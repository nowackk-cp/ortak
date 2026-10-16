// "Ortak's hands" for agents that cannot touch the project themselves (capabilities.edit false,
// e.g. Gemini web / 4 Argon): the agent asks for files with `READ: path` lines and changes them
// with SEARCH/REPLACE blocks; Ortak reads, applies (inside the project folder only), and reports
// back what worked so the agent can fix failed blocks. Like a terminal, `RUN: command` runs a shell
// command in the project folder (allowed by the run's permission, see commands.js) and sends the
// output back. Used by lead-mode workers (textCoderTask), the Kod arayüzü's single-agent chat
// (textChatTurn) and team/parallel workers (work), where the agent also browses with `LIST: dir`.
//
//   READ: src/app.js
//   LIST: src
//   RUN: npm test
//
//   FILE: src/app.js
//   <<<<<<< SEARCH
//   exact existing lines
//   =======
//   new lines
//   >>>>>>> REPLACE
//
// API agents whose model supports function calling (Groq, OpenRouter, EVREN) get the same hands as
// real tools instead (nativeTurn below); the text protocol stays the fallback.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as P from './prompts.js';
import { clip } from '../util.js';
import { COMMAND_TIMEOUT_MS, policyOf, runCommand, shell } from '../commands.js';
import * as checkpoints from '../checkpoints.js';
import { getSettings } from '../settings.js';
import { allFiles, safePath } from '../tools/paths.js';
import { toolCaps } from '../tools/budget.js';
import { applyAll, applyReplace, levelNote, replaceLines, replaceOnce } from '../tools/edit.js';
import { checkFile } from '../tools/check.js';
import { deleteFile, findFiles, moveFile } from '../tools/files.js';
import { findSymbol, outline } from '../tools/symbols.js';
import { projectContext } from '../tools/project.js';
import { gitDiff, gitLog, gitShow, gitStatus } from '../tools/gittools.js';
import { UNTRUSTED, webFetch, webSearch } from '../tools/web.js';

export { safePath };

const MAX_ROUNDS = 7;          // agent turns per task (reads, commands, fix-ups)
const READ_EACH_MAX = 120_000; // chars per file sent to the agent
const READ_TOTAL_MAX = 300_000;
const LISTING_MAX = 400;
/**
 * The project as a first message shows it (tools/project.js): its instruction files (AGENTS.md…)
 * and the file list, or a map of folders when there are more than `max` files.
 */
export function projectListing(cwd, max = LISTING_MAX, { instructionsMax = 8000 } = {}) {
  return projectContext(cwd, { max, instructionsMax });
}

/** projectListing sized for one lane's agent (tools/budget.js); `max` overrides the file count. */
export const listingFor = (ctx, laneId, cwd = ctx.meta.cwd, max) => {
  const caps = toolCaps(ctx.adapterOf(laneId));
  return projectListing(cwd, Math.min(max || caps.listing, caps.listing), { instructionsMax: Math.min(8000, caps.read) });
};

const GREP_FILES_MAX = 20_000;
const GREP_FILE_BYTES = 2 * 1024 * 1024;
const GREP_HITS_MAX = 150;    // per pattern
const GREP_LINE_MAX = 220;

/** "desen @ src/" → { pattern, dir }. */
export function parseGrepSpec(spec) {
  const m = /^(.*\S)\s+@\s+(\S.*)$/.exec(String(spec || '').trim());
  return m ? { pattern: m[1], dir: m[2] } : { pattern: String(spec || '').trim(), dir: '' };
}

/**
 * Searches the project for each spec (case-insensitive regex; invalid regex → literal text).
 * Resolves [{ spec, hits: ['path:line: text'], more, files, error? }].
 */
export async function grepProject(cwd, specs, { hitsMax = GREP_HITS_MAX } = {}) {
  const out = [];
  let files = null;
  for (const spec of [...new Set(specs)].slice(0, 5)) {
    const { pattern, dir } = parseGrepSpec(spec);
    if (!pattern) { out.push({ spec, error: 'boş desen' }); continue; }
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    let prefix = '';
    if (dir && dir !== '.') {
      try { prefix = `${safePath(cwd, dir.replace(/\/+$/, '')).rel}/`; } catch (err) { out.push({ spec, error: err.message }); continue; }
    }
    files ||= (await allFiles(cwd, GREP_FILES_MAX)).slice(0, GREP_FILES_MAX);
    const hits = [];
    let more = 0;
    let matchedFiles = 0;
    for (const rel of files) {
      if (prefix && !rel.startsWith(prefix)) continue;
      const abs = path.join(cwd, rel);
      let buf;
      try {
        const st = await fs.stat(abs);
        if (!st.isFile() || st.size > GREP_FILE_BYTES) continue;
        buf = await fs.readFile(abs);
      } catch { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hit = true;
        if (hits.length >= hitsMax) { more++; continue; }
        const t = lines[i].trim();
        hits.push(`${rel}:${i + 1}: ${t.length > GREP_LINE_MAX ? `${t.slice(0, GREP_LINE_MAX)}…` : t}`);
      }
      if (hit) matchedFiles++;
    }
    out.push({ spec, hits, more, files: matchedFiles });
  }
  return out;
}

/** "src/a.js:100-200" / "src/a.js#L100-L200" / "src/a.js:100" → { path, from, to } (1-based, inclusive). */
export function parseReadSpec(spec) {
  const s = String(spec || '').trim();
  const m = /^(.+?)(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?$/i.exec(s);
  if (!m) return { path: s };
  const from = Math.max(1, Number(m[2]));
  const to = m[3] ? Math.max(from, Number(m[3])) : from + 199; // a single line number: 200 lines from there
  return { path: m[1], from, to };
}

/**
 * Reads project files for a text-only agent. Each spec may carry a line range (parseReadSpec).
 * Long files are cut at a line boundary; the result says which lines were sent (`from`, `to`,
 * `lines` = total) so the agent can ask for the rest with a range.
 */
export async function readFiles(cwd, paths, { eachMax = READ_EACH_MAX, totalMax = READ_TOTAL_MAX } = {}) {
  const out = [];
  let total = 0;
  for (const spec of [...new Set(paths)].slice(0, 20)) {
    const { path: p, from, to } = parseReadSpec(spec);
    try {
      const { abs, rel } = safePath(cwd, p);
      const buf = await fs.readFile(abs);
      if (buf.includes(0)) { out.push({ path: rel, error: 'ikili (binary) dosya, gösterilmedi' }); continue; }
      const all = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
      if (all.length > 1 && all.at(-1) === '') all.pop();
      const start = from ? Math.min(from, all.length || 1) : 1;
      const end = to ? Math.min(to, all.length) : all.length;
      const room = Math.max(0, Math.min(eachMax, totalMax - total));
      const picked = [];
      let size = 0;
      for (let i = start - 1; i < end; i++) {
        if (size + all[i].length + 1 > room) break;
        picked.push(all[i]);
        size += all[i].length + 1;
      }
      const shownTo = start + picked.length - 1;
      const truncated = shownTo < end;
      const partial = start > 1 || shownTo < all.length;
      total += size;
      out.push({
        path: rel, text: picked.join('\n'), truncated,
        ...(partial ? { from: start, to: shownTo, lines: all.length } : {}),
      });
    } catch (err) {
      out.push({ path: String(p), error: err.code === 'ENOENT' ? 'dosya yok' : err.message });
    }
  }
  return out;
}

/** Tool-card text for a read. */
export const readNote = (f) => f.error || `${f.text.length} karakter gönderildi${f.lines ? ` (satır ${f.from}-${f.to} / ${f.lines})` : ''}`;

// Block markers. Tolerant of web UIs that render markdown: a fence broken by a nested ``` turns
// ">>>>>>>" into a blockquote ("> > > > > > >").
const MARK_SEARCH = /^\s*(?:<\s*){5,9}SEARCH\s*$/i;
const MARK_DIVIDER = /^\s*(?:=\s*){5,9}$/;
const MARK_REPLACE = /^\s*(?:>\s*){5,9}REPLACE\s*$/i;

// Request lines of the text protocol: "KEY: value" at the start of a line (Turkish aliases too).
// The newer keys have no Turkish aliases on purpose: "Tanım:" or "Sil:" also start ordinary prose.
const REQUESTS = {
  reads: ['READ', 'OKU'],
  lists: ['LIST', 'LİSTE', 'LISTE', 'DIR'],
  greps: ['GREP', 'ARA'],
  runs: ['RUN', 'ÇALIŞTIR', 'CALISTIR', 'KOMUT'],
  finds: ['FIND'],
  outlines: ['OUTLINE'],
  symbols: ['SYMBOL'],
  gits: ['GIT'],
  webs: ['WEB'],
  fetches: ['FETCH'],
  deletes: ['DELETE'],
  moves: ['MOVE'],
};
const KEY_OF = new Map(Object.entries(REQUESTS).flatMap(([k, words]) => words.map((w) => [w.toLocaleUpperCase('tr'), k])));
const KEY_ALT = [...KEY_OF.keys()].sort((a, b) => b.length - a.length).join('|');
const REQUEST_LINE = new RegExp(`^\\s*(?:[-*]\\s*)?(${KEY_ALT})\\s*:\\s*(.*?)\\s*$`, 'iu');
const REQUEST_SPLIT = new RegExp(`\\s+(?=(?:${KEY_ALT})\\s*:)`, 'iu');

/**
 * Requests and edits in an agent answer:
 * `{ reads, lists, greps, runs, finds, outlines, symbols, gits, webs, fetches, deletes, moves: [string],
 *    edits: [{ path, search, replace }] }`.
 */
export function parseAnswer(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = Object.fromEntries(Object.keys(REQUESTS).map((k) => [k, []]));
  const edits = [];
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Several requests on one line ("LIST: . LIST: src" / "RUN: npm test READ: a.js"): one per line.
    const many = line.split(REQUEST_SPLIT);
    if (many.length > 1 && REQUEST_LINE.test(many[0])) {
      lines.splice(i, 1, ...many);
      i--;
      continue;
    }
    const req = REQUEST_LINE.exec(line);
    if (req) {
      const key = KEY_OF.get(req[1].toLocaleUpperCase('tr'));
      let v = req[2].replace(/^`+|`+$/g, '').trim();
      if (key === 'reads' || key === 'lists' || key === 'deletes' || key === 'outlines') v = v.replace(/^[`'"]+|[`'"]+$/g, '');
      if (key === 'lists') { out.lists.push(v || '.'); continue; }
      if (v) out[key].push(v);
      continue;
    }
    const f = /^\s*(?:FILE|DOSYA)\s*:\s*(.+?)\s*$/i.exec(line);
    if (f) { file = f[1].replace(/^[`'"*]+|[`'"*]+$/g, ''); continue; }
    if (MARK_SEARCH.test(line)) {
      const search = [];
      const replace = [];
      let j = i + 1;
      for (; j < lines.length && !MARK_DIVIDER.test(lines[j]); j++) search.push(lines[j]);
      for (j += 1; j < lines.length && !MARK_REPLACE.test(lines[j]); j++) replace.push(lines[j]);
      if (j >= lines.length) break; // unterminated block: ignore
      edits.push({ path: file, search: search.join('\n'), replace: replace.join('\n') });
      i = j;
    }
  }
  return { ...out, edits };
}

const RUNS_PER_ROUND = 5;

async function grepAndReport(cwd, greps, tool, hitsMax) {
  const found = await grepProject(cwd, greps, hitsMax ? { hitsMax } : {});
  for (const g of found) {
    tool('Ortak: ara', { pattern: g.spec }, g.error || (g.hits.length
      ? `${g.hits.length + g.more} eşleşme, ${g.files} dosyada${g.more ? ` (ilk ${g.hits.length} gönderildi)` : ''}`
      : 'Eşleşme yok'), !!g.error);
  }
  return found;
}

/**
 * Runs the agent's `RUN:` commands in `cwd` under the run's permission (commands.js policyOf).
 * Emits one tool card per command; resolves [{ command, code, output, timedOut, refused? }].
 */
export async function runCommands(ctx, cwd, commands, permission, tool, { outputMax } = {}) {
  const out = [];
  for (const command of commands.slice(0, RUNS_PER_ROUND)) {
    const refused = policyOf(command, permission);
    if (refused) {
      tool('Ortak: komut', { command }, `Çalıştırılmadı: ${refused}`, true);
      out.push({ command, refused });
      continue;
    }
    const id = `ortak-${++toolSeq}`;
    ctx.emit({ kind: 'agent', lane: tool.lane, event: { type: 'tool-start', id, name: 'Ortak: komut', input: { command } } });
    const r = await runCommand(command, { cwd, signal: ctx.signal, ...(outputMax ? { outputMax } : {}) });
    const head = r.timedOut ? `Zaman aşımı (${COMMAND_TIMEOUT_MS / 1000} sn) — durduruldu` : `Çıkış kodu ${r.code}`;
    ctx.emit({ kind: 'agent', lane: tool.lane, event: { type: 'tool-end', id, output: `${head}\n${r.output}`.trim(), isError: r.timedOut || r.code !== 0 } });
    out.push({ command, ...r });
  }
  for (const command of commands.slice(RUNS_PER_ROUND)) out.push({ command, refused: `bir mesajda en fazla ${RUNS_PER_ROUND} komut; sonra tekrar iste` });
  return out;
}

/** One folder's entries (dirs first, `name/`), relative to cwd. Root (`.`) allowed. */
export async function listDirs(cwd, paths) {
  const out = [];
  for (const p of [...new Set(paths)].slice(0, 10)) {
    try {
      const clean = String(p || '').trim().replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '');
      const { abs, rel } = !clean || clean === '.' ? { abs: cwd, rel: '.' } : safePath(cwd, clean);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && e.name !== '.git').map((e) => `${e.name}/`).sort();
      const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
      const all = [...dirs, ...files];
      out.push({ path: rel, entries: all.slice(0, LISTING_MAX), more: Math.max(0, all.length - LISTING_MAX) });
    } catch (err) {
      out.push({ path: String(p), error: err.code === 'ENOENT' ? 'klasör yok' : err.code === 'ENOTDIR' ? 'bu bir dosya, klasör değil (READ kullan)' : err.message });
    }
  }
  return out;
}

/** The answer with SEARCH/REPLACE blocks folded to one line each (the diff already shows them). */
export function stripEdits(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(?:FILE|DOSYA)\s*:\s*(.+?)\s*$/i.exec(lines[i]);
    if (f) { file = f[1]; continue; }
    if (MARK_SEARCH.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !MARK_REPLACE.test(lines[j])) j++;
      out.push(`[değişiklik bloğu: ${file || '?'} — uygulanıp uygulanmadığı yukarıda, içeriği adımın diff'inde]`);
      i = j;
      continue;
    }
    out.push(lines[i]);
  }
  // drop the fences that wrapped the blocks
  return out.join('\n').replace(/`{3,}[^\n]*\n((?:\[değişiklik bloğu: [^\n]*\]\n*)+)`{3,}/g, '$1').trim();
}

/**
 * Applies edits grouped by file. Returns [{ path, ok, error?, created?, fuzzy?, syntax? }] per
 * block: `fuzzy` says how a not-quite-exact search text was matched (tools/edit.js), `syntax` is a
 * syntax problem the changed file now has (tools/check.js) — the edit stays, the agent fixes it.
 * `cp` (checkpoints.begin) records each file's original content before it is first written.
 */
export async function applyEdits(cwd, edits, cp) {
  const results = [];
  const byFile = new Map();
  for (const e of edits) {
    if (!e.path) { results.push({ path: '(dosya adı yok)', ok: false, error: 'bloktan önce "FILE: yol" satırı yok' }); continue; }
    let sp;
    try { sp = safePath(cwd, e.path); } catch (err) { results.push({ path: e.path, ok: false, error: err.message }); continue; }
    if (!byFile.has(sp.rel)) byFile.set(sp.rel, { abs: sp.abs, blocks: [] });
    byFile.get(sp.rel).blocks.push(e);
  }
  for (const [rel, { abs, blocks }] of byFile) {
    let original = null;
    try { original = await fs.readFile(abs, 'utf8'); } catch { /* new file */ }
    const crlf = original != null && original.includes('\r\n');
    let content = original == null ? null : original.replace(/\r\n/g, '\n');
    let last = null;
    for (const b of blocks) {
      try {
        if (!b.search.trim()) {
          if (content != null && content.trim()) throw new Error('ARA kısmı boş ama dosya zaten var; değiştirmek istediğin satırları ARA kısmına aynen yaz');
          content = b.replace;
          results.push(last = { path: rel, ok: true, created: original == null });
        } else {
          if (content == null) throw new Error('dosya yok (yeni dosya için ARA kısmını boş bırak)');
          const r = applyReplace(content, b.search, b.replace);
          content = r.content;
          results.push(last = { path: rel, ok: true, ...(r.level > 1 ? { fuzzy: levelNote(r.level) } : {}) });
        }
      } catch (err) {
        results.push({ path: rel, ok: false, error: err.message });
      }
    }
    if (last) {
      await writeText(abs, rel, crlf ? content.replace(/\n/g, '\r\n') : content, cp);
      const syntax = await checkFile(abs, rel);
      if (syntax) last.syntax = syntax;
    }
  }
  return results;
}

/** Writes a file the checkpoint can undo (original noted first). */
async function writeText(abs, rel, text, cp) {
  await cp?.note(abs, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

/** Tool-card / model text for an applied edit: "Uygulandı (girinti farkı yok sayılarak)" + syntax. */
export function editNote(res) {
  if (!res.ok) return res.error;
  const head = `${res.created ? 'Oluşturuldu' : 'Uygulandı'}${res.fuzzy ? ` (${res.fuzzy})` : ''}`;
  return res.syntax ? `${head}. DİKKAT, dosyada şimdi sözdizimi hatası var: ${res.syntax} — düzelt.` : head;
}

let toolSeq = 0;

/**
 * One delegated task for a text-only agent. Loops (≤ MAX_ROUNDS turns): files it asks for are
 * sent back, its SEARCH/REPLACE blocks are applied (unless read-only) and failures are reported
 * so it can retry. Resolves { text, applied: [path], failed: [{ path, error }], readOnly }.
 */
export async function textCoderTask(ctx, laneId, opts) {
  const cp = checkpoints.begin(ctx.meta.id);
  try {
    let attached;
    if (await canUseTools(ctx, laneId)) {
      const { goal, task, files = [], permission, leadName } = opts;
      const cwd = ctx.meta.cwd;
      const readOnly = permission === 'read-only';
      const tool = cardEmitter(ctx, laneId);
      const caps = toolCaps(ctx.adapterOf(laneId));
      attached = files.length ? await readFiles(cwd, files, { eachMax: caps.read, totalMax: caps.readTotal }) : [];
      for (const f of attached) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
      try {
        const r = await nativeTurn(ctx, laneId, {
          prompt: P.nativeCoderTask({ goal, task, listing: await listingFor(ctx, laneId, cwd), attached, readOnly, leadName }),
          permission, cwd, system: P.nativeCoderSystem(permission),
        }, cp);
        return { text: r.text, applied: r.applied, failed: [...r.failed].map(([p, error]) => ({ path: p, error })), readOnly };
      } catch (err) {
        if (err?.code !== 'tools_unsupported') throw err;
        fellBack(ctx, laneId, err);
      }
    }
    return await coderLoop(ctx, laneId, { ...opts, attached }, cp);
  } finally {
    await emitCheckpoint(ctx, laneId, cp);
  }
}

/** Saves a turn's checkpoint and shows it (with its Geri al button) in the run. */
async function emitCheckpoint(ctx, laneId, cp) {
  try {
    const saved = await cp.finish();
    if (saved) ctx.emit({ kind: 'checkpoint', lane: laneId, id: saved.id, files: saved.files });
  } catch (err) {
    ctx.note(`Geri alma noktası kaydedilemedi: ${err.message}`, 'warn');
  }
}

async function coderLoop(ctx, laneId, { goal, task, files = [], permission, leadName, attached: preread }, cp) {
  const cwd = ctx.meta.cwd;
  const readOnly = permission === 'read-only';
  const tool = (name, input, output, isError = false) => {
    const id = `ortak-${++toolSeq}`;
    ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'tool-start', id, name, input } });
    ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'tool-end', id, output, isError } });
  };
  tool.lane = laneId;

  const caps = toolCaps(ctx.adapterOf(laneId));
  const readCaps = { eachMax: caps.read, totalMax: caps.readTotal };
  const listing = await listingFor(ctx, laneId, cwd);
  const attached = preread || (files.length ? await readFiles(cwd, files, readCaps) : []);
  if (!preread) for (const f of attached) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);

  let prompt = P.textCoderTask({ goal, task, listing, attached, readOnly, leadName });
  const applied = new Set();
  const failedNow = new Map();
  const ops = makeOps(ctx, laneId, { cwd, permission, cp, applied, caps });
  let text = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await ctx.turn(laneId, { prompt, permission: 'read-only', system: P.textCoderSystem(permission) });
    text = r.text;
    const req = parseAnswer(text);
    const { reads, lists, greps, runs, edits } = req;

    let results = [];
    if (edits.length) {
      if (readOnly) {
        tool('Ortak: değişiklik', { blocks: edits.length }, 'Salt okunur çalışma: değişiklikler uygulanmadı.', true);
      } else {
        results = await applyEdits(cwd, edits, cp);
        for (const res of results) {
          tool(res.created ? 'Ortak: dosya oluştur' : 'Ortak: düzenle', { path: res.path }, editNote(res), !res.ok);
          if (res.ok) { applied.add(res.path); failedNow.delete(res.path); } else failedNow.set(res.path, res.error);
        }
      }
    }
    const failed = results.filter((x) => !x.ok);
    const last = round === MAX_ROUNDS;
    const ran = runs.length ? await runCommands(ctx, cwd, runs, permission, tool, { outputMax: caps.output }) : [];
    const found = greps.length && !last ? await grepAndReport(cwd, greps, tool, caps.grepHits) : [];
    const fresh = reads.length && !last ? await readFiles(cwd, reads, readCaps) : [];
    for (const f of fresh) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
    const dirs = lists.length && !last ? await listDirs(cwd, lists) : [];
    for (const d of dirs) tool('Ortak: klasörü listele', { path: d.path }, d.error || `${d.entries.length} öğe`, !!d.error);
    const extras = !last ? await runExtras(ops, req) : [];

    const broken = !edits.length && !readOnly && BROKEN_BLOCK.test(text);
    if (broken) tool('Ortak: değişiklik', { blocks: '?' }, 'Değişiklik blokları bozuk geldi (kod bloğu içinde değil); yeniden isteniyor.', true);
    const asked = fresh.length || dirs.length || ran.length || found.length || extras.length;
    const broke = results.some((x) => x.syntax);
    if (!asked && !failed.length && !broken && !broke) break; // finished
    if (last) break;
    // Next round: requested files + command output + what failed (with the current text of those files).
    const current = failed.length ? await readFiles(cwd, [...new Set(failed.map((x) => x.path))], readCaps) : [];
    prompt = broken && !asked ? P.textChatBrokenBlocks : P.textCoderFollow({ files: fresh, dirs, ran, found, results, current, extras });
  }
  return {
    text,
    applied: [...applied],
    failed: [...failedNow].map(([p, error]) => ({ path: p, error })),
    readOnly,
  };
}

const BROKEN_BLOCK = /<{5,}\s*SEARCH|(?:>\s*){5,}REPLACE/i;
const CHAT_ROUNDS = 10; // agent turns per user message (reads, listings, commands, fix-ups)

/**
 * One user message of a Kod-arayüzü chat with a text-only agent (Gemini web / 4 Argon, EVREN).
 * `prompt` is what the agent sees first (the caller adds context/transcript); then, like
 * textCoderTask, requested files/folders are sent back and SEARCH/REPLACE blocks are applied
 * (unless read-only) until the agent stops asking. Resolves { text, applied: [path] }.
 */
export async function textChatTurn(ctx, laneId, opts) {
  const cp = checkpoints.begin(ctx.meta.id);
  try {
    if (await canUseTools(ctx, laneId)) {
      const { prompt, permission, resume = true, cwd = ctx.meta.cwd, system } = opts;
      try {
        const r = await nativeTurn(ctx, laneId, {
          prompt, permission, cwd, resume, system: [P.nativeChatSystem(permission), system].filter(Boolean).join('\n\n'),
        }, cp);
        return { text: r.text, applied: r.applied };
      } catch (err) {
        if (err?.code !== 'tools_unsupported') throw err;
        fellBack(ctx, laneId, err);
      }
    }
    return await chatLoop(ctx, laneId, opts, cp);
  } finally {
    await emitCheckpoint(ctx, laneId, cp);
  }
}

async function chatLoop(ctx, laneId, { prompt, permission, resume = true, cwd = ctx.meta.cwd, system }, cp) {
  const readOnly = permission === 'read-only';
  const tool = (name, input, output, isError = false) => {
    const id = `ortak-${++toolSeq}`;
    ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'tool-start', id, name, input } });
    ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'tool-end', id, output, isError } });
  };
  tool.lane = laneId;
  const applied = new Set();
  const caps = toolCaps(ctx.adapterOf(laneId));
  const readCaps = { eachMax: caps.read, totalMax: caps.readTotal };
  const ops = makeOps(ctx, laneId, { cwd, permission, cp, applied, caps });
  let text = '';
  for (let round = 1; round <= CHAT_ROUNDS; round++) {
    const r = await ctx.turn(laneId, { prompt, permission: 'read-only', system: [P.textChatSystem(permission), system].filter(Boolean).join('\n\n'), resume: round > 1 || resume });
    text = r.text;
    const req = parseAnswer(text);
    const { reads, lists, greps, runs, edits } = req;

    let results = [];
    if (edits.length) {
      if (readOnly) {
        results = edits.map((e) => ({ path: e.path || '?', ok: false, error: 'salt okunur çalışma: değişiklik uygulanmadı' }));
        tool('Ortak: değişiklik', { blocks: edits.length }, 'Salt okunur çalışma: değişiklikler uygulanmadı.', true);
      } else {
        results = await applyEdits(cwd, edits, cp);
        for (const res of results) {
          tool(res.created ? 'Ortak: dosya oluştur' : 'Ortak: düzenle', { path: res.path }, editNote(res), !res.ok);
          if (res.ok) applied.add(res.path);
        }
      }
    }
    const last = round === CHAT_ROUNDS;
    const failed = readOnly ? [] : results.filter((x) => !x.ok);
    // Commands run after the edits (so `RUN: npm test` tests the changed code).
    const ran = runs.length ? await runCommands(ctx, cwd, runs, permission, tool, { outputMax: caps.output }) : [];
    const found = greps.length && !last ? await grepAndReport(cwd, greps, tool, caps.grepHits) : [];
    const files = reads.length && !last ? await readFiles(cwd, reads, readCaps) : [];
    for (const f of files) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
    const dirs = lists.length && !last ? await listDirs(cwd, lists) : [];
    for (const d of dirs) tool('Ortak: klasörü listele', { path: d.path }, d.error || `${d.entries.length} öğe`, !!d.error);
    const extras = !last ? await runExtras(ops, req) : [];

    // Change markers but no parsable block: the web UI rendered it as markdown (no code fence),
    // which merges lines and eats "=======". Ask once more for fenced blocks.
    const broken = !edits.length && !readOnly && BROKEN_BLOCK.test(text);
    if (broken) tool('Ortak: değişiklik', { blocks: '?' }, 'Değişiklik blokları bozuk geldi (kod bloğu içinde değil); yeniden isteniyor.', true);

    const asked = files.length || dirs.length || ran.length || found.length || extras.length;
    const broke = results.some((x) => x.syntax);
    if (last || (!asked && !failed.length && !broken && !broke)) break;
    const current = failed.length ? await readFiles(cwd, [...new Set(failed.map((x) => x.path))], readCaps) : [];
    prompt = broken && !asked
      ? P.textChatBrokenBlocks
      : P.textChatFollow({ files, dirs, ran, found, results: readOnly ? [] : results, current, extras });
  }
  return { text, applied: [...applied] };
}

// ---- real function calling (API agents: Groq, OpenRouter, EVREN) ------------------------------
// Models that support it get the same hands as tools (nativeToolDefs: list_dir, find_files,
// read_file, outline, find_symbol, grep, git, run_command, web_search, web_fetch, edit_file,
// multi_edit, replace_lines, write_file, delete_file, move_file) instead of the text protocol;
// the adapter loops until the model answers.
// A model that rejects tools fails its first request with code 'tools_unsupported' and the turn
// is redone with LIST/READ/RUN.

function cardEmitter(ctx, laneId) {
  const tool = (name, input, output, isError = false) => {
    const id = `ortak-${++toolSeq}`;
    ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'tool-start', id, name, input } });
    ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'tool-end', id, output, isError } });
  };
  tool.lane = laneId;
  return tool;
}

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const webOn = () => getSettings().webTools !== false;

// ---- Ortak's hands beyond read / edit / run --------------------------------------------------
// Shared by the text protocol (FIND: / OUTLINE: / SYMBOL: / GIT: / WEB: / FETCH: / DELETE: / MOVE:)
// and real tool calls (find_files, outline, find_symbol, git, web_search, web_fetch, delete_file,
// move_file). Each resolves the text the agent sees and shows a tool card.

const firstLine = (t) => String(t).split('\n').find((l) => l.trim()) || '';
const GIT_KINDS = ['status', 'diff', 'log', 'show'];

/**
 * `{ find, outline, symbol, git, web, fetch, remove, move }` for one lane. `applied` collects the
 * files changed (deleted / moved); `cp` is the turn's checkpoint (so "Geri al" restores them).
 */
function makeOps(ctx, laneId, { cwd, permission, cp, applied, caps = toolCaps(ctx.adapterOf(laneId)) }) {
  const tool = cardEmitter(ctx, laneId);
  const readOnly = permission === 'read-only';
  const card = (name, input, text, isError = false, cardText) => { tool(name, input, cardText ?? firstLine(text), isError); return text; };
  const guard = async (name, input, fn) => {
    try { return await fn(); } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return card(name, input, `Hata: ${err.message}`, true);
    }
  };
  return {
    find: (pattern, dir = '') => guard('Ortak: dosya bul', { pattern, dir }, async () => {
      const r = await findFiles(cwd, pattern, { dir, max: caps.grepHits * 2 });
      if (!r.total) return card('Ortak: dosya bul', { pattern }, `"${pattern}" ile eşleşen dosya yok.`);
      return card('Ortak: dosya bul', { pattern }, `${r.total} dosya:\n${r.files.join('\n')}${r.more ? `\n… ve ${r.more} dosya daha (deseni daralt)` : ''}`, false, `${r.total} dosya`);
    }),
    outline: (p) => guard('Ortak: anahat', { path: p }, async () => {
      const r = await outline(cwd, p, caps.symbols);
      const body = r.items.length ? r.items.join('\n') : '(tanım bulunamadı)';
      return card('Ortak: anahat', { path: r.path }, `[${r.path} · ${r.lines} satır · ${r.items.length + r.more} tanım]\n${body}` +
        `${r.more ? `\n… ve ${r.more} tanım daha` : ''}\nGereken kısmı satır aralığıyla oku.`, false, `${r.items.length + r.more} tanım`);
    }),
    symbol: (name, dir = '') => guard('Ortak: tanım bul', { name }, async () => {
      const r = await findSymbol(cwd, name, { dir, max: Math.min(40, caps.grepHits) });
      if (!r.hits.length) return card('Ortak: tanım bul', { name }, `"${name}" için tanım bulunamadı (${r.scanned} kod dosyası tarandı); kullanım yerleri için grep kullan.`, false, 'bulunamadı');
      return card('Ortak: tanım bul', { name }, `${r.hits.map((x) => `${x.path}:${x.line}: ${x.text}`).join('\n')}${r.more ? `\n… ve ${r.more} tanım daha` : ''}`, false, `${r.hits.length + r.more} tanım`);
    }),
    git: (kind, { path: p = '', rev = '', n } = {}) => guard('Ortak: git', { command: `${kind} ${rev || p}`.trim() }, async () => {
      const k = String(kind || '').toLowerCase();
      if (!GIT_KINDS.includes(k)) return card('Ortak: git', { command: k }, `Hata: bilinmeyen git komutu "${kind}" (kullanılabilenler: ${GIT_KINDS.join(', ')})`, true);
      const max = Math.max(caps.read, 6000);
      const text = k === 'status' ? await gitStatus(cwd, max)
        : k === 'diff' ? await gitDiff(cwd, { path: p, ...(rev ? { base: rev } : {}), max })
        : k === 'log' ? await gitLog(cwd, { path: p, n, max })
        : await gitShow(cwd, { rev: rev || 'HEAD', path: p, max });
      return card('Ortak: git', { command: `${k} ${rev || p}`.trim() }, text, /^git hatası/.test(text), `${text.length} karakter`);
    }),
    web: (query) => guard('Ortak: web ara', { query }, async () => {
      if (!webOn()) return card('Ortak: web ara', { query }, 'İnternet araçları ayarlardan kapatılmış.', true);
      const results = await webSearch(query, { signal: ctx.signal });
      if (!results.length) return card('Ortak: web ara', { query }, 'Sonuç yok.');
      return card('Ortak: web ara', { query }, `${UNTRUSTED}\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n')}`, false, `${results.length} sonuç`);
    }),
    fetch: (url) => guard('Ortak: sayfa oku', { url }, async () => {
      if (!webOn()) return card('Ortak: sayfa oku', { url }, 'İnternet araçları ayarlardan kapatılmış.', true);
      const r = await webFetch(url, { max: caps.web, signal: ctx.signal });
      return card('Ortak: sayfa oku', { url: r.url }, `${UNTRUSTED}\n[${r.url}]${r.title ? ` ${r.title}` : ''}\n\n${r.text}`, false, `${r.text.length} karakter${r.truncated ? ' (kısaltıldı)' : ''}`);
    }),
    remove: (p) => guard('Ortak: dosya sil', { path: p }, async () => {
      if (readOnly) return card('Ortak: dosya sil', { path: p }, 'Hata: salt okunur çalışma, dosya silinemez.', true);
      const r = await deleteFile(cwd, p, cp);
      applied?.add(r.path);
      return card('Ortak: dosya sil', { path: r.path }, `${r.path} silindi (Geri al ile geri getirilebilir).`, false, 'Silindi');
    }),
    move: (from, to, overwrite = false) => guard('Ortak: taşı', { from, to }, async () => {
      if (readOnly) return card('Ortak: taşı', { from, to }, 'Hata: salt okunur çalışma, dosya taşınamaz.', true);
      const r = await moveFile(cwd, from, to, cp, { overwrite });
      applied?.add(r.from);
      applied?.add(r.to);
      return card('Ortak: taşı', { from: r.from, to: r.to }, `${r.from} → ${r.to} taşındı.`, false, 'Taşındı');
    }),
  };
}

/** "diff src/a.js" / "show abc123:src/a.js" / "log src" / "status" → ops.git arguments. */
function parseGitRequest(spec) {
  const [kind = '', ...rest] = String(spec).trim().split(/\s+/);
  const arg = rest.join(' ');
  if (/^show$/i.test(kind)) {
    const [rev, ...p] = arg.split(':');
    return [kind, { rev: rev || 'HEAD', path: p.join(':') }];
  }
  return [kind, { path: arg }];
}

/** "a.txt -> b/a.txt" / "a.txt => b.txt" / "a.txt b.txt" → [from, to]. */
function parseMove(spec) {
  const m = /^(.+?)\s*(?:->|=>|→)\s*(.+)$/.exec(String(spec).trim()) || /^(\S+)\s+(\S+)$/.exec(String(spec).trim());
  return m ? [m[1].replace(/^[`'"]+|[`'"]+$/g, ''), m[2].replace(/^[`'"]+|[`'"]+$/g, '')] : null;
}

/** Text-protocol requests beyond READ / GREP / RUN / LIST → [{ title, body }] for the next message. */
async function runExtras(ops, req) {
  const out = [];
  const each = async (list, max, title, fn) => {
    for (const v of list.slice(0, max)) out.push({ title: `${title} ${v}`, body: await fn(v) });
  };
  await each(req.finds, 5, 'FIND', (v) => { const g = parseGrepSpec(v); return ops.find(g.pattern, g.dir); });
  await each(req.outlines, 5, 'OUTLINE', (v) => ops.outline(v));
  await each(req.symbols, 5, 'SYMBOL', (v) => { const g = parseGrepSpec(v); return ops.symbol(g.pattern, g.dir); });
  await each(req.gits, 3, 'GIT', (v) => { const [k, a] = parseGitRequest(v); return ops.git(k, a); });
  await each(req.webs, 3, 'WEB', (v) => ops.web(v));
  await each(req.fetches, 3, 'FETCH', (v) => ops.fetch(v));
  await each(req.deletes, 10, 'DELETE', (v) => ops.remove(v));
  await each(req.moves, 10, 'MOVE', (v) => { const m = parseMove(v); return m ? ops.move(m[0], m[1]) : 'Hata: "MOVE: eski/yol -> yeni/yol" biçiminde yaz.'; });
  return out;
}

/** OpenAI-style tool definitions; read-only runs get no editing tools, web tools follow the setting. */
export function nativeToolDefs(permission) {
  const str = (description) => ({ type: 'string', description });
  const int = (description) => ({ type: 'integer', description });
  const defs = [
    fn('list_dir', 'Bir klasörün içeriğini listeler (klasörler "/" ile biter).', { path: str('Proje köküne göre klasör yolu; kök için "."') }, ['path']),
    fn('find_files', 'Dosya adı desenine (glob) uyan dosyaları bulur: "*.test.js", "src/**/*.ts", "**/config.{js,json}". "/" içermeyen desen her klasörde dosya adıyla eşleşir.', {
      pattern: str('Glob deseni'),
      dir: str('Yalnızca bu klasörde ara (isteğe bağlı)'),
    }, ['pattern']),
    fn('read_file', 'Bir dosyayı okur. Büyük dosyada önce outline ile yerini bul, sonra yalnızca gereken satırları iste.', {
      path: str('Proje köküne göre dosya yolu'),
      start_line: int('İlk satır (1\'den başlar, isteğe bağlı)'),
      end_line: int('Son satır (isteğe bağlı)'),
    }, ['path']),
    fn('outline', 'Bir kod dosyasındaki fonksiyon, sınıf, metot ve tipleri satır numaralarıyla listeler (dosyanın tamamını okumadan yapısını görmek için).', {
      path: str('Proje köküne göre dosya yolu'),
    }, ['path']),
    fn('find_symbol', 'Bir fonksiyon, sınıf, metot ya da tipin TANIMLANDIĞI yeri bulur (dosya:satır). Kullanıldığı yerler için grep kullan.', {
      name: str('Aranan ad, ör. "fiyatHesapla" ya da "UserService"'),
      dir: str('Yalnızca bu klasörde ara (isteğe bağlı)'),
    }, ['name']),
    fn('grep', 'Projede düzenli ifadeyle arar (büyük/küçük harf duyarsız, .gitignore\'a uyar); eşleşmeleri dosya:satır: metin olarak verir.', {
      pattern: str('Aranacak düzenli ifade ya da metin'),
      dir: str('Yalnızca bu klasörde ara (isteğe bağlı)'),
    }, ['pattern']),
    fn('git', 'Salt okunur git: status (değişen dosyalar), diff (son commit\'ten bu yana yapılan değişiklikler, yeni dosyalar dahil), log (geçmiş), show (bir commit ya da bir dosyanın o commit\'teki hâli).', {
      command: { type: 'string', enum: GIT_KINDS, description: 'status | diff | log | show' },
      path: str('Dosya ya da klasörle sınırla (isteğe bağlı)'),
      rev: str('show için commit (ör. HEAD~1, a1b2c3d); diff için karşılaştırılacak commit/dal (isteğe bağlı)'),
    }, ['command']),
    fn('run_command', `Proje klasöründe bir ${shell().name} komutu çalıştırır; çıktıyı ve çıkış kodunu verir. En fazla ${COMMAND_TIMEOUT_MS / 1000} sn.`, {
      command: str('Çalıştırılacak komut, ör. "npm test"'),
    }, ['command']),
  ];
  if (webOn()) {
    defs.push(
      fn('web_search', 'İnternette arar (dokümantasyon, hata mesajları, kütüphane kullanımı); başlık, adres ve özet döner.', { query: str('Arama sorgusu') }, ['query']),
      fn('web_fetch', 'Bir web sayfasını metin olarak okur (http/https, herkese açık adresler).', { url: str('Sayfanın adresi') }, ['url']));
  }
  if (permission === 'read-only') return defs;
  return [...defs,
    fn('edit_file', 'Bir dosyada old_text\'i new_text ile değiştirir. old_text dosyada tek bir kez geçmeli (küçük girinti farkları tolere edilir). Aynı dosyada birden çok değişiklik için multi_edit kullan.', {
      path: str('Proje köküne göre dosya yolu'),
      old_text: str('Dosyadaki mevcut metin (birkaç satır bağlamla, benzersiz olacak şekilde)'),
      new_text: str('Yerine gelecek metin'),
    }, ['path', 'old_text', 'new_text']),
    fn('multi_edit', 'Bir dosyada birden çok değişikliği tek seferde ve sırayla yapar; biri bile uygulanamazsa hiçbiri uygulanmaz.', {
      path: str('Proje köküne göre dosya yolu'),
      edits: {
        type: 'array',
        description: 'Sırayla uygulanacak değişiklikler',
        items: { type: 'object', properties: { old_text: str('Mevcut metin'), new_text: str('Yeni metin') }, required: ['old_text', 'new_text'] },
      },
    }, ['path', 'edits']),
    fn('replace_lines', 'Dosyanın start_line..end_line satırlarını (ikisi dahil) new_text ile değiştirir. Satır numaralarını hemen önce read_file ile okuduğun hâlden al.', {
      path: str('Proje köküne göre dosya yolu'),
      start_line: int('İlk satır (1\'den başlar)'),
      end_line: int('Son satır'),
      new_text: str('Bu satırların yerine gelecek metin'),
    }, ['path', 'start_line', 'end_line', 'new_text']),
    fn('write_file', 'Yeni bir dosya oluşturur ya da bir dosyanın tamamını verilen içerikle yazar.', {
      path: str('Proje köküne göre dosya yolu'),
      content: str('Dosyanın tam içeriği'),
    }, ['path', 'content']),
    fn('delete_file', 'Bir dosyayı siler (klasör değil). Kullanıcı "Geri al" ile geri getirebilir.', { path: str('Proje köküne göre dosya yolu') }, ['path']),
    fn('move_file', 'Bir dosyayı taşır ya da adını değiştirir.', {
      from: str('Mevcut yol'),
      to: str('Yeni yol'),
      overwrite: { type: 'boolean', description: 'Hedef varsa üzerine yaz (varsayılan: hayır)' },
    }, ['from', 'to']),
  ];
}

const intOf = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);

function nativeFile(f) {
  if (f.error) return `Hata: ${f.error}`;
  const range = f.lines ? ` · satır ${f.from}-${f.to} / toplam ${f.lines}` : '';
  const more = f.lines && f.to < f.lines ? ` — devamı için read_file(start_line=${f.to + 1})` : '';
  return `[${f.path}${range}${f.truncated ? ' · boyut sınırı nedeniyle kesildi' : ''}${more}]\n${f.text}`;
}

/** Runs one tool call with Ortak's hands; returns the text the model sees. */
function nativeExecutor(ctx, laneId, { cwd, permission, cp, applied, failed }) {
  const tool = cardEmitter(ctx, laneId);
  const caps = toolCaps(ctx.adapterOf(laneId));
  const readOnly = permission === 'read-only';
  const appliedSet = new Set();
  const ops = makeOps(ctx, laneId, { cwd, permission, cp, applied: appliedSet, caps });
  const editResult = (res) => {
    tool(res.created ? 'Ortak: dosya oluştur' : 'Ortak: düzenle', { path: res.path }, editNote(res), !res.ok);
    if (res.ok) { applied.add(res.path); failed.delete(res.path); } else failed.set(res.path, res.error);
  };
  const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const editReply = (res, retryHint) => (res.ok ? sentence(editNote(res)) : `UYGULANAMADI: ${res.error.replace(/ARA (metni|kısmı)/g, 'old_text')}. ${retryHint}`);
  const flushApplied = () => { for (const p of appliedSet) applied.add(p); appliedSet.clear(); };
  /** Read, transform and write one file (multi_edit / replace_lines). */
  const rewrite = async (p, transform) => {
    const sp = safePath(cwd, String(p));
    let original;
    try { original = await fs.readFile(sp.abs, 'utf8'); } catch { throw new Error(`dosya yok: ${sp.rel}`); }
    const crlf = original.includes('\r\n');
    const { content, fuzzy } = transform(original.replace(/\r\n/g, '\n'));
    await writeText(sp.abs, sp.rel, crlf ? content.replace(/\n/g, '\r\n') : content, cp);
    const syntax = await checkFile(sp.abs, sp.rel);
    return { path: sp.rel, ok: true, ...(fuzzy ? { fuzzy } : {}), ...(syntax ? { syntax } : {}) };
  };
  return async (name, a) => {
    try {
      switch (name) {
        case 'list_dir': {
          const [d] = await listDirs(cwd, [a.path || '.']);
          tool('Ortak: klasörü listele', { path: d.path }, d.error || `${d.entries.length} öğe`, !!d.error);
          return d.error ? `Hata: ${d.error}` : (d.entries.join('\n') || '(boş)') + (d.more ? `\n… ve ${d.more} öğe daha` : '');
        }
        case 'read_file': {
          if (!a.path) return 'Hata: path gerekli';
          const from = intOf(a.start_line), to = intOf(a.end_line);
          const spec = from || to ? `${a.path}:${from || 1}-${to || (from || 1) + 399}` : String(a.path);
          const [f] = await readFiles(cwd, [spec], { eachMax: caps.read, totalMax: caps.read });
          tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
          return nativeFile(f);
        }
        case 'grep': {
          if (!a.pattern) return 'Hata: pattern gerekli';
          const [g] = await grepAndReport(cwd, [a.dir ? `${a.pattern} @ ${a.dir}` : String(a.pattern)], tool, caps.grepHits);
          if (g.error) return `Hata: ${g.error}`;
          if (!g.hits.length) return 'Eşleşme yok.';
          return `${g.hits.length + g.more} eşleşme, ${g.files} dosyada:\n${g.hits.join('\n')}${g.more ? `\n… ve ${g.more} eşleşme daha (deseni daralt ya da dir ver)` : ''}`;
        }
        case 'find_files': return a.pattern ? await ops.find(String(a.pattern), a.dir ? String(a.dir) : '') : 'Hata: pattern gerekli';
        case 'outline': return a.path ? await ops.outline(String(a.path)) : 'Hata: path gerekli';
        case 'find_symbol': return a.name ? await ops.symbol(String(a.name), a.dir ? String(a.dir) : '') : 'Hata: name gerekli';
        case 'git': return await ops.git(String(a.command || ''), { path: a.path ? String(a.path) : '', rev: a.rev ? String(a.rev) : '', n: a.n });
        case 'web_search': return a.query ? await ops.web(String(a.query)) : 'Hata: query gerekli';
        case 'web_fetch': return a.url ? await ops.fetch(String(a.url)) : 'Hata: url gerekli';
        case 'run_command': {
          if (!a.command) return 'Hata: command gerekli';
          const [r] = await runCommands(ctx, cwd, [String(a.command)], permission, tool, { outputMax: caps.output });
          if (r.refused) return `Çalıştırılmadı: ${r.refused}`;
          return `${r.timedOut ? `Zaman aşımı: ${COMMAND_TIMEOUT_MS / 1000} sn sonra durduruldu.` : `Çıkış kodu: ${r.code}`}\n${r.output || '(çıktı yok)'}`;
        }
        case 'edit_file': {
          if (readOnly) return 'Hata: salt okunur çalışma, dosya değiştirilemez.';
          if (!a.path) return 'Hata: path gerekli';
          const [res] = await applyEdits(cwd, [{ path: String(a.path), search: String(a.old_text ?? ''), replace: String(a.new_text ?? '') }], cp);
          editResult(res);
          return editReply(res, a.old_text ? 'Dosyayı read_file ile yeniden okuyup tekrar dene.' : 'Mevcut bir dosyayı baştan yazmak için write_file kullan.');
        }
        case 'multi_edit': {
          if (readOnly) return 'Hata: salt okunur çalışma, dosya değiştirilemez.';
          if (!a.path || !Array.isArray(a.edits) || !a.edits.length) return 'Hata: path ve en az bir değişiklik içeren edits gerekli';
          let res;
          try {
            res = await rewrite(a.path, (text) => {
              const r = applyAll(text, a.edits.map((e) => ({ search: String(e?.old_text ?? ''), replace: String(e?.new_text ?? '') })));
              const lv = Math.max(...r.levels);
              return { content: r.content, fuzzy: lv > 1 ? levelNote(lv) : '' };
            });
          } catch (err) {
            res = { path: String(a.path), ok: false, error: `${err.message} — hiçbir değişiklik uygulanmadı` };
          }
          editResult(res);
          return editReply(res, 'Dosyayı read_file ile yeniden okuyup tekrar dene.');
        }
        case 'replace_lines': {
          if (readOnly) return 'Hata: salt okunur çalışma, dosya değiştirilemez.';
          if (!a.path) return 'Hata: path gerekli';
          let res;
          try {
            res = await rewrite(a.path, (text) => ({ content: replaceLines(text, intOf(a.start_line) ?? 0, intOf(a.end_line) ?? 0, String(a.new_text ?? '')) }));
          } catch (err) {
            res = { path: String(a.path), ok: false, error: err.message };
          }
          editResult(res);
          return editReply(res, 'Satır numaralarını read_file ile yeniden kontrol et.');
        }
        case 'write_file': {
          if (readOnly) return 'Hata: salt okunur çalışma, dosya yazılamaz.';
          if (!a.path) return 'Hata: path gerekli';
          let sp;
          try { sp = safePath(cwd, String(a.path)); } catch (err) { editResult({ path: String(a.path), ok: false, error: err.message }); return `Hata: ${err.message}`; }
          let before = null;
          try { before = await fs.readFile(sp.abs, 'utf8'); } catch { /* new file */ }
          const text = String(a.content ?? '').replace(/\r\n/g, '\n');
          await writeText(sp.abs, sp.rel, before?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text, cp);
          const syntax = await checkFile(sp.abs, sp.rel);
          const res = { path: sp.rel, ok: true, created: before == null, ...(syntax ? { syntax } : {}) };
          editResult(res);
          return sentence(editNote(res));
        }
        case 'delete_file': {
          const out = a.path ? await ops.remove(String(a.path)) : 'Hata: path gerekli';
          flushApplied();
          return out;
        }
        case 'move_file': {
          const out = a.from && a.to ? await ops.move(String(a.from), String(a.to), a.overwrite === true) : 'Hata: from ve to gerekli';
          flushApplied();
          return out;
        }
        default:
          return `Hata: bilinmeyen araç "${name}". Kullanılabilenler: ${nativeToolDefs(permission).map((d) => d.function.name).join(', ')}`;
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return `Hata: ${err?.message || err}`;
    }
  };
}

/** Whether this lane's agent/model should get real tools (false only when known unsupported). */
async function canUseTools(ctx, laneId) {
  const adapter = ctx.adapterOf(laneId);
  if (!adapter?.capabilities?.tools) return false;
  try {
    return (await adapter.supportsTools?.(ctx.lane(laneId)?.model)) !== false;
  } catch {
    return true;
  }
}

function fellBack(ctx, laneId, err) {
  ctx.emit({ kind: 'agent', lane: laneId, event: { type: 'status', text: `${err.message} LIST/READ/RUN yöntemiyle devam ediliyor.` } });
}

/** One turn with tools. Resolves { text, applied: [path], failed: Map(path → error) }. */
async function nativeTurn(ctx, laneId, { prompt, permission, cwd, system, resume = true }, cp) {
  const applied = new Set();
  const failed = new Map();
  const exec = nativeExecutor(ctx, laneId, { cwd, permission, cp, applied, failed });
  const r = await ctx.turn(laneId, { prompt, permission: 'read-only', system, resume, tools: { defs: nativeToolDefs(permission), exec } });
  return { text: r.text, applied: [...applied], failed };
}

export { projectListing as listing };

/** True when the lane's agent has no file tools of its own (Gemini web / 4 Argon, EVREN…). */
export const isTextOnly = (ctx, laneId) => ctx.adapterOf(laneId)?.capabilities?.edit === false;

/**
 * Drop-in for ctx.turn() on lanes that should change files (team/parallel workers): agents with
 * their own tools run as usual; text-only agents get Ortak's hands (LIST / READ / SEARCH-REPLACE)
 * in `cwd` (read-only: they read, search and run checks but change nothing — reviewers, planners).
 * The first turn of a session also gets the project's file list (at most `listingMax`). Resolves { text }.
 */
export async function work(ctx, laneId, { prompt, permission = 'read-only', system, cwd = ctx.meta.cwd, resume = true, listingMax }) {
  if (!isTextOnly(ctx, laneId)) return ctx.turn(laneId, { prompt, permission, system, cwd, resume });
  const fresh = !resume || !ctx.canResume(laneId);
  const listing = fresh ? await listingFor(ctx, laneId, cwd, listingMax) : null;
  const body = fresh ? P.textWorkIntro({ listing, prompt }) : prompt;
  return textChatTurn(ctx, laneId, { prompt: body, permission, resume, cwd, system });
}
export const _internals = { parseAnswer, replaceOnce, clip, parseMove, parseGitRequest };

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
//   OUTLINE: src/app.js      (functions/classes with line numbers, outline.js)
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
//
// Agents that take attachments (capabilities.uploads: Gemini web) get the files they read as .txt
// attachments instead of message text (Uploader below); unchanged files aren't sent twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ATT_ROOT } from '../attachments.js';
import { outlineLang, outlineText } from './outline.js';
import * as git from '../git.js';
import * as P from './prompts.js';
import { clip } from '../util.js';
import { COMMAND_TIMEOUT_MS, policyOf, runCommand, shell } from '../commands.js';
import * as checkpoints from '../checkpoints.js';

const MAX_ROUNDS = 7;          // agent turns per task (reads, commands, fix-ups)
const READ_EACH_MAX = 120_000; // chars per file sent to the agent
const READ_TOTAL_MAX = 300_000;
const READ_SUMMARY_LINES = 400; // read_file without a range on a longer file: outline + head
const READ_SUMMARY_HEAD = 150;
const LISTING_MAX = 400;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'tools', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv']);

/** Project files relative to cwd (git ls-files when possible: honours .gitignore), at most `max`+1. */
async function allFiles(cwd, max) {
  const r = await git.git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeoutMs: 15_000 });
  if (r.ok) return [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
  const files = [];
  const walk = async (dir, rel) => {
    if (files.length > max) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length > max) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), `${rel}${e.name}/`);
      } else if (e.isFile()) files.push(`${rel}${e.name}`);
    }
  };
  await walk(cwd, '');
  return files;
}

/** Project files (git ls-files when possible), relative to cwd, capped. */
export async function projectListing(cwd) {
  const files = await allFiles(cwd, LISTING_MAX);
  const more = files.length > LISTING_MAX ? files.length - LISTING_MAX : 0;
  return { files: files.slice(0, LISTING_MAX), more };
}

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
export async function grepProject(cwd, specs) {
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
        if (hits.length >= GREP_HITS_MAX) { more++; continue; }
        const t = lines[i].trim();
        hits.push(`${rel}:${i + 1}: ${t.length > GREP_LINE_MAX ? `${t.slice(0, GREP_LINE_MAX)}…` : t}`);
      }
      if (hit) matchedFiles++;
    }
    out.push({ spec, hits, more, files: matchedFiles });
  }
  return out;
}

/** Absolute path inside cwd, or throws a Turkish error. Never inside .git. */
export function safePath(cwd, rel) {
  const clean = String(rel || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/');
  if (!clean) throw new Error('boş dosya yolu');
  const abs = path.resolve(cwd, clean);
  const inside = path.relative(cwd, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`proje klasörünün dışında: ${clean}`);
  if (inside.split(/[\\/]/).includes('.git')) throw new Error(`.git klasörüne dokunulamaz: ${clean}`);
  return { abs, rel: inside.replace(/\\/g, '/') };
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
export async function readFiles(cwd, paths) {
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
      const room = Math.max(0, Math.min(READ_EACH_MAX, READ_TOTAL_MAX - total));
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

/** `{ reads: [path], lists: [dir], greps: [pattern], runs: [command], edits: [{ path, search, replace }] }` from an agent answer. */
export function parseAnswer(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const reads = [];
  const lists = [];
  const runs = [];
  const greps = [];
  const outlines = [];
  const edits = [];
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Several requests on one line ("LIST: . LIST: src" / "RUN: npm test READ: a.js"): one per line.
    const many = line.split(/\s+(?=(?:READ|OKU|LIST|LİSTE|LISTE|DIR|GREP|ARA|OUTLINE|ANAHAT|RUN|ÇALIŞTIR|CALISTIR|KOMUT)\s*:)/);
    if (many.length > 1 && /^\s*(?:[-*]\s*)?(?:READ|OKU|LIST|LİSTE|LISTE|DIR|GREP|ARA|OUTLINE|ANAHAT|RUN|ÇALIŞTIR|CALISTIR|KOMUT)\s*:/i.test(line)) {
      lines.splice(i, 1, ...many);
      i--;
      continue;
    }
    const grep = /^\s*(?:[-*]\s*)?(?:GREP|ARA)\s*:\s*(.+?)\s*$/i.exec(line);
    if (grep) { const g = grep[1].replace(/^`+|`+$/g, '').trim(); if (g) greps.push(g); continue; }
    const outl = /^\s*(?:[-*]\s*)?(?:OUTLINE|ANAHAT)\s*:\s*(.*?)\s*$/i.exec(line);
    if (outl) { outlines.push(outl[1].replace(/^[`'"]+|[`'"]+$/g, '') || '.'); continue; }
    const run = /^\s*(?:[-*]\s*)?(?:RUN|ÇALIŞTIR|CALISTIR|KOMUT)\s*:\s*(.+?)\s*$/i.exec(line);
    if (run) { const c = run[1].replace(/^`+|`+$/g, '').trim(); if (c) runs.push(c); continue; }
    const list = /^\s*(?:[-*]\s*)?(?:LIST|LİSTE|LISTE|DIR)\s*:\s*(.*?)\s*$/i.exec(line);
    if (list) { lists.push(list[1].replace(/^[`'"]+|[`'"]+$/g, '') || '.'); continue; }
    const read = /^\s*(?:[-*]\s*)?(?:READ|OKU)\s*:\s*(.+?)\s*$/i.exec(line);
    if (read) { reads.push(read[1].replace(/^[`'"]+|[`'"]+$/g, '')); continue; }
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
  return { reads, lists, greps, outlines, runs, edits };
}

const RUNS_PER_ROUND = 5;

async function grepAndReport(cwd, greps, tool) {
  const found = await grepProject(cwd, greps);
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
export async function runCommands(ctx, cwd, commands, permission, tool) {
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
    const r = await runCommand(command, { cwd, signal: ctx.signal });
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

const OUTLINE_DIR_FILES = 40; // files in a folder outline
const OUTLINE_DIR_EACH = 12;  // definitions per file there

/**
 * Outlines (outline.js) of files or folders, relative to cwd. A folder gives a short outline of
 * each file in it (git ls-files order). Resolves [{ path, text, error? }].
 */
export async function outlineFiles(cwd, specs) {
  const out = [];
  for (const spec of [...new Set(specs)].slice(0, 5)) {
    try {
      const clean = String(spec || '').trim().replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '');
      const { abs, rel } = !clean || clean === '.' ? { abs: cwd, rel: '.' } : safePath(cwd, clean);
      const st = await fs.stat(abs);
      if (st.isFile()) {
        if (st.size > GREP_FILE_BYTES) throw new Error('dosya çok büyük');
        out.push({ path: rel, text: outlineText(await fs.readFile(abs, 'utf8'), rel) });
        continue;
      }
      const prefix = rel === '.' ? '' : `${rel}/`;
      const files = (await allFiles(cwd, GREP_FILES_MAX)).filter((f) => f.startsWith(prefix) && outlineLang(f));
      const parts = [];
      for (const f of files.slice(0, OUTLINE_DIR_FILES)) {
        let text;
        try {
          const fst = await fs.stat(path.join(cwd, f));
          if (fst.size > GREP_FILE_BYTES) continue;
          text = await fs.readFile(path.join(cwd, f), 'utf8');
        } catch { continue; }
        const body = outlineText(text, f, OUTLINE_DIR_EACH);
        parts.push(`${f} (${text.split('\n').length} satır)\n${body.split('\n').map((l) => `  ${l}`).join('\n')}`);
      }
      const more = files.length - Math.min(files.length, OUTLINE_DIR_FILES);
      out.push({ path: rel, text: (parts.join('\n') || '(ana hattı çıkarılabilen dosya yok)') + (more ? `\n… ve ${more} dosya daha (alt klasör ver)` : '') });
    } catch (err) {
      out.push({ path: String(spec), error: err.code === 'ENOENT' ? 'dosya ya da klasör yok' : err.message });
    }
  }
  return out;
}

function outlineAndReport(cwd, specs, tool) {
  return outlineFiles(cwd, specs).then((found) => {
    for (const o of found) tool('Ortak: ana hat', { path: o.path }, o.error || `${o.text.split('\n').length} satır`, !!o.error);
    return found;
  });
}

// ---- files as attachments (capabilities.uploads: Gemini web) ----------------------------------

const UPLOAD_MIN_CHARS = 1500; // smaller files stay in the message text
const UPLOADS_MAX = 8;         // attachments per message (Gemini takes 10, the user's images included)
const UPLOAD_ROOT = path.join(ATT_ROOT, 'yukleme');

const uploadName = (f) => `${f.path.replace(/[\\/]+/g, '__').replace(/[^\w.-]+/g, '-')}${f.lines ? `__L${f.from}-${f.to}` : ''}.txt`;
const sha1 = (t) => crypto.createHash('sha1').update(t).digest('hex');

/**
 * Sends the files a text-only agent reads as attachments when its adapter takes them. `stage(files)`
 * writes them to a temp folder and returns them marked (`uploaded` / `unchanged`: prompts.js
 * fileBlock prints a note instead of the content); `turn(opts)` is ctx.turn with those attachments.
 * What a conversation already holds (lane.uploaded, per session) isn't sent again.
 */
export class Uploader {
  constructor(ctx, laneId, { resume = true } = {}) {
    this.ctx = ctx;
    this.laneId = laneId;
    this.on = !!ctx.adapterOf(laneId)?.capabilities?.uploads;
    this.fresh = !resume || !ctx.canResume(laneId); // the next turn starts a new conversation
    this.pending = [];
    this.marks = {};
    this.dir = null;
  }

  /** Hashes already in this lane's conversation. */
  known() {
    const lane = this.ctx.lane(this.laneId);
    const up = lane?.uploaded;
    return !this.fresh && up && up.session && up.session === lane.sessionId ? up.files || {} : {};
  }

  async stage(files) {
    if (!this.on || !files?.length) return files || [];
    const known = this.known();
    const out = [];
    const send = [];
    for (const f of files) {
      if (f.error || f.text.length < UPLOAD_MIN_CHARS) { out.push(f); continue; }
      const key = f.lines ? `${f.path}:${f.from}-${f.to}` : f.path;
      const hash = sha1(f.text);
      const name = uploadName(f);
      if (known[key] === hash || this.marks[key] === hash) { out.push({ ...f, unchanged: name }); continue; }
      this.marks[key] = hash;
      send.push({ f, name });
      out.push({ ...f, uploaded: name });
    }
    if (!send.length) return out;
    this.dir ||= path.join(UPLOAD_ROOT, `${this.ctx.meta.id}-${crypto.randomBytes(4).toString('hex')}`);
    await fs.mkdir(this.dir, { recursive: true });
    // Over the limit: the rest goes into one bundle file.
    const room = Math.max(1, UPLOADS_MAX - this.pending.length);
    const single = send.length > room ? send.slice(0, room - 1) : send;
    const bundled = send.slice(single.length);
    for (const { f, name } of single) {
      const file = path.join(this.dir, name);
      await fs.writeFile(file, `${f.text}\n`, 'utf8');
      this.pending.push({ name, mime: 'text/plain', path: file, fallback: P.fileBlock(f) });
    }
    if (bundled.length) {
      const name = `ortak-dosyalar-${this.pending.length + 1}.txt`;
      const body = bundled.map(({ f }) => P.fileBlock(f)).join('\n\n');
      const file = path.join(this.dir, name);
      await fs.writeFile(file, `${body}\n`, 'utf8');
      this.pending.push({ name, mime: 'text/plain', path: file, fallback: body });
      const inBundle = new Set(bundled.map(({ f }) => f));
      for (let i = 0; i < out.length; i++) {
        const src = files[i];
        if (inBundle.has(src)) out[i] = { ...out[i], uploaded: `${name} (içinde "### ${src.path}" başlığı)` };
      }
    }
    return out;
  }

  /** ctx.turn with the staged attachments; afterwards the conversation remembers them. */
  async turn(opts) {
    const uploads = this.pending;
    const marks = this.marks;
    this.pending = [];
    this.marks = {};
    try {
      const r = await this.ctx.turn(this.laneId, { ...opts, ...(uploads.length ? { uploads } : {}) });
      if (this.on) {
        const lane = this.ctx.lane(this.laneId);
        const files = { ...this.known(), ...marks };
        lane.uploaded = { session: lane.sessionId, files };
        this.fresh = false;
      }
      return r;
    } finally {
      if (this.dir && uploads.length) await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.dir = null;
    }
  }
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

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/** Replace `search` in `content` (LF text): exact, else ignoring trailing whitespace per line. */
function replaceOnce(content, search, replace) {
  const exact = countOf(content, search);
  if (exact === 1) return content.replace(search, () => replace);
  if (exact > 1) throw new Error('ARA metni dosyada birden fazla yerde geçiyor; daha uzun, benzersiz bir ARA metni ver');
  const rstrip = (s) => s.replace(/[ \t]+$/, '');
  const lines = content.split('\n');
  const want = search.split('\n').map(rstrip);
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) ok = rstrip(lines[i + k]) === want[k];
    if (ok) hits.push(i);
  }
  if (hits.length === 1) {
    lines.splice(hits[0], want.length, ...replace.split('\n'));
    return lines.join('\n');
  }
  if (hits.length > 1) throw new Error('ARA metni dosyada birden fazla yerde geçiyor; daha uzun, benzersiz bir ARA metni ver');
  throw new Error('ARA metni dosyada birebir bulunamadı (boşluklar ve satırlar dahil aynen kopyalanmalı)');
}

/** Applies edits grouped by file. Returns [{ path, ok, error?, created? }] per block. */
/** `cp` (checkpoints.begin) records each file's original content before it is first written. */
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
    let changed = false;
    for (const b of blocks) {
      try {
        if (!b.search.trim()) {
          if (content != null && content.trim()) throw new Error('ARA kısmı boş ama dosya zaten var; değiştirmek istediğin satırları ARA kısmına aynen yaz');
          content = b.replace;
          results.push({ path: rel, ok: true, created: original == null });
        } else {
          if (content == null) throw new Error('dosya yok (yeni dosya için ARA kısmını boş bırak)');
          content = replaceOnce(content, b.search, b.replace);
          results.push({ path: rel, ok: true });
        }
        changed = true;
      } catch (err) {
        results.push({ path: rel, ok: false, error: err.message });
      }
    }
    if (changed) {
      await cp?.note(abs, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, crlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
    }
  }
  return results;
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
      attached = files.length ? await readFiles(cwd, files) : [];
      for (const f of attached) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
      try {
        const r = await nativeTurn(ctx, laneId, {
          prompt: P.nativeCoderTask({ goal, task, listing: await projectListing(cwd), attached, readOnly, leadName }),
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

  const listing = await projectListing(cwd);
  const attached = preread || (files.length ? await readFiles(cwd, files) : []);
  if (!preread) for (const f of attached) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);

  const up = new Uploader(ctx, laneId);
  let prompt = P.textCoderTask({ goal, task, listing, attached: await up.stage(attached), readOnly, leadName });
  const applied = new Set();
  const failedNow = new Map();
  let text = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await up.turn({ prompt, permission: 'read-only', system: P.textCoderSystem(permission) });
    text = r.text;
    const { reads, greps, outlines, runs, edits } = parseAnswer(text);

    let results = [];
    if (edits.length) {
      if (readOnly) {
        tool('Ortak: değişiklik', { blocks: edits.length }, 'Salt okunur çalışma: değişiklikler uygulanmadı.', true);
      } else {
        results = await applyEdits(cwd, edits, cp);
        for (const res of results) {
          tool(res.created ? 'Ortak: dosya oluştur' : 'Ortak: düzenle', { path: res.path }, res.ok ? 'Uygulandı' : res.error, !res.ok);
          if (res.ok) { applied.add(res.path); failedNow.delete(res.path); } else failedNow.set(res.path, res.error);
        }
      }
    }
    const failed = results.filter((x) => !x.ok);
    const ran = runs.length ? await runCommands(ctx, cwd, runs, permission, tool) : [];
    const found = greps.length && round < MAX_ROUNDS ? await grepAndReport(cwd, greps, tool) : [];
    const outl = outlines.length && round < MAX_ROUNDS ? await outlineAndReport(cwd, outlines, tool) : [];
    const fresh = reads.length && round < MAX_ROUNDS ? await readFiles(cwd, reads) : [];
    for (const f of fresh) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);

    const broken = !edits.length && !readOnly && BROKEN_BLOCK.test(text);
    if (broken) tool('Ortak: değişiklik', { blocks: '?' }, 'Değişiklik blokları bozuk geldi (kod bloğu içinde değil); yeniden isteniyor.', true);
    if (!fresh.length && !ran.length && !found.length && !outl.length && !failed.length && !broken) break; // finished
    if (round === MAX_ROUNDS) break;
    // Next round: requested files + command output + what failed (with the current text of those files).
    const current = failed.length ? await readFiles(cwd, [...new Set(failed.map((x) => x.path))]) : [];
    prompt = broken && !fresh.length && !ran.length && !found.length && !outl.length
      ? P.textChatBrokenBlocks
      : P.textCoderFollow({ files: await up.stage(fresh), ran, found, outlines: outl, results, current: await up.stage(current) });
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
  const up = new Uploader(ctx, laneId, { resume });
  let text = '';
  for (let round = 1; round <= CHAT_ROUNDS; round++) {
    const r = await up.turn({ prompt, permission: 'read-only', system: [P.textChatSystem(permission), system].filter(Boolean).join('\n\n'), resume: round > 1 || resume });
    text = r.text;
    const { reads, lists, greps, outlines, runs, edits } = parseAnswer(text);

    let results = [];
    if (edits.length) {
      if (readOnly) {
        results = edits.map((e) => ({ path: e.path || '?', ok: false, error: 'salt okunur çalışma: değişiklik uygulanmadı' }));
        tool('Ortak: değişiklik', { blocks: edits.length }, 'Salt okunur çalışma: değişiklikler uygulanmadı.', true);
      } else {
        results = await applyEdits(cwd, edits, cp);
        for (const res of results) {
          tool(res.created ? 'Ortak: dosya oluştur' : 'Ortak: düzenle', { path: res.path }, res.ok ? 'Uygulandı' : res.error, !res.ok);
          if (res.ok) applied.add(res.path);
        }
      }
    }
    const last = round === CHAT_ROUNDS;
    const failed = readOnly ? [] : results.filter((x) => !x.ok);
    // Commands run after the edits (so `RUN: npm test` tests the changed code).
    const ran = runs.length ? await runCommands(ctx, cwd, runs, permission, tool) : [];
    const found = greps.length && !last ? await grepAndReport(cwd, greps, tool) : [];
    const outl = outlines.length && !last ? await outlineAndReport(cwd, outlines, tool) : [];
    const files = reads.length && !last ? await readFiles(cwd, reads) : [];
    for (const f of files) tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
    const dirs = lists.length && !last ? await listDirs(cwd, lists) : [];
    for (const d of dirs) tool('Ortak: klasörü listele', { path: d.path }, d.error || `${d.entries.length} öğe`, !!d.error);

    // Change markers but no parsable block: the web UI rendered it as markdown (no code fence),
    // which merges lines and eats "=======". Ask once more for fenced blocks.
    const broken = !edits.length && !readOnly && BROKEN_BLOCK.test(text);
    if (broken) tool('Ortak: değişiklik', { blocks: '?' }, 'Değişiklik blokları bozuk geldi (kod bloğu içinde değil); yeniden isteniyor.', true);

    if (last || (!files.length && !dirs.length && !ran.length && !found.length && !outl.length && !failed.length && !broken)) break;
    const current = failed.length ? await readFiles(cwd, [...new Set(failed.map((x) => x.path))]) : [];
    prompt = broken && !files.length && !dirs.length && !ran.length && !found.length && !outl.length
      ? P.textChatBrokenBlocks
      : P.textChatFollow({ files: await up.stage(files), dirs, ran, found, outlines: outl, results: readOnly ? [] : results, current: await up.stage(current) });
  }
  return { text, applied: [...applied] };
}

// ---- real function calling (API agents: Groq, OpenRouter, EVREN) ------------------------------
// Models that support it get the same hands as tools (list_dir, read_file, grep, run_command,
// edit_file, write_file) instead of the text protocol; the adapter loops until the model answers.
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

/** OpenAI-style tool definitions; read-only runs get no editing tools. */
export function nativeToolDefs(permission) {
  const str = (description) => ({ type: 'string', description });
  const int = (description) => ({ type: 'integer', description });
  const defs = [
    fn('list_dir', 'Bir klasörün içeriğini listeler (klasörler "/" ile biter).', { path: str('Proje köküne göre klasör yolu; kök için "."') }, ['path']),
    fn('read_file', `Bir dosyayı okur. Büyük dosyalarda yalnızca gereken satırları iste: ${READ_SUMMARY_LINES} satırdan uzun bir dosya aralıksız istenirse tamamı yerine ana hattı ve ilk ${READ_SUMMARY_HEAD} satırı gelir.`, {
      path: str('Proje köküne göre dosya yolu'),
      start_line: int('İlk satır (1\'den başlar, isteğe bağlı)'),
      end_line: int('Son satır (isteğe bağlı)'),
      full: { type: 'boolean', description: 'Uzun dosyanın tamamını gerçekten istiyorsan true (bağlamı doldurur; isteğe bağlı)' },
    }, ['path']),
    fn('outline', 'Bir dosyanın ana hattı: fonksiyonlar, sınıflar, başlıklar ve satır numaraları. Klasör verilirse içindeki her dosyanın kısa ana hattı. Büyük dosyada neyin nerede olduğunu bulmak için read_file\'dan önce kullan.', {
      path: str('Proje köküne göre dosya ya da klasör yolu; kök için "."'),
    }, ['path']),
    fn('grep', 'Projede düzenli ifadeyle arar (büyük/küçük harf duyarsız, .gitignore\'a uyar); eşleşmeleri dosya:satır: metin olarak verir.', {
      pattern: str('Aranacak düzenli ifade ya da metin'),
      dir: str('Yalnızca bu klasörde ara (isteğe bağlı)'),
    }, ['pattern']),
    fn('run_command', `Proje klasöründe bir ${shell().name} komutu çalıştırır; çıktıyı ve çıkış kodunu verir. En fazla ${COMMAND_TIMEOUT_MS / 1000} sn.`, {
      command: str('Çalıştırılacak komut, ör. "npm test"'),
    }, ['command']),
  ];
  if (permission === 'read-only') return defs;
  return [...defs,
    fn('edit_file', 'Bir dosyada old_text\'i new_text ile değiştirir. old_text dosyada birebir (boşluklar dahil) ve tek bir kez geçmeli.', {
      path: str('Proje köküne göre dosya yolu'),
      old_text: str('Dosyadaki mevcut metin (birkaç satır bağlamla, benzersiz olacak şekilde)'),
      new_text: str('Yerine gelecek metin'),
    }, ['path', 'old_text', 'new_text']),
    fn('write_file', 'Yeni bir dosya oluşturur ya da bir dosyanın tamamını verilen içerikle yazar.', {
      path: str('Proje köküne göre dosya yolu'),
      content: str('Dosyanın tam içeriği'),
    }, ['path', 'content']),
  ];
}

/** { text, lines } of a text file in cwd longer than READ_SUMMARY_LINES, else null. */
async function longFile(cwd, rel) {
  try {
    const { abs } = safePath(cwd, rel);
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > GREP_FILE_BYTES) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null;
    const text = buf.toString('utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return lines > READ_SUMMARY_LINES ? { text, lines } : null;
  } catch {
    return null;
  }
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
  const readOnly = permission === 'read-only';
  const editResult = (res) => {
    tool(res.created ? 'Ortak: dosya oluştur' : 'Ortak: düzenle', { path: res.path }, res.ok ? 'Uygulandı' : res.error, !res.ok);
    if (res.ok) { applied.add(res.path); failed.delete(res.path); } else failed.set(res.path, res.error);
  };
  return async (name, a) => {
    switch (name) {
      case 'list_dir': {
        const [d] = await listDirs(cwd, [a.path || '.']);
        tool('Ortak: klasörü listele', { path: d.path }, d.error || `${d.entries.length} öğe`, !!d.error);
        return d.error ? `Hata: ${d.error}` : (d.entries.join('\n') || '(boş)') + (d.more ? `\n… ve ${d.more} öğe daha` : '');
      }
      case 'read_file': {
        if (!a.path) return 'Hata: path gerekli';
        const from = intOf(a.start_line), to = intOf(a.end_line);
        // A long file asked for whole: its outline and head, so one read doesn't fill the context.
        if (!from && !to && a.full !== true) {
          const long = await longFile(cwd, String(a.path));
          if (long) {
            const [f] = await readFiles(cwd, [`${a.path}:1-${READ_SUMMARY_HEAD}`]);
            tool('Ortak: dosya oku', { path: f.path }, f.error || `${long.lines} satırlık dosya: ana hat + ilk ${READ_SUMMARY_HEAD} satır gönderildi`, !!f.error);
            if (f.error) return nativeFile(f);
            return `[${f.path} · toplam ${long.lines} satır — uzun dosya: tamamı yerine ana hat ve ilk ${READ_SUMMARY_HEAD} satır gönderildi. ` +
              'Gereken kısmı start_line/end_line ile iste (tamamı gerçekten gerekiyorsa full=true).]\n' +
              `Ana hat:\n${outlineText(long.text, f.path)}\n\n${nativeFile(f)}`;
          }
        }
        const spec = from || to ? `${a.path}:${from || 1}-${to || (from || 1) + 399}` : String(a.path);
        const [f] = await readFiles(cwd, [spec]);
        tool('Ortak: dosya oku', { path: f.lines ? `${f.path}:${f.from}-${f.to}` : f.path }, readNote(f), !!f.error);
        return nativeFile(f);
      }
      case 'outline': {
        const [o] = await outlineAndReport(cwd, [String(a.path || '.')], tool);
        return o.error ? `Hata: ${o.error}` : o.text;
      }
      case 'grep': {
        if (!a.pattern) return 'Hata: pattern gerekli';
        const [g] = await grepAndReport(cwd, [a.dir ? `${a.pattern} @ ${a.dir}` : String(a.pattern)], tool);
        if (g.error) return `Hata: ${g.error}`;
        if (!g.hits.length) return 'Eşleşme yok.';
        return `${g.hits.length + g.more} eşleşme, ${g.files} dosyada:\n${g.hits.join('\n')}${g.more ? `\n… ve ${g.more} eşleşme daha (deseni daralt ya da dir ver)` : ''}`;
      }
      case 'run_command': {
        if (!a.command) return 'Hata: command gerekli';
        const [r] = await runCommands(ctx, cwd, [String(a.command)], permission, tool);
        if (r.refused) return `Çalıştırılmadı: ${r.refused}`;
        return `${r.timedOut ? `Zaman aşımı: ${COMMAND_TIMEOUT_MS / 1000} sn sonra durduruldu.` : `Çıkış kodu: ${r.code}`}\n${r.output || '(çıktı yok)'}`;
      }
      case 'edit_file': {
        if (readOnly) return 'Hata: salt okunur çalışma, dosya değiştirilemez.';
        if (!a.path) return 'Hata: path gerekli';
        const [res] = await applyEdits(cwd, [{ path: String(a.path), search: String(a.old_text ?? ''), replace: String(a.new_text ?? '') }], cp);
        editResult(res);
        if (res.ok) return res.created ? 'Dosya oluşturuldu.' : 'Uygulandı.';
        return `UYGULANAMADI: ${res.error.replace(/ARA (metni|kısmı)/g, 'old_text')}. Dosyayı read_file ile yeniden okuyup tekrar dene` +
          (a.old_text ? '.' : ' (mevcut bir dosyayı baştan yazmak için write_file kullan).');
      }
      case 'write_file': {
        if (readOnly) return 'Hata: salt okunur çalışma, dosya yazılamaz.';
        if (!a.path) return 'Hata: path gerekli';
        let sp;
        try { sp = safePath(cwd, String(a.path)); } catch (err) { editResult({ path: String(a.path), ok: false, error: err.message }); return `Hata: ${err.message}`; }
        let before = null;
        try { before = await fs.readFile(sp.abs, 'utf8'); } catch { /* new file */ }
        const text = String(a.content ?? '').replace(/\r\n/g, '\n');
        await cp?.note(sp.abs, sp.rel);
        await fs.mkdir(path.dirname(sp.abs), { recursive: true });
        await fs.writeFile(sp.abs, before?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text, 'utf8');
        editResult({ path: sp.rel, ok: true, created: before == null });
        return before == null ? 'Dosya oluşturuldu.' : 'Dosya baştan yazıldı.';
      }
      default:
        return `Hata: bilinmeyen araç "${name}". Kullanılabilenler: ${nativeToolDefs(permission).map((d) => d.function.name).join(', ')}`;
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
 * in `cwd`. The first turn of a session also gets the project's file list. Resolves { text }.
 */
export async function work(ctx, laneId, { prompt, permission = 'read-only', system, cwd = ctx.meta.cwd, resume = true }) {
  if (!isTextOnly(ctx, laneId)) return ctx.turn(laneId, { prompt, permission, system, cwd, resume });
  const fresh = !resume || !ctx.canResume(laneId);
  const body = fresh ? P.textWorkIntro({ listing: await projectListing(cwd), prompt }) : prompt;
  return textChatTurn(ctx, laneId, { prompt: body, permission, resume, cwd, system });
}
export const _internals = { parseAnswer, replaceOnce, clip };

// What a reviewer (team denetçi, lead yönetici) sees of a run's changes. A raw `git diff --binary`
// is a poor prompt: one changed image or lockfile can fill the whole budget with base85 / generated
// lines, and a plain head-cut hides every file after the first few. Here the diff is split per
// file, binary / lockfile / generated sections are reduced to one line, the remaining budget is
// shared fairly between the files (small files whole, big ones cut at a line boundary), and the
// prompt names every file that was cut or left out so the reviewer can read it itself.

// Prompt size (characters) an agent comfortably takes in one turn. API models on free tiers are the
// tight ones: Groq's free tier allows ~8000 tokens per MINUTE, so one 60K-char prompt (~18K tokens)
// fails with "Request too large" before the model sees anything.
const BUDGETS = {
  groq: 14_000,
  openrouter: 40_000,
  evren: 40_000,
  gemini: 50_000,
  mock: 60_000,
};
const DEFAULT_BUDGET = 100_000;

/** Characters of context (diff + files) worth sending to this lane's agent in one prompt. */
export function promptBudget(adapter) {
  const own = Number(adapter?.capabilities?.promptBudget);
  if (own > 0) return own;
  return BUDGETS[adapter?.id] ?? DEFAULT_BUDGET;
}

const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|uv\.lock|flake\.lock|packages\.lock\.json)$/i;
const GENERATED = /(\.min\.(js|css)|\.map|\.snap)$|(^|\/)(dist|build|out|coverage|\.next|node_modules|vendor)\//i;

const unquote = (p) => {
  const s = String(p || '').trim();
  if (!s.startsWith('"')) return s;
  try { return JSON.parse(s); } catch { return s.slice(1, -1); }
};

/** Per-file sections of a unified git diff: [{ path, oldPath, text, added, removed, kind, status }]. */
export function splitDiff(diff) {
  const src = String(diff || '');
  if (!src.trim()) return [];
  const starts = [];
  const re = /^diff --git /gm;
  for (let m; (m = re.exec(src));) starts.push(m.index);
  if (!starts.length) return [{ path: '(diff)', oldPath: null, text: src, added: 0, removed: 0, kind: 'text', status: 'modified' }];
  return starts.map((at, i) => {
    const text = src.slice(at, starts[i + 1] ?? src.length);
    const head = text.slice(0, 2000);
    const pathOf = (re2) => { const m = re2.exec(head); return m ? unquote(m[1]).replace(/^[ab]\//, '') : null; };
    const plus = pathOf(/^\+\+\+ (.+)$/m);
    const minus = pathOf(/^--- (.+)$/m);
    const renameTo = pathOf(/^rename to (.+)$/m);
    const renameFrom = pathOf(/^rename from (.+)$/m);
    const header = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/m.exec(head);
    let path = renameTo || (plus && plus !== '/dev/null' ? plus : null) || (minus && minus !== '/dev/null' ? minus : null) || (header ? header[2] : '(?)');
    path = unquote(path);
    let status = 'modified';
    if (/^new file mode/m.test(head)) status = 'added';
    else if (/^deleted file mode/m.test(head)) status = 'deleted';
    else if (renameTo) status = 'renamed';
    let added = 0, removed = 0;
    const body = text.split('\n');
    let inHunk = false;
    for (const line of body) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    const binary = /^GIT binary patch$/m.test(text) || /^Binary files .* differ$/m.test(head);
    const kind = binary ? 'binary' : LOCKFILES.test(path) ? 'lockfile' : GENERATED.test(path) ? 'generated' : 'text';
    return { path, oldPath: renameFrom || null, text, added, removed, kind, status };
  });
}

const STATUS_TR = { added: 'yeni', deleted: 'silindi', renamed: 'taşındı', modified: '' };
const KIND_TR = { binary: 'ikili dosya, içerik gösterilmedi', lockfile: 'kilit dosyası, içerik gösterilmedi', generated: 'üretilmiş dosya, içerik gösterilmedi' };

function fileLine(f, note) {
  const tags = [STATUS_TR[f.status], f.oldPath ? `eski adı: ${f.oldPath}` : '', note].filter(Boolean);
  const counts = f.kind === 'binary' ? '' : ` (+${f.added} −${f.removed})`;
  return `- ${f.path}${counts}${tags.length ? ` — ${tags.join('; ')}` : ''}`;
}

/** Cut a file section at a line boundary to at most `room` chars. */
function cutSection(text, room) {
  if (text.length <= room) return { text, cut: false };
  const lines = text.split('\n');
  const out = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > room) break;
    out.push(line);
    size += line.length + 1;
  }
  return { text: out.join('\n'), cut: true, shown: out.length, total: lines.length };
}

/**
 * The diff as a reviewer prompt section within `budget` characters.
 * Resolves { text, files: [path], cut: [path], omitted: [path], stats: { files, added, removed } }.
 * `diff == null` (no git) and an empty diff get a one-line explanation.
 */
export function reviewDiff(diff, budget = DEFAULT_BUDGET) {
  if (diff == null) {
    return {
      text: '(Proje bir git deposu değil; diff yok. Değişen dosyaları adım özetlerinden bulup doğrudan oku.)',
      files: [], cut: [], omitted: [], stats: { files: 0, added: 0, removed: 0 },
    };
  }
  const files = splitDiff(diff);
  if (!files.length) return { text: '(Hiçbir dosya değişmedi.)', files: [], cut: [], omitted: [], stats: { files: 0, added: 0, removed: 0 } };

  const stats = { files: files.length, added: 0, removed: 0 };
  for (const f of files) { stats.added += f.added; stats.removed += f.removed; }

  // Deleted files: the reviewer needs to know they are gone, not their old content.
  const shown = files.filter((f) => f.kind === 'text' && f.status !== 'deleted');
  const listMax = Math.max(2000, Math.floor(budget * 0.2));
  const notes = new Map();
  for (const f of files) {
    if (f.kind !== 'text') notes.set(f.path, KIND_TR[f.kind]);
  }

  // Fair share: smallest sections first, each gets at most an equal part of what is left.
  let room = Math.max(0, budget - Math.min(listMax, files.length * 90) - 600);
  const take = new Map();
  const order = [...shown].sort((a, b) => a.text.length - b.text.length);
  for (let i = 0; i < order.length; i++) {
    const share = Math.floor(room / (order.length - i));
    const f = order[i];
    if (share < 400) { take.set(f.path, null); continue; } // not even a hunk fits
    const c = cutSection(f.text, share);
    take.set(f.path, c);
    room -= c.text.length + 1;
  }

  const cut = [];
  const omitted = [];
  for (const f of shown) {
    const c = take.get(f.path);
    if (!c) { omitted.push(f.path); notes.set(f.path, 'yer kalmadı, diff gösterilmedi — dosyayı kendin oku'); }
    else if (c.cut) { cut.push(f.path); notes.set(f.path, `diff kısaltıldı (${c.shown}/${c.total} satır) — devamı için dosyayı oku`); }
  }

  let list = files.map((f) => fileLine(f, notes.get(f.path))).join('\n');
  if (list.length > listMax) list = `${list.slice(0, listMax)}\n… (liste kısaltıldı)`;
  const body = shown.map((f) => take.get(f.path)?.text).filter(Boolean).join('\n');
  const head = `Değişen dosyalar (${stats.files} dosya, +${stats.added} −${stats.removed}):\n${list}`;
  const tail = cut.length || omitted.length
    ? `\n\nDİKKAT: Bütün değişiklikler bu mesaja sığmadı. ${[...cut, ...omitted].length} dosyanın diff'i kısaltıldı ya da gösterilmedi; ` +
      'bu dosyaları değerlendirmeden önce kendin oku (yukarıdaki listede işaretli).'
    : '';
  return {
    text: `${head}\n\n${body ? '```diff\n' + body + '\n```' : '(Gösterilecek metin diff\'i yok.)'}${tail}`,
    files: files.map((f) => f.path),
    cut,
    omitted,
    stats,
  };
}

/** Only the changed-file list (for a worker that can read the files itself). */
export function changedFiles(diff, max = 4000) {
  const files = splitDiff(diff);
  if (!files.length) return diff == null ? '(git deposu değil)' : '(değişiklik yok)';
  const list = files.map((f) => fileLine(f, f.kind === 'text' ? '' : KIND_TR[f.kind].split(',')[0])).join('\n');
  return list.length > max ? `${list.slice(0, max)}\n… (liste kısaltıldı)` : list;
}

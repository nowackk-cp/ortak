// Applying an agent's text edits. Free models often get whitespace or indentation slightly wrong,
// so the text to replace is accepted at the strictest level that finds it exactly once:
//   1 exact   2 trailing whitespace ignored   3 indentation ignored (the replacement is re-indented)
// Leading / trailing blank lines of the search text are ignored at levels 2–3. A search that is not
// found names the closest region of the file so the model can copy the real text and retry.

const AMBIGUOUS = 'ARA metni dosyada birden fazla yerde geçiyor; daha uzun, benzersiz bir ARA metni ver';
const LEVEL_TR = { 2: 'satır sonu boşlukları yok sayılarak', 3: 'girinti farkı yok sayılarak' };

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

const rstrip = (s) => s.replace(/[ \t]+$/, '');
const indentOf = (s) => /^[ \t]*/.exec(s)[0];

/** Drop leading / trailing blank lines (the same count from `replace` when it has them too). */
function trimBlankEdges(want, repl) {
  let a = 0;
  let b = want.length;
  while (a < b && !want[a].trim()) a++;
  while (b > a && !want[b - 1].trim()) b--;
  const r = [...repl];
  for (let i = 0; i < a && r.length && !r[0].trim(); i++) r.shift();
  for (let i = 0; i < want.length - b && r.length && !r[r.length - 1].trim(); i++) r.pop();
  return { want: want.slice(a, b), repl: r };
}

/** `base` changed by the difference between indentation `to` and `from` ("    " + ("  " − "")). */
function shift(base, from, to) {
  if (to.startsWith(from)) return base + to.slice(from.length);
  if (from.startsWith(to)) return base.slice(0, Math.max(0, base.length - (from.length - to.length)));
  return base;
}

/**
 * Re-indents `repl` for a match that ignored indentation: `want` (the search lines) matched
 * `found` (the file's lines). Replacement lines equal to a search line (in order) are anchors and
 * take that file line's indentation. A changed line takes the indentation of the first search line
 * it replaces (between the surrounding anchors), shifted by how the model indented it relative to
 * that search line; a purely added line follows the previous line.
 */
function reindent(repl, want, found) {
  const anchorOf = repl.map(() => -1);
  let from = 0;
  repl.forEach((l, i) => {
    if (!l.trim()) return;
    const k = want.findIndex((w, x) => x >= from && w.trim() === l.trim());
    if (k >= 0) { anchorOf[i] = k; from = k + 1; }
  });
  const firstText = want.findIndex((w) => w.trim());
  const out = [];
  let prev = null;     // { own, actual } of the previous non-blank replacement line
  let lastAnchor = -1; // search line of the last anchor seen
  repl.forEach((l, i) => {
    if (!l.trim()) { out.push(l); return; }
    const own = indentOf(l);
    let actual;
    if (anchorOf[i] >= 0) {
      lastAnchor = anchorOf[i];
      actual = indentOf(found[lastAnchor]);
    } else {
      const nextAnchor = anchorOf.slice(i + 1).find((x) => x >= 0) ?? want.length;
      let r = lastAnchor + 1;
      while (r < nextAnchor && !want[r].trim()) r++;
      if (r < nextAnchor) actual = shift(indentOf(found[r]), indentOf(want[r]), own);
      else if (prev) actual = shift(prev.actual, prev.own, own);
      else actual = shift(indentOf(found[firstText]), indentOf(want[firstText]), own);
    }
    out.push(actual + l.slice(own.length));
    prev = { own, actual };
  });
  return out;
}

/** Region of `lines` most like `want` (trimmed lines equal), as a hint for a failed edit. */
export function closestRegion(lines, want, maxChars = 1800) {
  const w = want.map((l) => l.trim());
  const m = Math.min(w.length, 200);
  if (!m) return null;
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(lines.length, 20_000);
  for (let i = 0; i < limit; i++) {
    let score = 0;
    for (let k = 0; k < m && i + k < lines.length; k++) if (w[k] && lines[i + k].trim() === w[k]) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore < Math.max(1, Math.ceil(m * 0.3))) return null;
  const end = Math.min(lines.length, best + m);
  let text = lines.slice(best, end).join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`;
  return { from: best + 1, to: end, text };
}

/**
 * Replace `search` in `content` (LF text) once. Resolves { content, level } (1 exact, 2 trailing
 * whitespace, 3 indentation) or throws a Turkish error (not found → with the closest region).
 */
export function applyReplace(content, search, replace) {
  const exact = countOf(content, search);
  if (exact === 1) return { content: content.replace(search, () => replace), level: 1 };
  if (exact > 1) throw new Error(AMBIGUOUS);
  const lines = content.split('\n');
  const { want, repl } = trimBlankEdges(search.split('\n'), replace.split('\n'));
  if (!want.length) throw new Error('ARA metni boş');
  const levels = [[2, rstrip], [3, (s) => s.trim()]];
  for (const [level, key] of levels) {
    const keys = want.map(key);
    const hits = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < want.length && ok; k++) ok = key(lines[i + k]) === keys[k];
      if (ok) hits.push(i);
    }
    if (hits.length > 1) throw new Error(AMBIGUOUS);
    if (hits.length === 1) {
      const at = hits[0];
      const out = level === 3 ? reindent(repl, want, lines.slice(at, at + want.length)) : repl;
      lines.splice(at, want.length, ...out);
      return { content: lines.join('\n'), level };
    }
  }
  const near = closestRegion(lines, want);
  throw new Error('ARA metni dosyada birebir bulunamadı (boşluklar ve satırlar dahil aynen kopyalanmalı)' +
    (near ? `. En yakın yer, satır ${near.from}-${near.to}:\n${near.text}` : '; önce dosyayı yeniden oku'));
}

export const replaceOnce = (content, search, replace) => applyReplace(content, search, replace).content;

/** How a fuzzy match was made, for the tool card ("girinti farkı yok sayılarak"). */
export const levelNote = (level) => LEVEL_TR[level] || '';

/**
 * Several replacements in one file, all or nothing. `edits` = [{ search, replace }].
 * Resolves { content, levels } or throws an Error naming the failing edit (1-based).
 */
export function applyAll(content, edits) {
  let out = content;
  const levels = [];
  edits.forEach((e, i) => {
    try {
      const r = applyReplace(out, String(e.search ?? ''), String(e.replace ?? ''));
      out = r.content;
      levels.push(r.level);
    } catch (err) {
      const e2 = new Error(`${i + 1}. değişiklik: ${err.message}`);
      e2.index = i;
      throw e2;
    }
  });
  return { content: out, levels };
}

/** Lines `from`..`to` (1-based, inclusive) replaced by `text`. Throws for a bad range. */
export function replaceLines(content, from, to, text) {
  const lines = content.split('\n');
  const n = lines.length && lines.at(-1) === '' ? lines.length - 1 : lines.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > n) {
    throw new Error(`geçersiz satır aralığı ${from}-${to} (dosyada ${n} satır var)`);
  }
  lines.splice(from - 1, to - from + 1, ...String(text).replace(/\r\n/g, '\n').split('\n'));
  return lines.join('\n');
}

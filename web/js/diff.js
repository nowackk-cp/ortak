// Unified diff parser + viewer (DOM built with text nodes only).
import { h, icon } from './dom.js';
import { fmtInt } from './util.js';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const stripPrefix = (p) => p.replace(/^"?(?:a|b)\//, '').replace(/"$/, '').replace(/\t.*$/, '');

export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');

  const newFile = () => {
    file = { oldPath: '', newPath: '', status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
    files.push(file);
    hunk = null;
  };

  for (const line of lines) {
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      const c = line[0];
      if (c === '+') { hunk.lines.push({ t: 'add', s: line.slice(1), n: hunk.newNo++ }); hunk.newLeft--; file.additions++; continue; }
      if (c === '-') { hunk.lines.push({ t: 'del', s: line.slice(1), o: hunk.oldNo++ }); hunk.oldLeft--; file.deletions++; continue; }
      if (c === ' ' || line === '') { hunk.lines.push({ t: 'ctx', s: line.slice(1), o: hunk.oldNo++, n: hunk.newNo++ }); hunk.oldLeft--; hunk.newLeft--; continue; }
      if (c === '\\') { hunk.lines.push({ t: 'meta', s: line }); continue; }
      hunk.oldLeft = hunk.newLeft = 0; // malformed: fall through to header parsing
    }
    if (hunk && line.startsWith('\\')) { hunk.lines.push({ t: 'meta', s: line }); continue; }

    if (line.startsWith('diff --git ')) {
      newFile();
      const m = line.match(/^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)(.+?)"?$/);
      if (m) { file.oldPath = m[1]; file.newPath = m[2]; }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!file || file.hunks.length) newFile();
      const p = line.slice(4);
      if (p.startsWith('/dev/null')) file.status = 'added';
      else file.oldPath = stripPrefix(p);
      continue;
    }
    if (line.startsWith('+++ ') && file) {
      const p = line.slice(4);
      if (p.startsWith('/dev/null')) file.status = 'deleted';
      else file.newPath = stripPrefix(p);
      continue;
    }
    const hm = line.match(HUNK);
    if (hm && file) {
      hunk = {
        header: line,
        oldNo: +hm[1], newNo: +hm[3],
        oldLeft: hm[2] === undefined ? 1 : +hm[2],
        newLeft: hm[4] === undefined ? 1 : +hm[4],
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) { file.status = 'renamed'; file.newPath = line.slice(10); }
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true;
  }
  return files;
}

const STATUS_TR = { added: 'yeni', deleted: 'silindi', renamed: 'taşındı', modified: '' };

function fileBody(f) {
  if (f.binary) return h('div', { class: 'diff-empty', text: 'İkili dosya — içerik gösterilmiyor.' });
  if (!f.hunks.length) return h('div', { class: 'diff-empty', text: f.status === 'renamed' ? 'Yalnızca yeniden adlandırıldı.' : 'İçerik değişikliği yok.' });
  const rows = [];
  for (const hk of f.hunks) {
    rows.push(h('tr', { class: 'd-hunk' }, h('td', { class: 'd-ln', colspan: '2' }), h('td', { class: 'd-code', text: hk.header })));
    for (const l of hk.lines) {
      if (l.t === 'meta') { rows.push(h('tr', { class: 'd-meta' }, h('td', { class: 'd-ln', colspan: '2' }), h('td', { class: 'd-code', text: l.s }))); continue; }
      const sign = l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' ';
      rows.push(h('tr', { class: `d-${l.t}` },
        h('td', { class: 'd-ln', text: l.o ?? '' }),
        h('td', { class: 'd-ln', text: l.n ?? '' }),
        h('td', { class: 'd-code' }, h('span', { class: 'd-sign', text: sign }), l.s)));
    }
  }
  return h('div', { class: 'diff-body' }, h('table', { class: 'diff-table' }, h('tbody', {}, rows)));
}

function statBar(add, del) {
  const total = add + del || 1;
  const blocks = 5;
  const a = Math.round((add / total) * blocks);
  const cells = [];
  for (let i = 0; i < blocks; i++) cells.push(h('i', { class: i < a ? 'sa' : 'sd' }));
  return h('span', { class: 'statbar', 'aria-hidden': 'true' }, cells);
}

/** Render a diff string. `stats` (from the server) is preferred for the summary line. */
export function renderDiff(text, stats) {
  const files = parseDiff(text);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const sFiles = stats?.files ?? files.length;
  const sAdd = stats?.additions ?? adds;
  const sDel = stats?.deletions ?? dels;

  const wrap = h('div', { class: 'diff' });
  wrap.append(h('div', { class: 'diff-summary' },
    icon('file'),
    h('span', {}, `${fmtInt(sFiles)} dosya değişti`),
    h('span', { class: 'n-add', text: `+${fmtInt(sAdd)}` }),
    h('span', { class: 'n-del', text: `−${fmtInt(sDel)}` })));

  if (!files.length) {
    wrap.append(h('div', { class: 'diff-empty', text: String(text || '').trim() ? 'Diff çözümlenemedi.' : 'Değişiklik yok.' }));
    if (String(text || '').trim()) wrap.append(h('pre', { class: 'diff-raw', text: String(text) }));
    return wrap;
  }

  const totalLines = files.reduce((n, f) => n + f.hunks.reduce((m, hk) => m + hk.lines.length, 0), 0);
  files.forEach((f, i) => {
    const path = f.status === 'deleted' ? f.oldPath || f.newPath : f.newPath || f.oldPath;
    const openByDefault = totalLines <= 600 || i < 3;
    const det = h('details', { class: 'diff-file' });
    let built = false;
    const build = () => { if (!built) { built = true; det.append(fileBody(f)); } };
    det.append(h('summary', {},
      icon('chevron', 'chev'),
      h('span', { class: 'diff-path', title: f.status === 'renamed' ? `${f.oldPath} → ${f.newPath}` : path, text: path || '(adsız)' }),
      STATUS_TR[f.status] && h('span', { class: `badge badge-${f.status}`, text: STATUS_TR[f.status] }),
      h('span', { class: 'diff-fstat' },
        h('span', { class: 'n-add', text: `+${f.additions}` }),
        h('span', { class: 'n-del', text: `−${f.deletions}` }),
        statBar(f.additions, f.deletions))));
    det.addEventListener('toggle', () => { if (det.open) build(); });
    if (openByDefault) { build(); det.open = true; }
    wrap.append(det);
  });
  return wrap;
}

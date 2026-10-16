// Small, safe Markdown renderer. Every piece of source text is HTML-escaped before any tag is
// generated, so the output only ever contains the tags produced here. Links are limited to
// http/https. Returns an HTML string meant for `el.innerHTML`.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BQ = /^ {0,3}>[ \t]?(.*)$/;
const LI = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const MAX_DEPTH = 10;

function expandTabs(line) {
  return line.indexOf('\t') === -1 ? line : line.replace(/^\t+/, (t) => '    '.repeat(t.length));
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isFenceClose(line, fence) {
  const t = line.trim();
  return t.length >= fence.length && t[0] === fence[0] && /^(`+|~+)$/.test(t);
}

function isTableStart(lines, i) {
  const a = lines[i], b = lines[i + 1];
  return b !== undefined && a.includes('|') && b.includes('|') && b.includes('-') && TABLE_SEP.test(b);
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || BQ.test(line) || LI.test(line) || isTableStart(lines, i);
}

function codeBlock(code, lang) {
  const l = String(lang || '').replace(/[^\w+#.-]/g, '').slice(0, 24);
  return (
    '<div class="md-code"><div class="md-code-head"><span class="md-code-lang">' +
    escapeHtml(l || 'kod') +
    '</span><button type="button" class="md-copy" title="Kodu kopyala">Kopyala</button></div>' +
    '<pre><code>' + escapeHtml(code) + '</code></pre></div>'
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function table(lines, i) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const al = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
  let html = '<div class="md-table"><table><thead><tr>';
  head.forEach((c, k) => { html += `<th${al(k)}>${inline(c)}</th>`; });
  html += '</tr></thead><tbody>';
  let j = i + 2;
  while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
    const cells = splitRow(lines[j]);
    html += '<tr>';
    for (let k = 0; k < head.length; k++) html += `<td${al(k)}>${inline(cells[k] ?? '')}</td>`;
    html += '</tr>';
    j++;
  }
  html += '</tbody></table></div>';
  return [html, j];
}

function list(lines, i, depth) {
  const first = lines[i].match(LI);
  const ordered = /\d/.test(first[2]);
  const baseIndent = first[1].length;
  const items = [];
  let item = null;
  let blank = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { blank = true; if (item) item.lines.push(''); i++; continue; }
    const m = line.match(LI);
    const ind = indentOf(line);
    if (m && m[1].length <= baseIndent + 1 && (!item || ind < item.contentIndent)) {
      if (/\d/.test(m[2]) !== ordered) break; // list type changed -> new list
      item = { lines: [m[3] || ''], contentIndent: m[1].length + m[2].length + 1, num: parseInt(m[2], 10) };
      items.push(item);
      blank = false;
      i++;
      continue;
    }
    if (item && ind >= Math.min(item.contentIndent, baseIndent + 2)) {
      item.lines.push(line.slice(Math.min(ind, item.contentIndent)));
      blank = false;
      i++;
      continue;
    }
    if (item && !blank && !startsBlock(lines, i)) { // lazy paragraph continuation
      item.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && items[0] && items[0].num !== 1 ? ` start="${items[0].num}"` : '';
  let html = `<${tag}${start}>`;
  for (const it of items) {
    while (it.lines.length && !it.lines[it.lines.length - 1].trim()) it.lines.pop();
    let body = it.lines;
    let check = '';
    const tm = body[0] && body[0].match(/^\[([ xX])\][ \t]+(.*)$/);
    if (tm) {
      check = tm[1] === ' ' ? '<span class="md-check">☐</span> ' : '<span class="md-check done">☑</span> ';
      body = [tm[2], ...body.slice(1)];
    }
    let inner = blocks(body, depth + 1);
    if (check) inner = inner.startsWith('<p>') ? `<p>${check}${inner.slice(3)}` : check + inner;
    html += `<li${check ? ' class="md-task"' : ''}>${inner}</li>`;
  }
  html += `</${tag}>`;
  return [html, i];
}

function blocks(lines, depth = 0) {
  if (depth > MAX_DEPTH) return `<p>${inline(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(FENCE))) {
      const fence = m[2];
      const pad = m[1].length;
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) {
        const l = lines[i];
        body.push(pad ? l.replace(new RegExp(`^ {0,${pad}}`), '') : l);
        i++;
      }
      i++; // closing fence (or end of input while streaming)
      out.push(codeBlock(body.join('\n'), m[3]));
      continue;
    }
    if ((m = line.match(HEADING)) && (m[2] !== undefined || /^ {0,3}#{1,6}\s*$/.test(line))) {
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2] || '')}</h${lvl}>`);
      i++;
      continue;
    }
    if (HR.test(line)) { out.push('<hr>'); i++; continue; }
    if (BQ.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim()) {
        const q = lines[i].match(BQ);
        if (q) body.push(q[1]);
        else if (body.length && !startsBlock(lines, i)) body.push(lines[i]);
        else break;
        i++;
      }
      out.push(`<blockquote>${blocks(body, depth + 1)}</blockquote>`);
      continue;
    }
    if (LI.test(line) && line.match(LI)[3] !== undefined) {
      const [html, next] = list(lines, i, depth);
      out.push(html);
      i = next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const [html, next] = table(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

const safeUrl = (u) => /^https?:\/\/[^\s]+$/i.test(u);
const linkTag = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

/** Inline markdown for one block of raw text (escapes first). */
export function inline(raw) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escapeHtml(String(raw ?? '').replace(/\u0000/g, ''));

  // code spans
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${code.replace(/^ ([\s\S]*) $/, '$1')}</code>`));
  // [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, (all, text, url) =>
    safeUrl(url) ? keep(linkTag(url, emphasis(text))) : `${text} (${url})`);
  // bare urls
  s = s.replace(/(^|[\s(>])(https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s\u0000])+)/g, (all, pre, url) => {
    let tail = '';
    const t = url.match(/(?:[.,;:!?]|\)(?![^(]*\())+$/);
    if (t && !(t[0] === ')' && url.includes('('))) { tail = t[0]; url = url.slice(0, -tail.length); }
    return pre + keep(linkTag(url, url)) + tail;
  });
  s = emphasis(s);
  for (let pass = 0; pass < 4 && s.includes('\u0000'); pass++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? '');
  }
  return s;
}

/** Render a full markdown document to a safe HTML string. */
export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (!text.trim()) return '';
  return blocks(text.split('\n').map(expandTabs), 0);
}

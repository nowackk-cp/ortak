// Where things are defined, without reading whole files: `outline` lists a file's functions,
// classes, methods and types with line numbers; `findSymbol` finds the definition of a name in the
// project. Regex-based (no parser), for the common languages — good enough to point a model at the
// right lines, which it then reads with a line range.
import fs from 'node:fs/promises';
import path from 'node:path';
import { allFiles, dirPrefix, safePath } from './paths.js';

const FILE_MAX = 2 * 1024 * 1024;
const SCAN_FILES_MAX = 6000;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'super', 'constructor']);

const ID = '[A-Za-z_$][\\w$]*';
const JS = [
  new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*[(<]`),
  new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${ID})`),
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`),
  new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+(${ID})`),
  new RegExp(`^\\s+(?:(?:static|async|get|set|public|private|protected|readonly|override)\\s+)*\\*?(#?${ID})\\s*\\([^)]*\\)\\s*(?::\\s*[^{=]+)?\\{\\s*$`),
];
const PY = [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/, /^\s*class\s+(\w+)/];
const GO = [/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*[([]/, /^type\s+(\w+)\s+(?:struct|interface)/];
const RUST = [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+(\w+)/, /^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/];
const MODS = '(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|sealed|partial|open|suspend|inline|extern)';
const JVM = [
  new RegExp(`^\\s*(?:${MODS}\\s+)*(?:class|interface|enum|record|struct|object)\\s+(\\w+)`),
  new RegExp(`^\\s+(?:${MODS}\\s+)+[\\w<>\\[\\],.?]+\\s+(\\w+)\\s*\\(`),
  /^\s*(?:(?:private|public|internal|override|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)\s*\(/,
];
const PHP = [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(/, /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/];
const RUBY = [/^\s*def\s+(?:self\.)?(\w+[?!=]?)/, /^\s*(?:class|module)\s+([\w:]+)/];

const BY_EXT = {
  js: JS, mjs: JS, cjs: JS, jsx: JS, ts: JS, tsx: JS, vue: JS, svelte: JS,
  py: PY, go: GO, rs: RUST, java: JVM, cs: JVM, kt: JVM, scala: JVM, swift: JVM, php: PHP, rb: RUBY,
};

const rulesFor = (file) => BY_EXT[path.extname(file).slice(1).toLowerCase()] || null;

/** [{ line, name, text }] definitions in `text` (by the rules of `file`'s language). */
export function definitions(file, text) {
  const rules = rulesFor(file);
  if (!rules) return [];
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 400) continue;
    for (const re of rules) {
      const m = re.exec(l);
      if (m && !KEYWORDS.has(m[1])) { out.push({ line: i + 1, name: m[1], text: l.replace(/\s+$/, '') }); break; }
    }
  }
  return out;
}

const supported = () => Object.keys(BY_EXT).map((e) => `.${e}`).join(' ');

/** A file's outline: "12: export function foo(a, b) {" lines (indentation kept). */
export async function outline(cwd, rel, max = 400) {
  const { abs, rel: r } = safePath(cwd, rel);
  if (!rulesFor(r)) throw new Error(`bu dosya türü için anahat çıkarılamıyor (desteklenenler: ${supported()}); read_file ile oku`);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isFile()) throw new Error(`dosya yok: ${r}`);
  if (st.size > FILE_MAX) throw new Error(`${r} çok büyük`);
  const text = await fs.readFile(abs, 'utf8');
  const defs = definitions(r, text);
  const total = text.split('\n').length;
  const shown = defs.slice(0, max).map((d) => `${d.line}: ${d.text.length > 160 ? `${d.text.slice(0, 160)}…` : d.text}`);
  return { path: r, lines: total, items: shown, more: Math.max(0, defs.length - max) };
}

/** Definitions of `name` across the project (exact, else case-insensitive). [{ path, line, text }] */
export async function findSymbol(cwd, name, { dir = '', max = 40 } = {}) {
  const n = String(name || '').trim().replace(/^[#.]/, '');
  if (!n) throw new Error('boş ad');
  const prefix = dirPrefix(cwd, dir);
  const files = (await allFiles(cwd, 20_000)).filter((f) => (!prefix || f.startsWith(prefix)) && rulesFor(f)).slice(0, SCAN_FILES_MAX);
  const exact = [];
  const loose = [];
  const low = n.toLowerCase();
  for (const f of files) {
    let text;
    try {
      const abs = path.join(cwd, f);
      if ((await fs.stat(abs)).size > FILE_MAX) continue;
      text = await fs.readFile(abs, 'utf8');
    } catch { continue; }
    if (!text.toLowerCase().includes(low)) continue;
    for (const d of definitions(f, text)) {
      const hit = { path: f, line: d.line, text: d.text.trim().slice(0, 200) };
      if (d.name === n || d.name === `#${n}`) exact.push(hit);
      else if (d.name.toLowerCase() === low) loose.push(hit);
    }
    if (exact.length >= max) break;
  }
  const hits = exact.length ? exact : loose;
  return { hits: hits.slice(0, max), more: Math.max(0, hits.length - max), scanned: files.length };
}

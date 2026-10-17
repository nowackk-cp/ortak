// Outline of a source file: its top-level definitions with line numbers, so agents without their
// own file tools (API models, Gemini web) can find what they need and read only those lines
// instead of whole files. Regex based (no parsers): good enough to point at the right range.

const MAX_LINES = 150;

const JS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([\w$]+)/,
  /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  /^export\s+(?:const|let|var)\s+([\w$]+)\s*=/,
  /^(export\s+default)\s*\{/,
  // class members / object methods (indented): `async run({ … }) {`, `get x() {`, `static y() {`
  /^\s{2,4}(?:static\s+|async\s+|get\s+|set\s+|#)*([\w$]+)\s*\(.*\)\s*\{\s*$/,
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with']);

const LANGS = {
  js: JS,
  py: [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, /^\s*(?:pub\s+)?(?:struct|enum|trait|impl(?:<[^>]*>)?)\s+([\w:<>]+)/],
  java: [
    /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+|final\s+)*(?:class|interface|enum|record|struct)\s+(\w+)/,
    /^\s+(?:public|private|protected|internal)\s+(?:static\s+|async\s+|override\s+|virtual\s+|final\s+)*[\w<>[\],.?\s]+\s+(\w+)\s*\(/,
  ],
  php: [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, /^\s*(?:public|private|protected|static|\s)*function\s+(\w+)/],
  rb: [/^\s*(?:def|class|module)\s+([\w.:?!]+)/],
  css: [/^([^\s@{}][^{]*?)\s*\{/, /^(@media[^{]*)\{/],
  md: [/^(#{1,4}\s+.+)$/],
};
const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', vue: 'js', svelte: 'js',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java', cs: 'java', swift: 'java', dart: 'java', cpp: 'java', hpp: 'java', c: 'java', h: 'java',
  php: 'php', rb: 'rb', css: 'css', scss: 'css', less: 'css', md: 'md', markdown: 'md',
};

/** Language key for a file name, or null when there is no outline for it. */
export const outlineLang = (name) => EXT[String(name).split('.').pop().toLowerCase()] || null;

/**
 * `[{ line, text }]` — the definitions in `text` (a file named `name`), at most `max`. For CSS and
 * Markdown the selector / heading itself, for code the trimmed declaration line.
 */
export function outlineFile(text, name, max = MAX_LINES) {
  const lang = outlineLang(name);
  if (!lang) return [];
  const pats = LANGS[lang];
  const out = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let inComment = false;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const l = lines[i];
    if (lang !== 'md' && lang !== 'py' && lang !== 'rb') {
      if (inComment) { if (l.includes('*/')) inComment = false; continue; }
      if (/^\s*\/\*/.test(l) && !l.includes('*/')) { inComment = true; continue; }
      if (/^\s*(\/\/|\*)/.test(l)) continue;
    }
    for (const re of pats) {
      const m = re.exec(l);
      if (!m) continue;
      if (lang === 'js' && KEYWORDS.has(m[1])) break;
      const shown = lang === 'css' || lang === 'md' ? m[1].trim() : l.trim().replace(/\s*=>.*$/, ' =>').replace(/\s*\{\s*$/, '');
      out.push({ line: i + 1, text: shown.length > 140 ? `${shown.slice(0, 139)}…` : shown });
      break;
    }
  }
  return out;
}

/** The outline as text for an agent ("12: export function a()"), or a note when there is none. */
export function outlineText(text, name, max) {
  const items = outlineFile(text, name, max);
  if (!items.length) return outlineLang(name) ? '(tanım bulunamadı)' : '(bu dosya türü için ana hat çıkarılamıyor)';
  const w = String(items.at(-1).line).length;
  return items.map((x) => `${String(x.line).padStart(w)}: ${x.text}`).join('\n') + (items.length >= (max ?? MAX_LINES) ? '\n… (ana hat kısaltıldı)' : '');
}

// What an agent without its own tools learns about the project in its first message:
// - the project's instruction files (AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules…), which
//   Claude Code and Codex read by themselves but a Groq / Gemini web model never sees;
// - the file list when it is short, else a map of folders with file counts plus a few facts
//   (languages, package.json scripts) — far cheaper than 400 paths for a small-context model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { allFiles } from './paths.js';

const LIST_ALL = 150;          // up to this many files the plain list is shown
const SCAN_MAX = 20_000;
const MAP_LINES = 70;

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules',
  '.github/copilot-instructions.md', 'CONVENTIONS.md'];

/** [{ name, text }] of the project's instruction files (at most 3, `max` chars in all). */
export async function projectInstructions(cwd, max = 8000) {
  const out = [];
  let room = max;
  for (const name of INSTRUCTION_FILES) {
    if (out.length >= 3 || room < 400) break;
    let text;
    try { text = (await fs.readFile(path.join(cwd, name), 'utf8')).trim(); } catch { continue; }
    if (!text || out.some((o) => o.text === text)) continue; // CLAUDE.md is often a copy of AGENTS.md
    const clipped = text.length > room ? `${text.slice(0, room)}\n…(kısaltıldı; tamamı için dosyayı oku)` : text;
    out.push({ name, text: clipped });
    room -= clipped.length;
  }
  return out;
}

const LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript (JSX)', ts: 'TypeScript', tsx: 'TypeScript (TSX)',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', php: 'PHP', rb: 'Ruby', swift: 'Swift',
  c: 'C', h: 'C/C++', cpp: 'C++', hpp: 'C++', dart: 'Dart', vue: 'Vue', svelte: 'Svelte', html: 'HTML', css: 'CSS', scss: 'SCSS',
  sql: 'SQL', sh: 'Shell', ps1: 'PowerShell', lua: 'Lua',
};

/** "TypeScript (120), CSS (14)…" from file extensions. */
function languages(files) {
  const n = new Map();
  for (const f of files) {
    const l = LANG[f.slice(f.lastIndexOf('.') + 1).toLowerCase()];
    if (l) n.set(l, (n.get(l) || 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, c]) => `${l} (${c})`).join(', ');
}

/** package.json name + scripts, other manifests by name. */
async function manifests(cwd, files) {
  const facts = [];
  if (files.includes('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
      if (pkg.name) facts.push(`package.json: ${pkg.name}${pkg.description ? ` — ${String(pkg.description).slice(0, 120)}` : ''}`);
      const scripts = Object.entries(pkg.scripts || {}).slice(0, 12).map(([k, v]) => `  npm run ${k}  →  ${String(v).slice(0, 80)}`);
      if (scripts.length) facts.push(`script'ler:\n${scripts.join('\n')}`);
    } catch { /* not JSON */ }
  }
  const other = ['pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'Makefile', 'Dockerfile']
    .filter((f) => files.includes(f));
  if (other.length) facts.push(`diğer proje dosyaları: ${other.join(', ')}`);
  return facts;
}

/** Folder tree with file counts (2 levels, the biggest folders first), root files listed. */
export function folderMap(files, maxLines = MAP_LINES) {
  const top = new Map();   // dir -> { count, subs: Map }
  const rootFiles = [];
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) { rootFiles.push(f); continue; }
    const d = top.get(parts[0]) || { count: 0, subs: new Map() };
    d.count++;
    if (parts.length > 2) d.subs.set(parts[1], (d.subs.get(parts[1]) || 0) + 1);
    else d.subs.set('', (d.subs.get('') || 0) + 1);
    top.set(parts[0], d);
  }
  const lines = [];
  for (const [dir, d] of [...top].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`${dir}/  (${d.count} dosya)`);
    const subs = [...d.subs].filter(([s]) => s).sort((a, b) => b[1] - a[1]);
    for (const [s, c] of subs.slice(0, 8)) lines.push(`  ${s}/  (${c})`);
    if (subs.length > 8) lines.push(`  … ve ${subs.length - 8} klasör daha`);
    if (lines.length >= maxLines) { lines.push('…'); break; }
  }
  const roots = rootFiles.slice(0, 25);
  return [...lines, ...roots, ...(rootFiles.length > roots.length ? [`… ve kökte ${rootFiles.length - roots.length} dosya daha`] : [])].join('\n');
}

/**
 * The first-message view of the project. Resolves
 * { files, more, total, map, facts, instructions } — `files` (≤ max) when the project is small,
 * else `map` (folders with counts) and `files` = [].
 */
export async function projectContext(cwd, { max = 400, instructionsMax = 8000 } = {}) {
  const all = await allFiles(cwd, SCAN_MAX);
  const total = all.length;
  const instructions = await projectInstructions(cwd, instructionsMax);
  if (total <= Math.min(max, LIST_ALL)) return { files: all, more: 0, total, map: null, facts: [], instructions };
  const facts = [];
  const lang = languages(all);
  if (lang) facts.push(`diller: ${lang}`);
  facts.push(...await manifests(cwd, all));
  return { files: [], more: 0, total, map: folderMap(all), facts, instructions };
}

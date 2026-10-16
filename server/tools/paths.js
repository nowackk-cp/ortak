// Project paths for Ortak's hands: every tool resolves agent-given paths through safePath (inside
// the project folder, never inside .git) and lists files through allFiles (.gitignore honoured).
import fs from 'node:fs/promises';
import path from 'node:path';
import * as git from '../git.js';

export const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'tools', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv']);

/** Project files relative to cwd (git ls-files when possible: honours .gitignore), at most `max`+1. */
export async function allFiles(cwd, max) {
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

/** "src/" / "./src" / "." → a relative folder prefix ("" for the root), or throws. */
export function dirPrefix(cwd, dir) {
  const d = String(dir || '').trim().replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '');
  if (!d || d === '.') return '';
  return `${safePath(cwd, d).rel}/`;
}

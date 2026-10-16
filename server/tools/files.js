// File operations beyond reading and editing: find files by pattern, delete and move them.
// Deletes and moves go through the turn's checkpoint, so the run's "Geri al" restores them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { allFiles, dirPrefix, safePath } from './paths.js';

const FIND_FILES_MAX = 20_000;
const DELETE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Glob → RegExp: `**` any folders, `*` / `?` within one name, `{a,b}` alternatives, `[…]` classes.
 * A pattern without "/" matches the file name at any depth ("*.test.js").
 */
export function globToRegExp(glob) {
  const g = String(glob || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; depth++; } else if (c === '}' && depth) { re += ')'; depth--; } else if (c === ',' && depth) re += '|';
    else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else { re += `[${g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Files matching `pattern` (in `dir`). Resolves { files, more, total }. */
export async function findFiles(cwd, pattern, { dir = '', max = 200 } = {}) {
  const p = String(pattern || '').trim();
  if (!p) throw new Error('boş desen');
  const prefix = dirPrefix(cwd, dir);
  const re = globToRegExp(p);
  const byName = !p.includes('/');
  const out = [];
  for (const rel of await allFiles(cwd, FIND_FILES_MAX)) {
    if (prefix && !rel.startsWith(prefix)) continue;
    const subject = byName ? rel.slice(rel.lastIndexOf('/') + 1) : rel.slice(prefix.length);
    if (re.test(subject)) out.push(rel);
  }
  return { files: out.slice(0, max), more: Math.max(0, out.length - max), total: out.length };
}

/** Deletes one file (not a folder). `cp` = the turn's checkpoint. Resolves { path }. */
export async function deleteFile(cwd, rel, cp) {
  const { abs, rel: r } = safePath(cwd, rel);
  let st;
  try { st = await fs.stat(abs); } catch { throw new Error(`dosya yok: ${r}`); }
  if (st.isDirectory()) throw new Error(`${r} bir klasör; yalnızca dosya silinebilir (klasördeki dosyaları tek tek sil)`);
  if (st.size > DELETE_MAX_BYTES) throw new Error(`${r} çok büyük (${Math.round(st.size / 1048576)} MB); geri alınabilir şekilde silinemez`);
  await cp?.note(abs, r);
  await fs.rm(abs);
  return { path: r };
}

/** Moves / renames one file. Refuses to overwrite unless `overwrite`. Resolves { from, to }. */
export async function moveFile(cwd, from, to, cp, { overwrite = false } = {}) {
  const src = safePath(cwd, from);
  const dst = safePath(cwd, to);
  if (src.rel === dst.rel) throw new Error('kaynak ve hedef aynı');
  let st;
  try { st = await fs.stat(src.abs); } catch { throw new Error(`dosya yok: ${src.rel}`); }
  if (st.isDirectory()) throw new Error(`${src.rel} bir klasör; yalnızca dosya taşınabilir`);
  if (st.size > DELETE_MAX_BYTES) throw new Error(`${src.rel} çok büyük; geri alınabilir şekilde taşınamaz`);
  const exists = await fs.stat(dst.abs).then(() => true, () => false);
  if (exists && !overwrite) throw new Error(`hedef zaten var: ${dst.rel} (üzerine yazmak için overwrite: true)`);
  await cp?.note(src.abs, src.rel);
  await cp?.note(dst.abs, dst.rel);
  await fs.mkdir(path.dirname(dst.abs), { recursive: true });
  try {
    await fs.rename(src.abs, dst.abs);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(src.abs, dst.abs);
    await fs.rm(src.abs);
  }
  return { from: src.rel, to: dst.rel };
}

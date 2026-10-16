// Undo for the file changes Ortak makes on behalf of text-only agents (SEARCH/REPLACE blocks of
// Gemini web / 4 Argon, EVREN and other API agents). One checkpoint per agent turn/task: the
// original content of every file touched (null = the file didn't exist), saved with the content it
// had afterwards. Undo restores the originals — but only for files nobody changed since, so a later
// edit is never silently thrown away. Stored in data/runs/<runId>.cp/<id>.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { dataDir } from './settings.js';

const dirOf = (runId) => path.join(dataDir, 'runs', `${runId}.cp`);

// A file's content in a checkpoint: null (no file), a string (text) or { b64 } (binary: images,
// archives… moved or deleted by an agent's tools).
async function readOrNull(abs) {
  let buf;
  try { buf = await fs.readFile(abs); } catch { return null; }
  return buf.includes(0) || !isUtf8(buf) ? { b64: buf.toString('base64') } : buf.toString('utf8');
}
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.b64 === b.b64;
}

const write = (abs, v) => (typeof v === 'string' ? fs.writeFile(abs, v, 'utf8') : fs.writeFile(abs, Buffer.from(v.b64, 'base64')));

let seq = 0;

/** A checkpoint in progress: call note(abs, rel) before changing a file, then finish(). */
export function begin(runId) {
  const files = new Map(); // rel -> { abs, before }
  return {
    async note(abs, rel) {
      if (!files.has(rel)) files.set(rel, { abs, before: await readOrNull(abs) });
    },
    get size() { return files.size; },
    /** Saves it (when something changed) and resolves { id, files: [rel] } or null. */
    async finish() {
      if (!files.size) return null;
      const id = `${Date.now().toString(36)}-${(++seq).toString(36)}`;
      const list = [];
      for (const [rel, f] of files) list.push({ rel, abs: f.abs, before: f.before, after: await readOrNull(f.abs) });
      const changed = list.filter((f) => !same(f.before, f.after));
      if (!changed.length) return null;
      await fs.mkdir(dirOf(runId), { recursive: true });
      await fs.writeFile(path.join(dirOf(runId), `${id}.json`), JSON.stringify({ id, createdAt: Date.now(), files: changed }), 'utf8');
      return { id, files: changed.map((f) => ({ path: f.rel, created: f.before == null })) };
    },
  };
}

/**
 * Restores a checkpoint. Resolves { restored: [rel], conflicts: [{ path, reason }] }.
 * Throws a Turkish Error when it doesn't exist or was already undone.
 */
export async function undo(runId, id) {
  if (!/^[a-z0-9-]+$/i.test(String(id || ''))) throw new Error('Geçersiz geri alma noktası.');
  const file = path.join(dirOf(runId), `${id}.json`);
  let cp;
  try { cp = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('Geri alma noktası bulunamadı.'); }
  if (cp.undoneAt) throw new Error('Bu değişiklikler zaten geri alındı.');
  const restored = [];
  const conflicts = [];
  for (const f of cp.files) {
    const now = await readOrNull(f.abs);
    if (!same(now, f.after)) { conflicts.push({ path: f.rel, reason: 'sonradan yeniden değişti; üzerine yazılmadı' }); continue; }
    try {
      if (f.before == null) await fs.rm(f.abs, { force: true });
      else { await fs.mkdir(path.dirname(f.abs), { recursive: true }); await write(f.abs, f.before); }
      restored.push(f.rel);
    } catch (err) {
      conflicts.push({ path: f.rel, reason: err.message });
    }
  }
  cp.undoneAt = Date.now();
  await fs.writeFile(file, JSON.stringify(cp), 'utf8');
  return { restored, conflicts };
}

export const removeAll = (runId) => fs.rm(dirOf(runId), { recursive: true, force: true }).catch(() => {});

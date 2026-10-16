// How the models did on the lead's tasks, kept across runs (data/model-stats.json): finished or
// not, and how long it took. The lead sees it next to every model of its catalog and team, so it
// stops giving small jobs to a model that needs ten minutes for one, or keeps failing.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './settings.js';

const FILE = path.join(dataDir, 'model-stats.json');
const KEEP = 20; // latest tasks per model

let cache = null;
let timer = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(cache));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch { /* a hint only */ }
  }, 500);
  timer.unref?.();
}

/** One task of model `ref` ("agent:model"): ok, seconds, failure kind (timeout, limit…). */
export function recordTask(ref, { ok, secs, kind } = {}) {
  if (!ref) return;
  const list = (load()[ref] ||= []);
  list.push({ ok: !!ok, secs: Number.isFinite(secs) ? secs : null, ...(kind ? { kind } : {}), at: Date.now() });
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  save();
}

/** { tasks, ok, timeouts, avgSecs } of `ref`'s latest tasks; null when it has none. */
export function statsOf(ref) {
  const list = load()[ref];
  if (!Array.isArray(list) || !list.length) return null;
  const timed = list.filter((x) => x.ok && Number.isFinite(x.secs));
  return {
    tasks: list.length,
    ok: list.filter((x) => x.ok).length,
    timeouts: list.filter((x) => x.kind === 'timeout').length,
    avgSecs: timed.length ? Math.round(timed.reduce((a, x) => a + x.secs, 0) / timed.length) : null,
  };
}

const dur = (secs) => (secs < 60 ? `${secs} sn` : `${Math.round(secs / 60)} dk`);

/** "geçmiş: 5 görev, 4 bitti, ort. 3 dk, 1 kez süre sınırı" — '' when there is no history. */
export function statsText(s) {
  if (!s) return '';
  const parts = [`${s.tasks} görev`, `${s.ok} bitti`];
  if (s.avgSecs != null) parts.push(`ort. ${dur(s.avgSecs)}`);
  if (s.timeouts) parts.push(`${s.timeouts} kez süre sınırı`);
  return `geçmiş: ${parts.join(', ')}`;
}

export const _test = { reset: () => { cache = {}; } };

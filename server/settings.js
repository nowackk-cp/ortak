// Settings, persisted in data/settings.json and edited from the UI (GET/PUT /api/settings): mostly
// about keeping the machine responsive while several agents (and their desktop apps) run in the
// background, plus whether agents may use the internet tools.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.resolve(process.env.ORTAK_DATA || path.join(ROOT, 'data'));
const FILE = path.join(DATA, 'settings.json');

export const DEFAULTS = Object.freeze({
  maxConcurrent: 5,           // agent turns that start a local CLI process (Claude, Codex, Copilot…) at once; 0 = no limit
  lowPriority: true,          // run agent processes / bridge windows at below-normal CPU priority
  geminiIdleMinutes: 10,      // close Ortak's Gemini window after this long without a turn; 0 = keep open
  antigravityAutoStart: true, // open Antigravity on demand when a turn needs it
  antigravityIdleMinutes: 0,  // close Antigravity *if Ortak opened it* after this long idle; 0 = never
  limitsRefreshMinutes: 5,    // UI refreshes quotas this often while visible; 0 = only by hand
  webTools: true,             // agents without their own tools may search the web / fetch pages (tools/web.js)
});

const int = (min, max) => (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

const RULES = {
  maxConcurrent: int(0, 8),
  lowPriority: bool,
  geminiIdleMinutes: int(0, 240),
  antigravityAutoStart: bool,
  antigravityIdleMinutes: int(0, 240),
  limitsRefreshMinutes: int(0, 120),
  webTools: bool,
};

function clean(obj) {
  const out = {};
  for (const [k, rule] of Object.entries(RULES)) {
    if (obj && k in obj) {
      const v = rule(obj[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

function load() {
  try {
    return { ...DEFAULTS, ...clean(JSON.parse(fs.readFileSync(FILE, 'utf8'))) };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();
const listeners = new Set();

export const getSettings = () => current;

/** Applies the valid keys of `patch`; throws a Turkish error listing invalid ones. */
export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Geçersiz ayarlar.');
  const good = clean(patch);
  const bad = Object.keys(patch).filter((k) => !(k in good));
  if (bad.length) throw new Error(`Geçersiz ayar: ${bad.join(', ')}`);
  current = { ...current, ...good };
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, FILE);
  for (const fn of listeners) { try { fn(current); } catch (err) { console.error('[settings]', err); } }
  return current;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { DATA as dataDir };

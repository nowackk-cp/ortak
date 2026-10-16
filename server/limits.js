// Agent discovery (detect + listModels) and quota (getLimits) aggregation with caching.
// Every adapter call runs in parallel with an 8 s timeout; results are cached for 60 s.
import { loadAdapters } from './adapters/index.js';
import { modelTier } from './tiers.js';

const TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;

const DEFAULT_CAPS = { edit: false, resume: false, streaming: false, cwd: false, sandbox: false };

function withTimeout(fn, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} zaman aşımına uğradı (${ms / 1000} sn)`)), ms);
    Promise.resolve()
      .then(fn)
      .then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * All adapters known to the registry. `ORTAK_AGENTS=mock,claude` restricts the set
 * (handy for tests: guarantees real CLIs are never touched).
 */
export async function listAdapters() {
  const map = await loadAdapters();
  const only = String(process.env.ORTAK_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...map.values()].filter((a) => a && (!only.length || only.includes(a.id)));
}

export async function findAdapter(id) {
  return (await listAdapters()).find((a) => a.id === id) || null;
}

function normModels(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      label: typeof m.label === 'string' && m.label ? m.label : m.id,
      ...(m.default ? { default: true } : {}),
      ...(typeof m.group === 'string' && m.group ? { group: m.group } : {}),
      ...(m.free ? { free: true } : {}),
      ...(m.disabled ? { disabled: true } : {}),
      ...(typeof m.note === 'string' && m.note ? { note: m.note } : m.disabled ? { note: '' } : {}),
    }));
}

async function probe(a) {
  const [det, mods] = await Promise.allSettled([
    withTimeout(() => a.detect(), CALL_TIMEOUT_MS, `${a.name || a.id} algılama`),
    withTimeout(() => a.listModels(), CALL_TIMEOUT_MS, `${a.name || a.id} model listesi`),
  ]);
  const d = det.status === 'fulfilled' ? det.value || {} : null;
  return {
    id: a.id,
    name: a.name || a.id,
    available: d ? d.available === true : false,
    version: d?.version ?? null,
    reason: d ? (d.available ? null : d.reason || 'Bulunamadı') : (det.reason?.message || String(det.reason)),
    capabilities: { ...DEFAULT_CAPS, ...(a.capabilities || {}) },
    // tier: what the model costs the user (tiers.js) — free / subscription / paid
    models: mods.status === 'fulfilled' ? normModels(mods.value).map((m) => ({ ...m, tier: modelTier(a.id, m) })) : [],
    startable: typeof a.start === 'function',
    // Sign-in from the UI (POST /api/agents/:id/login): required when unavailable for lack of an
    // account, optional when it only unlocks more models.
    loginable: typeof a.login === 'function',
    login: d?.login && typeof d.login === 'object'
      ? { required: !!d.login.required, label: String(d.login.label || 'Giriş yap'), hint: d.login.hint ? String(d.login.hint) : null }
      : null,
    // Available but its app/window is closed to save resources; the first turn opens it.
    sleeping: !!(d?.available && d.sleeping),
    // Available but not healthy (e.g. the Gemini web page changed or keeps failing).
    warning: d?.available && d.warning ? String(d.warning) : null,
  };
}

function cached(fetcher) {
  let entry = null; // { at, data }
  let inflight = null;
  return async ({ refresh = false } = {}) => {
    if (!refresh && entry && Date.now() - entry.at < TTL_MS) return entry.data;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = await fetcher();
        entry = { at: Date.now(), data };
        return data;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** `[{ id, name, available, version, reason, capabilities, models }]` */
export const getAgents = cached(async () => Promise.all((await listAdapters()).map(probe)));

export async function getAgentInfo(id) {
  return (await getAgents()).find((a) => a.id === id) || null;
}

/** `{ [agentId]: { ok, items, note, updatedAt, error? } }` */
export const getLimits = cached(async () => {
  const [adapters, agents] = await Promise.all([listAdapters(), getAgents()]);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = {};
  await Promise.all(adapters.map(async (a) => {
    const info = byId.get(a.id);
    const updatedAt = Date.now();
    if (!info?.available) {
      out[a.id] = { ok: false, items: [], note: null, updatedAt, error: info?.reason || 'Ajan kullanılamıyor' };
      return;
    }
    try {
      const lim = await withTimeout(() => a.getLimits(), CALL_TIMEOUT_MS, `${a.name || a.id} kota sorgusu`);
      const items = Array.isArray(lim?.items) ? lim.items.filter((x) => x && typeof x === 'object') : [];
      out[a.id] = { ok: true, items, note: lim ? lim.note ?? null : 'Kota bilgisi yok', updatedAt: Date.now() };
    } catch (err) {
      out[a.id] = { ok: false, items: [], note: null, updatedAt: Date.now(), error: err?.message || String(err) };
    }
  }));
  return out;
});

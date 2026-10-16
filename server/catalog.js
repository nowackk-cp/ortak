// The lead's catalog: every model it may hand work to. Each usable agent (getAgents) with its
// models the budget allows, addressed as "provider:model" (openrouter:deepseek/…:free,
// evren:glm-5.3, copilot:auto…), plus how many copies of that agent may work at the same time —
// the lead picks the model per task and Ortak opens another lane when one copy is busy.
import { findAdapter } from './limits.js';
import { modelTier, tierAllowed } from './tiers.js';
import { statsOf } from './modelstats.js';

// Copies of one agent that may work at once (each its own lane and session). One browser window
// for Gemini web and one Antigravity app; local CLIs are also bound by the maxConcurrent setting.
const COPIES = { gemini: 1, antigravity: 1, groq: 3, openrouter: 4, evren: 4, claude: 3, codex: 3, copilot: 3, opencode: 3, kilo: 3, junie: 2, mock: 4 };
const DEFAULT_COPIES = 2;

export const copiesOf = (agentId) => COPIES[agentId] ?? DEFAULT_COPIES;

// Agents whose every task takes minutes whatever its size (Junie: a JVM per turn, then its own
// plan → edit → verify → report loop). The lead is told, so small jobs go elsewhere.
const SLOW = new Set(['junie']);
export const isSlow = (agentId) => SLOW.has(agentId);
export const modelRef = (agentId, modelId) => `${agentId}:${modelId}`;

/**
 * "openrouter:deepseek/x:free" → { agentId, model } — the agent part is the text before the first
 * ":" and must be one of `agentIds`; "openrouter" alone → { agentId, model: null }. Else null.
 */
export function parseRef(ref, agentIds) {
  const s = String(ref || '').trim().replace(/^@+/, '');
  const i = s.indexOf(':');
  const agentId = (i < 0 ? s : s.slice(0, i)).toLowerCase();
  if (!agentIds.includes(agentId)) return null;
  const model = i < 0 ? null : s.slice(i + 1).trim() || null;
  return { agentId, model };
}

/**
 * [{ agentId, name, own, copies, models: [{ id, ref, label, tier, tools, backup, isDefault }] }]
 * for `agents` (getAgents() output) under `budget`. `own` = the agent edits and runs commands with
 * its own tools (CLIs, Antigravity); else Ortak is its hands. `tools` = whether the model takes
 * real tool calls (API agents; undefined = unknown). Models the budget allows only as a backup
 * (subscription under free-first) are marked `backup`. CLI "default" entries are left out when the
 * agent lists real models (which model "default" is depends on the user's CLI settings).
 */
export async function buildCatalog(agents, { budget = 'free-first' } = {}) {
  const out = [];
  for (const a of agents || []) {
    if (!a?.available) continue;
    const listed = (a.models || []).filter((m) => !m.disabled);
    const real = listed.filter((m) => m.id !== 'default');
    const own = !!a.capabilities?.edit;
    const models = [];
    let adapter = null;
    for (const m of own && real.length ? real : listed) {
      const tier = m.tier || modelTier(a.id, m);
      if (!tierAllowed(tier, budget, { backup: true })) continue;
      let tools;
      if (a.capabilities?.tools) {
        adapter ||= await findAdapter(a.id);
        try { tools = await adapter?.supportsTools?.(m.id); } catch { tools = undefined; }
      }
      models.push({
        id: m.id, ref: modelRef(a.id, m.id), label: m.label || m.id, tier, isDefault: !!m.default,
        ...(statsOf(modelRef(a.id, m.id)) ? { stats: statsOf(modelRef(a.id, m.id)) } : {}),
        ...(typeof tools === 'boolean' ? { tools } : {}),
        ...(budget === 'free-first' && tier === 'subscription' ? { backup: true } : {}),
      });
    }
    if (!models.length) continue;
    // free first, then credit, then the rest; the agent's default first within a tier
    const rank = { free: 0, credit: 1, subscription: 2, paid: 3 };
    models.sort((x, y) => (rank[x.tier] ?? 4) - (rank[y.tier] ?? 4) || Number(y.isDefault) - Number(x.isDefault));
    out.push({ agentId: a.id, name: a.name || a.id, own, copies: copiesOf(a.id), ...(isSlow(a.id) ? { slow: true } : {}), models });
  }
  return out;
}

/** The catalog entry of `{ agentId, model }` (model null → the agent's first model). */
export function findModel(catalog, { agentId, model }) {
  const p = catalog.find((x) => x.agentId === agentId);
  if (!p) return null;
  if (!model) return { provider: p, model: p.models[0] };
  const exact = p.models.find((m) => m.id === model);
  if (exact) return { provider: p, model: exact };
  // tolerate a missing ":free" suffix or a different case
  const low = model.toLowerCase();
  const loose = p.models.find((m) => m.id.toLowerCase() === low || m.id.toLowerCase().replace(/:free$/, '') === low.replace(/:free$/, ''));
  return loose ? { provider: p, model: loose } : null;
}

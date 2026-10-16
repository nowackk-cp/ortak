// What using an agent/model costs the user, and the automatic lead-mode team built from it.
//
//   free          no money and no paid-plan quota: free API tiers (Groq, OpenRouter :free, OpenCode
//                 Zen / Kilo free models, EVREN free models, Junie Lite) and Google's own quotas
//                 (Gemini web, Antigravity)
//   subscription  the user's paid plan limits: Claude Code (Claude Pro/Max), Codex (ChatGPT
//                 Plus/Pro), Copilot, Junie (JetBrains AI) — what lead mode tries to spare
//   paid          pay per token (non-free OpenCode / Kilo / EVREN models)
//
// A model the adapter marks `free: true` is free whatever its agent.

export const TIERS = ['free', 'subscription', 'paid'];
export const TIER_TR = { free: 'ücretsiz', subscription: 'abonelik', paid: 'ücretli' };
export const BUDGETS = ['free-first', 'free-only', 'any'];
export const DEFAULT_BUDGET = 'free-first';

const AGENT_TIER = {
  claude: 'subscription',
  codex: 'subscription',
  copilot: 'subscription',
  junie: 'subscription',
  gemini: 'free',
  antigravity: 'free',
  groq: 'free',
  openrouter: 'free',
  opencode: 'paid',
  kilo: 'paid',
  evren: 'paid',
  mock: 'free',
};

/** Tier of `model` ({ id, free? } or an id) on agent `agentId`. */
export function modelTier(agentId, model) {
  if (model && typeof model === 'object' && model.free) return 'free';
  return AGENT_TIER[agentId] || 'paid';
}

// Automatic team: which model of each agent, in the order free workers are preferred. Free API
// agents first (fast, quota of their own), then Google's, then the subscription backups.
const AUTO = [
  { agentId: 'gemini', models: ['argon-high', 'pro', 'default'] },
  { agentId: 'antigravity', models: ['flash', 'pro'] },
  { agentId: 'groq', models: [] },
  { agentId: 'openrouter', models: [] },
  { agentId: 'opencode', models: [] },
  { agentId: 'kilo', models: [] },
  { agentId: 'evren', models: [] },
  { agentId: 'junie', models: ['junie-lite'] },
  { agentId: 'mock', models: [] },
  // subscription backups (free-first: only these two; any: all of them)
  { agentId: 'claude', models: ['sonnet'], backup: true },
  { agentId: 'codex', models: ['default'], backup: true },
  { agentId: 'claude', models: ['haiku'], backup: true, extra: true },
  { agentId: 'copilot', models: ['auto', 'default'], backup: true, extra: true },
];
export const AUTO_MAX = 8;

/** The model of `agent` the auto team uses (a preferred one, else the default, else any free one). */
function pickModel(agent, prefs, wantFree) {
  const usable = (agent.models || []).filter((m) => !m.disabled);
  if (!usable.length) return null;
  const ok = (m) => !wantFree || modelTier(agent.id, m) === 'free';
  for (const id of prefs) {
    const m = usable.find((x) => x.id === id);
    if (m && ok(m)) return m;
  }
  const def = usable.find((m) => m.default);
  if (def && ok(def)) return def;
  return usable.find((m) => modelTier(agent.id, m) === 'free') || (wantFree ? null : usable[0]);
}

/**
 * Workers for a lead-mode run: `agents` = getAgents() output, `budget` = free-first | free-only |
 * any, `lead` = { agentId, model } (never also a worker). Resolves
 * [{ agentId, model, name, modelLabel, tier, backup }] (at most AUTO_MAX).
 */
export function autoTeam(agents, { budget = DEFAULT_BUDGET, lead } = {}) {
  const byId = new Map((agents || []).filter((a) => a.available).map((a) => [a.id, a]));
  const out = [];
  const seen = new Set();
  for (const spec of AUTO) {
    if (out.length >= AUTO_MAX) break;
    const a = byId.get(spec.agentId);
    if (!a) continue;
    if (spec.backup && budget === 'free-only') continue;
    if (spec.extra && budget !== 'any') continue;
    const m = pickModel(a, spec.models, !spec.backup);
    if (!m) continue;
    const tier = modelTier(a.id, m);
    if (tier === 'paid' && budget !== 'any') continue;
    if (budget === 'free-only' && tier !== 'free') continue;
    const key = `${a.id}:${m.id}`;
    if (seen.has(key) || (lead && lead.agentId === a.id && (lead.model || null) === m.id)) continue;
    seen.add(key);
    out.push({ agentId: a.id, model: m.id, name: a.name, modelLabel: m.label, tier, backup: budget === 'free-first' && tier !== 'free' });
  }
  return out;
}

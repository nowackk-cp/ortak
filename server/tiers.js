// What using an agent/model costs the user, and the automatic lead-mode team built from it.
//
//   free          no money and no paid-plan quota: free API tiers (Groq, OpenRouter :free, OpenCode
//                 Zen / Kilo free models, EVREN free models, Junie Lite) and Google's own quotas
//                 (Gemini web, Antigravity)
//   subscription  the user's paid plan limits: Claude Code (Claude Pro/Max), Codex (ChatGPT
//                 Plus/Pro), Copilot, Junie (JetBrains AI) — what lead mode tries to spare
//   credit        a gateway's credit balance (EVREN's non-free models): allowed in the free-first
//                 budget after the free models
//   paid          pay per token (non-free OpenCode / Kilo models: the user's own provider keys)
//
// A model the adapter marks `free: true` is free whatever its agent (Copilot's ×0 models too).

export const TIERS = ['free', 'credit', 'subscription', 'paid'];
export const TIER_TR = { free: 'ücretsiz', credit: 'kredi', subscription: 'abonelik', paid: 'ücretli' };
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
  evren: 'credit',
  mock: 'free',
};

/** Tier of `model` ({ id, free? } or an id) on agent `agentId`. */
export function modelTier(agentId, model) {
  if (model && typeof model === 'object' && model.free) return 'free';
  return AGENT_TIER[agentId] || 'paid';
}

// Automatic team: which model of each agent, in the order free workers are preferred. Free API
// agents first (fast, quota of their own), then Google's and Copilot's included models, then EVREN's
// credit models, then the subscription backups. The lead can still use any model of the catalog.
const AUTO = [
  { agentId: 'gemini', models: ['argon-high', 'pro', 'default'] },
  { agentId: 'antigravity', models: ['flash', 'pro'] },
  // Groq: the 120B open model handles tools and code far better than the small default
  { agentId: 'groq', models: ['openai/gpt-oss-120b'] },
  { agentId: 'copilot', models: ['auto'] },
  { agentId: 'openrouter', models: [] },
  { agentId: 'evren', models: ['glm-5.3', 'deepseek-v4.1-flash'] },
  { agentId: 'opencode', models: [] },
  { agentId: 'kilo', models: [] },
  { agentId: 'junie', models: ['junie-lite'] },
  { agentId: 'mock', models: [] },
  // subscription backups (free-first: only these two; any: all of them)
  { agentId: 'claude', models: ['sonnet'], backup: true },
  { agentId: 'codex', models: ['default'], backup: true },
  { agentId: 'claude', models: ['haiku'], backup: true, extra: true },
];
export const AUTO_MAX = 8;

/** Whether a model of `tier` may work under `budget` (free-first: free and credit, plus backups). */
export function tierAllowed(tier, budget, { backup = false } = {}) {
  if (budget === 'any') return true;
  if (budget === 'free-only') return tier === 'free';
  return tier === 'free' || tier === 'credit' || (backup && tier === 'subscription');
}

/** The model of `agent` the auto team uses: a free one if any, then a preferred / default allowed one. */
function pickModel(agent, prefs, ok) {
  const usable = (agent.models || []).filter((m) => !m.disabled && ok(modelTier(agent.id, m)));
  if (!usable.length) return null;
  const free = (m) => modelTier(agent.id, m) === 'free';
  const order = [
    ...prefs.map((id) => usable.find((m) => m.id === id && free(m))),
    usable.find((m) => m.default && free(m)),
    usable.find(free),
    ...prefs.map((id) => usable.find((m) => m.id === id)),
    usable.find((m) => m.default),
    usable[0],
  ];
  return order.find(Boolean) || null;
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
    const m = pickModel(a, spec.models, (tier) => tierAllowed(tier, budget, { backup: !!spec.backup }));
    if (!m) continue;
    const tier = modelTier(a.id, m);
    const key = `${a.id}:${m.id}`;
    if (seen.has(key) || (lead && lead.agentId === a.id && (lead.model || null) === m.id)) continue;
    seen.add(key);
    out.push({ agentId: a.id, model: m.id, name: a.name, modelLabel: m.label, tier, backup: budget === 'free-first' && tier === 'subscription' });
  }
  return out;
}

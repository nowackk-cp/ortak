// Agent catalog (from GET /api/agents) + agent/model picker widget.
import { h, icon } from './dom.js';

export const catalog = { agents: [], byId: new Map(), loaded: false };

export function setAgents(list) {
  catalog.agents = Array.isArray(list) ? list.filter((a) => a && a.id) : [];
  catalog.byId = new Map(catalog.agents.map((a) => [a.id, a]));
  catalog.loaded = true;
}

export const getAgent = (id) => catalog.byId.get(id);

// Cost tiers (server/tiers.js): free = no money and no paid-plan quota, subscription = the user's
// Claude / ChatGPT / Copilot plan limits, paid = pay per token.
export const TIER = {
  free: { label: 'Ücretsiz', title: 'Ücretsiz: para ya da abonelik limiti harcamaz' },
  subscription: { label: 'Abonelik', title: 'Aboneliğinizin (Claude, ChatGPT, Copilot…) limitinden harcar' },
  paid: { label: 'Ücretli', title: 'Token başına ücretlendirilir' },
};

/** Tiers of an agent's usable models (Set). */
export function agentTiers(agent) {
  const ms = (agent?.models || []).filter((m) => !m.disabled);
  return new Set(ms.map((m) => m.tier).filter(Boolean));
}

/** Tier of one model of an agent ('free' | 'subscription' | 'paid' | ''). */
export function modelTier(agentId, modelId) {
  const a = getAgent(agentId);
  const m = a?.models?.find((x) => x.id === modelId) || a?.models?.find((x) => x.default);
  return m?.tier || '';
}

/** Small badge: a tier id, or a Set of tiers (an agent: "Ücretsiz" / "Ücretsiz + Abonelik"…). */
export function tierBadge(t) {
  const set = t instanceof Set ? t : new Set(t ? [t] : []);
  if (!set.size) return null;
  const order = ['free', 'subscription', 'paid'].filter((x) => set.has(x));
  const main = order[0];
  const text = order.length > 1 && main === 'free' ? `${TIER.free.label} modeller` : TIER[main].label;
  return h('span', { class: `tier tier-${main}`, title: order.map((x) => TIER[x].title).join('\n'), text });
}
export const agentName = (id) => getAgent(id)?.name || id || '?';
export const canEdit = (a) => !!a?.capabilities?.edit;

// Model id 'default' (or none) = the CLI's own default model.
export function modelLabel(agentId, modelId) {
  const m = modelId ? getAgent(agentId)?.models?.find((x) => x.id === modelId) : null;
  if (m?.label) return m.label;
  if (!modelId || modelId === 'default') return 'Varsayılan';
  return modelId;
}

const optionLabel = (m) => m.label || (m.id === 'default' ? 'Varsayılan' : m.id);

export function defaultModel(agent) {
  const ms = Array.isArray(agent?.models) ? agent.models : [];
  return (ms.find((m) => m.default && !m.disabled) || ms.find((m) => !m.disabled) || ms[0])?.id || '';
}

/** Warning for agents whose permissions are only guarded, not enforced (capabilities.sandbox === false). */
export function sandboxWarning(agent) {
  if (!agent || agent.capabilities?.sandbox !== false) return '';
  if (agent.id === 'antigravity') {
    return "Antigravity'de izinler zorunlu değil: salt okunur/düzenleme modu sadece talimat + ihlalde durdurma ile korunur; komutlar sandbox'lı değil.";
  }
  return `${agent.name || agent.id} için izinler zorunlu değil: salt okunur/düzenleme modu sadece talimat + ihlalde durdurma ile korunur; komutlar sandbox'lı değil.`;
}

export const EDIT_REASON = 'Bu ajan dosya düzenleyemez; yalnızca okuma rollerinde (beyin fırtınası, planlayıcı, denetçi) kullanılabilir.';

/** null when usable, otherwise a Turkish reason. */
export function unusable(agent, requireEdit) {
  if (!agent) return 'Ajan bulunamadı';
  if (!agent.available) return agent.reason || 'Bu ajan şu anda kullanılamıyor.';
  if (requireEdit && !canEdit(agent)) return EDIT_REASON;
  return null;
}

export const usableAgents = (requireEdit) => catalog.agents.filter((a) => !unusable(a, requireEdit));

/** Normalize a { agentId, model } selection against the catalog. */
export function sanitizeSel(sel, requireEdit, preferId) {
  let a = sel && getAgent(sel.agentId);
  if (!a || unusable(a, requireEdit)) {
    const pref = preferId && getAgent(preferId);
    a = pref && !unusable(pref, requireEdit) ? pref : usableAgents(requireEdit)[0];
    if (!a) return { agentId: sel?.agentId || preferId || '', model: sel?.model || '' };
    return { agentId: a.id, model: defaultModel(a) };
  }
  const models = Array.isArray(a.models) ? a.models : [];
  const model = models.some((m) => m.id === sel.model) ? sel.model : defaultModel(a);
  return { agentId: a.id, model };
}

/**
 * Agent select + model select. `value` = { agentId, model }. Calls onChange(newValue).
 */
export function agentPicker({ value, requireEdit = false, onChange, onRemove, label }) {
  let cur = { agentId: value?.agentId || '', model: value?.model || '' };
  const agentSel = h('select', { class: 'sel sel-agent', 'aria-label': label ? `${label}: ajan` : 'Ajan' });
  const modelSel = h('select', { class: 'sel sel-model', 'aria-label': label ? `${label}: model` : 'Model' });

  function fillAgents() {
    agentSel.replaceChildren();
    let found = false;
    const tips = [];
    for (const a of catalog.agents) {
      const why = unusable(a, requireEdit);
      if (why) tips.push(`${a.name}: ${why}`);
      const tiers = agentTiers(a);
      const cost = tiers.size === 1 && tiers.has('free') ? ' · ücretsiz' : tiers.has('free') ? ' · ücretsiz modeller' : '';
      const suffix = why ? (a.available ? ' — yalnızca okuma' : ' — kullanılamıyor') : cost;
      const opt = h('option', { value: a.id, disabled: !!why, title: why || `${a.name}${a.version ? ' ' + a.version : ''}` }, a.name + suffix);
      if (a.id === cur.agentId) { opt.selected = true; found = true; }
      agentSel.append(opt);
    }
    if (!found) {
      agentSel.prepend(h('option', { value: cur.agentId, selected: true, disabled: true }, cur.agentId ? `${cur.agentId} (yok)` : 'Ajan yok'));
    }
    agentSel.title = tips.join('\n');
  }

  function fillModels() {
    const a = getAgent(cur.agentId);
    const models = Array.isArray(a?.models) ? a.models : [];
    modelSel.replaceChildren();
    if (!models.length) modelSel.append(h('option', { value: '' }, 'Varsayılan'));
    // Locked models (e.g. Ultra-only, paid without an account) are listed so the user knows they
    // exist, but can't be picked. Long catalogs (Kilo: 300+) come grouped: Ücretsiz, Anthropic, …
    // a free model on an agent that also has paid ones says so (unless its label already does)
    const mixed = new Set(models.map((m) => m.tier)).size > 1;
    const label = (m) => (mixed && m.tier === 'free' && !/ücretsiz/i.test(optionLabel(m)) ? `${optionLabel(m)} · ücretsiz` : optionLabel(m));
    const opt = (m) => h('option', { value: m.id, selected: m.id === cur.model, disabled: !!m.disabled, title: m.note || '' }, label(m));
    const grouped = models.some((m) => m.group) && new Set(models.map((m) => m.group || '')).size > 1;
    if (!grouped) {
      for (const m of models) modelSel.append(opt(m));
    } else {
      const groups = new Map();
      for (const m of models) {
        const g = m.group || 'Diğer';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(m);
      }
      for (const [g, list] of groups) {
        const locked = list.every((m) => m.disabled);
        modelSel.append(h('optgroup', { label: locked ? `${g} — kilitli` : g }, list.map(opt)));
      }
    }
    if (models.length && !models.some((m) => m.id === cur.model && !m.disabled)) {
      cur.model = defaultModel(a);
      modelSel.value = cur.model;
    }
    modelSel.disabled = models.length < 2;
    const sel = models.find((m) => m.id === cur.model);
    modelSel.title = sel?.note || (models.length > 20 ? `${models.filter((m) => !m.disabled).length} kullanılabilir model` : '');
    badge.replaceChildren(...[tierBadge(sel?.tier)].filter(Boolean));
  }
  const badge = h('span', { class: 'picker-tier' });

  agentSel.addEventListener('change', () => {
    cur = { agentId: agentSel.value, model: defaultModel(getAgent(agentSel.value)) };
    fillModels();
    updateWarn();
    onChange?.({ ...cur });
  });
  modelSel.addEventListener('change', () => {
    cur.model = modelSel.value;
    const m = getAgent(cur.agentId)?.models?.find((x) => x.id === cur.model);
    modelSel.title = m?.note || '';
    badge.replaceChildren(...[tierBadge(m?.tier)].filter(Boolean));
    onChange?.({ ...cur });
  });

  fillAgents();
  fillModels();
  const warn = h('div', { class: 'picker-warn', role: 'note' });
  function updateWarn() {
    const text = sandboxWarning(getAgent(cur.agentId));
    warn.hidden = !text;
    warn.replaceChildren(...(text ? [icon('warn'), h('span', { text })] : []));
  }
  updateWarn();
  return h('div', { class: 'picker-box' },
    h('div', { class: 'picker' },
      agentSel,
      modelSel,
      badge,
      onRemove && h('button', { type: 'button', class: 'icon-btn picker-remove', title: 'Kaldır', 'aria-label': 'Kaldır', onclick: onRemove }, icon('x'))),
    warn);
}

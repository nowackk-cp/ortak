// "Yeni çalışma" screen: mode tabs + per-mode setup. Remembers the last config per mode.
import { h, icon, fill, spinner } from './dom.js';
import { store, basename, enc } from './util.js';
import { PERMISSIONS, SURFACE_MODE_IDS, PRIMARY_MODES, BUDGETS, modeInfo } from './modes.js';
import { catalog, agentPicker, sanitizeSel, usableAgents, defaultModel, getAgent, unusable, tierBadge, modelLabel, agentName } from './agents.js';
import { api } from './api.js';

const MAX_PARTICIPANTS = 8;

// Each surface (Sohbet / Kod) remembers its own mode and per-mode configs.
let surface = 'code';
const modeStoreKey = (sf) => (sf === 'chat' ? 'sohbet.mode' : 'mode');
const cfgStoreKey = (sf, m) => (sf === 'chat' ? `cfg.sohbet.${m}` : `cfg.${m}`);
const storedMode = (sf) => {
  const m = store.get(modeStoreKey(sf));
  return SURFACE_MODE_IDS[sf].includes(m) ? m : 'chat';
};
const modes = { code: storedMode('code'), chat: storedMode('chat') };
let mode = modes[surface];
const configs = {}; // `${surface}:${mode}` → config
let root = null;
let heroEl = null;
let slotEl = null;
let restEl = null;
let ctx = { cwd: '', cwdInfo: null, onModeChange: null };

export const currentMode = () => mode;
export const currentSurface = () => surface;

/** Switch the surface (Sohbet / Kod); re-renders when mounted. */
export function setSurface(sf) {
  sf = sf === 'chat' ? 'chat' : 'code';
  if (sf === surface) return;
  surface = sf;
  mode = modes[sf];
  if (root?.isConnected) render();
}

const sel = (requireEdit, prefer) => sanitizeSel(null, requireEdit, prefer);
const all = (requireEdit) => usableAgents(requireEdit).map((a) => ({ agentId: a.id, model: defaultModel(a) }));

/** { agentId, model } when that agent is usable and has that (unlocked) model, else null. */
function pick(agentId, modelId) {
  const a = getAgent(agentId);
  if (!a || unusable(a, false)) return null;
  const m = modelId && a.models?.find((x) => x.id === modelId && !x.disabled);
  return { agentId, model: m ? m.id : defaultModel(a) };
}

// Suggested sub-agents: 4 Argon, Codex's default (GPT Sol), Antigravity's default (Gemini Flash),
// Sonnet, Haiku, then Copilot and the free OpenCode / Kilo models — whichever are available.
function leadWorkers() {
  const out = [pick('gemini', 'argon-high'), pick('codex'), pick('antigravity'), pick('claude', 'sonnet'), pick('claude', 'haiku'),
    pick('copilot'), pick('groq'), pick('evren'), pick('openrouter'), pick('opencode'), pick('kilo')].filter(Boolean).slice(0, MAX_PARTICIPANTS);
  return out.length ? out : [sel(false, 'claude')];
}

function defaults(m, sf = surface) {
  switch (m) {
    case 'chat':
      // Sohbet surface: any model (read-only); Kod surface: an agent that can edit.
      return sf === 'chat' ? { agent: sel(false, 'claude') } : { agent: sel(false, 'claude'), permission: 'edit' };
    case 'group': {
      const parts = all(false);
      // a conversation needs two voices: with one usable agent, add it twice (two sessions)
      while (parts.length && parts.length < 2) parts.push({ ...parts[0] });
      return { participants: parts.length ? parts : [sel(false, 'claude'), sel(false, 'claude')], rounds: 2 };
    }
    case 'brainstorm': {
      const parts = all(false);
      return { participants: parts.length ? parts : [sel(false, 'claude')], rounds: 2, moderator: sel(false, 'claude') };
    }
    case 'parallel': {
      const parts = all(true);
      return { participants: parts.length ? parts : [sel(true, 'claude')], permission: 'edit' };
    }
    case 'team':
      return { planner: sel(false, 'claude'), workers: [sel(true, 'claude')], reviewer: sel(false, 'codex'), fixRounds: 3, permission: 'edit' };
    case 'lead':
      // auto: the server picks the team from every usable agent the budget allows (tiers.js)
      return { lead: pick('claude', 'opus') || sel(false, 'claude'), teamMode: 'auto', budget: 'free-first', workers: leadWorkers(), steps: 8, parallel: 5, taskMinutes: 10, permission: 'edit' };
    default:
      return {};
  }
}

function sanitize(m, c, sf = surface) {
  const d = defaults(m, sf);
  if (!c || typeof c !== 'object') return d;
  const list = (arr, requireEdit, fallback) => {
    const out = (Array.isArray(arr) ? arr : [])
      .filter((s) => s && !unusable(getAgent(s.agentId), requireEdit))
      .map((s) => sanitizeSel(s, requireEdit))
      .slice(0, MAX_PARTICIPANTS);
    return out.length ? out : fallback;
  };
  const perm = (p, allowed, fb) => (allowed.includes(p) ? p : fb);
  switch (m) {
    case 'chat':
      if (sf === 'chat') return { agent: sanitizeSel(c.agent, false, 'claude') };
      return { agent: sanitizeSel(c.agent, false, 'claude'), permission: perm(c.permission, ['read-only', 'edit', 'full'], d.permission) };
    case 'group': {
      const r = Number(c.rounds);
      return { participants: list(c.participants, false, d.participants), rounds: r >= 1 && r <= 4 ? Math.round(r) : d.rounds };
    }
    case 'brainstorm': {
      const r = Number(c.rounds);
      return {
        participants: list(c.participants, false, d.participants),
        rounds: r >= 1 && r <= 4 ? Math.round(r) : d.rounds,
        moderator: sanitizeSel(c.moderator, false, 'claude'),
      };
    }
    case 'parallel':
      return { participants: list(c.participants, false, d.participants), permission: perm(c.permission, ['edit', 'full'], d.permission) };
    case 'team': {
      const f = Number(c.fixRounds);
      return {
        planner: sanitizeSel(c.planner, false, 'claude'),
        workers: list(c.workers, false, d.workers),
        reviewer: sanitizeSel(c.reviewer, false, 'codex'),
        fixRounds: f >= 1 && f <= 5 ? Math.round(f) : d.fixRounds,
        permission: perm(c.permission, ['edit', 'full'], d.permission),
      };
    }
    case 'lead': {
      const n = Number(c.steps);
      const par = Number(c.parallel);
      const mins = Number(c.taskMinutes);
      return {
        lead: sanitizeSel(c.lead, false, 'claude'),
        teamMode: c.teamMode === 'manual' ? 'manual' : 'auto',
        budget: BUDGETS.some((b) => b.id === c.budget) ? c.budget : d.budget,
        workers: list(c.workers, false, d.workers),
        steps: n >= 1 && n <= 12 ? Math.round(n) : d.steps,
        parallel: par >= 1 && par <= 10 ? Math.round(par) : d.parallel,
        taskMinutes: [0, 5, 10, 20, 30].includes(mins) ? mins : d.taskMinutes,
        permission: perm(c.permission, ['read-only', 'edit', 'full'], d.permission),
      };
    }
    default:
      return d;
  }
}

function cfg(m = mode, sf = surface) {
  const key = `${sf}:${m}`;
  if (!configs[key]) configs[key] = sanitize(m, store.get(cfgStoreKey(sf, m)), sf);
  return configs[key];
}

function save(m = mode, sf = surface) {
  store.set(cfgStoreKey(sf, m), configs[`${sf}:${m}`]);
}

// Agents added to Ortak later: once one becomes usable it joins the saved brainstorm participants
// and lead sub-agents (configs saved before it existed would never show it otherwise).
const LATE_AGENTS = ['opencode', 'kilo', 'copilot', 'junie', 'evren', 'openrouter', 'groq'];

function offerNewAgents() {
  const offered = new Set(store.get('offeredAgents', []));
  const fresh = LATE_AGENTS.filter((id) => !offered.has(id) && getAgent(id) && !unusable(getAgent(id), false));
  if (!fresh.length) return;
  for (const [sf, m, key] of [['code', 'brainstorm', 'participants'], ['chat', 'brainstorm', 'participants'], ['code', 'lead', 'workers']]) {
    const saved = store.get(cfgStoreKey(sf, m));
    const list = saved?.[key];
    if (!Array.isArray(list)) continue; // never saved: the defaults already include it
    for (const id of fresh) {
      if (list.length >= MAX_PARTICIPANTS) break;
      if (!list.some((x) => x?.agentId === id)) list.push({ agentId: id, model: defaultModel(getAgent(id)) });
    }
    store.set(cfgStoreKey(sf, m), saved);
    delete configs[`${sf}:${m}`];
  }
  for (const id of fresh) offered.add(id);
  store.set('offeredAgents', [...offered]);
}

/** Re-validate stored configs (agents list changed). */
export function refreshAgents() {
  if (catalog.loaded) offerNewAgents();
  for (const sf of ['code', 'chat']) {
    for (const m of SURFACE_MODE_IDS[sf]) {
      const key = `${sf}:${m}`;
      configs[key] = sanitize(m, configs[key] || store.get(cfgStoreKey(sf, m)), sf);
    }
  }
  if (root?.isConnected) render();
}

export function setContext(next) {
  const gitKey = (i) => `${i?.isGit ?? ''}|${i?.hasCommits ?? ''}|${i?.exists ?? ''}`;
  const gitChanged = 'cwdInfo' in next && gitKey(next.cwdInfo) !== gitKey(ctx.cwdInfo);
  ctx = { ...ctx, ...next };
  if (!root?.isConnected) return;
  if (mode === 'parallel' && gitChanged) render();
  else renderHero();
}

/**
 * Draws the new-run screen into `container`. The page keeps one composer: app.js moves it into
 * composerSlot() (between the greeting and the mode bar, like the chat apps). Re-renders never
 * detach the slot, so typing is never interrupted.
 */
export function mount(container, context) {
  const { surface: sf, ...rest } = context || {};
  ctx = { ...ctx, ...rest };
  if (sf) { surface = sf === 'chat' ? 'chat' : 'code'; mode = modes[surface]; }
  heroEl = h('div', { class: 'hero' });
  slotEl = h('div', { class: 'composer-slot' });
  restEl = h('div', { class: 'newrun-rest' });
  root = h('div', { class: 'newrun' }, heroEl, slotEl, restEl);
  container.replaceChildren(root);
  render();
}

export const composerSlot = () => slotEl;

/** One line for the composer: what will run ("Opus 5.5 yönetir · ekip otomatik"). */
export function summary() {
  if (!catalog.loaded) return '';
  const c = cfg();
  const who = (x) => (x?.agentId ? `${agentName(x.agentId)} · ${shortModel(x.agentId, x.model)}` : '');
  switch (mode) {
    case 'chat': return who(c.agent);
    case 'lead': return `${shortModel(c.lead.agentId, c.lead.model)} yönetir · ${c.teamMode === 'auto' ? 'otomatik ekip' : `${c.workers.length} alt ajan`}`;
    case 'team': return `${c.workers.length} çalışan · en fazla ${c.fixRounds} düzeltme`;
    default: return c.participants ? `${c.participants.length} katılımcı` : '';
  }
}

const shortModel = (agentId, modelId) => modelLabel(agentId, modelId).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+—.*$/, '').trim();

/** RunConfig (without cwd/prompt) for the selected mode. */
export function runConfig() {
  const c = cfg();
  const s = (x) => ({ agentId: x.agentId, ...(x.model ? { model: x.model } : {}) });
  if (surface === 'chat') {
    switch (mode) {
      case 'chat': return { surface, mode, agent: s(c.agent) };
      case 'group': return { surface, mode, participants: c.participants.map(s), rounds: c.rounds };
      case 'brainstorm': return { surface, mode, participants: c.participants.map(s), rounds: c.rounds, moderator: s(c.moderator) };
      default: return { surface, mode };
    }
  }
  switch (mode) {
    case 'chat': return { mode, agent: s(c.agent), permission: c.permission };
    case 'group': return { mode, participants: c.participants.map(s), rounds: c.rounds };
    case 'brainstorm': return { mode, participants: c.participants.map(s), rounds: c.rounds, moderator: s(c.moderator) };
    case 'parallel': return { mode, participants: c.participants.map(s), permission: c.permission };
    case 'team': return { mode, planner: s(c.planner), workers: c.workers.map(s), reviewer: s(c.reviewer), fixRounds: c.fixRounds, permission: c.permission };
    case 'lead': return {
      mode, lead: s(c.lead), workers: c.teamMode === 'auto' ? 'auto' : c.workers.map(s), budget: c.budget, steps: c.steps, parallel: c.parallel, taskMinutes: c.taskMinutes, permission: c.permission,
    };
    default: return { mode };
  }
}

/** Turkish error message or null. */
export function validate() {
  if (!catalog.loaded) return 'Ajan listesi henüz yüklenmedi.';
  if (!catalog.agents.some((a) => a.available)) return 'Kullanılabilir ajan yok. Ajanlar ve API’ler penceresinden kurulum/giriş durumunu kontrol edin.';
  const c = cfg();
  const check = (x, requireEdit, what) => {
    const why = unusable(getAgent(x?.agentId), requireEdit);
    return why ? `${what}: ${why}` : null;
  };
  switch (mode) {
    case 'chat': return surface === 'chat' ? check(c.agent, false, 'Model') : check(c.agent, false, 'Ajan');
    case 'group':
      if (c.participants.length < 2) return 'Grup sohbeti için en az iki katılımcı seçin (aynı ajanı farklı modellerle de ekleyebilirsiniz).';
      return c.participants.map((p) => check(p, false, 'Katılımcı')).find(Boolean) || null;
    case 'brainstorm':
      if (!c.participants.length) return 'En az bir katılımcı seçin.';
      return c.participants.map((p) => check(p, false, 'Katılımcı')).find(Boolean) || check(c.moderator, false, 'Moderatör');
    case 'parallel':
      if (!c.participants.length) return 'En az bir ajan seçin.';
      if (ctx.cwdInfo && ctx.cwdInfo.exists && ctx.cwdInfo.isGit === false) return 'Paralel mod bir git deposu gerektirir (her ajan kendi worktree’sinde çalışır).';
      if (ctx.cwdInfo && ctx.cwdInfo.isGit && ctx.cwdInfo.hasCommits === false) return 'Paralel mod için depoda en az bir commit olmalı (worktree’ler son commit’ten açılır).';
      return c.participants.map((p) => check(p, false, 'Ajan')).find(Boolean) || null;
    case 'team':
      if (!c.workers.length) return 'En az bir çalışan seçin.';
      return check(c.planner, false, 'Planlayıcı') || c.workers.map((p) => check(p, false, 'Çalışan')).find(Boolean) || check(c.reviewer, false, 'Denetçi');
    case 'lead':
      if (c.teamMode === 'auto') {
        const t = autoTeamFor(c);
        if (t.workers && !t.workers.length) {
          return c.budget === 'free-only'
            ? 'Kullanılabilir ücretsiz ajan yok. Ajanlar ve API\'ler penceresinden Groq, OpenRouter ya da Gemini gibi ücretsiz bir ajan bağlayın veya bütçeyi değiştirin.'
            : 'Ekip için kullanılabilir alt ajan yok. Ajanlar ve API\'ler penceresinden bir ajan bağlayın.';
        }
        return check(c.lead, false, 'Yönetici');
      }
      if (!c.workers.length) return 'En az bir alt ajan seçin.';
      return check(c.lead, false, 'Yönetici') || c.workers.map((p) => check(p, false, 'Alt ajan')).find(Boolean) || null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------

function renderHero() {
  if (!heroEl) return;
  if (surface === 'chat') {
    heroEl.replaceChildren(title('ne konuşalım?'),
      h('span', { class: 'hero-proj hero-sub' }, icon('chat'), 'Sohbet · proje klasörü gerekmez'));
    return;
  }
  const info = ctx.cwdInfo;
  const proj = ctx.cwd
    ? h('button', { type: 'button', class: 'hero-proj', title: `${ctx.cwd}\nDeğiştirmek için tıklayın`, onclick: () => ctx.onPickFolder?.() }, icon('folder'), basename(ctx.cwd),
      info?.isGit && h('span', { class: 'hero-git' }, icon('branch'), info.branch || 'git'))
    : h('button', { type: 'button', class: 'hero-proj warn', onclick: () => ctx.onPickFolder?.() }, icon('folder'), 'Bir proje klasörü seçin');
  heroEl.replaceChildren(title('ne yapalım?'), proj);
}

/** "✳ İyi akşamlar, ne yapalım?" */
function title(question) {
  const hr = new Date().getHours();
  const word = hr < 6 ? 'İyi geceler' : hr < 12 ? 'Günaydın' : hr < 18 ? 'İyi günler' : 'İyi akşamlar';
  return h('h1', { class: 'hero-title' },
    h('span', { class: 'brand-mark hero-mark', 'aria-hidden': 'true' }, h('i'), h('i')),
    h('span', { text: `${word}, ${question}` }));
}

function render() {
  if (!root) return;
  renderHero();
  const card = h('div', { class: 'setup' });
  buildSetup(card);
  fill(restEl,
    modeBar(),
    h('p', { class: 'mode-desc', text: modeInfo(mode, surface).desc }),
    card,
    suggestions());
}

function setMode(m) {
  if (m === mode) return;
  mode = m;
  modes[surface] = m;
  store.set(modeStoreKey(surface), m);
  render();
  ctx.onModeChange?.(m);
}

// ---- mode bar: the main modes as pills, the rest under "Diğer modlar" -------------------------

let menuClose = null;

function modeBar() {
  const ids = SURFACE_MODE_IDS[surface];
  const primary = surface === 'chat' ? ids : PRIMARY_MODES;
  const others = ids.filter((m) => !primary.includes(m));
  const pill = (m) => h('button', {
    type: 'button',
    class: `mode-pill${m === mode ? ' active' : ''}`,
    'aria-pressed': m === mode ? 'true' : 'false',
    title: modeInfo(m, surface).desc,
    onclick: () => setMode(m),
  }, icon(modeInfo(m, surface).icon), h('span', { text: modeInfo(m, surface).label }));
  const bar = h('div', { class: 'mode-bar', role: 'group', 'aria-label': 'Çalışma modu' }, primary.map(pill));
  if (!others.length) return bar;

  const inOthers = others.includes(mode);
  const menu = h('div', { class: 'menu mode-menu', role: 'menu', hidden: true },
    h('div', { class: 'menu-t', text: 'Diğer modlar' }),
    others.map((m) => h('button', {
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': m === mode ? 'true' : 'false',
      class: `menu-item${m === mode ? ' active' : ''}`,
      onclick: () => { close(); setMode(m); },
    },
    h('span', { class: 'mi-ico' }, icon(modeInfo(m, surface).icon)),
    h('span', { class: 'mi-main' },
      h('span', { class: 'mi-label', text: modeInfo(m, surface).label }),
      h('span', { class: 'mi-desc', text: modeInfo(m, surface).short || modeInfo(m, surface).desc })),
    m === mode && icon('check', 'mi-check'))));
  const btn = h('button', {
    type: 'button',
    class: `mode-pill more${inOthers ? ' active' : ''}`,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); },
  }, inOthers ? icon(modeInfo(mode, surface).icon) : icon('more'), h('span', { text: inOthers ? modeInfo(mode, surface).label : 'Diğer modlar' }), icon('down', 'chev'));
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };
  function open() {
    menuClose?.();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    menuClose = close;
    menu.querySelector('.menu-item')?.focus();
  }
  function close() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    if (menuClose === close) menuClose = null;
  }
  bar.append(h('div', { class: 'menu-anchor' }, btn, menu));
  return bar;
}

// ---- suggestions -----------------------------------------------------------------------------

const SUGGEST = {
  code: [
    ['search', 'Projeyi incele', 'Bu projeyi incele: ne işe yaradığını, klasör yapısını ve önemli dosyaları kısaca özetle.'],
    ['check', 'Testleri düzelt', 'Testleri çalıştır; kırık olanların nedenini bul ve düzelt.'],
    ['file', 'README yaz', 'README dosyasını projenin şu anki hâline göre güncelle: kurulum, kullanım ve örnekler.'],
    ['warn', 'Hata ara', 'Kodu hata, güvenlik açığı ve gözden kaçmış uç durumlar açısından gözden geçir; bulduklarını önem sırasıyla listele.'],
  ],
  chat: [
    ['bulb', 'Fikir üret', 'Bir yan proje için 5 özgün fikir öner; her biri için kısa bir açıklama yaz.'],
    ['chat', 'Basitçe açıkla', 'Bana bir kavramı 10 yaşındaki birine anlatır gibi açıkla: '],
    ['file', 'Metin yaz', 'Şu konuda kısa ve net bir e-posta taslağı yaz: '],
    ['code', 'Kodu açıkla', 'Şu kodun ne yaptığını adım adım açıkla:\n\n'],
  ],
};

function suggestions() {
  const list = SUGGEST[surface === 'chat' ? 'chat' : 'code'];
  return h('div', { class: 'suggest' }, list.map(([ic, label, text]) => h('button', {
    type: 'button',
    class: 'suggest-chip',
    title: text,
    onclick: () => ctx.onSuggest?.(text),
  }, icon(ic), h('span', { text: label }))));
}

// ---- setup -----------------------------------------------------------------------------------

function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('div', { class: 'field-label', text: label }),
    h('div', { class: 'field-control' }, control, hint && h('div', { class: 'field-hint' }, hint)));
}

function single(c, key, requireEdit, label) {
  return agentPicker({
    value: c[key],
    requireEdit,
    label,
    onChange: (v) => { c[key] = v; save(); if (mode === 'lead' && key === 'lead') render(); },
  });
}

function multi(c, key, requireEdit, addLabel, itemLabel) {
  const wrap = h('div', { class: 'multi' });
  const draw = () => {
    fill(wrap,
      ...c[key].map((v, i) => agentPicker({
        value: v,
        requireEdit,
        label: `${itemLabel} ${i + 1}`,
        onChange: (nv) => { c[key][i] = nv; save(); },
        onRemove: c[key].length > 1 ? () => { c[key].splice(i, 1); save(); draw(); } : null,
      })),
      c[key].length < MAX_PARTICIPANTS && h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm add-row',
        onclick: () => {
          const used = new Set(c[key].map((x) => x.agentId));
          const next = usableAgents(requireEdit).find((a) => !used.has(a.id)) || usableAgents(requireEdit)[0];
          if (!next) return;
          c[key].push({ agentId: next.id, model: defaultModel(next) });
          save();
          draw();
        },
      }, icon('plus'), addLabel));
  };
  draw();
  return wrap;
}

/** Segmented control. `opts` = [{ id, label, title?, danger? }]; `get()` / `set(id)`. */
function seg(opts, get, set, aria) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': aria });
  const draw = () => {
    wrap.replaceChildren(...opts.map((o) => h('button', {
      type: 'button',
      role: 'radio',
      title: o.title || '',
      'aria-checked': o.id === get() ? 'true' : 'false',
      class: `seg-btn${o.id === get() ? ' active' : ''}${o.danger ? ' danger' : ''}`,
      onclick: () => { set(o.id); draw(); },
    }, o.label)));
  };
  draw();
  return wrap;
}

function permissionControl(c, allowed) {
  const wrap = h('div', { class: 'perm' });
  const draw = () => {
    const opts = PERMISSIONS.filter((p) => allowed.includes(p.id));
    const cur = opts.find((p) => p.id === c.permission) || opts[0];
    fill(wrap,
      seg(opts.map((p) => ({ id: p.id, label: p.label, danger: p.id === 'full' })), () => cur.id, (id) => { c.permission = id; save(); draw(); }, 'Yetki'),
      h('div', { class: 'field-hint', text: cur.desc }),
      cur.id === 'full' && h('div', { class: 'danger-box', role: 'alert' }, icon('warn'),
        h('span', {}, h('strong', {}, 'Tam yetki: '), 'ajan onay istemeden, korumalı alan (sandbox) olmadan komut çalıştırabilir, dosya silebilir ve ağa erişebilir. Yalnızca güvendiğiniz projelerde ve yedeğiniz varken kullanın.')));
  };
  draw();
  return wrap;
}

const nums = (list) => list.map((n) => ({ id: n, label: String(n) }));

function roundsControl(c, label = 'Tur sayısı') {
  return seg(nums([1, 2, 3, 4]), () => c.rounds, (n) => { c.rounds = n; save(); }, label);
}

/** Collapsible "Gelişmiş" section (open state remembered). */
function advanced(...children) {
  const key = `adv.${surface}.${mode}`;
  const d = h('details', { class: 'adv', open: !!store.get(key, false) },
    h('summary', {}, icon('chevron', 'adv-chev'), 'Gelişmiş ayarlar'),
    h('div', { class: 'adv-body' }, children));
  d.addEventListener('toggle', () => store.set(key, d.open));
  return d;
}

// ---- lead: automatic team preview ------------------------------------------------------------

const autoCache = new Map(); // key -> { workers | null (loading), at }

function autoKey(c) {
  return `${c.budget}|${c.lead.agentId}|${c.lead.model || ''}|${catalog.agents.filter((a) => a.available).map((a) => a.id).join(',')}`;
}

/** { workers: [...] } when known, {} while loading (fetches /api/team/auto once per key). */
function autoTeamFor(c) {
  const key = autoKey(c);
  const hit = autoCache.get(key);
  if (hit) return hit;
  const entry = {};
  autoCache.set(key, entry);
  api(`/api/team/auto?budget=${enc(c.budget)}&lead=${enc(c.lead.agentId)}&leadModel=${enc(c.lead.model || '')}`, { quiet: true })
    .then((r) => { entry.workers = Array.isArray(r?.workers) ? r.workers : []; })
    .catch(() => { entry.workers = null; autoCache.delete(key); })
    .finally(() => { if (root?.isConnected && mode === 'lead') render(); });
  return entry;
}

function teamPreview(c) {
  const t = autoTeamFor(c);
  if (!t.workers) return h('div', { class: 'team-prev loading' }, spinner('sm'), 'Ekip hazırlanıyor…');
  if (!t.workers.length) {
    return h('div', { class: 'setup-note warn' }, icon('warn'), c.budget === 'free-only'
      ? 'Kullanılabilir ücretsiz ajan yok. Ajanlar ve API\'ler penceresinden Groq, OpenRouter ya da Gemini gibi ücretsiz bir ajan bağlayın.'
      : 'Kullanılabilir alt ajan yok.');
  }
  return h('div', { class: 'team-prev' }, t.workers.map((w) => h('span', {
    class: `team-chip${w.backup ? ' backup' : ''}`,
    title: `${w.name} · ${w.modelLabel}${w.backup ? '\nYedek: yalnızca ücretsiz ajanlar başaramazsa kullanılır' : ''}`,
  },
  h('span', { class: `agent-av sm spk-${w.agentId}`, 'aria-hidden': 'true', text: w.name.charAt(0).toLocaleUpperCase('tr') }),
  h('span', { class: 'tc-name' }, h('b', { text: w.name.replace(/\s*\(.*\)$/, '') }), ' ', shortModel(w.agentId, w.model)),
  tierBadge(w.tier),
  w.backup && h('span', { class: 'tc-backup', text: 'yedek' }))));
}

function leadSetup(card, c) {
  const team = h('div', { class: 'team-box' });
  const drawTeam = () => {
    fill(team,
      seg([
        { id: 'auto', label: 'Otomatik', title: 'Ortak, aktif ajanlardan ekibi bütçeye göre kurar' },
        { id: 'manual', label: 'Elle seç', title: 'Alt ajanları kendiniz seçin' },
      ], () => c.teamMode, (id) => { c.teamMode = id; save(); drawTeam(); ctx.onModeChange?.(mode); }, 'Ekip'),
      c.teamMode === 'auto'
        ? [
          h('div', { class: 'budget' },
            h('span', { class: 'budget-l', text: 'Bütçe' }),
            seg(BUDGETS.map((b) => ({ id: b.id, label: b.label, title: b.desc })), () => c.budget,
              (id) => { c.budget = id; save(); drawTeam(); ctx.onModeChange?.(mode); }, 'Bütçe')),
          h('div', { class: 'field-hint', text: BUDGETS.find((b) => b.id === c.budget)?.desc || '' }),
          teamPreview(c),
        ]
        : multi(c, 'workers', false, 'Alt ajan ekle', 'Alt ajan'));
  };
  drawTeam();
  card.append(
    field('Yönetici', single(c, 'lead', false, 'Yönetici'), 'Planlar, işi dağıtır ve denetler; kendisi kod yazmaz. Güçlü bir model seçin (ör. Opus).'),
    field('Ekip', team),
    advanced(
      field('En fazla denetim', seg(nums([3, 5, 8, 12]), () => c.steps, (n) => { c.steps = n; save(); }, 'En fazla denetim'), 'Yönetici işler bitince (bir iş başarısız olursa hemen) sonuçları denetler ve gerekirse yeni görev verir.'),
      field('Aynı anda görev', seg(nums([1, 3, 5, 8]), () => c.parallel, (n) => { c.parallel = n; save(); }, 'Aynı anda görev'), 'Bağımsız görevler aynı anda bu kadar modelde çalışır. Yönetici her görev için modeli katalogdan seçer; aynı model meşgulse yeni bir kopyası açılır.'),
      field('Görev süre sınırı', seg([5, 10, 20, 30, 0].map((n) => ({ id: n, label: n ? `${n} dk` : 'Yok' })), () => c.taskMinutes, (n) => { c.taskMinutes = n; save(); }, 'Görev süre sınırı'), 'Bu sürede bitmeyen görev durdurulur ve başka bir modele verilir (Junie gibi yavaş ajanlar işi tıkamasın).'),
      field('Yetki', permissionControl(c, ['read-only', 'edit', 'full']))));
}

function buildSetup(card) {
  const c = cfg();
  if (!catalog.loaded) {
    card.append(h('div', { class: 'empty small' }, spinner('sm'), 'Ajanlar yükleniyor…'));
    return;
  }
  if (!catalog.agents.some((a) => a.available)) {
    card.append(h('div', { class: 'empty' },
      h('strong', {}, 'Kullanılabilir ajan bulunamadı.'),
      h('div', {}, 'Claude Code, Codex, Gemini, Groq, OpenRouter… en az biri kurulu ya da bağlı olmalı.'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => ctx.onAgents?.() }, icon('key'), 'Ajanlar ve API\'ler')));
    return;
  }
  if (surface === 'chat') {
    buildChatSetup(card, c);
    return;
  }
  switch (mode) {
    case 'chat':
      card.append(
        field('Model', single(c, 'agent', false, 'Ajan'), 'Dosya araçları olmayan modellerde (Gemini web, Groq, OpenRouter…) Ortak dosyaları okur, değişiklikleri uygular ve komutları çalıştırır.'),
        field('Yetki', permissionControl(c, ['read-only', 'edit', 'full'])));
      break;
    case 'lead':
      leadSetup(card, c);
      break;
    case 'group':
      card.append(
        field('Katılımcılar', multi(c, 'participants', false, 'Katılımcı ekle', 'Katılımcı'), 'Sırayla konuşurlar; aynı ajanı farklı modellerle de ekleyebilirsiniz.'),
        field('Uzunluk', roundsControl(c, 'Konuşma uzunluğu'), 'Her mesajınızdan sonra her ajan en fazla bu kadar kez söz alır; herkes uzlaşırsa daha erken biter.'),
        h('div', { class: 'setup-note' }, icon('info'), 'Ajanlar birbirine @ad ile hitap eder. Grup sohbeti salt okunur çalışır.'));
      break;
    case 'brainstorm':
      card.append(
        field('Katılımcılar', multi(c, 'participants', false, 'Katılımcı ekle', 'Katılımcı')),
        field('Tur sayısı', roundsControl(c), 'Her turda ajanlar birbirlerinin önceki yanıtlarını görür.'),
        field('Moderatör', single(c, 'moderator', false, 'Moderatör'), 'Tartışmayı sonunda tek bir sentezde toplar.'),
        h('div', { class: 'setup-note' }, icon('info'), 'Beyin fırtınası salt okunur çalışır; dosyalar değiştirilmez.'));
      break;
    case 'parallel': {
      const noGit = ctx.cwdInfo && ctx.cwdInfo.exists && ctx.cwdInfo.isGit === false;
      const noCommits = ctx.cwdInfo && ctx.cwdInfo.isGit && ctx.cwdInfo.hasCommits === false;
      card.append(
        field('Ajanlar', multi(c, 'participants', false, 'Ajan ekle', 'Ajan'), 'Aynı ajanı farklı modellerle birden çok kez ekleyebilirsiniz.'),
        field('Yetki', permissionControl(c, ['edit', 'full'])),
        noGit
          ? h('div', { class: 'setup-note warn' }, icon('warn'), 'Seçili klasör bir git deposu değil. Paralel mod her ajan için ayrı bir git worktree oluşturur.')
          : noCommits
          ? h('div', { class: 'setup-note warn' }, icon('warn'), 'Depoda henüz commit yok. Paralel mod worktree’leri son commit’ten açar; önce bir commit oluşturun.')
          : h('div', { class: 'setup-note' }, icon('info'), 'Her ajan ayrı bir worktree’de çalışır; ana klasörünüz siz “Bunu uygula” diyene kadar değişmez.'));
      break;
    }
    case 'team':
      card.append(
        field('Planlayıcı', single(c, 'planner', false, 'Planlayıcı'), 'Görevi adımlara böler (salt okunur).'),
        field('Çalışanlar', multi(c, 'workers', false, 'Çalışan ekle', 'Çalışan'), 'Adımları sırayla uygular; biri limite takılırsa adım sıradakine geçer.'),
        field('Denetçi', single(c, 'reviewer', false, 'Denetçi'), 'Sonucu inceler; sorun bulursa düzeltme ister ve düzeltmeyi yeniden kontrol eder.'),
        field('Düzeltme turu', seg(nums([1, 2, 3, 5]), () => c.fixRounds, (n) => { c.fixRounds = n; save(); }, 'En fazla düzeltme turu'), 'Denetçi onay verene kadar en fazla bu kadar düzeltme yapılır. Limit dolarsa takım durur; "devam et" ile kaldığı yerden sürer.'),
        field('Yetki', permissionControl(c, ['edit', 'full'])));
      break;
    default:
      break;
  }
}

/** Setup card of the Sohbet surface: models only — no folder, no permissions (always read-only). */
function buildChatSetup(card, c) {
  switch (mode) {
    case 'chat':
      card.append(field('Model', single(c, 'agent', false, 'Model'), 'Claude, GPT (Codex), Gemini, Groq, OpenRouter, OpenCode ve Kilo’nun ücretsiz modelleri…'));
      break;
    case 'group':
      card.append(
        field('Katılımcılar', multi(c, 'participants', false, 'Katılımcı ekle', 'Katılımcı'), 'Sırayla konuşurlar; aynı ajanı farklı modellerle de ekleyebilirsiniz.'),
        field('Uzunluk', roundsControl(c, 'Konuşma uzunluğu'), 'Her mesajınızdan sonra her model en fazla bu kadar kez söz alır; herkes uzlaşırsa daha erken biter.'));
      break;
    case 'brainstorm':
      card.append(
        field('Katılımcılar', multi(c, 'participants', false, 'Katılımcı ekle', 'Katılımcı')),
        field('Tur sayısı', roundsControl(c), 'Her turda modeller birbirlerinin önceki yanıtlarını görür.'),
        field('Moderatör', single(c, 'moderator', false, 'Moderatör'), 'Tartışmayı sonunda tek bir sentezde toplar.'));
      break;
    default:
      break;
  }
}

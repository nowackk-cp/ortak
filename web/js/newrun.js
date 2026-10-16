// "Yeni çalışma" screen: mode tabs + per-mode setup. Remembers the last config per mode.
import { h, icon, fill } from './dom.js';
import { store, basename } from './util.js';
import { PERMISSIONS, SURFACE_MODE_IDS, modeInfo } from './modes.js';
import { catalog, agentPicker, sanitizeSel, usableAgents, defaultModel, getAgent, unusable } from './agents.js';

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
      return { planner: sel(false, 'claude'), workers: [sel(true, 'claude')], reviewer: sel(false, 'codex'), permission: 'edit' };
    case 'lead':
      return { lead: pick('claude', 'opus') || sel(false, 'claude'), workers: leadWorkers(), steps: 8, permission: 'edit' };
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
    case 'team':
      return {
        planner: sanitizeSel(c.planner, false, 'claude'),
        workers: list(c.workers, false, d.workers),
        reviewer: sanitizeSel(c.reviewer, false, 'codex'),
        permission: perm(c.permission, ['edit', 'full'], d.permission),
      };
    case 'lead': {
      const n = Number(c.steps);
      return {
        lead: sanitizeSel(c.lead, false, 'claude'),
        workers: list(c.workers, false, d.workers),
        steps: n >= 1 && n <= 12 ? Math.round(n) : d.steps,
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

export function mount(container, context) {
  const { surface: sf, ...rest } = context || {};
  ctx = { ...ctx, ...rest };
  if (sf) { surface = sf === 'chat' ? 'chat' : 'code'; mode = modes[surface]; }
  root = h('div', { class: 'newrun' });
  container.replaceChildren(root);
  render();
}

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
    case 'team': return { mode, planner: s(c.planner), workers: c.workers.map(s), reviewer: s(c.reviewer), permission: c.permission };
    case 'lead': return { mode, lead: s(c.lead), workers: c.workers.map(s), steps: c.steps, permission: c.permission };
    default: return { mode };
  }
}

/** Turkish error message or null. */
export function validate() {
  if (!catalog.loaded) return 'Ajan listesi henüz yüklenmedi.';
  if (!catalog.agents.some((a) => a.available)) return 'Kullanılabilir ajan yok. Ajanlar panelinden kurulum/giriş durumunu kontrol edin.';
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
      if (!c.workers.length) return 'En az bir alt ajan seçin.';
      return check(c.lead, false, 'Yönetici') || c.workers.map((p) => check(p, false, 'Alt ajan')).find(Boolean) || null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------

let heroEl = null;

function renderHero() {
  if (!heroEl) return;
  if (surface === 'chat') {
    heroEl.replaceChildren(h('h1', { class: 'hero-title' }, 'Ne konuşalım?'),
      h('span', { class: 'hero-proj hero-sub' }, icon('chat'), 'Sohbet · proje klasörü gerekmez'));
    return;
  }
  const info = ctx.cwdInfo;
  const proj = ctx.cwd
    ? h('span', { class: 'hero-proj', title: ctx.cwd }, icon('folder'), basename(ctx.cwd),
      info?.isGit && h('span', { class: 'hero-git' }, icon('branch'), info.branch || 'git'))
    : h('span', { class: 'hero-proj warn' }, icon('folder'), 'Soldan bir proje klasörü seçin');
  heroEl.replaceChildren(h('h1', { class: 'hero-title' }, 'Ne yapalım?'), proj);
}

function render() {
  if (!root) return;
  heroEl = h('div', { class: 'hero' });
  renderHero();

  const ids = SURFACE_MODE_IDS[surface];
  const tabs = h('div', { class: `mode-tabs${surface === 'chat' ? ' mode-tabs-chat' : ''}`, role: 'tablist', 'aria-label': 'Çalışma modu' },
    ids.map((m) => h('button', {
      type: 'button',
      role: 'tab',
      class: `mode-tab${m === mode ? ' active' : ''}`,
      'aria-selected': m === mode ? 'true' : 'false',
      onclick: () => setMode(m),
    }, icon(modeInfo(m, surface).icon), h('span', { text: modeInfo(m, surface).label }))));

  const desc = h('p', { class: 'mode-desc', text: modeInfo(mode, surface).desc });
  const card = h('div', { class: 'setup', role: 'tabpanel' });
  buildSetup(card);
  root.replaceChildren(heroEl, tabs, desc, card);
}

function setMode(m) {
  if (m === mode) return;
  mode = m;
  modes[surface] = m;
  store.set(modeStoreKey(surface), m);
  render();
  ctx.onModeChange?.(m);
}

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
    onChange: (v) => { c[key] = v; save(); },
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

function permissionControl(c, allowed) {
  const wrap = h('div', { class: 'perm' });
  const draw = () => {
    const opts = PERMISSIONS.filter((p) => allowed.includes(p.id));
    const cur = opts.find((p) => p.id === c.permission) || opts[0];
    fill(wrap,
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Yetki' },
        opts.map((p) => h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': p.id === cur.id ? 'true' : 'false',
          class: `seg-btn${p.id === cur.id ? ' active' : ''}${p.id === 'full' ? ' danger' : ''}`,
          onclick: () => { c.permission = p.id; save(); draw(); },
        }, p.label))),
      h('div', { class: 'field-hint', text: cur.desc }),
      cur.id === 'full' && h('div', { class: 'danger-box', role: 'alert' }, icon('warn'),
        h('span', {}, h('strong', {}, 'Tam yetki: '), 'ajan onay istemeden, korumalı alan (sandbox) olmadan komut çalıştırabilir, dosya silebilir ve ağa erişebilir. Yalnızca güvendiğiniz projelerde ve yedeğiniz varken kullanın.')));
  };
  draw();
  return wrap;
}

function roundsControl(c, label = 'Tur sayısı') {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const draw = () => {
    wrap.replaceChildren(...[1, 2, 3, 4].map((n) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': n === c.rounds ? 'true' : 'false',
      class: `seg-btn${n === c.rounds ? ' active' : ''}`,
      onclick: () => { c.rounds = n; save(); draw(); },
    }, String(n))));
  };
  draw();
  return wrap;
}

function stepsControl(c) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'En fazla denetim' });
  const draw = () => {
    wrap.replaceChildren(...[3, 5, 8, 12].map((n) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': n === c.steps ? 'true' : 'false',
      class: `seg-btn${n === c.steps ? ' active' : ''}`,
      onclick: () => { c.steps = n; save(); draw(); },
    }, String(n))));
  };
  draw();
  return wrap;
}

function buildSetup(card) {
  const c = cfg();
  if (!catalog.loaded) {
    card.append(h('div', { class: 'empty small' }, 'Ajanlar yükleniyor…'));
    return;
  }
  if (!catalog.agents.some((a) => a.available)) {
    card.append(h('div', { class: 'empty' },
      h('strong', {}, 'Kullanılabilir ajan bulunamadı.'),
      h('div', {}, 'Claude Code, Codex, OpenCode, Kilo Code, GitHub Copilot, Junie veya Antigravity kurulu ve oturum açmış olmalı. Sol alttaki Ajanlar panelinden nedenleri görebilir ve yenileyebilirsiniz.')));
    return;
  }
  if (surface === 'chat') {
    buildChatSetup(card, c);
    return;
  }
  switch (mode) {
    case 'chat':
      card.append(
        field('Ajan', single(c, 'agent', false, 'Ajan'), 'Gemini (4 Argon) gibi dosya araçları olmayan modellerde Ortak dosyaları okur, klasörlerde gezer, verdikleri değişiklikleri uygular ve istedikleri terminal komutlarını çalıştırır (yetkiye göre).'),
        field('Yetki', permissionControl(c, ['read-only', 'edit', 'full'])));
      break;
    case 'group':
      card.append(
        field('Katılımcılar', multi(c, 'participants', false, 'Katılımcı ekle', 'Katılımcı'), 'Sırayla konuşurlar; aynı ajanı farklı modellerle de ekleyebilirsiniz.'),
        field('Konuşma uzunluğu', roundsControl(c, 'Konuşma uzunluğu'), 'Sizin her mesajınızdan sonra her ajan en fazla bu kadar kez söz alır; herkes uzlaşırsa daha erken biter.'),
        h('div', { class: 'setup-note' }, icon('info'), 'Ajanlar birbirine @ad ile hitap eder; anılan ajan sıradaki konuşmacı olur. Grup sohbeti salt okunur çalışır.'));
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
        field('Çalışanlar', multi(c, 'workers', false, 'Çalışan ekle', 'Çalışan'), 'Adımları sırayla uygular.'),
        field('Denetçi', single(c, 'reviewer', false, 'Denetçi'), 'Sonucu inceler; gerekirse bir düzeltme turu ister.'),
        field('Yetki', permissionControl(c, ['edit', 'full'])));
      break;
    case 'lead':
      card.append(
        field('Yönetici', single(c, 'lead', false, 'Yönetici'), 'Planlar, görev dağıtır ve denetler; kendisi dosya değiştirmez. Güçlü bir model seçin (ör. Opus).'),
        field('Alt ajanlar', multi(c, 'workers', false, 'Alt ajan ekle', 'Alt ajan'), 'Yönetici her işi en uygun alt ajana verir. Bağımsız işler aynı anda çalışır; bir işe bağlı olan iş, o biter bitmez başlar. Her alt ajan aynı anda bir iş yapar.'),
        field('En fazla denetim', stepsControl(c), 'Yönetici işler bitince (bir iş başarısız olursa hemen) sonuçları denetler ve gerekirse yeni görev verir. İş bitince erken durur.'),
        field('Yetki', permissionControl(c, ['read-only', 'edit', 'full'])),
        h('div', { class: 'setup-note' }, icon('info'), 'Gemini (web) gibi dosyalara erişemeyen alt ajanlar için dosyaları Ortak okur, önerdikleri değişiklikleri uygular ve istedikleri komutları (test vb.) çalıştırır.'));
      break;
    default:
      break;
  }
}

/** Setup card of the Sohbet surface: models only — no folder, no permissions (always read-only). */
function buildChatSetup(card, c) {
  switch (mode) {
    case 'chat':
      card.append(
        field('Model', single(c, 'agent', false, 'Model'), 'Her ajanın kendi modelleri: Claude, GPT (Codex), Gemini, Copilot, OpenCode ve Kilo’nun ücretsiz modelleri…'));
      break;
    case 'group':
      card.append(
        field('Katılımcılar', multi(c, 'participants', false, 'Katılımcı ekle', 'Katılımcı'), 'Sırayla konuşurlar; aynı ajanı farklı modellerle de ekleyebilirsiniz.'),
        field('Konuşma uzunluğu', roundsControl(c, 'Konuşma uzunluğu'), 'Sizin her mesajınızdan sonra her model en fazla bu kadar kez söz alır; herkes uzlaşırsa daha erken biter.'));
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
  card.append(h('div', { class: 'setup-note' }, icon('info'), 'Sohbet arayüzünde modeller dosyalara ve komutlara dokunmaz. Kod yazdırmak için soldan Kod arayüzüne geçin.'));
}

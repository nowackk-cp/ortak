// Model lists: every model under each app / API, where the user can see them —
//   agentModels(agent)      the "Ajanlar ve API'ler" panel (all models, with the agent's notes)
//   catalogView(providers)  what the lead may choose from (GET /api/team/auto → catalog, and the
//                           run's 'catalog' event), as "provider:model" with cost and history
import { h, icon } from './dom.js';
import { tierBadge } from './agents.js';

const FILTER_MIN = 12; // a search box above longer lists

const dur = (secs) => (secs < 60 ? `${secs} sn` : `${Math.round(secs / 60)} dk`);

/** "5 görev · 4 bitti · ort. 3 dk" (server: modelstats.js) */
function statsText(s) {
  if (!s) return '';
  const parts = [`${s.tasks} görev`, `${s.ok} bitti`];
  if (s.avgSecs != null) parts.push(`ort. ${dur(s.avgSecs)}`);
  if (s.timeouts) parts.push(`${s.timeouts} kez süre sınırı`);
  return parts.join(' · ');
}

const tag = (text, cls = '', title = '') => h('span', { class: `mdl-tag${cls ? ' ' + cls : ''}`, text, title: title || null });

function modelRow(m, { showRef }) {
  const past = statsText(m.stats);
  return h('div', {
    class: `mdl${m.disabled ? ' off' : ''}`,
    dataset: { q: `${m.label || ''} ${m.id} ${m.ref || ''}`.toLocaleLowerCase('tr') },
    title: m.ref || m.id,
  },
  h('span', { class: 'mdl-name', text: m.label || m.id }),
  showRef && h('code', { class: 'mdl-ref', text: m.ref || m.id }),
  (m.default || m.isDefault) && tag('varsayılan'),
  m.team && tag('ekipte', 'team', 'Başlangıç ekibinde'),
  m.backup && tag('yedek', 'backup', 'Yalnızca ücretsiz modeller yetmezse kullanılır'),
  m.tools === false && tag('araçsız', '', 'Gerçek araç çağırmayı desteklemiyor: Ortak onunla yazı protokolüyle çalışır (daha yavaş)'),
  past && h('span', { class: 'mdl-stats', text: past, title: 'Bu modelin son görevleri' }),
  m.note && h('span', { class: 'mdl-note', text: m.note }),
  tierBadge(m.tier));
}

/** Rows grouped under the models' `group` (when they have one). */
function rows(models, opts) {
  const out = [];
  let group = null;
  for (const m of models) {
    if (m.group && m.group !== group) {
      group = m.group;
      out.push(h('div', { class: 'mdl-group', text: group }));
    }
    out.push(modelRow(m, opts));
  }
  return out;
}

/** A search box hiding the rows (and empty groups / providers) that don't match. */
function filterBox(scope, count) {
  if (count < FILTER_MIN) return null;
  const input = h('input', { type: 'search', class: 'mdl-filter', placeholder: `${count} model içinde ara…`, 'aria-label': 'Model ara' });
  input.addEventListener('input', () => {
    const q = input.value.trim().toLocaleLowerCase('tr');
    for (const r of scope.querySelectorAll('.mdl')) r.hidden = !!q && !r.dataset.q.includes(q);
    for (const g of scope.querySelectorAll('.prov')) {
      const any = [...g.querySelectorAll('.mdl')].some((r) => !r.hidden);
      g.hidden = !any;
      if (q && any) g.open = true;
    }
  });
  return input;
}

/** "Modeller (31)" under an agent of the agents panel. */
export function agentModels(agent) {
  const models = (agent.models || []).filter((m) => m.id !== 'default' || agent.models.length === 1);
  if (!models.length && !agent.modelsNote) return null;
  const usable = models.filter((m) => !m.disabled).length;
  const free = models.filter((m) => !m.disabled && m.tier === 'free').length;
  const list = h('div', { class: 'mdl-list' }, rows(models, { showRef: false }));
  return h('details', { class: 'agent-models' },
    h('summary', {}, icon('chevron', 'am-chev'),
      h('span', { text: `Modeller (${usable})` }),
      free > 0 && free < usable && h('span', { class: 'am-free', text: `${free} ücretsiz` })),
    agent.modelsNote && h('div', { class: 'agent-reason warn-text', text: agent.modelsNote }),
    filterBox(list, models.length),
    list);
}

/**
 * The lead's catalog: one folded block per provider. `providers` = catalog.js buildCatalog output
 * ([{ agentId, name, own, copies, slow?, models: [{ id, ref, label, tier, backup?, tools?, stats?, team? }] }]).
 */
export function catalogView(providers, { open = false } = {}) {
  const total = providers.reduce((n, p) => n + p.models.length, 0);
  const body = h('div', { class: 'prov-list' }, providers.map((p) => {
    const tiers = new Set(p.models.map((m) => m.tier));
    return h('details', { class: 'prov', open: open || p.models.length <= 3 },
      h('summary', {},
        icon('chevron', 'prov-chev'),
        h('span', { class: `agent-av sm spk-${p.agentId}`, 'aria-hidden': 'true', text: (p.name || p.agentId).charAt(0).toLocaleUpperCase('tr') }),
        h('b', { class: 'prov-name', text: p.name || p.agentId }),
        h('span', { class: 'prov-n', text: `${p.models.length} model` }),
        tierBadge(tiers),
        tag(p.own ? 'kendi araçları' : 'Ortak eli', '', p.own ? 'Dosyaları kendi araçlarıyla düzenler, komut çalıştırır' : 'Ortak onun yerine dosya okur, düzenler, komut çalıştırır'),
        tag(`aynı anda ${p.copies}`, '', 'Aynı anda açılabilecek kopya sayısı'),
        p.slow && tag('yavaş', 'slow', 'Küçük bir görev bile dakikalar sürebilir')),
      h('div', { class: 'mdl-list' }, rows(p.models, { showRef: true })));
  }));
  return { total, el: h('div', { class: 'catalog-view' }, filterBox(body, total), body) };
}

/** Run view: the folded "the lead sees N models" card (event kind 'catalog'). */
export function catalogCard(ev) {
  const providers = Array.isArray(ev.providers) ? ev.providers : [];
  const { total, el } = catalogView(providers);
  const bits = [
    providers.map((p) => `${p.name} ${p.models.length}`).join(' · '),
    ev.parallel && `aynı anda ${ev.parallel} görev`,
    ev.taskMinutes ? `görev başına en fazla ${ev.taskMinutes} dk` : null,
  ].filter(Boolean);
  return h('details', { class: 'catalog-card' },
    h('summary', {},
      icon('chevron', 'prov-chev'),
      icon('sparkle'),
      h('b', { text: `Yönetici ${total} model görüyor` }),
      h('span', { class: 'cc-sub', text: bits.join(' — ') })),
    h('div', { class: 'cc-body' },
      h('p', { class: 'cc-hint', text: 'Her görev için modeli yönetici seçer; “ekipte” olanlar başlangıç ekibi. Aynı model meşgulse yeni bir kopyası açılır.' }),
      el));
}

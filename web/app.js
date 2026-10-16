// Ortak frontend entry: routing, sidebar data, composer, run lifecycle.
import { h, icon, spinner } from './js/dom.js';
import { store, debounce, basename, enc, copyText } from './js/util.js';
import { api, toast } from './js/api.js';
import { setAgents } from './js/agents.js';
import * as newrun from './js/newrun.js';
import { RunView, isTerminal } from './js/runview.js';
import { RunStream } from './js/stream.js';
import { renderRuns, renderAgents, renderCwdStatus, renderRecentMenu } from './js/sidebar.js';
import { MODES, RUN_STATUS, SURFACES, modeInfo, runSurface } from './js/modes.js';
import { openFolderPicker } from './js/folderpicker.js';
import { openPerfDialog } from './js/perf.js';
import { initAttach, attached, clearAttachments } from './js/attach.js';

const $ = (id) => document.getElementById(id);

const state = {
  agents: [],
  agentsLoaded: false,
  agentsLoading: false,
  limits: {},
  limitsAt: 0,     // when quotas were last fetched
  settings: null,  // GET /api/settings (performance)
  runs: [],
  runsLoaded: false,
  recent: [],
  cwd: '',
  cwdInfo: null,
  cwdChecked: '',
  view: null, // 'new' | 'run'
  runId: null,
  runView: null,
  stream: null,
  busy: false,
  target: '', // follow-up target lane ('' = everyone)
  starting: new Set(), // agent ids being launched via POST /api/agents/:id/start
  loggingIn: new Set(), // agent ids waiting for a sign-in started via POST /api/agents/:id/login
  surface: store.get('surface') === 'chat' ? 'chat' : 'code', // Sohbet / Kod
};

const mqMobile = matchMedia('(max-width: 860px)');
const mqLight = matchMedia('(prefers-color-scheme: light)');

// ---- theme -----------------------------------------------------------------------------------

function effectiveTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return mqLight.matches ? 'light' : 'dark';
}

function renderThemeBtn() {
  const btn = $('theme-btn');
  const dark = effectiveTheme() === 'dark';
  btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
  btn.title = dark ? 'Açık temaya geç' : 'Koyu temaya geç';
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.set('theme', next);
  renderThemeBtn();
}

// ---- drawer (mobile sidebar) -----------------------------------------------------------------

function openDrawer() {
  document.body.classList.add('drawer-open');
  $('backdrop').hidden = false;
}

function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('backdrop').hidden = true;
}

// ---- project folder --------------------------------------------------------------------------

const checkCwdSoon = debounce(() => checkCwd(), 350);

function setCwd(value, { check = true, save = true } = {}) {
  const v = String(value || '').trim().replace(/^"(.*)"$/, '$1').trim();
  state.cwd = v;
  if ($('cwd').value.trim() !== v) $('cwd').value = v;
  if (save) store.set('cwd', v);
  const known = state.cwdChecked === v ? state.cwdInfo : null;
  newrun.setContext({ cwd: v, cwdInfo: known });
  if (!known) renderCwdStatus(v, null, !!v && check);
  if (check) checkCwdSoon();
  updateComposerCtx();
}

async function checkCwd() {
  checkCwdSoon.cancel();
  const p = state.cwd;
  if (!p) {
    state.cwdInfo = null;
    state.cwdChecked = '';
    renderCwdStatus('', null);
    newrun.setContext({ cwdInfo: null });
    return null;
  }
  if (state.cwdChecked === p && state.cwdInfo && !state.cwdInfo.error) return state.cwdInfo;
  renderCwdStatus(p, null, true);
  let info;
  try {
    info = await api(`/api/fs/check?path=${enc(p)}`, { quiet: true });
  } catch (err) {
    info = { error: err.message };
  }
  if (state.cwd !== p) return null;
  state.cwdInfo = info || { exists: false };
  // the server returns the normalized (long) form of the path — adopt it
  const norm = typeof info?.path === 'string' && info.path && info.exists ? info.path : p;
  if (norm !== p) {
    state.cwd = norm;
    if (document.activeElement !== $('cwd')) $('cwd').value = norm;
    store.set('cwd', norm);
    updateComposerCtx();
  }
  state.cwdChecked = norm;
  renderCwdStatus(norm, state.cwdInfo);
  newrun.setContext({ cwd: norm, cwdInfo: state.cwdInfo });
  return state.cwdInfo;
}

function showRecentMenu() {
  const shown = renderRecentMenu(state.recent, state.cwd, (c) => {
    setCwd(c, { check: false });
    checkCwd();
    hideRecentMenu();
    $('cwd').blur();
  });
  $('cwd-menu').hidden = !shown;
}

function hideRecentMenu() {
  $('cwd-menu').hidden = true;
}

function focusCwd() {
  if (mqMobile.matches) openDrawer();
  setTimeout(() => $('cwd').focus(), 50);
}

async function loadRecent() {
  try {
    const r = await api('/api/recent', { quiet: true });
    state.recent = Array.isArray(r?.cwds) ? r.cwds.filter((c) => typeof c === 'string') : [];
  } catch {
    state.recent = [];
  }
  if (!state.cwd && state.recent[0]) setCwd(state.recent[0]);
}

// ---- agents & limits -------------------------------------------------------------------------

function paintAgents() {
  renderAgents(state.agents, state.limits, {
    loaded: state.agentsLoaded,
    loading: state.agentsLoading,
    starting: state.starting,
    onStart: startAgent,
    loggingIn: state.loggingIn,
    onLogin: loginAgent,
  });
}

// Sign in / connect an account: the server opens the CLI's own login (terminal window or browser).
// While a required sign-in is pending, the agent list is re-checked every few seconds.
async function loginAgent(id) {
  if (state.loggingIn.has(id)) return;
  const agent = state.agents.find((a) => a.id === id);
  const name = agent?.name || id;
  let r;
  try {
    r = await api(`/api/agents/${enc(id)}/login`, { method: 'POST' });
  } catch { return; /* error toast shown by api() */ }
  toast(r?.message || `${name}: açılan pencerede oturum açın; bitince Ajanlar ve API’ler penceresini yenileyin.`, 'info', 6000);
  if (!agent?.login?.required) return;
  state.loggingIn.add(id);
  paintAgents();
  for (let i = 0; i < 40 && state.loggingIn.has(id); i++) {
    await new Promise((res) => setTimeout(res, 6000));
    await loadAgents(true);
    if (state.agents.find((a) => a.id === id)?.available) {
      toast(`${name} hazır.`, 'success');
      loadLimits(true);
      break;
    }
  }
  state.loggingIn.delete(id);
  paintAgents();
}

// Launch a startable agent (e.g. the Antigravity desktop app). May take up to ~90s.
async function startAgent(id) {
  if (state.starting.has(id)) return;
  const name = state.agents.find((a) => a.id === id)?.name || id;
  state.starting.add(id);
  paintAgents();
  try {
    await api(`/api/agents/${enc(id)}/start`, { method: 'POST' });
    toast(`${name} başlatıldı.`, 'success');
  } catch { /* error toast shown by api() */ }
  state.starting.delete(id);
  await Promise.all([loadAgents(true), loadLimits(true)]);
}

async function loadAgents(refresh = false) {
  state.agentsLoading = true;
  paintAgents();
  try {
    const list = await api(`/api/agents${refresh ? '?refresh=1' : ''}`);
    state.agents = Array.isArray(list) ? list : [];
  } catch {
    if (!state.agentsLoaded) state.agents = [];
  }
  setAgents(state.agents);
  state.agentsLoaded = true;
  state.agentsLoading = false;
  newrun.refreshAgents();
  state.runView?.refreshLabels();
  paintAgents();
  updateComposerCtx();
}

async function loadLimits(refresh = false) {
  state.limitsAt = Date.now();
  try {
    const l = await api(`/api/limits${refresh ? '?refresh=1' : ''}`, { quiet: true });
    if (l && typeof l === 'object') state.limits = l;
  } catch { /* keep previous */ }
  paintAgents();
}

async function refreshAll() {
  await Promise.all([loadAgents(true), loadLimits(true)]);
  toast('Ajanlar ve limitler yenilendi', 'success', 1800);
}

// ---- "Ajanlar ve API’ler" dialog -------------------------------------------------------------

let agentsReturn = null;

function openAgents() {
  const dlg = $('agents-dialog');
  if (!dlg.hidden) return;
  agentsReturn = document.activeElement;
  dlg.hidden = false;
  if (mqMobile.matches) closeDrawer();
  dlg.querySelector('.modal')?.focus();
  // quotas may be stale: refresh in the background when older than a minute
  if (Date.now() - state.limitsAt > 60_000) loadLimits();
}

function closeAgents() {
  const dlg = $('agents-dialog');
  if (dlg.hidden) return;
  dlg.hidden = true;
  agentsReturn?.focus?.();
  agentsReturn = null;
}

// ---- run history -----------------------------------------------------------------------------

function paintRuns() {
  const chat = state.surface === 'chat';
  renderRuns(state.runs.filter((r) => runSurface(r) === state.surface), state.view === 'run' ? state.runId : null, {
    loaded: state.runsLoaded,
    onDelete: deleteRun,
    emptyText: chat ? 'Henüz sohbet yok. Bir model seçip yazmaya başlayın.' : 'Henüz çalışma yok. Bir mod seçip görevinizi yazarak başlayın.',
  });
  updateTitle();
}

// ---- surfaces (Sohbet / Kod) -----------------------------------------------------------------

function renderSurfaceSwitch() {
  const el = $('surface-switch');
  el.replaceChildren(...Object.entries(SURFACES).map(([id, s]) => h('button', {
    type: 'button',
    role: 'tab',
    class: `surface-btn${id === state.surface ? ' active' : ''}`,
    'aria-selected': id === state.surface ? 'true' : 'false',
    title: s.title,
    onclick: () => switchSurface(id),
  }, icon(s.icon), h('span', { text: s.label }))));
}

/** Show a surface: sidebar, history and new-run screen follow it. */
function applySurface(sf) {
  sf = sf === 'chat' ? 'chat' : 'code';
  const changed = sf !== state.surface;
  state.surface = sf;
  store.set('surface', sf);
  document.body.dataset.surface = sf;
  renderSurfaceSwitch();
  newrun.setSurface(sf);
  $('new-btn').replaceChildren(h('span', { class: 'nb-ico' }, icon('plus')), h('span', { text: sf === 'chat' ? 'Yeni sohbet' : 'Yeni çalışma' }));
  $('sb-runs-title').textContent = sf === 'chat' ? 'Sohbetler' : 'Çalışmalar';
  if (changed) paintRuns();
}

/** Clicked Sohbet / Kod: open that surface's new screen (unless already there). */
function switchSurface(sf) {
  if (sf === state.surface && state.view === 'new') return;
  applySurface(sf);
  if (location.hash === '#/' || location.hash === '') showNew();
  else location.hash = '#/';
  if (mqMobile.matches) closeDrawer();
}

async function loadRuns() {
  try {
    const list = await api('/api/runs', { quiet: true });
    if (Array.isArray(list)) state.runs = list;
  } catch { /* keep previous */ }
  state.runsLoaded = true;
  const v = state.runView;
  if (v) {
    const r = state.runs.find((x) => x.id === v.id);
    if (r && v.status) r.status = v.status; // the live stream is fresher than the list
    if (r?.title && r.title !== v.meta.title) { v.meta.title = r.title; renderTopbar(); }
  }
  paintRuns();
}

async function deleteRun(id) {
  try {
    await api(`/api/runs/${enc(id)}`, { method: 'DELETE' });
  } catch {
    return;
  }
  state.runs = state.runs.filter((r) => r.id !== id);
  toast('Çalışma silindi', 'success', 1800);
  if (state.runId === id) location.hash = '#/';
  paintRuns();
}

// ---- views -----------------------------------------------------------------------------------

function closeRun() {
  state.stream?.stop();
  state.stream = null;
  state.runView?.destroy();
  state.runView = null;
}

/** The new-run screen holds the composer in its middle; a run keeps it at the bottom. */
let composerWrap = null;

function placeComposer(slot) {
  const wrap = (composerWrap ||= $('composer-wrap'));
  const target = slot || document.querySelector('.main');
  if (wrap.parentElement !== target) target.append(wrap);
  document.body.classList.toggle('view-new', !!slot);
}

function useSuggestion(text) {
  const ta = $('prompt');
  ta.value = text;
  autosize();
  saveDraft();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function showNew() {
  closeRun();
  placeComposer(null); // out of the old screen before it is replaced
  state.view = 'new';
  state.runId = null;
  newrun.mount($('content'), {
    surface: state.surface,
    cwd: state.cwd,
    cwdInfo: state.cwdChecked === state.cwd ? state.cwdInfo : null,
    onModeChange: () => updateComposer(),
    onSuggest: useSuggestion,
    onPickFolder: () => openFolderPicker(state.cwd, (p) => { setCwd(p, { check: false }); checkCwd(); }),
    onAgents: openAgents,
  });
  placeComposer(newrun.composerSlot());
  $('content').scrollTop = 0;
  renderTopbar();
  updateComposer();
  paintRuns();
  if (!mqMobile.matches) $('prompt').focus();
}

let openToken = 0;

async function openRun(id) {
  if (state.view === 'run' && state.runId === id && state.runView) return;
  closeRun();
  const token = ++openToken;
  state.view = 'run';
  state.runId = id;
  placeComposer(null);
  paintRuns();
  renderTopbar();
  updateComposer();
  $('content').replaceChildren(h('div', { class: 'empty run-loading' }, spinner(), 'Yükleniyor…'));

  let data;
  try {
    data = await api(`/api/runs/${enc(id)}`, { quiet: true });
  } catch (err) {
    if (token !== openToken) return;
    $('content').replaceChildren(h('div', { class: 'empty' },
      h('strong', { text: 'Çalışma açılamadı.' }),
      h('div', { text: err.message }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/'; } }, icon('plus'), 'Yeni çalışma')));
    return;
  }
  if (token !== openToken) return;
  // names/models come from the agent catalog; give it a moment on first load
  if (!state.agentsLoaded && state.agentsReady) {
    await Promise.race([state.agentsReady, new Promise((r) => setTimeout(r, 2500))]);
    if (token !== openToken) return;
  }

  const meta = data?.meta && typeof data.meta === 'object' ? data.meta : { id };
  meta.id = meta.id || id;
  if (runSurface(meta) !== state.surface) applySurface(runSurface(meta));
  state.target = '';
  const view = new RunView(meta, $('content'), {
    onStatus: onRunStatus,
    onLanes: (v) => { if (v === state.runView) updateComposerCtx(); },
  });
  state.runView = view;
  const events = Array.isArray(data?.events) ? [...data.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) : [];
  for (const ev of events) view.ingest(ev);
  if (meta.status && view.status !== meta.status) view.setStatus(meta.status, meta.error);
  view.flush();
  view.scrollBottom(false);

  state.stream = new RunStream(id, {
    since: () => view.lastSeq,
    onEvent: (ev) => view.ingest(ev),
    onState: (s) => view.setConnection(s),
    shouldRetry: () => state.runView === view && !isTerminal(view.status),
  });
  if (!isTerminal(view.status)) state.stream.start();
  onRunStatus(view);
  if (!mqMobile.matches && !$('prompt').disabled) $('prompt').focus();
}

function onRunStatus(view) {
  if (view !== state.runView) return;
  const r = state.runs.find((x) => x.id === view.id);
  if (r) {
    if (r.status !== view.status) {
      const was = r.status;
      r.status = view.status;
      r.updatedAt = Date.now();
      paintRuns();
      if (was === 'running' && view.status !== 'running') {
        loadLimits();
        setTimeout(loadRuns, 600);
        // Web-driven agents report page health (warnings in the Ajanlar ve API’ler dialog) after each turn.
        if (view.meta?.lanes?.some((l) => l.agentId === 'gemini')) loadAgents(true);
      }
    }
  } else if (state.runsLoaded) {
    loadRuns();
  }
  renderTopbar();
  updateComposer();
  updateTitle();
}

function route() {
  const m = location.hash.match(/^#\/run\/([^/?#]+)/);
  if (m) {
    let id = m[1];
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    openRun(id);
  } else {
    showNew();
  }
  if (mqMobile.matches) closeDrawer();
}

// ---- top bar / title -------------------------------------------------------------------------

function renderTopbar() {
  const title = $('tb-title');
  const actions = $('tb-actions');
  if (state.view === 'run') {
    const v = state.runView;
    const meta = v?.meta || state.runs.find((r) => r.id === state.runId) || {};
    const mode = modeInfo(meta.mode, runSurface(meta));
    const status = v?.status || meta.status;
    const text = meta.title || meta.config?.prompt || 'Çalışma';
    title.replaceChildren(
      h('span', { class: 'tb-ico', title: mode.label }, icon(mode.icon)),
      h('span', { class: 'tb-text', title: text, text }),
      ...(status ? [h('span', { class: `pill s-${status}` }, status === 'running' ? spinner('sm') : h('span', { class: 'dot' }), RUN_STATUS[status] || status)] : []));
    actions.replaceChildren(...(status === 'running'
      ? [h('button', { type: 'button', class: 'btn btn-danger btn-sm', title: 'Durdur (Esc)', onclick: cancelRun }, icon('stop'), h('span', { class: 'hide-xs', text: 'Durdur' }))]
      : []));
  } else {
    title.replaceChildren();
    actions.replaceChildren();
  }
}

function updateTitle() {
  const v = state.view === 'run' ? state.runView : null;
  if (v) {
    const t = v.meta.title || v.prompt || 'Çalışma';
    document.title = v.status === 'running' ? `● ${t} — Ortak` : `${t} — Ortak`;
    return;
  }
  const n = state.runs.filter((r) => r.status === 'running').length;
  document.title = n ? `● ${n} çalışma sürüyor — Ortak` : 'Ortak';
}

// ---- composer --------------------------------------------------------------------------------

// The backend accepts follow-ups in every status except 'running' (409).
const canFollowUp = (v) => !!v && v.status !== 'running';

const FOLLOW_UP_PLACEHOLDER = {
  chat: 'Yanıt yazın…',
  group: 'Sohbete katılın — @codex gibi birini anarsanız önce o cevaplar…',
  brainstorm: 'Tartışmaya katkıda bulunun — yeni bir tur başlar…',
  parallel: 'Takip isteği yazın — ajanlar kendi worktree’lerinde devam eder…',
  team: 'Ek istek yazın — takım kaldığı yerden devam eder…',
  lead: 'Yöneticiye yazın — ekibe yeni görevler dağıtır…',
};

function autosize() {
  const ta = $('prompt');
  ta.style.height = 'auto';
  const max = Math.max(120, Math.round(window.innerHeight * 0.4));
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}

function updateComposer() {
  const ta = $('prompt');
  const btn = $('send-btn');
  let placeholder = '';
  let disabled = false;
  let stop = false;
  if (state.view === 'new') {
    placeholder = modeInfo(newrun.currentMode(), state.surface).placeholder || '';
  } else if (state.view === 'run') {
    const v = state.runView;
    if (!v) { placeholder = 'Yükleniyor…'; disabled = true; }
    else if (v.status === 'running') { stop = true; placeholder = 'Ajan çalışıyor… Durdurmak için Esc.'; }
    else placeholder = FOLLOW_UP_PLACEHOLDER[v.mode] || FOLLOW_UP_PLACEHOLDER.chat;
  }
  ta.placeholder = placeholder;
  ta.disabled = disabled;
  btn.classList.toggle('stop', stop);
  btn.replaceChildren(state.busy ? spinner('sm') : icon(stop ? 'stop' : 'send'));
  btn.title = stop ? 'Durdur (Esc)' : 'Gönder (Enter)';
  btn.setAttribute('aria-label', stop ? 'Durdur' : 'Gönder');
  btn.disabled = state.busy || (disabled && !stop);
  $('composer').classList.toggle('disabled', disabled);
  updateComposerCtx();
}

function updateComposerCtx() {
  const el = $('composer-ctx');
  const chips = [];
  if (state.view === 'new') {
    const m = modeInfo(newrun.currentMode(), state.surface);
    if (state.surface !== 'chat') chips.push(state.cwd
      ? h('button', { type: 'button', class: 'ctx-chip', title: state.cwd, onclick: focusCwd }, icon('folder'), basename(state.cwd))
      : h('button', { type: 'button', class: 'ctx-chip warn', onclick: focusCwd }, icon('folder'), 'Klasör seçin'));
    const sum = newrun.summary();
    chips.push(h('span', { class: 'ctx-chip ctx-sum', title: sum ? `${m.label} · ${sum}` : m.label }, icon(m.icon), sum || m.label));
  } else if (state.view === 'run' && state.runView) {
    const v = state.runView;
    const m = modeInfo(v.mode, runSurface(v.meta));
    const targets = v.followUpTargets();
    if (targets.length) {
      if (state.target && !targets.some((t) => t.lane === state.target)) state.target = '';
      const sel = h('select', { class: 'ctx-select', 'aria-label': 'Mesajın hedefi', title: 'Takip mesajı kime gitsin?' },
        h('option', { value: '' }, v.mode === 'brainstorm' ? 'Hepsi (yeni tur)' : v.mode === 'group' ? 'Sıradaki (otomatik)' : v.mode === 'lead' ? 'Yönetici' : 'Hepsi'),
        targets.map((t) => h('option', { value: t.lane, selected: t.lane === state.target }, t.label)));
      sel.addEventListener('change', () => { state.target = sel.value; });
      chips.push(h('label', { class: 'ctx-chip ctx-target' }, h('span', { class: 'hide-xs', text: 'Hedef:' }), sel));
    } else {
      chips.push(h('span', { class: 'ctx-chip' }, icon(m.icon), m.label));
    }
    if (v.cwd && runSurface(v.meta) !== 'chat') chips.push(h('span', { class: 'ctx-chip', title: v.cwd }, icon('folder'), basename(v.cwd)));
  }
  el.replaceChildren(...chips);
}

function setBusy(b) {
  state.busy = b;
  updateComposer();
}

const saveDraft = debounce(() => store.set('draft', $('prompt').value), 300);

function clearPrompt() {
  $('prompt').value = '';
  saveDraft.cancel();
  store.set('draft', undefined);
  autosize();
}

async function submit() {
  if (state.busy) return;
  const ta = $('prompt');
  const text = ta.value.trim();

  const files = attached();

  if (state.view === 'new') {
    if (!text && !files.length) { ta.focus(); return; }
    const chat = state.surface === 'chat'; // Sohbet: no project folder
    if (!chat) {
      if (!state.cwd) { toast('Önce bir proje klasörü seçin.', 'error'); focusCwd(); return; }
      const info = await checkCwd();
      if (info?.error) { toast(info.error, 'error'); return; }
      if (info && !info.exists) { toast('Proje klasörü bulunamadı.', 'error'); focusCwd(); return; }
      if (info && info.exists && info.isDir === false) { toast('Proje yolu bir klasör değil.', 'error'); focusCwd(); return; }
    }
    const err = newrun.validate();
    if (err) { toast(err, 'error'); return; }
    const body = chat ? { ...newrun.runConfig(), prompt: text } : { ...newrun.runConfig(), cwd: state.cwd, prompt: text };
    if (files.length) body.attachments = files;
    setBusy(true);
    try {
      const r = await api('/api/runs', { method: 'POST', body });
      if (!r?.runId) throw new Error('Sunucu çalışma kimliği döndürmedi.');
      clearPrompt();
      clearAttachments();
      if (!chat) store.set('cwd', state.cwd);
      const { attachments: _a, ...cfg } = body;
      state.runs = [{ id: r.runId, mode: body.mode, title: (text || files[0].name).slice(0, 80), cwd: body.cwd, createdAt: Date.now(), updatedAt: Date.now(), status: 'running', config: cfg }, ...state.runs.filter((x) => x.id !== r.runId)];
      location.hash = `#/run/${enc(r.runId)}`;
      setTimeout(loadRuns, 400);
      if (!chat) loadRecent();
    } catch (e) {
      if (!e.status && !e.network) toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
    return;
  }

  if (state.view === 'run') {
    const v = state.runView;
    if (!v) return;
    if (v.status === 'running') { toast('Ajan hâlâ çalışıyor. Bitmesini bekleyin ya da Esc ile durdurun.', 'info'); return; }
    if (!text && !files.length) { ta.focus(); return; }
    const lane = state.target && v.followUpTargets().some((t) => t.lane === state.target) ? state.target : undefined;
    setBusy(true);
    try {
      await api(`/api/runs/${enc(v.id)}/message`, { method: 'POST', body: { text, ...(lane ? { lane } : {}), ...(files.length ? { attachments: files } : {}) } });
      clearPrompt();
      clearAttachments();
      v.stick = true;
      if (state.runView === v && state.stream && !state.stream.active) state.stream.start();
    } catch { /* toast shown */ } finally {
      setBusy(false);
    }
  }
}

async function cancelRun() {
  const v = state.runView;
  if (!v || v.status !== 'running') return;
  try {
    await api(`/api/runs/${enc(v.id)}/cancel`, { method: 'POST' });
    toast('Durduruluyor…', 'info', 1800);
  } catch { /* toast shown */ }
}

function focusComposer() {
  const ta = $('prompt');
  if (mqMobile.matches) closeDrawer();
  if (!ta.disabled) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

// ---- wiring ----------------------------------------------------------------------------------

function bind() {
  $('theme-btn').addEventListener('click', toggleTheme);
  $('perf-btn').addEventListener('click', () => openPerfDialog({ onChange: (s) => { state.settings = s; } }));
  $('perf-btn').replaceChildren(icon('gauge'));
  mqLight.addEventListener('change', renderThemeBtn);

  $('menu-btn').addEventListener('click', openDrawer);
  $('sb-close').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  mqMobile.addEventListener('change', () => { if (!mqMobile.matches) closeDrawer(); });

  const cwd = $('cwd');
  cwd.addEventListener('input', () => { setCwd(cwd.value); showRecentMenu(); });
  cwd.addEventListener('focus', showRecentMenu);
  cwd.addEventListener('blur', () => {
    setTimeout(hideRecentMenu, 120);
    if (state.cwd && state.cwdChecked === state.cwd && cwd.value.trim() !== state.cwd) cwd.value = state.cwd;
  });
  $('cwd-browse').addEventListener('click', () => {
    hideRecentMenu();
    openFolderPicker(state.cwd, (p) => { setCwd(p, { check: false }); checkCwd(); });
  });
  cwd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setCwd(cwd.value, { check: false }); checkCwd(); hideRecentMenu(); cwd.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); hideRecentMenu(); cwd.blur(); }
  });

  $('new-btn').addEventListener('click', () => {
    if (location.hash === '#/' || location.hash === '') showNew();
    else location.hash = '#/';
    if (mqMobile.matches) closeDrawer();
    setTimeout(focusComposer, 30);
  });

  $('agents-btn').addEventListener('click', openAgents);
  $('agents-close').addEventListener('click', closeAgents);
  $('agents-dialog').addEventListener('click', (e) => { if (e.target === $('agents-dialog')) closeAgents(); });
  $('ap-refresh').addEventListener('click', refreshAll);

  const ta = $('prompt');
  ta.addEventListener('input', () => { autosize(); saveDraft(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('send-btn').classList.contains('stop')) cancelRun();
    else submit();
  });
  window.addEventListener('resize', debounce(autosize, 100));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusComposer();
      return;
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (!$('agents-dialog').hidden) { closeAgents(); return; }
      if (document.body.classList.contains('drawer-open')) { closeDrawer(); return; }
      if (state.view === 'run' && state.runView?.status === 'running') {
        e.preventDefault();
        cancelRun();
      }
    }
  });

  // copy buttons inside rendered markdown
  document.addEventListener('click', async (e) => {
    const b = e.target.closest?.('.md-copy');
    if (!b) return;
    const code = b.closest('.md-code')?.querySelector('code');
    if (!code) return;
    const ok = await copyText(code.textContent || '');
    b.textContent = ok ? 'Kopyalandı ✓' : 'Kopyalanamadı';
    b.classList.toggle('ok', ok);
    setTimeout(() => { b.textContent = 'Kopyala'; b.classList.remove('ok'); }, 1500);
  });

  window.addEventListener('hashchange', route);
}

function init() {
  $('sb-close').append(icon('x'));
  $('menu-btn').append(icon('menu'));
  $('ap-refresh').append(icon('refresh'));
  $('agents-close').append(icon('x'));
  $('cwd-browse').append(icon('folder'));
  $('agents-legend').replaceChildren(
    h('span', {}, h('span', { class: 'tier tier-free', text: 'Ücretsiz' }), 'para ya da abonelik limiti harcamaz'),
    h('span', {}, h('span', { class: 'tier tier-subscription', text: 'Abonelik' }), 'Claude / ChatGPT / Copilot limitinden harcar'),
    h('span', {}, h('span', { class: 'tier tier-paid', text: 'Ücretli' }), 'token başına ücret'));
  renderThemeBtn();
  applySurface(state.surface);

  const draft = store.get('draft', '');
  if (typeof draft === 'string') $('prompt').value = draft;

  bind();
  initAttach({
    button: $('attach-btn'), input: $('attach-input'), list: $('attach-list'), dropZone: $('composer'),
    canAttach: () => !$('prompt').disabled,
  });
  setCwd(store.get('cwd', ''), { check: false, save: false });
  renderCwdStatus(state.cwd, null, !!state.cwd);
  paintAgents();
  paintRuns();
  state.agentsReady = loadAgents();
  route();
  autosize();

  loadLimits();
  loadRuns();
  loadRecent().then(() => { if (state.cwd) checkCwd(); });

  let tick = 0;
  setInterval(() => {
    tick++;
    if (document.hidden && tick % 6) return;
    if (state.runs.some((r) => r.status === 'running') || tick % 6 === 0) loadRuns();
  }, 5000);
  // Reading quotas starts a short-lived process per agent: only while the window is visible, at
  // the interval from the Performans settings (0 = by hand only).
  api('/api/settings', { quiet: true }).then((r) => { state.settings = r.settings; }).catch(() => {});
  const limitsDue = () => {
    const mins = state.settings?.limitsRefreshMinutes ?? 5;
    return mins > 0 && Date.now() - state.limitsAt >= mins * 60000;
  };
  setInterval(() => { if (!document.hidden && limitsDue()) loadLimits(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && limitsDue()) loadLimits(); });
}

init();

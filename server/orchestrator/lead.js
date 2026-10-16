// lead (Yönetici): one lead agent (read-only) plans a task graph for its sub-agents, reviews
// their reports + diffs and either adds tasks or finishes with a summary. The lead never edits.
// Independent tasks run in parallel; a task with `after` starts as soon as those are done.
// Workers that can edit (Claude Code, Codex, Antigravity) work in the project directly;
// text-only workers (Gemini web / 4 Argon) work through textcoder.js (Ortak reads files for
// them and applies their SEARCH/REPLACE blocks).
//
//   Planlama -> Uygulama (graph) -> Denetim (when idle, or early on a failure) -> … -> Sonuç
import * as git from '../git.js';
import * as P from './prompts.js';
import { HttpError, clip } from '../util.js';
import { jsonCandidates } from './json.js';
import { stripEdits, textCoderTask, work } from './textcoder.js';
import { errorKind, mayBeStaleSession } from '../errors.js';
import { promptBudget, reviewDiff } from './diffview.js';
import { getAgents, getLimits } from '../limits.js';
import { modelTier, tierAllowed, TIER_TR } from '../tiers.js';
import { buildCatalog, copiesOf, findModel, isSlow, modelRef, parseRef } from '../catalog.js';
import { recordTask, statsOf } from '../modelstats.js';

const MAX_TASKS_PER_REPLY = 12; // tasks taken from one lead answer
const MAX_TASKS_TOTAL = 40;     // per lead loop
export const DEFAULT_PARALLEL = 5; // tasks running at the same time (config.parallel)
export const DEFAULT_TASK_MINUTES = 10; // a task running longer is stopped and handed over (config.taskMinutes, 0 = no limit)
const LANES_MAX = 16;           // worker lanes per run, the lead's extra copies included
// Lead failures after which the run waits for "devam et" instead of ending in an error.
const PAUSE_KINDS = new Set(['limit', 'transient', 'auth']);
const DIFF_EVENT_MAX = 1_500_000;
// A failed task is handed to another worker when the failure is about that agent, not the task.
const HANDOFF_KINDS = new Set(['limit', 'transient', 'auth', 'toolarge', 'timeout']);
const HANDOFF_MAX = 2;          // other workers tried per task
const QUOTA_WAIT_MS = 3000;     // how long a run start waits for the quota overview
const KIND_TR = { limit: 'limiti doldu', transient: 'geçici bir hata verdi', auth: 'oturumu kapalı', toolarge: 'isteği kaldıramadı', timeout: 'süre sınırında bitiremedi' };

// ---- names ------------------------------------------------------------------------------------

const fold = (s) => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Words that say nothing about which model it is ("Gemini 3.8 Flash (High)" -> flash).
const GENERIC = new Set([
  'gemini', 'claude', 'gpt', 'openai', 'codex', 'code', 'web', 'antigravity', 'varsayilan', 'pencerede',
  'secili', 'olan', 'ayar', 'ayari', 'dusunme', 'yuksek', 'orta', 'dusuk', 'high', 'medium', 'low',
  'thinking', 'kilitli', 'opencode', 'kilo', 'copilot', 'junie', 'github', 'otomatik', 'auto', 'secer',
  'ucretsiz', 'free', 'preview', 'latest', 'evren', 'instruct', 'chat',
]);

/** One line, at most `n` chars. */
const line = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const shortTitle = (title) => String(title || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+—.*$/, '').trim();

/** "sonnet", "argon", "sol", "flash-lite"… from the lane title; the agent id for default models. */
function modelWord(lane) {
  const model = String(lane.title || '').split(' · ').slice(1).join(' ');
  const words = fold(shortTitle(model)).split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && /[a-z]/.test(w) && !/^\d+[a-z]?$/.test(w) && !GENERIC.has(w));
  return words.slice(0, 2).join('-') || lane.agentId;
}

/** Workers with stable @handles (kept in state so a renamed model label can't change them). */
function workerList(ctx) {
  const st = ctx.state;
  const permission = ctx.config.permission;
  const readOnly = permission === 'read-only';
  const saved = new Map((st.handles || []).map((x) => [x.lane, x.handle]));
  const used = new Map(); // handle -> "agent:model"
  const out = ctx.lanes('worker').map((l) => {
    const key = modelRef(l.agentId, l.model);
    let handle = saved.get(l.lane);
    if (!handle) {
      // another copy of the same model: sonnet-2; the same word on another agent: copilot-sonnet
      const word = modelWord(l);
      const base = used.has(word) && used.get(word) !== key ? `${l.agentId}-${word}` : word;
      handle = base;
      for (let n = 2; used.has(handle); n++) handle = `${base}-${n}`;
    }
    used.set(handle, key);
    const caps = ctx.adapterOf(l.lane)?.capabilities || {};
    const edit = !!caps.edit;
    const tier = l.tier || modelTier(l.agentId, null);
    return {
      lane: l.lane, agentId: l.agentId, model: l.model, title: shortTitle(l.title), handle,
      tier,
      slow: isSlow(l.agentId),
      stats: statsOf(key),
      backup: ctx.config.budget === 'free-first' && tier !== 'free',
      quota: st.quota?.[l.agentId] || null,
      exhausted: (st.exhausted || []).includes(l.lane) || (st.exhausted || []).includes(modelRef(l.agentId, l.model)),
      textOnly: !edit,
      canEdit: edit && !readOnly,
      // editShell false: the agent can't run commands in 'edit' mode (Claude Code on Windows)
      // text-only agents run commands through Ortak (`RUN:`, commands.js)
      canRun: edit ? (permission === 'full' || (permission === 'edit' && caps.editShell !== false)) : !readOnly,
    };
  });
  st.handles = out.map(({ lane, handle }) => ({ lane, handle }));
  return out;
}

/** Lead's view of the team (text-only workers in a read-only run just read). */
const teamView = (ctx, workers) => {
  const readOnly = ctx.config.permission === 'read-only';
  return workers.map((w) => ({ ...w, textOnly: w.textOnly && !readOnly }));
};

/**
 * Every model the lead may give work to under the run's budget (catalog.js); `ctx.catalogSource`
 * replaces it in tests. Loads the adapters so lanes can be opened at once.
 */
async function loadCatalog(ctx) {
  let catalog = [];
  try {
    catalog = ctx.catalogSource ? await ctx.catalogSource() : await buildCatalog(await getAgents(), { budget: ctx.config.budget || 'any' });
  } catch (err) {
    ctx.note(`Model kataloğu alınamadı (${err.message}); yönetici yalnızca mevcut ekiple çalışacak.`, 'warn');
  }
  await ctx.ensureAdapters(catalog.map((p) => p.agentId));
  return catalog;
}

const parallelOf = (ctx) => {
  const n = Number(ctx.config.parallel);
  return n >= 1 && n <= 10 ? Math.round(n) : DEFAULT_PARALLEL;
};

const taskMinutesOf = (ctx) => {
  const n = ctx.config.taskMinutes;
  return n === 0 || (Number(n) > 0 && Number(n) <= 120) ? Number(n) : DEFAULT_TASK_MINUTES;
};

/** "%80 kullanıldı" / "950 / 1000 istek kaldı" per agent, for the lead's team list (best effort). */
async function refreshQuota(ctx) {
  try {
    const limits = await Promise.race([getLimits(), new Promise((r) => setTimeout(() => r(null), QUOTA_WAIT_MS))]);
    if (!limits) return;
    const out = {};
    for (const l of ctx.lanes('worker')) {
      const lim = limits[l.agentId];
      if (!lim?.ok || !lim.items?.length) continue;
      const pct = lim.items.map((x) => Number(x.usedPercent)).filter((n) => Number.isFinite(n));
      if (pct.length) {
        const max = Math.max(...pct);
        out[l.agentId] = max >= 95 ? `neredeyse dolu (%${Math.round(max)} kullanıldı)` : `%${Math.round(max)} kullanıldı`;
      } else if (lim.items[0]?.text) {
        out[l.agentId] = line(lim.items[0].text, 80);
      }
    }
    ctx.state.quota = out;
  } catch { /* quota is a hint only */ }
}

/** The worker the lead meant by `name` (handle, lane, agent id, model id or a word of its title). */
export function resolveWorker(workers, name) {
  const n = fold(name).replace(/^@+/, '').trim();
  if (!n) return null;
  const direct = workers.find((w) => {
    const lane = fold(w.lane);
    return w.handle === n || lane === n || lane.replace('#', '') === n || lane.replace('#', '-') === n;
  });
  if (direct) return direct;
  const uniq = (arr) => (arr.length === 1 ? arr[0] : null);
  return uniq(workers.filter((w) => w.agentId === n))
    || uniq(workers.filter((w) => fold(w.model) === n))
    || uniq(workers.filter((w) => fold(w.title).split(/[^a-z0-9.]+/).includes(n)))
    || uniq(workers.filter((w) => n.includes(w.handle) || w.handle.includes(n)));
}

// ---- lead decisions ---------------------------------------------------------------------------

const firstStr = (...vals) => vals.find((v) => typeof v === 'string' && v.trim())?.trim() || '';

function normalizeDecision(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const arr = obj.tasks ?? obj.gorevler ?? obj['görevler'] ?? obj.assignments;
  const done = obj.done === true || obj.bitti === true || /^(true|evet)$/i.test(String(obj.done ?? ''));
  const stop = obj.cancel ?? obj.iptal;
  const cancel = (Array.isArray(stop) ? stop : stop != null ? [stop] : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
  if (!Array.isArray(arr) && !done && !Array.isArray(stop)) return null;
  const tasks = (Array.isArray(arr) ? arr : []).map((t) => {
    if (!t || typeof t !== 'object') return null;
    const task = firstStr(t.task, t.gorev, t['görev'], t.instructions, t.description, t.details);
    if (!task) return null;
    const files = (Array.isArray(t.files) ? t.files : Array.isArray(t.dosyalar) ? t.dosyalar : [])
      .filter((f) => typeof f === 'string' && f.trim()).slice(0, 12);
    const deps = t.after ?? t.dependsOn ?? t.depends ?? t.sonra;
    const after = (Array.isArray(deps) ? deps : deps != null ? [deps] : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
    const id = String(t.id ?? '').trim().replace(/\s+/g, '-').slice(0, 24);
    return { id, agent: firstStr(t.agent, t.ajan, t.to, t.worker, t.assignee), task: task.slice(0, 20_000), files, after };
  }).filter(Boolean);
  return { tasks, cancel, done: done && !tasks.length, summary: firstStr(obj.summary, obj.ozet, obj['özet']) };
}

export function parseDecision(text) {
  for (const c of jsonCandidates(text, 'tasks').concat(jsonCandidates(text, 'done'))) {
    const d = normalizeDecision(c);
    if (d) return d;
  }
  return null;
}

/** The lead's answer without its JSON block (used when it gave no summary). */
const prose = (text) => String(text || '').replace(/```json[\s\S]*?```/gi, '').trim();

// A lead without file tools of its own (Gemini web, Groq…) reads the project through Ortak's
// read-only hands (textcoder.work), like a text-only worker.
async function leadTurn(ctx, prompt) {
  const resumable = ctx.canResume('lead');
  ctx.state.leadTurns = (ctx.state.leadTurns || 0) + 1;
  try {
    return await work(ctx, 'lead', { prompt, permission: 'read-only', system: P.leadSystem });
  } catch (err) {
    // A stale session usually fails at once: start a new one with the goal, team and history
    // recapped. A usage limit, network or sign-in error says nothing about the session: keep it.
    if (!resumable || err.sawOutput || err.name === 'AbortError' || !mayBeStaleSession(err)) throw err;
    ctx.note('Yöneticinin önceki oturumu sürdürülemedi; yeni oturum başlatılıyor.', 'warn');
    ctx.lane('lead').sessionId = undefined;
    const recap = P.leadRecap({
      goal: ctx.state.goal, workers: teamView(ctx, workerList(ctx)), log: ctx.state.log, budget: ctx.config.budget, permission: ctx.config.permission,
      catalog: ctx.catalog, parallel: parallelOf(ctx), taskMinutes: taskMinutesOf(ctx),
    });
    return work(ctx, 'lead', { prompt: `${recap}${prompt}`, permission: 'read-only', system: P.leadSystem, resume: false });
  }
}

async function askLead(ctx, prompt) {
  const r = await leadTurn(ctx, prompt);
  const d = parseDecision(r.text);
  if (d) return { ...d, text: r.text };
  ctx.note('Yöneticinin cevabında geçerli bir görev listesi yok; biçimi düzeltmesi isteniyor.', 'warn');
  const fix = ctx.canResume('lead') ? P.leadFixFormat() : `Önceki cevabın:\n${clip(r.text, 8000)}\n\n${P.leadFixFormat()}`;
  const r2 = await leadTurn(ctx, fix);
  const d2 = parseDecision(r2.text);
  if (d2) return { ...d2, text: r2.text };
  ctx.note('Yönetici yine geçerli bir görev listesi vermedi; cevabı sonuç olarak alındı.', 'warn');
  return { tasks: [], done: true, summary: '', text: prose(r.text) ? r.text : r2.text };
}

// ---- git snapshots (never touch the user's index) ---------------------------------------------

async function snapshot(ctx) {
  if (!ctx.meta.git) return null;
  try {
    return await git.snapshotTree(ctx.meta.git.top);
  } catch (err) {
    ctx.note(`Git anlık görüntüsü alınamadı: ${err.message}`, 'warn');
    return null;
  }
}

/** { diff, stats, to } between tree `from` and now (null without git); emits a full-width diff event. */
async function diffSince(ctx, from, { emit = true } = {}) {
  if (!from) return null;
  const to = await snapshot(ctx);
  if (!to) return null;
  try {
    const r = await git.treeDiff(ctx.meta.git.top, from, to);
    if (emit && r.stats.files) {
      const truncated = r.diff.length > DIFF_EVENT_MAX;
      ctx.emit({
        kind: 'diff', diff: truncated ? r.diff.slice(0, DIFF_EVENT_MAX) : r.diff, stats: r.stats, applicable: false,
        ...(truncated ? { truncated: true } : {}),
      });
    }
    return { ...r, to };
  } catch (err) {
    ctx.note(`Diff alınamadı: ${err.message}`, 'warn');
    return null;
  }
}

// ---- workers ----------------------------------------------------------------------------------

async function workerTurn(ctx, w, opts) {
  const resumable = ctx.canResume(w.lane);
  try {
    return await ctx.turn(w.lane, opts);
  } catch (err) {
    if (!resumable || err.sawOutput || err.name === 'AbortError' || !mayBeStaleSession(err)) throw err;
    ctx.lane(w.lane).sessionId = undefined;
    return ctx.turn(w.lane, { ...opts, resume: false });
  }
}

/** One task on one worker. Resolves a report for the lead; never throws except on abort. */
async function runTask(ctx, w, t) {
  const leadName = shortTitle(ctx.lane('lead')?.title) || 'Yönetici';
  const base = { handle: w.handle, title: w.title, task: t.task };
  try {
    if (w.textOnly) {
      const r = await textCoderTask(ctx, w.lane, {
        goal: ctx.state.goal, task: t.task, files: t.files, permission: ctx.config.permission, leadName,
      });
      return { ...base, ok: true, text: stripEdits(r.text), applied: r.applied, failed: r.failed };
    }
    const r = await workerTurn(ctx, w, {
      prompt: P.leadWorkerTask({ goal: ctx.state.goal, task: t.task, files: t.files, leadName, canRun: w.canRun }),
      permission: ctx.config.permission,
      system: P.workerSystem,
    });
    return { ...base, ok: true, text: r.text };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.code === 'stopped') return { ...base, ok: false, kind: 'stopped', text: 'Görev durduruldu (ajanın turu elle durduruldu).' };
    return { ...base, ok: false, kind: errorKind(err), text: `Hata: ${err.message}` };
  }
}

const BUDGET_TR = { 'free-first': 'ücretsiz öncelikli', 'free-only': 'yalnızca ücretsiz', any: 'serbest' };

/** The automatic team, as shown to the user at the start of a run. */
function teamNote(workers, budget) {
  const tag = (w) => (w.tier === 'free' ? 'ücretsiz' : `${TIER_TR[w.tier] || w.tier}${w.backup ? ', yedek' : ''}`);
  return `**Ekip (otomatik · ${BUDGET_TR[budget] || budget})**\n` +
    workers.map((w) => `- @${w.handle} · ${w.title} _(${tag(w)})_${w.quota ? ` — kota: ${w.quota}` : ''}`).join('\n');
}

// ---- driver -----------------------------------------------------------------------------------
//
// Tasks form a dependency graph: a task starts as soon as everything in its `after` list is done
// and its worker is free (one task per worker at a time); independent tasks run side by side.
// The lead reviews when nothing is left running, or right away when a task failed (while the
// others keep going). Its new tasks join the running graph immediately.

const view = (x) => ({ id: x.id, handle: x.w?.handle || modelRef(x.target.agentId, x.target.model), task: x.task, after: x.after });
const needsLead = (r) => !r.ok || r.failed?.length;
/** What survives in state for a later "devam et". */
const compactReport = (r) => ({
  id: r.id, handle: r.handle, task: clip(r.task, 2000), ok: !!r.ok, skipped: !!r.skipped, secs: r.secs ?? null,
  text: clip(String(r.text || ''), 3000), applied: r.applied || [], failed: r.failed || [],
});

function pauseNote(kind, err) {
  const msg = err.message || String(err);
  if (kind === 'limit') return `Yönetici durdu: ${msg} Yapılan ve yarım kalan işler kaydedildi; limit yenilenince "devam et" yazman yeterli.`;
  if (kind === 'auth') return `Yönetici durdu: ${msg} Oturum açtıktan sonra "devam et" yaz; kaldığı yer kaydedildi.`;
  return `Yönetici geçici bir hata yüzünden durdu (${msg}). Kaldığı yer kaydedildi; biraz sonra "devam et" yaz.`;
}

/** "ücretsiz ajanlar 6 görev · abonelik 1 görev · yönetici 4 tur" */
function costLine(done, leadTurns) {
  const by = new Map();
  for (const r of done) if (r.tier) by.set(r.tier, (by.get(r.tier) || 0) + 1);
  const parts = ['free', 'credit', 'subscription', 'paid'].filter((t) => by.has(t))
    .map((t) => `${t === 'free' ? 'ücretsiz ajanlar' : TIER_TR[t]} ${by.get(t)} görev`);
  if (leadTurns) parts.push(`yönetici ${leadTurns} tur`);
  return parts.length ? `**Maliyet:** ${parts.join(' · ')}` : '';
}

function composeResult(ctx, d, totals, leadTurns) {
  const st = ctx.state;
  const lines = [d?.summary || prose(d?.text) || '(özet yok)'];
  const done = st.log.slice(st.logFrom || 0).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  if (done.length) {
    lines.push('', '**Yapılan işler**');
    for (const r of done) {
      const state = r.ok ? '' : r.skipped ? ' — _çalıştırılmadı_' : ' — _hata_';
      lines.push(`- ${r.id} · **@${r.handle}**${r.secs != null ? ` (${r.secs} sn)` : ''}: ${line(r.task, 140)}${state}`);
    }
  }
  if (totals?.stats.files) {
    const { files, additions, deletions } = totals.stats;
    lines.push('', `**Değişiklikler:** ${files} dosya (+${additions} / −${deletions})`);
  }
  const cost = costLine(done, leadTurns);
  if (cost) lines.push('', cost);
  return lines.join('\n');
}

/**
 * Messages the user writes while the team works (index.js → ctx.listen): the lead gets them in its
 * next turn — at once when it is idle, else right after its current turn. Opened as the activity
 * starts, so nothing written during the quota check or the first plan is lost.
 */
function openMailbox(ctx) {
  if (ctx.leadMail) return ctx.leadMail;
  const mail = { inbox: [], wake: null };
  mail.next = () => new Promise((resolve) => {
    if (mail.inbox.length) resolve({ kind: 'msg' });
    else mail.wake = () => { mail.wake = null; resolve({ kind: 'msg' }); };
  });
  ctx.listen?.({
    accepts: (m) => !m.lane || m.lane === 'lead',
    deliver: (m) => { mail.inbox.push(m.text); mail.wake?.(); },
  });
  ctx.leadMail = mail;
  return mail;
}

/**
 * Every model the lead may use, for the UI (runview: a folded card listing each provider's
 * models; the starting team's are marked).
 */
function catalogEvent({ catalog, parallel, taskMinutes }, workers, budget) {
  const team = new Set(workers.map((w) => modelRef(w.agentId, w.model)));
  return {
    kind: 'catalog', budget: budget || null, parallel, taskMinutes,
    providers: catalog.map((p) => ({
      agentId: p.agentId, name: p.name, own: p.own, copies: p.copies, ...(p.slow ? { slow: true } : {}),
      models: p.models.map((m) => (team.has(m.ref) ? { ...m, team: true } : m)),
    })),
  };
}

/**
 * Lead loop until the lead is done and nothing is left to run. `makePrompt({ catalog, parallel })`
 * builds the first prompt once the model catalog is known.
 */
async function drive(ctx, makePrompt, phaseTitle) {
  const st = ctx.state;
  let maxRounds = ctx.config.steps;
  st.log ||= [];
  st.logFrom = st.log.length;
  st.taskSeq ||= 0;
  const turnsFrom = st.leadTurns || 0;
  const startTree = await snapshot(ctx);
  let reviewTree = startTree;
  ctx.save();

  let workers = workerList(ctx);
  const catalog = await loadCatalog(ctx);
  const parallel = parallelOf(ctx);
  const taskMinutes = taskMinutesOf(ctx);
  ctx.catalog = catalog;
  const firstPrompt = makePrompt({ catalog, parallel, taskMinutes });
  const tasks = new Map();   // id -> { id, n, target: { agentId, model }, prefer, w, task, files, after, status, startedAt }
  const running = new Map(); // id -> promise resolving { kind: 'task', x, report | error }
  const busy = new Set();    // lanes with a running task
  let pending = [];          // reports the lead hasn't seen yet
  let inflight = [];         // reports in the lead review that is running now
  let planned = false;       // the lead answered the first prompt
  let warnings = [];
  let rounds = 0;
  let batches = 0;
  let announce = [];         // tasks of the last decision: the ones that can't start yet get a note
  let leadP = null;          // a lead review in flight (runs while tasks keep going)
  let decision = null;
  let fatal = null;
  const mail = openMailbox(ctx);
  const inbox = mail.inbox;
  let msgP = null;

  // Saved after every change, so a usage limit, an error, a cancel or a restart loses nothing.
  const persist = () => {
    if (!planned) return; // keep what an earlier interrupted loop left for this one
    st.unseen = [...inflight, ...pending].map(compactReport);
    st.open = [...tasks.values()].filter((x) => x.status === 'waiting' || x.status === 'running')
      .map((x) => ({ ...view(x), status: x.status }));
    ctx.save();
  };

  // ---- targets: a task runs on a model ("provider:model"), on any idle lane of that model ------
  const keyOf = (t) => modelRef(t.agentId, t.model);
  const exhausted = (t) => (st.exhausted || []).some((k) => k === keyOf(t) || k === t.agentId); // bare id: older runs
  const tierOf = (t) => findModel(catalog, t)?.model.tier || workers.find((w) => w.agentId === t.agentId && w.model === t.model)?.tier || modelTier(t.agentId, null);
  const labelOf = (t) => {
    const f = findModel(catalog, t);
    if (f) return `${f.provider.name} · ${f.model.label}`;
    return workers.find((w) => w.agentId === t.agentId && w.model === t.model)?.title || keyOf(t);
  };
  const lanesOf = (agentId) => ctx.lanes('worker').filter((l) => l.agentId === agentId);

  /** Where the lead's "agent" points: a lane's handle, "provider:model" or a provider name. */
  const resolveTarget = (name) => {
    const w = resolveWorker(workers, name);
    if (w) return { target: { agentId: w.agentId, model: w.model }, prefer: w.lane };
    const ref = parseRef(name, catalog.map((p) => p.agentId));
    const f = ref && findModel(catalog, ref);
    if (f) return { target: { agentId: f.provider.agentId, model: f.model.id }, prefer: null };
    return null;
  };

  /** An idle lane for target `t` (the preferred one first), opening a new copy when allowed. */
  const laneFor = (t, prefer) => {
    const same = workers.filter((w) => w.agentId === t.agentId && w.model === t.model && !busy.has(w.lane));
    const pick = same.find((w) => w.lane === prefer) || same[0];
    if (pick) return pick;
    if (lanesOf(t.agentId).length < copiesOf(t.agentId) && ctx.lanes('worker').length < LANES_MAX) {
      // a new copy shows up as its own card in the UI (lane event); no note needed
      const l = ctx.addLane({ agentId: t.agentId, model: t.model, role: 'worker', title: labelOf(t), tier: tierOf(t) });
      workers = workerList(ctx);
      return workers.find((x) => x.lane === l.lane);
    }
    // Every copy of the agent is open (one Gemini web window…): an idle copy on another model
    // switches to this one, in a new session. Busy copies make the task wait for one.
    const idle = workers.find((w) => w.agentId === t.agentId && !busy.has(w.lane) && waitingFor(w) === 0);
    if (!idle) return null;
    const l = ctx.lane(idle.lane);
    Object.assign(l, { model: t.model, title: labelOf(t), tier: tierOf(t), sessionId: undefined });
    st.handles = (st.handles || []).filter((x) => x.lane !== l.lane);
    ctx.emit({ kind: 'lane', lane: l.lane, agentId: l.agentId, model: l.model, role: l.role, title: l.title, tier: l.tier });
    workers = workerList(ctx);
    const w = workers.find((x) => x.lane === l.lane);
    ctx.note(`@${w.handle}: ${idle.title} yerine ${w.title} ile çalışacak.`);
    return w;
  };
  /** Waiting tasks the lead gave to this very lane (it keeps its model for them). */
  const waitingFor = (w) => [...tasks.values()].filter((x) => x.status === 'waiting' && x.prefer === w.lane).length;

  // Another target for a task its model couldn't do: the same tier first (a free task stays free),
  // models already in the team before new ones, never a model that failed it or ran out.
  const alternative = (x) => {
    const tried = x.tried || new Set();
    const tier = tierOf(x.target);
    const ok = (t) => !tried.has(keyOf(t)) && !exhausted(t) && keyOf(t) !== keyOf(x.target) &&
      tierAllowed(tierOf(t), ctx.config.budget || 'any') && t.agentId !== x.target.agentId;
    const rank = (t) => (tierOf(t) === tier ? 0 : tierOf(t) === 'free' ? 2 : tierOf(t) === 'credit' ? 4 : 6) + (isSlow(t.agentId) ? 1 : 0);
    const team = workers.map((w) => ({ agentId: w.agentId, model: w.model })).filter(ok);
    const more = catalog.flatMap((p) => p.models.filter((m) => !m.backup).map((m) => ({ agentId: p.agentId, model: m.id }))).filter(ok);
    return [...team.sort((a, b) => rank(a) - rank(b)), ...more.sort((a, b) => rank(a) - rank(b))][0] || null;
  };

  const markExhausted = (x) => {
    const k = keyOf(x.target);
    if ((st.exhausted ||= []).includes(k)) return;
    st.exhausted.push(k);
    for (const w of workers) if (keyOf(w) === k) w.exhausted = true;
    warnings.push(`${k} limitine ulaştı ya da oturumu kapandı; bu çalışmada ona görev verme (verirsen Ortak başka bir modele yönlendirir).`);
  };

  /** A task that failed because of its model (limit, sign-in, network, size) moves to another model. */
  const handoff = (x, r) => {
    if (r.ok || r.skipped || !HANDOFF_KINDS.has(r.kind)) return false;
    if (r.kind === 'limit' || r.kind === 'auth') markExhausted(x);
    (x.tried ||= new Set()).add(keyOf(x.target));
    if (x.tried.size > HANDOFF_MAX) return false;
    const alt = alternative(x);
    if (!alt) return false;
    recordTask(keyOf(x.target), { ok: false, secs: secsOf(x), kind: r.kind });
    ctx.note(`${x.id}: ${keyOf(x.target)} ${KIND_TR[r.kind]}; görev ${keyOf(alt)} modeline devredildi.`, 'warn');
    taskEvent(x, 'moved');
    if (r.kind === 'timeout' && !x.retold) { // the stopped model may have left half-done edits
      x.retold = true;
      x.task += `\n\nNot: Bu görevi önce başka bir model denedi ama ${taskMinutes} dakikada bitiremedi; yarım kalmış değişiklikler olabilir. Önce ilgili dosyaların şu anki hâline bak, sonra görevi tamamla.`;
    }
    x.target = alt;
    x.prefer = null;
    x.status = 'waiting';
    x.startedAt = 0;
    persist();
    return true;
  };

  /** The UI draws one card per task (runview: 'task' events). */
  const taskEvent = (x, state) => ctx.emit({ kind: 'task', id: x.id, lane: x.w?.lane, state, title: line(x.task, 160) });

  const secsOf = (x) => (x.startedAt ? Math.round((Date.now() - x.startedAt) / 1000) : null);

  const finishTask = (x, r) => {
    if (x.cancelled) { // the lead cancelled it: it knows, no report needed
      x.status = 'skipped';
      st.log.push({ id: x.id, n: x.n, handle: x.w?.handle || keyOf(x.target), tier: tierOf(x.target), task: clip(x.task, 2000), ok: false, skipped: true, secs: null });
      if (x.w) taskEvent(x, 'cancelled');
      persist();
      return;
    }
    x.status = r.ok ? 'done' : r.skipped ? 'skipped' : 'failed';
    const secs = secsOf(x);
    if (!r.skipped && x.w) recordTask(keyOf(x.target), { ok: !!r.ok, secs, ...(r.kind ? { kind: r.kind } : {}) });
    const who = x.w || { handle: keyOf(x.target), title: labelOf(x.target), tier: tierOf(x.target) };
    const report = { ...r, id: x.id, handle: who.handle, title: who.title, task: x.task, secs };
    pending.push(report);
    st.log.push({ id: x.id, n: x.n, handle: who.handle, tier: who.tier, task: clip(x.task, 2000), ok: !!r.ok, skipped: !!r.skipped, secs });
    if (x.w) taskEvent(x, x.status);
    if (!r.ok) ctx.note(`${x.id} · @${who.handle}: ${r.skipped ? r.text : 'görev başarısız oldu.'}`, 'warn');
    persist();
  };

  /** The lead's "cancel": waiting tasks are dropped, running ones stopped (their lane's turn). */
  const cancelTasks = (ids) => {
    const done = [];
    for (const id of ids) {
      const x = tasks.get(id);
      if (!x || (x.status !== 'waiting' && x.status !== 'running') || x.cancelled) continue;
      x.cancelled = true;
      done.push(id);
      if (x.status === 'waiting') finishTask(x, { ok: false, skipped: true });
      else ctx.stopLane?.(x.w.lane);
    }
    if (done.length) ctx.note(`Yönetici ${done.join(', ')} görev${done.length > 1 ? 'lerini' : 'ini'} iptal etti.`, 'warn');
  };

  const accept = (d) => {
    decision = d;
    if (d.cancel?.length) cancelTasks(d.cancel);
    if (!d.tasks.length) return;
    if (rounds >= maxRounds) {
      ctx.note(`Denetim sınırına (${maxRounds}) ulaşıldı; yöneticinin yeni görevleri çalıştırılmadı.`, 'warn');
      return;
    }
    const added = [];
    for (const t of d.tasks.slice(0, MAX_TASKS_PER_REPLY)) {
      if (tasks.size >= MAX_TASKS_TOTAL) { warnings.push(`Görev sınırına (${MAX_TASKS_TOTAL}) ulaşıldı; fazlası çalıştırılmadı.`); break; }
      let id = t.id || `t${++st.taskSeq}`;
      while (tasks.has(id)) id = `t${++st.taskSeq}`;
      const r = resolveTarget(t.agent);
      if (!r) {
        const names = workers.map((x) => x.handle).join(', ');
        warnings.push(`${id}: "${t.agent || '(boş)'}" ne bir ekip üyesi (${names}) ne de katalogdaki bir model; görev çalıştırılmadı. Katalogdaki adı "sağlayıcı:model" biçiminde aynen yaz.`);
        ctx.note(`${id}: "${t.agent || '(boş)'}" bulunamadı; görev çalıştırılmadı.`, 'warn');
        continue;
      }
      const x = { id, n: tasks.size, target: r.target, prefer: r.prefer, w: null, task: t.task, files: t.files, after: t.after, status: 'waiting', startedAt: 0 };
      if (exhausted(x.target)) {
        const alt = alternative(x);
        if (alt) {
          ctx.note(`${id}: ${keyOf(x.target)} limitine ulaşmıştı; görev ${keyOf(alt)} modeline verildi.`, 'warn');
          x.target = alt;
          x.prefer = null;
        }
      }
      tasks.set(id, x);
      added.push(id);
    }
    if (d.tasks.length > MAX_TASKS_PER_REPLY) warnings.push(`Bir cevapta ${d.tasks.length} görev verildi; ilk ${MAX_TASKS_PER_REPLY} görev alındı.`);
    for (const id of added) {
      const x = tasks.get(id);
      const unknown = x.after.filter((dep) => dep === id || !tasks.has(dep));
      if (unknown.length) {
        warnings.push(`${id}: bilinmeyen bağımlılık yok sayıldı (${unknown.join(', ')}).`);
        x.after = x.after.filter((dep) => dep !== id && tasks.has(dep));
      }
    }
    if (!added.length) return;
    ctx.phase('uygulama', `Uygulama ${++batches}`);
    announce.push(...added);
    persist();
  };

  // a started task shows as a card of its own; the ones that wait are listed once, with why
  const queuedNote = (ids) => {
    const waiting = ids.map((id) => tasks.get(id)).filter((x) => x?.status === 'waiting');
    if (!waiting.length) return;
    ctx.note(`**Sırada** (aynı anda en fazla ${parallel} görev)\n` + waiting.map((x) => {
      const deps = x.after.filter((id) => tasks.get(id)?.status !== 'done');
      return `- **${x.id} · ${keyOf(x.target)}** _(${deps.length ? `${deps.join(', ')} bitince` : 'sıra gelince'})_: ${line(x.task, 200)}`;
    }).join('\n'));
  };

  const start = (x, w) => {
    x.w = w;
    x.status = 'running';
    x.startedAt = Date.now();
    busy.add(w.lane);
    taskEvent(x, 'running');
    if (taskMinutes) {
      // past the limit the lane's turn is stopped (again every few seconds: between two turns of
      // a text-only worker nothing runs to stop) and the task goes to another model
      x.timer = setTimeout(() => {
        x.timedOut = true;
        const kill = () => ctx.stopLane?.(w.lane);
        kill();
        x.killer = setInterval(kill, 2000);
      }, taskMinutes * 60_000);
    }
    running.set(x.id, runTask(ctx, w, x).then(
      (report) => ({ kind: 'task', x, report }),
      (error) => ({ kind: 'task', x, error })));
    persist();
  };

  const startReady = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const x of tasks.values()) {
        if (x.status !== 'waiting') continue;
        const deps = x.after.map((id) => tasks.get(id));
        const bad = deps.find((dep) => dep.status === 'failed' || dep.status === 'skipped');
        if (bad) {
          finishTask(x, { ok: false, skipped: true, text: `Çalıştırılmadı: bağlı olduğu ${bad.id} ${bad.cancelled ? 'iptal edildi' : 'başarısız oldu'}.` });
          changed = true;
        } else if (deps.every((dep) => dep.status === 'done') && running.size < parallel) {
          const w = laneFor(x.target, x.prefer);
          if (w) { start(x, w); changed = true; }
        }
      }
    }
    if (!running.size) { // still waiting with nothing running: a dependency cycle or no lane at all
      for (const x of tasks.values()) {
        if (x.status !== 'waiting') continue;
        const blocked = x.after.some((id) => tasks.get(id).status !== 'done');
        finishTask(x, { ok: false, skipped: true, text: blocked ? 'Çalıştırılmadı: bağımlılıkları birbirini bekliyor (döngü).' : `Çalıştırılmadı: ${keyOf(x.target)} için şerit açılamadı.` });
      }
    }
  };

  const review = (messages = []) => {
    rounds++;
    const reports = pending;
    const warns = warnings;
    inflight = pending;
    pending = [];
    warnings = [];
    const runningNow = [...tasks.values()].filter((x) => x.status === 'running').map(view);
    const waitingNow = [...tasks.values()].filter((x) => x.status === 'waiting').map(view);
    ctx.phase('denetim', `${messages.length ? 'Yeni mesaj' : `Denetim ${rounds}`}${runningNow.length ? ` · ${runningNow.length} görev sürüyor` : ''}`);
    return (async () => {
      const d = await diffSince(ctx, reviewTree);
      if (d) reviewTree = d.to;
      return {
        kind: 'lead',
        decision: await askLead(ctx, P.leadReport({
          round: rounds, maxRounds, reports, running: runningNow, waiting: waitingNow,
          // per-file view sized for the lead's model (binary/lockfiles summarized, cut files named)
          diff: d ? reviewDiff(d.diff, Math.floor(promptBudget(ctx.adapterOf('lead')) * 0.6)) : null,
          warnings: warns, goal: st.goal, resumed: ctx.canResume('lead'), permission: ctx.config.permission, messages,
        })),
      };
    })().catch((error) => ({ kind: 'lead', error }));
  };

  try {
    ctx.phase('plan', phaseTitle);
    const first = await askLead(ctx, firstPrompt);
    planned = true;
    st.interrupted = null; // whatever an earlier loop left was in firstPrompt
    accept(first);
    persist();
    for (;;) {
      if (!fatal) startReady();
      if (announce.length) queuedNote(announce.splice(0));
      if (!leadP && !fatal) {
        if (inbox.length) {
          // the user's message gets a turn of its own (and the lead one more round after it)
          maxRounds = Math.max(maxRounds, rounds + 2);
          leadP = review(inbox.splice(0));
        } else {
          // keep the last review for when everything has stopped
          const urgent = pending.some(needsLead) && rounds < maxRounds - 1;
          if (pending.length && rounds < maxRounds && (!running.size || urgent)) leadP = review();
        }
      }
      if (!leadP && !running.size) break;
      // while the lead thinks, a new message waits for its answer
      if (!leadP && !fatal) msgP ||= mail.next();
      const next = await Promise.race([...running.values(), leadP, leadP || fatal ? null : msgP].filter(Boolean));
      if (next.kind === 'msg') { msgP = null; continue; }
      if (next.kind === 'task') {
        const x = next.x;
        running.delete(x.id);
        busy.delete(x.w.lane);
        clearTimeout(x.timer);
        clearInterval(x.killer);
        if (next.error) throw next.error; // abort: the other tasks see the same signal
        if (x.timedOut && next.report.kind === 'stopped') {
          next.report.kind = 'timeout';
          next.report.text = `Süre sınırı (${taskMinutes} dk) aşıldı; görev durduruldu.`;
        }
        x.timedOut = false;
        if (!handoff(next.x, next.report)) finishTask(next.x, next.report);
      } else {
        leadP = null;
        if (next.error?.name === 'AbortError') throw next.error;
        if (next.error) { // the lead can't go on: let running tasks finish, start nothing new
          fatal ||= next.error;
          pending = [...inflight, ...pending];
          inflight = [];
          persist();
          ctx.note(`Yönetici hata verdi (${next.error.message}); süren görevler bitince çalışma duracak.`, 'error');
        } else {
          inflight = [];
          accept(next.decision);
          persist();
        }
      }
    }
    if (fatal) throw fatal;
  } catch (err) {
    ctx.listen?.(null);
    // messages the lead never got: they open its next turn (followUp)
    if (inbox.length) st.unread = [...(st.unread || []), ...inbox.splice(0)];
    // Remember where we stopped: the next message continues from here (see followUp).
    if (planned) { pending = [...inflight, ...pending]; inflight = []; persist(); }
    const kind = err?.name === 'AbortError' ? 'abort' : errorKind(err);
    st.interrupted = { reason: kind === 'abort' ? 'kullanıcı iptal etti' : (err?.message || String(err)), kind, at: Date.now() };
    ctx.save();
    if (PAUSE_KINDS.has(kind)) { ctx.note(pauseNote(kind, err), 'warn'); return 'paused'; }
    if (kind !== 'abort') ctx.note('Kaldığı yer kaydedildi; "devam et" yazarak sürdürebilirsin.', 'info');
    throw err;
  } finally {
    for (const x of tasks.values()) { clearTimeout(x.timer); clearInterval(x.killer); }
  }
  ctx.listen?.(null);
  st.unseen = [];
  st.open = [];
  if (pending.length) ctx.note('Denetim sınırına ulaşıldı; son görevlerin raporları yöneticiye gösterilemedi.', 'warn');
  const totals = await diffSince(ctx, startTree, { emit: false });
  ctx.emit({ kind: 'result', lane: 'lead', text: composeResult(ctx, decision, totals, (st.leadTurns || 0) - turnsFrom) });
  st.summary = clip(decision?.summary || prose(decision?.text), 4000);
  ctx.save();
}

export default {
  async start(ctx) {
    const st = ctx.state;
    st.goal = ctx.config.prompt;
    openMailbox(ctx);
    if (!ctx.meta.git) ctx.note('Proje bir git deposu değil; yönetici değişiklikleri diff olarak göremeyecek (dosyaları okuyarak denetler).', 'warn');
    await refreshQuota(ctx);
    const workers = teamView(ctx, workerList(ctx));
    await drive(ctx, (more) => {
      // the catalog card lists every model (the team's marked); without one, the team alone
      if (more.catalog.length) ctx.emit(catalogEvent(more, workers, ctx.config.budget));
      else if (ctx.config.autoTeam) ctx.note(teamNote(workers, ctx.config.budget));
      return P.leadStart({
        goal: st.goal, workers, readOnly: ctx.config.permission === 'read-only', maxSteps: ctx.config.steps, budget: ctx.config.budget, permission: ctx.config.permission, ...more,
      });
    }, 'Planlama');
    return 'waiting';
  },

  checkFollowUp(meta, { lane }) {
    const l = lane && meta.lanes.find((x) => x.lane === lane);
    if (lane && !l) throw new HttpError(400, `Bu çalışmada böyle bir şerit yok: ${lane}`);
  },

  /**
   * Follow-up: by default the lead takes the message and runs the team again. Addressed to a
   * worker lane, that worker does it directly (no lead review).
   */
  async followUp(ctx, { text, lane }) {
    const st = ctx.state;
    st.goal ||= ctx.config.prompt;
    const workers = workerList(ctx);
    const w = lane && lane !== 'lead' ? workers.find((x) => x.lane === lane) : null;
    if (w) {
      ctx.phase('ek-istek', `@${w.handle} · doğrudan istek`);
      const before = await snapshot(ctx);
      const r = await runTask(ctx, w, { task: text, files: [] });
      await diffSince(ctx, before);
      ctx.emit({ kind: 'result', lane: w.lane, text: r.text });
      return 'waiting';
    }
    openMailbox(ctx);
    if (st.unread?.length) { // written while the last loop ran, never seen by the lead
      text = [...st.unread, text].join('\n\n');
      st.unread = [];
    }
    const resumed = ctx.canResume('lead');
    await refreshQuota(ctx);
    const team = teamView(ctx, workerList(ctx));
    const unseen = st.unseen || [];
    const open = st.open || [];
    if (st.interrupted || unseen.length || open.length) {
      await drive(ctx, (more) => P.leadResume({
        text, interrupted: st.interrupted, unseen, open, log: st.log, workers: team, maxSteps: ctx.config.steps, goal: st.goal, resumed, budget: ctx.config.budget, permission: ctx.config.permission, ...more,
      }), 'Yönetici · kaldığı yerden');
      return 'waiting';
    }
    await drive(ctx, (more) => P.leadUser({
      text, workers: team, maxSteps: ctx.config.steps, goal: st.goal, resumed, log: st.log, budget: ctx.config.budget, permission: ctx.config.permission, ...more,
    }), 'Yönetici · yeni mesaj');
    return 'waiting';
  },

  // Interrupted by a restart: the next message continues with the lead.
  resumable: (meta) => !!meta.state?.goal,
};

export const _internals = { modelWord, normalizeDecision, prose };

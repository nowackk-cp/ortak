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
import { getLimits } from '../limits.js';
import { modelTier, TIER_TR } from '../tiers.js';

const MAX_TASKS_PER_REPLY = 12; // tasks taken from one lead answer
const MAX_TASKS_TOTAL = 40;     // per lead loop
// Lead failures after which the run waits for "devam et" instead of ending in an error.
const PAUSE_KINDS = new Set(['limit', 'transient', 'auth']);
const DIFF_EVENT_MAX = 1_500_000;
// A failed task is handed to another worker when the failure is about that agent, not the task.
const HANDOFF_KINDS = new Set(['limit', 'transient', 'auth', 'toolarge']);
const HANDOFF_MAX = 2;          // other workers tried per task
const QUOTA_WAIT_MS = 3000;     // how long a run start waits for the quota overview
const KIND_TR = { limit: 'limiti doldu', transient: 'geçici bir hata verdi', auth: 'oturumu kapalı', toolarge: 'isteği kaldıramadı' };

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
  const used = new Set();
  const out = ctx.lanes('worker').map((l) => {
    let handle = saved.get(l.lane);
    if (!handle) {
      const word = modelWord(l);
      handle = used.has(word) ? `${l.agentId}-${word}` : word;
      for (let n = 2; used.has(handle); n++) handle = `${word}-${n}`;
    }
    used.add(handle);
    const caps = ctx.adapterOf(l.lane)?.capabilities || {};
    const edit = !!caps.edit;
    const tier = l.tier || modelTier(l.agentId, null);
    return {
      lane: l.lane, agentId: l.agentId, model: l.model, title: shortTitle(l.title), handle,
      tier,
      backup: ctx.config.budget === 'free-first' && tier !== 'free',
      quota: st.quota?.[l.agentId] || null,
      exhausted: (st.exhausted || []).includes(l.lane),
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
  if (!Array.isArray(arr) && !done) return null;
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
  return { tasks, done: done && !tasks.length, summary: firstStr(obj.summary, obj.ozet, obj['özet']) };
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
    const recap = P.leadRecap({ goal: ctx.state.goal, workers: teamView(ctx, workerList(ctx)), log: ctx.state.log, budget: ctx.config.budget });
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

const view = (x) => ({ id: x.id, handle: x.w.handle, task: x.task, after: x.after });
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
  const parts = ['free', 'subscription', 'paid'].filter((t) => by.has(t))
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

/** Lead loop from `firstPrompt` until the lead is done and nothing is left to run. */
async function drive(ctx, firstPrompt, phaseTitle) {
  const st = ctx.state;
  const maxRounds = ctx.config.steps;
  st.log ||= [];
  st.logFrom = st.log.length;
  st.taskSeq ||= 0;
  const turnsFrom = st.leadTurns || 0;
  const startTree = await snapshot(ctx);
  let reviewTree = startTree;
  ctx.save();

  const workers = workerList(ctx);
  const tasks = new Map();   // id -> { id, w, task, files, after, status, startedAt }
  const running = new Map(); // id -> promise resolving { kind: 'task', x, report | error }
  const busy = new Set();    // lanes with a running task
  let pending = [];          // reports the lead hasn't seen yet
  let inflight = [];         // reports in the lead review that is running now
  let planned = false;       // the lead answered the first prompt
  let warnings = [];
  let rounds = 0;
  let batches = 0;
  let leadP = null;          // a lead review in flight (runs while tasks keep going)
  let decision = null;
  let fatal = null;

  // Saved after every change, so a usage limit, an error, a cancel or a restart loses nothing.
  const persist = () => {
    if (!planned) return; // keep what an earlier interrupted loop left for this one
    st.unseen = [...inflight, ...pending].map(compactReport);
    st.open = [...tasks.values()].filter((x) => x.status === 'waiting' || x.status === 'running')
      .map((x) => ({ ...view(x), status: x.status }));
    ctx.save();
  };

  // Another worker for a task `w` couldn't do: same cost tier first (a free task stays free), then
  // free ones, idle before busy; a subscription backup only when no free worker is left.
  const alternative = (w, tried) => {
    const out = new Set(st.exhausted || []);
    const rank = (c) => (c.tier === w.tier ? 0 : c.tier === 'free' ? 2 : 4) + (busy.has(c.lane) ? 1 : 0);
    return workers
      .filter((c) => c.lane !== w.lane && !tried.has(c.lane) && !out.has(c.lane))
      .filter((c) => ctx.config.budget !== 'free-only' || c.tier === 'free')
      .sort((a, b) => rank(a) - rank(b))[0] || null;
  };

  const markExhausted = (w) => {
    if ((st.exhausted ||= []).includes(w.lane)) return;
    st.exhausted.push(w.lane);
    w.exhausted = true;
    warnings.push(`@${w.handle} limitine ulaştı ya da oturumu kapandı; bu çalışmada ona görev verme (verirsen Ortak başka bir ajana yönlendirir).`);
  };

  /** A task that failed because of its agent (limit, sign-in, network, size) moves to another worker. */
  const handoff = (x, r) => {
    if (r.ok || r.skipped || !HANDOFF_KINDS.has(r.kind)) return false;
    if (r.kind === 'limit' || r.kind === 'auth') markExhausted(x.w);
    (x.tried ||= new Set()).add(x.w.lane);
    if (x.tried.size > HANDOFF_MAX) return false;
    const alt = alternative(x.w, x.tried);
    if (!alt) return false;
    ctx.note(`${x.id}: @${x.w.handle} ${KIND_TR[r.kind]}; görev @${alt.handle} ajanına devredildi.`, 'warn');
    x.w = alt;
    x.status = 'waiting';
    x.startedAt = 0;
    persist();
    return true;
  };

  const finishTask = (x, r) => {
    x.status = r.ok ? 'done' : r.skipped ? 'skipped' : 'failed';
    const secs = x.startedAt ? Math.round((Date.now() - x.startedAt) / 1000) : null;
    const report = { ...r, id: x.id, handle: x.w.handle, title: x.w.title, task: x.task, secs };
    pending.push(report);
    st.log.push({ id: x.id, n: x.n, handle: x.w.handle, tier: x.w.tier, task: clip(x.task, 2000), ok: !!r.ok, skipped: !!r.skipped, secs });
    if (!r.ok) ctx.note(`${x.id} · @${x.w.handle}: ${r.skipped ? r.text : 'görev başarısız oldu.'}`, 'warn');
    persist();
  };

  const accept = (d) => {
    decision = d;
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
      let w = resolveWorker(workers, t.agent);
      if (!w) {
        const names = workers.map((x) => x.handle).join(', ');
        warnings.push(`${id}: "${t.agent || '(boş)'}" adında bir ajan yok (geçerli adlar: ${names}); görev çalıştırılmadı.`);
        ctx.note(`${id}: "${t.agent || '(boş)'}" adında bir ajan yok; görev çalıştırılmadı.`, 'warn');
        continue;
      }
      if ((st.exhausted || []).includes(w.lane)) {
        const alt = alternative(w, new Set());
        if (alt) {
          ctx.note(`${id}: @${w.handle} limitine ulaşmıştı; görev @${alt.handle} ajanına verildi.`, 'warn');
          w = alt;
        }
      }
      tasks.set(id, { id, n: tasks.size, w, task: t.task, files: t.files, after: t.after, status: 'waiting', startedAt: 0 });
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
    // How each task will start: now, after its dependencies, or when its worker is free.
    const claimed = new Set([...tasks.values()].filter((x) => x.status === 'running' || (x.status === 'waiting' && !added.includes(x.id))).map((x) => x.w.lane));
    ctx.note('**Görevler** — bağımsız olanlar aynı anda çalışır\n' + added.map((id) => {
      const x = tasks.get(id);
      let when = 'hemen';
      if (x.after.length) when = `${x.after.join(', ')} bitince`;
      else if (claimed.has(x.w.lane)) when = `@${x.w.handle} boşalınca`;
      claimed.add(x.w.lane);
      return `- **${id} · @${x.w.handle}** _(${when})_ · ${x.w.title}: ${line(x.task, 260)}`;
    }).join('\n'));
    persist();
  };

  const start = (x) => {
    x.status = 'running';
    x.startedAt = Date.now();
    busy.add(x.w.lane);
    running.set(x.id, runTask(ctx, x.w, x).then(
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
          finishTask(x, { ok: false, skipped: true, text: `Çalıştırılmadı: bağlı olduğu ${bad.id} başarısız oldu.` });
          changed = true;
        } else if (deps.every((dep) => dep.status === 'done') && !busy.has(x.w.lane)) {
          start(x);
        }
      }
    }
    if (!running.size) { // still waiting with nothing running: a dependency cycle
      for (const x of tasks.values()) {
        if (x.status === 'waiting') finishTask(x, { ok: false, skipped: true, text: 'Çalıştırılmadı: bağımlılıkları birbirini bekliyor (döngü).' });
      }
    }
  };

  const review = () => {
    rounds++;
    const reports = pending;
    const warns = warnings;
    inflight = pending;
    pending = [];
    warnings = [];
    const runningNow = [...tasks.values()].filter((x) => x.status === 'running').map(view);
    const waitingNow = [...tasks.values()].filter((x) => x.status === 'waiting').map(view);
    ctx.phase('denetim', `Denetim ${rounds}${runningNow.length ? ` · ${runningNow.length} görev sürüyor` : ''}`);
    return (async () => {
      const d = await diffSince(ctx, reviewTree);
      if (d) reviewTree = d.to;
      return {
        kind: 'lead',
        decision: await askLead(ctx, P.leadReport({
          round: rounds, maxRounds, reports, running: runningNow, waiting: waitingNow,
          // per-file view sized for the lead's model (binary/lockfiles summarized, cut files named)
          diff: d ? reviewDiff(d.diff, Math.floor(promptBudget(ctx.adapterOf('lead')) * 0.6)) : null,
          warnings: warns, goal: st.goal, resumed: ctx.canResume('lead'),
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
      if (!leadP && !fatal) {
        // keep the last review for when everything has stopped
        const urgent = pending.some(needsLead) && rounds < maxRounds - 1;
        if (pending.length && rounds < maxRounds && (!running.size || urgent)) leadP = review();
      }
      if (!leadP && !running.size) break;
      const next = await Promise.race([...running.values(), leadP].filter(Boolean));
      if (next.kind === 'task') {
        running.delete(next.x.id);
        busy.delete(next.x.w.lane);
        if (next.error) throw next.error; // abort: the other tasks see the same signal
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
    // Remember where we stopped: the next message continues from here (see followUp).
    if (planned) { pending = [...inflight, ...pending]; inflight = []; persist(); }
    const kind = err?.name === 'AbortError' ? 'abort' : errorKind(err);
    st.interrupted = { reason: kind === 'abort' ? 'kullanıcı iptal etti' : (err?.message || String(err)), kind, at: Date.now() };
    ctx.save();
    if (PAUSE_KINDS.has(kind)) { ctx.note(pauseNote(kind, err), 'warn'); return 'paused'; }
    if (kind !== 'abort') ctx.note('Kaldığı yer kaydedildi; "devam et" yazarak sürdürebilirsin.', 'info');
    throw err;
  }
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
    if (!ctx.meta.git) ctx.note('Proje bir git deposu değil; yönetici değişiklikleri diff olarak göremeyecek (dosyaları okuyarak denetler).', 'warn');
    await refreshQuota(ctx);
    const workers = teamView(ctx, workerList(ctx));
    if (ctx.config.autoTeam) ctx.note(teamNote(workers, ctx.config.budget));
    await drive(ctx, P.leadStart({
      goal: st.goal, workers, readOnly: ctx.config.permission === 'read-only', maxSteps: ctx.config.steps, budget: ctx.config.budget,
    }), 'Planlama');
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
    const resumed = ctx.canResume('lead');
    await refreshQuota(ctx);
    const team = teamView(ctx, workerList(ctx));
    const unseen = st.unseen || [];
    const open = st.open || [];
    if (st.interrupted || unseen.length || open.length) {
      await drive(ctx, P.leadResume({
        text, interrupted: st.interrupted, unseen, open, log: st.log, workers: team, maxSteps: ctx.config.steps, goal: st.goal, resumed, budget: ctx.config.budget,
      }), 'Yönetici · kaldığı yerden');
      return 'waiting';
    }
    await drive(ctx, P.leadUser({
      text, workers: team, maxSteps: ctx.config.steps, goal: st.goal, resumed, log: st.log, budget: ctx.config.budget,
    }), 'Yönetici · yeni mesaj');
    return 'waiting';
  },

  // Interrupted by a restart: the next message continues with the lead.
  resumable: (meta) => !!meta.state?.goal,
};

export const _internals = { modelWord, normalizeDecision, prose };

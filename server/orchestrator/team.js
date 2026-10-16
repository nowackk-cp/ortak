// team (Takım): Plan (planner) -> Uygulama (steps in order, round-robin over workers) ->
// İnceleme (reviewer) <-> Düzeltme (up to `fixRounds` rounds) -> Sonuç.
//
// The planner and the reviewer only read; agents without file tools of their own (Gemini web,
// Groq, OpenRouter, EVREN…) get Ortak's read-only hands (textcoder.work) so they can open the
// files a diff doesn't show. The reviewer sees a per-file, budgeted view of the changes
// (diffview.js) sized for its model, and answers with a "KARAR: ONAY / DÜZELTME" line.
//
// Every stage is saved in state (`stage`, `summaries`, `reviews`, `fixes`), so a usage limit, an
// error, a cancel or a server restart loses nothing: the next message ("devam et") continues from
// where it stopped. "devam et" after a review that still found problems runs more fix rounds.
import * as git from '../git.js';
import * as P from './prompts.js';
import { work } from './textcoder.js';
import { HttpError, clip, clipTail, makeTitle } from '../util.js';
import { balancedObjects, tryParse } from './json.js';
import { errorKind, mayBeStaleSession } from '../errors.js';
import { changedFiles, promptBudget, reviewDiff, splitDiff } from './diffview.js';

const MAX_STEPS = 6;
export const DEFAULT_FIX_ROUNDS = 3;
const DIFF_EVENT_MAX = 1_500_000;
const REVIEW_KEEP = 12_000;   // reviewer answer kept in state (issues for the fixer, recap for a fresh reviewer)
// Failures after which the run waits for "devam et" (state saved) instead of ending in an error.
const PAUSE_KINDS = new Set(['limit', 'transient', 'auth']);
// Failures another agent may not have: a step goes to the next worker.
const HANDOFF_KINDS = new Set(['limit', 'transient', 'auth', 'toolarge']);
// Below this prompt budget a reviewer starts a fresh session each round: resending its whole
// history (first review + every file it read) costs more than a compact recap.
const RESUME_BUDGET_MIN = 40_000;
const SMALL_LISTING = 150;    // project file list for tight-budget agents

// ---- plan parsing -----------------------------------------------------------------------------

const firstStr = (...vals) => vals.find((v) => typeof v === 'string' && v.trim())?.trim() || '';

function normalizeSteps(obj) {
  const arr = Array.isArray(obj) ? obj : (obj?.steps ?? obj?.plan?.steps ?? obj?.plan ?? obj?.adimlar ?? obj?.['adımlar']);
  if (!Array.isArray(arr)) return null;
  return arr.map((s) => {
    if (typeof s === 'string' && s.trim()) return { title: s.trim().slice(0, 160), details: s.trim() };
    if (!s || typeof s !== 'object') return null;
    const title = firstStr(s.title, s.name, s.baslik, s['başlık'], s.step, s.summary);
    const details = firstStr(s.details, s.description, s.detail, s.detay, s['açıklama'], s.aciklama, s.desc, s.instructions);
    if (!title && !details) return null;
    return { title: (title || details).slice(0, 160), details };
  }).filter(Boolean);
}

/** Robustly extract {"steps":[...]} from the planner's answer; falls back to a single step. */
export function parsePlan(text, goal) {
  const src = String(text || '').slice(0, 200_000);
  const blocks = [...src.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const candidates = [
    ...blocks.filter((b) => b.lang === 'json').reverse().map((b) => b.body),
    ...blocks.filter((b) => b.lang !== 'json').reverse().map((b) => b.body),
    ...balancedObjects(src).filter((s) => s.includes('steps')).reverse(),
  ];
  for (const c of candidates) {
    const steps = normalizeSteps(tryParse(c));
    if (steps?.length) {
      const warning = steps.length > MAX_STEPS ? `Plan ${steps.length} adım içeriyordu; ilk ${MAX_STEPS} adım uygulanacak.` : null;
      return { steps: steps.slice(0, MAX_STEPS), warning };
    }
  }
  return {
    steps: [{ title: 'Görevi uygula', details: goal }],
    warning: 'Planlayıcının cevabında geçerli bir JSON plan bulunamadı; görev tek adım olarak uygulanacak.',
  };
}

export function extractSummary(text) {
  const re = /^[\s>*_#-]*(?:ÖZET|OZET|SUMMARY)[\s*_]*[:：][\s*_]*(.+)$/gim;
  let m, last = null;
  while ((m = re.exec(String(text || '')))) last = m[1];
  if (last) return clip(last.replace(/[*_]+\s*$/, '').trim(), 600);
  const t = String(text || '').trim();
  return t ? clipTail(t, 500) : '(özet yok)';
}

/** Legacy rule: the answer starts with "ONAY". */
export function isApproved(text) {
  const t = String(text || '').trim().replace(/^[\s*_#>`"'“”«-]+/, '');
  return /^onay(?![a-zçğıöşü])/i.test(t);
}

const fold = (s) => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');

const NEGATIVE = /^(onay\s*(degil|yok|verilmedi|verilemez|veremem)|onaylanmadi|onaylanamaz|onaylamiyorum|onaysiz|not approved|reject|red\b|ret\b|reddedil|duzelt|sorun|eksik|hata|changes|revize|fix|degisiklik gerek)/;
const POSITIVE = /^(onay|onaylandi|onayliyorum|approve|approved|lgtm|kabul|tamam|gecti)/;

/**
 * The reviewer's verdict: 'approve' | 'fix' | null (none given). Its last recognizable
 * "KARAR: …" line wins (VERDICT/SONUÇ accepted too); an answer starting with "ONAY" approves.
 */
export function parseVerdict(text) {
  const t = String(text || '');
  const re = /^[\s>*_#`-]*(?:KARAR|VERDICT|SONUÇ|SONUC)[\s*_`]*[:：][\s*_`"'“]*([^\n]*)$/gim;
  const found = [];
  for (let m; (m = re.exec(t));) found.push(fold(m[1]).replace(/[*_`"'”.!]+/g, ' ').trim());
  for (const v of found.reverse()) {
    if (NEGATIVE.test(v)) return 'fix';
    if (POSITIVE.test(v)) return 'approve';
  }
  if (isApproved(t)) return 'approve';
  return null;
}

/** A follow-up that only means "go on" (it adds no instruction of its own). */
export const isContinue = (text) => /^(devam( et(in)?)?|devam edelim|sürdür|surdur|kaldığın yerden( devam( et)?)?|continue|go on|resume|tekrar dene|yeniden dene)[\s.!]*$/i
  .test(String(text || '').trim());

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

/** { diff, to } between tree `from` and now (null without git); emits a `diff` event on `lane`. */
async function diffSince(ctx, from, lane, { emitEmpty = false } = {}) {
  if (!from) return null;
  const to = await snapshot(ctx);
  if (!to) return null;
  try {
    const { diff, stats } = await git.treeDiff(ctx.meta.git.top, from, to);
    if (lane && (stats.files || emitEmpty)) {
      const truncated = diff.length > DIFF_EVENT_MAX;
      ctx.emit({
        kind: 'diff', lane, diff: truncated ? diff.slice(0, DIFF_EVENT_MAX) : diff, stats, applicable: false,
        ...(truncated ? { truncated: true } : {}),
      });
    }
    return { diff, stats, to };
  } catch (err) {
    ctx.note(`Diff alınamadı: ${err.message}`, 'warn');
    return null;
  }
}

async function treeDiff(ctx, from, to) {
  if (!from || !to) return null;
  try { return (await git.treeDiff(ctx.meta.git.top, from, to)).diff; } catch { return null; }
}

// ---- state ------------------------------------------------------------------------------------

/** Runs saved before stages existed: a finished plan means a finished run. */
function upgrade(st) {
  if (st.stage === undefined && st.plan) {
    st.stage = 'done';
    st.reviews ||= st.review ? [{ round: 1, verdict: st.approved ? 'approve' : 'fix', lane: 'reviewer', by: 'Denetçi', text: clip(st.review, REVIEW_KEEP) }] : [];
  }
  st.summaries ||= [];
  st.reviews ||= [];
  st.fixes ||= [];
  st.notes ||= [];
  st.cycle ||= { baseTree: st.startTree ?? null, reviewFrom: 0, fixFrom: 0 };
  return st;
}

const fixRounds = (ctx) => {
  const n = Number(ctx.config.fixRounds);
  return n >= 1 && n <= 5 ? Math.round(n) : DEFAULT_FIX_ROUNDS;
};

const goalOf = (ctx) => ctx.config.prompt;

// ---- turns ------------------------------------------------------------------------------------

/** Worker turn (edits allowed); a stale saved session is replaced once by a fresh one. */
async function workerTurn(ctx, laneId, prompt) {
  const resumable = ctx.canResume(laneId);
  const ask = (resume) => work(ctx, laneId, { prompt, permission: ctx.config.permission, system: P.workerSystem, resume });
  try {
    return await ask(true);
  } catch (err) {
    if (!resumable || err.sawOutput || err.name === 'AbortError' || !mayBeStaleSession(err)) throw err;
    ctx.lane(laneId).sessionId = undefined;
    return ask(false);
  }
}

/**
 * Read-only turn (planner / reviewer) with Ortak's hands for text-only agents. `build(resumed,
 * budget)` returns the prompt. A prompt the model can't take is rebuilt once with a third of the
 * budget in a fresh session; a stale session is replaced once.
 */
async function readerTurn(ctx, laneId, { system, build, resume = true }) {
  let budget = promptBudget(ctx.adapterOf(laneId));
  const listingMax = budget < RESUME_BUDGET_MIN ? SMALL_LISTING : undefined;
  let resumed = resume && ctx.canResume(laneId) && budget >= RESUME_BUDGET_MIN;
  for (let attempt = 0; ; attempt++) {
    try {
      return await work(ctx, laneId, { prompt: await build(resumed, budget), permission: 'read-only', system, resume: resumed, listingMax });
    } catch (err) {
      if (err.name === 'AbortError' || err.sawOutput || attempt >= 1) throw err;
      const kind = errorKind(err);
      if (kind === 'toolarge') {
        budget = Math.max(4000, Math.floor(budget / 3));
        ctx.note(`${ctx.lane(laneId)?.title || laneId}: istek modele büyük geldi; değişiklikler daha kısa gönderilip yeni oturumla tekrar deneniyor.`, 'warn');
      } else if (!(resumed && mayBeStaleSession(err))) {
        throw err;
      }
      ctx.lane(laneId).sessionId = undefined;
      resumed = false;
    }
  }
}

/** Workers in the order a job should try them: `first` (a lane) first, then the rest in order. */
function workerOrder(ctx, first) {
  const ws = ctx.lanes('worker');
  const i = Math.max(0, ws.findIndex((w) => w.lane === first));
  return [...ws.slice(i), ...ws.slice(0, i)];
}

/**
 * Runs one job (step, fix, request) on the workers in `order` until one finishes it. A worker that
 * fails hands the job on: always for limits / network / sign-in / size problems (another agent may
 * not have them), once for anything else. Resolves { r, w, diff }.
 */
async function onWorkers(ctx, order, what, prompt) {
  let lastErr = null;
  let retry = null;
  let others = 0;
  for (const w of order) {
    const before = await snapshot(ctx);
    try {
      const r = await workerTurn(ctx, w.lane, prompt(retry));
      const d = await diffSince(ctx, before, w.lane);
      return { r, w, diff: d?.diff ?? null };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      await diffSince(ctx, before, w.lane);
      lastErr = err;
      retry = w.title;
      if (!HANDOFF_KINDS.has(errorKind(err)) && ++others >= 2) break;
      if (w !== order.at(-1)) ctx.note(`${what}: ${w.title} başarısız oldu (${clip(err.message, 300)}); iş sıradaki çalışana veriliyor.`, 'warn');
    }
  }
  if (!lastErr) throw new Error(`${what}: çalışan yok.`);
  const e = new Error(`${what} tamamlanamadı: ${lastErr.message}`);
  e.sawOutput = lastErr.sawOutput;
  throw e;
}

const filesOf = (diff) => (diff == null ? [] : splitDiff(diff).map((f) => f.path).slice(0, 60));

// ---- stages -----------------------------------------------------------------------------------

async function planStage(ctx) {
  const st = ctx.state;
  ctx.phase('plan', 'Plan');
  const goal = goalOf(ctx);
  const r = await readerTurn(ctx, 'planner', {
    system: P.plannerSystem,
    build: (_resumed, budget) => P.plan(clip(goal, Math.max(8000, Math.floor(budget * 0.6))), st.notes, ctx.config.permission),
  });
  const { steps, warning } = parsePlan(r.text, goal);
  if (warning) ctx.note(warning, 'warn');
  st.plan = steps;
  st.summaries = [];
  st.stage = 'steps';
  ctx.save();
  ctx.note(`**Plan (${steps.length} adım)**\n${P.planList(steps)}`);
}

async function stepsStage(ctx) {
  const st = ctx.state;
  const steps = st.plan;
  const goal = goalOf(ctx);
  ctx.phase('uygulama', st.summaries.length ? `Uygulama · ${st.summaries.length + 1}. adımdan devam` : 'Uygulama');
  const workers = ctx.lanes('worker');
  for (let i = st.summaries.length; i < steps.length; i++) {
    ctx.throwIfAborted();
    const what = `Adım ${i + 1} (${steps[i].title})`;
    const { r, w, diff } = await onWorkers(ctx, workerOrder(ctx, workers[i % workers.length].lane), what,
      (retry) => P.workerStep({ goal, steps, index: i, summaries: st.summaries, notes: st.notes, retry }));
    st.summaries.push({ index: i, title: steps[i].title, by: w.title, lane: w.lane, summary: extractSummary(r.text), files: filesOf(diff) });
    ctx.save();
  }
  st.stage = 'review';
  ctx.save();
}

/** A follow-up request of the user, done by `cycle.lane` (or the first worker). */
async function requestStage(ctx) {
  const st = ctx.state;
  const cyc = st.cycle;
  ctx.phase('ek-istek', 'Ek istek');
  const { r, w, diff } = await onWorkers(ctx, workerOrder(ctx, cyc.lane), 'Ek istek', (retry) => {
    const p = P.teamFollow({ goal: goalOf(ctx), steps: st.plan, lastReview: st.reviews.at(-1)?.text, userText: cyc.request, notes: st.notes });
    return retry ? `${p}\n\nNot: Bu isteği önce ${retry} denedi ama tamamlayamadı; yarım kalmış değişiklikler olabilir.` : p;
  });
  st.summaries.push({
    index: st.summaries.length, title: `Ek istek: ${makeTitle(cyc.request, 60)}`, by: w.title, lane: w.lane,
    summary: extractSummary(r.text), files: filesOf(diff),
  });
  st.stage = 'review';
  ctx.save();
}

/** Reviewer lanes to try: the reviewer, then the planner as a stand-in when it's another model. */
function reviewerLanes(ctx) {
  const rv = ctx.lane('reviewer');
  const pl = ctx.lane('planner');
  const out = [rv].filter(Boolean);
  if (pl && (!rv || pl.agentId !== rv.agentId || pl.model !== rv.model)) out.push(pl);
  return out;
}

async function reviewStage(ctx) {
  const st = ctx.state;
  const cyc = st.cycle;
  const round = st.reviews.length - cyc.reviewFrom + 1;
  const last = st.reviews.at(-1);
  // A fix made after the latest review: this review re-checks those issues.
  const fix = st.fixes.at(-1)?.afterReview === st.reviews.length && last ? st.fixes.at(-1) : null;
  ctx.phase('inceleme', round === 1 && !fix ? 'İnceleme' : `İnceleme ${round}`);

  const total = await diffSince(ctx, cyc.baseTree, 'reviewer', { emitEmpty: true });
  const goal = goalOf(ctx);
  let failure = null;
  const lanes = reviewerLanes(ctx);
  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i];
    try {
      const build = async (resumed, budget) => {
        const common = {
          goal: clip(goal, Math.max(4000, Math.floor(budget * 0.25))), steps: st.plan, summaries: st.summaries, notes: st.notes,
          round, request: cyc.request, fix: fix ? { by: fix.by, summary: fix.summary } : null, permission: ctx.config.permission,
        };
        // A resumed reviewer that wrote the last review sees only what the fix changed.
        if (resumed && fix && last.lane === l.lane) {
          const fixDiff = await treeDiff(ctx, last.tree, total?.to);
          const body = P.review({ ...common, resumed: true, diff: { text: '' } });
          const view = reviewDiff(fixDiff, Math.max(3000, budget - body.length - 3000));
          return P.review({ ...common, resumed: true, diff: { text: `${view.text}\n\nBu çalışmada toplam değişen dosyalar:\n${changedFiles(total?.diff ?? null, 3000)}` } });
        }
        const prevIssues = fix ? last.text : null;
        const body = P.review({ ...common, prevIssues, resumed: false, diff: { text: '' } });
        return P.review({ ...common, prevIssues, resumed: false, diff: reviewDiff(total?.diff ?? null, Math.max(4000, budget - body.length)) });
      };
      let r = await readerTurn(ctx, l.lane, { system: P.reviewerSystem, build, resume: !!(fix && last.lane === l.lane) });
      let verdict = parseVerdict(r.text);
      if (!verdict && ctx.canResume(l.lane)) { // ask once more in the same session
        try {
          const again = await work(ctx, l.lane, { prompt: P.reviewVerdictAsk, permission: 'read-only', system: P.reviewerSystem, resume: true });
          verdict = parseVerdict(again.text);
          if (verdict) r = { text: `${r.text}\n\n${again.text}` };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
        }
      }
      if (!verdict) {
        verdict = /^\s*\d+[.)]\s+\S/m.test(r.text) ? 'fix' : 'approve';
        ctx.note(`Denetçi açık bir karar (KARAR: ONAY / DÜZELTME) yazmadı; ${verdict === 'fix' ? 'sorun listesi olduğu için düzeltme' : 'sorun listelemediği için onay'} sayıldı.`, 'warn');
      }
      st.reviews.push({ round, verdict, lane: l.lane, by: l.title, text: clip(r.text, REVIEW_KEEP), tree: total?.to ?? null });
      st.stage = verdict === 'approve' || st.fixes.length - cyc.fixFrom >= fixRounds(ctx) ? 'done' : 'fix';
      st.approved = verdict === 'approve';
      ctx.save();
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      failure = err;
      const next = lanes[i + 1];
      if (next) ctx.note(`Denetçi (${l.title}) hata verdi: ${clip(err.message, 300)}. Bu inceleme ${next.title} ile yapılıyor.`, 'warn');
    }
  }
  throw failure;
}

/**
 * Fixer: the worker whose steps touched most of the files the review names; the worker whose fix
 * the reviewer just rejected goes last (another one gets a try); ties rotate by round.
 */
function fixerOrder(ctx, issues, round) {
  const st = ctx.state;
  const cyc = st.cycle;
  const rejected = st.fixes.length > cyc.fixFrom ? st.fixes.at(-1).lane : null;
  const ws = ctx.lanes('worker');
  const text = String(issues || '');
  const score = new Map(ws.map((w) => [w.lane, 0]));
  for (const s of st.summaries) {
    for (const f of s.files || []) {
      const base = f.split('/').pop();
      if (score.has(s.lane) && (text.includes(f) || (base.length > 3 && text.includes(base)))) score.set(s.lane, score.get(s.lane) + 1);
    }
  }
  const rot = ws.map((w, i) => ({ w, s: score.get(w.lane), i: (i - (round - 1) % ws.length + ws.length) % ws.length }));
  const back = (x) => (x.w.lane === rejected ? 1 : 0);
  rot.sort((a, b) => back(a) - back(b) || b.s - a.s || a.i - b.i);
  return rot.map((x) => x.w);
}

async function fixStage(ctx) {
  const st = ctx.state;
  const cyc = st.cycle;
  const round = st.fixes.length - cyc.fixFrom + 1;
  const max = Math.max(fixRounds(ctx), round);
  const issues = st.reviews.at(-1)?.text || '';
  ctx.phase('duzeltme', round === 1 ? 'Düzeltme' : `Düzeltme ${round}`);
  const total = cyc.baseTree ? await treeDiff(ctx, cyc.baseTree, await snapshot(ctx)) : null;
  const changed = changedFiles(ctx.meta.git ? (total ?? '') : null);
  const { r, w } = await onWorkers(ctx, fixerOrder(ctx, issues, round), `Düzeltme ${round}`, (retry) => {
    const p = P.fix({ goal: goalOf(ctx), steps: st.plan, summaries: st.summaries, notes: st.notes, issues, changed, round, maxRounds: max });
    return retry ? `${p}\n\nNot: Bu düzeltmeyi önce ${retry} denedi ama tamamlayamadı; yarım kalmış değişiklikler olabilir.` : p;
  });
  st.fixes.push({ round, by: w.title, lane: w.lane, summary: extractSummary(r.text), afterReview: st.reviews.length });
  st.stage = 'review';
  ctx.save();
}

// ---- driver -----------------------------------------------------------------------------------

function composeResult(ctx) {
  const st = ctx.state;
  const cyc = st.cycle;
  const reviews = st.reviews.slice(cyc.reviewFrom);
  const fixes = st.fixes.slice(cyc.fixFrom);
  const last = st.reviews.at(-1);
  const lines = [];
  if (st.approved) {
    lines.push(`**Durum:** Denetçi onayladı${reviews.length > 1 ? ` (${reviews.length}. incelemede, ${fixes.length} düzeltme turundan sonra)` : ''}.`);
  } else {
    lines.push(`**Durum:** Denetçi ${fixes.length ? `${fixes.length} düzeltme turundan sonra ` : ''}hâlâ sorun görüyor. ` +
      '"devam et" yazarsan bildirdiği sorunlar için yeni düzeltme turları yapılır.');
  }
  lines.push('', '**Adımlar**');
  for (const s of st.summaries) lines.push(`${s.index + 1}. ${s.title} — _${s.by}_: ${s.summary}`);
  if (fixes.length) {
    lines.push('', '**Düzeltmeler**');
    for (const f of fixes) lines.push(`${f.round}. _${f.by}_: ${f.summary}`);
  }
  if (last) lines.push('', `**Denetçi** (${last.by})`, last.text.trim());
  return lines.join('\n');
}

function pauseNote(kind, err) {
  const msg = clip(err.message || String(err), 500);
  if (kind === 'limit') return `Takım durdu: ${msg} Yapılanlar kaydedildi; limit yenilenince "devam et" yazman yeterli.`;
  if (kind === 'auth') return `Takım durdu: ${msg} Oturum açtıktan sonra "devam et" yaz; kaldığı yer kaydedildi.`;
  return `Takım geçici bir hata yüzünden durdu (${msg}). Kaldığı yer kaydedildi; biraz sonra "devam et" yaz.`;
}

/** Runs the stages from wherever state says; pauses (state kept) on limits and network errors. */
async function drive(ctx) {
  const st = upgrade(ctx.state);
  try {
    if (st.startTree === undefined) {
      st.startTree = await snapshot(ctx);
      st.cycle.baseTree = st.startTree;
      if (!ctx.meta.git) ctx.note('Proje bir git deposu değil; değişiklikler diff olarak gösterilemeyecek (denetçi dosyaları okuyarak denetler).', 'warn');
    }
    if (!st.stage || st.stage === 'plan') { st.stage = 'plan'; ctx.save(); await planStage(ctx); }
    if (st.stage === 'steps') await stepsStage(ctx);
    if (st.stage === 'request') await requestStage(ctx);
    while (st.stage === 'review' || st.stage === 'fix') {
      ctx.throwIfAborted();
      if (st.stage === 'review') await reviewStage(ctx);
      else await fixStage(ctx);
    }
  } catch (err) {
    const kind = err?.name === 'AbortError' ? 'abort' : errorKind(err);
    st.interrupted = { reason: kind === 'abort' ? 'kullanıcı iptal etti' : clip(err?.message || String(err), 1000), kind, at: Date.now() };
    ctx.save();
    if (PAUSE_KINDS.has(kind)) { ctx.note(pauseNote(kind, err), 'warn'); return 'waiting'; }
    if (kind !== 'abort') ctx.note('Kaldığı yer kaydedildi; "devam et" yazarak sürdürebilirsin.', 'info');
    throw err;
  }
  st.interrupted = null;
  st.review = st.reviews.at(-1)?.text || null; // older clients read these two
  ctx.save();
  ctx.emit({ kind: 'result', lane: 'reviewer', text: composeResult(ctx) });
  return 'done';
}

export default {
  start(ctx) {
    return drive(ctx);
  },

  checkFollowUp(meta, { lane }) {
    const l = lane && meta.lanes.find((x) => x.lane === lane);
    if (lane && !l) throw new HttpError(400, `Bu çalışmada böyle bir şerit yok: ${lane}`);
  },

  /**
   * Follow-up:
   * - addressed to the planner / reviewer: that agent answers directly (read-only);
   * - the run stopped early (limit, error, cancel, restart): it continues where it stopped; a
   *   message other than "devam et" is kept as a note every later prompt carries;
   * - "devam et" after a review that still found problems: more fix rounds;
   * - anything else: a worker (the addressed one, else the first) does it, then review ↔ fix.
   */
  async followUp(ctx, { text, lane }) {
    const st = upgrade(ctx.state);
    const l = lane && ctx.lane(lane);

    if (l && (l.role === 'planner' || l.role === 'reviewer')) {
      ctx.phase('soru', l.role === 'planner' ? 'Planlayıcıya soru' : 'Denetçiye soru');
      const r = await readerTurn(ctx, l.lane, {
        system: l.role === 'planner' ? P.plannerSystem : P.reviewerSystem,
        build: (resumed) => (resumed ? text : `Genel hedef:\n${clip(goalOf(ctx), 8000)}\n\nKullanıcının sorusu:\n${text}`),
      });
      ctx.emit({ kind: 'result', lane: l.lane, text: r.text });
      return 'done';
    }

    const go = isContinue(text);
    if (st.stage !== 'done') {
      if (!go) st.notes.push(text);
      ctx.note(st.interrupted ? `Kaldığı yerden devam ediliyor (durma nedeni: ${clip(st.interrupted.reason, 200)}).` : 'Kaldığı yerden devam ediliyor.');
      ctx.save();
      return drive(ctx);
    }

    if (go && !st.approved && st.reviews.length) {
      st.cycle = { ...st.cycle, reviewFrom: st.reviews.length, fixFrom: st.fixes.length };
      st.stage = 'fix';
      ctx.save();
      return drive(ctx);
    }

    st.cycle = {
      baseTree: await snapshot(ctx), reviewFrom: st.reviews.length, fixFrom: st.fixes.length,
      request: text, lane: l?.role === 'worker' ? l.lane : ctx.lanes('worker')[0]?.lane,
    };
    st.stage = 'request';
    ctx.save();
    return drive(ctx);
  },

  /** After a restart an unfinished run waits for "devam et". */
  resumable: (meta) => !!meta.state?.stage && meta.state.stage !== 'done',
};

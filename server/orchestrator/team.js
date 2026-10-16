// team: Plan (planner, read-only, JSON plan) -> Uygulama (steps run sequentially in cwd,
// round-robin over workers) -> İnceleme (reviewer, read-only) -> one Düzeltme + Son inceleme.
import * as git from '../git.js';
import * as P from './prompts.js';
import { work } from './textcoder.js';
import { HttpError, clip, clipTail, makeTitle } from '../util.js';
import { balancedObjects, tryParse } from './json.js';

const MAX_STEPS = 6;
const DIFF_EVENT_MAX = 1_500_000;

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

export function isApproved(text) {
  const t = String(text || '').trim().replace(/^[\s*_#>`"'“”«-]+/, '');
  return /^onay(?![a-zçğıöşü])/i.test(t);
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

/** Diff between tree `from` and now; emits a `diff` event on `lane` when something changed. */
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
    return diff;
  } catch (err) {
    ctx.note(`Diff alınamadı: ${err.message}`, 'warn');
    return null;
  }
}

// ---- pipeline ---------------------------------------------------------------------------------

async function runStep(ctx, i, steps, summaries) {
  const workers = ctx.lanes('worker');
  const tries = Math.min(2, workers.length); // a failed step is handed to the next worker once
  for (let a = 0; a < tries; a++) {
    const w = workers[(i + a) % workers.length];
    const before = await snapshot(ctx);
    try {
      const r = await work(ctx, w.lane, {
        prompt: P.workerStep(ctx.config.prompt, steps, i, summaries),
        permission: ctx.config.permission,
        system: P.workerSystem,
      });
      await diffSince(ctx, before, w.lane);
      return { index: i, title: steps[i].title, by: w.title, lane: w.lane, summary: extractSummary(r.text) };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      await diffSince(ctx, before, w.lane);
      if (a + 1 >= tries) throw new Error(`Adım ${i + 1} (${steps[i].title}) başarısız: ${err.message}`);
      ctx.note(`Adım ${i + 1}: ${w.title} başarısız oldu (${err.message}); adım sıradaki çalışana veriliyor.`, 'warn');
    }
  }
  throw new Error(`Adım ${i + 1} için çalışan yok.`);
}

function composeResult(ctx, { approved, review, fixSummary, extra }) {
  const st = ctx.state;
  const lines = [`**Durum:** ${approved ? 'Denetçi onayladı' : 'Denetçi sorun bildirdi'}`, '', '**Adımlar**'];
  for (const s of st.summaries || []) lines.push(`${s.index + 1}. ${s.title} — _${s.by}_: ${s.summary}`);
  if (fixSummary) lines.push('', `**Düzeltme:** ${fixSummary}`);
  if (extra) lines.push('', extra);
  lines.push('', '**Denetçi**', review.trim());
  return lines.join('\n');
}

async function reviewCycle(ctx) {
  const st = ctx.state;
  const goal = ctx.config.prompt;
  ctx.phase('inceleme', 'İnceleme');
  const diff = await diffSince(ctx, st.startTree, 'reviewer', { emitEmpty: true });
  const rv = await ctx.turn('reviewer', {
    prompt: P.review(goal, st.plan, st.summaries, diff), permission: 'read-only', system: P.reviewerSystem,
  });
  let approved = isApproved(rv.text);
  let review = rv.text;
  let fixSummary = null;

  if (!approved) {
    ctx.phase('duzeltme', 'Düzeltme');
    const w = ctx.lanes('worker')[0];
    const before = await snapshot(ctx);
    const fx = await work(ctx, w.lane, { prompt: P.fix(goal, rv.text), permission: ctx.config.permission, system: P.workerSystem });
    await diffSince(ctx, before, w.lane);
    fixSummary = extractSummary(fx.text);

    ctx.phase('son-inceleme', 'Son inceleme');
    const resumed = ctx.canResume('reviewer');
    const diff2 = await diffSince(ctx, st.startTree, 'reviewer', { emitEmpty: true });
    const fr = await ctx.turn('reviewer', {
      prompt: P.finalReview({ goal, fixSummary, diff: diff2, resumed }), permission: 'read-only', system: P.reviewerSystem,
    });
    approved = isApproved(fr.text);
    review = fr.text;
  }
  st.review = review;
  st.approved = approved;
  ctx.save();
  ctx.emit({ kind: 'result', lane: 'reviewer', text: composeResult(ctx, { approved, review, fixSummary }) });
}

async function pipeline(ctx, goal) {
  const st = ctx.state;
  st.startTree = await snapshot(ctx);
  if (!ctx.meta.git) ctx.note('Proje bir git deposu değil; değişiklikler diff olarak gösterilemeyecek.', 'warn');

  ctx.phase('plan', 'Plan');
  const pr = await ctx.turn('planner', { prompt: P.plan(goal), permission: 'read-only', system: P.plannerSystem });
  const { steps, warning } = parsePlan(pr.text, goal);
  if (warning) ctx.note(warning, 'warn');
  st.plan = steps;
  st.summaries = [];
  ctx.save();
  ctx.note(`**Plan (${steps.length} adım)**\n${P.planList(steps)}`);

  ctx.phase('uygulama', 'Uygulama');
  for (let i = 0; i < steps.length; i++) {
    ctx.throwIfAborted();
    st.summaries.push(await runStep(ctx, i, steps, st.summaries));
    ctx.save();
  }
  await reviewCycle(ctx);
}

export default {
  async start(ctx) {
    await pipeline(ctx, ctx.config.prompt);
    return 'done';
  },

  checkFollowUp(meta, { lane }) {
    const l = lane && meta.lanes.find((x) => x.lane === lane);
    if (lane && !l) throw new HttpError(400, `Bu çalışmada böyle bir şerit yok: ${lane}`);
  },

  /**
   * Follow-up: a worker (the given lane, else the first worker) implements the user's extra
   * request, then the reviewer gives a short review. `lane: 'planner'|'reviewer'` asks that
   * agent directly (read-only).
   */
  async followUp(ctx, { text, lane }) {
    const st = ctx.state;
    const goal = ctx.config.prompt;
    const l = lane && ctx.lane(lane);

    if (l && (l.role === 'planner' || l.role === 'reviewer')) {
      ctx.phase('soru', l.role === 'planner' ? 'Planlayıcıya soru' : 'Denetçiye soru');
      const prompt = ctx.canResume(l.lane) ? text : `Genel hedef:\n${goal}\n\nKullanıcının sorusu:\n${text}`;
      const r = await ctx.turn(l.lane, { prompt, permission: 'read-only', system: l.role === 'planner' ? P.plannerSystem : P.reviewerSystem });
      ctx.emit({ kind: 'result', lane: l.lane, text: r.text });
      return 'done';
    }

    if (!st.plan) { // planning never finished: start over with the extra request folded in
      await pipeline(ctx, `${goal}\n\nKullanıcının ek isteği:\n${text}`);
      return 'done';
    }

    const w = l?.role === 'worker' ? l : ctx.lanes('worker')[0];
    ctx.phase('ek-istek', 'Ek istek');
    const before = await snapshot(ctx);
    const r = await work(ctx, w.lane, { prompt: P.teamFollow(goal, st.plan, st.review, text), permission: ctx.config.permission, system: P.workerSystem });
    const diff = await diffSince(ctx, before, w.lane);
    const summary = extractSummary(r.text);
    (st.summaries ||= []).push({ index: st.summaries.length, title: `Ek istek: ${makeTitle(text, 60)}`, by: w.title, lane: w.lane, summary });
    ctx.save();

    ctx.phase('inceleme', 'İnceleme');
    const resumed = ctx.canResume('reviewer');
    const rv = await ctx.turn('reviewer', {
      prompt: P.teamFollowReview({ goal, userText: text, summary, diff, resumed }), permission: 'read-only', system: P.reviewerSystem,
    });
    st.review = rv.text;
    st.approved = isApproved(rv.text);
    ctx.save();
    ctx.emit({ kind: 'result', lane: 'reviewer', text: composeResult(ctx, { approved: st.approved, review: rv.text }) });
    return 'done';
  },

  resumable: () => false,
};

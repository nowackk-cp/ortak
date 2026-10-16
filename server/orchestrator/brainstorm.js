// brainstorm: Tur 1 (independent answers, parallel) -> Tur 2..N (critique + improve) -> Sentez.
// Follow-up: one more round including the user's message, then a new synthesis.
import * as P from './prompts.js';
import { HttpError } from '../util.js';

const PERM = 'read-only';

const participants = (ctx) => ctx.lanes('participant');

/** Run a turn on several lanes in parallel; failures become warnings. */
async function runAll(ctx, ids, makePrompt) {
  const results = await Promise.allSettled(ids.map((id) =>
    ctx.turn(id, { prompt: makePrompt(id), permission: PERM, system: P.brainstormSystem })));
  ctx.throwIfAborted();
  const ok = {};
  const failed = [];
  results.forEach((r, i) => {
    const id = ids[i];
    if (r.status === 'fulfilled') ok[id] = r.value.text;
    else {
      failed.push(id);
      ctx.note(`${ctx.lane(id).title} cevap veremedi: ${r.reason?.message || r.reason}. Diğerleriyle devam ediliyor.`, 'warn');
    }
  });
  return { ok, failed };
}

async function firstRound(ctx, question) {
  const st = ctx.state;
  st.round = 1;
  ctx.phase('tur-1', 'Tur 1');
  const { ok } = await runAll(ctx, participants(ctx).map((l) => l.lane), () => P.brainstormFirst(question));
  if (!Object.keys(ok).length) throw new Error('Hiçbir katılımcı cevap veremedi.');
  st.answers = ok;
  st.active = Object.keys(ok);
  ctx.save();
}

async function critiqueRound(ctx, question) {
  const st = ctx.state;
  const k = ++st.round;
  ctx.phase(`tur-${k}`, `Tur ${k}`);
  const prev = { ...st.answers };
  const ids = st.active.filter((id) => prev[id]);
  const others = (id) => ids.filter((o) => o !== id).map((o) => ({ title: ctx.lane(o).title, text: prev[o] }));
  const { ok, failed } = await runAll(ctx, ids, (id) => (ctx.canResume(id)
    ? P.critiqueResume(k, others(id))
    : P.critiqueFresh(k, question, prev[id], others(id))));
  Object.assign(st.answers, ok); // a participant that failed keeps its previous answer for the synthesis
  st.active = ids.filter((id) => !failed.includes(id));
  if (!st.active.length) throw new Error(`Tur ${k}: hiçbir katılımcı cevap veremedi.`);
  ctx.save();
}

async function synthesize(ctx, question, userText) {
  const st = ctx.state;
  ctx.phase('sentez', 'Sentez');
  const answers = participants(ctx)
    .filter((l) => st.answers?.[l.lane])
    .map((l) => ({ title: l.title, text: st.answers[l.lane] }));
  const full = P.synthesis(question, answers, userText);
  const prompt = userText && st.synthesis && ctx.canResume('moderator') ? P.synthesisResume(userText, answers) : full;

  let lane = 'moderator';
  let text;
  try {
    text = (await ctx.turn('moderator', { prompt, permission: PERM, system: P.moderatorSystem })).text;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const fb = (st.active || []).find((id) => id !== 'moderator');
    if (!fb) throw err;
    ctx.note(`Moderatör sentez yapamadı (${err.message}); sentezi ${ctx.lane(fb).title} yapıyor.`, 'warn');
    text = (await ctx.turn(fb, { prompt: full, permission: PERM, system: P.moderatorSystem })).text;
    lane = fb;
  }
  st.synthesis = text;
  ctx.save();
  ctx.emit({ kind: 'result', lane, text });
}

export default {
  async start(ctx) {
    const q = ctx.config.prompt;
    await firstRound(ctx, q);
    for (let k = 2; k <= ctx.config.rounds; k++) {
      if (ctx.state.active.length < 2) {
        ctx.note('Eleştiri turu için en az iki katılımcı gerekir; doğrudan senteze geçiliyor.');
        break;
      }
      await critiqueRound(ctx, q);
    }
    await synthesize(ctx, q);
    return 'waiting';
  },

  checkFollowUp(meta, { lane }) {
    if (lane && lane !== 'moderator' && !meta.lanes.some((l) => l.lane === lane && l.role === 'participant')) {
      throw new HttpError(400, `Bu çalışmada böyle bir katılımcı yok: ${lane}`);
    }
  },

  async followUp(ctx, { text, lane }) {
    const q = ctx.config.prompt;
    const st = ctx.state;

    if (lane === 'moderator') { // direct question to the moderator
      ctx.phase('moderator', 'Moderatör');
      const prompt = ctx.canResume('moderator') ? text : P.moderatorDirect(q, st.synthesis, text);
      const r = await ctx.turn('moderator', { prompt, permission: PERM, system: P.moderatorSystem });
      ctx.emit({ kind: 'result', lane: 'moderator', text: r.text });
      return 'waiting';
    }

    if (!st.answers || !Object.keys(st.answers).length) {
      await firstRound(ctx, `${q}\n\nKullanıcının ek mesajı:\n${text}`);
    } else {
      const all = participants(ctx).map((l) => l.lane);
      const ids = lane ? [lane] : all;
      const k = ++st.round;
      ctx.phase(`tur-${k}`, `Tur ${k}`);
      const { ok, failed } = await runAll(ctx, ids, (id) => (ctx.canResume(id)
        ? P.brainstormFollowResume(text, st.synthesis)
        : P.brainstormFollowFresh(q, st.answers[id], st.synthesis, text)));
      if (!Object.keys(ok).length) throw new Error('Hiçbir katılımcı cevap veremedi.');
      Object.assign(st.answers, ok);
      st.active = all.filter((id) => st.answers[id] && !failed.includes(id));
      ctx.save();
    }
    await synthesize(ctx, q, text);
    return 'waiting';
  },

  // After a restart the discussion can continue as long as at least one round finished.
  resumable: (meta) => !!(meta.state?.answers && Object.keys(meta.state.answers).length),
};

// group: the agents (and the user) talk in one shared conversation, one speaker at a time.
// Every speaker sees what was said before it; an @mention picks the next speaker, otherwise the
// turn rotates. A session ends when everyone in a row ends with [UZLAŞI] or the turn budget
// (rounds × participants) runs out. A follow-up message from the user starts a new session.
import * as P from './prompts.js';
import { HttpError } from '../util.js';

const PERM = 'read-only';

/** "@claude" for lane "claude", "@claude2" for "claude#2". */
const handleOf = (lane) => lane.replace('#', '');

function people(ctx) {
  return ctx.lanes('participant').map((l) => ({ lane: l.lane, handle: handleOf(l.lane), title: l.title, agentId: l.agentId }));
}

/**
 * Lane addressed by an @mention in `text` (handle, agent id or first word of the name). The user
 * usually names the addressee first ("@codex ve @claude …"); agents tend to acknowledge someone
 * first and end with the question ("@claude'ye katılıyorum … @antigravity, sen ne dersin?"), so for
 * them the last mention wins.
 */
function mentionedLane(ctx, text, exclude, { last = false } = {}) {
  const ps = people(ctx);
  const keys = new Map();
  for (const p of ps) {
    for (const k of [p.handle, p.agentId, p.title.split(/[\s·]+/)[0]]) {
      const key = String(k).toLocaleLowerCase('tr');
      if (key && !keys.has(key)) keys.set(key, p.lane);
    }
  }
  const found = [];
  for (const m of String(text || '').matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const lane = keys.get(m[1].toLocaleLowerCase('tr'));
    if (lane && lane !== exclude) found.push(lane);
  }
  return (last ? found.at(-1) : found[0]) || null;
}

function nextInRotation(order, active, after) {
  const live = order.filter((l) => active.includes(l));
  if (!live.length) return null;
  const i = live.indexOf(after);
  return live[(i + 1) % live.length];
}

/**
 * Who talks next:
 *  1. near the end of the budget, whoever hasn't spoken yet in this session;
 *  2. anyone who has waited longer than a full round (a short back-and-forth between two agents is
 *     fine, but then the others get their turn), longest wait first;
 *  3. whoever the speaker @mentioned;
 *  4. the next one in rotation.
 */
function pickNext(ctx, { text, speaker, order, active, waited, spoke, budget }) {
  const others = active.filter((l) => l !== speaker);
  if (!others.length) return active[0] || null;
  const silent = others.filter((l) => !spoke.has(l));
  if (silent.length && budget <= silent.length) return silent[0];
  const starved = others
    .filter((l) => waited.get(l) >= active.length)
    .sort((a, b) => waited.get(b) - waited.get(a) || order.indexOf(a) - order.indexOf(b));
  if (starved.length) return starved[0];
  const mentioned = mentionedLane(ctx, text, speaker, { last: true });
  if (mentioned && active.includes(mentioned)) return mentioned;
  return nextInRotation(order, active, speaker);
}

async function converse(ctx, firstSpeaker) {
  const st = ctx.state;
  const ps = people(ctx);
  const order = ps.map((p) => p.lane);
  const byLane = new Map(ps.map((p) => [p.lane, p]));
  const name = (lane) => {
    const p = byLane.get(lane);
    return p ? `@${p.handle} (${p.title})` : lane;
  };

  st.active = (st.active || order).filter((l) => order.includes(l));
  if (!st.active.length) st.active = [...order];
  let budget = Math.max(1, (ctx.config.rounds || 2) * st.active.length);
  const spokeThisSession = new Set();
  // Lanes whose latest message says [UZLAŞI]; anyone speaking without it clears the set. Counting
  // distinct lanes (not a streak of messages) so two agents agreeing back and forth can't end the
  // conversation for a third one that never spoke.
  const agreed = new Set();
  // Turns since each lane last spoke. Mentions decide who's next, but nobody waits longer than one
  // full round: otherwise two agents that keep @-ing each other starve the rest.
  const waited = new Map(st.active.map((l) => [l, 0]));
  let next = firstSpeaker && st.active.includes(firstSpeaker) ? firstSpeaker : st.active[0];

  while (budget-- > 0 && next) {
    ctx.throwIfAborted();
    const speaker = next;
    const p = byLane.get(speaker);
    const seen = st.seen?.[speaker];
    const prompt = seen != null && ctx.canResume(speaker)
      ? P.groupResume(st.log.slice(seen), name, p.handle)
      : P.groupFresh(st.log, name, p.handle);
    const system = P.groupSystem(ps.map((x) => ({ handle: x.handle, title: x.title, self: x.lane === speaker })));

    let text;
    try {
      text = (await ctx.turn(speaker, { prompt, permission: PERM, system })).text;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      ctx.note(`${p.title} cevap veremedi: ${err.message}. Konuşma onsuz devam ediyor.`, 'warn');
      st.active = st.active.filter((l) => l !== speaker);
      if (!st.active.length) throw new Error('Hiçbir katılımcı cevap veremedi.');
      next = nextInRotation(order, st.active, speaker);
      continue;
    }

    st.log.push({ who: speaker, text });
    (st.seen ||= {})[speaker] = st.log.length;
    spokeThisSession.add(speaker);
    ctx.save();

    if (text.includes(P.CONSENSUS)) agreed.add(speaker);
    else agreed.clear();
    if (st.active.every((l) => agreed.has(l))) {
      ctx.note('Herkes uzlaştı; konuşma durdu. Yazarak devam ettirebilir ya da birine @ad ile soru sorabilirsiniz.');
      return;
    }

    for (const l of st.active) waited.set(l, l === speaker ? 0 : (waited.get(l) || 0) + 1);
    next = pickNext(ctx, { text, speaker, order, active: st.active, waited, spoke: spokeThisSession, budget });
  }
  ctx.note('Konuşma bu tur için sınıra ulaştı. Devam etmeleri için bir mesaj yazın (ör. "devam edin" ya da "@codex sen ne diyorsun?").');
}

export default {
  async start(ctx) {
    ctx.state.log = [{ who: 'user', text: ctx.config.prompt }];
    ctx.save();
    await converse(ctx, mentionedLane(ctx, ctx.config.prompt) || undefined);
    return 'waiting';
  },

  checkFollowUp(meta, { lane }) {
    if (lane && !meta.lanes.some((l) => l.lane === lane && l.role === 'participant')) {
      throw new HttpError(400, `Bu sohbette böyle bir katılımcı yok: ${lane}`);
    }
  },

  async followUp(ctx, { text, lane }) {
    const st = ctx.state;
    if (!Array.isArray(st.log) || !st.log.length) st.log = [{ who: 'user', text: ctx.config.prompt }];
    st.log.push({ who: 'user', text });
    // A participant that failed earlier gets another chance when the user speaks again.
    st.active = ctx.lanes('participant').map((l) => l.lane);
    ctx.save();
    const last = [...st.log].reverse().find((m) => m.who !== 'user')?.who;
    const first = lane || mentionedLane(ctx, text) || nextInRotation(st.active, st.active, last) || st.active[0];
    await converse(ctx, first);
    return 'waiting';
  },

  resumable: (meta) => Array.isArray(meta.state?.log) && meta.state.log.length > 0,
};

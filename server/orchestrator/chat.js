// chat: one agent, many turns. Resumes the agent session when possible, otherwise rebuilds
// context from a compact transcript.
import * as P from './prompts.js';
import { clip } from '../util.js';
import { mayBeStaleSession } from '../errors.js';
import * as git from '../git.js';
import { listing, stripEdits, textChatTurn } from './textcoder.js';

const DIFF_EVENT_MAX = 1_500_000;

const HISTORY_MAX = 16;      // messages kept for the transcript fallback
const HISTORY_MSG_MAX = 2500; // chars per message

// Kod arayüzü + an agent without its own file tools (Gemini web / 4 Argon, EVREN): Ortak is its
// hands — it lists folders, reads files and applies SEARCH/REPLACE blocks (textcoder.js).
async function textTurn(ctx, laneId, text) {
  const history = (ctx.state.history ||= []);
  const resumable = ctx.canResume(laneId);
  const prior = history.slice(-HISTORY_MAX);
  const first = !history.length;
  const body = first ? P.textChatIntro({ listing: await listing(ctx.meta.cwd), text }) : text;
  const prompt = resumable || !prior.length ? body : P.chatWithTranscript(prior, body);

  history.push({ role: 'user', text: clip(text, HISTORY_MSG_MAX) });
  ctx.save();
  const before = await snapshot(ctx);
  const res = await textChatTurn(ctx, laneId, { prompt, permission: ctx.config.permission, resume: resumable });
  if (before && res.applied.length) await emitDiff(ctx, before);
  history.push({ role: 'assistant', text: clip(stripEdits(res.text), HISTORY_MSG_MAX) });
  if (history.length > HISTORY_MAX * 2) history.splice(0, history.length - HISTORY_MAX * 2);
  ctx.save();
}

async function snapshot(ctx) {
  const info = (ctx.state.gitTop ??= (await git.repoInfo(ctx.meta.cwd)).top || '');
  if (!info) return null;
  try { return await git.snapshotTree(info); } catch { return null; }
}

async function emitDiff(ctx, from) {
  try {
    const to = await snapshot(ctx);
    if (!to) return;
    const r = await git.treeDiff(ctx.state.gitTop, from, to);
    if (!r.stats.files) return;
    const truncated = r.diff.length > DIFF_EVENT_MAX;
    ctx.emit({ kind: 'diff', diff: truncated ? r.diff.slice(0, DIFF_EVENT_MAX) : r.diff, stats: r.stats, applicable: false, ...(truncated ? { truncated: true } : {}) });
  } catch { /* the tool events already list what changed */ }
}

const textOnly = (ctx, laneId) => ctx.config.surface !== 'chat' && ctx.adapterOf(laneId)?.capabilities?.edit === false;

async function turn(ctx, text) {
  const laneId = ctx.meta.lanes[0].lane;
  if (textOnly(ctx, laneId)) return textTurn(ctx, laneId, text);
  const history = (ctx.state.history ||= []);
  const permission = ctx.config.permission;
  const resumable = ctx.canResume(laneId);
  const prior = history.slice(-HISTORY_MAX);
  const prompt = resumable || !prior.length ? text : P.chatWithTranscript(prior, text);

  history.push({ role: 'user', text: clip(text, HISTORY_MSG_MAX) });
  ctx.save();

  let res;
  try {
    res = await ctx.turn(laneId, { prompt, permission });
  } catch (err) {
    // A stale/expired session usually fails immediately: retry once without it. Never for a
    // usage limit, network or sign-in error — the session is fine and would be lost.
    if (!resumable || err.sawOutput || err.name === 'AbortError' || !mayBeStaleSession(err)) throw err;
    ctx.note('Önceki oturum sürdürülemedi; konuşma geçmişiyle yeni oturum başlatılıyor.', 'warn');
    ctx.lane(laneId).sessionId = undefined;
    res = await ctx.turn(laneId, {
      prompt: prior.length ? P.chatWithTranscript(prior, text) : text,
      permission,
      resume: false,
    });
  }
  history.push({ role: 'assistant', text: clip(res.text, HISTORY_MSG_MAX) });
  if (history.length > HISTORY_MAX * 2) history.splice(0, history.length - HISTORY_MAX * 2);
  ctx.save();
}

export default {
  async start(ctx) {
    await turn(ctx, ctx.config.prompt);
    return 'waiting';
  },
  async followUp(ctx, { text }) {
    await turn(ctx, text);
    return 'waiting';
  },
  // A chat whose turn was interrupted by a restart can simply continue with the next message.
  resumable: () => true,
};

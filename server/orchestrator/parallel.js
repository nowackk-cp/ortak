// parallel: the same task on N agents, each in its own git worktree (branch ortak/<runId>/<lane>).
// Each lane emits a `diff` when it finishes; POST /apply applies one of them to the real cwd.
import path from 'node:path';
import { existsSync } from 'node:fs';
import * as git from '../git.js';
import * as P from './prompts.js';
import { work } from './textcoder.js';
import { HttpError, safeName } from '../util.js';
import { realCwd } from '../adapters/base.js';

const DIFF_EVENT_MAX = 1_500_000;

export async function emitLaneDiff(ctx, lane) {
  try {
    const { diff, stats } = await git.worktreeDiff(lane.worktree, ctx.meta.git.base);
    const truncated = diff.length > DIFF_EVENT_MAX;
    ctx.emit({
      kind: 'diff', lane: lane.lane, diff: truncated ? diff.slice(0, DIFF_EVENT_MAX) : diff, stats, applicable: true,
      ...(truncated ? { truncated: true } : {}),
    });
    lane.stats = stats;
    ctx.save();
  } catch (err) {
    ctx.note(`${lane.title}: diff alınamadı: ${err.message}`, 'warn');
  }
}

const laneCwd = (ctx, lane) => realCwd(path.join(lane.worktree, ctx.meta.git.rel || ''));

async function runLane(ctx, lane, prompt) {
  let error = null;
  try {
    await work(ctx, lane.lane, { prompt, cwd: laneCwd(ctx, lane), permission: ctx.config.permission, system: P.parallelSystem });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    error = err;
  }
  await emitLaneDiff(ctx, lane); // partial work of a failed lane is still shown
  if (error) throw error;
}

async function runLanes(ctx, lanes, promptFor) {
  const results = await Promise.allSettled(lanes.map((l) => runLane(ctx, l, promptFor(l))));
  ctx.throwIfAborted();
  results.forEach((r, i) => {
    if (r.status === 'rejected') ctx.note(`${lanes[i].title} tamamlanamadı: ${r.reason?.message || r.reason}`, 'warn');
  });
  return results.filter((r) => r.status === 'fulfilled').length;
}

export default {
  async start(ctx) {
    const g = ctx.meta.git;
    if (await git.isDirty(g.top)) {
      ctx.note('Ana çalışma klasöründe commit edilmemiş değişiklikler var; ajanlar bunları görmez (HEAD üzerinden çalışırlar).', 'warn');
    }
    const lanes = ctx.lanes('worker');
    const ready = [];
    for (const lane of lanes) { // sequential: concurrent `git worktree add` fights over locks
      ctx.throwIfAborted();
      const name = safeName(lane.lane);
      const wt = path.join(g.worktreeDir, name);
      let branch = `ortak/${ctx.meta.id}/${name}`;
      if (await git.branchExists(g.top, branch)) branch += `-${Date.now().toString(36)}`;
      ctx.emit({ kind: 'agent', lane: lane.lane, event: { type: 'status', text: 'Çalışma ağacı hazırlanıyor…' } });
      try {
        await git.addWorktree(g.top, wt, branch, g.base);
        lane.worktree = realCwd(wt);
        lane.branch = branch;
        ctx.save();
        ready.push(lane);
      } catch (err) {
        ctx.emit({ kind: 'agent', lane: lane.lane, event: { type: 'error', message: err.message } });
      }
    }
    if (!ready.length) throw new Error('Hiçbir çalışma ağacı oluşturulamadı.');

    const ok = await runLanes(ctx, ready, () => ctx.config.prompt);
    if (!ok) throw new Error('Hiçbir ajan görevi tamamlayamadı.');
    ctx.note(`${ok}/${lanes.length} ajan tamamladı. Diff'leri karşılaştırıp birini uygulayabilirsiniz.`);
    return 'done';
  },

  checkFollowUp(meta, { lane }) {
    const lanes = meta.lanes.filter((l) => l.role === 'worker' && l.worktree && existsSync(l.worktree));
    if (lane && !lanes.some((l) => l.lane === lane)) throw new HttpError(409, `Bu ajanın çalışma ağacı yok: ${lane}`);
    if (!lanes.length) throw new HttpError(409, 'Devam edilecek çalışma ağacı yok.');
  },

  /** Follow-up continues in the same worktree(s): one lane if `lane` is given, else all. */
  async followUp(ctx, { text, lane }) {
    const lanes = ctx.lanes('worker').filter((l) => l.worktree && existsSync(l.worktree) && (!lane || l.lane === lane));
    const ok = await runLanes(ctx, lanes, (l) => (ctx.canResume(l.lane) ? text : P.parallelFollowFresh(ctx.config.prompt, l.lastText, text)));
    if (!ok) throw new Error('Hiçbir ajan isteği tamamlayamadı.');
    return 'done';
  },

  resumable: () => false,
};

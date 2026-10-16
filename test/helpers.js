// Test helpers: a throw-away git repo and a fake orchestrator context (same surface as
// server/orchestrator/context.js) whose agents are scripted per lane.
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

process.env.ORTAK_DATA ||= path.join(os.tmpdir(), `ortak-test-data-${process.pid}`);

export async function makeRepo(files = { 'README.md': '# deneme\n' }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ortak-test-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  for (const [rel, text] of Object.entries(files)) await put(dir, rel, text);
  run('add', '-A');
  run('commit', '-qm', 'ilk');
  return dir;
}

export async function put(dir, rel, content) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

export const editAgent = (id) => ({ id, name: id, capabilities: { edit: true, resume: true } });
export const textAgent = (id) => ({ id, name: id, capabilities: { edit: false, resume: true } });

/**
 * `lanes` = [{ lane, agentId, role, model?, title? }], `agents` = { agentId: adapter-like },
 * `script(laneId, opts, call)` returns the answer text (or throws). `call.n` counts that lane's turns.
 */
export function fakeCtx({ cwd, lanes, agents, config = {}, script, git = true, state = {} }) {
  const meta = {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    cwd,
    git: git ? { top: cwd } : null,
    lanes: lanes.map((l) => ({ title: l.title || `${l.agentId}-${l.lane}`, ...l })),
    config: { prompt: 'Hedef: test', permission: 'edit', ...config },
    state,
  };
  const events = [];
  const calls = [];
  const counts = new Map();
  const ctrl = new AbortController();
  let sid = 0;
  const ctx = {
    meta,
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    events,
    calls,
    get config() { return meta.config; },
    get state() { return (meta.state ||= {}); },
    emit: (e) => events.push(e),
    note: (text, level = 'info') => events.push({ kind: 'note', text, level }),
    phase: (id, title) => events.push({ kind: 'phase', id, title }),
    save: () => {},
    lane: (id) => meta.lanes.find((l) => l.lane === id),
    lanes: (role) => meta.lanes.filter((l) => !role || l.role === role),
    adapterOf: (laneId) => agents[ctx.lane(laneId)?.agentId] || null,
    canResume(laneId) {
      const l = ctx.lane(laneId);
      return !!(l?.sessionId && agents[l.agentId]?.capabilities?.resume);
    },
    throwIfAborted() {
      if (ctrl.signal.aborted) { const e = new Error('iptal'); e.name = 'AbortError'; throw e; }
    },
    async turn(laneId, opts) {
      ctx.throwIfAborted();
      const lane = ctx.lane(laneId);
      const n = (counts.get(laneId) || 0) + 1;
      counts.set(laneId, n);
      const resumed = !!(opts.resume !== false && lane.sessionId);
      calls.push({ lane: laneId, n, resumed, prompt: opts.prompt, permission: opts.permission, system: opts.system });
      let text;
      try {
        text = await script(laneId, { ...opts, resumed }, { n, cwd, lane });
      } catch (err) {
        if (err.sawOutput === undefined) err.sawOutput = false;
        throw err;
      }
      if (!resumed) lane.sessionId = `s${++sid}`;
      return { text: String(text ?? ''), sessionId: lane.sessionId };
    },
  };
  return ctx;
}

export const notes = (ctx) => ctx.events.filter((e) => e.kind === 'note').map((e) => e.text);
export const callsOf = (ctx, lane) => ctx.calls.filter((c) => c.lane === lane);

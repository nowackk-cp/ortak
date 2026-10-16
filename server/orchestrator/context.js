// Per-activation context handed to mode implementations: event helpers + `turn()`, which runs
// one adapter turn on a lane and forwards every adapter event as { kind:'agent', lane, event }.
import { findAdapter } from '../limits.js';
import { AbortError, abortable, clip } from '../util.js';
import { realCwd } from '../adapters/base.js';
import { acquireSlot } from '../gate.js';
import { getSettings } from '../settings.js';
import { errorKind } from '../errors.js';
import { CHAT_SURFACE } from './prompts.js';

const OUTPUT_EVENTS = new Set(['text-delta', 'message', 'tool-start', 'tool-end']);
const RETRY_DELAYS = [20_000, 60_000]; // transient errors: two retries

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new AbortError()); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The error a turn ends with when only that lane was stopped (ctx.stopLane), not the whole run. */
export function stoppedError() {
  const e = new Error('Durduruldu: bu ajanın turu elle durduruldu.');
  e.code = 'stopped';
  e.sawOutput = true; // never retried in a fresh session
  return e;
}

/**
 * `live` (optional) = the activity's mailbox in index.js: messages the user sends while it runs go
 * to `live.listener` ({ accepts?(msg), deliver(msg) }, set with ctx.listen) or wait for the end.
 */
export async function makeContext(store, run, signal, live = null) {
  const meta = run.meta;
  const laneStops = new Map(); // lane -> AbortController of its running turn
  const adapters = new Map();
  for (const l of meta.lanes) {
    if (!adapters.has(l.agentId)) adapters.set(l.agentId, await findAdapter(l.agentId));
  }
  const phaseIds = new Set(store.events(run).filter((e) => e.kind === 'phase').map((e) => e.id));

  const ctx = {
    run,
    meta,
    signal,
    get config() { return meta.config; },
    get state() { return (meta.state ||= {}); },

    emit: (payload) => store.append(run, payload),
    note: (text, level = 'info') => store.append(run, { kind: 'note', text, level }),
    phase(id, title) {
      let uid = id;
      for (let n = 2; phaseIds.has(uid); n++) uid = `${id}-${n}`;
      phaseIds.add(uid);
      return store.append(run, { kind: 'phase', id: uid, title });
    },
    save: () => store.saveMeta(run, true),
    lane: (id) => meta.lanes.find((l) => l.lane === id),
    lanes: (role) => meta.lanes.filter((l) => !role || l.role === role),
    adapterOf: (laneId) => adapters.get(ctx.lane(laneId)?.agentId) || null,
    /** Loads the adapters of `agentIds` so lanes on them can be added without waiting. */
    async ensureAdapters(agentIds) {
      for (const id of agentIds) if (!adapters.has(id)) adapters.set(id, await findAdapter(id));
    },
    /**
     * Adds a lane while the run goes on (lead mode: another copy of a model, a model the lead picked
     * from the catalog). Its adapter must be loaded (ensureAdapters). Resolves the lane.
     * `spec` = { agentId, model, role, title, tier }; the id is `agentId`, `agentId#2`, …
     */
    addLane(spec) {
      if (!adapters.get(spec.agentId)) throw new Error(`Ajan yüklenmedi: ${spec.agentId}`);
      let lane = spec.agentId;
      for (let n = 2; meta.lanes.some((l) => l.lane === lane); n++) lane = `${spec.agentId}#${n}`;
      const l = { lane, agentId: spec.agentId, model: spec.model ?? null, role: spec.role || 'worker', title: spec.title || spec.agentId, ...(spec.tier ? { tier: spec.tier } : {}) };
      meta.lanes.push(l);
      store.append(run, { kind: 'lane', lane, agentId: l.agentId, model: l.model, role: l.role, title: l.title, tier: l.tier });
      store.saveMeta(run, true);
      return l;
    },
    /**
     * Messages the user writes while this activity runs: `listener` = { accepts?(msg), deliver(msg) }
     * with msg = { text, lane }; null = not listening (messages wait until the activity ends).
     */
    listen(listener) {
      if (live) live.listener = listener || null;
    },
    /** Stops the running turn of one lane only; it fails with stoppedError(). False if idle. */
    stopLane(laneId) {
      const c = laneStops.get(laneId);
      if (!c || c.signal.aborted) return false;
      c.abort();
      return true;
    },
    canResume(laneId) {
      const l = ctx.lane(laneId);
      return !!(l?.sessionId && adapters.get(l.agentId)?.capabilities?.resume);
    },
    throwIfAborted() {
      if (signal.aborted) throw new AbortError();
    },

    /**
     * Run one turn. Resolves { text, sessionId }. On failure rejects with the adapter error
     * (err.sawOutput tells whether the agent produced anything before failing).
     */
    async turn(laneId, { prompt, permission = 'read-only', system, cwd, resume = true, tools }) {
      ctx.throwIfAborted();
      const lane = ctx.lane(laneId);
      if (!lane) throw new Error(`Bilinmeyen şerit: ${laneId}`);
      const adapter = adapters.get(lane.agentId);
      if (!adapter) {
        const err = new Error(`Ajan bulunamadı: ${lane.agentId}`);
        store.append(run, { kind: 'agent', lane: laneId, event: { type: 'error', message: err.message } });
        throw err;
      }
      const useSession = resume && adapter.capabilities?.resume ? lane.sessionId : undefined;
      // Sohbet arayüzü: every agent is told it is a plain conversation (no project, no tools).
      if (meta.config?.surface === 'chat') system = [system, CHAT_SURFACE].filter(Boolean).join('\n\n');
      let sawError = false, sawDone = false, sawOutput = false;
      const setSession = (sid) => {
        if (sid && typeof sid === 'string' && sid !== lane.sessionId) {
          lane.sessionId = sid;
          store.saveMeta(run, true);
        }
      };

      run.busy.add(laneId);
      let release = null;
      // this turn's own signal: the run's, plus ctx.stopLane for this lane alone
      const own = new AbortController();
      const onRunAbort = () => own.abort();
      signal.addEventListener('abort', onRunAbort, { once: true });
      laneStops.set(laneId, own);
      const tsignal = own.signal;
      try {
        // Heavy local CLIs (Claude Code, Codex) share a machine-wide limit (setting maxConcurrent).
        if (adapter.capabilities?.localProcess) {
          release = await acquireSlot({
            signal: tsignal,
            onWait: () => store.append(run, { kind: 'agent', lane: laneId, event: {
              type: 'status',
              text: `Sırada: aynı anda en fazla ${getSettings().maxConcurrent} ajan çalışıyor (Performans ayarı)`,
            } }),
          });
        }
        // Images the user attached that this lane hasn't seen yet (agents that can see images only;
        // the others get the file paths in the message text — attachments.js).
        const allImages = meta.state?.images || [];
        const images = adapter.capabilities?.images ? allImages.slice(lane.imagesSeen || 0) : [];
        const attempt = () => abortable(Promise.resolve().then(() => adapter.run({
          prompt,
          ...(images.length ? { images: images.map(({ name, mime, path }) => ({ name, mime, path })) } : {}),
          cwd: realCwd(cwd || meta.cwd),
          model: lane.model || undefined,
          sessionId: useSession,
          permission,
          system,
          // Real function calling for API agents (textcoder.js runs the tools).
          ...(tools ? { tools } : {}),
          signal: tsignal,
          onEvent: (ev) => {
            if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
            if (ev.type === 'error') sawError = true;
            if (ev.type === 'done') { sawDone = true; setSession(ev.sessionId); }
            if (OUTPUT_EVENTS.has(ev.type)) sawOutput = true;
            store.append(run, { kind: 'agent', lane: laneId, event: ev });
          },
        })), tsignal);
        let res;
        for (let n = 0; ; n++) {
          try {
            res = await attempt();
            break;
          } catch (err) {
            // Transient failures (overload, network, a token refresh race between Claude Code
            // processes…) that happened before any output are retried after a pause.
            if (err?.name === 'AbortError' || tsignal.aborted || sawOutput || err?.code === 'tools_unsupported' || n >= RETRY_DELAYS.length || errorKind(err) !== 'transient') throw err;
            const secs = RETRY_DELAYS[n] / 1000;
            store.append(run, { kind: 'agent', lane: laneId, event: {
              type: 'status', retry: true,
              text: `Geçici hata (${clip(err.message || String(err), 160)}); ${secs} sn sonra yeniden deneniyor (${n + 1}/${RETRY_DELAYS.length})`,
            } });
            release?.();
            release = null;
            await waitFor(RETRY_DELAYS[n], tsignal);
            if (adapter.capabilities?.localProcess) release = await acquireSlot({ signal: tsignal });
            sawError = false;
            sawDone = false;
          }
        }
        const text = typeof res?.text === 'string' ? res.text : '';
        setSession(res?.sessionId);
        if (res?.usage && typeof res.usage === 'object') {
          const u = (lane.usage ||= { inputTokens: 0, outputTokens: 0, costUsd: 0 });
          u.inputTokens += Number(res.usage.inputTokens) || 0;
          u.outputTokens += Number(res.usage.outputTokens) || 0;
          u.costUsd += Number(res.usage.costUsd) || 0;
          store.saveMeta(run);
        }
        if (!sawDone) {
          store.append(run, { kind: 'agent', lane: laneId, event: { type: 'done', text, sessionId: lane.sessionId } });
        }
        if (images.length) { lane.imagesSeen = allImages.length; store.saveMeta(run); }
        lane.lastText = clip(text, 4000);
        return { text, sessionId: lane.sessionId };
      } catch (err) {
        if (signal.aborted) throw new AbortError();
        if (tsignal.aborted) {
          store.append(run, { kind: 'agent', lane: laneId, event: { type: 'error', message: 'Durduruldu.' } });
          throw stoppedError();
        }
        if (err?.name === 'AbortError') throw new AbortError();
        const message = err?.message || String(err);
        // A model that rejects tools is not an error for the user: textcoder.js falls back to the text protocol.
        if (!sawError && err?.code !== 'tools_unsupported') store.append(run, { kind: 'agent', lane: laneId, event: { type: 'error', message } });
        const e = err instanceof Error ? err : new Error(message);
        e.sawOutput = sawOutput;
        throw e;
      } finally {
        release?.();
        run.busy.delete(laneId);
        signal.removeEventListener('abort', onRunAbort);
        if (laneStops.get(laneId) === own) laneStops.delete(laneId);
      }
    },
  };
  return ctx;
}

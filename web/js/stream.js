// EventSource wrapper for /api/runs/:id/events. Reconnects with ?since=<last seq> so events are
// never applied twice (the consumer also drops seq <= last seen).
import { enc } from './util.js';

const KINDS = ['run', 'lane', 'phase', 'user', 'agent', 'diff', 'note', 'result'];

export class RunStream {
  /**
   * @param {string} runId
   * @param {{ since: () => number, onEvent: (ev) => void, onState?: (s: 'open'|'retry'|'closed') => void, shouldRetry?: () => boolean }} o
   */
  constructor(runId, o) {
    this.runId = runId;
    this.o = o;
    this.es = null;
    this.timer = 0;
    this.retry = 0;
    this.stopped = true;
  }

  get active() {
    return !this.stopped;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.retry = 0;
    this.#connect();
  }

  #connect() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const es = new EventSource(`/api/runs/${enc(this.runId)}/events?since=${Math.max(0, this.o.since() || 0)}`);
    this.es = es;
    const onMsg = (e) => {
      if (!e.data) return;
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      this.retry = 0;
      this.o.onEvent(ev);
    };
    es.onmessage = onMsg;
    for (const k of KINDS) es.addEventListener(k, onMsg);
    es.onopen = () => { this.retry = 0; this.o.onState?.('open'); };
    es.onerror = () => {
      es.close();
      if (this.es === es) this.es = null;
      if (this.stopped) return;
      if (this.o.shouldRetry && !this.o.shouldRetry()) {
        this.stopped = true;
        this.o.onState?.('closed');
        return;
      }
      const delay = Math.min(10000, 600 * 2 ** this.retry++);
      this.o.onState?.('retry');
      this.timer = setTimeout(() => this.#connect(), delay);
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.es) { this.es.close(); this.es = null; }
  }
}

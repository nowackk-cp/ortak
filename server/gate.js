// Concurrency gate for agent turns that start a local CLI process (capabilities.localProcess:
// Claude Code, Codex). Brainstorm/parallel runs would otherwise start one heavy process per
// participant at the same time; extra turns wait here until a slot frees up.
// The limit is the `maxConcurrent` setting (0 = unlimited) and changes take effect immediately.
import { getSettings, onSettingsChange } from './settings.js';
import { AbortError } from './util.js';

let active = 0;
const waiting = []; // { grant, fail, signal, onAbort }

const limit = () => getSettings().maxConcurrent || Infinity;

function pump() {
  while (waiting.length && active < limit()) {
    const w = waiting.shift();
    w.signal?.removeEventListener('abort', w.onAbort);
    active++;
    w.grant();
  }
}

onSettingsChange(pump);

/**
 * Waits for a slot. Resolves a `release()` function (call it exactly once). `onWait(position)` is
 * called once if the caller has to queue. Rejects with AbortError if `signal` aborts first.
 */
export function acquireSlot({ signal, onWait } = {}) {
  if (signal?.aborted) return Promise.reject(new AbortError());
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active--;
    pump();
  };
  if (active < limit()) {
    active++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const w = {
      signal,
      grant: () => resolve(release),
      onAbort: () => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        reject(new AbortError());
      },
    };
    signal?.addEventListener('abort', w.onAbort, { once: true });
    waiting.push(w);
    try { onWait?.(waiting.length); } catch { /* listener error */ }
  });
}

export const gateStats = () => ({ active, waiting: waiting.length, limit: getSettings().maxConcurrent });

// Small shared helpers for the core server (not adapters).
import { AbortError } from './adapters/base.js';

export { AbortError };

/** Error that carries an HTTP status; `extra` is merged into the JSON body. */
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAbortError(err, signal) {
  return err?.name === 'AbortError' || (signal?.aborted ?? false);
}

/** Keep the head of a string. */
export function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(0, n) + `\n…(${s.length - n} karakter kısaltıldı)` : s;
}

/** Keep the tail of a string. */
export function clipTail(text, n) {
  const s = String(text ?? '');
  return s.length > n ? '…' + s.slice(s.length - n) : s;
}

/** First ~n chars of the first meaningful line(s), whitespace collapsed. */
export function makeTitle(prompt, n = 60) {
  const s = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s || 'Adsız';
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/** Resolve after `promise`, but reject with AbortError `graceMs` after `signal` aborts even if the
 *  adapter ignores the signal (so a misbehaving adapter can never wedge a run). */
export function abortable(promise, signal, graceMs = 5000) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => { timer = setTimeout(() => reject(new AbortError()), graceMs); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const done = () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    promise.then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
  });
}

/** Branch/file-name safe version of a lane id: "claude#2" -> "claude-2". */
export function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'lane';
}

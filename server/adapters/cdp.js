// Minimal Chrome DevTools Protocol client for the Gemini web bridge (geminiweb.js).
//
// Ortak runs its own Chrome window with a dedicated profile (data/gemini-profile). The user signs
// in to Google there themselves; Ortak never sees or stores credentials — it only drives the page
// (types the prompt, clicks send, reads the answer) like a user would.
//
// The debugging port is random (--remote-debugging-port=0, bound to 127.0.0.1) and read from the
// profile's DevToolsActivePort file. Node 24's global WebSocket is used, so no dependencies.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AbortError, lowerPriority } from './base.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA = path.resolve(process.env.ORTAK_DATA || path.join(ROOT, 'data'));
export const PROFILE = path.join(DATA, 'gemini-profile');
export const START_URL = 'https://gemini.google.com/app';

export function browserExe() {
  const env = process.env;
  const candidates = process.platform === 'win32'
    ? [
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => p && existsSync(p)) || null;
}

/** Port of the bridge browser if it is running (DevToolsActivePort answers), else null. */
export async function activePort() {
  let port;
  try { port = Number(readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); } catch { return null; }
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? port : null;
  } catch {
    return null;
  }
}

/**
 * Google refuses sign-in ("this browser may not be secure") in a browser started with a debugging
 * port. So signing in happens in a normal window on the same profile; the cookies stay in the
 * profile and the debug-mode window that Ortak drives afterwards is already signed in.
 */
export function openSignInWindow() {
  const exe = browserExe();
  if (!exe) throw new Error('Chrome veya Edge bulunamadı; Gemini köprüsü için biri kurulu olmalı.');
  mkdirSync(PROFILE, { recursive: true });
  spawn(exe, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,900', START_URL],
    { detached: true, stdio: 'ignore' }).unref();
}

/** Closes the bridge browser (debug mode) if it runs. */
export async function closeBrowser() {
  const port = await activePort();
  if (!port) return;
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 1500));
  } catch { /* already gone */ }
}

/**
 * Opens the bridge window (or does nothing if it already runs). Resolves with the port.
 * `minimized`: start it minimized (used when a turn opens it on demand, so no window pops up).
 */
export async function launchBrowser({ timeoutMs = 20000, minimized = false } = {}) {
  const running = await activePort();
  if (running) return running;
  const exe = browserExe();
  if (!exe) throw new Error('Chrome veya Edge bulunamadı; Gemini köprüsü için biri kurulu olmalı.');
  mkdirSync(PROFILE, { recursive: true });
  // A stale DevToolsActivePort from the last debug session would make the wait below succeed early.
  try { unlinkSync(path.join(PROFILE, 'DevToolsActivePort')); } catch { /* none */ }
  const child = spawn(exe, [
    `--user-data-dir=${PROFILE}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // Ortak drives the page while the window sits behind other windows: without these Chrome marks
    // it hidden and pauses the answer's reveal animation (aria-busy never clears).
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1100,900',
    `--app=${START_URL}`,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  lowerPriority(child.pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const port = await activePort();
    if (port) {
      if (minimized) await setWindowState(port, 'minimized').catch(() => {});
      return port;
    }
  }
  // Most likely the normal sign-in window still holds the profile: Chrome then just opens a tab in
  // that (non-debug) process.
  throw new Error('Gemini penceresi köprü modunda açılamadı. Giriş için açtığın Gemini penceresi hâlâ açıksa kapatıp tekrar deneyin.');
}

/** Browser-level CDP call (one short-lived connection). */
async function browserCall(port, method, params = {}) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP')); });
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP zaman aşımı (${method})`)), 5000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        clearTimeout(t);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    try { ws.close(); } catch { /* closed */ }
  }
}

/** Minimize / restore the bridge window ('minimized' | 'normal'). */
export async function setWindowState(port, windowState) {
  const page = (await listPages(port))[0];
  if (!page) return;
  const { windowId } = await browserCall(port, 'Browser.getWindowForTarget', { targetId: page.id });
  await browserCall(port, 'Browser.setWindowBounds', { windowId, bounds: { windowState } });
}

export async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  return (await res.json()).filter((t) => t.type === 'page');
}

export async function newPage(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  return res.json();
}

/** One WebSocket session to a page target. */
export class Page {
  static async connect(wsUrl) {
    const p = new Page(wsUrl);
    await p.ready;
    return p;
  }

  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('Gemini sayfasına bağlanılamadı.')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP hatası'));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) { try { fn(msg); } catch { /* listener error */ } }
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('Gemini penceresi kapandı.'));
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Gemini penceresi kapandı.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gemini sayfası cevap vermedi (${method}).`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates `fn` (a function, serialized) with JSON-able `args` in the page; returns its value. */
  async eval(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text || 'Sayfa betiği hatası');
    return r.result?.value;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new AbortError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

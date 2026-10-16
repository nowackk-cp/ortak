// Ortak HTTP server: static web UI + REST + SSE. Binds to 127.0.0.1 only.
//   node server/index.js [--mock]        (env: ORTAK_PORT, ORTAK_DATA, ORTAK_AGENTS)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RunStore, publicMeta } from './runs.js';
import { Orchestrator } from './orchestrator/index.js';
import { findAdapter, getAgents, getLimits } from './limits.js';
import { repoInfo } from './git.js';
import { HttpError } from './util.js';
import { realCwd } from './adapters/base.js';
import { DEFAULTS, getSettings, updateSettings } from './settings.js';
import { gateStats } from './gate.js';
import { servedPath } from './attachments.js';
import { BUDGETS, DEFAULT_BUDGET, autoTeam } from './tiers.js';
import { buildCatalog } from './catalog.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
fs.mkdirSync(path.resolve(process.env.ORTAK_DATA || path.join(ROOT, 'data')), { recursive: true });
const DATA = realCwd(path.resolve(process.env.ORTAK_DATA || path.join(ROOT, 'data'))); // long form (no 8.3 names)
const PORT = Number(process.env.ORTAK_PORT) || 4747;
const BIND = '127.0.0.1';
const BODY_MAX = 64 * 1024 * 1024; // attached images travel as base64
const PING_MS = 15_000;

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const PLACEHOLDER = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Ortak</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;background:#fafafa;color:#222}
code{background:#eee;padding:.1rem .3rem;border-radius:3px}</style></head>
<body><h1>Ortak çalışıyor</h1><p>Arayüz henüz yok (<code>web/index.html</code> bulunamadı).
API <code>/api/agents</code>, <code>/api/runs</code> adreslerinde hazır.</p></body></html>`;

const store = new RunStore(DATA);
const orch = new Orchestrator(store, { dataDir: DATA });

// ---- helpers ----------------------------------------------------------------------------------

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

const sendError = (res, status, message, extra) => sendJson(res, status, { ...(extra || {}), error: message });

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX) throw new HttpError(413, 'İstek gövdesi çok büyük.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Geçersiz JSON.');
  }
}

// ---- SSE --------------------------------------------------------------------------------------

function streamEvents(req, res, run, url) {
  const q = Number(url.searchParams.get('since'));
  const h = Number(req.headers['last-event-id']);
  const since = Math.max(Number.isFinite(q) ? q : 0, Number.isFinite(h) ? h : 0);

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let closed = false;
  const send = (e) => {
    if (closed) return;
    if (e === null) { cleanup(); res.end(); return; } // run deleted
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  // Replay and subscribe in the same tick so no event can fall in between.
  for (const e of store.events(run)) if (e.seq > since) send(e);
  const unsubscribe = store.subscribe(run, send);
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, PING_MS);
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unsubscribe();
  }
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ---- fs helpers -------------------------------------------------------------------------------

async function fsCheck(p) {
  if (typeof p !== 'string' || !p.trim()) throw new HttpError(400, 'Yol (path) gerekli.');
  const abs = realCwd(path.resolve(p.trim()));
  let st = null;
  try { st = await fsp.stat(abs); } catch { /* missing */ }
  if (!st) return { path: abs, exists: false, isDir: false, isGit: false };
  if (!st.isDirectory()) return { path: abs, exists: true, isDir: false, isGit: false };
  const info = await repoInfo(abs);
  return {
    path: abs, exists: true, isDir: true, isGit: info.isGit,
    ...(info.isGit ? { branch: info.branch, hasCommits: !!info.head, root: info.top } : {}),
  };
}

/** Folder browser for the UI (extra, read-only): `{ path, parent, dirs: [{ name, path }] }`. */
async function fsList(p) {
  if (!p || !String(p).trim()) {
    if (process.platform === 'win32') {
      const dirs = [];
      for (let c = 65; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        try { await fsp.access(d); dirs.push({ name: d, path: d }); } catch { /* no drive */ }
      }
      return { path: '', parent: null, dirs };
    }
    p = '/';
  }
  const abs = path.resolve(String(p).trim());
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    throw new HttpError(404, `Klasör okunamadı: ${abs}`);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }))
    .slice(0, 1000);
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? (process.platform === 'win32' ? '' : null) : parent, dirs };
}

// ---- API --------------------------------------------------------------------------------------

async function api(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;
  const refresh = searchParams.get('refresh') === '1';

  if (pathname === '/api/agents' && method === 'GET') return sendJson(res, 200, await getAgents({ refresh }));
  if (pathname === '/api/limits' && method === 'GET') return sendJson(res, 200, await getLimits({ refresh }));
  if (pathname === '/api/recent' && method === 'GET') return sendJson(res, 200, { cwds: store.getRecent() });
  if (pathname === '/api/fs/check' && method === 'GET') return sendJson(res, 200, await fsCheck(searchParams.get('path')));
  if (pathname === '/api/fs/list' && method === 'GET') return sendJson(res, 200, await fsList(searchParams.get('path')));
  if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, port: PORT });
  // The team lead mode would pick with `workers: 'auto'` (preview for the UI).
  if (pathname === '/api/team/auto' && method === 'GET') {
    const budget = BUDGETS.includes(searchParams.get('budget')) ? searchParams.get('budget') : DEFAULT_BUDGET;
    const lead = searchParams.get('lead') ? { agentId: searchParams.get('lead'), model: searchParams.get('leadModel') || null } : null;
    const agents = await getAgents({ refresh });
    // the starting team, and every model the lead may add to it (catalog.js)
    return sendJson(res, 200, { budget, workers: autoTeam(agents, { budget, lead }), catalog: await buildCatalog(agents, { budget }) });
  }
  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, { settings: getSettings(), defaults: DEFAULTS, gate: gateStats() });
    if (method === 'PUT') {
      let next;
      try { next = updateSettings(await readJson(req)); } catch (err) { throw new HttpError(400, err.message); }
      return sendJson(res, 200, { settings: next, defaults: DEFAULTS, gate: gateStats() });
    }
  }

  // Graceful stop (scripts/stop.mjs): cancels running agents, flushes runs, exits.
  if (pathname === '/api/shutdown' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => shutdown('api'), 100);
    return;
  }

  // Launch an agent's app/window (Antigravity desktop app, Gemini web bridge window).
  const sm = pathname.match(/^\/api\/agents\/([^/]+)\/start\/?$/);
  if (sm && method === 'POST') {
    const adapter = await findAdapter(decodeURIComponent(sm[1]));
    if (!adapter) return sendError(res, 404, 'Ajan bulunamadı.');
    if (typeof adapter.start !== 'function') return sendError(res, 400, 'Bu ajan buradan başlatılamaz.');
    const result = await adapter.start();
    await getAgents({ refresh: true });
    return sendJson(res, result?.ok === false ? 502 : 200, result?.ok === false ? { error: result.reason || 'Başlatılamadı.' } : { ok: true, ...result });
  }

  // Sign in / connect an account: the adapter opens the CLI's own login flow (terminal window or
  // browser). Ortak never sees the credentials.
  const lm = pathname.match(/^\/api\/agents\/([^/]+)\/login\/?$/);
  if (lm && method === 'POST') {
    const adapter = await findAdapter(decodeURIComponent(lm[1]));
    if (!adapter) return sendError(res, 404, 'Ajan bulunamadı.');
    if (typeof adapter.login !== 'function') return sendError(res, 400, 'Bu ajan için buradan giriş yapılamaz.');
    const result = await adapter.login();
    if (result?.ok === false) return sendError(res, 502, result.reason || 'Giriş başlatılamadı.');
    return sendJson(res, 200, { ok: true, ...result });
  }

  const am = pathname.match(/^\/api\/attachments\/([^/]+)\/([^/]+)$/);
  if (am && (method === 'GET' || method === 'HEAD')) {
    const file = servedPath(decodeURIComponent(am[1]), decodeURIComponent(am[2]));
    const st = file && await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) return sendError(res, 404, 'Dosya bulunamadı.');
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400' });
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  if (pathname === '/api/runs') {
    if (method === 'GET') return sendJson(res, 200, store.list().map(publicMeta));
    if (method === 'POST') return sendJson(res, 200, { runId: await orch.createRun(await readJson(req)) });
    return sendError(res, 405, 'İzin verilmeyen yöntem.');
  }

  const m = pathname.match(/^\/api\/runs\/([^/]+)(?:\/(events|message|cancel|stop-lane|apply|undo))?\/?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    const run = store.get(id);
    if (!run) return sendError(res, 404, 'Çalışma bulunamadı.');
    if (!action) {
      if (method === 'GET') return sendJson(res, 200, { meta: publicMeta(run.meta), events: store.events(run) });
      if (method === 'DELETE') return sendJson(res, 200, await orch.remove(id));
    } else if (action === 'events' && method === 'GET') {
      return streamEvents(req, res, run, url);
    } else if (method === 'POST') {
      const body = await readJson(req);
      if (action === 'message') return sendJson(res, 200, await orch.message(id, body));
      if (action === 'cancel') return sendJson(res, 200, orch.cancel(id));
      if (action === 'stop-lane') return sendJson(res, 200, orch.stopLane(id, body));
      if (action === 'apply') return sendJson(res, 200, await orch.apply(id, body));
      if (action === 'undo') return sendJson(res, 200, await orch.undo(id, body));
    }
    return sendError(res, 405, 'İzin verilmeyen yöntem.');
  }
  return sendError(res, 404, 'Bulunamadı.');
}

// ---- static -----------------------------------------------------------------------------------

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendError(res, 400, 'Geçersiz adres.'); }
  if (rel.includes('\0') || rel.includes(':')) return sendError(res, 400, 'Geçersiz adres.');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB, path.normalize(rel));
  if (file !== WEB && !file.startsWith(WEB + path.sep)) return sendError(res, 403, 'Erişim reddedildi.');
  if (file.split(path.sep).slice(WEB.split(path.sep).length).some((seg) => seg.startsWith('.'))) {
    return sendError(res, 404, 'Bulunamadı.');
  }

  const fileStat = async (p) => { const st = await fsp.stat(p).catch(() => null); return st?.isFile() ? st : null; };
  let target = file;
  let st = await fsp.stat(target).catch(() => null);
  if (st?.isDirectory()) target = path.join(target, 'index.html');
  st = await fileStat(target);
  if (!st) {
    const index = path.join(WEB, 'index.html');
    const indexSt = await fileStat(index);
    if (rel === '/index.html' && !indexSt) { // no UI yet
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : PLACEHOLDER);
    }
    if (path.extname(rel) || !indexSt) {
      res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bulunamadı');
    }
    target = index; // SPA fallback for extension-less paths
    st = indexSt;
  }
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

// ---- request entry ----------------------------------------------------------------------------

async function handle(req, res) {
  // DNS-rebinding guard: only our own host:port is accepted.
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return sendError(res, 403, `Geçersiz Host başlığı. Ortak'a yalnızca http://127.0.0.1:${PORT} adresinden erişilebilir.`);
  }
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin !== undefined && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) {
      return sendError(res, 403, 'Farklı bir kaynaktan (Origin) gelen istek reddedildi.');
    }
    // JSON forces a CORS preflight for cross-site pages. A body-less request (cancel/DELETE from
    // the UI) may omit Content-Type only when it carries our own Origin: cross-site browsers
    // always send their Origin, which was rejected above.
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const bodyless = !req.headers['transfer-encoding'] && (req.headers['content-length'] ?? '0') === '0';
    if (ct !== 'application/json' && !(bodyless && origin !== undefined)) {
      return sendError(res, 415, 'İstek türü (Content-Type) application/json olmalı.');
    }
  }
  let url;
  try { url = new URL(req.url, `http://${host}`); } catch { return sendError(res, 400, 'Geçersiz adres.'); }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(req, res, url);
  if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'İzin verilmeyen yöntem.');
  return serveStatic(req, res, url.pathname);
}

// ---- boot -------------------------------------------------------------------------------------

await store.init();
orch.recover();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[http]', err);
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, status, status >= 500 ? `Sunucu hatası: ${err?.message || err}` : err.message, err?.extra);
  });
});
server.keepAliveTimeout = 5_000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} kullanımda. Başka bir port için ORTAK_PORT ortam değişkenini ayarlayın.`);
  else console.error('Sunucu başlatılamadı:', err.message);
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  const mock = process.argv.includes('--mock') || process.env.ORTAK_MOCK === '1';
  console.log(`Ortak çalışıyor: http://127.0.0.1:${PORT}${mock ? '  (test ajanı açık)' : ''}`);
  console.log(`Veri klasörü: ${DATA}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} alındı, kapatılıyor…`);
  server.close();
  try {
    await orch.shutdown();
    await store.flushAll();
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

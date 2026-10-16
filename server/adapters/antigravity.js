// Google Antigravity adapter. See docs/CONTRACT.md §1.
//
// Antigravity 2.x is an Electron app that spawns `language_server.exe` with
// `--csrf_token <uuid> --https_server_port 0`. Besides the HTTPS (gRPC) port the language server
// listens on a second, plain-HTTP port on 127.0.0.1 that speaks Connect (JSON over HTTP/1.1):
//   POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>
//   headers: content-type: application/json, x-codeium-csrf-token: <csrf>
// That address is exactly what Antigravity hands its own terminals/sidecars as
// ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN, and what the shipped `agentapi` CLI
// (`language_server.exe agentapi …`) talks to (over gRPC).
//
// Discovery: env vars (when Ortak itself runs inside an Antigravity terminal) or the
// language_server process command line (CSRF, version) + its listening ports, probed over HTTP.
//
// We call the same RPCs `agentapi new-conversation` uses (StartCascade with
// source=AGENT_API and the same customAgentSpec), then SendUserCascadeMessage, directly from
// Node. Reasons: no argv/cmd.exe involvement for user text (no 32K command-line limit, no
// quoting issues), streaming of steps by polling GetCascadeTrajectorySteps, real cancel via
// CancelCascadeInvocation, per-turn model selection, and the full model list the Antigravity UI
// offers (agentapi only knows flash_lite|flash|pro). Permissions: see buildCascadeConfig().
//
// Only the user's running app and its local server are used. No OAuth tokens are read, and no
// Google endpoint is called directly. The CSRF token is a local per-session token and is never
// logged or returned.
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { AbortError, IS_WIN, which, truncate, lowerPriority } from './base.js';
import { getSettings, onSettingsChange, dataDir } from '../settings.js';
import { isMutatingCommand } from '../commands.js';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const NOT_RUNNING = 'Antigravity açık değil — uygulamayı başlatın';
const NOT_INSTALLED = 'Antigravity kurulu değil (https://antigravity.google)';

const POLL_MS = 450;
const RPC_TIMEOUT_MS = 15000;
const WAITING_LIMIT_MS = 180000; // a step waiting for approval longer than this => cancel
const MODELS_TTL_MS = 60000;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new AbortError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// ---------------------------------------------------------------------------
// Installation paths
// ---------------------------------------------------------------------------

function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

function installDir() {
  if (process.env.ORTAK_ANTIGRAVITY_DIR) return process.env.ORTAK_ANTIGRAVITY_DIR;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity');
  if (process.platform === 'darwin') return '/Applications/Antigravity.app/Contents';
  return '/usr/share/antigravity';
}

function appExe() {
  const dir = installDir();
  const candidates = IS_WIN
    ? [path.join(dir, 'Antigravity.exe')]
    : process.platform === 'darwin'
      ? [path.join(dir, 'MacOS', 'Antigravity')]
      : [path.join(dir, 'antigravity'), which('antigravity')];
  return candidates.find((p) => p && isFile(p)) || null;
}

function lsExe() {
  const dir = installDir();
  const p = path.join(dir, 'resources', 'bin', IS_WIN ? 'language_server.exe' : 'language_server');
  return isFile(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Language server discovery
// ---------------------------------------------------------------------------

function execText(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

/** Lists running language servers: [{ pid, cmd, ports }]. `cmd` contains the CSRF token: never log it. */
async function listLanguageServers() {
  if (IS_WIN) {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -match '--csrf_token' } | ForEach-Object {",
      "  [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; ports = @(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | ForEach-Object { $_.LocalPort }) }",
      '} | ConvertTo-Json -Compress -Depth 3',
    ].join('\n');
    const out = (await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 8000)).trim();
    if (!out) return [];
    try {
      const parsed = JSON.parse(out);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.pid, cmd: String(p.cmd || ''), ports: [].concat(p.ports || []).map(Number) }));
    } catch { return []; }
  }
  // POSIX best effort: ps + lsof.
  const ps = await execText('ps', ['-axww', '-o', 'pid=,args='], 5000);
  const procs = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !/language_server/.test(m[2]) || !/--csrf_token/.test(m[2])) continue;
    const lsof = await execText('lsof', ['-nP', '-a', '-p', m[1], '-iTCP', '-sTCP:LISTEN', '-Fn'], 5000);
    const ports = [...lsof.matchAll(/^n.*:(\d+)$/gm)].map((x) => Number(x[1]));
    procs.push({ pid: Number(m[1]), cmd: m[2], ports });
  }
  return procs;
}

function argValue(cmd, name) {
  const m = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)("[^"]*"|\\S+)`).exec(cmd);
  return m ? m[1].replace(/^"|"$/g, '') : undefined;
}

/** Low-level Connect/JSON call. Never includes the CSRF token in errors. */
function rawRpc(conn, method, body, { signal, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      host: conn.host, port: conn.port, method: 'POST', path: SERVICE + method,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-codeium-csrf-token': conn.csrf },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        cleanup();
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
        if (res.statusCode === 200 && json) return resolve(json);
        const msg = (json && json.message) || text.slice(0, 200) || `HTTP ${res.statusCode}`;
        const err = new Error(String(msg).replace(/\s*\(error ID: [0-9a-f]+\)/i, ''));
        err.status = res.statusCode;
        err.code = json?.code;
        reject(err);
      });
      res.on('error', (e) => { cleanup(); reject(e); });
    });
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => req.destroy(Object.assign(new Error('Antigravity yanıt vermedi (zaman aşımı)'), { code: 'ETIMEDOUT' })), timeoutMs);
    const onAbort = () => req.destroy(new AbortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    function cleanup() { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    req.on('error', (e) => { cleanup(); reject(signal?.aborted ? new AbortError() : e); });
    req.end(data);
  });
}

let cachedConn = null;
let discovering = null;
// Discovery (PowerShell + process/port listing) is the expensive part. While the app is closed,
// remember the miss for a while instead of rediscovering on every detect/limits/models call.
let lastMiss = 0;
const MISS_TTL_MS = 30000;

async function discover() {
  // 1) Running inside an Antigravity terminal / sidecar.
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (envAddr && envCsrf) {
    const m = /^(?:https?:\/\/)?([^:/]+):(\d+)/.exec(envAddr);
    if (m) {
      const conn = { host: m[1] === 'localhost' ? '127.0.0.1' : m[1], port: Number(m[2]), csrf: envCsrf, source: 'env' };
      try { await rawRpc(conn, 'GetStatus', {}, { timeoutMs: 3000 }); return conn; } catch { /* fall through */ }
    }
  }
  // 2) The desktop app's language server.
  const procs = await listLanguageServers();
  // Prefer the Antigravity 2.x app ("--subclient_type hub") over e.g. an IDE-embedded server.
  procs.sort((a, b) => Number(/subclient_type[ =]hub/.test(b.cmd)) - Number(/subclient_type[ =]hub/.test(a.cmd)));
  for (const p of procs) {
    const csrf = argValue(p.cmd, 'csrf_token');
    if (!csrf) continue;
    const version = argValue(p.cmd, 'override_ide_version');
    const httpsPort = Number(argValue(p.cmd, 'https_server_port')) || -1;
    // The plain-HTTP port is usually https+1, so try higher ports first.
    const ports = [...new Set(p.ports)].filter((x) => x && x !== httpsPort).sort((a, b) => b - a);
    for (const port of ports) {
      const conn = { host: '127.0.0.1', port, csrf, pid: p.pid, version, source: 'process' };
      try { await rawRpc(conn, 'GetStatus', {}, { timeoutMs: 2500 }); return conn; } catch { /* next port */ }
    }
  }
  return null;
}

/** Returns a working connection or null. Cached; re-validated cheaply. */
async function getConn({ fresh = false } = {}) {
  if (cachedConn && !fresh) {
    try { await rawRpc(cachedConn, 'GetStatus', {}, { timeoutMs: 2500 }); return cachedConn; } catch { cachedConn = null; }
  }
  if (!fresh && Date.now() - lastMiss < MISS_TTL_MS) return null;
  if (!discovering) discovering = discover().finally(() => { discovering = null; });
  cachedConn = await discovering;
  lastMiss = cachedConn ? 0 : Date.now();
  return cachedConn;
}

function isConnError(err) {
  return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err?.code) || err?.status === 401;
}

/** RPC with one automatic re-discovery (the app restarts its LS on a new port after crashes). */
async function call(method, body, opts = {}) {
  let conn = await getConn();
  if (!conn) throw new Error(NOT_RUNNING);
  try {
    return await rawRpc(conn, method, body, opts);
  } catch (err) {
    if (err.name === 'AbortError' || !isConnError(err) || opts.noRetry) throw err;
    conn = await getConn({ fresh: true });
    if (!conn) throw new Error(NOT_RUNNING);
    return rawRpc(conn, method, body, opts);
  }
}

// ---------------------------------------------------------------------------
// Models & limits
// ---------------------------------------------------------------------------

const TIER_ALIASES = { flash_lite: 'flashLite', flash: 'flash', pro: 'pro' };
const FALLBACK_MODELS = [
  { id: 'flash', label: 'Gemini Flash (Antigravity varsayılanı)', default: true },
  { id: 'pro', label: 'Gemini Pro' },
  { id: 'flash_lite', label: 'Gemini Flash Lite (en az kota)' },
];

let modelsCache = null; // { at, data }

/** GetAvailableModels → { models: {key: {...}}, agentIds, tiers, defaultId } */
async function fetchModels({ fresh = false } = {}) {
  if (!fresh && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.data;
  const r = await call('GetAvailableModels', {}, { timeoutMs: 8000 });
  const resp = r.response || r;
  const models = resp.models || {};
  const agentIds = [];
  for (const sort of resp.agentModelSorts || []) for (const g of sort.groups || []) for (const id of g.modelIds || []) if (!agentIds.includes(id)) agentIds.push(id);
  const tiers = {};
  for (const [alias, key] of Object.entries(TIER_ALIASES)) {
    const id = (resp.tieredModelIds?.[key] || [])[0];
    if (id) tiers[alias] = id;
  }
  const data = { models, agentIds, tiers, defaultId: resp.defaultAgentModelId || agentIds[0] };
  modelsCache = { at: Date.now(), data };
  saveModelCache(data);
  return data;
}

// Last model list seen, kept on disk so the model picker works while Antigravity is closed.
const MODEL_CACHE_FILE = path.join(dataDir, 'cache', 'antigravity-models.json');

function saveModelCache(data) {
  try {
    const slim = {};
    for (const [k, v] of Object.entries(data.models)) {
      slim[k] = { displayName: v.displayName, model: v.model, disabled: v.disabled, tagDescription: v.tagDescription };
    }
    mkdirSync(path.dirname(MODEL_CACHE_FILE), { recursive: true });
    writeFileSync(MODEL_CACHE_FILE, JSON.stringify({ ...data, models: slim }));
  } catch { /* cache is best effort */ }
}

function readModelCache() {
  try { return JSON.parse(readFileSync(MODEL_CACHE_FILE, 'utf8')); } catch { return null; }
}

function modelLabel(key, info) {
  return info?.displayName || key;
}

/** Why the app shows a model as unavailable (e.g. "… available to Ultra plan subscribers."). */
function lockReason(info) {
  const d = String(info?.tagDescription || '').trim();
  return /ultra plan/i.test(d) ? 'Google AI Ultra planı gerekiyor' : d;
}

/** Maps an Ortak model id to the language server's Model enum (e.g. MODEL_PLACEHOLDER_M318). */
async function resolveModel(model) {
  let data = null;
  try { data = await fetchModels(); } catch { /* fall back below */ }
  if (!model) {
    const key = data?.defaultId;
    return key ? data.models[key]?.model : undefined;
  }
  if (/^MODEL_[A-Z0-9_]+$/.test(model)) return model;
  if (!data) throw new Error('Antigravity model listesi alınamadı');
  const key = TIER_ALIASES[model] ? data.tiers[model] : model;
  const info = key && data.models[key];
  if (!info?.model) throw new Error(`Bilinmeyen Antigravity modeli: ${model}`);
  if (info.disabled) throw new Error(`${modelLabel(key, info)} bu hesapta kullanılamıyor${lockReason(info) ? `: ${lockReason(info)}` : ''}. Başka bir model seçin.`);
  return info.model;
}

// ---------------------------------------------------------------------------
// Permissions → Antigravity tool configuration
// ---------------------------------------------------------------------------

// What we verified against Antigravity 2.23 (see report):
//  - The coding agent (`codingAgent.googleMode`, what agentapi uses) ignores toolConfig
//    `forceDisable` flags: run_command / write_to_file still execute.
//  - A `customAgent` with an explicit `toolNames` list does restrict tools, but it drops the
//    whole system prompt (no workspace info) and the model wanders off: unusable.
//  - The terminal sandbox needs Windows 11 24H2+.
// So permissions are enforced by (1) an instruction in the prompt and (2) a guard that watches
// the trajectory and cancels the invocation as soon as a forbidden tool call shows up. The guard
// detects and stops; it cannot undo a command that already ran.
const READ_ONLY_NOTE =
  'ÖNEMLİ: Bu görev salt-okunurdur. Hiçbir dosya oluşturma, değiştirme veya silme; dosya değiştiren ' +
  'veya kuran terminal komutu çalıştırma (yalnızca okuma/listeleme komutları serbest). Sadece oku, ' +
  'incele ve yanıtını yaz.';
const editNote = (cwd) =>
  `ÖNEMLİ: Yalnızca şu çalışma klasörünün içindeki dosyaları düzenle: ${cwd}. Bu klasörün dışında ` +
  'hiçbir şeyi değiştirme; paket kurma, git commit/push gibi kalıcı değişiklik yapan komutlar çalıştırma.';

function buildCascadeConfig(permission, planModel) {
  const toolConfig = permission === 'full'
    ? { autoAllowAllInteractions: true, runCommand: { autoCommandConfig: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' } } }
    // If something asks for approval, let the server time it out instead of hanging forever.
    : { userInteractionTimeoutSeconds: 60 };
  const plannerConfig = { toolConfig };
  if (planModel) plannerConfig.planModel = planModel;
  return { plannerConfig };
}

const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file',
  'create_file', 'delete_file', 'notebook_edit', 'edit_notebook']);
function isInside(file, dir) {
  const norm = (p) => { let r = path.resolve(p); try { r = realpathSync.native(r); } catch { /* may not exist yet */ } return IS_WIN ? r.toLowerCase() : r; };
  const rel = path.relative(norm(dir), norm(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Returns a Turkish description of a permission violation, or null. */
function violationOf(step, permission, cwd) {
  if (permission === 'full') return null;
  const tc = step.metadata?.toolCall || {};
  const name = tc.name || '';
  let args = {};
  try { args = JSON.parse(tc.argumentsJson || '{}'); } catch { /* ignore */ }
  const b = stepBody(step);
  const isWrite = WRITE_TOOLS.has(name) || step.type === 'CORTEX_STEP_TYPE_CODE_ACTION';
  const isCmd = name === 'run_command' || step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND';
  const command = isCmd ? String(args.CommandLine || b.commandLine || b.proposedCommandLine || '') : '';
  if (permission === 'read-only') {
    if (isWrite) return `dosya değiştirme (${name || shortType(step.type)})`;
    if (isCmd && isMutatingCommand(command)) return `değiştiren komut: ${truncate(command, 200)}`;
    return null;
  }
  // edit: file changes must stay inside cwd.
  if (isWrite && cwd) {
    const target = args.TargetFile || args.AbsolutePath || args.FilePath ||
      uriToPath(b.actionSpec?.command?.file?.absoluteUri || b.actionSpec?.createFile?.path?.absoluteUri || '');
    if (target && path.isAbsolute(target) && !isInside(target, cwd)) return `çalışma klasörü dışında dosya: ${target}`;
  }
  return null;
}

function toFileUri(dir) {
  let p = dir;
  try { p = realpathSync.native(dir); } catch { /* keep as is */ }
  return pathToFileURL(p).href;
}

function uriToPath(uri) {
  try { return uri?.startsWith('file:') ? fileURLToPath(uri) : uri; } catch { return uri; }
}

// ---------------------------------------------------------------------------
// Trajectory → normalized events
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['CORTEX_STEP_STATUS_DONE', 'CORTEX_STEP_STATUS_ERROR', 'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_INTERRUPTED', 'CORTEX_STEP_STATUS_INVALID', 'CORTEX_STEP_STATUS_CLEARED']);
const ERRORISH = new Set(['CORTEX_STEP_STATUS_ERROR', 'CORTEX_STEP_STATUS_CANCELED', 'CORTEX_STEP_STATUS_INTERRUPTED', 'CORTEX_STEP_STATUS_INVALID']);
// Step types that are tool executions even when a step carries no `metadata.toolCall`.
const TOOL_TYPES = new Set(['CORTEX_STEP_TYPE_RUN_COMMAND', 'CORTEX_STEP_TYPE_VIEW_FILE', 'CORTEX_STEP_TYPE_CODE_ACTION',
  'CORTEX_STEP_TYPE_LIST_DIRECTORY', 'CORTEX_STEP_TYPE_FIND', 'CORTEX_STEP_TYPE_GREP_SEARCH', 'CORTEX_STEP_TYPE_GENERIC']);

function stepBody(step) {
  for (const [k, v] of Object.entries(step)) {
    if (k !== 'type' && k !== 'status' && k !== 'metadata' && k !== 'taskDetails' && v && typeof v === 'object') return v;
  }
  return {};
}

function shortType(type) {
  return String(type || '').replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase();
}

function toolInput(step) {
  const tc = step.metadata?.toolCall;
  if (tc?.argumentsJson) {
    try {
      const args = JSON.parse(tc.argumentsJson);
      delete args.toolAction;
      const s = JSON.stringify(args);
      return s.length > 4000 ? truncate(s, 4000) : args;
    } catch { return truncate(tc.argumentsJson, 4000); }
  }
  const body = stepBody(step);
  return truncate(JSON.stringify(body), 1000);
}

function diffText(edit) {
  const lines = edit?.diff?.unifiedDiff?.lines || [];
  const out = [];
  for (const l of lines) {
    if (l.type === 'UNIFIED_DIFF_LINE_TYPE_INSERT') out.push('+' + String(l.text || '').replace(/\r$/, ''));
    else if (l.type === 'UNIFIED_DIFF_LINE_TYPE_DELETE') out.push('-' + String(l.text || '').replace(/\r$/, ''));
  }
  return out.join('\n');
}

function toolOutput(step) {
  const b = stepBody(step);
  const err = errorOfStep(step) || (typeof b.error === 'string' ? b.error : '');
  let out = '';
  switch (step.type) {
    case 'CORTEX_STEP_TYPE_RUN_COMMAND':
      out = (b.combinedOutput?.full ?? b.stdout ?? '') + (b.exitCode != null ? `\n(çıkış kodu ${b.exitCode})` : '');
      break;
    case 'CORTEX_STEP_TYPE_VIEW_FILE':
      out = `${uriToPath(b.absolutePathUri) || ''} (${String(b.content || '').split('\n').length} satır)`;
      break;
    case 'CORTEX_STEP_TYPE_CODE_ACTION':
      out = diffText(b.actionResult?.edit) || uriToPath(b.actionSpec?.command?.file?.absoluteUri) || 'düzenlendi';
      break;
    case 'CORTEX_STEP_TYPE_GENERIC':
      out = typeof b.result?.result === 'string' ? b.result.result : JSON.stringify(b.result ?? b);
      break;
    default: {
      const copy = { ...b };
      delete copy.content;
      out = JSON.stringify(copy);
    }
  }
  if (err) out = `${err}${out ? '\n' + out : ''}`;
  return truncate(out, 4000);
}

function errorOfStep(step) {
  const b = stepBody(step);
  return b.error?.shortError || b.error?.message || b.shortError || step.error?.shortError || '';
}

function friendlyError(msg) {
  const m = String(msg || '');
  if (/RESOURCE_EXHAUSTED|quota|429/i.test(m)) return `Antigravity kotası doldu: ${m}`;
  if (/unauthenticated|sign.?in|login/i.test(m)) return `Antigravity oturumu yok — uygulamada Google hesabıyla giriş yapın (${m})`;
  return `Antigravity hatası: ${m}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Launch the Antigravity desktop app detached (so it outlives Ortak) and optionally wait until
 * its language server answers. Resolves { ok, already?, reason? }. Never throws.
 */
export async function startAntigravity({ wait = true, timeoutMs = 90000, signal } = {}) {
  try {
    if (await getConn()) return { ok: true, already: true };
    const exe = appExe();
    if (!exe) return { ok: false, reason: NOT_INSTALLED };
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ANTIGRAVITY_LS_ADDRESS;
    delete env.ANTIGRAVITY_CSRF_TOKEN;
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false, env, cwd: path.dirname(exe) });
    child.on('error', () => {});
    child.unref();
    lowerPriority(child.pid);
    openedByOrtak = true;
    lastActivity = Date.now();
    scheduleIdleClose();
    if (!wait) return { ok: true };
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(2500, signal);
      if (await getConn({ fresh: true })) return { ok: true };
    }
    return { ok: false, reason: 'Antigravity başlatıldı ama dil sunucusu yanıt vermedi' };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { ok: false, reason: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Idle close (setting antigravityIdleMinutes): only an app instance that Ortak itself opened, and
// only after no Ortak turn ran for that long. Closed the polite way (window close, like the user
// clicking X), never killed.
// ---------------------------------------------------------------------------

let openedByOrtak = false;
let activeTurns = 0;
let lastActivity = 0;
let idleTimer = null;

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const mins = getSettings().antigravityIdleMinutes;
  if (!openedByOrtak || !mins) return;
  const due = lastActivity + mins * 60000 - Date.now();
  idleTimer = setTimeout(closeIfIdle, Math.max(5000, due));
  idleTimer.unref?.();
}

function closeIfIdle() {
  idleTimer = null;
  const mins = getSettings().antigravityIdleMinutes;
  if (!openedByOrtak || !mins || activeTurns > 0) return;
  if (Date.now() - lastActivity < mins * 60000) return scheduleIdleClose();
  openedByOrtak = false;
  cachedConn = null;
  lastMiss = Date.now();
  if (IS_WIN) execFile('taskkill', ['/IM', 'Antigravity.exe'], { windowsHide: true }, () => {});
  else execFile('pkill', ['-TERM', '-x', 'antigravity'], () => {});
  console.log('[antigravity] boşta kaldığı için kapatıldı (Ortak açmıştı)');
}

onSettingsChange(scheduleIdleClose);

/** Internal helpers, exported for tests only. */
export const _internals = { isMutatingCommand, violationOf, buildCascadeConfig, resolveModel, fetchModels };

const adapter = {
  id: 'antigravity',
  name: 'Antigravity',
  // sandbox:false — permission levels are only guarded (prompt + stop-after-violation), not enforced.
  capabilities: { edit: true, resume: true, streaming: true, cwd: true, sandbox: false },

  /** Launch the desktop app (POST /api/agents/antigravity/start). */
  start: () => startAntigravity({ wait: true }),

  async detect() {
    try {
      const envConn = process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (!appExe() && !lsExe() && !envConn) return { available: false, reason: NOT_INSTALLED };
      const conn = await getConn();
      if (!conn) {
        // Closed, but a turn can open it (setting antigravityAutoStart): offer it as available.
        if (getSettings().antigravityAutoStart && appExe()) return { available: true, sleeping: true };
        return { available: false, reason: NOT_RUNNING };
      }
      const auth = await rawRpc(conn, 'GetAuthStatus', {}, { timeoutMs: 3000 }).catch(() => null);
      if (auth && auth.authResult && !auth.authResult.hasValidAuth) {
        return { available: false, version: conn.version, reason: 'Antigravity açık ama oturum açılmamış — uygulamada Google hesabıyla giriş yapın' };
      }
      return { available: true, version: conn.version };
    } catch (err) {
      return { available: false, reason: `Antigravity'ye bağlanılamadı: ${err?.message || err}` };
    }
  },

  async listModels() {
    try {
      // While the app sleeps (no connection) use the last list seen instead of discovering again.
      const data = (await getConn().catch(() => null)) ? await fetchModels() : readModelCache();
      if (!data) return FALLBACK_MODELS;
      const { models, agentIds, tiers, defaultId } = data;
      // Models the account can't use (e.g. Ultra-only ones) stay visible but locked.
      const list = agentIds.filter((id) => models[id]).map((id) => (models[id].disabled
        ? { id, label: `${modelLabel(id, models[id])} — kilitli`, disabled: true, note: lockReason(models[id]) || 'Bu hesapta kullanılamıyor' }
        : { id, label: modelLabel(id, models[id]) }));
      // The cheap tier agentapi calls "flash_lite" is not in the UI picker but is handy for light roles.
      const lite = tiers.flash_lite;
      if (lite && models[lite] && !list.some((m) => m.id === lite)) list.push({ id: lite, label: `${modelLabel(lite, models[lite])} (en az kota)` });
      if (!list.length) return FALLBACK_MODELS;
      const def = list.find((m) => m.id === defaultId && !m.disabled) || list.find((m) => !m.disabled) || list[0];
      def.default = true;
      return [def, ...list.filter((m) => m !== def)];
    } catch {
      return FALLBACK_MODELS;
    }
  },

  async getLimits() {
    try {
      const conn = await getConn();
      if (!conn) return { items: [], note: getSettings().antigravityAutoStart && appExe() ? 'Kapalı (uykuda): ilk turda Ortak açar, kota o zaman görünür.' : NOT_RUNNING };
      const [{ models, agentIds, tiers }, status] = await Promise.all([
        fetchModels({ fresh: true }),
        call('GetUserStatus', {}, { timeoutMs: 8000 }).catch(() => null),
      ]);
      const ids = [...agentIds];
      if (tiers.flash_lite && !ids.includes(tiers.flash_lite)) ids.push(tiers.flash_lite);
      const items = [];
      for (const id of ids) {
        const info = models[id];
        const q = info?.quotaInfo;
        if (!info || !q || info.disabled) continue;
        const rem = typeof q.remainingFraction === 'number' ? q.remainingFraction : 0; // omitted field = 0 remaining
        const item = { label: modelLabel(id, info), usedPercent: Math.max(0, Math.min(100, Math.round(1000 * (1 - rem)) / 10)) };
        const reset = typeof q.resetTime === 'string' ? q.resetTime : q.resetTime?.seconds ? new Date(Number(q.resetTime.seconds) * 1000).toISOString() : undefined;
        if (reset) item.resetsAt = new Date(reset).toISOString();
        items.push(item);
      }
      const plan = status?.userStatus?.userTier?.description || status?.userStatus?.planStatus?.planInfo?.planName;
      return { items, note: plan ? `Plan: ${plan}` : undefined };
    } catch (err) {
      return { items: [], note: `Antigravity kotası okunamadı: ${err?.message || err}` };
    }
  },

  async run({ prompt, cwd, model, sessionId, permission = 'read-only', system, signal, onEvent = () => {} }) {
    const emit = (e) => { try { onEvent(e); } catch (err) { console.error('[antigravity] onEvent error', err); } };
    const fail = (msg) => { emit({ type: 'error', message: msg }); return new Error(msg); };
    if (signal?.aborted) throw new AbortError();

    emit({ type: 'status', text: 'Antigravity bekleniyor…' });
    let conn = await getConn().catch(() => null);
    if (!conn && getSettings().antigravityAutoStart && appExe()) {
      emit({ type: 'status', text: 'Antigravity açılıyor (gerektiğinde açılır; ilk açılış biraz sürebilir)…' });
      const r = await startAntigravity({ wait: true, signal });
      if (!r.ok) throw fail(r.reason || NOT_RUNNING);
      conn = await getConn().catch(() => null);
    }
    if (!conn) throw fail(NOT_RUNNING);
    if (cwd && !existsSync(cwd)) throw fail(`Klasör bulunamadı: ${cwd}`);

    let planModel;
    try { planModel = await resolveModel(model); } catch (err) { throw fail(err.message); }
    const cascadeConfig = buildCascadeConfig(permission, planModel);

    let text = String(prompt ?? '');
    if (permission === 'read-only') text = `${READ_ONLY_NOTE}\n\n${text}`;
    else if (permission === 'edit' && cwd) text = `${editNote(cwd)}\n\n${text}`;
    if (system) text = `<ortak_talimatlari>\n${system}\n</ortak_talimatlari>\n\n${text}`;

    // 1) New conversation (same request shape as `agentapi new-conversation`) or resume.
    let cascadeId = sessionId;
    let base = 0;
    try {
      if (!cascadeId) {
        const r = await call('StartCascade', {
          source: 'CORTEX_TRAJECTORY_SOURCE_AGENT_API',
          trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
          workspaceUris: cwd ? [toFileUri(cwd)] : [],
          customAgentSpec: {
            commandExecutionPolicy: 'eager',
            enforcedWorkspaceValidation: permission !== 'full',
            cascadeConfig,
            codingAgent: { googleMode: true },
          },
        }, { signal });
        cascadeId = r.cascadeId;
        if (!cascadeId) throw new Error('StartCascade boş yanıt döndü');
      } else {
        const t = await call('GetCascadeTrajectory', { cascadeId }, { signal, timeoutMs: 30000 });
        base = Number(t.numTotalSteps ?? t.trajectory?.steps?.length ?? 0);
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (/trajectory not found/i.test(err.message)) throw fail(`Antigravity oturumu bulunamadı: ${cascadeId}`);
      throw fail(err.message === NOT_RUNNING ? NOT_RUNNING : friendlyError(err.message));
    }

    // 2) Send the message. `blocking: true` makes the RPC return when the invocation is idle;
    //    meanwhile we poll the new steps for streaming.
    const sendCtrl = new AbortController();
    let sendDone = false;
    let sendErr = null;
    const sendP = call('SendUserCascadeMessage', {
      cascadeId,
      items: [{ text }],
      cascadeConfig,
      blocking: true,
    }, { signal: sendCtrl.signal, timeoutMs: 0, noRetry: true })
      .then(() => { sendDone = true; }, (err) => { sendErr = err; sendDone = true; });

    let cancelP = null;
    const cancelRemote = () => {
      sendCtrl.abort();
      cancelP ||= rawRpc(conn, 'CancelCascadeInvocation', { cascadeId }, { timeoutMs: 5000 }).catch(() => { /* best effort */ });
      return cancelP;
    };
    let aborted = false;
    const onAbort = () => { aborted = true; cancelRemote(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const seen = new Map(); // step index -> { status, textLen, toolStarted, toolEnded, msgSent }
    const messages = []; // [{ idx, text }]
    const errors = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let sawUserInput = false;
    let lastStatusText = '';
    let waitingSince = 0;
    let settledPolls = 0;
    let violation = null;
    let lastSig = '';
    let lastChangeAt = Date.now();

    const setStatus = (t) => { if (t !== lastStatusText) { lastStatusText = t; emit({ type: 'status', text: t }); } };

    const processSteps = (steps) => {
      let busy = false;
      let waiting = false;
      steps.forEach((step, i) => {
        const idx = base + i;
        const st = seen.get(idx) || { status: '', textLen: 0 };
        const status = step.status || '';
        if (!TERMINAL.has(status)) busy = true;
        if (status === 'CORTEX_STEP_STATUS_WAITING') waiting = true;

        if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') sawUserInput = true;

        if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
          const pr = step.plannerResponse || {};
          const partial = String(pr.response || '');
          if (status === 'CORTEX_STEP_STATUS_GENERATING') setStatus('Antigravity yazıyor…');
          if (!TERMINAL.has(status) && partial.length > st.textLen && partial.startsWith(st.text || '')) {
            emit({ type: 'text-delta', text: partial.slice(st.textLen) });
            st.text = partial;
            st.textLen = partial.length;
          }
          if (TERMINAL.has(status) && !st.msgSent) {
            st.msgSent = true;
            if (pr.thinking) emit({ type: 'thinking', text: truncate(pr.thinking, 4000) });
            const full = String(pr.modifiedResponse || pr.response || '');
            if (full) {
              emit({ type: 'message', text: full });
              messages.push({ idx, text: full });
            }
            const mu = step.metadata?.modelUsage;
            if (mu) {
              usage.inputTokens += Number(mu.inputTokens || 0);
              usage.outputTokens += Number(mu.outputTokens || 0);
            }
            const e = errorOfStep(step);
            if (e) errors.push(e);
          }
        } else if (step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
          if (TERMINAL.has(status) && !st.msgSent) {
            st.msgSent = true;
            const e = errorOfStep(step) || 'bilinmeyen hata';
            errors.push(e);
            setStatus(truncate(`Antigravity: ${e}`, 300));
          }
        } else if (step.metadata?.toolCall || TOOL_TYPES.has(step.type)) {
          const id = step.metadata?.toolCall?.id || `step-${idx}`;
          if (!st.toolStarted) {
            st.toolStarted = true;
            emit({ type: 'tool-start', id, name: step.metadata?.toolCall?.name || shortType(step.type), input: toolInput(step) });
            const v = !violation && violationOf(step, permission, cwd);
            if (v) violation = v;
          }
          if (TERMINAL.has(status) && !st.toolEnded) {
            st.toolEnded = true;
            const b = stepBody(step);
            const isError = ERRORISH.has(status) || !!errorOfStep(step) ||
              (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && b.exitCode != null && Number(b.exitCode) !== 0);
            emit({ type: 'tool-end', id, output: toolOutput(step), isError });
          }
        }
        st.status = status;
        seen.set(idx, st);
      });
      return { busy, waiting };
    };

    try {
      await sleep(200, signal);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (aborted) throw new AbortError();
        let steps = [];
        try {
          const r = await call('GetCascadeTrajectorySteps', { cascadeId, stepOffset: base }, { signal });
          steps = r.steps || [];
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (isConnError(err)) throw fail('Antigravity bağlantısı koptu (uygulama kapandı mı?)');
          throw fail(friendlyError(err.message));
        }
        const { busy, waiting } = processSteps(steps);

        if (violation) {
          await cancelRemote();
          const mode = permission === 'read-only' ? 'salt-okunur' : 'düzenleme';
          throw fail(`Antigravity ${mode} modunda izin verilmeyen bir işlem denedi (${violation}); tur durduruldu.`);
        }

        if (waiting) {
          setStatus('Antigravity uygulamasında onay bekleniyor…');
          if (!waitingSince) waitingSince = Date.now();
          else if (Date.now() - waitingSince > WAITING_LIMIT_MS) {
            await cancelRemote();
            throw fail('Antigravity bir onay bekliyor ve Ortak bunu yanıtlayamıyor. Antigravity uygulamasında onaylayın veya izin modunu değiştirin.');
          }
        } else {
          waitingSince = 0;
          if (!busy && !sendDone) setStatus(sawUserInput ? 'Antigravity çalışıyor…' : 'Antigravity bekleniyor…');
        }

        // Fallback in case the blocking RPC never returns: the turn looks finished (last step is a
        // final answer without tool calls) and nothing changed for a minute.
        const sig = steps.map((s) => s.status).join(',');
        if (sig !== lastSig) { lastSig = sig; lastChangeAt = Date.now(); }
        const lastStep = steps[steps.length - 1];
        if (!sendDone && !busy && sawUserInput && lastStep?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' &&
            !(lastStep.plannerResponse?.toolCalls || []).length && Date.now() - lastChangeAt > 60000) {
          sendCtrl.abort();
          break;
        }

        if (sendDone) {
          if (sendErr) {
            if (aborted || sendErr.name === 'AbortError') throw new AbortError();
            if (isConnError(sendErr)) throw fail('Antigravity bağlantısı koptu (uygulama kapandı mı?)');
            throw fail(friendlyError(sendErr.message));
          }
          // The blocking call returned: finish once the new steps have settled.
          if (!busy && (sawUserInput || steps.length)) {
            if (++settledPolls >= 1) break;
          } else if (++settledPolls > 40) {
            break; // ~18s grace; don't hang if a step never reports a terminal status
          }
        }
        await sleep(sendDone ? 250 : POLL_MS, signal);
      }
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      await cancelRemote();
      if (err.name === 'AbortError' || aborted) throw new AbortError();
      throw err;
    }
    signal?.removeEventListener('abort', onAbort);
    await sendP;

    const finalText = messages.length ? messages[messages.length - 1].text : '';
    if (!finalText && errors.length) throw fail(friendlyError(errors[errors.length - 1]));

    const u = (usage.inputTokens || usage.outputTokens) ? usage : undefined;
    if (u) emit({ type: 'usage', ...u });
    emit({ type: 'done', text: finalText, sessionId: cascadeId });
    return { text: finalText, sessionId: cascadeId, usage: u };
  },
};

// Count turns so the idle close never fires mid-turn.
const runTurn = adapter.run;
adapter.run = async function run(opts) {
  activeTurns++;
  try {
    return await runTurn.call(adapter, opts);
  } finally {
    activeTurns--;
    lastActivity = Date.now();
    scheduleIdleClose();
  }
};

export default adapter;

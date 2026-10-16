// JetBrains Junie CLI adapter: runs `junie --output-format json-stream` (the batch host), prompt
// on stdin. Events: `session` (id) · `step` (one per tool call / TASK RESULT) · `system` ·
// `result` (final text, changed files, per-model usage).
//
// NOT ACP (`--acp=true`): an ACP session ignores the account's own model (`modelForLaunch` in
// ~/.junie/settings.json) and pins the licensed default (gemini-3.7-flash), so on an account
// without a JetBrains AI subscription every turn dies with a bare `stopReason: cancelled` —
// junie-lite, the free model the CLI itself uses, cannot even be selected over ACP. The batch
// host honours the account's model and `--model`, so it works where ACP does not. detect() still
// speaks ACP: a session opens there without a subscription, which makes it a sign-in check.
//
// Permissions: the batch host auto-approves everything, so Ortak installs a PreToolUse hook
// (junie-hook.cjs, passed per run with --config-location) that denies what the level forbids:
//   read-only → only read/search/plan tools        edit → everything but shell        full → no hook
// Sign-in: login() opens Junie's own welcome screen in a terminal (JetBrains Account in the
// browser, Junie API key or BYOK); Junie stores the credentials itself. Ortak never sees them.
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { which, capture, cleanEnv, realCwd, truncate, AbortError, openConsole, runJsonl } from './base.js';
import { AcpClient, INIT_PARAMS } from './acp.js';

const NAME = 'Junie';
const SAFE_ARG = /^[A-Za-z0-9._:\/-]+$/;
const NOT_INSTALLED = 'Junie CLI bulunamadı: https://junie.jetbrains.com/cli adresindeki kurulumla yükleyin (`junie` PATH üzerinde olmalı).';
const NOT_LOGGED_IN = 'Junie oturumu yok: Ajanlar ve API’ler penceresinden "Giriş yap" ile JetBrains hesabınızla oturum açın (auth login).';
const AUTH_TTL_MS = 3 * 60_000;
const VERSION_TTL_MS = 30 * 60_000;

// Junie's own ids (`junie --model=<id>`, same ids as its /model picker). junie-lite is the free
// model (Qwen on JetBrains' vLLM endpoint); everything else bills a JetBrains AI plan, so an
// account without one gets "Authorization failed" from them. The ids come from the live ACP
// catalog; junie-lite is only in the CLI's own list, never in the ACP one.
const PAID = 'JetBrains AI aboneliği gerektirir';
const STATIC_MODELS = [
  { id: 'default', label: 'Varsayılan (Junie ayarı)', default: true, group: 'Junie' },
  { id: 'junie-lite', label: 'Junie Lite (ücretsiz)', group: 'Junie', free: true },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', group: 'Anthropic', note: PAID },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', group: 'Anthropic', note: PAID },
  { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Anthropic', note: PAID },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', group: 'Anthropic', note: PAID },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Anthropic', note: PAID },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', group: 'Anthropic', note: PAID },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', group: 'OpenAI', note: PAID },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', group: 'OpenAI', note: PAID },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', group: 'OpenAI', note: PAID },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', group: 'OpenAI', note: PAID },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', group: 'OpenAI', note: PAID },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', group: 'OpenAI', note: PAID },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', group: 'OpenAI', note: PAID },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', group: 'Google', note: PAID },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', group: 'Google', note: PAID },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', group: 'Google', note: PAID },
  { id: 'grok-4.7', label: 'Grok 4.7', group: 'xAI', note: PAID },
  { id: 'grok-4.6', label: 'Grok 4.6', group: 'xAI', note: PAID },
];

const bin = () => which('junie');
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const isAuthError = (err) => /authenticat|log ?in|sign ?in|unauthori[sz]ed|\b401\b/i.test(`${err?.message || ''} ${JSON.stringify(err?.data || '')}`);

let authState = null;    // { at, loggedIn, error? }
let authInFlight = null;
let versionState = null; // { at, version, error? }
let versionInFlight = null;

function spawnAcp(cwd, extraArgs = [], handlers = {}) {
  return new AcpClient({
    file: bin(),
    args: ['--acp=true', '--skip-update-check', ...extraArgs],
    cwd,
    env: cleanEnv({ NO_COLOR: '1' }),
    ...handlers,
  });
}

// ---- detect / models / limits / login -------------------------------------------------------

/**
 * Signed in? An ACP session opens without a JetBrains AI subscription but not without a sign-in,
 * which makes `initialize` + a throw-away `session/new` the cheapest sign-in check Junie offers.
 * Never throws: on a timeout (the JVM can be slow under load) `loggedIn` stays null, and detect()
 * then reports Junie as usable — a run would surface the real reason anyway.
 */
async function checkAuth() {
  if (authState && Date.now() - authState.at < AUTH_TTL_MS) return authState;
  authInFlight ||= (async () => {
    const client = spawnAcp(os.tmpdir());
    try {
      const init = await client.request('initialize', INIT_PARAMS, { timeoutMs: 25_000 });
      const version = String(init?.agentInfo?.version || '').trim() || null;
      let loggedIn = false;
      try {
        const res = await client.request('session/new', { cwd: os.tmpdir(), mcpServers: [] }, { timeoutMs: 25_000 });
        loggedIn = true;
        const caps = init?.agentCapabilities?.sessionCapabilities || {};
        if (res?.sessionId && caps.delete) await client.request('session/delete', { sessionId: res.sessionId }, { timeoutMs: 5000 }).catch(() => {});
      } catch (err) {
        if (!isAuthError(err)) throw err;
      }
      authState = { at: Date.now(), loggedIn, version };
    } catch (err) {
      authState = { at: Date.now(), loggedIn: null, version: null, error: err?.message || String(err) };
    } finally {
      client.close();
    }
    return authState;
  })().finally(() => { authInFlight = null; });
  return authInFlight;
}

/** `junie --version`, cached: the JVM needs seconds to start and the number only moves on upgrade. */
async function checkVersion() {
  if (versionState && Date.now() - versionState.at < VERSION_TTL_MS) return versionState;
  versionInFlight ||= capture(bin(), ['--version', '--skip-update-check'], { timeoutMs: 25_000 })
    .then((r) => {
      const version = (`${r.stdout} ${r.stderr}`.match(/\d+\.\d+\.\d+(?: \(\d+\.\d+\))?/) || [])[0] || null;
      versionState = { at: Date.now(), version, error: version ? null : firstLine(r.stderr || r.stdout) };
      return versionState;
    })
    .finally(() => { versionInFlight = null; });
  return versionInFlight;
}

/**
 * Junie's JVM needs the better part of ten seconds to answer a cold probe — more than the agent
 * list is willing to wait. So detect() never blocks on it: it answers from the cached probe and
 * starts a new one in the background, which the next refresh (or the sign-in poll) picks up.
 * One probe answers both questions: `initialize` carries the version, `session/new` the sign-in
 * state; `junie --version` only fills the version in when ACP itself does not come up.
 */
async function detect() {
  if (!bin()) return { available: false, reason: NOT_INSTALLED };
  const fresh = authState && Date.now() - authState.at < AUTH_TTL_MS ? authState : null;
  if (!fresh) {
    checkAuth().then((a) => { if (!a.version) checkVersion(); }).catch(() => {});
    if (!authState) return { available: true, version: versionState?.version || null };
  }
  const a = fresh || authState;
  if (a.loggedIn === false) return { available: false, version: a.version, reason: NOT_LOGGED_IN, login: { required: true, label: 'Giriş yap' } };
  const version = a.version || versionState?.version || null;
  if (a.loggedIn == null && !version) return { available: false, reason: `Junie çalıştırılamadı: ${truncate(a.error || '', 200)}` };
  return { available: true, version };
}

async function listModels() {
  return STATIC_MODELS;
}

async function getLimits() {
  return { items: [], note: 'JetBrains AI kotası ve abonelik durumu: account.jetbrains.com (Junie çalışması için aktif bir JetBrains AI planı gerekir)' };
}

/** Opens Junie's own welcome screen in a terminal: JetBrains Account (browser), Junie API key or BYOK. */
function login() {
  if (!bin()) return { ok: false, reason: NOT_INSTALLED };
  authState = null;
  const r = openConsole({ title: 'Junie - giris', file: bin(), args: ['--skip-update-check'], cwd: os.tmpdir() });
  if (!r.ok) return r;
  return { ok: true, pending: true, message: 'Açılan Junie penceresinde JetBrains hesabınızla oturum açın (tarayıcı açılır), sonra pencereyi kapatın.' };
}

// ---- run ------------------------------------------------------------------------------------
const HOOK = fileURLToPath(new URL('./junie-hook.cjs', import.meta.url));
// Junie's JVM writes stdout in the console code page, which mangles Turkish (ı, ş, ğ → "?").
const JAVA_UTF8 = '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8';

/** Per-run config file holding the PreToolUse hook; null for `full` (no restrictions to enforce). */
async function writeHookConfig(permission) {
  if (permission === 'full') return null;
  const file = path.join(os.tmpdir(), `ortak-junie-${process.pid}-${Date.now().toString(36)}.json`);
  // The path goes in raw: JSON.stringify below escapes it once, which is what Junie unescapes.
  const config = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] } };
  await fsp.writeFile(file, JSON.stringify(config), 'utf8');
  return file;
}

// Junie's batch host reports a failed turn only as a `system` message plus exit 1; the reason
// (no subscription, expired sign-in, rate limit) reaches its own per-run log file and nowhere
// else. Best-effort: pick the most recently touched log and look for a known cause.
const JUNIE_LOG_DIR = path.join(os.homedir(), '.junie', 'logs');

async function diagnoseFromLog(sinceMs) {
  let files;
  try { files = await fsp.readdir(JUNIE_LOG_DIR); } catch { return null; }
  const candidates = [];
  for (const f of files) {
    if (!/^log-.*\.log$/.test(f) || /llm-streaming/i.test(f)) continue;
    try {
      const st = await fsp.stat(path.join(JUNIE_LOG_DIR, f));
      if (st.mtimeMs >= sinceMs - 3000) candidates.push({ f, mtimeMs: st.mtimeMs });
    } catch { /* ignore */ }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let text;
  try {
    text = await fsp.readFile(path.join(JUNIE_LOG_DIR, candidates[0].f), 'utf8');
    if (text.length > 20000) text = text.slice(-20000);
  } catch { return null; }
  if (/NO_LICENSE|No active JetBrains AI subscription/i.test(text)) {
    return 'Junie bu model için JetBrains AI aboneliği istiyor: "Junie Lite (ücretsiz)" modelini seçin ya da account.jetbrains.com üzerinden bir JetBrains AI planı edinin.';
  }
  if (/retry login - no more retries left|Authorization failed, will enforcing relogin/i.test(text)) {
    return 'Junie oturum yetkisini kaybetti: Ajanlar ve API’ler penceresinden "Giriş yap" ile tekrar oturum açın.';
  }
  if (/\b429\b|rate.?limit|quota exceeded/i.test(text)) return 'Junie kullanım limiti doldu (rate limit).';
  return null;
}

function describeError(text, { model } = {}) {
  const t = String(text || '');
  if (/authorization failed|not (logged|signed) in|unauthori[sz]ed|\b401\b/i.test(t)) {
    return model && model !== 'junie-lite'
      ? `Junie "${model}" modelini kullanamadı (yetki hatası): ücretsiz "Junie Lite" modelini deneyin ya da JetBrains AI aboneliğinizi kontrol edin.`
      : NOT_LOGGED_IN;
  }
  if (/model/i.test(t) && /(not (found|available|supported)|unknown|invalid)/i.test(t)) return `Junie: model kullanılamıyor (${model || 'varsayılan'}) — başka bir model seçin.`;
  if (/session .*not found|unknown session|no such session/i.test(t)) return 'Junie oturumu bulunamadı (session not found). Yeni bir sohbet başlatın.';
  if (/quota|credits?|rate.?limit|\b429\b|too many requests|limit (reached|exceeded)/i.test(t)) return `Junie kullanım limiti doldu (usage limit): ${truncate(firstLine(t), 200)}`;
  if (/ECONN|ETIMEDOUT|ENOTFOUND|network|socket hang up|\b50[0234]\b/i.test(t)) return `Junie bağlantı hatası: ${truncate(firstLine(t), 200)}`;
  return `Junie hatası: ${truncate(firstLine(t), 300) || 'beklenmedik şekilde kapandı'}`;
}

const shortInput = (v) => {
  if (v == null) return undefined;
  if (typeof v === 'string') return truncate(v, 4000);
  const s = JSON.stringify(v);
  return s.length > 4000 ? truncate(s, 4000) : v;
};

/**
 * json-stream events → Ortak events. One `step` = one finished tool call, so each becomes a
 * tool-start/tool-end pair; the final answer is the `result` event (the identical "TASK RESULT"
 * step is dropped, and so are the steps Junie replays from the previous turn when resuming).
 */
export function createMapper(onEvent) {
  const st = { sessionId: null, text: '', usage: null, changes: [], system: [], steps: 0, replaying: false };
  st.handle = (o) => {
    if (!o || typeof o !== 'object') return;
    switch (o.type) {
      case 'session':
        if (o.sessionId) st.sessionId = String(o.sessionId);
        break;
      case 'step': {
        const name = String(o.name || '').trim();
        if (!name || name === 'TASK RESULT') break; // == the result event, or a replayed one
        const id = `step-${++st.steps}`;
        onEvent({ type: 'tool-start', id, name, input: shortInput(o.details) });
        onEvent({ type: 'tool-end', id, output: truncate(String(o.output ?? o.details ?? 'Tamamlandı'), 4000) });
        break;
      }
      case 'system':
        if (o.message) {
          st.system.push(String(o.message));
          onEvent({ type: 'status', text: truncate(String(o.message), 300) });
        }
        break;
      case 'result': {
        if (typeof o.result === 'string' && o.result.trim()) st.text = o.result;
        if (Array.isArray(o.changes)) st.changes = o.changes.map((c) => c?.afterRelativePath || c?.beforeRelativePath).filter(Boolean);
        // `errorCode` is Junie's (misnamed) per-model usage array: [{ model, calls, cost, … }]
        const stats = Array.isArray(o.errorCode) ? o.errorCode : [];
        if (stats.length) {
          st.usage = stats.reduce((a, s) => ({
            inputTokens: a.inputTokens + (Number(s.inputTokens) || 0) + (Number(s.cacheInputTokens) || 0),
            outputTokens: a.outputTokens + (Number(s.outputTokens) || 0),
            costUsd: a.costUsd + (Number(s.cost) || 0),
          }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
        }
        break;
      }
      default:
        break;
    }
  };
  return st;
}

const systemBySession = new Map();

async function run({ prompt, cwd, model, sessionId, permission = 'read-only', system, signal, onEvent = () => {} }) {
  const fail = (message) => { onEvent({ type: 'error', message }); return new Error(message); };
  const file = bin();
  if (!file) throw fail(NOT_INSTALLED);
  if (model === 'default') model = undefined;
  if (model && !SAFE_ARG.test(model)) throw fail(`Geçersiz model adı: ${truncate(model, 60)}`);
  if (sessionId && !SAFE_ARG.test(sessionId)) throw fail('Geçersiz oturum kimliği.');
  if (signal?.aborted) throw new AbortError();

  const startedAt = Date.now();
  const args = ['--skip-update-check', '--output-format', 'json-stream'];
  // Read-only runs are conversation/analysis: Junie's chat mode answers them directly instead of
  // wrapping every reply in its "Changes / Verification / Notes" task report.
  if (permission === 'read-only') args.push('--agent-mode=chat');
  if (model) args.push(`--model=${model}`);
  if (sessionId) args.push(`--session-id=${sessionId}`);
  const hookConfig = await writeHookConfig(permission);
  if (hookConfig) args.push(`--config-location=${hookConfig}`);

  // No system-prompt flag worth the cmd.exe quoting: instructions ride on stdin, once per session.
  let input = String(prompt ?? '');
  if (system && (!sessionId || systemBySession.get(sessionId) !== system)) {
    input = `<system-instructions>\n${system}\n</system-instructions>\n\n${input}`;
  }

  const st = createMapper(onEvent);
  const lines = [];
  onEvent({ type: 'status', text: sessionId ? 'Junie oturumu sürdürülüyor…' : 'Junie başlatılıyor…' });
  let code;
  let stderr = '';
  try {
    ({ code, stderr } = await runJsonl({
      file,
      args,
      cwd: realCwd(cwd),
      env: cleanEnv({ NO_COLOR: '1', JAVA_TOOL_OPTIONS: JAVA_UTF8, ORTAK_JUNIE_PERMISSION: permission }),
      stdin: input,
      signal,
      onJson: st.handle,
      onLine: (l) => { if (lines.length < 40 && !/^Picked up JAVA_TOOL_OPTIONS/.test(l)) lines.push(l); },
    }));
  } catch (err) {
    if (err instanceof AbortError || err?.name === 'AbortError') throw err;
    throw fail(err?.code === 'ENOENT' ? NOT_INSTALLED : `Junie başlatılamadı: ${err?.message || err}`);
  } finally {
    if (hookConfig) fsp.rm(hookConfig, { force: true }).catch(() => {});
  }

  const sid = st.sessionId || sessionId;
  if (sid && system) systemBySession.set(sid, system);
  if (st.usage) onEvent({ type: 'usage', ...st.usage });
  if (st.changes.length) onEvent({ type: 'status', text: `Değişen dosyalar: ${truncate(st.changes.join(', '), 300)}` });

  if (code === 0 && st.text) {
    onEvent({ type: 'done', text: st.text, sessionId: sid });
    return { text: st.text, sessionId: sid, usage: st.usage || undefined };
  }
  const detail = [...st.system, ...lines, stderr].filter(Boolean).join('\n');
  const fromLog = /authorization|failed|error/i.test(detail) || !detail
    ? await diagnoseFromLog(startedAt).catch(() => null)
    : null;
  throw fail(fromLog || describeError(detail || `çıkış kodu ${code}`, { model }));
}

export default {
  id: 'junie',
  name: NAME,
  // No token-by-token stream: the batch host reports one event per finished step.
  capabilities: { edit: true, resume: true, streaming: false, cwd: true, sandbox: false, localProcess: true, editShell: false },
  detect,
  listModels,
  getLimits,
  login,
  run,
};

export const _internal = { describeError, diagnoseFromLog, writeHookConfig, HOOK };

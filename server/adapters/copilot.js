// GitHub Copilot CLI adapter (copilot 1.0.x): `copilot --output-format json`, prompt on stdin.
// See docs/CONTRACT.md §1.
//
// One run = one `copilot` process (the native copilot.exe next to the npm shim when present). The
// session is continued with `--resume=<sessionId>`. JSONL events:
//   assistant.message_delta (text) · assistant.message (full text + tool requests) ·
//   assistant.reasoning · tool.execution_start / tool.execution_complete · result (sessionId)
//
// Permission mapping (verified with copilot 1.0.98; non-interactive mode requires
// --allow-all-tools, and --deny-tool wins over it — a denied call fails with "denied"):
//   read-only → --allow-all-tools --deny-tool=write --deny-tool=shell --disable-builtin-mcps
//   edit      → --allow-all-tools --deny-tool=shell --disable-builtin-mcps
//               (writes limited to cwd by Copilot's path verification; no shell: not sandboxed)
//   full      → --allow-all
//
// Account data (sign-in state, models, quota) comes from Copilot's own SDK server mode
// (`copilot --headless --stdio`, JSON-RPC: auth.getStatus, models.list, account.getQuota) — the
// same API the official Copilot SDK uses; no tokens are read.
import path from 'node:path';
import os from 'node:os';
import { runJsonl, capture, cleanEnv, realCwd, truncate, AbortError, spawnCli, killTree, openConsole } from './base.js';
import { resolveBin } from './opencode-core.js';

const NAME = 'GitHub Copilot';
const SAFE_ARG = /^[A-Za-z0-9._:\/-]+$/;
const PROBE_TTL_MS = 60_000;
const NOT_INSTALLED = 'GitHub Copilot CLI bulunamadı: `npm i -g @github/copilot` ile kurun (`copilot` PATH üzerinde olmalı).';
const NOT_LOGGED_IN = 'GitHub Copilot oturumu yok: Ajanlar ve API’ler penceresinden "Giriş yap" (terminalde `copilot login`).';

const bin = () => resolveBin('copilot', path.join('node_modules', '@github', 'copilot', 'node_modules', '@github',
  `copilot-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'copilot.exe' : 'copilot'));

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const fmtTime = (iso) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

// ---- SDK server probe ---------------------------------------------------------------------------

/** Sends `calls` ([method, params]) to a short-lived `copilot --headless --stdio`; null on failure. */
function headless(calls, timeoutMs = 15000) {
  const file = bin();
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(file, ['--headless', '--no-auto-update', '--stdio', '--log-level', 'error'], { cwd: os.tmpdir(), env: cleanEnv() });
    } catch { return resolve(null); }
    const results = {};
    let buf = Buffer.alloc(0);
    let next = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(Object.keys(results).length ? results : null), timeoutMs);
    const send = () => {
      if (next >= calls.length) return finish(results);
      const [method, params] = calls[next];
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: next + 1, method, params: params || {} }), 'utf8');
      try { child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); } catch { finish(null); }
    };
    child.on('error', () => finish(null));
    child.on('close', () => finish(Object.keys(results).length ? results : null));
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString('latin1'));
        if (!m) { buf = buf.subarray(sep + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < sep + 4 + len) return;
        let msg = null;
        try { msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8')); } catch { /* skip */ }
        buf = buf.subarray(sep + 4 + len);
        if (msg && msg.id === next + 1) {
          results[calls[next][0]] = msg.error ? { error: msg.error } : msg.result;
          next++;
          send();
        }
      }
    });
    send();
  });
}

let probeCache = null; // { at, data }
let probeInFlight = null;

async function probe() {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.data;
  probeInFlight ||= headless([['ping', { message: 'ortak' }], ['auth.getStatus'], ['models.list'], ['account.getQuota']])
    .then((data) => { probeCache = { at: Date.now(), data }; return data; })
    .finally(() => { probeInFlight = null; });
  return probeInFlight;
}

// ---- detect / models / limits ---------------------------------------------------------------

async function detect() {
  const file = bin();
  if (!file) return { available: false, reason: NOT_INSTALLED };
  const [ver, info] = await Promise.all([capture(file, ['--version'], { timeoutMs: 8000 }), probe()]);
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [])[0];
  if (!ver.ok && !version) return { available: false, reason: `Copilot çalıştırılamadı: ${truncate(firstLine(ver.stderr || ver.stdout), 200)}` };
  const auth = info?.['auth.getStatus'];
  if (auth && auth.isAuthenticated === false) return { available: false, version, reason: NOT_LOGGED_IN, login: { required: true, label: 'Giriş yap' } };
  return { available: true, version, ...(auth?.login ? { account: auth.login } : {}) };
}

/** Copilot Free: no premium requests at all (auto then only uses the included models). */
function freePlan(info) {
  const p = info?.['account.getQuota']?.quotaSnapshots?.premium_interactions;
  return !!p && !p.entitlementRequests && !p.isUnlimitedEntitlement;
}

async function listModels() {
  const auto = { id: 'auto', label: 'Otomatik (Copilot seçer)', default: true, group: 'Copilot' };
  const info = await probe().catch(() => null);
  // Models with a ×0 premium multiplier are included in every plan (Copilot Free too): they cost
  // no premium requests — Ortak's "free" tier. On Copilot Free, auto picks among those only.
  if (freePlan(info)) auto.free = true;
  const list = Array.isArray(info?.['models.list']?.models) ? info['models.list'].models : [];
  const out = [auto];
  for (const m of list) {
    if (!m?.id || !SAFE_ARG.test(m.id)) continue;
    const mult = m.billing?.multiplier;
    const label = `${m.name || m.id}${mult === 0 ? ' (dahil)' : typeof mult === 'number' && mult !== 1 ? ` (×${mult})` : ''}`;
    const item = { id: m.id, label, group: m.vendor || m.capabilities?.family || 'Modeller', ...(mult === 0 ? { free: true } : {}) };
    if (m.policy?.state === 'disabled') { item.disabled = true; item.note = 'Hesap ayarlarında kapalı (github.com → Copilot ayarları).'; }
    out.push(item);
  }
  if (out.length === 1) auto.note = 'Bu hesap (Copilot Free) modeli otomatik seçimle kullanır.';
  return out;
}

async function getLimits() {
  const info = await probe().catch(() => null);
  const q = info?.['account.getQuota']?.quotaSnapshots;
  if (!q) return null;
  const items = [];
  const notes = [];
  const add = (snap, label) => {
    if (!snap || snap.isUnlimitedEntitlement) return;
    if (!snap.entitlementRequests && !snap.hasQuota) return;
    const remaining = Number(snap.remainingPercentage);
    const item = { label, usedPercent: Number.isFinite(remaining) ? Math.max(0, Math.min(100, 100 - remaining)) : undefined };
    if (snap.entitlementRequests) item.text = `${snap.entitlementRequests} istek/ay`;
    const reset = Date.parse(snap.resetDate);
    if (Number.isFinite(reset) && reset > Date.now()) item.resetsAt = new Date(reset).toISOString();
    items.push(item);
  };
  add(q.chat, 'Sohbet / ajan istekleri');
  add(q.premium_interactions, 'Premium istekler');
  if (q.chat?.isUnlimitedEntitlement) notes.push('Sohbet: sınırsız');
  if (q.premium_interactions && !q.premium_interactions.entitlementRequests && !q.premium_interactions.isUnlimitedEntitlement) {
    notes.push('Premium istek hakkı yok (Copilot Free)');
  }
  const login = info?.['auth.getStatus']?.login;
  if (login) notes.push(`Hesap: ${login}`);
  return { items, note: notes.join(' · ') || undefined };
}

function login() {
  const file = bin();
  if (!file) return { ok: false, reason: NOT_INSTALLED };
  probeCache = null;
  return openConsole({ title: 'GitHub Copilot - giriş', file, args: ['login'] });
}

// ---- run ------------------------------------------------------------------------------------

function permissionArgs(permission) {
  if (permission === 'full') return ['--allow-all'];
  const deny = permission === 'edit' ? ['--deny-tool=shell'] : ['--deny-tool=write', '--deny-tool=shell'];
  return ['--allow-all-tools', ...deny, '--disable-builtin-mcps'];
}

function describeError(text, { model } = {}) {
  const t = String(text || '');
  if (/not (logged|signed) in|no authentication|authenticate|copilot login|\b401\b|unauthori[sz]ed/i.test(t)) return NOT_LOGGED_IN;
  if (/from --model flag is not available|model .*not (available|supported|found)/i.test(t)) {
    return `Copilot: model kullanılamıyor (${model || 'otomatik'}) — bu hesapta yok; "Otomatik" seçin.`;
  }
  if (/session .*not found|no session|could not (find|resume)/i.test(t)) return 'Copilot oturumu bulunamadı (session not found). Yeni bir sohbet başlatın.';
  if (/quota|rate.?limit|\b429\b|too many requests|exceeded|usage limit|limit reached/i.test(t)) {
    return `Copilot kullanım limiti doldu (usage limit). ${truncate(firstLine(t), 200)}`;
  }
  if (/ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|network|\b50[0234]\b|overloaded/i.test(t)) return `Copilot bağlantı hatası: ${truncate(firstLine(t), 200)}`;
  const line = firstLine(t.replace(/^Error:\s*/i, ''));
  return line ? `Copilot hatası: ${truncate(line, 300)}` : 'Copilot beklenmedik şekilde kapandı.';
}

const shortInput = (v) => {
  if (v == null) return undefined;
  if (typeof v === 'string') return truncate(v, 4000);
  const s = JSON.stringify(v);
  return s.length > 4000 ? truncate(s, 4000) : v;
};

const TOOL_NAMES = { view: 'Read', powershell: 'Shell', bash: 'Shell', shell: 'Shell', apply_patch: 'Edit', edit: 'Edit', create: 'Write', str_replace_editor: 'Edit', glob: 'Glob', grep: 'Grep', rg: 'Grep', web_fetch: 'WebFetch', report_intent: 'Plan', update_todo: 'Plan' };

export function createMapper(onEvent) {
  const st = { sessionId: null, lastText: '', error: null, model: null, exitCode: null, premiumRequests: null };
  st.handle = (o) => {
    if (!o || typeof o !== 'object') return;
    const d = o.data || {};
    switch (o.type) {
      case 'session.auto_mode_resolved':
        if (d.chosenModel) onEvent({ type: 'status', text: `Otomatik model: ${d.chosenModel}` });
        break;
      case 'assistant.message_delta':
        if (typeof d.deltaContent === 'string' && d.deltaContent) onEvent({ type: 'text-delta', text: d.deltaContent });
        break;
      case 'assistant.message':
        if (d.model) st.model = d.model;
        if (typeof d.content === 'string' && d.content.trim()) {
          st.lastText = d.content;
          onEvent({ type: 'message', text: d.content });
        }
        break;
      case 'assistant.reasoning':
        if (typeof d.content === 'string' && d.content.trim()) onEvent({ type: 'thinking', text: d.content });
        break;
      case 'tool.execution_start': {
        let input = d.arguments;
        // apply_patch gets the raw patch text: show the files it touches first.
        if (typeof input === 'string' && /\*\*\* (Update|Add|Delete) File:/.test(input)) {
          const files = [...input.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim());
          input = { path: files.join(', '), patch: truncate(input, 3000) };
        }
        onEvent({ type: 'tool-start', id: d.toolCallId, name: TOOL_NAMES[d.toolName] || d.toolTitle || d.toolName || 'araç', input: shortInput(input) });
        break;
      }
      case 'tool.execution_complete': {
        const err = d.error?.message;
        const out = err || (typeof d.result?.content === 'string' ? d.result.content : shortInput(d.result) ?? '');
        onEvent({ type: 'tool-end', id: d.toolCallId, output: truncate(typeof out === 'string' ? out : JSON.stringify(out), 4000), isError: d.success === false });
        break;
      }
      case 'result':
        st.sessionId = o.sessionId || st.sessionId;
        st.exitCode = o.exitCode ?? null;
        st.premiumRequests = o.usage?.premiumRequests ?? null;
        break;
      default:
        if (/error$/i.test(o.type || '') && (d.message || d.error)) {
          st.error = d.message || d.error?.message || String(d.error);
          onEvent({ type: 'status', text: `Copilot: ${truncate(st.error, 300)}` });
        }
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

  const args = ['--output-format', 'json', '--no-auto-update', '--no-color', '--no-ask-user', ...permissionArgs(permission)];
  if (model) args.push('--model', model);
  if (sessionId) args.push(`--resume=${sessionId}`);

  // No system-prompt flag: instructions are prepended to the prompt, once per session.
  let input = String(prompt ?? '');
  if (system && (!sessionId || systemBySession.get(sessionId) !== system)) {
    input = `<system-instructions>\n${system}\n</system-instructions>\n\n${input}`;
  }

  const st = createMapper(onEvent);
  const lines = [];
  onEvent({ type: 'status', text: sessionId ? 'Copilot oturumu sürdürülüyor…' : 'Copilot başlatılıyor…' });
  let code;
  let stderr = '';
  try {
    ({ code, stderr } = await runJsonl({
      file, args, cwd: realCwd(cwd), env: cleanEnv({ NO_COLOR: '1' }), stdin: input, signal,
      onJson: st.handle,
      onLine: (l) => { if (lines.length < 40) lines.push(l); },
    }));
  } catch (err) {
    if (err instanceof AbortError || err?.name === 'AbortError') throw err;
    throw fail(err?.code === 'ENOENT' ? NOT_INSTALLED : `Copilot başlatılamadı: ${err?.message || err}`);
  }
  probeCache = null; // quota changed

  const sid = st.sessionId || sessionId;
  if (sid && system) systemBySession.set(sid, system);
  if (code === 0 && (st.exitCode == null || st.exitCode === 0) && !(st.error && !st.lastText)) {
    onEvent({ type: 'done', text: st.lastText, sessionId: sid });
    return { text: st.lastText, sessionId: sid };
  }
  const detail = [st.error, ...lines, stderr].filter(Boolean).join('\n');
  throw fail(describeError(detail || `çıkış kodu ${code}`, { model }));
}

export default {
  id: 'copilot',
  name: NAME,
  capabilities: { edit: true, resume: true, streaming: true, cwd: true, sandbox: true, localProcess: true, editShell: false },
  detect,
  listModels,
  getLimits,
  login,
  run,
};

export const _internal = { describeError, permissionArgs, headless, fmtTime };

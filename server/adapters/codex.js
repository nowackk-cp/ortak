// OpenAI Codex CLI adapter: drives `codex exec --json`. See docs/CONTRACT.md §1.
//
// One run = one `codex exec` process (codex.CMD shim → cmd.exe, so nothing user-written ever goes
// on argv: the prompt is read from stdin via the `-` argument, cwd is the spawn cwd, model ids and
// session ids are validated). A session is continued with `codex exec resume <threadId> -`.
//
// Permission mapping (approval_policy=never everywhere, so a prompt can never block — anything
// that would need approval fails and the model is told so):
//   read-only → -s read-only                       (resume: -c sandbox_mode=read-only)
//   edit      → -s workspace-write                 (resume: -c sandbox_mode=workspace-write)
//               writes limited to cwd, shell commands run inside Codex's sandbox, no network
//   full      → --dangerously-bypass-approvals-and-sandbox
//
// `codex exec --json` does not stream tokens: each finished agent message is one `message` event.
import { realpathSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { which, runJsonl, capture, cleanEnv, truncate, AbortError, spawnCli, killTree } from './base.js';

const BIN = 'codex';
const SAFE_ARG = /^[A-Za-z0-9._:\/-]+$/; // model slugs / thread ids we accept on argv (cmd.exe-safe)

const NOT_INSTALLED = 'Codex CLI bulunamadı: `npm i -g @openai/codex` ile kurun (`codex` PATH üzerinde olmalı).';
const NOT_LOGGED_IN = 'Codex oturumu yok veya süresi dolmuş: terminalde `codex login` çalıştırın.';

// ---- module state ---------------------------------------------------------------------------

let lastLimits = null;     // { snap, at } latest normalized rate-limit snapshot (probe or run)
let probeCache = null;     // { at, entry } result of the app-server probe
let probeInFlight = null;
const systemBySession = new Map(); // threadId → last `system` text sent (avoid repeating it)
// threadId → cumulative token totals. On `exec resume`, turn.completed.usage is the running total
// of the whole thread (verified: 35757 → 53839), so per-turn usage = new total − previous total.
const totalsBySession = new Map();

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const fmtTime = (iso) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

/** Expand Windows 8.3 short names so paths in events/sessions are stable (see claude.js). */
function canonicalCwd(cwd) {
  if (!cwd) return cwd;
  try { return realpathSync.native(cwd); } catch { return cwd; }
}

// ---- detect / models ------------------------------------------------------------------------

async function detect() {
  const file = which(BIN);
  if (!file) return { available: false, reason: NOT_INSTALLED };
  const [ver, login] = await Promise.all([
    capture(file, ['--version'], { timeoutMs: 5000 }),
    capture(file, ['login', 'status'], { timeoutMs: 5000 }),
  ]);
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [])[0];
  if (!ver.ok && !version) {
    return { available: false, reason: `Codex çalıştırılamadı: ${truncate(firstLine(ver.stderr || ver.stdout), 200)}` };
  }
  // `codex login status` → "Logged in using ChatGPT" (exit 0) / "Not logged in" (exit 1).
  const out = `${login.stdout}\n${login.stderr}`;
  if (/not logged in/i.test(out) || (!login.ok && !/logged in/i.test(out))) {
    return { available: false, version, reason: NOT_LOGGED_IN };
  }
  return { available: true, version };
}

/** `model = "…"` from the top level of config.toml (nothing else is read out of that file). */
async function configModel() {
  try {
    const text = await readFile(path.join(codexHome(), 'config.toml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break; // first table header: top-level keys are over
      const m = line.match(/^\s*model\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
  } catch { /* no config */ }
  return null;
}

async function listModels() {
  const def = await configModel();
  let models = [];
  try {
    const cache = JSON.parse(await readFile(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    models = (Array.isArray(cache) ? cache : cache.models || [])
      .filter((m) => m?.slug && (m.visibility == null || m.visibility === 'list'))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch { /* cache missing: fall back to the configured model only */ }
  if (def && !models.some((m) => m.id === def)) models.unshift({ id: def, label: `${def} (ayar)` });
  if (!models.length) return [{ id: 'default', label: 'Varsayılan (Codex ayarı)', default: true }];
  const d = models.find((m) => m.id === def) || models[0];
  d.default = true;
  return models;
}

// ---- limits ---------------------------------------------------------------------------------
//
// Sources, freshest first (all exposed by Codex itself, no credential files):
//  1. `codex app-server` JSON-RPC `account/rateLimits/read` — live from the backend, no tokens.
//  2. Rate limits recorded in session rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
//     `event_msg` / `token_count` lines) — refreshed after each run and scanned as a fallback.

function windowLabel(mins) {
  if (mins === 300) return '5 saatlik limit';
  if (mins === 10080) return 'Haftalık limit';
  if (!mins) return 'Limit';
  if (mins % 1440 === 0) return `${mins / 1440} günlük limit`;
  if (mins % 60 === 0) return `${mins / 60} saatlik limit`;
  return `${mins} dakikalık limit`;
}

/** app-server (camelCase) or rollout (snake_case) bucket → normalized { primary, secondary, … }. */
function normalizeBucket(b) {
  if (!b) return null;
  const win = (w) => w && {
    usedPercent: Number(w.usedPercent ?? w.used_percent ?? 0),
    mins: w.windowDurationMins ?? w.window_minutes ?? null,
    resetsAt: w.resetsAt ?? w.resets_at ?? null,
  };
  const credits = b.credits && {
    hasCredits: !!(b.credits.hasCredits ?? b.credits.has_credits),
    unlimited: !!b.credits.unlimited,
    balance: b.credits.balance ?? null,
  };
  return {
    limitId: b.limitId ?? b.limit_id ?? null,
    limitName: b.limitName ?? b.limit_name ?? b.normalModelSlug ?? null,
    primary: win(b.primary),
    secondary: win(b.secondary),
    credits,
    planType: b.planType ?? b.plan_type ?? null,
    reached: b.rateLimitReachedType ?? b.rate_limit_reached_type ?? null,
  };
}

function limitItems(snap) {
  const items = [];
  for (const bucket of snap.buckets) {
    const prefix = bucket.limitId && bucket.limitId !== 'codex' ? `${bucket.limitName || bucket.limitId}: ` : '';
    for (const w of [bucket.primary, bucket.secondary]) {
      if (!w) continue;
      const item = { label: prefix + windowLabel(w.mins), usedPercent: Math.min(100, Math.max(0, w.usedPercent)) };
      if (w.resetsAt) {
        const ms = w.resetsAt * 1000;
        if (ms < Date.now()) { item.usedPercent = 0; item.text = 'Sıfırlandı'; } // window rolled over
        else item.resetsAt = new Date(ms).toISOString();
      }
      items.push(item);
    }
    if (bucket.credits?.hasCredits || bucket.credits?.unlimited) {
      items.push({ label: `${prefix}Kredi`, text: bucket.credits.unlimited ? 'Sınırsız' : `Bakiye: ${bucket.credits.balance ?? '?'}` });
    }
  }
  return items;
}

/** One JSON-RPC request against a short-lived `codex app-server`. Resolves `result` or null. */
function appServerRequest(method, params, timeoutMs = 12000) {
  const file = which(BIN);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try { child = spawnCli(file, ['app-server'], { cwd: os.tmpdir(), env: cleanEnv() }); } catch { return resolve(null); }
    let buf = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 0) {
          if (msg.error) return finish(null);
          send({ method: 'initialized' });
          send({ id: 1, method, params });
        } else if (msg.id === 1) {
          return finish(msg.error ? null : msg.result);
        }
      }
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'ortak', title: 'Ortak', version: '0.1.0' } } });
  });
}

async function probeLimits() {
  const res = await appServerRequest('account/rateLimits/read', { excludeResetCreditDetails: true });
  if (!res) return null;
  const raw = res.rateLimitsByLimitId && Object.keys(res.rateLimitsByLimitId).length
    ? Object.values(res.rateLimitsByLimitId)
    : [res.rateLimits];
  const buckets = raw.map(normalizeBucket).filter(Boolean);
  if (!buckets.length) return null;
  return { buckets, blocked: res.ordinaryUsageAllowed === false };
}

/** Last `size` bytes of a file, split into complete lines. */
async function tailLines(file, size = 262144) {
  const fh = await open(file, 'r');
  try {
    const { size: total } = await fh.stat();
    const start = Math.max(0, total - size);
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(total - start), 0, total - start, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is partial
    return lines;
  } finally {
    await fh.close();
  }
}

/**
 * Newest `token_count` data in one rollout file:
 *   { limits: { ts, bucket } | null, totals: { inputTokens, outputTokens } | null }
 */
async function rolloutInfo(file) {
  const res = { limits: null, totals: null };
  let lines;
  try { lines = await tailLines(file); } catch { return res; }
  for (let i = lines.length - 1; i >= 0 && !(res.limits && res.totals); i--) {
    const line = lines[i];
    if (!line.includes('"token_count"')) continue;
    try {
      const o = JSON.parse(line);
      const rl = o.payload?.rate_limits;
      const tot = o.payload?.info?.total_token_usage;
      if (rl && !res.limits) res.limits = { ts: Date.parse(o.timestamp) || 0, bucket: normalizeBucket(rl) };
      if (tot && !res.totals) res.totals = { inputTokens: tot.input_tokens || 0, outputTokens: tot.output_tokens || 0 };
    } catch { /* partial line */ }
  }
  return res;
}

/** Rollout file of one thread (searches the newest day-directories by name, no stat calls). */
async function findRollout(threadId, maxDays = 60) {
  const root = path.join(codexHome(), 'sessions');
  const desc = async (p) => (await readdir(p).catch(() => [])).filter((n) => /^\d+$/.test(n)).sort().reverse();
  let days = 0;
  for (const y of await desc(root)) {
    for (const m of await desc(path.join(root, y))) {
      for (const d of await desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const hit = (await readdir(dir).catch(() => [])).find((n) => n.endsWith(`${threadId}.jsonl`));
        if (hit) return path.join(dir, hit);
        if (++days >= maxDays) return null;
      }
    }
  }
  return null;
}

/** Rollout files of the most recent `days` day-directories, newest first (by mtime). */
async function recentRollouts(days = 4) {
  const root = path.join(codexHome(), 'sessions');
  const dirs = [];
  const desc = async (p) => (await readdir(p).catch(() => [])).filter((n) => /^\d+$/.test(n)).sort().reverse();
  outer: for (const y of await desc(root)) {
    for (const m of await desc(path.join(root, y))) {
      for (const d of await desc(path.join(root, y, m))) {
        dirs.push(path.join(root, y, m, d));
        if (dirs.length >= days) break outer;
      }
    }
  }
  const files = [];
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      const s = await stat(full).catch(() => null);
      if (s) files.push({ full, name, mtime: s.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
}

async function scanRollouts(maxFiles = 12) {
  let best = null;
  for (const f of (await recentRollouts()).slice(0, maxFiles)) {
    const { limits } = await rolloutInfo(f.full);
    if (limits && (!best || limits.ts > best.ts)) best = limits;
  }
  return best && { snap: { buckets: [best.bucket] }, at: new Date(best.ts).toISOString() };
}

const newer = (a, b) => (!a ? b : !b ? a : Date.parse(b.at) > Date.parse(a.at) ? b : a);

async function getLimits() {
  try {
    if (!probeCache || Date.now() - probeCache.at > 45000) {
      probeInFlight ||= probeLimits().finally(() => { probeInFlight = null; });
      const snap = await probeInFlight;
      probeCache = { at: Date.now(), entry: snap && { snap, at: new Date().toISOString() } };
    }
    const live = probeCache.entry;
    // A run that finished after the probe wrote fresher numbers into its rollout.
    lastLimits = newer(lastLimits, live) || await scanRollouts();
    const current = lastLimits;
    if (!current) return null;

    const items = limitItems(current.snap);
    const notes = [];
    const plan = current.snap.buckets.map((b) => b.planType).find(Boolean);
    if (plan) notes.push(`Plan: ${plan}`);
    if (current.snap.blocked || current.snap.buckets.some((b) => b.reached)) notes.push('Kullanım limiti doldu');
    if (current !== live) notes.push(`Son kayıttan (${fmtTime(current.at)})`);
    return { items, note: notes.join(' · ') || undefined };
  } catch {
    return null;
  }
}

function resetHint() {
  if (!lastLimits) return '';
  const full = limitItems(lastLimits.snap).filter((i) => i.resetsAt && i.usedPercent >= 99);
  const next = full.map((i) => i.resetsAt).sort().pop();
  return next ? ` Sıfırlanma: ${fmtTime(next)}.` : '';
}

// ---- run ------------------------------------------------------------------------------------

function permissionArgs(permission, resume) {
  if (permission === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  const mode = permission === 'edit' ? 'workspace-write' : 'read-only';
  // `exec resume` has no -s flag; the same setting goes through a config override. Values are
  // bare words (invalid TOML → taken as literal strings), so no quotes travel through cmd.exe.
  const sandbox = resume ? ['-c', `sandbox_mode=${mode}`] : ['-s', mode];
  return [...sandbox, '-c', 'approval_policy=never'];
}

/** Short, actionable Turkish message for a failed run. */
function describeError(text, { model } = {}) {
  const t = String(text || '');
  if (/not logged in|please (log ?in|sign in)|\b401\b|unauthorized|refresh token|login required|authentication/i.test(t)) return NOT_LOGGED_IN;
  if (/no rollout found|thread .*not found|no saved session|session .*not found/i.test(t)) {
    return 'Codex oturumu bulunamadı (silinmiş ya da başka bir CODEX_HOME). Yeni bir sohbet başlatın.';
  }
  if (/usage limit|rate.?limit|\b429\b|too many requests|quota/i.test(t)) {
    const again = t.match(/try again (in|at) [^.\n]+/i);
    return 'Codex kullanım limiti doldu.' + (resetHint() || (again ? ` (${again[0]})` : ''));
  }
  if (/model/i.test(t) && /(not supported|not found|does not exist|unknown|invalid|not available|no access)/i.test(t)) {
    return `Model kullanılamıyor: ${model || 'varsayılan'} — başka bir model seçin.`;
  }
  if (/context (window|length)|too long|maximum context/i.test(t)) return 'İstem çok uzun: modelin bağlam penceresi aşıldı.';
  if (/stream disconnected|connection|network|timed? ?out|ECONN|ENOTFOUND/i.test(t)) return `Codex bağlantı hatası: ${truncate(firstLine(t), 200)}`;
  const line = firstLine(t.replace(/^Error:\s*/i, ''));
  return line ? `Codex hatası: ${truncate(line, 300)}` : 'Codex beklenmedik şekilde kapandı.';
}

/** Codex often wraps backend errors as a JSON string: {"error":{"message":"…"}}. */
function unwrapMessage(m) {
  if (typeof m !== 'string' || !m.trim().startsWith('{')) return m;
  try { const o = JSON.parse(m); return o.error?.message || o.message || m; } catch { return m; }
}

const shortJson = (v) => (v == null ? '' : typeof v === 'string' ? truncate(v, 4000) : truncate(JSON.stringify(v), 4000));

function todoText(items) {
  return (items || []).map((it) => `${it.completed ? '[x]' : '[ ]'} ${it.text}`).join('\n');
}

/** Turns `codex exec --json` events into AdapterEvents. */
function createMapper(onEvent) {
  const st = {
    threadId: null, lastText: '', usage: null, turnDone: false, turnFailed: null, lastError: null,
    started: new Set(), msgText: new Map(),
  };

  const start = (id, name, input) => {
    if (st.started.has(id)) return;
    st.started.add(id);
    onEvent({ type: 'tool-start', id, name, input });
  };

  const item = (phase, it) => {
    const id = it.id;
    switch (it.type) {
      case 'agent_message': {
        const text = it.text || '';
        if (phase === 'completed') {
          if (text) { st.lastText = text; onEvent({ type: 'message', text }); }
        } else {
          // Not emitted by 0.159, but stream growing text if a future version does.
          const prev = st.msgText.get(id) || '';
          if (text.length > prev.length && text.startsWith(prev)) onEvent({ type: 'text-delta', text: text.slice(prev.length) });
          st.msgText.set(id, text);
        }
        break;
      }
      case 'reasoning':
        if (phase === 'completed' && it.text) onEvent({ type: 'thinking', text: it.text });
        break;
      case 'command_execution':
        start(id, 'Shell', { command: truncate(String(it.command ?? ''), 2000) });
        if (phase === 'completed') {
          const failed = it.status === 'failed' || it.status === 'declined' || (it.exit_code != null && it.exit_code !== 0);
          let output = it.aggregated_output || '';
          if (it.status === 'declined') output ||= 'Komut reddedildi (izin yok).';
          else if (it.exit_code != null && it.exit_code !== 0) output += `\n(çıkış kodu ${it.exit_code})`;
          onEvent({ type: 'tool-end', id, output: truncate(output, 4000), isError: failed });
        }
        break;
      case 'file_change':
        start(id, 'Edit', { changes: (it.changes || []).map((c) => `${c.kind}: ${c.path}`).slice(0, 50) });
        if (phase === 'completed') {
          onEvent({ type: 'tool-end', id, output: it.status === 'failed' ? 'Değişiklik uygulanamadı' : 'Değişiklik uygulandı', isError: it.status === 'failed' });
        }
        break;
      case 'mcp_tool_call':
        start(id, `${it.server || 'mcp'}.${it.tool || '?'}`, shortJson(it.arguments));
        if (phase === 'completed') {
          const err = it.error?.message || (typeof it.error === 'string' ? it.error : null);
          const out = err || (it.result?.content ? it.result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') : shortJson(it.result));
          onEvent({ type: 'tool-end', id, output: truncate(out, 4000), isError: !!err || it.status === 'failed' });
        }
        break;
      case 'web_search':
        start(id, 'WebSearch', { query: it.query ?? '' });
        if (phase === 'completed') onEvent({ type: 'tool-end', id, output: it.query ? `Arandı: ${it.query}` : 'Tamamlandı', isError: false });
        break;
      case 'todo_list':
        start(id, 'Plan', todoText(it.items));
        if (phase === 'updated') {
          const done = (it.items || []).filter((x) => x.completed).length;
          onEvent({ type: 'status', text: `Plan: ${done}/${(it.items || []).length} tamamlandı` });
        } else if (phase === 'completed') {
          onEvent({ type: 'tool-end', id, output: todoText(it.items), isError: false });
        }
        break;
      case 'error':
        if (phase === 'completed' && it.message) onEvent({ type: 'status', text: `Uyarı: ${truncate(it.message, 300)}` });
        break;
      default: {
        // Unknown item kinds (collab/agent calls, images, …): show them as generic tool calls.
        const { id: _id, type, status, ...rest } = it;
        start(id, type || 'araç', shortJson(rest));
        if (phase === 'completed') onEvent({ type: 'tool-end', id, output: status ? String(status) : 'Tamamlandı', isError: status === 'failed' });
      }
    }
  };

  st.handle = (o) => {
    switch (o.type) {
      case 'thread.started':
        st.threadId = o.thread_id || st.threadId;
        onEvent({ type: 'status', text: 'Codex oturumu başladı' });
        break;
      case 'turn.started':
        onEvent({ type: 'status', text: 'Codex çalışıyor…' });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (o.item) item(o.type.slice(5), o.item);
        break;
      case 'turn.completed':
        st.turnDone = true;
        if (o.usage) {
          st.usage = {
            inputTokens: o.usage.input_tokens || 0, // includes cached_input_tokens
            outputTokens: o.usage.output_tokens || 0,
          };
        }
        break;
      case 'turn.failed':
        st.turnFailed = unwrapMessage(o.error?.message) || 'Tur başarısız oldu';
        break;
      case 'error':
        // Also used for transient notices (e.g. reconnects); only fatal if the turn never completes.
        if (o.message) {
          st.lastError = unwrapMessage(o.message);
          onEvent({ type: 'status', text: `Codex: ${truncate(st.lastError, 300)}` });
        }
        break;
      default:
        break;
    }
  };
  return st;
}

async function run({ prompt, cwd, model, sessionId, permission = 'read-only', system, signal, onEvent = () => {} }) {
  const fail = (message) => { onEvent({ type: 'error', message }); return new Error(message); };

  const file = which(BIN);
  if (!file) throw fail(NOT_INSTALLED);
  if (model === 'default') model = undefined;
  if (model && !SAFE_ARG.test(model)) throw fail(`Geçersiz model adı: ${truncate(model, 60)}`);
  if (sessionId && !SAFE_ARG.test(sessionId)) throw fail('Geçersiz oturum kimliği.');

  const args = sessionId ? ['exec', 'resume'] : ['exec'];
  args.push('--json', '--skip-git-repo-check');
  if (model) args.push('-m', model);
  args.push(...permissionArgs(permission, !!sessionId));
  if (sessionId) args.push(sessionId);
  args.push('-'); // read the prompt from stdin

  // exec has no system-prompt flag (and argv goes through cmd.exe), so instructions are prepended
  // to the prompt — once per session unless they change.
  let input = String(prompt ?? '');
  if (system && (!sessionId || systemBySession.get(sessionId) !== system)) {
    input = `<system-instructions>\n${system}\n</system-instructions>\n\n${input}`;
  }

  const st = createMapper(onEvent);
  onEvent({ type: 'status', text: sessionId ? 'Codex oturumu sürdürülüyor…' : 'Codex başlatılıyor…' });

  let prevTotals = null;
  let rollout = null; // this thread's rollout file, once known
  if (sessionId) {
    prevTotals = totalsBySession.get(sessionId) || null;
    if (!prevTotals) {
      rollout = await findRollout(sessionId).catch(() => null);
      prevTotals = rollout ? (await rolloutInfo(rollout)).totals : null;
    }
  }

  let code;
  let stderr = '';
  try {
    ({ code, stderr } = await runJsonl({
      file, args, cwd: canonicalCwd(cwd), env: cleanEnv(), stdin: input, signal, onJson: st.handle,
    }));
  } catch (err) {
    if (err instanceof AbortError || err?.name === 'AbortError') throw err;
    throw fail(err?.code === 'ENOENT' ? NOT_INSTALLED : `Codex başlatılamadı: ${err?.message || err}`);
  }

  const threadId = st.threadId || sessionId;
  if (threadId && system) systemBySession.set(threadId, system);

  // Pick up the rate limits Codex just wrote into this thread's rollout (exec --json omits them).
  if (threadId) {
    rollout ||= await findRollout(threadId).catch(() => null);
    const { limits } = rollout ? await rolloutInfo(rollout) : {};
    if (limits) lastLimits = newer(lastLimits, { snap: { buckets: [limits.bucket] }, at: new Date(limits.ts).toISOString() });
  }

  let usage;
  if (st.usage) {
    if (threadId) totalsBySession.set(threadId, st.usage);
    usage = prevTotals && st.usage.inputTokens >= prevTotals.inputTokens
      ? { inputTokens: st.usage.inputTokens - prevTotals.inputTokens, outputTokens: Math.max(0, st.usage.outputTokens - prevTotals.outputTokens) }
      : st.usage;
    onEvent({ type: 'usage', ...usage });
  }

  if (st.turnDone && !st.turnFailed && code === 0) {
    onEvent({ type: 'done', text: st.lastText, sessionId: threadId });
    return { text: st.lastText, sessionId: threadId, usage };
  }
  const detail = [st.turnFailed, st.lastError, stderr].filter(Boolean).join('\n');
  throw fail(describeError(detail || `çıkış kodu ${code}`, { model }));
}

export default {
  id: 'codex',
  name: 'OpenAI Codex',
  capabilities: { edit: true, resume: true, streaming: false, cwd: true, sandbox: true, localProcess: true },
  detect,
  listModels,
  getLimits,
  run,
};

// Exposed for unit tests only.
export const _internal = { describeError, createMapper, normalizeBucket, limitItems, scanRollouts, permissionArgs };

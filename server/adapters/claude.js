// Claude Code adapter: drives `claude -p --output-format stream-json`. See docs/CONTRACT.md §1.
//
// One run = one `claude -p` process. The prompt goes on stdin; the session is continued with
// `--resume <sessionId>`. stream-json lines are mapped to normalized AdapterEvents.
//
// Permission mapping (verified with claude 2.1.294; `--permission-prompts none` everywhere so a
// prompt can never block — anything that would ask is denied automatically):
//   read-only → --permission-mode dontAsk --tools <read tools> --allowedTools <read tools>
//               --strict-mcp-config
//               (only read tools exist in the session; no shell, no MCP servers. dontAsk denies
//                everything not pre-approved — even Read inside cwd — hence the explicit allow list.)
//   edit      → --permission-mode acceptEdits
//               (file edits inside cwd are auto-accepted; shell commands that would need approval
//                are auto-denied, because Claude's Bash sandbox is not available on Windows.
//                Commands the user pre-approved in their own Claude settings still run.)
//   full      → --dangerously-skip-permissions
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { which, runJsonl, capture, cleanEnv, truncate, AbortError } from './base.js';

const BIN = 'claude';
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
const MAX_ARGV_SYSTEM = 8000; // longer `system` texts are prepended to the prompt instead
const SAFE_ARG = /^[A-Za-z0-9._:\[\]\/-]+$/; // model ids / session ids we accept on argv

const NOT_INSTALLED = 'Claude Code bulunamadı: `claude` PATH üzerinde değil. Kurulum: https://claude.com/claude-code';
const NOT_LOGGED_IN = 'Claude Code oturumu yok veya süresi dolmuş: terminalde `claude auth login` çalıştırın.';

// ---- module state (shared across runs in this server process) -------------------------------

let authInfo = null;        // { subscriptionType } from `claude auth status`, filled by detect()
let lastRateLimit = null;   // { info, at } latest `rate_limit_event.rate_limit_info` seen in a run
let sessionCostUsd = 0;     // sum of total_cost_usd of all runs since the server started
let usageCache = null;      // { at, value } result of the `/usage` probe
let usageInFlight = null;   // shared promise while a probe is running
let usageProbeBroken = false; // set if `/usage` ever reaches a real model (then never probe again)

/** Env for child `claude` processes: no nesting markers from a parent Claude Code session. */
function childEnv() {
  const env = cleanEnv();
  // Set by a parent Claude Code session for its own tool shells; would leak effort/pid settings.
  delete env.CLAUDE_EFFORT;
  delete env.CLAUDE_PID;
  return env;
}

const isShim = (file) => /\.(cmd|bat)$/i.test(file);

/**
 * Canonical cwd. Windows 8.3 short names (C:\Users\ADMINI~1\…) must be expanded: with a short cwd
 * Claude Code does not recognise files as "inside the working directory", so acceptEdits stops
 * auto-accepting writes (verified). Sessions are also stored per cwd, so resume needs a stable form.
 */
function canonicalCwd(cwd) {
  if (!cwd) return cwd;
  try { return realpathSync.native(cwd); } catch { return cwd; }
}
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const fmtTime = (iso) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

// ---- detect / models ------------------------------------------------------------------------

async function detect() {
  const file = which(BIN);
  if (!file) return { available: false, reason: NOT_INSTALLED };
  const env = childEnv();
  const [ver, auth] = await Promise.all([
    capture(file, ['--version'], { env, timeoutMs: 5000 }),
    capture(file, ['auth', 'status', '--json'], { env, timeoutMs: 5000 }),
  ]);
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [])[0];
  if (!ver.ok && !version) {
    return { available: false, reason: `Claude Code çalıştırılamadı: ${truncate(firstLine(ver.stderr), 200)}` };
  }
  // `auth status --json` prints { loggedIn, authMethod, subscriptionType, ... } (no secrets).
  try {
    const st = JSON.parse(auth.stdout);
    authInfo = { subscriptionType: st.subscriptionType || null, authMethod: st.authMethod || null };
    if (st.loggedIn === false) return { available: false, version, reason: NOT_LOGGED_IN };
  } catch { /* older CLI without `auth status`: assume usable, run() reports auth errors */ }
  return { available: true, version };
}

// Aliases always point at the newest model of each family; ids in labels are what they resolved
// to when this was written (verified: haiku → claude-haiku-5-5).
const MODELS = [
  { id: 'default', label: 'Varsayılan (Claude Code ayarı)' },
  { id: 'fable', label: 'Fable 5.1 — en güçlü (claude-fable-5-1)' },
  { id: 'opus', label: 'Opus 5.5 (claude-opus-5-5)' },
  { id: 'sonnet', label: 'Sonnet 5.5 (claude-sonnet-5-5)' },
  { id: 'haiku', label: 'Haiku 5.5 — hızlı ve ucuz (claude-haiku-5-5)' },
];

async function listModels() {
  const list = MODELS.map((m) => ({ ...m }));
  list[0].default = true;
  // If the user pinned a model in ~/.claude/settings.json, show it as the default's label.
  try {
    const settings = JSON.parse(await readFile(path.join(claudeHome(), 'settings.json'), 'utf8'));
    if (typeof settings.model === 'string' && settings.model) {
      list[0].label = `Varsayılan (ayar: ${settings.model})`;
    }
  } catch { /* no settings file */ }
  return list;
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ---- limits ---------------------------------------------------------------------------------
//
// Two sources, both exposed by Claude Code itself (no credential files are touched):
//  1. `claude -p /usage` — a local slash command that works in print mode, costs no tokens
//     (model "<synthetic>", total_cost_usd 0) and prints e.g.
//       "Current session: 17% used · resets Oct 13, 8:09pm (Europe/Istanbul)"
//       "Current week (all models): 60% used · resets Oct 13, 7:59pm (Europe/Istanbul)"
//  2. `rate_limit_event` lines in every run's stream-json (five_hour / seven_day utilization 0..1
//     with exact resetsAt). Cached in module state; used when the probe fails.

const WINDOW_LABELS = {
  five_hour: '5 saatlik oturum limiti',
  seven_day: 'Haftalık limit (tüm modeller)',
  seven_day_opus: 'Haftalık limit (Opus)',
  seven_day_sonnet: 'Haftalık limit (Sonnet)',
  seven_day_fable: 'Haftalık limit (Fable)',
};

function usageLabel(name) {
  if (/^current session$/i.test(name)) return WINDOW_LABELS.five_hour;
  const m = name.match(/^current week(?:\s*\((.+)\))?$/i);
  if (m) {
    const scope = (m[1] || '').trim();
    if (!scope || /^all models$/i.test(scope)) return WINDOW_LABELS.seven_day;
    return `Haftalık limit (${scope.replace(/\s*only$/i, '')})`;
  }
  return name;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Offset (ms) of time zone `tz` from UTC at instant `t`. Throws RangeError for unknown zones. */
function tzOffset(t, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - Math.floor(t / 1000) * 1000;
}

/** Wall-clock time in `tz` (or local time if tz is unknown) → Date. */
function zonedDate(y, mo, d, h, mi, tz) {
  if (tz) {
    try {
      const guess = Date.UTC(y, mo, d, h, mi);
      let t = guess - tzOffset(guess, tz);
      t = guess - tzOffset(t, tz); // second pass handles DST edges
      return new Date(t);
    } catch { /* unknown zone → local */ }
  }
  return new Date(y, mo, d, h, mi);
}

/** Parse "resets Oct 13, 8:09pm (Europe/Istanbul)" / "resets 8:09pm (…)" / "resets in 2h 5m". */
function parseResets(text, now = Date.now()) {
  const rel = text.match(/resets in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    return new Date(now + ((+rel[1] || 0) * 1440 + (+rel[2] || 0) * 60 + (+rel[3] || 0)) * 60e3).toISOString();
  }
  const m = text.match(/resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*)?(?:(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m))?\s*(?:\(([^)]+)\))?/i);
  if (!m || (!m[1] && !m[3])) return undefined;
  const tz = m[6]?.trim();
  let hour = m[3] ? Number(m[3]) % 12 + (/p/i.test(m[5]) ? 12 : 0) : 0;
  const minute = m[4] ? Number(m[4]) : 0;
  // "Today" in the reported zone.
  let base = new Date(now);
  try { base = new Date(now + tzOffset(now, tz || Intl.DateTimeFormat().resolvedOptions().timeZone)); } catch {}
  let year = base.getUTCFullYear();
  let month = m[1] ? MONTHS[m[1].toLowerCase()] : base.getUTCMonth();
  let day = m[2] ? Number(m[2]) : base.getUTCDate();
  if (month === undefined) return undefined;
  let date = zonedDate(year, month, day, hour, minute, tz);
  if (date.getTime() < now - 864e5) date = zonedDate(year + 1, month, day, hour, minute, tz); // year rollover
  else if (!m[1] && date.getTime() < now) date = new Date(date.getTime() + 864e5); // time-only: next day
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseUsageText(text) {
  const items = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(Current [^:]+):\s*(\d+(?:\.\d+)?)\s*%\s*used(.*)$/i);
    if (!m) continue;
    const resetsAt = parseResets(m[3]);
    const item = { label: usageLabel(m[1].trim()), usedPercent: Math.min(100, Number(m[2])) };
    if (resetsAt) item.resetsAt = resetsAt;
    else if (/resets/i.test(m[3])) item.text = m[3].replace(/^\s*·\s*/, '').trim();
    items.push(item);
  }
  return items;
}

function itemsFromRateLimit(info) {
  const windows = info?.unifiedWindows || {};
  const items = Object.entries(windows).map(([key, w]) => {
    const item = { label: WINDOW_LABELS[key] || key };
    if (typeof w?.utilization === 'number') item.usedPercent = Math.round(Math.min(1, w.utilization) * 1000) / 10;
    if (w?.resetsAt) item.resetsAt = new Date(w.resetsAt * 1000).toISOString();
    // A window whose reset time has passed is empty again.
    if (item.resetsAt && Date.parse(item.resetsAt) < Date.now()) { item.usedPercent = 0; delete item.resetsAt; item.text = 'Sıfırlandı'; }
    return item;
  });
  if (!items.length && info?.rateLimitType) {
    items.push({
      label: WINDOW_LABELS[info.rateLimitType] || info.rateLimitType,
      ...(info.resetsAt ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
      text: info.status === 'rejected' ? 'Limit doldu' : undefined,
    });
  }
  return items;
}

/** Run `claude -p /usage` (no tokens used). Resolves { items, subscription } or null. */
async function probeUsage() {
  const file = which(BIN);
  if (!file || usageProbeBroken) return null;
  let resultText = null;
  let realModel = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    await runJsonl({
      file,
      // haiku + no tools + no persistence: if a future CLI ever forwarded "/usage" to a model,
      // the single accidental call stays as cheap as possible (and we stop probing, see below).
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--tools', '',
        '--no-session-persistence', '--permission-prompts', 'none'],
      cwd: os.tmpdir(),
      env: childEnv(),
      stdin: '/usage',
      signal: ctrl.signal,
      onJson: (o) => {
        if (o.type === 'stream_event' || (o.type === 'assistant' && o.message?.model && o.message.model !== '<synthetic>')) {
          realModel = true;
        }
        if (o.type === 'result' && !o.is_error) resultText = o.result;
      },
    });
  } catch { /* timeout / spawn failure */ } finally {
    clearTimeout(timer);
  }
  if (realModel) { usageProbeBroken = true; return null; }
  if (!resultText) return null;
  const items = parseUsageText(resultText);
  return items.length ? { items, subscription: /subscription/i.test(firstLine(resultText)) } : null;
}

async function getLimits() {
  try {
    if (!usageCache || Date.now() - usageCache.at > 45000) {
      usageInFlight ||= probeUsage().finally(() => { usageInFlight = null; });
      usageCache = { at: Date.now(), value: await usageInFlight };
    }
    const notes = [];
    const plan = authInfo?.subscriptionType;
    let items = usageCache.value?.items;
    if (items?.length) {
      if (usageCache.value.subscription) notes.push(`Abonelik kullanılıyor${plan ? ` (${plan})` : ''}`);
    } else if (lastRateLimit) {
      items = itemsFromRateLimit(lastRateLimit.info);
      notes.push(`Son çalıştırmadan (${fmtTime(lastRateLimit.at)})`);
    }
    if (sessionCostUsd > 0) notes.push(`Ortak'ta bu oturumda ≈ $${sessionCostUsd.toFixed(4)} (API liste fiyatı)`);
    if (!items?.length) return notes.length ? { items: [], note: notes.join(' · ') } : null;
    return { items, note: notes.join(' · ') || undefined };
  } catch {
    return null;
  }
}

// ---- run ------------------------------------------------------------------------------------

function permissionArgs(permission) {
  switch (permission) {
    case 'full':
      return ['--dangerously-skip-permissions'];
    case 'edit':
      return ['--permission-mode', 'acceptEdits'];
    default: // 'read-only' and anything unknown
      return ['--permission-mode', 'dontAsk', '--tools', READ_ONLY_TOOLS.join(','),
        '--allowedTools', READ_ONLY_TOOLS.join(','), '--strict-mcp-config'];
  }
}

/** Keep tool inputs small: long string fields (file contents, patches) are cut. */
function compactInput(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return truncate(String(input), 4000);
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? truncate(v, 1500) : v;
  return JSON.stringify(out).length > 4000 ? truncate(JSON.stringify(out), 4000) : out;
}

function toolOutput(content) {
  if (content == null) return '';
  if (typeof content === 'string') return truncate(content, 4000);
  if (Array.isArray(content)) {
    return truncate(content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[görsel]' : JSON.stringify(b))).join('\n'), 4000);
  }
  return truncate(JSON.stringify(content), 4000);
}

function resetHint() {
  const info = lastRateLimit?.info;
  if (!info) return '';
  // Prefer the window that is actually limiting, then the event's own reset time.
  const secs = info.unifiedWindows?.[info.rateLimitType]?.resetsAt || info.resetsAt;
  return secs && secs * 1000 > Date.now() ? ` Sıfırlanma: ${fmtTime(secs * 1000)}.` : '';
}

/** Short, actionable Turkish message for a failed run. */
function describeError(text, { model, code } = {}) {
  const t = String(text || '');
  if (/not logged in|please run \/login|invalid api key|authentication|oauth token (has )?expired|\b401\b/i.test(t)) return NOT_LOGGED_IN;
  if (/no conversation found|session .*not found|could not find session/i.test(t)) {
    return 'Claude oturumu bulunamadı (bu klasörde başlatılmamış ya da silinmiş). Yeni bir sohbet başlatın.';
  }
  if (/usage limit|rate.?limit|limit reached|hit your limit|\b429\b|out of (extra )?usage/i.test(t)) return 'Claude kullanım limiti doldu.' + resetHint();
  if (/overloaded|\b529\b/i.test(t)) return 'Claude sunucuları şu an aşırı yoğun; biraz sonra tekrar deneyin.';
  if (/credit balance|insufficient (credit|balance|funds)|billing_error/i.test(t)) return 'Claude hesabında kredi/bakiye yetersiz.';
  if (/model/i.test(t) && /(not.?found|not available|invalid|(does|may) not exist|not have access|unknown|isn't available|not supported)/i.test(t)) {
    return `Model kullanılamıyor: ${model || 'varsayılan'} — başka bir model seçin.`;
  }
  if (/prompt is too long|context (length|window)/i.test(t)) return 'İstem çok uzun: modelin bağlam penceresi aşıldı.';
  const line = firstLine(t);
  return line ? `Claude Code hatası: ${truncate(line, 300)}` : `Claude Code beklenmedik şekilde kapandı (çıkış kodu ${code}).`;
}

/** Turns stream-json objects into AdapterEvents. Keeps the bits run() needs at the end. */
function createMapper(onEvent) {
  const st = { sessionId: null, model: null, result: null, lastText: '', seen: new Set() };
  const once = (key) => (st.seen.has(key) ? false : (st.seen.add(key), true));

  st.handle = (o) => {
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init') {
          st.sessionId = o.session_id || st.sessionId;
          st.model = o.model || st.model;
          onEvent({ type: 'status', text: `Claude Code hazır · ${o.model || 'model'}` });
        } else if (o.subtype === 'status' && o.status === 'compacting') {
          onEvent({ type: 'status', text: 'Bağlam sıkıştırılıyor…' });
        } else if (o.subtype === 'compact_boundary') {
          onEvent({ type: 'status', text: 'Bağlam sıkıştırıldı' });
        } else if (o.subtype === 'api_retry') {
          onEvent({ type: 'status', text: `API yeniden deneniyor (${o.attempt ?? '?'}/${o.max_retries ?? '?'})` });
        }
        break;

      case 'stream_event': {
        if (o.parent_tool_use_id) break; // subagent internals: only their tool calls are shown
        const ev = o.event || {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          onEvent({ type: 'text-delta', text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
          onEvent({ type: 'status', text: 'Düşünüyor…' });
        }
        break;
      }

      case 'assistant': {
        // With --include-partial-messages every finished content block arrives as its own
        // `assistant` message, right after its deltas.
        const msg = o.message || {};
        if (o.is_api_error_message || (o.error && msg.model === '<synthetic>')) {
          // "API Error …" placeholder (e.g. error: "model_not_found"): reported via `error` instead.
          const text = (msg.content || []).map((b) => b.text || '').join('\n');
          st.apiError = `${o.error || ''} ${text}`.trim();
          break;
        }
        for (const block of msg.content || []) {
          if (block.type === 'tool_use') {
            if (once(`tool:${block.id}`)) onEvent({ type: 'tool-start', id: block.id, name: block.name, input: compactInput(block.input) });
          } else if (o.parent_tool_use_id) {
            continue;
          } else if (block.type === 'text' && block.text) {
            if (once(`text:${msg.id}:${block.text}`)) { st.lastText = block.text; onEvent({ type: 'message', text: block.text }); }
          } else if (block.type === 'thinking' && block.thinking) {
            if (once(`think:${msg.id}:${block.thinking.length}:${block.thinking.slice(0, 64)}`)) onEvent({ type: 'thinking', text: block.thinking });
          }
        }
        break;
      }

      case 'user':
        for (const block of Array.isArray(o.message?.content) ? o.message.content : []) {
          if (block.type === 'tool_result') {
            onEvent({ type: 'tool-end', id: block.tool_use_id, output: toolOutput(block.content), isError: !!block.is_error });
          }
        }
        break;

      case 'rate_limit_event': {
        const info = o.rate_limit_info;
        if (!info) break;
        lastRateLimit = { info, at: new Date().toISOString() };
        if (info.status === 'rejected') onEvent({ type: 'status', text: 'Claude kullanım limiti doldu.' + resetHint() });
        else if (info.status === 'allowed_warning') {
          const w = info.unifiedWindows?.[info.rateLimitType];
          const pct = typeof w?.utilization === 'number' ? ` (%${Math.round(w.utilization * 100)})` : '';
          onEvent({ type: 'status', text: `Uyarı: ${WINDOW_LABELS[info.rateLimitType] || 'kullanım limiti'} dolmak üzere${pct}` });
        }
        break;
      }

      case 'result':
        st.result = o;
        st.sessionId = o.session_id || st.sessionId;
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
  if (model && model !== 'default' && !SAFE_ARG.test(model)) throw fail(`Geçersiz model adı: ${truncate(model, 60)}`);
  if (sessionId && !SAFE_ARG.test(sessionId)) throw fail('Geçersiz oturum kimliği.');

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompts', 'none', ...permissionArgs(permission)];
  if (model && model !== 'default') args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);

  let input = String(prompt ?? '');
  if (system) {
    // claude.exe is a real executable, so argv is safe; an npm `.cmd` shim is not (CONTRACT.md).
    if (!isShim(file) && system.length <= MAX_ARGV_SYSTEM) args.push('--append-system-prompt', system);
    else input = `<system-instructions>\n${system}\n</system-instructions>\n\n${input}`;
  }

  const st = createMapper(onEvent);
  onEvent({ type: 'status', text: sessionId ? 'Claude oturumu sürdürülüyor…' : 'Claude Code başlatılıyor…' });

  let code;
  let stderr = '';
  try {
    ({ code, stderr } = await runJsonl({
      file, args, cwd: canonicalCwd(cwd), env: childEnv(), stdin: input, signal, onJson: st.handle,
    }));
  } catch (err) {
    if (err instanceof AbortError || err?.name === 'AbortError') throw err;
    throw fail(err?.code === 'ENOENT' ? NOT_INSTALLED : `Claude Code başlatılamadı: ${err?.message || err}`);
  }

  const r = st.result;
  let usage;
  if (r?.usage) {
    const u = r.usage;
    usage = {
      // Prompt-cache reads/writes are real input tokens too; report the total.
      inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      outputTokens: u.output_tokens || 0,
    };
    if (typeof r.total_cost_usd === 'number') { usage.costUsd = r.total_cost_usd; sessionCostUsd += r.total_cost_usd; }
    onEvent({ type: 'usage', ...usage });
  }
  if (r?.permission_denials?.length) {
    const names = [...new Set(r.permission_denials.map((d) => d.tool_name).filter(Boolean))];
    onEvent({ type: 'status', text: `İzin verilmeyen araç çağrıları reddedildi: ${names.join(', ') || r.permission_denials.length}` });
  }

  if (r && !r.is_error && r.subtype === 'success') {
    const text = typeof r.result === 'string' ? r.result : st.lastText;
    onEvent({ type: 'done', text, sessionId: st.sessionId });
    return { text, sessionId: st.sessionId, usage };
  }

  let message;
  if (r?.subtype === 'error_max_turns') message = 'Claude azami tur sayısına ulaştı; görevi bölerek tekrar deneyin.';
  else if (r?.subtype === 'error_max_budget_usd') message = 'Claude bütçe sınırına ulaştı.';
  else {
    const detail = [st.apiError, r?.is_error ? r.result : '', ...(Array.isArray(r?.errors) ? r.errors : []), stderr]
      .filter(Boolean).join('\n');
    message = describeError(detail, { model, code });
  }
  throw fail(message);
}

export default {
  id: 'claude',
  name: 'Claude Code',
  // editShell false: in 'edit' mode Bash is auto-denied (no Bash sandbox on Windows), see above.
  capabilities: { edit: true, resume: true, streaming: true, cwd: true, sandbox: true, localProcess: true, editShell: false },
  detect,
  listModels,
  getLimits,
  run,
};

// Exposed for unit tests only.
export const _internal = { parseUsageText, parseResets, describeError, createMapper };

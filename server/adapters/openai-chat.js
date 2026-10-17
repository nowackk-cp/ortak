// Shared streaming chat loop for the OpenAI-compatible API adapters (Groq, OpenRouter, EVREN).
//
// With `tools` ({ defs, exec }) the model gets real function calling: each tool call it makes is
// executed by Ortak (exec → result text), sent back as a `tool` message, and the request repeats
// until the model answers in plain text. The adapters only talk HTTP; what a tool does (read a
// file, run a command…) is decided by the orchestrator (orchestrator/textcoder.js).
//
// Models/gateways that reject the `tools` parameter make the first request fail with an error whose
// `code` is 'tools_unsupported'; the caller then falls back to the text protocol (LIST/READ/RUN).

const MAX_TOOL_STEPS = 40;
const SAVED_TOOL_OUTPUT_MAX = 6000; // tool results kept in a saved session (older results are clipped)
// Within one turn every step resends the whole history: once this turn's tool results pass the
// budget, the older ones are cut to their first line (the model can call the tool again).
const TURN_TOOL_BUDGET = 60_000; // chars
const KEEP_RECENT_TOOLS = 4;
const CLIPPED = '… (eski çıktı kısaltıldı; gerekirse aracı yeniden çağır)';

const unsupported = new Set(); // `${adapter}:${model}` that rejected tools this process

/** false when this model already rejected tools; undefined when we don't know yet. */
export function toolsKnownUnsupported(adapter, model) {
  return unsupported.has(`${adapter}:${model}`) ? false : undefined;
}

const TOOLS_REJECTED = /tool|function.?call/i;
// The model produced a tool call the provider could not validate (Groq: tool_use_failed / 500).
const MALFORMED_CALL = /tool_use_failed|tool call validation failed|failed_generation|did not match schema/i;
const MALFORMED_RETRIES = 2;
// Per-minute limits (Groq free tier: 8000 tokens/min) hit easily in a tool loop, which resends the
// history each step. When the provider says "try again in Ns" and N is short, wait and continue.
const RATE_WAIT_MAX_S = 45;
const RATE_RETRIES = 4;
const EMPTY_NUDGES = 2;
const BUSY_STATUS = new Set([500, 502, 503, 504, 529]);
const BUSY_WAITS_S = [10, 20, 40];

function retryAfter(err) {
  if (err?.status !== 429) return null;
  const m = /try again in (?:(\d+)m)?([\d.]+)\s*s/i.exec(err.message || '');
  if (!m) return null;
  const secs = Number(m[1] || 0) * 60 + Number(m[2]);
  return secs <= RATE_WAIT_MAX_S ? secs : null;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function readSse(res, onData) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      onData(obj);
    }
  }
}

/**
 * Tool calls and their results folded into plain text, for requests sent without `tools`
 * (a session that used tools earlier, continued in text mode; APIs reject `tool` messages then).
 */
export function flattenToolHistory(messages) {
  if (!messages.some((m) => m.role === 'tool' || m.tool_calls)) return messages;
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'user', content: `[Ortak aracının sonucu]\n${m.content}` });
    } else if (m.tool_calls) {
      const calls = m.tool_calls.map((c) => `[araç çağrısı: ${c.function?.name}(${c.function?.arguments || ''})]`).join('\n');
      out.push({ role: 'assistant', content: [m.content, calls].filter(Boolean).join('\n') });
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Messages to persist: old tool results clipped so later turns don't resend whole files. */
export function forSaving(messages) {
  return messages.filter((m) => m.role !== 'system').map((m) => (m.role === 'tool' && m.content.length > SAVED_TOOL_OUTPUT_MAX
    ? { ...m, content: `${m.content.slice(0, SAVED_TOOL_OUTPUT_MAX)}\n… (kısaltıldı; gerekirse aracı yeniden çağır)` }
    : m));
}

const clipTool = (m) => {
  if (m.content.endsWith(CLIPPED)) return;
  const nl = m.content.indexOf('\n');
  const head = (nl < 0 ? m.content : m.content.slice(0, nl)).slice(0, 300);
  m.content = `${head}\n${CLIPPED}`;
};
const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Shrinks this turn's tool results (messages[from…]) in place: read_file results of a file that a
 * later edit_file/write_file changed (they are stale), then the oldest ones while the total is over
 * TURN_TOOL_BUDGET, always keeping the last KEEP_RECENT_TOOLS. `info` maps tool_call_id → { name, path, ok }.
 */
export function compactToolResults(messages, from, info = new Map(), budget = TURN_TOOL_BUDGET) {
  const tools = [];
  for (let i = from; i < messages.length; i++) if (messages[i].role === 'tool') tools.push(messages[i]);
  const edited = new Map(); // path → index (in `tools`) of its last successful edit
  tools.forEach((m, k) => {
    const x = info.get(m.tool_call_id);
    if (x?.ok && (x.name === 'edit_file' || x.name === 'write_file') && x.path) edited.set(normPath(x.path), k);
  });
  tools.forEach((m, k) => {
    const x = info.get(m.tool_call_id);
    if (x?.name === 'read_file' && edited.get(normPath(x.path)) > k) clipTool(m);
  });
  let total = tools.reduce((n, m) => n + m.content.length, 0);
  for (const m of tools.slice(0, -KEEP_RECENT_TOOLS)) {
    if (total <= budget) break;
    const before = m.content.length;
    clipTool(m);
    total -= before - m.content.length;
  }
}

function parseArgs(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return null;
  }
}

/**
 * One user turn. `messages` (system + history + the new user message) is extended in place with
 * the assistant/tool messages of the tool rounds; the caller appends the final answer and saves.
 *
 * @param {object} o
 * @param {string} o.adapter  adapter id (for the unsupported-model cache)
 * @param {(path:string, opts:object)=>Promise<Response>} o.request  the adapter's HTTP helper
 * @param {(message:string, extra?:object)=>Error} o.fail  builds the adapter's error type
 * @param {(status:number, body:object)=>string} o.describe  error body → message
 * @param {object} o.body  extra request fields (model, reasoning_effort…)
 * @param {{defs: object[], exec: (name:string, args:object)=>Promise<string>}} [o.tools]
 * @returns {Promise<{text:string, usage:object|null, finish:string|null, toolSteps:number}>}
 */
export async function chatTurn({ adapter, request, fail, describe, label, body, messages, tools, signal, emit, timeoutMs, maxSteps = MAX_TOOL_STEPS }) {
  if (!tools) messages.splice(0, messages.length, ...flattenToolHistory(messages));
  const turnStart = messages.length;
  const callInfo = new Map(); // tool_call_id → { name, path, ok } for compactToolResults
  const usage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let malformed = 0;
  let rateWaits = 0;
  let nudges = 0;
  let busyWaits = 0;

  for (let step = 0; ; step++) {
    const last = tools && step >= maxSteps;
    if (tools && step > 0) compactToolResults(messages, turnStart, callInfo);
    let res;
    try {
      res = await request('/chat/completions', {
        method: 'POST',
        signal,
        timeoutMs,
        body: {
          ...body,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools ? { tools: tools.defs, tool_choice: last ? 'none' : 'auto' } : {}),
        },
      });
    } catch (err) {
      const wait = rateWaits < RATE_RETRIES ? retryAfter(err) : null;
      if (wait != null) {
        rateWaits++;
        emit({ type: 'status', text: `${label} dakikalık limitine takıldı; ${Math.ceil(wait)} sn bekleyip devam ediliyor.` });
        await sleep((wait + 0.5) * 1000, signal);
        if (signal?.aborted) throw err;
        step--;
        continue;
      }
      // Busy/overloaded provider in the middle of a tool loop: the work so far would be lost if the
      // whole turn failed (ctx.turn only retries turns without output), so wait and resend.
      if (step > 0 && busyWaits < BUSY_WAITS_S.length && BUSY_STATUS.has(err?.status) && !MALFORMED_CALL.test(err.message || '')) {
        const secs = BUSY_WAITS_S[busyWaits++];
        emit({ type: 'status', text: `${label} geçici olarak meşgul (${err.status}); ${secs} sn sonra kaldığı yerden devam ediliyor.` });
        await sleep(secs * 1000, signal);
        if (signal?.aborted) throw err;
        step--;
        continue;
      }
      // The model generated a broken tool call: tell it what was wrong and let it try again.
      if (tools && malformed < MALFORMED_RETRIES && MALFORMED_CALL.test(`${err?.code || ''} ${err?.message || ''}`)) {
        malformed++;
        messages.push({ role: 'user', content: `[Ortak] Son araç çağrın geçersizdi (${String(err.message).slice(0, 300)}). Aracı gerekli tüm alanlarıyla, geçerli JSON argümanlarla yeniden çağır.` });
        step--;
        continue;
      }
      if (tools && step === 0 && [400, 404, 422].includes(err?.status) && TOOLS_REJECTED.test(err.message)) {
        unsupported.add(`${adapter}:${body.model}`);
        const e = new Error(`${label}: bu model araç çağırmayı (function calling) desteklemiyor.`);
        e.code = 'tools_unsupported';
        throw e;
      }
      throw err;
    }

    let text = '';
    let thinking = '';
    let finish = null;
    const calls = [];
    try {
      await readSse(res, (obj) => {
        if (obj.error) { const e = fail(describe(obj.error.status || 500, obj), { code: obj.error.code }); e.fromApi = true; throw e; }
        const u = obj.usage || obj.x_groq?.usage;
        if (u) {
          sawUsage = true;
          usage.inputTokens += u.prompt_tokens || 0;
          usage.outputTokens += u.completion_tokens || 0;
        }
        const choice = obj.choices?.[0];
        if (!choice) return;
        const d = choice.delta || {};
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === 'string' && r) thinking += r;
        if (typeof d.content === 'string' && d.content) {
          if (thinking) { emit({ type: 'thinking', text: thinking }); thinking = ''; }
          text += d.content;
          emit({ type: 'text-delta', text: d.content });
        }
        for (const tc of d.tool_calls || []) {
          const i = Number.isInteger(tc.index) ? tc.index : calls.length;
          const c = (calls[i] ||= { id: '', name: '', arguments: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw err?.fromApi ? err : fail(`${label} bağlantı hatası: akış kesildi (${err?.message || err})`);
    }
    if (thinking) emit({ type: 'thinking', text: thinking });

    const toolCalls = calls.filter((c) => c && c.name);
    // Some models stop silently after using tools (no text, no call): nudge them to go on.
    if (tools && !toolCalls.length && !text.trim() && step > 0 && nudges < EMPTY_NUDGES && !last) {
      nudges++;
      messages.push({ role: 'user', content: '[Ortak] Cevabın boş geldi. Göreve devam et: gerekiyorsa araçları kullan; iş bittiyse ne yaptığını kısaca yaz.' });
      continue;
    }
    if (!tools || !toolCalls.length) {
      return { text: text.trim(), usage: sawUsage ? usage : null, finish, toolSteps: step };
    }

    // Tool round: record the call, run each tool, send the results back.
    if (text.trim()) emit({ type: 'text-delta', text: '\n\n' });
    toolCalls.forEach((c, i) => { if (!c.id) c.id = `call_${step}_${i}`; });
    messages.push({
      role: 'assistant',
      content: text || '',
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of toolCalls) {
      if (signal?.aborted) throw fail('iptal edildi');
      const args = parseArgs(c.arguments);
      let out;
      if (!args) out = `Hata: "${c.name}" aracının argümanları geçerli JSON değil: ${c.arguments.slice(0, 200)}`;
      else {
        try { out = String(await tools.exec(c.name, args)); } catch (err) { out = `Hata: ${err?.message || err}`; }
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out || '(boş)' });
      callInfo.set(c.id, { name: c.name, path: args?.path, ok: !!out && !/^(Hata|UYGULANAMADI)/.test(out) });
    }
  }
}

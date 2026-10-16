// EVREN adapter: the SSYZ "EVREN LLM Gateway" (evren.ssyz.org.tr), an OpenAI-compatible HTTP API
// with many hosted models. See CONTRACT §1.
//
// Unlike the other agents there is no CLI or app: every turn is one streamed
// POST /v1/chat/completions. The API is stateless, so Ortak keeps the conversation itself: the
// sessionId names a file in data/evren/ holding the messages so far, and a follow-up sends the
// whole history again.
//
// Text only (capabilities.edit = false), like Gemini web: read-only roles, and lead-mode workers
// through textcoder.js.
//
// The API key is the user's own: read from EVREN_API_KEY or data/evren.json ({ "apiKey": "…" },
// gitignored) and sent only to the gateway. Before the first call the key's owner must accept the
// gateway's terms (403 terms_not_accepted); detect() reports that and the Ajanlar panel's button
// (login()) accepts the current version.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AbortError, truncate } from './base.js';
import { dataDir } from '../settings.js';

const BASE = (process.env.EVREN_BASE_URL || 'https://evren-llmapi.ssyz.org.tr/v1').replace(/\/+$/, '');
const KEY_FILE = path.join(dataDir, 'evren.json');
const SESSIONS = path.join(dataDir, 'evren');
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;

const NO_KEY = `EVREN API anahtarı yok: EVREN_API_KEY ortam değişkenini ya da data/evren.json dosyasını ({"apiKey": "evren_llm_…"}) ayarlayın.`;
const TERMS = "EVREN kullanım şartları kabul edilmemiş: Ajanlar panelinde EVREN için 'Şartları kabul et'e basın.";

function apiKey() {
  if (process.env.EVREN_API_KEY) return process.env.EVREN_API_KEY.trim();
  try { return String(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).apiKey || '').trim(); } catch { return ''; }
}

class EvrenError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Short Turkish message for a gateway error body. The words matter to errors.js (limit/auth/transient). */
function describe(status, body) {
  const err = body?.error || {};
  const code = err.code || '';
  const msg = truncate(String(err.message || body?.detail || '').trim(), 300);
  if (code === 'terms_not_accepted') return TERMS;
  if (status === 401) return `EVREN API anahtarı geçersiz (401 unauthorized)${msg ? `: ${msg}` : ''}`;
  if (status === 402 || /credit|kredi|bakiye|insufficient/i.test(`${code} ${msg}`)) return `EVREN kredisi yetersiz, kotası doldu: ${msg || status}`;
  if (status === 429) return `EVREN limiti doldu (429): ${msg || 'çok fazla istek'}`;
  if (status >= 500) return `EVREN sunucu hatası (${status})${msg ? `: ${msg}` : ''}`;
  return `EVREN hatası (${status})${msg ? `: ${msg}` : ''}`;
}

async function request(pathname, { method = 'GET', body, signal, timeoutMs = 15000 } = {}) {
  const key = apiKey();
  if (!key) throw new EvrenError(NO_KEY, { code: 'no_key' });
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new EvrenError(describe(res.status, data), { status: res.status, code: data?.error?.code });
    }
    return res;
  } catch (err) {
    if (signal?.aborted) throw new AbortError();
    if (err instanceof EvrenError) throw err;
    if (err?.name === 'AbortError') throw new EvrenError('EVREN cevap vermedi (zaman aşımı).');
    throw new EvrenError(`EVREN bağlantı hatası: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const getJson = async (pathname, opts) => (await request(pathname, opts)).json();

// ---- models ---------------------------------------------------------------------------------

let modelCache = { at: 0, list: null };

async function fetchModels({ fresh = false } = {}) {
  if (!fresh && modelCache.list && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.list;
  const data = await getJson('/models');
  const list = (data?.data || []).filter((m) => m?.id && /chat/.test(m.task || 'chat'));
  modelCache = { at: Date.now(), list };
  return list;
}

/** Whether a gateway model accepts images (the gateway's metadata varies by provider). */
function seesImages(m) {
  if (!m) return false;
  const caps = m.capabilities || {};
  const mods = [m.architecture?.input_modalities, m.input_modalities, caps.input_modalities, caps.modalities].find(Array.isArray) || [];
  return !!(caps.vision || caps.image_input || caps.images || mods.includes('image') || /\b(vl|vision)\b|-vl-|gemma-?3|gpt-4o|gemini/i.test(m.id));
}

const EFFORT_LABEL = { none: 'düşünmesiz', minimal: 'en az', low: 'düşük', medium: 'orta', high: 'yüksek', xhigh: 'çok yüksek', max: 'en yüksek' };
// Default model when the user picks none: the first of these the key can use, else the first listed.
const PREFERRED = ['deepseek-v4.1-flash', 'mimo-v2.6-pro', 'glm-5.3', 'qwen3.8-flash-next'];
const FAMILY = { deepseek: 'DeepSeek', qwen: 'Qwen', glm: 'GLM', gemma: 'Gemma', mimo: 'MiMo', llama: 'Llama', mistral: 'Mistral' };

function priceNote(p) {
  if (!p) return undefined;
  if (p.free_until && Date.parse(p.free_until) > Date.now()) return `${p.free_until.slice(0, 10)} tarihine kadar ücretsiz`;
  if (!p.prompt_token_price && !p.completion_token_price) return 'ücretsiz';
  const per1m = (x) => +(Number(x) * 1e6).toPrecision(3);
  return `1M token: girdi ${per1m(p.prompt_token_price)} ${p.currency || 'CR'}, çıktı ${per1m(p.completion_token_price)} ${p.currency || 'CR'}`;
}

function isFree(p) {
  return !!p && ((p.free_until && Date.parse(p.free_until) > Date.now()) || (!p.prompt_token_price && !p.completion_token_price));
}

/** Gateway models → picker entries. Models with reasoning_effort values get one entry per level ("<id>::<effort>"). */
function toPicker(list) {
  const out = [];
  for (const m of sortModels(list)) {
    const base = m.id.split('/').pop();
    const fam = base.toLowerCase().match(/^[a-z]+/)?.[0] || '';
    const group = m.id === 'auto' ? 'EVREN' : FAMILY[fam] || (m.id.includes('/') ? m.id.split('/')[0] : 'Diğer');
    const ctx = m.context_length ? ` · ${m.context_length >= 1e6 ? `${Math.round(m.context_length / 1048576)}M` : `${Math.round(m.context_length / 1024)}K`}` : '';
    const label = m.id === 'auto' ? 'Otomatik (EVREN seçer)' : `${base}${ctx}`;
    const common = { group, note: priceNote(m.pricing), ...(isFree(m.pricing) ? { free: true } : {}) };
    out.push({ id: m.id, label, ...common });
    for (const e of efforts(m.capabilities)) {
      const word = EFFORT_LABEL[e] || e;
      out.push({ id: `${m.id}::${e}`, label: `${base} · ${e === 'none' ? word : `${word} düşünme`}`, ...common });
    }
  }
  if (out.length) out[0].default = true;
  return out;
}

/** Preferred default first, then the rest as the gateway lists them. */
function sortModels(list) {
  const rank = (m) => { const i = PREFERRED.indexOf(m.id); return i < 0 ? PREFERRED.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** Thinking levels worth offering. Without a published list: low/high (aliases may rewrite them). */
function efforts(caps) {
  if (!caps?.reasoning_effort) return [];
  return caps.reasoning_effort_values?.length ? caps.reasoning_effort_values : ['low', 'high'];
}

// ---- sessions -------------------------------------------------------------------------------

const sessionFile = (id) => path.join(SESSIONS, `${String(id).replace(/[^\w-]/g, '')}.json`);

function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; }
}

function saveSession(id, data) {
  fs.mkdirSync(SESSIONS, { recursive: true });
  const file = sessionFile(id);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

// ---- streaming ------------------------------------------------------------------------------

/** Read an OpenAI-style SSE body, calling onData(obj) for every `data:` JSON line. */
async function readSse(res, onData) {
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

export default {
  id: 'evren',
  name: 'EVREN',
  capabilities: { edit: false, resume: true, streaming: true, cwd: false, sandbox: true, images: true },

  async detect() {
    if (!apiKey()) return { available: false, reason: NO_KEY };
    try {
      const terms = await getJson('/terms/status', { timeoutMs: 5000 });
      if (terms && !terms.accepted) {
        return {
          available: false,
          reason: TERMS,
          login: { required: true, label: 'Şartları kabul et', hint: `EVREN LLM Gateway kullanım şartları v${terms.current_version} — metin: ${BASE}/terms/text` },
        };
      }
      return { available: true, version: 'evren.ssyz.org.tr' };
    } catch (err) {
      return { available: false, reason: err?.message || String(err) };
    }
  },

  /** Accept the current terms version for this key's owner (the user presses the button). */
  async login() {
    try {
      const terms = await getJson('/terms/status');
      if (terms.accepted) return { ok: true, message: 'EVREN şartları zaten kabul edilmiş.' };
      const r = await getJson('/terms/accept', { method: 'POST', body: { version: terms.current_version } });
      modelCache = { at: 0, list: null };
      return { ok: true, message: `EVREN kullanım şartları v${r.accepted_version} kabul edildi.` };
    } catch (err) {
      return { ok: false, reason: err?.message || String(err) };
    }
  },

  async listModels() {
    try { return toPicker(await fetchModels()); } catch { return []; }
  },

  async getLimits() {
    try {
      const q = await getJson('/quota', { timeoutMs: 8000 });
      const items = [];
      if (q.cap) {
        items.push({
          label: `${q.window_minutes ? `${q.window_minutes} dk` : 'Pencere'} token limiti`,
          usedPercent: Math.round((q.usage_ratio ?? q.used_tokens / q.cap) * 100),
          ...(q.reset_at ? { resetsAt: q.reset_at } : {}),
        });
      }
      if (q.daily_limit_tokens) {
        items.push({
          label: 'Günlük token',
          usedPercent: Math.round((q.daily_used_tokens / q.daily_limit_tokens) * 100),
          ...(q.daily_reset_at ? { resetsAt: q.daily_reset_at } : {}),
        });
      }
      if (q.remaining_cr != null) items.push({ label: 'Kredi', text: `${q.remaining_cr} CR kaldı` });
      return { items };
    } catch (err) {
      return { items: [], note: err?.message || String(err) };
    }
  },

  async run({ prompt, model, sessionId, system, images = [], signal, onEvent = () => {} }) {
    const emit = (e) => { try { onEvent(e); } catch { /* listener error */ } };
    if (signal?.aborted) throw new AbortError();

    try {
      let modelId = model && model !== 'default' ? model : null;
      if (!modelId) {
        const list = await fetchModels();
        if (!list.length) throw new EvrenError('EVREN bu anahtar için hiç sohbet modeli döndürmedi.');
        modelId = sortModels(list)[0].id;
      }
      const [id, effort] = modelId.split('::');

      const sid = sessionId || randomUUID();
      const saved = (sessionId && loadSession(sessionId)) || { messages: [] };
      if (sessionId && !saved.messages.length) throw new EvrenError(`EVREN oturumu bulunamadı: ${sessionId}`);
      const messages = saved.messages.filter((m) => m.role !== 'system');
      if (system) messages.unshift({ role: 'system', content: system });
      const userText = String(prompt ?? '');
      // Images go to vision models as OpenAI-style image_url parts; the saved session keeps only a
      // text marker (no base64 replayed on every later turn).
      let content = userText;
      if (images.length) {
        const meta = (await fetchModels().catch(() => [])).find((m) => m.id === id);
        if (seesImages(meta)) {
          const parts = [];
          for (const img of images) {
            try { parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${fs.readFileSync(img.path).toString('base64')}` } }); } catch { /* deleted meanwhile */ }
          }
          if (parts.length) content = [{ type: 'text', text: userText }, ...parts];
        } else {
          emit({ type: 'status', text: `${id.split('/').pop()} resim göremiyor; yalnızca metin gönderildi.` });
        }
      }
      messages.push({ role: 'user', content });

      emit({ type: 'status', text: `EVREN: ${id.split('/').pop()}${effort ? ` (${effort})` : ''}` });
      const res = await request('/chat/completions', {
        method: 'POST',
        signal,
        timeoutMs: TURN_TIMEOUT_MS,
        body: {
          model: id,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(effort ? { reasoning_effort: effort } : {}),
        },
      });

      let text = '';
      let thinking = '';
      let usage = null;
      let finish = null;
      try {
        await readSse(res, (obj) => {
          if (obj.error) throw new EvrenError(describe(obj.error.status || 500, obj));
          if (obj.usage) {
            usage = {
              inputTokens: obj.usage.prompt_tokens,
              outputTokens: obj.usage.completion_tokens,
            };
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
          if (choice.finish_reason) finish = choice.finish_reason;
        });
      } catch (err) {
        if (signal?.aborted) throw new AbortError();
        throw err instanceof EvrenError ? err : new EvrenError(`EVREN bağlantı hatası: akış kesildi (${err?.message || err})`);
      }
      if (thinking) emit({ type: 'thinking', text: thinking });
      text = text.trim();
      if (!text) throw new EvrenError('EVREN boş cevap döndü.');
      if (finish === 'length') text += '\n\n_(Cevap uzunluk sınırında kesildi.)_';

      messages.push({ role: 'assistant', content: text });
      const keep = messages.filter((m) => m.role !== 'system').map((m) => (Array.isArray(m.content)
        ? { ...m, content: `${m.content.find((x) => x.type === 'text')?.text || ''}\n\n[${m.content.length - 1} resim eklenmişti]` }
        : m));
      saveSession(sid, { model: modelId, updatedAt: new Date().toISOString(), messages: keep });

      emit({ type: 'message', text });
      if (usage) emit({ type: 'usage', ...usage });
      emit({ type: 'done', text, sessionId: sid });
      return { text, sessionId: sid, ...(usage ? { usage } : {}) };
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw new AbortError();
      const message = err?.message || String(err);
      emit({ type: 'error', message });
      throw new Error(message);
    }
  },
};

export const _internals = { toPicker, describe };

// Groq adapter: Ultra-fast inference on LPUs (Language Processing Units).
// OpenAI-compatible HTTP API. See CONTRACT §1.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AbortError, truncate } from './base.js';
import { dataDir } from '../settings.js';
import { chatTurn, forSaving, toolsKnownUnsupported } from './openai-chat.js';

const BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const KEY_FILE = path.join(dataDir, 'groq.json');
const SESSIONS = path.join(dataDir, 'groq');
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;

const NO_KEY = 'Groq API anahtarı yok: GROQ_API_KEY ortam değişkenini ya da data/groq.json dosyasını ({"apiKey": "gsk_…"}) ayarlayın.';

let lastRateLimits = null;

function apiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  try { return String(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).apiKey || '').trim(); } catch { return ''; }
}

class GroqError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function describe(status, body) {
  const err = body?.error || {};
  const code = err.code || '';
  const msg = truncate(String(err.message || body?.detail || '').trim(), 300);
  if (status === 401) return `Groq API anahtarı geçersiz (401 unauthorized)${msg ? `: ${msg}` : ''}`;
  if (status === 429) return `Groq istek limiti doldu (429): ${msg || 'lütfen biraz bekleyin'}`;
  if (status >= 500) return `Groq sunucu hatası (${status})${msg ? `: ${msg}` : ''}`;
  return `Groq hatası (${status})${msg ? `: ${msg}` : ''}`;
}

async function request(pathname, { method = 'GET', body, signal, timeoutMs = 15000 } = {}) {
  const key = apiKey();
  if (!key) throw new GroqError(NO_KEY, { code: 'no_key' });
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    const limReq = res.headers.get('x-ratelimit-remaining-requests');
    const totReq = res.headers.get('x-ratelimit-limit-requests');
    const limTok = res.headers.get('x-ratelimit-remaining-tokens');
    const totTok = res.headers.get('x-ratelimit-limit-tokens');
    if (limReq || limTok) {
      lastRateLimits = {
        remainingRequests: limReq,
        limitRequests: totReq,
        remainingTokens: limTok,
        limitTokens: totTok,
        resetRequests: res.headers.get('x-ratelimit-reset-requests'),
        resetTokens: res.headers.get('x-ratelimit-reset-tokens'),
        at: Date.now(),
      };
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new GroqError(describe(res.status, data), { status: res.status, code: data?.error?.code });
    }
    return res;
  } catch (err) {
    if (signal?.aborted) throw new AbortError();
    if (err instanceof GroqError) throw err;
    if (err?.name === 'AbortError') throw new GroqError('Groq cevap vermedi (zaman aşımı).');
    throw new GroqError(`Groq bağlantı hatası: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const getJson = async (pathname, opts) => (await request(pathname, opts)).json();

// ---- models -----------------------------------------------------------------------------------

let modelCache = { at: 0, list: null };

const EXCLUDED_PATTERNS = [/whisper/i, /prompt-guard/i, /safeguard/i, /orpheus/i];

function isChatModel(m) {
  if (!m || typeof m.id !== 'string') return false;
  if (m.active === false) return false;
  return !EXCLUDED_PATTERNS.some((re) => re.test(m.id));
}

async function fetchModels({ fresh = false } = {}) {
  if (!fresh && modelCache.list && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.list;
  const data = await getJson('/models');
  const list = (data?.data || []).filter(isChatModel);
  modelCache = { at: Date.now(), list };
  return list;
}

const PREFERRED = [
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'allam-2-7b',
];

function providerGroup(m) {
  if (m.owned_by) return m.owned_by;
  const prefix = m.id.split('/')[0].toLowerCase();
  if (prefix === 'qwen') return 'Alibaba / Qwen';
  if (prefix === 'openai') return 'OpenAI';
  if (prefix === 'meta-llama') return 'Meta';
  return 'Groq';
}

function modelLabel(m) {
  const ctx = m.context_window ? ` · ${Math.round(m.context_window / 1024)}K` : '';
  if (m.id === 'qwen/qwen3.8-27b') return `Qwen 3.8 27B — ultra hızlı${ctx}`;
  if (m.id === 'openai/gpt-oss-120b') return `GPT-OSS 120B — güçlü açık model${ctx}`;
  if (m.id === 'openai/gpt-oss-20b') return `GPT-OSS 20B — hafif ve hızlı${ctx}`;
  if (m.id === 'allam-2-7b') return `Allam 2 7B${ctx}`;
  const base = m.id.split('/').pop();
  return `${base}${ctx}`;
}

function toPicker(list) {
  const sorted = sortModels(list);
  const out = sorted.map((m) => ({
    id: m.id,
    label: `${modelLabel(m)} · ücretsiz`,
    group: providerGroup(m),
    free: true,
    note: 'ücretsiz',
  }));
  if (out.length) {
    const def = out.find((x) => x.id === 'qwen/qwen3.8-27b') || out[0];
    def.default = true;
  }
  return out;
}

function sortModels(list) {
  const rank = (m) => {
    const i = PREFERRED.indexOf(m.id);
    return i < 0 ? PREFERRED.length + 10 : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

// ---- sessions ---------------------------------------------------------------------------------

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

// ---- export adapter ---------------------------------------------------------------------------

export default {
  id: 'groq',
  name: 'Groq (LPU)',
  capabilities: { edit: false, tools: true, resume: true, streaming: true, cwd: false, sandbox: true },

  /** Real function calling (orchestrator/textcoder.js); false only after the model rejected it. */
  supportsTools: (model) => toolsKnownUnsupported('groq', model || 'qwen/qwen3.8-27b'),

  async detect() {
    if (!apiKey()) return { available: false, reason: NO_KEY };
    try {
      await getJson('/models', { timeoutMs: 5000 });
      return { available: true, version: 'Groq Cloud' };
    } catch (err) {
      return { available: false, reason: err?.message || String(err) };
    }
  },

  async listModels() {
    try {
      return toPicker(await fetchModels());
    } catch {
      return [];
    }
  },

  async getLimits() {
    try {
      const items = [];
      if (lastRateLimits) {
        if (lastRateLimits.remainingRequests != null && lastRateLimits.limitRequests) {
          const used = Number(lastRateLimits.limitRequests) - Number(lastRateLimits.remainingRequests);
          items.push({
            label: 'Günlük İstek Limiti',
            usedPercent: Math.round((used / Number(lastRateLimits.limitRequests)) * 100),
            text: `${lastRateLimits.remainingRequests} / ${lastRateLimits.limitRequests} istek kaldı`,
          });
        }
        if (lastRateLimits.remainingTokens != null && lastRateLimits.limitTokens) {
          items.push({
            label: 'Dakikalık Token',
            text: `${lastRateLimits.remainingTokens} / ${lastRateLimits.limitTokens} token kaldı`,
          });
        }
      } else {
        items.push({ label: 'Ücretsiz Plan', text: '1.000 istek / gün' });
      }
      return { items, note: 'Groq LPU ultra hızlı çıkarım' };
    } catch (err) {
      return { items: [], note: err?.message || String(err) };
    }
  },

  async run({ prompt, model, sessionId, system, tools, signal, onEvent = () => {} }) {
    const emit = (e) => { try { onEvent(e); } catch { /* listener error */ } };
    if (signal?.aborted) throw new AbortError();

    try {
      let modelId = model && model !== 'default' ? model : 'qwen/qwen3.8-27b';

      const sid = sessionId || randomUUID();
      const saved = (sessionId && loadSession(sessionId)) || { messages: [] };
      if (sessionId && !saved.messages.length) throw new GroqError(`Groq oturumu bulunamadı: ${sessionId}`);
      const messages = saved.messages.filter((m) => m.role !== 'system');
      if (system) messages.unshift({ role: 'system', content: system });
      messages.push({ role: 'user', content: String(prompt ?? '') });

      emit({ type: 'status', text: `Groq (LPU): ${modelId.split('/').pop()}${tools ? ' · araçlarla' : ''}` });
      const out = await chatTurn({
        adapter: 'groq', label: 'Groq', request, describe, signal, emit, tools, messages,
        fail: (message, extra) => new GroqError(message, extra),
        body: { model: modelId },
        timeoutMs: TURN_TIMEOUT_MS,
      });
      let { text, finish } = out;
      const usage = out.usage ? { ...out.usage, costUsd: 0 } : null;
      if (!text && out.toolSteps) text = '(Araçlarla çalıştı; ayrıca bir açıklama yazmadı.)';
      if (!text) throw new GroqError('Groq boş cevap döndü.');
      if (finish === 'length') text += '\n\n_(Cevap uzunluk sınırında kesildi.)_';

      messages.push({ role: 'assistant', content: text });
      saveSession(sid, { model: modelId, updatedAt: new Date().toISOString(), messages: forSaving(messages) });

      emit({ type: 'message', text });
      if (usage) emit({ type: 'usage', ...usage });
      emit({ type: 'done', text, sessionId: sid });
      return { text, sessionId: sid, ...(usage ? { usage } : {}) };
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw new AbortError();
      if (err?.code === 'tools_unsupported') throw err;
      const message = err?.message || String(err);
      emit({ type: 'error', message });
      throw new Error(message);
    }
  },
};

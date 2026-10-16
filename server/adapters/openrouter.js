// OpenRouter adapter: OpenAI-compatible HTTP API with strict free-models filter.
// Free tier provides daily free requests on models with pricing 0 (:free).
// PAID MODELS ARE EXPLICITLY REJECTED AND EXCLUDED.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AbortError, truncate } from './base.js';
import { dataDir } from '../settings.js';
import { chatTurn, forSaving, toolsKnownUnsupported } from './openai-chat.js';

const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const KEY_FILE = path.join(dataDir, 'openrouter.json');
const SESSIONS = path.join(dataDir, 'openrouter');
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;

const NO_KEY = 'OpenRouter API anahtarı yok: OPENROUTER_API_KEY ortam değişkenini ya da data/openrouter.json dosyasını ({"apiKey": "sk-or-v1-…"}) ayarlayın.';

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try { return String(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).apiKey || '').trim(); } catch { return ''; }
}

class OpenRouterError extends Error {
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
  if (status === 401) return `OpenRouter API anahtarı geçersiz (401 unauthorized)${msg ? `: ${msg}` : ''}`;
  if (status === 402) return `OpenRouter kredisi/limiti yetersiz (402): ${msg}`;
  if (status === 429) return `OpenRouter istek limiti doldu (429): ${msg || 'lütfen biraz bekleyin'}`;
  if (status >= 500) return `OpenRouter sunucu hatası (${status})${msg ? `: ${msg}` : ''}`;
  return `OpenRouter hatası (${status})${msg ? `: ${msg}` : ''}`;
}

async function request(pathname, { method = 'GET', body, signal, timeoutMs = 15000 } = {}) {
  const key = apiKey();
  if (!key) throw new OpenRouterError(NO_KEY, { code: 'no_key' });
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
        'HTTP-Referer': 'http://127.0.0.1:4747',
        'X-Title': 'Ortak',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new OpenRouterError(describe(res.status, data), { status: res.status, code: data?.error?.code });
    }
    return res;
  } catch (err) {
    if (signal?.aborted) throw new AbortError();
    if (err instanceof OpenRouterError) throw err;
    if (err?.name === 'AbortError') throw new OpenRouterError('OpenRouter cevap vermedi (zaman aşımı).');
    throw new OpenRouterError(`OpenRouter bağlantı hatası: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const getJson = async (pathname, opts) => (await request(pathname, opts)).json();

// ---- models (ONLY FREE MODELS) -----------------------------------------------------------------

let modelCache = { at: 0, list: null };

/** Strictly checks if a model is 100% free (pricing is 0 and output is text). */
export function isFreeModel(m) {
  if (!m || typeof m.id !== 'string') return false;
  const p = m.pricing;
  const isZero = p && Number(p.prompt || 0) === 0 && Number(p.completion || 0) === 0 && Number(p.request || 0) === 0;
  const isFreeSuffix = m.id.endsWith(':free') || m.id === 'openrouter/free';
  const isText = m.architecture?.output_modalities?.includes('text');
  // Exclude audio/music models (like Google Lyria which charge per song)
  return (isFreeSuffix || isZero) && isText && !m.id.includes('lyria');
}

async function fetchModels({ fresh = false } = {}) {
  if (!fresh && modelCache.list && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.list;
  const data = await getJson('/models');
  // FILTER: Only free models! Paid models are strictly excluded.
  const list = (data?.data || []).filter(isFreeModel);
  modelCache = { at: Date.now(), list };
  return list;
}

const PREFERRED = [
  'openrouter/free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3.5-super-vl:free',
];

const PROVIDER_NAMES = {
  openrouter: 'OpenRouter',
  poolside: 'Poolside (Kodlama)',
  cohere: 'Cohere (Kodlama)',
  google: 'Google',
  nvidia: 'NVIDIA',
  thinkingmachines: 'Thinking Machines',
  liquid: 'LiquidAI',
  'dots-studio': 'Dots Studio',
};

function providerGroup(id) {
  const prefix = id.split('/')[0].toLowerCase();
  return PROVIDER_NAMES[prefix] || (prefix ? prefix.toUpperCase() : 'Diğer');
}

function formatContext(ctx) {
  if (!ctx) return '';
  return ctx >= 1e6 ? ` · ${Math.round(ctx / 1048576)}M` : ` · ${Math.round(ctx / 1024)}K`;
}

function toPicker(list) {
  const sorted = sortModels(list);
  const out = [];
  for (const m of sorted) {
    const rawName = m.name || m.id.split('/').pop().replace(/:free$/, '');
    const cleanName = rawName.replace(/\s*\(free\)\s*/i, '').trim();
    const group = providerGroup(m.id);
    const ctx = formatContext(m.context_length);
    const label = m.id === 'openrouter/free'
      ? 'Otomatik (Ücretsiz Modeller Yönlendirici)'
      : `${cleanName}${ctx} · ücretsiz`;

    out.push({
      id: m.id,
      label,
      group,
      free: true,
      note: 'ücretsiz',
    });
  }
  if (out.length) {
    const def = out.find((x) => x.id === 'openrouter/free') || out[0];
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

// ---- streaming --------------------------------------------------------------------------------


// ---- export adapter ---------------------------------------------------------------------------

export default {
  id: 'openrouter',
  name: 'OpenRouter (Ücretsiz)',
  capabilities: { edit: false, tools: true, resume: true, streaming: true, cwd: false, sandbox: true },

  /** OpenRouter publishes which models accept `tools` (supported_parameters). */
  async supportsTools(model) {
    const id = model && model !== 'default' ? model : 'openrouter/free';
    if (toolsKnownUnsupported('openrouter', id) === false) return false;
    if (id === 'openrouter/free') return true;
    const m = (await fetchModels().catch(() => [])).find((x) => x.id === id);
    return m?.supported_parameters ? m.supported_parameters.includes('tools') : undefined;
  },

  async detect() {
    if (!apiKey()) return { available: false, reason: NO_KEY };
    try {
      const keyInfo = await getJson('/auth/key', { timeoutMs: 5000 });
      if (!keyInfo?.data) return { available: false, reason: 'OpenRouter anahtar bilgisi doğrulanamadı' };
      return { available: true, version: 'openrouter.ai' };
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
      const info = await getJson('/auth/key', { timeoutMs: 8000 });
      const items = [];
      const data = info?.data;
      if (data?.free_model_daily_requests) {
        const { used = 0, limit = 50, remaining = 50 } = data.free_model_daily_requests;
        items.push({
          label: 'Günlük Ücretsiz İstek',
          usedPercent: limit ? Math.round((used / limit) * 100) : 0,
          text: `${remaining} / ${limit} istek kaldı`,
        });
      }
      if (data?.usage_daily != null) {
        items.push({
          label: 'Bugünkü Kullanım',
          text: `$${Number(data.usage_daily).toFixed(4)}`,
        });
      }
      return { items, note: 'Yalnızca ücretsiz modeller aktiftir' };
    } catch (err) {
      return { items: [], note: err?.message || String(err) };
    }
  },

  async run({ prompt, model, sessionId, system, tools, signal, onEvent = () => {} }) {
    const emit = (e) => { try { onEvent(e); } catch { /* listener error */ } };
    if (signal?.aborted) throw new AbortError();

    try {
      const freeList = await fetchModels();
      const freeIds = new Set(freeList.map((m) => m.id));

      let modelId = model && model !== 'default' ? model : 'openrouter/free';

      // STRICT PROTECTION: If someone requests a model that is not free, reject immediately!
      if (!freeIds.has(modelId) && modelId !== 'openrouter/free' && !modelId.endsWith(':free')) {
        throw new Error(`OpenRouter adaptöründe yalnızca ücretsiz modeller kullanılabilir. Paralı modeller engellenmiştir: ${modelId}`);
      }

      const sid = sessionId || randomUUID();
      const saved = (sessionId && loadSession(sessionId)) || { messages: [] };
      if (sessionId && !saved.messages.length) throw new OpenRouterError(`OpenRouter oturumu bulunamadı: ${sessionId}`);
      const messages = saved.messages.filter((m) => m.role !== 'system');
      if (system) messages.unshift({ role: 'system', content: system });
      messages.push({ role: 'user', content: String(prompt ?? '') });

      emit({ type: 'status', text: `OpenRouter (Ücretsiz): ${modelId.split('/').pop().replace(/:free$/, '')}${tools ? ' · araçlarla' : ''}` });
      const out = await chatTurn({
        adapter: 'openrouter', label: 'OpenRouter', request, describe, signal, emit, tools, messages,
        fail: (message, extra) => new OpenRouterError(message, extra),
        body: { model: modelId },
        timeoutMs: TURN_TIMEOUT_MS,
      });
      let { text, finish } = out;
      const usage = out.usage ? { ...out.usage, costUsd: 0 } : null; // always free models
      if (!text && out.toolSteps) text = '(Araçlarla çalıştı; ayrıca bir açıklama yazmadı.)';
      if (!text) throw new OpenRouterError('OpenRouter boş cevap döndü.');
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

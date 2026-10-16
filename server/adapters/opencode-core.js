// Shared core for agents built on OpenCode: OpenCode itself and its fork Kilo Code. Both run
// `<cli> run --format json`, read the prompt from stdin and print one JSON object per event:
//   step_start / text / reasoning / tool_use / step_finish / error   (each carries sessionID)
// A session is continued with `-s <sessionID>`. See docs/CONTRACT.md §1.
//
// Permission mapping (verified with OpenCode 2.0.30 and Kilo 7.8.12). `--auto` approves every
// permission that is not explicitly denied, so nothing can ever wait for an answer; the denies
// come from inline config (OPENCODE_CONFIG_CONTENT / KILO_CONFIG_CONTENT), which removes those
// tools from the model entirely:
//   read-only → deny edit (edit/write/patch) and bash
//   edit      → deny bash and external_directory (edits stay inside cwd; no shell: not sandboxed)
//   full      → nothing denied
//
// `run --format json` does not stream tokens: every finished text part is one `message` event.
import { which, runJsonl, capture, cleanEnv, realCwd, truncate, AbortError, openConsole } from './base.js';

const SAFE_ARG = /^[A-Za-z0-9._:\/~#@+-]+$/; // model ids / session ids we accept on argv
const MODELS_TTL_MS = 10 * 60_000;
const IDLE_MS = 8 * 60_000; // no event for this long → the model stopped answering

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

const TOOL_NAMES = {
  read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'Edit', apply_patch: 'Edit',
  bash: 'Shell', shell: 'Shell', glob: 'Glob', grep: 'Grep', list: 'LS', ls: 'LS',
  webfetch: 'WebFetch', websearch: 'WebSearch', web_search: 'WebSearch', task: 'Task',
  todowrite: 'Plan', todoread: 'Plan', codesearch: 'Search',
};

function permissionConfig(permission) {
  if (permission === 'full') return {};
  if (permission === 'edit') return { permission: { bash: 'deny', external_directory: 'deny' } };
  return { permission: { edit: 'deny', bash: 'deny' } };
}

const shortInput = (v) => {
  if (v == null) return undefined;
  if (typeof v === 'string') return truncate(v, 4000);
  const s = JSON.stringify(v);
  return s.length > 4000 ? truncate(s, 4000) : v;
};

/** Turns `run --format json` events into AdapterEvents. */
export function createMapper(onEvent) {
  const st = {
    sessionId: null, lastText: '', lastMsgId: null, error: null, steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, seen: false },
  };
  st.handle = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.sessionID === 'string') st.sessionId ||= o.sessionID;
    const p = o.part || {};
    switch (o.type) {
      case 'step_start':
        st.steps++;
        if (st.steps > 1) onEvent({ type: 'status', text: `Adım ${st.steps}` });
        break;
      case 'text': {
        // Some free reasoning models leak their thinking into the text ("… </think>answer").
        let text = typeof p.text === 'string' ? p.text : '';
        if (text.includes('</think>')) text = text.slice(text.lastIndexOf('</think>') + 8).trimStart();
        text = text.replace(/^<think>[\s\S]*$/, '');
        if (!text.trim()) break;
        // Parts of one message are joined; a new message (after a tool call) replaces the answer.
        if (p.messageID && p.messageID === st.lastMsgId) st.lastText += `\n\n${text}`;
        else st.lastText = text;
        st.lastMsgId = p.messageID || null;
        onEvent({ type: 'message', text });
        break;
      }
      case 'reasoning':
        if (typeof p.text === 'string' && p.text.trim()) onEvent({ type: 'thinking', text: p.text });
        break;
      case 'tool_use': {
        const s = p.state || {};
        const id = p.callID || p.id || p.partID || `tool-${Date.now()}`;
        onEvent({ type: 'tool-start', id, name: TOOL_NAMES[p.tool] || p.tool || 'araç', input: shortInput(s.input) });
        if (s.status === 'completed' || s.status === 'error') {
          const isError = s.status === 'error';
          const out = isError ? (s.error || 'Araç hatası') : (s.output ?? '');
          onEvent({ type: 'tool-end', id, output: truncate(typeof out === 'string' ? out : JSON.stringify(out), 4000), isError });
        }
        st.lastMsgId = null;
        break;
      }
      case 'step_finish': {
        const t = p.tokens;
        if (t && typeof t === 'object') {
          st.usage.seen = true;
          st.usage.inputTokens += (Number(t.input) || 0) + (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0);
          st.usage.outputTokens += (Number(t.output) || 0) + (Number(t.reasoning) || 0);
        }
        if (typeof p.cost === 'number' && Number.isFinite(p.cost)) st.usage.costUsd += p.cost;
        if (p.model?.modelID && !st.model) {
          st.model = p.model.modelID;
          onEvent({ type: 'status', text: `Model: ${p.model.modelID}` });
        }
        break;
      }
      case 'error': {
        const e = o.error || {};
        st.error = e.data?.message || e.message || e.name || (typeof o.error === 'string' ? o.error : JSON.stringify(e));
        st.errorType = e.type || e.name || '';
        break;
      }
      default:
        break;
    }
  };
  return st;
}

/**
 * @param spec {
 *   id, name, notInstalled,
 *   bin(): absolute path of the CLI or null,
 *   runArgs: argv before the common flags (e.g. ['run', '--standalone']),
 *   configEnv: env var for inline JSON config,
 *   loadModels(file): Promise<model list>   (cached 10 min),
 *   loginArgs: argv for "connect an account" (opened in a terminal window),
 *   loginHint: Turkish hint shown in the UI,
 *   describeExtra?(text): Turkish message or null,
 *   limitsNote: Turkish note for the quota panel,
 * }
 */
export function createOpencodeAdapter(spec) {
  const systemBySession = new Map(); // sessionId → last `system` sent (sent once per session)
  let modelsCache = null; // { at, list }
  let modelsInFlight = null;
  const stats = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  async function detect() {
    const file = spec.bin();
    if (!file) return { available: false, reason: spec.notInstalled };
    const ver = await capture(file, ['--version'], { timeoutMs: 8000, env: cleanEnv({ NO_COLOR: '1' }) });
    const version = (`${ver.stdout}\n${ver.stderr}`.match(/\d+\.\d+\.\d+/) || [])[0];
    if (!ver.ok && !version) {
      return { available: false, reason: `${spec.name} çalıştırılamadı: ${truncate(firstLine(ver.stderr || ver.stdout), 200)}` };
    }
    return { available: true, version, login: { optional: true, label: 'Hesap bağla', hint: spec.loginHint } };
  }

  async function listModels() {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.list;
    const file = spec.bin();
    if (!file) return [];
    modelsInFlight ||= (async () => {
      try {
        const list = await spec.loadModels(file);
        if (list?.length) modelsCache = { at: Date.now(), list };
        return list?.length ? list : modelsCache?.list || [{ id: 'default', label: `Varsayılan (${spec.name} seçer)`, default: true }];
      } catch {
        return modelsCache?.list || [{ id: 'default', label: `Varsayılan (${spec.name} seçer)`, default: true }];
      } finally {
        modelsInFlight = null;
      }
    })();
    return modelsInFlight;
  }

  async function getLimits() {
    const notes = [spec.limitsNote];
    if (stats.turns) {
      const k = (n) => (n >= 1000 ? `${(n / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} bin` : String(n));
      notes.push(`Bu oturumda ${stats.turns} tur · ${k(stats.inputTokens + stats.outputTokens)} token` +
        (stats.costUsd > 0 ? ` · $${stats.costUsd.toFixed(3)}` : ''));
    }
    return { items: [], note: notes.filter(Boolean).join(' · ') };
  }

  function login() {
    const file = spec.bin();
    if (!file) return { ok: false, reason: spec.notInstalled };
    return openConsole({ title: `${spec.name} - hesap bağla`, file, args: spec.loginArgs });
  }

  function describeError(text, { model } = {}) {
    const t = String(text || '');
    const extra = spec.describeExtra?.(t, { model });
    if (extra) return extra;
    if (/no-route|model (unavailable|not found)|unknown model|model .*not (found|available|supported)|ProviderModelNotFound/i.test(t)) {
      return `${spec.name}: model kullanılamıyor (${model || 'varsayılan'}) — başka bir model seçin.`;
    }
    if (/session .*not found|no session|NotFoundError.*ses_/i.test(t)) {
      return `${spec.name} oturumu bulunamadı (session not found). Yeni bir sohbet başlatın.`;
    }
    if (/\b401\b|unauthori[sz]ed|invalid api key|api key|not authenticated|authentication|login required/i.test(t)) {
      return `${spec.name}: bu model için hesap gerekli. ${spec.loginHint}`;
    }
    if (/insufficient (credits|balance|funds)|payment required|\b402\b|out of credits|no credits/i.test(t)) {
      return `${spec.name}: bu model ücretli ve hesapta kredi yok. Ücretsiz bir model seçin.`;
    }
    if (/rate.?limit|\b429\b|too many requests|quota|usage limit/i.test(t)) {
      return `${spec.name} kullanım limiti doldu (rate limit): ${truncate(firstLine(t), 200)}`;
    }
    if (/context (window|length)|too long|maximum context/i.test(t)) return 'İstem çok uzun: modelin bağlam penceresi aşıldı.';
    if (/ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|network|fetch failed|\b50[0234]\b|overloaded/i.test(t)) {
      return `${spec.name} bağlantı hatası (geçici): ${truncate(firstLine(t), 200)}`;
    }
    const line = firstLine(t.replace(/^Error:\s*/i, ''));
    return line ? `${spec.name} hatası: ${truncate(line, 300)}` : `${spec.name} beklenmedik şekilde kapandı.`;
  }

  async function run({ prompt, cwd, model, sessionId, permission = 'read-only', system, signal, onEvent = () => {} }) {
    const fail = (message) => { onEvent({ type: 'error', message }); return new Error(message); };
    const file = spec.bin();
    if (!file) throw fail(spec.notInstalled);
    if (model === 'default') model = undefined;
    if (model && !SAFE_ARG.test(model)) throw fail(`Geçersiz model adı: ${truncate(model, 60)}`);
    if (sessionId && !SAFE_ARG.test(sessionId)) throw fail('Geçersiz oturum kimliği.');

    const args = [...spec.runArgs, '--format', 'json', '--auto', '--thinking'];
    if (model) args.push('-m', model);
    if (sessionId) args.push('-s', sessionId);

    // No system-prompt flag: instructions are prepended to the prompt, once per session.
    let input = String(prompt ?? '');
    if (system && (!sessionId || systemBySession.get(sessionId) !== system)) {
      input = `<system-instructions>\n${system}\n</system-instructions>\n\n${input}`;
    }

    const st = createMapper(onEvent);
    const lines = [];
    onEvent({ type: 'status', text: sessionId ? `${spec.name} oturumu sürdürülüyor…` : `${spec.name} başlatılıyor…` });

    // Free models sometimes stop answering (the CLI waits 5 min, then retries the same stream):
    // give up after IDLE_MS without any event. Tool results only arrive when a tool finishes, so
    // the limit is generous.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let idle = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { idle = true; ctrl.abort(); }, IDLE_MS);
    };
    arm();

    let code;
    let stderr = '';
    try {
      ({ code, stderr } = await runJsonl({
        file,
        args,
        cwd: realCwd(cwd),
        env: cleanEnv({ [spec.configEnv]: JSON.stringify(permissionConfig(permission)), NO_COLOR: '1' }),
        stdin: input,
        signal: ctrl.signal,
        onJson: (o) => { arm(); st.handle(o); },
        onLine: (l) => { if (lines.length < 40) lines.push(l); },
      }));
    } catch (err) {
      if (idle && !signal?.aborted) {
        throw fail(`${spec.name} ${Math.round(IDLE_MS / 60000)} dakikadır cevap vermedi (model yanıt vermiyor); tekrar deneyin ya da başka bir model seçin.`);
      }
      if (err instanceof AbortError || err?.name === 'AbortError') throw err;
      throw fail(err?.code === 'ENOENT' ? spec.notInstalled : `${spec.name} başlatılamadı: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const sid = st.sessionId || sessionId;
    if (sid && system) systemBySession.set(sid, system);
    let usage;
    if (st.usage.seen) {
      usage = { inputTokens: st.usage.inputTokens, outputTokens: st.usage.outputTokens, ...(st.usage.costUsd > 0 ? { costUsd: st.usage.costUsd } : {}) };
      onEvent({ type: 'usage', ...usage });
      stats.inputTokens += usage.inputTokens;
      stats.outputTokens += usage.outputTokens;
      stats.costUsd += usage.costUsd || 0;
    }
    stats.turns++;

    if (code === 0 && !st.error) {
      onEvent({ type: 'done', text: st.lastText, sessionId: sid });
      return { text: st.lastText, sessionId: sid, usage };
    }
    const detail = [st.error, ...lines, stderr].filter(Boolean).join('\n');
    throw fail(describeError(detail || `çıkış kodu ${code}`, { model }));
  }

  return {
    id: spec.id,
    name: spec.name,
    capabilities: { edit: true, resume: true, streaming: false, cwd: true, sandbox: true, localProcess: true, editShell: false },
    detect,
    listModels,
    getLimits,
    login,
    run,
    _internal: { describeError, permissionConfig },
  };
}

/** `which` for an npm-installed CLI, preferring a native binary next to the `.cmd` shim. */
export function resolveBin(name, nativeRel) {
  const shim = which(name);
  if (!shim || !nativeRel || !/\.cmd$/i.test(shim)) return shim;
  const exe = `${shim.slice(0, -(name.length + 4))}${nativeRel}`;
  return which(exe) || shim;
}

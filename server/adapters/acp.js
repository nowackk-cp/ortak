// Minimal Agent Client Protocol (https://agentclientprotocol.com) client: newline-delimited
// JSON-RPC 2.0 over a child process's stdio. Used by agents whose CLI speaks ACP (Junie).
//
// The client advertises no fs/terminal capabilities, so the agent uses its own tools; Ortak only
// answers `session/request_permission` (per the run's permission level) and reads
// `session/update` notifications.
import { spawnCli, killTree, AbortError } from './base.js';

export class AcpError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

export class AcpClient {
  /**
   * @param opts { file, args, cwd, env,
   *               onNotification(method, params), onRequest(method, params) → result | throws,
   *               onExit(code) }
   */
  constructor(opts) {
    this.opts = opts;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.closed = false;
    this.child = spawnCli(opts.file, opts.args || [], { cwd: opts.cwd, env: opts.env });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => { if (this.stderr.length < 65536) this.stderr += d; });
    this.child.stdin.on('error', () => {});
    this.child.on('error', (err) => this.#failAll(err));
    this.child.on('close', (code) => {
      this.closed = true;
      this.#failAll(new AcpError(`ACP süreci kapandı (çıkış kodu ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`, 'exit'));
      this.opts.onExit?.(code);
    });
  }

  #failAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  #write(msg) {
    if (this.closed) return;
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); } catch { /* exited */ }
  }

  async #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id != null) {
      // request from the agent
      try {
        const result = await this.opts.onRequest?.(msg.method, msg.params || {});
        this.#write({ id: msg.id, result: result ?? null });
      } catch (err) {
        this.#write({ id: msg.id, error: { code: err?.code ?? -32601, message: err?.message || 'Desteklenmiyor' } });
      }
    } else if (msg.method) {
      try { this.opts.onNotification?.(msg.method, msg.params || {}); } catch (err) { console.error('[acp] bildirim hatası', err); }
    } else if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpError(msg.error.message || 'ACP hatası', msg.error.code, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  /** JSON-RPC request; `timeoutMs` 0 = none. */
  request(method, params, { timeoutMs = 60_000 } = {}) {
    if (this.closed) return Promise.reject(new AcpError('ACP süreci kapalı', 'closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`${method} zaman aşımına uğradı`, 'timeout'));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method, params) {
    this.#write({ method, params });
  }

  close() {
    if (this.closed) return;
    this.#failAll(new AbortError());
    try { this.child.stdin.end(); } catch { /* ignore */ }
    killTree(this.child);
  }
}

export const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'ortak', title: 'Ortak', version: '0.1.0' },
};

/** Text of an ACP ContentBlock (or an array of them / tool-call content items). */
export function contentText(c) {
  if (!c) return '';
  if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join('\n');
  if (typeof c === 'string') return c;
  if (c.type === 'text') return c.text || '';
  if (c.type === 'content') return contentText(c.content);
  if (c.type === 'diff') return `${c.path || 'dosya'} değişti`;
  if (c.type === 'resource_link') return c.uri || c.name || '';
  if (c.type === 'resource') return c.resource?.text || c.resource?.uri || '';
  return '';
}

/** Option to answer a permission request with: allow or reject (once), per the ACP option kinds. */
export function permissionOutcome(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const pick = allow
    ? list.find((o) => o.kind === 'allow_once') || list.find((o) => /^allow/.test(o.kind || ''))
    : list.find((o) => o.kind === 'reject_once') || list.find((o) => /^reject/.test(o.kind || ''));
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

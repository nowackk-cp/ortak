// Run store: meta in data/runs/<id>.json, events in data/runs/<id>.jsonl (append-only).
// Metas are loaded at startup; event logs are loaded lazily on first access.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isRunId = (id) => typeof id === 'string' && ID_RE.test(id);

function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Atomic-ish JSON write (tmp + rename, falls back to direct write if rename is blocked). */
async function writeJson(file, obj) {
  const data = JSON.stringify(obj, null, 1);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, file);
  } catch {
    await fsp.writeFile(file, data, 'utf8');
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

export class RunStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'runs');
    this.runs = new Map();
    this.recentFile = path.join(dataDir, 'recent.json');
    this.recent = [];
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    for (const f of await fsp.readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dir, f), 'utf8'));
        if (meta && isRunId(meta.id)) this.runs.set(meta.id, this.#wrap(meta, false));
      } catch (err) {
        console.warn(`[runs] ${f} okunamadı: ${err.message}`);
      }
    }
    try {
      const r = JSON.parse(await fsp.readFile(this.recentFile, 'utf8'));
      if (Array.isArray(r?.cwds)) this.recent = r.cwds.filter((s) => typeof s === 'string');
    } catch { /* first start */ }
  }

  #wrap(meta, loaded) {
    return {
      meta,
      events: loaded ? [] : null,
      seq: 0,
      listeners: new Set(),
      busy: new Set(), // lanes with an agent turn in progress (in-memory only)
      pending: [],
      flushTimer: null,
      writeChain: Promise.resolve(),
      metaTimer: null,
      metaChain: Promise.resolve(),
      deleted: false,
    };
  }

  #paths(id) {
    return { json: path.join(this.dir, `${id}.json`), jsonl: path.join(this.dir, `${id}.jsonl`) };
  }

  get(id) {
    return isRunId(id) ? this.runs.get(id) || null : null;
  }

  all() {
    return [...this.runs.values()];
  }

  list() {
    return this.all().map((r) => r.meta).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  create({ mode, title, cwd, config, lanes, extra = {} }) {
    let id;
    do id = newRunId(); while (this.runs.has(id));
    const now = Date.now();
    const meta = { id, mode, title, cwd, createdAt: now, updatedAt: now, status: 'running', config, lanes, ...extra, state: {} };
    const run = this.#wrap(meta, true);
    this.runs.set(id, run);
    this.saveMeta(run, true);
    return run;
  }

  /** Events of a run (loads the JSONL on first access; tolerates a torn last line). */
  events(run) {
    if (!run.events) {
      run.events = [];
      let text = '';
      try { text = fs.readFileSync(this.#paths(run.meta.id).jsonl, 'utf8'); } catch { /* no events yet */ }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          run.events.push(e);
          if (e.seq > run.seq) run.seq = e.seq;
        } catch { /* torn write */ }
      }
    }
    return run.events;
  }

  /** Append an event: assigns seq/ts/runId, persists, notifies subscribers. */
  append(run, payload) {
    if (run.deleted) return null;
    this.events(run);
    const { seq: _s, ts: _t, runId: _r, ...rest } = payload;
    const env = { seq: ++run.seq, ts: Date.now(), runId: run.meta.id, ...rest };
    run.events.push(env);
    run.pending.push(JSON.stringify(env));
    if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), 40);
    run.meta.updatedAt = env.ts;
    this.saveMeta(run);
    for (const fn of run.listeners) {
      try { fn(env); } catch (err) { console.error('[runs] listener error', err); }
    }
    return env;
  }

  subscribe(run, fn) {
    run.listeners.add(fn);
    return () => run.listeners.delete(fn);
  }

  flush(run) {
    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    if (run.pending.length && !run.deleted) {
      const data = run.pending.join('\n') + '\n';
      run.pending = [];
      const file = this.#paths(run.meta.id).jsonl;
      run.writeChain = run.writeChain
        .then(() => fsp.appendFile(file, data, 'utf8'))
        .catch((err) => console.error(`[runs] olay yazılamadı (${run.meta.id}): ${err.message}`));
    }
    return run.writeChain;
  }

  /** Persist meta. Debounced unless `immediate` (status changes, lanes, sessions). */
  saveMeta(run, immediate = false) {
    if (run.deleted) return run.metaChain;
    if (run.metaTimer) { clearTimeout(run.metaTimer); run.metaTimer = null; }
    const write = () => {
      run.metaTimer = null;
      if (run.deleted) return run.metaChain;
      const snapshot = structuredClone(run.meta);
      run.metaChain = run.metaChain
        .then(() => writeJson(this.#paths(run.meta.id).json, snapshot))
        .catch((err) => console.error(`[runs] meta yazılamadı (${run.meta.id}): ${err.message}`));
      return run.metaChain;
    };
    if (immediate) return write();
    run.metaTimer = setTimeout(write, 1000);
    return run.metaChain;
  }

  setStatus(run, status, error) {
    run.meta.status = status;
    if (error) run.meta.error = error; else delete run.meta.error;
    this.append(run, { kind: 'run', status, ...(error ? { error } : {}) });
    this.saveMeta(run, true);
  }

  async flushAll() {
    await Promise.all(this.all().map(async (run) => {
      if (run.metaTimer) this.saveMeta(run, true);
      await Promise.all([this.flush(run), run.metaChain]);
    }));
  }

  async delete(id) {
    const run = this.get(id);
    if (!run) return false;
    await Promise.all([this.flush(run), run.metaChain]);
    if (run.metaTimer) clearTimeout(run.metaTimer);
    run.deleted = true;
    this.runs.delete(id);
    for (const fn of run.listeners) { try { fn(null); } catch { /* ignore */ } }
    run.listeners.clear();
    const p = this.#paths(id);
    await Promise.all([p.json, p.jsonl].map((f) => fsp.rm(f, { force: true, maxRetries: 3, retryDelay: 200 })));
    return true;
  }

  // ---- recent project folders -------------------------------------------------------------

  getRecent() {
    return [...this.recent];
  }

  async addRecent(cwd) {
    const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    this.recent = [cwd, ...this.recent.filter((c) => norm(c) !== norm(cwd))].slice(0, 15);
    try { await writeJson(this.recentFile, { cwds: this.recent }); } catch (err) { console.warn('[runs] recent.json yazılamadı', err.message); }
  }
}

/** Meta as exposed over HTTP (internal orchestrator state stripped). */
export function publicMeta(meta) {
  const { state, ...rest } = meta;
  return rest;
}

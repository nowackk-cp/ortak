// Mode dispatch + run lifecycle: validation, activation (one AbortController per activity),
// follow-ups, cancel, apply, delete, restart recovery.
import path from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getAgents } from '../limits.js';
import { BUDGETS, DEFAULT_BUDGET, autoTeam, modelTier } from '../tiers.js';
import * as git from '../git.js';
import { makeContext } from './context.js';
import { realCwd } from '../adapters/base.js';
import { HttpError, badRequest, makeTitle, sleep } from '../util.js';
import chat from './chat.js';
import brainstorm from './brainstorm.js';
import group from './group.js';
import parallel from './parallel.js';
import team from './team.js';
import lead, { DEFAULT_PARALLEL, DEFAULT_TASK_MINUTES } from './lead.js';
import { withAttachments } from './prompts.js';
import * as checkpoints from '../checkpoints.js';
import * as att from '../attachments.js';

const MODES = { chat, group, brainstorm, parallel, team, lead };
// Sohbet arayüzü (surface 'chat'): no project folder, conversation modes only, always read-only.
const CHAT_SURFACE_MODES = ['chat', 'group', 'brainstorm'];
const PERMISSIONS = ['read-only', 'edit', 'full'];
const MAX_PARTICIPANTS = 8;
const MAX_WORKERS = 6;
const MAX_LEAD_WORKERS = 8;
const PROMPT_MAX = 200_000;
/** File names / image links shown in the user's bubble. */
const userFiles = (files, images) => ({
  ...(files.length ? { files: files.map((f) => f.name) } : {}),
  ...(images.length ? { images: images.map(({ name, url }) => ({ name, url })) } : {}),
});

const ROLE_TR = { participant: 'katılımcı', moderator: 'moderatör', planner: 'planlayıcı', reviewer: 'denetçi', worker: 'çalışan', agent: 'ajan', lead: 'yönetici' };

export class Orchestrator {
  constructor(store, { dataDir }) {
    this.store = store;
    this.worktreeRoot = path.join(dataDir, 'worktrees');
    this.chatDir = path.join(dataDir, 'sohbet'); // working folder of Sohbet-arayüzü runs (stays empty)
    this.active = new Map(); // runId -> { ctrl, done }
  }

  // ---- validation -----------------------------------------------------------------------------

  async #validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Geçersiz istek gövdesi.');
    const mode = raw.mode;
    if (!Object.hasOwn(MODES, mode)) throw badRequest(`Geçersiz mod: ${mode ?? '(yok)'}. Geçerli modlar: chat, group, brainstorm, parallel, team, lead.`);

    const { texts: files, images } = att.parse(raw.attachments);
    const shown = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!shown && !files.length && !images.length) throw badRequest('İstem (prompt) boş olamaz.');
    if (shown.length > PROMPT_MAX) throw badRequest('İstem çok uzun.');
    // Agents see the attachments inline (images: saved by createRun); the UI shows text + names.
    const prompt = withAttachments(shown || 'Eklediğim dosyalara bak.', files);

    const surface = raw.surface === 'chat' ? 'chat' : 'code';
    if (surface === 'chat') {
      if (!CHAT_SURFACE_MODES.includes(mode)) throw badRequest('Sohbet arayüzünde yalnızca tek model, grup sohbeti ve beyin fırtınası kullanılabilir.');
      await mkdir(this.chatDir, { recursive: true });
    } else if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) {
      throw badRequest('Proje klasörü (cwd) gerekli.');
    }
    const cwd = realCwd(surface === 'chat' ? this.chatDir : path.resolve(raw.cwd.trim())); // long form: 8.3 names confuse CLI sandboxes
    let st;
    try { st = await stat(cwd); } catch { throw badRequest(`Klasör bulunamadı: ${cwd}`); }
    if (!st.isDirectory()) throw badRequest(`Bu bir klasör değil: ${cwd}`);

    let permission;
    if (surface === 'chat') {
      if (mode === 'chat') permission = 'read-only';
    } else if (mode !== 'brainstorm' && mode !== 'group') {
      permission = raw.permission ?? 'edit';
      if (!PERMISSIONS.includes(permission)) throw badRequest(`Geçersiz izin: ${permission}. Geçerli değerler: read-only, edit, full.`);
    }

    const agents = new Map((await getAgents()).map((a) => [a.id, a]));
    const resolve = (spec, role, needsEdit) => {
      if (!spec || typeof spec !== 'object' || typeof spec.agentId !== 'string' || !spec.agentId) {
        throw badRequest(`${ROLE_TR[role]} için ajan seçilmedi.`);
      }
      const info = agents.get(spec.agentId);
      if (!info) throw badRequest(`Bilinmeyen ajan: ${spec.agentId}`);
      if (!info.available) throw badRequest(`${info.name} kullanılamıyor: ${info.reason || 'bulunamadı'}`);
      if (needsEdit && !info.capabilities.edit) {
        throw badRequest(`${info.name} dosya düzenleyemez; yalnızca okuma rollerinde (beyin fırtınası, planlayıcı, denetçi) veya salt okunur sohbette kullanılabilir.`);
      }
      let model = typeof spec.model === 'string' && spec.model.trim() ? spec.model.trim() : undefined;
      if (!model) model = (info.models.find((m) => m.default && !m.disabled) || info.models.find((m) => !m.disabled) || info.models[0])?.id;
      const locked = info.models.find((m) => m.id === model && m.disabled);
      if (locked) throw badRequest(`${info.name} · ${locked.label.replace(/ — kilitli$/, '')} bu hesapta kullanılamıyor${locked.note ? ` (${locked.note})` : ''}. Başka bir model seçin.`);
      const picked = info.models.find((m) => m.id === model);
      const modelLabel = picked?.label || model || '';
      return { agentId: info.id, model: model || null, role, name: info.name, modelLabel, tier: picked?.tier || modelTier(info.id, picked) };
    };
    const list = (arr, role, needsEdit, max, what) => {
      if (!Array.isArray(arr) || !arr.length) throw badRequest(`En az bir ${what} seçin.`);
      if (arr.length > max) throw badRequest(`En fazla ${max} ${what} seçilebilir.`);
      return arr.map((s) => resolve(s, role, needsEdit));
    };

    const config = {
      mode, cwd, prompt, ...(surface === 'chat' ? { surface } : {}),
      ...(files.length || images.length ? { display: shown, files: files.map((f) => f.name) } : {}),
    };
    let entries;
    let extra = {};
    if (mode === 'chat') {
      // Text-only agents (Gemini web / 4 Argon, EVREN) can edit too: Ortak is their hands (chat.js).
      const a = resolve(raw.agent, 'agent', false);
      entries = [a];
      Object.assign(config, { agent: { agentId: a.agentId, model: a.model }, permission });
    } else if (mode === 'brainstorm') {
      const parts = list(raw.participants, 'participant', false, MAX_PARTICIPANTS, 'katılımcı');
      const rounds = raw.rounds == null ? 2 : Math.trunc(Number(raw.rounds));
      if (!Number.isFinite(rounds) || rounds < 1 || rounds > 5) throw badRequest('Tur sayısı 1 ile 5 arasında olmalı.');
      const mod = resolve(raw.moderator || raw.participants[0], 'moderator', false);
      entries = [...parts, { ...mod, lane: 'moderator' }];
      Object.assign(config, {
        participants: parts.map(({ agentId, model }) => ({ agentId, model })),
        rounds,
        moderator: { agentId: mod.agentId, model: mod.model },
      });
    } else if (mode === 'group') {
      const parts = list(raw.participants, 'participant', false, MAX_PARTICIPANTS, 'katılımcı');
      if (parts.length < 2) throw badRequest('Grup sohbeti için en az iki katılımcı seçin (aynı ajanı farklı modellerle de ekleyebilirsiniz).');
      const rounds = raw.rounds == null ? 2 : Math.trunc(Number(raw.rounds));
      if (!Number.isFinite(rounds) || rounds < 1 || rounds > 5) throw badRequest('Konuşma uzunluğu 1 ile 5 arasında olmalı.');
      entries = parts;
      Object.assign(config, { participants: parts.map(({ agentId, model }) => ({ agentId, model })), rounds });
    } else if (mode === 'parallel') {
      const parts = list(raw.participants, 'worker', false, MAX_PARTICIPANTS, 'ajan');
      const info = await git.repoInfo(cwd);
      if (!info.isGit) {
        throw badRequest('Paralel mod bir git deposu gerektirir. Klasörde `git init`, `git add -A` ve `git commit -m "ilk"` komutlarını çalıştırın.');
      }
      if (!info.head) throw badRequest('Depoda henüz commit yok. Önce `git add -A` ve `git commit -m "ilk"` ile bir commit oluşturun.');
      entries = parts;
      Object.assign(config, { participants: parts.map(({ agentId, model }) => ({ agentId, model })), permission });
      extra = { git: { top: info.top, base: info.head, branch: info.branch, rel: path.relative(info.top, cwd) } };
    } else if (mode === 'lead') {
      // The lead only reads; text-only agents (Gemini web) may be workers: Ortak edits for them.
      const boss = resolve(raw.lead, 'lead', false);
      const budget = raw.budget ?? DEFAULT_BUDGET;
      if (!BUDGETS.includes(budget)) throw badRequest(`Geçersiz bütçe: ${budget}. Geçerli değerler: ${BUDGETS.join(', ')}.`);
      // workers: 'auto' = every usable agent the budget allows (tiers.js), else an explicit list
      const auto = raw.workers === 'auto';
      let specs = raw.workers;
      if (auto) {
        specs = autoTeam([...agents.values()], { budget, lead: { agentId: boss.agentId, model: boss.model } });
        if (!specs.length) {
          throw badRequest(budget === 'free-only'
            ? 'Kullanılabilir ücretsiz ajan yok. Ajanlar ve API\'ler penceresinden Groq, OpenRouter ya da Gemini gibi ücretsiz bir ajanı bağlayın veya bütçeyi değiştirin.'
            : 'Ekip için kullanılabilir alt ajan yok. Ajanlar ve API\'ler penceresinden bir ajan bağlayın.');
        }
      }
      const workers = list(specs, 'worker', false, MAX_LEAD_WORKERS, 'alt ajan');
      const steps = raw.steps == null ? 8 : Math.trunc(Number(raw.steps));
      if (!Number.isFinite(steps) || steps < 1 || steps > 12) throw badRequest('Adım sayısı 1 ile 12 arasında olmalı.');
      const par = raw.parallel == null ? DEFAULT_PARALLEL : Math.trunc(Number(raw.parallel));
      if (!Number.isFinite(par) || par < 1 || par > 10) throw badRequest('Aynı anda çalışan görev sayısı 1 ile 10 arasında olmalı.');
      const mins = raw.taskMinutes == null ? DEFAULT_TASK_MINUTES : Math.trunc(Number(raw.taskMinutes));
      if (!Number.isFinite(mins) || mins < 0 || mins > 120) throw badRequest('Görev süre sınırı 0 (sınırsız) ile 120 dakika arasında olmalı.');
      entries = [{ ...boss, lane: 'lead' }, ...workers];
      Object.assign(config, {
        lead: { agentId: boss.agentId, model: boss.model },
        workers: workers.map(({ agentId, model }) => ({ agentId, model })),
        ...(auto ? { autoTeam: true } : { approvedWorkers: workers.map(({ agentId, model }) => ({ agentId, model })) }),
        budget,
        steps,
        parallel: par,
        taskMinutes: mins,
        permission,
      });
      const info = await git.repoInfo(cwd);
      extra = { git: info.isGit ? { top: info.top, base: info.head, branch: info.branch, rel: path.relative(info.top, cwd) } : null };
    } else {
      const workers = list(raw.workers, 'worker', false, MAX_WORKERS, 'çalışan');
      const planner = resolve(raw.planner || raw.workers[0], 'planner', false);
      const reviewer = resolve(raw.reviewer || raw.planner || raw.workers[0], 'reviewer', false);
      const fixRounds = raw.fixRounds == null ? 3 : Math.trunc(Number(raw.fixRounds));
      if (!Number.isFinite(fixRounds) || fixRounds < 1 || fixRounds > 5) throw badRequest('Düzeltme turu sayısı 1 ile 5 arasında olmalı.');
      entries = [{ ...planner, lane: 'planner' }, ...workers, { ...reviewer, lane: 'reviewer' }];
      Object.assign(config, {
        planner: { agentId: planner.agentId, model: planner.model },
        workers: workers.map(({ agentId, model }) => ({ agentId, model })),
        reviewer: { agentId: reviewer.agentId, model: reviewer.model },
        fixRounds,
        permission,
      });
      const info = await git.repoInfo(cwd);
      extra = { git: info.isGit ? { top: info.top, base: info.head, branch: info.branch, rel: path.relative(info.top, cwd) } : null };
    }
    return { mode, cwd, prompt, shown, files, images, surface, config, lanes: buildLanes(entries), extra };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  #setStatus(run, status, error) {
    if (run.deleted) return;
    this.store.setStatus(run, status, error);
  }

  /**
   * Start an activity on a run. `before()` emits its opening events right before 'running'.
   * `listener` (ctx.listen) takes the messages the user sends meanwhile; the others wait in `queue`
   * and are sent as follow-ups when the activity ends (stopped or not).
   */
  #activate(run, fn, before) {
    const id = run.meta.id;
    const ctrl = new AbortController();
    const entry = { ctrl, done: null, listener: null, queue: [], ctx: null };
    this.active.set(id, entry);
    before?.();
    this.#setStatus(run, 'running');
    entry.done = (async () => {
      let status = 'done';
      let error;
      try {
        const ctx = await makeContext(this.store, run, ctrl.signal, entry);
        entry.ctx = ctx;
        status = (await fn(ctx)) || 'done';
        if (ctrl.signal.aborted) status = 'cancelled';
      } catch (err) {
        if (err?.name === 'AbortError' || ctrl.signal.aborted) status = 'cancelled';
        else {
          status = 'error';
          error = err?.message || String(err);
          if (!(err instanceof HttpError)) console.error(`[run ${id}] hata: ${error}`);
        }
      }
      entry.listener = null;
      if (this.active.get(id) === entry) this.active.delete(id);
      if (status === 'cancelled') this.store.append(run, { kind: 'note', text: 'Çalışma iptal edildi.', level: 'warn' });
      this.#setStatus(run, status, error);
      if (entry.queue.length && !run.deleted && this.store.get(id)) this.#sendQueued(run, entry.queue);
    })();
    return entry;
  }

  /** Messages written while the run was busy: the first batch (same target) as one follow-up. */
  #sendQueued(run, queue) {
    const mod = MODES[run.meta.mode];
    let n = 1;
    while (n < queue.length && queue[n].lane === queue[0].lane) n++;
    const lane = queue[0].lane;
    const text = queue.slice(0, n).map((m) => m.text).join('\n\n');
    const rest = queue.slice(n);
    try {
      mod.checkFollowUp?.(run.meta, { text, lane });
    } catch (err) {
      this.store.append(run, { kind: 'note', text: `Sıradaki mesaj gönderilemedi: ${err.message}`, level: 'error' });
      if (rest.length) this.#sendQueued(run, rest);
      return;
    }
    const next = this.#activate(run, (ctx) => mod.followUp(ctx, { text, lane }), () => {
      this.store.append(run, { kind: 'dequeue', count: n }); // the UI moves them into the transcript
    });
    next.queue.push(...rest);
  }

  async createRun(raw) {
    const v = await this.#validate(raw);
    const images = await att.saveImages(v.images);
    if (images.length) {
      v.config.prompt = withAttachments(v.shown || 'Eklediğim resimlere bak.', v.files, images);
      v.config.images = images.map(({ name, url }) => ({ name, url }));
    }
    const run = this.store.create({
      mode: v.mode, title: makeTitle(v.shown || v.files[0]?.name || images[0]?.name || v.prompt), cwd: v.cwd, config: v.config, lanes: v.lanes, extra: v.extra,
    });
    if (images.length) run.meta.state = { ...(run.meta.state || {}), images };
    if (v.mode === 'parallel') run.meta.git.worktreeDir = path.join(this.worktreeRoot, run.meta.id);
    if (v.surface !== 'chat') this.store.addRecent(v.cwd);
    this.#activate(run, (ctx) => MODES[v.mode].start(ctx), () => {
      for (const l of run.meta.lanes) {
        this.store.append(run, { kind: 'lane', lane: l.lane, agentId: l.agentId, model: l.model, role: l.role, title: l.title, tier: l.tier });
      }
      this.store.append(run, { kind: 'user', text: v.shown, ...userFiles(v.files, images) });
    });
    return run.meta.id;
  }

  #get(id) {
    const run = this.store.get(id);
    if (!run) throw new HttpError(404, 'Çalışma bulunamadı.');
    return run;
  }

  isActive(id) {
    return this.active.has(id);
  }

  async message(id, body) {
    const run = this.#get(id);
    const { texts: files, images: rawImages } = att.parse(body?.attachments);
    const shown = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!shown && !files.length && !rawImages.length) throw badRequest('Mesaj boş olamaz.');
    if (shown.length > PROMPT_MAX) throw badRequest('Mesaj çok uzun.');
    const images = await att.saveImages(rawImages);
    const text = withAttachments(shown || (images.length ? 'Eklediğim resimlere bak.' : 'Eklediğim dosyalara bak.'), files, images);
    const lane = body?.lane == null || body.lane === '' ? undefined : String(body.lane);
    if (lane && !run.meta.lanes.some((l) => l.lane === lane)) throw badRequest(`Bilinmeyen şerit: ${lane}`);
    const mod = MODES[run.meta.mode];
    if (!mod) throw badRequest(`Bilinmeyen mod: ${run.meta.mode}`);
    mod.checkFollowUp?.(run.meta, { text, lane });
    this.store.events(run); // make sure the log is loaded before appending
    if (images.length) {
      const st = (run.meta.state ||= {});
      st.images = [...(st.images || []), ...images];
      this.store.saveMeta(run, true);
    }
    const userEvent = (extra) => this.store.append(run, { kind: 'user', text: shown, ...userFiles(files, images), ...(lane ? { lane } : {}), ...extra });
    const entry = this.active.get(id);
    if (entry) {
      // While it runs: the activity takes it now (lead, team, group) or it is sent when it ends.
      const msg = { text, lane };
      const l = entry.listener;
      if (l && (!l.accepts || l.accepts(msg))) {
        userEvent({ live: true });
        l.deliver(msg);
        return { ok: true, delivery: 'live' };
      }
      userEvent({ queued: true });
      entry.queue.push(msg);
      return { ok: true, delivery: 'queued' };
    }
    this.#activate(run, (ctx) => mod.followUp(ctx, { text, lane }), () => userEvent({}));
    return { ok: true, delivery: 'started' };
  }

  /** Stops one lane's running turn (a stuck agent); the run goes on without it. */
  stopLane(id, body) {
    const run = this.#get(id);
    const lane = String(body?.lane || '');
    if (!run.meta.lanes.some((l) => l.lane === lane)) throw badRequest(`Bilinmeyen şerit: ${lane}`);
    const stopped = !!this.active.get(id)?.ctx?.stopLane(lane);
    return { ok: true, stopped };
  }

  /** Restores the files of one checkpoint (changes Ortak made for a text-only agent). */
  async undo(id, body) {
    const run = this.#get(id);
    if (this.active.has(id)) throw new HttpError(409, 'Çalışma sürüyor; geri almak için bitmesini bekleyin veya durdurun.');
    const cpId = String(body?.checkpoint || '');
    let r;
    try { r = await checkpoints.undo(id, cpId); } catch (err) { throw badRequest(err.message); }
    this.store.events(run);
    this.store.append(run, { kind: 'undo', checkpoint: cpId, restored: r.restored, conflicts: r.conflicts });
    return { ok: true, ...r };
  }

  cancel(id) {
    this.#get(id);
    const entry = this.active.get(id);
    if (entry) entry.ctrl.abort();
    return { ok: true, cancelled: !!entry };
  }

  async apply(id, body) {
    const run = this.#get(id);
    const meta = run.meta;
    if (meta.mode !== 'parallel' || !meta.git) throw badRequest('Uygulama yalnızca paralel modda kullanılabilir.');
    const lane = meta.lanes.find((l) => l.lane === body?.lane);
    if (!lane) throw badRequest(`Bilinmeyen şerit: ${body?.lane ?? '(yok)'}`);
    if (run.busy.has(lane.lane)) throw new HttpError(409, `${lane.title} hâlâ çalışıyor; bitmesini bekleyin.`);
    if (!lane.worktree || !existsSync(lane.worktree)) throw new HttpError(409, `${lane.title} için çalışma ağacı bulunamadı.`);
    if (run.applying) throw new HttpError(409, 'Başka bir uygulama işlemi sürüyor.');
    run.applying = true;
    try {
      const { diff } = await git.worktreeDiff(lane.worktree, meta.git.base, { raw: true });
      if (!diff.length) throw new HttpError(409, `${lane.title} hiçbir değişiklik yapmamış; uygulanacak bir şey yok.`);
      const r = await git.applyPatch(meta.git.top, diff);
      if (!r.ok) {
        const msg = r.conflicts
          ? 'Değişiklikler çakışmalarla uygulandı; çakışma işaretlerini (<<<<<<<) elle çözün.'
          : 'Değişiklikler uygulanamadı: ana klasördeki dosyalar bu diff ile uyuşmuyor (değişiklikleri commit edin/geri alın ya da zaten uygulanmış olabilir).';
        this.store.append(run, { kind: 'note', text: `${lane.title}: ${msg}\n${r.output}`, level: 'error' });
        throw new HttpError(409, msg, { ok: false, conflicts: r.conflicts, output: r.output });
      }
      meta.applied = [...(meta.applied || []), { lane: lane.lane, at: Date.now() }];
      this.store.saveMeta(run, true);
      this.store.append(run, { kind: 'note', text: `${lane.title} değişiklikleri ${meta.git.top} klasörüne uygulandı.\n${r.output}`, level: 'info' });
      return { ok: true, output: r.output, method: r.method };
    } finally {
      run.applying = false;
    }
  }

  async remove(id) {
    const run = this.#get(id);
    const entry = this.active.get(id);
    if (entry) {
      entry.ctrl.abort();
      await Promise.race([entry.done, sleep(10_000)]);
    }
    const meta = run.meta;
    if (meta.mode === 'parallel' && meta.git?.top) {
      for (const l of meta.lanes) {
        if (l.worktree || l.branch) await git.removeWorktree(meta.git.top, l.worktree || '', l.branch);
      }
      await git.git(['worktree', 'prune'], { cwd: meta.git.top });
    }
    await rm(path.join(this.worktreeRoot, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
    await checkpoints.removeAll(id);
    await att.removeImages(meta.state?.images);
    await this.store.delete(id);
    return { ok: true };
  }

  /** On startup: runs left 'running' by a crash/restart become 'waiting' if resumable, else 'error'. */
  recover() {
    for (const run of this.store.all()) {
      if (run.meta.status !== 'running') continue;
      const mod = MODES[run.meta.mode];
      if (mod?.resumable?.(run.meta)) {
        this.store.append(run, { kind: 'note', text: 'Sunucu yeniden başlatıldı; son tur yarıda kaldı. Devam etmek için mesaj gönderebilirsiniz.', level: 'warn' });
        this.store.setStatus(run, 'waiting');
      } else {
        this.store.setStatus(run, 'error', 'Sunucu yeniden başlatıldı');
      }
    }
  }

  async shutdown(timeoutMs = 4000) {
    const entries = [...this.active.values()];
    for (const e of entries) e.ctrl.abort();
    await Promise.race([Promise.allSettled(entries.map((e) => e.done)), sleep(timeoutMs)]);
  }
}

/** Unique lane ids (`claude`, `claude#2`, … or a fixed role lane) and display titles. */
function buildLanes(entries) {
  const counts = new Map();
  const lanes = entries.map((e) => {
    let lane = e.lane;
    if (!lane) {
      const n = (counts.get(e.agentId) || 0) + 1;
      counts.set(e.agentId, n);
      lane = n === 1 ? e.agentId : `${e.agentId}#${n}`;
    }
    return { lane, agentId: e.agentId, model: e.model, role: e.role, tier: e.tier, title: e.modelLabel ? `${e.name} · ${e.modelLabel}` : e.name };
  });
  const seen = new Map();
  for (const l of lanes) {
    const key = `${l.role}|${l.title}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) l.title += ` (${n})`;
  }
  return lanes;
}

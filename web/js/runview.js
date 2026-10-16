// Run view: turns the run's event stream into a transcript (chat, group) or into phase sections
// with side-by-side lane columns (brainstorm / parallel / team). In group mode every speaker turn
// starts with a speaker header, like a group chat.
import { h, icon, spinner, setSafeHtml, fill } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { renderDiff } from './diff.js';
import { agentName, modelLabel, getAgent, tierBadge, modelTier } from './agents.js';
import { MODES, LANE_STATUS, PERMISSIONS, roleLabel, modeInfo } from './modes.js';
import { fmtInt, fmtCost, fmtDuration, fmtDate, truncate, basename, enc, copyText } from './util.js';
import { api, toast } from './api.js';

const TERMINAL = new Set(['done', 'error', 'cancelled']);
export const isTerminal = (s) => TERMINAL.has(s);

// ---- transcript items ------------------------------------------------------------------------

class Msg {
  constructor(cls = '') {
    this.text = '';
    this.rendered = null;
    this.body = h('div', { class: 'md' });
    this.el = h('div', { class: `msg${cls ? ' ' + cls : ''}` }, this.body);
  }
  render() {
    if (this.rendered === this.text) return;
    this.rendered = this.text;
    const src = this.transform ? this.transform(this.text) : this.text;
    setSafeHtml(this.body, renderMarkdown(src)); // renderMarkdown escapes all source text
  }
}

function asText(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function relPath(p, cwd) {
  if (!cwd || typeof p !== 'string') return p;
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const b = norm(cwd);
  return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : p;
}

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) || '';
const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'file', 'pattern', 'query', 'url', 'description', 'prompt', 'name', 'title'];

function toolSummary(input, cwd) {
  if (input == null || input === '') return '';
  if (typeof input === 'string') return truncate(firstLine(input), 110);
  if (typeof input === 'object') {
    if (Array.isArray(input.command)) return truncate(input.command.join(' '), 110);
    for (const k of SUMMARY_KEYS) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return truncate(firstLine(relPath(v, cwd)), 110);
    }
    return truncate(asText(input).replace(/\s+/g, ' '), 110);
  }
  return truncate(String(input), 110);
}

class ToolChip {
  constructor(name, input, cwd) {
    this.done = false;
    this.ico = h('span', { class: 'tool-ico' }, spinner());
    this.body = h('div', { class: 'tool-body' });
    const sum = toolSummary(input, cwd);
    this.el = h('details', { class: 'tool running' },
      h('summary', {}, this.ico, h('span', { class: 'tool-name', text: name || 'Araç' }), sum && h('span', { class: 'tool-arg', text: sum, title: sum })),
      this.body);
    const inTxt = asText(input);
    if (inTxt) this.body.append(section('Girdi', inTxt));
  }
  finish(output, isError) {
    if (this.done) return;
    this.done = true;
    this.el.classList.remove('running');
    this.el.classList.toggle('error', !!isError);
    this.ico.replaceChildren(icon(isError ? 'x' : 'check'));
    const out = asText(output);
    this.body.append(out ? section(isError ? 'Hata' : 'Çıktı', out) : h('div', { class: 'tool-sec tool-none', text: 'Çıktı yok' }));
  }
  stop(ok) {
    if (this.done) return;
    this.done = true;
    this.el.classList.remove('running');
    this.el.classList.add(ok ? 'ended' : 'stopped');
    this.ico.replaceChildren(icon(ok ? 'check' : 'x'));
  }
}

function section(title, text) {
  return h('div', { class: 'tool-sec' }, h('div', { class: 'tool-sec-t', text: title }), h('pre', { class: 'tool-pre', text: truncate(text, 12000) }));
}

class Thinking {
  constructor(text) {
    this.text = '';
    this.preview = h('span', { class: 'think-prev' });
    this.bodyEl = h('div', { class: 'think-body' });
    this.el = h('details', { class: 'thinking' },
      h('summary', {}, icon('brain'), h('span', { class: 'think-t', text: 'Düşünme' }), this.preview),
      this.bodyEl);
    this.append(text);
  }
  append(t) {
    if (t.startsWith(this.text)) this.text = t; // cumulative snapshot
    else this.text += (/\S$/.test(this.text) && /^\*\*/.test(t) ? '\n\n' : '') + t;
    this.bodyEl.textContent = this.text;
    this.preview.textContent = truncate(this.text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(), 100);
  }
}

function noteEl(text, level) {
  const lv = level === 'warn' || level === 'error' ? level : 'info';
  const body = h('div', { class: 'note-text md' });
  setSafeHtml(body, renderMarkdown(String(text ?? ''))); // orchestrator notes may contain markdown
  return h('div', { class: `note note-${lv}`, role: lv === 'error' ? 'alert' : null },
    icon(lv === 'info' ? 'info' : 'warn'),
    body);
}

function userEl(text, target, files, images) {
  const bubble = h('div', { class: 'user-bubble' },
    target && h('div', { class: 'user-target', text: `→ ${target}` }),
    images?.length > 0 && h('div', { class: 'user-images' },
      images.map((im) => h('a', { href: im.url, target: '_blank', rel: 'noopener', title: im.name }, h('img', { src: im.url, alt: im.name })))),
    files?.length > 0 && h('div', { class: 'user-files' },
      files.map((f) => h('span', { class: 'user-file', title: f }, icon('file'), h('span', { class: 'attach-name', text: f })))),
    text && h('div', { class: 'user-text', text }));
  // long prompts (pasted specs, logs) start folded
  if (text && (text.length > 700 || text.split('\n').length > 10)) {
    bubble.classList.add('clamped');
    bubble.append(h('button', {
      type: 'button',
      class: 'link-btn',
      onclick: (e) => { bubble.classList.toggle('clamped'); e.currentTarget.textContent = bubble.classList.contains('clamped') ? 'Tamamını göster' : 'Daralt'; },
    }, 'Tamamını göster'));
  }
  return h('div', { class: 'user-row' }, bubble);
}

/** Machine-readable plan / task blocks (```json {"tasks"…} / {"steps"…}) — the notes show them. */
function hideDecisionJson(t) {
  return t
    .replace(/^[ \t>*_]*KARAR[ \t*_]*[:：][ \t*_]*ONAY[ \t*_.!]*$/gim, '**✓ Karar: onay**')
    .replace(/^[ \t>*_]*KARAR[ \t*_]*[:：][ \t*_]*DÜZELTME[ \t*_.!]*$/gim, '**↻ Karar: düzeltme gerekiyor**')
    .replace(/```json[ \t]*\n\s*[{[][\s\S]*?```/gi, (m) => (/"(tasks|steps|done)"/.test(m) ? '' : m))
    .replace(/```json[ \t]*\n\s*\{[^`]*$/i, (m) => (/"(tasks|steps|done)"/.test(m) ? '' : m))
    .trim();
}

/** "Read README.md" / the last line of what the agent is writing — the folded card's preview. */
function previewOf(text) {
  const lines = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').split('\n').map((l) => l.replace(/[#>*_`|]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const ozet = lines.reverse().find((l) => /^(ÖZET|OZET|KARAR)\s*:/i.test(l));
  return truncate((ozet || lines[0] || '').replace(/^(ÖZET|OZET)\s*:\s*/i, ''), 160);
}

function speakerEl(name, model, handle, agentId) {
  const initial = (name || '?').trim().charAt(0).toLocaleUpperCase('tr');
  return h('div', { class: `speaker spk-${String(agentId || '').replace(/[^a-z0-9_-]/gi, '')}` },
    h('span', { class: 'spk-avatar', 'aria-hidden': 'true', text: initial }),
    h('span', { class: 'spk-name', text: name }),
    model && h('span', { class: 'spk-model', text: model }),
    handle && h('span', { class: 'spk-handle', text: '@' + handle }));
}

/** Coloured initial; a ring spins around it while the agent works. */
function avatarEl(name, agentId, busy) {
  return h('span', { class: `lane-av spk-${String(agentId || '').replace(/[^a-z0-9_-]/gi, '')}${busy ? ' busy' : ''}`, 'aria-hidden': 'true', text: (name || '?').trim().charAt(0).toLocaleUpperCase('tr') });
}

const laneTier = (info) => info.tier || modelTier(info.agentId, info.model);
const shortModel = (info) => modelLabel(info.agentId, info.model).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+—.*$/, '').replace(/\s*·\s*ücretsiz$/i, '').trim();

const phaseEl = (title) => h('div', { class: 'phase', role: 'separator' }, h('span', { class: 'phase-t', text: title }));

// ---- a timeline for one lane (or the whole chat) ---------------------------------------------

class Block {
  constructor(view) {
    this.view = view;
    this.el = h('div', { class: 'tl' });
    this.lanes = new Map();
    this.tools = new Map();
    this.state = 'idle';
    this.statusText = '';
    this.preview = ''; // one line for a folded lane card
    this.onChange = null;
  }

  st(lane) {
    let s = this.lanes.get(lane);
    if (!s) {
      s = { lane, cur: null, last: null, thinking: null, hasText: false, start: 0, usage: null, err: false, foot: null, dur: 0 };
      this.lanes.set(lane, s);
    }
    return s;
  }

  push(node) { this.el.append(node); return node; }
  isLast(node) { return !!node && this.el.lastChild === node; }

  setState(v) { if (this.state !== v) { this.state = v; this.onChange?.(); } }
  setStatusText(t) { if (this.statusText !== t) { this.statusText = t; this.onChange?.(); } }

  newMsg(s) {
    const m = new Msg();
    m.transform = this.view.transformFor(s.lane);
    m.el.classList.add('streaming');
    this.push(m.el);
    s.cur = m;
    s.last = m;
    return m;
  }

  closeMsg(s) {
    if (!s.cur) return;
    const p = previewOf(s.cur.transform ? s.cur.transform(s.cur.text) : s.cur.text);
    if (p) this.preview = p;
    s.cur.el.classList.remove('streaming');
    this.view.dirty(s.cur);
    s.cur = null;
  }

  /** Turn boundary (user message, phase). */
  boundary() {
    for (const s of this.lanes.values()) {
      this.closeMsg(s);
      s.last = null;
      s.thinking = null;
      s.err = false;
    }
  }

  /** The run stopped being 'running'. */
  finish(fin) {
    this.boundary();
    for (const t of this.tools.values()) t.stop(fin === 'done');
    if (this.state === 'running') this.setState(fin);
    this.setStatusText('');
  }

  pushFull(node) {
    this.boundary();
    return this.push(node);
  }

  agent(lane, e, ts) {
    const s = this.st(lane);
    const type = e.type;
    if (type !== 'done' && type !== 'error' && type !== 'usage') {
      if (!s.start) s.start = ts || Date.now();
      if (!s.err) this.setState('running');
    }
    switch (type) {
      case 'text-delta': {
        const t = String(e.text ?? '');
        if (!t) break;
        if (!s.cur) this.newMsg(s);
        s.cur.text += t;
        s.hasText = true;
        s.thinking = null;
        this.view.dirty(s.cur);
        break;
      }
      case 'message': {
        const text = String(e.text ?? '');
        s.thinking = null;
        if (s.cur) {
          if (text || !s.cur.text) s.cur.text = text;
          this.closeMsg(s);
        } else if (s.last && text === s.last.text) {
          // repeat of this lane's previous message (Antigravity re-sends its final text after a thinking step)
        } else if (text) {
          // complete message without preceding deltas (e.g. Codex): its own bubble
          const m = this.newMsg(s);
          m.text = text;
          this.closeMsg(s);
        }
        if (text) s.hasText = true;
        break;
      }
      case 'thinking': {
        const t = String(e.text ?? '');
        if (!t) break;
        this.closeMsg(s);
        if (s.thinking && this.isLast(s.thinking.el)) s.thinking.append(t);
        else { s.thinking = new Thinking(t); this.push(s.thinking.el); }
        break;
      }
      case 'tool-start': {
        this.closeMsg(s);
        s.last = null;
        s.thinking = null;
        this.preview = `${e.name || 'Araç'} ${toolSummary(e.input, this.view.cwd)}`.trim();
        const chip = new ToolChip(e.name, e.input, this.view.cwd);
        this.push(chip.el);
        this.tools.set(`${lane}\u0001${e.id ?? Math.random()}`, chip);
        break;
      }
      case 'tool-end': {
        let chip = e.id != null ? this.tools.get(`${lane}\u0001${e.id}`) : null;
        if (!chip) {
          this.closeMsg(s);
          s.last = null;
          chip = new ToolChip(e.name || 'Araç', undefined, this.view.cwd);
          this.push(chip.el);
          this.tools.set(`${lane}\u0001${e.id ?? Math.random()}`, chip);
        }
        chip.finish(e.output, !!e.isError);
        break;
      }
      case 'status':
        if (e.retry) { // the server retries a failed turn: show it and clear the error state
          s.err = false;
          this.push(noteEl(String(e.text ?? ''), 'warn'));
          this.setState('running');
        }
        this.setStatusText(String(e.text ?? ''));
        break;
      case 'usage':
        s.usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd };
        if (!s.start && s.foot) this.footer(s); // usage arrived after 'done'
        break;
      case 'error':
        this.closeMsg(s);
        s.last = null;
        s.err = true;
        this.preview = `Hata: ${e.message || 'bilinmeyen hata'}`;
        this.push(noteEl(e.message || 'Bilinmeyen hata', 'error'));
        this.setState('error');
        break;
      case 'done': {
        if (!s.hasText && e.text) {
          const m = this.newMsg(s);
          m.text = String(e.text);
        }
        this.closeMsg(s);
        s.dur = s.start && ts ? ts - s.start : 0;
        s.foot = null;
        this.footer(s);
        s.start = 0;
        s.hasText = false;
        s.thinking = null;
        this.setState(s.err ? 'error' : 'done');
        s.err = false;
        this.setStatusText('');
        break;
      }
      default:
        break;
    }
  }

  footer(s) {
    const u = s.usage;
    const parts = [];
    if (u) {
      if (Number.isFinite(u.inputTokens)) parts.push(`${fmtInt(u.inputTokens)} giriş`);
      if (Number.isFinite(u.outputTokens)) parts.push(`${fmtInt(u.outputTokens)} çıkış token`);
      if (Number.isFinite(u.costUsd) && u.costUsd > 0) parts.push(fmtCost(u.costUsd));
    }
    if (s.dur > 0) parts.push(fmtDuration(s.dur));
    s.usage = null;
    if (!parts.length) return;
    const text = parts.join(' · ');
    if (s.foot) s.foot.textContent = text;
    else s.foot = this.push(h('div', { class: 'turn-foot', title: 'Token kullanımı · maliyet · süre', text }));
  }
}

// ---- the view --------------------------------------------------------------------------------

export class RunView {
  /**
   * @param {object} meta run meta
   * @param {HTMLElement} scroller the scrolling container to render into
   * @param {{ onStatus?: (view) => void }} hooks
   */
  constructor(meta, scroller, hooks = {}) {
    this.meta = meta;
    this.id = meta.id;
    this.mode = MODES[meta.mode] ? meta.mode : 'chat';
    this.single = this.mode === 'chat' || this.mode === 'group'; // one transcript, no lane columns
    this.speakers = []; // group: [{ lane, el }] speaker headers, re-labelled when the catalog loads
    this.lastSpeaker = null;
    // group: show the agents' consensus marker as a short label instead of the raw token
    this.msgTransform = this.mode === 'group' ? (t) => t.split('[UZLAŞI]').join('✓ *uzlaştı*') : null;
    // lead / team: one folded card per agent and phase (like a chat app's "working" steps);
    // parallel / brainstorm keep side-by-side columns to compare answers.
    this.stack = this.mode === 'lead' || this.mode === 'team';
    this.cwd = meta.cwd || '';
    this.hooks = hooks;
    this.status = meta.status || 'running';
    this.error = meta.error || '';
    this.lastSeq = 0;
    this.lanes = new Map();
    // `display` = what the user typed when files were attached (config.prompt then has them inline)
    this.prompt = typeof meta.config?.display === 'string' ? meta.config.display : typeof meta.config?.prompt === 'string' ? meta.config.prompt : '';
    this.promptFiles = Array.isArray(meta.config?.files) ? meta.config.files : [];
    this.promptImages = Array.isArray(meta.config?.images) ? meta.config.images : [];
    this.promptSeen = false;
    this.runningSince = Date.now();
    this.dirtySet = new Set();
    this.flushTimer = 0;
    this.lastFlush = 0;
    this.tick = 0;
    // Back from the background: draw what streamed in meanwhile right away.
    this.onVisible = () => { if (!document.hidden && this.dirtySet.size) this.flush(); };
    document.addEventListener('visibilitychange', this.onVisible);
    this.stick = true;
    this.scroller = scroller;

    this.el = h('div', { class: `run run-${this.mode}${this.stack ? ' run-stack' : ''}` });
    this.connEl = h('div', { class: 'conn', hidden: true }, spinner(), 'Bağlantı koptu, yeniden bağlanılıyor…');
    this.jumpBtn = h('button', { type: 'button', class: 'jump-btn', hidden: true, title: 'En alta git', 'aria-label': 'En alta git', onclick: () => this.scrollBottom(true) }, icon('arrowDown'));
    this.el.append(this.connEl, this.infoEl());

    if (this.single) this.buildChat();
    else this.buildMulti();
    this.el.append(this.jumpBtn);

    scroller.replaceChildren(this.el);
    this.lastTop = scroller.scrollTop;
    this.onScroll = () => {
      // Only an upward scroll (by the user) releases the stick; growth/anchoring never does.
      const top = scroller.scrollTop;
      const near = scroller.scrollHeight - top - scroller.clientHeight < 90;
      if (near) this.stick = true;
      else if (top < this.lastTop - 4) this.stick = false;
      this.lastTop = top;
      this.jumpBtn.hidden = this.stick;
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });

    for (const l of Array.isArray(meta.lanes) ? meta.lanes : []) this.declareLane(l);
    this.syncTimer();
  }

  destroy() {
    clearTimeout(this.flushTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.tick);
    this.scroller.removeEventListener('scroll', this.onScroll);
  }

  // -- header line -----------------------------------------------------------------------------

  infoEl() {
    const c = this.meta.config || {};
    const perm = PERMISSIONS.find((p) => p.id === c.permission);
    const bits = [];
    if (this.mode === 'chat' && c.agent?.agentId) bits.push(`${agentName(c.agent.agentId)} · ${modelLabel(c.agent.agentId, c.agent.model)}`);
    if (this.mode === 'brainstorm' && c.rounds) bits.push(`${c.rounds} tur`);
    if (this.mode === 'group' && Array.isArray(c.participants)) bits.push(`${c.participants.length} katılımcı`);
    if (this.mode === 'lead' && Array.isArray(c.workers)) bits.push(`${c.workers.length} alt ajan`);
    return h('div', { class: 'run-info' },
      h('span', { class: 'ri-mode' }, icon(modeInfo(this.mode, this.meta.config?.surface).icon), modeInfo(this.mode, this.meta.config?.surface).label),
      bits.map((b) => h('span', { class: 'ri-bit', text: b })),
      this.cwd && this.meta.config?.surface !== 'chat' && h('span', { class: 'ri-bit ri-cwd', title: this.cwd }, icon('folder'), basename(this.cwd)),
      perm && h('span', { class: `ri-perm perm-${perm.id}`, text: perm.label }),
      this.meta.createdAt && h('span', { class: 'ri-bit ri-date', text: fmtDate(this.meta.createdAt) }));
  }

  // -- layouts ---------------------------------------------------------------------------------

  buildChat() {
    this.chat = new Block(this);
    this.chat.onChange = () => this.updateStatusLine();
    this.statusLine = h('div', { class: 'status-line', hidden: true }, spinner(), h('span', { class: 'sl-text' }), h('span', { class: 'sl-time' }));
    if (this.mode === 'group') {
      this.lanesBar = h('div', { class: 'lanes-bar' });
      this.el.append(this.lanesBar);
    }
    this.el.append(h('div', { class: 'transcript' }, this.chat.el, this.statusLine));
    if (this.prompt || this.promptFiles.length || this.promptImages.length) this.chat.push(userEl(this.prompt, null, this.promptFiles, this.promptImages));
    else this.promptSeen = true;
  }

  buildMulti() {
    this.sections = [];
    this.lanesBar = h('div', { class: 'lanes-bar' });
    this.sectionsEl = h('div', { class: 'sections' });
    let task = null;
    if (this.prompt || this.promptFiles.length || this.promptImages.length) {
      task = userEl(this.prompt, null, this.promptFiles, this.promptImages);
      task.classList.add('task-row');
    } else {
      this.promptSeen = true;
    }
    this.emptyEl = h('div', { class: 'empty small run-wait' }, spinner(), 'Ajanlar hazırlanıyor…');
    this.el.append(this.lanesBar, task, this.sectionsEl, this.emptyEl);
  }

  // -- lanes -----------------------------------------------------------------------------------

  /** Short display name: agent name (+ "#n" for duplicate lanes). The backend's lane title
   *  ("Name · Model") is used only when the agent is unknown. */
  laneLabel(info) {
    if (!info) return '?';
    const id = info.agentId || String(info.lane).split('#')[0];
    const m = String(info.lane).match(/#(\d+)$/);
    const suffix = m ? ` #${m[1]}` : '';
    // unknown agent: use the name part of the backend title ("Name · Model")
    if (!getAgent(id) && info.title) return String(info.title).split(' · ')[0] + suffix;
    return agentName(id) + suffix;
  }

  /** Re-render lane names/models (agent catalog arrived or changed). */
  refreshLabels() {
    if (this.mode === 'chat') return;
    if (this.single) {
      this.renderLanesBar();
      for (const s of this.speakers) s.el.replaceWith(s.el = this.speakerHeader(s.lane));
      return;
    }
    this.renderLanesBar();
    for (const sec of this.sections) for (const col of sec.cols.values()) this.renderColHead(col);
    this.hooks.onLanes?.(this);
  }

  speakerHeader(lane) {
    const info = this.lanes.get(lane) || { lane };
    return speakerEl(this.laneLabel(info), modelLabel(info.agentId, info.model), String(lane).replace('#', ''), info.agentId);
  }

  laneTip(info) {
    if (!info) return '';
    return [
      info.title || `${this.laneLabel(info)} · ${modelLabel(info.agentId, info.model)}`,
      info.role && roleLabel(info.role),
      info.branch && `dal: ${info.branch}`,
      info.worktree && `worktree: ${info.worktree}`,
    ].filter(Boolean).join('\n');
  }

  /** Composer targets for follow-ups: [{ lane, label }] (empty = broadcast only). */
  followUpTargets() {
    const lanes = [...this.lanes.values()];
    let pick = [];
    if (this.mode === 'brainstorm') pick = lanes.filter((l) => l.role === 'moderator' || l.lane === 'moderator');
    else if (this.mode === 'group') return lanes.map((l) => ({ lane: l.lane, label: `${this.laneLabel(l)} (@${l.lane.replace('#', '')})` }));
    else if (this.mode === 'parallel') pick = lanes;
    else if (this.mode === 'team') pick = lanes.filter((l) => ['planner', 'reviewer'].includes(l.role) || ['planner', 'reviewer'].includes(l.lane));
    // lead: '' (default) goes to the lead; a worker lane gets the message directly
    else if (this.mode === 'lead') {
      return lanes.filter((l) => l.role === 'worker')
        .map((l) => ({ lane: l.lane, label: `${this.laneLabel(l)} · ${modelLabel(l.agentId, l.model)} (doğrudan)` }));
    }
    return pick.map((l) => ({ lane: l.lane, label: `${this.laneLabel(l)}${l.role && this.mode !== 'parallel' ? ' (' + roleLabel(l.role) + ')' : ''}` }));
  }

  declareLane(p) {
    const lane = String(p.lane ?? p.agentId ?? '?');
    const info = this.lanes.get(lane) || { lane, state: 'idle', err: false };
    for (const k of ['agentId', 'model', 'role', 'title', 'tier', 'branch', 'worktree']) if (p[k] != null && p[k] !== '') info[k] = p[k];
    if (!info.agentId) info.agentId = lane.split('#')[0];
    this.lanes.set(lane, info);
    this.hooks.onLanes?.(this);
    if (this.single) this.renderLanesBar();
    else {
      this.renderLanesBar();
      for (const sec of this.sections) {
        const col = sec.cols.get(lane);
        if (col) this.renderColHead(col);
      }
    }
    return info;
  }

  renderLanesBar() {
    if (!this.lanesBar) return;
    const chips = [...this.lanes.values()].map((info) => h('button', {
      type: 'button',
      class: `lane-chip st-${info.state}`,
      title: `${this.laneTip(info)}\n${LANE_STATUS[info.state] || info.state}`,
      onclick: () => this.revealLane(info.lane),
    },
    avatarEl(this.laneLabel(info), info.agentId, info.state === 'running'),
    h('span', { class: 'lc-name', text: this.laneLabel(info) }),
    h('span', { class: 'lc-model', text: shortModel(info) }),
    info.role && info.role !== 'worker' && h('span', { class: 'lc-role', text: roleLabel(info.role) }),
    tierBadge(laneTier(info))));
    this.lanesBar.replaceChildren(...chips);
    this.lanesBar.hidden = !chips.length;
  }

  revealLane(lane) {
    if (this.single) {
      const s = [...this.speakers].reverse().find((x) => x.lane === lane);
      s?.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    for (let i = this.sections.length - 1; i >= 0; i--) {
      const col = this.sections[i].cols.get(lane);
      if (col) {
        col.el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
        col.el.classList.remove('flash');
        void col.el.offsetWidth;
        col.el.classList.add('flash');
        return;
      }
    }
  }

  setLaneState(lane, e) {
    const info = this.lanes.get(lane);
    if (!info) return;
    let ns = info.state;
    if (e.type === 'error') { ns = 'error'; info.err = true; }
    else if (e.type === 'status' && e.retry) { ns = 'running'; info.err = false; } // the server retries the turn
    else if (e.type === 'done') { ns = info.err ? 'error' : 'done'; info.err = false; }
    else if (e.type !== 'usage' && !info.err) ns = 'running';
    if (ns !== info.state) {
      info.state = ns;
      this.renderLanesBar();
    }
  }

  // -- sections (multi) ------------------------------------------------------------------------

  newSection(phase) {
    const sec = {
      phase,
      el: h('section', { class: 'sec' }),
      before: h('div', { class: 'sec-full' }),
      after: h('div', { class: 'sec-full' }),
      grid: null,
      cols: new Map(),
    };
    if (phase) sec.el.append(phaseEl(phase.title || phase.id || ''));
    sec.el.append(sec.before, sec.after);
    this.sectionsEl.append(sec.el);
    this.sections.push(sec);
    this.needSection = false;
    if (this.emptyEl) { this.emptyEl.remove(); this.emptyEl = null; }
    return sec;
  }

  curSection() {
    return this.sections[this.sections.length - 1] || this.newSection(null);
  }

  fullWidth(node) {
    const sec = this.curSection();
    (sec.grid ? sec.after : sec.before).append(node);
  }

  laneBlock(lane) {
    // a follow-up without its own phase continues in a fresh section below the user message
    if (this.needSection) this.newSection(null);
    const sec = this.curSection();
    const existing = sec.cols.get(lane);
    if (existing) return existing.block;
    if (!sec.grid) {
      sec.grid = h('div', { class: this.stack ? 'lane-stack' : 'lane-grid' });
      sec.el.insertBefore(sec.grid, sec.after);
    }
    if (!this.lanes.has(lane)) this.declareLane({ lane });
    const block = new Block(this);
    const col = {
      lane,
      block,
      head: h('div', { class: 'lane-head' }),
      foot: h('div', { class: 'lane-foot', hidden: true }),
      el: null,
    };
    col.el = h('div', { class: 'lane-col', dataset: { lane } }, col.head, block.el, col.foot);
    if (this.stack) {
      // folded by default, except the lead / reviewer (their text is the answer)
      const role = this.lanes.get(lane)?.role;
      col.open = role === 'lead' || role === 'reviewer';
      col.el.classList.toggle('folded', !col.open);
      col.prev = h('div', { class: 'lane-prev' });
      col.head.setAttribute('role', 'button');
      col.head.tabIndex = 0;
      const toggle = () => {
        col.open = !col.open;
        col.el.classList.toggle('folded', !col.open);
        col.head.setAttribute('aria-expanded', String(col.open));
      };
      col.head.addEventListener('click', (e) => { if (!e.target.closest('a, button')) toggle(); });
      col.head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      col.head.setAttribute('aria-expanded', String(col.open));
      col.el.insertBefore(col.prev, block.el);
    }
    block.onChange = () => this.renderColHead(col);
    sec.cols.set(lane, col);
    const order = [...this.lanes.keys()];
    [...sec.cols.values()]
      .sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane))
      .forEach((c) => sec.grid.append(c.el));
    sec.grid.style.setProperty('--cols', String(sec.cols.size));
    sec.grid.classList.toggle('single', sec.cols.size === 1);
    this.renderColHead(col);
    return block;
  }

  renderColHead(col) {
    const info = this.lanes.get(col.lane) || { lane: col.lane };
    const st = col.block.state;
    col.el.dataset.state = st;
    col.head.title = this.laneTip(info);
    if (this.stack) {
      fill(col.head,
        icon('chevron', 'lh-chev'),
        avatarEl(this.laneLabel(info), info.agentId, st === 'running' && this.status === 'running'),
        h('span', { class: 'lh-name', text: this.laneLabel(info) }),
        h('span', { class: 'lh-model', text: shortModel(info) }),
        info.role && info.role !== 'worker' && h('span', { class: 'lh-role', text: roleLabel(info.role) }),
        tierBadge(laneTier(info)),
        h('span', { class: `pill st-${st}` }, st === 'running' ? spinner('sm') : h('span', { class: 'dot' }), LANE_STATUS[st] || st));
      this.paintPreview(col);
    } else {
      fill(col.head,
        h('span', { class: 'lh-name', text: this.laneLabel(info) }),
        h('span', { class: 'lh-model', text: modelLabel(info.agentId, info.model) }),
        info.role && h('span', { class: 'lh-role', text: roleLabel(info.role) }),
        h('span', { class: `pill st-${st}` }, st === 'running' ? spinner('sm') : h('span', { class: 'dot' }), LANE_STATUS[st] || st));
    }
    const show = st === 'running' && this.status === 'running';
    col.foot.hidden = !show;
    if (show) col.foot.replaceChildren(spinner('sm'), h('span', { text: col.block.statusText || 'Çalışıyor…' }));
  }

  /** Message transform for a lane: the lead / planner / reviewer's decision blocks are shown by the notes. */
  transformFor(lane) {
    const role = this.lanes.get(String(lane))?.role;
    if ((this.mode === 'lead' || this.mode === 'team') && ['lead', 'planner', 'reviewer'].includes(role)) return hideDecisionJson;
    return this.msgTransform;
  }

  /** The folded card's one-line preview: what the agent is doing now, or its summary. */
  paintPreview(col) {
    if (!col.prev) return;
    const running = col.block.state === 'running' && this.status === 'running';
    const text = (running && col.block.statusText) || col.block.preview || (running ? 'Çalışıyor…' : '');
    if (col.prev.textContent !== text) col.prev.textContent = text;
  }

  allBlocks() {
    if (this.single) return [this.chat];
    return this.sections.flatMap((s) => [...s.cols.values()].map((c) => c.block));
  }

  // -- events ----------------------------------------------------------------------------------

  ingest(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (typeof ev.seq === 'number') {
      if (ev.seq <= this.lastSeq) return;
      this.lastSeq = ev.seq;
    }
    try {
      this.apply(ev);
    } catch (err) {
      console.error('Olay işlenemedi', ev, err);
    }
    this.schedule();
  }

  apply(ev) {
    switch (ev.kind) {
      case 'run': this.setStatus(ev.status, ev.error, ev.ts); break;
      case 'lane': this.declareLane(ev); break;
      case 'phase': this.onPhase(ev); break;
      case 'user': this.onUser(ev); break;
      case 'agent': this.onAgent(ev); break;
      case 'diff': this.onDiff(ev); break;
      case 'checkpoint': this.onCheckpoint(ev); break;
      case 'undo': this.onUndo(ev); break;
      case 'note': this.place(noteEl(ev.text, ev.level)); break;
      case 'result': this.place(this.resultEl(ev)); break;
      default: break;
    }
  }

  /** Append a full-width item (note, result, user message). Streaming messages stay open. */
  place(node) {
    if (this.single) this.chat.push(node);
    else this.fullWidth(node);
  }

  onPhase(ev) {
    if (this.single) {
      this.chat.pushFull(phaseEl(ev.title || ev.id || ''));
      return;
    }
    const cur = this.sections[this.sections.length - 1];
    if (cur && cur.phase && ev.id != null && cur.phase.id === ev.id) return;
    for (const b of this.allBlocks()) b.boundary();
    for (const info of this.lanes.values()) info.err = false;
    this.newSection({ id: ev.id, title: ev.title });
  }

  onUser(ev) {
    const text = String(ev.text ?? '');
    const first = !this.promptSeen;
    this.promptSeen = true;
    const files = Array.isArray(ev.files) ? ev.files : [];
    if (first && (this.prompt || this.promptFiles.length || this.promptImages.length) && text.trim() === this.prompt.trim()) return; // already shown from config
    for (const b of this.allBlocks()) b.boundary();
    for (const info of this.lanes.values()) info.err = false;
    const target = ev.lane != null ? this.laneLabel(this.lanes.get(String(ev.lane)) || { lane: String(ev.lane) }) : null;
    this.stick = true;
    this.lastSpeaker = null;
    this.place(userEl(text, target, files, Array.isArray(ev.images) ? ev.images : []));
    if (!this.single && this.sections.some((sec) => sec.grid)) this.needSection = true;
  }

  onAgent(ev) {
    const lane = String(ev.lane ?? '?');
    if (!this.lanes.has(lane)) this.declareLane({ lane });
    const e = ev.event && typeof ev.event === 'object' ? ev.event : {};
    if (typeof e.type !== 'string') return;
    if (this.mode === 'group' && lane !== this.lastSpeaker && e.type !== 'usage') {
      this.lastSpeaker = lane;
      const el = this.chat.pushFull(this.speakerHeader(lane));
      this.speakers.push({ lane, el });
    }
    const block = this.single ? this.chat : this.laneBlock(lane);
    block.agent(lane, e, ev.ts);
    this.setLaneState(lane, e);
  }

  onDiff(ev) {
    const lane = ev.lane != null ? String(ev.lane) : null;
    const node = this.diffEl(ev, lane);
    if (this.single || lane == null) { this.place(node); return; }
    const block = this.laneBlock(lane);
    block.pushFull(node);
  }

  /** Files Ortak changed for a text-only agent in one turn, with a "Geri al" button (POST /undo). */
  onCheckpoint(ev) {
    const lane = ev.lane != null ? String(ev.lane) : null;
    const files = Array.isArray(ev.files) ? ev.files : [];
    const names = files.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
    const btn = h('button', { type: 'button', class: 'btn btn-sm cp-btn', title: 'Bu turda Ortak\'ın yaptığı dosya değişikliklerini geri al' }, icon('undo'), 'Geri al');
    const status = h('span', { class: 'cp-status' });
    const el = h('div', { class: 'checkpoint' },
      icon('file'),
      h('span', { class: 'cp-text', title: names.join('\n') },
        `${names.length} dosya değişti: `, h('span', { class: 'cp-files', text: names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '') })),
      status, btn);
    (this.cps ||= new Map()).set(String(ev.id), { el, btn, status });
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (this.status === 'running') { toast('Çalışma sürüyor; geri almak için bitmesini bekleyin.', 'info'); return; }
      btn.disabled = true;
      btn.replaceChildren(spinner('sm'), 'Geri alınıyor…');
      try {
        const r = await api(`/api/runs/${enc(this.id)}/undo`, { method: 'POST', body: { checkpoint: ev.id }, quiet: true });
        this.onUndo({ checkpoint: ev.id, restored: r.restored, conflicts: r.conflicts });
        toast(r.conflicts?.length ? `${r.restored.length} dosya geri alındı, ${r.conflicts.length} dosya sonradan değiştiği için atlandı.` : 'Değişiklikler geri alındı.', r.conflicts?.length ? 'info' : 'success');
      } catch (err) {
        btn.disabled = false;
        btn.replaceChildren(icon('undo'), 'Geri al');
        toast(err.message, 'error');
      }
    });
    if (this.single || lane == null) this.place(el);
    else this.laneBlock(lane).pushFull(el);
  }

  onUndo(ev) {
    const cp = this.cps?.get(String(ev.checkpoint));
    if (!cp || cp.done) return;
    cp.done = true;
    cp.btn.disabled = true;
    cp.btn.replaceChildren(icon('check'), 'Geri alındı');
    cp.el.classList.add('undone');
    const conflicts = Array.isArray(ev.conflicts) ? ev.conflicts : [];
    if (conflicts.length) {
      cp.status.textContent = `Atlanan: ${conflicts.map((c) => c.path).join(', ')} (sonradan değişti)`;
      cp.status.title = conflicts.map((c) => `${c.path}: ${c.reason}`).join('\n');
    }
  }

  /** Lanes already applied to the real cwd (meta.applied: string | string[] | {lane} | {[lane]: …}). */
  appliedLanes() {
    const a = this.meta.applied;
    const out = new Set();
    const addOne = (x) => {
      if (typeof x === 'string') out.add(x);
      else if (x && typeof x === 'object' && x.lane != null) out.add(String(x.lane));
    };
    if (Array.isArray(a)) a.forEach(addOne);
    else if (typeof a === 'string' || (a && typeof a === 'object' && a.lane != null)) addOne(a);
    else if (a && typeof a === 'object') Object.keys(a).forEach((k) => { if (a[k]) out.add(k); });
    return out;
  }

  diffEl(ev, lane) {
    const wrap = h('div', { class: 'lane-diff' }, renderDiff(ev.diff, ev.stats));
    if (ev.truncated) {
      wrap.append(h('div', { class: 'diff-trunc' }, icon('info'), 'Diff çok büyük olduğu için kısaltıldı; tamamı ajanın çalışma klasöründe.'));
    }
    const has = Number(ev.stats?.files) > 0 || /\S/.test(String(ev.diff || ''));
    const applicable = ev.applicable === true || (ev.applicable === undefined && this.mode === 'parallel');
    if (!applicable || lane == null || !has) return wrap;

    const out = h('pre', { class: 'apply-out', hidden: true });
    const label = () => [icon('check'), 'Bunu uygula'];
    const btn = h('button', { type: 'button', class: 'btn btn-primary btn-sm apply-btn' }, ...label());
    const markApplied = () => {
      btn.disabled = true;
      btn.classList.add('applied');
      btn.replaceChildren(icon('check'), 'Uygulandı');
    };
    if (this.appliedLanes().has(lane)) markApplied();
    let armed = 0;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (!armed) {
        btn.classList.add('armed');
        btn.replaceChildren(icon('warn'), 'Onayla: ana klasöre uygula');
        armed = setTimeout(() => { armed = 0; btn.classList.remove('armed'); btn.replaceChildren(...label()); }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      btn.classList.remove('armed');
      btn.disabled = true;
      btn.replaceChildren(spinner('sm'), 'Uygulanıyor…');
      try {
        const r = await api(`/api/runs/${enc(this.id)}/apply`, { method: 'POST', body: { lane }, quiet: true });
        out.hidden = false;
        out.classList.remove('err');
        out.textContent = (r && typeof r.output === 'string' && r.output.trim()) || 'Değişiklikler uygulandı.';
        markApplied();
        const prev = this.meta.applied;
        this.meta.applied = Array.isArray(prev) ? [...prev, lane] : prev ? [prev, lane] : [lane];
        toast(`${this.laneLabel(this.lanes.get(lane))} değişiklikleri proje klasörüne uygulandı.`, 'success');
      } catch (err) {
        const d = err.data && typeof err.data === 'object' ? err.data : {};
        const lines = [err.message];
        // 409: { error, ok:false, conflicts: boolean | string[], output }
        if (Array.isArray(d.conflicts) && d.conflicts.length) {
          lines.push('', 'Çakışan dosyalar:');
          for (const c of d.conflicts) lines.push(`  • ${typeof c === 'string' ? c : c?.path || c?.file || JSON.stringify(c)}`);
        }
        if (typeof d.output === 'string' && d.output.trim()) lines.push('', d.output.trim());
        out.hidden = false;
        out.classList.add('err');
        out.textContent = lines.join('\n');
        if (d.conflicts === true || (Array.isArray(d.conflicts) && d.conflicts.length)) {
          // applied with conflict markers: the working tree changed, don't offer a blind retry
          btn.classList.add('conflict');
          btn.replaceChildren(icon('warn'), 'Çakışmalarla uygulandı');
        } else {
          btn.disabled = false;
          btn.replaceChildren(icon('refresh'), 'Tekrar dene');
        }
        toast(err.message, 'error');
      }
    });
    wrap.append(h('div', { class: 'apply-row' }, btn, h('span', { class: 'apply-hint', text: 'Bu ajanın değişikliklerini ana proje klasörünüze uygular.' })), out);
    return wrap;
  }

  resultEl(ev) {
    const info = ev.lane != null ? this.lanes.get(String(ev.lane)) : null;
    const msg = new Msg('result-md');
    msg.text = String(ev.text ?? '');
    msg.render();
    const copy = h('button', {
      type: 'button',
      class: 'btn btn-ghost btn-xs',
      title: 'Metni kopyala',
      onclick: async () => { if (await copyText(msg.text)) toast('Kopyalandı', 'success', 1500); },
    }, icon('copy'), 'Kopyala');
    return h('div', { class: 'result-card' },
      h('div', { class: 'rc-head' },
        icon('sparkle'),
        h('span', { class: 'rc-title', text: this.mode === 'brainstorm' ? 'Sentez' : 'Sonuç' }),
        info && h('span', { class: 'rc-by', text: `${this.laneLabel(info)}${info.role ? ' · ' + roleLabel(info.role) : ''}` }),
        copy),
      msg.el);
  }

  setStatus(status, error, ts) {
    if (!status) return;
    const prev = this.status;
    this.status = status;
    this.error = error || '';
    if (status === 'running') {
      if (prev !== 'running' || !this.runningSince) this.runningSince = ts || Date.now();
    } else {
      const fin = status === 'waiting' || status === 'done' ? 'done' : 'cancelled';
      for (const b of this.allBlocks()) b.finish(fin);
      let changed = false;
      for (const info of this.lanes.values()) {
        if (info.state === 'running') { info.state = fin; changed = true; }
      }
      if (changed) this.renderLanesBar();
      if (status === 'error' && prev !== 'error') this.place(noteEl(`Çalışma hata ile sonlandı${error ? ': ' + error : '.'}`, 'error'));
      if (status === 'cancelled' && prev !== 'cancelled') this.place(noteEl('Çalışma durduruldu.', 'warn'));
    }
    if (!this.single) for (const s of this.sections) for (const c of s.cols.values()) this.renderColHead(c);
    if (this.emptyEl && status !== 'running') this.emptyEl.replaceChildren(status === 'error' ? 'Çalışma başlatılamadı.' : 'Henüz çıktı yok.');
    this.syncTimer();
    this.updateStatusLine();
    this.hooks.onStatus?.(this);
  }

  setConnection(state) {
    this.connEl.hidden = state !== 'retry';
  }

  // -- rendering -------------------------------------------------------------------------------

  dirty(msg) {
    this.dirtySet.add(msg);
    this.schedule();
  }

  // Streaming text is re-rendered as Markdown from scratch, so it is throttled: at most every
  // 50 ms (longer for very long messages), and only every 2 s while the window is in the
  // background. A timer, not rAF: rAF never fires in a hidden tab.
  schedule() {
    if (this.flushTimer) return;
    const gap = document.hidden ? 2000 : this.renderGap();
    const wait = Math.max(16, this.lastFlush + gap - performance.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  renderGap() {
    let longest = 0;
    for (const m of this.dirtySet) longest = Math.max(longest, m.text?.length || 0);
    return longest < 4000 ? 50 : Math.min(400, longest / 50);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    this.lastFlush = performance.now();
    for (const m of this.dirtySet) m.render();
    this.dirtySet.clear();
    if (this.stack) for (const sec of this.sections) for (const c of sec.cols.values()) this.paintPreview(c);
    this.updateStatusLine();
    if (this.stick) this.scrollBottom(false);
  }

  scrollBottom(smooth) {
    const s = this.scroller;
    if (smooth) s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
    else s.scrollTop = s.scrollHeight;
    this.stick = true;
    this.jumpBtn.hidden = true;
  }

  syncTimer() {
    const want = this.status === 'running' && this.single;
    if (want && !this.tick) this.tick = setInterval(() => this.updateStatusLine(), 1000);
    if (!want && this.tick) { clearInterval(this.tick); this.tick = 0; }
  }

  updateStatusLine() {
    if (!this.statusLine) return;
    const show = this.status === 'running';
    this.statusLine.hidden = !show;
    if (!show) return;
    const who = this.mode === 'group' && this.lastSpeaker ? this.laneLabel(this.lanes.get(this.lastSpeaker)) : '';
    this.statusLine.querySelector('.sl-text').textContent = this.chat.statusText || (who ? `${who} yazıyor…` : 'Çalışıyor…');
    this.statusLine.querySelector('.sl-time').textContent = fmtDuration(Math.max(0, Date.now() - this.runningSince)).replace(/,\d sn$/, ' sn');
  }
}

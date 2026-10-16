// Gemini (web) adapter: drives gemini.google.com in Ortak's own Chrome window (see cdp.js), so the
// models of the user's Gemini app subscription — e.g. 4 Argon — can join Ortak. See CONTRACT §1.
//
// Why a browser: the Gemini desktop app is a wrapper around gemini.google.com with no local API
// (and it blocks remote debugging), and Gemini CLI no longer accepts personal Google accounts.
//
// How a turn works: one shared tab, one turn at a time (a mutex). Open the conversation
// (gemini.google.com/app[/<id>]), pick the model in the page's mode menu, type the prompt with
// Input.insertText, press Enter, then poll the last <model-response> and stream its text. The
// conversation id in the URL is the sessionId, so follow-ups continue the same Gemini chat (it also
// shows up in the user's Gemini history).
//
// Text only: Gemini web cannot touch the user's files, so it is limited to read-only roles
// (capabilities.edit = false) and its "permission" is inherently enforced (sandbox = true).
//
// The page's DOM is not a public API: Google can change it at any time. Selectors are kept in one
// place (SEL) and every failure turns into a short Turkish error.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AbortError, truncate } from './base.js';
import { activePort, launchBrowser, closeBrowser, openSignInWindow, listPages, Page, PROFILE, START_URL, sleep } from './cdp.js';
import { getSettings, onSettingsChange } from '../settings.js';

const NOT_RUNNING = "Gemini penceresi kapalı: Ajanlar ve API'ler penceresinde Gemini için Başlat'a basın (ilk seferde Google ile giriş yapmanız gerekir).";
const SIGNED_OUT = "Gemini'de oturum açık değil: açılan pencerede Google hesabınızla giriş yapın, pencereyi kapatın ve Başlat'a tekrar basın.";
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 600;
const BULK_TEXT = 3000; // longer messages are put into the editor at once (pageSetEditorText)
const textLength = (t) => t.replace(/\n/g, '').length; // what the editor's textContent holds

const SEL = {
  editor: 'rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]',
  modeButton: '[data-test-id="bard-mode-menu-button"]',
  modeMenu: '[data-test-id="bard-mode-desktop-gem-menu"]',
  response: 'model-response',
  responseBody: 'message-content .markdown, .markdown',
  sendButton: '.send-button button, button[aria-label="Mesaj gönder"], button[aria-label="Send message"]',
};

// Model ids → how to find them in the mode menu. `level` = the menu's thinking-level item.
const MODELS = [
  { id: 'default', label: 'Pencerede seçili olan', default: true },
  { id: 'argon-high', label: '4 Argon · Yüksek düşünme', model: /argon/i, level: /yüksek|high/i },
  { id: 'argon-medium', label: '4 Argon · Orta düşünme', model: /argon/i, level: /orta|medium/i },
  { id: 'argon-low', label: '4 Argon · Düşük düşünme', model: /argon/i, level: /düşük|low/i },
  { id: 'pro', label: '3.1 Pro', model: /\bpro\b/i },
  { id: 'flash', label: '3.8 Flash', model: /flash(?!-lite)/i },
  { id: 'flash-lite', label: '3.5 Flash-Lite — en hızlı', model: /flash-lite/i },
];

const LEVEL_SECTION = /düşünme düzeyi|thinking/i; // menu entry that expands the thinking levels

const systemBySession = new Map(); // conversation id → system text already sent
let queue = Promise.resolve();      // one turn at a time in the shared tab

// ---- sleep / idle close ----------------------------------------------------------------------
// The window is closed after `geminiIdleMinutes` without a turn and reopened (minimized) by the
// next turn. A marker in the profile remembers that the user signed in, so a closed window still
// counts as "available (asleep)" instead of asking the user to press Başlat.
const SIGNED_IN_MARK = path.join(PROFILE, '.ortak-signed-in');
let pendingTurns = 0;
let lastActivity = Date.now();
let idleTimer = null;

function markSignedIn(yes) {
  try {
    if (yes) { if (!existsSync(SIGNED_IN_MARK)) writeFileSync(SIGNED_IN_MARK, new Date().toISOString()); }
    else unlinkSync(SIGNED_IN_MARK);
  } catch { /* best effort */ }
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const mins = getSettings().geminiIdleMinutes;
  if (!mins) return;
  const due = lastActivity + mins * 60000 - Date.now();
  idleTimer = setTimeout(closeIfIdle, Math.max(5000, due));
  idleTimer.unref?.();
}

async function closeIfIdle() {
  idleTimer = null;
  const mins = getSettings().geminiIdleMinutes;
  if (!mins || pendingTurns > 0) return;
  if (Date.now() - lastActivity < mins * 60000) return scheduleIdleClose();
  if (await activePort()) {
    await closeBrowser().catch(() => {});
    console.log('[gemini] pencere boşta kaldığı için kapatıldı (sonraki turda yeniden açılır)');
  }
}

onSettingsChange(scheduleIdleClose);
scheduleIdleClose(); // also covers a window left open from before a server restart

// ---- page health -----------------------------------------------------------------------------
// Ortak drives a web page, so Google changing it (or Gemini failing repeatedly) shows up here first.
// detect() turns this into a warning under Gemini in the Ajanlar ve API'ler dialog; a good turn clears it.
const health = { fails: 0, last: '', pageChanged: false, pageError: false };
const PAGE_CHANGED = /bulunamadı|yüklenemedi|kabul etmedi/i;

function noteSuccess() {
  Object.assign(health, { fails: 0, last: '', pageChanged: false, pageError: false });
}

function noteFailure(message) {
  health.fails += 1;
  health.last = truncate(String(message || ''), 200);
  health.pageChanged = PAGE_CHANGED.test(health.last);
  health.pageError = /^Gemini: /.test(health.last);
}

/** Turkish warning for the Ajanlar ve API'ler dialog, or null while things work. */
export function healthWarning() {
  if (!health.last) return null;
  if (health.pageChanged) return `Gemini sayfası değişmiş olabilir (${health.last}). Sorun sürerse Ortak'ın Gemini köprüsünün güncellenmesi gerekir.`;
  if (health.pageError) return `Gemini sayfada hata gösterdi: ${health.last.replace(/^Gemini: /, '')}`;
  if (health.fails >= 2) return `Gemini son ${health.fails} denemede başarısız oldu (son hata: ${health.last}). Pencereyi kontrol edin; gerekirse kapatıp Başlat'a basın.`;
  return null;
}

function withLock(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------------------------
// Page helpers (functions below run inside the page via Page.eval; keep them self-contained)
// ---------------------------------------------------------------------------------------------

/** DOM → Markdown for one answer (paragraphs, headings, lists, code, tables, links, emphasis). */
function pageReadAnswer(sel) {
  const resp = [...document.querySelectorAll(sel.response)];
  const last = resp.at(-1);
  if (!last) return { count: 0 };
  const body = last.querySelector(sel.responseBody);
  const md = (node, ctx = { list: [] }) => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const kids = () => [...node.childNodes].map((c) => md(c, ctx)).join('');
    if (/^(button|mat-icon|svg|style|script|sources-carousel-inline|source-footnote|sup)$/.test(tag)) return '';
    if (node.classList?.contains('code-block-decoration')) return '';
    switch (tag) {
      case 'p': return `${kids().trim()}\n\n`;
      case 'br': return '\n';
      case 'hr': return '\n---\n\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return `${'#'.repeat(+tag[1])} ${kids().trim()}\n\n`;
      case 'strong': case 'b': { const t = kids(); return t.trim() ? `**${t.trim()}**` : t; }
      case 'em': case 'i': { const t = kids(); return t.trim() ? `*${t.trim()}*` : t; }
      case 'code': return node.closest('pre') ? node.textContent : `\`${node.textContent}\``;
      case 'pre': {
        const lang = node.closest('code-block')?.querySelector('.code-block-decoration span')?.textContent.trim().toLowerCase() || '';
        return `\n\`\`\`${lang}\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
      }
      case 'a': { const t = kids().trim(); const h = node.getAttribute('href'); return h && /^https?:/.test(h) ? `[${t || h}](${h})` : t; }
      case 'ul': case 'ol': {
        ctx.list.push({ ordered: tag === 'ol', n: 0 });
        const out = [...node.children].map((c) => md(c, ctx)).join('');
        ctx.list.pop();
        return ctx.list.length ? `\n${out}` : `${out}\n`;
      }
      case 'li': {
        const l = ctx.list.at(-1) || { ordered: false, n: 0 };
        l.n += 1;
        const pad = '  '.repeat(Math.max(0, ctx.list.length - 1));
        return `${pad}${l.ordered ? `${l.n}.` : '-'} ${kids().trim().replace(/\n{2,}/g, '\n')}\n`;
      }
      case 'blockquote': return kids().trim().split('\n').map((x) => `> ${x}`).join('\n') + '\n\n';
      case 'table': {
        const rows = [...node.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => md(td, ctx).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
        if (!rows.length) return '';
        const head = `| ${rows[0].join(' | ')} |\n| ${rows[0].map(() => '---').join(' | ')} |\n`;
        return `\n${head}${rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n')}\n\n`;
      }
      default: return kids();
    }
  };
  const text = body ? md(body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  const busy = body?.getAttribute('aria-busy') === 'true';
  // While generating, the send button turns into a stop button.
  const stop = [...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && (/stop/.test(b.className) || /durdur|stop/i.test(b.getAttribute('aria-label') || '')));
  const actions = last.querySelectorAll('message-actions button, .response-footer button, [data-test-id*="copy"]').length;
  const error = document.querySelector('snack-bar-container, .mat-mdc-snack-bar-label, [data-test-id="error-message"]')?.textContent.trim() || '';
  return { count: resp.length, text, busy, stop, actions, error, url: location.href };
}

function pageState(sel) {
  return {
    url: location.href,
    signedOut: /accounts\.google\.com/.test(location.href) || !!document.querySelector('a[href*="ServiceLogin"]'),
    editor: !!document.querySelector(sel.editor),
    responses: document.querySelectorAll(sel.response).length,
    mode: document.querySelector(sel.modeButton)?.getAttribute('aria-label') || '',
  };
}

// Clicks are DOM clicks (element.click()), not synthesized mouse events: the window usually sits
// minimized, and Chrome drops mouse/keyboard input for a minimized window.

/**
 * The mode-menu item whose text matches `pattern` (a RegExp source); clicks it when `click` and
 * it isn't selected yet. Returns its state, `{ collapsed }` for a hidden item (thinking levels
 * before "Düşünme düzeyi" is expanded), `{ missing, options }` or null (menu not open).
 */
function pageMenuItem(sel, pattern, flags, click) {
  const re = new RegExp(pattern, flags);
  const menu = document.querySelector(sel.modeMenu);
  if (!menu) return null;
  const item = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((e) => re.test(e.innerText));
  if (!item) return { missing: true, options: [...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.innerText.split('\n')[0].trim()) };
  const r = item.getBoundingClientRect();
  if (!r.width || !r.height) return { collapsed: true };
  const info = { selected: item.classList.contains('selected'), disabled: item.getAttribute('aria-disabled') === 'true', text: item.innerText.split('\n')[0].trim() };
  if (click && !info.selected && !info.disabled) item.click();
  return info;
}

/**
 * The page has a Sohbet/Görev (Chat/Task) toggle above the input. Görev starts a long-running
 * cloud task (Gemini Spark: Google apps, browsing) instead of answering, so Ortak always uses
 * Sohbet. Returns true when Sohbet is (now) selected or there is no toggle.
 */
function pageEnsureChat() {
  const items = [...document.querySelectorAll('.gem-segmented-button-action')];
  const chat = items.find((b) => /^(sohbet|chat)$/i.test(b.innerText.trim()));
  if (!chat) return true;
  if (chat.parentElement?.classList.contains('gem-segmented-button-select')) return true;
  chat.click();
  return false;
}

function pageClick(selector) {
  const el = document.querySelector(selector);
  if (el) el.click();
  return !!el;
}

function pageCloseMenu() {
  document.querySelector('.cdk-overlay-backdrop')?.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

function pageStop() {
  const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && (/stop/.test(x.className) || /durdur|stop/i.test(x.getAttribute('aria-label') || '')));
  if (b) b.click();
  return !!b;
}

/** Puts the caret in the prompt box. */
function pageFocusEditor(sel) {
  const e = document.querySelector(sel.editor);
  if (!e) return false;
  e.focus();
  return true;
}

/**
 * Replaces the editor's content with `text` as Quill paragraphs (`<p>`, `<p><br></p>` for blank
 * lines). Input.insertText types character by character and needs minutes for 100k+ chars
 * (file contents); building the DOM takes ~2 s and Quill picks it up through its observer.
 * The page enforces TrustedHTML, hence nodes instead of innerHTML. Returns the editor's length.
 */
function pageSetEditorText(sel, text) {
  const e = document.querySelector(sel.editor);
  if (!e) return -1;
  e.focus();
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    const p = document.createElement('p');
    if (line) p.textContent = line; else p.append(document.createElement('br'));
    frag.append(p);
  }
  e.replaceChildren(frag);
  e.dispatchEvent(new InputEvent('input', { bubbles: true }));
  return e.textContent.length;
}

/**
 * Pastes image files into the input box (a synthetic paste with a DataTransfer of Files — what
 * Ctrl+V does). Works in a minimized window, unlike the upload menu. `files` = [{ name, mime, b64 }].
 */
function pagePasteImages(sel, files) {
  const e = document.querySelector(sel.editor);
  if (!e) return -1;
  e.focus();
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.mime }));
  }
  e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return files.length;
}

/** { count, busy } of the attachment previews in the input box. */
function pageImagePreviews() {
  const previews = [...document.querySelectorAll('uploader-file-preview, gem-media-attachment')];
  const busy = previews.some((p) => p.querySelector('mat-progress-spinner, mat-spinner, [role="progressbar"], [aria-busy="true"], .loading'));
  return { count: document.querySelectorAll('uploader-file-preview').length || previews.length, busy };
}

/** Puts the user's images into the message and waits until Gemini has uploaded them. */
async function attachImages(page, images, emit, signal) {
  emit({ type: 'status', text: `Resimler ekleniyor (${images.length})…` });
  const files = [];
  for (const img of images) {
    try { files.push({ name: img.name, mime: img.mime, b64: readFileSync(img.path).toString('base64') }); } catch { /* deleted meanwhile */ }
  }
  if (!files.length) return;
  const before = (await page.eval(pageImagePreviews)).count;
  if ((await page.eval(pagePasteImages, SEL, files)) < 0) throw new Error('Gemini yazı kutusu bulunamadı.');
  const deadline = Date.now() + 90_000;
  let settled = 0;
  for (;;) {
    await sleep(500, signal);
    const st = await page.eval(pageImagePreviews);
    if (st.count >= before + files.length && !st.busy) { if (++settled >= 3) return; } else settled = 0;
    if (Date.now() > deadline) throw new Error(`Gemini resimleri kabul etmedi (${st.count - before}/${files.length} eklendi).`);
  }
}

/** Characters in the editor (0 once Gemini took the message); -1 without an editor. */
function pageEditorLength(sel) {
  const e = document.querySelector(sel.editor);
  return e ? e.textContent.trim().length : -1;
}

/** Empties the editor (a failed earlier turn may have left half-typed text in it). */
function pageClearEditor(sel) {
  const e = document.querySelector(sel.editor);
  if (!e) return false;
  if (e.textContent.length) {
    const p = document.createElement('p');
    p.append(document.createElement('br'));
    e.replaceChildren(p);
    e.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  return true;
}

/** Clicks send. Falls back to false (caller presses Enter) if the button isn't found. */
function pageSend(sel) {
  const b = document.querySelector(sel.sendButton);
  if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
  b.click();
  return true;
}

// ---------------------------------------------------------------------------------------------

async function key(page, keyName, code, vk, text) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk });
}

/** Connects to the bridge's Gemini tab (launching the window if needed). */
async function openPage({ launch = true, minimized = false } = {}) {
  let port = await activePort();
  if (!port) {
    if (!launch) return null;
    port = await launchBrowser({ minimized });
  }
  const pages = await listPages(port);
  const target = pages.find((p) => p.url.includes('gemini.google.com')) || pages.find((p) => p.url.includes('accounts.google.com')) || pages[0];
  if (!target) throw new Error(NOT_RUNNING);
  const page = await Page.connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable').catch(() => {});
  return page;
}

async function waitFor(page, pred, { timeoutMs = 20000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.eval(pageState, SEL).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(300, signal);
  }
  return last;
}

async function navigate(page, url, signal) {
  await page.send('Page.navigate', { url });
  await sleep(800, signal);
  const st = await waitFor(page, (s) => s.signedOut || (s.editor && s.url.startsWith(url.replace(/\/$/, ''))), { signal });
  if (st?.signedOut) { markSignedIn(false); throw Object.assign(new Error(SIGNED_OUT), { signedOut: true }); }
  if (st?.editor) markSignedIn(true);
  if (!st?.editor) throw new Error('Gemini sayfası yüklenemedi (yazı kutusu bulunamadı). Sayfa değişmiş olabilir.');
  return st;
}

async function selectModel(page, spec, signal) {
  // The mode button renders a moment after the input box.
  await waitFor(page, (s) => !!s.mode, { timeoutMs: 10000, signal });
  const openMenu = async () => {
    if (!(await page.eval(pageClick, SEL.modeButton))) throw new Error('Gemini model seçicisi bulunamadı.');
    await sleep(700, signal);
  };
  const find = (re, click) => page.eval(pageMenuItem, SEL, re.source, re.flags, click);
  const pick = async (re, what) => {
    let item = await find(re, false);
    if (!item) { await openMenu(); item = await find(re, false); }
    if (item?.collapsed) {
      const section = await find(LEVEL_SECTION, true);
      if (section && !section.missing && !section.collapsed) await sleep(600, signal);
      item = await find(re, false);
    }
    if (!item || item.missing || item.collapsed) {
      await page.eval(pageCloseMenu);
      const opts = item?.options?.length ? ` Mevcut seçenekler: ${item.options.join(', ')}.` : '';
      throw new Error(`Gemini'de ${what} bulunamadı.${opts}`);
    }
    if (item.disabled) {
      await page.eval(pageCloseMenu);
      throw new Error(`Gemini'de ${item.text} bu hesapta kullanılamıyor.`);
    }
    if (!item.selected) { await find(re, true); await sleep(700, signal); }
  };
  await openMenu();
  await pick(spec.model, `${spec.label.split(' · ')[0]} modeli`);
  if (spec.level) await pick(spec.level, 'düşünme düzeyi');
  // Close whatever is still open.
  if (await page.eval((s) => !!document.querySelector(s.modeMenu), SEL)) await page.eval(pageCloseMenu);
  await sleep(300, signal);
  return (await page.eval(pageState, SEL)).mode;
}

const conversationId = (url) => (/\/app\/([0-9a-f]{8,})/i.exec(url || '') || [])[1] || null;

async function turn({ prompt, model, sessionId, system, images = [], signal, onEvent }) {
  const emit = (e) => { try { onEvent(e); } catch { /* listener error */ } };
  if (sessionId && !/^[0-9a-f]{8,}$/i.test(sessionId)) throw new Error('Geçersiz Gemini oturum kimliği.');
  const spec = MODELS.find((m) => m.id === (model || 'default')) || MODELS[0];

  emit({ type: 'status', text: 'Gemini penceresi hazırlanıyor…' });
  let page;
  try {
    page = await openPage({ minimized: true });
  } catch (err) {
    throw new Error(err.message || NOT_RUNNING);
  }
  const onAbort = async () => {
    // Stop the generation in the page, like the user pressing "stop".
    try { await page.eval(pageStop); } catch { /* page gone */ }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await navigate(page, sessionId ? `${START_URL}/${sessionId}` : START_URL, signal);
    if (!(await page.eval(pageEnsureChat))) await sleep(600, signal);
    if (spec.model) {
      emit({ type: 'status', text: `Model seçiliyor: ${spec.label}` });
      let mode;
      try {
        mode = await selectModel(page, spec, signal);
      } catch (err) {
        // The menu sometimes renders late or collapses the levels: one more try from scratch.
        if (/kullanılamıyor/.test(err.message)) throw err;
        await page.eval(pageCloseMenu).catch(() => {});
        await sleep(1200, signal);
        mode = await selectModel(page, spec, signal);
      }
      if (mode) emit({ type: 'status', text: mode.replace(/^.*şu anda\s*/i, 'Mod: ').replace(/\s*modunda$/i, '') });
    }

    let text = String(prompt ?? '');
    if (system && (!sessionId || systemBySession.get(sessionId) !== system)) {
      text = `[Talimatlar]\n${system}\n[/Talimatlar]\n\n${text}`;
    }

    const before = await page.eval(pageReadAnswer, SEL);
    if (!(await page.eval(pageClearEditor, SEL))) throw new Error('Gemini yazı kutusu bulunamadı.');
    if (images.length) await attachImages(page, images, emit, signal);
    await page.eval(pageFocusEditor, SEL);
    let filled = false;
    if (text.length > BULK_TEXT) {
      emit({ type: 'status', text: `Mesaj yazılıyor (${Math.round(text.length / 1000)} bin karakter)…` });
      const typed = textLength(text);
      const got = await page.eval(pageSetEditorText, SEL, text).catch(() => -1);
      filled = got >= typed * 0.98;
      if (!filled) await page.eval(pageClearEditor, SEL).catch(() => {});
      await sleep(1200, signal); // let Quill sync before sending
    }
    const typeIt = () => page.send('Input.insertText', { text }, Math.max(30_000, text.length * 2));
    if (!filled) await typeIt();
    await sleep(400, signal);
    // Sent = the editor emptied. Quill occasionally misses a DOM fill (the click then does nothing):
    // try Enter, then type the text the slow way and send again.
    const sent = async () => {
      for (let i = 0; i < 8; i++) {
        await sleep(400, signal);
        const n = await page.eval(pageEditorLength, SEL).catch(() => 0);
        if (n === 0) return true;
      }
      return false;
    };
    // The send button stays disabled while attached images upload: wait for it (clicking or
    // pressing Enter earlier is silently ignored by Gemini).
    let clicked = false;
    for (let i = 0, n = images.length ? 120 : 6; i < n && !clicked; i++) {
      clicked = await page.eval(pageSend, SEL);
      if (!clicked) await sleep(500, signal);
    }
    if (!clicked) await key(page, 'Enter', 'Enter', 13, '\r');
    if (!(await sent())) {
      if (!(await page.eval(pageSend, SEL))) await key(page, 'Enter', 'Enter', 13, '\r');
      if (!(await sent()) && filled) {
        emit({ type: 'status', text: 'Mesaj yeniden yazılıyor…' });
        await page.eval(pageClearEditor, SEL);
        await page.eval(pageFocusEditor, SEL);
        await typeIt();
        await sleep(400, signal);
        if (!(await page.eval(pageSend, SEL))) await key(page, 'Enter', 'Enter', 13, '\r');
      }
    }
    emit({ type: 'status', text: 'Gemini düşünüyor…' });

    // Wait for a new answer, stream it, stop when the page is idle and the text has settled.
    const started = Date.now();
    let shown = '';
    let stable = 0;
    let sawNew = false;
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      if (Date.now() - started > TURN_TIMEOUT_MS) throw new Error('Gemini zamanında cevap vermedi.');
      await sleep(POLL_MS, signal);
      const s = await page.eval(pageReadAnswer, SEL);
      if (/accounts\.google\.com/.test(s.url || '')) throw Object.assign(new Error(SIGNED_OUT), { signedOut: true });
      if (s.count > before.count) sawNew = true;
      if (!sawNew) {
        if (s.error && Date.now() - started > 3000) throw new Error(`Gemini: ${truncate(s.error, 300)}`);
        const waited = Date.now() - started;
        if (!s.stop && waited > 90000) throw Object.assign(new Error('Gemini mesajı almadı (gönderilemedi). Pencereyi kontrol edin.'), { stuck: true });
        // Sometimes Gemini shows the message but never starts answering (spinner forever; a new
        // chat doesn't even get its conversation id). Thinking models show the answer box early,
        // so this is a hang: stop it and let run() send once more.
        if (waited > (sessionId ? 240000 : 120000) && (sessionId || !conversationId(s.url))) {
          await page.eval(pageStop).catch(() => {});
          throw Object.assign(new Error('Gemini mesajı aldı ama cevaba başlamadı (takıldı).'), { stuck: true });
        }
        continue;
      }
      if (s.text !== shown) {
        if (s.text.startsWith(shown)) emit({ type: 'text-delta', text: s.text.slice(shown.length) });
        else emit({ type: 'message', text: s.text });
        shown = s.text;
        stable = 0;
      } else {
        stable += 1;
      }
      // Done: no stop button any more and text unchanged for ~2s (or the answer's action bar is there).
      if (!s.stop && shown && (stable >= 3 || (s.actions > 0 && stable >= 1))) break;
      if (!s.stop && !shown && stable >= 20) throw new Error(s.error ? `Gemini: ${truncate(s.error, 300)}` : 'Gemini boş cevap döndü.');
    }

    const st = await page.eval(pageState, SEL);
    const id = conversationId(st.url) || sessionId || null;
    if (id && system) systemBySession.set(id, system);
    emit({ type: 'message', text: shown });
    return { text: shown, sessionId: id || undefined };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    page.close();
  }
}

export default {
  id: 'gemini',
  name: 'Gemini (web)',
  capabilities: { edit: false, resume: true, streaming: true, cwd: false, sandbox: true, images: true },

  async detect() {
    try {
      const page = await openPage({ launch: false });
      const warning = healthWarning();
      if (!page) return existsSync(SIGNED_IN_MARK) ? { available: true, sleeping: true, ...(warning ? { warning } : {}) } : { available: false, reason: NOT_RUNNING };
      try {
        const st = await page.eval(pageState, SEL);
        if (st.signedOut) { markSignedIn(false); return { available: false, reason: SIGNED_OUT }; }
        if (st.editor) markSignedIn(true);
        return { available: true, version: 'gemini.google.com', ...(warning ? { warning } : {}) };
      } finally {
        page.close();
      }
    } catch (err) {
      return { available: false, reason: `Gemini penceresine bağlanılamadı: ${err?.message || err}` };
    }
  },

  async start() {
    try {
      const page = await openPage({ launch: true });
      try {
        const st = await waitFor(page, (s) => s.signedOut || s.editor, { timeoutMs: 20000 });
        if (st?.signedOut) {
          // Google blocks sign-in in a debug-mode browser: reopen the same profile normally.
          markSignedIn(false);
          await closeBrowser();
          openSignInWindow();
          return { ok: false, reason: SIGNED_OUT };
        }
        if (st?.editor) markSignedIn(true);
        lastActivity = Date.now();
        scheduleIdleClose();
        return { ok: true };
      } finally {
        page.close();
      }
    } catch (err) {
      return { ok: false, reason: err?.message || String(err) };
    }
  },

  async listModels() {
    return MODELS.map(({ id, label, default: d }) => ({ id, label, ...(d ? { default: true } : {}) }));
  },

  async getLimits() {
    return { items: [], note: 'Gemini uygulamasının kotası buradan okunamıyor; limit dolarsa Gemini hata mesajı gösterir.' };
  },

  async run({ prompt, model, sessionId, system, images, signal, onEvent = () => {} }) {
    const emit = (e) => { try { onEvent(e); } catch { /* listener error */ } };
    if (signal?.aborted) throw new AbortError();
    emit({ type: 'status', text: 'Gemini sırası bekleniyor…' });
    pendingTurns++;
    try {
      const res = await withLock(async () => {
        if (signal?.aborted) throw new AbortError();
        try {
          return await turn({ prompt, model, sessionId, system, images, signal, onEvent });
        } catch (err) {
          if (!err?.stuck || signal?.aborted) throw err;
          emit({ type: 'status', text: `${err.message} Mesaj yeniden gönderiliyor…` });
          await sleep(2000, signal);
          return turn({ prompt, model, sessionId, system, images, signal, onEvent });
        }
      });
      noteSuccess();
      emit({ type: 'done', text: res.text, sessionId: res.sessionId });
      return res;
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw new AbortError();
      if (err?.signedOut) { await closeBrowser().catch(() => {}); try { openSignInWindow(); } catch { /* no browser */ } }
      const message = err?.message || String(err);
      if (!err?.signedOut) noteFailure(message);
      emit({ type: 'error', message });
      throw new Error(message);
    } finally {
      pendingTurns--;
      lastActivity = Date.now();
      scheduleIdleClose();
    }
  },
};

export const _internals = { MODELS, conversationId };

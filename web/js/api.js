// fetch wrapper + toasts.
import { h, icon } from './dom.js';

export function toast(message, level = 'info', ms) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const msg = String(message);
  for (const t of box.children) {
    if (t.dataset.msg === msg && !t.classList.contains('out')) return; // same toast already visible
  }
  const el = h('div', { class: `toast toast-${level}`, role: level === 'error' ? 'alert' : 'status' },
    icon(level === 'error' ? 'warn' : level === 'success' ? 'check' : 'info'),
    h('span', { class: 'toast-text', text: msg }));
  el.dataset.msg = msg;
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 180);
  };
  el.addEventListener('click', dismiss);
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(dismiss, ms ?? (level === 'error' ? 7000 : 3500));
}

/**
 * JSON request. Throws Error(message) on failure; message comes from the server's
 * `{ error }` field. Shows an error toast unless `quiet`.
 */
export async function api(path, { method = 'GET', body, quiet = false, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const e = new Error('Sunucuya ulaşılamıyor. Ortak sunucusu çalışıyor mu?');
    e.network = true;
    if (!quiet) toast(e.message, 'error');
    throw e;
  }
  let data = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const e = new Error((data && typeof data.error === 'string' && data.error) || `İstek başarısız (HTTP ${res.status})`);
    e.status = res.status;
    e.data = data; // e.g. apply conflicts: { error, ok:false, conflicts, output }
    if (!quiet) toast(e.message, 'error');
    throw e;
  }
  return data;
}

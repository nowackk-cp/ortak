// Formatting, storage and small helpers.

const PREFIX = 'ortak.';

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch { /* storage unavailable */ }
  },
};

const nfInt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
export const fmtInt = (n) => nfInt.format(Number(n) || 0);

export function fmtCost(usd) {
  const n = Number(usd) || 0;
  const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  return '$' + n.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtDuration(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toLocaleString('tr-TR', { maximumFractionDigits: s < 10 ? 1 : 0 })} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${Math.floor(s % 60)} sn`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

export function toMs(t) {
  if (typeof t === 'number') return t;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : NaN;
}

export function relTime(t) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 45) return 'az önce';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} dk önce`;
  if (diff < 86400) return `${Math.round(diff / 3600)} sa önce`;
  if (diff < 2 * 86400) return 'dün';
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} gün önce`;
  return new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

export function fmtDate(t) {
  const ms = toMs(t);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** "2 sa 14 dk sonra sıfırlanır" */
export function resetText(iso) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '';
  const mins = Math.ceil((ms - Date.now()) / 60000);
  if (mins <= 0) return 'sıfırlandı';
  const d = Math.floor(mins / 1440);
  const hh = Math.floor((mins % 1440) / 60);
  const mm = mins % 60;
  let s;
  if (d > 0) s = `${d} gün${hh ? ` ${hh} sa` : ''}`;
  else if (hh > 0) s = `${hh} sa${mm ? ` ${mm} dk` : ''}`;
  else s = `${mm} dk`;
  return `${s} sonra sıfırlanır`;
}

export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
}

export function basename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) || s : s;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export const enc = encodeURIComponent;

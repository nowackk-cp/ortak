// Phone access ("Telefondan aç"): a second listener on all network interfaces (port 4748 by
// default) next to the local-only one on 127.0.0.1. The local listener stays as it was (no key);
// every request on this one needs the pairing key — a long random key shown on the computer (and in
// the QR code), kept by the phone as an HttpOnly cookie. Off until turned on from the computer.
// State: data/remote.json { enabled, port, key }.   env: ORTAK_REMOTE_PORT, ORTAK_REMOTE=1 (turn on)
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REMOTE_PORT = 4748;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const KEY_LEN = 16;                                  // 80 bits
const COOKIE = 'ortak_key';
const COOKIE_AGE = 365 * 24 * 3600;
const FAIL_MAX = 10;                                 // wrong keys per address…
const FAIL_WINDOW_MS = 10 * 60_000;                  // …within this window
const DEVICES_MAX = 8;
const LOGIN_PATH = '/telefon/giris';
const MANIFEST = path.resolve(import.meta.dirname, '..', 'web', 'manifest.webmanifest');
const PUBLIC = /^\/icons\/[\w.-]+\.png$/; // home-screen icons: nothing secret, fetched without cookies

export function newKey() {
  const bytes = crypto.randomBytes(KEY_LEN);
  return [...bytes].map((b) => ALPHABET[b & 31]).join('');
}

/** What the user typed → key characters (case, spaces, dashes and look-alikes forgiven). */
export function normalizeKey(s) {
  return String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
}

export const formatKey = (k) => (String(k).match(/.{1,4}/g) || []).join('-');

function sameKey(a, b) {
  const x = Buffer.from(normalizeKey(a));
  const y = Buffer.from(normalizeKey(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|^br-|^veth|virbr|loopback|npcap|vpn|zerotier/i;

/** Addresses the phone may use: [{ url, kind: 'lan' | 'tailscale' | 'other', label }]. */
export function addresses(port, ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
      const [p, q] = a.address.split('.').map(Number);
      if (p === 169 && q === 254) continue; // link-local: no DHCP
      const tailscale = /tailscale/i.test(name) || (p === 100 && q >= 64 && q <= 127);
      const privateLan = p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q <= 31);
      const kind = tailscale ? 'tailscale' : privateLan && !VIRTUAL.test(name) ? 'lan' : 'other';
      out.push({
        url: `http://${a.address}:${port}`,
        kind,
        label: kind === 'tailscale' ? 'Tailscale — her yerden' : kind === 'lan' ? `Aynı Wi-Fi / ağ (${name})` : `Diğer ağ (${name})`,
      });
    }
  }
  const rank = { lan: 0, tailscale: 1, other: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** "Android · Chrome" from a User-Agent. */
export function deviceName(ua) {
  const s = String(ua || '');
  const osName = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'Cihaz';
  const browser = /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera'
    : /Firefox|FxiOS/.test(s) ? 'Firefox' : /Chrome|CriOS/.test(s) ? 'Chrome' : /Safari/.test(s) ? 'Safari' : '';
  return browser ? `${osName} · ${browser}` : osName;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(error = '') {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#262624"><title>Ortak · Telefon</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f5;--card:#fff;--text:#1d1c1a;--muted:#5f5c55;--border:#dcd8cc;--accent:#c96442;--red:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--card:#30302e;--text:#f2f0e9;--muted:#b4b1a7;--border:#4a4843;--accent:#d97757;--red:#ef7a6f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,"Segoe UI",system-ui,Roboto,sans-serif}
main{width:100%;max-width:380px;padding:26px 22px;border:1px solid var(--border);border-radius:18px;background:var(--card)}
.mark{display:flex;gap:2px;margin-bottom:14px}.mark i{width:22px;height:22px;border:3px solid var(--accent);border-radius:50%}.mark i+i{margin-left:-9px}
h1{margin:0 0 6px;font-size:21px}p{margin:0 0 18px;color:var(--muted);font-size:14.5px}
input{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg);color:var(--text);font:600 19px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:600 16px system-ui,sans-serif}
.err{min-height:20px;margin-top:10px;color:var(--red);font-size:14px}
small{display:block;margin-top:14px;color:var(--muted);font-size:13px}
</style></head><body><main>
<div class="mark" aria-hidden="true"><i></i><i></i></div>
<h1>Ortak'a bağlan</h1>
<p>Bilgisayardaki Ortak'ta <b>Telefondan aç</b> penceresindeki QR kodu okut ya da anahtarı buraya yaz.</p>
<form id="f"><input id="k" name="k" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" aria-label="Anahtar" required>
<button type="submit">Bağlan</button><div class="err" id="e" role="alert">${esc(error)}</div></form>
<small>Anahtar yalnızca bu cihazda saklanır. Bilgisayarda “Yeni anahtar” denirse yeniden bağlanman gerekir.</small>
</main><script>
document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const e=document.getElementById('e');e.textContent='';
try{const r=await fetch('${LOGIN_PATH}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('k').value})});
if(r.ok){location.replace('/');return;}const j=await r.json().catch(()=>({}));e.textContent=j.error||'Bağlanılamadı.';}catch{e.textContent='Bilgisayara ulaşılamadı.';}});
</script></body></html>`;
}

export class Remote {
  /**
   * @param {{ dataDir: string, handle: (req, res) => Promise<void>, log?: (msg: string) => void }} o
   *   handle: the app's request handler, called for requests that carry the key
   */
  constructor({ dataDir, handle, log = console.log }) {
    this.file = path.join(dataDir, 'remote.json');
    this.handle = handle;
    this.log = log;
    this.server = null;
    this.error = null;
    this.fails = new Map();   // address -> [timestamps of wrong keys]
    this.devices = new Map(); // address|ua -> { name, ip, at }
    const saved = this.#read();
    const envPort = Number(process.env.ORTAK_REMOTE_PORT);
    this.port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : saved.port || DEFAULT_REMOTE_PORT;
    this.key = typeof saved.key === 'string' && normalizeKey(saved.key).length === KEY_LEN ? normalizeKey(saved.key) : '';
    this.enabled = !!saved.enabled || process.env.ORTAK_REMOTE === '1';
  }

  #read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch { return {}; }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ enabled: this.enabled, port: this.port, key: this.key }, null, 2), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) { this.log(`Telefon ayarı kaydedilemedi: ${err.message}`); }
  }

  get listening() { return !!this.server?.listening; }

  /** For the computer's UI (`local`) or the phone (no key). */
  status({ local }) {
    const urls = addresses(this.port);
    return {
      enabled: this.enabled,
      listening: this.listening,
      port: this.port,
      error: this.error,
      urls,
      ...(local ? {
        key: this.key ? formatKey(this.key) : null,
        // the QR code carries the key: scanning it signs the phone in
        links: this.key ? urls.map((u) => ({ ...u, link: `${u.url}/?k=${this.key}` })) : [],
        devices: [...this.devices.values()].sort((a, b) => b.at - a.at),
      } : {}),
    };
  }

  async start() {
    if (this.enabled) await this.#listen();
  }

  /** Turn phone access on or off (from the computer). */
  async setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled && !this.key) this.key = newKey();
    this.#save();
    if (this.enabled) await this.#listen();
    else await this.#close();
  }

  /** A new key: every phone signed in with the old one has to scan again. */
  rotate() {
    this.key = newKey();
    this.devices.clear();
    this.#save();
  }

  async stop() { await this.#close(); }

  #listen() {
    if (this.listening) return Promise.resolve();
    if (!this.key) { this.key = newKey(); this.#save(); }
    this.error = null;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.serve(req, res).catch((err) => {
          console.error('[telefon]', err);
          if (!res.headersSent) this.#json(res, 500, { error: `Sunucu hatası: ${err?.message || err}` });
          else res.destroy();
        });
      });
      server.keepAliveTimeout = 5_000;
      server.once('error', (err) => {
        this.error = err.code === 'EADDRINUSE'
          ? `Port ${this.port} kullanımda. Başka bir port için ORTAK_REMOTE_PORT ortam değişkenini ayarla.`
          : `Telefon erişimi başlatılamadı: ${err.message}`;
        this.server = null;
        this.log(this.error);
        resolve();
      });
      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        const first = addresses(this.port)[0];
        this.log(`Telefondan erişim açık: ${first ? first.url : `port ${this.port}`}  ·  anahtar: ${formatKey(this.key)}`);
        resolve();
      });
    });
  }

  #close() {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.(); // SSE streams would keep it open
    });
  }

  #json(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(data);
  }

  #html(res, status, html, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(html);
  }

  #cookie(clear = false) {
    return clear
      ? `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      : `${COOKIE}=${this.key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_AGE}`;
  }

  /** Too many wrong keys from this address lately? */
  #blocked(ip) {
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.fails.set(ip, list);
    return list.length >= FAIL_MAX;
  }

  #failed(ip) {
    const list = this.fails.get(ip) || [];
    list.push(Date.now());
    this.fails.set(ip, list);
    if (this.fails.size > 1000) this.fails.delete(this.fails.keys().next().value);
  }

  #seen(req, ip) {
    const ua = String(req.headers['user-agent'] || '');
    const id = `${ip}|${ua}`;
    const d = this.devices.get(id) || { name: deviceName(ua), ip };
    d.at = Date.now();
    this.devices.delete(id);
    this.devices.set(id, d);
    while (this.devices.size > DEVICES_MAX) this.devices.delete(this.devices.keys().next().value);
  }

  /**
   * The home-screen icon opens `start_url`; on an iPhone that app doesn't share Safari's cookies,
   * so a signed-in phone gets a start_url that signs it in again (its own key, on its own screen).
   */
  #manifest(res, signedIn) {
    let m = {};
    try { m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* minimal below */ }
    m = { name: 'Ortak', display: 'standalone', ...m, start_url: signedIn ? `/?k=${this.key}` : '/', scope: '/' };
    const data = JSON.stringify(m);
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  async serve(req, res) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    let url;
    try { url = new URL(req.url, 'http://telefon'); } catch { return this.#json(res, 400, { error: 'Geçersiz adres.' }); }
    const method = req.method;

    if (url.pathname === LOGIN_PATH && method === 'POST') {
      if (this.#blocked(ip)) return this.#json(res, 429, { error: 'Çok fazla yanlış deneme. 10 dakika sonra tekrar dene.' });
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return this.#json(res, 415, { error: 'İstek türü application/json olmalı.' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return this.#json(res, 413, { error: 'İstek çok büyük.' });
      }
      let key = '';
      try { key = JSON.parse(body || '{}').key; } catch { /* below */ }
      if (!sameKey(key, this.key)) {
        this.#failed(ip);
        return this.#json(res, 401, { error: 'Anahtar yanlış. Bilgisayardaki Telefondan aç penceresine bak.' });
      }
      this.#seen(req, ip);
      return this.#json(res, 200, { ok: true }, { 'Set-Cookie': this.#cookie() });
    }

    // the QR code's link: ?k=KEY signs in, then the key leaves the address bar
    const k = url.searchParams.get('k');
    if (k != null && (method === 'GET' || method === 'HEAD')) {
      if (this.#blocked(ip)) return this.#html(res, 429, loginPage('Çok fazla yanlış deneme. 10 dakika sonra tekrar dene.'));
      if (!sameKey(k, this.key)) {
        this.#failed(ip);
        return this.#html(res, 401, loginPage('Bu QR kodun anahtarı artık geçerli değil. Bilgisayardaki yeni kodu okut.'));
      }
      this.#seen(req, ip);
      url.searchParams.delete('k');
      const to = `${url.pathname}${url.search}` || '/';
      res.writeHead(302, { Location: to, 'Set-Cookie': this.#cookie(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }

    const signedIn = sameKey(cookieOf(req, COOKIE), this.key);
    if (url.pathname === '/manifest.webmanifest' && (method === 'GET' || method === 'HEAD')) return this.#manifest(res, signedIn);
    if (PUBLIC.test(url.pathname) && (method === 'GET' || method === 'HEAD')) return this.handle(req, res);
    if (!signedIn) {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return this.#json(res, 401, { error: 'Telefon anahtarı gerekli: sayfayı yenileyip yeniden bağlan.', login: true });
      }
      if (method !== 'GET' && method !== 'HEAD') return this.#json(res, 401, { error: 'Anahtar gerekli.' });
      return this.#html(res, 200, loginPage());
    }

    if (url.pathname === '/telefon/cikis' && method === 'POST') {
      return this.#json(res, 200, { ok: true }, { 'Set-Cookie': this.#cookie(true) });
    }
    this.#seen(req, ip);
    return this.handle(req, res);
  }
}

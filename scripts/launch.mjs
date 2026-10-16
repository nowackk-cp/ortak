// One-click launcher (used by Ortak.vbs and the desktop shortcut):
//  1. if the Ortak server is not answering, start it in the background (no console window,
//     output appended to data/server.log) and wait until it is healthy;
//  2. open the UI in an app-style browser window (Chrome/Edge --app), or the default browser.
// Exits 0 on success, 1 on failure (Ortak.vbs then shows a message box).
//   node scripts/launch.mjs [--tab] [--no-open]
//     --tab      open in a normal browser tab instead of an app window
//     --no-open  only make sure the server runs (e.g. after `npm run durdur` to restart it)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.ORTAK_PORT) || 4747;
const BASE = `http://127.0.0.1:${PORT}/`;
const DATA = path.resolve(process.env.ORTAK_DATA || path.join(ROOT, 'data'));
const LOG = path.join(DATA, 'server.log');
const START_TIMEOUT_MS = 20_000;

const log = (msg) => {
  try { fs.appendFileSync(LOG, `[launch ${new Date().toISOString()}] ${msg}\n`); } catch {}
};

async function healthy() {
  try {
    const res = await fetch(`${BASE}api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

async function startServer() {
  fs.mkdirSync(DATA, { recursive: true });
  try { if (fs.statSync(LOG).size > 5_000_000) fs.renameSync(LOG, `${LOG}.1`); } catch {}
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    detached: true,     // survives this launcher
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy()) return true;
    if (exited !== null) break; // e.g. port already used by another program
    await new Promise((r) => setTimeout(r, 300));
  }
  log(exited !== null ? `sunucu çıkış kodu ${exited} ile kapandı` : 'sunucu zamanında cevap vermedi');
  return false;
}

function browserApp() {
  if (process.platform !== 'win32') return null;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => p && fs.existsSync(p)) || null;
}

function openUi({ tab }) {
  const exe = tab ? null : browserApp();
  const opts = { detached: true, stdio: 'ignore' };
  if (exe) spawn(exe, [`--app=${BASE}`, '--window-size=1400,900'], opts).unref();
  else if (process.platform === 'win32') spawn('cmd.exe', ['/d', '/c', 'start', '""', BASE], { ...opts, windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [BASE], opts).unref();
}

// exitCode instead of process.exit(): exiting with a fetch socket still open trips a libuv
// assertion on Windows.
const ok = (await healthy()) || (await startServer());
if (!ok) process.exitCode = 1;
else if (!process.argv.includes('--no-open')) openUi({ tab: process.argv.includes('--tab') });

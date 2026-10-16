// Shared helpers for adapters. See docs/CONTRACT.md §1.
import { spawn, execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from '../settings.js';

export const IS_WIN = process.platform === 'win32';

export class AbortError extends Error {
  constructor(message = 'İptal edildi') {
    super(message);
    this.name = 'AbortError';
  }
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// Make sure the usual CLI locations are on PATH, for `which` and for child processes (codex.cmd
// needs `node`):
//  - <ortak>/tools/node_modules/.bin: CLIs installed next to Ortak (`npm run araclar`). Global
//    `npm i -g` run from a packaged (MSIX) app such as the Claude desktop app lands in that app's
//    virtualized AppData and is invisible to the rest of the system, so Ortak ships its own copy.
//  - %APPDATA%\npm: the shortcut inherits Explorer's environment, which can predate `npm i -g`.
{
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = (process.env[key] || '').split(path.delimiter).filter(Boolean);
  const have = new Set(dirs.map((d) => path.resolve(d).toLowerCase()));
  const extra = [
    IS_WIN && process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    path.dirname(process.execPath),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin'),
    path.resolve(import.meta.dirname, '..', '..', 'tools', 'node_modules', '.bin'),
  ].filter((d) => d && !have.has(path.resolve(d).toLowerCase()) && existsSync(d));
  if (extra.length) process.env[key] = [...dirs, ...extra].join(path.delimiter);
}

/** Resolve an executable on PATH (PATHEXT-aware on Windows). Returns an absolute path or null. */
export function which(cmd) {
  if (path.isAbsolute(cmd)) return isFile(cmd) ? cmd : null;
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  // On Windows an extensionless file (e.g. npm's POSIX `codex` script) is not runnable, so only
  // accept names that carry a PATHEXT extension.
  const exts = IS_WIN
    ? (path.extname(cmd) ? [''] : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** Copy of process.env without the variables that make a child `claude` think it is nested. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_AGENT_SDK_VERSION' ||
        k === 'CLAUDE_EFFORT' || k === 'CLAUDE_PID') delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * Canonical long form of a directory (expands Windows 8.3 names such as `ADMINI~1`, which make
 * some CLIs treat paths inside cwd as outside it). Returns the input unchanged if it can't resolve.
 */
export function realCwd(dir) {
  if (!dir) return dir;
  try { return realpathSync.native(dir); } catch { return dir; }
}

// cmd.exe quoting for arguments of .cmd/.bat shims. Only meant for flags and paths:
// user text must go through stdin (see CONTRACT.md).
function quoteCmdArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^%!(),;=]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Spawn a CLI. `.cmd`/`.bat` files on Windows are routed through cmd.exe (Node refuses to spawn
 * them directly). stdio is always piped.
 */
export function spawnCli(file, args = [], { cwd, env, windowsHide = true } = {}) {
  const ext = path.extname(file).toLowerCase();
  // Some CLIs (OpenCode, Kilo) take their working directory from $PWD rather than the process
  // cwd; a PWD inherited from the shell that started Ortak would point them at the wrong folder.
  const childEnv = { ...(env || cleanEnv()) };
  if (cwd) childEnv.PWD = cwd;
  else delete childEnv.PWD;
  delete childEnv.OLDPWD;
  const opts = { cwd, env: childEnv, windowsHide, stdio: ['pipe', 'pipe', 'pipe'] };
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    const line = [quoteCmdArg(file), ...args.map(quoteCmdArg)].join(' ');
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
    // cmd.exe needs a few ms before it starts the real program, which then inherits this.
    lowerPriority(child.pid);
    return child;
  }
  const child = spawn(file, args, opts);
  lowerPriority(child.pid);
  return child;
}

/**
 * Below-normal CPU priority for a process Ortak started (setting `lowPriority`), so agents never
 * make the user's foreground apps stutter. On Windows a below-normal process passes its priority
 * class on to the processes it creates (cmd.exe → node → codex.exe, Chrome → its renderers), so
 * lowering the direct child right after spawn covers the whole tree. Never throws.
 */
export function lowerPriority(pid) {
  if (!pid || !getSettings().lowPriority) return;
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* exited / not allowed */ }
}

/**
 * Open a visible terminal window running `file args…` (sign-in flows that need the user: device
 * codes, browser logins). The window stays open afterwards. Windows only; elsewhere returns a hint.
 * `file`/`args` must be paths and flags, never user text.
 */
export function openConsole({ title = 'Ortak', file, args = [], cwd = os.homedir() }) {
  if (!IS_WIN) return { ok: false, reason: `Bir terminalde çalıştırın: ${[path.basename(file), ...args].join(' ')}` };
  const q = (s) => (/[\s&|<>^()]/.test(String(s)) ? `"${s}"` : String(s));
  const safeTitle = String(title).replace(/["&|<>^%]/g, '');
  const line = `start "${safeTitle}" cmd /k ${[q(file), ...args.map(q)].join(' ')}`;
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd, env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Terminal açılamadı: ${err?.message || err}` };
  }
}

/** Kill a child and all of its descendants. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

/**
 * Run a process that prints JSON Lines on stdout.
 *  onJson(obj)    – every stdout line that parses as JSON
 *  onLine(line)   – every stdout line that does not
 *  onStderr(text) – raw stderr chunks
 * Resolves { code, stderr } (stderr capped at 64KB). Rejects with AbortError when `signal` aborts.
 */
export function runJsonl({ file, args = [], cwd, env, stdin, signal, onJson, onLine, onStderr }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    if (cwd && !existsSync(cwd)) return reject(new Error(`Klasör bulunamadı: ${cwd}`));

    let child;
    try {
      child = spawnCli(file, args, { cwd, env });
    } catch (err) {
      return reject(err);
    }

    let buf = '';
    let stderr = '';
    let aborted = false;

    const onAbort = () => { aborted = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line) => {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed.trim()) return;
      if (trimmed[0] === '{' || trimmed[0] === '[') {
        try { onJson?.(JSON.parse(trimmed)); return; } catch { /* fall through */ }
      }
      onLine?.(trimmed);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { handleLine(line); } catch (err) { console.error('[runJsonl] handler error', err); }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 65536) stderr += chunk;
      onStderr?.(chunk);
    });

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (buf) { try { handleLine(buf); } catch {} buf = ''; }
      if (aborted) return reject(new AbortError());
      resolve({ code, stderr });
    });

    if (stdin != null) {
      child.stdin.on('error', () => {}); // process may exit before reading everything
      child.stdin.end(stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** Run a command and collect stdout (for --version style probes). Never throws. */
export async function capture(file, args = [], { cwd, env, timeoutMs = 10000, stdin } = {}) {
  let out = '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { code, stderr } = await runJsonl({
      file, args, cwd, env, stdin, signal: ctrl.signal,
      onJson: (o) => { out += JSON.stringify(o) + '\n'; },
      onLine: (l) => { out += l + '\n'; },
    });
    return { ok: code === 0, code, stdout: out, stderr };
  } catch (err) {
    return { ok: false, code: -1, stdout: out, stderr: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export function truncate(str, n = 4000) {
  if (str == null) return '';
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n})` : s;
}

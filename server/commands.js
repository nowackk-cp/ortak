// Shell commands run by Ortak on behalf of agents without their own terminal (Gemini web / 4 Argon,
// EVREN): `RUN: npm test` in an answer → runCommand() in the project folder, output back to the agent.
// Not a sandbox: the permission decides what may run (policyOf), and every command is shown in the UI.
//   read-only → only commands that don't change anything (tests, listings, git status/diff/log)
//   edit      → anything except destructive / outward-facing commands (push, commit, global installs,
//               publishing, recursive deletes, system tools)
//   full      → everything
import { spawn } from 'node:child_process';
import { IS_WIN, which, killTree } from './adapters/base.js';

export const COMMAND_TIMEOUT_MS = 120_000;
const OUTPUT_MAX = 12_000; // chars of output sent back for a failing command (head + error lines + tail)
const OUTPUT_OK_MAX = 3000; // a command that succeeded: its end says enough ("12 passed")
const HEAD_KEEP = 1500;
const ERROR_LINES_MAX = 60;
// Lines worth keeping from the middle of a long failing output.
const ERROR_LINE = /\b(error|errors|fail|failed|failing|failure|exception|traceback|assert|panic|cannot|not found|undefined|expected|hata|başarısız)\b|✗|✖|×|FAIL|ERR!/i;
const strip = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n'); // eslint-disable-line no-control-regex

/**
 * Output for the agent: short when the command succeeded; for a failure the start, the error-like
 * lines from the part that was cut, and the end. `head` = the first chars, `body` = the rest kept,
 * `errs` = error lines already seen in what scrolled out, `dropped` = chars that scrolled out.
 */
export function shapeOutput({ head, body, errs = [], dropped = 0 }, ok) {
  const max = ok ? OUTPUT_OK_MAX : OUTPUT_MAX;
  const text = (head + body).trimEnd();
  if (!dropped && text.length <= max) return text;
  if (ok) {
    const cut = dropped + text.length - (max - 600);
    return `${text.slice(0, 600)}\n…(${cut} karakter çıktı atlandı; komut başarılı)…\n${text.slice(-(max - 600))}`;
  }
  const keepTail = max - HEAD_KEEP - 3000;
  const middle = text.slice(HEAD_KEEP, Math.max(HEAD_KEEP, text.length - keepTail));
  const found = [...errs, ...middle.split('\n').filter((l) => ERROR_LINE.test(l))]
    .map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l));
  const picked = found.slice(0, ERROR_LINES_MAX);
  const cut = dropped + middle.length;
  return `${text.slice(0, HEAD_KEEP)}\n…(${cut} karakter çıktı atlandı` +
    (picked.length ? `; aradaki hata satırları${found.length > picked.length ? ` (ilk ${picked.length})` : ''}:\n${picked.join('\n')}\n…` : ')…') +
    `\n${text.slice(-keepTail)}`;
}

const MUTATING_COMMANDS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'ren', 'rename', 'cp', 'copy',
  'xcopy', 'robocopy', 'mkdir', 'md', 'touch', 'new-item', 'ni', 'remove-item', 'ri', 'move-item', 'mi',
  'copy-item', 'cpi', 'rename-item', 'rni', 'set-content', 'add-content', 'ac', 'out-file', 'clear-content',
  'set-itemproperty', 'tee', 'tee-object', 'chmod', 'chown', 'truncate', 'dd', 'format', 'shutdown', 'taskkill',
  'stop-process', 'kill', 'reg', 'setx', 'winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'msiexec']);

// Never in 'edit' (system-wide, irreversible or outward-facing).
const DANGEROUS_COMMANDS = new Set(['format', 'shutdown', 'restart-computer', 'stop-computer', 'reg', 'setx',
  'taskkill', 'stop-process', 'kill', 'winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'msiexec', 'diskpart',
  'bcdedit', 'cipher', 'takeown', 'icacls', 'net', 'netsh', 'sc', 'schtasks', 'runas', 'sudo', 'set-executionpolicy',
  'invoke-expression', 'iex', 'start-process', 'mkfs', 'chown', 'dd']);

const segments = (c) => c.split(/&&|\|\||[;|&\n]/).map((seg) => {
  const first = seg.trim().replace(/^[(@&.\s]+/, '').split(/\s+/)[0]?.replace(/^["']|["']$/g, '').toLowerCase() || '';
  return { seg, base: first.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|com|ps1)$/, '') };
});

/** True for commands that change files or the system (used for read-only runs). */
export function isMutatingCommand(cmd) {
  const c = String(cmd || '');
  // Output redirection to a real file (not 2>&1, >$null, >NUL, >/dev/null).
  if (/(^|[^0-9&>])>{1,2}(?!\s*(\$null|nul\b|&\d|\/dev\/null))/i.test(c.replace(/"[^"]*"|'[^']*'/g, '""'))) return true;
  if (/\bgit\s+(add|commit|push|reset|checkout|clean|rebase|merge|stash|rm|mv|apply|restore|switch|pull|cherry-pick|revert|am|tag|init|clone)\b/i.test(c)) return true;
  if (/\b(npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|go|dotnet|gem|composer)\s+(install|i|ci|add|remove|rm|uninstall|update|upgrade|publish|init|get)\b/i.test(c)) return true;
  if (/\bsed\s+-i|\bperl\s+-p?i\b|\[System\.IO\.File\]::(Write|Append|Delete|Move|Copy)/i.test(c)) return true;
  return segments(c).some(({ base }) => MUTATING_COMMANDS.has(base));
}

/** Reason why `cmd` is refused in an 'edit' run, or null. */
export function dangerousReason(cmd) {
  const c = String(cmd || '');
  if (/\bgit\s+(push|commit|reset|clean|rebase|merge|stash|checkout|switch|restore|pull|cherry-pick|revert|am|tag|clone|remote|config|filter-branch|update-ref|gc|reflog)\b/i.test(c)) {
    return 'git geçmişini/uzak depoyu değiştiren komutlar (commit, push, reset, checkout…) yasak';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|login|logout|adduser|token|owner|deprecate|dist-tag)\b/i.test(c)) return 'paket yayınlama/hesap komutları yasak';
  if (/\b(npm|pnpm|yarn|bun|pip|pip3)\s+[^;&|]*(\s-g\b|--global\b|--user\b)/i.test(c) || /\byarn\s+global\b/i.test(c)) return 'genel (global) paket kurulumu yasak';
  if (/\b(cargo|dotnet|gem|composer|go)\s+(publish|push|login)\b/i.test(c)) return 'yayınlama komutları yasak';
  if (/\brm\s+(-[a-z]*r|-[a-z]*f[a-z]*r|--recursive)|\brmdir\s+\/s|\brd\s+\/s|\bdel\s+[^;&|]*\/s\b|remove-item[^;&|]*-recurse/i.test(c)) return 'özyinelemeli (klasör) silme yasak';
  if (/(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^;&]*\|\s*(sh|bash|iex|invoke-expression|powershell|pwsh|cmd)\b/i.test(c)) return 'internetten indirip doğrudan çalıştırma yasak';
  if (/(^|[\s"'=])(?:[a-z]:\\(?:windows|program files)|\/(?:etc|usr|bin|boot|sys)\/|%systemroot%|\$env:windir)/i.test(c)) return 'sistem klasörlerine dokunan komut yasak';
  const bad = segments(c).find(({ base }) => DANGEROUS_COMMANDS.has(base));
  if (bad) return `"${bad.base}" komutu yasak (sistem düzeyi)`;
  return null;
}

/** null when `cmd` may run under `permission`, otherwise a Turkish reason. */
export function policyOf(cmd, permission) {
  if (!String(cmd || '').trim()) return 'boş komut';
  if (permission === 'full') return null;
  if (permission === 'read-only') return isMutatingCommand(cmd) ? 'salt okunur çalışma: yalnızca hiçbir şeyi değiştirmeyen komutlar (test, listeleme, git status/diff/log) çalıştırılabilir' : null;
  return dangerousReason(cmd);
}

let shellCache;
/** { file, args(cmd), name } — PowerShell 7 when installed (supports &&), else Windows PowerShell; sh elsewhere. */
export function shell() {
  if (shellCache) return shellCache;
  if (!IS_WIN) {
    shellCache = { file: process.env.SHELL || '/bin/sh', args: (c) => ['-c', c], name: 'sh' };
  } else {
    const pwsh = which('pwsh');
    const file = pwsh || 'powershell.exe';
    const utf8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;';
    shellCache = {
      file,
      // -Command reports only 0/1: pass on the native program's real exit code.
      args: (c) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `${utf8}$global:LASTEXITCODE=0\n${c}\n$__ok=$?; if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__ok) { exit 1 }`],
      name: pwsh ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1 (&& ve || yok; komutları ; ile ayır)',
    };
  }
  return shellCache;
}

/**
 * Runs `cmd` in `cwd`. Resolves { code, output, timedOut } — never rejects for a failing command.
 * Rejects with AbortError when `signal` aborts (the process tree is killed).
 */
export async function runCommand(cmd, { cwd, signal, timeoutMs = COMMAND_TIMEOUT_MS }) {
  const sh = shell();
  return new Promise((resolve, reject) => {
    const child = spawn(sh.file, sh.args(cmd), {
      cwd, windowsHide: true, detached: !IS_WIN,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', npm_config_yes: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The start is kept apart; the rest scrolls, keeping its error-like lines as it goes.
    let head = '';
    let body = '';
    let dropped = 0;
    const errs = [];
    const add = (d) => {
      let t = strip(d.toString('utf8'));
      if (head.length < HEAD_KEEP) { const room = HEAD_KEEP - head.length; head += t.slice(0, room); t = t.slice(room); }
      body += t;
      if (body.length > OUTPUT_MAX * 4) {
        const cutAt = body.lastIndexOf('\n', body.length - OUTPUT_MAX * 2) + 1 || body.length - OUTPUT_MAX * 2;
        const gone = body.slice(0, cutAt);
        if (errs.length < ERROR_LINES_MAX) errs.push(...gone.split('\n').filter((l) => ERROR_LINE.test(l)).slice(0, ERROR_LINES_MAX - errs.length));
        dropped += gone.length;
        body = body.slice(cutAt);
      }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.on('error', (err) => { finish(); resolve({ code: -1, output: `Komut başlatılamadı: ${err.message}`, timedOut: false }); });
    child.on('close', (code) => {
      finish();
      if (signal?.aborted) { const e = new Error('İptal edildi'); e.name = 'AbortError'; reject(e); return; }
      const text = shapeOutput({ head, body, errs, dropped }, code === 0 && !timedOut);
      resolve({ code: timedOut ? null : code, output: text, timedOut });
    });
  });
}

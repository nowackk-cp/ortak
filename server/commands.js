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
const OUTPUT_MAX = 12_000; // chars of output sent back (tail; head kept short)

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
export async function runCommand(cmd, { cwd, signal, timeoutMs = COMMAND_TIMEOUT_MS, outputMax = OUTPUT_MAX }) {
  const sh = shell();
  return new Promise((resolve, reject) => {
    const child = spawn(sh.file, sh.args(cmd), {
      cwd, windowsHide: true, detached: !IS_WIN,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', npm_config_yes: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let dropped = 0;
    const add = (d) => {
      out += d.toString('utf8');
      if (out.length > outputMax * 4) { dropped += out.length - outputMax * 2; out = out.slice(-outputMax * 2); }
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
      // eslint-disable-next-line no-control-regex
      let text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n').trimEnd();
      if (text.length > outputMax || dropped) {
        const head = Math.min(1500, Math.floor(outputMax * 0.25));
        const cut = dropped + Math.max(0, text.length - outputMax);
        text = `${text.slice(0, head)}\n…(${cut} karakter çıktı atlandı)…\n${text.slice(-(outputMax - head))}`;
      }
      resolve({ code: timedOut ? null : code, output: text, timedOut });
    });
  });
}

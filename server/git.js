// Git helpers: repo info, worktrees, diffs, apply. Always execFile('git', ...) — never a shell.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep } from './util.js';
import { realCwd } from './adapters/base.js';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' };

// Flags that make diff output independent of the user's git config (colors, external diff
// tools, noprefix...) so it can always be fed back to `git apply`.
const DIFF_FLAGS = ['--binary', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

/**
 * Run git. Resolves `{ ok, code, stdout, stderr }` and never rejects.
 * `raw: true` returns stdout as a Buffer (patches may contain non-UTF-8 bytes).
 */
export function git(args, { cwd, input, env, raw = false, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('git', ['-c', 'core.quotepath=false', ...args], {
        cwd,
        env: { ...process.env, ...GIT_ENV, ...env },
        windowsHide: true,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer',
        timeout: timeoutMs,
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        let errText = stderr ? stderr.toString('utf8') : '';
        if (err?.code === 'ENOENT') errText = 'Git bulunamadı (PATH içinde `git` yok). Git for Windows kurun.';
        else if (err && typeof err.code !== 'number' && !errText) errText = err.message;
        const out = stdout || Buffer.alloc(0);
        resolve({ ok: code === 0, code, stdout: raw ? out : out.toString('utf8'), stderr: errText });
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: raw ? Buffer.alloc(0) : '', stderr: err?.message || String(err) });
      return;
    }
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** `{ isGit, top?, head?, branch? }` for any directory (never throws). */
export async function repoInfo(dir) {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 });
  if (!top.ok || !top.stdout.trim()) return { isGit: false, error: top.stderr.trim() || null };
  const [head, br] = await Promise.all([
    git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: dir, timeoutMs: 10_000 }),
    git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, timeoutMs: 10_000 }),
  ]);
  const headSha = head.ok ? head.stdout.trim() : null;
  let branch = br.ok ? br.stdout.trim() : null;
  if (!branch && headSha) branch = headSha.slice(0, 8); // detached HEAD
  return { isGit: true, top: realCwd(path.resolve(top.stdout.trim())), head: headSha, branch };
}

export async function isDirty(dir) {
  const r = await git(['status', '--porcelain'], { cwd: dir });
  return r.ok && r.stdout.trim().length > 0;
}

export async function branchExists(top, branch) {
  return (await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: top })).ok;
}

export async function addWorktree(top, wtPath, branch, base) {
  await mkdir(path.dirname(wtPath), { recursive: true });
  const r = await git(['worktree', 'add', '-b', branch, wtPath, base], { cwd: top });
  if (!r.ok) throw new Error(`Çalışma ağacı oluşturulamadı: ${r.stderr.trim() || r.stdout.trim()}`);
}

/** Remove a worktree and its branch; tolerant of half-deleted state and Windows file locks. */
export async function removeWorktree(top, wtPath, branch) {
  if (await exists(wtPath)) {
    for (let i = 0; i < 4; i++) {
      const r = await git(['worktree', 'remove', '--force', '--force', wtPath], { cwd: top });
      if (r.ok || !(await exists(wtPath))) break;
      await sleep(400 * (i + 1));
    }
    if (await exists(wtPath)) {
      await rm(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    }
  }
  await git(['worktree', 'prune'], { cwd: top });
  if (branch) await git(['branch', '-D', branch], { cwd: top });
}

export function parseNumstat(text) {
  let files = 0, additions = 0, deletions = 0;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    if (m[1] !== '-') additions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
  }
  return { files, additions, deletions };
}

/** Stage everything in an Ortak-owned worktree and diff it against `base` (catches commits too). */
export async function worktreeDiff(wt, base, { raw = false } = {}) {
  const add = await git(['add', '-A'], { cwd: wt });
  if (!add.ok) throw new Error(`git add başarısız: ${add.stderr.trim()}`);
  const [d, n] = await Promise.all([
    git(['diff', '--cached', ...DIFF_FLAGS, base], { cwd: wt, raw }),
    git(['diff', '--cached', '--numstat', '--no-color', base], { cwd: wt }),
  ]);
  if (!d.ok) throw new Error(`git diff başarısız: ${d.stderr.trim()}`);
  return { diff: d.stdout, stats: parseNumstat(n.stdout) };
}

/**
 * Snapshot the whole working tree (tracked + untracked, respecting .gitignore) as a tree object
 * WITHOUT touching the user's index: uses a temporary GIT_INDEX_FILE.
 */
export async function snapshotTree(top) {
  const idx = await git(['rev-parse', '--git-path', 'index'], { cwd: top });
  const tmp = path.join(os.tmpdir(), `ortak-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    if (idx.ok) await copyFile(path.resolve(top, idx.stdout.trim()), tmp).catch(() => {});
    const env = { GIT_INDEX_FILE: tmp };
    const add = await git(['add', '-A'], { cwd: top, env });
    if (!add.ok) throw new Error(`git add başarısız: ${add.stderr.trim()}`);
    const wt = await git(['write-tree'], { cwd: top, env });
    if (!wt.ok) throw new Error(`git write-tree başarısız: ${wt.stderr.trim()}`);
    return wt.stdout.trim();
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function treeDiff(top, a, b, { raw = false } = {}) {
  const [d, n] = await Promise.all([
    git(['diff', ...DIFF_FLAGS, a, b], { cwd: top, raw }),
    git(['diff', '--numstat', '--no-color', a, b], { cwd: top }),
  ]);
  if (!d.ok) throw new Error(`git diff başarısız: ${d.stderr.trim()}`);
  return { diff: d.stdout, stats: parseNumstat(n.stdout) };
}

/**
 * Apply a patch (Buffer/string) to the working tree of `top`. A plain `git apply` is tried first
 * (atomic, leaves the changes unstaged exactly like a direct edit); if it does not apply cleanly
 * we fall back to `git apply --3way`, which merges using the blobs from the shared object store
 * (works when HEAD moved since the run started; may leave conflict markers).
 * Resolves `{ ok, output, method, conflicts }`.
 */
export async function applyPatch(top, patch) {
  const text = (r) => [r.stdout, r.stderr].map((s) => String(s).trim()).filter(Boolean).join('\n');
  const plain = await git(['apply', '--whitespace=nowarn', '-'], { cwd: top, input: patch });
  if (plain.ok) {
    return { ok: true, method: 'apply', conflicts: false, output: text(plain) || 'Değişiklikler temiz şekilde uygulandı.' };
  }
  const three = await git(['apply', '--3way', '--whitespace=nowarn', '-'], { cwd: top, input: patch });
  const out3 = text(three);
  const output = `$ git apply\n${text(plain)}\n\n$ git apply --3way\n${out3 || (three.ok ? 'tamam' : 'başarısız')}`;
  return { ok: three.ok, method: '3way', conflicts: /with conflicts/i.test(out3), output };
}

// Read-only git for agents without a terminal of their own: what changed (status / diff against the
// last commit, untracked files included), history and old versions. Allowed in every permission;
// nothing here writes to the repository or the user's index.
import path from 'node:path';
import * as git from '../git.js';
import { reviewDiff } from '../orchestrator/diffview.js';
import { clipMiddle } from './budget.js';
import { safePath } from './paths.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NOT_GIT = 'Proje bir git deposu değil.';

async function top(cwd) {
  const r = await git.git(['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

/** A commit / branch name an agent may pass (no options, no shell characters). */
const validRef = (ref) => /^[\w./~^@{}-]+$/.test(String(ref)) && !String(ref).startsWith('-');

const fail = (r) => `git hatası: ${(r.stderr || r.stdout || '').trim().slice(0, 400) || 'bilinmeyen hata'}`;

/** `git status --short --branch`. */
export async function gitStatus(cwd, max = 6000) {
  if (!await top(cwd)) return NOT_GIT;
  const r = await git.git(['status', '--short', '--branch'], { cwd });
  if (!r.ok) return fail(r);
  return clipMiddle(r.stdout.trim() || '(temiz)', max);
}

/**
 * Working tree (untracked files included) against the last commit, or against `base` (a commit /
 * branch). `path` limits it to a file or folder. Sized to `max` with diffview (binary files and
 * lockfiles summarized, cut files named).
 */
export async function gitDiff(cwd, { path: p = '', base = 'HEAD', max = 20_000 } = {}) {
  const root = await top(cwd);
  if (!root) return NOT_GIT;
  if (!validRef(base)) return `Geçersiz commit: ${base}`;
  const head = await git.git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd });
  const from = head.ok ? head.stdout.trim() : base === 'HEAD' ? EMPTY_TREE : null;
  if (!from) return `Böyle bir commit/dal yok: ${base}`;
  const tree = await git.snapshotTree(root);
  const args = ['diff', '--binary', '--no-color', '--no-ext-diff', from, tree];
  if (p) args.push('--', safePath(cwd, p).abs);
  const r = await git.git(args, { cwd: root });
  if (!r.ok) return fail(r);
  return reviewDiff(r.stdout, max).text;
}

/** Last `n` commits (of `path`): "a1b2c3d 2026-10-16 Ad Soyad — mesaj". */
export async function gitLog(cwd, { path: p = '', n = 15, max = 6000 } = {}) {
  if (!await top(cwd)) return NOT_GIT;
  const count = Math.max(1, Math.min(50, Number(n) || 15));
  const args = ['log', `-n${count}`, '--date=short', '--format=%h %ad %an — %s'];
  if (p) args.push('--', safePath(cwd, p).abs);
  const r = await git.git(args, { cwd });
  if (!r.ok) return /does not have any commits/i.test(r.stderr) ? 'Henüz commit yok.' : fail(r);
  return clipMiddle(r.stdout.trim() || '(commit yok)', max);
}

/** A commit's message and changed files, or a file as it was in that commit (`path`). */
export async function gitShow(cwd, { rev = 'HEAD', path: p = '', max = 20_000 } = {}) {
  const root = await top(cwd);
  if (!root) return NOT_GIT;
  const ref = String(rev || 'HEAD').trim();
  if (!validRef(ref)) return `Geçersiz commit: ${ref}`;
  if (p) {
    const rel = path.relative(root, safePath(cwd, p).abs).replace(/\\/g, '/');
    const r = await git.git(['show', `${ref}:${rel}`], { cwd: root });
    if (!r.ok) return fail(r);
    return clipMiddle(r.stdout, max);
  }
  const r = await git.git(['show', '--stat', '--format=%h %ad %an%n%n%B', '--date=short', ref], { cwd });
  if (!r.ok) return fail(r);
  return clipMiddle(r.stdout.trim(), max);
}

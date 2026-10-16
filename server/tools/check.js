// Quick syntax check of a file an agent just wrote, so a broken edit is reported in the same tool
// result instead of three turns later in a failing test. Cheap and offline: `node --check` for
// JavaScript, JSON.parse for JSON, Python's ast.parse when Python is installed. Other files: none.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { which } from '../adapters/base.js';

const JS = new Set(['.js', '.mjs', '.cjs']);
const CHECK_MS = 10_000;
const FILE_MAX = 2 * 1024 * 1024;

let python; // undefined = not looked up yet, null = none
const pythonPath = () => (python === undefined ? (python = which('python3') || which('python') || null) : python);

function run(file, args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), CHECK_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: String(out) }); });
  });
}

/** "SyntaxError: Unexpected token" + the offending line, from node --check output. */
function nodeMessage(out, abs, rel) {
  const lines = out.replace(/\r/g, '').split('\n').map((l) => l.split(abs).join(rel));
  const where = lines.find((l) => l.startsWith(rel) || l.includes(`${rel}:`)) || '';
  const what = lines.find((l) => /^\w*Error\b/.test(l)) || lines.find((l) => l.trim()) || 'sözdizimi hatası';
  const code = lines[lines.indexOf(where) + 1]?.trim();
  return [where.replace(/^file:\/\/\S*?(\S+:\d+)/, '$1'), what, code && `  ${code}`].filter(Boolean).join(' — ');
}

/** Line/column of a JSON.parse error ("at position 120" / "line 4 column 3"). */
function jsonWhere(text, err) {
  const m = /position (\d+)/.exec(err.message);
  if (!m) return err.message;
  const pos = Number(m[1]);
  const line = text.slice(0, pos).split('\n').length;
  return `${err.message.replace(/ in JSON at position \d+.*$/, '')} (satır ${line})`;
}

/**
 * Syntax problem of the file at `abs` (shown as `rel`), or null when it looks fine or can't be
 * checked. Never throws.
 */
export async function checkFile(abs, rel) {
  const ext = path.extname(abs).toLowerCase();
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > FILE_MAX) return null;
    if (JS.has(ext)) {
      // `node --check` on a .js file with import/export falls back to module detection and then
      // reports nothing at all, even for a broken file: check such files as an .mjs copy.
      const text = await fs.readFile(abs, 'utf8');
      const esm = ext === '.js' && /^\s*(import\s*[\w{*'"]|export\s)/m.test(text);
      if (!esm) {
        const r = await run(process.execPath, ['--check', abs], path.dirname(abs));
        return r && r.code !== 0 ? nodeMessage(r.out, abs, rel) : null;
      }
      const tmp = path.join(os.tmpdir(), `ortak-check-${randomBytes(4).toString('hex')}.mjs`);
      await fs.writeFile(tmp, text, 'utf8');
      try {
        const r = await run(process.execPath, ['--check', tmp], os.tmpdir());
        return r && r.code !== 0 ? nodeMessage(r.out, tmp, rel) : null;
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    }
    if (ext === '.json') {
      const text = await fs.readFile(abs, 'utf8');
      try { JSON.parse(text); return null; } catch (err) {
        // tsconfig / VS Code settings are JSON with comments: not an error
        if (/^\s*\/\/|\/\*/m.test(text) || /(^|\/)(tsconfig|jsconfig)[^/]*\.json$|\.vscode\//.test(rel)) return null;
        return `JSON geçersiz: ${jsonWhere(text, err)}`;
      }
    }
    if (ext === '.py' && pythonPath()) {
      const r = await run(pythonPath(), ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', abs], path.dirname(abs));
      if (!r || r.code === 0) return null;
      const lines = r.out.replace(/\r/g, '').trim().split('\n');
      const lineNo = /line (\d+)/.exec(r.out)?.[1];
      return `${lines.at(-1)}${lineNo ? ` (satır ${lineNo})` : ''}`;
    }
  } catch { /* unreadable: nothing to say */ }
  return null;
}

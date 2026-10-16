// OpenCode adapter (opencode 2.x): `opencode run --standalone --format json`, prompt on stdin.
// See opencode-core.js for the event/permission mapping.
//
// Models: `opencode models` lists what this machine can use right now — without an account only
// the free OpenCode Zen models (provider `opencode`, ids ending in -free, Big Pickle). Display names
// and prices come from OpenCode's public models.dev cache (~/.cache/opencode/models.json).
// `--standalone` runs a private server per turn, so the inline permission config applies and the
// user's background OpenCode service is left alone.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capture, cleanEnv } from './base.js';
import { createOpencodeAdapter, resolveBin } from './opencode-core.js';

const NAME = 'OpenCode';
const PREFERRED = ['opencode/deepseek-v4.1-flash-free', 'opencode/big-pickle', 'opencode/nemotron-3-ultra-free'];

const bin = () => resolveBin('opencode', path.join('node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));

const cacheFile = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'opencode', 'models.json');

/** "DeepSeek V4.1 Flash Free" → "DeepSeek V4.1 Flash (ücretsiz)". */
function cleanLabel(name, free) {
  const base = String(name).replace(/\s*\(free\)\s*$/i, '').replace(/\s+free$/i, '').trim();
  return free ? `${base} (ücretsiz)` : base;
}

async function loadModels(file) {
  const r = await capture(file, ['models', '--standalone'], { timeoutMs: 25000, env: cleanEnv({ NO_COLOR: '1' }) });
  const ids = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((l) => /^[A-Za-z0-9._-]+\/\S+$/.test(l));
  if (!ids.length) return [];
  let catalog = {};
  try { catalog = JSON.parse(await readFile(cacheFile(), 'utf8')); } catch { /* names fall back to ids */ }
  const models = ids.map((full) => {
    const [provider, ...rest] = full.split('/');
    const id = rest.join('/');
    const info = catalog[provider]?.models?.[id] || {};
    const free = /-free$/.test(id) || (info.cost && !info.cost.input && !info.cost.output);
    const providerName = catalog[provider]?.name || provider;
    return { id: full, label: cleanLabel(info.name || id, free), group: free ? 'Ücretsiz' : providerName, free: !!free };
  });
  models.sort((a, b) => (b.free - a.free) || a.group.localeCompare(b.group, 'tr') || a.label.localeCompare(b.label, 'tr'));
  const def = PREFERRED.map((id) => models.find((m) => m.id === id)).find(Boolean) || models.find((m) => m.free) || models[0];
  def.default = true;
  return models;
}

export default createOpencodeAdapter({
  id: 'opencode',
  name: NAME,
  notInstalled: 'OpenCode bulunamadı: `npm i -g @opencode/cli` ile kurun (`opencode` PATH üzerinde olmalı).',
  bin,
  runArgs: ['run', '--standalone'],
  configEnv: 'OPENCODE_CONFIG_CONTENT',
  loadModels,
  loginArgs: ['auth', 'login'],
  loginHint: 'Ücretsiz modeller hesapsız çalışır; ücretli modeller için terminalde `opencode auth login` ile bir sağlayıcı bağlayın.',
  limitsNote: 'Ücretsiz OpenCode Zen modelleri: kota bilgisi yayınlanmıyor',
});

// Kilo Code adapter (Kilo CLI 7.x, a fork of OpenCode): `kilo run --format json`, prompt on stdin.
// See opencode-core.js for the event/permission mapping (inline config: KILO_CONFIG_CONTENT).
//
// Models: `kilo models --verbose` prints every model of the Kilo Gateway with metadata (`isFree`,
// prices, variants). Free models (`…:free`, Auto Free) work without an account; the rest need a
// Kilo account with credits (`kilo auth login`), so they are listed locked until one is connected.
import { capture, cleanEnv, which } from './base.js';
import { createOpencodeAdapter } from './opencode-core.js';

const NAME = 'Kilo Code';
const DEFAULT_MODEL = 'kilo/kilo-auto/free';
const AUTO_TR = { free: '', balanced: '(dengeli)', efficient: '(verimli)', frontier: '(en güçlü)', small: '(küçük)' };

// `kilo.cmd` → node launcher → native kilo.exe (the launcher picks the right CPU build).
const bin = () => which('kilo') || which('kilocode');

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\[\d+m/g, '');

/** "kilo/x\n{…json…}" blocks of `kilo models --verbose`. */
export function parseVerbose(text) {
  const out = [];
  const re = /^([^\s{}]+\/[^\s{}]+)\r?\n(\{[\s\S]*?\r?\n\})/gm;
  let m;
  while ((m = re.exec(text))) {
    try { out.push({ full: m[1], info: JSON.parse(m[2]) }); } catch { /* skip */ }
  }
  return out;
}

/** "NVIDIA: Nemotron 3 Ultra (free)" → { vendor: "NVIDIA", label: "Nemotron 3 Ultra" }. */
function splitName(name) {
  let s = String(name || '').replace(/\s*\((free|\$+)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  const i = s.indexOf(': ');
  const vendor = i > 0 ? s.slice(0, i) : '';
  if (i > 0) s = s.slice(i + 2);
  return { vendor, label: s };
}

async function connectedAccounts(file) {
  const r = await capture(file, ['auth', 'list'], { timeoutMs: 15000, env: cleanEnv({ NO_COLOR: '1' }) });
  const m = stripAnsi(`${r.stdout}\n${r.stderr}`).match(/(\d+)\s+credentials?/i);
  return m ? Number(m[1]) : 0;
}

async function loadModels(file) {
  const env = cleanEnv({ NO_COLOR: '1' });
  const [r, accounts] = await Promise.all([
    capture(file, ['models', '--verbose'], { timeoutMs: 30000, env }),
    connectedAccounts(file).catch(() => 0),
  ]);
  const parsed = parseVerbose(r.stdout);
  if (!parsed.length) return [];
  // One group per vendor id ("qwen", "~qwen"): named after the vendor its models mostly give.
  const vendorKey = (info, full) => String(info.id || full.split('/').slice(1).join('/')).replace(/^~/, '').split('/')[0].toLowerCase();
  const votes = new Map();
  for (const { full, info } of parsed) {
    const v = splitName(info.name).vendor;
    if (!v) continue;
    const key = vendorKey(info, full);
    const counts = votes.get(key) || new Map();
    counts.set(v, (counts.get(v) || 0) + 1);
    votes.set(key, counts);
  }
  const groupName = (key) => {
    if (key === 'kilo-auto') return 'Kilo Otomatik';
    const counts = votes.get(key);
    if (counts) return [...counts].sort((a, b) => b[1] - a[1])[0][0];
    return key.charAt(0).toUpperCase() + key.slice(1);
  };
  const models = parsed.map(({ full, info }) => {
    const free = info.isFree === true;
    const { label } = splitName(info.name || full.split('/').slice(1).join('/'));
    const auto = /^kilo-auto\//.test(info.id || '');
    const nice = auto ? `Otomatik ${AUTO_TR[(info.id || '').split('/')[1]] ?? label.replace(/^Auto\s*/i, '').toLowerCase()}`.trim() : label;
    const group = free ? 'Ücretsiz' : groupName(vendorKey(info, full));
    const m = { id: full, label: free ? `${nice.replace(/\s*free$/i, '')} (ücretsiz)` : nice, group, free };
    if (!free && !accounts) {
      m.disabled = true;
      m.note = 'Ücretli: Kilo hesabı ve kredi gerekir (Ajanlar panelinde "Hesap bağla").';
    }
    return m;
  });
  models.sort((a, b) => (b.free - a.free) || (a.id === DEFAULT_MODEL ? -1 : b.id === DEFAULT_MODEL ? 1 : 0) ||
    a.group.localeCompare(b.group, 'tr') || a.label.localeCompare(b.label, 'tr'));
  const def = models.find((m) => m.id === DEFAULT_MODEL) || models.find((m) => m.free) || models[0];
  def.default = true;
  return models;
}

export default createOpencodeAdapter({
  id: 'kilo',
  name: NAME,
  notInstalled: 'Kilo Code CLI bulunamadı: `npm i -g @kilocode/cli` ile kurun (`kilo` PATH üzerinde olmalı).',
  bin,
  runArgs: ['run'],
  configEnv: 'KILO_CONFIG_CONTENT',
  loadModels,
  loginArgs: ['auth', 'login'],
  loginHint: 'Ücretsiz modeller hesapsız çalışır; ücretli modeller için terminalde `kilo auth login` ile Kilo hesabınızı bağlayın.',
  limitsNote: 'Ücretsiz Kilo modelleri: kota bilgisi yayınlanmıyor',
});

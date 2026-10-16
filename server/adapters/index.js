// Adapter registry. Adapters are loaded lazily so a broken/missing adapter never takes the
// server down; it just shows up as unavailable with the load error.
const MODULES = ['claude', 'codex', 'antigravity', 'geminiweb', 'opencode', 'kilo', 'copilot', 'junie', 'evren', 'openrouter', 'groq'];

const mockEnabled = () => process.argv.includes('--mock') || process.env.ORTAK_MOCK === '1';

let cache = null;

export async function loadAdapters() {
  if (cache) return cache;
  const names = mockEnabled() ? [...MODULES, 'mock'] : MODULES;
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      const mod = await import(`./${name}.js`);
      return mod.default;
    } catch (err) {
      return brokenAdapter(name, err);
    }
  }));
  cache = new Map(loaded.map((a) => [a.id, a]));
  return cache;
}

export async function getAdapter(id) {
  const adapters = await loadAdapters();
  const a = adapters.get(id);
  if (!a) throw new Error(`Bilinmeyen ajan: ${id}`);
  return a;
}

function brokenAdapter(id, err) {
  const reason = `Adaptör yüklenemedi: ${err?.message || err}`;
  return {
    id,
    name: id,
    capabilities: { edit: false, resume: false, streaming: false, cwd: false, sandbox: false },
    async detect() { return { available: false, reason }; },
    async listModels() { return []; },
    async getLimits() { return null; },
    async run() { throw new Error(reason); },
  };
}

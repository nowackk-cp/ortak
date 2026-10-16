// Manually exercise one adapter:
//   node scripts/try-adapter.mjs <agentId> detect|models|limits
//   node scripts/try-adapter.mjs <agentId> run "prompt" [--model m] [--cwd dir] [--perm read-only|edit|full] [--session id]
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , agentId, action = 'detect', ...rest] = process.argv;
if (!agentId) {
  console.error('kullanım: node scripts/try-adapter.mjs <claude|codex|antigravity|mock> <detect|models|limits|run> [prompt] [--model m] [--cwd d] [--perm p] [--session s]');
  process.exit(1);
}

const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

const file = path.resolve(import.meta.dirname, '..', 'server', 'adapters', `${agentId}.js`);
const adapter = (await import(pathToFileURL(file).href)).default;

const t0 = Date.now();
if (action === 'detect') console.log(await adapter.detect());
else if (action === 'models') console.log(await adapter.listModels());
else if (action === 'limits') console.dir(await adapter.getLimits(), { depth: 5 });
else if (action === 'run') {
  const ctrl = new AbortController();
  process.on('SIGINT', () => ctrl.abort());
  try {
    const res = await adapter.run({
      prompt: positional.join(' ') || 'Sadece "ok" yaz.',
      cwd: path.resolve(flags.cwd || process.cwd()),
      model: flags.model,
      sessionId: flags.session,
      permission: flags.perm || 'read-only',
      signal: ctrl.signal,
      onEvent: (e) => {
        if (e.type === 'text-delta') process.stdout.write(e.text);
        else console.log('\n[event]', JSON.stringify(e).slice(0, 300));
      },
    });
    console.log('\n[result]', JSON.stringify(res).slice(0, 1000));
  } catch (err) {
    console.error('\n[rejected]', err.name, err.message);
    process.exitCode = 1;
  }
}
console.log(`(${Date.now() - t0} ms)`);

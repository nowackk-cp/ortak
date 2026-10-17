import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTeam, modelTier } from '../server/tiers.js';
import { buildCatalog, parseRef, findModel } from '../server/catalog.js';
import { catalogBlock } from '../server/orchestrator/prompts.js';

const agent = (id, models, extra = {}) => ({ id, name: id, available: true, models, ...extra });
const AGENTS = [
  agent('claude', [{ id: 'default', default: true }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }]),
  agent('codex', [{ id: 'default', default: true }]),
  agent('gemini', [{ id: 'default', default: true }, { id: 'argon-high' }]),
  agent('groq', [{ id: 'qwen', default: true, free: true }]),
  agent('openrouter', [{ id: 'openrouter/free', default: true, free: true }]),
  agent('kilo', [{ id: 'anthropic/claude', default: true }, { id: 'kilo/auto/free', free: true }]),
  agent('evren', [{ id: 'pahali', default: true }, { id: 'glm-5.3' }]),
  agent('copilot', [{ id: 'auto', default: true, free: true }, { id: 'claude-opus' }]),
  agent('antigravity', [{ id: 'flash', default: true }], { available: false }),
];

test('modelTier: model işareti ajan varsayılanını ezer', () => {
  assert.equal(modelTier('claude', { id: 'opus' }), 'subscription');
  assert.equal(modelTier('kilo', { id: 'x', free: true }), 'free');
  assert.equal(modelTier('kilo', { id: 'x' }), 'paid');
  assert.equal(modelTier('evren', { id: 'glm-5.3' }), 'credit');
  assert.equal(modelTier('gemini', null), 'free');
});

test('autoTeam: ücretsiz öncelikli — ücretsizler ve kredi; Claude/Codex otomatik eklenmez', () => {
  const team = autoTeam(AGENTS, { budget: 'free-first', lead: { agentId: 'claude', model: 'opus' } });
  assert.deepEqual(team.map((w) => `${w.agentId}:${w.model}:${w.tier}${w.backup ? ':yedek' : ''}`), [
    'gemini:argon-high:free', 'groq:qwen:free', 'copilot:auto:free', 'openrouter:openrouter/free:free', 'evren:glm-5.3:credit',
    'kilo:kilo/auto/free:free',
  ]);
});

test('autoTeam: yalnızca ücretsiz ve serbest', () => {
  const free = autoTeam(AGENTS, { budget: 'free-only', lead: { agentId: 'claude', model: 'opus' } });
  assert.ok(free.every((w) => w.tier === 'free'));
  assert.equal(free.length, 5);
  const any = autoTeam(AGENTS, { budget: 'any', lead: { agentId: 'claude', model: 'sonnet' } });
  assert.ok(!any.some((w) => w.agentId === 'claude' && w.model === 'sonnet'), 'yönetici alt ajan olmaz');
  assert.ok(!any.some((w) => ['claude', 'codex'].includes(w.agentId)));
  assert.ok(any.length <= 8);
});

test('model kataloğu: sağlayıcı:model adları, bütçe, yedekler, kopya sayısı', async () => {
  const agents = [
    { id: 'openrouter', name: 'OpenRouter', available: true, capabilities: { edit: false }, models: [
      { id: 'deepseek/deepseek-v3:free', label: 'DeepSeek V3 (ücretsiz)', free: true },
      { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder 480B (ücretsiz)', free: true },
    ] },
    { id: 'evren', name: 'EVREN', available: true, capabilities: { edit: false }, models: [{ id: 'glm-5.3', label: 'GLM 5.3' }, { id: 'mini-free', free: true }] },
    { id: 'claude', name: 'Claude Code', available: true, capabilities: { edit: true }, models: [{ id: 'default' }, { id: 'sonnet', default: true }, { id: 'opus' }] },
    { id: 'kilo', name: 'Kilo', available: true, capabilities: { edit: true }, models: [{ id: 'paid-x' }] },
    { id: 'groq', name: 'Groq', available: false, capabilities: { edit: false }, models: [{ id: 'q' }] },
  ];
  const cat = await buildCatalog(agents, { budget: 'free-first' });
  assert.deepEqual(cat.map((p) => [p.agentId, p.models.map((m) => `${m.ref}:${m.tier}${m.backup ? ':yedek' : ''}`)]), [
    ['openrouter', ['openrouter:deepseek/deepseek-v3:free:free', 'openrouter:qwen/qwen3-coder:free:free']],
    ['evren', ['evren:mini-free:free', 'evren:glm-5.3:credit']],
  ]);
  assert.equal(cat[0].copies, 4);
  assert.ok(!cat.some((p) => p.agentId === 'claude'));
  const only = await buildCatalog(agents, { budget: 'free-only' });
  assert.deepEqual(only.map((p) => p.agentId), ['openrouter', 'evren']);

  const ids = cat.map((p) => p.agentId);
  assert.deepEqual(parseRef('openrouter:qwen/qwen3-coder:free', ids), { agentId: 'openrouter', model: 'qwen/qwen3-coder:free' });
  assert.deepEqual(parseRef('@EVREN', ids), { agentId: 'evren', model: null });
  assert.equal(parseRef('yok:model', ids), null);
  assert.equal(findModel(cat, { agentId: 'openrouter', model: 'qwen/qwen3-coder' }).model.id, 'qwen/qwen3-coder:free');
  assert.equal(findModel(cat, { agentId: 'evren', model: null }).model.id, 'mini-free');
  assert.equal(findModel(cat, { agentId: 'evren', model: 'yok' }), null);

  const block = catalogBlock(cat);
  assert.match(block, /kopya: openrouter:deepseek\/deepseek-v3:free, openrouter:qwen\/qwen3-coder:free \(Qwen3 Coder 480B\)\n/);
  assert.match(block, /EVREN — KREDİ \(EVREN bakiyesi\) — Ortak onun elleri olur/);
  assert.doesNotMatch(block, /Claude Code/);
  assert.match(block, /aynı anda 4 kopya/);
});

test('Claude/Codex kataloğu yalnızca açıkça seçilen modeli açar; serbest bütçe tek başına izin değildir', async () => {
  assert.ok(!(await buildCatalog(AGENTS, { budget: 'any' })).some((p) => ['claude', 'codex'].includes(p.agentId)));
  const cat = await buildCatalog(AGENTS, { budget: 'free-first', approvedWorkers: [{ agentId: 'claude', model: 'sonnet' }] });
  assert.deepEqual(cat.find((p) => p.agentId === 'claude').models.map((m) => m.id), ['sonnet']);
  assert.ok(!cat.some((p) => p.agentId === 'codex'));
});

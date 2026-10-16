import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTeam, modelTier } from '../server/tiers.js';

const agent = (id, models, extra = {}) => ({ id, name: id, available: true, models, ...extra });
const AGENTS = [
  agent('claude', [{ id: 'default', default: true }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }]),
  agent('codex', [{ id: 'default', default: true }]),
  agent('gemini', [{ id: 'default', default: true }, { id: 'argon-high' }]),
  agent('groq', [{ id: 'qwen', default: true, free: true }]),
  agent('openrouter', [{ id: 'openrouter/free', default: true, free: true }]),
  agent('kilo', [{ id: 'anthropic/claude', default: true }, { id: 'kilo/auto/free', free: true }]),
  agent('evren', [{ id: 'pahali', default: true }]),
  agent('antigravity', [{ id: 'flash', default: true }], { available: false }),
];

test('modelTier: model işareti ajan varsayılanını ezer', () => {
  assert.equal(modelTier('claude', { id: 'opus' }), 'subscription');
  assert.equal(modelTier('kilo', { id: 'x', free: true }), 'free');
  assert.equal(modelTier('kilo', { id: 'x' }), 'paid');
  assert.equal(modelTier('gemini', null), 'free');
});

test('autoTeam: ücretsiz öncelikli — ücretsizler + iki yedek, yönetici ve ücretliler hariç', () => {
  const team = autoTeam(AGENTS, { budget: 'free-first', lead: { agentId: 'claude', model: 'opus' } });
  assert.deepEqual(team.map((w) => `${w.agentId}:${w.model}:${w.tier}${w.backup ? ':yedek' : ''}`), [
    'gemini:argon-high:free', 'groq:qwen:free', 'openrouter:openrouter/free:free', 'kilo:kilo/auto/free:free',
    'claude:sonnet:subscription:yedek', 'codex:default:subscription:yedek',
  ]);
});

test('autoTeam: yalnızca ücretsiz ve serbest', () => {
  const free = autoTeam(AGENTS, { budget: 'free-only', lead: { agentId: 'claude', model: 'opus' } });
  assert.ok(free.every((w) => w.tier === 'free'));
  assert.equal(free.length, 4);
  const any = autoTeam(AGENTS, { budget: 'any', lead: { agentId: 'claude', model: 'sonnet' } });
  assert.ok(!any.some((w) => w.agentId === 'claude' && w.model === 'sonnet'), 'yönetici alt ajan olmaz');
  assert.ok(any.some((w) => w.agentId === 'claude' && w.model === 'haiku'));
  assert.ok(any.length <= 8);
});

import { makeRepo, fakeCtx, editAgent, textAgent, notes, callsOf } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import lead from '../server/orchestrator/lead.js';

const AGENTS = { claude: editAgent('claude'), groq: textAgent('groq'), gemini: textAgent('gemini') };
const LANES = [
  { lane: 'lead', agentId: 'claude', model: 'opus', role: 'lead', title: 'Claude Code · Opus 5.5', tier: 'subscription' },
  { lane: 'groq', agentId: 'groq', model: 'qwen', role: 'worker', title: 'Groq · Qwen 3.8', tier: 'free' },
  { lane: 'gemini', agentId: 'gemini', model: 'argon-high', role: 'worker', title: 'Gemini (web) · 4 Argon', tier: 'free' },
  { lane: 'claude', agentId: 'claude', model: 'sonnet', role: 'worker', title: 'Claude Code · Sonnet 5.5', tier: 'subscription' },
];
const TASK = '```json\n{"tasks":[{"id":"t1","agent":"qwen","task":"README\'ye bir satır ekle"}],"done":false}\n```';
const DONE = '```json\n{"tasks":[],"done":true,"summary":"Bitti."}\n```';

test('yönetici bütçe kurallarını ve ajanların ücret sınıfını görür; limitte görev ücretsiz ajana devredilir', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: LANES, agents: AGENTS, config: { mode: 'lead', budget: 'free-first', steps: 4, autoTeam: true },
    script: async (lane, opts, call) => {
      if (lane === 'lead') return call.n === 1 ? TASK : DONE;
      if (lane === 'groq') throw new Error('Groq istek limiti doldu (429): günlük istek hakkı bitti');
      return 'Ekledim.\nÖZET: README güncellendi';
    },
  });
  assert.equal(await lead.start(ctx), 'waiting');
  const first = callsOf(ctx, 'lead')[0].prompt;
  assert.match(first, /@qwen — Groq · Qwen 3\.8 — ÜCRETSİZ/);
  assert.match(first, /@sonnet — Claude Code · Sonnet 5\.5 — ABONELİK — kullanıcının ücretli plan limitini harcar \(YEDEK\)/);
  assert.match(first, /BÜTÇE \(ücretsiz öncelikli\)/);
  assert.match(first, /KENDİ LİMİTİNİ KORU/);
  assert.ok(notes(ctx).some((t) => /t1: @qwen limiti doldu; görev @argon ajanına devredildi/.test(t)), notes(ctx).join('\n'));
  assert.ok(notes(ctx).some((t) => /Ekip \(otomatik · ücretsiz öncelikli\)/.test(t)));
  assert.equal(callsOf(ctx, 'claude').length, 0, 'abonelikli yedek kullanılmadı');
  assert.deepEqual(ctx.state.exhausted, ['groq']);
  const review = callsOf(ctx, 'lead')[1].prompt;
  assert.match(review, /@qwen limitine ulaştı/);
  const result = ctx.events.find((e) => e.kind === 'result').text;
  assert.match(result, /\*\*Maliyet:\*\* ücretsiz ajanlar 1 görev · yönetici 2 tur/);
});

test('limiti dolan ajana sonradan verilen görev başka ajana yönlendirilir', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: LANES, agents: AGENTS, config: { mode: 'lead', budget: 'free-first', steps: 4 },
    state: { exhausted: ['groq'] },
    script: async (lane, opts, call) => {
      if (lane === 'lead') return call.n === 1 ? TASK : DONE;
      return 'ÖZET: tamam';
    },
  });
  await lead.start(ctx);
  assert.equal(callsOf(ctx, 'groq').length, 0);
  assert.equal(callsOf(ctx, 'gemini').length, 1);
  assert.ok(notes(ctx).some((t) => /@qwen limitine ulaşmıştı; görev @argon ajanına verildi/.test(t)));
});

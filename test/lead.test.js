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
  assert.match(first, /Bu çalışmanın yetkisi: DÜZENLEME — alt ajanlar proje klasöründe dosya yazar/);
  assert.match(callsOf(ctx, 'lead')[0].system, /BİLEREK salt okunur açılır/);
  assert.ok(notes(ctx).some((t) => /t1: groq:qwen limiti doldu; görev gemini:argon-high modeline devredildi/.test(t)), notes(ctx).join('\n'));
  assert.ok(notes(ctx).some((t) => /Ekip \(otomatik · ücretsiz öncelikli\)/.test(t)));
  assert.equal(callsOf(ctx, 'claude').length, 0, 'abonelikli yedek kullanılmadı');
  assert.deepEqual(ctx.state.exhausted, ['groq:qwen']);
  const review = callsOf(ctx, 'lead')[1].prompt;
  assert.match(review, /groq:qwen limitine ulaştı/);
  const result = ctx.events.find((e) => e.kind === 'result').text;
  assert.match(result, /\*\*Maliyet:\*\* ücretsiz ajanlar 1 görev · yönetici 2 tur/);
});

test('limiti dolan ajana sonradan verilen görev başka ajana yönlendirilir', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: LANES, agents: AGENTS, config: { mode: 'lead', budget: 'free-first', steps: 4 },
    state: { exhausted: ['groq:qwen'] },
    script: async (lane, opts, call) => {
      if (lane === 'lead') return call.n === 1 ? TASK : DONE;
      return 'ÖZET: tamam';
    },
  });
  await lead.start(ctx);
  assert.equal(callsOf(ctx, 'groq').length, 0);
  assert.equal(callsOf(ctx, 'gemini').length, 1);
  assert.ok(notes(ctx).some((t) => /groq:qwen limitine ulaşmıştı; görev gemini:argon-high modeline verildi/.test(t)));
});

test('tam yetkili çalışmada yönetici her mesajda ekibin yazabildiğini öğrenir (oturum sürse de)', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: LANES, agents: AGENTS, config: { mode: 'lead', budget: 'free-first', steps: 4, permission: 'full' },
    script: async (lane, opts, call) => (lane === 'lead' ? DONE : 'ÖZET: tamam'),
  });
  await lead.start(ctx);
  await lead.followUp(ctx, { text: 'devam et ve testleri yaz' });
  const [first, second] = callsOf(ctx, 'lead');
  assert.match(first.prompt, /TAM YETKİ — alt ajanlar onay sormadan dosya yazar/);
  assert.equal(second.resumed, true);
  assert.match(second.prompt, /^Bu çalışmanın yetkisi: TAM YETKİ/);
  assert.doesNotMatch(first.prompt, /Bu çalışma SALT OKUNUR/);
});

test('yönetici katalogdan model seçer: meşgul modelin yeni kopyası açılır, aynı anda en fazla N görev, tek kopyalı ajan model değiştirir', async () => {
  const cwd = await makeRepo();
  const agents = { claude: editAgent('claude'), openrouter: textAgent('openrouter'), gemini: textAgent('gemini') };
  const lanes = [
    { lane: 'lead', agentId: 'claude', model: 'opus', role: 'lead', title: 'Claude Code · Opus 5.5', tier: 'subscription' },
    { lane: 'gemini', agentId: 'gemini', model: 'argon-high', role: 'worker', title: 'Gemini (web) · 4 Argon', tier: 'free' },
  ];
  const plan = '```json\n{"tasks":[' +
    '{"id":"a","agent":"openrouter:qwen/qwen3-coder:free","task":"a.js yaz"},' +
    '{"id":"b","agent":"openrouter:qwen/qwen3-coder","task":"b.js yaz"},' +
    '{"id":"c","agent":"openrouter:qwen/qwen3-coder:free","task":"c.js yaz"},' +
    '{"id":"d","agent":"argon","task":"d.js yaz"},' +
    '{"id":"e","agent":"gemini:pro","task":"hepsini gözden geçir","after":["d"]}' +
    '],"done":false}\n```';
  let active = 0;
  let peak = 0;
  const ctx = fakeCtx({
    cwd, lanes, agents, config: { mode: 'lead', budget: 'free-first', steps: 4, parallel: 3 },
    script: async (lane, opts, call) => {
      if (lane === 'lead') return call.n === 1 ? plan : DONE;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      return 'ÖZET: tamam';
    },
  });
  ctx.catalogSource = async () => [
    { agentId: 'openrouter', name: 'OpenRouter', own: false, copies: 4, models: [{ id: 'qwen/qwen3-coder:free', ref: 'openrouter:qwen/qwen3-coder:free', label: 'Qwen3 Coder', tier: 'free' }] },
    { agentId: 'gemini', name: 'Gemini (web)', own: false, copies: 1, models: [
      { id: 'argon-high', ref: 'gemini:argon-high', label: '4 Argon', tier: 'free' },
      { id: 'pro', ref: 'gemini:pro', label: 'Pro', tier: 'free' },
    ] },
  ];
  await lead.start(ctx);
  const first = callsOf(ctx, 'lead')[0].prompt;
  assert.match(first, /Model kataloğu/);
  assert.match(first, /openrouter:qwen\/qwen3-coder:free/);
  assert.match(first, /aynı anda en fazla 3 görev/);
  assert.equal(peak, 3, 'paralel sınır');
  const orLanes = ctx.lanes('worker').filter((l) => l.agentId === 'openrouter').map((l) => l.lane);
  assert.deepEqual(orLanes, ['openrouter', 'openrouter#2', 'openrouter#3']);
  assert.ok(ctx.lanes('worker').every((l) => l.agentId !== 'openrouter' || l.model === 'qwen/qwen3-coder:free'));
  for (const l of orLanes) assert.equal(callsOf(ctx, l).length, 1);
  assert.equal(ctx.lane('gemini').model, 'pro', 'tek kopyalı Gemini sonraki görev için modelini değiştirdi');
  assert.equal(callsOf(ctx, 'gemini').length, 2);
  assert.ok(notes(ctx).some((t) => /ekibe katıldı/.test(t)));
  assert.ok(notes(ctx).some((t) => /@pro: Gemini · 4 Argon yerine Gemini · Pro ile çalışacak/.test(t)), notes(ctx).join('\n'));
  assert.ok(notes(ctx).some((t) => /@qwen3-coder-2 ekibe katıldı/.test(t)) && notes(ctx).some((t) => /@qwen3-coder-3 ekibe katıldı/.test(t)));
  assert.ok(notes(ctx).some((t) => /Yönetici 3 model görüyor; .* aynı anda en fazla 3 görev/.test(t)));
  const result = ctx.events.find((e) => e.kind === 'result').text;
  assert.match(result, /ücretsiz ajanlar 5 görev/);
  const tasks = ctx.events.filter((e) => e.kind === 'task');
  assert.equal(tasks.filter((e) => e.state === 'running').length, 5);
  assert.equal(tasks.filter((e) => e.state === 'done').length, 5);
});

test('çalışma sürerken yazılan mesaj yöneticiye hemen gider; yönetici süren ve bekleyen görevi iptal eder', async () => {
  const cwd = await makeRepo();
  const plan = '```json\n{"tasks":[{"id":"t1","agent":"qwen","task":"uzun iş"},{"id":"t2","agent":"argon","task":"sonraki iş","after":["t1"]}],"done":false}\n```';
  const ctx = fakeCtx({
    cwd, lanes: LANES, agents: AGENTS, config: { mode: 'lead', budget: 'free-first', steps: 4 },
    script: async (lane, opts, call) => {
      if (lane === 'lead') {
        if (call.n === 1) return plan;
        if (call.n === 2) return 'Tamam, vazgeçiyoruz.\n```json\n{"tasks":[],"cancel":["t1","t2"],"done":false}\n```';
        return DONE;
      }
      if (lane === 'groq') {
        setTimeout(() => ctx.listener.deliver({ text: 'Vazgeçtim, bu işler yapılmasın.' }), 10);
        await new Promise((r) => setTimeout(r, 400));
        return 'ÖZET: bitti';
      }
      return 'ÖZET: tamam';
    },
  });
  ctx.catalogSource = async () => [];
  await lead.start(ctx);
  const second = callsOf(ctx, 'lead')[1].prompt;
  assert.match(second, /KULLANICININ YENİ MESAJI \(ekip çalışırken yazdı; önceliklidir\):\nVazgeçtim, bu işler yapılmasın\./);
  assert.match(second, /Hâlâ süren görevler[\s\S]*t1 · @qwen/);
  assert.equal(callsOf(ctx, 'gemini').length, 0, 'bekleyen görev hiç başlamadı');
  assert.ok(notes(ctx).some((t) => /Yönetici t1, t2 görevlerini iptal etti/.test(t)), notes(ctx).join('\n'));
  assert.deepEqual(ctx.state.log.map((r) => [r.id, r.ok, r.skipped]), [['t2', false, true], ['t1', false, true]]);
  assert.ok(ctx.events.some((e) => e.kind === 'task' && e.id === 't1' && e.state === 'cancelled'));
  assert.equal(ctx.listener, null, 'dinleme bitti');
  assert.ok(ctx.events.some((e) => e.kind === 'phase' && /^Yeni mesaj/.test(e.title)));
});

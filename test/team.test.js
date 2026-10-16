import { makeRepo, put, fakeCtx, editAgent, textAgent, notes, callsOf } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import team, { parseVerdict, isContinue } from '../server/orchestrator/team.js';

const PLAN = '```json\n{"steps":[{"title":"A dosyası","details":"a.txt yaz"},{"title":"B dosyası","details":"b.txt yaz"}]}\n```';
const AGENTS = { claude: editAgent('claude'), codex: editAgent('codex'), gemini: textAgent('gemini'), groq: textAgent('groq') };

function lanes({ reviewer = 'claude', planner = 'claude' } = {}) {
  return [
    { lane: 'planner', agentId: planner, role: 'planner', title: `Planlayıcı ${planner}` },
    { lane: 'w1', agentId: 'claude', role: 'worker', title: 'Çalışan 1' },
    { lane: 'w2', agentId: 'codex', role: 'worker', title: 'Çalışan 2' },
    { lane: 'reviewer', agentId: reviewer, role: 'reviewer', title: `Denetçi ${reviewer}` },
  ];
}

/** Workers write the file their step names; fixes rewrite a.txt. */
async function worker(opts, { cwd }) {
  const p = opts.prompt;
  if (/Senin adımın \(1\/2\)/.test(p)) { await put(cwd, 'a.txt', 'a yanlis\n'); return 'Yazdım.\nÖZET: a.txt yazıldı'; }
  if (/Senin adımın \(2\/2\)/.test(p)) { await put(cwd, 'b.txt', 'b\n'); return 'ÖZET: b.txt yazıldı'; }
  if (/Denetçi şu sorunları buldu/.test(p)) { await put(cwd, 'a.txt', 'a dogru\n'); return 'ÖZET: a.txt düzeltildi'; }
  if (/Kullanıcının ek isteği/.test(p)) { await put(cwd, 'c.txt', 'c\n'); return 'ÖZET: c.txt eklendi'; }
  return 'ÖZET: ?';
}

function script({ reviewer, planner } = {}) {
  return async (lane, opts, call) => {
    if (lane === 'planner') return planner ? planner(opts, call) : PLAN;
    if (lane === 'reviewer') return reviewer(opts, call);
    return worker(opts, call);
  };
}

test('parseVerdict: KARAR satırı, eski ONAY biçimi ve olumsuzlar', () => {
  assert.equal(parseVerdict('İnceledim.\n\n**KARAR: ONAY**'), 'approve');
  assert.equal(parseVerdict('1. a.js bozuk\n\nKARAR: DÜZELTME'), 'fix');
  assert.equal(parseVerdict('## Değerlendirme\nKARAR: onaylanmadı'), 'fix');
  assert.equal(parseVerdict('KARAR: ONAY DEĞİL — eksikler var'), 'fix');
  assert.equal(parseVerdict('Önce KARAR: DÜZELTME dedim ama düzeldi.\nKARAR: ONAY'), 'approve');
  assert.equal(parseVerdict('ONAY. Her şey yerinde.'), 'approve');
  assert.equal(parseVerdict('Verdict: approved'), 'approve');
  assert.equal(parseVerdict('Bazı sorunlar var:\n1. x'), null);
  assert.ok(isContinue('devam et') && isContinue('Devam!') && !isContinue('devam et ve testleri de yaz'));
});

test('plan → adımlar → inceleme → düzeltme → onay', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: lanes(), agents: AGENTS,
    script: script({ reviewer: (o, c) => (c.n === 1 ? '1. a.txt içeriği yanlış ("a yanlis").\n\nKARAR: DÜZELTME' : 'Sorun giderildi.\nKARAR: ONAY') }),
  });
  assert.equal(await team.start(ctx), 'done');
  const st = ctx.state;
  assert.equal(st.stage, 'done');
  assert.equal(st.approved, true);
  assert.equal(st.reviews.length, 2);
  assert.equal(st.fixes.length, 1);
  assert.equal(st.fixes[0].lane, 'w1', 'a.txt\'yi yazan çalışan düzeltir');
  assert.deepEqual(st.summaries[0].files, ['a.txt']);
  const [r1, r2] = callsOf(ctx, 'reviewer');
  assert.match(r1.prompt, /a\.txt \(\+1 −0\) — yeni/);
  assert.match(r1.prompt, /KARAR: ONAY/);
  assert.match(r1.prompt, /Bu çalışmanın yetkisi: DÜZENLEME — çalışanlar proje klasöründe dosya yazar/);
  assert.match(callsOf(ctx, 'planner')[0].prompt, /Bu çalışmanın yetkisi: DÜZENLEME/);
  assert.equal(r2.resumed, true);
  assert.match(r2.prompt, /Çalışan 1 bildirilen sorunlar için düzeltme yaptı: a\.txt düzeltildi/);
  assert.match(r2.prompt, /\+a dogru/);
  assert.match(r2.prompt, /toplam değişen dosyalar:\n- a\.txt/);
  const fixCall = callsOf(ctx, 'w1').find((c) => /Denetçi şu sorunları buldu/.test(c.prompt));
  assert.match(fixCall.prompt, /Şu ana kadar değişen dosyalar:\n- a\.txt/);
  assert.match(fixCall.prompt, /Plan:\n1\. A dosyası/);
  const result = ctx.events.find((e) => e.kind === 'result');
  assert.match(result.text, /Denetçi onayladı \(2\. incelemede, 1 düzeltme turundan sonra\)/);
});

test('eli olmayan denetçi dosyaları Ortak üzerinden okur', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: lanes({ reviewer: 'gemini' }), agents: AGENTS,
    script: script({ reviewer: (o, c) => (c.n === 1 ? 'READ: a.txt' : 'Dosyayı okudum.\nKARAR: ONAY') }),
  });
  assert.equal(await team.start(ctx), 'done');
  const [r1, r2] = callsOf(ctx, 'reviewer');
  assert.match(r1.prompt, /Projedeki dosyalar:/);
  assert.match(r1.system, /SALT OKUNUR/);
  assert.match(r2.prompt, /a yanlis/, 'okunan dosyanın içeriği denetçiye gitti');
  assert.equal(ctx.state.approved, true);
});

test('küçük bütçeli denetçi: büyük diff kısalır, ikili dosya gönderilmez, 413 hatasında daha kısa tekrar', async () => {
  const cwd = await makeRepo();
  const big = Array.from({ length: 3000 }, (_, i) => `const satir${i} = ${i};`).join('\n');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), randomBytes(30_000)]);
  const ctx = fakeCtx({
    cwd, lanes: lanes({ reviewer: 'groq' }), agents: AGENTS,
    script: async (lane, opts, call) => {
      if (lane === 'planner') return '```json\n{"steps":[{"title":"Büyük iş","details":"x"}]}\n```';
      if (lane === 'reviewer') {
        if (call.n === 1) throw new Error('Groq hatası (413): Request too large for model on tokens per minute (TPM): Limit 8000, Requested 18000');
        return 'KARAR: ONAY';
      }
      await put(cwd, 'src/buyuk.js', big);
      await put(cwd, 'src/kucuk.js', 'export const x = 1;\n');
      await put(cwd, 'logo.png', png);
      return 'ÖZET: yazıldı';
    },
  });
  assert.equal(await team.start(ctx), 'done');
  const [r1, r2] = callsOf(ctx, 'reviewer');
  assert.ok(r1.prompt.length < 17_000, `ilk istem ${r1.prompt.length}`);
  assert.ok(r2.prompt.length < r1.prompt.length, 'ikinci deneme daha kısa');
  for (const p of [r1.prompt, r2.prompt]) {
    assert.match(p, /logo\.png — yeni; ikili dosya/);
    assert.match(p, /src\/kucuk\.js \(\+1 −0\)/);
    assert.match(p, /src\/buyuk\.js \(\+3000 −0\) — yeni; (diff kısaltıldı|yer kalmadı)/);
    assert.doesNotMatch(p, /GIT binary patch/);
  }
  assert.equal(r2.resumed, false);
  assert.ok(notes(ctx).some((t) => /büyük geldi/.test(t)));
});

test('limit dolunca durur, "devam et" ile adımları tekrarlamadan sürer', async () => {
  const cwd = await makeRepo();
  let limited = true;
  const ctx = fakeCtx({
    cwd, lanes: lanes(), agents: AGENTS,
    script: script({
      reviewer: () => {
        if (limited) throw new Error('Claude kullanım limiti doldu (usage limit). 17:00\'de yenilenir.');
        return 'KARAR: ONAY';
      },
    }),
  });
  assert.equal(await team.start(ctx), 'waiting');
  assert.equal(ctx.state.stage, 'review');
  assert.equal(ctx.state.interrupted.kind, 'limit');
  assert.ok(notes(ctx).some((t) => /devam et/.test(t)));
  assert.equal(team.resumable(ctx.meta), true);
  const workerCalls = callsOf(ctx, 'w1').length + callsOf(ctx, 'w2').length;

  limited = false;
  assert.equal(await team.followUp(ctx, { text: 'devam et' }), 'done');
  assert.equal(callsOf(ctx, 'planner').length, 1);
  assert.equal(callsOf(ctx, 'w1').length + callsOf(ctx, 'w2').length, workerCalls, 'adımlar yeniden yapılmadı');
  assert.equal(ctx.state.approved, true);
  assert.equal(ctx.state.interrupted, null);
  assert.equal(team.resumable(ctx.meta), false);
});

test('düzeltme turu sınırı; "devam et" yeni turlar açar', async () => {
  const cwd = await makeRepo();
  let strict = true;
  const ctx = fakeCtx({
    cwd, lanes: lanes(), agents: AGENTS, config: { fixRounds: 2 },
    script: script({ reviewer: () => (strict ? '1. a.txt hâlâ yanlış\nKARAR: DÜZELTME' : 'KARAR: ONAY') }),
  });
  assert.equal(await team.start(ctx), 'done');
  assert.equal(ctx.state.approved, false);
  assert.equal(ctx.state.fixes.length, 2);
  assert.equal(ctx.state.reviews.length, 3);
  assert.match(ctx.events.filter((e) => e.kind === 'result').at(-1).text, /2 düzeltme turundan sonra hâlâ sorun görüyor/);
  assert.notEqual(ctx.state.fixes[0].lane, ctx.state.fixes[1].lane, 'ikinci tur başka bir çalışanı dener');

  strict = false;
  assert.equal(await team.followUp(ctx, { text: 'devam et' }), 'done');
  assert.equal(ctx.state.fixes.length, 3);
  assert.equal(ctx.state.approved, true);
});

test('denetçi hata verirse planlayıcı yedek denetçi olur', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: lanes({ planner: 'codex' }), agents: AGENTS,
    script: async (lane, opts, call) => {
      if (lane === 'planner') return call.n === 1 ? PLAN : 'Yedek olarak inceledim.\nKARAR: ONAY';
      if (lane === 'reviewer') throw new Error('Beklenmeyen bir hata');
      return worker(opts, call);
    },
  });
  assert.equal(await team.start(ctx), 'done');
  assert.equal(ctx.state.reviews[0].lane, 'planner');
  assert.ok(notes(ctx).some((t) => /Bu inceleme Planlayıcı codex ile yapılıyor/.test(t)));
});

test('çalışan limite takılırsa adım sıradakine geçer', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: lanes(), agents: AGENTS,
    script: async (lane, opts, call) => {
      if (lane === 'planner') return PLAN;
      if (lane === 'reviewer') return 'KARAR: ONAY';
      if (lane === 'w1') throw new Error('usage limit reached');
      return worker(opts, call);
    },
  });
  assert.equal(await team.start(ctx), 'done');
  assert.deepEqual(ctx.state.summaries.map((s) => s.lane), ['w2', 'w2']);
  const retry = callsOf(ctx, 'w2').find((c) => /Senin adımın \(1\/2\)/.test(c.prompt));
  assert.match(retry.prompt, /önce Çalışan 1 denedi/);
});

test('bitmiş çalışmaya ek istek: çalışan yapar, denetçi yalnızca o isteği inceler', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({ cwd, lanes: lanes(), agents: AGENTS, script: script({ reviewer: () => 'KARAR: ONAY' }) });
  await team.start(ctx);
  assert.equal(await team.followUp(ctx, { text: 'c.txt ekle' }), 'done');
  const last = callsOf(ctx, 'reviewer').at(-1);
  assert.match(last.prompt, /Kullanıcının ek isteği \(bu turda yapıldı\):\nc\.txt ekle/);
  assert.match(last.prompt, /c\.txt \(\+1 −0\)/);
  assert.doesNotMatch(last.prompt, /- a\.txt/, 'yalnızca bu isteğin değişiklikleri');
  assert.equal(ctx.state.summaries.at(-1).title, 'Ek istek: c.txt ekle');
});

test('eski biçimde kaydedilmiş çalışma ek istek alabilir', async () => {
  const cwd = await makeRepo();
  const ctx = fakeCtx({
    cwd, lanes: lanes(), agents: AGENTS, script: script({ reviewer: () => 'KARAR: ONAY' }),
    state: { plan: [{ title: 'A', details: '' }], summaries: [{ index: 0, title: 'A', by: 'Çalışan 1', lane: 'w1', summary: 'ok' }], review: 'ONAY', approved: true },
  });
  assert.equal(await team.followUp(ctx, { text: 'c.txt ekle' }), 'done');
  assert.equal(ctx.state.reviews.length, 2);
});

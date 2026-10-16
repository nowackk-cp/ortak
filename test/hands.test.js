import { makeRepo, put, fakeCtx, notes } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { textChatTurn, textCoderTask, nativeToolDefs } from '../server/orchestrator/textcoder.js';

const toolAgent = (id) => ({ id, name: id, capabilities: { edit: false, resume: true, tools: true } });
const textAgent = (id) => ({ id, name: id, capabilities: { edit: false, resume: true } });
const cards = (ctx) => ctx.events.filter((e) => e.kind === 'agent' && e.event.type === 'tool-end').map((e) => e.event.output);

test('araç tanımları: düzenleme araçları yalnızca yazma yetkisinde', () => {
  const ro = nativeToolDefs('read-only').map((d) => d.function.name);
  const ed = nativeToolDefs('edit').map((d) => d.function.name);
  for (const n of ['find_files', 'outline', 'find_symbol', 'git', 'grep', 'read_file', 'web_search', 'web_fetch']) assert.ok(ro.includes(n), n);
  for (const n of ['multi_edit', 'replace_lines', 'delete_file', 'move_file']) { assert.ok(!ro.includes(n), n); assert.ok(ed.includes(n), n); }
});

test('gerçek araç çağırma: bul, anahat, çoklu düzenleme, sözdizimi uyarısı, sil, taşı, git, okuma sınırı', async () => {
  const big = Array.from({ length: 2000 }, (_, i) => `// satır ${i} ${'x'.repeat(30)}`).join('\n');
  const cwd = await makeRepo({
    'AGENTS.md': 'Kod Türkçe yorumlanır.',
    'src/sepet.js': 'export function topla(a, b) {\n    return a + b;\n}\n\nexport function cikar(a, b) {\n    return a - b;\n}\n',
    'src/eski.js': 'export const eski = 1;\n',
    'notlar.txt': 'not\n',
    'buyuk.js': big,
  });
  const out = {};
  const ctx = fakeCtx({
    cwd,
    lanes: [{ lane: 'groq', agentId: 'groq', role: 'agent' }],
    agents: { groq: toolAgent('groq') },
    script: async (lane, opts) => {
      const x = opts.tools.exec;
      out.prompt = opts.prompt;
      out.find = await x('find_files', { pattern: '*.js', dir: 'src' });
      out.outline = await x('outline', { path: 'src/sepet.js' });
      out.symbol = await x('find_symbol', { name: 'cikar' });
      out.multi = await x('multi_edit', { path: 'src/sepet.js', edits: [
        { old_text: 'return a + b;', new_text: 'return a + b + 0;' },
        { old_text: 'export function cikar(a, b) {\nreturn a - b;\n}', new_text: 'export function cikar(a, b) {\nreturn b - a;\n}' },
      ] });
      out.bad = await x('edit_file', { path: 'src/sepet.js', old_text: 'return b - a;', new_text: 'return b - a;;; }' });
      out.lines = await x('replace_lines', { path: 'src/sepet.js', start_line: 6, end_line: 6, new_text: '    return b - a;' });
      out.del = await x('delete_file', { path: 'notlar.txt' });
      out.move = await x('move_file', { from: 'src/eski.js', to: 'src/arsiv/eski.js' });
      out.git = await x('git', { command: 'status' });
      out.read = await x('read_file', { path: 'buyuk.js' });
      return 'Bitti.';
    },
  });
  const r = await textChatTurn(ctx, 'groq', { prompt: 'Sepeti düzelt', permission: 'edit' });
  assert.equal(r.text, 'Bitti.');
  assert.equal(out.find, '2 dosya:\nsrc/eski.js\nsrc/sepet.js');
  assert.match(out.outline, /1: export function topla\(a, b\) \{\n5: export function cikar/);
  assert.equal(out.symbol, 'src/sepet.js:5: export function cikar(a, b) {');
  assert.match(out.multi, /^Uygulandı \(girinti farkı yok sayılarak\)\.$/);
  assert.match(out.bad, /sözdizimi hatası var: src\/sepet\.js:7 — SyntaxError: Unexpected token '\}'.* — düzelt\.$/);
  assert.equal(out.lines, 'Uygulandı.');
  assert.equal(await fs.readFile(path.join(cwd, 'src/sepet.js'), 'utf8'),
    'export function topla(a, b) {\n    return a + b + 0;\n}\n\nexport function cikar(a, b) {\n    return b - a;\n}\n');
  assert.match(out.del, /notlar\.txt silindi/);
  assert.match(out.move, /src\/eski\.js → src\/arsiv\/eski\.js taşındı/);
  assert.match(out.git, /src\/sepet\.js/);
  assert.ok(out.read.length < 8000, `Groq'a giden okuma ${out.read.length} karakter`);
  assert.match(out.read, /devamı için read_file\(start_line=/);
  const cp = ctx.events.find((e) => e.kind === 'checkpoint');
  assert.deepEqual(cp.files.map((f) => f.path).sort(), ['notlar.txt', 'src/arsiv/eski.js', 'src/eski.js', 'src/sepet.js']);
  // instructions and the project are in the turn's prompt (the caller passes it on)
  assert.ok(cards(ctx).some((c) => /sözdizimi hatası/.test(c)));
});

test('yazı protokolü: FIND / OUTLINE / GIT, girinti toleransı, sözdizimi hatasında tur sürer, talimat dosyası', async () => {
  const cwd = await makeRepo({ 'AGENTS.md': 'Her değişiklikten sonra testleri çalıştır.', 'src/a.js': 'function f() {\n    return 1;\n}\nmodule.exports = f;\n' });
  const prompts = [];
  const systems = [];
  const ctx = fakeCtx({
    cwd,
    lanes: [{ lane: 'gemini', agentId: 'gemini', role: 'worker' }],
    agents: { gemini: textAgent('gemini') },
    script: async (lane, opts, call) => {
      prompts.push(opts.prompt);
      systems.push(opts.system);
      if (call.n === 1) return 'FIND: *.js\nOUTLINE: src/a.js\nGIT: status';
      if (call.n === 2) return '````\nFILE: src/a.js\n<<<<<<< SEARCH\nfunction f() {\nreturn 1;\n}\n=======\nfunction f() {\nreturn (1;\n}\n>>>>>>> REPLACE\n````';
      if (call.n === 3) return '````\nFILE: src/a.js\n<<<<<<< SEARCH\n    return (1;\n=======\n    return 2;\n>>>>>>> REPLACE\n````\nÖZET: düzeltildi';
      return 'ÖZET: bitti';
    },
  });
  const r = await textCoderTask(ctx, 'gemini', { goal: 'f 2 döndürsün', task: 'src/a.js içinde f 2 döndürsün', files: [], permission: 'edit', leadName: 'Opus' });
  assert.match(prompts[0], /Projenin talimat dosyaları[\s\S]*### AGENTS\.md\nHer değişiklikten sonra testleri çalıştır\./);
  assert.match(systems[0], /"FIND: desen"/, 'kurallar yeni komutları anlatır');
  assert.match(systems[0], /"DELETE: yol\/dosya"/);
  assert.match(systems[0], /"WEB: arama sorgusu"/);
  assert.match(prompts[1], /### FIND \*\.js\n```\n1 dosya:\nsrc\/a\.js/);
  assert.match(prompts[1], /### OUTLINE src\/a\.js\n```\n\[src\/a\.js · 5 satır · 1 tanım\]\n1: function f\(\) \{/);
  assert.match(prompts[1], /### GIT status/);
  assert.match(prompts[2], /src\/a\.js: uygulandı \(girinti farkı yok sayılarak\) — DİKKAT: dosyada şimdi sözdizimi hatası var/);
  assert.equal(prompts.length, 3, 'düzeltme gelince tur biter');
  assert.equal(await fs.readFile(path.join(cwd, 'src/a.js'), 'utf8'), 'function f() {\n    return 2;\n}\nmodule.exports = f;\n');
  assert.deepEqual(r.applied, ['src/a.js']);
  assert.equal(notes(ctx).length, 0);
});

test('salt okunur: silme ve taşıma reddedilir', async () => {
  const cwd = await makeRepo({ 'a.txt': 'a\n' });
  await put(cwd, 'b.txt', 'b\n');
  const prompts = [];
  const ctx = fakeCtx({
    cwd,
    lanes: [{ lane: 'gemini', agentId: 'gemini', role: 'reviewer' }],
    agents: { gemini: textAgent('gemini') },
    script: async (lane, opts, call) => { prompts.push(opts.prompt); return call.n === 1 ? 'DELETE: a.txt\nMOVE: b.txt -> c.txt' : 'Tamam.'; },
  });
  await textChatTurn(ctx, 'gemini', { prompt: 'incele', permission: 'read-only' });
  assert.match(prompts[1], /### DELETE a\.txt\n```\nHata: salt okunur çalışma/);
  await fs.stat(path.join(cwd, 'a.txt'));
  await fs.stat(path.join(cwd, 'b.txt'));
});

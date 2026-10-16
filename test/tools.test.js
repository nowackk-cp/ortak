import { makeRepo, put } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyReplace, applyAll, replaceLines } from '../server/tools/edit.js';
import { checkFile } from '../server/tools/check.js';
import { findFiles, deleteFile, moveFile, globToRegExp } from '../server/tools/files.js';
import { outline, findSymbol, definitions } from '../server/tools/symbols.js';
import { projectContext, projectInstructions } from '../server/tools/project.js';
import { gitDiff, gitLog, gitShow, gitStatus } from '../server/tools/gittools.js';
import { isPrivateAddress, checkUrl, htmlToText, parseDuckDuckGo } from '../server/tools/web.js';
import { toolCaps } from '../server/tools/budget.js';
import { compactMessages } from '../server/adapters/openai-chat.js';
import * as checkpoints from '../server/checkpoints.js';

// ---- edit ------------------------------------------------------------------------------------

test('applyReplace: birebir, satır sonu boşluğu ve girinti farkı', () => {
  const src = 'function a() {\n    if (x) {\n        return 1;   \n    }\n}\n';
  assert.equal(applyReplace(src, 'return 1;   ', 'return 2;').level, 1);
  const r2 = applyReplace(src, '        return 1;\n    }', '        return 2;\n    }');
  assert.equal(r2.level, 2);
  assert.match(r2.content, /return 2;\n {4}}/);
  // the model dropped the indentation: matched by content, replacement re-indented to the file's
  const r3 = applyReplace(src, 'if (x) {\n    return 1;\n}', 'if (y) {\n    return 3;\n}');
  assert.equal(r3.level, 3);
  assert.equal(r3.content, 'function a() {\n    if (y) {\n        return 3;\n    }\n}\n');
  // only the inner lines lost their indentation; an added line follows the previous one
  const r4 = applyReplace('function f() {\n    a();\n    b();\n}\n', 'function f() {\na();\nb();\n}', 'function f() {\na2();\nyeni();\n  ic();\nb();\n}');
  assert.equal(r4.content, 'function f() {\n    a2();\n    yeni();\n      ic();\n    b();\n}\n');
});

test('applyReplace: belirsiz ve bulunamayan metin; en yakın yeri gösterir', () => {
  assert.throws(() => applyReplace('a\nb\na\n', 'a', 'c'), /birden fazla yerde/);
  const src = 'const fiyat = 10;\nconst indirim = 0.2;\nconst toplam = fiyat * (1 - indirim);\n';
  assert.throws(() => applyReplace(src, 'const indirim = 0.2;\nconst toplam = fiyat * (1 + indirim);', 'x'),
    /En yakın yer, satır 2-3:\nconst indirim = 0\.2;/);
});

test('applyAll hepsi ya da hiçbiri; replaceLines', () => {
  const src = 'a\nb\nc\n';
  assert.equal(applyAll(src, [{ search: 'a', replace: 'A' }, { search: 'c', replace: 'C' }]).content, 'A\nb\nC\n');
  assert.throws(() => applyAll(src, [{ search: 'a', replace: 'A' }, { search: 'yok', replace: 'C' }]), /^Error: 2\. değişiklik/);
  assert.equal(replaceLines(src, 2, 2, 'B1\nB2'), 'a\nB1\nB2\nc\n');
  assert.throws(() => replaceLines(src, 3, 9, 'x'), /geçersiz satır aralığı 3-9 \(dosyada 3 satır var\)/);
});

// ---- syntax check ----------------------------------------------------------------------------

test('checkFile: JS, JSON, JSONC ve Python', async () => {
  const dir = await makeRepo();
  await put(dir, 'ok.js', 'export const x = 1;\n');
  await put(dir, 'bad.js', 'const x = {\n  a: 1,\n;\n');
  await put(dir, 'bad.json', '{\n  "a": 1,\n}\n');
  await put(dir, 'esm.js', 'export function f() {\n  return 1;;; }\n}\n');
  await put(dir, 'tsconfig.json', '{\n  // yorum\n  "compilerOptions": {}\n}\n');
  assert.equal(await checkFile(path.join(dir, 'ok.js'), 'ok.js'), null);
  assert.match(await checkFile(path.join(dir, 'bad.js'), 'bad.js'), /bad\.js:3 — SyntaxError/);
  assert.match(await checkFile(path.join(dir, 'esm.js'), 'esm.js'), /esm\.js:3 — SyntaxError: Unexpected token '\}'/, 'import/export içeren .js de denetlenir');
  assert.match(await checkFile(path.join(dir, 'bad.json'), 'bad.json'), /JSON geçersiz/);
  assert.equal(await checkFile(path.join(dir, 'tsconfig.json'), 'tsconfig.json'), null);
  let python = true;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { python = false; }
  if (python) {
    await put(dir, 'bad.py', 'def f(:\n  pass\n');
    assert.match(await checkFile(path.join(dir, 'bad.py'), 'bad.py'), /SyntaxError|invalid syntax/);
  }
});

// ---- files -----------------------------------------------------------------------------------

test('findFiles: glob desenleri', async () => {
  const dir = await makeRepo({ 'README.md': '#', 'src/a.js': '', 'src/a.test.js': '', 'src/lib/b.ts': '', 'test/c.test.js': '', 'config.json': '{}' });
  const names = async (p, o) => (await findFiles(dir, p, o)).files.sort();
  assert.deepEqual(await names('*.test.js'), ['src/a.test.js', 'test/c.test.js']);
  assert.deepEqual(await names('src/**/*.{js,ts}'), ['src/a.js', 'src/a.test.js', 'src/lib/b.ts']);
  assert.deepEqual(await names('*.js', { dir: 'test' }), ['test/c.test.js']);
  assert.ok(globToRegExp('**/config.json').test('config.json'));
});

test('deleteFile / moveFile geri alınabilir (ikili dosya dahil)', async () => {
  const dir = await makeRepo({ 'a.txt': 'merhaba\n', 'logo.bin': 'x' });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 0, 7]);
  await fs.writeFile(path.join(dir, 'logo.bin'), png);
  const cp = checkpoints.begin('test-files');
  await deleteFile(dir, 'a.txt', cp);
  await moveFile(dir, 'logo.bin', 'img/logo.bin', cp);
  await assert.rejects(moveFile(dir, 'yok.txt', 'b.txt', cp), /dosya yok/);
  await assert.rejects(deleteFile(dir, '../dışarı.txt', cp), /proje klasörünün dışında/);
  const saved = await cp.finish();
  assert.deepEqual(saved.files.map((f) => f.path).sort(), ['a.txt', 'img/logo.bin', 'logo.bin']);
  const r = await checkpoints.undo('test-files', saved.id);
  assert.equal(r.conflicts.length, 0);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'merhaba\n');
  assert.deepEqual(await fs.readFile(path.join(dir, 'logo.bin')), png);
  await assert.rejects(fs.stat(path.join(dir, 'img/logo.bin')));
});

// ---- symbols ---------------------------------------------------------------------------------

test('outline ve findSymbol: JS ve Python', async () => {
  const js = [
    'import x from "y";',
    'export function fiyatHesapla(a, b) {',
    '  if (a) {',
    '    return a;',
    '  }',
    '}',
    'export class Sepet {',
    '  constructor() {}',
    '  async ekle(urun) {',
    '    foo(bar);',
    '  }',
    '}',
    'const indir = async (x) => x;',
    'export interface Urun { id: string }',
  ].join('\n');
  const dir = await makeRepo({ 'src/sepet.ts': js, 'app.py': 'class Kasa:\n    def ode(self, n):\n        return n\n\ndef main():\n    pass\n' });
  const o = await outline(dir, 'src/sepet.ts');
  assert.deepEqual(o.items, [
    '2: export function fiyatHesapla(a, b) {', '7: export class Sepet {', '9:   async ekle(urun) {',
    '13: const indir = async (x) => x;', '14: export interface Urun { id: string }',
  ]);
  assert.deepEqual(definitions('app.py', await fs.readFile(path.join(dir, 'app.py'), 'utf8')).map((d) => d.name), ['Kasa', 'ode', 'main']);
  const s = await findSymbol(dir, 'ekle');
  assert.deepEqual(s.hits.map((h) => `${h.path}:${h.line}`), ['src/sepet.ts:9']);
  assert.equal((await findSymbol(dir, 'kasa')).hits[0].path, 'app.py'); // case-insensitive fallback
  await assert.rejects(outline(dir, 'README.md'), /anahat çıkarılamıyor/);
});

// ---- project context --------------------------------------------------------------------------

test('projectContext: talimat dosyaları, küçük projede liste, büyükte harita', async () => {
  const files = { 'AGENTS.md': 'Testleri npm test ile çalıştır.', 'CLAUDE.md': 'Testleri npm test ile çalıştır.', 'GEMINI.md': 'Türkçe yaz.', 'package.json': '{"name":"demo","scripts":{"test":"node --test"}}' };
  const small = await makeRepo(files);
  const ins = await projectInstructions(small);
  assert.deepEqual(ins.map((i) => i.name), ['AGENTS.md', 'GEMINI.md'], 'aynı içerikli CLAUDE.md atlanır');
  const c1 = await projectContext(small);
  assert.equal(c1.map, null);
  assert.ok(c1.files.includes('package.json'));
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`src/m${i % 4}/f${i}.ts`, '']));
  const big = await makeRepo({ ...many, 'package.json': files['package.json'] });
  const c2 = await projectContext(big);
  assert.deepEqual(c2.files, []);
  assert.match(c2.map, /^src\/ {2}\(200 dosya\)\n {2}m0\/ {2}\(50\)/);
  assert.ok(c2.facts.some((f) => /TypeScript \(200\)/.test(f)));
  assert.ok(c2.facts.some((f) => /npm run test/.test(f)));
});

// ---- git -------------------------------------------------------------------------------------

test('git araçları: diff (yeni dosyalar dahil), log, show, status', async () => {
  const dir = await makeRepo({ 'a.js': 'const a = 1;\n' });
  await put(dir, 'a.js', 'const a = 2;\n');
  await put(dir, 'yeni.js', 'export {};\n');
  const d = await gitDiff(dir);
  assert.match(d, /a\.js \(\+1 −1\)/);
  assert.match(d, /yeni\.js \(\+1 −0\) — yeni/);
  assert.match(await gitStatus(dir), /yeni\.js/);
  assert.match(await gitLog(dir), /Test — ilk/);
  assert.equal(await gitShow(dir, { rev: 'HEAD', path: 'a.js' }), 'const a = 1;\n');
  assert.match(await gitShow(dir, { rev: '--output=x' }), /Geçersiz commit/);
  assert.match(await gitDiff(dir, { base: '--output=x' }), /Geçersiz commit/);
  const plain = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'ortak-nogit-'));
  assert.equal(await gitDiff(plain), 'Proje bir git deposu değil.');
});

// ---- web -------------------------------------------------------------------------------------

test('web: özel ağ adresleri ve yerel adresler reddedilir', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  await assert.rejects(checkUrl('http://127.0.0.1:4747/api/runs'), /yerel\/özel ağ/);
  await assert.rejects(checkUrl('http://localhost:4747/'), /yerel ağdaki/);
  await assert.rejects(checkUrl('file:///etc/passwd'), /yalnızca http ve https/);
  await assert.rejects(checkUrl('http://[::1]/'), /yerel/);
});

test('web: HTML metne çevrilir, DuckDuckGo sonuçları ayrıştırılır', () => {
  const { title, text } = htmlToText('<html><head><title>Belge &amp; Örnek</title><style>x{}</style></head><body><nav>menü</nav>' +
    '<main><h1>Başlık</h1><p>Bir <b>paragraf</b>.</p><ul><li>bir</li><li>iki</li></ul><pre><code>const a = 1 &lt; 2;</code></pre></main><script>evil()</script></body></html>');
  assert.equal(title, 'Belge & Örnek');
  assert.equal(text, '# Başlık\n\nBir paragraf.\n\n- bir\n- iki\n\n```\nconst a = 1 < 2;\n```');
  const html = '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=x">Node <b>fs</b> API</a>' +
    '<a class="result__snippet" href="#">Dosya sistemi <b>modülü</b></a></div>' +
    '<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Reklam</a></div>';
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'Node fs API', url: 'https://nodejs.org/api/fs.html', snippet: 'Dosya sistemi modülü' }]);
});

// ---- budget & compaction ---------------------------------------------------------------------

test('toolCaps: küçük bütçeli modele küçük çıktı', () => {
  const groq = toolCaps({ id: 'groq', capabilities: {} });
  const big = toolCaps({ id: 'gemini', capabilities: {} });
  assert.ok(groq.read <= 7000 && groq.output <= 5000 && groq.listing === 60);
  assert.ok(big.read > groq.read && big.listing > groq.listing);
});

test('compactMessages: eski araç çıktıları kısalır, geçmiş düşer, çağrı-sonuç eşleri korunur', () => {
  const big = 'x'.repeat(6000);
  const messages = [
    { role: 'system', content: 'sistem' },
    { role: 'user', content: 'eski soru' }, { role: 'assistant', content: 'eski cevap '.repeat(400) },
    { role: 'user', content: 'yeni görev' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: big },
  ];
  const turn = messages[3];
  const removed = compactMessages(messages, 8000, turn);
  assert.ok(removed > 0);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1], turn, 'eski tur atıldı, güncel kullanıcı mesajı kaldı');
  assert.match(messages[3].content, /kısaltıldı/, 'ilk araç çıktısı kısaltıldı');
  assert.equal(messages[5].content.length, 6000, 'son araç çıktısı olduğu gibi');
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
  assert.equal(compactMessages(messages, 100_000, turn), 0);
});

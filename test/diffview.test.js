import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiff, splitDiff, changedFiles, promptBudget } from '../server/orchestrator/diffview.js';

const section = (file, lines, { status = 'modified' } = {}) => {
  const head = [`diff --git a/${file} b/${file}`];
  if (status === 'added') head.push('new file mode 100644', '--- /dev/null', `+++ b/${file}`);
  else if (status === 'deleted') head.push('deleted file mode 100644', `--- a/${file}`, '+++ /dev/null');
  else head.push(`--- a/${file}`, `+++ b/${file}`);
  return [...head, `@@ -1,${lines} +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+satır ${i} ${file}`)].join('\n');
};
const binary = (file, kb) => [
  `diff --git a/${file} b/${file}`, 'new file mode 100644', 'index 0000000..1234567', 'GIT binary patch', `literal ${kb * 1024}`,
  ...Array.from({ length: kb * 15 }, () => 'zcmV-T0RR6000031h0Fh1!7gHx1g0G2#0Lk1)AZ0RR910'),
].join('\n');

test('splitDiff: dosyaları, durumları ve türleri ayırır', () => {
  const d = [section('src/a.js', 3), section('yeni.txt', 2, { status: 'added' }), section('eski.js', 4, { status: 'deleted' }), binary('logo.png', 2), section('package-lock.json', 50)].join('\n');
  const files = splitDiff(d);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.kind]), [
    ['src/a.js', 'modified', 'text'], ['yeni.txt', 'added', 'text'], ['eski.js', 'deleted', 'text'],
    ['logo.png', 'added', 'binary'], ['package-lock.json', 'modified', 'lockfile'],
  ]);
  assert.equal(files[0].added, 3);
});

test('reviewDiff: ikili ve kilit dosyaları içeriksiz listelenir, kod dosyaları görünür', () => {
  const d = [binary('assets/logo.png', 40), section('package-lock.json', 3000), section('src/fiyat.js', 30)].join('\n');
  const v = reviewDiff(d, 20_000);
  assert.ok(v.text.length <= 20_000 + 500, `çok uzun: ${v.text.length}`);
  assert.match(v.text, /assets\/logo\.png — yeni; ikili dosya/);
  assert.match(v.text, /package-lock\.json \(\+3000 −0\) — kilit dosyası/);
  assert.match(v.text, /\+satır 29 src\/fiyat\.js/); // the code file is shown whole
  assert.doesNotMatch(v.text, /GIT binary patch|zcmV/);
});

test('reviewDiff: bütçe dosyalar arasında adil bölünür ve kesilenler adlandırılır', () => {
  const files = Array.from({ length: 8 }, (_, i) => section(`src/m${i}.js`, i === 0 ? 4000 : 20));
  const v = reviewDiff(files.join('\n'), 12_000);
  for (let i = 1; i < 8; i++) assert.match(v.text, new RegExp(`\\+satır 19 src/m${i}\\.js`)); // small files whole
  assert.deepEqual(v.cut, ['src/m0.js']);
  assert.match(v.text, /src\/m0\.js \(\+4000 −0\) — diff kısaltıldı/);
  assert.match(v.text, /DİKKAT: Bütün değişiklikler bu mesaja sığmadı/);
  assert.ok(v.text.length < 12_500);
});

test('reviewDiff: git yoksa ve değişiklik yoksa açıklama verir', () => {
  assert.match(reviewDiff(null).text, /git deposu değil/);
  assert.match(reviewDiff('').text, /Hiçbir dosya değişmedi/);
});

test('changedFiles ve promptBudget', () => {
  assert.match(changedFiles(section('a.js', 2)), /- a\.js \(\+2 −0\)/);
  assert.equal(promptBudget({ id: 'groq', capabilities: {} }), 14_000);
  assert.equal(promptBudget({ id: 'claude', capabilities: {} }), 100_000);
  assert.equal(promptBudget({ id: 'x', capabilities: { promptBudget: 5000 } }), 5000);
});

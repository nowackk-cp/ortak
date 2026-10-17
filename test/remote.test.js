import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Remote, addresses, deviceName, formatKey, newKey, normalizeKey } from '../server/remote.js';
import { qrMatrix } from '../web/js/qr.js';

test('telefon anahtarı: 16 karakter, yazım hataları affedilir', () => {
  const k = newKey();
  assert.match(k, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.equal(formatKey('ABCD1234EFGH5678'), 'ABCD-1234-EFGH-5678');
  assert.equal(normalizeKey(' abcd-1234 efgh-5678 '), 'ABCD1234EFGH5678');
  assert.equal(normalizeKey('O0Il'), '0011'); // look-alikes
});

test('telefon adresleri: önce ev ağı, sonra Tailscale; sanal ağlar sonda', () => {
  const ifaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.48.1', internal: false }],
    Tailscale: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.23', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [{ family: 'IPv4', address: '169.254.10.2', internal: false }],
  };
  const list = addresses(4748, ifaces);
  assert.deepEqual(list.map((a) => [a.kind, a.url]), [
    ['lan', 'http://192.168.1.23:4748'],
    ['tailscale', 'http://100.101.102.103:4748'],
    ['other', 'http://172.20.48.1:4748'],
  ]);
});

test('cihaz adı', () => {
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
});

test('QR: sürüm metnin uzunluğuna göre seçilir', () => {
  assert.equal(qrMatrix('a').length, 21);                                            // sürüm 1
  assert.equal(qrMatrix('http://192.168.100.123:4748/?k=ABCDEFGHJKMNPQRS').length, 33); // sürüm 4 (M)
  assert.throws(() => qrMatrix('x'.repeat(3000), 'H'));
});

test('telefon dinleyicisi: anahtarsız giremez, QR bağlantısı ve çerezle girer, yeni anahtar eskisini geçersiz kılar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortak-remote-'));
  const seen = [];
  const remote = new Remote({
    dataDir: dir,
    log: () => {},
    handle: async (req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('uygulama'); },
  });
  remote.port = 0; // any free port
  try {
    await remote.setEnabled(true);
    assert.ok(remote.listening);
    const base = `http://127.0.0.1:${remote.server.address().port}`;
    const key = remote.key;
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'remote.json'), 'utf8'));
    assert.equal(saved.enabled, true);
    assert.equal(saved.key, key);

    // no key: sign-in page / 401, the app is never reached
    let r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Ortak'a bağlan/);
    r = await fetch(`${base}/api/runs`);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).login, true);
    assert.equal(seen.length, 0);

    // the QR code's link: cookie + redirect without the key
    r = await fetch(`${base}/?k=${key}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/');
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const jar = cookie.split(';')[0];
    r = await fetch(`${base}/api/runs`, { headers: { cookie: jar } });
    assert.equal(await r.text(), 'uygulama');
    assert.deepEqual(seen, ['/api/runs']);
    seen.length = 0;

    // home screen: icons without the key; the manifest's start_url signs the phone in only if it already is
    r = await fetch(`${base}/icons/icon-192.png`);
    assert.equal(await r.text(), 'uygulama');
    assert.equal((await (await fetch(`${base}/manifest.webmanifest`)).json()).start_url, '/');
    assert.equal((await (await fetch(`${base}/manifest.webmanifest`, { headers: { cookie: jar } })).json()).start_url, `/?k=${key}`);
    r = await fetch(`${base}/icons/../api/runs`);
    assert.equal(r.status, 401);

    // typed key (any case / dashes)
    r = await fetch(`${base}/telefon/giris`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: formatKey(key).toLowerCase() }) });
    assert.equal(r.status, 200);
    assert.ok(remote.status({ local: true }).devices.length >= 1);
    assert.equal(remote.status({ local: false }).key, undefined); // the phone never gets the key back

    // a new key: the old cookie no longer opens anything
    remote.rotate();
    r = await fetch(`${base}/api/runs`, { headers: { cookie: jar } });
    assert.equal(r.status, 401);

    // wrong keys: locked out after 10 tries
    let last = 0;
    for (let i = 0; i < 11; i++) {
      r = await fetch(`${base}/telefon/giris`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'yanlis' }) });
      last = r.status;
    }
    assert.equal(last, 429);

    await remote.setEnabled(false);
    assert.equal(remote.listening, false);
    await assert.rejects(fetch(`${base}/`));
  } finally {
    await remote.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

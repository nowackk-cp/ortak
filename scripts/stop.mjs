// Stops a running Ortak server (cancels running agents first).   node scripts/stop.mjs
// Exit codes: 0 stopped, 1 failed, 2 was not running (Ortak.vbs uses them for its message).
const PORT = Number(process.env.ORTAK_PORT) || 4747;
const origin = `http://127.0.0.1:${PORT}`;
try {
  const res = await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { Origin: origin }, signal: AbortSignal.timeout(5000) });
  console.log(res.ok ? 'Ortak kapatılıyor.' : `Kapatılamadı: HTTP ${res.status}`);
  process.exitCode = res.ok ? 0 : 1;
  // Wait until it is really gone, so `stop && launch` doesn't find the old server still answering.
  for (let i = 0; res.ok && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const up = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (!up) break;
  }
} catch {
  console.log('Ortak zaten çalışmıyor.');
  process.exitCode = 2;
}

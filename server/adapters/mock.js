// Fake agent for tests and UI work. Enabled with `node server/index.js --mock` or ORTAK_MOCK=1.
// Costs nothing, streams text slowly, simulates a tool call, and (with permission != read-only)
// writes a small file into cwd so parallel/team modes produce real diffs.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AbortError } from './base.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AbortError()); }, { once: true });
});

let counter = 0;

// Plays the orchestrator roles well enough for UI work: a lead hands out tasks to the @handles it
// was given and finishes on its first review; a planner plans two steps; a reviewer approves.
function roleReply(prompt, system) {
  if (/yöneticisisin/.test(system)) {
    if (/^Denetim \d+\/\d+|\nDenetim \d+\/\d+/.test(prompt)) {
      return 'Raporları ve değişiklikleri inceledim; iş tamam.\n\n```json\n{"tasks":[],"done":true,"summary":"Görev ekip tarafından tamamlandı (sahte ajan)."}\n```';
    }
    const handles = [...new Set([...prompt.matchAll(/^- @([\w.-]+) —/gm)].map((m) => m[1]))].slice(0, 3);
    if (!handles.length) return null;
    const tasks = handles.map((hd, i) => ({ id: `t${i + 1}`, agent: hd, task: `Parça ${i + 1}: ilgili dosyaları incele ve gerekeni yap.` }));
    // two more on a catalog model ("mock:hizli"): Ortak opens extra copies of it to run them in parallel
    const ref = /\b(mock:[\w.-]+)/.exec(prompt.split('Model kataloğu')[1] || '')?.[1];
    if (ref) for (const n of [1, 2]) tasks.push({ id: `k${n}`, agent: ref, task: `Ek parça ${n}: katalogdan seçilen modelle yap.` });
    if (handles.length > 1) tasks.push({ id: `t${handles.length + 1}`, agent: handles[0], task: 'Diğer parçaları birleştir ve test et.', after: tasks.map((t) => t.id) });
    return `İşi ${tasks.length} göreve böldüm.\n\n\`\`\`json\n${JSON.stringify({ tasks, done: false })}\n\`\`\``;
  }
  if (/planlayıcısısın/.test(system)) {
    return 'Plan hazır.\n\n```json\n{"steps":[{"title":"Hazırlık","details":"Gerekli dosyaları oluştur"},{"title":"Uygulama","details":"İşi tamamla ve test et"}]}\n```';
  }
  if (/denetçisisin/.test(system)) return 'Değişiklikleri inceledim; hedefe uygun.\n\nKARAR: ONAY';
  return null;
}

export default {
  id: 'mock',
  name: 'Test Ajanı',
  capabilities: { edit: true, resume: true, streaming: true, cwd: true, sandbox: true, localProcess: true },

  async detect() {
    return { available: true, version: 'mock-1' };
  },

  async listModels() {
    return [
      { id: 'hizli', label: 'Hızlı', default: true },
      { id: 'yavas', label: 'Yavaş' },
    ];
  },

  async getLimits() {
    return { items: [{ label: 'Sahte kota', usedPercent: 42, resetsAt: new Date(Date.now() + 3600e3).toISOString() }] };
  },

  async run({ prompt, cwd, model, sessionId, permission = 'read-only', system, signal, onEvent = () => {} }) {
    const sid = sessionId || `mock-${++counter}`;
    const delay = model === 'yavas' ? 120 : 25;
    onEvent({ type: 'status', text: 'Düşünüyor…' });
    await sleep(delay * 4, signal);

    const firstLine = String(prompt).split('\n').find((l) => l.trim()) || '';
    const reply = roleReply(String(prompt), String(system || '')) ||
      `(${model || 'hizli'}) Mesajını aldım: "${firstLine.slice(0, 120)}". ` +
      `Bu sahte bir cevaptır; gerçek ajanlar yerine arayüzü ve orkestrasyonu test etmek için kullanılır.\n\n` +
      `- Madde bir\n- Madde iki\n\n\`\`\`js\nconsole.log('merhaba');\n\`\`\`\n\nÖZET: sahte iş yapıldı`;

    const toolId = `t${counter}`;
    onEvent({ type: 'tool-start', id: toolId, name: 'Read', input: { file_path: 'README.md' } });
    await sleep(delay * 3, signal);
    onEvent({ type: 'tool-end', id: toolId, output: '# örnek dosya içeriği', isError: false });

    if (permission !== 'read-only' && cwd) {
      const file = path.join(cwd, `mock-${sid}.txt`);
      const wid = `w${counter}`;
      onEvent({ type: 'tool-start', id: wid, name: 'Write', input: { file_path: file } });
      await writeFile(file, `mock ajanı tarafından yazıldı\n${firstLine}\n`, 'utf8');
      onEvent({ type: 'tool-end', id: wid, output: 'ok', isError: false });
    }

    let text = '';
    for (const word of reply.split(/(\s+)/)) {
      text += word;
      onEvent({ type: 'text-delta', text: word });
      await sleep(delay / 3, signal);
    }
    onEvent({ type: 'message', text });
    const usage = { inputTokens: prompt.length, outputTokens: text.length, costUsd: 0 };
    onEvent({ type: 'usage', ...usage });
    onEvent({ type: 'done', text, sessionId: sid });
    return { text, sessionId: sid, usage };
  },
};

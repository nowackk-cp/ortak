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

  async run({ prompt, cwd, model, sessionId, permission = 'read-only', signal, onEvent = () => {} }) {
    const sid = sessionId || `mock-${++counter}`;
    const delay = model === 'yavas' ? 120 : 25;
    onEvent({ type: 'status', text: 'Düşünüyor…' });
    await sleep(delay * 4, signal);

    const firstLine = String(prompt).split('\n').find((l) => l.trim()) || '';
    const reply =
      `(${model || 'hizli'}) Mesajını aldım: "${firstLine.slice(0, 120)}". ` +
      `Bu sahte bir cevaptır; gerçek ajanlar yerine arayüzü ve orkestrasyonu test etmek için kullanılır.\n\n` +
      `- Madde bir\n- Madde iki\n\n\`\`\`js\nconsole.log('merhaba');\n\`\`\``;

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

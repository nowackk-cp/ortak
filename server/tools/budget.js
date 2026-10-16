// How much a tool may send back to one agent. A free API model on a tight tier (Groq: ~8000
// tokens per minute) fails outright on a 120K-character file, so every tool result is sized from
// the agent's prompt budget (diffview.promptBudget): small for Groq, large for Gemini web.
import { promptBudget } from '../orchestrator/diffview.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(n)));

/**
 * { read, readTotal, output, grepHits, listing, web, symbols } for the adapter of a lane:
 * read      chars of one file per read
 * readTotal chars of all files sent in one message (text protocol)
 * output    chars of one command's output
 * grepHits  matching lines per search
 * listing   project files listed in a first message (more → a map of folders instead)
 * web       chars of one fetched page
 * symbols   outline / find_symbol lines
 */
export function toolCaps(adapter) {
  const b = promptBudget(adapter);
  return {
    read: clamp(b * 0.45, 4000, 120_000),
    readTotal: clamp(b, 8000, 300_000),
    output: clamp(b * 0.35, 3000, 12_000),
    grepHits: b < 20_000 ? 40 : b < 60_000 ? 100 : 150,
    listing: b < 20_000 ? 60 : b < 60_000 ? 200 : 400,
    web: clamp(b * 0.4, 4000, 40_000),
    symbols: b < 20_000 ? 120 : 400,
  };
}

/** Head + tail of a long text, with what was left out in between. */
export function clipMiddle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${s.slice(0, head)}\n…(${s.length - max} karakter atlandı)…\n${s.slice(-tail)}`;
}

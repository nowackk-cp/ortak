// Tolerant JSON extraction from model answers (```json blocks, bare objects, small syntax slips).

/** Every balanced top-level {...} substring (string-aware). */
export function balancedObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
    }
  }
  return out;
}

/** JSON.parse with fixes for smart quotes and trailing commas; null if hopeless. */
export function tryParse(s) {
  const t = String(s).trim();
  const fixed = t.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
  for (const a of [t, fixed]) { try { return JSON.parse(a); } catch { /* next */ } }
  const i = fixed.indexOf('{'), j = fixed.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(fixed.slice(i, j + 1)); } catch { /* give up */ } }
  return null;
}

/**
 * Parsed JSON candidates from an answer, most likely first: ```json blocks (last first), other
 * fenced blocks, then bare objects containing `mustContain`.
 */
export function jsonCandidates(text, mustContain = '') {
  const src = String(text || '').slice(0, 200_000);
  const blocks = [...src.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const raw = [
    ...blocks.filter((b) => b.lang === 'json').reverse().map((b) => b.body),
    ...blocks.filter((b) => b.lang !== 'json').reverse().map((b) => b.body),
    ...balancedObjects(src).filter((s) => !mustContain || s.includes(mustContain)).reverse(),
  ];
  const out = [];
  for (const r of raw) {
    const v = tryParse(r);
    if (v != null) out.push(v);
  }
  return out;
}

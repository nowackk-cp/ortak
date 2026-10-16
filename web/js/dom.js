// Tiny DOM helpers. All text goes through text nodes / textContent; the only innerHTML use is
// for the constant icon markup below and for the escaped output of markdown.js.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'open', 'readOnly', 'indeterminate']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (PROPS.has(k)) { el[k] = v; continue; }
      if (v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else for (const p in v) el.style.setProperty(p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v[p]);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, children);
  return el;
}

/** replaceChildren that skips null/false/undefined children. */
export function fill(el, ...children) {
  el.replaceChildren();
  return add(el, children);
}

export function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

// Hand-drawn 24x24 stroke icons (constant markup).
const ICONS = {
  chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/>',
  chats: '<path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h9a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 14 13H8.5L5 16v-3a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M18 8.5h1A1.5 1.5 0 0 1 20.5 10v6a1.5 1.5 0 0 1-1.5 1.5v3l-3.5-3H11a1.5 1.5 0 0 1-1.5-1.5V16"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  split: '<path d="M12 21v-7"/><path d="M12 14 5 6M12 14l7-8M12 14V4"/><path d="M3.5 7.5 5 6l1.5 1.5M17.5 7.5 19 6l1.5 1.5M10.5 5.5 12 4l1.5 1.5"/>',
  crown: '<path d="M4.5 17 3 7.5l5 3.8L12 5l4 6.3 5-3.8L19.5 17z"/><path d="M5 20.5h14"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.1c2.6.4 4.5 2.8 4.5 5.9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9"/>',
  check: '<path d="M5 12.5 9.5 17 19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  terminal: '<path d="M5 7l5 5-5 5M12.5 17H19"/>',
  branch: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="7.5" r="2"/><path d="M6 7.5v9M18 9.5c0 4.5-7 3.5-11 7.5"/>',
  warn: '<path d="M12 4 21 20H3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.3"/>',
  sparkle: '<path d="M12 3.5 13.9 9 19.5 11l-5.6 2L12 18.5 10.1 13 4.5 11l5.6-2z"/><path d="M19 3v3M17.5 4.5h3"/>',
  brain: '<path d="M9.5 4.5A2.5 2.5 0 0 0 7 7a2.5 2.5 0 0 0-2 4 2.8 2.8 0 0 0 1 4.6A2.5 2.5 0 0 0 9.5 19.5c1.4 0 2.5-1 2.5-2.3V6.8c0-1.3-1.1-2.3-2.5-2.3z"/><path d="M14.5 4.5A2.5 2.5 0 0 1 17 7a2.5 2.5 0 0 1 2 4 2.8 2.8 0 0 1-1 4.6 2.5 2.5 0 0 1-3.5 3.9c-1.4 0-2.5-1-2.5-2.3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  clip: '<path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/>',
  file: '<path d="M6.5 3h7.5l4.5 4.5V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4.5h4.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-4.1 3.4-7.5 7.5-7.5s7.5 3.4 7.5 7.5"/>',
  arrowDown: '<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  gauge: '<path d="M4.5 17.5a8.5 8.5 0 1 1 15 0"/><path d="M12 13.5l4-4.5"/><circle cx="12" cy="14" r="1.3" fill="currentColor" stroke="none"/>',
  code: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5"/>',
  key: '<circle cx="8" cy="15.5" r="3.8"/><path d="M10.8 12.8 19.5 4M16 7.5l2.5 2.5M13.8 9.8l2 2"/>',
  moonzz: '<path d="M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z"/><path d="M15 4h4l-4 4h4"/>',
};

export function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic${cls ? ' ' + cls : ''}" ${SVG}>${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

export function spinner(cls = '') {
  return h('span', { class: `spin${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
}

/** Set an element's HTML from markdown.js output (already escaped). */
export function setSafeHtml(el, html) {
  el.innerHTML = html;
}

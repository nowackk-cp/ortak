// Folder browser modal backed by GET /api/fs/list?path= → { path, parent, dirs: [{ name, path }] }.
// An empty path lists the drives on Windows. Click a folder to enter it; "Bu klasörü seç" picks it.
import { h, icon, spinner } from './dom.js';
import { api } from './api.js';
import { enc } from './util.js';

export function openFolderPicker(startPath, onPick) {
  const prevFocus = document.activeElement;
  let cur = null;
  let token = 0;

  const list = h('div', { class: 'fp-list' });
  const pathEl = h('div', { class: 'fp-path' });
  const upBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Üst klasöre çık' }, icon('up'), 'Üst');
  const chooseBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('check'), 'Bu klasörü seç');

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Proje klasörü seç' },
      h('div', { class: 'modal-head' },
        h('strong', { text: 'Proje klasörü seç' }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Kapat', 'aria-label': 'Kapat', onclick: close }, icon('x'))),
      h('div', { class: 'fp-bar' }, upBtn, pathEl),
      list,
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: close }, 'İptal'),
        chooseBtn)));

  async function load(p, fallback) {
    const my = ++token;
    list.replaceChildren(h('div', { class: 'sb-empty' }, spinner('sm'), 'Yükleniyor…'));
    let r;
    try {
      r = await api(`/api/fs/list?path=${enc(p || '')}`, { quiet: true });
    } catch (err) {
      if (my !== token) return;
      if (fallback) { load('', false); return; }
      list.replaceChildren(h('div', { class: 'fp-err', text: err.message }));
      return;
    }
    if (my !== token) return;
    cur = r || { path: '', parent: null, dirs: [] };
    pathEl.textContent = cur.path || 'Bu bilgisayar';
    pathEl.title = cur.path || '';
    upBtn.disabled = cur.parent == null;
    chooseBtn.disabled = !cur.path;
    // hide dot-folders (.git, .vscode …); they are never project roots
    const dirs = (Array.isArray(cur.dirs) ? cur.dirs : []).filter((d) => !String(typeof d === 'string' ? d : d?.name || '').startsWith('.'));
    list.replaceChildren(...(dirs.length
      ? dirs.map((d) => {
        const name = typeof d === 'string' ? d : d?.name;
        const full = typeof d === 'string' ? d : d?.path;
        return h('button', { type: 'button', class: 'fp-item', title: full, onclick: () => load(full) }, icon('folder'), h('span', { text: name || full }));
      })
      : [h('div', { class: 'sb-empty', text: 'Alt klasör yok.' })]));
    list.scrollTop = 0;
    (list.querySelector('.fp-item') || chooseBtn).focus({ preventScroll: true });
  }

  upBtn.addEventListener('click', () => { if (cur && cur.parent != null) load(cur.parent); });
  chooseBtn.addEventListener('click', () => {
    if (!cur?.path) return;
    onPick(cur.path);
    close();
  });

  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  load(startPath || '', !!startPath);
}

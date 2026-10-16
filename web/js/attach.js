// Files attached to the next message (composer): ataç button, drag & drop, paste.
// Text files are sent inline as { name, text }; images (PNG/JPEG/WebP/GIF) as
// { kind: 'image', name, mime, data: base64 } — the server saves them and hands them to the agents.
import { h, icon } from './dom.js';
import { toast } from './api.js';

const MAX_FILES = 10;
const EACH_MAX = 200_000;  // chars kept per file (the server enforces the same)
const TOTAL_MAX = 600_000;
const BYTES_MAX = 8 * 1024 * 1024; // larger files are not even read
const MAX_IMAGES = 6;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

let files = []; // [{ name, text, truncated }] | [{ kind: 'image', name, mime, data, preview }]
let listEl = null;

export const attached = () => files.map(({ preview, ...f }) => ({ ...f }));
export const hasAttachments = () => files.length > 0;

export function clearAttachments() {
  for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
  files = [];
  render();
}

function render() {
  if (!listEl) return;
  listEl.hidden = !files.length;
  listEl.replaceChildren(...files.map((f, i) => h('span', { class: `attach-chip${f.kind === 'image' ? ' attach-img' : ''}`, title: f.truncated ? `${f.name} (kısaltıldı)` : f.name },
    f.kind === 'image' ? h('img', { src: f.preview, alt: '' }) : icon('file'),
    h('span', { class: 'attach-name', text: f.name }),
    h('button', {
      type: 'button', class: 'attach-x', title: 'Kaldır', 'aria-label': `${f.name} dosyasını kaldır`,
      onclick: () => { const [gone] = files.splice(i, 1); if (gone?.preview) URL.revokeObjectURL(gone.preview); render(); },
    }, icon('x')))));
}

async function addFile(file) {
  if (files.length >= MAX_FILES) { toast(`En fazla ${MAX_FILES} dosya eklenebilir.`, 'error'); return; }
  if (file.size > BYTES_MAX) { toast(`${file.name} çok büyük (en fazla 8 MB).`, 'error'); return; }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (IMAGE_TYPES.has(file.type)) {
    if (files.filter((f) => f.kind === 'image').length >= MAX_IMAGES) { toast(`Bir mesaja en fazla ${MAX_IMAGES} resim eklenebilir.`, 'error'); return; }
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const name = file.name && file.name !== 'image.png' ? file.name : `resim-${files.length + 1}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
    files.push({ kind: 'image', name, mime: file.type, data: btoa(bin), preview: URL.createObjectURL(file) });
    render();
    return;
  }
  if (buf.subarray(0, 8000).includes(0)) {
    toast(`${file.name} bir metin dosyası ya da desteklenen bir resim (PNG, JPEG, WebP, GIF) değil.`, 'error');
    return;
  }
  let text = new TextDecoder('utf-8').decode(buf);
  const used = files.reduce((n, f) => n + (f.text?.length || 0), 0);
  const room = Math.min(EACH_MAX, TOTAL_MAX - used);
  if (room <= 0) { toast('Eklenen dosyalar toplamda çok büyük.', 'error'); return; }
  const truncated = text.length > room;
  if (truncated) {
    text = text.slice(0, room);
    toast(`${file.name} uzun olduğu için kısaltıldı.`, 'info');
  }
  const name = file.webkitRelativePath || file.name;
  files = files.filter((f) => f.name !== name);
  files.push({ name, text, ...(truncated ? { truncated: true } : {}) });
  render();
}

export async function addFiles(list) {
  for (const f of Array.from(list || [])) await addFile(f).catch(() => toast(`${f.name} okunamadı.`, 'error'));
}

/** Wires the ataç button, hidden <input type=file>, drop on the composer and pasted files. */
export function initAttach({ button, input, list, dropZone, canAttach }) {
  listEl = list;
  button.append(icon('clip'));
  button.addEventListener('click', () => { if (canAttach()) input.click(); });
  input.addEventListener('change', async () => {
    await addFiles(input.files);
    input.value = '';
  });
  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files') || !canAttach()) return;
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragging');
  });
  dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('dragging');
    if (!e.dataTransfer?.files?.length || !canAttach()) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.files;
    if (!pasted?.length || !canAttach()) return;
    e.preventDefault();
    addFiles(pasted);
  });
  render();
}

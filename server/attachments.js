// Files the user attaches to a message (composer: ataç, drag & drop, paste).
//  - text files → inlined into the message text the agents see
//  - images     → saved under data/attachments/<id>/ and
//      * handed to agents that can see images (capabilities.images: Gemini web pastes them into
//        the page, EVREN sends them to vision models) on their next turn — see context.js
//      * listed with their path in the message text, so agents with file tools (Claude Code,
//        Codex…) can open them
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './settings.js';
import { badRequest } from './util.js';

const MAX_FILES = 10;
const TEXT_EACH_MAX = 200_000; // chars per attached text file
const TEXT_TOTAL_MAX = 600_000;
const MAX_IMAGES = 6;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

export const ATT_ROOT = path.join(dataDir, 'attachments');
const cleanName = (s, fb) => String(s || '').replace(/[\r\n`]/g, '').trim().slice(0, 200) || fb;

/** Validates `raw` → { texts: [{ name, text, truncated? }], images: [{ name, mime, buf }] }. */
export function parse(raw) {
  if (raw == null) return { texts: [], images: [] };
  if (!Array.isArray(raw)) throw badRequest('Geçersiz dosya ekleri.');
  if (raw.length > MAX_FILES) throw badRequest(`En fazla ${MAX_FILES} dosya eklenebilir.`);
  const texts = [];
  const images = [];
  let total = 0;
  for (const f of raw) {
    if (!f || typeof f.name !== 'string') throw badRequest('Geçersiz dosya eki.');
    if (f.kind === 'image') {
      const ext = IMAGE_TYPES[f.mime];
      if (!ext || typeof f.data !== 'string') throw badRequest(`${cleanName(f.name, 'resim')}: desteklenmeyen resim türü (PNG, JPEG, WebP, GIF).`);
      if (images.length >= MAX_IMAGES) throw badRequest(`Bir mesaja en fazla ${MAX_IMAGES} resim eklenebilir.`);
      const buf = Buffer.from(f.data, 'base64');
      if (!buf.length) throw badRequest('Boş resim.');
      if (buf.length > IMAGE_MAX_BYTES) throw badRequest(`${cleanName(f.name, 'resim')} çok büyük (en fazla 8 MB).`);
      images.push({ name: cleanName(f.name, `resim${ext}`), mime: f.mime, buf });
      continue;
    }
    if (typeof f.text !== 'string') throw badRequest('Geçersiz dosya eki.');
    let text = f.text;
    let truncated = !!f.truncated;
    const room = Math.min(TEXT_EACH_MAX, TEXT_TOTAL_MAX - total);
    if (room <= 0) throw badRequest('Eklenen dosyalar toplamda çok büyük.');
    if (text.length > room) { text = text.slice(0, room); truncated = true; }
    total += text.length;
    texts.push({ name: cleanName(f.name, 'dosya'), text, ...(truncated ? { truncated: true } : {}) });
  }
  return { texts, images };
}

/** Writes images to data/attachments/<id>/ → [{ name, mime, path, url }] (url: /api/attachments/<id>/<file>). */
export async function saveImages(images) {
  if (!images.length) return [];
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(ATT_ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const base = img.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'resim';
    const file = `${i + 1}-${base}${IMAGE_TYPES[img.mime]}`;
    await fs.writeFile(path.join(dir, file), img.buf);
    out.push({ name: img.name, mime: img.mime, path: path.join(dir, file), url: `/api/attachments/${id}/${file}` });
  }
  return out;
}

/** Absolute path of a served attachment, or null (no traversal). */
export function servedPath(id, file) {
  if (!/^[a-z0-9-]+$/i.test(id) || !/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith('.')) return null;
  return path.join(ATT_ROOT, id, file);
}

/** Removes the folders of the given saved images. */
export async function removeImages(images = []) {
  const dirs = new Set(images.map((x) => x?.path && path.dirname(x.path)).filter((d) => d && d.startsWith(ATT_ROOT)));
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
}

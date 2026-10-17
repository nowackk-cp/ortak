// Renders the Ortak logo (same as the favicon in web/index.html: orange rounded square with two
// white rings) into assets/ortak.ico at several sizes, and the phone's home-screen icons
// (web/icons/*.png, see web/manifest.webmanifest). Zero dependencies: PNG-in-ICO.
//   node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'assets', 'ortak.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling per axis

const BG = [0xd4, 0x82, 0x5f];
const FG = [0xff, 0xff, 0xff];

// Geometry in the favicon's 32×32 user space.
const RX = 8;
const RINGS = [[12, 16], [20, 16]];
const R = 6;
const HALF_STROKE = 1.3;

function inRoundedRect(x, y) {
  const cx = Math.min(Math.max(x, RX), 32 - RX);
  const cy = Math.min(Math.max(y, RX), 32 - RX);
  return x >= 0 && y >= 0 && x <= 32 && y <= 32 && (x - cx) ** 2 + (y - cy) ** 2 <= RX * RX;
}

function inRing(x, y) {
  return RINGS.some(([cx, cy]) => Math.abs(Math.hypot(x - cx, y - cy) - R) <= HALF_STROKE);
}

/** `full`: no transparent corners (iOS rounds the home-screen icon itself). */
function render(size, { full = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 32 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) * scale;
          const uy = (y + (sy + 0.5) / SS) * scale;
          if (!full && !inRoundedRect(ux, uy)) continue;
          const c = inRing(ux, uy) ? FG : BG;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((s) => ({ size: s, data: png(s, render(s)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4);   // planes
  e.writeUInt16LE(32, 6);  // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`${OUT} (${SIZES.join(', ')} px)`);

// phone: home-screen icons
const ICONS = path.join(ROOT, 'web', 'icons');
fs.mkdirSync(ICONS, { recursive: true });
for (const [name, size, full] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['apple-touch-icon.png', 180, true]]) {
  fs.writeFileSync(path.join(ICONS, name), png(size, render(size, { full })));
}
console.log(`${ICONS} (192, 512, apple-touch-icon 180 px)`);

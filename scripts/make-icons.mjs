// Иконки PWA (PNG) из того же рисунка, что favicon.svg: папка со стрелкой на зелёном фоне.
// Без зависимостей: растеризация отрезками с 4×4 сглаживанием и запись PNG через zlib.
// Запуск: node scripts/make-icons.mjs → public/icons/*.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BRAND = [0x11, 0x86, 0x6c];
const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'icons');

// Контур папки (координаты 32×32 как в favicon.svg), скругления — дугами из отрезков.
function arc(cx, cy, r, from, to, steps = 8) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
const P = Math.PI;
const folder = [
  ...arc(11.5, 11.5, 2.5, P, 1.5 * P), [14.7, 9], [16.7, 11.2],
  ...arc(20.5, 13.7, 2.5, 1.5 * P, 2 * P), ...arc(20.5, 20.5, 2.5, 0, 0.5 * P),
  ...arc(11.5, 20.5, 2.5, 0.5 * P, P), [9, 11.5],
];
const arrow = [[[16, 20], [16, 15]], [[13.8, 17.2], [16, 15], [18.2, 17.2]]];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
const near = (px, py, line, w) => line.some((p, i) => i > 0 && segDist(px, py, line[i - 1], p) <= w / 2);

function inRoundRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** @param {number} size @param {boolean} maskable — фон до краёв, рисунок в безопасной зоне */
function render(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const scale = maskable ? 0.72 : 1; // безопасная зона maskable — круг 80% от размера
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (maskable || inRoundRect(fx, fy, size, size * 0.25)) bg++;
          // в координаты рисунка 32×32
          const u = ((fx / size - 0.5) / scale + 0.5) * 32;
          const v = ((fy / size - 0.5) / scale + 0.5) * 32;
          if (near(u, v, folder, 1.8) || arrow.some((l) => near(u, v, l, 1.8))) fg++;
        }
      }
      const a = bg / (SS * SS);
      const f = Math.min(fg, bg) / (SS * SS);
      const i = (y * size + x) * 4;
      // фон бренда, поверх — белый рисунок
      const mix = a ? f / a : 0;
      px[i] = Math.round(BRAND[0] + (255 - BRAND[0]) * mix);
      px[i + 1] = Math.round(BRAND[1] + (255 - BRAND[1]) * mix);
      px[i + 2] = Math.round(BRAND[2] + (255 - BRAND[2]) * mix);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит, RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  fs.writeFileSync(path.join(out, name), render(size, maskable));
  console.log('icons/' + name);
}

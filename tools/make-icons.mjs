// Draws Perch's icon (a small amber window perched over a larger frame) into PNGs.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [21, 22, 26];
const FRAME = [244, 241, 234];
const ACCENT = [255, 181, 71];

function inRoundRect(x, y, l, t, r, b, rad) {
  if (x < l || x > r || y < t || y > b) return false;
  const cx = Math.min(Math.max(x, l + rad), r - rad);
  const cy = Math.min(Math.max(y, t + rad), b - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}

// Shapes in a 128-unit space.
function sample(x, y) {
  if (!inRoundRect(x, y, 4, 4, 124, 124, 28)) return null;
  if (inRoundRect(x, y, 58, 26, 108, 66, 9)) return ACCENT;
  const outer = inRoundRect(x, y, 22, 44, 94, 102, 10);
  const inner = inRoundRect(x, y, 30, 52, 86, 94, 4);
  const hole = inRoundRect(x, y, 51, 19, 115, 73, 13);
  if (outer && !inner && !hole) return FRAME;
  return BG;
}

function png(size) {
  const ss = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = sample(((x + (sx + 0.5) / ss) / size) * 128, ((y + (sy + 0.5) / ss) / size) * 128);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      const n = ss * ss;
      row.set(a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / n) * 255)] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

const out = new URL('../extension/icons/', import.meta.url);
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`${size}.png`, out), png(size));
console.log('icons written');

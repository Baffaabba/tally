'use strict';

// Draws the Tally app icon — the bar's dark housing with a lit tally lamp —
// and writes build/icon.ico (16–256 px, picked up by electron-builder) and
// build/icon.png (512 px). No dependencies: pixels are computed directly and
// encoded with zlib.
//
//   node scripts/make-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersamples per axis, for smooth edges

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const HOUSING_TOP = hex('#22262d');
const HOUSING_BOTTOM = hex('#0f1114');
const EDGE = hex('#3a4149');
const WELL = hex('#08090b');
const TALLY = hex('#e5342a');
const TALLY_HOT = hex('#ff8a6a');

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Signed distance to a rounded square centred at 0.5,0.5 (unit coordinates). */
function roundedSquare(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Colour and alpha of one sample point, unit coordinates. */
function sample(x, y, size) {
  const small = size <= 24; // at tiny sizes drop detail, enlarge the lamp
  const half = 0.47;
  const d = roundedSquare(x, y, half, 0.2);
  if (d > 0) {
    // outside the tile: only the lamp's glow may spill (it doesn't), so clear
    return [0, 0, 0, 0];
  }

  let c = mix(HOUSING_TOP, HOUSING_BOTTOM, y);
  // thin lighter rim
  const rim = small ? 0 : 0.022;
  if (d > -rim) c = mix(c, EDGE, 0.85);

  const r = Math.hypot(x - 0.5, y - 0.5);
  const lampR = small ? 0.27 : 0.2;
  const wellR = lampR + (small ? 0.06 : 0.07);

  // recessed well around the lamp
  if (!small && r < wellR) c = mix(c, WELL, 0.9);

  // glow
  const glow = Math.max(0, 1 - (r - lampR) / (small ? 0.12 : 0.2));
  if (r >= lampR && glow > 0) c = mix(c, TALLY, 0.55 * glow * glow);

  // the lamp, with a hot spot toward the top-left
  if (r < lampR) {
    const hs = Math.hypot(x - (0.5 - lampR * 0.35), y - (0.5 - lampR * 0.35)) / lampR;
    c = mix(TALLY, TALLY_HOT, Math.max(0, 1 - hs) * 0.8);
  }
  return [...c, 255];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0, 0];
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const s = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, size);
          const a = s[3] / 255;
          acc[0] += s[0] * a; acc[1] += s[1] * a; acc[2] += s[2] * a; acc[3] += a;
        }
      }
      const o = (j * size + i) * 4;
      const a = acc[3];
      px[o] = a ? Math.round(acc[0] / a) : 0;
      px[o + 1] = a ? Math.round(acc[1] / a) : 0;
      px[o + 2] = a ? Math.round(acc[2] / a) : 0;
      px[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)]);
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.ico'), ico(SIZES.map((size) => ({ size, data: png(size) }))));
fs.writeFileSync(path.join(out, 'icon.png'), png(512));
console.log('wrote build/icon.ico and build/icon.png');

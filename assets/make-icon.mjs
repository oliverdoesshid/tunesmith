/**
 * Generates the TuneSmith application icon: a dark rounded tile with a cyan
 * gauge arc, tick marks and an amber needle. Zero dependencies — pixels are
 * rendered into a buffer, encoded to PNG by hand, and packed into a .ico
 * (PNG-compressed entries, supported since Vista) that electron-builder uses.
 *
 * Run: `node assets/make-icon.mjs`  →  assets/icon.ico + assets/icon-256.png
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = 512; // render resolution, downsampled for small icon sizes
const SIZES = [256, 48, 32, 16];

const buf = new Uint8ClampedArray(MASTER * MASTER * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= MASTER || y >= MASTER || a <= 0) return;
  const i = (y * MASTER + x) * 4;
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const out = sa + da * (1 - sa);
  if (out <= 0) return;
  buf[i] = (r * sa + buf[i] * da * (1 - sa)) / out;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / out;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / out;
  buf[i + 3] = out * 255;
}

function disc(cx, cy, rad, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(MASTER - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(MASTER - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const alpha = Math.min(1, Math.max(0, rad + 0.5 - d)) * a;
      if (alpha > 1) blend(x, y, r, g, b, a);
    }
  }
}

function capsule(x0, y0, x1, y1, w, r, g, b, a) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const pad = w / 2 + 1;
  const xMin = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const xMax = Math.min(MASTER - 1, Math.ceil(Math.max(x0, x1) + pad));
  const yMin = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const yMax = Math.min(MASTER - 1, Math.ceil(Math.max(y0, y1) + pad));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      let t = len2 === 0 ? 0 : (px * dx + py * dy) / len2;
      t = Math.min(1, Math.max(0, t));
      const d = Math.hypot(px - dx * t, py - dy * t);
      const alpha = Math.min(1, Math.max(0, w / 2 + 0.5 - d)) * a;
      if (alpha > 1) blend(x, y, r, g, b, a);
    }
  }
}

// --- background: vertical-gradient rounded tile, transparent corners ---
const RADIUS = 112;
const TOP = [27, 42, 74];
const BOT = [11, 17, 32];
for (let y = 0; y < MASTER; y++) {
  for (let x = 0; x < MASTER; x++) {
    const dx = Math.min(x + 0.5, MASTER - 1 - x);
    const dy = Math.min(y + 0.5, MASTER - 1 - y);
    // distance outside the rounded-rect body (negative = inside)
    const cx = Math.min(Math.max(x + 0.5, RADIUS), MASTER - RADIUS);
    const cy = Math.min(Math.max(y + 0.5, RADIUS), MASTER - RADIUS);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - RADIUS;
    if (d >= 0.5) continue;
    const t = y / (MASTER - 1);
    const cr = TOP[0] + (BOT[0] - TOP[0]) * t;
    const cg = TOP[1] + (BOT[1] - TOP[1]) * t;
    const cb = TOP[2] + (BOT[2] - TOP[2]) * t;
    blend(x, y, cr, cg, cb, 255 * Math.min(1, 0.5 - d));
  }
}
// thin inner border highlight
for (let y = 6; y < MASTER - 6; y++) {
  for (let x = 6; x < MASTER - 6; x++) {
    const cx = Math.min(Math.max(x + 0.5, RADIUS), MASTER - RADIUS);
    const cy = Math.min(Math.max(y + 0.5, RADIUS), MASTER - RADIUS);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - (RADIUS - 7);
    if (Math.abs(d) < 1.5) blend(x, y, 148, 163, 184, 40);
  }
}

// --- gauge (y-down angles: 135° = SW, sweep clockwise to 405° = SE) ---
const CX = 256;
const CY = 272;
const RAD = 148;
const A0 = 135;
const A1 = 405;
const NEEDLE_A = 318;
const rad = (a) => (a * Math.PI) / 180;
const px = (a, r) => CX + r * Math.cos(rad(a));
const py = (a, r) => CY + r * Math.sin(rad(a));

function arcBand(a0, a1, rMid, half, cr, cg, cb, alpha, step = 0.4) {
  for (let a = a0; a <= a1; a += step) {
    const x = px(a, rMid);
    const y = py(a, rMid);
    disc(x, y, half, cr, cg, cb, alpha * 0.12);
  }
  for (let a = a0; a <= a1; a += step) {
    const x = px(a, rMid);
    const y = py(a, rMid);
    disc(x, y, half * 0.55, cr, cg, cb, alpha * 0.2);
  }
}

// glow, track, value portion
arcBand(A0, A1, RAD, 26, 34, 211, 238, 60);
arcBand(A0, A1, RAD, 15, 100, 116, 139, 110);
arcBand(A0, NEEDLE_A, RAD, 15, 34, 211, 238, 235);

// ticks
for (let a = A0; a <= A1 + 0.01; a += 15) {
  const major = Math.round((a - A0) % 45) === 0;
  capsule(px(a, 168), py(a, 168), px(a, major ? 138 : 150), py(a, major ? 138 : 150),
    major ? 9 : 5, 203, 213, 225, major ? 235 : 150);
}

// needle
const nx = px(NEEDLE_A, 116);
const ny = py(NEEDLE_A, 116);
const tx = px(NEEDLE_A, -34);
const ty = py(NEEDLE_A, -34);
capsule(tx, ty, nx, ny, 17, 251, 191, 36, 255);
capsule(tx, ty, nx, ny, 6, 255, 251, 235, 255);

// hub
disc(CX, CY, 30, 15, 23, 42, 255);
for (let a = 0; a < 360; a += 1.5) disc(px(a, 30), py(a, 30), 4, 34, 211, 238, 230);
disc(CX, CY, 11, 34, 211, 238, 255);

// --- downsample (box average) ---
function downsample(size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const k = MASTER / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * k);
      const x1 = Math.floor((x + 1) * k);
      const y0 = Math.floor(y * k);
      const y1 = Math.floor((y + 1) * k);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * MASTER + sx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = (x1 - x0) * (y1 - y0);
      const j = (y * size + x) * 4;
      out[j] = r / n; out[j + 1] = g / n; out[j + 2] = b / n; out[j + 3] = a / n;
    }
  }
  return out;
}

// --- minimal PNG encoder (RGBA, filter 0) ---
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc(bytes) {
  let c = -1;
  for (const v of bytes) c = CRC_TABLE[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, c]);
}
function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4)
      .copy(raw, y * (1 + size * 4) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- .ico packing (PNG-compressed entries) ---
const pngs = SIZES.map((s) => encodePng(downsample(s), s));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map((p, i) => {
  const e = Buffer.alloc(16);
  const s = SIZES[i];
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(p.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.length;
  return e;
});
writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
writeFileSync(path.join(root, 'assets', 'icon-256.png'), pngs[0]);
console.log(`icon.ico written (${SIZES.join('/')}px PNG entries)`);

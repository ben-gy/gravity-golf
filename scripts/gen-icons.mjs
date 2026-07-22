// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * gen-icons.mjs — rasterise public/favicon.svg into the PNGs a home-screen
 * install needs. Run: `node scripts/gen-icons.mjs`. Outputs to public/icons/.
 *
 * Why a hand-rolled rasteriser: the repo has no image dependency (no sharp, no
 * resvg) and a PWA icon is not worth adding one for. This is not a general SVG
 * renderer — it encodes the SHAPES of favicon.svg (the same rounded panel, amber
 * planet, dashed cyan trajectory and white ball, in the same 64-unit coordinate
 * space and the same palette) so the icons stay the game's existing identity
 * rather than a second, drifting one. Change favicon.svg and change this too.
 *
 * Coverage is 4x4 supersampled signed distance, which is why the edges are clean
 * at 192px without a font/AA engine.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── palette (src/styles/main.css) ────────────────────────────────────────────
const BG = [0x0a, 0x0e, 0x1a]; // --bg0
const AMBER = [0xff, 0x9f, 0x45]; // --amber
const AMBER_RING = [0xff, 0xd9, 0xa8];
const CYAN = [0x4d, 0xd0, 0xff]; // --cyan
const BALL = [0xea, 0xf6, 0xff];

// ── geometry helpers, all in favicon.svg's 0..64 space ───────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (a) => Math.hypot(a[0], a[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

const sdCircle = (p, c, r) => len(sub(p, c)) - r;
/** A stroked circle: the band of half-width w/2 either side of the radius. */
const sdRing = (p, c, r, w) => Math.abs(len(sub(p, c)) - r) - w / 2;

function sdRoundRect(p, x, y, w, h, r) {
  const cx = Math.abs(p[0] - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(p[1] - (y + h / 2)) - (h / 2 - r);
  const ox = Math.max(cx, 0);
  const oy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.hypot(ox, oy) - r;
}

/** Distance to the segment a→b, i.e. a capsule's spine. */
function sdSegment(p, a, b, w) {
  const pa = sub(p, a);
  const ba = sub(b, a);
  const h = Math.min(1, Math.max(0, dot(pa, ba) / Math.max(dot(ba, ba), 1e-9)));
  return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h]) - w / 2;
}

const quad = (p0, p1, p2, t) => {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
};

/**
 * favicon.svg's `M14 46 Q20 20 40 24` with `stroke-dasharray="1 5"` and round
 * caps: flatten the curve, walk its arc length, and emit a capsule per "on" run.
 * Round caps are what make each 1-unit dash read as a dot.
 */
function dashedQuad(p0, p1, p2, width, dash, gap) {
  const pts = [];
  const STEPS = 400;
  for (let i = 0; i <= STEPS; i++) pts.push(quad(p0, p1, p2, i / STEPS));

  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = cum[cum.length - 1];

  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };

  const caps = [];
  for (let s = 0; s < total; s += dash + gap) {
    caps.push([at(s), at(Math.min(s + dash, total))]);
  }
  return (p) => caps.reduce((m, [a, b]) => Math.min(m, sdSegment(p, a, b, width)), Infinity);
}

const trajectory = dashedQuad([14, 46], [20, 20], [40, 24], 2.5, 1, 5);

/**
 * The icon artwork, as (point in 0..64 space) -> layers to composite in order.
 * `rounded` is false for the iOS icon: iOS applies its own mask, so baking our
 * corners in would show a dark ring inside the system's rounded square.
 */
function layers(rounded) {
  return [
    { sd: (p) => sdRoundRect(p, 0, 0, 64, 64, rounded ? 14 : 0), color: BG, alpha: 1 },
    { sd: (p) => sdCircle(p, [42, 40], 12), color: AMBER, alpha: 1 },
    { sd: (p) => sdRing(p, [42, 40], 12, 1.5), color: AMBER_RING, alpha: 0.5 },
    { sd: trajectory, color: CYAN, alpha: 0.85 },
    { sd: (p) => sdCircle(p, [14, 46], 5), color: BALL, alpha: 1 },
    { sd: (p) => sdRing(p, [14, 46], 5, 1.5), color: CYAN, alpha: 1 },
  ];
}

/**
 * `inset` shrinks the artwork toward the centre for the maskable icon: Android
 * crops adaptive icons to a circle/squircle of ~80% of the canvas, so anything
 * outside that safe zone is cut. The BACKGROUND still goes full-bleed, which is
 * the whole point of a separate maskable file.
 */
function render(size, { rounded = true, inset = 0 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersamples per pixel
  const art = layers(rounded);
  const bg = art[0];
  const fg = art.slice(1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((x + (sx + 0.5) / SS) / size) * 64;
          const uy = ((y + (sy + 0.5) / SS) / size) * 64;
          // Background always fills the frame; only the artwork is inset.
          const p = [ux, uy];
          const q = [(ux - 32) / (1 - inset) + 32, (uy - 32) / (1 - inset) + 32];

          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const layer of [{ ...bg, p }, ...fg.map((l) => ({ ...l, p: q }))]) {
            // Distance -> coverage across roughly one supersample of width.
            const cov = Math.min(1, Math.max(0, 0.5 - layer.sd(layer.p) * (size / 64) * SS)) * layer.alpha;
            if (cov <= 0) continue;
            cr = layer.color[0] * cov + cr * (1 - cov);
            cg = layer.color[1] * cov + cg * (1 - cov);
            cb = layer.color[2] * cov + cb * (1 - cov);
            ca = cov + ca * (1 - cov);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// ── minimal PNG encoder (RGBA8, one IDAT) ────────────────────────────────────
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) | 0, 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12: deflate / adaptive filtering / no interlace — all zero.

  // Every scanline gets filter byte 0 (None); the image is tiny and zlib does
  // the work.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── go ───────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  // Android crops adaptive icons hard; 20% inset keeps the ball and the planet
  // inside the safe zone whatever mask the launcher picks.
  { file: 'icon-512-maskable.png', size: 512, opts: { rounded: false, inset: 0.2 } },
  // iOS ignores the manifest entirely and composites transparency on BLACK, so
  // this one is deliberately full-bleed and fully opaque.
  { file: 'apple-touch-icon.png', size: 180, opts: { rounded: false } },
];

for (const { file, size, opts } of targets) {
  const png = encodePng(render(size, opts), size);
  writeFileSync(join(OUT, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}

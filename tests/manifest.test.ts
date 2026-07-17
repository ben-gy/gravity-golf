/**
 * manifest.test.ts — the home-screen install contract.
 *
 * An install that "works" is easy to fake and impossible to notice broken: a
 * typo'd icon path, or an icon whose real pixels are not the size the manifest
 * claims, just yields a blank or squashed tile on someone's phone weeks later.
 * So this reads the actual PNG headers rather than trusting the filenames, and
 * pins the two rules that are not obvious:
 *
 *  - EVERY path must be relative. The game is served from a project subpath in
 *    dev and from its own domain in prod; a leading "/" only works in one.
 *  - iOS ignores the manifest icons completely, so apple-touch-icon must exist
 *    on its own, at 180x180, and be fully opaque (iOS composites alpha on BLACK).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

interface Png {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  raw: Buffer;
}

/** Read the IHDR straight out of the file — do not trust the name or the size. */
function readPng(path: string): Png {
  const b = readFileSync(path);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(b.subarray(12, 16).toString('ascii')).toBe('IHDR');

  const idat: Buffer[] = [];
  let off = 8;
  while (off < b.length) {
    const length = b.readUInt32BE(off);
    if (b.subarray(off + 4, off + 8).toString('ascii') === 'IDAT') {
      idat.push(b.subarray(off + 8, off + 8 + length));
    }
    off += 12 + length;
  }

  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    bitDepth: b[24],
    colorType: b[25],
    raw: inflateSync(Buffer.concat(idat)),
  };
}

/** Lowest alpha anywhere in an RGBA8, filter-0 PNG (what gen-icons.mjs emits). */
function minAlpha(png: Png): number {
  expect(png.colorType).toBe(6); // RGBA
  expect(png.bitDepth).toBe(8);
  const stride = png.width * 4 + 1;
  let min = 255;
  for (let y = 0; y < png.height; y++) {
    expect(png.raw[y * stride]).toBe(0); // filter: None
    for (let x = 0; x < png.width; x++) {
      const a = png.raw[y * stride + 1 + x * 4 + 3];
      if (a < min) min = a;
    }
  }
  return min;
}

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'),
) as Manifest;

const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');

describe('manifest.webmanifest', () => {
  it('parses and declares everything an install prompt needs', () => {
    expect(manifest.name).toBe('Gravity Golf');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // launcher truncates past this
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation.length).toBeGreaterThan(0);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('uses the game palette for the splash and the status bar', () => {
    // A mismatched theme colour is a white flash on every cold start.
    expect(manifest.background_color).toBe('#0a0e1a'); // --bg0
    expect(manifest.theme_color).toBe('#0a0e1a');
    expect(indexHtml).toContain('<meta name="theme-color" content="#0a0e1a" />');
  });

  it('keeps every path relative so it resolves on a subpath AND on the domain', () => {
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('./')).toBe(true);
    }
  });

  it('ships icons whose REAL pixels match the declared size', () => {
    for (const icon of manifest.icons) {
      const png = readPng(join(PUBLIC, icon.src));
      const [w, h] = icon.sizes.split('x').map(Number);
      expect({ src: icon.src, w: png.width, h: png.height }).toEqual({ src: icon.src, w, h });
      expect(icon.type).toBe('image/png');
    }
  });

  it('includes a 192, a 512, and a dedicated maskable 512', () => {
    const any = manifest.icons.filter((i) => i.purpose !== 'maskable');
    expect(any.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);

    // Without a maskable icon Android crops the "any" one to its adaptive shape
    // and eats the artwork's edges.
    const maskable = manifest.icons.find((i) => i.purpose === 'maskable');
    expect(maskable?.sizes).toBe('512x512');
    // A maskable icon is cropped, so it MUST be opaque to the corners.
    expect(minAlpha(readPng(join(PUBLIC, maskable!.src)))).toBe(255);
  });
});

describe('index.html — the iOS set the manifest cannot cover', () => {
  it('links the manifest relatively', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
  });

  it('declares the apple-touch-icon, standalone mode and the home-screen title', () => {
    expect(indexHtml).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png" />',
    );
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    );
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="Gravity Golf" />');
  });

  it('ships an apple-touch-icon that is really 180x180 and fully opaque', () => {
    const png = readPng(join(PUBLIC, 'icons', 'apple-touch-icon.png'));
    expect([png.width, png.height]).toEqual([180, 180]);
    // iOS composites a transparent icon onto black — the rounded corners would
    // come back as dark wedges outside the system mask.
    expect(minAlpha(png)).toBe(255);
  });

  it('registers no service worker', () => {
    // A stale SW cache would serve players an old build after every deploy. The
    // bundle is self-contained; there is nothing to gain and a lot to lose.
    expect(indexHtml).not.toMatch(/serviceWorker/i);
  });
});

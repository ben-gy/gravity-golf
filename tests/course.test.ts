/**
 * Course generation: determinism (P2P fairness — every peer plays the exact
 * same course) + validity invariants (no unwinnable / trapped holes, no player
 * starts with an easier board).
 */
import { describe, expect, it } from 'vitest';
import { generateCourse, generateHole, MARGIN, CUP_R } from '../src/game/course';
import { FIELD_W, FIELD_H, BALL_R } from '../src/game/physics';

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('course determinism (P2P fairness)', () => {
  it('same seed → identical course for two peers', () => {
    const a = generateCourse(987654, 9);
    const b = generateCourse(987654, 9);
    expect(a).toEqual(b);
  });

  it('same string seed → identical course', () => {
    expect(generateCourse('QK7P', 9)).toEqual(generateCourse('QK7P', 9));
  });

  it('different seeds → different courses', () => {
    expect(generateCourse(1, 9)).not.toEqual(generateCourse(2, 9));
  });

  it('everyone starts identically: hole 0 tee is the same across seeds re-run', () => {
    // Fairness = identical opening for all peers (they share the seed).
    for (const seed of [11, 22, 33]) {
      expect(generateHole(seed, 0).tee).toEqual(generateHole(seed, 0).tee);
    }
  });
});

describe('course validity invariants (no trapped / unfair holes)', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i * 7 + 3);

  it('holes are in-bounds, separated, and non-overlapping over many seeds', () => {
    for (const seed of seeds) {
      const holes = generateCourse(seed, 12);
      for (const h of holes) {
        // tee & cup inside the field.
        expect(h.tee.x).toBeGreaterThanOrEqual(0);
        expect(h.tee.x).toBeLessThanOrEqual(FIELD_W);
        expect(h.tee.y).toBeGreaterThanOrEqual(0);
        expect(h.tee.y).toBeLessThanOrEqual(FIELD_H);
        expect(h.cup.x).toBeGreaterThanOrEqual(MARGIN - 0.01);
        expect(h.cup.x).toBeLessThanOrEqual(FIELD_W - MARGIN + 0.01);
        // tee & cup comfortably apart so the hole isn't trivial.
        expect(dist(h.tee, h.cup)).toBeGreaterThan(40);
        // par sane.
        expect(h.par).toBeGreaterThanOrEqual(2);
        expect(h.par).toBeLessThanOrEqual(5);

        for (let i = 0; i < h.wells.length; i++) {
          const w = h.wells[i];
          // fully inside the field.
          expect(w.x - w.r).toBeGreaterThanOrEqual(0);
          expect(w.x + w.r).toBeLessThanOrEqual(FIELD_W);
          expect(w.y - w.r).toBeGreaterThanOrEqual(0);
          expect(w.y + w.r).toBeLessThanOrEqual(FIELD_H);
          // does not swallow the tee (launch clearance).
          expect(dist(w, h.tee)).toBeGreaterThan(w.r + BALL_R);
          // does not block the cup itself.
          expect(dist(w, h.cup)).toBeGreaterThan(w.r + CUP_R);
          // no two wells overlap.
          for (let j = i + 1; j < h.wells.length; j++) {
            const w2 = h.wells[j];
            expect(dist(w, w2)).toBeGreaterThan(w.r + w2.r);
          }
        }
      }
    }
  });

  it('early holes are gentler than late holes (well count trends up)', () => {
    let earlyTotal = 0;
    let lateTotal = 0;
    for (const seed of seeds) {
      const holes = generateCourse(seed, 12);
      earlyTotal += holes[0].wells.length + holes[1].wells.length;
      lateTotal += holes[10].wells.length + holes[11].wells.length;
    }
    expect(lateTotal).toBeGreaterThan(earlyTotal);
  });
});

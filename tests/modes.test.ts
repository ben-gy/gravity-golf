/**
 * modes.test.ts — the host's mode is what the room plays.
 *
 * A mode changes how many holes there are AND where on the difficulty ramp they
 * start, so two peers resolving it differently are not merely playing at
 * different lengths — they are on different courses, racing the same clock. The
 * mode therefore travels frozen inside the round start, and an id off the wire
 * is never trusted.
 *
 * The failure worth pinning is not a crash. generateCourse clamps its hole count
 * with `Math.max(MIN_HOLES, Math.min(MAX_HOLES, holeCount))`, and both of those
 * pass NaN straight through — so an unresolved mode does not throw, it builds a
 * course of zero holes and hands GolfGame an empty array.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_LIST, MODES, modeOf, timeLimitMs } from '../src/modes';
import { generateCourse, MIN_HOLES, MAX_HOLES } from '../src/game/course';

describe('modeOf', () => {
  it('resolves a known id', () => {
    expect(modeOf('sprint').holes).toBe(3);
    expect(modeOf('gauntlet').tier).toBe(6);
  });

  it('falls back rather than handing generateCourse an undefined hole count', () => {
    // A start from an older peer, a corrupted store, or a hand-edited message.
    for (const bad of [undefined, null, '', 'nope', 42, {}, ['sprint']]) {
      const m = modeOf(bad as unknown);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(m.holes)).toBe(true);
      expect(Number.isInteger(m.tier)).toBe(true);
      expect(Number.isFinite(timeLimitMs(m))).toBe(true);
    }
  });

  it('resolves a hostile id off the wire without inheriting from Object', () => {
    // MODES is an object literal, so 'constructor' / 'toString' are truthy on it.
    // Returning one of those as a Mode would put `undefined` in every field —
    // the exact empty course the fallback above exists to prevent, reached
    // through the one input it exists to distrust.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const m = modeOf(bad);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(m.holes)).toBe(true);
      expect(generateCourse(1, m.holes, m.tier).length).toBeGreaterThan(0);
    }
  });
});

describe('the modes ask for courses the generator can actually build', () => {
  it('stays inside the clamp, so no mode is silently shortened', () => {
    for (const m of MODE_LIST) {
      expect(m.holes, `${m.id} holes`).toBeGreaterThanOrEqual(MIN_HOLES);
      expect(m.holes, `${m.id} holes`).toBeLessThanOrEqual(MAX_HOLES);
      expect(generateCourse(3, m.holes, m.tier)).toHaveLength(m.holes);
    }
  });

  it('offers a real spread — no two modes are the same round', () => {
    const shapes = new Set(MODE_LIST.map((m) => `${m.holes}/${m.tier}`));
    expect(shapes.size).toBe(MODE_LIST.length);
  });

  it('gives the harder field more clock, not just more holes', () => {
    // Gauntlet is Classic's length six rungs up the ramp: same holes, more time,
    // because a field with black holes in it costs strokes and strokes cost time.
    expect(MODES.gauntlet.holes).toBe(MODES.classic.holes);
    expect(timeLimitMs(MODES.gauntlet)).toBeGreaterThan(timeLimitMs(MODES.classic));
  });
});

/**
 * mobile.test.ts — the zoom guard.
 *
 * A real player double-tapped mid-course and zoomed into a live game with no way
 * back out. The viewport meta says user-scalable=no; iOS Safari has ignored that
 * since iOS 10, so the meta tag proves nothing and only these listeners do.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { hardenViewport, type Unharden } from '../src/engine/mobile';

let unharden: Unharden | null = null;

afterEach(() => {
  unharden?.();
  unharden = null;
  document.documentElement.style.removeProperty('--vh');
});

/** Dispatch a cancelable event and report whether something refused it. */
function fire(type: string, init: Record<string, unknown> = {}): boolean {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, init);
  document.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('hardenViewport — pinch', () => {
  it('refuses iOS gesture events, the only way to decline a pinch in Safari', () => {
    expect(fire('gesturestart')).toBe(false); // nothing installed yet
    unharden = hardenViewport();
    expect(fire('gesturestart')).toBe(true);
    expect(fire('gesturechange')).toBe(true);
    expect(fire('gestureend')).toBe(true);
  });

  it('refuses a multi-touch touchmove — Android pinches through touch, not gestures', () => {
    unharden = hardenViewport();
    expect(fire('touchmove', { touches: { length: 2 } })).toBe(true);
    // …but a one-finger drag is the game's aiming gesture and must survive.
    expect(fire('touchmove', { touches: { length: 1 } })).toBe(false);
  });
});

describe('hardenViewport — double-tap', () => {
  it('refuses the second tap inside the double-tap window', () => {
    vi.useFakeTimers();
    try {
      unharden = hardenViewport();
      expect(fire('touchend')).toBe(false); // first tap: always allowed
      vi.advanceTimersByTime(100);
      expect(fire('touchend')).toBe(true); // second, 100ms later: zoom refused

      vi.advanceTimersByTime(1000);
      expect(fire('touchend')).toBe(false); // a slow tap is just a tap
      expect(fire('dblclick')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hardenViewport — the --vh unit', () => {
  it('publishes the real viewport height, since 100vh ignores the URL bar', () => {
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe(
      `${window.innerHeight * 0.01}px`,
    );
  });

  it('never writes a 0px --vh from a backgrounded tab', () => {
    const real = window.innerHeight;
    try {
      unharden = hardenViewport();
      const before = document.documentElement.style.getPropertyValue('--vh');

      // A backgrounded or pre-rendered tab reports 0. Writing it through would
      // collapse every calc(var(--vh) * 100) layout to a blank page.
      Object.defineProperty(window, 'innerHeight', { value: 0, configurable: true });
      window.dispatchEvent(new Event('resize'));

      expect(document.documentElement.style.getPropertyValue('--vh')).toBe(before);
      expect(document.documentElement.style.getPropertyValue('--vh')).not.toBe('0px');
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: real, configurable: true });
    }
  });
});

describe('hardenViewport — teardown', () => {
  it('removes every listener it installed', () => {
    hardenViewport()();
    expect(fire('gesturestart')).toBe(false);
    expect(fire('dblclick')).toBe(false);
  });
});

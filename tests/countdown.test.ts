/**
 * countdown.test.ts — the beat between the host's start and the first stroke.
 *
 * What matters here is not the animation. It is that the countdown ALWAYS ends —
 * exactly once, and never after the screen it belongs to is gone. main.ts holds
 * the field with `paused = true` for the whole count and only releases it in
 * onDone, so a countdown that never fires onDone is not a cosmetic bug: it is a
 * race that can never be played. And one that fires onDone after teardown starts
 * the round underneath whatever screen the player has since walked to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountdown } from '../src/countdown';
import type { Sfx, SfxName } from '../src/engine/sound';

function fakeSfx(): Sfx & { played: SfxName[] } {
  return {
    played: [] as SfxName[],
    unlock() {},
    play(name: SfxName) {
      this.played.push(name);
    },
    muted: () => false,
    setMuted() {},
  };
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('createCountdown', () => {
  it('counts 3-2-1-GO and then starts the round, once', () => {
    const sfx = fakeSfx();
    const onDone = vi.fn();
    createCountdown({ root, sfx, onDone });

    // Paints immediately: a blank beat before the first digit reads as a hang.
    expect(root.querySelector('.cd-num')!.textContent).toBe('3');
    expect(onDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('2');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('1');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('GO');
    // GO is held briefly — the round must not start on the same frame it appears.
    expect(onDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);

    // And it lets go of the DOM rather than leaving GO burned over the course.
    expect(root.querySelector('.countdown')).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('makes a sound on every tick, because nobody is looking at the overlay', () => {
    const sfx = fakeSfx();
    createCountdown({ root, sfx, onDone: vi.fn() });
    vi.advanceTimersByTime(3000);
    // Three pips…
    expect(sfx.played).toEqual(['blip', 'blip', 'blip', 'win']);
    // …and the GO is a different sound, so the ear can tell them apart without
    // reading the screen. Players watch the ball, not the digits.
    expect(sfx.played[3]).not.toBe(sfx.played[2]);
  });

  it('cancel() stops the round from ever starting', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(1500);
    cd.cancel();

    // The teardown case: a peer left, or the race was torn down mid-count. If
    // onDone still fired it would un-pause and start a race on a dead screen.
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
    expect(root.querySelector('.countdown')).toBeNull();
  });

  it('cancel() during the GO hold still stops the round from starting', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    // The narrow window the other cancel test misses. Every other pending timer
    // lands back in step(), which is guarded by the `done` flag — but the GO
    // timer calls onDone() DIRECTLY, so this path is only safe because cancel()
    // clears it. Take the clearTimeout out and a race torn down between GO and
    // the first stroke starts anyway, on a screen that has already gone.
    vi.advanceTimersByTime(3000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('GO');
    cd.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('cancel() after it has finished is harmless', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(3450);
    expect(onDone).toHaveBeenCalledTimes(1);
    cd.cancel();
    cd.cancel();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is announced to screen readers as it changes', () => {
    createCountdown({ root, sfx: fakeSfx(), onDone: vi.fn() });
    const el = root.querySelector('.countdown')!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  it('honours reduced motion without dropping the count itself', () => {
    createCountdown({ root, sfx: fakeSfx(), onDone: vi.fn(), reducedMotion: true });
    // The digits are the information; only the animation is decoration.
    expect(root.querySelector('.countdown')!.classList.contains('reduced')).toBe(true);
    expect(root.querySelector('.cd-num')!.textContent).toBe('3');
  });

  it('counts from a custom start', () => {
    const onDone = vi.fn();
    createCountdown({ root, sfx: fakeSfx(), onDone, from: 1 });
    expect(root.querySelector('.cd-num')!.textContent).toBe('1');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('GO');
    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

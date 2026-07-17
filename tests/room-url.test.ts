/**
 * room-url.test.ts — the room code's life in the URL.
 *
 * The shipped bug: setRoomInUrl wrote ?room= and NOTHING ever cleared it. Leave
 * to the menu, then reload — or reopen from the home-screen icon, which is the
 * same URL — and the stale parameter silently drags you back into a room you had
 * left. "It always spawns the same game room no matter what." leaveRoom() calls
 * clearRoomInUrl(); these hold that.
 *
 * The ?seed= course link is the other half: Gravity Golf's async "Share this
 * course" flow lives in it, and a room must never quietly eat it or resurrect it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearRoomInUrl, normalizeRoomCode, roomCodeFromUrl, setRoomInUrl } from '../src/engine/lobby';

const at = (url: string): void => history.replaceState(null, '', url);
const search = (): string => new URL(location.href).search;

beforeEach(() => at('/'));

describe('normalizeRoomCode', () => {
  it('upper-cases so a typed code matches the host link', () => {
    expect(normalizeRoomCode('k7qp')).toBe('K7QP');
  });

  it('strips spaces, dashes and punctuation, and caps at 8', () => {
    expect(normalizeRoomCode(' k7-qp ')).toBe('K7QP');
    expect(normalizeRoomCode('abcdefghij')).toBe('ABCDEFGH');
  });
});

describe('roomCodeFromUrl', () => {
  it('reads and canonicalizes a hand-edited ?room=', () => {
    at('/?room=k7-qp');
    expect(roomCodeFromUrl()).toBe('K7QP');
  });

  it('is null with no room', () => {
    at('/?seed=123');
    expect(roomCodeFromUrl()).toBeNull();
  });
});

describe('setRoomInUrl', () => {
  it('puts the code in the URL so the invite link and a refresh both carry it', () => {
    setRoomInUrl('K7QP');
    expect(roomCodeFromUrl()).toBe('K7QP');
  });

  it('drops a stale ?seed= — a course link and a room are different ways to play', () => {
    at('/?seed=999&holes=9');
    setRoomInUrl('K7QP');
    expect(search()).not.toContain('seed=');
  });
});

describe('clearRoomInUrl — the stale-room bug', () => {
  it('removes ?room= so a reload lands on the menu, not back in the room', () => {
    setRoomInUrl('K7QP');
    clearRoomInUrl();
    // This is the whole fix: after leaving, boot() must find nothing to rejoin.
    expect(roomCodeFromUrl()).toBeNull();
    expect(search()).not.toContain('room=');
  });

  it('leaves a ?seed= course link alone — it is still replayable', () => {
    at('/?seed=4242&holes=9&room=K7QP');
    clearRoomInUrl();
    const url = new URL(location.href);
    expect(url.searchParams.get('seed')).toBe('4242');
    expect(url.searchParams.get('holes')).toBe('9');
    expect(url.searchParams.get('room')).toBeNull();
  });

  it('is a no-op when there is no room, rather than rewriting history', () => {
    at('/?seed=1');
    clearRoomInUrl();
    expect(search()).toBe('?seed=1');
  });
});

/**
 * Multiplayer contract tests:
 *  - gate #1: normalizeRoomCode — a hand-typed code canonicalises to the exact
 *    string the invite link carries.
 *  - gate #2: host-transfer takeover — a promoted client can drive the round to
 *    over === true; while a client it does NOT self-decide the round.
 *  - gate #3: a departing peer never freezes the round (peer-leave grace).
 *  - snapshot / progress serialization round-trips.
 */
import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from '../src/engine/lobby';
import {
  RaceSession,
  compareStandings,
  encodeProgress,
  decodeProgress,
  type PeerProgress,
  type RaceStanding,
} from '../src/game/race';

const done = (strokes = 10, hole = 2): PeerProgress => ({
  hole,
  strokes,
  holeStrokes: 0,
  done: true,
  finishedAt: 1,
});
const playing = (hole = 1, strokes = 5): PeerProgress => ({
  hole,
  strokes,
  holeStrokes: 0,
  done: false,
  finishedAt: null,
});
const standing = (id: string, p: PeerProgress): RaceStanding => ({
  id,
  name: id,
  connected: true,
  ...p,
});

describe('gate #1 — normalizeRoomCode', () => {
  it('canonicalises a hand-typed code to the invite-link code', () => {
    const linkCode = 'AB12';
    expect(normalizeRoomCode('ab12')).toBe(linkCode);
    expect(normalizeRoomCode(' ab-12 ')).toBe(linkCode);
    expect(normalizeRoomCode('a b 1 2')).toBe(linkCode);
  });
  it('strips punctuation and caps length', () => {
    expect(normalizeRoomCode('qk7p!!')).toBe('QK7P');
    expect(normalizeRoomCode('abcdefghijk')).toBe('ABCDEFGH');
  });
});

describe('gate #2 — host-transfer takeover', () => {
  it('a client does NOT self-decide the round; a promoted host can end it', () => {
    const s = new RaceSession({ selfId: 'bbb', isHost: false, totalHoles: 2, timeLimitMs: 10000 });
    s.setRoster(['aaa', 'bbb']);
    s.applyProgress('aaa', done());
    s.setSelfProgress(done());

    // While a client, ticking is a no-op — only the host owns the clock/over.
    s.tick(20000);
    expect(s.over).toBe(false);
    expect(s.remainingMs).toBe(10000);

    // Host leaves → this peer is promoted. It already holds everyone's progress,
    // so it can immediately conclude the finished round.
    s.setHost(true);
    expect(s.isHost()).toBe(true);
    expect(s.over).toBe(true);
  });

  it('a promoted host ends the round when the timer expires, even mid-play', () => {
    const s = new RaceSession({ selfId: 'bbb', isHost: false, totalHoles: 2, timeLimitMs: 5000 });
    s.setRoster(['aaa', 'bbb']);
    // Client adopts the host's clock via snapshots.
    s.applySnapshot({
      standings: [standing('aaa', playing()), standing('bbb', playing())],
      remainingMs: 1500,
      over: false,
      totalHoles: 2,
    });
    expect(s.remainingMs).toBe(1500);

    s.setHost(true); // promote; nobody has finished yet
    expect(s.over).toBe(false);
    s.tick(1000);
    expect(s.over).toBe(false);
    s.tick(1000); // clock hits zero → round ends and can never hang
    expect(s.remainingMs).toBe(0);
    expect(s.over).toBe(true);
  });
});

describe('gate #3 — peer-leave grace', () => {
  it('a departing unfinished peer no longer blocks the round from ending', () => {
    const s = new RaceSession({ selfId: 'aaa', isHost: true, totalHoles: 2, timeLimitMs: 60000 });
    s.setRoster(['aaa', 'bbb', 'ccc']);
    s.setSelfProgress(done());
    s.applyProgress('bbb', done());
    s.applyProgress('ccc', playing()); // ccc still going

    s.tick(500);
    expect(s.over).toBe(false); // ccc not done yet

    s.onPeerLeave('ccc'); // ccc quits
    s.tick(500);
    expect(s.over).toBe(true); // remaining connected peers are all done
  });
});

describe('standings ordering & snapshot', () => {
  it('ranks done-first, then fewer strokes, then further progress', () => {
    expect(compareStandings(done(8), playing(1))).toBeLessThan(0);
    expect(compareStandings(done(8), done(12))).toBeLessThan(0);
    expect(compareStandings(playing(3, 20), playing(1, 5))).toBeLessThan(0); // further hole wins
  });

  it('snapshot sorts standings and carries clock + over', () => {
    const s = new RaceSession({ selfId: 'aaa', isHost: true, totalHoles: 3, timeLimitMs: 9000 });
    s.setRoster(['aaa', 'bbb']);
    s.setSelfProgress(playing(1, 8));
    s.applyProgress('bbb', done(6));
    const snap = s.snapshot();
    expect(snap.standings[0].id).toBe('bbb'); // finished peer ranks first
    expect(snap.remainingMs).toBe(9000);
    expect(snap.totalHoles).toBe(3);
  });
});

describe('progress serialization', () => {
  it('round-trips through the compact wire form', () => {
    const p = done(7, 3);
    expect(decodeProgress(encodeProgress(p))).toEqual(p);
    const q = playing(2, 4);
    expect(decodeProgress(encodeProgress(q))).toEqual(q);
  });
});

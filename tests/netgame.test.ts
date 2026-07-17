/**
 * netgame.test.ts — the per-race subsystem must let go of the room when the
 * race ends.
 *
 * The Net now outlives every race (rematches run inside the same mesh, see
 * engine/rematch.ts) and net.channel() fans out to every registered receiver
 * rather than memoizing one per name. Together those make a leak that did not
 * exist before: a finished NetGame that stays subscribed keeps folding the NEXT
 * race's 'prog' into its dead RaceSession, and — if it was the host — keeps
 * ticking and broadcasting snapshots of a finished race over the live one.
 * NetGame.destroy() has to detach. These tests hold it to that.
 */

import { describe, expect, it, vi } from 'vitest';
import { NetGame } from '../src/net-game';
import type { Net, PeerId } from '../src/engine/net';
import { emptyProgress, type ProgWire, type RaceSnapshot } from '../src/game/race';

/** A Net stand-in with real fan-out + off(), mirroring engine/net.ts. */
function mockNet(selfId: PeerId, peers: PeerId[], isHost: boolean) {
  const chans = new Map<string, Set<(d: unknown, from: PeerId) => void>>();
  const sent: { name: string; data: unknown }[] = [];
  const roster = [selfId, ...peers].sort();

  const net: Net = {
    selfId,
    peers: () => roster,
    host: () => (isHost ? selfId : roster[0]),
    isHost: () => isHost,
    // A race only ever starts from a settled room (see host-election.test.ts), so
    // the NetGame never sees an unsettled Net.
    hostSettled: () => true,
    count: () => roster.length,
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      if (!chans.has(name)) chans.set(name, new Set());
      const h = onReceive as (d: unknown, from: PeerId) => void;
      chans.get(name)!.add(h);
      const send = ((data: T) => {
        sent.push({ name, data });
      }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
      send.off = () => {
        chans.get(name)!.delete(h);
      };
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  };

  const deliver = (name: string, data: unknown, from: PeerId): void => {
    for (const h of [...(chans.get(name) ?? [])]) h(data, from);
  };
  const receivers = (name: string): number => chans.get(name)?.size ?? 0;
  return { net, deliver, receivers, sent };
}

const cfg = { totalHoles: 2, timeLimitMs: 60_000, names: { aaa: 'A', bbb: 'B' } };
const noop = { onSnapshot: () => {}, onHostPromoted: () => {} };

const wire = (h: number, s: number): ProgWire => ({ h, s, hs: 0, d: 0, hl: [] });

describe('NetGame teardown', () => {
  it('detaches its receivers so a retired race stops listening', () => {
    const { net, receivers } = mockNet('aaa', ['bbb'], true);
    const g = new NetGame(net, cfg, noop);
    expect(receivers('prog')).toBe(1);
    expect(receivers('snap')).toBe(1);

    g.destroy();
    expect(receivers('prog')).toBe(0);
    expect(receivers('snap')).toBe(0);
  });

  it('a destroyed race does not absorb the NEXT race\'s progress', () => {
    const { net, deliver } = mockNet('aaa', ['bbb'], true);
    const first = new NetGame(net, cfg, noop);
    first.destroy();

    const second = new NetGame(net, cfg, noop);
    deliver('prog', wire(1, 7), 'bbb');

    const stale = first.session.snapshot().standings.find((s) => s.id === 'bbb');
    const live = second.session.snapshot().standings.find((s) => s.id === 'bbb');
    // The dead round must be frozen at zero while the live one sees the shot.
    expect(stale?.strokes).toBe(0);
    expect(live?.strokes).toBe(7);
  });

  it('the old host stops broadcasting snapshots of a finished race', () => {
    vi.useFakeTimers();
    try {
      const { net, sent } = mockNet('aaa', ['bbb'], true);
      const g = new NetGame(net, cfg, noop);
      g.start();

      vi.advanceTimersByTime(700);
      expect(sent.filter((m) => m.name === 'snap').length).toBeGreaterThan(0);

      g.destroy();
      const after = sent.filter((m) => m.name === 'snap').length;
      vi.advanceTimersByTime(3000);
      // A keepalive that outlives its race would stomp the live one's clock.
      expect(sent.filter((m) => m.name === 'snap').length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a client\'s destroyed race ignores a late snapshot', () => {
    const { net, deliver } = mockNet('bbb', ['aaa'], false);
    const g = new NetGame(net, cfg, noop);
    g.destroy();

    const snap: RaceSnapshot = {
      standings: [{ id: 'aaa', name: 'A', connected: true, ...emptyProgress(), strokes: 99 }],
      remainingMs: 1,
      over: true,
      totalHoles: 2,
    };
    deliver('snap', snap, 'aaa');

    expect(g.session.over).toBe(false);
  });
});

describe('NetGame authority follows the net, and only the net', () => {
  it('seeds the race host from net.isHost() rather than re-deriving it', () => {
    // 'zzz' sorts LAST but holds the room by incumbency (see host-election.test.ts).
    // A NetGame that re-ran a min-id election here would hand authority to 'aaa'
    // and the room would have two hosts ticking two clocks.
    const { net } = mockNet('zzz', ['aaa'], true);
    const g = new NetGame(net, cfg, noop);
    expect(g.session.isHost()).toBe(true);
  });

  it('never lets a mid-race joiner take authority', () => {
    vi.useFakeTimers();
    try {
      // We are a client. Someone joins mid-race; the roster grows, but net never
      // says the host changed — so nothing here may promote us.
      const { net, sent } = mockNet('aaa', ['zzz'], false);
      const g = new NetGame(net, cfg, noop);
      g.start();
      g.onRoster(['aaa', 'zzz', 'mmm']);

      vi.advanceTimersByTime(1000);
      expect(g.session.isHost()).toBe(false);
      // The tell-tale of a second host: snapshots on the wire from a client.
      expect(sent.filter((m) => m.name === 'snap')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('promotes the survivor when net hands the room over mid-race', () => {
    vi.useFakeTimers();
    try {
      const { net, sent } = mockNet('aaa', ['zzz'], false);
      let promoted = 0;
      const g = new NetGame(net, cfg, { onSnapshot: () => {}, onHostPromoted: () => promoted++ });
      g.start();
      expect(sent.filter((m) => m.name === 'snap')).toHaveLength(0);

      // The host left; net re-elected us. The race must carry on from the
      // standings and clock we already hold, not stall with nobody ticking.
      g.onHostChange(true);
      vi.advanceTimersByTime(1000);

      expect(promoted).toBe(1);
      expect(g.session.isHost()).toBe(true);
      expect(sent.filter((m) => m.name === 'snap').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down when net says it is no longer host', () => {
    vi.useFakeTimers();
    try {
      const { net, sent } = mockNet('aaa', ['zzz'], true);
      const g = new NetGame(net, cfg, noop);
      g.start();
      vi.advanceTimersByTime(700);
      const before = sent.filter((m) => m.name === 'snap').length;
      expect(before).toBeGreaterThan(0);

      // Two peers converged onto one host (net.ts's __h exchange). The loser must
      // go quiet, or both keep broadcasting conflicting clocks forever.
      g.onHostChange(false);
      vi.advanceTimersByTime(3000);
      expect(sent.filter((m) => m.name === 'snap').length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

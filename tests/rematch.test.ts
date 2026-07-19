/**
 * rematch.test.ts — the multi-race protocol, driven with N simulated peers.
 * A "round" here is one live race over a shared course seed.
 *
 * What this covers and what it deliberately does not:
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, host election, host handover mid-results. This is our logic
 *    and a fake bus exercises it honestly.
 *
 *  - NOT COVERED: the transport bug that started all this. A fake bus sits ABOVE
 *    Trystero's room cache, so it structurally cannot contain that defect and
 *    would happily go green while the real game was broken. Two other tests own
 *    that: trystero-rejoin.test.ts pins the Trystero behaviour itself, and the
 *    "one join per session" case below asserts the invariant that makes the trap
 *    unreachable — no network model required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

/** A shared in-memory bus. Delivery is synchronous — we are testing protocol
 *  decisions, not timing. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** Roster subscribers, backing net.onPeersChange(). */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();

  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.announceRoster();
  }

  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.announceRoster();
  }

  /** Everyone still here learns the new roster, exactly as net.ts fans it out. */
  announceRoster(): void {
    const roster = this.roster();
    for (const [id, cbs] of this.watchers) {
      if (!this.peers.has(id)) continue;
      for (const cb of [...cbs]) cb(roster);
    }
  }

  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    if (!this.watchers.has(id)) this.watchers.set(id, new Set());
    this.watchers.get(id)!.add(cb);
    return () => this.watchers.get(id)?.delete(cb);
  }

  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }

  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }

  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    // Same election rule as the real net.ts: lexicographically smallest id.
    host: () => bus.roster()[0],
    isHost: () => bus.roster()[0] === selfId,
    // Host election is host-election.test.ts's job; here the room is always up.
    hostSettled: () => true,
    // One uncontested term for the whole test — epoch churn is host-election's job.
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    // Real fan-out, because rematch.ts leans on it for two things this file
    // exercises: resetting the roster-settle window, and re-sending the current
    // start to a peer that connected after the round began.
    onPeersChange: (cb) => bus.watch(selfId, cb),
    takeover: () => {},
    netDiag: () => ({
      selfId,
      host: bus.roster()[0],
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

function table(
  ids: PeerId[],
  opts: { minPlayers?: number; roundOpts?: (id: PeerId) => unknown } = {},
): Seat[] {
  const bus = new Bus();
  return ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      // Per-peer so a test can give every peer a DIFFERENT local pick — the only
      // way to tell "the host's setting" apart from "my own setting".
      ...(opts.roundOpts ? { roundOpts: () => opts.roundOpts!(id) } : {}),
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

let seats: Seat[];
beforeEach(() => {
  seats = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Let the roster go quiet, then let the poll notice.
 *
 * Auto-start is no longer synchronous with the last vote, and that is the point.
 * A host that freezes its roster the instant quorum is reached freezes it from a
 * mesh that is still forming — the peers whose data channels open a second later
 * are simply absent from the round, which is what "I got ejected when the round
 * started" was. So rematch.ts refuses to start until the roster has held still
 * for ROSTER_SETTLE_MS (4s) and retries on a 1.5s poll. 6s covers the window
 * plus the next poll tick.
 */
const settle = (): void => {
  vi.advanceTimersByTime(6000);
};

describe('createRounds — starting a round', () => {
  it('starts once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Auto-start fires once the roster has held still; nobody had to press Start.
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so player indices match on every peer', () => {
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());
    settle();

    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    // Every peer must agree on the field and its order — the roster comes
    // from the host's bytes, not from each peer re-deriving it locally.
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // a quiet roster is not enough — the votes are what is missing
    expect(seats.every((s) => s.got.length === 0)).toBe(true);

    seats[2].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('lets the host start early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].got.length).toBe(0); // c has not voted — only a grace countdown

    seats[0].rounds.go(); // host forces it, without waiting the countdown out
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    // 'b' is not the host; forge a start and make sure nobody honours it.
    seats[1].net.channel('rs', () => {})(
      { round: 1, seed: 42, roster: [{ id: 'b', name: 'B' }] } as never,
    );
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Both players hit "Play again" — the exact sequence the user reported.
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    // The symptom was TWO hosts. There must be exactly one, every round.
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    // …and a fresh course, not a replay of round 1.
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it('keeps both peers in each other\'s roster across the rematch', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // "Neither can see each other" — assert the opposite, directly.
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    const seed = seats[0].got[0].seed;

    // Replay round 1's start — e.g. a duplicate delivery, or both peers pressing
    // at the same instant. The monotonic guard must swallow it.
    seats[0].net.channel('rs', () => {})(
      { round: 1, seed: 999, roster: [{ id: 'a', name: 'A' }] } as never,
    );
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote()); // round 1 playing; no finish()
    settle();
    seats.forEach((s) => s.rounds.vote()); // premature "play again"
    settle();
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].got.length).toBe(1); // still waiting on c

    seats[2].net.leave(); // c closes the tab
    seats[0].rounds.vote(); // any nudge re-tallies
    // c leaving IS a roster change, so the window reopens — the host must not
    // freeze a roster the instant somebody drops out either.
    settle();

    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    expect(seats[0].net.isHost()).toBe(true);

    seats[0].net.leave(); // the host walks away between rounds
    expect(seats[1].net.isHost()).toBe(true); // b is promoted by min-id election

    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle();

    // The promoted host must be able to run the rematch — inheriting no tally
    // from the old host is the classic way this deadlocks.
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    // Settle so a round genuinely DOES start on the host — otherwise this case
    // would pass simply because nothing happened at all.
    settle();
    expect(seats[0].got.length).toBe(1);

    // A destroyed Rounds must not keep driving a screen that is gone.
    expect(seats[1].got.length).toBe(0);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Two of three hit "Play again". The third is still reading the scorecard.
    // The OLD rule required unanimity, so this hung forever with no way out but
    // the menu — the exact reported failure.
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // the countdown only arms once the roster is quiet
    expect(seats[0].got.length).toBe(1); // not yet — the countdown is running

    const s = seats[0].rounds.state();
    expect(s.startsInMs).toBeGreaterThan(0); // and it is VISIBLE, not a silent hang

    vi.advanceTimersByTime(8100);

    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('starts without the straggler even if the countdown were never surfaced', () => {
    // Deliberately asserts NOTHING about startsInMs. The sibling case above
    // checks the countdown is visible, and that assertion sits earlier — so if
    // the grace logic is removed it fails there and never reaches the part that
    // matters most: the round actually starting without the silent player. This
    // case pins that half on its own.
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    vi.advanceTimersByTime(8100);

    expect(seats[0].got.length).toBe(2);
    expect(seats[2].got.length).toBe(2); // the straggler is pulled in, not stranded
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Unanimity must not be punished with an 8s grace wait on top of the settle.
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // No settle: go() is a deliberate host action, so it is allowed to skip both
    // the settle window and the countdown.
    seats[0].rounds.go();

    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].rounds.state().startsInMs).toBeGreaterThan(0);

    seats[1].rounds.unvote(); // changed their mind
    expect(seats[0].rounds.state().startsInMs).toBeNull();

    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1); // no round started below quorum
  });

  it('a peer who returns to the lobby mid-countdown still lands in the race', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[2].rounds.vote(); // the straggler taps just in time
    settle();

    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

/**
 * The bug these exist to prevent has shipped once already: a guest rendering its
 * OWN local pick under the label "Host picked X". Every peer here is given a
 * DIFFERENT local pick, because a test where both peers want the same mode
 * passes just as happily with the host's choice ignored entirely.
 */
describe('createRounds — the host\'s settings, never your own', () => {
  const picks = (id: PeerId): unknown => ({ mode: id === 'a' ? 'gauntlet' : 'sprint' });

  it('gives a guest the HOST\'s gossiped pick, not the guest\'s own', () => {
    seats = table(['a', 'b'], { roundOpts: picks });
    const [host, guest] = seats;

    expect(host.net.isHost()).toBe(true);
    expect(host.rounds.state().hostOpts).toEqual({ mode: 'gauntlet' });
    // The guest locally wants 'sprint'. It must still report the host's pick.
    expect(guest.rounds.state().hostOpts).toEqual({ mode: 'gauntlet' });
  });

  it('reports null rather than a guess when the host has gossiped nothing', () => {
    // Only the GUEST has a pick to offer; the host announces no opts at all.
    // "Waiting for the host's pick…" is the honest render here — reporting the
    // guest's own setting would be a confident lie about a room it has not heard
    // from.
    const bus = new Bus();
    const hostNet = mockNet(bus, 'a');
    const guestNet = mockNet(bus, 'b');
    createRounds({ net: hostNet, playerName: 'A', onRound: () => {} });
    const guest = createRounds({
      net: guestNet,
      playerName: 'B',
      roundOpts: () => ({ mode: 'sprint' }),
      onRound: () => {},
    });

    expect(guestNet.isHost()).toBe(false);
    expect(guest.state().hostOpts).toBeNull();
  });

  it('follows the host when the host changes its pick', () => {
    const bus = new Bus();
    const hostNet = mockNet(bus, 'a');
    const guestNet = mockNet(bus, 'b');
    let hostPick = 'classic';
    const host = createRounds({
      net: hostNet,
      playerName: 'A',
      roundOpts: () => ({ mode: hostPick }),
      onRound: () => {},
    });
    const guest = createRounds({
      net: guestNet,
      playerName: 'B',
      roundOpts: () => ({ mode: 'sprint' }),
      onRound: () => {},
    });
    expect(guest.state().hostOpts).toEqual({ mode: 'classic' });

    hostPick = 'gauntlet';
    host.vote(); // any gossip re-announces the current pick

    expect(guest.state().hostOpts).toEqual({ mode: 'gauntlet' });
  });

  it('freezes the HOST\'s pick into the start every peer plays', () => {
    seats = table(['a', 'b'], { roundOpts: picks });
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Not "each peer got its own opts" — the same bytes on both.
    expect(seats[0].got[0].opts).toEqual({ mode: 'gauntlet' });
    expect(seats[1].got[0].opts).toEqual({ mode: 'gauntlet' });
  });
});

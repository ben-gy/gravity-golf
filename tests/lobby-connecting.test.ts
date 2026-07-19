/**
 * lobby-connecting.test.ts — what the lobby is allowed to claim before the room
 * has settled.
 *
 * net.ts no longer seeds every peer as host on join, so for the first moments in
 * a room nobody knows who hosts. The lobby has to say so. The old build painted a
 * HOST badge and a live Start button immediately, which on a mesh that never
 * formed was permanent: both players sat in the right room code, each looking
 * like the host, seeing nobody.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLobby } from '../src/engine/lobby';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import type { Rounds, RoundsState } from '@ben-gy/game-engine/rematch';

/** Filled by the most recently mounted fakeNet, so a test can assert on it. */
let tookOver = 0;

function fakeNet(selfId: PeerId, roster: PeerId[], settled: boolean): Net {
  return {
    selfId,
    peers: () => roster,
    host: () => (settled ? roster[0] : null),
    // Exactly net.ts's contract: false until the room settles, whatever the ids.
    isHost: () => settled && roster[0] === selfId,
    hostSettled: () => settled,
    // An unsettled room has no term yet; a settled one is in its first.
    hostEpoch: () => (settled ? 1 : 0),
    count: () => roster.length,
    onPeersChange: () => () => {},
    takeover: () => {
      tookOver++;
    },
    netDiag: () => ({
      selfId,
      host: settled ? roster[0] : null,
      epoch: settled ? 1 : 0,
      settled,
      peers: roster,
      relaySockets: {},
      turn: false,
    }),
    channel: () => Object.assign(() => {}, { off: () => {} }),
    ping: async () => 0,
    leave: async () => {},
  };
}

function fakeRounds(present: PeerId[]): Rounds {
  const state: RoundsState = {
    round: 0,
    phase: 'waiting',
    votes: [],
    present: present.map((id) => ({ id, name: id.toUpperCase() })),
    voted: false,
    isHost: false,
    canStart: false,
    // Nothing is playing yet, so nobody is seated in a current round.
    seated: false,
    // Null is the honest value here: nobody has heard the host's settings yet,
    // which is exactly the "room has not settled" state this file is about.
    hostOpts: null,
    startsInMs: null,
  };
  return {
    vote: () => {},
    unvote: () => {},
    go: () => {},
    finish: () => {},
    state: () => state,
    destroy: () => {},
  };
}

let lobby: { destroy: () => void } | null = null;

function mount(settled: boolean, selfId = 'aaa', roster = ['aaa', 'zzz']): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  lobby = createLobby({
    container,
    net: fakeNet(selfId, roster, settled),
    rounds: fakeRounds(roster),
    roomCode: 'K7QP',
    minPlayers: 2,
    maxPlayers: 6,
  });
  return container;
}

beforeEach(() => {
  tookOver = 0;
});

afterEach(() => {
  lobby?.destroy();
  lobby = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('createLobby — before the room settles', () => {
  it('says it is connecting instead of naming a host', () => {
    const el = mount(false);
    expect(el.textContent).toContain('Connecting to the room…');
    // 'aaa' sorts first: under the OLD min-id rule it would already be wearing
    // the badge on a mesh that has not formed.
    expect(el.querySelector('.lobby-badge')).toBeNull();
  });

  it('offers no Start button to anybody', () => {
    expect(mount(false, 'aaa').querySelector('.lobby-start')).toBeNull();
    expect(mount(false, 'zzz').querySelector('.lobby-start')).toBeNull();
  });

  it('does not tell a peer to wait for a host nobody has heard from', () => {
    expect(mount(false, 'zzz').querySelector('.lobby-wait')).toBeNull();
  });

  it('disables ready — a vote nobody can receive is a lie', () => {
    const btn = mount(false, 'zzz').querySelector<HTMLButtonElement>('.lobby-ready');
    expect(btn?.disabled).toBe(true);
  });
});

/**
 * net.ts will not self-elect on a roster of one, and it is right not to: that is
 * precisely the phantom host that later stole a live room. The cost is that
 * somebody who opens an invite link after the host has gone is alone, unsettled,
 * and — without this — spinning forever behind a disabled ready button. The
 * escape hatch has to exist, and it has to be the player's explicit choice.
 */
describe('createLobby — alone in a room with no host', () => {
  it('offers to hand the player the room after a long silent wait', () => {
    vi.useFakeTimers();
    const el = mount(false, 'aaa', ['aaa']);
    // Not immediately: an offer at second one would just be the old self-election
    // wearing a button, and the mesh usually forms inside the settle window.
    expect(el.querySelector('.lobby-host')).toBeNull();

    vi.advanceTimersByTime(16000); // past OFFER_HOST_MS, and the 600ms repaint
    expect(el.querySelector('.lobby-host')).not.toBeNull();
    expect(el.textContent).toContain("Nobody's here yet");
  });

  it('takes the room via net.takeover(), which mints a fresh term', () => {
    vi.useFakeTimers();
    const el = mount(false, 'aaa', ['aaa']);
    vi.advanceTimersByTime(16000);

    el.querySelector<HTMLButtonElement>('.lobby-host')!.click();
    // A new term is what makes this safe: a real incumbent that surfaces later
    // outranks us and we stand down, rather than fighting for the room.
    expect(tookOver).toBe(1);
    // And it is not offered twice — one deliberate choice, not a loop.
    vi.advanceTimersByTime(16000);
    expect(el.querySelector('.lobby-host')).toBeNull();
  });

  it('never offers it to a peer that can see somebody else', () => {
    vi.useFakeTimers();
    // Two in the roster and still unsettled means the mesh IS forming — keep
    // waiting for the incumbent rather than racing it, which is the whole fix.
    const el = mount(false, 'aaa', ['aaa', 'zzz']);
    vi.advanceTimersByTime(16000);
    expect(el.querySelector('.lobby-host')).toBeNull();
  });
});

describe('createLobby — once the room settles', () => {
  it('badges the incumbent and gives the host its Start button', () => {
    const el = mount(true, 'aaa');
    expect(el.textContent).not.toContain('Connecting to the room…');
    expect(el.querySelector('.lobby-badge')?.textContent).toBe('HOST');
    expect(el.querySelector('.lobby-start')).not.toBeNull();
  });

  it('gives a guest the ready toggle, enabled', () => {
    const el = mount(true, 'zzz');
    expect(el.querySelector('.lobby-start')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('.lobby-ready')?.disabled).toBe(false);
    expect(el.querySelector('.lobby-wait')).not.toBeNull();
  });
});

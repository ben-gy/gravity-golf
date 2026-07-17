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

import { afterEach, describe, expect, it } from 'vitest';
import { createLobby } from '../src/engine/lobby';
import type { Net, PeerId } from '../src/engine/net';
import type { Rounds, RoundsState } from '../src/engine/rematch';

function fakeNet(selfId: PeerId, roster: PeerId[], settled: boolean): Net {
  return {
    selfId,
    peers: () => roster,
    host: () => (settled ? roster[0] : null),
    // Exactly net.ts's contract: false until the room settles, whatever the ids.
    isHost: () => settled && roster[0] === selfId,
    hostSettled: () => settled,
    count: () => roster.length,
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

afterEach(() => {
  lobby?.destroy();
  lobby = null;
  document.body.innerHTML = '';
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

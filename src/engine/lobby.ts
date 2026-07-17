/**
 * lobby.ts — drop-in peer-to-peer lobby built on net.ts + rematch.ts (copied
 * from patterns/ and extended with a room-entry screen).
 *
 * Flow: createRoomEntry (create a room OR type a code) → createLobby (roster,
 * ready states, host Start, animated connecting spinner).
 *
 * This file is a VIEW. It owns no protocol: presence, readiness, quorum, the
 * shared course seed and the frozen roster all come from rematch.ts, so the
 * first race and every rematch travel the identical code path. The lobby used to
 * run its own 'pres'/'preq'/'go' channels, which meant two ways to start a race
 * and a 'go' that carried a seed but no roster — leaving peers free to disagree
 * about who was in the field.
 */

import type { Net, PeerId } from './net';
import type { Rounds } from './rematch';

export interface LobbyPlayer {
  id: PeerId;
  name: string;
  ready: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyConfig {
  container: HTMLElement;
  net: Net;
  /** The round protocol driving this room. Owns start; the lobby just renders. */
  rounds: Rounds;
  roomCode: string;
  minPlayers?: number;
  maxPlayers?: number;
}

/**
 * Canonicalise a room code so a hand-typed code (lower-case, stray spaces or
 * dashes) resolves to the EXACT string the invite link carries. Without this,
 * two players silently join different Trystero rooms.
 */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** Read ?room= from the URL (normalized), or null if none. */
export function roomCodeFromUrl(): string | null {
  const existing = new URL(location.href).searchParams.get('room');
  return existing ? normalizeRoomCode(existing) : null;
}

/** Mint a fresh 4-char code (unambiguous alphabet). Not for security. */
export function mintCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/O/0/1/L ambiguity
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function inviteLink(roomCode: string): string {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  return url.toString();
}

export interface RoomEntryConfig {
  container: HTMLElement;
  /** Called with a freshly minted code when the player creates a room. */
  onCreate: (code: string) => void;
  /** Called with a normalized code when the player joins by typed code. */
  onJoin: (code: string) => void;
  /** Called if the player backs out. */
  onBack?: () => void;
}

/**
 * Room-entry screen: a "Create a room" button AND an "Enter room code → Join"
 * field. The invite link is a convenience; a friend must be able to TYPE a code.
 */
export function createRoomEntry(config: RoomEntryConfig): { destroy: () => void } {
  const { container } = config;
  container.innerHTML = `
    <div class="room-entry">
      <h2 class="re-title">Play with friends</h2>
      <p class="re-sub">Peer-to-peer — no server, no login. Start a room or join one.</p>
      <button class="re-create" type="button">Create a room</button>
      <div class="re-or"><span>or</span></div>
      <form class="re-joinform" novalidate>
        <label class="re-label" for="re-code">Enter a room code</label>
        <div class="re-joinrow">
          <input class="re-input" id="re-code" inputmode="text" autocomplete="off"
                 autocapitalize="characters" spellcheck="false" maxlength="8"
                 placeholder="e.g. QK7P" aria-label="Room code" />
          <button class="re-join" type="submit">Join</button>
        </div>
        <p class="re-err" role="status" aria-live="polite"></p>
      </form>
      <button class="re-back" type="button">← Back</button>
    </div>`;

  const input = container.querySelector<HTMLInputElement>('.re-input')!;
  const err = container.querySelector<HTMLElement>('.re-err')!;

  const create = () => config.onCreate(mintCode());
  const join = (e: Event) => {
    e.preventDefault();
    const code = normalizeRoomCode(input.value);
    if (code.length < 3) {
      err.textContent = 'That code looks too short — check and try again.';
      input.focus();
      return;
    }
    config.onJoin(code);
  };

  container.querySelector('.re-create')?.addEventListener('click', create);
  container.querySelector('.re-joinform')?.addEventListener('submit', join);
  container.querySelector('.re-back')?.addEventListener('click', () => config.onBack?.());
  input.addEventListener('input', () => {
    const norm = normalizeRoomCode(input.value);
    if (input.value !== norm) input.value = norm;
    err.textContent = '';
  });

  return {
    destroy() {
      container.innerHTML = '';
    },
  };
}

export function createLobby(config: LobbyConfig): { destroy: () => void } {
  const { net, rounds, container } = config;
  const minPlayers = config.minPlayers ?? 2;
  const maxPlayers = config.maxPlayers ?? 8;

  // The lobby renders; it does not decide. Presence, readiness, quorum and the
  // start signal all live in rematch.ts, so the first race and every rematch
  // travel the identical code path — including the frozen roster.
  function players(): LobbyPlayer[] {
    const s = rounds.state();
    const host = net.host();
    const ready = new Set(s.votes.map((v) => v.id));
    return s.present
      .map((p) => ({
        id: p.id,
        name: p.name,
        ready: ready.has(p.id),
        isHost: p.id === host,
        isSelf: p.id === net.selfId,
      }))
      .sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.id.localeCompare(b.id)));
  }

  function toggleReady(): void {
    if (rounds.state().voted) rounds.unvote();
    else rounds.vote();
    render();
  }

  async function share(): Promise<void> {
    const link = inviteLink(config.roomCode);
    const shareData = { title: 'Join my Gravity Golf game', text: `Room ${config.roomCode}`, url: link };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      flash('Invite link copied');
    } catch {
      flash(link);
    }
  }

  function flash(msg: string): void {
    const el = container.querySelector<HTMLElement>('.lobby-flash');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1800);
    }
  }

  /** Unchanged gate: every non-host has readied up, and we have a full grid. */
  function canStart(): boolean {
    const ps = players();
    return net.isHost() && ps.length >= minPlayers && ps.every((p) => p.ready || p.isHost);
  }

  function start(): void {
    if (!canStart()) return;
    // The host abstains from voting until it presses Start, which is what keeps
    // rematch's auto-start from firing here and preserves "the host starts the
    // race". Voting first puts the host into the frozen roster go() ships.
    rounds.vote();
    rounds.go();
  }

  /** Repaint only on a real change — a blind interval would fight the user for
   *  focus on the invite-link field. */
  let painted = '';

  function render(): void {
    if (rounds.state().phase === 'playing') return;
    const ps = players();
    const key = JSON.stringify([ps, canStart()]);
    if (key === painted) return;
    painted = key;
    const link = inviteLink(config.roomCode);
    container.innerHTML = `
      <div class="lobby">
        <div class="lobby-head">
          <h2 class="lobby-title">Room <span class="lobby-code">${escapeHtml(config.roomCode)}</span></h2>
          <p class="lobby-sub">${ps.length}/${maxPlayers} players · peer-to-peer, no server</p>
        </div>
        <div class="lobby-invite">
          <input class="lobby-link" readonly value="${escapeHtml(link)}" aria-label="Invite link" />
          <button class="lobby-btn lobby-share" type="button">Invite</button>
        </div>
        <ul class="lobby-players">
          ${ps
            .map(
              (p) => `<li class="lobby-player${p.isSelf ? ' is-self' : ''}">
                <span class="lobby-dot ${p.ready || p.isHost ? 'ready' : ''}"></span>
                <span class="lobby-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</span>
                ${p.isHost ? '<span class="lobby-badge">HOST</span>' : p.ready ? '<span class="lobby-badge ok">READY</span>' : ''}
              </li>`,
            )
            .join('')}
        </ul>
        ${
          ps.length < minPlayers
            ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Looking for ${minPlayers - ps.length} more player${minPlayers - ps.length === 1 ? '' : 's'}… share the room code or link</span></div>`
            : ''
        }
        <div class="lobby-actions">
          ${
            net.isHost()
              ? `<button class="lobby-btn lobby-start" type="button" ${canStart() ? '' : 'disabled'}>
                   ${ps.length < minPlayers ? `Waiting for ${minPlayers - ps.length} more…` : 'Start race'}
                 </button>`
              : `<button class="lobby-btn lobby-ready" type="button">${rounds.state().voted ? 'Not ready' : "I'm ready"}</button>
                 <p class="lobby-wait"><span class="spinner sm" aria-hidden="true"></span> Waiting for the host to start…</p>`
          }
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    container.querySelector('.lobby-share')?.addEventListener('click', () => void share());
    container.querySelector('.lobby-ready')?.addEventListener('click', toggleReady);
    container.querySelector('.lobby-start')?.addEventListener('click', start);
    container.querySelector<HTMLInputElement>('.lobby-link')?.addEventListener('focus', (e) => {
      (e.target as HTMLInputElement).select();
    });
  }

  // Repaint for roster/ready changes and for a host transfer (net.ts re-elects
  // when the host leaves), so a promoted peer learns Start is now theirs.
  // Presence gossip and resync belong to rematch.ts, not to this view.
  let lastHost = net.host();
  const poll = setInterval(() => {
    render();
    const host = net.host();
    if (host !== lastHost) {
      const wasHost = lastHost === net.selfId;
      lastHost = host;
      if (net.isHost() && !wasHost) flash("The host left — you're the host now");
    }
  }, 600);

  render();

  return {
    destroy() {
      clearInterval(poll);
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

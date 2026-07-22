// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
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

import type { Net, PeerId } from '@ben-gy/game-engine/net';
// Types only. Importing the noticeboard's implementation here would drag a mesh
// of strangers into every screen that shows a room code — see BoardAccess.
import type { PublicRoom, RoomAd } from '@ben-gy/game-engine/noticeboard';
import type { Rounds } from '@ben-gy/game-engine/rematch';

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
  /** Optional game-settings block rendered above the actions (host picks). */
  modeSlot?: () => string;
  /** Called after each repaint so the slot's controls can be re-wired. */
  onModeMount?: () => void;
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

/** Push a chosen room code into the URL so the invite link + a refresh both work. */
export function setRoomInUrl(roomCode: string): void {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  // A ?seed= course link and a room are different ways to play — never both.
  url.searchParams.delete('seed');
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

/**
 * Drop ?room= on the way out of a room. Without this the code outlives the
 * session: reopen the page — from history, or a home-screen icon — and the stale
 * parameter drags you straight back into a room you have left, with no way to
 * start a fresh one. "It always spawns the same game room no matter what."
 * A ?seed= course link is left alone — it is still replayable.
 */
export function clearRoomInUrl(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has('room')) return;
  url.searchParams.delete('room');
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

export function inviteLink(roomCode: string): string {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  return url.toString();
}

// ---- public rooms -----------------------------------------------------------
//
// Everything below exists to keep ONE promise: a private room is invisible, and
// a player who only plays with friends never touches the noticeboard at all.
// The board is WebRTC, so being on it — listing OR browsing — hands your IP to
// every stranger who is also on it. That is the cost, it is unavoidable in a
// serverless lobby, and the only honest answer is to make it opt-in on both
// sides and say so where the player opts in rather than in About.

/** Shown under the public/private choice. Plain language, no euphemism. */
export const P2P_IP_NOTE =
  'Public games are peer-to-peer, so other players can see your IP address — the ' +
  'same as any P2P game, but with strangers rather than friends.';

/** Shown under the browse button. Browsing costs the same thing, so it says so. */
export const BROWSE_IP_NOTE =
  'The list is peer-to-peer too: while it is open, the other people browsing can ' +
  'see your IP address. It closes as soon as you leave this screen.';

/**
 * The noticeboard, as the room screens are allowed to see it.
 *
 * Deliberately NOT a Noticeboard. The board gets opened and closed repeatedly
 * over a session (browse → back → browse; public → private → public) and net.ts
 * throws if its room is rejoined while the last one is still tearing down. The
 * owner serialises that; the views just declare what they want.
 */
export interface BoardAccess {
  /** Join the board and start listing. Only ever from an explicit opt-in. */
  open(onRooms: (rooms: PublicRoom[]) => void): Promise<void>;
  /** Advertise this room, joining the board if we are not on it yet. */
  announce(ad: RoomAd): Promise<void>;
  /** Leave the board. Never hold the mesh open behind a screen nobody is on. */
  close(): void;
}

export interface ListingState {
  /** The host's choice. Private is the default, and private NEVER announces. */
  isPublic: boolean;
  isHost: boolean;
  /** False the moment the lobby is gone — a started race leaves the board. */
  inLobby: boolean;
  playing: boolean;
  code: string;
  host: string;
  players: number;
  max: number;
  note?: string;
}

/**
 * The single rule for "is this room on the public list?", returning the ad to
 * broadcast or null meaning get off the board.
 *
 * One function, so the announce tick, the race start and the way out cannot
 * answer it differently. A room still advertising after it went private is not
 * a cosmetic bug — it is the one promise this feature makes, broken.
 */
export function roomAd(s: ListingState): RoomAd | null {
  if (!s.isPublic || !s.isHost || !s.inLobby || s.playing) return null;
  return {
    code: s.code,
    host: s.host,
    players: s.players,
    max: s.max,
    playing: false,
    ...(s.note ? { note: s.note } : {}),
  };
}

export interface Listing {
  /** Feed it the room's current truth; it does the rest. Cheap to call often. */
  sync(s: ListingState): void;
  close(): void;
}

/** Keeps the board's copy of this room in step with reality, and lets go of the
 *  board the instant the room stops qualifying. */
export function createListing(board: BoardAccess): Listing {
  let last = '';
  return {
    sync(s: ListingState) {
      const ad = roomAd(s);
      // Re-announcing an unchanged ad every tick would be pure noise: the board
      // already re-broadcasts what it holds every 2s to prove the room is alive.
      const key = ad ? JSON.stringify(ad) : '';
      if (key === last) return;
      last = key;
      if (!ad) {
        board.close();
        return;
      }
      void board.announce(ad);
    },
    close() {
      last = '';
      board.close();
    },
  };
}

export interface RoomEntryConfig {
  container: HTMLElement;
  /**
   * `created` is true for a fresh hosted room, false when a code was typed in or
   * picked off the public list. `isPublic` is only ever true alongside `created`
   * — you cannot list someone else's room.
   */
  onSubmit: (roomCode: string, created: boolean, isPublic: boolean) => void;
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
  /** Omit and this game has no public rooms at all: no toggle, no browse. */
  board?: BoardAccess;
  /**
   * How long to keep saying "joining" before believing an empty list. Being ON
   * the board is not the same as being connected to anyone on it — see browse().
   */
  settleMs?: number;
}

/**
 * Room-entry screen: create a room (public or private), TYPE a friend's code, or
 * browse the public list. The invite link is a convenience; a friend must always
 * be able to type a code.
 */
export function createRoomEntry(config: RoomEntryConfig): { destroy: () => void } {
  const { container } = config;
  const title = config.title ?? 'Play with friends';
  const subtitle = config.subtitle ?? 'Start a new room, or enter a code to join a friend.';

  // PRIVATE BY DEFAULT. A public room advertises itself to strangers, so it has
  // to be something the player reached for — never a default they never saw.
  let isPublic = false;
  let browsing = false;
  let joined = false;
  let rooms: PublicRoom[] = [];
  /** Survives the repaint that toggling public/private causes. */
  let draft = '';
  let err = '';
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function leave(code: string, created: boolean): void {
    // Off the board before the screen changes: nothing may keep the mesh open
    // once the player has stopped browsing.
    browsing = false;
    clearTimeout(settleTimer);
    config.board?.close();
    config.onSubmit(code, created, created && isPublic);
  }

  function visChip(pub: boolean, name: string, meta: string): string {
    return `<button class="vis-chip${isPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${isPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${escapeHtml(name)}</span>
      <span class="vis-meta">${escapeHtml(meta)}</span>
    </button>`;
  }

  function renderHome(): void {
    container.innerHTML = `
      <div class="room-entry">
        <div class="re-head">
          <h2 class="re-title">${escapeHtml(title)}</h2>
          <p class="re-sub">${escapeHtml(subtitle)}</p>
        </div>
        ${
          config.board
            ? `<div class="vis re-vis" role="radiogroup" aria-label="Who can join">
                 ${visChip(false, 'Private', 'Invite only')}
                 ${visChip(true, 'Public', 'Listed for anyone')}
               </div>
               <p class="re-note">${escapeHtml(P2P_IP_NOTE)}</p>`
            : ''
        }
        <button class="lobby-btn primary re-create" type="button">Create a ${
          config.board ? (isPublic ? 'public' : 'private') : ''
        } room</button>
        <div class="re-divider"><span>or join a friend</span></div>
        <form class="re-join" novalidate>
          <input class="re-input" type="text" inputmode="latin" autocomplete="off"
            autocapitalize="characters" spellcheck="false" maxlength="8"
            placeholder="Enter room code" aria-label="Room code" value="${escapeHtml(draft)}" />
          <button class="lobby-btn re-go" type="submit">Join</button>
        </form>
        <p class="re-error" role="alert" aria-live="polite">${escapeHtml(err)}</p>
        ${
          config.board
            ? `<div class="re-divider"><span>or find a game</span></div>
               <button class="lobby-btn re-browse" type="button">Browse public games</button>
               <p class="re-note">${escapeHtml(BROWSE_IP_NOTE)}</p>`
            : ''
        }
        ${config.onCancel ? '<button class="lobby-btn ghost re-cancel" type="button">← Back</button>' : ''}
      </div>`;

    const input = container.querySelector<HTMLInputElement>('.re-input')!;
    const errEl = container.querySelector<HTMLElement>('.re-error')!;
    const showErr = (msg: string) => {
      err = msg;
      errEl.textContent = msg;
    };

    input.addEventListener('input', () => {
      const caretAtEnd = input.selectionStart === input.value.length;
      input.value = normalizeRoomCode(input.value);
      if (caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
      draft = input.value;
      if (errEl.textContent) showErr('');
    });

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
      btn.addEventListener('click', () => {
        isPublic = btn.dataset.pub === '1';
        renderHome();
      });
    }

    container.querySelector('.re-create')?.addEventListener('click', () => leave(mintCode(), true));

    container.querySelector<HTMLFormElement>('.re-join')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = normalizeRoomCode(input.value);
      if (code.length < 3) {
        showErr('Enter the room code your host shared (e.g. QK7P).');
        input.focus();
        return;
      }
      leave(code, false);
    });

    container.querySelector('.re-browse')?.addEventListener('click', () => void browse());

    if (config.onCancel) {
      container.querySelector('.re-cancel')?.addEventListener('click', () => {
        config.board?.close();
        config.onCancel!();
      });
    }
  }

  /** The ONLY thing that ever joins the board. Not page load, not the lobby. */
  async function browse(): Promise<void> {
    browsing = true;
    joined = false;
    rooms = [];
    renderBrowse();
    await config.board!.open((next) => {
      rooms = next;
      // Hearing any room at all proves the mesh is up — stop waiting on a clock.
      if (rooms.length) joined = true;
      if (browsing) renderBrowse();
    });
    if (!browsing) return;
    // Being ON the board is not the same as being connected to anyone on it: the
    // mesh forms through a public relay and takes seconds. An empty list in that
    // window means "we have not heard yet", not "nobody is there" — and saying
    // the latter is a lie the player acts on. They tap Back, and never see the
    // room that was being advertised the whole time.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      joined = true;
      if (browsing) renderBrowse();
    }, config.settleMs ?? 3000);
  }

  function stopBrowsing(): void {
    browsing = false;
    clearTimeout(settleTimer);
    config.board?.close();
    renderHome();
  }

  function roomRow(r: PublicRoom): string {
    const full = r.players >= r.max;
    return `<li><button class="re-room${r.playing ? ' playing' : ''}" type="button"
      data-code="${escapeHtml(r.code)}">
      <span class="re-room-host">${escapeHtml(r.host)}</span>
      <span class="re-room-code">${escapeHtml(r.code)}</span>
      <span class="re-room-note">${escapeHtml(r.note ?? 'Open room')}</span>
      <span class="re-room-meta">${r.players}/${r.max}${full ? ' · full' : ''}</span>
      ${
        r.playing
          ? '<span class="re-room-state">Race in progress — you would wait in the lobby</span>'
          : ''
      }
    </button></li>`;
  }

  function renderBrowse(): void {
    const body = !joined
      ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
           <span>Joining the public list…</span></div>`
      : rooms.length
        ? `<ul class="re-rooms">${rooms.map(roomRow).join('')}</ul>`
        : `<p class="re-empty">Nobody has a public room open right now. Rooms only
             appear here while someone is sitting in one waiting for players — so
             it is often empty. Start one and see who turns up.</p>`;

    container.innerHTML = `
      <div class="room-entry">
        <div class="re-head">
          <h2 class="re-title">Public games</h2>
          <p class="re-sub">Anyone can join these. Tap one to go in as a guest.</p>
        </div>
        ${body}
        <button class="lobby-btn${rooms.length ? '' : ' primary'} re-make" type="button">Create a room instead</button>
        <p class="re-note">${escapeHtml(BROWSE_IP_NOTE)}</p>
        <button class="lobby-btn ghost re-back" type="button">← Back</button>
      </div>`;

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.re-room')) {
      // A room off the list is SOMEONE ELSE'S. Guest, never host: created=false
      // is what keeps claimHost false, so we wait for the incumbent rather than
      // racing a stranger for their own room.
      btn.addEventListener('click', () => leave(normalizeRoomCode(btn.dataset.code!), false));
    }
    container.querySelector('.re-make')?.addEventListener('click', () => {
      browsing = false;
      config.board?.close();
      leave(mintCode(), true);
    });
    container.querySelector('.re-back')?.addEventListener('click', stopBrowsing);
  }

  renderHome();

  return {
    destroy() {
      browsing = false;
      clearTimeout(settleTimer);
      config.board?.close();
      container.innerHTML = '';
    },
  };
}

/**
 * How long a peer sits alone and unsettled before the lobby offers to host.
 *
 * The engine's net.ts deliberately never self-elects on a roster of one: silence
 * is evidence of NO MESH, not of an empty room, and a peer that assumed
 * otherwise became a phantom host that later walked into a live room and stole
 * it. (The old vendored net.ts did exactly that after 2.5s — it is the reason a
 * second player joining could kick everyone out.)
 *
 * But that invariant leaves a real player with nowhere to go: someone who opens
 * an invite link after the host has left is alone, unsettled, and would spin
 * forever. So net.ts hands the escape hatch to the lobby, where it belongs —
 * hosting an orphaned room is a UX decision the player makes, never one the
 * transport makes on their behalf.
 */
const OFFER_HOST_MS = 15000;

export function createLobby(config: LobbyConfig): { destroy: () => void; repaint: () => void } {
  const { net, rounds, container } = config;
  const minPlayers = config.minPlayers ?? 2;
  const maxPlayers = config.maxPlayers ?? 8;
  const openedAt = Date.now();
  /** Set once the player accepts the offer, so it is never re-offered. */
  let tookOver = false;

  /** Alone, unsettled, and waiting long enough that we should offer to host. */
  function shouldOfferHost(): boolean {
    return !tookOver && !net.hostSettled() && net.count() === 1 && Date.now() - openedAt > OFFER_HOST_MS;
  }

  // The lobby renders; it does not decide. Presence, readiness, quorum and the
  // start signal all live in rematch.ts, so the first race and every rematch
  // travel the identical code path — including the frozen roster.
  function players(): LobbyPlayer[] {
    const s = rounds.state();
    // Null until the room settles. Painting a host badge before then is how both
    // players ended up looking like the host of a room that never connected.
    const host = net.hostSettled() ? net.host() : null;
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

  /** Unchanged gate: every non-host has readied up, and we have a full grid.
   *  net.isHost() is false until the room settles, so this cannot fire on a mesh
   *  that has not formed. */
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
    const key = JSON.stringify([
      ps,
      canStart(),
      net.hostSettled(),
      shouldOfferHost(),
      config.modeSlot?.() ?? '',
    ]);
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
          shouldOfferHost()
            ? `<div class="lobby-searching lobby-offer">
                 <span>Nobody's here yet. If you minted this code, you can host the room.</span>
                 <button class="lobby-btn lobby-host" type="button">Host this room</button>
               </div>`
            : !net.hostSettled()
            ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Connecting to the room…</span></div>`
            : ps.length < minPlayers
              ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Looking for ${minPlayers - ps.length} more player${minPlayers - ps.length === 1 ? '' : 's'}… share the room code or link</span></div>`
              : ''
        }
        ${config.modeSlot ? config.modeSlot() : ''}
        <div class="lobby-actions">
          ${
            // Until the room settles we do not know who hosts, so we render
            // neither the host's Start nor the guest's "waiting for the host" —
            // both are lies about a mesh that has not formed yet.
            !net.hostSettled()
              ? `<button class="lobby-btn lobby-ready" type="button" disabled>I'm ready</button>`
              : net.isHost()
                ? `<button class="lobby-btn lobby-start" type="button" ${canStart() ? '' : 'disabled'}>
                   ${ps.length < minPlayers ? `Waiting for ${minPlayers - ps.length} more…` : 'Start race'}
                 </button>`
                : `<button class="lobby-btn lobby-ready" type="button">${rounds.state().voted ? 'Not ready' : "I'm ready"}</button>
                 <p class="lobby-wait"><span class="spinner sm" aria-hidden="true"></span> Waiting for the host to start…</p>`
          }
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    config.onModeMount?.();
    container.querySelector('.lobby-host')?.addEventListener('click', () => {
      tookOver = true;
      // A NEW term, so if a real incumbent surfaces later its higher epoch wins
      // and we stand down — the offer can never re-create the phantom host.
      net.takeover();
      render();
    });
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
      const hadHost = lastHost !== null;
      lastHost = host;
      // `hadHost` matters: host() is null until the room settles, so without it
      // the very first settle onto ourselves would announce a handover that never
      // happened. Only a real incumbent leaving earns the message.
      if (hadHost && net.isHost() && !wasHost) flash("The host left — you're the host now");
    }
  }, 600);

  render();

  return {
    destroy() {
      clearInterval(poll);
    },
    repaint() {
      painted = '';
      render();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

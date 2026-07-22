// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — bootstrap & screen routing for Gravity Golf.
 * Owns the canvas, slingshot input, the fixed-timestep loop, and the menu →
 * game → results / lobby flow for solo, async-seed, and live P2P race play.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createLoop, type Loop } from '@ben-gy/game-engine/loop';
import { createSfx } from './engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { newSeed } from '@ben-gy/game-engine/rng';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createListing,
  createRoomEntry,
  roomCodeFromUrl,
  setRoomInUrl,
  P2P_IP_NOTE,
  type BoardAccess,
  type Listing,
} from './engine/lobby';
import { createNoticeboard, type Noticeboard, type PublicRoom } from '@ben-gy/game-engine/noticeboard';
import { createCountdown } from './countdown';
import { DEFAULT_MODE, MODE_LIST, modeOf, timeLimitMs, type Mode, type ModeId } from './modes';
import { generateCourse } from './game/course';
import { GolfGame } from './game/golf';
import { type Vec } from './game/physics';
import { Fx } from './fx';
import { computeView, screenToWorld, draw, PAL, type View, type AimView } from './render';
import { NetGame } from './net-game';
import type { RoundPlayer } from '@ben-gy/game-engine/rematch';
import type { RaceSnapshot } from './game/race';
import {
  FOOTER_HTML,
  menuHTML,
  howToHTML,
  aboutHTML,
  soloResultsHTML,
  raceResultsHTML,
  esc,
  toParStr,
} from './ui';

const APP_ID = 'gravity-golf';
/**
 * The signaling namespace for every mesh this page opens. `roomAppId()` folds
 * the engine's wire-protocol revision into the slug, so a player on a cached
 * old build lands in a different namespace and simply never sees us — honest,
 * and far better than half-connecting and desyncing. It is deliberately NOT
 * APP_ID: that stays the raw slug so localStorage keys (and everyone's saved
 * bests) survive a protocol bump.
 */
const ROOM_APP_ID = roomAppId(APP_ID);
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MAX_DRAG = 46; // world units for full power
const POWER_SCALE = 1.7;
const MIN_DRAG = 2.5; // deadzone
const CELEBRATE_MS = 1.15; // seconds of sink celebration before advancing

// Before anything renders: iOS ignores the viewport meta's user-scalable=no, so
// a double-tap or a pinch will zoom a live course and there is no way back out.
hardenViewport();

/**
 * TURN credentials, fetched the moment the page boots — before any mesh exists.
 *
 * Trystero pre-builds ONE global pool of peer connections from whichever
 * joinRoom() fires FIRST on the page, and every later room draws its outbound
 * offers from that pool. So if the public-rooms noticeboard opens first without
 * TURN, the game room's *initiating* half stays STUN-only no matter what the
 * game room asks for — which is exactly the half a phone on carrier-grade NAT
 * needs relayed, and it fails for only about half of all pairs, making it
 * miserable to diagnose. Hence: one fetch, at boot, before either mesh.
 *
 * Awaited at every mesh site rather than merely fired-and-forgotten, so the
 * ordering is guaranteed instead of likely. That costs nothing in practice —
 * getTurnConfig() is sessionStorage-cached, times out at 3s, and fails open to
 * an empty list (i.e. the old STUN-only behaviour), so it can never block or
 * fail a join. Starting it here rather than at join time means it has almost
 * always resolved before the player has finished reading the menu.
 */
const turnReady: Promise<void> = getTurnConfig().then(
  (servers) => setTurnConfig(servers),
  () => setTurnConfig([]),
);

const store = createStore(APP_ID);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sfx = createSfx(store.get('muted', false));

const app = document.getElementById('app')!;
let content: HTMLElement; // .main-content

// ---- session state ----
let mode: 'solo' | 'race' = 'solo';
let game: GolfGame | null = null;
let net: Net | null = null;
let rounds: Rounds | null = null;
let netGame: NetGame | null = null;
let lobby: { destroy: () => void; repaint: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let loop: Loop | null = null;
let fx = new Fx(reduced);
let countdown: { cancel: () => void } | null = null;
let listing: Listing | null = null;
let listingTick: number | undefined;
/** The room we are in, and whether it is on the public list. Private by default. */
let roomCode = '';
let roomPublic = false;

/** The mode this player last chose. The HOST's choice is what a room plays. */
let modeId: ModeId = modeOf(store.get<string>('mode', DEFAULT_MODE)).id;

function setMode(id: ModeId): void {
  modeId = modeOf(id).id;
  store.set('mode', modeId);
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let view: View = { scale: 1, ox: 0, oy: 0, cw: 1, ch: 1 };
let dpr = 1;

let paused = false;
let celebrateT = 0;
let courseSeed: number | string = 0;
// The course actually being PLAYED. Set from a Mode at every start — in a race,
// from the HOST's mode as it arrived frozen in the round start, never from
// `modeId`, which is only ever this peer's own lobby pick. Kept as the whole
// Mode rather than a loose hole count so the two cannot drift apart: a restart
// or a scorecard that rebuilt the course with the right length and the wrong
// tier would silently show pars from a course nobody played.
let playedMode: Mode = modeOf(DEFAULT_MODE);
let lastBounceSfx = 0;
let selfFinished = false;
let raceOver = false;
let lastSnap: RaceSnapshot | null = null;

// aim
let dragging = false;
let dragCur: Vec | null = null;
let kbAngle = 0;
let kbPower = 0.62;
let kbActive = false;

// net dispatch (reassigned when a race starts)
let onHostChangeRoute: (isHost: boolean) => void = () => {};
let onPeerLeaveRoute: (id: string) => void = () => {};
let onPeersRoute: (ids: string[]) => void = () => {};

// ---- helpers ----
function playerName(): string {
  let n = store.get<string>('name', '');
  if (!n) {
    const adj = ['Comet', 'Nova', 'Orbit', 'Lunar', 'Astro', 'Pulsar', 'Nebula', 'Rocket', 'Quasar', 'Meteor'];
    const num = 100 + Math.floor(Math.random() * 900);
    n = `${adj[Math.floor(Math.random() * adj.length)]}-${num}`;
    store.set('name', n);
  }
  return n;
}

function shell(inner: string): void {
  app.innerHTML = `<div class="main-content">${inner}</div>${FOOTER_HTML}`;
  content = app.querySelector('.main-content')!;
}

function firstGestureUnlock(): void {
  sfx.unlock();
}

// ---- mode picker -------------------------------------------------------------

function modePicker(): string {
  const m = modeOf(modeId);
  return `
    <div class="modes" role="radiogroup" aria-label="Course">
      ${MODE_LIST.map(
        (x) => `<button class="mode-chip${x.id === m.id ? ' on' : ''}" type="button"
          role="radio" aria-checked="${x.id === m.id}" data-mode="${x.id}">
          <span class="mode-name">${esc(x.name)}</span>
          <span class="mode-meta">${x.holes} holes${x.tier ? ' · hard' : ''}</span>
        </button>`,
      ).join('')}
      <p class="mode-blurb">${esc(m.blurb)}</p>
    </div>`;
}

function modeNote(): string {
  // The HOST's gossiped choice — never our own local pick. Rendering `modeId`
  // here would confidently tell a guest "Host picked Sprint" while the host was
  // actually on Gauntlet, and then a 9-hole course would appear.
  const hostOpts = rounds?.state().hostOpts as { mode?: unknown; pub?: unknown } | null | undefined;
  if (hostOpts == null) return `<p class="mode-note">Waiting for the host's pick…</p>`;
  const m = modeOf(hostOpts.mode);
  return (
    `<p class="mode-note">Host picked <strong>${esc(m.name)}</strong> · ${m.holes} holes</p>` +
    // Guests are on the host's course too. Someone who was handed an invite link
    // has no way of knowing strangers can walk in unless we say so.
    (hostOpts.pub
      ? `<p class="mode-note pub">This room is listed publicly — anyone browsing can join.</p>`
      : '')
  );
}

function wireModePicker(repaint: () => void): void {
  for (const btn of content.querySelectorAll<HTMLButtonElement>('.mode-chip')) {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode as ModeId);
      sfx.play('blip');
      repaint();
    });
  }
}

// ---- public / private --------------------------------------------------------

/** The host's own control, in the lobby: a room can be taken off the list again. */
function visibilityPicker(): string {
  const chip = (pub: boolean, name: string, meta: string): string =>
    `<button class="vis-chip${roomPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${roomPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${esc(name)}</span>
      <span class="vis-meta">${esc(meta)}</span>
    </button>`;
  return `
    <div class="vis" role="radiogroup" aria-label="Who can join">
      ${chip(false, 'Private', 'Invite only')}
      ${chip(true, 'Public', 'Listed for anyone')}
    </div>
    <p class="re-note">${esc(P2P_IP_NOTE)}</p>`;
}

function wireVisibility(repaint: () => void): void {
  for (const btn of content.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
    btn.addEventListener('click', () => {
      roomPublic = btn.dataset.pub === '1';
      sfx.play('blip');
      // Immediately, not on the next tick: "private" has to mean off the list
      // now, not within a second.
      syncListing();
      repaint();
    });
  }
}

// ---- the public room list ----------------------------------------------------
//
// At most one board, held only while something is actually using it — browsing
// the list, or listing our own room. It is a mesh of STRANGERS (see P2P_IP_NOTE),
// so it is never opened by the page loading and never left running behind a
// screen the player has walked away from.

let board: Noticeboard | null = null;
let boardRooms: ((rooms: PublicRoom[]) => void) | null = null;
/** Serialises open/close. net.ts throws if the board's room is rejoined while
 *  the last one is still tearing down, and browse → back → browse is two taps. */
let boardQueue: Promise<void> = Promise.resolve();

function onBoard(then: () => void): Promise<void> {
  boardQueue = boardQueue
    .then(async () => {
      // The board is often the first mesh on the page (menu → browse, before
      // any room is joined), so TURN has to be in force before it opens or it
      // poisons the shared offer pool for the game room that follows.
      await turnReady;
      board ??= createNoticeboard({ appId: ROOM_APP_ID, onRooms: (r) => boardRooms?.(r) });
      then();
    })
    .then(
      () => undefined,
      (e) => console.error(e),
    );
  return boardQueue;
}

const boardAccess: BoardAccess = {
  open(onRooms) {
    boardRooms = onRooms;
    // Hand over whatever is already known so the list is not blank for a cycle.
    return onBoard(() => onRooms(board!.rooms()));
  },
  announce(ad) {
    return onBoard(() => board!.announce(ad));
  },
  close() {
    boardRooms = null;
    const b = board;
    board = null;
    if (!b) return;
    // CHAIN, never replace — same trap as roomTeardown below.
    boardQueue = boardQueue.then(() => b.destroy()).then(
      () => undefined,
      () => undefined,
    );
  },
};

/** Feed engine/lobby.ts's roomAd() rule the room's current truth. It decides. */
function syncListing(): void {
  if (!listing) return;
  if (!net || !rounds) {
    listing.close();
    return;
  }
  const s = rounds.state();
  listing.sync({
    isPublic: roomPublic,
    isHost: net.isHost(),
    inLobby: !!lobby,
    playing: s.phase === 'playing',
    code: roomCode,
    host: playerName(),
    players: s.present.length,
    max: MAX_PLAYERS,
    note: `${modeOf(modeId).name} · ${modeOf(modeId).holes} holes`,
  });
}

// ---- room lifecycle ----

/** Resolves once any in-flight room teardown has fully finished. */
let roomTeardown: Promise<void> = Promise.resolve();

/**
 * Tear the room down for good. Only ever called on the way to the menu — NEVER
 * between races. `net.leave()` is awaited because Trystero keeps the room in its
 * cache until teardown finishes; joining again before then hands back the dying
 * room and every peer ends up alone and self-elected as host. Rematches keep the
 * Net alive and start a new round inside it (engine/rematch.ts).
 */
function leaveRoom(): Promise<void> {
  lobby?.destroy();
  lobby = null;
  roomEntry?.destroy();
  roomEntry = null;
  rounds?.destroy();
  rounds = null;
  // The NetGame holds the keepalive and the 'prog'/'snap' receivers, so it has
  // to go BEFORE the Net it is subscribed to — quitting mid-race used to drop
  // the Net and leave this ticking and broadcasting into a room we had left.
  netGame?.destroy();
  netGame = null;
  // Off the list and off the board, before anything else can go wrong. Leaving
  // is one of the three ways a room stops being public (the others are going
  // private and starting a race) and it is the one where nobody is left to
  // notice a stale listing.
  listing?.close();
  listing = null;
  if (listingTick) clearInterval(listingTick);
  listingTick = undefined;
  roomPublic = false;
  roomCode = '';
  // Also covers a board opened by the browse screen: leaveRoom() is on every
  // path out of it.
  boardAccess.close();
  countdown?.cancel();
  countdown = null;
  teardownGame();
  // The room is over for us — take it out of the URL so a refresh, or reopening
  // from the home-screen icon, lands on the menu instead of silently rejoining.
  clearRoomInUrl();
  const leaving = net;
  net = null;
  // CHAIN, never replace. leaveRoom() runs again on the way into a new room, and
  // by then `net` is already null — replacing the promise there would hand back
  // an instantly-resolved teardown while the real one was still inside
  // Trystero's 99ms window, and the next createNet would throw.
  roomTeardown = roomTeardown.then(() => leaving?.leave()).then(
    () => undefined,
    () => undefined,
  );
  return roomTeardown;
}

// ---- menu ----
/** Bests are per MODE: a 3-hole Sprint and a 9-hole Gauntlet are not comparable. */
function bestLabel(): string {
  const m = modeOf(modeId);
  const best = store.get<number | null>(`best-${m.id}`, null);
  return best != null
    ? `Best ${m.name} round: ${best} strokes`
    : 'No round played yet — go for a low score!';
}

function showMenu(): void {
  void leaveRoom();
  shell(menuHTML(bestLabel(), modeOf(modeId), modePicker()));
  wireModePicker(() => showMenu());
  content.querySelector('#m-solo')?.addEventListener('click', () => {
    firstGestureUnlock();
    startSolo(newSeed(), modeOf(modeId));
  });
  content.querySelector('#m-friends')?.addEventListener('click', () => {
    firstGestureUnlock();
    showRoomEntry();
  });
  content.querySelector('#m-how')?.addEventListener('click', () => openModal(howToHTML()));
  content.querySelector('#m-about')?.addEventListener('click', () => openModal(aboutHTML()));
  maybeAutoHowTo();
}

function maybeAutoHowTo(): void {
  if (!store.get('seen-howto', false)) {
    store.set('seen-howto', true);
    openModal(howToHTML());
  }
}

// ---- modal ----
function openModal(html: string): void {
  closeModal();
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <button class="modal-close" aria-label="Close">✕</button>
      ${html}
    </div>`;
  m.addEventListener('click', (e) => {
    if (e.target === m || (e.target as HTMLElement).classList.contains('modal-close')) closeModal();
  });
  document.body.appendChild(m);
}
function closeModal(): void {
  document.querySelector('.modal-backdrop')?.remove();
}

// ---- solo ----
function startSolo(seed: number | string, m: Mode): void {
  mode = 'solo';
  courseSeed = seed;
  playedMode = m;
  const course = generateCourse(seed, m.holes, m.tier);
  game = new GolfGame(course);
  buildGameScreen();
  resetKbAim();
  updateHud();
  startLoop();
}

// ---- room entry / lobby ----
function showRoomEntry(): void {
  void leaveRoom();
  shell(`<div class="screen entry" id="entry"></div>`);
  roomEntry = createRoomEntry({
    container: content.querySelector('#entry')!,
    subtitle: 'Peer-to-peer — no server, no login. Start a room or join one.',
    // Handing the entry `board` is what makes public rooms exist at all — it
    // does not join anything until the player taps Browse.
    board: boardAccess,
    // Minting the code is the ONLY way to arrive as the host. Typing a friend's
    // code walks into a room they already hold — see openRoom's claimHost.
    onSubmit: (code, created, isPublic) => void openRoom(code, created, isPublic),
    onCancel: () => showMenu(),
  });
}

/**
 * Join a room ONCE and hold it for as long as the player stays. Every race —
 * the first and every rematch — runs inside this one Net via `rounds`. Nothing
 * here may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string, created: boolean, isPublic: boolean): Promise<void> {
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms).
  // Joining inside that window returns the dying room, so wait it out.
  await roomTeardown;
  // Started at boot, so on the deep-link path (the only one that reaches here
  // without the player passing through the menu) this is the guarantee that
  // TURN is in force before the very first mesh, not merely on its way.
  await turnReady;

  // Put the room code in the URL so the invite link carries it. The public flag
  // stays OUT: it is the host's live choice, not a property of the code. Baked
  // into an invite link it would survive the host flipping the room private, and
  // every guest who forwarded the link would pass on a claim that is not true.
  setRoomInUrl(code);
  roomCode = code;
  roomPublic = created && isPublic;

  try {
    net = createNet(
      // `created` is the difference between minting this code and walking into
      // someone else's room. Only the minter may host on arrival; a guest waits
      // to hear from the incumbent instead of racing it for the role.
      { appId: ROOM_APP_ID, roomId: code, claimHost: created },
      {
        onHostChange: (_id, isHost) => onHostChangeRoute(isHost),
        onPeerLeave: (id) => onPeerLeaveRoute(id),
        onPeers: (peers) => onPeersRoute(peers),
      },
    );
  } catch (err) {
    // The room is somehow still held (see engine/net.ts). Never strand the
    // player on a blank screen — go back somewhere they can act.
    console.error(err);
    showMenu();
    return;
  }

  rounds = createRounds({
    net,
    playerName: playerName(),
    minPlayers: MIN_PLAYERS,
    // Only the host's pick counts, and it travels frozen with the start — a mode
    // each peer read from its own UI is a mode two peers can disagree about, and
    // here that is two different courses. `pub` rides along so a guest can see
    // that strangers may walk in; it is gossiped with presence, so it is live
    // rather than a claim from join time.
    roundOpts: () => ({ mode: modeId, pub: roomPublic }),
    onRound: ({ seed, players, isHost, opts }) => startRace(seed, players, isHost, opts),
  });

  listing = createListing(boardAccess);
  // Player counts move, the host can flip the room private, and the host role
  // itself can transfer mid-lobby. Poll one rule rather than hunt every edge.
  listingTick = window.setInterval(syncListing, 1000);

  showLobby(code);
}

function showLobby(code: string): void {
  if (!net || !rounds) return;
  shell(`<div class="screen lobby-screen" id="lobby"></div>
    <button class="btn ghost back-btn" id="lobby-back">← Leave room</button>`);
  content.querySelector('#lobby-back')?.addEventListener('click', () => showMenu());
  lobby = createLobby({
    container: content.querySelector('#lobby')!,
    net,
    rounds,
    roomCode: code,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    // Only the host chooses; everyone else sees what they are about to play, so
    // nobody is surprised by a nine-hole Gauntlet they did not pick.
    modeSlot: () => (net!.isHost() ? modePicker() + visibilityPicker() : modeNote()),
    onModeMount: () => {
      wireModePicker(() => lobby?.repaint());
      wireVisibility(() => lobby?.repaint());
    },
  });
  syncListing();
}

// ---- race ----
function startRace(seed: number, roster: RoundPlayer[], _isHost: boolean, opts: unknown): void {
  if (!net) return;
  lobby?.destroy();
  lobby = null;
  // The race is starting, so the room comes off the list right now — not up to a
  // tick later, and not "once someone notices". syncListing reads `lobby`, which
  // is the null above.
  syncListing();
  netGame?.destroy();
  netGame = null;
  countdown?.cancel();

  // The roster arrives frozen from the host, identical bytes on every peer, so
  // everyone agrees on the field. If we are not in it we joined mid-start —
  // wait for the next race rather than playing a ghost nobody is racing.
  if (!roster.some((p) => p.id === net!.selfId)) {
    showLobby(roomCodeFromUrl() ?? '');
    return;
  }

  // Course AND clock come from the host's mode, frozen into the start alongside
  // the roster. modeOf() is what stops an unknown id off the wire from handing
  // generateCourse an undefined hole count.
  const m = modeOf((opts as { mode?: unknown } | undefined)?.mode);

  mode = 'race';
  courseSeed = seed;
  playedMode = m;
  raceOver = false;
  selfFinished = false;
  lastSnap = null;
  const course = generateCourse(seed, m.holes, m.tier);
  game = new GolfGame(course);

  const names: Record<string, string> = {};
  for (const p of roster) names[p.id] = p.name;

  netGame = new NetGame(
    net!,
    { totalHoles: m.holes, timeLimitMs: timeLimitMs(m), names },
    {
      onSnapshot: (snap) => onSnapshot(snap),
      onHostPromoted: () => showToast("You're the host now"),
    },
  );

  onHostChangeRoute = (isHost) => netGame?.onHostChange(isHost);
  onPeerLeaveRoute = (id) => netGame?.onPeerLeave(id);
  onPeersRoute = (ids) => netGame?.onRoster(ids);
  netGame.onRoster(net!.peers());

  buildGameScreen();
  resetKbAim();
  updateHud();
  syncProgress();

  // Show the course behind the countdown, but hold the shot: the point is that
  // everyone gets the same look at the field before it counts. `paused` is what
  // freezes the sim and blocks input, and the loop still runs so the course is
  // drawn rather than left blank.
  paused = true;
  startLoop();
  countdown = createCountdown({
    root: content.querySelector('#game-screen')!,
    sfx,
    reducedMotion: reduced,
    onDone: () => {
      countdown = null;
      paused = false;
      // The round clock starts when the round does. netGame.start() is what
      // spins up the host's keepalive tick, so starting it before the count
      // would spend the first ~3.5s of everyone's race on the countdown.
      netGame?.start();
    },
  });
}

function onSnapshot(snap: RaceSnapshot): void {
  lastSnap = snap;
  updateRaceStrip(snap);
  if (selfFinished) updateWaitingOverlay(snap);
  if (snap.over) showRaceResults(snap);
}

// ---- game screen / canvas ----
function buildGameScreen(): void {
  shell(`
    <div class="screen game" id="game-screen">
      <div class="hud" id="hud">
        <div class="hud-left">
          <span class="hud-hole" id="hud-hole"></span>
          <span class="hud-par" id="hud-par"></span>
        </div>
        <div class="hud-mid" id="hud-mid"></div>
        <div class="hud-right">
          <button class="icon-btn" id="hud-mute" aria-label="Mute"></button>
          <button class="icon-btn" id="hud-pause" aria-label="Pause">❚❚</button>
        </div>
      </div>
      <div class="race-strip" id="race-strip" ${mode === 'race' ? '' : 'hidden'}></div>
      <div class="stage" id="stage"><canvas id="board"></canvas></div>
      <div class="hint" id="hint">Drag <b>back</b> from the ball, then release to launch</div>
      <div class="toast" id="toast" hidden></div>
      <div class="game-overlay" id="goverlay" hidden></div>
    </div>`);

  canvas = content.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d');
  wireCanvasInput();
  wireHudButtons();
  window.addEventListener('resize', resize);
  resize();
  // Retry once layout settles, in case the first measurement was 0-size.
  requestAnimationFrame(resize);
  setTimeout(resize, 80);
  setTimeout(resize, 300);
  updateMuteBtn();
}

function wireHudButtons(): void {
  content.querySelector('#hud-mute')?.addEventListener('click', toggleMute);
  content.querySelector('#hud-pause')?.addEventListener('click', togglePause);
}

function resize(): void {
  if (!canvas) return;
  const stage = content.querySelector('#stage') as HTMLElement;
  const rect = stage.getBoundingClientRect();
  // Ignore transient zero-size measurements so a good view is never clobbered
  // (which would make pointer→world mapping produce NaN and drop shots).
  if (rect.width < 1 || rect.height < 1) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  view = computeView(rect.width, rect.height);
}

// ---- input ----
function pointerWorld(e: PointerEvent): Vec {
  // Derive canvas-local CSS pixels from clientX/Y + the element rect, matching
  // how `view` is computed. More robust than offsetX/Y across DPR/zoom quirks.
  const rect = canvas!.getBoundingClientRect();
  return screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
}

function onPointerDown(e: PointerEvent): void {
  firstGestureUnlock();
  if (paused || !game || !game.canShoot() || !canvas) return;
  dragging = true;
  kbActive = false;
  dragCur = pointerWorld(e);
}
function onPointerMove(e: PointerEvent): void {
  if (!dragging) return;
  dragCur = pointerWorld(e);
}
function onPointerUpGlobal(): void {
  if (!dragging) return;
  // Compute the aim while `dragging` is still true (computeAim needs it), then
  // release. Reversing these silently drops every slingshot shot.
  const aim = computeAim();
  const cur = dragCur;
  dragging = false;
  dragCur = null;
  if (aim && cur && game?.canShoot()) {
    const len = Math.hypot(game.ball.x - cur.x, game.ball.y - cur.y);
    if (len >= MIN_DRAG) doShoot(aim.vx, aim.vy);
  }
}

function wireCanvasInput(): void {
  if (!canvas) return;
  canvas.style.touchAction = 'none';
  // Move/up on window so a drag that leaves the canvas edge still completes.
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUpGlobal);
  window.addEventListener('pointercancel', onPointerUpGlobal);
  window.addEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'm' || e.key === 'M') {
    toggleMute();
    return;
  }
  if (e.key === 'p' || e.key === 'P') {
    togglePause();
    return;
  }
  if ((e.key === 'r' || e.key === 'R') && mode === 'solo') {
    startSolo(courseSeed, playedMode);
    return;
  }
  if (!game || !game.canShoot() || paused) return;
  if (e.key === 'ArrowLeft') {
    kbAngle -= 0.045;
    kbActive = true;
    e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    kbAngle += 0.045;
    kbActive = true;
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    kbPower = Math.min(1, kbPower + 0.03);
    kbActive = true;
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    kbPower = Math.max(0.05, kbPower - 0.03);
    kbActive = true;
    e.preventDefault();
  } else if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (kbActive) {
      const aim = computeAim();
      if (aim) doShoot(aim.vx, aim.vy);
    }
  }
}

function resetKbAim(): void {
  if (!game) return;
  const h = game.current();
  kbAngle = Math.atan2(h.cup.y - game.ball.y, h.cup.x - game.ball.x);
  kbPower = 0.62;
  kbActive = false;
}

function computeAim(): { vx: number; vy: number; power: number } | null {
  if (!game) return null;
  if (dragging && dragCur) {
    const dx = game.ball.x - dragCur.x;
    const dy = game.ball.y - dragCur.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return null;
    const clamped = Math.min(len, MAX_DRAG);
    const mag = clamped * POWER_SCALE;
    return { vx: (dx / len) * mag, vy: (dy / len) * mag, power: clamped / MAX_DRAG };
  }
  if (kbActive) {
    const mag = kbPower * MAX_DRAG * POWER_SCALE;
    return { vx: Math.cos(kbAngle) * mag, vy: Math.sin(kbAngle) * mag, power: kbPower };
  }
  return null;
}

function doShoot(vx: number, vy: number): void {
  if (!game) return;
  if (game.shoot(vx, vy)) {
    sfx.play('jump');
    fx.burst(game.ball.x, game.ball.y, PAL.ballGlow, 10, 30);
    kbActive = false;
    updateHud();
    syncProgress();
  }
}

// ---- loop ----
function startLoop(): void {
  stopLoop();
  loop = createLoop({ update, render, hz: 60 });
  loop.start();
}
function stopLoop(): void {
  loop?.stop();
  loop = null;
}

function update(dt: number): void {
  if (paused) return;
  fx.update(dt);
  if (!game || game.done) return;
  if (game.awaiting()) {
    celebrateT -= dt;
    if (celebrateT <= 0) advanceHole();
    return;
  }
  if (game.ball.state === 'moving') {
    const ev = game.update(dt);
    handleEvents(ev);
    if (game.ball.state === 'moving') fx.trail(game.ball.x, game.ball.y, PAL.ballGlow);
  }
}

function handleEvents(ev: ReturnType<GolfGame['update']>): void {
  if (ev.bounce) {
    const t = fx.time();
    if (t - lastBounceSfx > 0.05 && ev.bounce.speed > 6) {
      sfx.play('hit');
      lastBounceSfx = t;
    }
    fx.burst(ev.bounce.x, ev.bounce.y, '#cfe6ff', 5, Math.min(40, ev.bounce.speed));
    fx.addShake(Math.min(3, ev.bounce.speed / 40));
  }
  if (ev.swallowed) {
    sfx.play('explosion');
    fx.burst(game!.ball.x, game!.ball.y, PAL.blackRing, 22, 55, 0);
    fx.addShake(4);
    showToast('Swallowed! Shot lost');
    updateHud();
    syncProgress();
  }
  if (ev.holeComplete) {
    const res = game!.results[game!.results.length - 1];
    const ace = res.strokes === 1;
    sfx.play(ace ? 'powerup' : res.strokes <= res.par ? 'win' : 'coin');
    const cup = game!.current().cup;
    fx.burst(cup.x, cup.y, PAL.cup, ace ? 30 : 18, 45, 30);
    fx.addShake(ace ? 5 : 3);
    const d = res.strokes - res.par;
    const label = ace ? 'Hole in one!' : d <= -2 ? 'Eagle!' : d === -1 ? 'Birdie!' : d === 0 ? 'Par' : d === 1 ? 'Bogey' : `+${d}`;
    showToast(label);
    celebrateT = CELEBRATE_MS;
    updateHud();
    syncProgress();
  }
}

function advanceHole(): void {
  if (!game) return;
  game.advance();
  if (game.done) {
    finishRound();
    return;
  }
  resetKbAim();
  updateHud();
  syncProgress();
}

function render(): void {
  if (!ctx || !canvas || !game) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const aimData = computeAim();
  const av: AimView = { active: false, vx: 0, vy: 0, power: 0, path: [] };
  if (aimData && game.canShoot() && !paused) {
    av.active = true;
    av.vx = aimData.vx;
    av.vy = aimData.vy;
    av.power = aimData.power;
    av.path = game.predict(aimData.vx, aimData.vy);
  }
  draw(ctx, view, game, av, fx);
  if (mode === 'race' && lastSnap) updateRaceClock(lastSnap);
}

// ---- finish ----
function finishRound(): void {
  syncProgress();
  if (mode === 'solo') {
    showSoloResults();
  } else {
    selfFinished = true;
    showWaitingOverlay();
    if (lastSnap?.over) showRaceResults(lastSnap);
  }
}

function showSoloResults(): void {
  stopLoop();
  const total = game!.totalStrokes;
  const par = game!.totalPar();
  const prevBest = store.get<number | null>(`best-${playedMode.id}`, null);
  const isNewBest = prevBest == null || total < prevBest;
  if (isNewBest) store.set(`best-${playedMode.id}`, total);
  shell(soloResultsHTML(game!.results, par, isNewBest ? total : prevBest, isNewBest));
  content.querySelector('#r-again')?.addEventListener('click', () => startSolo(courseSeed, playedMode));
  content.querySelector('#r-share')?.addEventListener('click', shareCourse);
  content.querySelector('#r-menu')?.addEventListener('click', showMenu);
}

async function shareCourse(): Promise<void> {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.set('seed', String(courseSeed));
  // The MODE, not a hole count: the course is (seed, holes, tier), and a link
  // carrying only the length would hand the recipient a different course — same
  // number of holes, different fields — which is the one thing "play this exact
  // course" must not do. `holes` is dropped so an older link's stale count
  // cannot outlive the mode we are actually writing.
  url.searchParams.delete('holes');
  url.searchParams.set('mode', playedMode.id);
  const link = url.toString();
  const flashEl = content.querySelector('.share-flash') as HTMLElement | null;
  const shareData = { title: 'Gravity Golf', text: 'Play this exact course!', url: link };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
    await navigator.clipboard.writeText(link);
    if (flashEl) flashEl.textContent = 'Course link copied — send it to a friend!';
  } catch {
    if (flashEl) flashEl.textContent = link;
  }
}

/**
 * The latch lives HERE, not on the caller, because two paths reach this screen:
 * a host snapshot with over=true, and finishRound() when we hole out last. With
 * the flag set only on the snapshot path, both could fire and re-render the
 * results out from under the player mid-click.
 */
function showRaceResults(snap: RaceSnapshot): void {
  if (raceOver) return;
  raceOver = true;
  stopLoop();
  // The race is over but the ROOM lives on — this is the rematch path. Retire
  // the round's NetGame (it detaches its channels) and hand the room back to
  // `rounds`, which will start the next race inside the very same mesh.
  netGame?.destroy();
  netGame = null;
  rounds?.finish();

  const pars = generateCourse(courseSeed, playedMode.holes, playedMode.tier).map((h) => h.par);
  shell(raceResultsHTML(snap.standings, net?.selfId ?? '', pars));
  content.querySelector('#r-share')?.addEventListener('click', shareCourse);
  content.querySelector('#r-menu')?.addEventListener('click', () => showMenu());

  const againBtn = content.querySelector<HTMLButtonElement>('#r-again');
  const status = content.querySelector<HTMLElement>('.again-status');
  const startNow = content.querySelector<HTMLButtonElement>('#r-start-now');

  startNow?.addEventListener('click', () => rounds?.go());
  content.querySelector('#r-lobby')?.addEventListener('click', () => {
    // Back to the lobby WITHOUT leaving the room — the mesh and the roster all
    // survive. From there you can wait, re-ready, or see who is still around,
    // instead of the scorecard being a dead end with only "Back to menu".
    rounds?.unvote();
    showLobby(roomCodeFromUrl() ?? '');
  });

  againBtn?.addEventListener('click', () => {
    // NOT a rejoin. The room and the whole peer mesh stay exactly as they are;
    // this only registers a vote, and the next race starts underneath us once
    // everyone has voted. Leaving and rejoining here is what used to strand
    // both players alone as host — see engine/net.ts.
    if (!rounds) return;
    if (rounds.state().voted) rounds.unvote();
    else rounds.vote();
    paintAgain();
  });

  function paintAgain(): void {
    if (!rounds || !againBtn || !status) return;
    const s = rounds.state();
    againBtn.textContent = s.voted ? 'Ready — waiting…' : 'Play again';
    againBtn.classList.toggle('waiting', s.voted);

    // The host never has to sit and hope: once enough people are in, it can
    // start immediately rather than wait out the countdown.
    if (startNow) startNow.hidden = !s.canStart || s.votes.length === s.present.length;

    const waiting = s.present.length - s.votes.length;
    const secs = s.startsInMs !== null ? Math.ceil(s.startsInMs / 1000) : null;
    if (!s.voted) {
      status.textContent = `${s.votes.length}/${s.present.length} ready for another round`;
    } else if (secs !== null) {
      // Say WHY we are still waiting and when it ends. A bare "waiting…" with no
      // horizon is what made this feel like a hang.
      status.textContent = `Starting in ${secs}s — waiting for ${waiting} more player${
        waiting === 1 ? '' : 's'
      }`;
    } else if (waiting > 0) {
      status.textContent = `Waiting for ${waiting} more player${waiting === 1 ? '' : 's'}…`;
    } else {
      status.textContent = 'Starting…';
    }
  }

  paintAgain();
  const tick = setInterval(() => {
    if (!againBtn || !document.body.contains(againBtn)) {
      clearInterval(tick);
      return;
    }
    paintAgain();
  }, 500);
}

// ---- HUD ----
function updateHud(): void {
  if (!game) return;
  const holeEl = content.querySelector('#hud-hole');
  const parEl = content.querySelector('#hud-par');
  const midEl = content.querySelector('#hud-mid');
  const h = game.current();
  if (holeEl) holeEl.textContent = `Hole ${Math.min(game.holeIndex + 1, playedMode.holes)}/${playedMode.holes}`;
  if (parEl) parEl.textContent = `Par ${h.par}`;
  if (midEl) {
    const throughPar = game.results.reduce((s, r) => s + (r.strokes - r.par), 0);
    midEl.innerHTML = `<span class="hud-strokes">This hole: <b>${game.holeStrokes}</b></span>
      <span class="hud-total">Total ${game.totalStrokes} · ${toParStr(throughPar)}</span>`;
  }
}

function updateRaceStrip(snap: RaceSnapshot): void {
  const strip = content.querySelector('#race-strip') as HTMLElement | null;
  if (!strip) return;
  const rows = snap.standings
    .slice(0, 6)
    .map((s, i) => {
      const me = s.id === net?.selfId;
      const prog = s.done ? '✓' : `${s.hole + 1}`;
      return `<span class="rs-item ${me ? 'me' : ''}">
        <b>${i + 1}.</b> ${esc(s.name.slice(0, 8))} <span class="rs-prog">${prog}</span> <span class="rs-str">${s.strokes}</span>
      </span>`;
    })
    .join('');
  strip.innerHTML = rows;
}

function updateRaceClock(snap: RaceSnapshot): void {
  const midEl = content.querySelector('#hud-mid');
  if (!midEl || !game) return;
  const secs = Math.max(0, Math.ceil(snap.remainingMs / 1000));
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, '0');
  midEl.innerHTML = `<span class="hud-strokes">This hole: <b>${game.holeStrokes}</b></span>
    <span class="hud-total">Total ${game.totalStrokes} · ⏱ ${mm}:${ss}</span>`;
}

// ---- race waiting overlay ----
function showWaitingOverlay(): void {
  const ov = content.querySelector('#goverlay') as HTMLElement | null;
  if (!ov) return;
  ov.hidden = false;
  ov.classList.add('waiting');
  updateWaitingOverlay(lastSnap);
}

function updateWaitingOverlay(snap: RaceSnapshot | null): void {
  const ov = content.querySelector('#goverlay') as HTMLElement | null;
  if (!ov || !ov.classList.contains('waiting')) return;
  const rows = (snap?.standings ?? [])
    .map(
      (s, i) =>
        `<li class="${s.id === net?.selfId ? 'is-self' : ''}">${i + 1}. ${esc(s.name)} — ${s.done ? `${s.strokes} ✓` : `hole ${s.hole + 1}`}</li>`,
    )
    .join('');
  ov.innerHTML = `<div class="overlay-card">
      <h3>You finished! <span class="spinner sm"></span></h3>
      <p>Waiting for the others to hole out…</p>
      <ol class="wait-list">${rows}</ol>
    </div>`;
}

// ---- pause / mute / toast ----
function togglePause(): void {
  // Never while the countdown is running: `paused` is what holds the field, so
  // an early P would hand that player the first stroke before GO.
  if (!game || game.done || selfFinished || countdown) return;
  paused = !paused;
  const ov = content.querySelector('#goverlay') as HTMLElement | null;
  if (!ov) return;
  if (paused) {
    ov.hidden = false;
    ov.classList.remove('waiting');
    ov.innerHTML = `<div class="overlay-card">
        <h3>Paused</h3>
        <div class="menu-actions">
          <button class="btn primary" id="pz-resume">Resume</button>
          ${mode === 'solo' ? '<button class="btn" id="pz-restart">Restart course</button>' : ''}
          <button class="btn ghost" id="pz-menu">Quit to menu</button>
        </div>
      </div>`;
    ov.querySelector('#pz-resume')?.addEventListener('click', togglePause);
    ov.querySelector('#pz-restart')?.addEventListener('click', () => {
      paused = false;
      startSolo(courseSeed, playedMode);
    });
    // showMenu() goes through leaveRoom(), which retires the NetGame and the
    // Rounds BEFORE the Net and awaits the leave. Dropping the Net on its own
    // here left the NetGame's keepalive ticking and broadcasting snapshots into
    // a room we had walked out of.
    ov.querySelector('#pz-menu')?.addEventListener('click', () => {
      paused = false;
      showMenu();
    });
  } else {
    ov.hidden = true;
    ov.innerHTML = '';
  }
}

function toggleMute(): void {
  sfx.setMuted(!sfx.muted());
  store.set('muted', sfx.muted());
  updateMuteBtn();
}
function updateMuteBtn(): void {
  const b = content.querySelector('#hud-mute');
  if (b) b.textContent = sfx.muted() ? '🔇' : '🔊';
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string): void {
  const t = content.querySelector('#toast') as HTMLElement | null;
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => (t.hidden = true), 250);
  }, 1300);
}

// ---- progress sync (race) ----
function syncProgress(): void {
  if (!game || mode !== 'race' || !netGame) return;
  // No local finish timestamp: the host stamps finish order (see game/race.ts).
  netGame.pushProgress({ ...game.progress(), finishOrder: null });
}

// ---- teardown ----
function teardownGame(): void {
  stopLoop();
  window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUpGlobal);
  window.removeEventListener('pointercancel', onPointerUpGlobal);
  paused = false;
  dragging = false;
  dragCur = null;
  fx = new Fx(reduced);
  celebrateT = 0;
  game = null;
  canvas = null;
  ctx = null;
}

// ---- boot ----
function boot(): void {
  const roomParam = roomCodeFromUrl();
  const url = new URL(location.href);
  const seedParam = url.searchParams.get('seed');

  window.addEventListener('beforeunload', () => net?.leave());

  if (roomParam) {
    // Deep-linked invite — go straight to the lobby (consume the link once). We
    // are the guest here, never the host: whoever sent the link already holds it,
    // and it is their mode and their public/private choice that the room plays.
    void openRoom(roomParam, false, false);
    return;
  }
  if (seedParam) {
    // A shared course link. modeOf() validates the id the same way the wire does
    // — a hand-edited ?mode=lol falls back to Classic rather than reaching the
    // generator. `holes` is the pre-mode link format, honoured so links already
    // sent out still open a course of the right length.
    const holesParam = url.searchParams.get('holes');
    const m = url.searchParams.has('mode')
      ? modeOf(url.searchParams.get('mode'))
      : holesParam
        ? { ...modeOf(DEFAULT_MODE), holes: Math.max(3, Math.min(18, parseInt(holesParam, 10) || modeOf(DEFAULT_MODE).holes)) }
        : modeOf(DEFAULT_MODE);
    const seedNum = Number(seedParam);
    startSolo(Number.isFinite(seedNum) && seedParam !== '' ? seedNum : seedParam, m);
    return;
  }
  showMenu();
}

boot();

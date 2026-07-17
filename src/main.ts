/**
 * main.ts — bootstrap & screen routing for Gravity Golf.
 * Owns the canvas, slingshot input, the fixed-timestep loop, and the menu →
 * game → results / lobby flow for solo, async-seed, and live P2P race play.
 */

import './styles/mobile.css';
import './styles/main.css';
import { hardenViewport } from './engine/mobile';
import { createLoop, type Loop } from './engine/loop';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { newSeed } from './engine/rng';
import { createNet, type Net } from './engine/net';
import { createRounds, type Rounds } from './engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  roomCodeFromUrl,
  setRoomInUrl,
} from './engine/lobby';
import { generateCourse, DEFAULT_HOLES } from './game/course';
import { GolfGame } from './game/golf';
import { type Vec } from './game/physics';
import { Fx } from './fx';
import { computeView, screenToWorld, draw, PAL, type View, type AimView } from './render';
import { NetGame } from './net-game';
import type { RoundPlayer } from './engine/rematch';
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
const MAX_DRAG = 46; // world units for full power
const POWER_SCALE = 1.7;
const MIN_DRAG = 2.5; // deadzone
const CELEBRATE_MS = 1.15; // seconds of sink celebration before advancing

// Before anything renders: iOS ignores the viewport meta's user-scalable=no, so
// a double-tap or a pinch will zoom a live course and there is no way back out.
hardenViewport();

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
let lobby: { destroy: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let loop: Loop | null = null;
let fx = new Fx(reduced);

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let view: View = { scale: 1, ox: 0, oy: 0, cw: 1, ch: 1 };
let dpr = 1;

let paused = false;
let celebrateT = 0;
let courseSeed: number | string = 0;
let holeCount = DEFAULT_HOLES;
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
function bestLabel(): string {
  const best = store.get<number | null>(`best-${holeCount}`, null);
  return best != null ? `Best ${holeCount}-hole round: ${best} strokes` : 'No round played yet — go for a low score!';
}

function showMenu(): void {
  void leaveRoom();
  shell(menuHTML(bestLabel(), holeCount));
  content.querySelector('#m-solo')?.addEventListener('click', () => {
    firstGestureUnlock();
    startSolo(newSeed(), holeCount);
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
function startSolo(seed: number | string, holes: number): void {
  mode = 'solo';
  courseSeed = seed;
  holeCount = holes;
  const course = generateCourse(seed, holes);
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
    // Minting the code is the ONLY way to arrive as the host. Typing a friend's
    // code walks into a room they already hold — see openRoom's claimHost.
    onCreate: (code) => void openRoom(code, true),
    onJoin: (code) => void openRoom(code, false),
    onBack: () => showMenu(),
  });
}

/**
 * Join a room ONCE and hold it for as long as the player stays. Every race —
 * the first and every rematch — runs inside this one Net via `rounds`. Nothing
 * here may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string, created: boolean): Promise<void> {
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms).
  // Joining inside that window returns the dying room, so wait it out.
  await roomTeardown;

  // Put the room code in the URL so the invite link carries it.
  setRoomInUrl(code);

  try {
    net = createNet(
      // `created` is the difference between minting this code and walking into
      // someone else's room. Only the minter may host on arrival; a guest waits
      // to hear from the incumbent instead of racing it for the role.
      { appId: APP_ID, roomId: code, claimHost: created },
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
    minPlayers: 2,
    onRound: ({ seed, players, isHost }) => startRace(seed, players, isHost),
  });

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
    minPlayers: 2,
    maxPlayers: 6,
  });
}

// ---- race ----
function startRace(seed: number, roster: RoundPlayer[], _isHost: boolean): void {
  if (!net) return;
  lobby?.destroy();
  lobby = null;
  netGame?.destroy();
  netGame = null;

  // The roster arrives frozen from the host, identical bytes on every peer, so
  // everyone agrees on the field. If we are not in it we joined mid-start —
  // wait for the next race rather than playing a ghost nobody is racing.
  if (!roster.some((p) => p.id === net!.selfId)) {
    showLobby(roomCodeFromUrl() ?? '');
    return;
  }

  mode = 'race';
  courseSeed = seed;
  holeCount = DEFAULT_HOLES;
  raceOver = false;
  selfFinished = false;
  lastSnap = null;
  const course = generateCourse(seed, holeCount);
  game = new GolfGame(course);

  const names: Record<string, string> = {};
  for (const p of roster) names[p.id] = p.name;

  netGame = new NetGame(
    net!,
    { totalHoles: holeCount, timeLimitMs: holeCount * 60000, names },
    {
      onSnapshot: (snap) => onSnapshot(snap),
      onHostPromoted: () => showToast("You're the host now"),
    },
  );

  onHostChangeRoute = (isHost) => netGame?.onHostChange(isHost);
  onPeerLeaveRoute = (id) => netGame?.onPeerLeave(id);
  onPeersRoute = (ids) => netGame?.onRoster(ids);
  netGame.onRoster(net!.peers());
  netGame.start();

  buildGameScreen();
  resetKbAim();
  updateHud();
  syncProgress();
  startLoop();
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
    startSolo(courseSeed, holeCount);
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
  const prevBest = store.get<number | null>(`best-${holeCount}`, null);
  const isNewBest = prevBest == null || total < prevBest;
  if (isNewBest) store.set(`best-${holeCount}`, total);
  shell(soloResultsHTML(game!.results, par, isNewBest ? total : prevBest, isNewBest));
  content.querySelector('#r-again')?.addEventListener('click', () => startSolo(courseSeed, holeCount));
  content.querySelector('#r-share')?.addEventListener('click', shareCourse);
  content.querySelector('#r-menu')?.addEventListener('click', showMenu);
}

async function shareCourse(): Promise<void> {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.set('seed', String(courseSeed));
  url.searchParams.set('holes', String(holeCount));
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

  const pars = generateCourse(courseSeed, holeCount).map((h) => h.par);
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
  if (holeEl) holeEl.textContent = `Hole ${Math.min(game.holeIndex + 1, holeCount)}/${holeCount}`;
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
  if (!game || game.done || selfFinished) return;
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
      startSolo(courseSeed, holeCount);
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
  const holesParam = url.searchParams.get('holes');

  window.addEventListener('beforeunload', () => net?.leave());

  if (roomParam) {
    // Deep-linked invite — go straight to the lobby (consume the link once). We
    // are the guest here, never the host: whoever sent the link already holds it.
    void openRoom(roomParam, false);
    return;
  }
  if (seedParam) {
    const holes = holesParam ? Math.max(3, Math.min(18, parseInt(holesParam, 10) || DEFAULT_HOLES)) : DEFAULT_HOLES;
    const seedNum = Number(seedParam);
    startSolo(Number.isFinite(seedNum) && seedParam !== '' ? seedNum : seedParam, holes);
    return;
  }
  showMenu();
}

boot();

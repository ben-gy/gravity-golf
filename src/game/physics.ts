/**
 * physics.ts — pure gravity-golf simulation. No DOM, no randomness → fully
 * unit-testable. All positions are in a fixed logical field (FIELD_W x FIELD_H)
 * so a course looks identical on every device and in every peer's race.
 *
 * Physics is LOCAL to each peer (each player flies their own ball); only the
 * seeded course must match across peers, so floating-point drift here is fine.
 */

export const FIELD_W = 100;
export const FIELD_H = 160;
export const BALL_R = 1.35;

// Tuned constants (kept named so they're easy to adjust after playtesting).
export const G = 430; // gravity strength
export const DAMP = 0.62; // linear velocity damping per second (space "drag")
export const SOFT_FLOOR = 1.15; // near-field softening (× well radius) — limits orbit capture
export const WATCHDOG_FLIGHT = 4.5; // s of flight before damping ramps hard to force a settle
export const WATCHDOG_DAMP = 5; // extra damping once the watchdog kicks in
export const HARD_STOP = 6.5; // s absolute cap — the ball settles no matter what (kills orbits)
export const STOP_SPEED = 4; // below this (sustained) the ball is at rest
export const STOP_TIME = 0.3; // s the ball must stay slow before it rests
export const SINK_SPEED = 40; // arrive slower than this to drop in the cup
export const CUP_BRAKE = 0.9; // per-step speed retention near the cup (the "green")
export const WALL_E = 0.72; // wall restitution
export const PLANET_E = 0.62; // planet-surface restitution
export const MAX_SPEED = 200; // hard cap so a black-hole slingshot can't explode

export interface Vec {
  x: number;
  y: number;
}

export type WellKind = 'attract' | 'repel' | 'blackhole';

export interface Well {
  x: number;
  y: number;
  r: number;
  mass: number;
  kind: WellKind;
}

export interface Cup {
  x: number;
  y: number;
  r: number;
}

export interface Hole {
  index: number;
  tee: Vec;
  cup: Cup;
  wells: Well[];
  par: number;
}

export type BallState = 'rest' | 'moving' | 'sunk';

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BallState;
  flightTime: number;
  slowTime: number;
  /** Where the current shot was launched from (black-hole reset target). */
  restX: number;
  restY: number;
}

export interface StepEvents {
  bounce?: { x: number; y: number; speed: number };
  sunk?: boolean;
  swallowed?: boolean;
  rested?: boolean;
}

export function makeBall(tee: Vec): Ball {
  return {
    x: tee.x,
    y: tee.y,
    vx: 0,
    vy: 0,
    state: 'rest',
    flightTime: 0,
    slowTime: 0,
    restX: tee.x,
    restY: tee.y,
  };
}

/** Launch the ball with a velocity. The shot origin is remembered for resets. */
export function launch(ball: Ball, vx: number, vy: number): void {
  ball.restX = ball.x;
  ball.restY = ball.y;
  ball.vx = vx;
  ball.vy = vy;
  ball.state = 'moving';
  ball.flightTime = 0;
  ball.slowTime = 0;
}

export function speed(ball: Ball): number {
  return Math.hypot(ball.vx, ball.vy);
}

/** Net gravitational acceleration on a point at (px,py) from all wells + cup. */
export function gravityAt(px: number, py: number, hole: Hole): Vec {
  let ax = 0;
  let ay = 0;
  for (const w of hole.wells) {
    const dx = w.x - px;
    const dy = w.y - py;
    const d2 = dx * dx + dy * dy;
    const d = Math.sqrt(d2) || 0.0001;
    // Clamp near-field so acceleration stays finite (and orbit capture is rare).
    const soft = Math.max(d, w.r * SOFT_FLOOR);
    let a = (G * w.mass) / (soft * soft);
    if (w.kind === 'repel') a = -a * 0.9;
    if (w.kind === 'blackhole') a *= 1.7;
    ax += (dx / d) * a;
    ay += (dy / d) * a;
  }
  // The cup exerts a "lip" pull so near-misses curve in and drop.
  const cdx = hole.cup.x - px;
  const cdy = hole.cup.y - py;
  const cd = Math.hypot(cdx, cdy) || 0.0001;
  if (cd < hole.cup.r * 4.5) {
    const ca = (G * 1.5) / Math.max(cd, hole.cup.r * 0.9) ** 2;
    ax += (cdx / cd) * ca;
    ay += (cdy / cd) * ca;
  }
  return { x: ax, y: ay };
}

function reflect(ball: Ball, nx: number, ny: number, e: number): number {
  const vn = ball.vx * nx + ball.vy * ny;
  ball.vx -= (1 + e) * vn * nx;
  ball.vy -= (1 + e) * vn * ny;
  return Math.abs(vn);
}

/**
 * Advance the ball by exactly `dt` seconds. Mutates `ball`, returns the events
 * that occurred this step (for sound/particles). Deterministic in its inputs.
 */
export function stepBall(ball: Ball, hole: Hole, dt: number): StepEvents {
  const ev: StepEvents = {};
  if (ball.state !== 'moving') return ev;

  // 1. Gravity.
  const g = gravityAt(ball.x, ball.y, hole);
  ball.vx += g.x * dt;
  ball.vy += g.y * dt;

  // 2. Damping (with a watchdog so nothing orbits forever).
  ball.flightTime += dt;
  const damp = ball.flightTime > WATCHDOG_FLIGHT ? WATCHDOG_DAMP : DAMP;
  const f = Math.exp(-damp * dt);
  ball.vx *= f;
  ball.vy *= f;

  // Speed cap.
  const sp0 = Math.hypot(ball.vx, ball.vy);
  if (sp0 > MAX_SPEED) {
    ball.vx = (ball.vx / sp0) * MAX_SPEED;
    ball.vy = (ball.vy / sp0) * MAX_SPEED;
  }

  // 3. Integrate position.
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // 4. Black holes (checked pre-bounce; they have no solid surface).
  for (const w of hole.wells) {
    if (w.kind !== 'blackhole') continue;
    if (Math.hypot(w.x - ball.x, w.y - ball.y) < w.r) {
      ball.x = ball.restX;
      ball.y = ball.restY;
      ball.vx = 0;
      ball.vy = 0;
      ball.state = 'rest';
      ev.swallowed = true;
      return ev;
    }
  }

  // 5. Solid planet collisions.
  for (const w of hole.wells) {
    if (w.kind === 'blackhole') continue;
    const dx = ball.x - w.x;
    const dy = ball.y - w.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    const minD = w.r + BALL_R;
    if (d < minD) {
      const nx = dx / d;
      const ny = dy / d;
      ball.x = w.x + nx * minD;
      ball.y = w.y + ny * minD;
      const bs = reflect(ball, nx, ny, PLANET_E);
      if (!ev.bounce || bs > ev.bounce.speed) ev.bounce = { x: ball.x, y: ball.y, speed: bs };
    }
  }

  // 6. Boundary walls.
  if (ball.x < BALL_R) {
    ball.x = BALL_R;
    const bs = reflect(ball, 1, 0, WALL_E);
    if (!ev.bounce || bs > ev.bounce.speed) ev.bounce = { x: ball.x, y: ball.y, speed: bs };
  } else if (ball.x > FIELD_W - BALL_R) {
    ball.x = FIELD_W - BALL_R;
    const bs = reflect(ball, -1, 0, WALL_E);
    if (!ev.bounce || bs > ev.bounce.speed) ev.bounce = { x: ball.x, y: ball.y, speed: bs };
  }
  if (ball.y < BALL_R) {
    ball.y = BALL_R;
    const bs = reflect(ball, 0, 1, WALL_E);
    if (!ev.bounce || bs > ev.bounce.speed) ev.bounce = { x: ball.x, y: ball.y, speed: bs };
  } else if (ball.y > FIELD_H - BALL_R) {
    ball.y = FIELD_H - BALL_R;
    const bs = reflect(ball, 0, -1, WALL_E);
    if (!ev.bounce || bs > ev.bounce.speed) ev.bounce = { x: ball.x, y: ball.y, speed: bs };
  }

  // 7. Sink check. Near the cup, the "green" brakes the ball so approaches drop.
  const distCup = Math.hypot(hole.cup.x - ball.x, hole.cup.y - ball.y);
  if (distCup < hole.cup.r * 2.4) {
    const brake = CUP_BRAKE + (1 - CUP_BRAKE) * (distCup / (hole.cup.r * 2.4));
    ball.vx *= brake;
    ball.vy *= brake;
  }
  const sp = Math.hypot(ball.vx, ball.vy);
  // Drop in when inside the cup arriving slow enough, OR when the ball loses its
  // momentum right on the lip (so a near-miss settles into the hole, never stuck
  // resting just outside it).
  const inCup = distCup < hole.cup.r && sp <= SINK_SPEED;
  const lipDrop = distCup < hole.cup.r * 1.6 && sp < STOP_SPEED * 1.8;
  if (inCup || lipDrop) {
    ball.x = hole.cup.x;
    ball.y = hole.cup.y;
    ball.vx = 0;
    ball.vy = 0;
    ball.state = 'sunk';
    ev.sunk = true;
    return ev;
  }

  // 8. Rest detection (must stay slow for a short window so it doesn't stop mid-orbit).
  // The HARD_STOP cap guarantees a ball caught orbiting a planet always settles.
  if (sp < STOP_SPEED) {
    ball.slowTime += dt;
    if (ball.slowTime >= STOP_TIME) {
      ball.vx = 0;
      ball.vy = 0;
      ball.state = 'rest';
      ev.rested = true;
    }
  } else if (ball.flightTime >= HARD_STOP) {
    ball.vx = 0;
    ball.vy = 0;
    ball.state = 'rest';
    ev.rested = true;
  } else {
    ball.slowTime = 0;
  }

  return ev;
}

/**
 * Simulate a shot forward from `from` with velocity (vx,vy) and return sampled
 * positions for the aim-preview dots. Stops early on sink/swallow. Pure.
 */
export function predictPath(
  from: Vec,
  vx: number,
  vy: number,
  hole: Hole,
  maxSteps = 240,
  sampleEvery = 4,
): Vec[] {
  const ball = makeBall(from);
  launch(ball, vx, vy);
  const pts: Vec[] = [{ x: ball.x, y: ball.y }];
  const dt = 1 / 60;
  for (let i = 0; i < maxSteps; i++) {
    const ev = stepBall(ball, hole, dt);
    if (i % sampleEvery === 0) pts.push({ x: ball.x, y: ball.y });
    if (ev.sunk || ev.swallowed || ball.state !== 'moving') {
      pts.push({ x: ball.x, y: ball.y });
      break;
    }
  }
  return pts;
}

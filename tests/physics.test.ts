/**
 * Pure physics + per-player game core.
 */
import { describe, expect, it } from 'vitest';
import {
  makeBall,
  launch,
  stepBall,
  gravityAt,
  predictPath,
  speed,
  FIELD_W,
  FIELD_H,
  BALL_R,
  SINK_SPEED,
  type Hole,
} from '../src/game/physics';
import { GolfGame } from '../src/game/golf';

function openHole(over: Partial<Hole> = {}): Hole {
  return {
    index: 0,
    tee: { x: 50, y: 120 },
    cup: { x: 50, y: 24, r: 3.2 },
    wells: [],
    par: 3,
    ...over,
  };
}

describe('ball state machine', () => {
  it('starts at rest, launch makes it move', () => {
    const b = makeBall({ x: 10, y: 10 });
    expect(b.state).toBe('rest');
    launch(b, 5, 0);
    expect(b.state).toBe('moving');
    expect(b.restX).toBe(10);
  });

  it('stepBall is a no-op when the ball is at rest', () => {
    const b = makeBall({ x: 10, y: 10 });
    expect(stepBall(b, openHole(), 1 / 60)).toEqual({});
  });
});

describe('gravity', () => {
  it('attractors pull the ball toward them', () => {
    const hole = openHole({ wells: [{ x: 70, y: 80, r: 8, mass: 64, kind: 'attract' }] });
    const g = gravityAt(50, 80, hole);
    expect(g.x).toBeGreaterThan(0); // pulled to the right, toward the well
    expect(Math.abs(g.y)).toBeLessThan(1e-6);
  });

  it('repulsors push the ball away', () => {
    const hole = openHole({ wells: [{ x: 70, y: 80, r: 8, mass: 64, kind: 'repel' }] });
    const g = gravityAt(50, 80, hole);
    expect(g.x).toBeLessThan(0); // pushed left, away from the well
  });
});

describe('damping', () => {
  it('slows a free-flying ball with no gravity nearby', () => {
    const hole = openHole({ cup: { x: 90, y: 150, r: 3.2 } });
    const b = makeBall({ x: 50, y: 80 });
    launch(b, 40, 0);
    const s0 = speed(b);
    for (let i = 0; i < 10; i++) stepBall(b, hole, 1 / 60);
    expect(speed(b)).toBeLessThan(s0);
  });
});

describe('collisions', () => {
  it('bounces off a wall (reverses velocity component)', () => {
    const b = makeBall({ x: FIELD_W - BALL_R - 0.2, y: 80 });
    launch(b, 60, 0);
    const ev = stepBall(b, openHole(), 1 / 60);
    expect(b.x).toBeLessThanOrEqual(FIELD_W - BALL_R + 1e-6);
    expect(b.vx).toBeLessThan(0);
    expect(ev.bounce).toBeTruthy();
  });

  it('bounces off a solid planet', () => {
    const hole = openHole({ wells: [{ x: 50, y: 70, r: 9, mass: 81, kind: 'attract' }] });
    const b = makeBall({ x: 50, y: 70 + 9 + BALL_R + 0.3 });
    launch(b, 0, -80); // straight into the planet
    const ev = stepBall(b, hole, 1 / 60);
    expect(ev.bounce).toBeTruthy();
    // pushed back outside the surface
    expect(Math.hypot(b.x - 50, b.y - 70)).toBeGreaterThanOrEqual(9 + BALL_R - 1e-6);
  });

  it('black holes swallow the ball and reset it to the shot origin', () => {
    const hole = openHole({ wells: [{ x: 50, y: 80, r: 4, mass: 16, kind: 'blackhole' }] });
    const b = makeBall({ x: 50, y: 86 });
    launch(b, 0, -30);
    let ev = stepBall(b, hole, 1 / 60);
    for (let i = 0; i < 20 && !ev.swallowed; i++) ev = stepBall(b, hole, 1 / 60);
    expect(ev.swallowed).toBe(true);
    expect(b.state).toBe('rest');
    expect(b.x).toBe(50);
    expect(b.y).toBe(86);
  });
});

describe('sinking', () => {
  it('sinks when arriving slow inside the cup', () => {
    const hole = openHole();
    const b = makeBall({ x: hole.cup.x, y: hole.cup.y });
    launch(b, 2, 0); // very slow
    const ev = stepBall(b, hole, 1 / 60);
    expect(ev.sunk).toBe(true);
    expect(b.state).toBe('sunk');
  });

  it('rims out when arriving too fast', () => {
    const hole = openHole();
    const b = makeBall({ x: hole.cup.x - 1, y: hole.cup.y });
    launch(b, SINK_SPEED + 60, 0);
    const ev = stepBall(b, hole, 1 / 60);
    expect(ev.sunk).toBeFalsy();
  });
});

describe('predictPath', () => {
  it('returns a sampled trajectory', () => {
    const path = predictPath({ x: 50, y: 120 }, 0, -60, openHole());
    expect(path.length).toBeGreaterThan(2);
    expect(path[0]).toEqual({ x: 50, y: 120 });
  });
});

describe('GolfGame', () => {
  const course: Hole[] = [
    openHole({ index: 0, cup: { x: 50, y: 30, r: 3.2 } }),
    openHole({ index: 1, cup: { x: 40, y: 30, r: 3.2 } }),
  ];

  it('counts strokes and blocks shooting mid-flight', () => {
    const g = new GolfGame(course);
    expect(g.canShoot()).toBe(true);
    expect(g.shoot(0, -40)).toBe(true);
    expect(g.totalStrokes).toBe(1);
    expect(g.holeStrokes).toBe(1);
    expect(g.canShoot()).toBe(false);
    expect(g.shoot(0, -40)).toBe(false); // can't shoot while moving
  });

  it('records a result and advances through the course to done', () => {
    const g = new GolfGame(course);
    // Hole 0.
    g.shoot(1, 0);
    g.ball.x = g.current().cup.x;
    g.ball.y = g.current().cup.y;
    g.ball.vx = 1;
    g.ball.vy = 0;
    const ev = g.update(1 / 60);
    expect(ev.holeComplete).toBe(true);
    expect(g.results.length).toBe(1);
    expect(g.awaiting()).toBe(true);
    g.advance();
    expect(g.holeIndex).toBe(1);
    expect(g.holeStrokes).toBe(0);
    // Hole 1.
    g.shoot(1, 0);
    g.ball.x = g.current().cup.x;
    g.ball.y = g.current().cup.y;
    g.ball.vx = 0.5;
    g.ball.vy = 0;
    g.update(1 / 60);
    g.advance();
    expect(g.done).toBe(true);
    expect(g.progress().done).toBe(true);
    expect(g.progress().hole).toBe(2);
  });
});

describe('field bounds sanity', () => {
  it('keeps a ball inside the field after many steps', () => {
    const hole = openHole({
      wells: [
        { x: 30, y: 60, r: 9, mass: 81, kind: 'attract' },
        { x: 70, y: 100, r: 8, mass: 64, kind: 'attract' },
      ],
    });
    const b = makeBall({ x: 50, y: 120 });
    launch(b, 55, -70);
    for (let i = 0; i < 600 && b.state === 'moving'; i++) stepBall(b, hole, 1 / 60);
    expect(b.x).toBeGreaterThanOrEqual(-0.5);
    expect(b.x).toBeLessThanOrEqual(FIELD_W + 0.5);
    expect(b.y).toBeGreaterThanOrEqual(-0.5);
    expect(b.y).toBeLessThanOrEqual(FIELD_H + 0.5);
  });
});

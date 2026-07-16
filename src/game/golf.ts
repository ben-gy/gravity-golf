/**
 * golf.ts — the per-player game core: current hole, ball, strokes, results.
 * Framework-agnostic and deterministic given the same course + inputs, so it's
 * unit-testable and shared identically by solo and race play.
 */

import {
  makeBall,
  launch,
  stepBall,
  predictPath,
  type Ball,
  type Hole,
  type StepEvents,
  type Vec,
} from './physics';

export interface HoleResult {
  hole: number;
  par: number;
  strokes: number;
}

export interface Progress {
  /** 0-based index of the hole being played, or holes.length once finished. */
  hole: number;
  strokes: number;
  holeStrokes: number;
  done: boolean;
}

export interface UpdateEvents extends StepEvents {
  holeComplete?: boolean;
}

export class GolfGame {
  readonly course: Hole[];
  holeIndex = 0;
  ball: Ball;
  holeStrokes = 0;
  totalStrokes = 0;
  results: HoleResult[] = [];
  done = false;
  private awaitingAdvance = false;

  constructor(course: Hole[]) {
    if (course.length === 0) throw new Error('course must have at least one hole');
    this.course = course;
    this.ball = makeBall(course[0].tee);
  }

  current(): Hole {
    return this.course[Math.min(this.holeIndex, this.course.length - 1)];
  }

  canShoot(): boolean {
    return !this.done && !this.awaitingAdvance && this.ball.state === 'rest';
  }

  /** Take a shot. Returns true if it was launched. */
  shoot(vx: number, vy: number): boolean {
    if (!this.canShoot()) return false;
    this.holeStrokes++;
    this.totalStrokes++;
    launch(this.ball, vx, vy);
    return true;
  }

  update(dt: number): UpdateEvents {
    const ev = stepBall(this.ball, this.current(), dt) as UpdateEvents;
    if (ev.sunk && !this.awaitingAdvance) {
      const h = this.current();
      this.results.push({ hole: h.index, par: h.par, strokes: this.holeStrokes });
      this.awaitingAdvance = true;
      ev.holeComplete = true;
    }
    return ev;
  }

  /** True while the just-sunk celebration should play, before advancing. */
  awaiting(): boolean {
    return this.awaitingAdvance;
  }

  /** Load the next hole (or finish the course). Call after the sink celebration. */
  advance(): void {
    if (!this.awaitingAdvance) return;
    this.awaitingAdvance = false;
    this.holeIndex++;
    if (this.holeIndex >= this.course.length) {
      this.done = true;
      return;
    }
    this.ball = makeBall(this.course[this.holeIndex].tee);
    this.holeStrokes = 0;
  }

  predict(vx: number, vy: number): Vec[] {
    // Short horizon: show the launch curve, not the whole guaranteed line — the
    // player still has to judge the approach, which keeps sinking skillful.
    return predictPath({ x: this.ball.x, y: this.ball.y }, vx, vy, this.current(), 150, 5);
  }

  progress(): Progress {
    return {
      hole: this.done ? this.course.length : this.holeIndex,
      strokes: this.totalStrokes,
      holeStrokes: this.holeStrokes,
      done: this.done,
    };
  }

  totalPar(): number {
    return this.course.reduce((s, h) => s + h.par, 0);
  }
}

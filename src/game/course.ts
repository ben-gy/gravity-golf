/**
 * course.ts — deterministic course generation. Same seed → identical course on
 * every peer (the one thing a P2P race must agree on), so no player ever starts
 * with an easier board: everyone plays the exact same holes from the same tee.
 *
 * Generation enforces validity invariants (all covered by tests/course.test.ts):
 *  - tee & cup inside the field, comfortably separated
 *  - every well fully inside the field
 *  - no well overlaps the tee's launch clearance or the cup's approach clearance
 *  - no two wells overlap
 * so an unwinnable / trapped hole can't be generated.
 */

import { makeRng, randInt, randFloat, type Rng } from '../engine/rng';
import {
  FIELD_W,
  FIELD_H,
  type Hole,
  type Vec,
  type Well,
  type WellKind,
} from './physics';

export const MARGIN = 11;
export const CUP_R = 4;
const MIN_TEE_CUP = 62;
const TEE_CLEAR = 12; // open space around the tee (plus well radius)
const CUP_CLEAR = 13; // open approach around the cup (plus well radius)
const WELL_GAP = 4; // min gap between two well surfaces

export const DEFAULT_HOLES = 9;
export const MIN_HOLES = 3;
export const MAX_HOLES = 18;

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function randPos(rng: Rng, r: number): Vec {
  return {
    x: randFloat(rng, MARGIN + r, FIELD_W - MARGIN - r),
    y: randFloat(rng, MARGIN + r, FIELD_H - MARGIN - r),
  };
}

function wellRadius(rng: Rng, kind: WellKind): number {
  if (kind === 'blackhole') return randFloat(rng, 3.4, 4.8);
  if (kind === 'repel') return randFloat(rng, 5, 7.5);
  return randFloat(rng, 6, 10.5);
}

function chooseKind(rng: Rng, index: number): WellKind {
  const r = rng();
  // Black holes appear from hole 3; repulsors from hole 5. Attractors dominate.
  const blackChance = index >= 2 ? Math.min(0.06 + index * 0.03, 0.28) : 0;
  const repelChance = index >= 4 ? 0.16 : 0;
  if (r < blackChance) return 'blackhole';
  if (r < blackChance + repelChance) return 'repel';
  return 'attract';
}

function fits(pos: Vec, r: number, tee: Vec, cup: Vec, wells: Well[]): boolean {
  if (dist(pos, tee) < r + TEE_CLEAR) return false;
  if (dist(pos, cup) < r + CUP_CLEAR + CUP_R) return false;
  for (const w of wells) {
    if (dist(pos, w) < r + w.r + WELL_GAP) return false;
  }
  return true;
}

function computePar(tee: Vec, cup: Vec, wells: Well[]): number {
  const d = dist(tee, cup);
  let par = 2 + Math.round(d / 58);
  // Wells near the tee→cup line make the hole harder.
  const midX = (tee.x + cup.x) / 2;
  const midY = (tee.y + cup.y) / 2;
  let hazardous = 0;
  for (const w of wells) {
    if (Math.hypot(w.x - midX, w.y - midY) < d * 0.5 + w.r) {
      hazardous += w.kind === 'blackhole' ? 1 : 0.5;
    }
  }
  par += Math.min(2, Math.round(hazardous));
  return Math.max(2, Math.min(5, par));
}

/** Generate a single hole deterministically from (seed, index). */
export function generateHole(seed: number | string, index: number): Hole {
  const rng = makeRng(`${seed}:${index}`);

  // Tee & cup: reject until they're far enough apart.
  let tee = randPos(rng, 0);
  let cup = randPos(rng, CUP_R);
  for (let i = 0; i < 240 && dist(tee, cup) < MIN_TEE_CUP; i++) {
    tee = randPos(rng, 0);
    cup = randPos(rng, CUP_R);
  }

  const target = Math.max(1, Math.min(4, 1 + Math.floor(index / 3) + randInt(rng, 0, 1)));
  const wells: Well[] = [];
  for (let attempt = 0; attempt < target * 60 && wells.length < target; attempt++) {
    const kind = chooseKind(rng, index);
    const r = wellRadius(rng, kind);
    const pos = randPos(rng, r);
    if (!fits(pos, r, tee, cup, wells)) continue;
    // Softened mass keeps gravity legible & shots steerable in the narrow field.
    wells.push({ x: pos.x, y: pos.y, r, mass: r * r * 0.62, kind });
  }

  return {
    index,
    tee,
    cup: { x: cup.x, y: cup.y, r: CUP_R },
    wells,
    par: computePar(tee, cup, wells),
  };
}

/** Generate a full course. Same seed + count → identical holes on every peer. */
export function generateCourse(seed: number | string, holeCount = DEFAULT_HOLES): Hole[] {
  const n = Math.max(MIN_HOLES, Math.min(MAX_HOLES, holeCount));
  const holes: Hole[] = [];
  for (let i = 0; i < n; i++) holes.push(generateHole(seed, i));
  return holes;
}

/** Total par for the whole course (for scorecards). */
export function coursePar(holes: Hole[]): number {
  return holes.reduce((sum, h) => sum + h.par, 0);
}

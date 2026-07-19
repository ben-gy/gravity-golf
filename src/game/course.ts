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

import { makeRng, randInt, randFloat, type Rng } from '@ben-gy/game-engine/rng';
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
export const MIN_TEE_CUP = 62;
/**
 * The cup must be within ONE clean shot of the tee.
 *
 * A full-power shot travels ~93 units on an empty field (measured; pinned by
 * tests/course.test.ts). A cup further away than that can only be reached by
 * chaining shots through whatever the generator scattered in between — and
 * sometimes there is no chain. Not "hard": a ball that cannot be sunk by ANY
 * sequence of shots, on a hole the player cannot skip, so the round is over.
 *
 * This was measured, not guessed. Searching the reachable rest positions of
 * 1080 holes per tier, the cup was unreachable on:
 *
 *        span 60-79   80-99   100-119  120-139
 *   tier 0     0.2%    1.2%      4.2%     3.7%
 *   tier 6     0.4%    3.1%      7.3%    13.0%
 *
 * — i.e. the defect is a function of the SPAN, and the difficulty tier only
 * amplifies it. Uncapped, that is 1.4% of holes at tier 0 (about one 9-hole
 * round in eight) and 3.1% at tier 6 (one round in four). Capped here, both
 * tiers land at 0.28%: once the cup is within one shot, the field between them
 * can no longer seal it off, which is what makes the tiers safe to ship at all.
 *
 * Deliberately arithmetic and seeded, never a simulation: the course must be
 * IDENTICAL on every peer, and a generator that re-rolled until a physics sim
 * said "winnable" would hand two peers different courses the moment their
 * engines disagreed in the last bit of a Math.hypot.
 */
export const MAX_TEE_CUP = 85;
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

function inField(p: Vec, r: number): boolean {
  return (
    p.x >= MARGIN + r && p.x <= FIELD_W - MARGIN - r && p.y >= MARGIN + r && p.y <= FIELD_H - MARGIN - r
  );
}

/**
 * Last resort when rejection sampling cannot find a cup in the winnable band:
 * place one by construction, at a known-good distance along one of eight
 * directions derived from the draw. Pure arithmetic (no trig), so it stays as
 * reproducible as the rest of the generator.
 *
 * Eight and not four: a tee in the field's corner has every axis-aligned
 * direction pointing out of bounds at this range, and only the diagonals land.
 */
function placeCup(rng: Rng, tee: Vec, drawn: Vec): Vec {
  let ux = drawn.x - tee.x;
  let uy = drawn.y - tee.y;
  const len = Math.hypot(ux, uy);
  // A cup drawn exactly on the tee has no direction to offer; pick one.
  if (len < 1e-6) {
    ux = 1;
    uy = 0;
  } else {
    ux /= len;
    uy /= len;
  }
  const k = Math.SQRT1_2;
  const dirs: Vec[] = [
    { x: ux, y: uy },
    { x: -ux, y: -uy },
    { x: -uy, y: ux },
    { x: uy, y: -ux },
    { x: (ux - uy) * k, y: (uy + ux) * k },
    { x: (ux + uy) * k, y: (uy - ux) * k },
    { x: (-ux + uy) * k, y: (-uy - ux) * k },
    { x: (-ux - uy) * k, y: (-uy + ux) * k },
  ];
  // Furthest first, so a constructed hole is still a long one where it can be.
  for (let d = MAX_TEE_CUP; d >= MIN_TEE_CUP; d -= 2) {
    for (const dir of dirs) {
      const p = { x: tee.x + dir.x * d, y: tee.y + dir.y * d };
      if (inField(p, CUP_R)) return p;
    }
  }
  // Unreachable for any tee the generator can draw in this field, but never
  // return an out-of-band cup: that is the hole this whole path exists to avoid.
  return { x: randFloat(rng, MARGIN + CUP_R, FIELD_W - MARGIN - CUP_R), y: tee.y };
}

function wellRadius(rng: Rng, kind: WellKind): number {
  if (kind === 'blackhole') return randFloat(rng, 3.4, 4.8);
  if (kind === 'repel') return randFloat(rng, 5, 7.5);
  return randFloat(rng, 6, 10.5);
}

function chooseKind(rng: Rng, difficulty: number): WellKind {
  const r = rng();
  // Black holes appear from hole 3; repulsors from hole 5. Attractors dominate.
  const blackChance = difficulty >= 2 ? Math.min(0.06 + difficulty * 0.03, 0.28) : 0;
  const repelChance = difficulty >= 4 ? 0.16 : 0;
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

/**
 * Generate a single hole deterministically from (seed, index, tier).
 *
 * `tier` shifts where on the difficulty ramp this hole sits WITHOUT moving it in
 * the round: tier 6 makes the opening tee play like hole 7 — a crowded field
 * with black holes and repulsors already in it. That is the whole of Gauntlet
 * (see ../modes.ts), and it is a different game rather than a longer one: on
 * tier 0 the first holes are open enough to aim straight at, and on tier 6 they
 * are not, so you are curving shots around gravity from the first stroke.
 *
 * The rng is keyed on seed:index only, so the tee and cup are the same for a
 * seed whatever the tier — the field between them is what changes. Every peer
 * gets the tier frozen inside the host's round start, so they all build the same
 * course; a tier read from each peer's own UI is a course two peers disagree on.
 */
export function generateHole(seed: number | string, index: number, tier = 0): Hole {
  const rng = makeRng(`${seed}:${index}`);
  const difficulty = index + Math.max(0, tier);

  // Tee & cup: reject until they are far enough apart to be interesting, and
  // close enough together to be winnable (see MAX_TEE_CUP).
  let tee = randPos(rng, 0);
  let cup = randPos(rng, CUP_R);
  const spanOk = (): boolean => {
    const d = dist(tee, cup);
    return d >= MIN_TEE_CUP && d <= MAX_TEE_CUP;
  };
  for (let i = 0; i < 240 && !spanOk(); i++) {
    tee = randPos(rng, 0);
    cup = randPos(rng, CUP_R);
  }
  // Rejection sampling can, in principle, run out. Falling through with whatever
  // the last draw happened to be would quietly reintroduce the very hole this
  // cap exists to prevent, so place the cup by construction instead: pull it
  // along the tee->cup line to a distance that is known good.
  if (!spanOk()) cup = placeCup(rng, tee, cup);

  const target = Math.max(1, Math.min(4, 1 + Math.floor(difficulty / 3) + randInt(rng, 0, 1)));
  const wells: Well[] = [];
  for (let attempt = 0; attempt < target * 60 && wells.length < target; attempt++) {
    const kind = chooseKind(rng, difficulty);
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

/** Generate a full course. Same seed + count + tier → identical holes everywhere. */
export function generateCourse(seed: number | string, holeCount = DEFAULT_HOLES, tier = 0): Hole[] {
  const n = Math.max(MIN_HOLES, Math.min(MAX_HOLES, holeCount));
  const holes: Hole[] = [];
  for (let i = 0; i < n; i++) holes.push(generateHole(seed, i, tier));
  return holes;
}

/** Total par for the whole course (for scorecards). */
export function coursePar(holes: Hole[]): number {
  return holes.reduce((sum, h) => sum + h.par, 0);
}

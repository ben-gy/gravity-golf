/**
 * modes.ts — the shapes a round can take.
 *
 * Two knobs, and only one of them is a number you could shrug at. `holes` is how
 * long the round is; `tier` is where on the difficulty ramp it STARTS.
 *
 * The ramp is the whole point. course.ts seeds a hole from its index: black
 * holes only appear from the third hole, repulsors from the fifth, and the well
 * count climbs with the index. So a 3-hole round is not "a 9-hole round, cut
 * short" — it is the open, uncluttered end of the ramp, and measurably so: over
 * 40 seeds, Sprint holes average 1.43 wells with 0.07 black holes and exactly
 * zero repulsors, against Classic's 2.47 / 0.55 / 0.23. Sprint is aiming;
 * Gauntlet, which starts six rungs up the ramp, is 3.81 wells with 1.20 black
 * holes a hole, and you are bending shots around gravity off the first tee.
 * Tier 9 was measured too and cut: it saturates at 4.00 wells and plays the same
 * as tier 6, which is exactly the "two modes that feel the same" the brief warns
 * about.
 *
 * The host picks; the choice travels frozen inside the round start (see
 * engine/rematch.ts), so every peer builds the identical course and races the
 * same clock. A mode each peer read from its own UI is a mode two peers can
 * disagree about — and here that means two different courses.
 */

export interface Mode {
  id: ModeId;
  name: string;
  /** How many holes. course.ts clamps to MIN_HOLES..MAX_HOLES regardless. */
  holes: number;
  /**
   * Difficulty-ramp offset. Hole N is generated as if it were hole N+tier, so a
   * tier of 6 opens on a field that Classic would not reach until its seventh.
   */
  tier: number;
  /** Race clock allowance per hole. Harder fields cost strokes, so cost time. */
  msPerHole: number;
  /** One line, shown under the name — say what it FEELS like, not the numbers. */
  blurb: string;
}

export type ModeId = 'sprint' | 'classic' | 'gauntlet';

export const MODES: Record<ModeId, Mode> = {
  sprint: {
    id: 'sprint',
    name: 'Sprint',
    holes: 3,
    tier: 0,
    msPerHole: 60_000,
    blurb: 'Three open holes, no black holes. Pure aim — in and out.',
  },
  classic: {
    id: 'classic',
    name: 'Classic',
    holes: 9,
    tier: 0,
    msPerHole: 60_000,
    blurb: 'The full round. It gets crowded around the turn.',
  },
  gauntlet: {
    id: 'gauntlet',
    name: 'Gauntlet',
    holes: 9,
    tier: 6,
    msPerHole: 75_000,
    blurb: 'Nine holes that all play like the back nine. Curve everything.',
  },
};

export const DEFAULT_MODE: ModeId = 'classic';

export const MODE_LIST: Mode[] = [MODES.sprint, MODES.classic, MODES.gauntlet];

/**
 * Resolve a mode id that arrived over the wire, out of a URL, or out of storage.
 *
 * Never trust it: an older peer, a corrupted store or a hand-edited message
 * would otherwise hand `undefined` to generateCourse and produce a course of
 * length NaN — which is not a crash, it is a GolfGame constructed on an empty
 * array. Falling back keeps a mismatched peer playing Classic instead.
 *
 * hasOwn, NOT a plain `MODES[id] || …`: MODES is an object literal, so it
 * inherits from Object.prototype and `MODES['constructor']` is the Object
 * function — truthy, so it sails through the guard and gets returned AS a Mode
 * with every field undefined. That is the exact empty course this function
 * exists to prevent, reached by the one input it exists to distrust. Same for
 * 'toString', 'valueOf' and friends. Pinned by tests/modes.test.ts.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id as ModeId];
  return MODES[DEFAULT_MODE];
}

/** The race clock for a mode. Host-authoritative, but derived identically. */
export function timeLimitMs(m: Mode): number {
  return m.holes * m.msPerHole;
}

/**
 * race.ts — host-authoritative race state for live P2P play, deliberately free
 * of any network or DOM so it's fully unit-testable (see tests/race.test.ts).
 *
 * Model: every peer plays its own ball (GolfGame) and broadcasts its `progress`
 * on channel 'prog'. EVERY peer folds incoming progress into its own `progress`
 * map, so any peer is ready to take over. The host additionally owns the round
 * clock and broadcasts a `snap` (standings + remaining + over). On host loss,
 * net.ts re-elects and the survivor calls setHost(true): it already holds the
 * standings + last remaining clock, resumes ticking, and can still end the round
 * — the game never freezes and can always finish.
 */

export interface PeerProgress {
  hole: number;
  strokes: number;
  holeStrokes: number;
  done: boolean;
  finishedAt: number | null;
}

export interface RaceStanding extends PeerProgress {
  id: string;
  name: string;
  connected: boolean;
}

export interface RaceSnapshot {
  standings: RaceStanding[];
  remainingMs: number;
  over: boolean;
  totalHoles: number;
}

export interface RaceConfig {
  selfId: string;
  isHost: boolean;
  totalHoles: number;
  timeLimitMs: number;
  names?: Record<string, string>;
}

export function emptyProgress(): PeerProgress {
  return { hole: 0, strokes: 0, holeStrokes: 0, done: false, finishedAt: null };
}

/** Ranking order: done-first, then further/fewer strokes, then earlier finish. */
export function compareStandings(a: PeerProgress, b: PeerProgress): number {
  if (a.done !== b.done) return a.done ? -1 : 1;
  if (a.done && b.done) {
    if (a.strokes !== b.strokes) return a.strokes - b.strokes;
    return (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity);
  }
  // Neither done: further through the course wins, then fewer strokes.
  if (a.hole !== b.hole) return b.hole - a.hole;
  return a.strokes - b.strokes;
}

export class RaceSession {
  readonly selfId: string;
  private hostFlag: boolean;
  readonly totalHoles: number;
  private progress = new Map<string, PeerProgress>();
  private names = new Map<string, string>();
  private connected = new Set<string>();
  remainingMs: number;
  over = false;

  constructor(cfg: RaceConfig) {
    this.selfId = cfg.selfId;
    this.hostFlag = cfg.isHost;
    this.totalHoles = cfg.totalHoles;
    this.remainingMs = cfg.timeLimitMs;
    this.progress.set(cfg.selfId, emptyProgress());
    this.connected.add(cfg.selfId);
    for (const [id, name] of Object.entries(cfg.names ?? {})) this.names.set(id, name);
  }

  isHost(): boolean {
    return this.hostFlag;
  }

  setName(id: string, name: string): void {
    this.names.set(id, name);
  }

  /** Update the set of currently-connected peers (self always included). */
  setRoster(ids: string[]): void {
    this.connected = new Set([this.selfId, ...ids]);
    for (const id of this.connected) {
      if (!this.progress.has(id)) this.progress.set(id, emptyProgress());
    }
  }

  /** Record another peer's (or our own) progress. */
  applyProgress(id: string, p: PeerProgress): void {
    this.progress.set(id, { ...p });
    this.connected.add(id);
  }

  setSelfProgress(p: PeerProgress): void {
    this.progress.set(this.selfId, { ...p });
  }

  onPeerLeave(id: string): void {
    this.connected.delete(id);
    // Keep their last progress for final ranking, but stop waiting on them.
  }

  /** Promote/demote this peer. On promotion it keeps its accumulated state. */
  setHost(isHost: boolean): void {
    this.hostFlag = isHost;
    if (isHost && this.everyoneDone()) this.over = true;
  }

  private everyoneDone(): boolean {
    const live = [...this.connected];
    if (live.length === 0) return false;
    return live.every((id) => this.progress.get(id)?.done === true);
  }

  /** HOST ONLY: advance the round clock. No-op for clients. */
  tick(dtMs: number): void {
    if (!this.hostFlag || this.over) return;
    this.remainingMs = Math.max(0, this.remainingMs - dtMs);
    if (this.remainingMs <= 0 || this.everyoneDone()) this.over = true;
  }

  /** CLIENT: adopt a host snapshot (also keeps us ready to take over). */
  applySnapshot(snap: RaceSnapshot): void {
    for (const s of snap.standings) {
      this.progress.set(s.id, {
        hole: s.hole,
        strokes: s.strokes,
        holeStrokes: s.holeStrokes,
        done: s.done,
        finishedAt: s.finishedAt,
      });
      if (s.name) this.names.set(s.id, s.name);
    }
    if (!this.hostFlag) {
      this.remainingMs = snap.remainingMs;
      this.over = snap.over;
    }
  }

  standings(): RaceStanding[] {
    const rows: RaceStanding[] = [];
    for (const [id, p] of this.progress) {
      rows.push({
        id,
        name: this.names.get(id) ?? 'Player',
        connected: this.connected.has(id),
        ...p,
      });
    }
    rows.sort(compareStandings);
    return rows;
  }

  snapshot(): RaceSnapshot {
    return {
      standings: this.standings(),
      remainingMs: this.remainingMs,
      over: this.over,
      totalHoles: this.totalHoles,
    };
  }
}

/** Compact wire form for the 'prog' channel (kept tiny). */
export interface ProgWire {
  h: number;
  s: number;
  hs: number;
  d: 0 | 1;
  f: number | null;
}

export function encodeProgress(p: PeerProgress): ProgWire {
  return { h: p.hole, s: p.strokes, hs: p.holeStrokes, d: p.done ? 1 : 0, f: p.finishedAt };
}

export function decodeProgress(w: ProgWire): PeerProgress {
  return { hole: w.h, strokes: w.s, holeStrokes: w.hs, done: w.d === 1, finishedAt: w.f };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * net-game.ts — glue between the P2P net and the race core.
 *
 * Each peer broadcasts its own `progress` on 'prog'; every peer folds incoming
 * progress into its RaceSession so it's ready to take over. The host runs a
 * ~300ms setInterval keepalive that ticks the round clock (survives a
 * backgrounded tab — rAF would not) and broadcasts a 'snap'. On host loss the
 * survivor's onHostChange promotes it: it already holds the standings + clock,
 * resumes the keepalive, and can still end the round.
 *
 * There is exactly ONE answer to "who is host": engine/net.ts. The RaceSession
 * carries its own hostFlag only so the race core stays testable without a Net —
 * it is seeded from net.isHost() and thereafter moved ONLY by net's onHostChange,
 * never re-derived here. That matters now that net.ts elects by incumbency: a
 * mid-race joiner with a lower peer id no longer wins anything, so this must not
 * quietly hold a second opinion and hand it authority.
 */

import type { Net } from '@ben-gy/game-engine/net';
import {
  RaceSession,
  encodeProgress,
  decodeProgress,
  type PeerProgress,
  type ProgWire,
  type RaceSnapshot,
} from './game/race';

export interface NetGameCallbacks {
  onSnapshot: (snap: RaceSnapshot) => void;
  onHostPromoted: () => void;
}

export class NetGame {
  readonly net: Net;
  readonly session: RaceSession;
  private cb: NetGameCallbacks;
  private sendProg: ((w: ProgWire) => void) & { off: () => void };
  private sendSnap: ((s: RaceSnapshot) => void) & { off: () => void };
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private started = false;

  constructor(
    net: Net,
    cfg: { totalHoles: number; timeLimitMs: number; names: Record<string, string> },
    cb: NetGameCallbacks,
  ) {
    this.net = net;
    this.cb = cb;
    this.session = new RaceSession({
      selfId: net.selfId,
      isHost: net.isHost(),
      totalHoles: cfg.totalHoles,
      timeLimitMs: cfg.timeLimitMs,
      names: cfg.names,
    });
    this.session.setRoster(net.peers());

    this.sendProg = net.channel<ProgWire>('prog', (w, from) => {
      this.session.applyProgress(from, decodeProgress(w));
    });
    this.sendSnap = net.channel<RaceSnapshot>('snap', (snap) => {
      if (!this.session.isHost()) {
        this.session.applySnapshot(snap);
        this.cb.onSnapshot(snap);
      }
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.session.isHost()) this.startKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepalive != null) return;
    this.lastTick = performance.now();
    this.keepalive = setInterval(() => {
      const now = performance.now();
      const dt = now - this.lastTick;
      this.lastTick = now;
      this.session.tick(dt);
      const snap = this.session.snapshot();
      this.sendSnap(snap);
      this.cb.onSnapshot(snap);
    }, 300);
  }

  private stopKeepalive(): void {
    if (this.keepalive != null) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  /** Broadcast our latest progress (call whenever it changes). */
  pushProgress(p: PeerProgress): void {
    this.session.setSelfProgress(p);
    this.sendProg(encodeProgress(p));
  }

  // ---- routed from net handlers in main.ts ----

  onHostChange(isHost: boolean): void {
    const was = this.session.isHost();
    this.session.setHost(isHost);
    if (isHost && !was) {
      // Promoted: adopt our accumulated standings + clock and resume the round.
      this.startKeepalive();
      this.cb.onHostPromoted();
    } else if (!isHost && was) {
      this.stopKeepalive();
    }
  }

  onRoster(ids: string[]): void {
    this.session.setRoster(ids);
  }

  onPeerLeave(id: string): void {
    this.session.onPeerLeave(id);
  }

  destroy(): void {
    this.stopKeepalive();
    // The Net now outlives each race (rematches run inside the same room) and
    // channel() fans out to every receiver, so a finished NetGame that stays
    // subscribed would keep folding the NEXT race's 'prog' into its dead
    // RaceSession — and, if it was the host, broadcast snapshots of a finished
    // race over the live one. Detach with the round that owns them.
    this.sendProg.off();
    this.sendSnap.off();
  }
}

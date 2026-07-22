// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * render.ts — Canvas 2D rendering of the gravity-golf world. Draws in CSS-pixel
 * space (main.ts applies the devicePixelRatio transform before calling draw).
 */

import { FIELD_W, FIELD_H, BALL_R, type Vec } from './game/physics';
import type { GolfGame } from './game/golf';
import type { Fx } from './fx';
import { makeRng } from '@ben-gy/game-engine/rng';

export const PAL = {
  bg0: '#0a0e1a',
  bg1: '#151d34',
  wall: '#31456e',
  play: 'rgba(20,28,50,0.55)',
  ball: '#eaf6ff',
  ballGlow: '#4dd0ff',
  attract: '#ff9f45',
  attractCore: '#ffd7a6',
  repel: '#9aa7bf',
  repelCore: '#dbe2f0',
  blackCore: '#050208',
  blackRing: '#b061ff',
  cup: '#35d07f',
  cupDark: '#0c3a24',
  aimLo: '#35d07f',
  aimMid: '#ffd23f',
  aimHi: '#ff5d73',
  tee: '#4a5b86',
  star: '#9fb4e6',
};

export interface View {
  scale: number;
  ox: number;
  oy: number;
  cw: number;
  ch: number;
}

export function computeView(cw: number, ch: number): View {
  const scale = Math.min(cw / FIELD_W, ch / FIELD_H);
  return { scale, ox: (cw - FIELD_W * scale) / 2, oy: (ch - FIELD_H * scale) / 2, cw, ch };
}

export function screenToWorld(v: View, sx: number, sy: number): Vec {
  return { x: (sx - v.ox) / v.scale, y: (sy - v.oy) / v.scale };
}

export interface AimView {
  active: boolean;
  vx: number;
  vy: number;
  power: number; // 0..1
  path: Vec[];
}

// Fixed starfield (normalized coords), generated once — purely decorative.
const STARS = (() => {
  const rng = makeRng(20260716);
  return Array.from({ length: 90 }, () => ({
    x: rng(),
    y: rng(),
    r: 0.4 + rng() * 1.3,
    tw: rng() * Math.PI * 2,
  }));
})();

export function draw(
  ctx: CanvasRenderingContext2D,
  v: View,
  game: GolfGame,
  aim: AimView,
  fx: Fx,
): void {
  const { scale, ox, oy, cw, ch } = v;
  const wx = (x: number) => ox + x * scale;
  const wy = (y: number) => oy + y * scale;
  const wr = (r: number) => r * scale;
  const t = fx.time();

  // Background.
  const bg = ctx.createLinearGradient(0, 0, 0, ch);
  bg.addColorStop(0, PAL.bg1);
  bg.addColorStop(1, PAL.bg0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, ch);

  // Stars.
  for (const s of STARS) {
    const a = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.5 + s.tw));
    ctx.globalAlpha = a;
    ctx.fillStyle = PAL.star;
    ctx.beginPath();
    ctx.arc(s.x * cw, s.y * ch, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.translate(fx.shakeX, fx.shakeY);

  // Play field.
  roundRect(ctx, wx(0), wy(0), FIELD_W * scale, FIELD_H * scale, 10);
  ctx.fillStyle = PAL.play;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = PAL.wall;
  ctx.stroke();

  const hole = game.current();

  // Wells.
  for (const w of hole.wells) {
    const cxs = wx(w.x);
    const cys = wy(w.y);
    const rs = wr(w.r);
    if (w.kind === 'blackhole') {
      // Accretion ring.
      ctx.save();
      ctx.translate(cxs, cys);
      ctx.rotate(t * 1.3);
      const grad = ctx.createRadialGradient(0, 0, rs * 0.6, 0, 0, rs * 2.1);
      grad.addColorStop(0, 'rgba(176,97,255,0.0)');
      grad.addColorStop(0.55, 'rgba(176,97,255,0.55)');
      grad.addColorStop(1, 'rgba(176,97,255,0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, rs * 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = PAL.blackRing;
      ctx.lineWidth = 2;
      ctx.setLineDash([rs * 0.5, rs * 0.4]);
      ctx.beginPath();
      ctx.arc(0, 0, rs * 1.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // Core.
      ctx.fillStyle = PAL.blackCore;
      ctx.beginPath();
      ctx.arc(cxs, cys, rs, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(176,97,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (w.kind === 'repel') {
      const grad = ctx.createRadialGradient(cxs - rs * 0.3, cys - rs * 0.3, rs * 0.2, cxs, cys, rs);
      grad.addColorStop(0, PAL.repelCore);
      grad.addColorStop(1, PAL.repel);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cxs, cys, rs, 0, Math.PI * 2);
      ctx.fill();
      // Outward chevrons.
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const bx = cxs + Math.cos(a) * rs * 1.15;
        const by = cys + Math.sin(a) * rs * 1.15;
        const ox2 = Math.cos(a);
        const oy2 = Math.sin(a);
        const px = -oy2;
        const py = ox2;
        ctx.beginPath();
        ctx.moveTo(bx + px * rs * 0.28, by + py * rs * 0.28);
        ctx.lineTo(bx + ox2 * rs * 0.34, by + oy2 * rs * 0.34);
        ctx.lineTo(bx - px * rs * 0.28, by - py * rs * 0.28);
        ctx.stroke();
      }
    } else {
      // Attractor aura.
      const aura = ctx.createRadialGradient(cxs, cys, rs, cxs, cys, rs * 2.3);
      aura.addColorStop(0, 'rgba(255,159,69,0.28)');
      aura.addColorStop(1, 'rgba(255,159,69,0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(cxs, cys, rs * 2.3, 0, Math.PI * 2);
      ctx.fill();
      const pulse = 1 + 0.03 * Math.sin(t * 2 + w.x);
      const grad = ctx.createRadialGradient(
        cxs - rs * 0.35,
        cys - rs * 0.35,
        rs * 0.2,
        cxs,
        cys,
        rs * pulse,
      );
      grad.addColorStop(0, PAL.attractCore);
      grad.addColorStop(1, PAL.attract);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cxs, cys, rs * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Cup + flag.
  const cx = wx(hole.cup.x);
  const cy = wy(hole.cup.y);
  const cr = wr(hole.cup.r);
  ctx.fillStyle = PAL.cupDark;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PAL.cup;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.stroke();
  // Flag.
  const poleTop = cy - cr - 22 * (scale / 4 > 1 ? 1 : 1);
  const poleH = Math.max(16, cr * 5);
  ctx.strokeStyle = '#cfe';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - poleH);
  ctx.stroke();
  const wave = Math.sin(t * 4) * (poleH * 0.06);
  ctx.fillStyle = PAL.cup;
  ctx.beginPath();
  ctx.moveTo(cx, cy - poleH);
  ctx.lineTo(cx + poleH * 0.42, cy - poleH + poleH * 0.14 + wave);
  ctx.lineTo(cx, cy - poleH + poleH * 0.28);
  ctx.closePath();
  ctx.fill();
  void poleTop;

  // Tee ring (where this hole's shots start).
  ctx.strokeStyle = PAL.tee;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(wx(hole.tee.x), wy(hole.tee.y), wr(BALL_R + 1.4), 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const ball = game.ball;

  // Aim preview.
  if (aim.active && game.canShoot()) {
    // Predicted path dots.
    const path = aim.path;
    for (let i = 1; i < path.length; i++) {
      const fade = 1 - i / path.length;
      ctx.globalAlpha = 0.15 + fade * 0.55;
      ctx.fillStyle = '#dff1ff';
      ctx.beginPath();
      ctx.arc(wx(path[i].x), wy(path[i].y), Math.max(1.2, wr(0.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Slingshot band from pull-back handle to ball.
    const handleX = ball.x - aim.vx * 0.16;
    const handleY = ball.y - aim.vy * 0.16;
    const col = aim.power < 0.5 ? PAL.aimLo : aim.power < 0.82 ? PAL.aimMid : PAL.aimHi;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(wx(handleX), wy(handleY));
    ctx.lineTo(wx(ball.x), wy(ball.y));
    ctx.stroke();
    // Power ring around ball.
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(wx(ball.x), wy(ball.y), wr(BALL_R + 2.2), -Math.PI / 2, -Math.PI / 2 + aim.power * Math.PI * 2);
    ctx.stroke();
  }

  // Particles (behind ball for trail glow).
  for (const p of fx.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(wx(p.x), wy(p.y), Math.max(0.8, wr(p.size)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Ball with glow.
  if (ball.state !== 'sunk' || game.awaiting()) {
    const bx = wx(ball.x);
    const by = wy(ball.y);
    const br = wr(BALL_R);
    const glow = ctx.createRadialGradient(bx, by, br * 0.4, bx, by, br * 3);
    glow.addColorStop(0, 'rgba(77,208,255,0.5)');
    glow.addColorStop(1, 'rgba(77,208,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(bx, by, br * 3, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(bx - br * 0.4, by - br * 0.4, br * 0.2, bx, by, br);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, PAL.ball);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

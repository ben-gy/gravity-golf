/**
 * fx.ts — lightweight juice: particles, a comet trail, and screen shake.
 * Respects prefers-reduced-motion (no shake, fewer/short particles).
 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
}

export class Fx {
  particles: Particle[] = [];
  shake = 0;
  shakeX = 0;
  shakeY = 0;
  reduced: boolean;
  private t = 0;

  constructor(reducedMotion: boolean) {
    this.reduced = reducedMotion;
  }

  time(): number {
    return this.t;
  }

  burst(x: number, y: number, color: string, count: number, spd = 40, gravity = 0): void {
    const n = this.reduced ? Math.ceil(count / 3) : count;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const s = spd * (0.4 + Math.random() * 0.8);
      const life = (this.reduced ? 0.35 : 0.6) * (0.6 + Math.random() * 0.7);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life,
        maxLife: life,
        size: 0.6 + Math.random() * 1.4,
        color,
        gravity,
      });
    }
  }

  trail(x: number, y: number, color: string): void {
    if (this.reduced) return;
    this.particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0.4,
      maxLife: 0.4,
      size: 1.1,
      color,
      gravity: 0,
    });
  }

  addShake(amount: number): void {
    if (this.reduced) return;
    this.shake = Math.min(6, this.shake + amount);
  }

  update(dt: number): void {
    this.t += dt;
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
    }
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 22);
      this.shakeX = (Math.random() * 2 - 1) * this.shake;
      this.shakeY = (Math.random() * 2 - 1) * this.shake;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  clear(): void {
    this.particles.length = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}

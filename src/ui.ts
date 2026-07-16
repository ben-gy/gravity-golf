/**
 * ui.ts — pure HTML builders for the menu / help / about / results screens.
 * main.ts owns the canvas + event wiring; these just return markup strings.
 */

import type { HoleResult } from './game/golf';
import type { RaceStanding } from './game/race';

export const FOOTER_HTML = `
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export function toParStr(delta: number): string {
  return delta === 0 ? 'E' : delta > 0 ? `+${delta}` : `${delta}`;
}

export function parLabel(strokes: number, par: number): { t: string; c: string } {
  const d = strokes - par;
  if (strokes === 1) return { t: 'Hole in one!', c: 'ace' };
  if (d <= -2) return { t: 'Eagle', c: 'eagle' };
  if (d === -1) return { t: 'Birdie', c: 'birdie' };
  if (d === 0) return { t: 'Par', c: 'par' };
  if (d === 1) return { t: 'Bogey', c: 'bogey' };
  return { t: `+${d}`, c: 'over' };
}

export function menuHTML(bestLabel: string, holes: number): string {
  return `
    <div class="screen menu">
      <div class="logo">
        <span class="logo-ball"></span>
        <h1 class="title">Gravity<span>Golf</span></h1>
      </div>
      <p class="tagline">Slingshot your ball through a field of planets — bend it around gravity into the hole.</p>
      <div class="menu-actions">
        <button class="btn primary" id="m-solo">Play solo · ${holes} holes</button>
        <button class="btn" id="m-friends">Play with friends</button>
        <div class="menu-row">
          <button class="btn ghost" id="m-how">How to play</button>
          <button class="btn ghost" id="m-about">About</button>
        </div>
      </div>
      <p class="best">${esc(bestLabel)}</p>
    </div>`;
}

export function howToHTML(): string {
  return `
    <div class="modal-body">
      <h2>How to play</h2>
      <ul class="how-list">
        <li><b>Aim:</b> press and drag <b>back</b> from the ball like a slingshot, then release to launch. Longer drag = more power.</li>
        <li><b>Gravity:</b> amber planets <b>pull</b> your ball — bend your shot around them. Grey planets <b>push</b> it away.</li>
        <li><b>Sink it:</b> drop into the green hole. Arrive too fast and it rims out — ease off near the cup.</li>
        <li><b>Hazard:</b> magenta <b>black holes</b> swallow the ball and cost you the shot.</li>
        <li><b>Keyboard:</b> ←/→ aim, ↑/↓ power, <b>Space</b> shoot. <b>P</b> pause · <b>R</b> restart · <b>M</b> mute.</li>
      </ul>
      <p class="how-goal">Clear every hole in as few strokes as you can. Share a course with a friend, or race live!</p>
    </div>`;
}

export function aboutHTML(): string {
  return `
    <div class="modal-body">
      <h2>About</h2>
      <p>Gravity Golf is a physics mini-golf game: every shot is a little orbital puzzle. Play solo, share a <b>seed link</b> so a friend plays the exact same course and compares scores, or race up to 6 players live.</p>
      <p>It runs entirely in your browser — no login, no install, no data stored on any server. Multiplayer is <b>peer-to-peer</b> over WebRTC; a free public signaling relay only helps the browsers find each other for the initial handshake, then play flows directly between you.</p>
      <p>Anonymous, cookie-less page-view counts come from Cloudflare Web Analytics — the only network call the base game makes.</p>
      <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>
    </div>`;
}

/** Solo end-of-course scorecard. */
export function soloResultsHTML(
  results: HoleResult[],
  totalPar: number,
  best: number | null,
  isNewBest: boolean,
): string {
  const totalStrokes = results.reduce((s, r) => s + r.strokes, 0);
  const delta = totalStrokes - totalPar;
  const rows = results
    .map((r) => {
      const lab = parLabel(r.strokes, r.par);
      return `<tr>
        <td>${r.hole + 1}</td>
        <td>${r.par}</td>
        <td>${r.strokes}</td>
        <td><span class="chip ${lab.c}">${esc(lab.t)}</span></td>
      </tr>`;
    })
    .join('');
  return `
    <div class="screen results">
      <h2 class="results-title">Course complete${isNewBest ? ' · New best!' : ''}</h2>
      <div class="score-big">${totalStrokes} <span class="score-sub">strokes · ${toParStr(delta)} to par</span></div>
      <div class="table-wrap">
        <table class="scorecard">
          <thead><tr><th>Hole</th><th>Par</th><th>You</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>Total</td><td>${totalPar}</td><td>${totalStrokes}</td><td>${toParStr(delta)}</td></tr></tfoot>
        </table>
      </div>
      ${best != null ? `<p class="best">Best: ${best} strokes</p>` : ''}
      <div class="menu-actions">
        <button class="btn primary" id="r-again">Play again</button>
        <button class="btn" id="r-share">Share this course</button>
        <button class="btn ghost" id="r-menu">Menu</button>
      </div>
      <p class="share-flash" role="status" aria-live="polite"></p>
    </div>`;
}

/** Live race final standings. */
export function raceResultsHTML(standings: RaceStanding[], selfId: string): string {
  const rows = standings
    .map((s, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
      const status = s.done
        ? `${s.strokes} strokes`
        : `hole ${s.hole + 1} · ${s.strokes}`;
      return `<tr class="${s.id === selfId ? 'is-self' : ''}">
        <td class="rank">${medal}</td>
        <td>${esc(s.name)}${s.id === selfId ? ' (you)' : ''}${s.connected ? '' : ' <span class="dc">left</span>'}</td>
        <td>${s.done ? '✓' : ''} ${status}</td>
      </tr>`;
    })
    .join('');
  return `
    <div class="screen results">
      <h2 class="results-title">Race over</h2>
      <div class="table-wrap">
        <table class="scorecard race">
          <thead><tr><th>#</th><th>Player</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="menu-actions">
        <button class="btn primary" id="r-menu">Back to menu</button>
      </div>
    </div>`;
}

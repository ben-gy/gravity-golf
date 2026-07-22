# Gravity Golf

**Slingshot your ball through a field of planets — bend it around gravity into the hole in as few shots as you can.**

🎮 Play: https://gravity-golf.benrichardson.dev

## What it is
Gravity Golf is a physics mini-golf game where every shot is a little orbital puzzle. You pull back on the ball like a slingshot and let go; amber planets **pull** your ball and grey ones **push** it, so a straight line rarely works — you learn to curve your shot around the gravity. Arrive at the green hole slowly and you drop in; blast through too fast and it rims out. Magenta **black holes** swallow the ball and cost you the shot.

A course is 9 procedurally generated holes with a live predicted-trajectory guide so you can read the curve before you commit. It's fun for one person in the first five seconds — but you can also share a course seed so a friend plays the exact same holes and compares scores, or race up to 6 players live.

## How to play
- **Desktop:** press and drag **back** from the ball, release to launch (longer drag = more power). Or ←/→ to aim, ↑/↓ for power, **Space** to shoot. **P** pause · **R** restart · **M** mute.
- **Mobile:** drag back from the ball with your thumb and lift to launch.
- **Goal:** clear all 9 holes in as few strokes as possible. Watch the dotted trajectory preview to judge the gravity.

## Multiplayer
Two flavours, both zero-backend:

- **Async seed-share** — finish a course and hit **Share this course**; the link carries the seed so a friend plays the identical 9 holes and compares their total. No live connection needed.
- **Live P2P race (2–6 players)** — create a room or join by a typed code, everyone plays the same seeded course simultaneously, and a live standings strip shows who's ahead. It's **peer-to-peer** over WebRTC: a free public signaling relay only helps browsers find each other for the initial handshake, then play flows directly between peers with no game server. If the host leaves, another player is seamlessly promoted so the race always finishes.

## Tech
- Vite 6 + vanilla TypeScript
- Canvas 2D rendering (comet trails, particles, screen shake, procedural audio)
- Shared engine: fixed-timestep loop, seedable deterministic RNG, procedural sound, Trystero P2P netcode with host-authoritative race state + host-transfer takeover
- Vitest for physics, course-generation, P2P-sync determinism, room-code, and host-transfer tests
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

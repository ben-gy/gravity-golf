# Game Plan: Gravity Golf

## Overview
- **Name:** Gravity Golf
- **Repo name:** gravity-golf
- **Tagline:** Slingshot your ball through a field of planets — bend it around gravity into the hole in as few shots as you can.
- **Genre (directory category):** arcade

## Core Loop
Pull back on the ball to aim a slingshot, watch the predicted arc curve as gravity from nearby planets bends it, and release. The ball flies, slingshots around attractors, bounces off planet surfaces and walls, and rolls to a stop. Sink it in the hole (arrive slow enough) to clear the hole; blast through too fast and it rims out. Fewest strokes over a 9-hole course wins. Tension = every shot is a little orbital-mechanics puzzle: aim straight and a planet eats your line; use the pull and you curve a perfect approach.

## Controls
- **Desktop:** Mouse — press and drag *back* from the ball (slingshot), release to launch. Longer drag = more power. Or keyboard: ←/→ rotate aim, ↑/↓ power, **Space** shoot. **P** pause, **R** restart, **M** mute.
- **Mobile:** Touch — drag back from the ball and lift to launch. A live aim line + predicted trajectory dots show where it'll go. Big 44px+ tap targets for all menu buttons.

## Multiplayer
- **Mode:** both **async-seed** (share a `?seed=` link → a friend plays the identical course, compare totals) **and live P2P race** (2–6 players).
- **If live P2P:** players 2–6; topology **host-authoritative for race state** (standings + round clock), while each peer runs its *own* local ball physics (physics need not be frame-synced — only the seeded course must match, which rng.ts guarantees).
  - Each peer broadcasts its `progress` (`{hole, strokes, holeStrokes, done, finishedAt}`) on channel **`prog`** whenever it changes. Every peer folds incoming progress into a local `standings` map (so any peer can take over).
  - Host aggregates standings + a round timer and broadcasts a **`snap`** (`{standings, remainingMs, over, ranking}`) on a ~3Hz `setInterval` (not rAF — survives backgrounded tabs). Clients render the host snapshot for the live standings panel + round clock.
  - **Room entry:** create a room OR type a code (`createRoomEntry` + `normalizeRoomCode`), not link-only. Deep-link `?room=` skips entry once.
  - **Late joiner:** joins the same seeded course, starts at hole 1; standings show them mid-race. Non-blocking.
  - **Host leaves:** net.ts re-elects the smallest peer id and fires `onHostChange`; `RaceSession.setHost(true)` promotes the survivor — it adopts the last snapshot's standings + remaining clock, resumes the round timer and the `snap` keepalive on `setInterval`, and can still declare the round **over**. A "you're the host now" flash shows. The round can always still end.
  - **Peer leave:** `onPeerLeave` drops that peer from the "everyone done?" check so a departing player never freezes the round.
  - Channels: `prog`, `snap` (plus engine `pres`/`preq`/`go`/`ping`). All ≤12 bytes.

## Juice Plan
- **Sound (sound.ts):** `blip` on aim-adjust, `jump` (whoosh) on launch, `hit` on planet/wall bounce, `coin`/`win` on sink, `powerup` on hole-in-one, `explosion` on black-hole swallow, `lose` on out-of-strokes-ish. Mute persisted.
- **Particles:** launch burst at the ball, spark on every bounce, a green confetti pop on sink, a purple implosion swirl on black-hole swallow, a comet **trail** behind the moving ball.
- **Screen shake:** small on hard bounces, bigger on sink and black-hole swallow (respect `prefers-reduced-motion` → no shake, fewer particles).
- **Tweens:** eased camera-settle, hole flag wave, planet pulse glow, power-meter fill, results count-up. Predicted-trajectory dots fade with distance.
- **Palette:** deep-space navy; cyan ball; amber attractors; green hole; magenta black holes — all distinguishable without colour.

## Style Direction
**Vibe:** neon / clean-space arcade.
**Palette:** `#0a0e1a` space navy · `#4dd0ff` cyan (ball/UI) · `#ff9f45` amber (attractor planets) · `#35d07f` green (hole) · `#b061ff` magenta (black holes). Colour-blind-safe (distinct hues + distinct shapes: filled planet vs ringed hole vs swirled black hole).
**Theme:** dark (space).
**Reference feel:** the tactile slingshot of Angry-Birds-style aiming + the orbital elegance of *Osmos*/*Spacewar* — feel only, no IP.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** Canvas 2D (continuous motion, particles, trails).
- **Engine modules copied from patterns/:** loop, rng, net, lobby (extended with `createRoomEntry`/`normalizeRoomCode`), sound, storage. (input.ts not used — slingshot is native pointer/touch drag on the canvas; keyboard handled directly.)
- **Persistence:** localStorage — mute, "seen how-to", best total per course length, last name.

## Non-Goals
- No rectangular wall mazes / moving obstacles this pass (circular planets + boundary walls + black holes are enough variety for 9 holes).
- No frame-synced physics across peers (unnecessary — only the course is shared).
- No global leaderboard/backend.

## How To Play (player-facing copy)
Drag **back** from the ball to aim your slingshot, then release to launch. Planets pull your ball — bend your shot around them and drop it in the green hole. Arrive too fast and it'll rim out. Clear all 9 holes in as few strokes as you can. Watch out for magenta black holes — they'll swallow your ball!

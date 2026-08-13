# RALLYE — Vehicle & AI tuning guide

Everything gameplay-feel lives in **two data files** and one AI header. You
should never need to touch solver code to change how the game feels.

## Where the knobs are

| File | What it owns |
|---|---|
| `src/game/config.js` | Gravity, steering feel, assists, drift, air control, reset rules, collisions, aero |
| `src/game/vehicles.js` | The three car specs — mass, grip, power, suspension, silhouette |
| `src/world/surfaces.js` | What DIRT/SAND/MUD/… mean (grip, drag, sink, dust, squeal) |
| `src/game/ai.js` (header consts) | AI lookahead, braking model, offsets, balancing |
| `src/world/tracks/*.js` | Stage layout: path, widths, paints, jumps, walls, laps |

## The five numbers that matter most

1. **`G` (config.js, 12.8)** — gravity. The whole game is tuned around it:
   jump arcs (a 20° kicker at 30 m/s flies ~56 m), suspension sag, grip
   levels. Change it last, and only with a full retune.
2. **`comHeight` (per spec)** — the anti-flip lever. Rollover threshold is
   `(track / comHeight) · G`; every car keeps ≥1.2× margin over its peak
   road-grip lateral acceleration. Raise it and cars roll in fast corners.
3. **`gripF / gripR` (per spec)** — base friction multiplied by the surface.
   The front/rear DIFFERENCE is the car's character: front-biased = safe
   understeer (hopper), near-square = planted (ridgeback), front-heavy with
   low rear = throttle-rotates (redline).
4. **`topSpeed` (per spec)** — honest terminal velocity; drive force fades to
   a tail at exactly this speed. AI reads it directly for its targets.
5. **`TUNE.steer.speedTaper` (0.24)** — fraction of full lock available at
   top speed. This is why keyboard steering stays civilised at 130 km/h.

## Car-by-car intent

- **DUNE HOPPER** (1120 kg, 36 m/s) — learns you the game. Front grip bias,
  AWD 45 % front, softest assists exposure. Mild turn-in push; lift and it
  tucks back in. The slide is lazy and catchable.
- **RIDGEBACK** (1680 kg, 32 m/s) — momentum truck. Rear-biased grip so it
  will not swap ends, 1.35× anti-roll, 12 % less lock. Strongest pull below
  20 m/s: it wins by exiting corners hard and shrugging off ruts.
- **REDLINE** (1010 kg, 41 m/s) — the reward. 28 % front drive, sharpest
  rack, rear grip deliberately below front: it rotates on throttle. Demands
  discipline over crests; fastest everywhere if you give it that.

## Assists (config.js `TUNE.assists`, always on — arcade)

- `tcSlipCap` / `absCap` — traction control and ABS ceilings. Raise to make
  the cars more feral; the AI copes either way (it drives the same physics).
- `stabilityYawDamp` + `yawRateCap` (2.0 rad/s) — the spin governor. The
  handbrake yaw boost is capped by this, which is what keeps drifts filmable.
- `countersteerAssist` (0.42) — auto-adds correct-sign steer up to 1.2 rad of
  slip. This is why aiming at where you want to go recovers most slides —
  for the player AND the AI.
- `drift.spinGuard` — stability walks back in between 31° and 66° of slip:
  the difference between a drift and a pirouette.

## Surfaces

`SURFACES[id] = { grip, drag, sink, bump, dust, dustCol, skid }` — grip
multiplies tyre friction; drag is rolling resistance as a fraction of load;
sink scales live rut depth (MUD trenches, ROAD doesn't); bump scales baked
micro-roughness; skid scales squeal (sings on ROAD/ROCK, mute in MUD).
LAVA is a hazard by cost: grip 0.55 + drag 0.038, plus race logic respawns
anything that loiters on it below 7 m/s for 1.2 s ("SCORCHED").

## AI

`makeGridProfiles(count, difficulty01, rng)` ladders skill around
`0.30 + 0.55·difficulty`; skill maps to **0.78–1.02× of the racing-line
speed**, plus start reaction, braking-point noise and mistake probability
(rises when pressured by a rival within 8 m). Aggression trades later
braking and later yielding; consistency trades corner-entry noise.

- Difficulty per stage is set in `main.js` (`difficultyFor`) — training 0.25
  rising to volcano 0.91.
- **Balancing**: `AI_BALANCE` in ai.js — leader ×0.985, P6 ×1.015 on the
  AI's *speed targets* (never on the vehicle), eased over 1.5 s, hard-capped,
  `enabled:false` kills it entirely.
- The AI enforces ≥0.98× line speed for 40 m before any gap jump regardless
  of skill — nobody lemmings into the canyon gap.
- If AI weaves on the volcano rim or saws on corner exit, lengthen `LOOK_K`
  first, then lower `STEER_RATE` toward 5 (see the header comment block in
  ai.js — the three gains most likely to need work are documented with their
  failure symptoms).

## Race rules (config.js `TUNE.reset`)

flip 2.5 s · stuck 4 s under throttle · off-course 25 m for 2.5 s · lava
loiter 1.2 s · manual hold 0.8 s · respawn ghost 1.5 s. Respawns place you a
few metres past the last gate you actually cleared, facing the right way.

## Camera & feel (game/camera.js, game/feel.js)

`rig.yawHz` (1.91) — how hard the camera chases the car's travel direction;
lower shows more slide, higher squares the car to frame. `CH.pivotYAir`
(4.5) — vertical softness while airborne; this is the whole jump read.
`feel.js` `shakeLo/shakeHi` (18/40 m/s) — where speed rumble starts and
saturates. All three carry symptom notes in-file.

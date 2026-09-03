# RALLY ROAD RASH — Vehicle & AI tuning guide

Everything gameplay-feel lives in **two data files** and one AI header. You
should never need to touch solver code to change how the game feels.

## Where the knobs are

| File | What it owns |
|---|---|
| `src/game/config.js` | Gravity, steering feel, assists, drift, **mini-turbo**, air control, reset rules, collisions, aero |
| `src/game/vehicles.js` | The four machine specs — mass, grip, power, suspension, silhouette |
| `src/world/surfaces.js` | What DIRT/SAND/MUD/… mean (grip, drag, sink, dust, squeal) |
| `src/game/ai.js` (header consts) | AI lookahead, braking model, offsets, balancing |
| `src/world/tracks/*.js` | Stage layout: path, widths, paints, jumps, walls, laps |
| `src/game/items.js` (header consts) | Power-up roster and the rubber-banding table |

## The five numbers that matter most

1. **`G` (config.js, 12.8)** -- gravity. The whole game is tuned around it:
   jump arcs, suspension sag, grip levels. Ground physics always uses the
   full 12.8 -- change it last, and only with a full retune. Airtime itself
   is a separate knob: once a jump has been airborne past `hangHi` (0.35 s),
   `TUNE.air.hangGravity` (0.58) scales gravity back and a kicker flies
   roughly 1.7x further without the ground getting any softer -- see
   Airborne below.
2. **`comHeight` (per spec)** — the anti-flip lever. Rollover threshold is
   `(track / comHeight) · G`; every car keeps ≥1.2× margin over its peak
   road-grip lateral acceleration. Raise it and cars roll in fast corners.
3. **`gripF / gripR` (per spec)** — base friction multiplied by the surface.
   The front/rear DIFFERENCE is the car's character: front-biased = safe
   understeer (hopper), near-square = planted (ridgeback), front-heavy with
   low rear = throttle-rotates (redline), rear-biased on a short wheelbase =
   drives out of the corner on the back wheel (moto).
4. **`topSpeed` (per spec)** — honest terminal velocity; drive force fades to
   a tail at exactly this speed. AI reads it directly for its targets.
5. **`TUNE.steer.speedTaper` (0.24)** -- fraction of full lock available at
   top speed. This is why keyboard steering stays civilised at 140 km/h.

## Car-by-car intent

- **DUNE HOPPER** (1120 kg, 39 m/s) -- learns you the game. Front grip bias,
  AWD 45 % front, softest assists exposure. Mild turn-in push; lift and it
  tucks back in. The slide is lazy and catchable.
- **RIDGEBACK** (1680 kg, 34 m/s) -- momentum truck. Rear-biased grip so it
  will not swap ends, 1.35× anti-roll, 12 % less lock. Strongest pull below
  20 m/s: it wins by exiting corners hard and shrugging off ruts.
- **REDLINE** (1010 kg, 45 m/s) -- the reward. 28 % front drive, sharpest
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

## Airborne (config.js `TUNE.air`)

Two independent systems share this block: control authority (how the car
rotates once it leaves the ground) and hang time (how far it flies).

- `pitchAuthority` / `yawAuthority` / `rollAuthority` (3.6 / 2.8 / 3.8
  rad/s^2 at full stick). Wave 6 roughly doubled all three: air is now a
  place you do things on purpose, and roll went from the smallest to the
  largest because it is the trick axis. `damp` fell to 0.55 to match.
- `alignAssist` (2.3) is the LANDING ASSIST, and it is predictive now, not
  a timer. It runs a Newton solve for time-to-ground against the real
  height field, takes the ground normal AT the predicted landing point,
  and aims the car at velocity-heading x that normal. `assistWindow`
  ([0.2, 1.6] s) is how it fades in as the ground approaches;
  `assistScale` ([0.55, 1.0, 1.6]) is the trickAssist setting. It is off
  entirely while any input is held, so a committed flip is never rescued
  for you -- that is what replaced `alignDelay` and `alignGiveUp`, both
  retired. `snapFrom` (5.2 rad) / `snapRate` (1.5 rad/s) are the
  snap-through: a rotation past that angle and still turning is COMPLETED
  rather than unwound the short way, measured on |angle| mod 2*pi so a
  flip 66 degrees past a full turn is not sent the long way round.
- `spinCap` stays at 5.0 rad/s -- airborne rates never get near it in
  normal play, and raising it lets crash-bounce chaos carry enough spin to
  make the flip watchdog non-deterministic.
- `hangGravity` (0.58) / `hangLo` (0.12 s) / `hangHi` (0.35 s) -- the
  arcade hang. Gravity scales back to 58% of `G` once a jump has been
  continuously airborne past `hangHi`, so kickers fly roughly 1.7x
  further; anything shorter than `hangLo` (a rut blip, a kerb) still
  falls at full weight. Ground handling never sees this -- `G` above
  stays 12.8 either way.

## Surfaces

`SURFACES[id] = { grip, drag, sink, bump, dust, dustCol, skid }` — grip
multiplies tyre friction; drag is rolling resistance as a fraction of load;
sink scales live rut depth (MUD trenches, ROAD doesn't); bump scales baked
micro-roughness; skid scales squeal (sings on ROAD/ROCK, mute in MUD).
LAVA is a hazard by cost: grip 0.55 + drag 0.038, plus race logic respawns
anything that loiters on it below 7 m/s for 1.2 s ("SCORCHED").

## AI

`makeGridProfiles(count, difficulty01, rng)` ladders skill around
`0.30 + 0.55·difficulty`; skill maps to **0.66–1.06× of the racing-line
speed**, plus start reaction, braking-point noise and mistake probability
(rises when pressured by a rival within 8 m). Aggression trades later
braking and later yielding; consistency trades corner-entry noise.

### The speed model is MEASURED, not guessed (wave 7)

`dev/vehicle-check.mjs` puts the real cars at **16.7–17.6 m/s² of braking**
and **12.0–14.3 m/s² of sustained lateral** on DIRT (grip 0.82). The driver
model believed 8.5 and 7.5 — about 0.55× of the slowest real car — so it
lifted absurdly early into every corner and arrived roughly 11 m/s slow.

| Constant | Where | Was | Now |
|---|---|---|---|
| `LAT_ACCEL` | `world/track.js` (exported) | 7.5 | **10.5** |
| `A_BRAKE` | `game/ai.js` (exported) | 8.5 | **13.0** |
| `SKILL_LO` / `SKILL_HI` | `game/ai.js` | 0.78 / 1.02 | **0.66 / 1.06** |
| `MISTAKE_LATE` | `game/ai.js` | 0.35 | **0.25** |

`LAT_ACCEL` is the one number the racing line, the AI's corner limit and the
alternate-route solver all read — `ai.js` imports it rather than repeating the
literal. If corners now overshoot, **raise `BRK_P` 0.5 → 0.8 before touching
any of the four above.** A jump point's advisory speed is never scaled UP by a
fast driver's line scale: it is a cap that already carries the over-fly margin.

### Real air vs a rock hop

The air policy is a total input blackout, and it used to begin after
`AIR_MIN_T` (0.12 s) of airborne — which a stone, a rut or a whoop crest all
satisfy, so on rough ground the driver's hands came off the wheel several
times a second. That is the sawing, erratic rival QA reported. A flight is now
declared REAL by the lip (`jumpCommit` within `LIP_RECENT` 0.5 s) or the
launch (`vel.y > LAUNCH_VY` 3.0), and confirmed in flight by hang time
(`HOP_T` = `TUNE.air.hangHi` 0.35 s) or peak height (`AIR_PEAK_REAL` 0.6 m).
Anything else is a hop: ground steer is kept, `steerOut` is NOT decayed, and
throttle is merely capped at `HOP_THR` 0.6. Touching down from real air runs a
`LAND_GRACE` (0.35 s) exit that clamps steer to `LAND_STEER` and brake to
`LAND_BRAKE` rather than restarting cold.

- Difficulty per stage is set in `main.js` (`difficultyFor`) — training 0.25
  rising to volcano 0.91, **plus the RIVALS setting's `diff`** (easy −0.20,
  normal 0, hard +0.18).
- **Balancing**: `AI_BALANCE` in ai.js — leader ×0.985, P6 ×1.015 on the
  AI's *speed targets* (never on the vehicle), eased over 1.5 s, hard-capped,
  `enabled:false` kills it entirely.
- **…and the player band**, `AI_BALANCE.player` (wave 7). The ladder above
  only knows a rival's place among six cars, so a field that had collectively
  driven off up the road stayed perfectly balanced against itself while the
  player watched it go. This is the other axis: the gap in seconds to the
  PLAYER's ratcheted `raceS`, eased over `ramp` seconds of gap and clamped by
  `cap`. `main.js`'s `RIVALS` table replaces the whole band per difficulty —
  EASY backs a leading rival off sooner and further, HARD raises the floor so
  nobody hands you the place.
- **Route cost-awareness**: `AI_SHORTCUT.costAware` (wave 7). Every alt now
  carries `dtSec`/`dtFrac` — what the detour costs against the road it
  replaces, from the same per-point speed sum `ai-check` uses for an ideal
  lap. A route losing more than `slowFrac` (2 %) is skipped unless the track
  asked for it with an `aiBias` of at least `forceBias` (0.8). Measured:
  canyon `slot` +2.0 s/lap and `mesatop` +2.1 s/lap (both now refused), forest
  `highroute` −0.3 s/lap (still taken). `costAware: false` restores the old
  blind roll — `dev/ai-check.mjs` gate g does exactly that, because it tests
  the stitching, not the tuning.
- **Rivals get the PLAYER's recovery net.** `OFF_LINE_D` / `OFF_LINE_T` in
  ai.js now read `TUNE.reset.offCourseDist` / `offCourseTime` (30 m / 2.5 s)
  instead of a private 22 m / 0.6 s — a rival used to give up on a slide a
  human would have driven out of, four times more readily.
- The AI enforces ≥0.98× line speed for 40 m before any gap jump regardless
  of skill — nobody lemmings into the canyon gap.
- If AI weaves on the volcano rim or saws on corner exit, lengthen `LOOK_K`
  first, then lower `STEER_RATE` toward 5 (see the header comment block in
  ai.js — the three gains most likely to need work are documented with their
  failure symptoms).

## Mini-turbo (config.js `TUNE.boost`)

A drift charges a tier; releasing it fires a boost. The mechanic is **always
on** — it is handling, not a power-up, and the POWER-UPS setting does not
touch it.

The tier times are the number people get wrong first. They are
`[0.12, 0.24, 0.34]` seconds and they look absurdly short until you measure
what the handbrake actually does here: a swept test found the car leaves the
slip band after **~0.47 s** no matter how you steer, with a maximum
single-application charge of **0.36**. The handbrake in this game is a
rotation tool, not a state you hold. Tiers longer than that are simply
unreachable — the original `[0.85, 1.90, 3.10]` fired zero times in a full
race. If you lengthen them, re-measure first.

- **`slipHand` 0.20 / `slipFree` 0.34** — the dual gate, in radians of body
  slip. The lower number applies with the handbrake down. The higher one is
  what lets a *throttle* slide charge, and it is the only reason AI cars get
  mini-turbos at all: `ai.js` sets `handbrake = 0` unconditionally.
- **`slipMax` 1.15** — the upper gate. Without it a full pirouette counted as
  a drift. It matches the top of `TUNE.drift.spinGuard`.
- **`minSpeed` 9** — measured against `groundSpeed`, not `speed`. At 86° of
  slip the forward component is ~0, so gating on `speed` switched the charge
  off exactly when the car was most sideways.
- **`grace` 0.30 / `decay` 1.2** — how long a slide may lapse before the
  charge bleeds, and how fast it goes. `grace` is also the second fire
  trigger: the first is the handbrake DOWN→UP edge.
- **`fireTop` `[1.00, 1.06, 1.13]`** — the top-speed multiplier per tier.
  Tier 1 is exactly 1.00 on purpose: it fires roughly twenty times a lap and
  must add punch without moving terminal speed.
- **`spinLockout` 0.40** — no charging while spun out.

Symptom guide: *boosts never fire* → tiers too long, or `slipFree` too high.
*Boosts fire constantly on straights* → `slipFree` too low. *Lap times fall
off a cliff* → `fireTop` above ~1.15; the drive-fade curve stops being an
honest ceiling.

## Power-ups (`src/game/items.js`)

`DROP_WEIGHTS[position][item]` is the whole balance surface — plain integers
by row, not normalised. Row 0 is P1. Rubber-banding is **strong by design**:
P1 draws defence only, last place draws a catch-up special about a third of
the time, and anyone more than `ITEM_TUNE.gapShiftSec` (8 s) behind the
leader rolls one row *lower* than their position. To soften the whole system,
raise `gapShiftSec` and flatten the last two rows; to harden it, do the
reverse. Changing a weight needs no code change and no other file.

`ITEM_TUNE.sledLockoutM` (120) and `stormMinPos` (4) are the guards that stop
the two specials deciding a race in its final metres. `dev/items-check.mjs`
gates both, plus the two rubber-band assertions — if you rebalance the table,
that suite tells you whether it is still a catch-up system.

### `use` and `hint` are UI-owned (wave 7)

Every item carries a `use` verb and an optional `hint`. The on-screen prompt
is `<NAME> — PRESS <KEY> TO <USE>`; it used to read "TO FIRE" for all seven,
which named a key and said nothing whatever about what pressing it would do.
`{BACK}` in a hint is substituted per input method (↓ / LT / BRAKE).
`dev/items-check.mjs` gate a fails an item with no `use`.

Nothing was wrong with the AI's item USE — `dev/ai-check.mjs` gate y measures
a 66 % hit rate against a 35 % gate, and the field throws 40–80 items a race.
It was invisible: `race.js` handed both `ItemWorld` and `RaceFX` `vfx: null`
and nothing ever called `vfx.update()`, so every item particle, hit ring,
wheel ribbon, sled flame and pad flash in the game was allocated, wired and
then never drawn. `AI_ITEM.shoot` needs no change; leave it at 0.30.

## Race rules (config.js `TUNE.reset`)

flip 2.5 s / stuck 4 s under throttle below 1.6 m/s / no-progress 4 m of
`liveS` in 6 s (ground only -- airborne time never counts against it; it reads
the UN-ratcheted progress estimate, because `raceS` is frozen after a respawn
and a watchdog on it deadlocks) / off-course
30 m for 2.5 s / lava loiter 1.2 s / manual hold 0.8 s / respawn ghost
1.5 s. Respawns place you a few metres past the last gate you actually
cleared, facing the right way, and are pushed clear of any gap-jump void
that spot would otherwise drop them into.

## Camera & feel (game/camera.js, game/feel.js)

`rig.yawHz` (1.91) -- how hard the camera chases the car's travel direction;
lower shows more slide, higher squares the car to frame. `CH.pivotYAir`
(3.4) -- vertical softness while airborne, the whole jump read; `CH.airDist`
(1.22) and `CH.airFov` (8 deg) boom the shot out and widen it further while
airborne, so a big jump visibly climbs out of frame instead of just hanging
there. `feel.js` `shakeLo/shakeHi` (26/48 m/s) -- where speed rumble starts
and saturates, raised so it reads as speed and not as a loose camera. All
carry symptom notes in-file.

# RALLY ROAD RASH — Architecture & Interface Contracts

**RALLY ROAD RASH** is a 3D arcade off-road rally racing game: one player + 5 AI racers, themed tracks
(desert canyon, forest/mountain, volcanic badlands, plus a training ground), laps, checkpoints,
big jumps, progression and unlocks. Desktop (keyboard/gamepad) + mobile (touch), 60 fps target.

The house style is vanilla ES modules, **zero npm dependencies, no build step**, vendored
three.js r160, everything generated procedurally at load time.
This document is the binding contract between modules. **If you need to change a contract,
stop and flag it in your report instead of unilaterally changing it.**

## Hard rules (all contributors)

1. **No new dependencies. No network fetches at runtime.** Everything the game NEEDS is
   code-generated (canvas textures, procedural geometry, WebAudio synthesis).

   *Amended in wave 6:* a small set of **optional** images may ship in `assets/` — skyline
   panoramas, ground detail tiles, stage and title key art. They are a look upgrade and
   nothing more. The rules that keep that true, and that every consumer is tested against:
   they load through `src/core/assets.js` only; they load with **relative URLs** and
   `crossOrigin = 'anonymous'` (the game is served from Sandscape in production and from a
   static server locally, and a tainted canvas breaks the screenshot path); loading is
   **non-blocking** and a missing or broken entry resolves to `null`, never to a rejected
   promise; and **every consumer keeps its procedural path as the fallback**. Rename
   `assets/` aside and the game must still run and still look deliberate — that is a QA gate,
   not an aspiration. No generated 3D and no generated audio: those stay procedural.
2. **ES modules** loaded via the import map in `index.html` (`three`, `three/addons/`).
   Relative imports between our modules. Must run from a static file server, Chrome 89+ /
   Firefox 108+ / Safari 16.4+ (WebGL2 + import maps).
3. **Own only your assigned files.** Never edit files owned by another task, even to "fix" them.
   If an interface is missing/wrong, note it in your report.
4. **No per-frame allocations in hot paths.** Use module-level scratch vectors/quaternions
   (`_v1`, `_q1`, …) exactly like the existing code. No `new`, `.clone()`, array literals, or
   closures inside per-frame update loops.
5. **Comment style:** match the repo — comments explain constraints and *why*, not what.
6. **Determinism where cheap:** use `makeRNG(seed)` / `hash2i` from `core/rng.js` for world
   generation. `Math.random()` allowed only for cosmetic transients (particles, audio jitter).
7. **CPU/GPU height agreement is sacred.** Physics reads `terrain.heightAt(x,z)`; the terrain
   vertex shader samples the same baked textures with matching filtering. Never introduce a
   height source the other side can't see.
8. Syntax-check every file you write with `node --check <file>` before finishing.
   **Do not use browser tools; do not start dev servers.** The integrator does visual QA.
9. Units: metres, seconds, radians. Y is up. Vehicle-local forward is **+Z**, right is **−X**
   (matches existing vehicle math). World is the XZ plane.
10. Keep files under ~1400 lines; split coherently if larger.

## Module map & ownership

```
index.html                shell, overlays, HUD markup            [P6 ui/ux]
server.js                 static server (unchanged)              [locked]
src/
  main.js                 bootstrap, app state machine, frame    [lead]
  core/
    engine.js             renderer, quality tiers, composer      [P1 env & vfx]
    assets.js             OPTIONAL image loading (never in Node)  [lead]
    input.js              kb/mouse/gamepad/touch                 [P4 air & tricks: roll bindings]
    audio.js              procedural WebAudio                    [lead: delegates only]
    audio-items.js        power-up/boost/trick cues              [P4 air & tricks]
    rng.js                noise/PRNG helpers (unchanged)         [locked]
    save.js               localStorage wrapper                   [locked]
  world/
    terrain.js            Terrain object, CPU height, clipmap, ruts [lead]
    terrain-const.js      extents/resolutions both sides agree on  [locked]
    terrain-bake.js       theme base, road carve, surface paint    [P3 tracks]
    terrain-shader.js     THEMES, height GLSL, material factories  [P1 env & vfx]
    track.js              spline, routes, checkpoints, racing line [P3 tracks]
    tracks/index.js       registry: TRACKS list                  [P3 tracks]
    tracks/training.js    PROVING GROUNDS (tutorial)             [P3 tracks]
    tracks/canyon.js      SUNSTRIKE CANYON (desert, gap jumps)   [P3 tracks]
    tracks/forest.js      TIMBERLINE CLIMB (mud, narrow, ramps)  [P3 tracks]
    tracks/volcano.js     CALDERA RUN (extreme, biggest jumps)   [P3 tracks]
    tracks/thunder.js     THUNDER PARK (bonus stunt stage)       [P3 tracks]
    surfaces.js           surface-type table (shared data)       [locked]
    props.js              scatter, landmarks, camps, jump kit     [P1 env & vfx]
    props-recipes.js      per-theme dressing plans + signage       [P1 env & vfx]
    props-shapes.js       scatter geometry (rock, tree, log, …)    [P1 env & vfx]
    kit.js                set-dressing geometry (vertex-coloured)  [P1 env & vfx]
    sky.js                skies per theme, sun, clouds, vista, IBL [P1 env & vfx]
    vfx.js                sparks/confetti/shock/ribbons/flames    [P1 env & vfx]
    dust.js               atmospheric dust/mud/debris particles  [P1 env & vfx]
    textures.js           shared procedural texture helpers      [P1 env & vfx]
  game/
    config.js             ALL gameplay tuning in one place       [P4 air & tricks]
    vehicle.js            4-wheel rigid body: solver only        [P4 air & tricks]
    vehicle-art.js        everything a vehicle LOOKS like        [P2 vehicle art]
    vehicle-livery.js     the 1024x512 livery canvases           [P2 vehicle art]
    tricks.js             PURE air-rotation scoring              [P4 air & tricks]
    vehicles.js           the four machine specs                 [P2 vehicle art]
    racecore.js           PURE race logic (no three, no DOM)     [locked]
    race.js               race session: countdown→results        [lead]
    racefx.js             race presentation (sound/particle/shake) [lead]
    progression.js        PURE unlocks/records (no three/DOM)    [P6 ui/ux]
    miniturbo.js          PURE drift->boost state machine        [P4 air & tricks]
    items.js              PURE power-up table + roulette          [P6 ui/ux: desc/tip/icon ONLY]
    itemworld.js          live boxes/projectiles/hazards/pads      [P5 ai & items]
    ai.js                 AI drivers                             [P5 ai & items]
    ai-items.js           PURE "should I fire, and where" policy  [P5 ai & items]
    camera.js             chase camera, shake, FOV, look-ahead   [locked]
    feel.js               game-feel triggers (shake/fx routing)  [locked]
  ui/
    hud.js                HUD, minimap, banners, results         [P6 ui/ux]
    ui.js                 screens, cards, settings, focus        [P6 ui/ux]
    menuscene.js          the live 3D menu backdrop              [P6 ui/ux]
    cards.js              stage and machine card painting        [P6 ui/ux]
    logo.js               canvas wordmark                        [P6 ui/ux]
    icons.js              item and event glyphs                  [P6 ui/ux]
    playbook.js           the how-to-play screen                 [P6 ui/ux]
    styles.css            responsive layout, touch-safe          [P6 ui/ux]
tests/                    node:test suites for pure modules      [lead]
dev/                      harness checks; each package owns its own [see below]
docs/                     this file + tuning/QA docs             [lead]
```

## Coordinate/track conventions

- A **track path** is a closed loop of control points, Catmull-Rom interpolated.
- `s` = arc length along the loop in metres, `0 ≤ s < spline.length`, increasing in the
  **racing direction**. The start/finish line is at `s = 0`.
- `lateral` = signed metres from centreline, positive to the **left** of the direction of
  travel (consistent with right = −X when forward = +Z... verify with cross(up, dir)).
- Race distance for standings: `raceS = lapIndex * spline.length + sEstimate` and is
  **monotonic per racer** (never decreases from checkpoint logic jitter).

## Surface types — `src/world/surfaces.js` (T1 owns, everyone reads)

```js
export const SURF = { ROAD:0, DIRT:1, SAND:2, MUD:3, ROCK:4, GRASS:5, LAVA:6 };
export const SURFACES = [ // indexed by id
  { id:0, name:'ROAD',  grip:1.00, drag:0.006, sink:0.00, bump:0.15, dust:0.15, dustCol:[0.55,0.50,0.44], skid:0.9 },
  { id:1, name:'DIRT',  grip:0.82, drag:0.012, sink:0.35, bump:0.45, dust:0.85, dustCol:[0.58,0.46,0.32], skid:0.6 },
  { id:2, name:'SAND',  grip:0.62, drag:0.030, sink:0.80, bump:0.30, dust:1.00, dustCol:[0.78,0.66,0.44], skid:0.3 },
  { id:3, name:'MUD',   grip:0.52, drag:0.045, sink:1.00, bump:0.40, dust:0.55, dustCol:[0.30,0.22,0.14], skid:0.2 },
  { id:4, name:'ROCK',  grip:0.92, drag:0.008, sink:0.00, bump:0.90, dust:0.35, dustCol:[0.45,0.43,0.41], skid:0.8 },
  { id:5, name:'GRASS', grip:0.68, drag:0.025, sink:0.25, bump:0.55, dust:0.40, dustCol:[0.35,0.40,0.22], skid:0.3 },
  { id:6, name:'LAVA',  grip:0.70, drag:0.020, sink:0.10, bump:0.60, dust:0.60, dustCol:[0.28,0.10,0.06], skid:0.4 },
];
```
`grip` multiplies tyre friction; `drag` is rolling-resistance fraction of load; `sink` scales
rut depth; `bump` scales micro-roughness applied at bake; `dust`/`dustCol` drive particles;
`skid` drives tyre-squeal loudness. Numbers are starting values — tuning happens in config.

## Track definition — `src/world/tracks/*.js` (data-only modules, no three imports)

```js
export default {
  id: 'canyon', name: 'SUNSTRIKE CANYON', tagline: 'Gap jumps over red rock',
  theme: 'canyon',            // 'training' | 'canyon' | 'forest' | 'volcano'
  seed: 1207,                 // drives all procedural placement for this track
  laps: 3,
  path: [ { x, z, y?, w? }, … ],  // closed loop; y = authored elevation override (else from
                                  // theme base noise, smoothed); w = half-width in m (default 8)
  surfaceDefault: SURF.DIRT,
  paints: [ { s0, s1, type } , { x, z, r, type } ],   // along-path spans or discs
  jumps:  [ { s, len, h, gap? } ],  // kicker at s: ramp length, lip height, optional gap
                                    // (metres of carved-out void after the lip)
  shortcut: { path: [ {x,z,y?,w?}, … ], s0, s1 },     // open polyline rejoining main at s1
  walls: [ { s0, s1, side: -1|1|0 } ],                // barrier runs (0 = both sides)
  props: 'theme',            // theme-driven scatter; explicit [{kind,x,z,s,yaw}] also allowed
  grid: { s: 0 },            // grid forms up just behind s (8 slots, 2 wide)
  checkpoints: 'auto',       // ~1 per 110–140 m of path + one on every jump lip
  par: { gold: 0, silver: 0, bronze: 0 },  // seconds, filled during tuning
};
```

## Terrain — `terrain.js` + `terrain-{const,bake,shader}.js`

Split in wave 6 because one 1763-line file could not be worked on by two packages at once.
The four pieces and who may touch them:

- **`terrain-const.js`** — extents, resolutions, detail amplitudes, the crossfade radii.
  Locked. Every one of these numbers appears on BOTH sides of the height contract; a value
  changed here and not there is a car landing where the ground is not.
- **`terrain-bake.js`** [P3] — theme base fields, the road carve, jump profiles, the surface
  and lateral paint, mip chains. Everything that runs once, at load.
- **`terrain-shader.js`** [P1] — `THEMES`, `themePalette`, `TERRAIN_GLSL` (with the parity
  table), `buildTerrainMaterial(terrain)` and `makeLevelMaterial(terrain, cell, i)`.
- **`terrain.js`** [lead] — the `Terrain` object itself: CPU sampling, the clipmap, ruts,
  trails, the sun mask. It **re-exports every name that moved**, so `import { bakeTrack,
  Terrain, PLAYABLE_EXT, THEMES, … } from './terrain.js'` still works everywhere.


```js
export const GRAVITY_WORLD = …  // re-export from game/config.js if needed; physics owns G
export function* bakeTrack(trackDef, report) → baked   // generator, yields for progress UI
export class Terrain {
  constructor(renderer, baked, quality, caps, trackDef)
  heightAt(x, z) → metres          // CPU bilinear, EXACTLY matches shader sampling
  normalAt(x, z, e?, out?) → Vector3
  slopeAt(x, z) → degrees
  surfaceAt(x, z) → surface id (int)   // nearest-sample from baked surface map
  onRoad(x, z) → 0..1                  // road-mask sample (1 = centre of road)
  spline   // TrackSpline for this track (set by whoever constructs it — see race flow)
  rut(x, z, halfWidth, depth, dig)     // deformable ground
  addTrack(ax, az, bx, bz, width, strength)   // tyre-mark decal into trail buffer
  update(dt, camera, sunDir)
  setQuality(q); clearDent(); clearTrails(); dispose()
  uniforms // theme/lighting uniforms incl. uSunDir, uSunCol, shadow-map hookups (as today)
}
```
- Bake pipeline: theme base noise → **carve road** along spline (flatten toward road profile
  with smooth shoulders; kill detail noise on the roadbed) → jumps/gaps → paint surface map +
  road mask → mips. Roads must be drivable at speed: no unauthored steps > ~0.3 m across the
  roadbed; jump lips are the *only* sharp features.
- Surface map: `Uint8Array` (RES ~1024² over the playable extent), uploaded as a texture; CPU
  `surfaceAt` = nearest texel. Shader blends per-surface albedo/roughness from it.
- Lighting: replace Lommel–Seeliger with a standard day model (Lambert + hemisphere ambient +
  distance haze colour per theme) driven by theme uniforms. Keep: baked sun-occlusion mask
  (static sun per track → bake once), directional-shadow-map sampling for vehicles, trail
  buffer, dent field (ruts), clipmap + mips + manual-bilinear fallback.
- The world extent stays ~±600 m playable inside a larger non-playable vista. Track loop
  lengths: training ~900 m, canyon ~1600 m, forest ~1800 m, volcano ~2000 m.

## Track spline & race data — `src/world/track.js` (T1)

```js
export class TrackSpline {
  constructor(points, closed = true)      // builds arc-length table + XZ lookup grid
  length                                   // metres
  posAt(s, out?) → {x, y, z}              // y = road height AT BAKE TIME (report elevation)
  dirAt(s, out?) → unit XZ direction
  widthAt(s) → half-width metres
  nearest(x, z) → { s, d, side }          // O(1) via spatial grid; d = distance to centreline
  offsetPoint(s, lateral, out?) → {x, z}
}
export function buildTrackData(trackDef) → {
  spline, shortcutSpline?,
  checkpoints: [ { x, z, r, s, idx, big } ],   // ordered; big = has visual gate
  gridSlots:   [ { x, z, yaw } × 8 ],
  racingLine:  [ { x, z, s, speed } … ]        // ~every 6 m; speed = advisory max m/s from
}                                              // curvature + width + surface + jump flags
```
`buildTrackData` must be importable in Node (no three imports — plain math) so tests can
validate checkpoint ordering and racing-line sanity. Use plain objects, not Vector3.

## Vehicles — `vehicle.js`, `vehicle-art.js`, `vehicles.js`, `config.js`

`vehicle.js` is the solver and nothing else. Everything a car LOOKS like moved to
`vehicle-art.js` in wave 6: `buildVehicleVisuals(v, scene, spec)`,
`updateVehicleVisuals(v, dt)`, `disposeVehicleVisuals(v)` and `setGhostLook(v, k01)`.

The Vehicle still **owns** the objects — `root`, `chassis`, `wheelRoot`, `leanRoot`,
`mats`, `tex`, `geos`, `exhaust`, `paintColor` and the per-wheel `obj/hub/arm/coil/…` are
instance properties, because the dev harnesses reach in and read them. `updateVisuals(dt)`
and `dispose()` remain methods and simply delegate, so race.js and every harness are
unchanged. Physics reads none of it.


```js
// config.js — THE tuning surface. Everything gameplay-feel lives here.
export const G = 12.8;                     // arcade gravity, tuned for jump feel
export const TUNE = { steer: {...}, assists: {...}, reset: {...}, collide: {...}, air: {...} };

// vehicles.js
export const VEHICLES = [
  { id:'hopper',  name:'DUNE HOPPER', desc:'…', mass:1120, color:0x2857e0, /* full spec */ },
  { id:'ridgeback', name:'RIDGEBACK', …heavier, grippier, slower… },
  { id:'redline',   name:'REDLINE',   …fastest, twitchy… },
  { id:'moto',      name:'HORNET',    …245 kg motocross 450, bodyStyle 'bike'… },
];

// The HORNET is the one spec that needs a paragraph. It is a FOUR-CORNER
// rigid body, exactly like the cars — the solver has no idea a motorcycle
// exists — drawn as a single-track machine: vehicle.js collapses both wheels
// of an axle onto the centreline, hides one of each pair, and banks the whole
// thing about the contact line via an extra `leanRoot` group. `track` (0.74 m
// half) is therefore an INVISIBLE outrigger whose only job is keeping the
// rollover margin honest, and `antiRollBonus` 1.55 holds the body flat so the
// drawn bank is not stacked on a real roll. Everything a player feels —
// 245 kg, a third of a car's yaw inertia, the shortest wheelbase — is real.
// dev/vehicle-check.mjs section (j) gates all of it.

// vehicle.js
export class Vehicle {
  constructor(scene, terrain, spec, opts = {})   // opts: { livery: int } tint variation for AI
  placeAt(x, z, yaw)                              // settle on ground, zero motion
  step(dt, ctl)     // ctl = { throttle:-1..1, steer:-1..1, brake:0..1, handbrake:0|1 }
                    // internally substeps; reads terrain.heightAt/normalAt/surfaceAt
  sync()            // write pos/quat to the three.js root
  updateVisuals(dt) // wheels, suspension, steering, body roll accents
  dispose()
  // --- state (read by AI, camera, HUD, audio, race) ---
  pos; quat; vel; omega;            // THREE types
  get forward(); get right(); get up();
  get speed();                      // signed m/s along forward
  get speedKmh();
  wheels;        // 4 × { worldPos, contact, load, slipLong (0..1), slipLat (0..1),
                 //        spinVel, steer, surface, compVel }
  airborne; airTime; flipped;       // booleans / seconds
  surfaceId;                        // dominant surface under wheels
  hardHit;                          // peak landing/impact m/s this frame (race consumes)
  rpmNorm;                          // 0..1 engine speed proxy for audio
  spec;                             // the vehicle spec object
  // --- kart layer (wave 5) — see INTEGRATION-NOTES "Kart layer" ---
  extDriveMul; extTopMul;           // items write these; ItemWorld is the ONLY writer
  driveMul; driveTopMul;            // read-only composite: mini-turbo x external
  bodySlip; groundSpeed; spinT;     // published for miniturbo.js / spin-out
}
export function resolveVehiclePair(a, b) → impactSpeed   // impulse + separation between two
                                                          // vehicles (sphere-set model);
                                                          // race loop calls for all pairs
```
Requirements: spring/damper suspension with visible travel; speed-sensitive steering;
weight transfer; grip from surface table (`SURFACES[surfaceAt]`) via friction circle; handbrake
= rear-wheel grip cut for drifting; stable at 40+ m/s; limited air pitch/yaw control via
`ctl` while airborne; anti-roll + active self-righting torque tuned so rollovers are possible
but recoverable; landing compression feeds `hardHit`. **Fun > realism**: bias grip forward,
recover slides progressively, keep it drivable with binary keyboard input.

## Race logic — `racecore.js` (pure), `race.js`, `progression.js` (T5)

```js
// racecore.js — importable under Node, zero dependencies.
export class RaceTracker {
  constructor({ ids, laps, lapLength, checkpoints })  // checkpoints: [{x,z,r,s,idx}]
  update(id, x, z, tNow) → events[]   // [{type:'checkpoint'|'lap'|'finish'|'wrongway', …}]
  progress(id) → { lap, nextCp, raceS, liveS, lapTime, bestLap, distNext,
  //                  cpCount, wrongWay, finished, total }   // REUSED object
  standings() → [id…]                 // finished first (by time), then by raceS desc
  results() → [{ id, finished, total, bestLap, lapTimes }]
}
```
Checkpoints must be hit **in order** (radius generous: max(10, roadHalfWidth+4) m, ignore Y).
Missing one → next lap won't count until the racer goes back (HUD warns; reset offers return).
`raceS` interpolates between checkpoint `s` values via nearest-point-on-spline, clamped to
be monotonic. `liveS` is the same estimate WITHOUT that ratchet: standings read `raceS`,
anything asking "is this car moving?" reads `liveS`. (A respawn leaves `segFrac` pinned, so
`raceS` is frozen for the whole drive back to the crash — a watchdog on it deadlocks.) Shortcut legality: shortcut paths carry their own checkpoint replacing the main
ones they bypass — encode as checkpoint groups: `idx` equal ⇒ either satisfies the slot.

`race.js` drives the session: LOADING → GRID → COUNTDOWN (3-2-1-GO, inputs locked) → RUNNING →
FINISHED → RESULTS. Owns: spawning player + 5 AI, per-frame vehicle stepping, pair collisions,
reset/recovery (hold-R or auto after flipped >2.5 s / stuck >4 s / off-course >30 m (grounded
time only) / no race-line progress (`liveS`) >6 s → respawn at last checkpoint — never inside a gap
jump's void — aligned to spline, 1.5 s ghosted), timing, HUD feed, audio cues, autosave
of records. `progression.js` (pure): unlock graph, medals by finish position, records,
localStorage schema `rallye.v1` via `core/save.js`.

## Kart layer — `miniturbo.js` (pure), `items.js` (pure), `itemworld.js` (T5)

Three modules layered **on top of** the handling model, not inside it. Nothing
here changes how a tyre generates force; everything is expressed through
multipliers and through machinery the game already had.

```js
// miniturbo.js — PURE. No three, no DOM, allocates nothing after construction.
export function makeDrift()                 // the 11-field state object
export function driftReset(st)              // wipes it (placeAt calls this)
export function driftStep(st, dt, v, ctl)   // mutates st; reads v.bodySlip,
                                            // v.groundSpeed, v.contacts,
                                            // v.airborne, v.spinT
export function driftProgress(st) → 0..1    // HUD charge bar

// items.js — PURE. The table, the roulette, the inventory rules.
export const ITEM = { NONE:-1, NITRO:0, TRIPLE:1, WHEEL:2, SLICK:3, TOW:4, SLED:5, STORM:6 };
export const ITEMS       // [{ id, name, colour, charges, rear }]
export const DROP_WEIGHTS  // [6 positions][7 items] — integers, NOT normalised
export const ITEM_TUNE   // { gapShiftSec, sledLockoutM, stormMinPos }
export function rollItem(pos, field, ctx, rng) → ITEM.*
export function makeInv() / clearInv(inv) / hasItem(inv) / canTake(inv)
export function giveItem(inv, id) / consume(inv) / tickInv(inv, dt)

// itemworld.js — the live system. Owned and disposed by Race.
export class ItemWorld {
  constructor({ scene, terrain, trackData, dust, audio, feel, engine,
                racers, tracker, rng, enabled })
  step(dt, live)            // MUST run BEFORE Race._stepVehicles
  updateVisuals(dt, camera)
  fire(ri, back)            // back = firing rearwards
  pilot(ri, ctl)            // rocket-sled autopilot; overwrites ctl in place
  hudFor(ri, out) · isGhost(ri) · isSledding(ri) · hasItem(ri) · itemOf(ri)
  notifyReset(ri) · resetAll() · setEnabled(on) · dispose()
}
```

**Mini-turbo.** A drift charges; releasing it fires a boost. The charge needs
body slip past a **dual gate** — `slipHand` 0.20 rad with the handbrake down,
`slipFree` 0.34 rad without — so a throttle slide charges too, which is the
only reason the AI gets mini-turbos at all (`ai.js` sets `handbrake = 0`
unconditionally). Two triggers fire it: the handbrake DOWN→UP **edge**, or the
slide lapsing for longer than `grace`. An edge alone would make the grace
window dead code; a lapse alone would make a deliberate release feel late.

Tiers are short — `[0.12, 0.24, 0.34]` s — because the handbrake in this game
is a *rotation tool*, not a sustainable state: a measured sweep found the car
spins out after ~0.47 s inside the slip band no matter how you steer, with a
maximum single-application charge of 0.36. Tier 1 therefore fires roughly
twenty times a lap, which is why `fireTop[0]` is exactly `1.00` — it must add
punch without moving terminal speed.

**Items.** Boxes are derived from `trackData.racingLine` and a seeded RNG — no
new track data, no new file. They are **triggers, never colliders**: they are
not in `props.colliders`, so you drive through them. The trigger pass is the
same O(1) idea as the checkpoint test: one `spline.nearest()` per racer into a
**per-racer** scratch object, then a bucket lookup.

**Rubber-banding is strong by design.** `DROP_WEIGHTS` is read by row (finish
position), and a racer more than `gapShiftSec` behind the leader rolls one row
lower still. P1 draws defence only; last place draws a catch-up special about a
third of the time. `stormMinPos` and a `sledLockoutM` finish-line lockout stop
the two specials from deciding a race in its last 120 m.

**Effects reuse existing machinery — no damage system was invented.**

| Effect | How |
|---|---|
| SPIN OUT | `v.spinT = max(v.spinT, t)` plus one `v.omega.y += side * 3.2`. Vehicle forces `handbrake = 1, throttle = 0, steer = 0` while `spinT > 0`. |
| SLOW / BOOST | `v.extDriveMul` / `v.extTopMul`, recomputed from scratch every frame so there is exactly one writer and no drift. |
| BLIND | the `uBlind` uniform in the final pass (see INTEGRATION-NOTES). |
| ROCKET SLED | `ItemWorld.pilot()` writes the ctl from a racing-line follower — the same trick `dev/qa-drive.js` uses to drive the player car. |

## AI — `src/game/ai.js` (T6)

```js
export class AIDriver {
  constructor(vehicle, trackData, profile, rng)
  // profile: { name, skill 0..1, aggression 0..1, consistency 0..1 }
  update(dt, ctx) → ctl     // ctx: { vehicles, tracker, myId }
}
export function makeGridProfiles(count, difficulty) → profiles[]
```
AI follows the racing line with pure-pursuit steering + PI speed control against
`racingLine.speed` scaled by skill; brakes early for corners/jumps by look-ahead; avoids/
overtakes via lateral offset when a slower vehicle blocks the line; may take the shortcut
(probability by skill); recovers via race.js reset when flagged stuck; makes occasional
believable mistakes (noise on entry speed, late braking when aggressive). Balancing runs on
TWO axes, both on the AI's *speed targets* and never on the vehicle: the ±1.5 % ladder by
position among the six cars (`AI_BALANCE.leader`/`trailing`), and — since wave 7 — a band
against the PLAYER's gap in seconds (`AI_BALANCE.player`, replaced wholesale by the RIVALS
setting). The ladder alone kept the field beautifully balanced against itself while it drove
off up the road. Both are hard-capped and eased. **Same Vehicle physics as the player — AI
outputs only `ctl`.**

## Camera & feel — `camera.js`, `feel.js` (T8)

Chase cam: critically-damped follow, look-ahead by steering + velocity, speed-based FOV
(58→~74°), keeps horizon stable during jumps (blend to velocity-forward while airborne, no
snap on landing), terrain/prop collision avoidance, shake from `feel.js`. Modes: CHASE,
HOOD, ORBIT (podium/results). `feel.js`: `addShake(v)`, `kick(pitch)`, landing/skid/impact
routing so race.js has one call site.

## UI/HUD — `index.html`, `ui/hud.js`, `ui/styles.css`, input touch (T7)

Screens: boot/loading (per-track bake progress), main menu, vehicle select, track select,
settings, pause, results (podium + times + unlock banners), controls help. HUD: position
(e.g. 2/6), lap (e.g. 1/3), race clock, last/best lap, speed dial, minimap (baked from
heightfield + spline overlay, live racer dots), next-checkpoint arrow when off-course,
countdown overlay, wrong-way / reset prompts, transient banners. Mobile: left steering zone
(virtual wheel or L/R buttons), right throttle/brake pedals, pause + reset buttons ≥64 px,
safe-area insets, landscape-first. `input.js` gains `lastMethod` ('kb'|'pad'|'touch') updated
on any activity; UI swaps prompt glyphs from it. Keyboard: WASD/arrows drive, Space handbrake,
R reset (hold), Esc pause, C camera, M mute. Gamepad: LS steer, RT/LT throttle/brake, A
handbrake, B reset, Start pause.

## Audio — `core/audio.js` (T4)

Keep the class shape (init/resume/setVolumes/setMusic/ui). Replace content: engine =
multi-voice synth with rpm pitch + load timbre (keep pulse-train + formant approach, tuned
much higher-revving), per-surface rolling bed (gravel grains / mud slosh / sand hiss),
tyre squeal from slipLat scaled by `SURFACES[].skid`, wind above 20 m/s, jump whoosh +
landing thud + suspension clunks, collision crunches, countdown beeps (3 low, GO high),
checkpoint chime, lap bell, finish fanfare, position up/down stingers, UI ticks. Music:
menu theme + in-race driving loop (intensity input), generative, energetic but not annoying.
`update(dt, { rpm, load, speed, slipLat, slipLong, surface, airborne, contacts })`.

## Wave 6 contracts ("arcade glow-up")

Written by the lead **before** the parallel packages start, and binding on all of them. Six
agents (P1 environment & vfx, P2 vehicle art, P3 tracks, P4 air & tricks, P5 ai & items,
P6 ui/ux) work in isolated worktrees with **disjoint file ownership** — see the module map.
A package that needs something outside its files reports it; it does not reach across.

The lead has already landed the pre-wave refactors these contracts assume:
`vehicle-art.js`, the `terrain-{const,bake,shader}.js` split (plus the signed-lateral
texture below), `racefx.js`, `core/assets.js`, `kit.boostPadGeo`, and a `trick-check` stub
registered in the suite.

### 6.1 Track schema additions — `world/tracks/*.js` → `track.js` + `terrain-bake.js`

```js
difficulty: 0.55, bonus: true,                       // bonus ⇒ not in TRACK_ORDER
jumps: [{ s, len, h, gap?, name?, kind?: 'kicker'|'table'|'hip'|'drop', cp?: false,
          top?, down?,   // table: plateau length / down-ramp length
          yaw? }],       // hip: lip line angle (deg); ramp s shifts by lat·tan(yaw)
banks:  [{ s0, s1, deg }],            // authored superelevation (≤ 28°), replaces the
                                      //   curvature bank inside the span
whoops: [{ s0, s1, wl, amp }],        // rollers: wl 5..10 m, amp ≤ 0.7 m, full width
berms:  [{ s0, s1, side, h }],        // raised outer verge wall, h ≤ 2.5 (wall-ride)
routes: [{ id, name, s0, s1, path, aiBias?, jumps? }],   // generalises `shortcut`
pads:   [{ s, lat, hw?:1.6, len?:4, mul?:1.6, top?:1.10, time?:1.2 }],
```

`buildTrackData` publishes: normalised `jumps[].kind/cp/top/down/yaw`; `banks/whoops/berms`
verbatim; `routes[] = {id, name, s0, s1, spline, aiBias, jumps}` with `shortcutSpline =
routes[0].spline` kept as an alias **until all 14 shortcut consumers move**; `pads[] =
{idx, s, lat, x, y, z, dx, dz, hw, len, mul, top, time}`; `voids[] = [{s0, s1}]` (gaps and
drops, so the respawn rule is data rather than a hard-coded list); and
`elev: Float32Array(64)` for the UI's card strips.

Every jump entry still gets a lip checkpoint **unless** `cp: false`; `track-check` gates
`jumpN === jumps.filter(j => j.cp !== false).length`. Route jumps are always `cp: false`.

The theme id `thunder` is fixed. Every theme table gets an entry, each from its owner:
`SKY_THEMES`, `DUST_THEMES`, `THEMES` (palette), `KIT_PALETTE`, `RECIPES`, `DRESSING` → P1;
`THEME_BASE` → P3; `STAGE_SKIN` → P6.

### 6.2 VFX — `world/vfx.js` (P1 writes; lead, P5 and P6 call, always guarded `if (vfx)`)

```
sparks(n, x,y,z, dx,dy,dz, speed, spread, r,g,b, life)
confetti(n, x,y,z, spread)
shock(x,y,z, radius, r,g,b)
padFlash(x,y,z, dx,dz)
ribbon(id) -> { push(x,y,z), fade(), clear() }   // 14 fixed slots:
                                                 //   0–7 projectiles, 8–13 racer flames
flame(ri, on01, x,y,z, dx,dy,dz, tier)
update(dt, camera)   setViewport()   setTheme()   setQuality()   clear()   dispose()
```

≤ 3 draw calls: one additive Points pool sized by tier (400/900/1600/2400), one ribbon mesh,
one ring InstancedMesh. Smoke is **not** a new system — it is `dust.spawn(PUFF, dark)`.
Zero allocation after construction. Sprites come from `textures.js makeVfxAtlas(128)`
(SPARK / CONFETTI / RING / STREAK). Built in `main.js buildWorld`, disposed by
`Race.dispose`, `setViewport` called beside `dust.setViewport`.

VFX may use `Math.random()` — it is cosmetic and never feeds the sim.

### 6.3 Tricks — `game/tricks.js` (P4; PURE, imports `TUNE` and nothing else)

`TRICK` enum + `TRICK_NAME`: STYLE HOP, BIG AIR, 360, 720, BACKFLIP, FRONTFLIP, BARREL ROLL,
DOUBLE FLIP, COMBO, CRASH.

```
makeTrick()  -> fixed shape { qx,qy,qz,qw, pitch,yaw,roll, air, hopT, hop, wasHand,
                              launched, id, pts, tier, seq, q, best, bestPts, total, fired }
trickReset(st)          // flight only — called from placeAt
trickClear(st)          // totals too — called at the grid
trickStep(st, dt, v, ctl)   // once per frame, right after driftStep
trickLabel(id)
predictAirTime(vy, dropM, G, hang)   // shared with the AI's canned-trick planner
```

`trickStep` accumulates pitch/yaw/roll from the **body-frame delta quaternion**; on
`v.landEdge` it classifies, sets `id/pts/tier`, bumps `seq`, adds to `total`, and sets
`fired = tier` as a one-shot.

### 6.4 Vehicle publications (P4; all zeroed in `placeAt`)

`landEdge`, `landQ` (0..1), `airPeak`, `_trick`. `ctl` gains `roll` (−1..1).

**Every copy site must carry `roll`** or it works in the check and not in the game:
`vehicle.js _ctl` (P4), `race.js _pctl` (**done, pre-wave**), `ai.js this.ctl` +
`itemworld.pilot()` (P5), `input.js poll()` (P4). Dev checks tolerate absence via
`c.roll || 0`. At integration the lead greps `handbrake:` across `src/` to find any missed
one.

### 6.5 Mini-turbo hook (P4)

`export function driftFire(st, tier)` in `miniturbo.js` — "better of, never the sum", the
same rule the existing tier logic uses; sets `st.fired = tier` so `RaceFX.boost` plays the
cues that already exist. `makeDrift()`'s key set does not change (boost-check A8 counts it).

### 6.6 HUD payload additions (race.js writes, hud.js reads; pre-allocated, strings only on change)

**IMPLEMENTED in wave 7.** hud.js had all of this built since wave 5 and race.js filled in
none of it, so the pickup banner, the item icon, the race log, the mini-turbo charge arc,
the boost bar, the trick pop and the FINAL LAP banner had never once drawn.

```
vehicle: { …, drift 0..1, driftTier, boost 0..1, boostTier,
           trick: { id, name, pts, tier, seq } }        // Vehicle.hudDrift/hudTrick
race:    { …, finalLap, style, styleBest }
item:    { …, icon, seq, use, hint }                    // seq bumps when the ROULETTE LANDS
events:  { hitSeq, hitBy, hitWith, dealtSeq, dealtTo, dealtWith,
           rivalFireSeq, rivalFireBy, rivalFireWith,
           noteSeq, noteText, landSeq, padSeq }
```

`item.seq` bumps on the frame the roulette lands, **not** at pickup: `hud._itemEvent`
deliberately swallows a seq change while `rolling` is true, so a pickup-time bump produced
no banner at all. `use` is the verb on the prompt (`<NAME> — PRESS <KEY> TO <USE>`) and
`hint` an optional second line; both live on the item defs and are gated by
`dev/items-check.mjs`. `Vehicle.hudDrift(out)` / `hudTrick(out)` are allocation-free
accessors that copy out of miniturbo.js's and tricks.js's private state.

Plus `hud.setInputMethod(m)` (P6), called beside `ui.setInputMethod` — it never was until
wave 7, so the keycap read "F" on a pad — and `hud.tip(id, text, ttl)` (P6) for first-run
tips, which race.js now actually calls for `items`, `drift` and `pad`.

**`vfx` is threaded into Race.** `main.js` passes `App.world.vfx`; Race hands it to both
ItemWorld and RaceFX (which were constructed with `vfx: null`) and calls `vfx.update(dt, cam)`
each frame and `vfx.dispose()` on teardown. It was the one member of `App.world` that leaked
on every quit.

### 6.7 AI ↔ ItemWorld read-only accessors (P5 owns both sides)

`ctx.items` is supplied by race.js (**done, pre-wave**). ItemWorld exposes:

```
threats(out)        // caller-owned typed arrays: live projectiles + hazards
                    //   { n, x, z, vx, vz, r, kind }
nearestBox(ri, out)   nearestPad(ri, out)   canLock(ri)   hasItem(ri)
events              // scalars: hitSeq, hitTarget, hitOwner, hitItem,
                    //          pickSeq, pickRacer, pickItem, padSeq, padRacer,
                    //          fireSeq, fireRacer, fireItem, fireNear,
                    //          noteSeq, noteText
```

Read-only means read-only: the AI never mutates anything it reaches through `ctx.items`.
`dev/ai-check.mjs` passes a mock `ctx.items` for the new scenarios only — the AI must
early-return without one.

### 6.8 Menu scene — `ui/menuscene.js` (P6 writes, main.js drives)

```
show(kind, { trackId, vehicleId, profile })   // 'main' | 'tracks' | 'garage'
setTrack()   setVehicle()   update(dt, elapsed)   hide()   dispose()
sky                                            // for projectSun
resultsBurst(vfx, pos)
```

`hide()`/`dispose()` **must dispose its `Sky` before `buildWorld` runs** — `Sky.dispose`
restores fog and environment, and a menu sky left alive is the wrong IBL for the whole race.
UI emits `{ type: 'preview', trackId?, vehicleId? }` on card selection.

### 6.9 Items copy — `game/items.js` (P6 owns exactly three fields; P5 reads `ITEMS` read-only)

`desc`, `tip`, `icon` (`nitro | triple | wheel | slick | tow | sled | storm`). No other field
in that file moves.

### 6.10 Profile, settings, bindings

- `profile.tips = { drive, drift, air, items, pad }`, whitelisted in `defaultProfile`,
  `normalizeProfile` **and** `cloneProfile` — those are strict whitelists and a field missing
  from any one of them is silently dropped.
- `EXTRA_TRACKS = ['thunder']`; `REQUIREMENT.thunder = { track: 'canyon', podium: true }`;
  `REWARDS.canyon.tracks = ['forest', 'thunder']`; whitelist over `ALL_TRACKS`.
- Settings keys `motionFx` (0 | 0.5 | 1), `tips` (bool), `trickAssist` (0 | 1 | 2) and
  `rivals` ('easy' | 'normal' | 'hard') in `main.js DEFAULTS` (lead) and
  `ui.js SETTINGS_SPEC` (P6). `save.js` has no per-key whitelist — settings are one blob —
  so a new key needs nothing else. `rivals` drives `main.js`'s `RIVALS` table, which feeds
  both `difficultyFor()` and `AI_BALANCE.player`; `trickAssist` reaches the player's Vehicle
  through `Race`'s option bag (before wave 7 it reached no car at all).
- Bindings (P4, `input.js`): `KeyQ`/`KeyE` → `roll ∓1`; pad buttons 4/5 (LB/RB) → roll;
  handbrake **held while airborne** is the trick modifier (steer rolls instead of yaws).
  Touch is unchanged.

### 6.11 Optional assets — `core/assets.js` (lead)

`assets.get(id)` returns a texture **or null**, and null is the normal case:

| id | what | consumer |
|---|---|---|
| `sky/<theme>` | skyline panorama | P1 dome (`uSkyline`/`uSkylineOn`) — the procedural vista ring is the fallback and hides when a panorama is present |
| `ground` | `DataArrayTexture`, layers DIRT SAND ROCK MUD GRASS ROAD | P1 terrain shader (`uGround`/`uGroundOn`), close-range detail faded out by 60 m, sampled per surface id |
| `art/<trackId>` | 16:9 stage key art | P6 stage cards, race loading screen |
| `art/title` | 16:9 title key art | P6 menu backdrop |

Every path must render correctly with the map empty. See hard rule 1.

### 6.12 The signed-lateral texture (landed pre-wave)

The heightfield is single-valued and carries no lateral channel, so the shader has no way to
know where the road edge is. The bake now writes one: `baked.lat`, a `SURF_RES²` byte field
holding the signed offset across the road in half-widths, encoded around a neutral 128 and
saturating at ±1.4. `Terrain` uploads it as R8 `uLat`; the GLSL helper is

```glsl
float latAt(vec2 p);   // 0 on the crown, ±1 at the roadbed edge, ±1.4 out in the verge
```

Off the carved corridor it reads 0, so **gate every use on `roadMaskAt(p) > 0`**. P1 consumes
it (lane tones, shoulder, verge dust); P3 owns what the bake writes into it.

## Performance budgets

- HIGH tier: ≤2.4 Mpx framebuffer, ≤450 k tris in view, 6 vehicles stepped in <2.0 ms on a
  desktop core, bake <6 s desktop.
- Mobile (MEDIUM/LOW): 30 fps floor on 2020-era Android; keep the pixel-budget cap +
  adaptive governor untouched; particle pools bounded by quality tier; no allocations per frame.
- Download stays ≈ current repo size (three.js dominates). Load-to-menu <4 s desktop.

## The frame (who calls whom — integrated by T5 in main.js)

```
input.poll() → race.update(dt, raw)
  ├─ items.step(dt, live)        ← BEFORE the cars move: effects are written first
  ├─ per vehicle: ai.update / player ctl → items.pilot → vehicle.step → vehicle.sync
  ├─ resolveVehiclePair for all pairs → feel/audio hooks
  ├─ tracker.update per vehicle → events → hud/audio/progression
  ├─ terrain ruts + tyre marks + dust emission from wheel state
  └─ reset system
camera.update → terrain.update → sky.update → props.update → dust.update
audio.update → hud.update → engine.render
```

## Wave 8 contracts ("wasteland glow-up")

**Hard rule 1 is amended again.** Wave 6 said "no generated 3D and no generated audio:
those stay procedural." This wave ships both — vehicle carcasses, hero props, five music
tracks and a sample bank — under exactly the same terms as the images, and no weaker ones:
relative URLs, non-blocking loads, a missing file resolves to `null` and never to a
rejection, and **every consumer keeps its procedural path as the fallback**. Rename
`assets/` aside and the game still runs, still races, still sounds like a game, and logs
zero console errors. That is a QA gate. What changes is only the *kind* of file allowed in
`assets/`, never the promise about it.

Models do NOT load through `assets.js`. A GLB is megabytes; `assets.js` loads its whole
manifest at boot because a texture is not. See 8.6.

### 8.1 Arsenal state on `Vehicle` (P3 writes, P2 reads)

Published fields, all zeroed by `placeAt()` like every other publication in 6.4:

| field | type | meaning |
|---|---|---|
| `v.ammo` | int | rockets in the tube |
| `v.ammoCap` | int | from `LAUNCHERS[spec.id].ammoCap` |
| `v.nitroT` | s | nitro burn remaining, 0 when not boosting |
| `v.reloadT` | s | time until the next shot is allowed |

`extDriveMul` / `extTopMul` keep **one writer**: Arsenal. Nitro multiplies through those
two, exactly where the old NITRO item did. The mini-turbo keeps its own separate path.

### 8.2 Launcher geometry (P2 owns the field, P3 reads)

`vehicles.js` gains per spec:

```js
launcher: { x, y, z, pitch, tubes }   // body-space mount, metres and radians
```

`Vehicle.muzzleWorld(out)` — P2, published from `vehicle-art.js` as `v._muzzle` — writes
the world-space muzzle position into `out` and returns the world-space forward as a second
scratch. Allocation-free, valid whether or not a GLB loaded.

`LAUNCHERS[id]` — reload, rocket speed, splash radius, `ammoCap` — lives in P3's
`weapons.js`, not in `vehicles.js`. Deltas between machines stay ≤ 15 % this pass: they say
"different quality", not "different weapon". Converging or diverging them is a later call.

### 8.3 HUD payload (P3 writes, P6 reads)

The `item` block is **replaced**, not extended:

```js
arsenal: { enabled, ammo, ammoCap, reloadT, nitroT,
           pickupSeq, pickupKind, pickupText, fireSeq }
```

`events` keeps its existing shape: `hitSeq/hitBy/hitWith`, `dealtSeq/dealtTo/dealtWith`,
`rivalFireSeq/…`, `noteSeq/noteText`, `padSeq`, `landSeq`. Pre-allocated, strings only on
change (6.6 still applies). `hud.setInputMethod` is unchanged. FIRE is **F / X / on-screen
FIRE**, and holding reverse fires backwards.

### 8.4 Post-fx nitro

`engine.final.uniforms.uNitro` — 0..1, added by P1 with the GLSL that reads it. Written by
**`feel.js` alone**, via `feel.nitro(k01)`; `feel.reset()` zeroes it, and `camera-check`
gates that reset. The effect lives **inside the existing final pass** — no new pass:
radial blur ×2.2, a blue-white chromatic push, a vignette pinch, and a 1.5 % zoom warp.

### 8.5 Sky

`new Sky(renderer, scene, quality, theme)` and every existing method keep their names —
`update`, `setQuality`, `dispose`, `projectSun`, `setSkyline`, `refreshEnv`, `markEnvDirty`,
`setFogEnabled`, `sunDir`, `sunColor`, `hazeColor`, `horizonColor`. `menuscene.js`,
`garage.js`, `firstlight.js` and `main.js` all depend on them.

New: `sky.setEnvImage(tex|null)` — an equirect texture, when set, wins over the shader env.

`SKY_THEMES[t]` gains `turbidity, rayleigh, mie, mieG, skyExposure`. `hazeColor` and
`horizonColor` become **derived** from the physical model rather than authored, so the
`FogExp2` colour, the terrain haze uniform in `main.js syncSun`, and the dome cannot
disagree.

### 8.6 Assets

`assets/manifest.json` gains two kinds, both added to `core/assets.js` by the lead:

- **`equirect`** — id `env/<theme>`, `EquirectangularReflectionMapping`, sRGB, no mipmaps
  (PMREM builds its own chain). Read with `assets.get(id)`.
- **`model`** — id `models/<id>`, **url only**. `assets.js` records the resolved relative
  url as a string and issues no request. Read it with **`assets.url(id)`**;
  `assets.get(id)` deliberately returns `null` for a model, because handing a string to
  something expecting a `Texture` fails deep inside three, a long way from the typo.

`src/core/models.js` (lead) does the lazy loading:

```js
loadModel(url) -> Promise<THREE.Group|null>   // never rejects; null means "use your fallback"
disposeModel(group)                            // the instance's cloned materials only
clearModelCache()                              // the shared templates: geometry + textures
modelCacheSize()
```

The cache holds one **template** per url and every call returns its own instance: node tree
cloned, **materials cloned**, geometry and textures shared. Two rivals on the same machine
need two Groups, and liveries/`mudify()`/the ghost overlay all write to materials — sharing
those would let the second car to load win for both. Node never imports this file.

### 8.7 Music and SFX (P5)

`audio.setRaceTheme(theme)` — P5 writes it, P3 adds the single call in `race.js _enterGrid`.

Every new cue is a method on `Audio` with a synth fallback behind it:
`rocketFire(gain,pan)`, `rocketFlyby(pan)`, `rocketHit(gain,pan,near)`, `ammoPickup()`,
`nitroPickup()`, `nitroBurst()`, `ammoEmpty()`, `crateBreak(gain)`.

### 8.8 Arsenal kit — `src/world/kit-arsenal.js` (P3 owns)

```js
rocketCrateGeo(P, seed)   nitroCanGeo(P, seed)
rocketGeo(P, seed)        launcherGeo(P, seed, tubes)
```

Same attribute set as `kit.js` — position + normal + color, **no uv** — and every shape
stands on y = 0. P2 imports `launcherGeo` and `rocketGeo` for the mount and the ammo rack.
P4's `kit-check` gates all four alongside its own factories.

### 8.9 Hero models in the dressing plan (P4)

```js
DRESSING[theme].heroModels = [{ id, url, s, lat, yaw, scale, r, fallback }]
```

`props.js` loads them through `models.js`, places each at `heightAt`, and gives each **one
fixed collider** of radius `r`. A missing file falls back to the named kit shape — which
means the collider and the silhouette must be right in both cases.

### 8.10 Settings

The setting key `items` becomes `weapons` (bool). The lead migrates it in `main.js boot()`
(`weapons ??= items`); P6 renames the row and its help text.

The record flags `itemsTotal` / `itemsLap` in `progression.js` **keep their names** — they
are a locked whitelist and renaming them invalidates every saved profile. Their label reads
"set with weapons on".

### 8.11 AI context (P3 owns both sides)

`ctx.items` becomes `ctx.arsenal`, with `threats(out)`, `nearestPickup(ri,out)`,
`nearestPad(ri,out)`, `ammoOf(ri)`. The mock in `dev/ai-check.mjs` is renamed to match.

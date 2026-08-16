# RALLY ROAD RASH — Architecture & Interface Contracts

**RALLY ROAD RASH** is a 3D arcade off-road rally racing game: one player + 5 AI racers, themed tracks
(desert canyon, forest/mountain, volcanic badlands, plus a training ground), laps, checkpoints,
big jumps, progression and unlocks. Desktop (keyboard/gamepad) + mobile (touch), 60 fps target.

The house style is vanilla ES modules, **zero npm dependencies, no build step**, vendored
three.js r160, everything generated procedurally at load time.
This document is the binding contract between modules. **If you need to change a contract,
stop and flag it in your report instead of unilaterally changing it.**

## Hard rules (all contributors)

1. **No new dependencies. No asset files. No network fetches.** Everything is code-generated
   (canvas textures, procedural geometry, WebAudio synthesis).
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
index.html                shell, overlays, HUD markup            [T7 ui]
server.js                 static server (unchanged)              [locked]
src/
  main.js                 bootstrap, app state machine, frame    [T5 race-flow]
  core/
    engine.js             renderer, quality tiers, composer      [T3 environment: light rig only]
    input.js              kb/mouse/gamepad/touch                 [T7 ui: touch + input-method detect]
    audio.js              procedural WebAudio                    [T4 audio]
    rng.js                noise/PRNG helpers (unchanged)         [locked]
    save.js               localStorage wrapper                   [T5 race-flow]
  world/
    terrain.js            bake, clipmap, surface map, ruts       [T1 terrain]
    track.js              spline, road carve, checkpoints, grid  [T1 terrain]
    tracks/index.js       registry: TRACKS list                  [T1 terrain]
    tracks/training.js    PROVING GROUNDS (tutorial)             [T1 terrain]
    tracks/canyon.js      SUNSTRIKE CANYON (desert, gap jumps)   [T1 terrain]
    tracks/forest.js      TIMBERLINE CLIMB (mud, narrow, ramps)  [T1 terrain]
    tracks/volcano.js     CALDERA RUN (extreme, biggest jumps)   [T1 terrain]
    surfaces.js           surface-type table (shared data)       [T1 terrain]
    props.js              rocks/trees/barriers/gates + colliders [T1 terrain]
    sky.js                day skies per theme, sun, clouds, IBL  [T3 environment]
    dust.js               atmospheric dust/mud/debris particles  [T3 environment]
    textures.js           shared procedural texture helpers      [T3 environment]
  game/
    config.js             ALL gameplay tuning in one place       [T2 vehicle]
    vehicle.js            4-wheel rigid-body vehicle + visuals   [T2 vehicle]
    vehicles.js           the three vehicle specs                [T2 vehicle]
    racecore.js           PURE race logic (no three, no DOM)     [T5 race-flow]
    race.js               race session: countdown→results        [T5 race-flow]
    progression.js        PURE unlocks/records (no three/DOM)    [T5 race-flow]
    ai.js                 AI drivers                             [T6 ai]
    camera.js             chase camera, shake, FOV, look-ahead   [T8 camera-feel]
    feel.js               game-feel triggers (shake/fx routing)  [T8 camera-feel]
  ui/
    hud.js                HUD, minimap, banners, results         [T7 ui]
    styles.css            responsive layout, touch-safe          [T7 ui]
tests/                    node:test suites for pure modules      [T9 qa]
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

## Terrain — `src/world/terrain.js` (T1)

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

## Vehicles — `src/game/vehicle.js`, `vehicles.js`, `config.js` (T2)

```js
// config.js — THE tuning surface. Everything gameplay-feel lives here.
export const G = 12.8;                     // arcade gravity, tuned for jump feel
export const TUNE = { steer: {...}, assists: {...}, reset: {...}, collide: {...}, air: {...} };

// vehicles.js
export const VEHICLES = [
  { id:'hopper',  name:'DUNE HOPPER', desc:'…', mass:1250, color:0xff7a1a, /* full spec */ },
  { id:'ridgeback', name:'RIDGEBACK', …heavier, grippier, slower… },
  { id:'redline',   name:'REDLINE',   …fastest, twitchy… },
];

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
  progress(id) → { lap, nextCp, raceS, lapTime, bestLap }
  standings() → [id…]                 // finished first (by time), then by raceS desc
  results() → [{ id, finished, total, bestLap, lapTimes }]
}
```
Checkpoints must be hit **in order** (radius generous: max(10, roadHalfWidth+4) m, ignore Y).
Missing one → next lap won't count until the racer goes back (HUD warns; reset offers return).
`raceS` interpolates between checkpoint `s` values via nearest-point-on-spline, clamped to
be monotonic. Shortcut legality: shortcut paths carry their own checkpoint replacing the main
ones they bypass — encode as checkpoint groups: `idx` equal ⇒ either satisfies the slot.

`race.js` drives the session: LOADING → GRID → COUNTDOWN (3-2-1-GO, inputs locked) → RUNNING →
FINISHED → RESULTS. Owns: spawning player + 5 AI, per-frame vehicle stepping, pair collisions,
reset/recovery (hold-R or auto after flipped >2.5 s / stuck >4 s / off-course >30 m (grounded
time only) / no race-line progress >6 s → respawn at last checkpoint — never inside a gap
jump's void — aligned to spline, 1.5 s ghosted), timing, HUD feed, audio cues, autosave
of records. `progression.js` (pure): unlock graph, medals by finish position, records,
localStorage schema `rallye.v1` via `core/save.js`.

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
believable mistakes (noise on entry speed, late braking when aggressive). Balancing: mild —
±4 % top-speed handicap by position, hard-capped, documented in config. **Same Vehicle
physics as the player — AI outputs only `ctl`.**

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

## Performance budgets

- HIGH tier: ≤2.4 Mpx framebuffer, ≤450 k tris in view, 6 vehicles stepped in <2.0 ms on a
  desktop core, bake <6 s desktop.
- Mobile (MEDIUM/LOW): 30 fps floor on 2020-era Android; keep the pixel-budget cap +
  adaptive governor untouched; particle pools bounded by quality tier; no allocations per frame.
- Download stays ≈ current repo size (three.js dominates). Load-to-menu <4 s desktop.

## The frame (who calls whom — integrated by T5 in main.js)

```
input.poll() → race.update(dt, raw)
  ├─ per vehicle: ai.update / player ctl → vehicle.step → vehicle.sync
  ├─ resolveVehiclePair for all pairs → feel/audio hooks
  ├─ tracker.update per vehicle → events → hud/audio/progression
  ├─ terrain ruts + tyre marks + dust emission from wheel state
  └─ reset system
camera.update → terrain.update → sky.update → props.update → dust.update
audio.update → hud.update → engine.render
```

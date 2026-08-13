# Integration notes — as-built module facts

Living document maintained by the lead. Wave-2+ contributors: treat this as authoritative
addenda to ARCHITECTURE.md — it records what each module ACTUALLY shipped.

## Audio (src/core/audio.js) — DONE, 1311 lines

Public API as built:
- Lifecycle: `init(external?)` (must run inside a user gesture), `resume()`, `now()`,
  `setVolumes(sfx, music)`, `setMusic(on)`, `ui('tick'|'ok'|'back'|'hover'|'bad'|'warn')`.
- `setEngineCharacter(specOrId)` — vehicle spec object, `{family}`, or id string.
- `setDriving(on)` — gates the whole car layer; false in menus/pause/results.
- `setMusicMode('menu'|'race'|'off')` — 0.4–0.8 s crossfade. `musicTick(t, intensity)` per frame.
- `update(dt, {rpm, load, speed, slipLat, slipLong, surface, airborne, contacts, scrape,
  rivalRpm, rivalPan})` once per frame, all fields optional/clamped.
- One-shots: `clunk(f,pan)`, `bottomOut(f,pan)`, `thud(f)`, `land(f,surface?)`,
  `jumpWhoosh(f)`, `crash(f,pan)`, `scrape(surface,amount)`, `countdownBeep(n)`,
  `countdownGo()`, `checkpoint()`, `lapBell(final)`, `finishFanfare(won)`, `positionUp()`,
  `positionDown()`, `unlockJingle()`, `wrongWay()`, `resetWhoosh()`, `ping(...)`.
- REMOVED: `chirp/echo/discovery/radio` (old gameplay.js would throw — it is dead, delete it).

Race-flow obligations:
- Grid: `setEngineCharacter(playerSpec)` → `setDriving(true)` → `setMusicMode('race')`
  BEFORE countdown. Countdown: `countdownBeep(3/2/1)` at 1 s marks, `countdownGo()` on green,
  start feeding real rpm in `update` the same instant.
- Per wheel: `clunk((compVel-thr)*k, side*0.45)`; `bottomOut` on travel exhaustion;
  `land(hardHit*k, surfaceId)` once per touchdown; `jumpWhoosh` on lip departure.
- Intensity policy: `0.30 + 0.22*(lap/(laps-1))`, floor 0.70 final lap, +0.20 rival within
  ~12 m, +0.05 leading, clamp 0..1. Do not pre-smooth.
- Rival voice: `rivalRpm`/`rivalPan` for nearest rival <40 m else null; don't swap rival
  more than ~1/s.
- MUST add `audio.resume()` on `visibilitychange`/`focus` (iOS re-suspends) — T5/T7.
- `update()` exactly once per frame (shift detector not idempotent).

## Environment (sky.js 661 / dust.js 428 / textures.js 255 / engine.js light rig) — DONE

- `SKY_THEMES` exported from sky.js is the AUTHORITATIVE per-theme lighting table
  (sunDir/sunColor/hemi/zenith/horizon/haze/fog/clouds). Terrain does NOT hardcode sun:
  race flow passes `sky.sunDir` into `terrain.update(dt, camera, sky.sunDir)` (bakes the
  occlusion mask once on first change) and copies sun colors into terrain uniforms at race
  setup, REGOLITH `syncSun` style.
- `new Sky(renderer, scene, quality, themeName)`; statics per race; `sky.sunMesh` is the
  billboard (`engine.sun` remains the DirectionalLight). `sky.projectSun(camera, out)` feeds
  `engine.final.uniforms.uSunUV` (replaces old main.js flare math).
- Sky sets `scene.fog` (FogExp2, theme fogHint) — affects standard materials (props,
  vehicles); terrain ShaderMaterial unaffected (does its own haze). `setFogEnabled(false)`
  to opt out; `dispose()` restores.
- `engine.setLightTheme(SKY_THEMES[theme])` per race (pass whole theme object).
- Dust: `new Dust(scene, terrain, sunDirRef, max, theme)`; `DUST_KIND {PUFF,CLOD,EMBER}`;
  `spawn(n,x,y,z,force,spread,dirX,dirZ, r,g,b, kind)`; `burst(x,y,z,heading,force,col)`;
  `setTheme`, `setWind`, `dispose`. REQUIRED: `dust.setViewport(drawingBufferHeight)` at boot
  and in every resize path. Dust imports `G` from src/game/config.js (T2 file).
- engine.js: `_configureShadow()` extracted (fixes LOW→HIGH shadow box bug); final-pass
  defaults now uGrain 0.35 / uAberr 0.5 / uVignette 0.85.
- Race-flow wiring per frame: `sky.update(dt, camera, elapsed)`, `dust.update(dt)`,
  `engine.aimShadow(playerPos, sky.sunDir)`.
- T5 must strip main.js of Earth/Moon texture plumbing (loadTextures block, uAlbedoTex
  assignment) — textures.js no longer exports those makers.
- Lead follow-ups at integration: try bloom threshold ~1.4 for daylight (currently 1.15);
  watch near-camera gl.POINTS dust clipping; `QUALITY.stars` now dead data.

## Vehicle (config.js 327 / vehicles.js 212 / vehicle.js 1342) — DONE, 102/102 gates

- `G = 12.8` and `TUNE` live in src/game/config.js (groups: steer, assists, air, reset,
  collide, drift, drive, tyre, susp, aero, sim). `VEHICLES`, `VEHICLE_BY_ID`,
  `statBars(spec)` in vehicles.js. Specs: hopper 36 m/s understeery-friendly, ridgeback
  32 m/s heavy/planted (won't swap ends), redline 41 m/s throttle-rotates.
- Race-flow wiring: `v.step(dt, ctl)` for all → `resolveVehiclePair(a,b)` each pair once →
  THEN read `v.hardHit` (step zeroes it, collisions max into it). Reset = `placeAt(x,z,yaw)`
  (aligns to ground normal, zeroes motion); set `v.ghost = true` for TUNE.reset.ghostTime
  after respawn — pair resolver early-returns on ghosts. `flipped` latches per TUNE.reset.
  Thresholds in TUNE.reset verbatim (flipTime 2.5, stuckTime 4, stuckSpeed 1.2,
  offCourseDist 25, ghostTime 1.5, holdTime 0.8).
- AI contract: output only ctl; throttle opposite travel >1.2 m/s = braking (not reverse);
  built-in countersteer assist catches slides if AI just aims at the line; yaw rate capped
  2.0 rad/s. Read spec.topSpeed as honest terminal speed.
- Camera reads: pos, quat, speed, airborne, airTime, hardHit, contacts, `_accelLong`,
  `_accelLat` (filtered). Body lean is visual-only on the `chassis` child — never add
  camera lean from accel on top blindly.
- Audio reads: `rpmNorm` (virtual 5-speed sawtooth 0.35→1, low-passed, blips on shift),
  `rpm`, slipLat/slipLong (getters), surfaceId, contacts, motorLoad.
- HUD reads: speedKmh, gear, lap-relevant state comes from race core.
- Jump ballistics at G=12.8: 20° kicker @30 m/s = ~56 m air, 1.9 s hang; 12° = ~37 m.
  Track design (T1) and par times should assume these.
- Risks flagged: watch hard-floor failsafe firing on real terrain (means suspTravel/comHeight
  mismatch — fix spec, not floor); surface sampled once per step per wheel (fine at ~1 m
  texels); livery canvas per instance (cache if grid grows).

## Terrain/tracks/props (terrain.js 1709 / track.js 714 / tracks/* / props.js 946) — DONE

- Tracks: training 900 m (7 cp, 2 jumps, laps 1), canyon 1600 m (13 cp + 1 alt, 4 jumps
  incl. 15 m gap needing ≥24.2 m/s, slot-canyon shortcut), forest 1800 m (14 cp + 2 alt,
  3 wooden-ramp jumps, high-route shortcut, 58 m climb), volcano 2000 m (16 cp, 4 jumps,
  biggest 3.6 m lip / 12 m gap over lava, 19% grades). All deterministic; bake 0.4–0.8 s
  in Node; road fidelity within 0.3 m everywhere; only jump lips are sharp.
- `bakeTrack(trackDef, report)` generator → baked carries `{theme, trackDef, trackData}`;
  `new Terrain(renderer, baked, quality, caps, trackDef)`; **terrain.spline and
  terrain.trackData are pre-populated — do NOT call buildTrackData again** (14–24 ms).
- REMOVED exports: `MOON_G`, `bakeTerrain`, `baseHeight`, `HOME`, `RIM_R/RIM_W`,
  `Terrain.excavate`. CHANGED: `MACRO_EXT` 1200→1360, `DENT_EXT`→1200. NEW exports:
  `PLAYABLE_EXT 600`, `PLAYABLE_R 620`, `THEMES`, `themePalette(theme)`,
  `themeBaseFn(theme)`. `terrain.update(dt, camera, sunDir?)` — sunDir optional
  (defaults to theme's static sun); occlusion mask bakes once.
- Terrain has its OWN THEMES lighting table (sun dir/colour per theme) — differs from
  sky.js SKY_THEMES numbers. INTEGRATOR RECONCILIATION: race flow copies `sky.sunDir` /
  sky colours into terrain uniforms at race setup (`syncSun` pattern) so the shadow bake,
  vehicle lighting, and sky agree; terrain THEMES remain the shader-palette source.
- `trackData`: checkpoints `{x,y,z? r,s,idx,jump,alt,altS}` sorted by (idx, alt) — equal
  idx = one slot, either satisfies (RaceTracker must honour); gridSlots `{x,z,y,s,yaw}`;
  racingLine every 6 m `{x,y,z,s,lat,speed,k,surface,jump}` with brake/accel propagation
  applied (AI scales by skill, doesn't re-derive); `jumps` with kicker geometry; `walls`;
  `lapLength = spline.length`. `spline.nearest(x,z,out)` ~0.25 µs — PASS A PER-CALLER
  `out` (default is module scratch). `curvatureAt(s)` signed, + = left.
- `paintAt(trackDef, s, x, z, lat, L)` shared by bake and racing line; paints support
  `lat0/lat1` lateral bands. LAVA retuned in surfaces.js (grip 0.55, drag 0.038); lava
  DAMAGE (if wanted) keys off `surfaceAt()===SURF.LAVA` in race logic.
- Props: `new Props(scene, terrain, quality, trackDef, trackData)`; `resolve(vehicle)`
  reads `.pos/.vel/.omega/.collideR` (vehicle should expose collideR ≈ 1.15); barrier
  segment colliders + circle colliders; gates/gantry/finishStripe built from trackData;
  zero scatter on roadbed; `dispose()` complete.
- Risks for integrator: shaders never GPU-compiled (first-light needed); in-view tris
  ~500 k at HIGH vs 450 k budget → if needed drop QUALITY.high.clipM 160→144 first;
  shortcut rejoin seams roughest ground (≤0.28 m); training cp spacing 70–187 m.

## Wave-2 cross-module contracts (BINDING for T5/T6/T7/T8)

### App flow (T5 main.js owns the state machine)
BOOT → MENU → TRACKS (select, locked show unlock hint) → GARAGE (vehicle select w/ stat
bars) → RACE-LOADING (per-track bake w/ progress) → RACE (GRID → COUNTDOWN → RUNNING →
FINISHED → RESULTS) → MENU. Pause available in RACE. Quick-restart from pause/results.
Championship default path: next-uncleared track preselected.

### UI facade — src/ui/ui.js (T7 implements, T5 consumes)
```js
export class UI {
  constructor(save)                      // reads settings for toggles
  boot(p01, msg)                         // loading bar (also used for per-race bake)
  bootDone()
  show(screen, data)  // 'main'|'tracks'|'garage'|'settings'|'pause'|'results'
  hide(screen?)       // no arg = hide all screens
  on(fn)              // single action callback: fn({type, ...})
  // action types: {type:'race', trackId, vehicleId} {type:'resume'} {type:'restart'}
  // {type:'quit'} {type:'settings', key, value} {type:'nextTrack'} {type:'back'}
  setInputMethod(m)   // 'kb'|'pad'|'touch' → swaps prompt glyphs
}
```
- 'main' data: { canContinue:false (no mid-race save), progression, records }
- 'tracks' data: { tracks:[{id,name,tagline,laps,locked,lockHint,medal,best,bestLap}], champion }
- 'garage' data: { vehicles:[{spec,locked,lockHint,stats:statBars(spec)}], trackId }
- 'results' data: { placements:[{name,isPlayer,total,bestLap,dnf}], playerPos, medal,
  unlocks:[strings], newRecord:{total?,lap?}, trackId, nextTrackId? }
- 'pause' data: { trackName, position, lap }
- 'settings' data: { settings } — controls listed under Settings keys below.

### HUD — src/ui/hud.js (T7 implements; T5 feeds)
```js
hud.showRace({trackName, laps, racers:[{id,name,color,isPlayer}]})
hud.hideRace()
hud.bakeMap(terrain, trackData)          // minimap bg: heightfield shade + road ribbon
hud.update(dt, {
  race: {state, countdown, position, total, lap, laps, raceTime, lastLap, bestLap,
         wrongWay, resetHold, offCourse},   // times seconds; countdown 3..0 or -1
  vehicle: {speedKmh, gear, rpmNorm, airborne, airTime},
  dots: [{x,z,color,isPlayer}],          // world XZ; hud projects via its baked map transform
  rival: {name, gap} | null              // gap seconds, signed (negative = behind you)
})
hud.countdown(n)      // 3,2,1 then hud.countdown('GO') — big center overlay
hud.banner(text, kind='good', ttl=2.2)   // 'good'|'warn'|'bad'
hud.log(text, kind)
hud.airtime(sec)      // brief "AIR 1.9s" flourish on landing (T5 calls on touchdown >0.8s)
```

### Feel — src/game/feel.js (T8 implements; T5 calls)
```js
export class Feel {
  constructor(rig, engine)               // camera rig + engine (for final-pass uniforms)
  update(dt, vehicle)                    // continuous: speed shake, fov support
  landing(hardHit); collision(impact, worldDir); jump(); nearMiss()
  reset()                                // clear transients on respawn/race start
}
```

### Camera — src/game/camera.js (T8)
```js
export const CAM = { CHASE:0, HOOD:1, ORBIT:2 };
rig = new CameraRig(camera, terrain); rig.setMode(m, vehicle); rig.cycle(vehicle)
rig.update(dt, vehicle, look {lookX, lookY, zoom})   // reads vehicle state directly
rig.addShake(v); rig.fovScale; rig.sens; rig.autoCentre  // settings-driven
rig.snapBehind(vehicle)   // hard reset behind car (race start / respawn)
```

### AI — src/game/ai.js (T6) — NO three imports (plain math)
```js
export class AIDriver {
  constructor(id, vehicle, trackData, profile, rng)
  update(dt, ctx) -> ctl {throttle, steer, brake, handbrake}
  // ctx: { vehicles:[Vehicle], tracker, myId, state:'countdown'|'running'|'finished' }
  wantsReset       // true when flipped/stuck beyond thresholds — race flow performs it
  notifyReset()    // race flow calls after performing the respawn
}
export function makeGridProfiles(count, difficulty01, rng) -> profiles
```
- During 'countdown': full brake, small throttle blip on last beat allowed.
- After 'finished': cruise at 40% throttle following line (podium drive-off handled by T5).

### Input (T7 owns input.js changes)
poll() → {throttle -1..1, steer -1..1, brake 0..1, handbrake 0|1, lookX, lookY, zoom}
Keyboard: W/S or Up/Down throttle/brake-reverse; A/D steer; Space handbrake; R reset
(hold); C camera; Esc pause; M mute. Gamepad: LS steer, RT/LT, A handbrake, B reset,
Y camera, Start pause. Touch: left steer zone, right GAS/BRAKE pedals, PAUSE/RESET/CAM
buttons. `input.lastMethod` ∈ 'kb'|'pad'|'touch' updated on any activity. Reset semantics:
race flow reads `input.down('KeyR')`/pad B/touch RESET as a HOLD (progress in
race.resetHold), not edge.

### Settings keys (Save.settings(), applied by T5, edited via UI 'settings')
quality ('low'|'medium'|'high'|'ultra'), fov (42..82 base 58), sens, volSfx, volMusic,
music (bool), camMode, invertY, hudScale, grain (0|0.35|1), autoCentre (0|1|2),
showTouch ('auto'|'on'|'off')

### Standings/timing source of truth
racecore.RaceTracker per ARCHITECTURE.md. race.js owns wall-clock (raceTime starts at GO).
progression.js decides medals/unlocks from final placements; race.js reports via UI results.

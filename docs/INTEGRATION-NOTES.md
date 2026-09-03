# Integration notes — as-built module facts

## FIRST LIGHT (integrator, browser, HIGH tier) — PASSED all 4 tracks
- All wave-1 systems render together on GPU at 56–57 fps: terrain + road ribbon + surface
  albedos, sky/clouds/haze per theme, props (cones/barrels/rails/signs/rocks/trees/basalt),
  wheel dust, all 3 vehicles driving the racing line, jumps launch (~1.6 s air observed).
- FIXED during first light: `patch` → `pch` in terrain fragment shader (`patch` is a
  reserved word in ESSL 3.00 — terrain failed to compile on WebGL2 at all); added
  `precision highp sampler2D;` to TERRAIN_GLSL + sun-mask shader (lowp sampler default
  would break R32F heights on strict GLES); un-reversed a smoothstep in the shadow-edge
  fade (UB per spec).
- Steering sign convention CONFIRMED on GPU: positive ctl.steer turns RIGHT (−X);
  target-right ⇒ cross(f→v) > 0 ⇒ steer = +atan2(cross, dot)·k. (An inverted-sign
  controller drives to the horizon — symptom: d grows monotonically.)
- Dev harness: dev/firstlight.html?track=id&veh=id (server: `node server.js 5490`).
  window.__FL exposes {veh, terrain, engine, fps}.
- Visual polish backlog (wave 3): pale streak artifact on distant canyon hillside;
  forest tree density near track too sparse (more corridor feel); ROAD "two-tone"
  comment in terrain.js describes an effect the flat road mask can't produce (either
  bake lateral offset into a channel or fix the comment); surface-id dither in shader
  vs undithered CPU surfaceAt (~0.75 m visual/physical divergence — intentional,
  document); baked sun mask marches mipped field vs sunVis base level (soft divergence,
  acceptable); unroll pragma in surface loop is regex-fragile — do not reformat it.

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
  setup, `syncSun` style.
- `new Sky(renderer, scene, quality, themeName)`; statics per race; `sky.sunMesh` is the
  billboard (`engine.sun` remains the DirectionalLight). `sky.projectSun(camera, out)` feeds
  `engine.final.uniforms.uSunUV` (replaces old main.js flare math).
- Sky sets `scene.fog` (FogExp2, theme fogHint) — affects standard materials (props,
  vehicles); terrain ShaderMaterial unaffected (does its own haze). `setFogEnabled(false)`
  to opt out; `dispose()` restores.
- `engine.setLightTheme(SKY_THEMES[theme])` per race (pass whole theme object).
  It also reads the optional `grade` field (an [r,g,b] multiplier) and writes it to
  the final pass's `uGrade`. That uniform exists SEPARATELY from `uExposure`
  because feel.js owns uExposure, holds it at exactly 1.0 and dips it on landings,
  and dev/camera-check gates that it returns to 1.0 — a stage that simply wants to
  be a stop darker has nowhere else to say so. The engine caches the grade and
  re-applies it in buildComposer(), or a quality change would silently brighten
  the stage.
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

## Vehicle (config.js 363 / vehicles.js 216 / vehicle.js 1458) -- DONE, 102/102 gates

- `G = 12.8` and `TUNE` live in src/game/config.js (groups: steer, assists, air, reset,
  collide, drift, drive, tyre, susp, aero, sim). `VEHICLES`, `VEHICLE_BY_ID`,
  `statBars(spec)` in vehicles.js. Specs: hopper 39 m/s understeery-friendly, ridgeback
  34 m/s heavy/planted (won't swap ends), redline 45 m/s throttle-rotates.
- Race-flow wiring: `v.step(dt, ctl)` for all → `resolveVehiclePair(a,b)` each pair once →
  THEN read `v.hardHit` (step zeroes it, collisions max into it). Reset = `placeAt(x,z,yaw)`
  (aligns to ground normal, zeroes motion); set `v.ghost = true` for TUNE.reset.ghostTime
  after respawn — pair resolver early-returns on ghosts. `flipped` latches per TUNE.reset.
  Thresholds in TUNE.reset verbatim (flipTime 2.5, stuckTime 4, stuckSpeed 1.6,
  noProgressDist 4, noProgressTime 6, offCourseDist 30, offCourseTime 2.5,
  ghostTime 1.5, holdTime 0.8). Recovery hardening this pass: stuckSpeed was 1.2 (a
  car beached on a slope could slide backward through the window forever);
  offCourseDist was 25 (raised to give the longer arcade air room to land before
  being judged); noProgress is the new watchdog underneath every other gate, keyed
  off race-line progress so a beached car cannot fake it, and airborne time never
  counts against it.
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

- Tracks: training 900 m (9 cp, 4 jumps, laps 1), canyon 1600 m (14 cp + 1 alt, 7 jumps
  incl. a 24 m gap needing ~26 m/s, slot-canyon shortcut), forest 1800 m (15 cp + 2 alt,
  5 wooden-ramp jumps incl. an 18 m gap, high-route shortcut, 58 m climb), volcano 2000 m
  (16 cp, 5 jumps, biggest 5.0 m lip / 24 m gap over lava, 19% grades). All deterministic;
  bake 0.4-0.8 s in Node; road fidelity within 0.3 m everywhere; only jump lips are sharp.
- `bakeTrack(trackDef, report)` generator → baked carries `{theme, trackDef, trackData}`;
  `new Terrain(renderer, baked, quality, caps, trackDef)`; **terrain.spline and
  terrain.trackData are pre-populated — do NOT call buildTrackData again** (14–24 ms).
- REMOVED exports: `bakeTerrain`, `baseHeight`, `HOME`, `RIM_R/RIM_W`,
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
  rival: {name, gap} | null,             // gap seconds, signed (negative = behind you)
  item: {id, name, colour, charges, rolling} | null   // power-up slot (wave 5)
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

### Race flow — AS BUILT (T5 done, 104/104 racecore checks incl. mutation testing)
- Race.dispose() owns the whole world (terrain/sky/props/dust/vehicles) built by main.js
  during LOADING. Racecore: checkpoint groups fold by idx ("slots"); nextSlot starts at 1
  (slot 0 = start line ⇒ satisfying it always completes a lap); raceS ratchets (monotonic);
  wrongway on separate unratcheted estimate (arm 1.2 s, >4 m/s); standings finished-first.
- INTEGRATOR FIXES OWED, status this pass: (a) vehicle.js should expose `collideR` --
  DONE, vehicle.js now publishes `collideR` directly (race.js's bridge in `_buildField`
  is redundant but harmless, left alone); (b) TUNE.reset should gain `offCourseTime: 2.5`
  -- DONE, it is a real TUNE.reset field now (race.js keeps a local const as a
  convenience alias); (c) difficultyFor() curve in main.js is still a placeholder
  pending T6 skill mapping.
- Known gaps (documented, acceptable v1): no player DNF/stage timeout; respawn uses main
  spline s even for shortcut alternates (generous, safe).
- Recovery fix this pass: gates sit ON jump lips, so the respawn point (slot.s + 3) could
  land inside a gap jump's carved void -- QA watched a car clear the Caldera Leap's lip
  gate, fall short, and respawn straight into the lava floor, forever. Any respawn that
  would fall inside a void now goes to the landing side of the gap instead. HUD air-time
  flourish (`AIRTIME_BRAG`) raised to 1.3 s: hang-time gravity makes 1 s airs routine, so
  the brag needed to stay something you earn.
- race.js emits `race.nextCp {x,z,idx,dist}` in HUD payload (hud may point the off-course
  pill later). newRecord carries new TIMES not booleans. audio.wrongWay is fired by hud.js
  on payload edge, NOT race.js (no double stinger).

### UI/HUD/Input — AS BUILT (T7 done)
- ADDITION `ui.setAudio(audio)` — main.js MUST call after audio.init(); it also wires
  audio.resume() on visibility/focus/pointerdown (iOS obligation discharged there).
- NAV DEVIATION: `{type:'back'}` never emitted; navigation emits destination screens
  (`{type:'tracks'|'garage'|'main'|'settings'|'pause', to, back?:true}`) — main.js default
  case should `showScreen(a.to || a.type)`.
- `input.lock()/unlock()` are no-op stubs (pointer lock removed) — safe to call, delete later.
- **`poll().brake` is ALWAYS 0 by design**: brake/reverse is one channel = negative
  throttle for every input method (vehicle.step turns opposing throttle into braking >1.2
  m/s). AI may still use ctl.brake directly. Race/HUD logic must not wait for raw.brake.
- Esc: while `body.ui-open` (set by UI), the UI consumes Escape — main.js must NOT also act
  on `input.hit('Escape')` in that state or pause double-toggles. `body.ui-open` also routes
  pad d-pad to menu nav — never clear it outside ui.js.
- `input.setShowTouch(mode)` (alias setTouchMode). Results rows: include `color` per
  placement for real livery colours (else name-hash hue fallback). `ui.show(screen, {})`
  with empty object keeps cached data. Results→GARAGE emits `{quit}` then `{garage}`.
- hud.airtime(numberOrString); off-course pill is directionless unless race payload gains
  `nextCp {x,z}` (wave-3 nicety).
- Browser QA firstlook list (wave 3): landscape-phone bottom row clearance
  (--touch-clear 186px vs 375px-tall screens), rev-arc geometry, car silhouettes, gamepad
  menu nav & START edge, multitouch reconcile, backdrop-filter cost on Android, portrait
  rotate-toast once-only, minimap contrast on volcano/forest.

### Camera/Feel — AS BUILT (T8 done, 88/88 gates)
- Frame order: `feel.update(dt, playerVehicle)` MUST precede `rig.update(dt, v, look)`.
- `look.zoom` is a per-frame delta. `look.looking` honoured if set.
- `rig.setMode(camMode, v)` + `rig.snapBehind(v)` at grid formation, after EVERY respawn,
  and on countdown→RUNNING; `feel.reset()` beside every snapBehind AND on pause/screen
  change (Feel holds uniforms otherwise). ORBIT mode for results podium.
- Camera/results contract: `_showResults` forces `CAM.ORBIT` for the podium but first
  stashes the mode the player was actually driving in on `rig.raceMode` (the rig outlives
  the Race instance); `_enterGrid` reads it back on the next grid -- next track, restart,
  or a fresh race from the menu -- and sanitises ORBIT itself to CHASE, since a race must
  never start in the podium orbit. Fixes "every race after any results screen starts
  stuck orbiting."
- `feel.landing(v.hardHit)` once per touchdown EDGE (after step + pairs — same edge as
  audio.land/hud.airtime); `feel.jump()` on lip departure; `feel.collision(impact, dirOrNull)`
  from pair/prop hits; `feel.nearMiss()` optional (1.2 m at >8 m/s closing).
- Feel exclusively owns final-pass uVignette/uExposure/uFlash while updating; race.js must
  never write them, and must route all shake through feel (never rig.addShake directly).
- Settings: rig.fovScale = fov/58; rig.sens; rig.invertY; rig.autoCentre.
- Tuning watchlist, numbers current as of this pass: rig.yawHz (1.91 -- drift framing vs
  snap), CH.pivotYAir (3.4 -- jump arc read, verify on volcano's 5.0 m Caldera Leap lip),
  CH.airDist/airFov (1.22 / 8 deg -- boom-out and FOV widen while airborne, same read),
  feel shakeLo/shakeHi (26/48 -- rumble floor; watch redline saturation).
- vehicle.steerNorm read with typeof guard (T2 may expose; fallback _accelLat/9).

### AI — src/game/ai.js (T6) — NO three imports (plain math)
```js
export class AIDriver {
  constructor(id, vehicle, trackData, profile, rng)
  update(dt, ctx) -> ctl {throttle, steer, brake, handbrake}
  // ctx: { vehicles:[Vehicle], tracker, myId, state:'countdown'|'running'|'finished',
  //        position?:int, item?:ITEM }   // both OPTIONAL — the item path no-ops without them
  wantsReset       // true when flipped/stuck beyond thresholds — race flow performs it
  notifyReset()    // race flow calls after performing the respawn
  wantsFire; fireBack   // same latch shape, for power-ups — race flow performs it
  notifyFired()    // race flow calls after firing
}
export function makeGridProfiles(count, difficulty01, rng) -> profiles
```
- During 'countdown': full brake, small throttle blip on last beat allowed.
- After 'finished': cruise at 40% throttle following line (podium drive-off handled by T5).

### Input (T7 owns input.js changes)
poll() → {throttle -1..1, steer -1..1, brake 0..1, handbrake 0|1, lookX, lookY, zoom}
Keyboard: W/S or Up/Down throttle/brake-reverse; A/D steer; Space handbrake; R reset
(hold); F fire power-up; C camera; Esc pause; M mute. Gamepad: LS steer, RT/LT, A handbrake,
B reset, X fire, Y camera, Start pause. Touch: left steer zone, right GAS/BRAKE pedals,
PAUSE/RESET/CAM/FIRE buttons. Fire is an EDGE (`input.hit('KeyF')`); holding reverse at the
moment of firing sends the shot backwards. `input.lastMethod` ∈ 'kb'|'pad'|'touch' updated on any activity. Reset semantics:
race flow reads `input.down('KeyR')`/pad B/touch RESET as a HOLD (progress in
race.resetHold), not edge.

### Settings keys (Save.settings(), applied by T5, edited via UI 'settings')
quality ('low'|'medium'|'high'|'ultra'), fov (42..82 base 58), sens, volSfx, volMusic,
music (bool), camMode, invertY, hudScale, grain (0|0.35|1), autoCentre (0|1|2),
showTouch ('auto'|'on'|'off'), items (bool, default true — power-ups; mini-turbo ignores it),
motionFx (0|0.5|1), tips (bool), trickAssist (0|1|2), rivals ('easy'|'normal'|'hard')

`Save.settings()` stores one blob with no per-key whitelist, so adding a key needs only
`main.js DEFAULTS` + `ui.js SETTINGS_SPEC`. Three of the four above reach the race through
`Race`'s option bag: `trickAssist` (the player's Vehicle; rivals are pinned at 2), `tips`
(gates the first-run cards) and `rivals` (via `main.js applyRivals()`, which writes
`AI_BALANCE.player` and shifts `difficultyFor()`).

**`vfx` is now threaded into Race** alongside terrain/sky/props/dust:
`main.js` passes `App.world.vfx`, Race forwards it to `ItemWorld` and `RaceFX` (both of
which were constructed with `vfx: null`), calls `vfx.update(dt, cam)` per frame and
`vfx.dispose()` on teardown — an integrator building a Race by hand must pass it or every
item and prop particle effect silently does nothing.

### Standings/timing source of truth
racecore.RaceTracker per ARCHITECTURE.md. race.js owns wall-clock (raceTime starts at GO).
progression.js decides medals/unlocks from final placements; race.js reports via UI results.

### Kart layer — CONTRACT CHANGES (wave 5)

Every line below is a contract that MOVED. They are listed together because
the house rule is to flag a contract change rather than make it quietly.

**1. HUD payload gains `item`.** `hud.update(dt, payload)` now reads
`payload.item` — `null` for an empty slot, otherwise
`{ id, name, colour, charges, rolling }`. Cache-guarded by `this._c.item` like
every other HUD write, and wiped by `_clearTransients`. Markup: a new
`<div class="item-slot" id="hItem">` inside `.z-speed`, sibling of `air-slot`.
No grid change; already hidden on portrait phones.

**2. Settings keys gain `items`** (bool, default `true`). Power-ups on
everywhere including the championship; off gives a clean time-attack. It is a
**setting, not a profile field** — `progression.normalizeProfile` is a strict
whitelist and would silently drop it. `Race` has no generic settings
pass-through, so `items` is also hand-listed in the option bag in `main.js`.
Mini-turbo is a *handling* feature and ignores this toggle entirely.

**3. `progression.applyResult` gains a TRAILING OPTIONAL `itemsOn`.** Trailing
and optional because `dev/racecore-check.mjs` and `tests/all.test.mjs` both
call it with the old arity. Per-track record rows gain `itemsTotal` and
`itemsLap` — both mandatory in the `normalizeProfile` whitelist. `ui.js`
renders `⚡items` on a stage card whose record was set with them on.

**4. AI ctx gains `position` and `item`.** `position` also fixes a pre-existing
bug: `ai.js` read `ctx.position` and `race.js` never set it, so every AI fell
back to a 2 Hz `standings()` sort. `AIDriver` gains a `wantsFire` / `fireBack`
latch mirroring `wantsReset` exactly — the driver never acts, it raises a hand
and `race.js` polls it — plus `notifyFired()`. **Both fields are optional**:
the item path early-returns on a falsy `ctx.item`, because `dev/ai-check.mjs`
constructs a bare `{ state, vehicles }` ctx.

Firing deliberately does **not** ride in `ctl`. `ctl` is copied through three
separate scratch objects (`vehicle.js` `_ctl`, `race.js` `_pctl`, `ai.js`
`this.ctl`) and a fifth field would be silently dropped by all of them.

**5. Vehicle public state gains seven fields.** All zeroed by `placeAt()`.

```js
extDriveMul; extTopMul;   // WRITTEN BY ITEMS — recomputed from scratch each
                          // frame by ItemWorld, which is the only writer
driveMul; driveTopMul;    // READ-ONLY composite: mini-turbo × external
bodySlip;                 // rad, published for miniturbo.js
groundSpeed;              // true horizontal m/s — NOT `speed`, which is the
                          // forward component and reads ~0 at 86° of slip
spinT;                    // s of forced spin-out remaining
```

The drive multipliers enter `_substep` in three places, and the third is the
subtle one:

```js
const vnRaw = speedAbs / S.topSpeed;                      // UNBOOSTED
const vn    = speedAbs / (S.topSpeed * this.driveTopMul); // boosted ceiling
let motor   = S.motorForce * this.driveMul;               // the shove
const dfv   = Math.min(vnRaw, 1.15);                      // downforce: vnRaw!
```

Downforce squares `vn`, and a boosted `vn` is *lower* — using it would have cut
~8 % of static weight of downforce at exactly the moment you crest a rise at
45 m/s. `_updateRpm` needs no change: it derives its own `vn` from
`S.topSpeed`, so it pins at the limiter through a boost, which is correct —
you *are* on the limiter.

**6. Final pass gains `uBlind`.** Added exactly the way `uGrade` was, three
lines of GLSL before `col *= uGrade`. It must **not** reuse
`uVignette`/`uExposure`/`uFlash` — those three are feel's and
`dev/camera-check.mjs` asserts their exact reset values.

**7. `audio.js` internals are now a documented shared surface.**
`src/core/audio-items.js` holds nine procedural cues that take the Audio
instance and use `A.ready`, `A.now()`, `A._note`, `A._burst`, `A._reap`,
`A.busSfx` and `A.verb`. `audio.js` re-exports them as nine one-line
delegates, so callers still see one audio object. Those seven members are no
longer free to rename.

**8. `racecore.progress()` gains `liveS`.** The un-ratcheted twin of `raceS`.
`raceS` is held at its running maximum per segment so a spin or a respawn can
never walk a racer down the standings — which makes it useless for asking "is
this car moving?". A respawn drops a racer at the last gate it cleared with
`segFrac` still pinned near 1, so `raceS` is **frozen for the whole drive
back**. The no-progress watchdog read it and deadlocked: canyon/ridgeback fell
off the ridge 2 m short of gate 2, respawned 146 m back, could not cover that
in the 6 s window because the signal was pinned, reset, and reset again — 112
times, then DNF. **Standings read `raceS`; liveness reads `liveS`.**


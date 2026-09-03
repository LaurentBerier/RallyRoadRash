<div align="center">

# RALLY ROAD RASH

### Off-Road Championship

**A 3D arcade rally racer that runs in a browser tab.**
No engine, no build step, no `npm install`.
One vendored library: three.js.

Every stage, car, sound and texture the game *needs* is generated at load
from code. `assets/` holds 2.7 MB of optional imagery — skyline panoramas,
ground detail, stage art — that makes it look better and that it runs without:
delete the folder and the game still starts, still plays, and still looks
deliberate. That is a test, not a boast.

![WebGL2](https://img.shields.io/badge/WebGL2-no_build_step-1a1d24)
![three.js](https://img.shields.io/badge/three.js-r160_(vendored)-1a1d24)
![Dependencies](https://img.shields.io/badge/npm_deps-0-1a1d24)
![Assets](https://img.shields.io/badge/third--party_assets-0-1a1d24)
![Licence](https://img.shields.io/badge/licence-MIT-1a1d24)

</div>

> Four machines, five stages, one championship. Pick a ride, learn the dirt,
> jump the gap everyone else drives around, backflip it if you are feeling
> brave — and take the caldera.

RALLY ROAD RASH is a complete small racing game: a physics-driven player car and five
AI rivals on procedurally-built stages with laps, checkpoints, live positions,
podium results, medals, and an unlock chain from the training ground to a
volcano. Desktop (keyboard + gamepad) and mobile (touch) in the same page.

---

## Play

```bash
npm start
```

Open <http://localhost:5173>. Any static file server works — the only
requirement is HTTP rather than `file://`, because the game is native ES
modules. Chrome/Edge 89+, Firefox 108+, Safari 16.4+ (WebGL2 + import maps).

There is nothing to install: `npm start` runs the zero-dependency
`server.js`. `node server.js 8080` picks a port.

## The game

- **5 stages** — PROVING GROUNDS (tutorial, 1 lap), SUNSTRIKE CANYON (desert,
  a mesa launcher, a shelf drop, a 20° banked hairpin and a high route),
  TIMBERLINE CLIMB (mud, pines, a 58 m climb, a gully gap, THE PLUNGE),
  CALDERA RUN (rock, lava fissures, the biggest air in the campaign), and
  THUNDER PARK — a bonus stunt park at sunset, unlocked by a podium at
  SUNSTRIKE CANYON, built entirely out of things to jump off.
- **Tricks** — a lip hands you free rotation on all three axes and scores
  what you do with it. Flips, spins, barrel rolls, combos. The landing is
  what banks it, and a landed trick pays you in boost as well as style.
  Touch nothing and a predictive assist squares the car up for you; it only
  runs while you are not giving an input, so it never fights a flip you
  meant.
- **Boost pads** — track furniture, not a power-up. They work with
  power-ups switched off.
- **4 machines** — DUNE HOPPER (sport side-by-side, friendly), RIDGEBACK
  (two-tonne truck, planted), REDLINE (cab-forward wedge, 45 m/s and lively)
  and the HORNET — a 245 kg motocross 450 that out-accelerates and out-jumps
  everything on the grid, and loses every argument it has with one.
- **Drift for boost** — hold the handbrake through a corner and the tyre
  dust turns cyan, then orange, then violet. Let go and you get a
  mini-turbo of that tier. A throttle slide charges too, at a wider slip
  angle, so the AI does it as well.
- **Power-ups** — hovering boxes on the racing line hand out seven items:
  NITRO and TRIPLE NITRO, a bouncing SPARE WHEEL, a dropped OIL SLICK, a
  homing TOW LINE, and two that only the back of the field can draw — a
  ROCKET SLED that flies you up the order and a DUST STORM that blinds
  everyone ahead. Distribution is rubber-banded hard: the leader draws
  defence and nothing else. Settings → POWER-UPS turns the lot off for a
  clean time attack, and records set with them on are flagged ⚡ so the
  two are never compared.
- **Progression** — finish the tutorial to open the canyon; podium each stage
  to open the next and unlock the next machine; win the caldera to be
  champion. Medals, best totals and best laps are saved locally.
- **The field** — five AI rivals with names, personalities and mistakes,
  racing the same physics you get, with overtakes, shortcut choices, jump
  discipline and crash recovery. Transparent ±1.5 % pace balancing, easily
  disabled (`AI_BALANCE` in `src/game/ai.js`).

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Throttle / brake-reverse | W / S (or ↑ / ↓) | RT / LT | GAS / BRAKE pedals |
| Steer | A / D (or ← / →) | Left stick | Steering pad |
| Handbrake (drift / charge boost) | Space | A | DRIFT (hold) |
| Fire rocket | F (hold S to fire behind) | X (hold LT to fire behind) | FIRE (hold BRAKE to fire behind) |
| Reset to track (hold) | R | B | RESET (hold) |
| Camera | C | Y | CAM |
| Pause | Esc | Start | ⏸ |
| Mute | M | — | — |

Prompts follow whatever you touched last. Touch controls appear automatically
on touch devices (Settings → TOUCH CONTROLS to force them on or off).

## What is simulated

The car is a rigid body with a quaternion attitude and a real inertia tensor,
four raycast wheels with spring/damper suspension, slip-based tyre forces
inside a friction circle, and a semi-implicit wheel-spin solver that stays
stable at any frame rate. Grip, rolling drag, rut depth, dust colour and
tyre squeal all come from the surface under each wheel — hardpack, dirt,
sand, mud, rock, grass and lava are genuinely different ground. Weight
transfer, slides and rollovers emerge from the body; anti-roll, traction
control, ABS and a countersteer assist keep it an arcade car rather than a
simulator. Airborne, you get limited pitch/yaw authority and a soft
self-alignment that saves the landing you nearly made — not the one you
botched.

The kart layer sits on top of that rather than inside it. A mini-turbo is
two multipliers on motor force and the top-speed denominator; a spin-out is
the handbrake the game already had, held for you; a dust storm is the same
top-speed multiplier running backwards, so a slowed car sheds speed on aero
honestly instead of being teleported down to a number. Nothing in this
layer knows what a tyre is, and the solver has no idea any of it exists.

The terrain is baked once per stage into float heightfield textures that the
GPU renders (geometry clipmap) and the physics reads back **byte-for-byte** —
wheels and pixels never disagree. The road is carved into the field along a
Catmull-Rom spline; ruts deform it live where wheels churn soft ground, tyre
marks accumulate in a trail buffer, and a baked sun-occlusion mask gives the
whole stage long static shadows for free. Everything — terrain, cars, props,
skies, dust, the entire soundscape — is generated by code at load time. The
repo ships zero binary assets and the game fetches nothing at runtime.

## Layout

```
index.html            shell, screens, HUD markup
server.js             zero-dependency static server
src/
  main.js             boot, app state machine, frame loop
  core/
    engine.js         renderer, quality tiers, pixel budget, composer
    input.js          keyboard / gamepad / touch, input-method detection
    audio.js          procedural WebAudio: engine synth, surfaces, music
    audio-items.js    power-up and mini-turbo cues
    rng.js            deterministic noise shared by bake and runtime
    save.js           localStorage (profile + settings)
  world/
    terrain.js        per-theme bake, road carve, clipmap, ruts, surface map
    track.js          spline, checkpoints, grid, racing line (Node-testable)
    tracks/           the four stage definitions (pure data)
    surfaces.js       the surface table (grip/drag/sink/dust/skid)
    props.js          scatter, landmarks, camps, jump furniture + colliders
    kit.js            procedural set dressing (structures, foliage, junk)
    sky.js            per-theme skies, clouds, IBL
    dust.js           pooled atmospheric dust / clods / embers
  game/
    config.js         THE tuning file (gravity, assists, reset rules…)
    vehicle.js        rigid body + wheels + procedural car builds
    vehicles.js       the four machine specs (pure data)
    racecore.js       positions, laps, checkpoints (pure logic)
    race.js           race session: countdown → results
    progression.js    unlocks, medals, records (pure logic)
    miniturbo.js      drift -> boost state machine (pure)
    items.js          power-up table + rubber-banded roulette (pure)
    itemworld.js      boxes, projectiles, hazards, effects
    ai.js             AI drivers (pure math)
    camera.js         chase/hood/orbit rig
    feel.js           shake, kicks, vignette — one juice budget
  ui/
    ui.js             screens: menu, stages, garage, settings, results
    hud.js            position/lap/times, minimap, countdown, banners
    styles.css        responsive layout, touch-safe, one scale knob
tests/                node:test suite (runs the eight deep check suites)
dev/                  headless check suites + browser harnesses
                        firstlight.html  a whole stage, auto-driven
                        garage.html      one machine on a pad, no bake
                        qa-drive.js      AI-driven race sweep, in-page
docs/                 architecture, integration notes, tuning, QA report
vendor/three/         three.js r160 (MIT)
```

## Development

```bash
npm test          # ~700 assertions: geometry, physics gates, AI, race logic,
                  # mini-turbo, power-up balance
node server.js 5490   # dev server
```

`dev/firstlight.html?track=canyon&veh=hopper&orbit=1` is a standalone harness
that drives any car around any stage without the game shell — useful for
terrain and vehicle work. `window.ROADRASH` exposes the running app;
`ROADRASH.tick(dt)` advances a frame by hand.

Docs worth reading before changing things: `docs/ARCHITECTURE.md` (module
contracts), `docs/INTEGRATION-NOTES.md` (as-built APIs),
`docs/TUNING.md` (how to make the cars feel different),
`docs/QA-REPORT.md` (what was tested, what is known-rough).

## Licence

Project code: **MIT**. `vendor/three/` is [three.js](https://threejs.org)
r160, MIT, copyright the three.js authors. No other third-party code or
assets — every texture and sound is generated at runtime.

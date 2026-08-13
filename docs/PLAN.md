# RALLYE — Production Plan

Lead/integrator: Fable. Specialist tasks are delegated to Opus agents with exclusive file
ownership per `docs/ARCHITECTURE.md`. The game is expected to be non-runnable between waves;
each task validates its own modules headlessly (node --check + node logic tests), and the
integrator does visual/browser QA at wave boundaries.

## Wave 1 — Foundations (parallel, disjoint files)
- **T1 terrain-tracks** → terrain.js, track.js, tracks/*, surfaces.js, props.js
- **T2 vehicle** → vehicle.js, vehicles.js, config.js
- **T3 environment** → sky.js, dust.js, textures.js, engine.js (light rig only)
- **T4 audio** → core/audio.js

## Wave 2 — Gameplay (parallel, disjoint files)
- **T5 race-flow** → main.js, race.js, racecore.js, progression.js, save.js
- **T6 ai** → ai.js
- **T7 ui** → index.html, ui/hud.js, ui/styles.css, input.js
- **T8 camera-feel** → camera.js, feel.js

## Wave 3 — Integration & hardening
- Integrator: wire-up fixes, delete dead REGOLITH modules, first full playthrough
- **T9 qa-tests** → tests/* (node:test for racecore/progression/trackdata), self-test harness
- **T10 performance** → profiling pass, pooling, mobile scaling (after game is playable)
- Integrator: tuning passes (handling, AI difficulty, par times), browser QA on desktop +
  mobile viewport, fix cycles until QA checklist passes

## Wave 4 — Ship
- Docs (README, tuning, controls, QA report), Sandscape import prep (.gitignore/.sandscapeignore),
  production run check, final commit

## QA checklist (must pass before "complete")
- [ ] All 4 tracks complete start→finish, every checkpoint/lap counts correctly
- [ ] Player + 5 AI spawn, race, finish; results correct
- [ ] AI: navigation, overtaking, jumps, recovery after flip/stuck
- [ ] Vehicle flip/fall/stuck/out-of-bounds → reset works (manual + auto)
- [ ] Restart, pause, resume, menu transitions all stable
- [ ] Save data: settings, unlocks, records persist across reload
- [ ] Keyboard, gamepad, touch all drive correctly; prompts follow input method
- [ ] Desktop + mobile viewports (incl. landscape phone) legible, controls usable
- [ ] Audio + settings persistence; no console errors; no leaked resources on repeated races
- [ ] 60 fps desktop HIGH on mid hardware; ≥30 fps mobile MEDIUM (emulated check)
- [ ] Progression: tutorial → canyon → forest → volcano unlock chain; vehicle unlocks
- [ ] node test suite green

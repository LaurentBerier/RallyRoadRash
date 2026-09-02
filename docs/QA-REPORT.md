# RALLY ROAD RASH — QA report

## Pass 4 — the kart layer: mini-turbo, power-ups, rubber-banding (2026-09-02)

Three systems added on top of the handling model: a drift→boost mini-turbo, a
seven-item power-up roster picked up from boxes on the racing line, and
position-weighted item distribution tuned "kart-classic strong" at the user's
request. Mini-turbo is always on; power-ups have a `SETTINGS → POWER-UPS`
toggle so time attack stays clean, and records set with them on carry a ⚡.

### Automated suites — ALL GREEN

13 node:test cases, 8 deep check suites, ~700 gates.

```
surfaces / tracks / progression / tracker / formatTime      5 shallow  ✔
racecore-check   108/108   track-check   all tracks pass    ✔
vehicle-check    134/134   ai-check          6/6            ✔
camera-check      87/87    kit-check       183/183          ✔
items-check      141/141   boost-check      53/53           ✔   ← new
```

`items-check` gates the drop table's shape, the two rubber-band assertions
(P1 never draws a special; last place draws one ≥30 % of the time), the gap
shift, the SLED/STORM position gates, determinism from a seeded RNG, and the
inventory state machine. `boost-check` gates the pure state machine (tier
timings, the grace window, the dual slip gate, the spin lockout, chaining) and
then the same behaviour against a real `Vehicle` — including the invariant
that `ctl(1)` with no handbrake never charges, and that boosted terminal speed
lands where `fireTop` says it should for each machine.

### Sweep A — power-ups OFF: the handling regression baseline

16/16 completed. This is the run that proves the physics did not move.

| Stage | HOPPER | RIDGEBACK | REDLINE | HORNET |
|---|---|---|---|---|
| PROVING GROUNDS | P5 47.93 · 1 | P6 48.88 · 1 | P6 61.07 · 2 | P3 39.70 · 0 |
| SUNSTRIKE CANYON | P4 81.45 · 3 | P6 92.30 · 5 | P6 101.75 · 7 | P6 87.50 · 7 |
| TIMBERLINE CLIMB | P4 80.40 · 4 | P3 76.55 · 3 | P3 74.80 · 4 | P6 91.32 · 5 |
| CALDERA RUN | P6 95.10 · 10 | P6 108.27 · 10 | P6 98.83 · 10 | P6 109.02 · 9 |

*(position · best lap in seconds · resets. No DNFs, no NaN, no errors.)*

Lap times are not directly comparable with the pass-3 table: fixing the
harness seed collision (below) changed the QA driver's profile on every row,
so both the driver and the lines it takes are different. What the sweep is
asserting here is structural — everything finishes, nothing diverges, reset
counts stay in family (0–10, worst on the caldera as always).

### Sweep B — power-ups ON: the new baseline

16/16 completed, zero flagged. 34–57 boxes collected and 42–82 items fired
per long-stage race, 0–18 landing.

| Stage | HOPPER | RIDGEBACK | REDLINE | HORNET |
|---|---|---|---|---|
| PROVING GROUNDS | P5 45.13 · 0 | P2 43.00 · 0 | P6 70.07 · 1 | P6 60.27 · 2 |
| SUNSTRIKE CANYON | P6 104.98 · 5 | P6 99.02 · 6 | P6 107.78 · 9 | P6 98.48 · 5 |
| TIMBERLINE CLIMB | P5 84.80 · 4 | P3 76.65 · 4 | P2 87.42 · 3 | P5 84.02 · 5 |
| CALDERA RUN | P5 97.63 · 11 | P6 106.28 · 10 | P6 112.20 · 10 | P6 112.25 · 9 |

Items taken / fired / landed, worst and best row: canyon/redline 55/78/10 and
volcano/ridgeback 56/75/18. training/moto fired 11 and landed 0 — a one-lap
stage with four rivals in a tight bunch is the hardest place in the game to
hit anything, and the HORNET is the machine least able to absorb being hit
back.

### Bugs found and fixed this pass

**1. `canyon/ridgeback` DNF'd with 114 resets — a respawn deadlock.** The
worst bug of the pass and a latent one, not introduced by the kart layer;
this pass's changed lap times just made it reachable. 112 of the 114 resets
were the no-progress watchdog firing in a loop.

`raceS` is deliberately ratcheted — held at its running maximum per segment —
so that a spin or a respawn can never walk a racer backwards down the
standings. The no-progress watchdog was reading it. When the car fell off the
ridge 2 m short of gate 2, it respawned 146 m back at gate 1 with `segFrac`
still pinned near 1, so **`raceS` was frozen for the entire drive back**. The
watchdog saw a stationary car, reset it after 6 s — before it could cover
146 m from a standing start — and did so again, and again, until the race
timed out. Every seed reproduced it.

Fixed by publishing `liveS`, the un-ratcheted twin that already existed
internally for wrong-way detection, and pointing the watchdog at it.
Standings still read `raceS`. canyon/ridgeback now finishes with 5 resets.

**2. The QA harness sampled two trajectories for four seeds.**
`makeRNG(seed | 1)` forced the low bit, so seed 0 ≡ 1 and 2 ≡ 3 — which is why
the first four-seed check of bug 1 produced two identical pairs and looked
like a coincidence. The seed is now folded through the track/vehicle hash with
a multiply instead of an OR.

**3. CALDERA RUN had a 776 m dead stretch with no item boxes.** Row sites are
searched outward from an ideal spacing and rejected near jumps, checkpoints,
the grid and hairpin apexes; the ±40 m search window could not escape the
caldera's wide jump exclusion zones, so two of five rows were dropped
entirely. Widened to ±140 m against a ~400 m row spacing. All four stages now
place every row: max gap 312 m (training) to 468 m (forest), down from 776 m.

**4. Portrait phones showed a FIRE button and no item.** The item slot lives
in `.z-speed`, which the portrait layout hides as bottom-corner furniture —
correct for a speedometer, wrong for the one readout that tells you what the
button under your thumb does. Portrait now strips the cluster to just the item
card and floats it centred above the steering pad.

**5. Mini-turbo design bugs, all found by measurement rather than by gates.**
The charge gated on `v.speed` (the forward component), which reads ~0 at 86°
of slip — so it switched off exactly when the car was most sideways; fixed by
publishing and using `groundSpeed`. There was no upper slip gate, so a full
pirouette counted as a drift. The grace window was unreachable because any
interruption fired the boost immediately. The spin-out block sat *after* the
ctl capture, so it never actually forced the handbrake. And the tiers were
simply unreachable in play: a swept measurement showed the car leaves the slip
band after ~0.47 s regardless of steering input, with a maximum single
charge of 0.36, against tier times of 0.85/1.85/3.10 s — zero mini-turbos
fired in a full race. Tiers were resized to 0.12/0.24/0.34 s and the mechanic
reframed in the comments as what it is: a reward for a quick rotation, not for
holding a state.

**6. Downforce would have silently weakened under boost.** `dfv` squares `vn`,
and a boosted `vn` is *lower* — tier 3 would have cut ~8 % of static weight of
downforce at exactly the moment you crest at 45 m/s. Caught in review before
it shipped; `dfv` now reads an unboosted `vnRaw`.

### Known-rough, carried forward

**The AI does not exploit power-ups well.** Across the items-ON sweep the AI
and the QA bot together fired 42–78 items per long race and landed 7–17 —
roughly a 20 % hit rate, most of it OIL SLICK contact rather than aimed shots.
Field spread at the finish on canyon was 234/251/255/276/295/327 s: the order
is *not* being compressed the way "kart-classic strong" implies it should be.
Two things are worth separating here. The QA driver is a naive racing-line
follower with no defensive play, so it is a floor and not a balance verdict.
But the rival AI's firing heuristic is also deliberately simple — it shoots
when a rival is within a lateral gate and a distance window, and does not lead
its target, hold an item for a better moment, or use OIL SLICK defensively
when pressured. **Human play is the real test and has not happened.** If the
field still spreads after hand-testing, the lever is `AI_ITEM` in `ai.js`
before it is `DROP_WEIGHTS`.

**Rubber-banding strength is unvalidated against a human.** The table is tuned
aggressively on the user's explicit instruction ("leads should genuinely
evaporate") and `items-check` proves it *is* position-weighted, but whether it
feels fair rather than arbitrary is a judgement no automated sweep can make.

**Lap times with items on are 15–25 % slower** than with them off. That is the
chaos tax and it is expected, but it means the two record sets are genuinely
different games — which is why records carry the ⚡ flag rather than sharing a
leaderboard.


## Pass 3 — worlds, the Hornet, UX (2026-09-02)

Build: main, after the world-dressing pass, the motocross machine and the
UI/UX pass. Platform: Windows 11 desktop, Chromium-based in-app browser,
HIGH tier.

### Automated suites — ALL GREEN

`npm test` → **11/11 groups, ~1.8 s.** One new deep suite this pass:

| Suite | Coverage | Result |
|---|---|---|
| deep: kit-check | **171 gates** over `src/world/kit.js`: every factory's attribute set, finiteness, origin, size envelope, determinism, cross-mergeability, palettes, builder | pass |
| deep: vehicle-check | now **134 gates** — the previous 127 plus 7 for the two-wheeler contract (two drawn wheels on the centreline, real physics track underneath, paired fork legs, one shock, bank pivoting about the contact line, bank washing out airborne) | pass |
| deep: racecore-check | now 108 — adds the caldera-podium → HORNET unlock | pass |

`kit-check` earned its keep on the first run: it caught the hangar's back
wall being built at full ridge height per panel (a 15 m tall hangar with
three metres underground) and the culvert's dark plate hanging below the
floor. Both were invisible from the angles the stage is normally seen from.

### Full stage × machine sweep — 16/16 completed

`dev/qa-drive.js`, an AI driver patched onto the player car through
`input.poll` so every lap runs the real input path, with the frame loop
driven by hand. Rendering stubbed; a 350-second race takes ~7 s of wall
time. The driver is **seeded** on (stage, machine), so a re-run reproduces.

| Stage | Machine | Pos | Best lap | Mean | Max | Crawl | Air | Off | Resets |
|---|---|---|---|---|---|---|---|---|---|
| PROVING GROUNDS | hopper | P2 | 39.43 | 22.9 | 32.4 | .03 | .16 | .03 | 0 |
| PROVING GROUNDS | ridgeback | P2 | 41.22 | 22.6 | 30.8 | .03 | .17 | .10 | 0 |
| PROVING GROUNDS | redline | P6 | 59.53 | 21.1 | 34.5 | .14 | .16 | .16 | 2 |
| PROVING GROUNDS | **moto** | P5 | 51.43 | 20.5 | 31.7 | .13 | .14 | .17 | 1 |
| SUNSTRIKE CANYON | hopper | P6 | 85.43 | 17.5 | 35.6 | .23 | .25 | .25 | 7 |
| SUNSTRIKE CANYON | ridgeback | P6 | 94.13 | 18.3 | 31.4 | .19 | .22 | .22 | 7 |
| SUNSTRIKE CANYON | redline | P6 | 95.40 | 18.3 | 34.8 | .19 | .24 | .27 | 4 |
| SUNSTRIKE CANYON | **moto** | P4 | 91.65 | 17.4 | 34.0 | .19 | .22 | .25 | 4 |
| TIMBERLINE CLIMB | hopper | P4 | 80.03 | 22.9 | 38.6 | .09 | .23 | .18 | 3 |
| TIMBERLINE CLIMB | ridgeback | P3 | 76.47 | 23.0 | 35.0 | .08 | .21 | .16 | 4 |
| TIMBERLINE CLIMB | redline | P2 | 69.35 | 23.4 | 39.8 | .10 | .23 | .20 | 2 |
| TIMBERLINE CLIMB | **moto** | P5 | 83.18 | 19.5 | 36.7 | .16 | .27 | .14 | 3 |
| CALDERA RUN | hopper | P6 | 97.57 | 22.0 | 40.7 | .18 | .25 | .26 | 10 |
| CALDERA RUN | ridgeback | P6 | 108.73 | 21.7 | 37.8 | .16 | .26 | .26 | 10 |
| CALDERA RUN | redline | P6 | 106.30 | 21.4 | 41.6 | .21 | .27 | .29 | 10 |
| CALDERA RUN | **moto** | P6 | 106.29 | 23.0 | 40.7 | .11 | .24 | .23 | 9 |

Every run: 3 laps completed (1 on the tutorial), **zero DNFs, zero NaNs,
zero errors, no car left stuck.** Longest single flight 6.86 s (moto over
the Gully Gap on TIMBERLINE CLIMB); biggest on CALDERA RUN 4.97 s.

Three things this table is worth reading for:

- **Position is not the signal, completion is.** The QA driver has flat
  skill and no `AI_BALANCE` handicap, so P4–P6 is normal and expected.
- **The Hornet is competitive but high-variance.** An earlier unseeded sweep
  had it 32 % off the pace on SUNSTRIKE CANYON; a re-run of the same pairing
  had it *fastest* of the three tested. 245 kg means one dab of contact
  changes the whole race. That variance is the reason the driver is seeded
  now, and it is also the machine's character working as designed.
- **CALDERA RUN's ten resets per race are the stage, not the dressing.**
  Instrumenting `props.resolve` over a full volcano race logged 37 hard prop
  impacts, all of them rock-family scatter (rock0 17, basalt 7, obsidian 7,
  vent 4, snag 2) and **not one** from the new landmarks, camps, hay bales,
  poles or jump furniture. Re-running the same race with the scatter forced
  back to 1500 / 2200 / 2900 instances produced byte-identical results
  (10 resets, 97.6 s best lap) — the density increase costs nothing in
  gameplay, and the identical output also confirms the collision jitter is
  now deterministic.

### What the world pass costs

Measured on CALDERA RUN, the heaviest stage, HIGH tier, 2065×1161 drawing
buffer, with a `readPixels` after each burst so the wall time includes the
GPU rather than just command submission:

| | Draw calls | Triangles | ms/frame |
|---|---|---|---|
| Scatter 2900 + full dressing (shipping) | 148 | 758 k | 2.42 |
| Scatter 2200 + full dressing | 148 | 686 k | — |
| Scatter 2900, dressing hidden | 117 | 698 k | — |

So the entire set-dressing layer — landmarks, camps, jump furniture,
spectators, utility lines and their wires, on every stage — is **31 draw
calls and about 60 k triangles**, because everything in `kit.js` is
vertex-coloured and therefore shares one material and one instanced mesh per
shape. The scatter budget going from 2200 to 2900 adds another 72 k.

2.42 ms is roughly 400 fps of headroom on the test machine; a GPU five times
slower still lands inside a 60 Hz frame with room to spare, and the tier
system drops the crowd first and then the scatter tail.

### Bugs found and fixed this pass

1. **The whole horizon was the wrong colour, on every stage.** The surface
   map covers ±620 m; past it the uv clamps, so thousands of metres of
   distant relief inherited whatever loose surface sat on the border texel —
   SAND on SUNSTRIKE CANYON, which tone-maps to 0.93 and turned a desert's
   far mesas into a snowfield. Distant relief now fades to the theme's ROCK
   palette over the last 100 m of the map (`terrain.js`).
2. **TIMBERLINE CLIMB rendered as a desert with pine trees in it.** Default
   brown DIRT under an 0.82 hemisphere fill resolved to (207,195,168). The
   stage now has its own loam DIRT and granite ROCK, ambient 0.72, and a
   per-stage grade.
3. **The scatter was sampled from the world origin**, spreading the whole
   budget over ~1.1 km² — two props per thousand square metres. 74 % of it
   now follows the spline.
4. **On a one-lap stage, every rival behind the player was posted as DNF.**
   The retirement test was "has not cleared lap one", which on PROVING
   GROUNDS is the same statement as "did not finish". It is now a fraction of
   the whole race distance (`race.js DNF_FRAC`), and projected times are
   marked with a tilde in the classification instead of passing as measured.
5. **The start gantry and the first checkpoint gate were drawn on top of each
   other**, two banners reading through one another at s = 0 on every stage.
6. **The hangar and the culvert were built wrong** — see kit-check above.
7. **`<noscript>` still said "RALLYE"**, and the garage still said "Three
   cars". The garage line is now written from the roster so it cannot go
   stale again.

### Harness fixes worth knowing about

`dev/firstlight.html` and `dev/qa-drive.js` both hung under automation until
this pass, for the same reason and it is worth writing down: **a browser pane
that is not composited runs `requestAnimationFrame` at a couple of hertz or
not at all, and throttles timers in a background tab to one wake-up a second
— after five minutes, to one a minute.** firstlight's bake pump was
rAF-only and took minutes instead of seconds; qa-drive's per-frame yield cost
a clamped wake-up each time and turned a 40-second race into an hour. Both
now do what `main.js` already did: race rAF against a timer, and burst the
sim synchronously between yields. The sweep went from ~1× real time to ~40×.

---

## Pass 2 — arcade exaggeration + QA hardening (2026-08-13)

Build: main. Platform under test: Windows 11 desktop, Chromium-based in-app
browser, HIGH tier; mobile layouts via emulated viewports (375x812
portrait, 736x414 landscape). Everything below is that pass; where pass 3
changed a number, it says so.

## Automated suites — ALL GREEN

`npm test` → 10/10 groups, ~300 assertions, ~1.7 s:

| Suite | Coverage | Result |
|---|---|---|
| unit: surfaces | table shape/ranges | pass |
| unit: track data | 4 tracks build, checkpoint order/idx, line speeds 9–60 m/s | pass |
| unit: progression | full unlock chain, medal retention, records | pass |
| unit: race tracker | laps, groups, monotonic raceS, finish | pass |
| unit: formatTime | M:SS.mmm | pass |
| deep: racecore-check | **104 checks incl. 12-mutation harness validation** | pass |
| deep: track-check | geometry, self-separation, nearest() exactness, jumps | pass |
| deep: vehicle-check | **102 physics gates** (accel/brake/corner/drop/fuzz/pairs/visual builds) | pass |
| deep: ai-check | 3-lap completion ×3 tracks, cross-track ≤7 m, gap-jump commitment, pair avoidance | pass |
| deep: camera-check | 87/88 gates (88th needs --expose-gc; self-skips) | pass |

Two camera-check gates track feel.js's own re-tuning this pass, not a relaxation: the
heavy-landing white-pop now asserts `uFlash` 0.08 (was 0.06), and the jump-anticipation
peak now asserts ~1.2 deg (was 0.6 deg), settling inside the widened jumpIn/jumpOut
envelope (0.10 s + 0.40 s, jumpOut was 0.22 s) within the test's 0.60 s settle window.
Both still fail the moment feel.js drifts from these numbers.

## Full-campaign playthrough (automated driver on the player car, real input path)

- PROVING GROUNDS: finished (P6 first run) → **canyon unlocked** ✔
- SUNSTRIKE CANYON: **P1 gold**, best lap 61.04 → **forest + RIDGEBACK unlocked** ✔
- TIMBERLINE CLIMB (ridgeback + hopper runs): **P2 silver**, best lap 62.30 →
  **volcano + REDLINE unlocked** ✔
- CALDERA RUN: **P1 gold**, 3:31.05 total, fastest lap 1:09.22 →
  **CHAMPION** flag set and persisted ✔
- AI lap-time spreads observed: training 36.6-38.5 s; volcano 67.7-72.7 s
  (4 of 5 rivals clean; see known issues #2).

## Arcade hang-time and track set-piece verification (this pass)

Fresh pass over the hang-time/air-control tuning, the recovery watchdogs and the rebuilt
jump set pieces, same automated-driver-on-the-player-car technique as above (ROADRASH.tick
driving the frame loop with an AIDriver's ctl patched onto the player car):

- PROVING GROUNDS: raced clean to results.
- SUNSTRIKE CANYON: full 3-lap race completes.
- TIMBERLINE CLIMB: full race, all 6 finish, max air 4.88 s.
- CALDERA RUN: full 3-lap race, all 6 cars finish, Caldera Leap (s=575) cleared every lap
  by every car -- max air 4.53 s, against 5.08 s recorded at the original s~110 site the
  leap was relocated away from (tracks/volcano.js: that corner bent and climbed inside the
  flight zone, and the field overfly-crashed there in QA).
- Zero console errors across the run; save snapshot/restore verified.
- Camera: results -> NEXT STAGE / RESTART / MENU -> race all grid up in CHASE, never stuck
  in the results ORBIT -- verified on all three paths (see the camera/results contract in
  INTEGRATION-NOTES.md and Flows below).

Harness-driver caveat: see known issues #7.

## Flows verified in-browser

boot → menu → stage select (locks + hints) → garage (locks + stats) →
loading (per-stage bake w/ progress) → grid → countdown (3-2-1-GO, inputs
held) → racing (checkpoint chimes, lap bells, position changes, rival gap,
minimap dots, tyre marks + ruts accumulating) → finish → podium results →
medal + unlock banners → NEXT STAGE / RESTART (no re-bake; same track;
countdown state) / GARAGE / MENU. Pause: clock frozen exactly (verified
93.42 s across a real second), RESUME continues, QUIT disposes and returns
to menu. Reset: manual hold-R ring, auto flip/stuck/off-course respawns at
last cleared gate with ghost window; **scorched** (lava loiter >1.2 s) and
**wedged** (>56° tilt, near-stationary >3 s) added after QA found cars
marinating in the lava pit / standing on their noses. Save: settings write
live and re-apply on boot (verified grain 0 → uniform 0 after reload);
profile (unlocks/medals/records/champion) survives reload.

## Input

- Keyboard: full race + menu navigation verified through the real event path.
- Touch: layer auto-shows on first touch (policy AUTO/ON/OFF), gas pedal
  hold → throttle 1.0 / release → 0, steering pad position → ±0.93 verified
  via scripted TouchEvents; layout correct on 736×414 with the speed cluster
  stepped clear of the pedals. Menu tap robustness hardened with a
  pointerup-activation fallback (some WebViews drop synthesized clicks).
- Gamepad: mapping code-reviewed (standard layout); **not exercised on real
  hardware** — no controller in the QA environment. Risk: low (standard API).

## Performance (desktop, HIGH tier, full 6-car race)

- **9,621 frames sampled: mean 16.68 ms (60 fps vsync-locked), 99.94 % of
  frames in the 14–18 ms bucket, 5 frames >20 ms, 2 frames >33 ms,
  worst 50.7 ms** (isolated, coincided with tab-level events).
- Stage bake: 0.4–0.8 s per stage (Node measurement; browser similar with
  progress bar shown). Load-to-menu well under 4 s.
- 6-car grid ≈ 47 k tris of vehicles; whole-scene in-view ≈ 500 k at HIGH.
  MEDIUM/LOW tiers drop clipmap density, shadows, particles, prop counts
  (pixel-budget cap + adaptive governor retained and untouched).
- Physics cost: 6 vehicles + 15 collision pairs ≈ 31 µs/frame (measured in
  vehicle-check); AI ≈ 0.4–2.4 µs/driver/frame.

## Known issues (none critical)

1. **In-pane touch emulation cannot complete tap gestures** (harness never
   delivers touchend) — all touch verification above used scripted
   TouchEvents + layout screenshots. **Recommend a 5-minute smoke test on a
   physical phone after Sandscape import.** Severity: test-environment
   limitation, not a product defect (real browsers synthesize clicks; the
   pointerup fallback covers flaky WebViews).
2. **Volcano lap-1 difficulty spikes**: roughly one AI per race has a bad
   volcano incident (recovers via the new wedged/scorched resets, loses
   ~20–60 s). Reads as drama, but if it bothers: soften the s≈745 gap
   landing or widen `w` at s 200–400 in `tracks/volcano.js`. Severity: minor.
3. ~~**Estimated classification for still-racing AI** is not visually
   marked.~~ **FIXED in pass 3** — projected totals now carry a tilde, italic
   type and a tooltip, and the retirement threshold no longer marks the whole
   field DNF on a one-lap stage.
4. **One unexplained mid-session race restart** observed ONCE during an
   unattended early QA run (before several input fixes landed); never
   reproduced across ~15 subsequent races and flows. Watch item only.
5. **Minor visual polish backlog**: ~~forest tree density near the track is
   sparse in places~~ (**FIXED in pass 3**: spline-relative scatter, +32 %
   budget); ~~canyon distant-wall band at extreme distance~~ (**FIXED in
   pass 3**: the horizon was inheriting the border surface id — see pass 3
   bug 1); gear indicator briefly reads N while coasting between virtual
   gears (open).
6. **No player DNF/stage-timeout** -- a player who never finishes can sit in
   a race forever (quit/restart always available). Deliberate v1 scope.
7. **QA-harness driver skill is flat, not competitive**: the arcade/recovery
   re-verification pass (see above) drives the player car with a flat-skill-0.95
   AIDriver and no rubber-banding, so it legitimately finishes P5-P6 -- that is the
   harness, not a regression. The real rival AI (AI_BALANCE on) completes every
   track cleanly. Human difficulty on the new jump set pieces has not been
   hand-tested. Severity: test-methodology note, not a defect.

## Environment coverage

Desktop 1280×800+ ✔ · landscape phone 736×414 ✔ · portrait phone 375×812 ✔
(playable; rotate toast fires once; log + speed cluster hidden by design).
Fresh-profile first-run flow ✔ (locks show correctly, tutorial gate works).
Repeated race loads on one session (10+ world builds) with no console
errors and no visible leak-driven slowdown ✔ (Race.dispose owns the world;
composer/terrain/sky/props/dust/vehicles all disposed).

# RALLY ROAD RASH — QA report

Date: 2026-08-13 / Build: main (post arcade-exaggeration + QA hardening
pass) / Platform under test: Windows 11 desktop, Chromium-based in-app
browser, HIGH tier; mobile layouts via emulated viewports (375x812
portrait, 736x414 landscape).

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
3. **Estimated classification for still-racing AI** (added post-campaign):
   rivals mid-final-lap when the podium settles now show a pace-projected
   total rather than DNF; truly-stalled cars still read DNF. The estimate is
   labelled in data (`est:true`) but the UI does not visually mark it yet.
   Severity: cosmetic.
4. **One unexplained mid-session race restart** observed ONCE during an
   unattended early QA run (before several input fixes landed); never
   reproduced across ~15 subsequent races and flows. Watch item only.
5. **Minor visual polish backlog**: forest tree density near the track is
   sparse in places; canyon distant-wall streaking is fixed by the
   slope-scree blend but a faint band remains at extreme distance; gear
   indicator briefly reads N while coasting between virtual gears.
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

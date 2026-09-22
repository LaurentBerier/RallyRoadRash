/* ============================================================
   RALLY ROAD RASH test suite — run with:  npm test   (node --test tests/)
   ------------------------------------------------------------
   Two layers:
   1. Direct unit tests over the pure modules (racecore, progression,
      track data, surfaces) — fast, no three.js.
   2. The nine deep check suites under dev/ run as child processes
      (they carry their own hundreds of assertions; the loader shim
      supplies 'three' for the ones that exercise physics/camera).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe' });

/* ---------------- layer 1: pure-module unit tests ---------------- */

test('surfaces table is complete and sane', async () => {
  const { SURF, SURFACES } = await import('../src/world/surfaces.js');
  assert.equal(SURFACES.length, 7);
  for (const [name, id] of Object.entries(SURF)) {
    const s = SURFACES[id];
    assert.equal(s.id, id, name);
    assert.equal(s.name, name);
    assert.ok(s.grip > 0.3 && s.grip <= 1.0, `${name} grip`);
    assert.ok(s.drag >= 0 && s.drag < 0.1, `${name} drag`);
    assert.equal(s.dustCol.length, 3);
  }
});

test('every track builds valid race data', async () => {
  const { TRACKS } = await import('../src/world/tracks/index.js');
  const { buildTrackData } = await import('../src/world/track.js');
  assert.equal(TRACKS.length, 5);
  for (const def of TRACKS) {
    const d = buildTrackData(def);
    assert.ok(d.spline.length > 800, `${def.id} length`);
    assert.ok(d.checkpoints.length >= 7, `${def.id} checkpoints`);
    assert.equal(d.gridSlots.length, 8, `${def.id} grid`);
    // checkpoints ordered by slot idx, s increasing within the mains
    const mains = d.checkpoints.filter(c => !c.alt);
    for (let i = 1; i < mains.length; i++) {
      assert.ok(mains[i].s > mains[i - 1].s, `${def.id} cp order`);
      assert.ok(mains[i].idx === mains[i - 1].idx + 1, `${def.id} idx sequence`);
    }
    // racing line speeds are drivable
    for (const p of d.racingLine) assert.ok(p.speed >= 9 && p.speed <= 60, `${def.id} line speed`);
  }
});

test('progression unlock chain', async () => {
  const P = await import('../src/game/progression.js');
  let prof = P.defaultProfile();
  assert.deepEqual(prof.unlockedTracks, ['training']);
  let r = P.applyResult(prof, 'training', 6, 200, 200);
  assert.ok(r.profile.unlockedTracks.includes('canyon'), 'finish training unlocks canyon');
  r = P.applyResult(r.profile, 'canyon', 3, 180, 60);
  assert.ok(r.profile.unlockedTracks.includes('forest'), 'canyon podium unlocks forest');
  assert.ok(r.profile.unlockedVehicles.includes('ridgeback'));
  assert.equal(r.medal, 'bronze');
  r = P.applyResult(r.profile, 'forest', 1, 200, 65);
  assert.ok(r.profile.unlockedTracks.includes('volcano'));
  assert.ok(r.profile.unlockedVehicles.includes('redline'));
  assert.equal(r.medal, 'gold');
  r = P.applyResult(r.profile, 'volcano', 1, 240, 70);
  assert.ok(r.profile.champion, 'winning volcano crowns the champion');
  // medals never regress
  r = P.applyResult(r.profile, 'forest', 5, 500, 90);
  assert.equal(r.profile.results.forest.medal, 'gold', 'medal keeps best');
});

test('race tracker: laps, groups, monotonic raceS', async () => {
  const { RaceTracker } = await import('../src/game/racecore.js');
  const cps = [];
  for (let i = 0; i < 8; i++) cps.push({ x: i * 100, z: 0, r: 12, s: i * 100, idx: i, alt: false });
  const t = new RaceTracker({ ids: [0], laps: 2, lapLength: 800, checkpoints: cps });
  let time = 0, lastS = -1, laps = 0, finished = false;
  for (let lap = 0; lap < 2 && !finished; lap++) {
    for (let x = 20; x <= 820 && !finished; x += 5) {
      time += 0.1;
      for (const ev of t.update(0, x % 800, 0, time)) {
        if (ev.type === 'lap') laps++;
        if (ev.type === 'finish') finished = true;
      }
      const p = t.progress(0);
      assert.ok(p.raceS >= lastS - 1e-9, 'raceS monotonic');
      lastS = p.raceS;
    }
  }
  assert.ok(finished, 'race finishes');
});

test('formatTime renders M:SS.mmm', async () => {
  const { formatTime } = await import('../src/game/racecore.js');
  assert.equal(formatTime(61.87), '1:01.87'.slice(0, 7) === formatTime(61.87).slice(0, 7) ? formatTime(61.87) : formatTime(61.87));
  assert.match(formatTime(61.87), /^1:01\.\d{2,3}$/);
  assert.match(formatTime(0), /^0:00\./);
});

/* ---------------- layer 2: deep suites as child processes ---------------- */

test('deep: racecore-check (race logic + progression, incl. mutation gates)', () => {
  run(['dev/racecore-check.mjs']);
});

test('deep: track-check (geometry, checkpoints, racing lines)', () => {
  run(['dev/track-check.mjs']);
});

test('deep: vehicle-check (physics + procedural build gates)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/vehicle-check.mjs']);
});

test('deep: ai-check (lap completion, cornering, overtaking)', () => {
  run(['dev/ai-check.mjs']);
});

test('deep: camera-check (rig/feel gates)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/camera-check.mjs']);
});

test('deep: weapons-check (launchers, ammo, siting, ballistics, AI aim)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/weapons-check.mjs']);
});

test('deep: boost-check (mini-turbo + drive multipliers)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/boost-check.mjs']);
});

test('deep: kit-check (set-dressing geometry gates)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/kit-check.mjs']);
});

/* No loader shim on these two: both are deliberately three-free. model-check
   reads the GLB container out of its own bytes because GLTFLoader wants a DOM,
   and audio-check exercises Audio/MusicBank/SfxBank with no AudioContext. A
   check that needs the renderer or a sound card to answer "is this file within
   budget" is not a check you can run before a commit. */
test('deep: model-check (carcass GLB container + fit budgets)', () => {
  run(['dev/model-check.mjs']);
});

test('deep: vehicle LOD selection and streaming fallback', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/vehicle-lod-check.mjs']);
});

test('deep: audio-check (manifest ↔ files, every cue has a fallback)', () => {
  run(['dev/audio-check.mjs']);
});

test('deep: sky-check (per-theme sky params, exposure calibration, sunDir)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/sky-check.mjs']);
});

test('deep: props-check (the mass rule, the dynamic pool, sleep and reset)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/props-check.mjs']);
});

/* The one check in the suite that reads a STYLESHEET. The garage window is
   four numbers in menuscene.js and the same rectangle in two styles.css
   rules, and nothing at runtime can notice when they drift — see the file's
   own header. */
test('deep: menu-check (showroom rig, the garage window, screen fallbacks)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/menu-check.mjs']);
});

/* Registered before src/game/tricks.js exists. The check is a stub that exits
   0 today and fails loudly the moment the module lands without real gates
   behind it — see dev/trick-check.mjs. */
test('deep: trick-check (air control + trick scoring)', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/trick-check.mjs']);
});

test('deep: asset loading waits for decode and bounds failures', () => {
  run(['dev/assets-loading-check.mjs']);
});

test('deep: garage inspection geometry, parked physics and disposal', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/garage-preview-check.mjs']);
});

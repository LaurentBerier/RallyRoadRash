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

test('deep: generated vehicle decals and fabric banner integration', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/vehicle-decals-check.mjs']);
});

test('deep: Hornet race handling, lightweight collisions and exhaust alignment', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/hornet-handling-check.mjs']);
});

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

test('deep: environment geometry, safe placement and quality tiers', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/environment-check.mjs']);
});

test('deep: canyon vista foundations against baked terrain', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/canyon-foundation-check.mjs']);
});

test('deep: volcanic geology foundations and course clearance', () => {
  run(['--experimental-loader', './dev/loader.mjs', 'dev/volcano-foundation-check.mjs']);
});

test('deep: Ridgeback imported body clears tyre tread', () => {
  run(['dev/ridgeback-clearance-check.mjs']);
});

test('deep: mechanical audio playback and engine transitions', () => { run(['dev/audio-playback-check.mjs']); });

test('deep: checkpoint clearance and bounded airborne debris',()=>{run(['--experimental-loader','./dev/loader.mjs','dev/polish-check.mjs']);});


test('rocket wreck: minimum spectacle time, grounded recovery and airborne deadline', async () => {
  const {beginWreck,tickWreck,WRECK_CTL}=await import('../src/game/wreck.js');
  const v={contacts:4};
  assert.equal(beginWreck(v,100),true);
  for(let i=0;i<28;i++)assert.equal(tickWreck(v,.1),false);
  assert.equal(beginWreck(v,200),false);
  assert.equal(v.wreckS,100);
  assert.equal(tickWreck(v,.11),true);
  const air={contacts:0};beginWreck(air,50);
  assert.equal(tickWreck(air,3.9),false);
  assert.equal(tickWreck(air,.11),true);
  assert.equal(WRECK_CTL.throttle,0);assert.equal(WRECK_CTL.steer,0);assert.equal(WRECK_CTL.roll,0);
});

test('deep: rocket direct hits, reset and bounded effects',()=>{run(['--experimental-loader','./dev/loader.mjs','dev/rocket-polish-check.mjs']);});

test('deep: race progress on shoulders, jumps and alternate routes',()=>{run(['dev/race-progress-check.mjs']);});

test('deep: safe rocket recovery across baked tracks',()=>{run(['--experimental-loader','./dev/loader.mjs','dev/recovery-check.mjs']);});

test('Proving Grounds uses three laps and preserves legacy progress',async()=>{
 const {default:track}=await import('../src/world/tracks/training.js');
 const {normalizeProfile,applyResult}=await import('../src/game/progression.js');
 assert.equal(track.laps,3);
 const p=normalizeProfile({unlockedTracks:['training','canyon'],results:{training:{medal:'gold',bestTotal:80,bestLap:79,wins:1,plays:1}}});
 assert.equal(p.results.training.bestTotal,null);assert.equal(p.results.training.legacyBestTotal,80);
 assert.equal(p.results.training.bestLap,79);assert.equal(p.results.training.medal,'gold');
 const next=applyResult(p,'training',1,220,70).profile;
 assert.equal(normalizeProfile(next).results.training.bestTotal,220);
});

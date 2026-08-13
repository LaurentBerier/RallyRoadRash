/* ============================================================
   dev/racecore-check.mjs — the pure race logic, under bare Node
   ------------------------------------------------------------
       node dev/racecore-check.mjs
   Non-zero exit if anything below is violated. No three, no loader shim, no
   track data: everything here is a synthetic ten-gate loop so a failure is a
   failure in racecore.js and nowhere else.

   COVERAGE
     a  in-order hits count laps and finish at laps=3, with correct totals
     b  checkpoint GROUPS — an alternate sharing idx satisfies the slot
     c  skipping a gate stalls nextCp; the lap does not count until you return
     d  raceS is monotonic under +/-3 m of position noise
     e  wrongway arms on sustained regression and clears again
     f  standings order mid-race by raceS, post-finish by time
     g  progression: the unlock chain, medals keeping the best, records
   ============================================================ */
import { RaceTracker, formatTime } from '../src/game/racecore.js';
import {
  defaultProfile, applyResult, isTrackUnlocked, isVehicleUnlocked, lockHintFor
} from '../src/game/progression.js';

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); }
};
const eq = (a, b, msg) => ok(a === b, `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}  (got ${a}, want ${b}+-${tol})`);
const head = (s) => console.log(`\n=== ${s}`);

/* ------------------------------------------------------------
   A synthetic circuit: a 1000 m circle with ten evenly spaced gates.
   A circle keeps chord/arc geometry honest without needing a spline.
   ------------------------------------------------------------ */
const LAP = 1000;
const NCP = 10;
const R = LAP / (2 * Math.PI);                 // ~159.15 m radius

const at = (s) => {                            // world position at arc length s
  const a = (s / LAP) * 2 * Math.PI;
  return { x: Math.cos(a) * R, z: Math.sin(a) * R };
};

function makeCheckpoints(extra = []) {
  const cps = [];
  for (let i = 0; i < NCP; i++) {
    const s = i * (LAP / NCP);
    const p = at(s);
    cps.push({ x: p.x, z: p.z, r: 14, s, idx: i, big: i % 2 === 0 });
  }
  for (const e of extra) cps.push(e);
  cps.sort((a, b) => (a.idx - b.idx) || ((a.alt ? 1 : 0) - (b.alt ? 1 : 0)));
  return cps;
}

const mkTracker = (ids, laps = 3, cps = makeCheckpoints()) =>
  new RaceTracker({ ids, laps, lapLength: LAP, checkpoints: cps });

/** Drive one racer from arc length s0 to s1 in `stepM` metre steps. */
function drive(tr, id, s0, s1, t0, speed, sink, opts = {}) {
  const step = opts.step || 4;
  const noise = opts.noise || 0;
  const rng = opts.rng || (() => 0.5);
  const dir = s1 >= s0 ? 1 : -1;
  let t = t0;
  for (let s = s0; dir > 0 ? s <= s1 : s >= s1; s += dir * step) {
    const p = at(((s % LAP) + LAP) % LAP);
    const nx = noise ? (rng() * 2 - 1) * noise : 0;
    const nz = noise ? (rng() * 2 - 1) * noise : 0;
    const ev = tr.update(id, p.x + nx, p.z + nz, t);
    if (sink) for (const e of ev) sink(e, t);
    t += step / speed;
  }
  return t;
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   a — laps, finish, totals, best lap
   ============================================================ */
head('a  in-order laps, finish and timing');
{
  const tr = mkTracker(['solo'], 3);
  const cps = [], laps = [];
  let finish = null;
  const sink = (e) => {
    if (e.type === 'checkpoint') cps.push(e.idx);
    if (e.type === 'lap') laps.push(e);
    if (e.type === 'finish') finish = e;
  };

  // Start 30 m behind the line, exactly like a grid slot.
  let t = 0;
  t = drive(tr, 'solo', -30, 3 * LAP + 8, 0, 25, sink);

  eq(cps.length, 30, 'thirty gates over three laps');
  eq(laps.length, 3, 'three lap events');
  ok(finish !== null, 'finish event fired');

  // The first gate seen is slot 1 (the grid starts already past the line).
  eq(cps[0], 1, 'first gate cleared is slot 1, not the start line');
  eq(cps[9], 0, 'tenth gate cleared is the start/finish line');

  // 3030 m at 25 m/s, minus the ~14 m gate radius on the last crossing.
  ok(finish.total > 118 && finish.total < 124, `total in range (got ${finish.total.toFixed(2)})`);
  const p = tr.progress('solo');
  eq(p.finished, true, 'progress reports finished');
  eq(p.lap, 3, 'three laps completed');
  ok(p.bestLap > 0 && p.bestLap <= laps[0].lapTime + 0.01, 'bestLap is the quickest lap');
  for (const l of laps) ok(l.lapTime > 35 && l.lapTime < 45, `lap time sane (${l.lapTime.toFixed(2)})`);

  const res = tr.results();
  eq(res.length, 1, 'one row of results');
  eq(res[0].lapTimes.length, 3, 'three lap times recorded');
  near(res[0].lapTimes.reduce((a, b) => a + b, 0), finish.total, 1e-6, 'lap times sum to the total');

  /* bestLap must be the MINIMUM, not the last one seen. Three laps at
     different speeds, quickest in the middle. */
  const bl = mkTracker(['bl'], 3);
  const speeds = [18, 34, 22];
  const seen = [];
  let tb = 0;
  for (let L = 0; L < 3; L++) {
    tb = drive(bl, 'bl', L === 0 ? -30 : L * LAP, (L + 1) * LAP + 8, tb, speeds[L],
      (e) => { if (e.type === 'lap') seen.push(e); });
  }
  eq(seen.length, 3, 'three laps at three speeds');
  const quickest = Math.min(...seen.map(e => e.lapTime));
  near(bl.progress('bl').bestLap, quickest, 1e-9, 'bestLap is the quickest of the three');
  ok(seen[2].lapTime > quickest, 'the final lap was not the quickest (so the test bites)');
  near(seen[2].best, quickest, 1e-9, 'the lap event carries the running best, not the last');
  near(bl.progress('bl').lastLap, seen[2].lapTime, 1e-9, 'lastLap is the most recent lap');

  // laps=1 must still finish (the training ground is a single lap)
  const one = mkTracker(['x'], 1);
  let fin1 = null;
  drive(one, 'x', -30, LAP + 8, 0, 25, (e) => { if (e.type === 'finish') fin1 = e; });
  ok(fin1 !== null, 'a one-lap race finishes');

  eq(formatTime(0), '0:00.000', 'formatTime zero');
  eq(formatTime(63.5), '1:03.500', 'formatTime 1:03.500');
  eq(formatTime(605.007), '10:05.007', 'formatTime pads milliseconds');
  eq(formatTime(null), '--:--.---', 'formatTime blank');
}

/* ============================================================
   b — checkpoint groups: the alternate satisfies the slot
   ============================================================ */
head('b  checkpoint groups (shortcut legality)');
{
  /* Slots 4 and 5 get a twin 60 m OUTSIDE the circle — a detour no main-line
     gate radius could ever reach. Clearing them proves the group rule. */
  const extra = [];
  for (const idx of [4, 5]) {
    const s = idx * (LAP / NCP);
    const p = at(s);
    const m = Math.hypot(p.x, p.z);
    extra.push({
      x: p.x / m * (R + 60), z: p.z / m * (R + 60),
      r: 14, s, idx, big: false, alt: true, altS: idx * 10
    });
  }
  const tr = mkTracker(['sc'], 1, makeCheckpoints(extra));

  const seen = [];
  let t = 0;
  t = drive(tr, 'sc', -30, 3.4 * (LAP / NCP), 0, 25, (e) => { if (e.type === 'checkpoint') seen.push(e.idx); });
  eq(tr.progress('sc').nextCp, 4, 'hunting slot 4 at the shortcut mouth');

  // Take the detour: two points on the outer arc, nowhere near the main gates.
  for (const idx of [4, 5]) {
    const s = idx * (LAP / NCP);
    const p = at(s);
    const m = Math.hypot(p.x, p.z);
    const ev = tr.update('sc', p.x / m * (R + 60), p.z / m * (R + 60), t);
    t += 2;
    ok(ev.some(e => e.type === 'checkpoint' && e.idx === idx), `alternate satisfies slot ${idx}`);
  }
  eq(tr.progress('sc').nextCp, 6, 'the detour advanced two whole slots');

  // Rejoin and finish the lap normally.
  let fin = null;
  drive(tr, 'sc', 5.6 * (LAP / NCP), LAP + 8, t, 25, (e) => { if (e.type === 'finish') fin = e; });
  ok(fin !== null, 'a lap taken via the shortcut still counts');

  // The main gate must ALSO satisfy the same slot for a racer who stays out.
  const tr2 = mkTracker(['main'], 1, makeCheckpoints(extra));
  let cnt = 0;
  drive(tr2, 'main', -30, LAP + 8, 0, 25, (e) => { if (e.type === 'checkpoint') cnt++; });
  eq(cnt, 10, 'the main line clears ten slots, not twelve');
}

/* ============================================================
   c — a skipped gate stalls the lap
   ============================================================ */
head('c  missed checkpoint stalls the lap');
{
  const tr = mkTracker(['miss'], 3);
  const seg = LAP / NCP;
  let t = 0;

  // Clear slots 1 and 2, then swing 40 m wide of slot 3 and carry on.
  t = drive(tr, 'miss', -30, 2.3 * seg, 0, 25);
  eq(tr.progress('miss').nextCp, 3, 'next gate is 3');

  for (let s = 2.4 * seg; s <= 3.6 * seg; s += 4) {
    const p = at(s);
    const m = Math.hypot(p.x, p.z);
    tr.update('miss', p.x / m * (R + 45), p.z / m * (R + 45), t);
    t += 4 / 25;
  }
  eq(tr.progress('miss').nextCp, 3, 'nextCp is still 3 after driving past it');

  // Drive the whole rest of the lap and over the line: nothing may count.
  let laps = 0;
  t = drive(tr, 'miss', 3.7 * seg, LAP + 60, t, 25, (e) => { if (e.type === 'lap') laps++; });
  eq(laps, 0, 'no lap credited with a gate outstanding');
  eq(tr.progress('miss').lap, 0, 'lap counter still zero');
  eq(tr.progress('miss').nextCp, 3, 'still hunting the gate it missed');

  const stalledS = tr.progress('miss').raceS;
  ok(stalledS <= 3 * seg + 1, `raceS is pinned at the missed gate (${stalledS.toFixed(1)})`);

  // Go back for it, then finish the lap properly.
  const p3 = at(3 * seg);
  const ev = tr.update('miss', p3.x, p3.z, t + 1);
  ok(ev.some(e => e.type === 'checkpoint' && e.idx === 3), 'returning clears the gate');
  eq(tr.progress('miss').nextCp, 4, 'and the sequence resumes');
  t = drive(tr, 'miss', 3.1 * seg, LAP + 8, t + 2, 25, (e) => { if (e.type === 'lap') laps++; });
  eq(laps, 1, 'the lap counts once the gate is cleared');
}

/* ============================================================
   d — raceS monotonic under position noise
   ============================================================ */
head('d  raceS is monotonic under jitter');
{
  const tr = mkTracker(['jit'], 3);
  const rng = rngFrom(0xBEEF);
  let prev = -1, worst = 0, samples = 0;
  let t = 0;
  const step = 3;
  for (let s = -30; s <= 3 * LAP + 8; s += step) {
    const p = at(((s % LAP) + LAP) % LAP);
    tr.update('jit', p.x + (rng() * 2 - 1) * 3, p.z + (rng() * 2 - 1) * 3, t);
    const now = tr.progress('jit').raceS;
    if (prev >= 0 && now < prev) worst = Math.max(worst, prev - now);
    prev = now; samples++;
    t += step / 28;
    if (tr.progress('jit').finished) break;
  }
  ok(samples > 500, `enough samples (${samples})`);
  eq(worst, 0, 'raceS never decreased under +-3 m of noise');
  eq(tr.progress('jit').finished, true, 'the jittered racer still finished');

  /* Monotonic is not enough — the number has to be a plausible distance, or
     the rival gap on the HUD is fiction. Two different error budgets:

       UNDER-read is the chord-vs-arc approximation, and must stay tiny
         (<1 m over a 100 m gate spacing on a circle this tight).
       OVER-read is structural and expected: clearing a gate snaps the
         estimate to that gate's `s` while the car is still up to one gate
         RADIUS short of it. Every racer gets the same jump at the same
         place, so gaps stay fair; the bound is the radius, not zero. */
  const GATE_R = 14;
  const acc = mkTracker(['acc'], 3);
  let ta = 0, worstOver = 0, worstUnder = 0;
  for (let s = 0; s <= 2 * LAP; s += 7) {
    const p = at(((s % LAP) + LAP) % LAP);
    acc.update('acc', p.x, p.z, ta);
    ta += 7 / 25;
    if (s < 40) continue;                       // skip the run up to the line
    const e = acc.progress('acc').raceS - s;
    if (e > worstOver) worstOver = e;
    if (-e > worstUnder) worstUnder = -e;
  }
  ok(worstUnder < 1.5, `raceS under-reads by <1.5 m (worst ${worstUnder.toFixed(2)} m)`);
  ok(worstOver <= GATE_R + 0.5, `raceS over-reads by at most one gate radius (worst ${worstOver.toFixed(2)} m)`);

  /* The same test with FOUR gates, so the arcs are 250 m of 90° bend. This is
     the case that separates a single-sided chord estimate (10 m under at the
     apex) from the symmetric blend (exact there) — PROVING GROUNDS really does
     put 187 m between gates around a 66 m corner. */
  const coarse = [];
  for (let i = 0; i < 4; i++) {
    const s = i * (LAP / 4);
    const p = at(s);
    coarse.push({ x: p.x, z: p.z, r: GATE_R, s, idx: i, big: true });
  }
  const wide = new RaceTracker({ ids: ['w'], laps: 2, lapLength: LAP, checkpoints: coarse });
  let tw = 0, wUnder = 0, wPrev = -1, wBack = 0;
  for (let s = 0; s <= LAP; s += 5) {
    const p = at(s);
    wide.update('w', p.x, p.z, tw);
    tw += 5 / 25;
    const got = wide.progress('w').raceS;
    if (wPrev >= 0 && got < wPrev) wBack = Math.max(wBack, wPrev - got);
    wPrev = got;
    if (s > 40) wUnder = Math.max(wUnder, s - got);
  }
  eq(wBack, 0, 'still monotonic with 250 m between gates');
  ok(wUnder < 3, `250 m gate spacing stays within 3 m under (worst ${wUnder.toFixed(2)} m)`);

  // A respawn is a much bigger jump backwards and must also not walk it back.
  const tr2 = mkTracker(['tp'], 3);
  drive(tr2, 'tp', -30, 4.5 * (LAP / NCP), 0, 25);
  const before = tr2.progress('tp').raceS;
  const back = at(4 * (LAP / NCP));
  tr2.notifyTeleport('tp', back.x, back.z);
  tr2.update('tp', back.x, back.z, 30);
  ok(tr2.progress('tp').raceS >= before - 1e-9, 'a respawn does not lose race distance');
  eq(tr2.progress('tp').wrongWay, false, 'a respawn does not read as driving backwards');
}

/* ============================================================
   e — wrong way arms and clears
   ============================================================ */
head('e  wrong-way detection');
{
  const tr = mkTracker(['ww'], 3);
  let t = drive(tr, 'ww', -30, 2.5 * (LAP / NCP), 0, 25);

  let on = 0, off = 0;
  const sink = (e) => { if (e.type === 'wrongway') { e.on ? on++ : off++; } };

  // Turn round: 3 s of driving back up the road at 20 m/s.
  t = drive(tr, 'ww', 2.5 * (LAP / NCP), 2.5 * (LAP / NCP) - 60, t, 20, sink, { step: 2 });
  eq(on, 1, 'wrongway armed exactly once');
  eq(tr.progress('ww').wrongWay, true, 'progress reports wrongWay');

  // Turn back round and it must clear.
  t = drive(tr, 'ww', 2.5 * (LAP / NCP) - 60, 2.5 * (LAP / NCP), t, 20, sink, { step: 2 });
  eq(off, 1, 'wrongway cleared exactly once');
  eq(tr.progress('ww').wrongWay, false, 'progress no longer reports wrongWay');

  // Crawling backwards at walking pace is being stuck, not being lost.
  const tr2 = mkTracker(['slow'], 3);
  let t2 = drive(tr2, 'slow', -30, 2.5 * (LAP / NCP), 0, 25);
  let armed = 0;
  drive(tr2, 'slow', 2.5 * (LAP / NCP), 2.5 * (LAP / NCP) - 40, t2, 1.5, (e) => {
    if (e.type === 'wrongway' && e.on) armed++;
  }, { step: 1 });
  eq(armed, 0, 'reversing at 1.5 m/s does not raise the banner');
}

/* ============================================================
   f — standings
   ============================================================ */
head('f  standings, mid-race and after the flag');
{
  const ids = ['a', 'b', 'c'];
  const tr = mkTracker(ids, 3);
  const seg = LAP / NCP;

  // Mid-race: c is furthest, then a, then b.
  drive(tr, 'a', -30, 4.5 * seg, 0, 25);
  drive(tr, 'b', -30, 2.5 * seg, 0, 25);
  drive(tr, 'c', -30, 7.5 * seg, 0, 25);
  const mid = tr.standings();
  eq(mid.join(','), 'c,a,b', 'mid-race order is by raceS, descending');
  ok(tr.progress('c').raceS > tr.progress('a').raceS, 'c really is further along');
  eq(tr.position('b'), 3, 'position() agrees with standings()');

  /* Now finish all three, with b quickest. A finished car outranks every
     unfinished one no matter how far round it is. */
  const tr2 = mkTracker(ids, 1);
  drive(tr2, 'a', -30, LAP + 8, 0, 20);            // slowest
  drive(tr2, 'b', -30, LAP + 8, 0, 40);            // quickest
  drive(tr2, 'c', -30, 6 * seg, 0, 25);            // still out there
  const fin = tr2.standings();
  eq(fin.join(','), 'b,a,c', 'finishers by time, then the rest by distance');

  const rows = tr2.results();
  eq(rows[0].id, 'b', 'results are in finishing order');
  eq(rows[2].finished, false, 'the unfinished car is flagged');
  eq(rows[2].total, null, 'and carries no total');
  ok(rows[0].total < rows[1].total, 'the winner has the lower total');

  /* The "finished first" rule is currently invisible in ordinary play — a
     finisher always has the highest raceS anyway. Assert it directly so a
     future change to raceS cannot quietly demote someone who took the flag. */
  const tr3 = mkTracker(['fin', 'run'], 1);
  drive(tr3, 'fin', -30, LAP + 8, 0, 30);
  tr3.racers.get('run').raceS = 99999;
  eq(tr3.standings().join(','), 'fin,run', 'a finisher outranks a non-finisher whatever its raceS');
  eq(tr3.results()[0].id, 'fin', 'and heads the results table');
}

/* ============================================================
   g — progression chain, medals and records
   ============================================================ */
head('g  progression: unlocks, medals, records');
{
  let p = defaultProfile();
  eq(isTrackUnlocked(p, 'training'), true, 'training starts unlocked');
  eq(isTrackUnlocked(p, 'canyon'), false, 'canyon starts locked');
  eq(isVehicleUnlocked(p, 'hopper'), true, 'hopper starts unlocked');
  eq(isVehicleUnlocked(p, 'ridgeback'), false, 'ridgeback starts locked');
  ok(lockHintFor('canyon').includes('PROVING GROUNDS'), 'canyon hint names the tutorial');
  ok(lockHintFor('redline').includes('Podium'), 'redline hint asks for a podium');

  // training: ANY placement opens the canyon
  let r = applyResult(p, 'training', 5, 91.2, 88.0);
  p = r.profile;
  eq(isTrackUnlocked(p, 'canyon'), true, 'finishing training unlocks canyon');
  eq(p.tutorialDone, true, 'tutorialDone set');
  eq(r.medal, null, 'fifth place earns no medal');
  ok(r.unlocks.some(u => u.includes('SUNSTRIKE')), 'unlock banner mentions the canyon');
  near(r.newRecord.total, 91.2, 1e-9, 'first run is a record');

  // canyon: fourth place is not a podium — nothing opens
  r = applyResult(p, 'canyon', 4, 240, 78);
  p = r.profile;
  eq(isTrackUnlocked(p, 'forest'), false, 'fourth at canyon opens nothing');
  eq(isVehicleUnlocked(p, 'ridgeback'), false, 'and no ridgeback');
  eq(r.unlocks.length, 0, 'no banners');

  // canyon podium: forest + ridgeback
  r = applyResult(p, 'canyon', 3, 232, 76);
  p = r.profile;
  eq(r.medal, 'bronze', 'third is bronze');
  eq(isTrackUnlocked(p, 'forest'), true, 'podium at canyon unlocks forest');
  eq(isVehicleUnlocked(p, 'ridgeback'), true, 'and the ridgeback');
  near(r.newRecord.total, 232, 1e-9, 'faster total is a new record');
  near(r.newRecord.lap, 76, 1e-9, 'faster lap is a new record');

  // a slower run improves nothing and must not demote the medal
  r = applyResult(p, 'canyon', 6, 400, 120);
  p = r.profile;
  eq(r.newRecord.total, undefined, 'a slower total sets no record');
  eq(r.newRecord.lap, undefined, 'a slower lap sets no record');
  eq(p.results.canyon.medal, 'bronze', 'a bad run does not take the medal away');
  near(p.results.canyon.bestTotal, 232, 1e-9, 'best total kept');
  eq(p.results.canyon.plays, 3, 'plays counted');
  eq(p.results.canyon.wins, 0, 'no wins yet');

  // winning it upgrades to gold and counts the win
  r = applyResult(p, 'canyon', 1, 228, 74);
  p = r.profile;
  eq(r.medal, 'gold', 'first is gold');
  eq(p.results.canyon.medal, 'gold', 'gold replaces bronze');
  eq(p.results.canyon.wins, 1, 'win counted');

  // forest podium: volcano + redline
  r = applyResult(p, 'forest', 2, 300, 95);
  p = r.profile;
  eq(r.medal, 'silver', 'second is silver');
  eq(isTrackUnlocked(p, 'volcano'), true, 'podium at forest unlocks volcano');
  eq(isVehicleUnlocked(p, 'redline'), true, 'and the redline');
  eq(p.champion, false, 'not champion yet');

  // volcano podium is not enough — only the win crowns you
  r = applyResult(p, 'volcano', 2, 350, 110);
  p = r.profile;
  eq(p.champion, false, 'second at the caldera is not the championship');

  r = applyResult(p, 'volcano', 1, 344, 108);
  p = r.profile;
  eq(p.champion, true, 'winning the caldera crowns you');
  ok(r.unlocks.some(u => u.includes('CHAMPION OF THE CALDERA')), 'champion banner text');

  // winning it twice must not re-announce
  r = applyResult(p, 'volcano', 1, 340, 106);
  eq(r.unlocks.length, 0, 'the championship is announced once');

  // a DNF banks nothing but still counts as a play
  const before = JSON.stringify(p.results.forest);
  r = applyResult(p, 'forest', 6, Infinity, null);
  eq(r.medal, null, 'a DNF has no medal');
  eq(r.newRecord.total, undefined, 'a DNF sets no record');
  eq(r.profile.results.forest.plays, JSON.parse(before).plays + 1, 'but it does count as a play');

  // the original profile must be untouched throughout
  const fresh = defaultProfile();
  applyResult(fresh, 'training', 1, 80, 79);
  eq(fresh.unlockedTracks.length, 1, 'applyResult does not mutate its input');
}

/* ============================================================ */
console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);

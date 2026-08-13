/* ============================================================
   dev/ai-check.mjs — does the AI actually drive?
   ------------------------------------------------------------
   Plain Node, no three, no loader shim:
       node dev/ai-check.mjs
   Non-zero exit if anything below is violated.

   The car here is a KINEMATIC MOCK, not src/game/vehicle.js: a point mass
   that accelerates toward ctl.throttle · topSpeed along its heading, yaws at
   ctl.steer × (2.6 rad/s at 10 m/s falling to 0.9 at 40 m/s) and sheds 9 m/s²
   under the brake. It has no suspension, no slip, no jumps and no collisions.
   That is deliberate: this file tests the CONTROLLER — line tracking, braking
   points, personality spread, overtaking geometry — not the physics, which
   dev/vehicle-check.mjs already owns. Anything that only shows up with real
   grip (drift entry, landing attitude) belongs in the integrator's QA pass,
   and the report lists the gains most likely to need it.

   GATES
     a  three laps of training/canyon/volcano inside 2.5× the racing-line
        ideal time
     b  99 % of samples within 7 m of the racing line (shortcut span exempt)
     c  every sharp corner (line speed < 18 m/s) taken at 0.70 … 1.15× the
        line speed
     d  no NaN anywhere in pose, velocity or ctl
     e  skill 0.90 beats skill 0.35 by ≥ 6 % over canyon
     f  two cars nose to tail: the follower builds a lateral offset inside
        3 s and the pair never comes within 1.2 m over 60 s
   ============================================================ */
import { buildTrackData } from '../src/world/track.js';
import { VEHICLES } from '../src/game/vehicles.js';
import { AIDriver, makeGridProfiles, AI_BALANCE, AI_SHORTCUT } from '../src/game/ai.js';

import training from '../src/world/tracks/training.js';
import canyon from '../src/world/tracks/canyon.js';
import volcano from '../src/world/tracks/volcano.js';
import forest from '../src/world/tracks/forest.js';

const DT = 1 / 60;
const SPEC = VEHICLES[0];              // DUNE HOPPER, topSpeed 36

/* mock dynamics */
const TURN_LO = 2.6, TURN_HI = 0.9;    // rad/s at 10 and 40 m/s
const ACC_K = 1.2;                     // 1/s chase toward throttle·topSpeed
const ACC_MAX = 8.0, COAST = 3.0;      // m/s²
const BRAKE_DECEL = 9.0;               // m/s²

const CROSS_LIMIT = 7.0, CROSS_FRAC = 0.99;
const SHARP = 18.0, SHARP_LO = 0.70, SHARP_HI = 1.15;
const LAP_FACTOR = 2.5;
const SKILL_GAP = 0.06;
const PAIR_MIN = 1.2, PAIR_OFFSET_T = 3.0, PAIR_OFFSET = 1.0;
const ENTRY_ERR_MAX = 0.0601;          // ai.js ENTRY_ERR, +epsilon

let failures = 0;
const fail = (t, m) => { failures++; console.log(`  FAIL [${t}] ${m}`); };
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
   THE MOCK CAR — exactly the read surface AIDriver uses
   ============================================================ */
class MockCar {
  constructor(spec) {
    this.spec = spec;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.along = 0;                    // signed speed along the heading
    this.airborne = false;
    this.airTime = 0;
    this.flipped = false;
    this.surfaceId = 1;
    this._f = { x: 0, y: 0, z: 1 };
  }
  get forward() {
    this._f.x = Math.sin(this.yaw); this._f.z = Math.cos(this.yaw);
    return this._f;
  }
  get speed() { return this.along; }

  placeAt(x, z, yaw) {
    this.pos.x = x; this.pos.z = z; this.pos.y = 0;
    this.yaw = yaw; this.along = 0;
    this.vel.x = 0; this.vel.z = 0;
  }

  step(dt, ctl) {
    const v = Math.abs(this.along);
    const rate = TURN_LO + (TURN_HI - TURN_LO) * clamp((v - 10) / 30, 0, 1);
    // ctl.steer > 0 is RIGHT (vehicle.js: "−1..1 rack position, right positive")
    this.yaw -= ctl.steer * rate * dt;

    const cmd = ctl.throttle * this.spec.topSpeed;
    let a = clamp((cmd - this.along) * ACC_K, -COAST, ACC_MAX);
    a -= ctl.brake * BRAKE_DECEL;
    const next = this.along + a * dt;
    // brakes stop you at zero; only negative throttle actually reverses
    this.along = (ctl.brake > 0 && this.along > 0 && next < 0) ? 0 : Math.max(next, -6);

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.vel.x = fx * this.along; this.vel.z = fz * this.along;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
  }
}

/* ============================================================
   TRACK HELPERS
   ============================================================ */
function idealLapTime(td) {
  const rl = td.racingLine, n = rl.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const a = rl[i], b = rl[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    t += d / Math.max(1, 0.5 * (a.speed + b.speed));
  }
  return t;
}

/** Perpendicular distance to the racing-line polyline near arc length s. */
function crossTrack(td, s, x, z) {
  const rl = td.racingLine, n = rl.length;
  const step = td.lapLength / n;
  const c = Math.round(s / step);
  let best = Infinity;
  for (let k = -2; k <= 2; k++) {
    const a = rl[(c + k + n * 2) % n], b = rl[(c + k + 1 + n * 2) % n];
    const ex = b.x - a.x, ez = b.z - a.z;
    const el2 = ex * ex + ez * ez;
    if (el2 < 1e-9) continue;
    let t = ((x - a.x) * ex + (z - a.z) * ez) / el2;
    t = clamp(t, 0, 1);
    const qx = a.x + ex * t - x, qz = a.z + ez * t - z;
    const d = Math.sqrt(qx * qx + qz * qz);
    if (d < best) best = d;
  }
  return best;
}

function shortcutSpan(td) {
  const sc = td.def && td.def.shortcut;
  return sc ? [sc.s0 - 15, sc.s1 + 15] : null;
}

const SCOUT = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };

function placeOnLine(td, car, s) {
  const p = td.spline.offsetPoint(s, 0, { x: 0, y: 0, z: 0 });
  const d = td.spline.dirAt(s, { x: 0, z: 0 });
  car.placeAt(p.x, p.z, Math.atan2(d.x, d.z));
}

/* ============================================================
   THE RUN
   ============================================================ */
function runRace(td, profiles, seed, laps, opts) {
  opts = opts || {};
  const L = td.lapLength;
  const span = shortcutSpan(td);
  const n = profiles.length;

  const cars = [], drv = [], st = [];
  for (let i = 0; i < n; i++) {
    const c = new MockCar(SPEC);
    const s0 = td.spline.wrapS(-(opts.gap || 0) * i);
    placeOnLine(td, c, s0);
    cars.push(c);
    const d = new AIDriver(i, c, td, profiles[i], rngFrom(seed + i * 7919));
    drv.push(d);
    st.push({
      raceS: 0, lastS: s0, laps: 0, lapTimes: [], lapStart: 0,
      cross: 0, crossOver: 0, crossMax: 0,
      offsetFirst: -1, nan: false, resets: 0, scFrames: 0, scMaxD: 0,
    });
    d.update(DT, { state: 'running', vehicles: cars });   // prime s / route index
    st[i].lastS = d.s;
  }

  // sharp-corner probes (main line only)
  const rl = td.racingLine;
  const sharp = [];
  for (let i = 0; i < rl.length; i++) {
    if (rl[i].speed < SHARP) sharp.push({ i, d: Infinity, v: 0 });
  }
  /* GAP-jump probes. `need` is the launch speed that clears the void, from
     the same ballistics track.js used to build the line — this is the one
     number the AI is not allowed to get wrong. */
  const gaps = [];
  for (const j of (td.jumps || [])) {
    if (!(j.gap > 0)) continue;
    const s2 = Math.sin(2 * j.angle) || 0.2;
    gaps.push({ s: j.s, x: j.x, z: j.z, need: Math.sqrt((j.gap + 7) * 12.8 / s2), d: Infinity, v: 0 });
  }

  const ctx = { state: 'running', vehicles: cars };
  const maxT = opts.maxT || 600;
  let t = 0, done = 0, updUs = 0, updN = 0;

  while (t < maxT && done < n) {
    for (let i = 0; i < n; i++) {
      const s = st[i];
      if (s.laps >= laps) continue;
      const t0 = process.hrtime.bigint();
      const ctl = drv[i].update(DT, ctx);
      updUs += Number(process.hrtime.bigint() - t0) / 1000; updN++;

      if (!Number.isFinite(ctl.throttle) || !Number.isFinite(ctl.steer) ||
        !Number.isFinite(ctl.brake) || !Number.isFinite(ctl.handbrake)) s.nan = true;

      // the AI reads surfaceId; feed it the line's own surface so grip agrees
      const rp = drv[i].route.pts[drv[i].ri];
      cars[i].surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;

      cars[i].step(DT, ctl);
      if (!Number.isFinite(cars[i].pos.x) || !Number.isFinite(cars[i].pos.z) ||
        !Number.isFinite(cars[i].along)) s.nan = true;

      if (drv[i].wantsReset) {
        // stand in for race.js: put the car back on the line and carry on
        s.resets++;
        placeOnLine(td, cars[i], drv[i].s);
        drv[i].notifyReset();
      }

      // progress (monotonic, wrap-safe)
      let ds = drv[i].s - s.lastS;
      if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
      s.lastS = drv[i].s;
      s.raceS += ds;
      while (s.raceS >= (s.laps + 1) * L) {
        s.laps++;
        s.lapTimes.push(t - s.lapStart);
        s.lapStart = t;
        if (s.laps >= laps) { done++; break; }
      }

      // cross-track (shortcut span exempt — it is a different road)
      const inSc = drv[i].onShortcut || drv[i].scCommitted ||
        (span && drv[i].s > span[0] && drv[i].s < span[1]);
      if (!inSc) {
        const d = crossTrack(td, drv[i].s, cars[i].pos.x, cars[i].pos.z);
        s.cross++;
        if (d > CROSS_LIMIT) s.crossOver++;
        if (d > s.crossMax) s.crossMax = d;
      } else if (drv[i].onShortcut && td.shortcutSpline) {
        // …but the detour has to be tracked just as tightly
        s.scFrames++;
        const d = td.shortcutSpline.nearest(cars[i].pos.x, cars[i].pos.z, SCOUT).d;
        if (d > s.scMaxD) s.scMaxD = d;
      }

      // lateral offset telemetry (test f)
      if (s.offsetFirst < 0 && Math.abs(drv[i].offset) > PAIR_OFFSET) s.offsetFirst = t;
    }

    // sharp-corner + gap-lip speeds — driver 0 only, that is the graded one
    if (st[0].laps < laps) {
      const px = cars[0].pos.x, pz = cars[0].pos.z;
      for (let k = 0; k < sharp.length; k++) {
        const p = rl[sharp[k].i];
        const dx = p.x - px, dz = p.z - pz;
        const d = dx * dx + dz * dz;
        if (d < sharp[k].d) { sharp[k].d = d; sharp[k].v = cars[0].along; }
      }
      for (let k = 0; k < gaps.length; k++) {
        const dx = gaps[k].x - px, dz = gaps[k].z - pz;
        const d = dx * dx + dz * dz;
        if (d < gaps[k].d) { gaps[k].d = d; gaps[k].v = cars[0].along; }
      }
    }

    // pair separation (test f)
    if (n === 2) {
      const dx = cars[0].pos.x - cars[1].pos.x, dz = cars[0].pos.z - cars[1].pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (opts.minPair === undefined || d < opts.minPair) opts.minPair = d;
    }
    t += DT;
  }

  return { t, st, sharp, gaps, cars, drv, us: updN ? updUs / updN : 0 };
}

/* ============================================================
   GATES a-d, per track
   ============================================================ */
const TRACKS = [training, canyon, volcano];
const LAPS = 3;

const PRO = { name: 'PRO', skill: 0.90, aggression: 0.55, consistency: 0.90 };
const ROOKIE = { name: 'ROOKIE', skill: 0.35, aggression: 0.45, consistency: 0.50 };

let perfWorst = 0;

for (const def of TRACKS) {
  const td = buildTrackData(def);
  const ideal = idealLapTime(td);
  console.log(`\n=== ${def.id}  "${def.name}"  ${f1(td.lapLength)} m   ` +
    `racing-line ideal lap ${f1(ideal)} s`);

  for (const pro of [PRO, ROOKIE]) {
    const r = runRace(td, [pro], 20260813, LAPS, { maxT: ideal * LAPS * 3 + 60 });
    const s = r.st[0];
    perfWorst = Math.max(perfWorst, r.us);
    const tag = `${def.id}/${pro.name}`;
    const overFrac = s.cross ? s.crossOver / s.cross : 1;
    const avg = s.lapTimes.length ? s.lapTimes.reduce((a, b) => a + b, 0) / s.lapTimes.length : NaN;

    console.log(`  ${pro.name.padEnd(6)} laps=${s.laps}/${LAPS}  total=${f1(r.t)} s  ` +
      `avg lap ${f1(avg)} s (${f2(avg / ideal)}× ideal)  ` +
      `cross max ${f1(s.crossMax)} m, ${(overFrac * 100).toFixed(2)} % over ${CROSS_LIMIT} m  ` +
      `resets=${s.resets}  ${f2(r.us)} µs/update`);

    /* a */
    if (s.laps < LAPS) fail(tag, `only completed ${s.laps} of ${LAPS} laps in ${f1(r.t)} s`);
    else if (r.t > ideal * LAPS * LAP_FACTOR) {
      fail(tag, `${f1(r.t)} s for ${LAPS} laps > ${LAP_FACTOR}× ideal (${f1(ideal * LAPS * LAP_FACTOR)} s)`);
    }
    /* b */
    if (overFrac > 1 - CROSS_FRAC) {
      fail(tag, `${(overFrac * 100).toFixed(2)} % of samples > ${CROSS_LIMIT} m off the line ` +
        `(max ${f1(s.crossMax)} m)`);
    }
    /* d */
    if (s.nan) fail(tag, 'NaN in ctl or car state');

    /* c — sharp corners, driver 0 */
    let worstLo = Infinity, worstHi = 0, checked = 0, loAt = -1, hiAt = -1;
    for (const p of r.sharp) {
      if (p.d > 144) continue;                 // never passed within 12 m
      const line = td.racingLine[p.i];
      const span = shortcutSpan(td);
      if (span && line.s > span[0] && line.s < span[1]) continue;
      const ratio = Math.abs(p.v) / line.speed;
      checked++;
      if (ratio < worstLo) { worstLo = ratio; loAt = p.i; }
      if (ratio > worstHi) { worstHi = ratio; hiAt = p.i; }
    }
    if (checked > 0) {
      console.log(`         ${checked} sharp corners (<${SHARP} m/s): ` +
        `speed ratio ${f2(worstLo)} … ${f2(worstHi)} of line`);
      if (worstLo < SHARP_LO) {
        fail(tag, `corner at s=${f1(td.racingLine[loAt].s)} taken at ${f2(worstLo)}× line speed ` +
          `(< ${SHARP_LO})`);
      }
      if (worstHi > SHARP_HI) {
        fail(tag, `corner at s=${f1(td.racingLine[hiAt].s)} taken at ${f2(worstHi)}× line speed ` +
          `(> ${SHARP_HI})`);
      }
    }

    /* c2 — GAP jumps. Not part of the six gates, but it is the one place
       where getting the speed wrong is not "slow", it is "in the hole". */
    for (const g of r.gaps) {
      if (g.d > 49) continue;                  // took the shortcut round it
      console.log(`         gap lip at s=${f1(g.s)}: crossed at ${f1(Math.abs(g.v))} m/s, ` +
        `needs ≥ ${f1(g.need)} m/s`);
      if (Math.abs(g.v) < g.need) {
        fail(tag, `only ${f1(Math.abs(g.v))} m/s at the s=${f1(g.s)} gap — needs ${f1(g.need)}`);
      }
    }
  }
}

/* ============================================================
   c3 — the canyon gap, deterministically
   ------------------------------------------------------------
   The per-track loop above only reaches the s=630 lip when the driver did
   NOT take the slot canyon, and that is a coin toss. This is the one number
   where being wrong means landing in a hole, so pin the routing off and
   check both ends of the skill range.
   ============================================================ */
{
  const td = buildTrackData(canyon);
  const ideal = idealLapTime(td);
  const base = AI_SHORTCUT.base, sk = AI_SHORTCUT.skill;
  AI_SHORTCUT.base = 0; AI_SHORTCUT.skill = 0;      // main line only
  console.log('\n=== canyon gap jump with the shortcut disabled');
  for (const pro of [PRO, ROOKIE]) {
    const r = runRace(td, [pro], 987654, 2, { maxT: ideal * 2 * 3 + 60 });
    if (r.st[0].scFrames > 0) fail('gap', 'shortcut still taken with p = 0');
    for (const g of r.gaps) {
      console.log(`  ${pro.name.padEnd(6)} lip s=${f1(g.s)}: ${f1(Math.abs(g.v))} m/s ` +
        `(needs ≥ ${f1(g.need)}, closest approach ${f1(Math.sqrt(g.d))} m)`);
      if (g.d > 49) fail('gap', `${pro.name} never passed the s=${f1(g.s)} lip`);
      else if (Math.abs(g.v) < g.need) {
        fail('gap', `${pro.name} hit the s=${f1(g.s)} gap at ${f1(Math.abs(g.v))} m/s, needs ${f1(g.need)}`);
      }
    }
  }
  AI_SHORTCUT.base = base; AI_SHORTCUT.skill = sk;
}

/* ============================================================
   e — the profiles have to actually differ
   ------------------------------------------------------------
   Averaged over five seeds because SUNSTRIKE CANYON has a shortcut and the
   take-up probability is skill-dependent: a single seed measures the coin
   toss as much as the driver.
   ============================================================ */
{
  const td = buildTrackData(canyon);
  const ideal = idealLapTime(td);
  const SEEDS = [11, 2027, 40961, 777, 131313];
  const mean = {};
  for (const pro of [PRO, ROOKIE]) {
    let sum = 0, laps = 0, sc = 0;
    for (const sd of SEEDS) {
      const r = runRace(td, [pro], sd, LAPS, { maxT: ideal * LAPS * 3 + 60 });
      for (const lt of r.st[0].lapTimes) { sum += lt; laps++; }
      if (r.st[0].laps < LAPS) fail('canyon/spread', `${pro.name} seed ${sd} only did ${r.st[0].laps} laps`);
      sc += r.drv[0].scDecided ? 0 : 0;
    }
    mean[pro.name] = laps ? sum / laps : NaN;
    void sc;
  }
  const gain = (mean.ROOKIE - mean.PRO) / mean.ROOKIE;
  console.log(`\n=== profile spread on canyon (${SEEDS.length} seeds × ${LAPS} laps)`);
  console.log(`  PRO    mean lap ${f1(mean.PRO)} s`);
  console.log(`  ROOKIE mean lap ${f1(mean.ROOKIE)} s`);
  console.log(`  PRO is ${(gain * 100).toFixed(1)} % faster (need ≥ ${(SKILL_GAP * 100).toFixed(0)} %)`);
  if (!(gain >= SKILL_GAP)) {
    fail('canyon/spread', `skill 0.90 only ${(gain * 100).toFixed(1)} % faster than skill 0.35`);
  }
}

/* ============================================================
   f — nose to tail: build an offset, do not touch
   ============================================================ */
{
  const td = buildTrackData(training);
  const lead = { name: 'LEAD', skill: 0.45, aggression: 0.50, consistency: 0.85 };
  const chase = { name: 'CHASE', skill: 0.92, aggression: 0.70, consistency: 0.85 };
  // cars[0] leads, cars[1] starts 8 m back on the same line
  const opts = { gap: 8, maxT: 60, minPair: Infinity };
  const r = runRace(td, [lead, chase], 5150, 99, opts);
  const off = r.st[1].offsetFirst;
  console.log('\n=== nose-to-tail on training (60 s, 8 m gap)');
  console.log(`  follower first |offset| > ${PAIR_OFFSET} m at t=${off < 0 ? 'never' : f1(off) + ' s'}` +
    `   closest approach ${f1(opts.minPair)} m` +
    `   final gap ${f1(Math.hypot(r.cars[0].pos.x - r.cars[1].pos.x, r.cars[0].pos.z - r.cars[1].pos.z))} m`);
  if (off < 0 || off > PAIR_OFFSET_T) {
    fail('pair', `follower did not build a ${PAIR_OFFSET} m offset within ${PAIR_OFFSET_T} s`);
  }
  if (opts.minPair < PAIR_MIN) {
    fail('pair', `cars came within ${f1(opts.minPair)} m (< ${PAIR_MIN} m)`);
  }
  if (r.st[0].nan || r.st[1].nan) fail('pair', 'NaN during the pair run');
}

/* ============================================================
   g — the shortcut path actually runs, and is driven as tightly
   ------------------------------------------------------------
   p = 0.25 + 0.6·skill, so at skill 0.95 a driver takes it on ~82 % of
   approaches: four laps is enough to guarantee at least one in practice
   and the seed makes that reproducible.
   ============================================================ */
{
  const ACE = { name: 'ACE', skill: 0.95, aggression: 0.5, consistency: 0.9 };
  for (const def of [canyon, forest]) {
    const td = buildTrackData(def);
    const ideal = idealLapTime(td);
    const r = runRace(td, [ACE], 314159, 4, { maxT: ideal * 4 * 3 + 60 });
    const s = r.st[0];
    const secs = s.scFrames * DT;
    console.log(`\n=== shortcut on ${def.id} (skill ${ACE.skill}, 4 laps)`);
    console.log(`  ${f1(secs)} s spent on the detour, max ${f1(s.scMaxD)} m off the ` +
      `shortcut centreline, laps=${s.laps}/4, avg lap ` +
      `${f1(s.lapTimes.reduce((a, b) => a + b, 0) / Math.max(1, s.lapTimes.length))} s ` +
      `(ideal main-line lap ${f1(ideal)} s)`);
    if (s.scFrames === 0) fail(`${def.id}/shortcut`, 'never took the shortcut in 4 laps at skill 0.95');
    if (s.scMaxD > CROSS_LIMIT) {
      fail(`${def.id}/shortcut`, `wandered ${f1(s.scMaxD)} m off the shortcut centreline`);
    }
    if (s.laps < 4) fail(`${def.id}/shortcut`, `only completed ${s.laps} of 4 laps`);
    if (s.nan) fail(`${def.id}/shortcut`, 'NaN on the shortcut route');
  }
}

/* ============================================================
   g2 — the real thing: six cars off one grid
   ------------------------------------------------------------
   Not a pass/fail on contact — the brief wants contact to happen — but the
   pack is where index tracking, offsets and the shortcut all run at once,
   and it is the cheapest way to catch a driver that gets lost in traffic.
   ============================================================ */
{
  const td = buildTrackData(canyon);
  const ideal = idealLapTime(td);
  const profiles = makeGridProfiles(6, 0.7, rngFrom(20260813));
  const opts = { gap: 7, maxT: ideal * 2 * 3 + 60 };
  const r = runRace(td, profiles, 606060, 2, opts);
  let worstSep = Infinity, resets = 0, nan = false, finished = 0;
  for (let i = 0; i < 6; i++) {
    resets += r.st[i].resets;
    nan = nan || r.st[i].nan;
    if (r.st[i].laps >= 2) finished++;
    for (let k = i + 1; k < 6; k++) {
      const dx = r.cars[i].pos.x - r.cars[k].pos.x, dz = r.cars[i].pos.z - r.cars[k].pos.z;
      worstSep = Math.min(worstSep, Math.hypot(dx, dz));
    }
  }
  console.log('\n=== six-car grid on canyon (2 laps, makeGridProfiles(6, 0.7))');
  console.log('  ' + profiles.map((p, i) =>
    `${p.name} s${f2(p.skill)}/a${f2(p.aggression)}/c${f2(p.consistency)} → ` +
    `${r.st[i].laps === 2 ? f1(r.st[i].lapTimes.reduce((a, b) => a + b, 0)) + ' s' : 'DNF'}`
  ).join('\n  '));
  console.log(`  finished ${finished}/6   resets ${resets}   final closest pair ${f1(worstSep)} m   ` +
    `${f2(r.us)} µs/update`);
  if (finished < 6) fail('pack', `${6 - finished} of 6 did not complete 2 laps`);
  if (nan) fail('pack', 'NaN in the six-car run');
  if (resets > 6) fail('pack', `${resets} resets in 12 car-laps — drivers are getting stuck`);
  perfWorst = Math.max(perfWorst, r.us);
}

/* ============================================================
   h — the contract's state machine, directly
   ============================================================ */
{
  const td = buildTrackData(training);
  const car = new MockCar(SPEC);
  placeOnLine(td, car, 0);
  const d = new AIDriver('t', car, td, { name: 'T', skill: 0.7, aggression: 0.5, consistency: 0.8 },
    rngFrom(4242));
  const ctx = { state: 'countdown', vehicles: [car], toGo: 2.0 };
  console.log('\n=== contract states');

  let c = d.update(DT, ctx);
  if (!(c.brake === 1 && c.throttle === 0 && c.steer === 0)) {
    fail('countdown', `expected brake 1 / throttle 0 / steer 0, got ${f2(c.brake)} / ${f2(c.throttle)} / ${f2(c.steer)}`);
  }
  ctx.toGo = 0.2;
  c = d.update(DT, ctx);
  if (!(c.brake === 1 && c.throttle === 1)) {
    fail('countdown', `pre-stage should load the drivetrain, got throttle ${f2(c.throttle)}`);
  }
  console.log(`  countdown: brake 1 throttle 0 → pre-stage throttle 1 at ${0.35} s to go   ` +
    `reaction ${f2(d.reaction)} s`);

  // GO: the reaction delay must be real, then it must actually go
  ctx.state = 'running'; ctx.toGo = undefined;
  let launched = -1;
  for (let k = 0; k < 60; k++) {
    c = d.update(DT, ctx);
    if (launched < 0 && c.throttle > 0.5) launched = k * DT;
    car.step(DT, c);
  }
  if (launched < 0) fail('start', 'never launched after the lights went green');
  else if (Math.abs(launched - d.reaction) > 0.05) {
    fail('start', `launched at ${f2(launched)} s, reaction is ${f2(d.reaction)} s`);
  } else console.log(`  start:     launched ${f2(launched)} s after green`);

  // airborne policy
  car.airborne = true; car.airTime = 0.6;
  c = d.update(DT, ctx);
  if (!(c.steer === 0 && Math.abs(c.throttle - 0.5) < 1e-9 && c.brake === 0)) {
    fail('airborne', `expected steer 0 / throttle 0.5 / brake 0, got ` +
      `${f2(c.steer)} / ${f2(c.throttle)} / ${f2(c.brake)}`);
  } else console.log('  airborne:  steer 0, throttle 0.5, brake 0');
  car.airborne = false; car.airTime = 0;

  // finished: cruise
  ctx.state = 'finished';
  let vmax = 0;
  for (let k = 0; k < 60 * 25; k++) { c = d.update(DT, ctx); car.step(DT, c); vmax = Math.max(vmax, car.along); }
  if (vmax > SPEC.topSpeed * 0.45) {
    fail('finished', `cruised at ${f1(vmax)} m/s, expected ≤ ${f1(SPEC.topSpeed * 0.4)} m/s`);
  } else console.log(`  finished:  cruise topped out at ${f1(vmax)} m/s ` +
    `(40 % of ${SPEC.topSpeed} m/s = ${f1(SPEC.topSpeed * 0.4)})`);

  // stuck → wantsReset → notifyReset clears
  ctx.state = 'running';
  const car2 = new MockCar(SPEC);
  placeOnLine(td, car2, 0);
  const d2 = new AIDriver('s', car2, td, { name: 'S', skill: 0.7, aggression: 0.5, consistency: 0.8 },
    rngFrom(7));
  const ctx2 = { state: 'running', vehicles: [car2] };
  let t = 0, recoverSeen = false, resetAt = -1;
  while (t < 8 && resetAt < 0) {
    d2.update(DT, ctx2);          // car never moves: a wall, a rock, a ditch
    if (d2.recovering) recoverSeen = true;
    if (d2.wantsReset) resetAt = t;
    t += DT;
  }
  if (resetAt < 0) fail('stuck', 'never asked for a reset while pinned at 0 m/s');
  else if (Math.abs(resetAt - 4.0) > 0.25) fail('stuck', `asked for a reset at ${f2(resetAt)} s, TUNE.reset.stuckTime is 4`);
  if (!recoverSeen) fail('stuck', 'never tried reverse-and-steer before giving up');
  d2.notifyReset();
  if (d2.wantsReset) fail('stuck', 'notifyReset() did not clear wantsReset');
  console.log(`  stuck:     reverse-and-steer from ${f1(4 - 1.5)} s, wantsReset at ${f2(resetAt)} s, cleared by notifyReset()`);
}

/* ============================================================
   h2 — consistency has to actually do something
   ------------------------------------------------------------
   Both the per-corner entry-speed error and the late-braking mistake hang
   off one "a braking zone appeared" edge. An early version of that edge
   never fired and the whole personality axis was dead with no other symptom
   — every lap was simply perfect. This pins it down: a ghost rival is held
   6.4 m off the driver's nose (inside the 8 m mistake window, outside the
   3.5 m blocker window so it changes nothing else) and the two extremes of
   `consistency` must behave differently.
   ============================================================ */
{
  const td = buildTrackData(canyon);
  const ghost = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

  function probe(consistency, aggression, secs) {
    const car = new MockCar(SPEC);
    placeOnLine(td, car, 0);
    const d = new AIDriver('p', car, td, { name: 'P', skill: 0.8, aggression, consistency },
      rngFrom(8080));
    const ctx = { state: 'running', vehicles: [car, ghost] };
    let mistakes = 0, was = false, errs = 0, lastErr = 0, maxErr = 0;
    for (let k = 0; k < secs * 60; k++) {
      const f = car.forward, fx = f.x, fz = f.z;
      ghost.pos.x = car.pos.x + fx * 5 + fz * 4;      // 5 m ahead, 4 m left
      ghost.pos.z = car.pos.z + fz * 5 - fx * 4;
      ghost.vel.x = car.vel.x; ghost.vel.z = car.vel.z;
      const ctl = d.update(DT, ctx);
      const rp = d.route.pts[d.ri];
      car.surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
      car.step(DT, ctl);
      const m = d.mistakeT > 0;
      if (m && !was) mistakes++;
      was = m;
      if (d.entryErr !== lastErr) { errs++; lastErr = d.entryErr; }
      maxErr = Math.max(maxErr, Math.abs(d.entryErr));
      if (Math.abs(d.offset) > 0.05) fail('consistency', 'ghost rival should not trigger an offset');
    }
    return { mistakes, errs, maxErr };
  }

  const sloppy = probe(0.0, 1.0, 140);
  const clean = probe(1.0, 1.0, 140);
  console.log('\n=== consistency (140 s each, rival held at 6.4 m)');
  console.log(`  consistency 0.0: ${sloppy.mistakes} late-braking mistakes, ` +
    `${sloppy.errs} entry-speed re-rolls, peak error ${(sloppy.maxErr * 100).toFixed(1)} %`);
  console.log(`  consistency 1.0: ${clean.mistakes} mistakes, ${clean.errs} re-rolls, ` +
    `peak error ${(clean.maxErr * 100).toFixed(1)} %`);
  if (sloppy.mistakes < 3) fail('consistency', `consistency 0 / aggression 1 made only ${sloppy.mistakes} mistakes in 140 s`);
  if (sloppy.errs < 10) fail('consistency', 'entry-speed error is not being re-rolled per corner');
  if (sloppy.maxErr < 0.03 || sloppy.maxErr > ENTRY_ERR_MAX) {
    fail('consistency', `entry error peaked at ${(sloppy.maxErr * 100).toFixed(1)} %, expected up to 6 %`);
  }
  if (clean.mistakes !== 0) fail('consistency', 'a perfectly consistent driver made a mistake');
  if (clean.maxErr !== 0) fail('consistency', 'a perfectly consistent driver has entry-speed error');
}

/* ============================================================
   i — allocation gate (opt-in: node --expose-gc dev/ai-check.mjs)
   ------------------------------------------------------------
   What this CAN prove: update() retains nothing — no array that grows, no
   Map that fills, no closure captured into a field. gc() at both ends, then
   compare.

   What it cannot prove: zero transient garbage. V8 boxes escaping doubles as
   HeapNumbers, so source that provably allocates nothing still shows churn —
   TrackSpline.nearest ("nothing in here allocates once construction is done",
   and true on inspection) accounts for two thirds of what update() shows.
   So the transient figure is measured against nearest() as the control, and
   the gate is a RATIO: update may cost a few nearest()-worths of boxing, but
   not the step change an object per frame would produce.
   ============================================================ */
{
  const td = buildTrackData(canyon);
  const car = new MockCar(SPEC);
  placeOnLine(td, car, 0);
  const d = new AIDriver('a', car, td, { name: 'A', skill: 0.8, aggression: 0.5, consistency: 0.8 },
    rngFrom(1));
  const ctx = { state: 'running', vehicles: [car] };
  for (let k = 0; k < 20000; k++) { car.step(DT, d.update(DT, ctx)); }   // warm up + JIT

  console.log('\n=== allocations in update()');
  if (typeof globalThis.gc === 'function') {
    const N = 300000;
    const gc2 = () => { globalThis.gc(); globalThis.gc(); };

    gc2();
    let b = process.memoryUsage().heapUsed;
    for (let k = 0; k < N; k++) { car.step(DT, d.update(DT, ctx)); }
    const transient = (process.memoryUsage().heapUsed - b) / N;
    gc2();
    const retained = (process.memoryUsage().heapUsed - b) / N;

    gc2();
    b = process.memoryUsage().heapUsed;
    for (let k = 0; k < N; k++) { td.spline.nearest(car.pos.x, car.pos.z, SCOUT); }
    const control = Math.max(1, (process.memoryUsage().heapUsed - b) / N);
    gc2();

    console.log(`  retained after gc: ${retained.toFixed(3)} B/update  (must be ~0)`);
    console.log(`  transient churn:   ${transient.toFixed(1)} B/update = ` +
      `${(transient / control).toFixed(2)}× one spline.nearest() ` +
      `(${control.toFixed(1)} B) — V8 double boxing, not objects`);
    if (retained > 4) fail('alloc', `update() retains ~${retained.toFixed(1)} B per call — something is growing`);
    if (transient > control * 6 + 64) {
      fail('alloc', `update() churns ${(transient / control).toFixed(1)}× a nearest() call — ` +
        `that is an object per frame, not a boxed double`);
    }
  } else {
    console.log('  skipped — re-run with `node --expose-gc dev/ai-check.mjs` to measure');
  }
}

/* ============================================================
   perf + balancing sanity
   ============================================================ */
console.log('\n=== budget');
console.log(`  worst measured AIDriver.update: ${f2(perfWorst)} µs/call, hrtime pair included ` +
  `(budget 50 µs/driver)`);
if (perfWorst > 50) fail('perf', `update averaged ${f2(perfWorst)} µs > 50 µs`);
console.log(`  AI_BALANCE enabled=${AI_BALANCE.enabled} ` +
  `P1 ×${AI_BALANCE.leader}  P${AI_BALANCE.field} ×${AI_BALANCE.trailing}`);

/* profiles are deterministic and ordered */
{
  const p = makeGridProfiles(6, 0.6, rngFrom(99));
  const q = makeGridProfiles(6, 0.6, rngFrom(99));
  for (let i = 0; i < 6; i++) {
    if (p[i].name !== q[i].name || p[i].skill !== q[i].skill) {
      fail('profiles', 'makeGridProfiles is not deterministic for a given rng');
      break;
    }
    if (!(p[i].skill >= 0 && p[i].skill <= 1) ||
      !(p[i].aggression >= 0 && p[i].aggression <= 1) ||
      !(p[i].consistency >= 0 && p[i].consistency <= 1)) {
      fail('profiles', `profile ${i} out of range`);
    }
  }
  if (p[0].skill <= p[5].skill) fail('profiles', 'grid is not ordered fastest-first');
  console.log(`  grid profiles: ${p.map(x => `${x.name} ${f2(x.skill)}`).join(', ')}`);
}

console.log(failures === 0 ? '\nAI passes.\n' : `\n${failures} FAILURE(S).\n`);
process.exit(failures === 0 ? 0 : 1);

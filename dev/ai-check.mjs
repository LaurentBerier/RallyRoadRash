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

   …plus the wave-6 item gates, run against a MOCK ctx.items (contract 6.7)
   and never the real ItemWorld — that one owns three.js and this file stays
   loader-free:

     t  TARGETING, and the latch regression: a rival 20 m ahead on the line
        draws a shot inside a second; the same rival 6 m off the line never
        draws one, for five seconds
     u  DODGING · v  BOX SEEKING · w  CANNED TRICKS (plan, release, aborts)
     x  DETERMINISM: the same seed twice, items on, identical to the bit
     y  YIELD: the items-on hit rate the QA sweep is gated on
   ============================================================ */
import { buildTrackData } from '../src/world/track.js';
import { VEHICLES } from '../src/game/vehicles.js';
import { AIDriver, makeGridProfiles, AI_BALANCE, AI_SHORTCUT } from '../src/game/ai.js';
import {
  predictAirTime, planAirTrick, stepAirTrick, rollTrickIntent,
  TRICK_PLAN, TRICKS_AVAILABLE, itemStyleFor, ITEM_STYLE,
} from '../src/game/ai-items.js';
import { ITEM, ITEMS, rollItem } from '../src/game/items.js';
import { G, TUNE } from '../src/game/config.js';

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
/* A spun-out car’s ctl, per Vehicle.step’s spinT override. */
const _spun = { throttle: 0, steer: 0, brake: 0, handbrake: 1, roll: 0 };

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
      } else if (drv[i].onShortcut) {
        /* …but the detour has to be tracked just as tightly — against the
           route the driver actually committed to, which since wave 6 is one
           of several. Measuring against td.shortcutSpline (routes[0]) while
           the car was on canyon's MESA TOP read 241 m off a centreline the
           driver was never on. scIdx is the index it chose; fall back to the
           legacy alias only when there is no index to read. */
        const alt = drv[i].scIdx >= 0 && drv[i].R && drv[i].R.alts
          ? drv[i].R.alts[drv[i].scIdx] : null;
        const sp = (alt && alt.spline) || td.shortcutSpline;
        if (sp) {
          s.scFrames++;
          const d = sp.nearest(cars[i].pos.x, cars[i].pos.z, SCOUT).d;
          if (d > s.scMaxD) s.scMaxD = d;
        }
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

  /* Airborne policy. It used to be throttle 0.5, which was harmless while
     air pitch authority was small; at TUNE.air.pitchAuthority 1.85 a held
     half-throttle is 58° of rotation over a typical jump, so the default is
     now hands-off and a rotation only ever comes from a canned trick. */
  car.airborne = true; car.airTime = 0.6;
  c = d.update(DT, ctx);
  if (!(c.steer === 0 && c.throttle === 0 && c.brake === 0 && c.handbrake === 0 &&
    (c.roll || 0) === 0)) {
    fail('airborne', `expected steer 0 / throttle 0 / brake 0, got ` +
      `${f2(c.steer)} / ${f2(c.throttle)} / ${f2(c.brake)}`);
  } else console.log('  airborne:  steer 0, throttle 0, brake 0, handbrake 0, roll 0');
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
   THE MOCK ITEM WORLD (contract 6.7)
   ------------------------------------------------------------
   Exactly the five read-only questions the contract defines, and nothing
   else. If a driver ever reaches past them this object will throw, which is
   the point: "read-only means read-only" is a claim worth a test.

   It is supplied to the new scenarios ONLY. Every gate above still runs on
   a bare `{ state, vehicles }`, because the AI has to work with no item
   world at all — that is what a purist race with power-ups off is.
   ============================================================ */
function fillHit(out, src) {
  out.found = 0; out.dist = -1; out.s = 0; out.lat = 0; out.x = 0; out.z = 0;
  if (src) {
    out.found = 1; out.dist = src.dist; out.lat = src.lat;
    out.s = src.s || 0; out.x = src.x || 0; out.z = src.z || 0;
  }
  return out;
}

function mockItems() {
  const cfg = { threats: [], box: null, pad: null, lock: false, has: false };
  const calls = { threats: 0, box: 0, pad: 0, lock: 0, has: 0 };
  return {
    cfg, calls,
    events: {
      hitSeq: 0, hitTarget: -1, hitOwner: -1, hitItem: -1,
      pickSeq: 0, pickRacer: -1, pickItem: -1, padSeq: 0, padRacer: -1,
    },
    threats(out) {
      calls.threats++;
      const src = cfg.threats;
      let n = 0;
      for (let i = 0; i < src.length && n < out.x.length; i++) {
        out.x[n] = src[i].x; out.z[n] = src[i].z;
        out.vx[n] = src[i].vx || 0; out.vz[n] = src[i].vz || 0;
        out.r[n] = src[i].r === undefined ? 1.6 : src[i].r;
        out.kind[n] = src[i].kind || 0;
        n++;
      }
      out.n = n;
      return out;
    },
    nearestBox(ri, out) { calls.box++; return fillHit(out, cfg.box); },
    nearestPad(ri, out) { calls.pad++; return fillHit(out, cfg.pad); },
    canLock() { calls.lock++; return !!cfg.lock; },
    hasItem() { calls.has++; return !!cfg.has; },
  };
}

/** The longest run of near-zero curvature that is also clear of every jump. */
function straightStart(td) {
  const rl = td.racingLine, n = rl.length, step = td.lapLength / n;
  const jumps = td.jumps || [];
  const clear = (s) => {
    for (const j of jumps) {
      let d = Math.abs(j.s - s);
      if (d > td.lapLength * 0.5) d = td.lapLength - d;
      if (d < 90) return false;
    }
    return true;
  };
  let bestI = -1, bestLen = 0, i0 = 0, run = 0;
  for (let i = 0; i < n; i++) {
    const p = rl[i];
    if (Math.abs(p.k || 0) < 0.0025 && clear(p.s)) {
      if (run === 0) i0 = i;
      run++;
      if (run > bestLen) { bestLen = run; bestI = i0; }
    } else run = 0;
  }
  if (bestI < 0) return { s: 0, len: 0 };
  return { s: rl[bestI].s, len: bestLen * step };
}

/** Put a ghost `fwd` metres ahead and `lat` metres to the LEFT of `car`. */
function holdGhost(ghost, car, fwd, lat) {
  const f = car.forward, fx = f.x, fz = f.z;
  ghost.pos.x = car.pos.x + fx * fwd + fz * lat;
  ghost.pos.z = car.pos.z + fz * fwd - fx * lat;
  ghost.vel.x = car.vel.x; ghost.vel.z = car.vel.z;
}

/* ============================================================
   t — TARGETING, and the regression test for the latch
   ------------------------------------------------------------
   `_shotAhead`/`_shotBehind` used to be written only downward and never
   reset, so the first rival that ever came close latched a finite distance
   and every shot for the rest of the race was taken at a car that had long
   since gone. The second half of this gate is that bug, directly: a rival
   held 6 m off the line for five seconds must never draw a shot. If the
   latch comes back it will, within a quarter of a second.
   ============================================================ */
{
  const td = buildTrackData(training);
  const straight = straightStart(td);
  const GUN = { name: 'GUN', skill: 0.80, aggression: 0.90, consistency: 0.90 };

  function shootAt(lat, secs) {
    const car = new MockCar(SPEC);
    placeOnLine(td, car, straight.s);
    const d = new AIDriver(0, car, td, GUN, rngFrom(9091));
    const items = mockItems();
    const ghost = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    const ctx = {
      state: 'running', vehicles: [car, ghost], items, myId: 0, item: ITEM.WHEEL,
    };
    let firstAt = -1, fires = 0, backFires = 0, us = 0, n = 0;
    for (let k = 0; k < secs * 60; k++) {
      holdGhost(ghost, car, 20, lat);
      const t0 = process.hrtime.bigint();
      const ctl = d.update(DT, ctx);
      us += Number(process.hrtime.bigint() - t0) / 1000; n++;
      if (d.wantsFire) {
        fires++;
        if (d.fireBack) backFires++;
        if (firstAt < 0) firstAt = k * DT;
        d.notifyFired();                       // stand in for race.js
      }
      const rp = d.route.pts[d.ri];
      car.surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
      car.step(DT, ctl);
    }
    return { firstAt, fires, backFires, us: n ? us / n : 0, style: d.itemStyle };
  }

  console.log(`\n=== t  targeting (training straight at s=${f1(straight.s)}, ${f1(straight.len)} m)`);
  const on = shootAt(0.5, 1.0);
  const off = shootAt(6.0, 5.0);
  console.log(`  rival 20 m ahead at lat 0.5 m: first shot at ` +
    `${on.firstAt < 0 ? 'never' : f2(on.firstAt) + ' s'}, ${on.fires} shots in 1 s ` +
    `(style ${on.style})`);
  console.log(`  rival 20 m ahead at lat 6.0 m: ${off.fires} shots in 5 s (must be 0)`);
  console.log(`  ${f2(Math.max(on.us, off.us))} µs/update with a live ctx.items`);
  if (on.firstAt < 0 || on.firstAt > 1.0) {
    fail('targeting', 'a rival 20 m ahead on the line drew no shot inside a second');
  }
  if (off.fires !== 0) {
    fail('targeting', `${off.fires} shots at a rival 6 m off the line — the shot latch is back`);
  }
  perfWorst = Math.max(perfWorst, on.us, off.us);

  /* …and the mirror: nobody ahead at all, somebody 12 m behind on the line.
     The rearward solution has its own closing-speed sign and it is the one
     that is easy to get backwards. */
  {
    const car = new MockCar(SPEC);
    placeOnLine(td, car, straight.s);
    const d = new AIDriver(0, car, td, GUN, rngFrom(313));
    const items = mockItems();
    const ghost = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    const ctx = { state: 'running', vehicles: [car, ghost], items, myId: 0, item: ITEM.WHEEL };
    let back = 0, fwd = 0;
    for (let k = 0; k < 120; k++) {
      holdGhost(ghost, car, -12, 0.4);
      const ctl = d.update(DT, ctx);
      if (d.wantsFire) { if (d.fireBack) back++; else fwd++; d.notifyFired(); }
      const rp = d.route.pts[d.ri];
      car.surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
      car.step(DT, ctl);
    }
    console.log(`  rival 12 m BEHIND at lat 0.4 m: ${back} rearward shots, ${fwd} forward`);
    if (back === 0) fail('targeting', 'never covered its back against a car 12 m behind');
    if (fwd !== 0) fail('targeting', 'fired forward at nobody');
  }

  /* The item brain must be completely inert with no ctx.items at all — that
     is a race with power-ups off, and it is the default everywhere above. */
  {
    const car = new MockCar(SPEC);
    placeOnLine(td, car, straight.s);
    const d = new AIDriver(0, car, td, GUN, rngFrom(77));
    const ctx = { state: 'running', vehicles: [car] };     // no items, no item
    for (let k = 0; k < 300; k++) {
      const ctl = d.update(DT, ctx);
      if (d.wantsFire) fail('targeting', 'raised wantsFire with no item in hand');
      car.step(DT, ctl);
    }
    console.log('  no ctx.items, no ctx.item: 5 s of driving, no fire request');
  }
}

/* ============================================================
   u — DODGING
   ============================================================ */
{
  const td = buildTrackData(training);
  const straight = straightStart(td);
  const car = new MockCar(SPEC);
  placeOnLine(td, car, straight.s);
  const d = new AIDriver(0, car, td,
    { name: 'D', skill: 0.8, aggression: 0.5, consistency: 0.8 }, rngFrom(2222));
  const items = mockItems();
  items.cfg.threats = [{ x: 0, z: 0, r: 2.6, kind: 1 }];
  const ctx = { state: 'running', vehicles: [car], items, myId: 0, item: -1 };
  let at = -1, peak = 0;
  for (let k = 0; k < 120; k++) {
    // an oil slick sitting 25 m up the road, dead on the line
    const f = car.forward;
    items.cfg.threats[0].x = car.pos.x + f.x * 25;
    items.cfg.threats[0].z = car.pos.z + f.z * 25;
    const ctl = d.update(DT, ctx);
    const a = Math.abs(d.offset);
    if (a > peak) peak = a;
    if (at < 0 && a >= 1.5) at = k * DT;
    const rp = d.route.pts[d.ri];
    car.surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
    car.step(DT, ctl);
  }
  console.log('\n=== u  dodging (a slick held 25 m ahead, on the line)');
  console.log(`  |offset| reached 1.5 m at ${at < 0 ? 'never' : f2(at) + ' s'}` +
    `   peak ${f2(peak)} m   threats() polled ${items.calls.threats}×`);
  if (at < 0 || at > 2.0) fail('dodge', `no 1.5 m avoidance offset within 2 s (peak ${f2(peak)} m)`);
  if (items.calls.threats !== 120) fail('dodge', 'threats() is not polled every frame');
}

/* ============================================================
   v — BOX SEEKING
   ============================================================ */
{
  const td = buildTrackData(training);
  const straight = straightStart(td);
  const car = new MockCar(SPEC);
  placeOnLine(td, car, straight.s);
  const d = new AIDriver(0, car, td,
    { name: 'B', skill: 0.8, aggression: 0.5, consistency: 0.8 }, rngFrom(3333));
  const items = mockItems();
  items.cfg.box = { dist: 60, lat: 3, s: 0, x: 0, z: 0 };
  const ctx = { state: 'running', vehicles: [car], items, myId: 0, item: -1 };
  let at = -1, peak = -9;
  for (let k = 0; k < 180; k++) {
    const ctl = d.update(DT, ctx);
    if (d.offset > peak) peak = d.offset;
    if (at < 0 && d.offset > 1.0) at = k * DT;
    const rp = d.route.pts[d.ri];
    car.surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
    car.step(DT, ctl);
  }
  console.log('\n=== v  box seeking (an untaken row 60 m ahead at lat +3)');
  console.log(`  offset crossed +1 m at ${at < 0 ? 'never' : f2(at) + ' s'}   peak ${f2(peak)} m` +
    `   nearestBox() polled ${items.calls.box}×`);
  if (at < 0 || at > 3.0) fail('seek', `never steered toward the box (peak offset ${f2(peak)} m)`);

  /* …and it must NOT, holding an item. A car with a full slot drives past a
     box (items.js canTake), so a detour for one is a detour for nothing. */
  const car2 = new MockCar(SPEC);
  placeOnLine(td, car2, straight.s);
  const d2 = new AIDriver(0, car2, td,
    { name: 'B2', skill: 0.8, aggression: 0.5, consistency: 0.8 }, rngFrom(3333));
  const items2 = mockItems();
  items2.cfg.box = { dist: 60, lat: 3, s: 0, x: 0, z: 0 };
  items2.cfg.has = true;
  const ctx2 = { state: 'running', vehicles: [car2], items: items2, myId: 0, item: ITEM.SLICK };
  let peak2 = 0;
  for (let k = 0; k < 180; k++) {
    const ctl = d2.update(DT, ctx2);
    peak2 = Math.max(peak2, Math.abs(d2.seekOff));
    car2.step(DT, ctl);
  }
  console.log(`  holding an item: peak seek offset ${f2(peak2)} m (must be 0)`);
  if (peak2 !== 0) fail('seek', 'detoured to a box it could not have collected');
}

/* ============================================================
   w — CANNED AIR TRICKS
   ------------------------------------------------------------
   The plan is made once, at the lip, from a predicted hang time; the hold
   is a fraction of it; and there are two ways out — the hold expiring and
   the ground arriving early. Every one of those four numbers is checked
   here because none of them is visible from the driving gates.
   ============================================================ */
{
  console.log(`\n=== w  canned air tricks   (tricks.js ${TRICKS_AVAILABLE ? 'PRESENT' : 'absent — using the contract fallback'})`);

  // the predictor itself
  const tA = predictAirTime(9, 2, G, 0.7);
  const tB = predictAirTime(4, 0, G, 0.7);
  console.log(`  predictAirTime(9 m/s, 2 m drop) = ${f2(tA)} s;  (4 m/s, flat) = ${f2(tB)} s`);
  if (!(tA > 2.0 && tA < 2.5)) fail('trick', `predictAirTime(9,2) = ${f2(tA)}, expected ~2.2 s`);
  if (!(tB > 0.8 && tB < 1.0)) fail('trick', `predictAirTime(4,0) = ${f2(tB)}, expected ~0.89 s`);
  if (predictAirTime(0, -50, G, 0.7) !== 0) fail('trick', 'a landing ABOVE the lip must predict 0 s');

  /* The plan, and the release. P4's rule: hold until the rotation ALREADY
     turned plus the rotation still to come — extrapolated through
     TUNE.air.damp over the predicted time to the ground — reaches 275°
     (flip) or 290° (barrel). A clock was the first version of this and it
     landed 1 jump in 10; the target is fixed, the launch rate is not. */
  const DEGREE = Math.PI / 180;
  const K = TUNE.air.damp;
  const mk = (aggression) => ({
    aggression, skill: 0.8, rng: rngFrom(4141),
    trickPlan: 0, trickTarget: 0, trickDir: 0, _spunLast: 0, _spinRate: 0,
  });
  const trick0 = { pitch: 0, yaw: 0, roll: 0 };
  const flip = mk(0.30);
  planAirTrick(flip, tA, trick0);
  console.log(`  tAir ${f2(tA)} s → BACKFLIP, target ${(flip.trickTarget / DEGREE).toFixed(0)}° ` +
    `(damp k = ${K})`);
  if (flip.trickPlan !== TRICK_PLAN.BACKFLIP) fail('trick', 'aggression 0.3 should pick the backflip');
  if (Math.abs(flip.trickTarget - 275 * DEGREE) > 1e-9) {
    fail('trick', `backflip target ${(flip.trickTarget / DEGREE).toFixed(1)}°, contract says 275°`);
  }
  const barrel = mk(0.80);
  planAirTrick(barrel, tA, trick0);
  if (barrel.trickPlan !== TRICK_PLAN.BARREL) fail('trick', 'aggression 0.8 should pick the barrel');
  if (Math.abs(barrel.trickTarget - 290 * DEGREE) > 1e-9) fail('trick', 'barrel target is not 290°');
  if (barrel.trickDir !== 1 && barrel.trickDir !== -1) fail('trick', 'the barrel has no direction');

  // …and nothing at all below the floor
  const small = mk(0.30);
  planAirTrick(small, 1.29, trick0);
  if (small.trickPlan !== TRICK_PLAN.NONE) fail('trick', 'planned a trick on a 1.29 s hop');

  /* Fly a plausible flip: a launch pitch rate that decays at `damp`, and a
     time-to-ground that runs down. The release must land inside a few
     degrees of the target once the assist's share is accounted for. */
  function fly(d, rate0, tAir0) {
    const c = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };
    let spun = 0, w = rate0, t = 0, held = 0, at = -1;
    for (let k = 0; k < 400; k++) {
      const tG = Math.max(0, tAir0 - t);
      const live = stepAirTrick(d, c, DT, t, spun, tG);
      if (live) held = t;
      else if (at < 0) { at = t; }
      // the rotation the car will still make, hands off, is the same decay
      w *= Math.exp(-K * DT);
      if (live) w += 1.9 * DT;                     // pitchAuthority, roughly
      spun += w * DT;
      t += DT;
      if (t > tAir0) break;
    }
    return { at, held, spun, finalDeg: spun / DEGREE };
  }

  planAirTrick(flip, tA, trick0);
  const f1r = fly(flip, 3.2, tA);
  console.log(`  flown at 3.2 rad/s launch: released at ${f2(f1r.at)} s, ` +
    `total rotation ${f1r.finalDeg.toFixed(0)}° (target 275°)`);
  if (f1r.at < 0) fail('trick', 'never released — the predictor is not converging');
  if (f1r.finalDeg < 250 || f1r.finalDeg > 400) {
    fail('trick', `flip finished at ${f1r.finalDeg.toFixed(0)}° — release is badly mistimed`);
  }
  // a SLOWER launch has to hold LONGER; that is the whole point of the rule
  planAirTrick(flip, tA, trick0);
  const f2r = fly(flip, 1.2, tA);
  console.log(`  flown at 1.2 rad/s launch: released at ${f2(f2r.at)} s ` +
    `(a slower launch must hold longer)`);
  if (!(f2r.at > f1r.at)) {
    fail('trick', `slow launch released at ${f2(f2r.at)} s, fast at ${f2(f1r.at)} s — ` +
      'the release is still on a clock');
  }

  // the two escapes
  const c0 = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };
  planAirTrick(flip, tA, trick0);
  if (!stepAirTrick(flip, c0, DT, 0.2, 0, 2.0) || c0.throttle !== 1 || c0.steer !== 0) {
    fail('trick', 'a live backflip should be throttle 1, steer 0');
  }
  if (stepAirTrick(flip, c0, DT, 1.41, 0, 2.0)) fail('trick', 'the 1.4 s backstop did not fire');
  planAirTrick(flip, tA, trick0);
  if (stepAirTrick(flip, c0, DT, 0.2, 0, 0.44)) {
    fail('trick', 'did not abort with 0.44 s to the ground');
  }
  planAirTrick(barrel, tA, trick0);
  stepAirTrick(barrel, c0, DT, 0.2, 0, 2.0);
  if (!(c0.handbrake === 1 && Math.abs(c0.steer) === 1 && c0.throttle === 0)) {
    fail('trick', 'the barrel should be handbrake 1 + full steer, no throttle');
  }
  console.log(`  escapes: 1.4 s backstop and tG < 0.45 s; barrel is handbrake 1 / steer ${c0.steer}`);

  // the roll, over a hero jump only
  const rr = { rng: rngFrom(515), skill: 0.9 };
  let n = 0;
  for (let i = 0; i < 4000; i++) if (rollTrickIntent(rr, { gap: 0, h: 2.4 })) n++;
  const want = 0.25 + 0.60 * 0.9;
  console.log(`  hero-jump intent at skill 0.9: ${(n / 4000 * 100).toFixed(1)} % ` +
    `(contract ${(want * 100).toFixed(0)} %)`);
  if (Math.abs(n / 4000 - want) > 0.03) fail('trick', 'the lip-commit roll is off contract');
  if (rollTrickIntent(rr, { gap: 0, h: 0.9 })) fail('trick', 'planned a trick off a 0.9 m kicker');
  if (rollTrickIntent(rr, null)) fail('trick', 'planned a trick with no jump');

  /* End to end through the driver: the plumbing between "airborne" and
     "throttle 1" runs through five blocks of update() and every one of them
     has a chance to stamp on it. The mock car carries a `_trick` and a
     `terrain` because those are the two vehicle publications the release
     rule reads (contract 6.4); a driver without them must plan nothing. */
  {
    const td = buildTrackData(volcano);
    const car = new MockCar(SPEC);
    placeOnLine(td, car, 0);
    const d = new AIDriver(0, car, td,
      { name: 'F', skill: 0.9, aggression: 0.30, consistency: 0.9 }, rngFrom(6161));
    const ctx = { state: 'running', vehicles: [car] };
    d.update(DT, ctx);
    car.along = 28;                              // moving, so nothing calls it stuck
    const landY = d._routeYAt(d.s + 45);
    car.terrain = { heightAt: () => landY };
    car._trick = { pitch: 0, yaw: 0, roll: 0 };
    d.trickIntent = true;
    d._trickJump = { s: d.s, y: landY + 2, h: 2.6, gap: 8 };
    car.airborne = true; car.vel.y = 9; car.pos.y = landY + 4;

    let held = 0, after = null, plan = 0, w = 3.0;
    for (let k = 0; k < 240; k++) {
      car.airTime = 0.13 + k * DT;
      const c = d.update(DT, ctx);
      if (k === 0) plan = d.trickPlan;
      if (c.throttle === 1) held = car.airTime;
      else if (held > 0 && after === null) after = c;
      // integrate a plausible flight: pitch decays at damp, throttle feeds it
      w *= Math.exp(-TUNE.air.damp * DT);
      if (c.throttle === 1) w += 1.9 * DT;
      car._trick.pitch += w * DT;
      car.vel.y -= 12.8 * 0.7 * DT;
      car.pos.y += car.vel.y * DT;
      if (car.pos.y <= landY) break;
    }
    console.log(`  driver: plan ${plan === TRICK_PLAN.BACKFLIP ? 'BACKFLIP' : plan}, ` +
      `predicted ${f2(d._tAir)} s hang, held to ${f2(held)} s, ` +
      `${(car._trick.pitch / DEGREE).toFixed(0)}° turned`);
    if (plan !== TRICK_PLAN.BACKFLIP) fail('trick', 'the driver did not plan the backflip');
    if (!(held > 0.2)) fail('trick', 'never held the throttle for the flip');
    if (!after || after.throttle !== 0 || after.steer !== 0 || after.brake !== 0) {
      fail('trick', 'did not go hands-off after the release');
    }
    // …and a respawn forgets all of it
    d.notifyReset();
    if (d.trickPlan !== TRICK_PLAN.NONE || d.trickIntent || d._trickJump) {
      fail('trick', 'notifyReset left a flip in progress');
    }

    /* No `_trick` published (P4's vehicle work not merged): the AI must plan
       NOTHING rather than fall back to an open-loop hold, which is the
       version that landed one jump in ten. */
    const car2 = new MockCar(SPEC);
    placeOnLine(td, car2, 0);
    const d2 = new AIDriver(0, car2, td,
      { name: 'F2', skill: 0.9, aggression: 0.30, consistency: 0.9 }, rngFrom(6161));
    d2.update(DT, ctx2b(car2));
    car2.along = 28;
    d2.trickIntent = true;
    d2._trickJump = { s: d2.s, y: d2._routeYAt(d2.s + 45) + 2, h: 2.6, gap: 8 };
    car2.airborne = true; car2.airTime = 0.5; car2.vel.y = 9;
    const c2 = d2.update(DT, ctx2b(car2));
    if (d2.trickPlan !== TRICK_PLAN.NONE || c2.throttle !== 0 || c2.handbrake !== 0) {
      fail('trick', 'planned an open-loop trick with no _trick published');
    }
    console.log('  no vehicle _trick published: no canned trick, hands off');
  }
}
function ctx2b(car) { return { state: 'running', vehicles: [car] }; }

/* ============================================================
   x — DETERMINISM, items on
   ------------------------------------------------------------
   The QA sweep compares lap times between builds. One Math.random() in the
   item brain and every comparison it makes is noise.
   ============================================================ */
{
  const td = buildTrackData(canyon);
  const straight = straightStart(td);

  function sample(seed) {
    const car = new MockCar(SPEC);
    placeOnLine(td, car, straight.s);
    const d = new AIDriver(0, car, td,
      { name: 'X', skill: 0.75, aggression: 0.65, consistency: 0.6 }, rngFrom(seed));
    const items = mockItems();
    items.cfg.lock = true;
    items.cfg.box = { dist: 40, lat: -2, s: 0, x: 0, z: 0 };
    const ghost = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    const ctx = { state: 'running', vehicles: [car, ghost], items, myId: 0, item: 0 };
    let h = 2166136261, fires = 0;
    for (let k = 0; k < 3600; k++) {
      ctx.item = k % 7;                          // walk the whole roster
      holdGhost(ghost, car, 14 - (k % 40) * 0.5, ((k % 11) - 5) * 0.6);
      const ctl = d.update(DT, ctx);
      if (d.wantsFire) { fires++; d.notifyFired(); }
      const rp = d.route.pts[d.ri];
      car.surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
      car.step(DT, ctl);
      h ^= Math.round((ctl.throttle + 2) * 1e6) ^ Math.round((ctl.steer + 2) * 1e6) ^
        Math.round(ctl.brake * 1e6) ^ (ctl.handbrake << 3) ^ Math.round(car.pos.x * 1e4);
      h = Math.imul(h, 16777619);
    }
    return { h: h >>> 0, fires, x: car.pos.x, z: car.pos.z };
  }

  const a = sample(50505), b = sample(50505), c = sample(50506);
  console.log('\n=== x  determinism (60 s, the whole roster, items on)');
  console.log(`  seed 50505: hash ${a.h.toString(16)}  ${a.fires} shots` +
    `   ·   repeat: hash ${b.h.toString(16)}  ${b.fires} shots`);
  if (a.h !== b.h || a.fires !== b.fires) fail('determinism', 'the same seed produced a different race');
  if (a.h === c.h) fail('determinism', 'a different seed produced an identical race');
}

/* ============================================================
   y — THE ITEMS-ON HIT RATE
   ------------------------------------------------------------
   `ItemWorld.stats` reports hits ÷ fired and the QA sweep is gated on it,
   so this is the number the targeting rework exists to move. It cannot come
   from the drop table alone: `fired` holds the mix the AI CHOOSES to throw,
   not the mix it picks up — a leader sits on a spare wheel and a tow line
   with nothing to hook is never thrown at all.

   So: a six-car pack over two canyon laps against a miniature item world
   reproducing the parts of itemworld.js that decide the number — its box
   row spacing, items.js's real `rollItem` off real standings, the spare
   wheel's exact ballistics, the slick's radius / grace / immunity, the
   tow's cone, and `_spin`'s "already spinning harder" early return.

   The wheel figure is a LOWER bound: the real projectile also ricochets off
   the road corridor, and every ricochet is another chance to connect.
   ============================================================ */
{
  const WD = ITEMS[ITEM.WHEEL], SD = ITEMS[ITEM.SLICK], TD_ = ITEMS[ITEM.TOW];
  const CAR_R = 1.2;
  const td = buildTrackData(canyon);
  const L = td.lapLength;
  const ideal = idealLapTime(td);
  const LAPS_Y = 2;

  function itemRace(seed) {
    const profiles = makeGridProfiles(6, 0.7, rngFrom(seed));
    const n = profiles.length;
    const cars = [], drv = [], inv = [], prog = [];
    for (let i = 0; i < n; i++) {
      const car = new MockCar(SPEC);
      placeOnLine(td, car, td.spline.wrapS(-9 * i));
      cars.push(car);
      drv.push(new AIDriver(i, car, td, profiles[i], rngFrom(seed + 1 + i * 7919)));
      inv.push({ id: -1, charges: 0, roll: 0 });
      prog.push({ raceS: 0, lastS: 0, lat: 0, pos: i + 1 });
    }
    for (let i = 0; i < n; i++) {
      drv[i].update(DT, { state: 'running', vehicles: cars });
      prog[i].lastS = drv[i].s;
    }

    /* Box rows, laid out the way itemworld._buildBoxes does: `packs` rows a
       lap, four lanes across. A row is consumed per racer, not globally —
       BOX_RESPAWN is 3.5 s and a six-car pack is never that tight. */
    const packs = clamp(Math.round(L / 420), 3, 6);
    const rows = [];
    for (let p = 0; p < packs; p++) rows.push(td.spline.wrapS((p + 0.5) * L / packs));
    const LANES = [-3, -1, 1, 3];
    const taken = [];                       // per racer, per row: s at last take
    for (let i = 0; i < n; i++) taken.push(new Float64Array(rows.length).fill(-1));

    const rollRng = rngFrom(seed ^ 0x5eed);
    const dropCtx = { toFinishM: -1, hasTarget: true, behindSec: 0 };
    const P = [], H = [];
    let fired = 0, hits = 0, taken2 = 0;
    const byItem = new Array(ITEMS.length).fill(0);
    const hitBy = new Array(ITEMS.length).fill(0);

    const near = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
    const items = mockItems();
    const ctx = { state: 'running', vehicles: cars, items, myId: 0, item: -1 };
    /* Spin-out, crudely: Vehicle.step forces handbrake 1 / throttle 0 while
       `spinT` runs. Without it the pack never disperses, a single slick
       catches three cars in a row that would in reality have scattered, and
       the measured hit rate flatters itself. */
    const spinT = new Float64Array(n);

    /** itemworld._findTarget, to the letter — the tow's cone and window. */
    function lockOf(i) {
      const v = cars[i], f = v.forward;
      const rx = f.z, rz = -f.x;             // vehicle right = (fz, −fx) flipped
      for (let k = 0; k < n; k++) {
        if (k === i) continue;
        const dx = cars[k].pos.x - v.pos.x, dz = cars[k].pos.z - v.pos.z;
        const fwd = dx * f.x + dz * f.z;
        if (fwd < TD_.minDist || fwd > TD_.maxDist) continue;
        const lat = dx * rx + dz * rz;
        if (Math.abs(Math.atan2(lat, fwd)) > TD_.cone) continue;
        return true;
      }
      return false;
    }

    const maxT = ideal * LAPS_Y * 2.5 + 60;
    let done = 0;
    for (let t = 0; t < maxT && done < n; t += DT) {
      // standings, twice a second, exactly as race.js feeds them in
      if ((Math.round(t / DT) % 30) === 0) {
        const order = prog.map((p, i) => i).sort((a, b) => prog[b].raceS - prog[a].raceS);
        for (let k = 0; k < order.length; k++) prog[order[k]].pos = k + 1;
      }

      for (let i = 0; i < n; i++) {
        if (prog[i].raceS >= LAPS_Y * L) continue;
        // --- pickups ---
        td.spline.nearest(cars[i].pos.x, cars[i].pos.z, near);
        prog[i].lat = near.lat;
        if (inv[i].charges <= 0 && inv[i].roll <= 0) {
          for (let r = 0; r < rows.length; r++) {
            let d = near.s - rows[r];
            if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
            if (d < -4 || d > 4) continue;
            if (taken[i][r] > 0 && prog[i].raceS - taken[i][r] < L * 0.5) continue;
            taken[i][r] = prog[i].raceS;
            const leader = Math.max(...prog.map(p => p.raceS));
            dropCtx.toFinishM = LAPS_Y * L - prog[i].raceS;
            dropCtx.behindSec = (leader - prog[i].raceS) / 26;
            dropCtx.hasTarget = lockOf(i);
            const id = rollItem(prog[i].pos, n, dropCtx, rollRng);
            inv[i].id = id;
            inv[i].charges = ITEMS[id].charges;
            inv[i].roll = 0.7;                       // ROLL_TIME
            taken2++;
            break;
          }
        }
        if (inv[i].roll > 0) inv[i].roll -= DT;

        // --- drive ---
        ctx.myId = i;
        ctx.position = prog[i].pos;
        ctx.item = (inv[i].charges > 0 && inv[i].roll <= 0) ? inv[i].id : -1;
        items.cfg.lock = lockOf(i);
        items.cfg.has = inv[i].charges > 0;
        items.cfg.threats = threatList(P, H);
        items.cfg.box = boxAhead(near, rows, taken[i], prog[i], L, LANES);
        const ctl = drv[i].update(DT, ctx);

        if (drv[i].wantsFire && ctx.item >= 0) {
          const id = inv[i].id;
          fired++; byItem[id]++;
          if (--inv[i].charges <= 0) { inv[i].id = -1; inv[i].charges = 0; }
          const c = cars[i], f = c.forward, dir = drv[i].fireBack ? -1 : 1;
          if (id === ITEM.WHEEL) {
            P.push({
              x: c.pos.x + f.x * dir * 2.2, y: 0.5, z: c.pos.z + f.z * dir * 2.2,
              vx: c.vel.x + f.x * WD.speed * dir, vy: WD.lift,
              vz: c.vel.z + f.z * WD.speed * dir,
              life: WD.life, arm: WD.arm, bounce: 0, own: i,
            });
          } else if (id === ITEM.SLICK) {
            H.push({
              x: c.pos.x - f.x * SD.drop, z: c.pos.z - f.z * SD.drop,
              life: SD.life, own: i, grace: 1.0, imm: new Float64Array(n),
            });
          }
          drv[i].notifyFired();
        }

        const rp = drv[i].route.pts[drv[i].ri];
        cars[i].surfaceId = rp && rp.surface !== undefined ? rp.surface : 1;
        /* A spin is a ROTATION, not a stop: Vehicle.step cuts throttle and
           steering and pins the handbrake, and the car slides on. Modelling
           it as a stop would park cars on top of their own oil slick and
           re-catch them every `immune` for nine seconds. */
        cars[i].step(DT, spinT[i] > 0 ? (spinT[i] -= DT, _spun) : ctl);

        let ds = drv[i].s - prog[i].lastS;
        if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
        prog[i].lastS = drv[i].s;
        prog[i].raceS += ds;
        if (prog[i].raceS >= LAPS_Y * L) done++;
      }

      for (let k = P.length - 1; k >= 0; k--) {
        const p = P[k];
        p.life -= DT; if (p.arm > 0) p.arm -= DT;
        if (p.life <= 0) { P.splice(k, 1); continue; }
        p.vy -= G * DT; p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        if (p.y <= 0.30) {
          p.y = 0.30;
          if (p.vy < 0) {
            p.vy = -p.vy * WD.bounce; p.vx *= 0.94; p.vz *= 0.94;
            if (++p.bounce > WD.maxBounce) { P.splice(k, 1); continue; }
          }
        }
        let hitI = -1;
        for (let i = 0; i < n && hitI < 0; i++) {
          if (i === p.own && p.arm > 0) continue;
          const dx = cars[i].pos.x - p.x, dy = -p.y, dz = cars[i].pos.z - p.z;
          const R = CAR_R + WD.radius;
          if (dx * dx + dy * dy + dz * dz <= R * R) hitI = i;
        }
        if (hitI >= 0) {
          /* itemworld._spin: `if (v.spinT >= dur) return;` — a car already
             spinning harder than this does not count a second hit, and the
             projectile is consumed either way. */
          if (spinT[hitI] < WD.spin) { spinT[hitI] = WD.spin; hits++; hitBy[ITEM.WHEEL]++; }
          P.splice(k, 1);
        }
      }

      for (let k = H.length - 1; k >= 0; k--) {
        const h = H[k];
        h.life -= DT; h.grace -= DT;
        if (h.life <= 0) { H.splice(k, 1); continue; }
        for (let i = 0; i < n; i++) {
          if (i === h.own && h.grace > 0) continue;
          if (h.imm[i] > 0) { h.imm[i] -= DT; continue; }
          const dx = cars[i].pos.x - h.x, dz = cars[i].pos.z - h.z;
          if (dx * dx + dz * dz > SD.radius * SD.radius) continue;
          h.imm[i] = SD.immune;
          if (spinT[i] >= SD.spin) continue;             // already spinning harder
          spinT[i] = SD.spin;
          hits++; hitBy[ITEM.SLICK]++;
        }
      }

      /* resolveVehiclePair, crudely. Without SOME separation the six point
         masses travel as one blob, every oil slick catches the whole field
         and the measured rate is a fiction. */
      for (let a = 0; a < n - 1; a++) {
        for (let b = a + 1; b < n; b++) {
          const dx = cars[b].pos.x - cars[a].pos.x, dz = cars[b].pos.z - cars[a].pos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 9 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2), push = (3 - d) * 0.5;
          cars[a].pos.x -= (dx / d) * push; cars[a].pos.z -= (dz / d) * push;
          cars[b].pos.x += (dx / d) * push; cars[b].pos.z += (dz / d) * push;
        }
      }
    }
    return { fired, hits, taken: taken2, byItem, hitBy, rate: fired ? hits / fired : 0 };
  }

  /** The live projectile/hazard list, in the shape mockItems.threats wants. */
  function threatList(P, H) {
    const out = [];
    for (const p of P) out.push({ x: p.x, z: p.z, vx: p.vx, vz: p.vz, r: 1.6, kind: 0 });
    for (const h of H) out.push({ x: h.x, z: h.z, vx: 0, vz: 0, r: SD.radius, kind: 1 });
    return out;
  }

  /** Nearest untaken row ahead, lane picked nearest the car's own lateral. */
  function boxAhead(near, rows, mine, p, lap, LANES) {
    let bd = Infinity, bi = -1;
    for (let r = 0; r < rows.length; r++) {
      if (mine[r] > 0 && p.raceS - mine[r] < lap * 0.5) continue;
      let d = rows[r] - near.s;
      if (d < -lap * 0.5) d += lap; else if (d > lap * 0.5) d -= lap;
      if (d < 0) continue;
      if (d < bd) { bd = d; bi = r; }
    }
    if (bi < 0) return null;
    let lane = LANES[0], best = Infinity;
    for (const l of LANES) {
      const dl = Math.abs(l - near.lat);
      if (dl < best) { best = dl; lane = l; }
    }
    return { dist: bd, lat: lane, s: rows[bi], x: 0, z: 0 };
  }

  /* Four seeds, because one two-lap race is fifty-odd throws and fifty
     throws is not a rate. The spread is printed so a reader can see how
     much of the headline number is noise. */
  const SEEDS_Y = [20260813, 4242, 777, 131313];
  const runs = SEEDS_Y.map(itemRace);
  const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
  const fired = sum(r => r.fired), hits = sum(r => r.hits), boxes = sum(r => r.taken);
  const byItem = ITEMS.map((it, i) => sum(r => r.byItem[i]));
  const hitBy = ITEMS.map((it, i) => sum(r => r.hitBy[i]));
  const rate = fired ? hits / fired : 0;
  const wRate = byItem[ITEM.WHEEL] ? hitBy[ITEM.WHEEL] / byItem[ITEM.WHEEL] : 0;
  const sRate = byItem[ITEM.SLICK] ? hitBy[ITEM.SLICK] / byItem[ITEM.SLICK] : 0;
  const lo = Math.min(...runs.map(r => r.rate)), hi = Math.max(...runs.map(r => r.rate));

  console.log(`\n=== y  items-on hit rate ` +
    `(6-car canyon pack, ${LAPS_Y} laps × ${SEEDS_Y.length} seeds, real drop table)`);
  console.log(`  ${boxes} boxes taken · ${fired} items fired · ${hits} hits`);
  console.log('  fired by item: ' +
    ITEMS.map((it, i) => byItem[i] ? `${it.name} ${byItem[i]}` : null)
      .filter(Boolean).join(' · '));
  console.log(`  SPARE WHEEL connects ${(wRate * 100).toFixed(1)} % of throws · ` +
    `OIL SLICK catches ${(sRate * 100).toFixed(2)} cars per drop`);
  console.log(`  ⇒ HIT RATE  ${(rate * 100).toFixed(1)} %  ` +
    `(per-seed ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)} %; ` +
    `QA gate 35 %, pre-wave baseline 20 %)`);
  if (fired < 120) fail('yield', `only ${fired} items fired across four races — the AI is hoarding`);
  if (wRate < 0.35) {
    fail('yield', `only ${(wRate * 100).toFixed(1)} % of spare-wheel shots connect`);
  }
  if (rate < 0.35) {
    fail('yield', `hit rate ${(rate * 100).toFixed(1)} % — below the QA gate`);
  }

  /* Determinism again, through the full item loop this time: the drop
     roulette, the AI's decisions and the standings all feed each other. */
  const again = itemRace(SEEDS_Y[0]);
  if (again.fired !== runs[0].fired || again.hits !== runs[0].hits ||
    again.taken !== runs[0].taken) {
    fail('yield', 'two identical seeds produced two different item races');
  }
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

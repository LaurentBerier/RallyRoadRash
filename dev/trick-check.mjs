/* ============================================================
   RALLY ROAD RASH — air control and tricks
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/trick-check.mjs

   Two halves, deliberately separate — the same split boost-check uses, and
   for the same reason.

     A. THE CLASSIFIER ON ITS OWN, driven by scripted quaternion sequences.
        "Does 360° about the body's up axis read as a 360" is arithmetic, and
        testing it by arranging for a real car to spin on cue tests the wrong
        thing and fails for the wrong reasons.

     B. THE AIR MODEL ON A REAL VEHICLE, over a copy of vehicle-check's
        kicker mock. The gates here are the design, in order of how much they
        matter: a player who touches NOTHING lands on their wheels at every
        speed the tracks can produce; a player who commits gets the trick; a
        player who never lets go crashes. If the first one ever fails, the
        rest is decoration — a jump would be a hazard again.

   THE ONE THAT WILL CATCH A REGRESSION FIRST is B1. The whole wave-6 air
   rewrite doubled the rotation authorities, and the only reason that is safe
   is the predictive landing assist. B1 is that assist's contract.
   ============================================================ */
import * as THREE from 'three';
import { Vehicle } from '../src/game/vehicle.js';
import { VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { TUNE } from '../src/game/config.js';
import { SURF } from '../src/world/surfaces.js';
import { makeRNG } from '../src/core/rng.js';
import {
  TRICK, TRICK_NAME, makeTrick, trickReset, trickClear, trickStep, trickLabel,
  predictAirTime,
} from '../src/game/tricks.js';

const T = TUNE.trick;
const DT = 1 / 60;
const DEG = Math.PI / 180;

let failures = 0, checks = 0;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

/* ============================================================
   A — THE CLASSIFIER
   ------------------------------------------------------------
   No three, no Vehicle: a plain object with a `quat` and the three fields
   trickStep reads. The quaternion is driven by hand so every flight below is
   an exact number of degrees about an exact body axis.
   ============================================================ */

/** A vehicle-shaped object with only the four fields trickStep reads. */
const fakeV = () => ({
  quat: { x: 0, y: 0, z: 0, w: 1 },
  airborne: false, landEdge: false, landQ: 1,
});
const CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };
const ctl = (t = 0, s = 0, b = 0, h = 0, r = 0) => {
  CTL.throttle = t; CTL.steer = s; CTL.brake = b; CTL.handbrake = h; CTL.roll = r;
  return CTL;
};

/** Rotate v's BODY frame by `ang` about the local axis (ax,ay,az): q ← q·dq. */
function spinBody(v, ax, ay, az, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  const bx = ax * s, by = ay * s, bz = az * s, bw = Math.cos(h);
  const q = v.quat, { x, y, z, w } = q;
  q.x = w * bx + x * bw + y * bz - z * by;
  q.y = w * by - x * bz + y * bw + z * bx;
  q.z = w * bz + x * by - y * bx + z * bw;
  q.w = w * bw - x * bx - y * by - z * bz;
}

/* The three body axes, in the sign convention tricks.js documents.
   Right is −X, so NOSE UP is a rotation about (−1,0,0). */
const AX = {
  backflip: [-1, 0, 0], frontflip: [1, 0, 0],
  spin: [0, 1, 0], barrel: [0, 0, 1],
};

/**
 * Fly one scripted flight and land it.
 * @param moves  [axisName, totalRadians] pairs, applied evenly over the flight
 */
function fly(st, secs, moves, landQ = 1, hopPress = false) {
  const v = fakeV();
  v.quat.x = 0; v.quat.y = 0; v.quat.z = 0; v.quat.w = 1;

  // a beat on the ground first, so the hop window has somewhere to happen
  trickStep(st, DT, v, ctl(0, 0, 0, 0));
  if (hopPress) trickStep(st, DT, v, ctl(0, 0, 0, 1));

  const n = Math.max(1, Math.round(secs / DT));
  v.airborne = true;
  for (let i = 0; i < n; i++) {
    trickStep(st, DT, v, ctl(0, 0, 0, hopPress ? 1 : 0));
    for (let m = 0; m < moves.length; m++) {
      const a = AX[moves[m][0]];
      spinBody(v, a[0], a[1], a[2], moves[m][1] / n);
    }
  }
  // touchdown: airborne goes false and the edge fires, exactly as step() does
  v.airborne = false; v.landEdge = true; v.landQ = landQ;
  trickStep(st, DT, v, ctl(0, 0, 0, 0));
  v.landEdge = false;
  return st;
}

const TAU = Math.PI * 2;

head('A. CLASSIFIER — scripted quaternion sequences in, trick ids out');

/* A1. Every trick, one at a time. Each flight is 1.2 s long so nothing
   accidentally qualifies for BIG AIR (1.8 s) on the way past. */
{
  const cases = [
    ['backflip', TAU, TRICK.BACKFLIP, T.pts.backflip, T.tier.backflip],
    ['frontflip', TAU, TRICK.FRONTFLIP, T.pts.frontflip, T.tier.frontflip],
    ['spin', TAU, TRICK.SPIN360, T.pts.spin360, T.tier.spin360],
    ['spin', TAU * 2, TRICK.SPIN720, T.pts.spin720, T.tier.spin720],
    ['barrel', TAU, TRICK.BARREL, T.pts.barrel, T.tier.barrel],
    ['backflip', TAU * 2, TRICK.DOUBLE, T.pts.double, T.tier.double],
  ];
  for (const [axis, ang, id, pts, tier] of cases) {
    const st = makeTrick();
    fly(st, 1.2, [[axis, ang]]);
    ok(`${f(ang / DEG, 0)}° of ${axis} → ${TRICK_NAME[id]}`, st.id === id,
      `got ${trickLabel(st.id) || 'nothing'}`);
    ok(`  …pays ${pts} at tier ${tier}`, st.pts === pts && st.tier === tier,
      `${st.pts} / tier ${st.tier}`);
  }
}

/* A2. The signs. A backflip and a frontflip are the SAME magnitude about the
   same axis and only the direction tells them apart, so an inverted pitch
   sign is a bug that no magnitude test can see. */
{
  const b = makeTrick(); fly(b, 1.2, [['backflip', TAU]]);
  const fr = makeTrick(); fly(fr, 1.2, [['frontflip', TAU]]);
  info(`pitch accumulated: backflip ${f(b.pitch, 2)} rad, frontflip ${f(fr.pitch, 2)} rad`);
  ok('nose-up accumulates POSITIVE pitch', b.pitch > 6.0 && fr.pitch < -6.0,
    `${f(b.pitch, 2)} / ${f(fr.pitch, 2)}`);
  ok('…and the two are told apart', b.id === TRICK.BACKFLIP && fr.id === TRICK.FRONTFLIP);
}

/* A3. Just under the bar is not a trick. 300° is deliberately under a full
   turn (see config.js), so the thing that must not happen is 290° scoring. */
{
  const st = makeTrick();
  fly(st, 1.2, [['backflip', (T.flipDeg - 20) * DEG]]);
  ok(`${T.flipDeg - 20}° of flip scores nothing`, st.id === 0 && st.pts === 0,
    trickLabel(st.id) || 'nothing');
  const st2 = makeTrick();
  fly(st2, 1.2, [['backflip', (T.flipDeg + 5) * DEG]]);
  ok(`…and ${T.flipDeg + 5}° scores the backflip`, st2.id === TRICK.BACKFLIP);
}

/* A4. Two in one flight is a COMBO, and a DOUBLE is not one. */
{
  const st = makeTrick();
  fly(st, 1.2, [['backflip', TAU], ['spin', TAU]]);
  const want = Math.round((T.pts.backflip + T.pts.spin360) * T.pts.comboMul);
  info(`backflip + 360 in one flight → ${trickLabel(st.id)} for ${st.pts} ` +
    `(${T.pts.backflip} + ${T.pts.spin360} × ${T.pts.comboMul})`);
  ok('two tricks in one flight is a COMBO', st.id === TRICK.COMBO);
  ok('…scored at the combo multiplier', st.pts === want, `${st.pts} vs ${want}`);
  ok('…at tier 3', st.tier === T.tier.combo, `tier ${st.tier}`);

  const dbl = makeTrick();
  fly(dbl, 1.2, [['backflip', TAU * 2]]);
  ok('a DOUBLE FLIP is one trick, not a combo', dbl.id === TRICK.DOUBLE,
    trickLabel(dbl.id));
}

/* A5. The hop window. An INPUT timing, not an airtime — see tricks.js. */
{
  const clean = makeTrick();
  fly(clean, 0.4, [], 1, true);
  ok('handbrake tapped on the lip → STYLE HOP', clean.id === TRICK.HOP,
    trickLabel(clean.id) || 'nothing');
  ok('…at tier 1 for 100', clean.tier === T.tier.hop && clean.pts === T.pts.hop);

  // …and the same flight with the tap too early
  const late = makeTrick();
  const v = fakeV();
  trickStep(late, DT, v, ctl(0, 0, 0, 1));               // the press
  const wait = Math.round((T.hopWindow + 0.15) / DT);    // …then stay on the ground
  for (let i = 0; i < wait; i++) trickStep(late, DT, v, ctl(0, 0, 0, 0));
  v.airborne = true;
  for (let i = 0; i < 24; i++) trickStep(late, DT, v, ctl(0));
  v.airborne = false; v.landEdge = true; v.landQ = 1;
  trickStep(late, DT, v, ctl(0));
  info(`tap ${f(T.hopWindow + 0.15)} s before the lip (window is ${T.hopWindow} s) → ` +
    `${trickLabel(late.id) || 'nothing'}`);
  ok('a tap outside the window is not a hop', late.id === 0 && late.hop === 0);

  // an ordinary jump with no tap at all is not a hop either
  const plain = makeTrick();
  fly(plain, 0.4, []);
  ok('no handbrake, no hop', plain.id === 0);
}

/* A6. BIG AIR, and the fact that it never doubles up with a real trick. */
{
  const big = makeTrick();
  fly(big, T.bigAir + 0.3, []);
  ok(`${f(T.bigAir + 0.3)} s of nothing at all → BIG AIR`, big.id === TRICK.BIG_AIR,
    trickLabel(big.id) || 'nothing');
  ok('…which pays points but no boost tier', big.pts === T.pts.bigAir && big.tier === 0,
    `${big.pts} / tier ${big.tier}`);
  const both = makeTrick();
  fly(both, T.bigAir + 0.3, [['backflip', TAU]]);
  ok('a long flight with a flip in it is a BACKFLIP, not a combo with BIG AIR',
    both.id === TRICK.BACKFLIP, trickLabel(both.id));
}

/* A7. The landing has the last word — the gate that makes a trick a decision. */
{
  const clean = makeTrick(); fly(clean, 1.2, [['backflip', TAU]], T.cleanQ + 0.05);
  const sloppy = makeTrick(); fly(sloppy, 1.2, [['backflip', TAU]], (T.cleanQ + T.sloppyQ) / 2);
  const crash = makeTrick(); fly(crash, 1.2, [['backflip', TAU]], T.sloppyQ - 0.1);
  info(`same backflip, three landings: clean ${clean.pts} pts tier ${clean.tier} · ` +
    `sloppy ${sloppy.pts} pts tier ${sloppy.tier} · crashed ${crash.pts} pts tier ${crash.tier}`);
  ok('a clean landing pays in full', clean.pts === T.pts.backflip && clean.tier === T.tier.backflip);
  ok('a sloppy landing pays half and drops a tier',
    sloppy.pts === Math.round(T.pts.backflip * 0.5) &&
    sloppy.tier === T.tier.backflip - T.sloppyTierDrop,
    `${sloppy.pts} / tier ${sloppy.tier}`);
  ok('below sloppyQ it is a CRASH worth nothing',
    crash.id === TRICK.CRASH && crash.pts === 0 && crash.tier === 0);
  ok('…and a crash still bumps seq, so the HUD can say so', crash.seq === 1);
}

/* A8. Totals, and what survives which reset. */
{
  const st = makeTrick();
  fly(st, 1.2, [['backflip', TAU]]);
  fly(st, 1.2, [['spin', TAU]]);
  fly(st, 1.2, [['backflip', TAU], ['barrel', TAU]]);
  const want = T.pts.backflip + T.pts.spin360 +
    Math.round((T.pts.backflip + T.pts.barrel) * T.pts.comboMul);
  info(`three flights: total ${st.total}, best ${trickLabel(st.best)} for ${st.bestPts}, seq ${st.seq}`);
  ok('points accumulate', st.total === want, `${st.total} vs ${want}`);
  ok('seq counts scored tricks', st.seq === 3, `${st.seq}`);
  ok('best tracks the biggest', st.best === TRICK.COMBO, trickLabel(st.best));

  trickReset(st);
  ok('trickReset clears the FLIGHT',
    st.pitch === 0 && st.yaw === 0 && st.roll === 0 && st.air === 0 &&
    st.launched === 0 && st.id === 0 && st.pts === 0 && st.tier === 0 && st.fired === 0);
  ok('…and keeps the score — a respawn must not cost you your points',
    st.total === want && st.seq === 3 && st.best === TRICK.COMBO,
    `total ${st.total}, seq ${st.seq}`);

  trickClear(st);
  ok('trickClear takes the totals too',
    st.total === 0 && st.seq === 0 && st.best === 0 && st.bestPts === 0);
}

/* A9. Fixed shape. A lazily-created field is a field some reset path forgets;
   miniturbo.js learned this and the state here is built the same way. */
{
  const keys = Object.keys(makeTrick());
  const st = makeTrick();
  fly(st, 1.2, [['backflip', TAU], ['spin', TAU]]);
  trickReset(st); trickClear(st);
  ok('the state object has a fixed shape', Object.keys(st).length === keys.length,
    `${Object.keys(st).length} of ${keys.length} fields`);
  const want = ['qx', 'qy', 'qz', 'qw', 'pitch', 'yaw', 'roll', 'air', 'hopT', 'hop',
    'wasHand', 'launched', 'id', 'pts', 'tier', 'seq', 'q', 'best', 'bestPts',
    'total', 'fired'];
  const missing = want.filter(k => !(k in st));
  ok('…and it is the shape the wave-6 contract names', missing.length === 0,
    missing.join(',') || `${keys.length} fields`);
  ok('every trick id has a name', TRICK_NAME.length === Object.keys(TRICK).length &&
    Object.values(TRICK).every(id => id === 0 || trickLabel(id).length > 0));
}

/* A10. predictAirTime — the one thing ai.js calls. */
{
  const G = 12.8, hang = 0.7;
  const flat = predictAirTime(9, 0, G, hang);
  const drop = predictAirTime(9, 6, G, hang);
  const rise = predictAirTime(9, -2, G, hang);
  info(`predictAirTime at vy 9 m/s: flat ${f(flat)} s, 6 m drop ${f(drop)} s, 2 m rise ${f(rise)} s`);
  ok('flat ground is the symmetric 2·vy/g', Math.abs(flat - 2 * 9 / (G * hang)) < 1e-9,
    `${f(flat, 3)} s`);
  ok('a drop lengthens the hang', drop > flat, `${f(drop)} > ${f(flat)}`);
  ok('a rise shortens it', rise < flat && rise > 0, `${f(rise)} s`);
  ok('an unclearable rise is 0, not NaN', predictAirTime(2, -20, G, hang) === 0);
  ok('zero gravity is 0, not Infinity', predictAirTime(9, 0, 0, hang) === 0);
}

/* ============================================================
   B — THE AIR MODEL, ON A REAL VEHICLE
   ------------------------------------------------------------
   The terrain mock is vehicle-check's, with one addition: the ground beyond
   the lip may rise to a plateau. Real track jumps land you on something —
   a table top, the far side of a gap, the run-out of a hip — and the
   difference matters, because touchdown speed (and therefore landQ) is set
   by how far you FELL, not by how long you flew.
   ============================================================ */
function makeTerrain(heightFn, surface = SURF.DIRT) {
  return {
    heightAt: heightFn,
    normalAt(x, z, e = 0.5, out) {
      const s = Math.max(e, 0.2);
      const hx = heightFn(x + s, z) - heightFn(x - s, z);
      const hz = heightFn(x, z + s) - heightFn(x, z - s);
      out.set(-hx, 2 * s, -hz).normalize();
      return out;
    },
    surfaceAt: () => surface,
    onRoad: () => 1,
  };
}

/**
 * A kicker: flat, then a ramp of `deg` starting at z0 and `len` long, then
 * the ground falls away at the lip. Past the lip it climbs smoothly to
 * `landY` over `rise` metres — 0 for vehicle-check's original flat run-out.
 */
function kicker(deg, z0, len, landY = 0, rise = 45) {
  const t = Math.tan(deg * Math.PI / 180);
  const top = z0 + len;
  return makeTerrain((x, z) => {
    if (z <= z0) return 0;
    if (z < top) return (z - z0) * t;
    if (landY === 0) return 0;
    let u = (z - top) / rise;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    return landY * u * u * (3 - 2 * u);
  });
}


const finite = (v) => [v.pos.x, v.pos.y, v.pos.z, v.vel.x, v.vel.y, v.vel.z,
  v.omega.x, v.omega.y, v.omega.z, v.quat.x, v.quat.y, v.quat.z, v.quat.w,
  v.landQ, v.airPeak, v._trick.pitch, v._trick.yaw, v._trick.roll]
  .every(Number.isFinite);

const VCTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };
const zeroCtl = () => {
  VCTL.throttle = 0; VCTL.steer = 0; VCTL.brake = 0; VCTL.handbrake = 0; VCTL.roll = 0;
};

/**
 * Launch a car off a kicker, fly it with a scripted control policy, and
 * SNAPSHOT the landing.
 *
 * The snapshot matters. The trick is classified one frame after touchdown
 * (vehicle.js, by design), and a car that bounces on the frame after THAT
 * has already re-launched and zeroed its accumulators — read `v._trick` two
 * frames too late and every flight in this file reports 3° of pitch. So:
 * step exactly once past the edge, copy out the numbers, stop.
 *
 * @param policy (airTime, v) → mutates VCTL. Called only once airborne; on
 *               the ramp the car is always flat out.
 */
function launch({ id = 'hopper', speed = 30, deg = 20, landY = 0, rise = 45,
  policy = null, maxT = 14 } = {}) {
  const S = VEHICLE_BY_ID[id];
  const terrain = kicker(deg, 40, 10, landY, rise);
  const v = new Vehicle(null, terrain, S, { headless: true });
  v.placeAt(0, 0, 0);
  v.vel.set(0, 0, speed);
  for (const w of v.wheels) w.spinVel = speed / S.wheelR;

  let t = 0, launched = false, air = 0, allFinite = true;
  let landed = false, hardHit = 0, landQ = 0, peak = 0, up = 1;
  while (t < maxT) {
    zeroCtl();
    if (!launched) VCTL.throttle = 1;
    else if (policy) policy(v.airTime, v);
    v.step(DT, VCTL);
    t += DT;
    if (!finite(v)) { allFinite = false; break; }
    if (!launched && v.airborne && v.pos.z > 40) launched = true;
    if (launched && v.airborne) air = v.airTime;
    if (launched && v.landEdge) {
      landed = true;
      hardHit = v.hardHit; landQ = v.landQ; peak = v.airPeak; up = v.up.y;
      break;
    }
  }
  // exactly ONE more step: the deferred classification, and nothing after it
  const st = v._trick;
  let id2 = 0, pts = 0, tier = 0, pitch = 0, yaw = 0, roll = 0, fired = 0, mul = 1;
  if (landed) {
    zeroCtl();
    v.step(DT, VCTL);
    id2 = st.id; pts = st.pts; tier = st.tier;
    pitch = st.pitch; yaw = st.yaw; roll = st.roll;
    fired = v._drift.fireTier; mul = v._drift.mul;
  }
  return {
    v, air, launched, landed, up, landQ, peak, hardHit,
    finite: allFinite && finite(v), spinT: v.spinT,
    id: id2, pts, tier, pitch, yaw, roll, fired, mul,
    name: trickLabel(id2) || '-',
  };
}

head('B1. NO INPUT — a player who touches nothing must land on their wheels');
{
  /* The gate the whole rewrite rests on. The authorities were doubled; the
     only reason that is safe is that doing nothing still works. */
  for (const speed of [24, 28, 32, 36]) {
    const r = launch({ speed });
    info(`${speed} m/s off a 20° kicker: ${f(r.air)} s hang, ${f(r.peak)} m over the lip, ` +
      `landQ ${f(r.landQ)}, up.y ${f(r.up)}`);
    ok(`${speed} m/s, hands off: lands upright (up.y > 0.9)`, r.up > 0.9, `${f(r.up)}`);
    ok(`${speed} m/s: a clean landing, not a scored crash`,
      r.landQ >= T.cleanQ && r.id !== TRICK.CRASH, `landQ ${f(r.landQ)} ${r.name}`);
    ok(`${speed} m/s: finite`, r.finite);
  }
}

head('B2. COMMITTED — 0.9 s of throttle is a backflip, and it pays tier 2');
{
  const HOLD = 0.9;
  const r = launch({ speed: 30, deg: 20, policy: (at) => { if (at < HOLD) VCTL.throttle = 1; } });
  info(`${f(HOLD)} s of throttle then hands off, 30 m/s off the 20° kicker: ` +
    `${f(r.air)} s hang, ${f(r.pitch / DEG, 0)}° of pitch, landQ ${f(r.landQ)}, up.y ${f(r.up)}`);
  info(`  → ${r.name} for ${r.pts}, tier ${r.tier}, mini-turbo tier ${r.fired} at ×${f(r.mul)}`);
  ok('a held-then-released throttle completes a BACKFLIP', r.id === TRICK.BACKFLIP, r.name);
  ok('…and the assist still lands it on its wheels', r.up > 0.9, `up.y ${f(r.up)}`);
  ok('…for a clean tier 2', r.tier === 2 && r.pts === T.pts.backflip,
    `${r.pts} pts, tier ${r.tier}`);
  ok('…which reaches the mini-turbo through driftFire', r.fired === 2 && r.mul > 1,
    `tier ${r.fired} ×${f(r.mul)}`);
  ok('…and nothing went NaN doing it', r.finite);

  /* Hold longer and it stops being a backflip and starts being a mistake —
     which is the point of the whole mechanic. */
  const over = launch({ speed: 30, deg: 20, policy: (at) => { if (at < 1.3) VCTL.throttle = 1; } });
  info(`the same jump with 1.3 s of throttle: ${f(over.pitch / DEG, 0)}° — ` +
    `${over.name}, up.y ${f(over.up)}`);
  ok('over-rotating past the turn costs the landing',
    over.pitch > r.pitch && over.up < r.up, `${f(over.up)} vs ${f(r.up)}`);
}

head('B3. THE MODIFIER — handbrake + steer is a barrel roll');
{
  const r = launch({
    speed: 30, deg: 20,
    policy: (at) => { if (at < 1.0) { VCTL.handbrake = 1; VCTL.steer = 1; } },
  });
  info(`1.0 s of handbrake + full steer: ${f(r.roll / DEG, 0)}° of roll against ` +
    `${f(r.yaw / DEG, 0)}° of yaw, landQ ${f(r.landQ)}, up.y ${f(r.up)} → ${r.name} for ${r.pts}`);
  ok('handbrake + steer in the air is a BARREL ROLL', r.id === TRICK.BARREL, r.name);
  ok('…rolling far more than it yaws', Math.abs(r.roll) > Math.abs(r.yaw) * 4,
    `${f(r.roll / DEG, 0)}° roll vs ${f(r.yaw / DEG, 0)}° yaw`);
  ok('…and it lands on its wheels', r.up > 0.5, `up.y ${f(r.up)}`);
  ok('…finite', r.finite);

  // the same input WITHOUT the handbrake must yaw instead — that is the modifier
  const yawOnly = launch({ speed: 30, deg: 20, policy: (at) => { if (at < 1.0) VCTL.steer = 1; } });
  info(`the same steer with no handbrake: ${f(yawOnly.roll / DEG, 0)}° of roll, ` +
    `${f(yawOnly.yaw / DEG, 0)}° of yaw`);
  ok('without the handbrake the same steer yaws instead of rolling',
    Math.abs(yawOnly.yaw) > Math.abs(yawOnly.roll) * 4,
    `${f(yawOnly.yaw / DEG, 0)}° yaw vs ${f(yawOnly.roll / DEG, 0)}° roll`);
}

head('B4. NEVER LETTING GO — the flip you cannot finish is a crash');
{
  const r = launch({ speed: 30, deg: 20, policy: () => { VCTL.throttle = 1; } });
  info(`throttle pinned through ${f(r.air)} s of air: ${f(r.pitch / DEG, 0)}° of pitch, ` +
    `landQ ${f(r.landQ)}, up.y ${f(r.up)}, hardHit ${f(r.hardHit)} m/s, spinT ${f(r.spinT)} s`);
  ok('holding throttle all the way down crashes the landing',
    r.id === TRICK.CRASH && r.pts === 0, `${r.name} / ${r.pts} pts`);
  ok('…and it pays no mini-turbo', r.fired === 0 && r.mul === 1, `tier ${r.fired}`);
  ok('…the crash spins the car, through the path race.js already knows',
    r.spinT >= T.crashSpin - 0.05, `spinT ${f(r.spinT)} s`);
  ok('…and reports an impact for feel.js and audio', r.hardHit >= 8, `${f(r.hardHit)} m/s`);
  ok('…without ever going NaN', r.finite);
}

head('B5. ROLL SIGNS — Q/E and the handbrake modifier must agree');
{
  /* Both roll inputs must send the car the same way, or the two control
     schemes fight each other in the same player's hands. Positive is the
     car's RIGHT side going down (vehicle.js), and right is −X. */
  const mk = (roll, hand, steer) => launch({
    speed: 30, deg: 20,
    policy: (at) => {
      if (at > 0.7) return;                     // a dab, not a full roll
      VCTL.roll = roll; VCTL.handbrake = hand; VCTL.steer = steer;
    },
  });
  const qKey = mk(-1, 0, 0), eKey = mk(1, 0, 0);
  const handR = mk(0, 1, 1), handL = mk(0, 1, -1);
  info(`0.7 s dabs — Q ${f(qKey.roll / DEG, 0)}°, E ${f(eKey.roll / DEG, 0)}°, ` +
    `handbrake+right ${f(handR.roll / DEG, 0)}°, handbrake+left ${f(handL.roll / DEG, 0)}°`);
  ok('E rolls one way and Q the other', eKey.roll > 0.5 && qKey.roll < -0.5,
    `${f(eKey.roll, 2)} / ${f(qKey.roll, 2)}`);
  ok('handbrake + steer rolls the SAME way as the matching key',
    Math.sign(handR.roll) === Math.sign(eKey.roll) &&
    Math.sign(handL.roll) === Math.sign(qKey.roll),
    `${f(handR.roll, 2)} / ${f(handL.roll, 2)}`);
  ok('the handbrake modifier suppresses yaw', Math.abs(handR.yaw) < Math.abs(handR.roll) * 0.3,
    `${f(handR.yaw / DEG, 0)}° of yaw against ${f(handR.roll / DEG, 0)}° of roll`);
  ok('all four flights finite', qKey.finite && eKey.finite && handR.finite && handL.finite);
}

head('B6. THE AI CANNED TRICK — the contract at the top of tricks.js, run');
{
  /* The reference implementation of the contract P5 codes against. It is
     gated here rather than left as prose precisely because the first version
     of that contract — a hold time proportional to the predicted hang — read
     perfectly well and landed one flight in ten. */
  const G = 12.8, K = TUNE.air.damp;
  const BACKFLIP_TARGET = 275 * DEG, BARREL_TARGET = 290 * DEG;
  const rng = makeRNG(0x7121C);
  let upright = 0, scored = 0, tier2 = 0, worst = 1;
  const rows = [];

  for (let i = 0; i < 10; i++) {
    const speed = 24 + i * 1.4;
    const deg = 18 + (i % 4) * 2;
    const landY = (i % 5);
    const aggression = rng();
    const ground = kicker(deg, 40, 10, landY, 42);
    let kind = '', target = 0, live = 0, lastSpun = 0, rate = 0, tAir = 0;

    const r = launch({
      speed, deg, landY, rise: 42,
      policy: (at, v) => {
        if (live === 0) {
          // FIRST airborne frame: commit, or fly it straight.
          tAir = predictAirTime(v.vel.y, -landY, G, 0.7);
          if (tAir < 1.3) { live = -1; return; }
          live = 1;
          kind = aggression > 0.6 ? 'BARREL' : 'BACKFLIP';
          target = kind === 'BARREL' ? BARREL_TARGET : BACKFLIP_TARGET;
          lastSpun = 0; rate = 0;
        }
        if (live < 0) return;
        const spun = Math.abs(kind === 'BARREL' ? v._trick.roll : v._trick.pitch);
        rate += ((spun - lastSpun) / DT - rate) * 0.35;
        lastSpun = spun;
        if (live !== 1) return;
        const tG = predictAirTime(v.vel.y, v.pos.y - ground.heightAt(v.pos.x, v.pos.z), G, 0.7);
        if (spun + rate * (1 - Math.exp(-K * tG)) / K >= target ||
            at >= 1.4 || tG < 0.45) { live = 2; return; }
        if (kind === 'BARREL') { VCTL.handbrake = 1; VCTL.steer = 1; }
        else VCTL.throttle = 1;
      },
    });
    if (r.up > 0.7) upright++;
    if (r.id && r.id !== TRICK.CRASH) scored++;
    if (r.tier >= 2) tier2++;
    if (r.up < worst) worst = r.up;
    rows.push(`${f(speed, 1).padStart(4)} m/s ${deg}° +${landY} m  tAir ${f(tAir)} s  ` +
      `${(kind || 'straight').padEnd(8)} → ${f(kind === 'BARREL' ? r.roll / DEG : r.pitch / DEG, 0).padStart(4)}°  ` +
      `${(r.name).padEnd(12)} t${r.tier}  up.y ${f(r.up)}`);
  }
  for (const s of rows) info(s);
  ok('the AI canned sequence lands upright at least 9 times in 10', upright >= 9,
    `${upright}/10 with up.y > 0.7, worst ${f(worst)}`);
  ok('…and scores a trick on at least 8 of them', scored >= 8, `${scored}/10 scored`);
  ok('…most of them clean enough for a real tier', tier2 >= 6, `${tier2}/10 at tier 2+`);
}

head('B7. HOUSEKEEPING — publications, the debounce, and placeAt');
{
  /* landEdge must not strobe. TUNE.trick.minAir is the debounce; without it
     a whoops section fires a landing event every few frames and the HUD's
     landSeq — and the trick classifier behind it — run continuously. */
  const S = VEHICLE_BY_ID.hopper;
  const chatter = makeTerrain((x, z) => Math.sin(z * 2.1) * 0.11);
  const v = new Vehicle(null, chatter, S, { headless: true });
  v.placeAt(0, 0, 0);
  v.vel.set(0, 0, 26);
  for (const w of v.wheels) w.spinVel = 26 / S.wheelR;
  let edges = 0, airFrames = 0;
  for (let i = 0; i < 480; i++) {
    zeroCtl(); VCTL.throttle = 0.6;
    v.step(DT, VCTL);
    if (v.landEdge) edges++;
    if (v.airborne) airFrames++;
  }
  /* ~70 crests pass under the car in those 8 s and it leaves the ground on
     most of them. Without the debounce that is ~70 landing events and ~70
     classifications; the gate is that almost none of them count. */
  info(`8 s over 22 cm chatter at 26 m/s (≈70 crests): off the ground on ${airFrames} ` +
    `of 480 frames, ${edges} landing edges, ${v._trick.seq} tricks scored`);
  ok('rut chatter does not fire a landing event per bump', edges <= 3, `${edges} edges`);
  ok('…and scores nothing', v._trick.total === 0, `${v._trick.total} pts`);
  ok('…and stays finite', finite(v));

  // placeAt wipes the flight and keeps the score
  const r = launch({ speed: 30, deg: 20 });
  r.v._trick.total = 4200; r.v._trick.seq = 7;
  r.v.landQ = 0.3; r.v.airPeak = 9; r.v.landEdge = true;
  r.v.placeAt(5, 5, 1);
  ok('placeAt zeroes the air publications',
    r.v.landEdge === false && r.v.landQ === 0 && r.v.airPeak === 0);
  ok('…and the flight, but not the score',
    r.v._trick.launched === 0 && r.v._trick.pitch === 0 &&
    r.v._trick.total === 4200 && r.v._trick.seq === 7);

  // airPeak is measured from the lip, and it is a real number
  const big = launch({ speed: 34, deg: 22 });
  info(`34 m/s off a 22° kicker: airPeak ${f(big.peak)} m over the lip, ${f(big.air)} s of hang`);
  ok('airPeak reports height over the LAUNCH point', big.peak > 3 && big.peak < 25,
    `${f(big.peak)} m`);

  // a ctl with no `roll` field must fly straight, not NaN — harnesses predate it
  const old = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };
  const v2 = new Vehicle(null, kicker(20, 40, 10), S, { headless: true });
  v2.placeAt(0, 0, 0);
  v2.pos.y += 8;
  for (let i = 0; i < 150; i++) v2.step(DT, old);
  ok('a ctl with no `roll` field is flown straight, not NaN',
    finite(v2) && v2.up.y > 0.9, `up.y ${f(v2.up.y)}`);
}

/* ---------------- verdict ---------------- */
console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('air control + tricks OK');
void THREE;

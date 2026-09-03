/* ============================================================
   RALLY ROAD RASH — vehicle physics smoke test
   ------------------------------------------------------------
   These gates ARE the acceptance criteria for the handling model. Every one
   of them is a number a player can feel; if one moves, the car changed.

     node --experimental-loader ./dev/loader.mjs dev/vehicle-check.mjs

   Runs headless (no scene, no canvas, no DOM). Nonzero exit on any failure.
   ============================================================ */
import * as THREE from 'three';
import { Vehicle, resolveVehiclePair } from '../src/game/vehicle.js';
import { tyreTubeGeometry } from '../src/game/vehicle-art.js';
import { VEHICLES, VEHICLE_BY_ID, statBars } from '../src/game/vehicles.js';
import { G, TUNE } from '../src/game/config.js';
import { SURF } from '../src/world/surfaces.js';
import { makeRNG } from '../src/core/rng.js';

/* ---------------- mock terrain ----------------
   Only the four methods the vehicle is contracted to use. normalAt is a real
   central difference of heightAt, so a mock ramp produces a mock normal that
   actually agrees with its own surface — the same invariant the real terrain
   has to hold. */
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
const flat = (s = SURF.DIRT) => makeTerrain(() => 0, s);

/** A kicker: flat, then a ramp of `deg` starting at z0 and `len` long, then
    flat ground again at zero. Launch happens at the lip. */
function kicker(deg, z0, len, s = SURF.DIRT) {
  const t = Math.tan(deg * Math.PI / 180);
  return makeTerrain((x, z) => {
    if (z <= z0) return 0;
    if (z >= z0 + len) return 0;              // the lip: ground falls away
    return (z - z0) * t;
  }, s);
}

/* ---------------- harness ---------------- */
let failures = 0, checks = 0;
const DT = 1 / 60;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));

function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

const CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };
const ctl = (t = 0, s = 0, b = 0, h = 0) => {
  CTL.throttle = t; CTL.steer = s; CTL.brake = b; CTL.handbrake = h; return CTL;
};

function make(id, terrain, x = 0, z = 0, yaw = 0) {
  const v = new Vehicle(null, terrain, VEHICLE_BY_ID[id], { headless: true });
  v.placeAt(x, z, yaw);
  return v;
}
function finite(v) {
  const okv = (a) => Number.isFinite(a);
  if (![v.pos.x, v.pos.y, v.pos.z, v.vel.x, v.vel.y, v.vel.z,
    v.omega.x, v.omega.y, v.omega.z, v.quat.x, v.quat.y, v.quat.z, v.quat.w,
    v.rpmNorm, v.hardHit, v.steerAngle].every(okv)) return false;
  for (const w of v.wheels) if (!okv(w.spinVel) || !okv(w.comp) || !okv(w.load)) return false;
  return true;
}

/* ============================================================
   0 — derived chassis numbers (these are what the tuning claims)
   ============================================================ */
head('0. CHASSIS — derived from mass + spec');
for (const S of VEHICLES) {
  const v = make(S.id, flat());
  const sagPct = v.sag / S.suspTravel * 100;
  const rollThresh = S.track / S.comHeight * G;
  const peakLat = Math.max(S.gripF, S.gripR) * G;            // on ROAD (grip 1.0)
  const dragTop = v.aeroC * S.topSpeed ** 2 +
    (0.012 + 0.35 * TUNE.tyre.sinkDrag) * S.mass * G;        // DIRT
  const tailF = TUNE.drive.fadeTail * S.motorForce;
  info(`${S.id.padEnd(10)} ride ${f(v.rideHz)} Hz  ζ ${f(v.rideZeta)}  sag ${f(v.sag * 100, 1)} cm = ${f(sagPct, 1)}% of travel`);
  info(`${''.padEnd(10)} rollover ${f(rollThresh, 1)} m/s² vs peak lateral ${f(peakLat, 1)} → margin ${f(rollThresh / peakLat)}×`);
  info(`${''.padEnd(10)} drag@top ${f(dragTop, 0)} N vs tail force ${f(tailF, 0)} N   peak accel ${f(S.motorForce / S.mass)} m/s²`);
  ok(`${S.id}: ride frequency 1.6–2.25 Hz`, v.rideHz > 1.6 && v.rideHz < 2.25, `${f(v.rideHz)} Hz`);
  ok(`${S.id}: damping ratio 0.70–0.85`, v.rideZeta > 0.70 && v.rideZeta < 0.85, `${f(v.rideZeta)}`);
  ok(`${S.id}: static sag 12–18% of travel`, sagPct > 12 && sagPct < 18, `${f(sagPct, 1)}%`);
  ok(`${S.id}: rollover margin > 1.15×`, rollThresh / peakLat > 1.15, `${f(rollThresh / peakLat)}×`);
  ok(`${S.id}: tail force beats drag at topSpeed`, tailF > dragTop, `${f(tailF, 0)} > ${f(dragTop, 0)} N`);
  const b = statBars(S);
  info(`${''.padEnd(10)} statBars  speed ${f(b.speed)}  accel ${f(b.accel)}  grip ${f(b.grip)}  weight ${f(b.weight)}`);
}

/* ============================================================
   (a) 0 → top speed
   ============================================================ */
head('(a) ACCELERATION — 0 → 95% topSpeed in < 9 s, then holds ±2%');
{
  for (const S of VEHICLES) {
    const v = make(S.id, flat());
    let t = 0, t95 = -1, peak = 0;
    while (t < 26) { v.step(DT, ctl(1)); t += DT; const sp = v.speed; if (sp > peak) peak = sp; if (t95 < 0 && sp >= S.topSpeed * 0.95) t95 = t; }
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < 300; i++) { v.step(DT, ctl(1)); const sp = v.speed; lo = Math.min(lo, sp); hi = Math.max(hi, sp); }
    const band = Math.max(Math.abs(lo - S.topSpeed), Math.abs(hi - S.topSpeed)) / S.topSpeed * 100;
    info(`${S.id.padEnd(10)} t95 ${f(t95)} s   terminal ${f(lo)}–${f(hi)} m/s (spec ${S.topSpeed})   band ±${f(band, 2)}%`);
    if (S.id === 'hopper') {
      ok('hopper: reaches 95% topSpeed in < 9 s', t95 > 0 && t95 < 9, `${f(t95)} s`);
      ok('hopper: settles within ±2% of topSpeed', band < 2, `±${f(band, 2)}%`);
    } else {
      ok(`${S.id}: settles within ±2% of topSpeed`, band < 2, `±${f(band, 2)}%`);
    }
  }
  // mud must be felt, not just seen
  const dirt = make('hopper', flat(SURF.DIRT));
  const mud = make('hopper', flat(SURF.MUD));
  for (let i = 0; i < 1800; i++) { dirt.step(DT, ctl(1)); mud.step(DT, ctl(1)); }
  info(`mud penalty: dirt top ${f(dirt.speed)} m/s vs mud top ${f(mud.speed)} m/s  (${f((1 - mud.speed / dirt.speed) * 100, 1)}% slower)`);
  ok('MUD is meaningfully slower than DIRT', dirt.speed - mud.speed > 1.0,
    `${f(dirt.speed - mud.speed)} m/s`);
}

/* ============================================================
   (b) braking
   ============================================================ */
head('(b) BRAKING — 30 → 0 m/s in < 45 m');
{
  for (const S of VEHICLES) {
    const v = make(S.id, flat());
    v.vel.set(0, 0, 30);
    for (const w of v.wheels) w.spinVel = 30 / S.wheelR;
    const z0 = v.pos.z;
    let t = 0, frontFrac = 0, samples = 0;
    while (v.speed > 0.15 && t < 12) {
      v.step(DT, ctl(0, 0, 1)); t += DT;
      if (v.speed > 5) {
        const fl = v.wheels[0].load + v.wheels[1].load;
        const rl = v.wheels[2].load + v.wheels[3].load;
        if (fl + rl > 1) { frontFrac += fl / (fl + rl); samples++; }
      }
    }
    const d = v.pos.z - z0;
    frontFrac /= Math.max(1, samples);
    info(`${S.id.padEnd(10)} ${f(d)} m in ${f(t)} s  (mean decel ${f(900 / (2 * d))} m/s²)  front load share under braking ${f(frontFrac * 100, 1)}%`);
    ok(`${S.id}: 30→0 in under 45 m`, d < 45 && d > 5, `${f(d)} m`);
    // weight transfer must be EMERGENT, not scripted — this is the proof
    ok(`${S.id}: weight transfers forward under braking`, frontFrac > 0.58,
      `${f(frontFrac * 100, 1)}% front`);
  }
}

/* ============================================================
   (c) steady-state cornering
   ============================================================ */
head('(c) CORNERING — full lock at 18 m/s: settles, radius 12–30 m, no flip');
{
  for (const S of VEHICLES) {
    const v = make(S.id, flat());
    v.vel.set(0, 0, 18);
    for (const w of v.wheels) w.spinVel = 18 / S.wheelR;
    let t = 0, minUp = 1;
    const yaws = [];
    while (t < 9) {
      // hold ~18 m/s so the radius is a cornering measurement, not a coastdown
      const thr = v.speed < 18 ? 0.55 : 0;
      v.step(DT, ctl(thr, 1)); t += DT;
      minUp = Math.min(minUp, v.up.y);
      if (t > 6) yaws.push({ w: v.omega.dot(v.up), s: v.speed });
    }
    const yr = yaws.reduce((a, b) => a + Math.abs(b.w), 0) / yaws.length;
    const sp = yaws.reduce((a, b) => a + b.s, 0) / yaws.length;
    let sd = 0; for (const y of yaws) sd += (Math.abs(y.w) - yr) ** 2;
    sd = Math.sqrt(sd / yaws.length);
    const R = sp / yr;
    info(`${S.id.padEnd(10)} yaw ${f(yr, 3)} ±${f(sd, 4)} rad/s at ${f(sp)} m/s → radius ${f(R)} m   min up.y ${f(minUp)}   lat ${f(yr * sp)} m/s²`);
    ok(`${S.id}: radius 12–30 m`, R > 12 && R < 30, `${f(R)} m`);
    ok(`${S.id}: yaw rate settled (σ < 8%)`, sd / yr < 0.08, `σ/µ ${f(sd / yr, 3)}`);
    ok(`${S.id}: never came close to flipping`, minUp > 0.80, `min up.y ${f(minUp)}`);
    ok(`${S.id}: finite`, finite(v));
  }
}

/* ============================================================
   (d) drop test
   ============================================================ */
head('(d) LANDING — 6 m drop: recovers, reports hardHit, no NaN');
{
  for (const S of VEHICLES) {
    const v = make(S.id, flat());
    v.pos.y += 6;
    let t = 0, peakHit = 0, airborneSeen = false, minComp = 9;
    while (t < 6) {
      v.step(DT, ctl(0)); t += DT;
      peakHit = Math.max(peakHit, v.hardHit);
      if (v.airborne) airborneSeen = true;
      if (!v.airborne && t > 1.2) minComp = Math.min(minComp, v.wheels[0].comp);
    }
    const vmag = v.vel.length();
    const settle = Math.abs(v.wheels[0].comp - v.sag);
    info(`${S.id.padEnd(10)} peak hardHit ${f(peakHit)} m/s   resting |v| ${f(vmag, 3)}   comp ${f(v.wheels[0].comp * 100, 1)} cm vs sag ${f(v.sag * 100, 1)} cm`);
    ok(`${S.id}: went airborne then landed`, airborneSeen && !v.airborne);
    ok(`${S.id}: hardHit fired`, peakHit > 0, `${f(peakHit)} m/s`);
    ok(`${S.id}: velocity decayed to rest`, vmag < 0.35, `${f(vmag, 3)} m/s`);
    ok(`${S.id}: suspension recovered to static sag`, settle < 0.012,
      `Δ ${f(settle * 1000, 1)} mm`);
    ok(`${S.id}: upright and finite`, finite(v) && v.up.y > 0.98);
    void minComp;
  }
}

/* ============================================================
   (e) high-speed stability
   ============================================================ */
head('(e) STABILITY — 10 s hands-off at 38 m/s (redline): heading drift < 8°');
{
  /* A perfectly symmetric car on a perfectly flat plane holds a heading for
     free, which would make this gate meaningless. So it gets kicked first: a
     yaw rate and a sideways shove, of the size a kerb or a rut would give it.
     The controller has to actually catch that and then hold. */
  const S = VEHICLE_BY_ID.redline;
  const v = make('redline', flat());
  v.vel.set(1.5, 0, 38);
  v.omega.set(0, 0.30, 0);
  for (const w of v.wheels) w.spinVel = 38 / S.wheelR;
  const h0 = Math.atan2(v.forward.x, v.forward.z);
  let t = 0, settled = -1, maxYaw = 0, lastH = h0;
  while (t < 10) {
    v.step(DT, ctl(1)); t += DT;
    const yr = Math.abs(v.omega.dot(v.up));
    maxYaw = Math.max(maxYaw, yr);
    if (settled < 0 && t > 0.4 && yr < 0.01) settled = t;
    lastH = Math.atan2(v.forward.x, v.forward.z);
  }
  let drift = Math.abs((lastH - h0) * 180 / Math.PI) % 360;
  if (drift > 180) drift = 360 - drift;
  info(`kicked with 0.30 rad/s + 1.5 m/s of side slip → total heading drift ${f(drift, 2)}°, settled in ${f(settled)} s, peak yaw ${f(maxYaw, 3)} rad/s`);
  ok('redline: heading drift < 8° over 10 s hands-off', drift < 8, `${f(drift, 2)}°`);
  ok('redline: yaw disturbance is caught, not just ridden out', settled > 0 && settled < 3,
    `settled ${f(settled)} s`);
  ok('redline: finite', finite(v));
}

/* ============================================================
   (f) vehicle ↔ vehicle
   ============================================================ */
head('(f) COLLISION — head-on 2 × 15 m/s, then a 6-car funnel');
{
  const t0 = flat();
  const a = make('hopper', t0, 0, -2.0, 0);            // facing +Z
  const b = make('hopper', t0, 0, 2.0, Math.PI);       // facing −Z
  a.vel.set(0, 0, 15); b.vel.set(0, 0, -15);
  const ke0 = 0.5 * a.mass * a.vel.lengthSq() + 0.5 * b.mass * b.vel.lengthSq();
  let impact = 0;
  for (let i = 0; i < 60 && impact === 0; i++) {
    a.step(DT, ctl(0)); b.step(DT, ctl(0));
    impact = resolveVehiclePair(a, b);
  }
  const ke1 = 0.5 * a.mass * a.vel.lengthSq() + 0.5 * b.mass * b.vel.lengthSq();
  info(`impact ${f(impact)} m/s   a.vz ${f(a.vel.z)} → b.vz ${f(b.vel.z)}   KE ${f(ke0 / 1000, 1)} → ${f(ke1 / 1000, 1)} kJ`);
  ok('head-on: reported an impact speed', impact > 25, `${f(impact)} m/s`);
  ok('head-on: both bounce back', a.vel.z < 0 && b.vel.z > 0,
    `${f(a.vel.z)} / ${f(b.vel.z)}`);
  ok('head-on: energy decreased', ke1 < ke0, `${f(ke1 / ke0 * 100, 1)}% retained`);
  ok('head-on: hardHit propagated to both', a.hardHit > 0 && b.hardHit > 0);
  ok('head-on: finite', finite(a) && finite(b));

  // six cars converging on the same point at 25 m/s — the turn-one funnel
  const pack = [];
  for (let i = 0; i < 6; i++) {
    const ang = i / 6 * Math.PI * 2;
    const c = make(VEHICLES[i % 3].id, t0, Math.sin(ang) * 22, Math.cos(ang) * 22, ang + Math.PI);
    c.vel.set(-Math.sin(ang) * 25, 0, -Math.cos(ang) * 25);
    for (const w of c.wheels) w.spinVel = 25 / c.spec.wheelR;
    pack.push(c);
  }
  let maxSpeed = 0, maxOmega = 0, allFinite = true, biggest = 0;
  for (let s = 0; s < 240; s++) {
    for (const c of pack) c.step(DT, ctl(0.6));
    for (let i = 0; i < pack.length; i++) {
      for (let j = i + 1; j < pack.length; j++) {
        biggest = Math.max(biggest, resolveVehiclePair(pack[i], pack[j]));
      }
    }
    for (const c of pack) {
      maxSpeed = Math.max(maxSpeed, c.vel.length());
      maxOmega = Math.max(maxOmega, c.omega.length());
      if (!finite(c)) allFinite = false;
    }
  }
  info(`funnel: biggest impact ${f(biggest)} m/s   max |v| after ${f(maxSpeed)} m/s   max |ω| ${f(maxOmega)} rad/s`);
  ok('6-car funnel: nothing exploded', allFinite && maxSpeed < 60 && maxOmega < 12,
    `|v|max ${f(maxSpeed)}  |ω|max ${f(maxOmega)}`);
  // no two cars left interpenetrating
  let worst = 0;
  for (let i = 0; i < pack.length; i++) {
    for (let j = i + 1; j < pack.length; j++) {
      const d = pack[i].pos.distanceTo(pack[j].pos);
      worst = Math.max(worst, (pack[i].sphR + pack[j].sphR) - d);
    }
  }
  ok('6-car funnel: no deep residual overlap', worst < 1.2, `worst ${f(worst)} m`);
}

/* ============================================================
   (g) NaN fuzz
   ============================================================ */
head('(g) FUZZ — 60 s of random control at 20 Hz, all three cars');
{
  for (const S of VEHICLES) {
    const rng = makeRNG(0xBADF00D ^ S.id.length * 977);
    const v = make(S.id, flat());
    let t = 0, ok2 = true, hold = 0, th = 0, st = 0, br = 0, hb = 0, worstY = 0;
    while (t < 60 && ok2) {
      if (hold <= 0) {
        hold = 0.05;
        th = rng() * 2 - 1; st = rng() * 2 - 1;
        br = rng() < 0.3 ? rng() : 0; hb = rng() < 0.18 ? 1 : 0;
      }
      // random frame times too, including the dt cap
      const dt = 1 / 60 + (rng() - 0.5) * 0.02 + (rng() < 0.01 ? 0.09 : 0);
      v.step(dt, ctl(th, st, br, hb));
      v.updateVisuals(dt);                      // headless: must be a no-op, not a crash
      hold -= dt; t += dt;
      worstY = Math.max(worstY, Math.abs(v.pos.y));
      if (!finite(v)) ok2 = false;
    }
    info(`${S.id.padEnd(10)} survived ${f(t)} s   |y| max ${f(worstY)} m   rpmNorm ${f(v.rpmNorm)}   gear ${v.gear + 1}`);
    ok(`${S.id}: all state finite through 60 s of fuzz`, ok2 && t >= 60);
    ok(`${S.id}: never left the world`, worstY < 30, `${f(worstY)} m`);
  }
}

/* ============================================================
   (h) the jump — what G = 12.8 actually buys
   ============================================================ */
head('(h) JUMPS — 20° kicker at 30 m/s must give ≥ 18 m of air');
{
  const RAMP = 10;                 // m of z: a kicker, not a mountain road
  const fly = (deg, holdThrottle) => {
    const S = VEHICLE_BY_ID.hopper;
    const v = new Vehicle(null, kicker(deg, 40, RAMP), S, { headless: true });
    v.placeAt(0, 0, 0);
    v.vel.set(0, 0, 30);
    for (const w of v.wheels) w.spinVel = 30 / S.wheelR;
    let t = 0, launchZ = 0, launchY = 0, launched = false, peak = 0, air = 0, landZ = 0;
    let launchSpeed = 0, pitchSwing = 0;
    while (t < 12) {
      // Throttle to the lip; in the air, the sane player lifts. `holdThrottle`
      // is the other experiment: it should cost you the landing.
      v.step(DT, ctl(!launched || holdThrottle ? 1 : 0)); t += DT;
      if (!launched && v.airborne && v.pos.z > 40) {
        launched = true; launchZ = v.pos.z; launchY = v.pos.y; launchSpeed = v.vel.length();
      }
      if (launched) {
        peak = Math.max(peak, v.pos.y - launchY);
        pitchSwing = Math.max(pitchSwing, Math.abs(Math.asin(clampf(v.forward.y, -1, 1))));
        if (v.airborne) { air = v.airTime; landZ = v.pos.z; }
        else if (v.airTime === 0 && air > 0.2) break;
      }
    }
    return { dist: landZ - launchZ, air, peak, launchSpeed, pitchSwing, v };
  };
  const clampf = (x, a, b) => (x < a ? a : x > b ? b : x);

  for (const deg of [12, 20]) {
    const r = fly(deg, false);
    info(`${deg}° kicker @30 m/s → ${f(r.dist)} m of air, ${f(r.air)} s hang, ${f(r.peak)} m over the lip (left the lip at ${f(r.launchSpeed)} m/s)`);
    ok(`${deg}° kicker: landed upright and finite`, finite(r.v) && r.v.up.y > 0.5,
      `up.y ${f(r.v.up.y)}`);
    if (deg === 20) ok('20° kicker at 30 m/s clears 18 m', r.dist >= 18, `${f(r.dist)} m`);
  }
  // …and the counter-experiment: holding throttle through the air must still
  // rotate you enough to ruin it, or the jumps carry no risk at all
  const held = fly(20, true);
  info(`holding throttle through the 20° jump: nose swung ${f(held.pitchSwing * 180 / Math.PI, 0)}°, landed up.y ${f(held.v.up.y)}`);
  ok('holding throttle in the air visibly costs you the landing',
    held.pitchSwing > 0.45, `${f(held.pitchSwing * 180 / Math.PI, 0)}° of pitch`);
}

/* ============================================================
   (i) drift + air control sanity (not gated, but it should not be silent)
   ============================================================ */
head('(i) FEEL PROBES');
{
  // handbrake must rotate the car harder than grip alone — but must NOT spin it
  const S = VEHICLE_BY_ID.hopper;
  const yawOf = (hand) => {
    const v = make('hopper', flat());
    v.vel.set(0, 0, 22);
    for (const w of v.wheels) w.spinVel = 22 / S.wheelR;
    let peak = 0, peakSlip = 0;
    for (let i = 0; i < 120; i++) {
      v.step(DT, ctl(0.3, 1, 0, hand));
      peak = Math.max(peak, Math.abs(v.omega.dot(v.up)));
      peakSlip = Math.max(peakSlip, Math.abs(Math.atan2(v.vel.dot(v.right), Math.abs(v.speed) + 1)));
    }
    // release and let go of the wheel: it has to come back
    for (let i = 0; i < 150; i++) v.step(DT, ctl(0.3, 0, 0, 0));
    const after = Math.abs(v.omega.dot(v.up));
    return { peak, peakSlip, after, flipped: v.flipped, v };
  };
  const grip = yawOf(0), drift = yawOf(1);
  info(`2 s of full lock at 22 m/s — grip: yaw peak ${f(grip.peak, 2)} rad/s, slip ${f(grip.peakSlip * 180 / Math.PI, 0)}°`);
  info(`                            handbrake: yaw peak ${f(drift.peak, 2)} rad/s, slip ${f(drift.peakSlip * 180 / Math.PI, 0)}°, yaw 2.5 s after release ${f(drift.after, 3)} rad/s`);
  ok('handbrake rotates the car harder than grip alone', drift.peak > grip.peak * 1.15,
    `${f(drift.peak / grip.peak)}×`);
  ok('handbrake drifts, it does not pirouette', drift.peak < TUNE.assists.yawRateCap * 1.35,
    `peak ${f(drift.peak, 2)} rad/s vs cap ${TUNE.assists.yawRateCap}`);
  ok('the car recovers once you let go', drift.after < 0.25, `${f(drift.after, 3)} rad/s`);
  ok('handbrake does not tip it over', !drift.flipped);

  // …and the way a player actually uses it: a tap on turn-in
  {
    const v = make('hopper', flat());
    v.vel.set(0, 0, 22);
    for (const w of v.wheels) w.spinVel = 22 / S.wheelR;
    let peak = 0, slipAt = 0;
    for (let i = 0; i < 210; i++) {
      const tap = i < 27 ? 1 : 0;                 // 0.45 s of handbrake on turn-in
      v.step(DT, ctl(i < 27 ? 0.2 : 0.8, i < 100 ? 1 : 0, 0, tap));
      const yr = Math.abs(v.omega.dot(v.up));
      if (yr > peak) { peak = yr; slipAt = Math.abs(Math.atan2(v.vel.dot(v.right), v.speed)); }
    }
    info(`0.45 s handbrake tap on turn-in: peak yaw ${f(peak, 2)} rad/s at ${f(slipAt * 180 / Math.PI, 0)}° slip, exit yaw ${f(Math.abs(v.omega.dot(v.up)), 3)} rad/s at ${f(v.speed)} m/s`);
    ok('a handbrake tap gives a usable rotation and drives out of it',
      peak > 1.0 && Math.abs(v.omega.dot(v.up)) < 1.2 && v.speed > 8,
      `peak ${f(peak, 2)} → exit ${f(Math.abs(v.omega.dot(v.up)), 2)} rad/s`);
  }

  // grip cornering at speed must understeer, never snap-oversteer
  {
    const v = make('hopper', flat());
    v.vel.set(0, 0, 30);
    for (const w of v.wheels) w.spinVel = 30 / S.wheelR;
    let peakSlip = 0, peakYaw = 0;
    for (let i = 0; i < 300; i++) {
      v.step(DT, ctl(i < 120 ? 1 : 0, 1));       // full lock, then lift mid-corner
      peakSlip = Math.max(peakSlip, Math.abs(Math.atan2(v.vel.dot(v.right), Math.abs(v.speed) + 1)));
      peakYaw = Math.max(peakYaw, Math.abs(v.omega.dot(v.up)));
    }
    info(`full lock at 30 m/s with a mid-corner lift: peak slip ${f(peakSlip * 180 / Math.PI, 1)}°, peak yaw ${f(peakYaw, 2)} rad/s`);
    ok('lift-off oversteer stays mild', peakSlip < 0.60,
      `${f(peakSlip * 180 / Math.PI, 1)}° of slip`);
  }

  // the virtual gearbox has to actually visit all five gears on the way up
  {
    const v = make('hopper', flat());
    const seen = new Set(); let dips = 0, last = v.rpmNorm, lo = 1, hi = 0;
    for (let i = 0; i < 900; i++) {
      v.step(DT, ctl(1));
      seen.add(v.gear);
      if (v.rpmNorm < last - 0.06) dips++;
      last = v.rpmNorm;
      if (v.speed > 3) { lo = Math.min(lo, v.rpmNorm); hi = Math.max(hi, v.rpmNorm); }
    }
    info(`gearbox on a full-throttle run: gears used ${[...seen].map(g => g + 1).sort().join(',')}, ${dips} shift drops, rpmNorm ${f(lo)}–${f(hi)}`);
    ok('all five gears are used on a run to top speed', seen.size === 5, `${seen.size} gears`);
    ok('rpm sawtooths rather than ramping once', dips >= 3, `${dips} drops`);
  }

  // airborne pitch authority: throttle raises the nose, brake drops it
  const air = (thr, brk) => {
    const v = make('hopper', flat());
    v.pos.y += 14; v.vel.set(0, 0, 18);
    for (let i = 0; i < 60; i++) v.step(DT, ctl(thr, 0, brk));
    return v.forward.y;
  };
  const nose = air(1, 0), dive = air(0, 1);
  info(`after 1 s of airtime: throttle nose ${f(nose, 3)} vs brake nose ${f(dive, 3)} (forward.y)`);
  ok('air: throttle lifts the nose, brake drops it', nose > dive + 0.10,
    `${f(nose, 3)} > ${f(dive, 3)}`);

  // flipped watchdog
  const v = make('hopper', flat());
  v.quat.setFromAxisAngle({ x: 0, y: 0, z: 1, isVector3: true }, Math.PI);
  v.pos.y += 0.4;
  for (let i = 0; i < 90; i++) v.step(DT, ctl(0));
  info(`upside-down for 1.5 s → up.y ${f(v.up.y)}  flipped=${v.flipped}`);
  ok('flipped watchdog latches when on the roof', v.flipped === true);
}

/* ============================================================
   (j) VISUALS — build, animate, dispose
   ------------------------------------------------------------
   Runs LAST, and only now installs a canvas stub. Everything above must
   survive with no `document` in the process at all: if a headless guard is
   ever dropped, those sections crash instead of being quietly rescued by a
   stub that only exists down here.
   ============================================================ */
head('(j) VISUALS — procedural build + dispose (DOM stubbed)');
{
  const noop = () => { };
  /* createImageData / getImageData hand back a REAL buffer rather than a
     noop's undefined. The procedural texture makers (the tyre dirt, the noise
     fields under it) read their own pixels back, and a stub that cannot do
     that turns "the material builds" into "the material is caught by its own
     guard" — which is a pass that proves nothing. Everything else stays a
     noop: fills and gradients only ever write, and nothing here reads a
     canvas anybody else drew. */
  const imageData = (w, h) => ({ width: w | 0, height: h | 0, data: new Uint8ClampedArray(Math.max(0, (w | 0) * (h | 0) * 4)) });
  const ctx2d = new Proxy({}, {
    get: (_, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop: noop });
      }
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createImageData') return (w, h) => imageData(w, h);
      if (k === 'getImageData') return (x, y, w, h) => imageData(w, h);
      return noop;
    },
  });
  globalThis.document = {
    createElement: (t) => ({ width: 0, height: 0, style: {}, tagName: String(t).toUpperCase(), getContext: () => ctx2d }),
  };

  const scene = new THREE.Scene();
  const terr = flat();
  let totalTris = 0;
  for (const S of VEHICLES) {
    let built = null;
    try {
      const v = new Vehicle(scene, terr, S, { livery: 3 });
      v.placeAt(0, 0, 0);
      let meshes = 0, tris = 0, noShadow = 0;
      v.root.traverse(o => {
        if (!o.isMesh) return;
        meshes++;
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        if (!o.castShadow && o !== v.exhaust) noShadow++;
      });
      for (let i = 0; i < 30; i++) {
        v.step(DT, ctl(1, 0.6, 0, i > 20 ? 1 : 0));
        v.updateVisuals(DT);
      }
      const moved = v.wheels[0].obj.position.lengthSq() > 0 &&
        Math.abs(v.wheels[0].obj.rotation.y) > 1e-4 && v.wheels[0].spin !== 0;
      const leaned = Math.abs(v.chassis.rotation.z) > 1e-5;
      built = { meshes, tris, noShadow, moved, leaned, v };
      totalTris += tris;
    } catch (e) {
      ok(`${S.id}: builds without throwing`, false, e.message);
      continue;
    }
    info(`${S.id.padEnd(10)} ${built.meshes} meshes, ${Math.round(built.tris)} tris, livery ${'#' + built.v.paintColor.toString(16).padStart(6, '0')}`);
    ok(`${S.id}: builds without throwing`, true);
    ok(`${S.id}: everything casts shadow`, built.noShadow === 0, `${built.noShadow} without`);
    ok(`${S.id}: wheels travel, steer and spin`, built.moved);
    ok(`${S.id}: body lean is applied`, built.leaned);
    const before = scene.children.length;
    built.v.dispose();
    ok(`${S.id}: dispose detaches from the scene`, scene.children.length === before - 1);
    ok(`${S.id}: dispose is idempotent`, (built.v.dispose(), true));
  }
  /* ---- the two-wheeler's own contract ----
     The Hornet is a four-corner rigid body drawn as a single-track machine.
     Three things have to hold or it stops being a motorcycle, and none of
     them is visible to any of the gates above. */
  {
    const S = VEHICLE_BY_ID.moto;
    const v = new Vehicle(scene, terr, S, { livery: 1 });
    v.placeAt(0, 0, 0);
    for (let i = 0; i < 8; i++) { v.step(DT, ctl(0.4, 0.8)); v.updateVisuals(DT); }

    // 1. One tyre per axle, on the centreline. Two visible wheels, not four.
    const visible = v.wheels.filter(w => w.obj.visible);
    const offCentre = v.wheels.filter(w => w.obj.visible && Math.abs(w.obj.position.x) > 1e-6);
    ok('moto: exactly two wheels are drawn', visible.length === 2, `${visible.length}`);
    ok('moto: both drawn wheels sit on the centreline', offCentre.length === 0,
      offCentre.map(w => f(w.obj.position.x, 3)).join(',') || 'x = 0');
    ok('moto: the physics hubs keep their real track',
      Math.abs(v.wheels[0].mount.x) > 0.5 && v.wheels[0].mount.x === -v.wheels[1].mount.x,
      `mount.x ±${f(Math.abs(v.wheels[0].mount.x), 2)}`);

    // 2. The fork is a PAIR of legs, offset either side, and it travels.
    const legs = v.wheels.filter(w => w.front && w.arm);
    const legX = legs.map(w => w.hubOff);
    ok('moto: two fork legs, one either side of the wheel',
      legs.length === 2 && legX[0] === -legX[1] && Math.abs(legX[0]) > 0.02,
      `x ±${f(Math.abs(legX[0] || 0), 3)}`);
    ok('moto: exactly one rear shock', v.wheels.filter(w => w.coil).length === 1);

    /* 3. The bank pivots about the CONTACT LINE, not the centre of mass.
       Roll the lean group by 30° and the tyre's bottom must stay on the
       ground; pivot it at the CoM instead and it swings 20 cm sideways and
       lifts, which reads as the bike skating rather than banking. */
    const wheel = visible[0];
    const groundY = -S.comHeight;
    v.leanRoot.rotation.z = 0.52;                 // ~30°
    v.leanRoot.updateMatrixWorld(true);
    const contact = new THREE.Vector3(0, -S.wheelR, 0);
    wheel.obj.localToWorld(contact);
    v.root.worldToLocal(contact);
    const drop = Math.abs(contact.y - groundY);
    const slide = Math.abs(contact.x);
    info(`moto       banked 30°: contact patch moves ${f(slide * 100, 1)} cm across, ${f(drop * 100, 1)} cm up`);
    ok('moto: banking pivots about the contact line, not the CoM',
      drop < 0.06 && slide < 0.06, `Δy ${f(drop, 3)} m, Δx ${f(slide, 3)} m`);
    v.leanRoot.rotation.z = 0;

    // 4. Airborne, the bank decays — a bike frozen at 30° in mid-air is broken.
    v.pos.y += 8;
    for (let i = 0; i < 40; i++) { v.step(DT, ctl(0)); v.updateVisuals(DT); }
    ok('moto: the bank washes out while airborne',
      Math.abs(v.leanRoot.rotation.z) < 0.05, `${f(v.leanRoot.rotation.z, 3)} rad`);
    v.dispose();
  }

  info(`6-car grid would be ~${Math.round(totalTris / 3 * 6)} tris — budget is 450 k in view`);
  ok('6 cars fit the triangle budget', totalTris / 3 * 6 < 120000,
    `${Math.round(totalTris / 3 * 6)} tris`);
  delete globalThis.document;
}

/* ============================================================
   (k) LANDING ON ANYTHING BUT THE TYRES
   ------------------------------------------------------------
   The regression this section exists for: a car that came down inverted used
   to GAIN energy. The suspension probe was a bare vertical measure with no
   idea which way the strut pointed, so four struts aimed at the sky still read
   as fully compressed, fired 28 g a corner along the body's own up axis —
   which by then pointed at the ground — and drove the car into the terrain.
   The floor guard bounced it back, the springs fired again, and a 5 m drop
   came off the ground at 13 m/s and reached 10 m. It looked exactly like a
   car with no weight.

   The gate is ENERGY. Total mechanical energy after touchdown may not exceed
   what the car arrived with, at any attitude, on any vehicle. Everything else
   here — the re-launch count, the settle — is a symptom; this is the disease.
   ============================================================ */
head('(k) LANDING NOT ON THE TYRES — no energy may be created');
{
  /* The invariant the whole hull rests on: with the car on its wheels at FULL
     BUMP, the hull floor is still above the ground. If this fails the hull and
     the suspension fight each other on every hard landing. */
  for (const S of VEHICLES) {
    const v = make(S.id, flat());
    const atFullBump = v.hullClearance - (S.suspTravel - v.sag);
    ok(`${S.id}: hull floor clears full bump`, atFullBump > 0.005,
      `${f(atFullBump * 1000, 1)} mm of daylight at full compression`);
  }

  const energy = (v) => {
    const q = v.quat.clone().invert();
    const wb = v.omega.clone().applyQuaternion(q);
    return 0.5 * v.mass * v.vel.lengthSq() +
      v.mass * G * (v.pos.y - v.terrain.heightAt(v.pos.x, v.pos.z)) +
      0.5 * (v.Ibody.x * wb.x ** 2 + v.Ibody.y * wb.y ** 2 + v.Ibody.z * wb.z ** 2);
  };

  /* 0° is the control: the same drop on the wheels must be unaffected. 90° is
     a door landing, 180° is flat on the roof, and 100° is the one that used to
     be worst — just past the point where a strut can reach the ground. */
  for (const S of VEHICLES) {
    let worstE = 0, worstVy = 0, worstAngle = 0, relaunches = 0, allFinite = true;
    for (const deg of [0, 45, 90, 100, 135, 180]) {
      const v = make(S.id, flat());
      v.pos.y += 6;
      v.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg * Math.PI / 180);
      v.vel.set(0, 0, 15);
      const e0 = energy(v);
      let t = 0, down = false, wasAir = true, peakE = 0, peakVy = 0;
      while (t < 8) {
        v.step(DT, ctl(0)); t += DT;
        if (!finite(v)) { allFinite = false; break; }
        if (!v.airborne) down = true;
        if (down) {
          peakE = Math.max(peakE, energy(v));
          peakVy = Math.max(peakVy, v.vel.y);
          if (!wasAir && v.airborne) relaunches++;
        }
        wasAir = v.airborne;
      }
      const ratio = peakE / e0;
      if (ratio > worstE) { worstE = ratio; worstAngle = deg; }
      worstVy = Math.max(worstVy, peakVy);
    }
    info(`${S.id.padEnd(10)} worst energy after touchdown ${f(worstE, 3)}× (at ${worstAngle}°)   ` +
      `peak upward vy ${f(worstVy)} m/s   re-launches ${relaunches}`);
    ok(`${S.id}: a landing never creates energy`, worstE <= 1.02, `${f(worstE, 3)}×`);
    ok(`${S.id}: the ground does not fire it back up`, worstVy < 3.0, `${f(worstVy)} m/s`);
    ok(`${S.id}: it does not pogo`, relaunches <= 2, `${relaunches} re-launches`);
    ok(`${S.id}: finite through every attitude`, allFinite);
  }

  /* A car at rest on its roof must report !airborne. This is not cosmetic:
     race.js gates BOTH `wedged` and `stuck` recovery on !v.airborne, so while
     a rolled car counted as flying the recovery net could not see it at all
     and only the up.y < 0.25 flip path could ever bring it back. */
  {
    const v = make('hopper', flat());
    v.pos.y += 3;
    v.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    for (let t = 0; t < 5; t += DT) v.step(DT, ctl(0));
    info(`resting after a roof landing: airborne ${v.airborne}, hullDown ${v.hullDown}, ` +
      `|v| ${f(v.vel.length(), 3)}, |ω| ${f(v.omega.length(), 3)}, up.y ${f(v.up.y)}`);
    ok('a car down on its bodywork is not "airborne"', !v.airborne);
    ok('…and it has come to rest, not settled into a bounce',
      v.vel.length() < 0.6 && v.omega.length() < 0.6,
      `|v| ${f(v.vel.length(), 3)}, |ω| ${f(v.omega.length(), 3)}`);
    ok('…so airTime is not still climbing', v.airTime < 0.1, `${f(v.airTime, 2)} s`);
  }

  /* The strut gate itself, as an INVARIANT rather than one probe: over a long
     tumble at every attitude a car can reach, a strut that does not point at
     the ground must never carry load. This is the check that would have caught
     the original bug at its source — four skyward struts reporting 28 g each. */
  {
    let worstBadLoad = 0, samples = 0, gated = 0, minSeen = 1;
    for (const S of VEHICLES) {
      for (const deg of [70, 90, 110, 140, 180]) {
        const v = make(S.id, flat());
        v.pos.y += 4;
        v.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg * Math.PI / 180);
        v.vel.set(0, 0, 18); v.omega.set(0, 0, 2.5);
        for (let t = 0; t < 4; t += DT) {
          v.step(DT, ctl(0));
          for (const w of v.wheels) {
            samples++;
            if (w.align < minSeen) minSeen = w.align;
            if (w.align <= TUNE.susp.minAlign) {
              gated++;
              if (w.load > worstBadLoad) worstBadLoad = w.load;
            }
          }
        }
      }
    }
    info(`${samples} wheel-substeps of tumbling: ${gated} had a strut that cannot ` +
      `reach the ground (align down to ${f(minSeen, 2)}); heaviest load on one ` +
      `${f(worstBadLoad, 1)} N`);
    // The gate is worthless if it never enters the branch, so assert that too.
    ok('the tumble actually drives struts past the align gate', gated > 1000,
      `${gated} gated wheel-substeps`);
    ok('a strut pointing away from the ground never carries load', worstBadLoad < 1,
      `${f(worstBadLoad, 1)} N`);
  }
}

/* ============================================================
   (l) THE ARSENAL ON THE CAR — contracts 8.1 and 8.2
   ------------------------------------------------------------
   Four published numbers that placeAt must wipe, and one method that must
   answer from three different sources without ever throwing or allocating:
   the art's `_muzzle` (an Object3D or a body-space point), the spec's
   `launcher` mount, and the bounding-box fallback a headless car gets.
   ============================================================ */
head('(l) ARSENAL — placeAt wipes the publications; muzzleWorld never fails');
{
  const out = new THREE.Vector3();
  for (const S of VEHICLES) {
    const v = make(S.id, flat());
    v.ammo = 5; v.ammoCap = 12; v.nitroT = 1.1; v.reloadT = 0.4;
    v.placeAt(3, 3, 0.4);
    ok(`${S.id}: placeAt wipes ammo / ammoCap / nitroT / reloadT`,
      v.ammo === 0 && v.ammoCap === 0 && v.nitroT === 0 && v.reloadT === 0,
      `${v.ammo}/${v.ammoCap} nitro ${v.nitroT} reload ${v.reloadT}`);

    // 1. no art, no launcher on the spec (or whatever P2 has authored): the fallback
    v.placeAt(0, 0, 0);
    // `dir`, not `f` — the module's number formatter is called `f`, and shadowing
    // it here made every message in this section throw instead of print.
    const dir = v.muzzleWorld(out);
    const fwd = v.forward;
    const finiteAll = [out.x, out.y, out.z, dir.x, dir.y, dir.z].every(Number.isFinite);
    ok(`${S.id}: muzzleWorld is finite and above the centre of mass`,
      finiteAll && out.y > v.pos.y, `y ${f(out.y)} vs com ${f(v.pos.y)}`);
    ok(`${S.id}: …and points the way the car does`,
      dir.x * fwd.x + dir.z * fwd.z > 0.95 && dir.y >= 0,
      `dot ${f(dir.x * fwd.x + dir.z * fwd.z)}`);

    // 2. a body-space point, the way the art may publish it
    v._muzzle = { x: 0.1, y: 1.0, z: 0.5 };
    v.muzzleWorld(out);
    ok(`${S.id}: a body-space _muzzle lands 1 m over the com`,
      Math.abs(out.y - (v.pos.y + 1.0)) < 0.02, `${f(out.y - v.pos.y)} m`);

    // 3. an Object3D at the tube mouth, pitched up 0.2 rad
    const m = new THREE.Object3D();
    m.position.set(0, 1.2, 0.8); m.rotation.x = -0.2;
    v.root ? v.root.add(m) : m.updateMatrixWorld(true);
    m.updateMatrixWorld(true);
    v._muzzle = m;
    const f3 = v.muzzleWorld(out);
    ok(`${S.id}: an Object3D _muzzle reports its own pitch`, f3.y > 0.15 && f3.y < 0.25,
      `forward.y ${f(f3.y)}`);
    v._muzzle = null;
    v.dispose();
  }
  // never throws on garbage
  const v = make('hopper', flat());
  let threw = false;
  try {
    v._muzzle = { x: NaN };
    v.muzzleWorld(out);
    v._muzzle = 'nonsense';
    v.muzzleWorld(out);
  } catch (e) { threw = true; void e; }
  ok('muzzleWorld never throws on a bad _muzzle', !threw && Number.isFinite(out.x));
}

/* ============================================================
   (m) THE TYRE IS SOLID
   ------------------------------------------------------------
   The regression this exists for: the tyre carcass used to be three
   open-ended cylinders — a tread band and two coning sidewalls — and nothing
   at all closed the bead. From anywhere below the axle line you looked
   straight through the near sidewall, past the rim, and out at the INSIDE of
   the far one. It reads as a hole in the wheel, because it is one.

   The gate is that the tube is a closed surface: every undirected edge shared
   by exactly two triangles. Run on the TUBE ALONE, deliberately — the lugs
   are documented as having no bottom face (they are buried in the tread and
   ten triangles beat twelve, thirty-nine times a wheel), so merging them in
   would report 39 × 4 false boundaries and the gate would have to be turned
   off to pass.

   Runs after (j) because it needs NO document: LatheGeometry is arithmetic.
   ============================================================ */
head('(m) TYRE — the carcass is a closed surface');
{
  for (const S of VEHICLES) {
    const g = tyreTubeGeometry(S.wheelR, S.wheelW);
    const idx = g.index, pos = g.attributes.position;
    /* Weld by position first. A lathe duplicates vertices at both of its
       seams — the last radial column onto the first, and the profile's
       closing point onto its start — because the two need different uvs. A
       seam is a second INDEX for one point, not a hole, and testing raw
       indices would call every closed lathe in three broken. Quantised to
       1e-5 m so float error in the revolve cannot split a welded corner. */
    const canon = new Int32Array(pos.count);
    const seen = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = Math.round(pos.getX(i) * 1e5) + ',' +
        Math.round(pos.getY(i) * 1e5) + ',' + Math.round(pos.getZ(i) * 1e5);
      const hit = seen.get(key);
      if (hit === undefined) { seen.set(key, i); canon[i] = i; } else canon[i] = hit;
    }
    const edges = new Map();
    const tris = idx.count / 3;
    let degenerate = 0;
    for (let t = 0; t < tris; t++) {
      const a = canon[idx.getX(t * 3)], b = canon[idx.getX(t * 3 + 1)], c = canon[idx.getX(t * 3 + 2)];
      if (a === b || b === c || c === a) { degenerate++; continue; }
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const key = p < q ? p + ':' + q : q + ':' + p;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    let open = 0, nonManifold = 0;
    for (const n of edges.values()) {
      if (n === 1) open++; else if (n !== 2) nonManifold++;
    }
    info(`${S.id.padEnd(10)} tube ${tris} tris, ${pos.count} verts → ${seen.size} welded, ${edges.size} edges`);
    ok(`${S.id}: the tyre tube has no open edges`, open === 0, `${open} boundary edge(s)`);
    ok(`${S.id}: …and no edge shared by more than two faces`, nonManifold === 0,
      `${nonManifold} over-shared`);
    ok(`${S.id}: no degenerate triangles in the revolve`, degenerate === 0, `${degenerate}`);
    g.dispose();
  }
}

/* ---------------- verdict ---------------- */
console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('vehicle physics OK');

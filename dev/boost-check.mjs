/* ============================================================
   RALLY ROAD RASH — mini-turbo and the drive multipliers
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/boost-check.mjs

   Two halves, deliberately separate:

     A. The state machine on its own, driven by a stub vehicle. Tier timings,
        the grace window, the decay, the dual slip gate and the spin lockout
        are all arithmetic, and testing them against a real car would mean
        first arranging for a real car to drift on cue — which tests the
        wrong thing and fails for the wrong reasons.

     B. The integration on a real Vehicle. Only three questions matter here:
        does the boost reach the drive path, does it stay out of the way when
        nobody is drifting, and does placeAt() wipe it.

   THE GATE THAT MATTERS MOST is A0/B1: a straight-line, full-throttle,
   no-handbrake run must leave every multiplier at exactly 1.0. That is the
   invariant dev/vehicle-check.mjs's "settles within ±2% of topSpeed" gate
   silently depends on, and without an explicit test here, somebody widening
   the charge gate later would break a terminal-speed assertion in a
   different file and have no idea why.
   ============================================================ */
import { Vehicle } from '../src/game/vehicle.js';
import { VEHICLES, VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { makeDrift, driftStep, driftReset, driftProgress, driftFire } from '../src/game/miniturbo.js';
import { TUNE } from '../src/game/config.js';
import { SURF } from '../src/world/surfaces.js';

const B = TUNE.boost;
const DT = 1 / 60;
let failures = 0, checks = 0;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

/* ---------------- stubs ---------------- */
const flat = () => ({
  heightAt: () => 0,
  normalAt(x, z, e, out) { return out.set(0, 1, 0); },
  surfaceAt: () => SURF.DIRT,
  onRoad: () => 1,
});
const CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };
const ctl = (t = 0, s = 0, b = 0, h = 0) => {
  CTL.throttle = t; CTL.steer = s; CTL.brake = b; CTL.handbrake = h; return CTL;
};
/** A vehicle-shaped object with only the six fields driftStep reads. */
const stub = (slip, speed) => ({
  bodySlip: slip, speed, groundSpeed: speed, contacts: 4,
  airborne: false, spinT: 0,
});

/** Hold a state in a steady slide for `secs`, return the state. */
function slideFor(st, secs, slip, speed, hand) {
  const v = stub(slip, speed);
  const c = ctl(0.5, 1, 0, hand ? 1 : 0);
  for (let t = 0; t < secs; t += DT) driftStep(st, DT, v, c);
  return st;
}

/* ============================================================
   A — the state machine
   ============================================================ */
head('A. STATE MACHINE — charge, tiers, grace, gates');

/* A0. The invariant vehicle-check leans on. */
{
  const st = makeDrift();
  const v = stub(0, 38);
  const c = ctl(1, 0, 0, 0);
  for (let t = 0; t < 26; t += DT) driftStep(st, DT, v, c);
  ok('straight-line full throttle never charges', st.charge === 0 && st.tier === 0);
  ok('…and leaves both multipliers at exactly 1', st.mul === 1 && st.top === 1,
    `mul ${st.mul} top ${st.top}`);
}

/* A1. Tier thresholds. Charge rate is speed- and slip-scaled, so the test
   drives a SATURATED slide, where the rate is exactly 1 s of charge per
   second and the thresholds are the literal numbers in TUNE.boost.tier. */
{
  const st = makeDrift();
  const v = stub(B.slipFull + 0.1, B.fullSpeed + 5);
  const c = ctl(0.5, 1, 0, 1);
  let t = 0;
  const hit = [0, 0, 0];
  while (t < 5) {
    driftStep(st, DT, v, c);
    t += DT;
    if (st.tierUp) hit[st.tier - 1] = t;
  }
  info(`saturated slide: tiers at ${hit.map(x => f(x)).join(' / ')} s ` +
    `(spec ${B.tier.join(' / ')})`);
  for (let i = 0; i < 3; i++) {
    /* Tolerance is two frames OR 5%, whichever is looser: the tiers are
       small enough that 5% of tier 1 is less than a single 16 ms step. */
    const tol = Math.max(B.tier[i] * 0.05, 2 * DT);
    ok(`tier ${i + 1} lands within ${f(tol, 3)} s of ${B.tier[i]}`,
      Math.abs(hit[i] - B.tier[i]) <= tol, `${f(hit[i], 3)} s`);
  }
  ok('tier stops at 3', st.tier === 3, `${st.tier}`);
}

/* A2. A tentative slide is slower than a committed one — the reason tier 3
   is something you aim for rather than something that happens. */
{
  const a = slideFor(makeDrift(), 1.0, B.slipHand + 0.02, B.minSpeed + 1, true);
  const b = slideFor(makeDrift(), 1.0, B.slipFull, B.fullSpeed, true);
  info(`1 s of drift: tentative ${f(a.charge)} vs committed ${f(b.charge)}`);
  ok('a committed slide charges faster', b.charge > a.charge * 1.6,
    `${f(b.charge / Math.max(1e-6, a.charge))}x`);
}

/* A3. The grace window. */
{
  const st = slideFor(makeDrift(), 1.0, B.slipFull, B.fullSpeed, true);
  const held = st.charge;
  /* Handbrake STAYS DOWN through the lapse — that is the case grace exists
     for: catching the car mid-chicane without losing the tier. */
  const v = stub(0, 25), c = ctl(1, 0, 0, 1);
  for (let t = 0; t < B.grace * 0.8; t += DT) driftStep(st, DT, v, c);
  ok('a lapse inside the grace window keeps the charge',
    Math.abs(st.charge - held) < 1e-6, `${f(st.charge)} vs ${f(held)}`);
  ok('…and does not fire the boost early', st.fireT === 0);
  for (let t = 0; t < 0.6; t += DT) driftStep(st, DT, v, c);
  ok('…but past the window it fires and the charge is spent',
    st.fired === 0 && st.charge === 0, `charge ${f(st.charge)}`);
}

/* A4. Release fires, and the boost expires on its own clock. */
{
  const st = slideFor(makeDrift(), (B.tier[1] + B.tier[2]) * 0.5, B.slipFull, B.fullSpeed, true);
  ok('tier 2 banked before release', st.tier === 2, `tier ${st.tier}`);
  const v = stub(0, 30), c = ctl(1, 0, 0, 0);
  driftStep(st, DT, v, c);          // handbrake DOWN→UP: the release edge
  info(`fired tier ${st.fireTier}: mul ${f(st.mul)} top ${f(st.top)} for ${f(st.fireT)} s`);
  ok('releasing fires the banked tier', st.fireTier === 2, `tier ${st.fireTier}`);
  ok('mul and top match the table',
    st.mul === B.fireMul[1] && st.top === B.fireTop[1]);
  ok('the charge is spent', st.charge === 0 && st.tier === 0);
  let t = 0;
  while (st.fireT > 0 && t < 6) { driftStep(st, DT, v, c); t += DT; }
  info(`boost ran ${f(t)} s (spec ${B.fireT[1]})`);
  ok('the boost expires and hands the multipliers back',
    st.mul === 1 && st.top === 1 && st.fireT === 0);
  ok('…on schedule', Math.abs(t - B.fireT[1]) < 0.1, `${f(t)} s`);
}

/* A5. Chained tier-1s must not stack into something untested. */
{
  const st = makeDrift();
  const v = stub(0, 30), cOff = ctl(1, 0, 0, 0);
  let peak = 0;
  for (let n = 0; n < 4; n++) {
    slideFor(st, B.tier[0] + 0.1, B.slipFull, B.fullSpeed, true);
    for (let t = 0; t < 0.2; t += DT) { driftStep(st, DT, v, cOff); peak = Math.max(peak, st.mul); }
  }
  info(`four chained tier-1 fires: peak mul ${f(peak)} (single tier-1 is ${B.fireMul[0]})`);
  ok('chained boosts take the better, never the sum', peak <= B.fireMul[2] + 1e-9,
    `${f(peak)}`);
}

/* A6. The dual slip gate — the whole reason the AI has this feature. */
{
  const mid = (B.slipHand + B.slipFree) * 0.5;
  const withHand = slideFor(makeDrift(), 1.0, mid, B.fullSpeed, true);
  const without = slideFor(makeDrift(), 1.0, mid, B.fullSpeed, false);
  info(`${f(mid, 3)} rad of slip: handbrake charges ${f(withHand.charge)}, free ${f(without.charge)}`);
  ok('a modest slide charges WITH the handbrake', withHand.charge > 0.5);
  ok('…and not without it', without.charge === 0);
  const big = slideFor(makeDrift(), 1.0, B.slipFree + 0.12, B.fullSpeed, false);
  ok('a genuine throttle slide charges with no handbrake at all', big.charge > 0.4,
    `${f(big.charge)} — this is how ai.js earns a mini-turbo`);
}

/* A7. Airborne is not a drift, and a spin cannot be farmed. */
{
  const st = makeDrift();
  const air = stub(1.0, 30); air.airborne = true; air.contacts = 0;
  for (let t = 0; t < 2; t += DT) driftStep(st, DT, air, ctl(1, 1, 0, 1));
  ok('a sideways car in mid-air charges nothing', st.charge === 0);

  const st2 = makeDrift();
  const spun = stub(1.0, 25); spun.spinT = 1.0;
  for (let t = 0; t < 0.4; t += DT) driftStep(st2, DT, spun, ctl(0, 0, 0, 1));
  ok('the first moments of a spin-out charge nothing', st2.charge === 0);
  spun.spinT = B.spinLockout * 0.5;
  for (let t = 0; t < 0.5; t += DT) driftStep(st2, DT, spun, ctl(0, 0, 0, 1));
  ok('…but the tail of the recovery does pay', st2.charge > 0.2, `${f(st2.charge)}`);
}

/* A8. Housekeeping. */
{
  const st = slideFor(makeDrift(), 2.0, B.slipFull, B.fullSpeed, true);
  const p = driftProgress(st);
  ok('driftProgress is 0..1', p >= 0 && p <= 1, `${f(p)}`);
  driftReset(st);
  ok('driftReset wipes every field',
    st.charge === 0 && st.tier === 0 && st.fireT === 0 && st.mul === 1 &&
    st.top === 1 && st.active === 0 && st.slack === 0);
  const keys = Object.keys(makeDrift()).length;
  ok('the state object has a fixed shape', Object.keys(st).length === keys,
    `${Object.keys(st).length} fields`);
}

/* A9. driftFire — the door the air knocks on.
   A landed trick pays a mini-turbo tier through this rather than through a
   boost path of its own (ARCHITECTURE §6.5), which means every rule the
   drift release already obeys has to survive the second caller. */
{
  const st = makeDrift();
  driftFire(st, 2);
  info(`driftFire(2) on a cold state: mul ${f(st.mul)} top ${f(st.top)} for ${f(st.fireT)} s`);
  ok('driftFire fires the tier it is handed',
    st.fireTier === 2 && st.mul === B.fireMul[1] && st.top === B.fireTop[1] &&
    st.fireT === B.fireT[1]);
  ok('…and publishes the one-shot RaceFX.boost reads', st.fired === 2, `${st.fired}`);

  /* Better of, never the sum — the same rule a chained release obeys. A
     tier-1 trick landed into a running tier-3 must not extend it. */
  const big = makeDrift();
  driftFire(big, 3);
  const wasT = big.fireT;
  driftFire(big, 1);
  ok('a smaller tier does not shorten or weaken a running boost',
    big.fireTier === 3 && big.fireT === wasT && big.mul === B.fireMul[2],
    `tier ${big.fireTier} mul ${f(big.mul)}`);
  const small = makeDrift();
  driftFire(small, 1);
  driftFire(small, 3);
  ok('…and a bigger one upgrades it rather than adding to it',
    small.fireTier === 3 && small.fireT === B.fireT[2] && small.mul === B.fireMul[2],
    `${f(small.fireT)} s at ×${f(small.mul)}`);

  /* Tier 0 is the common case: BIG AIR scores points and no boost, and a
     CRASH scores neither. Callers must be able to pass a raw trick tier. */
  const none = makeDrift();
  driftFire(none, 0); driftFire(none, -1);
  ok('tier 0 (BIG AIR) and a negative are no-ops',
    none.mul === 1 && none.top === 1 && none.fireT === 0 && none.fired === 0);

  /* A release this same frame must not be swallowed: driftStep sets `fired`
     for its own cue, and vehicle.js calls driftFire immediately after it. */
  const both = makeDrift();
  both.fired = 3;
  driftFire(both, 1);
  ok('a trick tier never overwrites a bigger release cue in the same frame',
    both.fired === 3, `${both.fired}`);

  const keys = Object.keys(makeDrift()).length;
  const probe = makeDrift();
  driftFire(probe, 3);
  ok('driftFire adds no fields to the state', Object.keys(probe).length === keys,
    `${Object.keys(probe).length} of ${keys}`);
}

/* ============================================================
   B — the real Vehicle
   ============================================================ */
head('B. INTEGRATION — the drive path, on a real car');

function make(id) {
  const v = new Vehicle(null, flat(), VEHICLE_BY_ID[id], { headless: true });
  v.placeAt(0, 0, 0);
  return v;
}

/* B1. The same invariant, end to end. */
{
  for (const S of VEHICLES) {
    const v = make(S.id);
    let lo = 1e9, hi = -1e9;
    for (let t = 0; t < 26; t += DT) v.step(DT, ctl(1));
    for (let i = 0; i < 240; i++) {
      v.step(DT, ctl(1));
      lo = Math.min(lo, v.speed); hi = Math.max(hi, v.speed);
    }
    const band = Math.max(Math.abs(lo - S.topSpeed), Math.abs(hi - S.topSpeed)) / S.topSpeed * 100;
    ok(`${S.id}: a straight-line run leaves the multipliers at 1`,
      v.driveMul === 1 && v.driveTopMul === 1, `${v.driveMul} / ${v.driveTopMul}`);
    ok(`${S.id}: terminal speed still inside ±2%`, band < 2, `±${f(band, 2)}%`);
  }
}

/* B2. The multipliers reach the drive path — the thing the whole feature
   depends on. Driven through ext* rather than by arranging a real drift,
   because this is a test of the FORCE PATH, not of the state machine. */
{
  for (const S of VEHICLES) {
    const v = make(S.id);
    for (let t = 0; t < 26; t += DT) v.step(DT, ctl(1));
    const base = v.speed;
    v.extDriveMul = B.fireMul[2];
    v.extTopMul = B.fireTop[2];
    for (let t = 0; t < 14; t += DT) v.step(DT, ctl(1));
    const boosted = v.speed;
    const gain = (boosted / base - 1) * 100;
    info(`${S.id.padEnd(10)} ${f(base)} → ${f(boosted)} m/s under a tier-3 boost (+${f(gain, 1)}%)`);
    /* Aero fights back, hard: drag rises with the square of speed, so a
       +13% ceiling never yields +13% of speed. The window is wide on purpose
       — what is being asserted is that the boost REACHES the drive path and
       is bounded, not a precise number. */
    ok(`${S.id}: a tier-3 boost gains 5–16%`, gain > 5 && gain < 16, `+${f(gain, 1)}%`);
    v.extDriveMul = 1; v.extTopMul = 1;
    for (let t = 0; t < 14; t += DT) v.step(DT, ctl(1));
    ok(`${S.id}: and it comes back down`, Math.abs(v.speed - base) / base < 0.03,
      `${f(v.speed)} vs ${f(base)}`);
  }
}

/* B3. Spin-out. */
{
  const S = VEHICLE_BY_ID.hopper;
  const v = make('hopper');
  v.vel.set(0, 0, 26);
  for (const w of v.wheels) w.spinVel = 26 / S.wheelR;
  v.spinT = 1.2;
  v.omega.y += 3.2;
  let peakYaw = 0, spun = 0, t = 0;
  for (; t < 1.2; t += DT) {
    v.step(DT, ctl(1, 0));                    // player still flat out: must be ignored
    // The 3.2 rad/s kick is deliberately ABOVE yawRateCap so the always-on
    // cap bleeds it — measure the peak only after it has had time to.
    if (t > 0.3) peakYaw = Math.max(peakYaw, Math.abs(v.omega.dot(v.up)));
    spun += Math.abs(v.omega.dot(v.up)) * DT;
  }
  info(`spin-out: peak yaw ${f(peakYaw, 2)} rad/s, ${f(spun * 57.3, 0)}° turned, ` +
    `handbrake forced ${v._ctlHand === 1}`);
  ok('a spin-out forces the handbrake path', v._ctlHand === 1);
  ok('…and ignores the throttle', v._ctlThr === 0);
  /* The 3.2 rad/s kick is deliberately ABOVE yawRateCap: the point is that
     the always-on cap bleeds it back rather than that it never exceeds it.
     What must be true is that a spin ENDS. */
  let lateYaw = 0;
  for (let k = 0; k < 60; k++) { v.step(DT, ctl(1, 0)); lateYaw = Math.abs(v.omega.dot(v.up)); }
  ok('the yaw cap bleeds the spin back under itself',
    lateYaw < TUNE.assists.yawRateCap, `${f(lateYaw, 2)} vs cap ${TUNE.assists.yawRateCap}`);
  ok('the spin expires', v.spinT === 0, `${f(v.spinT, 3)}`);
  for (let i = 0; i < 60; i++) v.step(DT, ctl(1, 0));
  ok('and control comes back', v._ctlThr === 1);
}

/* B4. Airborne deferral — the Caldera Leap case. */
{
  const v = make('hopper');
  v.pos.y += 12;
  v.spinT = 1.0;
  const before = v.spinT;
  for (let i = 0; i < 30; i++) v.step(DT, ctl(0));
  /* One frame of slack: `airborne` is written during _substep, so the very
     first step after a launch still reads last frame's value. A 16 ms lag on
     a 1 s timer is not worth a branch. */
  ok('a spin-out does not tick down in mid-air', v.spinT > before - 3 * DT,
    `${f(v.spinT, 3)} of ${before} — being hit at the apex must not cost the landing`);
  ok('…and the throttle still answers', v.airborne);
}

/* B5. placeAt is the reset path every respawn goes through. */
{
  const v = make('redline');
  v.extDriveMul = 1.9; v.extTopMul = 1.13; v.spinT = 0.8;
  slideFor(v._drift, 2.0, B.slipFull, B.fullSpeed, true);
  v.placeAt(10, 10, 1);
  ok('placeAt zeroes every boost field',
    v.driveMul === 1 && v.driveTopMul === 1 && v.extDriveMul === 1 &&
    v.extTopMul === 1 && v.spinT === 0 && v._drift.charge === 0 && v._drift.tier === 0);
}

/* B6. bodySlip is published, and is the number the machine reads. */
{
  const S = VEHICLE_BY_ID.hopper;
  const v = make('hopper');
  v.vel.set(0, 0, 24);
  for (const w of v.wheels) w.spinVel = 24 / S.wheelR;
  /* 0.7 s of handbrake, then catch it. Measured, this is very close to the
     most a single application can earn before slipMax decides you are
     spinning rather than drifting — so it should bank a real tier. */
  let peak = 0;
  for (let i = 0; i < 42; i++) {
    v.step(DT, ctl(0.5, 1, 0, 1));
    peak = Math.max(peak, Math.abs(v.bodySlip));
  }
  const banked = v._drift.tier;
  v.step(DT, ctl(0.9, 0, 0, 0));            // release: the fire edge
  info(`0.7 s handbrake at 24 m/s: peak slip ${f(peak * 57.3, 0)}°, banked tier ${banked}, ` +
    `fired tier ${v._drift.fireTier}, mul ${f(v._drift.mul)}`);
  ok('bodySlip is published and non-trivial', peak > B.slipHand,
    `${f(peak, 3)} rad`);
  ok('a real handbrake drift banks a real tier', banked >= 1, `tier ${banked}`);
  /* The release is armed, not instant: the car is still 60° crossed up on
     the frame the handbrake comes off, and the boost lands once it settles. */
  let fireAt = 0;
  for (let i = 0; i < 180 && v._drift.fireTier === 0; i++) { v.step(DT, ctl(0.9, 0, 0, 0)); fireAt += DT; }
  ok('…and the armed release fires once the car settles',
    v._drift.fireTier >= 1 && v._drift.mul > 1,
    `tier ${v._drift.fireTier} after ${f(fireAt)} s, mul ${f(v._drift.mul)}`);
}

/* ---------------- verdict ---------------- */
console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('mini-turbo OK');

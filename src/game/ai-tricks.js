/* ============================================================
   RALLY ROAD RASH — THE AI's CANNED AIR TRICKS
   ------------------------------------------------------------
   Split out of ai.js because it answers a different question from the
   driver: ai.js answers "where should this car be", this file answers "is
   this jump big enough to do something stupid on, and when do I let go".
   It moved here unchanged from ai-items.js in wave 8, when the item brain
   became ai-weapons.js — the two halves of that file never shared a line.

   PURE-ish: reads `predictAirTime` from tricks.js if that module exists.
   No three, no DOM, no allocation after load. Every random draw goes
   through `d.rng`, never Math.random: two identical seeds must produce
   identical races or the QA sweep cannot compare builds.
   ============================================================ */

import { TUNE } from './config.js';

/* ---------------------------------------------------------------
   P4's tricks.js may not exist yet. A static import would take the whole
   AI down with it, and there is no synchronous "does this module exist"
   in ESM, so: a local implementation of the contract, replaced by the real
   one at module-evaluation time if the file is there. Top-level await
   rather than a `.then()` on purpose — a promise that resolves later would
   leave `dev/ai-check.mjs` measuring the fallback while the game ran P4's,
   which is the exact "passes the check, wrong in the game" failure the
   wave-6 contract note warns about.

   This only covers the PREDICTOR. Whether a canned trick happens at all is
   gated separately, in ai.js, on the vehicle publishing `_trick` (contract
   6.4) — that accumulator is the release rule's only feedback, and without
   it the alternative is the open-loop hold P4 measured landing one jump in
   ten. No `_trick`, no trick.
   --------------------------------------------------------------- */

/**
 * Time to ground for a ballistic launch, per contract 6.3.
 * `hang` is the fraction of G that applies while genuinely airborne
 * (TUNE.air.hangGravity, faded in over hangLo..hangHi — callers pass a
 * slightly conservative number because the fade costs the first fraction
 * of a second). `dropM` is how much LOWER the landing is than the lip.
 */
function fallbackAirTime(vy, dropM, g, hang) {
  const G = g * (hang > 0 ? hang : 1);
  const d = dropM > 0 ? dropM : 0;
  const disc = vy * vy + 2 * G * d;
  if (!(disc > 0) || !(G > 0)) return 0;
  const t = (vy + Math.sqrt(disc)) / G;
  return t > 0 ? t : 0;
}

let _airTimeImpl = fallbackAirTime;
let _tricksLoaded = false;
try {
  const m = await import('./tricks.js');
  if (m && typeof m.predictAirTime === 'function') {
    _airTimeImpl = m.predictAirTime;
    _tricksLoaded = true;
  }
} catch (e) {
  /* Not in this worktree yet. The fallback above IS the contract. */
  void e;
}

/** True if P4's tricks.js supplied the real predictor. Reported by dev checks. */
export const TRICKS_AVAILABLE = _tricksLoaded;

export function predictAirTime(vy, dropM, g, hang) {
  return _airTimeImpl(vy, dropM, g, hang);
}

/* ============================================================
   CANNED AIR TRICKS
   ------------------------------------------------------------
   The AI cannot improvise a flip: it has no model of its own attitude and
   P4's pitch authority is strong enough that "hold some throttle and hope"
   loops the car onto its roof. So it commits to a whole trick at the lip
   and then releases on a PREDICTED FINISH.

   WHY NOT A TIMED HOLD. The first version of this held one input for a
   fraction of the predicted hang time. P4 measured it over ten
   representative jumps and it landed 1 of 10 upright; a flat 0.36·tAir
   landed 2 of 10. The reason is that the rotation a jump needs is FIXED —
   one turn — but the pitch rate the car leaves the lip with is not, and it
   does not correlate usefully with hang time. So a clock is measuring the
   wrong thing. Releasing when the rotation is predicted to ARRIVE lands 10
   of 10 (P4's trick-check B6).

   THE PREDICTION. Airborne rotation decays at TUNE.air.damp, so from a
   current rate `w` with `tG` seconds of flight left the car will turn a
   further w·(1 − e^(−k·tG))/k. Add what it has already turned; release the
   moment that reaches the target. The target is just UNDER a full turn
   (275° flip / 290° barrel) because the align assist finishes the last of
   it — and the hands-off tail is when that assist runs, which is why the
   release is what makes the trick land rather than what ends it.

   The plan is made ONCE per jump. Re-deciding mid-air would produce a car
   that visibly changes its mind, which reads as a bug rather than a stunt.
   ============================================================ */
export const TRICK_PLAN = { NONE: 0, BACKFLIP: 1, BARREL: 2 };

const DEG = Math.PI / 180;
const HERO_GAP = 0;           // any gap jump is a hero jump
const HERO_H = 1.8;           // m of lip height that also counts as one
const TRICK_P_BASE = 0.25, TRICK_P_SKILL = 0.60;
const TRICK_MIN_AIR = 1.3;    // s of predicted hang below which nothing is tried
const BARREL_AGGR = 0.6;      // aggression above which the barrel is preferred
const TRICK_ABORT_TG = 0.45;  // s to ground below which we bail out and land
const TRICK_BACKSTOP = 1.4;   // s — release regardless, if the predictor is wrong
const TARGET_FLIP = 275 * DEG;
const TARGET_BARREL = 290 * DEG;
const RATE_SMOOTH = 0.35;     // per frame, on the measured rotation rate
const DAMP_FALLBACK = 0.55;   // if TUNE.air.damp has not landed yet

/** Rolled at lip commit, before the car has left the ground. */
export function rollTrickIntent(d, jump) {
  if (!jump) return false;
  if (!(jump.gap > HERO_GAP || jump.h >= HERO_H)) return false;
  return d.rng() < TRICK_P_BASE + TRICK_P_SKILL * d.skill;
}

/**
 * First airborne frame: commit to a trick, or to nothing.
 * @param trick  the vehicle's published `_trick` state, for the rotation
 *               this flight has already accumulated. Without it there is no
 *               closed loop and the caller must not plan at all.
 */
export function planAirTrick(d, tAir, trick) {
  d.trickPlan = TRICK_PLAN.NONE;
  d.trickTarget = 0;
  d.trickDir = 0;
  d._spunLast = 0;
  d._spinRate = 0;
  if (!(tAir >= TRICK_MIN_AIR)) return TRICK_PLAN.NONE;
  if (d.aggression > BARREL_AGGR) {
    d.trickPlan = TRICK_PLAN.BARREL;
    d.trickTarget = TARGET_BARREL;
    d.trickDir = d.rng() < 0.5 ? -1 : 1;
  } else {
    d.trickPlan = TRICK_PLAN.BACKFLIP;
    d.trickTarget = TARGET_FLIP;
  }
  const s0 = trick ? (d.trickPlan === TRICK_PLAN.BARREL ? trick.roll : trick.pitch) : 0;
  d._spunLast = s0 < 0 ? -s0 : s0;
  return d.trickPlan;
}

/**
 * One airborne frame of a committed trick. Writes `ctl` in place and
 * returns true if it did; false means "released, or aborted" and the caller
 * keeps the hands-off default for the rest of the flight.
 *
 * @param spun  radians turned so far on the trick's own axis (`_trick.pitch`
 *              for a flip, `_trick.roll` for a barrel) — signed; we care
 *              about magnitude, and a barrel can go either way
 * @param tG    live estimate of seconds to the ground
 */
export function stepAirTrick(d, ctl, dt, airTime, spun, tG) {
  if (d.trickPlan === TRICK_PLAN.NONE) return false;

  const s = spun < 0 ? -spun : spun;
  /* Smoothed, because the raw per-frame difference of an accumulated angle
     is noisy enough at 60 Hz to fire the release a whole turn early. */
  const inst = dt > 1e-6 ? (s - d._spunLast) / dt : 0;
  d._spinRate += (inst - d._spinRate) * RATE_SMOOTH;
  d._spunLast = s;

  const k = (TUNE.air && TUNE.air.damp > 0) ? TUNE.air.damp : DAMP_FALLBACK;
  const willTurn = d._spinRate * (1 - Math.exp(-k * tG)) / k;
  if (s + willTurn >= d.trickTarget || airTime >= TRICK_BACKSTOP || tG < TRICK_ABORT_TG) {
    d.trickPlan = TRICK_PLAN.NONE;
    return false;
  }

  if (d.trickPlan === TRICK_PLAN.BACKFLIP) {
    // Throttle lifts the nose (TUNE.air.pitchAuthority). Nothing else.
    ctl.throttle = 1; ctl.steer = 0; ctl.brake = 0; ctl.handbrake = 0; ctl.roll = 0;
  } else {
    /* Contract 6.10: the handbrake HELD WHILE AIRBORNE is the trick
       modifier — steer rolls instead of yawing. Driving the barrel through
       that path rather than through `ctl.roll` means the two roll inputs
       can never stack into a rate the align assist cannot recover from. */
    ctl.throttle = 0; ctl.brake = 0; ctl.handbrake = 1;
    ctl.steer = d.trickDir; ctl.roll = 0;
  }
  return true;
}

/** Everything a respawn has to forget. */
export function clearAirTrick(d) {
  d.trickPlan = TRICK_PLAN.NONE;
  d.trickTarget = 0;
  d.trickDir = 0;
  d._spunLast = 0;
  d._spinRate = 0;
  d.trickIntent = false;
  d._trickJump = null;
  d._airPlanned = false;
  d._airWas = false;
  d._airVy = 0;
  d._airLandY = 0;
}

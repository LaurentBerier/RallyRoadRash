/* ============================================================
   RALLY ROAD RASH — THE AI's ITEM BRAIN, AND ITS CANNED AIR TRICKS
   ------------------------------------------------------------
   Split out of ai.js because the two halves answer different questions.
   ai.js answers "where should this car be"; this file answers "is now the
   moment to spend what I am holding", and "is this jump big enough to do
   something stupid on".

   PURE-ish: it reads `ITEM`/`ITEMS` from items.js (read-only — P6 owns that
   table's copy fields) and `predictAirTime` from tricks.js if that module
   exists yet. No three, no DOM, no allocation after load. Every random draw
   goes through `d.rng`, never Math.random: two identical seeds must produce
   identical races or the QA sweep cannot compare builds.

   WHY THE OLD `_decideFire` MISSED
   -------------------------------
   It asked one question — "is `_shotAhead` finite" — and `_shotAhead` was
   only ever written DOWNWARD by the rival scan and never reset. One car
   passing close by on lap one therefore latched a target distance that
   stayed finite for the rest of the race, so every subsequent shot was
   taken at a car that had long since gone. Two things fix it: ai.js now
   clears the shot fields at the top of every scan, and the decision below
   is a lead-aim solution rather than a boolean.

   THE LEAD-AIM SOLUTION
   ---------------------
   A spare wheel leaves the car at `ITEMS[WHEEL].speed` m/s ON TOP of the
   firer's own velocity (itemworld.js: `pVX = v.vel.x + f.x * speed * dir`),
   so along my forward axis it closes on a rival at

       forward:  34 + (spd - theirFwd)      rearward:  34 - (spd - theirFwd)

   and it carries my lateral velocity, i.e. none relative to me. So the
   rival's own lateral drift is the whole of the miss:

       t = fl / max(8, rel)          m = ll + theirLat * t

   The `max(8, …)` floor is not cosmetic. Fired backwards while flat out,
   `34 - spd` can go to zero or negative — the wheel is then travelling
   forwards in world space and will never reach a car behind. Flooring the
   closing rate makes `t` finite and large, which makes `m` large, which
   makes the gate refuse the shot. That is the correct answer arrived at
   without a special case.
   ============================================================ */

import { ITEM, ITEMS } from './items.js';
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

/* ---------------------------------------------------------------
   How eager a driver is with a power-up, evaluated `hz` times a second.
   `base` is the floor everyone has; `aggression` is the personality dial
   makeGridProfiles already assigns and which is deliberately uncorrelated
   with skill — "a slow driver who will not move over is the most memorable
   car on the grid" applies just as well to one who will not stop throwing
   things at you.
   --------------------------------------------------------------- */
export const AI_ITEM = {
  hz: 4,               // decisions per second
  boost: 0.35, boostSkill: 0.50,   // p on a straight, at speed
  shoot: 0.30, shootSkill: 0.60,   // p with a rival lined up
  drop: 0.50,                      // p with somebody close behind, or a corner
  special: 1.0,                    // sled and storm: no reason to wait
  /* RECORD gate, not an aim gate. The rival scan keeps the nearest car
     inside this lateral band so the lead-aim solution has something to
     work with; whether the shot is on is then decided by `aimOk`, which
     is the only place a miss distance is computed. Widening this beyond
     the old 3.5 m is what lets the AI decline a shot at a car that is on
     the road but not on the line — before, "recorded" and "lined up" were
     the same test and the AI fired at anything vaguely in front. */
  latGate: 8.0,
  aheadMin: 2, aheadMax: 46,       // m — the window a forward shot considers
  behindMin: 2, behindMax: 44,     // m — and a rearward one
};

/* ---------------- the spare-wheel firing solution ---------------- */
const WHEEL_V = ITEMS[ITEM.WHEEL].speed;   // 34 m/s muzzle speed, relative
const WHEEL_MIN = 6, WHEEL_MAX = 40;       // m — the useful distance band
const AIM_BASE = 1.6;                      // m of miss tolerated at zero range
const AIM_PER_M = 0.04;                    // …growing this much per metre
const REL_FLOOR = 8;                       // m/s — see the header
const STRAIGHT_K = 0.010;                  // 1/m — above this the wheel leaves
                                           //   the corridor before it arrives

/* ---------------- the rest of the roster ---------------- */
const NITRO_K = 0.008;        // 1/m — a boost into a corner is a boost at a wall
const NITRO_DRIVE = 1.05;     // never stack on a mini-turbo (v.driveMul composes
                              //   drift × ext, so >1.05 means one is running)
const NITRO_AHEAD = 25;       // m — somebody worth chasing down
const NITRO_BEHIND_S = 2.0;   // s adrift of the leader — somebody worth catching
const NITRO_IDLE = 0.30;      // p scale with neither reason: hold, mostly
const TRIPLE_GAP = 0.5;       // s between charges of a triple

const SLICK_NEAR = 3, SLICK_FAR = 18;   // m behind — the defensive window
const SLICK_LAT = 2.5;                  // m — …and how close to my line
const SLICK_CORNER_K = 0.012;           // 1/m — a corner entry is worth oiling
const SLICK_HOLD = 12;                  // s — stop hoarding after this

const STORM_MIN_POS = 4;      // matches ITEM_TUNE.stormMinPos
const STORM_GAP_S = 8;        // s — the car ahead has to be catchable

const LEADER_POS = 2;         // P1/P2 hold their defence…
const LEADER_HOLD = 15;       // s …until this old, or until threatened
const LEAD_THREAT_M = 26;     // m behind — close enough to count as a threat

const HOLD_ESCAPE = 20;       // s — nothing is ever held longer than this

/* ---------------- personality ---------------- */
export const ITEM_STYLE = { SNIPER: 'sniper', SPAMMER: 'spammer', TURTLE: 'turtle' };

/* Sniper waits for the shot and takes it clean; spammer throws early and
   often; turtle sits on defence. Consistency is tested FIRST because it is
   the axis that correlates with skill — a fast, tidy driver should read as
   deliberate, not as trigger-happy, even when they are also aggressive. */
export function itemStyleFor(p) {
  if (!p) return ITEM_STYLE.TURTLE;
  if (p.consistency > 0.7) return ITEM_STYLE.SNIPER;
  if (p.aggression > 0.7) return ITEM_STYLE.SPAMMER;
  return ITEM_STYLE.TURTLE;
}

const AIM_SCALE = { sniper: 0.75, spammer: 1.30, turtle: 1.00 };
const P_SCALE = { sniper: 1.00, spammer: 1.25, turtle: 0.85 };
const HOLD_SCALE = { sniper: 1.00, spammer: 0.60, turtle: 1.40 };

/* ============================================================
   AIMING
   ============================================================ */
const abs = Math.abs;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Curvature of the route under the driver, or 0 if the index is not live. */
function localK(d) {
  const R = d.route, i = d.ri;
  if (!R || !R.pts || i < 0 || i >= R.n) return 0;
  const k = R.pts[i].k;
  return k < 0 ? -k : (k || 0);
}

/**
 * Is a spare wheel fired NOW going to arrive where the target will be?
 * Exported so ai.js can re-run it on the frame `wantsFire` is actually
 * polled — a decision taken up to 1/hz seconds ago is a decision taken
 * against a geometry that has since moved, and firing on a stale one is
 * the same class of bug as the latch it replaces.
 */
export function aimOk(d, back, k) {
  if (k >= STRAIGHT_K) return false;
  const fl = back ? d._shotBehind : d._shotAhead;
  if (!(fl >= WHEEL_MIN && fl <= WHEEL_MAX)) return false;
  const ll = back ? d._shotLatB : d._shotLat;
  const closing = back ? d._shotClosingB : d._shotClosing;   // spd − theirFwd
  const theirLat = back ? d._shotTheirLatB : d._shotTheirLat;
  const rel = back ? (WHEEL_V - closing) : (WHEEL_V + closing);
  const t = fl / (rel > REL_FLOOR ? rel : REL_FLOOR);
  const miss = abs(ll + theirLat * t);
  const win = (AIM_BASE + AIM_PER_M * fl) * (AIM_SCALE[d.itemStyle] || 1);
  return miss < win;
}

/* ============================================================
   THE DECISION
   ------------------------------------------------------------
   Sets the latch and nothing else. This function must never touch `ctl`,
   the steering state or the offset — ai.js's item block is write-only to
   `wantsFire`/`fireBack` for exactly that reason.

   `ctx.items` is optional throughout. Without it TOW simply never fires,
   which is what makes the whole path inert under dev/ai-check.mjs's bare
   `{ state, vehicles }` context.
   ============================================================ */
export function decideFire(d, item, spd, ctx) {
  if (!(item >= 0)) return false;
  const V = d.vehicle;
  const k = localK(d);
  const A = d.aggression;
  const style = d.itemStyle;
  const pos = d.position | 0;                    // 0 = the race flow did not say
  const leading = pos > 0 && pos <= LEADER_POS;
  const threatened = d._shotBehind < LEAD_THREAT_M;
  const stale = d.itemAge > HOLD_ESCAPE;         // never hold anything for ever
  let p = 0, back = false;

  switch (item) {
    case ITEM.NITRO:
    case ITEM.TRIPLE: {
      /* Three refusals, in cost order: airborne (the drive fade does nothing
         with no wheels down), curvature (a boost into a corner is thrown
         away), and an already-boosted car (the mini-turbo owns `driveMul`
         between 1 and ~1.15 — stacking on top of it wastes both). */
      if (V.airborne) break;
      if (k >= NITRO_K) break;
      if ((V.driveMul || 1) > NITRO_DRIVE) break;
      if (item === ITEM.TRIPLE && d.sinceFire < TRIPLE_GAP) break;
      p = AI_ITEM.boost + AI_ITEM.boostSkill * A;
      // A reason to spend it now: ground to make up, or a car to run down.
      if (!(d.behindSec > NITRO_BEHIND_S || d._shotAhead <= NITRO_AHEAD)) p *= NITRO_IDLE;
      break;
    }

    case ITEM.WHEEL: {
      /* P1 and P2 draw the spare wheel as a rear guard. Throwing it forward
         at nobody is how a leader ends up defenceless when the pack finally
         arrives; hold it until somebody is actually there. */
      if (leading && !threatened && d.itemAge < LEADER_HOLD) break;
      if (aimOk(d, false, k)) back = false;
      else if (aimOk(d, true, k)) back = true;
      else break;
      p = AI_ITEM.shoot + AI_ITEM.shootSkill * A;
      /* Aim error from consistency: a sloppy driver takes a marginal shot
         anyway and misses, which is far more entertaining than a grid of
         six perfect marksmen. */
      if (d.rng() > d.consistency) p *= 0.4;
      break;
    }

    case ITEM.TOW: {
      /* The tow needs a real lock — itemworld's own cone/window test, not
         our approximation of it. Without it `fire()` silently converts the
         pickup into a nitro, which is a waste dressed up as a mercy. */
      const io = ctx && ctx.items;
      const ri = (ctx && ctx.myId !== undefined) ? ctx.myId : d.id;
      if (!io || typeof io.canLock !== 'function' || !io.canLock(ri)) break;
      p = AI_ITEM.shoot + AI_ITEM.shootSkill * A;
      break;
    }

    case ITEM.SLICK: {
      if (leading && !threatened && d.itemAge < LEADER_HOLD) break;
      const tail = d._shotBehind >= SLICK_NEAR && d._shotBehind <= SLICK_FAR &&
        abs(d._shotLatB) < SLICK_LAT;
      const corner = k > SLICK_CORNER_K;
      const hold = SLICK_HOLD * (HOLD_SCALE[style] || 1);
      if (!(tail || corner || d.itemAge > hold)) break;
      p = AI_ITEM.drop;
      back = true;                              // a hazard always goes behind
      break;
    }

    case ITEM.STORM: {
      /* Rear-of-field only (items.js gates the roll the same way), and only
         when there is somebody close enough ahead for 2.6 s of slow to be
         worth anything. `gapAheadSec` is Infinity with no tracker, so the
         stale escape below is what stops it being held for ever. */
      if (pos > 0 && pos < STORM_MIN_POS && !stale) break;
      if (!(d.gapAheadSec <= STORM_GAP_S) && !stale) break;
      p = AI_ITEM.special;
      break;
    }

    case ITEM.SLED:
      p = AI_ITEM.special;                      // a comeback item you sit on is scenery
      break;

    default: break;
  }

  if (!(p > 0)) return false;
  p *= P_SCALE[style] || 1;
  if (d.rng() < p) {
    d.wantsFire = true;
    d.fireBack = back;
    d._fireItem = item;
    return true;
  }
  return false;
}

/**
 * Re-check a latched shot on the frame it is actually polled. Only the
 * aimed item can go stale — a boost or a sled is as good now as it was
 * a quarter of a second ago.
 */
export function validateFire(d) {
  if (!d.wantsFire || d._fireItem !== ITEM.WHEEL) return;
  if (!aimOk(d, d.fireBack, localK(d))) {
    d.wantsFire = false;
    d.fireBack = false;
  }
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

/* ============================================================
   RALLY ROAD RASH — THE AI's TRIGGER FINGER
   ------------------------------------------------------------
   ai.js answers "where should this car be"; this file answers "is now the
   moment to fire". It replaced the roster half of ai-items.js in wave 8:
   seven items with seven policies became one rocket with one, and the
   whole file is the firing solution plus when to hold.

   PURE. Reads the launcher table from weapons.js (pure) so ai.js keeps its
   "no three in the import graph" property. No DOM, no allocation after
   load. Every random draw goes through `d.rng`, never Math.random: two
   identical seeds must produce identical races or the QA sweep cannot
   compare builds.

   THE LEAD-AIM SOLUTION
   ---------------------
   A rocket leaves the tube at `speed` m/s ON TOP of the firer's own
   velocity (arsenal.js: `pVX = v.vel.x + dir.x * speed`), so along my
   forward axis it closes on a rival at

       forward:  speed + (spd − theirFwd)      rearward:  speed − (spd − theirFwd)

   and it carries my lateral velocity, i.e. none relative to me. So the
   rival's own lateral drift is the whole of the miss:

       t = fl / max(8, rel)          m = ll + theirLat · t

   The `max(8, …)` floor is not cosmetic. Fired backwards while flat out,
   `speed − spd` can go to zero or negative — the rocket is then travelling
   forwards in world space and will never reach a car behind. Flooring the
   closing rate makes `t` finite and large, which makes `m` large, which
   makes the gate refuse the shot. That is the correct answer arrived at
   without a special case.

   WHAT NITRO IS NOT. There is no nitro decision here and there must never
   be one: the can fires on contact. The only thing this file knows about
   nitro is nothing.
   ============================================================ */

import { launcherFor } from './weapons.js';

/* ---------------------------------------------------------------
   How eager a driver is with the launcher, evaluated `hz` times a second.
   `shoot` is the floor everyone has; `aggression` is the personality dial
   makeGridProfiles already assigns and which is deliberately uncorrelated
   with skill — "a slow driver who will not move over is the most memorable
   car on the grid" applies just as well to one who will not stop shooting
   at you.
   --------------------------------------------------------------- */
export const AI_WEAPON = {
  hz: 4,                           // decisions per second
  shoot: 0.30, shootSkill: 0.60,   // p with a rival lined up
  /* RECORD gate, not an aim gate. The rival scan in ai.js keeps the nearest
     car inside this lateral band so the lead-aim solution has something to
     work with; whether the shot is on is then decided by `aimOk`, which is
     the only place a miss distance is computed. */
  latGate: 8.0,
  aheadMin: 2, aheadMax: 80,       // m — the window a forward scan records
  behindMin: 2, behindMax: 70,     // m — and a rearward one
  /* The firing window (contract: 8–70 m, ±12°). Inside `rangeMin` the
     rocket has not armed; past `rangeMax` the drop has begun to matter and
     the AI is guessing. `cone` is the launcher's honest field of fire —
     the tube does not traverse. */
  rangeMin: 8, rangeMax: 70,
  cone: 12 * Math.PI / 180,
};

const AIM_BASE = 1.5;                      // m of miss tolerated at zero range
const AIM_PER_M = 0.030;                   // …growing this much per metre
const REL_FLOOR = 8;                       // m/s — see the header
const STRAIGHT_K = 0.012;                  // 1/m — above this the rocket leaves
                                           //   the corridor before it arrives
const LEADER_POS = 2;                      // P1/P2 keep a rocket in the tube…
const LEAD_THREAT_M = 26;                  // m behind — …until somebody is here
const SPEED_FALLBACK = 60;                 // m/s if the driver published none

/* ---------------- personality ---------------- */
export const WEAPON_STYLE = { SNIPER: 'sniper', SPAMMER: 'spammer', TURTLE: 'turtle' };

/* Sniper waits for the shot and takes it clean; spammer fires early and
   often; turtle keeps rockets back for defence. Consistency is tested FIRST
   because it is the axis that correlates with skill — a fast, tidy driver
   should read as deliberate, not as trigger-happy, even when they are also
   aggressive. */
export function weaponStyleFor(p) {
  if (!p) return WEAPON_STYLE.TURTLE;
  if (p.consistency > 0.7) return WEAPON_STYLE.SNIPER;
  if (p.aggression > 0.7) return WEAPON_STYLE.SPAMMER;
  return WEAPON_STYLE.TURTLE;
}

const AIM_SCALE = { sniper: 0.75, spammer: 1.30, turtle: 1.00 };
const P_SCALE = { sniper: 1.00, spammer: 1.25, turtle: 0.85 };
/* How many rockets each style keeps back when it is NOT threatened. A
   turtle's second rocket is also a defensive one. */
const RESERVE = { sniper: 1, spammer: 0, turtle: 2 };

/* ============================================================
   AIMING
   ============================================================ */
const abs = Math.abs;

/** Curvature of the route under the driver, or 0 if the index is not live. */
function localK(d) {
  const R = d.route, i = d.ri;
  if (!R || !R.pts || i < 0 || i >= R.n) return 0;
  const k = R.pts[i].k;
  return k < 0 ? -k : (k || 0);
}

/** The muzzle speed this driver's machine throws at. */
export function rocketSpeedOf(d) {
  if (d.rocketSpeed > 0) return d.rocketSpeed;
  const V = d.vehicle;
  const id = V && V.spec ? V.spec.id : null;
  return id ? launcherFor(id).speed : SPEED_FALLBACK;
}

/**
 * Is a rocket fired NOW going to arrive where the target will be?
 * Exported so ai.js can re-run it on the frame `wantsFire` is actually
 * polled — a decision taken up to 1/hz seconds ago is a decision taken
 * against a geometry that has since moved, and firing on a stale one is
 * the same class of bug as the latch it replaces.
 */
export function aimOk(d, back, k) {
  if (k >= STRAIGHT_K) return false;
  const fl = back ? d._shotBehind : d._shotAhead;
  if (!(fl >= AI_WEAPON.rangeMin && fl <= AI_WEAPON.rangeMax)) return false;
  const ll = back ? d._shotLatB : d._shotLat;
  // The tube does not traverse: outside the cone there is no shot to lead.
  if (abs(ll) > fl * Math.tan(AI_WEAPON.cone)) return false;
  const closing = back ? d._shotClosingB : d._shotClosing;   // spd − theirFwd
  const theirLat = back ? d._shotTheirLatB : d._shotTheirLat;
  const speed = rocketSpeedOf(d);
  const rel = back ? (speed - closing) : (speed + closing);
  const t = fl / (rel > REL_FLOOR ? rel : REL_FLOOR);
  const miss = abs(ll + theirLat * t);
  const win = (AIM_BASE + AIM_PER_M * fl) * (AIM_SCALE[d.weaponStyle] || 1);
  return miss < win;
}

/* ============================================================
   THE DECISION
   ------------------------------------------------------------
   Sets the latch and nothing else. This function must never touch `ctl`,
   the steering state or the offset — ai.js's weapon block is write-only
   to `wantsFire`/`fireBack` for exactly that reason.

   The policy, in the order it is applied:
     1. nothing in the tube → nothing to decide
     2. the last rocket is for defence: fire it only when THREATENED
        (a car close behind, or a rocket on the way in)
     3. a leader keeps its style's reserve back until threatened
     4. forward shot if the lead-aim says yes, else a rearward one
     5. probability from aggression, scaled by style, dented by a sloppy
        driver's consistency — a grid of six perfect marksmen is dull
   ============================================================ */
export function decideFire(d, ammo, spd, ctx) {
  void ctx; void spd;
  if (!(ammo > 0)) return false;
  const k = localK(d);
  const A = d.aggression;
  const style = d.weaponStyle;
  const pos = d.position | 0;                    // 0 = the race flow did not say
  const leading = pos > 0 && pos <= LEADER_POS;
  const threatened = d._shotBehind < LEAD_THREAT_M || d.threatOff !== 0;

  if (!threatened) {
    if (ammo <= 1) return false;                 // the last one is for defence
    if (leading && ammo <= (RESERVE[style] || 0)) return false;
  }

  let back;
  if (aimOk(d, false, k)) back = false;
  else if (aimOk(d, true, k)) back = true;
  else return false;

  let p = AI_WEAPON.shoot + AI_WEAPON.shootSkill * A;
  /* Aim error from consistency: a sloppy driver takes a marginal shot
     anyway and misses, which is far more entertaining than a grid of six
     perfect marksmen. */
  if (d.rng() > d.consistency) p *= 0.4;
  p *= P_SCALE[style] || 1;
  if (d.rng() < p) {
    d.wantsFire = true;
    d.fireBack = back;
    return true;
  }
  return false;
}

/**
 * Re-check a latched shot on the frame it is actually polled. The rocket
 * is the aimed weapon — it is the only thing that can go stale.
 */
export function validateFire(d) {
  if (!d.wantsFire) return;
  if (!aimOk(d, d.fireBack, localK(d))) {
    d.wantsFire = false;
    d.fireBack = false;
  }
}

/* ============================================================
   THE ARSENAL — launchers, pickups, and the ammo rules
   ------------------------------------------------------------
   PURE. Imports config.js and nothing else, so dev/weapons-check.mjs can
   hammer the rules under bare Node and a balance change is a data change.
   The live half — pickups on the road, the rocket pool, the effects — is
   src/game/arsenal.js.

   WHAT REPLACED THE ROULETTE, AND WHY
   -----------------------------------
   Wave 5's power-ups were a kart-racer item box: one slot, a random roll
   weighted by position, seven things it could be. Every one of those
   decisions cost the player a beat of reading — what did I get, what does
   it do, which way does it go — and the cockpit notes said the same thing
   every time: the boxes felt like a lottery nobody had entered. A rally is
   not a lottery. So the roster collapsed to ONE weapon everybody always
   has and ONE road pickup that acts the instant you drive through it.
   There is nothing to read; there is only whether you hit.

     • Every machine carries a roof launcher and leaves the grid with
       `ammoStart` rockets. A crate on a straight tops the rack up; the
       rack has a cap, so hoarding is not a strategy and a crate you pass
       with a full rack is a crate you chose to leave.
     • The nitro can is NOT inventory. It fires the moment a car drives
       through it — no key, no meter — and its effect is exactly the old
       NITRO item's, through the same two drive multipliers. Siting it on
       corner exits and after crests is what makes it a reward for a good
       line rather than a random gift.

   No rubber band. Position-weighted drops were the mechanism by which a
   lead evaporated; the AI's balancing bands in ai.js do that job now, on
   the speed targets, where a player cannot see the thumb on the scale.
   ============================================================ */
import { G, TUNE } from './config.js';

const W = TUNE.weapons;
const N = TUNE.nitro;

/* ============================================================
   LAUNCHERS — per machine (contract 8.2)
   ------------------------------------------------------------
   Keyed by vehicles.js `spec.id`. Deltas between machines stay inside
   15 % of each other on every column: they say "different quality", not
   "different weapon". The heavy truck reloads slowest and throws the
   slowest, biggest bang; the wedge is the sniper. dev/weapons-check.mjs
   gates the spread, so widening it is a deliberate act.

     ammo      rockets on the rack at the grid
     ammoCap   the most the rack holds
     reload    s between shots
     speed     m/s of muzzle speed, ON TOP of the car's own velocity
     splash    m — the radius inside which a miss still costs somebody
   ============================================================ */
export const LAUNCHERS = {
  hopper:    { ammo: W.ammoStart, ammoCap: W.ammoCap, reload: 0.84, speed: 60, splash: 3.30 },
  ridgeback: { ammo: W.ammoStart, ammoCap: W.ammoCap, reload: 0.91, speed: 56, splash: 3.50 },
  redline:   { ammo: W.ammoStart, ammoCap: W.ammoCap, reload: 0.80, speed: 64, splash: 3.05 },
  moto:      { ammo: W.ammoStart, ammoCap: W.ammoCap, reload: 0.82, speed: 62, splash: 3.10 },
};

/* A spec this file has never heard of still gets a launcher: the middle of
   the table, so a new machine fires before anybody has tuned it. */
export const LAUNCHER_DEFAULT = LAUNCHERS.hopper;

export function launcherFor(specId) {
  return LAUNCHERS[specId] || LAUNCHER_DEFAULT;
}

/* ============================================================
   PICKUPS — what sits on the road
   ------------------------------------------------------------
   Two kinds, and the table is deliberately small: arsenal.js dispatches on
   `id` and reads nothing off a pickup that is not here. `text` is what the
   HUD says when you take one (contract 8.3 `pickupText`); `col` is the
   colour the kit already paints it, so the spark on collection matches
   the object it came off.
   ============================================================ */
export const PICKUP = { NONE: -1, ROCKET: 0, NITRO: 1 };

export const PICKUPS = [
  {
    id: PICKUP.ROCKET, key: 'rocket', name: 'ROCKETS', text: '+3 ROCKETS',
    col: 0xffd23f,
    ammo: W.crateAmmo,
    respawn: W.crateRespawn,
    rows: W.crateRows,            // crates per row, [min, max]
  },
  {
    id: PICKUP.NITRO, key: 'nitro', name: 'NITRO', text: 'NITRO',
    col: 0xff8a1a,
    respawn: N.respawn,
    force: N.force, top: N.top, time: N.time,
  },
];

/* ============================================================
   PER-RACER STATE
   ------------------------------------------------------------
   Fixed shape, declared up front, every field a number. arsenal.js keeps
   one of these per racer and mirrors four of the fields onto the Vehicle
   every frame (contract 8.1) — this object is the truth, the Vehicle's
   copy is the publication.
   ============================================================ */
export function makeArsenal(specId) {
  const L = launcherFor(specId);
  return {
    ammo: L.ammo,
    ammoCap: L.ammoCap,
    reloadT: 0,             // s until the next shot is allowed
    nitroT: 0,              // s of nitro burn remaining
    slowT: 0,               // s of a rocket hit's drive cut remaining
    /* The launcher's own numbers, copied so the hot path never touches the
       table — and so a machine's launcher travels with its racer row. */
    reload: L.reload,
    speed: L.speed,
    splash: L.splash,
  };
}

/** Back to the grid: a full rack, nothing burning, nothing cut. */
export function resetArsenal(st) {
  st.ammo = W.ammoStart > st.ammoCap ? st.ammoCap : W.ammoStart;
  st.reloadT = 0; st.nitroT = 0; st.slowT = 0;
}

/**
 * Load `n` rockets. Returns how many actually went on — zero means the rack
 * was full, which arsenal.js reads as "leave the crate where it is".
 */
export function addAmmo(st, n) {
  const room = st.ammoCap - st.ammo;
  const add = n > room ? room : n;
  if (add <= 0) return 0;
  st.ammo += add;
  return add;
}

export function canFire(st) { return st.ammo > 0 && st.reloadT <= 0; }

/** Spend one rocket and start the reload. False if there was nothing to spend. */
export function spend(st) {
  if (!canFire(st)) return false;
  st.ammo--;
  st.reloadT = st.reload;
  return true;
}

/** A can was driven through. `max`, never `+=`: two cans in a second are
    one burn, not three seconds of one. */
export function giveNitro(st) {
  if (st.nitroT < N.time) st.nitroT = N.time;
  return st;
}

/** Hit by a rocket. `direct` false is the splash tier — half of everything. */
export function giveSlow(st, direct) {
  const t = direct ? W.slowT : W.slowT * W.splashMul;
  if (st.slowT < t) st.slowT = t;
  return st;
}

/** Seconds of spin-out a hit is worth, on the Vehicle's spinT path. */
export function hitSpin(direct) { return direct ? W.spin : W.spin * W.splashMul; }

/** Tick every clock. Once per frame per racer. */
export function tick(st, dt) {
  if (st.reloadT > 0) { st.reloadT -= dt; if (st.reloadT < 0) st.reloadT = 0; }
  if (st.nitroT > 0) { st.nitroT -= dt; if (st.nitroT < 0) st.nitroT = 0; }
  if (st.slowT > 0) { st.slowT -= dt; if (st.slowT < 0) st.slowT = 0; }
}

/**
 * The two drive multipliers this state is worth right now, from scratch —
 * recomputed every frame so an effect can never accumulate (the itemworld
 * rule, kept). `out.drive` × motorForce, `out.top` × topSpeed as the
 * drive-fade denominator: the same semantics as TUNE.boost.fireMul/fireTop,
 * which is what lets Vehicle.step compose a nitro with a mini-turbo.
 */
export function effectMuls(st, out) {
  let d = 1, t = 1;
  if (st.nitroT > 0) { d *= N.force; t *= N.top; }
  if (st.slowT > 0) d *= W.slowDrive;
  out.drive = d; out.top = t;
  return out;
}

/* ============================================================
   BALLISTICS
   ------------------------------------------------------------
   The model arsenal.js integrates: flat for `straightT`, then a `dropG`
   fraction of gravity, dead at `life`. Closed-form here so the check can
   ask "does the shot reach the AI's whole window" without a simulation,
   and so the AI's lead-aim (ai-weapons.js) and the live rocket agree on
   what the muzzle speed means.
   ============================================================ */

/**
 * Horizontal metres a rocket covers before the ground, from `height` above
 * flat ground, fired from a car doing `vLaunch` m/s along the shot.
 */
export function rocketRange(vLaunch, muzzleSpeed, height) {
  const v = vLaunch + muzzleSpeed;
  if (!(v > 0)) return 0;
  const h = height > 0 ? height : 0;
  const tFall = Math.sqrt(2 * h / (W.dropG * G));
  const t = Math.min(W.life, W.straightT + tFall);
  return v * t;
}

/** How far a rocket has gone when it may first hit its own launcher. */
export function armDistance(vLaunch, muzzleSpeed) {
  const v = vLaunch + muzzleSpeed;
  return v > 0 ? v * W.arm : 0;
}

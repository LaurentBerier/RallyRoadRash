/* ============================================================
   RALLY ROAD RASH — AI DRIVERS
   ------------------------------------------------------------
   NO three imports. Plain math over plain numbers. The Vehicle happens to
   expose THREE vectors; we read `.x/.y/.z` off them and never construct one.
   Nothing in `update()` allocates: every scratch value is a scalar field on
   the driver, the returned `ctl` is the SAME object every frame, and the
   per-track route tables are built once and shared through a WeakMap.

   THE DRIVER MODEL IN TEN LINES
   -----------------------------
   1. One `spline.nearest(x, z, this._n)` per update gives s / lateral / how
      far off course I am. Everything else runs off a route index walked
      locally on the 6 m racing-line grid (±2..8 indices per frame).
   2. Steering is pure pursuit at ld = clamp(6 + 0.55·v, 7, 34) m. The
      required rack angle δ = atan(wheelbase·2·lat/ld²) is divided by the
      car's OWN current lock (config.js taper) so we ask for a geometry, not
      a stick position, and never fight the rack. Deadzone 0.02, own rate
      limit 6/s (the rack itself does 6.5/s — stay just inside it).
   3. Speed: scan the line forward over the stopping distance v²/(2·a) with
      a = 8.5·grip(surface), take min over i of √(v_i² + 2·a·d_i) — the most
      restrictive (speed, distance) pair — then scale by skill.
   4. skill maps to [0.78 … 1.02] of line speed. Target ≥ 0.95·topSpeed ⇒
      throttle pinned to 1. Otherwise a P controller with a hysteresis band
      (brake in at +1.1 m/s, out at +0.2) so it never flutters.
   5. aggression shifts the brake point up to 12 % closer; a "mistake" adds
      another 35 % for 1.2 s. consistency drives a per-corner entry-speed
      error (±6 %) and a wandering steering bias (±0.02). A "corner" is one
      edge of "something ahead wants me slower than I am" — see CORNER_GATE.
   6. Jumps: inside 30 m the apex offset is dropped and we aim at the lip
      itself; inside 12 m the throttle is frozen and the brake released;
      airborne it is steer 0 / throttle 0.5 and let the car self-align.
      In the 40 m before a GAP the target is floored at 0.98× line speed
      regardless of skill — that is what makes the canyon 24.2 m/s.
   7. Overtaking: a car ≤18 m ahead and within ±3.5 m of my line earns a
      lateral offset of up to ±min(2.8, halfWidth − 1.5) toward the freer
      side, blended in/out over 0.7 s, dropped if they are pulling away.
      Alongside (|lateral| < 1.9 m) adds a repulsion term. We lift, never
      brake-check; aggression decides how late we lift.
   8. Shortcut: at the entry window, once per lap approach, take it with
      p = AI_SHORTCUT.base + AI_SHORTCUT.skill·skill (0.25 + 0.6·skill). The
      alternate route is a full stitched lap (main → shortcut samples → main)
      built once per track. Read AI_SHORTCUT's note before shipping canyon.
   9. Recovery: flipped > TUNE.reset.flipTime, stuck > TUNE.reset.stuckTime,
      or > 22 m off the centreline ⇒ `wantsReset`. The last 1.5 s before
      that is spent reversing and steering back at the line, which quite
      often works and always looks alive.
  10. Balancing is a cap on MY speed targets, never on the vehicle. See
      AI_BALANCE below.

   BALANCING — transparent, ±1.5 %, one flag
   -----------------------------------------
   `AI_BALANCE.enabled = false` disables it completely. The factor is linear
   in current race position: P1 → 0.985, P6 → 1.015, hard-clamped to that
   range whatever the field size, and eased with a 1.5 s time constant so a
   position change is not a step in the throttle. It multiplies the racing
   line speeds and the topSpeed cap this driver aims for. It does NOT touch
   `spec.topSpeed`, the vehicle, or anything the player can feel directly.

   Position comes from `ctx.position` (1-based) if the race flow supplies it.
   Failing that we call `ctx.tracker.standings()` at most twice a second —
   that call allocates, which is why it is the fallback and not the source.
   With neither, the factor is 1.0 (so the dev checks are deterministic).
   ============================================================ */

import { paintAt } from '../world/track.js';
import { SURFACES } from '../world/surfaces.js';
import { TUNE } from './config.js';

/* ---------------------------------------------------------------
   The balancing knob. Documented above; exported so the integrator can
   flip it off from one place without touching driver code.
   --------------------------------------------------------------- */
/* How eager a driver is with a power-up, evaluated four times a second.
   `base` is the floor everyone has; `aggression` is the personality dial
   makeGridProfiles already assigns and which is deliberately uncorrelated
   with skill — "a slow driver who will not move over is the most memorable
   car on the grid" applies just as well to one who will not stop throwing
   things at you. */
export const AI_ITEM = {
  hz: 4,               // decisions per second
  boost: 0.35, boostSkill: 0.50,   // p on a straight, at speed
  shoot: 0.30, shootSkill: 0.60,   // p with a rival lined up
  drop: 0.50,                      // p with somebody close behind, or a corner
  special: 1.0,                    // sled and storm: no reason to wait
  latGate: 3.5,        // m of lateral error inside which a shot is "lined up"
  aheadMin: 4, aheadMax: 42,       // m — the window a forward shot wants
  behindMin: 3, behindMax: 30,     // m — and a rearward one
};

export const AI_BALANCE = {
  enabled: true,
  leader: 0.985,      // multiplier on speed targets for P1
  trailing: 1.015,    // …and for P6 (or last, if the field is smaller)
  field: 6,           // position that reaches `trailing`
  ease: 1.5,          // s — time constant so the factor never steps
};

/* ---------------------------------------------------------------
   Shortcut take-up: p = base + skill·(driver skill), decided once per lap
   approach. Exported because the two authored detours pull in OPPOSITE
   directions and the integrator will want to say so per track:

     TIMBERLINE CLIMB  high route  −0.3 s/lap  (worth taking)
     SUNSTRIKE CANYON  slot canyon +2.8 s/lap  (the gap jump is the fast way)

   measured by dev/ai-check.mjs at skill 0.9. With the contract's 0.25 + 0.6
   ·skill, the quickest drivers take the canyon detour ~82 % of the time and
   give away five per cent of the lap for it. Setting `skill` NEGATIVE makes
   take-up fall with ability, which is the behaviour that track wants.
   --------------------------------------------------------------- */
export const AI_SHORTCUT = { base: 0.25, skill: 0.60 };

/* ---------------------------------------------------------------
   Driver-model constants. Everything the report quotes lives here.
   --------------------------------------------------------------- */
const LOOK_BASE = 6.0;        // m of pure-pursuit lookahead at a standstill
const LOOK_K = 0.55;          // …plus this much per m/s
const LOOK_MIN = 7.0, LOOK_MAX = 34.0;

const STEER_RATE = 6.0;       // 1/s on OUR output. The rack does 6.5/s.
const STEER_DEAD = 0.02;      // rack fractions — kills idle dither

const A_BRAKE = 8.5;          // m/s² before the surface grip multiplier
const REACT_T = 0.12;         // s of travel shaved off every braking distance

const SKILL_LO = 0.78, SKILL_HI = 1.02;   // line-speed scaling by skill
const LATE_BRAKE = 0.12;      // aggression pulls the brake point this % closer
const MISTAKE_LATE = 0.35;    // …and a mistake adds this much again
const MISTAKE_T = 1.2;        // s a mistake lasts before ordinary control resumes
const MISTAKE_P_NEAR = 0.30;  // per-corner probability scale with a rival <8 m
const MISTAKE_P_FAR = 0.04;   // …and without one
const RIVAL_NEAR = 8.0;       // m

/* "A corner is coming" = the scan's most restrictive point wants me slower
   than the line speed where I already am. Comparing against topSpeed instead
   would call most of a rally lap a corner and re-roll the dice all the way
   round; comparing against the LOCAL line speed fires once per braking zone,
   which is what the personality is supposed to modulate. */
const CORNER_GATE = 0.95;     // vTarget below this × the local line speed
const CORNER_HOLD = 0.8;      // s between re-rolls, so one corner is one roll

const ENTRY_ERR = 0.06;       // ±6 % of entry speed at consistency 0
const BIAS_MAX = 0.02;        // rack fractions of slow steering wander
const BIAS_WALK = 0.055;      // per √s of random walk
const BIAS_PULL = 0.30;       // 1/s mean reversion

const THR_P = 0.60;           // throttle per (m/s of speed deficit)
const THR_BASE = 0.25;        // …plus this at zero error (beats coast-down)
const BRK_P = 0.50;           // brake per (m/s of excess)
const BRK_IN = 1.10, BRK_OUT = 0.20;   // hysteresis band, m/s
const FULL_COMMIT = 0.95;     // target ≥ this × topSpeed ⇒ throttle 1

const JUMP_NEAR = 30, JUMP_COMMIT = 12;   // m before the lip
const GAP_WIN = 40;           // m before a GAP jump where the floor applies
const GAP_FRAC = 0.98;        // …at this fraction of the line's own speed
const AIR_THROTTLE = 0.5;
const AIR_MIN_T = 0.12;       // s airborne before the air policy takes over —
                              //   below it every rut would zero the steering

const AVOID_AHEAD = 18.0;     // m — how far up the road a blocker counts
const AVOID_LAT = 3.5;        // m — …and how far off my line
const AVOID_LAT_REL = 5.5;    // m — hysteresis: keep the offset out to here
const AVOID_MAX = 2.8;        // m of lateral offset, before the road-edge clamp
const AVOID_EDGE = 1.5;       // m of half-width kept in hand
const AVOID_BLEND = 0.7;      // s to blend the offset fully in or out
const SIDE_GAP = 1.9;         // m — below this we push apart
const SIDE_PUSH = 1.2;        // m of extra offset at zero gap
/* "They are faster, let them go" needs a real speed difference. At exactly
   matched pace the closing speed dithers either side of zero, and a strict
   `>= 0` test made the whole overtaking system flicker off in a train. */
const CLOSE_TOL = -0.75;      // m/s
const LIFT_BASE = 5.5;        // m — lift (never brake) inside this…
const LIFT_AGGR = 2.5;        // …minus this much for a fully aggressive driver
const LIFT_THROTTLE = 0.25;

const SHORTCUT_WIN0 = 90, SHORTCUT_WIN1 = 20;   // m before the entry to decide

const OFF_LINE_D = 22;        // m from the CENTRELINE before we call it lost
const OFF_LINE_T = 0.6;       // s of dwell, so one bad frame is not a reset
const RECOVER_T = 1.5;        // s of reverse-and-steer before giving up
const RECOVER_THR = -0.7;

const REACT_LO = 0.08, REACT_HI = 0.28;   // s of start reaction, by skill
const PRESTAGE = 0.35;        // s before green that we load the drivetrain
const FINISH_SCALE = 0.40;    // speed targets after the flag

const BRAKE_A_LINE = 11.0;    // matches track.js's racing-line propagation
const ACCEL_A_LINE = 6.5;

/* ---------------- tiny local math (no imports for four lines) ---------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ============================================================
   ROUTES — built once per trackData, shared by every driver.
   ------------------------------------------------------------
   A route is `{ pts, n, cum, len, gapFloor }` where `pts[i]` has the racing
   line point shape and `cum[i]` is the true 3-D distance from pts[0] round
   to pts[i] (cum[n] = the whole lap). Distances come from the geometry, not
   from an assumed 6 m stride, because buildTrackData rounds the stride to
   L / round(L / 6) and the offset line is not the centreline.

   `main` is trackData.racingLine untouched (we never mutate T1's data).
   `alt` is the stitched shortcut lap: main up to the split, our own samples
   of shortcutSpline, then main from the rejoin.
   ============================================================ */
const _routeCache = new WeakMap();

function makeRoute(pts, gapFloor) {
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return { pts, n, cum, len: cum[n], gapFloor, step: cum[n] / n };
}

/** Distance floor to hold in the run-up to a GAP jump, per main-line index. */
function buildGapFloor(trackData, rl) {
  const n = rl.length;
  const out = new Float32Array(n);
  const jumps = trackData.jumps || [];
  const L = trackData.lapLength || trackData.spline.length;
  for (let k = 0; k < jumps.length; k++) {
    const j = jumps[k];
    if (!(j.gap > 0)) continue;
    let li = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      let d = Math.abs(rl[i].s - j.s);
      if (d > L * 0.5) d = L - d;
      if (d < bd) { bd = d; li = i; }
    }
    if (out[li] < rl[li].speed) out[li] = rl[li].speed;
    let d = 0, i = li;
    while (d < GAP_WIN) {
      const p = (i - 1 + n) % n;
      d += Math.hypot(rl[i].x - rl[p].x, rl[i].y - rl[p].y, rl[i].z - rl[p].z);
      if (out[p] < rl[p].speed) out[p] = rl[p].speed;
      i = p;
      if (i === li) break;
    }
  }
  return out;
}

function buildRoutes(trackData) {
  const rl = trackData.racingLine;
  const N = rl.length;
  const L = trackData.lapLength || trackData.spline.length;
  const gapFloor = buildGapFloor(trackData, rl);
  const main = makeRoute(rl, gapFloor);

  const R = {
    L, step: L / N, main, alt: null,
    e0: 0, e1: 0, scN: 0, entryS: 0, exitS: 0, hasShortcut: false,
  };

  const def = trackData.def;
  const ss = trackData.shortcutSpline;
  const sc = def && def.shortcut;
  /* A shortcut whose span wraps the finish line would need the stitch to wrap
     too. No authored track does it; refusing is cheaper and safer than a
     branch nobody exercises. */
  if (!ss || !sc || !(sc.s1 > sc.s0)) return R;

  const entryS = sc.s0, exitS = sc.s1, span = exitS - entryS;
  let e0 = 0; while (e0 < N && rl[e0].s < entryS) e0++;
  let e1 = 0; while (e1 < N && rl[e1].s <= exitS) e1++;
  if (e0 < 2 || e1 >= N - 1 || e1 <= e0) return R;

  const SL = ss.length;
  const scN = Math.max(4, Math.round(SL / R.step));
  const ds = SL / scN;
  const pts = new Array(scN);
  const tmp = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < scN; i++) {
    const t = i * ds;
    ss.posAt(t, tmp);
    /* The terrain bake carves the detour with s = s0 + fraction·span (see
       terrain.js carveInto), so painting it at the same s is what puts the
       AI on the same surface the physics will report. */
    const sMain = entryS + (t / SL) * span;
    const surf = def ? paintAt(def, sMain - Math.floor(sMain / L) * L, tmp.x, tmp.z, 0, L) : 1;
    pts[i] = {
      x: tmp.x, y: tmp.y, z: tmp.z, s: sMain, lat: 0,
      speed: 48, k: 0, surface: surf, jump: false,
    };
  }
  // Menger curvature -> the same sqrt(7.5·grip·R) the racing line uses.
  for (let i = 0; i < scN; i++) {
    const a = pts[i > 0 ? i - 1 : 0], b = pts[i], c = pts[i < scN - 1 ? i + 1 : scN - 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const bcx = c.x - b.x, bcz = c.z - b.z;
    const cax = a.x - c.x, caz = a.z - c.z;
    const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(cax, caz);
    const area2 = Math.abs(abx * bcz - abz * bcx);
    const kk = (la * lb * lc > 1e-9 && area2 > 1e-9) ? (2 * area2) / (la * lb * lc) : 0;
    const rad = kk > 1e-6 ? 1 / kk : 1e6;
    const grip = SURFACES[b.surface] ? SURFACES[b.surface].grip : 0.8;
    b.k = kk;
    b.speed = clamp(Math.sqrt(7.5 * grip * rad), 9, 48);
  }
  // Brake propagation back from the rejoin, then accel forward from the split.
  const inPt = rl[e0 - 1], outPt = rl[e1];
  let vn = outPt.speed;
  for (let i = scN - 1; i >= 0; i--) {
    const b = i === scN - 1 ? outPt : pts[i + 1];
    const dd = Math.hypot(b.x - pts[i].x, b.y - pts[i].y, b.z - pts[i].z);
    const lim = Math.sqrt(vn * vn + 2 * BRAKE_A_LINE * dd);
    if (pts[i].speed > lim) pts[i].speed = lim;
    vn = pts[i].speed;
  }
  let vp = inPt.speed;
  for (let i = 0; i < scN; i++) {
    const a = i === 0 ? inPt : pts[i - 1];
    const dd = Math.hypot(pts[i].x - a.x, pts[i].y - a.y, pts[i].z - a.z);
    const lim = Math.sqrt(vp * vp + 2 * ACCEL_A_LINE * dd);
    if (pts[i].speed > lim) pts[i].speed = lim;
    vp = pts[i].speed;
  }

  // stitch: main[0 … e0) + shortcut + main[e1 … N)
  const alt = new Array(e0 + scN + (N - e1));
  const altFloor = new Float32Array(alt.length);
  let w = 0;
  for (let i = 0; i < e0; i++) { alt[w] = rl[i]; altFloor[w] = gapFloor[i]; w++; }
  for (let i = 0; i < scN; i++) { alt[w] = pts[i]; altFloor[w] = 0; w++; }
  for (let i = e1; i < N; i++) { alt[w] = rl[i]; altFloor[w] = gapFloor[i]; w++; }

  R.alt = makeRoute(alt, altFloor);
  R.e0 = e0; R.e1 = e1; R.scN = scN;
  R.entryS = entryS; R.exitS = exitS;
  R.hasShortcut = true;
  return R;
}

function routesFor(trackData) {
  let R = _routeCache.get(trackData);
  if (!R) { R = buildRoutes(trackData); _routeCache.set(trackData, R); }
  return R;
}

/* ============================================================
   THE DRIVER
   ============================================================ */
export class AIDriver {
  /**
   * @param {*} id            whatever the race flow calls this racer
   * @param {*} vehicle       a Vehicle (we only read numbers off it)
   * @param {*} trackData     buildTrackData() output
   * @param {*} profile       { name, skill, aggression, consistency }
   * @param {*} rng           () => [0,1); Math.random if omitted
   */
  constructor(id, vehicle, trackData, profile, rng) {
    this.id = id;
    this.vehicle = vehicle;
    this.trackData = trackData;
    this.rng = typeof rng === 'function' ? rng : Math.random;

    const p = profile || {};
    this.profile = p;
    this.name = p.name || String(id);
    this.skill = clamp(p.skill === undefined ? 0.6 : p.skill, 0, 1);
    this.aggression = clamp(p.aggression === undefined ? 0.5 : p.aggression, 0, 1);
    this.consistency = clamp(p.consistency === undefined ? 0.7 : p.consistency, 0, 1);

    this.spline = trackData.spline;
    this.R = routesFor(trackData);
    this.route = this.R.main;
    this.lapLength = this.R.L;

    const spec = vehicle && vehicle.spec ? vehicle.spec : null;
    this.topSpeed = spec && spec.topSpeed ? spec.topSpeed : 36;
    this.wheelbase = spec && spec.wheelbase
      ? Math.max(1.2, spec.wheelbase.front - spec.wheelbase.rear) : 2.6;
    this.lockScale = spec && spec.steerLockScale ? spec.steerLockScale : 1;

    /* PER-DRIVER nearest() out object. The default is module scratch inside
       track.js and six drivers sharing it would each read the last one's
       answer. This is the single most important line in the file. */
    this._n = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
    /* Returned every frame — the race flow consumes it immediately. */
    this.ctl = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };

    /* Item firing, latched exactly like `wantsReset`: this driver never acts,
       it only ever raises a hand, and race.js polls it. Keeping it out of
       `ctl` is deliberate — ctl is copied through three separate scratch
       objects and a fifth field would be silently dropped by all of them. */
    this.wantsFire = false;
    this.fireBack = false;
    this.fireT = 0;
    this._shotAhead = Infinity;      // m to the nearest lined-up car ahead
    this._shotBehind = Infinity;     // …and behind. Written by the rival scan.

    // --- route tracking ---
    this.ri = -1;             // route index at/just behind me; -1 = re-acquire
    this.rProj = 0;           // my projected distance along the route
    this.s = 0;               // main-spline arc length (progress + windows)
    this.lineD = 0;           // distance to MY route's polyline
    this.offCourseD = 0;      // distance to the centreline (reset system)

    // --- personality state ---
    this.entryErr = 0;
    this.bias = 0;
    this.mistakeT = 0;
    this.lastCornerIdx = 0;
    this.cornerT = 0;

    // --- controller state ---
    this.steerOut = 0;
    this.braking = false;
    this.offset = 0;          // signed lateral offset, + = LEFT (telemetry)
    this.offsetTarget = 0;
    this.avoidHold = 0;
    this.throttleHold = 0;
    this.jumpLatched = false;
    this.balanceF = 1;
    this.posSample = 0;
    this.position = 0;
    // _targetAt() output, declared here so the shape never changes
    this._tx = 0; this._tz = 0; this._ttx = 0; this._ttz = 1;

    // --- start ---
    this.reaction = REACT_LO + (REACT_HI - REACT_LO) * (1 - this.skill);
    this.reaction += (this.rng() - 0.5) * 0.04;
    this.reaction = clamp(this.reaction, 0.05, 0.35);
    this.launchT = -1;        // s since the lights went green, -1 = not started
    this.wasCountdown = false;

    // --- shortcut ---
    this.scCommitted = false;
    this.scDecided = false;
    this.onShortcut = false;

    // --- recovery ---
    this.wantsReset = false;
    this.flipT = 0;
    this.stuckT = 0;
    this.offT = 0;
    this.recovering = false;
  }

  /**
   * Is now a good moment to use what we are holding? Sets the latch and
   * nothing else. The windows come from the rival scan that already ran this
   * frame (_shotAhead / _shotBehind), so targeting is free.
   *
   * ITEM ids are items.js's: 0 nitro, 1 triple, 2 wheel, 3 slick, 4 tow,
   * 5 sled, 6 storm. Imported as numbers rather than by name to keep this
   * file's import graph as thin as it has always been.
   */
  _decideFire(item, spd) {
    const R = this.route, i = this.ri;
    const k = (R && R.pts && i >= 0 && i < R.n) ? Math.abs(R.pts[i].k || 0) : 0;
    const fast = spd > 0.55 * this.topSpeed;
    const A = this.aggression;
    let p = 0, back = false;

    switch (item) {
      case 0: case 1:
        // A boost is worth nothing into a corner. Straight, and quick already.
        if (k < 0.006 && fast && !this.vehicle.airborne) p = AI_ITEM.boost + AI_ITEM.boostSkill * A;
        break;
      case 2:
        // Forward if somebody is lined up there, otherwise cover your back.
        if (this._shotAhead < Infinity) p = AI_ITEM.shoot + AI_ITEM.shootSkill * A;
        else if (this._shotBehind < Infinity) { p = AI_ITEM.shoot + AI_ITEM.shootSkill * A; back = true; }
        /* Aim error from consistency: a sloppy driver takes the shot anyway
           and misses, which is far more entertaining than not taking it. */
        if (p > 0 && this.rng() > this.consistency) p *= 0.4;
        break;
      case 3:
        // Drop it where it will do something: a corner, or in somebody's face.
        if (this._shotBehind < Infinity || k > 0.012) { p = AI_ITEM.drop; back = true; }
        break;
      case 4:
        if (this._shotAhead < Infinity) p = AI_ITEM.shoot + AI_ITEM.shootSkill * A;
        break;
      case 5: case 6:
        p = AI_ITEM.special;
        break;
      default: break;
    }
    if (p > 0 && this.rng() < p) { this.wantsFire = true; this.fireBack = back; }
  }

  /** race.js consumed the fire request. */
  notifyFired() { this.wantsFire = false; this.fireBack = false; this.fireT = 0; }

  /** Race flow calls this once it has actually performed the respawn. */
  notifyReset() {
    this.wantsReset = false;
    this.wantsFire = false; this.fireBack = false; this.fireT = 0;
    this.flipT = 0; this.stuckT = 0; this.offT = 0;
    this.recovering = false;
    this.offset = 0; this.offsetTarget = 0; this.avoidHold = 0;
    this.steerOut = 0; this.braking = false; this.mistakeT = 0;
    this.entryErr = 0; this.bias = 0; this.jumpLatched = false;
    this.lastCornerIdx = 0; this.cornerT = 0;
    this.route = this.R.main;
    this.scCommitted = false; this.onShortcut = false; this.scDecided = false;
    this.ri = -1;             // force a full re-acquire next update
    this.ctl.throttle = 0; this.ctl.steer = 0;
    this.ctl.brake = 0; this.ctl.handbrake = 0;
  }

  /* ---------------- route position ---------------- */

  /** Forward distance from me to route point j, handling the lap wrap. */
  _ahead(j) {
    let d = this.route.cum[j] - this.rProj;
    if (d < -this.route.len * 0.5) d += this.route.len;
    return d;
  }

  _reacquire(px, pz) {
    const R = this.route, pts = R.pts, n = R.n;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = pts[i].x - px, dz = pts[i].z - pz;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    this.ri = bi;
  }

  /** Walk the route index to me and project onto the two touching chords. */
  _track(px, pz, dt, spd) {
    const R = this.route, pts = R.pts, n = R.n, cum = R.cum;
    if (this.ri < 0 || this.ri >= n) this._reacquire(px, pz);

    const fwd = 4 + ((Math.abs(spd) * dt) / R.step | 0);
    let bi = this.ri, bd = Infinity;
    for (let k = -2; k <= fwd; k++) {
      const i = (this.ri + k + n) % n;
      const dx = pts[i].x - px, dz = pts[i].z - pz;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    /* Lost the thread (shunted off, teleported, first frame after a bad
       respawn): a whole-route scan costs a few microseconds and only ever
       happens when something already went wrong. */
    if (bd > 1600) { this._reacquire(px, pz); bi = this.ri; }

    let proj = cum[bi], best = Infinity;
    for (let side = 0; side < 2; side++) {
      const a = side === 0 ? (bi - 1 + n) % n : bi;
      const ax = pts[a].x, az = pts[a].z;
      const b = (a + 1) % n;
      const ex = pts[b].x - ax, ez = pts[b].z - az;
      const el2 = ex * ex + ez * ez;
      if (el2 < 1e-9) continue;
      let t = ((px - ax) * ex + (pz - az) * ez) / el2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t - px, qz = az + ez * t - pz;
      const d2 = qx * qx + qz * qz;
      if (d2 < best) { best = d2; proj = cum[a] + (cum[a + 1] - cum[a]) * t; }
    }
    this.ri = bi;
    this.rProj = proj;
    this.lineD = Math.sqrt(best);
  }

  /* ---------------- main update ---------------- */

  update(dt, ctx) {
    const V = this.vehicle;
    const ctl = this.ctl;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.05) dt = 0.05;

    const state = (ctx && ctx.state) || 'running';

    /* Read every number off the Vehicle ONCE. `forward` and `speed` both go
       through module scratch inside vehicle.js — hold the numbers, not the
       vectors. */
    const px = V.pos.x, pz = V.pos.z;      // y is never needed: this is a 2-D problem
    const f = V.forward, fx = f.x, fz = f.z;
    const spd = V.speed;
    const vAbs = spd > 0 ? spd : 0;
    const airborne = !!V.airborne;
    const airTime = V.airTime || 0;
    const flipped = !!V.flipped;
    const surf = SURFACES[V.surfaceId | 0] || SURFACES[1];
    const grip = surf.grip;

    /* --- 1. where am I. ONE nearest() call, into MY out object. --- */
    const nr = this.spline.nearest(px, pz, this._n);
    this.s = nr.s;
    this.offCourseD = nr.d;
    const halfW = this.spline.widthAt(nr.s);

    /* --- 2. shortcut bookkeeping. Runs BEFORE _track because it can swap
       `this.route` out from under it; it reads last frame's `ri`, which is a
       frame of lag on a decision taken 20-90 m before the split. */
    this._shortcut(state);

    /* --- 3. route index + projection --- */
    this._track(px, pz, dt, spd);
    const rt = this.route, pts = rt.pts, rn = rt.n;
    const here = pts[this.ri];

    /* --- 4. balancing factor --- */
    this._balance(dt, ctx);

    /* --- 5. rivals: blockers, side-by-side, the mistake trigger ---
       Two separate questions, because they have different answers:
         holdDist/holdSide  — do I need to be somewhere else laterally?
                              Counts cars from 2.5 m behind my axle forward,
                              so the offset SURVIVES being alongside. Dropping
                              it the moment the pass starts is what turns an
                              overtake into a side-swipe.
         aheadDist/closing  — am I about to run into the back of someone?
                              Strictly ahead, and it only ever lifts. */
    let rivalNear = false, aheadDist = Infinity, aheadClosing = 0;
    let wantOff = 0;
    if (ctx && ctx.vehicles && state !== 'finished') {
      const list = ctx.vehicles;
      let holdDist = Infinity, holdSide = 0;
      let push = 0;
      const latGate = this.avoidHold > 0 ? AVOID_LAT_REL : AVOID_LAT;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (!o || o === V || !o.pos) continue;
        const dx = o.pos.x - px, dz = o.pos.z - pz;
        const fl = dx * fx + dz * fz;            // + = ahead of me
        const ll = dx * fz - dz * fx;            // + = to my LEFT
        const d2 = dx * dx + dz * dz;
        if (d2 < RIVAL_NEAR * RIVAL_NEAR) rivalNear = true;
        /* Free targeting data, inside a loop that already runs. `fl` and
           `ll` are exactly what a shot needs to know and they are computed
           three lines up for the blocker logic. */
        const al = ll < 0 ? -ll : ll;
        if (al < AI_ITEM.latGate) {
          if (fl > AI_ITEM.aheadMin && fl < AI_ITEM.aheadMax && fl < this._shotAhead) this._shotAhead = fl;
          if (-fl > AI_ITEM.behindMin && -fl < AI_ITEM.behindMax && -fl < this._shotBehind) this._shotBehind = -fl;
        }
        if (fl > AVOID_AHEAD || fl < -6 || ll > latGate || ll < -latGate) continue;

        const theirFwd = o.vel ? o.vel.x * fx + o.vel.z * fz : 0;
        const closing = spd - theirFwd;
        if (fl > 0 && fl < aheadDist) { aheadDist = fl; aheadClosing = closing; }
        // a car pulling away is not in my way — unless it is right there
        if (fl > -2.5 && fl < holdDist && (closing > CLOSE_TOL || fl < 3)) {
          holdDist = fl; holdSide = ll >= 0 ? 1 : -1;
        }
        // alongside: shove apart. Both cars run this, so nobody gets wedged.
        if (fl > -4.5 && fl < 4.5) {
          const ag = ll < 0 ? -ll : ll;
          if (ag < SIDE_GAP) push += (ll >= 0 ? -1 : 1) * SIDE_PUSH * (1 - ag / SIDE_GAP);
        }
      }

      if (holdDist < Infinity) {
        /* Go to the side the blocker is NOT on, unless the road runs out
           there — then take the other side and accept the squeeze. */
        const maxOff = Math.min(AVOID_MAX, Math.max(0, halfW - AVOID_EDGE));
        const baseLat = here.lat || 0;
        const room = Math.max(0.5, halfW - 1.2);
        let want = -holdSide * maxOff;
        if (baseLat + want > room || baseLat + want < -room) want = -want;
        wantOff = clamp(baseLat + want, -room, room) - baseLat;
        this.avoidHold = AVOID_BLEND;
      } else if (this.avoidHold > 0) {
        this.avoidHold -= dt;
      }
      wantOff += push;
      const maxOff2 = Math.min(AVOID_MAX + SIDE_PUSH, Math.max(0.5, halfW - 1.2));
      wantOff = clamp(wantOff, -maxOff2, maxOff2);
    } else {
      this.avoidHold = 0;
    }
    this.offsetTarget = wantOff;
    const orate = (AVOID_MAX / AVOID_BLEND) * dt;
    this.offset += clamp(this.offsetTarget - this.offset, -orate, orate);

    /* --- 6. jumps: is a lip coming, and is it a gap? --- */
    let jumpDist = Infinity, jumpX = 0, jumpZ = 0;
    if (!this.scCommitted && !this.onShortcut) {
      const J = this.trackData.jumps;
      if (J) {
        for (let i = 0; i < J.length; i++) {
          let d = J[i].s - this.s;
          if (d < -this.lapLength * 0.5) d += this.lapLength;
          if (d > this.lapLength * 0.5) d -= this.lapLength;
          if (d >= -2 && d < jumpDist) { jumpDist = d; jumpX = J[i].x; jumpZ = J[i].z; }
        }
      }
    }
    const jumpNear = jumpDist < JUMP_NEAR;
    const jumpCommit = jumpDist < JUMP_COMMIT;

    /* --- 7. speed target: scan the line over my stopping distance --- */
    const aBrake = A_BRAKE * grip;
    const lineScale = this._lineScale(state);
    let lateF = 1 - LATE_BRAKE * this.aggression;
    if (this.mistakeT > 0) { lateF -= MISTAKE_LATE; this.mistakeT -= dt; }
    lateF = clamp(lateF, 0.45, 1);

    const stopD = (vAbs * vAbs) / (2 * Math.max(1.5, aBrake)) + LOOK_MIN;
    const react = vAbs * REACT_T;
    let vTarget = Infinity, cornerIdx = this.ri;
    for (let k = 0; k < rn; k++) {
      const j = (this.ri + k) % rn;
      const d = this._ahead(j);
      if (d > stopD) break;
      const vi = pts[j].speed * lineScale;
      const de = d - react;
      const allowed = de > 0
        ? Math.sqrt(vi * vi + (2 * aBrake * de) / lateF)
        : vi;
      if (allowed < vTarget) { vTarget = allowed; cornerIdx = j; }
    }
    if (!(vTarget < Infinity)) vTarget = here.speed * lineScale;

    /* New corner ⇒ new entry-speed error, and a roll for a mistake.
       `cornerIdx` is whatever is currently limiting me. Through a corner
       APPROACH it locks onto that one point and does not move, so this fires
       once when the corner appears and not again until the next one. On a
       straight nothing is limiting (vTarget sits at the cap), which is the
       other half of "per corner" — the `limited` gate. The index difference
       is taken the short way round the lap so the finish-line wrap is not a
       new corner. */
    this.cornerT -= dt;
    let di = cornerIdx - this.lastCornerIdx;
    if (di < 0) di += rn;
    if (di > rn - di) di = rn - di;
    const limited = vTarget < here.speed * lineScale * CORNER_GATE;
    if (limited && di > 3 && this.cornerT <= 0) {
      this.cornerT = CORNER_HOLD;
      this.lastCornerIdx = cornerIdx;
      this.entryErr = (this.rng() * 2 - 1) * ENTRY_ERR * (1 - this.consistency);
      if (state === 'running' && this.mistakeT <= 0) {
        const p = (1 - this.consistency) * this.aggression *
          (rivalNear ? MISTAKE_P_NEAR : MISTAKE_P_FAR);
        if (this.rng() < p) this.mistakeT = MISTAKE_T;
      }
    }
    vTarget *= 1 + this.entryErr;

    // the topSpeed cap the balancing acts on — never the vehicle itself
    const capV = this.topSpeed * this.balanceF * (state === 'finished' ? FINISH_SCALE : 1);
    if (vTarget > capV) vTarget = capV;

    /* Gap jumps: the line already carries the speed that clears them, so the
       only way to fall in the hole is our own skill scaling. Floor it. */
    const floor = rt.gapFloor[this.ri];
    if (floor > 0) {
      const fv = floor * GAP_FRAC;
      if (vTarget < fv) vTarget = fv;
    }

    /* --- 8. throttle / brake --- */
    let throttle, brake = 0;
    const dv = spd - vTarget;
    if (this.braking) { if (dv < BRK_OUT) this.braking = false; }
    else if (dv > BRK_IN) this.braking = true;

    if (vTarget >= FULL_COMMIT * this.topSpeed && !this.braking) {
      throttle = 1;                                   // full commitment
    } else if (this.braking) {
      brake = clamp((dv - BRK_OUT) * BRK_P, 0.12, 1);
      throttle = 0;
    } else {
      throttle = clamp(THR_BASE - dv * THR_P, 0, 1);
    }

    /* Never brake-check a car we are catching: lift instead. Aggressive
       drivers lift later and lean on people; that is the point of them. */
    const liftD = LIFT_BASE - LIFT_AGGR * this.aggression;
    if (aheadDist < liftD && aheadClosing > 0.5 && !jumpCommit) {
      if (throttle > LIFT_THROTTLE) throttle = LIFT_THROTTLE;
    }

    /* --- 9. steering: pure pursuit at the lookahead --- */
    const ld = clamp(LOOK_BASE + vAbs * LOOK_K, LOOK_MIN, LOOK_MAX);
    let tx, tz;
    if (jumpNear && jumpDist < ld) {
      /* Square up to the lip. No apex offset, no overtaking line: landing
         crooked off a 3.6 m kicker is worse than any position you gain. */
      tx = jumpX; tz = jumpZ;
    } else {
      this._targetAt(ld);
      const off = jumpNear ? 0 : this.offset;
      tx = this._tx + this._ttz * off;
      tz = this._tz - this._ttx * off;
    }

    const dx = tx - px, dz = tz - pz;
    const fl = dx * fx + dz * fz;
    const ll = dx * fz - dz * fx;               // + = target is to my LEFT
    const ld2 = dx * dx + dz * dz;
    // The rack the CAR will actually give me at this speed (config.js taper).
    const lock = Math.max(0.02, this.lockScale * TUNE.steer.maxLock *
      lerp(1, TUNE.steer.speedTaper,
        Math.pow(Math.min(1, vAbs / this.topSpeed), TUNE.steer.taperShape)));
    let steer;
    if (fl < 0.5 || ld2 < 0.25) {
      steer = ll > 0 ? -1 : 1;                  // target behind: full lock at it
    } else {
      // + steer is RIGHT (vehicle.js: "−1..1 rack position (right positive)")
      const delta = -Math.atan(2 * this.wheelbase * ll / ld2);
      steer = clamp(delta / lock, -1, 1);
    }
    if (steer < STEER_DEAD && steer > -STEER_DEAD) steer = 0;

    /* Slow wander so laps are not carbon copies. sqrt(dt) keeps the diffusion
       frame-rate independent; the pull term gives it a ±0.02 envelope. */
    this.bias += (this.rng() - 0.5) * BIAS_WALK * Math.sqrt(dt);
    this.bias -= this.bias * BIAS_PULL * dt;
    const bmax = BIAS_MAX * (0.4 + 0.6 * (1 - this.consistency));
    this.bias = clamp(this.bias, -bmax, bmax);
    steer = clamp(steer + this.bias, -1, 1);

    /* --- 10. jump commit: hold the throttle, drop everything else --- */
    if (jumpCommit) {
      if (!this.jumpLatched) { this.jumpLatched = true; this.throttleHold = throttle; }
      throttle = this.throttleHold;
      brake = 0;
    } else {
      this.jumpLatched = false;
    }

    /* --- 11. airborne: the car self-aligns; do not help it --- */
    if (airborne && airTime > AIR_MIN_T) {
      steer = 0;
      throttle = AIR_THROTTLE;
      brake = 0;
      this.steerOut *= Math.max(0, 1 - 8 * dt);
    }

    /* --- 12. race state overrides --- */
    if (state === 'countdown') {
      this.wasCountdown = true;
      this.launchT = -1;
      const toGo = this._toGo(ctx);
      // Load the drivetrain against the brakes for the last beat.
      throttle = toGo <= PRESTAGE ? 1 : 0;
      brake = 1;
      steer = 0;
      this.steerOut = 0;
      this.braking = false;
    } else if (state === 'running' && this.wasCountdown) {
      if (this.launchT < 0) this.launchT = 0;
      this.launchT += dt;
      if (this.launchT < this.reaction) {
        throttle = 0; brake = 0; steer = 0;      // human-ish delay off the line
      } else if (this.launchT > 4) {
        this.wasCountdown = false;
      }
    }

    /* --- 13. recovery --- */
    if (flipped) this.flipT += dt; else this.flipT = 0;
    if (state === 'countdown') {
      this.stuckT = 0;
    } else if (Math.abs(spd) < TUNE.reset.stuckSpeed && Math.abs(this.ctl.throttle) > 0.5) {
      this.stuckT += dt;
    } else if (Math.abs(spd) > TUNE.reset.stuckSpeed) {
      this.stuckT = 0;
    }
    if (this.offCourseD > OFF_LINE_D && !this.onShortcut && !airborne) this.offT += dt;
    else this.offT = 0;

    const flipLimit = TUNE.reset.flipTime, stuckLimit = TUNE.reset.stuckTime;
    const inFlipRecover = this.flipT > flipLimit - RECOVER_T && this.flipT <= flipLimit;
    const inStuckRecover = this.stuckT > stuckLimit - RECOVER_T && this.stuckT <= stuckLimit;
    this.recovering = (inFlipRecover || inStuckRecover) && state !== 'countdown';
    if (this.recovering) {
      /* Reverse out of it, steering the way that points the nose back at the
         line when we go forward again — which is the mirror of the pursuit
         command, because we are travelling backwards. */
      throttle = RECOVER_THR;
      brake = 0;
      steer = -steer;
      this.braking = false;
    }
    if (state !== 'countdown' &&
      (this.flipT > flipLimit || this.stuckT > stuckLimit || this.offT > OFF_LINE_T)) {
      this.wantsReset = true;
    } else if (this.wantsReset && this.flipT === 0 && this.stuckT === 0 && this.offT === 0) {
      /* Every condition cleared on its own (we drove out of it, or the race
         flow respawned us without calling notifyReset). Un-latch rather than
         ask forever — a stuck `wantsReset` would respawn a healthy car every
         frame if the caller polls it. */
      this.wantsReset = false;
    }

    /* --- 13b. power-ups ---
       WRITE-ONLY to the latch. This block must never touch ctl, steerOut,
       braking or offset, and it early-returns the moment `ctx.item` is
       absent — which is what makes it completely inert inside
       dev/ai-check.mjs, whose ctx is literally `{ state, vehicles }`. All
       twenty of that suite's gates, its 50 µs/driver budget and its
       allocation gate are untouched by construction.

       Four times a second, not every frame: the decision is "is now a good
       moment", and asking sixty times a second only makes it noisier. Rolled
       from `this.rng`, never Math.random — dev/qa-drive.js compares lap times
       between builds and the props.js hash2 comment is explicit that
       unseeded noise at this scale hides real regressions. */
    const item = ctx && ctx.item;
    if (item !== undefined && item !== null && item >= 0 && state === 'running') {
      this.fireT -= dt;
      if (this.fireT <= 0 && !this.wantsFire) {
        this.fireT = 1 / AI_ITEM.hz;
        this._decideFire(item, spd);
      }
    } else if (item === undefined || item === null || item < 0) {
      this.wantsFire = false;
    }

    /* --- 14. rate-limit our own output and ship it --- */
    const srate = STEER_RATE * dt;
    this.steerOut += clamp(steer - this.steerOut, -srate, srate);
    this.steerOut = clamp(this.steerOut, -1, 1);

    ctl.throttle = clamp(throttle, -1, 1);
    ctl.steer = this.steerOut;
    ctl.brake = clamp(brake, 0, 1);
    ctl.handbrake = 0;      // the countersteer assist is better than we are
    // NaN guard: one bad frame must not poison the physics for the rest of
    // the race. Cheap, and it has caught a divide-by-zero in testing.
    if (!(ctl.throttle === ctl.throttle)) ctl.throttle = 0;
    if (!(ctl.steer === ctl.steer)) { ctl.steer = 0; this.steerOut = 0; }
    if (!(ctl.brake === ctl.brake)) ctl.brake = 0;
    return ctl;
  }

  /* ---------------- helpers ---------------- */

  /** Interpolated route point `dd` metres ahead → _tx/_tz + unit tangent. */
  _targetAt(dd) {
    const R = this.route, pts = R.pts, n = R.n;
    let j = this.ri, da = this._ahead(j), guard = 0;
    let b = j;
    while (guard++ < n) {
      b = (j + 1) % n;
      const db = this._ahead(b);
      if (db >= dd || db < da) {
        const t = db > da ? clamp((dd - da) / (db - da), 0, 1) : 0;
        const A = pts[j], B = pts[b];
        this._tx = A.x + (B.x - A.x) * t;
        this._tz = A.z + (B.z - A.z) * t;
        let ex = B.x - A.x, ez = B.z - A.z;
        const m = Math.sqrt(ex * ex + ez * ez) || 1;
        this._ttx = ex / m; this._ttz = ez / m;
        return;
      }
      j = b; da = db;
    }
    this._tx = pts[b].x; this._tz = pts[b].z;
    this._ttx = 0; this._ttz = 1;
  }

  /** skill × per-corner error × balancing × finished-cruise. */
  _lineScale(state) {
    let sc = SKILL_LO + (SKILL_HI - SKILL_LO) * this.skill;
    sc *= this.balanceF;
    if (state === 'finished') sc *= FINISH_SCALE;
    return sc;
  }

  _toGo(ctx) {
    if (!ctx) return Infinity;
    if (typeof ctx.toGo === 'number') return ctx.toGo;
    if (typeof ctx.goAt === 'number' && typeof ctx.now === 'number') return ctx.goAt - ctx.now;
    if (typeof ctx.countdown === 'number' && ctx.countdown >= 0) return ctx.countdown;
    return Infinity;
  }

  _balance(dt, ctx) {
    if (!AI_BALANCE.enabled) { this.balanceF = 1; return; }
    let pos = 0;
    if (ctx && typeof ctx.position === 'number') pos = ctx.position;
    else if (ctx && ctx.tracker && typeof ctx.tracker.standings === 'function') {
      /* standings() builds an array. Twice a second is invisible next to a
         physics step and keeps update() itself allocation-free. */
      this.posSample -= dt;
      if (this.posSample <= 0) {
        this.posSample = 0.5;
        const st = ctx.tracker.standings();
        for (let i = 0; i < st.length; i++) {
          if (st[i] === (ctx.myId !== undefined ? ctx.myId : this.id)) { pos = i + 1; break; }
        }
        this.position = pos;
      } else pos = this.position;
    }
    let want = 1;
    if (pos > 0) {
      const t = clamp((pos - 1) / Math.max(1, AI_BALANCE.field - 1), 0, 1);
      want = clamp(lerp(AI_BALANCE.leader, AI_BALANCE.trailing, t),
        Math.min(AI_BALANCE.leader, AI_BALANCE.trailing),
        Math.max(AI_BALANCE.leader, AI_BALANCE.trailing));
    }
    const k = Math.min(1, dt / Math.max(0.05, AI_BALANCE.ease));
    this.balanceF += (want - this.balanceF) * k;
  }

  /** Entry window decision + the two route swaps. */
  _shortcut(state) {
    const R = this.R;
    if (!R.hasShortcut) return;

    if (this.route === R.alt) {
      const inSc = this.ri >= R.e0 && this.ri < R.e0 + R.scN;
      this.onShortcut = inSc;
      // rejoined: hand back to the main route so the next lap re-decides
      if (this.ri >= R.e0 + R.scN + 2) {
        this.ri = this.ri - R.e0 - R.scN + R.e1;
        this.route = R.main;
        this.onShortcut = false;
        this.scCommitted = false;
      }
      return;
    }
    this.onShortcut = false;

    // re-arm well away from the window
    let toEntry = R.entryS - this.s;
    if (toEntry < -R.L * 0.5) toEntry += R.L;
    if (toEntry > R.L * 0.5) toEntry -= R.L;
    if (toEntry > SHORTCUT_WIN0 + 60 || toEntry < -(R.exitS - R.entryS) - 60) {
      this.scDecided = false;
      this.scCommitted = false;
    }
    if (this.scDecided || state === 'finished') return;
    if (toEntry > SHORTCUT_WIN0 || toEntry < SHORTCUT_WIN1) return;
    if (this.ri >= R.e0) return;               // already past the split

    this.scDecided = true;
    if (this.rng() < AI_SHORTCUT.base + AI_SHORTCUT.skill * this.skill) {
      this.scCommitted = true;
      this.route = R.alt;                      // indices below e0 are shared
    }
  }
}

/* ============================================================
   GRID PROFILES
   ------------------------------------------------------------
   difficulty01 slides the whole field; the spread inside it is fixed so
   there is always a front-runner to chase and a backmarker to catch.
   Deterministic for a given rng.
   ============================================================ */
const NAMES = [
  'VOSS', 'KIRA MOSS', 'DUSTY REN', 'MAREK HALL', 'NAVA OKO', 'TOBIN GRAY',
  'SILT', 'RENZO PIKE', 'ASHE VANCE', 'BRICK LOMAX', 'GRAV', 'JUNO REYES',
];

export function makeGridProfiles(count, difficulty01, rng) {
  const r = typeof rng === 'function' ? rng : Math.random;
  const d = clamp(difficulty01 === undefined ? 0.5 : difficulty01, 0, 1);
  const cnt = Math.max(1, count | 0);
  const base = 0.30 + 0.55 * d;              // difficulty 0 → 0.30, 1 → 0.85
  const out = new Array(cnt);

  // names without repeats, deterministic
  const pool = NAMES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }

  for (let i = 0; i < cnt; i++) {
    const ladder = cnt > 1 ? (i / (cnt - 1) - 0.5) : 0;      // −0.5 … +0.5
    const skill = clamp(base - ladder * 0.34 + (r() - 0.5) * 0.06, 0.05, 0.98);
    /* Aggression is deliberately NOT correlated with skill: a slow driver
       who will not move over is the most memorable car on the grid. */
    const aggression = clamp(0.22 + 0.56 * r() + 0.22 * d, 0, 1);
    // …consistency is, though. Fast drivers make fewer mistakes.
    const consistency = clamp(0.34 + 0.52 * skill + (r() - 0.5) * 0.16, 0.05, 0.99);
    out[i] = {
      name: pool[i % pool.length] + (i >= pool.length ? ' ' + (i + 1) : ''),
      skill, aggression, consistency,
    };
  }
  return out;
}

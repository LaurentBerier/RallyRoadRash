/* ============================================================
   RALLY ROAD RASH — AI DRIVERS
   ------------------------------------------------------------
   NO three imports. Plain math over plain numbers. The Vehicle happens to
   expose THREE vectors; we read `.x/.y/.z` off them and never construct one.
   Nothing in `update()` allocates: every scratch value is a scalar field on
   the driver, the returned `ctl` is the SAME object every frame, and the
   per-track route tables are built once and shared through a WeakMap.

   The item brain — targeting, the roster policy, the canned air tricks —
   is `ai-items.js`. This file is the driver.

   THE DRIVER MODEL IN TWELVE LINES
   --------------------------------
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
      itself; inside 12 m the throttle is frozen and the brake released.
      In the 40 m before a GAP the target is floored at 0.98× line speed
      regardless of skill — that is what makes the canyon 24.2 m/s.
   7. AIRBORNE IS ALL ZERO. Steer, throttle, brake, roll: nothing. The only
      exception is a canned trick planned at the lip (ai-items.js), which
      holds ONE input until the rotation is predicted to arrive and then
      goes hands-off too, because that tail is when the align assist runs.
   8. THERE IS EXACTLY ONE LATERAL INPUT. Overtaking, dodging a projectile
      and detouring to a box all write the same `offset`, blended over
      AVOID_BLEND. A second one would fight the first.
      Overtaking: a car ≤18 m ahead within ±3.5 m of my line earns up to
      ±min(2.8, halfWidth − 1.5) toward the freer side, dropped if they are
      pulling away; alongside (<1.9 m) adds repulsion. We lift, never
      brake-check, and aggression decides how late.
   9. Items: `ctx.items` (contract 6.7) is read-only and optional. Threats
      inside 40 m and ±2.5 m buy 1.8 m of dodge; with an empty slot and a
      clear road, the nearest box inside 120 m (or pad inside 60 m) is
      worth steering at.
  10. Routes: every entry in `trackData.routes[]` becomes one stitched
      alternate lap, decided once per approach with
      p = AI_SHORTCUT.base + aiBias·skill. See AI_SHORTCUT.
  11. Recovery: flipped > TUNE.reset.flipTime, stuck > TUNE.reset.stuckTime,
      or > 22 m off the centreline ⇒ `wantsReset`. The last 1.5 s before
      that is spent reversing and steering back at the line, which quite
      often works and always looks alive.
  12. Balancing is a cap on MY speed targets, never on the vehicle:
      `AI_BALANCE.enabled = false` disables it completely, and the factor is
      linear in race position (P1 → 0.985, P6 → 1.015, hard-clamped whatever
      the field size, eased over 1.5 s so it is never a step in the
      throttle). It multiplies the line speeds and the topSpeed cap this
      driver aims for, and touches nothing the player can feel. Position
      comes from `ctx.position`, else from a 2 Hz `ctx.tracker` sample (see
      _standings, which the item brain needs anyway), else the factor is 1.
   ============================================================ */

import { paintAt } from '../world/track.js';
import { SURFACES } from '../world/surfaces.js';
import { G, TUNE } from './config.js';
import {
  AI_ITEM, decideFire, validateFire, itemStyleFor,
  predictAirTime, rollTrickIntent, planAirTrick, stepAirTrick, clearAirTrick,
  TRICK_PLAN,
} from './ai-items.js';

/* The item brain lives in ai-items.js — targeting, the roster policy and the
   canned air tricks. Re-exported so nothing outside has to know it moved. */
export { AI_ITEM, ITEM_STYLE, itemStyleFor, TRICKS_AVAILABLE } from './ai-items.js';

/* ---------------------------------------------------------------
   The balancing knob. Documented above; exported so the integrator can
   flip it off from one place without touching driver code.
   --------------------------------------------------------------- */
export const AI_BALANCE = {
  enabled: true,
  leader: 0.985,      // multiplier on speed targets for P1
  trailing: 1.015,    // …and for P6 (or last, if the field is smaller)
  field: 6,           // position that reaches `trailing`
  ease: 1.5,          // s — time constant so the factor never steps
};

/* ---------------------------------------------------------------
   Route take-up: p = base + aiBias·skill, decided once per lap approach.
   `skill` here is only the DEFAULT bias, used by a route that publishes
   none — the two authored detours pull in OPPOSITE directions and a single
   global cannot say that:

     TIMBERLINE CLIMB  high route  −0.3 s/lap  (worth taking)
     SUNSTRIKE CANYON  slot canyon +2.8 s/lap  (the gap jump is the fast way)

   measured by dev/ai-check.mjs at skill 0.9. At 0.25 + 0.6·skill the
   quickest drivers take the canyon detour ~82 % of the time and give away
   five per cent of the lap for it; a NEGATIVE `aiBias` makes take-up fall
   with ability, which is the behaviour that track wants. `enabled` is the
   hard off switch the dev checks use — with per-route biases, zeroing
   `base`/`skill` no longer disables anything.
   --------------------------------------------------------------- */
export const AI_SHORTCUT = { enabled: true, base: 0.25, skill: 0.60 };

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
const AIR_MIN_T = 0.12;       // s airborne before the air policy takes over —
                              //   below it every rut would zero the steering
/* Landing-height probe: how far past the lip to sample the route for the
   ground the car is actually going to meet. 45 m is roughly one second of
   flight at jump speeds — far enough past the void to be real ground, near
   enough that a following corner has not moved the road sideways yet. */
const AIR_LAND_AHEAD = 45;
/* Conservative read of TUNE.air.hangGravity (0.58). The float fades in over
   hangLo..hangHi, so the first fraction of a second is at full G and a
   predictor that assumed 0.58 from t=0 would over-estimate the hang. */
const AIR_HANG = 0.7;

const THREAT_AHEAD = 40;      // m — how far up the road an incoming counts
const THREAT_LAT = 2.5;       // m — …and how close to my line
const THREAT_OFF = 1.8;       // m of lateral offset a threat is worth

const BOX_SEEK = 120;         // m ahead — worth a detour for a power-up
const PAD_SEEK = 60;          // m ahead — a pad is worth more, and closer
/* MAX_PROJ + MAX_HAZ in itemworld.js. Sized here rather than imported so
   ai.js keeps its "no three in the import graph" property. If itemworld
   grows a pool, `threats()` simply stops early — it fills to out.x.length. */
const MAX_THREATS = 20;

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

/* Module scratch for the canned-trick control, written and read inside one
   statement of update(). Shared between drivers exactly like vehicle.js's
   `_v1` — there is never a frame on which two of them hold it at once. */
const _air = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };

/* ============================================================
   ROUTES — built once per trackData, shared by every driver.
   ------------------------------------------------------------
   A route is `{ pts, n, cum, len, gapFloor }` where `cum[i]` is the true
   3-D distance from pts[0] round to pts[i]. Distances come from the
   geometry, not from an assumed 6 m stride, because buildTrackData rounds
   the stride to L / round(L / 6) and the offset line is not the centreline.

   `main` is trackData.racingLine untouched (we never mutate T1's data);
   each entry of `alts[]` is one stitched alternate lap — main to the split,
   our own samples of that route's spline, main from the rejoin. Contract
   6.1's `routes[]` and the legacy `shortcut` + `shortcutSpline` pair are
   BOTH read; a track with neither gets `alts.length === 0`.
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

/**
 * Raise `out[i]` to the line speed everywhere inside the GAP_WIN run-up to a
 * gap jump. Works on ANY point array — main line or stitched alternate —
 * because every point carries its own `s`. `lo`/`hi` restrict which indices
 * a jump may CLAIM as its lip; the backward walk that lays the run-up down
 * crosses that boundary freely, because a jump 10 m after a rejoin still
 * needs an approach and that approach is on the detour.
 */
function applyGapFloor(pts, out, jumps, L, lo, hi) {
  if (!jumps || !jumps.length) return out;
  const n = pts.length;
  for (let k = 0; k < jumps.length; k++) {
    const j = jumps[k];
    if (!(j.gap > 0)) continue;
    let li = -1, bd = Infinity;
    for (let i = lo; i < hi; i++) {
      let d = Math.abs(pts[i].s - j.s);
      if (d > L * 0.5) d = L - d;
      if (d < bd) { bd = d; li = i; }
    }
    if (li < 0) continue;
    if (out[li] < pts[li].speed) out[li] = pts[li].speed;
    let d = 0, i = li;
    while (d < GAP_WIN) {
      const p = (i - 1 + n) % n;
      d += Math.hypot(pts[i].x - pts[p].x, pts[i].y - pts[p].y, pts[i].z - pts[p].z);
      if (out[p] < pts[p].speed) out[p] = pts[p].speed;
      i = p;
      if (i === li) break;
    }
  }
  return out;
}

/** Distance floor to hold in the run-up to a GAP jump, per main-line index. */
function buildGapFloor(trackData, rl) {
  const L = trackData.lapLength || trackData.spline.length;
  return applyGapFloor(rl, new Float32Array(rl.length), trackData.jumps || [], L, 0, rl.length);
}

/**
 * Every alternate route a track publishes, in the shape the AI wants.
 * Accepts the wave-6 `routes[]` and falls back to the legacy single
 * `shortcut` + `shortcutSpline` pair.
 */
function routeDefs(trackData) {
  const out = [];
  const R = trackData.routes;
  if (R && R.length) {
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      if (!r || !r.spline || !(r.s1 > r.s0)) continue;
      out.push({
        id: r.id || ('route' + i), spline: r.spline,
        s0: r.s0, s1: r.s1, aiBias: r.aiBias, jumps: r.jumps || null,
      });
    }
    if (out.length) return out;
  }
  const def = trackData.def;
  const sc = def && def.shortcut;
  const ss = trackData.shortcutSpline;
  if (ss && sc && sc.s1 > sc.s0) {
    out.push({ id: 'shortcut', spline: ss, s0: sc.s0, s1: sc.s1, aiBias: undefined, jumps: null });
  }
  return out;
}

/** Stitch one alternate lap, or null if its span will not splice cleanly. */
function buildAlt(trackData, rl, gapFloor, step, L, rd) {
  const N = rl.length;
  const def = trackData.def;
  /* A route whose span wraps the finish line would need the stitch to wrap
     too. No authored track does it; refusing is cheaper and safer than a
     branch nobody exercises. */
  const entryS = rd.s0, exitS = rd.s1, span = exitS - entryS;
  let e0 = 0; while (e0 < N && rl[e0].s < entryS) e0++;
  let e1 = 0; while (e1 < N && rl[e1].s <= exitS) e1++;
  if (e0 < 2 || e1 >= N - 1 || e1 <= e0) return null;

  const ss = rd.spline;
  const SL = ss.length;
  const scN = Math.max(4, Math.round(SL / step));
  const ds = SL / scN;
  const pts = new Array(scN);
  const tmp = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < scN; i++) {
    const t = i * ds;
    ss.posAt(t, tmp);
    /* The terrain bake carves the detour with s = s0 + fraction·span (see
       terrain-bake.js carveInto), so painting it at the same s is what puts
       the AI on the same surface the physics will report. */
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

  // stitch: main[0 … e0) + route samples + main[e1 … N)
  const alt = new Array(e0 + scN + (N - e1));
  const altFloor = new Float32Array(alt.length);
  let w = 0;
  for (let i = 0; i < e0; i++) { alt[w] = rl[i]; altFloor[w] = gapFloor[i]; w++; }
  for (let i = 0; i < scN; i++) { alt[w] = pts[i]; altFloor[w] = 0; w++; }
  for (let i = e1; i < N; i++) { alt[w] = rl[i]; altFloor[w] = gapFloor[i]; w++; }

  /* The detour has its own gap jumps (contract 6.1: route jumps are always
     cp:false, so nothing else in the pipeline will have flagged them) and a
     route sample carries no `jump` flag of its own. Without this the AI
     would brake for the run-up to a canyon gap it is about to fly. */
  applyGapFloor(alt, altFloor, rd.jumps, L, e0, e0 + scN);

  return {
    id: rd.id, route: makeRoute(alt, altFloor),
    /* The detour's OWN centreline, carried through so the alt can say which
       road it is. Without it the only spline anyone could ask for was
       trackData.shortcutSpline — routes[0] — and anything measuring a driver
       on routes[1] was measuring it against a road it had never been on. */
    spline: rd.spline,
    e0, e1, scN, entryS, exitS,
    aiBias: (rd.aiBias === undefined || rd.aiBias === null) ? null : rd.aiBias,
  };
}

function buildRoutes(trackData) {
  const rl = trackData.racingLine;
  const N = rl.length;
  const L = trackData.lapLength || trackData.spline.length;
  const gapFloor = buildGapFloor(trackData, rl);
  const main = makeRoute(rl, gapFloor);

  const R = { L, step: L / N, main, alts: [], hasShortcut: false };

  const defs = routeDefs(trackData);
  for (let i = 0; i < defs.length; i++) {
    const a = buildAlt(trackData, rl, gapFloor, R.step, L, defs[i]);
    if (a) R.alts.push(a);
  }
  R.hasShortcut = R.alts.length > 0;
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
    /* Returned every frame — the race flow consumes it immediately.
       `roll` per contract 6.4: EVERY copy site has to carry it or the trick
       modifier works in the dev check and silently not in the game. */
    this.ctl = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };

    /* Item firing, latched exactly like `wantsReset`: this driver never acts,
       it only ever raises a hand, and race.js polls it. Keeping it out of
       `ctl` is deliberate — ctl is copied through three separate scratch
       objects and a sixth field would be silently dropped by all of them. */
    this.wantsFire = false;
    this.fireBack = false;
    this.fireT = 0;
    this._fireItem = -1;
    this.itemStyle = p.itemStyle || itemStyleFor(p);
    this.itemAge = 0;         // s the current item has been held
    this.sinceFire = 99;      // s since the last shot (the triple's spacing)
    this._lastItem = -1;

    /* THE TARGETING BLOCK, cleared at the top of every rival scan. The
       previous version only ever wrote these DOWNWARD, so one close pass on
       lap one latched a finite distance and every shot for the rest of the
       race went at a car that had gone. The other three turn "somebody is
       there" into a firing solution. */
    this._shotAhead = Infinity;      // m to the nearest recorded car ahead
    this._shotIdx = -1;              // …its index in ctx.vehicles
    this._shotLat = 0;               // m, + = to my LEFT
    this._shotClosing = 0;           // m/s, my speed − theirs along my forward
    this._shotTheirLat = 0;          // m/s of THEIR lateral drift in my frame
    this._shotBehind = Infinity;     // the same five, mirrored behind me
    this._shotIdxB = -1;
    this._shotLatB = 0;
    this._shotClosingB = 0;
    this._shotTheirLatB = 0;

    /* Race standings, sampled at 2 Hz (see _standings). The item brain needs
       all three and none of them is worth a per-frame tracker query. */
    this.gapAheadSec = Infinity;
    this.behindSec = 0;

    /* Caller-owned scratch for the two read-only ItemWorld accessors. Both
       are filled in place; nothing here is ever reallocated. */
    this._threats = {
      n: 0,
      x: new Float32Array(MAX_THREATS), z: new Float32Array(MAX_THREATS),
      vx: new Float32Array(MAX_THREATS), vz: new Float32Array(MAX_THREATS),
      r: new Float32Array(MAX_THREATS), kind: new Int8Array(MAX_THREATS),
    };
    this._box = { found: 0, s: 0, lat: 0, x: 0, z: 0, dist: -1 };
    this._pad = { found: 0, s: 0, lat: 0, x: 0, z: 0, dist: -1 };
    this.threatOff = 0;       // telemetry: the dodge component of `offset`
    this.seekOff = 0;         // …and the box/pad component

    /* Canned air tricks (ai-items.js). All of it cleared by notifyReset. */
    this.trickPlan = TRICK_PLAN.NONE;
    this.trickTarget = 0;     // rad of rotation the release is waiting for
    this.trickDir = 0;
    this._spunLast = 0;       // rad turned as of last frame
    this._spinRate = 0;       // …smoothed rad/s, which is what extrapolates
    this.trickIntent = false;
    this._trickJump = null;
    this._airPlanned = false;
    this._airWas = false;
    this._airVy = 0;
    this._airLandY = 0;
    this._tAir = 0;           // telemetry: the predicted hang time

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

    // --- alternate routes ---
    this.scCommitted = false;
    this.scDecided = false;
    this.onShortcut = false;
    this.scIdx = -1;                     // which alts[] entry we are on/deciding
    /* One "already decided this approach" flag per route, so two routes whose
       entry windows overlap cannot re-roll each other. Allocated once. */
    this._scDone = new Uint8Array(Math.max(1, this.R.alts.length));

    // --- recovery ---
    this.wantsReset = false;
    this.flipT = 0;
    this.stuckT = 0;
    this.offT = 0;
    this.recovering = false;
  }

  /** race.js consumed the fire request. */
  notifyFired() {
    this.wantsFire = false; this.fireBack = false; this.fireT = 0;
    this._fireItem = -1;
    this.sinceFire = 0;       // the triple's minimum spacing runs off this
  }

  /** Race flow calls this once it has actually performed the respawn. */
  notifyReset() {
    this.wantsReset = false;
    this.wantsFire = false; this.fireBack = false; this.fireT = 0;
    this._fireItem = -1;
    this.flipT = 0; this.stuckT = 0; this.offT = 0;
    this.recovering = false;
    this.offset = 0; this.offsetTarget = 0; this.avoidHold = 0;
    this.threatOff = 0; this.seekOff = 0;
    this.steerOut = 0; this.braking = false; this.mistakeT = 0;
    this.entryErr = 0; this.bias = 0; this.jumpLatched = false;
    this.lastCornerIdx = 0; this.cornerT = 0;
    this.route = this.R.main;
    this.scCommitted = false; this.onShortcut = false; this.scDecided = false;
    this.scIdx = -1;
    this._shotAhead = Infinity; this._shotBehind = Infinity;
    this._shotIdx = -1; this._shotIdxB = -1;
    /* A teleport invalidates a flip in progress as surely as it invalidates
       a route projection: the car is somewhere else, at rest, on the ground. */
    clearAirTrick(this);
    this.ri = -1;             // force a full re-acquire next update
    this.ctl.throttle = 0; this.ctl.steer = 0;
    this.ctl.brake = 0; this.ctl.handbrake = 0; this.ctl.roll = 0;
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

    /* --- 2. route bookkeeping. Runs BEFORE _track because it can swap
       `this.route` out from under it; it reads last frame's `ri`, which is a
       frame of lag on a decision taken 20-90 m before the split. */
    this._routes(state);

    /* --- 3. route index + projection --- */
    this._track(px, pz, dt, spd);
    const rt = this.route, pts = rt.pts, rn = rt.n;
    const here = pts[this.ri];

    /* --- 4. balancing factor + the 2 Hz standings sample --- */
    this._balance(dt, ctx);

    /* --- 5. jumps: is a lip coming, and is it a gap? ---
       Hoisted above the rivals because the item-world detour in 6b has to
       know: nothing on this road is worth swerving for with a kicker 30 m
       away, and a box tucked against the verge on a jump approach is how a
       car lands sideways. */
    let jumpDist = Infinity, jumpX = 0, jumpZ = 0, jumpObj = null;
    if (!this.scCommitted && !this.onShortcut) {
      const J = this.trackData.jumps;
      if (J) {
        for (let i = 0; i < J.length; i++) {
          let d = J[i].s - this.s;
          if (d < -this.lapLength * 0.5) d += this.lapLength;
          if (d > this.lapLength * 0.5) d -= this.lapLength;
          if (d >= -2 && d < jumpDist) {
            jumpDist = d; jumpX = J[i].x; jumpZ = J[i].z; jumpObj = J[i];
          }
        }
      }
    }
    const jumpNear = jumpDist < JUMP_NEAR;
    const jumpCommit = jumpDist < JUMP_COMMIT;

    /* --- 6. rivals: blockers, side-by-side, the mistake trigger ---
       Two questions with different answers. `holdDist/holdSide` is "do I
       need to be somewhere else laterally", counted from 2.5 m BEHIND my
       axle forward so the offset survives being alongside — dropping it the
       moment the pass starts is what turns an overtake into a side-swipe.
       `aheadDist/closing` is "am I about to run into the back of someone",
       strictly ahead, and it only ever lifts. */
    let rivalNear = false, aheadDist = Infinity, aheadClosing = 0;
    let wantOff = 0, blocked = false;
    const myIdx = (ctx && ctx.myId !== undefined) ? ctx.myId : this.id;
    /* THE LATCH FIX. Cleared at the TOP of the scan, every frame, whether or
       not the scan then runs — a `finished` state or a missing ctx.vehicles
       must leave no target standing either. Everything below only ever
       narrows these; nothing else in the file writes them. */
    this._shotAhead = Infinity; this._shotIdx = -1;
    this._shotLat = 0; this._shotClosing = 0; this._shotTheirLat = 0;
    this._shotBehind = Infinity; this._shotIdxB = -1;
    this._shotLatB = 0; this._shotClosingB = 0; this._shotTheirLatB = 0;
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
        const theirFwd = o.vel ? o.vel.x * fx + o.vel.z * fz : 0;
        const closing = spd - theirFwd;
        /* Free targeting data, inside a loop that already runs. `fl`, `ll`
           and the two velocity projections are exactly what a lead-aim
           solution needs, and three of the four are computed here anyway for
           the blocker logic. `latGate` is a RECORD band, not an aim test —
           ai-items.js aimOk() is the only place a miss distance exists. */
        const al = ll < 0 ? -ll : ll;
        if (al < AI_ITEM.latGate) {
          const theirLat = o.vel ? o.vel.x * fz - o.vel.z * fx : 0;
          if (fl > AI_ITEM.aheadMin && fl < AI_ITEM.aheadMax && fl < this._shotAhead) {
            this._shotAhead = fl; this._shotIdx = i;
            this._shotLat = ll; this._shotClosing = closing; this._shotTheirLat = theirLat;
          }
          if (-fl > AI_ITEM.behindMin && -fl < AI_ITEM.behindMax && -fl < this._shotBehind) {
            this._shotBehind = -fl; this._shotIdxB = i;
            this._shotLatB = ll; this._shotClosingB = closing; this._shotTheirLatB = theirLat;
          }
        }
        if (fl > AVOID_AHEAD || fl < -6 || ll > latGate || ll < -latGate) continue;

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
      blocked = holdDist < Infinity || push !== 0;
      const maxOff2 = Math.min(AVOID_MAX + SIDE_PUSH, Math.max(0.5, halfW - 1.2));
      wantOff = clamp(wantOff, -maxOff2, maxOff2);
    } else {
      this.avoidHold = 0;
    }

    /* --- 6b. the item world: dodge what is coming, collect what is not ---
       Both go through the SAME lateral machinery as a blocker: there is one
       input for "be somewhere else on the road" and a second would fight it
       (header, point 8). `ctx.items` is optional — without it the whole
       block costs one property read. */
    const io = ctx && ctx.items;
    let threatOff = 0, seekOff = 0;
    if (io && state !== 'finished') {
      /* Dodging. An incoming spare wheel or a slick on the line is worth
         1.8 m — enough to miss a 2.6 m hazard from the centre of it, not so
         much that a driver throws itself off the road to avoid a projectile
         that was never going to arrive. */
      if (typeof io.threats === 'function') {
        const T = io.threats(this._threats);
        let bestD = Infinity, bestLat = 0;
        for (let i = 0; i < T.n; i++) {
          const dx = T.x[i] - px, dz = T.z[i] - pz;
          const fl = dx * fx + dz * fz;
          if (fl < 0 || fl > THREAT_AHEAD) continue;
          const ll = dx * fz - dz * fx;
          const al = ll < 0 ? -ll : ll;
          if (al > THREAT_LAT + T.r[i]) continue;
          if (fl < bestD) { bestD = fl; bestLat = ll; }
        }
        if (bestD < Infinity) {
          /* WHICH WAY. Reading the side off the sign of `bestLat` is right
             for a threat that is off to one side and catastrophic for one
             that is dead on the nose: that sign oscillates around zero,
             flips the offset target ±1.8 m every frame, and the blend never
             gets anywhere — the car dithers down the road and drives
             straight into it. So below a real lateral, KEEP last frame's
             side, and with no last frame take the wider half of the road. */
          let side;
          if (bestLat > 0.35 || bestLat < -0.35) side = bestLat >= 0 ? 1 : -1;
          else if (this.threatOff !== 0) side = this.threatOff > 0 ? -1 : 1;
          else side = (here.lat || 0) >= 0 ? 1 : -1;
          threatOff = -side * THREAT_OFF;
          this.avoidHold = AVOID_BLEND;   // hold it through the pass, as a blocker does
        }
      }
      /* Box and pad seeking, only with a clear road and nothing in hand.
         A pad wins inside PAD_SEEK because it is worth a boost NOW and the
         box is worth a lottery ticket in a hundred metres. */
      const haveItem = typeof io.hasItem === 'function' && io.hasItem(myIdx);
      if (!haveItem && !blocked && threatOff === 0 && !jumpNear) {
        let want = null;
        if (typeof io.nearestPad === 'function') {
          const p = io.nearestPad(myIdx, this._pad);
          if (p && p.found && p.dist >= 0 && p.dist < PAD_SEEK) want = p;
        }
        if (!want && typeof io.nearestBox === 'function') {
          const b = io.nearestBox(myIdx, this._box);
          if (b && b.found && b.dist >= 0 && b.dist < BOX_SEEK) want = b;
        }
        if (want) {
          const room = Math.max(0.5, halfW - 1.2);
          const baseLat = here.lat || 0;
          seekOff = clamp(clamp(want.lat, -room, room) - baseLat, -AVOID_MAX, AVOID_MAX);
        }
      }
    }
    this.threatOff = threatOff;
    this.seekOff = seekOff;
    wantOff += threatOff + seekOff;
    {
      const cap = Math.min(AVOID_MAX + SIDE_PUSH + THREAT_OFF, Math.max(0.5, halfW - 1.2));
      wantOff = clamp(wantOff, -cap, cap);
    }

    this.offsetTarget = wantOff;
    const orate = (AVOID_MAX / AVOID_BLEND) * dt;
    this.offset += clamp(this.offsetTarget - this.offset, -orate, orate);

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
       `cornerIdx` is whatever is limiting me; through an APPROACH it locks
       onto one point and does not move, so this fires once per corner. On a
       straight nothing is limiting — the `limited` gate is the other half
       of "per corner". The index difference is taken the short way round so
       the finish-line wrap is not a new corner. */
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
      if (!this.jumpLatched) {
        this.jumpLatched = true;
        this.throttleHold = throttle;
        /* Lip commit is the last moment a trick decision is still cheap: the
           car is on the ground, the lip is known, and a "no" costs nothing.
           Deciding in the air instead would mean re-rolling every frame. */
        this.trickIntent = rollTrickIntent(this, jumpObj);
        this._trickJump = jumpObj;
      }
      throttle = this.throttleHold;
      brake = 0;
    } else {
      this.jumpLatched = false;
    }

    /* --- 11. airborne ---
       THE DEFAULT IS ALL ZERO. It used to be throttle 0.5, harmless while
       air pitch authority was small; at P4's 1.85 rad/s² that is ~58° of
       nose-up over a typical jump with nothing arguing against it, and
       every car on the grid loops. Hands off, and let TUNE.air.alignAssist
       land it — unless a trick was planned at the lip (ai-items.js). */
    let handbrake = 0, roll = 0;
    if (!airborne) {
      this._airWas = false;
      this._airPlanned = false;
      this.trickPlan = TRICK_PLAN.NONE;
      this.trickIntent = false;
      this._trickJump = null;
    } else {
      if (!this._airWas) {
        /* The TRUE first airborne frame. `vel.y` here is the launch velocity
           the ballistics need; a frame later gravity has already eaten some
           of it and the predicted hang comes out short. */
        this._airWas = true;
        this._airPlanned = false;
        this._airVy = (V.vel && V.vel.y) || 0;
      }
      if (airTime > AIR_MIN_T) {
        steer = 0;
        throttle = 0;
        brake = 0;
        this.steerOut *= Math.max(0, 1 - 8 * dt);

        /* `_trick` is P4's published rotation accumulator (contract 6.4) and
           it is the ONLY feedback the release rule has. Without it there is
           no closed loop, so there is no canned trick either — an open-loop
           hold is the version P4 measured landing 1 jump in 10. */
        const tr = V._trick || null;

        if (!this._airPlanned) {
          this._airPlanned = true;
          this._tAir = 0;
          const j = this.trickIntent ? this._trickJump : null;
          if (j && tr) {
            /* The landing is not the lip: sample the route a second of
               flight further on, so a gap or a drop is in the number. */
            this._airLandY = this._routeYAt(j.s + AIR_LAND_AHEAD);
            this._tAir = predictAirTime(this._airVy, j.y - this._airLandY, G, AIR_HANG);
            planAirTrick(this, this._tAir, tr);
          } else {
            this.trickPlan = TRICK_PLAN.NONE;
          }
        }

        if (this.trickPlan !== TRICK_PLAN.NONE && tr) {
          /* Height under the CAR, not the planned landing: a launch that
             went wrong has to abort into a landing attitude while there is
             still time, and `_airLandY` is 45 m up the road from where that
             happened. It is the fallback for a terrain-less driver. */
          const gy = (V.terrain && typeof V.terrain.heightAt === 'function')
            ? V.terrain.heightAt(V.pos.x, V.pos.z) : this._airLandY;
          const tG = predictAirTime((V.vel && V.vel.y) || 0,
            ((V.pos && V.pos.y) || 0) - gy, G, AIR_HANG);
          const spun = this.trickPlan === TRICK_PLAN.BARREL ? tr.roll : tr.pitch;
          if (stepAirTrick(this, _air, dt, airTime, spun || 0, tG)) {
            throttle = _air.throttle; steer = _air.steer; brake = _air.brake;
            handbrake = _air.handbrake; roll = _air.roll;
            /* The rack rate limit is a GROUND constraint (config.js taper).
               Airborne with the handbrake down, `steer` is a roll command,
               and ramping it in over 170 ms wastes a third of the flight. */
            this.steerOut = steer;
          }
        }
      }
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
      handbrake = 0; roll = 0;
      this.steerOut = 0;
      this.braking = false;
    } else if (state === 'running' && this.wasCountdown) {
      if (this.launchT < 0) this.launchT = 0;
      this.launchT += dt;
      if (this.launchT < this.reaction) {
        throttle = 0; brake = 0; steer = 0;      // human-ish delay off the line
        handbrake = 0; roll = 0;
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
      handbrake = 0; roll = 0;
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
       WRITE-ONLY to the latch: never ctl, steerOut, braking or offset. It
       is inert without `ctx.item`, which is what leaves every driving gate
       in dev/ai-check.mjs untouched. Decided four times a second, not sixty
       — the question is "is now a good moment" — and always from `this.rng`,
       because the QA sweep compares lap times between builds. */
    this.sinceFire += dt;
    const rawItem = ctx && ctx.item;
    const held = (rawItem === undefined || rawItem === null) ? -1 : rawItem;
    /* `itemAge` is what the hold policies are written against — a leader
       sitting on a spare wheel, a turtle sitting on an oil slick. It has to
       reset on the PICKUP, not on the fire, or a second box of the same kind
       inherits the first one's patience. */
    if (held !== this._lastItem) { this._lastItem = held; this.itemAge = 0; }
    else this.itemAge += dt;

    if (held >= 0 && state === 'running') {
      this.fireT -= dt;
      if (this.fireT <= 0 && !this.wantsFire) {
        this.fireT = 1 / AI_ITEM.hz;
        decideFire(this, held, spd, ctx);
      }
      /* Re-validated on the frame the latch is actually POLLED, not only on
         the frame it was set. race.js reads `wantsFire` immediately after
         update() returns, so a decision taken up to 1/hz seconds ago is a
         decision taken against a geometry that has since moved — the same
         class of staleness as the latch bug this replaces. */
      validateFire(this);
    } else {
      this.wantsFire = false; this.fireBack = false; this._fireItem = -1;
    }

    /* --- 14. rate-limit our own output and ship it --- */
    const srate = STEER_RATE * dt;
    this.steerOut += clamp(steer - this.steerOut, -srate, srate);
    this.steerOut = clamp(this.steerOut, -1, 1);

    ctl.throttle = clamp(throttle, -1, 1);
    ctl.steer = this.steerOut;
    ctl.brake = clamp(brake, 0, 1);
    /* On the ground: never. The countersteer assist is better than we are.
       Airborne: contract 6.10's trick modifier, and the only path by which
       this driver ever holds it. */
    ctl.handbrake = handbrake ? 1 : 0;
    ctl.roll = clamp(roll, -1, 1);
    // NaN guard: one bad frame must not poison the physics for the rest of
    // the race. Cheap, and it has caught a divide-by-zero in testing.
    if (!(ctl.throttle === ctl.throttle)) ctl.throttle = 0;
    if (!(ctl.steer === ctl.steer)) { ctl.steer = 0; this.steerOut = 0; }
    if (!(ctl.brake === ctl.brake)) ctl.brake = 0;
    if (!(ctl.roll === ctl.roll)) ctl.roll = 0;
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

  /** Height of the MAIN racing line at `s`. buildRacingLine samples at a
      uniform stride, so this is an index, not a search. */
  _routeYAt(s) {
    const R = this.R.main, pts = R.pts, n = R.n, L = this.lapLength;
    const ws = s - Math.floor(s / L) * L;
    let i = Math.round(ws / (L / n));
    if (i < 0) i = 0; else if (i >= n) i -= n;
    return pts[i] ? pts[i].y : 0;
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

  /**
   * Position, the gap to the car ahead and the gap to the leader, at 2 Hz —
   * the item brain needs all three and none is worth a per-frame query.
   * `standings()` reuses racecore's own `_order` array and `progress()` a
   * per-racer payload, so this allocates nothing; the rate limit is about
   * the sort, not about garbage.
   */
  _standings(dt, ctx) {
    this.posSample -= dt;
    if (this.posSample > 0) return;
    this.posSample = 0.5;
    const T = ctx && ctx.tracker;
    if (!T || typeof T.standings !== 'function' || typeof T.progress !== 'function') return;
    const me = ctx.myId !== undefined ? ctx.myId : this.id;
    const st = T.standings();
    let at = -1;
    for (let i = 0; i < st.length; i++) if (st[i] === me) { at = i; break; }
    if (at < 0) return;
    if (!(ctx && typeof ctx.position === 'number')) this.position = at + 1;
    const mine = T.progress(me);
    if (!mine) return;
    /* Pace, not speed: an instantaneous m/s through a hairpin would report a
       two-second gap as eight. The floor is the same 6 m/s the reset system
       calls "stopped". */
    const pace = Math.max(6, Math.abs(this.vehicle.speed) || 0, this.topSpeed * 0.45);
    const lead = T.progress(st[0]);
    this.behindSec = (lead && at > 0) ? Math.max(0, (lead.raceS - mine.raceS) / pace) : 0;
    if (at > 0) {
      const up = T.progress(st[at - 1]);
      this.gapAheadSec = up ? Math.max(0, (up.raceS - mine.raceS) / pace) : Infinity;
    } else {
      this.gapAheadSec = Infinity;
    }
  }

  _balance(dt, ctx) {
    /* The standings sample runs whatever the balancing flag says — it is the
       item brain's only source of position and gap, and turning AI_BALANCE
       off must not blind it. */
    this._standings(dt, ctx);
    if (ctx && typeof ctx.position === 'number') this.position = ctx.position;
    if (!AI_BALANCE.enabled) { this.balanceF = 1; return; }
    const pos = this.position | 0;
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

  /**
   * Alternate-route bookkeeping: one decision per approach per route (see
   * AI_SHORTCUT), and the two index swaps that follow it. Walks the whole
   * of `routes[]` rather than testing one span, per contract 6.1.
   */
  _routes(state) {
    const R = this.R;
    const A = R.alts;
    if (!A.length) return;

    // --- already on one: track it, and hand back at the rejoin ---
    if (this.scIdx >= 0 && this.route !== R.main) {
      const a = A[this.scIdx];
      this.onShortcut = this.ri >= a.e0 && this.ri < a.e0 + a.scN;
      if (this.ri >= a.e0 + a.scN + 2) {
        this.ri = this.ri - a.e0 - a.scN + a.e1;
        this.route = R.main;
        this.onShortcut = false;
        this.scCommitted = false;
        this.scIdx = -1;
      }
      return;
    }
    this.onShortcut = false;

    let inAnyWindow = false, decidedHere = false;
    for (let k = 0; k < A.length; k++) {
      const a = A[k];
      let toEntry = a.entryS - this.s;
      if (toEntry < -R.L * 0.5) toEntry += R.L;
      if (toEntry > R.L * 0.5) toEntry -= R.L;
      // re-arm well away from the window
      if (toEntry > SHORTCUT_WIN0 + 60 || toEntry < -(a.exitS - a.entryS) - 60) {
        this._scDone[k] = 0;
        continue;
      }
      if (toEntry > SHORTCUT_WIN0 || toEntry < SHORTCUT_WIN1) continue;
      inAnyWindow = true;
      if (this._scDone[k]) { decidedHere = true; continue; }
      if (state === 'finished' || !AI_SHORTCUT.enabled) { this._scDone[k] = 1; continue; }
      if (this.ri >= a.e0) { this._scDone[k] = 1; continue; }   // past the split

      this._scDone[k] = 1;
      decidedHere = true;
      /* An authored aiBias is a MULTIPLIER on the global skill knob, not a
         replacement for it. Reading it as a replacement made AI_SHORTCUT a
         half-switch: zeroing base and skill silenced the legacy shortcut but
         left every authored route firing at its own bias, so "route off" was
         not off and ai-check's gap test drove a detour it had disabled. A
         route with no authored bias behaves exactly as the single shortcut
         always did, because its multiplier is 1. */
      const bias = a.aiBias === null ? 1 : a.aiBias;
      if (this.rng() < AI_SHORTCUT.base + bias * AI_SHORTCUT.skill * this.skill) {
        this.scCommitted = true;
        this.scIdx = k;
        this.route = a.route;                  // indices below e0 are shared
        break;                                 // one detour per approach
      }
    }
    if (!inAnyWindow) this.scCommitted = false;
    /* Legacy single-route telemetry, still read by dev/ai-check.mjs and the
       QA harness: "a decision has been taken for the window I am in". */
    this.scDecided = decidedHere;
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
    const p = {
      name: pool[i % pool.length] + (i >= pool.length ? ' ' + (i + 1) : ''),
      skill, aggression, consistency,
    };
    /* Derived, not rolled: the item personality has to be a READING of the
       driving personality, or a car that drives like a sniper throws like a
       spammer and the grid stops having characters on it. */
    p.itemStyle = itemStyleFor(p);
    out[i] = p;
  }
  return out;
}

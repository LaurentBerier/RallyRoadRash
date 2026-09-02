/* ============================================================
   TRICKS — what the air is FOR
   ------------------------------------------------------------
   Air used to be a fixed-authority tumble with a levelling assist that gave
   up once you were committed, which made every big jump a hazard: the only
   correct play was to touch nothing and hope. Air is now free rotation with
   a predictive landing assist (see TUNE.air in config.js), and this module
   is the half that pays for it — it watches the flight, names what you did,
   scores it, and hands a mini-turbo tier back to vehicle.js.

   PURE, AND IT MUTATES
   --------------------
   No three, no DOM, and it imports `TUNE` and nothing else — the quaternion
   maths below is written out by hand on four scalars for exactly that
   reason, so dev/trick-check.mjs can drive the whole classifier under bare
   Node with no engine at all. Like miniturbo.js, `trickStep` MUTATES the
   state it is handed and returns nothing: it runs once per frame per car and
   the house rule is that a hot path allocates nothing. There are no arrays,
   no closures and no object literals below `makeTrick()`.

   HOW A FLIGHT IS MEASURED
   ------------------------
   Once per frame we take the BODY-FRAME delta quaternion — conj(qPrev)·qNow
   — convert it to an axis-angle rotation vector, and add its three
   components onto `pitch` / `yaw` / `roll`. That is "how far has this car
   turned about its own nose, roof and side", which is the question a trick
   scorer is actually asking, and it is why a backflip through a bit of yaw
   still reads as a backflip. It is deliberately NOT an Euler decomposition
   of the total rotation: those wrap, gimbal-lock, and cannot tell one flip
   from three.

   Sign conventions follow vehicle.js (forward +Z, right −X, up +Y):
     pitch > 0  nose UP     → BACKFLIP        pitch < 0  nose down → FRONTFLIP
     yaw   > 0  turning left                  roll  > 0  right side down
   Only `pitch` carries a name per sign; yaw and roll are scored on magnitude.

   THE PAYOUT IS GATED ON THE LANDING, and that is the whole design. Any
   idiot can leave a lip spinning. `landQ` (published by vehicle.js: how flat
   and how softly you arrived) decides whether the trick pays in full, pays
   half and drops a tier, or is a CRASH worth nothing — so a trick is a
   decision about how much you can still fix before the ground arrives,
   which is a skill, rather than a button, which is not.

   ============================================================
   THE AI CANNED-TRICK CONTRACT  —  specified here, implemented in ai.js
   ------------------------------------------------------------
   P4 owns this file and the air model; P5 owns ai.js. This is the interface
   between them, and it is written here because it is a statement about the
   air model rather than about any one driver.

   FIRST, THE DEFAULT AIR POLICY MUST CHANGE. ai.js currently flies with
   `AIR_THROTTLE = 0.5` and lets the align assist clean up. Under the wave-6
   authorities (pitch 3.6 rad/s², damp 0.55) a held half-throttle is 1.8
   rad/s² of sustained nose-up, and — because the landing assist is switched
   off while an input is held, deliberately — nothing is arguing with it.
   Every car on the grid would loop. The default airborne policy becomes
   steer 0 / throttle 0 / brake 0 / roll 0, which under the new assist lands
   flat on its own; that is what the "no-input flights land upright" gates in
   dev/trick-check.mjs exist to guarantee.

   THEN, THE CANNED TRICK, on top of that default:

     1. At lip commit for a hero jump, roll once:
            rng() < 0.25 + 0.6 * skill
        Failing the roll means the flight is an ordinary no-input landing.

     2. On the FIRST airborne frame, estimate the hang and pick the trick:
            tAir = predictAirTime(vel.y, j.y - routeYAt(j.s + 45), 12.8, 0.7)
        `j.y - routeYAt(j.s + 45)` is the drop from the lip to the road 45 m
        further on — positive downhill. 12.8 is G; 0.7 is a slightly
        pessimistic stand-in for TUNE.air.hangGravity's blended value over a
        real flight (the float is not fully in for the first 0.35 s).

            commit only if tAir >= 1.3      // less is not enough air to finish
            kind   = aggression > 0.6 ? BARREL : BACKFLIP
            target = kind === BARREL ? 290° : 275°     (in radians)

     3. RELEASE ON THE PREDICTED FINISH, NOT ON A CLOCK. Each airborne frame,
        while the input is still held:

            spun = |kind === BARREL ? v._trick.roll : v._trick.pitch|
            rate += ((spun - lastSpun) / dt - rate) * 0.35;  lastSpun = spun
            tG    = predictAirTime(vel.y, pos.y - heightAt(pos), 12.8, 0.7)
            k     = TUNE.air.damp
            done  = spun + rate * (1 - Math.exp(-k * tG)) / k >= target
                 || airTime >= 1.4                  // T_max, the backstop
                 || tG < 0.45                       // the abort

        `rate/k · (1 − e^(−k·tG))` is how much further a rotation coasts
        before the ground arrives, and the whole rule is "let go once what
        you have already banked will finish on its own".

        A FIXED HOLD TIME WAS TRIED FIRST AND MEASURABLY DOES NOT WORK.
        The rotation a jump needs is fixed at one turn; the rate you leave
        the lip with is not — it depends on ramp angle and entry speed, and
        across ten representative jumps the hold that lands a backflip ranged
        from 0.80 s to 1.30 s with no useful correlation to hang time.
        `0.45 · tAir` landed 1 of those 10 upright. The rule above lands
        10 of 10, at tier 2, and it is barely longer to write.

     4. WHAT TO HOLD:
            BACKFLIP   throttle 1, steer 0, brake 0, roll 0
            BARREL     handbrake 1, steer ±1  (the handbrake is what turns
                       steer into roll — see vehicle.js), throttle 0, brake 0

     5. Once `done`, the rest of the flight is the all-zero default. That
        tail is not slack: it is the only time the landing assist is allowed
        to run, and it is what actually lands the trick.

        The `tG < 0.45` abort is the safety net rather than the controller —
        it is what stops a car that launched badly, or got hit at the lip,
        from riding a rotation into the dirt.

   BARREL is the riskier of the two and is meant to be: it is gated on
   aggression, and across the same ten jumps it lands about eight times in
   ten against the backflip's ten. An aggressive driver eating dirt once in
   five is the correct shape for this feature.

   Nothing in this module is called by the AI except `predictAirTime`, which
   is pure arithmetic and allocates nothing. Everything else it needs
   (`v._trick.pitch/roll`, `v.airTime`) is already published on the Vehicle.
   ============================================================ */
import { TUNE } from './config.js';

const T = TUNE.trick;
const DEG = Math.PI / 180;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ============================================================
   THE VOCABULARY
   ------------------------------------------------------------
   NONE is 0 so `if (st.id)` reads as "did anything happen". Everything else
   is an index into TRICK_NAME, which is what the HUD prints verbatim.
   ============================================================ */
export const TRICK = {
  NONE: 0,
  HOP: 1,
  BIG_AIR: 2,
  SPIN360: 3,
  SPIN720: 4,
  BACKFLIP: 5,
  FRONTFLIP: 6,
  BARREL: 7,
  DOUBLE: 8,
  COMBO: 9,
  CRASH: 10,
};

export const TRICK_NAME = [
  '', 'STYLE HOP', 'BIG AIR', '360', '720', 'BACKFLIP', 'FRONTFLIP',
  'BARREL ROLL', 'DOUBLE FLIP', 'COMBO', 'CRASH',
];

/** The printable name of a trick id, or '' for TRICK.NONE / anything odd. */
export function trickLabel(id) {
  return TRICK_NAME[id | 0] || '';
}

/* ============================================================
   STATE
   ------------------------------------------------------------
   Built once per vehicle at construction. Every field is declared here and
   nothing is ever added later — the same rule miniturbo.js follows, and for
   the same reason: a lazily-created field is a field some reset path forgets.
   ============================================================ */
export function makeTrick() {
  return {
    /* --- last frame's orientation, for the body-frame delta --- */
    qx: 0, qy: 0, qz: 0, qw: 1,

    /* --- this flight --- */
    pitch: 0,       // rad accumulated about the body's right axis (+ = nose up)
    yaw: 0,         // rad about the body's up axis (+ = turning left)
    roll: 0,        // rad about the body's forward axis (+ = right side down)
    air: 0,         // s of airtime this flight
    hopT: 0,        // s left in the hop window (counts down on the ground)
    hop: 0,         // 1 if this flight left the ground inside that window
    wasHand: 0,     // handbrake last frame — the PRESS edge opens the hop window
    launched: 0,    // 1 between the first airborne frame and the classification

    /* --- the last scored trick --- */
    id: 0,          // TRICK.*
    pts: 0,         // points it paid
    tier: 0,        // mini-turbo tier it earned (0 = none)
    q: 0,           // the landQ it was judged on, 0..1
    seq: 0,         // bumped on every scored trick — the HUD's "this is new" flag

    /* --- the session --- */
    best: 0,        // TRICK.* of the highest-scoring trick so far
    bestPts: 0,     // …and what it paid
    total: 0,       // points banked

    /* --- one-shot --- */
    fired: 0,       // the tier to hand miniturbo THIS frame, else 0
  };
}

/**
 * Wipe the FLIGHT only. Called from Vehicle.placeAt, so a respawn cannot
 * bank the tumble it just had — but a respawn must not wipe your score
 * either, which is why `total`/`best` survive this and only trickClear()
 * takes them.
 */
export function trickReset(st) {
  st.qx = 0; st.qy = 0; st.qz = 0; st.qw = 1;
  st.pitch = 0; st.yaw = 0; st.roll = 0;
  st.air = 0; st.hopT = 0; st.hop = 0; st.wasHand = 0; st.launched = 0;
  st.id = 0; st.pts = 0; st.tier = 0; st.q = 0;
  st.fired = 0;
}

/** Everything, totals included. Called at the grid, once per race. */
export function trickClear(st) {
  trickReset(st);
  st.seq = 0; st.best = 0; st.bestPts = 0; st.total = 0;
}

/* ============================================================
   ONE FRAME
   ------------------------------------------------------------
   Called from Vehicle.step immediately after driftStep, which means it sees
   LAST frame's `landEdge` — the edge is published at the end of step(),
   after the substeps that actually put the wheels back on the ground. That
   one-frame lag is the same one boost-check documents for `airborne`, and it
   is load-bearing here: it is what guarantees the classification runs after
   `landQ` has been measured rather than before.
   ============================================================ */
export function trickStep(st, dt, v, ctl) {
  st.fired = 0;

  const air = !!v.airborne;
  const hand = ctl && ctl.handbrake ? 1 : 0;

  /* ---- the hop window ----
     A hop is the oldest trick in the genre: pop the suspension on the lip so
     you leave the ground with intent rather than because the ground stopped.
     The PRESS edge opens the window; leaving the ground before it closes is
     what makes the flight a hop. It is an input timing, not an airtime, so
     the clock only runs on the ground. */
  if (!air) {
    if (hand && !st.wasHand) st.hopT = T.hopWindow;
    else if (st.hopT > 0) { st.hopT -= dt; if (st.hopT < 0) st.hopT = 0; }
  }
  st.wasHand = hand;

  const q = v.quat;
  if (air && !st.launched) {
    /* ---- launch ----
       Zero the accumulators and RE-BASELINE the orientation in the same
       breath. Skipping the re-baseline would fold the whole of the last
       grounded frame — a kerb strike, a suspension kick — into the first
       frame of the flight, which is how a rut becomes a barrel roll. */
    st.pitch = 0; st.yaw = 0; st.roll = 0;
    st.air = 0;
    st.hop = st.hopT > 0 ? 1 : 0;
    st.launched = 1;
  } else if (st.launched) {
    _accumulate(st, q);
  }
  st.qx = q.x; st.qy = q.y; st.qz = q.z; st.qw = q.w;

  if (air && st.launched) st.air += dt;

  /* ---- touchdown ----
     `landEdge` is only true on a real landing (vehicle.js debounces it
     against TUNE.trick.minAir), so rut chatter can neither score nor reset. */
  if (st.launched && v.landEdge) {
    st.launched = 0;
    _classify(st, v.landQ);
  }
}

/* ------------------------------------------------------------
   The body-frame delta, written out on scalars because this module owns no
   quaternion type. dq = conj(qPrev) · qNow, which expresses the frame's
   rotation in the PREVIOUS body frame — the "about my own axes" number.
   ------------------------------------------------------------ */
function _accumulate(st, q) {
  const pw = st.qw, px = st.qx, py = st.qy, pz = st.qz;
  const nw = q.w, nx = q.x, ny = q.y, nz = q.z;

  let dw = pw * nw + px * nx + py * ny + pz * nz;
  let dx = pw * nx - px * nw - py * nz + pz * ny;
  let dy = pw * ny + px * nz - py * nw - pz * nx;
  let dz = pw * nz - px * ny + py * nx - pz * nw;
  // Double cover: q and −q are the same orientation, and taking the wrong
  // one turns a 5° frame into a 355° one going the other way.
  if (dw < 0) { dw = -dw; dx = -dx; dy = -dy; dz = -dz; }

  const s = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (s < 1e-9) return;
  const ang = 2 * Math.atan2(s, dw) / s;      // fold the normalise into the scale

  /* Right is −X (vehicle.js), so nose-up is a NEGATIVE rotation about local
     +X. Negating here is what makes `pitch > 0` mean BACKFLIP everywhere
     else in this file. */
  st.pitch -= dx * ang;
  st.yaw += dy * ang;
  st.roll += dz * ang;
}

/* ------------------------------------------------------------
   CLASSIFY. Everything the flight earned, summed, then judged on the
   landing. Written as a flat sequence of "did you clear this bar" tests
   rather than a table because the interactions — a double is not two
   backflips, a 720 is not two 360s — are the whole content.
   ------------------------------------------------------------ */
function _classify(st, landQ) {
  const q = clamp01(landQ || 0);
  st.q = q;

  const P = T.pts, TI = T.tier;
  const ap = Math.abs(st.pitch), ay = Math.abs(st.yaw), ar = Math.abs(st.roll);
  const flip = T.flipDeg * DEG, rollT = T.rollDeg * DEG;
  const spin = T.spinDeg * DEG, spin2 = T.spin2Deg * DEG;

  let id = 0, pts = 0, tier = 0, n = 0;

  /* ---- pitch: a double outranks a single, and it is not a combo ---- */
  if (ap >= flip * 2) {
    id = TRICK.DOUBLE; pts += P.double; tier = Math.max(tier, TI.double); n++;
  } else if (ap >= flip) {
    if (st.pitch > 0) { id = TRICK.BACKFLIP; pts += P.backflip; tier = Math.max(tier, TI.backflip); }
    else { id = TRICK.FRONTFLIP; pts += P.frontflip; tier = Math.max(tier, TI.frontflip); }
    n++;
  }

  /* ---- yaw ---- */
  if (ay >= spin2) {
    if (!id) id = TRICK.SPIN720;
    pts += P.spin720; tier = Math.max(tier, TI.spin720); n++;
  } else if (ay >= spin) {
    if (!id) id = TRICK.SPIN360;
    pts += P.spin360; tier = Math.max(tier, TI.spin360); n++;
  }

  /* ---- roll ---- */
  if (ar >= rollT) {
    if (!id) id = TRICK.BARREL;
    pts += P.barrel; tier = Math.max(tier, TI.barrel); n++;
  }

  /* ---- the consolation prizes, in order of how much they are worth ----
     BIG AIR only when nothing else happened: a backflip off the Caldera Leap
     is a backflip, not a backflip AND a rewarded absence of rotation. */
  if (!id && st.air >= T.bigAir) { id = TRICK.BIG_AIR; pts = P.bigAir; n = 1; }
  else if (!id && st.hop) { id = TRICK.HOP; pts = P.hop; tier = TI.hop; n = 1; }

  /* ---- the landing has the last word, and it speaks first ----
     Below sloppyQ you did not land it, you arrived — whether or not you were
     doing anything on the way down. CRASH is announced even for a flight
     that scored nothing, because "you just landed on your roof" is the one
     thing the HUD and the audio most need to be told; vehicle.js has already
     spun the car for it. */
  if (q < T.sloppyQ) {
    st.id = TRICK.CRASH; st.pts = 0; st.tier = 0;
    st.seq++;
    return;
  }

  if (!id) {                        // an ordinary landing off an ordinary jump
    st.id = 0; st.pts = 0; st.tier = 0;
    return;
  }

  /* ---- two or more in one flight is a COMBO ---- */
  if (n > 1) {
    id = TRICK.COMBO;
    pts = Math.round(pts * P.comboMul);
    tier = Math.max(tier, TI.combo);
  }

  // Sloppy but survivable: half the points, one tier off.
  if (q < T.cleanQ) {
    pts = Math.round(pts * 0.5);
    tier = Math.max(0, tier - T.sloppyTierDrop);
  }

  st.id = id; st.pts = pts; st.tier = tier;
  st.seq++;
  st.total += pts;
  if (pts > st.bestPts) { st.bestPts = pts; st.best = id; }
  st.fired = tier;
}

/* ============================================================
   predictAirTime — shared with the AI's canned-trick planner
   ------------------------------------------------------------
   Flat-ground ballistics, which is all anyone should ask of an estimate made
   on the first frame of a flight. Solving

       0 = vy·t − ½·g·t² + dropM        with  g = G · hang

   for the positive root. `dropM` is how much LOWER the landing is than the
   launch, in metres, so a downhill landing is positive and lengthens the
   hang. `hang` folds in TUNE.air.hangGravity; pass the honest G and let the
   caller decide how optimistic to be about the float.

   Returns seconds, never negative, never NaN — a caller that has already
   passed the apex of a rise it cannot clear gets 0 and should abort.
   ============================================================ */
export function predictAirTime(vy, dropM, G, hang) {
  const g = G * (hang > 0 ? hang : 1);
  if (!(g > 1e-6)) return 0;
  const disc = vy * vy + 2 * g * dropM;
  if (!(disc > 0)) return 0;
  const t = (vy + Math.sqrt(disc)) / g;
  return t > 0 ? t : 0;
}

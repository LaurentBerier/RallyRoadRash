/* ============================================================
   MINI-TURBO — what a drift is FOR
   ------------------------------------------------------------
   Hold a slide, charge a tier, release, get shoved. The handbrake in this
   game has always been well tuned and completely unrewarded: it rotated the
   car and cost you speed, and the fast line was the one that never used it.
   This is the payoff, and it is the reason to take a corner sideways.

   PURE, AND IT MUTATES
   --------------------
   No three, no DOM, no imports beyond config — so dev/boost-check.mjs can
   drive it under bare Node. `driftStep` MUTATES the state object it is
   handed and returns nothing: it runs six times a frame per car, and the
   house rule is that a hot path allocates nothing. There are no arrays, no
   closures and no object literals below `makeDrift()`.

   WHAT THE TIERS ACTUALLY MEASURE — read this before retuning
   -----------------------------------------------------------
   Not "how long you held the drift". They cannot: in this handling model the
   handbrake is a rotation tool, not a sustainable state, and holding it walks
   the slip angle straight through the drift band and on to a spin in about
   two seconds regardless of what you do with the steering (measured across
   steer 0.3 → full lock at 32 m/s; the time inside the band never moved more
   than 40 ms). The most a single handbrake application can bank is ~0.36.

   So a tier measures HOW FAR YOU DARED ROTATE BEFORE CATCHING IT. Tier 1 is
   a flick; tier 3 means riding it to about 63°, with the spin a tenth of a
   second away and `slipMax` waiting to pay you nothing if you overcook it.
   That is the skill this game already had and never rewarded.

   THE STATE MACHINE, in one paragraph
   -----------------------------------
   While the car is sliding hard enough, fast enough, inside the band and on
   the ground, `charge` accumulates at a rate scaled by both how sideways and
   how fast you are. Cross a threshold in `TUNE.boost.tier` and `tier` steps
   up (`tierUp` fires once, for the chime). Break the slide and `grace`
   seconds later the charge bleeds — slowly, so a flick that banks less than
   tier 1 keeps its progress and a linked left-right adds up instead of
   starting over. Release with a tier banked and the boost is armed; it fires
   the moment the car settles, and `mul`/`top` step away from 1 for
   `fireT[tier]` seconds. Firing into a running boost takes the better of the
   two, never the sum — a chain of tier-1s must not add up to a rocket.
   ============================================================ */
import { TUNE } from './config.js';

const B = TUNE.boost;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The per-vehicle state. Built once at construction; every field below is
 * declared here and nothing is ever added later — a lazily-created field is
 * a field some reset path will forget (see the `lavaT`/`wedgeT` note in
 * race.js for what that costs).
 */
export function makeDrift() {
  return {
    charge: 0,      // s of accumulated drift
    tier: 0,        // 0 = nothing banked, 1..3 = a tier ready to fire
    slack: 0,       // s since the slide was last good enough
    wasHand: 0,     // handbrake last step — the release EDGE arms the fire
    armed: 0,       // release seen with a tier banked; fire once the car settles
    fireT: 0,       // s of boost remaining
    fireTier: 0,    // which tier is currently burning
    mul: 1,         // × motorForce      — read by Vehicle._substep
    top: 1,         // × topSpeed (fade denominator only)
    tierUp: 0,      // 1 on the frame a tier is gained, else 0 (one-shot, for audio)
    fired: 0,       // the tier that fired THIS frame, else 0 (one-shot)
    active: 0,      // 1 while charging — drives the coloured tyre dust
  };
}

/** Wipe it. Called from Vehicle.placeAt, so a respawn never keeps a charge. */
export function driftReset(st) {
  st.charge = 0; st.tier = 0; st.slack = 0; st.wasHand = 0; st.armed = 0;
  st.fireT = 0; st.fireTier = 0;
  st.mul = 1; st.top = 1;
  st.tierUp = 0; st.fired = 0; st.active = 0;
}

/**
 * One substep.
 *
 * @param st    state from makeDrift(), MUTATED
 * @param dt    seconds
 * @param v     the Vehicle — reads bodySlip, speed, contacts, airborne, spinT
 * @param ctl   the resolved control object (handbrake, steer)
 */
export function driftStep(st, dt, v, ctl) {
  st.tierUp = 0;
  st.fired = 0;

  /* ---- the running boost, first: it expires on its own clock ---- */
  if (st.fireT > 0) {
    st.fireT -= dt;
    if (st.fireT <= 0) {
      st.fireT = 0; st.fireTier = 0;
      st.mul = 1; st.top = 1;
    }
  }

  const hand = ctl.handbrake > 0;
  /* GROUND speed, not the forward component. vehicle.js already learned this
     the hard way ("a car at 86° of slip has almost no forward speed"): gating
     on v.speed makes the charge switch itself off at exactly the moment the
     car is most sideways, which is the moment it should be paying best. */
  const speed = v.groundSpeed;

  /* Airborne is not a drift. A car at 40° of yaw in mid-air is a car that is
     about to have a bad landing, and paying it for that would make the
     correct play "jump sideways". `contacts` is the honest test — it is what
     the suspension actually found. */
  const grounded = v.contacts > 0 && !v.airborne;

  /* A spin-out routes through the handbrake path (see Vehicle.step), so
     without this it would charge a mini-turbo for you. Recovering from an
     oil slick WITH a tier-1 is the right payoff; being handed one for free
     the instant you are hit is not. */
  const spinLocked = v.spinT > B.spinLockout;

  const gate = hand ? B.slipHand : B.slipFree;
  const slip = Math.abs(v.bodySlip);
  /* An upper gate as well as a lower one. Past `slipMax` the car is not
     drifting, it is spinning — and paying for a pirouette would make the
     fastest way to charge a tier "stop racing and do donuts". The number is
     deliberately the top of TUNE.drift.spinGuard, the same slip angle at
     which the stability controller comes back to stop the rotation: past
     there the game has already decided you are out of control. */
  const sliding = grounded && !spinLocked &&
    speed > B.minSpeed && slip > gate && slip < B.slipMax;

  if (sliding) {
    st.slack = 0;
    /* Rate scales with BOTH how sideways and how fast, each saturating. A
       committed slide at speed fills a tier about twice as fast as a
       tentative one, which is what makes tier 3 a thing you aim for rather
       than a thing that happens. */
    const sf = clamp((slip - gate) / Math.max(1e-4, B.slipFull - gate), 0, 1);
    const vf = clamp((speed - B.minSpeed) / Math.max(1e-4, B.fullSpeed - B.minSpeed), 0, 1);
    st.charge += dt * (0.45 + 0.55 * sf) * (0.55 + 0.45 * vf);
    st.active = 1;

    const t = st.tier;
    if (t < 3 && st.charge >= B.tier[t]) { st.tier = t + 1; st.tierUp = 1; }
  } else {
    st.active = 0;
    st.slack += dt;
    if (st.slack > B.grace) {
      st.charge -= dt * B.decay;
      if (st.charge < 0) st.charge = 0;
      /* The tier follows the charge back DOWN. Banking tier 3 and then
         cruising for four seconds must not still pay tier 3. */
      while (st.tier > 0 && st.charge < B.tier[st.tier - 1]) st.tier--;
    }
  }

  /* ---- release ----
     TWO triggers, and getting this wrong made the grace window unreachable
     in the first draft: if ANY interruption fires the boost, then a lapse can
     never be forgiven and `grace` is dead code.

       • The handbrake going DOWN→UP is the player saying "now" — but it ARMS
         the fire rather than firing it. Letting the handbrake go while the
         car is still crossed up does not straighten it; you carry the slide
         out on the throttle, and a boost fired into a car that is 60°
         sideways just sends it off the road. The armed release lands the
         moment the car points where it is going, which is also exactly when
         you want it: corner exit.
       • Otherwise, once the slide has been gone longer than the grace window.
         That is what lets you hold the handbrake through a catch mid-chicane
         and keep building, and it is the only trigger a throttle slide has —
         correctly, since you end one of those by straightening up. */
  if (st.wasHand && !hand && st.tier > 0) st.armed = 1;
  st.wasHand = hand ? 1 : 0;
  if (st.tier > 0 && !sliding && (st.armed || st.slack > B.grace)) {
    const t = st.tier;
    st.fired = t;
    st.charge = 0;
    st.tier = 0;
    st.slack = 0;
    st.armed = 0;
    /* Better of the two, never the sum: a chain of tier-1s must not stack
       into something the handling model has never been tested at. */
    const wantT = B.fireT[t - 1];
    if (wantT > st.fireT) { st.fireT = wantT; st.fireTier = t; }
    st.mul = Math.max(st.mul, B.fireMul[st.fireTier - 1]);
    st.top = Math.max(st.top, B.fireTop[st.fireTier - 1]);
  }
}

/** 0..1 progress toward the next tier, for the HUD. Cheap, allocation-free. */
export function driftProgress(st) {
  const t = st.tier;
  if (t >= 3) return 1;
  const lo = t === 0 ? 0 : B.tier[t - 1];
  const hi = B.tier[t];
  return clamp((st.charge - lo) / Math.max(1e-4, hi - lo), 0, 1);
}

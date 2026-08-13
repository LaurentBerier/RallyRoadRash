/* ============================================================
   RALLYE — CENTRAL TUNING
   ------------------------------------------------------------
   Every number that decides how the game FEELS lives here. Nothing in this
   file imports anything: it is pure data, readable from Node tests and from
   the browser alike, and it is the one file the lead edits during a tuning
   pass.

   House rules for this file:
     • Units are stated on every line. Metres, seconds, radians, newtons.
     • A value belongs here if changing it changes the feel. Values that are
       *derived* (spring rates from mass, inertia from dims) live next to the
       thing they describe and are computed at construction — see vehicles.js.
     • Per-vehicle character lives in vehicles.js; this file holds the shared
       chassis of the handling model that all three cars sit on.
   ============================================================ */

/* Arcade gravity. Real Earth is 9.81; we run 30 % heavy on purpose.

   The jump arc is the reason. Lighter gravity gives long, floaty, boring
   hangs where you have all day to correct your attitude. Heavier gravity
   makes a 20° kicker at 30 m/s land in about 45 m instead of 59 m, which is
   a distance a player can read and aim at, and it snaps the car back onto
   the ground fast enough that the suspension does the talking. It also lets
   the tyres carry more absolute grip (grip scales with weight) without the
   cornering speeds getting silly.

   EVERY module reads gravity from here. Do not hardcode 9.81 anywhere. */
export const G = 12.8;                       // m/s²

export const TUNE = {

  /* ---------------------------------------------------------------
     STEERING
     Keyboard steer is binary ±1. The rate limiter and the speed taper are
     what turn that square wave into something you can place a car with.
     --------------------------------------------------------------- */
  steer: {
    maxLock: 0.55,          // rad — full lock at crawl (31.5°). Sets the tightest
                            //       possible turn: R ≈ wheelbase / tan(lock).
    speedTaper: 0.24,       // fraction of maxLock still available at topSpeed.
                            //       0.24 → 7.6° at the top end. Lower = calmer
                            //       at speed, but too low and fast chicanes go dead.
    taperShape: 0.55,       // exponent on (speed/topSpeed) driving the taper.
                            //       <1 bites early, so the lock is already sane by
                            //       half speed — that is where most cornering lives.
    rate: 6.5,              // lock-fractions per second toward the input. 6.5 → full
                            //       lock in 0.154 s. Speed-invariant on purpose: a
                            //       rad/s rate would feel instant once the lock tapers.
    returnRate: 9.0,        // lock-fractions/s back to centre when the key is released.
                            //       Faster than `rate` so the car self-straightens and
                            //       tapping a key gives a clean dab of steering.
    countersteerAssist: 0.42, // 0..1 — how much of the physically-correct countersteer
                            //       is dialled in for you when the car is sliding. This
                            //       is the single value that makes binary keyboard input
                            //       survivable at the limit. 0 = raw, 1 = drives itself.
    assistSlip: 0.10,       // rad — body slip angle deadband before the assist wakes up.
    assistSpeed: 5.0,       // m/s — below this the assist is off (parking, donuts).
  },

  /* ---------------------------------------------------------------
     DRIVE / ENGINE
     motorForce (per vehicle) is the peak drive force at the contact patches.
     This block shapes how that force decays with speed and how the virtual
     gearbox sings.
     --------------------------------------------------------------- */
  drive: {
    fadeKnee: 0.60,         // fraction of topSpeed where the drive force starts falling
                            //       off. Below it you get everything the tyres can take.
    fadeTail: 0.20,         // fraction of motorForce still on tap AT topSpeed. Must be
                            //       big enough to beat drag at topSpeed or the car never
                            //       reaches its spec number — vehicles.js is sized for it.
    overBand: 0.012,        // fraction of topSpeed over which the drive closes to zero
                            //       once past topSpeed. Narrow, so the terminal speed
                            //       lands inside topSpeed +0…+1.2 % on any surface where
                            //       fadeTail still wins. This is what makes `topSpeed`
                            //       an honest number the UI and the AI can quote.
    reverseFrac: 0.28,      // reverse tops out at this fraction of topSpeed.
    reverseForce: 0.55,     // reverse drive force as a fraction of motorForce.
    engineBrake: 0.055,     // coast-down drag on the driven wheels as a fraction of
                            //       motorForce. Gives lift-off a little bite.
    liftBrakeSpeed: 1.2,    // m/s — above this, "throttle against the direction of
                            //       travel" is read as braking, not as reverse.

    /* Virtual 5-speed. Upper edge of each gear as a fraction of topSpeed. The
       last one runs past 1.0 so top gear never sits pinned on the limiter. */
    gearBands: [0.14, 0.30, 0.50, 0.74, 1.06],
    rpmLow: 0.35,           // rpmNorm at the bottom of a gear (1.0 at the top).
    rpmIdle: 0.16,          // rpmNorm at a standstill with no throttle.
    rpmBlip: 0.10,          // rpmNorm kick added on an upshift, decays out.
    rpmSmooth: 14.0,        // 1/s — low-pass on rpmNorm so audio never zippers.
    airRevSmooth: 2.2,      // 1/s — how fast revs chase throttle while airborne.
  },

  /* ---------------------------------------------------------------
     TYRES
     Slip stiffnesses are expressed PER NEWTON OF LOAD, so they scale with
     weight transfer for free: the unloaded inside wheel goes vague exactly
     when it should.
     --------------------------------------------------------------- */
  tyre: {
    longStiff: 2.6,         // N of drive/brake force per (m/s of slip) per N of load.
                            //       µ≈1.2 ⇒ saturates at ~0.46 m/s of slip: crisp.
    latStiff: 1.55,         // same, laterally. Saturates at ~0.77 m/s of lateral slip,
                            //       ≈2.7° of slip angle at 18 m/s. High = sharp turn-in.
    latCap: 0.94,           // lateral force is capped at this fraction of the friction
                            //       circle BEFORE the circle is applied, so there is
                            //       always a sliver of budget left for drive and brake.
                            //       This is what keeps lift-off oversteer mild.
    slipRef: 3.0,           // m/s of slip that reads as slipLong = 1.0 (dust/audio).
    latRef: 3.5,            // m/s of lateral slip that reads as slipLat = 1.0.
    sinkDrag: 0.055,        // extra rolling resistance per unit of SURFACES[].sink,
                            //       as a fraction of load. MUD (sink 1.0) therefore
                            //       costs 10 % of your weight in drag — you feel it.
    rollDragCap: 900,       // N·s/m — rolling resistance is blended out below walking
                            //       pace so it can never push a parked car backwards.
  },

  /* ---------------------------------------------------------------
     SUSPENSION
     Spring and damper rates are sized per vehicle (see vehicles.js) from a
     target natural frequency; these are the shared limits around them.
     --------------------------------------------------------------- */
  susp: {
    bumpStopMul: 90,        // bump stop rate as a multiple of suspK, applied to
                            //       (overtravel)². Progressive: soft touch, hard wall.
    droop: 0.02,            // m of negative compression allowed before the wheel is
                            //       simply off the ground (kills contact chatter).
    compVelClamp: 9.0,      // m/s — damper velocity clamp. Stops a single-frame spike
                            //       on a kerb from launching the car.
    maxForceG: 22,          // per-corner spring+damper force ceiling, in multiples of
                            //       that corner's static load. A landing safety valve.
    hitComp: 0.55,          // fraction of travel that must be used before a compression
                            //       counts as a "hit" for hardHit.
    hitVel: 3.0,            // m/s of compression velocity below which a landing is not
                            //       worth reporting to feel/audio.
  },

  /* ---------------------------------------------------------------
     AERO
     A small honest v² term. Its real job is coast-down feel and giving the
     drive fade something to converge against at top speed.
     --------------------------------------------------------------- */
  aero: {
    rho: 1.2,               // kg/m³ — air density (sea level-ish, single number).
    cd: { buggy: 0.44, truck: 0.52, wedge: 0.34 },   // drag coefficient by bodyStyle.
    frontalFrac: 0.82,      // frontal area = W × H × this (bodies are not rectangles).
  },

  /* ---------------------------------------------------------------
     DRIVER AIDS — always on. This is an arcade game; the aids ARE the feel.
     --------------------------------------------------------------- */
  assists: {
    tcSlipCap: 1.7,         // m/s of wheelspin allowed before traction control eases
                            //       the throttle. High enough that launches still light
                            //       up the rears and throw dust.
    tcAttack: 0.85,         // per (m/s of excess slip) — how hard TC pulls torque back.
    tcFloor: 0.12,          // TC never cuts below this fraction of commanded torque.
    absCap: 1.6,            // m/s of lock-up slip allowed before ABS releases a wheel.
    absAttack: 1.1,         // per (m/s of excess) — brake release rate.
    absFloor: 0.15,         // ABS never releases below this fraction of brake torque.
    absOffSpeed: 1.8,       // m/s — below this ABS is bypassed so the car can actually
                            //       stop and stay stopped.
    stabilityYawDamp: 2.6,  // 1/s — gain on (yaw rate − the yaw rate your steering angle
                            //       actually asked for). Not blunt yaw damping: it does
                            //       not fight a corner you commanded, it only kills the
                            //       part you did not. This is why 40 m/s is hands-off
                            //       stable on a straight.
    stabilityLow: 0.18,     // fraction of topSpeed below which stability control is off,
                            //       so low-speed donuts and hairpins stay playful.
    stabilityHigh: 0.55,    // fraction of topSpeed where it reaches full authority.
    antiRoll: 0.60,         // roll-restoring torque, as a multiple of (m·G·halfTrack)
                            //       per radian of roll. Applied only while in contact.
    antiRollDamp: 0.22,     // same units, per (rad/s) of roll rate. Kills the wallow.
    downforce: 0.40,        // extra normal load at topSpeed, as a fraction of static
                            //       weight. Scales with (v/topSpeed)². Small, but it is
                            //       what makes a flat-out crest feel planted.
    yawRateCap: 2.0,        // rad/s — nothing may ever spin faster than this on the
                            //       ground. Grip cornering peaks near 0.9, so this never
                            //       touches ordinary driving; it exists because a
                            //       handbrake turn at full lock is a genuine 7 rad/s² of
                            //       yaw moment (full-grip front against a dead rear) and
                            //       without a ceiling the car whips round faster than the
                            //       chase camera — or the player — can read.
    yawCapGain: 20,         // 1/s of restoring authority per (rad/s) past the cap. High,
                            //       because it has to out-argue the tyres; the cap is a
                            //       wall, not a suggestion.
    slideRecovery: 0.50,    // 1/s — lateral body velocity bled off per second when all
                            //       four are sliding and you are NOT on the handbrake.
                            //       Turns a spin into a slide you can catch. Raise it
                            //       and the car feels on rails; lower it and keyboard
                            //       players spin on every corner exit.
  },

  /* ---------------------------------------------------------------
     AIRBORNE
     Authorities are angular accelerations at full stick, so they read the
     same on every car regardless of mass.
     --------------------------------------------------------------- */
  air: {
    /* Authorities are sized against HANG TIME, not against how they feel in a
       vacuum. With `damp` below, holding full input for a typical 1.2 s jump
       buys about 35° of pitch — enough to save a bad launch, not enough to
       flip. A three-second volcano jump held flat out gets you most of the way
       round, which is the correct punishment for holding throttle off a lip. */
    pitchAuthority: 1.15,   // rad/s² at full (throttle − brake). Throttle lifts the
                            //       nose, brake drops it — the way every player expects.
    yawAuthority: 1.30,     // rad/s² at full steer, about the body's up axis. This is
                            //       how you line a landing up with the road, so it is
                            //       the most generous of the three.
    rollAuthority: 0.75,    // rad/s² at full steer, about the body's forward axis.
                            //       Deliberately smallest: it is garnish, and roll is
                            //       the axis that ruins a landing.
    alignAssist: 1.5,       // rad/s² of levelling torque toward the ground normal, at
                            //       90° of misalignment. Weighted by sin(error) and then
                            //       faded OUT past alignGiveUp — the assist tidies up the
                            //       landing you nearly had, and abandons you completely
                            //       once you have committed to a flip. That fade is the
                            //       whole design: without it, a stronger assist just
                            //       means the game lands for you and jumps stop mattering.
    alignGiveUp: [1.0, 2.2],// rad — assist fades from full to nothing between these.
    alignDelay: 0.6,        // s of airtime before the assist starts fading in.
    alignRamp: 0.9,         // s over which it fades to full once it starts.
    damp: 0.75,             // 1/s — angular damping while airborne. Sets the terminal
                            //       rotation rate at authority/damp, which is the number
                            //       that actually decides whether you can flip.
    spinCap: 5.0,           // rad/s — hard cap on airborne angular rate. Anti-explosion.
  },

  /* ---------------------------------------------------------------
     DRIFT / HANDBRAKE
     --------------------------------------------------------------- */
  drift: {
    handbrakeGripRear: 0.34,  // rear µ multiplier while the handbrake is held. 0.34 is
                              //     loose enough to rotate on turn-in, tight enough that
                              //     the car still goes where it is pointed.
    handbrakeYawBoost: 0.85,  // rad/s² of extra yaw at full steer while the handbrake is
                              //     down. Fades out below 4 m/s, above ~0.8 topSpeed, AND
                              //     once the car is already sideways (see yawBoostFade) —
                              //     the handbrake starts a rotation, it must not sustain
                              //     a spin, or every corner ends facing backwards.
    yawBoostFade: [0.40, 0.90], // rad of body slip over which the boost fades to zero.
    handbrakeTorque: 0.55,    // rear brake torque while handbraking, as a fraction of
                              //     brakeForce. ABS is bypassed on the rear — that is
                              //     the whole point of a handbrake.
    driftGripRecovery: 2.2,   // 1/s — how fast rear grip walks back to normal after
                              //     release. Slow enough that you can flick–catch–flick
                              //     through an S without the car snapping straight.
    stabilityCut: 0.25,       // stability control is scaled by this while handbraking…
    spinGuard: [0.55, 1.15],  // …but walks back to FULL authority across this range of
                              //     body slip angle (rad, ~31°→66°). Inside the window
                              //     the car drifts with nothing arguing; past it the
                              //     controller comes back and stops the rotation. This
                              //     is the difference between a drift and a pirouette,
                              //     and it is the single value to move if the handbrake
                              //     feels either too tame or uncatchable.
  },

  /* ---------------------------------------------------------------
     RESET / RECOVERY — race.js owns the behaviour, these are its thresholds.
     --------------------------------------------------------------- */
  reset: {
    flipTime: 2.5,          // s upside-down (Vehicle.flipped true) before auto-reset.
    stuckTime: 4.0,         // s below stuckSpeed before auto-reset.
    stuckSpeed: 1.2,        // m/s — the "not actually going anywhere" threshold.
    offCourseDist: 25,      // m from the centreline before you count as lost.
    offCourseTime: 2.5,     // s you must STAY lost — a crest overshoot is not a DNF.
    ghostTime: 1.5,         // s of collision-immune, semi-transparent respawn.
    holdTime: 0.8,          // s the player must hold R for a manual reset.
  },

  /* ---------------------------------------------------------------
     VEHICLE-VS-VEHICLE COLLISION
     Three spheres down the local Z axis per car. Cheap, stable, and it
     never wedges two cars together the way a box hull does.
     --------------------------------------------------------------- */
  collide: {
    restitution: 0.30,      // 0..1 bounce. Ramped in with closing speed (see below) so
                            //       cars leaning on each other in a pack do not buzz.
    restitutionSpeed: 4.0,  // m/s of closing speed at which restitution is fully on.
    friction: 0.45,         // tangential impulse cap as a fraction of the normal impulse.
                            //       This is what makes side-by-side contact scrub speed.
    pushOut: 0.55,          // fraction of the remaining overlap resolved per call. Under
                            //       1.0 on purpose: a six-car funnel resolves over a few
                            //       frames instead of firing someone into orbit.
    maxPush: 0.30,          // m — hard cap on positional correction per pair per call.
    maxDeltaV: 26,          // m/s — impulse clamp per car per pair. Generous enough for
                            //       a genuine 30 m/s head-on, tight enough that a deep
                            //       overlap from a teleport cannot explode.
    spinFactor: 0.45,       // how much of the off-centre yaw an impact really imparts.
                            //       1.0 is physical and makes pack racing a spin fest.
    minSpeed: 0.35,         // m/s of closing speed below which we report no impact
                            //       (still separates, just does not ring the audio bell).

    /* 3-sphere layout per bodyStyle.
         radius = fraction of the car's half-width (W/2)
         spread = fraction of the largest offset that still keeps the envelope
                  exactly L long, i.e. z = ±spread · (L/2 − radius) */
    sphereSet: {
      buggy: { radius: 1.02, spread: 1.00 },
      truck: { radius: 1.06, spread: 0.96 },   // fatter: bullbar and flares stick out
      wedge: { radius: 0.98, spread: 1.00 },
    },
  },

  /* ---------------------------------------------------------------
     SOLVER
     --------------------------------------------------------------- */
  sim: {
    substeps: 6,            // per step(). 6 × 1/60 s = 2.8 ms substeps — enough for the
                            //       stiff springs without the semi-implicit spin solver
                            //       needing help.
    dtCap: 0.05,            // s — a tab-out must not teleport the car through a wall.
    inertia: {              // scale factors on the box inertia from dims. Cars carry
      pitch: 0.85,          //     their mass low and central, so the raw box tensor is
      yaw: 0.82,            //     too lazy. Cutting yaw inertia is the cheapest way to
      roll: 1.00,           //     buy turn-in without touching grip.
    },
    floorMargin: 0.02,      // m of slack under full bump before the hard-floor failsafe
                            //       engages. The failsafe is a tunnelling guard, not a
                            //       bump stop — if it fires in normal driving, the
                            //       suspension travel is wrong.
    floorBounce: 0.12,      // restitution of the hard floor. Just enough to not stick.
    flipUp: 0.25,           // body up.y below this counts as flipped.
    flipHold: 0.35,         // s it must stay there — a barrel roll through inverted is
                            //       not a flip, landing on the roof is.
  },
};

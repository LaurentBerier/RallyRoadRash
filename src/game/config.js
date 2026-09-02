/* ============================================================
   RALLY ROAD RASH — CENTRAL TUNING
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

   G itself stays this heavy so GROUND handling — grip, suspension sag, the
   arc a car carries into a lip — keeps its bite. The arcade float on a big
   jump comes instead from TUNE.air.hangGravity, which scales gravity back
   only once the car has been genuinely airborne, so jumps fly ~1.7x further
   while rut-chatter and landings still carry full weight.

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
    /* Drag coefficient by bodyStyle. `bike` is the outlier: a rider is a very
       draggy shape for their frontal area, and the number has a second job —
       it is the only brake on a 245 kg body with this much power-to-weight,
       so it is what keeps the Hornet's terminal speed an honest 40 m/s. */
    cd: { buggy: 0.44, truck: 0.52, wedge: 0.34, bike: 0.42 },
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
       buys about 58° of pitch — enough to save a bad launch, not enough to
       flip. A three-second volcano jump held flat out gets you most of the way
       round, which is the correct punishment for holding throttle off a lip. */
    pitchAuthority: 1.85,   // rad/s² at full (throttle − brake). Throttle lifts the
                            //       nose, brake drops it — the way every player expects.
    yawAuthority: 2.10,     // rad/s² at full steer, about the body's up axis. This is
                            //       how you line a landing up with the road, so it is
                            //       the most generous of the three.
    rollAuthority: 1.25,    // rad/s² at full steer, about the body's forward axis.
                            //       Deliberately smallest: it is garnish, and roll is
                            //       the axis that ruins a landing.
    alignAssist: 2.3,       // rad/s² of levelling torque toward the ground normal, at
                            //       90° of misalignment. Weighted by sin(error) and then
                            //       faded OUT past alignGiveUp — the assist tidies up the
                            //       landing you nearly had, and abandons you completely
                            //       once you have committed to a flip. That fade is the
                            //       whole design: without it, a stronger assist just
                            //       means the game lands for you and jumps stop mattering.
    alignGiveUp: [1.0, 2.2],// rad — assist fades from full to nothing between these.
    alignDelay: 0.45,       // s of airtime before the assist starts fading in.
    alignRamp: 0.9,         // s over which it fades to full once it starts.
    damp: 0.75,             // 1/s — angular damping while airborne. Sets the terminal
                            //       rotation rate at authority/damp, which is the number
                            //       that actually decides whether you can flip.
    spinCap: 5.0,           // rad/s — hard cap on airborne angular rate. Anti-explosion.
                            //       Stays at 5.0: airborne rates are authority/damp
                            //       limited far below it anyway, and a higher cap lets
                            //       crash-bounce chaos carry enough spin to make the
                            //       flip watchdog non-deterministic.

    /* Hang time. A different mechanic from the authorities above: instead of
       shaping how the car ROTATES in the air, this scales gravity itself once
       the car has been genuinely airborne for a beat, so a jump flies further
       without changing how it tumbles. Gated on airTime the same way as the
       camera's airLo/airHi, so rut chatter never floats — only a real jump
       does. See the gravity term in vehicle.js and the note above
       `export const G` below. */
    hangGravity: 0.58,      // fraction of G while fully airborne — the arcade
                            //       hang-time. 1.0 = realistic.
    hangLo: 0.12,           // s of continuous airTime below which gravity stays
                            //       full (rut blips get no float).
    hangHi: 0.35,           // s of airTime by which the float is fully in.
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
     MINI-TURBO — the drift's payoff
     ------------------------------------------------------------------
     Hold a slide, charge a tier, release, get shoved down the road. The
     state machine is src/game/miniturbo.js; these are its numbers.

     TWO SLIP GATES, and the second one is the whole reason the AI has this
     feature at all. ai.js:816 sets `ctl.handbrake = 0` unconditionally —
     "the countersteer assist is better than we are" — so a handbrake-only
     charge would be a mechanic five of the six cars on the grid could never
     use. With `slipFree`, a genuine throttle slide charges too: the AI earns
     mini-turbos on the corners where it is actually sideways, with no change
     to ai.js, and a player who drifts on the throttle is rewarded for it.
     `slipHand` is the lower bar because with the handbrake down, 11° of slip
     is unambiguously a deliberate drift.

     WHY TIER 1 CANNOT RAISE TERMINAL SPEED (fireTop[0] = 1.00). Tier 1 fires
     twenty times a lap. `topSpeed` is an honest number that the UI quotes,
     the AI plans against and dev/vehicle-check gates to ±2 %; letting the
     most common event in the game move it would quietly make every one of
     those a lie. Tier 1 is pure shove. Only the tiers you have to work for
     move the ceiling.
     --------------------------------------------------------------- */
  boost: {
    slipHand: 0.20,         // rad of body slip that counts as charging, handbrake down
    slipFree: 0.34,         // rad without it — a real throttle slide, not a wobble
    slipFull: 0.62,         // rad at which the charge rate saturates
    /* Upper gate: past this you are spinning, not drifting. Deliberately the
       top of TUNE.drift.spinGuard — the same angle at which the stability
       controller comes back to stop the rotation. Without it, the fastest
       way to bank tier 3 would be to stop racing and do donuts. */
    slipMax: 1.15,          // rad
    minSpeed: 9.0,          // m/s — a donut in the paddock is not a drift
    fullSpeed: 22.0,        // m/s at which the speed term saturates

    /* Grace is the single value that makes a chained S-bend feel good.
       `drift.driftGripRecovery` already lets you flick-catch-flick; without a
       matching hold on the CHARGE, the second flick starts from zero and
       tier 3 is unreachable anywhere but a hairpin. */
    grace: 0.30,            // s the charge survives a lost slide
    decay: 1.2,             // 1/s it bleeds once the grace is spent

    /* THE TIERS ARE SMALL, AND THE MEASUREMENT SAYS THEY HAVE TO BE.
       A kart racer charges its turbo by holding one long drift. That cannot
       work here, and it is worth writing down why: in this handling model the
       handbrake is a ROTATION tool, not a sustainable state. Held down, it
       pins rearGripMul at 0.34 and the car's slip angle climbs monotonically
       — through the 0.20–1.15 rad drift band in about 0.47 s, and on to 180°
       and travelling backwards by two seconds. Swept across steer angles from
       0.3 to full lock at 32 m/s, the time spent inside the band never varied
       by more than 40 ms. The maximum charge any single handbrake application
       can produce is therefore about 0.36.

       So the mechanic is not "how long can you hold it" — the physics has no
       answer to that but "until you spin". It is HOW FAR DARE YOU ROTATE
       BEFORE YOU CATCH IT: tier 1 is a flick, tier 2 a committed rotation,
       tier 3 means riding it to about 63° with the spin one tenth of a second
       away. That is the skill this game already has, and this pays for it.

       Chaining still works, and is how a careful driver out-earns a brave one:
       a flick that banks less than tier 1 KEEPS its charge, and `decay` at
       1.2/s with a 0.30 s grace means a linked left-right adds up rather than
       starting over. Once a tier is banked, releasing spends it. */
    tier: [0.12, 0.24, 0.34],       // charge units (≈ seconds of saturated drift)
    fireT: [0.45, 0.85, 1.40],      // s the boost lasts
    fireMul: [1.35, 1.60, 1.95],    // × motorForce while boosting
    fireTop: [1.00, 1.06, 1.13],    // × topSpeed, as the DRIVE-FADE denominator only
    fireFov: [0.9, 1.8, 3.0],       // deg into feel.kick() on release
    fireShake: [0.06, 0.14, 0.26],  // feel.addShake() on release
    tierFov: 0.6,                   // deg of kick on each tier-up

    /* Tyre-dust tint per tier — cyan, then the house orange, then violet.
       Passed to dust.spawn OVER-BRIGHT (× glow): the colour attribute is
       unclamped end to end, so a value past 1 clears the bloom threshold and
       the sparks glow instead of just being coloured. */
    col: [[0.24, 0.72, 1.00], [1.00, 0.54, 0.10], [0.77, 0.42, 1.00]],
    glow: 2.6,

    /* A spin-out charges a mini-turbo — recovering from an oil slick with a
       tier-1 boost is the right arcade payoff. This is the cap that stops it
       being farmed: no charge for the first 0.4 s of a spin you did not ask
       for. */
    spinLockout: 0.40,      // s
  },

  /* ---------------------------------------------------------------
     RESET / RECOVERY — race.js owns the behaviour, these are its thresholds.
     --------------------------------------------------------------- */
  reset: {
    flipTime: 2.5,          // s upside-down (Vehicle.flipped true) before auto-reset.
    stuckTime: 4.0,         // s below stuckSpeed before auto-reset.
    stuckSpeed: 1.6,        // m/s — the "not actually going anywhere" threshold.
                            //       1.2 let a car beached on a slope slide backwards
                            //       through the window forever; 1.6 still clears any
                            //       real crawl (a mud bog at full throttle is mercy).
    noProgressDist: 4,      // m of race-line progress that counts as "still racing".
    noProgressTime: 6.0,    // s on the ground without it before recovery. The net
                            //       under every other gate: beached cars can dodge
                            //       stuck/wedge/off-course thresholds indefinitely,
                            //       but they cannot fake forward progress.
    offCourseDist: 30,      // m from the centreline before you count as lost.
                            //       Raised from 25 alongside the longer arcade
                            //       hang (TUNE.air.hangGravity) — bigger air can
                            //       carry you further off-line before you are
                            //       back down to be judged.
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
      /* A bike is the one body whose envelope is genuinely small. radius runs
         over 1.0 because W (0.86 m) is bar width, not body width, and a
         0.43 m sphere would let a car's nose reach the rider before anything
         touched. 1.24 puts the envelope at rider-plus-elbows. */
      bike: { radius: 1.24, spread: 1.00 },
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

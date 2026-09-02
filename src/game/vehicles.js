/* ============================================================
   RALLY ROAD RASH — THE ROSTER
   ------------------------------------------------------------
   Pure data. No three.js, no DOM: importable from Node tests, from the UI,
   and from the physics alike.

   How to read a spec
   ------------------
   Anything with a unit is a real physical quantity fed straight into the
   rigid body. Anything ending in `Scale`, `Bonus` or `Split` is a multiplier
   on a shared value in config.js — that is where the car's *character*
   lives, and it is the safe place to tune.

   Sizing rules that hold across the whole roster (break them and the checks
   fail):

     suspK   is derived from a target ride frequency f:  k = (mass/4)·(2πf)²
             Static sag is then simply G/(2πf)², independent of mass, and it
             must land at 12–18 % of suspTravel. All three sit at 2.0–2.2 Hz,
             the stiff end of the off-road band — with G = 12.8 anything
             softer would need 0.7 m+ of travel to keep the sag fraction
             honest, and that would put the centre of mass too high to hold
             a rollover margin.

     suspC   is ζ·2·√(suspK·mass/4) with ζ ≈ 0.74–0.82. Under-damped enough
             that landings visibly work the suspension, over-damped enough
             that a whoops section does not turn into a pogo stick.

     comHeight is the roll/pitch lever arm — the centre of mass above the
             contact patch. It is the ONLY thing standing between arcade grip
             levels and cars on their roofs. Rollover threshold is
             (track / comHeight) · G; keep it at least 1.2× the peak lateral
             acceleration the tyres can generate on ROAD, which is
             max(gripF, gripR) · G. All three are deliberately lower than a
             real vehicle of that silhouette would be.

     motorForce must satisfy  drive.fadeTail · motorForce > drag(topSpeed),
             or the car will never reach the top speed printed on its card.
             drag(topSpeed) = aero + rolling resistance on DIRT.
   ============================================================ */

export const VEHICLES = [

  /* -----------------------------------------------------------------
     DUNE HOPPER — the one you learn on and the one you keep coming back to.
     Tube-frame buggy: light, huge travel for its size, mild understeer on
     turn-in that turns into a lazy, catchable slide if you overdo it. Fast
     enough to win on every track, best on none of them.
     ----------------------------------------------------------------- */
  {
    id: 'hopper',
    name: 'DUNE HOPPER',
    desc: 'Sport side-by-side. Forgiving, floaty, quick everywhere.',
    color: 0x2857e0,
    bodyStyle: 'buggy',

    mass: 1120,                       // kg
    dims: { L: 3.95, W: 1.98, H: 1.34 },  // m — bounding box, drives inertia and aero

    wheelR: 0.42,                     // m — rolling radius
    wheelW: 0.34,                     // m — tyre width (visual + contact patch feel)
    track: 0.94,                      // m — HALF track, wheel centre from centreline
    wheelbase: { front: 1.34, rear: -1.30 },   // m — axle z in body space (+Z forward)

    suspRest: 0.50,                   // m — strut length from mount to hub at full droop
    suspTravel: 0.40,                 // m — usable compression before the bump stop
    suspK: 51200,                     // N/m per corner  → 2.15 Hz, sag 0.070 m = 17.5 %
    suspC: 5900,                      // N·s/m per corner → ζ = 0.78

    motorForce: 11800,                // N total at the contact patches → 10.5 m/s² peak
    brakeForce: 24000,                // N total. Sized above the friction limit so ABS,
                                      //   not the calipers, decides the stopping distance.
    topSpeed: 39,                     // m/s (140 km/h)
    revRange: [850, 7600],            // rpm — rpmNorm 0..1 maps onto this for HUD + audio

    gripF: 1.46,                      // base µ, multiplied by SURFACES[].grip
    gripR: 1.40,                      //   front > rear ⇒ safe, progressive understeer
    driveSplit: 0.45,                 // fraction of drive to the front axle (AWD, rear-biased)
    brakeBias: 0.58,                  // fraction of brake to the front axle

    comHeight: 0.52,                  // m above the contact patch. Threshold 23.1 m/s²
                                      //   vs 18.7 peak lateral on ROAD → 1.24× margin.
    antiRollBonus: 1.00,              // × TUNE.assists.antiRoll
    steerLockScale: 1.00,             // × TUNE.steer.maxLock

    liveryHues: [0.00, 0.09, 0.42, 0.58, 0.79],   // hue offsets (turns) for AI variants
  },

  /* -----------------------------------------------------------------
     RIDGEBACK — the heavy one. Wide track, long wheelbase, the most grip on
     the card and the most torque under 20 m/s. It shrugs off ruts and body
     contact that would put the other two in the scenery, and it pays for all
     of that with 5 m/s of top end and a lazy change of direction.
     ----------------------------------------------------------------- */
  {
    id: 'ridgeback',
    name: 'RIDGEBACK',
    desc: 'Two tonnes of bullbar. Planted, torquey, allergic to straights.',
    color: 0x3f9d54,
    bodyStyle: 'truck',

    mass: 1680,
    dims: { L: 4.60, W: 2.20, H: 1.88 },

    wheelR: 0.48,
    wheelW: 0.40,
    track: 1.06,
    wheelbase: { front: 1.58, rear: -1.54 },

    suspRest: 0.56,
    suspTravel: 0.48,
    suspK: 67900,                     // → 2.02 Hz, sag 0.079 m = 16.5 %
    suspC: 8760,                      // → ζ = 0.82, the most damped of the three

    motorForce: 17500,                // 10.4 m/s² peak — out-drags the Hopper to 20 m/s
    brakeForce: 36000,
    topSpeed: 34,
    revRange: [700, 6200],            // low and gruff

    gripF: 1.48,
    gripR: 1.50,                      // rear-biased grip: it simply will not swap ends
    driveSplit: 0.50,                 // locked-centre AWD
    brakeBias: 0.56,

    comHeight: 0.58,                  // threshold 23.4 m/s² vs 19.2 peak → 1.22× margin.
                                      //   Very low for a 1.88 m tall truck; that is the
                                      //   deal we make so it can carry this much grip.
    antiRollBonus: 1.35,              // fat bars — it stays flat and refuses to tip
    steerLockScale: 0.88,             // less lock: a long, heavy car with full lock just
                                      //   scrubs the fronts and goes straight on

    liveryHues: [0.00, 0.13, 0.31, 0.63, 0.86],
  },

  /* -----------------------------------------------------------------
     REDLINE — the fast one, and the one that will bin you. Low, light, short
     on rear grip and rear-drive biased, so it rotates the instant you lift
     mid-corner. Its reward is 45 m/s and the sharpest turn-in in the game.
     Demands throttle discipline: squeeze, do not stab.
     ----------------------------------------------------------------- */
  {
    id: 'redline',
    name: 'REDLINE',
    desc: 'Cab-forward wedge. Fastest thing here, and it knows it.',
    color: 0xe1252b,
    bodyStyle: 'wedge',

    mass: 1010,
    dims: { L: 4.25, W: 1.90, H: 1.14 },

    wheelR: 0.37,
    wheelW: 0.31,
    track: 0.90,
    wheelbase: { front: 1.48, rear: -1.42 },

    suspRest: 0.46,
    suspTravel: 0.38,
    suspK: 47800,                     // → 2.19 Hz, sag 0.068 m = 17.8 % — stiffest ride
    suspC: 5140,                      // → ζ = 0.74, the loosest damping: it moves about

    motorForce: 11800,                // 11.7 m/s² peak — best power-to-weight.
                                      //   12200 overpowered the rear axle: it spun out
                                      //   of the steady-state cornering check instead
                                      //   of settling. 11800 + gripR 1.42 keeps the
                                      //   tail lively but catchable.
    brakeForce: 23000,
    topSpeed: 45,
    revRange: [950, 8600],            // screams

    gripF: 1.56,                      // huge front end…
    gripR: 1.42,                      // …and a rear axle that is only ever a suggestion
    driveSplit: 0.28,                 // rear-drive biased: throttle rotates it
    brakeBias: 0.62,                  // forward bias to stop the rear stepping out on entry

    comHeight: 0.44,                  // threshold 26.2 m/s² vs 20.0 peak → 1.31× margin.
                                      //   Lowest car, biggest margin — it slides, it does
                                      //   not roll, which is exactly the failure mode you
                                      //   want on the twitchy one.
    antiRollBonus: 0.85,              // softer bars: it leans, and the lean telegraphs
    steerLockScale: 1.06,             // sharpest rack in the game

    liveryHues: [0.00, 0.07, 0.35, 0.52, 0.72],
  },

  /* -----------------------------------------------------------------
     HORNET — the motocross 450, and the only two-wheeler on the grid.

     ONE MODEL, TWO TRACKS
     ---------------------
     The rigid body underneath every vehicle in this game has four corners,
     and rewriting it for one bike would put every gate in dev/vehicle-check
     back on the table. So the Hornet is a four-corner body that is DRAWN as
     a single-track machine: vehicle.js collapses both wheels of an axle onto
     the centreline and banks the whole bike into the corner (see
     `bikeLean`). Nothing the player can see has four wheels.

     What that buys, and what it costs:
       • `track` (0.68) is an INVISIBLE outrigger. It exists only to keep the
         rollover margin honest — (track/comHeight)/grip = 1.21x, the same
         gate the cars pass. A real 0.1 m half-track would put the bike on
         its side in the first corner and there is nothing in a four-corner
         solver that would stop it.
       • `antiRollBonus` 1.55 is the second half of that deal. The visual
         lean is cosmetic, so the body underneath has to stay flat or the
         drawn lean stacks on top of a real roll and the bike looks drunk.
       • Everything a player actually feels — 245 kg, the lowest yaw inertia
         on the grid, the sharpest rack, and the least grip — is real.

     Character: it out-accelerates and out-jumps everything (a quarter of the
     Ridgeback's mass off the same lip is a different sport), and it has less
     grip than anything else here, so it arrives at every corner asking to be
     slid. Contact is what kills it: 245 kg against 1680 kg of Ridgeback is
     not an argument you win.
     ----------------------------------------------------------------- */
  {
    id: 'moto',
    name: 'HORNET',
    desc: 'Motocross 450. Half the weight, twice the air, no margin at all.',
    color: 0xe8c21a,
    bodyStyle: 'bike',

    mass: 245,                        // kg — 110 kg bike + rider + arcade fudge
    dims: { L: 2.18, W: 0.86, H: 1.55 },  // W is BAR width, not body width; H is
                                      //   ground-to-helmet with the rider up on the pegs.
                                      //   Both feed aero and the collision spheres, so
                                      //   moving the rider means re-checking the top-speed
                                      //   gate — see TUNE.aero.cd.bike.

    wheelR: 0.36,                     // m — an 80/100-21 front measures 0.347 m; the
                                      //   rear is a 19 and the model splits the difference
    wheelW: 0.12,
    track: 0.74,                      // m — see the outrigger note above
    wheelbase: { front: 0.72, rear: -0.72 },   // 1.44 m, real MX numbers

    suspRest: 0.52,                   // long forks
    suspTravel: 0.40,                 // m — 400 mm is generous for MX, but the sag
                                      //   band (12–18 %) and the 1.6–2.25 Hz band
                                      //   cannot both be met on 300 mm at G = 12.8
    suspK: 11700,                     // N/m per corner → 2.20 Hz, sag 0.067 m = 16.8 %
    suspC: 1320,                      // → ζ = 0.78

    motorForce: 3050,                 // N → 12.45 m/s² on paper. It never sees that:
                                      //   rear-biased drive on 245 kg is traction
                                      //   limited off the line, so it wheelspins,
                                      //   TC catches it, and it still leaves.
    brakeForce: 6200,                 // above the friction limit, like the cars
    topSpeed: 40,                     // m/s (144 km/h)
    revRange: [1400, 11500],          // a 450 single. Screams higher than the Redline.

    gripF: 1.42,                      // knobblies in loose dirt genuinely hook up, so the
    gripR: 1.48,                      //   bike is not the low-grip machine — the front is
                                      //   simply the end that lets go first, and tucking
                                      //   it makes you a passenger. Rear-biased, because
                                      //   a bike drives out of a corner on the back wheel.
    driveSplit: 0.12,                 // chain drive is 0.00; 0.12 is the smallest front
                                      //   share that keeps a 1.44 m wheelbase pointing
                                      //   where it was aimed under the shared solver
    brakeBias: 0.66,                  // front-brake dominant, the way a bike stops

    comHeight: 0.40,                  // rollover threshold 23.7 m/s² vs 18.9 peak lateral
                                      //   → 1.25× margin
    antiRollBonus: 1.55,              // the invisible outrigger's spring — see above
    /* LOW, and that is not a typo. The wheelbase is 1.44 m against the
       Hopper's 2.64, so the same rack angle asks for twice the yaw rate;
       past the tyre's peak slip angle the surplus is not cornering, it is
       scrubbing, and full lock at 1.22 measured 32.6 m of radius against the
       Hopper's 24.0. At 0.78 the bike turns inside every car on the grid at
       walking pace (3.1 m against the Hopper's 4.3) and is grip-limited, not
       scrub-limited, everywhere above it. The sharpest steering RESPONSE in
       the game comes from the yaw inertia, which is a third of a car's. */
    steerLockScale: 0.78,

    liveryHues: [0.00, 0.11, 0.28, 0.55, 0.81],
  },
];

/* Lookup by id — the UI, save data and the AI all address cars by string. */
export const VEHICLE_BY_ID = Object.fromEntries(VEHICLES.map(v => [v.id, v]));

/* ============================================================
   STAT BARS (for the vehicle-select screen)
   ------------------------------------------------------------
   Four 0..1 numbers. The ranges below are FIXED, not derived from the roster:
   when the Hornet joined, the bars on the other three did not move by a pixel,
   which is the entire point. The bike pins `accel` and bottoms out `grip` and
   `weight` — all three are true statements about it, and the 0.05 floor in
   `bar()` is what keeps a bottomed-out bar visible rather than absent.
   ============================================================ */
const RANGE = {
  speed:  [26, 48],       // m/s of topSpeed
  accel:  [6.5, 12.5],    // m/s² of motorForce / mass
  grip:   [1.30, 1.60],   // mean of gripF and gripR
  weight: [950, 1800],    // kg
};

const bar = (v, [lo, hi]) => Math.max(0.05, Math.min(1, (v - lo) / (hi - lo)));

/**
 * statBars(spec) -> { speed, accel, grip, weight }, each 0.05..1.
 * `weight` is a *fact*, not a virtue: draw it in a neutral colour or the
 * Ridgeback reads as the best car on the screen.
 */
export function statBars(spec) {
  return {
    speed:  bar(spec.topSpeed, RANGE.speed),
    accel:  bar(spec.motorForce / spec.mass, RANGE.accel),
    grip:   bar((spec.gripF + spec.gripR) * 0.5, RANGE.grip),
    weight: bar(spec.mass, RANGE.weight),
  };
}

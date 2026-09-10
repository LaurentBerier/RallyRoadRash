/* ============================================================
   RALLY ROAD RASH — CAMERA RIG   (CHASE / HOOD / ORBIT)
   ------------------------------------------------------------
   The chase camera is most of what a player calls "game feel", so almost every
   number in here is a feel decision rather than a technical one. Three rules
   run through the whole file:

     1. NOTHING SNAPS. Every quantity the camera derives from the car — boom
        yaw, boom pitch, the pivot it hangs off, the ground clearance, the FOV —
        moves through a spring or a first-order filter. The one exception is
        snapBehind(), which exists precisely so race.js has a way to say "cut".
     2. THE HORIZON IS FIXED. Chase never rolls. Rally cars spend a lot of time
        sideways and a lot of time in the air; a camera that rolls with the body
        turns that into motion sickness and hides where the road went. HOOD is
        the opposite — it IS the driver, so it rolls fully.
     3. THE CAMERA FOLLOWS TRAVEL, NOT THE NOSE. Chase yaw tracks the velocity
        heading, so a drifting car sits visibly rotated inside the frame. If the
        boom tracked `forward` instead, a 30° slide would look like driving
        straight and the entire drift model would be invisible.

   Allocation discipline: every vector/quaternion this file needs per frame is
   either an instance field or a module scratch at the bottom. `new`, `.clone()`,
   array literals and closures are all forbidden inside update().

   Vehicle reads (as-built contract, docs/INTEGRATION-NOTES.md): pos, quat, vel,
   speed, forward, up, airborne, airTime, contacts, omega, spinT. `steerNorm` is
   read defensively for the lateral look-ahead and falls back to filtered lateral
   acceleration if a caller's vehicle-like object does not carry it; `omega` and
   `spinT` are read the same way, and a vehicle-like without them simply never
   trips the crash/spin gate.
   ============================================================ */
import * as THREE from 'three';
import { clamp, sstep } from '../core/rng.js';

export const CAM = { CHASE: 0, HOOD: 1, ORBIT: 2 };
const NAMES = ['CHASE', 'HOOD', 'ORBIT'];

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------
   CHASE tuning. Every distance is metres, every angle radians.
   ------------------------------------------------------------ */
const CH = {
  dist: 7.2,              // m — boom length at rest. Zoom moves this, speed scales it.
  distMin: 5.2,           // m — zoom limits. Session-only; nobody persists them.
  distMax: 11.0,
  distSpeed: 0.22,        // fraction added to the boom at speedRef and above.
  speedRef: 40,           // m/s — "flat out" reference. Faster than any car's top
                          //       speed on purpose, so the scaling never saturates
                          //       before the car does.
  lift: 0.40,             // m — constant eye lift over the boom tip. With the boom
                          //     at 7.2 m / 9° this puts the eye ~2.6 m over the road,
                          //     which is the height the shot was framed for.
  pivotUp: 1.1,           // m — the boom hangs off pos + WORLD-up × this. World up,
                          //     not body up: the pivot must not pitch with the car.

  pitch0: 9 * D2R,        // boom elevation at rest…
  pitch1: 14 * D2R,       // …and flat out. Rising elevation is what keeps the road
                          //   visible once look-ahead has run the aim point 13 m
                          //   past the nose.
  pitchLo: 8, pitchHi: 34,        // m/s over which pitch0 → pitch1
  pitchMin: -0.30, pitchMax: 1.25, // rad — manual look limits (final, post-offset)
  pitchRate: 3.5,         // 1/s — first-order follow on the auto pitch.

  slopeW: 0.35,           // how much of the ground slope ahead is folded into pitch.
                          //   1.0 would glue the camera to the hill and make crests
                          //   lurch; 0 hides the road every time you crest one.
  slopeAhead: 10,         // m — base slope sample distance…
  slopeAheadV: 0.25,      // …plus this per m/s, capped by slopeAheadMax.
  slopeAheadMax: 24,
  slopeMax: 25 * D2R,     // rad — clamp. A cliff must not fling the boom.
  slopeLP: 2.2,           // 1/s — the slope signal is the noisiest input the rig has.

  aheadBase: 2.2,         // m — look-ahead at a standstill…
  aheadSpeed: 0.28,       // …+ this per m/s. At 38 m/s the aim sits 12.8 m up the road.
  aheadMax: 18,
  lateral: 1.6,           // m — full-lock lateral shift of the aim point. This is the
                          //     one that makes corners "open up" before you turn in.
  latLo: 3, latHi: 18,    // m/s over which the lateral shift fades in (no view swing
                          //     while parking).

  slipLo: 0.06, slipHi: 0.45,   // rad of body slip over which the aim direction hands
                                //   over from the nose to the direction of travel.
  travelLo: 1.5, travelHi: 6.5, // m/s over which boom yaw hands over from nose to travel.

  /* ---- the nose cone (rule 3, bounded) ----
     Rule 3 is right about WHY the boom follows travel and wrong about how far
     it may go. This car carries real slip — a committed drift runs 30-45° and
     a throttle-on slide holds it for the whole corner — and a boom that tracks
     the velocity heading faithfully swings that far around the flank and stays
     there. From the seat that is not "the drift reads", it is the camera
     orbiting the car mid-corner, and it costs you the one thing the shot is
     for: seeing where the road goes next.
     So travel still aims the boom, inside a cone around the nose. Under the
     cone nothing changes at all; past it the shot stops rotating and the car
     rotates inside the frame instead — which is the drift, drawn by the car
     rather than by the lens. The cone opens to a full circle in the air, where
     the nose is meaningless (the car may be mid-barrel-roll and travel is the
     only honest heading), and the tumble latch below still overrides both. */
  noseCone: 0.20,         // rad — 11.5°, the most the boom may sit off the nose
                          //   on the ground. Tune with rig.noseCone; 0 pins the
                          //   camera dead astern, Math.PI restores pure rule 3.
  noseConeAir: Math.PI,   // rad — no cone at all once fully airborne.

  yawHz: 1.91,            // Hz — critically damped boom yaw. See note in _chase().
  yawAirMul: 0.55,        // the same spring, softened while airborne.

  /* ---- the crash/spin gate ----
     Rule 3 says the boom follows travel, and it is right up until the car stops
     travelling and starts rotating. A spin-out has no heading anybody wants to
     look along: the nose sweeps 360°, the velocity heading sweeps with it, and
     the yaw spring faithfully chases both — which is the "the camera gets
     confusing when I crash" report. So while the car is tumbling the boom yaw
     is FROZEN on the last heading from before it went wrong, and the boom is
     lengthened so the whole mess fits in frame. */
  tumbleOmega: 2.5,       // rad/s of body yaw rate that counts as a spin. 143°/s
                          //   is past any corner: at 30 m/s that is a 12 m radius.
  tumbleUpY: 0.6,         // body up.y below which the car is on its side or worse
                          //   (53° off vertical) and its nose means nothing.
  tumbleDist: 1.45,       // boom length multiplier at full tumble, ceilinged at
                          //   distMax so a crash never puts the eye further out
                          //   than the player's own zoom can ask for.
  tumbleBlend: 1.2,       // 1/s — how fast the pull-back comes IN. Deliberately
                          //   slow: this is the same lesson as airLo/airHi. A
                          //   kerb strike spikes omega for three frames and a
                          //   fast blend would pump the boom on every rut.
  tumbleFall: 3.0,        // 1/s — and how fast it goes back OUT once the car is
                          //   settled. Faster than it came in, because by then
                          //   the shot belongs to the player again; still under
                          //   the 6/s the airborne blend uses, so it reads as a
                          //   move rather than a snap. With tumbleZero this puts
                          //   a full release at ~1.3 s.
  tumbleZero: 0.02,       // below this the blend is snapped to exactly 0. It has
                          //   to reach zero, not approach it: zero is the only
                          //   state in which _stableYaw tracks the live boom.
  tumbleReleaseOmega: 0.8,   // rad/s — "settled" is slow…
  tumbleReleaseContacts: 3,  // …and back on at least three wheels.

  pivotXZ: 22,            // 1/s — pivot follow, horizontal. Near-rigid: horizontal lag
                          //     reads as rubber-banding, not as weight.
  pivotY: 13,             // 1/s — vertical follow on the ground. Loose enough that
                          //     suspension chatter never reaches the lens.
  pivotYAir: 3.4,         // 1/s — vertical follow in the air. THIS is what makes a jump
                          //     read: the car climbs out of the frame and drops back in.
                          //     Lowered further still: the car climbs even further out of
                          //     frame on a big jump, and that IS the jump reading bigger.
  airBlend: 6,            // 1/s — how fast the airborne settings fade in and back out.
                          //     ~0.5 s of recovery after touchdown, which is the whole
                          //     "no snap on landing" requirement.
  airLo: 0.07,            // s of continuous air below which the blend stays at zero…
  airHi: 0.20,            // …and above which it is allowed to go all the way to 1.
                          //   `vehicle.airborne` is literally `contacts === 0`, so at
                          //   speed a rutted straight sets it for one or two frames at
                          //   a time. Chasing those blips pumps the boom by 12 %, the
                          //   FOV by 4° and the vertical follow rate by 3×, several
                          //   times a second — which is most of what "the camera goes
                          //   unstable when I go fast" actually is. A real jump clears
                          //   airHi in the first 12 frames and is unaffected.
  airDist: 1.22,          // boom length multiplier while airborne.
  airFov: 8,              // deg of extra FOV while airborne.

  fovBase: 58,            // deg (× fovScale)
  fovSpeed: 13,           // deg added by speed…
  fovLo: 12, fovHi: 40,   // …over this m/s window.
  fovRate: 5,             // 1/s — FOV follow. Feel's transients bypass this (see below).

  ground: 0.55,           // m — minimum clearance over terrain along the boom.
  groundUp: 22,           // 1/s — how fast the rig climbs out of a hill. Fast: being
                          //     inside the ground is the worst thing a camera can do.
  groundDown: 3.0,        // 1/s — how fast it comes back down. Slow, or every rut
                          //     pumps the camera.
  taps: 4,                // terrain samples along the boom, including the eye itself.
};

/* ------------------------------------------------------------ HOOD */
const HD = {
  x: 0, y: 1.18, z: 0.55,   // m, vehicle-local. Vehicle forward is +Z.
  slerp: 30,                // 1/s — just enough to take the edge off the physics
                            //     quaternion without introducing swim.
  trim: -1.5 * D2R,         // rad — nose-down trim so the bonnet is not the whole frame.
  fovBase: 62, fovSpeed: 8,
  ground: 0.25,             // m — only a tunnelling guard; the mount is rigid.
};

/* ------------------------------------------------------------ ORBIT */
const OR = {
  r: 9.0,                   // m at default zoom; zoom scales it proportionally.
  rate: 0.14,               // rad/s
  h: 2.6, bob: 0.55, bobRate: 0.45,
  lookUp: 0.9,
  fov: 50,
};

const BLEND = 0.28;         // s — cross-fade on a mode change. Cutting from a 7 m boom
                            //     to a bonnet mount is a hard cut in the worst place;
                            //     snapBehind() is the sanctioned way to actually cut.

const SHAKE_CAP = 1.5;      // impulse channel ceiling
const SHAKE_DECAY = 2.6;    // 1/s
const ROT_CAP = 0.055;      // rad (~3.2°) — total rotational shake clamp
const POS_CAP = 0.045;      // m — total positional shake clamp

/* Shake oscillator rates, rad/s. These are SAMPLED once a frame, never
   filtered, so the ceiling is set by the frame rate and not by taste: at 60 Hz
   anything past ~30 rad/s (4.8 Hz) gets under seven samples a cycle and reads
   as erratic judder rather than as vibration — and because dt is whatever rAF
   hands us, the phase step is irregular too, so the judder does not even repeat.
   The originals ran at 47–62 rad/s (7.5–9.8 Hz), which is why the continuous
   speed shake looked like the camera coming loose. Everything here is under
   30 rad/s and mutually non-commensurate so the sum still never repeats. */
const RS = {
  rotA: 24.1, rotB: 13.7,   // yaw pair  — 3.8 Hz / 2.2 Hz
  rotC: 19.9, rotD: 10.3,   // pitch pair — 3.2 Hz / 1.6 Hz
  posA: 27.7, posB: 22.3,   // 4.4 Hz / 3.5 Hz
  rumRot: 0.009,            // rad per unit rumble (was 0.016)
  rumPos: 0.018,            // m   per unit rumble (was 0.035)
};

/* ============================================================
   CameraRig
   ============================================================ */
export class CameraRig {
  constructor(camera, terrain) {
    this.cam = camera;
    this.terrain = terrain;
    this.mode = CAM.CHASE;

    /* ---- boom state ---- */
    this.yaw = 0;                 // rad, world heading the camera LOOKS along
    this.pitch = CH.pitch0;       // rad, boom elevation over the pivot
    this.dist = CH.dist;          // m, zoom-adjusted base boom length
    this.yawHz = CH.yawHz;        // public: the one knob for "how tight is the follow"
    this.noseCone = CH.noseCone;  // public: and the one for "how far off astern may it get"
    this._yawVel = 0;

    /* ---- manual look, as offsets on top of the auto boom ---- */
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookIdle = 99;           // s since the player last touched the look axis

    /* ---- settings surface (T5 writes these) ---- */
    this.fovScale = 1;            // settings.fov / 58
    this.sens = 1.0;
    this.invertY = false;
    this.autoCentre = 1;          // 0 off · 1 slow (2.6 s) · 2 fast (1.0 s)

    /* ---- juice inputs, written by feel.js, consumed here ----
       The rig applies these; Feel owns their envelopes. Keeping the decay on
       Feel's side is what lets one place (feel.js) hold the whole juice budget
       and stops two systems from both deciding how long a kick lasts. */
    this.kickPitch = 0;           // rad, + = look up
    this.kickYaw = 0;             // rad, + = look right
    this.fovOffset = 0;           // deg, added raw AFTER the FOV filter
    this.rumble = 0;              // 0..1 continuous high-frequency shake
    this.sway = 0;                // 0..1 continuous low-frequency lateral sway

    /* ---- shake channels ---- */
    this.shake = 0;               // impulse channel, decayed here
    this._rumbleS = 0;            // smoothed continuous channel

    /* ---- smoothing state ---- */
    this._pivot = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._air = 0;                // 0..1 airborne blend
    this._tumble = 0;             // 0..1 crash/spin blend (see CH.tumble*)
    this._stableYaw = 0;          // rad, the boom heading from before the spin
    this._slope = 0;              // rad, low-passed ground slope ahead
    this._avoid = 0;              // m, current terrain push-up
    this._hoodQ = new THREE.Quaternion();
    this._orb = 0;                // rad, orbit phase
    this._t = 0;                  // s, internal clock (no performance.now — the dev
                                  //   harness runs this in Node and wants determinism)
    this._first = true;

    /* ---- FOV ---- */
    this.fov = CH.fovBase;
    this._fovTarget = CH.fovBase;

    /* ---- mode cross-fade ---- */
    this._blendT = 0;
    this._blendPos = new THREE.Vector3();
    this._blendQuat = new THREE.Quaternion();
    this._blendFov = CH.fovBase;
  }

  get modeName() { return NAMES[this.mode] || 'CHASE'; }

  /* ------------------------------------------------------------
     Mode changes cross-fade rather than cut. The frozen "from" pose is the
     camera exactly as it was last frame, so the first frame of a switch moves
     the eye by almost nothing and the switch reads as a move, not a glitch.
     ------------------------------------------------------------ */
  setMode(m, vehicle) {
    m = (m | 0) % 3; if (m < 0) m += 3;
    if (m === this.mode) return;
    this._blendPos.copy(this.cam.position);
    this._blendQuat.copy(this.cam.quaternion);
    this._blendFov = this.cam.fov;
    this._blendT = BLEND;

    // Re-datum on entry. CHASE parks its yaw behind the car; carrying an orbit
    // angle into it (or a chase angle into the orbit) starts the shot facing
    // somewhere nobody asked for.
    if (vehicle) {
      const h = headingOf(vehicle);
      if (m === CAM.CHASE) { this.yaw = h; this._yawVel = 0; this.pitch = CH.pitch0; }
      if (m === CAM.ORBIT) this._orb = this.yaw + Math.PI;
      if (m === CAM.HOOD) { _q1.copy(vehicle.quat).multiply(_qFlip); this._hoodQ.copy(_q1); }
    }
    this.lookYaw = 0; this.lookPitch = 0; this.lookIdle = 99;
    this.mode = m;
  }

  cycle(vehicle) { this.setMode((this.mode + 1) % 3, vehicle); }

  addShake(v) {
    if (!(v > 0)) return;
    this.shake = Math.min(SHAKE_CAP, this.shake + v);
  }

  /** Continuous channels, set every frame by feel.js. */
  setRumble(hi, lo) {
    this.rumble = hi > 0 ? hi : 0;
    this.sway = lo > 0 ? lo : 0;
  }

  /* ------------------------------------------------------------
     The one sanctioned cut: race start, respawn, anything that teleports the
     car. Every spring is zeroed and the eye is placed this frame, so the next
     update() has nothing to recover from.
     ------------------------------------------------------------ */
  snapBehind(vehicle) {
    if (!vehicle) return;
    this.yaw = headingOf(vehicle);
    this._yawVel = 0;
    this.pitch = CH.pitch0;
    this.lookYaw = 0; this.lookPitch = 0; this.lookIdle = 99;
    this._air = 0; this._slope = 0; this._avoid = 0;
    this._tumble = 0; this._stableYaw = this.yaw;
    this.shake = 0; this._rumbleS = 0;
    this.kickPitch = 0; this.kickYaw = 0; this.fovOffset = 0;
    this.rumble = 0; this.sway = 0;
    this._blendT = 0;
    this._first = true;
    this.fov = CH.fovBase * this.fovScale;
    this._fovTarget = this.fov;
    this._orb = this.yaw + Math.PI;
    _q1.copy(vehicle.quat).multiply(_qFlip); this._hoodQ.copy(_q1);
    // Place the eye now so a caller that snaps and renders in the same frame
    // (grid formation, results screen) never shows the old pose.
    this.update(1 / 60, vehicle, null);
  }

  /* ============================================================
     MAIN
     ============================================================ */
  update(dt, vehicle, look) {
    if (!vehicle) return;
    dt = dt > 0 ? (dt < 0.05 ? dt : 0.05) : 1 / 240;
    this._t += dt;

    /* ---- manual look ---------------------------------------- */
    const lx = look ? (look.lookX || 0) : 0;
    const ly = look ? (look.lookY || 0) : 0;
    const lz = look ? (look.zoom || 0) : 0;
    const s = 0.0022 * this.sens;
    if (this.mode !== CAM.ORBIT) {
      // Sign convention: positive lookX swings the view right.
      this.lookYaw -= lx * s;
      this.lookPitch = clamp(this.lookPitch + ly * s * (this.invertY ? -1 : 1), -1.2, 1.2);
    }
    if (lz) this.dist = clamp(this.dist + lz * 0.9, CH.distMin, CH.distMax);

    const moving = (look && look.looking) || Math.abs(lx) > 1e-3 || Math.abs(ly) > 1e-3;
    this.lookIdle = moving ? 0 : this.lookIdle + dt;

    const vHoriz = Math.hypot(vehicle.vel.x, vehicle.vel.z);
    this._autoCentre(dt, vHoriz);

    /* ---- airborne blend -------------------------------------
       Gated on how long the car has actually been off the ground, not on the
       raw flag: see CH.airLo. A vehicle-like without airTime keeps the old
       all-or-nothing behaviour. */
    const airWant = vehicle.airborne
      ? (typeof vehicle.airTime === 'number'
        ? sstep(CH.airLo, CH.airHi, vehicle.airTime) : 1)
      : 0;
    this._air += (airWant - this._air) * (1 - Math.exp(-dt * CH.airBlend));

    /* ---- crash / spin blend ---------------------------------
       A latch, not a follower: it ENGAGES on the spin and only lets go once the
       car is both slow in rotation and back on its wheels. In between — a car
       that has stopped spinning but is still in the air, still on its roof, or
       still sliding on two wheels — it holds, because none of those are
       "settled" either and the whole point is to not hand the shot back early.

       Every field here is read defensively. A vehicle-like that publishes none
       of them (the dev harness's mock, the garage turntable, a menu prop) is a
       car that never tumbles, which is the correct answer for all three. */
    const omg = vehicle.omega;
    let omY = 0, omLen = 0;
    if (omg) {
      omY = omg.y || 0;
      omLen = Math.hypot(omg.x || 0, omY, omg.z || 0);
    }
    // `up` is a getter on the real vehicle (it writes a scratch and hands it
    // back), so it is read exactly once. Anything that is not a number reads as
    // upright: an absent `up` must not be mistaken for a car on its roof.
    const upv = vehicle.up;
    const upY = upv && typeof upv.y === 'number' ? upv.y : 1;
    const cts = typeof vehicle.contacts === 'number' ? vehicle.contacts : CH.tumbleReleaseContacts;
    let tumbleWant;
    if (omg && (Math.abs(omY) > CH.tumbleOmega || (vehicle.spinT || 0) > 0 || upY < CH.tumbleUpY)) {
      tumbleWant = 1;
    } else if (omLen < CH.tumbleReleaseOmega && cts >= CH.tumbleReleaseContacts) {
      tumbleWant = 0;
    } else {
      tumbleWant = this._tumble > 0 ? 1 : 0;
    }
    const tRate = tumbleWant > this._tumble ? CH.tumbleBlend : CH.tumbleFall;
    this._tumble += (tumbleWant - this._tumble) * (1 - Math.exp(-dt * tRate));
    if (tumbleWant === 0 && this._tumble < CH.tumbleZero) this._tumble = 0;
    /* The datum, taken BEFORE the per-mode pose runs, so it is always last
       frame's finished boom heading — i.e. the last one from before things went
       wrong, whichever frame that turns out to have been. */
    if (this._tumble === 0) this._stableYaw = this.yaw;

    /* ---- per-mode pose -------------------------------------- */
    if (this.mode === CAM.HOOD) this._hood(dt, vehicle);
    else if (this.mode === CAM.ORBIT) this._orbit(dt, vehicle);
    else this._chase(dt, vehicle, vHoriz);

    /* ---- mode cross-fade ------------------------------------ */
    if (this._blendT > 0) {
      const w = 1 - this._blendT / BLEND;
      const e = w * w * (3 - 2 * w);
      this.cam.position.lerp(this._blendPos, 1 - e);
      this.cam.quaternion.slerp(this._blendQuat, 1 - e);
      this._fovTarget = this._fovTarget + (this._blendFov - this._fovTarget) * (1 - e);
      this._blendT -= dt;
    }

    /* ---- shake + kicks, applied to the finished pose --------- */
    this._applyShake(dt);

    /* ---- FOV ------------------------------------------------- */
    // The base curve is filtered; Feel's transients (landing boost, collision
    // pinch, near-miss pulse) are added raw. A 90 ms pulse pushed through a
    // 5 Hz low-pass is a pulse nobody ever sees.
    this.fov += (this._fovTarget - this.fov) * Math.min(1, dt * CH.fovRate);
    const want = clamp(this.fov + this.fovOffset, 30, 110);
    if (Math.abs(this.cam.fov - want) > 0.01) {
      this.cam.fov = want;
      this.cam.updateProjectionMatrix();
    }

    this._first = false;
  }

  /* ------------------------------------------------------------
     Auto-centre: an idle timer, then a ramp, so the view is never dragged
     back while the player is still looking around. Rate is
     gated on speed so a parked car recentres gently instead of yanking.
     ------------------------------------------------------------ */
  _autoCentre(dt, vHoriz) {
    if (this.autoCentre <= 0) return;
    if (this.lookYaw === 0 && this.lookPitch === 0) return;
    const delay = this.autoCentre === 1 ? 2.6 : 1.0;
    const ramp = clamp((this.lookIdle - delay) / 0.8, 0, 1);
    if (ramp <= 0) return;
    const rate = (this.autoCentre === 1 ? 1.6 : 4.0) * ramp *
      (0.35 + 0.65 * sstep(1, 10, vHoriz));
    const k = 1 - Math.exp(-dt * rate);
    this.lookYaw -= this.lookYaw * k;
    this.lookPitch -= this.lookPitch * k;
    if (Math.abs(this.lookYaw) < 1e-4) this.lookYaw = 0;
    if (Math.abs(this.lookPitch) < 1e-4) this.lookPitch = 0;
  }

  /* ============================================================
     CHASE
     ============================================================ */
  _chase(dt, v, vHoriz) {
    /* ---- headings ------------------------------------------- */
    _fwd.copy(v.forward); _fwd.y = 0;
    const fl = _fwd.lengthSq();
    // A car pitched to vertical has no horizontal nose direction; fall back to
    // the boom's own heading rather than producing a NaN.
    if (fl > 1e-6) _fwd.multiplyScalar(1 / Math.sqrt(fl));
    else _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    _vel.set(v.vel.x, 0, v.vel.z);
    const vFwd = _vel.x * _fwd.x + _vel.z * _fwd.z;
    if (vHoriz > 1e-4) _vel.multiplyScalar(1 / vHoriz); else _vel.copy(_fwd);

    // Signed body slip: where the car is going vs where it is pointing. right =
    // forward × up, so a positive slip means the car is sliding to its right.
    _rgt.crossVectors(_fwd, _WUP);
    const vRgt = v.vel.x * _rgt.x + v.vel.z * _rgt.z;
    const slip = vHoriz > 0.8 ? Math.atan2(vRgt, vFwd) : 0;

    /* ---- boom yaw target -------------------------------------
       Travel heading, not nose heading. Blended back to the nose at low speed
       (where the velocity direction is pure noise) and while reversing (where
       it would swing the camera round to stare at the bonnet). While airborne
       the nose is meaningless — the car may be mid-barrel-roll — so the target
       is frozen onto the velocity heading outright. */
    let travelW = sstep(CH.travelLo, CH.travelHi, vHoriz) * sstep(0, 2.5, vFwd);
    if (this._air > 0) travelW = travelW + (1 - travelW) * this._air * sstep(2, 8, vHoriz);
    _dir.set(
      _fwd.x + (_vel.x - _fwd.x) * travelW, 0,
      _fwd.z + (_vel.z - _fwd.z) * travelW,
    );
    const dl = _dir.lengthSq();
    let yawTarget = dl > 1e-6 ? Math.atan2(_dir.x, _dir.z) : this.yaw;

    /* Bound it to the nose cone (CH.noseCone). This is a clamp on the TARGET,
       not on the boom: the spring downstream is untouched, so the approach to
       the cone edge is the same filtered move as every other heading change
       here and hitting the limit mid-drift reads as the shot settling, not as
       a stop. Clamping the target is also what keeps the limit honest — clamp
       `this.yaw` after the spring and the spring integrates against a wall,
       which is how a camera gets the sticky feel this file spends 700 lines
       avoiding. Low speed needs no special case: travelW is already 0 there,
       so the target IS the nose and the offset is zero. */
    const cone = this.noseCone + (CH.noseConeAir - this.noseCone) * this._air;
    if (cone < Math.PI) {
      const noseYaw = Math.atan2(_fwd.x, _fwd.z);
      const off = wrapPi(yawTarget - noseYaw);
      if (off > cone) yawTarget = wrapPi(noseYaw + cone);
      else if (off < -cone) yawTarget = wrapPi(noseYaw - cone);
    }

    /* …and none of that survives a spin. Nose and travel both sweep the full
       circle in a crash, so while the tumble blend is up the target is the
       heading the boom already had — a hard hold, not a weighted one, because
       any weight at all lets a 5 rad/s spin drag the frame round with it. The
       switch itself costs nothing: _stableYaw was this.yaw on the frame the
       latch closed, so the spring's error is zero going in and the error going
       out is absorbed the way every other heading change in this file is. */
    if (this._tumble > 0) yawTarget = this._stableYaw;

    /* Critically damped, closed form — unconditionally stable at any dt, which
       matters because a tab-out hands us a 50 ms frame.

       On the rate: the brief asked for "~4.5 Hz equivalent". A literal 4.5 Hz
       (ω = 28 rad/s) settles in 0.14 s and erases the lag that makes a corner
       read as a corner; a literal 4.5 rad/s lags 25° at the 2.0 rad/s yaw cap
       and the car walks out of frame. 1.91 Hz (ω = 12) sits between them: ~7°
       of lag in a hard corner, ~9.6° at the yaw cap. Tune with rig.yawHz. */
    const w = TAU * this.yawHz * (this._air > 0 ? 1 - (1 - CH.yawAirMul) * this._air : 1);
    const err = wrapPi(this.yaw - yawTarget);
    const A = this._yawVel + w * err;
    const ex = Math.exp(-w * dt);
    this.yaw = wrapPi(yawTarget + (err + A * dt) * ex);
    this._yawVel = (this._yawVel - w * dt * A) * ex;

    /* ---- boom pitch ------------------------------------------ */
    const aheadD = Math.min(CH.slopeAheadMax, CH.slopeAhead + vHoriz * CH.slopeAheadV);
    const h0 = this.terrain.heightAt(v.pos.x, v.pos.z);
    const h1 = this.terrain.heightAt(v.pos.x + Math.sin(this.yaw) * aheadD,
      v.pos.z + Math.cos(this.yaw) * aheadD);
    const slopeRaw = clamp(Math.atan2(h1 - h0, aheadD), -CH.slopeMax, CH.slopeMax);
    this._slope += (slopeRaw - this._slope) * (1 - Math.exp(-dt * CH.slopeLP));

    const pitchWant = CH.pitch0 + (CH.pitch1 - CH.pitch0) * sstep(CH.pitchLo, CH.pitchHi, vHoriz)
      + CH.slopeW * this._slope;
    this.pitch += (pitchWant - this.pitch) * Math.min(1, dt * CH.pitchRate);
    const pitch = clamp(this.pitch + this.lookPitch, CH.pitchMin, CH.pitchMax);
    const yaw = this.yaw + this.lookYaw;

    /* ---- pivot ----------------------------------------------
       Horizontal is near-rigid; vertical is loose, and looser still in the air.
       That asymmetry IS the jump: the car climbs out of frame on the way up and
       drops back into it on the way down, and after touchdown the vertical rate
       walks back to its ground value over about half a second — which is the
       "no snap on landing" requirement, satisfied by not having a snap to
       suppress in the first place. */
    _piv.set(v.pos.x, v.pos.y + CH.pivotUp, v.pos.z);
    if (this._first) this._pivot.copy(_piv);
    else {
      const kxz = 1 - Math.exp(-dt * CH.pivotXZ);
      const ky = 1 - Math.exp(-dt * (CH.pivotY + (CH.pivotYAir - CH.pivotY) * this._air));
      this._pivot.x += (_piv.x - this._pivot.x) * kxz;
      this._pivot.z += (_piv.z - this._pivot.z) * kxz;
      this._pivot.y += (_piv.y - this._pivot.y) * ky;
    }

    /* ---- aim point -------------------------------------------
       Look-ahead along a blend of the nose and the direction of travel. The
       velocity weight rises with slip, so the aim tracks where the car is
       actually going and the body is left visibly rotated against it. Lateral
       look-ahead from the rack opens the corner up before turn-in. */
    const velW = sstep(CH.slipLo, CH.slipHi, Math.abs(slip));
    // Look-ahead scales with speed ALONG THE AIM, which is the forward component
    // when the car is straight and the full ground speed when it is sideways.
    // Using the forward component alone collapses the look-ahead to nothing at
    // 90° of slip — exactly when the player most needs to see where they will
    // end up.
    const speedAbs = Math.abs(vFwd) * (1 - velW) + vHoriz * velW;
    _dir.set(_fwd.x + (_vel.x - _fwd.x) * velW, 0, _fwd.z + (_vel.z - _fwd.z) * velW);
    const al = _dir.lengthSq();
    if (al > 1e-6) _dir.multiplyScalar(1 / Math.sqrt(al)); else _dir.copy(_fwd);

    const ahead = Math.min(CH.aheadMax, CH.aheadBase + speedAbs * CH.aheadSpeed);
    // Rack position if the vehicle publishes one; filtered lateral acceleration
    // is a serviceable stand-in for anything that does not.
    const steerN = typeof v.steerNorm === 'number' ? v.steerNorm
      : clamp((v._accelLat || 0) / 9, -1, 1);
    const lat = CH.lateral * (steerN * Math.abs(steerN)) * sstep(CH.latLo, CH.latHi, vHoriz);
    _rgt.crossVectors(_dir, _WUP);

    _aim.copy(this._pivot).addScaledVector(_dir, ahead).addScaledVector(_rgt, lat);
    if (this._first) this._aim.copy(_aim);
    else this._aim.lerp(_aim, 1 - Math.exp(-dt * 10));

    /* ---- eye -------------------------------------------------- */
    let dist = this.dist * (1 + CH.distSpeed * sstep(0, CH.speedRef, vHoriz))
      * (1 + (CH.airDist - 1) * this._air);
    /* The tumble pull-back is the only boom term that can stack on top of the
       airborne one, so it is the one that gets a ceiling — distMax, the same
       11 m the zoom clamps to. A boom already past that (deep zoom plus a big
       air) is left exactly where it was rather than being hauled back in. */
    if (this._tumble > 0) {
      dist = Math.min(Math.max(dist, CH.distMax),
        dist * (1 + (CH.tumbleDist - 1) * this._tumble));
    }
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    _eye.set(
      this._pivot.x - Math.sin(yaw) * cp * dist,
      this._pivot.y + sp * dist + CH.lift,
      this._pivot.z - Math.cos(yaw) * cp * dist,
    );

    this._clearGround(dt, this._pivot, _eye, CH.ground);

    this.cam.position.copy(_eye);
    this.cam.up.copy(_WUP);          // horizon locked — chase never rolls
    this.cam.lookAt(this._aim);

    this._fovTarget = CH.fovBase * this.fovScale
      + CH.fovSpeed * sstep(CH.fovLo, CH.fovHi, vHoriz)
      + CH.airFov * this._air;
  }

  /* ============================================================
     HOOD — rigid windshield mount. This one DOES roll with the car: it is the
     driver's head, and a stabilised horizon from inside the cockpit reads as
     the car sliding around underneath a floating camera.
     ============================================================ */
  _hood(dt, v) {
    _eye.set(HD.x, HD.y, HD.z).applyQuaternion(v.quat).add(v.pos);
    const gh = this.terrain.heightAt(_eye.x, _eye.z) + HD.ground;
    if (_eye.y < gh) _eye.y = gh;

    _q1.copy(v.quat).multiply(_qFlip);
    if (this._first) this._hoodQ.copy(_q1);
    else this._hoodQ.slerp(_q1, 1 - Math.exp(-dt * HD.slerp));

    this.cam.position.copy(_eye);
    this.cam.quaternion.copy(this._hoodQ);
    this.cam.rotateX(HD.trim);

    const vHoriz = Math.hypot(v.vel.x, v.vel.z);
    this._fovTarget = HD.fovBase * this.fovScale
      + HD.fovSpeed * sstep(CH.fovLo, CH.fovHi, vHoriz);

    // The pivot has to keep tracking or a switch back to CHASE starts its
    // smoothing from wherever the car was when hood mode began.
    this._pivot.set(v.pos.x, v.pos.y + CH.pivotUp, v.pos.z);
    this._aim.copy(this._pivot).addScaledVector(v.forward, 6);
    this.yaw = headingOf(v);
  }

  /* ============================================================
     ORBIT — results / podium. Slow, cinematic, ignores look except zoom.
     ============================================================ */
  _orbit(dt, v) {
    this._orb += dt * OR.rate;
    const r = OR.r * (this.dist / CH.dist);
    _piv.set(v.pos.x, v.pos.y, v.pos.z);
    if (this._first) this._pivot.copy(_piv);
    else this._pivot.lerp(_piv, 1 - Math.exp(-dt * 3.5));

    _eye.set(
      this._pivot.x + Math.sin(this._orb) * r,
      this._pivot.y + OR.h + Math.sin(this._t * OR.bobRate) * OR.bob,
      this._pivot.z + Math.cos(this._orb) * r,
    );
    _aim.set(this._pivot.x, this._pivot.y + OR.lookUp, this._pivot.z);
    this._aim.copy(_aim);

    this._clearGround(dt, this._pivot, _eye, CH.ground);

    this.cam.position.copy(_eye);
    this.cam.up.copy(_WUP);
    this.cam.lookAt(this._aim);
    this._fovTarget = OR.fov * this.fovScale;
    this.yaw = wrapPi(this._orb + Math.PI);
  }

  /* ------------------------------------------------------------
     Terrain avoidance. Four taps along the boom (the eye itself is the last
     one, which is also the "crest behind the car" case). A breach at parameter
     t only needs (need / t) of lift at the eye end, so the worst ratio wins —
     that keeps the correction as small as the geometry allows instead of
     hoisting the whole boom for a pebble halfway down it.

     Rise is fast and fall is slow on purpose: being inside a hill for one frame
     is a hole in the world, while dropping back a little late costs nothing.
     No prop avoidance — a rock big enough to matter is already terrain, and
     ray-testing the prop set every frame is not worth the milliseconds.
     ------------------------------------------------------------ */
  _clearGround(dt, pivot, eye, margin) {
    let lift = 0;
    for (let i = 1; i <= CH.taps; i++) {
      const t = i / CH.taps;
      const x = pivot.x + (eye.x - pivot.x) * t;
      const z = pivot.z + (eye.z - pivot.z) * t;
      const y = pivot.y + (eye.y - pivot.y) * t;
      const need = this.terrain.heightAt(x, z) + margin - y;
      if (need > 0) { const l = need / t; if (l > lift) lift = l; }
    }
    if (this._first) this._avoid = lift;
    else {
      const rate = lift > this._avoid ? CH.groundUp : CH.groundDown;
      this._avoid += (lift - this._avoid) * (1 - Math.exp(-dt * rate));
    }
    eye.y += this._avoid;
  }

  /* ------------------------------------------------------------
     Shake, applied AFTER the pose is final. Rotational
     offsets only for the impulse channel — translating the eye is how a shake
     ends up inside a wall. The continuous channel adds a capped few centimetres
     of camera-local translation, which is small enough that the 0.55 m ground
     margin swallows it whole.
     ------------------------------------------------------------ */
  _applyShake(dt) {
    this.shake = Math.max(0, this.shake - dt * SHAKE_DECAY);
    this._rumbleS += (this.rumble - this._rumbleS) * (1 - Math.exp(-dt * 8));

    const t = this._t;
    // Impulse energy falls off as the square so a big hit is loud and the tail
    // is short; a linear decay leaves a long mushy wobble.
    let rot = this.shake * this.shake * 0.075 + this._rumbleS * RS.rumRot;
    if (rot > ROT_CAP) rot = ROT_CAP;

    let ry = 0, rx = 0;
    if (rot > 1e-5) {
      ry = (Math.sin(t * RS.rotA) + 0.6 * Math.sin(t * RS.rotB)) * rot * 0.625;
      rx = (Math.cos(t * RS.rotC) + 0.6 * Math.cos(t * RS.rotD)) * rot * 0.5;
    }
    ry += this.kickYaw;
    rx += this.kickPitch;
    // The yaw component goes about WORLD up, not the camera's own Y. About the
    // local axis it bleeds roll = ry·sin(pitch) into the frame, which is small
    // but it is exactly the horizon wobble rule 2 exists to prevent. HOOD is the
    // exception: it is a head, and a head shakes in its own frame.
    if (ry !== 0) {
      if (this.mode === CAM.HOOD) this.cam.rotateY(ry);
      else this.cam.rotateOnWorldAxis(_WUP, ry);
    }
    if (rx !== 0) this.cam.rotateX(rx);

    let px = 0, py = 0;
    if (this._rumbleS > 1e-4) {
      const a = this._rumbleS * RS.rumPos;
      px = Math.sin(t * RS.posA) * a;
      py = Math.cos(t * RS.posB) * a * 0.8;
    }
    if (this.sway > 1e-4) {
      // Low-frequency lateral sway from the slip channel. Positional, never
      // roll: the chassis already leans (vehicle.js does it on the chassis
      // child) and stacking a camera roll on top double-counts the same cue.
      px += Math.sin(t * 3.1) * this.sway * 0.045;
    }
    const pm = Math.hypot(px, py);
    if (pm > POS_CAP) { const k = POS_CAP / pm; px *= k; py *= k; }
    if (px !== 0 || py !== 0) {
      _sx.set(1, 0, 0).applyQuaternion(this.cam.quaternion);
      _sy.set(0, 1, 0).applyQuaternion(this.cam.quaternion);
      this.cam.position.addScaledVector(_sx, px).addScaledVector(_sy, py);
    }
  }
}

/* ------------------------------------------------------------ helpers */
function headingOf(v) {
  _fwd.copy(v.forward);
  const l = Math.hypot(_fwd.x, _fwd.z);
  return l > 1e-5 ? Math.atan2(_fwd.x, _fwd.z) : 0;
}
function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/* ------------------------------------------------------------ scratch */
const _WUP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const _fwd = /*@__PURE__*/ new THREE.Vector3();
const _vel = /*@__PURE__*/ new THREE.Vector3();
const _rgt = /*@__PURE__*/ new THREE.Vector3();
const _dir = /*@__PURE__*/ new THREE.Vector3();
const _piv = /*@__PURE__*/ new THREE.Vector3();
const _aim = /*@__PURE__*/ new THREE.Vector3();
const _eye = /*@__PURE__*/ new THREE.Vector3();
const _sx = /*@__PURE__*/ new THREE.Vector3();
const _sy = /*@__PURE__*/ new THREE.Vector3();
const _q1 = /*@__PURE__*/ new THREE.Quaternion();
/* Vehicle forward is +Z; a camera looks down −Z. This is the difference. */
const _qFlip = /*@__PURE__*/ new THREE.Quaternion().setFromAxisAngle(_WUP, Math.PI);

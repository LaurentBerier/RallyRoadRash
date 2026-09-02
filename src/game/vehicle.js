/* ============================================================
   RALLY ROAD RASH — 4-wheel rigid-body vehicle
   ------------------------------------------------------------
   A proper rigid body (quaternion + body-frame inertia tensor) with a raycast
   wheel at each corner: spring/damper suspension along the chassis's own down
   axis, slip-based tyre forces inside a friction circle, and a semi-implicit
   wheel-spin solver because the wheel inertia is small and the slip stiffness
   is large — an explicit step on that pair oscillates and then explodes.

   The solver is aimed squarely at Earth arcade:
     • gravity comes from config.G (12.8, heavy on purpose — see config.js)
     • springs sized from mass to a target ride frequency, not hand-picked
     • grip is per-wheel and comes from the surface map under that wheel
     • the driver aids (TC, ABS, stability, anti-roll, countersteer) are
       always on, because they ARE the handling model, not a difficulty option
     • airborne is a first-class state with its own control authority

   Everything that decides feel lives in config.js and vehicles.js. If you find
   yourself wanting to change a literal in this file, it probably wants to be
   a tuning value instead.

   Conventions (from ARCHITECTURE.md): metres, seconds, radians. Y is up.
   Vehicle-local forward is +Z, right is −X. Positive ctl.steer turns RIGHT.
   ============================================================ */
import * as THREE from 'three';
import { clamp, sstep, lerp } from '../core/rng.js';
import { SURFACES, SURF } from '../world/surfaces.js';
import { G, TUNE } from './config.js';
import { makeDrift, driftStep, driftReset, driftFire } from './miniturbo.js';
import { makeTrick, trickReset, trickStep } from './tricks.js';
import {
  buildVehicleVisuals, updateVehicleVisuals, disposeVehicleVisuals,
} from './vehicle-art.js';

const ZERO_CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };

/* ============================================================
   Vehicle
   ============================================================ */
export class Vehicle {
  /**
   * @param {THREE.Scene|null} scene  null (or opts.headless) skips all visuals
   * @param {object} terrain          heightAt / normalAt / surfaceAt / onRoad
   * @param {object} spec             one of VEHICLES
   * @param {object} opts             { livery:int, headless:bool }
   */
  constructor(scene, terrain, spec, opts = {}) {
    this.spec = spec;
    this.terrain = terrain;
    this.headless = !!opts.headless || !scene;
    this.livery = opts.livery | 0;

    /* ---- rigid body ---- */
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.omega = new THREE.Vector3();
    this.mass = spec.mass;

    const { L, W, H } = spec.dims;
    const I = TUNE.sim.inertia;
    // Box inertia from the bounding box, then scaled: a car's mass sits low and
    // central, so the raw tensor is too lazy — particularly in yaw, where
    // cutting it is the cheapest turn-in you will ever buy.
    this.Ibody = new THREE.Vector3(
      spec.mass / 12 * (H * H + L * L) * I.pitch,
      spec.mass / 12 * (W * W + L * L) * I.yaw,
      spec.mass / 12 * (W * W + H * H) * I.roll,
    );
    this.Imean = (this.Ibody.x + this.Ibody.y + this.Ibody.z) / 3;

    /* ---- derived chassis numbers ----
       sag is where the suspension settles under its own weight. Because
       k = m_corner·ω², sag = G/ω² and is mass-independent: it is purely a
       statement about the ride frequency, which is why vehicles.js tunes the
       frequency and lets the spring rate fall out. */
    this.cornerLoad = spec.mass * G / 4;
    this.sag = this.cornerLoad / spec.suspK;
    this.rideHz = Math.sqrt(spec.suspK / (spec.mass / 4)) / (2 * Math.PI);
    this.rideZeta = spec.suspC / (2 * Math.sqrt(spec.suspK * spec.mass / 4));
    this.maxSpringForce = TUNE.susp.maxForceG * this.cornerLoad;
    this.bumpStopK = spec.suspK * TUNE.susp.bumpStopMul;
    this.arbK = spec.suspK * 0.30 * spec.antiRollBonus;
    this.wheelbase = spec.wheelbase.front - spec.wheelbase.rear;

    /* The strut mount height that puts the contact patch exactly comHeight
       below the centre of mass at static sag. comHeight IS the roll lever —
       see vehicles.js. Everything else about ride height follows from it. */
    this.mountY = spec.wheelR + spec.suspRest - this.sag - spec.comHeight;

    // Rotational inertia of one wheel+hub. Scaled off the Hopper's 0.42 m /
    // 1120 kg reference so a bigger, heavier car gets heavier wheels.
    this.wheelI = 2.4 * (spec.wheelR / 0.42) ** 2 * (spec.mass / 1120);

    // Aero: one honest v² term. Its day job is coast-down feel; its night job
    // is giving the drive fade something to converge against at top speed.
    const A = W * H * TUNE.aero.frontalFrac;
    this.aeroC = 0.5 * TUNE.aero.rho * (TUNE.aero.cd[spec.bodyStyle] ?? 0.45) * A;

    /* ---- collision sphere set ---- */
    const cs = TUNE.collide.sphereSet[spec.bodyStyle] ?? TUNE.collide.sphereSet.buggy;
    this.sphR = cs.radius * W * 0.5;
    this.sphD = cs.spread * Math.max(0.05, L * 0.5 - this.sphR);
    this.sphY = -spec.comHeight + H * 0.5;
    this.collRadius = this.sphD + this.sphR;
    // props.resolve() reads `collideR` — same number, published under the name
    // the props contract uses so a Vehicle collides correctly outside race.js.
    this.collideR = this.collRadius;

    /* ---- wheels ---- */
    this.wheels = [];
    for (const front of [true, false]) {
      for (const side of [-1, 1]) {
        this.wheels.push({
          mount: new THREE.Vector3(side * spec.track, this.mountY,
            front ? spec.wheelbase.front : spec.wheelbase.rear),
          side, front,
          steer: 0,                  // geometric rotation about +Y (negative = turning right)
          spin: 0, spinVel: 0,
          comp: this.sag, compVel: 0,
          contact: false,
          normal: new THREE.Vector3(0, 1, 0),
          worldPos: new THREE.Vector3(),
          load: 0, slipLong: 0, slipLat: 0,
          surface: SURF.DIRT, grip: 1, drag: 0.012, sink: 0,
          obj: null, hub: null, arm: null, coil: null,
          armRoot: new THREE.Vector3(), coilRoot: new THREE.Vector3(),
        });
      }
    }
    this.driveWheels = 4;

    /* ---- controller / exposed state ---- */
    this.steerNorm = 0;              // −1..1 rack position (right positive)
    this.steerAngle = 0;             // rad, rack × current lock
    this.rearGripMul = 1;            // handbrake grip cut, recovers over time
    this.airborne = false; this.airTime = 0;
    this.contacts = 0;
    this.flipTimer = 0;
    this.hardHit = 0;                // peak impact m/s THIS frame — reset by step()
    this.lastImpact = 0;
    /* Set by race.js for TUNE.reset.ghostTime after a respawn. resolveVehiclePair
       honours it, so the reset system does not have to special-case its pair
       loop — a ghosted car simply cannot be hit or hit anything. */
    this.ghost = false;
    this.surfaceId = SURF.DIRT;
    this.onRoad = 1;
    this.slipLat = 0; this.slipLong = 0;
    this.rpmNorm = TUNE.drive.rpmIdle;
    this.rpm = spec.revRange[0];
    this.gear = 0;
    this.odo = 0;
    this.motorLoad = 0;
    this._rpmRaw = TUNE.drive.rpmIdle;
    this._blip = 0;
    this._ctlBrake = 0; this._ctlThr = 0; this._ctlHand = 0;
    this._accelLong = 0; this._accelLat = 0;

    /* ---- drive multipliers ----
       ONE WRITER EACH, and step() is the only place they are composed.
       `_drift` belongs to miniturbo.js; `ext*` belong to whatever race-side
       system is applying an item, and that system recomputes them from
       scratch every frame so effects can never accumulate. Anything that
       wants to make a car faster or slower goes through these two numbers —
       there is no addForce on this class and adding one would bypass the
       friction circle, the traction control and the fade curve all at once. */
    this._drift = makeDrift();
    this.extDriveMul = 1;      // external × motorForce
    this.extTopMul = 1;        // external × topSpeed (fade denominator)
    this.driveMul = 1;         // composed: _drift.mul * extDriveMul
    this.driveTopMul = 1;      // composed: _drift.top * extTopMul
    this.bodySlip = 0;         // rad, signed — published for the drift charge
    this.groundSpeed = 0;      // m/s of true horizontal speed, not the forward part
    this.spinT = 0;            // s of forced spin-out remaining
    this._leanRoll = 0; this._leanPitch = 0; this._bikeLean = 0;
    this._lastSpeed = 0;

    /* ---- air / tricks (wave 6) ----
       `_trick` belongs to tricks.js exactly the way `_drift` belongs to
       miniturbo.js: this class publishes the three facts a trick is scored
       from and hands the resulting tier straight to driftFire, and knows
       nothing else about scoring. */
    this._trick = makeTrick();
    this.landEdge = false;     // ONE frame, on a real touchdown (see TUNE.trick.minAir)
    this.landQ = 0;            // 0..1 quality of that landing — flat AND soft
    this.airPeak = 0;          // m of peak height over the launch point, this flight
    /* Which TUNE.air.assistScale entry the landing assist uses — the
       `trickAssist` setting (0 PRO / 1 default / 2 ARCADE). race.js writes it
       on the player; the AI and every harness leave it at the default. */
    this.trickAssist = 1;
    this._launchY = 0;         // world y at the moment the wheels left
    this._airVy = 0;           // vel.y on the last airborne substep — the touchdown speed
    this._airLast = 0;         // airTime on that same substep, for the landEdge debounce

    /* ---- visuals ---- */
    this.root = null; this.chassis = null; this.wheelRoot = null;
    this.mats = null; this.tex = null; this.geos = null;
    if (!this.headless) buildVehicleVisuals(this, scene, spec);
  }

  /* ============================================================
     BASIC STATE
     ============================================================ */
  get forward() { return _gf.set(0, 0, 1).applyQuaternion(this.quat); }
  /* Right-handed, Y up, forward +Z ⇒ right is MINUS X. Getting this backwards
     is what makes the steering answer the wrong key. */
  get right() { return _gr.set(-1, 0, 0).applyQuaternion(this.quat); }
  get up() { return _gu.set(0, 1, 0).applyQuaternion(this.quat); }
  get speed() { return this.vel.dot(this.forward); }
  get speedKmh() { return this.vel.dot(this.forward) * 3.6; }
  get flipped() { return this.flipTimer > TUNE.sim.flipHold; }

  /** World-space centre of collision sphere i (0 = nose, 1 = mid, 2 = tail). */
  sphereCentre(i, out) {
    return out.set(0, this.sphY, i === 0 ? this.sphD : i === 2 ? -this.sphD : 0)
      .applyQuaternion(this.quat).add(this.pos);
  }

  /** Drop the car onto the ground at (x,z) facing `yaw`, all motion zeroed. */
  placeAt(x, z, yaw = 0) {
    const S = this.spec;
    const h = this.terrain.heightAt(x, z);
    this.terrain.normalAt(x, z, 0.8, _n1);
    // Yaw first, then tip the whole thing onto the local ground plane, so a
    // grid slot on a cambered road spawns flat against it instead of digging in.
    _q1.setFromAxisAngle(_wup, yaw);
    _q2.setFromUnitVectors(_wup, _n1);
    this.quat.copy(_q2).multiply(_q1).normalize();
    this.pos.set(x, h + S.comHeight / Math.max(0.5, _n1.y) + 0.02, z);
    this.vel.set(0, 0, 0); this.omega.set(0, 0, 0);

    for (const w of this.wheels) {
      w.comp = this.sag; w.compVel = 0; w.spinVel = 0; w.spin = 0;
      w.contact = true; w.load = this.cornerLoad;
      w.slipLat = 0; w.slipLong = 0; w.steer = 0;
      w.normal.copy(_n1);
      w.worldPos.copy(this.pos).addScaledVector(_n1, -(S.comHeight - S.wheelR));
    }
    this.steerNorm = 0; this.steerAngle = 0; this.rearGripMul = 1;
    this.airborne = false; this.airTime = 0; this.flipTimer = 0;
    this.hardHit = 0; this.lastImpact = 0; this.contacts = 4;
    this.slipLat = 0; this.slipLong = 0; this.motorLoad = 0;
    this.gear = 0; this._blip = 0;
    this._rpmRaw = TUNE.drive.rpmIdle; this.rpmNorm = TUNE.drive.rpmIdle;
    this._accelLong = 0; this._accelLat = 0; this._lastSpeed = 0;
    this._leanRoll = 0; this._leanPitch = 0; this._bikeLean = 0;
    this._ctlBrake = 0; this._ctlThr = 0; this._ctlHand = 0;
    this.bodySlip = 0; this.groundSpeed = 0; this.spinT = 0;
    this.extDriveMul = 1; this.extTopMul = 1;
    this.driveMul = 1; this.driveTopMul = 1;
    driftReset(this._drift);
    /* The FLIGHT is wiped, the score is not: a respawn must not bank the
       tumble that caused it, and must not cost you the points you already
       earned. trickClear() (race.js, at the grid) is the one that takes
       those. */
    this.landEdge = false; this.landQ = 0; this.airPeak = 0;
    this._launchY = this.pos.y; this._airVy = 0; this._airLast = 0;
    trickReset(this._trick);

    // One tiny zero-input substep so wheel world positions, normals and surface
    // ids are valid before anything reads them (first visual frame, AI, HUD).
    this._substep(1e-4, ZERO_CTL, true);
    this.vel.set(0, 0, 0); this.omega.set(0, 0, 0);
    this.hardHit = 0; this.flipTimer = 0;
    this.sync();
  }

  sync() {
    if (!this.root) return;
    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);
  }

  /* ============================================================
     PHYSICS
     ============================================================ */
  step(dt, ctl) {
    const c = ctl || ZERO_CTL;
    _ctl.throttle = clamp(c.throttle || 0, -1, 1);
    _ctl.steer = clamp(c.steer || 0, -1, 1);
    _ctl.brake = clamp(c.brake || 0, 0, 1);
    _ctl.handbrake = c.handbrake ? 1 : 0;
    /* `|| 0` rather than a required field: every ctl in the game is supposed
       to carry `roll` (ARCHITECTURE.md §6.4 lists the copy sites), but a dev
       harness or an older caller that does not must fly straight, not NaN. */
    _ctl.roll = clamp(c.roll || 0, -1, 1);
    /* ---- a spin-out IS a handbrake slide you did not ask for ----
       Routing it through ctl means rearGripMul, the ABS-bypassed rear brake,
       the stability cut and the spinGuard walk-back all fire unmodified. That
       path is already tuned so a handbrake slide is catchable and never
       becomes a pirouette; a hand-rolled spin force would have to re-earn all
       of it. Deferred while airborne on purpose: throttle is the ONLY pitch
       authority in the air, and being hit at the apex of the Caldera Leap
       must not make the landing unrecoverable. The clock starts on touchdown. */
    if (this.spinT > 0 && !this.airborne) {
      this.spinT -= dt;
      if (this.spinT < 0) this.spinT = 0;
      _ctl.handbrake = 1; _ctl.throttle = 0; _ctl.steer = 0; _ctl.roll = 0;
    }
    // Captured AFTER the spin override, or the brake lights and the audio
    // would report the input the player gave rather than the one that ran.
    this._ctlThr = _ctl.throttle; this._ctlBrake = _ctl.brake; this._ctlHand = _ctl.handbrake;

    /* Charge/burn the mini-turbo once per frame, not per substep: `charge` is
       measured in seconds of drift and stepping it six times would run its
       clock at 6x. */
    const fdt = Math.min(dt, TUNE.sim.dtCap);
    driftStep(this._drift, fdt, this, _ctl);

    /* Tricks, immediately after the drift and for the same reason: `air` is
       measured in seconds and running its clock six times a frame would make
       every jump six times longer.

       It reads LAST frame's `landEdge` — the edge is published at the bottom
       of this method, after the substeps that actually put the wheels back
       down, so a classification here is a classification of a landing whose
       `landQ` has already been measured. Same one-frame lag boost-check
       documents for `airborne`, and load-bearing rather than sloppy. */
    trickStep(this._trick, fdt, this, _ctl);
    /* A trick pays a mini-turbo — the drift and the jump feed the same pot,
       so the air needs no boost economy of its own. driftFire takes the
       better of the two, never the sum, exactly like a chained drift. */
    if (this._trick.fired) driftFire(this._drift, this._trick.fired);

    this.driveMul = this._drift.mul * this.extDriveMul;
    this.driveTopMul = this._drift.top * this.extTopMul;

    // hardHit is a per-frame peak: whoever consumes it (feel/audio/damage)
    // reads it after step() and after resolveVehiclePair().
    this.hardHit = 0;
    this.landEdge = false;
    const wasAir = this.airborne;

    const SUB = TUNE.sim.substeps;
    const h = fdt / SUB;
    for (let s = 0; s < SUB; s++) this._substep(h, _ctl, s === 0);

    /* ---- the landing edge ----
       One frame, on a REAL touchdown. `_airLast` is the airTime on the last
       substep that was actually off the ground, so the whole thing is gated
       on TUNE.trick.minAir: without that, a whoops section fires a landing
       event every third frame and the HUD strobes.

       `landQ` asks the two questions that decide whether a landing hurt:
       did you come down flat (up · groundNormal) and did you come down
       softly (the descent speed fade). It is the number tricks.js pays on. */
    if (wasAir && !this.airborne && this._airLast > TUNE.trick.minAir) {
      this.landEdge = true;
      this.terrain.normalAt(this.pos.x, this.pos.z, 1.0, _n2);
      const up = _up.set(0, 1, 0).applyQuaternion(this.quat);
      const fwd = _fw.set(0, 0, 1).applyQuaternion(this.quat);
      const flat = clamp(up.dot(_n2), 0, 1);
      const sv = TUNE.trick.softV;
      this.landQ = flat * (1 - sstep(sv[0], sv[1], -this._airVy));

      /* ---- the crash ----
         Landing on the roof, or nose-first into the face of something, at a
         speed where it matters. Routed through spinT because that is the
         handbrake-recovery path race.js, miniturbo and the camera are all
         already tuned around — a bespoke "crashed" state would have to
         re-earn every one of them. hardHit gets a floor so feel.js shakes
         and audio bangs even when the suspension found a soft way down. */
      const K = TUNE.trick;
      if ((flat < K.crashUp || fwd.dot(_n2) < K.crashNose) &&
          this.groundSpeed > K.crashSpeed) {
        this.spinT = Math.max(this.spinT, K.crashSpin);
        this.hardHit = Math.max(this.hardHit, K.crashHit);
      }
    }

    // Road mask under the body, once per frame. Physics does not use it (the
    // surface map already says ROAD where it matters); it is here so AI, dust
    // and the HUD have one agreed answer to "am I on the road".
    if (this.terrain.onRoad) this.onRoad = this.terrain.onRoad(this.pos.x, this.pos.z);

    // frame-rate-independent filtered accelerations, for camera/feel/body lean
    const sp = this.speed;
    const k = Math.min(1, dt * 9);
    this._accelLong += ((sp - this._lastSpeed) / Math.max(dt, 1e-4) - this._accelLong) * k;
    this._accelLat += (-this.omega.dot(this.up) * sp - this._accelLat) * k;
    this._lastSpeed = sp;

    this._updateRpm(dt);
    this.sync();
  }

  _substep(dt, ctl, resample) {
    const S = this.spec, T = TUNE;
    const q = this.quat;
    const up = _up.set(0, 1, 0).applyQuaternion(q);
    const fwd = _fw.set(0, 0, 1).applyQuaternion(q);
    const rgt = _rt.set(-1, 0, 0).applyQuaternion(q);

    const vFwd = this.vel.dot(fwd);
    const vRgt = this.vel.dot(rgt);
    const speedAbs = Math.abs(vFwd);
    /* TWO normalised speeds, and they are not interchangeable.

       `vn` is measured against the BOOSTED top speed, because that is what a
       mini-turbo actually raises: the drive-fade denominator. It also feeds
       the steering taper, which is a happy accident worth keeping — a boost
       that turns the car into a train is the classic failure of this feature,
       and a little extra lock while it burns is the fix, for free.

       `vnRaw` is against the honest top speed and exists for exactly one
       consumer: downforce. dfv squares min(vn, 1.15), so feeding it the
       boosted value would CUT about 8 % of static weight of downforce at
       precisely the moment you are cresting something at 45 m/s. That is a
       handling regression hiding inside a feature. */
    const vnRaw = speedAbs / S.topSpeed;
    const vn = speedAbs / (S.topSpeed * this.driveTopMul);
    const hand = ctl.handbrake;
    /* How fast the car is ACTUALLY travelling, regardless of where it is
       pointing. Anything that asks "is this fast enough to need help" must use
       this and not the forward component — a car at 86° of slip has almost no
       forward speed, and gating the stability controller on it makes the
       controller switch itself off at precisely the moment it is needed. */
    const vHoriz = Math.hypot(this.vel.x, this.vel.z);
    // signed body slip: where the car is going vs where it is pointing
    const bodySlip = vHoriz > 0.5 ? Math.atan2(vRgt, vFwd) : 0;
    const absSlip = Math.abs(bodySlip);

    /* ---- throttle / brake resolution ----
       Pressing "back" while rolling forward is BRAKING, not reverse. Every
       arcade racer does this and every player expects it; without it the
       keyboard S key silently commands a burnout against the direction of
       travel. Reverse only engages once you are nearly stopped. */
    let thr = ctl.throttle, brk = ctl.brake;
    const lb = T.drive.liftBrakeSpeed;
    if (thr < 0 && vFwd > lb) { brk = Math.max(brk, -thr); thr = 0; }
    else if (thr > 0 && vFwd < -lb) { brk = Math.max(brk, thr); thr = 0; }

    /* ---- steering ----
       Lock tapers with speed on a fractional-power curve (bites early, because
       most cornering happens between a third and two thirds of top speed), and
       the rack moves at a speed-invariant rate in lock-fractions per second so
       binary keyboard input still lands somewhere placeable. */
    /* The taper reads FORWARD speed on purpose, not vHoriz: sideways in a
       drift, vFwd drops, the lock opens back up, and there is more rack
       available exactly when you need it to catch the slide. */
    const lock = S.steerLockScale * T.steer.maxLock *
      lerp(1, T.steer.speedTaper, Math.pow(Math.min(1, vn), T.steer.taperShape));

    let target = ctl.steer;
    if (vHoriz > T.steer.assistSpeed && absSlip < 1.2 && T.steer.countersteerAssist > 0) {
      /* Countersteer assist. Body slip positive means the car is travelling to
         the right of where its nose points, i.e. it has yawed left, i.e. you
         want lock to the right. Feeding a fraction of the physically correct
         correction into the rack is what lets a ±1 keyboard axis catch a slide.
         Above 1.2 rad you are a passenger and the assist stops pretending. */
      const over = Math.sign(bodySlip) * Math.max(0, absSlip - T.steer.assistSlip);
      target += clamp(over / lock, -1, 1) * T.steer.countersteerAssist;
      target = clamp(target, -1, 1);
    }
    const toCentre = Math.abs(target) < Math.abs(this.steerNorm) ||
      target * this.steerNorm < 0;
    const rate = (toCentre ? T.steer.returnRate : T.steer.rate) * dt;
    this.steerNorm += clamp(target - this.steerNorm, -rate, rate);
    this.steerAngle = this.steerNorm * lock;

    /* ---- drive force envelope ----
       Full force to the knee, then a smooth fall to `fadeTail` at exactly
       topSpeed, then a narrow band that closes it out completely. The narrow
       band is what makes topSpeed an honest number: as long as fadeTail beats
       drag (vehicles.js guarantees it), terminal velocity lands inside
       topSpeed + 0…1.2 % on any surface. */
    let fade;
    if (vn <= T.drive.fadeKnee) fade = 1;
    else if (vn <= 1) fade = 1 - (1 - T.drive.fadeTail) * sstep(T.drive.fadeKnee, 1, vn);
    else fade = T.drive.fadeTail * (1 - sstep(1, 1 + T.drive.overBand, vn));
    let motor = S.motorForce * this.driveMul;
    if (thr < 0) {                    // reverse: its own, much lower envelope
      motor *= T.drive.reverseForce;
      fade = 1 - sstep(0, T.drive.reverseFrac, vn);
    }

    /* ---- pass 1: geometry, compression, surface ----
       Split from the force pass so the anti-roll bar can see both wheels of an
       axle in the same substep instead of chasing last substep's numbers. */
    let contacts = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      _p1.copy(w.mount).applyQuaternion(q).add(this.pos);            // strut mount, world
      _p2.copy(_p1).addScaledVector(up, -S.suspRest);                // hub at full droop
      const gh = this.terrain.heightAt(_p2.x, _p2.z);
      this.terrain.normalAt(_p2.x, _p2.z, S.wheelR * 0.8, w.normal);

      let comp = gh - (_p2.y - S.wheelR);
      comp = clamp(comp, -T.susp.droop, S.suspTravel + 0.35);
      w.contact = comp > 0;
      if (w.contact) contacts++;
      w.compVel = (comp - w.comp) / dt;
      w.comp = comp;
      w.worldPos.set(_p2.x, w.contact ? gh + S.wheelR : _p2.y, _p2.z);
      // geometric wheel angle: positive ctl.steer must swing the fronts toward
      // −X (the chassis's right), so the rotation about +Y is negated
      w.steer = w.front ? -this.steerAngle : 0;

      /* Surface is resampled once per step(), not once per substep: the wheel
         moves ~11 cm per substep at 40 m/s and the surface map is ~1 m/texel,
         so 5 of every 6 lookups would return the same id anyway. */
      if (resample) {
        const id = this.terrain.surfaceAt(_p2.x, _p2.z) | 0;
        const s = SURFACES[id] || SURFACES[SURF.DIRT];
        w.surface = s.id; w.grip = s.grip; w.drag = s.drag; w.sink = s.sink;
      }
    }
    this.contacts = contacts;
    this.airborne = contacts === 0;

    /* ---- pass 2: suspension + tyres ---- */
    const force = _F.set(0, 0, 0);
    const torque = _T.set(0, 0, 0);
    let loadSum = 0, domLoad = -1, slipLatMax = 0, slipLongMax = 0, latSlipSum = 0;
    this.motorLoad = 0;

    // rear grip recovery from the handbrake, walked rather than snapped so a
    // flick–catch–flick through an S bend does not straighten the car for you
    const wantRear = hand ? T.drift.handbrakeGripRear : 1;
    this.rearGripMul += (wantRear - this.rearGripMul) *
      Math.min(1, dt * (hand ? 40 : T.drift.driftGripRecovery));

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) {
        w.load = 0; w.slipLat = 0; w.slipLong = 0;
        // a free wheel bleeds off slowly — it still has to look right in the air
        w.spinVel -= Math.sign(w.spinVel) * Math.min(Math.abs(w.spinVel), 1.4 * dt);
        w.spin += w.spinVel * dt;
        continue;
      }

      /* ---- spring, damper, bump stop, anti-roll bar ---- */
      const partner = this.wheels[i ^ 1];       // 0↔1 and 2↔3 are the same axle
      const over = Math.max(0, w.comp - S.suspTravel);
      const arb = partner.contact ? this.arbK * (w.comp - partner.comp) : 0;
      let fs = S.suspK * w.comp
        + S.suspC * clamp(w.compVel, -T.susp.compVelClamp, T.susp.compVelClamp)
        + this.bumpStopK * over * over
        - arb;
      fs = clamp(fs, 0, this.maxSpringForce);

      _p3.copy(up).multiplyScalar(fs);
      force.add(_p3);
      _p4.copy(w.mount).applyQuaternion(q);                          // mount arm, body→world
      torque.add(_p5.crossVectors(_p4, _p3));
      w.load = fs; loadSum += fs;
      if (fs > domLoad) { domLoad = fs; this.surfaceId = w.surface; }

      // a landing that uses over half the travel at speed is worth telling
      // feel.js and audio about
      if (w.comp > S.suspTravel * T.susp.hitComp && w.compVel > T.susp.hitVel) {
        this.hardHit = Math.max(this.hardHit, w.compVel);
      }

      /* ---- tyre frame: steered, then flattened onto the contact plane ---- */
      _q1.setFromAxisAngle(up, w.steer);
      const wf = _p6.copy(fwd).applyQuaternion(_q1);
      wf.addScaledVector(w.normal, -wf.dot(w.normal));
      if (wf.lengthSq() < 1e-8) wf.copy(fwd); else wf.normalize();
      const wr = _p7.crossVectors(wf, w.normal).normalize();          // points right

      /* Contact patch, NOT the hub. The lever from the centre of mass down to
         the patch is comHeight, and it is what turns tyre force into pitch and
         roll — i.e. into weight transfer. Applying tyre force at the hub
         instead would cancel that lever out entirely. */
      const cp = _p8.copy(_p4).addScaledVector(up, -(S.suspRest - w.comp + S.wheelR));
      const cv = _p9.copy(this.vel).add(_p10.crossVectors(this.omega, cp));
      const vLong = cv.dot(wf), vLat = cv.dot(wr);

      /* ---- friction budget for this corner ---- */
      const base = w.front ? S.gripF : S.gripR * this.rearGripMul;
      const mu = base * w.grip;
      const maxF = mu * fs;

      /* ---- drive torque, with traction control ---- */
      const dshare = (w.front ? S.driveSplit : 1 - S.driveSplit) * 0.5;
      let driveT = thr * motor * fade * dshare * S.wheelR;
      const slipNow = w.spinVel * S.wheelR - vLong;
      if (driveT !== 0) {
        const excess = Math.abs(slipNow) - T.assists.tcSlipCap;
        if (excess > 0 && Math.sign(slipNow) === Math.sign(driveT)) {
          driveT *= Math.max(T.assists.tcFloor, 1 - excess * T.assists.tcAttack);
        }
        this.motorLoad += Math.abs(driveT) / (motor * S.wheelR + 1e-6);
      } else if (Math.abs(thr) < 0.02 && Math.abs(brk) < 0.02) {
        // engine braking on the driven wheels — lift-off should have some bite
        driveT = -Math.sign(w.spinVel) * T.drive.engineBrake * S.motorForce *
          dshare * S.wheelR * Math.min(1, vn * 3);
      }

      /* ---- brake torque, with ABS ---- */
      const bshare = (w.front ? S.brakeBias : 1 - S.brakeBias) * 0.5;
      let brakeCmd = brk * S.brakeForce * bshare;
      const rearHand = hand && !w.front;
      if (rearHand) {
        // the handbrake locks the rear on purpose: no ABS, that is the point
        brakeCmd = Math.max(brakeCmd, T.drift.handbrakeTorque * S.brakeForce * 0.5);
      } else if (brakeCmd > 0 && speedAbs > T.assists.absOffSpeed) {
        const lockSlip = Math.abs(vLong) - Math.abs(w.spinVel * S.wheelR);
        const ex = lockSlip - T.assists.absCap;
        if (ex > 0) brakeCmd *= Math.max(T.assists.absFloor, 1 - ex * T.assists.absAttack);
      }
      const brakeT = brakeCmd * S.wheelR * Math.sign(w.spinVel || vLong || 1e-6);

      /* ---- longitudinal tyre force, solved SEMI-IMPLICITLY ----
         The wheel inertia is small and the slip stiffness is large, so an
         explicit step on this pair rings and then diverges. Solving directly
         for the new spin rate is unconditionally stable at any timestep. */
      const kLong = T.tyre.longStiff * fs;
      const kLat = T.tyre.latStiff * fs;
      const aT = (driveT - brakeT) / this.wheelI;
      const denom = 1 + dt * kLong * S.wheelR * S.wheelR / this.wheelI;
      let spinNew = (w.spinVel + dt * aT + dt * kLong * S.wheelR * vLong / this.wheelI) / denom;
      let slipV = spinNew * S.wheelR - vLong;
      let fx = kLong * slipV;
      // Cap lateral below the full circle so drive and brake always keep a
      // sliver of budget: this is what keeps lift-off oversteer mild.
      const latMax = maxF * T.tyre.latCap;
      let fy = clamp(-vLat * kLat, -latMax, latMax);

      const fmag = Math.hypot(fx, fy);
      if (fmag > maxF) {
        const k = maxF / fmag; fx *= k; fy *= k;
        // the force was capped, so the wheel is free to spin up: re-integrate
        spinNew = w.spinVel + dt * (aT - fx * S.wheelR / this.wheelI);
        slipV = spinNew * S.wheelR - vLong;
      }
      if (brakeCmd > 0 && Math.abs(spinNew) < 0.8) spinNew *= 0.4;
      const spinCap = S.topSpeed / S.wheelR * 1.8;
      w.spinVel = clamp(spinNew, -spinCap, spinCap);
      w.spin += w.spinVel * dt;

      /* ---- rolling resistance + sinkage ----
         SURFACES[].sink is why mud is heavy: it buys a tenth of the car's
         weight in drag, on top of grip already being halved. */
      const rr = (w.drag + w.sink * T.tyre.sinkDrag) * fs;
      const fRoll = -Math.sign(vLong) * Math.min(rr, Math.abs(vLong) * T.tyre.rollDragCap);

      _p11.copy(wf).multiplyScalar(fx + fRoll).addScaledVector(wr, fy);
      force.add(_p11);
      torque.add(_p12.crossVectors(cp, _p11));

      w.slipLong = clamp(Math.abs(slipV) / T.tyre.slipRef, 0, 1);
      w.slipLat = clamp(Math.abs(vLat) / T.tyre.latRef, 0, 1);
      if (w.slipLat > slipLatMax) slipLatMax = w.slipLat;
      if (w.slipLong > slipLongMax) slipLongMax = w.slipLong;
      latSlipSum += w.slipLat;
    }
    this.slipLat = slipLatMax;
    this.slipLong = slipLongMax;
    // Published for miniturbo.js (and anything else that wants to know how
    // sideways the car is) — it was a substep local and died here.
    this.bodySlip = bodySlip;
    // …and the speed the car is ACTUALLY doing, which is not the forward
    // component once it is sideways. miniturbo gates on this.
    this.groundSpeed = vHoriz;

    /* ---- gravity ----
       Full weight on the ground. Once the car has been genuinely airborne for
       a beat (the airTime gate ignores rut blips, same idea as the camera's
       airLo), TUNE.air.hangGravity scales the weight back — the arcade hang
       that turns a kicker into a set piece without touching ground handling.
       Touchdown restores full weight instantly, so landings still thump. */
    let gMul = 1;
    if (contacts === 0) {
      gMul = 1 - (1 - T.air.hangGravity) * sstep(T.air.hangLo, T.air.hangHi, this.airTime);
    }
    force.y -= this.mass * G * gMul;

    if (contacts > 0) {
      this.airTime = 0;

      /* ---- downforce ----
         Along the body's own down axis, so cresting a rise still presses the
         car into the road instead of into the sky. Only while in contact —
         a barrel roll should not get vacuumed back down. */
      const dfv = Math.min(vnRaw, 1.15);
      force.addScaledVector(up, -T.assists.downforce * this.mass * G * dfv * dfv);

      /* ---- anti-roll ----
         Explicit restoring torque about the body's forward axis, on top of the
         physical anti-roll bar already in the spring pass. Rolled right ⇒ the
         right vector dips below the ground plane ⇒ push back to the left. */
      const nAvg = _n1.set(0, 0, 0);
      for (const w of this.wheels) if (w.contact) nAvg.add(w.normal);
      if (nAvg.lengthSq() > 1e-6) nAvg.normalize(); else nAvg.set(0, 1, 0);
      const rollAng = Math.asin(clamp(-rgt.dot(nAvg), -1, 1));
      const rollRate = this.omega.dot(fwd);
      const arScale = this.mass * G * S.track * S.antiRollBonus * (contacts / 4);
      torque.addScaledVector(fwd,
        -(T.assists.antiRoll * rollAng + T.assists.antiRollDamp * rollRate) * arScale);

      /* ---- stability control ----
         Damps the DIFFERENCE between the yaw rate you have and the yaw rate
         your steering angle actually asked for. Blunt yaw damping would fight
         every corner; this only fights the part you did not order, which is
         why 40 m/s hands-off on a straight is dead stable and a deliberate
         drift still rotates. */
      let sGain = T.assists.stabilityYawDamp *
        sstep(T.assists.stabilityLow * S.topSpeed, T.assists.stabilityHigh * S.topSpeed, vHoriz);
      if (hand) {
        // A drift window, not a blanket switch-off: full freedom out to ~30° of
        // slip, then the controller walks back in and refuses the pirouette.
        sGain *= lerp(T.drift.stabilityCut, 1,
          sstep(T.drift.spinGuard[0], T.drift.spinGuard[1], absSlip));
      }
      if (sGain > 0) {
        const muRef = (S.gripF + S.gripR) * 0.5 * (SURFACES[this.surfaceId] || SURFACES[1]).grip;
        const cap = vHoriz > 1 ? muRef * G / vHoriz : 50;
        const yawRef = clamp(-vFwd * Math.tan(this.steerAngle) / this.wheelbase, -cap, cap);
        torque.addScaledVector(up, -this.Ibody.y * sGain * (this.omega.dot(up) - yawRef));
      }

      /* Hard yaw-rate ceiling. Separate from the stability controller and never
         off, because it is not a handling aid — it is the guarantee that the
         camera and the player can follow what the car is doing. Ordinary
         cornering never reaches it. */
      const yr = this.omega.dot(up);
      const overSpin = Math.abs(yr) - T.assists.yawRateCap;
      if (overSpin > 0) {
        torque.addScaledVector(up,
          -Math.sign(yr) * overSpin * T.assists.yawCapGain * this.Ibody.y);
      }

      /* ---- handbrake yaw boost ----
         Fades out once the car is already sideways. Without that fade the boost
         keeps feeding a rotation it started, the stability cut means nothing is
         fighting it, and every handbrake turn ends facing the way you came. */
      if (hand && Math.abs(this.steerNorm) > 0.15) {
        const k = sstep(4, 10, vHoriz) * (1 - sstep(0.75, 1.05, vHoriz / S.topSpeed)) *
          (1 - sstep(T.drift.yawBoostFade[0], T.drift.yawBoostFade[1], absSlip));
        torque.addScaledVector(up,
          -this.steerNorm * T.drift.handbrakeYawBoost * this.Ibody.y * k);
      }

      /* ---- slide recovery ----
         A slide you cannot catch is not a slide, it is a crash. When all four
         are past the peak and the driver is NOT asking for a drift, bleed a
         little of the sideways velocity. Small on purpose: raise it and the
         car feels like it is on rails, drop it and keyboard players spin on
         every corner exit. */
      if (!hand && contacts >= 3) {
        const slide = latSlipSum / contacts;
        if (slide > 0.5) {
          force.addScaledVector(rgt,
            -vRgt * T.assists.slideRecovery * this.mass * sstep(0.5, 1.0, slide));
        }
      }

      // roll/pitch damping only — yaw belongs to the stability controller
      torque.addScaledVector(fwd, -this.omega.dot(fwd) * 0.8 * this.Ibody.z);
      torque.addScaledVector(rgt, -this.omega.dot(rgt) * 0.8 * this.Ibody.x);

    } else {
      /* ============================================================
         AIRBORNE — free rotation, plus a predictive landing assist
         ------------------------------------------------------------
         Two halves, and they only work together (see the block comment over
         TUNE.air in config.js).

         THE AUTHORITIES are big enough that a flip, a spin and a barrel roll
         all fit inside an ordinary jump, and `spinCap` rather than damping is
         what limits them. Throttle/brake still pitch, with the sign
         unchanged from wave 5, because that is the one air control every
         player already has muscle memory for.

         THE MODIFIER IS THE HANDBRAKE. Held in the air, steer stops yawing
         and starts rolling — so a keyboard with no dedicated roll keys can
         still barrel roll, and a pad has it on the button it already uses
         for drift. Q/E (and the bumpers) are the explicit axis on top.

         THE ASSIST is the reason all of that is safe. It does NOT level the
         car toward the ground underneath it — that ground is 40 m behind
         where the car is going to land. It predicts the touchdown point,
         takes the normal there, and aims the car down its own velocity on
         that surface. And it switches OFF the instant the player holds
         anything: an assist that argues with a deliberate input is what
         makes air control feel like mush, and it is what keeps holding the
         throttle off a lip an actual mistake. Do nothing and you land flat.
         ============================================================ */
      this.airTime += dt;

      if (this.airTime <= dt * 1.5) {      // first substep of this flight
        this._launchY = this.pos.y;
        this.airPeak = 0;
      }
      const rise = this.pos.y - this._launchY;
      if (rise > this.airPeak) this.airPeak = rise;
      // The touchdown numbers, sampled every airborne substep so the last
      // one written is the state the wheels actually arrived with.
      this._airVy = this.vel.y;
      this._airLast = this.airTime;

      const pitchIn = clamp(ctl.throttle - ctl.brake, -1, 1);
      const rollIn = clamp((ctl.roll || 0) + (hand ? this.steerNorm : 0), -1, 1);
      const yawIn = hand ? 0 : this.steerNorm;
      torque.addScaledVector(rgt, T.air.pitchAuthority * pitchIn * this.Ibody.x);
      torque.addScaledVector(up, -yawIn * T.air.yawAuthority * this.Ibody.y);
      torque.addScaledVector(fwd, rollIn * T.air.rollAuthority * this.Ibody.z);

      /* Any air input at all suspends BOTH the assist and the damping. The
         deadband is small on purpose: a pad stick resting at 0.02 must not
         quietly switch the landing help off for the whole flight. */
      const inputHeld = Math.abs(pitchIn) > 0.05 || Math.abs(rollIn) > 0.05 ||
        Math.abs(yawIn) > 0.05;

      if (!inputHeld) {
        const scale = T.air.assistScale[this.trickAssist | 0] ?? 1;
        const aw = T.air.assistWindow;
        const tG = this._timeToGround(gMul * G);
        const gain = T.air.alignAssist * (1 - sstep(aw[0], aw[1], tG)) * scale;
        if (gain > 1e-4) this._landAssist(torque, gain, tG, fwd);
        torque.addScaledVector(this.omega, -T.air.damp * this.Imean);
      }
    }

    /* ---- aero drag: always, contact or not ---- */
    const spd = this.vel.length();
    if (spd > 0.05) force.addScaledVector(this.vel, -this.aeroC * spd);

    /* ---- integrate linear ---- */
    this.vel.addScaledVector(force, dt / this.mass);
    // never let a braked car creep down a slope
    if (brk > 0.7 && contacts >= 3 && this.vel.lengthSq() < 0.06) this.vel.multiplyScalar(0.5);
    this.pos.addScaledVector(this.vel, dt);

    /* ---- integrate angular in the body frame: ω̇ = I⁻¹(τ − ω × Iω) ---- */
    _q2.copy(q).invert();
    const tb = _p1.copy(torque).applyQuaternion(_q2);
    const wb = _p2.copy(this.omega).applyQuaternion(_q2);
    _p3.set(wb.x * this.Ibody.x, wb.y * this.Ibody.y, wb.z * this.Ibody.z);
    _p4.crossVectors(wb, _p3);
    wb.x += dt * (tb.x - _p4.x) / this.Ibody.x;
    wb.y += dt * (tb.y - _p4.y) / this.Ibody.y;
    wb.z += dt * (tb.z - _p4.z) / this.Ibody.z;
    this.omega.copy(wb).applyQuaternion(q);
    let wlen = this.omega.length();
    if (this.airborne && wlen > T.air.spinCap) {
      this.omega.multiplyScalar(T.air.spinCap / wlen); wlen = T.air.spinCap;
    }
    if (wlen > 1e-6) {
      _q1.setFromAxisAngle(_p5.copy(this.omega).divideScalar(wlen), wlen * dt);
      this.quat.premultiply(_q1).normalize();
    }

    /* ---- hard floor failsafe ----
       A tunnelling guard, not a bump stop: it sits below the lowest legitimate
       centre-of-mass height (full bump, minus a margin). If this fires during
       ordinary driving then suspTravel and comHeight disagree — fix the spec,
       do not raise the floor. */
    const bh = this.terrain.heightAt(this.pos.x, this.pos.z);
    const minY = bh + Math.max(0.05, S.comHeight - S.suspTravel - T.sim.floorMargin);
    if (this.pos.y < minY) {
      this.pos.y = minY;
      if (this.vel.y < 0) {
        this.hardHit = Math.max(this.hardHit, -this.vel.y);
        this.vel.y *= -T.sim.floorBounce;
      }
      this.vel.x *= 0.94; this.vel.z *= 0.94;
    }

    /* ---- flip watchdog ---- */
    if (up.y < T.sim.flipUp) this.flipTimer += dt; else this.flipTimer = 0;
    this.odo += Math.abs(vFwd) * dt;
  }

  /* ============================================================
     WHERE, AND WHEN, THIS FLIGHT ENDS
     ------------------------------------------------------------
     Time to ground, by Newton on

         f(t) = y + vy·t − ½·g·t² − heightAt(x + vx·t, z + vz·t)

     seeded with the closed-form answer against the ground directly below.
     The seed matters more than the iterations: it is already exact over flat
     ground, which is most of every track, so the three refinements are only
     ever correcting for the fact that the car is going to land somewhere
     ELSE — down a drop, up the far side of a gap, into the next roller.

     The derivative drops the terrain-slope term (dh/dt). That term is
     genuinely second-order at the gradients a driveable track carries, and
     carrying it would cost two more heightAt lookups per iteration in the
     hottest loop in the game to move the answer by a few milliseconds.

     `g` is the CURRENT gravity, hang-time scaling included — predicting a
     jump against full weight would have the assist believe every landing is
     0.6 s sooner than it is, which is precisely the error that makes an
     assist feel like it is grabbing the wheel.
     ============================================================ */
  _timeToGround(g) {
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
    const vx = this.vel.x, vy = this.vel.y, vz = this.vel.z;
    if (!(g > 1e-6)) return 4;

    const drop = py - this.terrain.heightAt(px, pz);
    const disc = vy * vy + 2 * g * drop;
    let t = disc > 0 ? (vy + Math.sqrt(disc)) / g : 0.05;
    if (!(t > 0)) t = 0.05;

    for (let i = 0; i < TUNE.air.predictSteps; i++) {
      const df = vy - g * t;
      // Only refine on the way DOWN. At the apex f' is zero and Newton throws
      // the estimate into the next county; the seed is the better answer.
      if (df > -1e-3) break;
      const f = py + vy * t - 0.5 * g * t * t -
        this.terrain.heightAt(px + vx * t, pz + vz * t);
      t -= f / df;
      if (!(t > 0.05)) { t = 0.05; break; }
      if (t > 4) { t = 4; break; }
    }
    return t < 0.05 ? 0.05 : t > 4 ? 4 : t;
  }

  /* ============================================================
     THE PREDICTIVE LANDING ASSIST
     ------------------------------------------------------------
     Aim the car at the attitude it wants to ARRIVE in: up along the normal
     at the predicted touchdown point, nose along where the car is actually
     travelling. Both halves matter. Levelling to the ground under the car
     is wrong on any jump that covers ground, and levelling without squaring
     the nose to the velocity leaves you landing flat but sideways, which in
     this handling model is a spin.

     SNAP-THROUGH is the rest of it. Past `snapFrom` of accumulated pitch or
     roll, still turning faster than `snapRate`, the shortest way to level is
     BEHIND you — and an assist that takes it yanks a backflip that is 300°
     round back through 60° it has already paid for. So when the shortest
     correction fights the rotation, we take the long way instead and finish
     what the player started. This is the single thing that makes a big flip
     feel like an opportunity rather than a coin toss.
     ============================================================ */
  _landAssist(torque, gain, tG, fwd) {
    /* Where the wheels are going to be. Same ballistic model the estimate
       came from — this is a lookup at a point, not a second prediction. */
    const lx = this.pos.x + this.vel.x * tG;
    const lz = this.pos.z + this.vel.z * tG;
    this.terrain.normalAt(lx, lz, 1.0, _a1);                       // target up

    /* Target nose: horizontal velocity, flattened onto that surface. Below
       walking pace the velocity direction is noise, so keep the nose where
       it is and only fix the attitude. */
    if (Math.abs(this.vel.x) + Math.abs(this.vel.z) > 1.0) _a2.set(this.vel.x, 0, this.vel.z);
    else _a2.copy(fwd);
    _a2.addScaledVector(_a1, -_a2.dot(_a1));
    if (_a2.lengthSq() < 1e-6) {
      _a2.copy(fwd).addScaledVector(_a1, -fwd.dot(_a1));
      if (_a2.lengthSq() < 1e-6) return;      // nose exactly along the normal: no answer
    }
    _a2.normalize();

    // Local +X is the car's LEFT (right is −X), so x = up × forward.
    _a3.crossVectors(_a1, _a2);
    _m1.makeBasis(_a3, _a1, _a2);
    _q3.setFromRotationMatrix(_m1);

    // World-frame error: qe · qNow = qTarget.
    _q4.copy(_q3).multiply(_q5.copy(this.quat).invert());
    if (_q4.w < 0) { _q4.x = -_q4.x; _q4.y = -_q4.y; _q4.z = -_q4.z; _q4.w = -_q4.w; }
    let s = Math.sqrt(_q4.x * _q4.x + _q4.y * _q4.y + _q4.z * _q4.z);
    if (s < 1e-6) return;                     // already there
    let ang = 2 * Math.atan2(s, _q4.w);       // 0..π — the SHORT way
    _a3.set(_q4.x / s, _q4.y / s, _q4.z / s);

    /* How far into the CURRENT turn, not how far in total — and that modulo
       is the whole safety of this. A flip 66° PAST a full rotation has 7.4
       rad on the clock and is nowhere near "nearly finished": the shortest
       way to level is 66° back, and taking the long way instead would send
       it round another 294° it has no air left for. Only a rotation that is
       genuinely close to closing gets pushed through. */
    const st = this._trick;
    const ap = Math.abs(st.pitch) % (2 * Math.PI);
    const ar = Math.abs(st.roll) % (2 * Math.PI);
    if ((ap > TUNE.air.snapFrom || ar > TUNE.air.snapFrom) &&
        this.omega.length() > TUNE.air.snapRate && _a3.dot(this.omega) < 0) {
      _a3.negate();
      ang = 2 * Math.PI - ang;
    }

    /* Linear in the error out to 1 rad and then flat. sin(error) — the wave-5
       weighting — dies at π, which is exactly the attitude that needs the
       most help, and snap-through can hand this a 5 rad target. */
    torque.addScaledVector(_a3, gain * (ang < 1 ? ang : 1) * this.Imean);
  }

  /* ============================================================
     VIRTUAL GEARBOX  →  rpmNorm  (audio + HUD tacho)
     ------------------------------------------------------------
     There is no gearbox in the physics — drive force is continuous. This is
     purely a narrative layer over road speed, but it is the single loudest
     thing in the game, so it gets to be honest about wheelspin and airtime.
     ============================================================ */
  _updateRpm(dt) {
    const S = this.spec, D = TUNE.drive;
    const thr = Math.abs(this._ctlThr);

    if (this.airborne) {
      // no load: the engine chases the pedal, and falls away when you lift
      const t = thr > 0.05 ? 0.94 : D.rpmIdle + 0.08;
      this._rpmRaw += (t - this._rpmRaw) * Math.min(1, dt * D.airRevSmooth);
    } else {
      // a lit-up axle revs the engine even when the car is going nowhere
      let spin = 0;
      for (const w of this.wheels) spin += Math.abs(w.spinVel);
      spin = spin * 0.25 * S.wheelR;
      const ref = Math.max(Math.abs(this.speed), spin * 0.92);
      const vn = clamp(ref / S.topSpeed, 0, 1.12);

      let g = 0;
      while (g < D.gearBands.length - 1 && vn >= D.gearBands[g]) g++;
      const lo = g === 0 ? 0 : D.gearBands[g - 1];
      const hi = D.gearBands[g];
      const f = clamp((vn - lo) / Math.max(1e-4, hi - lo), 0, 1);
      let t = D.rpmLow + (1 - D.rpmLow) * f;
      if (thr < 0.05 && ref < 0.6) t = D.rpmIdle;
      if (g !== this.gear) { this._blip = D.rpmBlip * (g < this.gear ? 1.7 : 1); this.gear = g; }
      this._rpmRaw += (t - this._rpmRaw) * Math.min(1, dt * D.rpmSmooth);
    }
    this._blip *= Math.max(0, 1 - dt * 4.5);
    this.rpmNorm = clamp(this._rpmRaw + this._blip, 0, 1.05);
    this.rpm = lerp(S.revRange[0], S.revRange[1], this.rpmNorm);
  }

  /* ============================================================
     VISUALS — delegated to vehicle-art.js
     ------------------------------------------------------------
     The Vehicle still OWNS the objects (root, chassis, wheelRoot, leanRoot,
     mats, tex, geos, exhaust and the per-wheel obj/hub/arm/coil); the art
     module builds, drives and frees them. These stay methods because race.js
     and the dev harnesses call them on the instance.
     ============================================================ */
  updateVisuals(dt) { updateVehicleVisuals(this, dt); }

  dispose() { disposeVehicleVisuals(this); }
}

/* ============================================================
   VEHICLE ↔ VEHICLE COLLISION
   ------------------------------------------------------------
   Three spheres down each car's local Z. Deliberately ONE contact per pair
   per call — the deepest — plus a fractional push-out. Six cars funnelling
   into turn one produce fifteen pair calls a frame; resolving nine sphere
   pairs each, with full impulses, is how you get a physics grenade. This
   converges over a handful of frames instead, which nobody can see and
   nothing can explode.
   ============================================================ */
export function resolveVehiclePair(a, b) {
  const C = TUNE.collide;
  if (a.ghost || b.ghost) return 0;          // respawn immunity

  // broad phase
  const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
  const reach = a.collRadius + b.collRadius;
  if (dx * dx + dy * dy + dz * dz > reach * reach) return 0;

  // narrow phase: deepest overlapping sphere pair
  let bestPen = 0, bi = -1, bj = -1;
  for (let i = 0; i < 3; i++) {
    a.sphereCentre(i, _ca);
    for (let j = 0; j < 3; j++) {
      b.sphereCentre(j, _cb);
      const ex = _cb.x - _ca.x, ey = _cb.y - _ca.y, ez = _cb.z - _ca.z;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const pen = a.sphR + b.sphR - d;
      if (pen > bestPen) { bestPen = pen; bi = i; bj = j; }
    }
  }
  if (bi < 0) return 0;

  a.sphereCentre(bi, _ca); b.sphereCentre(bj, _cb);
  _cn.subVectors(_cb, _ca);
  let d = _cn.length();
  if (d < 1e-4) {                     // exactly co-located: shove them apart on XZ
    _cn.set(b.pos.x - a.pos.x, 0, b.pos.z - a.pos.z);
    d = _cn.length();
    if (d < 1e-4) { _cn.set(1, 0, 0); d = 1; }
  }
  _cn.divideScalar(d);
  const pen = a.sphR + b.sphR - d;

  const invA = 1 / a.mass, invB = 1 / b.mass, invSum = invA + invB;

  // positional push-out first, split by mass — the heavy car barely moves
  const push = Math.min(pen * C.pushOut, C.maxPush);
  a.pos.addScaledVector(_cn, -push * invA / invSum);
  b.pos.addScaledVector(_cn, push * invB / invSum);

  // contact point and the relative velocity there (ω × r included, so a
  // glancing blow on the nose knows it is a glancing blow on the nose)
  _cp.copy(_ca).addScaledVector(_cn, a.sphR - pen * 0.5);
  _ra.subVectors(_cp, a.pos); _rb.subVectors(_cp, b.pos);
  _va.copy(a.vel).add(_t1.crossVectors(a.omega, _ra));
  _vb.copy(b.vel).add(_t2.crossVectors(b.omega, _rb));
  _rel.subVectors(_vb, _va);
  const vn = _rel.dot(_cn);
  if (vn >= 0) { a.sync(); b.sync(); return 0; }     // already separating
  const closing = -vn;

  // restitution ramps in with closing speed so a pack leaning on each other
  // through a long corner does not buzz apart
  const e = C.restitution * sstep(0.4, C.restitutionSpeed, closing);
  let j = -(1 + e) * vn / invSum;
  j = Math.min(j, C.maxDeltaV / Math.max(invA, invB));
  a.vel.addScaledVector(_cn, -j * invA);
  b.vel.addScaledVector(_cn, j * invB);

  // tangential friction: this is what makes door-to-door contact scrub speed
  _tan.copy(_rel).addScaledVector(_cn, -vn);
  const tl = _tan.length();
  if (tl > 1e-4) {
    _tan.divideScalar(tl);
    const jt = Math.min(tl / invSum, C.friction * j);
    a.vel.addScaledVector(_tan, jt * invA);
    b.vel.addScaledVector(_tan, -jt * invB);
  }

  /* A touch of yaw from an off-centre hit — the YAW component only. The full
     r × J is physical and turns pack racing into a spinning-top simulator; the
     yaw part alone reads as "he tipped me into a slide", which is what a punt
     is supposed to feel like. */
  const yawA = -j * (_ra.z * _cn.x - _ra.x * _cn.z) / a.Ibody.y * C.spinFactor;
  const yawB = j * (_rb.z * _cn.x - _rb.x * _cn.z) / b.Ibody.y * C.spinFactor;
  a.omega.y = clamp(a.omega.y + yawA, -4, 4);
  b.omega.y = clamp(b.omega.y + yawB, -4, 4);

  a.sync(); b.sync();
  if (closing < C.minSpeed) return 0;
  a.hardHit = Math.max(a.hardHit, closing);
  b.hardHit = Math.max(b.hardHit, closing);
  a.lastImpact = closing; b.lastImpact = closing;
  return closing;
}

/* ============================================================
   scratch — module level, zero allocation in step()/updateVisuals()
   ============================================================ */
const _ctl = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };
const _wup = new THREE.Vector3(0, 1, 0);
const _gf = new THREE.Vector3(), _gr = new THREE.Vector3(), _gu = new THREE.Vector3();
const _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
const _F = new THREE.Vector3(), _T = new THREE.Vector3();
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3();
const _p4 = new THREE.Vector3(), _p5 = new THREE.Vector3(), _p6 = new THREE.Vector3();
const _p7 = new THREE.Vector3(), _p8 = new THREE.Vector3(), _p9 = new THREE.Vector3();
const _p10 = new THREE.Vector3(), _p11 = new THREE.Vector3(), _p12 = new THREE.Vector3();
const _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
/* Air-assist scratch, kept separate from the _p and _q sets because
   _landAssist runs INSIDE the airborne branch of _substep, and _p1.._p5 plus
   _q1/_q2 are still needed by the angular integration below it. */
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3(), _a3 = new THREE.Vector3();
const _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
/* collision scratch, kept separate so a resolve() call can never stomp on a
   step() that is mid-flight in some future threaded world */
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _cn = new THREE.Vector3();
const _cp = new THREE.Vector3(), _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _rel = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _tan = new THREE.Vector3();

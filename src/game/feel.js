/* ============================================================
   RALLYE — GAME FEEL
   ------------------------------------------------------------
   One class, one owner for every "juice" transient in the game. race.js gets
   five call sites (landing / collision / jump / nearMiss / reset) plus one
   per-frame update, and nothing else in the codebase is allowed to touch the
   camera shake or the final-pass uniforms. That single-owner rule is not
   tidiness: the failure mode of scattered juice is two systems shaking for the
   same event, which reads as a bug and cannot be tuned out.

   Feel writes into the rig's juice inputs (kickPitch / kickYaw / fovOffset /
   rumble / sway) and owns their envelopes. The rig applies them and does not
   decay them, so "how long does a landing kick last" is one number, here.

   The contrast policy is the important one and it is easy to get backwards:
   the continuous channels (speed shake, slip sway) are killed while airborne.
   A jump only feels big because the frame goes STILL on the way up and then
   everything arrives at once on touchdown. Shaking the whole time flattens it.

   Post-process: uVignette is driven continuously, uExposure dips on landings,
   uFlash pops on heavy ones. engine.final is re-read every frame — the
   composer is rebuilt whenever the quality tier changes, so a cached uniforms
   object silently stops being the one on screen.
   ============================================================ */
import { clamp, sstep } from '../core/rng.js';

const D2R = Math.PI / 180;

const F = {
  /* ---- continuous ---- */
  shakeLo: 18, shakeHi: 40,   // m/s over which the speed shake fades in
  shakeUp: 8, shakeDown: 6,   // 1/s attack / release
  airCalm: 10,                // 1/s — how fast the continuous channels die in the air
  swayRef: 0.9,               // _accelLat as a fraction of G that reads as full sway
  swayMax: 0.75,
  swayRate: 4,                // 1/s

  vigBase: 0.85,              // engine.js daylight default — restore to this, exactly
  vigTop: 1.00,
  vigLo: 0.45,                // fraction of topSpeed where the tunnel starts
  vigRate: 3,                 // 1/s

  /* ---- landing ---- */
  landShake: 0.09,            // per m/s of hardHit
  landShakeMax: 0.9,
  landPitch: 1.2 * D2R,       // rad of nose-down kick at full k
  landDecay: 7.0,             // 1/s ≈ gone in 0.45 s
  landModerate: 3.5,          // m/s — TUNE.susp.hitVel is 3.0; a hit worth an exposure
                              //       dip is a step above "the suspension noticed"
  landHeavy: 7.0,             // m/s — white pop threshold
  expDip: 0.97, expTime: 0.12,
  flashAmt: 0.06,

  /* ---- collision ---- */
  hitShake: 0.07,             // per m/s of impact
  hitShakeMax: 1.1,
  hitKick: 0.022,             // rad of directional kick at full magnitude
  hitDecay: 7.0,              // 1/s
  pinchFov: -2.0, pinchTime: 0.15,

  /* ---- jump ---- */
  jumpPitch: 0.6 * D2R,       // rad of anticipation lift
  jumpIn: 0.10, jumpOut: 0.22,

  /* ---- near miss ---- */
  missFov: 1.5, missTime: 0.09,

  /* ---- fov boost (Feel.kick) ---- */
  kickFovMax: 3.0, kickFovDecay: 6.0,
};

export class Feel {
  constructor(rig, engine) {
    this.rig = rig;
    this.engine = engine || null;

    /** Master scale on everything this class emits. Settings can drive it
        later (a "reduced camera motion" toggle is one line from here). */
    this.intensity = 1;

    this._rumble = 0;
    this._sway = 0;
    this._vig = F.vigBase;

    this._pitch = 0;      // rad, accumulated kick (landing + collision), decaying
    this._yaw = 0;        // rad, ditto
    this._jumpT = -1;     // s, jump anticipation envelope clock
    this._pinchT = 0;     // s remaining on the collision FOV pinch
    this._missT = 0;      // s remaining on the near-miss pulse
    this._expT = 0;       // s remaining on the exposure dip
    this._flash = 0;      // one-frame white pop
    this._fovKick = 0;    // deg, decaying FOV boost
  }

  /* ------------------------------------------------------------
     Continuous. Call once per frame, BEFORE rig.update() — the rig consumes
     what this leaves behind, and a frame of lag on a shake is a frame of lag
     nobody can see but a frame of lag on the FOV pinch eats a third of it.
     ------------------------------------------------------------ */
  update(dt, vehicle) {
    dt = dt > 0 ? (dt < 0.05 ? dt : 0.05) : 1 / 240;
    const rig = this.rig;
    const I = this.intensity;

    if (vehicle) {
      const speed = Math.abs(vehicle.speed || 0);
      const air = !!vehicle.airborne;
      const grounded = (vehicle.contacts | 0) > 0;

      /* ---- speed shake ----
         Grounded only, and gated on contacts rather than on a surface lookup:
         the surface table is a physics concern and the difference between
         gravel and dirt is not worth a texture fetch on the camera's budget. */
      const want = air || !grounded ? 0 : sstep(F.shakeLo, F.shakeHi, speed) * I;
      const rate = air ? F.airCalm : (want > this._rumble ? F.shakeUp : F.shakeDown);
      this._rumble += (want - this._rumble) * (1 - Math.exp(-dt * rate));

      /* ---- slip sway ---- */
      const lat = Math.abs(vehicle._accelLat || 0);
      const swayWant = air || !grounded ? 0
        : Math.min(F.swayMax, lat / (12.8 * F.swayRef)) * I;
      this._sway += (swayWant - this._sway) * (1 - Math.exp(-dt * (air ? F.airCalm : F.swayRate)));

      /* ---- vignette: a subtle tunnel as the speed comes up ---- */
      const top = (vehicle.spec && vehicle.spec.topSpeed) || 38;
      const vigWant = F.vigBase + (F.vigTop - F.vigBase) * sstep(top * F.vigLo, top, speed) * I;
      this._vig += (vigWant - this._vig) * (1 - Math.exp(-dt * F.vigRate));
    } else {
      this._rumble += (0 - this._rumble) * (1 - Math.exp(-dt * F.shakeDown));
      this._sway += (0 - this._sway) * (1 - Math.exp(-dt * F.swayRate));
      this._vig += (F.vigBase - this._vig) * (1 - Math.exp(-dt * F.vigRate));
    }

    /* ---- transient envelopes ---- */
    const kd = 1 - Math.exp(-dt * F.landDecay);
    this._pitch -= this._pitch * kd;
    this._yaw -= this._yaw * (1 - Math.exp(-dt * F.hitDecay));
    if (Math.abs(this._pitch) < 1e-6) this._pitch = 0;
    if (Math.abs(this._yaw) < 1e-6) this._yaw = 0;

    let jump = 0;
    if (this._jumpT >= 0) {
      this._jumpT += dt;
      // Ramp in, then fall away. The lift has to arrive over ~100 ms or it is
      // indistinguishable from a hitch.
      jump = this._jumpT < F.jumpIn
        ? this._jumpT / F.jumpIn
        : 1 - clamp((this._jumpT - F.jumpIn) / F.jumpOut, 0, 1);
      if (this._jumpT > F.jumpIn + F.jumpOut) { this._jumpT = -1; jump = 0; }
    }

    let fov = 0;
    if (this._pinchT > 0) { this._pinchT -= dt; fov += F.pinchFov * clamp(this._pinchT / F.pinchTime, 0, 1); }
    if (this._missT > 0) { this._missT -= dt; fov += F.missFov * clamp(this._missT / F.missTime, 0, 1); }
    this._fovKick -= this._fovKick * (1 - Math.exp(-dt * F.kickFovDecay));
    if (Math.abs(this._fovKick) < 0.01) this._fovKick = 0;
    fov += this._fovKick;

    /* ---- hand it all to the rig ---- */
    rig.setRumble(this._rumble, this._sway);
    rig.kickPitch = this._pitch + F.jumpPitch * jump * I;
    rig.kickYaw = this._yaw;
    rig.fovOffset = fov;

    /* ---- post-process ---- */
    const u = this._uniforms();
    if (u) {
      if (u.uVignette) u.uVignette.value = this._vig;
      if (u.uExposure) {
        let e = 1;
        if (this._expT > 0) {
          this._expT -= dt;
          e = 1 - (1 - F.expDip) * clamp(this._expT / F.expTime, 0, 1);
        }
        u.uExposure.value = e;
      } else if (this._expT > 0) this._expT -= dt;
      // uFlash is a single-frame pop: written once, cleared on the next update.
      if (u.uFlash) { u.uFlash.value = this._flash; }
      this._flash = 0;
    } else {
      if (this._expT > 0) this._expT -= dt;
      this._flash = 0;
    }
  }

  /* ------------------------------------------------------------
     TRIGGERS — race.js call sites
     ------------------------------------------------------------ */

  /** Touchdown. `hardHit` is vehicle.hardHit in m/s of compression velocity,
      read AFTER step() and resolveVehiclePair(). Once per touchdown. */
  landing(hardHit) {
    const h = hardHit > 0 ? hardHit : 0;
    if (h <= 0) return;
    const k = clamp(h * F.landShake, 0, F.landShakeMax);
    this.rig.addShake(k * this.intensity);
    // Down, always: the car has just stopped falling and the mass carries on.
    this._pitch -= F.landPitch * (k / F.landShakeMax) * this.intensity;
    if (h >= F.landModerate) this._expT = F.expTime;
    if (h > F.landHeavy) this._flash = F.flashAmt;
  }

  /** Contact with another car or a barrier. `impact` in m/s of closing speed,
      `worldDir` a world-space direction for the hit (may be null). */
  collision(impact, worldDir) {
    const m = Math.min(Math.abs(impact || 0) * F.hitShake, F.hitShakeMax);
    if (m <= 0.001) return;
    this.rig.addShake(m * this.intensity);
    this._pinchT = F.pinchTime;

    if (worldDir) {
      // Project the hit onto the camera's own axes so the kick throws the view
      // the way the car was thrown. Cheap approximation of a directional shake:
      // one yaw kick and one pitch kick, signed, instead of biased noise.
      const q = this.rig.cam.quaternion;
      const dx = worldDir.x, dy = worldDir.y, dz = worldDir.z;
      const dl = Math.hypot(dx, dy, dz) || 1;
      rotateBasis(q, 1, 0, 0);
      const sx = (dx * _bx + dy * _by + dz * _bz) / dl;
      rotateBasis(q, 0, 1, 0);
      const sy = (dx * _bx + dy * _by + dz * _bz) / dl;
      this._yaw += sx * m * F.hitKick * this.intensity;
      this._pitch += sy * m * F.hitKick * this.intensity;
    }
  }

  /** Lip departure. Tiny upward anticipation — call it as the wheels leave. */
  jump() { this._jumpT = 0; }

  /** Passing something close and fast. Cheap: a 90 ms FOV pulse, nothing else. */
  nearMiss() { this._missT = F.missTime; }

  /** Optional extra FOV punch, ≤3°, decaying. ARCHITECTURE.md names this. */
  kick(deg) {
    const d = clamp(deg || 0, -F.kickFovMax, F.kickFovMax);
    this._fovKick = clamp(this._fovKick + d, -F.kickFovMax, F.kickFovMax);
  }

  /** Straight passthrough so race.js never has to reach past Feel to the rig. */
  addShake(v) { this.rig.addShake((v || 0) * this.intensity); }

  /** Respawn, race start, screen change: everything transient goes to zero and
      the post-process is handed back exactly as engine.js left it. */
  reset() {
    this._rumble = 0; this._sway = 0; this._vig = F.vigBase;
    this._pitch = 0; this._yaw = 0;
    this._jumpT = -1; this._pinchT = 0; this._missT = 0; this._expT = 0;
    this._flash = 0; this._fovKick = 0;
    const rig = this.rig;
    rig.setRumble(0, 0);
    rig.kickPitch = 0; rig.kickYaw = 0; rig.fovOffset = 0;
    rig.shake = 0;
    const u = this._uniforms();
    if (u) {
      if (u.uVignette) u.uVignette.value = F.vigBase;
      if (u.uExposure) u.uExposure.value = 1;
      if (u.uFlash) u.uFlash.value = 0;
    }
  }

  /* Re-resolved every frame: setQuality() rebuilds the composer and hands out a
     brand new ShaderPass, so anything holding the old uniforms is writing to a
     pass that is no longer on screen. */
  _uniforms() {
    const e = this.engine;
    return (e && e.final && e.final.uniforms) || null;
  }
}

/* v' = q·v·q⁻¹ into three module scalars. Keeps the collision path free of
   scratch vectors and keeps feel.js free of a three.js import — it has no other
   reason to pull the library in. Same arithmetic as Vector3.applyQuaternion. */
let _bx = 0, _by = 0, _bz = 0;
function rotateBasis(q, x, y, z) {
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  _bx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  _by = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  _bz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
}

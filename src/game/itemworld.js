/* ============================================================
   THE LIVE ITEM SYSTEM — boxes, projectiles, hazards, effects
   ------------------------------------------------------------
   src/game/items.js is the table and the roulette and is pure. This is the
   half that owns three.js objects, runs every frame and touches the cars.
   Race constructs it, steps it, and disposes it.

   FIVE DECISIONS WORTH KNOWING BEFORE CHANGING ANYTHING HERE
   ----------------------------------------------------------

   1. NO NEW SPATIAL STRUCTURE. Thirty boxes, eight projectiles and twelve
      hazards against six cars is at most 300 squared-distance tests a frame.
      resolveVehiclePair already does 135 with square roots in it. A grid
      here would be machinery bought to solve a problem that cannot occur,
      and props.js's CSR broadphase is built once and cannot take a moving
      object anyway.

   2. BOXES ARE TRIGGERS, NOT COLLIDERS. Nothing here goes into
      props.colliders. A solid item box would bounce cars off it, which is
      the exact opposite of a pickup.

   3. ONE WRITER PER FIELD. Every effect is recomputed from scratch each
      frame into `v.extDriveMul` / `v.extTopMul`, so effects can never
      accumulate and a missed clear cannot leave a car permanently fast.
      `v.spinT` is likewise only ever written here, with `max` rather than
      `+=`. The mini-turbo owns its own multipliers separately and
      Vehicle.step composes the two.

   4. EVERY PER-RACER FIELD IS DECLARED UP FRONT in `_makeState`. race.js has
      two lazily-created timers (`lavaT`, `wedgeT`) that no reset path clears,
      and a restart inherits them. That is the bug this shape exists to avoid.

   5. EFFECTS ARE WRITTEN BEFORE THE CARS STEP. `step()` runs immediately
      before Race._stepVehicles, so a hit landed this frame is felt this
      frame. Pickup and projectile tests run against last frame's positions —
      at 39 m/s that is 65 cm against a 2 m trigger radius, which nobody can
      perceive and which buys a whole frame of latency back.
   ============================================================ */
import * as THREE from 'three';
import { G, TUNE } from './config.js';
import { DUST_KIND } from '../world/dust.js';
import { itemBoxGeo, spareWheelGeo, builder, kitPalette, shade } from '../world/kit.js';
import {
  ITEM, ITEMS, rollItem, makeInv, clearInv, hasItem, canTake, giveItem, consume, tickInv,
} from './items.js';
import { clamp } from '../core/rng.js';

const MAX_PROJ = 8;
const MAX_HAZ = 12;
const PICK_R = 1.9;              // m — box trigger radius
const PICK_Y = 1.9;              // m — and how far below it you may be
const BOX_RESPAWN = 3.5;         // s
const ROLL_TIME = 0.7;           // s of roulette before an item is usable
const BOX_HOVER = 1.15;          // m above the road

/* Boxes are laid out in packs across the road. `lapLength / 420` gives seven
   rows on the 900 m tutorial and nine on the 2 km caldera — often enough that
   the back of the field always finds one, rare enough that the road is not
   paved with them. */
const PACK_SPACING = 420;
const BUCKET = 10;               // m per entry in the arc-length lookup

/* ---------------- module scratch — nothing below allocates ---------------- */
const _dummy = new THREE.Object3D();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _pp = { x: 0, y: 0, z: 0 };
const _dd = { x: 0, z: 0 };
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);

export class ItemWorld {
  /**
   * @param o.scene, o.terrain, o.trackData, o.dust, o.audio, o.feel, o.engine
   * @param o.racers   the live racer rows (read: id, isPlayer, vehicle, pos)
   * @param o.rng      the SEEDED race stream
   * @param o.enabled  the ITEMS setting
   */
  constructor(o) {
    this.scene = o.scene;
    this.terrain = o.terrain;
    this.data = o.trackData;
    this.spline = this.data.spline;
    this.dust = o.dust;
    this.audio = o.audio;
    this.feel = o.feel;
    this.engine = o.engine;
    this.racers = o.racers;
    this.rng = o.rng;
    this.enabled = o.enabled !== false;
    this.theme = (this.data.def && this.data.def.theme) || 'training';

    this.lapLength = this.data.lapLength || this.spline.length;
    this.laps = Math.max(1, (this.data.def && this.data.def.laps) | 0 || 1);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._geo = [];
    this._mat = [];

    /* Per-racer state. Every field declared here, cleared by _clearState. */
    this.st = [];
    for (let i = 0; i < this.racers.length; i++) this.st.push(this._makeState());

    /* Per-racer nearest() output. Sharing module scratch between six callers
       is the documented bug in ai.js:365 — each racer gets its own. */
    this._near = [];
    for (let i = 0; i < this.racers.length; i++) {
      this._near.push({ s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 });
    }

    this.stats = { fired: 0, hits: 0, taken: 0 };
    this.tracker = o.tracker || null;
    this.blindT = 0;

    this._buildBoxes();
    this._buildPools();
    this._time = 0;
    if (!this.enabled) this._hideAll();
  }

  _makeState() {
    return {
      inv: makeInv(),
      boostT: 0, boostForce: 1, boostTop: 1,
      slowT: 0,
      sledT: 0,
      towT: 0, towTarget: -1,
      ghostT: 0,
      /* Per-hazard re-trigger immunity, so one slick cannot spin the same car
         four times while it slides across it. */
      hazImmune: new Float32Array(MAX_HAZ),
      rollShown: -1,          // which item name the roulette is displaying
      rollTick: 0,
    };
  }

  _clearState(s) {
    clearInv(s.inv);
    s.boostT = 0; s.boostForce = 1; s.boostTop = 1;
    s.slowT = 0; s.sledT = 0;
    s.towT = 0; s.towTarget = -1;
    s.ghostT = 0;
    s.hazImmune.fill(0);
    s.rollShown = -1; s.rollTick = 0;
  }

  /* ============================================================
     1.  BOXES
     ============================================================ */
  _buildBoxes() {
    const sp = this.spline, L = this.lapLength;
    const P = kitPalette(this.theme);
    const line = this.data.racingLine || [];
    const jumps = this.data.jumps || [];
    const cps = this.data.checkpoints || [];
    const grid = this.data.gridSlots || [];

    const xs = [], ys = [], zs = [], ss = [];
    const packs = clamp(Math.round(L / PACK_SPACING), 3, 6);
    const step = line.length ? L / line.length : 6;

    for (let p = 0; p < packs; p++) {
      const want = (p + 0.5) * L / packs;
      let best = -1;
      /* Search outward from the ideal spacing for the first sample that is
         somewhere sane to make people swerve. Rejecting rather than nudging
         keeps the layout deterministic: the same track always gets the same
         boxes, which matters because a collider that moves between races is
         a bug and a pickup that moves is a lie about the track. */
      /* The window is wide (140 m against a ~400 m row spacing) because a
         narrow one leaves HOLES, and a hole is worse than an uneven row: QA
         found CALDERA RUN placing four rows on a 2 km lap with a 776 m dead
         stretch, because two ideal sites both landed inside jump exclusion
         zones and a 40 m search could not escape them. Adjacent rows can now
         converge to ~120 m in the worst case, which is fine; a third of a lap
         with no boxes is not. */
      for (let d = 0; d <= 140 && best < 0; d += 6) {
        for (const sgn of (d === 0 ? ONE : BOTH)) {
          const s = sp.wrapS(want + sgn * d);
          if (!this._siteOk(s, line, step, jumps, cps, grid)) continue;
          best = s; break;
        }
      }
      if (best < 0) continue;

      const w = sp.widthAt(best);
      const n = clamp(Math.floor(w / 2.0), 3, 5);
      for (let k = 0; k < n; k++) {
        const lat = n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * Math.max(1.2, w - 2.2);
        const q = sp.offsetPoint(best, lat, _pp);
        xs.push(q.x);
        ys.push(this.terrain.heightAt(q.x, q.z) + BOX_HOVER);
        zs.push(q.z);
        ss.push(best);
      }
    }

    const n = xs.length;
    this.nBox = n;
    this.boxX = new Float32Array(xs);
    this.boxY = new Float32Array(ys);
    this.boxZ = new Float32Array(zs);
    this.boxS = new Float32Array(ss);
    this.boxT = new Float32Array(n);        // > 0 = collected, counting back

    /* Arc-length lookup: s -> first box index at or after it. One Int16Array
       and the pickup test becomes "check the two or three boxes near where
       this car is", which is how racecore tests checkpoints. */
    const nb = Math.max(1, Math.ceil(L / BUCKET));
    this.bucket = new Int16Array(nb);
    let bi = 0;
    for (let b = 0; b < nb; b++) {
      const s = b * BUCKET;
      while (bi < n - 1 && this.boxS[bi] < s) bi++;
      this.bucket[b] = bi;
    }

    if (!n) { this.boxMesh = null; return; }
    const geo = this._keepGeo(itemBoxGeo(P, 149));
    const mat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0.15,
      emissive: 0x201400, emissiveIntensity: 1.0,
    }));
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.castShadow = true; im.frustumCulled = false;
    this.group.add(im);
    this.boxMesh = im;
    void P;
  }

  /** Is `s` a reasonable place to put a row of boxes? */
  _siteOk(s, line, step, jumps, cps, grid) {
    const L = this.lapLength;
    // Never in a jump window: a box on a lip is a box nobody can collect and
    // a swerve nobody can afford.
    for (let i = 0; i < jumps.length; i++) {
      const j = jumps[i];
      let d = s - (j.s - 40);
      if (d < 0) d += L;
      if (d < 40 + j.len + (j.gap || 0) + 25) return false;
    }
    // Not on a checkpoint disc — the gate furniture is already there.
    const q = this.spline.posAt(s, _pp);
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      const dx = q.x - c.x, dz = q.z - c.z;
      if (dx * dx + dz * dz < (c.r + 6) * (c.r + 6)) return false;
    }
    // Not on the grid, and not in the last stretch before the line.
    for (let i = 0; i < grid.length; i++) {
      const gd = grid[i];
      const dx = q.x - gd.x, dz = q.z - gd.z;
      if (dx * dx + dz * dz < 1600) return false;
    }
    if (s < 25 || s > L - 90) return false;
    // Straights and corner exits only. A hairpin apex is the worst possible
    // place to ask somebody to choose a line.
    if (Math.abs(this.spline.curvatureAt(s)) > 1 / 62) return false;
    // And not on the lava.
    if (line.length) {
      const idx = clamp(Math.round(s / Math.max(1e-3, step)), 0, line.length - 1);
      const pt = line[idx];
      if (pt && pt.jump) return false;
    }
    return true;
  }

  /* ============================================================
     2.  POOLS
     ============================================================ */
  _buildPools() {
    const P = kitPalette(this.theme);

    this.pX = new Float32Array(MAX_PROJ); this.pY = new Float32Array(MAX_PROJ);
    this.pZ = new Float32Array(MAX_PROJ);
    this.pVX = new Float32Array(MAX_PROJ); this.pVY = new Float32Array(MAX_PROJ);
    this.pVZ = new Float32Array(MAX_PROJ);
    this.pLife = new Float32Array(MAX_PROJ);
    this.pArm = new Float32Array(MAX_PROJ);
    this.pSpin = new Float32Array(MAX_PROJ);
    this.pOwner = new Int8Array(MAX_PROJ).fill(-1);
    this.pBounce = new Int8Array(MAX_PROJ);

    const pg = this._keepGeo(spareWheelGeo(P, 151));
    const pm = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, metalness: 0.05,
    }));
    const pim = new THREE.InstancedMesh(pg, pm, MAX_PROJ);
    pim.castShadow = true; pim.frustumCulled = false;
    this.group.add(pim);
    this.projMesh = pim;

    this.hX = new Float32Array(MAX_HAZ); this.hY = new Float32Array(MAX_HAZ);
    this.hZ = new Float32Array(MAX_HAZ); this.hLife = new Float32Array(MAX_HAZ);
    this.hOwner = new Int8Array(MAX_HAZ).fill(-1);

    /* The slick is a decal: a flat disc lifted a few centimetres and pushed
       into the depth buffer, the same trick props.js uses for the finish
       stripe. Its own material because polygonOffset and transparency are
       material state, not geometry. */
    const b = builder();
    b.plane(shade(P.glass, -0.3), 5.2, 5.2, 0, 0, 0, -Math.PI / 2, 0, 0);
    const hg = this._keepGeo(b.done());
    this.hazMat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.18, metalness: 0.35,
      transparent: true, opacity: 0.9, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3,
      side: THREE.DoubleSide,
    }));
    const him = new THREE.InstancedMesh(hg, this.hazMat, MAX_HAZ);
    him.castShadow = false; him.frustumCulled = false;
    this.group.add(him);
    this.hazMesh = him;

    /* One stretched cylinder, respanned per frame — three.js Line ignores
       linewidth on most platforms, so a "line" has to be geometry. */
    const tg = this._keepGeo(new THREE.CylinderGeometry(0.055, 0.055, 1, 6).rotateX(Math.PI / 2));
    const tm = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x4fd07a, emissive: 0x1d5c33, roughness: 0.5,
    }));
    this.towMesh = new THREE.Mesh(tg, tm);
    this.towMesh.visible = false;
    this.towMesh.frustumCulled = false;
    this.group.add(this.towMesh);
  }

  _keepGeo(g) { this._geo.push(g); return g; }
  _keepMat(m) { this._mat.push(m); return m; }

  /* ============================================================
     3.  THE FRAME
     ============================================================ */
  /**
   * Simulation. Called from Race.update immediately BEFORE _stepVehicles, so
   * everything written here is felt by the cars in the same frame.
   * @param live true only while the race is actually running
   */
  step(dt, live) {
    this._time += dt;
    if (!this.enabled) return;

    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i], s = this.st[i], v = r.vehicle;
      tickInv(s.inv, dt);
      if (s.inv.rollT > 0) {
        // Roulette: cosmetic only, so Math.random is allowed (house rule 6).
        s.rollTick -= dt;
        if (s.rollTick <= 0) { s.rollTick = 0.06; s.rollShown = (Math.random() * ITEMS.length) | 0; }
      } else s.rollShown = -1;

      if (s.boostT > 0) s.boostT -= dt;
      if (s.slowT > 0) s.slowT -= dt;
      if (s.ghostT > 0) s.ghostT -= dt;
      if (s.sledT > 0) this._stepSled(dt, r, s);
      if (s.towT > 0) this._stepTow(dt, r, s);
      for (let h = 0; h < MAX_HAZ; h++) if (s.hazImmune[h] > 0) s.hazImmune[h] -= dt;

      /* Recomputed from scratch every frame — see decision 3 in the header. */
      let fm = 1, tm = 1;
      if (s.boostT > 0) { fm *= s.boostForce; tm *= s.boostTop; }
      if (s.slowT > 0) { fm *= ITEMS[ITEM.STORM].force; tm *= ITEMS[ITEM.STORM].top; }
      if (s.sledT > 0) { fm *= ITEMS[ITEM.SLED].force; tm *= ITEMS[ITEM.SLED].top; }
      v.extDriveMul = fm;
      v.extTopMul = tm;
    }

    if (!live) return;
    this._stepBoxes(dt);
    this._stepProjectiles(dt);
    this._stepHazards(dt);
  }

  _stepBoxes(dt) {
    for (let i = 0; i < this.nBox; i++) {
      if (this.boxT[i] > 0) { this.boxT[i] -= dt; if (this.boxT[i] < 0) this.boxT[i] = 0; }
    }
    if (!this.nBox) return;

    for (let ri = 0; ri < this.racers.length; ri++) {
      const r = this.racers[ri], s = this.st[ri], v = r.vehicle;
      if (r.finished || !canTake(s.inv)) continue;
      const near = this._near[ri];
      this.spline.nearest(v.pos.x, v.pos.z, near);
      const b0 = this.bucket[clamp(Math.floor(near.s / BUCKET), 0, this.bucket.length - 1)];
      // The bucket points at the first box at or after this arc length; a car
      // can be just past one, so look one entry back as well as forward.
      for (let k = -1; k <= 4; k++) {
        const bi = b0 + k;
        if (bi < 0 || bi >= this.nBox || this.boxT[bi] > 0) continue;
        const dx = v.pos.x - this.boxX[bi], dz = v.pos.z - this.boxZ[bi];
        if (dx * dx + dz * dz > PICK_R * PICK_R) continue;
        const dy = v.pos.y - this.boxY[bi];
        if (dy * dy > PICK_Y * PICK_Y) continue;
        this._collect(ri, bi);
        break;
      }
    }
  }

  _collect(ri, bi) {
    const r = this.racers[ri], s = this.st[ri];
    this.boxT[bi] = BOX_RESPAWN;
    const id = rollItem(r.pos || this.racers.length, this.racers.length,
      this._ctxFor(r), this.rng);
    giveItem(s.inv, id, ROLL_TIME);
    this.stats.taken++;
    if (r.isPlayer) {
      this.audio.itemRoll();
    }
    if (this.dust) {
      this.dust.burst(this.boxX[bi], this.boxY[bi], this.boxZ[bi], 0, 0.8, BOX_POP);
    }
  }

  /** The three flags items.js's gates read. Cheap; called once per pickup. */
  _ctxFor(r) {
    const c = _ctx;
    const prog = this.tracker ? this.tracker.progress(r.id) : null;
    const done = prog ? prog.raceS : 0;
    c.toFinishM = this.laps * this.lapLength - done;
    c.behindSec = r.behindSec || 0;
    c.hasTarget = this._findTarget(r, ITEMS[ITEM.TOW]) >= 0;
    return c;
  }

  /* ---------------- projectiles ---------------- */
  _stepProjectiles(dt) {
    const def = ITEMS[ITEM.WHEEL];
    for (let i = 0; i < MAX_PROJ; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      if (this.pArm[i] > 0) this.pArm[i] -= dt;
      if (this.pLife[i] <= 0) { this._killProj(i); continue; }

      this.pVY[i] -= G * dt;
      this.pX[i] += this.pVX[i] * dt;
      this.pY[i] += this.pVY[i] * dt;
      this.pZ[i] += this.pVZ[i] * dt;

      const gy = this.terrain.heightAt(this.pX[i], this.pZ[i]) + 0.30;
      if (this.pY[i] <= gy) {
        this.pY[i] = gy;
        if (this.pVY[i] < 0) {
          this.pVY[i] = -this.pVY[i] * def.bounce;
          this.pVX[i] *= 0.94; this.pVZ[i] *= 0.94;
          if (++this.pBounce[i] > def.maxBounce) { this._killProj(i); continue; }
        }
      }

      /* Ricochet off the ROAD EDGE rather than off props. props.resolve()
         ignores Y entirely, so a wheel flying three metres over a boulder
         would "bounce off thin air" — far more visible than clipping a
         barrier. Reflecting the lateral component off the corridor edge is
         cheap, needs no collider query, and reads exactly right: the wheel
         rattles down the canyon instead of leaving it. */
      this.spline.nearest(this.pX[i], this.pZ[i], _projNear);
      const w = this.spline.widthAt(_projNear.s) * 1.15;
      if (_projNear.d > w) {
        const dx = this.spline.dirAt(_projNear.s, _dd);
        const nx = dx.z * -_projNear.side, nz = -dx.x * -_projNear.side;
        const vn = this.pVX[i] * nx + this.pVZ[i] * nz;
        if (vn < 0) { this.pVX[i] -= 2 * vn * nx * 0.8; this.pVZ[i] -= 2 * vn * nz * 0.8; }
      }

      // versus cars
      for (let ri = 0; ri < this.racers.length; ri++) {
        const r = this.racers[ri], v = r.vehicle;
        if (r.finished || v.ghost || this.st[ri].sledT > 0) continue;
        if (ri === this.pOwner[i] && this.pArm[i] > 0) continue;
        const dx = v.pos.x - this.pX[i], dy = v.pos.y - this.pY[i], dz = v.pos.z - this.pZ[i];
        const R = (v.collRadius || 1.2) + def.radius;
        if (dx * dx + dy * dy + dz * dz > R * R) continue;
        this._spin(ri, this.pSpin[i], this.pVX[i], this.pVZ[i]);
        this._killProj(i);
        break;
      }
    }
  }

  _killProj(i) {
    this.pLife[i] = 0; this.pOwner[i] = -1; this.pBounce[i] = 0;
    _dummy.position.set(0, -9999, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(0.0001);
    _dummy.updateMatrix();
    this.projMesh.setMatrixAt(i, _dummy.matrix);
    this.projMesh.instanceMatrix.needsUpdate = true;
  }

  /* ---------------- hazards ---------------- */
  _stepHazards(dt) {
    const def = ITEMS[ITEM.SLICK];
    for (let i = 0; i < MAX_HAZ; i++) {
      if (this.hLife[i] <= 0) continue;
      this.hLife[i] -= dt;
      if (this.hLife[i] <= 0) { this.hOwner[i] = -1; continue; }
      for (let ri = 0; ri < this.racers.length; ri++) {
        const r = this.racers[ri], v = r.vehicle, s = this.st[ri];
        if (r.finished || v.ghost || s.sledT > 0 || s.hazImmune[i] > 0) continue;
        if (v.airborne) continue;                 // you cannot slip on air
        const dx = v.pos.x - this.hX[i], dz = v.pos.z - this.hZ[i];
        if (dx * dx + dz * dz > def.radius * def.radius) continue;
        s.hazImmune[i] = def.immune;
        this._spin(ri, def.spin, v.vel.x, v.vel.z);
      }
    }
  }

  /* ============================================================
     4.  EFFECTS
     ============================================================ */
  /**
   * Spin a car out. `spinT` routes through Vehicle.step's handbrake override,
   * so the whole tuned drift path (grip cut, ABS-bypassed rear brake, the
   * spinGuard walk-back) does the work — a hand-rolled spin force would have
   * to re-earn all of it. Never additive: `max`, so two hits in a second are
   * one spin, not two seconds of one.
   */
  _spin(ri, dur, dirX, dirZ) {
    const r = this.racers[ri], v = r.vehicle;
    if (v.spinT >= dur) return;
    v.spinT = dur;
    /* Deliberately above TUNE.assists.yawRateCap so the always-on cap bleeds
       it: a rotation that starts violently and self-limits. The sign comes
       from which side the hit arrived on, so being clipped from the left
       spins you left. */
    const side = (dirX * v.right.x + dirZ * v.right.z) > 0 ? -1 : 1;
    v.omega.y += side * 3.2;
    this.stats.hits++;
    const cam = this.engine ? this.engine.camera.position : null;
    const d = cam ? v.pos.distanceTo(cam) : 0;
    if (r.isPlayer) {
      this.audio.spinOut(1);
      if (this.feel) {
        _v1.copy(v.vel).setY(0);
        if (_v1.lengthSq() > 1e-6) _v1.normalize().negate(); else _v1.set(0, 0, 1);
        this.feel.collision(9, _v1);
      }
    } else if (d < 80) this.audio.spinOut(clamp(1 - d / 80, 0.15, 0.6));
    if (this.dust && d < 110) {
      this.dust.burst(v.pos.x, this.terrain.heightAt(v.pos.x, v.pos.z), v.pos.z,
        Math.atan2(v.vel.x, v.vel.z), 1.4, SPIN_POP);
    }
  }

  _boost(ri, def) {
    const s = this.st[ri], r = this.racers[ri];
    s.boostT = Math.max(s.boostT, def.time);
    s.boostForce = Math.max(s.boostForce > 1 ? s.boostForce : 1, def.force);
    s.boostTop = Math.max(s.boostTop > 1 ? s.boostTop : 1, def.top);
    const v = r.vehicle;
    if (r.isPlayer) {
      this.audio.boostFire(3, 1);
      if (this.feel) { this.feel.kick(TUNE.boost.fireFov[2]); this.feel.addShake(0.22); }
    }
    if (this.dust) {
      const f = v.forward;
      this.dust.spawn(5, v.pos.x - f.x * 1.6, v.pos.y - 0.15, v.pos.z - f.z * 1.6,
        3.0, 0.32, -f.x, -f.z, 1.0, 0.55, 0.16, DUST_KIND.EMBER);
    }
  }

  /* ---------------- the rocket sled ---------------- */
  _stepSled(dt, r, s) {
    s.sledT -= dt;
    s.ghostT = Math.max(s.ghostT, 0.05);   // stays ghosted for the whole ride
    if (s.sledT <= 0 || r.finished || (r.pos && r.pos <= ITEMS[ITEM.SLED].releaseAt)) {
      s.sledT = 0; s.ghostT = 0;
      return;
    }
    const v = r.vehicle;
    if (this.dust) {
      const f = v.forward;
      this.dust.spawn(2, v.pos.x - f.x * 1.7, v.pos.y - 0.1, v.pos.z - f.z * 1.7,
        3.4, 0.30, -f.x, -f.z, 1.0, 0.5, 0.18, DUST_KIND.EMBER);
    }
  }

  /**
   * Drive a sledding car. Race calls this INSTEAD of the player's raw input
   * or the AI's ctl — the same override the countdown already performs, and
   * the same racing-line pursuit dev/qa-drive.js uses to drive the player.
   * @returns true if it wrote the ctl
   */
  pilot(ri, ctl) {
    const s = this.st[ri];
    if (!this.enabled || s.sledT <= 0) return false;
    const r = this.racers[ri], v = r.vehicle;
    const near = this._near[ri];
    this.spline.nearest(v.pos.x, v.pos.z, near);
    const aim = this.spline.wrapS(near.s + 16 + Math.abs(v.speed) * 0.35);
    const p = this.spline.posAt(aim, _pp);
    _v1.set(p.x - v.pos.x, 0, p.z - v.pos.z);
    if (_v1.lengthSq() > 1e-6) _v1.normalize();
    const f = v.forward, rt = v.right;
    ctl.throttle = 1;
    ctl.brake = 0;
    ctl.handbrake = 0;
    ctl.steer = clamp(_v1.dot(rt) * 2.6, -1, 1) * (f.dot(_v1) > 0 ? 1 : 1);
    return true;
  }

  /* ---------------- the tow line ---------------- */
  _stepTow(dt, r, s) {
    const def = ITEMS[ITEM.TOW];
    s.towT -= dt;
    const t = this.racers[s.towTarget];
    if (s.towT <= 0 || !t || t.finished || t.vehicle.ghost) { this._endTow(s); return; }
    const a = r.vehicle, b = t.vehicle;
    _v1.subVectors(b.pos, a.pos);
    const d = _v1.length();
    if (d < def.breakNear || d > def.breakFar) { this._endTow(s); return; }
    /* A tow that drags either car off the road is a tow that has stopped
       being a racing move. Break it instead. */
    this.spline.nearest(a.pos.x, a.pos.z, _projNear);
    if (_projNear.d > this.spline.widthAt(_projNear.s) * 1.2) { this._endTow(s); return; }
    _v1.divideScalar(d);
    a.vel.addScaledVector(_v1, def.pull * dt);
    b.vel.addScaledVector(_v1, -def.drag * dt);
  }

  _endTow(s) { s.towT = 0; s.towTarget = -1; }

  /** Nearest car ahead inside the item's cone and distance window, or -1. */
  _findTarget(r, def) {
    const v = r.vehicle, f = v.forward, rt = v.right;
    let best = -1, bestD = 1e9;
    for (let i = 0; i < this.racers.length; i++) {
      const o = this.racers[i];
      if (o === r || o.finished || o.vehicle.ghost) continue;
      _v2.subVectors(o.vehicle.pos, v.pos);
      const fwd = _v2.x * f.x + _v2.z * f.z;
      if (fwd < def.minDist || fwd > def.maxDist) continue;
      const lat = _v2.x * rt.x + _v2.z * rt.z;
      if (Math.abs(Math.atan2(lat, fwd)) > def.cone) continue;
      if (fwd < bestD) { bestD = fwd; best = i; }
    }
    return best;
  }

  /* ============================================================
     5.  FIRING
     ============================================================ */
  /**
   * Use the held item.
   * @param ri   racer index
   * @param back true to send it behind (player holds reverse; AI decides)
   */
  fire(ri, back) {
    if (!this.enabled) return false;
    const s = this.st[ri], r = this.racers[ri];
    if (r.finished) return false;
    const def = consume(s.inv);
    if (!def) return false;
    this.stats.fired++;
    const v = r.vehicle;

    switch (def.kind) {
      case 'boost':
        this._boost(ri, def);
        break;
      case 'projectile': {
        const i = this._freeProj();
        if (i < 0) break;
        const f = v.forward;
        const dir = back ? -1 : 1;
        this.pX[i] = v.pos.x + f.x * dir * 2.2;
        this.pY[i] = v.pos.y + 0.2;
        this.pZ[i] = v.pos.z + f.z * dir * 2.2;
        this.pVX[i] = v.vel.x + f.x * def.speed * dir;
        this.pVY[i] = def.lift;
        this.pVZ[i] = v.vel.z + f.z * def.speed * dir;
        this.pLife[i] = def.life;
        this.pArm[i] = def.arm;
        this.pSpin[i] = def.spin;
        this.pOwner[i] = ri;
        this.pBounce[i] = 0;
        if (r.isPlayer || this._camNear(v, 70)) this.audio.itemThrow(r.isPlayer ? 1 : 0.4);
        break;
      }
      case 'hazard': {
        const i = this._freeHaz();
        if (i < 0) break;
        const f = v.forward;
        this.hX[i] = v.pos.x - f.x * def.drop;
        this.hZ[i] = v.pos.z - f.z * def.drop;
        this.hY[i] = this.terrain.heightAt(this.hX[i], this.hZ[i]) + 0.06;
        this.hLife[i] = def.life;
        this.hOwner[i] = ri;
        for (let k = 0; k < this.st.length; k++) this.st[k].hazImmune[i] = 0;
        // the dropper gets a moment's grace so they cannot spin themselves
        s.hazImmune[i] = 1.0;
        if (r.isPlayer || this._camNear(v, 60)) this.audio.itemDrop(r.isPlayer ? 1 : 0.4);
        break;
      }
      case 'tow': {
        const ti = this._findTarget(r, def);
        if (ti < 0) { this._boost(ri, ITEMS[ITEM.NITRO]); break; }   // never waste a pickup
        s.towT = def.time; s.towTarget = ti;
        if (r.isPlayer || this._camNear(v, 70)) this.audio.towSnap(r.isPlayer ? 1 : 0.4);
        break;
      }
      case 'sled':
        s.sledT = def.time;
        s.ghostT = def.time;
        if (r.isPlayer) {
          this.audio.sledLaunch();
          if (this.feel) { this.feel.kick(3); this.feel.addShake(0.4); }
        }
        break;
      case 'storm': {
        const myPos = r.pos || this.racers.length;
        for (let i = 0; i < this.racers.length; i++) {
          const o = this.racers[i];
          if (o === r || o.finished) continue;
          if ((o.pos || 99) >= myPos) continue;         // only those AHEAD
          this.st[i].slowT = Math.max(this.st[i].slowT, def.time);
          if (o.isPlayer) this.blindT = def.time;
        }
        this.audio.stormHit(r.isPlayer ? 1 : 0.5);
        break;
      }
      default: break;
    }
    return true;
  }

  _freeProj() { for (let i = 0; i < MAX_PROJ; i++) if (this.pLife[i] <= 0) return i; return -1; }
  _freeHaz() {
    let old = 0, oldT = 1e9;
    for (let i = 0; i < MAX_HAZ; i++) {
      if (this.hLife[i] <= 0) return i;
      if (this.hLife[i] < oldT) { oldT = this.hLife[i]; old = i; }
    }
    return old;                       // reuse the one about to expire anyway
  }
  /** Is this car close enough to the camera to be worth hearing? Same
      distance-gating idea as Race._contact: a rival's item forty metres up
      the road is information, one at four hundred is noise. */
  _camNear(v, m) {
    if (!this.engine || !this.engine.camera) return false;
    return v.pos.distanceTo(this.engine.camera.position) < m;
  }

  /* ============================================================
     6.  PRESENTATION
     ============================================================ */
  updateVisuals(dt, camera) {
    if (!this.enabled) return;
    const t = this._time;

    if (this.boxMesh) {
      for (let i = 0; i < this.nBox; i++) {
        const gone = this.boxT[i] > 0;
        if (gone) {
          _dummy.position.set(this.boxX[i], this.boxY[i], this.boxZ[i]);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.setScalar(0.0001);
        } else {
          _dummy.position.set(this.boxX[i],
            this.boxY[i] + Math.sin(t * 1.8 + i * 1.7) * 0.16, this.boxZ[i]);
          _dummy.rotation.set(0, t * 1.1 + i * 0.9, 0);
          _dummy.scale.setScalar(1);
        }
        _dummy.updateMatrix();
        this.boxMesh.setMatrixAt(i, _dummy.matrix);
      }
      this.boxMesh.instanceMatrix.needsUpdate = true;
    }

    for (let i = 0; i < MAX_PROJ; i++) {
      if (this.pLife[i] <= 0) continue;
      _dummy.position.set(this.pX[i], this.pY[i], this.pZ[i]);
      const sp = Math.hypot(this.pVX[i], this.pVZ[i]);
      _dummy.rotation.set(0, Math.atan2(this.pVX[i], this.pVZ[i]), 0);
      _dummy.rotateX(-t * Math.max(2, sp * 0.9));
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      this.projMesh.setMatrixAt(i, _dummy.matrix);
    }
    this.projMesh.instanceMatrix.needsUpdate = true;

    const hdef = ITEMS[ITEM.SLICK];
    for (let i = 0; i < MAX_HAZ; i++) {
      const live = this.hLife[i] > 0;
      _dummy.position.set(this.hX[i], live ? this.hY[i] : -9999, this.hZ[i]);
      _dummy.rotation.set(0, i * 1.3, 0);
      // fade in fast, then hold, then shrink away in the last second
      const k = live ? Math.min(1, this.hLife[i]) * Math.min(1, (hdef.life - this.hLife[i]) * 6) : 0.0001;
      _dummy.scale.set(Math.max(0.0001, k), 1, Math.max(0.0001, k));
      _dummy.updateMatrix();
      this.hazMesh.setMatrixAt(i, _dummy.matrix);
    }
    this.hazMesh.instanceMatrix.needsUpdate = true;

    // the tow rope
    let towShown = false;
    for (let i = 0; i < this.st.length && !towShown; i++) {
      const s = this.st[i];
      if (s.towT <= 0 || s.towTarget < 0) continue;
      const a = this.racers[i].vehicle.pos, b = this.racers[s.towTarget].vehicle.pos;
      this.towMesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 0.35, (a.z + b.z) * 0.5);
      _v1.subVectors(b, a);
      const len = _v1.length();
      this.towMesh.scale.set(1, 1, Math.max(0.02, len));
      if (len > 1e-4) this.towMesh.quaternion.setFromUnitVectors(_zAxis, _v1.divideScalar(len));
      this.towMesh.visible = true;
      towShown = true;
    }
    if (!towShown) this.towMesh.visible = false;

    /* The blind. Its own uniform: feel.js exclusively owns uVignette,
       uExposure and uFlash and dev/camera-check asserts their exact reset
       values, so a screen effect from here needs somewhere of its own to
       live — the same reasoning that gave the per-stage grade `uGrade`.
       Re-resolved every frame because a quality change rebuilds the composer
       and hands out a brand new ShaderPass. */
    if (this.blindT > 0) this.blindT -= dt;
    const u = this.engine && this.engine.final && this.engine.final.uniforms;
    if (u && u.uBlind) {
      const want = this.blindT > 0
        ? ITEMS[ITEM.STORM].blind * Math.min(1, this.blindT * 3)
        : 0;
      u.uBlind.value += (want - u.uBlind.value) * Math.min(1, dt * 9);
      if (u.uBlind.value < 0.002) u.uBlind.value = 0;
    }
    void camera;
  }

  /* ============================================================
     7.  HUD, RESET, TEARDOWN
     ============================================================ */
  /** Fill a pre-allocated payload object. No allocation, no strings. */
  hudFor(ri, out) {
    const s = this.st[ri];
    out.enabled = this.enabled;
    out.rolling = s.inv.rollT > 0;
    const id = out.rolling ? s.rollShown : s.inv.id;
    const def = id >= 0 ? ITEMS[id] : null;
    out.id = def ? def.id : -1;
    out.name = def ? def.name : '';
    out.col = def ? def.col : 0;
    out.charges = out.rolling ? 0 : s.inv.charges;
    return out;
  }

  isGhost(ri) { return this.enabled && this.st[ri].ghostT > 0; }
  isSledding(ri) { return this.enabled && this.st[ri].sledT > 0; }
  hasItem(ri) { return this.enabled && hasItem(this.st[ri].inv) && this.st[ri].inv.rollT <= 0; }
  itemOf(ri) { const s = this.st[ri]; return s.inv.rollT > 0 ? ITEM.NONE : s.inv.id; }

  /**
   * A racer was teleported. Cancel everything that was happening TO them and
   * everything they had in flight — a projectile owned by a car that is no
   * longer where it was is a projectile nobody can read. The held ITEM
   * survives: losing it would double-punish a respawn.
   */
  notifyReset(ri) {
    const s = this.st[ri];
    s.boostT = 0; s.boostForce = 1; s.boostTop = 1;
    s.slowT = 0; s.sledT = 0; s.ghostT = 0;
    this._endTow(s);
    s.hazImmune.fill(0);
    for (let i = 0; i < this.st.length; i++) {
      if (this.st[i].towTarget === ri) this._endTow(this.st[i]);
    }
    for (let i = 0; i < MAX_PROJ; i++) if (this.pOwner[i] === ri) this._killProj(i);
    const v = this.racers[ri].vehicle;
    v.extDriveMul = 1; v.extTopMul = 1; v.spinT = 0;
  }

  /** A restart or a return to the grid: everything, everywhere, gone. */
  resetAll() {
    for (let i = 0; i < this.st.length; i++) {
      this._clearState(this.st[i]);
      const v = this.racers[i].vehicle;
      v.extDriveMul = 1; v.extTopMul = 1; v.spinT = 0;
    }
    for (let i = 0; i < MAX_PROJ; i++) this._killProj(i);
    this.hLife.fill(0); this.hOwner.fill(-1);
    this.boxT.fill(0);
    this.blindT = 0;
    this.stats.fired = 0; this.stats.hits = 0; this.stats.taken = 0;
    const u = this.engine && this.engine.final && this.engine.final.uniforms;
    if (u && u.uBlind) u.uBlind.value = 0;
    if (this.towMesh) this.towMesh.visible = false;
  }

  setEnabled(on) {
    const was = this.enabled;
    this.enabled = !!on;
    if (was && !this.enabled) { this.resetAll(); this._hideAll(); }
    else if (!was && this.enabled) this.group.visible = true;
  }

  _hideAll() {
    this.group.visible = false;
    for (let i = 0; i < this.st.length; i++) {
      const v = this.racers[i].vehicle;
      v.extDriveMul = 1; v.extTopMul = 1;
    }
  }

  dispose() {
    this.resetAll();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this._geo.length = 0; this._mat.length = 0;
    this.racers = null; this.st.length = 0;
  }
}

/* ---------------- module constants ---------------- */
const ONE = [0];
const BOTH = [-1, 1];
const BOX_POP = [1.0, 0.78, 0.22];
const SPIN_POP = [0.42, 0.38, 0.34];
const _ctx = { toFinishM: -1, hasTarget: true, behindSec: 0 };
const _projNear = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
void _q1; void _up; void _v2;

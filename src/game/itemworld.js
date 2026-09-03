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

   6. BOOST PADS ARE TRACK FURNITURE, NOT A POWER-UP. They are chevrons
      painted on the road; a stage that has them has them whatever the ITEMS
      setting says, and a lap time set with items off has to be comparable
      with one set with them on. `step()` is therefore split into an item
      layer gated on `enabled` and a pad layer that is not, `_hideAll` leaves
      the pads alone, and the pad meshes live in their own group so hiding
      the item group cannot take them with it.
   ============================================================ */
import * as THREE from 'three';
import { G, TUNE } from './config.js';
import { DUST_KIND } from '../world/dust.js';
import {
  itemBoxGeo, spareWheelGeo, boostPadGeo, builder, kitPalette, shade,
} from '../world/kit.js';
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
/* How far away a rival's shot is still worth hearing and logging. Both used
   to be 60-70 m, which on a spread-out grid is "never": the field fires 40 to
   80 items a race and the cockpit registered almost none of them, which is
   why the AI reads as though it does not use items at all. */
const FIRE_HEAR_D = 110;         // m — audio
const FIRE_LOG_D = 80;           // m — the race log line
/* A box has to be readable from 150 m at 40 m/s, which the old 1.15 m hover,
   1.1 rad/s spin and 0.55-roughness amber were not. Higher, bigger, faster,
   and above the bloom threshold at the top of the pulse. */
const BOX_HOVER = 1.35;          // m above the road
const BOX_SCALE = 1.25;          // × the authored geometry
const BOX_SPIN = 2.2;            // rad/s
const BOX_BOB = 0.20;            // m of hover travel
const BOX_EMIT_LO = 0.9, BOX_EMIT_HI = 1.7;   // emissiveIntensity pulse
const BOX_POP_T = 0.2;           // s to shrink away when collected
const BOX_IN_T = 0.4;            // s to scale back in on respawn
const HALO_R = 1.5;              // m — the flat additive disc under each box

/* ---------------- boost pads (contract 6.1 `pads[]`) ---------------- */
const PAD_HW = 1.6, PAD_LEN = 4, PAD_MUL = 1.6, PAD_TOP = 1.10, PAD_TIME = 1.2;
/* Re-trigger lockout for THE SAME pad, on top of that pad's own boost time.
   Per-pad rather than per-car on purpose: a car parked on a pad must not
   farm it for ever, but an authored CHAIN of pads has to chain — a blanket
   per-car cooldown would silently eat every pad but the first. */
const PAD_CD = 0.35;
const PAD_GEO_HW = 1.6;          // kit.js boostPadGeo: W 3.2 => half-width 1.6
const PAD_GEO_LEN = 4.0;         // …and LEN 4.0. Instances scale from these.

/* ---------------- what the AI is allowed to see ----------------
   Contract 6.7 radii. These are DANGER radii, not collision radii: what the
   dodge wants to know is how wide to go, and a spare wheel's 0.36 m hitbox
   plus a car's 1.2 m is the distance at which it actually matters. */
const THREAT_R_PROJ = 1.6;
const THREAT_R_HAZ = ITEMS[ITEM.SLICK].radius;
const THREAT_PROJ = 0, THREAT_HAZ = 1;   // `kind`

/* Boxes are laid out in packs across the road. `lapLength / 420` gives seven
   rows on the 900 m tutorial and nine on the 2 km caldera — often enough that
   the back of the field always finds one, rare enough that the road is not
   paved with them. */
const PACK_SPACING = 420;
const BUCKET = 10;               // m per entry in the arc-length lookup

/* ---------------- module scratch — nothing below allocates ---------------- */
const _dummy = new THREE.Object3D();
/* Spline scratch for the storm curtain — module-level and single-writer, the
   same house rule as _dummy above. */
const _sp2 = { x: 0, y: 0, z: 0 };
const _sd2 = { x: 0, y: 0, z: 0 };
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
   * @param o.vfx      world/vfx.js, or null. EVERY call site is guarded.
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
    /* Contract 6.2. Built in main.js buildWorld and threaded in by Race; null
       until P1's module lands, and null for good on any path that does not
       build a world. Guarded at every call, never cached into a local. */
    this.vfx = o.vfx || null;
    this.racers = o.racers;
    this.rng = o.rng;
    this.enabled = o.enabled !== false;
    this.theme = (this.data.def && this.data.def.theme) || 'training';

    this.lapLength = this.data.lapLength || this.spline.length;
    this.laps = Math.max(1, (this.data.def && this.data.def.laps) | 0 || 1);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    /* Pads are not part of the item group: `_hideAll` hides that one, and a
       stage's boost pads have to survive the ITEMS setting being off. */
    this.padGroup = new THREE.Group();
    this.scene.add(this.padGroup);
    this._geo = [];
    this._mat = [];

    /* Contract 6.7 — plain scalars, bumped by a sequence number so a reader
       can tell "a new one" from "the same one still". race.js copies these
       into the HUD payload; the AI may read them; nobody writes them but us. */
    this.events = {
      hitSeq: 0, hitTarget: -1, hitOwner: -1, hitItem: -1,
      pickSeq: 0, pickRacer: -1, pickItem: -1,
      padSeq: 0, padRacer: -1,
      /* Somebody FIRED something. The AI has always fired 40-80 items a race
         and none of it was legible from the cockpit — no sound past 70 m, no
         particles at all (Race handed us `vfx: null`), and nothing in the log.
         `fireNear` is the "close enough to be information" flag. */
      fireSeq: 0, fireRacer: -1, fireItem: -1, fireNear: false,
      /* A line of text for the things the game simply never said: a full slot
         driving through a box, a tow with nothing to hook. */
      noteSeq: 0, noteText: '',
    };
    /* Per-box cooldown on the SLOT FULL note, so one long row of boxes does
       not produce eight identical log lines. */
    this._noteCd = 0;

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
    this._buildPads();
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
      /* Bumped on the frame the roulette LANDS on something, which is the
         moment the item is actually yours. hud.js keys its pickup callout off
         this (contract 6.6) and deliberately ignores a change made while
         `rolling` is true, so bumping it at pickup produced nothing at all. */
      readySeq: 0,
      // boost pads — declared here like everything else (decision 4)
      padT: 0, padCd: 0, padMul: 1, padTop: 1, padLast: -1,
      sledFlame: 0,           // 1 while a vfx flame is lit for this racer
    };
  }

  _clearState(s) {
    clearInv(s.inv);
    s.boostT = 0; s.boostForce = 1; s.boostTop = 1;
    s.slowT = 0; s.sledT = 0;
    s.towT = 0; s.towTarget = -1;
    s.ghostT = 0;
    s.hazImmune.fill(0);
    s.rollShown = -1; s.rollTick = 0; s.readySeq = 0;
    s.padT = 0; s.padCd = 0; s.padMul = 1; s.padTop = 1; s.padLast = -1;
    s.sledFlame = 0;
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

    const xs = [], ys = [], zs = [], ss = [], ls = [];
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
        ls.push(lat);
      }
    }

    const n = xs.length;
    this.nBox = n;
    this.boxX = new Float32Array(xs);
    this.boxY = new Float32Array(ys);
    this.boxZ = new Float32Array(zs);
    this.boxS = new Float32Array(ss);
    /* Kept because `nearestBox` answers in LATERAL terms — the AI steers by
       offset, and re-deriving a lateral from a world point would need a
       second spline.nearest() per query. */
    this.boxLat = new Float32Array(ls);
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
      vertexColors: true, roughness: 0.35, metalness: 0.15,
      /* Bright cyan, pulsed past the bloom threshold at the peak — the same
         trick the boost pads use, and the reason they read at range while the
         boxes did not. */
      emissive: 0x2fd8f0, emissiveIntensity: BOX_EMIT_LO,
    }));
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.castShadow = true; im.frustumCulled = false;
    this.group.add(im);
    this.boxMesh = im;
    this.boxMat = mat;

    /* A flat additive disc on the ground under each box. Three draw calls is
       the budget for this whole file and this is the third: it is what makes a
       ROW of boxes read as a row from 150 m, rather than four small cubes that
       resolve into anything at all only once you are on top of them. */
    const hgeo = this._keepGeo(new THREE.CircleGeometry(HALO_R, 18));
    hgeo.rotateX(-Math.PI / 2);
    const hmat = this._keepMat(new THREE.MeshBasicMaterial({
      color: 0x2fd8f0, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const halo = new THREE.InstancedMesh(hgeo, hmat, n);
    halo.frustumCulled = false; halo.renderOrder = 2;
    this.group.add(halo);
    this.boxHalo = halo;
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
     1b. BOOST PADS
     ------------------------------------------------------------
     Pure track data (contract 6.1 `pads[]`), which is why there is no
     placement search here and no seeded RNG: a pad is authored, a box is
     scattered. `x/y/z/dx/dz` are published by buildTrackData, but they are
     derived from `s`/`lat` and this module can derive them too — so a track
     that only carries the authored half still works.
     ============================================================ */
  _buildPads() {
    const src = this.data.pads || [];
    const n = src.length;
    this.nPad = n;
    this.padS = new Float32Array(n);
    this.padLat = new Float32Array(n);
    this.padX = new Float32Array(n);
    this.padY = new Float32Array(n);
    this.padZ = new Float32Array(n);
    this.padDX = new Float32Array(n);
    this.padDZ = new Float32Array(n);
    this.padHW = new Float32Array(n);
    this.padLen = new Float32Array(n);
    this.padMul = new Float32Array(n);
    this.padTop = new Float32Array(n);
    this.padTime = new Float32Array(n);
    this.padHit = new Float32Array(n);      // s of "just fired" glow left
    if (!n) { this.padMesh = null; return; }

    for (let i = 0; i < n; i++) {
      const p = src[i];
      const s = this.spline.wrapS(p.s || 0);
      const lat = p.lat || 0;
      this.padS[i] = s;
      this.padLat[i] = lat;
      let x = p.x, z = p.z;
      if (!(Number.isFinite(x) && Number.isFinite(z))) {
        const q = this.spline.offsetPoint(s, lat, _pp);
        x = q.x; z = q.z;
      }
      let dx = p.dx, dz = p.dz;
      if (!(Number.isFinite(dx) && Number.isFinite(dz))) {
        const d = this.spline.dirAt(s, _dd);
        dx = d.x; dz = d.z;
      }
      this.padX[i] = x;
      this.padZ[i] = z;
      // sit ON the road, not in it: the same 6 cm lift the oil decal uses
      this.padY[i] = this.terrain.heightAt(x, z) + 0.05;
      this.padDX[i] = dx; this.padDZ[i] = dz;
      this.padHW[i] = p.hw > 0 ? p.hw : PAD_HW;
      this.padLen[i] = p.len > 0 ? p.len : PAD_LEN;
      this.padMul[i] = p.mul > 0 ? p.mul : PAD_MUL;
      this.padTop[i] = p.top > 0 ? p.top : PAD_TOP;
      this.padTime[i] = p.time > 0 ? p.time : PAD_TIME;
    }

    const P = kitPalette(this.theme);
    const geo = this._keepGeo(boostPadGeo(P, 157));
    /* Emissive on the shared material rather than per-instance colour: one
       material, one draw call, and the pulse is a single uniform write. */
    this.padMat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.45, metalness: 0.20,
      emissive: 0x3a1c00, emissiveIntensity: 1.0,
    }));
    const im = new THREE.InstancedMesh(geo, this.padMat, n);
    im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false;
    this.padGroup.add(im);
    this.padMesh = im;

    for (let i = 0; i < n; i++) {
      _dummy.position.set(this.padX[i], this.padY[i], this.padZ[i]);
      _dummy.rotation.set(0, Math.atan2(this.padDX[i], this.padDZ[i]), 0);
      _dummy.scale.set(this.padHW[i] / PAD_GEO_HW, 1, this.padLen[i] / PAD_GEO_LEN);
      _dummy.updateMatrix();
      im.setMatrixAt(i, _dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
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
    /* Two rings, not one flat disc. A single dark plane on dark rock is
       invisible until you are on it, which makes the slick feel like bad luck
       rather than a hazard you failed to read: the pale rim gives it an EDGE
       and the lighter centre an iridescent sheen, so it reads as spilled oil
       on any of the five surfaces. */
    b.plane(shade(P.glass, -0.3), 5.2, 5.2, 0, 0, 0, -Math.PI / 2, 0, 0);
    b.plane(shade(P.glass, 0.45), 3.4, 3.4, 0, 0.012, 0, -Math.PI / 2, 0, 0);
    b.plane(shade(P.paintAlt, 0.25), 1.7, 1.7, 0, 0.02, 0, -Math.PI / 2, 0, 0);
    const hg = this._keepGeo(b.done());
    this.hazMat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.18, metalness: 0.35,
      transparent: true, opacity: 0.95, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3,
      side: THREE.DoubleSide,
    }));
    const him = new THREE.InstancedMesh(hg, this.hazMat, MAX_HAZ);
    him.castShadow = false; him.frustumCulled = false;
    this.group.add(him);
    this.hazMesh = him;

    /* One stretched cylinder, respanned per frame — three.js Line ignores
       linewidth on most platforms, so a "line" has to be geometry. */
    /* 0.11 m of radius is a thread at any distance the tow actually spans.
       Doubled, and lit, so the one item that visibly CONNECTS two cars looks
       like it is doing something. */
    const tg = this._keepGeo(new THREE.CylinderGeometry(0.11, 0.11, 1, 8).rotateX(Math.PI / 2));
    const tm = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x4fd07a, emissive: 0x3fbf6a, emissiveIntensity: 1.3, roughness: 0.4,
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

    /* ONE spline.nearest() per racer per frame, feeding BOTH the box trigger
       and the pad trigger. It has to happen out here rather than inside
       _stepBoxes because the pads run with the item layer switched off. */
    const wantNear = live && (this.enabled || this.nPad > 0);
    if (wantNear) {
      for (let i = 0; i < this.racers.length; i++) {
        const v = this.racers[i].vehicle;
        this.spline.nearest(v.pos.x, v.pos.z, this._near[i]);
      }
    }

    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i], s = this.st[i];

      if (this.enabled) {
        tickInv(s.inv, dt);
        if (s.inv.rollT > 0) {
          // Roulette: cosmetic only, so Math.random is allowed (house rule 6).
          s.rollTick -= dt;
          if (s.rollTick <= 0) { s.rollTick = 0.06; s.rollShown = (Math.random() * ITEMS.length) | 0; }
        } else {
          // The landing edge: was spinning last frame, is not now, and something
          // came out of it.
          if (s.rollShown >= 0 && hasItem(s.inv)) s.readySeq++;
          s.rollShown = -1;
        }

        if (s.boostT > 0) s.boostT -= dt;
        if (s.slowT > 0) s.slowT -= dt;
        if (s.ghostT > 0) s.ghostT -= dt;
        if (s.sledT > 0) this._stepSled(dt, r, s, i);
        else if (s.sledFlame) this._sledFlame(i, r, 0);
        if (s.towT > 0) this._stepTow(dt, r, s);
        for (let h = 0; h < MAX_HAZ; h++) if (s.hazImmune[h] > 0) s.hazImmune[h] -= dt;
        if (s.slowT > 0) this._stormWall(r);
      }

      // --- the pad layer, whatever the ITEMS setting says ---
      if (s.padCd > 0) s.padCd -= dt;
      if (s.padT > 0) { s.padT -= dt; if (s.padT < 0) s.padT = 0; }
      if (live && this.nPad) this._stepPads(i);

      this._applyMuls(i);
    }

    if (!live || !this.enabled) return;
    this._stepBoxes(dt);
    this._stepProjectiles(dt);
    this._stepHazards(dt);
  }

  /**
   * The one writer for `extDriveMul` / `extTopMul` — recomputed from scratch
   * so an effect can never accumulate (decision 3). Pads compose with items
   * rather than replacing them: a nitro over a pad is exactly as silly as it
   * sounds and exactly as rare.
   */
  _applyMuls(i) {
    const s = this.st[i], v = this.racers[i].vehicle;
    let fm = 1, tm = 1;
    if (this.enabled) {
      if (s.boostT > 0) { fm *= s.boostForce; tm *= s.boostTop; }
      if (s.slowT > 0) { fm *= ITEMS[ITEM.STORM].force; tm *= ITEMS[ITEM.STORM].top; }
      if (s.sledT > 0) { fm *= ITEMS[ITEM.SLED].force; tm *= ITEMS[ITEM.SLED].top; }
    }
    if (s.padT > 0) { fm *= s.padMul; tm *= s.padTop; }
    v.extDriveMul = fm;
    v.extTopMul = tm;
  }

  /**
   * Boost-pad trigger for one racer, off the arc length / lateral already
   * computed this frame. No distance test, no collider: a pad is a span of
   * road, and "am I on that span, within that many metres of its lat" is
   * exactly the same O(1) question the checkpoint test asks.
   */
  _stepPads(ri) {
    const r = this.racers[ri], s = this.st[ri], v = r.vehicle;
    if (r.finished) return;
    if (v.airborne) return;                       // a pad you fly over is scenery
    const near = this._near[ri];
    const L = this.lapLength;
    for (let i = 0; i < this.nPad; i++) {
      if (i === s.padLast && s.padCd > 0) continue;
      let d = near.s - this.padS[i];
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < -this.padLen[i] * 0.5 || d > this.padLen[i] * 0.5) continue;
      const dl = near.lat - this.padLat[i];
      if (dl < -this.padHW[i] || dl > this.padHW[i]) continue;
      s.padT = this.padTime[i];
      s.padMul = this.padMul[i];
      s.padTop = this.padTop[i];
      s.padLast = i;
      s.padCd = this.padTime[i] + PAD_CD;
      this.padHit[i] = 0.35;
      this.events.padSeq++;
      this.events.padRacer = ri;
      if (r.isPlayer) {
        this.audio.boostFire(2, 0.9);
        if (this.feel) { this.feel.kick(TUNE.boost.fireFov[1]); this.feel.addShake(0.16); }
      } else if (this._camNear(v, 70)) this.audio.boostFire(2, 0.35);
      if (this.vfx) {
        this.vfx.padFlash(this.padX[i], this.padY[i] + 0.05, this.padZ[i],
          this.padDX[i], this.padDZ[i]);
      }
      if (this.dust) {
        const f = v.forward;
        this.dust.spawn(3, v.pos.x - f.x * 1.5, v.pos.y - 0.12, v.pos.z - f.z * 1.5,
          3.2, 0.30, -f.x, -f.z, 1.0, 0.62, 0.20, DUST_KIND.EMBER);
      }
      return;                                     // one pad per frame per car
    }
  }

  _stepBoxes(dt) {
    for (let i = 0; i < this.nBox; i++) {
      if (this.boxT[i] > 0) { this.boxT[i] -= dt; if (this.boxT[i] < 0) this.boxT[i] = 0; }
    }
    if (!this.nBox) return;

    if (this._noteCd > 0) this._noteCd -= dt;
    for (let ri = 0; ri < this.racers.length; ri++) {
      const r = this.racers[ri], s = this.st[ri], v = r.vehicle;
      if (r.finished) continue;
      if (!canTake(s.inv)) {
        /* Driving through a box with a full slot does nothing, and the game
           never said why — which reads as "the boxes are broken". Player
           only, and rate-limited: this is a nudge, not a nag. */
        if (r.isPlayer && this._noteCd <= 0 && this._overABox(v, ri)) {
          this._noteCd = 2.0;
          this.events.noteSeq++;
          this.events.noteText = 'SLOT FULL — FIRE IT';
        }
        continue;
      }
      const near = this._near[ri];               // filled once, up in step()
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

  /** Is this car inside a live box's pickup volume? Same test the collect
      loop uses, factored out so the full-slot note cannot drift from it. */
  _overABox(v, ri) {
    const near = this._near[ri];
    const b0 = this.bucket[clamp(Math.floor(near.s / BUCKET), 0, this.bucket.length - 1)];
    for (let k = -1; k <= 4; k++) {
      const bi = b0 + k;
      if (bi < 0 || bi >= this.nBox || this.boxT[bi] > 0) continue;
      const dx = v.pos.x - this.boxX[bi], dz = v.pos.z - this.boxZ[bi];
      if (dx * dx + dz * dz > PICK_R * PICK_R) continue;
      const dy = v.pos.y - this.boxY[bi];
      if (dy * dy > PICK_Y * PICK_Y) continue;
      return true;
    }
    return false;
  }

  _collect(ri, bi) {
    const r = this.racers[ri], s = this.st[ri];
    this.boxT[bi] = BOX_RESPAWN;
    const id = rollItem(r.pos || this.racers.length, this.racers.length,
      this._ctxFor(r), this.rng);
    giveItem(s.inv, id, ROLL_TIME);
    this.stats.taken++;
    this.events.pickSeq++;
    this.events.pickRacer = ri;
    this.events.pickItem = id;
    if (r.isPlayer) {
      this.audio.itemRoll();
    }
    if (this.dust) {
      this.dust.burst(this.boxX[bi], this.boxY[bi], this.boxZ[bi], 0, 0.8, BOX_POP);
    }
    /* The box pops in the item's own colour — the pickup reads as "I got
       THAT" a beat before the roulette finishes saying so. */
    if (this.vfx) {
      const col = ITEMS[id] ? ITEMS[id].col : 0xffffff;
      this.vfx.sparks(16, this.boxX[bi], this.boxY[bi], this.boxZ[bi],
        0, 1, 0, 5.0, 1.0,
        ((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 0.55);
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

      /* Contract 6.2 reserves ribbon slots 0-7 for projectiles, which is
         exactly MAX_PROJ — so the pool index IS the slot and there is no
         allocation table to keep in step. */
      if (this.vfx) {
        const rb = this.vfx.ribbon(i);
        if (rb) rb.push(this.pX[i], this.pY[i], this.pZ[i]);
      }

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
        this._spin(ri, this.pSpin[i], this.pVX[i], this.pVZ[i], this.pOwner[i], ITEM.WHEEL);
        this._killProj(i);
        break;
      }
    }
  }

  _killProj(i) {
    if (this.vfx) {
      const rb = this.vfx.ribbon(i);
      /* fade(), not clear(): the trail should outlive the wheel by the width
         of the impact, which is the whole point of having drawn it. */
      if (rb) rb.fade();
    }
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
        this._spin(ri, def.spin, v.vel.x, v.vel.z, this.hOwner[i], ITEM.SLICK);
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
  _spin(ri, dur, dirX, dirZ, owner, item) {
    const r = this.racers[ri], v = r.vehicle;
    if (v.spinT >= dur) return;
    v.spinT = dur;
    this.events.hitSeq++;
    this.events.hitTarget = ri;
    this.events.hitOwner = owner === undefined ? -1 : owner;
    this.events.hitItem = item === undefined ? -1 : item;
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
    /* The ring reads at any distance and the sparks read close up, which is
       the same split racefx uses for a heavy contact. */
    if (this.vfx) {
      this.vfx.shock(v.pos.x, v.pos.y + 0.5, v.pos.z, 3.4, 1.0, 0.72, 0.28);
      this.vfx.sparks(22, v.pos.x, v.pos.y + 0.5, v.pos.z,
        dirX, 0.6, dirZ, 7.5, 1.1, 1.0, 0.66, 0.22, 0.5);
    }
  }

  /**
   * A wall of dust around a car inside a storm. Cheap and per-frame: eight
   * short-lived motes on a ring, so the effect is legible from outside the
   * car as well as from inside it (the `uBlind` uniform only ever reaches
   * the player).
   */
  _stormWall(r) {
    if (!this.dust) return;
    /* SMOKE BELONGS IN dust.js — vfx.js says so in its own header, and this
       was calling vfx.sparks() for it: four hot points, which at a glance is
       an electrical fault rather than a face full of grit. A ring of ochre
       PUFFs at 3 m is what being inside a dust cloud looks like. */
    const v = r.vehicle;
    const a = this._time * 3.1;
    for (let k = 0; k < 6; k++) {
      const th = a + k * (Math.PI / 3);
      const cx = Math.sin(th), cz = Math.cos(th);
      this.dust.spawn(1, v.pos.x + cx * 3.0, v.pos.y + 0.9, v.pos.z + cz * 3.0,
        1.6, 0.9, cx, cz, 0.72, 0.60, 0.42, DUST_KIND.PUFF);
    }
  }

  /**
   * The wall the storm actually is: a curtain of ochre dust thrown across the
   * road ahead of whoever fired it. Sited off the ROAD, not off the car, so it
   * spans the corridor rather than trailing one bumper.
   */
  _stormBurst(ri) {
    if (!this.dust) return;
    const near = this._near[ri];
    const s0 = near ? near.s : 0;
    const sp = this.spline;
    for (let k = 0; k < 40; k++) {
      const s = (s0 + 12 + (k % 8) * 3) % this.lapLength;
      sp.posAt(s, _sp2);
      sp.dirAt(s, _sd2);
      const nx = -_sd2.z, nz = _sd2.x;
      const w = sp.widthAt(s);
      const lat = ((k / 40) * 2 - 1) * w;
      this.dust.spawn(1, _sp2.x + nx * lat, _sp2.y + 0.6 + (k % 5) * 0.5, _sp2.z + nz * lat,
        2.4, 1.6, 0, 0, 0.74, 0.62, 0.44, DUST_KIND.PUFF);
    }
  }

  /** Light or douse the sled's exhaust plume. Ribbon slots 8-13, via flame(). */
  _sledFlame(ri, r, on) {
    const s = this.st[ri];
    if (!this.vfx) { s.sledFlame = on ? 1 : 0; return; }
    const v = r.vehicle, f = v.forward;
    this.vfx.flame(ri, on, v.pos.x - f.x * 1.8, v.pos.y - 0.05, v.pos.z - f.z * 1.8,
      -f.x, 0.12, -f.z, 3);
    s.sledFlame = on ? 1 : 0;
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
  _stepSled(dt, r, s, ri) {
    s.sledT -= dt;
    s.ghostT = Math.max(s.ghostT, 0.05);   // stays ghosted for the whole ride
    if (s.sledT <= 0 || r.finished || (r.pos && r.pos <= ITEMS[ITEM.SLED].releaseAt)) {
      s.sledT = 0; s.ghostT = 0;
      if (s.sledFlame) this._sledFlame(ri, r, 0);
      return;
    }
    this._sledFlame(ri, r, 1);
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
    /* Contract 6.4: every ctl copy site carries `roll`. A sled that inherited
       the last roll input the AI wrote would barrel-roll down the road. */
    ctl.roll = 0;
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
    /* The slot is empty again, so the last pickup is no longer news. Leaving
       `pickItem` set would have the HUD's item strip and the AI both reading
       a held item that has just been thrown. */
    this.events.pickRacer = -1;
    this.events.pickItem = -1;
    const v = r.vehicle;
    this.events.fireSeq++;
    this.events.fireRacer = ri;
    this.events.fireItem = def.id;
    this.events.fireNear = !r.isPlayer && this._camNear(v, FIRE_LOG_D);

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
        if (r.isPlayer || this._camNear(v, FIRE_HEAR_D)) this.audio.itemThrow(r.isPlayer ? 1 : 0.4);
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
        if (r.isPlayer || this._camNear(v, FIRE_HEAR_D)) this.audio.itemDrop(r.isPlayer ? 1 : 0.4);
        break;
      }
      case 'tow': {
        const ti = this._findTarget(r, def);
        if (ti < 0) {
          this._boost(ri, ITEMS[ITEM.NITRO]);   // never waste a pickup
          /* …but say so. Silently turning into a different item is the sort
             of thing that makes a system feel broken rather than generous. */
          if (r.isPlayer) {
            this.events.noteSeq++;
            this.events.noteText = 'NO LOCK — NITRO INSTEAD';
          }
          break;
        }
        s.towT = def.time; s.towTarget = ti;
        if (this.vfx) {
          const tv = this.racers[ti].vehicle;
          this.vfx.sparks(14, tv.pos.x, tv.pos.y + 0.5, tv.pos.z, 0, 1, 0, 5.0, 1.0,
            0.31, 0.82, 0.48, 0.8);
        }
        /* A tow never routes through _spin, so without this the only two
           effects in the roster that take time off somebody else would be
           invisible to every events reader. */
        this._noteHit(ti, ri, def.id);
        if (r.isPlayer || this._camNear(v, FIRE_HEAR_D)) this.audio.towSnap(r.isPlayer ? 1 : 0.4);
        break;
      }
      case 'sled':
        s.sledT = def.time;
        s.ghostT = def.time;
        this._sledFlame(ri, r, 1);
        if (r.isPlayer) {
          this.audio.sledLaunch();
          if (this.feel) { this.feel.kick(3); this.feel.addShake(0.4); }
        }
        break;
      case 'storm': {
        this._stormBurst(ri);
        const myPos = r.pos || this.racers.length;
        for (let i = 0; i < this.racers.length; i++) {
          const o = this.racers[i];
          if (o === r || o.finished) continue;
          if ((o.pos || 99) >= myPos) continue;         // only those AHEAD
          this.st[i].slowT = Math.max(this.st[i].slowT, def.time);
          this._noteHit(i, ri, def.id);
          if (o.isPlayer) this.blindT = def.time;
        }
        this.audio.stormHit(r.isPlayer ? 1 : 0.5);
        if (r.isPlayer) {
          /* The one item whose whole effect happens to OTHER people. Without
             this the player fires it, nothing visibly changes, and it reads as
             a dud — which is precisely what QA reported. */
          this.events.noteSeq++;
          this.events.noteText = 'DUST STORM — EVERYONE AHEAD IS BLINDED';
        }
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
    const t = this._time;

    /* Pads first, and OUTSIDE the enabled gate — see decision 6. The pulse
       is one shared uniform rather than per-instance colour: the chevrons
       already carry the direction, all this has to do is breathe. */
    if (this.padMesh) {
      let flash = 0;
      for (let i = 0; i < this.nPad; i++) {
        if (this.padHit[i] > 0) {
          this.padHit[i] -= dt;
          if (this.padHit[i] < 0) this.padHit[i] = 0;
          if (this.padHit[i] > flash) flash = this.padHit[i];
        }
      }
      this.padMat.emissiveIntensity =
        0.85 + 0.45 * Math.sin(t * 3.4) + 2.6 * flash;
    }

    if (!this.enabled) return;

    if (this.boxMesh) {
      // One pulse for the whole row: an instanced material has one uniform.
      if (this.boxMat) {
        this.boxMat.emissiveIntensity =
          BOX_EMIT_LO + (BOX_EMIT_HI - BOX_EMIT_LO) * (0.5 + 0.5 * Math.sin(t * 3.0));
      }
      for (let i = 0; i < this.nBox; i++) {
        const cd = this.boxT[i];
        /* Scale, not a teleport to 0.0001. A box that vanishes between two
           frames does not read as "you got that" — it reads as a glitch, and
           the shrink is the only confirmation the world gives you. */
        const live = cd <= 0;
        const since = BOX_RESPAWN - cd;          // s since it was collected
        let k = 1;
        if (!live) {
          if (since < BOX_POP_T) k = 1 - since / BOX_POP_T;      // shrink away
          else if (cd < BOX_IN_T) k = 1 - cd / BOX_IN_T;         // scale back in
          else k = 0;
        }
        k = Math.max(0.0001, Math.min(1, k));
        _dummy.position.set(this.boxX[i],
          this.boxY[i] + (live ? Math.sin(t * 1.8 + i * 1.7) * BOX_BOB : 0), this.boxZ[i]);
        _dummy.rotation.set(0, t * BOX_SPIN + i * 0.9, 0);
        _dummy.scale.setScalar(k * BOX_SCALE);
        _dummy.updateMatrix();
        this.boxMesh.setMatrixAt(i, _dummy.matrix);

        if (this.boxHalo) {
          const hk = live ? (0.85 + 0.15 * Math.sin(t * 3.0 + i * 1.3)) : 0.0001;
          _dummy.position.set(this.boxX[i], this.boxY[i] - BOX_HOVER + 0.06, this.boxZ[i]);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.setScalar(hk);
          _dummy.updateMatrix();
          this.boxHalo.setMatrixAt(i, _dummy.matrix);
        }
      }
      this.boxMesh.instanceMatrix.needsUpdate = true;
      if (this.boxHalo) this.boxHalo.instanceMatrix.needsUpdate = true;
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
    /* The rest of hud.js's §6.6 contract, which nothing had ever filled in.
       `seq` bumps when the ROULETTE LANDS, not when the box is taken: the
       HUD deliberately swallows a seq change while `rolling` is true, so a
       pickup-time bump produced no banner at all — which is why the callout
       has never been seen. */
    out.seq = s.readySeq;
    out.icon = def ? (def.icon || '') : '';
    out.use = def ? (def.use || 'FIRE') : '';
    out.hint = def ? (def.hint || '') : '';
    return out;
  }

  isGhost(ri) { return this.enabled && this.st[ri].ghostT > 0; }
  isSledding(ri) { return this.enabled && this.st[ri].sledT > 0; }
  hasItem(ri) { return this.enabled && hasItem(this.st[ri].inv) && this.st[ri].inv.rollT <= 0; }
  itemOf(ri) { const s = this.st[ri]; return s.inv.rollT > 0 ? ITEM.NONE : s.inv.id; }

  /** One place that stamps a "somebody took a hit" event. */
  _noteHit(target, owner, item) {
    this.events.hitSeq++;
    this.events.hitTarget = target;
    this.events.hitOwner = owner;
    this.events.hitItem = item;
  }

  /* ============================================================
     6b. THE READ-ONLY VIEW (contract 6.7)
     ------------------------------------------------------------
     Everything below is what a driver is allowed to know. All of it is
     CALLER-OWNED-BUFFER: the AI hands in its own typed arrays and gets them
     filled, so six drivers polling every frame allocate nothing between
     them and none of them can hold a reference into our state.

     Read-only means read-only. Nothing here returns a live object, and no
     path from `ctx.items` reaches a setter.
     ============================================================ */

  /**
   * Live projectiles and hazards, nearest-first is NOT guaranteed — the
   * caller filters by its own geometry anyway.
   * @param out { n, x, z, vx, vz, r, kind } of parallel typed arrays
   */
  threats(out) {
    let n = 0;
    const cap = out.x.length;
    if (this.enabled) {
      for (let i = 0; i < MAX_PROJ && n < cap; i++) {
        if (this.pLife[i] <= 0) continue;
        out.x[n] = this.pX[i]; out.z[n] = this.pZ[i];
        out.vx[n] = this.pVX[i]; out.vz[n] = this.pVZ[i];
        out.r[n] = THREAT_R_PROJ; out.kind[n] = THREAT_PROJ; n++;
      }
      for (let i = 0; i < MAX_HAZ && n < cap; i++) {
        if (this.hLife[i] <= 0) continue;
        out.x[n] = this.hX[i]; out.z[n] = this.hZ[i];
        out.vx[n] = 0; out.vz[n] = 0;
        out.r[n] = THREAT_R_HAZ; out.kind[n] = THREAT_HAZ; n++;
      }
    }
    out.n = n;
    return out;
  }

  /**
   * Nearest uncollected box AHEAD of racer `ri`, as an arc-length distance
   * and the LATERAL the AI would have to hold to take it. Boxes come in
   * rows at one `s`, so the row is found first and the lane inside it
   * second — otherwise a car would be sent at whichever box of the row
   * happened to be built first.
   */
  nearestBox(ri, out) {
    out.found = 0; out.dist = -1; out.s = 0; out.lat = 0; out.x = 0; out.z = 0;
    if (!this.enabled || !this.nBox) return out;
    const near = this._near[ri], L = this.lapLength;
    let bd = Infinity;
    for (let i = 0; i < this.nBox; i++) {
      if (this.boxT[i] > 0) continue;
      let d = this.boxS[i] - near.s;
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < 0) continue;
      if (d < bd) bd = d;
    }
    if (!(bd < Infinity)) return out;
    let bi = -1, bl = Infinity;
    for (let i = 0; i < this.nBox; i++) {
      if (this.boxT[i] > 0) continue;
      let d = this.boxS[i] - near.s;
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < 0 || d > bd + 1) continue;          // same row, 1 m of slop
      const dl = Math.abs(this.boxLat[i] - near.lat);
      if (dl < bl) { bl = dl; bi = i; }
    }
    if (bi < 0) return out;
    out.found = 1; out.dist = bd; out.s = this.boxS[bi]; out.lat = this.boxLat[bi];
    out.x = this.boxX[bi]; out.z = this.boxZ[bi];
    return out;
  }

  /** Nearest boost pad ahead of racer `ri`. Same shape as `nearestBox`. */
  nearestPad(ri, out) {
    out.found = 0; out.dist = -1; out.s = 0; out.lat = 0; out.x = 0; out.z = 0;
    if (!this.nPad) return out;
    const s = this.st[ri];
    // a pad already burning under this car is not a pad to steer at
    if (s.padCd > 0) return out;
    const near = this._near[ri], L = this.lapLength;
    let bd = Infinity, bi = -1;
    for (let i = 0; i < this.nPad; i++) {
      let d = this.padS[i] - near.s;
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < 0) continue;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return out;
    out.found = 1; out.dist = bd; out.s = this.padS[bi]; out.lat = this.padLat[bi];
    out.x = this.padX[bi]; out.z = this.padZ[bi];
    return out;
  }

  /**
   * Would a tow line fired right now find something? The AI's own rival scan
   * cannot answer this: the lock uses the item's cone and window, and
   * `fire()` silently converts a missed tow into a nitro — a waste dressed
   * up as a mercy, and one the AI should decline rather than trigger.
   */
  canLock(ri) {
    if (!this.enabled) return false;
    const r = this.racers[ri];
    if (!r || r.finished) return false;
    return this._findTarget(r, ITEMS[ITEM.TOW]) >= 0;
  }

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
    /* A pad boost belongs to a piece of road the car is no longer on. The
       cooldown goes too, or a respawn onto a pad would be dead to it. */
    s.padT = 0; s.padCd = 0; s.padMul = 1; s.padTop = 1; s.padLast = -1;
    if (s.sledFlame) this._sledFlame(ri, this.racers[ri], 0);
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
      if (this.st[i].sledFlame) this._sledFlame(i, this.racers[i], 0);
      this._clearState(this.st[i]);
      const v = this.racers[i].vehicle;
      v.extDriveMul = 1; v.extTopMul = 1; v.spinT = 0;
    }
    for (let i = 0; i < MAX_PROJ; i++) this._killProj(i);
    this.hLife.fill(0); this.hOwner.fill(-1);
    this.boxT.fill(0);
    if (this.padHit) this.padHit.fill(0);
    this.blindT = 0;
    this._noteCd = 0;
    this.stats.fired = 0; this.stats.hits = 0; this.stats.taken = 0;
    const e = this.events;
    e.hitSeq = 0; e.hitTarget = -1; e.hitOwner = -1; e.hitItem = -1;
    e.pickSeq = 0; e.pickRacer = -1; e.pickItem = -1;
    e.padSeq = 0; e.padRacer = -1;
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

  /* Hides the ITEM group only. `padGroup` is deliberately untouched and the
     multipliers go through _applyMuls, which keeps a live pad boost — a
     stage's boost pads are not a power-up (decision 6). */
  _hideAll() {
    this.group.visible = false;
    for (let i = 0; i < this.st.length; i++) this._applyMuls(i);
  }

  dispose() {
    this.resetAll();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    if (this.padGroup.parent) this.padGroup.parent.remove(this.padGroup);
    this.padGroup.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
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

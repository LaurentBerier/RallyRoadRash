/* ============================================================
   IMPACT VFX
   ------------------------------------------------------------
   dust.js is the world's own material: ground thrown off a tyre, lit by the
   sun, hiding what is behind it. This file is the opposite — everything that
   is made of ENERGY rather than of dirt, and every bit of it additive:

     • sparks     a panel scraped along rock, a shell going off, a landing
     • confetti   the finish line, and nothing else
     • rings      the pressure front of a hit, the flash of a boost pad
     • ribbons    the trail behind a projectile and the flame off a boost

   THE THREE DRAW CALLS
   --------------------
   That is the entire budget and it is a hard one, because this layer fires
   while six cars are on screen and the frame is already paying for a
   clipmap, a shadow pass and a bloom chain. So:

     1. ONE additive Points pool for every particle in the file, sized by
        tier (400 / 900 / 1600 / 2400) and sharing one sprite sheet.
     2. ONE mesh for all fourteen ribbons — eight projectile slots and six
        racer flames, fixed slots, fixed index buffer, rebuilt on the CPU
        each frame into a buffer that never grows.
     3. ONE InstancedMesh of rings.

   And no fourth: SMOKE IS NOT A NEW SYSTEM. A dark puff is
   dust.spawn(..., PUFF) with a dark colour, which already has drag, wind,
   ground contact and the right lighting. Adding a smoke pool here would be
   a second answer to a solved problem and a fourth draw call.

   Nothing here allocates after the constructor. Math.random() IS allowed —
   every number in this file is cosmetic and none of it is ever read back by
   the simulation, so a race stays reproducible with the sparks on.
   ============================================================ */
import * as THREE from 'three';
import { G } from '../game/config.js';
import { clamp } from '../core/rng.js';
import { makeVfxAtlas, VFX_TILE } from './textures.js';
import { DUST_KIND } from './dust.js';

/* Pool size per quality tier, straight off QUALITY.name. */
const TIER_POOL = { LOW: 400, MEDIUM: 900, HIGH: 1600, ULTRA: 2400 };

/* ---------------- ribbons ---------------- */
export const RIB_SLOTS = 14;         // 0-7 projectiles, 8-13 racer flames
const RIB_PTS = 16;                  // spine points per ribbon
const RIB_LIFE = 0.34;               // s before a spine point is dropped
const RIB_STEP = 0.30;               // m — closer than this and the head moves
const RIB_W = 0.42;                  // m — half-width at the head

/* ---------------- rings ---------------- */
const RING_MAX = 24;

/* Boost-flame colour by mini-turbo tier. Blue, orange, violet: the same
   escalation every kart racer has used since 1996, because it works — the
   hue tells you the tier before the number does. Values are above 1 on
   purpose, so a flame clears the bloom threshold and the glow is real. */
const FLAME_COL = [
  [0.55, 0.85, 1.70],
  [1.70, 0.86, 0.28],
  [1.55, 0.42, 1.55],
];

/* How hard the additive layer has to push to read against each sky. A noon
   airfield eats a spark that a caldera dusk would blow out. */
const THEME_GAIN = {
  training: 1.30, canyon: 1.10, forest: 1.15, volcano: 0.85, thunder: 0.95
};

/* ---------------- module scratch: nothing below allocates ---------------- */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _col = new THREE.Color();

export class VFX {
  /**
   * @param scene    scene to attach to
   * @param dust     world/dust.js Dust — the smoke half of every impact
   * @param quality  a QUALITY tier object from core/engine.js
   * @param theme    a sky theme id, for the additive gain
   */
  constructor(scene, dust, quality, theme = 'training') {
    this.scene = scene;
    this.dust = dust || null;
    this.quality = quality || null;
    this.MAX = TIER_POOL[(quality && quality.name) || 'HIGH'] || TIER_POOL.HIGH;
    this.n = 0;

    this.atlas = makeVfxAtlas(128);
    this._buildPoints();
    this._buildRibbons();
    this._buildRings();
    this.setTheme(theme);
  }

  /* ============================================================
     1.  THE PARTICLE POOL
     ============================================================ */
  _buildPoints() {
    this._allocPoints(this.MAX, 0);
    const g = this.pGeo = new THREE.BufferGeometry();
    this._bindPoints();
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.pMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTex: { value: this.atlas },
        uGain: { value: 1.0 },
        uTime: { value: 0 },
        uViewH: { value: 1080 },
        uMaxPx: { value: 420 }
      },
      vertexShader: /* glsl */`
        attribute vec3 aVel, aCol, aParam;      // aParam = (sizeMetres, tile, spin)
        attribute float aLife, aSeed;
        varying vec3 vCol; varying vec2 vTile;
        varying float vL, vAng, vStretch;
        uniform float uTime, uViewH, uMaxPx;
        void main(){
          vCol = aCol; vL = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 vv = (viewMatrix * vec4(aVel, 0.0)).xyz;
          // Only the STREAK tile stretches along its travel; a spark is a
          // point of light and a confetto tumbles on its own axis.
          float isStreak = step(2.5, aParam.y);
          vStretch = mix(1.0, clamp(1.0 + length(vv.xy) * 0.055, 1.0, 3.4), isStreak);
          vAng = mix(aSeed * 6.2832 + aParam.z * uTime, atan(vv.y, vv.x + 1e-6), isStreak);
          vTile = vec2(mod(aParam.y, 2.0), floor(aParam.y * 0.5)) * 0.5;
          // metres -> pixels straight out of the projection, same as dust.js
          float px = projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.30);
          gl_PointSize = clamp(aParam.x * px * sqrt(vStretch), 1.0, uMaxPx);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying vec3 vCol; varying vec2 vTile;
        varying float vL, vAng, vStretch;
        uniform sampler2D uTex; uniform float uGain;
        void main(){
          vec2 pc = gl_PointCoord - 0.5;
          float c = cos(vAng), s = sin(vAng);
          pc = mat2(c, s, -s, c) * pc;
          pc.x /= vStretch;
          // every tile fades to zero alpha at its border, so a rotated corner
          // samples the gutter and discards
          vec2 uv = clamp(pc + 0.5, 0.0, 1.0) * 0.5 + vTile;
          vec4 t = texture2D(uTex, uv);
          if (t.a < 0.008) discard;
          // additive: alpha is the WEIGHT, the colour is the energy. Sparks
          // die on a curve rather than linearly — a hot particle dims fast
          // and then lingers, which is what a cooling ember actually does.
          float fade = pow(clamp(vL, 0.0, 1.0), 0.75);
          gl_FragColor = vec4(vCol * t.rgb * uGain, t.a * fade);
        }`
    });

    this.points = new THREE.Points(this.pGeo, this.pMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;          // above dust, below nothing
    this.scene.add(this.points);
  }

  _allocPoints(max, keep) {
    const grow = (old, stride) => {
      const a = new Float32Array(max * stride);
      if (old && keep) a.set(old.subarray(0, keep * stride));
      return a;
    };
    this.pos = grow(this.pos, 3);        // uploaded
    this.vel = grow(this.vel, 3);        // uploaded (drives the streak)
    this.col = grow(this.col, 3);        // uploaded
    this.par = grow(this.par, 3);        // uploaded: size, tile, spin
    this.nrm = grow(this.nrm, 1);        // uploaded: life remaining 0..1
    this.sed = grow(this.sed, 1);        // uploaded
    this.life = grow(this.life, 1);
    this.maxLife = grow(this.maxLife, 1);
    this.drag = grow(this.drag, 1);
    this.gy = grow(this.gy, 1);
  }

  _bindPoints() {
    const g = this.pGeo;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aParam', new THREE.BufferAttribute(this.par, 3));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.nrm, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.sed, 1));
  }

  /** One particle into the pool. Silently dropped when full — a spark that
      does not exist is always better than one that costs a frame. */
  _emit(x, y, z, vx, vy, vz, size, tile, r, g, b, life, drag, gy, spin) {
    if (this.n >= this.MAX) return;
    const i = this.n++, i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.par[i3] = size; this.par[i3 + 1] = tile; this.par[i3 + 2] = spin;
    this.sed[i] = Math.random();
    this.life[i] = life; this.maxLife[i] = life; this.nrm[i] = 1;
    this.drag[i] = drag; this.gy[i] = gy;
  }

  /* ============================================================
     2.  RIBBONS
     ------------------------------------------------------------
     Fourteen fixed slots in one buffer. Fixed, not pooled, because a
     projectile and a racer both want a trail that persists across frames
     and is addressed by identity — "slot 3's trail", not "a trail". The
     index buffer is built once and never touched; an empty slot collapses
     to a degenerate strip and draws nothing.
     ============================================================ */
  _buildRibbons() {
    const NV = RIB_SLOTS * RIB_PTS * 2;
    this.rPos = new Float32Array(NV * 3);
    this.rCol = new Float32Array(NV * 3);
    this.rPar = new Float32Array(NV * 2);      // (taper 1..0 head->tail, side -1/+1)
    const idx = new Uint16Array(RIB_SLOTS * (RIB_PTS - 1) * 6);
    let o = 0;
    for (let s = 0; s < RIB_SLOTS; s++) {
      const vb = s * RIB_PTS * 2;
      for (let i = 0; i < RIB_PTS - 1; i++) {
        const a = vb + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx[o++] = a; idx[o++] = b; idx[o++] = c;
        idx[o++] = b; idx[o++] = d; idx[o++] = c;
      }
    }

    const g = this.rGeo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rPos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.rCol, 3));
    g.setAttribute('aParam', new THREE.BufferAttribute(this.rPar, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.rMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uGain: { value: 1.0 } },
      vertexShader: /* glsl */`
        attribute vec3 aCol; attribute vec2 aParam;
        varying vec3 vCol; varying vec2 vP;
        void main(){
          vCol = aCol; vP = aParam;
          gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying vec3 vCol; varying vec2 vP;
        uniform float uGain;
        void main(){
          // taper down the length, soft across the width, hottest at the head
          float a = vP.x * vP.x * (1.0 - vP.y * vP.y);
          if (a < 0.004) discard;
          gl_FragColor = vec4(vCol * (0.55 + 0.45 * vP.x) * uGain, a);
        }`
    });

    this.ribbonMesh = new THREE.Mesh(this.rGeo, this.rMat);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.renderOrder = 6;
    this.scene.add(this.ribbonMesh);

    /* Per-slot state, flat so nothing here is an object allocation. `pts` is
       a ring of (x, y, z, age) with `head` pointing at the newest sample. */
    this.rPts = new Float32Array(RIB_SLOTS * RIB_PTS * 4);
    this.rHead = new Int32Array(RIB_SLOTS);
    this.rCount = new Int32Array(RIB_SLOTS);
    this.rFade = new Uint8Array(RIB_SLOTS);
    // whether this slot's VERTICES currently hold a live strip — the flag
    // that says a dead slot still owes the buffer one degenerate write
    this.rLive = new Uint8Array(RIB_SLOTS);
    this.rTint = new Float32Array(RIB_SLOTS * 3);
    this.rWide = new Float32Array(RIB_SLOTS);
    for (let s = 0; s < RIB_SLOTS; s++) {
      this.rHead[s] = -1;
      this.rTint[s * 3] = 1.4; this.rTint[s * 3 + 1] = 1.0; this.rTint[s * 3 + 2] = 0.5;
      this.rWide[s] = RIB_W;
      this.rLive[s] = 1;                 // force the first frame to wipe them
    }

    /* The handles callers hold. Built once: ribbon(id) hands back the SAME
       object every time, so a projectile can keep its handle for its whole
       flight without this file allocating per call. */
    this._handles = [];
    for (let s = 0; s < RIB_SLOTS; s++) this._handles.push(makeHandle(this, s));
  }

  /**
   * The trail for one fixed slot: 0–7 projectiles, 8–13 racer flames.
   * @returns {{push:Function, fade:Function, clear:Function}} always the same
   *   object for a given id.
   *
   * `push(x, y, z)` extends the trail. The optional (r, g, b) tail sets the
   * slot's colour — 3-argument callers keep whatever colour it had.
   */
  ribbon(id) { return this._handles[clamp(id | 0, 0, RIB_SLOTS - 1)]; }

  _ribPush(s, x, y, z, r, g, b) {
    if (r !== undefined) {
      const o = s * 3;
      this.rTint[o] = r; this.rTint[o + 1] = g; this.rTint[o + 2] = b;
    }
    this.rFade[s] = 0;
    const P = this.rPts, base = s * RIB_PTS * 4;
    let h = this.rHead[s];
    if (h >= 0) {
      const o = base + h * 4;
      const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2];
      // Below a step the HEAD moves instead of a new sample landing on top
      // of the last one: a stationary emitter would otherwise chew through
      // the whole ring in a quarter of a second and the trail would vanish.
      if (dx * dx + dy * dy + dz * dz < RIB_STEP * RIB_STEP) {
        P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = 0;
        return;
      }
    }
    h = (h + 1) % RIB_PTS;
    this.rHead[s] = h;
    const o = base + h * 4;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = 0;
    if (this.rCount[s] < RIB_PTS) this.rCount[s]++;
  }

  _ribClear(s) {
    this.rCount[s] = 0; this.rHead[s] = -1; this.rFade[s] = 0;
  }

  /* ============================================================
     3.  RINGS
     ============================================================ */
  _buildRings() {
    /* A quad lying flat in XZ, UV-mapped onto the atlas's RING quadrant, so
       the whole thing is a plain MeshBasicMaterial with an instance colour —
       no custom shader, and additive fade-out costs nothing but the colour
       going to black. */
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * 0.5, uv.getY(i) * 0.5 + 0.5);
    }
    this.ringGeo = geo;
    this.ringMat = new THREE.MeshBasicMaterial({
      map: this.atlas, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      toneMapped: false, fog: false
    });
    const im = this.rings = new THREE.InstancedMesh(this.ringGeo, this.ringMat, RING_MAX);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_MAX * 3), 3);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.renderOrder = 6;
    im.count = 0;
    this.scene.add(im);

    // live ring state, dense, swap-removed
    this.kN = 0;
    this.kPos = new Float32Array(RING_MAX * 3);
    this.kCol = new Float32Array(RING_MAX * 3);
    this.kGeom = new Float32Array(RING_MAX * 4);   // r0, r1, yaw, aspect
    this.kT = new Float32Array(RING_MAX);
    this.kLife = new Float32Array(RING_MAX);
  }

  _ring(x, y, z, r0, r1, yaw, aspect, life, r, g, b) {
    // Full is full: the oldest ring is the one nobody is looking at.
    let i = this.kN;
    if (i >= RING_MAX) {
      let worst = 0, best = -1;
      for (let k = 0; k < RING_MAX; k++) {
        const f = this.kT[k] / this.kLife[k];
        if (f > worst) { worst = f; best = k; }
      }
      i = best < 0 ? 0 : best;
    } else this.kN++;
    const i3 = i * 3, i4 = i * 4;
    this.kPos[i3] = x; this.kPos[i3 + 1] = y; this.kPos[i3 + 2] = z;
    this.kCol[i3] = r; this.kCol[i3 + 1] = g; this.kCol[i3 + 2] = b;
    this.kGeom[i4] = r0; this.kGeom[i4 + 1] = r1;
    this.kGeom[i4 + 2] = yaw; this.kGeom[i4 + 3] = aspect;
    this.kT[i] = 0; this.kLife[i] = life;
  }

  /* ============================================================
     4.  THE PUBLIC EFFECTS
     ============================================================ */

  /**
   * A shower of sparks in a cone.
   * @param n        how many
   * @param x,y,z    origin
   * @param dx,dy,dz cone axis (need not be normalised; zero = omnidirectional)
   * @param speed    m/s scale
   * @param spread   cone half-angle in radians
   * @param r,g,b    linear colour, above 1 to clear the bloom threshold
   * @param life     seconds
   */
  sparks(n, x, y, z, dx, dy, dz, speed, spread, r, g, b, life) {
    const L = Math.hypot(dx, dy, dz);
    const ax = L > 1e-5 ? dx / L : 0, ay = L > 1e-5 ? dy / L : 1, az = L > 1e-5 ? dz / L : 0;
    // one orthonormal frame for the whole burst
    const up = Math.abs(ay) > 0.94 ? 0 : 1;
    _v1.set(ax, ay, az);
    _v2.set(up, 1 - up, 0).cross(_v1).normalize();
    _v3.copy(_v1).cross(_v2).normalize();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.2832;
      const t = Math.tan(spread * Math.sqrt(Math.random()));
      const cx = Math.cos(a) * t, cy = Math.sin(a) * t;
      const sp = speed * (0.45 + Math.random() * 0.95);
      const vx = (ax + _v2.x * cx + _v3.x * cy) * sp;
      const vy = (ay + _v2.y * cx + _v3.y * cy) * sp;
      const vz = (az + _v2.z * cx + _v3.z * cy) * sp;
      const hot = 0.75 + Math.random() * 0.55;
      this._emit(x, y, z, vx, vy, vz,
        0.05 + Math.random() * 0.09, VFX_TILE.SPARK,
        r * hot, g * hot, b * hot,
        life * (0.55 + Math.random() * 0.75), 0.10, 0.85, 0);
    }
  }

  /** Paper, at the finish line. Slow, tumbling, gravity-bound, five colours. */
  confetti(n, x, y, z, spread) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.2832;
      const rr = spread * Math.sqrt(Math.random());
      const h = 0.35 + Math.random() * 0.65;
      const k = (Math.random() * 5) | 0;
      // saturated primaries: at a distance, confetti IS its colour
      const cr = k === 0 ? 1.5 : k === 1 ? 0.25 : k === 2 ? 1.5 : k === 3 ? 0.30 : 1.4;
      const cg = k === 0 ? 0.30 : k === 1 ? 1.3 : k === 2 ? 1.2 : k === 3 ? 1.1 : 1.4;
      const cb = k === 0 ? 0.35 : k === 1 ? 0.55 : k === 2 ? 0.20 : k === 3 ? 1.5 : 1.4;
      this._emit(x + Math.cos(a) * rr, y + Math.random() * 1.2, z + Math.sin(a) * rr,
        Math.cos(a) * (0.8 + Math.random() * 2.6), 2.4 + Math.random() * 3.6 * h,
        Math.sin(a) * (0.8 + Math.random() * 2.6),
        0.13 + Math.random() * 0.10, VFX_TILE.CONFETTI,
        cr, cg, cb,
        2.6 + Math.random() * 2.2, 0.62, 0.28,
        (5 + Math.random() * 9) * (Math.random() < 0.5 ? -1 : 1));
    }
  }

  /**
   * The pressure front of a hit: one expanding ring on the ground, a fan of
   * sparks, and — through dust.js, not through a pool of its own — the dark
   * puff that makes it read as an impact rather than a firework.
   */
  shock(x, y, z, radius, r, g, b) {
    this._ring(x, y + 0.10, z, radius * 0.16, radius, Math.random() * 3.14, 1, 0.42, r, g, b);
    this.sparks(10, x, y + 0.3, z, 0, 1, 0, radius * 3.6, 1.15, r, g, b, 0.42);
    if (this.dust) {
      // dark, slow, and it hangs — the difference between a bang and a bloom
      this.dust.spawn(6, x, y + 0.2, z, radius * 1.5, radius * 0.45, 0, 0,
        0.13, 0.11, 0.10, DUST_KIND.PUFF);
    }
  }

  /**
   * A boost pad going off under a car. Stretched along the pad's own
   * direction, because a circular flash on a rectangular pad reads as a
   * decal that missed.
   */
  padFlash(x, y, z, dx, dz) {
    const yaw = Math.atan2(dx, dz);
    this._ring(x, y + 0.09, z, 1.3, 3.4, yaw, 1.9, 0.34, 0.55, 1.35, 1.9);
    this.sparks(9, x, y + 0.25, z, dx, 0.85, dz, 9.5, 0.42, 0.55, 1.30, 1.85, 0.36);
  }

  /**
   * The flame off one racer's exhaust, tier-coloured.
   * @param ri    racer index 0..5 (slots 8..13)
   * @param on01  0 = off (the trail fades out), 1 = full
   * @param x,y,z emitter in world space
   * @param dx,dy,dz  the direction the flame points (usually −forward)
   * @param tier  mini-turbo tier 1..3
   */
  flame(ri, on01, x, y, z, dx, dy, dz, tier) {
    const s = 8 + clamp(ri | 0, 0, RIB_SLOTS - 9);
    if (!(on01 > 0.02)) { this.rFade[s] = 1; return; }
    const c = FLAME_COL[clamp((tier | 0) - 1, 0, 2)];
    const k = clamp(on01, 0, 1);
    this.rWide[s] = RIB_W * (0.55 + 0.75 * k);
    const L = Math.hypot(dx, dy, dz) || 1;
    this._ribPush(s, x + dx / L * 0.35, y + dy / L * 0.35, z + dz / L * 0.35,
      c[0] * k, c[1] * k, c[2] * k);
    // a couple of embers off the tip, so the flame sheds rather than ending
    if (Math.random() < 0.55 * k) {
      this.sparks(1, x, y, z, dx, dy + L * 0.35, dz, 5.5 * k, 0.55,
        c[0], c[1], c[2], 0.30);
    }
  }

  /* ============================================================
     5.  FRAME
     ============================================================ */
  update(dt, camera) {
    if (dt <= 0) return;
    const ut = this.pMat.uniforms.uTime;
    ut.value = (ut.value + dt) % 1024;

    this._stepPoints(dt);
    this._stepRibbons(dt, camera);
    this._stepRings(dt);
  }

  _stepPoints(dt) {
    const P = this.pos, V = this.vel, C = this.col, R = this.par;
    const L = this.life, M = this.maxLife, N = this.nrm, S = this.sed;
    const D = this.drag, GY = this.gy;
    let i = 0;
    while (i < this.n) {
      const i3 = i * 3;
      L[i] -= dt;
      if (L[i] <= 0) {
        // swap-remove: the pool stays dense and the draw range stays one call
        const j = --this.n, j3 = j * 3;
        if (j !== i) {
          P[i3] = P[j3]; P[i3 + 1] = P[j3 + 1]; P[i3 + 2] = P[j3 + 2];
          V[i3] = V[j3]; V[i3 + 1] = V[j3 + 1]; V[i3 + 2] = V[j3 + 2];
          C[i3] = C[j3]; C[i3 + 1] = C[j3 + 1]; C[i3 + 2] = C[j3 + 2];
          R[i3] = R[j3]; R[i3 + 1] = R[j3 + 1]; R[i3 + 2] = R[j3 + 2];
          L[i] = L[j]; M[i] = M[j]; N[i] = N[j]; S[i] = S[j];
          D[i] = D[j]; GY[i] = GY[j];
        }
        continue;
      }
      /* Same implicit quadratic drag as dust.js: v/(1+k|v|t) has no explosion
         at 20 fps and needs no tuning that only holds at 60. */
      let vx = V[i3], vy = V[i3 + 1], vz = V[i3 + 2];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const f = 1 / (1 + D[i] * sp * dt);
      vx *= f; vy *= f; vz *= f;
      vy -= GY[i] * G * dt;
      V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
      P[i3] += vx * dt; P[i3 + 1] += vy * dt; P[i3 + 2] += vz * dt;
      N[i] = L[i] / M[i];
      i++;
    }

    const n = this.n;
    this.pGeo.setDrawRange(0, n);
    if (n > 0) {
      this._push('position', 3, n); this._push('aVel', 3, n);
      this._push('aCol', 3, n); this._push('aParam', 3, n);
      this._push('aLife', 1, n); this._push('aSeed', 1, n);
    }
  }

  _push(name, stride, n) {
    const a = this.pGeo.attributes[name];
    if (a.clearUpdateRanges) { a.clearUpdateRanges(); a.addUpdateRange(0, n * stride); }
    a.needsUpdate = true;
  }

  /* Rebuild every ribbon into the shared buffer. Camera-facing per SEGMENT
     rather than along a single screen-space right vector: a trail that curls
     back toward the camera would otherwise collapse to a line. */
  _stepRibbons(dt, camera) {
    if (!camera) return;
    let dirty = false;
    for (let s = 0; s < RIB_SLOTS; s++) {
      const base = s * RIB_PTS * 4;
      const P = this.rPts;
      let count = this.rCount[s];
      if (count > 0) {
        const head = this.rHead[s];
        // A faded ribbon ages at double rate. That is what fade() BUYS over
        // simply not pushing: the trail is pulled in rather than left to
        // drift, which is what you want the moment a projectile detonates.
        const ad = this.rFade[s] ? dt * 2 : dt;
        for (let k = 0; k < count; k++) P[base + ((head - k + RIB_PTS * 2) % RIB_PTS) * 4 + 3] += ad;
        // drop from the TAIL while the oldest sample is over the limit
        while (count > 0 &&
          P[base + ((head - count + 1 + RIB_PTS * 2) % RIB_PTS) * 4 + 3] > RIB_LIFE) count--;
        this.rCount[s] = count;
      }
      // A dead slot still owes the buffer one degenerate write, and exactly
      // one: after that its vertices are parked and cost nothing per frame.
      if (count > 0 || this.rLive[s]) {
        this._writeRibbon(s, count, camera);
        this.rLive[s] = count > 0 ? 1 : 0;
        dirty = true;
      }
    }
    if (dirty) {
      this.rGeo.attributes.position.needsUpdate = true;
      this.rGeo.attributes.aCol.needsUpdate = true;
      this.rGeo.attributes.aParam.needsUpdate = true;
    }
  }

  _writeRibbon(s, count, camera) {
    const vb = s * RIB_PTS * 2;
    const RP = this.rPos, RC = this.rCol, RA = this.rPar;
    const P = this.rPts, base = s * RIB_PTS * 4;
    const head = this.rHead[s];
    const ct = s * 3;
    const cr = this.rTint[ct], cg = this.rTint[ct + 1], cb = this.rTint[ct + 2];
    const wide = this.rWide[s];

    if (count < 2) {
      // degenerate: every vertex on one point, so the slot draws no area
      for (let i = 0; i < RIB_PTS * 2; i++) {
        const o = (vb + i) * 3;
        RP[o] = 0; RP[o + 1] = -1e5; RP[o + 2] = 0;
        RA[(vb + i) * 2] = 0; RA[(vb + i) * 2 + 1] = 0;
      }
      return;
    }

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (let i = 0; i < RIB_PTS; i++) {
      // i = 0 is the head; clamp past the live tail so the strip stays closed
      const k = i < count ? i : count - 1;
      const o = base + ((head - k + RIB_PTS * 2) % RIB_PTS) * 4;
      const px = P[o], py = P[o + 1], pz = P[o + 2];

      // tangent from the neighbouring samples, one-sided at the ends
      const kn = k < count - 1 ? k + 1 : k;
      const kp = k > 0 ? k - 1 : k;
      const on = base + ((head - kn + RIB_PTS * 2) % RIB_PTS) * 4;
      const op = base + ((head - kp + RIB_PTS * 2) % RIB_PTS) * 4;
      let tx = P[op] - P[on], ty = P[op + 1] - P[on + 1], tz = P[op + 2] - P[on + 2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl < 1e-5) { tx = 1; ty = 0; tz = 0; } else { tx /= tl; ty /= tl; tz /= tl; }

      // side = tangent x view, normalised: a proper camera-facing ribbon
      const vx = px - cx, vy = py - cy, vz = pz - cz;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl < 1e-5) { sx = 0; sy = 1; sz = 0; } else { sx /= sl; sy /= sl; sz /= sl; }

      const t = i / (RIB_PTS - 1);
      const taper = (i < count ? 1 - t : 0);
      const w = wide * (0.35 + 0.65 * taper);
      const vA = (vb + i * 2) * 3, vB = vA + 3;
      RP[vA] = px - sx * w; RP[vA + 1] = py - sy * w; RP[vA + 2] = pz - sz * w;
      RP[vB] = px + sx * w; RP[vB + 1] = py + sy * w; RP[vB + 2] = pz + sz * w;
      RC[vA] = cr; RC[vA + 1] = cg; RC[vA + 2] = cb;
      RC[vB] = cr; RC[vB + 1] = cg; RC[vB + 2] = cb;
      const pA = (vb + i * 2) * 2;
      RA[pA] = taper; RA[pA + 1] = -1;
      RA[pA + 2] = taper; RA[pA + 3] = 1;
    }
  }

  _stepRings(dt) {
    let i = 0;
    while (i < this.kN) {
      this.kT[i] += dt;
      if (this.kT[i] >= this.kLife[i]) {
        const j = --this.kN;
        if (j !== i) {
          const i3 = i * 3, j3 = j * 3, i4 = i * 4, j4 = j * 4;
          for (let k = 0; k < 3; k++) { this.kPos[i3 + k] = this.kPos[j3 + k]; this.kCol[i3 + k] = this.kCol[j3 + k]; }
          for (let k = 0; k < 4; k++) this.kGeom[i4 + k] = this.kGeom[j4 + k];
          this.kT[i] = this.kT[j]; this.kLife[i] = this.kLife[j];
        }
        continue;
      }
      const f = this.kT[i] / this.kLife[i];
      // fast out of the gate, coasting to a stop: an expanding front loses
      // energy to the air, and a linear ring reads as an animation
      const e = 1 - (1 - f) * (1 - f) * (1 - f);
      const i3 = i * 3, i4 = i * 4;
      const rad = this.kGeom[i4] + (this.kGeom[i4 + 1] - this.kGeom[i4]) * e;
      const dim = (1 - f) * (1 - f);
      _dummy.position.set(this.kPos[i3], this.kPos[i3 + 1], this.kPos[i3 + 2]);
      _dummy.rotation.set(0, this.kGeom[i4 + 2], 0);
      _dummy.scale.set(rad, 1, rad * this.kGeom[i4 + 3]);
      _dummy.updateMatrix();
      this.rings.setMatrixAt(i, _dummy.matrix);
      _col.setRGB(this.kCol[i3] * dim, this.kCol[i3 + 1] * dim, this.kCol[i3 + 2] * dim);
      this.rings.setColorAt(i, _col);
      i++;
    }
    this.rings.count = this.kN;
    if (this.kN > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
      this.rings.instanceColor.needsUpdate = true;
    }
  }

  /* ============================================================
     6.  HOUSEKEEPING
     ============================================================ */

  /** Drawing-buffer height in pixels — point sizes are metres until it is set. */
  setViewport(heightPx) { this.pMat.uniforms.uViewH.value = Math.max(64, heightPx | 0); }

  /** A sky theme id, or a bare gain. Sets how hard the additive layer pushes. */
  setTheme(nameOrGain) {
    const g = typeof nameOrGain === 'number'
      ? nameOrGain
      : (THEME_GAIN[nameOrGain] === undefined ? 1.0 : THEME_GAIN[nameOrGain]);
    this.pMat.uniforms.uGain.value = g;
    this.rMat.uniforms.uGain.value = g;
    return this;
  }

  /** Resize the pool for a new tier. Particles in flight are kept. */
  setQuality(q) {
    this.quality = q || this.quality;
    const max = TIER_POOL[(q && q.name) || 'HIGH'] || TIER_POOL.HIGH;
    if (max === this.MAX) return;
    const keep = Math.min(this.n, max);
    this._allocPoints(max, keep);
    this.MAX = max;
    this.n = keep;
    this._bindPoints();
    this.pGeo.setDrawRange(0, keep);
  }

  /** Everything gone, this frame. The grid, a restart, a track change. */
  clear() {
    this.n = 0;
    this.pGeo.setDrawRange(0, 0);
    this.kN = 0;
    this.rings.count = 0;
    for (let s = 0; s < RIB_SLOTS; s++) { this._ribClear(s); this.rLive[s] = 1; }
  }

  dispose() {
    this.clear();
    if (this.points.parent) this.points.parent.remove(this.points);
    if (this.ribbonMesh.parent) this.ribbonMesh.parent.remove(this.ribbonMesh);
    if (this.rings.parent) this.rings.parent.remove(this.rings);
    this.pGeo.dispose(); this.pMat.dispose();
    this.rGeo.dispose(); this.rMat.dispose();
    this.ringGeo.dispose(); this.ringMat.dispose();
    this.rings.dispose();
    this.atlas.dispose();
    this.dust = null;
  }
}

/** One ribbon handle. Built once per slot in the constructor — see ribbon(). */
function makeHandle(vfx, s) {
  return {
    push(x, y, z, r, g, b) { vfx._ribPush(s, x, y, z, r, g, b); },
    fade() { vfx.rFade[s] = 1; },
    clear() { vfx._ribClear(s); }
  };
}

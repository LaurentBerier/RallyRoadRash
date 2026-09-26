/* ============================================================
   DUST, CLODS AND EMBERS
   ------------------------------------------------------------
   There is air here, and air is the whole point. A grain thrown off a
   tyre does not fly a clean parabola — quadratic drag eats its speed in
   the first metre, and what is left hangs, spreads and drifts downwind
   for a couple of seconds. That hang is what makes a rally car look
   fast from behind.

   Three kinds share one pool, one draw call and one sprite sheet:
     0 PUFF   drag-heavy, nearly weightless, grows as it fades
     1 CLOD   near-ballistic, spins, bounces once — mud and torn turf
     2 EMBER  buoyant, glowing, cools from orange to nothing

   Colour is per-particle (SURFACES[].dustCol), so the same pool serves
   red canyon dirt, black mud and grey rock without a second material.
   ============================================================ */
import * as THREE from 'three';
import {themePalette, THEMES} from './terrain-shader.js';
import { G } from '../game/config.js';
import { clamp, vnoise } from '../core/rng.js';
import { makeDustAtlas } from './textures.js';

export const DUST_KIND = { PUFF: 0, CLOD: 1, EMBER: 2 };

/* Per-kind constants, flat arrays so the update loop never touches an object.
   gy scales gravity, buoy is an upward acceleration that decays over the
   particle's life (hot air under a puff, rising ash under an ember). */
const K_GY   = [0.14, 1.00, 0.30];
const K_BUOY = [1.60, 0.00, 3.40];

/* Wind and light per theme. These MIRROR world/sky.js SKY_THEMES — dust must
   not import sky.js (it would drag three's PMREM into the particle module), so
   the numbers live twice. If a sky theme's sun colour changes, change it here.
   sunCol/amb/sky are LINEAR radiance, already multiplied by intensity. */
export const DUST_THEMES = {
  training: { wind: [1.10, 0.40], sunCol: [2.55, 2.32, 2.02], amb: [0.16, 0.15, 0.13], sky: [0.18, 0.25, 0.40] },
  canyon:   { wind: [1.80, -0.80], sunCol: [2.55, 1.72, 1.02], amb: [0.22, 0.16, 0.10], sky: [0.14, 0.20, 0.34] },
  forest:   { wind: [0.60, 0.50], sunCol: [2.05, 1.60, 1.05], amb: [0.14, 0.17, 0.11], sky: [0.20, 0.26, 0.34] },
  volcano:  { wind: [2.40, -1.10], sunCol: [1.65, 0.62, 0.24], amb: [0.20, 0.09, 0.07], sky: [0.14, 0.09, 0.10] },
  // Thunder's warm afternoon key and cool skylight match the concept pass.
  thunder:  { wind: [2.10, -0.60], sunCol: [2.70, 2.08, 1.40], amb: [0.19, 0.18, 0.16], sky: [0.22, 0.29, 0.40] }
};

const DEFAULT_COL = [0.27, 0.19, 0.11];      // DIRT, for callers that pass nothing

export class Dust {
  /**
   * @param scene      scene to attach the Points to
   * @param terrain    needs heightAt(x,z); may be null (particles then never land)
   * @param sunDirRef  a uniform object {value:Vector3} or a bare Vector3 (sky.sunDir)
   * @param max        pool size — pass quality.dust
   * @param theme      a DUST_THEMES key
   */
  constructor(scene, terrain, sunDirRef, max = 1200, theme = 'training') {
    this.scene = scene;
    this.terrain = terrain || null;
    this.MAX = max;
    this.n = 0;
    this._tick = 0;
    this.windX = 0; this.windZ = 0;

    this._alloc(max, 0);

    const g = new THREE.BufferGeometry();
    this.geo = g;
    this._bind();
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const sunUniform = sunDirRef && sunDirRef.isVector3
      ? { value: sunDirRef }
      : (sunDirRef || { value: new THREE.Vector3(0.36, 0.88, 0.30) });

    this.atlas = makeDustAtlas(128);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      // NOT additive: thick dust has to hide what is behind it, or a rooster
      // tail turns into a light bulb the moment two cars overlap it
      blending: THREE.NormalBlending,
      uniforms: {
        uTex: { value: this.atlas },
        uSunDir: sunUniform,
        uSunCol: { value: new THREE.Vector3(2.55, 2.32, 2.02) },
        uAmb: { value: new THREE.Vector3(0.16, 0.15, 0.13) },
        uSky: { value: new THREE.Vector3(0.18, 0.25, 0.40) },
        uHaze: { value: new THREE.Vector3(.43,.46,.49) },
        uWrap: { value: 0.45 },
        uOpacity: { value: 0.52 },   // full-opacity puffs read as solid spheres
        uTime: { value: 0 },
        uViewH: { value: 1080 },
        uMaxPx: { value: 512 }
      },
      vertexShader: /* glsl */`
        attribute vec3 aVel, aCol, aParam;      // aParam = (sizeMetres, kind, spinRate)
        attribute float aLife, aSeed;
        varying vec3 vCol; varying vec2 vTile;
        varying float vL, vKind, vAng, vStretch, vSeed, vDistance;
        varying vec3 vSunView;
        uniform vec3 uSunDir;
        uniform float uTime, uViewH, uMaxPx;
        void main(){
          vL = aLife; vSeed = aSeed; vCol = aCol; vKind = aParam.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDistance=length(mv.xyz);
          vSunView=normalize(mat3(viewMatrix)*uSunDir);

          float age = 1.0 - aLife;
          float isPuff = step(aParam.y, 0.5);
          float sizeM = aParam.x * mix(1.0, 1.0 + 0.95 * age, isPuff);
          sizeM*=mix(1.,.68,smoothstep(45.,220.,vDistance)*isPuff);

          vec3 vv = (viewMatrix * vec4(aVel, 0.0)).xyz;
          vStretch = mix(1.0, clamp(1.0 + length(vv.xy) * 0.030, 1.0, 1.8), isPuff);
          // a puff streaks along its travel; a clod or an ember tumbles
          vAng = mix(aSeed * 6.2832 + aParam.z * uTime, atan(vv.y, vv.x + 1e-6), isPuff);

          vTile = vec2(mod(aParam.y, 2.0), floor(aParam.y * 0.5)) * 0.5;

          // metres -> pixels, straight out of the projection: no magic constant
          // that only holds at one resolution
          float px = projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.30);
          gl_PointSize = clamp(sizeM * px * sqrt(vStretch), 1.0, uMaxPx);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying vec3 vCol; varying vec2 vTile;
        varying float vL, vKind, vAng, vStretch, vSeed, vDistance;
        varying vec3 vSunView;
        uniform sampler2D uTex;
        uniform vec3 uSunDir, uSunCol, uAmb, uSky, uHaze;
        uniform float uWrap, uOpacity;
        void main(){
          vec2 pc = gl_PointCoord - 0.5;
          float c = cos(vAng), s = sin(vAng);
          pc = mat2(c, s, -s, c) * pc;
          pc.x /= vStretch;
          // clamp inside the tile: every tile fades to zero alpha at its border,
          // so a rotated corner samples the gutter and discards
          vec2 uv = clamp(pc + 0.5, 0.0, 1.0) * 0.5 + vTile;
          vec4 t = texture2D(uTex, uv);
          if (t.a < 0.01) discard;

          // spherical impostor + wrap lighting: a dust cloud scatters light
          // round its own limb, so hard Lambert reads as a solid pebble
          vec2 nc = (gl_PointCoord - 0.5) * 2.0;
          float r2 = min(dot(nc, nc), 1.0);
          vec3 N = vec3(nc.x, -nc.y, sqrt(max(1.0 - r2, 0.0)));
          vec3 S = normalize(vSunView);
          float lam = clamp((dot(N, S) + uWrap) / (1.0 + uWrap), 0.0, 1.0);

          vec3 alb = vCol * t.rgb * (0.86 + 0.28 * vSeed);
          vec3 col = alb * (mix(.38,lam,.42) * uSunCol + uAmb + uSky * (0.5 + 0.5 * N.y));

          float aIn  = smoothstep(0.0, 0.14, 1.0 - vL);
          float aOut = smoothstep(0.0, 0.32, vL);
          float alpha = t.a * aIn * aOut * (vKind < 0.5 ? uOpacity : 0.78);
          if(vKind<.5){
            float farDust=smoothstep(30.,210.,vDistance);
            alpha*=mix(1.,.20,farDust)*(1.-smoothstep(230.,380.,vDistance));
            alpha*=smoothstep(1.1,3.4,vDistance);
            col=mix(col,uHaze,farDust*.38);
          }

          if (vKind > 1.5){
            // cooling ember: bright enough to clear the bloom threshold while hot
            float heat = pow(vL, 1.6);
            col = mix(vec3(0.05, 0.010, 0.004), vCol * vec3(2.8, 1.0, 0.38), heat) * (1.8 + 9.0 * heat);
            alpha = t.a * aOut * 0.78 * (0.30 + 0.70 * heat);
          }
          gl_FragColor = vec4(col, alpha);
        }`
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    this.setTheme(theme);
  }

  /* ---------------- pool storage ---------------- */
  _alloc(max, keep) {
    const grow = (old, stride, Type) => {
      const a = new Type(max * stride);
      if (old && keep) a.set(old.subarray(0, keep * stride));
      return a;
    };
    const F = Float32Array;
    this.pos = grow(this.pos, 3, F);        // uploaded
    this.vel = grow(this.vel, 3, F);        // uploaded (drives the streak)
    this.col = grow(this.col, 3, F);        // uploaded
    this.param = grow(this.param, 3, F);    // uploaded: size, kind, spinRate
    this.norm = grow(this.norm, 1, F);      // uploaded: life remaining, 0..1
    this.seed = grow(this.seed, 1, F);      // uploaded
    this.life = grow(this.life, 1, F);
    this.maxLife = grow(this.maxLife, 1, F);
    this.drag = grow(this.drag, 1, F);
    this.gnd = grow(this.gnd, 1, F);        // cached ground height once landed
    this.flag = grow(this.flag, 1, Uint8Array);
  }

  _bind() {
    const g = this.geo;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aParam', new THREE.BufferAttribute(this.param, 3));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.norm, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
  }

  /* ---------------- theme / tuning ---------------- */

  /** Wind is a constant drift in m/s on the XZ plane — no gusts, no field. */
  setWind(x, z) { this.windX = x; this.windZ = z; }

  /** name from SKY_THEMES, or an explicit { wind, sunCol, amb, sky } override. */
  setTheme(nameOrOpts) {
    this.groundPalette=themePalette(typeof nameOrOpts==='string'?nameOrOpts:'training').map(c=>{
      const earth=clamp(c[0]*.55+c[1]*.35+c[2]*.10,.075,.28);
      return nameOrOpts==='thunder'?[earth,earth*.84,earth*.66]:[earth,earth*.72,earth*.43];
    });
    const t = typeof nameOrOpts === 'string'
      ? (DUST_THEMES[nameOrOpts] || DUST_THEMES.training)
      : (nameOrOpts || DUST_THEMES.training);
    const u = this.mat.uniforms;
    u.uHaze.value.fromArray((THEMES[typeof nameOrOpts==='string'?nameOrOpts:'training']||THEMES.training).haze);
    if (t.wind) this.setWind(t.wind[0], t.wind[1]);
    if (t.sunCol) u.uSunCol.value.fromArray(t.sunCol);
    if (t.amb) u.uAmb.value.fromArray(t.amb);
    if (t.sky) u.uSky.value.fromArray(t.sky);
    return this;
  }

  /** Drawing-buffer height in pixels — point sizes are metres until it is set. */
  setViewport(heightPx) { this.mat.uniforms.uViewH.value = Math.max(64, heightPx | 0); }

  // Resolve the actual ground under the emitter against the shader's theme
  // palette; no pixel readback, texture sampling or per-particle allocation.
  groundColorAt(x,z,fallback=DEFAULT_COL){
    const sid=this.terrain?.surfaceAt?.(x,z);
    const base=this.groundPalette?.[sid]||fallback;
    const out=this._groundSample||(this._groundSample=[0,0,0]);
    // Modest luminance variation follows broad ground patches; avoid reading
    // the framebuffer or turning every puff into a differently coloured blob.
    let luma=.96+.10*vnoise(x*.018,z*.018,53);
    if(this.terrain?.normalAt){
      const n=this._groundNormal||(this._groundNormal=new THREE.Vector3());
      this.terrain.normalAt(x,z,.8,n);
      luma*=.93+.09*Math.max(0,n.dot(this.mat.uniforms.uSunDir.value));
    }
    const vis=this.terrain?.sunVis?.(x,z,this.mat.uniforms.uSunDir.value)??1;
    // Use the same terrain occlusion as vehicles: dust in a shaded cutting
    // receives cool sky fill instead of keeping a sunlit orange glow.
    out[0]=base[0]*luma*(.42+.58*vis);
    out[1]=base[1]*luma*(.53+.47*vis);
    out[2]=base[2]*luma*(.70+.30*vis);
    return out;
  }

  /* ---------------- emission ---------------- */

  /**
   * Throw grains. dirX/dirZ bias the cone along a heading — pass the negated
   * travel direction for a rooster tail behind a wheel.
   *
   * @param n            how many (silently truncated at the pool ceiling)
   * @param force        m/s scale of the launch
   * @param spread       radius in metres the grains are seeded over
   * @param cr,cg,cb     SURFACES[id].dustCol
   * @param kind         DUST_KIND.PUFF | CLOD | EMBER
   */
  spawn(n, x, y, z, force, spread, dirX = 0, dirZ = 0,
        cr = DEFAULT_COL[0], cg = DEFAULT_COL[1], cb = DEFAULT_COL[2], kind = 0) {
    const biased = (dirX !== 0 || dirZ !== 0);
    const hd = biased ? Math.atan2(dirZ, dirX) : 0;
    const k = kind | 0;
    for (let q = 0; q < n; q++) {
      if (this.n >= this.MAX) return;
      const i = this.n++;
      const i3 = i * 3;
      const r1 = Math.random(), r2 = Math.random(), r3 = Math.random(), r4 = Math.random();
      const a = biased ? hd + (r1 - 0.5) * 1.7 : r1 * 6.2832;
      const ring = spread * (0.12 + r2 * 0.88);

      let out, vy, size, life, drg, spin;
      if (k === 1) {
        out = (0.45 + r3 * 1.30) * force * 1.30;
        vy = (1.65 + r4 * 2.15) * force;
        size = 0.065 + r2 * 0.16;
        life = 1.00 + r3 * 1.30;
        drg = 0.012 + r4 * 0.038;
        spin = (4.0 + r1 * 7.0) * (r2 < 0.5 ? -1 : 1);
      } else if (k === 2) {
        out = (0.22 + r3 * 0.80) * force;
        vy = (0.85 + r4 * 1.40) * force;
        size = 0.09 + r2 * 0.17;
        life = 1.60 + r3 * 1.80;
        drg = 0.22 + r4 * 0.22;
        spin = (1.0 + r1 * 2.0) * (r2 < 0.5 ? -1 : 1);
      } else {
        out = (0.30 + r3 * 0.95) * force;
        vy = (0.50 + r4 * 0.95) * force * (biased ? 0.60 : 1.0);
        // First light showed 2.2 m puffs growing past 5 m read as boulders, not
        // dust — cap the base under 1.5 m and let the growth term do the rest.
        size = 0.42 + r2 * 1.00;
        life = 1.50 + r3 * 1.50;
        drg = 0.42 + r4 * 0.40;
        spin = 0.15 + r1 * 0.35;
      }

      this.pos[i3] = x + Math.cos(a) * ring;
      this.pos[i3 + 1] = y + 0.06 + r4 * 0.10;
      this.pos[i3 + 2] = z + Math.sin(a) * ring;
      this.vel[i3] = Math.cos(a) * out;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = Math.sin(a) * out;
      const shade=k===1?.48:1;
      this.col[i3] = cr*shade; this.col[i3 + 1] = cg*shade; this.col[i3 + 2] = cb*shade;
      this.param[i3] = size; this.param[i3 + 1] = k; this.param[i3 + 2] = spin;
      this.seed[i] = r1;
      this.maxLife[i] = life;
      this.life[i] = life;
      this.norm[i] = 1;
      this.drag[i] = drg;
      this.gnd[i] = -1e9;
      this.flag[i] = 0;
    }
  }

  /**
   * Landing / impact: a flat ring of dust that punches outward plus a fan of
   * clods thrown back along the direction of travel.
   * @param heading yaw in radians; forward is (sin, cos), matching +Z-forward
   * @param force   0..3-ish, scale it off the impact speed
   * @param col     SURFACES[id].dustCol (array of three), optional
   */
  burst(x, y, z, heading = 0, force = 1, col = DEFAULT_COL) {
    const f = clamp(force, 0.30, 3.40);
    const dx = Math.sin(heading), dz = Math.cos(heading);
    col=this.groundColorAt(x,z,col);
    const cr = col[0], cg = col[1], cb = col[2];
    this.spawn(Math.round(10 + f * 16), x, y, z, 0.9 + f * 1.5, 0.55 + f * 0.55,
      0, 0, cr, cg, cb, 0);
    this.spawn(Math.round(3 + f * 4), x, y + 0.10, z, 1.4 + f * 2.2, 0.35,
      -dx, -dz, cr, cg, cb, 1);
  }

  /* ---------------- simulation ---------------- */
  update(dt) {
    if (dt <= 0) { return; }
    // wrapped: spin is uTime * rate, and a float loses the fraction eventually
    const ut = this.mat.uniforms.uTime;
    ut.value = (ut.value + dt) % 1024;
    this._tick++;
    const tick = this._tick;
    const P = this.pos, V = this.vel, C = this.col, R = this.param;
    const L = this.life, M = this.maxLife, N = this.norm, S = this.seed;
    const D = this.drag, GH = this.gnd, FL = this.flag;
    const wx = this.windX, wz = this.windZ;
    const terrain = this.terrain;
    let i = 0;
    while (i < this.n) {
      const i3 = i * 3;
      L[i] -= dt;
      if (L[i] <= 0) {
        // swap-remove: the pool stays dense, the draw range stays one call
        const j = --this.n, j3 = j * 3;
        if (j !== i) {
          P[i3] = P[j3]; P[i3 + 1] = P[j3 + 1]; P[i3 + 2] = P[j3 + 2];
          V[i3] = V[j3]; V[i3 + 1] = V[j3 + 1]; V[i3 + 2] = V[j3 + 2];
          C[i3] = C[j3]; C[i3 + 1] = C[j3 + 1]; C[i3 + 2] = C[j3 + 2];
          R[i3] = R[j3]; R[i3 + 1] = R[j3 + 1]; R[i3 + 2] = R[j3 + 2];
          L[i] = L[j]; M[i] = M[j]; N[i] = N[j]; S[i] = S[j];
          D[i] = D[j]; GH[i] = GH[j]; FL[i] = FL[j];
        }
        continue;
      }

      const k = R[i3 + 1] | 0;
      const frac = L[i] / M[i];

      /* quadratic drag against the wind, integrated implicitly.
         v' = -k|v|v has the closed form v/(1+k|v|t) — using it directly means
         no explosion at 20 fps and no tuning that only holds at 60. */
      let rx = V[i3] - wx, ry = V[i3 + 1], rz = V[i3 + 2] - wz;
      const sp = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const f = 1 / (1 + D[i] * sp * dt);
      rx *= f; ry *= f; rz *= f;
      ry += (K_BUOY[k] * frac - K_GY[k] * G) * dt;

      V[i3] = rx + wx; V[i3 + 1] = ry; V[i3 + 2] = rz + wz;
      P[i3] += V[i3] * dt;
      P[i3 + 1] += V[i3 + 1] * dt;
      P[i3 + 2] += V[i3 + 2] * dt;

      /* ground. Airborne grains only look down when they are falling; landed
         ones re-sample every fourth frame, which is often enough for something
         creeping at walking pace. */
      const landed = FL[i] & 1;
      if (terrain && (V[i3 + 1] < 0 || landed)) {
        let gh;
        if (landed && ((i + tick) & 3) !== 0) gh = GH[i];
        else { gh = terrain.heightAt(P[i3], P[i3 + 2]); GH[i] = gh; }
        if (P[i3 + 1] <= gh + 0.03) {
          if (k === 1 && !landed && V[i3 + 1] < -2.5) {
            // one dead bounce, then it is debris on the ground
            P[i3 + 1] = gh + 0.03;
            V[i3 + 1] = -V[i3 + 1] * 0.22;
            V[i3] *= 0.50; V[i3 + 2] *= 0.50;
            if (L[i] > 0.75) L[i] = 0.75;
          } else if (k === 0) {
            // a puff does not land, it spreads out along the ground and creeps
            P[i3 + 1] = gh + 0.12;
            if (V[i3 + 1] < 0) V[i3 + 1] = 0;
            FL[i] |= 1;
          } else {
            P[i3 + 1] = gh + 0.03;
            V[i3 + 1] = 0; V[i3] *= 0.30; V[i3 + 2] *= 0.30;
            FL[i] |= 1;
            if (L[i] > 0.45) L[i] = 0.45;
          }
        }
      }

      N[i] = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      i++;
    }

    const n = this.n;
    this.geo.setDrawRange(0, n);
    if (n > 0) {
      this._push('position', 3, n); this._push('aVel', 3, n);
      this._push('aCol', 3, n); this._push('aParam', 3, n);
      this._push('aLife', 1, n); this._push('aSeed', 1, n);
    }
  }

  /* Upload only the live prefix of each attribute. Ranges are cleared first:
     if the pool is stepped while nothing renders they would otherwise pile up. */
  _push(name, stride, n) {
    const a = this.geo.attributes[name];
    if (a.clearUpdateRanges) { a.clearUpdateRanges(); a.addUpdateRange(0, n * stride); }
    a.needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** Resize the pool for a new quality tier. Grains in flight are kept. */
  setMax(max) {
    if (max === this.MAX) return;
    const keep = Math.min(this.n, max);
    this._alloc(max, keep);
    this.MAX = max;
    this.n = keep;
    this._bind();
    this.geo.setDrawRange(0, keep);
  }

  /** Convenience for the quality menu: tiers carry their own particle budget. */
  setQuality(q) { if (q && q.dust) this.setMax(q.dust); }

  dispose() {
    if (this.points.parent) this.points.parent.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
    this.atlas.dispose();
    this.n = 0;
  }
}

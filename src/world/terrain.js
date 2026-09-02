/* ============================================================
   RALLY ROAD RASH — terrain
   ------------------------------------------------------------
   • Height is BAKED on the CPU into Float textures; the GPU only ever
     samples them. Physics and pixels therefore agree exactly, which is
     the whole reason a car can land a 30 m jump on the same lip the
     renderer drew. See "CPU / SHADER HEIGHT AGREEMENT" below §4.
   • Rendered as a geometry clipmap centred on the camera: 0.16 m cells
     under the wheels, 41 m cells at the horizon, zero per-frame CPU
     geometry work.
   • After the theme base is baked, the ROAD IS CARVED into it: the
     field is blended toward the spline's own y over the roadbed, the
     shoulder feathers out, kickers and gaps are cut, and everything
     within 45 m of the road is soft-clamped into a cone so no authored
     elevation can ever put a cliff across the racing line.
   • A baked sun-occlusion mask (sun is static per track — baked once).
   • A GPU "trail" buffer records tyre marks.
   • A CPU-authoritative dent field carries wheel ruts with displaced
     berms; churned ground slumps back at the angle of repose.
   ============================================================ */
import * as THREE from 'three';
import { clamp, sstep, lerp } from '../core/rng.js';
import {
  MACRO_EXT, MACRO_RES, FAR_EXT, FAR_RES, DET_TILE, DET_RES, DENT_EXT,
  SUNMASK_EXT, SURF_EXT, SURF_RES, DET_AMP, DET_AMP2, DET_SCALE2, FADE0, FADE1,
  BERM_OUT, BERM_GAIN, DIG_CAP, SLUMP_TTL,
} from './terrain-const.js';
import { THEMES, buildTerrainMaterial, makeLevelMaterial } from './terrain-shader.js';

/* The split is an implementation detail: everything the rest of the game used
   to import from this file still comes out of it. */
export {
  PLAYABLE_EXT, PLAYABLE_R, MACRO_EXT, MACRO_RES, FAR_EXT, FAR_RES, DET_TILE,
  DET_RES, DENT_EXT, SUNMASK_EXT, SURF_EXT, SURF_RES, FADE0, FADE1,
} from './terrain-const.js';
export { THEMES, themePalette, TERRAIN_GLSL } from './terrain-shader.js';
export { bakeTrack, themeBaseFn } from './terrain-bake.js';

/* ============================================================
   CPU FIELD SAMPLING
   ============================================================
   The two filters the height query runs on. They must match what the GPU
   sampler does texel for texel — see the parity table in terrain-shader.js. */
function bilinear(arr, res, ext, x, z) {
  // matches GL LinearFilter + ClampToEdge exactly
  const u = (x / ext + 0.5) * res - 0.5;
  const v = (z / ext + 0.5) * res - 0.5;
  const x0 = Math.floor(u), z0 = Math.floor(v);
  const fx = u - x0, fz = v - z0;
  const c = (a, b) => (a < 0 ? 0 : a > b ? b : a);
  const xa = c(x0, res - 1), xb = c(x0 + 1, res - 1);
  const za = c(z0, res - 1) * res, zb = c(z0 + 1, res - 1) * res;
  const h00 = arr[za + xa], h10 = arr[za + xb];
  const h01 = arr[zb + xa], h11 = arr[zb + xb];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}
function bilinearWrap(arr, res, x, z) {
  const u = x * res - 0.5, v = z * res - 0.5;
  const x0 = Math.floor(u), z0 = Math.floor(v);
  const fx = u - x0, fz = v - z0;
  const w = (a) => ((a % res) + res) % res;
  const xa = w(x0), xb = w(x0 + 1), za = w(z0) * res, zb = w(z0 + 1) * res;
  const h00 = arr[za + xa], h10 = arr[za + xb];
  const h01 = arr[zb + xa], h11 = arr[zb + xb];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}
/* ============================================================
   5.  TERRAIN OBJECT
   ============================================================ */
export class Terrain {
  constructor(renderer, baked, quality, caps = {}, trackDef = null) {
    this.renderer = renderer;
    /* Height fields are R32F. Sampling them with LinearFilter needs
       OES_texture_float_linear, which three silently downgrades to NEAREST when
       absent — 0.7 m stair-steps across the whole map. Where the extension is
       missing we filter in the shader instead. */
    this.manualBilinear = caps.floatLinear === false;
    this.macro = baked.macro; this.far = baked.far; this.det = baked.det;
    this.roadMask = baked.roadMask; this.surf = baked.surf; this.bump = baked.bump;
    // Signed lateral offset across the road, in half-widths; see the bake.
    // Older bakes predate it, so the shader gets a neutral field rather than
    // a null sampler, which some drivers treat as an error.
    this.lat = baked.lat || new Uint8Array(SURF_RES * SURF_RES).fill(128);
    this.quality = quality;
    this.trackDef = trackDef || baked.trackDef;
    this.theme = baked.theme || (this.trackDef && this.trackDef.theme) || 'training';
    this.trackData = baked.trackData;
    // The contract says whoever constructs the Terrain owns `spline`; the bake
    // already built one, so hand it over rather than making race.js build a
    // second copy of a 2 km arc-length table.
    this.spline = baked.trackData ? baked.trackData.spline : null;

    const T = THEMES[this.theme] || THEMES.training;
    this.sunDir = new THREE.Vector3(T.sun[0], T.sun[1], T.sun[2]).normalize();

    /* ---- data textures ----
       R32F, not half: heights reach 120 m and half-float's 10-bit mantissa
       would quantise that to 12 cm steps — visibly terraced ground. */
    const mk = (arr, res, wrap, mips) => {
      const t = new THREE.DataTexture(arr, res, res, THREE.RedFormat, THREE.FloatType);
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      if (this.manualBilinear) { t.magFilter = t.minFilter = THREE.NearestFilter; }
      else if (mips) { t.mipmaps = mips; t.minFilter = THREE.LinearMipmapLinearFilter; }
      else t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    this.texMacro = mk(this.macro, MACRO_RES, false, baked.macroMips);
    this.texFar = mk(this.far, FAR_RES, false, baked.farMips);
    this.texDetail = mk(this.det, DET_RES, true, null);

    const mk8 = (arr, res, nearest) => {
      const t = new THREE.DataTexture(arr, res, res, THREE.RedFormat, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.texRoad = mk8(this.roadMask, MACRO_RES, false);
    this.texSurf = mk8(this.surf, SURF_RES, true);
    this.texBump = mk8(this.bump, SURF_RES, false);
    this.texLat = mk8(this.lat, SURF_RES, false);

    /* ---- rut field (CPU authoritative, uploaded as dirty rects) ---- */
    const DR = this.dentRes = quality.dentRes;
    this.dent = new Float32Array(DR * DR);
    this.dentHalf = new Uint16Array(DR * DR);
    this.texDent = new THREE.DataTexture(this.dentHalf, DR, DR, THREE.RedFormat, THREE.HalfFloatType);
    this.texDent.magFilter = this.texDent.minFilter =
      this.manualBilinear ? THREE.NearestFilter : THREE.LinearFilter;
    this.texDent.generateMipmaps = false;
    this.texDent.needsUpdate = true;
    // A rut touches ~4 texels; a landing gouge touches ~200. Uploading a fixed
    // 128-square block for both wastes two orders of magnitude of bandwidth.
    this.scratches = [16, 64, 256].map((n) => {
      const t = new THREE.DataTexture(new Uint16Array(n * n), n, n, THREE.RedFormat, THREE.HalfFloatType);
      t.generateMipmaps = false; t.needsUpdate = true;
      return { n, tex: t };
    });
    this._marks = [];
    this._slumps = [];

    /* ---- trail buffer (tyre marks) ---- */
    const TR = quality.trailRes;
    this.TRAIL_EXT = 1300;
    this.trailRT = new THREE.WebGLRenderTarget(TR, TR, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
    });
    this.trailCam = new THREE.OrthographicCamera(-this.TRAIL_EXT / 2, this.TRAIL_EXT / 2,
      this.TRAIL_EXT / 2, -this.TRAIL_EXT / 2, -1, 1);
    this.trailScene = new THREE.Scene();
    this._trailPool = []; this._trailUsed = 0;
    this._trailTex = makeTrackStamp();
    this._trailGeo = new THREE.PlaneGeometry(1, 1);
    // Additive: a line darkens where six cars have taken the same apex, and
    // saturates. Nothing erases it — that is the point of a racing line.
    this._trailProto = new THREE.MeshBasicMaterial({
      map: this._trailTex, color: 0xffffff, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false
    });
    renderer.setRenderTarget(this.trailRT);
    renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false);
    renderer.setRenderTarget(null);

    /* ---- sun occlusion mask ---- */
    this.sunRT = new THREE.WebGLRenderTarget(quality.sunRes, quality.sunRes, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
    });
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: {
        uMacro: { value: this.texMacro }, uFar: { value: this.texFar },
        uSun: { value: this.sunDir.clone() }, uExt: { value: SUNMASK_EXT },
        uSteps: { value: quality.sunSteps }
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy*2.0,0.0,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; precision highp sampler2D; varying vec2 vUv;
        uniform sampler2D uMacro, uFar; uniform vec3 uSun; uniform float uExt, uSteps;
        float hM(vec2 p){
          float m = texture2D(uMacro, clamp(p/${MACRO_EXT.toFixed(1)}+0.5, 0.0005, 0.9995)).r;
          float f = texture2D(uFar, clamp(p/${FAR_EXT.toFixed(1)}+0.5, 0.0005, 0.9995)).r;
          return mix(m, f, smoothstep(${FADE0.toFixed(1)}, ${FADE1.toFixed(1)}, length(p)));
        }
        void main(){
          vec2 p = (vUv - 0.5) * uExt;
          float h0 = hM(p) + 0.20;                       // bias off the surface: no acne
          vec2 dir = normalize(uSun.xz + vec2(1e-5));
          float tanA = max(uSun.y, 0.04) / max(length(uSun.xz), 1e-4);
          // 'stp', not 'step': a variable of that name would hide the built-in
          // step() for the rest of the scope, and the next person to add a
          // smoothstep-free threshold here would lose an hour to it.
          float sh = 1.0, d = 0.9, stp = 0.9;
          for (int i = 0; i < 128; i++){
            if (float(i) >= uSteps) break;
            float hr = h0 + d * tanA;
            float ht = hM(p + dir * d);
            // Penumbra widens with distance to the occluder — daylight shadows
            // have soft edges, which is most of what sells them as daylight.
            sh = min(sh, clamp((hr - ht) / (0.055 * d + 0.5), 0.0, 1.0));
            if (sh <= 0.002) break;
            d += stp; stp *= 1.055;
          }
          gl_FragColor = vec4(sh, 0.0, 0.0, 1.0);
        }`
    });
    this._sunQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sunMat);
    this._sunScene = new THREE.Scene(); this._sunScene.add(this._sunQuad);
    this._sunCam = new THREE.Camera();
    this._lastSun = new THREE.Vector3(9, 9, 9);

    this.buildMaterial();
    this.buildClipmap();
  }

  /* ---------- CPU height, term-for-term what the vertex shader computes ----------
     Read §4 above before touching either side of this. */
  heightAt(x, z) {
    const m = bilinear(this.macro, MACRO_RES, MACRO_EXT, x, z);
    const f = bilinear(this.far, FAR_RES, FAR_EXT, x, z);
    let h = lerp(m, f, sstep(FADE0, FADE1, Math.hypot(x, z)));
    const road = bilinear(this.roadMask, MACRO_RES, MACRO_EXT, x, z) / 255;
    const bmp = bilinear(this.bump, SURF_RES, SURF_EXT, x, z) / 255;
    const amp = (1 - road * 0.85) * (0.30 + 0.85 * bmp);
    let d = bilinearWrap(this.det, DET_RES, x / DET_TILE, z / DET_TILE) * DET_AMP;
    d += bilinearWrap(this.det, DET_RES, x / DET_SCALE2 + 0.37, z / DET_SCALE2 + 0.71) * DET_AMP2;
    h += d * amp;
    h -= this.dentAt(x, z);
    return h;
  }
  dentAt(x, z) {
    const u = (x / DENT_EXT + 0.5), v = (z / DENT_EXT + 0.5);
    if (u < 0.001 || u > 0.999 || v < 0.001 || v > 0.999) return 0;
    return bilinear(this.dent, this.dentRes, DENT_EXT, x, z);
  }
  normalAt(x, z, e = 0.35, out = new THREE.Vector3()) {
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }
  /** slope in degrees */
  slopeAt(x, z) { const n = this.normalAt(x, z, 0.9, _v3a); return Math.acos(clamp(n.y, -1, 1)) * 57.29578; }

  /** Surface id under a point. NEAREST texel — ids do not interpolate. */
  surfaceAt(x, z) {
    let i = Math.floor((x / SURF_EXT + 0.5) * SURF_RES);
    let j = Math.floor((z / SURF_EXT + 0.5) * SURF_RES);
    if (i < 0) i = 0; else if (i > SURF_RES - 1) i = SURF_RES - 1;
    if (j < 0) j = 0; else if (j > SURF_RES - 1) j = SURF_RES - 1;
    return this.surf[j * SURF_RES + i];
  }
  /** 0..1, 1 in the middle of the roadbed. Same sample the height uses. */
  onRoad(x, z) { return bilinear(this.roadMask, MACRO_RES, MACRO_EXT, x, z) / 255; }

  /** CPU sun visibility (0 shadow .. 1 lit), for lighting the cars.
      Marches the macro field only, exactly like the baked GPU mask does. */
  sunVis(x, z, sun = this.sunDir) {
    const h0 = bilinear(this.macro, MACRO_RES, MACRO_EXT, x, z);
    const l = Math.hypot(sun.x, sun.z) || 1e-4;
    const dx = sun.x / l, dz = sun.z / l;
    const tanA = Math.max(sun.y, 0.04) / l;
    let sh = 1, d = 1.1, step = 1.1;
    for (let i = 0; i < 48; i++) {
      const hr = h0 + 0.20 + d * tanA;
      const ht = bilinear(this.macro, MACRO_RES, MACRO_EXT, x + dx * d, z + dz * d);
      sh = Math.min(sh, clamp((hr - ht) / (0.055 * d + 0.5), 0, 1));
      if (sh <= 0.004) break;
      d += step; step *= 1.09;
    }
    return sh;
  }

  /* ============================================================
     material
     ============================================================ */
  buildMaterial() { buildTerrainMaterial(this); }

  /* ============================================================
     clipmap
     ============================================================ */
  buildClipmap() {
    // Reuse the group across rebuilds: main adds it to the scene once at boot,
    // so handing back a fresh one on a quality change would leave the old rings
    // drawn and the new ones orphaned.
    if (this.group) {
      for (const L of this.levels) {
        this.group.remove(L.mesh);
        L.mesh.geometry.dispose(); L.mesh.material.dispose();
      }
    } else {
      this.group = new THREE.Group();
      this.group.frustumCulled = false;
    }
    this.levels = [];
    const M = this.quality.clipM;
    const LV = this.quality.clipLevels;
    const c0 = this.quality.clipCell;

    const grid = (nx, nz, hole) => {
      const verts = [], idx = [];
      const w = nx + 1;
      for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) verts.push(x - nx / 2, 0, z - nz / 2);
      for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        if (hole) {
          const cx = x - nx / 2 + 0.5, cz = z - nz / 2 + 0.5;
          if (Math.abs(cx) < hole && Math.abs(cz) < hole) continue;
        }
        const a = z * w + x, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setIndex(idx);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      return g;
    };

    for (let i = 0; i < LV; i++) {
      const cell = c0 * Math.pow(2, i);
      const geo = grid(M, M, i === 0 ? 0 : M / 4 - 2);   // 2-cell overlap hides any snap mismatch
      const mat = makeLevelMaterial(this, cell, i);
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(cell, 1, cell);
      m.frustumCulled = false;
      m.renderOrder = -10 + i;
      this.group.add(m);
      this.levels.push({ mesh: m, cell, snap: cell * 2 });
    }
  }

  /* ============================================================
     ruts
     ============================================================ */
  /* Mark a rect for GPU upload. Rects are kept as a SHORT LIST, never a single
     union: two cars 300 m apart would otherwise produce one rect spanning
     everything between them, and we would re-upload a third of the world. */
  _mark(x0, z0, x1, z1) {
    const M = this._marks;
    for (const m of M) {
      if (x0 <= m[2] + 8 && x1 >= m[0] - 8 && z0 <= m[3] + 8 && z1 >= m[1] - 8) {
        m[0] = Math.min(m[0], x0); m[1] = Math.min(m[1], z0);
        m[2] = Math.max(m[2], x1); m[3] = Math.max(m[3], z1);
        return;
      }
    }
    if (M.length < 16) M.push([x0, z0, x1, z1]);
    else {
      const m = M[0];
      m[0] = Math.min(m[0], x0); m[1] = Math.min(m[1], z0);
      m[2] = Math.max(m[2], x1); m[3] = Math.max(m[3], z1);
    }
  }

  /** Ground that is still settling. Only wheelspin creates these — a compacted
      rut does not flow, it stays exactly where you put it. */
  _slumpRegion(x0, z0, x1, z1) {
    for (const r of this._slumps) {
      if (x0 <= r[2] + 4 && x1 >= r[0] - 4 && z0 <= r[3] + 4 && z1 >= r[1] - 4) {
        r[0] = Math.min(r[0], x0); r[1] = Math.min(r[1], z0);
        r[2] = Math.max(r[2], x1); r[3] = Math.max(r[3], z1);
        r[4] = SLUMP_TTL;
        return;
      }
    }
    if (this._slumps.length >= 10) this._slumps.shift();
    this._slumps.push([x0, z0, x1, z1, SLUMP_TTL]);
  }

  /** Cut a wheel rut.
      Soil is displaced, not destroyed: what the wheel presses down piles up into
      berms along both flanks, which is what turns a dark stripe into an actual
      furrow. Rolling settles toward a target depth and stops there; `dig`
      accumulates without limit, because that is exactly what a spinning wheel
      does — and it is how you bury yourself to the axle in mud. */
  rut(wx, wz, halfWidth, depth, dig) {
    const DENT_RES = this.dentRes;
    const px = DENT_EXT / DENT_RES, half = DENT_RES * 0.5;
    const R = halfWidth * BERM_OUT;
    const gx0 = Math.max(1, Math.floor((wx - R) / px + half));
    const gx1 = Math.min(DENT_RES - 2, Math.ceil((wx + R) / px + half));
    const gz0 = Math.max(1, Math.floor((wz - R) / px + half));
    const gz1 = Math.min(DENT_RES - 2, Math.ceil((wz + R) / px + half));
    if (gx1 < gx0 || gz1 < gz0) return;
    const D = this.dent;
    for (let gz = gz0; gz <= gz1; gz++) {
      const p = (gz - half + 0.5) * px;
      for (let gx = gx0; gx <= gx1; gx++) {
        const q = (gx - half + 0.5) * px;
        const t = Math.hypot(q - wx, p - wz) / halfWidth;
        const i = gz * DENT_RES + gx;
        if (t < 1) {
          const target = depth * (1 - 0.30 * t * t);        // near-flat floor
          if (dig) D[i] = Math.min(DIG_CAP, D[i] + dig * (1 - 0.5 * t));
          else if (D[i] < target) D[i] = Math.min(target, D[i] + depth * 0.6);
        } else if (t < BERM_OUT) {
          // Never let the berm pass eat a trough. Successive calls overlap as
          // the wheel rolls, so a texel that was rut floor one step ago lands in
          // the berm annulus the next — and without this guard the two passes
          // fight and cancel each other into flat ground.
          if (D[i] > 0.004) continue;
          const u = (t - 1) / (BERM_OUT - 1);
          const lobe = Math.sin(u * Math.PI) * (1 - u) * 1.55;
          const target = -depth * lobe * BERM_GAIN - (dig ? dig * lobe * 2.2 : 0);
          if (D[i] > target) D[i] = Math.max(target, D[i] - Math.max(depth, dig) * 0.5);
        }
      }
    }
    this._mark(gx0, gz0, gx1, gz1);
    if (dig) this._slumpRegion(gx0, gz0, gx1, gz1);
  }

  /** Loose ground cannot hold a wall: relax anything past the angle of repose.
      Each churned patch settles on its own clock, inside its own small rect. */
  relax(dt) {
    if (!this._slumps.length) return;
    const DENT_RES = this.dentRes;
    const D = this.dent, n = DENT_RES;
    const px = DENT_EXT / DENT_RES;
    const STEP = 0.62 * px;                    // ~32 degree repose angle
    const STEPD = STEP * 1.41421;
    const FLOW = Math.min(0.42, dt * 9);
    for (let k = this._slumps.length - 1; k >= 0; k--) {
      const r = this._slumps[k];
      r[4] -= dt;
      const x0 = Math.max(1, r[0] - 1), z0 = Math.max(1, r[1] - 1);
      const x1 = Math.min(DENT_RES - 2, r[2] + 1), z1 = Math.min(DENT_RES - 2, r[3] + 1);
      if (x1 < x0 || z1 < z0 || r[4] <= 0) { this._slumps.splice(k, 1); continue; }
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const i = z * n + x;
        let si = -D[i];
        const move = (j, thr) => {
          const sj = -D[j], d = si - sj;
          if (d > thr) { const m = (d - thr) * FLOW * 0.5; D[i] += m; D[j] -= m; si -= m; }
        };
        move(i - 1, STEP); move(i + 1, STEP); move(i - n, STEP); move(i + n, STEP);
        move(i - n - 1, STEPD); move(i - n + 1, STEPD); move(i + n - 1, STEPD); move(i + n + 1, STEPD);
      }
      this._mark(x0, z0, x1, z1);
    }
  }

  _uploadDirty() {
    if (!this._marks.length) return;
    for (const m of this._marks) this._uploadRect(m[0], m[1], m[2], m[3]);
    this._marks.length = 0;
  }

  _uploadRect(x0, z0, x1, z1) {
    const DENT_RES = this.dentRes;
    x0 = Math.max(0, x0); z0 = Math.max(0, z0);
    x1 = Math.min(DENT_RES - 1, x1); z1 = Math.min(DENT_RES - 1, z1);
    if (x1 < x0 || z1 < z0) return;
    const need = Math.max(x1 - x0 + 1, z1 - z0 + 1);
    const sc = this.scratches.find(s => s.n >= need) || this.scratches[this.scratches.length - 1];
    const S = sc.n, data = sc.tex.image.data;
    const half = THREE.DataUtils.toHalfFloat;
    for (let by = z0; by <= z1; by += S) {
      for (let bx = x0; bx <= x1; bx += S) {
        // The blit always writes a full S-square, so clamp the origin inward
        // rather than running off the edge of the texture.
        const ox = Math.min(bx, DENT_RES - S), oz = Math.min(by, DENT_RES - S);
        for (let y = 0; y < S; y++) {
          const src = (oz + y) * DENT_RES, dst = y * S;
          for (let x = 0; x < S; x++) data[dst + x] = half(this.dent[src + ox + x]);
        }
        sc.tex.needsUpdate = true;
        this.renderer.copyTextureToTexture(_uploadPos.set(ox, oz), sc.tex, this.texDent);
      }
    }
  }

  /* ============================================================
     tyre marks
     ============================================================ */
  _trailQuad() {
    if (this._trailUsed < this._trailPool.length) return this._trailPool[this._trailUsed++];
    const m = new THREE.Mesh(this._trailGeo, this._trailProto.clone());
    m.frustumCulled = false; m.visible = false;
    this._trailPool.push(m); this._trailUsed++;
    this.trailScene.add(m);
    return m;
  }
  /** Queue a tyre-mark segment. The buffer is a top-down orthographic view, so
      +Z in the world maps to -Y in the buffer. */
  addTrack(ax, az, bx, bz, width, strength) {
    if (this._trailUsed >= 128) return;                       // hard per-frame cap
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4 || !Number.isFinite(len)) return;
    const m = this._trailQuad();
    m.position.set((ax + bx) * 0.5, -(az + bz) * 0.5, 0);
    m.rotation.z = Math.atan2(-dz, dx);
    m.scale.set(len + width * 0.5, width, 1);
    m.material.color.setScalar(clamp(strength, 0, 1));
    m.visible = true;
  }
  _flushTrails() {
    if (this._trailUsed === 0) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.trailRT);
    r.render(this.trailScene, this.trailCam);          // one pass, all queued quads
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    for (let i = 0; i < this._trailUsed; i++) this._trailPool[i].visible = false;
    this._trailUsed = 0;
  }
  clearTrails() {
    const r = this.renderer, p = r.getRenderTarget();
    const prev = r.getClearColor(_clearCol), prevA = r.getClearAlpha();
    r.setRenderTarget(this.trailRT);
    r.setClearColor(0x000000, 1); r.clear(true, false, false);
    r.setRenderTarget(p);
    r.setClearColor(prev, prevA);
  }

  /** Wipe every rut and push the whole field back to the GPU. */
  clearDent() {
    this.dent.fill(0);
    this._slumps.length = 0;
    this._marks.length = 0;
    this._uploadRect(0, 0, this.dentRes - 1, this.dentRes - 1);
  }

  /* ============================================================
     live quality change
     ============================================================
     Re-fit everything the tier sizes without re-baking the track: bakeTrack
     takes no quality argument, so the height field is tier-independent and the
     expensive half of the load is reusable. A tier change costs a hitch, not a
     reload.

     One rule holds this together: uniform VALUES are mutated in place and the
     wrapper objects are never replaced. Every clipmap ring shares these exact
     wrappers (buildClipmap does Object.assign to share them), and dust holds
     uSunDir directly — swapping a wrapper would silently unwire both. */
  setQuality(q) {
    const prev = this.quality;
    this.quality = q;

    if (q.dentRes !== this.dentRes) this._resizeDent(q.dentRes);
    if (q.trailRes !== prev.trailRes) this._resizeTrail(q.trailRes);
    if (q.sunRes !== prev.sunRes) {
      this.sunRT.dispose();
      this.sunRT = new THREE.WebGLRenderTarget(q.sunRes, q.sunRes, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
      });
      this.uniforms.uSunMask.value = this.sunRT.texture;
    }
    this.sunMat.uniforms.uSteps.value = q.sunSteps;
    // The mask is derived from the height field and the sun angle, so there is
    // nothing to preserve — just force update() to redraw it next frame.
    this._lastSun.set(9, 9, 9);

    if (q.clipM !== prev.clipM || q.clipLevels !== prev.clipLevels || q.clipCell !== prev.clipCell) {
      this.buildClipmap();
    }
  }

  /** Reallocate the rut field, resampling what is already dug into it. Ruts are
      the record of the race so far; dropping them on a settings change would be
      a worse bug than the one this fixes. */
  _resizeDent(DR) {
    const src = this.dent, SR = this.dentRes;
    const out = new Float32Array(DR * DR);
    const ratio = SR / DR;
    for (let z = 0; z < DR; z++) {
      const sz = (z + 0.5) * ratio - 0.5;
      const z0 = Math.floor(sz), fz = sz - z0;
      const za = clamp(z0, 0, SR - 1) * SR, zb = clamp(z0 + 1, 0, SR - 1) * SR;
      for (let x = 0; x < DR; x++) {
        const sx = (x + 0.5) * ratio - 0.5;
        const x0 = Math.floor(sx), fx = sx - x0;
        const xa = clamp(x0, 0, SR - 1), xb = clamp(x0 + 1, 0, SR - 1);
        const h0 = src[za + xa] + (src[za + xb] - src[za + xa]) * fx;
        const h1 = src[zb + xa] + (src[zb + xb] - src[zb + xa]) * fx;
        out[z * DR + x] = h0 + (h1 - h0) * fz;
      }
    }

    this.dent = out;
    this.dentRes = DR;
    this.dentHalf = new Uint16Array(DR * DR);
    const half = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < out.length; i++) this.dentHalf[i] = half(out[i]);

    this.texDent.dispose();
    this.texDent = new THREE.DataTexture(this.dentHalf, DR, DR, THREE.RedFormat, THREE.HalfFloatType);
    this.texDent.magFilter = this.texDent.minFilter =
      this.manualBilinear ? THREE.NearestFilter : THREE.LinearFilter;
    this.texDent.generateMipmaps = false;
    // Upload the whole field as one texture rather than replaying it through the
    // scratch blitter: copyTextureToTexture needs a destination that is already
    // resident, and a fresh DataTexture is not until three uploads it.
    this.texDent.needsUpdate = true;

    this.uniforms.uDent.value = this.texDent;
    this.uniforms.uTexRes.value.w = DR;
    this._marks.length = 0;
    this._slumps.length = 0;
  }

  /** Reallocate the tyre-mark buffer, copying the existing marks across. */
  _resizeTrail(TR) {
    const old = this.trailRT;
    this.trailRT = new THREE.WebGLRenderTarget(TR, TR, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
    });
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(this.TRAIL_EXT, this.TRAIL_EXT),
      new THREE.MeshBasicMaterial({ map: old.texture, depthTest: false, depthWrite: false, toneMapped: false })
    );
    quad.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(quad);
    const r = this.renderer, p = r.getRenderTarget();
    r.setRenderTarget(this.trailRT);
    r.setClearColor(0x000000, 1); r.clear(true, false, false);
    r.render(sc, this.trailCam);
    r.setRenderTarget(p);
    quad.geometry.dispose(); quad.material.dispose();
    old.dispose();
    this.uniforms.uTrail.value = this.trailRT.texture;
  }

  /* ============================================================
     per-frame
     ============================================================ */
  update(dt, camera, sunDir = this.sunDir) {
    // clipmap follow + snap
    const cx = camera.position.x, cz = camera.position.z;
    this.uniforms.uCamXZ.value.set(cx, cz, 0);
    for (const L of this.levels) {
      L.mesh.position.x = Math.round(cx / L.snap) * L.snap;
      L.mesh.position.z = Math.round(cz / L.snap) * L.snap;
    }
    this.uniforms.uTime.value += dt;
    this.relax(dt);
    this._uploadDirty();
    this._flushTrails();

    // The sun does not move during a race, so this fires exactly once — but the
    // check stays, because the track-select preview does move it.
    if (sunDir.distanceToSquared(this._lastSun) > 2e-6) {
      this._lastSun.copy(sunDir);
      this.sunMat.uniforms.uSun.value.copy(sunDir);
      this.uniforms.uSunDir.value.copy(sunDir);
      const r = this.renderer, p = r.getRenderTarget();
      r.setRenderTarget(this.sunRT);
      r.render(this._sunScene, this._sunCam);
      r.setRenderTarget(p);
    }
  }

  dispose() {
    this.texMacro.dispose(); this.texFar.dispose(); this.texDetail.dispose();
    this.texDent.dispose(); this.texRoad.dispose(); this.texSurf.dispose();
    this.texBump.dispose(); this.texLat.dispose();
    this._trailTex.dispose(); this._trailGeo.dispose(); this._trailProto.dispose();
    for (const s of this.scratches) s.tex.dispose();
    this.trailRT.dispose(); this.sunRT.dispose();
    this.sunMat.dispose();
    for (const L of this.levels) { L.mesh.geometry.dispose(); L.mesh.material.dispose(); }
    this.material.dispose();
  }
}

/* ---------------- module scratch ---------------- */
const _v3a = new THREE.Vector3();
const _uploadPos = new THREE.Vector2();
const _clearCol = new THREE.Color();

/** Cross-section profile of a tyre mark: dark centre, soft edges. Uniform along
    its length so the quad can be stretched to any distance. */
function makeTrackStamp() {
  const S = 64;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const v = Math.abs((y + 0.5) / S * 2 - 1);            // 0 centre .. 1 edge
    let a = 1 - sstep(0.50, 1.0, v);
    a *= 0.80 + 0.20 * Math.cos(v * 9.0);                  // faint twin-rut relief
    const k = Math.round(clamp(a, 0, 1) * 255);
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = k;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
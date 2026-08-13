/* ============================================================
   DAY SKIES
   ------------------------------------------------------------
   Four static skies, one per track theme. Nothing here moves fast:
   the sun never moves at all (terrain bakes its occlusion mask once,
   so a moving sun would desynchronise the shadows from the ground),
   the clouds drift at a couple of degrees a minute, and the only
   thing with any real motion is the ash column over the caldera.

   Everything is a dome, a billboard, or a quad soup. There is no
   atmospheric scattering integral — a hand-tuned ramp reads better
   at 60 fps than a physically correct one at 40.
   ============================================================ */
import * as THREE from 'three';
import { makeRNG, clamp } from '../core/rng.js';
import { makeCloudSprite, makeSmokeSprite } from './textures.js';

/* ============================================================
   THEME CONTRACT — terrain.js THEMES **must match** sunDir and sunColor
   exactly, or the baked sun-occlusion mask will disagree with the shadow
   map and with the specular on the cars. These are the authoritative
   numbers; copy them, do not re-derive them.

   sunDir is a unit vector, written out to six places from
       (cos(el)cos(az), sin(el), cos(el)sin(az))
   with the elevation/azimuth noted per theme. Y is up, world is XZ.
   ============================================================ */
export const SKY_THEMES = {
  /* clean noon over an empty airfield: flat light, nothing to misread */
  training: {
    sunEl: 62, sunAz: 40,
    sunDir: { x: 0.359631, y: 0.882948, z: 0.301773 },
    sunColor: 0xfff3e2, sunIntensity: 2.85,
    hemiSky: 0xa8c8ff, hemiGround: 0x7a6a52, hemiIntensity: 0.60,
    zenith: 0x2b68c2, horizon: 0xcadef2, hazeColor: 0xc2d5e8,
    groundHaze: 0x9aa89a,
    cloudAmount: 0.55, cloudTint: 0xffffff, cloudShade: 0x93a8c2,
    cloudY: 1250, cirrus: 0.35,
    sunDiscColor: 0xfff8ee, sunAngDeg: 1.1, haloStrength: 0.55, sunGlow: 1.0,
    fogHint: 0.00050
  },

  /* late afternoon in the red rock — long shadows, warm dust in the air */
  canyon: {
    sunEl: 28, sunAz: -35,
    sunDir: { x: 0.723270, y: 0.469472, z: -0.506444 },
    sunColor: 0xffd2a0, sunIntensity: 2.95,
    hemiSky: 0x9dbde8, hemiGround: 0x8c6444, hemiIntensity: 0.55,
    zenith: 0x2f63ae, horizon: 0xf0c491, hazeColor: 0xe0b58a,
    groundHaze: 0xb08256,
    cloudAmount: 0.62, cloudTint: 0xffe6cc, cloudShade: 0xa08498,
    cloudY: 1500, cirrus: 0.55,
    sunDiscColor: 0xfff0d2, sunAngDeg: 1.6, haloStrength: 0.95, sunGlow: 1.25,
    fogHint: 0.00068
  },

  /* mountain morning: the sun still low behind the ridge, mist in the valleys */
  forest: {
    sunEl: 22, sunAz: 118,
    sunDir: { x: -0.435229, y: 0.374607, z: 0.818656 },
    sunColor: 0xffe0b4, sunIntensity: 2.25,
    hemiSky: 0xb6d2e6, hemiGround: 0x4c5638, hemiIntensity: 0.75,
    zenith: 0x3d80bc, horizon: 0xe2ece6, hazeColor: 0xcedcd4,
    groundHaze: 0x9aab9c,
    cloudAmount: 1.00, cloudTint: 0xf6f0e6, cloudShade: 0x8e9aa6,
    cloudY: 900, cirrus: 0.30,
    sunDiscColor: 0xfff2d8, sunAngDeg: 1.4, haloStrength: 1.10, sunGlow: 1.15,
    fogHint: 0.00105
  },

  /* caldera dusk: the sun is a coin behind the ash, the horizon glows on its own */
  volcano: {
    sunEl: 11, sunAz: -152,
    sunDir: { x: -0.866729, y: 0.190809, z: -0.460847 },
    sunColor: 0xff8c4e, sunIntensity: 1.55,
    hemiSky: 0x5a3038, hemiGround: 0x2c1c16, hemiIntensity: 0.65,
    zenith: 0x241c2c, horizon: 0x8e3a18, hazeColor: 0x6e2c1c,
    groundHaze: 0x40201a,
    cloudAmount: 0.50, cloudTint: 0x6a4a44, cloudShade: 0x241614,
    cloudY: 1100, cirrus: 0.25,
    sunDiscColor: 0xff9a52, sunAngDeg: 3.4, haloStrength: 1.35, sunGlow: 0.85,
    fogHint: 0.00130,
    // ash + the thing making it: a plume off the caldera, downwind of the track
    ash: 0.85, ashColor: 0x3a2a2a, emberColor: 0xff4a12, emberGlow: 0.9,
    plume: { dir: { x: -0.62, z: 0.78 }, dist: 3400, baseY: 120, height: 2600, count: 1.0 }
  }
};

/* Cloud counts and dome tessellation by tier. `stars` is gone from the sky but
   still sits in QUALITY — engine.js is not ours to prune. */
const SKY_BUDGET = {
  LOW:    { domeW: 24, domeH: 14, clusters: 10, puffs: 4, plume: 10, ashOct: 2 },
  MEDIUM: { domeW: 32, domeH: 20, clusters: 16, puffs: 5, plume: 16, ashOct: 3 },
  HIGH:   { domeW: 48, domeH: 28, clusters: 22, puffs: 6, plume: 22, ashOct: 3 },
  ULTRA:  { domeW: 64, domeH: 36, clusters: 26, puffs: 7, plume: 28, ashOct: 4 }
};

const DOME_R = 9000;
const SUN_D = 7600;
const CLOUD_R0 = 2400;      // clouds live between these radii, on a flat deck
const CLOUD_R1 = 7400;

/* shared scratch — nothing in update() allocates */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/* value noise for the ash, three lines of GLSL and no texture fetch */
const GLSL_NOISE = /* glsl */`
  float h31(vec3 p){ p = fract(p*0.3183099 + vec3(0.71,0.113,0.419)); p += dot(p, p.yzx+19.19); return fract((p.x+p.y)*p.z); }
  float n31(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z); }
`;

export class Sky {
  /**
   * @param renderer  WebGLRenderer (PMREM needs it)
   * @param scene     the scene to attach to; background is cleared, fog is set
   * @param quality   a QUALITY tier object from core/engine.js
   * @param themeName 'training' | 'canyon' | 'forest' | 'volcano'
   */
  constructor(renderer, scene, quality, themeName = 'training') {
    this.renderer = renderer;
    this.scene = scene;
    this.quality = quality;
    this.themeName = SKY_THEMES[themeName] ? themeName : 'training';
    this.theme = SKY_THEMES[this.themeName];
    this.budget = SKY_BUDGET[(quality && quality.name) || 'HIGH'] || SKY_BUDGET.HIGH;
    this._seed = 0x5C1 ^ (this.themeName.charCodeAt(0) * 7919);

    const t = this.theme;
    /* STATIC per track. terrain.js bakes shadows against this exact vector. */
    this.sunDir = new THREE.Vector3(t.sunDir.x, t.sunDir.y, t.sunDir.z).normalize();
    this.sunColor = new THREE.Color(t.sunColor);
    this.hazeColor = new THREE.Color(t.hazeColor);
    this.horizonColor = new THREE.Color(t.horizon);
    this.zenithColor = new THREE.Color(t.zenith);
    this.sunIntensity = t.sunIntensity;

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    scene.add(this.group);

    // the dome paints every pixel the world does not cover
    scene.background = null;
    this.fog = new THREE.FogExp2(t.hazeColor, t.fogHint);
    this._prevFog = scene.fog || null;
    scene.fog = this.fog;

    this._time = 0;
    this._envDirty = true;
    this.envRT = null;

    this._buildDome();
    this._buildSun();
    this._buildClouds();
    if (t.plume) this._buildPlume();
    this._buildEnv();
  }

  /* ---------------- the dome ---------------- */
  _buildDome() {
    const t = this.theme;
    const b = this.budget;
    const ash = !!t.ash;
    const geo = new THREE.SphereGeometry(DOME_R, b.domeW, b.domeH);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, fog: false,
      // no depth at all: this is a background fill, drawn before anything opaque
      depthWrite: false, depthTest: false,
      defines: ash ? { ASH: 1, ASH_OCT: b.ashOct } : {},
      uniforms: {
        uZenith: { value: this.zenithColor },
        uHorizon: { value: this.horizonColor },
        uHaze: { value: this.hazeColor },
        uGround: { value: new THREE.Color(t.groundHaze) },
        uSunCol: { value: new THREE.Color(t.sunDiscColor) },
        uSunDir: { value: this.sunDir },
        uHalo: { value: t.haloStrength },
        uTime: { value: 0 },
        uAsh: { value: t.ash || 0 },
        uAshCol: { value: new THREE.Color(t.ashColor || 0x333333) },
        uEmberCol: { value: new THREE.Color(t.emberColor || 0xff4400) },
        uEmber: { value: t.emberGlow || 0 },
        uPlumeDir: { value: new THREE.Vector2(t.plume ? t.plume.dir.x : 1, t.plume ? t.plume.dir.z : 0).normalize() }
      },
      vertexShader: /* glsl */`
        varying vec3 vD;
        void main(){
          vD = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vD;
        uniform vec3 uZenith, uHorizon, uHaze, uGround, uSunCol, uSunDir, uAshCol, uEmberCol;
        uniform float uHalo, uTime, uAsh, uEmber;
        uniform vec2 uPlumeDir;
        ${GLSL_NOISE}
        void main(){
          vec3 d = normalize(vD);
          float h = d.y;

          // zenith ramp. The exponent, not the endpoints, is what makes a sky
          // look like a sky: linear gradients read as a backdrop.
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));

          // haze band straddling the horizon line
          col = mix(col, uHaze, exp(-abs(h) * 7.5) * 0.80);

          // below the horizon the dome only shows past the edge of the world
          col = mix(col, uGround, smoothstep(-0.02, -0.32, h));

          // forward scatter around the sun — wide, warm, no disc (that is a billboard)
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunCol * (pow(s, 46.0) * 0.55 + pow(s, 6.0) * 0.17) * uHalo;

        #ifdef ASH
          // slow shear: two layers sliding over each other at different speeds
          vec3 p = d * 2.4;
          float n = 0.0, a = 0.58, f = 1.0;
          for (int i = 0; i < ASH_OCT; i++){
            n += n31(p * f + vec3(uTime * 0.0032 * f, uTime * 0.0011, 0.0)) * a;
            f *= 2.17; a *= 0.52;
          }
          float band = exp(-max(h, 0.0) * 1.9);
          col = mix(col, uAshCol, clamp((n - 0.40) * 1.9, 0.0, 1.0) * band * uAsh);

          // the caldera itself, burning a hole in the horizon behind the ash
          vec2 hz = normalize(vec2(d.x, d.z) + 1e-5);
          float toward = max(dot(hz, uPlumeDir), 0.0);
          col += uEmberCol * exp(-abs(h) * 14.0) * pow(toward, 2.6) * uEmber;
          col += uEmberCol * exp(-abs(h + 0.01) * 26.0) * 0.16 * uEmber;   // the thin hot line
        #endif

          gl_FragColor = vec4(max(col, 0.0), 1.0);
        }`
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.domeMat = mat;
    this.group.add(this.dome);
  }

  /* ---------------- sun disc ----------------
     Bright enough to clear the bloom threshold and nothing more; the veiling
     glare in the final pass does the rest of the work. */
  _buildSun() {
    const t = this.theme;
    const rad = SUN_D * Math.tan(t.sunAngDeg * Math.PI / 360);
    const W = rad / 0.16;                       // the disc occupies r=0.16 of the quad
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCol: { value: new THREE.Color(t.sunDiscColor) },
        uGlow: { value: t.sunGlow }
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv; uniform vec3 uCol; uniform float uGlow;
        void main(){
          vec2 d = (vUv - 0.5) * 2.0;
          float r = length(d);
          float disc = 1.0 - smoothstep(0.150, 0.176, r);       // soft edge: there is air here
          float limb = mix(1.0, 0.86, smoothstep(0.0, 0.176, r));
          float glow = pow(max(0.0, 1.0 - r), 3.4) * 0.55 + exp(-r * 7.0) * 0.30;
          vec3 col = uCol * (disc * limb * 9.0 + glow * 2.4 * uGlow);
          float a = clamp(disc + glow * 1.6, 0.0, 1.0);
          if (a < 0.003) discard;
          gl_FragColor = vec4(col, a);
        }`
    });
    // `sunMesh`, not `sun`: engine.sun is the DirectionalLight and confusing the
    // two costs an afternoon
    this.sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, W * 2), mat);
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = -995;
    this.sunMesh.position.copy(this.sunDir).multiplyScalar(SUN_D);   // static in group space
    this.sunMat = mat;
    this.group.add(this.sunMesh);
  }

  /* ---------------- clouds ----------------
     A quad soup, not instancing: at this count the draw call is identical and
     a plain BufferGeometry cannot trip over an instancing path.

     Two layers in one buffer — cumulus (squash ~0.6) and cirrus (squash ~0.15,
     low alpha, higher up) — separated by the aLayer attribute. */
  _buildClouds() {
    const t = this.theme;
    const b = this.budget;
    const rng = makeRNG(this._seed ^ 0x1D0);
    const nClu = Math.max(3, Math.round(b.clusters * t.cloudAmount));
    const nCir = Math.round(nClu * (t.cirrus || 0));
    const quads = nClu * b.puffs + nCir;
    if (quads <= 0) { this.clouds = null; return; }

    const pos = new Float32Array(quads * 4 * 3);
    const corner = new Float32Array(quads * 4 * 2);
    const param = new Float32Array(quads * 4 * 4);      // size, seed, alpha, squash
    const layer = new Float32Array(quads * 4);
    const idx = new Uint16Array(quads * 6);
    const CX = [-1, 1, 1, -1], CY = [-1, -1, 1, 1];

    let q = 0;
    const put = (x, y, z, size, alpha, squash, lay) => {
      const seed = rng();
      for (let k = 0; k < 4; k++) {
        const v = q * 4 + k;
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        corner[v * 2] = CX[k]; corner[v * 2 + 1] = CY[k];
        param[v * 4] = size; param[v * 4 + 1] = seed;
        param[v * 4 + 2] = alpha; param[v * 4 + 3] = squash;
        layer[v] = lay;
      }
      const o = q * 6, v0 = q * 4;
      idx[o] = v0; idx[o + 1] = v0 + 1; idx[o + 2] = v0 + 2;
      idx[o + 3] = v0; idx[o + 4] = v0 + 2; idx[o + 5] = v0 + 3;
      q++;
    };

    // cumulus: clusters of overlapping puffs, area-uniform out to the horizon
    for (let c = 0; c < nClu; c++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (CLOUD_R1 - CLOUD_R0) + CLOUD_R0;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const cy = t.cloudY * (0.80 + rng() * 0.55);
      const scale = r / 4200;                                   // keep angular size steady
      const base = (240 + rng() * 300) * scale;
      const spread = base * 1.35;
      for (let p = 0; p < b.puffs; p++) {
        const f = p / Math.max(1, b.puffs - 1);
        put(cx + (rng() - 0.5) * spread * 2.4,
            cy + (rng() - 0.5) * spread * 0.55 + (0.5 - f) * spread * 0.30,
            cz + (rng() - 0.5) * spread * 2.4,
            base * (0.55 + rng() * 0.75),
            0.62 + rng() * 0.30,
            0.52 + rng() * 0.22,
            0);
      }
    }
    // cirrus: wide flat smears well above the cumulus deck
    for (let c = 0; c < nCir; c++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (CLOUD_R1 - CLOUD_R0) + CLOUD_R0 * 1.4;
      put(Math.cos(a) * r, t.cloudY * (2.1 + rng() * 0.9), Math.sin(a) * r,
          (900 + rng() * 1100) * (r / 4200),
          0.10 + rng() * 0.16,
          0.10 + rng() * 0.12,
          1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aParam', new THREE.BufferAttribute(param, 4));
    geo.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CLOUD_R1 * 2);

    this.cloudTex = makeCloudSprite(this.budget === SKY_BUDGET.LOW ? 128 : 256, { seed: 3 });
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      blending: THREE.NormalBlending, side: THREE.DoubleSide,
      uniforms: {
        uTex: { value: this.cloudTex },
        uLit: { value: new THREE.Color(t.cloudTint) },
        uShade: { value: new THREE.Color(t.cloudShade) },
        uSunScreen: { value: new THREE.Vector2(0, 1) },
        uTime: { value: 0 },
        uOpacity: { value: 1 }
      },
      vertexShader: /* glsl */`
        attribute vec2 aCorner; attribute vec4 aParam; attribute float aLayer;
        varying vec2 vC; varying float vA, vLayer;
        uniform float uTime;
        void main(){
          vC = aCorner; vA = aParam.z; vLayer = aLayer;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // screen-aligned: a distant cloud has no meaningful orientation, and
          // billboarding in view space costs two adds
          float s = aParam.x * (1.0 + 0.035 * sin(uTime * 0.06 + aParam.y * 6.2832));
          mv.xy += aCorner * vec2(s, s * aParam.w);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying vec2 vC; varying float vA, vLayer;
        uniform sampler2D uTex; uniform vec3 uLit, uShade;
        uniform vec2 uSunScreen; uniform float uOpacity;
        void main(){
          float a = texture2D(uTex, vC * 0.5 + 0.5).a;
          if (a < 0.004) discard;
          // "lit side" is screen-space and a lie, but it is the lie that makes a
          // flat billboard read as a volume
          float lit = 0.5 + 0.5 * dot(normalize(vC + vec2(1e-4)), uSunScreen);
          lit = mix(lit * lit, 0.72 + 0.28 * lit, vLayer);
          vec3 col = mix(uShade, uLit, lit);
          col += uLit * pow(lit, 5.0) * (1.0 - a) * 0.85;        // silver where it thins
          gl_FragColor = vec4(col, a * vA * uOpacity);
        }`
    });
    this.clouds = new THREE.Mesh(geo, mat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -990;
    this.cloudMat = mat;
    this.cloudGroup = new THREE.Group();          // rotates, very slowly
    this.cloudGroup.add(this.clouds);
    this.group.add(this.cloudGroup);
  }

  /* ---------------- the ash column over the caldera ---------------- */
  _buildPlume() {
    const t = this.theme, P = t.plume;
    const n = Math.round(this.budget.plume * (P.count || 1));
    const rng = makeRNG(this._seed ^ 0x9A5);
    const pos = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const param = new Float32Array(n * 4 * 4);    // size, phase, jitterAngle, alpha
    const idx = new Uint16Array(n * 6);
    const CX = [-1, 1, 1, -1], CY = [-1, -1, 1, 1];
    const dl = Math.hypot(P.dir.x, P.dir.z) || 1;
    const bx = (P.dir.x / dl) * P.dist, bz = (P.dir.z / dl) * P.dist;

    for (let q = 0; q < n; q++) {
      const size = 220 + rng() * 200;
      const phase = q / n + rng() * 0.02;
      const jit = rng() * Math.PI * 2;
      const alpha = 0.42 + rng() * 0.32;
      for (let k = 0; k < 4; k++) {
        const v = q * 4 + k;
        pos[v * 3] = bx; pos[v * 3 + 1] = P.baseY; pos[v * 3 + 2] = bz;
        corner[v * 2] = CX[k]; corner[v * 2 + 1] = CY[k];
        param[v * 4] = size; param[v * 4 + 1] = phase;
        param[v * 4 + 2] = jit; param[v * 4 + 3] = alpha;
      }
      const o = q * 6, v0 = q * 4;
      idx[o] = v0; idx[o + 1] = v0 + 1; idx[o + 2] = v0 + 2;
      idx[o + 3] = v0; idx[o + 4] = v0 + 2; idx[o + 5] = v0 + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aParam', new THREE.BufferAttribute(param, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), P.dist * 2);

    this.smokeTex = makeSmokeSprite(192, { seed: 17 });
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      blending: THREE.NormalBlending, side: THREE.DoubleSide,
      uniforms: {
        uTex: { value: this.smokeTex },
        uLit: { value: new THREE.Color(0x6b5a52) },
        uShade: { value: new THREE.Color(0x1d1412) },
        uHot: { value: new THREE.Color(t.emberColor || 0xff4a12) },
        uSunScreen: { value: new THREE.Vector2(0, 1) },
        uTime: { value: 0 },
        uH: { value: P.height },
        uRise: { value: 0.017 }
      },
      vertexShader: /* glsl */`
        attribute vec2 aCorner; attribute vec4 aParam;
        varying vec2 vC; varying float vA, vT;
        uniform float uTime, uH, uRise;
        void main(){
          float t = fract(aParam.y + uTime * uRise);
          vT = t;
          vec3 p = position;
          p.y += t * uH;
          // shear downwind and wander as it climbs
          float w = t * t;
          p.x += cos(aParam.z) * (60.0 + 520.0 * w) + 900.0 * w;
          p.z += sin(aParam.z) * (60.0 + 520.0 * w) - 420.0 * w;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float s = aParam.x * (0.45 + 2.6 * t);
          mv.xy += aCorner * s;
          vC = aCorner;
          vA = aParam.w * smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.45, 1.0, t));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying vec2 vC; varying float vA, vT;
        uniform sampler2D uTex; uniform vec3 uLit, uShade, uHot; uniform vec2 uSunScreen;
        void main(){
          float a = texture2D(uTex, vC * 0.5 + 0.5).a;
          if (a < 0.004) discard;
          float lit = 0.5 + 0.5 * dot(normalize(vC + vec2(1e-4)), uSunScreen);
          vec3 col = mix(uShade, uLit, lit * lit);
          col += uHot * (1.0 - smoothstep(0.0, 0.16, vT)) * 1.6;   // still glowing at the vent
          gl_FragColor = vec4(col, a * vA);
        }`
    });
    this.plume = new THREE.Mesh(geo, mat);
    this.plume.frustumCulled = false;
    this.plume.renderOrder = -992;
    this.plumeMat = mat;
    this.group.add(this.plume);
  }

  /* ---------------- image-based lighting ----------------
     A 4-second job at load and then never again unless someone asks: this is
     what puts sky colour in the car paint and the glass. Same ramp as the dome,
     minus the ash, plus a ground bounce the dome does not need. */
  _buildEnv() {
    const t = this.theme;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        uZenith: { value: this.zenithColor },
        uHorizon: { value: this.horizonColor },
        uHaze: { value: this.hazeColor },
        uGround: { value: new THREE.Color(t.groundHaze) },
        uSunCol: { value: new THREE.Color(t.sunDiscColor) },
        uSunDir: { value: this.sunDir },
        uSunInt: { value: t.sunIntensity },
        uHalo: { value: t.haloStrength }
      },
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vD;
        uniform vec3 uZenith, uHorizon, uHaze, uGround, uSunCol, uSunDir;
        uniform float uSunInt, uHalo;
        void main(){
          vec3 d = normalize(vD);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
          col = mix(col, uHaze, exp(-abs(h) * 7.5) * 0.80);
          // the lower hemisphere is ground bounce, not sky: warm, dim, and the
          // reason the underside of a car is not black
          col = mix(col, uGround * 0.55, smoothstep(0.0, -0.45, h));
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunCol * (pow(s, 46.0) * 0.55 + pow(s, 6.0) * 0.17) * uHalo;
          col += uSunCol * uSunInt * 3.4 * smoothstep(0.9986, 0.9994, s);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    this.envGeo = new THREE.SphereGeometry(100, 24, 16);
    this.envScene.add(new THREE.Mesh(this.envGeo, this.envMat));
  }

  refreshEnv() {
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 4000);
    if (old) old.dispose();
    this.scene.environment = this.envRT.texture;
    this._envDirty = false;
  }

  markEnvDirty() { this._envDirty = true; }

  /** Distance fog is the sky's job, but it touches every lit material in the
      scene — this is the one switch for anyone who needs it off. */
  setFogEnabled(on) { this.scene.fog = on ? this.fog : this._prevFog; }

  /* ---------------- per-frame ---------------- */
  update(dt, camera, elapsed) {
    this._time = elapsed === undefined ? this._time + dt : elapsed;
    const T = this._time;

    // the whole sky rides with the camera: nothing here has a position in the world
    this.group.position.copy(camera.position);
    this.sunMesh.quaternion.copy(camera.quaternion);

    // sun direction in view space -> which way the clouds are lit on screen.
    // Derived from the camera quaternion rather than matrixWorldInverse, which
    // the renderer has not refreshed yet at this point in the frame.
    _v.copy(this.sunDir).applyQuaternion(_q.copy(camera.quaternion).invert());
    const l = Math.hypot(_v.x, _v.y);
    const sx = l > 1e-4 ? _v.x / l : 0, sy = l > 1e-4 ? _v.y / l : 1;

    if (this.clouds) {
      this.cloudGroup.rotation.y = T * 0.00055;     // ~2 degrees a minute
      this.cloudMat.uniforms.uTime.value = T;
      this.cloudMat.uniforms.uSunScreen.value.set(sx, sy);
    }
    if (this.plume) {
      this.plumeMat.uniforms.uTime.value = T;
      this.plumeMat.uniforms.uSunScreen.value.set(sx, sy);
    }
    if (this.theme.ash) this.domeMat.uniforms.uTime.value = T;

    if (this._envDirty) this.refreshEnv();
  }

  /**
   * Screen position + visibility of the sun, for engine.final's uSunUV.
   * out = Vector3(u, v, visibility). Convenience only — the race loop may do
   * this itself; it is here so the projection lives next to the sun.
   */
  projectSun(camera, out) {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    _v2.copy(camera.position).addScaledVector(this.sunDir, SUN_D).project(camera);
    const front = this.sunDir.dot(camera.getWorldDirection(_v)) > 0;
    const vis = front
      ? clamp(1 - Math.max(Math.abs(_v2.x), Math.abs(_v2.y)) * 0.42, 0, 1) * clamp(this.sunDir.y * 6, 0, 1)
      : 0;
    return out.set(_v2.x * 0.5 + 0.5, _v2.y * 0.5 + 0.5, vis);
  }

  /** Rebuild only what the tier actually changes: dome tessellation and clouds. */
  setQuality(q) {
    const b = SKY_BUDGET[(q && q.name) || 'HIGH'] || SKY_BUDGET.HIGH;
    this.quality = q;
    if (b === this.budget) return;
    this.budget = b;

    this.group.remove(this.dome);
    this.dome.geometry.dispose(); this.dome.material.dispose();
    this._buildDome();

    if (this.clouds) {
      this.group.remove(this.cloudGroup);
      this.clouds.geometry.dispose(); this.clouds.material.dispose();
      this.cloudTex.dispose();
      this.clouds = null;
    }
    this._buildClouds();

    if (this.plume) {
      this.group.remove(this.plume);
      this.plume.geometry.dispose(); this.plume.material.dispose();
      this.smokeTex.dispose();
      this.plume = null;
      this._buildPlume();
    }
    this._envDirty = true;
  }

  dispose() {
    this.scene.remove(this.group);
    this.dome.geometry.dispose(); this.dome.material.dispose();
    this.sunMesh.geometry.dispose(); this.sunMesh.material.dispose();
    if (this.clouds) {
      this.clouds.geometry.dispose(); this.clouds.material.dispose();
      this.cloudTex.dispose();
    }
    if (this.plume) {
      this.plume.geometry.dispose(); this.plume.material.dispose();
      this.smokeTex.dispose();
    }
    this.envGeo.dispose();
    this.envMat.dispose();
    this.pmrem.dispose();
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    if (this.scene.environment) this.scene.environment = null;
    if (this.scene.fog === this.fog) this.scene.fog = this._prevFog;
    this.clouds = this.plume = this.dome = this.sunMesh = null;
  }
}

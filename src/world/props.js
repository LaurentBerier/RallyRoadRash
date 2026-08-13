/* ============================================================
   THINGS BESIDE THE ROAD
   ------------------------------------------------------------
   Two populations, one class:

   • SCATTER — theme decoration, seeded from trackDef.seed and placed
     by rejection sampling against terrain.onRoad(), the checkpoint
     discs and the local slope. Instanced, and always placed at the
     densest tier so lowering quality HIDES A SUFFIX rather than
     re-rolling the scatter (a boulder is a collider; sliding one
     sideways while somebody is driving past it is a bug).

   • FURNITURE — derived from trackData: start gantry, checkpoint
     gates, barrier runs along the authored wall spans, arrow boards
     before hairpins and jumps, and the finish stripe on the ground.

   Collision is a 24 m bucket grid over circles and segments. resolve()
   pushes the car out and returns the impact speed so race.js can route
   it to damage and audio with one call.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRNG, vnoise, fbm, clamp, sstep } from '../core/rng.js';
import { PLAYABLE_EXT } from './terrain.js';

/* Placement is always done for the densest tier. Keep in step with
   QUALITY.ultra.boulders in core/engine.js. */
const MAX_SCATTER = 2200;
const GRID_CELL = 24, GRID_HALF = 640;
const CAR_R = 1.15;              // fallback body radius if a vehicle has none

/* ---------------- module scratch (no per-frame allocation) ---------------- */
const _dummy = new THREE.Object3D();
const _near = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
const _pp = { x: 0, y: 0, z: 0 };
const _dd = { x: 0, z: 0 };

/* ============================================================
   1.  PROCEDURAL GEOMETRY
   ============================================================ */

/** Irregular rock. Three octaves of displacement then a radius quantise, so
    the silhouette is angular at every scale you can see it at. */
function boulderGeo(seed, detail = 2, squash = 0.76) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    n.copy(v).normalize();
    let d = 1.0;
    d += (fbm(n.x * 1.7 + seed, n.z * 1.7 - seed, 2, 2.1, 0.5, seed | 0) - 0.5) * 0.66;
    d += (fbm(n.x * 4.3 + seed * 2, n.y * 4.3 - seed, 3, 2.1, 0.5, (seed * 13) | 0) - 0.5) * 0.30;
    d += (vnoise(n.x * 11.0 + seed * 5, n.z * 11.0 - seed * 3, (seed * 31) | 0) - 0.5) * 0.11;
    d = Math.round(d * 11) / 11 * 0.34 + d * 0.66;      // facet the fracture planes
    d *= 1 - 0.32 * Math.max(0, -n.y);                  // flatter where it meets the ground
    v.copy(n).multiplyScalar(d);
    v.y *= squash;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.deleteAttribute('uv');                              // triplanar in the shader
  return g;
}

/** A hoodoo: stacked resistant caps on a soft column, which is exactly how the
    real ones form and the only reason they read at 200 m. */
function hoodooGeo(seed) {
  const rng = makeRNG((seed * 7919) | 1);
  const parts = [];
  let y = 0;
  const n = 3 + Math.floor(rng() * 3);
  let r = 0.9 + rng() * 0.5;
  for (let i = 0; i < n; i++) {
    const hgt = 0.7 + rng() * 1.5;
    const rTop = r * (0.55 + rng() * 0.30);
    const seg = new THREE.CylinderGeometry(rTop, r, hgt, 9, 1);
    seg.translate((rng() - 0.5) * 0.18, y + hgt * 0.5, (rng() - 0.5) * 0.18);
    parts.push(seg);
    y += hgt;
    // the cap: a wider slab that shelters the column beneath it
    if (rng() < 0.6 && i < n - 1) {
      const cap = new THREE.CylinderGeometry(rTop * 1.35, rTop * 1.42, 0.26, 9, 1);
      cap.translate(0, y + 0.13, 0);
      parts.push(cap);
      y += 0.26;
    }
    r = rTop;
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Conifer: a trunk and three stacked skirts. Merged so one instanced draw
    covers the whole tree. */
function pineGeo(seed) {
  const rng = makeRNG((seed * 104729) | 1);
  const h = 5.5 + rng() * 5.0;
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.10, 0.20, h * 0.42, 6, 1);
  trunk.translate(0, h * 0.21, 0);
  parts.push(trunk);
  const tiers = 3 + (rng() < 0.5 ? 1 : 0);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = (1.55 - t * 0.85) * (0.85 + rng() * 0.3);
    const ch = h * (0.42 - t * 0.09);
    const cone = new THREE.ConeGeometry(r, ch, 7, 1);
    cone.translate(0, h * (0.22 + t * 0.22) + ch * 0.5, 0);
    parts.push(cone);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  g.userData.height = h;
  return g;
}

/** Fallen log, lying along X with a stub or two. */
function logGeo(seed) {
  const rng = makeRNG((seed * 15485863) | 1);
  const len = 3.2 + rng() * 4.5, r = 0.22 + rng() * 0.18;
  const parts = [];
  const body = new THREE.CylinderGeometry(r * 0.8, r, len, 8, 1);
  body.rotateZ(Math.PI / 2);
  body.translate(0, r, 0);
  parts.push(body);
  for (let i = 0; i < 2; i++) {
    if (rng() > 0.55) continue;
    const s = new THREE.CylinderGeometry(0.05, 0.09, 0.5 + rng(), 5, 1);
    s.rotateZ((rng() - 0.5) * 1.6);
    s.translate((rng() - 0.5) * len * 0.7, r + 0.25, 0);
    parts.push(s);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Columnar basalt: a hexagonal prism, snapped off at an angle. */
function basaltGeo(seed) {
  const rng = makeRNG((seed * 32452843) | 1);
  const parts = [];
  const n = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const h = 1.0 + rng() * 3.4;
    const r = 0.35 + rng() * 0.4;
    const c = new THREE.CylinderGeometry(r, r * 1.04, h, 6, 1);
    c.rotateY(rng() * 6.283);
    c.rotateZ((rng() - 0.5) * 0.42);
    c.translate((rng() - 0.5) * 1.7, h * 0.46, (rng() - 0.5) * 1.7);
    parts.push(c);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Spatter cone around a vent — open at the top so it reads as a hole. */
function ventGeo(seed) {
  const rng = makeRNG((seed * 49979687) | 1);
  const h = 1.4 + rng() * 2.2;
  const g = new THREE.CylinderGeometry(0.55 + rng() * 0.4, 2.1 + rng() * 1.4, h, 12, 1, true);
  g.translate(0, h * 0.5, 0);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Marker cone with a base. */
function coneGeo() {
  const parts = [
    new THREE.ConeGeometry(0.24, 0.68, 10, 1).translate(0, 0.36, 0),
    new THREE.BoxGeometry(0.52, 0.05, 0.52).translate(0, 0.025, 0)
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Stack of three tyres. Open cylinders, not tori: a torus of any usable
    smoothness is 170 triangles and there are four hundred of these — from a
    moving car the silhouette is a stack of dark rings either way. */
function tyreStackGeo() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.CylinderGeometry(0.52, 0.52, 0.28, 11, 1, true);
    t.translate(0, 0.16 + i * 0.29, 0);
    parts.push(t);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/* ---------------- materials ---------------- */

/** Triplanar rock surface injected into a standard material: no UVs needed on
    an arbitrary lump, world-space so neighbouring rocks never repeat, and
    faded with distance so a pebble at 80 m is not a pixel-sized noise
    generator. */
function rockMaterial(color, dustCol) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.93, metalness: 0.0 });
  const dc = new THREE.Color(dustCol);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDustCol = { value: new THREE.Vector3(dc.r, dc.g, dc.b) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRkW; varying vec3 vRkN;')
      // After <begin_vertex> both `transformed` and `objectNormal` exist. The
      // instance matrix has to be applied by hand — every rock carries its own
      // rotation, and without it the detail sits in the wrong place.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 rkP = vec4(transformed, 1.0);
          vec3 rkN = objectNormal;
          #ifdef USE_INSTANCING
            rkP = instanceMatrix * rkP;
            rkN = mat3(instanceMatrix) * rkN;
          #endif
          vRkW = (modelMatrix * rkP).xyz;
          vRkN = normalize(mat3(modelMatrix) * rkN);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRkW; varying vec3 vRkN; uniform vec3 uDustCol;
        float rkH(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
        float rkN2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(rkH(i),rkH(i+vec2(1,0)),f.x), mix(rkH(i+vec2(0,1)),rkH(i+vec2(1,1)),f.x), f.y); }
        float rkF(vec2 p){ return rkN2(p)*0.55 + rkN2(p*2.13+7.7)*0.28 + rkN2(p*4.31+19.3)*0.17; }
        float rkTri(vec3 w, vec3 n, float s){
          vec3 b = pow(abs(n), vec3(4.0)); b /= (b.x+b.y+b.z);
          return rkF(w.yz*s)*b.x + rkF(w.xz*s)*b.y + rkF(w.xy*s)*b.z;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 rn = normalize(vRkN);
          float fade = 1.0 - smoothstep(25.0, 110.0, length(vViewPosition));
          float coarse = rkTri(vRkW, rn, 1.7);
          float fine   = mix(0.5, rkTri(vRkW, rn, 8.0), fade);
          diffuseColor.rgb *= 0.72 + 0.34*coarse + 0.16*fine;
          // dust settles on anything facing up
          float up = smoothstep(0.15, 0.85, rn.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, uDustCol, up*(0.22 + 0.28*coarse));
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= 0.84 + 0.24*rkTri(vRkW, normalize(vRkN), 3.0);`);
  };
  m.customProgramCacheKey = () => 'rallye-rock-' + color.toString(16);
  return m;
}

/* ---------------- canvas textures ---------------- */
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

function gantryTex(accent) {
  return canvasTex(1024, 160, (g, w, h) => {
    g.fillStyle = '#14161c'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10);
    // chevron run either side of the wordmark
    g.fillStyle = 'rgba(255,255,255,0.10)';
    for (let x = -40; x < w; x += 46) {
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x + 22, 14);
      g.lineTo(x + 44, h - 14); g.lineTo(x + 22, h - 14); g.closePath(); g.fill();
    }
    g.fillStyle = '#0e1014'; g.fillRect(w * 0.26, 16, w * 0.48, h - 32);
    g.font = '800 96px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#f2efe6'; g.fillText('RALLYE', w * 0.5, h * 0.5 + 4);
    g.font = '600 22px ui-monospace, monospace';
    g.fillStyle = accent; g.fillText('START / FINISH', w * 0.5, h - 26);
  });
}

function bannerTex(label, accent) {
  return canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#171a20'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, h - 8, w, 8);
    g.font = '700 44px ui-monospace, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#e8e4da'; g.fillText(label, w * 0.5, h * 0.46);
  });
}

/** Chevron board. dir = -1 left, +1 right, 0 = caution (jump ahead). */
function arrowTex(dir) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = dir === 0 ? '#d8231c' : '#f0b21a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#14161c'; g.lineWidth = 0;
    if (dir === 0) {
      // exclamation slab: reads as "something is about to happen"
      g.fillRect(w * 0.42, h * 0.16, w * 0.16, h * 0.44);
      g.beginPath(); g.arc(w * 0.5, h * 0.76, w * 0.09, 0, 6.2832); g.fill();
    } else {
      for (let i = 0; i < 3; i++) {
        const x0 = w * (0.10 + i * 0.26);
        g.beginPath();
        if (dir < 0) { g.moveTo(x0 + w * 0.22, h * 0.12); g.lineTo(x0, h * 0.5); g.lineTo(x0 + w * 0.22, h * 0.88); g.lineTo(x0 + w * 0.30, h * 0.88); g.lineTo(x0 + w * 0.08, h * 0.5); g.lineTo(x0 + w * 0.30, h * 0.12); }
        else { g.moveTo(x0, h * 0.12); g.lineTo(x0 + w * 0.22, h * 0.5); g.lineTo(x0, h * 0.88); g.lineTo(x0 + w * 0.08, h * 0.88); g.lineTo(x0 + w * 0.30, h * 0.5); g.lineTo(x0 + w * 0.08, h * 0.12); }
        g.closePath(); g.fill();
      }
    }
  });
}

function checkerTex() {
  return canvasTex(256, 64, (g, w, h) => {
    const n = 16, cw = w / n, ch = h / 2;
    for (let y = 0; y < 2; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = ((x + y) & 1) ? '#f0ede4' : '#16181d';
      g.fillRect(x * cw, y * ch, cw + 1, ch + 1);
    }
  });
}

function railTex(accent) {
  return canvasTex(256, 32, (g, w, h) => {
    g.fillStyle = '#dedbd2'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 32, h);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, h - 6, w, 6);
  });
}

/* ============================================================
   2.  THEME RECIPES
   ============================================================ */
const RECIPES = {
  training: {
    accent: '#2ad2ff',
    rock: 0x7a7166, dust: 0x8b8578,
    kinds: [
      { id: 'cone', share: 0.50, min: 0.9, max: 1.5, solid: false, slope: 22, clear: 1.35, shadow: false },
      { id: 'tyre', share: 0.28, min: 0.9, max: 1.4, solid: true, r: 0.62, slope: 18, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.22, min: 0.3, max: 0.9, solid: false, slope: 34, clear: 1.6, shadow: false }
    ]
  },
  canyon: {
    accent: '#ff7a1a',
    rock: 0x8a4a30, dust: 0xb99a6a,
    kinds: [
      { id: 'hoodoo', share: 0.10, min: 1.4, max: 3.4, solid: true, r: 1.15, slope: 26, clear: 2.0, shadow: true },
      { id: 'rock0', share: 0.10, min: 1.2, max: 4.4, solid: true, r: 0.72, slope: 32, clear: 1.7, shadow: true },
      { id: 'rock1', share: 0.32, min: 0.7, max: 2.2, solid: true, r: 0.72, slope: 36, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.48, min: 0.22, max: 0.9, solid: false, slope: 40, clear: 1.35, shadow: false }
    ]
  },
  forest: {
    accent: '#4fd07a',
    rock: 0x5f6357, dust: 0x6b6c56,
    kinds: [
      { id: 'pine0', share: 0.30, min: 0.75, max: 1.5, solid: true, r: 0.55, slope: 34, clear: 1.45, shadow: true },
      { id: 'pine1', share: 0.26, min: 0.7, max: 1.4, solid: true, r: 0.5, slope: 36, clear: 1.45, shadow: true },
      { id: 'pine2', share: 0.22, min: 0.6, max: 1.2, solid: true, r: 0.45, slope: 38, clear: 1.45, shadow: false },
      { id: 'log', share: 0.10, min: 0.8, max: 1.4, solid: true, r: 0.5, slope: 22, clear: 1.7, shadow: false },
      { id: 'rock1', share: 0.12, min: 0.4, max: 1.5, solid: false, slope: 40, clear: 1.5, shadow: false }
    ]
  },
  volcano: {
    accent: '#ff5a2c',
    rock: 0x3a3634, dust: 0x4a3c33,
    kinds: [
      { id: 'basalt', share: 0.24, min: 0.9, max: 2.4, solid: true, r: 1.0, slope: 30, clear: 1.9, shadow: true },
      { id: 'vent', share: 0.08, min: 0.9, max: 1.8, solid: true, r: 1.6, slope: 18, clear: 2.2, shadow: true },
      { id: 'rock0', share: 0.12, min: 0.9, max: 3.2, solid: true, r: 0.72, slope: 34, clear: 1.7, shadow: false },
      { id: 'rock2', share: 0.56, min: 0.25, max: 1.0, solid: false, slope: 42, clear: 1.4, shadow: false }
    ]
  }
};

/* ============================================================
   3.  PROPS
   ============================================================ */
export class Props {
  constructor(scene, terrain, quality, trackDef, trackData) {
    this.scene = scene;
    this.terrain = terrain;
    this.quality = quality;
    this.def = trackDef;
    this.data = trackData;
    this.theme = trackDef.theme || 'training';
    this.recipe = RECIPES[this.theme] || RECIPES.training;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.colliders = [];       // { x, z, r, kind, bounce }
    this.barriers = [];        // { ax, az, bx, bz, r, kind }
    this._tex = [];            // everything to dispose
    this._geo = [];
    this._mat = [];

    this.rockMat = this._keepMat(rockMaterial(this.recipe.rock, this.recipe.dust));

    this.buildScatter();
    this.buildFurniture();
    this.setScatterDensity(quality.boulders);
  }

  _keepMat(m) { this._mat.push(m); return m; }
  _keepGeo(g) { this._geo.push(g); return g; }
  _keepTex(t) { this._tex.push(t); return t; }

  /* ---------------- placement test ----------------
     A prop may not sit on the road, in a checkpoint disc, on a slope it would
     visibly float off, or inside the grid box where eight cars are about to
     materialise. */
  _canPlace(x, z, clearW) {
    if (Math.abs(x) > PLAYABLE_EXT || Math.abs(z) > PLAYABLE_EXT) return false;
    if (this.terrain.onRoad(x, z) > 0.05) return false;
    const sp = this.data.spline;
    sp.nearest(x, z, _near);
    if (_near.d < sp.widthAt(_near.s) * clearW) return false;
    const sc = this.data.shortcutSpline;
    if (sc) {
      sc.nearest(x, z, _near);
      if (_near.d < sc.widthAt(_near.s) * clearW) return false;
    }
    const cps = this.data.checkpoints;
    for (let i = 0; i < cps.length; i++) {
      const dx = x - cps[i].x, dz = z - cps[i].z;
      if (dx * dx + dz * dz < cps[i].r * cps[i].r) return false;
    }
    for (let i = 0; i < this.data.gridSlots.length; i++) {
      const g = this.data.gridSlots[i];
      const dx = x - g.x, dz = z - g.z;
      if (dx * dx + dz * dz < 100) return false;
    }
    return true;
  }

  /* ---------------- theme scatter ---------------- */
  buildScatter() {
    const rng = makeRNG((this.def.seed | 0) ^ 0xB0D1E);
    const R = this.recipe;
    this.scatterMeshes = [];
    this._scatterSolids = [];

    // one geometry per kind id, built lazily
    const geoFor = (id) => {
      if (!this._geoCache) this._geoCache = {};
      if (this._geoCache[id]) return this._geoCache[id];
      let g;
      /* Icosahedron subdivision costs 4x per level. Level 2 (320 tris) is the
         most any rock you drive past deserves; the pebble scatter runs at 0
         (20 tris) and leans on the triplanar shader instead. */
      if (id === 'rock0') g = boulderGeo(1.7, 2);
      else if (id === 'rock1') g = boulderGeo(5.3, 1);
      else if (id === 'rock2') g = boulderGeo(9.1, 0);
      else if (id === 'hoodoo') g = hoodooGeo(3);
      else if (id === 'pine0') g = pineGeo(1);
      else if (id === 'pine1') g = pineGeo(2);
      else if (id === 'pine2') g = pineGeo(3);
      else if (id === 'log') g = logGeo(4);
      else if (id === 'basalt') g = basaltGeo(5);
      else if (id === 'vent') g = ventGeo(6);
      else if (id === 'cone') g = coneGeo();
      else if (id === 'tyre') g = tyreStackGeo();
      else g = boulderGeo(2.2, 1);
      this._geoCache[id] = this._keepGeo(g);
      return g;
    };

    const pineMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x2c4426, roughness: 0.94, metalness: 0
    }));
    const woodMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x4a3524, roughness: 0.92, metalness: 0
    }));
    const coneMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0xff6a1e, roughness: 0.7, metalness: 0, emissive: 0x2a0e00
    }));
    const tyreMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x1a1a1c, roughness: 0.95, metalness: 0
    }));
    const matFor = (id) => id.startsWith('pine') ? pineMat
      : id === 'log' ? woodMat
        : id === 'cone' ? coneMat
          : id === 'tyre' ? tyreMat
            : this.rockMat;

    for (let ki = 0; ki < R.kinds.length; ki++) {
      const K = R.kinds[ki];
      const per = Math.ceil(MAX_SCATTER * K.share);
      const geo = geoFor(K.id);
      const im = new THREE.InstancedMesh(geo, matFor(K.id), per);
      im.castShadow = !!K.shadow;
      im.receiveShadow = false;
      im.frustumCulled = false;
      const solids = [];
      this._scatterSolids.push(solids);

      let k = 0, guard = 0;
      while (k < per && guard++ < per * 30) {
        // A band biased toward the track: nobody sees the far corners of the
        // map, and every instance spent out there is one missing from the verge.
        const a = rng() * 6.2831853;
        const band = rng();
        const r = band < 0.62 ? 40 + rng() * 300 : 140 + rng() * (PLAYABLE_EXT - 150);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!this._canPlace(x, z, K.clear)) continue;
        if (this.terrain.slopeAt(x, z) > K.slope) continue;
        const size = K.min + Math.pow(rng(), 1.8) * (K.max - K.min);
        const y = this.terrain.heightAt(x, z) - size * (K.id.startsWith('pine') ? 0.05 : 0.20);
        _dummy.position.set(x, y, z);
        if (K.id.startsWith('pine') || K.id === 'cone' || K.id === 'tyre' || K.id === 'vent') {
          _dummy.rotation.set(0, rng() * 6.2832, 0);       // upright things stay upright
        } else if (K.id === 'log' || K.id === 'hoodoo' || K.id === 'basalt') {
          _dummy.rotation.set((rng() - 0.5) * 0.12, rng() * 6.2832, (rng() - 0.5) * 0.12);
        } else {
          _dummy.rotation.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
        }
        const sx = size * (0.85 + rng() * 0.3);
        _dummy.scale.set(sx, size * (0.85 + rng() * 0.3), sx);
        _dummy.updateMatrix();
        im.setMatrixAt(k, _dummy.matrix);
        solids.push(K.solid && size > K.min * 0.9
          ? { x, z, r: (K.r || 0.7) * size, kind: K.id, bounce: K.id.startsWith('pine') ? 1.15 : 1.35 }
          : null);
        k++;
      }
      im.userData.placed = k;
      im.userData.share = K.share;
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.scatterMeshes.push(im);
    }
  }

  /** Show the first N of the field and collide with exactly those. Anything the
      tier hides must not be solid, or you would be stopped by a rock that is
      not there. */
  setScatterDensity(N) {
    this.colliders.length = 0;
    for (let vi = 0; vi < this.scatterMeshes.length; vi++) {
      const im = this.scatterMeshes[vi];
      const show = Math.min(im.userData.placed, Math.ceil(N * im.userData.share));
      im.count = show;
      const solids = this._scatterSolids[vi];
      for (let i = 0; i < show; i++) if (solids[i]) this.colliders.push(solids[i]);
    }
    for (let i = 0; i < this._fixedColliders.length; i++) this.colliders.push(this._fixedColliders[i]);
    this._buildBroadphase();
  }

  setQuality(q) {
    this.quality = q;
    this.setScatterDensity(q.boulders);
  }

  /* ============================================================
     track furniture
     ============================================================ */
  buildFurniture() {
    this._fixedColliders = [];
    const A = this.recipe.accent;
    this.postMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x30343c, roughness: 0.6, metalness: 0.55
    }));
    this.buildGantry(A);
    this.buildGates(A);
    this.buildBarriers(A);
    this.buildSigns();
    this.buildFinishStripe();
  }

  /** Start gantry straddling s = 0. */
  buildGantry(accent) {
    const sp = this.data.spline;
    const gs = 0;
    const w = sp.widthAt(gs);
    const span = w * 2 + 5;
    const H = 7.2;
    const g = new THREE.Group();

    const legGeo = this._keepGeo(new THREE.CylinderGeometry(0.26, 0.34, H, 10));
    const beamGeo = this._keepGeo(new THREE.BoxGeometry(span, 0.42, 0.5));
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, this.postMat);
      leg.position.set(s * span * 0.5, H * 0.5, 0);
      leg.castShadow = true;
      g.add(leg);
      const foot = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(1.4, 0.3, 1.4)), this.postMat);
      foot.position.set(s * span * 0.5, 0.15, 0);
      g.add(foot);
      // brace back to the beam
      const br = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(2.4, 0.18, 0.18)), this.postMat);
      br.position.set(s * (span * 0.5 - 0.9), H - 0.9, 0);
      br.rotation.z = -s * 0.6;
      g.add(br);
    }
    const beam = new THREE.Mesh(beamGeo, this.postMat);
    beam.position.y = H; beam.castShadow = true; g.add(beam);

    const tex = this._keepTex(gantryTex(accent));
    const banner = new THREE.Mesh(
      this._keepGeo(new THREE.PlaneGeometry(span * 0.94, 1.5)),
      this._keepMat(new THREE.MeshStandardMaterial({
        map: tex, side: THREE.DoubleSide, roughness: 0.85, metalness: 0
      })));
    banner.position.y = H - 1.1;
    // The group's +Z points DOWNSTREAM; racers approach from upstream and would
    // read the plane's back face mirrored. Face the text at the traffic.
    banner.rotation.y = Math.PI;
    banner.castShadow = true;
    g.add(banner);

    const p = sp.posAt(gs, _pp), d = sp.dirAt(gs, _dd);
    g.position.set(p.x, this.terrain.heightAt(p.x, p.z), p.z);
    g.rotation.y = Math.atan2(d.x, d.z);
    this.group.add(g);
    this.gantry = g;

    // The legs are solid. They sit outside the roadbed, but a car arriving
    // sideways off the grid will find them.
    for (const s of [-1, 1]) {
      const q = sp.offsetPoint(gs, s * span * 0.5, _pp);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 0.7, kind: 'gantry', bounce: 1.1 });
    }
  }

  /** Two posts and a slim banner at every checkpoint flagged `big`. */
  buildGates(accent) {
    const sp = this.data.spline;
    const postGeo = this._keepGeo(new THREE.CylinderGeometry(0.16, 0.2, 4.4, 8));
    const gateTex = this._keepTex(bannerTex('CHECK', accent));
    const gateMat = this._keepMat(new THREE.MeshStandardMaterial({
      map: gateTex, side: THREE.DoubleSide, roughness: 0.88, metalness: 0
    }));
    this.gates = [];
    const cps = this.data.checkpoints;
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (!c.big || c.alt) continue;
      const w = sp.widthAt(c.s);
      const span = w * 2 + 2.6;
      const g = new THREE.Group();
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, this.postMat);
        post.position.set(s * span * 0.5, 2.2, 0);
        post.castShadow = true;
        g.add(post);
      }
      const bn = new THREE.Mesh(this._keepGeo(new THREE.PlaneGeometry(span, 0.9)), gateMat);
      bn.position.y = 4.0;
      bn.rotation.y = Math.PI;          // face oncoming traffic, not the exit
      g.add(bn);
      const d = sp.dirAt(c.s, _dd);
      g.position.set(c.x, this.terrain.heightAt(c.x, c.z), c.z);
      g.rotation.y = Math.atan2(d.x, d.z);
      this.group.add(g);
      this.gates.push(g);
      for (const s of [-1, 1]) {
        const q = sp.offsetPoint(c.s, s * span * 0.5, _pp);
        this._fixedColliders.push({ x: q.x, z: q.z, r: 0.45, kind: 'gate', bounce: 1.0 });
      }
    }
  }

  /* ---------------- barrier runs ----------------
     Posts are instanced; the rail is one merged strip per run. Collision is
     SEGMENTS, not a bead of circles: a car sliding along a wall at 30 m/s must
     glance off it, and a row of discs would chatter it into the scenery. */
  buildBarriers(accent) {
    const walls = this.data.walls || [];
    if (!walls.length) { this.barrierMesh = null; return; }
    const sp = this.data.spline, L = sp.length;
    const rTex = this._keepTex(railTex(accent));
    rTex.wrapS = THREE.RepeatWrapping;
    const railMat = this._keepMat(new THREE.MeshStandardMaterial({
      map: rTex, roughness: 0.62, metalness: 0.25, side: THREE.DoubleSide
    }));
    const postGeo = this._keepGeo(new THREE.BoxGeometry(0.18, 1.15, 0.18));
    const railStrips = [];
    const posts = [];
    const SPACING = 4.5;

    for (const wl of walls) {
      let s0 = sp.wrapS(wl.s0), s1 = sp.wrapS(wl.s1);
      let span = s1 - s0; if (span <= 0) span += L;
      const sides = wl.side === 0 ? [-1, 1] : [wl.side];
      for (const side of sides) {
        const n = Math.max(2, Math.round(span / SPACING));
        let prev = null;
        for (let i = 0; i <= n; i++) {
          const s = s0 + span * (i / n);
          const off = side * (sp.widthAt(s) * 1.32 + 0.7);
          const q = sp.offsetPoint(s, off, _pp);
          const y = this.terrain.heightAt(q.x, q.z);
          posts.push([q.x, y, q.z]);
          if (prev) {
            // rail quad from prev to here, 0.55 m tall, centred at 0.78 m
            railStrips.push(railQuad(prev[0], prev[1] + 0.78, prev[2], q.x, y + 0.78, q.z, 0.55));
            this.barriers.push({
              ax: prev[0], az: prev[2], bx: q.x, bz: q.z, r: 0.45, kind: 'barrier'
            });
          }
          prev = [q.x, y, q.z];
        }
      }
    }

    if (posts.length) {
      const im = new THREE.InstancedMesh(postGeo, this.postMat, posts.length);
      im.castShadow = true; im.frustumCulled = false;
      for (let i = 0; i < posts.length; i++) {
        _dummy.position.set(posts[i][0], posts[i][1] + 0.55, posts[i][2]);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.barrierPosts = im;
    }
    if (railStrips.length) {
      const merged = mergeGeometries(railStrips, false);
      for (const g of railStrips) g.dispose();
      merged.computeVertexNormals();
      const m = new THREE.Mesh(this._keepGeo(merged), railMat);
      m.castShadow = true; m.frustumCulled = false;
      this.group.add(m);
      this.barrierMesh = m;
    }
  }

  /* ---------------- warning boards ----------------
     One before every jump, and one before anything tighter than 55 m radius.
     They go on the OUTSIDE of the corner, which is where a driver is already
     looking when they are about to get it wrong. */
  buildSigns() {
    const sp = this.data.spline, L = sp.length;
    const mats = [
      this._keepMat(new THREE.MeshStandardMaterial({ map: this._keepTex(arrowTex(-1)), roughness: 0.8, side: THREE.DoubleSide })),
      this._keepMat(new THREE.MeshStandardMaterial({ map: this._keepTex(arrowTex(1)), roughness: 0.8, side: THREE.DoubleSide })),
      this._keepMat(new THREE.MeshStandardMaterial({ map: this._keepTex(arrowTex(0)), roughness: 0.8, side: THREE.DoubleSide }))
    ];
    const boardGeo = this._keepGeo(new THREE.PlaneGeometry(1.5, 1.5));
    const legGeo = this._keepGeo(new THREE.CylinderGeometry(0.07, 0.07, 1.7, 6));
    const sites = [];
    for (const j of this.data.jumps) sites.push({ s: sp.wrapS(j.s - 42), type: 2, side: 1 });
    // scan for corners, keeping only the tightest point of each one
    let run = null;
    for (let s = 0; s < L; s += 4) {
      const k = sp.curvatureAt(s);
      if (Math.abs(k) > 1 / 55) {
        if (!run || Math.abs(k) > Math.abs(run.k)) run = { s, k };
      } else if (run) {
        sites.push({ s: sp.wrapS(run.s - 46), type: run.k > 0 ? 0 : 1, side: run.k > 0 ? -1 : 1 });
        run = null;
      }
    }
    this.signs = [];
    for (const site of sites) {
      const w = sp.widthAt(site.s);
      const off = site.side * (w * 1.28 + 1.6);
      const q = sp.offsetPoint(site.s, off, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT || Math.abs(q.z) > PLAYABLE_EXT) continue;
      const y = this.terrain.heightAt(q.x, q.z);
      const g = new THREE.Group();
      const leg = new THREE.Mesh(legGeo, this.postMat);
      leg.position.y = 0.85; g.add(leg);
      const bd = new THREE.Mesh(boardGeo, mats[site.type]);
      bd.position.y = 2.2; bd.castShadow = true; g.add(bd);
      const d = sp.dirAt(site.s, _dd);
      g.position.set(q.x, y, q.z);
      // face back down the track at the oncoming car
      g.rotation.y = Math.atan2(-d.x, -d.z);
      this.group.add(g);
      this.signs.push(g);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 0.3, kind: 'sign', bounce: 0.6 });
    }
  }

  /** Checker stripe painted on the ground at s = 0, conforming to the terrain. */
  buildFinishStripe() {
    const sp = this.data.spline;
    const w = sp.widthAt(0) * 1.25;
    const NW = 20, NL = 3, LEN = 2.2;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= NL; j++) {
      const s = sp.wrapS(-LEN * 0.5 + LEN * (j / NL));
      for (let i = 0; i <= NW; i++) {
        const lat = -w + 2 * w * (i / NW);
        const q = sp.offsetPoint(s, lat, _pp);
        // 6 cm proud: any less and the clipmap's own sag pokes through it
        pos.push(q.x, this.terrain.heightAt(q.x, q.z) + 0.06, q.z);
        uv.push(i / NW * 6, j / NL);
      }
    }
    for (let j = 0; j < NL; j++) for (let i = 0; i < NW; i++) {
      const a = j * (NW + 1) + i, b = a + 1, c = a + NW + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = this._keepTex(checkerTex());
    tex.wrapS = THREE.RepeatWrapping;
    const m = new THREE.Mesh(this._keepGeo(g), this._keepMat(new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2
    })));
    m.receiveShadow = true;
    this.group.add(m);
    this.finishStripe = m;
  }

  /* ============================================================
     collision
     ============================================================ */
  _buildBroadphase() {
    const dim = this._bpDim = Math.ceil((GRID_HALF * 2) / GRID_CELL);
    const lists = new Array(dim * dim);
    const push = (cx, cz, v) => {
      if (cx < 0 || cz < 0 || cx >= dim || cz >= dim) return;
      const k = cz * dim + cx;
      (lists[k] || (lists[k] = [])).push(v);
    };
    const cell = (v) => Math.floor((v + GRID_HALF) / GRID_CELL);
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const r = c.r + 2;
      for (let gz = cell(c.z - r); gz <= cell(c.z + r); gz++)
        for (let gx = cell(c.x - r); gx <= cell(c.x + r); gx++) push(gx, gz, i);
    }
    // barriers get their own list; they are indexed negatively so one bucket
    // can hold both populations without a second grid
    for (let i = 0; i < this.barriers.length; i++) {
      const b = this.barriers[i];
      const x0 = Math.min(b.ax, b.bx) - 2, x1 = Math.max(b.ax, b.bx) + 2;
      const z0 = Math.min(b.az, b.bz) - 2, z1 = Math.max(b.az, b.bz) + 2;
      for (let gz = cell(z0); gz <= cell(z1); gz++)
        for (let gx = cell(x0); gx <= cell(x1); gx++) push(gx, gz, -(i + 1));
    }
    // flatten to CSR — resolve() runs six times a frame and must not allocate
    const off = this._bpOff = new Int32Array(dim * dim + 1);
    let total = 0;
    for (let k = 0; k < dim * dim; k++) { off[k] = total; if (lists[k]) total += lists[k].length; }
    off[dim * dim] = total;
    const idx = this._bpIdx = new Int32Array(total);
    let o = 0;
    for (let k = 0; k < dim * dim; k++) { const L = lists[k]; if (!L) continue; for (let i = 0; i < L.length; i++) idx[o++] = L[i]; }
  }

  /**
   * Push a vehicle out of anything solid it has ended up inside.
   * @param {{pos:THREE.Vector3, vel:THREE.Vector3, omega?:THREE.Vector3}} v
   * @returns {number} impact speed in m/s along the contact normal (0 = clean)
   */
  resolve(v) {
    const px = v.pos.x, pz = v.pos.z;
    const dim = this._bpDim;
    const gx = Math.floor((px + GRID_HALF) / GRID_CELL);
    const gz = Math.floor((pz + GRID_HALF) / GRID_CELL);
    if (gx < 0 || gz < 0 || gx >= dim || gz >= dim) return 0;
    const k = gz * dim + gx;
    const o0 = this._bpOff[k], o1 = this._bpOff[k + 1];
    if (o0 === o1) return 0;
    const R0 = v.collideR || CAR_R;
    let impact = 0;

    for (let o = o0; o < o1; o++) {
      const id = this._bpIdx[o];
      let nx, nz, pen, bounce;
      if (id >= 0) {
        const c = this.colliders[id];
        const dx = v.pos.x - c.x, dz = v.pos.z - c.z;
        const d2 = dx * dx + dz * dz;
        const R = c.r + R0;
        if (d2 > R * R || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        nx = dx / d; nz = dz / d; pen = R - d; bounce = c.bounce || 1.2;
      } else {
        const b = this.barriers[-id - 1];
        const ex = b.bx - b.ax, ez = b.bz - b.az;
        const el2 = ex * ex + ez * ez;
        if (el2 < 1e-9) continue;
        let t = ((v.pos.x - b.ax) * ex + (v.pos.z - b.az) * ez) / el2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = b.ax + ex * t, cz = b.az + ez * t;
        const dx = v.pos.x - cx, dz = v.pos.z - cz;
        const d2 = dx * dx + dz * dz;
        const R = b.r + R0;
        if (d2 > R * R || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        // Barriers absorb rather than bounce: hitting a wall should cost you
        // time and paint, not fire you back across the road.
        nx = dx / d; nz = dz / d; pen = R - d; bounce = 0.55;
      }
      v.pos.x += nx * pen; v.pos.z += nz * pen;
      const vn = v.vel.x * nx + v.vel.z * nz;
      if (vn < 0) {
        v.vel.x -= vn * nx * bounce; v.vel.z -= vn * nz * bounce;
        if (v.omega) v.omega.y += (Math.random() - 0.5) * Math.min(-vn, 5) * 0.08;
        if (-vn > impact) impact = -vn;
      }
    }
    return impact;
  }

  update(dt, t, camera) {
    void dt; void t; void camera;      // nothing here animates yet; dust owns the smoke
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    for (const t of this._tex) t.dispose();
    this._geo.length = 0; this._mat.length = 0; this._tex.length = 0;
    this.colliders.length = 0; this.barriers.length = 0;
  }
}

/** A single upright quad from A to B, `h` metres tall, as its own geometry. */
function railQuad(ax, ay, az, bx, by, bz, h) {
  const g = new THREE.BufferGeometry();
  const len = Math.hypot(bx - ax, bz - az);
  const u = Math.max(0.25, len / 4);
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    ax, ay - h * 0.5, az, bx, by - h * 0.5, bz,
    bx, by + h * 0.5, bz, ax, ay + h * 0.5, az
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u, 0, u, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

void clamp; void sstep;

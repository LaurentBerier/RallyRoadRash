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
import {
  kitPalette, cactusGeo, agaveGeo, bushGeo, snagGeo, broadleafGeo, stumpGeo,
  shardGeo, drumGeo, crateGeo, baleGeo, wreckGeo, pipeStackGeo, shedGeo,
  containerGeo, towerGeo, waterTankGeo, hangarGeo, grandstandGeo, canopyGeo,
  personGeo, poleGeo, culvertGeo, pipeworkGeo, logStackGeo, wireGeo,
} from './kit.js';

/* Placement is always done for the densest tier. Keep in step with
   QUALITY.ultra.boulders in core/engine.js. */
const MAX_SCATTER = 2900;
const GRID_CELL = 24, GRID_HALF = 640;
const CAR_R = 1.15;              // fallback body radius if a vehicle has none

/** Deterministic 0..1 from a world point. Cheap, uncorrelated on a lattice. */
function hash2(x, z) {
  let h = Math.imul((x * 8192) | 0, 0x27d4eb2d) ^ Math.imul((z * 8192) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/* ---------------- module scratch (no per-frame allocation) ---------------- */
const _dummy = new THREE.Object3D();
const _near = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
const _pp = { x: 0, y: 0, z: 0 };
// Second point scratch: the dressing pass needs a site AND the centreline
// point it should face, and one buffer cannot hold both.
const _pp2 = { x: 0, y: 0, z: 0 };
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
  m.customProgramCacheKey = () => 'rrr-rock-' + color.toString(16);
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
    // 72px, not 96: "ROAD RASH" is nine glyphs and has to sit inside the
    // w*0.48 plate carved out above.
    g.font = '800 72px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#f2efe6'; g.fillText('ROAD RASH', w * 0.5, h * 0.5 + 4);
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
      { id: 'cone', share: 0.22, min: 0.9, max: 1.5, solid: false, slope: 22, clear: 1.35, shadow: false },
      { id: 'tyre', share: 0.16, min: 0.9, max: 1.4, solid: true, r: 0.62, slope: 18, clear: 1.5, shadow: false },
      { id: 'drum', share: 0.10, min: 0.9, max: 1.2, solid: true, r: 0.42, slope: 16, clear: 1.6, shadow: true },
      { id: 'crate', share: 0.08, min: 0.9, max: 1.3, solid: true, r: 0.55, slope: 14, clear: 1.7, shadow: true },
      { id: 'bale', share: 0.07, min: 0.9, max: 1.15, solid: true, r: 0.72, slope: 16, clear: 1.7, shadow: true },
      { id: 'bush0', share: 0.19, min: 0.6, max: 1.5, solid: false, slope: 34, clear: 1.4, shadow: false },
      { id: 'rock2', share: 0.18, min: 0.3, max: 0.9, solid: false, slope: 34, clear: 1.6, shadow: false }
    ]
  },
  canyon: {
    accent: '#ff7a1a',
    rock: 0x8a4a30, dust: 0xb99a6a,
    kinds: [
      /* Hoodoos are down from 0.08 to 0.035. They were a tenth of the scatter
         when the scatter was 2200 spread over a kilometre; at 2900 with 74 %
         of it on the verge, the same share put 230 identical orange spires
         along the racing line and SUNSTRIKE CANYON looked like a slalom
         course. A hoodoo is a landmark — it wants to be rare. */
      { id: 'hoodoo', share: 0.035, min: 1.4, max: 3.4, solid: true, r: 1.15, slope: 26, clear: 2.0, shadow: true },
      { id: 'rock0', share: 0.10, min: 1.2, max: 4.4, solid: true, r: 0.72, slope: 32, clear: 1.7, shadow: true },
      { id: 'rock1', share: 0.26, min: 0.7, max: 2.2, solid: true, r: 0.72, slope: 36, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.30, min: 0.22, max: 0.9, solid: false, slope: 40, clear: 1.35, shadow: false },
      { id: 'cactus0', share: 0.10, min: 0.8, max: 1.5, solid: true, r: 0.34, slope: 26, clear: 1.6, shadow: true },
      { id: 'cactus1', share: 0.06, min: 0.7, max: 1.3, solid: true, r: 0.32, slope: 26, clear: 1.6, shadow: true },
      { id: 'agave', share: 0.10, min: 0.7, max: 1.6, solid: false, slope: 32, clear: 1.4, shadow: false },
      { id: 'bush0', share: 0.07, min: 0.6, max: 1.4, solid: false, slope: 34, clear: 1.4, shadow: false }
    ]
  },
  forest: {
    accent: '#4fd07a',
    rock: 0x5f6357, dust: 0x6b6c56,
    kinds: [
      { id: 'pine0', share: 0.22, min: 0.75, max: 1.5, solid: true, r: 0.55, slope: 34, clear: 1.45, shadow: true },
      { id: 'pine1', share: 0.18, min: 0.7, max: 1.4, solid: true, r: 0.5, slope: 36, clear: 1.45, shadow: true },
      { id: 'pine2', share: 0.14, min: 0.6, max: 1.2, solid: true, r: 0.45, slope: 38, clear: 1.45, shadow: false },
      { id: 'broadleaf', share: 0.07, min: 0.7, max: 1.4, solid: true, r: 0.5, slope: 30, clear: 1.6, shadow: true },
      { id: 'snag', share: 0.08, min: 0.7, max: 1.4, solid: true, r: 0.32, slope: 38, clear: 1.5, shadow: true },
      { id: 'log', share: 0.07, min: 0.8, max: 1.4, solid: true, r: 0.5, slope: 22, clear: 1.7, shadow: false },
      { id: 'stump', share: 0.07, min: 0.8, max: 1.5, solid: true, r: 0.4, slope: 26, clear: 1.5, shadow: false },
      { id: 'bush0', share: 0.09, min: 0.7, max: 1.7, solid: false, slope: 36, clear: 1.35, shadow: false },
      { id: 'rock1', share: 0.08, min: 0.4, max: 1.5, solid: false, slope: 40, clear: 1.5, shadow: false }
    ]
  },
  volcano: {
    accent: '#ff5a2c',
    rock: 0x3a3634, dust: 0x4a3c33,
    kinds: [
      { id: 'basalt', share: 0.20, min: 0.9, max: 2.4, solid: true, r: 1.0, slope: 30, clear: 1.9, shadow: true },
      { id: 'vent', share: 0.06, min: 0.9, max: 1.8, solid: true, r: 1.6, slope: 18, clear: 2.2, shadow: true },
      { id: 'shard0', share: 0.14, min: 0.7, max: 1.9, solid: true, r: 0.5, slope: 36, clear: 1.5, shadow: true },
      { id: 'shard1', share: 0.10, min: 0.5, max: 1.4, solid: false, slope: 40, clear: 1.4, shadow: false },
      { id: 'snag', share: 0.08, min: 0.6, max: 1.2, solid: true, r: 0.3, slope: 36, clear: 1.5, shadow: true },
      { id: 'rock0', share: 0.10, min: 0.9, max: 3.2, solid: true, r: 0.72, slope: 34, clear: 1.7, shadow: false },
      { id: 'rock2', share: 0.32, min: 0.25, max: 1.0, solid: false, slope: 42, clear: 1.4, shadow: false }
    ]
  }
};

/* ============================================================
   2b. SET-DRESSING PLAN — what each stage is a picture OF
   ------------------------------------------------------------
   The scatter above is texture: it fills the middle distance and it is much
   the same everywhere on a stage. This table is the opposite — a short list
   of authored, one-off structures that give a stage a place and a story, and
   the utility lines that tie them together across the map.

   `landmarks` are placed by rejection sampling in a lateral BAND beside the
   racing line, so they land where a driver will actually look: near enough
   to read at 130 km/h, far enough out that they are never the reason you
   lost the race. `lat` is that band in metres from the centreline; `r` is
   the collision radius, and `size` the random scale range.

   Everything here is merged into instanced meshes by id, so adding a
   landmark costs one draw call for the whole stage, not one per building.
   ============================================================ */
const DRESSING = {
  training: {
    // An old airfield somebody bolted a rally school onto.
    landmarks: [
      { id: 'hangar', n: 1, lat: [95, 150], r: 12.0, size: [1.00, 1.00] },
      { id: 'tower', n: 1, lat: [58, 95], r: 2.2, size: [0.95, 1.15] },
      { id: 'grandstand', n: 2, lat: [26, 40], r: 7.0, size: [1.00, 1.00] },
      { id: 'shed', n: 3, lat: [42, 110], r: 2.6, size: [0.90, 1.30] },
      { id: 'container', n: 4, lat: [30, 90], r: 3.2, size: [1.00, 1.00] },
      { id: 'wreck', n: 2, lat: [26, 55], r: 1.9, size: [1.00, 1.00] },
    ],
    lines: { runs: 2, poleH: 8.5, arms: 2, span: 46 },
  },
  canyon: {
    // A worked-out mining claim in the wash: water tank, camp, dead machinery.
    landmarks: [
      { id: 'tank', n: 2, lat: [48, 110], r: 3.4, size: [0.90, 1.20] },
      { id: 'shed', n: 4, lat: [30, 120], r: 2.6, size: [0.85, 1.25] },
      { id: 'mast', n: 1, lat: [85, 160], r: 2.0, size: [1.00, 1.00] },
      { id: 'pipes', n: 3, lat: [26, 60], r: 2.2, size: [1.00, 1.00] },
      { id: 'wreck', n: 3, lat: [24, 48], r: 1.9, size: [1.00, 1.00] },
      { id: 'culvert', n: 2, lat: [22, 34], r: 2.0, size: [1.00, 1.30] },
      { id: 'container', n: 2, lat: [34, 80], r: 3.2, size: [1.00, 1.00] },
    ],
    lines: { runs: 2, poleH: 9.5, arms: 2, span: 52 },
  },
  forest: {
    // An active logging show, and the fire lookout that watches it.
    landmarks: [
      { id: 'lookout', n: 1, lat: [62, 120], r: 2.4, size: [1.00, 1.00] },
      { id: 'logstack', n: 5, lat: [24, 70], r: 3.0, size: [0.90, 1.20] },
      { id: 'shed', n: 3, lat: [28, 90], r: 2.6, size: [0.85, 1.15] },
      { id: 'container', n: 2, lat: [28, 60], r: 3.2, size: [1.00, 1.00] },
      { id: 'wreck', n: 2, lat: [22, 44], r: 1.9, size: [1.00, 1.00] },
      { id: 'grandstand', n: 1, lat: [24, 34], r: 7.0, size: [1.00, 1.00] },
    ],
    lines: { runs: 1, poleH: 10.0, arms: 1, span: 44 },
  },
  volcano: {
    // A monitoring station nobody has staffed since the last eruption.
    landmarks: [
      { id: 'mast', n: 2, lat: [55, 130], r: 2.0, size: [1.00, 1.20] },
      { id: 'shed', n: 4, lat: [26, 90], r: 2.6, size: [0.80, 1.20] },
      { id: 'pipework', n: 5, lat: [22, 60], r: 1.6, size: [1.00, 1.40] },
      { id: 'pipes', n: 3, lat: [24, 55], r: 2.2, size: [1.00, 1.00] },
      { id: 'culvert', n: 3, lat: [20, 34], r: 2.0, size: [1.10, 1.50] },
      { id: 'wreck', n: 2, lat: [22, 42], r: 1.9, size: [1.00, 1.00] },
      { id: 'container', n: 2, lat: [30, 70], r: 3.2, size: [1.00, 1.00] },
    ],
    lines: { runs: 1, poleH: 9.0, arms: 2, span: 48 },
  },
};

/** Scatter ids whose geometry comes from kit.js and is vertex-coloured. */
const KIT_KINDS = new Set([
  'cactus0', 'cactus1', 'agave', 'bush0', 'snag', 'broadleaf', 'stump',
  'shard0', 'shard1', 'drum', 'crate', 'bale',
]);

/**
 * How hard a prop throws you back. This is the only thing that tells a player
 * what a shape is MADE of, so it is worth being deliberate: rock and steel
 * punish, wood is firm, and the soft stuff (bales, brush, cactus) barely
 * argues — a hay bale that fired a car back across the road would be a lie.
 */
const BOUNCE_FOR = (id) =>
  id === 'bale' ? 0.35
    : id === 'bush0' || id === 'agave' ? 0.5
      : id === 'cactus0' || id === 'cactus1' ? 0.7
        : id === 'crate' || id === 'stump' ? 0.9
          : id === 'drum' ? 1.0
            : id.startsWith('pine') || id === 'snag' || id === 'broadleaf' ? 1.15
              : 1.35;

/** Kinds that must stand upright — a leaning cactus reads as a mistake. */
const UPRIGHT_KINDS = new Set([
  'cone', 'tyre', 'vent', 'cactus0', 'cactus1', 'agave', 'snag', 'broadleaf',
  'stump', 'drum', 'crate', 'bale',
]);

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

    this.palette = kitPalette(this.theme);
    this.plan = DRESSING[this.theme] || DRESSING.training;
    this.rockMat = this._keepMat(rockMaterial(this.recipe.rock, this.recipe.dust));
    /* One material for every vertex-coloured thing in the stage: scatter
       plants, junk, landmarks, poles, spectators. Adding a new kind of prop
       costs a geometry and nothing else. */
    this.dressMat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0.05,
    }));

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
    const sp = this.data.spline;
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
      if (KIT_KINDS.has(id)) { this._geoCache[id] = this._kitGeo(id); return this._geoCache[id]; }
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
    /* Anything from kit.js carries its colours in the vertex stream, so the
       whole of the new scatter — cacti, snags, drums, obsidian — shares one
       material and adds no shader permutations. */
    const matFor = (id) => KIT_KINDS.has(id) ? this.dressMat
      : id.startsWith('pine') ? pineMat
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
        /* Placement follows the ROAD, not the map centre.

           The old sampler picked a radius from the world origin, which on a
           600 m track spread the whole budget over about 1.1 km² — two props
           per thousand square metres, and TIMBERLINE CLIMB looked like a
           desert with twenty pine trees standing in it. Nobody ever sees the
           far corners of the map; every instance spent out there is one
           missing from the verge you are actually looking at.

           So 74 % of the budget is sampled as (s along the spline, lateral
           offset), with the offset raised to a power so it crowds the first
           30 m off the road edge and thins out by 110 m. The remaining 26 %
           still fills the wide field, because a horizon with nothing on it
           reads as a bald patch from the top of a climb. */
        let x, z;
        if (rng() < 0.74) {
          const s = rng() * sp.length;
          const side = rng() < 0.5 ? -1 : 1;
          const q = sp.offsetPoint(s,
            side * (sp.widthAt(s) * K.clear + 1.5 + Math.pow(rng(), 1.7) * 108), _pp);
          x = q.x; z = q.z;
        } else {
          const a = rng() * 6.2831853;
          const r = 110 + rng() * (PLAYABLE_EXT - 125);
          x = Math.cos(a) * r; z = Math.sin(a) * r;
        }
        if (!this._canPlace(x, z, K.clear)) continue;
        if (this.terrain.slopeAt(x, z) > K.slope) continue;
        const size = K.min + Math.pow(rng(), 1.8) * (K.max - K.min);
        /* Kit geometry stands ON y = 0, so it must NOT be sunk the way a
           boulder is — a drum buried to its waist reads as a bug. Trees and
           plants get a token 5 cm so their base never floats on a slope. */
        const sink = KIT_KINDS.has(K.id) ? 0.05
          : K.id.startsWith('pine') ? size * 0.05 : size * 0.20;
        const y = this.terrain.heightAt(x, z) - sink;
        _dummy.position.set(x, y, z);
        if (K.id.startsWith('pine') || UPRIGHT_KINDS.has(K.id)) {
          _dummy.rotation.set(0, rng() * 6.2832, 0);       // upright things stay upright
        } else if (K.id === 'log' || K.id === 'hoodoo' || K.id === 'basalt' ||
          K.id === 'shard0' || K.id === 'shard1') {
          _dummy.rotation.set((rng() - 0.5) * 0.12, rng() * 6.2832, (rng() - 0.5) * 0.12);
        } else {
          _dummy.rotation.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
        }
        const sx = size * (0.85 + rng() * 0.3);
        _dummy.scale.set(sx, size * (0.85 + rng() * 0.3), sx);
        _dummy.updateMatrix();
        im.setMatrixAt(k, _dummy.matrix);
        solids.push(K.solid && size > K.min * 0.9
          ? { x, z, r: (K.r || 0.7) * size, kind: K.id, bounce: BOUNCE_FOR(K.id) }
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
    /* The crowd is the first thing to go. Spectators are ~60 instances of a
       12-primitive figure that nobody looks at directly, and dropping them
       costs the stage nothing structurally — unlike the landmarks, which are
       what tells you WHERE you are and stay at every tier. */
    const showCrowd = q.boulders >= 700;
    for (const m of this.crowdMeshes || []) m.visible = showCrowd;
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
    this.buildDressing(A);
    this.buildFinishStripe();
  }

  /* ============================================================
     SET DRESSING
     ------------------------------------------------------------
     Everything in this block shares one vertex-coloured material and is
     collapsed into one InstancedMesh per shape, so a stage that gains a
     hangar, a power line, forty spectators and a set of jump furniture gains
     about a dozen draw calls in total.

     The order matters. Landmarks claim their ground first because they are
     the biggest and the fussiest about slope; utility lines then thread
     between whatever is left; the paddock, jump furniture and crowds are
     placed against track features and never negotiate.
     ============================================================ */
  buildDressing(accent) {
    const rng = makeRNG((this.def.seed | 0) ^ 0x5E7D1);
    this._dressSites = new Map();      // id -> [ {x,y,z,yaw,scale} ]
    this._dressGeoCache = this._dressGeoCache || {};
    this._oneOff = [];                 // geometry already in world space
    this._crowdIds = new Set();        // ids the low tier drops
    this._claimed = [];                // {x,z,r} — landmark keep-out discs

    this._planLandmarks(rng);
    this._planUtilityLines(rng);
    this._planPaddock(rng);
    this._planJumpFurniture(rng, accent);
    this._planCrowds(rng);
    this._flushDressing();
  }

  /** Geometry for a dressing/kit id, built once and cached for the stage. */
  _kitGeo(id) {
    const C = this._dressGeoCache || (this._dressGeoCache = {});
    if (C[id]) return C[id];
    const P = this.palette;
    const s = (this.def.seed | 0) + id.length * 131;
    let g;
    switch (id) {
      /* scatter plants and junk */
      case 'cactus0': g = cactusGeo(P, s + 11); break;
      case 'cactus1': g = cactusGeo(P, s + 29); break;
      case 'agave': g = agaveGeo(P, s + 17); break;
      case 'bush0': g = bushGeo(P, s + 23); break;
      case 'snag': g = snagGeo(P, s + 31); break;
      case 'broadleaf': g = broadleafGeo(P, s + 37); break;
      case 'stump': g = stumpGeo(P, s + 41); break;
      case 'shard0': g = shardGeo(P, s + 43); break;
      case 'shard1': g = shardGeo(P, s + 47); break;
      case 'drum': g = drumGeo(P, s + 53); break;
      case 'crate': g = crateGeo(P, s + 59); break;
      case 'bale': g = baleGeo(P, s + 61); break;
      /* landmarks */
      case 'hangar': g = hangarGeo(P, s + 71, 24, 17, 8.5); break;
      case 'tower': g = towerGeo(P, s + 73, 15, true); break;
      case 'lookout': g = towerGeo(P, s + 79, 11, true); break;
      case 'mast': g = towerGeo(P, s + 83, 17, false); break;
      case 'grandstand': g = grandstandGeo(P, s + 89, 15, 6); break;
      case 'shed': g = shedGeo(P, s + 97); break;
      case 'container': g = containerGeo(P, s + 101); break;
      case 'wreck': g = wreckGeo(P, s + 103); break;
      case 'tank': g = waterTankGeo(P, s + 107); break;
      case 'pipes': g = pipeStackGeo(P, s + 109); break;
      case 'pipework': g = pipeworkGeo(P, s + 113); break;
      case 'culvert': g = culvertGeo(P, s + 127); break;
      case 'logstack': g = logStackGeo(P, s + 131); break;
      /* paddock and crowd */
      case 'canopy': g = canopyGeo(P, s + 137); break;
      case 'person0': g = personGeo(P, s + 139); break;
      case 'person1': g = personGeo(P, s + 149); break;
      case 'person2': g = personGeo(P, s + 151); break;
      case 'pole': g = poleGeo(P, s + 157, this.plan.lines.poleH, this.plan.lines.arms); break;
      default: g = crateGeo(P, s); break;
    }
    C[id] = this._keepGeo(g);
    return g;
  }

  /**
   * Register one dressing instance. `solid` adds a fixed collider, which is
   * what stops a hangar being scenery you drive through.
   */
  _dress(id, x, y, z, yaw, scale = 1, solid = 0, bounce = 1.3) {
    let a = this._dressSites.get(id);
    if (!a) this._dressSites.set(id, a = []);
    a.push({ x, y, z, yaw, scale });
    if (solid > 0) this._fixedColliders.push({ x, z, r: solid * scale, kind: id, bounce });
  }

  /** True if (x,z) is far enough from every landmark already placed. */
  _clearOfClaims(x, z, r) {
    for (let i = 0; i < this._claimed.length; i++) {
      const c = this._claimed[i];
      const dx = x - c.x, dz = z - c.z, rr = r + c.r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }

  /* ---------------- landmarks ----------------
     Sampled in a lateral band off the racing line so they are always in
     shot. A building also needs FLAT ground: `slopeAt` over 14° is rejected
     outright rather than fudged, because a hangar on a 20° slope has one
     corner in the air and no amount of sinking hides it. */
  _planLandmarks(rng) {
    const sp = this.data.spline, L = sp.length;
    for (const spec of this.plan.landmarks) {
      const maxSlope = spec.r > 3 ? 11 : 20;      // big footprint, flatter ground
      let placed = 0, guard = 0;
      while (placed < spec.n && guard++ < spec.n * 160) {
        const s = rng() * L;
        const side = rng() < 0.5 ? -1 : 1;
        const lat = spec.lat[0] + rng() * (spec.lat[1] - spec.lat[0]);
        const q = sp.offsetPoint(s, side * lat, _pp);
        const x = q.x, z = q.z;
        if (Math.abs(x) > PLAYABLE_EXT - 20 || Math.abs(z) > PLAYABLE_EXT - 20) continue;
        if (!this._canPlace(x, z, 2.4)) continue;
        if (this.terrain.slopeAt(x, z) > maxSlope) continue;
        if (!this._clearOfClaims(x, z, spec.r + 8)) continue;
        const scale = spec.size[0] + rng() * (spec.size[1] - spec.size[0]);
        // Face the road, roughly. A building that ignores the only road for
        // 40 km reads as placed; one that fronts onto it reads as lived in.
        const c = sp.posAt(s, _pp2);
        const yaw = Math.atan2(c.x - x, c.z - z) + (rng() - 0.5) * 0.5;
        this._dress(spec.id, x, this.terrain.heightAt(x, z), z, yaw, scale, spec.r);
        this._claimed.push({ x, z, r: spec.r + 6 });
        placed++;
      }
    }
  }

  /* ---------------- utility lines ----------------
     A pole line is the cheapest thing in this file and does more for scale
     than anything else: it gives the middle distance a rhythm, it crosses
     the road overhead, and it tells you how far away the horizon is. The
     wires are the whole point — poles alone read as fence posts. */
  _planUtilityLines(rng) {
    const cfg = this.plan.lines;
    const R = PLAYABLE_EXT * 0.94;
    const P = this.palette;
    const wireCol = 0x1c1e22;
    for (let run = 0; run < cfg.runs; run++) {
      const ang = rng() * Math.PI;                       // undirected chord
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const off = (rng() - 0.5) * R * 1.1;               // perpendicular offset
      const ox = -dz * off, oz = dx * off;
      const n = Math.floor(2 * R / cfg.span);
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const t = -R + i * cfg.span;
        const x = ox + dx * t, z = oz + dz * t;
        if (Math.abs(x) > PLAYABLE_EXT - 8 || Math.abs(z) > PLAYABLE_EXT - 8) { prev = null; continue; }
        // A pole may not stand on the road. The wire still spans the gap,
        // which is exactly what a real line does at a level crossing.
        const onRoad = this.terrain.onRoad(x, z) > 0.05 || !this._canPlace(x, z, 1.9);
        if (onRoad || this.terrain.slopeAt(x, z) > 26) { continue; }
        const y = this.terrain.heightAt(x, z);
        this._dress('pole', x, y, z, ang + Math.PI / 2, 1, 0.5, 1.2);
        if (prev && Math.hypot(x - prev.x, z - prev.z) < cfg.span * 2.4) {
          const topA = prev.y + cfg.poleH - 0.5, topB = y + cfg.poleH - 0.5;
          const sag = 0.9 + Math.hypot(x - prev.x, z - prev.z) * 0.012;
          for (const s of [-1, 1]) {
            const lx = -dz * s * 1.05, lz = dx * s * 1.05;
            const w = wireGeo(wireCol, prev.x + lx, topA + 0.13, prev.z + lz,
              x + lx, topB + 0.13, z + lz, sag, 5, 0.032);
            if (w) this._oneOff.push(w);
          }
        }
        prev = { x, y, z };
      }
    }
    void P;
  }

  /* ---------------- paddock ----------------
     Behind the grid, on the side the gantry legs are not on: canopies, a
     container or two, and the crew. This is the first thing a player sees on
     every single race, so it is worth the twenty props. */
  _planPaddock(rng) {
    const sp = this.data.spline;
    const side = rng() < 0.5 ? -1 : 1;
    const items = [
      ['canopy', -46, 1.0], ['canopy', -34, 1.0], ['canopy', -20, 1.0],
      ['container', -58, 1.0], ['container', 14, 1.0],
      ['crate', -28, 1.1], ['crate', -41, 0.9], ['drum', -24, 1.0], ['drum', -52, 1.0],
      ['bale', 4, 1.0], ['bale', -8, 1.0],
    ];
    for (const [id, ds, sc] of items) {
      const s = sp.wrapS(ds);
      const lat = side * (sp.widthAt(s) * 2.15 + 4 + rng() * 5);
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT - 10 || Math.abs(q.z) > PLAYABLE_EXT - 10) continue;
      if (this.terrain.slopeAt(q.x, q.z) > 17) continue;
      const d = sp.dirAt(s, _dd);
      this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z,
        Math.atan2(d.x, d.z) + (rng() - 0.5) * 0.4, sc, id === 'container' ? 3.2 : 0.9);
    }
    // crew, milling about between the canopies
    for (let i = 0; i < 12; i++) {
      const s = sp.wrapS(-56 + rng() * 70);
      const lat = side * (sp.widthAt(s) * 2.0 + 2 + rng() * 12);
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT - 10 || Math.abs(q.z) > PLAYABLE_EXT - 10) continue;
      const id = 'person' + (i % 3);
      this._crowdIds.add(id);
      this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z, rng() * 6.283, 0.94 + rng() * 0.14);
    }
  }

  /* ---------------- jump furniture ----------------
     The point of this game is the jumps, and until now the only thing that
     told you one was coming was a 1.5 m warning board. Every kicker now gets
     hay bales down the lip so the take-off edge is unmistakable at 40 m/s,
     and every HERO jump — anything with a gap, or a lip over 3 m — gets a
     sponsor arch over the ramp and a crowd that came to watch you get it
     wrong. The bales sit OUTSIDE the road corridor: they mark the edge, they
     never narrow it. */
  _planJumpFurniture(rng, accent) {
    const sp = this.data.spline;
    this.jumpArches = [];
    for (const j of this.data.jumps) {
      const hero = !!j.gap || j.h >= 3.0;
      const lipW = sp.widthAt(j.s);
      // bales along the ramp and down the far side of the landing
      const runs = hero ? [-j.len * 0.5, -j.len * 0.18, j.len * 0.16, (j.gap || 0) + j.len * 0.6]
        : [-j.len * 0.4, j.len * 0.2];
      for (const ds of runs) {
        const s = sp.wrapS(j.s + ds);
        for (const side of [-1, 1]) {
          const lat = side * (sp.widthAt(s) * 1.20 + 1.1);
          const q = sp.offsetPoint(s, lat, _pp);
          if (Math.abs(q.x) > PLAYABLE_EXT - 6 || Math.abs(q.z) > PLAYABLE_EXT - 6) continue;
          const d = sp.dirAt(s, _dd);
          this._dress('bale', q.x, this.terrain.heightAt(q.x, q.z), q.z,
            Math.atan2(d.x, d.z) + Math.PI / 2, 1, 0.7, 0.35);
        }
      }
      if (!hero) continue;
      this._buildJumpArch(j, accent, lipW);
      // spectators on the outside of the take-off, well back
      for (let i = 0; i < 14; i++) {
        const s = sp.wrapS(j.s - 12 + rng() * (j.len + 34));
        const side = i & 1 ? 1 : -1;
        const lat = side * (sp.widthAt(s) * 1.9 + 3 + rng() * 9);
        const q = sp.offsetPoint(s, lat, _pp);
        if (Math.abs(q.x) > PLAYABLE_EXT - 8 || Math.abs(q.z) > PLAYABLE_EXT - 8) continue;
        if (this.terrain.slopeAt(q.x, q.z) > 30) continue;
        const id = 'person' + (i % 3);
        this._crowdIds.add(id);
        const c = sp.posAt(s, _pp2);
        this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(c.x - q.x, c.z - q.z) + (rng() - 0.5) * 0.6, 0.92 + rng() * 0.16);
      }
      for (const side of [-1, 1]) {
        const s = sp.wrapS(j.s + 6);
        const lat = side * (sp.widthAt(s) * 2.3 + 6);
        const q = sp.offsetPoint(s, lat, _pp);
        if (Math.abs(q.x) > PLAYABLE_EXT - 8 || Math.abs(q.z) > PLAYABLE_EXT - 8) continue;
        if (this.terrain.slopeAt(q.x, q.z) > 20) continue;
        const c = sp.posAt(s, _pp2);
        this._dress('canopy', q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(c.x - q.x, c.z - q.z), 1, 0.9);
      }
    }
  }

  /**
   * Sponsor arch over a hero jump's take-off. Straddles the ramp at twice
   * the road width so nobody can hit a leg, and carries the jump's name —
   * which is the only place in the game a set piece is announced by name.
   */
  _buildJumpArch(j, accent, w) {
    const sp = this.data.spline;
    const s = sp.wrapS(j.s - j.len * 0.55);
    const span = w * 2.6 + 6;
    const H = 8.4;
    const g = new THREE.Group();
    const legGeo = this._keepGeo(new THREE.CylinderGeometry(0.22, 0.30, H, 9));
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, this.postMat);
      leg.position.set(side * span * 0.5, H * 0.5, 0);
      leg.castShadow = true;
      g.add(leg);
      const brace = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(2.1, 0.16, 0.16)), this.postMat);
      brace.position.set(side * (span * 0.5 - 0.8), H - 0.8, 0);
      brace.rotation.z = -side * 0.62;
      g.add(brace);
    }
    const beam = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(span, 0.40, 0.46)), this.postMat);
    beam.position.y = H; beam.castShadow = true; g.add(beam);
    const label = (j.name || 'BIG AIR').toUpperCase();
    const banner = new THREE.Mesh(
      this._keepGeo(new THREE.PlaneGeometry(span * 0.92, 1.9)),
      this._keepMat(new THREE.MeshStandardMaterial({
        map: this._keepTex(bannerTex(label, accent)),
        side: THREE.DoubleSide, roughness: 0.86, metalness: 0,
      })));
    banner.position.y = H - 1.25;
    banner.rotation.y = Math.PI;             // face the oncoming car
    banner.castShadow = true;
    g.add(banner);

    const p = sp.posAt(s, _pp), d = sp.dirAt(s, _dd);
    g.position.set(p.x, this.terrain.heightAt(p.x, p.z), p.z);
    g.rotation.y = Math.atan2(d.x, d.z);
    this.group.add(g);
    this.jumpArches.push(g);
    for (const side of [-1, 1]) {
      const q = sp.offsetPoint(s, side * span * 0.5, _pp);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 0.6, kind: 'arch', bounce: 1.1 });
    }
  }

  /* ---------------- corner crowds ----------------
     People gather where cars go wrong, which means the tightest corner on
     the lap. Same scan the warning boards use, so the crowd and the sign
     always agree about where the corner is. */
  _planCrowds(rng) {
    const sp = this.data.spline, L = sp.length;
    const corners = [];
    let run = null;
    for (let s = 0; s < L; s += 4) {
      const k = sp.curvatureAt(s);
      if (Math.abs(k) > 1 / 46) {
        if (!run || Math.abs(k) > Math.abs(run.k)) run = { s, k };
      } else if (run) { corners.push(run); run = null; }
    }
    corners.sort((a, b) => Math.abs(b.k) - Math.abs(a.k));
    for (const c of corners.slice(0, 3)) {
      const outside = c.k > 0 ? -1 : 1;
      for (let i = 0; i < 10; i++) {
        const s = sp.wrapS(c.s - 20 + rng() * 46);
        const lat = outside * (sp.widthAt(s) * 1.85 + 3 + rng() * 8);
        const q = sp.offsetPoint(s, lat, _pp);
        if (Math.abs(q.x) > PLAYABLE_EXT - 8 || Math.abs(q.z) > PLAYABLE_EXT - 8) continue;
        if (this.terrain.slopeAt(q.x, q.z) > 30) continue;
        const id = 'person' + (i % 3);
        this._crowdIds.add(id);
        const p = sp.posAt(s, _pp2);
        this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(p.x - q.x, p.z - q.z) + (rng() - 0.5) * 0.5, 0.92 + rng() * 0.16);
      }
      const s = sp.wrapS(c.s);
      const lat = outside * (sp.widthAt(s) * 2.5 + 7);
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) < PLAYABLE_EXT - 8 && Math.abs(q.z) < PLAYABLE_EXT - 8 &&
        this.terrain.slopeAt(q.x, q.z) < 20) {
        const p = sp.posAt(s, _pp2);
        this._dress('canopy', q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(p.x - q.x, p.z - q.z), 1, 0.9);
      }
    }
  }

  /** Turn the plan into meshes: one instanced draw per shape, one for wires. */
  _flushDressing() {
    this.dressMeshes = [];
    this.crowdMeshes = [];
    for (const [id, sites] of this._dressSites) {
      if (!sites.length) continue;
      const geo = this._kitGeo(id);
      const im = new THREE.InstancedMesh(geo, this.dressMat, sites.length);
      im.castShadow = true;
      im.receiveShadow = false;
      im.frustumCulled = false;
      for (let i = 0; i < sites.length; i++) {
        const st = sites[i];
        _dummy.position.set(st.x, st.y, st.z);
        _dummy.rotation.set(0, st.yaw, 0);
        _dummy.scale.setScalar(st.scale);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.dressMeshes.push(im);
      if (this._crowdIds.has(id)) this.crowdMeshes.push(im);
    }
    if (this._oneOff.length) {
      const merged = mergeGeometries(this._oneOff, false);
      this._oneOff.forEach(g => g.dispose());
      this._oneOff.length = 0;
      if (merged) {
        const m = new THREE.Mesh(this._keepGeo(merged), this.dressMat);
        m.castShadow = false;          // a shadow-casting wire is a stripe of acne
        m.frustumCulled = false;
        this.group.add(m);
        this.wireMesh = m;
      }
    }
    this._dressSites.clear();
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
    const L = sp.length;
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (!c.big || c.alt) continue;
      /* The first checkpoint sits at or near s = 0, which is where the start
         gantry already straddles the road — two banners on top of each other,
         the CHECK one reading through the ROAD RASH one. The gantry IS the
         first gate; skip anything inside 45 m of it. */
      const ds = Math.min(sp.wrapS(c.s), L - sp.wrapS(c.s));
      if (ds < 45) continue;
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
        /* A glancing hit should twist the car a little — clipping a rock
           squarely and carrying on straight reads as hitting a wall of jelly.
           The twist is arbitrary, so it used to be Math.random(); it is a hash
           of the CONTACT POINT instead, which looks identical and makes a race
           reproducible. That matters: dev/qa-drive.js compares lap times
           between builds, and an unseeded nudge here is enough noise on a
           three-lap race to hide a real regression. */
        if (v.omega) v.omega.y += (hash2(v.pos.x + nx, v.pos.z + nz) - 0.5) * Math.min(-vn, 5) * 0.08;
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

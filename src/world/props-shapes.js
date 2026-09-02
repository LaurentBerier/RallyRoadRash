/* ============================================================
   SCATTER GEOMETRY AND THE ROCK SHADER
   ------------------------------------------------------------
   Split out of props.js, which owns PLACEMENT and had grown past the
   house line limit carrying three unrelated jobs. This half is the one
   that makes SHAPES the kit cannot: everything here is either displaced
   from a primitive (rocks, hoodoos, basalt) or built without vertex
   colours because it wants a real material (pines, logs, cones, tyres).

   kit.js is the other shape file and the rule between them is simple:
   if it carries its colour in the vertex stream and merges with a hay
   bale, it belongs in kit.js. If it needs its own material — a triplanar
   rock, a green pine, an orange cone — it belongs here.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRNG, vnoise, fbm } from '../core/rng.js';

/** Deterministic 0..1 from a world point. Cheap, uncorrelated on a lattice. */
export function hash2(x, z) {
  let h = Math.imul((x * 8192) | 0, 0x27d4eb2d) ^ Math.imul((z * 8192) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Irregular rock. Three octaves of displacement then a radius quantise, so
    the silhouette is angular at every scale you can see it at. */
export function boulderGeo(seed, detail = 2, squash = 0.76) {
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
export function hoodooGeo(seed) {
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
  return finish(parts);
}

/** Conifer: a trunk and three stacked skirts. Merged so one instanced draw
    covers the whole tree. */
export function pineGeo(seed) {
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
  const g = finish(parts);
  g.userData.height = h;
  return g;
}

/** Fallen log, lying along X with a stub or two. */
export function logGeo(seed) {
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
  return finish(parts);
}

/** Columnar basalt: a hexagonal prism, snapped off at an angle. */
export function basaltGeo(seed) {
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
  return finish(parts);
}

/** Spatter cone around a vent — open at the top so it reads as a hole. */
export function ventGeo(seed) {
  const rng = makeRNG((seed * 49979687) | 1);
  const h = 1.4 + rng() * 2.2;
  const g = new THREE.CylinderGeometry(0.55 + rng() * 0.4, 2.1 + rng() * 1.4, h, 12, 1, true);
  g.translate(0, h * 0.5, 0);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Marker cone with a base. */
export function coneGeo() {
  return finish([
    new THREE.ConeGeometry(0.24, 0.68, 10, 1).translate(0, 0.36, 0),
    new THREE.BoxGeometry(0.52, 0.05, 0.52).translate(0, 0.025, 0)
  ]);
}

/** Stack of three tyres. Open cylinders, not tori: a torus of any usable
    smoothness is 170 triangles and there are four hundred of these — from a
    moving car the silhouette is a stack of dark rings either way. */
export function tyreStackGeo() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.CylinderGeometry(0.52, 0.52, 0.28, 11, 1, true);
    t.translate(0, 0.16 + i * 0.29, 0);
    parts.push(t);
  }
  return finish(parts);
}

/** A single upright quad from A to B, `h` metres tall, as its own geometry. */
export function railQuad(ax, ay, az, bx, by, bz, h) {
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

/** Merge, renormal, drop the uv. Every factory above ends the same way. */
function finish(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Triplanar rock surface injected into a standard material: no UVs needed on
    an arbitrary lump, world-space so neighbouring rocks never repeat, and
    faded with distance so a pebble at 80 m is not a pixel-sized noise
    generator. */
export function rockMaterial(color, dustCol) {
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

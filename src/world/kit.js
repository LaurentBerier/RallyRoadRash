/* ============================================================
   SET DRESSING KIT — the things in the world that are not rock
   ------------------------------------------------------------
   props.js owns PLACEMENT (where a thing goes, whether you can hit it, how
   the quality tier thins it out). This file owns SHAPE: every structure,
   plant, wreck and piece of junk that dresses a stage, as a plain
   BufferGeometry with nothing attached to it.

   THE ONE RULE THAT MAKES THIS CHEAP
   ----------------------------------
   Every geometry in here carries a per-vertex `color` and NO uv. That means
   a hangar, a pine snag, an oil drum and a spectator can all share one
   `MeshStandardMaterial({ vertexColors: true })` — so the entire set dressing
   of a stage merges into a handful of draw calls instead of one per kind, and
   a prop can be four colours without costing a second material. Anything that
   genuinely needs a texture (banners, flags) is built by props.js instead.

   CONVENTIONS, held by every factory here
     • +Y is up and y = 0 is where the thing meets the ground. A caller places
       a prop with terrain.heightAt() and nothing else.
     • +Z is the facing direction for anything that has a front.
     • Sizes are metres and are the REAL size — factories are not unit-scaled,
       because a 6 m pine and a 0.9 m oil drum want different silhouette
       detail, not the same one stretched.
     • `seed` makes a factory deterministic. The same seed is the same object
       forever, which is what lets props.js hide a prop at a lower quality
       tier instead of re-rolling the whole scatter.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRNG, clamp } from '../core/rng.js';

/* ============================================================
   1.  BUILDER
   ------------------------------------------------------------
   A tiny scene graph that flattens to one geometry. Every primitive takes a
   colour as its first argument; nothing else in the file allocates a
   material.
   ============================================================ */
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _yUp = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/** Attach a flat vertex colour and drop everything a merge cannot match. */
function tint(g, hex) {
  g.deleteAttribute('uv');
  g.deleteAttribute('uv1');
  g.deleteAttribute('uv2');
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  /* Colours are authored as sRGB hex and three's `color` ATTRIBUTE is read as
     already being in the working (linear) space — so exactly one conversion
     is owed here, and Color.set(hex) IS that conversion: with
     ColorManagement enabled (the default since r152) setHex decodes sRGB into
     the working space for you.
     This used to chain .convertSRGBToLinear() on top of it, which decoded a
     second time — mid grey 0x808080 landed at 0.038 instead of 0.216, five
     and a half times too dark. Every vertex-coloured thing in the game was
     wearing it: every plant, every building, every spectator, the item boxes
     and the boost pads. If props ever look a stop hot after a three upgrade,
     check whether ColorManagement is still on before adding a convert back. */
  _col.set(hex);
  for (let i = 0; i < n; i++) { c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Vary a colour by a signed fraction — one hex becomes a family. */
export function shade(hex, amount) {
  _col.set(hex);
  const f = 1 + amount;
  return new THREE.Color(
    clamp(_col.r * f, 0, 1), clamp(_col.g * f, 0, 1), clamp(_col.b * f, 0, 1)).getHex();
}

class Build {
  constructor() { this.parts = []; }

  _add(g, hex, x, y, z, rx, ry, rz) {
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.parts.push(tint(g, hex));
    return this;
  }

  box(hex, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this._add(new THREE.BoxGeometry(sx, sy, sz), hex, x, y, z, rx, ry, rz);
  }
  /** Box resting ON y, rather than centred on it — most furniture wants this. */
  slab(hex, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this.box(hex, sx, sy, sz, x, y + sy * 0.5, z, rx, ry, rz);
  }
  cyl(hex, rt, rb, h, seg, x, y, z, rx = 0, ry = 0, rz = 0, open = false) {
    return this._add(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), hex, x, y, z, rx, ry, rz);
  }
  /** Upright post standing ON y. */
  post(hex, r, h, x, y, z, seg = 7) {
    return this.cyl(hex, r, r * 1.08, h, seg, x, y + h * 0.5, z);
  }
  cone(hex, r, h, seg, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this._add(new THREE.ConeGeometry(r, h, seg), hex, x, y, z, rx, ry, rz);
  }
  sphere(hex, r, x, y, z, seg = 8) {
    return this._add(new THREE.SphereGeometry(r, seg, Math.max(4, seg * 0.6 | 0)), hex, x, y, z, 0, 0, 0);
  }
  /** Round member between two points — beams, wires, branches, cables. */
  tube(hex, ax, ay, az, bx, by, bz, r, seg = 6) {
    const lx = bx - ax, ly = by - ay, lz = bz - az;
    const len = Math.hypot(lx, ly, lz);
    if (len < 1e-4) return this;
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    _q.setFromUnitVectors(_yUp, _v.set(lx / len, ly / len, lz / len));
    _m.makeRotationFromQuaternion(_q);
    _m.setPosition((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    g.applyMatrix4(_m);
    this.parts.push(tint(g, hex));
    return this;
  }
  /** Double-sided quad, for anything flat enough that a box would be a lie. */
  plane(hex, sx, sy, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.PlaneGeometry(sx, sy);
    return this._add(g, hex, x, y, z, rx, ry, rz);
  }

  /** Merge and hand back. The builder is spent afterwards. */
  done() {
    if (!this.parts.length) return null;
    const g = this.parts.length === 1 ? this.parts[0] : mergeGeometries(this.parts, false);
    if (this.parts.length > 1) this.parts.forEach(p => p.dispose());
    this.parts.length = 0;
    /* Deliberately NOT computeVertexNormals(): every primitive already ships
       correct normals, rotate/translate carries them, and recomputing on a
       merged soup rounds off the hard edges that make a crate read as a
       crate. */
    return g;
  }
}

export function builder() { return new Build(); }

/* ============================================================
   2.  PALETTES
   ------------------------------------------------------------
   One table per theme. Everything in section 3 reads its colours from here,
   so a stage can be re-skinned without touching a single vertex.
   ============================================================ */
export const KIT_PALETTE = {
  training: {
    wood: 0x8a7550, timber: 0x6f5c3e, metal: 0x9aa1a8, rust: 0x8a5a34,
    paint: 0xd8dade, paintAlt: 0x2f6f9e, canvas: 0xe4e2da, canvasAlt: 0x2ad2ff,
    foliage: 0x5c7a3e, foliageAlt: 0x74904c, bark: 0x5a4a34, dead: 0x8a8064,
    concrete: 0xb4b1a6, dirt: 0x8b8578, glass: 0x2a3a44, hazard: 0xf0b21a,
  },
  canyon: {
    wood: 0x9a7a4e, timber: 0x7a5c38, metal: 0x8f8478, rust: 0x9c5626,
    paint: 0xd9c8a8, paintAlt: 0xff7a1a, canvas: 0xe8d9b8, canvasAlt: 0xd8531f,
    foliage: 0x5e7442, foliageAlt: 0x86934e, bark: 0x6b5334, dead: 0xa89468,
    concrete: 0xa89880, dirt: 0xb99a6a, glass: 0x3a3228, hazard: 0xf0b21a,
  },
  forest: {
    wood: 0x7a6444, timber: 0x5c4a30, metal: 0x8a9096, rust: 0x7a4a2c,
    paint: 0xc4c8c2, paintAlt: 0x2f6b46, canvas: 0xd6d8d0, canvasAlt: 0x4fd07a,
    foliage: 0x2c4426, foliageAlt: 0x3f5c30, bark: 0x4a3a28, dead: 0x7a6e58,
    concrete: 0x9aa0a0, dirt: 0x6b6c56, glass: 0x27332e, hazard: 0xf0b21a,
  },
  volcano: {
    wood: 0x5a4634, timber: 0x40342a, metal: 0x7c7670, rust: 0x8c4a24,
    paint: 0xa8a49e, paintAlt: 0xff5a2c, canvas: 0xa89a90, canvasAlt: 0xff8a3a,
    foliage: 0x4a4230, foliageAlt: 0x5c5238, bark: 0x342a22, dead: 0x54483c,
    concrete: 0x8a847e, dirt: 0x4a3c33, glass: 0x241c1a, hazard: 0xf0b21a,
  },
  /* THUNDER MESA. The canyon's rock and timber, but this is the built-up
     stage — floodlights, sponsor boards, tyre walls — so the paint and the
     canvas are a stop hotter than anywhere else. Under a nine-degree sun
     every one of those is either rim-lit or a silhouette, and a muted accent
     would simply disappear. */
  thunder: {
    wood: 0x9a7448, timber: 0x74522e, metal: 0x9a9088, rust: 0xa85a24,
    paint: 0xe4d2b0, paintAlt: 0xff5edc, canvas: 0xf0dcb4, canvasAlt: 0x2ad2ff,
    foliage: 0x5a6c3a, foliageAlt: 0x84904a, bark: 0x66502e, dead: 0xb09a68,
    concrete: 0xa89478, dirt: 0xba9660, glass: 0x2e2420, hazard: 0xf0b21a,
  },
};

export function kitPalette(theme) { return KIT_PALETTE[theme] || KIT_PALETTE.training; }

/* ============================================================
   3.  FACTORIES
   ------------------------------------------------------------
   Grouped by what they are for. Each takes (palette, seed, opts) and returns
   one merged, vertex-coloured geometry standing on y = 0.
   ============================================================ */

/* ---------------- foliage ---------------- */

/** Saguaro: a trunk and one or two arms that go up, out, then up again. */
export function cactusGeo(P, seed) {
  const rng = makeRNG((seed * 7907) | 1);
  const b = builder();
  const h = 2.6 + rng() * 2.8, r = 0.20 + rng() * 0.10;
  const green = shade(P.foliage, -0.10 + rng() * 0.24);
  b.cyl(green, r * 0.82, r, h, 9, 0, h * 0.5, 0);
  b.sphere(green, r * 0.82, 0, h, 0, 8);
  // Ribs: eight shallow flutes make it read as a cactus and not a bollard.
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    b.cyl(shade(green, -0.16), 0.028, 0.028, h * 0.94, 4,
      Math.cos(a) * r * 0.94, h * 0.48, Math.sin(a) * r * 0.94);
  }
  const arms = rng() < 0.72 ? (rng() < 0.4 ? 2 : 1) : 0;
  for (let i = 0; i < arms; i++) {
    const side = i === 0 ? (rng() < 0.5 ? -1 : 1) : (rng() < 0.5 ? 1 : -1);
    const ax = side * (rng() < 0.5 ? 1 : 0.7), az = side * (rng() < 0.5 ? 0.7 : 0);
    const y0 = h * (0.42 + rng() * 0.24), out = 0.42 + rng() * 0.34;
    const ar = r * (0.62 + rng() * 0.16), up = 0.7 + rng() * 1.1;
    b.tube(green, 0, y0, 0, ax * out, y0 + 0.22, az * out, ar, 8);
    b.tube(green, ax * out, y0 + 0.18, az * out, ax * out, y0 + 0.18 + up, az * out, ar, 8);
    b.sphere(green, ar, ax * out, y0 + 0.18 + up, az * out, 7);
  }
  return b.done();
}

/** Agave / yucca: a rosette of stiff blades, and sometimes a flower spike. */
export function agaveGeo(P, seed) {
  const rng = makeRNG((seed * 15013) | 1);
  const b = builder();
  const n = 7 + (rng() * 5 | 0);
  const base = shade(P.foliageAlt, -0.08 + rng() * 0.2);
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2 + rng() * 0.3;
    const len = 0.55 + rng() * 0.65, tilt = 0.55 + rng() * 0.55;
    b.tube(shade(base, (rng() - 0.5) * 0.18), 0, 0.06, 0,
      Math.cos(a) * len * Math.sin(tilt), 0.06 + len * Math.cos(tilt) + 0.1,
      Math.sin(a) * len * Math.sin(tilt), 0.035, 4);
  }
  if (rng() < 0.35) {
    const sh = 1.6 + rng() * 1.4;
    b.cyl(P.dead, 0.030, 0.045, sh, 5, 0, sh * 0.5 + 0.2, 0);
    for (let i = 0; i < 5; i++) {
      b.sphere(shade(P.dead, 0.15), 0.075, 0, 0.6 + i * (sh / 5), 0, 5);
    }
  }
  return b.done();
}

/** Low scrub. Three overlapping lumps and some twig, which at 40 m is a bush. */
export function bushGeo(P, seed) {
  const rng = makeRNG((seed * 32069) | 1);
  const b = builder();
  const c = shade(P.foliage, -0.14 + rng() * 0.3);
  const n = 3 + (rng() * 3 | 0);
  for (let i = 0; i < n; i++) {
    const r = 0.30 + rng() * 0.34;
    b.sphere(shade(c, (rng() - 0.5) * 0.22), r,
      (rng() - 0.5) * 0.55, r * (0.62 + rng() * 0.3), (rng() - 0.5) * 0.55, 7);
  }
  for (let i = 0; i < 4; i++) {
    const a = rng() * 6.283;
    b.tube(P.bark, 0, 0, 0, Math.cos(a) * 0.3, 0.42 + rng() * 0.3, Math.sin(a) * 0.3, 0.022, 4);
  }
  return b.done();
}

/** Dead standing tree — the snag. Bare, forked, and it holds its silhouette. */
export function snagGeo(P, seed) {
  const rng = makeRNG((seed * 49157) | 1);
  const b = builder();
  const h = 3.6 + rng() * 5.2;
  const c = shade(P.dead, -0.12 + rng() * 0.22);
  b.cyl(c, 0.10 + rng() * 0.06, 0.26 + rng() * 0.10, h, 7, 0, h * 0.5, 0);
  const forks = 2 + (rng() * 4 | 0);
  for (let i = 0; i < forks; i++) {
    const y = h * (0.35 + rng() * 0.55);
    const a = rng() * 6.283, out = 0.5 + rng() * 1.3, up = 0.3 + rng() * 1.2;
    b.tube(c, 0, y, 0, Math.cos(a) * out, y + up, Math.sin(a) * out, 0.045 + rng() * 0.03, 5);
  }
  return b.done();
}

/** Broadleaf: a real trunk, three boughs, and a clumped canopy. */
export function broadleafGeo(P, seed) {
  const rng = makeRNG((seed * 76079) | 1);
  const b = builder();
  const h = 5.0 + rng() * 4.5;
  const bark = shade(P.bark, -0.1 + rng() * 0.2);
  const leaf = shade(P.foliageAlt, -0.16 + rng() * 0.3);
  b.cyl(bark, 0.14, 0.26, h * 0.62, 7, 0, h * 0.31, 0);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * 6.283 + rng();
    const out = 0.7 + rng() * 0.6;
    b.tube(bark, 0, h * 0.5, 0, Math.cos(a) * out, h * 0.74, Math.sin(a) * out, 0.075, 5);
  }
  const lumps = 4 + (rng() * 3 | 0);
  for (let i = 0; i < lumps; i++) {
    const a = rng() * 6.283, out = rng() * 1.5;
    b.sphere(shade(leaf, (rng() - 0.5) * 0.2), 1.0 + rng() * 0.9,
      Math.cos(a) * out, h * (0.74 + rng() * 0.22), Math.sin(a) * out, 8);
  }
  return b.done();
}

/** Cut stump with a ring of splinters. Reads as logging, not as a rock. */
export function stumpGeo(P, seed) {
  const rng = makeRNG((seed * 93179) | 1);
  const b = builder();
  const r = 0.30 + rng() * 0.28, h = 0.32 + rng() * 0.46;
  b.cyl(P.bark, r * 0.94, r, h, 9, 0, h * 0.5, 0);
  b.cyl(shade(P.timber, 0.30), r * 0.90, r * 0.90, 0.05, 9, 0, h + 0.02, 0);
  for (let i = 0; i < 3; i++) {
    const a = rng() * 6.283;
    b.box(shade(P.timber, 0.1), 0.08, 0.34, 0.08,
      Math.cos(a) * r * 0.6, h + 0.14, Math.sin(a) * r * 0.6, (rng() - 0.5) * 0.5, a, (rng() - 0.5) * 0.5);
  }
  return b.done();
}

/** Obsidian: sharp black glass blades shoved up out of the ground. */
export function shardGeo(P, seed) {
  const rng = makeRNG((seed * 104711) | 1);
  const b = builder();
  const n = 2 + (rng() * 4 | 0);
  for (let i = 0; i < n; i++) {
    const h = 0.6 + rng() * 2.2;
    b.cone(shade(P.glass, -0.05 + rng() * 0.35), 0.16 + rng() * 0.26, h, 4,
      (rng() - 0.5) * 0.9, h * 0.46, (rng() - 0.5) * 0.9,
      (rng() - 0.5) * 0.42, rng() * 6.283, (rng() - 0.5) * 0.42);
  }
  return b.done();
}

/* ---------------- junk and debris ---------------- */

/** Oil drum, standing or on its side. Rust is the point. */
export function drumGeo(P, seed) {
  const rng = makeRNG((seed * 122777) | 1);
  const b = builder();
  const lying = rng() < 0.34;
  const c = rng() < 0.5 ? P.rust : shade(P.paintAlt, -0.25);
  const R = 0.30, H = 0.88;
  if (lying) {
    b.cyl(c, R, R, H, 12, 0, R, 0, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) b.cyl(shade(c, -0.22), R * 1.04, R * 1.04, 0.05, 12, s * H * 0.26, R, 0, 0, 0, Math.PI / 2);
  } else {
    b.cyl(c, R, R, H, 12, 0, H * 0.5, 0);
    for (const t of [0.28, 0.72]) b.cyl(shade(c, -0.22), R * 1.05, R * 1.05, 0.05, 12, 0, H * t, 0);
    b.cyl(shade(c, 0.12), R, R, 0.04, 12, 0, H + 0.02, 0);
  }
  return b.done();
}

/** Wooden crate, sometimes stacked, sometimes broken open. */
export function crateGeo(P, seed) {
  const rng = makeRNG((seed * 139969) | 1);
  const b = builder();
  const n = rng() < 0.45 ? 2 : 1;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = 0.62 + rng() * 0.28, hgt = s * (0.7 + rng() * 0.4);
    const c = shade(P.wood, -0.16 + rng() * 0.28);
    b.slab(c, s, hgt, s, (rng() - 0.5) * 0.16, y, (rng() - 0.5) * 0.16, 0, rng() * 0.5, 0);
    // corner battens, so the silhouette is not a plain cube
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.slab(shade(c, -0.2), 0.06, hgt, 0.06, sx * s * 0.47, y, sz * s * 0.47);
    }
    y += hgt;
  }
  return b.done();
}

/** Round hay bale — the softest thing you can hit and the friendliest marker. */
export function baleGeo(P, seed) {
  const rng = makeRNG((seed * 160001) | 1);
  const b = builder();
  const R = 0.62, W = 1.05;
  const c = shade(0xc9a648, -0.12 + rng() * 0.2);
  b.cyl(c, R, R, W, 12, 0, R, 0, 0, 0, Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    b.cyl(shade(c, -0.14), R * 1.02, R * 1.02, 0.05, 12, (i - 1.5) * W * 0.24, R, 0, 0, 0, Math.PI / 2);
  }
  return b.done();
}

/** Burnt-out rally car. Somebody got this corner wrong, once, permanently. */
export function wreckGeo(P, seed) {
  const rng = makeRNG((seed * 179429) | 1);
  const b = builder();
  const burnt = shade(0x2a2622, rng() * 0.3);
  const L = 3.4 + rng() * 0.8, W = 1.7;
  const tip = (rng() - 0.5) * 0.24;                 // sitting crooked in the dirt
  b.slab(burnt, W, 0.42, L, 0, 0.16, 0, tip, 0, (rng() - 0.5) * 0.3);
  b.slab(shade(burnt, 0.2), W * 0.82, 0.44, L * 0.42, 0, 0.56, -0.18, tip);  // cabin remains
  // roll cage, bent
  for (const s of [-1, 1]) {
    b.tube(P.rust, s * W * 0.36, 0.58, 0.5, s * W * 0.30, 1.14, -0.30, 0.045, 5);
    b.tube(P.rust, s * W * 0.30, 1.14, -0.30, s * W * 0.34, 0.62, -L * 0.42, 0.045, 5);
  }
  b.tube(P.rust, -W * 0.30, 1.14, -0.30, W * 0.30, 1.14, -0.30, 0.045, 5);
  // three wheels: the fourth is somewhere else entirely, which is the joke
  const hubs = [[-1, 1], [1, 1], [-1, -1]];
  for (const [sx, sz] of hubs) {
    b.cyl(0x18181a, 0.33, 0.33, 0.26, 10, sx * W * 0.46, 0.30, sz * L * 0.31, 0, 0, Math.PI / 2);
  }
  b.cyl(0x18181a, 0.33, 0.33, 0.26, 10, W * 0.9, 0.13, -L * 0.7, Math.PI / 2 + 0.3, 0, 0);
  return b.done();
}

/** Stack of scaffold pipe / drill rod — a work site, in one object. */
export function pipeStackGeo(P, seed) {
  const rng = makeRNG((seed * 196613) | 1);
  const b = builder();
  const len = 3.0 + rng() * 2.0, r = 0.075;
  let rowN = 4;
  for (let row = 0; row < 3; row++) {
    const y = r + row * r * 1.7;
    for (let i = 0; i < rowN; i++) {
      b.cyl(shade(P.rust, -0.1 + rng() * 0.3), r, r, len, 7,
        (i - (rowN - 1) * 0.5) * r * 2.1 + (row & 1 ? r : 0), y, 0, 0, 0, Math.PI / 2);
    }
    rowN--;
  }
  for (const s of [-1, 1]) b.slab(P.timber, 0.14, 0.14, 1.2, s * len * 0.36, 0, 0);
  return b.done();
}

/* ---------------- structures ---------------- */

/** Corrugated shack: four walls, a lean-to roof, a dark doorway. */
export function shedGeo(P, seed, w = 3.6, d = 3.0, h = 2.4) {
  const rng = makeRNG((seed * 217081) | 1);
  const b = builder();
  const wall = shade(P.metal, -0.2 + rng() * 0.3);
  const t = 0.09;
  b.slab(P.concrete, w + 0.3, 0.16, d + 0.3, 0, 0, 0);
  for (const s of [-1, 1]) b.slab(wall, t, h, d, s * w * 0.5, 0.14, 0);
  b.slab(wall, w, h, t, 0, 0.14, -d * 0.5);
  // front wall with a doorway punched through it
  const doorW = 1.0;
  for (const s of [-1, 1]) {
    b.slab(wall, (w - doorW) * 0.5, h, t, s * (w + doorW) * 0.25, 0.14, d * 0.5);
  }
  b.slab(wall, doorW, h - 2.0, t, 0, h - 1.86, d * 0.5);
  b.slab(P.glass, doorW * 0.94, 1.96, 0.03, 0, 0.14, d * 0.5 - 0.05);   // dark opening
  // roof, pitched back so rain runs off the door
  b.box(shade(wall, 0.16), w + 0.5, 0.10, d + 0.5, 0, h + 0.30, -0.05, -0.10);
  // corrugation: ribs across the front, cheap and it kills the flat panel look
  for (let i = 0; i < 7; i++) {
    b.slab(shade(wall, -0.14), 0.05, h, 0.03, (i - 3) * w * 0.15, 0.14, d * 0.5 + 0.05);
  }
  if (rng() < 0.6) b.cyl(P.rust, 0.07, 0.07, 1.6, 6, w * 0.34, h + 0.9, -d * 0.3);  // flue
  return b.done();
}

/** Shipping container. One box, done properly: corrugation and door furniture. */
export function containerGeo(P, seed) {
  const rng = makeRNG((seed * 233279) | 1);
  const b = builder();
  const L = 6.06, W = 2.44, H = 2.59;
  const c = rng() < 0.5 ? shade(P.paintAlt, -0.2 + rng() * 0.3) : shade(P.rust, rng() * 0.3);
  b.slab(c, W, H, L, 0, 0, 0);
  for (let i = 0; i < 18; i++) {
    const z = (i / 17 - 0.5) * L * 0.96;
    for (const s of [-1, 1]) b.slab(shade(c, -0.16), 0.05, H * 0.94, 0.10, s * W * 0.5, 0.03, z);
  }
  b.slab(shade(c, 0.14), W * 1.02, 0.16, L * 1.01, 0, H - 0.16, 0);
  for (const s of [-1, 1]) b.cyl(shade(c, -0.3), 0.05, 0.05, H * 0.92, 6, s * 0.5, H * 0.5, L * 0.5 + 0.03);
  return b.done();
}

/** Lattice tower with a cabin on top: control tower, fire lookout, mast. */
export function towerGeo(P, seed, h = 14, cabin = true) {
  const rng = makeRNG((seed * 250043) | 1);
  const b = builder();
  const base = 2.2, top = 1.0;
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const at = (i, t) => {
    const [sx, sz] = legs[i];
    const r = (base + (top - base) * t) * 0.5;
    return [sx * r, t * h, sz * r];
  };
  for (let i = 0; i < 4; i++) {
    const a = at(i, 0), c = at(i, 1);
    b.tube(P.metal, a[0], a[1], a[2], c[0], c[1], c[2], 0.075, 5);
    b.slab(P.concrete, 0.5, 0.3, 0.5, a[0], 0, a[2]);
  }
  const rungs = Math.max(3, Math.round(h / 2.2));
  for (let r = 1; r <= rungs; r++) {
    const t = r / (rungs + 0.2);
    for (let i = 0; i < 4; i++) {
      const a = at(i, t), c = at((i + 1) & 3, t);
      b.tube(P.metal, a[0], a[1], a[2], c[0], c[1], c[2], 0.035, 4);
      // one diagonal per face per bay — a full X doubles the cost for nothing
      const d = at((i + 1) & 3, Math.min(1, t + 1 / (rungs + 0.2)));
      b.tube(P.metal, a[0], a[1], a[2], d[0], d[1], d[2], 0.026, 4);
    }
  }
  if (cabin) {
    const cw = 2.6, ch = 2.1;
    b.slab(shade(P.paint, -0.1), cw, 0.16, cw, 0, h, 0);
    b.slab(P.glass, cw * 0.92, ch * 0.62, cw * 0.92, 0, h + 0.16, 0);
    b.slab(shade(P.paint, -0.2), cw * 0.96, 0.3, cw * 0.96, 0, h + 0.16 + ch * 0.62, 0);
    b.box(shade(P.paint, 0.1), cw * 1.22, 0.12, cw * 1.22, 0, h + ch + 0.16, 0);
    // rail around the deck
    for (const s of [-1, 1]) {
      b.tube(P.metal, s * cw * 0.6, h + 0.9, -cw * 0.6, s * cw * 0.6, h + 0.9, cw * 0.6, 0.028, 4);
      b.tube(P.metal, -cw * 0.6, h + 0.9, s * cw * 0.6, cw * 0.6, h + 0.9, s * cw * 0.6, 0.028, 4);
    }
  } else {
    b.tube(P.metal, 0, h, 0, 0, h + 4.5 + rng() * 3, 0, 0.05, 5);
    for (const s of [-1, 1]) b.tube(P.metal, s * 0.8, h + 2.2, 0, -s * 0.8, h + 2.2, 0, 0.03, 4);
  }
  return b.done();
}

/** Water tank on stilts. Every desert road has one and it reads at 400 m. */
export function waterTankGeo(P, seed, h = 9, R = 2.6) {
  const b = builder();
  const legs = 6;
  for (let i = 0; i < legs; i++) {
    const a = i / legs * Math.PI * 2;
    const x = Math.cos(a) * R * 0.78, z = Math.sin(a) * R * 0.78;
    b.tube(P.metal, x * 1.18, 0, z * 1.18, x, h, z, 0.065, 5);
    b.slab(P.concrete, 0.45, 0.25, 0.45, x * 1.18, 0, z * 1.18);
    const a2 = (i + 1) / legs * Math.PI * 2;
    b.tube(P.metal, x, h * 0.55, z, Math.cos(a2) * R * 0.78, h * 0.55, Math.sin(a2) * R * 0.78, 0.028, 4);
  }
  b.cyl(shade(P.metal, -0.12), R, R, 3.2, 14, 0, h + 1.6, 0);
  b.cyl(shade(P.metal, 0.10), R * 1.05, R * 1.05, 0.16, 14, 0, h + 3.2, 0);
  b.cone(shade(P.rust, 0.1), R * 1.02, 0.9, 14, 0, h + 3.7, 0);
  for (const t of [0.3, 0.7]) b.cyl(shade(P.metal, -0.26), R * 1.02, R * 1.02, 0.10, 14, 0, h + 0.2 + 3.2 * t, 0);
  return b.done();
}

/** Open-front hangar: an arched shell you can see straight through. */
export function hangarGeo(P, seed, W = 22, D = 16, H = 8) {
  const b = builder();
  const RIBS = 9, SEG = 9;
  const shell = shade(P.metal, -0.06);
  for (let r = 0; r < RIBS; r++) {
    const z = (r / (RIBS - 1) - 0.5) * D;
    for (let s = 0; s < SEG; s++) {
      const a0 = s / SEG * Math.PI, a1 = (s + 1) / SEG * Math.PI;
      b.tube(shell, Math.cos(a0) * W * 0.5, Math.sin(a0) * H, z,
        Math.cos(a1) * W * 0.5, Math.sin(a1) * H, z, 0.11, 4);
    }
  }
  // skin: purlins running the length, dense enough to read as a wall
  for (let s = 1; s < SEG; s++) {
    const a = s / SEG * Math.PI;
    b.tube(shade(shell, -0.08), Math.cos(a) * W * 0.5, Math.sin(a) * H, -D * 0.5,
      Math.cos(a) * W * 0.5, Math.sin(a) * H, D * 0.5, 0.09, 4);
  }
  /* Back wall, so it is a building and not a tunnel. Each panel is a COLUMN
     from the slab up to the arch at that x — sized to its own segment, not to
     the full ridge height. Panels of height H centred on the arch put three
     metres of wall underground and another six above the roof, which the kit
     check caught as a 15 m tall hangar. */
  for (let s = 0; s < SEG; s++) {
    const a = s / SEG * Math.PI, a1 = (s + 1) / SEG * Math.PI;
    const x = (Math.cos(a) + Math.cos(a1)) * W * 0.25;
    const top = Math.min(Math.sin(a), Math.sin(a1)) * H;
    if (top <= 0.05) continue;
    b.plane(shade(P.paint, -0.24), W / SEG * 1.3, top, x, top * 0.5, -D * 0.5, 0, 0, 0);
  }
  b.slab(P.concrete, W + 2, 0.22, D + 2, 0, 0, 0);
  return b.done();
}

/** Spectator grandstand: stepped bench rows under a cantilever roof. */
export function grandstandGeo(P, seed, len = 14, rows = 6) {
  const rng = makeRNG((seed * 262147) | 1);
  const b = builder();
  const step = 0.52, depth = 0.78;
  for (let r = 0; r < rows; r++) {
    const y = r * step, z = -r * depth;
    b.slab(P.timber, len, 0.14, depth, 0, y, z);                      // tread
    b.slab(shade(P.wood, 0.1), len, 0.34, 0.10, 0, y + 0.14, z - depth * 0.4);  // bench
    if (r % 2 === 0) {
      for (const s of [-1, 1]) b.tube(P.metal, s * len * 0.48, 0, z, s * len * 0.48, y, z, 0.05, 4);
    }
  }
  const backZ = -rows * depth;
  for (const s of [-1, 1]) {
    b.tube(P.metal, s * len * 0.46, 0, 0.4, s * len * 0.46, rows * step + 2.6, backZ + 0.3, 0.07, 5);
  }
  b.box(shade(P.metal, 0.12), len + 0.8, 0.12, rows * depth + 1.4,
    0, rows * step + 2.7, backZ * 0.5, -0.10);
  // a scatter of people, because an empty stand is worse than no stand
  const n = Math.round(len * rows * 0.35);
  for (let i = 0; i < n; i++) {
    if (rng() < 0.35) continue;
    const r = rng() * rows | 0;
    const x = (rng() - 0.5) * len * 0.94;
    b.cyl(shade(rng() < 0.5 ? P.canvasAlt : P.paint, (rng() - 0.5) * 0.5), 0.13, 0.16, 0.52, 5,
      x, r * step + 0.5, -r * depth - depth * 0.2);
    b.sphere(0xc9a184, 0.11, x, r * step + 0.86, -r * depth - depth * 0.2, 6);
  }
  return b.done();
}

/** Pop-up paddock canopy: four legs, a peaked roof, a table under it. */
export function canopyGeo(P, seed) {
  const rng = makeRNG((seed * 278917) | 1);
  const b = builder();
  const S = 3.0, H = 2.3;
  const cloth = rng() < 0.5 ? P.canvas : P.canvasAlt;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.tube(P.metal, sx * S * 0.5, 0, sz * S * 0.5, sx * S * 0.5, H, sz * S * 0.5, 0.038, 5);
  }
  for (let i = 0; i < 4; i++) {
    const a0 = i / 4 * Math.PI * 2 + Math.PI / 4, a1 = (i + 1) / 4 * Math.PI * 2 + Math.PI / 4;
    const r = S * 0.72;
    b.plane(shade(cloth, i & 1 ? -0.08 : 0.04),
      S * 1.06, S * 0.62,
      (Math.cos(a0) + Math.cos(a1)) * r * 0.25, H + 0.24,
      (Math.sin(a0) + Math.sin(a1)) * r * 0.25,
      -0.42, -(a0 + a1) * 0.5 + Math.PI / 2, 0);
  }
  b.slab(P.timber, 1.7, 0.06, 0.7, 0, 0.74, -S * 0.28);
  for (const sx of [-1, 1]) b.tube(P.metal, sx * 0.7, 0, -S * 0.28, sx * 0.7, 0.74, -S * 0.28, 0.03, 4);
  if (rng() < 0.6) b.slab(shade(P.paintAlt, 0.1), 0.6, 0.5, 0.5, 0.5, 0, S * 0.2);  // tool chest
  return b.done();
}

/** One standing spectator. Deliberately crude: they exist in crowds. */
export function personGeo(P, seed) {
  const rng = makeRNG((seed * 294911) | 1);
  const b = builder();
  const h = 1.62 + rng() * 0.20;
  const shirt = shade(rng() < 0.5 ? P.canvasAlt : P.paint, (rng() - 0.5) * 0.55);
  b.cyl(shade(P.glass, 0.25), 0.11, 0.13, h * 0.46, 5, 0, h * 0.23, 0);       // legs
  b.cyl(shirt, 0.15, 0.17, h * 0.34, 6, 0, h * 0.63, 0);                      // torso
  for (const s of [-1, 1]) b.cyl(shirt, 0.045, 0.05, h * 0.3, 4, s * 0.19, h * 0.62, 0, 0, 0, s * 0.12);
  b.sphere(0xc9a184, 0.105, 0, h * 0.87, 0, 6);
  if (rng() < 0.4) b.cyl(shade(P.hazard, (rng() - 0.5) * 0.4), 0.13, 0.13, 0.06, 6, 0, h * 0.93, 0);  // cap
  return b.done();
}

/* ---------------- infrastructure ---------------- */

/**
 * Utility pole. `arms` crossbars with insulators; the wires between poles are
 * built by the caller (props.js) because they need to know the next pole.
 */
export function poleGeo(P, seed, h = 8.5, arms = 2) {
  const rng = makeRNG((seed * 312397) | 1);
  const b = builder();
  const wood = shade(P.timber, -0.1 + rng() * 0.25);
  b.cyl(wood, 0.11, 0.17, h, 7, 0, h * 0.5, 0);
  for (let a = 0; a < arms; a++) {
    const y = h - 0.5 - a * 1.05, span = 1.5 - a * 0.25;
    b.box(shade(wood, 0.1), span * 2, 0.11, 0.11, 0, y, 0);
    b.tube(wood, 0, y - 0.75, 0, span * 0.7, y - 0.03, 0, 0.045, 4);
    b.tube(wood, 0, y - 0.75, 0, -span * 0.7, y - 0.03, 0, 0.045, 4);
    for (const t of [-1, -0.35, 0.35, 1]) {
      b.cyl(shade(P.glass, 0.5), 0.055, 0.075, 0.14, 6, t * span, y + 0.13, 0);
    }
  }
  return b.done();
}

/** Half-buried culvert / lava tube mouth: a dark arch cut into a bank. */
export function culvertGeo(P, seed, R = 1.8) {
  const b = builder();
  const SEG = 10;
  for (let s = 0; s < SEG; s++) {
    const a0 = s / SEG * Math.PI, a1 = (s + 1) / SEG * Math.PI;
    b.tube(P.concrete, Math.cos(a0) * R, Math.sin(a0) * R, 0,
      Math.cos(a1) * R, Math.sin(a1) * R, 0, 0.16, 4);
    b.tube(shade(P.concrete, -0.2), Math.cos(a0) * R, Math.sin(a0) * R, -1.6,
      Math.cos(a1) * R, Math.sin(a1) * R, -1.6, 0.16, 4);
  }
  /* The dark inside. Sized to the opening and standing ON the ground: a
     square R*1.9 across centred at R*0.5 put a third of the plate below the
     floor and the rest straight through the arch. */
  b.plane(0x0a0a0c, R * 1.8, R * 0.98, 0, R * 0.49, -1.7);
  return b.done();
}

/** Steam / fumarole pipework: a rusted manifold venting off a vent field. */
export function pipeworkGeo(P, seed) {
  const rng = makeRNG((seed * 331777) | 1);
  const b = builder();
  const h = 1.4 + rng() * 1.2;
  b.slab(P.concrete, 1.5, 0.22, 1.5, 0, 0, 0);
  b.cyl(P.rust, 0.16, 0.18, h, 8, 0, h * 0.5, 0);
  b.cyl(shade(P.rust, -0.2), 0.24, 0.24, 0.14, 8, 0, h * 0.62, 0);          // flange
  const runs = 2 + (rng() * 2 | 0);
  for (let i = 0; i < runs; i++) {
    const a = rng() * 6.283, len = 1.6 + rng() * 2.4;
    b.tube(P.rust, 0, h * 0.8, 0, Math.cos(a) * len, h * 0.8 - 0.2, Math.sin(a) * len, 0.10, 6);
    b.cyl(P.metal, 0.16, 0.16, 0.5, 7, Math.cos(a) * len, h * 0.8 - 0.2, Math.sin(a) * len);
  }
  b.cyl(P.metal, 0.10, 0.10, 0.7, 6, 0, h + 0.35, 0);                        // vent stack
  return b.done();
}

/** Stack of felled timber, chained. Logging camp in one prop. */
export function logStackGeo(P, seed) {
  const rng = makeRNG((seed * 350377) | 1);
  const b = builder();
  const len = 4.2 + rng() * 2.4, r = 0.24;
  let rowN = 5;
  for (let row = 0; row < 4 && rowN > 0; row++) {
    const y = r + row * r * 1.72;
    for (let i = 0; i < rowN; i++) {
      const c = shade(P.bark, -0.14 + rng() * 0.3);
      b.cyl(c, r, r * 1.06, len, 8,
        (i - (rowN - 1) * 0.5) * r * 2.05 + (row & 1 ? r : 0), y, (rng() - 0.5) * 0.3,
        0, 0, Math.PI / 2);
      b.cyl(shade(P.timber, 0.32), r * 0.94, r * 0.94, 0.05, 8,
        (i - (rowN - 1) * 0.5) * r * 2.05 + (row & 1 ? r : 0), y, 0, 0, 0, Math.PI / 2);
    }
    rowN--;
  }
  for (const s of [-1, 1]) {
    b.tube(P.metal, s * len * 0.34, 0, -1.0, s * len * 0.34, r * 7, -1.0, 0.05, 4);
    b.tube(P.metal, s * len * 0.34, 0, 1.0, s * len * 0.34, r * 7, 1.0, 0.05, 4);
  }
  return b.done();
}

/* ---------------- the arcade layer ---------------- */

/**
 * Item box. A chamfered cube on a floating diamond, in the theme's hazard
 * yellow with accent faces — it has to be unmistakable at 40 m/s against
 * four completely different palettes, which is why it borrows `hazard`
 * (0xf0b21a in every theme) rather than the theme accent.
 *
 * Built around y = 0.5 rather than resting on the ground: this is the one
 * kit shape that HOVERS, and props.js places it at a height rather than at
 * terrain level. The kit check's `sink` allowance covers the diamond's
 * bottom point.
 */
/* PICKUP CYAN, and it is deliberately NOT from the theme palette. The box used
   to be painted `P.hazard` — the same matte amber as every barrier, cone and
   warning prop in every theme — over a near-black emissive, so at any distance
   it read as one more piece of hazard furniture. A pickup has to be the one
   object on the stage that is obviously not scenery, and it has to look the
   same on all five stages so the lesson transfers. */
const BOX_CORE = 0xdff8ff;           // cyan-white
const BOX_MARK = 0x14c8e6;           // the ? and the ring under it

export function itemBoxGeo(P, seed) {
  const b = builder();
  const S = 0.52;                      // half-edge
  const core = BOX_CORE;
  // the cube, as six inset faces over a dark shell so the edges read
  b.box(shade(core, -0.45), S * 2.0, S * 2.0, S * 2.0, 0, 0.55, 0);
  const f = S * 1.72, d = S * 2.04;
  b.plane(core, f, f, 0, 0.55, d * 0.5, 0, 0, 0);
  b.plane(core, f, f, 0, 0.55, -d * 0.5, 0, Math.PI, 0);
  b.plane(shade(core, -0.12), f, f, d * 0.5, 0.55, 0, 0, Math.PI / 2, 0);
  b.plane(shade(core, -0.12), f, f, -d * 0.5, 0.55, 0, 0, -Math.PI / 2, 0);
  b.plane(shade(core, 0.14), f, f, 0, 0.55 + d * 0.5, 0, -Math.PI / 2, 0, 0);
  b.plane(shade(core, -0.30), f, f, 0, 0.55 - d * 0.5, 0, Math.PI / 2, 0, 0);
  /* A QUESTION MARK on each of the four upright faces, built from five accent
     bars the same way the chevrons were. A chevron is a direction; a "?" is
     the universal "unknown pickup", which is the one thing the box actually
     means and the one thing it never said. */
  const a = BOX_MARK;
  const QM = [
    // [w, h, x, y, rot] in face-local space — hook, stem, dot
    [0.20, 0.06, -0.02, 0.20, 0],
    [0.06, 0.10, 0.07, 0.14, 0],
    [0.06, 0.09, 0.00, 0.06, 0],
    [0.06, 0.09, 0.00, -0.02, 0],
    [0.07, 0.07, 0.00, -0.14, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const ang = i * Math.PI * 2 / 4;
    const sx = Math.sin(ang), cz = Math.cos(ang);
    const off = d * 0.5 + 0.012;
    for (const [w, h, lx, ly] of QM) {
      b.box(a, w, h, 0.045,
        sx * off + cz * lx, 0.55 + ly, cz * off - sx * lx, 0, ang, 0);
    }
  }
  // the diamond it floats on
  b.cone(shade(a, -0.15), 0.20, 0.34, 4, 0, 0.20, 0, Math.PI, 0, 0);
  b.cone(shade(a, 0.10), 0.20, 0.24, 4, 0, 0.20, 0);
  void seed; void P;
  return b.done();
}

/** The spare wheel: a knobbly tyre with a pale hub, and nothing else. */
export function spareWheelGeo(P, seed) {
  const rng = makeRNG((seed * 368113) | 1);
  const b = builder();
  const R = 0.30, W = 0.22;
  b.cyl(0x1a1a1c, R, R, W, 12, 0, R, 0, 0, 0, Math.PI / 2);
  for (const s of [-1, 1]) {
    b.cyl(shade(P.metal, 0.10), R * 0.44, R * 0.44, 0.04, 10, s * (W * 0.5 + 0.01), R, 0, 0, 0, Math.PI / 2);
  }
  // cleats — the silhouette while it is cartwheeling away from you
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2;
    b.box(shade(0x1a1a1c, 0.28), W * 0.86, 0.06, 0.10,
      0, R + Math.cos(a) * R * 0.97, Math.sin(a) * R * 0.97, a, 0, 0);
  }
  void rng;
  return b.done();
}

/**
 * Boost pad: a low chevron slab that lies ON the road, pointing the way you
 * are meant to cross it.
 *
 * Built at the default pad footprint from the track schema — 2 × hw (1.6) wide
 * and len (4) long, +Z being down the road — so a default pad instances at
 * scale 1 and only an authored hw/len has to scale. It is deliberately almost
 * flat: 6 cm of slab plus 2 cm of chevron. A pad that stands proud enough to
 * see from the cockpit is also tall enough to unsettle a car crossing it at
 * 40 m/s, and this is a reward, not a kerb.
 *
 * The chevrons carry the accent colour; the pulse and the glow are the
 * emissive material's job, not the geometry's.
 */
export function boostPadGeo(P, seed) {
  const b = builder();
  const W = 3.2, LEN = 4.0, T = 0.06;
  // the slab, dark so the chevrons read against it in any theme
  b.box(shade(P.concrete, -0.55), W, T, LEN, 0, T * 0.5, 0);
  // a thin lip either side, so the pad has an edge under a low sun
  for (const s of [-1, 1]) {
    b.box(shade(P.metal, -0.25), 0.14, T + 0.02, LEN, s * (W * 0.5 - 0.07), (T + 0.02) * 0.5, 0);
  }
  /* Three chevrons down the length. Each is two angled bars meeting on the
     centreline; brightness climbs toward the exit end so the arrow reads as
     motion even when the car is sitting still on top of it. */
  const a = P.paintAlt;
  for (let i = 0; i < 3; i++) {
    const z = -LEN * 0.5 + LEN * (0.22 + i * 0.28);
    const k = -0.18 + i * 0.18;
    for (const s of [-1, 1]) {
      b.box(shade(a, k), 0.22, 0.02, W * 0.52,
        s * W * 0.20, T + 0.01, z, 0, s * 0.90, 0);
    }
  }
  void seed;
  return b.done();
}

/* ---------------- the event layer ----------------
   Everything below exists because a rally stage that is only rocks and trees
   reads as a wilderness, and this is a RACE. Floodlights, sponsor boards,
   tyre walls and bunting are what say somebody set this up on purpose and
   people came to watch. They cluster around the start, the hero jumps and
   the big corners, and they are the whole visual identity of THUNDER MESA. */

/**
 * Stadium floodlight. A tapered mast, a rack of six heads, and guy braces.
 *
 * The lamp faces are near-white on purpose: they carry no emissive of their
 * own (this whole file is one vertex-coloured material), so all they can do
 * is be the brightest thing in the frame and let the bloom find them. Under
 * a low sun that is enough — a floodlight reads by its silhouette and by
 * six hot rectangles, not by casting light.
 */
export function floodlightGeo(P, seed, h = 12) {
  const rng = makeRNG((seed * 386117) | 1);
  const b = builder();
  const steel = shade(P.metal, -0.10 + rng() * 0.2);
  b.slab(P.concrete, 1.3, 0.34, 1.3, 0, 0, 0);
  b.cyl(steel, 0.13, 0.26, h, 8, 0, h * 0.5 + 0.30, 0);
  // three guys down to the pad: without them the mast reads as a lamppost
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.4;
    b.tube(shade(steel, -0.18), Math.cos(a) * 0.55, h * 0.62, Math.sin(a) * 0.55,
      Math.cos(a) * 1.9, 0.30, Math.sin(a) * 1.9, 0.035, 4);
  }
  // the rack: a spine, a back brace, and the heads hung off the front
  const top = h + 0.30, W = 3.0;
  b.box(steel, W, 0.16, 0.16, 0, top, 0);
  b.box(steel, W * 0.86, 0.12, 0.12, 0, top - 0.62, 0.30);
  for (const s of [-1, 1]) b.tube(steel, s * W * 0.42, top, 0, s * W * 0.34, top - 0.62, 0.30, 0.05, 4);
  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * W * 0.175;
    const y = top + (i & 1 ? 0.34 : 0.10);
    b.box(shade(steel, -0.24), 0.44, 0.34, 0.30, x, y, 0.16, -0.34, 0, 0);   // housing
    b.plane(0xfff6e0, 0.40, 0.30, x, y - 0.09, 0.33, -0.34, 0, 0);           // the lens
    b.box(shade(steel, 0.14), 0.48, 0.05, 0.05, x, y + 0.18, 0.26);          // hood
  }
  return b.done();
}

/**
 * Sponsor board. Legs, a lattice back, and a dark face panel.
 *
 * The face is deliberately BLANK here — props.js lays a canvas sponsor
 * texture over it the same way it does the start gantry, because this file
 * has no UVs by design and a texture needs them. What kit owns is the
 * structure; what props owns is what the structure is advertising.
 */
export function billboardGeo(P, seed, w = 9, h = 4.6) {
  const rng = makeRNG((seed * 402653) | 1);
  const b = builder();
  const steel = shade(P.metal, -0.14 + rng() * 0.22);
  const stand = 3.2;
  for (const s of [-1, 1]) {
    b.post(steel, 0.15, stand + h * 0.5, s * w * 0.34, 0, 0, 8);
    b.slab(P.concrete, 0.7, 0.22, 0.7, s * w * 0.34, 0, 0);
    // raking prop behind, which is what stops a board this size taking off
    b.tube(shade(steel, -0.2), s * w * 0.34, stand + h * 0.4, 0,
      s * w * 0.34, 0.2, -1.9, 0.07, 5);
  }
  const cy = stand + h * 0.5;
  b.box(shade(P.paint, -0.55), w, h, 0.16, 0, cy, -0.10);      // backing
  for (let i = 0; i < 5; i++) {                                 // lattice
    b.box(steel, 0.10, h * 1.02, 0.10, (i - 2) * w * 0.22, cy, -0.22);
  }
  b.box(steel, w * 1.03, 0.14, 0.26, 0, cy + h * 0.5, -0.10);
  b.box(steel, w * 1.03, 0.14, 0.26, 0, cy - h * 0.5, -0.10);
  // the face props.js will paper over, and a valance of lamps above it
  b.plane(shade(P.glass, 0.10), w * 0.96, h * 0.94, 0, cy, 0.02);
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * w * 0.26;
    b.tube(steel, x, cy + h * 0.5, 0.0, x, cy + h * 0.5 + 0.34, 0.42, 0.04, 4);
    b.box(0xfff2d8, 0.30, 0.10, 0.16, x, cy + h * 0.5 + 0.34, 0.44);
  }
  return b.done();
}

/**
 * Tyre wall. Three courses of scrap tyres strapped to a rail — the standard
 * answer to "what goes on the outside of this corner" at every circuit in
 * the world, and the friendliest thing in the game to hit at 40 m/s.
 */
export function tyreWallGeo(P, seed, len = 6) {
  const rng = makeRNG((seed * 419431) | 1);
  const b = builder();
  const R = 0.34, across = Math.max(2, Math.round(len / (R * 1.9)));
  for (let row = 0; row < 3; row++) {
    const y = R + row * R * 1.62;
    for (let i = 0; i < across; i++) {
      const x = (i - (across - 1) * 0.5) * R * 1.9 + (row & 1 ? R * 0.5 : 0);
      // open cylinders, not tori: from a moving car a stack of dark rings is
      // a stack of dark rings either way, at a sixth of the triangles. The
      // inner ring — the bit that makes it read as a HOLE — is skipped on
      // the bottom course, which is the one usually half in the dirt.
      b.cyl(shade(0x1c1c1e, rng() * 0.22), R, R, 0.26, 9, x, y, 0, Math.PI / 2, 0, 0, true);
      if (row > 0) b.cyl(shade(0x141416, 0.1), R * 0.62, R * 0.62, 0.24, 7, x, y, 0, Math.PI / 2, 0, 0, true);
    }
  }
  // conveyor strap across the face, and a painted capping rail
  b.box(shade(P.rust, -0.2), len * 1.02, 0.10, 0.06, 0, R * 2.4, 0.30);
  b.box(P.hazard, len * 1.04, 0.14, 0.34, 0, R * 4.05, 0);
  for (const s of [-1, 1]) b.post(P.metal, 0.07, R * 4.1, s * len * 0.5, 0, -0.18, 6);
  return b.done();
}

/**
 * A natural rock arch you drive THROUGH. The legs are colliders on the
 * props side; everything between them is clear air, which is the entire
 * point — the one landmark in the game that is also a gate.
 *
 * Built as a chain of short tapered cylinders following the arch line with
 * a jittered radius, rather than as a swept tube: the facets are what make
 * it read as fractured rock instead of as a pipe.
 */
export function rockArchGeo(P, seed, span = 26, h = 13) {
  const rng = makeRNG((seed * 434293) | 1);
  const b = builder();
  const base = shade(P.dirt, -0.30);
  const SEG = 15;
  const hx = span * 0.5;
  /* The arch line: a flattened half-ellipse, so the crown is broad. It
     springs from 0.35 rather than from 0 because the first segment is a
     three-metre cylinder whose end cap is tilted with the arch — starting
     at zero puts a quarter of a metre of that cap underground, and the
     buttress below hides the 0.35 completely. */
  const at = (t) => {
    const a = Math.PI * t;
    return [-Math.cos(a) * hx, Math.pow(Math.sin(a), 0.72) * h + 0.35, (rng() - 0.5) * 1.1];
  };
  let p = at(0);
  for (let i = 1; i <= SEG; i++) {
    const q = at(i / SEG);
    const t = i / SEG;
    // thick at the springing, thinnest a third of the way up, solid at the crown
    const r = 1.5 + 2.6 * Math.pow(Math.abs(0.5 - t) * 2, 1.8) + rng() * 0.5;
    b.tube(shade(base, -0.12 + rng() * 0.26), p[0], p[1], p[2], q[0], q[1], q[2], r, 7);
    p = q;
  }
  // buttresses at the feet: an arch with no shoulders looks like a croquet hoop.
  // No z-tilt on the cones — the arch is already sunk to the ankles by its own
  // springing tubes, and a tilted 5 m cone puts a corner half a metre under.
  for (const s of [-1, 1]) {
    b.cone(shade(base, -0.06 + rng() * 0.2), 4.2 + rng() * 1.2, h * 0.42, 7,
      s * (hx + 0.7), h * 0.23, (rng() - 0.5) * 1.4, 0, rng() * 6.283, 0);
    b.cyl(shade(base, -0.20), 2.6, 4.4, h * 0.30, 7, s * (hx + 0.2), h * 0.15, 0);
  }
  // a few cap blocks for the silhouette against the sky
  for (let i = 0; i < 5; i++) {
    const t = 0.30 + rng() * 0.40;
    const q = at(t);
    b.box(shade(base, 0.10 + rng() * 0.2), 2.0 + rng() * 1.6, 1.0 + rng(), 2.2 + rng(),
      q[0], q[1] + 1.6 + rng() * 0.8, q[2], (rng() - 0.5) * 0.4, rng() * 6.283, (rng() - 0.5) * 0.4);
  }
  return b.done();
}

/**
 * The falling sheet of a waterfall, standing on its plunge pool.
 *
 * NO UVs, like everything else here — props.js gives this one its own
 * scrolling additive material, which derives its texture coordinate from
 * OBJECT-SPACE POSITION instead. That is what lets a sheet with the same
 * attribute set as a hay bale still scroll. The vertex colour carries the
 * vertical ramp: glassy and dark at the lip where the water is still one
 * body, white and broken at the bottom where it is mostly air.
 */
export function waterfallSheetGeo(P, seed, w = 7, h = 16) {
  const rng = makeRNG((seed * 452930) | 1);
  const b = builder();
  const ROWS = 10, COLS = 3;
  const rowH = h / ROWS;
  for (let r = 0; r < ROWS; r++) {
        // 0 at the lip, 1 at the pool
    const t = 1 - (r + 0.5) / ROWS;
    const y = h - (r + 0.5) * rowH;
    // the sheet spreads and bows outward as it falls
    const wide = w * (0.72 + 0.42 * t);
    const bow = 0.9 * t * t;
    const col = shade(0x9fc4d8, -0.22 + 0.50 * t + (rng() - 0.5) * 0.10);
    for (let c = 0; c < COLS; c++) {
      const x = (c - (COLS - 1) * 0.5) * wide / COLS;
      b.plane(col, wide / COLS * 1.06, rowH * 1.10, x, y, bow + (rng() - 0.5) * 0.12,
        0, (c - 1) * -0.16, 0);
    }
  }
  // the lip, and the boil at the bottom. The boil sits ON the pool surface:
  // a sphere centred at its own radius has its underside at y = 0, which is
  // where the water is.
  b.box(shade(P.concrete, -0.3), w * 0.82, 0.5, 1.2, 0, h - 0.18, -0.1);
  for (let i = 0; i < 5; i++) {
    const r = 0.7 + rng() * 0.8;
    b.sphere(shade(0xdfeef4, -0.10 + rng() * 0.18), r,
      (rng() - 0.5) * w * 0.9, r * 0.94, 0.6 + rng() * 1.2, 7);
  }
  return b.done();
}

/**
 * A geyser vent: a mineral cone built up out of its own deposits, open at
 * the top. props.js fires dust and VFX up through it on a timer; all this
 * has to do is look like something that could.
 */
export function geyserVentGeo(P, seed) {
  const rng = makeRNG((seed * 471011) | 1);
  const b = builder();
  const R = 1.3 + rng() * 0.7, h = 0.55 + rng() * 0.55;
  const crust = shade(P.concrete, -0.06 + rng() * 0.22);
  // terraces: each flood leaves a rim slightly inside the last one
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    b.cyl(shade(crust, -0.10 + t * 0.24), R * (0.78 - t * 0.22), R * (1.0 - t * 0.20),
      h * 0.42, 11, 0, h * t + h * 0.21, 0);
  }
  b.cyl(shade(crust, 0.20), R * 0.56, R * 0.60, 0.10, 11, 0, h + 0.05, 0);   // rim
  b.plane(0x120c0a, R * 1.0, R * 1.0, 0, h + 0.02, 0, -Math.PI / 2, 0, 0);   // the throat
  // spatter, so the ground around it does not stop dead at the cone
  for (let i = 0; i < 6; i++) {
    const a = rng() * 6.283, d = R * (1.05 + rng() * 0.5), r = 0.10 + rng() * 0.16;
    b.sphere(shade(crust, -0.2 + rng() * 0.2), r,
      Math.cos(a) * d, r * 0.80, Math.sin(a) * d, 5);
  }
  return b.done();
}

/**
 * Catenary wire between two points, as a thin swept tube.
 * `sag` is the drop at midspan in metres. Built as one polyline of short
 * segments — a wire is two pixels wide, and anything cleverer is wasted.
 */
export function wireGeo(color, ax, ay, az, bx, by, bz, sag = 1.2, steps = 8, r = 0.035) {
  const b = builder();
  let px = ax, py = ay, pz = az;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const y = ay + (by - ay) * t - sag * 4 * t * (1 - t);
    b.tube(color, px, py, pz, x, y, z, r, 4);
    px = x; py = y; pz = z;
  }
  return b.done();
}

/**
 * Bunting: the same catenary as a wire, with pennants hanging off it.
 *
 * Free-standing like wireGeo rather than palette-driven, and for the same
 * reason — a run has to know where BOTH ends are, and only the caller does.
 * Two alternating flag colours, because one is a decoration and two is an
 * event. The pennants hang from the cord, so this geometry does NOT stand
 * on y = 0; it belongs strung between two things that do.
 */
export function buntingGeo(cord, flagA, flagB, ax, ay, az, bx, by, bz, sag = 1.4, n = 14) {
  const b = builder();
  const at = (t) => [ax + (bx - ax) * t, ay + (by - ay) * t - sag * 4 * t * (1 - t),
    az + (bz - az) * t];
  let p = at(0);
  for (let i = 1; i <= n; i++) {
    const q = at(i / n);
    b.tube(cord, p[0], p[1], p[2], q[0], q[1], q[2], 0.022, 4);
    p = q;
  }
  const len = Math.hypot(bx - ax, bz - az) || 1;
  // yaw so every pennant hangs square to the run
  const yaw = Math.atan2(bx - ax, bz - az) + Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const c = at((i + 0.5) / n);
    // a triangle would need a shape; a narrow tapered cone hung point-down
    // is two dozen triangles cheaper and reads identically at 30 m
    b.cone(i & 1 ? flagA : flagB, 0.17, 0.42, 3,
      c[0], c[1] - 0.23, c[2], Math.PI, yaw, 0);
  }
  void len;
  return b.done();
}

/* ============================================================
   SHARED PROCEDURAL IMAGERY
   ------------------------------------------------------------
   Small canvas-generated textures. Nothing here is loaded from disk:
   the repository ships no imagery at all, so there is nothing to
   license and nothing to download.

   Sprites are authored white-on-alpha and tinted in the shader, so one
   sheet serves every surface colour in SURFACES[].dustCol.
   ============================================================ */
import * as THREE from 'three';
import { fbm, ridged, vnoise, clamp, sstep, lerp } from '../core/rng.js';

/* ---------------- generic helpers ---------------- */

export function canvas2d(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Canvas -> texture. Sprite sheets want mipmaps off: with tiles packed two to
    a side, the coarse mips average across tile borders and a puff picks up its
    neighbour's alpha. Single sprites keep mips — they are drawn at every size. */
export function toTexture(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = opts.wrap || THREE.ClampToEdgeWrapping;
  t.wrapT = opts.wrapT || opts.wrap || THREE.ClampToEdgeWrapping;
  if (opts.flipY === false) t.flipY = false;
  t.generateMipmaps = opts.mipmaps !== false;
  t.minFilter = t.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = opts.aniso || 1;
  t.needsUpdate = true;
  return t;
}

/**
 * Grayscale noise field on a canvas — the generic one, for anyone who needs a
 * detail map without writing another loop.
 *
 * opts: { octaves, lac, gain, seed, scale, ridge, contrast, bias, tile, alpha }
 *   scale    cells across the canvas (default 4)
 *   ridge    0..1 blend toward a ridged multifractal (crests instead of blobs)
 *   contrast >1 pushes toward black/white around `bias`
 *   tile     cross-fade the field with itself so the canvas wraps (4x the cost)
 *   alpha    also write the value into the alpha channel
 */
export function noiseCanvas(size, opts = {}) {
  const {
    octaves = 4, lac = 2.07, gain = 0.5, seed = 1, scale = 4,
    ridge = 0, contrast = 1, bias = 0.5, tile = false, alpha = false
  } = opts;
  const c = canvas2d(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const S = scale;
  const at = (x, y) => {
    const a = fbm(x, y, octaves, lac, gain, seed);
    return ridge > 0 ? lerp(a, ridged(x, y, octaves, lac, gain, seed + 7), ridge) : a;
  };
  for (let j = 0; j < size; j++) {
    const fy = j / size;
    for (let i = 0; i < size; i++) {
      const fx = i / size;
      let v;
      if (tile) {
        // bilinear cross-fade of four shifted copies: the seams cancel out
        const wx = fx, wy = fy;
        v = (at(fx * S, fy * S) * (1 - wx) * (1 - wy) +
             at((fx - 1) * S, fy * S) * wx * (1 - wy) +
             at(fx * S, (fy - 1) * S) * (1 - wx) * wy +
             at((fx - 1) * S, (fy - 1) * S) * wx * wy);
      } else {
        v = at(fx * S, fy * S);
      }
      if (contrast !== 1) v = clamp((v - bias) * contrast + bias, 0, 1);
      const o = (j * size + i) * 4;
      const b = v * 255;
      d[o] = b; d[o + 1] = b; d[o + 2] = b; d[o + 3] = alpha ? b : 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* Two-octave value noise sampled straight from rng.js — used by the sprite
   makers below, where a full fbm() per pixel is more than the shape needs. */
function erode(x, y, seed) {
  return vnoise(x, y, seed) * 0.62 + vnoise(x * 2.13 + 9, y * 2.13 + 3, seed + 41) * 0.38;
}

/* ---------------- cloud / smoke ---------------- */

/**
 * One cumulus puff: a dome that sits on a flattish base, alpha eaten by noise
 * so the silhouette is lumpy rather than elliptical. RGB stays white — the
 * cloud shader tints the lit and shadowed sides itself.
 */
export function makeCloudSprite(S = 256, opts = {}) {
  const { seed = 3, softness = 0.55, erosion = 0.85, flatBase = 0.62 } = opts;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  const inv = 1 / S;
  for (let j = 0; j < S; j++) {
    const v = j * inv * 2 - 1;                 // -1 top .. +1 bottom
    for (let i = 0; i < S; i++) {
      const u = i * inv * 2 - 1;
      // an ellipse pushed up, then squashed under the base line
      const vy = v * (v > 0 ? 1 / (1 - flatBase * 0.55) : 0.82);
      let r = Math.sqrt(u * u * 1.15 + vy * vy);
      // lumpy radius: three lobes of low-frequency noise on the boundary
      const ang = Math.atan2(vy, u);
      r *= 1 - 0.20 * (erode(Math.cos(ang) * 1.6 + 3, Math.sin(ang) * 1.6 - 2, seed) - 0.5);
      let a = 1 - sstep(0.62 - softness * 0.35, 0.98, r);
      // interior erosion: holes and thin edges, the thing that stops it reading as a blob
      const n = erode(i * inv * 5.5 + 2, j * inv * 5.5 - 1, seed + 11) * 0.65 +
                erode(i * inv * 13.0 - 5, j * inv * 13.0 + 4, seed + 29) * 0.35;
      a *= lerp(1, 0.25 + 1.05 * n, erosion);
      // hard transparent border so bilinear filtering never smears a tile edge
      a *= sstep(0, 0.06, Math.min(Math.min(i, S - 1 - i), Math.min(j, S - 1 - j)) * inv * 2);
      const o = (j * S + i) * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
      d[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

/** Wispier, taller, more eaten-through: an ash column, not a fair-weather cumulus. */
export function makeSmokeSprite(S = 256, opts = {}) {
  const { seed = 17 } = opts;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  const inv = 1 / S;
  for (let j = 0; j < S; j++) {
    const v = j * inv * 2 - 1;
    for (let i = 0; i < S; i++) {
      const u = i * inv * 2 - 1;
      const r = Math.sqrt(u * u + v * v * 0.85);
      let a = 1 - sstep(0.10, 0.92, r);
      const n = erode(i * inv * 4.2 + 7, j * inv * 4.2 + 1, seed) * 0.5 +
                erode(i * inv * 11.0 - 3, j * inv * 11.0 + 8, seed + 63) * 0.5;
      a *= clamp((n - 0.20) * 1.9, 0, 1);
      a *= sstep(0, 0.06, Math.min(Math.min(i, S - 1 - i), Math.min(j, S - 1 - j)) * inv * 2);
      const o = (j * S + i) * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
      d[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

/* ---------------- particle sprites ---------------- */

/* Tile indices inside the dust atlas — the particle shader picks by `kind`. */
export const DUST_TILE = { PUFF: 0, CLOD: 1, EMBER: 2, SPECKLE: 3 };

/**
 * One particle sprite drawn into `d` at tile (tx, ty) of an S-wide sheet.
 * kind: 0 soft puff, 1 clod, 2 ember, 3 fine speckle.
 * RGB carries luminance detail (multiplied onto the per-particle colour),
 * alpha carries the shape.
 */
function drawGrain(d, sheet, T, tx, ty, kind, seed) {
  const inv = 1 / T;
  for (let j = 0; j < T; j++) {
    const v = j * inv * 2 - 1;
    for (let i = 0; i < T; i++) {
      const u = i * inv * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      let a = 0, lum = 1;
      if (kind === 0) {
        // soft puff: gaussian core with a noise-bitten edge
        a = Math.exp(-r * r * 2.35) * 1.15;
        const n = erode(i * inv * 3.4 + 1, j * inv * 3.4 + 5, seed) * 0.6 +
                  erode(i * inv * 8.5 - 2, j * inv * 8.5 + 3, seed + 19) * 0.4;
        a *= 0.34 + 0.86 * n;
        a *= 1 - sstep(0.72, 1.0, r);
        lum = 0.82 + 0.30 * n;
      } else if (kind === 1) {
        // clod: an irregular polygonal chunk, hard edged so it reads as solid
        const ang = Math.atan2(v, u);
        const wob = 0.72 + 0.26 * erode(Math.cos(ang) * 2.2 + 11, Math.sin(ang) * 2.2 - 4, seed);
        a = 1 - sstep(wob - 0.10, wob, r);
        const n = erode(i * inv * 6.0 + 4, j * inv * 6.0 - 6, seed + 5);
        lum = 0.58 + 0.62 * n;
        // a lit facet so a tumbling clod flickers instead of reading as a disc
        lum *= 1 + 0.35 * clamp(-(u * 0.6 + v * 0.8), 0, 1);
      } else if (kind === 2) {
        // ember: tight core, wide glow — the glow is what bloom picks up
        a = Math.exp(-r * r * 22.0) + Math.exp(-r * r * 3.0) * 0.42;
        a *= 1 - sstep(0.80, 1.0, r);
        lum = 1;
      } else {
        // speckle: a handful of hard grains for spray and grit
        a = 0;
        for (let k = 0; k < 5; k++) {
          const cx = (vnoise(k * 3.7 + 0.5, seed * 0.13 + 1.5, seed + k) - 0.5) * 1.3;
          const cy = (vnoise(k * 5.1 + 2.5, seed * 0.17 + 4.5, seed + k * 3) - 0.5) * 1.3;
          const rr = 0.10 + 0.13 * vnoise(k * 9.3 + 6.5, seed * 0.29 + 8.5, seed + k * 7);
          const dd = Math.sqrt((u - cx) * (u - cx) + (v - cy) * (v - cy));
          a = Math.max(a, (1 - sstep(rr * 0.55, rr, dd)) * (0.55 + 0.45 * (k / 5)));
        }
        lum = 0.75 + 0.4 * erode(i * inv * 7 + 3, j * inv * 7 + 9, seed + 33);
      }
      // transparent gutter: the atlas has no mips, but linear filtering still
      // reaches one texel past the tile at grazing sizes
      a *= sstep(0, 0.05, Math.min(Math.min(i, T - 1 - i), Math.min(j, T - 1 - j)) * inv * 2);
      const o = ((ty * T + j) * sheet + (tx * T + i)) * 4;
      const L = clamp(lum, 0, 1.6) * 255;
      d[o] = Math.min(255, L); d[o + 1] = Math.min(255, L * 0.99); d[o + 2] = Math.min(255, L * 0.97);
      d[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
}

/** A single grain sprite, if you want one on its own. kind per DUST_TILE. */
export function makeGrainSprite(kind = 0, T = 128, seed = 7) {
  const c = canvas2d(T, T);
  const g = c.getContext('2d');
  const img = g.createImageData(T, T);
  drawGrain(img.data, T, T, 0, 0, kind, seed);
  g.putImageData(img, 0, 0);
  return toTexture(c, { mipmaps: false });
}

/**
 * 2x2 sheet: puff | clod
 *            ember | speckle
 * One texture, one draw call, four particle looks. Mipmaps are off on purpose
 * (see toTexture) and every tile fades to zero alpha at its border.
 */
export function makeDustAtlas(T = 128, seed = 7) {
  const S = T * 2;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  drawGrain(img.data, S, T, 0, 0, 0, seed);
  drawGrain(img.data, S, T, 1, 0, 1, seed + 101);
  drawGrain(img.data, S, T, 0, 1, 2, seed + 211);
  drawGrain(img.data, S, T, 1, 1, 3, seed + 307);
  g.putImageData(img, 0, 0);
  // flipY off so tile (tx,ty) in canvas space is tile (tx,ty) in UV space —
  // the particle shader indexes tiles arithmetically from `kind`
  return toTexture(c, { mipmaps: false, flipY: false });
}

/* ---------------- impact VFX ----------------
   The dust atlas is for things made of ground. This one is for things made
   of energy: the shower off a scraped panel, the burst at the line, the
   pressure ring of a hit, the smear behind a projectile. Same rules — white
   on alpha, tinted per particle in the shader, one sheet, one draw call. */

/** Tile indices in the VFX atlas. Same (k%2, k/2) layout as DUST_TILE. */
export const VFX_TILE = { SPARK: 0, CONFETTI: 1, RING: 2, STREAK: 3 };

function drawVfx(d, sheet, T, tx, ty, kind, seed) {
  const inv = 1 / T;
  for (let j = 0; j < T; j++) {
    const v = j * inv * 2 - 1;
    for (let i = 0; i < T; i++) {
      const u = i * inv * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      let a = 0, lum = 1;
      if (kind === 0) {
        // SPARK: a hot pinpoint inside a small halo. The core has to be
        // small enough to survive the bloom without turning into a blob.
        a = Math.exp(-r * r * 42.0) + Math.exp(-r * r * 6.0) * 0.34;
        a *= 1 - sstep(0.78, 1.0, r);
        lum = 1;
      } else if (kind === 1) {
        // CONFETTI: a hard-edged slip of paper with a crease down it, so a
        // tumbling one flashes bright/dark instead of reading as a dot
        const c = 0.9239, s = 0.3827;                    // 22.5 degrees
        const px = u * c - v * s, py = u * s + v * c;
        a = (Math.abs(px) < 0.62 && Math.abs(py) < 0.30) ? 1 : 0;
        a *= 1 - sstep(0.52, 0.62, Math.abs(px));
        a *= 1 - sstep(0.22, 0.30, Math.abs(py));
        lum = 0.72 + 0.55 * clamp(1 - Math.abs(py + 0.06) * 5, 0, 1);
      } else if (kind === 2) {
        // RING: an expanding pressure front. Thin, hard on the outside,
        // trailing inward — the asymmetry is what gives it a direction.
        const w = 1 - sstep(0.74, 0.94, r);
        a = w * sstep(0.34, 0.86, r);
        a = a * a;
        lum = 0.85 + 0.5 * sstep(0.70, 0.90, r);
        a *= 1 - sstep(0.94, 1.0, r);
      } else {
        // STREAK: a long soft smear along X, for anything moving fast enough
        // that a round sprite would look like a bead
        const stretch = Math.abs(u) * 0.42;
        a = Math.exp(-(stretch * stretch + v * v * 5.5) * 3.4);
        a *= 1 - sstep(0.90, 1.0, Math.max(Math.abs(u), Math.abs(v)));
        const n = erode(i * inv * 6.0 + 3, j * inv * 6.0 - 2, seed + 71);
        lum = 0.80 + 0.40 * n;
      }
      a *= sstep(0, 0.05, Math.min(Math.min(i, T - 1 - i), Math.min(j, T - 1 - j)) * inv * 2);
      const o = ((ty * T + j) * sheet + (tx * T + i)) * 4;
      const L = Math.min(255, clamp(lum, 0, 1.6) * 255);
      d[o] = L; d[o + 1] = L; d[o + 2] = L;
      d[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
}

/**
 * 2x2 sheet: spark | confetti
 *            ring  | streak
 * Authored white-on-alpha exactly like the dust sheet, so world/vfx.js tints
 * every one of them per particle and the whole impact layer is one material.
 */
export function makeVfxAtlas(T = 128, seed = 23) {
  const S = T * 2;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  drawVfx(img.data, S, T, 0, 0, 0, seed);
  drawVfx(img.data, S, T, 1, 0, 1, seed + 113);
  drawVfx(img.data, S, T, 0, 1, 2, seed + 227);
  drawVfx(img.data, S, T, 1, 1, 3, seed + 331);
  g.putImageData(img, 0, 0);
  return toTexture(c, { mipmaps: false, flipY: false });
}

/**
 * Falling water, as a tile that repeats in BOTH axes.
 *
 * Everything periodic here is periodic in v by construction — the threads
 * are sine waves with an integer number of cycles across the canvas — so a
 * sheet can scroll forever with no seam. Which is the whole trick: a
 * waterfall is not a shape, it is one texture moving downward faster than
 * the eye can follow.
 */
export function makeStreakSprite(S = 256, opts = {}) {
  const { seed = 29, threads = 26 } = opts;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  const inv = 1 / S;
  for (let i = 0; i < S; i++) {
    const fx = i * inv;
    // one thread's centre, width and speed are fixed per column band
    const band = Math.floor(fx * threads);
    const jitter = vnoise(band * 3.1 + 0.5, seed * 0.31 + 1.5, seed + band);
    const cyc = 1 + Math.floor(jitter * 3);            // integer cycles => tiles in v
    const phase = vnoise(band * 7.7 + 2.5, seed * 0.17 + 4.5, seed + band * 5);
    const wide = 0.35 + jitter * 0.55;
    const local = Math.abs((fx * threads - band) * 2 - 1);
    const across = (1 - sstep(wide * 0.55, wide, local));
    for (let j = 0; j < S; j++) {
      const fy = j * inv;
      const flow = 0.5 + 0.5 * Math.sin((fy * cyc + phase) * Math.PI * 2);
      // foam is brightest where the thread necks down and breaks up
      const a = across * (0.30 + 0.70 * flow) * (0.55 + 0.45 * jitter);
      const lum = 0.78 + 0.30 * flow;
      const o = (j * S + i) * 4;
      const L = Math.min(255, lum * 255);
      d[o] = L; d[o + 1] = Math.min(255, L * 0.99); d[o + 2] = 255;
      d[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false, wrap: THREE.RepeatWrapping, mipmaps: false });
}

/**
 * A run of chevrons pointing along +V, tiling in V. White on alpha, so it
 * takes whatever colour the material multiplies it by — a boost pad, a
 * direction arrow on a berm, a scrolling floor marker.
 */
export function makeChevronTex(S = 128, opts = {}) {
  const { rows = 3, thickness = 0.16 } = opts;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = '#ffffff';
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  g.lineWidth = S * thickness;
  const step = S / rows;
  // one extra above and below so the chevron that straddles the seam is drawn
  for (let i = -1; i <= rows; i++) {
    const y = (i + 0.5) * step;
    g.globalAlpha = 1;
    g.beginPath();
    g.moveTo(S * 0.06, y + step * 0.26);
    g.lineTo(S * 0.5, y - step * 0.26);
    g.lineTo(S * 0.94, y + step * 0.26);
    g.stroke();
  }
  return toTexture(c, { srgb: false, wrapT: THREE.RepeatWrapping, mipmaps: false });
}

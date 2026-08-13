/* ============================================================
   RALLYE — terrain
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
import { fbm, ridged, vnoise, hash2i, clamp, sstep, lerp } from '../core/rng.js';
import { SURF, SURFACES } from './surfaces.js';
import { buildTrackData, paintAt, rampRise, LIP_HOLD } from './track.js';

/* ---------------- world constants (metres) ---------------- */
/** Half-extent of the racing world. Everything past this is vista. */
export const PLAYABLE_EXT = 600;
/** Radial soft fence, for anything that still wants one number. */
export const PLAYABLE_R = 620;

export const MACRO_EXT = 1360, MACRO_RES = 2048;      // 0.664 m / texel
export const FAR_EXT = 7200, FAR_RES = 512;           // horizon scenery
export const DET_TILE = 12, DET_RES = 256;            // 0.047 m / texel, tiling
export const DENT_EXT = 1200;                         // rut field extent
export const SUNMASK_EXT = 1500;
export const SURF_EXT = 1240, SURF_RES = 1024;        // 1.21 m / texel

/* Detail noise is deliberately small. REGOLITH could afford half a metre of
   grain because it faded the detail out with camera distance in the shader —
   a term the CPU could not see, and therefore a lie the moment a car is more
   than 95 m away. Here the amplitude is low enough to need no fade at all, so
   the two sides evaluate the identical expression everywhere. */
const DET_AMP = 0.135, DET_AMP2 = 0.052, DET_SCALE2 = 3.71;
export const FADE0 = 600, FADE1 = 668;   // macro -> far crossfade radius

const BERM_OUT = 1.72;      // berm reaches this multiple of the rut half-width
const BERM_GAIN = 0.85;     // how much displaced volume shows up as lip
const DIG_CAP = 0.22;       // hub-deep, not axle-deep: a rally car must always
                            // have a fighting chance of powering out of its hole
const SLUMP_TTL = 2.0;
const CURVE_R = 620000;     // horizon-curvature radius

/* ---- road carve tuning ---- */
const CARVE_STEP = 0.7;     // spline walk, metres
const SHOULDER_IN = 0.55;   // flat roadbed out to this fraction of half-width
const SHOULDER_OUT = 1.30;  // verge has fully fallen away by here
const VERGE_DROP = 0.85;    // metres the verge sits below the roadbed at 1.30w
const BLEND_W = 7;          // metres past the verge before the theme base is back
const MASK_IN = 0.80, MASK_OUT = 1.25;   // road mask feather, same units
const CORRIDOR = 45;        // slope-clamp reach beyond the shoulder
const BANK_SLOPE = 1.15;    // 49 deg: the steepest cut we allow next to a road
const BANK_FREE = 1.2;      // metres of free play before the clamp bites
const CROWN = 0.10;         // roadbed crown, centre high
const BANK_GAIN = 4.5, BANK_MAX = 1.3;   // corner banking from curvature

/* ============================================================
   1.  THEMES — sun, sky, haze, palette
   ============================================================
   The sun does not move during a race, which is what lets the occlusion
   mask be baked once at load instead of every frame. */

/* Canonical surface albedos. Themes tint these and may override individual
   entries; the shader gets the resolved 7-entry table as a uniform array. */
const SURF_BASE = [
  [0.44, 0.42, 0.39],   // ROAD   hardpack, two-tone in the shader
  [0.42, 0.32, 0.22],   // DIRT
  [0.76, 0.65, 0.45],   // SAND
  [0.20, 0.15, 0.11],   // MUD
  [0.44, 0.42, 0.40],   // ROCK
  [0.29, 0.37, 0.19],   // GRASS
  [0.30, 0.11, 0.06]    // LAVA   crust; the glow is emissive
];

export const THEMES = {
  training: {
    name: 'PROVING GROUNDS',
    sun: [0.38, 0.70, 0.60], sunCol: [1.34, 1.30, 1.20],
    sky: [0.40, 0.53, 0.72], ground: [0.26, 0.24, 0.20], ambient: 0.62,
    haze: [0.66, 0.73, 0.83], hazeDensity: 0.00050, hazeStart: 90,
    tint: [1.00, 1.00, 1.00],
    surf: {}
  },
  canyon: {
    // Late afternoon, sun low across the wash. Clear warm air: you can see the
    // far mesas, which is the whole point of a desert.
    name: 'SUNSTRIKE CANYON',
    sun: [0.74, 0.34, -0.58], sunCol: [1.62, 1.34, 1.02],
    sky: [0.46, 0.52, 0.70], ground: [0.38, 0.27, 0.18], ambient: 0.58,
    haze: [0.80, 0.68, 0.52], hazeDensity: 0.00032, hazeStart: 140,
    tint: [1.08, 0.98, 0.88],
    surf: { 4: [0.52, 0.27, 0.18], 1: [0.50, 0.35, 0.22] }   // red rock, red dirt
  },
  forest: {
    // Overcast-bright and misty: the haze is doing the work here, stacking the
    // pine ridges into layers instead of one flat green wall.
    name: 'TIMBERLINE CLIMB',
    sun: [-0.30, 0.76, 0.58], sunCol: [1.14, 1.16, 1.12],
    sky: [0.52, 0.58, 0.64], ground: [0.20, 0.22, 0.17], ambient: 0.82,
    haze: [0.66, 0.71, 0.72], hazeDensity: 0.00125, hazeStart: 45,
    tint: [0.94, 0.98, 0.94],
    surf: { 5: [0.24, 0.34, 0.16], 3: [0.17, 0.13, 0.09] }
  },
  volcano: {
    // Low red sun through smoke. Everything not lit by it is lit by the ground.
    name: 'CALDERA RUN',
    sun: [-0.62, 0.28, 0.73], sunCol: [1.50, 0.94, 0.62],
    // Ambient raised from 0.50 after QA: away-from-sun climbs read as a wall
    // of murk at 0.50, and this track needs its road legible at 130 km/h.
    sky: [0.34, 0.24, 0.23], ground: [0.28, 0.14, 0.09], ambient: 0.64,
    haze: [0.36, 0.20, 0.17], hazeDensity: 0.00115, hazeStart: 70,
    tint: [1.02, 0.90, 0.86],
    surf: { 4: [0.25, 0.23, 0.23], 1: [0.31, 0.24, 0.19] }
  }
};

/** Resolved 7x3 albedo table for a theme. */
export function themePalette(theme) {
  const T = THEMES[theme] || THEMES.training;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const o = T.surf[i] || SURF_BASE[i];
    out.push([o[0] * T.tint[0], o[1] * T.tint[1], o[2] * T.tint[2]]);
  }
  return out;
}

/* ============================================================
   2.  THEME BASE HEIGHT FIELDS
   ============================================================
   Smooth, low-frequency, and shared by BOTH the near and far bakes so the
   horizon joins the playable field without a seam. Everything sharp — the
   roadbed, the shoulders, the jump lips — arrives later, in the carve.

   These are deliberately not track-aware. The carve's slope clamp marries
   whatever the noise did to whatever the author asked for, which is why a
   58 m climb can be dropped onto a 20 m hillside and come out as a shelf
   road rather than a floating ribbon. */

/** Flat-topped plateaus on a jittered lattice — mesas, buttes, benches. */
function plateaus(x, z, cell, seed, hMin, hMax, prob, skirt) {
  let h = 0;
  const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = gx + dx, cz = gz + dz;
    if (hash2i(cx, cz, seed) > prob) continue;
    const px = (cx + 0.18 + 0.64 * hash2i(cx, cz, seed + 1)) * cell;
    const pz = (cz + 0.18 + 0.64 * hash2i(cx, cz, seed + 2)) * cell;
    const rr = hash2i(cx, cz, seed + 3);
    const r = cell * (0.20 + 0.26 * rr);
    const top = hMin + (hMax - hMin) * hash2i(cx, cz, seed + 4);
    // wobble the rim so no mesa is a cylinder
    const a = Math.atan2(z - pz, x - px);
    const wob = 1 + 0.16 * (vnoise(Math.cos(a) * 2.1 + cx * 3.3, Math.sin(a) * 2.1 + cz * 3.3, seed + 5) - 0.5) * 2;
    const d = Math.hypot(x - px, z - pz) / (r * wob);
    if (d > 1 + skirt) continue;
    // flat cap, steep face, talus apron: 1 -> 0 over the last quarter of the
    // radius, then a low fan that keeps the base from looking cut out
    const cap = 1 - sstep(0.74, 1.0, d);
    const fan = (1 - sstep(1.0, 1 + skirt, d)) * 0.14;
    h += top * (cap + fan);
  }
  return h;
}

/** Narrow, deep fissures. Ridged noise inverted and sharpened. */
function crevices(x, z, scale, seed, depth) {
  const r = ridged(x * scale, z * scale, 3, 2.1, 0.5, seed);
  const t = clamp((r - 0.78) / 0.22, 0, 1);
  return -t * t * depth;
}

/** Distant relief, common to every theme so the far bake always has something. */
function vista(x, z, r, seed, amp, start) {
  return sstep(start, start + 900, r) * (ridged(x * 0.00195, z * 0.00195, 5, 2.1, 0.55, seed) - 0.28) * amp;
}

const THEME_BASE = {
  /* A shallow dished arena with a berm around the outside — nothing to hit,
     nowhere to fall, and a horizon that tells you where the world ends. */
  training(x, z) {
    const r = Math.hypot(x, z);
    let h = (fbm(x * 0.0024, z * 0.0024, 3, 2.05, 0.5, 11) - 0.5) * 8;
    h -= 3.2 * sstep(300, 40, r);
    h += 17 * sstep(300, 540, r) * (0.70 + 0.60 * fbm(x * 0.006, z * 0.006, 2, 2, 0.5, 5));
    h += vista(x, z, r, 63, 120, 620);
    return h;
  },

  /* Rolling desert floor cut by washes, with mesas standing off it and a broken
     rim wall in the distance. The road ends up in the washes; the mesas end up
     as the walls the barriers run along. */
  canyon(x, z) {
    const r = Math.hypot(x, z);
    let h = (fbm(x * 0.00165, z * 0.00165, 4, 2.05, 0.5, 21) - 0.5) * 30;
    h += (fbm(x * 0.0072, z * 0.0072, 3, 2.1, 0.5, 29) - 0.5) * 5.5;   // dunes
    h += plateaus(x, z, 210, 33, 22, 48, 0.55, 0.55);
    h += plateaus(x, z, 78, 41, 6, 15, 0.30, 0.75);                    // hoodoo benches
    h += 34 * sstep(430, 640, r) * (0.5 + 0.9 * ridged(x * 0.0052, z * 0.0052, 3, 2.1, 0.5, 51));
    h += vista(x, z, r, 71, 205, 620);
    return h;
  },

  /* Ridge-and-valley country. Big wavelengths so the track can climb one flank
     for 400 m, plus a ridged overlay that gives the skyline its teeth. */
  forest(x, z) {
    const r = Math.hypot(x, z);
    let h = (fbm(x * 0.00125, z * 0.00125, 4, 2.1, 0.55, 31) - 0.5) * 86;
    h += (ridged(x * 0.0033, z * 0.0033, 3, 2.1, 0.5, 47) - 0.35) * 30;
    h += (fbm(x * 0.021, z * 0.021, 2, 2, 0.5, 3) - 0.5) * 2.0;        // ground lumps
    h += 26 * sstep(360, 620, r);
    h += vista(x, z, r, 83, 250, 600);
    return h;
  },

  /* Inside the caldera: a cinder cone in the middle, a broken rim wall right
     out at the edge of the world, crevices everywhere between. */
  volcano(x, z) {
    const r = Math.hypot(x, z);
    let h = -16 + (fbm(x * 0.00185, z * 0.00185, 4, 2.05, 0.5, 61) - 0.5) * 34;
    h += (fbm(x * 0.0095, z * 0.0095, 3, 2.1, 0.5, 67) - 0.5) * 4.4;
    // central cone with a summit crater
    const cone = Math.exp(-Math.pow(r / 118, 2));
    h += cone * (74 + 20 * ridged(x * 0.016, z * 0.016, 3, 2.1, 0.5, 73));
    h -= Math.exp(-Math.pow(r / 34, 2)) * 34;
    h += crevices(x, z, 0.0062, 79, 26);
    h += 92 * sstep(430, 620, r) * (0.45 + 0.95 * ridged(x * 0.0044, z * 0.0044, 4, 2.1, 0.5, 89));
    h += vista(x, z, r, 97, 230, 610);
    return h;
  }
};

/** The base-height function for a theme. Pure, deterministic, (x,z) -> metres. */
export function themeBaseFn(theme) { return THEME_BASE[theme] || THEME_BASE.training; }

/* ============================================================
   3.  BAKE
   ============================================================ */
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

/* periodic value noise, for the seamless detail tile */
function pvn(x, y, per, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = (a) => ((a % per) + per) % per;
  const a = hash2i(w(ix), w(iy), seed), b = hash2i(w(ix + 1), w(iy), seed);
  const c = hash2i(w(ix), w(iy + 1), seed), d = hash2i(w(ix + 1), w(iy + 1), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Box-filtered mip chain. A clipmap ring with 19 m cells cannot represent a
    20 m feature; without a filtered height field it interpolates straight
    across and leaves a row of tents on the horizon. */
function buildMips(base, res) {
  const mips = [{ data: base, width: res, height: res }];
  let src = base, w = res;
  while (w > 4) {
    const nw = w >> 1;
    const dst = new Float32Array(nw * nw);
    for (let y = 0; y < nw; y++) {
      const r0 = (y * 2) * w, r1 = r0 + w, o = y * nw;
      for (let x = 0; x < nw; x++) {
        const i = x * 2;
        dst[o + x] = (src[r0 + i] + src[r0 + i + 1] + src[r1 + i] + src[r1 + i + 1]) * 0.25;
      }
    }
    mips.push({ data: dst, width: nw, height: nw });
    src = dst; w = nw;
  }
  return mips;
}

/** clamp with a quadratic knee, so the top of a road cut is an edge you can
    see rather than a crease that catches the light like a knife. */
function softClamp(v, lo, hi, k) {
  if (v > hi - k) {
    const t = (v - (hi - k)) / k;
    v = t < 2 ? (hi - k) + k * (t - 0.25 * t * t) : hi;
  }
  if (v < lo + k) {
    const t = ((lo + k) - v) / k;
    v = t < 2 ? (lo + k) - k * (t - 0.25 * t * t) : lo;
  }
  return v;
}

/* ---------------- the road carve ----------------
   Rasterised as a chain of WEDGES: one sliver of ground per 0.7 m of spline,
   bounded by the bisector planes at each end and by the corridor width. The
   naive version — a disc or an axis-aligned box per step — tests thirty times
   more texels than it writes, and at 2 km of road that is seconds. The wedges
   are deliberately overlapped by a slop proportional to the local turn rate
   (with none, the outside of a hairpin gets radial gaps between slivers), and
   the winner for each texel is the wedge whose centreline is CLOSEST — which
   is the same answer a distance field would give. */
function* carveInto(C, spline, jumps, sMapBase, sMapScale, endTaper, report, prog0, prog1) {
  const { res, ext, x0, z0, nx, nz, cAcross, cTarget, cW, cS, cD } = C;
  const px = ext / res;
  const L = spline.length;
  const steps = Math.max(8, Math.ceil(L / CARVE_STEP));
  const step = L / steps;
  const closed = spline.closed;
  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  const dPrev = { x: 0, z: 0 }, dCur = { x: 0, z: 0 }, dNext = { x: 0, z: 0 };

  for (let k = 0; k < steps; k++) {
    const sA = k * step, sB = sA + step;
    if (!closed && sB > L) break;
    spline.posAt(sA, A); spline.posAt(closed ? sB : Math.min(sB, L), B);
    spline.dirAt(sA + step * 0.5, dCur);
    spline.dirAt(sA - step * 0.5, dPrev);
    spline.dirAt(sB + step * 0.5, dNext);
    const wA = spline.widthAt(sA), wB = spline.widthAt(sB);
    const kappaA = spline.curvatureAt(sA + step * 0.5);

    const dx = dCur.x, dz = dCur.z;
    const lx = dz, lz = -dx;                       // left of travel
    // bisector normals: the boundary between this wedge and its neighbours
    let nsx = dPrev.x + dx, nsz = dPrev.z + dz;
    let m = Math.hypot(nsx, nsz) || 1; nsx /= m; nsz /= m;
    let nex = dx + dNext.x, nez = dz + dNext.z;
    m = Math.hypot(nex, nez) || 1; nex /= m; nez /= m;

    const wMax = Math.max(wA, wB);
    const R = wMax * SHOULDER_OUT + CORRIDOR;
    // turn rate this step -> how far the neighbouring wedges must overlap for
    // the far edge of the corridor to stay covered
    const turn = Math.max(Math.abs(dCur.x * dPrev.z - dCur.z * dPrev.x),
      Math.abs(dNext.x * dCur.z - dNext.z * dCur.x));
    const slop = 0.55 + R * turn * 1.15;

    const zLo = Math.min(A.z, B.z) - R - slop, zHi = Math.max(A.z, B.z) + R + slop;
    let gz0 = Math.floor((zLo - z0) / px), gz1 = Math.ceil((zHi - z0) / px);
    if (gz0 < 0) gz0 = 0; if (gz1 > nz - 1) gz1 = nz - 1;

    for (let gz = gz0; gz <= gz1; gz++) {
      const wz = z0 + (gz + 0.5) * px;
      // four half-planes a*x + c >= 0 -> one x interval
      let xlo = -1e9, xhi = 1e9, empty = false;
      const con = (a, c) => {
        if (a > 1e-9) { const v = -c / a; if (v > xlo) xlo = v; }
        else if (a < -1e-9) { const v = -c / a; if (v < xhi) xhi = v; }
        else if (c < 0) empty = true;
      };
      con(nsx, -nsx * A.x + nsz * (wz - A.z) + slop);
      con(-nex, nex * B.x - nez * (wz - B.z) + slop);
      con(-lx, lx * A.x - lz * (wz - A.z) + R);
      con(lx, -lx * A.x + lz * (wz - A.z) + R);
      if (empty || xhi < xlo) continue;
      let gx0 = Math.floor((xlo - x0) / px), gx1 = Math.ceil((xhi - x0) / px);
      if (gx0 < 0) gx0 = 0; if (gx1 > nx - 1) gx1 = nx - 1;
      const row = gz * nx;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = x0 + (gx + 0.5) * px;
        const rx = wx - A.x, rz = wz - A.z;
        const across = lx * rx + lz * rz;
        const ad = across < 0 ? -across : across;
        let along = dx * rx + dz * rz;
        /* Winner is the wedge whose SEGMENT is nearest, not the one with the
           smallest across. Inside a hairpin the wedges overlap by metres, and
           comparing across alone compares distances measured in two different
           frames — which shows up as a 40 cm ridge down the middle of the
           apex. Distance to the segment is frame-free. */
        const over = along < 0 ? -along : (along > step ? along - step : 0);
        const dSeg = over > 0 ? Math.hypot(across, over) : ad;
        const i = row + gx;
        if (cW[i] > 0 && cD[i] <= dSeg) continue;
        if (along < 0) along = 0; else if (along > step) along = step;
        const u = along / step;
        const w = wA + (wB - wA) * u;
        if (ad > w * SHOULDER_OUT + CORRIDOR) continue;
        const s = sA + along;

        /* target = the finished road SURFACE at this point: crown, bank,
           verge and any kicker, all of it. Nothing about the cross-section is
           left for the resolve pass to guess at — see the note there. */
        let tgt = A.y + (B.y - A.y) * u;
        const tw = ad / w;
        tgt -= CROWN * tw * tw;                                     // crown
        /* Merge taper. Where a shortcut rejoins, two independently banked and
           verged roads meet along a Voronoi seam, and a metre of bank on one
           side against nothing on the other is a wheel-catching ledge exactly
           where cars are converging. Both terms fade out over the last 45 m of
           an open spline, so the junction is flat and the surfaces agree. */
        const tk = endTaper > 0
          ? clamp(Math.min(s, L - s) / endTaper, 0, 1) : 1;
        // banking: raise the outside of the corner. kappa > 0 turns left, so
        // the outside is negative-across.
        tgt += clamp(-kappaA * across * BANK_GAIN, -BANK_MAX, BANK_MAX) * tk;
        tgt -= VERGE_DROP * tk * sstep(SHOULDER_IN, SHOULDER_OUT, tw);
        if (jumps) tgt += jumpProfile(jumps, s, ad, w, L);

        cAcross[i] = across; cTarget[i] = tgt; cW[i] = w; cD[i] = dSeg;
        cS[i] = sMapBase + s * sMapScale;
      }
    }
    if ((k & 127) === 0) { report(prog0 + (prog1 - prog0) * (k / steps), 'carving the road'); yield; }
  }
}

/** Kicker ramps and carved voids, in metres to ADD to the roadbed height. */
function jumpProfile(jumps, s, ad, w, L) {
  let h = 0;
  for (let i = 0; i < jumps.length; i++) {
    const j = jumps[i];
    let ds = s - j.s;
    if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
    const gap = j.gap || 0;
    if (ds > gap + 2 || ds < -j.len - 1) continue;
    // the ramp face, tapered across so it is a kicker and not an earthwork
    const taper = 1 - sstep(0.78, 1.12, ad / w);
    if (taper > 0) {
      // rampRise + LIP_HOLD live in track.js: one definition of the kicker
      // face, shared with the racing line's launch-speed maths.
      if (ds <= 0 && ds >= -j.len) {
        h += rampRise(clamp((ds + j.len) / (j.len - LIP_HOLD), 0, 1), j.h) * taper;
      }
      else if (ds > 0) {
        // the back of the lip: near-vertical for a gap (you are meant to fly
        // it), 1.2 m of 70-degree face otherwise so a crawling car can get down
        const back = gap > 0 ? 0.4 : 1.2;
        if (ds < back) h += j.h * (1 - ds / back) * taper;
      }
    }
    if (gap > 0 && ds > 0 && ds < gap) {
      const D = clamp(gap * 0.62, 6, 10);
      // sheer take-off wall, flat floor, then a ramp back up to the landing
      const alongF = sstep(0, 0.4, ds) * (1 - sstep(gap * 0.58, gap, ds));
      // side walls at ~37 deg: steep enough to read as a chasm, shallow enough
      // that a failed jump can be crawled out of instead of needing a reset
      const acrossF = 1 - sstep(w * 1.1, w * 2.3, ad);
      h -= D * alongF * acrossF;
    }
  }
  return h;
}

/**
 * Bake a whole track. Generator: step it until done, calling report() as it
 * goes. Everything expensive happens here exactly once, at load.
 * @returns {object} baked — pass straight to `new Terrain(...)`.
 */
export function* bakeTrack(trackDef, report = () => { }) {
  const theme = trackDef.theme || 'training';
  const base = themeBaseFn(theme);
  const trackData = buildTrackData(trackDef);
  const spline = trackData.spline;
  const L = spline.length;

  /* --- 3a. macro base (coarse, then smoothly upsampled) --- */
  const CO = 640;
  const coarse = new Float32Array(CO * CO);
  for (let z = 0; z < CO; z++) {
    for (let x = 0; x < CO; x++) {
      const wx = (x / (CO - 1) - 0.5) * MACRO_EXT;
      const wz = (z / (CO - 1) - 0.5) * MACRO_EXT;
      coarse[z * CO + x] = base(wx, wz);
    }
    if ((z & 15) === 0) { report(0.02 + 0.20 * (z / CO), 'shaping the ground'); yield; }
  }

  /* Catmull-Rom upsample, done SEPARABLY: rows first into a strip, then
     columns. The naive 2D form costs 21 M spline evaluations at this size and
     blocks the main thread for seconds; separating it costs 5.5 M. */
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const xi = new Int32Array(MACRO_RES), xt = new Float32Array(MACRO_RES);
  for (let x = 0; x < MACRO_RES; x++) {
    const fx = (x / (MACRO_RES - 1)) * (CO - 1);
    xi[x] = Math.floor(fx); xt[x] = fx - xi[x];
  }
  const cxc = (v) => (v < 0 ? 0 : v > CO - 1 ? CO - 1 : v);
  const strip = new Float32Array(CO * MACRO_RES);
  for (let z = 0; z < CO; z++) {
    const row = z * CO, out = z * MACRO_RES;
    for (let x = 0; x < MACRO_RES; x++) {
      const i = xi[x];
      strip[out + x] = cr(coarse[row + cxc(i - 1)], coarse[row + cxc(i)],
        coarse[row + cxc(i + 1)], coarse[row + cxc(i + 2)], xt[x]);
    }
    if ((z & 63) === 0) { report(0.22 + 0.05 * (z / CO), 'resolving relief'); yield; }
  }
  const macro = new Float32Array(MACRO_RES * MACRO_RES);
  for (let z = 0; z < MACRO_RES; z++) {
    const fz = (z / (MACRO_RES - 1)) * (CO - 1), iz = Math.floor(fz), tz = fz - iz;
    const r0 = cxc(iz - 1) * MACRO_RES, r1 = cxc(iz) * MACRO_RES;
    const r2 = cxc(iz + 1) * MACRO_RES, r3 = cxc(iz + 2) * MACRO_RES;
    const out = z * MACRO_RES;
    for (let x = 0; x < MACRO_RES; x++) {
      macro[out + x] = cr(strip[r0 + x], strip[r1 + x], strip[r2 + x], strip[r3 + x], tz);
    }
    if ((z & 63) === 0) { report(0.27 + 0.10 * (z / MACRO_RES), 'resolving relief'); yield; }
  }

  /* --- 3b. carve the road --- */
  const roadMask = new Uint8Array(MACRO_RES * MACRO_RES);
  const px = MACRO_EXT / MACRO_RES;
  // Work only inside the track's own footprint: the carve buffers are four
  // floats per texel and the full field would be 67 MB of transient garbage.
  let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
  const pt = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < L; s += 4) {
    spline.posAt(s, pt);
    const rr = spline.widthAt(s) * SHOULDER_OUT + CORRIDOR + 3;
    bx0 = Math.min(bx0, pt.x - rr); bx1 = Math.max(bx1, pt.x + rr);
    bz0 = Math.min(bz0, pt.z - rr); bz1 = Math.max(bz1, pt.z + rr);
  }
  if (trackData.shortcutSpline) {
    const ss = trackData.shortcutSpline;
    for (let s = 0; s <= ss.length; s += 4) {
      ss.posAt(s, pt);
      const rr = ss.widthAt(s) * SHOULDER_OUT + CORRIDOR + 3;
      bx0 = Math.min(bx0, pt.x - rr); bx1 = Math.max(bx1, pt.x + rr);
      bz0 = Math.min(bz0, pt.z - rr); bz1 = Math.max(bz1, pt.z + rr);
    }
  }
  const half = MACRO_RES * 0.5;
  const gi0 = Math.max(0, Math.floor(bx0 / px + half)), gi1 = Math.min(MACRO_RES - 1, Math.ceil(bx1 / px + half));
  const gj0 = Math.max(0, Math.floor(bz0 / px + half)), gj1 = Math.min(MACRO_RES - 1, Math.ceil(bz1 / px + half));
  const nx = gi1 - gi0 + 1, nz = gj1 - gj0 + 1;
  const C = {
    res: MACRO_RES, ext: MACRO_EXT, nx, nz, gi0, gj0,
    x0: (gi0 - half) * px, z0: (gj0 - half) * px,
    cAcross: new Float32Array(nx * nz), cTarget: new Float32Array(nx * nz),
    cW: new Float32Array(nx * nz), cS: new Float32Array(nx * nz),
    cD: new Float32Array(nx * nz)
  };
  report(0.38, 'carving the road'); yield;
  yield* carveInto(C, spline, trackData.jumps, 0, 1, 0, report, 0.38, 0.48);
  if (trackData.shortcutSpline) {
    // The detour inherits the MAIN line's s so surface spans keep running down
    // it; racecore never asks the terrain where a shortcut racer is.
    const sc = trackDef.shortcut;
    let span = sc.s1 - sc.s0; if (span <= 0) span += L;
    yield* carveInto(C, trackData.shortcutSpline, null,
      sc.s0, span / trackData.shortcutSpline.length, 45, report, 0.48, 0.52);
  }

  /* resolve the carve into the height field + road mask */
  const roadS = new Float32Array(nx * nz);        // arc length, for the paint pass
  const roadLat = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const w = C.cW[c];
      if (w <= 0) { roadS[c] = -1; continue; }
      const across = C.cAcross[c];
      const ad = across < 0 ? -across : across;
      const tw = ad / w;
      const g = (gj0 + j) * MACRO_RES + (gi0 + i);
      /* The whole cross-section out to 1.30w was AUTHORED by the carve —
         crown, bank and verge are already in cTarget. Lerping the raw theme
         base across the shoulder instead looks reasonable until the base is
         30 m away vertically, at which point the lerp hits the clamp limit
         within centimetres of 0.55w and puts a 1.2 m step down the road edge. */
      const roadH = C.cTarget[c];
      const k = 1 - sstep(SHOULDER_OUT, SHOULDER_OUT + BLEND_W / w, tw);
      let h = macro[g] + (roadH - macro[g]) * k;
      // Slope clamp: within CORRIDOR metres of the verge nothing may sit
      // further from the road than a 49-degree cut. This is what lets a track
      // be authored on top of any theme noise at all without cliffs across it.
      const dd = ad - w * SHOULDER_OUT;
      if (dd < CORRIDOR) {
        const lim = BANK_FREE + BANK_SLOPE * Math.max(0, dd);
        h = softClamp(h, roadH - lim, roadH + lim, 2.2);
      }
      macro[g] = h;
      roadMask[g] = Math.round(255 * (1 - sstep(MASK_IN, MASK_OUT, tw)));
      // The shortcut carve stored s0 + fraction*span, which can run past L.
      roadS[c] = C.cS[c] - Math.floor(C.cS[c] / L) * L;
      roadLat[c] = across;
    }
    if ((j & 63) === 0) { report(0.52 + 0.06 * (j / nz), 'grading the shoulders'); yield; }
  }
  C.cAcross = C.cTarget = C.cW = C.cS = null;

  /* --- 3c. far horizon field --- */
  const far = new Float32Array(FAR_RES * FAR_RES);
  for (let z = 0; z < FAR_RES; z++) {
    for (let x = 0; x < FAR_RES; x++) {
      const wx = (x / (FAR_RES - 1) - 0.5) * FAR_EXT;
      const wz = (z / (FAR_RES - 1) - 0.5) * FAR_EXT;
      far[z * FAR_RES + x] = base(wx, wz);
    }
    if ((z & 31) === 0) { report(0.58 + 0.07 * (z / FAR_RES), 'plotting the horizon'); yield; }
  }

  /* --- 3d. seamless detail tile --- */
  const det = new Float32Array(DET_RES * DET_RES);
  const P = 16;
  for (let z = 0; z < DET_RES; z++) {
    for (let x = 0; x < DET_RES; x++) {
      const u = x / DET_RES * P, v = z / DET_RES * P;
      const d = pvn(u, v, P, 5) * 0.50 + pvn(u * 2, v * 2, P * 2, 6) * 0.28
        + pvn(u * 4, v * 4, P * 4, 7) * 0.14 + pvn(u * 8, v * 8, P * 8, 8) * 0.08;
      det[z * DET_RES + x] = d - 0.5;
    }
    if ((z & 63) === 0) { report(0.65 + 0.03 * (z / DET_RES), 'surface grain'); yield; }
  }
  {
    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < det.length; i++) { if (det[i] < mn) mn = det[i]; if (det[i] > mx) mx = det[i]; }
    const s = 1 / Math.max(mx - mn, 1e-6);
    for (let i = 0; i < det.length; i++) det[i] = (det[i] - mn) * s - 0.5;
  }

  /* --- 3e. surface map + bump map --- */
  const surf = new Uint8Array(SURF_RES * SURF_RES);
  const bumpF = new Float32Array(SURF_RES * SURF_RES);
  const defNoRoad = trackDef.paints
    ? Object.assign({}, trackDef, { paints: trackDef.paints.filter(p => p.type !== SURF.ROAD) })
    : trackDef;
  const spx = SURF_EXT / SURF_RES, shalf = SURF_RES * 0.5;
  const jumps = trackData.jumps;
  for (let j = 0; j < SURF_RES; j++) {
    const wz = (j - shalf + 0.5) * spx;
    const gj = Math.floor(wz / px + half);
    for (let i = 0; i < SURF_RES; i++) {
      const wx = (i - shalf + 0.5) * spx;
      const gi = Math.floor(wx / px + half);
      let s = -1, lat = 0, rm = 0;
      if (gi >= gi0 && gi <= gi1 && gj >= gj0 && gj <= gj1) {
        const c = (gj - gj0) * nx + (gi - gi0);
        s = roadS[c]; lat = roadLat[c];
        rm = roadMask[gj * MACRO_RES + gi] / 255;
      }
      let id = paintAt(trackDef, s, wx, wz, lat, L);
      // Hardpack only exists where there IS a road; off the mask, re-evaluate
      // without the ROAD spans so the verge keeps whatever it should have had.
      if (id === SURF.ROAD && rm < 0.45) id = paintAt(defNoRoad, s, wx, wz, lat, L);
      // Kicker faces are packed rock — but an authored hazard (the lava
      // fissure on CALDERA RUN) still wins, because that is the whole feature.
      if (s >= 0 && id !== SURF.LAVA && onJumpFace(jumps, s, Math.abs(lat), L)) id = SURF.ROCK;
      const o = j * SURF_RES + i;
      surf[o] = id;
      bumpF[o] = SURFACES[id] ? SURFACES[id].bump : 0.4;
    }
    if ((j & 63) === 0) { report(0.68 + 0.14 * (j / SURF_RES), 'painting surfaces'); yield; }
  }
  /* The surface map is sampled NEAREST (an id cannot be interpolated), but the
     roughness it drives cannot be: a hard step in the detail amplitude puts a
     1.2 m staircase across the ground. So bump gets its own blurred, bilinear
     copy — one term, two textures, both sides sampling identically. */
  const bumpTmp = new Float32Array(SURF_RES * SURF_RES);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? bumpF : bumpTmp, dst = pass === 0 ? bumpTmp : bumpF;
    for (let j = 0; j < SURF_RES; j++) {
      const jm = j > 0 ? j - 1 : 0, jp = j < SURF_RES - 1 ? j + 1 : SURF_RES - 1;
      for (let i = 0; i < SURF_RES; i++) {
        const im = i > 0 ? i - 1 : 0, ip = i < SURF_RES - 1 ? i + 1 : SURF_RES - 1;
        dst[j * SURF_RES + i] = (
          src[jm * SURF_RES + im] + src[jm * SURF_RES + i] + src[jm * SURF_RES + ip] +
          src[j * SURF_RES + im] + src[j * SURF_RES + i] * 4 + src[j * SURF_RES + ip] +
          src[jp * SURF_RES + im] + src[jp * SURF_RES + i] + src[jp * SURF_RES + ip]) / 12;
      }
    }
  }
  const bump = new Uint8Array(SURF_RES * SURF_RES);
  for (let i = 0; i < bump.length; i++) bump[i] = Math.round(clamp(bumpF[i], 0, 1) * 255);
  report(0.84, 'filtering for distance'); yield;

  const macroMips = buildMips(macro, MACRO_RES);
  const farMips = buildMips(far, FAR_RES);
  report(1.0, 'ready'); yield;

  return {
    macro, far, det, macroMips, farMips,
    roadMask, surf, bump,
    theme, trackDef, trackData
  };
}

function onJumpFace(jumps, s, ad, L) {
  for (let i = 0; i < jumps.length; i++) {
    const j = jumps[i];
    let ds = s - j.s;
    if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
    if (ds < -j.len - 2 || ds > (j.gap || 0) + 2) continue;
    if (ad < j.w * 1.6) return true;
  }
  return false;
}

/* ============================================================
   4.  GLSL — one height function, shared by every terrain shader
   ============================================================

   CPU / SHADER HEIGHT AGREEMENT
   -----------------------------
   Terrain.heightAt(x,z) and terrainH(p) below must return the same number
   for the same point, always. Term by term:

     term            CPU (heightAt)                     GPU (terrainH)
     ------------------------------------------------------------------
     macro field     bilinear(macro, MACRO_RES,         hMacro(): SAMPLE_H on
                       MACRO_EXT) — clamp-to-edge         uMacro, uv=p/uConst.x+0.5,
                       indexing, identical to             hardware LinearFilter or
                       GL_LINEAR/CLAMP_TO_EDGE            texBil() when the float
                                                          -linear extension is absent
     far field       bilinear(far, FAR_RES, FAR_EXT)    SAMPLE_H on uFar, same uv form
     macro->far      lerp by sstep(FADE0, FADE1,        mix by smoothstep(uConst3.z,
                       hypot(x,z))                        uConst3.w, length(p))
     road mask       bilinear(roadMask,MACRO_RES,       roadMaskAt(): texture2D on
                       MACRO_EXT)/255                     uRoad (R8, always LinearFilter
                                                          — no extension needed)
     bump            bilinear(bump, SURF_RES,           bumpAt(): texture2D on uBump
                       SURF_EXT)/255                      (R8, LinearFilter), uv=p/uConst3.x
     detail amp      (1-road*0.85)*(0.30+0.85*bump)     identical expression
     detail tile     bilinearWrap(det, DET_RES,         SAMPLE_H on uDetail with
                       x/DET_TILE, z/DET_TILE)*DET_AMP    RepeatWrapping, p/uConst.z,
                       + same at DET_SCALE2 with the      * uConst2.x, plus the
                       (0.37,0.71) offset * DET_AMP2      DET_SCALE2 tap * uConst2.y
     dent            -bilinear(dent,dentRes,DENT_EXT),  -hDent(): SAMPLE_H on uDent,
                       zero outside the field             zero outside 0.001..0.999

   There is deliberately NO camera-distance fade on the detail term and no
   per-ring amplitude scaling: either would be a height the CPU cannot see.
   The clipmap's sag (uSag) and the horizon curvature are applied AFTER
   terrainH, in the vertex shader only — they move where a vertex is drawn,
   not where the ground is.
   ============================================================ */
export const TERRAIN_GLSL = /* glsl */`
// ESSL 3.00 defaults samplers to lowp; the R32F height fields hold values to
// ~250 m, and a strict GLES driver's lowp is ±2. Desktop ANGLE ignores this —
// a mobile driver may not.
precision highp sampler2D;
uniform sampler2D uMacro, uFar, uDetail, uDent, uRoad, uBump;
uniform vec4 uConst;      // MACRO_EXT, FAR_EXT, DET_TILE, DENT_EXT
uniform vec4 uConst2;     // DET_AMP, DET_AMP2, DET_SCALE2, TRAIL_EXT
uniform vec4 uConst3;     // SURF_EXT, SURF_RES, FADE0, FADE1
uniform vec3 uCamXZ;
uniform vec2 uLod;
uniform vec4 uTexRes;     // macro, far, detail, dent texel counts

#ifdef MANUAL_BILINEAR
/* Four taps and a lerp — what the sampler would have done for us. Only the
   R32F height fields need this; the R8 masks filter natively everywhere. */
float texBil(sampler2D t, vec2 uv, float res){
  vec2 p = uv * res - 0.5;
  vec2 i = floor(p), f = fract(p);
  vec2 b = (i + 0.5) / res, e = vec2(1.0 / res, 0.0);
  float h00 = textureLod(t, b, 0.0).r;
  float h10 = textureLod(t, b + e.xy, 0.0).r;
  float h01 = textureLod(t, b + e.yx, 0.0).r;
  float h11 = textureLod(t, b + e.xx, 0.0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
  #define SAMPLE_H(t, uv, res, lod) texBil(t, uv, res)
#else
  #define SAMPLE_H(t, uv, res, lod) textureLod(t, uv, lod).r
#endif

float hMacro(vec2 p){
  vec2 uv = p / uConst.x + 0.5;
  float m = SAMPLE_H(uMacro, clamp(uv, 0.0005, 0.9995), uTexRes.x, uLod.x);
  float f = SAMPLE_H(uFar, clamp(p / uConst.y + 0.5, 0.0005, 0.9995), uTexRes.y, uLod.y);
  return mix(m, f, smoothstep(uConst3.z, uConst3.w, length(p)));
}
float roadMaskAt(vec2 p){
  return texture2D(uRoad, clamp(p / uConst.x + 0.5, 0.0005, 0.9995)).r;
}
float bumpAt(vec2 p){
  return texture2D(uBump, clamp(p / uConst3.x + 0.5, 0.0005, 0.9995)).r;
}
float hDetail(vec2 p){
  // No fract() here: the tile is RepeatWrapping, and folding the coordinate by
  // hand would put a hard seam at every tile boundary in BOTH paths.
  float d  = SAMPLE_H(uDetail, p / uConst.z, uTexRes.z, 0.0) * uConst2.x;
  d += SAMPLE_H(uDetail, p / uConst2.z + vec2(0.37, 0.71), uTexRes.z, 0.0) * uConst2.y;
  return d;
}
float hDent(vec2 p){
  vec2 uv = p / uConst.w + 0.5;
  if (any(lessThan(uv, vec2(0.001))) || any(greaterThan(uv, vec2(0.999)))) return 0.0;
  return SAMPLE_H(uDent, uv, uTexRes.w, 0.0);
}
float terrainH(vec2 p){
  float road = roadMaskAt(p);
  float bmp  = bumpAt(p);
  float amp  = (1.0 - road * 0.85) * (0.30 + 0.85 * bmp);
  return hMacro(p) + hDetail(p) * amp - hDent(p);
}
`;

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
  buildMaterial() {
    const T = THEMES[this.theme] || THEMES.training;
    const pal = themePalette(this.theme).map(c => new THREE.Vector3(c[0], c[1], c[2]));

    const U = this.uniforms = {
      uMacro: { value: this.texMacro }, uFar: { value: this.texFar },
      uDetail: { value: this.texDetail }, uDent: { value: this.texDent },
      uRoad: { value: this.texRoad }, uSurf: { value: this.texSurf },
      uBump: { value: this.texBump },
      uTrail: { value: this.trailRT.texture },
      uSunMask: { value: this.sunRT.texture },
      uConst: { value: new THREE.Vector4(MACRO_EXT, FAR_EXT, DET_TILE, DENT_EXT) },
      uConst2: { value: new THREE.Vector4(DET_AMP, DET_AMP2, DET_SCALE2, this.TRAIL_EXT) },
      uConst3: { value: new THREE.Vector4(SURF_EXT, SURF_RES, FADE0, FADE1) },
      uCamXZ: { value: new THREE.Vector3() },
      uSunDir: { value: this.sunDir.clone() },
      uSunCol: { value: new THREE.Vector3(T.sunCol[0], T.sunCol[1], T.sunCol[2]) },
      uSkyCol: { value: new THREE.Vector3(T.sky[0], T.sky[1], T.sky[2]) },
      uGroundCol: { value: new THREE.Vector3(T.ground[0], T.ground[1], T.ground[2]) },
      uAmbient: { value: T.ambient },
      uHazeCol: { value: new THREE.Vector3(T.haze[0], T.haze[1], T.haze[2]) },
      uHaze: { value: new THREE.Vector2(T.hazeDensity, T.hazeStart) },
      uSurfCol: { value: pal },
      uSunMaskExt: { value: SUNMASK_EXT },
      uCurveR: { value: CURVE_R },
      uCell: { value: 0.3 },
      uSag: { value: 0.0 },
      uLod: { value: new THREE.Vector2(0, 0) },
      uTexRes: { value: new THREE.Vector4(MACRO_RES, FAR_RES, DET_RES, this.dentRes) },
      uTime: { value: 0 },
      uFogK: { value: 1.0 },
      // vehicles + props, from three's directional shadow map
      uRShadow: { value: null },
      uRShadowMat: { value: new THREE.Matrix4() },
      uRShadowOn: { value: 0 },
      uRShadowTexel: { value: 1 / 2048 }
    };

    const vert = /* glsl */`
      ${TERRAIN_GLSL}
      uniform float uCurveR, uCell, uSag;
      varying vec3 vW; varying vec3 vN; varying float vDent; varying float vRoad;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 p = wp.xz;
        float h = terrainH(p);
        float e = max(uCell, 0.25);
        float hx = terrainH(p + vec2(e, 0.0));
        float hz = terrainH(p + vec2(0.0, e));
        vN = normalize(vec3(h - hx, e, h - hz));
        vDent = hDent(p);
        vRoad = roadMaskAt(p);
        wp.y = h - uSag;
        wp.y -= dot(p - uCamXZ.xy, p - uCamXZ.xy) / (2.0 * uCurveR);   // horizon curvature
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`;

    const frag = /* glsl */`
      precision highp float;
      #include <packing>
      varying vec3 vW; varying vec3 vN; varying float vDent; varying float vRoad;
      uniform sampler2D uSunMask, uTrail, uSurf;
      uniform sampler2D uRShadow; uniform mat4 uRShadowMat;
      uniform float uRShadowOn, uRShadowTexel;
      uniform vec3 uSunDir, uSunCol, uSkyCol, uGroundCol, uHazeCol;
      uniform vec3 uSurfCol[7];
      uniform float uSunMaskExt, uTime, uFogK, uAmbient;
      uniform vec2 uHaze;
      uniform vec4 uConst2, uConst3;

      float h1(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(h1(i),h1(i+vec2(1,0)),f.x), mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x), f.y); }
      const mat2 RA = mat2(0.8090,-0.5878,0.5878,0.8090);
      const mat2 RB = mat2(0.3090,0.9511,-0.9511,0.3090);
      float fb(vec2 p){ return n2(p)*0.55 + n2(RA*p*2.17+7.7)*0.30 + n2(RB*p*4.01+19.3)*0.15; }

      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        float dist = distance(vW.xz, cameraPosition.xz);
        float near = 1.0 - smoothstep(26.0, 190.0, dist);

        /* ---- which surface are we standing on ----
           The map is NEAREST because an id has no meaning halfway between two
           values. To stop the 1.2 m texel grid reading as a checkerboard, the
           lookup point is dithered by up to one texel — the boundary between
           two surfaces becomes an interlocking noise rather than a staircase,
           which is also what a real edge between rock and sand looks like. */
        float texel = uConst3.x / uConst3.y;
        vec2 jit = (vec2(fb(vW.xz*0.9), fb(vW.xz*0.9+31.7)) - 0.5) * texel * 1.25;
        vec2 suv = clamp((vW.xz + jit) / uConst3.x + 0.5, 0.0005, 0.9995);
        int sid = int(texture2D(uSurf, suv).r * 255.0 + 0.5);

        /* three's own unroll pragma rather than a dynamic uSurfCol[sid]: the
           index is legal in GLSL ES 3.00, but a fixed seven-way select costs
           nothing and cannot be miscompiled by a mobile driver. */
        vec3 albedo = uSurfCol[0];
        #pragma unroll_loop_start
        for (int i = 0; i < 7; i++) { if (UNROLLED_LOOP_INDEX == sid) albedo = uSurfCol[i]; }
        #pragma unroll_loop_end

        float rough = 1.0;          // 1 = fully diffuse, lower = a spec lobe appears
        vec3 emis = vec3(0.0);

        /* ---- micro relief: the grain has to CATCH the light, not be painted on ---- */
        #define GRIT(P) (n2((P)*4.1)*0.58 + n2((P)*16.0)*0.42)
        float g0 = GRIT(vW.xz);
        float varN = fb(vW.xz*0.31);
        float speck = n2(vW.xz*9.3);
        float gritK = 0.55;

        if (sid == 0) {
          /* ROAD — hardpack. Two-tone along the direction of travel: the
             centre crown stays pale and dusty, the wheel tracks either side
             are polished darker by everything that has driven them. */
          float polish = smoothstep(0.35, 0.95, vRoad);
          albedo *= 0.86 + 0.30*fb(vW.xz*0.22);
          albedo *= mix(1.0, 0.80, polish * (0.45 + 0.55*n2(vW.xz*0.9)));
          rough = 0.82; gritK = 0.22;
        } else if (sid == 1) {
          albedo *= 0.84 + 0.34*varN + 0.16*g0;              // DIRT: clods
          albedo *= 0.92 + 0.20*speck;
        } else if (sid == 2) {
          // SAND: bright, and rippled at a wavelength you can see from the car
          float rip = 0.5 + 0.5*sin(vW.x*1.7 + vW.z*0.9 + fb(vW.xz*0.12)*9.0);
          albedo *= 0.92 + 0.14*rip + 0.10*varN;
          gritK = 0.38;
        } else if (sid == 3) {
          // MUD: dark, wet, and the only surface here with a real highlight
          albedo *= 0.80 + 0.34*varN;
          albedo = mix(albedo, albedo*0.62, smoothstep(0.4, 0.8, fb(vW.xz*0.6)));
          rough = 0.28; gritK = 0.30;
        } else if (sid == 4) {
          albedo *= 0.74 + 0.42*fb(vW.xz*0.55) + 0.18*g0;    // ROCK: mottled, hard
          rough = 0.72; gritK = 0.85;
        } else if (sid == 5) {
          // GRASS: green broken with brown, at two scales, or it reads as felt
          // 'patch' is reserved in ESSL 3.00 (tessellation) — hence the terse name.
          float pch = fb(vW.xz*0.28);
          albedo = mix(albedo, vec3(0.34,0.30,0.16), smoothstep(0.42,0.78,pch));
          albedo *= 0.82 + 0.36*n2(vW.xz*2.7);
          gritK = 0.70;
        } else if (sid == 6) {
          /* LAVA: black crust cracked over something moving. The pulse is slow
             and out of phase across the field, so a channel breathes rather
             than blinking. */
          float crack = fb(vW.xz*0.85 + vec2(0.0, uTime*0.035));
          float glow = smoothstep(0.46, 0.80, crack);
          float pulse = 0.62 + 0.38*sin(uTime*0.9 + vW.x*0.05 + vW.z*0.031);
          albedo *= 0.55 + 0.30*crack;
          emis = vec3(2.6, 0.72, 0.14) * glow * pulse;
          rough = 0.55; gritK = 0.45;
        }

        /* ---- steep ground can't hold its coat ----
           The surface map is painted in plan view, so an embankment cut by the
           road carve gets the same GRASS or SAND id as the flat beside it — and
           a 60° green wall reads as a hedge, a pale one as a snowdrift. Loose
           cover slides off a slope in reality; blend steep faces toward the
           ROCK palette (darkened raw substrate) regardless of painted id. */
        float steep = smoothstep(0.86, 0.62, N.y);   // 0 flat .. 1 past ~38°
        if (sid != 6) {                              // lava keeps its glow
          vec3 scree = uSurfCol[4] * (0.62 + 0.30*fb(vW.xz*0.5) + 0.14*g0);
          albedo = mix(albedo, scree, steep * 0.85);
          rough = mix(rough, 0.8, steep);
        }

        vec3 Nr = N;
        if (near > 0.002 && gritK > 0.01){
          float e = 0.05;
          float gx = GRIT(vW.xz + vec2(e, 0.0));
          float gz = GRIT(vW.xz + vec2(0.0, e));
          Nr = normalize(N + vec3(-(gx-g0), 0.0, -(gz-g0)) * gritK * near);
        }

        /* ---- freshly churned ground is DARKER and wetter, not brighter ----
           (the moon got this the other way round: unweathered regolith is
           bright. Dirt is the opposite — you are turning up damp subsoil.) */
        float churn = smoothstep(0.02, 0.35, abs(vDent));
        albedo *= 1.0 - 0.30 * churn;
        rough = mix(rough, rough*0.72, churn);

        /* ---- tyre marks ----
           Sampled per PIXEL, not per vertex: a 0.35 m mark across a 0.30 m
           clipmap cell would otherwise be smeared into nothing. */
        vec2 tuv = vec2(vW.x, -vW.z) / uConst2.w + 0.5;
        float trackFade = 1.0 - smoothstep(150.0, 520.0, dist);
        float tr = (tuv.x>0.004&&tuv.x<0.996&&tuv.y>0.004&&tuv.y<0.996)
                 ? texture2D(uTrail, tuv).r * trackFade : 0.0;
        if (tr > 0.004){
          // Recover the direction of travel from the gradient of the trail
          // field so the tread lies ACROSS the mark instead of drifting through
          // it on some fixed diagonal.
          float e = 2.0 / uConst2.w;
          vec2 g = vec2(texture2D(uTrail, tuv + vec2(e,0.0)).r - texture2D(uTrail, tuv - vec2(e,0.0)).r,
                        texture2D(uTrail, tuv + vec2(0.0,e)).r - texture2D(uTrail, tuv - vec2(0.0,e)).r);
          vec2 across = vec2(g.x, -g.y);
          vec2 along = (length(across) > 1e-4) ? normalize(vec2(-across.y, across.x)) : vec2(1.0, 0.0);
          float tread = smoothstep(0.05, 0.9, 0.5 + 0.5*sin(dot(vW.xz, along * 34.0)));
          albedo *= mix(1.0, 0.46 + 0.24*tread, tr);
          rough = mix(rough, rough*0.80, tr);
          Nr = normalize(mix(Nr, N, tr*0.8));       // the grain is crushed flat
        }

        /* ---- shadowing: baked terrain self-shadow, sun is static per track ---- */
        vec2 smu = vW.xz / uSunMaskExt + 0.5;
        float sm = (smu.x>0.0&&smu.x<1.0&&smu.y>0.0&&smu.y<1.0) ? texture2D(uSunMask, smu).r : 1.0;

        /* ---- plus the cars and the props, from the real shadow map ----
           Without this the machine floats: nothing sells contact with a surface
           like the shadow it throws across it. */
        if (uRShadowOn > 0.5){
          vec4 sc = uRShadowMat * vec4(vW, 1.0);
          vec3 sp = sc.xyz / sc.w;
          if (sp.x > 0.001 && sp.x < 0.999 && sp.y > 0.001 && sp.y < 0.999 && sp.z < 1.0){
            float d = sp.z - 0.0016;
            float o = uRShadowTexel;
            float s = 0.0;
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2(-o,-o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2( o,-o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2(-o, o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2( o, o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy)));
            float edge = 1.0 - smoothstep(0.42, 0.5, max(abs(sp.x-0.5), abs(sp.y-0.5)));
            sm *= mix(1.0, s * 0.2, edge);
          }
        }

        /* ---- daylight: Lambert sun + hemisphere fill ---- */
        float ndl = max(dot(Nr, uSunDir), 0.0);
        vec3 col = albedo * uSunCol * ndl * sm;

        // hemisphere ambient: sky above, bounce off the ground below
        vec3 amb = mix(uGroundCol, uSkyCol, 0.5 + 0.5*N.y);
        col += albedo * amb * uAmbient;

        // one spec lobe, only where the surface earns it (wet mud, polished
        // hardpack, glassy lava crust)
        if (rough < 0.95){
          vec3 H = normalize(uSunDir + V);
          float sh2 = mix(4.0, 90.0, 1.0 - rough);
          float sp2 = pow(max(dot(Nr, H), 0.0), sh2) * (1.0 - rough) * 0.42;
          col += uSunCol * sp2 * sm;
        }
        col += emis;

        /* ---- distance haze toward the theme horizon ---- */
        float fogAmt = 1.0 - exp(-max(0.0, dist - uHaze.y) * uHaze.x * uFogK);
        col = mix(col, uHazeCol, clamp(fogAmt, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }`;

    this.material = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: vert, fragmentShader: frag, fog: false,
      defines: this.manualBilinear ? { MANUAL_BILINEAR: 1 } : {}
    });
  }

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
      // Built directly rather than cloned: ShaderMaterial.clone() deep-copies
      // the uniforms, which warns on every render-target texture in the set
      // and then has its work thrown away by the line below.
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign({}, this.uniforms),      // share the value objects
        vertexShader: this.material.vertexShader,
        fragmentShader: this.material.fragmentShader,
        defines: this.material.defines,
        fog: false
      });
      mat.uniforms.uCell = { value: cell };
      // Sag rises with cell size so a coarser ring always sits UNDER the finer
      // one it overlaps, hiding both the LOD step and any snapping mismatch.
      mat.uniforms.uSag = { value: i === 0 ? 0 : 0.10 * cell };
      mat.uniforms.uLod = {
        value: new THREE.Vector2(
          Math.max(0, Math.log2(cell / (MACRO_EXT / MACRO_RES))),
          Math.max(0, Math.log2(cell / (FAR_EXT / FAR_RES))))
      };
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
    this.texBump.dispose();
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

void SURF;

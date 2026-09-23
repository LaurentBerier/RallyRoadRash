/* ============================================================
   RALLY ROAD RASH — terrain bake
   ------------------------------------------------------------
   Everything that runs once, at load, to turn a track definition into the
   Float/byte fields the Terrain samples forever after: the theme base height
   field, the road carve, the surface paint and the mip chains.

   bakeTrack is a GENERATOR. It yields between slices so the loading screen
   can paint; nothing in here may allocate per frame because nothing in here
   runs per frame.

   The carve is the interesting part. The theme base is smooth, low-frequency
   noise that knows nothing about the track; the carve blends it toward the
   spline's own y over the roadbed, feathers the shoulder, cuts the kickers
   and gaps, and soft-clamps everything within CORRIDOR metres into a cone —
   which is why a 58 m climb can be authored on top of any hillside and come
   out as a shelf road instead of a floating ribbon.
   ============================================================ */
import { fbm, ridged, vnoise, hash2i, clamp, sstep } from '../core/rng.js';
import { SURF, SURFACES } from './surfaces.js';
import { buildTrackData, paintAt, rampRise, LIP_HOLD, DROP_RUN } from './track.js';
import {
  MACRO_EXT, MACRO_RES, FAR_EXT, FAR_RES, DET_RES, SURF_EXT, SURF_RES,
} from './terrain-const.js';

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
/* Authored features blend in over these, in metres of arc length. 12 m is
   roughly a car length and a half at speed: long enough that the transition
   never registers as a step, short enough that a 60 m bank is mostly bank. */
const BANK_TAPER = 12, BERM_TAPER = 10;

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
function plateaus(x, z, cell, seed, hMin, hMax, prob, skirt, eroded = false) {
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
    const fluting=eroded ? .075*Math.sin(a*11+cx)+.04*Math.sin(a*23+cz) : 0;
    const d = Math.hypot(x - px, z - pz) / (r * (wob+fluting));
    if (d > 1 + skirt) continue;
    // flat cap, steep face, talus apron: 1 -> 0 over the last quarter of the
    // radius, then a low fan that keeps the base from looking cut out
    const cap = 1 - sstep(0.74, 1.0, d);
    const fan = (1 - sstep(1.0, 1 + skirt, d)) * 0.14;
    if(eroded) {
      // Several narrow cliff risers and broad benches replace smooth cones.
      const terraces=.62*(1-sstep(.76,.81,d))+.18*(1-sstep(.90,.925,d))
        +.08*(1-sstep(1.015,1.04,d))+.12*(1-sstep(1.05,1+skirt,d));
      const incision=(vnoise(x*.075,z*.075,seed+9)-.5)*2.8;
      h+=top*terraces+incision*sstep(.12,.4,terraces);
    } else h += top * (cap + fan);
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
    // Excavated benches outside the tutorial's generous run-off. This lives
    // in the shared bake, so geometry, tyres and shadows see the same banks.
    const rim = r + (fbm(x * 0.011, z * 0.011, 3, 2, 0.5, 17) - 0.5) * 95
      + (vnoise(x*.09,z*.09,37)-.5)*11;
    const fracture=(ridged(x*.046,z*.046,3,2,.5,61)-.5)*8;
    h += 15 * sstep(260, 264, rim) + 19 * sstep(350, 355, rim);
    h += 25 * sstep(470, 476, rim);
    h += sstep(215,250,r)*fracture;
    h += sstep(225,255,r)*(Math.floor(vnoise(x*.065,z*.065,73)*5)/5-.5)*3.5;
    // Flat excavated benches with irregular fractured risers. Broad rounded
    // plateaus here made the quarry read as dunes even with a cliff texture.
    h += vista(x, z, r, 63, 200, 620);
    return h;
  },

  /* Rolling desert floor cut by washes, with mesas standing off it and a broken
     rim wall in the distance. The road ends up in the washes; the mesas end up
     as the walls the barriers run along. */
  canyon(x, z) {
    const r = Math.hypot(x, z);
    let h = (fbm(x * 0.00165, z * 0.00165, 4, 2.05, 0.5, 21) - 0.5) * 30;
    h += (fbm(x * 0.0072, z * 0.0072, 3, 2.1, 0.5, 29) - 0.5) * 5.5;   // dunes
    h += plateaus(x, z, 210, 33, 28, 60, 0.55, 0.55, true);
    h += plateaus(x, z, 78, 41, 6, 15, 0.30, 0.75, true);                    // hoodoo benches
    h += 34 * sstep(430, 640, r) * (0.5 + 0.9 * ridged(x * 0.0052, z * 0.0052, 3, 2.1, 0.5, 51));
    h += plateaus(x,z,430,133,65,135,.72,.60,true)*sstep(430,760,r);
    h += vista(x, z, r, 71, 115, 920);
    return h;
  },

  /* One mountainside, rising west, with the valley in the east.

     This used to be ±43 m of low-frequency fbm and nothing else — "big
     wavelengths so the track can climb one flank". The wavelengths were big
     but they were NOISE, so they knew nothing about where the road actually
     climbs, and where the road reached 58 m the ground happened to be low:
     the carve then raised terrain to meet it and TIMBERLINE CLIMB came out as
     a 63 m causeway with 290 m of unwalled shoulder. Measured over 300 road
     samples, 68 % of the lap had ground falling away on BOTH sides.

     The fix is to make the large scale deterministic and aligned with the
     stage. The track is a ring at r≈290 whose height varies with ANGLE, and
     its height correlates almost perfectly with x — valley at x≈+275 y≈2.5,
     ridge at x≈−290 y≈50 — so a single westward rise carries the whole
     profile, climb and descent both, and the road never has to be propped up:
     worst raise over the lap is now 0.1 m against 63.1 m.

     The noise that remains is deliberately small (16 m of fbm, 6 m of ridged
     against 86 and 30) because it is now DETAIL on a hillside rather than the
     landform itself. Amplitudes and the −8 m offset come from a 3600-shape
     sweep in dev/tmp; the objective was worst-raise, because that is what
     track-check gates.

     This still leaves the road cut into a hill on both sides. Which side is
     the mountain and which side is the drop is a design decision, not
     something a noise field can know — see `shelves` and shelfAt(). */
  forest(x, z) {
    const r = Math.hypot(x, z);
    let h = (fbm(x * 0.00125, z * 0.00125, 4, 2.1, 0.55, 31) - 0.5) * 16;
    h += 58 * sstep(250, -300, x);                                     // the mountainside
    h += (ridged(x * 0.0033, z * 0.0033, 3, 2.1, 0.5, 47) - 0.35) * 6;
    h += (fbm(x * 0.021, z * 0.021, 2, 2, 0.5, 3) - 0.5) * 2.0;        // ground lumps
    h += vista(x, z, r, 83, 250, 600);
    return h + 8;
  },

  /* Inside the caldera: a cinder cone in the middle, a broken rim wall right
     out at the edge of the world, crevices everywhere between. */
  /* THUNDER PARK: SUNSTRIKE CANYON's ground, every seed pushed by 40 so not one
     mesa or hoodoo repeats, and the middle of the arena squashed flat. A stunt
     park is built on a graded pad — inside r=320 the only relief that should
     read is the set pieces, and the rim wall stays out where it belongs. */
  thunder(x, z) {
    const r = Math.hypot(x, z);
    let h = (fbm(x * 0.00165, z * 0.00165, 4, 2.05, 0.5, 61) - 0.5) * 30;
    h += (fbm(x * 0.0072, z * 0.0072, 3, 2.1, 0.5, 69) - 0.5) * 5.5;
    h += plateaus(x, z, 210, 73, 22, 48, 0.55, 0.55);
    h += plateaus(x, z, 78, 81, 6, 15, 0.30, 0.75);
    h += 34 * sstep(430, 640, r) * (0.5 + 0.9 * ridged(x * 0.0052, z * 0.0052, 3, 2.1, 0.5, 91));
    h += vista(x, z, r, 111, 205, 620);
    // The pad. Scaling the whole field rather than clamping it keeps the join
    // smooth — a clamp would put a terrace ring right through the outer loop.
    return h * (1 - 0.72 * (1 - sstep(200, 320, r)));
  },

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
   BAKE
   ============================================================ */
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
function* carveInto(C, spline, F, report, prog0, prog1) {
  const { res, ext, x0, z0, nx, nz, cAcross, cTarget, cW, cS, cD } = C;
  const px = ext / res;
  const L = spline.length;
  const jumps = F.jumps, banks = F.banks, whoops = F.whoops, berms = F.berms;
  const sMapBase = F.sMapBase, sMapScale = F.sMapScale, endTaper = F.endTaper;
  const bsign = banks && banks.length ? bankSigns(spline, banks) : null;
  const _bk = { w: 0, t: 0 };
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
        /* Banking: raise the outside of the corner. kappa > 0 turns left, so
           the outside is negative-across. An AUTHORED bank replaces the
           curvature term inside its span rather than stacking on it — the
           whole point of authoring one is that the corner gets the angle the
           designer asked for, not that plus whatever the geometry produced. */
        const curveBank = clamp(-kappaA * across * BANK_GAIN, -BANK_MAX, BANK_MAX);
        if (bsign) {
          bankAt(banks, bsign, s, L, _bk);
          tgt += (curveBank * (1 - _bk.w) + across * _bk.t * _bk.w) * tk;
        } else tgt += curveBank * tk;
        /* The verge: a drop away from the road, unless a berm has been authored
           on this side — then the same span of ground goes UP instead, into a
           wall you can ride. Same profile curve either way, so the roadbed edge
           joins it without a lip. */
        const vf = sstep(SHOULDER_IN, SHOULDER_OUT, tw);
        const bh = berms ? bermAt(berms, s, across, L) : 0;
        if (bh > 0) tgt += bh * vf * tk;
        else tgt -= VERGE_DROP * tk * vf;
        if (whoops) tgt += whoopAt(whoops, s, L) * (1 - sstep(0.95, 1.25, tw));
        if (jumps) tgt += jumpProfile(jumps, s, across, ad, w, L);

        cAcross[i] = across; cTarget[i] = tgt; cW[i] = w; cD[i] = dSeg;
        cS[i] = sMapBase + s * sMapScale;
      }
    }
    if ((k & 127) === 0) { report(prog0 + (prog1 - prog0) * (k / steps), 'carving the road'); yield; }
  }
}

/* ---------------- authored cross-section features ---------------- */

/**
 * Which edge of an authored bank goes up. `deg` is a magnitude in the track
 * file — asking an author to sign it correctly for a corner they cannot see
 * from the numbers is how you get a bank that throws cars off the outside.
 * The sign comes from the MEAN curvature over the whole span so it cannot flip
 * halfway through and put a ridge down the middle of the apex; a negative
 * authored `deg` still flips it, for the one corner that wants the wrong way.
 */
function bankSigns(spline, banks) {
  const L = spline.length;
  const out = new Float32Array(banks.length);
  for (let i = 0; i < banks.length; i++) {
    const b = banks[i];
    let span = b.s1 - b.s0; if (span <= 0) span += L;
    let acc = 0;
    for (let t = 0; t <= span; t += 2) acc += spline.curvatureAt(b.s0 + t);
    // kappa > 0 turns left; the outside is then negative-across, and raising it
    // needs a negative multiplier on `across`.
    out[i] = acc >= 0 ? -1 : 1;
  }
  return out;
}

/** Authored bank at s: `w` is the blend against the curvature bank, `t` the
    signed tangent to multiply `across` by. */
function bankAt(banks, signs, s, L, out) {
  out.w = 0; out.t = 0;
  for (let i = 0; i < banks.length; i++) {
    const b = banks[i];
    let d0 = s - b.s0; if (d0 < -L * 0.5) d0 += L; else if (d0 > L * 0.5) d0 -= L;
    let span = b.s1 - b.s0; if (span <= 0) span += L;
    if (d0 < 0 || d0 > span) continue;
    const w = clamp(Math.min(d0, span - d0) / BANK_TAPER, 0, 1);
    if (w <= out.w) continue;
    out.w = w;
    out.t = Math.tan(b.deg * Math.PI / 180) * signs[i];
  }
  return out;
}

/** Rollers, in metres to ADD to the roadbed. One wavelength of fade at each end
    so the field starts and ends level with the road either side of it. */
function whoopAt(whoops, s, L) {
  let h = 0;
  for (let i = 0; i < whoops.length; i++) {
    const q = whoops[i];
    let d0 = s - q.s0; if (d0 < -L * 0.5) d0 += L; else if (d0 > L * 0.5) d0 -= L;
    let span = q.s1 - q.s0; if (span <= 0) span += L;
    if (d0 < 0 || d0 > span) continue;
    const fade = clamp(Math.min(d0, span - d0) / q.wl, 0, 1);
    h += q.amp * (1 - Math.cos((2 * Math.PI * d0) / q.wl)) * 0.5 * fade;
  }
  return h;
}

/* --- shelf spans: a road cut into a mountainside --- */
const SHELF_CUT = 0.85;     // 40 deg — the cut face standing above a shelf road
const SHELF_FALL = 0.62;    // 32 deg — the ground falling away on the open side
const SHELF_TAPER = 40;     // metres of blend in and out along the span

/* Module scratch: shelfAt runs once per macro cell in the carve corridor, so
   it must not allocate. Same reason the wheel/scatter code keeps its own. */
const _shelf = { side: 1, rise: 26, fall: 18, k: 1 };

/**
 * The shelf span covering `s`, or null.
 *
 * A shelf road has a hillside on ONE side and open air on the other. Which
 * side that is cannot be derived from a height field — it is the same sort of
 * authored decision as a bank or a berm, so it takes the same {s0, s1, side}
 * vocabulary. The theme base can supply a mountain; only the track can say
 * which way the view opens.
 *
 * `k` tapers the span in and out so a bench never begins with a step.
 */
function shelfAt(shelves, s, L) {
  for (let i = 0; i < shelves.length; i++) {
    const sh = shelves[i];
    let d0 = s - sh.s0; if (d0 < -L * 0.5) d0 += L; else if (d0 > L * 0.5) d0 -= L;
    let span = sh.s1 - sh.s0; if (span <= 0) span += L;
    if (d0 < 0 || d0 > span) continue;
    _shelf.side = sh.side;
    _shelf.rise = sh.rise != null ? sh.rise : 26;
    _shelf.fall = sh.fall != null ? sh.fall : 18;
    _shelf.k = clamp(Math.min(d0, span - d0) / SHELF_TAPER, 0, 1);
    return _shelf;
  }
  return null;
}

/** Berm height on this side of the road at s, or 0 if the verge is normal. */
function bermAt(berms, s, across, L) {
  for (let i = 0; i < berms.length; i++) {
    const b = berms[i];
    if (b.side > 0 ? across < 0 : across > 0) continue;      // other side of the road
    let d0 = s - b.s0; if (d0 < -L * 0.5) d0 += L; else if (d0 > L * 0.5) d0 -= L;
    let span = b.s1 - b.s0; if (span <= 0) span += L;
    if (d0 < 0 || d0 > span) continue;
    return b.h * clamp(Math.min(d0, span - d0) / BERM_TAPER, 0, 1);
  }
  return 0;
}

/** Kicker ramps and carved voids, in metres to ADD to the roadbed height. */
function jumpProfile(jumps, s, across, ad, w, L) {
  let h = 0;
  for (let i = 0; i < jumps.length; i++) {
    const j = jumps[i];
    let ds = s - j.s;
    if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
    /* A hip's lip is a diagonal line across the road: shifting ds by
       across·tan(yaw) rotates the entire ramp about the centreline, so one edge
       of the lip sits metres further up the face than the other and the car
       leaves it turning. */
    if (j.yaw) ds += across * Math.tan(j.yaw);
    // the ramp face, tapered across so it is a kicker and not an earthwork
    const taper = 1 - sstep(0.78, 1.12, ad / w);

    if (j.kind === 'drop') {
      /* A shelf. DROP_RUN metres of ramp up on to it (see track.js: without
         that it is a wall), `len` metres of plateau at h, then the ground stops
         in 0.4 m — the shortest step this 0.66 m/texel field can hold as an
         edge instead of smearing into a slope. Nothing is carved out beyond it;
         the road underneath simply carries on at its own height. */
      if (taper <= 0 || ds < -j.len - DROP_RUN || ds > 1) continue;
      if (ds <= -j.len) h += j.h * ((ds + j.len + DROP_RUN) / DROP_RUN) * taper;
      else if (ds <= 0) h += j.h * taper;
      else h += j.h * (1 - clamp(ds / 0.4, 0, 1)) * taper;
      continue;
    }

    const gap = j.gap || 0;
    // A table's deck: `top` metres of lip held flat, then `down` metres of exit
    // ramp. Land on it, roll off it, or clear the lot — the choice is the point.
    const top = j.kind === 'table' ? j.top : 0;
    const down = j.kind === 'table' ? j.down : 0;
    if (ds > gap + top + down + 2 || ds < -j.len - 1) continue;
    if (taper > 0) {
      // rampRise + LIP_HOLD live in track.js: one definition of the kicker
      // face, shared with the racing line's launch-speed maths.
      if (ds <= 0 && ds >= -j.len) {
        h += rampRise(clamp((ds + j.len) / (j.len - LIP_HOLD), 0, 1), j.h) * taper;
      }
      else if (ds > 0) {
        if (top > 0 || down > 0) {
          if (ds <= top) h += j.h * taper;
          else if (ds <= top + down) h += j.h * (1 - (ds - top) / down) * taper;
        } else {
          // the back of the lip: near-vertical for a gap (you are meant to fly
          // it), 1.2 m of 70-degree face otherwise so a crawling car can get down
          const back = gap > 0 ? 0.4 : 1.2;
          if (ds < back) h += j.h * (1 - ds / back) * taper;
        }
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
  for (const rt of trackData.routes) {
    const ss = rt.spline;
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
  yield* carveInto(C, spline, {
    jumps: trackData.jumps, banks: trackData.banks,
    whoops: trackData.whoops, berms: trackData.berms,
    sMapBase: 0, sMapScale: 1, endTaper: 0
  }, report, 0.38, 0.48);
  {
    /* Every route is carved with its OWN jumps — a detour whose drop exists
       only in the data is a route the AI will take and the ground will not
       honour. Banks, whoops and berms are main-line spans and stay off the
       detours: their s is the main line's, and re-indexing them into route
       arc length would put a bank where nobody asked for one. */
    const rts = trackData.routes;
    const p0 = 0.48, p1 = 0.52;
    for (let i = 0; i < rts.length; i++) {
      const rt = rts[i];
      // The detour inherits the MAIN line's s so surface spans keep running down
      // it; racecore never asks the terrain where a route racer is.
      let span = rt.s1 - rt.s0; if (span <= 0) span += L;
      const a = p0 + (p1 - p0) * (i / rts.length);
      const b = p0 + (p1 - p0) * ((i + 1) / rts.length);
      yield* carveInto(C, rt.spline, {
        jumps: rt.jumps, banks: null, whoops: null, berms: null,
        sMapBase: rt.s0, sMapScale: span / rt.spline.length, endTaper: 45
      }, report, a, b);
    }
  }

  /* resolve the carve into the height field + road mask */
  const shelves = trackData.shelves || [];
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
      if(theme==='training' && dd>0) {
        // An excavated haul road sits between spoil shoulders, not on a
        // causeway above an empty bowl. Start outside the authored verge:
        // the entire driving surface, jump lips and banking stay intact.
        const x=(gi0+i-half)*px,z=(gj0+j-half)*px;
        const broken=fbm(x*.047,z*.047,3,2,.5,97);
        const rise=across>0?1.2+broken*3.8:.35+broken*1.8;
        const fade=sstep(0,8,dd)*(1-sstep(27,CORRIDOR,dd));
        h=Math.max(h,h+(roadH+rise-h)*fade);
      }
      /* A shelf, if one is authored here: hillside on `side`, open air on the
         other. Deliberately applied AFTER the slope clamp, because the clamp
         is symmetric — that symmetry is what lets a road be authored on top
         of any noise at all — and a bench is the one place we want asymmetry.

         Both sides fade out by the corridor edge so the theme base takes over
         without a step; on forest the base is a real mountainside rising west,
         so the cut face continues into it rather than ending in a wall. */
      if (shelves.length && dd > 0) {
        const sh = shelfAt(shelves, C.cS[c], L);
        if (sh) {
          const fade = sh.k * (1 - sstep(CORRIDOR * 0.6, CORRIDOR, dd));
          if ((across < 0 ? -1 : 1) === sh.side) {
            /* max(): this CUTS a bench into whatever hill is already there.
               Ground higher than the cut face is left alone, so the mountain
               keeps climbing behind the shelf instead of being shaved flat. */
            h = Math.max(h, h + (roadH + Math.min(sh.rise, dd * SHELF_CUT) - h) * fade);
          } else {
            /* min(): nothing on the open side may stand above the road. This
               is the line that turns a trench into a view. */
            h = Math.min(h, h + (roadH - Math.min(sh.fall, dd * SHELF_FALL) - h) * fade);
          }
        }
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

  /* --- 3e. surface map + bump map + lateral map --- */
  const surf = new Uint8Array(SURF_RES * SURF_RES);
  const bumpF = new Float32Array(SURF_RES * SURF_RES);
  /* Signed distance ACROSS the road, in half-widths, encoded 0..255 around a
     neutral 128. The carve already knows this number per texel; the shader has
     no way to recompute it (the height field is single-valued and carries no
     lateral channel), so without this there is no way to paint a lane, a
     shoulder or a verge dust line. ±1 is the edge of the roadbed and the scale
     saturates at ±1.4, which is just past the verge — beyond that the value is
     only ever used to say "outside".

     Texels with no road at all hold the neutral 128 as well, so this must only
     be sampled where the road mask is non-zero. */
  const lat8 = new Uint8Array(SURF_RES * SURF_RES);
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
      lat8[o] = s >= 0
        ? Math.round(clamp(lat / Math.max(1e-3, spline.widthAt(s)), -1.4, 1.4) * 90 + 128)
        : 128;
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
    roadMask, surf, bump, lat: lat8,
    theme, trackDef, trackData
  };
}

function onJumpFace(jumps, s, ad, L) {
  for (let i = 0; i < jumps.length; i++) {
    const j = jumps[i];
    let ds = s - j.s;
    if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
    // The packed-rock apron covers whatever the carve actually built: a drop's
    // run-up and plateau ahead of the lip, a table's deck behind it.
    const before = j.kind === 'drop' ? j.len + DROP_RUN : j.len;
    const after = (j.gap || 0) + (j.kind === 'table' ? j.top + j.down : 0);
    if (ds < -before - 2 || ds > after + 2) continue;
    if (ad < j.w * 1.6) return true;
  }
  return false;
}

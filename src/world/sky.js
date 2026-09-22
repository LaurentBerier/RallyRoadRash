/* ============================================================
   DAY SKIES
   ------------------------------------------------------------
   Five static skies, one per track theme. Nothing here moves fast:
   the sun never moves at all (terrain bakes its occlusion mask once,
   so a moving sun would desynchronise the shadows from the ground),
   the clouds drift at a couple of degrees a minute, and the only
   thing with any real motion is the ash column over the caldera.

   Wave 8 swapped the hand-tuned zenith ramp for the real thing:
   the vendored Preetham dome (three/addons/objects/Sky.js) paints the
   sky, and a TRANSPARENT overlay dome on top of it carries the three
   jobs a scattering integral cannot do — the panorama band, the
   caldera's ash and embers, and the ground haze below the horizon.
   Everything else (sun billboard, clouds, vista ring, plume) is
   untouched.

   The reason to bother: with the ramp, `hazeColor` was a hand-picked
   hex and the dome, the FogExp2 colour and the terrain's haze uniform
   were three authored numbers that drifted apart every time one of
   them was retuned. They are now all read off ONE model, so they
   cannot disagree — see deriveSkyColors() and §8.5.
   ============================================================ */
import * as THREE from 'three';
import { Sky as PhysicalSky } from 'three/addons/objects/Sky.js';
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

   `grade` is the per-stage colour grade, read by engine.setLightTheme and
   applied in the final pass just before tone mapping. It is NOT exposure:
   feel.js owns uExposure, holds it at exactly 1.0 and dips it on landings,
   and dev/camera-check gates that it comes back. This is the stage's own
   key, and it is what stops five different times of day all resolving to the
   same washed-out mid-grey after ACES. Every channel is a pull except
   THUNDER's red, which is a deliberate 2 % push on a stage that is a sunset
   and nothing else — tone mapping otherwise has all the highlight it can use.

   `shaft` / `sat` / `con` ride along the same road: engine.setLightTheme
   reads them into uShaft / uSat / uCon. ACES pulls saturation out of
   everything bright, so an arcade stage has to ask for it back, and god rays
   are a function of how low the sun is — noon over an airfield gets almost
   none, a caldera dusk gets a lot.

   `vista` / `vistaColor` / `vistaFade` describe the silhouette ring at 5–7.5
   km. It is the FALLBACK: when assets carry a `sky/<theme>` panorama the
   dome shows that instead and the ring hides itself.

   ATMOSPHERE (§8.5). `turbidity` / `rayleigh` / `mie` / `mieG` are the
   Preetham parameters the physical dome is built from — turbidity is how much
   is in the air, rayleigh how blue the clear part of it is, mie/mieG how big
   and how forward-scattering the particles are (a bigger mie is a wider,
   hotter aureole around the sun).

   `skyExposure` is NOT art. The Preetham shader's output is HDR in units
   nobody chose, so every theme carries the one multiplier that puts its
   horizon back where the retired ramp had it — measured, to four places, and
   re-measured by dev/sky-check.mjs against a ±15 % band. If you retune
   turbidity/rayleigh/mie you MUST re-derive skyExposure, and sky-check will
   tell you so.

   `zenith` / `horizon` / `hazeColor` are the RETIRED ramp's endpoints. They
   paint nothing any more: hazeColor and horizonColor are derived from the
   model now. They stay because they are the reference skyExposure is
   calibrated against — delete them and the calibration has nothing to be
   calibrated to. `groundHaze` is still live (the overlay and the env's ground
   bounce both read it); so is everything else in here.
   ============================================================ */
export const SKY_THEMES = {
  /* Warm afternoon in the quarry: the lower key reveals the excavated banks. */
  training: {
    sunEl: 38, sunAz: -35,
    sunDir: { x: 0.645496, y: 0.615661, z: -0.451975 },
    sunColor: 0xffdeb6, sunIntensity: 2.70,
    hemiSky: 0x9dbce7, hemiGround: 0x66533e, hemiIntensity: 0.42,
    zenith: 0x2b68c2, horizon: 0xcadef2, hazeColor: 0xc2d5e8,
    turbidity: 2.2, rayleigh: 1.6, mie: 0.005, mieG: 0.80, skyExposure: 0.3300,
    groundHaze: 0x9aa89a,
    cloudAmount: 0.55, cloudTint: 0xffffff, cloudShade: 0x93a8c2,
    cloudY: 1250, cirrus: 0.35,
    sunDiscColor: 0xfff8ee, sunAngDeg: 1.1, haloStrength: 0.55, sunGlow: 1.0,
    fogHint: 0.00050,
    grade: [0.88, 0.90, 0.93],
    shaft: 0.06, sat: 1.04, con: 1.08,
    vista: 'hills', vistaColor: 0x6c7a8c, vistaFade: 0.40
  },

  /* late afternoon in the red rock — long shadows, warm dust in the air */
  canyon: {
    sunEl: 28, sunAz: -35,
    sunDir: { x: 0.723270, y: 0.469472, z: -0.506444 },
    sunColor: 0xffd2a0, sunIntensity: 2.95,
    hemiSky: 0x9dbde8, hemiGround: 0x8c6444, hemiIntensity: 0.55,
    zenith: 0x2f63ae, horizon: 0xf0c491, hazeColor: 0xe0b58a,
    turbidity: 7.0, rayleigh: 2.2, mie: 0.005, mieG: 0.80, skyExposure: 0.3048,
    groundHaze: 0xb08256,
    cloudAmount: 0.62, cloudTint: 0xf1e7d9, cloudShade: 0x727d8b,
    cloudY: 1500, cirrus: 0.55,
    sunDiscColor: 0xfff0d2, sunAngDeg: 1.6, haloStrength: 0.95, sunGlow: 1.25,
    fogHint: 0.00068,
    grade: [0.98, 0.90, 0.82],
    shaft: 0.20, sat: 1.04, con: 1.07,
    vista: 'mesas', vistaColor: 0x8a4832, vistaFade: 0.30
  },

  /* mountain morning: the sun still low behind the ridge, mist in the valleys */
  forest: {
    sunEl: 22, sunAz: 118,
    sunDir: { x: -0.435229, y: 0.374607, z: 0.818656 },
    sunColor: 0xffe0b4, sunIntensity: 2.25,
    /* hemiIntensity was 0.75, the highest of the five and 0.10 clear of the
       0.55–0.65 every other stage sits in — on the stage that ALSO carries the
       highest turbidity and the highest skyExposure. The dome knee handles the
       sky; this is the other half of the same over-exposure, and it is the
       half that lands on the cars and the trees. ADVISORY: derived from the
       table, not from a screenshot. Revert to 0.75 if Timberline goes flat. */
    hemiSky: 0xb6d2e6, hemiGround: 0x4c5638, hemiIntensity: 0.62,
    zenith: 0x3d80bc, horizon: 0xe2ece6, hazeColor: 0xcedcd4,
    /* Thick and grey, and the mie kept deliberately small: at turbidity 10 a
       0.012 mie put 8 % of the whole dome over the 1.30 bloom threshold and
       veiled the frame every time the camera came round to the sun. */
    turbidity: 10.0, rayleigh: 2.0, mie: 0.004, mieG: 0.70, skyExposure: 0.4480,
    groundHaze: 0x9aab9c,
    cloudAmount: 1.00, cloudTint: 0xf6f0e6, cloudShade: 0x8e9aa6,
    cloudY: 900, cirrus: 0.30,
    sunDiscColor: 0xfff2d8, sunAngDeg: 1.4, haloStrength: 1.10, sunGlow: 1.15,
    fogHint: 0.00105,
    grade: [0.82, 0.86, 0.84],
    shaft: 0.28, sat: 1.04, con: 1.06,
    vista: 'peaks', vistaColor: 0x4a5c70, vistaFade: 0.58
  },

  /* caldera dusk: the sun is a coin behind the ash, the horizon glows on its own */
  volcano: {
    sunEl: 11, sunAz: -152,
    sunDir: { x: -0.866729, y: 0.190809, z: -0.460847 },
    sunColor: 0xff8c4e, sunIntensity: 1.55,
    hemiSky: 0x8793af, hemiGround: 0x48372c, hemiIntensity: 0.85,
    zenith: 0x241c2c, horizon: 0x8e3a18, hazeColor: 0x6e2c1c,
    turbidity: 20.0, rayleigh: 3.0, mie: 0.020, mieG: 0.85, skyExposure: 0.0775,
    groundHaze: 0x40201a,
    cloudAmount: 0.50, cloudTint: 0x6a4a44, cloudShade: 0x241614,
    cloudY: 1100, cirrus: 0.25,
    sunDiscColor: 0xff9a52, sunAngDeg: 3.4, haloStrength: 1.35, sunGlow: 0.85,
    fogHint: 0.00130,
    grade: [1.00, 0.90, 0.86],
    shaft: 0.24, sat: 1.06, con: 1.04,
    vista: 'rim', vistaColor: 0x3a1e1c, vistaFade: 0.44,
    // ash + the thing making it: a plume off the caldera, downwind of the track
    ash: 0.85, ashColor: 0x3a2a2a, emberColor: 0xff4a12, emberGlow: 0.9,
    plume: { dir: { x: -0.62, z: 0.78 }, dist: 3400, baseY: 120, height: 2600, count: 1.0 }
  },

  /* THUNDER MESA: the canyon family an hour later. Same red rock, same warm
     air, but the sun is nine degrees off the deck and every vertical surface
     on the stage is either rim-lit or in silhouette. High cirrus catches the
     last of it, which is what the 0.70 buys. */
  thunder: {
    sunEl: 9, sunAz: -118,
    sunDir: { x: -0.463692, y: 0.156434, z: -0.872076 },
    sunColor: 0xffb070, sunIntensity: 2.60,
    hemiSky: 0x7c6ea4, hemiGround: 0x6e4630, hemiIntensity: 0.62,
    zenith: 0x1f2a68, horizon: 0xff9a3c, hazeColor: 0xdd8846,
    /* mie 0.012 rather than the 0.02 a nine-degree sun wants: at 0.02 the
       aureole peaked at 6x the bloom threshold, seven times the old dome's
       brightest pixel. 0.012 halves that and still glows. Raise it once
       somebody has looked at it. */
    turbidity: 8.0, rayleigh: 2.6, mie: 0.012, mieG: 0.80, skyExposure: 0.3704,
    groundHaze: 0x8a5030,
    cloudAmount: 0.78, cloudTint: 0xeed4b5, cloudShade: 0x636471,
    cloudY: 1350, cirrus: 0.70,
    sunDiscColor: 0xffc078, sunAngDeg: 2.4, haloStrength: 1.25, sunGlow: 1.35,
    fogHint: 0.00058,
    grade: [1.02, 0.90, 0.80],
    shaft: 0.30, sat: 1.08, con: 1.08,
    vista: 'buttes', vistaColor: 0x5a2c30, vistaFade: 0.34
  }
};

/* Cloud counts and dome tessellation by tier. `stars` is gone from the sky but
   still sits in QUALITY — engine.js is not ours to prune. */
const SKY_BUDGET = {
  LOW:    { domeW: 24, domeH: 14, clusters: 10, puffs: 4, plume: 10, ashOct: 2, vista: 16 },
  MEDIUM: { domeW: 32, domeH: 20, clusters: 16, puffs: 5, plume: 16, ashOct: 3, vista: 22 },
  HIGH:   { domeW: 48, domeH: 28, clusters: 22, puffs: 6, plume: 22, ashOct: 3, vista: 28 },
  ULTRA:  { domeW: 64, domeH: 36, clusters: 26, puffs: 7, plume: 28, ashOct: 4, vista: 32 }
};

const DOME_R = 9000;
const SUN_D = 7600;
const CLOUD_R0 = 2400;      // clouds live between these radii, on a flat deck
const CLOUD_R1 = 7400;
/* The vista ring sits outside the clipmap (which reaches ~2.9 km at HIGH)
   and inside the camera's 26 km far plane. Two thousand five hundred metres
   of depth across the ring is what gives it parallax against itself. */
const VISTA_R0 = 5000, VISTA_R1 = 7500;
const VISTA_COLS = 9;       // columns per silhouette; the profile is sampled here
/* Where the panorama band sits on the dome, in d.y. Just under the horizon so
   there is no gap, up to about 9 degrees — a skyline, not a ceiling. */
const SKYLINE_BAND = [-0.035, 0.155];

/* shared scratch — nothing in update() allocates */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/* ---------------- vista silhouette profiles ----------------
   h(u) for u across one silhouette, 0..1, zero at both ends so neighbours
   overlap into a continuous range. p0..p2 are that silhouette's three
   deterministic randoms — the shape is a pure function of them, which is
   what lets the ring survive a quality change unchanged. */
function vistaHeight(kind, rng) {
  const R = { mesas: [300, 520], peaks: [480, 900], rim: [230, 400], hills: [170, 320], buttes: [300, 580] };
  const a = R[kind] || R.hills;
  return a[0] + rng() * (a[1] - a[0]);
}

function vistaProfile(kind, u, p0, p1, p2) {
  const s = Math.sin(Math.PI * u);
  if (kind === 'mesas') {
    /* A mesa is defined by what it is NOT doing: the top is dead flat and
       the sides are near-vertical, because the cap rock is the only thing
       holding the whole thing up. A bench on one flank sells the layering. */
    const e = 0.10 + p0 * 0.07;
    const top = sstepf(0, e, u) * (1 - sstepf(1 - e, 1, u));
    const bench = sstepf(0, e * 0.6, u) * (1 - sstepf(0.34 + p1 * 0.3, 0.46 + p1 * 0.3, u));
    return Math.min(1, top * (0.90 + 0.10 * p2) + bench * 0.22);
  }
  if (kind === 'peaks') {
    const a = 0.30 + p0 * 0.38;
    const v = u < a ? u / a : (1 - u) / (1 - a);
    const main = Math.pow(Math.max(0, v), 0.52);
    // a subordinate summit, so the range has a rhythm instead of a beat
    const b = a > 0.5 ? a - 0.30 - p1 * 0.14 : a + 0.30 + p1 * 0.14;
    const w = u < b ? u / Math.max(b, 1e-3) : (1 - u) / Math.max(1 - b, 1e-3);
    return Math.min(1, Math.max(main, Math.pow(Math.max(0, w), 0.6) * (0.52 + 0.18 * p2)));
  }
  if (kind === 'rim') {
    // one long crater wall with a breach blown out of it
    const notch = Math.exp(-Math.pow((u - (0.25 + p0 * 0.5)) / (0.07 + p1 * 0.06), 2));
    return Math.max(0, Math.pow(s, 0.30) * (0.82 + 0.18 * p2) * (1 - notch * 0.72));
  }
  if (kind === 'buttes') {
    // a narrow tower standing on its own talus fan
    const c = 0.34 + p0 * 0.32, w = 0.10 + p1 * 0.08;
    const tower = 1 - sstepf(w, w + 0.05, Math.abs(u - c));
    const talus = Math.pow(s, 1.9) * (0.28 + 0.14 * p2);
    return Math.min(1, Math.max(talus, tower * (0.86 + 0.14 * p2) * Math.pow(s, 0.18)));
  }
  // hills: two soft lobes, nothing sharp anywhere
  return Math.pow(s, 0.62) * (0.74 + 0.26 * Math.sin(u * 6.2832 * (1 + p0 * 1.6) + p1 * 6.2832)) *
    (0.82 + 0.18 * p2);
}

/** Local smoothstep — rng.js has one, but this file only needs the scalar. */
function sstepf(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/* value noise for the ash, three lines of GLSL and no texture fetch */
const GLSL_NOISE = /* glsl */`
  float h31(vec3 p){ p = fract(p*0.3183099 + vec3(0.71,0.113,0.419)); p += dot(p, p.yzx+19.19); return fract((p.x+p.y)*p.z); }
  float n31(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z); }
`;

/* ============================================================
   THE SAME MODEL, IN JAVASCRIPT
   ------------------------------------------------------------
   A line-for-line port of vendor/three/examples/jsm/objects/Sky.js, so the
   haze colour, the fog colour and the terrain's haze uniform can be READ OFF
   the dome instead of guessed at. Every constant below is copied from that
   file; if it is ever revendored, diff these against it.

   Two deliberate departures from the vendored shader, both applied to the
   GLSL as well so the two stay in step:

     • no solar disc. `sunAngularDiameterCos` gives a 0.53° dot at 19000x the
       sky, which lands INSIDE our own sun billboard (1.1–3.4° per theme) and
       is seven times brighter than it. Two suns is one too many, and the
       billboard is the one with a per-theme colour and size.

     • an output multiplier, `skyExposure`. The shader's units are its own;
       this is what puts them back in ours.

   `sunPosition` is fed the UNIT sun direction, exactly as three's own example
   does, which pins vSunfade at 1 and the output gamma at 1/2.4.
   ============================================================ */
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734, STEEPNESS = 1.5, EE = 1000.0;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3, MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075, ONE_OVER_FOURPI = 0.07957747154594767;
const SKY_AMBIENT = [0.0, 0.0003, 0.00075];

/* ------------------------------------------------------------
   THE HIGHLIGHT KNEE
   ------------------------------------------------------------
   The over-exposure report. Preetham's output is unbounded, and `skyExposure`
   is calibrated against ONE number — the horizon band at h = 0.02, averaged
   over 64 azimuths. Nothing in that calibration looks at the zenith, at the
   aureole, or at how much of the dome clears the bloom threshold, and on the
   thick stages a lot of it does: measured over a 64 x 16 hemisphere scan,
   forest put 5.8 % of the dome and thunder 3.1 % over the 1.30 threshold of
   UnrealBloomPass, peaking at 1.93 and 3.98. Bloom then smears that across the
   frame, which is what "the light and sky are over-exposed" looks like.

   Re-deriving skyExposure cannot fix it. Exposure scales the WHOLE dome, so
   pulling the peak down drags the horizon down with it, and the horizon is the
   one thing that is calibrated — dev/sky-check §3 allows it +-15 % and the
   measured peak/legacy ratios run from 1.14 (training) to 4.13 (thunder).
   Spending forest's entire 15 % takes its over-threshold fraction from 5.8 %
   to 2.7 %, and it is out of budget after that.

   So: a soft knee at the exposure point instead. Below T everything is
   untouched — which is every theme's horizon, every theme's zenith, and the
   overwhelming majority of every dome — and above it the curve rolls over to a
   hard asymptote at T + K. With T = 1.0 and K = 0.25 that asymptote is 1.25,
   strictly under the 1.30 bloom threshold, so no part of the sky can bloom at
   all and the bloom budget goes back to what it is for: the sun billboard,
   the embers, and specular on the cars.

   It is a curve and not a clamp on purpose. A clamp at 1.25 flattens the
   aureole into a disc with a visible edge; the exponential keeps a gradient
   all the way out, so the sun still reads as brighter than the sky around it.

   Applied in BOTH models — here and, identically, in the patched GLSL (see
   patchSkyMaterial) — because the JS port is what the fog colour, the terrain
   haze uniform and dev/sky-check are read off. Two curves that disagree is
   exactly the drift §8.5 exists to close. */
export const SKY_KNEE_THRESH = 1.0;
export const SKY_KNEE_K = 0.25;

/** The knee, scalar. Identical by construction to skyKnee() in the GLSL. */
export function skyKnee(v, t, k) {
  return v <= t ? v : t + k * (1 - Math.exp(-(v - t) / k));
}

/** Elevation the haze/horizon colours are sampled at: a hair above the line,
    where the air is thickest but the model is not yet clamped. */
export const HAZE_H = 0.02;
/** Azimuths in the horizon-band mean. The fog is one colour for every
    heading, so the number it gets is the average of every heading. */
const AZ_SAMPLES = 64;

/**
 * Resolve a theme into the numbers both the shader and the port work from.
 * @param {string|object} theme  a SKY_THEMES key, or a theme object
 */
export function skyParams(theme) {
  const t = typeof theme === 'string' ? (SKY_THEMES[theme] || SKY_THEMES.training) : theme;
  const d = t.sunDir, n = Math.hypot(d.x, d.y, d.z) || 1;
  const sun = [d.x / n, d.y / n, d.z / n];
  const rayleigh = t.rayleigh === undefined ? 1 : t.rayleigh;
  const mie = t.mie === undefined ? 0.005 : t.mie;
  const turbidity = t.turbidity === undefined ? 2 : t.turbidity;
  // sunPosition is a unit vector, so exp(y/450000) > 1 and the clamp pins
  // vSunfade at exactly 1 — which is also why rayleighCoefficient == rayleigh.
  const sunfade = 1 - clamp(1 - Math.exp(sun[1] / 450000), 0, 1);
  const zc = clamp(sun[1], -1, 1);
  const sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(zc)) / STEEPNESS)));
  const c = 0.2 * turbidity * 1e-17;              // totalMie's `( 0.2 * T ) * 10E-18`
  return {
    turbidity, rayleigh, mie, mieG: t.mieG === undefined ? 0.8 : t.mieG,
    exposure: t.skyExposure === undefined ? 1 : t.skyExposure,
    sun, sunE, sunfade,
    betaR: TOTAL_RAYLEIGH.map(v => v * (rayleigh - (1 - sunfade))),
    betaM: MIE_CONST.map(v => 0.434 * c * v * mie)
  };
}

/**
 * Linear radiance the dome shows looking down `d`, with skyExposure applied.
 * @param p    from skyParams()
 * @param out  length-3 array, written in place and returned
 */
export function skyRadiance(p, dx, dy, dz, out) {
  const n = Math.hypot(dx, dy, dz) || 1;
  dx /= n; dy /= n; dz /= n;
  // the shader's 90° cutoff: below the horizon it keeps showing the horizon
  const za = Math.acos(Math.max(0, dy));
  const inv = 1 / (Math.cos(za) + 0.15 * Math.pow(93.885 - (za * 180) / Math.PI, -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inv, sM = MIE_ZENITH_LENGTH * inv;
  const cosTheta = dx * p.sun[0] + dy * p.sun[1] + dz * p.sun[2];
  const rPhase = THREE_OVER_SIXTEENPI * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g2 = p.mieG * p.mieG;
  const mPhase = ONE_OVER_FOURPI * ((1 - g2) / Math.pow(1 - 2 * p.mieG * cosTheta + g2, 1.5));
  // the shader's `mix(vec3(1), pow(..., 1/2), clamp(pow(1 - sun.y, 5), 0, 1))`
  const zf = clamp(Math.pow(1 - p.sun[1], 5), 0, 1);
  const gamma = 1 / (1.2 + 1.2 * p.sunfade);
  for (let i = 0; i < 3; i++) {
    const bR = p.betaR[i], bM = p.betaM[i];
    const Fex = Math.exp(-(bR * sR + bM * sM));
    const frac = (bR * rPhase + bM * mPhase) / (bR + bM);
    const lin = Math.pow(p.sunE * frac * (1 - Fex), 1.5)
      * (1 + zf * (Math.sqrt(p.sunE * frac * Fex) - 1));
    // Per channel, at the exposure point, exactly where the GLSL does it — a
    // luminance-preserving knee would shift hue on the one part of the dome
    // that is meant to be white-hot, and the shader has no cheap way to match
    // it. See SKY_KNEE_THRESH.
    out[i] = skyKnee(Math.pow((lin + 0.1 * Fex) * 0.04 + SKY_AMBIENT[i], gamma) * p.exposure,
      SKY_KNEE_THRESH, SKY_KNEE_K);
  }
  return out;
}

/**
 * Azimuthal mean of the dome at elevation `h`. This is the horizon "colour"
 * for anything that only gets one — the fog, the vista ring's base, the
 * skyline band's wash — and the luminance dev/sky-check calibrates against.
 */
export function skyBandColor(p, h, out) {
  const ch = Math.sqrt(Math.max(0, 1 - h * h));
  const s = [0, 0, 0];
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < AZ_SAMPLES; i++) {
    const a = (i / AZ_SAMPLES) * Math.PI * 2;
    skyRadiance(p, Math.cos(a) * ch, h, Math.sin(a) * ch, s);
    out[0] += s[0]; out[1] += s[1]; out[2] += s[2];
  }
  out[0] /= AZ_SAMPLES; out[1] /= AZ_SAMPLES; out[2] /= AZ_SAMPLES;
  return out;
}

/**
 * §8.5's derivation. `haze` and `horizon` are the SAME number on purpose:
 * the whole point of deriving them is that the FogExp2 colour, the terrain's
 * haze uniform and the dome cannot disagree, and two values with two names is
 * how they used to.
 */
export function deriveSkyColors(theme) {
  const p = skyParams(theme);
  const band = skyBandColor(p, HAZE_H, [0, 0, 0]);
  return { params: p, haze: band, horizon: band.slice(), zenith: skyRadiance(p, 0, 1, 0, [0, 0, 0]) };
}

/** Rec.709 luminance of a length-3 linear triple. */
export function lum3(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

/* ---------------- the two patches to the vendored shader ----------------
   Applied to the material's own strings, never to vendor/. Both are asserted
   by a substring check, because a silent no-op here would show up as a sky
   that is simply the wrong brightness — and that reads as a tuning mistake,
   not as a failed patch. */
const SKY_DISC_SRC = 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk;';
const SKY_OUT_SRC = 'gl_FragColor = vec4( retColor, 1.0 );';

/* The knee, in GLSL. Branchless and identical to skyKnee() above: below t the
   exp() term is exactly zero, so the bracket evaluates to t and min() hands
   back the untouched channel; above it, the bracket is always the smaller of
   the two. Written per channel on a vec3 so the hue of a blown-out aureole is
   whatever the model said it was, only dimmer. */
const SKY_KNEE_GLSL = /* glsl */`
uniform float uSkyExposure;
uniform float uSkyKneeThresh;
uniform float uSkyKneeK;
vec3 skyKnee(vec3 c, float t, float k){
  return min(c, t + k * (1.0 - exp(-max(c - t, 0.0) / k)));
}
`;

/**
 * Turn a vendored Sky into ours: the solar disc removed, an exposure
 * multiplier added, that exposure passed through the highlight knee, and — for
 * the IBL copy only — a ground bounce under the horizon, because the model
 * just keeps showing sky down there and the underside of a car is not lit by
 * sky.
 *
 * The ground bounce goes AFTER the knee, which is the right order: uEnvGround
 * is groundHaze x 0.55 and can only ever pull a channel down, so nothing the
 * knee bounded can climb back over it.
 *
 * `retColor * uSkyExposure` is kept as a literal substring in both branches —
 * dev/sky-check.mjs asserts on exactly that text to prove the patch landed.
 */
function patchSkyMaterial(mat, withGround) {
  let fs = mat.fragmentShader;
  if (fs.indexOf(SKY_DISC_SRC) < 0 || fs.indexOf(SKY_OUT_SRC) < 0) {
    console.warn('[RALLY ROAD RASH] vendored Sky.js shader changed shape — sky patch skipped');
    return;
  }
  fs = fs.replace(SKY_DISC_SRC, '// solar disc removed: sky.js draws its own, per theme');
  fs = fs.replace(SKY_OUT_SRC, withGround
    ? `vec3 envCol = skyKnee( retColor * uSkyExposure, uSkyKneeThresh, uSkyKneeK );
       // dim, warm, and the reason the underside of a car is not black
       envCol = mix(envCol, uEnvGround, smoothstep(0.0, -0.45, normalize(vWorldPosition - cameraPosition).y));
       gl_FragColor = vec4( envCol, 1.0 );`
    : 'gl_FragColor = vec4( skyKnee( retColor * uSkyExposure, uSkyKneeThresh, uSkyKneeK ), 1.0 );');
  mat.fragmentShader = SKY_KNEE_GLSL
    + (withGround ? 'uniform vec3 uEnvGround;\n' : '') + fs;
  mat.needsUpdate = true;
}

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
    this.sunIntensity = t.sunIntensity;

    /* §8.5: read off the model, not authored. Same names, same three
       consumers (FogExp2, main.js syncSun's terrain haze, the overlay), one
       source. Done before anything is built, because the fog and the overlay
       both want the answer. */
    const derived = deriveSkyColors(t);
    this.skyModel = derived.params;
    this.hazeColor = new THREE.Color().fromArray(derived.haze);
    this.horizonColor = new THREE.Color().fromArray(derived.horizon);
    this.zenithColor = new THREE.Color().fromArray(derived.zenith);

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    scene.add(this.group);

    // the dome paints every pixel the world does not cover
    scene.background = null;
    this.fog = new THREE.FogExp2(0x000000, t.fogHint);
    this.fog.color.copy(this.hazeColor);
    this._prevFog = scene.fog || null;
    scene.fog = this.fog;

    this._time = 0;
    this._envDirty = true;
    this.envRT = null;
    this._envImage = null;         // §8.5: a set equirect wins over the shader env
    this._skyline = null;          // optional panorama; the ring is the fallback

    this._buildSkyDome();
    this._buildDome();
    this._buildSun();
    this._buildVista();
    this._buildClouds();
    if (t.plume) this._buildPlume();
    this._buildEnv();
  }

  /**
   * Hand the dome a skyline panorama, or null to go back to the procedural
   * ring. `assets.get('sky/<theme>')` is the source and null is the normal
   * case — see core/assets.js.
   *
   * The image is wrapped around the full 360 degrees whatever its aspect
   * ratio, which would put a hard vertical seam behind the player at u = 0.
   * A MIRRORED copy is cross-faded in over the last few per cent either side
   * of the seam: at u = 0 the mirror reads the image's right edge, which is
   * exactly what continues from u = 1.
   *
   * Alpha is used when the image has it (a PNG silhouette) and ignored when
   * it does not (a JPEG horizon, which brings its own sky and is a perfectly
   * good answer for the lowest nine degrees). Either way the band dissolves
   * into the dome across its top third, so there is never a cut line.
   * SKYLINE_BAND is where it sits and how tall it is; that number and the
   * dissolve want one look at the real images to settle.
   */
  setSkyline(tex) {
    this._skyline = tex || null;
    this._applySkyline();
  }

  _applySkyline() {
    const m = this.domeMat;
    if (!m) return;
    const on = !!this._skyline;
    m.uniforms.uSkyline.value = this._skyline;
    if (!!m.defines.SKYLINE !== on) {
      if (on) m.defines.SKYLINE = 1; else delete m.defines.SKYLINE;
      m.needsUpdate = true;
    }
    // The ring and the panorama are the same job; two of them is one too many.
    if (this.vista) this.vista.visible = !on;
    this._envDirty = true;
  }

  /* ---------------- the physical dome ----------------
     The vendored Preetham model, and the only thing painting plain sky. The
     box is 1x1x1 scaled out to DOME_R; the shader forces gl_Position.z to the
     far plane anyway and this thing neither tests nor writes depth, so its
     actual size is only about staying inside the frustum.

     The uniforms object is SHARED with the IBL copy in _buildEnv, which is
     what makes the reflections and the sky the same sky by construction
     rather than by two matching edits. */
  _buildSkyDome() {
    const t = this.theme;
    const mesh = new PhysicalSky();
    const u = mesh.material.uniforms;
    u.turbidity.value = this.skyModel.turbidity;
    u.rayleigh.value = this.skyModel.rayleigh;
    u.mieCoefficient.value = this.skyModel.mie;
    u.mieDirectionalG.value = this.skyModel.mieG;
    u.sunPosition.value.copy(this.sunDir);        // unit, exactly as the port assumes
    u.uSkyExposure = { value: this.skyModel.exposure };
    /* Set here rather than in the patch, and BEFORE this.skyUniforms = u, so
       the IBL dome — which shares this exact object by reference, see
       _buildEnv — inherits the knee without a second edit. The reflection in a
       wing mirror and the sky above it are the same sky, bounded the same way,
       by construction. */
    u.uSkyKneeThresh = { value: SKY_KNEE_THRESH };
    u.uSkyKneeK = { value: SKY_KNEE_K };
    u.uEnvGround = { value: new THREE.Color(t.groundHaze).multiplyScalar(0.55) };
    mesh.material.depthWrite = false;
    mesh.material.depthTest = false;
    patchSkyMaterial(mesh.material, false);
    mesh.scale.setScalar(DOME_R);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    this.skyUniforms = u;
    this.skyMesh = mesh;
    this.group.add(mesh);
  }

  /* ---------------- the overlay dome ----------------
     Everything the scattering integral cannot do, and nothing else: the
     SKYLINE panorama band, the caldera's ash and ember blocks, and the ground
     haze below the horizon. Fully transparent everywhere those three say
     nothing, so the physical dome shows through untouched.

     premultipliedAlpha, because the ember block is ADDITIVE and the other two
     are coverage. Premultiplied source-over is the one blend that does both:
     a covering layer writes (colour * alpha, alpha), an additive one writes
     (colour, 0).

     And depthTest goes back ON, which the old opaque dome did not need. That
     dome was drawn in the OPAQUE pass before anything else and the world was
     painted over the top of it; a transparent one is drawn AFTER every opaque
     object, so with the test off the ash band and the ground haze would paint
     straight over the terrain and the cars. It still writes no depth — it is a
     shell at 9 km, and everything it has to lose to is nearer than that. */
  _buildDome() {
    const t = this.theme;
    const b = this.budget;
    const ash = !!t.ash;
    const geo = new THREE.SphereGeometry(DOME_R, b.domeW, b.domeH);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, fog: false,
      transparent: true, premultipliedAlpha: true,
      depthWrite: false, depthTest: true,
      defines: ash ? { ASH: 1, ASH_OCT: b.ashOct } : {},
      uniforms: {
        uHaze: { value: this.hazeColor },
        uGround: { value: new THREE.Color(t.groundHaze) },
        uTime: { value: 0 },
        uAsh: { value: t.ash || 0 },
        uAshCol: { value: new THREE.Color(t.ashColor || 0x333333) },
        uEmberCol: { value: new THREE.Color(t.emberColor || 0xff4400) },
        uEmber: { value: t.emberGlow || 0 },
        uPlumeDir: { value: new THREE.Vector2(t.plume ? t.plume.dir.x : 1, t.plume ? t.plume.dir.z : 0).normalize() },
        uSkyline: { value: this._skyline || null },
        uSkyBand: { value: new THREE.Vector2(SKYLINE_BAND[0], SKYLINE_BAND[1]) }
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
        uniform vec3 uHaze, uGround, uAshCol, uEmberCol;
        uniform float uTime, uAsh, uEmber;
        uniform vec2 uPlumeDir, uSkyBand;
        #ifdef SKYLINE
        uniform sampler2D uSkyline;
        #endif
        ${GLSL_NOISE}
        void main(){
          vec3 d = normalize(vD);
          float h = d.y;

          /* premultiplied: col carries colour*coverage, a carries coverage.
             Nothing here paints plain sky — that is the physical dome behind. */
          vec3 col = vec3(0.0);
          float a = 0.0;

        #ifdef ASH
          // slow shear: two layers sliding over each other at different speeds
          vec3 p = d * 2.4;
          float n = 0.0, amp = 0.58, f = 1.0;
          for (int i = 0; i < ASH_OCT; i++){
            n += n31(p * f + vec3(uTime * 0.0032 * f, uTime * 0.0011, 0.0)) * amp;
            f *= 2.17; amp *= 0.52;
          }
          float band = exp(-max(h, 0.0) * 1.9);
          float ka = clamp((n - 0.40) * 1.9, 0.0, 1.0) * band * uAsh;
          col = col * (1.0 - ka) + uAshCol * ka;
          a = a * (1.0 - ka) + ka;
        #endif

          // below the horizon the dome only shows past the edge of the world,
          // and the model has no answer down there — it just keeps showing sky
          float kg = smoothstep(-0.02, -0.32, h);
          col = col * (1.0 - kg) + uGround * kg;
          a = a * (1.0 - kg) + kg;

        #ifdef SKYLINE
          {
            float u = atan(d.z, d.x) * 0.15915494 + 0.5;
            float v = clamp((h - uSkyBand.x) / (uSkyBand.y - uSkyBand.x), 0.0, 1.0);
            vec4 sa = texture2D(uSkyline, vec2(u, v));
            vec4 sb = texture2D(uSkyline, vec2(1.0 - u, v));     // mirrored wrap
            vec4 sk = mix(sb, sa, smoothstep(0.0, 0.07, min(u, 1.0 - u)));
            /* Two kinds of panorama have to work here. A PNG carries its own
               alpha and this is a silhouette; a JPEG has none, so sk.a is 1
               and the band is opaque — which is fine, because a photographic
               horizon brings its own sky and that sky IS the answer for the
               lowest nine degrees. What neither may have is a hard edge where
               the band stops, so it dissolves into the dome across the top
               third rather than being cut off. */
            float k = sk.a * (1.0 - smoothstep(0.62, 1.0, v));
            // and the base washes into the theme haze, so the horizon line
            // belongs to the same air as everything in front of it
            vec3 sc = mix(uHaze, sk.rgb, 0.35 + 0.65 * smoothstep(0.0, 0.45, v));
            col = col * (1.0 - k) + sc * k;
            a = a * (1.0 - k) + k;
          }
        #endif

        #ifdef ASH
          // the caldera itself, burning a hole in the horizon behind the ash.
          // Additive, which premultiplied source-over spells as alpha 0.
          vec2 hz = normalize(vec2(d.x, d.z) + 1e-5);
          float toward = max(dot(hz, uPlumeDir), 0.0);
          col += uEmberCol * exp(-abs(h) * 14.0) * pow(toward, 2.6) * uEmber;
          col += uEmberCol * exp(-abs(h + 0.01) * 26.0) * 0.16 * uEmber;   // the thin hot line
        #endif

          if (a < 0.002 && dot(col, col) < 1e-8) discard;
          gl_FragColor = vec4(max(col, 0.0), clamp(a, 0.0, 1.0));
        }`
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -999;      // straight on top of the physical dome
    this.domeMat = mat;
    this.group.add(this.dome);
    this._applySkyline();          // a rebuild must not lose the panorama
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
          /* Harder edge and a hotter core than before: the disc has to clear
             the bloom threshold on its own (1.30 after the retune) so the
             glow around it is the BLOOM, not a painted gradient. Painted
             gradients read as a sticker; bloom reads as light. */
          float disc = 1.0 - smoothstep(0.148, 0.170, r);
          float limb = mix(1.0, 0.80, smoothstep(0.0, 0.170, r));
          // three lobes: a tight aureole, the corona, and a wide warm bloom
          float glow = exp(-r * 13.0) * 0.34 + exp(-r * 5.2) * 0.40
                     + pow(max(0.0, 1.0 - r), 4.2) * 0.36;
          vec3 col = uCol * (disc * limb * 12.0 + glow * 2.8 * uGlow);
          float a = clamp(disc + glow * 1.5, 0.0, 1.0);
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

  /* ---------------- the vista ring ----------------
     A stage used to end at the edge of the clipmap and then be sky. That
     reads as a diorama on a table: no matter how good the ground is, a
     horizon with nothing behind it tells the eye the world is 3 km across.

     So: ~28 silhouettes on a ring 5–7.5 km out, in ONE BufferGeometry of
     about 500 triangles, coloured by height and by their own distance so the
     far ones sit back into the haze. They are the same object as the dome's
     haze band, only with a shape — which is exactly what atmospheric
     perspective looks like.

     Per theme the shapes are different, because the silhouette is most of
     what tells you WHERE a stage is: flat-topped mesas for the canyon,
     sawtooth peaks for the timberline, one long crater rim for the caldera,
     rolling hills for the airfield, narrow buttes for Thunder Mesa.

     This is the FALLBACK. With a `sky/<theme>` panorama loaded the dome
     paints the real thing and setSkyline() hides the ring. */
  _buildVista() {
    const t = this.theme;
    if (!t.vista) { this.vista = null; return; }
    const n = Math.max(8, this.budget.vista | 0);
    const COLS = VISTA_COLS;
    const rng = makeRNG(this._seed ^ 0x715A);
    const nv = n * (COLS + 1) * 2;
    const pos = new Float32Array(nv * 3);
    const par = new Float32Array(nv * 2);          // hNorm, depth
    const idx = new Uint16Array(n * COLS * 2 * 3);
    const sector = Math.PI * 2 / n;

    let vi = 0, ii = 0;
    for (let i = 0; i < n; i++) {
      const r = VISTA_R0 + rng() * (VISTA_R1 - VISTA_R0);
      const a0 = i * sector + (rng() - 0.5) * sector * 0.55;
      // Half-widths overlap the neighbouring sector on purpose: a ring of
      // separated humps reads as a fence, an overlapping one as a range.
      const aw = sector * (0.58 + rng() * 0.62);
      // Height scales with radius so a far ridge and a near one subtend
      // roughly the same angle — the depth cue is COLOUR, not size.
      const scale = r / 6000;
      const H = vistaHeight(t.vista, rng) * scale;
      const base = -0.050 * r;
      const p0 = rng(), p1 = rng(), p2 = rng();
      const depth = (r - VISTA_R0) / (VISTA_R1 - VISTA_R0);
      const v0 = vi;
      for (let j = 0; j <= COLS; j++) {
        const u = j / COLS;
        const a = a0 + (u - 0.5) * 2 * aw;
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
        const hn = vistaProfile(t.vista, u, p0, p1, p2);
        const o = vi * 3, q = vi * 2;
        pos[o] = cx; pos[o + 1] = base; pos[o + 2] = cz;
        par[q] = 0; par[q + 1] = depth;
        pos[o + 3] = cx; pos[o + 4] = hn * H; pos[o + 5] = cz;
        par[q + 2] = hn; par[q + 3] = depth;
        vi += 2;
      }
      for (let j = 0; j < COLS; j++) {
        const b0 = v0 + j * 2, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
        idx[ii++] = b0; idx[ii++] = t0; idx[ii++] = t1;
        idx[ii++] = b0; idx[ii++] = t1; idx[ii++] = b1;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aParam', new THREE.BufferAttribute(par, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), VISTA_R1 * 1.5);

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      side: THREE.DoubleSide,
      uniforms: {
        uHaze: { value: this.hazeColor },
        uRidge: { value: new THREE.Color(t.vistaColor || 0x60646e) },
        uFade: { value: t.vistaFade === undefined ? 0.40 : t.vistaFade }
      },
      vertexShader: /* glsl */`
        attribute vec2 aParam;
        varying vec2 vP;
        void main(){ vP = aParam; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying vec2 vP;
        uniform vec3 uHaze, uRidge;
        uniform float uFade;
        void main(){
          // haze x height: solid rock at the ridge line, dissolved into the
          // horizon band at the base, and the whole thing pushed toward haze
          // by distance and by how thick the theme's air is
          float k = pow(clamp(vP.x, 0.0, 1.0), 0.85) * (1.0 - vP.y * 0.45) * (1.0 - uFade);
          gl_FragColor = vec4(mix(uHaze, uRidge, k),
            smoothstep(0.0, 0.16, vP.x) * (0.62 + 0.38 * vP.x));
        }`
    });

    this.vista = new THREE.Mesh(geo, mat);
    this.vista.frustumCulled = false;
    this.vista.renderOrder = -993;
    this.vistaMat = mat;
    this.vista.visible = !this._skyline;
    this.group.add(this.vista);
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
          /* Retuned harder. The old ramp was linear in lit*lit, which gives
             a cumulus an even grey gradient — technically a sphere, visually
             a pebble. A cloud is nearly white where the sun reaches it and
             falls off FAST into its own shadow, so the cumulus term gets a
             smoothstep and the silver lining gets over a stop more. Cirrus
             (vLayer 1) keeps its flat wash: it is one ice crystal thick and
             has no shadowed side to find. */
          lit = mix(smoothstep(0.04, 0.92, lit * lit), 0.70 + 0.30 * lit, vLayer);
          vec3 col = mix(uShade, uLit, lit);
          col += uLit * pow(lit, 4.0) * (1.0 - a) * 1.15;        // silver where it thins
          col *= 1.0 + 0.20 * (1.0 - vLayer) * lit;              // tops catch the key
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
     what puts sky colour in the car paint and the glass.

     A SECOND physical dome, sharing the first one's uniforms object, so the
     reflection in a wing mirror and the sky above it are the same sky by
     construction. The only difference is the ground bounce patched under its
     horizon — the model keeps showing sky down there, and sky under a car is
     how you get a floating car.

     Vehicles are MeshPhysicalMaterial with envMapIntensity 0.95–2.4, so this
     lands on chrome, rims, visor, glass and the generated carcasses. Terrain
     and kit are custom/vertex-colour materials and ignore it; that is correct,
     not a bug to chase. */
  _buildEnv() {
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    const mesh = new PhysicalSky();
    mesh.material.uniforms = this.skyUniforms;      // shared, not copied
    mesh.material.depthWrite = false;
    mesh.material.depthTest = false;
    patchSkyMaterial(mesh.material, true);
    mesh.scale.setScalar(200);                      // inside the 1..4000 pmrem frustum
    mesh.frustumCulled = false;
    this.envMesh = mesh;
    this.envScene.add(mesh);
  }

  /**
   * §8.5. Hand the scene an equirect panorama to light from, or null to go
   * back to the shader dome. `assets.get('env/<theme>')` is the source and
   * null is the normal case — every asset in this game is optional.
   *
   * Cheap: it only marks the env dirty, and update() rebuilds once. Calling
   * this five times in a frame costs one PMREM, not five.
   */
  setEnvImage(tex) {
    const next = tex || null;
    if (next === this._envImage) return;
    this._envImage = next;
    this._envDirty = true;
  }

  /** Which of the two paths refreshEnv will take. Cheap enough to assert. */
  envUsesImage() { return !!this._envImage; }

  /**
   * Rebuild the environment map from whichever source is current.
   *
   * BOTH paths dispose the previous render target before dropping the
   * reference. A PMREM target is a cube mip chain and it is not small; three
   * races in a row through the leak this used to have showed up as a hundred
   * megabytes in QA's memory check, which is the only reason anybody noticed.
   */
  refreshEnv() {
    const old = this.envRT;
    this.envRT = this._envImage
      ? this.pmrem.fromEquirectangular(this._envImage)
      : this.pmrem.fromScene(this.envScene, 0, 1, 4000);
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

  /** Rebuild only what the tier actually changes: dome tessellation and clouds.
      The physical dome is a box with an analytic shader — there is no
      tessellation to change, so it survives every tier untouched. */
  setQuality(q) {
    const b = SKY_BUDGET[(q && q.name) || 'HIGH'] || SKY_BUDGET.HIGH;
    this.quality = q;
    if (b === this.budget) return;
    this.budget = b;

    this.group.remove(this.dome);
    this.dome.geometry.dispose(); this.dome.material.dispose();
    this._buildDome();

    if (this.vista) {
      this.group.remove(this.vista);
      this.vista.geometry.dispose(); this.vista.material.dispose();
      this.vista = null;
    }
    this._buildVista();

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
    this.skyMesh.geometry.dispose(); this.skyMesh.material.dispose();
    this.envMesh.geometry.dispose(); this.envMesh.material.dispose();
    this.sunMesh.geometry.dispose(); this.sunMesh.material.dispose();
    if (this.vista) { this.vista.geometry.dispose(); this.vista.material.dispose(); }
    if (this.clouds) {
      this.clouds.geometry.dispose(); this.clouds.material.dispose();
      this.cloudTex.dispose();
    }
    if (this.plume) {
      this.plume.geometry.dispose(); this.plume.material.dispose();
      this.smokeTex.dispose();
    }
    this.pmrem.dispose();
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    if (this.scene.environment) this.scene.environment = null;
    if (this.scene.fog === this.fog) this.scene.fog = this._prevFog;
    // The panorama and the env image belong to Assets, which owns their
    // lifetimes — drop the reference, never the texture.
    this._skyline = null;
    this._envImage = null;
    this.clouds = this.plume = this.dome = this.sunMesh = this.vista = null;
    this.skyMesh = this.envMesh = null;
  }
}

/* ============================================================
   ARSENAL KIT — the rockets, what they come in, and what fires them
   ------------------------------------------------------------
   Five shapes under exactly the rule kit.js lives by: position + normal +
   color, NO uv, standing on y = 0, +Z forward. They go through kit.js's own
   builder so they merge with everything else on a stage and so a crate can
   sit in an InstancedMesh next to a boost pad under the same vertex-coloured
   material.

   WHO READS THESE. arsenal.js instances the crate and the can as pickups, the
   beacon as the column that makes them findable, and the rocket as the
   projectile; vehicle-art.js mounts launcherGeo on the roof and racks
   rocketGeo as the visible ammo count; dev/kit-check.mjs gates all five beside
   kit.js's own factories. The five signatures below are therefore a contract
   (ARCHITECTURE §8.8) — add a shape, never change one of these.

   THE BEACON IS THE ONE THAT IS NOT LIT. Everything else here goes under a
   MeshStandardMaterial and takes the sun; the beacon goes under an additive
   MeshBasicMaterial and IS the light, which is why its vertex colours are a
   baked white-to-black gradient rather than a description of what it is
   painted. Read its own comment before changing a number in it.

   THE COLOURS ARE NOT THE THEME'S. A pickup has to be the one thing on the
   stage that is obviously not scenery, and it has to look the same on all
   five stages so the lesson transfers — the same argument kit.js makes for
   the item box's cyan. The crate is olive drab under a warning-yellow band;
   the can is the nitro orange the HUD and the boost flame already use; the
   rocket is a pale body with a red nose so it reads against dark rock and
   pale sand alike. The palette supplies only the metal.

   `seed` moves nothing a player would notice — a nose leans a degree, a band
   sits a centimetre higher — and exists so the four factories obey kit.js's
   "same seed, same object, forever" rule like everything else on the stage.
   ============================================================ */
import { builder, shade } from './kit.js';
import { makeRNG, clamp } from '../core/rng.js';

const CRATE_BODY = 0x4f5a34;         // olive drab
const CRATE_BAND = 0xffd23f;         // warning yellow — the ROCKETS pickup colour
const CRATE_STRAP = 0x2a2d22;
const ROCKET_BODY = 0xd9d5c8;        // pale, so it reads against rock and sand alike
const ROCKET_NOSE = 0xd8342a;
const ROCKET_FIN = 0x3a3d3a;
const NITRO_CAN = 0xff8a1a;          // the nitro orange the HUD already uses
const NITRO_BAND = 0xf3f0ea;

/**
 * An ammo crate: a strapped olive box with three rocket noses standing out of
 * the top, so it says "rockets" from thirty metres without a label. 1.0 m
 * wide, 0.62 m deep, ~0.8 m tall with the noses.
 */
export function rocketCrateGeo(P, seed) {
  const rng = makeRNG((seed * 0x2F1B5) | 1);
  const b = builder();
  const W = 1.0, H = 0.56, D = 0.62;
  b.slab(CRATE_BODY, W, H, D, 0, 0, 0);
  // two straps over the top and down the sides, proud of the body
  for (const s of [-1, 1]) {
    b.box(CRATE_STRAP, 0.08, H + 0.02, D + 0.02, s * 0.28, H * 0.5, 0);
  }
  // the warning band, front and back
  for (const s of [-1, 1]) {
    b.box(CRATE_BAND, W * 0.9, 0.12, 0.012, 0, H * 0.54, s * (D * 0.5 + 0.004));
  }
  // metal corner caps: the thing that catches a low sun
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(shade(P.metal, -0.15), 0.07, 0.07, 0.07, sx * (W * 0.5 - 0.035), H - 0.035, sz * (D * 0.5 - 0.035));
    }
  }
  /* Three noses out of the lid. Each leans by up to ~3° off the seed: a row
     of perfectly parallel cones reads as a model, a slightly disorderly one
     as a crate somebody packed. */
  for (let i = -1; i <= 1; i++) {
    const lean = (rng() - 0.5) * 0.10;
    const x = i * 0.28;
    b.cyl(shade(ROCKET_BODY, -0.05), 0.07, 0.07, 0.10, 10, x, H + 0.05, 0, 0, 0, lean);
    b.cone(ROCKET_NOSE, 0.07, 0.18, 10, x - Math.sin(lean) * 0.19, H + 0.19, 0, 0, 0, lean);
  }
  return b.done();
}

/**
 * A nitro can: a squat orange bottle with a pale band, a metal neck and a
 * valve across the top. ~0.4 m across, ~0.78 m tall. The valve's yaw is the
 * only thing the seed moves.
 */
export function nitroCanGeo(P, seed) {
  const rng = makeRNG((seed * 0x3A7C9) | 1);
  const b = builder();
  const R = 0.19, H = 0.48;
  b.cyl(shade(P.metal, -0.30), R + 0.01, R + 0.01, 0.04, 14, 0, 0.02, 0);      // base ring
  b.cyl(NITRO_CAN, R, R, H, 14, 0, H * 0.5, 0);                                 // the bottle
  b.cyl(NITRO_BAND, R + 0.005, R + 0.005, 0.10, 14, 0, 0.30, 0);               // the band
  b.box(shade(NITRO_CAN, -0.55), 0.14, 0.16, 0.02, 0, 0.19, R - 0.004);        // the label
  b.cone(shade(NITRO_CAN, -0.10), R, 0.14, 14, 0, H + 0.07, 0);                // the shoulder
  b.cyl(shade(P.metal, 0.05), 0.06, 0.06, 0.10, 8, 0, H + 0.14 + 0.05, 0);     // the neck
  const yaw = rng() * Math.PI;
  b.box(shade(P.metal, 0.15), 0.18, 0.05, 0.05, 0, H + 0.14 + 0.10 + 0.025, 0, 0, yaw, 0);  // the valve
  return b.done();
}

/**
 * The projectile. Lies along +Z (nose forward), 0.9 m long, and stands on
 * its fins at y = 0 — arsenal.js lifts the instance by the axis height so the
 * body flies where the sim says the rocket is. A red band near the nose is
 * the only mark the seed moves.
 */
export function rocketGeo(P, seed) {
  const rng = makeRNG((seed * 0x1D4F7) | 1);
  const b = builder();
  const R = 0.09;                      // body radius
  const FIN = 0.10;                    // radial reach of a fin past the body
  /* Fins sit at 45° so none points straight down; the lowest point is then
     the fin tip at (R + FIN)·sin45 below the axis, which puts the axis here. */
  const A = (R + FIN) * Math.SQRT1_2;
  // body, then the nose cone: CylinderGeometry/ConeGeometry stand along +Y,
  // and rotateX(π/2) lays +Y onto +Z
  b.cyl(ROCKET_BODY, R, R, 0.62, 12, 0, A, -0.04, Math.PI / 2);
  b.cone(ROCKET_NOSE, R, 0.24, 12, 0, A, 0.39, Math.PI / 2);
  // exhaust nozzle — flared toward the tail, dark
  b.cyl(shade(P.metal, -0.45), 0.06, 0.085, 0.08, 10, 0, A, -0.39, Math.PI / 2);
  // the band, somewhere on the front half
  b.cyl(ROCKET_NOSE, R + 0.004, R + 0.004, 0.05, 12, 0, A, 0.06 + rng() * 0.10, Math.PI / 2);
  // four fins at the tail. rotateZ turns the fin's +Y (radial) toward −X.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const rad = R + FIN * 0.5;
    b.box(ROCKET_FIN, 0.02, FIN, 0.16, -Math.sin(a) * rad, A + Math.cos(a) * rad, -0.30, 0, 0, a);
  }
  void P;
  return b.done();
}

/* ---------------- the beacon ----------------
   A crate is a metre wide. At 150 m that is a handful of pixels and no amount
   of emissive pulse makes a handful of pixels into a landmark — what makes a
   pickup readable at range is something with a screen-space size that does not
   collapse, and the cheapest one of those is a VERTICAL: a column reads at any
   distance because the horizon it stands against is horizontal.

   These three numbers are the whole shape. Nine bands, not one tapered
   cylinder, because the colour lives in the VERTICES (this file's contract is
   position + normal + colour and NO uv, so there is nowhere else to put a
   gradient) and a gradient needs somewhere to be sampled. */
const BEACON_H = 6.0;            // m — clears a crest and a car in front of you
const BEACON_R = 0.055;          // m at the foot; it tapers to about half that
const BEACON_BANDS = 9;

/**
 * The column of light over a pickup. Drawn white at the base and fading to
 * black at the top, so that whatever tint arsenal.js multiplies in — the
 * crate's yellow, the can's orange — fades out with height for free, on one
 * additive InstancedMesh shared by both kinds and one draw call for the lot.
 *
 * BAKED SRGB, DECODED BY THE MATERIAL. kit.js's tint() puts a hex through
 * THREE.Color.set, which converts sRGB to linear, so the authored ramp is
 * raised to about 2.2 on its way into the buffer. The exponent below is
 * therefore deliberately SHALLOW — a linear-looking ramp authored here would
 * arrive as a stub of light on the ground with six metres of nothing above it.
 *
 * Open-ended cylinders: nobody sees the inside of a 5 cm tube, the material
 * draws both sides so the far wall adds through the near one, and dropping the
 * caps halves the triangle count of a shape that is instanced forty times.
 */
export function beaconGeo(P, seed) {
  const rng = makeRNG((seed * 0x7B19D) | 1);
  const b = builder();
  const h = BEACON_H / BEACON_BANDS;
  for (let i = 0; i < BEACON_BANDS; i++) {
    const t0 = i / BEACON_BANDS, t1 = (i + 1) / BEACON_BANDS;
    const f = Math.pow(1 - (t0 + t1) * 0.5, 0.85);
    const g = clamp(Math.round(f * 255), 0, 255);
    /* A flare at the foot so the column is planted rather than hovering, and
       a per-band wobble of a couple of percent off the seed — a perfectly
       parallel tube reads as a cylinder, which is the one thing it must not
       read as. Neither is a millimetre a player could measure; both are here
       because kit.js's "same seed, same object, forever" rule applies to
       every factory in this file and a factory that ignores its seed is a
       factory nobody notices has stopped being deterministic. */
    const flare = i === 0 ? 1.7 : 1.0;
    const wob = 0.96 + rng() * 0.08;
    const rb = BEACON_R * (1 - t0 * 0.50) * flare * wob;
    const rt = BEACON_R * (1 - t1 * 0.50) * wob;
    b.cyl((g << 16) | (g << 8) | g, rt, rb, h, 7, 0, (i + 0.5) * h, 0, 0, 0, 0, true);
  }
  void P;
  return b.done();
}

/**
 * The roof mount: a plate, a cradle and `tubes` launch tubes side by side
 * along +Z. Built LEVEL — the spec's `launcher.pitch` is applied by whoever
 * mounts it — and standing on y = 0 so vehicle-art.js can drop it on a roof
 * at the mount height and nothing else. Tubes clamp to 1..4; a yellow band
 * near each muzzle sits a centimetre or two apart per seed.
 */
export function launcherGeo(P, seed, tubes = 2) {
  const rng = makeRNG((seed * 0x5C3D1) | 1);
  const b = builder();
  const n = clamp(tubes | 0, 1, 4);
  const PITCH_X = 0.18;                // tube spacing
  const TR = 0.075, TL = 0.72;
  const W = n * PITCH_X + 0.10;
  const dark = shade(P.metal, -0.35);
  b.slab(dark, W, 0.04, 0.34, 0, 0, 0);                                  // the plate
  for (const s of [-1, 1]) b.box(shade(P.metal, -0.20), W, 0.10, 0.05, 0, 0.09, s * 0.16);  // the cradle
  const AXIS = 0.04 + 0.10 + TR - 0.02;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) * 0.5) * PITCH_X;
    b.cyl(dark, TR, TR, TL, 10, x, AXIS, 0, Math.PI / 2);                              // the tube
    b.cyl(shade(P.metal, 0.05), TR + 0.01, TR + 0.01, 0.04, 10, x, AXIS, TL * 0.5 - 0.02, Math.PI / 2);   // muzzle ring
    b.cyl(shade(P.metal, -0.55), TR - 0.015, TR - 0.015, 0.05, 8, x, AXIS, -TL * 0.5 - 0.01, Math.PI / 2);  // breech
    b.cyl(CRATE_BAND, TR + 0.003, TR + 0.003, 0.03, 10, x, AXIS, 0.20 + rng() * 0.03, Math.PI / 2);  // the band
  }
  return b.done();
}

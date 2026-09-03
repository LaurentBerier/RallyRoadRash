/* ============================================================
   ARSENAL KIT — the rockets, what they come in, and what fires them
   ------------------------------------------------------------
   Four shapes under exactly the rule kit.js lives by: position + normal +
   color, NO uv, standing on y = 0, +Z forward. They go through kit.js's own
   builder so they merge with everything else on a stage and so a crate can
   sit in an InstancedMesh next to a boost pad under the same vertex-coloured
   material.

   WHO READS THESE. arsenal.js instances the crate and the can as pickups and
   the rocket as the projectile; vehicle-art.js mounts launcherGeo on the roof
   and racks rocketGeo as the visible ammo count; dev/kit-check.mjs gates all
   four beside kit.js's own factories. The four signatures below are therefore
   a contract (ARCHITECTURE §8.8) — add a shape, never change one of these.

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

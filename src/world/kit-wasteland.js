/* ============================================================
   THE WASTELAND LAYER — what the road outlived
   ------------------------------------------------------------
   A second half of kit.js, split for exactly one reason: kit.js was 1126
   lines and the house limit is 1400. Everything here obeys kit.js's rules
   to the letter — palette in, one merged BufferGeometry out, position +
   normal + colour and NO uv, real metres, feet on y = 0, deterministic in
   `seed` — so a wasteland shape merges with a hay bale and shares the one
   vertex-coloured material the whole stage already uses.

   WHAT THIS LAYER IS FOR
   ----------------------
   kit.js dresses a stage that somebody is still using: sheds with flues,
   grandstands with people in them, a water tank that still holds water.
   This file dresses the part nobody came back for. The difference is not
   the palette — it is the same palette — it is that every shape here is
   BROKEN in a way you can read at 130 km/h: a car on its roof, a barricade
   welded out of somebody else's car, a billboard with no face left.

   TRIANGLES ARE THE WHOLE DESIGN CONSTRAINT. These are placed by the
   dozen and merged into one static mesh, so a shape that costs 900
   triangles instead of 300 costs the stage 8 k it cannot spend. Every
   cylinder in here is 5–9 segments and every sphere was replaced with a
   box, because at 20 m a rotated box is a sandbag and at 60 m nothing is
   anything. dev/kit-check.mjs holds the resulting census to a budget.
   ============================================================ */
import { builder, shade } from './kit.js';
import { makeRNG } from '../core/rng.js';

/* Tyre black and scorch black are deliberately NOT palette entries: rubber
   and soot look the same on every stage, and pulling them from `metal`
   would make the volcano's tyres lighter than the canyon's. */
const TYRE = 0x1a1a1c;
const SOOT = 0x241f1c;

/* ---------------- carcasses ---------------- */

/**
 * A stripped car husk. Three variants, because two of the same wreck 30 m
 * apart reads as an asset and three reads as a road that has been killing
 * people for years.
 *
 *   0  saloon on its roof, wheels in the air
 *   1  pickup, cab flattened, bed torn off
 *   2  panel van nosed into something, doors hanging
 *
 * Unlike kit.js's `wreckGeo` — which is a burnt RALLY car, and belongs to
 * the event layer — this is traffic. No roll cage, no racing number, and
 * the paint that is left is a colour nobody chose.
 */
export function wreckHuskGeo(P, seed, variant = 0) {
  const v = ((variant % 3) + 3) % 3;
  const rng = makeRNG((seed * 486187 + v * 7919) | 1);
  const b = builder();
  const shell = shade(P.rust, -0.34 + rng() * 0.30);
  const panel = shade(P.metal, -0.40 + rng() * 0.24);
  const W = 1.70;
  const tip = (rng() - 0.5) * 0.16;               // nothing here is level

  if (v === 0) {
    const L = 4.0;
    // the roof, pressed flat into the dirt, and the floorpan facing the sky
    b.slab(panel, W * 0.92, 0.16, L * 0.62, 0, 0, -0.35, tip, 0, 0.05);
    b.slab(shell, W, 0.54, L, 0, 0.14, 0, tip, 0, 0.05);
    b.slab(shade(shell, -0.22), 0.36, 0.14, L * 0.80, 0, 0.68, 0, tip);   // trans tunnel
    b.slab(SOOT, W * 0.86, 0.20, L * 0.30, 0, 0.62, L * 0.30, tip);       // burnt engine bay
    // the door apertures, which is what says the glass is gone
    for (const s of [-1, 1]) for (const dz of [-0.55, 0.75]) {
      b.box(shade(panel, -0.30), 0.10, 0.46, 0.90, s * W * 0.48, 0.30, dz, tip);
    }
    // two wheels still on, pointing at nothing
    for (const s of [-1, 1]) {
      b.cyl(TYRE, 0.31, 0.31, 0.24, 9, s * W * 0.52, 0.60, -L * 0.30, 0, 0, Math.PI / 2);
    }
    b.tube(shade(panel, -0.1), -W * 0.5, 0.60, L * 0.30, W * 0.5, 0.60, L * 0.30, 0.055, 5);
  } else if (v === 1) {
    const L = 4.6;
    b.slab(shade(panel, -0.2), W * 0.86, 0.22, L, 0, 0.28, 0, tip);        // chassis rails
    b.slab(shell, W, 0.62, L * 0.40, 0, 0.44, -L * 0.16, tip);             // cab, sat down on itself
    b.slab(shade(panel, -0.34), W * 0.80, 0.30, L * 0.34, 0, 1.02, -L * 0.14, tip);
    b.slab(shell, W * 0.94, 0.36, L * 0.30, 0, 0.42, L * 0.28, tip, 0, 0.08);  // bonnet, folded
    b.slab(SOOT, 0.80, 0.54, 0.74, 0, 0.50, L * 0.36, tip);                // engine, exposed
    // the bed is gone; what is left is the frame it bolted to
    for (const s of [-1, 1]) {
      b.box(shade(panel, -0.15), 0.12, 0.12, L * 0.44, s * W * 0.40, 0.44, -L * 0.30, 0.1 * s);
      b.cyl(TYRE, 0.34, 0.34, 0.26, 9, s * W * 0.54, 0.34, L * 0.30, 0, 0, Math.PI / 2);
    }
    b.cyl(TYRE, 0.34, 0.34, 0.26, 9, -W * 0.54, 0.34, -L * 0.28, 0, 0, Math.PI / 2);
    b.cyl(shade(panel, 0.1), 0.30, 0.30, 0.10, 8, W * 0.50, 0.14, -L * 0.30, Math.PI / 2 + 0.4, 0, 0);
  } else {
    const L = 5.0;
    b.slab(shell, W, 1.55, L * 0.72, 0, 0.30, -L * 0.10, tip);             // box body
    b.slab(shade(shell, -0.18), W * 0.98, 0.90, L * 0.30, 0, 0.26, L * 0.32, tip, 0, -0.14);  // crushed nose
    b.slab(shade(panel, -0.44), W * 0.90, 0.60, 0.08, 0, 0.90, L * 0.46, tip);  // windscreen hole
    b.slab(shade(panel, 0.12), W * 1.04, 0.12, L * 0.74, 0, 1.86, -L * 0.10, tip);  // roof cap
    // side ribs, and one door swung open on its hinge
    for (let i = 0; i < 4; i++) {
      const z = (i / 3 - 0.5) * L * 0.62 - L * 0.10;
      b.box(shade(shell, -0.24), W * 1.02, 0.12, 0.09, 0, 1.10, z, tip);
    }
    b.box(shade(panel, -0.10), 0.08, 1.20, 0.86, W * 0.50, 0.86, L * 0.16, 0, -0.9, 0);
    for (const s of [-1, 1]) {
      b.cyl(TYRE, 0.36, 0.36, 0.26, 9, s * W * 0.52, 0.36, L * 0.26, 0, 0, Math.PI / 2);
    }
    b.cyl(TYRE, 0.36, 0.36, 0.26, 9, -W * 0.52, 0.36, -L * 0.30, 0, 0, Math.PI / 2);
  }
  return b.done();
}

/**
 * A heap of scrap: crumpled panel, a bent axle, a wheel that got away, and
 * the dust drift that has built up on the windward side of all of it.
 *
 * The one shape in this file that goes into the SCATTER rather than the
 * dressing plan, so it is the one with a hard triangle ceiling — there are
 * sixty of these on a stage at HIGH and every triangle is paid for sixty
 * times. Boxes only, and no cylinder over 7 segments.
 */
export function scrapPileGeo(P, seed) {
  const rng = makeRNG((seed * 512927) | 1);
  const b = builder();
  const junk = shade(P.rust, -0.24 + rng() * 0.36);
  b.slab(shade(P.dirt, -0.12), 1.35, 0.16, 1.15, 0, 0, 0, 0, rng() * 1.2, 0);   // drift
  for (let i = 0; i < 3; i++) {
    const w = 0.5 + rng() * 0.6;
    b.box(shade(junk, (rng() - 0.5) * 0.34), w, 0.09, 0.4 + rng() * 0.5,
      (rng() - 0.5) * 0.5, 0.16 + rng() * 0.34, (rng() - 0.5) * 0.5,
      (rng() - 0.5) * 1.1, rng() * 6.283, (rng() - 0.5) * 1.1);
  }
  b.cyl(TYRE, 0.28, 0.28, 0.20, 7, 0.35, 0.20, -0.28, 1.2, 0.6, 0);
  b.cyl(shade(P.metal, -0.2), 0.05, 0.05, 1.5, 5, -0.1, 0.30, 0.15, 0.2, rng() * 3.1, 1.3);
  return b.done();
}

/**
 * Jack-knifed fuel tanker. The biggest carcass in the file and the only one
 * that reads from the far side of a valley, which is what it is for: a
 * ten-metre horizontal cylinder is a silhouette nothing else on a rally
 * stage makes.
 *
 * Split open along the top, because a sealed tanker is a prop and a burst
 * one is a story. Lies along +X so a caller yaws it into the ditch.
 */
export function tankerWreckGeo(P, seed) {
  const rng = makeRNG((seed * 534809) | 1);
  const b = builder();
  const barrel = shade(P.metal, -0.10 + rng() * 0.22);
  const R = 1.25, L = 7.4;
  // the tank, on its side and slightly rolled
  b.cyl(barrel, R, R, L, 11, 0.6, R * 0.92, 0, 0, 0, Math.PI / 2);
  for (const t of [-0.34, 0, 0.34]) {
    b.cyl(shade(barrel, -0.20), R * 1.04, R * 1.04, 0.12, 11, 0.6 + t * L, R * 0.92, 0, 0, 0, Math.PI / 2);
  }
  // the split: a dark trough down the crown with its lips peeled back
  b.box(SOOT, L * 0.66, 0.10, R * 0.9, 0.6, R * 1.86, 0);
  for (const s of [-1, 1]) {
    b.box(shade(barrel, 0.16), L * 0.62, 0.07, 0.55, 0.6, R * 1.80, s * R * 0.55, s * 0.55, 0, 0);
  }
  b.cyl(shade(P.rust, 0.1), R * 0.34, R * 0.34, 0.5, 8, 0.6 - L * 0.52, R * 0.92, 0, 0, 0, Math.PI / 2);
  // the tractor unit, folded across the front of its own trailer
  const cab = shade(P.paintAlt, -0.42);
  b.slab(shade(P.metal, -0.30), 2.4, 0.34, 1.9, -L * 0.62, 0.22, 0.9, 0, 0.62, 0);
  b.slab(cab, 1.9, 1.7, 1.8, -L * 0.66, 0.52, 1.0, 0, 0.62, -0.10);
  b.slab(shade(cab, -0.40), 1.7, 0.9, 0.10, -L * 0.66 + 0.72, 1.10, 1.65, 0, 0.62, 0);
  b.cyl(shade(P.rust, -0.1), 0.14, 0.14, 1.9, 6, -L * 0.60, 1.60, 0.3);       // stack
  for (const s of [-1, 1]) {
    b.cyl(TYRE, 0.52, 0.52, 0.34, 9, -L * 0.66 + s * 0.4, 0.52, 1.0 + s * 0.9, 0, 0.62, Math.PI / 2);
    b.cyl(TYRE, 0.52, 0.52, 0.34, 9, 0.6 + s * 0.5 + L * 0.34, 0.52, s * 0.55, 0, 0, Math.PI / 2);
  }
  return b.done();
}

/* ---------------- machinery that stopped ---------------- */

/**
 * Pumpjack. Base skid, samson post, walking beam, horse head and the
 * counterweight crank — the five parts that make the silhouette, and
 * nothing else, because the whole thing is read against the sky.
 *
 * Frozen mid-stroke rather than level: a nodding donkey stopped level
 * looks like it is waiting, and this one is not waiting for anything.
 */
export function pumpjackGeo(P, seed) {
  const rng = makeRNG((seed * 557069) | 1);
  const b = builder();
  const steel = shade(P.metal, -0.18 + rng() * 0.24);
  const nod = 0.16 + rng() * 0.14;                 // the stroke it died on
  b.slab(shade(P.concrete, -0.10), 2.0, 0.24, 5.6, 0, 0, 0);
  // samson post: an A-frame, which is the only part that has to be stiff
  for (const s of [-1, 1]) {
    b.tube(steel, s * 0.75, 0.24, -0.9, 0, 3.5, 0, 0.085, 5);
    b.tube(steel, s * 0.75, 0.24, 0.9, 0, 3.5, 0, 0.085, 5);
  }
  b.tube(shade(steel, -0.2), -0.75, 1.8, -0.9, 0.75, 1.8, 0.9, 0.05, 4);
  // the walking beam, nodding forward
  const bx = Math.sin(nod), by = Math.cos(nod);
  b.box(shade(P.rust, 0.05), 0.26, 0.34, 6.2, 0, 3.5, 0, nod, 0, 0);
  // horse head at the well end, hanging its bridle down the hole
  b.box(shade(steel, 0.12), 0.30, 1.10, 0.70, 0, 3.5 - bx * 3.1 - 0.35, by * 3.1, nod);
  b.tube(shade(steel, -0.3), 0, 3.5 - bx * 3.1 - 0.85, by * 3.1 + 0.28,
    0, 0.9, by * 3.1 + 0.28, 0.045, 4);
  b.cyl(P.rust, 0.22, 0.30, 0.9, 8, 0, 0.45, by * 3.1 + 0.28);            // wellhead
  // crank and counterweight at the pitman end
  b.slab(shade(steel, -0.26), 1.5, 1.5, 1.2, 0, 0, -2.6);
  for (const s of [-1, 1]) {
    b.cyl(shade(P.rust, -0.12), 0.62, 0.62, 0.16, 9, s * 0.55, 1.55, -2.6, 0, 0, Math.PI / 2);
    b.tube(steel, s * 0.55, 1.55, -2.6, s * 0.55, 3.5 + bx * 3.1 * 0.9, -by * 3.0, 0.05, 4);
  }
  return b.done();
}

/**
 * Farm wind pump: lattice tower, a multi-blade fan and a tail vane.
 *
 * The fan is TWELVE PLANES on a hub, not a disc — from any angle that
 * matters it is a wheel of glints, and a disc with a texture would need
 * uvs this whole file does not have. Two blades are missing, which is what
 * stops it reading as maintained.
 */
export function windPumpGeo(P, seed, h = 8.0) {
  const rng = makeRNG((seed * 578917) | 1);
  const b = builder();
  const steel = shade(P.metal, -0.14 + rng() * 0.20);
  const base = 1.15, top = 0.30;
  const at = (i, t) => {
    const a = i * Math.PI * 0.5 + Math.PI * 0.25;
    const r = base + (top - base) * t;
    return [Math.cos(a) * r, t * h, Math.sin(a) * r];
  };
  for (let i = 0; i < 4; i++) {
    const p = at(i, 0), q = at(i, 1);
    b.tube(steel, p[0], p[1], p[2], q[0], q[1], q[2], 0.05, 4);
  }
  for (let r = 1; r <= 4; r++) {
    const t = r / 4.4;
    for (let i = 0; i < 4; i++) {
      const p = at(i, t), q = at((i + 1) & 3, t);
      b.tube(shade(steel, -0.15), p[0], p[1], p[2], q[0], q[1], q[2], 0.024, 4);
      if (i < 2) {
        const d = at((i + 1) & 3, Math.min(1, t + 1 / 4.4));
        b.tube(shade(steel, -0.15), p[0], p[1], p[2], d[0], d[1], d[2], 0.02, 4);
      }
    }
  }
  // the head: hub, blades, vane
  b.cyl(shade(P.rust, 0.05), 0.22, 0.26, 0.5, 8, 0, h + 0.25, 0, Math.PI / 2, 0, 0);
  for (let i = 0; i < 12; i++) {
    if (i === 3 || i === 8) continue;              // two gone, and it still turns
    const a = i / 12 * Math.PI * 2 + rng() * 0.05;
    b.plane(shade(steel, 0.10 + (i & 1 ? -0.14 : 0)), 0.24, 0.86,
      0, h + 0.25 + Math.cos(a) * 0.78, Math.sin(a) * 0.78 - 0.18, 0.34, Math.PI / 2, a);
  }
  b.plane(shade(P.paintAlt, -0.30), 1.2, 0.62, 0, h + 0.30, 1.35, 0, Math.PI / 2, 0);
  b.tube(steel, 0, h + 0.25, 0.2, 0, h + 0.30, 1.1, 0.035, 4);
  return b.done();
}

/**
 * Watchtower: four legs, a boarded deck, a shade roof and a ladder.
 *
 * Sited 40–80 m off the road, which is the distance at which a tower is
 * scale and not furniture — near enough to know how tall it is, far enough
 * that you never think about driving to it. Deliberately CRUDER than
 * kit.js's lattice `towerGeo`: that one is infrastructure somebody
 * commissioned, this one is four poles and whatever was in the truck.
 */
export function watchtowerGeo(P, seed, h = 10.5) {
  const rng = makeRNG((seed * 596909) | 1);
  const b = builder();
  const wood = shade(P.timber, -0.12 + rng() * 0.26);
  const S = 1.55;
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of legs) {
    b.tube(wood, sx * S * 1.20, 0, sz * S * 1.20, sx * S * 0.62, h, sz * S * 0.62, 0.10, 5);
  }
  // two rings of bracing; a third would cost 130 triangles nobody can see
  for (const t of [0.32, 0.66]) {
    const r = S * (1.20 + (0.62 - 1.20) * t), y = t * h;
    for (let i = 0; i < 4; i++) {
      const a = legs[i], c = legs[(i + 1) & 3];
      b.tube(shade(wood, -0.18), a[0] * r, y, a[1] * r, c[0] * r, y, c[1] * r, 0.045, 4);
    }
    b.tube(shade(wood, -0.18), -r, y, -r, r, y + h * 0.16, r, 0.038, 4);
  }
  // deck, rail and a lean-to roof on two short posts
  const d = S * 0.62 + 0.55;
  b.slab(shade(P.wood, 0.06), d * 2, 0.14, d * 2, 0, h, 0);
  for (const s of [-1, 1]) {
    b.box(shade(wood, 0.1), d * 2, 0.10, 0.10, 0, h + 0.95, s * d);
    b.box(shade(wood, 0.1), 0.10, 0.10, d * 2, s * d, h + 0.95, 0);
    b.box(shade(P.metal, -0.30), d * 2 * 0.96, 0.55, 0.06, 0, h + 0.42, s * d);   // kick plate
  }
  for (const [sx, sz] of legs) b.cyl(wood, 0.07, 0.07, 1.9, 5, sx * d * 0.9, h + 1.1, sz * d * 0.9);
  b.box(shade(P.metal, -0.06), d * 2.3, 0.10, d * 2.3, 0, h + 2.05, 0, -0.13);
  // the ladder, which is what makes the height believable
  for (const s of [-1, 1]) b.tube(shade(wood, 0.14), s * 0.28, 0, S * 1.35, s * 0.28, h, S * 0.72, 0.05, 4);
  for (let i = 1; i < 8; i++) {
    const t = i / 8, z = S * (1.35 + (0.72 - 1.35) * t);
    b.box(shade(P.metal, -0.1), 0.62, 0.05, 0.05, 0, t * h, z);
  }
  return b.done();
}

/* ---------------- things put across the road ---------------- */

/**
 * A run of concrete jersey barriers, nose to tail.
 *
 * The real profile is a curve; this is three stacked boxes, which gives
 * the same read — wide splayed foot, kicked-in waist, narrow top — for 36
 * triangles a barrier instead of a lathe. Built along +X so a caller yaws
 * it along whatever edge it is defending.
 */
export function jerseyBarrierGeo(P, seed, n = 4) {
  const rng = makeRNG((seed * 611953) | 1);
  const b = builder();
  const unit = 2.1;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) * 0.5) * unit;
    const c = shade(P.concrete, -0.14 + rng() * 0.26);
    const skew = (rng() - 0.5) * 0.10;              // nobody laid these straight
    b.slab(c, unit * 0.98, 0.28, 0.62, x, 0, 0, 0, skew, 0);
    b.slab(shade(c, -0.06), unit * 0.98, 0.34, 0.42, x, 0.28, 0, 0, skew, 0);
    b.slab(shade(c, 0.08), unit * 0.98, 0.34, 0.26, x, 0.62, 0, 0, skew, 0);
    // a diagonal hazard flash on the traffic face, on about half of them
    if (rng() < 0.55) b.box(P.hazard, unit * 0.34, 0.30, 0.04, x, 0.55, -0.15, 0, skew, 0.5);
  }
  return b.done();
}

/**
 * Sandbag wall on a low berm. Every bag is a rotated box, because a
 * squashed sphere is 30 triangles and a box is 12, and at the 15 m this
 * is ever seen from the difference is the jitter, not the geometry.
 */
export function sandbagWallGeo(P, seed, len = 3.6) {
  const rng = makeRNG((seed * 634297) | 1);
  const b = builder();
  const bagW = 0.52, bagH = 0.22;
  const rows = 4;
  b.slab(shade(P.dirt, -0.20), len * 1.10, 0.10, 0.86, 0, 0, 0);
  for (let r = 0; r < rows; r++) {
    const n = Math.max(2, Math.round((len - r * 0.28) / bagW));
    const y = 0.08 + r * bagH * 0.92;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) * 0.5) * bagW + (r & 1 ? bagW * 0.5 : 0);
      b.box(shade(P.canvas, -0.34 + rng() * 0.22), bagW * 0.96, bagH, 0.36,
        x, y + bagH * 0.5, (rng() - 0.5) * 0.06,
        (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.16, (rng() - 0.5) * 0.14);
    }
  }
  return b.done();
}

/**
 * A barricade welded out of the last people who tried to get past it:
 * a plate wall on a scrap frame, tyres wedged at the foot, and stakes
 * angled at whatever is coming.
 *
 * Goes on the OUTSIDE of the three tightest corners on a lap, which is
 * where the crowd and the warning boards already are — the corner that
 * needs a sign is the corner that needs something to hit.
 */
export function barricadeGeo(P, seed, len = 5.0) {
  const rng = makeRNG((seed * 656311) | 1);
  const b = builder();
  const plate = shade(P.rust, -0.16 + rng() * 0.34);
  const H = 1.35;
  const posts = Math.max(2, Math.round(len / 1.7));
  for (let i = 0; i < posts; i++) {
    const x = (i - (posts - 1) * 0.5) * (len / (posts - 1 || 1));
    b.cyl(shade(P.metal, -0.28), 0.09, 0.11, H * 1.16, 6, x, H * 0.58, 0);
    b.tube(shade(P.metal, -0.34), x, H * 0.95, 0, x + 0.1, 0.05, -1.05, 0.05, 4);   // raker
  }
  // the wall: overlapping plates, none of them the same height
  const plates = Math.max(3, Math.round(len / 1.05));
  for (let i = 0; i < plates; i++) {
    const x = (i - (plates - 1) * 0.5) * (len / plates) * 1.08;
    const ph = H * (0.62 + rng() * 0.42);
    b.slab(shade(plate, (rng() - 0.5) * 0.30), len / plates * 1.14, ph, 0.08,
      x, 0.06, 0.10, 0, 0, (rng() - 0.5) * 0.14);
  }
  b.box(P.hazard, len * 0.98, 0.16, 0.10, 0, H * 1.10, 0.10);      // the one painted part
  // tyres at the foot and stakes leaning into the traffic
  for (let i = 0; i < 3; i++) {
    const x = (rng() - 0.5) * len * 0.86;
    b.cyl(TYRE, 0.34, 0.34, 0.24, 8, x, 0.34, 0.34, 0, 0, Math.PI / 2);
  }
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * len * 0.26;
    b.cone(shade(P.timber, -0.1 + rng() * 0.3), 0.09, 1.5, 5, x, 0.62, 0.62, -0.85, 0, 0);
  }
  return b.done();
}

/* ---------------- signals ---------------- */

/**
 * A drum with a fire in it. The one prop in the game that is ALIVE while
 * nothing is happening — props.update runs an ember emitter off it — and
 * the reason a night-black stage still has somewhere to look.
 *
 * The flame itself is not geometry: this file has one matte vertex-coloured
 * material and cannot emit. What it has instead is a near-white core plane
 * across the drum mouth, sized so the bloom finds it and the sparks come out
 * of something that was already bright. The same trick as the floodlight
 * lenses in kit.js, for the same reason.
 */
export function fireDrumGeo(P, seed) {
  const rng = makeRNG((seed * 678331) | 1);
  const b = builder();
  const R = 0.30, H = 0.86;
  const body = shade(P.rust, -0.30 + rng() * 0.30);
  b.cyl(body, R, R, H, 11, 0, H * 0.5, 0, 0, 0, 0, true);          // open: it has no lid
  for (const t of [0.26, 0.70]) b.cyl(shade(body, -0.24), R * 1.05, R * 1.05, 0.05, 11, 0, H * t, 0);
  b.cyl(SOOT, R * 0.98, R * 0.98, 0.04, 11, 0, H * 0.30, 0);        // the ash floor
  // the fire: a hot disc at the mouth with two tongues over the rim
  b.cyl(0xffd28a, R * 0.94, R * 0.94, 0.03, 11, 0, H - 0.06, 0);
  b.cone(0xfff0c8, R * 0.62, 0.44, 6, 0, H + 0.18, 0);
  b.cone(0xffb04a, R * 0.34, 0.30, 5, (rng() - 0.5) * 0.2, H + 0.34, (rng() - 0.5) * 0.2);
  // fuel: whatever was burnable, leaning out of the top
  for (let i = 0; i < 3; i++) {
    const a = rng() * 6.283;
    b.tube(shade(P.timber, -0.2 + rng() * 0.2), Math.cos(a) * R * 0.4, H * 0.5, Math.sin(a) * R * 0.4,
      Math.cos(a) * (R + 0.34), H + 0.22, Math.sin(a) * (R + 0.34), 0.045, 4);
  }
  b.slab(SOOT, 1.05, 0.04, 1.05, 0, 0, 0, 0, rng(), 0);            // scorched ground
  return b.done();
}

/**
 * A waymarker totem: a leaning pole with everything anybody ever nailed to
 * it. Hubcaps, a road sign with the writing gone, a tyre, a bleached skull
 * of something, and a rag on top.
 *
 * The only prop here whose job is purely to be LOOKED at rather than
 * driven past — it goes where the road forks or where the alt route
 * rejoins, and it says somebody has been this way and thought it worth
 * marking.
 */
export function totemGeo(P, seed) {
  const rng = makeRNG((seed * 694957) | 1);
  const b = builder();
  const lean = (rng() - 0.5) * 0.22;
  const h = 3.2 + rng() * 1.1;
  const pole = shade(P.timber, -0.14 + rng() * 0.24);
  b.slab(shade(P.dirt, -0.14), 0.9, 0.14, 0.9, 0, 0, 0, 0, rng(), 0);
  b.cyl(pole, 0.09, 0.14, h, 7, Math.sin(lean) * h * 0.5, h * 0.5, 0, 0, 0, lean);
  const at = (t) => [Math.sin(lean) * h * t, h * t, 0];
  // the junk, going up: each piece square to the pole and none of them level
  const p1 = at(0.30);
  b.cyl(shade(P.metal, 0.10), 0.30, 0.30, 0.05, 9, p1[0], p1[1], p1[2], 0.2, rng() * 3, lean + 1.2);
  const p2 = at(0.48);
  b.cyl(TYRE, 0.34, 0.34, 0.22, 9, p2[0], p2[1], p2[2], 0.35, 0, Math.PI / 2 + lean);
  const p3 = at(0.66);
  b.box(shade(P.hazard, -0.30), 0.66, 0.52, 0.05, p3[0], p3[1], p3[2], 0, rng() * 0.6 - 0.3, lean + 0.18);
  const p4 = at(0.80);
  b.cyl(shade(P.paint, 0.08), 0.24, 0.24, 0.05, 8, p4[0], p4[1], p4[2], 0.9, 0, lean);
  // skull: a box and two dark sockets is enough at any range you see this from
  const p5 = at(0.93);
  b.box(shade(P.dead, 0.22), 0.26, 0.24, 0.30, p5[0], p5[1], p5[2], 0.1, 0.4, lean);
  b.box(0x14100e, 0.19, 0.07, 0.05, p5[0], p5[1] + 0.03, p5[2] + 0.16, 0.1, 0.4, lean);
  // the rag, which is the only thing on it that moves in a photograph
  b.plane(shade(P.canvasAlt, -0.10), 0.34, 0.70, at(1)[0], h - 0.30, 0.14, 0.35, 0.9, lean);
  return b.done();
}

/**
 * A billboard with no face left: legs, the lattice that held the panel, two
 * strips of it still hanging on, and a walkway nobody will ever stand on.
 *
 * kit.js's `billboardGeo` is the same structure with a sponsor graphic
 * papered over it by props.js. This is what that becomes, and putting both
 * on THUNDER MESA is the cheapest way the stage says the promoter left.
 */
export function ruinedBillboardGeo(P, seed, w = 8.0, h = 4.2) {
  const rng = makeRNG((seed * 715619) | 1);
  const b = builder();
  const steel = shade(P.rust, -0.20 + rng() * 0.30);
  const stand = 2.8, cy = stand + h * 0.5;
  for (const s of [-1, 1]) {
    b.post(steel, 0.15, stand + h * 0.5, s * w * 0.34, 0, 0, 7);
    b.slab(shade(P.concrete, -0.16), 0.7, 0.20, 0.7, s * w * 0.34, 0, 0);
    b.tube(shade(steel, -0.24), s * w * 0.34, stand + h * 0.34, 0, s * w * 0.34, 0.18, -1.7, 0.06, 4);
  }
  // the frame: two rails and five studs, and that is the whole billboard now
  b.box(steel, w * 1.02, 0.13, 0.22, 0, cy + h * 0.5, -0.08);
  b.box(steel, w * 1.02, 0.13, 0.22, 0, cy - h * 0.5, -0.08);
  for (let i = 0; i < 5; i++) {
    b.box(shade(steel, -0.12), 0.09, h, 0.09, (i - 2) * w * 0.22, cy, -0.16);
  }
  for (let i = 0; i < 3; i++) {
    b.tube(shade(steel, -0.3), -w * 0.5, cy + h * 0.5, -0.08,
      w * 0.5, cy + h * (0.5 - 0.34 * (i + 1) / 3), -0.08, 0.035, 4);
  }
  // two survivors of the face, one of them peeled off at the bottom
  b.plane(shade(P.paint, -0.44), w * 0.30, h * 0.86, -w * 0.30, cy + h * 0.04, 0.02);
  b.plane(shade(P.paint, -0.50), w * 0.20, h * 0.46, w * 0.24, cy + h * 0.20, 0.02, 0.22, 0.10, 0);
  b.slab(shade(P.metal, -0.2), w * 0.94, 0.06, 0.42, 0, cy - h * 0.5 - 0.24, 0.22);   // walkway
  return b.done();
}

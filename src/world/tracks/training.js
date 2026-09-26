/* ============================================================
   PROVING GROUNDS — the tutorial oval
   ------------------------------------------------------------
   Data only: no three, no imports beyond the surface table, so the
   race tests and dev/track-check.mjs can load it under bare Node.

   Design intent: a wide, flat, forgiving bowl with nothing on it that
   can end your run. Half-widths of 10.4-12.1 m are half again what
   the other tracks give you, the tightest corner is 66 m radius (flat
   out in third).

   It is also the syllabus. Every feature type the campaign uses gets
   introduced here once, in the order a driver needs them, with the
   whole bowl as run-off:
     s 150  a boost pad, on its own, on a straight
     s 318  FIRST AIR - a TABLE. Land on the deck, land past it, or
            case it: all three are survivable, which is the only way
            to teach a lip
     s 380  a 1.15 m kicker, no gate (the rhythm idea)
     s 470  THE RIPPLE - whoops, 7 m apart, 0.4 m tall
     s 560  80 m banked 12 deg: the first corner that is faster than
            it looks
     s 700  a second kicker, taken at speed off the banking
     s 760  a pair of pads, one each side, so the line matters
     s 835  FINISH FLYER, unchanged, through the start gantry
   Three laps, matching the other championship stages.
   ============================================================ */
import { SURF } from '../surfaces.js';

export default {
  id: 'training',
  name: 'PROVING GROUNDS',
  tagline: 'Learn the car. Nothing here bites.',
  theme: 'training',
  seed: 4101,
  laps: 3,
  difficulty: 0.25,

  /* Closed loop, racing direction = increasing index. Authored y is the ROAD
     height; terrain.js carves the bowl to meet it. */
  path: [
    { x: 133, z: 0, y: 1.1, w: 12 }, { x: 131.4, z: 37.4, y: 2.8, w: 11.9 }, { x: 127.8, z: 74.7, y: 3.4, w: 11.8 },
    { x: 112.8, z: 108.9, y: 2.4, w: 11.6 }, { x: 87.7, z: 136.4, y: 0.3, w: 11.4 }, { x: 53.4, z: 150.9, y: -2, w: 11.2 },
    { x: 16.1, z: 153, y: -3.7, w: 10.9 }, { x: -19.6, z: 142.3, y: -4, w: 10.6 }, { x: -50.6, z: 121.4, y: -3.2, w: 10.5 },
    { x: -76.4, z: 94.3, y: -1.6, w: 10.4 }, { x: -98.6, z: 64.2, y: -0.1, w: 10.4 }, { x: -116.5, z: 31.2, y: 0.8, w: 10.5 },
    { x: -128, z: -4.4, y: 1.1, w: 10.6 }, { x: -130.2, z: -41.7, y: 0.9, w: 10.7 }, { x: -122.6, z: -78.2, y: 0.6, w: 10.8 },
    { x: -104.8, z: -111.1, y: 0.4, w: 11 }, { x: -77.5, z: -136.4, y: 0.3, w: 11.1 }, { x: -42.8, z: -150.1, y: -0.1, w: 11.2 },
    { x: -5.5, z: -152.3, y: -0.9, w: 11.3 }, { x: 30.5, z: -142.4, y: -2.1, w: 11.4 }, { x: 63.6, z: -124.9, y: -3.2, w: 11.6 },
    { x: 92.4, z: -101, y: -3.6, w: 11.8 }, { x: 116.2, z: -72.2, y: -2.9, w: 12 }, { x: 129.3, z: -37.3, y: -1.1, w: 12.1 }
  ],
  // loop length is 900.0 m

  surfaceDefault: SURF.DIRT,
  paints: [
    // Graded hardpack over the start/finish straight so lap one begins on grip.
    { s0: 840, s1: 105, type: SURF.ROAD },
    // Verges last: lat-limited strips must survive the full-corridor spans above.
    { s0: 0, s1: 899, type: SURF.GRASS, lat0: 14, lat1: 90 },
    { s0: 0, s1: 899, type: SURF.GRASS, lat0: -90, lat1: -14 }
  ],

  jumps: [
    // FIRST AIR is a real table, not a kicker called one: 10 m of flat deck
    // then 8 m of exit ramp, so a first-timer at any speed lands on something.
    { s: 318, len: 18, h: 3.0, kind: 'table', top: 10, down: 8, name: 'FIRST AIR' },
    // No gate: 62 m behind FIRST AIR, a checkpoint here would halve the spacing.
    { s: 380, len: 11, h: 1.15, cp: false },
    /* This was authored as an 18° HIP and is deliberately not one any more.
       A hip biases the racing line 1.2 m sideways across its lip, and both
       ai-check drivers answered that step by running 7.4 m wide through
       s700-725 — 1.54 % of PRO's lap spent past the 7 m gate, against a 1 %
       budget and a 0.50 % baseline. Dropping the yaw did nothing: the line's
       hip aim reads sign(yaw), not its magnitude, so 10° and 18° are the
       same line. Removing the hip took the stage to 0.00 %.

       So the hip lesson moves to where it is allowed to bite: SUNSTRIKE
       CANYON s250, TIMBERLINE s1650 and the ∓20/+20 pair on THUNDER PARK,
       all of which hold the line inside the gate. This is the stage that
       promises nothing here bites, and it keeps that promise with a plain
       kicker off the banking. Do not re-add yaw here without re-running
       ai-check. */
    { s: 700, len: 11, h: 1.6, cp: false },
    { s: 835, len: 20, h: 4.0, name: 'FINISH FLYER' }    // Finish Line Flyer - lands through the start gantry, clear of the grid
  ],

  // THE RIPPLE. 7 m wavelength at 0.4 m is 10.5 texels a crest on the 0.664 m
  // heightfield — the shortest roller this ground can hold and still be felt.
  whoops: [{ s0: 470, s1: 530, wl: 7, amp: 0.4 }],
  // A gentle right-hander; 12 deg of authored bank makes it flat-out.
  banks: [{ s0: 560, s1: 640, deg: 12 }],

  pads: [
    { s: 150 },                                  // the introduction: one pad, straight ahead
    { s: 760, lat: 3 }, { s: 760, lat: -3 }      // now pick a side
  ],

  walls: [{ s0: 820, s1: 140, side: 0 }],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

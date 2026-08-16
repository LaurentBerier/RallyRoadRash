/* ============================================================
   PROVING GROUNDS — the tutorial oval
   ------------------------------------------------------------
   Data only: no three, no imports beyond the surface table, so the
   race tests and dev/track-check.mjs can load it under bare Node.

   Design intent: a wide, flat, forgiving bowl with nothing on it that
   can end your run. Half-widths of 10.4-12.1 m are half again what
   the other tracks give you, the tightest corner is 66 m radius (flat
   out in third). Two small kickers (1.15-1.35 m) teach that landings
   compress the suspension; two bigger set pieces - First Air (s=318,
   a 3 m tabletop) and the Finish Line Flyer (s=835, 4 m, landing
   through the start gantry) - teach real air with nothing around to
   bin it on.
   One lap: this is a shakedown, not a race.
   ============================================================ */
import { SURF } from '../surfaces.js';

export default {
  id: 'training',
  name: 'PROVING GROUNDS',
  tagline: 'Learn the car. Nothing here bites.',
  theme: 'training',
  seed: 4101,
  laps: 1,

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
    { s: 318, len: 18, h: 3.0 },   // First Air - tabletop, ~34 m/s on the open back straight
    { s: 380, len: 11, h: 1.15 },
    { s: 700, len: 11, h: 1.35 },
    { s: 835, len: 20, h: 4.0 }    // Finish Line Flyer - lands through the start gantry, clear of the grid
  ],

  walls: [{ s0: 820, s1: 140, side: 0 }],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

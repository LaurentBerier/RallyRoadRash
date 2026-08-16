/* ============================================================
   TIMBERLINE CLIMB — 58 m up through the pines, then all of it back
   ------------------------------------------------------------
   Data only: no three imports (see tracks/training.js).

   The narrowest track in the game (6.6-8.0 m half-width) and the only
   one where the ground fights you: mud in the valley bottom and again
   through the hairpin, grass everywhere you leave the ruts.

     s    0- 260  wet valley floor, MUD, third gear and patience
     s  350- 750  the climb: 55 m over 400 m, three wooden ramps cut
                  into the switchback shelves
     s  750-1000  the ridge line, dry and fast
     s 1020-1200  the hairpin on the shelf, mud, walls on both sides
     s 1200-1500  the descent — and the ALTERNATE HIGH ROUTE, which
                  stays on the shelf for 275 m against the main line's
                  300 m and pays for it with a 26 % plunge at the end
   ============================================================ */
import { SURF } from '../surfaces.js';

export default {
  id: 'forest',
  name: 'TIMBERLINE CLIMB',
  tagline: 'Mud, pines and a 55 m climb',
  theme: 'forest',
  seed: 8823,
  laps: 3,

  path: [
    { x: 275.4, z: 0, y: 2.5, w: 8 }, { x: 273.1, z: 52.7, y: 4.1, w: 7.9 }, { x: 266.1, z: 105, y: 4.8, w: 7.7 },
    { x: 251.9, z: 155.7, y: 5.7, w: 7.5 }, { x: 225.9, z: 201.5, y: 6.8, w: 7.4 }, { x: 189.5, z: 239.5, y: 8.7, w: 7.3 },
    { x: 144.1, z: 266.2, y: 11.7, w: 7.1 }, { x: 93.4, z: 279.9, y: 16.2, w: 7 }, { x: 40.7, z: 279.3, y: 22.3, w: 6.9 },
    { x: -10.2, z: 265.9, y: 29.7, w: 6.8 }, { x: -57.2, z: 242, y: 37.8, w: 6.7 }, { x: -101.2, z: 212.9, y: 45.5, w: 6.6 },
    { x: -144.9, z: 183.3, y: 52, w: 6.6 }, { x: -188.2, z: 153.1, y: 56.4, w: 6.6 }, { x: -228.5, z: 119.2, y: 58.1, w: 6.7 },
    { x: -262.8, z: 79.2, y: 57.2, w: 6.9 }, { x: -286.3, z: 32, y: 54.8, w: 7.1 }, { x: -297.2, z: -19.5, y: 52.5, w: 7.2 },
    { x: -293.6, z: -71.9, y: 50.9, w: 7.2 }, { x: -274.5, z: -120.9, y: 50.5, w: 7 }, { x: -237.6, z: -157.6, y: 50.8, w: 6.8 },
    { x: -186.7, z: -169, y: 50.5, w: 6.7 }, { x: -134.2, z: -169.9, y: 49.3, w: 6.6 }, { x: -91.3, z: -199.3, y: 46.9, w: 6.6 },
    { x: -56.2, z: -238.7, y: 42.8, w: 6.7 }, { x: -12.8, z: -268.4, y: 36.8, w: 6.8 }, { x: 36.9, z: -285.7, y: 29.4, w: 7 },
    { x: 89.4, z: -288, y: 21.2, w: 7.1 }, { x: 139.7, z: -272.8, y: 13, w: 7.3 }, { x: 182.1, z: -241.8, y: 6, w: 7.4 },
    { x: 214.6, z: -200.4, y: 0.9, w: 7.6 }, { x: 238, z: -153.1, y: -1.7, w: 7.8 }, { x: 255.7, z: -103.4, y: -1.8, w: 7.9 },
    { x: 268.9, z: -52.3, y: 0.2, w: 8 }
  ],
  // loop length is 1800.0 m

  surfaceDefault: SURF.DIRT,
  paints: [
    { s0: 1620, s1: 260, type: SURF.MUD },       // valley bottom, wraps past the line
    { s0: 1020, s1: 1200, type: SURF.MUD },      // the shelf hairpin never dries out
    { s0: 560, s1: 700, type: SURF.ROCK },       // scree shelf on the steep part
    { s0: 0, s1: 1799, type: SURF.GRASS, lat0: 10, lat1: 90 },
    { s0: 0, s1: 1799, type: SURF.GRASS, lat0: -90, lat1: -10 },
    { x: -230, z: -158, r: 30, type: SURF.MUD }  // the wallow at the hairpin exit
  ],

  /* Wooden ramps: props.js drops a plank deck and side rails on each lip, the
     terrain carves the earth bank under it. */
  jumps: [
    { s: 500, len: 14, h: 2.6 },                 // rhythm double 1/2 (was the lone s~525 kicker)
    { s: 570, len: 14, h: 2.6 },                 // rhythm double 2/2, 70 m on
    { s: 815, len: 18, h: 3.8, gap: 18 },        // Gully Gap - dry ridge line, ~21.7 m/s to clear
    { s: 1100, len: 12, h: 1.8 },
    { s: 1650, len: 13, h: 2.1 }
  ],

  /* The high route. 275 m of shelf against 300 m of main line, and it holds its
     altitude to the last moment — so it is faster only if you can take the drop
     back onto the road without landing on the nose. */
  shortcut: {
    s0: 1200, s1: 1500,
    path: [
      { x: -103.6, z: -188.6, y: 47.8, w: 6.5 }, { x: -72.6, z: -197.3, y: 47.1, w: 6.5 }, { x: -44.9, z: -210, y: 47.3, w: 6.5 },
      { x: -22.3, z: -215.8, y: 47.8, w: 6.5 }, { x: -0.1, z: -221.4, y: 47.5, w: 6.5 }, { x: 19.9, z: -226.8, y: 45.7, w: 6.5 },
      { x: 38.6, z: -233.3, y: 41.9, w: 6.5 }, { x: 57.1, z: -241, y: 36.2, w: 6.5 }, { x: 76.8, z: -249.7, y: 29.2, w: 6.5 },
      { x: 98.9, z: -257.8, y: 21.8, w: 6.5 }, { x: 125.3, z: -263.3, y: 15.3, w: 6.5 }, { x: 154.7, z: -264.1, y: 10.5, w: 6.5 }
    ]
  },

  walls: [
    { s0: 1000, s1: 1210, side: 0 },             // the shelf hairpin
    { s0: 560, s1: 700, side: -1 },              // outside of the climb: long way down
    { s0: 1250, s1: 1420, side: -1 }
  ],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

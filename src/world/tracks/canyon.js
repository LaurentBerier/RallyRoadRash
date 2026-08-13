/* ============================================================
   SUNSTRIKE CANYON — desert wash, red rock, one enormous gap
   ------------------------------------------------------------
   Data only: no three imports (see tracks/training.js).

   The lap in three acts:
     s    0- 500  fast open sweepers along the mesa flank, sand over
                  hardpack, nothing to hit
     s  560- 740  THE GAP. A 15 m void carved across a rising straight
                  behind a 2.2 m kicker. Ballistics say ~21 m/s clears
                  it, so it is free at racing speed and fatal at a
                  crawl. The `shortcut` is the way round: a slot canyon
                  that costs ~33 m of extra road and two blind corners.
     s 1120-1310  the hairpin, 31 m radius, bare rock between walls
   Three more kickers pace the rest of the lap.
   ============================================================ */
import { SURF } from '../surfaces.js';

export default {
  id: 'canyon',
  name: 'SUNSTRIKE CANYON',
  tagline: 'Gap jumps over red rock',
  theme: 'canyon',
  seed: 1207,
  laps: 3,

  path: [
    { x: 233.4, z: 0, y: 4.3, w: 10 }, { x: 229.1, z: 49.8, y: 9.5, w: 9.8 }, { x: 222.5, z: 99.4, y: 13.4, w: 9.5 },
    { x: 208.7, z: 147.4, y: 15.2, w: 9.1 }, { x: 186, z: 191.8, y: 14.8, w: 8.9 }, { x: 152.5, z: 228.8, y: 12.3, w: 8.6 },
    { x: 111.1, z: 256.7, y: 8.4, w: 8.4 }, { x: 63.5, z: 271.5, y: 4.4, w: 8.2 }, { x: 13.6, z: 271.3, y: 1.3, w: 8 },
    { x: -34.3, z: 257.6, y: -0.2, w: 8 }, { x: -76.5, z: 231, y: 0.4, w: 8.1 }, { x: -112.6, z: 196.4, y: 2.6, w: 8.2 },
    { x: -143.8, z: 157.3, y: 5.7, w: 8.4 }, { x: -173.4, z: 117, y: 8.6, w: 8.6 }, { x: -202.5, z: 76.3, y: 10.4, w: 8.9 },
    { x: -225.9, z: 32.1, y: 10.2, w: 9.2 }, { x: -241.5, z: -15.3, y: 8.2, w: 9.4 }, { x: -247.2, z: -65, y: 4.5, w: 9.5 },
    { x: -241.8, z: -114.6, y: -0.1, w: 9.4 }, { x: -225.5, z: -161.8, y: -4.6, w: 9 }, { x: -196.2, z: -202.1, y: -8.4, w: 8.5 },
    { x: -155.8, z: -231.2, y: -11.2, w: 7.9 }, { x: -107.8, z: -235.4, y: -12.8, w: 7.6 }, { x: -66.7, z: -207.5, y: -13.5, w: 7.5 },
    { x: -31.8, z: -171.6, y: -13.7, w: 7.5 }, { x: 13.9, z: -165.8, y: -13.8, w: 7.8 }, { x: 59.2, z: -187, y: -13.7, w: 8.2 },
    { x: 108.4, z: -193.1, y: -13.3, w: 8.5 }, { x: 155.5, z: -177.7, y: -12.1, w: 8.8 }, { x: 191, z: -143, y: -9.7, w: 9.1 },
    { x: 211.6, z: -97.5, y: -6, w: 9.4 }, { x: 224.4, z: -49.2, y: -1.1, w: 9.8 }
  ],
  // loop length is 1600.0 m

  surfaceDefault: SURF.SAND,
  paints: [
    { s0: 1520, s1: 140, type: SURF.DIRT },      // graded hardpack past the pits
    { s0: 560, s1: 745, type: SURF.ROCK },       // the slab the gap is cut into
    { s0: 1120, s1: 1300, type: SURF.ROCK },     // hairpin, scrubbed to bedrock
    // Blown-out rock shelves either side of the wash. Lat-limited, so they lie
    // on top of the spans above instead of replacing them.
    { s0: 0, s1: 1599, type: SURF.ROCK, lat0: 13, lat1: 90 },
    { s0: 0, s1: 1599, type: SURF.ROCK, lat0: -90, lat1: -13 },
    // Two sand drifts that have blown right across the racing line.
    { x: 63, z: 271, r: 34, type: SURF.SAND },
    { x: -240, z: -115, r: 40, type: SURF.SAND }
  ],

  jumps: [
    { s: 250, len: 12, h: 1.6 },
    { s: 630, len: 16, h: 2.2, gap: 15 },        // ~21 m/s to clear; see header
    { s: 880, len: 13, h: 1.9 },
    { s: 1330, len: 12, h: 1.7 }
  ],

  /* The slot canyon. Leaves the main line 70 m before the kicker and rejoins
     10 m past the landing, so a racer who bottles the gap has somewhere to go
     and still passes a checkpoint with the same idx. */
  shortcut: {
    s0: 560, s1: 735,
    path: [
      { x: -118.3, z: 189.9, y: 3.1, w: 6.5 }, { x: -141, z: 185.4, y: 4.2, w: 6.5 }, { x: -162.3, z: 179.5, y: 5.3, w: 6.5 },
      { x: -181.5, z: 171.8, y: 6.4, w: 6.5 }, { x: -197.7, z: 161.3, y: 7.4, w: 6.5 }, { x: -209.9, z: 148.4, y: 8.4, w: 6.5 },
      { x: -217.9, z: 133.6, y: 9.2, w: 6.5 }, { x: -223.3, z: 114.9, y: 9.9, w: 6.5 }, { x: -225.5, z: 92.8, y: 10.4, w: 6.5 },
      { x: -223.5, z: 70, y: 10.5, w: 6.5 }, { x: -218.8, z: 47.3, y: 10.5, w: 6.5 }
    ]
  },

  walls: [
    { s0: 1120, s1: 1310, side: 0 },             // hairpin, both sides
    { s0: 300, s1: 420, side: 1 }                // the drop into the wash
  ],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

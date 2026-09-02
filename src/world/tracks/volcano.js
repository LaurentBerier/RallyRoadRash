/* ============================================================
   CALDERA RUN — around the rim, down into it, and out
   ------------------------------------------------------------
   Data only: no three imports (see tracks/training.js).

   64 m of vertical between the rim at s=500 (+31.5 m) and the caldera
   floor at s=1125 (-32.9 m). CALDERA LEAP (s=575, firing down the
   descent) is the biggest jump in the game: a 5.0 m lip off a 22 m
   ramp clearing a 24 m gap onto a falling straight, chaining into the
   fissure jump 150 m later. The rest of the kickers are 2.2-4.2 m
   lips off 14-18 m ramps.

     s   90- 150  opener hop on the climbing rim bend (no gap - the
                  corner cannot host a long flight)
     s  380- 560  lava runs in a channel to the LEFT of the line, close
                  enough to light the bodywork
     s  550- 770  THE DESCENT DOUBLE: Caldera Leap fires you onto the
                  falling straight, then the fissure launches you over
                  20 m of lava. The signature run of the campaign.
     s  900-1080  a second lava channel, this one on the right
     s 1150-1360  the floor hairpin, 23 m radius, walls both sides
     s 1720-1900  the climb back out, one last big jump on the rim road
   ============================================================ */
import { SURF } from '../surfaces.js';

export default {
  id: 'volcano',
  name: 'CALDERA RUN',
  tagline: 'Big air over a live vent',
  theme: 'volcano',
  seed: 3316,
  laps: 3,

  path: [
    { x: 293.7, z: 0, y: -5.2, w: 9 }, { x: 291.2, z: 55.4, y: 2.5, w: 10 }, { x: 284.6, z: 110.4, y: 10, w: 11 },
    { x: 270.6, z: 163.9, y: 16.6, w: 10 }, { x: 247.2, z: 214.1, y: 21.8, w: 8.4 }, { x: 212.9, z: 257.4, y: 25.6, w: 8.2 },
    { x: 168.9, z: 290.8, y: 28.2, w: 8.1 }, { x: 117.6, z: 311.2, y: 29.9, w: 7.9 }, { x: 62.5, z: 316.1, y: 31, w: 7.8 },
    { x: 8, z: 307.4, y: 31.5, w: 9 }, { x: -42.8, z: 285.3, y: 31.2, w: 10 }, { x: -87.7, z: 253, y: 29.7, w: 10 },
    { x: -130.5, z: 217.8, y: 26.5, w: 7.2 }, { x: -175.7, z: 185.8, y: 21.2, w: 7.2 }, { x: -221.3, z: 154.3, y: 13.6, w: 7.2 },
    { x: -263.2, z: 118.1, y: 4.3, w: 7.4 }, { x: -296.1, z: 73.7, y: -6.1, w: 7.6 }, { x: -318.1, z: 23, y: -16.2, w: 7.9 },
    { x: -328.4, z: -31.3, y: -24.8, w: 8 }, { x: -322.6, z: -86.2, y: -30.6, w: 8 }, { x: -299.4, z: -136.1, y: -32.9, w: 7.8 },
    { x: -253.7, z: -164.8, y: -31.6, w: 7.5 }, { x: -198.7, z: -162.4, y: -27, w: 7.3 }, { x: -145.3, z: -147.5, y: -20.4, w: 7.2 },
    { x: -97.6, z: -161.6, y: -13.2, w: 7.3 }, { x: -77.8, z: -213.3, y: -6.9, w: 7.5 }, { x: -45.2, z: -258, y: -2.8, w: 7.7 },
    { x: 0, z: -289.6, y: -1.5, w: 8 }, { x: 52.6, z: -306.2, y: -3, w: 8.2 }, { x: 107.8, z: -306, y: -6.8, w: 8.3 },
    { x: 160, z: -287.9, y: -11.5, w: 8.5 }, { x: 204.8, z: -255.7, y: -16, w: 8.6 }, { x: 238.2, z: -211.6, y: -18.9, w: 8.7 },
    { x: 263.5, z: -162.4, y: -19.3, w: 8.8 }, { x: 280.5, z: -109.7, y: -16.9, w: 8.9 }, { x: 291.1, z: -55.3, y: -12, w: 9 }
  ],
  // loop length is 2000.0 m

  surfaceDefault: SURF.ROCK,
  paints: [
    { s0: 1400, s1: 1700, type: SURF.DIRT },     // ash fan on the floor
    { s0: 1150, s1: 1360, type: SURF.DIRT },     // hairpin, churned to cinder
    // Live channels alongside the racing line. Lat-limited so they light the
    // verge without paving the road — brush one and you lose grip and paint.
    { s0: 380, s1: 560, type: SURF.LAVA, lat0: 11, lat1: 30 },
    { s0: 900, s1: 1080, type: SURF.LAVA, lat0: -32, lat1: -12 },
    // The fissure the second kicker clears. Full width, inside the carved void.
    { s0: 744, s1: 767, type: SURF.LAVA, lat0: -22, lat1: 22 },
    // Caldera Leap void - same hazard-floor pattern as the fissure above.
    { s0: 574, s1: 601, type: SURF.LAVA, lat0: -22, lat1: 22 },
    { x: -300, z: -136, r: 26, type: SURF.ROCK }
  ],

  jumps: [
    { s: 110, len: 14, h: 2.2 },                 // opener hop - the rim road bends away and climbs
                                                 //   here, so no gap: QA watched a whole field
                                                 //   overfly the corner and grind on recovery
    { s: 255, len: 14, h: 2.8 },
    { s: 575, len: 22, h: 5.0, gap: 24, name: 'CALDERA LEAP' },  // CALDERA LEAP - biggest jump in the game, fired
                                                 //   onto the falling descent straight (5 deg of
                                                 //   bend, -10 m over the flight): the ground drops
                                                 //   with the arc, so even a flat-out overfly meets
                                                 //   road - or the fissure's own up-ramp. ~23 m/s
                                                 //   to clear; chains into the fissure below
    { s: 745, len: 18, h: 4.2, gap: 20, name: 'THE FISSURE' },  // fissure - back half of the descent double, ~21.8 m/s to clear
    { s: 1795, len: 15, h: 3.3, name: 'RIM ROAD' }
  ],

  walls: [
    { s0: 1150, s1: 1360, side: 0 },             // floor hairpin
    { s0: 950, s1: 1100, side: 1 },              // keeps you off the left-hand channel
    { s0: 380, s1: 560, side: 1 }
  ],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

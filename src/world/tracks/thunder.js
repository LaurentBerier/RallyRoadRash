/* ============================================================
   THUNDER PARK — the bonus stunt stage
   ------------------------------------------------------------
   Data only: no three imports (see tracks/training.js).

   Not a rally stage. A purpose-built stunt park on a graded pad,
   two laps, and the one place in the game where AIR TIME is the
   point rather than the price of a corner. It is `bonus: true`,
   so it sits outside TRACK_ORDER and is earned with a SUNSTRIKE
   CANYON podium — progression wiring is P6's.

   The lap, in five acts:
     s    0- 370  the run: THUNDER STEP (a 20 m table you can land
                  ON) then SKY HOOK, the hero jump, launched off a
                  +6 m plateau on to ground that falls away — ~60 m
                  of flight at racing speed, which is the whole
                  reason to come here
     s  370- 496  THE BOWL. A 40 m-radius 180 banked at 24 deg with
                  tyre walls round the outside; the HIGH LINE peels
                  off the exit and runs the rim
     s  496- 715  THE WASHBOARD (whoops) into the first of the TWIN
                  HIPS — diagonal lips, 20 deg apart, that throw the
                  car in opposite directions 70 m apart
     s  715- 985  THE CANYON DROP off a 4 m shelf on to 60 m of
                  falling straight, pads, then BIG GAP: 28 m of void
                  behind a 3.6 m kicker, ~27 m/s to clear it
     s  985-1400  the banked far sweeper and THUNDER FLYER through
                  the gantry on to the start/finish straight

   Plan geometry is a closed turtle walk (straights and arcs) so the
   bowl really is 40 m radius rather than whatever a hand-placed
   control point produced; the lap closes to 1400.0 m by construction.
   ============================================================ */
import { SURF } from '../surfaces.js';

/* The HIGH LINE. Authored as an offset of the main line over the bowl exit, so
   both ends meet the road tangentially instead of T-boning it. It skips THE
   WASHBOARD, costs ~20 m of extra road, and pays it back only if you can take
   the drop off the rim at the end without landing on the nose. Its `jumps` are
   in the ROUTE's own arc length, and route jumps are always cp:false. */
const HIGH_LINE = {
  id: 'highline', name: 'HIGH LINE', s0: 500, s1: 655, aiBias: 0.5,
  path: [
    { x: -80.1, z: 366, y: 0, w: 6.5 }, { x: -84.5, z: 353.1, y: 1, w: 6.5 },
    { x: -91, z: 340.2, y: 2.3, w: 6.5 }, { x: -97.5, z: 327.3, y: 3.4, w: 6.5 },
    { x: -103.1, z: 314.4, y: 4.2, w: 6.5 }, { x: -106.7, z: 301.5, y: 4.8, w: 6.5 },
    { x: -108, z: 288.6, y: 5, w: 6.5 }, { x: -106.7, z: 275.6, y: 4.7, w: 6.5 },
    { x: -103, z: 262.6, y: 3.9, w: 6.5 }, { x: -97.4, z: 249.6, y: 2.7, w: 6.5 },
    { x: -90.8, z: 237, y: 1.3, w: 6.5 }, { x: -84.7, z: 224.1, y: 0, w: 6.5 },
    { x: -80.6, z: 211.1, y: -0.6, w: 6.5 }
  ],
  /* Route arc length, not the main line's. The bow is deliberately shallow —
     28 m over 155 — because a ledge has to fly over ground that is not turning,
     and a tighter rim would bend harder than the 80 m radius the siting rule
     allows anywhere along it. */
  jumps: [{ s: 105, len: 10, h: 2.6, kind: 'drop', name: 'RIM DROP' }]
};

export default {
  id: 'thunder',
  name: 'THUNDER PARK',
  tagline: 'Two laps. All air.',
  theme: 'thunder',
  seed: 5507,
  laps: 2,
  bonus: true,
  difficulty: 0.55,

  path: [
    { x: 0, z: 0, y: 0, w: 11 }, { x: 0, z: 38, y: 0.5, w: 11 }, { x: 0, z: 76, y: 1.4, w: 10.8 },
    { x: 0, z: 114, y: 2.1, w: 10.7 }, { x: 0, z: 152, y: 2.9, w: 10.6 }, { x: 0, z: 190, y: 5.3, w: 10.5 },
    { x: 0, z: 228, y: 6, w: 10.4 }, { x: 0, z: 266, y: 6, w: 10.2 }, { x: 0, z: 304, y: 1.6, w: 10.1 },
    { x: 0, z: 342, y: 0.6, w: 10 }, { x: -1.2, z: 379.9, y: 0.2, w: 9.5 }, { x: -6.4, z: 391.8, y: 0.2, w: 9.4 },
    { x: -15.1, z: 401.3, y: 0.2, w: 9.4 }, { x: -26.4, z: 407.6, y: 0.1, w: 9.4 }, { x: -39.2, z: 410, y: 0.1, w: 9.4 },
    { x: -52, z: 408.2, y: 0.1, w: 9.4 }, { x: -63.5, z: 402.3, y: 0.1, w: 9.4 }, { x: -72.6, z: 393.1, y: 0, w: 9.4 },
    { x: -78.3, z: 381.5, y: 0, w: 9.4 }, { x: -80, z: 368.7, y: 0, w: 9.4 }, { x: -80, z: 355.7, y: 0, w: 9.4 },
    { x: -80, z: 342.7, y: 0, w: 9.5 }, { x: -80, z: 304.7, y: -0.9, w: 9.7 }, { x: -80, z: 266.7, y: -1, w: 10 },
    { x: -80, z: 228.7, y: -1, w: 10 }, { x: -82.7, z: 190.8, y: 0, w: 10 }, { x: -94.1, z: 154.7, y: 1.2, w: 10 },
    { x: -110.2, z: 120.2, y: 3.5, w: 10 }, { x: -126.2, z: 85.8, y: 6, w: 10.1 }, { x: -142.3, z: 51.4, y: 6.5, w: 10.3 },
    { x: -158.4, z: 16.9, y: 2.1, w: 10.5 }, { x: -174.4, z: -17.5, y: 0.5, w: 10.5 }, { x: -190.5, z: -52, y: 0.1, w: 10.5 },
    { x: -206.5, z: -86.4, y: 0, w: 10.5 }, { x: -215.6, z: -122.9, y: 0, w: 10.4 }, { x: -205.2, z: -159, y: 0.4, w: 9.9 },
    { x: -178, z: -184.9, y: 2.6, w: 9.5 }, { x: -141.4, z: -193.4, y: 3.3, w: 9.6 }, { x: -105.6, z: -182.3, y: 3.9, w: 9.9 },
    { x: -74.4, z: -160.6, y: 3.8, w: 10 }, { x: -43.3, z: -138.8, y: 2.8, w: 10.2 }, { x: -14.9, z: -113.8, y: 2.3, w: 10.5 },
    { x: -0.8, z: -79, y: 1.6, w: 10.6 }, { x: 0, z: -41, y: 0.6, w: 10.8 }
  ],
  // loop length is 1400.0 m

  surfaceDefault: SURF.DIRT,
  paints: [
    // The rock shelf the drop and the gap are cut into.
    { s0: 800, s1: 1000, type: SURF.ROCK },
    // Blown sand off the pad, banked against both verges.
    { s0: 0, s1: 1399, type: SURF.SAND, lat0: 12, lat1: 90 },
    { s0: 0, s1: 1399, type: SURF.SAND, lat0: -90, lat1: -12 }
  ],

  /* Every lip here is a set piece; there are no filler kickers. `top`/`down`
     turn THUNDER STEP into a deck you can land on at any speed, which is what
     makes it the tutorial for the rest of the park. */
  jumps: [
    { s: 140, len: 18, h: 3.0, kind: 'table', top: 20, down: 25, name: 'THUNDER STEP' },
    { s: 260, len: 24, h: 5.5, name: 'SKY HOOK' },
    /* TWIN HIPS: opposite lip angles 70 m apart. cp:false — two gates that
       close would put the checkpoint spacing under the 40 m floor. The first
       moved 660 -> 680 so its ramp foot clears the HIGH LINE's merge at 655. */
    { s: 680, len: 14, h: 2.8, kind: 'hip', yaw: -20, cp: false },
    { s: 750, len: 14, h: 2.8, kind: 'hip', yaw: 20, cp: false },
    { s: 820, len: 12, h: 4.0, kind: 'drop', name: 'THE CANYON DROP' },
    { s: 940, len: 20, h: 3.6, gap: 28, name: 'BIG GAP' },
    { s: 1220, len: 22, h: 4.8, name: 'THUNDER FLYER' }
  ],

  banks: [
    { s0: 380, s1: 470, deg: 24 },      // THE BOWL
    { s0: 1050, s1: 1150, deg: 18 }     // the far sweeper
  ],
  whoops: [{ s0: 520, s1: 600, wl: 8, amp: 0.5 }],   // THE WASHBOARD

  pads: [
    { s: 60, lat: 3 }, { s: 60, lat: -3 },           // off the line
    { s: 900, lat: 3 }, { s: 900, lat: -3 }          // 40 m before BIG GAP
  ],

  routes: [HIGH_LINE],
  /* Alias for the fourteen consumers that still read `def.shortcut`
     (docs/ARCHITECTURE.md §6.1). Same object, not a copy. */
  shortcut: HIGH_LINE,

  walls: [
    { s0: 370, s1: 500, side: -1 },     // tyre walls round the outside of the bowl
    { s0: 780, s1: 900, side: 0 }       // the drop approach, both sides
  ],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

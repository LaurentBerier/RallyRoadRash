/* ============================================================
   TIMBERLINE CLIMB — 58 m up through the pines, then all of it back
   ------------------------------------------------------------
   Data only: no three imports (see tracks/training.js).

   The narrowest track in the game (6.6-8.0 m half-width) and the only
   one where the ground fights you: mud in the valley bottom and again
   through the hairpin, grass everywhere you leave the ruts.

     s    0- 260  wet valley floor, MUD, third gear and patience —
                  with THE CORDUROY (whoops, 120-190) in the worst of
                  it, where the ruts have set hard
     s  350- 750  the climb: 55 m over 400 m on a SHELF cut into the
                  mountainside — rock wall outboard, the valley falling
                  away inboard — with a table and 60 m of 14 deg bank
     s  750-1000  the ridge line, dry and fast, still on the shelf:
                  GULLY GAP at 815, then THE STEP, a 25 m deck
     s 1020-1200  the hairpin on the shelf, mud, walls both sides and a
                  2 m berm round the outside of each half of it
     s 1200-1500  the descent — THE PLUNGE at 1280 and the ALTERNATE
                  HIGH ROUTE, which stays on the shelf for 275 m
                  against the main line's 300 m and pays for it with a
                  2.5 m ledge at the end
   ============================================================ */
import { SURF } from '../surfaces.js';

/* The high route. 275 m of shelf against 300 m of main line, and it holds its
   altitude to the last moment — so it is faster only if you can take the drop
   back onto the road without landing on the nose. Its jump is in the ROUTE's
   own arc length, and route jumps are always cp:false. */
const HIGH_ROUTE = {
  id: 'highroute', name: 'HIGH ROUTE', s0: 1200, s1: 1500, aiBias: 0.35,
  path: [
    { x: -103.6, z: -188.6, y: 47.8, w: 6.5 }, { x: -72.6, z: -197.3, y: 47.1, w: 6.5 }, { x: -44.9, z: -210, y: 47.3, w: 6.5 },
    { x: -22.3, z: -215.8, y: 47.8, w: 6.5 }, { x: -0.1, z: -221.4, y: 47.5, w: 6.5 }, { x: 19.9, z: -226.8, y: 45.7, w: 6.5 },
    { x: 38.6, z: -233.3, y: 41.9, w: 6.5 }, { x: 57.1, z: -241, y: 36.2, w: 6.5 }, { x: 76.8, z: -249.7, y: 29.2, w: 6.5 },
    { x: 98.9, z: -257.8, y: 21.8, w: 6.5 }, { x: 125.3, z: -263.3, y: 15.3, w: 6.5 }, { x: 154.7, z: -264.1, y: 10.5, w: 6.5 }
  ],
  jumps: [{ s: 240, len: 6, h: 2.5, kind: 'drop', name: 'SHELF END' }]
};

export default {
  id: 'forest',
  name: 'TIMBERLINE CLIMB',
  tagline: 'Mud, pines and a 55 m climb',
  theme: 'forest',
  seed: 8823,
  laps: 3,
  difficulty: 0.65,

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
    // A table on the steepest part of the climb — 8 m of deck so a car that
    // arrives slow in the mud still gets over it. No gate: GULLY GAP has one.
    { s: 570, len: 14, h: 2.8, kind: 'table', top: 8, down: 7, cp: false },
    { s: 815, len: 18, h: 4.2, gap: 20, name: 'GULLY GAP' },  // Gully Gap - dry ridge line, ~22.5 m/s to clear
    // THE STEP: 14 m of ramp, 25 m of deck, 30 m of exit ramp. Not a jump so
    // much as a ridge you drive over — and land on, if you got the gap wrong.
    { s: 940, len: 14, h: 1.6, kind: 'table', top: 25, down: 30, name: 'THE STEP' },
    // THE PLUNGE. The descent is already falling at 11 %; the ledge just takes
    // the last 3 m of it away. No gate — the landing is nowhere near the road.
    { s: 1280, len: 10, h: 3.0, kind: 'drop', cp: false, name: 'THE PLUNGE' },
    { s: 1650, len: 13, h: 2.4, kind: 'hip', yaw: 14 }
  ],

  // THE CORDUROY: set ruts in the valley mud, 6.5 m apart.
  whoops: [{ s0: 120, s1: 190, wl: 6.5, amp: 0.35 }],
  // A canted shelf on the climb. The corner is nearly straight here; the camber
  // is the mountain's, not a racing line's.
  banks: [{ s0: 640, s1: 700, deg: 14 }],
  /* The climb and the ridge are CUT INTO the mountainside — rock wall on the
     outside of the loop, the valley falling away on the inside — rather than
     being propped up on an embankment. Before this the stage read as "a high
     road sticking out of the ground", and it measured that way too: 63 m above
     its own base terrain with ground falling away on BOTH sides for 68 % of the
     lap, which is also where most of the falls came from.

     The theme base now supplies a real mountain (see THEME_BASE.forest), and
     these two spans say which side of the road it stands on — a height field
     cannot know that, so it is authored, exactly like a bank or a berm.

     `side: 1` is OUTBOARD: positive lateral is away from the centre of the
     loop, which through the climb and along the ridge is also the uphill side.
     The ridge gets the deeper `fall` because that is where the view is. */
  shelves: [
    { s0: 340, s1: 770, side: 1, rise: 26, fall: 20 },
    { s0: 770, s1: 1015, side: 1, rise: 22, fall: 26 }
  ],
  /* The hairpin berm, in two pieces because the corner reverses at s~1135: one
     wall on the outside of the right-hand sweeper, one on the outside of the
     left-hand hairpin. A single 1030-1180 span would have put 2 m of earth on
     the INSIDE of half of it. */
  berms: [
    { s0: 1030, s1: 1125, side: 1, h: 2.0 },
    { s0: 1140, s1: 1180, side: -1, h: 2.0 }
  ],

  pads: [
    { s: 260 },                                  // out of the valley mud
    { s: 760 },                                  // 30 m before GULLY GAP's ramp
    { s: 1560, lat: 2.5 }, { s: 1560, lat: -2.5 } // the run home
  ],

  routes: [HIGH_ROUTE],
  /* Alias for the fourteen consumers that still read `def.shortcut`
     (docs/ARCHITECTURE.md §6.1). Same object, not a copy. */
  shortcut: HIGH_ROUTE,

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

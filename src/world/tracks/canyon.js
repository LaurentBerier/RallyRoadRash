/* ============================================================
   SUNSTRIKE CANYON — desert wash, red rock, one enormous gap
   ------------------------------------------------------------
   Data only: no three imports (see tracks/training.js).

   ELEVATION. The front half of the lap (s 0-900) runs ON the wash floor:
   every control point sits ~0.5 m above the canyon theme's base noise, so the
   terrain bake has nothing to lift. It used to be authored 10-19 m higher, and
   because the bake resolves a road above the base by raising terrain INTO an
   embankment, that turned the whole front half into a causeway with 49 deg
   drop-offs 13 m off the centreline and no walls to catch you -- the #1 reset
   site on the campaign. The one place the road still stands proud of the floor
   is s 490-610, ~5.4 m over a natural hollow: that embankment IS the slab THE
   GAP is cut into, and the gap's ballistics need it level. The back half
   (s 950-1550) is CUT INTO the mesas -- road below base -- which is the canyon
   look and stays as drawn. dev/track-check.mjs gates the raise.

   The lap in four acts:
     s    0- 300  MESA LAUNCHER off the opening straight at 40+ m/s,
                  then a hip that turns you into the top sweeper
     s  300- 470  the MESA TOP route peels off here and cuts a slot through
                  the hoodoo, paying for the line with a step back down
     s  452- 500  THE SHELF: 2.5 m of ledge that simply stops
     s  560- 740  THE GAP. A 24 m void carved across the straight
                  behind a 3.2 m kicker. Ballistics say ~26 m/s clears
                  it, so it is free at racing speed and fatal at a
                  crawl. The slot-canyon route is the way round: ~33 m
                  of extra road and two blind corners.
     s 1000-1280  the washboard into the hairpin — 31 m radius, banked
                  20 deg with a 2.2 m berm round the outside, which
                  turns the slowest corner on the stage into the one
                  worth carrying speed into
   ============================================================ */
import { SURF } from '../surfaces.js';

/* THE SLOT. Leaves the main line 70 m before THE GAP's kicker and rejoins 10 m
   past the landing, so a racer who bottles the gap has somewhere to go and
   still passes a checkpoint with the same idx. It drops off the gap slab into
   the hollow the gap is cut through and climbs back to the road at s1 — both
   ends meet the main line within 0.05 m. */
const SLOT = {
  id: 'slot', name: 'THE SLOT', s0: 560, s1: 735, aiBias: 0.35,
  path: [
    { x: -118.3, z: 189.9, y: -3.2, w: 6.5 }, { x: -141, z: 185.4, y: -3.8, w: 6.5 }, { x: -162.3, z: 179.5, y: -4.3, w: 6.5 },
    { x: -181.5, z: 171.8, y: -4.6, w: 6.5 }, { x: -197.7, z: 161.3, y: -4.7, w: 6.5 }, { x: -209.9, z: 148.4, y: -4.4, w: 6.5 },
    { x: -217.9, z: 133.6, y: -4.1, w: 6.5 }, { x: -223.3, z: 114.9, y: -3.9, w: 6.5 }, { x: -225.5, z: 92.8, y: -3.4, w: 6.5 },
    { x: -223.5, z: 70, y: -2.8, w: 6.5 }, { x: -218.8, z: 47.3, y: -2.3, w: 6.5 }
  ]
};

/* MESA TOP. A slot line through the hoodoo, then a step back down: 23 m longer
   than the road it replaces and it ends in a drop, so it is never the safe
   choice — it is the stunt line, and the AI is told as much through a low
   aiBias. Points 1-2 run BELOW the hoodoo's base noise, so the bake carves them
   into a slot. Its `jumps` are in the ROUTE's own arc length. */
const MESA_TOP = {
  id: 'mesatop', name: 'MESA TOP', s0: 300, s1: 470, aiBias: 0.15,
  path: [
    { x: 111.9, z: 256.3, y: -2.3, w: 6.5 }, { x: 96.6, z: 269.4, y: -1.6, w: 6.5 },
    { x: 79.8, z: 282.9, y: -0.4, w: 6.5 }, { x: 60.3, z: 293.5, y: 0.8, w: 6.5 },
    { x: 39, z: 298.7, y: 1.2, w: 6.5 }, { x: 17.6, z: 297.5, y: 0.6, w: 6.5 },
    { x: -2.7, z: 290.2, y: -0.8, w: 6.5 }, { x: -20.9, z: 278, y: -2.0, w: 6.5 },
    { x: -36.7, z: 263.2, y: -2.8, w: 6.5 }, { x: -50.9, z: 248.9, y: -2.7, w: 6.5 }
  ],
  /* Route arc length, not the main line's. Sited at 150 of 194: any earlier and
     the ledge would fire the car over the bench's own curve back to the road. */
  jumps: [{ s: 150, len: 8, h: 2.2, kind: 'drop', name: 'MESA STEP' }]
};

export default {
  id: 'canyon',
  name: 'SUNSTRIKE CANYON',
  tagline: 'Gap jumps over red rock',
  theme: 'canyon',
  seed: 1207,
  laps: 3,
  difficulty: 0.45,

  path: [
    { x: 233.4, z: 0, y: 1.0, w: 10 }, { x: 229.1, z: 49.8, y: 0.2, w: 9.8 }, { x: 222.5, z: 99.4, y: -1.8, w: 9.5 },
    { x: 208.7, z: 147.4, y: -2.9, w: 9.1 }, { x: 186, z: 191.8, y: -3.1, w: 8.9 }, { x: 152.5, z: 228.8, y: -2.0, w: 8.6 },
    { x: 111.1, z: 256.7, y: -2.3, w: 8.4 }, { x: 63.5, z: 271.5, y: -1.8, w: 8.2 }, { x: 13.6, z: 271.3, y: -2.4, w: 8 },
    { x: -34.3, z: 257.6, y: -2.6, w: 8 }, { x: -76.5, z: 231, y: -3.5, w: 8.1 }, { x: -112.6, z: 196.4, y: -3.8, w: 8.2 },
    /* The three control points after THE GAP were re-graded in wave 6: the lap
       used to keep climbing at ~3.7 % through the landing, and a 24 m gap that
       lands on rising ground cases every time. The crest now arrives WITH the
       landing (s=654), so the runway is level and the climb resumes after it. */
    { x: -143.8, z: 157.3, y: -3.2, w: 8.4 }, { x: -173.4, z: 117, y: -2.4, w: 8.6 }, { x: -202.5, z: 76.3, y: -2.4, w: 8.9 },
    { x: -225.9, z: 32.1, y: -2.3, w: 9.2 }, { x: -241.5, z: -15.3, y: -2.0, w: 9.4 }, { x: -247.2, z: -65, y: -2.1, w: 9.5 },
    { x: -241.8, z: -114.6, y: -2.8, w: 9.4 }, { x: -225.5, z: -161.8, y: -4.6, w: 9 }, { x: -196.2, z: -202.1, y: -8.4, w: 8.5 },
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
    // A table, not a kicker. As a 5.0 m ramp this fired 141 m at 40+ m/s and
    // landed inside the next sweeper on a climbing road -- the single worst
    // reset site on the campaign. At 2.6 m the lip is 12 deg: ~90 m on to level
    // road at racing speed, on to the deck at a crawl, and still ~2 s of air,
    // so the trick system keeps its showpiece. Keep `cp`: checkpoint idx 1
    // lives on this lip and track-check's MAX_CP_GAP fails without it.
    { s: 100, len: 22, h: 2.6, kind: 'table', top: 14, down: 10, name: 'MESA LAUNCHER' },
    // Hip: the lip line is angled 15 deg the other way, so the car leaves it
    // already pointed into the sweeper. No gate — MESA LAUNCHER has one 150 m back.
    { s: 250, len: 12, h: 2.0, kind: 'hip', yaw: -15, cp: false },
    // THE SHELF. Sited at 452 rather than the drawn 470 because the wash floor
    // turns upward at ~460 and a drop must never land on rising ground.
    { s: 452, len: 10, h: 2.5, kind: 'drop', cp: false, name: 'THE SHELF' },
    { s: 630, len: 18, h: 3.2, gap: 24, name: 'THE GAP' },  // true canyon leap, ~26 m/s to clear; see header
    { s: 880, len: 13, h: 2.4, kind: 'table', top: 8, down: 6 },
    { s: 1330, len: 12, h: 1.7 },
    { s: 1475, len: 13, h: 2.4 },                // the gated half of the rhythm double
    // …and its partner 70 m on, now a hip that flicks the car left for the
    // climb out. The checkpoint stays on 1475.
    { s: 1545, len: 13, h: 2.4, kind: 'hip', yaw: 12, cp: false }
  ],

  // The washboard down the descent, then the hairpin: 20 deg of authored bank
  // with a 2.2 m berm round the outside to lean on. Sited 1170-1275 rather than
  // the drawn 1150-1280 because the corner reverses either side of that.
  whoops: [{ s0: 1000, s1: 1060, wl: 8, amp: 0.45 }],
  banks: [{ s0: 1170, s1: 1275, deg: 20 }],
  berms: [{ s0: 1170, s1: 1275, side: -1, h: 2.2 }],

  // 45 m before THE GAP's ramp foot: the pads are how a slow car makes it.
  pads: [{ s: 585, lat: 2.5 }, { s: 585, lat: -2.5 }],

  routes: [SLOT, MESA_TOP],
  /* Alias for the fourteen consumers that still read `def.shortcut`
     (docs/ARCHITECTURE.md §6.1). Same object, not a copy. */
  shortcut: SLOT,

  walls: [
    { s0: 1120, s1: 1310, side: 0 },             // hairpin, both sides
    { s0: 300, s1: 420, side: 1 }                // the drop into the wash
  ],

  props: 'theme',
  grid: { s: 0 },
  checkpoints: 'auto',
  par: { gold: 0, silver: 0, bronze: 0 }
};

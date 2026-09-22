/* ============================================================
   WHAT EACH STAGE IS A PICTURE OF
   ------------------------------------------------------------
   Split out of props.js: the placement machinery is one job and the
   DESCRIPTION of what to place is another, and only the second one changes
   when a stage is being art-directed. Everything here is data plus the
   canvas signage that carries a stage's accent colour.

   Four tables and the signage:

   • RECIPES   — the scatter. Texture for the middle distance: how much of
     each kind, how big, whether you can hit it, how steep a slope it will
     tolerate. Much the same everywhere on a stage, by design. The shares
     must sum to 1 per stage: buildScatter ceils MAX_SCATTER × share per
     kind, so an over-unity table silently overspends the tier. kit-check
     asserts it.

   • DRESSING  — the authored one-offs. A short list of structures that give
     a stage a place and a story, the utility lines that tie them together,
     and the HEROES: the two or three landmarks a player will actually
     remember. Landmarks are placed by rejection sampling in a lateral BAND
     beside the racing line, so they land where a driver is looking — near
     enough to read at 130 km/h, far enough out never to be the reason you
     lost the race. `lat` is that band in metres from the centreline, `r` is
     the collision radius, `size` the random scale range.

   • WASTE_FACING — which way each wasteland shape is BUILT, so a planner
     knows how far to turn it. A fact about the geometry, not about a stage.

   • The signage — gantry, banners, sponsor boards, warning chevrons, the
     finish checker, the barrier rail. All canvas, all tinted by the
     recipe's accent.
   ============================================================ */
import * as THREE from 'three';

/* ============================================================
   1.  SCATTER RECIPES
   ============================================================ */
export const RECIPES = {
  training: {
    accent: '#2ad2ff',
    rock: 0x94806a, dust: 0xb49b77,
    kinds: [
      { id: 'cone', share: 0.035, min: 0.9, max: 1.2, solid: false, slope: 22, clear: 1.35, shadow: false },
      { id: 'tyre', share: 0.045, min: 0.9, max: 1.4, solid: true, r: 0.62, slope: 18, clear: 1.5, shadow: false },
      { id: 'drum', share: 0.03, min: 0.9, max: 1.2, solid: true, r: 0.42, slope: 16, clear: 1.6, shadow: true },
      { id: 'crate', share: 0.03, min: 0.9, max: 1.3, solid: true, r: 0.55, slope: 14, clear: 1.7, shadow: true },
      { id: 'bale', share: 0.02, min: 0.9, max: 1.15, solid: true, r: 0.72, slope: 16, clear: 1.7, shadow: true },
      { id: 'rock0', share: 0.22, min: 0.8, max: 2.7, solid: true, r: 0.72, slope: 34, clear: 1.8, shadow: true },
      { id: 'rock2', share: 0.60, min: 0.3, max: 0.9, solid: false, slope: 34, clear: 1.6, shadow: false },
      { id: 'scrap', share: 0.02, min: 0.8, max: 1.5, solid: true, r: 0.62, slope: 20, clear: 1.5, shadow: false }
    ]
  },
  canyon: {
    accent: '#ff7a1a',
    rock: 0x8a4a30, dust: 0xb99a6a,
    kinds: [
      /* Hoodoos are down from 0.08 to 0.035. They were a tenth of the scatter
         when the scatter was 2200 spread over a kilometre; at 2900 with 74 %
         of it on the verge, the same share put 230 identical orange spires
         along the racing line and SUNSTRIKE CANYON looked like a slalom
         course. A hoodoo is a landmark — it wants to be rare. */
      { id: 'hoodoo', share: 0.035, min: 1.4, max: 3.4, solid: true, r: 1.15, slope: 26, clear: 2.0, shadow: true },
      { id: 'rock0', share: 0.10, min: 1.2, max: 4.4, solid: true, r: 0.72, slope: 32, clear: 1.7, shadow: true },
      /* rock1 and rock2 are down 0.015 and 0.03 from where the wave-6 pass
         left them. That table summed to 1.025, which quietly gave the whole
         canyon scatter 2.5 % more instances than MAX_SCATTER budgets for —
         buildScatter ceils per kind, so an over-unity table simply overspends.
         kit-check now asserts the sum, per stage. */
      { id: 'rock1', share: 0.245, min: 0.7, max: 2.2, solid: true, r: 0.72, slope: 36, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.27, min: 0.22, max: 0.9, solid: false, slope: 40, clear: 1.35, shadow: false },
      { id: 'cactus0', share: 0.10, min: 0.8, max: 1.5, solid: true, r: 0.34, slope: 26, clear: 1.6, shadow: true },
      { id: 'cactus1', share: 0.06, min: 0.7, max: 1.3, solid: true, r: 0.32, slope: 26, clear: 1.6, shadow: true },
      { id: 'agave', share: 0.10, min: 0.7, max: 1.6, solid: false, slope: 32, clear: 1.4, shadow: false },
      { id: 'bush0', share: 0.07, min: 0.6, max: 1.4, solid: false, slope: 34, clear: 1.4, shadow: false },
      { id: 'scrap', share: 0.02, min: 0.8, max: 1.6, solid: true, r: 0.62, slope: 22, clear: 1.5, shadow: false }
    ]
  },
  forest: {
    accent: '#4fd07a',
    rock: 0x5f6357, dust: 0x6b6c56,
    kinds: [
      { id: 'pine0', share: 0.22, min: 0.75, max: 1.5, solid: true, r: 0.55, slope: 34, clear: 1.45, shadow: true },
      { id: 'pine1', share: 0.18, min: 0.7, max: 1.4, solid: true, r: 0.5, slope: 36, clear: 1.45, shadow: true },
      { id: 'pine2', share: 0.14, min: 0.6, max: 1.2, solid: true, r: 0.45, slope: 38, clear: 1.45, shadow: false },
      { id: 'broadleaf', share: 0.07, min: 0.7, max: 1.4, solid: true, r: 0.5, slope: 30, clear: 1.6, shadow: true },
      { id: 'snag', share: 0.08, min: 0.7, max: 1.4, solid: true, r: 0.32, slope: 38, clear: 1.5, shadow: true },
      { id: 'log', share: 0.07, min: 0.8, max: 1.4, solid: true, r: 0.5, slope: 22, clear: 1.7, shadow: false },
      { id: 'stump', share: 0.07, min: 0.8, max: 1.5, solid: true, r: 0.4, slope: 26, clear: 1.5, shadow: false },
      { id: 'bush0', share: 0.075, min: 0.7, max: 1.7, solid: false, slope: 36, clear: 1.35, shadow: false },
      { id: 'rock1', share: 0.08, min: 0.4, max: 1.5, solid: false, slope: 40, clear: 1.5, shadow: false },
      /* The leanest scrap share in the game. TIMBERLINE CLIMB is a working
         logging show, not a dumping ground — what rusts here got dropped off
         the back of a truck, it did not drive up. */
      { id: 'scrap', share: 0.015, min: 0.8, max: 1.4, solid: true, r: 0.62, slope: 24, clear: 1.5, shadow: false }
    ]
  },
  volcano: {
    accent: '#ff5a2c',
    rock: 0x3a3634, dust: 0x4a3c33,
    kinds: [
      { id: 'basalt', share: 0.20, min: 0.9, max: 2.4, solid: true, r: 1.0, slope: 30, clear: 1.9, shadow: true },
      { id: 'vent', share: 0.06, min: 0.9, max: 1.8, solid: true, r: 1.6, slope: 18, clear: 2.2, shadow: true },
      { id: 'shard0', share: 0.14, min: 0.7, max: 1.9, solid: true, r: 0.5, slope: 36, clear: 1.5, shadow: true },
      { id: 'shard1', share: 0.10, min: 0.5, max: 1.4, solid: false, slope: 40, clear: 1.4, shadow: false },
      { id: 'snag', share: 0.08, min: 0.6, max: 1.2, solid: true, r: 0.3, slope: 36, clear: 1.5, shadow: true },
      { id: 'rock0', share: 0.10, min: 0.9, max: 3.2, solid: true, r: 0.72, slope: 34, clear: 1.7, shadow: false },
      { id: 'rock2', share: 0.30, min: 0.25, max: 1.0, solid: false, slope: 42, clear: 1.4, shadow: false },
      { id: 'scrap', share: 0.02, min: 0.8, max: 1.5, solid: true, r: 0.62, slope: 22, clear: 1.5, shadow: false }
    ]
  },
  /* THUNDER MESA. Canyon rock, but the scatter is thinner and there is
     visibly less of it: this stage's middle distance belongs to the EVENT —
     the floodlights, the boards, the tyre walls — and a full desert scatter
     would fight them for the same silhouette. What is left is the stuff a
     promoter would not have bothered to clear. */
  thunder: {
    accent: '#ff5edc',
    rock: 0x8a4a30, dust: 0xb99a6a,
    kinds: [
      { id: 'hoodoo', share: 0.03, min: 1.6, max: 3.8, solid: true, r: 1.15, slope: 26, clear: 2.0, shadow: true },
      { id: 'rock0', share: 0.11, min: 1.2, max: 4.6, solid: true, r: 0.72, slope: 32, clear: 1.7, shadow: true },
      { id: 'rock1', share: 0.21, min: 0.7, max: 2.2, solid: true, r: 0.72, slope: 36, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.24, min: 0.22, max: 0.9, solid: false, slope: 40, clear: 1.35, shadow: false },
      { id: 'tyre', share: 0.11, min: 0.9, max: 1.4, solid: true, r: 0.62, slope: 18, clear: 1.5, shadow: false },
      { id: 'drum', share: 0.08, min: 0.9, max: 1.3, solid: true, r: 0.42, slope: 16, clear: 1.6, shadow: true },
      { id: 'cactus0', share: 0.09, min: 0.8, max: 1.5, solid: true, r: 0.34, slope: 26, clear: 1.6, shadow: true },
      { id: 'agave', share: 0.10, min: 0.7, max: 1.6, solid: false, slope: 32, clear: 1.4, shadow: false },
      /* The heaviest scrap share in the game, and the reason THUNDER MESA now
         reads as abandoned rather than merely empty: the promoter's stuff is
         still standing and nobody has cleared up around it since. */
      { id: 'scrap', share: 0.03, min: 0.8, max: 1.6, solid: true, r: 0.62, slope: 22, clear: 1.5, shadow: false }
    ]
  }
};

/* ============================================================
   2.  SET-DRESSING PLAN
   ------------------------------------------------------------
   `heroes` is the point of the whole table: one or two things per stage that
   are not scenery but LANDMARKS — an arch you drive through, a waterfall you
   drive past, a vent field that goes off while you are in it. Each is placed
   against a named point on the spline rather than sampled, because a landmark
   that lands somewhere different every build is not a landmark.

   WAVE 8 adds two more lists per stage, and the reason they are separate
   lists rather than more `landmarks` rows is the DRAW-CALL BUDGET, which is
   the only budget this file can blow on its own:

   • `wasteland` — the kit-wasteland.js structures. Every one of these is
     BAKED INTO WORLD SPACE and merged into a single mesh (props.js
     `_oneOffSolid`), so twelve new shapes across a stage cost ONE draw call
     between them instead of one each. That is the whole trick, and it is the
     same one the bunting and the power-line wires already use. The price is
     that they are not instanced: each site pays its own triangles, which is
     why the shapes in that file are 100–530 triangles and not 900.

     `where` says how a row finds its ground:
       'verge'  (default) rejection-sample the `lat` band beside the line
       'corner' the outside of the three tightest corners on the lap — the
                same scan the warning boards and the crowd use, so the sign,
                the crowd and the thing you hit all agree where the corner is
     `ember: true` records the site's world position for props.update, which
     is how a fire drum gets its sparks. Which WAY a row ends up pointing is
     not in the row at all — see WASTE_FACING below.

   • `heroModels` — ARCHITECTURE §8.9. A generated GLB per stage, with the kit
     shape it falls back to when the file is not there. See the note on the
     table itself: `scale` is not a taste knob, it is the metre conversion.
   ============================================================ */
export const DRESSING = {
  training: {
    // An old airfield somebody bolted a rally school onto.
    landmarks: [
      { id: 'hangar', n: 1, lat: [95, 150], r: 12.0, size: [1.00, 1.00] },
      { id: 'tower', n: 1, lat: [58, 95], r: 2.2, size: [0.95, 1.15] },
      { id: 'grandstand', n: 2, lat: [26, 40], r: 7.0, size: [1.00, 1.00] },
      { id: 'shed', n: 3, lat: [42, 110], r: 2.6, size: [0.90, 1.30] },
      { id: 'container', n: 4, lat: [30, 90], r: 3.2, size: [1.00, 1.00] },
      { id: 'wreck', n: 2, lat: [26, 55], r: 1.9, size: [1.00, 1.00] },
    ],
    lines: { runs: 2, poleH: 8.5, arms: 2, span: 46 },
    heroes: [{ kind: 'bunting', s: 0, span: 34 }],
    /* PROVING GROUNDS has the widest road in the game — 10.4 to 12.1 m of
       half-width — so its wreck band starts at 18 m and not at the 12 the
       narrow stages can afford. `clear` multiplies the half-width in
       _canPlace, so a husk asked for at 12 m is INSIDE the road-clearance
       test here and would simply never be placed. The band has to clear the
       road, not the number in the brief. */
    wasteland: [
      { id: 'husk0', n: 2, lat: [18, 34], r: 2.2, clear: 1.45 },
      { id: 'husk1', n: 1, lat: [20, 40], r: 2.5, clear: 1.45 },
      { id: 'jersey', n: 2, lat: [19, 30], r: 3.6, clear: 1.45, slope: 12 },
      { id: 'sandbags', n: 2, lat: [19, 34], r: 1.9, clear: 1.45, slope: 14 },
      { id: 'watchtower', n: 1, lat: [40, 80], r: 2.6, slope: 13 },
      { id: 'totem', n: 1, lat: [20, 42], r: 0.42 },
      { id: 'firedrum', n: 3, lat: [18, 28], r: 0.45, clear: 1.42, slope: 12, ember: true },
      { id: 'barricade', n: 3, r: 2.5, where: 'corner' },
    ],
    centerpieces: [
      { id: 'training-conveyor', url: 'assets/models/heroes/training-conveyor.glb',
        s: 195, lat: 58, yaw: 1.5708, scale: 8, size: 25, height: 22, r: 18, fallback: 'container' },
    ],
    heroModels: [
      { id: 'crusher', url: 'assets/models/heroes/training-hero.glb',
        s: 310, lat: 42, yaw: -1.15, scale: 3.20, size: 18, height: 15, r: 13, fallback: 'container' },
    ],
  },
  canyon: {
    // A worked-out mining claim in the wash: water tank, camp, dead machinery.
    landmarks: [
      { id: 'tank', n: 2, lat: [48, 110], r: 3.4, size: [0.90, 1.20] },
      { id: 'shed', n: 4, lat: [30, 120], r: 2.6, size: [0.85, 1.25] },
      { id: 'mast', n: 1, lat: [85, 160], r: 2.0, size: [1.00, 1.00] },
      { id: 'pipes', n: 3, lat: [26, 60], r: 2.2, size: [1.00, 1.00] },
      { id: 'wreck', n: 3, lat: [24, 48], r: 1.9, size: [1.00, 1.00] },
      { id: 'culvert', n: 2, lat: [22, 34], r: 2.0, size: [1.00, 1.30] },
      { id: 'container', n: 2, lat: [34, 80], r: 3.2, size: [1.00, 1.00] },
    ],
    lines: { runs: 2, poleH: 9.5, arms: 2, span: 52 },
    // The natural arch over the wash. Every canyon photograph you have ever
    // seen has one, and this is the only place in the game you drive through
    // a piece of geology instead of past it.
    heroes: [{ kind: 'arch', s: 300 }],
    /* The fullest wasteland list of the five, because SUNSTRIKE CANYON is the
       stage the whole layer was drawn for: a claim that was worked, walked
       away from, and then used as a place to leave things. */
    wasteland: [
      { id: 'husk0', n: 1, lat: [14, 30], r: 2.2, clear: 1.55 },
      { id: 'husk1', n: 1, lat: [14, 30], r: 2.5, clear: 1.55 },
      { id: 'husk2', n: 1, lat: [16, 32], r: 2.6, clear: 1.55 },
      { id: 'tanker', n: 1, lat: [20, 40], r: 4.6, clear: 1.7, slope: 12 },
      { id: 'pumpjack', n: 2, lat: [40, 78], r: 3.0, slope: 13 },
      { id: 'windpump', n: 1, lat: [44, 85], r: 1.7, slope: 15 },
      { id: 'watchtower', n: 1, lat: [40, 80], r: 2.6, slope: 13 },
      { id: 'jersey', n: 1, lat: [15, 26], r: 3.6, clear: 1.55, slope: 12 },
      { id: 'totem', n: 2, lat: [16, 40], r: 0.42 },
      { id: 'firedrum', n: 3, lat: [13, 24], r: 0.45, clear: 1.5, slope: 12, ember: true },
      { id: 'barricade', n: 3, r: 2.5, where: 'corner' },
    ],
    centerpieces: [
      { id: 'canyon-arch', url: 'assets/models/heroes/canyon-arch.glb',
        s: 1030, lat: 58, yaw: 1.5708, scale: 8, size: 24, height: 20, r: 18, natural: true, fallback: 'ruinboard' },
    ],
    heroModels: [
      { id: 'tailsection', url: 'assets/models/heroes/canyon-hero.glb',
        s: 940, lat: 38, yaw: -1.27, scale: 4.60, size: 18, height: 11, r: 12.8, fallback: 'ruinboard' },
    ],
  },
  forest: {
    // An active logging show, and the fire lookout that watches it.
    landmarks: [
      { id: 'lookout', n: 1, lat: [62, 120], r: 2.4, size: [1.00, 1.00] },
      { id: 'logstack', n: 5, lat: [24, 70], r: 3.0, size: [0.90, 1.20] },
      { id: 'shed', n: 3, lat: [28, 90], r: 2.6, size: [0.85, 1.15] },
      { id: 'container', n: 2, lat: [28, 60], r: 3.2, size: [1.00, 1.00] },
      { id: 'wreck', n: 2, lat: [22, 44], r: 1.9, size: [1.00, 1.00] },
      { id: 'grandstand', n: 1, lat: [24, 34], r: 7.0, size: [1.00, 1.00] },
    ],
    lines: { runs: 1, poleH: 10.0, arms: 1, span: 44 },
    // The falls, off the outside of the climb, with their own mist.
    heroes: [{ kind: 'waterfall', s: 640, lat: [30, 62] }],
    /* No pumpjack, no windpump, no tanker: nothing on this list drove up a
       shelf road cut into a mountainside, so what rusts on TIMBERLINE CLIMB
       is what the logging show itself left. The slope gates matter more here
       than anywhere else — inboard of the bench through s 340–1015 the ground
       falls ~16 m in 30 m, and a prop sampled onto that side is rejected by
       `slope` rather than placed sixteen metres under the road. */
    wasteland: [
      { id: 'husk1', n: 1, lat: [13, 28], r: 2.5, clear: 1.6, slope: 18 },
      { id: 'husk2', n: 1, lat: [13, 28], r: 2.6, clear: 1.6, slope: 18 },
      { id: 'watchtower', n: 2, lat: [40, 78], r: 2.6, slope: 15 },
      { id: 'jersey', n: 3, lat: [13, 24], r: 3.6, clear: 1.6, slope: 12 },
      { id: 'sandbags', n: 2, lat: [13, 26], r: 1.9, clear: 1.6, slope: 15 },
      { id: 'totem', n: 2, lat: [15, 36], r: 0.42, slope: 24 },
      { id: 'firedrum', n: 3, lat: [12, 22], r: 0.45, clear: 1.55, slope: 12, ember: true },
      { id: 'barricade', n: 3, r: 2.5, where: 'corner' },
    ],
    centerpieces: [
      { id: 'forest-trestle', url: 'assets/models/heroes/forest-trestle.glb',
        s: 1450, lat: 46, yaw: 1.5708, scale: 8, size: 20, height: 14, r: 15, fallback: 'logstack' },
    ],
    heroModels: [
      /* s 1320 is deliberately off the shelf (s 340–1015): the bench has a
         rock face outboard and air inboard, and neither is anywhere to leave
         a seven-metre machine. */
      { id: 'fellerbuncher', url: 'assets/models/heroes/forest-hero.glb',
        s: 1320, lat: 30, yaw: -1.19, scale: 3.30, size: 8, height: 6, r: 5.7, fallback: 'pumpjack' },
    ],
  },
  volcano: {
    // A monitoring station nobody has staffed since the last eruption.
    landmarks: [
      { id: 'mast', n: 2, lat: [55, 130], r: 2.0, size: [1.00, 1.20] },
      { id: 'shed', n: 4, lat: [26, 90], r: 2.6, size: [0.80, 1.20] },
      { id: 'pipework', n: 5, lat: [22, 60], r: 1.6, size: [1.00, 1.40] },
      { id: 'pipes', n: 3, lat: [24, 55], r: 2.2, size: [1.00, 1.00] },
      { id: 'culvert', n: 3, lat: [20, 34], r: 2.0, size: [1.10, 1.50] },
      { id: 'wreck', n: 2, lat: [22, 42], r: 1.9, size: [1.00, 1.00] },
      { id: 'container', n: 2, lat: [30, 70], r: 3.2, size: [1.00, 1.00] },
    ],
    lines: { runs: 1, poleH: 9.0, arms: 2, span: 48 },
    // Three vents close enough to the road to catch you out, on a timer.
    heroes: [{ kind: 'geyser', n: 3, lat: [16, 40] }],
    /* Four fire drums, the most of any stage. CALDERA RUN is the darkest
       stage in the game and the only one where the drums are doing lighting
       work rather than storytelling — they are the reason a night-black
       verge has somewhere to look. */
    wasteland: [
      { id: 'husk1', n: 1, lat: [14, 30], r: 2.5, clear: 1.55 },
      { id: 'husk2', n: 1, lat: [14, 30], r: 2.6, clear: 1.55 },
      { id: 'tanker', n: 1, lat: [20, 42], r: 4.6, clear: 1.7, slope: 12 },
      { id: 'pumpjack', n: 1, lat: [40, 75], r: 3.0, slope: 13 },
      { id: 'windpump', n: 1, lat: [44, 85], r: 1.7, slope: 15 },
      { id: 'watchtower', n: 1, lat: [40, 80], r: 2.6, slope: 13 },
      { id: 'jersey', n: 2, lat: [15, 26], r: 3.6, clear: 1.55, slope: 12 },
      { id: 'sandbags', n: 3, lat: [15, 30], r: 1.9, clear: 1.55, slope: 15 },
      { id: 'totem', n: 2, lat: [16, 38], r: 0.42 },
      { id: 'firedrum', n: 4, lat: [13, 24], r: 0.45, clear: 1.5, slope: 12, ember: true },
      { id: 'barricade', n: 3, r: 2.5, where: 'corner' },
    ],
    centerpieces: [
      { id: 'volcano-pipe', url: 'assets/models/heroes/volcano-pipe.glb',
        s: 1380, lat: 48, yaw: 1.5708, scale: 8, size: 18, height: 18, r: 13, fallback: 'pipework' },
    ],
    heroModels: [
      { id: 'derrick', url: 'assets/models/heroes/volcano-hero.glb',
        s: 1100, lat: 40, yaw: 0.55, scale: 6.60, size: 18, height: 18, r: 8.5, fallback: 'watchtower' },
    ],
  },
  /* THUNDER MESA. The one stage that is a VENUE rather than a place:
     floodlights on the skyline, sponsor boards on every straight, tyre
     walls on the corners you get wrong, and an arch over the middle of it.
     Everything here is the promoter's, and it is all facing the road. */
  thunder: {
    landmarks: [
      { id: 'floodlight', n: 6, lat: [30, 78], r: 1.4, size: [0.90, 1.25] },
      { id: 'billboard', n: 5, lat: [22, 46], r: 3.6, size: [0.90, 1.20] },
      { id: 'tyrewall', n: 8, lat: [15, 24], r: 3.2, size: [1.00, 1.35] },
      { id: 'grandstand', n: 3, lat: [24, 40], r: 7.0, size: [1.00, 1.15] },
      { id: 'container', n: 4, lat: [26, 70], r: 3.2, size: [1.00, 1.00] },
      { id: 'mast', n: 2, lat: [80, 150], r: 2.0, size: [1.00, 1.20] },
      { id: 'wreck', n: 2, lat: [22, 44], r: 1.9, size: [1.00, 1.00] },
    ],
    lines: { runs: 1, poleH: 9.5, arms: 2, span: 50 },
    heroes: [
      { kind: 'arch', s: 520 },
      { kind: 'bunting', s: 0, span: 40 },
    ],
    /* The only stage that gets `ruinboard`, and it gets three of them —
       standing beside the five live sponsor boards. Two versions of the same
       structure, one papered and one stripped, is the cheapest sentence in
       the game: the promoter was here, and then he was not. */
    wasteland: [
      { id: 'husk0', n: 2, lat: [17, 32], r: 2.2, clear: 1.5 },
      { id: 'husk1', n: 1, lat: [18, 34], r: 2.5, clear: 1.5 },
      { id: 'husk2', n: 1, lat: [18, 34], r: 2.6, clear: 1.5 },
      { id: 'ruinboard', n: 3, lat: [22, 46], r: 3.6, slope: 12 },
      { id: 'tanker', n: 1, lat: [22, 44], r: 4.6, clear: 1.65, slope: 12 },
      { id: 'watchtower', n: 2, lat: [42, 80], r: 2.6, slope: 13 },
      { id: 'jersey', n: 4, lat: [17, 28], r: 3.6, clear: 1.5, slope: 12 },
      { id: 'sandbags', n: 2, lat: [17, 32], r: 1.9, clear: 1.5, slope: 14 },
      { id: 'totem', n: 1, lat: [18, 40], r: 0.42 },
      { id: 'firedrum', n: 4, lat: [16, 26], r: 0.45, clear: 1.45, slope: 12, ember: true },
      { id: 'barricade', n: 3, r: 2.5, where: 'corner' },
    ],
    centerpieces: [
      { id: 'thunder-timing', url: 'assets/models/heroes/thunder-timing.glb',
        s: 1020, lat: 44, yaw: 1.5708, scale: 8, size: 18, height: 18, r: 13, fallback: 'watchtower' },
    ],
    heroModels: [
      /* The one hero model that FRONTS ONTO the road instead of lying along
         it: a trophy on a plinth faces the crowd, and on this stage the road
         is the crowd. */
      { id: 'monument', url: 'assets/models/heroes/thunder-hero.glb',
        s: 900, lat: 35, yaw: 0.25, scale: 4.30, size: 14, height: 10, r: 10, fallback: 'ruinboard' },
    ],
  },
};

/**
 * Ids whose geometry comes from the kit — kit.js or kit-wasteland.js — and
 * carries its colours in the vertex stream.
 *
 * props.js reads this in three places and all three are about the SCATTER:
 * route the id to _kitGeo, draw it with the one vertex-coloured material, and
 * do not sink it (kit shapes stand on y = 0, so a drum buried to its waist
 * reads as a bug). The wasteland ids that only ever appear in the `wasteland`
 * dressing list are listed anyway — every one of them is a kit shape, and the
 * day one is promoted into a RECIPES row it must already route correctly
 * rather than silently come out as a boulder.
 */
export const KIT_KINDS = new Set([
  'cactus0', 'cactus1', 'agave', 'bush0', 'snag', 'broadleaf', 'stump',
  'shard0', 'shard1', 'drum', 'crate', 'bale',
  /* the wasteland layer */
  'husk0', 'husk1', 'husk2', 'scrap', 'tanker', 'pumpjack', 'windpump',
  'watchtower', 'jersey', 'sandbags', 'barricade', 'firedrum', 'totem',
  'ruinboard',
]);

/**
 * How hard a prop throws you back. This is the only thing that tells a player
 * what a shape is MADE of, so it is worth being deliberate: rock and steel
 * punish, wood is firm, and the soft stuff (bales, brush, cactus, tyres)
 * barely argues — a hay bale that fired a car back across the road would be
 * a lie, and so would a tyre wall.
 *
 * The wasteland layer is graded on the same one question. Sandbags are the
 * softest thing in the game after a hay bale, because that is what sand in a
 * sack does. A car husk and a tanker are sheet metal on a chassis: they stop
 * you, but they fold doing it, so they sit under the boulders and the welded
 * plate. `barricade` and `jersey` are the two that punish, and they are the
 * two deliberately parked on the outside of the corners where a driver is
 * already going too fast — the whole point of putting them there is that
 * hitting one has to be the worse choice.
 */
export const BOUNCE_FOR = (id) =>
  id === 'bale' || id === 'tyrewall' ? 0.35
    : id === 'sandbags' ? 0.40
      : id === 'bush0' || id === 'agave' ? 0.5
        : id === 'cactus0' || id === 'cactus1' ? 0.7
          : id === 'crate' || id === 'stump' || id === 'scrap' ? 0.9
            : id === 'drum' || id === 'firedrum' ? 1.0
              : id.startsWith('pine') || id === 'snag' || id === 'broadleaf' ||
                id.startsWith('husk') || id === 'tanker' || id === 'totem' ? 1.15
                : 1.35;

/**
 * Kinds that GIVE WAY rather than stop you.
 *
 * Membership here is a statement about the shape, not about the machine: a
 * pine, a hay bale and a warning board are all things a vehicle could in
 * principle move, so all three are listed. Whether any given machine actually
 * moves one is decided per hit, against PROP_MASS_KG below — which is how one
 * table gets to say both "a truck goes through a tree" and "a motocross does
 * not" without either being a special case.
 *
 * What is deliberately NOT here, and stays a hard stop for everybody: rock in
 * all its forms (boulders, hoodoos, basalt, shards), the barriers, the jersey
 * runs, the towers and the buildings, the gantries and the arches, the hero
 * landmarks, and the whole wasteland layer — those one-offs are merged into a
 * single static mesh and physically cannot be moved one at a time.
 *
 * `cone` is absent on purpose. Every recipe places it `solid: false`, so it
 * has no collider and you already drive through it; giving it a body would be
 * simulating something nobody can hit.
 */
export const DYNAMIC_KINDS = new Set([
  'pine0', 'pine1', 'pine2', 'broadleaf', 'snag',
  'cactus0', 'cactus1', 'agave', 'bush0',
  'drum', 'crate', 'bale', 'tyre', 'tyrewall',
  'sign',
]);

/**
 * WHAT A PROP WEIGHS, in kilograms.
 *
 * One reader, one question: props-dynamic.js asks whether this thing is light
 * enough that the machine hitting it should carry on. The answer is
 * `mass <= TUNE.props.massRatio * vehicleMass`, so these are less a physics
 * claim than a statement about who wins — which is why they are graded against
 * the four machines rather than looked up in a timber table.
 *
 * At massRatio 0.30 the caps are moto 73.5, redline 303, hopper 336,
 * ridgeback 504 kg:
 *
 *   3–55 kg    everything up to a fuel drum. The 245 kg bike shoulders these
 *              aside too, and it should: a rider bouncing off a hay bale is a
 *              worse lie than a rider going through one.
 *   90–260 kg  the snag, the three pines, the broadleaf, a tyre wall. Every
 *              four-wheeler ploughs through — the tightest is the 1010 kg
 *              redline at 303 kg, which still clears the 260 kg tyre wall —
 *              and the bike stops dead, exactly as it does today. That row is
 *              the whole feature.
 *
 * Nothing may reach 504 kg. A prop nobody on the grid can move is immovable,
 * and immovable things belong in the set above this one where a reader can
 * see them, not hiding at the bottom of a mass table. Unknown ids come back
 * Infinity so a typo fails closed — an unlisted prop keeps today's hard stop
 * rather than silently becoming furniture. dev/props-check.mjs gates both ends.
 */
const PROP_MASS = {
  cone: 3, bush0: 8, agave: 10, sign: 12, tyre: 12, cactus1: 16, cactus0: 18,
  bale: 20, crate: 35, drum: 55,
  snag: 90, pine0: 110, pine1: 160, broadleaf: 190, pine2: 210, tyrewall: 260,
};
export const PROP_MASS_KG = (id) => {
  const m = PROP_MASS[id];
  return m === undefined ? Infinity : m;
};

/** Kinds that must stand upright — a leaning cactus reads as a mistake. */
export const UPRIGHT_KINDS = new Set([
  'cone', 'tyre', 'vent', 'cactus0', 'cactus1', 'agave', 'snag', 'broadleaf',
  'stump', 'drum', 'crate', 'bale',
  /* Every wasteland shape carries its own lean, its own drift and its own
     scorch mark at y = 0, so the scatter's random 3-axis tumble would spin a
     ground stain into the air. They tilt in the factory or not at all. */
  'husk0', 'husk1', 'husk2', 'scrap', 'tanker', 'pumpjack', 'windpump',
  'watchtower', 'jersey', 'sandbags', 'barricade', 'firedrum', 'totem',
  'ruinboard',
]);

/**
 * Which way a wasteland shape is BUILT, and therefore how a planner has to
 * turn it to put it where it belongs. This is a fact about the geometry and
 * not about any stage, so it lives here once instead of on forty-four rows.
 *
 *   face   'along'  lie along the road — the default, and what a carcass, a
 *                   run of barriers and a jack-knifed tanker all want
 *          'road'   front onto the centreline — anything with a FACE. A board
 *                   nobody can read from the road is not a board.
 *          'free'   any yaw: radially symmetric, or nobody can tell
 *   turn   radians added after `face` resolves, and the whole reason this
 *          table exists. kit.js builds along +Z; kit-wasteland.js builds the
 *          tanker, the jersey run, the sandbag wall and the barricade along
 *          +X, because a caller yawing a wall along an edge thinks in the
 *          wall's length. Both are right and they cannot share a convention,
 *          so the −π/2 is written down where it can be checked.
 *
 * A row in DRESSING may override either field; nothing currently needs to.
 */
export const WASTE_FACING = {
  husk0: { face: 'along', turn: 0 },
  husk1: { face: 'along', turn: 0 },
  husk2: { face: 'along', turn: 0 },
  scrap: { face: 'free', turn: 0 },
  tanker: { face: 'along', turn: -Math.PI / 2 },
  pumpjack: { face: 'along', turn: 0 },
  windpump: { face: 'free', turn: 0 },
  watchtower: { face: 'free', turn: 0 },
  jersey: { face: 'along', turn: -Math.PI / 2 },
  sandbags: { face: 'along', turn: -Math.PI / 2 },
  barricade: { face: 'along', turn: -Math.PI / 2 },
  firedrum: { face: 'free', turn: 0 },
  totem: { face: 'road', turn: 0 },
  ruinboard: { face: 'road', turn: 0 },
};

/* ============================================================
   3.  SIGNAGE
   ------------------------------------------------------------
   Canvas, not files. Each one takes the stage's accent so a re-skin is a
   single hex.
   ============================================================ */
export function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

export function gantryTex(accent) {
  return canvasTex(1024, 160, (g, w, h) => {
    g.fillStyle = '#14161c'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10);
    // chevron run either side of the wordmark
    g.fillStyle = 'rgba(255,255,255,0.10)';
    for (let x = -40; x < w; x += 46) {
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x + 22, 14);
      g.lineTo(x + 44, h - 14); g.lineTo(x + 22, h - 14); g.closePath(); g.fill();
    }
    g.fillStyle = '#0e1014'; g.fillRect(w * 0.26, 16, w * 0.48, h - 32);
    // 72px, not 96: "ROAD RASH" is nine glyphs and has to sit inside the
    // w*0.48 plate carved out above.
    g.font = '800 72px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#f2efe6'; g.fillText('ROAD RASH', w * 0.5, h * 0.5 + 4);
    g.font = '600 22px ui-monospace, monospace';
    g.fillStyle = accent; g.fillText('START / FINISH', w * 0.5, h - 26);
  });
}

export function bannerTex(label, accent) {
  return canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#171a20'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, h - 8, w, 8);
    g.font = '700 44px ui-monospace, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#e8e4da'; g.fillText(label, w * 0.5, h * 0.46);
  });
}

/**
 * A sponsor board. `variant` picks between two layouts so a straight lined
 * with boards is not the same picture eight times — two textures is two
 * draw calls, and three would be one too many.
 */
export function sponsorTex(label, accent, variant = 0) {
  return canvasTex(1024, 512, (g, w, h) => {
    if (variant === 0) {
      g.fillStyle = '#101318'; g.fillRect(0, 0, w, h);
      g.fillStyle = accent;
      g.beginPath(); g.moveTo(0, h); g.lineTo(w * 0.42, 0); g.lineTo(w * 0.66, 0);
      g.lineTo(w * 0.24, h); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, h * 0.80, w, h * 0.06);
      g.font = '900 150px ui-monospace, Menlo, monospace';
      g.textAlign = 'right'; g.textBaseline = 'middle';
      g.fillStyle = '#f4f1e8'; g.fillText(label, w * 0.94, h * 0.42);
      g.font = '600 46px ui-monospace, monospace';
      g.fillStyle = accent; g.fillText('OFFICIAL FUEL OF THE SERIES', w * 0.94, h * 0.72);
    } else {
      g.fillStyle = accent; g.fillRect(0, 0, w, h);
      g.fillStyle = '#12151a'; g.fillRect(w * 0.04, h * 0.08, w * 0.92, h * 0.84);
      g.fillStyle = accent;
      for (let i = 0; i < 7; i++) g.fillRect(w * (0.06 + i * 0.021), h * 0.14, w * 0.010, h * 0.72);
      g.font = '900 132px ui-monospace, Menlo, monospace';
      g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillStyle = '#f4f1e8'; g.fillText(label, w * 0.24, h * 0.42);
      g.font = '600 44px ui-monospace, monospace';
      g.fillStyle = accent; g.fillText('TYRES / SUSPENSION / GLORY', w * 0.24, h * 0.70);
    }
  });
}

/** Chevron board. dir = -1 left, +1 right, 0 = caution (jump ahead). */
export function arrowTex(dir) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = dir === 0 ? '#d8231c' : '#f0b21a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#14161c'; g.lineWidth = 0;
    if (dir === 0) {
      // exclamation slab: reads as "something is about to happen"
      g.fillRect(w * 0.42, h * 0.16, w * 0.16, h * 0.44);
      g.beginPath(); g.arc(w * 0.5, h * 0.76, w * 0.09, 0, 6.2832); g.fill();
    } else {
      for (let i = 0; i < 3; i++) {
        const x0 = w * (0.10 + i * 0.26);
        g.beginPath();
        if (dir < 0) { g.moveTo(x0 + w * 0.22, h * 0.12); g.lineTo(x0, h * 0.5); g.lineTo(x0 + w * 0.22, h * 0.88); g.lineTo(x0 + w * 0.30, h * 0.88); g.lineTo(x0 + w * 0.08, h * 0.5); g.lineTo(x0 + w * 0.30, h * 0.12); }
        else { g.moveTo(x0, h * 0.12); g.lineTo(x0 + w * 0.22, h * 0.5); g.lineTo(x0, h * 0.88); g.lineTo(x0 + w * 0.08, h * 0.88); g.lineTo(x0 + w * 0.30, h * 0.5); g.lineTo(x0 + w * 0.08, h * 0.12); }
        g.closePath(); g.fill();
      }
    }
  });
}

export function checkerTex() {
  return canvasTex(256, 64, (g, w, h) => {
    const n = 16, cw = w / n, ch = h / 2;
    for (let y = 0; y < 2; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = ((x + y) & 1) ? '#f0ede4' : '#16181d';
      g.fillRect(x * cw, y * ch, cw + 1, ch + 1);
    }
  });
}

export function railTex(accent) {
  return canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#a6a399'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    g.globalAlpha = 0.62;
    for (let x = 0; x < w; x += 256) g.fillRect(x, 0, 100, h);
    g.globalAlpha = 1;
    let seed = 731;
    const rand = () => ((seed = Math.imul(seed,1664525)+1013904223|0)>>>0)/4294967296;
    for(let i=0;i<2100;i++) {
      g.fillStyle = i%3 ? 'rgba(27,23,18,0.12)' : 'rgba(225,214,188,0.18)';
      g.fillRect(rand()*w,rand()*h,1+rand()*5,1+rand()*2);
    }
    const dirt=g.createLinearGradient(0,0,0,h);
    dirt.addColorStop(0,'rgba(10,8,5,0.03)');
    dirt.addColorStop(0.58,'rgba(10,8,5,0.02)');
    dirt.addColorStop(1,'rgba(40,28,14,0.55)');
    g.fillStyle=dirt; g.fillRect(0,0,w,h);
    g.fillStyle='rgba(220,216,199,0.4)';g.fillRect(0,1,w,2);
  });
}

/**
 * The falling sheet's material, for kit.waterfallSheetGeo.
 *
 * NOT additive: falling water HIDES the hillside behind it, and additive
 * water on a dark rock face reads as a searchlight. What makes it read as
 * water is the two layers scrolling at different rates — one sheet is a
 * texture, two is motion.
 *
 * The scroll coordinate comes from OBJECT-SPACE POSITION rather than a uv,
 * because every kit shape ships position + normal + colour and nothing else.
 * That is the whole reason a waterfall can share an attribute set with a hay
 * bale: the geometry does not carry the coordinate, the shader derives it.
 */
export function waterfallMaterial(tex) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, fog: false,
    side: THREE.DoubleSide, vertexColors: true,
    uniforms: { uTex: { value: tex }, uTime: { value: 0 }, uFall: { value: 0.42 } },
    vertexShader: /* glsl */`
      varying vec3 vL; varying vec3 vC;
      void main(){
        vL = position; vC = color;
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision mediump float;
      varying vec3 vL; varying vec3 vC;
      uniform sampler2D uTex; uniform float uTime, uFall;
      void main(){
        vec2 uv = vec2(vL.x * 0.16, vL.y * 0.075 + uTime * uFall);
        float a = texture2D(uTex, uv).a;
        float b = texture2D(uTex, uv * vec2(1.9, 0.55) + vec2(0.37, uTime * uFall * 0.62)).a;
        float k = clamp(a * 0.72 + b * 0.62, 0.0, 1.0);
        if (k < 0.05) discard;
        gl_FragColor = vec4(vC * (0.70 + 0.85 * k), k * 0.92);
      }`
  });
}

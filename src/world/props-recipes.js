/* ============================================================
   WHAT EACH STAGE IS A PICTURE OF
   ------------------------------------------------------------
   Split out of props.js: the placement machinery is one job and the
   DESCRIPTION of what to place is another, and only the second one changes
   when a stage is being art-directed. Everything here is data plus the
   canvas signage that carries a stage's accent colour.

   Three tables:

   • RECIPES   — the scatter. Texture for the middle distance: how much of
     each kind, how big, whether you can hit it, how steep a slope it will
     tolerate. Much the same everywhere on a stage, by design.

   • DRESSING  — the authored one-offs. A short list of structures that give
     a stage a place and a story, the utility lines that tie them together,
     and the HEROES: the two or three landmarks a player will actually
     remember. Landmarks are placed by rejection sampling in a lateral BAND
     beside the racing line, so they land where a driver is looking — near
     enough to read at 130 km/h, far enough out never to be the reason you
     lost the race. `lat` is that band in metres from the centreline, `r` is
     the collision radius, `size` the random scale range.

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
    rock: 0x7a7166, dust: 0x8b8578,
    kinds: [
      { id: 'cone', share: 0.22, min: 0.9, max: 1.5, solid: false, slope: 22, clear: 1.35, shadow: false },
      { id: 'tyre', share: 0.16, min: 0.9, max: 1.4, solid: true, r: 0.62, slope: 18, clear: 1.5, shadow: false },
      { id: 'drum', share: 0.10, min: 0.9, max: 1.2, solid: true, r: 0.42, slope: 16, clear: 1.6, shadow: true },
      { id: 'crate', share: 0.08, min: 0.9, max: 1.3, solid: true, r: 0.55, slope: 14, clear: 1.7, shadow: true },
      { id: 'bale', share: 0.07, min: 0.9, max: 1.15, solid: true, r: 0.72, slope: 16, clear: 1.7, shadow: true },
      { id: 'bush0', share: 0.19, min: 0.6, max: 1.5, solid: false, slope: 34, clear: 1.4, shadow: false },
      { id: 'rock2', share: 0.18, min: 0.3, max: 0.9, solid: false, slope: 34, clear: 1.6, shadow: false }
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
      { id: 'rock1', share: 0.26, min: 0.7, max: 2.2, solid: true, r: 0.72, slope: 36, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.30, min: 0.22, max: 0.9, solid: false, slope: 40, clear: 1.35, shadow: false },
      { id: 'cactus0', share: 0.10, min: 0.8, max: 1.5, solid: true, r: 0.34, slope: 26, clear: 1.6, shadow: true },
      { id: 'cactus1', share: 0.06, min: 0.7, max: 1.3, solid: true, r: 0.32, slope: 26, clear: 1.6, shadow: true },
      { id: 'agave', share: 0.10, min: 0.7, max: 1.6, solid: false, slope: 32, clear: 1.4, shadow: false },
      { id: 'bush0', share: 0.07, min: 0.6, max: 1.4, solid: false, slope: 34, clear: 1.4, shadow: false }
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
      { id: 'bush0', share: 0.09, min: 0.7, max: 1.7, solid: false, slope: 36, clear: 1.35, shadow: false },
      { id: 'rock1', share: 0.08, min: 0.4, max: 1.5, solid: false, slope: 40, clear: 1.5, shadow: false }
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
      { id: 'rock2', share: 0.32, min: 0.25, max: 1.0, solid: false, slope: 42, clear: 1.4, shadow: false }
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
      { id: 'rock1', share: 0.22, min: 0.7, max: 2.2, solid: true, r: 0.72, slope: 36, clear: 1.5, shadow: false },
      { id: 'rock2', share: 0.26, min: 0.22, max: 0.9, solid: false, slope: 40, clear: 1.35, shadow: false },
      { id: 'tyre', share: 0.11, min: 0.9, max: 1.4, solid: true, r: 0.62, slope: 18, clear: 1.5, shadow: false },
      { id: 'drum', share: 0.08, min: 0.9, max: 1.3, solid: true, r: 0.42, slope: 16, clear: 1.6, shadow: true },
      { id: 'cactus0', share: 0.09, min: 0.8, max: 1.5, solid: true, r: 0.34, slope: 26, clear: 1.6, shadow: true },
      { id: 'agave', share: 0.10, min: 0.7, max: 1.6, solid: false, slope: 32, clear: 1.4, shadow: false }
    ]
  }
};

/* ============================================================
   2.  SET-DRESSING PLAN
   ------------------------------------------------------------
   `heroes` is the new part and the point of the whole table: one or two
   things per stage that are not scenery but LANDMARKS — an arch you drive
   through, a waterfall you drive past, a vent field that goes off while you
   are in it. Each is placed against a named point on the spline rather than
   sampled, because a landmark that lands somewhere different every build is
   not a landmark.
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
  },
};

/** Scatter ids whose geometry comes from kit.js and is vertex-coloured. */
export const KIT_KINDS = new Set([
  'cactus0', 'cactus1', 'agave', 'bush0', 'snag', 'broadleaf', 'stump',
  'shard0', 'shard1', 'drum', 'crate', 'bale',
]);

/**
 * How hard a prop throws you back. This is the only thing that tells a player
 * what a shape is MADE of, so it is worth being deliberate: rock and steel
 * punish, wood is firm, and the soft stuff (bales, brush, cactus, tyres)
 * barely argues — a hay bale that fired a car back across the road would be
 * a lie, and so would a tyre wall.
 */
export const BOUNCE_FOR = (id) =>
  id === 'bale' || id === 'tyrewall' ? 0.35
    : id === 'bush0' || id === 'agave' ? 0.5
      : id === 'cactus0' || id === 'cactus1' ? 0.7
        : id === 'crate' || id === 'stump' ? 0.9
          : id === 'drum' ? 1.0
            : id.startsWith('pine') || id === 'snag' || id === 'broadleaf' ? 1.15
              : 1.35;

/** Kinds that must stand upright — a leaning cactus reads as a mistake. */
export const UPRIGHT_KINDS = new Set([
  'cone', 'tyre', 'vent', 'cactus0', 'cactus1', 'agave', 'snag', 'broadleaf',
  'stump', 'drum', 'crate', 'bale',
]);

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
  return canvasTex(256, 32, (g, w, h) => {
    g.fillStyle = '#dedbd2'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 32, h);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, h - 6, w, 6);
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

/* ============================================================
   RALLY ROAD RASH — liveries
   ------------------------------------------------------------
   The 2D half of vehicle art: one 1024×512 panel per car, painted once at
   build time and never touched again. Split out of vehicle-art.js because
   canvas work and geometry work have nothing to say to each other, and
   together they were past the 1400-line ceiling.

   A livery is (layout × hue × number), never hue alone. Six cars wearing the
   same graphic in six colours reads as exactly what it is — a palette swap —
   and the grid looks like one team that lost its paint order. `LAYOUTS` is
   the difference: vehicle-art keys the works car into its team's signature
   graphic by `spec.id`, and every AI variant walks the list from there, so
   two cars only ever share a layout if the grid is more than five deep in
   the same machine.

   Everything here runs against a canvas that may be a stub (dev/vehicle-check
   installs a no-op 2D context), so nothing may READ back from the context:
   no getImageData, no createPattern round-trips, no measureText-driven
   layout that would collapse to zero. Sizes are computed, not measured.
   ============================================================ */
import * as THREE from 'three';

/* Panel is 2:1 and 1024 wide. The door plates are nearer 3:1 and the bike's
   number board nearer 1.5:1, so everything important is drawn with margin —
   a graphic that only works at exactly 2:1 will be cropped or stretched on
   half the machines that wear it. */
const W = 1024, H = 512;

/** The five signature graphics. Order is stable — vehicle-art indexes it. */
export const LAYOUTS = ['blade', 'chevron', 'split', 'bars', 'camo'];

/* Sponsor names are assembled, not authored: two syllable tables and a seeded
   RNG give every car on the grid its own set of backers without shipping a
   list of two hundred strings. They read as motorsport because the halves do. */
const SPON_A = ['NOVA', 'IRON', 'DUST', 'APEX', 'VOLT', 'GRIT', 'ATLAS', 'RAZOR',
  'KILO', 'TORQ', 'HAVOC', 'SABLE', 'VECTOR', 'CINDER', 'ROGUE', 'BRIMM'];
const SPON_B = ['LINE', 'WORKS', 'FUEL', 'TYRE', 'GEAR', 'LAB', 'FORGE', 'CO',
  'MOTO', 'DYNE', 'TECH', 'RIG', 'AXLE', 'OIL', 'GRIP', 'HAUL'];
const SPON_TAIL = ['', '', '', ' HD', ' 24', ' XR', '·GP', ' PRO'];

/**
 * Paint one car's panel.
 *
 * @param {object} o
 * @param {THREE.Color} o.paint    body colour (already hue-shifted for AI)
 * @param {THREE.Color} o.paint2   the dark complement, used for the graphic
 * @param {THREE.Color} o.accent   the bright read-at-40-m colour
 * @param {number} o.number        race number
 * @param {string} o.team          team wordmark, e.g. 'DUNE WORKS'
 * @param {string} o.layout        one of LAYOUTS
 * @param {function} o.rng         seeded 0..1
 * @returns {THREE.CanvasTexture}
 */
export function liveryTexture(o) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rng = o.rng;

  const P = {
    paint: hex(o.paint),
    dark: hex(o.paint2),
    accent: hex(o.accent),
    lite: shade(o.paint, 1.34),
    deep: shade(o.paint, 0.52),
  };

  base(g, P);
  const roundel = (LAYOUT_FN[o.layout] || LAYOUT_FN.blade)(g, P, rng);
  drawRoundel(g, roundel, o.number);
  sponsors(g, P, roundel, o.team, rng);
  wear(g, rng);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/* ============================================================
   ground coat
   ============================================================ */
function base(g, P) {
  g.fillStyle = P.paint; g.fillRect(0, 0, W, H);

  /* Panel shading. The plate is flat geometry with a flat normal, so every
     bit of form on it has to be painted: a light wash down from the top edge
     and a shadow where a real door tucks under the sill. */
  let grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(255,255,255,0.16)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.00)');
  grd.addColorStop(1, 'rgba(0,0,0,0.30)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);

  // shut lines — two verticals and the sill, all one pixel of dark
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(W * 0.045, 0, 3, H);
  g.fillRect(W * 0.955, 0, 3, H);
  g.fillRect(0, H * 0.905, W, 3);
  g.fillStyle = 'rgba(255,255,255,0.10)';
  g.fillRect(W * 0.045 + 3, 0, 2, H);
}

/* ============================================================
   the five graphics
   ------------------------------------------------------------
   Each paints the mid-panel and hands back where the number goes, because
   the roundel and the graphic are the same design decision: a swept blade
   wants the number in the clear nose end, a hard diagonal split wants it
   sitting ON the split.
   ============================================================ */
const LAYOUT_FN = {
  /* A single swept blade rising toward the nose, pinstriped. The classic. */
  blade(g, P) {
    g.fillStyle = P.dark;
    g.beginPath();
    g.moveTo(0, H * 0.94); g.lineTo(W, H * 0.40);
    g.lineTo(W, H * 0.72); g.lineTo(0, H * 1.00);
    g.closePath(); g.fill();
    g.fillStyle = P.accent;
    g.beginPath();
    g.moveTo(0, H * 0.885); g.lineTo(W, H * 0.345);
    g.lineTo(W, H * 0.415); g.lineTo(0, H * 0.955);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath();
    g.moveTo(0, H * 0.862); g.lineTo(W, H * 0.322);
    g.lineTo(W, H * 0.344); g.lineTo(0, H * 0.884);
    g.closePath(); g.fill();
    return { x: W * 0.185, y: H * 0.40, r: H * 0.29, light: true };
  },

  /* Repeating chevrons pointing forward — reads as motion even parked. */
  chevron(g, P) {
    g.fillStyle = P.dark;
    g.fillRect(0, H * 0.52, W, H * 0.40);
    for (let i = 0; i < 7; i++) {
      const x = W * 0.30 + i * W * 0.105;
      g.fillStyle = i % 2 ? P.accent : P.lite;
      g.beginPath();
      g.moveTo(x, H * 0.52); g.lineTo(x + W * 0.058, H * 0.52);
      g.lineTo(x + W * 0.098, H * 0.72); g.lineTo(x + W * 0.058, H * 0.92);
      g.lineTo(x, H * 0.92); g.lineTo(x + W * 0.040, H * 0.72);
      g.closePath(); g.fill();
    }
    g.fillStyle = P.accent;
    g.fillRect(0, H * 0.485, W, H * 0.026);
    return { x: W * 0.155, y: H * 0.34, r: H * 0.26, light: true };
  },

  /* A hard diagonal split with a toothed edge: nose in body colour, tail in
     the complement. The number sits ON the tooth line, half on each. */
  split(g, P) {
    g.fillStyle = P.dark;
    g.beginPath();
    g.moveTo(W * 0.46, 0); g.lineTo(W, 0); g.lineTo(W, H); g.lineTo(W * 0.30, H);
    g.closePath(); g.fill();
    // teeth along the seam, each one a triangle biting back into the nose
    g.fillStyle = P.accent;
    for (let i = 0; i < 9; i++) {
      const t = i / 8, x = W * 0.46 - t * W * 0.16, y = t * H;
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x - W * 0.055, y + H * 0.062);
      g.lineTo(x - W * 0.012, y + H * 0.124);
      g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(W * 0.62, H * 0.06, W * 0.30, H * 0.030);
    return { x: W * 0.44, y: H * 0.46, r: H * 0.30, light: false };
  },

  /* Three horizontal bars of falling weight — the sponsor-livery look. */
  bars(g, P) {
    g.fillStyle = P.dark; g.fillRect(0, H * 0.58, W, H * 0.34);
    g.fillStyle = P.accent; g.fillRect(0, H * 0.505, W, H * 0.062);
    g.fillStyle = P.lite; g.fillRect(0, H * 0.455, W, H * 0.032);
    g.fillStyle = 'rgba(255,255,255,0.42)'; g.fillRect(0, H * 0.425, W, H * 0.016);
    // a kicked-up tail block so the flat bars are not the whole idea
    g.fillStyle = P.accent;
    g.beginPath();
    g.moveTo(W * 0.80, H * 0.58); g.lineTo(W, H * 0.34);
    g.lineTo(W, H * 0.58); g.closePath(); g.fill();
    return { x: W * 0.175, y: H * 0.27, r: H * 0.235, light: true };
  },

  /* Splinter camo. Angular shards only — organic blobs read as damage, not
     as a paint scheme, and this is a race car, not a tank. */
  camo(g, P, rng) {
    for (let i = 0; i < 16; i++) {
      const x = rng() * W, y = H * (0.18 + rng() * 0.78);
      const w = W * (0.06 + rng() * 0.16), h = H * (0.10 + rng() * 0.30);
      g.fillStyle = i % 3 === 0 ? P.accent : (i % 3 === 1 ? P.dark : P.deep);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + w, y - h * 0.35);
      g.lineTo(x + w * 0.72, y + h * 0.65);
      g.lineTo(x - w * 0.18, y + h);
      g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,0.34)'; g.fillRect(0, H * 0.90, W, H * 0.10);
    return { x: W * 0.18, y: H * 0.40, r: H * 0.28, light: true };
  },
};

/* ============================================================
   the number
   ============================================================ */
function drawRoundel(g, R, num) {
  const s = String(num);
  g.save();
  g.beginPath(); g.arc(R.x, R.y, R.r, 0, 6.2832); g.closePath();
  g.fillStyle = R.light ? 'rgba(246,246,240,0.96)' : 'rgba(22,23,27,0.95)';
  g.fill();
  g.lineWidth = R.r * 0.11;
  g.strokeStyle = R.light ? 'rgba(20,20,22,0.80)' : 'rgba(240,240,236,0.85)';
  g.stroke();
  // inner hairline: two rings read as a decal, one reads as a paint circle
  g.lineWidth = R.r * 0.028;
  g.strokeStyle = R.light ? 'rgba(20,20,22,0.42)' : 'rgba(240,240,236,0.45)';
  g.beginPath(); g.arc(R.x, R.y, R.r * 0.86, 0, 6.2832); g.stroke();

  /* Two digits have to fit the same disc as one, so the size is chosen from
     the digit count rather than measured — the check harness's canvas stub
     answers every measureText with 10 px. */
  const size = Math.round(R.r * (s.length > 1 ? 1.00 : 1.26));
  g.fillStyle = R.light ? '#15161a' : '#f2f2ee';
  g.font = `900 ${size}px ui-sans-serif, "Arial Black", Impact, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(s, R.x, R.y + R.r * 0.05);
  g.restore();
}

/* ============================================================
   wordmarks
   ============================================================ */
function sponsors(g, P, R, team, rng) {
  g.textBaseline = 'alphabetic';

  // team name, big, in the clear air behind the roundel
  const tx = Math.min(W * 0.52, R.x + R.r + W * 0.06);
  g.textAlign = 'left';
  g.font = `800 ${Math.round(H * 0.115)}px ui-sans-serif, "Arial Narrow", system-ui, sans-serif`;
  g.fillStyle = 'rgba(0,0,0,0.38)';
  g.fillText(team, tx + 3, H * 0.235 + 3);
  g.fillStyle = 'rgba(252,252,250,0.95)';
  g.fillText(team, tx, H * 0.235);
  g.fillStyle = P.accent;
  g.fillRect(tx, H * 0.265, Math.min(W - tx - 12, team.length * H * 0.062), H * 0.018);

  // three or four backers along the sill, each a different treatment
  const n = 3 + (rng() < 0.5 ? 1 : 0);
  let x = tx;
  for (let i = 0; i < n; i++) {
    const text = SPON_A[(rng() * SPON_A.length) | 0] +
      (rng() < 0.45 ? ' ' : '') + SPON_B[(rng() * SPON_B.length) | 0] +
      SPON_TAIL[(rng() * SPON_TAIL.length) | 0];
    const h = H * (0.052 + rng() * 0.022);
    const w = wordmark(g, x, H * 0.815, h, text, (rng() * 3) | 0, P);
    x += w + W * 0.022;
    if (x > W * 0.92) break;
  }

  // technical stencil under the roundel — the small print every rally car wears
  g.textAlign = 'center';
  g.font = `600 ${Math.round(H * 0.040)}px ui-monospace, Menlo, monospace`;
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fillText('FIA GRP-R · SCRUTINEERED', R.x, Math.min(H * 0.96, R.y + R.r + H * 0.10));
}

/**
 * One sponsor block. Returns the width it consumed so the caller can pack the
 * next one — the canvas stub in the check harness cannot measure text, so the
 * advance is derived from the glyph count at a fixed 0.60 em.
 */
function wordmark(g, x, y, h, text, style, P) {
  const em = h * 0.60, w = text.length * em + h * 0.5;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  if (style === 0) {                       // knocked out of a solid slab
    g.fillStyle = 'rgba(18,18,20,0.80)';
    g.fillRect(x, y - h * 0.86, w, h * 1.16);
    g.fillStyle = 'rgba(250,250,248,0.94)';
    g.font = `800 ${Math.round(h)}px ui-sans-serif, system-ui, sans-serif`;
    g.fillText(text, x + h * 0.25, y);
  } else if (style === 1) {                // outlined, sitting on the paint
    g.font = `800 ${Math.round(h)}px ui-sans-serif, system-ui, sans-serif`;
    g.lineWidth = Math.max(1, h * 0.09);
    g.strokeStyle = 'rgba(12,12,14,0.75)';
    g.strokeText(text, x + h * 0.25, y);
    g.fillStyle = P.accent;
    g.fillText(text, x + h * 0.25, y);
  } else {                                 // plain, ruled underneath
    g.font = `700 ${Math.round(h)}px ui-monospace, Menlo, monospace`;
    g.fillStyle = 'rgba(246,246,242,0.86)';
    g.fillText(text, x + h * 0.25, y);
    g.fillStyle = 'rgba(246,246,242,0.42)';
    g.fillRect(x + h * 0.25, y + h * 0.18, w - h * 0.5, Math.max(1, h * 0.07));
  }
  return w;
}

/* ============================================================
   wear
   ------------------------------------------------------------
   Every rally car is filthy by lap two, and the dirt is what stops a flat
   procedural panel reading as vinyl. It goes on LAST, over the graphics and
   the decals, because that is the order it happens in.
   ============================================================ */
function wear(g, rng) {
  const grd = g.createLinearGradient(0, H * 0.42, 0, H);
  grd.addColorStop(0, 'rgba(58,46,32,0)');
  grd.addColorStop(0.55, 'rgba(56,44,30,0.20)');
  grd.addColorStop(1, 'rgba(44,34,22,0.52)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);

  // spray off the front tyre: a fan of specks thrown back from the leading edge
  for (let i = 0; i < 220; i++) {
    const t = rng();
    const x = W * (0.02 + t * 0.55) + rng() * W * 0.10;
    const y = H * (0.55 + rng() * rng() * 0.45);
    const r = 1 + rng() * (5 - t * 3);
    g.fillStyle = `rgba(${52 + rng() * 26 | 0},${40 + rng() * 22 | 0},${26 + rng() * 18 | 0},${0.10 + rng() * 0.40})`;
    g.fillRect(x, y, r * (1 + rng() * 2), r);
  }
  // stone chips and scuffs
  for (let i = 0; i < 46; i++) {
    g.fillStyle = `rgba(28,24,18,${0.05 + rng() * 0.12})`;
    g.fillRect(rng() * W, rng() * H, 6 + rng() * 70, 1 + rng() * 4);
  }
}

/* ============================================================
   colour helpers — build time only
   ============================================================ */
const _c = new THREE.Color();
const hex = (col) => '#' + col.getHexString();
function shade(col, k) {
  _c.copy(col);
  _c.setRGB(Math.min(1, _c.r * k), Math.min(1, _c.g * k), Math.min(1, _c.b * k));
  return '#' + _c.getHexString();
}

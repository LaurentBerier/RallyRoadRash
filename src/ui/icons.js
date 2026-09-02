/* ============================================================
   RALLY ROAD RASH — ITEM AND EVENT GLYPHS
   ------------------------------------------------------------
   Seven power-up icons plus four event glyphs, drawn on a 2D canvas. There
   are no image files in this project and no icon font is guaranteed on any
   platform we ship to, so a glyph is code — which also means it inherits the
   accent colour and the device pixel ratio for free.

   PALETTE RULE, and it is the whole reason these read as a set: one accent
   (orange, or whatever the caller passes) plus cyan, over the plate. No
   third hue, no gradients, no strokes thinner than 8 % of the box. An icon
   that has to survive being 22 px tall on a phone HUD cannot afford detail;
   what it can afford is one unmistakable silhouette.

   Every icon is authored inside a UNIT BOX (0..1 on both axes) and scaled by
   the caller, so the same path serves a 22 px HUD chip and a 44 px playbook
   row without a second set of numbers.
   ============================================================ */

/** The seven `items.js` icon ids, in ITEM order. */
export const ITEM_ICONS = ['nitro', 'triple', 'wheel', 'slick', 'tow', 'sled', 'storm'];
/** Event glyphs the HUD and the playbook use. */
export const EVENT_ICONS = ['trick', 'boost', 'pad', 'flag'];

const ACC = '#ff7a1a';
const CYAN = '#4fd8e8';
const DARK = 'rgba(0,0,0,.55)';
const PAPER = '#f2efe9';

/**
 * Paint one glyph.
 *
 * @param g       a CanvasRenderingContext2D
 * @param name    an ITEM_ICONS or EVENT_ICONS id; anything else draws a dot
 * @param x,y     top-left of the box, in device pixels
 * @param s       box size (square), in device pixels
 * @param accent  the warm colour; cyan is fixed because it is the
 *                information colour everywhere else in the UI
 */
export function drawIcon(g, name, x, y, s, accent) {
  const A = accent || ACC;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // One stroke weight for the whole set. Authored against the unit box, so it
  // thickens with the icon rather than vanishing at HUD size.
  g.lineWidth = 0.11;
  switch (name) {
    case 'nitro': nitro(g, A, 1); break;
    case 'triple': nitro(g, A, 3); break;
    case 'wheel': wheel(g, A); break;
    case 'slick': slick(g, A); break;
    case 'tow': tow(g, A); break;
    case 'sled': sled(g, A); break;
    case 'storm': storm(g, A); break;
    case 'trick': trick(g, A); break;
    case 'boost': boost(g, A); break;
    case 'pad': pad(g, A); break;
    case 'flag': flag(g, A); break;
    default:
      g.fillStyle = A;
      g.beginPath(); g.arc(0.5, 0.5, 0.22, 0, 6.2832); g.fill();
      break;
  }
  g.restore();
}

/**
 * A standalone canvas carrying one glyph, sized in CSS pixels and backed at
 * the device ratio. This is what goes into the DOM — the HUD builds one only
 * when the held item actually changes, never per frame.
 */
export function iconCanvas(name, px, accent) {
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
  const cv = document.createElement('canvas');
  cv.className = 'ico';
  cv.width = Math.round(px * dpr);
  cv.height = Math.round(px * dpr);
  cv.style.width = px + 'px';
  cv.style.height = px + 'px';
  cv.setAttribute('aria-hidden', 'true');
  const g = cv.getContext('2d');
  if (g) drawIcon(g, name, 0, 0, cv.width, accent);
  return cv;
}

/**
 * Fill every `<canvas data-ico="…">` under `root`. The playbook emits icon
 * placeholders as markup (one innerHTML write beats forty appendChild calls)
 * and then asks for them all to be painted in one pass.
 */
export function paintIcons(root, accent) {
  if (!root) return;
  const list = root.querySelectorAll('canvas[data-ico]');
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
  for (let i = 0; i < list.length; i++) {
    const cv = list[i];
    const px = +cv.dataset.size || 26;
    cv.width = Math.round(px * dpr);
    cv.height = Math.round(px * dpr);
    cv.style.width = px + 'px';
    cv.style.height = px + 'px';
    const g = cv.getContext('2d');
    if (g) drawIcon(g, cv.dataset.ico, 0, 0, cv.width, cv.dataset.accent || accent);
  }
}

/* ============================================================
   THE GLYPHS
   Authored in the unit box. Each one is a silhouette first and a detail
   second: squint at it and the wrong icon must still be obvious.
   ============================================================ */

/** A pressurised bottle with a nozzle, and one streak per charge. */
function nitro(g, A, n) {
  // streaks behind, cyan, so a triple reads as "three of them" at a glance
  g.strokeStyle = CYAN;
  g.lineWidth = 0.09;
  for (let i = 0; i < n; i++) {
    const y = 0.5 + (i - (n - 1) / 2) * 0.22;
    g.beginPath(); g.moveTo(0.06, y); g.lineTo(0.30 - i * 0.03, y); g.stroke();
  }
  g.fillStyle = A;
  g.strokeStyle = DARK;
  g.lineWidth = 0.06;
  // body
  g.beginPath();
  g.moveTo(0.40, 0.30); g.lineTo(0.78, 0.30);
  g.quadraticCurveTo(0.90, 0.50, 0.78, 0.70);
  g.lineTo(0.40, 0.70);
  g.quadraticCurveTo(0.33, 0.50, 0.40, 0.30);
  g.closePath(); g.fill(); g.stroke();
  // neck
  g.fillStyle = PAPER;
  g.fillRect(0.78, 0.43, 0.14, 0.14);
}

/** A tyre: black casing, bright rim, cleats around the outside. */
function wheel(g, A) {
  g.fillStyle = '#1b1c20';
  g.beginPath(); g.arc(0.5, 0.5, 0.42, 0, 6.2832); g.fill();
  g.strokeStyle = A;
  g.lineWidth = 0.10;
  g.beginPath(); g.arc(0.5, 0.5, 0.42, 0, 6.2832); g.stroke();
  // cleats: the silhouette of a wheel cartwheeling at you
  g.strokeStyle = A;
  g.lineWidth = 0.07;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * 6.2832;
    g.beginPath();
    g.moveTo(0.5 + Math.cos(a) * 0.30, 0.5 + Math.sin(a) * 0.30);
    g.lineTo(0.5 + Math.cos(a) * 0.42, 0.5 + Math.sin(a) * 0.42);
    g.stroke();
  }
  g.fillStyle = PAPER;
  g.beginPath(); g.arc(0.5, 0.5, 0.13, 0, 6.2832); g.fill();
}

/** A spreading slick with one highlight — the only icon that is a puddle. */
function slick(g, A) {
  g.fillStyle = '#17181c';
  g.beginPath();
  g.moveTo(0.10, 0.62);
  g.bezierCurveTo(0.16, 0.40, 0.42, 0.34, 0.56, 0.44);
  g.bezierCurveTo(0.74, 0.32, 0.94, 0.48, 0.88, 0.66);
  g.bezierCurveTo(0.74, 0.82, 0.26, 0.84, 0.10, 0.62);
  g.closePath(); g.fill();
  g.strokeStyle = A;
  g.lineWidth = 0.055;
  g.stroke();
  g.fillStyle = CYAN;
  g.globalAlpha = 0.85;
  g.beginPath(); g.ellipse(0.38, 0.55, 0.12, 0.05, -0.3, 0, 6.2832); g.fill();
  g.globalAlpha = 1;
  // drips above, so a still image still says "something was dropped here"
  g.fillStyle = A;
  g.beginPath(); g.arc(0.66, 0.24, 0.06, 0, 6.2832); g.fill();
}

/** A hook on a slack line: you throw it forward and it drags you along. */
function tow(g, A) {
  g.strokeStyle = CYAN;
  g.lineWidth = 0.075;
  g.beginPath();
  g.moveTo(0.08, 0.24);
  g.quadraticCurveTo(0.34, 0.60, 0.56, 0.34);
  g.stroke();
  g.strokeStyle = A;
  g.lineWidth = 0.11;
  g.beginPath();
  g.moveTo(0.56, 0.30); g.lineTo(0.56, 0.58);
  g.arc(0.70, 0.58, 0.14, Math.PI, 0.35, false);
  g.stroke();
  // barb
  g.fillStyle = A;
  g.beginPath();
  g.moveTo(0.84, 0.50); g.lineTo(0.95, 0.62); g.lineTo(0.80, 0.66);
  g.closePath(); g.fill();
}

/** A rocket with a flame — the comeback item, and it looks like one. */
function sled(g, A) {
  g.fillStyle = CYAN;
  g.beginPath();
  g.moveTo(0.16, 0.50);
  g.lineTo(0.36, 0.34); g.lineTo(0.36, 0.66);
  g.closePath(); g.fill();
  g.fillStyle = A;
  g.strokeStyle = DARK;
  g.lineWidth = 0.055;
  g.beginPath();
  g.moveTo(0.34, 0.36); g.lineTo(0.72, 0.36);
  g.quadraticCurveTo(0.94, 0.50, 0.72, 0.64);
  g.lineTo(0.34, 0.64);
  g.closePath(); g.fill(); g.stroke();
  // fins
  g.fillStyle = PAPER;
  g.beginPath();
  g.moveTo(0.46, 0.36); g.lineTo(0.40, 0.18); g.lineTo(0.58, 0.36); g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(0.46, 0.64); g.lineTo(0.40, 0.82); g.lineTo(0.58, 0.64); g.closePath(); g.fill();
}

/** A rolling wall of dust: three arcs and the grit inside them. */
function storm(g, A) {
  g.strokeStyle = A;
  g.lineWidth = 0.095;
  for (let i = 0; i < 3; i++) {
    const y = 0.28 + i * 0.22;
    g.beginPath();
    g.moveTo(0.08, y);
    g.lineTo(0.62 + (i === 1 ? 0.16 : 0), y);
    g.stroke();
  }
  g.strokeStyle = CYAN;
  g.lineWidth = 0.085;
  g.beginPath();
  g.arc(0.62, 0.28, 0.13, -1.4, 1.9);
  g.stroke();
  g.beginPath();
  g.arc(0.68, 0.72, 0.13, -1.4, 1.9);
  g.stroke();
  g.fillStyle = PAPER;
  g.beginPath(); g.arc(0.90, 0.50, 0.055, 0, 6.2832); g.fill();
}

/** Rotation: a broken ring with an arrowhead, the universal "you spun". */
function trick(g, A) {
  g.strokeStyle = A;
  g.lineWidth = 0.12;
  g.beginPath();
  g.arc(0.5, 0.52, 0.32, 0.55, 5.4);
  g.stroke();
  g.fillStyle = A;
  g.beginPath();
  g.moveTo(0.66, 0.10); g.lineTo(0.92, 0.24); g.lineTo(0.64, 0.36);
  g.closePath(); g.fill();
  g.fillStyle = CYAN;
  g.beginPath(); g.arc(0.5, 0.52, 0.10, 0, 6.2832); g.fill();
}

/** Two chevrons: speed, everywhere in this UI. */
function boost(g, A) {
  g.strokeStyle = CYAN;
  g.lineWidth = 0.13;
  g.beginPath();
  g.moveTo(0.16, 0.20); g.lineTo(0.46, 0.50); g.lineTo(0.16, 0.80);
  g.stroke();
  g.strokeStyle = A;
  g.beginPath();
  g.moveTo(0.52, 0.20); g.lineTo(0.82, 0.50); g.lineTo(0.52, 0.80);
  g.stroke();
}

/** The boost pad as it is on the ground: a slab in perspective with chevrons. */
function pad(g, A) {
  g.fillStyle = '#191a1f';
  g.beginPath();
  g.moveTo(0.30, 0.24); g.lineTo(0.70, 0.24); g.lineTo(0.94, 0.80); g.lineTo(0.06, 0.80);
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.18)';
  g.lineWidth = 0.05; g.stroke();
  g.strokeStyle = A;
  g.lineWidth = 0.10;
  for (let i = 0; i < 2; i++) {
    const t = 0.30 + i * 0.26;
    const w = 0.16 + i * 0.13;
    g.beginPath();
    g.moveTo(0.5 - w, t + 0.16); g.lineTo(0.5, t); g.lineTo(0.5 + w, t + 0.16);
    g.stroke();
  }
}

/** Chequered flag on a pole. Used for the finish and for lap events. */
function flag(g, A) {
  g.strokeStyle = A;
  g.lineWidth = 0.10;
  g.beginPath(); g.moveTo(0.18, 0.08); g.lineTo(0.18, 0.94); g.stroke();
  const x0 = 0.24, y0 = 0.14, c = 0.17;
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 4; i++) {
      g.fillStyle = ((i + j) & 1) ? PAPER : '#1b1c20';
      g.fillRect(x0 + i * c, y0 + j * c, c, c);
    }
  }
  g.strokeStyle = 'rgba(0,0,0,.5)';
  g.lineWidth = 0.04;
  g.strokeRect(x0, y0, c * 4, c * 3);
}

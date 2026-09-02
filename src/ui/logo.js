/* ============================================================
   RALLY ROAD RASH — THE WORDMARK
   ------------------------------------------------------------
   The CSS wordmark it replaces was `font-weight:900` plus a skew, which is
   as far as the system font stack goes: on a machine without a heavy face it
   fell back to bold-ish, and the "logo" of the game was whatever the OS felt
   like. This draws it instead — same idea, but the weight comes from a
   stroke we control, so it is the same mark on every machine.

   Three things make it a logo rather than a heading:
     • the letterforms are drawn twice, a fat dark stroke under a fill, so
       they hold a silhouette against a bright 3D backdrop;
     • one chequer slash cuts the block on the diagonal — the only place in
       the whole UI a chequer appears, which is what makes it read as motor
       sport rather than as texture;
     • the leading R is the accent colour, exactly as the CSS mark had it.

   Still no web fonts (hard rule 1): the face is the system stack, and the
   condensing is a horizontal scale, so what varies between machines is the
   letter shapes, never the layout.
   ============================================================ */

const ACC = '#ff7a1a';
const PAPER = '#f3f0ea';

/** Authored block size. Everything below is in these units and scaled to fit. */
const BOX_W = 1000;
const BOX_H = 340;

/**
 * Paint the wordmark into a canvas, sizing the backing store from the
 * element's CSS box and the device pixel ratio.
 *
 * @param canvas  a <canvas>; if it has no laid-out size yet the call is a
 *                no-op and returns false, so the caller can retry after the
 *                screen is visible (a hidden screen measures 0).
 * @param opts    { lines: [string, string], accent, paper, sub }
 * @returns true if it painted
 */
export function drawLogo(canvas, opts) {
  if (!canvas) return false;
  const o = opts || {};
  const r = canvas.getBoundingClientRect();
  let cssW = r.width, cssH = r.height;
  if (!cssW || !cssH) {
    // Not laid out (hidden screen). Fall back to the attribute size so a
    // detached canvas still paints — the DOM path retries when shown.
    cssW = canvas.width || 0; cssH = canvas.height || 0;
    if (!cssW || !cssH) return false;
  }
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

  const g = canvas.getContext('2d');
  if (!g) return false;
  g.clearRect(0, 0, W, H);

  const lines = o.lines || ['RALLY ROAD', 'RASH'];
  const acc = o.accent || ACC;
  const paper = o.paper || PAPER;

  // Fit the authored block into the canvas, preserving its aspect.
  const k = Math.min(W / BOX_W, H / BOX_H);
  g.save();
  g.translate((W - BOX_W * k) * 0.5, (H - BOX_H * k) * 0.5);
  g.scale(k, k);

  /* The skew and the squeeze. Applied as a transform rather than a font
     variant because no condensed face is guaranteed anywhere. */
  g.transform(0.88, 0, -0.16, 1, 78, 0);

  const F = 168;                       // cap height of the authored block
  g.font = `italic 900 ${F}px ${o.font || 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'}`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.lineJoin = 'round';

  const y0 = 152, y1 = 152 + F * 0.94;
  paintLine(g, lines[0], 0, y0, acc, paper, true);
  paintLine(g, lines[1] || '', 0, y1, acc, paper, false);

  /* The chequer slash. Drawn last and clipped to a thin diagonal band so it
     cuts ACROSS the letters — a slash beside the word is a decoration, a
     slash through it is a logo. */
  chequerSlash(g, y1);

  g.restore();
  return true;
}

/**
 * One line: a heavy dark stroke for the silhouette, then the fill, then the
 * leading character re-drawn in the accent when it is the first line.
 */
function paintLine(g, text, x, y, acc, paper, leadAccent) {
  if (!text) return;
  g.lineWidth = 16;
  g.strokeStyle = 'rgba(0,0,0,.62)';
  g.strokeText(text, x, y);
  g.fillStyle = paper;
  g.fillText(text, x, y);
  if (leadAccent && text.length) {
    const head = text[0];
    g.lineWidth = 14;
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.strokeText(head, x, y);
    g.fillStyle = acc;
    g.fillText(head, x, y);
  }
}

/**
 * A four-square chequer band running bottom-left to top-right across the
 * block. `clip` keeps it inside the band; `globalCompositeOperation` is left
 * alone deliberately — the band sits ON the letters, which is the point.
 */
function chequerSlash(g, baseY) {
  const w = 620, h = 46;
  g.save();
  g.translate(430, baseY - 128);
  g.rotate(-0.30);
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
  const c = h * 0.5;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < Math.ceil(w / c); i++) {
      const on = (i + j) & 1;
      g.fillStyle = on ? 'rgba(243,240,234,.92)' : 'rgba(12,12,15,.88)';
      g.fillRect(i * c, j * c, c, c);
    }
  }
  g.restore();
}

/**
 * Paint every `<canvas class="logo">` under `root`. Called on show() and on
 * resize; a canvas that is not laid out yet is skipped and picked up by the
 * next call, which is why this never throws on a hidden screen.
 */
export function paintLogos(root, opts) {
  const scope = root || document;
  const list = scope.querySelectorAll('canvas.logo');
  for (let i = 0; i < list.length; i++) {
    const cv = list[i];
    drawLogo(cv, {
      lines: (cv.dataset.lines || 'RALLY ROAD|RASH').split('|'),
      accent: cv.dataset.accent || (opts && opts.accent),
    });
  }
}

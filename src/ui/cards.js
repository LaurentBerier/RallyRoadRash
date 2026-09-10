/* ============================================================
   RALLY ROAD RASH — STAGE AND MACHINE CARD PAINTING
   ------------------------------------------------------------
   Split out of ui.js, which had grown past 1200 lines with two hundred of
   them being canvas drawing that nothing else in the screen logic touched.

   STAGE PREVIEW ART
   The stage cards used to be four paragraphs of text in four identical
   boxes, which told a player nothing about what they were choosing. This
   draws the actual racing line straight from the track module's `path` — so
   the picture cannot drift out of step with the track, because it IS the
   track — with the start line, the routes and every jump marked, an
   elevation strip along the bottom, and key art behind the lot when there is
   any.

   KEY ART IS OPTIONAL AND USUALLY ABSENT (docs/ARCHITECTURE.md §6.11).
   `assets.get('art/<id>')` returns null on a normal install, so the backdrop
   here is a *third* layer: art if we have it, otherwise the theme gradient
   that has always been there. The lap, the jumps and the elevation are drawn
   on top either way, so the card carries exactly the same information with
   the assets directory renamed aside.

   MACHINE ART
   Key art per machine when assets/ has it — the garage is selling four
   vehicles and a pictogram was never going to do that — and a procedural
   side profile per bodyStyle when it does not. The silhouette is the
   FALLBACK, not dead code: it is what the strip draws with the assets
   directory renamed aside, and it reads as a sponsor-plate pictogram, which
   is the house style for a card with no photograph behind it.
   ============================================================ */

/* One skin per theme. `thunder` is P6's entry in the theme tables that wave 6
   asks every owner to fill in (ARCHITECTURE §6.1) — violet, because the bonus
   stunt stage is the one place in the game that is not trying to look like a
   real desert. */
export const STAGE_SKIN = {
  training: { ink: '#2ad2ff', ground: '#2b2f36', wash: '#1a2026' },
  canyon: { ink: '#ff7a1a', ground: '#3a2820', wash: '#241a15' },
  forest: { ink: '#4fd07a', ground: '#243026', wash: '#161f19' },
  volcano: { ink: '#ff5a2c', ground: '#33211d', wash: '#1d1211' },
  thunder: { ink: '#c46bff', ground: '#2a2336', wash: '#171325' },
};

export function skinFor(theme) { return STAGE_SKIN[theme] || STAGE_SKIN.training; }

export function toCss(c, fallback) {
  if (typeof c === 'number') return '#' + (c >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string' && c) return c;
  return fallback;
}

/** Closed-loop length of an authored path, in metres. */
export function splineLength(path) {
  if (!path || path.length < 2) return 0;
  let L = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    L += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return L;
}

/**
 * A THREE texture's underlying drawable, or null.
 *
 * `assets.get()` hands back a THREE.Texture whose `image` is the HTMLImage we
 * can blit straight into a 2D context — but a DataArrayTexture's image is a
 * plain `{data,width,height}` object and drawImage would throw on it. Duck-type
 * rather than instanceof so this stays honest about what canvas can actually
 * consume.
 */
export function artImage(tex) {
  const img = tex && tex.image;
  if (!img) return null;
  const n = img.nodeName;
  if (n !== 'IMG' && n !== 'CANVAS' && n !== 'VIDEO') return null;
  return (img.width && img.height) ? img : null;
}

/**
 * Fit a set of world-space points into the canvas with a margin, returning a
 * projector. Aspect is preserved: a long thin stage must LOOK long and thin,
 * or the preview is lying about the shape of the lap.
 */
function fitter(pts, W, H, pad) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  const sx = (W - pad * 2) / Math.max(1, x1 - x0);
  const sz = (H - pad * 2) / Math.max(1, z1 - z0);
  const s = Math.min(sx, sz);
  const ox = (W - (x1 - x0) * s) * 0.5 - x0 * s;
  const oz = (H - (z1 - z0) * s) * 0.5 - z0 * s;
  return (p) => [p.x * s + ox, p.z * s + oz];
}

/** Catmull-Rom through the control points, so the preview curves like the road. */
function smoothLoop(path, steps = 6) {
  const n = path.length, out = [];
  const at = (i) => path[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   Route paths. `routes` generalises `shortcut` (ARCHITECTURE §6.1) and both
   may be present while P3's change lands, so read whichever exists and never
   draw the same line twice.
   ------------------------------------------------------------------ */
function routePaths(def) {
  const out = [];
  if (Array.isArray(def.routes)) {
    for (const r of def.routes) if (r && Array.isArray(r.path) && r.path.length > 1) out.push(r.path);
  }
  if (!out.length && def.shortcut && Array.isArray(def.shortcut.path)) out.push(def.shortcut.path);
  return out;
}

/**
 * The elevation strip: a small area chart of `trackData.elev` along the
 * bottom edge. It answers the one question the plan view cannot — is this
 * lap flat or is it a mountain — and it is 64 floats, so it costs nothing.
 * Absent (P3's field has not landed, or a bonus stage that never built one)
 * simply means no strip.
 */
function elevStrip(g, elev, W, H, skin) {
  const n = elev && elev.length ? elev.length : 0;
  if (n < 4) return;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = elev[i];
    if (!isFinite(v)) continue;
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  if (!isFinite(mn) || mx - mn < 0.5) return;      // dead flat: the strip would lie
  const h = H * 0.22, y0 = H - h - 2, span = mx - mn;

  g.save();
  g.beginPath();
  g.moveTo(2, H - 2);
  for (let i = 0; i < n; i++) {
    const x = 2 + (i / (n - 1)) * (W - 4);
    const y = y0 + h - ((elev[i] - mn) / span) * (h - 3);
    g.lineTo(x, y);
  }
  g.lineTo(W - 2, H - 2);
  g.closePath();
  g.fillStyle = 'rgba(0,0,0,.42)';
  g.fill();
  g.strokeStyle = skin.ink;
  g.globalAlpha = 0.72;
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = 2 + (i / (n - 1)) * (W - 4);
    const y = y0 + h - ((elev[i] - mn) / span) * (h - 3);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  g.globalAlpha = 1;
  // the drop, in metres — the number is the whole reason for the strip
  g.fillStyle = 'rgba(255,255,255,.62)';
  g.font = '700 10px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillText(`${Math.round(span)} m`, W - 5, H - 4);
  g.restore();
}

/**
 * Paint a stage card.
 *
 * @param canvas  the card's <canvas class="stage-art">
 * @param def     the track module's default export
 * @param locked  true if the player has not earned it
 * @param opts    { art: THREE.Texture|null, elev: Float32Array|null,
 *                  mapOnly: boolean }
 *                All optional; `art` and `elev` are usually absent — see the
 *                header. `mapOnly` refuses the photograph even when one was
 *                passed: the stage-select hero already IS that painting at
 *                full size, so the map drawn over it wants the theme gradient
 *                and the contour rings, which is exactly the no-art branch
 *                below. Everything after the backdrop is identical either way,
 *                so the card path is untouched when the flag is absent.
 */
export function drawStage(canvas, def, locked, opts) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const o = opts || 0;
  const W = canvas.width, H = canvas.height;
  const skin = skinFor(def.theme);
  g.clearRect(0, 0, W, H);

  /* ---- backdrop: key art if the assets directory has any, otherwise the
     theme gradient this card has always used. The art is dimmed hard and
     desaturated toward the theme wash, because everything that follows is
     line work and a photograph at full contrast eats all of it. ---- */
  const img = o.mapOnly ? null : artImage(o.art);
  if (img) {
    // cover-fit: never letterbox, never distort
    const s = Math.max(W / img.width, H / img.height);
    const dw = img.width * s, dh = img.height * s;
    g.save();
    g.globalAlpha = 0.85;
    g.drawImage(img, (W - dw) * 0.5, (H - dh) * 0.5, dw, dh);
    g.restore();
    const veil = g.createLinearGradient(0, 0, 0, H);
    veil.addColorStop(0, 'rgba(6,6,9,.34)');
    veil.addColorStop(1, 'rgba(6,6,9,.80)');
    g.fillStyle = veil; g.fillRect(0, 0, W, H);
  } else {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, skin.ground); bg.addColorStop(1, skin.wash);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
  }

  const loop = smoothLoop(def.path, 7);
  const routes = routePaths(def);
  let all = loop;
  for (const r of routes) all = all.concat(r);
  const P = fitter(all, W, H, 18);

  // contour rings behind the road: cheap, and it stops the card reading flat.
  // Skipped over key art, where they read as scratches on the photograph.
  if (!img) {
    g.save();
    g.globalAlpha = 0.16;
    g.strokeStyle = skin.ink; g.lineWidth = 1;
    for (let r = 1; r <= 3; r++) {
      g.beginPath();
      for (let i = 0; i <= loop.length; i++) {
        const p = loop[i % loop.length];
        const q = P({ x: p.x * (1 + r * 0.10), z: p.z * (1 + r * 0.10) });
        i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
      }
      g.closePath(); g.stroke();
    }
    g.restore();
  }

  const trace = (pts, closed) => {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const q = P(pts[i]);
      i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
    }
    if (closed) g.closePath();
  };

  // road: a wide dark casing under a bright core, which is the only way a
  // 3 px line reads as a ROAD and not as a graph
  g.lineJoin = g.lineCap = 'round';
  trace(loop, true); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 9; g.stroke();
  trace(loop, true); g.strokeStyle = 'rgba(255,255,255,.82)'; g.lineWidth = 4.5; g.stroke();

  for (const rp of routes) {
    trace(rp, false);
    g.setLineDash([7, 6]);
    g.strokeStyle = skin.ink; g.lineWidth = 3; g.stroke();
    g.setLineDash([]);
  }

  /* Jumps. The preview's whole job on this game is to say WHERE THE AIR IS,
     so a gap jump gets a filled diamond and a plain kicker a small tick. The
     wave-6 schema adds `kind`, which lets a table and a drop read differently
     from a kicker — a square for a table (you land ON it), a downward wedge
     for a drop. A def written before that field simply has none, and falls
     back to the height/gap test that has always driven this. */
  const L = splineLength(def.path);
  for (const j of (def.jumps || [])) {
    const t = (j.s / Math.max(1, L)) * loop.length;
    const p = loop[Math.floor(t) % loop.length];
    const q = P(p);
    const hero = !!j.gap || j.h >= 3.0 || j.kind === 'drop';
    g.beginPath();
    if (j.kind === 'table') {
      const r = 6.5;
      g.rect(q[0] - r, q[1] - r, r * 2, r * 2);
      g.fillStyle = skin.ink; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1.5; g.stroke();
    } else if (j.kind === 'drop') {
      const r = 8;
      g.moveTo(q[0] - r, q[1] - r * 0.6); g.lineTo(q[0] + r, q[1] - r * 0.6);
      g.lineTo(q[0], q[1] + r); g.closePath();
      g.fillStyle = skin.ink; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1.5; g.stroke();
    } else if (hero) {
      const r = 8;
      g.moveTo(q[0], q[1] - r); g.lineTo(q[0] + r, q[1]);
      g.lineTo(q[0], q[1] + r); g.lineTo(q[0] - r, q[1]); g.closePath();
      g.fillStyle = skin.ink; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1.5; g.stroke();
    } else {
      g.arc(q[0], q[1], 3.2, 0, 6.2832);
      g.fillStyle = 'rgba(255,255,255,.7)'; g.fill();
    }
  }

  // boost pads: a small cyan chevron on the line, the same colour they are
  // in the world and on the minimap
  for (const pd of (def.pads || [])) {
    const t = (pd.s / Math.max(1, L)) * loop.length;
    const p = loop[Math.floor(t) % loop.length];
    const q = P(p);
    g.strokeStyle = '#4fd8e8'; g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(q[0] - 4, q[1] + 3); g.lineTo(q[0], q[1] - 3); g.lineTo(q[0] + 4, q[1] + 3);
    g.stroke();
  }

  // start line
  {
    const a = P(loop[0]), b = P(loop[1]);
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.max(1e-3, Math.hypot(dx, dz));
    const nx = -dz / len * 8, nz = dx / len * 8;
    g.beginPath();
    g.moveTo(a[0] - nx, a[1] - nz); g.lineTo(a[0] + nx, a[1] + nz);
    g.strokeStyle = '#f2efe6'; g.lineWidth = 4; g.stroke();
    g.strokeStyle = '#15161a'; g.lineWidth = 4; g.setLineDash([3, 3]); g.stroke();
    g.setLineDash([]);
  }

  elevStrip(g, o.elev || def.elev, W, H, skin);

  // No locked wash here: .pick.locked already drops the whole card to 44 %
  // opacity, and dimming twice made the lap shape unreadable — which is the
  // one thing a locked card still needs to sell.
  void locked;
}

/* ============================================================
   STAGE CHIPS
   ------------------------------------------------------------
   The little labels under the preview. Returned as data rather than markup
   so ui.js keeps ownership of escaping and of the DOM.

   Every field this reads is from the wave-6 track schema and every one is
   OPTIONAL: a track module written before §6.1 lands produces exactly the
   chip set the cards had before, which is the whole degradation story here.
   ============================================================ */

const KIND_LABEL = { kicker: 'KICKER', table: 'TABLE', hip: 'HIP', drop: 'DROP' };
const DIFF_LABEL = ['GENTLE', 'STEADY', 'QUICK', 'SAVAGE'];

/**
 * @param def   track definition
 * @returns [{ text, kind }] where kind is '' | 'info' | 'hot' | 'bonus'
 */
export function stageChips(def) {
  const out = [];
  const laps = def.laps || 1;
  out.push({ text: `${laps} LAP${laps > 1 ? 'S' : ''}`, kind: '' });
  const km = Math.round(splineLength(def.path) / 100) / 10;
  if (km > 0) out.push({ text: `${km} KM`, kind: '' });

  if (def.bonus) out.push({ text: '★ BONUS STAGE', kind: 'bonus' });

  if (typeof def.difficulty === 'number') {
    const i = Math.max(0, Math.min(3, Math.floor(def.difficulty * 4)));
    out.push({ text: DIFF_LABEL[i], kind: def.difficulty >= 0.75 ? 'hot' : '' });
  }

  /* Set pieces. A NAMED jump gets its own chip — a stage with "THE ANVIL" on
     it is selling that jump, and a count of four kickers is not. Unnamed ones
     collapse into counts by kind so the chip row stays a row. */
  const jumps = def.jumps || [];
  const counts = Object.create(null);
  let named = 0;
  for (const j of jumps) {
    if (j.name && named < 2) { out.push({ text: j.name.toUpperCase(), kind: 'hot' }); named++; continue; }
    const k = KIND_LABEL[j.kind] || ((j.gap || j.h >= 3.0) ? 'BIG AIR' : 'KICKER');
    counts[k] = (counts[k] || 0) + 1;
  }
  for (const k in counts) {
    out.push({ text: `${counts[k]} ${k}${counts[k] > 1 && k !== 'BIG AIR' ? 'S' : ''}`, kind: 'info' });
  }

  const banks = (def.banks || []).length;
  if (banks) out.push({ text: `${banks} BANKED`, kind: 'info' });
  const whoops = (def.whoops || []).length;
  if (whoops) out.push({ text: `${whoops} WHOOP${whoops > 1 ? 'S' : ''}`, kind: 'info' });
  const pads = (def.pads || []).length;
  if (pads) out.push({ text: `${pads} BOOST PAD${pads > 1 ? 'S' : ''}`, kind: 'info' });

  const routes = def.routes ? def.routes.length : (def.shortcut ? 1 : 0);
  if (routes) out.push({ text: routes > 1 ? `${routes} ROUTES` : 'SHORTCUT', kind: 'info' });

  return out;
}

/* ============================================================
   MACHINE ART
   ------------------------------------------------------------
   Two layers, exactly like drawStage: key art when assets/ has a painting of
   this machine, and the procedural silhouette when it does not — which is
   still the normal case (ARCHITECTURE §6.11), and is the whole reason the
   silhouette below is not deleted.
   ============================================================ */
/**
 * @param canvas  the card's <canvas class="car-art">
 * @param spec    the vehicle spec (color, bodyStyle, id)
 * @param opts    { art: THREE.Texture|null } — optional and usually absent
 */
export function drawCar(canvas, spec, opts) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const o = opts || 0;
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);

  /* ---- key art. The paintings are composed with a dark left third left
     free for text, and the veil below guarantees that rather than trusting
     four JPEGs to keep agreeing about it — the garage strip reads as one set
     with the hero because both carry the same wash.

     And then STOP. The silhouette is a STAND-IN for a picture of the machine;
     drawing the pictogram on top of the painting would be two cars in one
     box, and the number plate is part of that same stand-in treatment. ---- */
  const img = artImage(o.art);
  if (img) {
    // cover-fit: never letterbox, never distort
    const s = Math.max(W / img.width, H / img.height);
    const dw = img.width * s, dh = img.height * s;
    g.drawImage(img, (W - dw) * 0.5, (H - dh) * 0.5, dw, dh);
    const veil = g.createLinearGradient(0, 0, W, 0);
    veil.addColorStop(0, 'rgba(6,6,9,.80)');
    veil.addColorStop(0.36, 'rgba(6,6,9,.24)');
    veil.addColorStop(1, 'rgba(6,6,9,.06)');
    g.fillStyle = veil; g.fillRect(0, 0, W, H);
    return;
  }

  const body = toCss(spec && spec.color, '#ff7a1a');
  const style = (spec && spec.bodyStyle) || 'buggy';
  const dark = 'rgba(0,0,0,.55)';

  // ground shadow — sells "vehicle" before a single panel is drawn
  const grad = g.createLinearGradient(0, H * 0.82, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,.35)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, H * 0.82, W, H * 0.18);

  const gy = H * 0.80;                     // ground line
  const s = W / 416;                       // art is authored at 416 wide

  const wheel = (cx, r) => {
    g.fillStyle = '#15161a';
    g.beginPath(); g.arc(cx, gy - r, r, 0, 6.2832); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(cx, gy - r, r - 2 * s, 0, 6.2832); g.stroke();
    g.fillStyle = body;
    g.beginPath(); g.arc(cx, gy - r, r * 0.36, 0, 6.2832); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1.4 * s;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * 6.2832;
      g.beginPath(); g.moveTo(cx, gy - r);
      g.lineTo(cx + Math.cos(a) * r * 0.82, gy - r + Math.sin(a) * r * 0.82); g.stroke();
    }
  };

  const path = (pts, fill, stroke) => {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) i ? g.lineTo(pts[i] * s, pts[i + 1] * s) : g.moveTo(pts[i] * s, pts[i + 1] * s);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2 * s; g.stroke(); }
  };

  if (style === 'truck') {
    const r = 34 * s;
    wheel(104 * s, r); wheel(316 * s, r);
    // ladder frame + tray
    path([56, 92, 372, 92, 372, 106, 56, 106], dark);
    // cab + bed
    path([96, 92, 104, 46, 214, 40, 236, 92], body, 'rgba(255,255,255,.22)');
    path([236, 92, 236, 62, 368, 62, 368, 92], body, 'rgba(255,255,255,.16)');
    // glass
    path([116, 86, 122, 56, 204, 52, 218, 86], 'rgba(150,205,225,.35)');
    // bullbar + light bar
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillRect(44 * s, 66 * s, 12 * s, 34 * s);
    g.fillRect(108 * s, 30 * s, 96 * s, 9 * s);
  } else if (style === 'wedge') {
    const r = 27 * s;
    wheel(112 * s, r); wheel(310 * s, r);
    path([48, 106, 384, 106, 384, 114, 48, 114], dark);
    // long low wedge: nose at the left, cab pushed forward
    path([44, 104, 92, 74, 168, 58, 268, 60, 356, 82, 386, 104], body, 'rgba(255,255,255,.22)');
    path([120, 72, 176, 46, 254, 48, 288, 70], 'rgba(150,205,225,.35)');
    // rear wing
    g.fillStyle = body;
    g.fillRect(330 * s, 48 * s, 62 * s, 8 * s);
    g.fillRect(352 * s, 52 * s, 8 * s, 28 * s);
    // splitter
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.fillRect(38 * s, 100 * s, 46 * s, 6 * s);
  } else if (style === 'bike') {
    /* Motocross: two big wheels close together, a rider standing on the pegs.
       The rider is most of the read — a bike without one is a bicycle. */
    const r = 41 * s;
    const fx = 300 * s, rx = 150 * s;            // hub centres
    const hy = gy - r;
    wheel(rx, r); wheel(fx, r);
    // frame: cases, spar to the headstock, swingarm back to the rear hub
    g.strokeStyle = body; g.lineWidth = 9 * s; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(258 * s, hy - 42 * s); g.lineTo(214 * s, hy - 20 * s);
    g.lineTo(196 * s, hy + 6 * s); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.30)'; g.lineWidth = 7 * s;
    g.beginPath(); g.moveTo(196 * s, hy + 4 * s); g.lineTo(rx, hy); g.stroke();  // swingarm
    // forks
    g.strokeStyle = 'rgba(220,226,232,.85)'; g.lineWidth = 6 * s;
    g.beginPath(); g.moveTo(272 * s, hy - 50 * s); g.lineTo(fx, hy); g.stroke();
    // tank / shroud + seat
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(226 * s, hy - 30 * s); g.lineTo(268 * s, hy - 46 * s);
    g.lineTo(276 * s, hy - 28 * s); g.lineTo(232 * s, hy - 14 * s); g.closePath(); g.fill();
    g.fillStyle = 'rgba(20,22,26,.92)';
    g.fillRect(180 * s, hy - 34 * s, 56 * s, 9 * s);                   // seat
    g.fillStyle = body;
    g.beginPath();                                                     // rear fender
    g.moveTo(158 * s, hy - 46 * s); g.lineTo(196 * s, hy - 34 * s);
    g.lineTo(190 * s, hy - 26 * s); g.lineTo(156 * s, hy - 38 * s); g.closePath(); g.fill();
    g.beginPath();                                                     // front fender
    g.moveTo(286 * s, hy - 40 * s); g.lineTo(330 * s, hy - 30 * s);
    g.lineTo(326 * s, hy - 21 * s); g.lineTo(284 * s, hy - 32 * s); g.closePath(); g.fill();
    // bars
    g.strokeStyle = 'rgba(220,226,232,.9)'; g.lineWidth = 4 * s;
    g.beginPath(); g.moveTo(272 * s, hy - 52 * s); g.lineTo(288 * s, hy - 72 * s); g.stroke();
    // rider: boots on the pegs, hips back, shoulders over the bars
    const dk = 'rgba(24,26,31,.95)';
    g.strokeStyle = dk; g.lineWidth = 11 * s;
    g.beginPath();
    g.moveTo(206 * s, hy - 8 * s); g.lineTo(200 * s, hy - 46 * s);
    g.lineTo(214 * s, hy - 74 * s); g.stroke();                        // legs
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 14 * s;
    g.beginPath(); g.moveTo(214 * s, hy - 74 * s); g.lineTo(244 * s, hy - 100 * s); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 8 * s;
    g.beginPath();
    g.moveTo(244 * s, hy - 100 * s); g.lineTo(272 * s, hy - 92 * s);
    g.lineTo(288 * s, hy - 72 * s); g.stroke();                        // arm to the bar
    g.fillStyle = '#eef1f5';
    g.beginPath(); g.arc(258 * s, hy - 112 * s, 13 * s, 0, 6.2832); g.fill();  // helmet
    g.fillStyle = 'rgba(20,26,32,.85)';
    g.fillRect(262 * s, hy - 117 * s, 14 * s, 7 * s);                  // visor
    g.fillStyle = '#eef1f5';
    g.beginPath();                                                     // peak
    g.moveTo(266 * s, hy - 122 * s); g.lineTo(292 * s, hy - 128 * s);
    g.lineTo(292 * s, hy - 122 * s); g.lineTo(266 * s, hy - 114 * s); g.closePath(); g.fill();
  } else {
    // buggy: exposed wheels, visible roll cage, short body
    const r = 31 * s;
    wheel(100 * s, r); wheel(322 * s, r);
    path([70, 96, 352, 96, 352, 108, 70, 108], dark);
    path([84, 96, 100, 70, 300, 66, 344, 96], body, 'rgba(255,255,255,.22)');
    // roll cage
    g.strokeStyle = 'rgba(255,255,255,.62)'; g.lineWidth = 5 * s; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(120 * s, 92 * s); g.lineTo(156 * s, 34 * s);
    g.lineTo(258 * s, 34 * s); g.lineTo(298 * s, 92 * s);
    g.moveTo(258 * s, 34 * s); g.lineTo(316 * s, 74 * s);
    g.stroke();
    // seat + spare
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(186 * s, 48 * s, 34 * s, 42 * s);
    g.fillStyle = '#15161a';
    g.beginPath(); g.arc(332 * s, 62 * s, 17 * s, 0, 6.2832); g.fill();
  }

  // number plate — the sponsor-plate cue that ties the three cards together
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.fillRect(W - 62 * s, 18 * s, 46 * s, 26 * s);
  g.fillStyle = '#0d0d0f';
  g.font = `italic 800 ${20 * s}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String((spec && spec.id ? spec.id.length : 4) % 9 + 1), W - 39 * s, 32 * s);
}

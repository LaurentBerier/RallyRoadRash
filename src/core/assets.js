/* ============================================================
   RALLY ROAD RASH — optional image assets
   ------------------------------------------------------------
   The game is procedural and stays playable with this directory empty. What
   lives in `assets/` is a LOOK UPGRADE: skyline panoramas behind the vista
   ring, photographic ground detail under the shader's own grain, key art for
   the stage cards and the title screen. Every consumer must render correctly
   when `get()` returns null, and every one is tested that way — rename
   `assets/` aside and the game must still run and still look deliberate.

   Rules that make that promise keepable:

     • Nothing here blocks. Boot fires loadAssets() and carries on; textures
       appear when they appear, and a consumer that has already drawn its
       procedural fallback simply keeps it until the next material rebuild.
     • Relative URLs only, and crossOrigin 'anonymous'. The game is served
       from Sandscape in production and from a static server locally; an
       absolute URL to either one is wrong on the other, and a texture that
       taints the canvas breaks the screenshot path.
     • A missing or broken entry resolves to null, never to a rejected
       promise. One 404 must not cost the other twenty images.
     • Node never imports this file. It touches Image, and the harness checks
       run without a DOM.

   The manifest is a flat id -> spec map:

       { "sky/canyon":   { "url": "sky/canyon-skyline.jpg", "kind": "color" },
         "ground":       { "kind": "layers", "layers": ["ground/dirt.jpg", ...] },
         "art/canyon":   { "url": "art/canyon.jpg",         "kind": "color" } }

   `kind` decides the sampler set:
     color   sRGB, clamped, mipmapped   — panoramas and key art
     tile    sRGB, repeating, mipmapped — anything sampled by world position
     layers  one DataArrayTexture built from N tiles, in SURF order
   ============================================================ */
import * as THREE from 'three';

/** Ground layer order. Matches the surface ids the terrain shader samples by,
    minus LAVA — which is emissive and has no photographic answer. */
export const GROUND_LAYERS = ['dirt', 'sand', 'rock', 'mud', 'grass', 'road'];

const LAYER_SIZE = 512;      // every ground layer is resampled to this square

/**
 * Load whatever `assets/manifest.json` lists.
 * @param {string} manifestUrl  relative, e.g. 'assets/manifest.json'
 * @returns {Promise<Map<string, THREE.Texture|null>>} never rejects
 */
export async function loadAssets(manifestUrl = 'assets/manifest.json') {
  const out = new Map();
  let manifest = null;
  try {
    const res = await fetch(manifestUrl, { cache: 'force-cache' });
    if (res.ok) manifest = await res.json();
  } catch { /* no manifest is the normal case, not an error */ }
  if (!manifest || typeof manifest !== 'object') return out;

  const base = manifestUrl.replace(/[^/]*$/, '');       // 'assets/'
  const jobs = [];
  for (const id of Object.keys(manifest)) {
    const spec = manifest[id] || {};
    if (spec.kind === 'layers') jobs.push(loadLayers(base, spec).then(t => out.set(id, t)));
    else jobs.push(loadOne(base + spec.url, spec.kind).then(t => out.set(id, t)));
  }
  await Promise.all(jobs);
  return out;
}

/* ------------------------------------------------------------------
   one image
   ------------------------------------------------------------------ */
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadOne(url, kind) {
  const img = await loadImage(url);
  if (!img) return null;
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  const repeat = kind === 'tile';
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------
   ground layers -> one DataArrayTexture
   ------------------------------------------------------------------
   Six surfaces sampled by world position want six bindings, or one array
   texture and an integer. The array costs one sampler and lets the shader
   pick a layer from the surface id it already reads.

   Each tile is drawn four times with a cross-fade before it is read back —
   the same trick noiseCanvas() uses for its `tile` option. A generated image
   is never actually seamless, and a hard seam every 12 m across an open
   desert is the most obvious artefact in the game.
   ------------------------------------------------------------------ */
async function loadLayers(base, spec) {
  const urls = spec.layers || [];
  if (!urls.length) return null;
  const imgs = await Promise.all(urls.map(u => loadImage(base + u)));
  if (imgs.every(i => !i)) return null;

  const N = imgs.length;
  const S = LAYER_SIZE;
  const data = new Uint8Array(S * S * 4 * N);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });

  for (let i = 0; i < N; i++) {
    const img = imgs[i];
    g.clearRect(0, 0, S, S);
    if (img) {
      /* Four copies offset by half a tile, cross-faded by the same weights in
         both axes. What is a seam in one copy is the middle of another, and
         the weights sum to 1 everywhere, so nothing darkens. */
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.drawImage(img, 0, 0, S, S);
      g.globalCompositeOperation = 'lighter';
      const h = S * 0.5;
      for (const [ox, oy, a] of [[h, 0, 0.5], [0, h, 0.5], [h, h, 0.34]]) {
        g.globalAlpha = a;
        g.drawImage(img, ox - S, oy - S, S, S);
        g.drawImage(img, ox, oy - S, S, S);
        g.drawImage(img, ox - S, oy, S, S);
        g.drawImage(img, ox, oy, S, S);
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    } else {
      // A hole in the set is mid grey, not black: the shader multiplies this
      // in, and a missing layer must not turn its surface into a shadow.
      g.fillStyle = '#808080';
      g.fillRect(0, 0, S, S);
    }
    data.set(g.getImageData(0, 0, S, S).data, S * S * 4 * i);
  }

  const t = new THREE.DataArrayTexture(data, S, S, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------
   the handle main.js passes around
   ------------------------------------------------------------------ */
export class Assets {
  constructor(map) { this.map = map || new Map(); }
  /** The texture for `id`, or null. Callers must handle null. */
  get(id) { return this.map.get(id) || null; }
  /** True if anything at all loaded — for a one-line boot log. */
  get any() { return [...this.map.values()].some(Boolean); }
  dispose() {
    for (const t of this.map.values()) if (t) t.dispose();
    this.map.clear();
  }
}

/** The empty set. Every consumer's fallback path runs against this. */
export const NO_ASSETS = new Assets(new Map());

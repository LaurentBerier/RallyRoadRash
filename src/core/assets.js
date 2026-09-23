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

     • Boot awaits decoded images with bounded requests. Failed assets settle
       to procedural fallbacks before the menu is revealed.
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
     color    sRGB, clamped, mipmapped   — panoramas and key art
     tile     sRGB, repeating, mipmapped — anything sampled by world position
     layers   one DataArrayTexture built from N tiles, in SURF order
     equirect sRGB, EquirectangularReflectionMapping — a 2:1 panorama fed to
              PMREM as the environment map. No mipmaps: PMREM builds its own
              roughness chain, and a mip pyramid on the source only costs
              memory and blurs the pole rows.
     model    NOT LOADED HERE. The entry carries a url and nothing else; the
              map holds that url as a plain string and core/models.js fetches
              it lazily when something actually wants the mesh. A GLB is
              megabytes and blocks nothing at boot, which is the whole point.
              Read it with `assets.url(id)`, never `assets.get(id)`.
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
export async function loadAssets(manifestUrl = 'assets/manifest.json', onProgress = () => {}, quality = 'HIGH') {
  const out = new Map();
  let manifest = null;
  try {
    /* 'no-cache' REVALIDATES; it does not skip the cache. The manifest is a
       few hundred bytes and it is the index that names every other file, so
       serving it stale is how a shipped asset becomes invisible: this was
       'force-cache', which uses the cached copy however old it is, and the
       wave-8 carcasses did not appear for anyone who had loaded the game
       before — the GLBs were pushed, the entries were live, and every
       returning player looked them up in last week's manifest and got null.
       A conditional request that comes back 304 costs nothing. The files the
       manifest POINTS at still cache normally; they are content, not index. */
    const res = await fetch(manifestUrl, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
    if (res.ok) manifest = await res.json();
  } catch { /* no manifest is the normal case, not an error */ }
  if (!manifest || typeof manifest !== 'object') return out;

  const base = manifestUrl.replace(/[^/]*$/, '');       // 'assets/'
  const jobs = [];
  for (const id of Object.keys(manifest)) {
    const spec = manifest[id] || {};
    if (spec.kind === 'model') {
      // A url, resolved against the manifest, and no request. models.js does
      // the fetching; a missing file is its problem and its fallback.
      if (spec.url) out.set(id, base + spec.url);
    } else if (spec.kind === 'layers') {
      jobs.push(loadLayers(base, spec).then(t => out.set(id, t)));
    } else {
      const low=['LOW','MEDIUM'].includes(String(quality).toUpperCase());
      jobs.push(loadOne(base + (low && spec.lowUrl || spec.url), spec.kind).then(t => out.set(id, t)));
    }
  }
  let completed = 0;
  await Promise.all(jobs.map(job => job.finally(() => onProgress(++completed / jobs.length))));
  onProgress(1);
  return out;
}

/* ------------------------------------------------------------------
   one image
   ------------------------------------------------------------------ */
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => { finish(null); img.src = ''; }, 15000);
    img.onload = async () => {
      try { await img.decode(); finish(img); } catch { finish(null); }
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

async function loadOne(url, kind) {
  const img = await loadImage(url);
  if (!img) return null;
  const t = new THREE.Texture(img);
  t.colorSpace = kind==='data-tile' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (kind === 'equirect') {
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.wrapS = THREE.RepeatWrapping;          // the seam is a real wrap in longitude
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }
  const repeat = kind === 'tile' || kind === 'data-tile';
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
      /* Four copies offset by half a tile, cross-faded: what is a seam in one
         copy is the middle of another.

         The weights have to SUM TO ONE, because this is a MEAN and not a
         stack. Drawing the three offset copies with 'lighter' adds them
         instead, at a total weight of 2.34 — which came back as a solid 255
         slab for dirt, sand and road, took the shader's `gt` from about 1 to
         4.6, and left the near ground with an albedo of 1.7. Ground that
         reflects 170 % of the light falling on it renders at 2.5 in linear:
         through the tone curve that is white, and it is also well past the
         bloom threshold, so the ground itself veiled the whole frame. Drawing
         with 'source-over' at 1/2, 1/3, 1/4 leaves the running result the
         plain average of the four copies at every pixel. */
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.drawImage(img, 0, 0, S, S);
      const h = S * 0.5;
      let k = 1;
      // The authored gravel is already a tile; averaging four copies erases
      // its aggregate and the relief that the terrain shader derives from it.
      const offsets = spec.seamless?.includes(i) ? [] : [[h, 0], [0, h], [h, h]];
      for (const [ox, oy] of offsets) {
        g.globalAlpha = 1 / ++k;
        g.drawImage(img, ox - S, oy - S, S, S);
        g.drawImage(img, ox, oy - S, S, S);
        g.drawImage(img, ox - S, oy, S, S);
        g.drawImage(img, ox, oy, S, S);
      }
      g.globalAlpha = 1;
    } else {
      // A hole in the set is mid grey, not black: the shader multiplies this
      // in, and a missing layer must not turn its surface into a shadow.
      g.fillStyle = '#808080';
      g.fillRect(0, 0, S, S);
    }
    const px = g.getImageData(0, 0, S, S);
    if (img) reexpose(px.data);
    data.set(px.data, S * S * 4 * i);
  }

  const t = new THREE.DataArrayTexture(data, S, S, N);
  t.anisotropy = 8;
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

/* 8-bit sRGB <-> linear. A 256-entry table because re-exposing six 512 x 512
   tiles is 1.6 M pixels and Math.pow on every one of them is a visible hitch
   on the boot thread. */
const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** 50 % sRGB grey in linear. Must stay equal to the terrain shader's divisor. */
const MID_GREY = 0.2158;

function linearToByte(v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Re-expose one tile in place so that each channel averages mid grey.
 *
 * The terrain shader divides this texture by that same MID_GREY and
 * multiplies the theme palette by the result, so the tile only behaves —
 * modulating around 1.0 — if it is genuinely exposed there. Photographs are
 * not, and there is no exposure a set of six can share: of the ones shipped
 * here sand averages 0.74 in linear and mud 0.09, three stops apart. Sand on
 * its own would put the ground's albedo past 2 even with the compositing
 * above fixed, which is the same failure by a slower road.
 *
 * Per CHANNEL rather than per luminance, which also neutralises each tile's
 * average colour cast. That is deliberate and it is the shader's stated
 * contract: the theme palette decides what a stage is made of, the photograph
 * supplies only its variation. This is the half of that contract that has to
 * live at load time — the shader cannot know what it was handed.
 */
function reexpose(d) {
  const n = d.length / 4;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += SRGB_TO_LINEAR[d[i]];
    g += SRGB_TO_LINEAR[d[i + 1]];
    b += SRGB_TO_LINEAR[d[i + 2]];
  }
  const kr = MID_GREY / Math.max(r / n, 1e-4);
  const kg = MID_GREY / Math.max(g / n, 1e-4);
  const kb = MID_GREY / Math.max(b / n, 1e-4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = linearToByte(SRGB_TO_LINEAR[d[i]] * kr);
    d[i + 1] = linearToByte(SRGB_TO_LINEAR[d[i + 1]] * kg);
    d[i + 2] = linearToByte(SRGB_TO_LINEAR[d[i + 2]] * kb);
  }
}

/* ------------------------------------------------------------------
   the handle main.js passes around
   ------------------------------------------------------------------ */
export class Assets {
  constructor(map) { this.map = map || new Map(); }
  /** The texture for `id`, or null. Callers must handle null.
      A `model` entry is a url string and deliberately does NOT answer here —
      handing a string to something expecting a Texture fails deep inside
      three, a long way from the manifest typo that caused it. */
  get(id) {
    const v = this.map.get(id);
    return (v && typeof v !== 'string') ? v : null;
  }
  /** The relative url for a `model` entry, or null. For core/models.js. */
  url(id) {
    const v = this.map.get(id);
    return typeof v === 'string' ? v : null;
  }
  /** True if anything at all loaded — for a one-line boot log. */
  get any() { return [...this.map.values()].some(Boolean); }
  dispose() {
    for (const t of this.map.values()) if (t && typeof t !== 'string') t.dispose();
    this.map.clear();
  }
}

/** The empty set. Every consumer's fallback path runs against this. */
export const NO_ASSETS = new Assets(new Map());

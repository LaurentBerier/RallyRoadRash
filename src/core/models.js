/* ============================================================
   RALLY ROAD RASH — optional glTF models
   ------------------------------------------------------------
   The sibling of core/assets.js, and it keeps the same promise: everything
   here is a LOOK UPGRADE over a procedural shape that already works. Rename
   `assets/` aside and every consumer must fall back and still look
   deliberate. A vehicle carcass, a crashed airliner tail — none of them are
   load-bearing, and none of them may block a frame or a boot.

   Why this is not just another `kind` inside assets.js:

     • assets.js loads its whole manifest at boot, because a texture is tens
       of kilobytes and the set is small. A GLB is megabytes. These load when
       something actually asks, and the asker draws its procedural shape until
       the promise lands.
     • assets.js hands back a THREE.Texture, which is immutable enough to
       share. A Group is not: it has exactly one parent, and two rivals on the
       same machine need two of them. So the cache holds a TEMPLATE and every
       call gets its own instance (see instantiate() below).

   Rules, inherited and enforced:

     • Relative URLs only. The game is served from Sandscape in production and
       from a static server locally; an absolute URL to one is wrong on the
       other. An absolute url here is a bug, so it fails loudly-once and
       resolves null rather than half-working in dev.
     • Never rejects. A 404, a truncated file, a Draco-compressed mesh we have
       no decoder for — all of them resolve to null, once, with one warning.
       A missing model must cost the caller nothing but its fallback.
     • Node never imports this file. GLTFLoader wants fetch, createImageBitmap
       and a URL base; the harness checks run without a DOM. dev/model-check
       reads the container bytes directly instead.
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** url -> Promise<THREE.Group|null> of the TEMPLATE. Never evicted during a
    session: the whole point is that stage two of a championship does not
    re-download the carcass it just drew. */
const _cache = new Map();

/** Templates that actually resolved, for clearModelCache(). */
const _templates = new Map();

let _loader = null;
function loader() {
  return _loader || (_loader = new GLTFLoader().setCrossOrigin('anonymous'));
}

/**
 * Load a glTF/GLB and hand back a fresh instance of it.
 *
 * @param {string} url  relative to the page, e.g. 'assets/models/hopper-carcass.glb'
 * @returns {Promise<THREE.Group|null>}  never rejects; null means "use your fallback"
 */
export function loadModel(url) {
  if (typeof url !== 'string' || !url) return Promise.resolve(null);
  if (!isOwnOrigin(url)) {
    warnOnce(url, 'off-origin url — models must be served from our own origin');
    return Promise.resolve(null);
  }
  let job = _cache.get(url);
  if (!job) {
    job = new Promise((resolve) => {
      loader().load(
        url,
        (gltf) => {
          const scene = gltf && gltf.scene;
          if (!scene) { warnOnce(url, 'no scene in the file'); resolve(null); return; }
          prepare(scene);
          _templates.set(url, scene);
          resolve(scene);
        },
        undefined,
        (err) => {
          // The normal case is a 404 for an asset we simply do not ship yet.
          warnOnce(url, (err && err.message) || 'load failed');
          resolve(null);
        }
      );
    });
    _cache.set(url, job);
  }
  return job.then(t => (t ? instantiate(t) : null));
}

/**
 * Release an instance returned by loadModel().
 *
 * Disposes ONLY what that instance owns — its cloned materials. Geometry and
 * textures belong to the cached template and are shared by every other
 * instance still on screen; disposing them here is how you get a rival's
 * carcass to vanish mid-race. Use clearModelCache() to give those back.
 */
export function disposeModel(group) {
  if (!group) return;
  group.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) { for (const one of m) if (one) one.dispose(); }
    else m.dispose();
  });
  if (group.parent) group.parent.remove(group);
}

/**
 * Drop the shared templates: geometry, textures, and the source materials.
 * Every live instance must be disposed first — after this call their geometry
 * is gone. Nothing in a normal session needs it; it exists so a leak test can
 * return to a known floor.
 */
export function clearModelCache() {
  for (const scene of _templates.values()) {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      const list = Array.isArray(m) ? m : (m ? [m] : []);
      for (const one of list) {
        for (const k of Object.keys(one)) {
          const v = one[k];
          if (v && v.isTexture) v.dispose();
        }
        one.dispose();
      }
    });
  }
  _templates.clear();
  _cache.clear();
}

/** How many distinct urls this session has fetched. For the boot log and QA. */
export function modelCacheSize() { return _templates.size; }

/* ------------------------------------------------------------------
   template preparation
   ------------------------------------------------------------------
   Done once per url, not once per instance. Anything here that depends on
   the CONSUMER (shadow flags, envMapIntensity, tint) is deliberately left
   alone — vehicle-art and props each have their own opinion and set it on
   the instance they were handed.
   ------------------------------------------------------------------ */
function prepare(scene) {
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    // An exporter that writes no normals leaves every face flat-lit black
    // under our directional key. Cheaper to fix here than to notice in game.
    if (o.geometry && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    if (o.geometry && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
    /* Warm the relief cache HERE, on the template, and not in the consumer.
       instantiate() clones every material, so two rivals on one machine would
       otherwise each run the same Sobel pass over the same pixels — and this
       is the one thing in the load path that costs milliseconds rather than
       microseconds. The consumer still has to ASK for it (that is its own
       opinion, like the shadow flags above), it just never pays for it. */
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m || m.normalMap) continue;
      const nm = normalFromAlbedo(m.map);
      /* Parked on the TEMPLATE material as an own enumerable property, purely
         so clearModelCache's key sweep can find and dispose it. Material.copy
         only copies the properties it knows about, so an instance never
         carries this — one owner, one dispose. */
      if (nm) m.derivedNormalMap = nm;
    }
  });
}

/* ------------------------------------------------------------------
   relief from albedo
   ------------------------------------------------------------------
   For the file that ships an albedo and no normal map. Its panel gaps, weld
   lines and rivets are PAINTED onto flat geometry, so they read from 40 m and
   disappear at 4 m, where the light should be catching them. Sobel over the
   albedo's luminance puts them back — it is right about where the detail is
   and only ever guessing how deep, which is why the consumer applies it at
   half strength.

   Every carcass in assets/ today ships its own normal map, so nothing calls
   this on the current asset set: prepare() above asks only for materials that
   have no normalMap, and vehicle-carcass.js applies only to the same. It is
   here because the next generated body may not be so complete, and because
   "the model looks flat" is not a failure anyone would trace to a missing
   texture channel.

   Cheap on purpose:
     • 512² cap. This is coarse relief, not fine detail, and the cap bounds
       the one-time cost at ~260 k pixels however big the source is.
     • Keyed on the IMAGE, in a WeakMap, so several materials sharing one
       bitmap derive one texture and every instance shares it by reference.
     • Guarded hard. No map, no image, a 1×1 stand-in, an image that has not
       decoded, no 2d context, a tainted canvas — every one of them returns
       null and changes nothing, because a carcass with no relief is the look
       we shipped and a carcass that threw during load is not.
   ------------------------------------------------------------------ */

/** Longest side of the derived map. */
const RELIEF_MAX = 512;
/** Luminance gradient → slope. Sobel over a 0..1 field reaches about ±4 at a
    hard edge, so 2.0 puts a painted panel gap near 45° before normalScale
    halves it again. Higher and every JPEG block becomes a dent. */
const RELIEF_K = 2.0;

/** map.image → THREE.CanvasTexture | null (null caches a refusal). */
const _relief = new WeakMap();

/**
 * A tangent-space normal map derived from an albedo, or null.
 * @param {THREE.Texture} map
 * @returns {THREE.Texture|null}  shared; owned by the template, never disposed here
 */
export function normalFromAlbedo(map) {
  if (!map) return null;
  const img = map.image;
  if (!img || typeof img !== 'object') return null;
  if (_relief.has(img)) return _relief.get(img);
  // Not decoded yet, or a 1×1 placeholder: refuse WITHOUT caching, so a later
  // caller that finds a real image still gets one.
  if (!(img.width > 1) || !(img.height > 1)) return null;
  let tex = null;
  try { tex = sobelNormal(img, map); }
  catch (err) { tex = null; void err; }
  _relief.set(img, tex);
  return tex;
}

function sobelNormal(img, src) {
  if (typeof document === 'undefined') return null;
  const k = Math.min(1, RELIEF_MAX / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * k));
  const h = Math.max(2, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  // Luminance once. The 3×3 below reads eight neighbours per pixel, and doing
  // the dot product inside that loop would do it eight times over.
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (px[p] * 0.2126 + px[p + 1] * 0.7152 + px[p + 2] * 0.0722) * (1 / 255);
  }
  /* Clamped neighbour indices, precomputed. Clamped rather than wrapped even
     when the source repeats: one texel of flat edge on a relief map is
     invisible, and a per-pixel modulo over 260 k pixels is not free. */
  const xm = new Int32Array(w), xp = new Int32Array(w);
  for (let x = 0; x < w; x++) { xm[x] = x > 0 ? x - 1 : 0; xp[x] = x < w - 1 ? x + 1 : w - 1; }
  const ym = new Int32Array(h), yp = new Int32Array(h);
  for (let y = 0; y < h; y++) { ym[y] = y > 0 ? y - 1 : 0; yp[y] = y < h - 1 ? y + 1 : h - 1; }

  const out = g.createImageData(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const r0 = ym[y] * w, r1 = y * w, r2 = yp[y] * w;
    for (let x = 0; x < w; x++) {
      const a = xm[x], b = xp[x];
      const tl = lum[r0 + a], tt = lum[r0 + x], tr = lum[r0 + b];
      const ll = lum[r1 + a], rr = lum[r1 + b];
      const bl = lum[r2 + a], bb = lum[r2 + x], br = lum[r2 + b];
      const gx = (tr + 2 * rr + br) - (tl + 2 * ll + bl);
      const gy = (bl + 2 * bb + br) - (tl + 2 * tt + tr);
      // tangent space: +Z out of the surface, flat = (0.5, 0.5, 1)
      const nx = -gx * RELIEF_K, ny = -gy * RELIEF_K;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (r1 + x) * 4;
      d[o] = (nx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);

  const t = new THREE.CanvasTexture(c);
  // A normal map is data, not colour: sRGB-decoding it tilts every normal.
  t.colorSpace = THREE.NoColorSpace;
  // The albedo's own addressing, or the relief slides off the model where it
  // repeats and lands upside down where glTF has already flipped it.
  t.wrapS = src.wrapS; t.wrapT = src.wrapT; t.flipY = src.flipY;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------
   one instance
   ------------------------------------------------------------------
   Object3D.clone() copies the node tree and shares geometry AND materials.
   Sharing geometry is exactly what we want — it is the megabytes. Sharing
   materials is not: liveries tint them, mudify() dirties them, and the ghost
   overlay walks them, so two cars on the same machine would fight over one
   material and the second to write would win for both.

   Textures stay shared. They are owned by the template and released by
   clearModelCache().
   ------------------------------------------------------------------ */
function instantiate(template) {
  const inst = template.clone(true);
  inst.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = Array.isArray(o.material)
      ? o.material.map(m => (m ? m.clone() : m))
      : o.material.clone();
  });
  return inst;
}

/* ------------------------------------------------------------------
   small guards
   ------------------------------------------------------------------ */
/**
 * True if `url` will be served from the origin this game was served from.
 *
 * The rule being enforced is "our own origin", not "textually relative". A
 * relative url is always ours, and so is an absolute one that resolves to the
 * page's own origin — which is what a module gets when it resolves a path
 * against its own `import.meta.url`, and that is the only way to write a url
 * that does not silently depend on which PAGE is asking. props-wasteland does
 * exactly that for the hero models, because the same authored path is loaded
 * from the game at the root and from the harnesses in dev/.
 */
function isOwnOrigin(url) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) return true;
  try { return new URL(url, location.href).origin === location.origin; }
  catch { return false; }
}

const _warned = new Set();
function warnOnce(url, why) {
  if (_warned.has(url)) return;
  _warned.add(url);
  console.warn('[models] ' + url + ': ' + why + ' — using the procedural fallback');
}

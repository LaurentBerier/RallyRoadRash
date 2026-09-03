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
  return _loader || (_loader = new GLTFLoader());
}

/**
 * Load a glTF/GLB and hand back a fresh instance of it.
 *
 * @param {string} url  relative to the page, e.g. 'assets/models/hopper-carcass.glb'
 * @returns {Promise<THREE.Group|null>}  never rejects; null means "use your fallback"
 */
export function loadModel(url) {
  if (typeof url !== 'string' || !url) return Promise.resolve(null);
  if (!isRelative(url)) {
    warnOnce(url, 'absolute url — models must be served from our own origin');
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
  });
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
function isRelative(url) {
  // A scheme ('http:', 'data:', 'blob:') or a protocol-relative '//host'.
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//');
}

const _warned = new Set();
function warnOnce(url, why) {
  if (_warned.has(url)) return;
  _warned.add(url);
  console.warn('[models] ' + url + ': ' + why + ' — using the procedural fallback');
}

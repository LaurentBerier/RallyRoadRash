/* ============================================================
   THE WASTELAND LAYER — placement
   ------------------------------------------------------------
   The third file split out of props.js, on the same seam as the first two:
   props-recipes.js is WHAT a stage is made of, props-shapes.js is the scatter
   geometry, and this is where the wave-8 layer gets PUT. It exists because
   props.js was at 1379 lines against a 1400-line house limit before any of
   this was written, and because the layer is one coherent thing — the
   carcasses, the dead machinery, the barricades and the hero models all obey
   the same two rules and no other part of the file obeys either:

     1. ONE DRAW CALL FOR ALL OF IT. Every structure here is baked into world
        space and merged into a single mesh. Twelve shapes placed one to four
        times each would otherwise be twelve InstancedMeshes with two
        instances in them, and the draw call is the scarce resource, not the
        vertex data. See dressOneOff().

     2. CLOSER IN THAN A LANDMARK, AND FACING ALONG THE ROAD. A building
        fronts onto the road because that is what a building does. A car that
        came off the road is lying the way it was travelling, and it is on the
        verge rather than on the horizon, or it is just a lump.

   These are free functions taking the Props instance rather than methods,
   because that is the honest shape of a split: the layer reaches into props
   for exactly six things — `plan`, `data`, `terrain`, `group`, `dressMat`
   and the three accumulators (`_oneOffSolid`, `_fixedColliders`, `_claimed`)
   — plus `_kitGeo`, `_canPlace`, `_clearOfClaims`, `_keepGeo` and
   `_tightestCorners`. Naming that list is better than hiding it behind
   `this`.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadModel, disposeModel } from '../core/models.js';
import { PLAYABLE_EXT } from './terrain.js';
import { DUST_KIND } from './dust.js';
import {
  wreckHuskGeo, scrapPileGeo, tankerWreckGeo, pumpjackGeo, windPumpGeo,
  watchtowerGeo, jerseyBarrierGeo, sandbagWallGeo, barricadeGeo, fireDrumGeo,
  totemGeo, ruinedBillboardGeo,
} from './kit-wasteland.js';
import { BOUNCE_FOR, WASTE_FACING } from './props-recipes.js';

/* ---------------- module scratch (no per-frame allocation) ---------------- */
/**
 * A `heroModels` url, resolved so it does not depend on which page is asking.
 *
 * DRESSING authors these repo-root-relative ('assets/models/heroes/x.glb'),
 * which a browser resolves against the PAGE. That is correct from the game at
 * the root and wrong from every harness in dev/, where it becomes
 * '/dev/assets/...' and 404s — so the heroes were invisible in firstlight,
 * which is the one place they were going to be looked at. Resolving against
 * this module's own url instead is page-independent and still relative to
 * wherever the game is served from, which Sandscape needs.
 */
const _ROOT = new URL('../../', import.meta.url);
const heroUrl = (url) => (url ? new URL(url, _ROOT).href : null);

const _dummy = new THREE.Object3D();
const _pp = { x: 0, y: 0, z: 0 };
const _pp2 = { x: 0, y: 0, z: 0 };
const _dd = { x: 0, z: 0 };
/* Used once per hero model, when its GLB lands. A generated mesh arrives
   normalised and centred rather than in metres standing on a floor, so the
   only way to know where its feet are is to measure them. */
const _box = new THREE.Box3();

const NO_FACING = { face: 'along', turn: 0 };
/** How to turn a shape: the row wins, then the per-shape table, then along. */
function facingOf(spec) {
  const t = WASTE_FACING[spec.id] || NO_FACING;
  return {
    face: spec.face || t.face || 'along',
    turn: spec.turn === undefined ? (t.turn || 0) : spec.turn,
  };
}

/**
 * Geometry for one wasteland id, with the arguments this layer is authored
 * for — the tower heights and the wall lengths in particular, because a shape
 * gated at one size in kit-check and built at another is not gated.
 *
 * This dispatch lives here rather than as fourteen more cases in props.js
 * `_kitGeo` for the same reason the planners do: it is one layer, and the
 * file it came out of was already at the house line limit. It returns null
 * for anything it does not own, so `_kitGeo`'s own default still catches a
 * genuine typo — and dev/kit-check.mjs gates the tables against both
 * switches, so neither one can drift away from the other quietly.
 */
export function wastelandGeo(P, seed, id) {
  switch (id) {
    /* Three husks and not one, because two of the same wreck thirty metres
       apart reads as an asset and three reads as a road that has been
       killing people for years. */
    case 'husk0': return wreckHuskGeo(P, seed + 197, 0);
    case 'husk1': return wreckHuskGeo(P, seed + 199, 1);
    case 'husk2': return wreckHuskGeo(P, seed + 211, 2);
    case 'scrap': return scrapPileGeo(P, seed + 223);
    case 'tanker': return tankerWreckGeo(P, seed + 227);
    case 'pumpjack': return pumpjackGeo(P, seed + 229);
    case 'windpump': return windPumpGeo(P, seed + 233, 8.5);
    case 'watchtower': return watchtowerGeo(P, seed + 239, 10.5);
    case 'jersey': return jerseyBarrierGeo(P, seed + 241, 4);
    case 'sandbags': return sandbagWallGeo(P, seed + 251, 3.6);
    case 'barricade': return barricadeGeo(P, seed + 257, 5.0);
    case 'firedrum': return fireDrumGeo(P, seed + 263);
    case 'totem': return totemGeo(P, seed + 269);
    case 'ruinboard': return ruinedBillboardGeo(P, seed + 271);
    default: return null;
  }
}

/**
 * Register one dressing instance as WORLD-SPACE geometry instead of an
 * InstancedMesh slot.
 *
 * The transform is composed exactly the way props.js `_flushDressing`
 * composes an instance matrix — position, then a yaw-only rotation, then a
 * uniform scale — so a one-off and an instance of the same id at the same
 * site land in the same place. That is not a coincidence worth risking on two
 * copies of the maths.
 */
export function dressOneOff(p, id, x, y, z, yaw, scale = 1, solid = 0, bounce = 1.35) {
  const src = p._kitGeo(id);
  if (!src) return;
  _dummy.position.set(x, y, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  p._oneOffSolid.push(src.clone().applyMatrix4(_dummy.matrix));
  if (solid > 0) p._fixedColliders.push({ x, z, r: solid * scale, kind: id, bounce });
}

/* ============================================================
   the structures
   ============================================================ */

/**
 * What the road outlived: carcasses, dead machinery, and the things people put
 * across it. Sampled like a landmark, baked flat like the bunting.
 *
 * Two things this planner does that props.js `_planLandmarks` does not:
 *
 * • It honours a per-row `clear`. The landmark sampler hard-codes a 2.4x
 *   half-width road clearance, which is 25–29 m on PROVING GROUNDS: a wreck
 *   asked for at 14 m from the centreline would be rejected on every single
 *   attempt and that stage would silently come out with no wrecks at all. A
 *   carcass wants to be just off the verge, so the row says how close counts.
 *
 * • It faces things ALONG the road rather than at it, off WASTE_FACING, which
 *   records which axis each shape is built long on — kit-wasteland.js builds
 *   the tanker, the barriers and the sandbags along +X and the husks and the
 *   pumpjack along +Z, and no amount of cleverness here can guess which.
 */
export function planWasteland(p, rng) {
  const list = p.plan.wasteland;
  if (!list || !list.length) return;
  const sp = p.data.spline, L = sp.length;
  for (const spec of list) {
    if (spec.where === 'corner') { planCornerLine(p, spec, rng); continue; }
    const clear = spec.clear === undefined ? 1.6 : spec.clear;
    const maxSlope = spec.slope === undefined ? 22 : spec.slope;
    const { face, turn } = facingOf(spec);
    let placed = 0, guard = 0;
    while (placed < spec.n && guard++ < spec.n * 200) {
      const s = rng() * L;
      const side = rng() < 0.5 ? -1 : 1;
      const lat = spec.lat[0] + rng() * (spec.lat[1] - spec.lat[0]);
      const q = sp.offsetPoint(s, side * lat, _pp);
      const x = q.x, z = q.z;
      if (Math.abs(x) > PLAYABLE_EXT - 14 || Math.abs(z) > PLAYABLE_EXT - 14) continue;
      if (!p._canPlace(x, z, clear)) continue;
      if (p.terrain.slopeAt(x, z) > maxSlope) continue;
      if (!p._clearOfClaims(x, z, spec.r + 5)) continue;
      const y = p.terrain.heightAt(x, z);
      let yaw;
      if (face === 'free') {
        yaw = rng() * 6.2832;
      } else if (face === 'road') {
        const c = sp.posAt(s, _pp2);
        yaw = Math.atan2(c.x - x, c.z - z) + turn + (rng() - 0.5) * 0.40;
      } else {
        const d = sp.dirAt(s, _dd);
        yaw = Math.atan2(d.x, d.z) + turn + (rng() - 0.5) * 0.35;
      }
      dressOneOff(p, spec.id, x, y, z, yaw, 1, spec.r, BOUNCE_FOR(spec.id));
      p._claimed.push({ x, z, r: spec.r + 4 });
      if (spec.ember) p.fireDrums.push({ x, y, z });
      placed++;
    }
  }
}

/**
 * A welded barricade on the outside of each of the tightest corners on the lap.
 *
 * Placed off the SAME corner scan the warning boards and the crowd use, so
 * the sign that tells you the corner is coming, the people who came to watch,
 * and the plate you hit if you get it wrong all agree about where the corner
 * is. It sits at 1.45 half-widths plus 2.6 m, which on every stage in the game
 * leaves its collision disc clear of the road edge: a barricade is the
 * punishment for leaving the road, never a narrowing of it.
 */
export function planCornerLine(p, spec, rng) {
  const sp = p.data.spline;
  const maxSlope = spec.slope === undefined ? 22 : spec.slope;
  const { turn } = facingOf(spec);
  for (const c of p._tightestCorners(spec.n || 3)) {
    const s = sp.wrapS(c.s + (rng() - 0.5) * 10);
    const outside = c.k > 0 ? -1 : 1;
    const q = sp.offsetPoint(s, outside * (sp.widthAt(s) * 1.45 + 2.6), _pp);
    const x = q.x, z = q.z;
    if (Math.abs(x) > PLAYABLE_EXT - 10 || Math.abs(z) > PLAYABLE_EXT - 10) continue;
    /* A looser clearance than anything else in this file, deliberately: the
       whole point of a corner barricade is to be close. 1.32 half-widths is
       still outside the road on every stage — and it still refuses to stand
       on an alt route, because _canPlace tests the shortcut spline too. */
    if (!p._canPlace(x, z, 1.32)) continue;
    if (p.terrain.slopeAt(x, z) > maxSlope) continue;
    const d = sp.dirAt(s, _dd);
    dressOneOff(p, spec.id, x, p.terrain.heightAt(x, z), z,
      Math.atan2(d.x, d.z) + turn, 1, spec.r, BOUNCE_FOR(spec.id));
    p._claimed.push({ x, z, r: spec.r + 3 });
  }
}

/** The wasteland, in one draw. Called from props.js `_flushDressing`. */
export function flushWasteland(p) {
  if (!p._oneOffSolid.length) return;
  const merged = mergeGeometries(p._oneOffSolid, false);
  p._oneOffSolid.forEach(g => g.dispose());
  p._oneOffSolid.length = 0;
  if (!merged) return;
  const m = new THREE.Mesh(p._keepGeo(merged), p.dressMat);
  /* These are solid objects rather than wires, so unlike the mesh props.js
     merges the power lines into, this one casts. It is not frustum-culled
     either: its bounds are the whole stage, and culling a mesh that is always
     on screen is two matrix multiplies for nothing. */
  m.castShadow = true;
  m.receiveShadow = false;
  m.frustumCulled = false;
  p.group.add(m);
  p.wasteMesh = m;
}

/* ============================================================
   hero models — ARCHITECTURE §8.9
   ------------------------------------------------------------
   One generated GLB per stage, and the only thing in the whole world build
   that is not made of code. Everything about how it is wired is arranged so
   that the file being absent changes the picture and nothing else:

   • The COLLIDER goes in synchronously, from the table, before the load is
     even started. A hero you can drive through on a fast connection and not
     on a slow one would be a race condition in the physics.
   • The FALLBACK kit shape goes up immediately, as its own Mesh rather than
     merged into anything, precisely so it can be taken down again when the
     model arrives. If it never arrives, that shape IS the landmark, and it
     was placed and collided identically.
   • `scale` in the table is not a taste knob, it is the METRE CONVERSION.
     These meshes come back normalised into a ~1.9-unit box — a car and a
     drilling derrick both measure 1.9 across their longest axis — so the
     number is chosen to land the model on the same metres its named fallback
     already occupies. Change the fallback and the scale must be re-derived.
   • `yaw` is measured from the ROAD HEADING at the site, not from world
     north, so the entry survives a re-graded or re-routed track. It applies
     to the MODEL only: every one of these meshes came back long on X where
     our own kit is built long on Z, and a fallback rotated by the model's
     number would face the wrong way. The kit shape gets the ordinary
     landmark convention instead — front onto the road.
   ============================================================ */
export function planHeroModels(p) {
  p.heroModels = [];
  const list = p.plan.heroModels;
  if (!list || !list.length) return;
  const sp = p.data.spline;
  for (const h of list) {
    const site = heroModelSite(p, h);
    if (!site) continue;
    p._claimed.push({ x: site.x, z: site.z, r: h.r + 10 });
    p._fixedColliders.push({ x: site.x, z: site.z, r: h.r, kind: 'hero', bounce: 1.25 });

    const fbGeo = p._kitGeo(h.fallback);
    let fb = null;
    if (fbGeo) {
      const c = sp.posAt(site.s, _pp2);
      fb = new THREE.Mesh(fbGeo, p.dressMat);
      fb.position.set(site.x, site.y - 0.10, site.z);
      fb.rotation.y = Math.atan2(c.x - site.x, c.z - site.z);
      fb.castShadow = true;
      fb.receiveShadow = false;
      p.group.add(fb);
    }

    loadModel(heroUrl(h.url)).then((g) => {
      if (!g) return;                       // the fallback stays; nothing to do
      if (p._disposed) { disposeModel(g); return; }
      g.rotation.set(0, site.yaw, 0);
      g.scale.setScalar(h.scale);
      g.position.set(0, 0, 0);
      g.updateMatrixWorld(true);
      /* Measure, do not assume. The box these arrive in is CENTRED on the
         origin, so half the model is under the floor until it is lifted by
         its own minimum — and that minimum is only knowable after the node
         transforms and `scale` are both on, which is why this is done here
         and not in the table. The 12 cm sink afterwards is the same token a
         kit shape gets, so a broad flat base never floats off the crown of
         a slope. */
      _box.setFromObject(g);
      g.position.set(site.x, site.y - _box.min.y - 0.12, site.z);
      g.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = false;
      });
      p.group.add(g);
      p.heroModels.push(g);
      if (fb) { p.group.remove(fb); fb = null; }
    }).catch((e) => {
      /* loadModel never rejects, so this only fires if the continuation above
         throws on a file that loaded but is not the shape we expect. The
         fallback is still standing at this point — it is only removed on the
         last line — so the stage survives with its procedural landmark, which
         is the whole promise. One warn, not a stack trace per frame. */
      console.warn('[props] hero model ' + h.id + ' failed to place: ' + (e && e.message));
    });
  }
}

/**
 * Where a hero model actually stands.
 *
 * Pinned first and walked second. A landmark has to be in the same place on
 * every build or it is not a landmark — but the ground under it gets regraded
 * between waves, and a derrick standing in mid-air is worse than a derrick
 * eight metres further down the road. So the search is exhaustive and
 * DETERMINISTIC: the authored (s, lat), then ±8 m at a time out to ±64, then
 * the same walk mirrored to the other side of the road. No rng touches it, so
 * two builds of the same track agree about the answer.
 */
export function heroModelSite(p, h) {
  const sp = p.data.spline;
  const clear = h.clear === undefined ? 1.5 : h.clear;
  const maxSlope = h.slope === undefined ? 14 : h.slope;
  for (let flip = 0; flip < 2; flip++) {
    const lat = flip ? -h.lat : h.lat;
    for (let k = 0; k <= 16; k++) {
      const ds = k === 0 ? 0 : (k & 1 ? 1 : -1) * Math.ceil(k / 2) * 8;
      const s = sp.wrapS(h.s + ds);
      const q = sp.offsetPoint(s, lat, _pp);
      const x = q.x, z = q.z;
      if (Math.abs(x) > PLAYABLE_EXT - 24 || Math.abs(z) > PLAYABLE_EXT - 24) continue;
      if (!p._canPlace(x, z, clear)) continue;
      if (p.terrain.slopeAt(x, z) > maxSlope) continue;
      if (!p._clearOfClaims(x, z, h.r + 8)) continue;
      const d = sp.dirAt(s, _dd);
      return {
        s, x, z,
        y: p.terrain.heightAt(x, z),
        yaw: Math.atan2(d.x, d.z) + h.yaw,
      };
    }
  }
  return null;
}

/**
 * Dispose the loaded hero instances. ONLY the instance's own cloned materials
 * — geometry and textures belong to the template in core/models.js and are
 * shared with every other instance and every future stage. clearModelCache()
 * is what gives those back.
 */
export function disposeHeroModels(p) {
  for (const g of p.heroModels || []) disposeModel(g);
  if (p.heroModels) p.heroModels.length = 0;
}

/* ============================================================
   the fire drums
   ------------------------------------------------------------
   The one prop in the game that is doing something while nothing is
   happening. A geyser is an EVENT — one big burst every six to nine seconds —
   and this is the opposite: a thin continuous trickle off every drum in range
   at once, because a fire that puffs on a timer reads as a machine and a fire
   that never stops reads as a fire.

   Six embers a second per drum, four drums, is two dozen grains a second
   against a 2200-grain pool: cheap enough to leave running, and the reason it
   can be is that the drums' world positions were recorded once at build time.
   There is no allocation in here at all — the loop walks a flat array of
   objects that already exist and hands their fields straight to spawn().
   ============================================================ */
export function runEmbers(p, dt, camera) {
  const D = p.fireDrums;
  if (!D || !D.length || !p.dust) return;
  p._embT = (p._embT === undefined ? 0 : p._embT) - dt;
  if (p._embT > 0) return;
  p._embT = 0.17;
  const cx = camera.position.x, cz = camera.position.z;
  for (let i = 0; i < D.length; i++) {
    const d = D[i];
    const dx = d.x - cx, dz = d.z - cz;
    // 140 m: past that a 12 cm ember is a fraction of a pixel, and the
    // near-white disc across the drum mouth is doing all the work anyway.
    if (dx * dx + dz * dz > 140 * 140) continue;
    /* Off the mouth at 0.95 m, not off the ground: fireDrumGeo's drum is
       0.86 m tall and its hot disc sits just under the rim. EMBER grains are
       the buoyant kind — high drag, long life, they rise and then hang — so
       the launch only has to be a nudge; 1.1 m/s is a column, not a fountain.
       The colour stays UNDER 1: dust.js's ember branch multiplies it by
       (2.8, 1.0, 0.38) and then by up to 10.8 of its own heat term, so the
       bloom is already taken care of and a value over 1 here would make a
       bin fire brighter than a rocket motor. These are a shade cooler than
       arsenal.js's exhaust, deliberately — it is a fire in a drum. */
    p.dust.spawn(1, d.x, d.y + 0.95, d.z, 1.10, 0.09, 0, 0,
      0.95, 0.55, 0.18, DUST_KIND.EMBER);
  }
}

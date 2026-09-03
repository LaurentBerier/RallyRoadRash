/* ============================================================
   THINGS BESIDE THE ROAD
   ------------------------------------------------------------
   Two populations, one class:

   • SCATTER — theme decoration, seeded from trackDef.seed and placed
     by rejection sampling against terrain.onRoad(), the checkpoint
     discs and the local slope. Instanced, and always placed at the
     densest tier so lowering quality HIDES A SUFFIX rather than
     re-rolling the scatter (a boulder is a collider; sliding one
     sideways while somebody is driving past it is a bug).

   • FURNITURE — derived from trackData: start gantry, checkpoint
     gates, barrier runs along the authored wall spans, arrow boards
     before hairpins and jumps, and the finish stripe on the ground.

   • HEROES — the two or three landmarks per stage that are placed at a
     NAMED point on the spline rather than sampled: the arch over the
     canyon wash, the falls above the timberline, the vent field in the
     caldera, the arch and the bunting over Thunder Mesa. A landmark that
     lands somewhere different every build is not a landmark.

   • THE WASTELAND — carcasses, dead machinery, barricades on the corners
     people go off at, and one generated hero model per stage. Planned in
     props-wasteland.js and merged into a single mesh, so the whole layer
     costs the stage one draw call.

   Collision is a 24 m bucket grid over circles and segments. resolve()
   pushes the car out and returns the impact speed so race.js can route
   it to damage and audio with one call.

   Three sibling files carry what used to be in here, because this one was
   doing four jobs and had grown past the house line limit:
   props-recipes.js is WHAT a stage is made of (the tables and the
   signage), props-shapes.js is the scatter geometry and the rock shader,
   props-wasteland.js is the wave-8 layer's placement and the hero models.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRNG, clamp } from '../core/rng.js';
import { PLAYABLE_EXT } from './terrain.js';
import { DUST_KIND } from './dust.js';
import { makeStreakSprite } from './textures.js';
import {
  kitPalette, cactusGeo, agaveGeo, bushGeo, snagGeo, broadleafGeo, stumpGeo,
  shardGeo, drumGeo, crateGeo, baleGeo, wreckGeo, pipeStackGeo, shedGeo,
  containerGeo, towerGeo, waterTankGeo, hangarGeo, grandstandGeo, canopyGeo,
  personGeo, poleGeo, culvertGeo, pipeworkGeo, logStackGeo, wireGeo,
  floodlightGeo, billboardGeo, buntingGeo, tyreWallGeo, rockArchGeo,
  waterfallSheetGeo, geyserVentGeo,
} from './kit.js';
import {
  RECIPES, DRESSING, KIT_KINDS, UPRIGHT_KINDS, BOUNCE_FOR,
  gantryTex, bannerTex, sponsorTex, arrowTex, checkerTex, railTex,
  waterfallMaterial,
} from './props-recipes.js';
import {
  wastelandGeo, planWasteland, planHeroModels, flushWasteland,
  disposeHeroModels, runEmbers,
} from './props-wasteland.js';
/* Whoever owns the page says where the hero GLBs live — main.js from the asset
   manifest, the dev harnesses from their own. No source means no hero models
   and the kit fallbacks stand, which is the state a tree with no assets/ is in. */
export { setHeroSource } from './props-wasteland.js';
import {
  hash2, boulderGeo, hoodooGeo, pineGeo, logGeo, basaltGeo, ventGeo,
  coneGeo, tyreStackGeo, railQuad, rockMaterial,
} from './props-shapes.js';

/* Placement is always done for the densest tier. Keep in step with
   QUALITY.ultra.boulders in core/engine.js. */
const MAX_SCATTER = 2900;
const GRID_CELL = 24, GRID_HALF = 640;
const CAR_R = 1.15;              // fallback body radius if a vehicle has none

/* ---------------- module scratch (no per-frame allocation) ---------------- */
const _dummy = new THREE.Object3D();
const _near = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
const _pp = { x: 0, y: 0, z: 0 };
// Second point scratch: the dressing pass needs a site AND the centreline
// point it should face, and one buffer cannot hold both.
const _pp2 = { x: 0, y: 0, z: 0 };
const _dd = { x: 0, z: 0 };

/* ============================================================
   PROPS
   ============================================================ */
export class Props {
  constructor(scene, terrain, quality, trackDef, trackData) {
    this.scene = scene;
    this.terrain = terrain;
    this.quality = quality;
    this.def = trackDef;
    this.data = trackData;
    this.theme = trackDef.theme || 'training';
    this.recipe = RECIPES[this.theme] || RECIPES.training;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.colliders = [];       // { x, z, r, kind, bounce }
    this.barriers = [];        // { ax, az, bx, bz, r, kind }
    this._tex = [];            // everything to dispose
    this._geo = [];
    this._mat = [];

    this.palette = kitPalette(this.theme);
    this.plan = DRESSING[this.theme] || DRESSING.training;
    this.rockMat = this._keepMat(rockMaterial(this.recipe.rock, this.recipe.dust));
    /* One material for every vertex-coloured thing in the stage: scatter
       plants, junk, landmarks, poles, spectators. Adding a new kind of prop
       costs a geometry and nothing else. */
    this.dressMat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0.05,
    }));

    this.buildScatter();
    this.buildFurniture();
    this.setScatterDensity(quality.boulders);
  }

  _keepMat(m) { this._mat.push(m); return m; }
  _keepGeo(g) { this._geo.push(g); return g; }
  _keepTex(t) { this._tex.push(t); return t; }

  /* ---------------- placement test ----------------
     A prop may not sit on the road, in a checkpoint disc, on a slope it would
     visibly float off, or inside the grid box where eight cars are about to
     materialise. */
  _canPlace(x, z, clearW) {
    if (Math.abs(x) > PLAYABLE_EXT || Math.abs(z) > PLAYABLE_EXT) return false;
    if (this.terrain.onRoad(x, z) > 0.05) return false;
    const sp = this.data.spline;
    sp.nearest(x, z, _near);
    if (_near.d < sp.widthAt(_near.s) * clearW) return false;
    const sc = this.data.shortcutSpline;
    if (sc) {
      sc.nearest(x, z, _near);
      if (_near.d < sc.widthAt(_near.s) * clearW) return false;
    }
    const cps = this.data.checkpoints;
    for (let i = 0; i < cps.length; i++) {
      const dx = x - cps[i].x, dz = z - cps[i].z;
      if (dx * dx + dz * dz < cps[i].r * cps[i].r) return false;
    }
    for (let i = 0; i < this.data.gridSlots.length; i++) {
      const g = this.data.gridSlots[i];
      const dx = x - g.x, dz = z - g.z;
      if (dx * dx + dz * dz < 100) return false;
    }
    return true;
  }

  /* ---------------- theme scatter ---------------- */
  buildScatter() {
    const rng = makeRNG((this.def.seed | 0) ^ 0xB0D1E);
    const R = this.recipe;
    const sp = this.data.spline;
    this.scatterMeshes = [];
    this._scatterSolids = [];

    // one geometry per kind id, built lazily
    const geoFor = (id) => {
      if (!this._geoCache) this._geoCache = {};
      if (this._geoCache[id]) return this._geoCache[id];
      let g;
      /* Icosahedron subdivision costs 4x per level. Level 2 (320 tris) is the
         most any rock you drive past deserves; the pebble scatter runs at 0
         (20 tris) and leans on the triplanar shader instead. */
      if (KIT_KINDS.has(id)) { this._geoCache[id] = this._kitGeo(id); return this._geoCache[id]; }
      if (id === 'rock0') g = boulderGeo(1.7, 2);
      else if (id === 'rock1') g = boulderGeo(5.3, 1);
      else if (id === 'rock2') g = boulderGeo(9.1, 0);
      else if (id === 'hoodoo') g = hoodooGeo(3);
      else if (id === 'pine0') g = pineGeo(1);
      else if (id === 'pine1') g = pineGeo(2);
      else if (id === 'pine2') g = pineGeo(3);
      else if (id === 'log') g = logGeo(4);
      else if (id === 'basalt') g = basaltGeo(5);
      else if (id === 'vent') g = ventGeo(6);
      else if (id === 'cone') g = coneGeo();
      else if (id === 'tyre') g = tyreStackGeo();
      else g = boulderGeo(2.2, 1);
      this._geoCache[id] = this._keepGeo(g);
      return g;
    };

    const pineMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x2c4426, roughness: 0.94, metalness: 0
    }));
    const woodMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x4a3524, roughness: 0.92, metalness: 0
    }));
    const coneMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0xff6a1e, roughness: 0.7, metalness: 0, emissive: 0x2a0e00
    }));
    const tyreMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x1a1a1c, roughness: 0.95, metalness: 0
    }));
    /* Anything from kit.js carries its colours in the vertex stream, so the
       whole of the new scatter — cacti, snags, drums, obsidian — shares one
       material and adds no shader permutations. */
    const matFor = (id) => KIT_KINDS.has(id) ? this.dressMat
      : id.startsWith('pine') ? pineMat
        : id === 'log' ? woodMat
          : id === 'cone' ? coneMat
            : id === 'tyre' ? tyreMat
              : this.rockMat;

    for (let ki = 0; ki < R.kinds.length; ki++) {
      const K = R.kinds[ki];
      const per = Math.ceil(MAX_SCATTER * K.share);
      const geo = geoFor(K.id);
      const im = new THREE.InstancedMesh(geo, matFor(K.id), per);
      im.castShadow = !!K.shadow;
      im.receiveShadow = false;
      im.frustumCulled = false;
      const solids = [];
      this._scatterSolids.push(solids);

      let k = 0, guard = 0;
      while (k < per && guard++ < per * 30) {
        /* Placement follows the ROAD, not the map centre.

           The old sampler picked a radius from the world origin, which on a
           600 m track spread the whole budget over about 1.1 km² — two props
           per thousand square metres, and TIMBERLINE CLIMB looked like a
           desert with twenty pine trees standing in it. Nobody ever sees the
           far corners of the map; every instance spent out there is one
           missing from the verge you are actually looking at.

           So 74 % of the budget is sampled as (s along the spline, lateral
           offset), with the offset raised to a power so it crowds the first
           30 m off the road edge and thins out by 110 m. The remaining 26 %
           still fills the wide field, because a horizon with nothing on it
           reads as a bald patch from the top of a climb. */
        let x, z;
        if (rng() < 0.74) {
          const s = rng() * sp.length;
          const side = rng() < 0.5 ? -1 : 1;
          const q = sp.offsetPoint(s,
            side * (sp.widthAt(s) * K.clear + 1.5 + Math.pow(rng(), 1.7) * 108), _pp);
          x = q.x; z = q.z;
        } else {
          const a = rng() * 6.2831853;
          const r = 110 + rng() * (PLAYABLE_EXT - 125);
          x = Math.cos(a) * r; z = Math.sin(a) * r;
        }
        if (!this._canPlace(x, z, K.clear)) continue;
        if (this.terrain.slopeAt(x, z) > K.slope) continue;
        const size = K.min + Math.pow(rng(), 1.8) * (K.max - K.min);
        /* Kit geometry stands ON y = 0, so it must NOT be sunk the way a
           boulder is — a drum buried to its waist reads as a bug. Trees and
           plants get a token 5 cm so their base never floats on a slope. */
        const sink = KIT_KINDS.has(K.id) ? 0.05
          : K.id.startsWith('pine') ? size * 0.05 : size * 0.20;
        const y = this.terrain.heightAt(x, z) - sink;
        _dummy.position.set(x, y, z);
        if (K.id.startsWith('pine') || UPRIGHT_KINDS.has(K.id)) {
          _dummy.rotation.set(0, rng() * 6.2832, 0);       // upright things stay upright
        } else if (K.id === 'log' || K.id === 'hoodoo' || K.id === 'basalt' ||
          K.id === 'shard0' || K.id === 'shard1') {
          _dummy.rotation.set((rng() - 0.5) * 0.12, rng() * 6.2832, (rng() - 0.5) * 0.12);
        } else {
          _dummy.rotation.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
        }
        const sx = size * (0.85 + rng() * 0.3);
        _dummy.scale.set(sx, size * (0.85 + rng() * 0.3), sx);
        _dummy.updateMatrix();
        im.setMatrixAt(k, _dummy.matrix);
        solids.push(K.solid && size > K.min * 0.9
          ? { x, z, r: (K.r || 0.7) * size, kind: K.id, bounce: BOUNCE_FOR(K.id) }
          : null);
        k++;
      }
      im.userData.placed = k;
      im.userData.share = K.share;
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.scatterMeshes.push(im);
    }
  }

  /** Show the first N of the field and collide with exactly those. Anything the
      tier hides must not be solid, or you would be stopped by a rock that is
      not there. */
  setScatterDensity(N) {
    this.colliders.length = 0;
    for (let vi = 0; vi < this.scatterMeshes.length; vi++) {
      const im = this.scatterMeshes[vi];
      const show = Math.min(im.userData.placed, Math.ceil(N * im.userData.share));
      im.count = show;
      const solids = this._scatterSolids[vi];
      for (let i = 0; i < show; i++) if (solids[i]) this.colliders.push(solids[i]);
    }
    for (let i = 0; i < this._fixedColliders.length; i++) this.colliders.push(this._fixedColliders[i]);
    this._buildBroadphase();
  }

  setQuality(q) {
    this.quality = q;
    this.setScatterDensity(q.boulders);
    /* The crowd is the first thing to go. Spectators are ~60 instances of a
       12-primitive figure that nobody looks at directly, and dropping them
       costs the stage nothing structurally — unlike the landmarks, which are
       what tells you WHERE you are and stay at every tier. */
    const showCrowd = q.boulders >= 700;
    for (const m of this.crowdMeshes || []) m.visible = showCrowd;
  }

  /* ============================================================
     track furniture
     ============================================================ */
  buildFurniture() {
    this._fixedColliders = [];
    const A = this.recipe.accent;
    this.postMat = this._keepMat(new THREE.MeshStandardMaterial({
      color: 0x30343c, roughness: 0.6, metalness: 0.55
    }));
    this.buildGantry(A);
    this.buildGates(A);
    this.buildBarriers(A);
    this.buildSigns();
    this.buildDressing(A);
    this.buildFinishStripe();
  }

  /* ============================================================
     SET DRESSING
     ------------------------------------------------------------
     Everything in this block shares one vertex-coloured material and is
     collapsed into one InstancedMesh per shape, so a stage that gains a
     hangar, a power line, forty spectators and a set of jump furniture gains
     about a dozen draw calls in total.

     The order matters. Landmarks claim their ground first because they are
     the biggest and the fussiest about slope; utility lines then thread
     between whatever is left; the paddock, jump furniture and crowds are
     placed against track features and never negotiate.
     ============================================================ */
  buildDressing(accent) {
    const rng = makeRNG((this.def.seed | 0) ^ 0x5E7D1);
    this._dressSites = new Map();      // id -> [ {x,y,z,yaw,scale} ]
    this._dressGeoCache = this._dressGeoCache || {};
    this._oneOff = [];                 // geometry already in world space
    /* The wasteland bucket. Same idea as _oneOff — world-space geometry
       merged into a single mesh — but it CASTS A SHADOW, and _oneOff cannot:
       that mesh carries the power-line wires, and a shadow-casting wire is a
       stripe of acne. A ten-metre watchtower with no shadow is the same
       mistake read the other way, so it gets its own draw call. */
    this._oneOffSolid = [];
    this._crowdIds = new Set();        // ids the low tier drops
    this._claimed = [];                // {x,z,r} — landmark keep-out discs

    this._planHeroes(rng, accent);     // first: a hero owns its ground outright
    planHeroModels(this);              // …and a hero MODEL owns the most of it
    this._planLandmarks(rng);
    planWasteland(this, rng);
    this._planUtilityLines(rng);
    this._planPaddock(rng);
    this._planJumpFurniture(rng, accent);
    this._planCrowds(rng);
    this._flushDressing();
    this._buildBillboards(accent);
  }

  /** Geometry for a dressing/kit id, built once and cached for the stage. */
  _kitGeo(id) {
    const C = this._dressGeoCache || (this._dressGeoCache = {});
    if (C[id]) return C[id];
    const P = this.palette;
    const s = (this.def.seed | 0) + id.length * 131;
    let g;
    switch (id) {
      /* scatter plants and junk */
      case 'cactus0': g = cactusGeo(P, s + 11); break;
      case 'cactus1': g = cactusGeo(P, s + 29); break;
      case 'agave': g = agaveGeo(P, s + 17); break;
      case 'bush0': g = bushGeo(P, s + 23); break;
      case 'snag': g = snagGeo(P, s + 31); break;
      case 'broadleaf': g = broadleafGeo(P, s + 37); break;
      case 'stump': g = stumpGeo(P, s + 41); break;
      case 'shard0': g = shardGeo(P, s + 43); break;
      case 'shard1': g = shardGeo(P, s + 47); break;
      case 'drum': g = drumGeo(P, s + 53); break;
      case 'crate': g = crateGeo(P, s + 59); break;
      case 'bale': g = baleGeo(P, s + 61); break;
      /* landmarks */
      case 'hangar': g = hangarGeo(P, s + 71, 24, 17, 8.5); break;
      case 'tower': g = towerGeo(P, s + 73, 15, true); break;
      case 'lookout': g = towerGeo(P, s + 79, 11, true); break;
      case 'mast': g = towerGeo(P, s + 83, 17, false); break;
      case 'grandstand': g = grandstandGeo(P, s + 89, 15, 6); break;
      case 'shed': g = shedGeo(P, s + 97); break;
      case 'container': g = containerGeo(P, s + 101); break;
      case 'wreck': g = wreckGeo(P, s + 103); break;
      case 'tank': g = waterTankGeo(P, s + 107); break;
      case 'pipes': g = pipeStackGeo(P, s + 109); break;
      case 'pipework': g = pipeworkGeo(P, s + 113); break;
      case 'culvert': g = culvertGeo(P, s + 127); break;
      case 'logstack': g = logStackGeo(P, s + 131); break;
      /* the event layer */
      case 'floodlight': g = floodlightGeo(P, s + 163, 13); break;
      case 'billboard': g = billboardGeo(P, s + 167); break;
      case 'tyrewall': g = tyreWallGeo(P, s + 173, 6.5); break;
      case 'geyservent': g = geyserVentGeo(P, s + 191); break;
      /* paddock and crowd */
      case 'canopy': g = canopyGeo(P, s + 137); break;
      case 'person0': g = personGeo(P, s + 139); break;
      case 'person1': g = personGeo(P, s + 149); break;
      case 'person2': g = personGeo(P, s + 151); break;
      case 'pole': g = poleGeo(P, s + 157, this.plan.lines.poleH, this.plan.lines.arms); break;
      /* The wasteland layer dispatches its own fourteen ids next door, so
         they do not need fourteen more lines in here. A crate is still the
         answer for a genuine typo, and it is deliberately silent — a warn
         per prop per stage is noise, and kit-check gates the tables against
         both switches instead. */
      default: g = wastelandGeo(P, s, id) || crateGeo(P, s); break;
    }
    C[id] = this._keepGeo(g);
    return g;
  }

  /**
   * Register one dressing instance. `solid` adds a fixed collider, which is
   * what stops a hangar being scenery you drive through.
   */
  _dress(id, x, y, z, yaw, scale = 1, solid = 0, bounce = 1.3) {
    let a = this._dressSites.get(id);
    if (!a) this._dressSites.set(id, a = []);
    a.push({ x, y, z, yaw, scale });
    if (solid > 0) this._fixedColliders.push({ x, z, r: solid * scale, kind: id, bounce });
  }

  /** True if (x,z) is far enough from every landmark already placed. */
  _clearOfClaims(x, z, r) {
    for (let i = 0; i < this._claimed.length; i++) {
      const c = this._claimed[i];
      const dx = x - c.x, dz = z - c.z, rr = r + c.r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }

  /* ============================================================
     HEROES
     ------------------------------------------------------------
     Everything else in this file is placed by rejection sampling, which is
     right for texture and wrong for a landmark: a thing you are supposed to
     remember has to be in the same place every time you drive the stage, or
     it is not a landmark, it is weather.

     So each of these is pinned to a NAMED arc-length on the spline, out of
     props-recipes.js, and claims its ground before anything else gets a
     look at the map.
     ============================================================ */
  _planHeroes(rng, accent) {
    this.geysers = [];                 // world positions the update timer fires
    this.waterfalls = [];              // { x, y, z } for the mist
    this.fireDrums = [];               // { x, y, z } the ember emitter reads
    for (const h of this.plan.heroes || []) {
      if (h.kind === 'arch') this._buildRockArch(h.s, rng);
      else if (h.kind === 'waterfall') this._buildWaterfall(h, rng);
      else if (h.kind === 'geyser') this._planGeysers(h, rng);
      else if (h.kind === 'bunting') this._buildBunting(h, rng, accent);
    }
  }

  /**
   * A rock arch straddling the road. The one landmark in the game that is
   * also a GATE — you go through it, not past it — which is why the span is
   * sized off the local road width rather than authored, and why the only
   * solid parts are the two legs.
   */
  _buildRockArch(s0, rng) {
    const sp = this.data.spline;
    const s = sp.wrapS(s0);
    const p = sp.posAt(s, _pp), d = sp.dirAt(s, _dd);
    const w = sp.widthAt(s);
    // The authored geometry spans 26 m. Scale it so the legs clear the
    // roadbed by a car's width on each side and no further: an arch you
    // cannot possibly hit is also an arch you cannot possibly notice.
    const scale = clamp((w * 2 + 13) / 26, 0.95, 1.7);
    const geo = this._keepGeo(rockArchGeo(this.palette, (this.def.seed | 0) + 179, 26, 13));
    const m = new THREE.Mesh(geo, this.dressMat);
    m.position.set(p.x, this.terrain.heightAt(p.x, p.z) - 0.25, p.z);
    m.rotation.y = Math.atan2(d.x, d.z);
    m.scale.setScalar(scale);
    m.castShadow = true;
    m.frustumCulled = false;
    this.group.add(m);
    this.archMesh = m;
    // two leg colliders, exactly as _buildJumpArch does it
    for (const side of [-1, 1]) {
      const q = sp.offsetPoint(s, side * 13 * scale, _pp2);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 3.0 * scale, kind: 'arch', bounce: 1.35 });
      this._claimed.push({ x: q.x, z: q.z, r: 10 * scale });
    }
    void rng;
  }

  /**
   * The falls. Sited on the STEEPEST ground inside the authored lateral
   * band — a waterfall belongs on a cliff, and the bake does not carve one,
   * so the best this can do is find the closest thing the stage already has
   * and put the sheet on it. Its own scrolling material, and its own mist,
   * which is dust.js doing what dust.js already does.
   */
  _buildWaterfall(h, rng) {
    const sp = this.data.spline;
    const s = sp.wrapS(h.s);
    let best = null, bestSlope = -1;
    for (let i = 0; i < 40; i++) {
      const side = i & 1 ? 1 : -1;
      const lat = side * (h.lat[0] + (i / 40) * (h.lat[1] - h.lat[0]));
      const q = sp.offsetPoint(sp.wrapS(s + (rng() - 0.5) * 60), lat, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT - 24 || Math.abs(q.z) > PLAYABLE_EXT - 24) continue;
      const sl = this.terrain.slopeAt(q.x, q.z);
      if (sl > bestSlope) { bestSlope = sl; best = { x: q.x, z: q.z }; }
    }
    if (!best) return;
    const y = this.terrain.heightAt(best.x, best.z);
    const geo = this._keepGeo(waterfallSheetGeo(this.palette, (this.def.seed | 0) + 181, 7, 16));
    const tex = this._keepTex(makeStreakSprite(256, { seed: 29 }));
    const mat = this._keepMat(waterfallMaterial(tex));
    const m = new THREE.Mesh(geo, mat);
    m.position.set(best.x, y, best.z);
    // face the road: the falls are for looking at from the car, and a sheet
    // seen edge-on is a line
    const c = sp.posAt(s, _pp2);
    m.rotation.y = Math.atan2(c.x - best.x, c.z - best.z);
    m.frustumCulled = false;
    this.group.add(m);
    this.waterfallMesh = m;
    this.waterfallMat = mat;
    this.waterfalls.push({ x: best.x, y, z: best.z });
    this._claimed.push({ x: best.x, z: best.z, r: 16 });
    this._fixedColliders.push({ x: best.x, z: best.z, r: 3.4, kind: 'falls', bounce: 1.2 });
  }

  /** A vent field. The cones are instanced set dressing; what makes them a
      landmark is the timer in update() firing one every six to nine seconds. */
  _planGeysers(h, rng) {
    const sp = this.data.spline, L = sp.length;
    let placed = 0, guard = 0;
    while (placed < (h.n || 3) && guard++ < 400) {
      const s = rng() * L;
      const side = rng() < 0.5 ? -1 : 1;
      const lat = side * (h.lat[0] + rng() * (h.lat[1] - h.lat[0]));
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT - 12 || Math.abs(q.z) > PLAYABLE_EXT - 12) continue;
      if (!this._canPlace(q.x, q.z, 1.6)) continue;
      if (this.terrain.slopeAt(q.x, q.z) > 16) continue;      // a vent sits in a flat
      if (!this._clearOfClaims(q.x, q.z, 14)) continue;
      const y = this.terrain.heightAt(q.x, q.z);
      this._dress('geyservent', q.x, y, q.z, rng() * 6.283, 1.0 + rng() * 0.5, 1.5, 1.2);
      this.geysers.push({ x: q.x, y, z: q.z });
      this._claimed.push({ x: q.x, z: q.z, r: 12 });
      placed++;
    }
  }

  /** Bunting over the start straight. Merges into the same one-off mesh the
      power-line wires use, so a whole stage's worth costs no extra draw. */
  _buildBunting(h, rng, accent) {
    const sp = this.data.spline;
    const s0 = sp.wrapS(h.s || 0);
    const span = h.span || 34;
    const A = new THREE.Color(accent).getHex();
    for (let i = 0; i < 3; i++) {
      const s = sp.wrapS(s0 - 18 + i * (span * 0.55));
      const w = sp.widthAt(s) * 1.5 + 3;
      const a = sp.offsetPoint(s, -w, _pp);
      const b = sp.offsetPoint(s, w, _pp2);
      const ay = this.terrain.heightAt(a.x, a.z) + 6.2 + rng() * 0.6;
      const by = this.terrain.heightAt(b.x, b.z) + 6.2 + rng() * 0.6;
      const g = buntingGeo(0x1c1e22, A, 0xf2efe6, a.x, ay, a.z, b.x, by, b.z, 1.5, 14);
      if (g) this._oneOff.push(g);
    }
  }

  /**
   * The sponsor faces. The kit's billboard is a blank dark panel — this lays
   * a canvas graphic over each one, split across TWO textures so a straight
   * lined with boards is not the same picture five times. Two instanced
   * meshes, two draw calls, and no per-instance UV plumbing.
   */
  _buildBillboards(accent) {
    const sites = this._billboardSites;
    if (!sites || !sites.length) return;
    this.billboardMeshes = [];
    const W = 9 * 0.96, H = 4.6 * 0.94;
    for (let v = 0; v < 2; v++) {
      const mine = sites.filter((_, i) => (i & 1) === v);
      if (!mine.length) continue;
      const mat = this._keepMat(new THREE.MeshStandardMaterial({
        map: this._keepTex(sponsorTex(v ? 'RIDGEBACK' : 'SUNSTRIKE', accent, v)),
        roughness: 0.84, metalness: 0.03, side: THREE.FrontSide
      }));
      const im = new THREE.InstancedMesh(
        this._keepGeo(new THREE.PlaneGeometry(W, H)), mat, mine.length);
      im.frustumCulled = false;
      im.castShadow = false;
      for (let i = 0; i < mine.length; i++) {
        const st = mine[i];
        _dummy.position.set(st.x, st.y, st.z);
        _dummy.rotation.set(0, st.yaw, 0);
        _dummy.scale.setScalar(st.scale);
        _dummy.translateY((3.2 + 4.6 * 0.5) * st.scale);
        _dummy.translateZ(0.05 * st.scale);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.billboardMeshes.push(im);
    }
  }

  /* ---------------- landmarks ----------------
     Sampled in a lateral band off the racing line so they are always in
     shot. A building also needs FLAT ground: `slopeAt` over 14° is rejected
     outright rather than fudged, because a hangar on a 20° slope has one
     corner in the air and no amount of sinking hides it. */
  _planLandmarks(rng) {
    const sp = this.data.spline, L = sp.length;
    for (const spec of this.plan.landmarks) {
      const maxSlope = spec.r > 3 ? 11 : 20;      // big footprint, flatter ground
      let placed = 0, guard = 0;
      while (placed < spec.n && guard++ < spec.n * 160) {
        const s = rng() * L;
        const side = rng() < 0.5 ? -1 : 1;
        const lat = spec.lat[0] + rng() * (spec.lat[1] - spec.lat[0]);
        const q = sp.offsetPoint(s, side * lat, _pp);
        const x = q.x, z = q.z;
        if (Math.abs(x) > PLAYABLE_EXT - 20 || Math.abs(z) > PLAYABLE_EXT - 20) continue;
        if (!this._canPlace(x, z, 2.4)) continue;
        if (this.terrain.slopeAt(x, z) > maxSlope) continue;
        if (!this._clearOfClaims(x, z, spec.r + 8)) continue;
        const scale = spec.size[0] + rng() * (spec.size[1] - spec.size[0]);
        // Face the road, roughly. A building that ignores the only road for
        // 40 km reads as placed; one that fronts onto it reads as lived in.
        const c = sp.posAt(s, _pp2);
        const yaw = Math.atan2(c.x - x, c.z - z) + (rng() - 0.5) * 0.5;
        this._dress(spec.id, x, this.terrain.heightAt(x, z), z, yaw, scale, spec.r);
        this._claimed.push({ x, z, r: spec.r + 6 });
        placed++;
      }
    }
  }

  /**
   * The `n` tightest corners on the lap, hardest first.
   *
   * One scan, three callers. Anything that wants to react to "the corner
   * people go off at" has to agree with everything else that does, or the
   * crowd stands at one hairpin and the barricade defends a different one.
   */
  _tightestCorners(n) {
    const sp = this.data.spline, L = sp.length;
    const corners = [];
    let run = null;
    for (let s = 0; s < L; s += 4) {
      const k = sp.curvatureAt(s);
      if (Math.abs(k) > 1 / 46) {
        if (!run || Math.abs(k) > Math.abs(run.k)) run = { s, k };
      } else if (run) { corners.push(run); run = null; }
    }
    // A corner still open when the scan reaches s = L is a corner that
    // straddles the start line, and it used to be dropped on the floor.
    if (run) corners.push(run);
    corners.sort((a, b) => Math.abs(b.k) - Math.abs(a.k));
    return corners.slice(0, n);
  }

  /* ---------------- utility lines ----------------
     A pole line is the cheapest thing in this file and does more for scale
     than anything else: it gives the middle distance a rhythm, it crosses
     the road overhead, and it tells you how far away the horizon is. The
     wires are the whole point — poles alone read as fence posts. */
  _planUtilityLines(rng) {
    const cfg = this.plan.lines;
    const R = PLAYABLE_EXT * 0.94;
    const P = this.palette;
    const wireCol = 0x1c1e22;
    for (let run = 0; run < cfg.runs; run++) {
      const ang = rng() * Math.PI;                       // undirected chord
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const off = (rng() - 0.5) * R * 1.1;               // perpendicular offset
      const ox = -dz * off, oz = dx * off;
      const n = Math.floor(2 * R / cfg.span);
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const t = -R + i * cfg.span;
        const x = ox + dx * t, z = oz + dz * t;
        if (Math.abs(x) > PLAYABLE_EXT - 8 || Math.abs(z) > PLAYABLE_EXT - 8) { prev = null; continue; }
        // A pole may not stand on the road. The wire still spans the gap,
        // which is exactly what a real line does at a level crossing.
        const onRoad = this.terrain.onRoad(x, z) > 0.05 || !this._canPlace(x, z, 1.9);
        if (onRoad || this.terrain.slopeAt(x, z) > 26) { continue; }
        const y = this.terrain.heightAt(x, z);
        this._dress('pole', x, y, z, ang + Math.PI / 2, 1, 0.5, 1.2);
        if (prev && Math.hypot(x - prev.x, z - prev.z) < cfg.span * 2.4) {
          const topA = prev.y + cfg.poleH - 0.5, topB = y + cfg.poleH - 0.5;
          const sag = 0.9 + Math.hypot(x - prev.x, z - prev.z) * 0.012;
          for (const s of [-1, 1]) {
            const lx = -dz * s * 1.05, lz = dx * s * 1.05;
            const w = wireGeo(wireCol, prev.x + lx, topA + 0.13, prev.z + lz,
              x + lx, topB + 0.13, z + lz, sag, 5, 0.032);
            if (w) this._oneOff.push(w);
          }
        }
        prev = { x, y, z };
      }
    }
    void P;
  }

  /* ---------------- paddock ----------------
     Behind the grid, on the side the gantry legs are not on: canopies, a
     container or two, and the crew. This is the first thing a player sees on
     every single race, so it is worth the twenty props. */
  _planPaddock(rng) {
    const sp = this.data.spline;
    const side = rng() < 0.5 ? -1 : 1;
    const items = [
      ['canopy', -46, 1.0], ['canopy', -34, 1.0], ['canopy', -20, 1.0],
      ['container', -58, 1.0], ['container', 14, 1.0],
      ['crate', -28, 1.1], ['crate', -41, 0.9], ['drum', -24, 1.0], ['drum', -52, 1.0],
      ['bale', 4, 1.0], ['bale', -8, 1.0],
    ];
    for (const [id, ds, sc] of items) {
      const s = sp.wrapS(ds);
      const lat = side * (sp.widthAt(s) * 2.15 + 4 + rng() * 5);
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT - 10 || Math.abs(q.z) > PLAYABLE_EXT - 10) continue;
      if (this.terrain.slopeAt(q.x, q.z) > 17) continue;
      const d = sp.dirAt(s, _dd);
      this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z,
        Math.atan2(d.x, d.z) + (rng() - 0.5) * 0.4, sc, id === 'container' ? 3.2 : 0.9);
    }
    // crew, milling about between the canopies
    for (let i = 0; i < 12; i++) {
      const s = sp.wrapS(-56 + rng() * 70);
      const lat = side * (sp.widthAt(s) * 2.0 + 2 + rng() * 12);
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT - 10 || Math.abs(q.z) > PLAYABLE_EXT - 10) continue;
      const id = 'person' + (i % 3);
      this._crowdIds.add(id);
      this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z, rng() * 6.283, 0.94 + rng() * 0.14);
    }
  }

  /* ---------------- jump furniture ----------------
     The point of this game is the jumps, and until now the only thing that
     told you one was coming was a 1.5 m warning board. Every kicker now gets
     hay bales down the lip so the take-off edge is unmistakable at 40 m/s,
     and every HERO jump — anything with a gap, or a lip over 3 m — gets a
     sponsor arch over the ramp and a crowd that came to watch you get it
     wrong. The bales sit OUTSIDE the road corridor: they mark the edge, they
     never narrow it. */
  _planJumpFurniture(rng, accent) {
    const sp = this.data.spline;
    this.jumpArches = [];
    for (const j of this.data.jumps) {
      const hero = !!j.gap || j.h >= 3.0;
      const lipW = sp.widthAt(j.s);
      // bales along the ramp and down the far side of the landing
      const runs = hero ? [-j.len * 0.5, -j.len * 0.18, j.len * 0.16, (j.gap || 0) + j.len * 0.6]
        : [-j.len * 0.4, j.len * 0.2];
      for (const ds of runs) {
        const s = sp.wrapS(j.s + ds);
        for (const side of [-1, 1]) {
          const lat = side * (sp.widthAt(s) * 1.20 + 1.1);
          const q = sp.offsetPoint(s, lat, _pp);
          if (Math.abs(q.x) > PLAYABLE_EXT - 6 || Math.abs(q.z) > PLAYABLE_EXT - 6) continue;
          const d = sp.dirAt(s, _dd);
          this._dress('bale', q.x, this.terrain.heightAt(q.x, q.z), q.z,
            Math.atan2(d.x, d.z) + Math.PI / 2, 1, 0.7, 0.35);
        }
      }
      if (!hero) continue;
      this._buildJumpArch(j, accent, lipW);
      // spectators on the outside of the take-off, well back
      for (let i = 0; i < 14; i++) {
        const s = sp.wrapS(j.s - 12 + rng() * (j.len + 34));
        const side = i & 1 ? 1 : -1;
        const lat = side * (sp.widthAt(s) * 1.9 + 3 + rng() * 9);
        const q = sp.offsetPoint(s, lat, _pp);
        if (Math.abs(q.x) > PLAYABLE_EXT - 8 || Math.abs(q.z) > PLAYABLE_EXT - 8) continue;
        if (this.terrain.slopeAt(q.x, q.z) > 30) continue;
        const id = 'person' + (i % 3);
        this._crowdIds.add(id);
        const c = sp.posAt(s, _pp2);
        this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(c.x - q.x, c.z - q.z) + (rng() - 0.5) * 0.6, 0.92 + rng() * 0.16);
      }
      for (const side of [-1, 1]) {
        const s = sp.wrapS(j.s + 6);
        const lat = side * (sp.widthAt(s) * 2.3 + 6);
        const q = sp.offsetPoint(s, lat, _pp);
        if (Math.abs(q.x) > PLAYABLE_EXT - 8 || Math.abs(q.z) > PLAYABLE_EXT - 8) continue;
        if (this.terrain.slopeAt(q.x, q.z) > 20) continue;
        const c = sp.posAt(s, _pp2);
        this._dress('canopy', q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(c.x - q.x, c.z - q.z), 1, 0.9);
      }
    }
  }

  /**
   * Sponsor arch over a hero jump's take-off. Straddles the ramp at twice
   * the road width so nobody can hit a leg, and carries the jump's name —
   * which is the only place in the game a set piece is announced by name.
   */
  _buildJumpArch(j, accent, w) {
    const sp = this.data.spline;
    const s = sp.wrapS(j.s - j.len * 0.55);
    const span = w * 2.6 + 6;
    const H = 8.4;
    const g = new THREE.Group();
    const legGeo = this._keepGeo(new THREE.CylinderGeometry(0.22, 0.30, H, 9));
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, this.postMat);
      leg.position.set(side * span * 0.5, H * 0.5, 0);
      leg.castShadow = true;
      g.add(leg);
      const brace = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(2.1, 0.16, 0.16)), this.postMat);
      brace.position.set(side * (span * 0.5 - 0.8), H - 0.8, 0);
      brace.rotation.z = -side * 0.62;
      g.add(brace);
    }
    const beam = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(span, 0.40, 0.46)), this.postMat);
    beam.position.y = H; beam.castShadow = true; g.add(beam);
    const label = (j.name || 'BIG AIR').toUpperCase();
    const banner = new THREE.Mesh(
      this._keepGeo(new THREE.PlaneGeometry(span * 0.92, 1.9)),
      this._keepMat(new THREE.MeshStandardMaterial({
        map: this._keepTex(bannerTex(label, accent)),
        side: THREE.DoubleSide, roughness: 0.86, metalness: 0,
      })));
    banner.position.y = H - 1.25;
    banner.rotation.y = Math.PI;             // face the oncoming car
    banner.castShadow = true;
    g.add(banner);

    const p = sp.posAt(s, _pp), d = sp.dirAt(s, _dd);
    g.position.set(p.x, this.terrain.heightAt(p.x, p.z), p.z);
    g.rotation.y = Math.atan2(d.x, d.z);
    this.group.add(g);
    this.jumpArches.push(g);
    for (const side of [-1, 1]) {
      const q = sp.offsetPoint(s, side * span * 0.5, _pp);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 0.6, kind: 'arch', bounce: 1.1 });
    }
  }

  /* ---------------- corner crowds ----------------
     People gather where cars go wrong, which means the tightest corner on
     the lap. Same scan the warning boards use, so the crowd and the sign
     always agree about where the corner is. */
  _planCrowds(rng) {
    const sp = this.data.spline;
    for (const c of this._tightestCorners(3)) {
      const outside = c.k > 0 ? -1 : 1;
      for (let i = 0; i < 10; i++) {
        const s = sp.wrapS(c.s - 20 + rng() * 46);
        const lat = outside * (sp.widthAt(s) * 1.85 + 3 + rng() * 8);
        const q = sp.offsetPoint(s, lat, _pp);
        if (Math.abs(q.x) > PLAYABLE_EXT - 8 || Math.abs(q.z) > PLAYABLE_EXT - 8) continue;
        if (this.terrain.slopeAt(q.x, q.z) > 30) continue;
        const id = 'person' + (i % 3);
        this._crowdIds.add(id);
        const p = sp.posAt(s, _pp2);
        this._dress(id, q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(p.x - q.x, p.z - q.z) + (rng() - 0.5) * 0.5, 0.92 + rng() * 0.16);
      }
      const s = sp.wrapS(c.s);
      const lat = outside * (sp.widthAt(s) * 2.5 + 7);
      const q = sp.offsetPoint(s, lat, _pp);
      if (Math.abs(q.x) < PLAYABLE_EXT - 8 && Math.abs(q.z) < PLAYABLE_EXT - 8 &&
        this.terrain.slopeAt(q.x, q.z) < 20) {
        const p = sp.posAt(s, _pp2);
        this._dress('canopy', q.x, this.terrain.heightAt(q.x, q.z), q.z,
          Math.atan2(p.x - q.x, p.z - q.z), 1, 0.9);
      }
    }
  }

  /** Turn the plan into meshes: one instanced draw per shape, one for wires. */
  _flushDressing() {
    this.dressMeshes = [];
    this.crowdMeshes = [];
    this._billboardSites = this._dressSites.get('billboard') || null;
    for (const [id, sites] of this._dressSites) {
      if (!sites.length) continue;
      const geo = this._kitGeo(id);
      const im = new THREE.InstancedMesh(geo, this.dressMat, sites.length);
      im.castShadow = true;
      im.receiveShadow = false;
      im.frustumCulled = false;
      for (let i = 0; i < sites.length; i++) {
        const st = sites[i];
        _dummy.position.set(st.x, st.y, st.z);
        _dummy.rotation.set(0, st.yaw, 0);
        _dummy.scale.setScalar(st.scale);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.dressMeshes.push(im);
      if (this._crowdIds.has(id)) {
        /* The crowd is the only dressing that MOVES, so it is the only one
           that has to keep its rest pose after the flush — the bob rebuilds
           each matrix from scratch rather than accumulating on to the last
           one, because an accumulating bob drifts a spectator across the
           hillside over a three-lap race. Flat, five floats a person. */
        const rest = new Float32Array(sites.length * 5);
        for (let i = 0; i < sites.length; i++) {
          const st = sites[i], o = i * 5;
          rest[o] = st.x; rest[o + 1] = st.y; rest[o + 2] = st.z;
          rest[o + 3] = st.yaw; rest[o + 4] = st.scale;
        }
        im.userData.rest = rest;
        im.userData.bobbing = 0;      // how many are currently displaced
        this.crowdMeshes.push(im);
      }
    }
    // The billboard sites survive the clear below because the sponsor faces
    // are built from them a moment later; nothing else outlives the flush.
    if (this._billboardSites) this._billboardSites = this._billboardSites.slice();
    if (this._oneOff.length) {
      const merged = mergeGeometries(this._oneOff, false);
      this._oneOff.forEach(g => g.dispose());
      this._oneOff.length = 0;
      if (merged) {
        const m = new THREE.Mesh(this._keepGeo(merged), this.dressMat);
        m.castShadow = false;          // a shadow-casting wire is a stripe of acne
        m.frustumCulled = false;
        this.group.add(m);
        this.wireMesh = m;
      }
    }
    flushWasteland(this);
    this._dressSites.clear();
  }

  /** Start gantry straddling s = 0. */
  buildGantry(accent) {
    const sp = this.data.spline;
    const gs = 0;
    const w = sp.widthAt(gs);
    const span = w * 2 + 5;
    const H = 7.2;
    const g = new THREE.Group();

    const legGeo = this._keepGeo(new THREE.CylinderGeometry(0.26, 0.34, H, 10));
    const beamGeo = this._keepGeo(new THREE.BoxGeometry(span, 0.42, 0.5));
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, this.postMat);
      leg.position.set(s * span * 0.5, H * 0.5, 0);
      leg.castShadow = true;
      g.add(leg);
      const foot = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(1.4, 0.3, 1.4)), this.postMat);
      foot.position.set(s * span * 0.5, 0.15, 0);
      g.add(foot);
      // brace back to the beam
      const br = new THREE.Mesh(this._keepGeo(new THREE.BoxGeometry(2.4, 0.18, 0.18)), this.postMat);
      br.position.set(s * (span * 0.5 - 0.9), H - 0.9, 0);
      br.rotation.z = -s * 0.6;
      g.add(br);
    }
    const beam = new THREE.Mesh(beamGeo, this.postMat);
    beam.position.y = H; beam.castShadow = true; g.add(beam);

    const tex = this._keepTex(gantryTex(accent));
    const banner = new THREE.Mesh(
      this._keepGeo(new THREE.PlaneGeometry(span * 0.94, 1.5)),
      this._keepMat(new THREE.MeshStandardMaterial({
        map: tex, side: THREE.DoubleSide, roughness: 0.85, metalness: 0
      })));
    banner.position.y = H - 1.1;
    // The group's +Z points DOWNSTREAM; racers approach from upstream and would
    // read the plane's back face mirrored. Face the text at the traffic.
    banner.rotation.y = Math.PI;
    banner.castShadow = true;
    g.add(banner);

    const p = sp.posAt(gs, _pp), d = sp.dirAt(gs, _dd);
    g.position.set(p.x, this.terrain.heightAt(p.x, p.z), p.z);
    g.rotation.y = Math.atan2(d.x, d.z);
    this.group.add(g);
    this.gantry = g;

    // The legs are solid. They sit outside the roadbed, but a car arriving
    // sideways off the grid will find them.
    for (const s of [-1, 1]) {
      const q = sp.offsetPoint(gs, s * span * 0.5, _pp);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 0.7, kind: 'gantry', bounce: 1.1 });
    }
  }

  /** Two posts and a slim banner at every checkpoint flagged `big`. */
  buildGates(accent) {
    const sp = this.data.spline;
    const postGeo = this._keepGeo(new THREE.CylinderGeometry(0.16, 0.2, 4.4, 8));
    const gateTex = this._keepTex(bannerTex('CHECK', accent));
    const gateMat = this._keepMat(new THREE.MeshStandardMaterial({
      map: gateTex, side: THREE.DoubleSide, roughness: 0.88, metalness: 0
    }));
    this.gates = [];
    const cps = this.data.checkpoints;
    const L = sp.length;
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (!c.big || c.alt) continue;
      /* The first checkpoint sits at or near s = 0, which is where the start
         gantry already straddles the road — two banners on top of each other,
         the CHECK one reading through the ROAD RASH one. The gantry IS the
         first gate; skip anything inside 45 m of it. */
      const ds = Math.min(sp.wrapS(c.s), L - sp.wrapS(c.s));
      if (ds < 45) continue;
      const w = sp.widthAt(c.s);
      const span = w * 2 + 2.6;
      const g = new THREE.Group();
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, this.postMat);
        post.position.set(s * span * 0.5, 2.2, 0);
        post.castShadow = true;
        g.add(post);
      }
      const bn = new THREE.Mesh(this._keepGeo(new THREE.PlaneGeometry(span, 0.9)), gateMat);
      bn.position.y = 4.0;
      bn.rotation.y = Math.PI;          // face oncoming traffic, not the exit
      g.add(bn);
      const d = sp.dirAt(c.s, _dd);
      g.position.set(c.x, this.terrain.heightAt(c.x, c.z), c.z);
      g.rotation.y = Math.atan2(d.x, d.z);
      this.group.add(g);
      this.gates.push(g);
      for (const s of [-1, 1]) {
        const q = sp.offsetPoint(c.s, s * span * 0.5, _pp);
        this._fixedColliders.push({ x: q.x, z: q.z, r: 0.45, kind: 'gate', bounce: 1.0 });
      }
    }
  }

  /* ---------------- barrier runs ----------------
     Posts are instanced; the rail is one merged strip per run. Collision is
     SEGMENTS, not a bead of circles: a car sliding along a wall at 30 m/s must
     glance off it, and a row of discs would chatter it into the scenery. */
  buildBarriers(accent) {
    const walls = this.data.walls || [];
    if (!walls.length) { this.barrierMesh = null; return; }
    const sp = this.data.spline, L = sp.length;
    const rTex = this._keepTex(railTex(accent));
    rTex.wrapS = THREE.RepeatWrapping;
    const railMat = this._keepMat(new THREE.MeshStandardMaterial({
      map: rTex, roughness: 0.62, metalness: 0.25, side: THREE.DoubleSide
    }));
    const postGeo = this._keepGeo(new THREE.BoxGeometry(0.18, 1.15, 0.18));
    const railStrips = [];
    const posts = [];
    const SPACING = 4.5;

    for (const wl of walls) {
      let s0 = sp.wrapS(wl.s0), s1 = sp.wrapS(wl.s1);
      let span = s1 - s0; if (span <= 0) span += L;
      const sides = wl.side === 0 ? [-1, 1] : [wl.side];
      for (const side of sides) {
        const n = Math.max(2, Math.round(span / SPACING));
        let prev = null;
        for (let i = 0; i <= n; i++) {
          const s = s0 + span * (i / n);
          const off = side * (sp.widthAt(s) * 1.32 + 0.7);
          const q = sp.offsetPoint(s, off, _pp);
          const y = this.terrain.heightAt(q.x, q.z);
          posts.push([q.x, y, q.z]);
          if (prev) {
            // rail quad from prev to here, 0.55 m tall, centred at 0.78 m
            railStrips.push(railQuad(prev[0], prev[1] + 0.78, prev[2], q.x, y + 0.78, q.z, 0.55));
            this.barriers.push({
              ax: prev[0], az: prev[2], bx: q.x, bz: q.z, r: 0.45, kind: 'barrier'
            });
          }
          prev = [q.x, y, q.z];
        }
      }
    }

    if (posts.length) {
      const im = new THREE.InstancedMesh(postGeo, this.postMat, posts.length);
      im.castShadow = true; im.frustumCulled = false;
      for (let i = 0; i < posts.length; i++) {
        _dummy.position.set(posts[i][0], posts[i][1] + 0.55, posts[i][2]);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.barrierPosts = im;
    }
    if (railStrips.length) {
      const merged = mergeGeometries(railStrips, false);
      for (const g of railStrips) g.dispose();
      merged.computeVertexNormals();
      const m = new THREE.Mesh(this._keepGeo(merged), railMat);
      m.castShadow = true; m.frustumCulled = false;
      this.group.add(m);
      this.barrierMesh = m;
    }
  }

  /* ---------------- warning boards ----------------
     One before every jump, and one before anything tighter than 55 m radius.
     They go on the OUTSIDE of the corner, which is where a driver is already
     looking when they are about to get it wrong. */
  buildSigns() {
    const sp = this.data.spline, L = sp.length;
    const mats = [
      this._keepMat(new THREE.MeshStandardMaterial({ map: this._keepTex(arrowTex(-1)), roughness: 0.8, side: THREE.DoubleSide })),
      this._keepMat(new THREE.MeshStandardMaterial({ map: this._keepTex(arrowTex(1)), roughness: 0.8, side: THREE.DoubleSide })),
      this._keepMat(new THREE.MeshStandardMaterial({ map: this._keepTex(arrowTex(0)), roughness: 0.8, side: THREE.DoubleSide }))
    ];
    const boardGeo = this._keepGeo(new THREE.PlaneGeometry(1.5, 1.5));
    const legGeo = this._keepGeo(new THREE.CylinderGeometry(0.07, 0.07, 1.7, 6));
    const sites = [];
    for (const j of this.data.jumps) sites.push({ s: sp.wrapS(j.s - 42), type: 2, side: 1 });
    // scan for corners, keeping only the tightest point of each one
    let run = null;
    for (let s = 0; s < L; s += 4) {
      const k = sp.curvatureAt(s);
      if (Math.abs(k) > 1 / 55) {
        if (!run || Math.abs(k) > Math.abs(run.k)) run = { s, k };
      } else if (run) {
        sites.push({ s: sp.wrapS(run.s - 46), type: run.k > 0 ? 0 : 1, side: run.k > 0 ? -1 : 1 });
        run = null;
      }
    }
    this.signs = [];
    for (const site of sites) {
      const w = sp.widthAt(site.s);
      const off = site.side * (w * 1.28 + 1.6);
      const q = sp.offsetPoint(site.s, off, _pp);
      if (Math.abs(q.x) > PLAYABLE_EXT || Math.abs(q.z) > PLAYABLE_EXT) continue;
      const y = this.terrain.heightAt(q.x, q.z);
      const g = new THREE.Group();
      const leg = new THREE.Mesh(legGeo, this.postMat);
      leg.position.y = 0.85; g.add(leg);
      const bd = new THREE.Mesh(boardGeo, mats[site.type]);
      bd.position.y = 2.2; bd.castShadow = true; g.add(bd);
      const d = sp.dirAt(site.s, _dd);
      g.position.set(q.x, y, q.z);
      // face back down the track at the oncoming car
      g.rotation.y = Math.atan2(-d.x, -d.z);
      this.group.add(g);
      this.signs.push(g);
      this._fixedColliders.push({ x: q.x, z: q.z, r: 0.3, kind: 'sign', bounce: 0.6 });
    }
  }

  /** Checker stripe painted on the ground at s = 0, conforming to the terrain. */
  buildFinishStripe() {
    const sp = this.data.spline;
    const w = sp.widthAt(0) * 1.25;
    const NW = 20, NL = 3, LEN = 2.2;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= NL; j++) {
      const s = sp.wrapS(-LEN * 0.5 + LEN * (j / NL));
      for (let i = 0; i <= NW; i++) {
        const lat = -w + 2 * w * (i / NW);
        const q = sp.offsetPoint(s, lat, _pp);
        // 6 cm proud: any less and the clipmap's own sag pokes through it
        pos.push(q.x, this.terrain.heightAt(q.x, q.z) + 0.06, q.z);
        uv.push(i / NW * 6, j / NL);
      }
    }
    for (let j = 0; j < NL; j++) for (let i = 0; i < NW; i++) {
      const a = j * (NW + 1) + i, b = a + 1, c = a + NW + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = this._keepTex(checkerTex());
    tex.wrapS = THREE.RepeatWrapping;
    const m = new THREE.Mesh(this._keepGeo(g), this._keepMat(new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2
    })));
    m.receiveShadow = true;
    this.group.add(m);
    this.finishStripe = m;
  }

  /* ============================================================
     collision
     ============================================================ */
  _buildBroadphase() {
    const dim = this._bpDim = Math.ceil((GRID_HALF * 2) / GRID_CELL);
    const lists = new Array(dim * dim);
    const push = (cx, cz, v) => {
      if (cx < 0 || cz < 0 || cx >= dim || cz >= dim) return;
      const k = cz * dim + cx;
      (lists[k] || (lists[k] = [])).push(v);
    };
    const cell = (v) => Math.floor((v + GRID_HALF) / GRID_CELL);
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const r = c.r + 2;
      for (let gz = cell(c.z - r); gz <= cell(c.z + r); gz++)
        for (let gx = cell(c.x - r); gx <= cell(c.x + r); gx++) push(gx, gz, i);
    }
    // barriers get their own list; they are indexed negatively so one bucket
    // can hold both populations without a second grid
    for (let i = 0; i < this.barriers.length; i++) {
      const b = this.barriers[i];
      const x0 = Math.min(b.ax, b.bx) - 2, x1 = Math.max(b.ax, b.bx) + 2;
      const z0 = Math.min(b.az, b.bz) - 2, z1 = Math.max(b.az, b.bz) + 2;
      for (let gz = cell(z0); gz <= cell(z1); gz++)
        for (let gx = cell(x0); gx <= cell(x1); gx++) push(gx, gz, -(i + 1));
    }
    // flatten to CSR — resolve() runs six times a frame and must not allocate
    const off = this._bpOff = new Int32Array(dim * dim + 1);
    let total = 0;
    for (let k = 0; k < dim * dim; k++) { off[k] = total; if (lists[k]) total += lists[k].length; }
    off[dim * dim] = total;
    const idx = this._bpIdx = new Int32Array(total);
    let o = 0;
    for (let k = 0; k < dim * dim; k++) { const L = lists[k]; if (!L) continue; for (let i = 0; i < L.length; i++) idx[o++] = L[i]; }
  }

  /**
   * Push a vehicle out of anything solid it has ended up inside.
   * @param {{pos:THREE.Vector3, vel:THREE.Vector3, omega?:THREE.Vector3}} v
   * @returns {number} impact speed in m/s along the contact normal (0 = clean)
   */
  resolve(v) {
    const px = v.pos.x, pz = v.pos.z;
    const dim = this._bpDim;
    const gx = Math.floor((px + GRID_HALF) / GRID_CELL);
    const gz = Math.floor((pz + GRID_HALF) / GRID_CELL);
    if (gx < 0 || gz < 0 || gx >= dim || gz >= dim) return 0;
    const k = gz * dim + gx;
    const o0 = this._bpOff[k], o1 = this._bpOff[k + 1];
    if (o0 === o1) return 0;
    const R0 = v.collideR || CAR_R;
    let impact = 0;

    for (let o = o0; o < o1; o++) {
      const id = this._bpIdx[o];
      let nx, nz, pen, bounce;
      if (id >= 0) {
        const c = this.colliders[id];
        const dx = v.pos.x - c.x, dz = v.pos.z - c.z;
        const d2 = dx * dx + dz * dz;
        const R = c.r + R0;
        if (d2 > R * R || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        nx = dx / d; nz = dz / d; pen = R - d; bounce = c.bounce || 1.2;
      } else {
        const b = this.barriers[-id - 1];
        const ex = b.bx - b.ax, ez = b.bz - b.az;
        const el2 = ex * ex + ez * ez;
        if (el2 < 1e-9) continue;
        let t = ((v.pos.x - b.ax) * ex + (v.pos.z - b.az) * ez) / el2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = b.ax + ex * t, cz = b.az + ez * t;
        const dx = v.pos.x - cx, dz = v.pos.z - cz;
        const d2 = dx * dx + dz * dz;
        const R = b.r + R0;
        if (d2 > R * R || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        // Barriers absorb rather than bounce: hitting a wall should cost you
        // time and paint, not fire you back across the road.
        nx = dx / d; nz = dz / d; pen = R - d; bounce = 0.55;
      }
      v.pos.x += nx * pen; v.pos.z += nz * pen;
      const vn = v.vel.x * nx + v.vel.z * nz;
      if (vn < 0) {
        v.vel.x -= vn * nx * bounce; v.vel.z -= vn * nz * bounce;
        /* A glancing hit should twist the car a little — clipping a rock
           squarely and carrying on straight reads as hitting a wall of jelly.
           The twist is arbitrary, so it used to be Math.random(); it is a hash
           of the CONTACT POINT instead, which looks identical and makes a race
           reproducible. That matters: dev/qa-drive.js compares lap times
           between builds, and an unseeded nudge here is enough noise on a
           three-lap race to hide a real regression. */
        if (v.omega) v.omega.y += (hash2(v.pos.x + nx, v.pos.z + nz) - 0.5) * Math.min(-vn, 5) * 0.08;
        if (-vn > impact) impact = -vn;
      }
    }
    return impact;
  }

  /**
   * Hand the stage the two particle systems. Both stay optional and every
   * use is guarded: props has to build and collide correctly in a harness
   * that never made either one.
   */
  setVfx(vfx, dust) {
    this.vfx = vfx || null;
    this.dust = dust || null;
    return this;
  }

  update(dt, t, camera) {
    if (dt <= 0 || !camera) return;
    this._bobCrowd(t, camera);
    this._runGeysers(dt, camera);
    this._runFalls(dt, camera);
    runEmbers(this, dt, camera);
  }

  /* ---------------- the crowd ----------------
     A stand full of people standing perfectly still is the single most
     dead-looking thing you can put beside a race track — worse than an
     empty stand, because an empty stand at least does not claim anybody
     came. Eight radians a second is about 1.3 bounces, with a per-person
     phase so it is a crowd and not a chorus line.

     Only inside 120 m, which is where a figure is more than a few pixels;
     and the moment one leaves that radius it is written back to its rest
     pose exactly once, so the far crowd costs nothing per frame. */
  _bobCrowd(t, camera) {
    const meshes = this.crowdMeshes;
    if (!meshes || !meshes.length) return;
    const cx = camera.position.x, cz = camera.position.z;
    const R2 = 120 * 120;
    for (let mi = 0; mi < meshes.length; mi++) {
      const im = meshes[mi];
      if (!im.visible) continue;
      const rest = im.userData.rest;
      const n = Math.min(im.count, rest.length / 5);
      let touched = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        const dx = rest[o] - cx, dz = rest[o + 2] - cz;
        const near = dx * dx + dz * dz < R2;
        if (!near) continue;
        const ph = i * 2.399963;                    // golden angle: no visible beat
        const b = Math.sin(t * 8.0 + ph);
        _dummy.position.set(rest[o], rest[o + 1] + 0.055 + 0.055 * b, rest[o + 2]);
        _dummy.rotation.set(0, rest[o + 3] + 0.10 * Math.sin(t * 3.1 + ph), 0);
        _dummy.scale.set(rest[o + 4], rest[o + 4] * (1 - 0.035 * b), rest[o + 4]);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
        touched++;
      }
      // one settling pass when the last of them goes out of range
      if (!touched && im.userData.bobbing) {
        for (let i = 0; i < n; i++) {
          const o = i * 5;
          _dummy.position.set(rest[o], rest[o + 1], rest[o + 2]);
          _dummy.rotation.set(0, rest[o + 3], 0);
          _dummy.scale.setScalar(rest[o + 4]);
          _dummy.updateMatrix();
          im.setMatrixAt(i, _dummy.matrix);
        }
      }
      if (touched || im.userData.bobbing) im.instanceMatrix.needsUpdate = true;
      im.userData.bobbing = touched;
    }
  }

  /* ---------------- the vent field ----------------
     One geyser every six to nine seconds, and never the same one twice in a
     row. The timing is Math.random() and that is deliberate: it is cosmetic,
     nothing reads it back, and a vent field on a fixed clock reads as a
     machine rather than as geology. */
  _runGeysers(dt, camera) {
    const G = this.geysers;
    if (!G || !G.length) return;
    this._geyT = (this._geyT === undefined ? 3 : this._geyT) - dt;
    if (this._geyT > 0) return;
    this._geyT = 6 + Math.random() * 3;
    let i = (Math.random() * G.length) | 0;
    if (G.length > 1 && i === this._geyLast) i = (i + 1) % G.length;
    this._geyLast = i;
    const g = G[i];
    const dx = g.x - camera.position.x, dz = g.z - camera.position.z;
    if (dx * dx + dz * dz > 260 * 260) return;      // nobody is there to see it
    if (this.dust) {
      // steam, not smoke: pale, buoyant, and it goes UP hard before it drifts
      this.dust.spawn(26, g.x, g.y + 0.6, g.z, 7.5, 0.55, 0, 0,
        0.82, 0.84, 0.86, DUST_KIND.PUFF);
    }
    if (this.vfx) {
      this.vfx.sparks(14, g.x, g.y + 0.4, g.z, 0, 1, 0, 13.0, 0.20,
        1.10, 1.25, 1.45, 0.85);
      this.vfx.shock(g.x, g.y, g.z, 2.6, 0.9, 1.05, 1.25);
    }
  }

  /** Mist off the plunge pool, and the sheet's own scroll clock. */
  _runFalls(dt, camera) {
    if (!this.waterfallMat) return;
    const u = this.waterfallMat.uniforms.uTime;
    u.value = (u.value + dt) % 2048;
    const W = this.waterfalls;
    if (!W.length || !this.dust) return;
    this._mistT = (this._mistT === undefined ? 0 : this._mistT) - dt;
    if (this._mistT > 0) return;
    this._mistT = 0.22;
    const w = W[0];
    const dx = w.x - camera.position.x, dz = w.z - camera.position.z;
    if (dx * dx + dz * dz > 170 * 170) return;
    this.dust.spawn(2, w.x, w.y + 0.7, w.z, 2.2, 2.4, 0, 0,
      0.86, 0.90, 0.94, DUST_KIND.PUFF);
  }

  dispose() {
    /* Set FIRST. A hero model's load can still be in flight, and its
       continuation adds a Group to a scene this call is in the middle of
       tearing down; the flag is how that continuation knows to throw its
       instance away instead. */
    this._disposed = true;
    this.scene.remove(this.group);
    this.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    disposeHeroModels(this);
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    for (const t of this._tex) t.dispose();
    this._geo.length = 0; this._mat.length = 0; this._tex.length = 0;
    this.colliders.length = 0; this.barriers.length = 0;
    if (this.fireDrums) this.fireDrums.length = 0;
  }
}

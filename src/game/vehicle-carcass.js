/* ============================================================
   RALLY ROAD RASH — carcass and arsenal rig
   ------------------------------------------------------------
   The wave-8 half of vehicle art, split out because vehicle-art.js was at
   the line ceiling: the OPTIONAL generated GLB body, and the rocket
   launcher with its ammo rack that every machine wears whether or not a
   GLB ever arrives.

   The carcass is a look upgrade under the same terms as every image in
   assets/ (ARCHITECTURE hard rule 1, wave-8 amendment): it loads lazily
   through core/models.js, never blocks a frame, and a missing or broken
   file leaves EXACTLY today's procedural body on screen. The procedural
   body is built first, every time, and is only hidden — never skipped —
   the frame the GLB resolves. dev/model-check.mjs gates the files;
   renaming assets/ aside is the runtime test.

   What a generated carcass needs before it can be worn:

     • FIT. The mesh is in its own units with its long axis wherever the
       generator left it. vehicle-fit.js holds the measured table and the
       arithmetic; here it becomes one Group transform.
     • STRIP. The image model draws wheels however the prompt reads, and
       the mesh model fuses them into the body — one node, one primitive,
       no `wheel` to delete. So the wheels go by TRIANGLE: every face whose
       centroid falls inside a wheel cylinder is dropped from the index, and
       the game's own tyres — which steer, spin and travel — take their
       place. Done once per url and cached; models.js shares geometry
       between instances, so two rivals on one machine strip once.
     • DRESS. Materials get the mud patch, the ghost fade and (for AI
       liveries) the paint hue, so a carcass behaves like the panels it
       replaces under every existing effect.

   The launcher is procedural in both cases — P3's kit-arsenal.js shapes
   under the car's own vertex-colour material — and publishes `v._muzzle`
   for Vehicle.muzzleWorld (ARCHITECTURE §8.2): an empty Object3D parked at
   the tube mouth under the rig, so getWorldPosition() and its matrixWorld
   answer position and forward exactly, lean and pitch included, and never
   a frame stale (getWorldPosition re-walks the parents). The rack is
   `ammoCap` rockets built once and toggled by `.visible` off `v.ammo`, so
   the per-frame cost is a comparison.

   Conventions match vehicle-art.js: metres, radians, Y up, local forward
   +Z, right −X, origin at the centre of mass.
   ============================================================ */
import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { kitPalette } from '../world/kit.js';
import { launcherGeo, rocketGeo } from '../world/kit-arsenal.js';
import { LAUNCHERS } from './weapons.js';
import { MODEL_FIT, carcassFit, wheelZones, inWheelZone } from './vehicle-fit.js';

/* Where the tube axis and the muzzle sit in launcherGeo's own frame. These
   mirror kit-arsenal.js (`AXIS` and `TL / 2`) — a rocket spawned anywhere
   else pops out of the plate or the breech. */
const MUZZLE_Y = 0.195, MUZZLE_Z = 0.36, TUBE_PITCH = 0.18;
/* Rack rockets are the projectile at just over half size: a full 0.9 m
   round six times over is a second car on the roof. */
const RACK_SCALE = 0.55, RACK_PITCH = 0.105;
const RACK_DEFAULT = 6, RACK_MAX = 12;

/* ---------------- source ----------------
   Who says where a machine's GLB lives. The default is the served layout
   (index.html at the root); dev/garage.js overrides it with '../assets/…'
   and `?model=0` sets it null. main.js may point it at assets.url() once
   the manifest carries model entries — either answer is a relative url. */
/* No default. A guessed path is a second source of truth, and the earlier one
   wins: this used to default to 'assets/models/<id>-carcass.glb', so the menu
   scene fetched a GLB at boot — before main.js had installed the manifest
   lookup — and bypassed the manifest entirely. On a tree with no assets/ that
   is a 404 in the console for a file nobody ever said existed, which is a QA
   gate (hard rule 1), and it also made contract 8.6's "read it with
   assets.url(id)" untrue in the one place it mattered.
   Whoever owns the page declares the source: main.js from the manifest, and
   dev/garage.js from its own ?model flag. Until then there is no carcass, and
   no carcass means today's procedural body. */
let _source = null;
export function setCarcassSource(fn) { _source = typeof fn === 'function' ? fn : null; }

/* The renderer, for one number: the maximum anisotropy this GPU will sample
   with. It is a capability, not a scene object, and there is no other way to
   ask for it — three keeps it on the renderer. Optional on purpose: the Node
   harnesses and dev/garage both build vehicles, only one of them has a
   renderer to hand, and a missing one costs a carcass its sharpest grazing
   angles and nothing else. */
let _renderer = null;
export function setCarcassRenderer(r) { _renderer = (r && r.capabilities) ? r : null; }
function maxAniso() {
  return _renderer ? _renderer.capabilities.getMaxAnisotropy() : 0;
}

/* core/models.js pulls GLTFLoader, which the Node harnesses must never see,
   so it is imported on first use and only when there is a window to load
   into. One job, shared by every vehicle. */
let _modelsJob = null, _models = null;
function models() {
  if (!_modelsJob) {
    _modelsJob = import('../core/models.js').then((m) => (_models = m), () => null);
  }
  return _modelsJob;
}

/** template geometry → { geometry, tris, kept, box }. Never evicted, like
    the model cache it shadows: the templates it keys are never evicted
    either during a session. */
const _stripped = new Map();

/* ============================================================
   carcass
   ============================================================ */

/**
 * Start the (optional) carcass load for `v`. Returns immediately; the
 * procedural body already built by vehicle-art stays until the GLB lands,
 * and stays for good if it never does.
 */
export function attachCarcass(v, spec, M) {
  v.carcass = null;
  v._carcassInfo = null;
  const url = (_source && typeof window !== 'undefined') ? _source(spec.id) : null;
  if (!url) return;
  const gen = v._carcassGen = (v._carcassGen | 0) + 1;
  models()
    .then((mod) => (mod ? mod.loadModel(url) : null))
    .then((group) => {
      if (!group) return;
      // disposed, or rebuilt, while the file was in flight
      if (!v.root || v._carcassGen !== gen) { _models.disposeModel(group); return; }
      fitCarcass(v, spec, M, group, url);
    })
    .catch((err) => {
      console.warn('[carcass] ' + spec.id + ': ' + ((err && err.message) || err) +
        ' — keeping the procedural body');
    });
}

/** Take the carcass off `v` (dispose path, and a rebuild guard). */
export function detachCarcass(v) {
  v._carcassGen = (v._carcassGen | 0) + 1;
  if (v.carcass) {
    if (v.carcass.parent) v.carcass.parent.remove(v.carcass);
    if (_models) _models.disposeModel(v.carcass);
    v.carcass = null;
  }
  v._carcassInfo = null;
}

function fitCarcass(v, spec, M, group, url) {
  group.updateMatrixWorld(true);
  _box.setFromObject(group);
  if (_box.isEmpty()) { _models.disposeModel(group); return; }
  _raw.min[0] = _box.min.x; _raw.min[1] = _box.min.y; _raw.min[2] = _box.min.z;
  _raw.max[0] = _box.max.x; _raw.max[1] = _box.max.y; _raw.max[2] = _box.max.z;
  const fit = carcassFit(spec, spec.id, _raw);
  const zones = wheelZones(spec, spec.id, fit);
  _fitM.compose(_p.set(fit.x, fit.y, fit.z), _q.setFromAxisAngle(_yUp, fit.yaw), _s3.setScalar(fit.s));

  const F = MODEL_FIT[spec.id] || {};
  const tintAll = !F.tint || F.tint.length === 0;
  /* AI variants: the paint hue over the scan, lifted toward white so a
     saturated team colour tints the steel rather than painting it black.
     The works car keeps the raw scan — that is the point of the scan. */
  const tint = v.livery > 0 ? new THREE.Color(v.paintColor).lerp(_white, 0.45) : null;

  let tris = 0, kept = 0;
  const aniso = maxAniso();
  const kbox = new THREE.Box3();
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.castShadow = true; o.receiveShadow = true;
    _m.multiplyMatrices(_fitM, o.matrixWorld);        // geometry → body space
    const rec = stripGeometry(o.geometry, _m, zones);
    o.geometry = rec.geometry;
    tris += rec.tris; kept += rec.kept;
    kbox.union(rec.box);
    /* The mud mask wants body-space height, and this geometry is in model
       units under a node transform: hand the shader the row of the matrix
       that produces body y. */
    const e = _m.elements;
    const row = new THREE.Vector4(e[1], e[5], e[9], e[13]);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (!mat) continue;
      mat.envMapIntensity = 1;
      if (!mat.name) mat.name = 'carcass';
      if (tint && (tintAll || F.tint.indexOf(mat.name) >= 0)) mat.color.multiply(tint);
      sharpen(mat, aniso);
      /* Both of the branches below are FOR THE FILE WE HAVE NOT BEEN SENT
         YET, and neither of them fires on the four carcasses in assets/
         today: every one of those ships a metallicRoughness map and a normal
         map of its own, and a map is the generator's answer where a constant
         is only ever our guess. What they cover is the plainer export —
         albedo and nothing else — because glTF's default for a material with
         no metallicRoughness is roughness 1, metalness 1, which draws a
         painted car as a sheet of black chrome, and because a scan's relief
         is painted into its colour with flat geometry underneath, so the
         panel gaps and the rivets read at 40 m and vanish at 4.
         Half strength on the derived normal: luminance is right about WHERE
         the detail is and always guessing how deep. */
      if (mat.isMeshStandardMaterial) {
        if (!mat.roughnessMap) mat.roughness = 0.78;
        if (!mat.metalnessMap) mat.metalness = 0.25;
        if (!mat.normalMap && mat.map && _models.normalFromAlbedo) {
          const nm = _models.normalFromAlbedo(mat.map);
          if (nm) { mat.normalMap = nm; mat.normalScale.set(0.6, 0.6); }
        }
      }
      mudify(mat, v._uMud, row);
      v._ghost.mats.push(mat);
      if (v._ghost.k > 0) { mat.transparent = true; mat.opacity = 1 - 0.58 * v._ghost.k; }
      mat.needsUpdate = true;
    }
  });

  group.position.set(fit.x, fit.y, fit.z);
  group.rotation.set(0, fit.yaw, 0);
  group.scale.setScalar(fit.s);
  group.name = 'carcass';
  v.chassis.add(group);
  v.carcass = group;
  v._carcassInfo = { url, tris, kept, box: kbox, fit };

  /* The frame the GLB resolves: the merged body panels go, and the lamp and
     brake panels go with them — a painted carcass draws its own headlights,
     and a procedural disc left floating at the PROCEDURAL body's coordinates
     inside one is exactly the "primitive penetrating the model" the eye
     catches first. `keepLamps` opts a machine back out (MODEL_FIT).
     What has to survive either way is the light: the blooms are Sprites under
     `_glowRig`, which the shadow pass skips and which no carcass can draw
     for itself, so they are moved by the measured delta instead of hidden. */
  for (const mesh of v._bodyMeshes) {
    if (F.keepLamps && (mesh.material === M.lamp || mesh.material === M.brake)) continue;
    mesh.visible = false;
  }
  if (!F.keepLamps && F.lamps && v._glowRig) {
    /* buildGlowRig parks every bloom as a SIBLING of the flare with its offset
       from the flare baked into the local position — so a body-space delta is
       a plain add here, and the flare's own halo (under `_flameRig`) is
       untouched by it. Every head glow moves, including a roof light bar: one
       delta per kind is the contract, and the fit table records what that does
       to the pod on the machines that have one. */
    for (const s of v._glowRig.children) {
      const d = s.material === M.headGlow ? F.lamps.head
        : s.material === M.brakeGlow ? F.lamps.brake : null;
      if (!d) continue;
      s.position.set(s.position.x + (d.dx || 0),
        s.position.y + (d.dy || 0), s.position.z + (d.dz || 0));
    }
  }
  /* The launcher is bolted to a roof or a deck, and a carcass's roof is not
     the procedural one's — on all three cars it is 23–36 cm higher, which
     puts the tubes inside the bodywork. The whole rig moves, so `_muzzle`
     (a child) moves with it and Vehicle.muzzleWorld stays correct. */
  if (F.launcher && v._arsenalRig) {
    const p = v._arsenalRig.position, L = F.launcher;
    p.set(p.x + (L.dx || 0), p.y + (L.dy || 0), p.z + (L.dz || 0));
  }
  if (F.flame && v.exhaust) {
    v.exhaust.position.set(F.flame.x, F.flame.y, F.flame.z);
    if (v._flameRig) v._flameRig.position.copy(v.exhaust.position);
  }
}

/* ---------------- texture filtering ----------------
   Every sampled map on a carcass material, in the order three reads them.
   `aoMap` is here for completeness; these files do not ship one. */
const SAMPLED = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
/** Textures already given the treatment. */
const _sharpened = new WeakSet();

/**
 * Make a carcass's textures survive a grazing angle.
 *
 * A generated body is a 1–2 k albedo wrapped round a car that is looked at
 * almost edge-on from a chase camera at 30 m/s — the exact case where
 * trilinear alone crawls with aliasing and anisotropic sampling does not. 8×
 * is the knee: past it the cost keeps climbing and nothing on screen changes.
 *
 * Once per TEXTURE, not once per material. The template's textures are shared
 * by every instance of that file (two rivals on one machine) and often by
 * several materials inside one file, and each `needsUpdate` is a re-upload of
 * a couple of megabytes — so the WeakSet is what keeps this a load-time cost
 * instead of a per-car one.
 */
function sharpen(mat, aniso) {
  for (let i = 0; i < SAMPLED.length; i++) {
    const t = mat[SAMPLED[i]];
    if (!t || !t.image || t.isCompressedTexture || _sharpened.has(t)) continue;
    _sharpened.add(t);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    /* no renderer, no capability query, and no way to know what is safe — so
       the mips still happen and the anisotropy silently does not.
       The ceiling is the GPU's own number, not a constant. A carcass atlas is
       1024² stretched over a whole machine, so its texel density is the lowest
       of any surface in the game, and the body panels are read at exactly the
       grazing angles anisotropy exists for — from directly astern, most of the
       car is nearly edge-on to the eye. That is the case where 8 and 16 taps
       differ visibly, and it is the case the chase camera is in for the entire
       race. `aniso` is already the capability query's answer (16 on anything
       current, 1 where the extension is missing), so the old Math.min(8, …)
       was throwing away half the sharpness the hardware was offering. */
    if (aniso > 1) t.anisotropy = aniso;
    t.needsUpdate = true;
  }
}

/**
 * Drop every triangle whose centroid sits in a wheel zone. The survivors
 * are a NEW index over the SAME attributes — geometry.attributes are shared
 * with the template, so the megabytes are not copied — and the result is
 * cached per template geometry. `m` maps geometry space to body space.
 *
 * Normals are kept as exported: removing faces does not invalidate the
 * vertices that remain, and recomputing them across the UV seams of a
 * fused scan would facet every panel.
 */
function stripGeometry(geo, m, zones) {
  const hit = _stripped.get(geo);
  if (hit) return hit;
  const pos = geo.attributes.position;
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const triCount = (n / 3) | 0;
  const out = new Uint32Array(triCount * 3);
  const box = new THREE.Box3();
  let k = 0;
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    _pa.fromBufferAttribute(pos, a).applyMatrix4(m);
    _pb.fromBufferAttribute(pos, b).applyMatrix4(m);
    _pc.fromBufferAttribute(pos, c).applyMatrix4(m);
    _cen.copy(_pa).add(_pb).add(_pc).multiplyScalar(1 / 3);
    if (inWheelZone(zones, _cen.x, _cen.y, _cen.z)) continue;
    out[k++] = a; out[k++] = b; out[k++] = c;
    box.expandByPoint(_pa).expandByPoint(_pb).expandByPoint(_pc);
  }
  let geometry = geo;
  if (k < triCount * 3) {
    geometry = new THREE.BufferGeometry();
    for (const name in geo.attributes) geometry.setAttribute(name, geo.attributes[name]);
    const index = pos.count > 65535 ? out.slice(0, k) : new Uint16Array(out.subarray(0, k));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    /* Culling bounds stay the template's — the wheels are inside them, so
       they are merely conservative, and the template already paid for them. */
    geometry.boundingBox = geo.boundingBox;
    geometry.boundingSphere = geo.boundingSphere;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  }
  const rec = { geometry, tris: triCount, kept: k / 3, box };
  _stripped.set(geo, rec);
  return rec;
}

/**
 * Mud on a material, as a shader patch rather than a second texture set:
 * one varying, two uniforms, the same texture either way. It darkens the
 * panel, roughens it and — the part that actually sells it — kills the
 * clearcoat, because the difference between a clean car and a filthy one
 * is almost entirely the specular.
 *
 * `row` maps geometry-space position to body-space HEIGHT (a Vector4 dotted
 * with (position, 1)). The procedural panels are already in body space and
 * use the default; a carcass hands in the row of its fit matrix.
 *
 * The closure below has the same source for every material on purpose:
 * three keys its program cache on `onBeforeCompile.toString()`, so one
 * program serves every mudified panel and the uniforms do the varying.
 */
export function mudify(mat, uMud, row = MUD_ROW_BODY) {
  const uRow = { value: row };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMud = uMud;
    sh.uniforms.uMudRow = uRow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMudP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvMudP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uMud;\nuniform vec4 uMudRow;\nvarying vec3 vMudP;\n' +
        'float mudMask(){\n' +
        // body space: height above the centre of mass, so low = dirty
        '  float h = smoothstep(0.45, -0.35, dot(uMudRow, vec4(vMudP, 1.0)));\n' +
        '  float n = sin(vMudP.x * 13.0) * sin(vMudP.z * 9.0 + 1.7) * 0.5 + 0.5;\n' +
        '  return clamp(uMud * h * (0.40 + 0.80 * n), 0.0, 1.0);\n}')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n\tfloat _mud = mudMask();\n' +
        '\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.105, 0.078, 0.050), _mud);')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, 0.94, _mud);')
      .replace('#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n\t#ifdef USE_CLEARCOAT\n' +
        '\tmaterial.clearcoat = mix(material.clearcoat, 0.02, _mud);\n' +
        '\tmaterial.clearcoatRoughness = mix(material.clearcoatRoughness, 0.85, _mud);\n\t#endif');
  };
}

/* ============================================================
   launcher and rack
   ============================================================ */

/**
 * Mount the launcher at `spec.launcher`, build the rack, publish the muzzle.
 * Called from buildVehicleVisuals after the body — so before any carcass —
 * and drawn in both cases: the rig is a child of `chassis`, a sibling of the
 * carcass, and reads none of it.
 *
 * spec.launcher = { x, y, z, pitch, tubes }   (ARCHITECTURE §8.2), plus two
 * optional cosmetics this module owns: `base` metres of pedestal under the
 * plate (a deck mount), and `brace` for an off-centre mount, which draws
 * the bars back to the centreline and racks the ammo as a pannier on the
 * other side.
 */
export function buildArsenalRig(v, spec, M) {
  v._muzzle = null; v._rack = null; v._rackShown = -1; v._arsenalRig = null;
  const L = spec.launcher;
  if (!L) return;
  const P = kitPalette('training');
  const seed = seedOf(spec.id);
  const tubes = clamp(L.tubes | 0, 1, 4);
  const plateW = tubes * TUBE_PITCH + 0.10;

  const rig = new THREE.Group();
  rig.name = 'arsenal';
  rig.position.set(L.x, L.y, L.z);
  rig.rotation.x = -L.pitch;                 // tips +Z up by `pitch`
  v.chassis.add(rig);
  v._arsenalRig = rig;

  const lg = launcherGeo(P, seed, tubes);
  addPart(rig, lg, M.arsenal, v);
  if (L.base > 0) {
    const g = new THREE.BoxGeometry(plateW + 0.02, L.base, 0.36);
    g.translate(0, -L.base * 0.5, 0);
    addPart(rig, g, M.dark, v);
  }
  if (L.brace && L.x !== 0) {
    // two bars from under the plate, across the centreline, to the pannier
    const span = Math.abs(L.x) * 2 + RACK_PITCH;
    for (const z of [-0.10, 0.10]) {
      const g = new THREE.BoxGeometry(span, 0.035, 0.05);
      g.translate(-L.x, -0.02, z);
      addPart(rig, g, M.dark, v);
    }
  }

  /* The rack is sized at build, and the Vehicle's own ammoCap is still 0
     then — arsenal.js writes it at the grid — so the number comes from
     LAUNCHERS (§8.2), with the instance field and a default behind it. */
  const launcher = LAUNCHERS[spec.id];
  const cap = clamp((launcher && launcher.ammoCap) || v.ammoCap || RACK_DEFAULT, 1, RACK_MAX);
  const rg = rocketGeo(P, seed + 1);
  v.geos.push(rg);
  v._rack = [];
  for (let i = 0; i < cap; i++) {
    const m = new THREE.Mesh(rg, M.arsenal);
    m.castShadow = true; m.receiveShadow = true;
    m.scale.setScalar(RACK_SCALE);
    rackSlot(L, plateW, i, m.position);
    m.visible = false;
    rig.add(m);
    v._rack.push(m);
  }

  /* The muzzle (§8.2): an empty node at the mouth of the tubes. Its +Z is
     the rig's +Z, which the pitch already tipped, so Vehicle.muzzleWorld
     reads both position and forward off one matrixWorld. */
  const mz = new THREE.Object3D();
  mz.name = 'muzzle';
  mz.position.set(0, MUZZLE_Y, MUZZLE_Z);
  rig.add(mz);
  v._muzzle = mz;
}

function addPart(rig, geometry, material, v) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true; m.receiveShadow = true;
  rig.add(m);
  v.geos.push(geometry);
  return m;
}

/**
 * Body-space muzzle position and forward for a spec — pure, no vehicle
 * needed, ignoring the cosmetic body lean. The headless answer: a Vehicle
 * built with no scene has no `_muzzle`, and this is what it would have
 * said; the garage prints it, and the smoke check holds `_muzzle` to it.
 */
export function muzzleLocal(spec, outPos, outDir) {
  const L = spec.launcher;
  if (!L) { outPos.set(0, 0, spec.dims.L * 0.5); outDir.set(0, 0, 1); return outPos; }
  const cp = Math.cos(L.pitch), sp = Math.sin(L.pitch);
  outPos.set(L.x, L.y + MUZZLE_Y * cp + MUZZLE_Z * sp, L.z - MUZZLE_Y * sp + MUZZLE_Z * cp);
  outDir.set(0, sp, cp);
  return outPos;
}

/* Rack slots in rig space (on the plate, pitched with the tubes). A centred
   mount racks two columns a side, filling both sides before stacking a
   row; an off-centre mount racks a two-column pannier at its mirror point,
   so a bike carries its rounds on the far side from the tube. */
function rackSlot(L, plateW, i, out) {
  if (L.x !== 0) {
    const col = i & 1, row = i >> 1;
    out.set(-2 * L.x + (col - 0.5) * RACK_PITCH, 0.02 + row * RACK_PITCH, 0);
    return;
  }
  const side = (i & 1) ? -1 : 1, col = (i >> 1) & 1, row = i >> 2;
  out.set(side * (plateW * 0.5 + 0.07 + col * RACK_PITCH), row * RACK_PITCH, -0.02);
}

/**
 * Per frame, from updateVehicleVisuals: show `v.ammo` rounds on the rack.
 * Skipped entirely while the count is unchanged, which is every frame but
 * a pickup or a shot. Allocation-free.
 */
export function updateArsenalRig(v) {
  if (!v._rack) return;
  const n = v.ammo | 0;
  if (n !== v._rackShown) {
    v._rackShown = n;
    const R = v._rack;
    for (let i = 0; i < R.length; i++) R[i].visible = i < n;
  }
}

function seedOf(id) {
  let h = 0x2F0B;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h >>> 0) & 0xffff;
}

/* ============================================================
   scratch — module level; the load path runs once per car, the update path
   every frame, and neither allocates
   ============================================================ */
const MUD_ROW_BODY = new THREE.Vector4(0, 1, 0, 0);
const _white = new THREE.Color(1, 1, 1);
const _yUp = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _raw = { min: [0, 0, 0], max: [0, 0, 0] };
const _fitM = new THREE.Matrix4(), _m = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s3 = new THREE.Vector3(), _q = new THREE.Quaternion();
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3();
const _cen = new THREE.Vector3();

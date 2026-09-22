/* ============================================================
   RALLY ROAD RASH — vehicle art
   ------------------------------------------------------------
   Everything a Vehicle LOOKS like, and nothing it does. Extracted from
   vehicle.js so the solver and the model kit can be worked on separately:
   physics reads none of this, and this reads only published body state
   (pos/quat, per-wheel worldPos/steer/spin, the _accel* pair, contacts,
   the drift tier and the item drive multiplier).

   The Vehicle still OWNS the objects — root, chassis, wheelRoot, leanRoot,
   mats, tex, geos, exhaust, paintColor and the per-wheel obj/hub/arm/coil
   live on the instance, because the dev harnesses reach in and read them.
   These functions only build, drive and free them.

   Two hard constraints shape most of what follows:

     • `updateVehicleVisuals` runs once per car per frame, six cars deep.
       It allocates NOTHING — no vectors, no closures, no array literals.
     • Every mesh under `root` casts a shadow (dev/vehicle-check gates it,
       and a car whose wheels do not cast reads as hovering). The single
       exemption is `v.exhaust`. Additive transients therefore have to be
       something the shadow pass does not render at all, which is why the
       lamp/brake/flame glows are `THREE.Sprite` and not quads: three's
       shadow map only walks Mesh/Line/Points.

   Wave 8 split the file at the line ceiling. vehicle-livery.js is the 2D
   half; vehicle-carcass.js is the optional generated GLB body, the mud
   shader patch, and the launcher + ammo rack. This file still builds the
   procedural body first, every time — the carcass only ever HIDES it.

   Conventions match vehicle.js: metres, radians, Y up, local forward +Z.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, makeRNG } from '../core/rng.js';
import { G } from './config.js';
import { liveryTexture, LAYOUTS } from './vehicle-livery.js';
import { noiseCanvas } from '../world/textures.js';
import { vehicleWear, tireWear } from './vehicle-wear.js';
import { attachCarcass, detachCarcass, buildArsenalRig, updateArsenalRig, mudify }
  from './vehicle-carcass.js';
export { setCarcassSource, setCarcassRenderer } from './vehicle-carcass.js';

const RACE_NUMBERS = [7, 12, 23, 41, 68, 95, 3, 55];
/* Peak visual bank on a two-wheeler, radians. 0.62 = 35.5°, which is what a
   450 actually carries through a flat turn and about the point where the
   inside peg would start dragging. Higher looks like a road racer, which is
   the wrong sport. */
const BIKE_LEAN_MAX = 0.62;

/* Which of the five graphics a machine's WORKS car wears. AI variants walk
   the list from there (`+ livery`), so a grid never shows the same layout
   twice until it is more than five cars deep in one machine — and hue alone
   is never what tells two cars apart. */
const TEAM_LAYOUT = { hopper: 0, redline: 1, moto: 2, ridgeback: 3 };

/* Rim family per body style. A beadlock is a plate with a bolted ring, a
   truck wheel is six heavy spokes, and the wedge gets the turbine off a
   road car — three silhouettes you can name from the chase camera. */
const RIM_STYLE = { buggy: 'beadlock', truck: 'spoke6', wedge: 'turbine5', bike: 'wire' };
/* Half the rim width, as a fraction of spec.wheelW. The tyre's bead and the
   rim's flange are the same circle on the same plane — both builders read
   this so they cannot drift apart. */
const RIM_W = 0.40;

/* Base headlamp colour, over-bright by 1.6× so it clears the bloom
   threshold (engine.js: UnrealBloomPass at 1.15 over a HalfFloat target).
   Kept as linear components because updateVisuals rescales it every time
   the ghost flicker moves and must not allocate a Color to do it. */
const LAMP_R = 1.600, LAMP_G = 1.447, LAMP_B = 1.157;

/* Body panels that take mud. The cage, the rims and the glass do not: mud
   sticks to flat painted surfaces and slides off anything polished.
   The tyre is the exception, and it is the surface that puts the mud THERE:
   a knobbly does not shed it, it packs it between the lugs, and filthy sills
   over spotless rubber reads as the effect being wired to the wrong list.
   Note what the mask does on something that turns — see mudify(): its height
   ramp is in the MESH's own space, so the packed side spins with the wheel
   rather than staying under the car. Which is what packed mud does. */
const MUD_MATS = ['paint', 'paint2', 'livery', 'dark', 'tyre'];
/* Everything solid enough to need fading when a car is ghosted. Fading only
   the painted panels leaves a set of solid wheels floating inside a
   translucent body, which reads as a bug rather than as a respawn. */
const GHOST_MATS = ['paint', 'paint2', 'livery', 'dark', 'metal', 'rim',
  'tyre', 'spring', 'glass', 'visor', 'helmet', 'arsenal'];

/* ============================================================
   PUBLIC API — build / update / dispose / ghost / mud
   ============================================================ */

/**
 * Build every visual for `v` and park it under `scene`. Called once, from the
 * Vehicle constructor, and only when the car is not headless.
 * @param {object} v      the Vehicle (mutated: root, chassis, mats, geos, …)
 * @param {THREE.Scene} scene
 * @param {object} spec   one of VEHICLES
 */
export function buildVehicleVisuals(v, scene, spec) {
  v.root = new THREE.Group();
  v.root.name = 'vehicle-' + spec.id;
  scene.add(v.root);
  const rng = makeRNG(0x9a17 + v.livery * 7919 + spec.id.length);
  const hue = spec.liveryHues[v.livery % spec.liveryHues.length] || 0;
  /* Livery 0 is the works car and wears the team's own number off the spec;
     everything behind it on the grid is a privateer and draws from the pool. */
  const num = v.livery === 0 ? (spec.number | 0) || RACE_NUMBERS[0]
    : RACE_NUMBERS[v.livery % RACE_NUMBERS.length];

  const base = new THREE.Color(spec.color);
  base.getHSL(_hsl);
  const paint = new THREE.Color().setHSL((_hsl.h + hue) % 1, _hsl.s, _hsl.l);
  const paint2 = new THREE.Color().setHSL((_hsl.h + hue + 0.5) % 1,
    _hsl.s * 0.35, _hsl.l * 0.34);
  /* The third colour. paint2 is the body's own shadow — put a graphic in it
     and the graphic vanishes at 40 m, which is the range every one of these
     cars is actually looked at. `accent` is the complement pushed to full
     chroma and mid lightness: the one value on the panel that survives
     distance, dust and a low sun. */
  const accent = new THREE.Color().setHSL((_hsl.h + hue + 0.5) % 1,
    Math.min(1, _hsl.s * 1.1 + 0.30), 0.60);
  const helmet = new THREE.Color().setHSL((_hsl.h + hue) % 1,
    Math.min(1, _hsl.s * 0.55), 0.84);
  v.paintColor = paint.getHex();

  const layout = LAYOUTS[((TEAM_LAYOUT[spec.id] | 0) + v.livery) % LAYOUTS.length];
  v.tex = {
    livery: liveryTexture({
      paint, paint2, accent, number: num, layout, rng,
      team: spec.team || spec.name,
    }),
  };

  const M = buildMaterials(v, paint, paint2, helmet);

  v.chassis = new THREE.Group();
  v.wheelRoot = new THREE.Group();

  /* A bike leans, and it leans about the line where its tyres touch the
     ground — not about the centre of mass. Rolling the chassis in place
     would swing the contact patch 23 cm sideways at 35°, which reads as
     the bike skating rather than banking. So the two-wheelers get one
     extra group whose origin sits ON the ground plane; everything under it
     is pushed back up by the same amount, and a rotation there pivots the
     whole machine about the rubber. Four-wheelers keep the flat hierarchy. */
  v.leanRoot = null;
  if (spec.bodyStyle === 'bike') {
    v.leanRoot = new THREE.Group();
    v.leanRoot.position.y = -spec.comHeight;
    v.chassis.position.y = spec.comHeight;
    v.wheelRoot.position.y = spec.comHeight;
    v.leanRoot.add(v.chassis, v.wheelRoot);
    v.root.add(v.leanRoot);
  } else {
    v.root.add(v.chassis, v.wheelRoot);
  }

  const kit = new Kit();
  if (spec.bodyStyle === 'truck') buildTruck(kit, spec);
  else if (spec.bodyStyle === 'wedge') buildWedge(kit, spec);
  else if (spec.bodyStyle === 'bike') buildBike(kit, spec);
  else buildBuggy(kit, spec);
  v.geos = kit.flush(v.chassis, M);
  /* The merged panels, by reference: a carcass hides these and nothing
     else on the chassis (the flare, the lamps and the launcher stay). */
  v._bodyMeshes = v.chassis.children.slice();
  buildGlowRig(v, kit, M);
  buildArsenalRig(v, spec, M);

  buildRunningGear(v, spec, M);
  // Traverse the WHOLE root, not just the chassis — the wheels, arms and
  // brake discs live under wheelRoot and a car whose wheels cast no shadow
  // reads as hovering.
  v.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // additive transients must never enter the shadow pass
  if (v.exhaust) { v.exhaust.castShadow = false; v.exhaust.receiveShadow = false; }
  v.sync();
  // last, and asynchronous: the optional GLB. Nothing above waits for it.
  attachCarcass(v, spec, M);
}

/* ---------------- materials ----------------
   One set per vehicle, because every one of them carries either the car's
   own paint, its own livery canvas or its own mud uniform. `name` is set on
   all of them so dev/garage.js can print a triangle count per material
   without a lookup table that would go stale the first time one is added. */
function buildMaterials(v, paint, paint2, helmet) {
  const uMud = v._uMud = { value: 0 };
  const glow = glowTexture();
  const dirt = tireWear();
  const spriteMat = (color) => new THREE.SpriteMaterial({
    map: glow, color, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });

  const M = v.mats = {
    /* Physical, not Standard: a rally car is painted metal under lacquer,
       and the second specular lobe is the entire difference between "this
       is a colour" and "this is a panel". clearcoatRoughness stays low —
       the mud path below is what dulls it, on purpose and under control. */
    paint: new THREE.MeshPhysicalMaterial({
      color: paint, metalness: 0.35, roughness: 0.38,
      clearcoat: 0.90, clearcoatRoughness: 0.12, envMapIntensity: 1.10,
    }),
    paint2: new THREE.MeshPhysicalMaterial({
      color: paint2, metalness: 0.28, roughness: 0.52,
      clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 0.95,
    }),
    livery: new THREE.MeshPhysicalMaterial({
      map: v.tex.livery, color: 0xffffff, metalness: 0.18, roughness: 0.42,
      clearcoat: 0.85, clearcoatRoughness: 0.14, envMapIntensity: 1.05,
    }),
    dark: new THREE.MeshStandardMaterial({ ...vehicleWear(), color: 0x41433e, metalness: 0.35, roughness: 0.86 }),
    // the cage, the bullbar, the pipes: chrome, and it wants the sky in it
    metal: new THREE.MeshStandardMaterial({
      ...vehicleWear(), color: 0x92958d, metalness: 0.72, roughness: 0.68, envMapIntensity: 1.10,
    }),
    rim: new THREE.MeshStandardMaterial({
      color: 0x9aa4ad, vertexColors: true, metalness: 0.82, roughness: 0.40, envMapIntensity: 0.90,
    }),
    /* The one flat black on the car, and four of them per machine. Bare, it
       is a silhouette with no surface in it at any distance; `dirt` gives it
       a mottle and a matching roughness break-up so the light has something
       to catch. The albedo carries the rubber, so the colour goes white to
       let it through — and goes back to being the rubber itself if the
       texture could not be built, because white × nothing is a white tyre. */
    tyre: new THREE.MeshStandardMaterial({
      map: dirt.map, roughnessMap: dirt.roughnessMap,
      color: dirt.map ? 0xffffff : 0x121215, metalness: 0.02, roughness: 0.95,
    }),
    spring: new THREE.MeshStandardMaterial({
      ...vehicleWear(), color: 0x68685f, metalness: 0.55, roughness: 0.78,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x0b1015, metalness: 0.20, roughness: 0.10,
      clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.8,
    }),
    /* A mirrored visor, not a window. It is 20 cm of the model and it is the
       only part of a driver anybody ever looks at; leaving it the same dark
       glass as the screen makes the helmet read as empty. */
    visor: new THREE.MeshStandardMaterial({
      color: 0x2c2412, metalness: 1.0, roughness: 0.07, envMapIntensity: 2.40,
    }),
    helmet: new THREE.MeshStandardMaterial({ color: helmet, metalness: 0.10, roughness: 0.34 }),
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(LAMP_R, LAMP_G, LAMP_B) }),
    brake: new THREE.MeshBasicMaterial({ color: 0x3a0705 }),
    glow: new THREE.MeshBasicMaterial({
      color: 0xff8a3a, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    headGlow: spriteMat(0xffe9c0),
    brakeGlow: spriteMat(0xff2a10),
    flameGlow: spriteMat(0xff9a44),
    /* The launcher and its rounds come out of kit-arsenal.js already
       coloured per vertex, no uv, so they take the one vertex-colour
       material on the car. Deliberately no mud: it is the last thing bolted
       on and the first thing the eye has to read at 40 m. */
    arsenal: new THREE.MeshStandardMaterial({
      ...vehicleWear(), vertexColors: true, color:0x99988d, metalness: 0.55, roughness: 0.78, envMapIntensity: 1.00,
    }),
  };
  for (const k in M) M[k].name = k;
  for (const k of MUD_MATS) mudify(M[k], uMud);

  /* Pre-built so setGhostLook can run every frame without walking an object
     literal or filtering a list. `k` is the last value applied, which is how
     the (very common) not-ghosted case costs one comparison. */
  v._ghost = { k: 0, mats: GHOST_MATS.map(k => M[k]) };
  v._ghostFlicker = 1;
  v._lampK = -1;
  return M;
}

/* The mud shader patch itself (`mudify`) lives in vehicle-carcass.js now,
   because a carcass needs it too and with a different height mapping. */

/**
 * How filthy this car is, 0 = washed, 1 = a lap of TIMBERLINE. Cheap enough
 * to drive off surface time per frame if a caller ever wants to.
 */
export function setMudLook(v, k01) {
  if (v._uMud) v._uMud.value = clamp(k01, 0, 1);
}

/* ---------------- the additive rig ----------------
   `v.exhaust` is the pipe flare and the ONE mesh dev/vehicle-check excuses
   from the shadow pass. Everything else additive on the car — lamp bloom,
   brake bloom, the flame's own halo — hangs under it as `THREE.Sprite`,
   which the shadow map skips outright.

   The sprites are SIBLINGS of the flare, not children, in two groups both
   parked at the flare's home: the flare scales with boost and a parent's
   scale would drag its children's positions with it, and a carcass may
   move the flare to its own pipes (MODEL_FIT.flame) — the halo has to
   follow that and the lamp blooms must not. */
function buildGlowRig(v, kit, M) {
  const F = kit.flameSpec;
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(F.r, F.len, 8, 1, true).rotateX(-Math.PI / 2), M.glow);
  flame.position.set(F.x, F.y, F.z);
  flame.renderOrder = 6;
  v.chassis.add(flame);
  v.exhaust = flame;
  v.geos.push(flame.geometry);

  const rig = v._glowRig = new THREE.Group();        // the lamp blooms
  const flameRig = v._flameRig = new THREE.Group();  // the flare halo
  rig.position.set(F.x, F.y, F.z);
  flameRig.position.set(F.x, F.y, F.z);
  v.chassis.add(rig, flameRig);
  const spr = (parent, mat, x, y, z, size) => {
    const s = new THREE.Sprite(mat);
    s.position.set(x - F.x, y - F.y, z - F.z);
    s.scale.set(size, size, 1);
    s.renderOrder = 7;
    parent.add(s);
    return s;
  };
  /* Only the flare halo is kept by reference — it is the one sprite whose
     SIZE moves. Every lamp bloom is driven through its shared material, so
     twelve headlights on a truck cost one opacity write, not twelve. */
  v._sprFlame = spr(flameRig, M.flameGlow, F.x, F.y, F.z - F.len * 0.45, 0.3);
  for (const g of kit.glows) {
    spr(rig, g.kind === 'brake' ? M.brakeGlow : M.headGlow, g.x, g.y, g.z, g.size);
  }
}

/* ---------------- running gear, four-wheeler ---------------- */
function buildRunningGear(v, spec, M) {
  if (spec.bodyStyle === 'bike') return buildBikeGear(v, spec, M);
  const sxs = spec.bodyStyle === 'buggy';
  // An SxS wears its rubber big: the buggy's tyres run visually wider than
  // the contact-patch number the physics uses. Purely cosmetic.
  const visW = spec.wheelW * (sxs ? 1.16 : 1);
  const wheelGeo = buildWheelGeometry(spec.wheelR, visW);
  /* Rims are handed — the face is on the outboard side and the brake disc
     tucks in behind it — so there are two geometries, not one mirrored by a
     negative scale (which would invert every normal on the car's left). Two
     wheels share each. */
  const rimGeo = { '-1': null, 1: null }, calGeo = { '-1': null, 1: null };
  for (const s of [-1, 1]) {
    rimGeo[s] = buildRimGeometry(spec.wheelR, visW, RIM_STYLE[spec.bodyStyle], s);
    calGeo[s] = buildCaliperGeometry(spec.wheelR, visW, s);
  }
  const armGeo = roundedBox(sxs ? 0.075 : 0.11, sxs ? 0.075 : 0.09, 1, 0.028);
  const coilGeo = new THREE.CylinderGeometry(sxs ? 0.075 : 0.055, sxs ? 0.075 : 0.055, 1, 9);
  coilGeo.rotateX(Math.PI / 2);                        // make it a +Z member too
  const shaftGeo = sxs ? (() => { const g = new THREE.CylinderGeometry(0.026, 0.026, 1, 7); g.rotateX(Math.PI / 2); return g; })() : null;
  v.geos.push(wheelGeo, rimGeo[-1], rimGeo[1], calGeo[-1], calGeo[1], armGeo, coilGeo);
  if (shaftGeo) v.geos.push(shaftGeo);

  for (const w of v.wheels) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeo, M.tyre);
    g.add(tyre);
    g.add(new THREE.Mesh(rimGeo[w.side], M.rim));
    /* The caliper is bolted to the upright, not to the disc. `w.obj` carries
       both the steering angle and the wheel spin, so the caliper cancels the
       spin back out every frame and keeps the steering — one property write,
       and without it the car has a brake caliper orbiting its own wheel. */
    w.caliper = new THREE.Mesh(calGeo[w.side], M.paint);
    g.add(w.caliper);
    w.obj = g; w.hub = tyre;
    v.wheelRoot.add(g);

    /* Visible linkage. All members are unit-length +Z pieces re-spanned every
       frame between their chassis pickup and the live hub position, which is
       the only way the suspension reads as *travelling* rather than as wheels
       sliding around inside the arches. The buggy gets the full SxS set:
       upper + lower A-arm in body colour and a coilover with a visible
       spring; the others keep the single dark arm + strut. */
    const armMat = M.dark;
    w.arm = new THREE.Mesh(armGeo, armMat);
    w.coil = new THREE.Mesh(coilGeo, sxs ? M.spring : M.metal);
    v.wheelRoot.add(w.arm, w.coil);
    w.armRoot.set(w.side * spec.track * 0.20, w.mount.y - spec.suspRest * 0.90, w.mount.z);
    // Outboard upper pickup below the shell; the former tall diagonal cut
    // straight through the generated hood. Physics mounts remain untouched.
    w.coilRoot.set(w.side * spec.track * 0.43, w.mount.y - 0.08, w.mount.z - 0.06);
    if (sxs) {
      w.arm2 = new THREE.Mesh(armGeo, armMat);
      v.wheelRoot.add(w.arm2);
      w.arm2Root = new THREE.Vector3(w.side * spec.track * 0.22,
        w.mount.y - spec.suspRest * 0.52, w.mount.z + 0.10);
      w.shaft = new THREE.Mesh(shaftGeo, M.metal);
      v.wheelRoot.add(w.shaft);
    }
  }
}

/* ---------------- running gear, two-wheeler ----------------
   The solver has four corners; the machine has two wheels. The deal:

     • the two wheels of an axle share ONE tyre mesh, drawn on the
       centreline. `side === -1` owns it, `side === +1` renders nothing —
       its object still exists and still tracks, because updateVisuals is
       not allowed to care which corner it is looking at.
     • the linkage is where the second corner earns its keep. Both front
       corners span a fork leg, 8.5 cm either side of the centreline, so
       the fork is a real pair of tubes that really travel. Both rear
       corners span a swingarm rail; only the left one also spans the
       mono-shock, because a bike has exactly one of those.

   Net result: a wheel count of two, a fork that works, and no special
   case anywhere in the physics. ---------------------------------------- */
function buildBikeGear(v, spec, M) {
  const R = spec.wheelR;
  // Taller, narrower knobs than a car: this is an MX tyre, and the knobs
  // are most of what says so from the side.
  const wheelGeo = buildWheelGeometry(R, spec.wheelW, 13, 0.135);
  const rimGeo = { '-1': null, 1: null }, calGeo = { '-1': null, 1: null };
  for (const s of [-1, 1]) {
    rimGeo[s] = buildRimGeometry(R, spec.wheelW, 'wire', s);
    calGeo[s] = buildCaliperGeometry(R, spec.wheelW, s);
  }
  // Fork legs and swingarm rails are round tube; the shock wears a spring.
  const legGeo = new THREE.CylinderGeometry(0.030, 0.036, 1, 8); legGeo.rotateX(Math.PI / 2);
  const armGeo = new THREE.CylinderGeometry(0.034, 0.042, 1, 7); armGeo.rotateX(Math.PI / 2);
  const shockGeo = new THREE.CylinderGeometry(0.048, 0.048, 1, 9); shockGeo.rotateX(Math.PI / 2);
  v.geos.push(wheelGeo, rimGeo[-1], rimGeo[1], calGeo[-1], calGeo[1], legGeo, armGeo, shockGeo);

  const FORK_X = 0.085, ARM_X = 0.098;
  for (const w of v.wheels) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeo, M.tyre);
    g.add(tyre, new THREE.Mesh(rimGeo[w.side], M.rim));
    w.caliper = new THREE.Mesh(calGeo[w.side], M.paint);
    g.add(w.caliper);
    // One tyre per axle. The right-hand corner tracks silently.
    g.visible = w.side < 0;
    w.obj = g; w.hub = tyre;
    v.wheelRoot.add(g);

    /* Pickups are quoted as height above the ground and converted here, so
       they can be read against buildBike's frame without arithmetic: the
       fork tops sit just over the upper triple clamp at 1.19 m, the
       swingarm hangs off the pivot at 0.42 m, and the shock's top eye is on
       the frame behind the tank at 0.86 m. */
    const Y = (h) => h - spec.comHeight;
    w.hubOff = w.side * (w.front ? FORK_X : ARM_X);
    w.arm = new THREE.Mesh(w.front ? legGeo : armGeo, w.front ? M.metal : M.dark);
    v.wheelRoot.add(w.arm);
    if (w.front) w.armRoot.set(w.hubOff, Y(1.19), w.mount.z - 0.12);
    else w.armRoot.set(w.hubOff, Y(0.42), w.mount.z + 0.60);
    if (w.front || w.side > 0) {
      w.coil = null;                     // no shock on the forks, none on the right
      w.coilRoot.set(0, 0, 0);
    } else {
      w.coil = new THREE.Mesh(shockGeo, M.spring);
      v.wheelRoot.add(w.coil);
      w.coilRoot.set(0, Y(0.86), w.mount.z + 0.62);
    }
  }
}

/**
 * Wheels, suspension travel, steering, lamps, the pipe flare and the
 * visual-only body lean. Physics never reads any of this, and none of it
 * allocates: six cars × 60 Hz is the wrong place to make garbage.
 */
export function updateVehicleVisuals(v, dt) {
  if (!v.root) return;
  /* The respawn look, driven off the flag race.js already maintains. Wave 6
     says race.js will call setGhostLook itself with `v.ghost ? 1 : 0`; doing
     it here as well is not a second writer, because both sites compute the
     same number from the same flag and setGhostLook is idempotent. What it
     buys is that ghosting is LIVE with no edit to a file this package does
     not own — and a feature that needs someone else's line to do anything is
     a feature that ships broken. */
  setGhostLook(v, v.ghost ? 1 : 0);
  const S = v.spec;
  _q1.copy(v.quat).invert();

  const bike = S.bodyStyle === 'bike';
  for (const w of v.wheels) {
    _v1.copy(w.worldPos).sub(v.pos).applyQuaternion(_q1);
    // Single track: both corners of an axle draw on the centreline. The
    // physics hub keeps its real lateral offset; only the picture moves.
    if (bike) _v1.x = 0;
    w.obj.position.copy(_v1);
    w.obj.rotation.set(0, 0, 0);
    w.obj.rotateY(w.steer);
    w.obj.rotateX(w.spin);
    if (w.caliper) w.caliper.rotation.x = -w.spin;      // bolted to the upright
    if (w.hubOff) { _v2.copy(_v1); _v2.x += w.hubOff; span(w.arm, w.armRoot, _v2); }
    else span(w.arm, w.armRoot, _v1);
    if (w.coil) span(w.coil, w.coilRoot, _v1);
    if (w.arm2) { span(w.arm2, w.arm2Root, _v1); span(w.shaft, w.coilRoot, _v1); }
  }

  /* Body lean. Purely cosmetic and capped at 3°: the rigid body already
     rolls and pitches for real, v just exaggerates it enough to read from
     a chase camera without making the car look like it is about to tip. */
  const kf = Math.min(1, dt * 7);
  const tRoll = clamp(-v._accelLat / (G * 1.5), -1, 1) * 0.052;
  const tPitch = clamp(-v._accelLong / (G * 1.2), -1, 1) * 0.045;
  v._leanRoll += (tRoll - v._leanRoll) * kf;
  v._leanPitch += (tPitch - v._leanPitch) * kf;
  v.chassis.rotation.set(v._leanPitch, 0, v._leanRoll);

  /* A bike banks INTO the corner — the opposite sign to a car's body roll,
     and an order of magnitude bigger. This is the whole reason the machine
     reads as a motorcycle: the four-corner body underneath is held flat by
     antiRollBonus, and every degree of bank you see comes from here.
     Pivoted about the contact line by `leanRoot` (see build()), rate
     limited rather than snapped, so a flick through a chicane has weight.
     Airborne it decays to zero: nothing is generating lateral load, and a
     bike frozen at 30° of bank in mid-air looks broken. */
  if (v.leanRoot) {
    const grounded = v.contacts > 0 ? 1 : 0;
    const want = clamp(v._accelLat / (G * 0.90), -1, 1) * BIKE_LEAN_MAX * grounded;
    v._bikeLean += (want - v._bikeLean) * Math.min(1, dt * (grounded ? 6.0 : 2.4));
    v.leanRoot.rotation.z = v._bikeLean;
  }

  /* Ghosting dims every emissive on the car as well as fading the panels —
     a translucent body still wearing full-brightness headlamps looks like a
     rendering fault. `_ghostFlicker` is 1 whenever the car is solid, so this
     is a multiply by one in every frame of a normal race. */
  const flick = v._ghostFlicker;
  if (flick !== v._lampK) {
    v._lampK = flick;
    v.mats.lamp.color.setRGB(LAMP_R * flick, LAMP_G * flick, LAMP_B * flick);
  }
  v.mats.headGlow.opacity = 0.40 * flick;

  // brake lights: on under braking, and under reverse, like the real thing
  const lit = v._ctlBrake > 0.04 || v._ctlHand > 0 || v.speed < -0.6;
  const b = (lit ? 4.0 : 0.22) * flick;
  v.mats.brake.color.setRGB(b, b * 0.055, b * 0.04);
  v.mats.brakeGlow.opacity = lit ? 0.80 * flick : 0;

  /* Pipe flare. Two sources, and the boost one is the point: `fireTier / 3`
     is the mini-turbo burning, `(extDriveMul − 1) / 0.9` is a nitro from the
     item layer, and taking the max means one visual answers both without
     either system knowing the other exists. Everything below is a cosmetic
     transient, so Math.random is allowed (hard rule 6). */
  if (v.exhaust) {
    const heat = v.rpmNorm * Math.max(0, v._ctlThr);
    const boost = clamp(Math.max(v._drift.fireTier / 3, (v.extDriveMul - 1) / 0.9), 0, 1);
    const k = Math.max(heat > 0.35 ? (heat - 0.35) * 1.55 : 0, boost);
    const jit = 0.55 + Math.random() * 0.45;
    const wide = 0.72 + k * 0.60, long = 0.55 + k * (1.6 + jit * 0.7);
    v.exhaust.scale.set(wide, wide, long);
    v.exhaust.material.opacity = k * jit * flick;
    // orange at idle, blue-white at full boost — the same read as a rocket
    v.exhaust.material.color.setRGB(1 - 0.22 * boost, 0.54 + 0.30 * boost, 0.23 + 0.70 * boost);
    v.mats.flameGlow.color.setRGB(1 - 0.14 * boost, 0.56 + 0.28 * boost, 0.28 + 0.62 * boost);
    v.mats.flameGlow.opacity = k * (0.30 + jit * 0.45) * flick;
    const fs = 0.26 + k * 0.80;
    v._sprFlame.scale.set(fs, fs, 1);
    v._sprFlame.position.z = -(0.10 + k * 0.34);
  }

  // the muzzle for the weapons layer, and the rack for the eye
  updateArsenalRig(v);
}

export function disposeVehicleVisuals(v) {
  if (!v.root) return;
  /* The carcass first, and off the graph: its geometry is shared with every
     other instance of that file, and the traverse below would dispose it. */
  detachCarcass(v);
  const seenG = new Set(), seenM = new Set();
  v.root.traverse(o => {
    if (!o.isMesh) return;
    if (o.geometry && !seenG.has(o.geometry)) { seenG.add(o.geometry); o.geometry.dispose(); }
    const m = o.material;
    if (Array.isArray(m)) m.forEach(x => { if (!seenM.has(x)) { seenM.add(x); x.dispose(); } });
    else if (m && !seenM.has(m)) { seenM.add(m); m.dispose(); }
  });
  for (const g of v.geos || []) if (!seenG.has(g)) g.dispose();
  /* Sprites are not meshes, so the traverse above never reaches the three
     glow materials — and their shared quad geometry belongs to three, not to
     us, so it must NOT be disposed. Sweep the table instead of the graph. */
  for (const k in v.mats) {
    const m = v.mats[k];
    if (m && !seenM.has(m)) { seenM.add(m); m.dispose(); }
  }
  for (const k in v.tex) v.tex[k]?.dispose();
  v.root.parent?.remove(v.root);
  v.root = null; v.chassis = null; v.wheelRoot = null;
  v.exhaust = null; v._glowRig = null; v._flameRig = null; v._sprFlame = null;
  v._ghost = null; v._uMud = null; v._bodyMeshes = null;
  v._muzzle = null; v._rack = null; v._arsenalRig = null;
  for (const w of v.wheels) { w.obj = w.hub = w.arm = w.coil = w.caliper = null; }
}

/**
 * Ghost look for a car inside its post-respawn immunity: k01 0 = solid,
 * 1 = fully ghosted. Called EVERY frame, for every car, from
 * updateVehicleVisuals (and, per the wave-6 contract, from race.js as well),
 * so the solid case has to cost almost nothing — hence the early out and the
 * pre-built material list. Idempotent: calling it twice with the same k does
 * nothing the second time except re-roll the lamp flicker.
 *
 * `transparent` is a program parameter in three (it drives the OPAQUE
 * define), so flipping it recompiles. That happens twice per respawn, on the
 * edges only, and the second one is a program-cache hit.
 */
export function setGhostLook(v, k01) {
  const gh = v._ghost;
  if (!gh) return;
  const k = k01 > 1 ? 1 : k01 < 0 ? 0 : k01;
  if (k === 0 && gh.k === 0) return;                  // the whole-race case
  if ((k > 0) !== (gh.k > 0)) {
    const on = k > 0;
    for (let i = 0; i < gh.mats.length; i++) {
      gh.mats[i].transparent = on;
      gh.mats[i].needsUpdate = true;
    }
  }
  const o = 1 - 0.58 * k;                             // lerp(1, 0.42, k)
  for (let i = 0; i < gh.mats.length; i++) gh.mats[i].opacity = o;
  /* The lamps and the sprites are written by updateVehicleVisuals, which has
     exactly one writer per value and must keep it that way. So the flicker
     is published here as a scalar and applied there — one frame of latency
     on a value that is deliberately random anyway. */
  v._ghostFlicker = k > 0 ? 1 - k * (0.45 + Math.random() * 0.45) : 1;
  gh.k = k;
}

/* ============================================================
   procedural geometry helpers (build time only — allocation is fine here)
   ============================================================ */

/** Rounded box via SDF projection — soft edges catch a low sun properly. */
function roundedBox(sx, sy, sz, r, seg = 3) {
  r = Math.min(r, Math.min(sx, sy, sz) * 0.49);
  const g = new THREE.BoxGeometry(sx, sy, sz, seg, seg, seg);
  const p = g.attributes.position;
  const hx = sx / 2 - r, hy = sy / 2 - r, hz = sz / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const qx = clamp(vx, -hx, hx), qy = clamp(vy, -hy, hy), qz = clamp(vz, -hz, hz);
    let ox = vx - qx, oy = vy - qy, oz = vz - qz;
    const l = Math.hypot(ox, oy, oz);
    if (l > 1e-9) { const k = r / l; ox *= k; oy *= k; oz *= k; } else { ox = oy = oz = 0; }
    p.setXYZ(i, qx + ox, qy + oy, qz + oz);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * One moulded block: a tapered prism with NO bottom face, because the bottom
 * is buried in whatever it stands on and nothing ever sees it. Ten triangles
 * where a BoxGeometry is twelve — across 39 lugs a tyre, 24 wheels a grid,
 * that is most of a spare wheel's worth of budget.
 *
 * Grows along +Y from the origin. Indexed, with a zeroed normal attribute
 * and a dummy uv, because mergeGeometries refuses a mixed attribute set and
 * every caller recomputes normals after the merge anyway.
 */
function lugGeometry(sx, sy, sz, taper = 0.72) {
  const hx = sx * 0.5, hz = sz * 0.5, tx = hx * taper, tz = hz * taper;
  const b = [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]];
  const t = [[-tx, sy, -tz], [tx, sy, -tz], [tx, sy, tz], [-tx, sy, tz]];
  const pos = [], uv = [], idx = [];
  const quad = (p0, p1, p2, p3) => {
    const o = pos.length / 3;
    pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2],
      p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad(t[0], t[3], t[2], t[1]);                                  // crown
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    quad(b[j], b[i], t[i], t[j]);                                // flanks
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * The tyre's carcass, as ONE closed surface revolved from a section.
 *
 * It used to be three open-ended cylinders — a tread band and two cones —
 * with nothing at all closing the bead, so any grazing angle that got past
 * the rim looked straight through the rubber and out at the inside of the far
 * sidewall. DoubleSide would have hidden that; it would also have doubled the
 * shading cost of the biggest black surface on the car and made every lug's
 * (deliberately) missing bottom face visible from underneath. So the fix is
 * geometry, and the material stays FrontSide. dev/vehicle-check gates it: the
 * tube alone, every edge shared by exactly two triangles.
 *
 * The section, once round and back to where it started — radii as fractions
 * of R, half-widths as fractions of W:
 *
 *      crown  0.90  ├─────────────┤        the tread, under the lugs
 *   shoulder  0.886 ╱               ╲      ±0.60 W: the widest thing here
 *   sidewall  0.775 │               │
 *       bead  0.62  ╲_____________╱        ±0.40 W = RIM_W, the flange
 *        toe  0.60   ┌───────────┐         under the flange, so the rim
 * inner wall  0.80   └───────────┘         caps the hole down the axle
 *
 * Sixteen radial segments where the old shells used twenty-four: the lugs
 * carry the silhouette, and the tread's facets are underneath them.
 *
 * `RIM_W` is the same 0.40 the rim builder uses — move one and move both, or
 * the flange ends up outside the rubber.
 *
 * @param {number} R    rolling radius
 * @param {number} W    nominal tyre width (the section runs 1.2× that)
 * @param {number} seg  radial segments
 */
export function tyreTubeGeometry(R, W, seg = 16) {
  const TR = R * 0.90, BEAD = R * 0.62;
  const SH = W * 0.60, BW = W * RIM_W, CW = SH * 0.78;
  /* LatheGeometry revolves about +Y and derives its normals from the
     profile's own direction: y increasing gives an outward-facing skin, y
     decreasing an inward-facing one. So the list runs up the outside and back
     down the inside, and the loop CLOSES at the bead — the lathe does not
     weld its first point to its last, and the shading seam that leaves is one
     the rim's flange sits over. */
  const V = (x, y) => new THREE.Vector2(x, y);
  const P = [
    V(BEAD, -BW),                 // bead heel, side A
    V(R * 0.775, -SH * 0.985),    // sidewall A, bulging out toward full width
    V(TR * 0.985, -SH),           // shoulder A — the widest point on the wheel
    V(TR, -CW),                   // crown, side A
    V(TR, CW),                    // crown, side B
    V(TR * 0.985, SH),            // shoulder B
    V(R * 0.775, SH * 0.985),     // sidewall B
    V(BEAD, BW),                  // bead heel, side B
    V(R * 0.600, BW * 0.90),      // bead toe B — inside the rim barrel (0.615)
    V(R * 0.800, SH * 0.52),      // cavity wall B
    V(R * 0.800, -SH * 0.52),     // cavity roof, under the tread
    V(R * 0.600, -BW * 0.90),     // bead toe A
  ];
  P.push(P[0].clone());
  const g = new THREE.LatheGeometry(P, seg);
  // rotateZ(π/2) sends +Y to −X: the lathe's axis becomes the axle, the way
  // every other part of this wheel is built
  g.rotateZ(Math.PI / 2);
  return g;
}

/**
 * Knobbly off-road tyre. A closed lathe carcass and thirteen rows of blocky
 * lugs: a shoulder pair staggered either side of the crown plus one
 * centre-rib block half a row along.
 *
 * The old tyre wore 32 thin chevrons and 544 triangles and read as fuzz —
 * at speed the eye integrates anything finer than a few degrees of arc into
 * noise, and noise is what a black doughnut looks like. Thirteen big blocks
 * cost the same and actually hold a silhouette.
 *
 * Budget: 774 tris per wheel, 3096 for a set of four. That is up from
 * 534 / 2136, and all of the rise is the carcass — 384 for the closed tube
 * against 144 for the three open shells it replaces. It buys a tyre you
 * cannot see through, which the old one could not claim from any angle below
 * the axle line. dev/garage.js prints the measured set; dev/vehicle-check
 * holds the six-car grid to its ceiling.
 *
 * The sidewalls cone INBOARD as they drop to the bead, so the tread shoulder
 * is the widest thing on the wheel and the rim sits in a dish behind it.
 * Coning them the other way (which is what the old tyre did) puts the rim
 * permanently inside the rubber, which is why the rims never read.
 */
function buildWheelGeometry(R, W, rows = 13, lugH = 0.115) {
  const parts = [tyreTubeGeometry(R, W)];
  const TR = R * 0.90;                     // carcass radius, under the lugs

  const step = Math.PI * 2 / rows, LR = TR - R * 0.015;
  for (let i = 0; i < rows; i++) {
    const a = i * step;
    for (const sd of [-1, 1]) {
      // shoulder block, canted like a real directional knobbly and staggered
      // half a step against its partner so the two rows interlock
      const lug = lugGeometry(W * 0.48, R * lugH, R * 0.26, 0.68);
      lug.rotateY(sd * 0.34);
      lug.translate(sd * W * 0.30, LR, 0);
      lug.rotateX(a + sd * step * 0.22);
      parts.push(lug);
    }
    const rib = lugGeometry(W * 0.34, R * lugH * 0.86, R * 0.19, 0.64);
    rib.rotateY((i & 1) ? 0.20 : -0.20);
    rib.translate(0, LR, 0);
    rib.rotateX(a + step * 0.5);
    parts.push(rib);
  }

  const g = mergeGeometries(parts, false);
  parts.forEach(p => p.dispose());
  g.computeVertexNormals();
  return g;
}

/**
 * The wheel behind the rubber: barrel, back cap, hub, a brake disc you can
 * see turning through the spokes, and one of four faces.
 *
 * Handed — `side` is the outboard direction (+1 for the right-hand pair) —
 * because mirroring one geometry with a negative scale inverts every normal
 * down that side of the car. Two geometries, two wheels each.
 */
function buildRimGeometry(R, W, style, side) {
  const parts = [];
  const RR = R * 0.615;                    // flange, just over the tyre bead
  const face = side * W * 0.34;            // the spoke face, inside the dish
  const push = (g, hex = 0xffffff) => {
    const c=new THREE.Color(hex), colors=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<colors.length;i+=3){colors[i]=c.r;colors[i+1]=c.g;colors[i+2]=c.b;}
    g.setAttribute('color',new THREE.BufferAttribute(colors,3));parts.push(g);
  };

  // barrel runs a hair past the tyre bead at ±RIM_W so no grazing angle can
  // find a gap between rubber and rim
  const barrel = new THREE.CylinderGeometry(RR, RR, W * (RIM_W * 2 + 0.05), 20, 1, true);
  barrel.rotateZ(Math.PI / 2); push(barrel, 0x747b82);
  /* Back of the dish, both ways. Every surface on a merged geometry is
     single-sided, so ONE disc here closes the wheel from outboard and leaves
     a hole through it from inboard. Two discs, 24 triangles, and the wheel is
     opaque from every angle a rolled car can be looked at. */
  for (const s of [-1, 1]) {
    const back = new THREE.CircleGeometry(RR, 12);
    back.rotateY(s * Math.PI / 2);
    back.translate(-side * W * (RIM_W + 0.02) + s * 0.002, 0, 0);
    push(back, 0x272b31);
  }
  // brake disc: inboard of the face so it reads as being BEHIND the spokes
  const disc = new THREE.CylinderGeometry(R * 0.50, R * 0.50, W * 0.08, 14);
  disc.rotateZ(Math.PI / 2); disc.translate(-side * W * 0.12, 0, 0); push(disc, 0x62676b);
  const hub = new THREE.CylinderGeometry(R * 0.17, R * 0.17, W * 0.76, 10);
  hub.rotateZ(Math.PI / 2); push(hub);

  /** A radial member lying in the face plane: thickness across the axle,
      width around the wheel, growing outward from `r0`. */
  const spoke = (thick, len, wide, r0, a, twist, taper) => {
    const g = lugGeometry(thick, len, wide, taper);
    if (twist) g.rotateY(twist);
    g.translate(face, r0, 0);
    g.rotateX(a);
    push(g);
  };
  /** A stud standing proud of the face, growing outboard. */
  const stud = (d, h, r0, a) => {
    const g = lugGeometry(d, h, d, 0.75);
    g.rotateZ(-side * Math.PI / 2);        // +Y → outboard
    g.translate(face + side * W * 0.02, Math.cos(a) * r0, Math.sin(a) * r0);
    push(g);
  };
  const ring = (ri, ro, dx) => {
    const g = new THREE.RingGeometry(ri, ro, 20, 1);
    g.rotateY(side * Math.PI / 2); g.translate(face + side * dx, 0, 0); push(g);
  };
  const cap = (r, dx) => {
    const g = new THREE.CircleGeometry(r, style === 'beadlock' ? 20 : 12);
    g.rotateY(side * Math.PI / 2); g.translate(face + side * dx, 0, 0); push(g);
  };

  if (style === 'beadlock') {
    // Open beadlock face: dark brake hardware behind eight machined spokes.
    cap(R * 0.23, 0.010);
    for (let i = 0; i < 8; i++) spoke(W*0.13, RR*0.64, R*0.11, R*0.13, i*Math.PI/4, 0, 0.65);
    ring(RR * 0.74, RR * 0.96, 0.022);
    for (let i = 0; i < 8; i++) stud(R * 0.055, W * 0.055, RR * 0.85, i / 8 * Math.PI * 2);
  } else if (style === 'spoke6') {
    ring(RR * 0.70, RR, 0.010);
    for (let i = 0; i < 6; i++) spoke(W * 0.13, RR * 0.60, R * 0.155, R * 0.15, i / 6 * Math.PI * 2, 0, 0.52);
    cap(R * 0.26, 0.020);
  } else if (style === 'turbine5') {
    ring(RR * 0.78, RR, 0.010);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      spoke(W * 0.10, RR * 0.56, R * 0.185, R * 0.16, a, 0.42, 0.60);       // blade
      spoke(W * 0.07, RR * 0.34, R * 0.095, R * 0.30, a + 0.63, 0.62, 0.70); // vane
    }
    cap(R * 0.24, 0.020);
  } else {                                  // 'wire' — the motocross wheel
    ring(RR * 0.88, RR, 0.006);
    for (let i = 0; i < 10; i++) spoke(W * 0.10, RR * 0.66, R * 0.045, R * 0.17, i / 10 * Math.PI * 2, 0, 0.85);
    cap(R * 0.22, 0.016);
  }

  const g = mergeGeometries(parts, false);
  parts.forEach(p => p.dispose());
  g.computeVertexNormals();
  return g;
}

/** Brake caliper: a body and a bridge straddling the disc, 20 triangles. */
function buildCaliperGeometry(R, W, side) {
  const x = -side * W * 0.12;               // over the disc, not over the rim
  const body = lugGeometry(W * 0.17, R * 0.15, R * 0.21, 0.82);
  body.translate(x, R * 0.40, 0);
  const bridge = lugGeometry(W * 0.26, R * 0.05, R * 0.12, 0.90);
  bridge.translate(x, R * 0.36, 0);
  const g = mergeGeometries([body, bridge], false);
  body.dispose(); bridge.dispose();
  g.computeVertexNormals();
  return g;
}

/* One shared coil-spring stripe texture for every coilover in the game. Never
   disposed with a vehicle — it is module state, not instance state. */
let _springTex = null;
function springTexture() {
  if (_springTex) return _springTex;
  const c = document.createElement('canvas'); c.width = 16; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#20242c'; g.fillRect(0, 0, 16, 64);
  g.fillStyle = '#e0e4ea';
  for (let i = 0; i < 4; i++) g.fillRect(0, i * 16, 16, 9);   // coils
  _springTex = new THREE.CanvasTexture(c);
  _springTex.wrapS = _springTex.wrapT = THREE.RepeatWrapping;
  _springTex.repeat.set(1, 5);
  _springTex.colorSpace = THREE.NoColorSpace;
  return _springTex;
}

/* One shared radial falloff for every additive sprite on every car. Module
   state like the spring stripe, so disposeVehicleVisuals must not touch it. */
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,244,220,0.72)');
  grd.addColorStop(0.55, 'rgba(255,210,150,0.20)');
  grd.addColorStop(1.00, 'rgba(255,180,110,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

/* How many times the dirt tile wraps: three times round the circumference,
   once across the section. */
const TYRE_UV = [3, 1];

/* One shared dirt set for every tyre in the game — a mottled rubber albedo
   and the roughness break-up that goes with it. Module state like the spring
   stripe and the glow, so disposeVehicleVisuals must not touch it.

   Authored against the LATHE's uvs, which run u once around the circumference
   and v once across the section. The lugs share this material and carry the
   dummy (0,0)–(1,1) quad uv lugGeometry gives everything, so a lug face shows
   the whole tile at 5 cm and mips down to its mean — which is why the field
   is isotropic mottle and not a crown-to-sidewall gradient. A gradient would
   be right on the tube and meaningless on thirty-nine blocks a wheel.

   Everything here is guarded: no canvas, or a canvas that will not give its
   pixels back, leaves both maps null and the tyre exactly the flat black it
   was. Same terms as every other image in the game. */
let _tyreTex = null;
function tyreTextures() {
  if (_tyreTex) return _tyreTex;
  _tyreTex = { map: null, rough: null };
  try { buildTyreTextures(_tyreTex, 128); }
  catch (err) { void err; }
  return _tyreTex;
}

function buildTyreTextures(out, N) {
  /* Two tiling fields. `blot` is where dust cakes — big and clumpy; `grit` is
     the fine break-up over it. Both must wrap: the tread repeats three times
     a revolution and a seam would come round three times a wheel. */
  const blot = greyOf(noiseCanvas(N, { tile: true, scale: 3.5, octaves: 4, seed: 61, contrast: 1.45 }), N);
  const grit = greyOf(noiseCanvas(N, { tile: true, scale: 13, octaves: 2, seed: 137 }), N);
  const cm = tyreCanvas(N), cr = tyreCanvas(N);
  const gm = cm.getContext('2d'), gr = cr.getContext('2d');
  const im = gm.createImageData(N, N), ir = gr.createImageData(N, N);
  const dm = im.data, dr = ir.data;
  const RUB = [0x14, 0x15, 0x19], DUST = [0x8c, 0x76, 0x57];
  for (let i = 0; i < N * N; i++) {
    const b = blot[i], f = grit[i];
    /* Dust only where both fields agree, then squared. A straight lerp lays a
       grey film over the whole tyre and turns it into a grey tyre; this puts
       pale caked patches in clumps and leaves the rest black. */
    let k = clamp((b * 0.78 + f * 0.42 - 0.46) * 2.1, 0, 1);
    k *= k;
    const shade = 0.80 + 0.38 * f;            // grain in the rubber itself
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const rub = RUB[c] * shade;
      dm[o + c] = clamp(rub + (DUST[c] - rub) * k, 0, 255);
    }
    dm[o + 3] = 255;
    /* Correlated with the albedo on purpose: three multiplies `roughness` by
       this map's GREEN channel, so caked dust comes out rougher than the
       rubber under it and the two maps can never disagree about where the
       dirt is. Band kept narrow — rubber is already 0.95. */
    const g8 = clamp((0.92 + 0.08 * k - 0.05 * (1 - f)) * 255, 0, 255);
    dr[o] = g8; dr[o + 1] = g8; dr[o + 2] = g8; dr[o + 3] = 255;
  }
  gm.putImageData(im, 0, 0);
  gr.putImageData(ir, 0, 0);
  out.map = tyreTexOf(cm, THREE.SRGBColorSpace);
  out.rough = tyreTexOf(cr, THREE.NoColorSpace);
}

function tyreCanvas(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return c;
}
/** noiseCanvas writes its value into all three channels; one is enough. */
function greyOf(canvas, n) {
  const d = canvas.getContext('2d').getImageData(0, 0, n, n).data;
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * (1 / 255);
  return out;
}
function tyreTexOf(c, space) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = space;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(TYRE_UV[0], TYRE_UV[1]);
  // three clamps this to the device maximum at upload, so 4 is safe with no
  // renderer to ask — and a tyre is only ever seen at a grazing angle
  t.anisotropy = 4;
  return t;
}

/** Collects build-time geometry into one merged mesh per material. */
class Kit {
  constructor() {
    this.b = new Map();
    /* Two side channels the body builders write and buildGlowRig reads, so
       a machine declares where its lamps and its pipe are in the same call
       that draws them instead of the caller guessing. */
    this.glows = [];
    this.flameSpec = { x: 0, y: 0, z: 0, r: 0.08, len: 0.34 };
  }
  add(mat, g) { let a = this.b.get(mat); if (!a) this.b.set(mat, a = []); a.push(g); }

  box(mat, sx, sy, sz, x, y, z, r = 0.04, rx = 0, ry = 0, rz = 0) {
    const g = roundedBox(sx, sy, sz, r);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  /** Hard-edged 12-triangle box. `box` subdivides 3× for its rounding, which
      is 108 triangles — right for a bonnet, absurd for a mirror stalk. */
  blk(mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  plate(mat, sx, sy, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.PlaneGeometry(sx, sy);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  cyl(mat, rt, rb, h, seg, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  torus(mat, r, tube, rseg, tseg, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.TorusGeometry(r, tube, rseg, tseg);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  sphere(mat, r, x, y, z, seg = 12) {
    const g = new THREE.SphereGeometry(r, seg, seg * 0.7 | 0);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  /** Cage tube between two body-space points. Ten sides, not eight: this is
      the chrome, and a chrome octagon shows its facets in every reflection. */
  tube(mat, ax, ay, az, bx, by, bz, r) {
    const lx = bx - ax, ly = by - ay, lz = bz - az;
    const len = Math.hypot(lx, ly, lz);
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, 10);
    _kq.setFromUnitVectors(_kY, _kv.set(lx / len, ly / len, lz / len));
    _km.makeRotationFromQuaternion(_kq);
    _km.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    g.applyMatrix4(_km);
    this.add(mat, g);
  }

  /** Register an additive bloom at a lamp. kind: 'head' | 'brake'. */
  glow(kind, x, y, z, size) { this.glows.push({ kind, x, y, z, size }); }
  /** Where this machine's pipe flare lives, and how big it is. */
  flame(x, y, z, r, len) { this.flameSpec = { x, y, z, r, len }; }

  flush(group, mats) {
    const out = [];
    for (const [key, arr] of this.b) {
      const g = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
      if (arr.length > 1) arr.forEach(x => x.dispose());
      if (!g) continue;
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mats[key]);
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
      out.push(g);
    }
    this.b.clear();
    return out;
  }
}

/* --- shared furniture every car gets ------------------------------------ */
function addLights(kit, y, zF, zR, spread) {
  // Headlights are faintly lit at all times — a dark grille with two bright
  // discs is the cheapest way to give a low-poly car a face at 40 m. The tail
  // boxes share one material so updateVisuals can light them all at once, and
  // each lamp registers an additive bloom that sits in front of it.
  for (const s of [-1, 1]) {
    kit.cyl('lamp', 0.10, 0.10, 0.05, 14, s * spread, y, zF, Math.PI / 2);
    kit.cyl('dark', 0.125, 0.125, 0.07, 14, s * spread, y, zF - 0.035, Math.PI / 2);
    kit.blk('brake', 0.30, 0.11, 0.06, s * spread * 0.92, y, zR);
    kit.glow('head', s * spread, y, zF + 0.05, 0.62);
    kit.glow('brake', s * spread * 0.92, y, zR - 0.05, 0.44);
  }
}

/* The driver. Half the read on an open car and most of the read on the bike:
   a helmet alone is a bowling ball on a seat, and what makes it a person is
   the pair of arms going somewhere. They go to the wheel rim, which is why
   the wheel is a torus and not a disc. */
function addDriver(kit, spec, y, z, lean = 0.22, x = 0) {
  const w = spec.dims.W;
  kit.box('dark', w * 0.34, 0.42, 0.16, x, y + 0.06, z - 0.34, 0.05, -lean);   // seat back
  kit.box('dark', w * 0.34, 0.10, 0.44, x, y - 0.15, z - 0.10, 0.04);          // seat base
  kit.blk('dark', w * 0.36, 0.06, 0.10, x, y + 0.24, z - 0.33, -lean);         // headrest
  // torso in the team suit, shoulders squared to the wheel
  kit.box('paint2', 0.36, 0.34, 0.24, x, y + 0.01, z - 0.20, 0.08, -lean * 0.5);
  kit.sphere('helmet', 0.145, x, y + 0.20, z - 0.20);
  kit.blk('helmet', 0.20, 0.05, 0.13, x, y + 0.265, z - 0.115, -0.34);         // peak
  /* Proud of the shell, not flush with it. A 12-segment sphere's front facet
     lands at z − 0.06 here, and a visor plate placed ON that number z-fights
     with it and disappears — which is what the old one did. */
  kit.plate('visor', 0.21, 0.115, x, y + 0.198, z - 0.045);

  /* The wheel is a rim, because the arms have to arrive somewhere. Its axis
     points up and back at the driver: TorusGeometry rings the +Z axis, and
     rotateX(−0.42) tips that to (0, 0.41, 0.91). */
  const wy = y + 0.055, wz = z + 0.255;
  kit.torus('dark', 0.112, 0.017, 4, 10, x, wy, wz, -0.42);
  kit.blk('dark', 0.21, 0.022, 0.030, x, wy, wz, -0.42);                       // cross spoke
  kit.blk('dark', 0.060, 0.048, 0.032, x, wy, wz, -0.42);                      // boss
  for (const s of [-1, 1]) {
    kit.tube('paint2', x + s * 0.155, y + 0.11, z - 0.19, x + s * 0.150, y + 0.06, z + 0.06, 0.046);
    kit.tube('paint2', x + s * 0.150, y + 0.06, z + 0.06, x + s * 0.100, wy + 0.02, wz - 0.02, 0.036);
    kit.blk('dark', 0.075, 0.065, 0.085, x + s * 0.098, wy + 0.02, wz - 0.005);  // glove
  }
}

/* --- BUGGY: modern sport side-by-side — low panelled hull, raked cage with
   a roof, angular LED brows, tube bumper, and its suspension worn on the
   outside. Modelled on the Can-Am Maverick X3 silhouette. ------------------ */
function buildBuggy(kit, spec) {
  const { L, W, H } = spec.dims;
  const y0 = -spec.comHeight;                 // ground plane in body space
  const hw = W * 0.5;
  const top = y0 + H;

  /* ---- hull. The body core is much narrower than the track — an SxS wears
     its wheels a full arm's length outboard, and that gap IS the look. ---- */
  const bw = W * 0.62;                        // body core width
  kit.box('dark', bw, 0.10, L * 0.66, 0, y0 + 0.30, 0.02, 0.03);               // belly pan
  kit.box('paint', bw * 0.98, 0.34, 1.55, 0, y0 + 0.52, 0.02, 0.10);           // lower hull
  // sloped bonnet, dropping toward the nose, with a centre vent
  kit.box('paint', bw * 0.84, 0.11, 1.10, 0, y0 + 0.735, L * 0.265, 0.05, 0.135);
  kit.blk('dark', bw * 0.30, 0.055, 0.62, 0, y0 + 0.80, L * 0.245, 0.135);     // hood vent
  // front fascia: black grille panel under angry LED brows
  kit.box('dark', bw * 0.86, 0.30, 0.16, 0, y0 + 0.545, L * 0.455, 0.04);
  for (const s of [-1, 1]) {
    // LED brows — thin lit slashes, angled down-inward like the reference
    kit.blk('lamp', 0.30, 0.035, 0.03, s * bw * 0.28, y0 + 0.665, L * 0.468, 0, 0, s * -0.22);
    kit.blk('dark', 0.34, 0.075, 0.05, s * bw * 0.28, y0 + 0.665, L * 0.452, 0, 0, s * -0.22);
  }

  /* ---- front tube bumper: twin rails wrapping the nose ---- */
  const bz = L * 0.50, by = y0 + 0.40, br = 0.038, bwid = bw * 0.55;
  kit.tube('metal', -bwid, by, bz, bwid, by, bz, br);
  kit.tube('metal', -bwid * 0.82, by + 0.24, bz - 0.03, bwid * 0.82, by + 0.24, bz - 0.03, br);
  for (const s of [-1, 1]) {
    kit.tube('metal', s * bwid, by, bz, s * bwid * 0.82, by + 0.24, bz - 0.03, br);
    kit.tube('metal', s * bwid, by, bz, s * bw * 0.52, by + 0.02, L * 0.36, br);      // wrap-back
    kit.tube('metal', s * bwid * 0.5, by, bz, s * bwid * 0.42, by + 0.24, bz - 0.03, 0.030);
  }

  /* ---- doors and flanks ---- */
  for (const s of [-1, 1]) {
    // half-door panel carrying the livery (number, graphics)
    kit.plate('livery', 1.34, 0.44, s * (bw * 0.5 + 0.005), y0 + 0.60, -0.10, 0, s * Math.PI / 2);
    kit.box('dark', 0.07, 0.50, 1.40, s * bw * 0.515, y0 + 0.575, -0.10, 0.045);
    // fender flares over both arches, wider than the hull
    kit.box('dark', 0.30, 0.075, 1.02, s * hw * 0.74, y0 + 0.82, spec.wheelbase.front, 0.03);
    kit.box('dark', 0.32, 0.075, 1.10, s * hw * 0.76, y0 + 0.84, spec.wheelbase.rear, 0.03);
    // rock slider under the door
    kit.box('dark', 0.17, 0.09, 1.30, s * bw * 0.56, y0 + 0.20, -0.06, 0.03);
  }

  /* ---- cockpit: side-by-side, driver offset left ---- */
  kit.box('dark', bw * 0.92, 0.30, 1.10, 0, y0 + 0.66, -0.18, 0.05);            // tub
  addDriver(kit, spec, y0 + 0.80, -0.12, 0.22, -0.26);
  // empty co-driver seat
  kit.box('dark', W * 0.20, 0.42, 0.16, 0.26, y0 + 0.86, -0.46, 0.05, -0.22);
  kit.box('dark', W * 0.20, 0.10, 0.44, 0.26, y0 + 0.65, -0.22, 0.04);
  kit.plate('glass', bw * 0.82, 0.26, 0, y0 + 1.00, 0.42, -0.62);               // low screen

  /* ---- cage: raked pillars, flat roof, kicked-up rear hoop ---- */
  const cw = bw * 0.52, r = 0.048;
  const roofY = top + 0.02, roofF = 0.14, roofR = -0.86;
  for (const s of [-1, 1]) {
    kit.tube('metal', s * bw * 0.5, y0 + 0.70, 0.66, s * cw, roofY, roofF, r);  // raked A-pillar
    kit.tube('metal', s * cw, y0 + 0.44, roofR, s * cw, roofY, roofR, r);       // main hoop leg
    kit.tube('metal', s * cw, roofY, roofF, s * cw, roofY, roofR, r);           // roof rail
    kit.tube('metal', s * cw, roofY, roofR, s * bw * 0.42, y0 + 0.62, -L * 0.44, r); // rear stay
    kit.tube('metal', s * cw, y0 + 0.44, roofR, -s * cw, roofY, roofR, r * 0.75);    // X brace
    kit.tube('metal', s * bw * 0.5, y0 + 0.70, 0.66, s * cw, y0 + 0.98, -0.20, r * 0.7); // intrusion
    // side mirror on the A-pillar
    kit.blk('dark', 0.05, 0.09, 0.14, s * (bw * 0.5 + 0.09), y0 + 1.05, 0.52);
  }
  kit.tube('metal', -cw, roofY, roofF, cw, roofY, roofF, r);
  kit.tube('metal', -cw, roofY, roofR, cw, roofY, roofR, r);
  kit.box('dark', cw * 2.06, 0.045, roofF - roofR, 0, roofY + 0.045, (roofF + roofR) / 2, 0.02); // roof panel

  /* ---- rear: exposed engine, twin exhausts, no wing (the cage is the wing) */
  kit.box('dark', bw * 0.72, 0.30, 0.66, 0, y0 + 0.50, -L * 0.335, 0.05);       // engine block
  kit.box('metal', bw * 0.34, 0.14, 0.34, 0, y0 + 0.70, -L * 0.32, 0.04);       // cam cover
  kit.box('dark', bw * 0.42, 0.16, 0.28, 0, y0 + 0.84, -L * 0.33, 0.05);        // airbox
  kit.box('dark', bw * 0.95, 0.24, 0.30, 0, y0 + 0.42, -L * 0.455, 0.06);     // rear valance
  for (const s of [-1, 1]) {
    kit.cyl('metal', 0.055, 0.062, 0.22, 10, s * bw * 0.24, y0 + 0.60, -L * 0.475, Math.PI / 2);
    kit.tube('metal', s * bw * 0.45, y0 + 0.40, -L * 0.50, s * bw * 0.45, y0 + 0.72, -L * 0.44, 0.034);
  }
  kit.flame(0, y0 + 0.60, -L * 0.50 - 0.20, 0.10, 0.40);

  addLights(kit, y0 + 0.60, L * 0.472, -L * 0.49, bw * 0.40);
  // cage light pod — pure rally
  for (let i = 0; i < 4; i++) {
    kit.cyl('lamp', 0.070, 0.070, 0.04, 12, (i - 1.5) * 0.19, roofY + 0.10, roofF + 0.05, Math.PI / 2);
    kit.cyl('dark', 0.085, 0.085, 0.07, 12, (i - 1.5) * 0.19, roofY + 0.10, roofF + 0.01, Math.PI / 2);
  }
  kit.glow('head', 0, roofY + 0.10, roofF + 0.10, 1.05);
}

/* --- TRUCK: cab, bed, bullbar, chunky ----------------------------------- */
function buildTruck(kit, spec) {
  const { L, W } = spec.dims;
  const y0 = -spec.comHeight, hw = W * 0.5;

  kit.box('dark', W * 0.66, 0.16, L * 0.80, 0, y0 + 0.34, 0, 0.04);             // ladder frame
  for (const s of [-1, 1]) kit.box('metal', 0.10, 0.20, L * 0.78, s * W * 0.30, y0 + 0.34, 0, 0.03);

  // cab
  const cabY = y0 + 0.62, cabH = 0.92;
  kit.box('paint', W * 0.90, cabH, 1.72, 0, cabY + cabH / 2, 0.42, 0.12);
  kit.box('paint2', W * 0.92, 0.16, 1.78, 0, cabY + cabH + 0.02, 0.42, 0.06);   // roof cap
  kit.plate('glass', W * 0.72, 0.62, 0, cabY + cabH * 0.66, 1.30, -0.30);        // windscreen
  for (const s of [-1, 1]) {
    kit.plate('glass', 1.00, 0.50, s * (W * 0.452), cabY + cabH * 0.64, 0.34, 0, s * Math.PI / 2);
    kit.plate('livery', 1.10, 0.42, s * (W * 0.452), cabY + cabH * 0.16, 0.30, 0, s * Math.PI / 2);
    kit.blk('dark', 0.10, 0.16, 0.26, s * hw * 0.98, cabY + cabH * 0.70, 1.02);  // mirror
  }
  addDriver(kit, spec, cabY + 0.44, 0.52, 0.30);

  // bed with real walls, plus a spare strapped in
  const bz = -L * 0.30, bw = W * 0.88;
  kit.box('paint', bw, 0.42, 1.74, 0, y0 + 0.62, bz, 0.06);
  for (const s of [-1, 1]) kit.box('paint2', 0.10, 0.44, 1.74, s * bw * 0.5, y0 + 0.98, bz, 0.03);
  kit.box('paint2', bw, 0.44, 0.10, 0, y0 + 0.98, bz - 0.87, 0.03);
  kit.cyl('tyre', spec.wheelR * 0.86, spec.wheelR * 0.86, spec.wheelW * 0.9, 16,
    0, y0 + 0.95, bz + 0.30, 0, 0, 0);

  // bullbar: the reason nobody wants to be in front of this thing
  const bz2 = L * 0.48, by = y0 + 0.52;
  kit.tube('metal', -hw * 0.86, by, bz2, hw * 0.86, by, bz2, 0.055);
  kit.tube('metal', -hw * 0.86, by + 0.42, bz2, hw * 0.86, by + 0.42, bz2, 0.055);
  for (let i = -2; i <= 2; i++) kit.tube('metal', i * hw * 0.36, by - 0.06, bz2, i * hw * 0.36, by + 0.44, bz2, 0.038);
  for (const s of [-1, 1]) {
    kit.tube('metal', s * hw * 0.86, by, bz2, s * hw * 0.70, y0 + 0.40, L * 0.30, 0.048);
    kit.tube('metal', s * hw * 0.86, by + 0.42, bz2, s * hw * 0.74, y0 + 0.86, L * 0.24, 0.040);
    kit.box('paint2', 0.24, 0.44, 1.10, s * hw * 0.94, y0 + 0.66, 1.10, 0.06);   // fender flare
    kit.box('paint2', 0.24, 0.44, 1.10, s * hw * 0.94, y0 + 0.66, -1.30, 0.06);
  }
  // snorkel
  kit.cyl('dark', 0.075, 0.075, 1.10, 10, hw * 0.86, cabY + 0.62, 1.02);
  kit.blk('dark', 0.20, 0.16, 0.22, hw * 0.86, cabY + 1.18, 1.10);
  // twin stacks out the back, and the flare that goes with them
  for (const s of [-1, 1]) kit.cyl('metal', 0.062, 0.070, 0.26, 10, s * W * 0.20, y0 + 0.50, -L * 0.50, Math.PI / 2);
  kit.flame(0, y0 + 0.50, -L * 0.50 - 0.22, 0.11, 0.42);

  // roof light bar
  const ly = cabY + cabH + 0.18;
  kit.box('dark', W * 0.80, 0.14, 0.16, 0, ly, 1.05, 0.03);
  for (let i = 0; i < 5; i++) kit.cyl('lamp', 0.072, 0.072, 0.05, 12, (i - 2) * W * 0.17, ly, 1.13, Math.PI / 2);
  kit.glow('head', 0, ly, 1.20, 1.30);

  addLights(kit, y0 + 0.74, L * 0.44, -L * 0.49, hw * 0.62);
}

/* --- WEDGE: low, cab-forward, ducktail ---------------------------------- */
function buildWedge(kit, spec) {
  const { L, W } = spec.dims;
  const y0 = -spec.comHeight, hw = W * 0.5;

  kit.box('dark', W * 0.96, 0.07, 0.62, 0, y0 + 0.10, L * 0.44, 0.02);          // splitter
  kit.box('paint', W * 0.88, 0.30, L * 0.86, 0, y0 + 0.32, -0.05, 0.10);        // lower body
  /* The wedge itself: three stacked slabs, each shorter and narrower than the
     one under it. Cheaper than shearing a hull and it keeps the hard creases
     that make the silhouette read as a wedge rather than as a bar of soap. */
  kit.box('paint', W * 0.80, 0.20, 1.55, 0, y0 + 0.50, L * 0.24, 0.08, -0.055);
  kit.box('paint2', W * 0.62, 0.16, 1.05, 0, y0 + 0.64, L * 0.30, 0.06, -0.075);
  kit.box('paint', W * 0.86, 0.26, 1.50, 0, y0 + 0.52, -L * 0.26, 0.09);        // haunches

  // cab-forward canopy
  const cy = y0 + 0.66;
  kit.box('dark', W * 0.60, 0.34, 1.30, 0, cy + 0.16, 0.10, 0.10);
  kit.plate('glass', W * 0.52, 0.50, 0, cy + 0.20, 0.80, -0.62);
  for (const s of [-1, 1]) {
    kit.plate('glass', 0.90, 0.28, s * (W * 0.302), cy + 0.22, 0.02, 0, s * Math.PI / 2);
    kit.plate('livery', 1.30, 0.30, s * (hw * 0.885), y0 + 0.40, -0.10, 0, s * Math.PI / 2);
    kit.box('paint2', 0.09, 0.16, 1.10, s * hw * 0.88, y0 + 0.30, 0.20, 0.03);  // side strake
    kit.box('dark', 0.16, 0.30, 0.50, s * hw * 0.80, y0 + 0.66, -L * 0.14, 0.05); // intake
  }
  kit.plate('glass', W * 0.50, 0.34, 0, cy + 0.22, -0.60, 0.72);                // rear screen
  addDriver(kit, spec, cy + 0.02, 0.14, 0.34);

  // ducktail + diffuser
  kit.box('paint2', W * 0.84, 0.09, 0.46, 0, y0 + 0.70, -L * 0.44, 0.03, 0.20);
  for (const s of [-1, 1]) kit.blk('paint', 0.05, 0.13, 0.30, s * W * 0.41, y0 + 0.77, -L * 0.44);
  kit.box('dark', W * 0.80, 0.10, 0.44, 0, y0 + 0.16, -L * 0.44, 0.02, -0.14);
  for (let i = -2; i <= 2; i++) kit.blk('dark', 0.05, 0.16, 0.42, i * W * 0.16, y0 + 0.20, -L * 0.44);

  // exhausts — the flare mesh is built by buildGlowRig so it can be animated
  for (const s of [-1, 1]) kit.cyl('metal', 0.065, 0.075, 0.20, 10, s * 0.22, y0 + 0.30, -L * 0.49, Math.PI / 2);
  kit.flame(0, y0 + 0.30, -L * 0.49 - 0.24, 0.09, 0.42);

  addLights(kit, y0 + 0.44, L * 0.485, -L * 0.485, hw * 0.58);
}

/* --- BIKE: motocross 450 with a rider up on the pegs ---------------------
   Everything is built around three fixed points: the front hub (+0.72 z), the
   rear hub (−0.72 z) and the ground plane (y0). The forks, the swingarm and
   the shock are NOT built here — they are spanned live by buildBikeGear so
   they travel, which on a machine with 400 mm of suspension is most of what
   you actually watch.

   The rider is half the silhouette and all of the read at distance: standing
   in the attack position, weight back, elbows up, helmet over the bars. Head
   height lands at 1.6 m over the ground, which is what `dims.H` (1.42, plus
   the CoM offset) is sized for — change one and the aero and the collision
   spheres want the other. ------------------------------------------------ */
function buildBike(kit, spec) {
  const zF = spec.wheelbase.front, zR = spec.wheelbase.rear;
  /* Everything below is quoted as HEIGHT ABOVE THE GROUND, because that is
     the number you can check against a photograph. Y() converts to body
     space, where the origin is the centre of mass. */
  const Y = (h) => h - spec.comHeight;

  /* ---- engine and frame. A modern MX frame is a pair of aluminium spars
     wrapping over one very tall cylinder; the spars and the tank shrouds are
     the whole silhouette from three metres away. ---- */
  kit.box('dark', 0.28, 0.30, 0.40, 0, Y(0.50), 0.00, 0.05);              // cases
  kit.box('metal', 0.23, 0.28, 0.23, 0, Y(0.78), 0.05, 0.04, -0.16);      // barrel + head
  kit.blk('dark', 0.19, 0.08, 0.19, 0, Y(0.94), 0.03);                    // valve cover
  const HEAD = 1.00, PIVOT = 0.42;             // steering head, swingarm pivot
  for (const s of [-1, 1]) {
    // main spar: head -> over the engine -> down to the pivot
    kit.tube('paint2', s * 0.055, Y(HEAD - 0.06), zF - 0.10, s * 0.108, Y(0.80), -0.04, 0.036);
    kit.tube('paint2', s * 0.108, Y(0.80), -0.04, s * 0.098, Y(PIVOT + 0.04), -0.12, 0.033);
    kit.tube('paint2', s * 0.052, Y(HEAD - 0.16), zF - 0.12, s * 0.082, Y(0.34), 0.12, 0.026);  // downtube
    kit.tube('paint2', s * 0.104, Y(0.82), -0.08, s * 0.092, Y(0.93), zR + 0.28, 0.024);        // subframe
  }
  kit.blk('metal', 0.15, 0.09, 0.13, 0, Y(HEAD + 0.02), zF - 0.11);       // triple clamp, lower
  kit.blk('metal', 0.19, 0.05, 0.11, 0, Y(HEAD + 0.16), zF - 0.13);       // triple clamp, upper

  /* ---- plastics. The tank is nearly invisible on a modern MX bike; the
     shrouds beside it are what you actually see, so they get the colour. ---- */
  kit.box('paint', 0.21, 0.19, 0.40, 0, Y(0.99), 0.24, 0.07);             // tank
  for (const s of [-1, 1]) {
    kit.box('paint', 0.075, 0.30, 0.42, s * 0.135, Y(0.90), 0.22, 0.05, 0, 0, s * 0.17);   // shroud
    kit.plate('livery', 0.32, 0.22, s * 0.126, Y(0.82), -0.26, 0, s * Math.PI / 2);        // number plate
    kit.blk('dark', 0.05, 0.19, 0.32, s * 0.122, Y(0.82), -0.26);                          // airbox side
    kit.blk('dark', 0.055, 0.16, 0.26, s * 0.115, Y(0.56), -0.34);                         // side panel
  }
  kit.box('dark', 0.16, 0.08, 0.62, 0, Y(0.97), -0.14, 0.04, -0.05);      // seat
  kit.box('paint', 0.20, 0.04, 0.38, 0, Y(1.02), zR + 0.30, 0.02, 0.18);  // rear fender
  kit.box('paint', 0.21, 0.04, 0.34, 0, Y(1.03), zF + 0.08, 0.02, 0.14);  // front fender
  kit.plate('livery', 0.25, 0.19, 0, Y(HEAD + 0.24), zF - 0.05, -0.34);   // front number board

  /* ---- exhaust: header off the front of the head, round the right side,
     into a can under the seat. Three tubes and a silencer. ---- */
  kit.tube('metal', 0.04, Y(0.86), 0.22, 0.09, Y(0.60), 0.30, 0.025);
  kit.tube('metal', 0.09, Y(0.60), 0.30, 0.12, Y(0.56), -0.12, 0.025);
  kit.tube('metal', 0.12, Y(0.56), -0.12, 0.14, Y(0.74), zR + 0.32, 0.029);
  kit.cyl('metal', 0.052, 0.058, 0.36, 10, 0.145, Y(0.82), zR + 0.10, Math.PI / 2, 0, 0.10);
  kit.flame(0.145, Y(0.84), zR - 0.14, 0.065, 0.30);

  /* ---- bars, controls, pegs ---- */
  const BAR = HEAD + 0.28, barZ = zF - 0.19;
  for (const s of [-1, 1]) {
    kit.cyl('metal', 0.026, 0.026, 0.06, 8, s * 0.070, Y(BAR - 0.05), zF - 0.13);           // riser
    kit.tube('metal', s * 0.070, Y(BAR - 0.02), zF - 0.13, s * 0.33, Y(BAR), barZ, 0.017);  // bar
    kit.cyl('dark', 0.023, 0.023, 0.12, 8, s * 0.365, Y(BAR), barZ, 0, 0, Math.PI / 2);     // grip
    kit.blk('dark', 0.085, 0.085, 0.028, s * 0.33, Y(BAR + 0.02), barZ + 0.06);             // handguard
    kit.blk('metal', 0.12, 0.02, 0.085, s * 0.185, Y(0.35), -0.05);                         // footpeg
  }
  kit.cyl('lamp', 0.068, 0.068, 0.04, 12, 0, Y(HEAD + 0.22), zF + 0.01, Math.PI / 2);       // headlight
  kit.blk('brake', 0.12, 0.06, 0.04, 0, Y(1.04), zR + 0.12);                                // tail light
  kit.glow('head', 0, Y(HEAD + 0.22), zF + 0.06, 0.55);
  kit.glow('brake', 0, Y(1.04), zR + 0.08, 0.34);

  /* ---- rider. Up on the pegs, weight over the back wheel, elbows out: the
     attack position, and the one pose that reads as motocross rather than as
     a commuter. The helmet is the highest thing on the machine and `dims.H`
     is measured to the top of it. ---- */
  const PEG = 0.38, KNEE = 0.74, HIP = 1.10, SHOULDER = 1.36;
  for (const s of [-1, 1]) {
    kit.blk('dark', 0.10, 0.08, 0.22, s * 0.185, Y(PEG - 0.02), -0.04);                    // boot
    kit.tube('dark', s * 0.185, Y(PEG + 0.06), -0.03, s * 0.165, Y(KNEE), 0.02, 0.058);    // shin
    kit.tube('dark', s * 0.165, Y(KNEE), 0.02, s * 0.125, Y(HIP), -0.14, 0.066);           // thigh
    kit.tube('paint2', s * 0.155, Y(SHOULDER), -0.06, s * 0.295, Y(BAR + 0.15), barZ + 0.10, 0.050); // upper arm
    kit.tube('paint2', s * 0.295, Y(BAR + 0.15), barZ + 0.10, s * 0.345, Y(BAR + 0.02), barZ, 0.039); // forearm
    kit.blk('dark', 0.075, 0.070, 0.090, s * 0.352, Y(BAR + 0.01), barZ);                  // glove
  }
  kit.box('dark', 0.26, 0.13, 0.20, 0, Y(HIP + 0.02), -0.16, 0.05);                        // hips
  kit.box('paint2', 0.28, 0.36, 0.22, 0, Y((HIP + SHOULDER) * 0.5 + 0.02), -0.10, 0.08, 0.42); // torso
  kit.plate('livery', 0.26, 0.20, 0, Y(1.24), -0.24, -0.42);                               // back number
  kit.sphere('helmet', 0.142, 0, Y(1.42), 0.10);
  kit.blk('helmet', 0.19, 0.045, 0.15, 0, Y(1.50), 0.17, -0.40);                           // peak
  kit.plate('visor', 0.185, 0.095, 0, Y(1.40), 0.252, 0, 0, 0.10);                         // goggles
}

/** Stretch a unit-length +Z member so it spans exactly from a to b. */
function span(mesh, a, b) {
  mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  _sv.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = _sv.length();
  mesh.scale.set(1, 1, Math.max(len, 0.02));
  if (len > 1e-5) mesh.quaternion.setFromUnitVectors(_zAxis, _sv.divideScalar(len));
}

/* ============================================================
   scratch — module level, zero allocation in updateVehicleVisuals()
   ============================================================ */
const _zAxis = new THREE.Vector3(0, 0, 1);
const _v1 = new THREE.Vector3(), _sv = new THREE.Vector3();
const _v2 = new THREE.Vector3();          // fork/swingarm pickup, offset off _v1
const _q1 = new THREE.Quaternion();
/* build-time only */
const _hsl = { h: 0, s: 0, l: 0 };
const _kv = new THREE.Vector3(), _kY = new THREE.Vector3(0, 1, 0);
const _kq = new THREE.Quaternion(), _km = new THREE.Matrix4();

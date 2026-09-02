/* ============================================================
   RALLY ROAD RASH — vehicle art
   ------------------------------------------------------------
   Everything a Vehicle LOOKS like, and nothing it does. Extracted from
   vehicle.js so the solver and the model kit can be worked on separately:
   physics reads none of this, and this reads only published body state
   (pos/quat, per-wheel worldPos/steer/spin, the _accel* pair, contacts).

   The Vehicle still OWNS the objects — root, chassis, wheelRoot, leanRoot,
   mats, tex, geos, exhaust, paintColor and the per-wheel obj/hub/arm/coil
   live on the instance, because the dev harnesses reach in and read them.
   These functions only build, drive and free them.

   Conventions match vehicle.js: metres, radians, Y up, local forward +Z.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, makeRNG } from '../core/rng.js';
import { G } from './config.js';

const RACE_NUMBERS = [7, 12, 23, 41, 68, 95, 3, 55];
/* Peak visual bank on a two-wheeler, radians. 0.62 = 35.5°, which is what a
   450 actually carries through a flat turn and about the point where the
   inside peg would start dragging. Higher looks like a road racer, which is
   the wrong sport. */
const BIKE_LEAN_MAX = 0.62;

/* ============================================================
   PUBLIC API — build / update / dispose / ghost
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
  const num = RACE_NUMBERS[v.livery % RACE_NUMBERS.length];

  const base = new THREE.Color(spec.color);
  base.getHSL(_hsl);
  const paint = new THREE.Color().setHSL((_hsl.h + hue) % 1, _hsl.s, _hsl.l);
  const paint2 = new THREE.Color().setHSL((_hsl.h + hue + 0.5) % 1,
    _hsl.s * 0.35, _hsl.l * 0.34);
  v.paintColor = paint.getHex();

  v.tex = { livery: liveryTexture(paint, paint2, num, spec.name, rng) };

  const M = v.mats = {
    paint: new THREE.MeshStandardMaterial({ color: paint, metalness: 0.30, roughness: 0.42 }),
    paint2: new THREE.MeshStandardMaterial({ color: paint2, metalness: 0.20, roughness: 0.60 }),
    livery: new THREE.MeshStandardMaterial({
      map: v.tex.livery, color: 0xffffff, metalness: 0.15, roughness: 0.48,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1d1f24, metalness: 0.35, roughness: 0.74 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.90, roughness: 0.38 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0.05, roughness: 0.92 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.85, roughness: 0.32 }),
    spring: new THREE.MeshStandardMaterial({
      map: springTexture(), color: 0xe8eaee, metalness: 0.55, roughness: 0.48,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x0b1015, metalness: 0.20, roughness: 0.10,
      clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.8,
    }),
    helmet: new THREE.MeshStandardMaterial({ color: 0xf0f2f5, metalness: 0.1, roughness: 0.45 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff4dc }),
    brake: new THREE.MeshBasicMaterial({ color: 0x3a0705 }),
    glow: new THREE.MeshBasicMaterial({
      color: 0xff8a3a, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  };

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
  else if (spec.bodyStyle === 'wedge') buildWedge(kit, spec, v);
  else if (spec.bodyStyle === 'bike') buildBike(kit, spec, v);
  else buildBuggy(kit, spec);
  v.geos = kit.flush(v.chassis, M);

  buildRunningGear(v, spec, M);
  // Traverse the WHOLE root, not just the chassis — the wheels, arms and
  // brake discs live under wheelRoot and a car whose wheels cast no shadow
  // reads as hovering.
  v.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // additive transients must never enter the shadow pass
  if (v.exhaust) { v.exhaust.castShadow = false; v.exhaust.receiveShadow = false; }
  v.sync();
}

function buildRunningGear(v, spec, M) {
  if (spec.bodyStyle === 'bike') return buildBikeGear(v, spec, M);
  const sxs = spec.bodyStyle === 'buggy';
  // An SxS wears its rubber big: the buggy's tyres run visually wider than
  // the contact-patch number the physics uses. Purely cosmetic.
  const visW = spec.wheelW * (sxs ? 1.16 : 1);
  const wheelGeo = buildWheelGeometry(spec.wheelR, visW);
  // The rim face must reach the tyre face or it vanishes inside the sidewall.
  const discGeo = new THREE.CylinderGeometry(spec.wheelR * 0.60, spec.wheelR * 0.60,
    sxs ? visW * 0.96 : spec.wheelW * 0.20, 16);
  discGeo.rotateZ(Math.PI / 2);
  const armGeo = roundedBox(sxs ? 0.075 : 0.11, sxs ? 0.075 : 0.09, 1, 0.028);
  const coilGeo = new THREE.CylinderGeometry(sxs ? 0.075 : 0.055, sxs ? 0.075 : 0.055, 1, 9);
  coilGeo.rotateX(Math.PI / 2);                        // make it a +Z member too
  const shaftGeo = sxs ? (() => { const g = new THREE.CylinderGeometry(0.026, 0.026, 1, 7); g.rotateX(Math.PI / 2); return g; })() : null;
  let beadGeo = null;
  if (sxs) {
    // Beadlock face: outer ring + eight bolt heads, one merged geometry that
    // spins with the tyre. Mirrored per side at attach time via scale.x.
    const parts = [];
    const face = visW * 0.5 + 0.008, ringR = spec.wheelR * 0.60;
    const ring = new THREE.TorusGeometry(ringR, 0.030, 8, 22);
    ring.rotateY(Math.PI / 2);
    ring.translate(face, 0, 0);
    parts.push(ring);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      const bolt = new THREE.CylinderGeometry(0.022, 0.022, 0.04, 6);
      bolt.rotateZ(Math.PI / 2);
      bolt.translate(face + 0.012, Math.cos(a) * ringR, Math.sin(a) * ringR);
      parts.push(bolt);
    }
    beadGeo = mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
  }
  v.geos.push(wheelGeo, discGeo, armGeo, coilGeo);
  if (shaftGeo) v.geos.push(shaftGeo);
  if (beadGeo) v.geos.push(beadGeo);

  for (const w of v.wheels) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeo, M.tyre);
    tyre.castShadow = true; tyre.receiveShadow = true;
    g.add(tyre);
    const disc = new THREE.Mesh(discGeo, M.rim);
    g.add(disc);
    if (beadGeo) {
      const bead = new THREE.Mesh(beadGeo, M.rim);
      bead.scale.x = w.side;                 // outboard face on both sides
      g.add(bead);
    }
    w.obj = g; w.hub = tyre;
    v.wheelRoot.add(g);

    /* Visible linkage. All members are unit-length +Z pieces re-spanned every
       frame between their chassis pickup and the live hub position, which is
       the only way the suspension reads as *travelling* rather than as wheels
       sliding around inside the arches. The buggy gets the full SxS set:
       upper + lower A-arm in body colour and a coilover with a visible
       spring; the others keep the single dark arm + strut. */
    const armMat = sxs ? M.paint : M.dark;
    w.arm = new THREE.Mesh(armGeo, armMat);
    w.coil = new THREE.Mesh(coilGeo, sxs ? M.spring : M.metal);
    w.arm.castShadow = w.coil.castShadow = true;
    v.wheelRoot.add(w.arm, w.coil);
    w.armRoot.set(w.side * spec.track * 0.20, w.mount.y - spec.suspRest * 0.90, w.mount.z);
    w.coilRoot.set(w.side * spec.track * 0.30, w.mount.y + 0.20, w.mount.z - 0.06);
    if (sxs) {
      w.arm2 = new THREE.Mesh(armGeo, armMat);
      w.arm2.castShadow = true;
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
  const wheelGeo = buildWheelGeometry(R, spec.wheelW);
  // Spoked hub: a plain disc reads as a scooter wheel. Rim ring + hub barrel.
  const hubParts = [];
  const rim = new THREE.CylinderGeometry(R * 0.80, R * 0.80, spec.wheelW * 0.34, 18, 1, true);
  rim.rotateZ(Math.PI / 2); hubParts.push(rim);
  const barrel = new THREE.CylinderGeometry(R * 0.20, R * 0.20, spec.wheelW * 1.5, 10);
  barrel.rotateZ(Math.PI / 2); hubParts.push(barrel);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(spec.wheelW * 0.10, R * 0.62, 0.012);
    spoke.translate(0, R * 0.50, 0);
    spoke.rotateX(a);
    hubParts.push(spoke);
  }
  const discGeo = mergeGeometries(hubParts, false);
  hubParts.forEach(p => p.dispose());
  // Fork legs and swingarm rails are round tube; the shock wears a spring.
  const legGeo = new THREE.CylinderGeometry(0.030, 0.036, 1, 8); legGeo.rotateX(Math.PI / 2);
  const armGeo = new THREE.CylinderGeometry(0.034, 0.042, 1, 7); armGeo.rotateX(Math.PI / 2);
  const shockGeo = new THREE.CylinderGeometry(0.048, 0.048, 1, 9); shockGeo.rotateX(Math.PI / 2);
  v.geos.push(wheelGeo, discGeo, legGeo, armGeo, shockGeo);

  const FORK_X = 0.085, ARM_X = 0.098;
  for (const w of v.wheels) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeo, M.tyre);
    const disc = new THREE.Mesh(discGeo, M.rim);
    g.add(tyre, disc);
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
 * Wheels, suspension travel, steering, brake lights and the visual-only body
 * lean. Physics never reads any of this.
 */
export function updateVehicleVisuals(v, dt) {
  if (!v.root) return;
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

  // brake lights: on under braking, and under reverse, like the real thing
  const lit = v._ctlBrake > 0.04 || v._ctlHand > 0 || v.speed < -0.6;
  const b = lit ? 2.6 : 0.22;
  v.mats.brake.color.setRGB(b, b * 0.055, b * 0.04);

  // exhaust flicker — cosmetic transient, Math.random is allowed here
  if (v.exhaust) {
    const heat = v.rpmNorm * Math.max(0, v._ctlThr);
    v.exhaust.material.opacity = heat > 0.35
      ? (heat - 0.35) * (0.45 + Math.random() * 0.55) : 0;
  }
}

export function disposeVehicleVisuals(v) {
  if (!v.root) return;
  const seenG = new Set(), seenM = new Set();
  v.root.traverse(o => {
    if (!o.isMesh) return;
    if (o.geometry && !seenG.has(o.geometry)) { seenG.add(o.geometry); o.geometry.dispose(); }
    const m = o.material;
    if (Array.isArray(m)) m.forEach(x => { if (!seenM.has(x)) { seenM.add(x); x.dispose(); } });
    else if (m && !seenM.has(m)) { seenM.add(m); m.dispose(); }
  });
  for (const g of v.geos || []) if (!seenG.has(g)) g.dispose();
  for (const k in v.tex) v.tex[k]?.dispose();
  v.root.parent?.remove(v.root);
  v.root = null; v.chassis = null; v.wheelRoot = null;
  for (const w of v.wheels) { w.obj = w.hub = w.arm = w.coil = null; }
}

/**
 * Ghost look for a replay/spectator car: k01 0 = solid, 1 = fully ghosted.
 * A no-op stub until the vehicle-art pass lands the transparent path — the
 * call site in race.js exists now so the seam is exercised from day one.
 */
export function setGhostLook(v, k01) {   // eslint-disable-line no-unused-vars
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

/** Knobby off-road tyre: carcass, rim face, and chevron cleats with real depth. */
function buildWheelGeometry(R, W) {
  const parts = [];
  const carcass = new THREE.CylinderGeometry(R * 0.94, R * 0.94, W, 20, 1, true);
  carcass.rotateZ(Math.PI / 2); parts.push(carcass);
  for (const s of [-1, 1]) {
    const sidewall = new THREE.CylinderGeometry(R * 0.94, R * 0.62, W * 0.16, 20, 1, true);
    sidewall.rotateZ(Math.PI / 2); sidewall.translate(s * (W / 2 + W * 0.08), 0, 0);
    parts.push(sidewall);
    const face = new THREE.CircleGeometry(R * 0.62, 20);
    face.rotateY(s * Math.PI / 2); face.translate(s * (W / 2 + W * 0.16), 0, 0);
    parts.push(face);
  }
  // Cleats, deliberately chunky — these are the silhouette at speed, and a
  // tyre without them reads as a black doughnut.
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2;
    for (const half of [-1, 1]) {
      const cleat = new THREE.BoxGeometry(W * 0.42, R * 0.10, R * 0.30);
      cleat.translate(0, R * 0.96, 0);
      cleat.rotateY(half * 0.30);
      cleat.translate(half * W * 0.24, 0, 0);
      cleat.rotateX(a + half * 0.10);
      parts.push(cleat);
    }
  }
  const g = mergeGeometries(parts, false);
  parts.forEach(p => p.dispose());
  g.computeVertexNormals();
  return g;
}

/** Racing livery: number roundel, accent stripes, a bit of sponsor noise. */
function liveryTexture(paint, paint2, num, name, rng, size = 512) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size / 2;
  const g = c.getContext('2d');
  const H = c.height;
  const hex = (col) => '#' + col.getHexString();

  g.fillStyle = hex(paint); g.fillRect(0, 0, size, H);
  // dirt gradient toward the bottom — every rally car is filthy by lap two
  const grd = g.createLinearGradient(0, H * 0.45, 0, H);
  grd.addColorStop(0, 'rgba(60,48,34,0)'); grd.addColorStop(1, 'rgba(52,42,30,0.42)');
  g.fillStyle = grd; g.fillRect(0, 0, size, H);

  // accent stripes running the length of the panel
  g.fillStyle = hex(paint2);
  g.fillRect(0, H * 0.60, size, H * 0.10);
  g.globalAlpha = 0.55; g.fillRect(0, H * 0.73, size, H * 0.035); g.globalAlpha = 1;
  g.save();
  g.translate(size * 0.70, 0); g.transform(1, 0, -0.35, 1, 0, 0);
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(0, 0, size * 0.09, H); g.fillRect(size * 0.14, 0, size * 0.04, H);
  g.restore();

  // number roundel
  const cx = size * 0.30, cy = H * 0.40, r = H * 0.30;
  g.fillStyle = 'rgba(248,248,244,0.94)';
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
  g.strokeStyle = 'rgba(20,20,22,0.75)'; g.lineWidth = r * 0.10; g.stroke();
  g.fillStyle = '#17181c';
  g.font = `900 ${Math.round(r * 1.15)}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), cx, cy + r * 0.04);

  // team name + a couple of sponsor blocks
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(250,250,250,0.88)';
  g.font = `700 ${Math.round(H * 0.085)}px ui-monospace, Menlo, monospace`;
  g.fillText(name, size * 0.50, H * 0.24);
  g.font = `600 ${Math.round(H * 0.052)}px ui-monospace, Menlo, monospace`;
  g.fillStyle = 'rgba(20,20,22,0.66)';
  g.fillText('ROAD RASH · WORKS TEAM', size * 0.50, H * 0.545);
  for (let i = 0; i < 5; i++) {
    const bx = size * (0.50 + i * 0.095), by = H * 0.80;
    g.fillStyle = `rgba(${20 + rng() * 40 | 0},${20 + rng() * 40 | 0},${24 + rng() * 40 | 0},0.55)`;
    g.fillRect(bx, by, size * 0.075, H * 0.10);
  }
  // scuffs
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(30,24,18,${0.03 + rng() * 0.07})`;
    g.fillRect(rng() * size, rng() * H, 4 + rng() * 40, 1 + rng() * 4);
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
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

/** Collects build-time geometry into one merged mesh per material. */
class Kit {
  constructor() { this.b = new Map(); }
  add(mat, g) { let a = this.b.get(mat); if (!a) this.b.set(mat, a = []); a.push(g); }

  box(mat, sx, sy, sz, x, y, z, r = 0.04, rx = 0, ry = 0, rz = 0) {
    const g = roundedBox(sx, sy, sz, r);
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
  sphere(mat, r, x, y, z, seg = 12) {
    const g = new THREE.SphereGeometry(r, seg, seg * 0.7 | 0);
    g.translate(x, y, z); this.add(mat, g); return g;
  }
  /** Cage tube between two body-space points. */
  tube(mat, ax, ay, az, bx, by, bz, r) {
    const lx = bx - ax, ly = by - ay, lz = bz - az;
    const len = Math.hypot(lx, ly, lz);
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, 8);
    _kq.setFromUnitVectors(_kY, _kv.set(lx / len, ly / len, lz / len));
    _km.makeRotationFromQuaternion(_kq);
    _km.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    g.applyMatrix4(_km);
    this.add(mat, g);
  }

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
  // boxes share one material so updateVisuals can light them all at once.
  for (const s of [-1, 1]) {
    kit.cyl('lamp', 0.10, 0.10, 0.05, 14, s * spread, y, zF, Math.PI / 2);
    kit.cyl('dark', 0.125, 0.125, 0.07, 14, s * spread, y, zF - 0.035, Math.PI / 2);
    kit.box('brake', 0.30, 0.11, 0.06, s * spread * 0.92, y, zR, 0.02);
  }
}

function addDriver(kit, spec, y, z, lean = 0.22, x = 0) {
  const w = spec.dims.W;
  kit.box('dark', w * 0.34, 0.42, 0.16, x, y + 0.06, z - 0.34, 0.05, -lean);   // seat back
  kit.box('dark', w * 0.34, 0.10, 0.44, x, y - 0.15, z - 0.10, 0.04);          // seat base
  kit.sphere('helmet', 0.145, x, y + 0.20, z - 0.20);
  kit.plate('glass', 0.20, 0.11, x, y + 0.20, z - 0.065);                      // visor
  kit.cyl('dark', 0.115, 0.115, 0.03, 14, x, y + 0.06, z + 0.26, 1.15);        // steering wheel
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
  kit.box('dark', bw * 0.30, 0.055, 0.62, 0, y0 + 0.80, L * 0.245, 0.02, 0.135); // hood vent
  // front fascia: black grille panel under angry LED brows
  kit.box('dark', bw * 0.86, 0.30, 0.16, 0, y0 + 0.545, L * 0.455, 0.04);
  for (const s of [-1, 1]) {
    // LED brows — thin lit slashes, angled down-inward like the reference
    kit.box('lamp', 0.30, 0.035, 0.03, s * bw * 0.28, y0 + 0.665, L * 0.468, 0.008, 0, 0, s * -0.22);
    kit.box('dark', 0.34, 0.075, 0.05, s * bw * 0.28, y0 + 0.665, L * 0.452, 0.015, 0, 0, s * -0.22);
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
    // white slash accent along the door top — the "RS" streak
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
    kit.box('dark', 0.05, 0.09, 0.14, s * (bw * 0.5 + 0.09), y0 + 1.05, 0.52, 0.02);
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
    kit.cyl('dark', 0.055, 0.062, 0.22, 10, s * bw * 0.24, y0 + 0.60, -L * 0.475, Math.PI / 2);
    kit.tube('metal', s * bw * 0.45, y0 + 0.40, -L * 0.50, s * bw * 0.45, y0 + 0.72, -L * 0.44, 0.034);
  }

  addLights(kit, y0 + 0.60, L * 0.472, -L * 0.49, bw * 0.40);
  // cage light pod — pure rally
  for (let i = 0; i < 4; i++) {
    kit.cyl('lamp', 0.070, 0.070, 0.04, 12, (i - 1.5) * 0.19, roofY + 0.10, roofF + 0.05, Math.PI / 2);
    kit.cyl('dark', 0.085, 0.085, 0.07, 12, (i - 1.5) * 0.19, roofY + 0.10, roofF + 0.01, Math.PI / 2);
  }
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
    kit.box('dark', 0.10, 0.16, 0.26, s * hw * 0.98, cabY + cabH * 0.70, 1.02, 0.03);  // mirror
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
  kit.box('dark', 0.20, 0.16, 0.22, hw * 0.86, cabY + 1.18, 1.10, 0.04);

  // roof light bar
  const ly = cabY + cabH + 0.18;
  kit.box('dark', W * 0.80, 0.14, 0.16, 0, ly, 1.05, 0.03);
  for (let i = 0; i < 5; i++) kit.cyl('lamp', 0.072, 0.072, 0.05, 12, (i - 2) * W * 0.17, ly, 1.13, Math.PI / 2);

  addLights(kit, y0 + 0.74, L * 0.44, -L * 0.49, hw * 0.62);
}

/* --- WEDGE: low, cab-forward, ducktail ---------------------------------- */
function buildWedge(kit, spec, v) {
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
  for (const s of [-1, 1]) kit.box('paint', 0.05, 0.13, 0.30, s * W * 0.41, y0 + 0.77, -L * 0.44, 0.01);
  kit.box('dark', W * 0.80, 0.10, 0.44, 0, y0 + 0.16, -L * 0.44, 0.02, -0.14);
  for (let i = -2; i <= 2; i++) kit.box('dark', 0.05, 0.16, 0.42, i * W * 0.16, y0 + 0.20, -L * 0.44, 0.01);

  // exhausts — the flicker mesh is built separately so it can be animated
  for (const s of [-1, 1]) kit.cyl('metal', 0.065, 0.075, 0.20, 10, s * 0.22, y0 + 0.30, -L * 0.49, Math.PI / 2);
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.42, 8, 1, true).rotateX(-Math.PI / 2),
    v.mats.glow);
  flame.position.set(0, y0 + 0.30, -L * 0.49 - 0.24);
  flame.renderOrder = 6;
  v.chassis.add(flame);
  v.exhaust = flame;

  addLights(kit, y0 + 0.44, L * 0.485, -L * 0.485, hw * 0.58);
}

/* --- BIKE: motocross 450 with a rider up on the pegs ---------------------
   Everything is built around three fixed points: the front hub (+0.72 z), the
   rear hub (−0.72 z) and the ground plane (y0). The forks, the swingarm and
   the shock are NOT built here — they are spanned live by _buildBikeGear so
   they travel, which on a machine with 400 mm of suspension is most of what
   you actually watch.

   The rider is half the silhouette and all of the read at distance: standing
   in the attack position, weight back, elbows up, helmet over the bars. Head
   height lands at 1.6 m over the ground, which is what `dims.H` (1.42, plus
   the CoM offset) is sized for — change one and the aero and the collision
   spheres want the other. ------------------------------------------------ */
function buildBike(kit, spec, v) {
  const zF = spec.wheelbase.front, zR = spec.wheelbase.rear;
  /* Everything below is quoted as HEIGHT ABOVE THE GROUND, because that is
     the number you can check against a photograph. Y() converts to body
     space, where the origin is the centre of mass. */
  const Y = (h) => h - spec.comHeight;
  const AXLE = spec.wheelR;                    // 0.36 — both hubs at static sag

  /* ---- engine and frame. A modern MX frame is a pair of aluminium spars
     wrapping over one very tall cylinder; the spars and the tank shrouds are
     the whole silhouette from three metres away. ---- */
  kit.box('dark', 0.28, 0.30, 0.40, 0, Y(0.50), 0.00, 0.05);              // cases
  kit.box('metal', 0.23, 0.28, 0.23, 0, Y(0.78), 0.05, 0.04, -0.16);      // barrel + head
  kit.box('dark', 0.19, 0.08, 0.19, 0, Y(0.94), 0.03, 0.03);              // valve cover
  const HEAD = 1.00, PIVOT = 0.42;             // steering head, swingarm pivot
  for (const s of [-1, 1]) {
    // main spar: head -> over the engine -> down to the pivot
    kit.tube('paint2', s * 0.055, Y(HEAD - 0.06), zF - 0.10, s * 0.108, Y(0.80), -0.04, 0.036);
    kit.tube('paint2', s * 0.108, Y(0.80), -0.04, s * 0.098, Y(PIVOT + 0.04), -0.12, 0.033);
    kit.tube('paint2', s * 0.052, Y(HEAD - 0.16), zF - 0.12, s * 0.082, Y(0.34), 0.12, 0.026);  // downtube
    kit.tube('paint2', s * 0.104, Y(0.82), -0.08, s * 0.092, Y(0.93), zR + 0.28, 0.024);        // subframe
  }
  kit.box('metal', 0.15, 0.09, 0.13, 0, Y(HEAD + 0.02), zF - 0.11, 0.03); // triple clamp, lower
  kit.box('metal', 0.19, 0.05, 0.11, 0, Y(HEAD + 0.16), zF - 0.13, 0.02); // triple clamp, upper

  /* ---- plastics. The tank is nearly invisible on a modern MX bike; the
     shrouds beside it are what you actually see, so they get the colour. ---- */
  kit.box('paint', 0.21, 0.19, 0.40, 0, Y(0.99), 0.24, 0.07);             // tank
  for (const s of [-1, 1]) {
    kit.box('paint', 0.075, 0.30, 0.42, s * 0.135, Y(0.90), 0.22, 0.05, 0, 0, s * 0.17);   // shroud
    kit.plate('livery', 0.32, 0.22, s * 0.126, Y(0.82), -0.26, 0, s * Math.PI / 2);        // number plate
    kit.box('dark', 0.05, 0.19, 0.32, s * 0.122, Y(0.82), -0.26, 0.03);                    // airbox side
    kit.box('dark', 0.055, 0.16, 0.26, s * 0.115, Y(0.56), -0.34, 0.03);                   // side panel
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

  /* ---- bars, controls, pegs ---- */
  const BAR = HEAD + 0.28, barZ = zF - 0.19;
  for (const s of [-1, 1]) {
    kit.cyl('metal', 0.026, 0.026, 0.06, 8, s * 0.070, Y(BAR - 0.05), zF - 0.13);           // riser
    kit.tube('metal', s * 0.070, Y(BAR - 0.02), zF - 0.13, s * 0.33, Y(BAR), barZ, 0.017);  // bar
    kit.cyl('dark', 0.023, 0.023, 0.12, 8, s * 0.365, Y(BAR), barZ, 0, 0, Math.PI / 2);     // grip
    kit.box('dark', 0.085, 0.085, 0.028, s * 0.33, Y(BAR + 0.02), barZ + 0.06, 0.01);       // handguard
    kit.box('metal', 0.12, 0.02, 0.085, s * 0.185, Y(0.35), -0.05, 0.01);                   // footpeg
  }
  kit.cyl('lamp', 0.068, 0.068, 0.04, 12, 0, Y(HEAD + 0.22), zF + 0.01, Math.PI / 2);       // headlight
  kit.box('brake', 0.12, 0.06, 0.04, 0, Y(1.04), zR + 0.12, 0.02);                          // tail light

  /* ---- rider. Up on the pegs, weight over the back wheel, elbows out: the
     attack position, and the one pose that reads as motocross rather than as
     a commuter. The helmet is the highest thing on the machine and `dims.H`
     is measured to the top of it. ---- */
  const PEG = 0.38, KNEE = 0.74, HIP = 1.10, SHOULDER = 1.36;
  for (const s of [-1, 1]) {
    kit.box('dark', 0.10, 0.08, 0.22, s * 0.185, Y(PEG - 0.02), -0.04, 0.03);              // boot
    kit.tube('dark', s * 0.185, Y(PEG + 0.06), -0.03, s * 0.165, Y(KNEE), 0.02, 0.058);    // shin
    kit.tube('dark', s * 0.165, Y(KNEE), 0.02, s * 0.125, Y(HIP), -0.14, 0.066);           // thigh
    kit.tube('paint2', s * 0.155, Y(SHOULDER), -0.06, s * 0.295, Y(BAR + 0.15), barZ + 0.10, 0.050); // upper arm
    kit.tube('paint2', s * 0.295, Y(BAR + 0.15), barZ + 0.10, s * 0.345, Y(BAR + 0.02), barZ, 0.039); // forearm
  }
  kit.box('dark', 0.26, 0.13, 0.20, 0, Y(HIP + 0.02), -0.16, 0.05);                        // hips
  kit.box('paint2', 0.28, 0.36, 0.22, 0, Y((HIP + SHOULDER) * 0.5 + 0.02), -0.10, 0.08, 0.42); // torso
  kit.plate('livery', 0.26, 0.20, 0, Y(1.24), -0.24, -0.42);                               // back number
  kit.sphere('helmet', 0.142, 0, Y(1.42), 0.10);
  kit.box('helmet', 0.19, 0.045, 0.15, 0, Y(1.50), 0.17, 0.02, -0.40);                     // peak
  kit.plate('glass', 0.185, 0.095, 0, Y(1.40), 0.24, 0, 0, 0.10);                          // goggles

  /* ---- pipe flare. One can, so one cone, at the silencer tip. */
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.065, 0.30, 8, 1, true).rotateX(-Math.PI / 2),
    v.mats.glow);
  flame.position.set(0.145, Y(0.84), zR - 0.14);
  flame.renderOrder = 6;
  v.chassis.add(flame);
  v.exhaust = flame;
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

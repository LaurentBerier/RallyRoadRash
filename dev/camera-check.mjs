/* ============================================================
   RALLY ROAD RASH — camera & feel smoke test
   ------------------------------------------------------------
   Drives CameraRig + Feel through a scripted stunt (launch → hard corner →
   1.8 s air arc → heavy landing) against a mock terrain and a mock vehicle,
   then gates the things a camera is allowed to get wrong: burying itself in
   the ground, producing a NaN, leaving its design envelope, ringing after a
   landing, or teleporting on a mode change.

     node --experimental-loader ./dev/loader.mjs dev/camera-check.mjs

   Runs headless (no renderer, no DOM). Nonzero exit on any failure.
   ============================================================ */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CameraRig, CAM } from '../src/game/camera.js';
import { Feel } from '../src/game/feel.js';
import { G } from '../src/game/config.js';

/* ---------------- harness ---------------- */
let failures = 0, checks = 0;
const DT = 1 / 60;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++; if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

/* ---------------- mock terrain ----------------
   Flat is the primary surface (the brief's ground-clearance gate is stated
   against flat ground). `rolling` exists so the boom avoidance has something to
   actually avoid — a flat world can never fail it. */
const flat = { heightAt: () => 0 };
const rolling = {
  heightAt: (x, z) => 3.5 * Math.sin(x * 0.045) * Math.cos(z * 0.037) + 1.2 * Math.sin(z * 0.11),
};

/* ---------------- mock vehicle ----------------
   Exactly the fields docs/INTEGRATION-NOTES.md says the camera may read, plus
   `spec.topSpeed` for the vignette curve and `steerNorm` for lateral
   look-ahead. Kinematic: the script sets velocity and heading, this integrates. */
const _gf = new THREE.Vector3(), _gu = new THREE.Vector3(), _gr = new THREE.Vector3();
class MockVehicle {
  constructor() {
    this.pos = new THREE.Vector3(0, 0.55, 0);
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.airborne = false; this.airTime = 0; this.contacts = 4;
    this.hardHit = 0;
    this.steerNorm = 0;
    this._accelLong = 0; this._accelLat = 0;
    this.spec = { topSpeed: 38 };
    this.heading = 0;          // body yaw, rad
    this.pitchAng = 0; this.rollAng = 0;
  }
  get forward() { return _gf.set(0, 0, 1).applyQuaternion(this.quat); }
  get right() { return _gr.set(-1, 0, 0).applyQuaternion(this.quat); }
  get up() { return _gu.set(0, 1, 0).applyQuaternion(this.quat); }
  get speed() { return this.vel.dot(this.forward); }
  /** Rebuild quat from euler-ish heading/pitch/roll, integrate position. */
  step(dt, terrain) {
    _qa.setFromAxisAngle(_YAX, this.heading);
    _qb.setFromAxisAngle(_XAX, this.pitchAng);
    _qc.setFromAxisAngle(_ZAX, this.rollAng);
    this.quat.copy(_qa).multiply(_qb).multiply(_qc).normalize();
    this.pos.addScaledVector(this.vel, dt);
    if (!this.airborne) {
      this.pos.y = terrain.heightAt(this.pos.x, this.pos.z) + 0.55;
      this.vel.y = 0;
      this.contacts = 4; this.airTime = 0;
    } else {
      this.vel.y -= G * dt;
      this.airTime += dt;
      this.contacts = 0;
    }
  }
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _XAX = new THREE.Vector3(1, 0, 0), _YAX = new THREE.Vector3(0, 1, 0), _ZAX = new THREE.Vector3(0, 0, 1);

/* Mock engine: just the final-pass uniforms Feel is allowed to touch. */
function mockEngine() {
  return {
    final: {
      uniforms: {
        uVignette: { value: 0.85 }, uExposure: { value: 1.0 },
        uFlash: { value: 0.0 }, uLetterbox: { value: 0.0 },
      },
    },
  };
}

function makeCam() { return new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 3000); }

function finiteCam(cam) {
  cam.updateMatrixWorld(true);
  const e = cam.matrixWorld.elements;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) return false;
  return Number.isFinite(cam.fov) && Number.isFinite(cam.position.x) &&
    Number.isFinite(cam.position.y) && Number.isFinite(cam.position.z) &&
    Number.isFinite(cam.quaternion.x) && Number.isFinite(cam.quaternion.w);
}

const LOOK = { lookX: 0, lookY: 0, zoom: 0 };
const look = (x = 0, y = 0, z = 0) => { LOOK.lookX = x; LOOK.lookY = y; LOOK.zoom = z; return LOOK; };

const _upv = new THREE.Vector3(), _rv = new THREE.Vector3(), _dirv = new THREE.Vector3();

/* ============================================================
   0 — CONTRACT
   ============================================================ */
head('0. CONTRACT — exports and signatures (docs/INTEGRATION-NOTES.md)');
{
  ok('CAM = {CHASE:0, HOOD:1, ORBIT:2}',
    CAM.CHASE === 0 && CAM.HOOD === 1 && CAM.ORBIT === 2,
    JSON.stringify(CAM));
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const feel = new Feel(rig, mockEngine());
  const sigs = [
    ['CameraRig#setMode', rig.setMode, 2], ['CameraRig#cycle', rig.cycle, 1],
    ['CameraRig#update', rig.update, 3], ['CameraRig#addShake', rig.addShake, 1],
    ['CameraRig#snapBehind', rig.snapBehind, 1],
    ['Feel#update', feel.update, 2], ['Feel#landing', feel.landing, 1],
    ['Feel#collision', feel.collision, 2], ['Feel#jump', feel.jump, 0],
    ['Feel#nearMiss', feel.nearMiss, 0], ['Feel#reset', feel.reset, 0],
  ];
  for (const [name, fn, arity] of sigs) {
    ok(`${name}(${arity} arg${arity === 1 ? '' : 's'}) exists`,
      typeof fn === 'function' && fn.length === arity,
      typeof fn === 'function' ? `arity ${fn.length}` : 'missing');
  }
  for (const p of ['fovScale', 'sens', 'invertY', 'autoCentre']) {
    ok(`CameraRig.${p} is a settings field`, p in rig, `= ${rig[p]}`);
  }
  ok('Feel.intensity master defaults to 1', feel.intensity === 1, `= ${feel.intensity}`);
  ok('CameraRig(camera, terrain) needs no vehicle to construct', rig.mode === CAM.CHASE);
}

/* ============================================================
   1 — THE STUNT
   ============================================================
   0–6 s   launch, straight, 0 → 38 m/s
   6–10 s  hard right, 18° of body slip held
   10 s    lip departure: 1.8 s ballistic arc
   ~11.8 s touchdown, hardHit 8
   →14 s   settle
   ============================================================ */
head('1. STUNT — accelerate → 18° drift → 1.8 s air → hardHit 8 landing');
const stunt = (terrain, mode = CAM.CHASE, capture = null) => {
  const cam = makeCam();
  const rig = new CameraRig(cam, terrain);
  const eng = mockEngine();
  const feel = new Feel(rig, eng);
  const v = new MockVehicle();
  v.pos.set(0, terrain.heightAt(0, 0) + 0.55, 0);
  rig.setMode(mode, v);
  rig.snapBehind(v);
  feel.reset();

  const R = {
    minClear: 1e9, maxDist: 0, minDist: 1e9, maxFov: -1e9, minFov: 1e9,
    maxStep: 0, maxStepT: 0, nan: false, frames: 0,
    landT: -1, vig: [0, 0], eyeH: [1e9, -1e9],
  };
  let t = 0, launched = false, landed = false;
  const prev = new THREE.Vector3().copy(cam.position);

  while (t < 14) {
    /* ---- script ---- */
    if (t < 6) {                                   // accelerate 0 → 38 m/s
      const sp = Math.min(38, 38 * (t / 5.2));
      v.heading = 0; v.steerNorm = 0;
      v.vel.set(Math.sin(v.heading) * sp, 0, Math.cos(v.heading) * sp);
      v._accelLong = 38 / 5.2; v._accelLat = 0;
    } else if (t < 10) {                           // hard right, 18° body slip
      const turn = 0.55 * (t - 6);                 // rad of travel heading swept
      const trav = turn;                           // velocity heading
      v.heading = trav + 18 * Math.PI / 180;       // nose 18° inside the slide
      v.steerNorm = 0.85;
      const sp = 30;
      v.vel.set(Math.sin(trav) * sp, 0, Math.cos(trav) * sp);
      v._accelLat = 0.55 * sp;                     // ω·v
      v.rollAng = -0.05;
    } else if (!launched) {                        // lip
      launched = true;
      v.airborne = true;
      v.vel.y = 1.8 * G / 2;                       // 1.8 s of hang at G = 12.8
      v.steerNorm = 0; v._accelLat = 0; v.rollAng = 0;
      feel.jump();
    }
    if (v.airborne) {
      v.pitchAng = Math.sin((t - 10) * 1.4) * 0.22;   // nose bobbing in the air
      if (v.vel.y < 0 && v.pos.y <= terrain.heightAt(v.pos.x, v.pos.z) + 0.55) {
        v.airborne = false; v.vel.y = 0; v.pitchAng = 0;
        v.pos.y = terrain.heightAt(v.pos.x, v.pos.z) + 0.55;
        landed = true; R.landT = t;
        feel.landing(8);
      }
    }
    v.step(DT, terrain);

    /* ---- rig ---- */
    feel.update(DT, v);
    rig.update(DT, v, look());
    t += DT; R.frames++;

    /* ---- measure ---- */
    if (!finiteCam(cam)) R.nan = true;
    const clear = cam.position.y - terrain.heightAt(cam.position.x, cam.position.z);
    if (clear < R.minClear) R.minClear = clear;
    const d = cam.position.distanceTo(v.pos);
    if (d > R.maxDist) R.maxDist = d;
    if (d < R.minDist) R.minDist = d;
    if (cam.fov > R.maxFov) R.maxFov = cam.fov;
    if (cam.fov < R.minFov) R.minFov = cam.fov;
    const step = cam.position.distanceTo(prev);
    if (step > R.maxStep) { R.maxStep = step; R.maxStepT = t; }
    prev.copy(cam.position);
    R.vig[0] = Math.min(R.vig[0] || 9, eng.final.uniforms.uVignette.value);
    R.vig[1] = Math.max(R.vig[1], eng.final.uniforms.uVignette.value);
    const eh = cam.position.y - v.pos.y;
    if (eh < R.eyeH[0]) R.eyeH[0] = eh;
    if (eh > R.eyeH[1]) R.eyeH[1] = eh;

    if (capture) capture(t, cam, v, eng);
  }
  R.landed = landed;
  return R;
};

{
  const R = stunt(flat);
  info(`frames ${R.frames}   landed at t=${f(R.landT)} s`);
  info(`clearance min ${f(R.minClear)} m   boom ${f(R.minDist)}–${f(R.maxDist)} m   FOV ${f(R.minFov)}–${f(R.maxFov)}°`);
  info(`eye height over car ${f(R.eyeH[0])}–${f(R.eyeH[1])} m   vignette ${f(R.vig[0], 3)}–${f(R.vig[1], 3)}`);
  info(`largest single-frame eye move ${f(R.maxStep, 3)} m at t=${f(R.maxStepT)} s (car does ${f(38 * DT, 3)} m)`);
  ok('script actually launched and landed', R.landed);
  ok('no NaN anywhere in the camera matrix', !R.nan);
  ok('camera stays >= 0.5 m above ground', R.minClear >= 0.5, `${f(R.minClear)} m`);
  ok('boom length inside 4.5–13 m envelope', R.minDist > 4.5 && R.maxDist < 13,
    `${f(R.minDist)}–${f(R.maxDist)} m`);
  ok('FOV inside 50–84° envelope', R.minFov > 50 && R.maxFov < 84, `${f(R.minFov)}–${f(R.maxFov)}°`);
  ok('vignette drives 0.85 → 1.0 and never leaves it',
    R.vig[0] >= 0.849 && R.vig[1] <= 1.001 && R.vig[1] > 0.93, `${f(R.vig[0], 3)}–${f(R.vig[1], 3)}`);
}

/* ============================================================
   2 — LANDING RECOVERY (no ringing)
   ============================================================ */
head('2. LANDING — springs settle, no oscillation after 0.8 s');
{
  // Measure the boom vector in the car's own frame. The car is still doing
  // 30 m/s after touchdown, so an absolute position never settles — what has to
  // settle is the camera's offset from the car.
  const samples = [];
  const rel = new THREE.Vector3();
  const R = stunt(flat, CAM.CHASE, (t, cam, v) => {
    rel.copy(cam.position).sub(v.pos);
    samples.push([t, rel.x, rel.y, rel.z]);
  });
  const t0 = R.landT + 0.8, t1 = R.landT + 2.0;
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const s of samples) {
    if (s[0] < t0 || s[0] > t1) continue;
    for (let i = 0; i < 3; i++) { if (s[i + 1] < lo[i]) lo[i] = s[i + 1]; if (s[i + 1] > hi[i]) hi[i] = s[i + 1]; }
  }
  const p2p = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // And the window that includes the impact itself, to prove there IS a
  // response — a camera that never moves also passes a settling test.
  let loA = 1e9, hiA = -1e9;
  for (const s of samples) {
    if (s[0] < R.landT || s[0] > R.landT + 0.6) continue;
    if (s[2] < loA) loA = s[2]; if (s[2] > hiA) hiA = s[2];
  }
  info(`boom p2p in [land+0.8, land+2.0]: x ${f(hi[0] - lo[0], 3)}  y ${f(hi[1] - lo[1], 3)}  z ${f(hi[2] - lo[2], 3)} m`);
  info(`vertical excursion during the first 0.6 s after impact: ${f(hiA - loA, 3)} m`);
  ok('no oscillation > 0.4 m p2p after 0.8 s', p2p < 0.4, `${f(p2p, 3)} m`);
  ok('the landing is actually visible (>4 cm of vertical travel)', hiA - loA > 0.04,
    `${f(hiA - loA, 3)} m`);
}

/* ============================================================
   3 — snapBehind
   ============================================================ */
head('3. snapBehind — hard reset lands within 5° of directly behind');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const v = new MockVehicle();
  let worst = 0, worstH = 0;
  for (const h of [0, 0.7, 1.9, -2.4, Math.PI, -0.3]) {
    v.heading = h; v.vel.set(0, 0, 0); v.pos.set(20, 0.55, -35);
    v.step(DT, flat);
    // Start from a deliberately wrong pose so the snap has work to do.
    rig.yaw = h + 2.6; rig._yawVel = 3; rig.lookYaw = 0.9; rig.shake = 1.2;
    rig.snapBehind(v);
    const dx = cam.position.x - v.pos.x, dz = cam.position.z - v.pos.z;
    const fw = v.forward;
    // Angle between "car → camera" and "straight astern".
    const a = Math.atan2(dx, dz), b = Math.atan2(-fw.x, -fw.z);
    let e = Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
    if (e > worst) { worst = e; worstH = h; }
  }
  info(`worst offset ${f(worst, 3)}° at heading ${f(worstH)} rad`);
  ok('within 5° of directly behind for every heading', worst < 5, `${f(worst, 3)}°`);
  ok('snapBehind zeroes the shake channel', rig.shake === 0, `${rig.shake}`);
  ok('snapBehind zeroes the yaw spring velocity', rig._yawVel === 0);
}

/* ============================================================
   4 — MODE SWITCHES
   ============================================================ */
head('4. MODES — a switch never teleports the eye more than 4 m in one frame');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const feel = new Feel(rig, mockEngine());
  const v = new MockVehicle();
  v.heading = 0.4; v.vel.set(Math.sin(0.4) * 30, 0, Math.cos(0.4) * 30);
  v.step(DT, flat);
  rig.snapBehind(v);

  const prev = new THREE.Vector3();
  let worst = 0, worstWhen = '';
  const order = [CAM.HOOD, CAM.ORBIT, CAM.CHASE, CAM.ORBIT, CAM.HOOD, CAM.CHASE];
  for (const m of order) {
    for (let i = 0; i < 40; i++) { v.step(DT, flat); feel.update(DT, v); rig.update(DT, v, look()); }
    prev.copy(cam.position);
    rig.setMode(m, v);
    v.step(DT, flat); feel.update(DT, v); rig.update(DT, v, look());
    const d = cam.position.distanceTo(prev);
    if (d > worst) { worst = d; worstWhen = `→ ${rig.modeName}`; }
    if (!finiteCam(cam)) ok(`mode ${rig.modeName} produced a finite matrix`, false);
  }
  info(`worst single-frame move across 6 switches: ${f(worst, 3)} m ${worstWhen}`);
  ok('no mode switch jumps > 4 m in one frame', worst < 4, `${f(worst, 3)} m`);

  // cycle() must visit all three and come home.
  const seen = new Set();
  rig.setMode(CAM.CHASE, v);
  for (let i = 0; i < 3; i++) { seen.add(rig.mode); rig.cycle(v); }
  ok('cycle() visits CHASE, HOOD and ORBIT', seen.size === 3 && rig.mode === CAM.CHASE,
    [...seen].join(','));

  // HOOD is a rigid mount: it must sit at the windshield, not somewhere near it.
  rig.setMode(CAM.HOOD, v);
  for (let i = 0; i < 60; i++) { v.step(DT, flat); feel.update(DT, v); rig.update(DT, v, look()); }
  const off = cam.position.distanceTo(v.pos);
  const want = Math.hypot(1.18, 0.55);
  // Residual is the continuous micro-shake, which is capped at 0.035 m by design.
  info(`hood mount offset ${f(off, 3)} m (spec (0, 1.18, 0.55) = ${f(want, 3)} m)`);
  ok('HOOD sits on the windshield mount', Math.abs(off - want) < 0.05, `${f(off, 3)} m`);
  ok('HOOD FOV is the 62° base + speed', cam.fov > 62 && cam.fov < 76, `${f(cam.fov)}°`);
}

/* ============================================================
   5 — TERRAIN AVOIDANCE
   ============================================================ */
head('5. TERRAIN — the boom climbs out of hills and settles back');
{
  const R = stunt(rolling);
  info(`rolling terrain: clearance min ${f(R.minClear)} m   boom ${f(R.minDist)}–${f(R.maxDist)} m`);
  ok('no NaN over rolling terrain', !R.nan);
  ok('camera stays >= 0.5 m above ground on hills', R.minClear >= 0.5, `${f(R.minClear)} m`);
  ok('avoidance never flings the boom past 15 m', R.maxDist < 15, `${f(R.maxDist)} m`);

  // A wall right behind the car: the eye must end up above it, not inside it.
  const cam = makeCam();
  const wall = { heightAt: (x, z) => (z < -2 ? 6 : 0) };
  const rig = new CameraRig(cam, wall);
  const v = new MockVehicle();
  v.heading = 0; v.vel.set(0, 0, 8); v.pos.set(0, 0.55, 0);
  v.step(DT, wall);
  rig.snapBehind(v);
  let minC = 1e9;
  for (let i = 0; i < 180; i++) {
    v.vel.set(0, 0, 8); v.pos.z = 0; v.step(DT, wall);
    rig.update(DT, v, look());
    minC = Math.min(minC, cam.position.y - wall.heightAt(cam.position.x, cam.position.z));
  }
  info(`6 m wall directly astern: eye at y=${f(cam.position.y)} m, clearance ${f(minC)} m`);
  ok('eye climbs over a 6 m wall behind the car', minC >= 0.5, `${f(minC)} m`);
}

/* ============================================================
   6 — LOOK / AUTO-CENTRE / ZOOM
   ============================================================ */
head('6. LOOK — manual orbit, auto-centre timing, zoom limits, invertY');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const v = new MockVehicle();
  v.vel.set(0, 0, 25); v.step(DT, flat);
  rig.snapBehind(v);

  for (let i = 0; i < 30; i++) { v.step(DT, flat); rig.update(DT, v, look(40, 0)); }
  const swung = rig.lookYaw;
  info(`30 frames of lookX=40 at sens 1.0 → ${f(swung * 180 / Math.PI, 1)}° of manual yaw`);
  ok('manual lookX swings the view', Math.abs(swung) > 0.05, `${f(swung, 3)} rad`);

  rig.autoCentre = 1;
  let t = 0; while (t < 2.4) { v.step(DT, flat); rig.update(DT, v, look()); t += DT; }
  const held = Math.abs(rig.lookYaw / swung);
  while (t < 6.0) { v.step(DT, flat); rig.update(DT, v, look()); t += DT; }
  const after = Math.abs(rig.lookYaw / swung);
  info(`autoCentre=1: ${f(held * 100, 0)}% still held at 2.4 s, ${f(after * 100, 0)}% at 6.0 s`);
  ok('autoCentre 1 holds the view through the 2.6 s delay', held > 0.95, `${f(held * 100, 0)}%`);
  ok('autoCentre 1 has recentred by 6 s', after < 0.12, `${f(after * 100, 0)}%`);

  rig.lookYaw = swung; rig.lookIdle = 0; rig.autoCentre = 2;
  t = 0; while (t < 2.4) { v.step(DT, flat); rig.update(DT, v, look()); t += DT; }
  const fast = Math.abs(rig.lookYaw / swung);
  info(`at the SAME 2.4 s mark: autoCentre 1 leaves ${f(held * 100, 0)}%, autoCentre 2 leaves ${f(fast * 100, 0)}%`);
  ok('autoCentre 2 is much faster than autoCentre 1', fast < 0.1 && fast < held * 0.5,
    `${f(fast * 100, 0)}% vs ${f(held * 100, 0)}%`);

  rig.lookYaw = 0.4; rig.autoCentre = 0;
  for (let i = 0; i < 600; i++) { v.step(DT, flat); rig.update(DT, v, look()); }
  ok('autoCentre 0 never recentres', Math.abs(rig.lookYaw - 0.4) < 1e-9, `${f(rig.lookYaw, 4)}`);

  rig.invertY = false; rig.lookPitch = 0;
  rig.update(DT, v, look(0, 100)); const up = rig.lookPitch;
  rig.invertY = true; rig.lookPitch = 0;
  rig.update(DT, v, look(0, 100)); const dn = rig.lookPitch;
  ok('invertY flips the pitch axis', up !== 0 && Math.abs(up + dn) < 1e-12, `${f(up, 4)} vs ${f(dn, 4)}`);

  for (let i = 0; i < 200; i++) rig.update(DT, v, look(0, 0, 1));
  const far = rig.dist;
  for (let i = 0; i < 400; i++) rig.update(DT, v, look(0, 0, -1));
  const near = rig.dist;
  info(`zoom clamps to ${f(near)}–${f(far)} m`);
  ok('zoom clamps to 5.2–11 m', Math.abs(far - 11) < 1e-6 && Math.abs(near - 5.2) < 1e-6,
    `${f(near)}–${f(far)}`);

  rig.sens = 2.0; rig.lookYaw = 0; rig.update(DT, v, look(40, 0));
  const s2 = rig.lookYaw; rig.sens = 1.0; rig.lookYaw = 0; rig.update(DT, v, look(40, 0));
  ok('sens scales the look rate linearly', Math.abs(s2 / rig.lookYaw - 2) < 1e-9,
    `${f(s2 / rig.lookYaw, 4)}×`);
}

/* ============================================================
   7 — DRIFT READ
   ============================================================ */
head('7. DRIFT — the boom follows travel, so a slide shows the car rotated');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const v = new MockVehicle();
  const slipDeg = 25, trav = 0.0;
  v.heading = trav + slipDeg * Math.PI / 180;
  v.vel.set(Math.sin(trav) * 28, 0, Math.cos(trav) * 28);
  v._accelLat = 12; v.steerNorm = 0.7;
  v.step(DT, flat); rig.snapBehind(v);
  for (let i = 0; i < 240; i++) { v.step(DT, flat); v.pos.x = 0; v.pos.z = 0; rig.update(DT, v, look()); }
  const yawErrTravel = Math.abs(((rig.yaw - trav + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  const yawErrNose = Math.abs(((rig.yaw - v.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  info(`held ${slipDeg}° of slip: boom is ${f(yawErrTravel, 2)}° off travel, ${f(yawErrNose, 2)}° off the nose`);
  ok('boom settles on the travel heading, not the nose',
    yawErrTravel < 3 && yawErrNose > slipDeg - 4, `${f(yawErrTravel, 2)}° / ${f(yawErrNose, 2)}°`);

  // Reversing must not swing the camera round to stare at the bonnet.
  v.heading = 0; v.vel.set(0, 0, -4); v._accelLat = 0; v.steerNorm = 0;
  v.step(DT, flat); rig.snapBehind(v);
  for (let i = 0; i < 240; i++) { v.step(DT, flat); v.pos.z = 0; rig.update(DT, v, look()); }
  const rev = Math.abs(((rig.yaw - 0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  info(`reversing at 4 m/s: boom is ${f(rev, 2)}° off the nose heading`);
  ok('reversing keeps the camera behind the car', rev < 5, `${f(rev, 2)}°`);
}

/* ============================================================
   8 — AIRBORNE
   ============================================================ */
head('8. AIRBORNE — boom eases out, FOV opens, horizon stays level, calm shake');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const feel = new Feel(rig, mockEngine());
  const v = new MockVehicle();
  v.heading = 0; v.vel.set(0, 0, 34); v.step(DT, flat); rig.snapBehind(v);
  for (let i = 0; i < 120; i++) { v.step(DT, flat); feel.update(DT, v); rig.update(DT, v, look()); }
  const groundDist = cam.position.distanceTo(v.pos), groundFov = cam.fov;
  const groundRumble = rig.rumble;

  v.airborne = true; v.vel.y = 1.8 * G / 2;
  let maxRoll = 0, airRumble = 0;
  for (let i = 0; i < 60; i++) {
    v.rollAng = 0.5; v.pitchAng = 0.3;           // car cartwheeling
    v.step(DT, flat); feel.update(DT, v); rig.update(DT, v, look());
    _upv.set(0, 1, 0).applyQuaternion(cam.quaternion);
    // Camera roll = how far its own right axis has left the horizontal plane.
    _rv.set(1, 0, 0).applyQuaternion(cam.quaternion);
    maxRoll = Math.max(maxRoll, Math.abs(Math.asin(Math.max(-1, Math.min(1, _rv.y)))) * 180 / Math.PI);
    airRumble = rig.rumble;
  }
  const airDist = cam.position.distanceTo(v.pos), airFov = cam.fov;
  info(`boom ${f(groundDist)} → ${f(airDist)} m   FOV ${f(groundFov)} → ${f(airFov)}°`);
  info(`continuous rumble ${f(groundRumble, 3)} on the ground → ${f(airRumble, 3)} in the air`);
  info(`peak camera roll with the car at 29° of body roll: ${f(maxRoll, 3)}°`);
  ok('boom eases out in the air', airDist > groundDist * 1.03, `${f(airDist / groundDist, 3)}×`);
  ok('FOV opens in the air', airFov > groundFov + 1.5, `+${f(airFov - groundFov)}°`);
  ok('horizon stays level (camera roll < 0.01°)', maxRoll < 0.01, `${f(maxRoll, 4)}°`);
  ok('continuous shake goes calm in the air', airRumble < groundRumble * 0.25,
    `${f(airRumble, 3)} vs ${f(groundRumble, 3)}`);
}


/* ============================================================
   9 — FEEL TRIGGERS
   ============================================================ */
head('9. FEEL — every trigger moves something, and nothing is left behind');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const eng = mockEngine();
  const feel = new Feel(rig, eng);
  const v = new MockVehicle();
  v.vel.set(0, 0, 20); v.step(DT, flat); rig.snapBehind(v); feel.reset();
  const U = eng.final.uniforms;

  // -- landing scales with hardHit
  feel.landing(2); const s2 = rig.shake; feel.reset();
  feel.landing(8); const s8 = rig.shake;
  info(`landing shake: hardHit 2 → ${f(s2, 3)},  hardHit 8 → ${f(s8, 3)} (cap 0.9)`);
  ok('landing shake ∝ hardHit, capped at 0.9', s8 > s2 && s8 <= 0.9001 && Math.abs(s8 - 0.72) < 0.01,
    `${f(s8, 3)}`);
  feel.update(DT, v);
  ok('a moderate landing dips exposure to 0.97', U.uExposure.value < 0.985 && U.uExposure.value >= 0.969,
    `${f(U.uExposure.value, 4)}`);
  ok('a heavy landing (>6) pops uFlash to 0.08', Math.abs(U.uFlash.value - 0.08) < 1e-9,
    `${f(U.uFlash.value, 3)}`);
  ok('the landing kick is nose-DOWN', rig.kickPitch < 0, `${f(rig.kickPitch * 180 / Math.PI, 3)}°`);
  feel.update(DT, v);
  ok('uFlash is a single frame', U.uFlash.value === 0);

  // -- kick decays inside 0.45 s
  const k0 = Math.abs(rig.kickPitch);
  let tt = 0; while (tt < 0.45) { feel.update(DT, v); tt += DT; }
  const k1 = Math.abs(rig.kickPitch);
  info(`pitch kick ${f(k0 * 180 / Math.PI, 3)}° → ${f(k1 * 180 / Math.PI, 3)}° after 0.45 s`);
  ok('pitch kick recovers in ~0.45 s', k1 < k0 * 0.06, `${f(k1 / k0 * 100, 1)}% left`);
  while (tt < 1.5) { feel.update(DT, v); tt += DT; }
  ok('exposure returns to 1.0', Math.abs(U.uExposure.value - 1) < 1e-9, `${f(U.uExposure.value, 4)}`);

  // -- collision is directional and pinches the FOV
  feel.reset();
  _dirv.set(1, 0, 0);                     // hit shoving the car along +X
  feel.collision(20, _dirv); feel.update(DT, v);
  const yawA = rig.kickYaw, fovA = rig.fovOffset;
  feel.reset();
  _dirv.set(-1, 0, 0);
  feel.collision(20, _dirv); feel.update(DT, v);
  const yawB = rig.kickYaw;
  info(`collision 20 m/s: shake ${f(rig.shake, 3)} (cap 1.1), yaw kick ±${f(Math.abs(yawA) * 180 / Math.PI, 3)}°, FOV ${f(fovA)}°`);
  ok('collision shake ∝ impact, capped at 1.1', rig.shake > 0.5 && rig.shake <= 1.1001, `${f(rig.shake, 3)}`);
  ok('collision kick is directional (opposite hits, opposite kicks)',
    yawA * yawB < 0 && Math.abs(yawA + yawB) < 1e-9, `${f(yawA, 4)} / ${f(yawB, 4)}`);
  ok('collision pinches the FOV by ~2°', fovA < -1.5 && fovA >= -2.001, `${f(fovA, 3)}°`);
  feel.reset();
  feel.collision(200, null);
  ok('an absurd impact still respects the 1.1 cap', rig.shake <= 1.1001, `${f(rig.shake, 3)}`);

  // -- jump anticipation lifts, then goes away
  feel.reset(); feel.jump();
  let peak = 0; tt = 0;
  // Envelope is jumpIn (0.10 s) + jumpOut (0.40 s); give it 0.60 s to settle.
  while (tt < 0.60) { feel.update(DT, v); peak = Math.max(peak, rig.kickPitch); tt += DT; }
  info(`jump anticipation peak ${f(peak * 180 / Math.PI, 3)}° (spec 1.2°), settled at ${f(rig.kickPitch, 6)}`);
  ok('jump() lifts the nose ~1.2° and returns',
    peak > 1.10 * Math.PI / 180 && peak <= 1.201 * Math.PI / 180 && rig.kickPitch === 0,
    `${f(peak * 180 / Math.PI, 3)}°`);

  // -- near miss
  feel.reset(); feel.nearMiss(); feel.update(DT, v);
  const nm = rig.fovOffset;
  tt = 0; while (tt < 0.12) { feel.update(DT, v); tt += DT; }
  info(`near-miss pulse ${f(nm, 3)}° → ${f(rig.fovOffset, 3)}° after 0.12 s`);
  ok('nearMiss() pulses +1.5° FOV for ~90 ms', nm > 1.0 && nm <= 1.501 && rig.fovOffset === 0, `${f(nm, 3)}°`);

  // -- intensity master
  feel.reset(); feel.intensity = 0; feel.landing(8); feel.jump();
  for (let i = 0; i < 10; i++) feel.update(DT, v);
  ok('Feel.intensity = 0 silences everything',
    rig.shake === 0 && rig.kickPitch === 0 && rig.rumble === 0,
    `shake ${f(rig.shake, 3)} kick ${f(rig.kickPitch, 4)}`);
  feel.intensity = 1;

  // -- reset hands the post-process back exactly as engine.js left it
  feel.landing(9); feel.collision(15, null); feel.nearMiss(); feel.update(DT, v);
  feel.reset();
  ok('reset() restores uVignette 0.85 / uExposure 1 / uFlash 0',
    U.uVignette.value === 0.85 && U.uExposure.value === 1 && U.uFlash.value === 0,
    `${f(U.uVignette.value, 3)} / ${f(U.uExposure.value, 3)} / ${f(U.uFlash.value, 3)}`);
  ok('reset() clears every rig transient',
    rig.shake === 0 && rig.kickPitch === 0 && rig.kickYaw === 0 && rig.fovOffset === 0 &&
    rig.rumble === 0 && rig.sway === 0);

  // -- no engine at all
  const bare = new Feel(rig, null);
  bare.landing(9); bare.collision(9, null); bare.jump(); bare.nearMiss();
  bare.update(DT, v); bare.reset();
  ok('Feel survives a null engine (menus, headless)', true);
  const halfBuilt = new Feel(rig, {});
  halfBuilt.update(DT, v);
  ok('Feel survives engine.final being absent (composer rebuild)', true);
}


/* ============================================================
   10 — ROBUSTNESS
   ============================================================ */
head('10. ROBUSTNESS — pathological dt, stationary car, vertical car, no look');
{
  const cam = makeCam();
  const rig = new CameraRig(cam, flat);
  const feel = new Feel(rig, mockEngine());
  const v = new MockVehicle();
  v.step(DT, flat); rig.snapBehind(v);
  let bad = false;
  for (const d of [0, -1, 1e-6, 0.5, 2.0, NaN, 1 / 240, 1 / 20]) {
    v.step(1 / 60, flat);
    feel.update(d, v); rig.update(d, v, null);
    if (!finiteCam(cam)) bad = true;
  }
  ok('pathological dt (0, negative, 2 s, NaN) never produces a NaN pose', !bad);

  // Parked: nothing to derive a heading from.
  v.vel.set(0, 0, 0); v.heading = 1.1;
  for (let i = 0; i < 300; i++) { v.step(DT, flat); rig.update(DT, v, look()); }
  ok('a parked car holds a stable pose', finiteCam(cam) &&
    Math.abs(cam.position.distanceTo(v.pos) - 7.6) < 1.5,
    `boom ${f(cam.position.distanceTo(v.pos))} m`);

  // Nose straight up: forward has no horizontal component at all.
  v.pitchAng = Math.PI / 2; v.vel.set(0, 12, 0); v.airborne = true;
  for (let i = 0; i < 90; i++) { v.step(DT, flat); rig.update(DT, v, look()); }
  ok('a vertical car does not divide by zero', finiteCam(cam));

  // update() with no vehicle must be a no-op, not a throw.
  const before = cam.position.x;
  rig.update(DT, null, look());
  ok('update(dt, null) is a safe no-op', cam.position.x === before);
}

/* ============================================================
   11 — ALLOCATION AUDIT
   ============================================================
   Two gates, because neither alone is worth much:

   (a) STATIC. Modern V8 boxes every double stored into an object property, so
       `heapUsed` climbs even in code that allocates no objects at all — Vector3
       .set() alone charges three HeapNumbers. Measuring bytes therefore cannot
       tell our code apart from three.js's, and the rule in ARCHITECTURE.md is
       about objects: no `new`, no clone, no literals, no closures in a hot
       path. That is a source property, so it is checked in the source.
   (b) RETAINED. A real leak — anything pushed onto a list and never dropped —
       does survive a collection, and that is what the heap number can see.
   ============================================================ */
head('11. ALLOCATION — no objects built per frame, nothing retained');
{
  const src = {
    'camera.js': readFileSync(new URL('../src/game/camera.js', import.meta.url), 'utf8'),
    'feel.js': readFileSync(new URL('../src/game/feel.js', import.meta.url), 'utf8'),
  };
  // Blank out every comment while preserving line numbers, so prose that talks
  // ABOUT allocation is not mistaken for allocation.
  const decomment = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, raw] of Object.entries(src)) {
    const lines = decomment(raw).split('\n');
    // `new` is legal in the constructor and in the module scratch block; nowhere else.
    let inCtor = false, scratchAt = 1e9;
    raw.split('\n').forEach((l, i) => { if (scratchAt === 1e9 && /scratch \*\//.test(l)) scratchAt = i; });
    const bad = [];
    lines.forEach((l, i) => {
      if (/^\s{2}constructor\s*\(/.test(l)) inCtor = true;
      else if (inCtor && /^\s{2}\}/.test(l)) inCtor = false;
      if (/\bnew\s+[A-Z]/.test(l) && !inCtor && i < scratchAt) bad.push(`${i + 1}: ${l.trim()}`);
    });
    ok(`${name}: 'new' only in the constructor and the scratch block`, bad.length === 0,
      bad.length ? bad[0] : 'clean');
    for (const [what, re] of [
      ['.clone()', /\.clone\s*\(/], ['array literal return', /return\s*\[/],
      ['.push(', /\.push\s*\(/], ['.map(/.filter(', /\.(map|filter|forEach)\s*\(/],
      ['closure (=>)', /=>/], ['JSON./Object.assign', /JSON\.|Object\.assign/],
    ]) {
      const hit = lines.findIndex((l) => re.test(l));
      ok(`${name}: no ${what}`, hit < 0, hit < 0 ? 'clean' : `line ${hit + 1}`);
    }
  }

  const cam = makeCam();
  const rig = new CameraRig(cam, rolling);
  const feel = new Feel(rig, mockEngine());
  const v = new MockVehicle();
  v.vel.set(0, 0, 30); v.step(DT, rolling); rig.snapBehind(v);
  for (let i = 0; i < 20000; i++) { v.pos.set(0, 0.55, 0); v.step(DT, rolling); feel.update(DT, v); rig.update(DT, v, look(0, 0, 0)); }
  const N = 500000;
  const settle = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
  if (!global.gc) {
    info('retained-heap gate skipped: re-run with --expose-gc to enable it');
    info('  node --expose-gc --experimental-loader ./dev/loader.mjs dev/camera-check.mjs');
  } else {
    const a = settle();
    for (let i = 0; i < N; i++) { v.pos.set(0, 0.55, 0); v.step(DT, rolling); feel.update(DT, v); rig.update(DT, v, look(0, 0, 0)); }
    const d = settle() - a;
    info(`retained heap after ${N / 1000} k frames: ${f(d / 1024, 1)} kB (a 1-object-per-frame leak would be > 25 MB)`);
    ok('nothing retained across 500 k frames', Math.abs(d) < 512 * 1024, `${f(d / 1024, 1)} kB`);
  }
}

/* ============================================================ */
console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);

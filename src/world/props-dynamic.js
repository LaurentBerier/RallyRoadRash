/* ============================================================
   PROPS THAT GIVE WAY
   ------------------------------------------------------------
   A pine beside the road is one matrix inside an InstancedMesh and one
   circle in the broad-phase grid. That is the correct way to pay for two
   thousand of them, and it is why hitting one has always been a hard stop:
   there was nothing there to push.

   This file is the other half of the prop's life. It costs nothing while a
   prop is scenery, and it is only entered when something hits one hard
   enough that stopping dead would be the wrong answer:

     STATIC     the instance's matrix is whatever buildScatter wrote, its
                collider is in the grid, and nothing in here runs. This is
                every prop, almost all of the time.
     LIVE       a body has been woken in the pool. It carries the prop's
                position, orientation and scale, integrates under gravity,
                lands on the terrain, and rewrites exactly one matrix per
                frame. Its collider is flagged `awake` and resolve() skips it
                in a single branch — it is debris now, not an obstacle.
     ASLEEP     it stopped moving. The matrix stays where it fell, the
                collider stays skipped, and the body's slot is handed back.

   THE MASS RULE is the whole design, and it lives in dynHit(): a prop yields
   when its mass is under TUNE.props.massRatio of the machine's. Return false
   and props.js falls through to the hard stop it has always had, byte for
   byte. So a 1680 kg ridgeback goes through a 210 kg pine, and a 245 kg
   motocross — capped at 73.5 kg — does not. Nobody had to write "if bike".

   Everything is preallocated: eighteen typed arrays and three fixed object
   arrays, sized once at TUNE.props.poolSize. Nothing in here allocates after
   construction, because dynHit is reached from resolve() and resolve() runs
   six times a frame per car.

   The contact model is TUNE.collide's — restitution, friction, spinFactor,
   maxDeltaV. A prop and a rival car are the same problem and there is no
   reason for two answers to it.
   ============================================================ */
import * as THREE from 'three';
import { G, TUNE } from '../game/config.js';
import { PROP_MASS_KG } from './props-recipes.js';
import { hash2 } from './props-shapes.js';

/* ---------------- module scratch (no per-frame allocation) ---------------- */
const _m4 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _n3 = new THREE.Vector3();
const _r3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _col = [0, 0, 0];            // dust.burst wants a colour triple, not three args

/** Slot states. Exported so dev/props-check.mjs can read them by name. */
export const DYN_STATE = { FREE: 0, LIVE: 1, ASLEEP: 2 };
const { FREE, LIVE, ASLEEP } = DYN_STATE;

/* Below this closing speed nothing is knocked over. Leaning on a tree at
   walking pace has to hold you up, or a car nudged into the verge quietly
   flattens the scenery and the pool churns for no visible reason. */
const KNOCK_MIN = 1.5;             // m/s

/* A knocked prop's speed is capped so a 40 m/s hit does not fire a hay bale
   over the horizon. Momentum says it should; an arcade racer says no. */
const MAX_PROP_SPEED = 22;         // m/s

/* The vehicle's collider is a CIRCLE, so a contact arm along the normal is
   radial and can never twist the car — which is precisely why resolve() has
   to fake its yaw nudge with a hash. Stretching the arm along the body's own
   long axis puts the contact roughly where the bodywork is, so clipping a
   tree with a corner twists you and hitting one square on does not. 1.8 is
   about the length/width ratio of the four bodies. */
const ARM_LONG = 1.8;

/* Ground behaviour. The scrub is a RATE, not a per-contact multiplier: a
   felled tree resting on the terrain touches every frame, and 0.45 taken off
   per frame would stop it in three of them, which reads as landing in glue. */
const GROUND_SCRUB = 8.0;          // multiplies TUNE.collide.friction, per second. High
                                   //   on purpose: a felled tree lies along its whole
                                   //   length, it does not balance on a point, and one
                                   //   that skates for three seconds reads as ice
const AIR_ANG_DAMP = 0.8;          // 1/s
const GROUND_ANG_DAMP = 6.0;       // 1/s — mirrors TUNE.sim.hullAngDamp, same reason
const BOUNCE_STOP = 0.5;           // m/s of rebound below which it just stays down
const SLEEP_SPIN = 0.5;            // rad/s — a body still turning is not asleep

/* Leaf and bark for anything that grows, grit and orange for anything a
   promoter put there. At 40 m/s the colour of what comes off is the only
   part of the hit a player actually reads. */
const VEGETATION = new Set([
  'pine0', 'pine1', 'pine2', 'broadleaf', 'snag',
  'cactus0', 'cactus1', 'agave', 'bush0',
]);

/**
 * Preallocate the whole feature.
 *
 * @param {object} props   the Props instance — the pool reads `terrain`,
 *                         `scatterMeshes`, `_dressMeshById`, `vfx` and `dust`
 *                         off it, all of them late and all of them guarded.
 * @param {number} [maxBodies]
 */
export function createDynamicPool(props, maxBodies = TUNE.props.poolSize) {
  const n = Math.max(1, maxBodies | 0);
  const f32 = () => new Float32Array(n);
  const pool = {
    props, n, live: 0,
    /* position, velocity, orientation, spin, scale — flat, one array each, so
       the step loop never touches an object it did not have to. */
    px: f32(), py: f32(), pz: f32(),
    vx: f32(), vy: f32(), vz: f32(),
    qx: f32(), qy: f32(), qz: f32(), qw: f32(),
    wx: f32(), wy: f32(), wz: f32(),
    sx: f32(), sy: f32(), sz: f32(),
    still: f32(),                          // s spent continuously under sleepSpeed
    state: new Uint8Array(n),              // FREE | LIVE | ASLEEP
    ii: new Int32Array(n),                 // instance index inside its mesh, -1 = a Group
    /* The rest pose, so anything knocked over can be stood back up: sixteen
       floats of the original instance matrix, or x/y/z/yaw in the first four
       for a sign, which is a Group and has no instance matrix. */
    rest: new Float32Array(n * 16),
    mesh: new Array(n).fill(null),         // InstancedMesh this body writes into
    obj: new Array(n).fill(null),          // …or the Group, for a sign
    col: new Array(n).fill(null),          // the collider whose `awake` flag we own
    free: new Int32Array(n),
    nFree: n,
    /* Target resolution writes here instead of returning an object. */
    _tMesh: null, _tObj: null, _tIdx: -1,
  };
  for (let i = 0; i < n; i++) pool.free[i] = n - 1 - i;
  return pool;
}

/**
 * Something hit a prop. Decide whether the prop moves.
 *
 * @param {object} pool
 * @param {object} c        the collider — carries `kind` and the back-reference
 *                          props.js stamped on it (`vi`, `i`, `obj`)
 * @param {object} v        the vehicle: mass, vel, omega, quat, collideR, applyImpulse
 * @param {number} nx,nz    unit contact normal, prop centre → vehicle
 * @param {number} closing  m/s the vehicle is closing along that normal
 * @returns {boolean} true if the prop gave way and the caller must NOT push out
 */
export function dynHit(pool, c, v, nx, nz, closing) {
  if (!pool || !c) return false;
  const T = TUNE.props;
  /* The mass rule, and the only place it is stated. Written as `<=` on the
     positive side so an Infinity mass — an id with no entry in the table —
     fails closed and keeps today's hard stop. */
  const pm = PROP_MASS_KG(c.kind);
  if (!(pm <= T.massRatio * v.mass)) return false;
  if (!(closing > KNOCK_MIN)) return false;

  if (!_resolveTarget(pool, c)) return false;   // hidden by the quality tier: nothing to move
  const b = _claim(pool, v.pos.x, v.pos.z);
  if (b < 0) return false;                      // every slot live: hard stop, no drama

  /* ---- seed the body from wherever the prop is standing right now ---- */
  const o16 = b * 16;
  const rest = pool.rest;
  if (pool._tObj) {
    const g = pool._tObj;
    rest[o16] = g.position.x; rest[o16 + 1] = g.position.y; rest[o16 + 2] = g.position.z;
    rest[o16 + 3] = g.rotation.y;
    _p.copy(g.position); _q.copy(g.quaternion); _s.set(1, 1, 1);
    pool.mesh[b] = null; pool.obj[b] = g; pool.ii[b] = -1;
  } else {
    const arr = pool._tMesh.instanceMatrix.array, o = pool._tIdx * 16;
    for (let k = 0; k < 16; k++) rest[o16 + k] = arr[o + k];
    _m4.fromArray(arr, o);
    _m4.decompose(_p, _q, _s);
    pool.mesh[b] = pool._tMesh; pool.obj[b] = null; pool.ii[b] = pool._tIdx;
  }
  pool.px[b] = _p.x; pool.py[b] = _p.y; pool.pz[b] = _p.z;
  pool.qx[b] = _q.x; pool.qy[b] = _q.y; pool.qz[b] = _q.z; pool.qw[b] = _q.w;
  pool.sx[b] = _s.x; pool.sy[b] = _s.y; pool.sz[b] = _s.z;

  /* ---- what the prop does ----
     It leaves along the hit direction (−n), lifted, and turning about the
     horizontal axis that topples it that way: up × travel. The wobble on the
     other two axes is a hash of the contact point, not Math.random() — the
     tumble is cosmetic but the collider's `awake` flag is not, and qa-drive
     compares lap times between builds. */
  const speed = Math.min(T.transferFrac * closing, MAX_PROP_SPEED);
  pool.vx[b] = -nx * speed;
  pool.vz[b] = -nz * speed;
  pool.vy[b] = T.popUp * Math.min(1.6, Math.max(0.35, closing / 8));
  const spin = Math.min(7.5, 0.55 + closing * 0.20);
  const h1 = hash2(c.x, c.z) - 0.5, h2 = hash2(c.z, c.x) - 0.5;
  pool.wx[b] = -nz * spin + h1 * spin * 0.35;
  pool.wy[b] = h2 * spin * 0.5;
  pool.wz[b] = nx * spin + h1 * spin * 0.35;
  pool.still[b] = 0;
  pool.col[b] = c;
  pool.state[b] = LIVE;
  pool.live++;
  c.awake = 1;

  /* ---- and what the machine gets back ----
     A reduced counter-impulse, sized by the momentum actually transferred, so
     going through a tree costs speed without costing the race. Through the one
     public impulse door on Vehicle, which is the only one that carries the
     body-frame inertia — the plain fallback exists so a headless mock vehicle
     can still be driven into a prop. */
  const R0 = v.collideR || 1.15;
  let j = T.transferFrac * pm * closing;
  const jCap = TUNE.collide.maxDeltaV * v.mass;
  if (j > jCap) j = jCap;
  if (v.applyImpulse) {
    _n3.set(nx, 0, nz);
    _r3.set(-nx * R0, 0, -nz * R0);
    if (v.quat) {
      _fwd.set(0, 0, 1).applyQuaternion(v.quat);
      const fl = Math.hypot(_fwd.x, _fwd.z);
      if (fl > 1e-4) {
        const fx = _fwd.x / fl, fz = _fwd.z / fl;
        const along = _r3.x * fx + _r3.z * fz;
        _r3.x += fx * along * (ARM_LONG - 1);
        _r3.z += fz * along * (ARM_LONG - 1);
      }
    }
    // scaling the ARM scales the torque and leaves the linear impulse alone,
    // which is exactly what spinFactor is for on the car-to-car path
    _r3.multiplyScalar(TUNE.collide.spinFactor);
    v.applyImpulse(_n3, j, _r3);
  } else {
    const dv = j / v.mass;
    v.vel.x += nx * dv; v.vel.z += nz * dv;
  }

  _knockFx(pool.props, c, nx, nz, closing);
  return true;
}

/**
 * Advance every live body. Returns immediately when nothing is moving, which
 * is the state the stage is in for all but a second or two of a race.
 */
export function stepDynamicPool(pool, dt, terrain) {
  if (!pool || pool.live <= 0 || !(dt > 0)) return;
  const T = TUNE.props, C = TUNE.collide;
  const gnd = terrain || pool.props.terrain;
  const sleepV2 = T.sleepSpeed * T.sleepSpeed;
  const airK = Math.max(0, 1 - AIR_ANG_DAMP * dt);
  const gndK = Math.max(0, 1 - GROUND_ANG_DAMP * dt);
  const scrub = Math.max(0, 1 - C.friction * GROUND_SCRUB * dt);

  for (let b = 0; b < pool.n; b++) {
    if (pool.state[b] !== LIVE) continue;

    let vx = pool.vx[b], vy = pool.vy[b] - G * dt, vz = pool.vz[b];
    let px = pool.px[b] + vx * dt, py = pool.py[b] + vy * dt, pz = pool.pz[b] + vz * dt;

    /* A body that has gone non-finite is a bug somewhere upstream, and the
       cheapest place to stop it hurting anybody is here: stand the prop back
       up and free the slot rather than write NaN into an instance matrix,
       which takes the whole InstancedMesh off screen. */
    if (!(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz))) {
      _restore(pool, b);
      pool.free[pool.nFree++] = b;
      pool.state[b] = FREE;
      pool.live--;
      continue;
    }

    const h = gnd ? gnd.heightAt(px, pz) : 0;
    let grounded = false;
    if (py <= h) {
      py = h;
      grounded = true;
      if (vy < 0) {
        vy = -vy * C.restitution;
        if (vy < BOUNCE_STOP) vy = 0;
      }
      vx *= scrub; vz *= scrub;
    }

    const k = grounded ? gndK : airK;
    let wx = pool.wx[b] * k, wy = pool.wy[b] * k, wz = pool.wz[b] * k;

    /* q += 0.5 · ω ⊗ q, then renormalise. Explicit, because a Quaternion
       object per body per frame is exactly the allocation this file exists to
       avoid. */
    const hx = wx * dt * 0.5, hy = wy * dt * 0.5, hz = wz * dt * 0.5;
    const qx = pool.qx[b], qy = pool.qy[b], qz = pool.qz[b], qw = pool.qw[b];
    let nqx = qx + (hx * qw + hy * qz - hz * qy);
    let nqy = qy + (hy * qw + hz * qx - hx * qz);
    let nqz = qz + (hz * qw + hx * qy - hy * qx);
    let nqw = qw + (-hx * qx - hy * qy - hz * qz);
    const ql = Math.sqrt(nqx * nqx + nqy * nqy + nqz * nqz + nqw * nqw);
    if (ql > 1e-6) { nqx /= ql; nqy /= ql; nqz /= ql; nqw /= ql; }
    else { nqx = 0; nqy = 0; nqz = 0; nqw = 1; }

    pool.px[b] = px; pool.py[b] = py; pool.pz[b] = pz;
    pool.vx[b] = vx; pool.vy[b] = vy; pool.vz[b] = vz;
    pool.wx[b] = wx; pool.wy[b] = wy; pool.wz[b] = wz;
    pool.qx[b] = nqx; pool.qy[b] = nqy; pool.qz[b] = nqz; pool.qw[b] = nqw;

    _p.set(px, py, pz);
    _q.set(nqx, nqy, nqz, nqw);
    const m = pool.mesh[b];
    if (m) {
      _s.set(pool.sx[b], pool.sy[b], pool.sz[b]);
      _m4.compose(_p, _q, _s);
      m.setMatrixAt(pool.ii[b], _m4);
      // only the meshes with a live body in them are ever marked, which is the
      // same discipline _bobCrowd uses on the spectators
      m.instanceMatrix.needsUpdate = true;
    } else {
      const g = pool.obj[b];
      if (g) { g.position.set(px, py, pz); g.quaternion.set(nqx, nqy, nqz, nqw); }
    }

    const v2 = vx * vx + vy * vy + vz * vz;
    const w2 = wx * wx + wy * wy + wz * wz;
    if (grounded && v2 < sleepV2 && w2 < SLEEP_SPIN * SLEEP_SPIN) {
      pool.still[b] += dt;
      if (pool.still[b] >= T.sleepTime) {
        /* Asleep, not gone: the matrix stays exactly where it fell and the
           collider stays flagged, so a felled pine is something you drive
           over rather than something that stands back up behind you. The SLOT
           goes back on the free list — _claim() will restore this prop only if
           it ever needs the slot again. */
        pool.vx[b] = 0; pool.vy[b] = 0; pool.vz[b] = 0;
        pool.wx[b] = 0; pool.wy[b] = 0; pool.wz[b] = 0;
        pool.state[b] = ASLEEP;
        pool.live--;
      }
    } else {
      pool.still[b] = 0;
    }
  }
}

/**
 * Stand everything back up. Called when the collider list is about to be
 * rebuilt — a quality-tier change re-derives this.colliders from scratch, and
 * a body still animating an instance the new tier hides would write matrices
 * into nothing and leave its `awake` flag on a collider that no longer exists.
 */
export function resetDynamicPool(pool) {
  if (!pool) return;
  for (let b = 0; b < pool.n; b++) {
    if (pool.state[b] === FREE) continue;
    _restore(pool, b);
    pool.state[b] = FREE;
  }
  for (let i = 0; i < pool.n; i++) pool.free[i] = pool.n - 1 - i;
  pool.nFree = pool.n;
  pool.live = 0;
}

/* ---------------- internals ---------------- */

/**
 * Which mesh and which instance does this collider stand for? Writes into pool
 * scratch instead of returning a record, because this is on the hit path.
 *
 * Three populations, one answer: `obj` set means a sign, which is its own
 * Group and can simply be transformed; `vi >= 0` means scatter; otherwise it
 * is dressing, found by id. An instance past its mesh's current `count` is
 * hidden by the quality tier — there is nothing on screen to knock over, so
 * the caller falls through to the hard stop rather than animating a ghost.
 */
function _resolveTarget(pool, c) {
  pool._tMesh = null; pool._tObj = null; pool._tIdx = -1;
  if (c.obj) { pool._tObj = c.obj; return true; }
  const P = pool.props;
  let m = null;
  if (c.vi >= 0) {
    const list = P.scatterMeshes;
    m = list ? list[c.vi] : null;
  } else {
    m = P._dressMeshById ? P._dressMeshById.get(c.kind) : null;
  }
  if (!m || !(c.i >= 0) || c.i >= m.count) return false;
  pool._tMesh = m; pool._tIdx = c.i;
  return true;
}

/**
 * A slot, or -1. A full pool recycles the SLEEPING body furthest from the
 * incident: it is the one least likely to be in shot when its prop stands
 * back up, and a tree a lap behind you popping upright is a smaller lie than
 * the truck in front of you hitting a wall. Nothing live is ever stolen.
 */
function _claim(pool, x, z) {
  if (pool.nFree > 0) return pool.free[--pool.nFree];
  let best = -1, bestD = -1;
  for (let b = 0; b < pool.n; b++) {
    if (pool.state[b] !== ASLEEP) continue;
    const dx = pool.px[b] - x, dz = pool.pz[b] - z;
    const d = dx * dx + dz * dz;
    if (d > bestD) { bestD = d; best = b; }
  }
  if (best < 0) return -1;
  _restore(pool, best);
  return best;
}

/** Put one prop back where it was built, and make it solid again. */
function _restore(pool, b) {
  const rest = pool.rest, o16 = b * 16;
  const m = pool.mesh[b];
  if (m) {
    _m4.fromArray(rest, o16);
    if (pool.ii[b] >= 0 && pool.ii[b] < m.count) {
      m.setMatrixAt(pool.ii[b], _m4);
      m.instanceMatrix.needsUpdate = true;
    }
  } else {
    const g = pool.obj[b];
    if (g) {
      g.position.set(rest[o16], rest[o16 + 1], rest[o16 + 2]);
      g.rotation.set(0, rest[o16 + 3], 0);
    }
  }
  const c = pool.col[b];
  if (c) c.awake = 0;
  pool.mesh[b] = null; pool.obj[b] = null; pool.col[b] = null;
  pool.ii[b] = -1;
  pool.still[b] = 0;
}

/**
 * What comes off the prop. Both systems stay optional and both calls are
 * guarded — props has to collide correctly in a harness that made neither.
 */
function _knockFx(props, c, nx, nz, closing) {
  if (!props.dust && !props.vfx) return;
  const gy = props.terrain ? props.terrain.heightAt(c.x, c.z) : 0;
  const veg = VEGETATION.has(c.kind);
  if (props.dust) {
    // heading is where the debris is THROWN: away from the car, along −n
    _col[0] = veg ? 0.30 : 0.52;
    _col[1] = veg ? 0.34 : 0.49;
    _col[2] = veg ? 0.18 : 0.45;
    props.dust.burst(c.x, gy + 0.35, c.z, Math.atan2(-nx, -nz),
      Math.min(2.6, 0.55 + closing * 0.07), _col);
  }
  if (props.vfx) {
    // splinters and leaves travel WITH the hit; grit off steel goes up and out
    props.vfx.sparks(veg ? 12 : 16, c.x, gy + 0.6 + c.r, c.z,
      -nx, 0.55, -nz, Math.min(16, 4 + closing * 0.45), 0.70,
      veg ? 0.36 : 1.25, veg ? 0.44 : 0.72, veg ? 0.20 : 0.24,
      veg ? 0.55 : 0.40);
  }
}

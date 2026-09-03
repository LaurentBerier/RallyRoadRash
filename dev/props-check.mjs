/* ============================================================
   RALLY ROAD RASH — props that give way
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/props-check.mjs

   props.js needs a canvas, a scene and a baked terrain, so the placement half
   of the prop layer can only be checked by looking at it. The PHYSICS half
   cannot — it is a mass table, a comparison, and a fixed-size integrator over
   typed arrays — so it is checked here, where a regression costs milliseconds
   instead of a screenshot nobody took.

   What is actually being asserted, and why each one matters:

     • THE TABLE IS COMPLETE. A dynamic kind with no mass on file falls back to
       Infinity and quietly keeps its hard stop, which looks exactly like the
       feature not being finished. And a kind that no stage places, or whose id
       resolves to no geometry, is dead weight nobody will ever notice.

     • THE TABLE IS IN RANGE. Nothing may reach massRatio × 1680 kg, or it is
       immovable for the whole grid and belongs in the immovable set where a
       reader can find it. Something must exceed massRatio × 245 kg, or the
       bike never stops at anything and "a motocross would stop" is a comment
       rather than a behaviour.

     • THE RULE IS MONOTONIC. A heavier machine must never yield to FEWER
       kinds than a lighter one. This is the whole promise of expressing the
       feature as one comparison instead of four vehicle special cases, and it
       is checked through dynHit() rather than by re-deriving the arithmetic.

     • THE INTEGRATOR TERMINATES. A woken body must land, stop, and be marked
       asleep — without ever producing a NaN, because a NaN in an instance
       matrix does not draw a broken tree, it takes the entire InstancedMesh
       off screen and the stage loses two thousand props at once.

     • THE POOL NEVER LOSES A PROP. Every collider flagged `awake` must be
       owned by an occupied slot, at every point, including when the pool is
       full and recycling. A leaked flag is a prop you can drive through
       forever, and it is invisible until somebody drives at it.

     • IT IS DETERMINISTIC. dev/qa-drive.js compares lap times between builds.
       A prop that lands somewhere different on the second run is exactly the
       kind of noise that hides a real regression.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { TUNE } from '../src/game/config.js';
import { VEHICLES } from '../src/game/vehicles.js';
import {
  RECIPES, DRESSING, KIT_KINDS, DYNAMIC_KINDS, PROP_MASS_KG,
} from '../src/world/props-recipes.js';
import {
  createDynamicPool, dynHit, stepDynamicPool, resetDynamicPool, DYN_STATE,
} from '../src/world/props-dynamic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROPS_SRC = readFileSync(join(ROOT, 'src', 'world', 'props.js'), 'utf8');
const WASTE_SRC = readFileSync(join(ROOT, 'src', 'world', 'props-wasteland.js'), 'utf8');

/* ---------------- harness ---------------- */
let failures = 0, checks = 0;
const DT = 1 / 60;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

const T = TUNE.props;
const IDS = [...DYNAMIC_KINDS];
/* The four machines, read from the real table rather than retyped — the whole
   point of the mass rule is that it is graded against these. */
const MACHINES = VEHICLES.map(v => ({ id: v.id, mass: v.mass }))
  .sort((a, b) => a.mass - b.mass);

/* ---------------- mocks ----------------
   Flat ground, a real InstancedMesh (three works headless; only the RENDERER
   needs a canvas), and a vehicle that publishes exactly the five things the
   pool is contracted to read. */
const FLAT = { heightAt: () => 0 };

function makeStage(nInst = 6, kind = 'pine0') {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const im = new THREE.InstancedMesh(geo, mat, nInst);
  const m4 = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const colliders = [];
  for (let i = 0; i < nInst; i++) {
    p.set(i * 12, 0, 0);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.4);
    s.set(1.1, 1.3, 1.1);                       // non-uniform, like the real scatter
    m4.compose(p, q, s);
    im.setMatrixAt(i, m4);
    colliders.push({
      x: i * 12, z: 0, r: 0.55, kind, bounce: 1.15,
      awake: 0, vi: 0, i, obj: null,
    });
  }
  im.count = nInst;
  im.instanceMatrix.needsUpdate = false;
  const props = {
    terrain: FLAT, scatterMeshes: [im], _dressMeshById: new Map(),
    vfx: null, dust: null,
  };
  const rest = Float32Array.from(im.instanceMatrix.array);
  return { props, im, colliders, rest };
}

function makeVehicle(mass, speed = 20) {
  return {
    mass, collideR: 1.3,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(0, 0, speed),
    omega: new THREE.Vector3(), quat: new THREE.Quaternion(),
    _j: 0, _arm: 0,
    applyImpulse(n, j, r) {
      this.vel.addScaledVector(n, j / this.mass);
      this._j = j; this._arm = r.length();
      // a real Vehicle folds inertia in here; the mock only has to prove the
      // arm reaching it is non-degenerate for an off-centre hit
      this.omega.y += (r.x * n.z - r.z * n.x) * j / (this.mass * 4);
    },
  };
}

/** One knock, from a machine of `mass` closing at `closing` m/s. */
function knock(pool, c, mass, closing) {
  const v = makeVehicle(mass, closing);
  // normal points prop → vehicle; the car sits on +x of the prop closing in
  const nx = 1, nz = 0;
  v.pos.set(c.x + 2, 0, c.z);
  v.vel.set(-closing, 0, 0);
  v.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);   // off-axis: a clipped hit
  return { hit: dynHit(pool, c, v, nx, nz, closing), v };
}

/** Step until every body is asleep, or the clock runs out. Returns seconds. */
function settle(pool, limit = 6) {
  let t = 0;
  while (pool.live > 0 && t < limit) { stepDynamicPool(pool, DT, FLAT); t += DT; }
  return t;
}

function occupied(pool) {
  let n = 0;
  for (let b = 0; b < pool.n; b++) if (pool.state[b] !== DYN_STATE.FREE) n++;
  return n;
}
const awakeCount = (cols) => cols.reduce((a, c) => a + (c.awake ? 1 : 0), 0);

/* ============================================================
   1.  THE TABLE
   ============================================================ */
head('1. THE TABLE — every dynamic kind has a mass, a home and a geometry');
{
  /* Where an id can come from. A kind nothing places is dead weight: it will
     never be hit, so the row is a claim nobody can check. `sign` is the one
     that is not in any table — every stage builds warning boards from the
     spline, unconditionally. */
  const placed = new Set(['sign']);
  for (const theme of Object.keys(RECIPES)) {
    for (const K of RECIPES[theme].kinds) placed.add(K.id);
    const D = DRESSING[theme];
    for (const L of D.landmarks) placed.add(L.id);
    for (const W of (D.wasteland || [])) placed.add(W.id);
  }
  /* And whether the id resolves to geometry. Same two switches kit-check
     reads, plus buildScatter's own geoFor chain for the non-kit shapes. */
  const resolves = (id) => id === 'sign' ||
    PROPS_SRC.includes(`case '${id}':`) || WASTE_SRC.includes(`case '${id}':`) ||
    PROPS_SRC.includes(`id === '${id}'`) || PROPS_SRC.includes(`id.startsWith('pine')`) &&
    id.startsWith('pine');

  for (const id of IDS) {
    const m = PROP_MASS_KG(id);
    ok(`${id}: has a mass`, Number.isFinite(m) && m > 0, `${m} kg`);
    ok(`${id}: some stage places it`, placed.has(id));
    ok(`${id}: resolves to geometry`, resolves(id),
      KIT_KINDS.has(id) ? '_kitGeo' : id === 'sign' ? 'buildSigns' : 'geoFor');
  }
  ok('an unlisted id fails closed rather than becoming furniture',
    PROP_MASS_KG('rock0') === Infinity && PROP_MASS_KG('nope') === Infinity);

  /* The two ends of the range. Both are statements about the design, not
     slack: nothing may be immovable for everybody, and something must be
     immovable for the bike. */
  const heaviest = MACHINES[MACHINES.length - 1], lightest = MACHINES[0];
  const ceiling = T.massRatio * heaviest.mass;
  const floor = T.massRatio * lightest.mass;
  const masses = IDS.map(id => PROP_MASS_KG(id));
  const over = IDS.filter(id => PROP_MASS_KG(id) >= ceiling);
  ok(`nothing reaches ${f(ceiling, 1)} kg — the ${heaviest.id}'s share`,
    over.length === 0, over.join(',') || `heaviest is ${Math.max(...masses)} kg`);
  const stopsBike = IDS.filter(id => PROP_MASS_KG(id) > floor);
  ok(`something exceeds ${f(floor, 1)} kg — the ${lightest.id} genuinely stops`,
    stopsBike.length > 0, stopsBike.join(','));
  info(`${IDS.length} dynamic kinds, ${Math.min(...masses)}–${Math.max(...masses)} kg, ` +
    `massRatio ${T.massRatio}, pool ${T.poolSize}`);

  /* Eligible but never placed SOLID is not a failure — a recipe may flip a
     kind solid tomorrow and the table must already be right — but it is worth
     saying out loud, because such a kind has no collider and can never be hit. */
  const solidSomewhere = new Set(['sign']);
  for (const theme of Object.keys(RECIPES)) {
    for (const K of RECIPES[theme].kinds) if (K.solid) solidSomewhere.add(K.id);
    for (const L of DRESSING[theme].landmarks) if (L.r > 0) solidSomewhere.add(L.id);
  }
  solidSomewhere.add('bale');                  // _planJumpFurniture dresses it solid 0.7
  const noCollider = IDS.filter(id => !solidSomewhere.has(id));
  info(noCollider.length
    ? `no collider on any stage today (cannot be hit): ${noCollider.join(', ')}`
    : 'every dynamic kind is solid on at least one stage');
}

/* ============================================================
   2.  THE MASS RULE
   ============================================================ */
head('2. THE MASS RULE — who goes through what, measured through dynHit()');
const YIELDS = new Map();
{
  /* Measured, not derived: a fresh pool and a real call per (machine, kind),
     so this table is what the game will actually do. */
  for (const M of MACHINES) {
    const set = new Set();
    for (const id of IDS) {
      const st = makeStage(1, id);
      const pool = createDynamicPool(st.props, 4);
      if (knock(pool, st.colliders[0], M.mass, 18).hit) set.add(id);
    }
    YIELDS.set(M.id, set);
    const stops = IDS.filter(id => !set.has(id));
    info(`${M.id.padEnd(10)} ${String(M.mass).padStart(4)} kg  cap ` +
      `${f(T.massRatio * M.mass, 1).padStart(5)} kg  →  through ${set.size}/${IDS.length}` +
      (stops.length ? `   STOPS AT: ${stops.join(' ')}` : '   stops at nothing'));
  }

  /* Monotonic: a heavier machine yields to a superset of what a lighter one
     yields to. If this ever fails, the rule has grown a special case. */
  let mono = true, where = '';
  for (let i = 1; i < MACHINES.length; i++) {
    const lo = YIELDS.get(MACHINES[i - 1].id), hi = YIELDS.get(MACHINES[i].id);
    for (const id of lo) if (!hi.has(id)) { mono = false; where = `${MACHINES[i].id} not ${id}`; }
  }
  ok('heavier machines yield to a superset of lighter ones', mono, where || 'monotonic');

  const bike = MACHINES[0];
  const bikeStops = IDS.filter(id => !YIELDS.get(bike.id).has(id));
  ok(`the ${bike.id} stops at the heavy kinds`, bikeStops.length > 0, bikeStops.join(','));
  for (let i = 1; i < MACHINES.length; i++) {
    const M = MACHINES[i];
    ok(`the ${M.id} ploughs through every kind`,
      YIELDS.get(M.id).size === IDS.length,
      `${YIELDS.get(M.id).size}/${IDS.length}`);
  }

  /* Standing against a tree must not fell it, or a car nudged into the verge
     quietly flattens the scenery it is leaning on. */
  const st = makeStage(1);
  const pool = createDynamicPool(st.props, 4);
  ok('a nudge at 0.5 m/s does not knock anything over',
    !knock(pool, st.colliders[0], 1680, 0.5).hit && st.colliders[0].awake === 0);

  /* arsenal.js drives a MASSLESS probe through props.resolve() to find out
     what a rocket just flew into — `_probe` publishes pos, vel and collideR
     and nothing else. The comparison has to fail closed on that undefined
     mass, or a rocket starts felling trees and the probe's "did pos move"
     hit test stops firing. This is why the rule is written as `<=` on the
     positive side rather than `>` on the negative one. */
  const probe = {
    pos: new THREE.Vector3(st.colliders[0].x + 2, 0, 0),
    vel: new THREE.Vector3(-30, 0, 0), collideR: 0.35,
  };
  ok('a massless probe (a rocket) can never knock a prop over',
    dynHit(pool, st.colliders[0], probe, 1, 0, 30) === false &&
    st.colliders[0].awake === 0);
}

/* ============================================================
   3.  THE COUNTER-IMPULSE
   ============================================================ */
head('3. WHAT THE MACHINE GETS BACK');
{
  for (const M of MACHINES) {
    const st = makeStage(1, 'crate');            // 35 kg: everything goes through it
    const pool = createDynamicPool(st.props, 4);
    const { hit, v } = knock(pool, st.colliders[0], M.mass, 24);
    if (!hit) { ok(`${M.id}: goes through a crate`, false); continue; }
    const dv = 24 - Math.abs(v.vel.x);           // speed given up to the crate
    ok(`${M.id}: keeps going through a 35 kg crate`,
      Math.abs(v.vel.x) > 0 && v.vel.x < 0 && dv > 0 && dv < 24,
      `−${f(dv)} m/s of ${24}`);
    ok(`${M.id}: an off-axis hit twists it`, Math.abs(v.omega.y) > 1e-6,
      `ω.y ${f(v.omega.y, 4)}`);
    ok(`${M.id}: Δv is under the TUNE.collide.maxDeltaV clamp`,
      dv <= TUNE.collide.maxDeltaV + 1e-6, `${f(dv)} ≤ ${TUNE.collide.maxDeltaV}`);
  }
  /* The heavy end: the same hit on a pine costs the bike nothing, because the
     bike does not get through and props.js's own hard stop handles it. */
  const st = makeStage(1, 'pine2');
  const pool = createDynamicPool(st.props, 4);
  const { hit, v } = knock(pool, st.colliders[0], MACHINES[0].mass, 24);
  ok('a bike hitting a 210 kg pine is left entirely to the hard stop',
    !hit && v._j === 0 && st.colliders[0].awake === 0);

  /* Something has to come off the prop, or a truck going through a pine reads
     as the pine having been a hologram. Both systems stay optional — props
     builds and collides in a harness that made neither — so the guard is
     checked in the same breath as the call. */
  const spy = () => {
    const s = { bursts: [], sparks: [] };
    s.dust = { burst: (...a) => s.bursts.push(a) };
    s.vfx = { sparks: (...a) => s.sparks.push(a) };
    return s;
  };
  for (const [kind, label, green] of [['pine1', 'a felled pine', true],
  ['drum', 'a punted fuel drum', false]]) {
    const s = spy();
    const stv = makeStage(1, kind);
    stv.props.dust = s.dust; stv.props.vfx = s.vfx;
    const pool2 = createDynamicPool(stv.props, 4);
    knock(pool2, stv.colliders[0], 1680, 22);
    ok(`${label} throws dust and debris`, s.bursts.length === 1 && s.sparks.length === 1);
    if (!s.sparks.length) continue;
    // sparks(n, x, y, z, dx, dy, dz, speed, spread, r, g, b, life)
    const r = s.sparks[0][9], g = s.sparks[0][10], b = s.sparks[0][11];
    ok(`${label}: ${green ? 'leaf and bark' : 'grit and orange'}`,
      green ? (g > r && r > b) : (r > g && g > b), `${f(r)} ${f(g)} ${f(b)}`);
    ok(`${label}: every number handed to the particle systems is finite`,
      s.sparks[0].every(Number.isFinite) &&
      s.bursts[0].slice(0, 5).every(Number.isFinite));
  }
  {
    const stn = makeStage(1, 'crate');
    stn.props.terrain = null;                    // a harness with no terrain either
    const pool2 = createDynamicPool(stn.props, 4);
    let threw = false;
    try { knock(pool2, stn.colliders[0], 1680, 22); } catch (e) { threw = true; void e; }
    ok('no vfx, no dust and no terrain still knocks the prop over', !threw);
  }
}

/* ============================================================
   4.  THE INTEGRATOR
   ============================================================ */
head('4. THE INTEGRATOR — it lands, it stops, and it says so');
{
  const finite = (pool, b) => [pool.px[b], pool.py[b], pool.pz[b],
  pool.vx[b], pool.vy[b], pool.vz[b],
  pool.qx[b], pool.qy[b], pool.qz[b], pool.qw[b]].every(Number.isFinite);

  let worst = 0;
  for (const closing of [3, 8, 18, 30, 45]) {
    const st = makeStage(1, 'pine1');
    const pool = createDynamicPool(st.props, 4);
    ok(`${closing} m/s: the hit takes`, knock(pool, st.colliders[0], 1680, closing).hit);
    let nan = false, below = false, t = 0;
    while (pool.live > 0 && t < 6) {
      stepDynamicPool(pool, DT, FLAT);
      t += DT;
      if (!finite(pool, 0)) nan = true;
      if (pool.py[0] < -1e-3) below = true;      // the mock ground is exactly y = 0
    }
    worst = Math.max(worst, t);
    const dist = Math.hypot(pool.px[0] - st.colliders[0].x, pool.pz[0] - st.colliders[0].z);
    ok(`${closing} m/s: settles inside 2 s`, t < 2.0, `${f(t)} s, ${f(dist, 1)} m away`);
    ok(`${closing} m/s: never went non-finite`, !nan);
    ok(`${closing} m/s: never went through the ground`, !below);
    ok(`${closing} m/s: ends ASLEEP with a live count of zero`,
      pool.state[0] === DYN_STATE.ASLEEP && pool.live === 0);
    ok(`${closing} m/s: the quaternion is still a unit quaternion`,
      Math.abs(Math.hypot(pool.qx[0], pool.qy[0], pool.qz[0], pool.qw[0]) - 1) < 1e-4);
    ok(`${closing} m/s: the prop actually moved`, dist > 0.05, `${f(dist, 2)} m`);
    ok(`${closing} m/s: the instance matrix was rewritten`,
      im0Changed(st), 'setMatrixAt + needsUpdate');
  }
  info(`slowest settle across five closing speeds: ${f(worst)} s`);

  /* A sleeping stage costs one predicate. This is the number the whole design
     is arranged around, so it is worth stating rather than assuming. */
  const st = makeStage(4);
  const pool = createDynamicPool(st.props);
  const before = st.im.instanceMatrix.array.slice();
  /* `needsUpdate` on a BufferAttribute is write-only — the setter bumps
     `version` and there is no getter — so the version counter is the only way
     to prove the attribute was never marked for re-upload. */
  const v0 = st.im.instanceMatrix.version;
  for (let k = 0; k < 600; k++) stepDynamicPool(pool, DT, FLAT);
  ok('an idle pool touches nothing over 10 s of frames',
    before.every((x, i) => x === st.im.instanceMatrix.array[i]) &&
    st.im.instanceMatrix.version === v0 && pool.live === 0,
    `version ${v0} → ${st.im.instanceMatrix.version}`);
}

function im0Changed(st) {
  const a = st.im.instanceMatrix.array;
  for (let k = 0; k < 16; k++) if (a[k] !== st.rest[k]) return true;
  return false;
}

/* ============================================================
   5.  THE POOL
   ============================================================ */
head('5. THE POOL — a fixed budget that never loses a prop');
{
  const P = T.poolSize;

  /* (a) More simultaneous hits than slots. The overflow must fall through to
     the hard stop, not overwrite a live body. */
  {
    const st = makeStage(P + 16);
    const pool = createDynamicPool(st.props);
    let taken = 0;
    for (const c of st.colliders) if (knock(pool, c, 1680, 20).hit) taken++;
    ok('a full pool stops taking hits rather than growing',
      taken === P && pool.live === P, `${taken} of ${st.colliders.length} took, ${P} slots`);
    ok('every awake collider is owned by an occupied slot',
      awakeCount(st.colliders) === occupied(pool),
      `${awakeCount(st.colliders)} awake, ${occupied(pool)} slots`);
    const stillSolid = st.colliders.filter(c => !c.awake).length;
    ok('the overflow props are still solid', stillSolid === 16, `${stillSolid}`);
  }

  /* (b) Sleep, then keep hitting things. Slots recycle, and the invariant has
     to hold at every step — a recycled slot must have stood its own prop back
     up before it forgets about it. */
  {
    const N = P * 2 + 5;
    const st = makeStage(N);
    const pool = createDynamicPool(st.props);
    let taken = 0, broke = '';
    for (const c of st.colliders) {
      if (knock(pool, c, 1680, 20).hit) taken++;
      settle(pool);
      if (awakeCount(st.colliders) !== occupied(pool)) broke = `at ${c.i}`;
    }
    ok('slots recycle, so every prop on the stage can be knocked over',
      taken === N, `${taken}/${N}`);
    ok('the awake flags and the occupied slots never disagree', !broke, broke || 'held');
    ok('at most poolSize props are down at once', awakeCount(st.colliders) <= P,
      `${awakeCount(st.colliders)} down`);

    /* And reset puts the stage back exactly as it was built. Bit-for-bit,
       because "close enough" on an instance matrix is a prop that drifts a
       little further every time somebody changes the quality tier. */
    resetDynamicPool(pool);
    const arr = st.im.instanceMatrix.array;
    let same = arr.length === st.rest.length;
    if (same) for (let k = 0; k < arr.length; k++) if (arr[k] !== st.rest[k]) { same = false; break; }
    ok('resetDynamicPool restores every matrix bit-for-bit', same);
    ok('resetDynamicPool clears every awake flag', awakeCount(st.colliders) === 0);
    ok('resetDynamicPool hands back every slot',
      pool.live === 0 && pool.nFree === pool.n && occupied(pool) === 0);
  }

  /* (c) An instance the quality tier is hiding has nothing on screen to move,
     so the hit must fall through to the hard stop instead of animating a
     ghost — and must not burn a slot doing it. */
  {
    const st = makeStage(6);
    const pool = createDynamicPool(st.props);
    st.im.count = 2;                             // a lower tier hides the last four
    const hidden = knock(pool, st.colliders[5], 1680, 20);
    ok('a prop hidden by the quality tier keeps its hard stop',
      !hidden.hit && st.colliders[5].awake === 0 && pool.nFree === pool.n);
    ok('a prop the tier still shows is knocked normally',
      knock(pool, st.colliders[0], 1680, 20).hit);
  }

  /* (d) The other two populations. A sign is a Group, a bale is an instance
     found by id — both have to wake, move and come back. */
  {
    const st = makeStage(1);
    const g = new THREE.Group();
    g.position.set(40, 3, -7);
    g.rotation.set(0, 1.1, 0);
    const sign = { x: 40, z: -7, r: 0.3, kind: 'sign', bounce: 0.6, awake: 0, vi: -1, i: -1, obj: g };
    const pool = createDynamicPool(st.props);
    ok('a sign (a Group, not an instance) can be knocked over',
      knock(pool, sign, 1010, 22).hit && sign.awake === 1);
    settle(pool);
    const moved = Math.hypot(g.position.x - 40, g.position.z + 7) > 0.05;
    ok('the sign Group was actually transformed', moved,
      `${f(g.position.x, 1)}, ${f(g.position.y, 1)}, ${f(g.position.z, 1)}`);
    resetDynamicPool(pool);
    /* The rest pose is kept in the same Float32Array the instance matrices
       use, so a sign's yaw comes back through single precision — 1e-7 rad on
       a 1.5 m board, which is well under a pixel at any distance you can see
       one from. Position is exact; it is only the angle that rounds. */
    ok('and it stands back up exactly where it was',
      g.position.x === 40 && g.position.y === 3 && g.position.z === -7 &&
      Math.abs(g.rotation.y - 1.1) < 1e-6 && sign.awake === 0,
      `yaw off by ${(g.rotation.y - 1.1).toExponential(1)}`);

    const dst = makeStage(3, 'bale');
    dst.props._dressMeshById.set('bale', dst.im);
    const dcol = { x: 24, z: 0, r: 0.7, kind: 'bale', bounce: 0.35, awake: 0, vi: -1, i: 2, obj: null };
    const dpool = createDynamicPool(dst.props);
    ok('a dressing instance is found by id and knocked over',
      knock(dpool, dol(dcol), 245, 16).hit && dcol.awake === 1);
    settle(dpool);
    ok('a dressing id with no mesh falls through rather than throwing',
      !knock(dpool, { x: 0, z: 0, r: 1, kind: 'drum', awake: 0, vi: -1, i: 0, obj: null },
        1680, 20).hit);
  }
}
function dol(c) { return c; }

/* ============================================================
   6.  DETERMINISM
   ============================================================ */
head('6. DETERMINISM — the same hit is the same hit, forever');
{
  const run = () => {
    const st = makeStage(3, 'pine0');
    const pool = createDynamicPool(st.props);
    for (const c of st.colliders) knock(pool, c, 1680, 26);
    for (let k = 0; k < 150; k++) stepDynamicPool(pool, DT, FLAT);
    return { pool, arr: Float32Array.from(st.im.instanceMatrix.array) };
  };
  const a = run(), b = run();
  const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'qx', 'qy', 'qz', 'qw',
    'wx', 'wy', 'wz', 'sx', 'sy', 'sz', 'still'];
  let bad = '';
  for (const k of FIELDS) {
    for (let i = 0; i < a.pool.n; i++) if (a.pool[k][i] !== b.pool[k][i]) { bad = `${k}[${i}]`; break; }
    if (bad) break;
  }
  ok('two identical runs give identical body state', !bad, bad || `${FIELDS.length} fields`);
  let sameMat = true;
  for (let i = 0; i < a.arr.length; i++) if (a.arr[i] !== b.arr[i]) { sameMat = false; break; }
  ok('…and identical instance matrices', sameMat);

  /* No Math.random() anywhere in the file. The tumble is cosmetic but the
     `awake` flag it comes with is not, and qa-drive compares lap times. */
  const src = readFileSync(join(ROOT, 'src', 'world', 'props-dynamic.js'), 'utf8');
  // comments stripped first: the file explains at length why it does NOT use
  // Math.random(), and a grep that trips over its own documentation is useless
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  ok('props-dynamic.js never calls Math.random()', !code.includes('Math.random'));
  ok('…and takes its randomness from hash2', src.includes("from './props-shapes.js'"));
}

/* ============================================================
   7.  THE WIRING
   ============================================================ */
head('7. THE WIRING — props.js hands the pool what it needs');
{
  ok('resolve() skips a knocked prop before it does anything else',
    /const c = this\.colliders\[id\];[\s\S]{0,400}?if \(c\.awake\) continue;/.test(PROPS_SRC));
  ok('resolve() offers the hit to dynHit before pushing the car out',
    PROPS_SRC.indexOf('dynHit(this._dyn') > 0 &&
    PROPS_SRC.indexOf('dynHit(this._dyn') < PROPS_SRC.indexOf('v.pos.x += nx * pen'));
  ok('the scatter stamps its back-reference on the collider',
    /awake: 0, vi: ki, i: k, obj: null/.test(PROPS_SRC));
  ok('the dressing stamps its instance index',
    /awake: 0, vi: -1, i: a\.length - 1, obj: null/.test(PROPS_SRC));
  ok('a sign carries its Group', /kind: 'sign'[\s\S]{0,80}obj: g/.test(PROPS_SRC));
  ok('_flushDressing keeps a mesh-by-id map', PROPS_SRC.includes('_dressMeshById.set(id, im)'));
  ok('the pool is built after setScatterDensity',
    PROPS_SRC.indexOf('createDynamicPool(this)') >
    PROPS_SRC.indexOf('this.setScatterDensity(quality.boulders)'));
  ok('a density change stands everything back up first',
    /setScatterDensity\(N\) \{[\s\S]{0,400}?resetDynamicPool\(this\._dyn\);[\s\S]{0,80}?this\.colliders\.length = 0/
      .test(PROPS_SRC));
  ok('update() steps the pool even with no camera',
    PROPS_SRC.indexOf('stepDynamicPool(this._dyn') < PROPS_SRC.indexOf('if (!camera) return;'));
  ok('the vehicle is pushed through Vehicle.applyImpulse, not by hand',
    readFileSync(join(ROOT, 'src', 'world', 'props-dynamic.js'), 'utf8')
      .includes('v.applyImpulse(_n3, j, _r3)'));
}

/* ---------------- verdict ---------------- */
console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('dynamic props OK');

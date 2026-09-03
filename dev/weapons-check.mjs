/* ============================================================
   RALLY ROAD RASH — the arsenal: launchers, ammo, siting, ballistics, aim
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/weapons-check.mjs

   Sections a–f run on the pure modules (weapons.js, arsenal-sites.js,
   ai-weapons.js) and buildTrackData; g needs a real Vehicle, which is why
   the loader shim is on the command line. Non-zero exit on any failure.

   The gates that matter most:
     • SITING IS DETERMINISTIC. The same track and seed must produce the
       same pickups to the bit, twice, or a lap time set on one build
       cannot be compared with the next.
     • THE SHOT REACHES THE WINDOW. The AI aims inside 8–70 m; a rocket
       that hits the ground short of 70 m at any launch speed makes that
       window a lie.
     • THE AIM CONNECTS. Six in ten shots the AI chooses to take must land
       on a kinematic straight-line mock, or the trigger finger is decoration.
   ============================================================ */
import { VEHICLES, VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { G, TUNE } from '../src/game/config.js';
import {
  LAUNCHERS, LAUNCHER_DEFAULT, launcherFor, PICKUP, PICKUPS,
  makeArsenal, resetArsenal, addAmmo, canFire, spend, giveNitro, giveSlow, hitSpin,
  tick, effectMuls, rocketRange, armDistance,
} from '../src/game/weapons.js';
import { sitePickups, ringDist } from '../src/game/arsenal-sites.js';
import { AI_WEAPON, aimOk, decideFire, validateFire } from '../src/game/ai-weapons.js';
import { buildTrackData } from '../src/world/track.js';
import { TRACKS } from '../src/world/tracks/index.js';
import { Vehicle } from '../src/game/vehicle.js';
import { SURF } from '../src/world/surfaces.js';

const W = TUNE.weapons, N = TUNE.nitro, B = TUNE.boost;

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); }
};
const eq = (a, b, msg) => ok(a === b, `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const head = (s) => console.log(`\n=== ${s}`);
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const pc = (n, d) => (100 * n / Math.max(1, d)).toFixed(1) + '%';

/* A seeded PRNG, copied in rather than imported so a failure here is a
   failure in the module under test and not in core/rng.js. */
function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* ============================================================
   a — the launcher table
   ============================================================ */
head('a  launchers: one per machine, deltas inside 15 %');
{
  const ids = VEHICLES.map(v => v.id);
  for (const id of ids) {
    const L = LAUNCHERS[id];
    ok(!!L, `${id} has a launcher entry`);
    if (!L) continue;
    eq(L.ammo, W.ammoStart, `${id} starts with ${W.ammoStart} rockets`);
    eq(L.ammoCap, W.ammoCap, `${id} rack caps at ${W.ammoCap}`);
    ok(L.reload >= 0.7 && L.reload <= 1.0, `${id} reload ${L.reload} inside 0.7–1.0 s`);
    ok(L.speed >= 55 && L.speed <= 65, `${id} rocket speed ${L.speed} inside 55–65 m/s`);
    ok(L.splash >= 3.0 && L.splash <= 3.6, `${id} splash ${L.splash} inside 3.0–3.6 m`);
    for (const k in L) ok(Number.isFinite(L[k]), `${id}.${k} is finite`);
  }
  for (const col of ['reload', 'speed', 'splash']) {
    let lo = Infinity, hi = -Infinity;
    for (const id of ids) { const v = LAUNCHERS[id][col]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const spread = (hi - lo) / lo;
    console.log(`      ${col.padEnd(7)} ${f2(lo)} … ${f2(hi)}  spread ${pc(spread, 1)}`);
    ok(spread <= 0.15 + 1e-9, `${col}: every machine inside 15 % of every other (${pc(spread, 1)})`);
  }
  ok(launcherFor('no-such-machine') === LAUNCHER_DEFAULT, 'an unknown spec gets the default launcher');
  ok(launcherFor('ridgeback') === LAUNCHERS.ridgeback, 'a known spec gets its own');
  eq(PICKUPS[PICKUP.ROCKET].ammo, W.crateAmmo, 'a crate is worth crateAmmo rockets');
  eq(PICKUPS[PICKUP.NITRO].time, N.time, 'the can carries the nitro time');
  for (const p of PICKUPS) {
    ok(typeof p.text === 'string' && p.text.length > 0, `${p.name} has HUD text`);
    ok(Number.isFinite(p.col), `${p.name} has a colour`);
    ok(p.respawn > 0, `${p.name} respawns`);
  }
}

/* ============================================================
   b — the ammo and reload rules
   ============================================================ */
head('b  ammo: a full rack at the grid, a reload between shots, a cap');
{
  const L = LAUNCHERS.hopper;
  const st = makeArsenal('hopper');
  eq(st.ammo, W.ammoStart, 'starts loaded');
  eq(st.ammoCap, W.ammoCap, '…with the cap from the table');
  eq(canFire(st), true, 'a loaded rack can fire');
  eq(spend(st), true, 'the first shot goes');
  eq(st.ammo, W.ammoStart - 1, '…and costs one rocket');
  ok(Math.abs(st.reloadT - L.reload) < 1e-9, `…and starts the ${L.reload} s reload`);
  eq(canFire(st), false, 'no shot during the reload');
  eq(spend(st), false, '…and spend() refuses one');
  tick(st, L.reload * 0.5);
  eq(canFire(st), false, '…still not, halfway through');
  tick(st, L.reload * 0.5 + 1e-6);
  eq(st.reloadT, 0, 'the reload clock stops at zero, never below');
  eq(canFire(st), true, '…and the tube is live again');
  let shots = 0;
  for (let i = 0; i < 20; i++) { if (spend(st)) shots++; tick(st, 5); }
  eq(shots, W.ammoStart - 1, 'the rest of the rack fires, one per reload');
  eq(st.ammo, 0, 'and then it is empty');
  eq(spend(st), false, 'an empty rack fires nothing');
  eq(addAmmo(st, W.crateAmmo), W.crateAmmo, 'a crate loads three');
  eq(addAmmo(st, 99), W.ammoCap - W.crateAmmo, 'a load past the cap loads only the room');
  eq(st.ammo, W.ammoCap, '…and the rack is exactly full');
  eq(addAmmo(st, 1), 0, 'a full rack takes nothing — the crate stays on the road');
  giveNitro(st); giveSlow(st, true); spend(st);
  resetArsenal(st);
  ok(st.ammo === W.ammoStart && st.reloadT === 0 && st.nitroT === 0 && st.slowT === 0,
    'resetArsenal is the grid: full rack, nothing burning, nothing cut');
  const keys = Object.keys(makeArsenal('moto')).length;
  eq(Object.keys(st).length, keys, 'the state has a fixed shape');
  const moto = makeArsenal('moto');
  ok(moto.speed === LAUNCHERS.moto.speed && moto.splash === LAUNCHERS.moto.splash,
    'each state carries its own launcher numbers');
}

/* ============================================================
   c — siting: deterministic, sane, on every stage
   ============================================================ */
head('c  siting: same seed → same sites, twice; rows 3–5 wide; cans spaced');
{
  const flat = { heightAt: () => 0 };
  const same = (A, Bb) => {
    if (A.n !== Bb.n) return false;
    for (const k of ['kind', 'x', 'y', 'z', 's', 'lat']) {
      for (let i = 0; i < A.n; i++) if (A[k][i] !== Bb[k][i]) return false;
    }
    return true;
  };
  for (const def of TRACKS) {
    const td = buildTrackData(def);
    const L = td.lapLength;
    const A = sitePickups(td, flat, def.seed);
    const Bb = sitePickups(td, flat, def.seed);
    const C = sitePickups(td, flat, def.seed + 1);
    ok(same(A, Bb), `${def.id}: the same seed sites identically, twice`);
    ok(!same(A, C), `${def.id}: a different seed moves something`);

    let crates = 0, cans = 0, finite = true, sorted = true, inJump = 0;
    const rowSizes = new Map();
    const canS = [];
    for (let i = 0; i < A.n; i++) {
      if (![A.x[i], A.y[i], A.z[i], A.s[i], A.lat[i]].every(Number.isFinite)) finite = false;
      if (i > 0 && A.s[i] < A.s[i - 1]) sorted = false;
      if (!(A.s[i] >= 0 && A.s[i] < L)) finite = false;
      if (A.kind[i] === PICKUP.ROCKET) {
        crates++;
        const key = Math.round(A.s[i] * 10);
        rowSizes.set(key, (rowSizes.get(key) || 0) + 1);
      } else { cans++; canS.push(A.s[i]); }
      for (const j of td.jumps || []) {
        let d = A.s[i] - (j.s - 40);
        if (d < 0) d += L;
        if (d < 40 + j.len + (j.gap || 0) + 25) inJump++;
      }
    }
    let rowsOk = true, rows = 0;
    for (const n of rowSizes.values()) { rows++; if (n < W.crateRows[0] || n > W.crateRows[1]) rowsOk = false; }
    let spaced = true, minGap = Infinity;
    for (let i = 0; i < canS.length; i++) {
      for (let j = i + 1; j < canS.length; j++) {
        const d = ringDist(canS[i], canS[j], L);
        if (d < minGap) minGap = d;
        if (d < 100) spaced = false;
      }
    }
    console.log(`      ${def.id.padEnd(9)} ${rows} rows / ${crates} crates · ${cans} cans` +
      `${cans > 1 ? ` (min gap ${f1(minGap)} m)` : ''} on ${f1(L)} m`);
    ok(finite && sorted, `${def.id}: every site finite, inside the lap, sorted by s`);
    ok(rows >= 3, `${def.id}: at least three crate rows (${rows})`);
    ok(rowsOk, `${def.id}: every row is ${W.crateRows[0]}–${W.crateRows[1]} wide`);
    ok(cans >= 1 && cans <= 7, `${def.id}: between one and seven cans (${cans})`);
    ok(spaced, `${def.id}: cans at least 100 m apart`);
    eq(inJump, 0, `${def.id}: nothing sited in a jump window`);
  }
}

/* ============================================================
   d — ballistics: the shot reaches the AI's whole window
   ============================================================ */
head('d  ballistics: 70 m at every launch speed 0–45 m/s, on every launcher');
{
  const H = 1.4;      // m — a roof-mounted tube, conservatively low
  let worst = Infinity, worstAt = '';
  for (const id in LAUNCHERS) {
    const L = LAUNCHERS[id];
    for (let v = 0; v <= 45; v += 5) {
      const r = rocketRange(v, L.speed, H);
      if (r < worst) { worst = r; worstAt = `${id} @ ${v} m/s`; }
      ok(r >= AI_WEAPON.rangeMax, `${id} fired at ${v} m/s reaches ${AI_WEAPON.rangeMax} m (${f1(r)})`);
      const straight = (v + L.speed) * W.straightT;
      ok(straight >= AI_WEAPON.rangeMin, `${id} @ ${v}: the flat phase covers the near window`);
    }
    ok(armDistance(0, L.speed) < AI_WEAPON.rangeMax, `${id}: the arm distance is inside the window`);
  }
  console.log(`      shortest reach ${f1(worst)} m (${worstAt}); window ${AI_WEAPON.rangeMin}–${AI_WEAPON.rangeMax} m`);
  ok(W.life * 55 > AI_WEAPON.rangeMax, 'life alone never ends a rocket inside the window');
  eq(rocketRange(-60, 60, H), 0, 'a rocket with no world speed goes nowhere');
}

/* ============================================================
   e — what a hit does, and what the can does
   ============================================================ */
head('e  hit tiers: direct vs splash = half; the can is the old NITRO, fireTop semantics');
{
  ok(Math.abs(hitSpin(true) - W.spin) < 1e-9, 'a direct hit spins for the full time');
  ok(Math.abs(hitSpin(false) - W.spin * W.splashMul) < 1e-9, 'a splash spins for half');
  const st = makeArsenal('hopper');
  const m = { drive: 1, top: 1 };
  giveSlow(st, false);
  ok(Math.abs(st.slowT - W.slowT * W.splashMul) < 1e-9, 'splash cuts drive for half the time');
  giveSlow(st, true);
  ok(Math.abs(st.slowT - W.slowT) < 1e-9, '…a direct hit on top raises it to the full time (max, not sum)');
  effectMuls(st, m);
  ok(Math.abs(m.drive - W.slowDrive) < 1e-9 && m.top === 1, `the cut is ${W.slowDrive} × drive, top untouched`);
  tick(st, W.slowT + 0.01);
  effectMuls(st, m);
  ok(m.drive === 1 && m.top === 1, 'and it ends cleanly');

  giveNitro(st);
  ok(Math.abs(st.nitroT - N.time) < 1e-9, `the can burns for ${N.time} s`);
  giveNitro(st);
  ok(Math.abs(st.nitroT - N.time) < 1e-9, 'two cans in a second are one burn, not two');
  effectMuls(st, m);
  ok(Math.abs(m.drive - N.force) < 1e-9 && Math.abs(m.top - N.top) < 1e-9,
    `the burn is ${N.force} × drive and ${N.top} × top`);
  ok(N.top >= 1 && N.top <= B.fireTop[2] + 0.05,
    `nitro.top (${N.top}) is a fade-denominator multiplier inside the tier envelope (≤ ${B.fireTop[2]})`);
  ok(N.force >= B.fireMul[0], 'the can shoves at least as hard as a tier-1 mini-turbo');
  giveSlow(st, true);
  effectMuls(st, m);
  ok(Math.abs(m.drive - N.force * W.slowDrive) < 1e-9, 'a hit during a burn composes, never overwrites');
  tick(st, N.time + 0.01);
  effectMuls(st, m);
  ok(m.top === 1, 'the ceiling comes back the moment the burn ends');
}

/* ============================================================
   f — the AI's aim, on a kinematic straight-line mock
   ------------------------------------------------------------
   No track, no driver: a shooter-shaped object with the six numbers the
   rival scan in ai.js fills, a target on constant velocity, and the same
   ballistics arsenal.js integrates. The aim is a lead solution against a
   straight-line target, so on a straight-line target it is EXACT — what
   this measures is whether the window it accepts is narrower than the
   hitbox it has to land in, plus the two refusals that keep it honest.
   ============================================================ */
head('f  AI aim: ≥ 60 % of chosen shots connect; refuses out of cone; keeps the last one');
{
  const SPEED = LAUNCHERS.hopper.speed;
  const HIT_R = 1.2 + W.radius;                 // the mock's collision radius + the rocket's
  const rng = rng32(0xA11);
  const shooter = () => ({
    vehicle: { spec: VEHICLE_BY_ID.hopper }, route: null, ri: -1,
    aggression: 0.8, consistency: 0.95, position: 3, weaponStyle: 'sniper',
    threatOff: 0, wantsFire: false, fireBack: false, rocketSpeed: SPEED,
    _shotAhead: Infinity, _shotLat: 0, _shotClosing: 0, _shotTheirLat: 0,
    _shotBehind: Infinity, _shotLatB: 0, _shotClosingB: 0, _shotTheirLatB: 0,
    rng,
  });

  /** Fly a rocket at (vS + SPEED) down +z against a target at (lat, fwd)
      moving (vLat, vS + dv); true if it passes inside HIT_R. */
  function flies(vS, fwd, lat, dv, vLat, back) {
    const dir = back ? -1 : 1;
    let rx = 0, rz = 0, ry = 1.4, vz = vS + SPEED * dir, vy = 0, age = 0;
    let tx = lat, tz = fwd * dir;
    const tvz = vS + dv, tvx = vLat;
    const dt = 1 / 240;
    for (let t = 0; t < W.life; t += dt) {
      age += dt;
      if (age > W.straightT) vy -= W.dropG * G * dt;
      rz += vz * dt; ry += vy * dt;
      tx += tvx * dt; tz += tvz * dt;
      const dx = tx - rx, dz = tz - rz, dy = 0.5 - ry;
      if (dx * dx + dz * dz + dy * dy <= HIT_R * HIT_R) return true;
      if (ry <= 0.25) return false;
      if ((tz - rz) * dir < -6) return false;        // passed it
    }
    return false;
  }

  let chosen = 0, hit = 0, offered = 0;
  for (const vS of [15, 25, 35]) {
    for (const fwd of [12, 25, 40, 55]) {
      for (const lat of [-2, -1, 0, 1, 2]) {
        for (const dv of [-8, -4, 0, 4]) {
          for (const vLat of [-1.5, 0, 1.5]) {
            offered++;
            const d = shooter();
            d._shotAhead = fwd; d._shotLat = lat; d._shotClosing = -dv; d._shotTheirLat = vLat;
            // up to eight 4 Hz decisions, as two seconds of a straight would give it
            let fired = false;
            for (let k = 0; k < 8 && !fired; k++) fired = decideFire(d, 6, vS, null);
            if (!fired) continue;
            validateFire(d);
            if (!d.wantsFire) continue;
            chosen++;
            if (flies(vS, fwd, lat, dv, vLat, d.fireBack)) hit++;
          }
        }
      }
    }
  }
  const rate = chosen ? hit / chosen : 0;
  console.log(`      ${offered} geometries · ${chosen} shots chosen · ${hit} hit  ⇒  ${pc(hit, chosen)}`);
  ok(chosen >= offered * 0.35, `the AI takes a fair share of the shots on offer (${pc(chosen, offered)})`);
  ok(rate >= 0.60, `≥ 60 % of chosen shots connect (${pc(hit, chosen)})`);

  // the two refusals
  {
    const d = shooter();
    d._shotAhead = 20; d._shotLat = 6;                // 6 m off at 20 m: outside ±12°
    let fires = 0;
    for (let k = 0; k < 40; k++) if (decideFire(d, 6, 25, null)) { fires++; d.wantsFire = false; }
    eq(fires, 0, 'never fires at a car outside the cone');
    eq(aimOk(d, false, 0), false, '…and aimOk says so directly');
    d._shotLat = 0; d._shotAhead = 5;
    eq(aimOk(d, false, 0), false, 'never inside the arm distance');
    d._shotAhead = 90;
    eq(aimOk(d, false, 0), false, 'never past the window');
    d._shotAhead = 30;
    eq(aimOk(d, false, 0.02), false, 'never into a corner');
    eq(aimOk(d, false, 0), true, '…but a car 30 m ahead on a straight is a shot');
  }
  {
    const d = shooter();
    d._shotAhead = 25; d._shotLat = 0;
    let fires = 0;
    for (let k = 0; k < 60; k++) if (decideFire(d, 1, 25, null)) { fires++; d.wantsFire = false; }
    eq(fires, 0, 'the last rocket is never spent on a car ahead when nobody is behind');
    d._shotBehind = 12; d._shotLatB = 0.3;             // …now somebody is
    let back = 0, fwd = 0;
    for (let k = 0; k < 60; k++) {
      if (decideFire(d, 1, 25, null)) { if (d.fireBack) back++; else fwd++; d.wantsFire = false; d.fireBack = false; }
    }
    ok(back + fwd > 0, 'threatened, the last rocket goes');
    d._shotAhead = Infinity;
    let back2 = 0;
    for (let k = 0; k < 60; k++) {
      if (decideFire(d, 3, 25, null)) { if (d.fireBack) back2++; d.wantsFire = false; d.fireBack = false; }
    }
    ok(back2 > 0, 'with nobody ahead and somebody behind, it fires behind');
  }
  {
    // the REL_FLOOR: flat out and firing backwards at a car that is pulling
    // away behind — the rocket can never arrive, and the gate must say no
    const d = shooter();
    d._shotBehind = 30; d._shotLatB = 0.5; d._shotClosingB = SPEED + 5;   // spd − theirFwd
    d._shotTheirLatB = 2.0;
    eq(aimOk(d, true, 0), false, 'a rearward shot that cannot arrive is refused');
  }
}

/* ============================================================
   g — Vehicle.placeAt wipes the arsenal publications (contract 8.1)
   ============================================================ */
head('g  Vehicle.placeAt zeroes nitroT / reloadT / ammo / ammoCap');
{
  const flat = {
    heightAt: () => 0,
    normalAt(x, z, e, out) { return out.set(0, 1, 0); },
    surfaceAt: () => SURF.DIRT,
    onRoad: () => 1,
  };
  for (const S of VEHICLES) {
    const v = new Vehicle(null, flat, S, { headless: true });
    v.placeAt(0, 0, 0);
    v.nitroT = 1.3; v.reloadT = 0.6; v.ammo = 7; v.ammoCap = 12;
    v.placeAt(5, 5, 0.3);
    ok(v.nitroT === 0 && v.reloadT === 0 && v.ammo === 0 && v.ammoCap === 0,
      `${S.id}: placeAt wipes all four`);
    const out = v.muzzleWorld(new (Object.getPrototypeOf(v.pos).constructor)());
    ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z),
      `${S.id}: muzzleWorld answers on a headless car`);
  }
}

/* ---------------- verdict ---------------- */
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
console.log('arsenal OK');

/* ============================================================
   dev/track-check.mjs — geometry sanity for every authored track
   ------------------------------------------------------------
   Plain Node, no three, no loader shim:
       node dev/track-check.mjs
   Non-zero exit if anything below is violated. Run it after every
   edit to a tracks/*.js control point.

   FAIL conditions
     - checkpoint spacing outside [40, 200] m, or s not monotonic
     - any racing-line advisory speed below 9 m/s
     - the loop passes within 0.8*(w_i+w_j) of itself with |ds| > 60 m
       (this engine has no bridges: a crossover is a car crash)
     - spline.nearest() disagrees with the generating s by > 2 m
   ============================================================ */
import { buildTrackData } from '../src/world/track.js';
import { TRACKS } from '../src/world/tracks/index.js';
import { SURFACES } from '../src/world/surfaces.js';

const MIN_CP_GAP = 40, MAX_CP_GAP = 200;
const MIN_RL_SPEED = 9;
const NEAREST_SAMPLES = 200, NEAREST_TOL = 2.0;
const CROSS_MIN_DS = 60;
const PLAYABLE = 600;

let failures = 0;
const fail = (t, msg) => { failures++; console.log(`  FAIL [${t}] ${msg}`); };
const warn = (t, msg) => console.log(`  warn [${t}] ${msg}`);
const f1 = (v) => v.toFixed(1);

/* deterministic sampler so a failure is reproducible */
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const def of TRACKS) {
  console.log(`\n=== ${def.id}  "${def.name}"  theme=${def.theme}  laps=${def.laps}`);
  const td = buildTrackData(def);
  const sp = td.spline;
  const L = sp.length;
  const id = def.id;

  /* ---------- 1. spline ---------- */
  let ext = 0, minR = 1e9, maxGrade = 0, minW = 1e9, maxW = 0;
  const p = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < L; s += 1) {
    sp.posAt(s, p);
    ext = Math.max(ext, Math.abs(p.x), Math.abs(p.z));
    const k = Math.abs(sp.curvatureAt(s));
    if (k > 1e-6) minR = Math.min(minR, 1 / k);
    const g = Math.abs(sp.heightAt(s + 4) - sp.heightAt(s)) / 4;
    if (g > maxGrade) maxGrade = g;
    const w = sp.widthAt(s);
    minW = Math.min(minW, w); maxW = Math.max(maxW, w);
  }
  console.log(`  length      ${f1(L)} m   controlPts=${def.path.length}   ` +
    `halfWidth ${f1(minW)}..${f1(maxW)} m`);
  console.log(`  geometry    tightest corner R=${f1(minR)} m   max grade=` +
    `${(maxGrade * 100).toFixed(0)}%   extent=${f1(ext)} m`);
  if (ext > PLAYABLE) fail(id, `track reaches ${f1(ext)} m, outside the +-${PLAYABLE} m playable extent`);
  if (maxGrade > 0.45) fail(id, `road grade ${(maxGrade * 100).toFixed(0)}% is not drivable`);
  else if (maxGrade > 0.30) warn(id, `road grade peaks at ${(maxGrade * 100).toFixed(0)}%`);
  if (minR < 18) warn(id, `tightest corner is only ${f1(minR)} m radius`);

  /* ---------- 2. checkpoints ---------- */
  const cps = td.checkpoints;
  const main = cps.filter(c => !c.alt);
  const alts = cps.filter(c => c.alt);
  let mono = true;
  for (let i = 1; i < main.length; i++) {
    if (main[i].s <= main[i - 1].s) mono = false;
    if (main[i].idx !== main[i - 1].idx + 1) mono = false;
  }
  let gmin = 1e9, gmax = -1e9;
  for (let i = 0; i < main.length; i++) {
    const a = main[i].s, b = main[(i + 1) % main.length].s;
    let g = b - a; if (g <= 0) g += L;
    gmin = Math.min(gmin, g); gmax = Math.max(gmax, g);
  }
  const bigN = cps.filter(c => c.big).length;
  const jumpN = cps.filter(c => c.jump).length;
  console.log(`  checkpoints ${main.length} main + ${alts.length} shortcut alternates   ` +
    `spacing ${f1(gmin)}..${f1(gmax)} m   gates=${bigN}   onJumpLip=${jumpN}`);
  if (!mono) fail(id, 'checkpoint s / idx are not monotonic');
  if (gmin < MIN_CP_GAP) fail(id, `checkpoint spacing ${f1(gmin)} m < ${MIN_CP_GAP} m`);
  if (gmax > MAX_CP_GAP) fail(id, `checkpoint spacing ${f1(gmax)} m > ${MAX_CP_GAP} m`);
  if (jumpN !== td.jumps.length) fail(id, `${td.jumps.length} jumps but ${jumpN} lip checkpoints`);
  for (const a of alts) {
    if (!main.some(m => m.idx === a.idx)) fail(id, `alternate checkpoint idx ${a.idx} has no main twin`);
  }
  if (def.shortcut && alts.length === 0) fail(id, 'shortcut bypasses no checkpoint — it would be free');

  /* ---------- 3. grid slots ---------- */
  const gs = td.gridSlots;
  let gsOk = gs.length === 8, gsExt = 0, gsOff = 0;
  for (const g of gs) {
    gsExt = Math.max(gsExt, Math.abs(g.x), Math.abs(g.z));
    const n = sp.nearest(g.x, g.z, { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 });
    gsOff = Math.max(gsOff, n.d);
    if (!Number.isFinite(g.yaw)) gsOk = false;
  }
  console.log(`  grid        ${gs.length} slots   max|xz|=${f1(gsExt)} m   ` +
    `max offset from centreline=${f1(gsOff)} m`);
  if (!gsOk) fail(id, 'grid slots malformed');
  if (gsExt > PLAYABLE) fail(id, 'grid slots outside the playable extent');
  if (gsOff > 4.0) fail(id, `grid slot sits ${f1(gsOff)} m off the centreline`);

  /* ---------- 4. racing line ---------- */
  const rl = td.racingLine;
  let vmin = 1e9, vmax = -1e9, latMax = 0, rlOff = 0;
  for (const r of rl) {
    vmin = Math.min(vmin, r.speed); vmax = Math.max(vmax, r.speed);
    latMax = Math.max(latMax, Math.abs(r.lat));
    rlOff = Math.max(rlOff, Math.abs(r.lat) - sp.widthAt(r.s));
  }
  console.log(`  racingLine  ${rl.length} pts @ ${f1(L / rl.length)} m   ` +
    `speed ${f1(vmin)}..${f1(vmax)} m/s (${(vmin * 3.6).toFixed(0)}..${(vmax * 3.6).toFixed(0)} km/h)   ` +
    `max apex offset ${f1(latMax)} m`);
  if (vmin < MIN_RL_SPEED) fail(id, `racing-line speed ${f1(vmin)} m/s < ${MIN_RL_SPEED}`);
  if (rlOff > 0) fail(id, `racing line leaves the road by ${f1(rlOff)} m`);

  /* ---------- 5. jumps ---------- */
  for (const j of td.jumps) {
    const deg = (j.angle * 57.2958).toFixed(0);
    const G = 12.8, s2 = Math.sin(2 * j.angle);
    const need = j.gap > 0 ? Math.sqrt((j.gap + 7) * G / s2) : 0;
    const at30 = 30 * 30 * s2 / G;
    const air30 = Math.pow(30 * Math.sin(j.angle), 2) / (2 * G);
    console.log(`  jump @s=${String(Math.round(j.s)).padStart(4)}  len=${j.len} h=${j.h}` +
      (j.gap ? ` GAP=${j.gap}m` : '        ') +
      `  lip=${deg}deg  @30m/s: ${at30.toFixed(0)} m long, ${air30.toFixed(1)} m high` +
      (need ? `  (needs >=${need.toFixed(1)} m/s)` : ''));
    if (j.gap > 0 && need > 34) fail(id, `gap at s=${Math.round(j.s)} needs ${need.toFixed(1)} m/s — unclearable`);
  }

  /* ---------- 6. surfaces actually used ---------- */
  const used = new Set();
  for (const r of rl) used.add(r.surface);
  console.log(`  surfaces on the line: ${[...used].map(i => SURFACES[i].name).join(', ')}`);

  /* ---------- 7. self-intersection at road width ---------- */
  let worst = Infinity, worstAt = null;
  const STEP = 2;
  const pi = { x: 0, y: 0, z: 0 }, pj = { x: 0, y: 0, z: 0 };
  for (let a = 0; a < L; a += STEP) {
    sp.posAt(a, pi); const wi = sp.widthAt(a);
    for (let b = a + CROSS_MIN_DS; b < L; b += STEP) {
      if (L - (b - a) < CROSS_MIN_DS) continue;              // wrap-around neighbours
      sp.posAt(b, pj);
      const d = Math.hypot(pj.x - pi.x, pj.z - pi.z);
      const need = 0.8 * (wi + sp.widthAt(b));
      if (d - need < worst) { worst = d - need; worstAt = [a, b, d]; }
    }
  }
  console.log(`  separation  closest non-adjacent pass leaves ${f1(worst)} m of margin` +
    (worstAt ? ` (s=${worstAt[0]} vs s=${worstAt[1]}, ${f1(worstAt[2])} m apart)` : ''));
  if (worst < 0) fail(id, `loop crosses itself at road width near s=${worstAt[0]} / s=${worstAt[1]}`);

  /* shortcut vs main line, same rule */
  if (td.shortcutSpline) {
    const ss = td.shortcutSpline, SL = ss.length;
    const s0 = sp.wrapS(def.shortcut.s0), s1 = sp.wrapS(def.shortcut.s1);
    let sworst = Infinity;
    for (let t = 0; t <= SL; t += STEP) {
      ss.posAt(t, pi); const wi = ss.widthAt(t);
      for (let b = 0; b < L; b += STEP) {
        // ignore the main line inside the bypassed span plus a 30 m apron:
        // that is the stretch the detour is deliberately shadowing
        const inSpan = (s1 > s0) ? (b > s0 - 30 && b < s1 + 30) : (b > s0 - 30 || b < s1 + 30);
        if (inSpan) continue;
        sp.posAt(b, pj);
        const d = Math.hypot(pj.x - pi.x, pj.z - pi.z);
        sworst = Math.min(sworst, d - 0.8 * (wi + sp.widthAt(b)));
      }
    }
    console.log(`  shortcut    ${f1(SL)} m detour vs ${f1(bypassLen(sp, s0, s1))} m of main line   ` +
      `clearance to unrelated road ${f1(sworst)} m`);
    if (sworst < 0) fail(id, 'shortcut overlaps an unrelated part of the main loop');
    const e0 = ss.posAt(0, { x: 0, y: 0, z: 0 });
    const eN = ss.posAt(SL, { x: 0, y: 0, z: 0 });
    const d0 = sp.nearest(e0.x, e0.z, { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 }).d;
    const dN = sp.nearest(eN.x, eN.z, { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 }).d;
    if (d0 > 3 || dN > 3) fail(id, `shortcut endpoints are ${f1(d0)}/${f1(dN)} m off the main line`);
  }

  /* ---------- 8. nearest() round-trip ---------- */
  const rng = rngFrom(def.seed);
  let worstErr = 0, worstCase = null, worstPt = 0;
  const nout = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
  for (let i = 0; i < NEAREST_SAMPLES; i++) {
    const s = rng() * L;
    /* Lateral reach is capped at 0.7 of the LOCAL radius of curvature, and that
       is geometry, not a fudge: past the centre of curvature the offset curve
       folds through itself, the generating s stops being the closest point on
       the centreline, and "nearest() should return s" is simply false. Inside
       that limit the mapping is one-to-one and the tolerance is meaningful.
       The point round-trip below is asserted at EVERY probe, including the
       folded ones, because that is the property the race and AI code use. */
    const k = Math.abs(sp.curvatureAt(s));
    const reach = Math.min(55, k > 1e-5 ? 0.7 / k : 55);
    const lat = (rng() * 2 - 1) * reach;
    const q = sp.offsetPoint(s, lat, { x: 0, y: 0, z: 0 });
    sp.nearest(q.x, q.z, nout);
    let e = Math.abs(nout.s - s);
    if (e > L / 2) e = L - e;
    const back = sp.offsetPoint(nout.s, nout.lat, { x: 0, y: 0, z: 0 });
    const perr = Math.hypot(back.x - q.x, back.z - q.z);
    if (perr > worstPt) worstPt = perr;
    if (e > worstErr) { worstErr = e; worstCase = [s, lat, nout.s]; }
    if (Math.abs(lat) > 1 && Math.sign(nout.lat) !== Math.sign(lat)) {
      fail(id, `nearest() side flipped at s=${f1(s)} lat=${f1(lat)}`);
    }
  }
  /* Second sweep: the hostile queries the reset system will make — far off
     course, behind a wall, on the wrong side of a hairpin. Here the assertion
     is against a BRUTE-FORCE scan of the whole 1 m table: the bucket grid must
     find the same winner everywhere inside the playable extent. (The
     offsetPoint round-trip is not asserted out here — 500 m from the road, a
     tenth of a degree between the chord and the smoothed tangent is metres of
     reconstruction error and means nothing.) */
  let stressD = 0;
  for (let i = 0; i < NEAREST_SAMPLES; i++) {
    const qx = (rng() * 2 - 1) * PLAYABLE, qz = (rng() * 2 - 1) * PLAYABLE;
    sp.nearest(qx, qz, nout);
    if (Math.abs(Math.hypot(nout.x - qx, nout.z - qz) - nout.d) > 1e-3) {
      fail(id, 'nearest() d does not match its own returned point');
    }
    let bd = Infinity;
    for (let s = 0; s < L; s += 1) {
      sp.posAt(s, pi);
      const d = Math.hypot(pi.x - qx, pi.z - qz);
      if (d < bd) bd = d;
    }
    stressD = Math.max(stressD, nout.d - bd);
  }
  console.log(`  nearest()   ${NEAREST_SAMPLES} on-corridor probes: worst |ds|=${f1(worstErr)} m, ` +
    `round-trip ${f1(worstPt)} m | ${NEAREST_SAMPLES} probes over +-${PLAYABLE} m: ` +
    `worst excess over brute force ${stressD.toFixed(3)} m`);
  if (worstErr > NEAREST_TOL) {
    fail(id, `nearest() off by ${f1(worstErr)} m (s=${f1(worstCase[0])} lat=${f1(worstCase[1])} -> ${f1(worstCase[2])})`);
  }
  if (worstPt > 0.3) fail(id, 'nearest() point round-trip is not exact on the corridor');
  if (stressD > 0.05) fail(id, `bucket grid missed the true nearest by ${f1(stressD)} m somewhere in the playable extent`);
}

function bypassLen(sp, s0, s1) { let d = s1 - s0; if (d <= 0) d += sp.length; return d; }

console.log(failures === 0
  ? '\nAll tracks pass.\n'
  : `\n${failures} FAILURE(S).\n`);
process.exit(failures === 0 ? 0 : 1);

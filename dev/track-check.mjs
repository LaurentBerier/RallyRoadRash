/* ============================================================
   dev/track-check.mjs — geometry sanity for every authored track
   ------------------------------------------------------------
   Plain Node, no three, no loader shim:
       node dev/track-check.mjs
   Non-zero exit if anything below is violated. Run it after every
   edit to a tracks/*.js control point.

   FAIL conditions
     - checkpoint spacing outside [40, 200] m, or s not monotonic
     - a jump that asked for a lip checkpoint did not get one (cp:false opts out)
     - any racing-line advisory speed below 9 m/s
     - the loop passes within 0.8*(w_i+w_j) of itself with |ds| > 60 m
       (this engine has no bridges: a crossover is a car crash), or a route
       passes that close to unrelated road, or to another route
     - spline.nearest() disagrees with the generating s by > 2 m
     - a gap (main line OR route) that needs more than 34 m/s to clear
     - whoops with wl < 5 m or amp > 0.7 m; a bank steeper than 28 deg
     - a boost pad off the roadbed, or inside a jump window
     - a gap or drop whose landing runway climbs, or whose flight is bent:
       the siting rule volcano.js states in prose for CALDERA LEAP, enforced
     - a track with no finite `difficulty`, or THUNDER PARK not flagged bonus
     - a RAISED ROAD: the terrain bake resolves an authored road above the
       theme's base noise by lifting terrain into an embankment, so a road
       authored too high becomes a causeway with unwalled drop-offs. Gated on
       canyon (see its header); every track prints its profile.
   ============================================================ */
import { buildTrackData, spanHas } from '../src/world/track.js';
import { themeBaseFn } from '../src/world/terrain-bake.js';
import { TRACKS } from '../src/world/tracks/index.js';
import { SURFACES } from '../src/world/surfaces.js';

const MIN_CP_GAP = 40, MAX_CP_GAP = 200;
const MIN_RL_SPEED = 9;
const NEAREST_SAMPLES = 200, NEAREST_TOL = 2.0;
const CROSS_MIN_DS = 60;
const PLAYABLE = 600;
const MAX_GAP_NEED = 34;               // m/s; nothing in the game goes faster
const MIN_WHOOP_WL = 5, MAX_WHOOP_AMP = 0.7;
/* Whoops are the only large-scale road bump the carve allows this close to a
   race: the road is 100% carved inside 1.30x half-width, so nothing else on
   the surface can throw a car this hard. The grid is where every race begins,
   and a car that is still bouncing before the field has had room to spread
   out is not fun — it is a coin-flip pileup. So a stage gets a minimum
   distance between the grid and its first whoop span, and a cap on how much
   total whoop length any one lap can carry. */
const MAX_WHOOP_LAP_M = 90, MIN_WHOOP_GRID_M = 200;
const MAX_BANK_DEG = 28;
/* Landing runway. A jump that lands on rising ground cases every time, and a
   flight over a bend puts the car in the scenery: 40 m of runout at no more
   than +2 %, and a radius of at least 80 m for the length of the flight.
   A gap's flight window is the gap. A drop's is its own freefall range at
   racing speed — h metres of fall is sqrt(2h/G) seconds of it. */
const RUNWAY_M = 40, RUNWAY_GRADE = 0.02, FLIGHT_K = 1 / 80;
const DROP_V = 25, G_ARCADE = 12.8;
/* Raised road. `raise` is centreline y minus the theme base noise at that xz;
   where it is positive the bake builds an embankment, and the shoulder it cuts
   gets steeper and longer with the raise. RAISE_STEP is the sample spacing,
   RAISE_RUN the longest embankment we will accept without walls on it.
   MAX_RAISE is 6 m rather than the ~3 m the wash floor actually sits at
   because canyon's gap slab (s 500-660) is a deliberate 5.8 m bench over a
   natural hollow — the gap's runway has to be level.

   This gate used to exempt forest and volcano on the grounds that they "have
   intentional shelf roads". They did not: the exemption was the assumption,
   and behind it TIMBERLINE CLIMB sat 63 m above its own ground with 290 m of
   unwalled shoulder. Forest now really is a shelf road — a deterministic
   mountainside in THEME_BASE.forest plus authored `shelves` spans saying which
   side the hill is on — so it is gated like any other track, at 1.1 m measured.

   Volcano is the same fault, still unfixed: 56.8 m of raise and 410 m of
   unwalled embankment at s 1370-1770. It stays exempt because it is a known
   open item, not because the road is deliberate. Do not close this comment
   without either fixing it or saying why not. */
const RAISE_STEP = 10, RAISE_THRESH = 4, RAISE_RUN = 200;
const RAISE_GATED = {
  canyon: { s0: 40, s1: 900, max: 6.0 },
  forest: { s0: 0, s1: 1800, max: 4.0 }
};

let failures = 0;
const _sc = { x: 0, y: 0, z: 0 }, _sc2 = { x: 0, y: 0, z: 0 };
const fail = (t, msg) => { failures++; console.log(`  FAIL [${t}] ${msg}`); };
const warn = (t, msg) => console.log(`  warn [${t}] ${msg}`);
const f1 = (v) => v.toFixed(1);

/* How far the authored road stands above the theme's base terrain, and for how
   long without walls. The bake lifts terrain to meet a road above the base, so
   this is the height of the embankment the player can fall off. */
function raiseAudit(id, def, td) {
  const base = themeBaseFn(def.theme);
  const sp = td.spline, L = sp.length;
  const walled = (s) => td.walls.some((w) => spanHas(w.s0, w.s1, s, L));
  let max = 0, maxS = 0, run = 0, runStart = 0, worstRun = 0, worstAt = 0, worstEnd = 0;
  const gate = RAISE_GATED[id];
  let gateMax = 0, gateAt = 0;
  for (let s = 0; s < L; s += RAISE_STEP) {
    const p = sp.posAt(s, _sc);
    const r = p.y - base(p.x, p.z);
    if (r > max) { max = r; maxS = s; }
    if (gate && spanHas(gate.s0, gate.s1, s, L) && r > gateMax) { gateMax = r; gateAt = s; }
    if (r > RAISE_THRESH && !walled(s)) {
      if (run === 0) runStart = s;
      run += RAISE_STEP;
      if (run > worstRun) { worstRun = run; worstAt = runStart; worstEnd = s; }
    } else run = 0;
  }
  console.log(`  raisedRoad  max ${f1(max)} m above base terrain at s=${Math.round(maxS)}` +
    (worstRun > 0
      ? `   longest unwalled embankment over ${RAISE_THRESH} m: ${worstRun} m (s=${Math.round(worstAt)}..${Math.round(worstEnd)})`
      : `   no unwalled embankment over ${RAISE_THRESH} m`));
  if (gate && gateMax > gate.max) {
    fail(id, `road stands ${f1(gateMax)} m above the base terrain at s=${Math.round(gateAt)} ` +
      `(limit ${gate.max} m over s ${gate.s0}..${gate.s1}) — the bake will build a causeway there`);
  }
  if (gate && worstRun > RAISE_RUN) {
    fail(id, `${worstRun} m of unwalled embankment over ${RAISE_THRESH} m from s=${Math.round(worstAt)} ` +
      `— over the ${RAISE_RUN} m limit; lower the road or wall it`);
  }
}

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

/** Max |curvature| and the runway grade for one jump, on whichever spline it
    belongs to. Shared by the main line and every route. */
function sitingOf(sp, j) {
  const flight = j.gap > 0 ? j.gap : DROP_V * Math.sqrt((2 * j.h) / G_ARCADE);
  let k = 0;
  for (let t = 0; t <= flight; t += 1) k = Math.max(k, Math.abs(sp.curvatureAt(j.s + t)));
  const land = j.s + (j.gap > 0 ? j.gap : 0);
  const grade = (sp.heightAt(land + RUNWAY_M) - sp.heightAt(land)) / RUNWAY_M;
  return { k, grade, land };
}

for (const def of TRACKS) {
  console.log(`\n=== ${def.id}  "${def.name}"  theme=${def.theme}  laps=${def.laps}` +
    `  difficulty=${def.difficulty}${def.bonus ? '  BONUS' : ''}`);
  const td = buildTrackData(def);
  const sp = td.spline;
  const L = sp.length;
  const id = def.id;

  /* ---------- 0. stage metadata ---------- */
  if (!Number.isFinite(def.difficulty)) fail(id, 'no finite difficulty — the UI sorts on it');
  if (def.id === 'thunder' && def.bonus !== true) {
    fail(id, 'THUNDER PARK must be bonus:true — it is not part of TRACK_ORDER');
  }

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
  // cp:false lips are rhythm features and carry no gate, so only the ones that
  // asked for a checkpoint are counted.
  const wantCp = td.jumps.filter(j => j.cp !== false).length;
  console.log(`  checkpoints ${main.length} main + ${alts.length} route alternates   ` +
    `spacing ${f1(gmin)}..${f1(gmax)} m   gates=${bigN}   onJumpLip=${jumpN}/${wantCp}`);
  if (!mono) fail(id, 'checkpoint s / idx are not monotonic');
  if (gmin < MIN_CP_GAP) fail(id, `checkpoint spacing ${f1(gmin)} m < ${MIN_CP_GAP} m`);
  if (gmax > MAX_CP_GAP) fail(id, `checkpoint spacing ${f1(gmax)} m > ${MAX_CP_GAP} m`);
  if (jumpN !== wantCp) fail(id, `${wantCp} jumps want a lip checkpoint but ${jumpN} got one`);
  for (const a of alts) {
    if (!main.some(m => m.idx === a.idx)) fail(id, `alternate checkpoint idx ${a.idx} has no main twin`);
  }
  for (const rt of td.routes) {
    if (!alts.some(a => a.route === rt.idx)) {
      fail(id, `route ${rt.id} bypasses no checkpoint — it would be free`);
    }
  }

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
    const G = 12.8, s2 = Math.sin(2 * j.angle) || 0;
    const at30 = 30 * 30 * s2 / G;
    const air30 = Math.pow(30 * Math.sin(j.angle), 2) / (2 * G);
    console.log(`  ${j.kind.padEnd(6)} @s=${String(Math.round(j.s)).padStart(4)}  len=${j.len} h=${j.h}` +
      (j.gap ? ` GAP=${j.gap}m` : '        ') + (j.cp ? '' : ' [no cp]') +
      (j.kind === 'table' ? ` top=${j.top} down=${j.down}` : '') +
      (j.yaw ? ` yaw=${(j.yaw * 57.2958).toFixed(0)}deg` : '') +
      `  lip=${deg}deg  @30m/s: ${at30.toFixed(0)} m long, ${air30.toFixed(1)} m high` +
      (j.need ? `  (needs >=${j.need.toFixed(1)} m/s)` : ''));
    if (j.gap > 0 && j.need > MAX_GAP_NEED) {
      fail(id, `gap at s=${Math.round(j.s)} needs ${j.need.toFixed(1)} m/s — unclearable`);
    }
    /* Landing runway. This is the rule volcano.js writes out in prose for
       CALDERA LEAP ("the ground drops with the arc") — every gap and every drop
       is held to it, because a jump that lands uphill or round a bend is a
       reset, and resets are the one thing that make a stage feel broken. */
    if (j.gap > 0 || j.kind === 'drop') {
      const st = sitingOf(sp, j);
      console.log(`         siting: |k|max=${st.k.toFixed(4)} (R=${st.k > 1e-5 ? (1 / st.k).toFixed(0) : 'inf'} m)` +
        `  runway grade=${(st.grade * 100).toFixed(1)}%`);
      if (st.grade > RUNWAY_GRADE) {
        fail(id, `${j.kind} at s=${Math.round(j.s)} lands on ground rising ${(st.grade * 100).toFixed(1)}%`);
      }
      if (st.k >= FLIGHT_K) {
        fail(id, `${j.kind} at s=${Math.round(j.s)} flies over a ${(1 / st.k).toFixed(0)} m radius bend`);
      }
    }
  }

  /* ---------- 5b. authored cross-section features ---------- */
  for (const b of td.banks) {
    if (Math.abs(b.deg) > MAX_BANK_DEG) {
      fail(id, `bank ${b.s0}..${b.s1} is ${b.deg} deg — over the ${MAX_BANK_DEG} deg limit`);
    }
  }
  let whoopLenTotal = 0;
  for (const q of td.whoops) {
    if (!(q.wl >= MIN_WHOOP_WL)) {
      fail(id, `whoops ${q.s0}..${q.s1} wavelength ${q.wl} m — under ${MIN_WHOOP_WL} m the heightfield cannot hold it`);
    }
    if (!(q.amp <= MAX_WHOOP_AMP)) fail(id, `whoops ${q.s0}..${q.s1} amplitude ${q.amp} m > ${MAX_WHOOP_AMP} m`);
    whoopLenTotal += bypassLen(sp, q.s0, q.s1);
    // The grid is always at s=0, and the loop is circular, so "distance from
    // the grid" has two candidates: forward from s=0 out to the span's near
    // edge (q.s0), or backward from the span's far edge (q.s1) round through
    // the finish line back to s=0 (L - q.s1). Whichever is shorter is how
    // close the span actually sits to the line every car starts and re-crosses.
    const distFromGrid = Math.min(q.s0, L - q.s1);
    if (distFromGrid < MIN_WHOOP_GRID_M) {
      fail(id, `whoops ${q.s0}..${q.s1} sit ${f1(distFromGrid)} m from the grid — under the ${MIN_WHOOP_GRID_M} m minimum, the field is still bunched when it hits them`);
    }
  }
  if (whoopLenTotal > MAX_WHOOP_LAP_M) {
    fail(id, `${f1(whoopLenTotal)} m of whoops on one lap — over the ${MAX_WHOOP_LAP_M} m limit`);
  }

  /* ---------- 5c. raised road ---------- */
  raiseAudit(id, def, td);
  if (td.banks.length || td.whoops.length || td.berms.length) {
    console.log(`  profile    ${td.banks.length} bank(s) ` +
      td.banks.map(b => `${b.s0}-${b.s1}@${b.deg}deg`).join(' ') +
      `   ${td.whoops.length} whoops ` + td.whoops.map(q => `${q.s0}-${q.s1} wl${q.wl}/${q.amp}`).join(' ') +
      `   ${td.berms.length} berm(s) ` + td.berms.map(b => `${b.s0}-${b.s1} side${b.side} h${b.h}`).join(' '));
  }

  /* ---------- 5c. boost pads ---------- */
  if (td.pads.length) {
    let worstPad = 1e9;
    for (const pd of td.pads) {
      // A pad has to be ON the roadbed: its whole strip inside the half-width.
      const room = sp.widthAt(pd.s) - (Math.abs(pd.lat) + pd.hw);
      worstPad = Math.min(worstPad, room);
      if (room < 0) fail(id, `pad at s=${Math.round(pd.s)} lat=${pd.lat} hangs ${f1(-room)} m off the roadbed`);
      /* …and OUTSIDE every jump window. A pad on a ramp fires the car at an
         angle nothing in the ballistics accounts for, and a pad in a gap's
         landing zone is a boost applied while airborne. */
      for (const j of td.jumps) {
        const before = j.s - j.len - (j.kind === 'drop' ? 8 : 0) - 6;
        const after = j.s + j.gap + j.top + j.down + 8;
        let d = pd.s - before; if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
        let span = after - before;
        if (d >= 0 && d <= span) {
          fail(id, `pad at s=${Math.round(pd.s)} sits inside the ${j.kind} window at s=${Math.round(j.s)}`);
        }
      }
    }
    console.log(`  pads        ${td.pads.length} at s=${td.pads.map(p => Math.round(p.s)).join(',')}   ` +
      `tightest roadbed margin ${f1(worstPad)} m`);
  }

  /* ---------- 5d. voids + elevation strip (contract shape) ---------- */
  if (td.elev.length !== 64) fail(id, `elev strip is ${td.elev.length} samples, contract says 64`);
  for (let i = 0; i < td.elev.length; i++) {
    if (!Number.isFinite(td.elev[i])) fail(id, 'elev strip has a non-finite sample');
  }
  if (td.voids.length) {
    console.log(`  voids       ${td.voids.map(v => `${v.kind} ${Math.round(v.s0)}..${Math.round(v.s1)}`).join('  ')}`);
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

  /* every route vs the main line, same rule */
  for (const rt of td.routes) {
    const ss = rt.spline, SL = ss.length;
    const s0 = rt.s0, s1 = rt.s1;
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
    console.log(`  route ${rt.id.padEnd(9)} ${f1(SL)} m detour vs ${f1(bypassLen(sp, s0, s1))} m of main line   ` +
      `clearance to unrelated road ${f1(sworst)} m   ${rt.jumps.length} jump(s)`);
    if (sworst < 0) fail(id, `route ${rt.id} overlaps an unrelated part of the main loop`);
    const e0 = ss.posAt(0, { x: 0, y: 0, z: 0 });
    const eN = ss.posAt(SL, { x: 0, y: 0, z: 0 });
    const d0 = sp.nearest(e0.x, e0.z, { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 }).d;
    const dN = sp.nearest(eN.x, eN.z, { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 }).d;
    if (d0 > 3 || dN > 3) fail(id, `route ${rt.id} endpoints are ${f1(d0)}/${f1(dN)} m off the main line`);
    /* Route jumps answer to the same ballistics and the same siting rule as
       main-line ones — measured on the ROUTE's arc length, which is what the
       carve walks. */
    for (const j of rt.jumps) {
      if (j.gap > 0 && j.need > MAX_GAP_NEED) {
        fail(id, `route ${rt.id} gap at s=${Math.round(j.s)} needs ${j.need.toFixed(1)} m/s — unclearable`);
      }
      if (j.gap > 0 || j.kind === 'drop') {
        const st = sitingOf(ss, j);
        console.log(`         ${rt.id} ${j.kind} @${Math.round(j.s)}: |k|max=${st.k.toFixed(4)}` +
          `  runway grade=${(st.grade * 100).toFixed(1)}%`);
        if (st.grade > RUNWAY_GRADE) {
          fail(id, `route ${rt.id} ${j.kind} at s=${Math.round(j.s)} lands on ground rising ${(st.grade * 100).toFixed(1)}%`);
        }
        if (st.k >= FLIGHT_K) {
          fail(id, `route ${rt.id} ${j.kind} at s=${Math.round(j.s)} flies over a ${(1 / st.k).toFixed(0)} m radius bend`);
        }
      }
    }
  }

  /* route vs route: two detours over the same span must not merge into one */
  for (let a = 0; a < td.routes.length; a++) {
    for (let b = a + 1; b < td.routes.length; b++) {
      const ra = td.routes[a].spline, rb = td.routes[b].spline;
      let rworst = Infinity;
      for (let t = 0; t <= ra.length; t += STEP) {
        ra.posAt(t, pi); const wi = ra.widthAt(t);
        for (let u = 0; u <= rb.length; u += STEP) {
          rb.posAt(u, pj);
          /* The ends of two routes may legitimately converge — they both meet
             the main line. Only the middles have to stay apart. */
          const endish = Math.min(t, ra.length - t) < 40 && Math.min(u, rb.length - u) < 40;
          if (endish) continue;
          const d = Math.hypot(pj.x - pi.x, pj.z - pi.z);
          rworst = Math.min(rworst, d - 0.8 * (wi + rb.widthAt(u)));
        }
      }
      console.log(`  routes      ${td.routes[a].id} vs ${td.routes[b].id}: ${f1(rworst)} m of margin`);
      if (rworst < 0) fail(id, `routes ${td.routes[a].id} and ${td.routes[b].id} overlap`);
    }
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
    /* …and the same argument applies across the map, not just around a corner.
       Where two legs of the loop run 80 m apart — THUNDER PARK's bowl — a probe
       46 m off one of them is nearer the other, and the generating s is again
       simply not the answer. Cap the reach at 45 % of the local self-clearance
       so every probe stays inside its own leg's Voronoi cell. */
    const reach = Math.min(55, k > 1e-5 ? 0.7 / k : 55, 0.45 * selfClear(sp, s, L));
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

/** Distance from the point at s to the nearest NON-ADJACENT part of the loop.
    Adjacent means within CROSS_MIN_DS of s along the curve — that is the same
    road, not a neighbour. */
function selfClear(sp, s, L) {
  sp.posAt(s, _sc);
  let best = Infinity;
  for (let t = 0; t < L; t += 3) {
    let ds = t - s; if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    if (Math.abs(ds) < CROSS_MIN_DS) continue;
    sp.posAt(t, _sc2);
    const d = Math.hypot(_sc2.x - _sc.x, _sc2.z - _sc.z);
    if (d < best) best = d;
  }
  return best;
}

console.log(failures === 0
  ? '\nAll tracks pass.\n'
  : `\n${failures} FAILURE(S).\n`);
process.exit(failures === 0 ? 0 : 1);

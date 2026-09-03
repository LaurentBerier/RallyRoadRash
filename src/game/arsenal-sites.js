/* ============================================================
   WHERE THE PICKUPS GO — a pure function of the track and its seed
   ------------------------------------------------------------
   Split out of arsenal.js for the same reason P4 split kit-wasteland.js:
   the live file was over the house line, and this half has no business
   knowing three.js exists. No three, no DOM — plain math over
   buildTrackData's output and a terrain's heightAt — so
   dev/weapons-check.mjs can site every stage twice under bare Node and
   compare the two to the bit.

   Rejecting rather than nudging keeps the layout deterministic: the same
   track always gets the same pickups, which matters because a collider
   that moves between races is a bug and a pickup that moves is a lie about
   the track. The one draw from the seeded stream is a small lateral jitter
   on each can — enough that "same seed, same sites" is a statement about
   the stream rather than about the geometry.

   CRATES go in rows across the straights, on the PACK_SPACING search the
   wave-5 boxes used. The window is wide (140 m against a ~400 m row
   spacing) because a narrow one leaves HOLES, and a hole is worse than an
   uneven row: QA found CALDERA RUN placing four rows on a 2 km lap with a
   776 m dead stretch, because two ideal sites both landed inside jump
   exclusion zones and a 40 m search could not escape them.

   CANS go where a good line goes: a little past the point a corner opens,
   and a little past a crest — spaced so the road is not paved with them,
   and never inside a jump window, on a gate, or on the grid. A track with
   neither (a flat oval) gets them midway between crate rows instead, so a
   player can at least plan for one.
   ============================================================ */
import { TUNE } from './config.js';
import { PICKUP } from './weapons.js';
import { makeRNG, clamp } from '../core/rng.js';

const W = TUNE.weapons;

/* A pickup has to be readable from 150 m at 40 m/s. The kit shapes stand on
   the ground (contract 8.8); a small hover keeps the crate off the ruts and
   the can's valve turning where the low sun can find it. Exported because
   arsenal.js places the halo under the hover. */
export const CRATE_HOVER = 0.30;        // m above the road
export const CAN_HOVER = 0.25;

/* Crate rows are laid out in packs across the road. `lapLength / 420`
   gives seven rows on the 900 m tutorial and nine on the 2 km caldera —
   often enough that the back of the field always finds one, rare enough
   that the road is not paved with them. */
const PACK_SPACING = 420;
/* The can scan. Walk the lap at CAN_STEP; a corner EXIT is where the
   curvature has been over K_CORNER and drops under K_EXIT, a CREST is a
   local maximum of road height that rose CREST_RISE over the last
   CREST_BACK metres. Both get the can a little way past them, so the reward
   for a good exit is on the exit, not in the apex.

   The thresholds are MEASURED against the five stages, not guessed: these
   roads are rally roads, and a 70 m radius is a corner on them — at 1/40
   the tutorial has no corners at all and the caldera has three. */
const CAN_STEP = 6;
const K_CORNER = 1 / 70, K_EXIT = 1 / 120;
const EXIT_AHEAD = 14;
const CREST_RISE = 1.0, CREST_BACK = 40, CREST_AHEAD = 10;
const CAN_GAP = 110;             // m between cans
const ROW_GAP = 35;              // m from a crate row
const CAN_MAX_PER_M = 1 / 280;   // ≈ 3 on the tutorial, 7 on the caldera
const CAN_MIN = 2;               // a stage with fewer exits than this gets cans between rows
const ROW_K_MAX = 1 / 62;        // curvature ceiling for a crate row: straights

const _pp = { x: 0, y: 0, z: 0 };
const ONE = [0];
const BOTH = [-1, 1];

/**
 * @param trackData  buildTrackData() output (spline, racingLine, jumps, …)
 * @param terrain    anything with heightAt(x, z)
 * @param seed       the track seed
 * @returns { n, kind: Int8Array, x, y, z, s, lat: Float32Array } sorted by s
 */
export function sitePickups(trackData, terrain, seed) {
  const sp = trackData.spline;
  const L = trackData.lapLength || sp.length;
  const line = trackData.racingLine || [];
  const jumps = trackData.jumps || [];
  const cps = trackData.checkpoints || [];
  const grid = trackData.gridSlots || [];
  const step = line.length ? L / line.length : 6;
  /* Hashed, not masked: `| 1` on the raw seed folded every even track seed
     onto its odd neighbour and two stages a seed apart sited identically. */
  const rng = makeRNG((Math.imul(seed | 0, 0x9E3779B1) ^ 0x2A11) >>> 0);
  const rows = W.crateRows;

  const out = [];                              // { kind, s, lat }

  /* ---- 1. crate rows ---- */
  const packs = clamp(Math.round(L / PACK_SPACING), 3, 6);
  const rowS = [];
  for (let p = 0; p < packs; p++) {
    const want = (p + 0.5) * L / packs;
    let best = -1;
    for (let d = 0; d <= 140 && best < 0; d += 6) {
      for (const sgn of (d === 0 ? ONE : BOTH)) {
        const s = sp.wrapS(want + sgn * d);
        if (!siteOk(sp, L, s, line, step, jumps, cps, grid, ROW_K_MAX)) continue;
        best = s; break;
      }
    }
    if (best < 0) continue;
    rowS.push(best);
    const w = sp.widthAt(best);
    const n = clamp(Math.floor(w / 2.0), rows[0], rows[1]);
    for (let k = 0; k < n; k++) {
      const lat = n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * Math.max(1.2, w - 2.2);
      out.push({ kind: PICKUP.ROCKET, s: best, lat });
    }
  }

  /* ---- 2. nitro cans: corner exits and crests ---- */
  const M = Math.max(8, Math.round(L / CAN_STEP));
  const ds = L / M;
  const kk = new Float32Array(M), hh = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const s = i * ds;
    kk[i] = Math.abs(sp.curvatureAt(s));
    hh[i] = sp.posAt(s, _pp).y;
  }
  const back = Math.max(1, Math.round(CREST_BACK / ds));
  const cand = [];
  let inCorner = false, kPeak = 0;
  for (let i = 0; i < M; i++) {
    const k = kk[i];
    if (k > K_CORNER) { inCorner = true; if (k > kPeak) kPeak = k; }
    else if (inCorner && k < K_EXIT) {
      cand.push({ s: sp.wrapS(i * ds + EXIT_AHEAD), w: 1 + kPeak * 60 });
      inCorner = false; kPeak = 0;
    }
    const hp = hh[(i - 1 + M) % M], hn = hh[(i + 1) % M];
    if (hh[i] > hp && hh[i] >= hn) {
      let lo = hh[i];
      for (let j = 1; j <= back; j++) { const h = hh[(i - j + M) % M]; if (h < lo) lo = h; }
      const rise = hh[i] - lo;
      if (rise >= CREST_RISE) cand.push({ s: sp.wrapS(i * ds + CREST_AHEAD), w: 1 + rise * 0.5 });
    }
  }
  /* Best first, then greedy spacing. The sort key is deterministic and the
     tie-break is arc length, so two candidates of equal weight always fall
     the same way. */
  cand.sort((a, b) => (b.w - a.w) || (a.s - b.s));
  const canS = [];
  const maxCans = clamp(Math.round(L * CAN_MAX_PER_M), 2, 7);
  const okCan = (s) => {
    if (!siteOk(sp, L, s, line, step, jumps, cps, grid, Infinity)) return false;
    for (let j = 0; j < canS.length; j++) if (ringDist(s, canS[j], L) < CAN_GAP) return false;
    for (let j = 0; j < rowS.length; j++) if (ringDist(s, rowS[j], L) < ROW_GAP) return false;
    return true;
  };
  for (let i = 0; i < cand.length && canS.length < maxCans; i++) {
    if (okCan(cand[i].s)) canS.push(cand[i].s);
  }
  /* A stage with fewer exits than CAN_MIN (a flat oval, or the tutorial)
     tops up midway between crate rows — a can you can at least plan for. */
  if (canS.length < CAN_MIN && rowS.length > 1) {
    for (let i = 0; i < rowS.length && canS.length < CAN_MIN; i++) {
      const a = rowS[i], b = rowS[(i + 1) % rowS.length];
      const mid = sp.wrapS(a + ringDist(a, b, L) * 0.5);
      if (okCan(mid)) canS.push(mid);
    }
  }
  for (let i = 0; i < canS.length; i++) {
    const s = canS[i];
    const w = sp.widthAt(s);
    let lat = 0;
    if (line.length) {
      const idx = clamp(Math.round(s / Math.max(1e-3, step)), 0, line.length - 1);
      lat = (line[idx].lat || 0) * 0.8;
    }
    // the seeded jitter: a can sits on the line, give or take a car's width
    lat += (rng() - 0.5) * 0.8;
    lat = clamp(lat, -(w - 2.0), w - 2.0);
    out.push({ kind: PICKUP.NITRO, s, lat });
  }

  /* ---- 3. pack, sorted by arc length for arsenal.js's bucket ---- */
  out.sort((a, b) => (a.s - b.s) || (a.lat - b.lat));
  const n = out.length;
  const kind = new Int8Array(n);
  const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
  const ss = new Float32Array(n), ls = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = out[i];
    const q = sp.offsetPoint(e.s, e.lat, _pp);
    kind[i] = e.kind;
    xs[i] = q.x; zs[i] = q.z;
    ys[i] = terrain.heightAt(q.x, q.z) + (e.kind === PICKUP.ROCKET ? CRATE_HOVER : CAN_HOVER);
    ss[i] = e.s; ls[i] = e.lat;
  }
  return { n, kind, x: xs, y: ys, z: zs, s: ss, lat: ls };
}

/** Is `s` a reasonable place to put something you drive through? `kMax` is
    the curvature ceiling — crate rows want a straight, a can is allowed on
    the exit it was sited for. */
function siteOk(sp, L, s, line, step, jumps, cps, grid, kMax) {
  // Never in a jump window: a pickup on a lip is a pickup nobody can collect
  // and a swerve nobody can afford.
  for (let i = 0; i < jumps.length; i++) {
    const j = jumps[i];
    let d = s - (j.s - 40);
    if (d < 0) d += L;
    if (d < 40 + j.len + (j.gap || 0) + 25) return false;
  }
  // Not on a checkpoint disc — the gate furniture is already there.
  const q = sp.posAt(s, _pp);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const dx = q.x - c.x, dz = q.z - c.z;
    if (dx * dx + dz * dz < (c.r + 6) * (c.r + 6)) return false;
  }
  // Not on the grid, and not in the last stretch before the line.
  for (let i = 0; i < grid.length; i++) {
    const gd = grid[i];
    const dx = q.x - gd.x, dz = q.z - gd.z;
    if (dx * dx + dz * dz < 1600) return false;
  }
  if (s < 25 || s > L - 90) return false;
  // Straights and corner exits only for a row. A hairpin apex is the worst
  // possible place to ask somebody to choose a line.
  if (Math.abs(sp.curvatureAt(s)) > kMax) return false;
  // And not on the lava.
  if (line.length) {
    const idx = clamp(Math.round(s / Math.max(1e-3, step)), 0, line.length - 1);
    const pt = line[idx];
    if (pt && pt.jump) return false;
  }
  return true;
}

/** Shortest distance between two arc lengths on a loop of length L. */
export function ringDist(a, b, L) {
  let d = Math.abs(a - b);
  if (d > L * 0.5) d = L - d;
  return d;
}

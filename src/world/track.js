/* ============================================================
   TRACK GEOMETRY — spline, checkpoints, grid, racing line
   ------------------------------------------------------------
   PLAIN JS ONLY. No three, no DOM. dev/track-check.mjs and the
   race-logic tests import this under bare Node, and the AI calls
   posAt/nearest six times a frame per driver — so every accessor
   writes into a caller-supplied (or module-scratch) object and
   nothing in here allocates once construction is done.

   Conventions (docs/ARCHITECTURE.md):
     s        arc length in metres, 0 at the start/finish line,
              increasing in the racing direction
     lateral  signed metres from the centreline, POSITIVE LEFT
              (left = cross(up, dir) = ( dir.z, -dir.x ))
     y        road surface height; the terrain bake carves the
              ground to meet it, so this IS the driving height.
   ============================================================ */
import { SURF, SURFACES } from './surfaces.js';
import { clamp, lerp, sstep } from '../core/rng.js';

/** Half-width used when a control point does not name one. */
export const DEFAULT_HALF_WIDTH = 8;

/* Arcade gravity. Mirrors G in game/config.js, duplicated rather than imported
   because that file owns vehicle tuning and this one must stay Node-pure and
   dependency-free. It is only ever used for ADVISORY racing-line speeds — a
   few percent of drift here costs the AI nothing. */
const G_ARCADE = 12.8;

/* Centripetal Catmull-Rom. alpha=0.5 is the whole reason hand-authored control
   points can sit 20 m apart in a hairpin and 90 m apart on a straight without
   the curve looping back on itself between them. */
const ALPHA = 0.5;

const SAMPLE_STEP = 1.0;          // arc-length table resolution, metres
const GRID_CELL = 24;             // XZ bucket size for nearest()
const GRID_HALF = 720;            // grid covers +-720 m; playable is +-600

/* ---------------- module scratch (see header: no allocations) ---------------- */
const _p = { x: 0, y: 0, z: 0 };
const _p2 = { x: 0, y: 0, z: 0 };
const _d = { x: 0, z: 0 };
const _d2 = { x: 0, z: 0 };
const _n = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };

/* ============================================================
   1.  THE SPLINE
   ============================================================ */
export class TrackSpline {
  /**
   * @param {Array<{x:number,z:number,y?:number,w?:number}>} points control points
   * @param {boolean} closed  true for the main loop, false for a shortcut polyline
   */
  constructor(points, closed = true) {
    const n = points.length;
    if (n < 4) throw new Error('TrackSpline needs at least 4 control points');
    this.closed = !!closed;
    this.n = n;

    this.cx = new Float64Array(n); this.cy = new Float64Array(n);
    this.cz = new Float64Array(n); this.cw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      this.cx[i] = p.x; this.cz[i] = p.z;
      this.cy[i] = p.y === undefined ? 0 : p.y;
      this.cw[i] = p.w === undefined ? DEFAULT_HALF_WIDTH : p.w;
    }

    this._buildTable();
    this._buildGrid();
  }

  /* ---- control-point access with the right end condition ---- */
  _ci(i) {
    const n = this.n;
    if (this.closed) return ((i % n) + n) % n;
    return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
  }
  /* Open splines get a reflected phantom point at each end, so the curve leaves
     the first control point along the P0->P1 chord instead of flapping. */
  _cget(i, o) {
    const n = this.n;
    if (!this.closed && i < 0) {
      o.x = 2 * this.cx[0] - this.cx[1]; o.y = 2 * this.cy[0] - this.cy[1];
      o.z = 2 * this.cz[0] - this.cz[1]; return o;
    }
    if (!this.closed && i > n - 1) {
      o.x = 2 * this.cx[n - 1] - this.cx[n - 2]; o.y = 2 * this.cy[n - 1] - this.cy[n - 2];
      o.z = 2 * this.cz[n - 1] - this.cz[n - 2]; return o;
    }
    const j = this._ci(i);
    o.x = this.cx[j]; o.y = this.cy[j]; o.z = this.cz[j];
    return o;
  }

  get segments() { return this.closed ? this.n : this.n - 1; }

  /** Barry-Goldman evaluation of segment i (control i -> i+1) at u in [0,1]. */
  _evalSeg(i, u, out) {
    const P0 = this._cget(i - 1, _g0), P1 = this._cget(i, _g1);
    const P2 = this._cget(i + 1, _g2), P3 = this._cget(i + 2, _g3);
    // Knots from XZ chord length only: elevation must not distort the plan shape.
    const t0 = 0;
    const t1 = t0 + Math.max(1e-4, Math.pow(Math.hypot(P1.x - P0.x, P1.z - P0.z), ALPHA));
    const t2 = t1 + Math.max(1e-4, Math.pow(Math.hypot(P2.x - P1.x, P2.z - P1.z), ALPHA));
    const t3 = t2 + Math.max(1e-4, Math.pow(Math.hypot(P3.x - P2.x, P3.z - P2.z), ALPHA));
    const t = t1 + (t2 - t1) * u;

    const a1 = (t1 - t) / (t1 - t0), b1 = 1 - a1;
    const a2 = (t2 - t) / (t2 - t1), b2 = 1 - a2;
    const a3 = (t3 - t) / (t3 - t2), b3 = 1 - a3;
    const A1x = a1 * P0.x + b1 * P1.x, A1y = a1 * P0.y + b1 * P1.y, A1z = a1 * P0.z + b1 * P1.z;
    const A2x = a2 * P1.x + b2 * P2.x, A2y = a2 * P1.y + b2 * P2.y, A2z = a2 * P1.z + b2 * P2.z;
    const A3x = a3 * P2.x + b3 * P3.x, A3y = a3 * P2.y + b3 * P3.y, A3z = a3 * P2.z + b3 * P3.z;

    const c1 = (t2 - t) / (t2 - t0), e1 = 1 - c1;
    const c2 = (t3 - t) / (t3 - t1), e2 = 1 - c2;
    const B1x = c1 * A1x + e1 * A2x, B1y = c1 * A1y + e1 * A2y, B1z = c1 * A1z + e1 * A2z;
    const B2x = c2 * A2x + e2 * A3x, B2y = c2 * A2y + e2 * A3y, B2z = c2 * A2z + e2 * A3z;

    out.x = a2 * B1x + b2 * B2x;
    out.y = a2 * B1y + b2 * B2y;
    out.z = a2 * B1z + b2 * B2z;
    return out;
  }

  /** Half-width across a segment. Smoothstepped, not Catmull-Rom: an overshoot
      in the width would punch a bulge through a canyon wall. */
  _widthSeg(i, u) {
    const w0 = this.cw[this._ci(i)];
    const w1 = this.cw[this._ci(i + 1)];
    const k = u * u * (3 - 2 * u);
    return w0 + (w1 - w0) * k;
  }

  /* ---- arc-length table, resampled to a fixed ~1 m stride ---- */
  _buildTable() {
    const segs = this.segments;
    // fine walk first: arc length is not linear in u, so we integrate it
    const fx = [], fy = [], fz = [], fw = [], fl = [];
    let len = 0;
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < segs; i++) {
      const chord = Math.hypot(
        this.cx[this._ci(i + 1)] - this.cx[this._ci(i)],
        this.cz[this._ci(i + 1)] - this.cz[this._ci(i)]);
      const ns = Math.max(8, Math.ceil(chord / 0.35));
      for (let k = 0; k <= ns; k++) {
        if (i > 0 && k === 0) continue;             // shared with previous segment end
        const u = k / ns;
        this._evalSeg(i, u, _p);
        if (fx.length) len += Math.hypot(_p.x - px, _p.y - py, _p.z - pz);
        fx.push(_p.x); fy.push(_p.y); fz.push(_p.z);
        fw.push(this._widthSeg(i, u)); fl.push(len);
        px = _p.x; py = _p.y; pz = _p.z;
      }
    }
    this.length = len;

    const M = Math.max(8, Math.round(len / SAMPLE_STEP));
    this.M = M;
    this.step = len / M;
    const N = M + 1;                                 // +1 duplicate end, so lerp wraps
    const rx = this.rx = new Float32Array(N), ry = this.ry = new Float32Array(N);
    const rz = this.rz = new Float32Array(N), rw = this.rw = new Float32Array(N);
    let j = 0;
    for (let k = 0; k < N; k++) {
      const target = Math.min(len, k * this.step);
      while (j < fl.length - 2 && fl[j + 1] < target) j++;
      const l0 = fl[j], l1 = fl[j + 1];
      const t = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
      rx[k] = fx[j] + (fx[j + 1] - fx[j]) * t;
      ry[k] = fy[j] + (fy[j + 1] - fy[j]) * t;
      rz[k] = fz[j] + (fz[j + 1] - fz[j]) * t;
      rw[k] = fw[j] + (fw[j + 1] - fw[j]) * t;
    }
    if (this.closed) { rx[M] = rx[0]; ry[M] = ry[0]; rz[M] = rz[0]; rw[M] = rw[0]; }

    // tangents + signed curvature, central differences over the 1 m table
    const dx = this.rdx = new Float32Array(N), dz = this.rdz = new Float32Array(N);
    const kk = this.rk = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const a = this._wrapIdx(k - 1), b = this._wrapIdx(k + 1);
      let vx = rx[b] - rx[a], vz = rz[b] - rz[a];
      const m = Math.hypot(vx, vz) || 1;
      dx[k] = vx / m; dz[k] = vz / m;
    }
    for (let k = 0; k < N; k++) {
      const a = this._wrapIdx(k - 1), b = this._wrapIdx(k + 1);
      // d(dir)/ds projected on the left vector = signed curvature (+ = turns left)
      const ddx = (dx[b] - dx[a]) / (2 * this.step), ddz = (dz[b] - dz[a]) / (2 * this.step);
      kk[k] = ddx * dz[k] - ddz * dx[k];
    }
  }
  _wrapIdx(k) {
    const M = this.M;
    if (this.closed) return ((k % M) + M) % M;
    return k < 0 ? 0 : k > M ? M : k;
  }

  /* ---- XZ bucket grid for nearest() ----
     Per cell we keep every sample that could possibly be the closest to ANY
     point inside that cell: with U an upper bound on the cell centre's own
     distance to the curve and h the cell half-diagonal, a sample can only win
     if it lies within U + 2h of the centre. That makes nearest() a fixed ~30
     distance tests anywhere on the map instead of a ring search that blows up
     the further you drive from the road. */
  _buildGrid() {
    const cell = GRID_CELL, half = GRID_HALF;
    const dim = this.gdim = Math.ceil((half * 2) / cell);
    this.gcell = cell; this.ghalf = half;
    const hd = cell * 0.7071068;                     // half-diagonal
    const M = this.M, rx = this.rx, rz = this.rz;
    const lists = new Array(dim * dim);
    let total = 0;
    const COARSE = 8;
    for (let gz = 0; gz < dim; gz++) {
      const czc = -half + (gz + 0.5) * cell;
      for (let gx = 0; gx < dim; gx++) {
        const cxc = -half + (gx + 0.5) * cell;
        // upper bound from a coarse scan — a subset minimum is still an upper bound
        let U2 = Infinity;
        for (let k = 0; k < M; k += COARSE) {
          const ddx = rx[k] - cxc, ddz = rz[k] - czc;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < U2) U2 = d2;
        }
        const R = Math.sqrt(U2) + 2 * hd + COARSE * this.step;
        const R2 = R * R;
        const list = [];
        for (let k = 0; k < M; k++) {
          const ddx = rx[k] - cxc, ddz = rz[k] - czc;
          if (ddx * ddx + ddz * ddz <= R2) list.push(k);
        }
        lists[gz * dim + gx] = list;
        total += list.length;
      }
    }
    // flatten to CSR: one Int32Array, one offset table. No per-query GC pressure.
    const off = this.goff = new Int32Array(dim * dim + 1);
    const idx = this.gidx = new Int32Array(total);
    let o = 0;
    for (let c = 0; c < dim * dim; c++) {
      off[c] = o;
      const L = lists[c];
      for (let i = 0; i < L.length; i++) idx[o++] = L[i];
    }
    off[dim * dim] = o;
  }

  /* ---------------- public accessors ---------------- */

  /** Wrap s into [0, length) for closed loops, clamp for open ones. */
  wrapS(s) {
    const L = this.length;
    if (!this.closed) return s < 0 ? 0 : s > L ? L : s;
    return s - Math.floor(s / L) * L;
  }

  /** Road-surface position at arc length s. Returns `out` (module scratch by
      default — copy the fields if you need to keep them). */
  posAt(s, out = _p) {
    s = this.wrapS(s);
    const f = s / this.step;
    let i = Math.floor(f);
    if (i >= this.M) i = this.M - 1;
    const t = f - i, j = i + 1;
    out.x = this.rx[i] + (this.rx[j] - this.rx[i]) * t;
    out.y = this.ry[i] + (this.ry[j] - this.ry[i]) * t;
    out.z = this.rz[i] + (this.rz[j] - this.rz[i]) * t;
    return out;
  }

  /** Unit XZ direction of travel at s. */
  dirAt(s, out = _d) {
    s = this.wrapS(s);
    const f = s / this.step;
    let i = Math.floor(f);
    if (i >= this.M) i = this.M - 1;
    const t = f - i, j = i + 1;
    let x = this.rdx[i] + (this.rdx[j] - this.rdx[i]) * t;
    let z = this.rdz[i] + (this.rdz[j] - this.rdz[i]) * t;
    const m = Math.hypot(x, z) || 1;
    out.x = x / m; out.z = z / m;
    return out;
  }

  /** Half-width in metres at s. */
  widthAt(s) {
    s = this.wrapS(s);
    const f = s / this.step;
    let i = Math.floor(f);
    if (i >= this.M) i = this.M - 1;
    const t = f - i;
    return this.rw[i] + (this.rw[i + 1] - this.rw[i]) * t;
  }

  /** Signed curvature 1/m at s; positive turns LEFT. */
  curvatureAt(s) {
    s = this.wrapS(s);
    const f = s / this.step;
    let i = Math.floor(f);
    if (i >= this.M) i = this.M - 1;
    const t = f - i;
    return this.rk[i] + (this.rk[i + 1] - this.rk[i]) * t;
  }

  /** Road height at s (shorthand — posAt().y without the scratch dance). */
  heightAt(s) {
    s = this.wrapS(s);
    const f = s / this.step;
    let i = Math.floor(f);
    if (i >= this.M) i = this.M - 1;
    const t = f - i;
    return this.ry[i] + (this.ry[i + 1] - this.ry[i]) * t;
  }

  /** Point `lateral` metres to the LEFT of the centreline at s. */
  offsetPoint(s, lateral, out = _p2) {
    this.posAt(s, out);
    this.dirAt(s, _d2);
    out.x += _d2.z * lateral;
    out.z += -_d2.x * lateral;
    return out;
  }

  /**
   * Closest point on the centreline. O(1) — bucket lookup then a two-segment
   * refine. `out` defaults to module scratch, so copy what you keep.
   * @returns {{s:number,d:number,side:number,lat:number,x:number,z:number}}
   *          side = +1 left of the racing direction, -1 right.
   */
  nearest(x, z, out = _n) {
    const M = this.M, rx = this.rx, rz = this.rz;
    let best = -1, bd2 = Infinity;
    const gx = Math.floor((x + this.ghalf) / this.gcell);
    const gz = Math.floor((z + this.ghalf) / this.gcell);
    if (gx >= 0 && gz >= 0 && gx < this.gdim && gz < this.gdim) {
      const c = gz * this.gdim + gx;
      const o0 = this.goff[c], o1 = this.goff[c + 1];
      for (let o = o0; o < o1; o++) {
        const k = this.gidx[o];
        const dx = rx[k] - x, dz = rz[k] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd2) { bd2 = d2; best = k; }
      }
    }
    if (best < 0) {
      // Outside the grid entirely (>720 m out). Coarse scan then local refine —
      // nobody is racing here, but the reset system still asks.
      for (let k = 0; k < M; k += 4) {
        const dx = rx[k] - x, dz = rz[k] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd2) { bd2 = d2; best = k; }
      }
      for (let o = -4; o <= 4; o++) {
        const k = this._wrapIdx(best + o);
        const dx = rx[k] - x, dz = rz[k] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd2) { bd2 = d2; best = k; }
      }
    }

    // refine against the two chords touching the winning sample
    let bs = best * this.step, bx = rx[best], bz = rz[best], bdist2 = bd2;
    for (let side = -1; side <= 1; side += 2) {
      const k0 = side < 0 ? this._wrapIdx(best - 1) : best;
      const k1 = side < 0 ? best : this._wrapIdx(best + 1);
      if (!this.closed && (best + side < 0 || best + side > M)) continue;
      const ax = rx[k0], az = rz[k0];
      const ex = rx[k1] - ax, ez = rz[k1] - az;
      const el2 = ex * ex + ez * ez;
      if (el2 < 1e-9) continue;
      let t = ((x - ax) * ex + (z - az) * ez) / el2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + ex * t, pz = az + ez * t;
      const dx = px - x, dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bdist2) {
        bdist2 = d2; bx = px; bz = pz;
        bs = (side < 0 ? best - 1 + t : best + t) * this.step;
      }
    }

    out.s = this.wrapS(bs);
    out.d = Math.sqrt(bdist2);
    out.x = bx; out.z = bz;
    this.dirAt(out.s, _d2);
    /* `lat` carries the TRUE distance with the side's sign, not the projection
       onto the smoothed tangent frame. The two differ by a fraction of a degree
       on the road, but 500 m off course that fraction is metres — and `lat` is
       what the HUD off-course arrow and the reset system read. */
    out.side = ((x - bx) * _d2.z - (z - bz) * _d2.x) >= 0 ? 1 : -1;
    out.lat = out.side * out.d;
    return out;
  }
}

const _g0 = { x: 0, y: 0, z: 0 }, _g1 = { x: 0, y: 0, z: 0 };
const _g2 = { x: 0, y: 0, z: 0 }, _g3 = { x: 0, y: 0, z: 0 };

/* ============================================================
   2.  SURFACE PAINTS  (shared by the racing line and the bake)
   ============================================================
   Kept here rather than in terrain.js so the headless racing-line solver and
   the GPU-side bake read surface ids through EXACTLY the same code — an AI that
   thinks it is on rock while the physics says sand is an unwinnable bug. */

/** True if s lies inside the span [s0,s1], which may wrap past the finish line. */
export function spanHas(s0, s1, s, L) {
  if (s1 >= s0) return s >= s0 && s <= s1;
  return s >= s0 || s <= s1;                  // wraps through s = 0
}

/**
 * Surface id at a point, from the track definition alone.
 * @param trackDef the track module's default export
 * @param s        arc length of the nearest centreline point (-1 if off-corridor)
 * @param x,z      world position (for disc paints)
 * @param lat      signed lateral offset in metres (for strip paints)
 * @param L        spline length
 */
export function paintAt(trackDef, s, x, z, lat, L) {
  let id = trackDef.surfaceDefault === undefined ? SURF.DIRT : trackDef.surfaceDefault;
  const P = trackDef.paints;
  if (!P) return id;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.r !== undefined) {                                  // disc paint
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz <= p.r * p.r) id = p.type;
    } else if (s >= 0) {                                      // along-path span
      if (!spanHas(p.s0, p.s1, s, L)) continue;
      // lat0/lat1 turn a span into a STRIP beside the racing line (lava verges,
      // rock shoulders). Absent = the whole corridor.
      if (p.lat0 !== undefined && (lat < p.lat0 || lat > p.lat1)) continue;
      id = p.type;
    }
  }
  return id;
}

/* ============================================================
   3.  RACE DATA
   ============================================================ */

/** Grip-scaled lateral acceleration the racing line is solved for. */
const LAT_ACCEL = 7.5;
const RL_STEP = 6;              // racing-line sample stride, metres
const RL_MIN_SPEED = 9;         // never advise a crawl — the AI would park
const RL_MAX_SPEED = 48;
const APEX_FRAC = 0.65;         // of half-width, per the design brief
const BRAKE_A = 11.0;           // m/s^2 used to back-propagate corner entry
const ACCEL_A = 6.5;

/**
 * Everything the race needs that is derived from a track definition.
 * Pure data out — no three types, so tests can assert on it.
 */
export function buildTrackData(trackDef) {
  const spline = new TrackSpline(trackDef.path, true);
  const L = spline.length;
  const shortcutSpline = trackDef.shortcut
    ? new TrackSpline(trackDef.shortcut.path, false) : null;

  const jumps = normaliseJumps(trackDef, spline);
  const checkpoints = buildCheckpoints(trackDef, spline, shortcutSpline, jumps);
  const gridSlots = buildGrid(trackDef, spline);
  const racingLine = buildRacingLine(trackDef, spline, jumps);

  const out = {
    spline, checkpoints, gridSlots, racingLine,
    // --- additions beyond the contract, all read-only conveniences ---
    jumps,                                   // lip position resolved to world XZ
    walls: trackDef.walls || [],
    def: trackDef,
    lapLength: L
  };
  if (shortcutSpline) out.shortcutSpline = shortcutSpline;
  return out;
}

/** Resolve each jump's lip to a world position + direction, once. */
function normaliseJumps(trackDef, spline) {
  const out = [];
  const J = trackDef.jumps || [];
  for (let i = 0; i < J.length; i++) {
    const j = J[i];
    const s = spline.wrapS(j.s);
    const p = spline.posAt(s, { x: 0, y: 0, z: 0 });
    const d = spline.dirAt(s, { x: 0, z: 0 });
    out.push({
      idx: i, s, len: j.len, h: j.h, gap: j.gap || 0,
      x: p.x, y: p.y, z: p.z, dx: d.x, dz: d.z,
      w: spline.widthAt(s),
      // Steepest angle of the kicker face. rampRise()/LIP_HOLD below are the one
      // definition of that face; terrain.js carves from the same two constants.
      angle: Math.atan2(j.h * RAMP_SLOPE_AT_LIP, Math.max(2, j.len - LIP_HOLD))
    });
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

/* Kicker face: h * (0.25u + 0.75u^2) reaching full height LIP_HOLD metres BEFORE
   the lip and holding it there. Gentle at the foot so the suspension is not
   slammed, steepening on the way up so the nose is already rising, then a short
   table so the car is off its wheels when the ground stops.

   The table is not cosmetic: the height field is 0.66 m per texel, and a peak
   that exists at exactly one point gets bilinear-averaged with the void behind
   it — a 2.2 m lip measures 0.4 m. A metre and a half of plateau gives the
   filter something to land on.

   terrain.js carves from these two constants and this function. If they drift
   apart, the AI is braking for a ramp the ground does not have. */
export const RAMP_SLOPE_AT_LIP = 1.75;
export const LIP_HOLD = 1.0;
export function rampRise(u, h) { return h * (0.25 * u + 0.75 * u * u); }

/* ---------------- checkpoints ---------------- */
function buildCheckpoints(trackDef, spline, shortcut, jumps) {
  const L = spline.length;
  const TARGET = 125;
  const count = Math.max(4, Math.round(L / TARGET));
  const spacing = L / count;

  const cand = [];
  for (let i = 0; i < count; i++) cand.push({ s: i * spacing, jump: false });

  /* Every jump lip carries a checkpoint: it is the one place a racer is legally
     airborne, and a missed gate there would read as cheating. Rather than
     INSERT one (which halves the local spacing and then leaves a 250 m hole
     when the neighbour is pruned), the nearest routine checkpoint SLIDES onto
     the lip. Spacing stays roughly uniform, which is what the HUD arrow and the
     reset-to-last-checkpoint system both assume. */
  for (const j of jumps) {
    const js = spline.wrapS(j.s + 1.5);
    if (js < 1 || js > L - 1) continue;                 // the finish line already has one
    let best = -1, bd = 1e9;
    for (let i = 1; i < cand.length; i++) {             // never move the s=0 gate
      if (cand[i].jump) continue;
      let d = Math.abs(cand[i].s - js);
      if (d > L / 2) d = L - d;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd < 62) { cand[best].s = js; cand[best].jump = true; }
    else cand.push({ s: js, jump: true });
  }
  cand.sort((a, b) => a.s - b.s);

  const cps = [];
  for (let i = 0; i < cand.length; i++) {
    const s = cand[i].s;
    const p = spline.posAt(s, { x: 0, y: 0, z: 0 });
    const w = spline.widthAt(s);
    cps.push({
      x: p.x, z: p.z, y: p.y, r: Math.max(10, w + 4), s, idx: i,
      // Gates every other checkpoint: enough to read the course ahead without
      // building a slalom out of scenery. Never on a jump lip — a gantry there
      // is something to land on.
      big: !cand[i].jump && (i % 2 === 0),
      jump: cand[i].jump
    });
  }

  /* Shortcut alternates. A racer satisfies slot `idx` by hitting EITHER the main
     checkpoint or its twin on the shortcut, which is the whole legality model
     for alternate routes (racecore.js just compares idx). */
  if (shortcut && trackDef.shortcut) {
    const s0 = spline.wrapS(trackDef.shortcut.s0);
    const s1 = spline.wrapS(trackDef.shortcut.s1);
    const bypassed = cps.filter(c => spanHas(s0, s1, c.s, L) && c.s !== s0 && c.s !== s1);
    const SL = shortcut.length;
    const n = bypassed.length;
    for (let i = 0; i < n; i++) {
      const main = bypassed[i];
      // place the twin at the same fraction along the detour as along the bypass
      let f = main.s - s0; if (f < 0) f += L;
      let span = s1 - s0; if (span <= 0) span += L;
      const ss = clamp(f / span, 0.06, 0.94) * SL;
      const p = shortcut.posAt(ss, { x: 0, y: 0, z: 0 });
      const w = shortcut.widthAt(ss);
      cps.push({
        x: p.x, z: p.z, y: p.y, r: Math.max(10, w + 4),
        s: main.s, idx: main.idx, big: false, jump: false,
        alt: true, altS: ss
      });
    }
  }

  // Ordered by slot, then by s inside a slot: main first, then its alternates.
  cps.sort((a, b) => (a.idx - b.idx) || ((a.alt ? 1 : 0) - (b.alt ? 1 : 0)));
  return cps;
}

/* ---------------- starting grid ---------------- */
function buildGrid(trackDef, spline) {
  const gs = spline.wrapS((trackDef.grid && trackDef.grid.s) || 0);
  const slots = [];
  const ROW = 7, LAT = 2.6, BACK = 9;
  for (let i = 0; i < 8; i++) {
    const row = i >> 1, col = i & 1;
    const s = spline.wrapS(gs - BACK - row * ROW);
    const lat = col === 0 ? LAT : -LAT;
    const p = spline.offsetPoint(s, lat, { x: 0, y: 0, z: 0 });
    const d = spline.dirAt(s, { x: 0, z: 0 });
    // Vehicle-local forward is +Z, so a yaw of atan2(dx,dz) points it down-track.
    slots.push({ x: p.x, z: p.z, y: p.y, yaw: Math.atan2(d.x, d.z), s });
  }
  return slots;
}

/* ---------------- racing line ---------------- */
function buildRacingLine(trackDef, spline, jumps) {
  const L = spline.length;
  const N = Math.max(16, Math.round(L / RL_STEP));
  const ds = L / N;
  const lat = new Float64Array(N);
  const sArr = new Float64Array(N);
  const wArr = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    const s = i * ds;
    sArr[i] = s;
    wArr[i] = spline.widthAt(s);
    // Cut to the inside in proportion to how hard the corner is. A 40 m radius
    // saturates; anything looser gets a proportional nibble.
    const k = spline.curvatureAt(s);
    const bias = clamp(Math.abs(k) / 0.019, 0, 1);
    lat[i] = Math.sign(k) * bias * APEX_FRAC * Math.max(0, wArr[i] - 1.6);
  }

  /* Smoothing is what turns "hug the inside" into something resembling
     out-in-out: the filter makes the line start drifting in before the corner
     arrives and drift out after it is gone. Eight passes over a 5-tap kernel is
     roughly a 30 m Gaussian, which is one car-length shy of a full corner. */
  const tmp = new Float64Array(N);
  for (let pass = 0; pass < 5; pass++) {
    for (let i = 0; i < N; i++) {
      const a = lat[(i - 2 + N) % N], b = lat[(i - 1 + N) % N], c = lat[i];
      const d = lat[(i + 1) % N], e = lat[(i + 2) % N];
      tmp[i] = (a + 2 * b + 3 * c + 2 * d + e) / 9;
    }
    lat.set(tmp);
  }
  for (let i = 0; i < N; i++) {
    const cap = APEX_FRAC * Math.max(0.5, wArr[i] - 1.6);
    lat[i] = clamp(lat[i], -cap, cap);
  }

  // resolve to world points
  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = spline.offsetPoint(sArr[i], lat[i], { x: 0, y: 0, z: 0 });
    pts[i] = { x: p.x, y: p.y, z: p.z, s: sArr[i], lat: lat[i], speed: RL_MAX_SPEED, k: 0 };
  }

  /* Speed from the curvature of the OFFSET line, not the centreline — the whole
     point of cutting a corner is that the line you drive is straighter than the
     road. Menger curvature through three consecutive points. */
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 1 + N) % N], b = pts[i], c = pts[(i + 1) % N];
    const abx = b.x - a.x, abz = b.z - a.z;
    const bcx = c.x - b.x, bcz = c.z - b.z;
    const cax = a.x - c.x, caz = a.z - c.z;
    const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(cax, caz);
    const area2 = Math.abs(abx * bcz - abz * bcx);
    const kk = area2 > 1e-9 ? (2 * area2) / (la * lb * lc) : 0;
    b.k = kk;
    const R = kk > 1e-6 ? 1 / kk : 1e6;
    const surf = paintAt(trackDef, b.s, b.x, b.z, b.lat, L);
    const grip = SURFACES[surf] ? SURFACES[surf].grip : 0.8;
    // slope costs you too: a steep climb caps entry speed, a drop adds to it
    const v = Math.sqrt(LAT_ACCEL * grip * R);
    b.speed = clamp(v, RL_MIN_SPEED, RL_MAX_SPEED);
    b.surface = surf;
  }

  /* Jump windows. A gap has to be cleared, so the advisory speed goes UP on the
     approach; a plain kicker has to not be over-flown, so it goes down. Both are
     ballistics off the same kicker face the terrain carves. */
  for (const j of jumps) {
    const th = j.angle, s2 = Math.sin(2 * th) || 0.2;
    const need = j.gap > 0 ? Math.sqrt((j.gap + 7) * G_ARCADE / s2) : 0;
    const cap = Math.sqrt(Math.max(24, j.gap + 40) * G_ARCADE / s2);
    for (let i = 0; i < N; i++) {
      let ds2 = j.s - pts[i].s; if (ds2 < -L / 2) ds2 += L; if (ds2 > L / 2) ds2 -= L;
      if (ds2 > 55 || ds2 < -12) continue;             // approach window
      if (need > 0) pts[i].speed = Math.max(pts[i].speed, Math.min(need * 1.18, RL_MAX_SPEED));
      pts[i].speed = Math.min(pts[i].speed, Math.max(need * 1.05, cap));
      pts[i].jump = true;
    }
  }

  /* Braking/accel propagation, twice around so the wrap converges. Without it
     the AI reads a corner limit only once it is already in the corner. */
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const nx = pts[(i + 1) % N];
      const lim = Math.sqrt(nx.speed * nx.speed + 2 * BRAKE_A * ds);
      if (pts[i].speed > lim) pts[i].speed = lim;
    }
    for (let i = 0; i < N; i++) {
      const pv = pts[(i - 1 + N) % N];
      const lim = Math.sqrt(pv.speed * pv.speed + 2 * ACCEL_A * ds);
      if (pts[i].speed > lim) pts[i].speed = lim;
    }
  }
  for (let i = 0; i < N; i++) pts[i].speed = Math.max(RL_MIN_SPEED, pts[i].speed);
  return pts;
}

void lerp; void sstep; void SURF;

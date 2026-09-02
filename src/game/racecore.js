/* ============================================================
   RALLY ROAD RASH — RACE CORE
   ------------------------------------------------------------
   Laps, checkpoint slots, progress, standings and results.

   ZERO imports on purpose. This file runs under bare `node`, which is how
   dev/racecore-check.mjs exercises the whole timing model without a browser,
   a GPU or a track. It also means nothing here may reach for the clock:
   EVERY time value arrives from the caller (`tNow`, seconds since the green
   light), so the same input sequence always produces the same race.

   The two ideas worth reading before the code:

   1. CHECKPOINT SLOTS, not checkpoints. trackData.checkpoints carries one
      entry per physical gate, and entries that share `idx` are alternates —
      the main-line gate and its twin on a shortcut. Hitting EITHER satisfies
      slot `idx`. That single rule is the entire legality model for shortcuts:
      a racer who takes the slot canyon still clears every slot in order, and
      a racer who cuts the corner without passing a gate does not.

   2. raceS WITHOUT the spline. Standings need a distance-along-the-race for
      every car on every frame, and asking the spline for it means an O(1)
      but not free `nearest()` per car per frame plus a wrap-around special
      case. Instead each racer carries the `s` of the checkpoint it last
      cleared and interpolates toward the next one by straight-line ratio:

          progressed_chord / total_chord, clamped to 0..1

      scaled onto the ARC length between the two slots. Because the arc is
      never shorter than the chord, this always UNDER-estimates, which is
      exactly the bias you want — the estimate can never overtake the gate it
      is heading for, so clearing a gate always pushes raceS forward.
      The ratio is also held at its running maximum per segment, so position
      jitter, a spin, or a respawn can never walk a racer backwards down the
      standings.

      That ratchet is right for standings and WRONG for anything asking "is
      this car moving?". A respawn drops a racer at the last gate it cleared
      while `segFrac` stays pinned near 1, so `raceS` is frozen for the whole
      drive back — a stall watchdog reading it sees a stationary car and
      resets it, forever. `liveS` is the same number without the ratchet and
      is published for exactly that job. Standings read `raceS`; liveness
      reads `liveS`.
   ============================================================ */

/** Shared empty result — the overwhelming majority of update() calls. */
const NO_EVENTS = [];

/* Wrong-way integrator. Deliberately slow to arm and quick to clear: a
   half-spin at a hairpin must not flash the banner, but a racer genuinely
   heading back up the road has to be told inside about a second and a half. */
const WRONG_ARM = 1.2;        // s of sustained regression before the banner
const WRONG_CLEAR = 0.2;      // s the integrator must fall back to, to clear
const WRONG_DECAY = 2.0;      // how much faster it unwinds than it winds up
const WRONG_SPEED = 4.0;      // m/s — below this you are parked, not lost
const WRONG_EPS = 0.05;       // m of regression per update that counts as one

/** M:SS.mmm — the one place race times turn into strings. */
export function formatTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '--:--.---';
  const t = Math.round(sec * 1000);
  const m = Math.floor(t / 60000);
  const s = Math.floor(t / 1000) % 60;
  const ms = t % 1000;
  return `${m}:${s < 10 ? '0' : ''}${s}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}`;
}

/** Signed gap for the HUD: +2.4s ahead of you, -0.8s behind. */
export function formatGap(sec) {
  if (sec == null || !isFinite(sec)) return '--.-';
  const a = Math.abs(sec);
  return `${sec < 0 ? '-' : '+'}${a < 10 ? a.toFixed(1) : a.toFixed(0)}`;
}

/**
 * Fold trackData.checkpoints into ordered slots. Entries sharing `idx` become
 * alternates of one slot; the non-alt entry (if any) owns the slot's headline
 * position and `s`, because that is the one the reset system respawns at.
 */
function buildSlots(checkpoints) {
  const byIdx = new Map();
  for (let i = 0; i < checkpoints.length; i++) {
    const c = checkpoints[i];
    const k = c.idx | 0;
    let g = byIdx.get(k);
    if (!g) byIdx.set(k, g = { idx: k, s: +c.s || 0, x: +c.x || 0, z: +c.z || 0, r: 12, big: false, entries: [] });
    const e = {
      x: +c.x || 0, z: +c.z || 0,
      r: c.r > 0 ? +c.r : 12,
      s: +c.s || 0,
      big: !!c.big, alt: !!c.alt,
      altS: c.altS === undefined ? -1 : +c.altS
    };
    g.entries.push(e);
    if (!e.alt) { g.s = e.s; g.x = e.x; g.z = e.z; g.r = e.r; g.big = e.big; }
  }
  const out = [];
  for (const g of byIdx.values()) out.push(g);
  out.sort((a, b) => a.idx - b.idx);
  return out;
}

export class RaceTracker {
  /**
   * @param {object}   o
   * @param {Array}    o.ids          racer ids (any comparable value)
   * @param {number}   o.laps         laps to complete
   * @param {number}   o.lapLength    spline.length, metres
   * @param {Array}    o.checkpoints  trackData.checkpoints {x,z,r,s,idx,big,alt,altS}
   */
  constructor({ ids = [], laps = 3, lapLength = 1000, checkpoints = [] } = {}) {
    this.laps = Math.max(1, laps | 0);
    this.lapLength = lapLength > 0 ? lapLength : 1000;
    this.slots = buildSlots(checkpoints);
    this.nSlots = this.slots.length;
    if (this.nSlots === 0) {
      // A track with no gates is still a legal loop: synthesise the line.
      this.slots.push({ idx: 0, s: 0, x: 0, z: 0, r: 12, big: true, entries: [{ x: 0, z: 0, r: 12, s: 0, big: true, alt: false, altS: -1 }] });
      this.nSlots = 1;
    }
    this.ids = ids.slice();
    this.racers = new Map();
    for (const id of this.ids) this.racers.set(id, this._makeRacer(id));

    this._order = this.ids.slice();
    /* Bound once: standings() runs every frame and a fresh comparator closure
       per call is a per-frame allocation for nothing. */
    this._cmp = (a, b) => {
      const A = this.racers.get(a), B = this.racers.get(b);
      if (A.finished !== B.finished) return A.finished ? -1 : 1;
      if (A.finished) return (A.total - B.total) || (A.finishOrder - B.finishOrder);
      return B.raceS - A.raceS;
    };
    this._finishCount = 0;
  }

  _makeRacer(id) {
    const s0 = this.slots.length ? this.slots[0] : { s: 0, x: 0, z: 0 };
    return {
      id,
      lap: 0,                       // 0-based: laps COMPLETED
      /* Slot 0 is the start/finish line and the grid sits behind it, so a
         racer starts already "past" it and hunts slot 1. Satisfying slot 0
         again therefore always means a completed lap — no first-crossing
         special case anywhere else in this file. */
      nextSlot: this.slots.length > 1 ? 1 : 0,
      finished: false, total: 0, finishOrder: 0,
      lapT0: 0, lastLap: 0, bestLap: 0, lapTimes: [],
      cpCount: 0,

      fromS: s0.s, fromX: s0.x, fromZ: s0.z,
      segFrac: 0,                   // running MAX ratio along the current segment
      raceS: 0, rawS: 0, prevRaw: 0, hasRaw: false,
      distNext: 0,                  // metres to the nearest entry of the next slot

      lastX: 0, lastZ: 0, lastT: 0, hasPos: false,
      wrongT: 0, wrongOn: false,

      // reused by progress(); never handed out as a fresh object per frame
      prog: {
        lap: 0, nextCp: 0, raceS: 0, lapTime: 0, bestLap: 0, lastLap: 0,
        finished: false, total: 0, wrongWay: false, distNext: 0, cpCount: 0,
        liveS: 0
      }
    };
  }

  /** Put every racer back on the grid. Used by the pause-menu restart. */
  resetAll() {
    this._finishCount = 0;
    for (const id of this.ids) this.racers.set(id, this._makeRacer(id));
  }

  /**
   * Advance one racer.
   * @returns events — [{type:'checkpoint',idx,big}|{type:'lap',lap,lapTime,best}
   *                    |{type:'finish',total}|{type:'wrongway',on}]
   *          The empty case returns a shared constant array; do not mutate it.
   */
  update(id, x, z, tNow) {
    const r = this.racers.get(id);
    if (!r) return NO_EVENTS;

    /* Speed comes from the position delta rather than the vehicle, so this
       file stays free of any physics import and the check script can drive it
       with nothing but coordinates. */
    const dt = r.hasPos ? Math.max(0, tNow - r.lastT) : 0;
    let speed = 0;
    if (dt > 1e-6) {
      const mx = x - r.lastX, mz = z - r.lastZ;
      speed = Math.sqrt(mx * mx + mz * mz) / dt;
    }
    r.lastX = x; r.lastZ = z; r.lastT = tNow; r.hasPos = true;

    // A finished car keeps moving (it drives off the circuit) but its race is
    // over: freezing raceS is what keeps the standings stable behind it.
    if (r.finished) return NO_EVENTS;

    let ev = null;

    /* ---- 1. checkpoint slot, in order, either alternate ---- */
    const slot = this.slots[r.nextSlot];
    if (slot) {
      for (let i = 0; i < slot.entries.length; i++) {
        const e = slot.entries[i];
        const dx = x - e.x, dz = z - e.z;
        if (dx * dx + dz * dz > e.r * e.r) continue;
        ev = ev || [];
        ev.push({ type: 'checkpoint', idx: slot.idx, big: e.big });
        this._clearSlot(r, slot, e, tNow, ev);
        break;
      }
    }

    /* ---- 2. progress along the current segment ---- */
    this._project(r, x, z);

    /* ---- 3. wrong way ---- */
    if (r.hasRaw) {
      if (r.rawS < r.prevRaw - WRONG_EPS && speed > WRONG_SPEED) {
        r.wrongT = Math.min(WRONG_ARM * 2, r.wrongT + dt);
      } else {
        r.wrongT = Math.max(0, r.wrongT - dt * WRONG_DECAY);
      }
    }
    r.prevRaw = r.rawS; r.hasRaw = true;

    if (!r.wrongOn && r.wrongT >= WRONG_ARM) {
      r.wrongOn = true;
      ev = ev || []; ev.push({ type: 'wrongway', on: true });
    } else if (r.wrongOn && r.wrongT <= WRONG_CLEAR) {
      r.wrongOn = false;
      ev = ev || []; ev.push({ type: 'wrongway', on: false });
    }

    return ev || NO_EVENTS;
  }

  /** Slot satisfied: re-anchor the interpolator, count the lap if it was the line. */
  _clearSlot(r, slot, entry, tNow, ev) {
    r.fromS = entry.s; r.fromX = entry.x; r.fromZ = entry.z;
    r.segFrac = 0;
    r.cpCount++;
    r.nextSlot = (r.nextSlot + 1) % this.nSlots;

    if (slot !== this.slots[0]) return;

    const lt = tNow - r.lapT0;
    r.lapT0 = tNow;
    r.lastLap = lt;
    r.lapTimes.push(lt);
    if (!r.bestLap || lt < r.bestLap) r.bestLap = lt;
    r.lap++;
    ev.push({ type: 'lap', lap: r.lap, lapTime: lt, best: r.bestLap });

    if (r.lap >= this.laps) {
      r.finished = true;
      r.total = tNow;
      r.finishOrder = ++this._finishCount;
      ev.push({ type: 'finish', total: r.total });
    }
  }

  /** raceS = lap·L + (last slot's s) + arc·ratio, monotonic per segment. */
  _project(r, x, z) {
    const next = this.slots[r.nextSlot];

    /* Measure against the CLOSEST alternate. On a shortcut the twin gate is
       the one the racer is actually driving at, and using the main-line gate
       would read the detour as "going nowhere". */
    let bestD = Infinity, bx = next.x, bz = next.z;
    for (let i = 0; i < next.entries.length; i++) {
      const e = next.entries[i];
      const dx = x - e.x, dz = z - e.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestD) { bestD = d; bx = e.x; bz = e.z; }
    }
    r.distNext = bestD;

    const cx = bx - r.fromX, cz = bz - r.fromZ;
    const segD = Math.sqrt(cx * cx + cz * cz);
    const fx = x - r.fromX, fz = z - r.fromZ;
    const fromD = Math.sqrt(fx * fx + fz * fz);

    let segLen = next.s - r.fromS;
    if (segLen <= 0) segLen += this.lapLength;      // the segment through the line

    /* Two chord estimates of the same fraction, averaged.
         "closed"  = (segD − distToNext) / segD   — under-reads through a bend
         "covered" = distFromLast / segD          — over-reads by the same shape
       On a circular arc the two errors are equal and opposite, so the mean is
       exact at the midpoint and roughly halves the error everywhere else. That
       matters on PROVING GROUNDS, whose gates are 187 m apart around a 66 m
       corner: the single-sided form is 13 m out there, the mean is 3.
       Both terms shrink when a racer turns round, so the wrong-way signal is
       if anything sharper. */
    const ratio = segD > 1e-3 ? 0.5 * ((segD - bestD) + fromD) / segD : 0;

    // Reported estimate: clamped and monotonic. Nothing downstream may ever
    // see a racer lose ground it has already covered.
    const cl = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    if (cl > r.segFrac) r.segFrac = cl;
    r.raceS = r.lap * this.lapLength + r.fromS + segLen * r.segFrac;

    /* Raw estimate: same number WITHOUT the ratchet, and allowed to go
       negative. This is the only thing that can detect a racer turning round,
       and it is the reason the ratchet lives on a separate field. */
    const rawR = ratio < -3 ? -3 : ratio > 1 ? 1 : ratio;
    r.rawS = r.lap * this.lapLength + r.fromS + segLen * rawR;
  }

  /**
   * Race state for one racer. Returns a REUSED object — read it, do not keep
   * it. (Six of these allocated per frame is exactly the kind of garbage the
   * house rules exist to prevent.)
   */
  progress(id) {
    const r = this.racers.get(id);
    if (!r) return null;
    const p = r.prog;
    p.lap = r.lap;
    p.nextCp = r.nextSlot;
    p.raceS = r.raceS;
    p.lapTime = r.finished ? r.lastLap : Math.max(0, r.lastT - r.lapT0);
    p.bestLap = r.bestLap;
    p.lastLap = r.lastLap;
    p.finished = r.finished;
    p.total = r.total;
    p.wrongWay = r.wrongOn;
    p.distNext = r.distNext;
    p.cpCount = r.cpCount;
    p.liveS = r.rawS;      // un-ratcheted twin — see the header note
    return p;
  }

  /** Slot the racer must clear next — position, radius and `s` for the reset. */
  nextSlotOf(id) {
    const r = this.racers.get(id);
    return r ? this.slots[r.nextSlot] : null;
  }

  /**
   * The slot the racer last cleared. This is where the reset system puts a
   * flipped or lost car back on the road, so it must never be the one they
   * are still hunting.
   */
  lastSlotOf(id) {
    const r = this.racers.get(id);
    if (!r) return this.slots[0];
    const i = (r.nextSlot - 1 + this.nSlots) % this.nSlots;
    return this.slots[i];
  }

  /** Finished first by total time, then everyone else by distance covered. */
  standings() {
    const o = this._order;
    o.length = 0;
    for (let i = 0; i < this.ids.length; i++) o.push(this.ids[i]);
    o.sort(this._cmp);
    return o;
  }

  /** 1-based finishing/running position. */
  position(id) {
    const o = this.standings();
    for (let i = 0; i < o.length; i++) if (o[i] === id) return i + 1;
    return o.length;
  }

  /** End-of-race table, in finishing order. Allocates — called once. */
  results() {
    const order = this.standings();
    const out = [];
    for (let i = 0; i < order.length; i++) {
      const r = this.racers.get(order[i]);
      out.push({
        id: r.id,
        finished: r.finished,
        total: r.finished ? r.total : null,
        bestLap: r.bestLap || null,
        lapTimes: r.lapTimes.slice(),
        lap: r.lap,
        raceS: r.raceS
      });
    }
    return out;
  }

  /**
   * The car was teleported (respawn). Drop the velocity and wrong-way history
   * so the jump backwards is not read as driving backwards; `segFrac` stays
   * put, which is what keeps raceS monotonic across a reset.
   */
  notifyTeleport(id, x, z) {
    const r = this.racers.get(id);
    if (!r) return;
    r.lastX = x; r.lastZ = z;
    r.hasPos = false;
    r.hasRaw = false;
    r.wrongT = 0;
    if (r.wrongOn) r.wrongOn = false;
  }

  /** Has anyone crossed the line? Cheap poll for the finish sequence. */
  anyFinished() { return this._finishCount > 0; }
}

export default RaceTracker;

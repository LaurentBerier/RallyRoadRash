/* ============================================================
   RALLY ROAD RASH — in-race HUD
   ------------------------------------------------------------
   Contract: docs/INTEGRATION-NOTES.md "HUD — src/ui/hud.js".
     new HUD(audio) · showRace(info) · hideRace() · bakeMap(terrain, trackData)
     update(dt, payload) · countdown(n) · banner(text, kind, ttl) ·
     log(text, kind) · airtime(sec)

   Cost discipline (this runs every frame at 60 Hz next to six cars of
   physics):
     • Every DOM write is guarded by a cached last-value. A frame where
       nothing changed touches nothing.
     • No allocation in update(): no object literals, no template strings
       except where a value actually changed, no array methods.
     • The rev arc redraws at 30 Hz off an accumulator. The minimap blits a
       pre-baked background and draws six dots — cheap enough per frame, and
       dots that lag look broken.
     • The minimap background is baked ONCE per race into an offscreen
       canvas; nothing samples the terrain after that.
   ============================================================ */
import { PLAYABLE_EXT } from '../world/terrain.js';
import { TUNE } from '../game/config.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

const MAP_N = 96;          // heightfield samples per side (9216 heightAt calls, once)
const MAP_BASE = 256;      // offscreen background resolution
const ROAD_STEP = 8;       // metres between road-ribbon samples
const RPM_HZ = 30;         // rev-arc redraw rate

/** m:ss.cc — the only string the HUD builds per frame, and only on change. */
function fmtTime(t) {
  if (t == null || !isFinite(t) || t < 0) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
function fmtGap(g) {
  if (g == null || !isFinite(g)) return '';
  const a = Math.abs(g);
  return (g < 0 ? '-' : '+') + (a < 10 ? a.toFixed(2) : a.toFixed(1));
}
function toCss(c, fallback) {
  if (typeof c === 'number') return '#' + (c >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string' && c) return c;
  return fallback;
}

export class HUD {
  constructor(audio) {
    this.audio = audio || null;

    this.el = {
      hud: $('hud'),
      pos: $('hPos'), posN: $('hPosN'), posT: $('hPosT'), rival: $('hRival'),
      lapN: $('hLapN'), lapT: $('hLapT'), track: $('hTrack'),
      time: $('hTime'), last: $('hLast'), best: $('hBest'),
      kmh: $('hKmh'), gear: $('hGear'), air: $('hAir'), item: $('hItem'),
      banner: $('hBanner'), log: $('hLog'),
      count: $('hCount'), countN: $('hCountN'),
      wrong: $('hWrong'), off: $('hOff'), reset: $('hReset'),
    };
    this.cv = { map: $('hMap'), rpm: $('hRpm') };
    this.ctx = {
      map: this.cv.map ? this.cv.map.getContext('2d') : null,
      rpm: this.cv.rpm ? this.cv.rpm.getContext('2d') : null,
    };

    this.mapBase = null;                       // offscreen canvas
    this.fit = { cx: 0, cz: 0, half: PLAYABLE_EXT };   // world → map transform
    this.racers = null;
    this.laps = 1;

    this._t = 0;
    this._rpmAcc = 0;
    this._banners = [];
    this._logs = [];
    this._cdT = 0;
    this._lastCd = null;
    this._airT = 0;
    this._posFlashT = 0;
    this._holdTime = (TUNE && TUNE.reset && TUNE.reset.holdTime) || 0.8;

    // last-rendered cache — the whole point of update() being free
    this._c = {
      pos: -1, total: -1, lap: -1, lapT: -1, time: '', last: '', best: '',
      kmh: -1, gear: '', rival: '', wrong: null, off: null, reset: -1,
      /* One string covering name + charges + rolling. An item you are holding
         is static for seconds at a time, so the common case must cost zero
         DOM writes — same discipline as every other field here. */
      item: '\u0000',
    };

    this._onResize = () => { this._sized = false; };
    addEventListener('resize', this._onResize);
    addEventListener('orientationchange', this._onResize);
  }

  dispose() {
    removeEventListener('resize', this._onResize);
    removeEventListener('orientationchange', this._onResize);
  }

  /* ============================================================
     RACE LIFECYCLE
     ============================================================ */
  showRace(info) {
    const i = info || {};
    this.racers = Array.isArray(i.racers) ? i.racers : null;
    this.laps = i.laps || 1;
    if (this.el.track) this.el.track.textContent = i.trackName || '';
    if (this.el.lapT) this.el.lapT.textContent = '/' + this.laps;
    if (this.el.posT) this.el.posT.textContent = '/' + (this.racers ? this.racers.length : 6);
    this._c.lapT = this.laps;

    // wipe transients so a restart never inherits the last race's furniture
    this._clearTransients();
    const c = this._c;
    c.pos = -1; c.total = -1; c.lap = -1; c.kmh = -1; c.gear = '';
    c.time = ''; c.last = ''; c.best = ''; c.rival = '';
    c.wrong = null; c.off = null; c.reset = -1;
    if (this.el.pos) this.el.pos.classList.remove('up', 'down', 'bump');

    if (this.el.hud) { this.el.hud.classList.remove('hidden'); this.el.hud.setAttribute('aria-hidden', 'false'); }
    this._sized = false;
  }

  hideRace() {
    if (this.el.hud) { this.el.hud.classList.add('hidden'); this.el.hud.setAttribute('aria-hidden', 'true'); }
    this._clearTransients();
  }

  _clearTransients() {
    if (this.el.banner) this.el.banner.innerHTML = '';
    if (this.el.log) this.el.log.innerHTML = '';
    if (this.el.air) this.el.air.innerHTML = '';
    if (this.el.item) this.el.item.innerHTML = '';
    this._c.item = '\u0000';
    if (this.el.count) this.el.count.classList.add('hidden');
    if (this.el.wrong) this.el.wrong.classList.add('hidden');
    if (this.el.off) this.el.off.classList.add('hidden');
    if (this.el.reset) this.el.reset.classList.add('hidden');
    this._banners.length = 0;
    this._logs.length = 0;
    this._cdT = 0; this._airT = 0; this._lastCd = null;
  }

  /* ============================================================
     MINIMAP BAKE
     Shaded heightfield + road ribbon + checkpoints + start line, once.
     ============================================================ */
  bakeMap(terrain, trackData) {
    const spline = trackData && trackData.spline;
    if (!terrain || typeof terrain.heightAt !== 'function' || !spline) return;

    /* ---- fit the view box to the track, then clamp to the playable world.
       A map scaled to ±PLAYABLE_EXT wastes two thirds of its pixels on empty
       vista for a 900 m loop; fitting the loop is what makes the 150 px
       instrument readable at a glance. ---- */
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const L = spline.length || 1;
    const step = Math.max(4, L / 512);
    const p = { x: 0, y: 0, z: 0 };
    for (let s = 0; s < L; s += step) {
      spline.posAt(s, p);
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;
    let half = Math.max(maxX - minX, maxZ - minZ) * 0.5 * 1.14 + 24;
    half = clamp(half, 90, PLAYABLE_EXT);
    this.fit.cx = cx; this.fit.cz = cz; this.fit.half = half;

    /* ---- sun for the hillshade: whatever the terrain is actually lit by, so
       the map's relief agrees with the world. ---- */
    let sx = -0.55, sz = -0.5;
    const sun = terrain.sunDir || (terrain.uniforms && terrain.uniforms.uSunDir && terrain.uniforms.uSunDir.value);
    if (sun && (sun.x || sun.z)) {
      const m = Math.hypot(sun.x, sun.z) || 1;
      sx = sun.x / m; sz = sun.z / m;
    }

    const base = document.createElement('canvas');
    base.width = base.height = MAP_BASE;
    const g = base.getContext('2d');

    // --- heightfield, MAP_N² samples, hillshaded ---
    const H = new Float32Array(MAP_N * MAP_N);
    const cell = (half * 2) / MAP_N;
    let mn = 1e9, mx = -1e9;
    for (let j = 0; j < MAP_N; j++) {
      const wz = cz - half + (j + 0.5) * cell;
      for (let i = 0; i < MAP_N; i++) {
        const wx = cx - half + (i + 0.5) * cell;
        const h = terrain.heightAt(wx, wz);
        H[j * MAP_N + i] = h;
        if (h < mn) mn = h; if (h > mx) mx = h;
      }
    }
    const span = Math.max(mx - mn, 1e-3);
    const shade = document.createElement('canvas');
    shade.width = shade.height = MAP_N;
    const sg = shade.getContext('2d');
    const img = sg.createImageData(MAP_N, MAP_N);
    for (let j = 0; j < MAP_N; j++) {
      for (let i = 0; i < MAP_N; i++) {
        const h = H[j * MAP_N + i];
        const hl = H[j * MAP_N + (i > 0 ? i - 1 : i)];
        const hr = H[j * MAP_N + (i < MAP_N - 1 ? i + 1 : i)];
        const hu = H[(j > 0 ? j - 1 : j) * MAP_N + i];
        const hd = H[(j < MAP_N - 1 ? j + 1 : j) * MAP_N + i];
        // surface normal in XZ, dotted with the sun's ground track
        const nx = (hl - hr) / (2 * cell), nz = (hu - hd) / (2 * cell);
        const lit = clamp(0.5 + (nx * sx + nz * sz) * 2.1, 0, 1);
        const t = (h - mn) / span;
        // near-black plate with a warm lift: the map must read as HUD, not map
        const v = (0.055 + t * 0.10) * (0.55 + 0.95 * lit);
        const o = (j * MAP_N + i) * 4;
        img.data[o] = clamp(v * 300, 0, 255);
        img.data[o + 1] = clamp(v * 276, 0, 255);
        img.data[o + 2] = clamp(v * 252, 0, 255);
        img.data[o + 3] = 255;
      }
    }
    sg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(shade, 0, 0, MAP_N, MAP_N, 0, 0, MAP_BASE, MAP_BASE);

    // --- world → base-canvas pixels ---
    const K = MAP_BASE / (half * 2);
    const px = (x) => (x - cx + half) * K;
    const pz = (z) => (z - cz + half) * K;

    const ribbon = (sp, dashed) => {
      const SL = sp.length || 1;
      g.beginPath();
      let first = true;
      for (let s = 0; s <= SL; s += ROAD_STEP) {
        sp.posAt(Math.min(s, SL - 0.001), p);
        const X = px(p.x), Y = pz(p.z);
        if (first) { g.moveTo(X, Y); first = false; } else g.lineTo(X, Y);
      }
      if (!dashed) g.closePath();
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.setLineDash(dashed ? [7, 6] : []);
      g.strokeStyle = 'rgba(0,0,0,.62)'; g.lineWidth = dashed ? 6 : 8; g.stroke();
      g.strokeStyle = dashed ? 'rgba(79,216,232,.85)' : 'rgba(236,232,224,.88)';
      g.lineWidth = dashed ? 3 : 4.4; g.stroke();
      g.setLineDash([]);
    };
    ribbon(spline, false);
    if (trackData.shortcutSpline) ribbon(trackData.shortcutSpline, true);

    // --- checkpoint ticks, perpendicular to the road ---
    const cps = trackData.checkpoints || [];
    const d = { x: 0, z: 0 };
    g.strokeStyle = 'rgba(255,122,26,.75)'; g.lineWidth = 2;
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (c.alt) continue;                       // alternates sit on the dashed line
      const sp = spline;
      sp.dirAt(c.s, d);
      const X = px(c.x), Y = pz(c.z);
      const nx = -d.z * 5, nz = d.x * 5;
      g.beginPath(); g.moveTo(X - nx, Y - nz); g.lineTo(X + nx, Y + nz); g.stroke();
    }

    /* --- jumps ---
       The minimap knew about corners and checkpoints but said nothing at all
       about the set pieces, which on this game are the reason you are looking
       at the map in the first place: on CALDERA RUN there is a 24 m void 60 m
       past a blind crest, and "there is a gap coming" is worth more than any
       other single thing the instrument could tell you. Same language as the
       stage-select cards — a filled diamond is air you must carry speed into,
       a small ring is a kicker. */
    const jumps = trackData.jumps || [];
    for (let i = 0; i < jumps.length; i++) {
      const j = jumps[i];
      const X = px(j.x), Y = pz(j.z);
      const hero = !!j.gap || j.h >= 3.0;
      g.beginPath();
      if (hero) {
        const r = 5.5;
        g.moveTo(X, Y - r); g.lineTo(X + r, Y); g.lineTo(X, Y + r); g.lineTo(X - r, Y);
        g.closePath();
        g.fillStyle = '#ff7a1a'; g.fill();
        g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 1.4; g.stroke();
      } else {
        g.arc(X, Y, 2.6, 0, 6.2832);
        g.fillStyle = 'rgba(255,122,26,.55)'; g.fill();
      }
    }

    // --- start / finish line ---
    spline.posAt(0, p); spline.dirAt(0, d);
    const X0 = px(p.x), Y0 = pz(p.z);
    const nx0 = -d.z * 9, nz0 = d.x * 9;
    g.strokeStyle = '#ffffff'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(X0 - nx0, Y0 - nz0); g.lineTo(X0 + nx0, Y0 + nz0); g.stroke();
    g.strokeStyle = '#0d0d0f'; g.lineWidth = 4; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(X0 - nx0, Y0 - nz0); g.lineTo(X0 + nx0, Y0 + nz0); g.stroke();
    g.setLineDash([]);

    this.mapBase = base;
    this._sized = false;
  }

  /* ============================================================
     PUSH API
     ============================================================ */
  countdown(n) {
    const el = this.el.count, num = this.el.countN;
    if (!el || !num) return;
    const go = (n === 'GO' || n === 0 || n === '0');
    const txt = go ? 'GO!' : String(n);
    num.textContent = txt;
    el.classList.toggle('go', go);
    el.classList.remove('hidden');
    // restart the CSS pop without a second class
    num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
    this._cdT = go ? 0.8 : 1.0;
    this._lastCd = go ? 0 : (+n || 0);
  }

  banner(text, kind = 'good', ttl = 2.2) {
    const host = this.el.banner;
    if (!host || !text) return;
    const d = document.createElement('div');
    d.className = 'banner ' + (kind || 'good');
    d.textContent = String(text);
    host.appendChild(d);
    this._banners.push({ el: d, t: ttl > 0 ? ttl : 2.2 });
    // never more than two on screen: a third is noise you cannot read anyway
    while (this._banners.length > 2) {
      const old = this._banners.shift();
      if (old.el.parentNode) old.el.remove();
    }
  }

  log(text, kind) {
    const host = this.el.log;
    if (!host || !text) return;
    const d = document.createElement('div');
    d.className = 'logline' + (kind ? ' ' + kind : '');
    d.textContent = String(text);
    host.prepend(d);
    this._logs.push({ el: d, t: 0 });
    while (host.children.length > 3) host.lastChild.remove();
  }

  /** T5 calls this on touchdown after a long flight. Number of seconds, or a
      pre-formatted string if the caller wants its own wording. */
  /**
   * The item slot. Cache-driven rather than timer-driven, unlike airtime():
   * an item persists until it is used, and the roulette is a rapid sequence
   * of different names rather than one thing fading out.
   */
  _drawItem(it) {
    const host = this.el.item;
    if (!host) return;
    const key = !it || !it.enabled || (!it.name && !it.rolling)
      ? '' : it.name + '|' + it.charges + '|' + (it.rolling ? 1 : 0);
    if (key === this._c.item) return;
    this._c.item = key;
    if (!key) { host.innerHTML = ''; return; }

    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'itemcard' + (it.rolling ? ' rolling' : '');
    d.style.setProperty('--ic', toCss(it.col, '#ff7a1a'));
    const n = document.createElement('b');
    n.textContent = it.name || '—';
    d.appendChild(n);
    if (it.charges > 1) {
      const pips = document.createElement('span');
      pips.className = 'charges';
      for (let i = 0; i < it.charges; i++) pips.appendChild(document.createElement('i'));
      d.appendChild(pips);
    }
    host.appendChild(d);
  }

  airtime(sec) {
    const host = this.el.air;
    if (!host) return;
    const txt = typeof sec === 'string' ? sec
      : `AIR ${(isFinite(sec) ? +sec : 0).toFixed(1)}s`;
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'airtag';
    d.textContent = txt;
    host.appendChild(d);
    this._airT = 1.6;
  }

  /* ============================================================
     PER-FRAME
     ============================================================ */
  update(dt, data) {
    if (!this.el.hud || this.el.hud.classList.contains('hidden')) return;
    const d = dt > 0 && dt < 1 ? dt : 0.016;
    this._t += d;
    if (!this._sized) this._resize();

    const p = data || 0;
    const race = (p && p.race) || 0;
    const veh = (p && p.vehicle) || 0;
    const c = this._c;

    this._drawItem(p && p.item);

    /* ---- position ---- */
    if (race) {
      const pos = race.position | 0, tot = race.total | 0;
      if (pos && pos !== c.pos) {
        if (c.pos > 0 && this.el.pos) {
          const better = pos < c.pos;
          this.el.pos.classList.remove('up', 'down', 'bump');
          void this.el.pos.offsetWidth;
          this.el.pos.classList.add('bump', better ? 'up' : 'down');
          this._posFlashT = 1.1;
        }
        c.pos = pos;
        if (this.el.posN) this.el.posN.textContent = pos;
      }
      if (tot && tot !== c.total) { c.total = tot; if (this.el.posT) this.el.posT.textContent = '/' + tot; }

      /* ---- lap ---- */
      const lap = race.lap | 0, laps = (race.laps | 0) || this.laps;
      if (lap !== c.lap) { c.lap = lap; if (this.el.lapN) this.el.lapN.textContent = lap > 0 ? lap : 1; }
      if (laps !== c.lapT) { c.lapT = laps; if (this.el.lapT) this.el.lapT.textContent = '/' + laps; }

      /* ---- clocks: rebuild the string only when the centisecond ticks ---- */
      const rt = race.raceTime;
      const ts = fmtTime(rt == null ? 0 : rt);
      if (ts !== c.time) { c.time = ts; if (this.el.time) this.el.time.textContent = ts; }
      const ls = fmtTime(race.lastLap);
      if (ls !== c.last) { c.last = ls; if (this.el.last) this.el.last.textContent = ls; }
      const bs = fmtTime(race.bestLap);
      if (bs !== c.best) { c.best = bs; if (this.el.best) this.el.best.textContent = bs; }

      /* ---- countdown ----
         race.js pushes these with countdown(); this is the belt-and-braces
         path for a flow that only fills the payload. `_lastCd` makes the two
         idempotent, so no digit is ever shown twice. */
      const cd = race.countdown;
      if (cd != null) {
        if (cd < 0) this._lastCd = null;
        else if (cd !== this._lastCd) this.countdown(cd === 0 ? 'GO' : cd);
      }

      /* ---- warnings ---- */
      const ww = !!race.wrongWay;
      if (ww !== c.wrong) {
        c.wrong = ww;
        if (this.el.wrong) this.el.wrong.classList.toggle('hidden', !ww);
        if (ww && this.audio && this.audio.wrongWay) { try { this.audio.wrongWay(); } catch { /* audio optional */ } }
      }
      // No direction vector exists in the payload, so this is a fixed pill, not
      // an arrow. See the report: a {x,z} for the next checkpoint would let the
      // HUD point at it.
      const oc = !!race.offCourse;
      if (oc !== c.off) { c.off = oc; if (this.el.off) this.el.off.classList.toggle('hidden', !oc); }

      /* ---- reset hold ring: accepts 0..1 progress or raw seconds ---- */
      let rh = +race.resetHold || 0;
      if (rh > 1.001) rh = rh / this._holdTime;
      rh = clamp(rh, 0, 1);
      const q = Math.round(rh * 40);                 // quantised: 40 steps is past visible
      if (q !== c.reset) {
        c.reset = q;
        if (this.el.reset) {
          this.el.reset.classList.toggle('hidden', rh <= 0.001);
          this.el.reset.style.setProperty('--p', rh.toFixed(3));
        }
      }
    }

    /* ---- speed cluster ---- */
    if (veh) {
      const kmh = Math.abs(veh.speedKmh || 0) | 0;
      if (kmh !== c.kmh) { c.kmh = kmh; if (this.el.kmh) this.el.kmh.textContent = kmh; }
      const gearRaw = veh.gear;
      const gs = gearRaw == null ? 'N' : (typeof gearRaw === 'string' ? gearRaw
        : gearRaw < 0 ? 'R' : gearRaw === 0 ? 'N' : String(gearRaw));
      if (gs !== c.gear) { c.gear = gs; if (this.el.gear) this.el.gear.textContent = gs; }
    }

    /* ---- rival gap ---- */
    const rv = p && p.rival;
    const rs = rv && rv.name ? `${rv.name} ${fmtGap(rv.gap)}` : '';
    if (rs !== c.rival) { c.rival = rs; if (this.el.rival) this.el.rival.textContent = rs; }

    /* ---- canvases ---- */
    this._rpmAcc += d;
    if (this._rpmAcc >= 1 / RPM_HZ) { this._rpmAcc = 0; this._drawRpm(veh ? +veh.rpmNorm || 0 : 0); }
    this._drawMap(p && p.dots);

    /* ---- transient timers ---- */
    this._tick(d);
  }

  _tick(d) {
    if (this._cdT > 0) {
      this._cdT -= d;
      if (this._cdT <= 0 && this.el.count) this.el.count.classList.add('hidden');
    }
    if (this._airT > 0) {
      this._airT -= d;
      if (this._airT <= 0 && this.el.air) this.el.air.innerHTML = '';
    }
    if (this._posFlashT > 0) {
      this._posFlashT -= d;
      if (this._posFlashT <= 0 && this.el.pos) this.el.pos.classList.remove('up', 'down', 'bump');
    }
    for (let i = this._banners.length - 1; i >= 0; i--) {
      const b = this._banners[i];
      b.t -= d;
      if (b.t <= 0.32 && !b.out) { b.out = true; b.el.classList.add('out'); }
      if (b.t <= 0) { if (b.el.parentNode) b.el.remove(); this._banners.splice(i, 1); }
    }
    for (let i = this._logs.length - 1; i >= 0; i--) {
      const l = this._logs[i];
      l.t += d;
      if (l.t > 6.5 && !l.faded) { l.faded = true; l.el.classList.add('fade'); }
      if (l.t > 7.4) { if (l.el.parentNode) l.el.remove(); this._logs.splice(i, 1); }
    }
  }

  /* ---------------- canvas sizing ----------------
     CSS drives the size (everything is a multiple of --hud-k); the backing
     store follows it, capped at 2× so a 3× phone does not pay for pixels
     nobody can see. */
  _resize() {
    this._sized = true;
    const dpr = Math.min(2, (window.devicePixelRatio || 1));
    for (const k in this.cv) {
      const cv = this.cv[k];
      if (!cv) continue;
      const r = cv.getBoundingClientRect();
      if (!r.width || !r.height) { this._sized = false; continue; }   // hidden: retry next frame
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    }
    this._c.kmh = -1;   // force a repaint of everything that shares the cluster
  }

  /* ---------------- rev arc ----------------
     A shallow arc across the top of the speed plate. Redline is the last
     18 %: it is drawn dim always and hot once you are in it, so the shift
     point is visible in peripheral vision. */
  _drawRpm(rpmNorm) {
    const g = this.ctx.rpm, cv = this.cv.rpm;
    if (!g || !cv || !cv.width) return;
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const cx = W * 0.5, cy = H * 2.30, R = H * 1.92;
    const a0 = Math.PI * 1.155, a1 = Math.PI * 1.845;
    const t = clamp(+rpmNorm || 0, 0, 1);
    const lw = Math.max(3, H * 0.16);

    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(255,255,255,.13)'; g.lineWidth = lw;
    g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();

    const aRed = a0 + 0.82 * (a1 - a0);
    g.strokeStyle = t > 0.82 ? 'rgba(255,83,71,.95)' : 'rgba(255,83,71,.30)';
    g.beginPath(); g.arc(cx, cy, R, aRed, a1); g.stroke();

    if (t > 0.002) {
      g.strokeStyle = t > 0.82 ? '#ff5347' : '#ff7a1a';
      g.lineWidth = lw;
      g.beginPath(); g.arc(cx, cy, R, a0, a0 + t * (a1 - a0)); g.stroke();
    }
    // ticks
    g.strokeStyle = 'rgba(255,255,255,.30)'; g.lineWidth = Math.max(1, H * 0.02);
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (a1 - a0);
      const c1 = Math.cos(a), s1 = Math.sin(a);
      const r0 = R + lw * 0.62, r1 = R + lw * (i % 4 === 0 ? 1.25 : 0.95);
      g.beginPath(); g.moveTo(cx + c1 * r0, cy + s1 * r0); g.lineTo(cx + c1 * r1, cy + s1 * r1); g.stroke();
    }
  }

  /* ---------------- minimap ---------------- */
  _drawMap(dots) {
    const g = this.ctx.map, cv = this.cv.map;
    if (!g || !cv || !cv.width) return;
    const S = cv.width;
    g.clearRect(0, 0, S, cv.height);
    if (this.mapBase) g.drawImage(this.mapBase, 0, 0, MAP_BASE, MAP_BASE, 0, 0, S, cv.height);
    if (!dots || !dots.length) return;

    const half = this.fit.half, cx = this.fit.cx, cz = this.fit.cz;
    const K = S / (half * 2);
    const rAI = Math.max(2.6, S * 0.022), rMe = Math.max(3.6, S * 0.030);

    // AI first, player last: the dot you are looking for is never underneath one
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < dots.length; i++) {
        const o = dots[i];
        if (!o) continue;
        const me = !!o.isPlayer;
        if (me !== (pass === 1)) continue;
        const X = (o.x - cx + half) * K, Y = (o.z - cz + half) * K;
        if (X < -8 || Y < -8 || X > S + 8 || Y > cv.height + 8) continue;
        const col = toCss(o.color, me ? '#ffffff' : '#9aa0a8');
        if (me) {
          g.fillStyle = '#ffffff';
          g.beginPath(); g.arc(X, Y, rMe + 2, 0, 6.2832); g.fill();
          g.fillStyle = '#ff7a1a';
          g.beginPath(); g.arc(X, Y, rMe - 0.4, 0, 6.2832); g.fill();
        } else {
          g.fillStyle = 'rgba(0,0,0,.6)';
          g.beginPath(); g.arc(X, Y, rAI + 1.4, 0, 6.2832); g.fill();
          g.fillStyle = col;
          g.beginPath(); g.arc(X, Y, rAI, 0, 6.2832); g.fill();
        }
      }
    }
  }
}

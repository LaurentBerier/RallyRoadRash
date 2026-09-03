/* ============================================================
   RALLY ROAD RASH — in-race HUD
   ------------------------------------------------------------
   Contract: docs/INTEGRATION-NOTES.md "HUD — src/ui/hud.js", plus the wave-6
   payload additions in docs/ARCHITECTURE.md §6.6.
     new HUD(audio) · showRace(info) · hideRace() · bakeMap(terrain, trackData)
     update(dt, payload) · countdown(n) · banner(text, kind, ttl) ·
     log(text, kind) · airtime(sec) · tip(id, text, ttl) · setInputMethod(m)

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

   EVENTS ARE SEQUENCE NUMBERS, NOT BOOLEANS. race.js bumps `item.seq`,
   `trick.seq`, `events.hitSeq` and friends; the HUD keeps the last value it
   acted on and fires when they differ. A boolean would need a handshake to
   clear it and would drop two hits in the same frame; a counter cannot.
   ============================================================ */
import { PLAYABLE_EXT } from '../world/terrain.js';
import { TUNE } from '../game/config.js';
import { iconCanvas } from './icons.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

const MAP_N = 96;          // heightfield samples per side (9216 heightAt calls, once)
const MAP_BASE = 256;      // offscreen background resolution
const ROAD_STEP = 8;       // metres between road-ribbon samples
const RPM_HZ = 30;         // rev-arc redraw rate

/* What "fire" is called on each input method. A player holding a pad must not
   be told to press F — which is exactly what the game did, in the one place
   it mentioned firing at all, which was nowhere. */
const FIRE_KEY = { kb: 'F', pad: 'X', touch: 'FIRE' };
/* The other key an item hint can mention: hold-back-to-throw-backwards. */
const BACK_KEY = { kb: '\u2193', pad: 'LT', touch: 'BRAKE' };
/* "PRESS F" reads as an instruction; "TAP FIRE" is what a touch player does. */
const PRESS_VERB = { kb: 'PRESS', pad: 'PRESS', touch: 'TAP' };

/* Mini-turbo tier colours, matched to the tyre dust the drift throws so the
   ring and the world are telling you the same thing. */
const TIER_COL = ['#4fd8e8', '#ff7a1a', '#c46bff'];
/* Trick tier colours: white, cyan, orange, violet as the rotation gets bigger. */
const TRICK_COL = ['#f3f0ea', '#4fd8e8', '#ff7a1a', '#c46bff'];

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
      time: $('hTime'), last: $('hLast'), best: $('hBest'), style: $('hStyle'),
      kmh: $('hKmh'), gear: $('hGear'), air: $('hAir'), item: $('hItem'),
      trick: $('hTrick'), tip: $('hTip'),
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
    this._trickT = 0;
    this._tipT = 0;
    this._posFlashT = 0;
    this._method = 'kb';
    this._holdTime = (TUNE && TUNE.reset && TUNE.reset.holdTime) || 0.8;

    /* Event sequence numbers we have already acted on. -1 means "nothing
       yet", and every one is reset by _clearTransients so a restart cannot
       replay the last race's last hit. */
    this._seq = {
      item: -1, trick: -1, hit: -1, land: -1, pad: -1,
      dealt: -1, rivalFire: -1, note: -1,
    };
    this._cardSeq = -1;                // the item card's own "this is new" edge
    this._fireBtn = null;              // core/input.js's touch FIRE, looked up lazily
    this._fireArmed = false;
    this._tipSeen = null;              // ids already shown, this session

    /* The rev arc repaints at 30 Hz but the payload arrives at 60, so the
       drift state is latched every frame and read by the draw: sampling it
       only on the frames that happen to redraw makes the charge arc stutter. */
    this._drift = 0; this._driftTier = 0; this._boost = 0; this._boostTier = 0;

    // last-rendered cache — the whole point of update() being free
    this._c = {
      pos: -1, total: -1, lap: -1, lapT: -1, time: '', last: '', best: '',
      kmh: -1, gear: '', rival: '', wrong: null, off: null, reset: -1,
      style: -1, finalLap: null,
      /* One string covering name + charges + rolling + icon + input method
         (the card carries the FIRE glyph, and picking up a pad mid-race has
         to change it). An item you are holding
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
    c.style = -1; c.finalLap = null;
    if (this.el.pos) this.el.pos.classList.remove('up', 'down', 'bump');

    if (this.el.hud) { this.el.hud.classList.remove('hidden'); this.el.hud.setAttribute('aria-hidden', 'false'); }
    this._sized = false;
  }

  hideRace() {
    if (this.el.hud) { this.el.hud.classList.add('hidden'); this.el.hud.setAttribute('aria-hidden', 'true'); }
    this._clearTransients();
  }

  /* EVERY transient field this file owns is wiped here, including all the
     wave-6 ones. A field added above and forgotten here is a stale trick pop
     sitting on the grid of the next race. */
  _clearTransients() {
    if (this.el.banner) this.el.banner.innerHTML = '';
    if (this.el.log) this.el.log.innerHTML = '';
    if (this.el.air) this.el.air.innerHTML = '';
    if (this.el.trick) this.el.trick.innerHTML = '';
    if (this.el.tip) this.el.tip.innerHTML = '';
    if (this.el.style) { this.el.style.innerHTML = ''; this.el.style.classList.add('off'); }
    if (this.el.item) this.el.item.innerHTML = '';
    this._c.item = '\u0000';
    if (this.el.count) this.el.count.classList.add('hidden');
    if (this.el.wrong) this.el.wrong.classList.add('hidden');
    if (this.el.off) this.el.off.classList.add('hidden');
    if (this.el.reset) this.el.reset.classList.add('hidden');
    this._banners.length = 0;
    this._logs.length = 0;
    this._cdT = 0; this._airT = 0; this._trickT = 0; this._tipT = 0; this._lastCd = null;
    this._c.style = -1;
    this._c.finalLap = null;
    this._drift = 0; this._driftTier = 0; this._boost = 0; this._boostTier = 0;
    const s = this._seq;
    s.item = -1; s.trick = -1; s.hit = -1; s.land = -1; s.pad = -1;
    s.dealt = -1; s.rivalFire = -1; s.note = -1;
    this._cardSeq = -1;
    this._armTouchFire(null);          // never leave the touch FIRE button lit
  }

  /**
   * 'kb' | 'pad' | 'touch'. Called beside ui.setInputMethod (§6.6). The item
   * card is the only thing that reads it, and the card is rebuilt lazily, so
   * dropping the cache key IS the implementation.
   */
  setInputMethod(m) {
    if (m !== 'kb' && m !== 'pad' && m !== 'touch') return;
    if (m === this._method) return;
    this._method = m;
    if (m !== 'touch') this._armTouchFire(null);
    // A single space is a key no real item can produce, and it is NOT '' —
    // which is the legitimate "no card" key and would suppress the rebuild.
    this._c.item = ' ';
  }

  /**
   * Light the touch FIRE button while an item is ready, in the item's colour.
   * `it` null disarms. The element is owned by core/input.js and is absent on
   * every non-touch session, so everything here is optional.
   */
  _armTouchFire(it) {
    const b = this._fireBtn ||
      (this._fireBtn = document.querySelector('#touch .rbtn.fire'));
    if (!b) return;
    const on = !!(it && it.enabled && it.name && !it.rolling);
    if (on === this._fireArmed) return;
    this._fireArmed = on;
    b.classList.toggle('armed', on);
    if (on) b.style.setProperty('--ic', toCss(it.col, '#ffd23f'));
    else b.style.removeProperty('--ic');
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
    /* The key gained `icon` and `method` in wave 6 — the card now carries a
       glyph and the FIRE key, and both can change without the name doing so
       (a pad plugged in mid-race changes only the method). */
    const key = !it || !it.enabled || (!it.name && !it.rolling)
      ? '' : it.name + '|' + it.charges + '|' + (it.rolling ? 1 : 0) +
        '|' + (it.icon || '') + '|' + (it.use || '') + '|' + this._method;
    if (key === this._c.item) return;
    this._c.item = key;
    if (!key) { host.innerHTML = ''; return; }

    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'itemcard' + (it.rolling ? ' rolling' : '');
    d.style.setProperty('--ic', toCss(it.col, '#ff7a1a'));
    if (it.icon) d.appendChild(iconCanvas(it.icon, 20, toCss(it.col, '#ff7a1a')));
    /* Name over verb, in one column: the card has to answer "what have I got"
       and "what does firing it do" at a glance, and the name alone answers
       only the first. */
    const col = document.createElement('span');
    col.className = 'namecol';
    const n = document.createElement('b');
    n.textContent = it.name || '—';
    col.appendChild(n);
    if (!it.rolling && it.use) {
      const u = document.createElement('small');
      u.className = 'use';
      u.textContent = it.use;
      col.appendChild(u);
    }
    d.appendChild(col);
    if (it.charges > 1) {
      const pips = document.createElement('span');
      pips.className = 'charges';
      for (let i = 0; i < it.charges; i++) pips.appendChild(document.createElement('i'));
      d.appendChild(pips);
    }
    /* The key glyph. Not decoration: before this the game had a full item
       system and did not say, anywhere, which button fires one. Suppressed
       while the roulette is still spinning, because it is not yours yet. */
    if (!it.rolling) {
      const k = document.createElement('i');
      k.className = 'firekey';
      k.textContent = FIRE_KEY[this._method] || 'F';
      d.appendChild(k);
    }
    host.appendChild(d);
    /* A one-shot pulse the frame the item lands, so the card announces itself
       without the banner having to be the only signal. */
    if (!it.rolling && (it.seq | 0) !== this._cardSeq) {
      this._cardSeq = it.seq | 0;
      d.classList.add('ready');
      setTimeout(() => d.classList.remove('ready'), 600);
    }
  }

  /**
   * The pickup callout. `item.seq` is bumped by race.js when a box is
   * collected; the card alone is easy to miss at 40 m/s in the corner of the
   * screen, and the name plus the key is the whole tutorial for the item
   * system.
   */
  _itemEvent(it) {
    if (!it || !it.enabled) return;
    const seq = it.seq | 0;
    if (seq === this._seq.item) return;
    const first = this._seq.item < 0;
    this._seq.item = seq;
    if (first || it.rolling || !it.name) return;   // wait for the roulette to land
    const m = this._method;
    const k = FIRE_KEY[m] || 'F';
    const verb = PRESS_VERB[m] || 'PRESS';
    /* The VERB, not "TO FIRE". Every item used to produce the same sentence,
       which told you which key to press and nothing whatever about what
       pressing it would do. */
    this.banner(`${it.name} — ${verb} ${k} TO ${it.use || 'FIRE'}`, 'item', 3.0);
    if (it.hint) {
      /* The one thing per item you cannot guess, on its own line so it does
         not compete with the instruction. */
      this.banner(it.hint.replace('{BACK}', BACK_KEY[m] || '\u2193'), 'item', 2.6);
    }
  }

  /**
   * The trick pop. Coloured by tier, 1.6 s, one at a time — a queue of these
   * would still be draining while you were setting up the next jump.
   */
  _trickPop(tr) {
    const host = this.el.trick;
    if (!host || !tr) return;
    const seq = tr.seq | 0;
    if (seq === this._seq.trick) return;
    const first = this._seq.trick < 0;
    this._seq.trick = seq;
    if (first || !tr.name) return;
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'trickpop';
    d.style.setProperty('--tc', TRICK_COL[clamp(tr.tier | 0, 0, 3)]);
    d.textContent = tr.pts > 0 ? `${tr.name} +${tr.pts | 0}` : String(tr.name);
    host.appendChild(d);
    this._trickT = 1.6;
  }

  /**
   * A first-run tip. `id` is progression.js's tip id and is used here only to
   * stop the same card firing twice in one session — the PROFILE flag is
   * race.js's business (progression.markTip), because only it knows whether
   * the tip was actually seen or the player was mid-crash.
   */
  tip(id, text, ttl) {
    const host = this.el.tip;
    if (!host || !text) return;
    if (!this._tipSeen) this._tipSeen = Object.create(null);
    if (id) {
      if (this._tipSeen[id]) return;
      this._tipSeen[id] = 1;
    }
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'tipcard';
    d.textContent = String(text);
    host.appendChild(d);
    this._tipT = ttl > 0 ? ttl : 5.0;
  }

  /**
   * Hit / pad feedback, through log() — which was built in wave 5 and then
   * called from precisely nowhere, so the race log has been an empty box in
   * the bottom-left corner for two waves.
   */
  _raceEvents(ev) {
    if (!ev) return;
    const s = this._seq;
    const hs = ev.hitSeq | 0;
    if (hs !== s.hit) {
      const first = s.hit < 0;
      s.hit = hs;
      if (!first) {
        const by = ev.hitBy, wi = ev.hitWith;
        this.log(by ? `HIT BY ${by}${wi ? ' · ' + wi : ''}` : (wi ? `HIT · ${wi}` : 'HIT'), 'bad');
      }
    }
    /* The other half of a hit. Landing one on somebody was completely silent,
       which is half the reason the item system reads as inert. */
    const ds = ev.dealtSeq | 0;
    if (ds !== s.dealt) {
      const first = s.dealt < 0;
      s.dealt = ds;
      if (!first) {
        const to = ev.dealtTo, wi = ev.dealtWith;
        this.log(to ? `YOU HIT ${to}${wi ? ' · ' + wi : ''}` : 'HIT LANDED', 'good');
      }
    }
    /* A rival firing something near you. The field throws 40-80 items a race
       and, with no particles and a 70 m audio gate, essentially none of it
       was ever perceptible from the cockpit. */
    const fs = ev.rivalFireSeq | 0;
    if (fs !== s.rivalFire) {
      const first = s.rivalFire < 0;
      s.rivalFire = fs;
      if (!first && ev.rivalFireBy) {
        this.log(`${ev.rivalFireBy} FIRED${ev.rivalFireWith ? ' · ' + ev.rivalFireWith : ''}`, 'warn');
      }
    }
    /* Things the game simply never said: a full slot, a tow with no lock. */
    const ns = ev.noteSeq | 0;
    if (ns !== s.note) {
      const first = s.note < 0;
      s.note = ns;
      if (!first && ev.noteText) this.log(ev.noteText, 'warn');
    }
    const ps = ev.padSeq | 0;
    if (ps !== s.pad) {
      const first = s.pad < 0;
      s.pad = ps;
      if (!first) this.log('BOOST PAD', 'good');
    }
    const ls = ev.landSeq | 0;
    if (ls !== s.land) s.land = ls;      // consumed by race.js's airtime() call
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

    const it = p && p.item;
    this._drawItem(it);
    this._itemEvent(it);
    if (this._method === 'touch') this._armTouchFire(it);
    this._raceEvents(p && p.events);
    if (veh) this._trickPop(veh.trick);

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

      /* ---- style total ----
         Hidden entirely until the first trick lands: a permanent 0 in the lap
         card reads as a broken instrument, and a player who never leaves the
         ground should not have to look at one. */
      const sty = race.style | 0;
      if (sty !== c.style) {
        c.style = sty;
        const el = this.el.style;
        if (el) {
          el.classList.toggle('off', sty <= 0);
          if (sty > 0) el.innerHTML = `<em>STYLE</em><b>${sty}</b>`;
        }
      }

      /* ---- final lap ----
         An edge, not a level: race.finalLap stays true for the whole lap and
         a level test would re-banner it every frame. */
      const fl = !!race.finalLap;
      if (fl !== c.finalLap) {
        const first = c.finalLap === null;
        c.finalLap = fl;
        if (fl && !first) this.banner('FINAL LAP', 'warn', 2.4);
      }

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
      // Latched every frame, drawn at 30 Hz — see the constructor.
      this._drift = +veh.drift || 0;
      this._driftTier = veh.driftTier | 0;
      this._boost = +veh.boost || 0;
      this._boostTier = veh.boostTier | 0;
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
    if (this._trickT > 0) {
      this._trickT -= d;
      if (this._trickT <= 0 && this.el.trick) this.el.trick.innerHTML = '';
    }
    if (this._tipT > 0) {
      this._tipT -= d;
      if (this._tipT <= 0.4 && this.el.tip && this.el.tip.firstChild) {
        this.el.tip.firstChild.classList.add('out');
      }
      if (this._tipT <= 0 && this.el.tip) this.el.tip.innerHTML = '';
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
     point is visible in peripheral vision.

     Wave 6 adds the mini-turbo to the same instrument rather than a new one:
     a CHARGE arc a little outside the rev arc while a drift is building, and
     a BURN bar under it while the boost is spending. Both are coloured by
     tier, matching the tyre dust — which is the only feedback the drift had,
     and is behind the car where you cannot see it in a corner. */
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

    /* ---- mini-turbo charge, outside the rev arc ---- */
    const dr = clamp(this._drift, 0, 1);
    if (dr > 0.004) {
      const Rc = R + lw * 1.75;
      const cw = Math.max(2, H * 0.10);
      g.lineCap = 'round';
      g.lineWidth = cw;
      g.strokeStyle = 'rgba(255,255,255,.14)';
      g.beginPath(); g.arc(cx, cy, Rc, a0, a1); g.stroke();
      g.strokeStyle = TIER_COL[clamp(this._driftTier - 1, 0, 2)];
      g.beginPath(); g.arc(cx, cy, Rc, a0, a0 + dr * (a1 - a0)); g.stroke();
      /* Tier ticks at a third and two thirds, so a player can see WHICH tier
         they are banking rather than only how full the bar is. */
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.lineWidth = Math.max(1, H * 0.03);
      for (let i = 1; i < 3; i++) {
        const a = a0 + (i / 3) * (a1 - a0);
        const c1 = Math.cos(a), s1 = Math.sin(a);
        g.beginPath();
        g.moveTo(cx + c1 * (Rc - cw * 0.6), cy + s1 * (Rc - cw * 0.6));
        g.lineTo(cx + c1 * (Rc + cw * 0.6), cy + s1 * (Rc + cw * 0.6));
        g.stroke();
      }
      g.lineCap = 'butt';
    }

    /* ---- boost burn, a straight bar across the bottom of the plate ---- */
    const bo = clamp(this._boost, 0, 1);
    if (bo > 0.004) {
      const bh = Math.max(2, H * 0.085);
      const y = H - bh * 0.5 - 1;
      const x0 = W * 0.10, x1 = W * 0.90;
      g.lineCap = 'round';
      g.lineWidth = bh;
      g.strokeStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
      g.strokeStyle = TIER_COL[clamp(this._boostTier - 1, 0, 2)];
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + (x1 - x0) * bo, y); g.stroke();
      g.lineCap = 'butt';
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

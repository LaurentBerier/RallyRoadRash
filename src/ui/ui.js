/* ============================================================
   RALLY ROAD RASH — screens (boot, menu, stage select, garage, settings, pause,
   results) and the focus manager that makes all of them drivable with a
   keyboard, a gamepad d-pad or a thumb.

   Contract: docs/INTEGRATION-NOTES.md "UI facade — src/ui/ui.js".
     new UI(save) · boot(p,msg) · bootDone() · show(screen,data) ·
     hide(screen?) · on(fn) · setInputMethod(m)
   ADDITION (flagged for T5): setAudio(audio) — the facade contract has no
   audio in the constructor, but every press wants a click. Call it once
   after audio.init(); until then the UI is silently mute.

   Three rules hold everywhere in here:
     1. Never throw on missing data. Every field is optional; screens fall
        back to the static registries (TRACKS / VEHICLES) so a menu is never
        dead just because the race flow has not handed anything over yet.
     2. The UI owns *menu* navigation (main → tracks → garage) and emits
        only the actions the race flow must act on. It also emits a
        {type:'nav', to} hint so main.js can keep its state machine in sync.
     3. Settings apply live. There is no apply button and no cancel.
   ============================================================ */
import { TRACKS } from '../world/tracks/index.js';
import { VEHICLES, statBars } from '../game/vehicles.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['main', 'tracks', 'garage', 'settings', 'pause', 'results'];

/* Settings schema. `key` matches the settings-keys contract exactly; the UI
   never invents a key and never writes storage itself — it emits and T5 saves. */
const SETTINGS_SPEC = [
  /* First in the list, because it is the only row here that changes what the
     race IS rather than how it looks. OFF is the clean time-attack game; the
     drift boost is handling, not a power-up, and stays on either way. */
  { key: 'items', label: 'POWER-UPS',
    hint: 'Item boxes, weapons and catch-up. OFF for clean time attack — the drift boost stays.',
    type: 'seg', opts: [[false, 'OFF'], [true, 'ON']], def: true },
  { key: 'quality', label: 'QUALITY', hint: 'Render tier. Drop it if the frame rate dips.',
    type: 'seg', opts: [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH'], ['ultra', 'ULTRA']], def: 'high' },
  { key: 'fov', label: 'FIELD OF VIEW', hint: 'Base chase-camera FOV in degrees.',
    type: 'range', min: 42, max: 82, step: 1, def: 58, fmt: (v) => `${Math.round(v)}°` },
  { key: 'camMode', label: 'CAMERA', hint: 'Default view. C cycles it mid-race.',
    type: 'seg', opts: [[0, 'CHASE'], [1, 'HOOD'], [2, 'ORBIT']], def: 0 },
  { key: 'autoCentre', label: 'AUTO-CENTRE', hint: 'How hard the camera returns behind the car.',
    type: 'seg', opts: [[0, 'OFF'], [1, 'SOFT'], [2, 'FULL']], def: 1 },
  { key: 'sens', label: 'LOOK SENSITIVITY', hint: 'Right-stick / drag look speed.',
    type: 'range', min: 0.3, max: 2, step: 0.05, def: 1, fmt: (v) => (+v).toFixed(2) },
  { key: 'invertY', label: 'INVERT LOOK Y', hint: '',
    type: 'seg', opts: [[false, 'OFF'], [true, 'ON']], def: false },
  { key: 'volSfx', label: 'SFX VOLUME', hint: '',
    type: 'range', min: 0, max: 1, step: 0.05, def: 0.8, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'volMusic', label: 'MUSIC VOLUME', hint: '',
    type: 'range', min: 0, max: 1, step: 0.05, def: 0.6, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'music', label: 'MUSIC', hint: '',
    type: 'seg', opts: [[false, 'OFF'], [true, 'ON']], def: true },
  { key: 'hudScale', label: 'HUD SIZE', hint: 'Scales every instrument from one knob.',
    type: 'seg', opts: [[0.85, 'S'], [1, 'M'], [1.15, 'L'], [1.3, 'XL']], def: 1 },
  { key: 'grain', label: 'FILM GRAIN', hint: '',
    type: 'seg', opts: [[0, 'OFF'], [0.35, 'LOW'], [1, 'FULL']], def: 0.35 },
  { key: 'showTouch', label: 'TOUCH CONTROLS', hint: 'AUTO shows them only after you touch the screen.',
    type: 'seg', opts: [['auto', 'AUTO'], ['on', 'ON'], ['off', 'OFF']], def: 'auto' },
];

/* Controls reference, one table per input method. */
const BINDINGS = {
  kb: [
    ['Throttle / reverse', 'W S  or  ↑ ↓'], ['Steer', 'A D  or  ← →'],
    ['Handbrake (drift)', 'SPACE'], ['Reset to track', 'hold R'],
    ['Camera', 'C'], ['Pause', 'ESC'], ['Mute', 'M'], ['Look around', 'right-drag'],
  ],
  pad: [
    ['Throttle / brake', 'RT / LT'], ['Steer', 'left stick'],
    ['Handbrake (drift)', 'A'], ['Reset to track', 'hold B'],
    ['Camera', 'Y'], ['Pause', 'START'], ['Look around', 'right stick'],
    ['Menus', 'd-pad + A, B = back'],
  ],
  touch: [
    ['Steer', 'left slider pad'], ['Throttle', 'GAS pedal'],
    ['Brake / reverse', 'BRAKE pedal'], ['Handbrake (drift)', 'DRIFT'],
    ['Reset to track', 'hold RESET'], ['Camera', 'CAM'], ['Pause', 'II'],
  ],
};

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

/* A record set with power-ups on is still a record — it just says so. One
   flag beats a dual leaderboard for a feature that is on by default. */
const ITEM_FLAG = '<span class="itflag" title="set with power-ups on">⚡</span>';

/** mm:ss.cc, or dashes when a time has not been set. */
function fmtTime(t) {
  if (t == null || !isFinite(t) || t < 0) return '--:--.--';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Stable colour for a racer we were given no colour for. */
function nameHue(name) {
  let h = 2166136261;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 360);
}
function toCss(c, fallback) {
  if (typeof c === 'number') return '#' + (c >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string' && c) return c;
  return fallback;
}

export class UI {
  constructor(save) {
    this.save = save || null;
    this.audio = null;
    this._cb = null;
    this._cur = null;                 // active screen name or null
    this._returnTo = 'main';          // where SETTINGS backs out to
    this._method = 'kb';
    this._data = {};                  // last payload per screen, so the UI can re-show itself
    this._sel = { trackId: null, vehicleId: null };
    this._pending = new Map();        // coalesced range emits
    this._flushT = 0;

    this.el = {
      boot: $('boot'), bootBar: $('bootBar'), bootMsg: $('bootMsg'),
      screens: $('screens'),
      mainBadge: $('mainBadge'), mainHints: $('mainHints'), mainProgress: $('mainProgress'),
      garageSub: $('garageSub'),
      trackGrid: $('trackGrid'), tracksNote: $('tracksNote'), tracksNext: $('tracksNext'),
      tracksChampion: $('tracksChampion'), tracksSub: $('tracksSub'),
      garageGrid: $('garageGrid'), garageNote: $('garageNote'), garageStart: $('garageStart'),
      garageTrack: $('garageTrack'),
      settingsBody: $('settingsBody'), controlsBody: $('controlsBody'),
      pauseCtx: $('pauseCtx'),
      resultsTitle: $('resultsTitle'), resultsSub: $('resultsSub'), resultsMedal: $('resultsMedal'),
      podium: $('podium'), resultsTable: $('resultsTable'), resultsRecord: $('resultsRecord'),
      unlockList: $('unlockList'), resultsBtns: $('resultsBtns'),
      rotate: $('rotate'),
    };
    this.scr = {};
    for (const s of SCREENS) this.scr[s] = $('scr-' + s);

    // settings snapshot: the UI needs current values to render its controls even
    // before T5 pushes a 'settings' screen at it.
    this._settings = this._readSettings();
    this._applyHudScale(this._settings.hudScale);

    this._focus = [];
    this._fi = -1;
    addEventListener('keydown', (e) => this._onKey(e));
    // A click anywhere in a screen re-homes the focus ring, so keyboard and
    // mouse never disagree about where "here" is.
    if (this.el.screens) this.el.screens.addEventListener('pointerdown', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-focus]') : null;
      if (t) this._setFocus(this._focus.indexOf(t), false);
    });
    /* Tap-robustness: some WebViews (and touch-translation layers) fail to
       synthesize `click` after a tap. Activate on a clean pointerdown→pointerup
       pair ourselves, and swallow the browser's own click if it then arrives —
       whichever path fires first wins, the other is deduped by timestamp. */
    if (this.el.screens) {
      let downBtn = null;
      this.el.screens.addEventListener('pointerdown', (e) => {
        downBtn = e.target && e.target.closest ? e.target.closest('button') : null;
      });
      this.el.screens.addEventListener('pointerup', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (b && b === downBtn) {
          const now = performance.now();
          if (!b._actT || now - b._actT > 350) { b._actT = now; b.click(); }
        }
        downBtn = null;
      });
      this.el.screens.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!b) return;
        const now = performance.now();
        if (b._actT && now - b._actT < 350 && !e._uiSynth) {
          // second arrival of the same tap — the pointerup path already ran it
          if (b._clicked) { e.stopImmediatePropagation(); e.preventDefault(); }
          b._clicked = true;
          setTimeout(() => { b._clicked = false; }, 400);
        }
      }, true);
    }

    this._buildSettings();
    this._buildControls();
    this._maybeRotateToast();
  }

  /* ---------------- ADDITION: audio, injected late ---------------- */
  /** T5 calls this once audio.init() has run inside a user gesture. */
  setAudio(audio) {
    this.audio = audio || null;
    /* INTEGRATION-NOTES asks for audio.resume() on visibilitychange/focus
       ("iOS re-suspends") and assigns it to T5/T7. Doing it here discharges
       the obligation from the UI side; a second registration in main.js is
       harmless, resume() is idempotent. */
    if (this.audio && !this._resumeHooked) {
      this._resumeHooked = true;
      const wake = () => { try { if (this.audio && this.audio.resume) this.audio.resume(); } catch { /* ignore */ } };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
      addEventListener('focus', wake);
      addEventListener('pointerdown', wake);
    }
  }
  _sfx(kind) { try { if (this.audio && this.audio.ui) this.audio.ui(kind); } catch { /* never break the UI for a click */ } }

  /* ---------------- settings storage ---------------- */
  _readSettings() {
    let s = {};
    try {
      const raw = this.save && (typeof this.save.settings === 'function' ? this.save.settings() : this.save.settings);
      if (raw && typeof raw === 'object') s = raw;
    } catch { s = {}; }
    const out = {};
    for (const spec of SETTINGS_SPEC) out[spec.key] = (s[spec.key] === undefined ? spec.def : s[spec.key]);
    return out;
  }
  _applyHudScale(v) {
    const k = +v;
    document.documentElement.style.setProperty('--hud-k', isFinite(k) && k > 0 ? String(k) : '1');
  }

  /* ---------------- action plumbing ---------------- */
  on(fn) { this._cb = typeof fn === 'function' ? fn : null; }
  _emit(a) { try { if (this._cb) this._cb(a); } catch (e) { console.error('[ui] action handler threw', e); } }

  /* ============================================================
     BOOT
     ============================================================ */
  boot(p01, msg) {
    const b = this.el.boot;
    if (b) b.classList.remove('hidden');
    if (this.el.bootBar) this.el.bootBar.style.width = `${clamp01(+p01 || 0) * 100}%`;
    if (this.el.bootMsg && msg != null && msg !== this._bootMsg) {
      this._bootMsg = msg; this.el.bootMsg.textContent = String(msg);
    }
  }
  bootDone() {
    if (this.el.boot) this.el.boot.classList.add('hidden');
    if (this.el.bootBar) this.el.bootBar.style.width = '100%';
  }

  /* ============================================================
     SCREENS
     ============================================================ */
  show(screen, data) {
    if (!SCREENS.includes(screen)) return;
    // An empty payload never erases context: main.js's generic
    // `showScreen(name)` path passes {} for screens it has no data for, and
    // that must not blank the pause line or the results table.
    if (data && typeof data === 'object' && Object.keys(data).length) this._data[screen] = data;
    const d = this._data[screen] || {};

    for (const s of SCREENS) if (this.scr[s]) this.scr[s].classList.toggle('hidden', s !== screen);
    if (this.el.screens) this.el.screens.classList.remove('hidden');
    document.body.classList.add('ui-open');     // input.js reads this to route d-pad to menus
    this._cur = screen;

    if (screen === 'main') this._renderMain(d);
    else if (screen === 'tracks') this._renderTracks(d);
    else if (screen === 'garage') this._renderGarage(d);
    else if (screen === 'settings') this._renderSettings(d);
    else if (screen === 'pause') this._renderPause(d);
    else if (screen === 'results') this._renderResults(d);

    this._collectFocus();
  }

  hide(screen) {
    if (screen && SCREENS.includes(screen)) {
      if (this.scr[screen]) this.scr[screen].classList.add('hidden');
      if (this._cur === screen) this._cur = null;
    } else {
      for (const s of SCREENS) if (this.scr[s]) this.scr[s].classList.add('hidden');
      this._cur = null;
    }
    const any = SCREENS.some(s => this.scr[s] && !this.scr[s].classList.contains('hidden'));
    if (!any) {
      if (this.el.screens) this.el.screens.classList.add('hidden');
      document.body.classList.remove('ui-open');
      this._focus = []; this._fi = -1;
    }
  }

  /** 'kb' | 'pad' | 'touch' — swaps prompt glyphs and the controls reference. */
  setInputMethod(m) {
    if (m !== 'kb' && m !== 'pad' && m !== 'touch') return;
    if (m === this._method) return;
    this._method = m;
    document.body.classList.remove('im-kb', 'im-pad', 'im-touch');
    document.body.classList.add('im-' + m);
    this._renderHints();
    this._buildControls();
  }

  /* ============================================================
     MAIN
     ============================================================ */
  _renderMain(d) {
    const champ = d.champion || (d.progression && d.progression.champion) || (d.profile && d.profile.champion);
    if (this.el.mainBadge) {
      this.el.mainBadge.innerHTML = champ
        ? `<span class="champ-badge"><b>★</b>CHAMPION${typeof champ === 'string' ? ' · ' + esc(champ) : ''}</span>` : '';
    }
    this._renderProgress(d);
    this._renderHints();
  }

  /**
   * Career strip: one step per stage, in order, showing locked / open / the
   * medal you took. The main menu previously said nothing whatsoever about
   * progress, so a returning player had to walk into STAGE SELECT to find out
   * where they were — and the RACE button said the same thing on the first
   * run as on the last. Both are fixed here, from data main.js already sends.
   */
  _renderProgress(d) {
    const el = this.el.mainProgress;
    if (!el) return;
    const prof = d.progression || d.profile || null;
    const recs = d.records || (prof && prof.results) || {};
    const unlocked = (prof && prof.unlockedTracks) || ['training'];
    let done = 0, opened = 0;
    const parts = [];
    for (const t of TRACKS) {
      const open = unlocked.indexOf(t.id) >= 0;
      const medal = open && recs[t.id] ? recs[t.id].medal : null;
      if (open) opened++;
      if (medal) done++;
      parts.push(
        `<span class="prog-step${open ? '' : ' off'}${medal ? ' ' + esc(medal) : ''}" title="${esc(t.name)}">` +
        `<i></i><em>${esc(t.name)}</em></span>`);
    }
    el.innerHTML = `<div class="prog-row">${parts.join('')}</div>` +
      `<p class="prog-note">${done ? `${done} of ${TRACKS.length} stages medalled` :
        opened > 1 ? 'Championship in progress' : 'New championship'}</p>`;
    // The primary action tells you which it is: a first run or a continuation.
    const race = this.el.screens && this.el.screens.querySelector('[data-act="main-race"]');
    if (race) race.textContent = opened > 1 || done ? 'CONTINUE CHAMPIONSHIP' : 'RACE';
  }

  _renderHints() {
    if (!this.el.mainHints) return;
    const h = this._method === 'pad'
      ? '<span class="keycap">d-pad</span> move · <span class="keycap">A</span> select · <span class="keycap">B</span> back'
      : this._method === 'touch'
        ? 'Tap to select · landscape recommended'
        : '<span class="keycap">↑↓</span> move · <span class="keycap">ENTER</span> select · <span class="keycap">ESC</span> back';
    if (h !== this._hintsHtml) { this._hintsHtml = h; this.el.mainHints.innerHTML = h; }
  }

  /* ============================================================
     TRACK SELECT
     ============================================================ */
  _trackList(d) {
    if (Array.isArray(d.tracks) && d.tracks.length) return d.tracks;
    // Fallback: the static registry, everything open. Keeps the menu alive if
    // the race flow has not pushed progression yet.
    return TRACKS.map(t => ({ id: t.id, name: t.name, tagline: t.tagline, laps: t.laps, locked: false }));
  }

  _renderTracks(d) {
    const list = this._trackList(d);
    if (!this._sel.trackId || !list.some(t => t.id === this._sel.trackId && !t.locked)) {
      const first = list.find(t => !t.locked) || list[0];
      this._sel.trackId = first ? first.id : null;
    }
    if (this.el.tracksChampion) {
      this.el.tracksChampion.innerHTML = d.champion
        ? `<span class="chip gold">★ CHAMPION</span>` : '';
    }
    const g = this.el.trackGrid;
    if (!g) return;
    g.innerHTML = '';
    for (const t of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick' + (t.locked ? ' locked' : '') + (t.id === this._sel.trackId ? ' sel' : '');
      b.setAttribute('data-focus', '');
      b.dataset.id = t.id;
      const laps = t.laps || 1;
      const medal = t.medal ? `<span class="chip ${esc(t.medal)}">${esc(String(t.medal)).toUpperCase()}</span>` : '';
      const times = (t.best != null || t.bestLap != null)
        ? `<div class="pick-times">
             <span><em>BEST</em>${fmtTime(t.best)}${t.bestItems ? ITEM_FLAG : ''}</span>
             <span><em>LAP</em>${fmtTime(t.bestLap)}${t.bestLapItems ? ITEM_FLAG : ''}</span>
           </div>` : '';
      const def = TRACKS.find(x => x.id === t.id) || null;
      const jumps = def ? (def.jumps || []) : [];
      const big = jumps.filter(j => j.gap || j.h >= 3.0).length;
      b.innerHTML = `
        <div class="pick-top">
          <span class="pick-name">${esc(t.name || t.id)}</span>
          ${t.locked ? `<span class="lock"><b>&#128274;</b>LOCKED</span>` : medal}
        </div>
        <canvas class="stage-art" width="440" height="252" aria-hidden="true"></canvas>
        <div class="pick-tag">${esc(t.tagline || '')}</div>
        <div class="pick-meta">
          <span class="chip">${laps} LAP${laps > 1 ? 'S' : ''}</span>
          ${def ? `<span class="chip">${Math.round(splineLength(def.path) / 100) / 10} KM</span>` : ''}
          ${big ? `<span class="chip info">${big} BIG AIR</span>` : ''}
          ${def && def.shortcut ? `<span class="chip info">SHORTCUT</span>` : ''}
          ${t.locked && t.lockHint ? `<span class="chip info">${esc(t.lockHint)}</span>` : ''}
        </div>
        ${times}`;
      b.addEventListener('click', () => this._pickTrack(t));
      g.appendChild(b);
      const cv = b.querySelector('.stage-art');
      if (cv && def) drawStage(cv, def, t.locked);
    }
    this._syncTrackFoot(list);
  }

  _pickTrack(t) {
    if (t.locked) {
      this._sfx('bad');
      if (this.el.tracksNote) this.el.tracksNote.textContent = t.lockHint || 'Locked — win earlier stages to open it.';
      return;
    }
    this._sel.trackId = t.id;
    this._sfx('tick');
    const g = this.el.trackGrid;
    if (g) for (const c of g.children) c.classList.toggle('sel', c.dataset.id === t.id);
    this._syncTrackFoot(this._trackList(this._data.tracks || {}));
  }

  _syncTrackFoot(list) {
    const cur = list.find(t => t.id === this._sel.trackId);
    if (this.el.tracksNote) {
      this.el.tracksNote.textContent = cur && cur.locked
        ? (cur.lockHint || 'Locked')
        : cur ? `${esc(cur.name)} selected` : '';
    }
    if (this.el.tracksNext) this.el.tracksNext.classList.toggle('off', !cur || !!cur.locked);
  }

  /* ============================================================
     GARAGE
     ============================================================ */
  _vehicleList(d) {
    if (Array.isArray(d.vehicles) && d.vehicles.length) {
      return d.vehicles.map(v => ({
        spec: v.spec || v, locked: !!v.locked, lockHint: v.lockHint,
        stats: v.stats || statBars(v.spec || v)
      }));
    }
    return VEHICLES.map(spec => ({ spec, locked: false, stats: statBars(spec) }));
  }

  _renderGarage(d) {
    const list = this._vehicleList(d);
    /* d.trackId is main.js's idea of the track, which is STALE the moment the
       player picks a different card on the tracks screen — main.js only learns
       the pick from the final {type:'race'} action. The UI's own selection is
       the authority; the payload only seeds it when we have none at all. */
    if (d.trackId && !this._sel.trackId) this._sel.trackId = d.trackId;
    if (!this._sel.vehicleId || !list.some(v => v.spec.id === this._sel.vehicleId && !v.locked)) {
      const first = list.find(v => !v.locked) || list[0];
      this._sel.vehicleId = first ? first.spec.id : null;
    }
    if (this.el.garageTrack) {
      const t = TRACKS.find(x => x.id === this._sel.trackId);
      this.el.garageTrack.textContent = t ? `STAGE · ${t.name}` : '';
    }
    /* Written from the roster rather than baked into index.html, where it
       said "Three cars" for as long as it took somebody to notice the
       Hornet had made it four. */
    if (this.el.garageSub) {
      const n = ['no', 'one', 'two', 'three', 'four', 'five', 'six'][list.length] || list.length;
      const open = list.filter(v => !v.locked).length;
      this.el.garageSub.textContent =
        `${n[0].toUpperCase()}${n.slice(1)} machines, ${open} unlocked. ` +
        'No wrong answers, only different mistakes.';
    }
    const g = this.el.garageGrid;
    if (!g) return;
    g.innerHTML = '';
    for (const v of list) {
      const s = v.spec || {};
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick' + (v.locked ? ' locked' : '') + (s.id === this._sel.vehicleId ? ' sel' : '');
      b.setAttribute('data-focus', '');
      b.dataset.id = s.id || '';
      const cv = document.createElement('canvas');
      cv.className = 'car-art'; cv.width = 416; cv.height = 160;
      const top = document.createElement('div');
      top.className = 'pick-top';
      top.innerHTML = `<span class="pick-name">${esc(s.name || s.id)}</span>` +
        (v.locked ? `<span class="lock"><b>&#128274;</b>LOCKED</span>`
          : `<span class="chip info">${Math.round((s.topSpeed || 0) * 3.6)} KM/H</span>`);
      const tag = document.createElement('div');
      tag.className = 'pick-tag'; tag.textContent = s.desc || '';
      const stats = document.createElement('div');
      stats.className = 'stats';
      const st = v.stats || {};
      stats.innerHTML =
        this._statRow('SPEED', st.speed) + this._statRow('ACCEL', st.accel) +
        this._statRow('GRIP', st.grip) + this._statRow('WEIGHT', st.weight, true);
      b.appendChild(top); b.appendChild(cv); b.appendChild(tag); b.appendChild(stats);
      if (v.locked && v.lockHint) {
        const lh = document.createElement('div');
        lh.className = 'pick-meta';
        lh.innerHTML = `<span class="chip info">${esc(v.lockHint)}</span>`;
        b.appendChild(lh);
      }
      b.addEventListener('click', () => this._pickCar(v));
      g.appendChild(b);
      drawCar(cv, s);
    }
    this._syncGarageFoot(list);
  }

  _statRow(label, v, neutral) {
    const w = Math.round(clamp01(+v || 0) * 100);
    return `<div class="stat${neutral ? ' neutral' : ''}"><em>${label}</em>` +
      `<div class="bar"><i style="width:${w}%"></i></div></div>`;
  }

  _pickCar(v) {
    if (v.locked) {
      this._sfx('bad');
      if (this.el.garageNote) this.el.garageNote.textContent = v.lockHint || 'Locked — keep winning.';
      return;
    }
    this._sel.vehicleId = v.spec.id;
    this._sfx('tick');
    const g = this.el.garageGrid;
    if (g) for (const c of g.children) c.classList.toggle('sel', c.dataset.id === v.spec.id);
    this._syncGarageFoot(this._vehicleList(this._data.garage || {}));
  }

  _syncGarageFoot(list) {
    const cur = list.find(v => v.spec.id === this._sel.vehicleId);
    if (this.el.garageNote) this.el.garageNote.textContent = cur ? `${esc(cur.spec.name || '')} selected` : '';
    if (this.el.garageStart) this.el.garageStart.classList.toggle('off', !cur || !!cur.locked);
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  _buildSettings() {
    const host = this.el.settingsBody;
    if (!host) return;
    host.innerHTML = '';
    this._ctl = {};
    for (const spec of SETTINGS_SPEC) {
      const row = document.createElement('div');
      row.className = 'set-row';
      const left = document.createElement('label');
      left.innerHTML = esc(spec.label) + (spec.hint ? `<small>${esc(spec.hint)}</small>` : '');
      const ctl = document.createElement('div');
      ctl.className = 'set-ctl';
      row.appendChild(left); row.appendChild(ctl);

      if (spec.type === 'seg') {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.setAttribute('data-focus', '');
        seg.tabIndex = -1;
        for (const [val, lab] of spec.opts) {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = lab; b.dataset.v = JSON.stringify(val);
          b.addEventListener('click', () => this._setSetting(spec, val));
          seg.appendChild(b);
        }
        // d-pad left/right on a focused segment steps through its options
        seg.addEventListener('ui-step', (e) => {
          const cur = spec.opts.findIndex(o => same(o[0], this._settings[spec.key]));
          const n = spec.opts.length;
          const i = ((cur < 0 ? 0 : cur) + (e.detail > 0 ? 1 : -1) + n) % n;
          this._setSetting(spec, spec.opts[i][0]);
        });
        ctl.appendChild(seg);
        this._ctl[spec.key] = seg;
      } else {
        const val = document.createElement('span');
        val.className = 'set-val';
        const r = document.createElement('input');
        r.type = 'range'; r.min = spec.min; r.max = spec.max; r.step = spec.step;
        r.setAttribute('data-focus', ''); r.tabIndex = -1;
        r.addEventListener('input', () => this._setSetting(spec, +r.value, true));
        r.addEventListener('change', () => this._flushPending());
        r.addEventListener('ui-step', (e) => {
          const step = (+spec.step || 1) * (e.detail > 0 ? 1 : -1);
          this._setSetting(spec, Math.max(spec.min, Math.min(spec.max, (+r.value) + step)));
        });
        ctl.appendChild(val); ctl.appendChild(r);
        this._ctl[spec.key] = r; this._ctl[spec.key + ':val'] = val;
      }
      host.appendChild(row);
    }
    this._syncSettings();
  }

  _renderSettings(d) {
    if (d && d.settings && typeof d.settings === 'object') {
      for (const spec of SETTINGS_SPEC) {
        if (d.settings[spec.key] !== undefined) this._settings[spec.key] = d.settings[spec.key];
      }
      this._applyHudScale(this._settings.hudScale);
    }
    this._syncSettings();
    this._buildControls();
  }

  _syncSettings() {
    for (const spec of SETTINGS_SPEC) {
      const el = this._ctl && this._ctl[spec.key];
      if (!el) continue;
      const v = this._settings[spec.key];
      if (spec.type === 'seg') {
        for (const b of el.children) b.classList.toggle('on', same(JSON.parse(b.dataset.v), v));
      } else {
        el.value = String(v);
        const lab = this._ctl[spec.key + ':val'];
        if (lab) lab.textContent = spec.fmt ? spec.fmt(v) : String(v);
      }
    }
  }

  _setSetting(spec, value, coalesce) {
    if (same(this._settings[spec.key], value)) return;
    this._settings[spec.key] = value;
    if (spec.key === 'hudScale') this._applyHudScale(value);
    this._syncSettings();
    if (spec.type === 'seg') this._sfx('tick');
    if (coalesce) {
      // A range fires per pixel of drag. Coalesce so main.js is not asked to
      // write localStorage sixty times a second.
      this._pending.set(spec.key, value);
      if (!this._flushT) this._flushT = setTimeout(() => this._flushPending(), 70);
    } else {
      this._emit({ type: 'settings', key: spec.key, value });
    }
  }
  _flushPending() {
    if (this._flushT) { clearTimeout(this._flushT); this._flushT = 0; }
    if (!this._pending.size) return;
    for (const [key, value] of this._pending) this._emit({ type: 'settings', key, value });
    this._pending.clear();
  }

  _buildControls() {
    const host = this.el.controlsBody;
    if (!host) return;
    const rows = BINDINGS[this._method] || BINDINGS.kb;
    const title = this._method === 'pad' ? 'GAMEPAD' : this._method === 'touch' ? 'TOUCH' : 'KEYBOARD';
    host.innerHTML = `<h3>CONTROLS · ${title}</h3>` + rows
      .map(([what, how]) => `<div class="keyrow"><span>${esc(what)}</span><b>${esc(how)}</b></div>`).join('');
  }

  /* ============================================================
     PAUSE
     ============================================================ */
  _renderPause(d) {
    if (!this.el.pauseCtx) return;
    const bits = [];
    if (d.trackName) bits.push(String(d.trackName));
    if (d.position) bits.push(`P${d.position}`);
    if (d.lap) bits.push(`LAP ${d.lap}`);
    this.el.pauseCtx.textContent = bits.join('  ·  ');
  }

  /* ============================================================
     RESULTS
     ============================================================ */
  _renderResults(d) {
    const P = Array.isArray(d.placements) ? d.placements : [];
    const pos = d.playerPos || (P.findIndex(p => p && p.isPlayer) + 1) || 0;

    if (this.el.resultsTitle) {
      this.el.resultsTitle.textContent = pos === 1 ? 'STAGE WON' : pos ? `FINISHED P${pos}` : 'RESULTS';
    }
    if (this.el.resultsSub) {
      const t = TRACKS.find(x => x.id === d.trackId);
      this.el.resultsSub.textContent = t ? t.name : '';
    }
    if (this.el.resultsMedal) {
      this.el.resultsMedal.innerHTML = d.medal
        ? `<span class="medal-award ${esc(d.medal)}">&#9679; ${esc(String(d.medal)).toUpperCase()} MEDAL</span>` : '';
    }

    // ---- podium: 2nd, 1st, 3rd, so first place stands in the middle ----
    if (this.el.podium) {
      const order = [1, 0, 2];
      this.el.podium.innerHTML = order.map(i => {
        const p = P[i];
        if (!p) return '';
        const col = toCss(p.color, p.isPlayer ? 'var(--acc)' : `hsl(${nameHue(p.name)} 62% 58%)`);
        return `<div class="riser p${i + 1}${p.isPlayer ? ' me' : ''}">
            <span class="car" style="background:${col}"></span>
            <span class="who">${esc(p.name || '—')}</span>
            <div class="block">${i + 1}</div>
          </div>`;
      }).join('');
    }

    // ---- full classification ----
    if (this.el.resultsTable) {
      this.el.resultsTable.innerHTML = P.map((p, i) => {
        const col = toCss(p.color, p.isPlayer ? 'var(--acc)' : `hsl(${nameHue(p.name)} 62% 58%)`);
        const best = d.newRecord && d.newRecord.lap != null && p.isPlayer;
        /* `est` means the car was still on track when the board froze and
           race.js projected its finish from its own pace. Saying so with a
           tilde is the difference between a result and a guess dressed as
           one — and it explains why the time is not on the record boards. */
        const time = p.dnf ? 'DNF' : (p.est ? '~' : '') + fmtTime(p.total);
        return `<div class="class-row${p.isPlayer ? ' me' : ''}${p.dnf ? ' dnf' : ''}${p.est ? ' est' : ''}"${p.est ? ' title="Still running when the flag fell — projected from their own pace"' : ''}>
            <span class="p">${p.dnf ? '—' : i + 1}</span>
            <span class="nm"><i class="dot" style="background:${col}"></i>${esc(p.name || '—')}</span>
            <span>${time}</span>
            <span class="${best ? 'rec' : ''}">${fmtTime(p.bestLap)}</span>
          </div>`;
      }).join('');
    }

    if (this.el.resultsRecord) {
      const r = d.newRecord || {};
      const bits = [];
      if (r.total != null) bits.push(`<span class="rec-flash">NEW RECORD · ${fmtTime(r.total)}</span>`);
      if (r.lap != null) bits.push(`<span class="rec-flash">FASTEST LAP · ${fmtTime(r.lap)}</span>`);
      this.el.resultsRecord.innerHTML = bits.join('');
      this.el.resultsRecord.classList.toggle('hidden', !bits.length);
    }

    if (this.el.unlockList) {
      const u = Array.isArray(d.unlocks) ? d.unlocks : [];
      this.el.unlockList.innerHTML = u.map((s, i) =>
        `<div class="unlock" style="animation-delay:${(0.25 + i * 0.12).toFixed(2)}s"><b>UNLOCKED</b>${esc(s)}</div>`
      ).join('');
    }

    // ---- buttons ----
    if (this.el.resultsBtns) {
      const btns = [];
      if (d.nextTrackId) btns.push(['res-next', 'NEXT STAGE', 'primary']);
      btns.push(['res-restart', 'RESTART', d.nextTrackId ? '' : 'primary']);
      btns.push(['res-garage', 'GARAGE', 'ghost']);
      btns.push(['res-menu', 'MENU', 'ghost']);
      // Listeners are attached by _collectFocus(), which show() runs right
      // after this — binding here too would double-fire every press.
      this.el.resultsBtns.innerHTML = btns
        .map(([act, lab, cls]) => `<button class="btn ${cls}" data-focus data-act="${act}">${lab}</button>`).join('');
    }
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  _act(act) {
    switch (act) {
      case 'main-race': this._sfx('ok'); this._nav('tracks'); break;
      case 'main-settings': this._sfx('ok'); this._returnTo = 'main'; this._nav('settings'); break;

      case 'tracks-back': this._sfx('back'); this._nav('main', true); break;
      case 'tracks-next': {
        const list = this._trackList(this._data.tracks || {});
        const cur = list.find(t => t.id === this._sel.trackId);
        if (!cur || cur.locked) { this._sfx('bad'); return; }
        this._sfx('ok'); this._nav('garage');
        break;
      }

      case 'garage-back': this._sfx('back'); this._nav('tracks', true); break;
      case 'garage-start': {
        const list = this._vehicleList(this._data.garage || {});
        const cur = list.find(v => v.spec.id === this._sel.vehicleId);
        if (!cur || cur.locked) { this._sfx('bad'); return; }
        this._sfx('ok');
        this._emit({ type: 'race', trackId: this._sel.trackId, vehicleId: this._sel.vehicleId });
        break;
      }

      case 'settings-back':
        this._flushPending(); this._sfx('back');
        this._nav(this._returnTo || 'main', true);
        break;

      case 'pause-resume': this._sfx('back'); this._emit({ type: 'resume' }); break;
      case 'pause-restart': this._sfx('ok'); this._emit({ type: 'restart' }); break;
      case 'pause-settings': this._sfx('ok'); this._returnTo = 'pause'; this._nav('settings'); break;
      case 'pause-quit': this._sfx('back'); this._emit({ type: 'quit' }); break;

      case 'res-next': this._sfx('ok'); this._emit({ type: 'nextTrack', trackId: (this._data.results || 0).nextTrackId }); break;
      case 'res-restart': this._sfx('ok'); this._emit({ type: 'restart' }); break;
      case 'res-garage':
        // quit first so the finished race is disposed, then land on the garage
        this._sfx('ok'); this._emit({ type: 'quit' }); this._nav('garage');
        break;
      case 'res-menu': this._sfx('back'); this._emit({ type: 'quit' }); break;
      default: break;
    }
  }

  /* ---- navigation ----
     DEVIATION, flagged in the report: the contract's {type:'back'} carries no
     destination, and main.js maps it unconditionally to the main menu — which
     is wrong for garage→tracks and for settings→pause. So a navigation press
     emits the DESTINATION instead: {type:'<screen>', to:'<screen>', back?}.
     That lands in main.js's existing `default: showScreen(a.type)` branch, so
     the state machine follows; and because the UI also moves itself off cached
     data (or the static TRACKS / VEHICLES registries), a main.js that ignores
     the action entirely still cannot dead-end the menu. */
  _nav(screen, back) {
    if (back) this._emit({ type: screen, to: screen, back: true });
    else this._emit({ type: screen, to: screen });
    this.show(screen);
  }

  /** Esc / B / BACK: what "back" means on each screen. */
  _back() {
    switch (this._cur) {
      case 'tracks': this._act('tracks-back'); break;
      case 'garage': this._act('garage-back'); break;
      case 'settings': this._act('settings-back'); break;
      case 'pause': this._act('pause-resume'); break;
      case 'main': this._sfx('back'); break;   // nowhere further back to go
      default: break;                          // results: you must pick something
    }
  }

  /* ============================================================
     FOCUS MANAGER
     Roving tabindex over [data-focus] inside the visible screen, arrow /
     d-pad movement by geometry (nearest centre in the pressed direction),
     Enter or A to activate, Esc or B to back out.
     ============================================================ */
  _collectFocus() {
    const root = this._cur && this.scr[this._cur];
    this._focus = root ? Array.from(root.querySelectorAll('[data-focus]')).filter(isVisible) : [];
    for (const el of this._focus) el.tabIndex = -1;
    // static buttons carry data-act but bind lazily, once
    if (root) for (const b of root.querySelectorAll('[data-act]')) {
      if (b._bound) continue;
      b._bound = true;
      b.addEventListener('click', () => this._act(b.dataset.act));
    }
    const keep = this._focus.findIndex(el => el.classList.contains('sel'));
    this._setFocus(keep >= 0 ? keep : 0, false);
  }

  _setFocus(i, scroll = true) {
    if (!this._focus.length) { this._fi = -1; return; }
    if (i < 0 || i >= this._focus.length) return;
    for (const el of this._focus) { el.classList.remove('focus'); el.tabIndex = -1; }
    this._fi = i;
    const el = this._focus[i];
    el.classList.add('focus'); el.tabIndex = 0;
    if (scroll && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _move(dx, dy) {
    if (this._focus.length < 2) return;
    const cur = this._focus[this._fi] || this._focus[0];

    // Horizontal presses inside a segmented control or a slider adjust it
    // rather than leaving it — that is what the d-pad is for on a settings row.
    if (dx && cur && (cur.classList.contains('seg') || cur.tagName === 'INPUT')) {
      cur.dispatchEvent(new CustomEvent('ui-step', { detail: dx }));
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = -1, bestScore = 1e9;
    for (let i = 0; i < this._focus.length; i++) {
      if (i === this._fi) continue;
      const r = this._focus[i].getBoundingClientRect();
      const bx = r.left + r.width / 2, by = r.top + r.height / 2;
      const px = bx - ax, py = by - ay;
      const along = dx ? px * dx : py * dy;
      if (along <= 4) continue;                       // wrong side
      const across = Math.abs(dx ? py : px);
      const score = along + across * 2.2;             // prefer straight ahead
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) {                                    // wrap along the axis
      best = (this._fi + (dx + dy > 0 ? 1 : -1) + this._focus.length) % this._focus.length;
    }
    this._setFocus(best);
    this._sfx('hover');
  }

  _onKey(e) {
    if (!this._cur) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); this._back(); return; }
    if (k === 'Tab') { e.preventDefault(); this._move(0, e.shiftKey ? -1 : 1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); this._move(0, -1); return; }
    if (k === 'ArrowDown') { e.preventDefault(); this._move(0, 1); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); this._move(-1, 0); return; }
    if (k === 'ArrowRight') { e.preventDefault(); this._move(1, 0); return; }
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      const el = this._focus[this._fi];
      if (el) {
        e.preventDefault();
        if (el.classList.contains('seg')) el.dispatchEvent(new CustomEvent('ui-step', { detail: 1 }));
        else if (el.tagName === 'INPUT') { /* ranges step with left/right */ }
        else el.click();
      }
    }
  }

  /* ============================================================
     PORTRAIT NUDGE — once per page load, never blocking
     ============================================================ */
  _maybeRotateToast() {
    const el = this.el.rotate;
    if (!el) return;
    const portrait = matchMedia('(orientation: portrait)').matches;
    const smallish = Math.min(innerWidth, innerHeight) < 620;
    const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!portrait || !smallish || !touch) return;
    el.classList.remove('hidden');
    const kill = () => { el.classList.add('hidden'); removeEventListener('pointerdown', kill); };
    setTimeout(kill, 5500);
    addEventListener('pointerdown', kill, { once: true });
  }
}

/* ---------------- helpers ---------------- */
function same(a, b) { return a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9); }
function isVisible(el) {
  return !!(el && !el.classList.contains('hidden') && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
}

/* ============================================================
   PROCEDURAL CAR ART
   ------------------------------------------------------------
   A side profile per bodyStyle, drawn once per card. No images anywhere in
   this project, and a photo of a car we do not have would be a lie anyway —
   these read as sponsor-plate pictograms, which is the house style.
   ============================================================ */
/* ============================================================
   STAGE PREVIEW ART
   ------------------------------------------------------------
   The stage cards used to be four paragraphs of text in four identical
   boxes, which told a player nothing about what they were choosing. This
   draws the actual racing line straight from the track module's `path` — so
   the picture cannot drift out of step with the track, because it IS the
   track — with the start line, the shortcut and every jump marked.

   Everything is derived. There is no art file and there is no per-track
   special case beyond the theme palette.
   ============================================================ */
const STAGE_SKIN = {
  training: { ink: '#2ad2ff', ground: '#2b2f36', wash: '#1a2026' },
  canyon: { ink: '#ff7a1a', ground: '#3a2820', wash: '#241a15' },
  forest: { ink: '#4fd07a', ground: '#243026', wash: '#161f19' },
  volcano: { ink: '#ff5a2c', ground: '#33211d', wash: '#1d1211' },
};

/** Closed-loop length of an authored path, in metres. */
function splineLength(path) {
  if (!path || path.length < 2) return 0;
  let L = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    L += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return L;
}

/**
 * Fit a set of world-space points into the canvas with a margin, returning a
 * projector. Aspect is preserved: a long thin stage must LOOK long and thin,
 * or the preview is lying about the shape of the lap.
 */
function fitter(pts, W, H, pad) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  const sx = (W - pad * 2) / Math.max(1, x1 - x0);
  const sz = (H - pad * 2) / Math.max(1, z1 - z0);
  const s = Math.min(sx, sz);
  const ox = (W - (x1 - x0) * s) * 0.5 - x0 * s;
  const oz = (H - (z1 - z0) * s) * 0.5 - z0 * s;
  return (p) => [p.x * s + ox, p.z * s + oz];
}

/** Catmull-Rom through the control points, so the preview curves like the road. */
function smoothLoop(path, steps = 6) {
  const n = path.length, out = [];
  const at = (i) => path[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  return out;
}

function drawStage(canvas, def, locked) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width, H = canvas.height;
  const skin = STAGE_SKIN[def.theme] || STAGE_SKIN.training;
  g.clearRect(0, 0, W, H);

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, skin.ground); bg.addColorStop(1, skin.wash);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  const loop = smoothLoop(def.path, 7);
  const all = def.shortcut ? loop.concat(def.shortcut.path) : loop;
  const P = fitter(all, W, H, 18);

  // contour rings behind the road: cheap, and it stops the card reading flat
  g.save();
  g.globalAlpha = 0.16;
  g.strokeStyle = skin.ink; g.lineWidth = 1;
  for (let r = 1; r <= 3; r++) {
    g.beginPath();
    for (let i = 0; i <= loop.length; i++) {
      const p = loop[i % loop.length];
      const q = P({ x: p.x * (1 + r * 0.10), z: p.z * (1 + r * 0.10) });
      i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
    }
    g.closePath(); g.stroke();
  }
  g.restore();

  const trace = (pts, closed) => {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const q = P(pts[i]);
      i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
    }
    if (closed) g.closePath();
  };

  // road: a wide dark casing under a bright core, which is the only way a
  // 3 px line reads as a ROAD and not as a graph
  g.lineJoin = g.lineCap = 'round';
  trace(loop, true); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 9; g.stroke();
  trace(loop, true); g.strokeStyle = 'rgba(255,255,255,.82)'; g.lineWidth = 4.5; g.stroke();

  if (def.shortcut) {
    trace(def.shortcut.path, false);
    g.setLineDash([7, 6]);
    g.strokeStyle = skin.ink; g.lineWidth = 3; g.stroke();
    g.setLineDash([]);
  }

  /* Jumps. The preview's whole job on this game is to say WHERE THE AIR IS,
     so a gap jump gets a filled diamond and a plain kicker a small tick. */
  const L = splineLength(def.path);
  for (const j of (def.jumps || [])) {
    const t = (j.s / Math.max(1, L)) * loop.length;
    const p = loop[Math.floor(t) % loop.length];
    const q = P(p);
    const hero = !!j.gap || j.h >= 3.0;
    g.beginPath();
    if (hero) {
      const r = 8;
      g.moveTo(q[0], q[1] - r); g.lineTo(q[0] + r, q[1]);
      g.lineTo(q[0], q[1] + r); g.lineTo(q[0] - r, q[1]); g.closePath();
      g.fillStyle = skin.ink; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1.5; g.stroke();
    } else {
      g.arc(q[0], q[1], 3.2, 0, 6.2832);
      g.fillStyle = 'rgba(255,255,255,.7)'; g.fill();
    }
  }

  // start line
  {
    const a = P(loop[0]), b = P(loop[1]);
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.max(1e-3, Math.hypot(dx, dz));
    const nx = -dz / len * 8, nz = dx / len * 8;
    g.beginPath();
    g.moveTo(a[0] - nx, a[1] - nz); g.lineTo(a[0] + nx, a[1] + nz);
    g.strokeStyle = '#f2efe6'; g.lineWidth = 4; g.stroke();
    g.strokeStyle = '#15161a'; g.lineWidth = 4; g.setLineDash([3, 3]); g.stroke();
    g.setLineDash([]);
  }

  // No locked wash here: .pick.locked already drops the whole card to 44 %
  // opacity, and dimming twice made the lap shape unreadable — which is the
  // one thing a locked card still needs to sell.
  void locked;
}

function drawCar(canvas, spec) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);

  const body = toCss(spec && spec.color, '#ff7a1a');
  const style = (spec && spec.bodyStyle) || 'buggy';
  const dark = 'rgba(0,0,0,.55)';

  // ground shadow — sells "vehicle" before a single panel is drawn
  const grad = g.createLinearGradient(0, H * 0.82, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,.35)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, H * 0.82, W, H * 0.18);

  const gy = H * 0.80;                     // ground line
  const s = W / 416;                       // art is authored at 416 wide

  const wheel = (cx, r) => {
    g.fillStyle = '#15161a';
    g.beginPath(); g.arc(cx, gy - r, r, 0, 6.2832); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(cx, gy - r, r - 2 * s, 0, 6.2832); g.stroke();
    g.fillStyle = body;
    g.beginPath(); g.arc(cx, gy - r, r * 0.36, 0, 6.2832); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1.4 * s;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * 6.2832;
      g.beginPath(); g.moveTo(cx, gy - r);
      g.lineTo(cx + Math.cos(a) * r * 0.82, gy - r + Math.sin(a) * r * 0.82); g.stroke();
    }
  };

  const path = (pts, fill, stroke) => {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) i ? g.lineTo(pts[i] * s, pts[i + 1] * s) : g.moveTo(pts[i] * s, pts[i + 1] * s);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2 * s; g.stroke(); }
  };

  if (style === 'truck') {
    const r = 34 * s;
    wheel(104 * s, r); wheel(316 * s, r);
    // ladder frame + tray
    path([56, 92, 372, 92, 372, 106, 56, 106], dark);
    // cab + bed
    path([96, 92, 104, 46, 214, 40, 236, 92], body, 'rgba(255,255,255,.22)');
    path([236, 92, 236, 62, 368, 62, 368, 92], body, 'rgba(255,255,255,.16)');
    // glass
    path([116, 86, 122, 56, 204, 52, 218, 86], 'rgba(150,205,225,.35)');
    // bullbar + light bar
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillRect(44 * s, 66 * s, 12 * s, 34 * s);
    g.fillRect(108 * s, 30 * s, 96 * s, 9 * s);
  } else if (style === 'wedge') {
    const r = 27 * s;
    wheel(112 * s, r); wheel(310 * s, r);
    path([48, 106, 384, 106, 384, 114, 48, 114], dark);
    // long low wedge: nose at the left, cab pushed forward
    path([44, 104, 92, 74, 168, 58, 268, 60, 356, 82, 386, 104], body, 'rgba(255,255,255,.22)');
    path([120, 72, 176, 46, 254, 48, 288, 70], 'rgba(150,205,225,.35)');
    // rear wing
    g.fillStyle = body;
    g.fillRect(330 * s, 48 * s, 62 * s, 8 * s);
    g.fillRect(352 * s, 52 * s, 8 * s, 28 * s);
    // splitter
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.fillRect(38 * s, 100 * s, 46 * s, 6 * s);
  } else if (style === 'bike') {
    /* Motocross: two big wheels close together, a rider standing on the pegs.
       The rider is most of the read — a bike without one is a bicycle. */
    const r = 41 * s;
    const fx = 300 * s, rx = 150 * s;            // hub centres
    const hy = gy - r;
    wheel(rx, r); wheel(fx, r);
    // frame: cases, spar to the headstock, swingarm back to the rear hub
    g.strokeStyle = body; g.lineWidth = 9 * s; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(258 * s, hy - 42 * s); g.lineTo(214 * s, hy - 20 * s);
    g.lineTo(196 * s, hy + 6 * s); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.30)'; g.lineWidth = 7 * s;
    g.beginPath(); g.moveTo(196 * s, hy + 4 * s); g.lineTo(rx, hy); g.stroke();  // swingarm
    // forks
    g.strokeStyle = 'rgba(220,226,232,.85)'; g.lineWidth = 6 * s;
    g.beginPath(); g.moveTo(272 * s, hy - 50 * s); g.lineTo(fx, hy); g.stroke();
    // tank / shroud + seat
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(226 * s, hy - 30 * s); g.lineTo(268 * s, hy - 46 * s);
    g.lineTo(276 * s, hy - 28 * s); g.lineTo(232 * s, hy - 14 * s); g.closePath(); g.fill();
    g.fillStyle = 'rgba(20,22,26,.92)';
    g.fillRect(180 * s, hy - 34 * s, 56 * s, 9 * s);                   // seat
    g.fillStyle = body;
    g.beginPath();                                                     // rear fender
    g.moveTo(158 * s, hy - 46 * s); g.lineTo(196 * s, hy - 34 * s);
    g.lineTo(190 * s, hy - 26 * s); g.lineTo(156 * s, hy - 38 * s); g.closePath(); g.fill();
    g.beginPath();                                                     // front fender
    g.moveTo(286 * s, hy - 40 * s); g.lineTo(330 * s, hy - 30 * s);
    g.lineTo(326 * s, hy - 21 * s); g.lineTo(284 * s, hy - 32 * s); g.closePath(); g.fill();
    // bars
    g.strokeStyle = 'rgba(220,226,232,.9)'; g.lineWidth = 4 * s;
    g.beginPath(); g.moveTo(272 * s, hy - 52 * s); g.lineTo(288 * s, hy - 72 * s); g.stroke();
    // rider: boots on the pegs, hips back, shoulders over the bars
    const dk = 'rgba(24,26,31,.95)';
    g.strokeStyle = dk; g.lineWidth = 11 * s;
    g.beginPath();
    g.moveTo(206 * s, hy - 8 * s); g.lineTo(200 * s, hy - 46 * s);
    g.lineTo(214 * s, hy - 74 * s); g.stroke();                        // legs
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 14 * s;
    g.beginPath(); g.moveTo(214 * s, hy - 74 * s); g.lineTo(244 * s, hy - 100 * s); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 8 * s;
    g.beginPath();
    g.moveTo(244 * s, hy - 100 * s); g.lineTo(272 * s, hy - 92 * s);
    g.lineTo(288 * s, hy - 72 * s); g.stroke();                        // arm to the bar
    g.fillStyle = '#eef1f5';
    g.beginPath(); g.arc(258 * s, hy - 112 * s, 13 * s, 0, 6.2832); g.fill();  // helmet
    g.fillStyle = 'rgba(20,26,32,.85)';
    g.fillRect(262 * s, hy - 117 * s, 14 * s, 7 * s);                  // visor
    g.fillStyle = '#eef1f5';
    g.beginPath();                                                     // peak
    g.moveTo(266 * s, hy - 122 * s); g.lineTo(292 * s, hy - 128 * s);
    g.lineTo(292 * s, hy - 122 * s); g.lineTo(266 * s, hy - 114 * s); g.closePath(); g.fill();
  } else {
    // buggy: exposed wheels, visible roll cage, short body
    const r = 31 * s;
    wheel(100 * s, r); wheel(322 * s, r);
    path([70, 96, 352, 96, 352, 108, 70, 108], dark);
    path([84, 96, 100, 70, 300, 66, 344, 96], body, 'rgba(255,255,255,.22)');
    // roll cage
    g.strokeStyle = 'rgba(255,255,255,.62)'; g.lineWidth = 5 * s; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(120 * s, 92 * s); g.lineTo(156 * s, 34 * s);
    g.lineTo(258 * s, 34 * s); g.lineTo(298 * s, 92 * s);
    g.moveTo(258 * s, 34 * s); g.lineTo(316 * s, 74 * s);
    g.stroke();
    // seat + spare
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(186 * s, 48 * s, 34 * s, 42 * s);
    g.fillStyle = '#15161a';
    g.beginPath(); g.arc(332 * s, 62 * s, 17 * s, 0, 6.2832); g.fill();
  }

  // number plate — the sponsor-plate cue that ties the three cards together
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.fillRect(W - 62 * s, 18 * s, 46 * s, 26 * s);
  g.fillStyle = '#0d0d0f';
  g.font = `italic 800 ${20 * s}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String((spec && spec.id ? spec.id.length : 4) % 9 + 1), W - 39 * s, 32 * s);
}

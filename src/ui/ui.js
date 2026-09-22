/* ============================================================
   RALLY ROAD RASH — screens (boot, menu, stage select, garage, playbook,
   settings, pause, results) and the focus manager that makes all of them
   drivable with a keyboard, a gamepad d-pad or a thumb.

   Contract: docs/INTEGRATION-NOTES.md "UI facade — src/ui/ui.js".
     new UI(save) · boot(p,msg) · bootDone() · show(screen,data) ·
     hide(screen?) · on(fn) · setInputMethod(m)
   ADDITIONS (flagged for the lead):
     setAudio(audio)   — the facade contract has no audio in the constructor,
                         but every press wants a click. Call it once after
                         audio.init(); until then the UI is silently mute.
     setAssets(assets) — core/assets.js's handle, for the stage key art on the
                         cards and the loading screen. NEVER required: with no
                         handle, or with the usual empty one, every screen
                         draws the procedural art it always did.

   Three rules hold everywhere in here:
     1. Never throw on missing data. Every field is optional; screens fall
        back to the static registries (TRACKS / VEHICLES) so a menu is never
        dead just because the race flow has not handed anything over yet.
     2. The UI owns *menu* navigation (main → tracks → garage) and emits
        only the actions the race flow must act on. It also emits a
        {type:'nav', to} hint so main.js can keep its state machine in sync.
     3. Settings apply live. There is no apply button and no cancel.

   The canvas drawing that used to live at the bottom of this file is now
   ui/cards.js, ui/logo.js and ui/icons.js; the how-to-play copy is
   ui/playbook.js. This file is screens, data and focus.
   ============================================================ */
import { TRACKS } from '../world/tracks/index.js';
import { VEHICLES, statBars } from '../game/vehicles.js';
import { drawStage, drawCar, stageChips, toCss, artImage } from './cards.js';
import { paintLogos } from './logo.js';
import { paintIcons } from './icons.js';
import { PLAYBOOK_TABS, playbookHTML } from './playbook.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['main', 'tracks', 'garage', 'playbook', 'settings', 'pause', 'results'];
/* Screens that put a menu backdrop behind themselves. PAUSE and RESULTS sit
   over a live race, so the hero must stay out of the way there. */
const HERO_SCREENS = { main: 1, tracks: 1, garage: 1, playbook: 1, settings: 1 };

/* Settings schema. `key` matches the settings-keys contract exactly; the UI
   never invents a key and never writes storage itself — it emits and T5 saves. */
const SETTINGS_SPEC = [
  /* First in the list, because it is the only row here that changes what the
     race IS rather than how it looks. OFF is the clean time-attack game; the
     drift boost is handling, not a pickup, and stays on either way. Wave 8
     §8.10: the key was `items`; main.js boot() migrates old profiles
     (`weapons ??= items`) so this rename never drops a saved preference. */
  { key: 'weapons', label: 'WEAPONS',
    hint: 'Rockets, ammo crates and nitro cans. OFF for clean time attack — pads and the drift boost stay.',
    type: 'seg', opts: [[false, 'OFF'], [true, 'ON']], def: true },
  { key: 'rivals', label: 'RIVALS', hint: 'How hard the AI races you. Applies from the next race.',
    type: 'seg', opts: [['easy', 'EASY'], ['normal', 'NORMAL'], ['hard', 'HARD']], def: 'normal' },
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
  /* Wave-6 additions (ARCHITECTURE §6.10). motionFx is the one that buys
     frames: at 0 the menu backdrop is a still picture instead of a live
     scene, which is the right default on a phone that is already deciding
     whether it can hold 30 fps in the race. */
  { key: 'motionFx', label: '3D VEHICLE VIEW', hint: 'Drag to inspect the garage vehicle. OFF uses static artwork.',
    type: 'seg', opts: [[0, 'OFF'], [0.5, 'LOW'], [1, 'FULL']], def: 1 },
  { key: 'tips', label: 'FIRST-RUN TIPS', hint: 'One-line cards the first time something new happens.',
    type: 'seg', opts: [[false, 'OFF'], [true, 'ON']], def: true },
  { key: 'trickAssist', label: 'TRICK ASSIST', hint: 'How much the game helps you land what you threw.',
    type: 'seg', opts: [[0, 'OFF'], [1, 'SOME'], [2, 'FULL']], def: 1 },
];

/* Controls reference, one table per input method.
   FIRE was missing from all three of these — the game shipped a whole item
   system and never told anybody which button throws one. The playbook's
   CONTROLS tab renders these same tables and adds the air-control rows. */
const BINDINGS = {
  kb: [
    ['Throttle / reverse', 'W S  or  ↑ ↓'], ['Steer', 'A D  or  ← →'],
    ['Handbrake (drift)', 'SPACE'], ['Fire rocket', 'F  (hold S to fire behind)'],
    ['Barrel roll (in air)', 'Q / E'], ['Reset to track', 'hold R'],
    ['Camera', 'C'], ['Pause', 'ESC'], ['Mute', 'M'], ['Look around', 'right-drag'],
  ],
  pad: [
    ['Throttle / brake', 'RT / LT'], ['Steer', 'left stick'],
    ['Handbrake (drift)', 'A'], ['Fire rocket', 'X  (hold LT to fire behind)'],
    ['Barrel roll (in air)', 'LB / RB'], ['Reset to track', 'hold B'],
    ['Camera', 'Y'], ['Pause', 'START'], ['Look around', 'right stick'],
    ['Menus', 'd-pad + A, B = back'],
  ],
  touch: [
    ['Steer', 'left slider pad'], ['Throttle', 'GAS pedal'],
    ['Brake / reverse', 'BRAKE pedal'], ['Handbrake (drift)', 'DRIFT'],
    ['Fire rocket', 'FIRE  (hold BRAKE to fire behind)'], ['Barrel roll (in air)', 'DRIFT + steer'],
    ['Reset to track', 'hold RESET'], ['Camera', 'CAM'], ['Pause', 'II'],
  ],
};

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

/* A record set with weapons on is still a record — it just says so. One flag
   beats a dual leaderboard for a feature that is on by default. §8.10: the
   progression.js record flags stay `itemsTotal`/`itemsLap` — a locked
   whitelist, renaming them would invalidate every saved profile — only the
   label here changes. */
const ITEM_FLAG = '<span class="itflag" title="set with weapons on">⚡</span>';

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

export class UI {
  constructor(save) {
    this.save = save || null;
    this.audio = null;
    this.assets = null;               // core/assets.js handle; null is normal
    this._cb = null;
    this._cur = null;                 // active screen name or null
    this._returnTo = 'main';          // where SETTINGS backs out to
    this._playbookFrom = 'main';      // and where the PLAYBOOK does
    this._tab = 0;                    // playbook tab index
    this._method = 'kb';
    this._data = {};                  // last payload per screen, so the UI can re-show itself
    this._sel = { trackId: null, vehicleId: null };
    this._pending = new Map();        // coalesced range emits
    this._flushT = 0;
    this._artSrc = '';                // last loading-screen art, so we set it once
    this._vehArtSrc = '';             // and the same for the garage hero
    this._trackArtSrc = '';           // and for the stage-select hero

    this.el = {
      boot: $('boot'), bootBar: $('bootBar'), bootMsg: $('bootMsg'), bootArt: $('bootArt'),
      hero: $('hero'), heroArt: $('heroArt'),
      screens: $('screens'),
      playbookTabs: $('playbookTabs'), playbookBody: $('playbookBody'),
      playbookHint: $('playbookHint'),
      mainBadge: $('mainBadge'), mainHints: $('mainHints'), mainProgress: $('mainProgress'),
      garageSub: $('garageSub'),
      trackGrid: $('trackGrid'), tracksNote: $('tracksNote'), tracksNext: $('tracksNext'),
      tracksChampion: $('tracksChampion'), tracksSub: $('tracksSub'),
      tracksHero: $('tracksHero'), tracksDetail: $('tracksDetail'),
      garageGrid: $('garageGrid'), garageNote: $('garageNote'), garageStart: $('garageStart'),
      garageTrack: $('garageTrack'),
      garageHero: $('garageHero'), garageDetail: $('garageDetail'),
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
    this._buildPlaybook();
    this._maybeRotateToast();

    /* The wordmark is a canvas now (ui/logo.js) rather than a heavy system
       font that is not heavy everywhere, so it has to be repainted whenever
       its box changes size. Coalesced onto one timer: a drag-resize fires
       this a hundred times and each paint is a full canvas clear. */
    this._onResize = () => {
      if (this._logoT) return;
      this._logoT = setTimeout(() => { this._logoT = 0; paintLogos(document); }, 90);
    };
    addEventListener('resize', this._onResize);
    addEventListener('orientationchange', this._onResize);
    paintLogos(document);
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

  /* ---------------- ADDITION: optional key art ----------------
     `assets.get(id)` returns null on a normal install and that is the case
     everything here is written for. Passing a handle upgrades the stage
     cards and the loading screen; passing nothing, or never calling this at
     all, leaves both exactly as they were. */
  setAssets(assets) {
    this.assets = assets && typeof assets.get === 'function' ? assets : null;
    const backdrop = artImage(this.assets?.get('art/menu-garage'));
    if (backdrop?.src) for (const screen of Object.values(this.scr)) {
      screen?.style.setProperty('--menu-backdrop', `url("${backdrop.src}")`);
    }
    if (this._cur === 'tracks') this._renderTracks(this._data.tracks || {});
    /* The garage too, and for a sharper reason than the stage cards: the
       manifest resolves AFTER boot, so a player who walks straight into the
       garage would otherwise sit looking at the no-art gradient with four
       perfectly good paintings already in memory. */
    else if (this._cur === 'garage') this._renderGarage(this._data.garage || {});
  }

  /** The texture for a stage's key art, or null. */
  _stageArt(trackId) {
    return this.assets && trackId ? this.assets.get('art/' + trackId) : null;
  }

  /** The texture for a machine's key art, or null. Same story as _stageArt:
      `assets.get()` answers null on a normal install and every caller here is
      written for that. */
  _vehArt(vehicleId) {
    return this.assets && vehicleId ? this.assets.get('art/veh-' + vehicleId) : null;
  }

  /**
   * Put the stage's key art behind the bake bar. Idempotent and cheap: the
   * background-image is only written when the URL actually changes.
   * With no art the layer stays empty and the loading screen is the gradient
   * it has always been.
   */
  setLoadingArt(trackId) {
    const el = this.el.bootArt;
    if (!el) return;
    const img = artImage(this._stageArt(trackId || this._sel.trackId));
    const src = img && img.nodeName === 'IMG' ? img.src : '';
    if (src === this._artSrc) return;
    this._artSrc = src;
    el.style.backgroundImage = src ? `url("${src}")` : '';
    el.classList.toggle('on', !!src);
  }

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
  /** @param trackId optional — which stage's key art to show behind the bar. */
  boot(p01, msg, trackId) {
    const b = this.el.boot;
    if (b) {
      const first = b.classList.contains('hidden');
      b.classList.remove('hidden');
      // The logo canvas measures 0 while the screen is hidden, so it cannot
      // paint until it is shown. First reveal = first honest measurement.
      if (first) paintLogos(b);
    }
    /* The UI's own selection is the authority for which stage is loading —
       the player picked it on the tracks screen — so the lead does not have
       to pass one, and a `nextTrack` flow that does pass one still wins. */
    this.setLoadingArt(trackId || this._sel.trackId);
    if (this.el.bootBar) {
      const percent = Math.round(clamp01(+p01 || 0) * 100);
      this.el.bootBar.style.width = `${percent}%`;
      this.el.bootBar.parentElement.setAttribute('aria-valuenow', String(percent));
    }
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
    this._syncHero();

    if (screen === 'main') this._renderMain(d);
    else if (screen === 'tracks') this._renderTracks(d);
    else if (screen === 'garage') this._renderGarage(d);
    else if (screen === 'playbook') this._renderPlaybook();
    else if (screen === 'settings') this._renderSettings(d);
    else if (screen === 'pause') this._renderPause(d);
    else if (screen === 'results') this._renderResults(d);

    // Canvases measure 0 while their screen is hidden; now that it is not,
    // the wordmark can size itself honestly.
    paintLogos(this.scr[screen] || document);
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
    this._syncHero();
  }

  /* The hero layer is shown for menu screens and hidden for PAUSE, RESULTS
     and no-screen (a race). It carries the CSS fallback on its own, so the
     right-hand half of the plate looks deliberate whether or not the lead has
     wired ui/menuscene.js yet — menuscene sets body.menu3d, which makes this
     layer transparent so the live scene shows through instead. */
  _syncHero() {
    const el = this.el.hero;
    if (!el) return;
    el.classList.toggle('hidden', !(this._cur && HERO_SCREENS[this._cur]));
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
    if (this._cur === 'playbook') this._renderPlaybook();
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
   *
   * BONUS STAGES ARE SKIPPED. THUNDER PARK is unlocked by the championship
   * and is not part of it (progression.js EXTRA_TRACKS), so putting it in the
   * chain would make the strip say "1 of 5 medalled" to a player who has in
   * fact finished the game.
   */
  _renderProgress(d) {
    const el = this.el.mainProgress;
    if (!el) return;
    const prof = d.progression || d.profile || null;
    const recs = d.records || (prof && prof.results) || {};
    const unlocked = (prof && prof.unlockedTracks) || ['training'];
    let done = 0, opened = 0, chain = 0;
    const parts = [];
    for (const t of TRACKS) {
      if (t.bonus) continue;
      chain++;
      const open = unlocked.indexOf(t.id) >= 0;
      const medal = open && recs[t.id] ? recs[t.id].medal : null;
      if (open) opened++;
      if (medal) done++;
      parts.push(
        `<span class="prog-step${open ? '' : ' off'}${medal ? ' ' + esc(medal) : ''}" title="${esc(t.name)}">` +
        `<i></i><em>${esc(t.name)}</em></span>`);
    }
    el.innerHTML = `<div class="prog-row">${parts.join('')}</div>` +
      `<p class="prog-note">${done ? `${done} of ${chain} stages medalled` :
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
    return TRACKS.map(t => ({
      id: t.id, name: t.name, tagline: t.tagline, laps: t.laps, bonus: !!t.bonus, locked: false
    }));
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
    this._renderTracksHero(list);

    /* The strip. Same `.pick` markup contract as the garage's — a focusable
       <button class="pick" data-focus data-id> — because the focus manager
       walks [data-focus] purely by class and getBoundingClientRect()
       geometry and knows nothing about layout.

       The tagline, the chips and the lap times are NOT here any more. They
       are one block over the hero, because saying them five times in five
       boxes is what made this screen a spreadsheet. */
    const g = this.el.trackGrid;
    if (!g) return;
    g.innerHTML = '';
    for (const t of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick' + (t.locked ? ' locked' : '') + (t.id === this._sel.trackId ? ' sel' : '');
      b.setAttribute('data-focus', '');
      b.dataset.id = t.id;
      const def = TRACKS.find(x => x.id === t.id) || null;
      b.classList.toggle('bonus', !!(t.bonus || (def && def.bonus)));
      const medal = t.medal ? `<span class="chip ${esc(t.medal)}">${esc(String(t.medal)).toUpperCase()}</span>` : '';
      b.innerHTML =
        `<canvas class="stage-art" width="360" height="206" aria-hidden="true"></canvas>
         <div class="pick-top">
           <span class="pick-name">${esc(t.name || t.id)}</span>
           ${t.locked ? `<span class="lock"><b>&#128274;</b>LOCKED</span>` : medal}
         </div>`;
      b.addEventListener('click', () => this._pickTrack(t));
      g.appendChild(b);
      const cv = b.querySelector('.stage-art');
      if (cv && def) {
        drawStage(cv, def, t.locked, { art: this._stageArt(t.id), elev: t.elev || def.elev });
      }
    }
    this._syncTrackFoot(list);
  }

  /**
   * The hero: the selected stage's key art full-bleed, with its name, its
   * chips, its records and the whole lap drawn big over the dark left third.
   *
   * Same two-layer contract as _renderGarageHero and the same reasons. The
   * BACKDROP is a CSS background-image written only when the URL actually
   * changes, so re-rendering does not make the browser re-decode a 150 KB
   * JPEG; with no art the `has-art` class stays off and styles.css draws a
   * per-theme gradient instead, which is why `data-theme` is set either way.
   * The MAP is drawn by the same `drawStage` the thumbnails use, with the
   * photograph turned off — it is line work over a dark panel at that size,
   * and it never depends on an asset.
   */
  _renderTracksHero(list) {
    const cur = list.find(t => t.id === this._sel.trackId) || list[0] || null;
    const def = cur ? (TRACKS.find(x => x.id === cur.id) || null) : null;

    const el = this.el.tracksHero;
    if (el) {
      el.dataset.theme = (def && def.theme) || 'training';
      const img = artImage(this._stageArt(cur && cur.id));
      const src = img && img.nodeName === 'IMG' ? img.src : '';
      if (src !== this._trackArtSrc) {
        this._trackArtSrc = src;
        el.style.backgroundImage = src ? `url("${src}")` : '';
        this.scr.tracks?.style.setProperty('--menu-backdrop', src ? `url("${src}")` : 'none');
        el.classList.toggle('has-art', !!src);
      }
    }

    const host = this.el.tracksDetail;
    if (!host) return;
    if (!cur) { host.innerHTML = ''; return; }
    host.classList.toggle('locked', !!cur.locked);

    const medal = cur.medal
      ? `<span class="chip ${esc(cur.medal)}">${esc(String(cur.medal)).toUpperCase()}</span>` : '';
    /* The chip row is derived from the track schema, so a wave-6 stage that
       declares banks, whoops, pads, routes, a difficulty and named set pieces
       advertises all of them, and a stage written before §6.1 produces exactly
       the chips this screen had before. */
    const chips = def ? stageChips(def) : [];
    const times = (cur.best != null || cur.bestLap != null)
      ? `<div class="pick-times">
           <span><em>BEST</em>${fmtTime(cur.best)}${cur.bestItems ? ITEM_FLAG : ''}</span>
           <span><em>LAP</em>${fmtTime(cur.bestLap)}${cur.bestLapItems ? ITEM_FLAG : ''}</span>
         </div>` : '<div class="pick-times"></div>';

    host.innerHTML =
      `<div class="pick-top">
         <span class="pick-name">${esc(cur.name || cur.id || '')}</span>
         ${cur.locked ? `<span class="lock"><b>&#128274;</b>LOCKED</span>` : medal}
       </div>
       <div class="pick-tag">${esc(cur.tagline || '')}</div>
       <div class="pick-meta">${chips.map(c =>
        `<span class="chip${c.kind ? ' ' + c.kind : ''}">${esc(c.text)}</span>`).join('')}</div>
       <canvas class="track-map" width="560" height="320" aria-hidden="true"></canvas>
       ${times}` +
      (cur.locked && cur.lockHint
        ? `<div class="pick-meta"><span class="chip info">${esc(cur.lockHint)}</span></div>` : '');

    const cv = host.querySelector('.track-map');
    this._trackMapObserver?.disconnect();
    if (cv && def) {
      const redraw = () => {
        const rect = cv.getBoundingClientRect();
        cv.width = Math.max(1, Math.round(rect.width));
        cv.height = Math.max(1, Math.round(rect.height));
        drawStage(cv, def, cur.locked, { elev: cur.elev || def.elev, mapOnly: true });
      };
      if (typeof ResizeObserver !== 'undefined') {
        this._trackMapObserver = new ResizeObserver(redraw);
        this._trackMapObserver.observe(cv);
      }
      redraw();
    }
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
    /* The hero IS the selection now, so it has to follow it. Only the hero:
       re-rendering the strip would rebuild the five buttons under the focus
       ring and throw away the ring's element identity mid-press. */
    this._renderTracksHero(this._trackList(this._data.tracks || {}));
    this._syncTrackFoot(this._trackList(this._data.tracks || {}));
    /* ARCHITECTURE §6.8. The backdrop is not live on this screen any more, so
       nothing swaps a sky from here — but main.js still reads App.trackId out
       of it, and that is what the garage builds its sky from when you walk in. */
    this._emit({ type: 'preview', trackId: t.id });
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
    /* Same rule for the machine, and for the same reason: seed from the
       payload when we have no pick of our own, so the garage opens on what the
       player last raced instead of on whatever happens to be first in the
       roster. The 3D inset follows main.js's id, so without this the hero and
       the live car disagree the moment you walk in. */
    if (d.vehicleId && !this._sel.vehicleId &&
      list.some(v => v.spec.id === d.vehicleId && !v.locked)) {
      this._sel.vehicleId = d.vehicleId;
    }
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
    this._renderGarageHero(list);

    /* The strip. Same `.pick` markup contract as the stage cards and as the
       grid this replaced — a focusable <button class="pick" data-focus
       data-id> — because the focus manager below walks [data-focus] purely by
       class name and getBoundingClientRect() geometry. Four cards in a row
       instead of a column is a layout change and nothing else; keyboard,
       d-pad and the pointerdown re-homing all keep working untouched.

       The name, the description and the bars are NOT here any more. They are
       one block over the hero, because saying them four times in four boxes
       is what made this screen a spreadsheet. */
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
      cv.className = 'car-art'; cv.width = 480; cv.height = 270;
      const top = document.createElement('div');
      top.className = 'pick-top';
      top.innerHTML = `<span class="pick-name">${esc(s.name || s.id)}</span>` +
        (v.locked ? `<span class="lock"><b>&#128274;</b>LOCKED</span>`
          : `<span class="chip info">${Math.round((s.topSpeed || 0) * 3.6)} KM/H</span>`);
      b.appendChild(cv); b.appendChild(top);
      b.addEventListener('click', () => this._pickCar(v));
      g.appendChild(b);
      drawCar(cv, s, { art: this._vehArt(s.id) });
    }
    this._syncGarageFoot(list);
  }

  /**
   * The hero: the selected machine's key art full-bleed, with its name, its
   * numbers and the lock state overlaid on the dark left third.
   *
   * Two layers and both degrade on their own. The BACKDROP is a CSS
   * background-image set idempotently — the src is only written when it
   * actually changes, exactly as setLoadingArt does it, so re-rendering the
   * screen does not make the browser re-decode a 200 KB JPEG. With no art the
   * `has-art` class stays off and styles.css draws a deliberate gradient
   * instead. The OVERLAY is the same DOM the cards used to carry, built once
   * for the selection rather than four times.
   */
  _renderGarageHero(list) {
    const cur = list.find(v => v.spec.id === this._sel.vehicleId) || list[0] || null;
    const s = (cur && cur.spec) || {};

    const el = this.el.garageHero;
    if (el) {
      const img = artImage(this._vehArt(s.id));
      const src = img && img.nodeName === 'IMG' ? img.src : '';
      if (src !== this._vehArtSrc) {
        this._vehArtSrc = src;
        el.style.backgroundImage = src ? `url("${src}")` : '';
        el.classList.toggle('has-art', !!src);
      }
    }

    const host = this.el.garageDetail;
    if (!host) return;
    if (!cur) { host.innerHTML = ''; return; }
    const st = cur.stats || {};
    host.classList.toggle('locked', !!cur.locked);
    host.innerHTML =
      `<div class="pick-top">
         <span class="pick-name">${esc(s.name || s.id || '')}</span>
         ${cur.locked ? `<span class="lock"><b>&#128274;</b>LOCKED</span>`
        : `<span class="chip info">${Math.round((s.topSpeed || 0) * 3.6)} KM/H</span>`}
       </div>
       <div class="pick-tag">${esc(s.desc || '')}</div>
       <div class="stats">` +
      this._statRow('SPEED', st.speed) + this._statRow('ACCEL', st.accel) +
      this._statRow('GRIP', st.grip) + this._statRow('WEIGHT', st.weight, true) +
      `</div>` +
      (cur.locked && cur.lockHint
        ? `<div class="pick-meta"><span class="chip info">${esc(cur.lockHint)}</span></div>` : '');
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
    /* The hero IS the selection now, so it has to follow it. Only the hero:
       re-rendering the strip would rebuild the four buttons under the focus
       ring and throw away the ring's element identity mid-press. */
    const list = this._vehicleList(this._data.garage || {});
    this._renderGarageHero(list);
    this._syncGarageFoot(list);
    // ARCHITECTURE §6.8: the machine on the menu pad swaps from this.
    this._emit({ type: 'preview', vehicleId: v.spec.id });
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
      .map(([what, how]) => `<div class="keyrow"><span>${esc(what)}</span><b>${esc(how)}</b></div>`).join('')
      + `<p class="ctl-more">Full reference in the PLAYBOOK.</p>`;
  }

  /* ============================================================
     PLAYBOOK
     ------------------------------------------------------------
     The tab strip is ONE [data-focus] element and handles `ui-step`, exactly
     the way a settings segment does. That is deliberate: the focus manager is
     shared and untouched, and left/right on a focused strip changes tab
     instead of jumping out of it.
     ============================================================ */
  _buildPlaybook() {
    const strip = this.el.playbookTabs;
    if (!strip) return;
    strip.innerHTML = '';
    for (let i = 0; i < PLAYBOOK_TABS.length; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = PLAYBOOK_TABS[i];
      b.setAttribute('role', 'tab');
      b.dataset.i = String(i);
      b.addEventListener('click', () => this._setTab(i));
      strip.appendChild(b);
    }
    strip.addEventListener('ui-step', (e) => {
      const n = PLAYBOOK_TABS.length;
      this._setTab((this._tab + (e.detail > 0 ? 1 : -1) + n) % n);
    });
  }

  _setTab(i) {
    if (i === this._tab) return;
    this._tab = i;
    this._sfx('tick');
    this._renderPlaybook();
    // The pane's contents changed under the focus ring, so it has to be
    // re-collected or the next d-pad press walks a list that is gone.
    this._collectFocus();
  }

  _renderPlaybook() {
    const strip = this.el.playbookTabs, body = this.el.playbookBody;
    if (strip) for (const b of strip.children) b.classList.toggle('on', +b.dataset.i === this._tab);
    if (this.el.playbookHint) {
      this.el.playbookHint.textContent = this._method === 'pad'
        ? 'LB / RB · TABS' : this._method === 'touch' ? 'TAP A TAB' : '← → TABS';
    }
    if (!body) return;
    body.innerHTML = playbookHTML(this._tab, this._method, BINDINGS, esc);
    paintIcons(body);
    body.scrollTop = 0;
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
      /* The medal and the best trick sit together: one says how you placed,
         the other says how you looked doing it, and on this game the second
         is half the reason anybody replays a stage. Both are optional. */
      const me = P.find(p => p && p.isPlayer) || 0;
      const bestTrick = d.bestTrick || (me && me.bestTrick) || '';
      const bestPts = d.bestTrickPts != null ? d.bestTrickPts : (me ? me.bestTrickPts : null);
      this.el.resultsMedal.innerHTML =
        (d.medal ? `<span class="medal-award ${esc(d.medal)}">&#9679; ${esc(String(d.medal)).toUpperCase()} MEDAL</span>` : '') +
        (bestTrick ? `<span class="best-trick">BEST TRICK · ${esc(bestTrick)}${bestPts ? ` +${bestPts | 0}` : ''}</span>` : '');
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
        /* STYLE: the trick total for the race. A dash rather than a zero for
           anyone who never left the ground — a column of noughts reads as a
           broken feature, a column of dashes reads as "not this driver". */
        const st = p.style | 0;
        return `<div class="class-row${p.isPlayer ? ' me' : ''}${p.dnf ? ' dnf' : ''}${p.est ? ' est' : ''}"${p.est ? ' title="Still running when the flag fell — projected from their own pace"' : ''}>
            <span class="p">${p.dnf ? '—' : i + 1}</span>
            <span class="nm"><i class="dot" style="background:${col}"></i>${esc(p.name || '—')}</span>
            <span>${time}</span>
            <span class="${best ? 'rec' : ''}">${fmtTime(p.bestLap)}</span>
            <span class="sty">${st > 0 ? st : '—'}</span>
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
      this.el.resultsBtns.innerHTML = (d.nextTrackId ? '' : '<span aria-hidden="true"></span>') + btns
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
      case 'main-playbook': this._sfx('ok'); this._playbookFrom = 'main'; this._nav('playbook'); break;

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

      /* The playbook is reachable from MAIN and from PAUSE, and must go back
         to whichever one sent it — backing a paused player out to the main
         menu would quietly bin their race. */
      case 'playbook-back': this._sfx('back'); this._nav(this._playbookFrom || 'main', true); break;

      case 'pause-resume': this._sfx('back'); this._emit({ type: 'resume' }); break;
      case 'pause-restart': this._sfx('ok'); this._emit({ type: 'restart' }); break;
      case 'pause-playbook': this._sfx('ok'); this._playbookFrom = 'pause'; this._nav('playbook'); break;
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
      case 'playbook': this._act('playbook-back'); break;
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

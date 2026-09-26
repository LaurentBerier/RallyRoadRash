/* ============================================================
   RALLY ROAD RASH — RACE SESSION
   ------------------------------------------------------------
   One race, from the grid to the results board. main.js builds the world
   (terrain, sky, props, dust) during the loading screen and hands it over;
   from that moment this object OWNS it, including disposal.

   The frame order below is the contract from docs/ARCHITECTURE.md and it is
   not negotiable — several modules depend on being read at a specific point:

     1  controls            player ctl from raw, AI ctl from AIDriver
     2  vehicle.step        all six, then
     3  resolveVehiclePair  all fifteen pairs exactly once, then
     4  props.resolve       per vehicle, and only THEN
     5  read hardHit        step() zeroes it and the collision passes max into it
     6  tracker.update      events -> hud / audio
     7  wheel effects       ruts, tyre marks, dust, suspension clunks
     8  reset system
     9  camera + feel
    10  terrain / sky / props / dust
    11  audio.update        exactly once per frame
    12  hud.update

   Everything in the per-frame path reuses module scratch objects. There is
   one allocation left on a normal frame — none.
   ============================================================ */
import * as THREE from 'three';
import {tickWreck,WRECK_CTL} from './wreck.js';
import {rocketRecoveryTarget,safeRecoveryS} from './recovery.js';
import { Vehicle, resolveVehiclePair } from './vehicle.js';
import { VEHICLES } from './vehicles.js';
import { TUNE } from './config.js';
import { SURF, SURFACES } from '../world/surfaces.js';
import { DUST_KIND } from '../world/dust.js';
import { RaceTracker, formatTime } from './racecore.js';
import { AIDriver, makeGridProfiles } from './ai.js';
import { Arsenal } from './arsenal.js';
import { PICKUP } from './weapons.js';
import { RaceFX } from './racefx.js';
import { CAM } from './camera.js';
import { applyResult, TRACK_ORDER, shouldTip, markTip } from './progression.js';
import { Save } from '../core/save.js';
import { makeRNG, clamp } from '../core/rng.js';
import { spanHas } from '../world/track.js';

export const RS = { GRID: 0, COUNTDOWN: 1, RUNNING: 2, FINISHED: 3, RESULTS: 4 };
const RS_NAME = ['grid', 'countdown', 'running', 'finished', 'results'];

const FIELD = 6;                    // one player + five rivals
const GRID_TIME = 1.2;              // s of "everyone is here" before the lights
const COUNT_TIME = 3.0;             // 3 · 2 · 1 at one-second marks, then green
const FINISH_HOLD = 2.2;            // s the sim keeps running after you cross
/* Fraction of the race distance a rival must have covered by the time the
   board freezes to be classified rather than retired. See _showResults(). */
const DNF_FRAC = 0.35;
const PLAYER_SLOT = 5;              // last on the grid: the whole field to pass

/* TUNE.reset carries the distance but not a dwell time, and yanking a car back
   the instant it strays 25 m would punish a wide line over a crest. Two and a
   half seconds out there means genuinely lost. */
const OFF_COURSE_TIME = TUNE.reset.offCourseTime ?? 2.5;
const RIVAL_RANGE = 40;             // m — the rival the engine mix can hear
const RIVAL_SWAP = 1.0;             // s minimum before the rival voice moves
const POS_STINGER_GAP = 1.0;        // s between position up/down stingers
const CLUNK_VEL = 1.9;              // m/s of compression velocity that thumps
const IMPACT_MIN = 2.0;             // m/s of closing speed worth hearing
const BOOST = TUNE.boost;           // read every frame in _wheelEffects

const AI_NAMES = ['MARA', 'JUKKA', 'REY', 'OTTO', 'SANNE'];
/* The one thing anybody can be hit with, as the race log names it. */
const WEAPON_NAME = 'ROCKET';
/* Minimap dots have to be told apart at four pixels across, which the three
   car colours cannot do on their own. The player keeps their car's colour. */
import { RIVAL_COLORS } from './racer-colors.js';

/* ---------------- module scratch ---------------- */
const _v1 = new THREE.Vector3();
const _sp = { x: 0, y: 0, z: 0 };
const _sd = { x: 0, z: 0 };
const _near = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };
const _near2 = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };

export class Race {
  /**
   * @param o.engine      core/engine.js Engine
   * @param o.input       core/input.js Input
   * @param o.audio       core/audio.js Audio
   * @param o.ui          ui/ui.js UI facade
   * @param o.hud         ui/hud.js HUD
   * @param o.rig         game/camera.js CameraRig
   * @param o.feel        game/feel.js Feel
   * @param o.terrain     built world — Race disposes all four
   * @param o.sky
   * @param o.props
   * @param o.dust
   * @param o.trackDef    tracks/*.js default export
   * @param o.trackData   terrain.trackData (already built by the bake)
   * @param o.vehicleSpec the player's car
   * @param o.difficulty  0..1
   * @param o.profile     progression profile (read for the AI car pool)
   * @param o.onExit      () => void      — quit to menu
   * @param o.onProfile   (p) => void     — a new profile was written
   * @param o.onSetting   (k, v) => void  — the race changed a saved setting
   */
  constructor(o) {
    this.engine = o.engine; this.input = o.input; this.audio = o.audio;
    this.ui = o.ui; this.hud = o.hud; this.rig = o.rig; this.feel = o.feel;
    this.terrain = o.terrain; this.sky = o.sky; this.props = o.props; this.dust = o.dust;
    /* The world's particle pool. Both ItemWorld and RaceFX were constructed
       with `vfx: null` and nothing ever called `vfx.update()`, so every item
       spark, hit ring, wheel ribbon, sled flame and pad flash in the game was
       allocated, wired and then never drawn — including props.js's own impact
       sparks, which go through the same pool. Three draw calls, by design. */
    this.vfx = o.vfx || null;
    this.trackDef = o.trackDef;
    this.trackData = o.trackData || o.terrain.trackData;
    this.spline = this.trackData.spline;
    this.shortcut = this.trackData.shortcutSpline || null;
    /* Every alternate line, not just the one `shortcut` aliases. The
       off-course net measures distance to the nearest LEGAL road, and a
       route the net does not know about is a road that resets you for
       driving it — canyon's MESA TOP sits 26 m off the main line, 4 m inside
       the gate, and used to be uncheckable. */
    this.routes = this.trackData.routes || [];
    this.playerSpec = o.vehicleSpec || VEHICLES[0];
    this.difficulty = clamp(o.difficulty == null ? 0.5 : o.difficulty, 0, 1);
    this.profile = o.profile || null;
    this.onExit = o.onExit || (() => { });
    this.onProfile = o.onProfile || (() => { });
    this.onSetting = o.onSetting || (() => { });
    this.trickAssist = o.trickAssist == null ? 1 : (o.trickAssist | 0);
    this.tips = o.tips !== false;

    this.laps = Math.max(1, this.trackDef.laps | 0);
    this.state = RS.GRID;
    this.stateT = 0;
    this.raceTime = 0;             // seconds since green; the one race clock
    this.elapsed = 0;              // seconds since the session began (music grid)
    this.paused = false;
    this.resetHold = 0;
    this.countdownN = -1;
    this._beat = -1;
    this._disposed = false;
    this._resultsShown = false;
    this._posT = 0;
    this._rivalT = 0;
    this._rivalId = -1;
    this._playerPos = FIELD;
    this._offCourse = 0;
    this._wrongWay = false;

    /* deterministic per track: the same grid, the same AI personalities, the
       same liveries every time you press RACE on the same circuit */
    this.rng = makeRNG((this.trackDef.seed | 0) ^ 0x5A17);

    this.racers = [];
    this.player = null;
    this._buildField();

    this.tracker = new RaceTracker({
      ids: this.racers.map(r => r.id),
      laps: this.laps,
      lapLength: this.trackData.lapLength || this.spline.length,
      spline: this.spline, routes: this.routes,
      checkpoints: this.trackData.checkpoints
    });

    /* ---- the arsenal ----
       Rockets on every roof, crates and nitro cans on the road. Sited off
       the TRACK seed, not the race stream, so the layout is a property of
       the stage and a sweep in dev/qa-drive.js stays reproducible between
       builds. `weapons` false is the purist toggle: the system still exists,
       it is simply inert and invisible. (`items` is read as a fallback until
       main.js's option bag is renamed — contract 8.10.) */
    const weaponsOn = (o.weapons === undefined ? o.items : o.weapons) !== false;
    this.arsenal = new Arsenal({
      scene: this.engine.scene, terrain: this.terrain, trackData: this.trackData,
      dust: this.dust, audio: this.audio, feel: this.feel, engine: this.engine,
      props: this.props, racers: this.racers, tracker: this.tracker, rng: this.rng,
      seed: this.trackDef.seed, enabled: weaponsOn, vfx: this.vfx,
    });
    /* Presentation. Everything this object does is a sound, a particle or a
       shake; nothing it does can change the race. See racefx.js. */
    this.fx = new RaceFX({
      audio: this.audio, feel: this.feel, dust: this.dust, terrain: this.terrain,
      hud: this.hud, engine: this.engine, vfx: this.vfx,
    });
    /* Set at the green flag and never cleared mid-race: a record set with
       weapons on is FLAGGED as such, and toggling them off on the last lap
       must not launder it. The record field keeps its old name (`itemsTotal`
       / `itemsLap` in progression.js are a locked whitelist). */
    this.weaponsFlag = false;

    /* ---- reusable per-frame payloads ---- */
    this._pctl = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };
    this._aictx = {
      vehicles: this.racers.map(r => r.vehicle), tracker: this.tracker,
      // Read-only view of the arsenal, so a driver can aim, dodge and decide
      // whether a crate is worth the detour (contract 8.11). See ai-weapons.js.
      arsenal: this.arsenal, myId: 0, state: 'countdown',
      /* Who the field is actually racing. AI_BALANCE.player reads the gap to
         this slot; without it the grid balances beautifully against itself
         while the player watches it disappear. */
      playerId: PLAYER_SLOT,
    };
    this._look = { lookX: 0, lookY: 0, zoom: 0 };
    this._as = {
      rpm: 0, load: 0, speed: 0, slipLat: 0, slipLong: 0, surface: 0,
      airborne: false, contacts: 4, scrape: 0, rivalRpm: null, rivalPan: 0
    };
    /* `nextCp` is beyond the contract: hud.js flagged that it can only draw a
       fixed off-course pill without somewhere to point. It costs nothing here
       (the tracker already knows) and an extra field cannot break a reader. */
    this._hudNextCp = { x: 0, z: 0, dist: 0, idx: 0 };
    this._hudRace = {
      state: 'grid', countdown: -1, position: FIELD, total: FIELD, lap: 1, laps: this.laps,
      raceTime: 0, lastLap: 0, bestLap: 0, wrongWay: false, resetHold: 0, offCourse: 0,
      finalLap: false,
      nextCp: this._hudNextCp
    };
    /* The full §6.6 vehicle payload. `drift`/`boost`/`trick` were in hud.js's
       contract from wave 5 and were never written, so the mini-turbo charge
       arc, the boost bar and the trick pop have never drawn. */
    this._hudVeh = {
      speedKmh: 0, gear: 0, rpmNorm: 0, airborne: false, airTime: 0,
      drift: 0, driftTier: 0, boost: 0, boostTier: 0, trick: null,
    };
    this._hudTrick = { id: 0, name: '', pts: 0, tier: 0, seq: 0 };
    this._hudVeh.trick = this._hudTrick;
    this._hudDots = this.racers.map(r => ({ x: 0, z: 0, color: r.color, isPlayer: r.isPlayer }));
    this._hudRival = { name: '', gap: 0 };
    /* Contract 8.3: the `item` block is REPLACED, not extended. Pre-allocated;
       the one string is a constant the Arsenal picks by kind. */
    this._hudArsenal = {
      enabled: true, ammo: 0, ammoCap: 0, reloadT: 0, nitroT: 0,
      pickupSeq: 0, pickupKind: -1, pickupText: '', fireSeq: 0,
    };
    /* Hit / dealt / pad / land, as sequence numbers. hud.js has drawn the race
       log since wave 5 and nothing ever handed it an event, so `#hLog` has
       been an empty box in the corner ever since. */
    this._hudEvents = {
      hitSeq: 0, hitBy: '', hitWith: '',
      dealtSeq: 0, dealtTo: '', dealtWith: '',
      rivalFireSeq: 0, rivalFireBy: '', rivalFireWith: '',
      noteSeq: 0, noteText: '',
      padSeq: 0, landSeq: 0,
    };
    this._hudPayload = {
      race: this._hudRace, vehicle: this._hudVeh, dots: this._hudDots,
      rival: null, arsenal: this._hudArsenal, events: this._hudEvents,
    };
    /* Last-seen edges of the Arsenal's own counters. Separate from the HUD's,
       because one arsenal event can produce a different HUD event depending
       on who it happened to. */
    this._lastHitSeq = 0; this._lastPadSeq = 0;
    this._lastFireSeq = 0; this._lastNoteSeq = 0; this._lastPickSeq = 0;
    this._tipPadSeq = 0;

    this._enterGrid(true);
  }

  /* ============================================================
     SETUP
     ============================================================ */

  /**
   * Five rivals plus the player. Rival cars are drawn from the WHOLE roster,
   * locked or not: seeing a Redline disappear up the road is the advert for
   * unlocking one, and a grid of six identical buggies reads as a placeholder.
   */
  _buildField() {
    const profiles = makeGridProfiles(FIELD - 1, this.difficulty, this.rng);
    const pool = VEHICLES;
    // Deterministic spread: walk the roster so no grid is all one car, with a
    // seeded offset so two tracks do not line up identically.
    const off = (this.rng() * pool.length) | 0;

    for (let i = 0; i < FIELD; i++) {
      const isPlayer = i === PLAYER_SLOT;
      const spec = isPlayer ? this.playerSpec : pool[(i + off) % pool.length];
      const v = new Vehicle(this.engine.scene, this.terrain, spec, { livery: isPlayer ? 0 : i + 1 });
      /* props.js reads `collideR`; vehicle.js publishes the same number as
         `collRadius`. Bridging it here is the whole fix — neither file is
         mine to edit, and without it every car uses the 1.15 m fallback. */
      v.collideR = v.collRadius;
      /* The TRICK ASSIST setting reached no car at all until this line: the
         menu wrote it to the profile and nothing ever read it back on to a
         vehicle. Rivals sit at ARCADE — they have no eyes for a landing. */
      v.trickAssist = isPlayer ? (this.trickAssist | 0) : 2;

      const r = {
        id: i,
        isPlayer,
        name: isPlayer ? 'YOU' : AI_NAMES[i % AI_NAMES.length],
        color: isPlayer ? spec.color : RIVAL_COLORS[i % RIVAL_COLORS.length],
        spec, vehicle: v, ai: null,
        slot: i,
        wasAir: false, airPeak: 0,
        /* Trick columns. Always present, never lazily added: arsenal.js
           reads racer rows through a fixed shape and a hidden class change
           mid-race costs more than the three slots do. */
        style: 0, bestTrick: 0, trickSeq: 0,
        ghostT: 0, flipT: 0, stuckT: 0, offT: 0,
        bestS: null, noProgT: 0, resetWhy: null,
        finished: false, pos: i + 1,
        lastGround: [],
        clunkT: new Float32Array(4),
        bottomT: new Float32Array(4)
      };
      for (let w = 0; w < 4; w++) r.lastGround.push({ x: 0, y: 0, z: 0, has: false });

      if (!isPlayer) {
        r.ai = new AIDriver(i, v, this.trackData, profiles[i] || { name: r.name, skill: 0.6, aggression: 0.5, consistency: 0.6 }, this.rng);
        if (profiles[i] && profiles[i].name) r.name = profiles[i].name;
      }
      this.racers.push(r);
      if (isPlayer) {this.player = r;v._flameLight=new THREE.PointLight(0xff8c24,0,4,2);v.chassis.add(v._flameLight);}
    }
  }

  /** Put the field on the grid. Called at construction and by restart(). */
  _enterGrid(first) {
    this.fx.reset();
    const slots = this.trackData.gridSlots;
    for (const r of this.racers) {
      const g = slots[r.slot % slots.length];
      r.vehicle.placeAt(g.x, g.z, g.yaw);
      r.vehicle.ghost = false;
      r.wasAir = false; r.airPeak = 0;
      r.ghostT = 0; r.flipT = 0; r.stuckT = 0; r.offT = 0;
      r.bestS = null; r.noProgT = 0;   // stale baselines from the last race
                                       // would instant-trigger the watchdog
      r.finished = false; r.pos = r.slot + 1;
      for (let w = 0; w < 4; w++) { r.lastGround[w].has = false; r.clunkT[w] = 0; r.bottomT[w] = 0; }
      if (r.ai && r.ai.notifyReset) r.ai.notifyReset();
      this.tracker.notifyTeleport(r.id, g.x, g.z);
    }

    this.state = RS.GRID; this.stateT = 0;
    /* Stand the scenery back up, for the same reason the watchdog baselines
       above are cleared: anything the LAST race left lying down is state this
       one did not earn. It belongs here rather than in restart() because a
       fresh Race on a stage whose props are already flattened — which is every
       run after the first in a qa-drive sweep — is not the track the first run
       measured, and lap times compared across builds are the whole point. */
    this.props.resetDynamic();
    /* And the ground itself. restart() already did these two; a FRESH Race did
       not, so a second race on a stage inherited the first one's ruts — and a
       rut is not decoration, it is subtracted from terrain.heightAt and the
       wheels feel it. That is a lap-time difference with no cause in the
       build, which is exactly what qa-drive exists to detect. */
    this.terrain.clearDent();
    this.terrain.clearTrails();
    this.arsenal.resetAll();
    this.weaponsFlag = false;
    this.raceTime = 0; this.countdownN = -1; this._beat = -1;
    this.resetHold = 0; this._resultsShown = false;
    this._wrongWay = false; this._offCourse = 0; this._playerPos = PLAYER_SLOT + 1;

    /* The rig outlives the race, and _showResults leaves it in ORBIT — a race
       must never START there (the podium spin chasing a moving car is the
       "camera keeps orbiting" bug). raceMode is the stash _showResults makes
       of the mode the player actually drove with; ORBIT itself is never a
       grid mode, so it sanitises to CHASE. */
    if (this.rig.mode === CAM.ORBIT) {
      const m = this.rig.raceMode;
      this.rig.setMode(m == null || m === CAM.ORBIT ? CAM.CHASE : m, this.player.vehicle);
    }
    this.rig.snapBehind(this.player.vehicle);
    if (this.feel && this.feel.reset) this.feel.reset();
    this.input.lock();
    this.input.showTouch(true);

    /* Audio obligation: character, then the car layer, then the score — all
       before the first beep, so the countdown lands into a live mix. The
       stage picks its own theme (contract 8.7); guarded until it lands. */
    this.audio.setEngineCharacter(this.playerSpec);
    this.audio.setDriving(true);
    if (this.audio.setRaceTheme) this.audio.setRaceTheme(this.trackDef.theme);
    this.audio.setMusicMode('race');

    if (first) {
      this.hud.showRace({
        trackName: this.trackDef.name,
        laps: this.laps,
        racers: this.racers.map(r => ({ id: r.id, name: r.name, color: r.color, isPlayer: r.isPlayer }))
      });
      this.hud.bakeMap(this.terrain, this.trackData);
    }
    this.hud.banner(this.trackDef.name, 'good', 2.0);
  }

  /* ============================================================
     SESSION CONTROL (main.js wires these to the UI actions)
     ============================================================ */
  togglePause() { this.paused ? this.resume() : this.pause(); }

  /** The WEAPONS setting, applied live — a pause-screen toggle takes effect now. */
  setWeaponsEnabled(on) {
    this.arsenal.setEnabled(on);
    if (on) this.weaponsFlag = this.weaponsFlag || this.state >= RS.RUNNING;
  }
  /** The setting's old name (contract 8.10). main.js swaps to the new one. */
  setItemsEnabled(on) { this.setWeaponsEnabled(on); }

  pause() {
    if (this.paused || this.state === RS.RESULTS) return;
    this.paused = true;
    this.input.unlock();
    this.input.showTouch(false);
    // The car goes quiet, the score does not: silence on pause reads as a bug.
    this.audio.setDriving(false);
    this.audio.ui('back');
    this.ui.show('pause', {
      trackName: this.trackDef.name,
      position: this._playerPos,
      laps: this.laps,
      lap: Math.min(this.laps, this.tracker.progress(this.player.id).lap + 1)
    });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.ui.hide('pause');
    this.input.lock();
    this.input.showTouch(true);
    this.audio.setDriving(true);
    this.audio.resume();
    this.audio.ui('ok');
  }

  /** Re-grid on the terrain we already baked — a restart must not cost 6 s. */
  restart() {
    this.paused = false;
    this.ui.hide();
    this.terrain.clearDent();
    this.terrain.clearTrails();
    this.dust.clear();
    // (the felled scenery is stood back up by _enterGrid, below)
    this.arsenal.resetAll();
    this.tracker.resetAll();
    this._enterGrid(false);
    this.input.lock();
    this.input.showTouch(true);
    this.audio.setDriving(true);
  }

  quit() {
    this.paused = false;
    this.onExit();
  }

  /* ============================================================
     FRAME
     ============================================================ */
  update(dt, raw) {
    if (this._disposed) return;

    // Esc is the one key that works in every state, including paused.
    if (this.input.hit('Escape')) {
      if (this.state !== RS.RESULTS) this.togglePause();
    }
    if (this.paused) return;

    if (this.input.hit('KeyC')) {
      this.rig.cycle(this.player.vehicle);
      this.audio.ui('tick');
      this.onSetting('camMode', this.rig.mode);
    }

    this.elapsed += dt;
    this.stateT += dt;
    this._advanceState(dt);

    const live = this.state === RS.RUNNING || this.state === RS.FINISHED;
    if (this.state !== RS.RESULTS) {
      /* FIRE — F, X on a pad, the on-screen FIRE. All three land on KeyF in
         input.js, so one edge covers them; holding reverse fires behind. No
         queue: a rack is either loaded or it is not, and an empty one says
         so itself (Arsenal.fire). */
      if (live && this.input.hit('KeyF')) {
        this.arsenal.fire(PLAYER_SLOT, (raw.throttle || 0) < -0.25);
      }
      /* The arsenal steps BEFORE the cars, so a hit landed this frame is
         felt this frame rather than next. See the header note in arsenal.js. */
      this.arsenal.step(dt, live);
      this._stepVehicles(dt, raw);
      if (live) {
        this.raceTime += dt;
        this._tickTracker(dt);
      }
      this._wheelEffects(dt);
      this._resetSystem(dt, raw);
    }

    /* ---- visuals ----
       AFTER every pass that can still move a body this frame (physics, the
       car↔car pairs, the prop resolve, the reset system), and unconditionally:
       in RESULTS the cars are parked but the orbit camera still looks at them,
       and a wheel frozen at the chassis origin is visible from every angle.
       Headless vehicles no-op on the root check. */
    for (const r of this.racers) r.vehicle.updateVisuals(dt);
    this.arsenal.updateVisuals(dt, this.engine.camera);

    /* ---- camera, then the world it looks at ---- */
    this._look.lookX = raw.lookX || 0;
    this._look.lookY = raw.lookY || 0;
    this._look.zoom = raw.zoom || 0;
    this.rig.update(dt, this.player.vehicle, this._look);
    if (this.feel) this.feel.update(dt, this.player.vehicle);

    const cam = this.engine.camera;
    this.terrain.update(dt, cam, this.sky.sunDir);
    this.sky.update(dt, cam, this.elapsed);
    this.props.update(dt, this.elapsed, cam);
    this.dust.update(dt);
    if (this.vfx) this.vfx.update(dt, cam);
    this.engine.aimShadow(this.player.vehicle.pos, this.sky.sunDir);

    this._mixAudio(dt);
    this._feedHud(dt);
  }

  /* ---------------- state machine ---------------- */
  _advanceState(dt) {
    void dt;
    switch (this.state) {
      case RS.GRID:
        if (this.stateT >= GRID_TIME) { this.state = RS.COUNTDOWN; this.stateT = 0; this._beat = -1; }
        break;

      case RS.COUNTDOWN: {
        // 3 at t=0, 2 at t=1, 1 at t=2, green at t=3.
        const beat = Math.min(3, Math.floor(this.stateT));
        if (beat !== this._beat) {
          this._beat = beat;
          if (beat < 3) {
            this.countdownN = 3 - beat;
            this.audio.countdownBeep(this.countdownN);
            this.hud.countdown(this.countdownN);
          } else {
            this.countdownN = 0;
            this.audio.countdownGo();
            this.hud.countdown('GO');
            this.state = RS.RUNNING; this.stateT = 0;
            this.weaponsFlag = this.weaponsFlag || this.arsenal.enabled;
            this.raceTime = 0;
          }
        }
        if (this.stateT >= COUNT_TIME && this.state === RS.COUNTDOWN) {
          this.state = RS.RUNNING; this.stateT = 0; this.raceTime = 0;
          this.weaponsFlag = this.weaponsFlag || this.arsenal.enabled;
        }
        break;
      }

      case RS.FINISHED:
        if (this.stateT >= FINISH_HOLD) this._showResults();
        break;

      default: break;
    }
  }

  /* ---------------- 1-2: controls and physics ---------------- */
  _stepVehicles(dt, raw) {
    const locked = this.state === RS.GRID || this.state === RS.COUNTDOWN;
    const aiState = locked ? 'countdown' : (this.state === RS.RUNNING ? 'running' : 'finished');
    this._aictx.state = aiState;

    for (const r of this.racers) {
      const v = r.vehicle;
      let ctl;
      if (r.isPlayer) {
        const c = this._pctl;
        if (locked) {
          // Brakes on, engine live: the countdown has to feel like held revs.
          c.throttle = 0; c.steer = 0; c.brake = 1; c.handbrake = 1; c.roll = 0;
        } else {
          c.throttle = raw.throttle || 0;
          c.steer = raw.steer || 0;
          c.brake = raw.brake || 0;
          c.handbrake = raw.handbrake ? 1 : 0;
          c.roll = raw.roll || 0;
        }
        ctl = c;
      } else {
        // A finished AI is told to cruise by its own state machine; before the
        // lights it holds the brake. Either way it only ever returns a ctl.
        this._aictx.myId = r.id;
        this._aictx.position = r.pos;
        ctl = r.ai.update(dt, this._aictx);
        /* The AI raises a hand; the Arsenal decides whether the tube is
           loaded. Either way the latch is consumed, so a reloading driver
           re-decides on its own clock rather than hammering the trigger. */
        if (r.ai.wantsFire) {
          this.arsenal.fire(r.id, !!r.ai.fireBack);
          if (r.ai.notifyFired) r.ai.notifyFired();
        }
      }
      v.gridThrottle=locked ? (r.isPlayer?clamp(raw.throttle||0,0,1):0) : null;
      v.step(dt, v.wrecked?WRECK_CTL:ctl);

      if (r.ghostT > 0) {
        r.ghostT -= dt;
        if (r.ghostT <= 0) r.ghostT = 0;
      }
      // ONE writer: the respawn ghost is the only reason to be intangible now.
      v.ghost = r.ghostT > 0;
    }

    /* All fifteen pairs, exactly once. hardHit is read AFTER this. */
    for (let i = 0; i < FIELD - 1; i++) {
      for (let j = i + 1; j < FIELD; j++) {
        const impact = resolveVehiclePair(this.racers[i].vehicle, this.racers[j].vehicle);
        if (impact > IMPACT_MIN) this.fx.contact(this.racers[i], this.racers[j], impact, this.player);
      }
    }

    for (const r of this.racers) {
      const impact = this.props.resolve(r.vehicle);
      if (impact > IMPACT_MIN) this.fx.contact(r, null, impact, this.player);
    }
  }

  /* ---------------- 5-6: post-step reads, then the tracker ---------------- */
  _tickTracker(dt) {
    const t = this.raceTime;
    for (const r of this.racers) {
      const v = r.vehicle;
      const ev = this.tracker.update(r.id, v.pos.x, v.pos.z, t);
      for (let i = 0; i < ev.length; i++) this._onEvent(r, ev[i]);
    }

    /* Standings, once. Position changes get a stinger, but not more than one a
       second — a three-wide corner exit would otherwise machine-gun. */
    const order = this.tracker.standings();
    for (let i = 0; i < order.length; i++) this.racers[order[i]].pos = i + 1;
    /* Seconds adrift of the leader, by pace. Telemetry now (the drop table
       that rolled off it went with the roulette in wave 8); kept on the row
       because dev/qa-drive.js and the results projection read gaps in
       seconds, not metres. */
    if (order.length) {
      const lead = this.tracker.progress(order[0]);
      for (let i = 0; i < order.length; i++) {
        const r = this.racers[order[i]];
        const pr = this.tracker.progress(r.id);
        const ref = Math.max(Math.abs(r.vehicle.speed), 12);
        r.behindSec = Math.max(0, (lead.raceS - pr.raceS) / ref);
      }
    }
    const pos = this.player.pos;
    this._posT += dt;
    if (pos !== this._playerPos) {
      if (this.state === RS.RUNNING && this._posT > POS_STINGER_GAP) {
        this._posT = 0;
        if (pos < this._playerPos) { this.audio.positionUp(); this.hud.banner(`P${pos}`, 'good', 1.2); }
        else this.audio.positionDown();
      }
      this._playerPos = pos;
    }
  }

  _onEvent(r, e) {
    const isP = r.isPlayer;
    switch (e.type) {
      case 'checkpoint':
        // Only the player's gates chime; six cars of chimes is a fruit machine.
        if (isP) this.audio.checkpoint();
        break;

      case 'lap': {
        if (!isP) break;
        const final = e.lap >= this.laps;
        this.audio.lapBell(final);
        if (!final) this.hud.banner(`LAP ${e.lap + 1}/${this.laps} · ${formatTime(e.lapTime)}`, 'good', 2.2);
        break;
      }

      case 'finish':
        r.finished = true;
        if (r.ai && r.ai.notifyFinish) r.ai.notifyFinish();
        if (isP && this.state === RS.RUNNING) {
          this.state = RS.FINISHED; this.stateT = 0;
          this.hud.banner(`FINISH · ${formatTime(e.total)}`, 'good', 2.6);
        }
        break;

      /* The flag only sets state. hud.js already owns the wrong-way pill AND
         fires audio.wrongWay() itself off the payload edge — ringing it here
         too would double the stinger. */
      case 'wrongway':
        if (isP) this._wrongWay = e.on;
        break;

      default: break;
    }
  }

  /* ---------------- 7: ground effects from the wheels ----------------
     One pass per contact wheel doing
     tyre marks, ruts and the rooster tail, driven off the surface table so a
     mud bog and a tarmac apron behave completely differently for free. */
  _wheelEffects(dt) {
    const cam = this.engine.camera.position;
    for (const r of this.racers) {
      const v = r.vehicle;
      const camD = v.pos.distanceTo(cam);
      // Rivals half a stage away still cut ruts nobody will ever see.
      const emit = r.isPlayer ? 1 : camD < 60 ? 0.7 : camD < 130 ? 0.3 : 0;
      const ground = r.isPlayer || camD < 90;

      // Drift charge stays in the boost/flame presentation; dirt stays earth toned.
      const D = v._drift;
      this.fx.boost(r, D, camD);

      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        const lg = r.lastGround[i];
        r.clunkT[i] = Math.max(0, r.clunkT[i] - dt);
        r.bottomT[i] = Math.max(0, r.bottomT[i] - dt);

        if (!w.contact) { lg.x = w.worldPos.x; lg.z = w.worldPos.z; lg.has = true; continue; }
        const S = SURFACES[w.surface] || SURFACES[SURF.DIRT];

        /* Suspension noise is the player's car only. A strut stop taking a hit
           is a discrete event, panned to the side the wheel is on. */
        if (r.isPlayer) {
          if (w.compVel > CLUNK_VEL && r.clunkT[i] <= 0) {
            this.audio.clunk((w.compVel - CLUNK_VEL) * 0.30, w.side * 0.45);
            r.clunkT[i] = 0.22;
          }
          const over = w.comp - v.spec.suspTravel;
          if (over > 0.015 && r.bottomT[i] <= 0) {
            this.audio.bottomOut(clamp(over * 5, 0.3, 1.5), w.side * 0.45);
            r.bottomT[i] = 0.30;
          }
        }

        const gx = w.worldPos.x, gz = w.worldPos.z;
        if (!lg.has) { lg.x = gx; lg.z = gz; lg.has = true; continue; }
        const dx = gx - lg.x, dz = gz - lg.z;
        const moved = Math.hypot(dx, dz);

        if (moved > 0.10) {
          if (ground) {
            /* One pass must already read as a tyre mark; a locked wheel or a
               sideways one lays it down black. `skid` keeps sand pale. */
            const strength = clamp(
              0.34 + w.load / (v.cornerLoad * 3.2) + w.slipLong * 0.34 + w.slipLat * 0.26
              + v._ctlBrake * 0.10, 0, 0.95) * (0.5 + S.skid * 0.5);
            this.terrain.addTrack(lg.x, lg.z, gx, gz, v.spec.wheelW * 1.3, strength);

            // Rut depth IS the surface's sink: ROAD leaves nothing, MUD a trench.
            if (S.sink > 0.05) {
              const depth = Math.min(0.13, (0.028 + w.slipLong * 0.045) * S.sink * 1.7);
              const steps = Math.min(r.isPlayer ? 5 : 2, Math.ceil(moved / 0.14));
              for (let k = 1; k <= steps; k++) {
                const f = k / steps;
                this.terrain.rut(lg.x + dx * f, lg.z + dz * f, 0.30, depth, 0);
              }
            }
          }
          lg.x = gx; lg.z = gz;
        }

        /* Wheelspin in soft ground digs a hole you can drop into — the reason
           flooring it out of a mud hairpin is the wrong answer. */
        if (ground && S.sink > 0.30 && w.slipLong > 0.35 && Math.abs(v.speed) < 2) {
          // Slow enough that a few seconds of panic throttle costs you a rut,
          // not the race — first light buried cars axle-deep at the old rate.
          this.terrain.rut(gx, gz, 0.30, 0.05, (w.slipLong - 0.30) * dt * 0.22);
        }

        /* Rooster tail. Rate is contact-patch speed plus slip, scaled by how
           dusty the surface is; colour comes straight from the surface table. */
        if (emit > 0) {
          const patch = Math.abs(w.spinVel) * v.spec.wheelR;
          const slip = w.slipLong + w.slipLat * 0.7;
          const rate = (patch * 0.085 + slip * 20) * S.dust * emit * dt;
          if(ground && patch>3 && Math.random()<Math.min(.3,patch*.025*S.dust*emit*dt)) {
            const c=this.dust.groundColorAt(gx,gz,S.dustCol);
            this.dust.spawn(1,gx,w.worldPos.y-v.spec.wheelR,gz,.8+Math.min(patch,30)*.025,.15,-v.vel.x,-v.vel.z,c[0],c[1],c[2],DUST_KIND.CLOD);
          }
          let n = rate | 0;
          if (Math.random() < rate - n) n++;
          if (n > 0) {
            const sx = v.vel.x, sz = v.vel.z;
            const m = Math.hypot(sx, sz) || 1;
            const c = this.dust.groundColorAt(gx,gz,S.dustCol);
            const k = 1;
            this.dust.spawn(n > 3 ? 3 : n, gx, w.worldPos.y - v.spec.wheelR * 0.55, gz,
              0.26 + patch * 0.011 + slip * 0.55, 0.22, -sx / m, -sz / m,
              c[0] * k, c[1] * k, c[2] * k,
              S.sink > 0.6 ? DUST_KIND.CLOD : DUST_KIND.PUFF);
          }
        }
      }

      /* Landings and lip departures, off the airborne edge. airTime is already
         zero on the frame you touch down, so the peak is carried forward. */
      const air = v.airborne;
      if (air && !r.wasAir) this.fx.lip(r, v);
      if (!air && r.wasAir) this.fx.touchdown(r, v, camD, emit);
      r.airPeak = air ? v.airTime : 0;
      r.wasAir = air;
    }

    /* Lava is not damage — it is 0.55 grip and a lot of drag, which is
       punishment enough. The banner and the hiss exist so the player knows
       WHY the car has gone vague. */
    this.fx.lava(dt, this.player.vehicle);
  }

  /* ---------------- 8: reset and recovery ---------------- */
  _resetSystem(dt, raw) {
    void raw;
    const T = TUNE.reset;

    for (const r of this.racers) {
      const v = r.vehicle;
      if (r.finished || this.state === RS.RESULTS) continue;
      if(v.wrecked){
        if(tickWreck(v,dt))this._respawn(r,'BACK IN THE RACE','rocket');
        continue;
      }

      if (r.isPlayer) {
        /* HOLD, not a tap: the contract has T7 mapping pad B and the touch
           RESET button onto KeyR, so one test covers all three. */
        const held = this.input.down('KeyR') || !!this.input.resetHeld;
        if (held && this.state !== RS.GRID && this.state !== RS.COUNTDOWN) {
          this.resetHold = Math.min(1, this.resetHold + dt / Math.max(0.05, T.holdTime));
          if (this.resetHold >= 1) { this._respawn(r, 'MANUAL RESET', 'manual'); this.resetHold = 0; }
        } else if (this.resetHold > 0) {
          this.resetHold = Math.max(0, this.resetHold - dt * 3);
        }
      }

      if (this.state !== RS.RUNNING && this.state !== RS.FINISHED) continue;

      /* Automatic recovery. Each condition carries its own dwell so a barrel
         roll that lands on its wheels, or a moment of wheelspin, is not a
         reason to teleport anyone. */
      r.flipT = v.flipped ? r.flipT + dt : 0;

      const stuck = Math.abs(v.speed) < T.stuckSpeed &&
        (r.isPlayer ? Math.abs(this._pctl.throttle) > 0.5 : true) && !v.airborne;
      r.stuckT = stuck ? r.stuckT + dt : 0;

      /* Scorched: wallowing in lava. The gap-jump voids are floored with it,
         their walls are too steep to climb at lava grip, and a car crawling
         at 1–4 km/h dodges the strict stuck gate forever — QA proved a racer
         can marinate down there for half a minute. Crossing at speed stays
         legal; loitering does not. */
      const inLava = v.surfaceId === SURF.LAVA && !v.airborne &&
        Math.hypot(v.vel.x, v.vel.z) < 7;
      r.lavaT = inLava ? (r.lavaT || 0) + dt : 0;
      if (r.lavaT > 1.2) { this._respawn(r, 'SCORCHED — RECOVERED', 'lava'); r.lavaT = 0; continue; }

      /* Wedged: nose-planted in a crevice or leaned hard on a wall. Not
         flipped (up.y can sit near 0.5), not stuck (the wheels still turn it
         a little), but going nowhere at a silly attitude. QA found a car
         standing vertically on its bumper for half a minute. */
      const wedged = v.up.y < 0.55 && Math.abs(v.speed) < 1.5 && !v.airborne;
      r.wedgeT = wedged ? (r.wedgeT || 0) + dt : 0;
      if (r.wedgeT > 3) { this._respawn(r, 'RECOVERED', 'wedged'); r.wedgeT = 0; continue; }

      /* Off course is measured against the MAIN spline and, where the track
         has one, the shortcut — a legal detour is 40 m off the centreline and
         must not be dragged back onto it. */
      let d = this.spline.nearest(v.pos.x, v.pos.z, _near).d;
      /* Only the routes whose span we are actually in — with 60 m of slack
         either end for the merge — so a route on the far side of the map
         cannot excuse being lost here. */
      const L = this.spline.length;
      for (let k = 0; k < this.routes.length; k++) {
        const rt = this.routes[k];
        if (!rt.spline || !spanHas(rt.s0 - 60, rt.s1 + 60, _near.s, L)) continue;
        const rd = rt.spline.nearest(v.pos.x, v.pos.z, _near2).d;
        if (rd < d) d = rd;
      }
      /* Air never counts as lost: a set-piece jump may legally clear the
         corridor at apex, and being yanked out of the sky mid-flight is the
         worst reset the game can do. The clock resumes on touchdown. */
      r.offT = d > T.offCourseDist ? r.offT + (v.airborne ? 0 : dt) : 0;
      if (r.isPlayer) this._offCourse = d > T.offCourseDist ? d : 0;

      /* No-progress watchdog — the net under every gate above. QA found a car
         beached on a canyon-wall slope at up.y 0.71, sliding backwards through
         the stuck gate's speed window, 18 m off-centre: under every threshold,
         stranded forever. Race-line progress is the one signal a beached car
         cannot fake. Airborne time never counts against it (set-piece flights
         are progress by definition).

         Read `liveS`, NOT `raceS`. raceS is ratcheted per segment so the
         standings stay stable across a spin or a reset, which means a car
         respawned to the gate behind it reports a FROZEN raceS for the whole
         drive back to where it crashed. QA found the deadlock that makes:
         canyon/ridgeback fell off the ridge 2 m short of gate 2, respawned
         146 m back, and could not cover that in the 6 s window because the
         only signal being measured was pinned — so it reset, and reset, 112
         times, and DNF'd. liveS is the same estimate un-ratcheted. */
      /* …but liveS is only meaningful while the car is on the gate sequence
         the tracker expects. Cross the line without completing that set and
         the projection starts running BACKWARDS as the car drives forward.
         So the net gets a floor no bookkeeping can argue with: a car doing
         real speed down the middle of the road is racing. `d` is the
         off-course distance measured just above. */
      const progS = this.tracker.progress(r.id).liveS;
      const clearlyRacing = Math.abs(v.speed) > (T.noProgressSpeed ?? 10) &&
        d < T.offCourseDist && !v.airborne;
      if (r.bestS == null || progS > r.bestS + (T.noProgressDist ?? 4)) {
        r.bestS = progS; r.noProgT = 0;
      } else if (clearlyRacing) {
        // Clear it, do not merely skip it: a car that recovers must not be
        // left holding a primed timer for the next slow corner.
        r.noProgT = 0;
      } else if (!v.airborne) {
        r.noProgT = (r.noProgT || 0) + dt;
        if (r.noProgT > (T.noProgressTime ?? 6)) { this._respawn(r, 'RECOVERED', 'noprog'); continue; }
      }

      if (r.flipT > T.flipTime) { this._respawn(r, 'RECOVERED', 'flip'); continue; }
      if (r.stuckT > T.stuckTime) { this._respawn(r, 'RECOVERED', 'stuck'); continue; }
      if (r.offT > OFF_COURSE_TIME) { this._respawn(r, 'BACK ON COURSE', 'off'); continue; }
      if (r.ai && r.ai.wantsReset) this._respawn(r, null, 'ai');
    }
  }

  /** Back on the road at the last gate the racer actually cleared.
      `why` is telemetry only (dev/qa-drive.js tallies it per racer): the
      banner tells the player what happened, `why` tells us WHICH net caught
      them, which is the difference between "this stage is hard" and "this
      stage has a hole in it". */
  _respawn(r, banner, why) {
    const v = r.vehicle;
    r.resetWhy = why || null;
    const slot = this.tracker.lastSlotOf(r.id);
    let target=slot.s+3;
    if(why==='rocket'&&Number.isFinite(v.wreckS)){
      const attacker=this.racers.find(other=>other.id===v.wreckAttacker&&other!==r&&!other.vehicle.wrecked);
      target=rocketRecoveryTarget(v.wreckS,this.tracker.progress(r.id),
        attacker?this.tracker.progress(attacker.id):null,
        attacker?this.spline.nearest(attacker.vehicle.pos.x,attacker.vehicle.pos.z,{}).s:NaN,this.spline.length);
    }
    const s=safeRecoveryS({target,tracker:this.tracker,id:r.id,spline:this.spline,
      jumps:this.trackData.jumps,terrain:this.terrain,colliders:this.props?.colliders});
    // Retain the wreck instead of placing it at a point that failed clearance.
    if(s===null)return;
    this.spline.posAt(s, _sp);
    this.spline.dirAt(s, _sd);
    const yaw = Math.atan2(_sd.x, _sd.z);

    v.placeAt(_sp.x, _sp.z, yaw);
    v.ghost = true;
    r.ghostT = TUNE.reset.ghostTime;
    r.flipT = 0; r.stuckT = 0; r.offT = 0;
    /* The respawn teleports BACKWARD along the race line, so the watchdog
       baseline must re-arm from here or it fires again on arrival. */
    r.bestS = null; r.noProgT = 0;
    r.wasAir = false; r.airPeak = 0;
    // AFTER placeAt: the Arsenal re-publishes the rack the same frame (8.1).
    this.arsenal.notifyReset(r.id);
    for (let w = 0; w < 4; w++) r.lastGround[w].has = false;
    this.tracker.notifyTeleport(r.id, _sp.x, _sp.z);

    if (r.ai && r.ai.notifyReset) r.ai.notifyReset();

    if (r.isPlayer) {
      this.rig.snapBehind(v);
      if (this.feel) this.feel.reset();
      this.audio.resetWhoosh();
      this._offCourse = 0; this._wrongWay = false;
      if (banner) this.hud.banner(banner, 'warn', 1.6);
    }
    this.fx.respawn(v, yaw);
  }

  /* ---------------- 11: audio mix ---------------- */
  _mixAudio(dt) {
    const v = this.player.vehicle;
    const a = this._as;
    a.gear = v.ghost ? null : v.gear;
    a.engineOff = !!v.wrecked; a.rpm = v.wrecked ? 0 : v.rpmNorm; a.load = v.wrecked ? 0 : v.motorLoad; a.speed = v.speed;
    a.slipLat = v.slipLat; a.slipLong = v.slipLong;
    a.surface = v.surfaceId; a.airborne = v.airborne; a.contacts = v.contacts;

    /* Rival voice: the nearest car inside 40 m, panned by bearing. It is
       deliberately sticky — a rival that flickers between two cars in a pack
       sounds like a fault, so the choice cannot move more than once a second. */
    this._rivalT += dt;
    if (this._rivalT >= RIVAL_SWAP) {
      this._rivalT = 0;
      let best = -1, bd = RIVAL_RANGE * RIVAL_RANGE;
      for (const r of this.racers) {
        if (r.isPlayer) continue;
        const d2 = r.vehicle.pos.distanceToSquared(v.pos);
        if (d2 < bd) { bd = d2; best = r.id; }
      }
      this._rivalId = best;
    }
    if (this._rivalId >= 0) {
      const rv = this.racers[this._rivalId].vehicle;
      const d = rv.pos.distanceTo(v.pos);
      if (d > RIVAL_RANGE * 1.4) { this._rivalId = -1; a.rivalRpm = null; }
      else {
        a.rivalRpm = rv.rpmNorm; a.rivalId=rv.spec.id; a.rivalDistance=d;
        a.rivalPan = clamp(_v1.subVectors(rv.pos, v.pos).dot(v.right) / 18, -1, 1);
      }
    } else a.rivalRpm = null;

    this.audio.update(dt, a);

    /* Intensity policy, verbatim from the integration notes. No pre-smoothing:
       audio.musicTick runs its own filter and doubling it makes the score lag
       the race by a corner and a half. */
    const p = this.tracker.progress(this.player.id);
    const lapFrac = this.laps > 1 ? p.lap / (this.laps - 1) : 1;
    let inten = 0.30 + 0.22 * lapFrac;
    if (p.lap >= this.laps - 1) inten = Math.max(inten, 0.70);
    if (this._rivalId >= 0 && this.racers[this._rivalId].vehicle.pos.distanceTo(v.pos) < 12) inten += 0.20;
    if (this._playerPos === 1) inten += 0.05;
    this.audio.musicTick(this.elapsed, clamp(inten, 0, 1));
  }

  /* ---------------- 12: HUD ---------------- */
  _feedHud(dt) {
    const v = this.player.vehicle;
    const p = this.tracker.progress(this.player.id);
    const hr = this._hudRace;
    hr.state = RS_NAME[this.state];
    hr.countdown = this.state === RS.COUNTDOWN ? this.countdownN : -1;
    hr.position = this._playerPos;
    hr.total = FIELD;
    hr.lap = Math.min(this.laps, p.lap + 1);
    hr.laps = this.laps;
    hr.raceTime = this.raceTime;
    hr.lastLap = p.lastLap;
    hr.bestLap = p.bestLap;
    hr.wrongWay = this._wrongWay;
    hr.resetHold = this.resetHold;
    hr.offCourse = this._offCourse;

    const slot = this.tracker.nextSlotOf(this.player.id);
    if (slot) {
      this._hudNextCp.x = slot.x; this._hudNextCp.z = slot.z;
      this._hudNextCp.idx = slot.idx; this._hudNextCp.dist = p.distNext;
    }

    /* The final lap, as a level — hud.js takes the edge off it itself. */
    hr.finalLap = hr.lap >= this.laps && this.state === RS.RUNNING;

    const ha = this.arsenal.hudFor(PLAYER_SLOT, this._hudArsenal);
    /* The touch FIRE button carries the "loaded" signal itself — a keycap
       means nothing to a thumb. input.js only touches the DOM on a change. */
    if (this.input.armFire) this.input.armFire(ha.enabled && ha.ammo > 0);
    this._feedEvents();
    this._firstRunTips();
    const hv = this._hudVeh;
    hv.speedKmh = v.speedKmh; hv.gear = v.gear; hv.rpmNorm = v.rpmNorm;
    hv.airborne = v.airborne; hv.airTime = v.airTime;
    v.hudDrift(hv);
    v.hudTrick(this._hudTrick);

    for (let i = 0; i < this.racers.length; i++) {
      const d = this._hudDots[i], rv = this.racers[i].vehicle;
      d.x = rv.pos.x; d.z = rv.pos.z;
    }

    /* The rival worth showing is the one you are actually racing: the car in
       front, or the car behind once you are leading. Gap is a time, from the
       distance between you divided by how fast you are covering ground. */
    let target = null;
    if (this.state === RS.RUNNING || this.state === RS.FINISHED) {
      const order = this.tracker.standings();
      const me = this._playerPos - 1;
      if (me > 0) target = this.racers[order[me - 1]];
      else if (order.length > 1) target = this.racers[order[1]];
    }

    if (target) {
      const tp = this.tracker.progress(target.id);
      const ref = Math.max(Math.abs(v.speed), 8);
      this._hudRival.name = target.name;
      this._hudRival.gap = (tp.raceS - p.raceS) / ref;
      this._hudPayload.rival = this._hudRival;
    } else this._hudPayload.rival = null;

    this.hud.update(dt, this._hudPayload);
  }

  /* ============================================================
     RESULTS
     ============================================================ */
  _showResults() {
    if (this._resultsShown) return;
    this._resultsShown = true;
    this.state = RS.RESULTS; this.stateT = 0;

    const table = this.tracker.results();
    const placements = [];
    const L = this.trackData.spline.length, finishS = this.laps * L;
    let playerPos = FIELD, playerTotal = null, playerBest = null;
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      const r = this.racers[row.id];
      /* The classification freezes the moment the player's podium settles, so
         a rival mid-final-lap has no total. "DNF" is a lie about a car that is
         still audibly racing behind you — project its finish from its own
         average pace instead.

         The DNF test is a fraction of the WHOLE race, not one lap. "Has not
         cleared lap one" is the right idea on a three-lap stage and complete
         nonsense on PROVING GROUNDS, where the race IS one lap: every rival
         who crossed the line two and a half seconds behind the player was
         being posted as a retirement, and on the tutorial that was half the
         field, every time. 0.35 of the race distance is about a lap on the
         long stages — the same bar as before — and a third of one here. */
      let total = row.total, dnf = false;
      if (!row.finished) {
        const prog = this.tracker.progress(row.id);
        if (prog.raceS < finishS * DNF_FRAC) { dnf = true; }
        else {
          const pace = prog.raceS / Math.max(1, this.raceTime);   // m/s of race made good
          total = this.raceTime + (finishS - prog.raceS) / Math.max(6, pace);
        }
      }
      placements.push({
        name: r.name, isPlayer: r.isPlayer, color: r.color,
        total, bestLap: row.bestLap, dnf, est: !row.finished && !dnf
      });
      if (r.isPlayer) { playerPos = i + 1; playerTotal = row.total; playerBest = row.bestLap; }
    }

    const res = applyResult(this.profile, this.trackDef.id, playerPos,
      playerTotal == null ? Infinity : playerTotal, playerBest, this.weaponsFlag);
    this.profile = res.profile;
    Save.writeProfile(this.profile);
    this.onProfile(this.profile);

    this.audio.setDriving(false);
    this.audio.setMusicMode('menu');
    this.audio.finishFanfare(playerPos === 1);
    if (res.unlocks.length) setTimeout(() => { if (!this._disposed) this.audio.unlockJingle(); }, 1400);

    this.input.unlock();
    this.input.showTouch(false);
    this.hud.hideRace();
    /* Stash the driving mode on the rig (it survives this Race instance) so
       the next _enterGrid — next track, restart, or a race after the menu —
       can put the player back in the camera they actually raced with. */
    if (this.rig.setMode) {
      this.rig.raceMode = this.rig.mode;
      this.rig.setMode(CAM.ORBIT, this.player.vehicle);
    }

    const next = TRACK_ORDER[TRACK_ORDER.indexOf(this.trackDef.id) + 1];

    this.ui.show('results', {
      placements, playerPos,
      medal: res.medal,
      unlocks: res.unlocks,
      newRecord: res.newRecord,
      trackId: this.trackDef.id,
      nextTrackId: next && this.profile.unlockedTracks.indexOf(next) >= 0 ? next : null
    });
  }

  /**
   * The three first-run tips that could never fire. `hud.tip`, the ids and the
   * profile whitelist have all existed since wave 5; nothing ever called them
   * for items, drift or pads, so the one place the HUD is allowed to EXPLAIN
   * rather than report has been silent. One card each, once per profile.
   */
  _firstRunTips() {
    if (!this.tips || !this.profile) return;
    const m = this.hud._method || 'kb';
    const fire = m === 'pad' ? 'X' : m === 'touch' ? 'the FIRE button' : 'F';
    const back = m === 'pad' ? 'LT' : m === 'touch' ? 'BRAKE' : '\u2193';
    let id = null, text = '';
    /* The rack is loaded from the grid, so the rockets tip has no pickup to
       wait for: a couple of seconds into the first green flag is the moment
       a player has a hand free to read it. The tip id keeps its old name —
       `profile.tips` is a strict whitelist (6.10). */
    if (this._hudArsenal.enabled && this.state === RS.RUNNING && this.raceTime > 2.5 &&
      shouldTip(this.profile, 'items')) {
      id = 'items';
      text = `ROCKETS: ${fire} fires, hold ${back} to fire behind.`;
    } else if (this._hudVeh.driftTier > 0 && shouldTip(this.profile, 'drift')) {
      id = 'drift';
      text = 'Mini-turbo charged. Let the handbrake go and the boost fires ' +
        'itself — the longer you dared hold the slide, the bigger it is.';
    } else if (this._hudEvents.padSeq !== this._tipPadSeq && shouldTip(this.profile, 'pad')) {
      id = 'pad';
      text = 'Boost pad. They are free speed and they always work — ' +
        'line one up on the exit of a corner, not the entry.';
    }
    this._tipPadSeq = this._hudEvents.padSeq;
    if (!id) return;
    this.hud.tip(id, text);
    this.profile = markTip(this.profile, id);
    this.onProfile(this.profile);
  }

  /**
   * The Arsenal's event block -> the HUD's race log. Sequence numbers in,
   * names out. The translation is here rather than in hud.js because names
   * of racers are race.js's business and the Arsenal only knows slot
   * indices. No closures: this runs every frame.
   */
  _feedEvents() {
    const ev = this.arsenal.events, he = this._hudEvents;

    /* One `hitSeq` covers everybody, so read the target to decide whether this
       one happened TO the player or was dealt BY them — both are worth saying
       and only one of them was ever going to be visible. */
    if ((ev.hitSeq | 0) !== this._lastHitSeq) {
      this._lastHitSeq = ev.hitSeq | 0;
      if (ev.hitTarget === PLAYER_SLOT) {
        he.hitSeq++;
        he.hitBy = this._nameOf(ev.hitOwner);
        he.hitWith = WEAPON_NAME;
      } else if (ev.hitOwner === PLAYER_SLOT) {
        he.dealtSeq++;
        he.dealtTo = this._nameOf(ev.hitTarget);
        he.dealtWith = WEAPON_NAME;
      }
    }
    if (ev.padSeq !== this._lastPadSeq) {
      this._lastPadSeq = ev.padSeq;
      if (ev.padRacer === PLAYER_SLOT) he.padSeq++;
    }
    /* A rival firing near you is the whole answer to "the AI never shoots"
       — it shoots constantly, and the log is where that becomes legible. */
    if ((ev.fireSeq | 0) !== this._lastFireSeq) {
      this._lastFireSeq = ev.fireSeq | 0;
      if (ev.fireRacer >= 0 && ev.fireRacer !== PLAYER_SLOT && ev.fireNear) {
        he.rivalFireSeq++;
        he.rivalFireBy = this._nameOf(ev.fireRacer);
        he.rivalFireWith = WEAPON_NAME;
      }
    }
    if ((ev.noteSeq | 0) !== this._lastNoteSeq) {
      this._lastNoteSeq = ev.noteSeq | 0;
      he.noteSeq++;
      he.noteText = ev.noteText || '';
    }
    /* The player's own pickups. A crate shows on the ammo counter; the can
       is the one that needs SAYING, because its whole effect is over in a
       second and a half and nothing else on screen names it. (The arsenal
       payload carries `pickupSeq`/`pickupText` for the HUD as well — if
       hud.js grows its own callout, this banner is the one to drop.) */
    if ((ev.pickSeq | 0) !== this._lastPickSeq) {
      this._lastPickSeq = ev.pickSeq | 0;
      if (ev.pickRacer === PLAYER_SLOT && ev.pickItem === PICKUP.NITRO) {
        this.hud.banner('NITRO', 'good', 1.1);
      }
    }
  }

  _nameOf(i) { return (i >= 0 && this.racers[i]) ? this.racers[i].name : ''; }

  /* ============================================================
     TEARDOWN — Race owns the world it was handed
     ============================================================ */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this.arsenal.dispose();
    for (const r of this.racers) r.vehicle.dispose();
    this.racers.length = 0;

    this.props.dispose();
    this.sky.dispose();
    this.dust.clear();
    this.dust.dispose();
    /* Race owns the world it was handed, and the pool is part of it — it was
       the one member of App.world that leaked on every quit. */
    if (this.vfx) { this.vfx.dispose(); this.vfx = null; }
    // terrain.dispose() frees its GPU objects but does not detach the clipmap.
    if (this.terrain.group && this.terrain.group.parent) {
      this.terrain.group.parent.remove(this.terrain.group);
    }
    this.terrain.dispose();

    this.hud.hideRace();
    this.audio.setDriving(false);
    this.terrain = this.sky = this.props = this.dust = null;
    this.player = null;
  }
}

export default Race;

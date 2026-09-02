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
import { Vehicle, resolveVehiclePair } from './vehicle.js';
import { VEHICLES } from './vehicles.js';
import { TUNE } from './config.js';
import { SURF, SURFACES } from '../world/surfaces.js';
import { DUST_KIND } from '../world/dust.js';
import { RaceTracker, formatTime } from './racecore.js';
import { AIDriver, makeGridProfiles } from './ai.js';
import { ItemWorld } from './itemworld.js';
import { CAM } from './camera.js';
import { applyResult, TRACK_ORDER } from './progression.js';
import { Save } from '../core/save.js';
import { makeRNG, clamp } from '../core/rng.js';

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
const LAVA_WARN_GAP = 3.5;          // s between lava banners
const TOUCHDOWN_AIR = 0.25;         // s of air before a landing is an event
const AIRTIME_BRAG = 1.3;           // s of air worth a HUD flourish. Hang-time
                                    //   gravity makes 1 s airs routine; the brag
                                    //   has to stay something you earn.
const CLUNK_VEL = 1.9;              // m/s of compression velocity that thumps
const IMPACT_MIN = 2.0;             // m/s of closing speed worth hearing
const BOOST = TUNE.boost;           // read every frame in _wheelEffects
const BOOST_HEAR = 70;              // m — a rival's boost you can still hear

const AI_NAMES = ['MARA', 'JUKKA', 'REY', 'OTTO', 'SANNE'];
/* Minimap dots have to be told apart at four pixels across, which the three
   car colours cannot do on their own. The player keeps their car's colour. */
const RIVAL_COLORS = [0x36a8ff, 0x7ee06a, 0xffd23f, 0xc46bff, 0xff5f56];

/* ---------------- module scratch ---------------- */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
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
    this.trackDef = o.trackDef;
    this.trackData = o.trackData || o.terrain.trackData;
    this.spline = this.trackData.spline;
    this.shortcut = this.trackData.shortcutSpline || null;
    this.playerSpec = o.vehicleSpec || VEHICLES[0];
    this.difficulty = clamp(o.difficulty == null ? 0.5 : o.difficulty, 0, 1);
    this.profile = o.profile || null;
    this.onExit = o.onExit || (() => { });
    this.onProfile = o.onProfile || (() => { });
    this.onSetting = o.onSetting || (() => { });

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
    this._lavaT = 0;
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
      checkpoints: this.trackData.checkpoints
    });

    /* ---- power-ups ----
       Built after the tracker because the drop roulette reads race position,
       and handed the SEEDED race stream so a sweep in dev/qa-drive.js stays
       reproducible between builds. `items` false is the purist toggle: the
       system still exists, it is simply inert and invisible. */
    this.items = new ItemWorld({
      scene: this.engine.scene, terrain: this.terrain, trackData: this.trackData,
      dust: this.dust, audio: this.audio, feel: this.feel, engine: this.engine,
      racers: this.racers, tracker: this.tracker, rng: this.rng,
      enabled: o.items !== false,
    });
    /* Set at the green flag and never cleared mid-race: a record set with
       items on is FLAGGED as such, and toggling them off on the last lap must
       not launder it. */
    this.itemsFlag = false;

    /* ---- reusable per-frame payloads ---- */
    this._pctl = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };
    this._aictx = { vehicles: this.racers.map(r => r.vehicle), tracker: this.tracker, myId: 0, state: 'countdown' };
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
      nextCp: this._hudNextCp
    };
    this._hudVeh = { speedKmh: 0, gear: 0, rpmNorm: 0, airborne: false, airTime: 0 };
    this._hudDots = this.racers.map(r => ({ x: 0, z: 0, color: r.color, isPlayer: r.isPlayer }));
    this._hudRival = { name: '', gap: 0 };
    this._hudItem = { enabled: true, id: -1, name: '', col: 0, charges: 0, rolling: false };
    this._hudPayload = {
      race: this._hudRace, vehicle: this._hudVeh, dots: this._hudDots,
      rival: null, item: this._hudItem,
    };

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

      const r = {
        id: i,
        isPlayer,
        name: isPlayer ? 'YOU' : AI_NAMES[i % AI_NAMES.length],
        color: isPlayer ? spec.color : RIVAL_COLORS[i % RIVAL_COLORS.length],
        spec, vehicle: v, ai: null,
        slot: i,
        wasAir: false, airPeak: 0,
        ghostT: 0, flipT: 0, stuckT: 0, offT: 0,
        bestS: null, noProgT: 0,
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
      if (isPlayer) this.player = r;
    }
  }

  /** Put the field on the grid. Called at construction and by restart(). */
  _enterGrid(first) {
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
    this.items.resetAll();
    this.itemsFlag = false;
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
       before the first beep, so the countdown lands into a live mix. */
    this.audio.setEngineCharacter(this.playerSpec);
    this.audio.setDriving(true);
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

  /** The ITEMS setting, applied live — a pause-screen toggle takes effect now. */
  setItemsEnabled(on) {
    this.items.setEnabled(on);
    if (on) this.itemsFlag = this.itemsFlag || this.state >= RS.RUNNING;
  }

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
    this.items.resetAll();
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
      /* Items step BEFORE the cars, so a hit landed this frame is felt this
         frame rather than next. See the header note in itemworld.js. */
      if (live && this.items.hasItem(PLAYER_SLOT) && this.input.hit('KeyF')) {
        this.items.fire(PLAYER_SLOT, (raw.throttle || 0) < -0.25);
      }
      this.items.step(dt, live);
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
    this.items.updateVisuals(dt, this.engine.camera);

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
            this.itemsFlag = this.itemsFlag || this.items.enabled;
            this.raceTime = 0;
          }
        }
        if (this.stateT >= COUNT_TIME && this.state === RS.COUNTDOWN) {
          this.state = RS.RUNNING; this.stateT = 0; this.raceTime = 0;
          this.itemsFlag = this.itemsFlag || this.items.enabled;
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
          c.throttle = 0; c.steer = 0; c.brake = 1; c.handbrake = 1;
        } else {
          c.throttle = raw.throttle || 0;
          c.steer = raw.steer || 0;
          c.brake = raw.brake || 0;
          c.handbrake = raw.handbrake ? 1 : 0;
        }
        ctl = c;
      } else {
        // A finished AI is told to cruise by its own state machine; before the
        // lights it holds the brake. Either way it only ever returns a ctl.
        this._aictx.myId = r.id;
        this._aictx.position = r.pos;
        this._aictx.item = this.items.itemOf(r.id);
        ctl = r.ai.update(dt, this._aictx);
        if (r.ai.wantsFire) {
          this.items.fire(r.id, !!r.ai.fireBack);
          if (r.ai.notifyFired) r.ai.notifyFired();
        }
      }
      /* A rocket sled drives itself. Overwriting the ctl in place is exactly
         what the countdown lock above does, so there is no new mechanism
         here and no new field on ctl. */
      if (!locked) this.items.pilot(r.id, ctl);
      v.step(dt, ctl);

      if (r.ghostT > 0) {
        r.ghostT -= dt;
        if (r.ghostT <= 0) r.ghostT = 0;
      }
      /* ONE writer. The respawn ghost and the sled's pass-through ghost are
         two independent reasons to be intangible; composing them here is what
         stops the recovery system's countdown quietly cancelling a sled. */
      v.ghost = r.ghostT > 0 || this.items.isGhost(r.id);
    }

    /* All fifteen pairs, exactly once. hardHit is read AFTER this. */
    for (let i = 0; i < FIELD - 1; i++) {
      for (let j = i + 1; j < FIELD; j++) {
        const impact = resolveVehiclePair(this.racers[i].vehicle, this.racers[j].vehicle);
        if (impact > IMPACT_MIN) this._contact(this.racers[i], this.racers[j], impact);
      }
    }

    for (const r of this.racers) {
      /* props.resolve() does not check `ghost` — it pushes anything out of a
         rock. A sled that bounced off the first boulder it met would be a
         comeback item that ends in a ditch, so it is the one exception. */
      if (this.items.isSledding(r.id)) continue;
      const impact = this.props.resolve(r.vehicle);
      if (impact > IMPACT_MIN) this._contact(r, null, impact);
    }
  }

  /** Collision heard and felt. Rivals only ring the bell if you are near them. */
  _contact(a, b, impact) {
    const p = this.player.vehicle;
    const near = a.isPlayer || (b && b.isPlayer);
    let gain = 1, pan = 0;
    if (!near) {
      const src = a.vehicle.pos;
      const d = src.distanceTo(p.pos);
      if (d > 55) return;
      gain = clamp(1 - d / 55, 0.15, 1);
      pan = clamp(_v1.subVectors(src, p.pos).dot(p.right) / 22, -1, 1);
    }
    this.audio.crash(clamp(impact * 0.16, 0.2, 2.2) * gain, pan);
    if (near && this.feel) {
      // Direction of the shove, so the shake leans the way the hit came from.
      const other = b ? (a.isPlayer ? b.vehicle : a.vehicle) : null;
      if (other) _v2.subVectors(p.pos, other.pos).setY(0).normalize();
      else _v2.copy(p.vel).setY(0).normalize().negate();
      this.feel.collision(impact, _v2);
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
    /* Seconds adrift of the leader, by pace. items.js uses it to roll a badly
       beaten racer one row further back than their POSITION says — without
       it, a table keyed only on position quietly stops helping the moment the
       field spreads out, which is exactly when it should be helping most. */
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

  /**
   * The one-shot half of the mini-turbo: the chime on a tier, and the shove
   * on release. Split out of the wheel loop because it is per CAR, not per
   * wheel, and because `tierUp`/`fired` are single-frame flags that must be
   * consumed exactly once.
   *
   * Rivals are distance-gated the same way _contact() gates a crash: a boost
   * seventy metres up the road is a sound you should hear, faintly, because
   * it tells you somebody just got a run on you. Beyond that it is noise.
   */
  _boostCues(r, D, camD) {
    if (D.tierUp) {
      if (r.isPlayer) {
        this.audio.boostTier(D.tier);
        if (this.feel) this.feel.kick(BOOST.tierFov);
      }
    }
    if (!D.fired) return;
    const t = D.fired;
    if (r.isPlayer) {
      this.audio.boostFire(t, 1);
      if (this.feel) {
        this.feel.kick(BOOST.fireFov[t - 1]);
        this.feel.addShake(BOOST.fireShake[t - 1]);
      }
    } else if (camD < BOOST_HEAR) {
      this.audio.boostFire(t, clamp(1 - camD / BOOST_HEAR, 0.12, 0.5));
    }
    /* The flame. EMBER is already a glowing, buoyant, cooling particle whose
       shader multiplies by a fixed warm tint and clears the bloom threshold —
       so an ember IS a flame with no new particle kind, no fourth entry in
       dust.js's K_GY/K_BUOY tables and no shader branch. It cannot be tinted
       cool, which is why the TIER is read from the charge dust and the FLAME
       is the same every time. */
    const v = r.vehicle;
    if (camD < 120) {
      const f = v.forward;
      this.dust.spawn(3 + t, v.pos.x - f.x * 1.6, v.pos.y - 0.15, v.pos.z - f.z * 1.6,
        2.0 + t * 0.9, 0.30, -f.x, -f.z, 1.0, 0.55, 0.16, DUST_KIND.EMBER);
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

      /* ---- mini-turbo: the whole visible half of the feature ----
         The charge is READ OFF THE TYRE DUST rather than drawn as anything
         new: while a tier is building, the rooster tail is tinted by tier
         instead of by the surface. That costs zero extra particles, which
         matters because the pool is 500 at LOW and shared with six cars —
         an item VFX budget that starves the tyre dust would be a bad trade.
         The colours go in OVER-BRIGHT (× glow): dust.js writes cr/cg/cb
         straight into the colour attribute with no clamp, so a value past 1
         clears the bloom threshold and the sparks actually glow. */
      const D = v._drift;
      /* Tinted from the FIRST frame of a drift, not from the first banked
         tier. Waiting for tier 1 means the most important quarter-second in
         the mechanic — the one where you are deciding whether to commit —
         looks identical to not drifting at all. Pre-tier sparks use the
         tier-1 hue at roughly half the glow, so "it has started" and "you
         have banked something" are still different pictures. */
      const bcol = D.active ? BOOST.col[D.tier > 0 ? D.tier - 1 : 0] : null;
      const bglow = D.tier > 0 ? BOOST.glow : BOOST.glow * 0.5;
      this._boostCues(r, D, camD);

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
          let n = rate | 0;
          if (Math.random() < rate - n) n++;
          if (n > 0) {
            const sx = v.vel.x, sz = v.vel.z;
            const m = Math.hypot(sx, sz) || 1;
            const c = bcol || S.dustCol;
            const k = bcol ? bglow : 1;
            this.dust.spawn(n > 3 ? 3 : n, gx, w.worldPos.y - v.spec.wheelR * 0.55, gz,
              0.26 + patch * 0.011 + slip * 0.55, 0.22, -sx / m, -sz / m,
              c[0] * k, c[1] * k, c[2] * k,
              bcol ? DUST_KIND.PUFF : (S.sink > 0.6 ? DUST_KIND.CLOD : DUST_KIND.PUFF));
          }
        }
      }

      /* Landings and lip departures, off the airborne edge. airTime is already
         zero on the frame you touch down, so the peak is carried forward. */
      const air = v.airborne;
      if (air && !r.wasAir && v.vel.y > 4) {
        this.audio.jumpWhoosh(clamp(v.vel.y * 0.12, 0.25, 1.5) * (r.isPlayer ? 1 : 0.35));
        if (r.isPlayer && this.feel && this.feel.jump) this.feel.jump();
      }
      if (!air && r.wasAir && r.airPeak > TOUCHDOWN_AIR) {
        const hit = v.hardHit;
        if (r.isPlayer) {
          if (this.feel) this.feel.landing(hit);
          this.audio.land(clamp(hit * 0.22, 0.2, 2.2), v.surfaceId);
          if (r.airPeak > AIRTIME_BRAG) this.hud.airtime(r.airPeak);
        } else if (camD < 70) {
          this.audio.land(clamp(hit * 0.22, 0.2, 2.2) * clamp(1 - camD / 70, 0.1, 0.6), v.surfaceId);
        }
        const S = SURFACES[v.surfaceId] || SURFACES[SURF.DIRT];
        if (emit > 0) {
          this.dust.burst(v.pos.x, this.terrain.heightAt(v.pos.x, v.pos.z), v.pos.z,
            Math.atan2(v.vel.x, v.vel.z), clamp(hit * 0.16, 0.4, 2.0) * S.dust, S.dustCol);
        }
      }
      r.airPeak = air ? v.airTime : 0;
      r.wasAir = air;
    }

    /* Lava is not damage — it is 0.55 grip and a lot of drag, which is
       punishment enough. The banner and the hiss exist so the player knows
       WHY the car has gone vague. */
    const pv = this.player.vehicle;
    if (this.terrain.surfaceAt(pv.pos.x, pv.pos.z) === SURF.LAVA) {
      this.audio.scrape(SURF.LAVA, clamp(Math.abs(pv.speed) / 18, 0.2, 1));
      this._lavaT -= dt;
      if (this._lavaT <= 0) { this._lavaT = LAVA_WARN_GAP; this.hud.banner('LAVA CRUST — NO GRIP', 'bad', 1.8); }
    } else if (this._lavaT > 0) {
      this._lavaT = 0;
    }
  }

  /* ---------------- 8: reset and recovery ---------------- */
  _resetSystem(dt, raw) {
    void raw;
    const T = TUNE.reset;

    for (const r of this.racers) {
      const v = r.vehicle;
      if (r.finished || this.state === RS.RESULTS) continue;

      if (r.isPlayer) {
        /* HOLD, not a tap: the contract has T7 mapping pad B and the touch
           RESET button onto KeyR, so one test covers all three. */
        const held = this.input.down('KeyR') || !!this.input.resetHeld;
        if (held && this.state !== RS.GRID && this.state !== RS.COUNTDOWN) {
          this.resetHold = Math.min(1, this.resetHold + dt / Math.max(0.05, T.holdTime));
          if (this.resetHold >= 1) { this._respawn(r, 'MANUAL RESET'); this.resetHold = 0; }
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
      if (r.lavaT > 1.2) { this._respawn(r, 'SCORCHED — RECOVERED'); r.lavaT = 0; continue; }

      /* Wedged: nose-planted in a crevice or leaned hard on a wall. Not
         flipped (up.y can sit near 0.5), not stuck (the wheels still turn it
         a little), but going nowhere at a silly attitude. QA found a car
         standing vertically on its bumper for half a minute. */
      const wedged = v.up.y < 0.55 && Math.abs(v.speed) < 1.5 && !v.airborne;
      r.wedgeT = wedged ? (r.wedgeT || 0) + dt : 0;
      if (r.wedgeT > 3) { this._respawn(r, 'RECOVERED'); r.wedgeT = 0; continue; }

      /* Off course is measured against the MAIN spline and, where the track
         has one, the shortcut — a legal detour is 40 m off the centreline and
         must not be dragged back onto it. */
      let d = this.spline.nearest(v.pos.x, v.pos.z, _near).d;
      if (this.shortcut) d = Math.min(d, this.shortcut.nearest(v.pos.x, v.pos.z, _near2).d);
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
      const progS = this.tracker.progress(r.id).liveS;
      if (r.bestS == null || progS > r.bestS + (T.noProgressDist ?? 4)) {
        r.bestS = progS; r.noProgT = 0;
      } else if (!v.airborne) {
        r.noProgT = (r.noProgT || 0) + dt;
        if (r.noProgT > (T.noProgressTime ?? 6)) { this._respawn(r, 'RECOVERED'); continue; }
      }

      if (r.flipT > T.flipTime) { this._respawn(r, 'RECOVERED'); continue; }
      if (r.stuckT > T.stuckTime) { this._respawn(r, 'RECOVERED'); continue; }
      if (r.offT > OFF_COURSE_TIME) { this._respawn(r, 'BACK ON COURSE'); continue; }
      if (r.ai && r.ai.wantsReset) this._respawn(r, null);
    }
  }

  /** Back on the road at the last gate the racer actually cleared. */
  _respawn(r, banner) {
    const v = r.vehicle;
    const slot = this.tracker.lastSlotOf(r.id);
    // A few metres past the gate: dropping exactly on it spawns you in the
    // middle of a gantry and, on the line, facing a stationary grid.
    let s = slot.s + 3;
    /* Gates sit ON jump lips, so slot.s + 3 can land inside a gap jump's
       carved void. QA watched a car clear the Caldera Leap's lip gate, fall
       short, and then respawn INTO the lava floor at zero speed — scorched,
       respawned there again, forever. Any respawn that falls in a void's
       span goes to the landing side of the gap instead. */
    const jumps = this.trackDef.jumps;
    if (jumps) {
      for (const j of jumps) {
        const gap = j.gap || 0;
        if (gap && s > j.s - 4 && s < j.s + gap + 6) { s = j.s + gap + 8; break; }
      }
    }
    if (this.spline.length > 0) s %= this.spline.length;
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
    this.items.notifyReset(r.id);
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
    const S = SURFACES[v.surfaceId] || SURFACES[SURF.DIRT];
    this.dust.burst(v.pos.x, this.terrain.heightAt(v.pos.x, v.pos.z), v.pos.z, yaw, 1.4, S.dustCol);
  }

  /* ---------------- 11: audio mix ---------------- */
  _mixAudio(dt) {
    const v = this.player.vehicle;
    const a = this._as;
    a.rpm = v.rpmNorm; a.load = v.motorLoad; a.speed = v.speed;
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
        a.rivalRpm = rv.rpmNorm;
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

    this.items.hudFor(PLAYER_SLOT, this._hudItem);
    const hv = this._hudVeh;
    hv.speedKmh = v.speedKmh; hv.gear = v.gear; hv.rpmNorm = v.rpmNorm;
    hv.airborne = v.airborne; hv.airTime = v.airTime;

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
      playerTotal == null ? Infinity : playerTotal, playerBest, this.itemsFlag);
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

  /* ============================================================
     TEARDOWN — Race owns the world it was handed
     ============================================================ */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this.items.dispose();
    for (const r of this.racers) r.vehicle.dispose();
    this.racers.length = 0;

    this.props.dispose();
    this.sky.dispose();
    this.dust.clear();
    this.items.resetAll();
    this.dust.dispose();
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

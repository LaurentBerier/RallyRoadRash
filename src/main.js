/* ============================================================
   RALLY ROAD RASH — BOOTSTRAP, APP STATE MACHINE, FRAME LOOP
   ------------------------------------------------------------
   BOOT → MENU → TRACKS → GARAGE → RACE-LOADING → RACE → (results, inside
   Race) → MENU. Pause lives inside Race.

   This file owns exactly three pieces of DOM: the <canvas id="stage"> it
   hands to the Engine and the Input, and window/document lifecycle
   listeners (resize, visibilitychange, beforeunload, the first user gesture
   that is allowed to start the audio context). Everything else on screen
   belongs to ui/ui.js and ui/hud.js.

   The world (terrain, sky, props, dust) is built HERE, during the loading
   screen, because that is where the bake progress bar lives — and then handed
   to Race, which owns it from that moment including disposal.
   ============================================================ */
import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Save } from './core/save.js';
import { clamp } from './core/rng.js';
import { Assets, NO_ASSETS, loadAssets } from './core/assets.js';
import { MenuScene } from './ui/menuscene.js';
import { bakeTrack, Terrain } from './world/terrain.js';
import { Sky, SKY_THEMES } from './world/sky.js';
import { Props } from './world/props.js';
import { Dust } from './world/dust.js';
import { VFX } from './world/vfx.js';
import { setGroundTexture } from './world/terrain-shader.js';
import { TRACKS, getTrack } from './world/tracks/index.js';
import { VEHICLES, VEHICLE_BY_ID, statBars } from './game/vehicles.js';
import { setCarcassSource } from './game/vehicle-art.js';
import { CameraRig } from './game/camera.js';
import { Feel } from './game/feel.js';
import { Race } from './game/race.js';
import { AI_BALANCE } from './game/ai.js';
import { UI } from './ui/ui.js';
import { HUD } from './ui/hud.js';
import {
  normalizeProfile, isTrackUnlocked, isVehicleUnlocked,
  lockHintFor, recordFor, nextTrackFor
} from './game/progression.js';

const AS = { BOOT: 0, MENU: 1, TRACKS: 2, GARAGE: 3, LOADING: 4, RACE: 5 };

/* Settings keys are the contract in docs/INTEGRATION-NOTES.md. Anything the
   UI can edit has a default here; anything not here is not a setting. */
const DEFAULTS = {
  quality: 'high', fov: 58, sens: 1.0, invertY: false,
  volSfx: 0.8, volMusic: 0.6, music: true, items: true,
  camMode: 0, hudScale: 1, grain: 0.35, autoCentre: 1, showTouch: 'auto',
  /* motionFx scales the optional camera-and-post flourishes (speed blur,
     the live menu scene). Coarse pointers default to half: the effects
     that cost the most are the ones a phone can least afford. */
  motionFx: 1, tips: true, trickAssist: 1,
  rivals: 'normal'
};

/* How hard the field races you. `diff` slides the whole grid's skill through
   difficultyFor(); `band` replaces AI_BALANCE.player, which is what keeps the
   rivals near YOU rather than merely near each other. EASY widens the band so
   a leading rival backs off sooner and further; HARD narrows the bottom of it
   so nobody hands you the place. Applied when a race is built, which is why
   the settings hint says "from the next race". */
const RIVALS = {
  easy: { diff: -0.20, band: { aheadSec: 2, aheadMul: 0.92, behindSec: 7, behindMul: 1.03, ramp: 4, cap: [0.86, 1.05] } },
  normal: { diff: 0, band: { aheadSec: 3, aheadMul: 0.95, behindSec: 5, behindMul: 1.05, ramp: 4, cap: [0.90, 1.08] } },
  hard: { diff: 0.18, band: { aheadSec: 4, aheadMul: 0.97, behindSec: 4, behindMul: 1.06, ramp: 4, cap: [0.95, 1.08] } },
};

const App = {
  state: AS.BOOT,
  settings: null,
  profile: null,
  world: null,        // { terrain, sky, props, dust, vfx } — Race disposes it
  /* Optional imagery. Starts as the EMPTY set, not null, so every consumer
     runs its fallback path from the first frame and never has to test for
     the handle itself — only for the texture, which is null most of the
     time. Replaced in place when the manifest resolves. */
  assets: NO_ASSETS,
  menuScene: null,    // the live 3D menu backdrop; disposed before a bake
  race: null,
  elapsed: 0,
  muted: false,
  trackId: 'training',
  vehicleId: 'hopper'
};

const _sz = new THREE.Vector2();

/* ============================================================
   BOOT
   ============================================================ */
function guessQuality() {
  // deviceMemory is Chromium-only, so on Safari and Firefox the core count has
  // to carry the guess by itself rather than silently reading as 4 GB.
  const mem = navigator.deviceMemory || 0;
  const cores = navigator.hardwareConcurrency || 4;
  let tier;
  if (cores >= 8 && (mem === 0 || mem >= 8)) tier = 2;
  else if (cores >= 6 || mem >= 4) tier = 1;
  else tier = 0;
  /* A coarse pointer means a touch screen, not a slow chip — an iPad Pro and a
     touchscreen laptop both report it. Take one tier off for the thinner
     thermal budget and let the frame governor do the rest. */
  if (matchMedia('(pointer: coarse)').matches) tier = Math.max(0, tier - 1);
  return ['low', 'medium', 'high'][tier];
}

async function boot() {
  App.settings = Object.assign({}, DEFAULTS,
    { quality: guessQuality() },
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
      ? { motionFx: 0.5 } : null),
    Save.settings());
  App.profile = normalizeProfile(Save.readProfile());
  App.trackId = nextTrackFor(App.profile);
  App.vehicleId = App.profile.unlockedVehicles[App.profile.unlockedVehicles.length - 1] || 'hopper';

  /* UI first: it is the only thing that can show a boot failure to a player
     rather than to the console. */
  App.ui = new UI(Save);
  App.ui.boot(0.02, 'warming the tyres');

  const stage = document.getElementById('stage');
  App.engine = new Engine(stage, App.settings.quality);
  App.input = new Input(stage);
  App.audio = new Audio();
  App.hud = new HUD(App.audio);
  App.ui.setAudio(App.audio);
  /* The rig outlives any single track, so it is built with no terrain and gets
     one per race in buildWorld(). Nothing may call rig.update() before then —
     the menu drives the camera itself in idle(). */
  App.rig = new CameraRig(App.engine.camera, null);
  App.menuScene = new MenuScene(App.engine, {
    assets: App.assets, motionFx: App.settings.motionFx,
  });
  App.feel = new Feel(App.rig, App.engine);

  applySettings();
  App.ui.on(onAction);
  App.ui.boot(1, 'ready');
  App.ui.bootDone();

  wireLifecycle();
  showScreen('main');

  /* Optional images, loaded AFTER the menu is up and deliberately not
     awaited: the game is fully playable with assets/ empty, and blocking
     the boot on a set of JPEGs that may not exist would trade a certain
     delay for an uncertain gain. Consumers pick them up at their next
     material rebuild — which for a race is buildWorld(), and for the menu
     is the next card paint. */
  loadAssets('assets/manifest.json').then((map) => {
    App.assets = new Assets(map);
    App.ui.setAssets(App.assets);
    App.menuScene.assets = App.assets;
    /* Where a vehicle's carcass GLB lives (contract 8.6). The manifest is the
       only source — no guessed path, so an entry that is absent really does
       mean "draw the procedural body" instead of "fetch it anyway and 404".
       The lookup is lazy, so it is correct to install it before the manifest
       exists; it simply answers null until then. */
    setCarcassSource((id) => App.assets.url('models/' + id + '-carcass'));
    /* The menu scene built its machine at boot, when that lookup still said
       null. Nothing about the CHOICE of machine has changed, so setVehicle
       would short-circuit — ask for the rebuild explicitly. */
    if (App.menuScene && App.menuScene.rebuildVehicle) App.menuScene.rebuildVehicle();
    // Repaint whatever is on screen so art that arrived late is used.
    if (App.state === AS.MENU || App.state === AS.TRACKS || App.state === AS.GARAGE) {
      showScreen(App.state === AS.TRACKS ? 'tracks' : App.state === AS.GARAGE ? 'garage' : 'main');
    }
  }).catch(() => { /* stays NO_ASSETS; nothing downstream cares */ });

  App.tick = tick;
  App.showScreen = showScreen;
  App.startRace = startRace;
  window.ROADRASH = App;                 // QA harness: ROADRASH.tick(1/60), .race, .state
  requestAnimationFrame(frame);
}

/* ============================================================
   SETTINGS
   ============================================================ */
function persist() { Save.saveSettings(App.settings); }

/** Everything a settings value touches, applied live. */
function applySettings() {
  const S = App.settings, e = App.engine;
  e.final.uniforms.uGrain.value = S.grain;
  App.rig.fovScale = S.fov / 58;
  App.rig.sens = S.sens;
  App.rig.invertY = !!S.invertY;
  App.rig.autoCentre = S.autoCentre;
  App.audio.setVolumes(App.muted ? 0 : S.volSfx, App.muted ? 0 : S.volMusic);
  App.audio.setMusic(!!S.music);
  // one knob for every instrument dimension; the stylesheet does the rest
  document.documentElement.style.setProperty('--hud-k', S.hudScale);
  if (App.input.setTouchMode) App.input.setTouchMode(S.showTouch);
}

/** A tier change has to reach everything that sized itself from it. */
function applyQuality(key) {
  App.settings.quality = key;
  App.engine.setQuality(key);
  const q = App.engine.quality, w = App.world;
  if (w) {
    w.terrain.setQuality(q);
    w.props.setQuality(q);
    w.sky.setQuality(q);
    w.dust.setQuality(q);
  }
  // setQuality rebuilds the composer, so the final-pass uniforms are new
  // objects — re-apply or grain silently resets.
  applySettings();
  syncViewport();
}

/** Dust sizes its points against the drawing buffer, not the CSS pixel. */
function syncViewport() {
  if (!App.world) return;
  App.engine.renderer.getDrawingBufferSize(_sz);
  App.world.dust.setViewport(_sz.y);
}

function applySetting(key, value) {
  const S = App.settings;
  switch (key) {
    case 'quality': applyQuality(value); break;
    case 'fov': S.fov = +value; App.rig.fovScale = S.fov / 58; break;
    case 'sens': S.sens = +value; App.rig.sens = S.sens; break;
    case 'invertY': S.invertY = !!value; App.rig.invertY = S.invertY; break;
    case 'autoCentre': S.autoCentre = value | 0; App.rig.autoCentre = S.autoCentre; break;
    case 'grain': S.grain = +value; App.engine.final.uniforms.uGrain.value = S.grain; break;
    case 'hudScale':
      S.hudScale = +value;
      document.documentElement.style.setProperty('--hud-k', S.hudScale);
      break;
    case 'volSfx': case 'volMusic':
      S[key] = +value;
      App.audio.setVolumes(App.muted ? 0 : S.volSfx, App.muted ? 0 : S.volMusic);
      break;
    case 'music': S.music = !!value; App.audio.setMusic(S.music); break;
    case 'camMode':
      S.camMode = value | 0;
      if (App.race) App.race.rig.setMode(S.camMode, App.race.player.vehicle);
      break;
    case 'showTouch':
      S.showTouch = value;
      if (App.input.setTouchMode) App.input.setTouchMode(value);
      break;
    /* Live, so a toggle from the pause screen takes effect on the next
       corner rather than the next race. The catch-all below would persist it
       correctly but would not reach the running race. */
    case 'items':
      S.items = !!value;
      if (App.race) App.race.setItemsEnabled(S.items);
      break;

    default: S[key] = value; break;
  }
  persist();
}

/* ============================================================
   SCREENS
   ============================================================ */
/* ui.show() already hides the other screens, so this never calls ui.hide()
   first — doing so drops `ui-open` for a frame and the focus ring with it. */
function showScreen(name) {
  switch (name) {
    case 'main':
      App.state = AS.MENU;
      App.audio.setDriving(false);
      App.audio.setMusicMode('menu');
      App.input.unlock();
      App.input.showTouch(false);
      App.ui.show('main', {
        canContinue: false,          // there is no mid-race save, by design
        progression: App.profile,
        records: recordTable()
      });
      menuScene('main');
      break;

    case 'tracks':
      App.state = AS.TRACKS;
      App.ui.show('tracks', { tracks: trackList(), champion: !!App.profile.champion });
      menuScene('tracks');
      break;

    case 'garage':
      App.state = AS.GARAGE;
      App.ui.show('garage', { vehicles: vehicleList(), trackId: App.trackId });
      menuScene('garage');
      break;

    case 'settings':
      App.ui.show('settings', { settings: App.settings });
      break;

    default:
      App.ui.show(name, {});
      break;
  }
}

function recordTable() {
  const out = {};
  for (const t of TRACKS) out[t.id] = recordFor(App.profile, t.id);
  return out;
}

function trackList() {
  return TRACKS.map(t => {
    const rec = recordFor(App.profile, t.id);
    const locked = !isTrackUnlocked(App.profile, t.id);
    return {
      id: t.id, name: t.name, tagline: t.tagline, laps: t.laps,
      locked, lockHint: locked ? lockHintFor(t.id) : '',
      medal: rec.medal, best: rec.bestTotal, bestLap: rec.bestLap,
      bestItems: !!rec.itemsTotal, bestLapItems: !!rec.itemsLap
    };
  });
}

function vehicleList() {
  return VEHICLES.map(spec => {
    const locked = !isVehicleUnlocked(App.profile, spec.id);
    return { spec, locked, lockHint: locked ? lockHintFor(spec.id) : '', stats: statBars(spec) };
  });
}

/* ============================================================
   UI ACTIONS
   ============================================================ */
/**
 * Bring the menu backdrop up for a screen, or take it down for one that is
 * not a menu. It is shown for exactly three screens; everything else (pause,
 * settings, results, playbook) sits over whatever was already there.
 */
function menuScene(kind) {
  if (!App.menuScene) return;
  if (App.race) return;                    // a race owns the scene, not us
  App.menuScene.show(kind, {
    trackId: App.trackId, vehicleId: App.vehicleId,
    profile: App.profile, motionFx: App.settings.motionFx,
  });
}

function onAction(a) {
  if (!a || !a.type) return;
  App.audio.init();                    // no-op after the first call
  App.audio.resume();

  switch (a.type) {
    case 'race':
      if (a.trackId) App.trackId = a.trackId;
      if (a.vehicleId) App.vehicleId = a.vehicleId;
      startRace(App.trackId, App.vehicleId);
      break;

    case 'resume': if (App.race) App.race.resume(); break;
    case 'restart': if (App.race) App.race.restart(); break;
    case 'quit': quitToMenu(); break;

    case 'nextTrack': {
      const id = a.trackId || nextTrackFor(App.profile);
      App.trackId = id;
      startRace(id, App.vehicleId);
      break;
    }

    case 'settings':
      // A payload with a key is an edit; without one it is "open the panel".
      if (a.key === undefined) showScreen('settings');
      else applySetting(a.key, a.value);
      break;

    case 'back': showScreen('main'); break;

    /* A card was highlighted but not chosen. The backdrop follows the
       selection so the sky and the machine you are looking at are the ones
       you would race — no screen change, no reload. */
    case 'preview':
      if (a.trackId) { App.trackId = a.trackId; App.menuScene.setTrack(a.trackId); }
      if (a.vehicleId) { App.vehicleId = a.vehicleId; App.menuScene.setVehicle(a.vehicleId); }
      break;

    /* Anything else is a navigation request. The UI names the DESTINATION as
       the action type and repeats it in `to` (it has already moved itself off
       cached data); re-showing with live data is what keeps the unlock state
       and the record times honest. */
    default: showScreen(a.to || a.type); break;
  }
}

function quitToMenu() {
  if (App.race) { App.race.dispose(); App.race = null; }
  App.world = null;
  App.rig.terrain = null;              // the one it had is disposed
  showScreen('main');
}

/* ============================================================
   RACE LOADING
   ============================================================ */
function startRace(trackId, vehicleId) {
  if (App.state === AS.LOADING) return;
  const def = getTrack(trackId) || TRACKS[0];
  const spec = VEHICLE_BY_ID[vehicleId] || VEHICLES[0];
  App.state = AS.LOADING;
  App.ui.hide();
  App.hud.hideRace();
  App.input.unlock();
  App.input.showTouch(false);

  // Tear the old stage down BEFORE baking the new one: two full worlds resident
  // at once is 300 MB of textures on a phone.
  if (App.race) { App.race.dispose(); App.race = null; }
  App.world = null;
  /* BEFORE the bake, not after. MenuScene.hide() disposes its Sky, and
     Sky.dispose restores the scene's fog and environment — run it after
     buildWorld and it tears down the race's lighting instead of its own. */
  App.menuScene.hide();

  App.ui.boot(0.01, `surveying ${def.name}`, def.id);

  pumpBake(def).then((baked) => {
    buildWorld(def, baked);
    App.ui.boot(1, 'grid is forming');
    App.ui.bootDone();

    /* Before difficultyFor() is read, not after: both halves of the RIVALS
       setting have to be in place for the field this race builds. */
    applyRivals();
    App.race = new Race({
      engine: App.engine, input: App.input, audio: App.audio,
      ui: App.ui, hud: App.hud, rig: App.rig, feel: App.feel,
      terrain: App.world.terrain, sky: App.world.sky,
      props: App.world.props, dust: App.world.dust, vfx: App.world.vfx,
      trackDef: def, trackData: App.world.terrain.trackData,
      vehicleSpec: spec, difficulty: difficultyFor(def),
      items: App.settings.items !== false,
      trickAssist: App.settings.trickAssist,
      tips: App.settings.tips !== false,
      profile: App.profile,
      onExit: quitToMenu,
      onProfile: (p) => { App.profile = p; },
      onSetting: applySetting
    });
    App.trackId = def.id;
    App.vehicleId = spec.id;
    App.state = AS.RACE;
  }).catch((err) => {
    /* A failed bake (or a Race that threw during construction) must not strand
       the app in LOADING with no way out — and must not leak a half-built
       world that no Race is now responsible for disposing. */
    bootError(err);
    const w = App.world;
    if (w) {
      try {
        w.props.dispose(); w.sky.dispose(); w.dust.dispose();
        if (w.vfx) w.vfx.dispose();
        if (w.terrain.group && w.terrain.group.parent) w.terrain.group.parent.remove(w.terrain.group);
        w.terrain.dispose();
      } catch (e2) { console.error(e2); }
    }
    App.world = null;
    App.rig.terrain = null;
    App.ui.bootDone();
    showScreen('main');
  });
}

/** Mild, documented curve: the tutorial is a walkover, the caldera is not. */
function difficultyFor(def) {
  const i = TRACKS.indexOf(def);
  const r = RIVALS[App.settings && App.settings.rivals] || RIVALS.normal;
  return clamp(0.25 + i * 0.22 + r.diff, 0, 1);
}

/** Push the RIVALS setting into the driver model. Called once per race build. */
function applyRivals() {
  const r = RIVALS[App.settings && App.settings.rivals] || RIVALS.normal;
  AI_BALANCE.player = r.band;
}

/**
 * Drive the bake generator in chunks so the progress bar animates. rAF alone
 * stalls a backgrounded tab forever, so race it against a timer and take
 * whichever fires first.
 */
function pumpBake(def) {
  const gen = bakeTrack(def, (p, msg) => App.ui.boot(0.02 + clamp(p, 0, 1) * 0.94, msg));
  return new Promise((resolve, reject) => {
    const schedule = (fn) => {
      let fired = false;
      const go = () => { if (!fired) { fired = true; fn(); } };
      requestAnimationFrame(go);
      setTimeout(go, 26);
    };
    const step = () => {
      try {
        // Nobody is watching a hidden tab and its timers are throttled to ~1 Hz,
        // so chunking there would stall the load indefinitely. Just finish.
        const budget = document.hidden ? 1e9 : 14;
        const t0 = performance.now();
        let res;
        do { res = gen.next(); } while (!res.done && performance.now() - t0 < budget);
        if (res.done) resolve(res.value); else schedule(step);
      } catch (e) { reject(e); }
    };
    schedule(step);
  });
}

function buildWorld(def, baked) {
  const engine = App.engine;
  const theme = def.theme || 'training';

  const terrain = new Terrain(engine.renderer, baked, engine.quality, engine.caps, def);
  engine.scene.add(terrain.group);

  /* The terrain GLSL has always had a dynamic-shadow path and nothing ever
     enabled it, which is why cars appeared to hover. One line. */
  engine.attachTerrain(terrain);
  /* Optional photographic ground detail. Null is the normal case and the
     shader's own grain is the fallback; see core/assets.js. */
  setGroundTexture(terrain, App.assets.get('ground'));

  const sky = new Sky(engine.renderer, engine.scene, engine.quality, theme);
  /* Optional skyline panorama. When there is one it replaces the procedural
     vista ring; when there is not, the ring IS the horizon. */
  sky.setSkyline(App.assets.get('sky/' + theme));
  engine.setLightTheme(SKY_THEMES[theme]);
  syncSun(terrain, sky);

  const props = new Props(engine.scene, terrain, engine.quality, def, terrain.trackData);
  const dust = new Dust(engine.scene, terrain, sky.sunDir, engine.quality.dust, theme);
  const vfx = new VFX(engine.scene, dust, engine.quality, theme);
  props.setVfx(vfx, dust);

  // The rig samples ground height for its boom and its collision avoidance,
  // so it needs THIS track's terrain before the first rig.update().
  App.rig.terrain = terrain;

  App.world = { terrain, sky, props, dust, vfx };
  syncViewport();
}

/**
 * One sun, three consumers. sky.js is authoritative for the DIRECTION —
 * terrain bakes its occlusion mask against exactly this vector, and a
 * mismatch puts shadows where the light is not.
 *
 * Colour is the reconciliation the lead asked for: take the SKY's hue so the
 * dome, the cars and the ground agree, but keep the terrain theme's own
 * luminance, because that number is what its albedo palette was calibrated
 * against. Copying the sky colour raw brightens the training ground by 17 %.
 */
function syncSun(terrain, sky) {
  terrain.sunDir.copy(sky.sunDir);
  const u = terrain.uniforms;
  if (u.uSunDir) u.uSunDir.value.copy(sky.sunDir);
  if (u.uSunCol) {
    const c = sky.sunColor, t = u.uSunCol.value;
    const lumSky = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const lumTer = 0.2126 * t.x + 0.7152 * t.y + 0.0722 * t.z;
    const k = lumSky > 1e-4 ? lumTer / lumSky : 1;
    t.set(c.r * k, c.g * k, c.b * k);
  }
  App.engine.sun.position.copy(sky.sunDir).multiplyScalar(100);
}

/* ============================================================
   FRAME
   ============================================================ */
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;              // a tab-out must not teleport anything
  if (dt < 0) dt = 0;
  tick(dt);
}

/** One simulated + rendered frame. On the debug handle so a headless driver
    can advance the game without rAF. */
function tick(dt) {
  const input = App.input;
  const raw = input.poll();

  if (input.lastMethod && input.lastMethod !== App._method) {
    App._method = input.lastMethod;
    App.ui.setInputMethod(input.lastMethod);
    /* The HUD needs it too, and never got it: the item card's keycap and the
       pickup prompt both name a key, and both said F to a pad player. */
    App.hud.setInputMethod(input.lastMethod);
  }
  if (input.hit('KeyM')) {
    App.muted = !App.muted;
    App.audio.setVolumes(App.muted ? 0 : App.settings.volSfx, App.muted ? 0 : App.settings.volMusic);
    App.audio.ui('tick');
  }

  if (App.state === AS.RACE && App.race) App.race.update(dt, raw);
  else idle(dt);

  /* Sun flare. The final pass needs screen-space sun coordinates every frame
     because the camera moves; with no sky there is nothing to flare. */
  const uv = App.engine.final.uniforms.uSunUV.value;
  if (App.world) App.world.sky.projectSun(App.engine.camera, uv);
  else uv.z = 0;

  App.engine.render(dt);
  input.endFrame();
}

/**
 * The world behind the menus. Deliberately almost nothing: baking a 2 km
 * circuit so the main menu has a backdrop costs four seconds of load for a
 * picture the UI covers anyway. A slow camera drift keeps the post chain and
 * the governor warm; when a race has already been loaded the real world is
 * still there and gets the same drift for free.
 */
function idle(dt) {
  App.elapsed += dt;
  const c = App.engine.camera;
  /* The menu scene owns the camera while it is live — it has a composed
     dolly aimed right-of-frame so the UI plate never covers the machine.
     The orbit below is the fallback for LOW tier and motionFx 0. */
  if (App.menuScene && App.menuScene.live) {
    App.menuScene.update(dt, App.elapsed);
    App.audio.musicTick(App.elapsed, 0);
    return;
  }
  const t = App.elapsed * 0.05;
  const r = App.world ? 90 : 26;
  const y = App.world ? App.world.terrain.heightAt(0, 0) + 34 : 8;
  c.position.set(Math.cos(t) * r, y + Math.sin(t * 0.7) * 3, Math.sin(t) * r);
  c.lookAt(0, y * 0.4, 0);
  if (App.world) {
    App.world.terrain.update(dt, c, App.world.sky.sunDir);
    App.world.sky.update(dt, c, App.elapsed);
    App.world.dust.update(dt);
  }
  App.audio.musicTick(App.elapsed, 0);
}

/* ============================================================
   LIFECYCLE
   ============================================================ */
function wireLifecycle() {
  // iOS re-suspends the audio context on backgrounding, every time.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) App.audio.resume();
  });
  window.addEventListener('focus', () => App.audio.resume());

  // Engine.resize() has its own listener; this one is for everything that
  // sizes against the DRAWING buffer rather than the window.
  window.addEventListener('resize', syncViewport);

  window.addEventListener('beforeunload', () => {
    persist();
    if (App.profile) Save.writeProfile(App.profile);
  });

  /* WebAudio may only start inside a user gesture. One shot, then gone. */
  const kick = () => {
    App.audio.init();
    App.audio.resume();
    App.audio.setVolumes(App.muted ? 0 : App.settings.volSfx, App.muted ? 0 : App.settings.volMusic);
    App.audio.setMusic(!!App.settings.music);
    if (App.state === AS.MENU) App.audio.setMusicMode('menu');
    document.removeEventListener('pointerdown', kick);
    document.removeEventListener('keydown', kick);
    document.removeEventListener('touchstart', kick);
  };
  document.addEventListener('pointerdown', kick);
  document.addEventListener('keydown', kick);
  document.addEventListener('touchstart', kick);
}

function bootError(err) {
  console.error(err);
  const msg = 'BOOT FAILURE — ' + ((err && err.message) || 'unknown');
  try { App.ui.boot(1, msg); } catch { /* the UI is what failed */ }
}

window.addEventListener('error', (e) => {
  if (App.state === AS.BOOT) bootError(e.error || e);
  else console.error(e.error || e.message);
});

boot().catch(bootError);

export { App };

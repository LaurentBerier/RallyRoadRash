/* ============================================================
   RALLY ROAD RASH — THE LIVE MENU BACKDROP
   ------------------------------------------------------------
   Contract: docs/ARCHITECTURE.md §6.8.
     show(kind, {trackId, vehicleId, profile}) · setTrack() · setVehicle() ·
     update(dt, elapsed) · hide() · dispose() · sky · resultsBurst(vfx, pos)

   THE LIVE HALF IS THE GARAGE, AND ONLY THE GARAGE (wave 10).
   It used to run behind all three menu screens. The main menu is a painting
   now and the stage select is the stage's own painting, so a turntable behind
   either was a Sky, a PMREM bake, a Vehicle and a dust pool paid for to be
   90 % covered. `_wantLive` returns false for every kind but 'garage'; `show`
   re-evaluates it on every call, so walking into the garage builds and walking
   out tears down, through the path the LOW-tier case has always used.

   What the garage used to be: a black plate of text over `main.js idle()`
   orbiting an EMPTY scene. Nothing was in it. This puts the selected machine
   on a lit pad under the selected stage's sky, with enough paddock furniture
   around it to read as somewhere, and turns it slowly — and since wave 10
   under a three-point SHOWROOM RIG rather than whatever the stage sky left
   behind (see buildShowroomRig).

   WHY A PAD AND NOT THE WORLD (the same argument dev/garage.js makes): baking
   a 2 km circuit so the garage has a backdrop costs four seconds of load for a
   picture the overlay covers half of. A disc, a sky and one car cost nothing
   and are 90 % of the read.

   THE ONE BUG THIS FILE MUST NOT HAVE
   -----------------------------------
   `Sky.dispose()` restores `scene.fog` and `scene.environment`. A menu sky
   left alive when `buildWorld()` runs is the wrong IBL for the entire race —
   every car and every prop lit by the training ground's sky on the caldera,
   with no error anywhere. So `hide()` is a FULL teardown, not a visibility
   toggle, and `dispose()` is the same call. Rebuilding costs a disc, four
   instanced meshes and one Vehicle; it is not worth risking the alternative.

   MOTION BUDGET
   `motionFx 0` or a LOW quality tier skips the 3D entirely and shows the key
   art (or the CSS fallback) alone — see `_wantLive`. A phone that is already
   deciding whether it can hold 30 fps in a race should not be spending its
   thermal budget on a menu.
   ============================================================ */
import * as THREE from 'three';
import { Sky, SKY_THEMES } from '../world/sky.js';
import { Dust } from '../world/dust.js';
import { Vehicle } from '../game/vehicle.js';
import { VEHICLES, VEHICLE_BY_ID } from '../game/vehicles.js';
import { TRACKS, getTrack } from '../world/tracks/index.js';
import { SURF } from '../world/surfaces.js';
import {
  kitPalette, canopyGeo, crateGeo, spareWheelGeo, poleGeo, wireGeo,
} from '../world/kit.js';

/* A pad, not a terrain: the same four methods Vehicle and Dust are
   contracted to use, and nothing else. Straight out of dev/garage.js. */
const PAD = {
  heightAt: () => 0,
  normalAt(x, z, e, out) { return out.set(0, 1, 0); },
  surfaceAt: () => SURF.DIRT,
  onRoad: () => 1,
};

/* Zero control, reused every frame — the car is parked, and a fresh object
   literal 60 times a second in a menu is still an allocation in a loop. */
const NO_CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0, roll: 0 };

const PAD_R = 13;                 // metres — big enough that the disc edge is
                                  // off screen at every camera angle we use

/* ------------------------------------------------------------------
   THE GARAGE WINDOW
   ------------------------------------------------------------------
   The garage screen is full-bleed key art with a rectangle CLIPPED OUT of it
   (styles.css `.garage-hero`, under `body.menu3d`), and the live turntable
   shows through that rectangle. These four numbers ARE that clip-path,
   expressed as fractions of the viewport — x/y from the top-left corner.
   MOVE ONE AND YOU MUST MOVE THE OTHER. Nothing at RUNTIME can notice they
   have drifted apart, so since wave 10 dev/menu-check.mjs reads styles.css as
   text, pulls the percentages out of that clip-path and asserts they equal
   these four numbers times 100. Edit one alone and `npm test` says so.

   Why a camera aim and not a viewport: the engine owns ONE EffectComposer and
   every screen renders through it, so there is no second pass to give the
   machine and no scissor rect to render it into. The only lever is where the
   camera looks, which is what _frameGarage does.
   ------------------------------------------------------------------ */
export const GARAGE_WIN = { x0: 0.50, x1: 1.00, y0: 0.12, y1: 0.66 };
const GARAGE_Y = 0.78;            // the machine's visual centre, metres up
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------
   THE SHOWROOM RIG
   ------------------------------------------------------------------
   Until wave 10 the garage had NO LIGHTING OF ITS OWN. _makeSky pushed the
   selected stage's theme through engine.setLightTheme and that was the whole
   rig: one DirectionalLight and one HemisphereLight, aimed and coloured for a
   race. Two things followed, and both of them looked like nothing in
   particular rather than like a bug, which is why they survived four waves.

   First, the machine's exposure was decided by the LAST STAGE YOU PICKED.
   sunIntensity runs 1.55 on volcano to 2.95 on canyon — the same paintwork
   1.9x brighter or darker depending on a choice made on a different screen.
   The clamps below are one-sided ON PURPOSE: they raise a dark stage to a
   floor and never pull a bright one down, so the caldera stops being a
   silhouette and the canyon keeps its own afternoon.

   Second, one key light from the stage's sun angle is not a product shot. A
   car is read from its highlights: a warm key across the front quarter to
   model the bodywork, and a cool rim from behind the far shoulder to cut the
   silhouette off the backdrop. Neither casts a shadow — engine.sun owns the
   only shadow map on the renderer and a second caster would double every
   contact — so this is pure shading and costs two lights.

   The rim takes its colour from the theme's own `hemiSky`, so the machine is
   still lit by the stage standing behind it; it is a composition of that
   light, not a replacement for it.
   ------------------------------------------------------------------ */
export const SHOWROOM = {
  keyColor: 0xffe0c0, keyIntensity: 2.2,
  keyX: -6.0, keyY: 5.5, keyZ: 4.0,          // front-left and high
  rimIntensity: 1.6,
  rimX: 5.0, rimY: 2.2, rimZ: -6.0,          // behind the far shoulder
  sunMin: 2.40, hemiMin: 0.70,               // floors, never ceilings
  sweepPeriod: 12, sweepAmp: 2.6,            // seconds, metres
};

const _v = new THREE.Vector3();
const _dummy = new THREE.Object3D();
/* Scratch for _frameGarage. Module scope because this runs every frame and a
   fresh Vector3 sixty times a second is still an allocation in a loop. */
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Add the three-point showroom rig to `group` and floor the engine's own two
 * lights. Renderer-free and side-effect-contained: everything it adds is a
 * child of `group`, everything it changes on the engine is undone by
 * teardownShowroomRig, and it never touches a shadow map or a render target —
 * which is what lets dev/menu-check.mjs exercise it against a bare Group and a
 * stub engine with no GL at all.
 *
 * @param group   THREE.Group the lights are parented to (the menu's own)
 * @param engine  core/engine.js Engine, or a stub carrying { sun, fill }
 * @param theme   a SKY_THEMES key — the stage standing behind the machine
 * @returns {{key: THREE.DirectionalLight, rim: THREE.DirectionalLight}|null}
 */
export function buildShowroomRig(group, engine, theme) {
  if (!group) return null;

  const key = new THREE.DirectionalLight(SHOWROOM.keyColor, SHOWROOM.keyIntensity);
  key.position.set(SHOWROOM.keyX, SHOWROOM.keyY, SHOWROOM.keyZ);
  key.castShadow = false;
  /* The target has to be IN THE SCENE or three.js never updates its world
     matrix and the light aims at wherever the origin was when it was made.
     Its default position is (0,0,0), which is the middle of the pad, which is
     where the machine is parked. */
  group.add(key);
  group.add(key.target);

  const rim = new THREE.DirectionalLight(0xa8c8ff, SHOWROOM.rimIntensity);
  rim.position.set(SHOWROOM.rimX, SHOWROOM.rimY, SHOWROOM.rimZ);
  rim.castShadow = false;
  group.add(rim);
  group.add(rim.target);

  const rig = { key, rim };
  tuneShowroomRig(rig, engine, theme);
  return rig;
}

/**
 * Re-apply everything about the rig that DEPENDS ON THE STAGE: the one-sided
 * intensity floors, and the rim's colour.
 *
 * Separate from the build because it has to run again. `Sky` is rebuilt on
 * every stage change, and _makeSky ends by pushing the new theme through
 * engine.setLightTheme — which writes sunIntensity and hemiIntensity straight
 * from the table and so UNDOES the floors. Walk into the garage on the caldera
 * and the clamp holds; swap the stage while standing in it and the sun drops
 * back to 1.55 with the rig still up, which is a darker garage than the one
 * that had no rig at all. So _makeSky calls this on its way out.
 */
export function tuneShowroomRig(rig, engine, theme) {
  const t = (theme && SKY_THEMES[theme]) || SKY_THEMES.training;
  // Floors, not settings — see the SHOWROOM note above.
  if (engine && engine.sun && engine.sun.intensity < SHOWROOM.sunMin) {
    engine.sun.intensity = SHOWROOM.sunMin;
  }
  if (engine && engine.fill && engine.fill.intensity < SHOWROOM.hemiMin) {
    engine.fill.intensity = SHOWROOM.hemiMin;
  }
  if (rig && rig.rim) rig.rim.color.set(t.hemiSky === undefined ? 0xa8c8ff : t.hemiSky);
  return rig || null;
}

/**
 * Remove the rig and put the stage's own light back. Returns null so the
 * caller can write `this.rig = teardownShowroomRig(...)`.
 *
 * The setLightTheme call is HYGIENE, not a fix: buildWorld() re-applies the
 * theme on its way into a race, so a leaked clamp could not actually reach the
 * track. But this file's whole contract is that it leaves nothing behind, and
 * "the race happens to overwrite it" is the argument that produces the next
 * bug rather than the one that prevents it.
 */
export function teardownShowroomRig(group, rig, engine, theme) {
  if (rig && group) {
    for (const l of [rig.key, rig.rim]) {
      if (!l) continue;
      if (l.target) group.remove(l.target);   // a no-op if it was never added
      group.remove(l);
      if (typeof l.dispose === 'function') l.dispose();
    }
  }
  if (engine && engine.setLightTheme) {
    engine.setLightTheme(SKY_THEMES[theme] || SKY_THEMES.training);
  }
  return null;
}

export class MenuScene {
  /**
   * @param engine  core/engine.js Engine — scene, camera, renderer, quality
   * @param opts    { assets, motionFx }  assets is core/assets.js's handle and
   *                may be null; every path here works with it empty.
   */
  constructor(engine, opts) {
    const o = opts || {};
    this.engine = engine || null;
    this.assets = o.assets || null;
    this.motionFx = o.motionFx == null ? 1 : +o.motionFx;

    this.kind = null;                 // 'main' | 'tracks' | 'garage' | null
    this.trackId = null;
    this.vehicleId = null;
    this.theme = 'training';

    this.sky = null;                  // read by main.js for projectSun
    this.group = null;
    this.turntable = null;
    this.dust = null;
    this.vehicle = null;
    this.rig = null;                  // the showroom lights, when the 3D is up
    this.contact = null;              // the machine's grounding shadow (per swap)

    this._live = false;               // is the 3D half built?
    this._geo = [];
    this._mat = [];
    this._tex = [];
    this._t = 0;
    this._spin = 0;
    this._wisp = 0;

    // The DOM half: a full-bleed layer between the canvas and the screens.
    // ui.js owns showing/hiding it for the plain case; this only takes over
    // the art and the `menu3d` flag.
    this.el = typeof document !== 'undefined' ? document.getElementById('hero') : null;
    this.elArt = typeof document !== 'undefined' ? document.getElementById('heroArt') : null;
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */

  /**
   * True while the 3D half is built and this object is driving the camera.
   * main.js's idle() reads it to decide whether to run its own orbit — the
   * two must never both write the camera in a frame, and the answer changes
   * with the quality tier and the motionFx setting, not just with the screen.
   */
  get live() { return this._live; }

  /** @param kind 'main' | 'tracks' | 'garage' */
  show(kind, o) {
    const d = o || {};
    this.kind = kind || 'main';
    if (d.motionFx != null) this.motionFx = +d.motionFx;
    if (d.trackId) this.trackId = d.trackId;
    if (d.vehicleId) this.vehicleId = d.vehicleId;
    if (!this.trackId) this.trackId = (TRACKS[0] && TRACKS[0].id) || 'training';
    if (!this.vehicleId) this.vehicleId = (VEHICLES[0] && VEHICLES[0].id) || 'hopper';

    /* Resolve the theme BEFORE building. A Sky construction runs a PMREM
       bake; building a training sky and then immediately replacing it with
       the selected stage's would pay for two. */
    const def = getTrack(this.trackId);
    const want = (def && def.theme) || 'training';
    this.theme = SKY_THEMES[want] ? want : 'training';

    if (this._wantLive()) this._build();
    else this._teardown();               // a settings change can turn it off live
    this._syncDom();
    if (this._live) {
      this.setTrack(this.trackId);
      this.setVehicle(this.vehicleId);
    }
  }

  /** Stage select swaps the sky (and with it the light, dust and paddock). */
  setTrack(trackId) {
    if (trackId) this.trackId = trackId;
    const def = getTrack(this.trackId);
    const theme = (def && def.theme) || 'training';
    if (!this._live) { this.theme = SKY_THEMES[theme] ? theme : 'training'; return; }
    if (theme === this.theme && this.sky) return;
    this.theme = SKY_THEMES[theme] ? theme : 'training';
    this._makeSky();
    this._buildDressing();
    if (this.dust) this.dust.setTheme(this.theme);
  }

  /**
   * Rebuild the machine on the pad even though it has not changed.
   *
   * For when something the BUILD reads has changed rather than the choice of
   * machine — the asset manifest arriving after boot, which is what tells
   * vehicle-carcass where the generated bodies live. setVehicle() short-
   * circuits on an unchanged spec, which is right for the garage and wrong
   * here, so this is the explicit way to ask for the work again.
   */
  rebuildVehicle() {
    const id = this.vehicleId;
    /* _dropVehicle FIRST, and no nulling before it.
       This used to null `this.vehicle` to defeat setVehicle's unchanged-spec
       guard — but _dropVehicle opens with `if (!this.vehicle) return;`, so
       nulling first turned the drop into a no-op: the old machine was never
       disposed and never removed from the turntable, and setVehicle built a
       second one on top of it. Two superimposed vehicles is why the garage
       showed a procedural cab, bullbar and light bar THROUGH the generated
       carcass, and it leaked a Vehicle on every boot, because main.js calls
       this the moment the asset manifest resolves.
       _dropVehicle nulls the field itself once it has disposed, which is all
       the unchanged-spec guard ever needed. */
    this._dropVehicle();
    this.setVehicle(id);
  }

  /** The garage swaps the machine on the pad. */
  setVehicle(vehicleId) {
    if (vehicleId) this.vehicleId = vehicleId;
    if (!this._live) return;
    const spec = VEHICLE_BY_ID[this.vehicleId] || VEHICLES[0];
    if (this.vehicle && this.vehicle.spec === spec) return;
    this._dropVehicle();
    try {
      this.vehicle = new Vehicle(this.turntable, PAD, spec, { livery: 0 });
      this.vehicle.placeAt(0, 0, 0);
      this._makeContactShadow(spec);
    } catch (e) {
      // A menu backdrop must never be able to stop the game booting.
      console.warn('[menuscene] vehicle build failed', e);
      this.vehicle = null;
    }
  }

  /**
   * One frame of backdrop. main.js calls this INSTEAD of driving the camera
   * itself while a menu screen is up — see the report's contract needs.
   */
  update(dt, elapsed) {
    if (!this._live) return;
    const d = dt > 0 && dt < 0.25 ? dt : 0.016;
    this._t += d;
    const cam = this.engine.camera;

    // turntable: slow, constant, and never reset — a car that snaps back to
    // its start angle when you change screens looks like a bug
    this._spin += d * 0.20;
    if (this.turntable) this.turntable.rotation.y = this._spin;

    if (this.vehicle) {
      this.vehicle.step(d, NO_CTL);
      this.vehicle.updateVisuals(d);
    }

    /* The dolly. There is only one kind left that can be live — see
       _wantLive — so there is only one framing: the garage window. */
    this._frameGarage(cam);

    /* The key light walks a slow arc across the machine's front quarter. One
       field write per frame, twelve seconds a lap: enough that the paint
       moves and the chrome catches, slow enough that nobody watches it. */
    if (this.rig && this.rig.key) {
      this.rig.key.position.x = SHOWROOM.keyX +
        Math.sin(this._t * (6.2832 / SHOWROOM.sweepPeriod)) * SHOWROOM.sweepAmp;
    }

    if (this.sky) this.sky.update(d, cam, elapsed || this._t);
    if (this.engine.aimShadow && this.sky) {
      this.engine.aimShadow(_v.set(0, 0.5, 0), this.sky.sunDir);
    }

    // Dust wisps: a few grains drifting across the pad, on a timer rather than
    // per frame, so the count is the same at 30 fps and at 144.
    if (this.dust) {
      this._wisp -= d;
      if (this._wisp <= 0) {
        this._wisp = 0.34 + Math.random() * 0.5;
        const ang = Math.random() * 6.2832;
        const r = PAD_R * (0.35 + Math.random() * 0.55);
        this.dust.spawn(3, Math.cos(ang) * r, 0.18 + Math.random() * 0.5, Math.sin(ang) * r,
          0.55, 0.9, -0.6, 0.2);
      }
      this.dust.update(d);
    }
  }

  /**
   * GARAGE FRAMING — put the machine inside the CSS window.
   *
   * Two jobs. First, pull back and raise a little, until the whole machine
   * fits inside a rectangle half the frame wide: the orbit this replaced sat
   * at 8.4 m for a full-frame composition, and in a window that size the car
   * is a bumper.
   *
   * Second, aim OFF-AXIS by exactly the window's offset from screen centre.
   * That offset is a nonlinear function of the aim point — moving the target
   * changes the view direction, which changes the machine's depth along it,
   * which changes how far a metre of offset is worth in screen space — so
   * rather than approximate it with a half-frustum width at the orbit radius
   * (which lands the machine about 4 % of the screen too far out, enough to
   * clip a wheel against the window edge at 1280 wide) this takes three
   * Newton steps. Each one measures where the machine actually projects and
   * pushes the aim point the other way; it converges to well under a pixel by
   * the third, and every vector it uses is module scope, so a frame of this
   * allocates nothing.
   *
   * No projection state is touched — no setViewOffset, no scissor, no second
   * pass — so there is nothing here for the race to inherit if this file's
   * teardown is ever wrong. The camera is re-aimed by main.js the moment a
   * race starts.
   */
  _frameGarage(cam) {
    // half-frustum tangents, read from the camera so the FIELD OF VIEW
    // setting and the window's aspect are both accounted for
    const tv = Math.tan((cam.fov || 58) * 0.5 * DEG);
    const th = tv * (cam.aspect || 1.7778);
    /* The menu shares the race camera and does NOT own its fov: game/camera.js
       leaves behind whatever the last frame of the last race had, which is the
       player's FIELD OF VIEW setting (42..82) plus a speed kick. Hold the
       framing against that by scaling the orbit radius with the tangent ratio,
       so the machine is the same size in the window on 42 as on 82. Clamped
       both ways: past ~12.5 m the camera walks out of PAD_R and the tyre wall
       gets between it and the machine. */
    const k = Math.min(1.16, Math.max(0.66, Math.tan(29 * DEG) / Math.max(0.12, tv)));
    /* A slow, narrow arc: a full orbit would swing the machine out of a
       window that is 50 % x 54 % of the frame. R and h came DOWN in wave 10
       (10.6 / 2.70) because the window grew half again as tall — the same
       framing in a bigger hole is a smaller car in more empty floor, which is
       the opposite of what widening it was for. */
    const a = -0.55 + Math.sin(this._t * 0.075) * 0.20;
    const R = 9.4 * k + Math.sin(this._t * 0.05) * 0.55;
    const h = 2.55 * k + Math.sin(this._t * 0.09) * 0.22;
    cam.position.set(Math.sin(a) * R, h, Math.cos(a) * R);

    // where the window's centre is, in normalised device coords (+x right,
    // +y UP — CSS y runs the other way, hence the 1 - 2*cy)
    const wantX = GARAGE_WIN.x0 + GARAGE_WIN.x1 - 1;
    const wantY = 1 - (GARAGE_WIN.y0 + GARAGE_WIN.y1);

    _tgt.set(0, GARAGE_Y, 0);                      // start by aiming at it
    for (let i = 0; i < 3; i++) {
      _fwd.copy(_tgt).sub(cam.position).normalize();
      // the basis three.js's lookAt will build from this direction
      _rgt.crossVectors(_fwd, _WORLD_UP).normalize();
      _upv.crossVectors(_rgt, _fwd);
      _rel.set(0, GARAGE_Y, 0).sub(cam.position);
      const depth = _rel.dot(_fwd);
      if (!(depth > 0.1)) break;                   // behind us: give up, aim straight
      const ex = wantX - _rel.dot(_rgt) / (depth * th);
      const ey = wantY - _rel.dot(_upv) / (depth * tv);
      if (Math.abs(ex) < 0.002 && Math.abs(ey) < 0.002) break;
      _tgt.addScaledVector(_rgt, -ex * depth * th);
      _tgt.addScaledVector(_upv, -ey * depth * tv);
    }
    cam.lookAt(_tgt);
  }

  /**
   * Leave the menu. FULL teardown — the Sky must be gone before the race bake
   * touches scene.fog / scene.environment. See the header.
   */
  hide() {
    this._teardown();
    this.kind = null;
    this._syncDom();
  }

  dispose() {
    this.hide();
    this.el = null;
    this.elArt = null;
    this.engine = null;
  }

  /** Podium confetti at the results screen. vfx is optional everywhere. */
  resultsBurst(vfx, pos) {
    if (!vfx || typeof vfx.confetti !== 'function') return;
    const p = pos | 0;
    const n = p === 1 ? 90 : p <= 3 ? 46 : 0;
    if (!n) return;
    try { vfx.confetti(n, 0, 3.2, 0, 3.4); } catch { /* cosmetic only */ }
  }

  /* ============================================================
     BUILD / TEARDOWN
     ============================================================ */

  /* LOW tier and motionFx 0 both mean "do not spend frames on decoration".
     A missing engine or renderer means we are in a harness with no GL at all. */
  _wantLive() {
    if (!this.engine || !this.engine.scene || !this.engine.renderer) return false;
    /* GARAGE ONLY, since wave 10. The main menu is a painting and the stage
       select is the stage's own painting; neither wants a turntable behind it,
       and neither should pay for a Sky, a PMREM bake and a Vehicle to show
       one. show() re-evaluates this on EVERY call and tears down when it
       flips, so main -> garage -> main builds on the way in and disposes on
       the way out, through exactly the path the LOW-tier and motionFx-0 cases
       have always used. Nothing new in the lifecycle. */
    if (this.kind !== 'garage') return false;
    if (!(this.motionFx > 0)) return false;
    const q = this.engine.quality;
    if (q && q.name === 'LOW') return false;
    return true;
  }

  _build() {
    if (this._live) return;
    const scene = this.engine.scene;

    this.group = new THREE.Group();
    this.group.name = 'menuscene';
    scene.add(this.group);

    this.turntable = new THREE.Group();
    this.group.add(this.turntable);

    // Set before anything can fail, so _teardown below can undo a half-build.
    this._live = true;

    this._makePad();
    this._makeSky();
    /* No sky means no light theme and no IBL — the pad would be a black disc
       and the machine an unlit silhouette. The DOM hero is a better answer
       than a broken one, so unwind and let it take over. */
    if (!this.sky) { this._teardown(); return; }

    this._buildDressing();
    this.rig = buildShowroomRig(this.group, this.engine, this.theme);

    try {
      const cap = Math.min(420, (this.engine.quality && this.engine.quality.dust) || 500);
      this.dust = new Dust(this.group, PAD, this.sky.sunDir, cap, this.theme);
      // Points are sized in metres until the viewport height is known.
      if (this.engine.renderer) {
        const sz = new THREE.Vector2();
        this.engine.renderer.getDrawingBufferSize(sz);
        this.dust.setViewport(sz.y);
      }
    } catch (e) {
      console.warn('[menuscene] dust unavailable', e);
      this.dust = null;
    }
  }

  _teardown() {
    if (!this._live) { this._syncDom(); return; }
    this._live = false;

    this._dropVehicle();
    this.rig = teardownShowroomRig(this.group, this.rig, this.engine, this.theme);
    if (this.dust) { try { this.dust.dispose(); } catch { /* already gone */ } this.dust = null; }
    /* THE ONE THAT MATTERS. Sky.dispose restores fog and environment; skipping
       it leaves the race lit by the menu. */
    if (this.sky) { try { this.sky.dispose(); } catch { /* already gone */ } this.sky = null; }

    /* Dressing geometry is built per THEME, not per scene, so it is not in
       _geo — it has to be released here as well as in _buildDressing, or a
       menu→race→menu round trip leaks one canopy set per visit. */
    if (this._dress) for (const m of this._dress) m.geometry.dispose();
    this._dress = null;

    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    for (const t of this._tex) t.dispose();
    this._geo.length = 0; this._mat.length = 0; this._tex.length = 0;

    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.group = null;
    this.turntable = null;
    this.dressMat = null;
  }

  _keepGeo(g) { this._geo.push(g); return g; }
  _keepMat(m) { this._mat.push(m); return m; }
  _keepTex(t) { this._tex.push(t); return t; }

  /* ---------------- the pad ---------------- */
  _makePad() {
    /* TWO textures on one disc, and they tile differently, which is why the
       grid is drawn per-metre and the light pool is not.

       The GRID is what it always was: a repeating one-metre square so ride
       height and the machine's shadow have something to read against. It is
       fainter than it used to be — under the showroom rig it was the loudest
       thing on the floor, and a garage floor is not graph paper. */
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#5f584e'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(0,0,0,.10)'; g.lineWidth = 2;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,.035)';
    g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
    const tex = this._keepTex(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(PAD_R * 2, PAD_R * 2);          // one square per metre
    tex.anisotropy = 4;

    /* The LIGHT POOL is a spot baked into the albedo: bright under the
       machine, falling to near-black at the disc edge, with two faint painted
       rings for a showroom floor's marked bay. It maps ONCE across the whole
       disc, so it cannot tile with the grid and has to be its own texture —
       drawn on the same material through `aoMap`'s slot would need a second
       uv set, so it goes in as an emissive-free multiply: the map above tints
       per metre, this one shades per disc, and both are albedo. */
    const p = document.createElement('canvas');
    p.width = p.height = 512;
    const q = p.getContext('2d');
    /* ALBEDO, not a light. The first cut of this ran the centre to #ffffff and
       the floor blew straight through the tone curve: a white disc lit by a
       2.85 sun is a white disc whatever the grade does afterwards. These stops
       hold the old flat pad's #5f584e as the BRIGHTEST value and fall away
       from it, so the pool is a shape in the shading rather than a lamp. */
    const pool = q.createRadialGradient(256, 256, 10, 256, 256, 250);
    pool.addColorStop(0.00, '#6b645a');
    pool.addColorStop(0.34, '#585148');
    pool.addColorStop(0.68, '#3b3630');
    pool.addColorStop(1.00, '#1e1b19');
    q.fillStyle = pool; q.fillRect(0, 0, 512, 512);
    q.strokeStyle = 'rgba(255,255,255,.07)'; q.lineWidth = 3;
    for (const r of [148, 206]) { q.beginPath(); q.arc(256, 256, r, 0, 6.2832); q.stroke(); }
    const poolTex = this._keepTex(new THREE.CanvasTexture(p));
    poolTex.colorSpace = THREE.SRGBColorSpace;
    poolTex.anisotropy = 4;

    /* Roughness down and metalness up from the old .96 / 0 matte: the Sky's
       PMREM is already in scene.environment, so a floor that is a little
       polished reflects the stage standing behind the machine and the pad
       stops being a grey plate. Not a mirror — `Reflector` is a second render
       pass, and one shared EffectComposer means a second pass for a 13 m disc
       under one parked car is not a trade worth making. */
    const mesh = new THREE.Mesh(
      this._keepGeo(new THREE.CircleGeometry(PAD_R, 56).rotateX(-Math.PI / 2)),
      this._keepMat(new THREE.MeshStandardMaterial({
        map: poolTex, roughness: 0.42, metalness: 0.12, envMapIntensity: 0.8,
      })));
    mesh.receiveShadow = true;
    this.group.add(mesh);

    /* The grid rides just above it as its own thin disc rather than fighting
       for the same map slot. depthWrite off and a renderOrder below the
       machine so nothing z-fights and nothing occludes the contact shadow. */
    const grid = new THREE.Mesh(
      this._keepGeo(new THREE.CircleGeometry(PAD_R, 56).rotateX(-Math.PI / 2)),
      this._keepMat(new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.20,
        depthWrite: false, toneMapped: false,
      })));
    grid.position.y = 0.004;
    grid.renderOrder = -1;
    this.group.add(grid);
  }

  /* ---------------- contact shadow ----------------
     THE ONE THING THAT GROUNDS THE MACHINE AT LOW QUALITY. engine.sun's
     shadow map is off entirely on the LOW tier (_configureShadow), and a car
     with no shadow does not sit on the floor, it hovers over it. This is a
     painted ellipse under the wheels: no light, no map, no pass — a radial
     alpha ramp on an unlit disc, which costs one draw call and works at every
     tier including the ones with real shadows, where it reads as the ambient
     occlusion the single key light cannot produce.

     Sized off the spec's own bounding box so the bike gets a bike's shadow
     and the Ridgeback gets a truck's. Per-swap state like the Vehicle itself,
     so it is disposed in _dropVehicle rather than held in _geo. */
  _makeContactShadow(spec) {
    if (!this.turntable) return;
    const d = (spec && spec.dims) || { L: 4, W: 2 };
    const r = Math.max(d.L || 4, d.W || 2) * 0.62;

    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grad.addColorStop(0.00, 'rgba(0,0,0,1)');
    grad.addColorStop(0.45, 'rgba(0,0,0,.72)');
    grad.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);

    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(r, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.55,
        depthWrite: false, toneMapped: false,
      }));
    mesh.position.y = 0.01;
    mesh.renderOrder = 1;
    this.turntable.add(mesh);
    this.contact = mesh;
  }

  /* ---------------- the sky ---------------- */
  _makeSky() {
    if (this.sky) { try { this.sky.dispose(); } catch { /* already gone */ } this.sky = null; }
    const scene = this.engine.scene;
    /* Sky adds itself to the scene inside its own constructor, so a throw
       part-way through leaves objects behind that no dispose() will ever
       reach — and this menu's whole contract is that it leaves NOTHING for
       the race to inherit. Watermark the scene and roll back to it. */
    const mark = scene.children.length;
    try {
      this.sky = new Sky(this.engine.renderer, scene, this.engine.quality, this.theme);
      if (this.engine.setLightTheme) this.engine.setLightTheme(SKY_THEMES[this.theme]);
      if (this.engine.sun && this.sky.sunDir) {
        this.engine.sun.position.copy(this.sky.sunDir).multiplyScalar(100);
      }
    } catch (e) {
      console.warn('[menuscene] sky unavailable', e);
      this.sky = null;
      while (scene.children.length > mark) scene.remove(scene.children[scene.children.length - 1]);
    }
    /* setLightTheme above wrote the stage's own sun and fill intensities, so
       the showroom floors have to go back on top of them. This is the ONLY
       reason tuneShowroomRig is a separate function — see its header. */
    if (this.rig) tuneShowroomRig(this.rig, this.engine, this.theme);
  }

  /* ---------------- paddock dressing ----------------
     One InstancedMesh per shape sharing a single vertex-coloured material —
     the pattern props.js `_flushDressing` uses, for the same reason: adding a
     kind of prop must cost a geometry and not a draw call.

     Rebuilt on a theme change because kit geometry bakes its palette into the
     vertex colours; that is four small merges, not a bake. */
  _buildDressing() {
    if (!this.group) return;
    if (this._dress) {
      for (const m of this._dress) { this.group.remove(m); m.geometry.dispose(); }
    }
    this._dress = [];
    if (!this.dressMat) {
      this.dressMat = this._keepMat(new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.88, metalness: 0.05,
      }));
    }
    /* The layout is hand-placed, not scattered: five props around one pad is
       a composition, and a seeded scatter over that area produces a car park.
       Coordinates are metres, +Z toward the camera's home position. */
    const P = kitPalette(this.theme);

    const place = (geo, sites) => {
      if (!sites.length) return;
      const im = new THREE.InstancedMesh(geo, this.dressMat, sites.length);
      im.castShadow = true;
      im.receiveShadow = false;
      im.frustumCulled = false;
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        _dummy.position.set(s[0], s[1] || 0, s[2]);
        _dummy.rotation.set(0, s[3] || 0, 0);
        _dummy.scale.setScalar(s[4] == null ? 1 : s[4]);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this._dress.push(im);
    };

    /* THE SET IS COMPOSED AROUND ONE CAMERA and since wave 10 there is only
       one: `_frameGarage` orbits a ≈ -0.55 ± 0.20 rad, so the machine's
       BACKGROUND — the strip of pad the window frames behind it — sits at
       roughly 148° in world terms, out past (+5, -8). Anything parked there
       is not scenery, it is a hat on the car.

       So in wave 10 the canopies went from two at r ≈ 7 to ONE at r ≈ 8.9,
       moved round to 54° off the view axis — outside the 45° half-frustum, so
       it frames from beyond the window's left edge and swings in only at the
       end of the arc. The one that used to sit opposite it was 22° off axis:
       a big flat quad of lit canvas directly behind the roll cage, reading as
       a coloured ceiling on every stage and as a pink glare on the caldera.
       The TYRE WALL backs the machine now, which is what a tyre wall is for,
       and the floodlight on that side is a thin vertical that frames rather
       than fills. */
    place(canopyGeo(P, 11), [[-8.8, 0, -1.2, 0.9]]);
    // crates under it, and out of the background strip with it
    place(crateGeo(P, 23), [
      [-7.4, 0, 0.2, 0.3], [-8.6, 0, 0.9, 1.1], [-6.6, 0, -2.4, 2.2],
      [7.9, 0, 1.4, 0.2], [9.0, 0, 2.4, 0.9],
    ]);
    /* Tyre wall: an arc of spare wheels behind the machine. Two rows, the top
       one offset half a wheel, which is how a real one is stacked and is also
       what stops it reading as a dotted line. */
    const tyres = [];
    for (let row = 0; row < 2; row++) {
      const n = row ? 9 : 10;
      for (let i = 0; i < n; i++) {
        const a = -2.35 + (i / (n - 1)) * 1.5 + (row ? 0.075 : 0);
        const r = 9.6;
        tyres.push([Math.cos(a) * r, row * 0.60, Math.sin(a) * r, a + Math.PI / 2, 1]);
      }
    }
    place(spareWheelGeo(P, 37), tyres);
    // floodlights
    place(poleGeo(P, 53, 8.0, 2), [[-8.6, 0, 3.4, 0.9], [8.4, 0, 2.2, -0.9]]);

    /* Bunting. wireGeo bakes its endpoints into the geometry, so these cannot
       be instanced — one little mesh is the honest cost of a sagging line
       between two poles.

       THERE USED TO BE THREE SPANS, AND THE MIDDLE ONE RAN POLE TO POLE at
       y = 2.5: a bright line straight across the window at exactly the height
       the roll cage lives. It went with the canopy it was tied to. What is
       left is the one span from the left floodlight down to the surviving
       canopy, out at the window's edge, which says paddock without drawing on
       the machine. */
    const wireCol = P.canvasAlt;
    const spans = [
      [-8.6, 7.2, 3.4, -8.8, 2.5, -1.2],
    ];
    for (const s of spans) {
      const g = wireGeo(wireCol, s[0], s[1], s[2], s[3], s[4], s[5], 0.9, 10, 0.05);
      const m = new THREE.Mesh(g, this.dressMat);
      m.castShadow = false;                 // a shadow-casting wire is acne
      m.frustumCulled = false;
      this.group.add(m);
      this._dress.push(m);
    }
  }

  _dropVehicle() {
    /* The contact shadow goes FIRST and unconditionally: it is built inside
       setVehicle's try, so a machine whose build threw half-way can leave one
       behind with no this.vehicle to hang it off. */
    if (this.contact) {
      if (this.contact.parent) this.contact.parent.remove(this.contact);
      this.contact.geometry.dispose();
      if (this.contact.material.map) this.contact.material.map.dispose();
      this.contact.material.dispose();
      this.contact = null;
    }
    if (!this.vehicle) return;
    try { this.vehicle.dispose(); } catch { /* already gone */ }
    if (this.vehicle.root && this.vehicle.root.parent) {
      this.vehicle.root.parent.remove(this.vehicle.root);
    }
    this.vehicle = null;
  }

  /* ---------------- the DOM half ----------------
     `#hero` is the layer between the WebGL canvas and the screens. When the
     3D is live it must be transparent (the scene IS the backdrop); when it is
     not, it carries the key art, or the CSS gradient that stands in for art
     nobody has. */
  _syncDom() {
    const kind = this.kind;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('menu3d', this._live && !!kind);
      /* The main menu is a POSTER: one painting, full bleed, with the logo,
         the career strip and the buttons over its dark left third. styles.css
         hangs the plate opt-out and the heavier scrim off this class, so the
         other menu screens keep the layer exactly as it was. */
      document.body.classList.toggle('hero-poster', kind === 'main');
    }
    if (!this.elArt) return;
    /* Only the DOM path shows art. THREE SOURCES, in order, and every step
       down is a normal install rather than a failure: `art/menu-hero` is the
       wasteland key art painted for this screen; `art/title` is the older
       clean-buggy plate and stands in for it; with neither,
       `.hero-art:not(.has-art)` is the gradient that has always been the
       no-assets answer.

       MAIN ONLY. Tracks and garage each carry their own full-bleed backdrop
       inside the screen, so painting a second picture on the layer underneath
       buys nothing and costs a JPEG decode — and until that decode finishes
       you see the WRONG picture through the one that has not painted yet. */
    const get = (!this._live && kind === 'main' && this.assets && this.assets.get)
      ? (id) => this.assets.get(id) : () => null;
    const tex = get('art/menu-hero') || get('art/title');
    const img = tex && tex.image;
    const src = img && img.nodeName === 'IMG' ? img.src : '';
    if (src !== this._artSrc) {
      this._artSrc = src;
      this.elArt.style.backgroundImage = src ? `url("${src}")` : '';
      this.elArt.classList.toggle('has-art', !!src);
    }
  }
}

export default MenuScene;

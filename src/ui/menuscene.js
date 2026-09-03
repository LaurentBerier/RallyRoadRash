/* ============================================================
   RALLY ROAD RASH — THE LIVE MENU BACKDROP
   ------------------------------------------------------------
   Contract: docs/ARCHITECTURE.md §6.8.
     show(kind, {trackId, vehicleId, profile}) · setTrack() · setVehicle() ·
     update(dt, elapsed) · hide() · dispose() · sky · resultsBurst(vfx, pos)

   What the menu used to be: a black plate of text over `main.js idle()`
   orbiting an EMPTY scene. Nothing was in it. This puts the selected machine
   on a lit pad under the selected stage's sky, with enough paddock furniture
   around it to read as somewhere, and turns it slowly.

   WHY A PAD AND NOT THE WORLD (the same argument dev/garage.js makes): baking
   a 2 km circuit so the main menu has a backdrop costs four seconds of load
   for a picture the plate covers half of. A disc, a sky and one car cost
   nothing and are 90 % of the read.

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
const _v = new THREE.Vector3();
const _dummy = new THREE.Object3D();

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
    this.art = null;                  // the key-art billboard, when there is one

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

    /* The dolly. A slow arc rather than a full orbit: the plate owns the left
       46 % of the screen, so the machine has to stay in the right half or it
       spends half its life behind the text. */
    const a = -0.62 + Math.sin(this._t * 0.085) * 0.34;
    const R = 8.4 + Math.sin(this._t * 0.055) * 0.9;
    const h = 2.35 + Math.sin(this._t * 0.11) * 0.28;
    cam.position.set(Math.sin(a) * R, h, Math.cos(a) * R);
    // aim off-centre so the car sits right-of-frame, clear of the plate
    cam.lookAt(-1.05, 0.85, 0);

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

    if (this.art) this.art.rotation.y = Math.atan2(cam.position.x - this.art.position.x,
      cam.position.z - this.art.position.z);
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
    this._makeArt();

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
    this.art = null;
    this.dressMat = null;
  }

  _keepGeo(g) { this._geo.push(g); return g; }
  _keepMat(m) { this._mat.push(m); return m; }
  _keepTex(t) { this._tex.push(t); return t; }

  /* ---------------- the pad ---------------- */
  _makePad() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#5f584e'; g.fillRect(0, 0, 256, 256);
    // a faint grid, so ride height and the car's shadow have something to read
    // against; a plain flat disc reads as a hole
    g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 2;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,.05)';
    g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
    const tex = this._keepTex(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(PAD_R * 2, PAD_R * 2);          // one square per metre
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(
      this._keepGeo(new THREE.CircleGeometry(PAD_R, 56).rotateX(-Math.PI / 2)),
      this._keepMat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0 })));
    mesh.receiveShadow = true;
    this.group.add(mesh);
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
  }

  /* ---------------- key art billboard ----------------
     `assets.get('art/title')` is null on a normal install (ARCHITECTURE
     §6.11), and then there is simply no plane: the sky IS the backdrop, which
     is what the scene looked like before this existed. */
  _makeArt() {
    const tex = this.assets && this.assets.get ? this.assets.get('art/title') : null;
    if (!tex) return;
    const W = 22, H = W * 9 / 16;
    const mat = this._keepMat(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.72, depthWrite: false, toneMapped: false,
    }));
    const m = new THREE.Mesh(this._keepGeo(new THREE.PlaneGeometry(W, H)), mat);
    m.position.set(0, H * 0.45 + 1.2, -17);
    m.renderOrder = -1;          // behind the pad and the machine, in front of the sky
    this.group.add(m);
    this.art = m;
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

    // canopies, off to one side so the plate never covers them both
    place(canopyGeo(P, 11), [[-6.2, 0, -3.4, 0.5], [5.9, 0, -4.6, -0.7]]);
    // crates under the canopies
    place(crateGeo(P, 23), [
      [-5.2, 0, -2.0, 0.3], [-6.6, 0, -1.4, 1.1], [5.2, 0, -3.3, 0.2],
      [6.7, 0, -3.9, 0.9], [-4.4, 0, -4.6, 2.2],
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
       be instanced — three little meshes is the honest cost of a sagging line
       between two poles. */
    const wireCol = P.canvasAlt;
    const spans = [
      [-8.6, 7.2, 3.4, -6.2, 2.5, -3.4],
      [-6.2, 2.5, -3.4, 5.9, 2.5, -4.6],
      [5.9, 2.5, -4.6, 8.4, 7.2, 2.2],
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
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('menu3d', this._live && !!this.kind);
    }
    if (!this.elArt) return;
    // Only the DOM path shows art; when the scene is live the billboard does.
    const tex = (!this._live && this.kind && this.assets && this.assets.get)
      ? this.assets.get('art/title') : null;
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

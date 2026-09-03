/* ============================================================
   THE LIVE ARSENAL — pickups on the road, rockets in the air, effects
   ------------------------------------------------------------
   src/game/weapons.js is the table and the ammo rules and is pure. This is
   the half that owns three.js objects, runs every frame and touches the
   cars. Race constructs it, steps it, and disposes it. It replaced
   itemworld.js in wave 8 and kept its bones: the siting search, the
   arc-length bucket, the pad layer, the one-writer multipliers and the
   read-only view the AI gets are all the same machinery with a smaller
   roster in front of it.

   SEVEN DECISIONS WORTH KNOWING BEFORE CHANGING ANYTHING HERE
   -----------------------------------------------------------

   1. NO NEW SPATIAL STRUCTURE. Forty pickups and eight rockets against six
      cars is at most 300 squared-distance tests a frame. resolveVehiclePair
      already does 135 with square roots in it. A grid here would be
      machinery bought to solve a problem that cannot occur, and props.js's
      CSR broadphase is built once and cannot take a moving object anyway.

   2. PICKUPS ARE TRIGGERS, NOT COLLIDERS. Nothing here goes into
      props.colliders. A solid crate would bounce cars off it, which is the
      exact opposite of a pickup.

   3. ONE WRITER PER FIELD. Every effect is recomputed from scratch each
      frame into `v.extDriveMul` / `v.extTopMul` (weapons.effectMuls), so
      effects can never accumulate and a missed clear cannot leave a car
      permanently fast. `v.spinT` is likewise only ever written here, with
      `max` rather than `+=`. The mini-turbo owns its own multipliers
      separately and Vehicle.step composes the two. The four arsenal
      publications on the Vehicle (contract 8.1) are mirrored from the pure
      state every frame — this file is the truth, the Vehicle is the copy.

   4. EVERY PER-RACER FIELD IS DECLARED UP FRONT in `_makeState`. race.js
      has two lazily-created timers (`lavaT`, `wedgeT`) that no reset path
      clears, and a restart inherits them. That is the bug this shape exists
      to avoid.

   5. EFFECTS ARE WRITTEN BEFORE THE CARS STEP. `step()` runs immediately
      before Race._stepVehicles, so a hit landed this frame is felt this
      frame. Pickup and rocket tests run against last frame's positions —
      at 39 m/s that is 65 cm against a 2 m trigger radius, which nobody
      can perceive and which buys a whole frame of latency back.

   6. BOOST PADS ARE TRACK FURNITURE, NOT A WEAPON. They are chevrons
      painted on the road; a stage that has them has them whatever the
      WEAPONS setting says, and a lap time set with weapons off has to be
      comparable with one set with them on. `step()` is therefore split
      into a weapon layer gated on `enabled` and a pad layer that is not,
      `_hideAll` leaves the pads alone, and the pad meshes live in their
      own group so hiding the weapon group cannot take them with it.

   7. THE PICKUP LAYER COSTS SIX DRAW CALLS, AND THAT IS NOT vfx.js's THREE.
      Crate, can, halo, beacon, and one billboard mesh per glyph — six, up
      from three, all InstancedMeshes on the arsenal's own group. world/vfx.js
      has a separate and much harder budget of exactly three (one Points pool,
      one ribbon mesh, one ring InstancedMesh) and NOTHING here is charged
      against it: the explosion added to that file adds no fourth call, and
      these six add nothing to that file. Do not conflate the two ledgers.
      A seventh here would want a real argument; a fourth there is refused.

   THE NITRO CAN IS NOT INVENTORY. It fires the instant a car drives
   through it. There is no `fire()` path for it, no HUD slot, no AI
   decision — the only decision is the line you take, and the can sits
   where a good line goes (see sitePickups).
   ============================================================ */
import * as THREE from 'three';
import { G, TUNE } from './config.js';
import { DUST_KIND } from '../world/dust.js';
import { boostPadGeo, kitPalette } from '../world/kit.js';
import { rocketCrateGeo, nitroCanGeo, rocketGeo, beaconGeo } from '../world/kit-arsenal.js';
/* The HUD's own glyphs, rasterised ONCE at load into two textures (see
   _iconTex). Reaching from game/ into ui/ for artwork is a layering
   compromise and it is a deliberate one: the alternative is a second
   hand-drawn rocket and a second hand-drawn can that drift out of step with
   the HUD's, and the whole point of the marker is that it means the same
   thing as the icon on the HUD chip. */
import { iconCanvas } from '../ui/icons.js';
import {
  PICKUP, PICKUPS, makeArsenal, resetArsenal, addAmmo, canFire, spend,
  giveNitro, giveSlow, hitSpin, tick, effectMuls,
} from './weapons.js';
import { sitePickups, CRATE_HOVER, CAN_HOVER } from './arsenal-sites.js';
import { clamp } from '../core/rng.js';

const W = TUNE.weapons;
const N = TUNE.nitro;

const MAX_PROJ = 8;
const PICK_R = 1.9;              // m — pickup trigger radius
const PICK_Y = 1.9;              // m — and how far below it you may be
const CRATE_SPIN = 0.9;          // rad/s — a crate turns like a sign, not a top
const CAN_SPIN = 2.2;
const BOB = 0.12;                // m of hover travel
const POP_T = 0.2;               // s to shrink away when collected
const IN_T = 0.4;                // s to scale back in on respawn
const HALO_R = 2.2;              // m — the flat additive disc under each pickup
const HALO_A = 0.5;              // …and its opacity
const EMIT_LO = 0.30, EMIT_HI = 0.85;   // crate emissive pulse
const CAN_EMIT_LO = 0.9, CAN_EMIT_HI = 1.7;   // the can pulses past the bloom threshold

/* ---------------- reading a pickup from 150 m ----------------
   A crate is 1.0 x 0.56 x 0.62 m and a can is Ø0.38 x 0.78. At 150 m and
   40 m/s — which is where a player has to make the decision to go for one —
   those are a few pixels each, and no emissive pulse turns a few pixels into
   a landmark. Three things fix that, and only one of them is the model:

     • SCALE, as an instance multiplier and NOT as a change to the geometry.
       kit-check gates the crate at 0.8–1.3 m and the pickup trigger radius
       PICK_R is 1.9 m; both of those are statements about the SIM, and the
       moment the drawn size is the same number as the collected size, making
       the marker bigger silently makes the pickup easier to take.
     • A VERTICAL. A column reads at any range because the horizon it stands
       against is horizontal (kit-arsenal.js beaconGeo).
     • A SCREEN-SPACE ICON, which is the only one of the three whose size in
       pixels does not depend on how far away it is at all. */
const CRATE_SCALE = 1.5;
const CAN_SCALE = 1.4;
const BEACON_H = 6.0;            // m — kept in step with kit-arsenal.js
/* The instance tint is pushed past 1 so the foot of the column clears the
   bloom threshold, the same trick the can's emissive pulse uses. It is only
   1.2 rather than the can's 1.7 because the material is DoubleSide and
   additive: the far wall of a 5 cm tube adds through the near one, so the
   core of the column is already twice whatever this says. */
const BEACON_TINT = 1.2;
/* The marker plane. `ICON_M` is its size in metres, which is what it draws at
   up close; `ICON_PX_K` is the ANGULAR floor underneath that — metres of
   height per metre of distance — and the larger of the two wins. A 60° vertical
   FOV on a 1080-line buffer puts one metre at 150 m at about 6 px, so a fixed
   1.1 m plane would be a smudge exactly where the marker matters most; 0.026
   holds it at roughly 24 px from any distance and hands the near field back to
   the metres. Inside ICON_FAR the plane starts shrinking and by ICON_NEAR it is
   gone — a billboard in your face at the moment of collection is worse than no
   billboard at all. */
const ICON_M = 1.1;              // m
const ICON_PX_K = 0.026;         // m of height per m of distance
/* Derived from the column rather than typed, so the marker always caps it:
   the baked gradient is down to a tenth of its brightness by about two thirds
   of the way up, and that is where the eye stops following the beacon and
   wants something to land on. */
const ICON_Y = BEACON_H * 0.60;  // m above the pickup, before its own half-height
const ICON_NEAR = 10, ICON_FAR = 15;   // m — the fade-out window

/* ---------------- boost pads (contract 6.1 `pads[]`) ---------------- */
const PAD_HW = 1.6, PAD_LEN = 4, PAD_MUL = 1.6, PAD_TOP = 1.10, PAD_TIME = 1.2;
/* Re-trigger lockout for THE SAME pad, on top of that pad's own boost time.
   Per-pad rather than per-car on purpose: a car parked on a pad must not
   farm it for ever, but an authored CHAIN of pads has to chain — a blanket
   per-car cooldown would silently eat every pad but the first. */
const PAD_CD = 0.35;
const PAD_GEO_HW = 1.6;          // kit.js boostPadGeo: W 3.2 => half-width 1.6
const PAD_GEO_LEN = 4.0;         // …and LEN 4.0. Instances scale from these.

/* ---------------- what the AI is allowed to see ----------------
   A DANGER radius, not a collision radius: what the dodge wants to know is
   how wide to go, and a rocket's 0.45 m hitbox plus a car's 1.2 m is the
   distance at which it actually matters. */
const THREAT_R_PROJ = 1.8;
const THREAT_PROJ = 0;           // `kind`

/* ---------------- siting ----------------
   arsenal-sites.js decides where everything goes; this file only needs the
   arc-length bucket over its sorted output. */
const BUCKET = 10;               // m per entry in the arc-length lookup

/* ---------------- rockets ---------------- */
/* kit-arsenal.js's rocketGeo stands on its fins at y = 0 with its axis this
   far up; the instance is lowered by it so the body flies where the sim
   says the rocket is. Kept in step with the FIN/R numbers there. */
const ROCKET_AXIS_Y = (0.09 + 0.10) * Math.SQRT1_2;
const ROCKET_GROUND = 0.25;      // m above the ground at which a rocket goes off
/* props.resolve() ignores Y entirely, so a rocket lobbed three metres over
   a boulder would explode on thin air — far more visible than clipping a
   barrier. Props are only tested while the rocket is low enough to
   plausibly be hitting one. */
const PROP_LOW = 2.2;
const FLYBY_D = 7;               // m — a rival's rocket passing this close hisses
const SMOKE_D = 160;             // m — beyond this the trail is a ribbon only
const ROCKET_SPIN = 18;          // rad/s of visual roll in flight
const SCORCH_Y = 3.0;            // m above the ground within which a blast marks it

/* ---------------- module scratch — nothing below allocates ---------------- */
const _dummy = new THREE.Object3D();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _mz = new THREE.Vector3();          // muzzle position
const _dir = new THREE.Vector3();
const _imp = new THREE.Vector3();         // blast impulse direction (unit)
const _arm = new THREE.Vector3();         // …and the arm it acts at
const _zAxis = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();
const _pp = { x: 0, y: 0, z: 0 };
const _dd = { x: 0, z: 0 };
const _mul = { drive: 1, top: 1 };
/* A vehicle-shaped probe for props.resolve(): it reads pos, vel and
   collideR and pushes pos out of anything solid. Moved pos = contact. */
const _probe = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), collideR: W.radius };
let _gain = 0, _pan = 0;                  // _hear() outputs

export class Arsenal {
  /**
   * @param o.scene, o.terrain, o.trackData, o.dust, o.audio, o.feel, o.engine
   * @param o.props    world/props.js, for rocket-vs-prop contact; optional
   * @param o.racers   the live racer rows (read: id, isPlayer, vehicle, pos)
   * @param o.rng      the SEEDED race stream (unused here — siting has its
   *                   own stream off the track seed so it cannot perturb
   *                   the grid draw, and the AI's rolls stay comparable)
   * @param o.seed     the track seed; siting is a pure function of it
   * @param o.enabled  the WEAPONS setting
   * @param o.vfx      world/vfx.js, or null. EVERY call site is guarded.
   */
  constructor(o) {
    this.scene = o.scene;
    this.terrain = o.terrain;
    this.data = o.trackData;
    this.spline = this.data.spline;
    this.dust = o.dust;
    this.audio = o.audio;
    this.feel = o.feel;
    this.engine = o.engine;
    this.props = o.props || null;
    /* Contract 6.2. Built in main.js buildWorld and threaded in by Race; null
       on any path that does not build a world. Guarded at every call, never
       cached into a local. */
    this.vfx = o.vfx || null;
    this.racers = o.racers;
    this.enabled = o.enabled !== false;
    this.theme = (this.data.def && this.data.def.theme) || 'training';
    const seed = o.seed !== undefined ? (o.seed | 0)
      : ((this.data.def && this.data.def.seed) | 0);

    this.lapLength = this.data.lapLength || this.spline.length;

    this.group = new THREE.Group();
    this.scene.add(this.group);
    /* Pads are not part of the weapon group: `_hideAll` hides that one, and
       a stage's boost pads have to survive the WEAPONS setting being off. */
    this.padGroup = new THREE.Group();
    this.scene.add(this.padGroup);
    this._geo = [];
    this._mat = [];
    this._tex = [];

    /* Contract 6.7 shape, kept — plain scalars, bumped by a sequence number
       so a reader can tell "a new one" from "the same one still". race.js
       copies these into the HUD payload; the AI may read them; nobody
       writes them but us. `hitItem` / `pickItem` / `fireItem` carry a
       PICKUP id now (a hit is always PICKUP.ROCKET). */
    this.events = {
      hitSeq: 0, hitTarget: -1, hitOwner: -1, hitItem: -1,
      pickSeq: 0, pickRacer: -1, pickItem: -1,
      padSeq: 0, padRacer: -1,
      fireSeq: 0, fireRacer: -1, fireItem: -1, fireNear: false,
      noteSeq: 0, noteText: '',
    };
    /* Cooldown on the RACK FULL / OUT OF ROCKETS notes, so a row of crates
       or a held key does not produce eight identical log lines. */
    this._noteCd = 0;

    /* Per-racer state. Every field declared here, cleared by _clearState. */
    this.st = [];
    this.playerIdx = -1;
    for (let i = 0; i < this.racers.length; i++) {
      this.st.push(this._makeState(this.racers[i]));
      if (this.racers[i].isPlayer) this.playerIdx = i;
    }

    /* Per-racer nearest() output. Sharing module scratch between six callers
       is the documented bug in ai.js — each racer gets its own. */
    this._near = [];
    for (let i = 0; i < this.racers.length; i++) {
      this._near.push({ s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 });
    }

    this.stats = { fired: 0, hits: 0, taken: 0 };
    this.tracker = o.tracker || null;

    this._buildPickups(seed);
    this._buildPads();
    this._buildRockets();
    this._time = 0;
    for (let i = 0; i < this.st.length; i++) this._publish(i);
    if (!this.enabled) this._hideAll();
  }

  _makeState(r) {
    const spec = r.vehicle && r.vehicle.spec;
    return {
      ars: makeArsenal(spec ? spec.id : null),
      // boost pads — declared here like everything else (decision 4)
      padT: 0, padCd: 0, padMul: 1, padTop: 1, padLast: -1,
      flameOn: 0,             // 1 while a vfx flame is lit for this racer
      /* Contract 8.3: the HUD's "this is new" edges, per racer, so a rival's
         pickup never bumps the player's banner. */
      pickupSeq: 0, pickupKind: PICKUP.NONE, fireSeq: 0,
    };
  }

  _clearState(s) {
    resetArsenal(s.ars);
    s.padT = 0; s.padCd = 0; s.padMul = 1; s.padTop = 1; s.padLast = -1;
    s.flameOn = 0;
    s.pickupSeq = 0; s.pickupKind = PICKUP.NONE; s.fireSeq = 0;
  }

  /* ============================================================
     1.  PICKUPS
     ============================================================ */
  _buildPickups(seed) {
    const P = kitPalette(this.theme);
    const S = sitePickups(this.data, this.terrain, seed);
    const n = S.n;
    this.nPick = n;
    this.pickKind = S.kind;
    this.pickX = S.x; this.pickY = S.y; this.pickZ = S.z;
    this.pickS = S.s;
    /* Kept because `nearestPickup` answers in LATERAL terms — the AI steers
       by offset, and re-deriving a lateral from a world point would need a
       second spline.nearest() per query. */
    this.pickLat = S.lat;
    this.pickT = new Float32Array(n);        // > 0 = collected, counting back
    /* Which instance of which mesh: crates and cans are two InstancedMeshes
       (two geometries), the halo is one over both. */
    this.pickInst = new Int16Array(n);
    let nC = 0, nN = 0;
    for (let i = 0; i < n; i++) this.pickInst[i] = S.kind[i] === PICKUP.ROCKET ? nC++ : nN++;
    this.nCrate = nC; this.nCan = nN;

    /* Arc-length lookup: s -> first pickup index at or after it. One
       Int16Array and the trigger test becomes "check the handful of pickups
       near where this car is", which is how racecore tests checkpoints. */
    const L = this.lapLength;
    const nb = Math.max(1, Math.ceil(L / BUCKET));
    this.bucket = new Int16Array(nb);
    let bi = 0;
    for (let b = 0; b < nb; b++) {
      const s = b * BUCKET;
      while (bi < n - 1 && this.pickS[bi] < s) bi++;
      this.bucket[b] = bi;
    }

    this.crateMesh = null; this.canMesh = null; this.halo = null;
    this.crateMat = null; this.canMat = null;
    this.beacon = null; this.crateIcon = null; this.canIcon = null;
    if (!n) return;

    if (nC) {
      const geo = this._keepGeo(rocketCrateGeo(P, 149));
      this.crateMat = this._keepMat(new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.55, metalness: 0.15,
        emissive: 0xffd23f, emissiveIntensity: EMIT_LO,
      }));
      const im = new THREE.InstancedMesh(geo, this.crateMat, nC);
      im.castShadow = true; im.frustumCulled = false;
      this.group.add(im);
      this.crateMesh = im;
    }
    if (nN) {
      const geo = this._keepGeo(nitroCanGeo(P, 151));
      /* Pulsed past the bloom threshold at the peak — the same trick the
         boost pads use, and the reason they read at range. The can is the
         one pickup you want to SEE from the previous corner. */
      this.canMat = this._keepMat(new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.35, metalness: 0.20,
        emissive: 0xff8a1a, emissiveIntensity: CAN_EMIT_LO,
      }));
      const im = new THREE.InstancedMesh(geo, this.canMat, nN);
      im.castShadow = true; im.frustumCulled = false;
      this.group.add(im);
      this.canMesh = im;
    }

    /* A flat additive disc on the ground under each pickup, in the pickup's
       own colour. It is what makes a ROW of crates read as a row from 150 m,
       rather than four small boxes that resolve into anything at all only
       once you are on top of them. */
    const hgeo = this._keepGeo(new THREE.CircleGeometry(HALO_R, 18));
    hgeo.rotateX(-Math.PI / 2);
    const hmat = this._keepMat(new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: HALO_A,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const halo = new THREE.InstancedMesh(hgeo, hmat, n);
    halo.frustumCulled = false; halo.renderOrder = 2;
    for (let i = 0; i < n; i++) {
      _col.setHex(PICKUPS[S.kind[i]].col);
      halo.setColorAt(i, _col);
    }
    if (halo.instanceColor) halo.instanceColor.needsUpdate = true;
    this.group.add(halo);
    this.halo = halo;

    /* The beacon. ONE InstancedMesh over both kinds, exactly as the halo is:
       the white-to-black gradient is baked into the geometry's vertex colours
       and the per-instance tint multiplies against it, so the crate's yellow
       and the can's orange come out of the same draw call and each fades to
       nothing at the top on its own. Additive and depthWrite off, because a
       column of light that occludes the road behind it is a post. */
    const bgeo = this._keepGeo(beaconGeo(P, 163));
    const bmat = this._keepMat(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      toneMapped: false, fog: false,
    }));
    const bm = new THREE.InstancedMesh(bgeo, bmat, n);
    bm.frustumCulled = false; bm.renderOrder = 3; bm.castShadow = false;
    for (let i = 0; i < n; i++) {
      const c = PICKUPS[S.kind[i]].col;
      _col.setRGB(((c >> 16) & 255) / 255 * BEACON_TINT,
        ((c >> 8) & 255) / 255 * BEACON_TINT, (c & 255) / 255 * BEACON_TINT);
      bm.setColorAt(i, _col);
    }
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    this.group.add(bm);
    this.beacon = bm;

    /* The screen-space markers. Two meshes because they are two textures, and
       two textures because they are two glyphs — a shared atlas would buy one
       draw call at the price of a uv attribute per instance, which is not a
       trade worth making for a pair. Null on any build without a DOM: the
       glyphs are rasterised on a 2D canvas and every use of them below is
       guarded, so a headless Arsenal simply has no markers. */
    const igeo = this._keepGeo(new THREE.PlaneGeometry(1, 1));
    if (nC) this.crateIcon = this._iconMesh(igeo, 'rocket', PICKUPS[PICKUP.ROCKET].col, nC);
    if (nN) this.canIcon = this._iconMesh(igeo, 'nitro', PICKUPS[PICKUP.NITRO].col, nN);
  }

  /**
   * One billboard marker mesh, or null when the glyph cannot be drawn. The
   * canvas is rasterised ONCE here and never again — icons.js paints into a
   * 2D context, which is far too expensive to do per frame and completely
   * free to do at load.
   */
  _iconMesh(geo, name, col, count) {
    if (typeof document === 'undefined') return null;
    let cv = null;
    try { cv = iconCanvas(name, 64, '#' + (col & 0xffffff).toString(16).padStart(6, '0')); }
    catch (e) { void e; return null; }
    if (!cv) return null;
    const tex = this._keepTex(new THREE.CanvasTexture(cv));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = this._keepMat(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false,
    }));
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.frustumCulled = false; im.renderOrder = 4; im.castShadow = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(im);
    return im;
  }

  /* ============================================================
     1b. BOOST PADS
     ------------------------------------------------------------
     Pure track data (contract 6.1 `pads[]`), which is why there is no
     placement search here and no seeded RNG: a pad is authored, a crate is
     scattered. `x/y/z/dx/dz` are published by buildTrackData, but they are
     derived from `s`/`lat` and this module can derive them too — so a
     track that only carries the authored half still works.
     ============================================================ */
  _buildPads() {
    const src = this.data.pads || [];
    const n = src.length;
    this.nPad = n;
    this.padS = new Float32Array(n);
    this.padLat = new Float32Array(n);
    this.padX = new Float32Array(n);
    this.padY = new Float32Array(n);
    this.padZ = new Float32Array(n);
    this.padDX = new Float32Array(n);
    this.padDZ = new Float32Array(n);
    this.padHW = new Float32Array(n);
    this.padLen = new Float32Array(n);
    this.padMul = new Float32Array(n);
    this.padTop = new Float32Array(n);
    this.padTime = new Float32Array(n);
    this.padHit = new Float32Array(n);      // s of "just fired" glow left
    if (!n) { this.padMesh = null; return; }

    for (let i = 0; i < n; i++) {
      const p = src[i];
      const s = this.spline.wrapS(p.s || 0);
      const lat = p.lat || 0;
      this.padS[i] = s;
      this.padLat[i] = lat;
      let x = p.x, z = p.z;
      if (!(Number.isFinite(x) && Number.isFinite(z))) {
        const q = this.spline.offsetPoint(s, lat, _pp);
        x = q.x; z = q.z;
      }
      let dx = p.dx, dz = p.dz;
      if (!(Number.isFinite(dx) && Number.isFinite(dz))) {
        const d = this.spline.dirAt(s, _dd);
        dx = d.x; dz = d.z;
      }
      this.padX[i] = x;
      this.padZ[i] = z;
      // sit ON the road, not in it: the same 6 cm lift the finish stripe uses
      this.padY[i] = this.terrain.heightAt(x, z) + 0.05;
      this.padDX[i] = dx; this.padDZ[i] = dz;
      this.padHW[i] = p.hw > 0 ? p.hw : PAD_HW;
      this.padLen[i] = p.len > 0 ? p.len : PAD_LEN;
      this.padMul[i] = p.mul > 0 ? p.mul : PAD_MUL;
      this.padTop[i] = p.top > 0 ? p.top : PAD_TOP;
      this.padTime[i] = p.time > 0 ? p.time : PAD_TIME;
    }

    const P = kitPalette(this.theme);
    const geo = this._keepGeo(boostPadGeo(P, 157));
    /* Emissive on the shared material rather than per-instance colour: one
       material, one draw call, and the pulse is a single uniform write. */
    this.padMat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.45, metalness: 0.20,
      emissive: 0x3a1c00, emissiveIntensity: 1.0,
    }));
    const im = new THREE.InstancedMesh(geo, this.padMat, n);
    im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false;
    this.padGroup.add(im);
    this.padMesh = im;

    for (let i = 0; i < n; i++) {
      _dummy.position.set(this.padX[i], this.padY[i], this.padZ[i]);
      _dummy.rotation.set(0, Math.atan2(this.padDX[i], this.padDZ[i]), 0);
      _dummy.scale.set(this.padHW[i] / PAD_GEO_HW, 1, this.padLen[i] / PAD_GEO_LEN);
      _dummy.updateMatrix();
      im.setMatrixAt(i, _dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
  }

  /* ============================================================
     2.  THE ROCKET POOL
     ============================================================ */
  _buildRockets() {
    const P = kitPalette(this.theme);
    this.pX = new Float32Array(MAX_PROJ); this.pY = new Float32Array(MAX_PROJ);
    this.pZ = new Float32Array(MAX_PROJ);
    this.pVX = new Float32Array(MAX_PROJ); this.pVY = new Float32Array(MAX_PROJ);
    this.pVZ = new Float32Array(MAX_PROJ);
    this.pLife = new Float32Array(MAX_PROJ);
    this.pAge = new Float32Array(MAX_PROJ);
    this.pArm = new Float32Array(MAX_PROJ);
    this.pOwner = new Int8Array(MAX_PROJ).fill(-1);
    this.pFly = new Int8Array(MAX_PROJ);     // 1 once the flyby hiss has played

    const geo = this._keepGeo(rocketGeo(P, 153));
    const mat = this._keepMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.45, metalness: 0.30,
      emissive: 0xff6a2a, emissiveIntensity: 0.35,
    }));
    const im = new THREE.InstancedMesh(geo, mat, MAX_PROJ);
    im.castShadow = true; im.frustumCulled = false;
    this.group.add(im);
    this.projMesh = im;
    for (let i = 0; i < MAX_PROJ; i++) this._killProj(i);
  }

  _keepGeo(g) { this._geo.push(g); return g; }
  _keepMat(m) { this._mat.push(m); return m; }
  _keepTex(t) { this._tex.push(t); return t; }

  /* ============================================================
     3.  THE FRAME
     ============================================================ */
  /**
   * Simulation. Called from Race.update immediately BEFORE _stepVehicles, so
   * everything written here is felt by the cars in the same frame.
   * @param live true only while the race is actually running
   */
  step(dt, live) {
    this._time += dt;
    if (this._noteCd > 0) this._noteCd -= dt;

    /* ONE spline.nearest() per racer per frame, feeding BOTH the pickup
       trigger and the pad trigger. It has to happen out here rather than
       inside _stepPickups because the pads run with the weapon layer off. */
    const wantNear = live && (this.enabled || this.nPad > 0);
    if (wantNear) {
      for (let i = 0; i < this.racers.length; i++) {
        const v = this.racers[i].vehicle;
        this.spline.nearest(v.pos.x, v.pos.z, this._near[i]);
      }
    }

    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i], s = this.st[i], a = s.ars;

      if (this.enabled) {
        tick(a, dt);
        /* The nitro's whole visible half: a tier-3 flame off the exhaust
           for as long as it burns, and the post-fx envelope for the player.
           Both are edge-safe — flame(…, 0) fades the ribbon out, and the
           envelope decays on its own once it is handed a zero. */
        const burning = a.nitroT > 0;
        if (burning) {
          this._flame(i, r.vehicle, 1);
          if (this.dust && this._camNear(r.vehicle, 120)) {
            const v = r.vehicle, f = v.forward;
            this.dust.spawn(2, v.pos.x - f.x * 1.7, v.pos.y - 0.1, v.pos.z - f.z * 1.7,
              3.4, 0.30, -f.x, -f.z, 1.0, 0.5, 0.18, DUST_KIND.EMBER);
          }
        } else if (s.flameOn) this._flame(i, r.vehicle, 0);
        if (r.isPlayer && this.feel && this.feel.nitro) {
          // ramps out over the last third of a second, so the screen lets go
          // before the shove does rather than the other way round
          this.feel.nitro(burning ? (a.nitroT < 0.35 ? a.nitroT / 0.35 : 1) : 0);
        }
      }

      // --- the pad layer, whatever the WEAPONS setting says ---
      if (s.padCd > 0) s.padCd -= dt;
      if (s.padT > 0) { s.padT -= dt; if (s.padT < 0) s.padT = 0; }
      if (live && this.nPad) this._stepPads(i);

      this._applyMuls(i);
      this._publish(i);
    }

    if (!live || !this.enabled) return;
    this._stepPickups(dt);
    this._stepProjectiles(dt);
  }

  /**
   * The one writer for `extDriveMul` / `extTopMul` — recomputed from scratch
   * so an effect can never accumulate (decision 3). Pads compose with the
   * nitro rather than replacing it: a nitro over a pad is exactly as silly
   * as it sounds and exactly as rare.
   */
  _applyMuls(i) {
    const s = this.st[i], v = this.racers[i].vehicle;
    let fm = 1, tm = 1;
    if (this.enabled) {
      effectMuls(s.ars, _mul);
      fm *= _mul.drive; tm *= _mul.top;
    }
    if (s.padT > 0) { fm *= s.padMul; tm *= s.padTop; }
    v.extDriveMul = fm;
    v.extTopMul = tm;
  }

  /** Contract 8.1: the four publications, mirrored from the pure state. */
  _publish(i) {
    const a = this.st[i].ars, v = this.racers[i].vehicle;
    v.ammo = this.enabled ? a.ammo : 0;
    v.ammoCap = a.ammoCap;
    v.nitroT = a.nitroT;
    v.reloadT = a.reloadT;
  }

  /**
   * Boost-pad trigger for one racer, off the arc length / lateral already
   * computed this frame. No distance test, no collider: a pad is a span of
   * road, and "am I on that span, within that many metres of its lat" is
   * exactly the same O(1) question the checkpoint test asks.
   */
  _stepPads(ri) {
    const r = this.racers[ri], s = this.st[ri], v = r.vehicle;
    if (r.finished) return;
    if (v.airborne) return;                       // a pad you fly over is scenery
    const near = this._near[ri];
    const L = this.lapLength;
    for (let i = 0; i < this.nPad; i++) {
      if (i === s.padLast && s.padCd > 0) continue;
      let d = near.s - this.padS[i];
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < -this.padLen[i] * 0.5 || d > this.padLen[i] * 0.5) continue;
      const dl = near.lat - this.padLat[i];
      if (dl < -this.padHW[i] || dl > this.padHW[i]) continue;
      s.padT = this.padTime[i];
      s.padMul = this.padMul[i];
      s.padTop = this.padTop[i];
      s.padLast = i;
      s.padCd = this.padTime[i] + PAD_CD;
      this.padHit[i] = 0.35;
      this.events.padSeq++;
      this.events.padRacer = ri;
      if (r.isPlayer) {
        this.audio.boostFire(2, 0.9);
        if (this.feel) { this.feel.kick(TUNE.boost.fireFov[1]); this.feel.addShake(0.16); }
      } else if (this._camNear(v, 70)) this.audio.boostFire(2, 0.35);
      if (this.vfx) {
        this.vfx.padFlash(this.padX[i], this.padY[i] + 0.05, this.padZ[i],
          this.padDX[i], this.padDZ[i]);
      }
      if (this.dust) {
        const f = v.forward;
        this.dust.spawn(3, v.pos.x - f.x * 1.5, v.pos.y - 0.12, v.pos.z - f.z * 1.5,
          3.2, 0.30, -f.x, -f.z, 1.0, 0.62, 0.20, DUST_KIND.EMBER);
      }
      return;                                     // one pad per frame per car
    }
  }

  _stepPickups(dt) {
    for (let i = 0; i < this.nPick; i++) {
      if (this.pickT[i] > 0) { this.pickT[i] -= dt; if (this.pickT[i] < 0) this.pickT[i] = 0; }
    }
    if (!this.nPick) return;

    for (let ri = 0; ri < this.racers.length; ri++) {
      const r = this.racers[ri], s = this.st[ri], v = r.vehicle;
      if (r.finished) continue;
      const near = this._near[ri];               // filled once, up in step()
      const b0 = this.bucket[clamp(Math.floor(near.s / BUCKET), 0, this.bucket.length - 1)];
      /* The bucket points at the first pickup at or after this arc length;
         a car can be just past one, so look one entry back as well as
         forward — and a row is up to five wide, so look far enough forward
         to cover a whole row plus a can behind it. */
      for (let k = -1; k <= 6; k++) {
        const bi = b0 + k;
        if (bi < 0 || bi >= this.nPick || this.pickT[bi] > 0) continue;
        const dx = v.pos.x - this.pickX[bi], dz = v.pos.z - this.pickZ[bi];
        if (dx * dx + dz * dz > PICK_R * PICK_R) continue;
        const dy = v.pos.y - this.pickY[bi];
        if (dy * dy > PICK_Y * PICK_Y) continue;
        if (this.pickKind[bi] === PICKUP.ROCKET) {
          if (s.ars.ammo >= s.ars.ammoCap) {
            /* Driving through a crate with a full rack does nothing, and
               the game should say why — otherwise the crates read as
               broken. Player only, rate-limited: a nudge, not a nag. */
            if (r.isPlayer && this._noteCd <= 0) {
              this._noteCd = 2.0;
              this.events.noteSeq++;
              this.events.noteText = NOTE_RACK_FULL;
            }
            continue;
          }
          this._collectCrate(ri, bi);
        } else {
          this._collectCan(ri, bi);
        }
        break;
      }
    }
  }

  _collectCrate(ri, bi) {
    const r = this.racers[ri], s = this.st[ri];
    const def = PICKUPS[PICKUP.ROCKET];
    addAmmo(s.ars, def.ammo);
    this.pickT[bi] = def.respawn;
    this.stats.taken++;
    s.pickupSeq++; s.pickupKind = PICKUP.ROCKET;
    this.events.pickSeq++;
    this.events.pickRacer = ri;
    this.events.pickItem = PICKUP.ROCKET;
    const A = this.audio;
    if (r.isPlayer) {
      if (A.ammoPickup) A.ammoPickup(); else if (A.ui) A.ui('ok');
    } else if (A.crateBreak && this._hear(this.pickX[bi], this.pickY[bi], this.pickZ[bi], 80)) {
      A.crateBreak(_gain);
    }
    this._pickupPop(bi, def.col, 14);
  }

  _collectCan(ri, bi) {
    const s = this.st[ri];
    const def = PICKUPS[PICKUP.NITRO];
    this.pickT[bi] = def.respawn;
    this.stats.taken++;
    s.pickupSeq++; s.pickupKind = PICKUP.NITRO;
    this.events.pickSeq++;
    this.events.pickRacer = ri;
    this.events.pickItem = PICKUP.NITRO;
    this._pickupPop(bi, def.col, 22);
    this._boost(ri);
  }

  /** The pickup goes with a burst in its own colour — "I got THAT". */
  _pickupPop(bi, col, sparks) {
    const x = this.pickX[bi], y = this.pickY[bi], z = this.pickZ[bi];
    if (this.dust) this.dust.burst(x, this.terrain.heightAt(x, z), z, 0, 0.8, CRATE_POP);
    if (this.vfx) {
      this.vfx.sparks(sparks, x, y + 0.4, z, 0, 1, 0, 5.0, 1.0,
        ((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 0.55);
    }
  }

  /**
   * The nitro. The can was driven through, so the burn starts NOW — through
   * the same two multipliers the mini-turbo uses (weapons.effectMuls), the
   * same FOV kick and shake the tier-3 release gets, and a flame the sled
   * used to have. There is no decision anywhere in this path.
   */
  _boost(ri) {
    const s = this.st[ri], r = this.racers[ri], v = r.vehicle;
    giveNitro(s.ars);
    const A = this.audio;
    if (r.isPlayer) {
      if (A.nitroPickup) A.nitroPickup();
      if (A.nitroBurst) A.nitroBurst(); else A.boostFire(3, 1);
      if (this.feel) { this.feel.kick(N.fov); this.feel.addShake(N.shake); }
    } else if (this._camNear(v, W.fireHearD)) {
      A.boostFire(3, 0.35);
    }
    this._flame(ri, v, 1);
    if (this.dust) {
      const f = v.forward;
      this.dust.spawn(5, v.pos.x - f.x * 1.6, v.pos.y - 0.15, v.pos.z - f.z * 1.6,
        3.0, 0.32, -f.x, -f.z, 1.0, 0.55, 0.16, DUST_KIND.EMBER);
    }
  }

  /** Light or douse a racer's exhaust plume. Ribbon slots 8-13, via flame(). */
  _flame(ri, v, on) {
    const s = this.st[ri];
    if (!this.vfx) { s.flameOn = on ? 1 : 0; return; }
    const f = v.forward;
    this.vfx.flame(ri, on, v.pos.x - f.x * 1.8, v.pos.y - 0.05, v.pos.z - f.z * 1.8,
      -f.x, 0.12, -f.z, 3);
    s.flameOn = on ? 1 : 0;
  }

  /* ---------------- rockets ---------------- */
  _stepProjectiles(dt) {
    const player = this.playerIdx >= 0 ? this.racers[this.playerIdx].vehicle : null;
    for (let i = 0; i < MAX_PROJ; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      this.pAge[i] += dt;
      if (this.pArm[i] > 0) this.pArm[i] -= dt;
      // A rocket that found nothing simply ends; a bang at the far end of
      // nowhere would splash whoever happened to be there.
      if (this.pLife[i] <= 0) { this._killProj(i); continue; }

      /* Flat for the first `straightT`, then a fraction of gravity: what
         makes "aim at the car" the right instruction out to 70 m and still
         puts the shot on the road rather than in orbit (config.js). */
      if (this.pAge[i] > W.straightT) this.pVY[i] -= W.dropG * G * dt;
      this.pX[i] += this.pVX[i] * dt;
      this.pY[i] += this.pVY[i] * dt;
      this.pZ[i] += this.pVZ[i] * dt;
      const x = this.pX[i], y = this.pY[i], z = this.pZ[i];

      /* Contract 6.2 reserves ribbon slots 0-7 for projectiles, which is
         exactly MAX_PROJ — so the pool index IS the slot and there is no
         allocation table to keep in step. The smoke is dust, not a new
         system (vfx.js says so in its own header). */
      if (this.vfx) {
        const rb = this.vfx.ribbon(i);
        if (rb) rb.push(x, y, z);
      }
      if (this.dust && this._hear(x, y, z, SMOKE_D)) {
        this.dust.spawn(1, x, y, z, 0.5, 0.22, 0, 0, 0.34, 0.32, 0.30, DUST_KIND.PUFF);
      }

      // versus the ground
      const gy = this.terrain.heightAt(x, z);
      if (y <= gy + ROCKET_GROUND) {
        this.pY[i] = gy + ROCKET_GROUND;
        this._explode(i, -1);
        continue;
      }

      // versus props, only down where a prop can plausibly be
      if (this.props && y - gy < PROP_LOW) {
        _probe.pos.set(x, y, z);
        _probe.vel.set(this.pVX[i], this.pVY[i], this.pVZ[i]);
        this.props.resolve(_probe);
        const mx = _probe.pos.x - x, mz = _probe.pos.z - z;
        if (mx * mx + mz * mz > 1e-6) { this._explode(i, -1); continue; }
      }

      // versus cars
      let hit = -1;
      for (let ri = 0; ri < this.racers.length && hit < 0; ri++) {
        const r = this.racers[ri], v = r.vehicle;
        if (r.finished || v.ghost) continue;
        if (ri === this.pOwner[i] && this.pArm[i] > 0) continue;
        const dx = v.pos.x - x, dy = v.pos.y - y, dz = v.pos.z - z;
        const R = (v.collRadius || 1.2) + W.radius;
        if (dx * dx + dy * dy + dz * dz <= R * R) hit = ri;
      }
      if (hit >= 0) { this._explode(i, hit); continue; }

      /* A rival's rocket going past the cockpit. Once per rocket, and only
         when it is somebody else's — your own leaving the tube is the
         launch cue. */
      if (player && !this.pFly[i] && this.pOwner[i] !== this.playerIdx) {
        const dx = player.pos.x - x, dz = player.pos.z - z;
        if (dx * dx + dz * dz < FLYBY_D * FLYBY_D) {
          this.pFly[i] = 1;
          if (this.audio.rocketFlyby) {
            this.audio.rocketFlyby(clamp(-(dx * player.right.x + dz * player.right.z) / FLYBY_D, -1, 1));
          }
        }
      }
    }
  }

  /**
   * The rocket goes off. `hitRi` is the car it struck, or -1 for ground and
   * scenery. Direct hit: the full spin plus the drive cut. Anyone else
   * inside the launcher's splash radius: half of both. The owner is spared
   * only while the rocket is still armed — after that, a shot into the
   * ground three metres ahead is a shot into the ground three metres ahead.
   */
  _explode(i, hitRi) {
    const x = this.pX[i], y = this.pY[i], z = this.pZ[i];
    const owner = this.pOwner[i];
    const splash = owner >= 0 ? this.st[owner].ars.splash : 3.2;
    const vx = this.pVX[i], vz = this.pVZ[i];

    /* The ring reads at any distance and the sparks read close up, which
       is the same split racefx uses for a heavy contact; the dark puff is
       what makes it an impact rather than a firework. `fireball` is the body
       of the thing — three staggered layers plus its own front — and it lives
       in vfx.js so it stays inside that file's three-draw-call budget. */
    if (this.vfx) {
      this.vfx.shock(x, y, z, splash, 1.0, 0.62, 0.22);
      if (this.vfx.fireball) this.vfx.fireball(x, y, z, splash);
      /* 14, down from 26. `fireball` throws sixteen of its own and the pool
         is 400 particles at the LOW tier, shared with every tyre on the grid
         — past the cap a spark is silently dropped, so an over-ask does not
         cost a frame, it costs somebody else's effect. */
      this.vfx.sparks(14, x, y + 0.3, z, 0, 1, 0, 11, 1.3, 1.0, 0.72, 0.30, 0.55);
    }
    const gy = this.terrain.heightAt(x, z);
    if (this.dust) {
      this.dust.burst(x, gy, z, Math.atan2(vx, vz), 1.8, ROCKET_POP);
      this.dust.spawn(8, x, y + 0.2, z, 2.6, 1.2, 0, 0, 0.18, 0.16, 0.14, DUST_KIND.PUFF);
    }
    /* A scorch mark, for free. terrain.addTrack is the tyre-mark stamp — a
       quad into an additive top-down buffer, capped at 128 a frame and shared
       with six cars laying rubber — so a short wide segment at the blast point
       is a black smear on the road that outlives the fire and costs one of
       those quads. Only when the blast was actually NEAR the ground: a rocket
       that caught a car mid-jump did not scorch anything, and a burn mark
       under thin air is the kind of detail that reads as a bug the first time
       somebody notices it. */
    if (this.terrain.addTrack && y - gy < SCORCH_Y) {
      this.terrain.addTrack(x - 0.45, z, x + 0.45, z, splash * 0.85, 0.70);
    }
    /* Lane A's dynamic props. Guarded rather than imported: if props.js has
       grown a blast door by the time this runs, vegetation and light debris
       inside the splash go over; if it has not, nothing happens and nothing
       breaks. See the report for the signature this wants. */
    if (this.props && typeof this.props.knockAt === 'function') {
      this.props.knockAt(x, y, z, splash * 1.4, W.launchV);
    }
    const A = this.audio;
    if (this._hear(x, y, z, W.hitHearD)) {
      const near = this._hear(x, y, z, 26);
      if (A.rocketHit) A.rocketHit(_gain, _pan, near);
      else if (A.crash) A.crash(clamp(_gain * 1.6, 0.3, 2.2), _pan);
    }
    this._blastFeel(x, y, z);

    for (let ri = 0; ri < this.racers.length; ri++) {
      const r = this.racers[ri], v = r.vehicle;
      if (r.finished || v.ghost) continue;
      if (ri === owner && this.pArm[i] > 0) continue;
      const direct = ri === hitRi;
      if (!direct) {
        const dx = v.pos.x - x, dy = v.pos.y - y, dz = v.pos.z - z;
        if (dx * dx + dy * dy + dz * dz > splash * splash) continue;
      }
      /* The shove direction: the rocket's own heading for the car it struck,
         outward from the blast for a neighbour. */
      let sx = vx, sz = vz;
      if (!direct) { sx = v.pos.x - x; sz = v.pos.z - z; }
      giveSlow(this.st[ri].ars, direct);
      /* BOTH, and in this order. `_spin` is the handbrake lock: it is what
         makes the LANDING read as a spin-out rather than as a car that simply
         fell over, and it is deferred by Vehicle.step while the car is in the
         air, so it waits for the touchdown the impulse below is about to
         cause. `_launch` is the blast itself. */
      this._spin(ri, hitSpin(direct), sx, sz, owner);
      this._launch(ri, sx, sz, direct);
    }
    this._killProj(i);
  }

  /**
   * The screen's answer to a blast, scaled by how far the PLAYER is from it.
   * Falls off as (1 − d/shakeD)² — squared, so a rocket at half the falloff is
   * a quarter of the response and one going off across the map is nothing at
   * all, which is the difference between a weapon layer that punctuates a race
   * and one that makes the camera feel broken.
   *
   * All three channels come through Feel, which is the single owner of every
   * juice transient (feel.js's own header says so): a shake, a directional
   * kick, and the white pop that `flash` exists for.
   */
  _blastFeel(x, y, z) {
    if (!this.feel || this.playerIdx < 0) return;
    const p = this.racers[this.playerIdx].vehicle;
    const dx = p.pos.x - x, dy = p.pos.y - y, dz = p.pos.z - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(d < W.shakeD)) return;
    const k = 1 - d / W.shakeD, kk = k * k;
    if (this.feel.flash) this.feel.flash(W.flashAmt * kk);
    this.feel.addShake(0.35 * kk);
    // the direction the blast threw the camera: away from it, with the
    // vertical taken down because a pure lift kicks the pitch further than a
    // player can read at 40 m/s
    _v1.set(dx, dy * 0.4, dz);
    if (_v1.lengthSq() > 1e-6) _v1.normalize(); else _v1.set(0, 1, 0);
    this.feel.collision(10 * kk, _v1);
  }

  /**
   * THE BLAST, as a real impulse.
   *
   * Until wave 9 a rocket wrote `spinT` and `omega.y += side * 3.2` and
   * NOTHING ELSE — no vertical, no roll, nothing that made a hit read as an
   * explosion rather than as a slippery patch. This goes through
   * Vehicle.applyImpulse, the one impulse in the codebase that carries the
   * body-frame inertia tensor, which is the entire reason it can do what the
   * yaw kick could not: a car shoved from the FLANK gets a torque about its
   * own long axis and rolls, one shoved from BEHIND gets it about the lateral
   * axis and pitches. That asymmetry is not decoration, it is the information
   * — you can see where you were hit from.
   *
   * TWO CLAMPS, AND THEY ARE INDEPENDENT. applyImpulse's linear term is j/mass
   * and its angular term is I⁻¹(r × n)j, so the arm scales one and not the
   * other:
   *   • Δv is clamped by TUNE.collide.maxDeltaV, the same ceiling a car-on-car
   *     impulse gets, so a point-blank hit cannot fire anyone into orbit.
   *   • Δω is clamped by TUNE.weapons.flipW, by shrinking the arm. Mass
   *     cancels out of the angular response entirely (I ∝ m·k², j ∝ m), so
   *     without this the 245 kg moto would spin four times as fast as the
   *     1680 kg truck off the same shove — not because it is light but because
   *     it is SMALL.
   *
   * @param dirX,dirZ the shove direction in the ground plane: the rocket's own
   *                  heading for the car it struck, outward from the blast for
   *                  a neighbour. Need not be normalised.
   * @param direct    true for the car the rocket actually hit
   */
  _launch(ri, dirX, dirZ, direct) {
    const v = this.racers[ri].vehicle;
    if (!v || typeof v.applyImpulse !== 'function') return;
    const L = Math.hypot(dirX, dirZ);
    const hx = L > 1e-5 ? dirX / L : 0, hz = L > 1e-5 ? dirZ / L : 1;

    // the shove, biased upward: a blast lifts more than it pushes
    _imp.set(hx, W.launchUp, hz).normalize();

    const mass = v.mass > 0 ? v.mass : 1000;
    let dv = W.launchV * (direct ? 1 : W.splashMul);
    if (dv > TUNE.collide.maxDeltaV) dv = TUNE.collide.maxDeltaV;
    const j = mass * dv;

    /* The arm points back toward the blast — the panel that took it. r × n is
       then horizontal and perpendicular to the shove, which is what turns a
       flank hit into roll and a rear hit into pitch. Its length is the sine of
       the shove's elevation, because the horizontal parts of r and n are
       parallel and cancel. */
    const sinUp = _imp.y;
    let arm = W.flipArm;
    const spin = arm * sinUp * j;                 // torque impulse, N·m·s
    /* Worst case over the two horizontal principal axes: whichever of pitch
       and roll this hit happens to load, the answer is at most flipW. */
    const Ib = v.Ibody;
    if (Ib && spin > 1e-6) {
      const Imin = Math.min(Ib.x, Ib.z);
      const w = spin / Imin;
      if (w > W.flipW) arm *= W.flipW / w;
    }
    _arm.set(-hx * arm, 0, -hz * arm);

    v.applyImpulse(_imp, j, _arm);
  }

  _killProj(i) {
    if (this.vfx) {
      const rb = this.vfx.ribbon(i);
      /* fade(), not clear(): the trail should outlive the rocket by the
         width of the impact, which is the whole point of having drawn it. */
      if (rb) rb.fade();
    }
    this.pLife[i] = 0; this.pOwner[i] = -1; this.pAge[i] = 0; this.pFly[i] = 0;
    _dummy.position.set(0, -9999, 0);
    _dummy.quaternion.set(0, 0, 0, 1);
    _dummy.scale.setScalar(0.0001);
    _dummy.updateMatrix();
    this.projMesh.setMatrixAt(i, _dummy.matrix);
    this.projMesh.instanceMatrix.needsUpdate = true;
  }

  /* ============================================================
     4.  EFFECTS
     ============================================================ */
  /**
   * Spin a car out. `spinT` routes through Vehicle.step's handbrake override,
   * so the whole tuned drift path (grip cut, ABS-bypassed rear brake, the
   * spinGuard walk-back) does the work — a hand-rolled spin force would have
   * to re-earn all of it. Never additive: `max`, so two hits in a second are
   * one spin, not two seconds of one.
   */
  _spin(ri, dur, dirX, dirZ, owner) {
    const r = this.racers[ri], v = r.vehicle;
    if (v.spinT >= dur) return;
    v.spinT = dur;
    this.events.hitSeq++;
    this.events.hitTarget = ri;
    this.events.hitOwner = owner === undefined ? -1 : owner;
    this.events.hitItem = PICKUP.ROCKET;
    /* Deliberately above TUNE.assists.yawRateCap so the always-on cap bleeds
       it: a rotation that starts violently and self-limits. The sign comes
       from which side the hit arrived on, so being clipped from the left
       spins you left. */
    const side = (dirX * v.right.x + dirZ * v.right.z) > 0 ? -1 : 1;
    v.omega.y += side * 3.2;
    this.stats.hits++;
    if (r.isPlayer) {
      this.audio.spinOut(1);
      if (this.feel) {
        _v1.copy(v.vel).setY(0);
        if (_v1.lengthSq() > 1e-6) _v1.normalize().negate(); else _v1.set(0, 0, 1);
        this.feel.collision(9, _v1);
      }
    }
    if (this.vfx) {
      this.vfx.sparks(14, v.pos.x, v.pos.y + 0.5, v.pos.z,
        dirX, 0.6, dirZ, 7.5, 1.1, 1.0, 0.66, 0.22, 0.5);
    }
  }

  /* ============================================================
     5.  FIRING
     ============================================================ */
  /**
   * Fire a rocket. F / X / the on-screen FIRE for the player, the AI's
   * latch for a rival; `back` sends it behind (the player holds reverse).
   * @returns true if a rocket left the tube
   */
  fire(ri, back) {
    if (!this.enabled) return false;
    const s = this.st[ri], r = this.racers[ri], a = s.ars;
    if (r.finished) return false;
    if (!canFire(a)) {
      /* An empty rack must SAY so, or the key reads as broken. Only the
         player, only when actually empty (a reload is visible on the HUD),
         and rate-limited against a held key. */
      if (r.isPlayer && a.ammo <= 0 && this._noteCd <= 0) {
        this._noteCd = 0.6;
        if (this.audio.ammoEmpty) this.audio.ammoEmpty();
        this.events.noteSeq++;
        this.events.noteText = NOTE_EMPTY;
      }
      return false;
    }
    const i = this._freeProj();
    if (i < 0) return false;                     // pool full: the rocket stays in the tube
    spend(a);
    this.stats.fired++;
    s.fireSeq++;
    const v = r.vehicle;
    this.events.fireSeq++;
    this.events.fireRacer = ri;
    this.events.fireItem = PICKUP.ROCKET;
    this.events.fireNear = !r.isPlayer && this._camNear(v, W.fireLogD);

    /* Contract 8.2: the muzzle in world space and the way it points, from
       the art if it has mounted the launcher and from the spec or the
       bounding box if not. A rear shot leaves from behind the car at the
       muzzle's height, pitched the same way. */
    const fwd = v.muzzleWorld(_mz);
    if (back) {
      const f = v.forward;
      _dir.set(-fwd.x, fwd.y, -fwd.z);
      const S = v.spec;
      const L = S && S.dims ? S.dims.L : 4;
      _mz.set(v.pos.x - f.x * (L * 0.5 + 0.5), _mz.y, v.pos.z - f.z * (L * 0.5 + 0.5));
    } else {
      _dir.copy(fwd);
    }
    if (_dir.lengthSq() > 1e-8) _dir.normalize(); else _dir.set(0, 0, 1);

    this.pX[i] = _mz.x; this.pY[i] = _mz.y; this.pZ[i] = _mz.z;
    this.pVX[i] = v.vel.x + _dir.x * a.speed;
    this.pVY[i] = v.vel.y + _dir.y * a.speed;
    this.pVZ[i] = v.vel.z + _dir.z * a.speed;
    this.pLife[i] = W.life;
    this.pAge[i] = 0;
    this.pArm[i] = W.arm;
    this.pOwner[i] = ri;
    this.pFly[i] = 0;

    if (this.vfx) {
      const rb = this.vfx.ribbon(i);
      if (rb) { rb.clear(); rb.push(_mz.x, _mz.y, _mz.z, 1.2, 1.0, 0.8); }
      // the muzzle flash: a hot fan out of the tube, and embers back over the roof
      this.vfx.sparks(12, _mz.x, _mz.y, _mz.z, _dir.x, _dir.y + 0.2, _dir.z,
        9, 0.5, 1.4, 0.9, 0.4, 0.22);
    }
    if (this.dust) {
      this.dust.spawn(3, _mz.x - _dir.x * 0.6, _mz.y, _mz.z - _dir.z * 0.6,
        2.4, 0.25, -_dir.x, -_dir.z, 1.0, 0.6, 0.2, DUST_KIND.EMBER);
    }
    const A = this.audio;
    if (r.isPlayer) {
      if (A.rocketFire) A.rocketFire(1, 0); else A.boostFire(1, 0.7);
      if (this.feel) { this.feel.kick(1.2); this.feel.addShake(0.10); }
    } else if (this._hear(_mz.x, _mz.y, _mz.z, W.fireHearD)) {
      if (A.rocketFire) A.rocketFire(_gain, _pan); else A.boostFire(1, _gain * 0.5);
    }
    return true;
  }

  _freeProj() { for (let i = 0; i < MAX_PROJ; i++) if (this.pLife[i] <= 0) return i; return -1; }

  /** Is this car close enough to the camera to be worth hearing? Same
      distance-gating idea as Race._contact: a rival's rocket forty metres
      up the road is information, one at four hundred is noise. */
  _camNear(v, m) {
    if (!this.engine || !this.engine.camera) return false;
    return v.pos.distanceTo(this.engine.camera.position) < m;
  }

  /**
   * Gain and pan for a sound at a world point, against the PLAYER's car —
   * the way racefx.contact does it. Writes the module scalars `_gain` /
   * `_pan` and returns whether it is inside `m` at all.
   */
  _hear(x, y, z, m) {
    const p = this.playerIdx >= 0 ? this.racers[this.playerIdx].vehicle : null;
    if (!p) return false;
    _v2.set(x - p.pos.x, y - p.pos.y, z - p.pos.z);
    const d = _v2.length();
    if (d >= m) return false;
    _gain = clamp(1 - d / m, 0.15, 1);
    _pan = clamp(_v2.dot(p.right) / 22, -1, 1);
    return true;
  }

  /* ============================================================
     6.  PRESENTATION
     ============================================================ */
  updateVisuals(dt, camera) {
    const t = this._time;

    /* Pads first, and OUTSIDE the enabled gate — see decision 6. The pulse
       is one shared uniform rather than per-instance colour: the chevrons
       already carry the direction, all this has to do is breathe. */
    if (this.padMesh) {
      let flash = 0;
      for (let i = 0; i < this.nPad; i++) {
        if (this.padHit[i] > 0) {
          this.padHit[i] -= dt;
          if (this.padHit[i] < 0) this.padHit[i] = 0;
          if (this.padHit[i] > flash) flash = this.padHit[i];
        }
      }
      this.padMat.emissiveIntensity =
        0.85 + 0.45 * Math.sin(t * 3.4) + 2.6 * flash;
    }

    if (!this.enabled) return;

    if (this.nPick) {
      // One pulse per kind: an instanced material has one uniform.
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.0);
      if (this.crateMat) this.crateMat.emissiveIntensity = EMIT_LO + (EMIT_HI - EMIT_LO) * pulse;
      if (this.canMat) this.canMat.emissiveIntensity = CAN_EMIT_LO + (CAN_EMIT_HI - CAN_EMIT_LO) * pulse;
      for (let i = 0; i < this.nPick; i++) {
        const crate = this.pickKind[i] === PICKUP.ROCKET;
        const respawn = crate ? PICKUPS[PICKUP.ROCKET].respawn : PICKUPS[PICKUP.NITRO].respawn;
        const cd = this.pickT[i];
        /* Scale, not a teleport to 0.0001. A pickup that vanishes between
           two frames does not read as "you got that" — it reads as a
           glitch, and the shrink is the only confirmation the world gives. */
        const live = cd <= 0;
        const since = respawn - cd;              // s since it was collected
        let k = 1;
        if (!live) {
          if (since < POP_T) k = 1 - since / POP_T;              // shrink away
          else if (cd < IN_T) k = 1 - cd / IN_T;                 // scale back in
          else k = 0;
        }
        k = Math.max(0.0001, Math.min(1, k));
        const hover = crate ? CRATE_HOVER : CAN_HOVER;
        _dummy.position.set(this.pickX[i],
          this.pickY[i] + (live ? Math.sin(t * 1.8 + i * 1.7) * BOB : 0), this.pickZ[i]);
        _dummy.rotation.set(0, t * (crate ? CRATE_SPIN : CAN_SPIN) + i * 0.9, 0);
        // the collect/respawn envelope TIMES the read-at-range multiplier: the
        // geometry is untouched, so PICK_R and kit-check's gates are untouched
        _dummy.scale.setScalar(k * (crate ? CRATE_SCALE : CAN_SCALE));
        _dummy.updateMatrix();
        (crate ? this.crateMesh : this.canMesh).setMatrixAt(this.pickInst[i], _dummy.matrix);

        if (this.halo) {
          const hk = live ? (0.85 + 0.15 * Math.sin(t * 3.0 + i * 1.3)) : 0.0001;
          _dummy.position.set(this.pickX[i], this.pickY[i] - hover + 0.06, this.pickZ[i]);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.setScalar(hk);
          _dummy.updateMatrix();
          this.halo.setMatrixAt(i, _dummy.matrix);
        }

        /* The beacon rides the same collect/respawn envelope as the pickup —
           it is the pickup's advertisement and it must not outlive it — but
           it does NOT bob, because a column that bobs reads as a mistake
           rather than as a hover. It stands on the road, under the hover. */
        if (this.beacon) {
          _dummy.position.set(this.pickX[i], this.pickY[i] - hover, this.pickZ[i]);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.set(k, k, k);
          _dummy.updateMatrix();
          this.beacon.setMatrixAt(i, _dummy.matrix);
        }

        /* The marker. Camera-facing, and sized so it holds ~24 px however far
           away it is — the angular floor is the whole reason it exists, and
           the metres are only what stops it being enormous in the near field.
           It rides up on its own half-height so a bigger marker never sits
           ON the crate, and it is gone by the time you reach one. */
        const im = crate ? this.crateIcon : this.canIcon;
        if (im && camera) {
          const dx = camera.position.x - this.pickX[i];
          const dy = camera.position.y - this.pickY[i];
          const dz = camera.position.z - this.pickZ[i];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          let sz = ICON_M;
          const need = ICON_PX_K * d;
          if (need > sz) sz = need;
          let fade = (d - ICON_NEAR) / (ICON_FAR - ICON_NEAR);
          fade = fade < 0 ? 0 : (fade > 1 ? 1 : fade);
          sz *= fade * (live ? 1 : k);
          if (sz < 0.0001) sz = 0.0001;
          _dummy.position.set(this.pickX[i], this.pickY[i] + ICON_Y + sz * 0.5, this.pickZ[i]);
          _dummy.quaternion.copy(camera.quaternion);
          _dummy.scale.set(sz, sz, sz);
          _dummy.updateMatrix();
          im.setMatrixAt(this.pickInst[i], _dummy.matrix);
        }
      }
      if (this.crateMesh) this.crateMesh.instanceMatrix.needsUpdate = true;
      if (this.canMesh) this.canMesh.instanceMatrix.needsUpdate = true;
      if (this.halo) this.halo.instanceMatrix.needsUpdate = true;
      if (this.beacon) this.beacon.instanceMatrix.needsUpdate = true;
      if (this.crateIcon) this.crateIcon.instanceMatrix.needsUpdate = true;
      if (this.canIcon) this.canIcon.instanceMatrix.needsUpdate = true;
    }

    /* Rockets point down their velocity and roll about it. The instance is
       dropped by the axis height so the body sits on the sim point. */
    for (let i = 0; i < MAX_PROJ; i++) {
      if (this.pLife[i] <= 0) continue;
      _dir.set(this.pVX[i], this.pVY[i], this.pVZ[i]);
      if (_dir.lengthSq() > 1e-6) _dir.normalize(); else _dir.set(0, 0, 1);
      _dummy.quaternion.setFromUnitVectors(_zAxis, _dir);
      _dummy.position.set(this.pX[i], this.pY[i], this.pZ[i]);
      _dummy.scale.setScalar(1);
      _dummy.rotateZ(t * ROCKET_SPIN);
      // the axis lift, in the rocket's own frame, so it stays under the body at any attitude
      _v1.set(0, -ROCKET_AXIS_Y, 0).applyQuaternion(_dummy.quaternion);
      _dummy.position.add(_v1);
      _dummy.updateMatrix();
      this.projMesh.setMatrixAt(i, _dummy.matrix);
    }
    this.projMesh.instanceMatrix.needsUpdate = true;
  }

  /* ============================================================
     7.  HUD, RESET, TEARDOWN
     ============================================================ */
  /** Fill a pre-allocated payload object (contract 8.3). No allocation;
      the one string is a constant chosen by kind. */
  hudFor(ri, out) {
    const s = this.st[ri], a = s.ars;
    out.enabled = this.enabled;
    out.ammo = this.enabled ? a.ammo : 0;
    out.ammoCap = a.ammoCap;
    out.reloadT = a.reloadT;
    out.nitroT = a.nitroT;
    out.pickupSeq = s.pickupSeq;
    out.pickupKind = s.pickupKind;
    out.pickupText = s.pickupKind >= 0 ? PICKUPS[s.pickupKind].text : '';
    out.fireSeq = s.fireSeq;
    return out;
  }

  /* ============================================================
     6b. THE READ-ONLY VIEW (contract 8.11)
     ------------------------------------------------------------
     Everything below is what a driver is allowed to know. All of it is
     CALLER-OWNED-BUFFER: the AI hands in its own typed arrays and gets them
     filled, so six drivers polling every frame allocate nothing between
     them and none of them can hold a reference into our state.

     Read-only means read-only. Nothing here returns a live object, and no
     path from `ctx.arsenal` reaches a setter.
     ============================================================ */

  /**
   * Live rockets. Nearest-first is NOT guaranteed — the caller filters by
   * its own geometry anyway.
   * @param out { n, x, z, vx, vz, r, kind } of parallel typed arrays
   */
  threats(out) {
    let n = 0;
    const cap = out.x.length;
    if (this.enabled) {
      for (let i = 0; i < MAX_PROJ && n < cap; i++) {
        if (this.pLife[i] <= 0) continue;
        out.x[n] = this.pX[i]; out.z[n] = this.pZ[i];
        out.vx[n] = this.pVX[i]; out.vz[n] = this.pVZ[i];
        out.r[n] = THREAT_R_PROJ; out.kind[n] = THREAT_PROJ; n++;
      }
    }
    out.n = n;
    return out;
  }

  /**
   * Nearest uncollected pickup AHEAD of racer `ri`, as an arc-length
   * distance and the LATERAL the AI would have to hold to take it. Crates
   * come in rows at one `s`, so the row is found first and the lane inside
   * it second — otherwise a car would be sent at whichever crate of the row
   * happened to be built first. `kind` narrows it to one pickup kind; -1 is
   * either.
   */
  nearestPickup(ri, out, kind = -1) {
    out.found = 0; out.dist = -1; out.s = 0; out.lat = 0; out.x = 0; out.z = 0;
    out.kind = PICKUP.NONE;
    if (!this.enabled || !this.nPick) return out;
    const near = this._near[ri], L = this.lapLength;
    let bd = Infinity, bi = -1, bl = Infinity;
    for (let i = 0; i < this.nPick; i++) {
      if (this.pickT[i] > 0) continue;
      if (kind >= 0 && this.pickKind[i] !== kind) continue;
      let d = this.pickS[i] - near.s;
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < 0) continue;
      const dl = Math.abs(this.pickLat[i] - near.lat);
      if (d < bd - 1) { bd = d; bi = i; bl = dl; }
      else if (d <= bd + 1 && dl < bl) { bi = i; bl = dl; if (d < bd) bd = d; }   // same row, 1 m of slop
    }
    if (bi < 0) return out;
    out.found = 1; out.dist = bd; out.s = this.pickS[bi]; out.lat = this.pickLat[bi];
    out.x = this.pickX[bi]; out.z = this.pickZ[bi]; out.kind = this.pickKind[bi];
    return out;
  }

  /** Nearest boost pad ahead of racer `ri`. Same shape as `nearestPickup`. */
  nearestPad(ri, out) {
    out.found = 0; out.dist = -1; out.s = 0; out.lat = 0; out.x = 0; out.z = 0;
    if (!this.nPad) return out;
    const s = this.st[ri];
    // a pad already burning under this car is not a pad to steer at
    if (s.padCd > 0) return out;
    const near = this._near[ri], L = this.lapLength;
    let bd = Infinity, bi = -1;
    for (let i = 0; i < this.nPad; i++) {
      let d = this.padS[i] - near.s;
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      if (d < 0) continue;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return out;
    out.found = 1; out.dist = bd; out.s = this.padS[bi]; out.lat = this.padLat[bi];
    out.x = this.padX[bi]; out.z = this.padZ[bi];
    return out;
  }

  /** Rockets on racer `ri`'s rack. Zero with weapons off, so the AI's
      trigger finger is inert on a purist race without a branch of its own. */
  ammoOf(ri) {
    if (!this.enabled) return 0;
    const s = this.st[ri];
    return s ? s.ars.ammo : 0;
  }

  /**
   * A racer was teleported. Cancel everything that was happening TO them and
   * everything they had in flight — a rocket owned by a car that is no
   * longer where it was is a rocket nobody can read. The AMMO survives:
   * losing it would double-punish a respawn.
   */
  notifyReset(ri) {
    const s = this.st[ri], a = s.ars;
    a.nitroT = 0; a.reloadT = 0; a.slowT = 0;
    /* A pad boost belongs to a piece of road the car is no longer on. The
       cooldown goes too, or a respawn onto a pad would be dead to it. */
    s.padT = 0; s.padCd = 0; s.padMul = 1; s.padTop = 1; s.padLast = -1;
    if (s.flameOn) this._flame(ri, this.racers[ri].vehicle, 0);
    if (ri === this.playerIdx && this.feel && this.feel.nitro) this.feel.nitro(0);
    for (let i = 0; i < MAX_PROJ; i++) if (this.pOwner[i] === ri) this._killProj(i);
    const v = this.racers[ri].vehicle;
    v.extDriveMul = 1; v.extTopMul = 1; v.spinT = 0;
    this._publish(ri);
  }

  /** A restart or a return to the grid: everything, everywhere, gone. */
  resetAll() {
    for (let i = 0; i < this.st.length; i++) {
      if (this.st[i].flameOn) this._flame(i, this.racers[i].vehicle, 0);
      this._clearState(this.st[i]);
      const v = this.racers[i].vehicle;
      v.extDriveMul = 1; v.extTopMul = 1; v.spinT = 0;
      this._publish(i);
    }
    for (let i = 0; i < MAX_PROJ; i++) this._killProj(i);
    this.pickT.fill(0);
    if (this.padHit) this.padHit.fill(0);
    this._noteCd = 0;
    this.stats.fired = 0; this.stats.hits = 0; this.stats.taken = 0;
    const e = this.events;
    e.hitSeq = 0; e.hitTarget = -1; e.hitOwner = -1; e.hitItem = -1;
    e.pickSeq = 0; e.pickRacer = -1; e.pickItem = -1;
    e.padSeq = 0; e.padRacer = -1;
    e.fireSeq = 0; e.fireRacer = -1; e.fireItem = -1; e.fireNear = false;
    if (this.feel && this.feel.nitro) this.feel.nitro(0);
  }

  setEnabled(on) {
    const was = this.enabled;
    this.enabled = !!on;
    if (was && !this.enabled) { this.resetAll(); this._hideAll(); }
    else if (!was && this.enabled) {
      this.group.visible = true;
      for (let i = 0; i < this.st.length; i++) this._publish(i);
    }
  }

  /* Hides the WEAPON group only. `padGroup` is deliberately untouched and the
     multipliers go through _applyMuls, which keeps a live pad boost — a
     stage's boost pads are not a weapon (decision 6). */
  _hideAll() {
    this.group.visible = false;
    for (let i = 0; i < this.st.length; i++) { this._applyMuls(i); this._publish(i); }
  }

  dispose() {
    this.resetAll();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    if (this.padGroup.parent) this.padGroup.parent.remove(this.padGroup);
    this.padGroup.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    for (const t of this._tex) t.dispose();
    this._geo.length = 0; this._mat.length = 0; this._tex.length = 0;
    this.racers = null; this.st.length = 0;
  }
}

/* ---------------- module constants ---------------- */
const CRATE_POP = [0.86, 0.72, 0.30];
const ROCKET_POP = [0.42, 0.36, 0.30];
const NOTE_RACK_FULL = 'RACK FULL — FIRE SOME';
const NOTE_EMPTY = 'OUT OF ROCKETS — FIND A CRATE';

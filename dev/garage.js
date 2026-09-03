/* ============================================================
   MODEL VIEWER — one vehicle, a flat pad, and an orbit.
   ------------------------------------------------------------
   dev/firstlight.html is the integration harness: it bakes a whole track,
   which takes tens of seconds and is the wrong tool entirely when the thing
   you are looking at is 2 m long. This page skips the world: a grey pad, the
   theme lighting, and the vehicle turning on the spot.

       dev/garage.html?veh=moto&livery=2&sky=canyon&lean=0.4&susp=1
       dev/garage.html?veh=redline&boost=1&ghost=1&mud=0.6

     veh      hopper | ridgeback | redline | moto        (default hopper)
     livery   0..4 — which AI colour variant                (default 0)
     sky      training | canyon | forest | volcano         (default training)
     lean     radians of bike bank to hold, for checking the pivot   (default 0)
     susp     1 = cycle the suspension through its travel so the linkage moves
     spin     seconds per revolution of the camera                  (default 14)
     boost    0..1 — pipe flare, driven through the same external drive
              multiplier the item layer writes. 1 = full nitro: the flare
              should be long, wide and blue-white rather than short and orange
     ghost    0..1 — respawn look. 1 = fully ghosted; the panels drop to 42 %
              and every lamp flickers
     mud      0..1 — how filthy. 1 is a lap of TIMBERLINE: the clearcoat
              should die from the sills up
     model    0 | 1 — wear the generated carcass from assets/models when it
              exists (default 1). 0 is the procedural body, which is also
              exactly what a missing file gives you                (default 1)
     ammo     rounds shown on the rack, standing in for the weapons layer's
              v.ammo (0 = empty rack; the rack is built to ammoCap either way)
     env      sky | image | none — the environment-map A/B (§8.5): the
              shader dome (default), the manifest's env/<sky> equirect, or
              no environment at all so the lights answer alone

       dev/garage.html?veh=ridgeback&model=1&ammo=3&ang=90
       dev/garage.html?veh=moto&model=0&env=none

   Physics runs, but on a flat plane with no controls, so the vehicle simply
   sits at static sag — which is the state you want to judge ride height in.
   ============================================================ */
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { Sky, SKY_THEMES } from '../src/world/sky.js';
import { Vehicle } from '../src/game/vehicle.js';
import { VEHICLES, VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { setGhostLook, setMudLook, setCarcassSource } from '../src/game/vehicle-art.js';
import { muzzleLocal } from '../src/game/vehicle-carcass.js';
import { loadAssets, Assets } from '../src/core/assets.js';
import { SURF } from '../src/world/surfaces.js';

const stats = document.getElementById('stats');
const err = document.getElementById('err');
window.addEventListener('error', (e) => { err.textContent += (e.message || e.error) + '\n'; });

const q = new URLSearchParams(location.search);
const num = (k, d) => {
  if (!q.has(k)) return d;
  const v = parseFloat(q.get(k));
  return Number.isFinite(v) ? v : d;
};
const vehId = q.get('veh') || 'hopper';
const skyId = q.get('sky') || 'training';
const livery = (q.get('livery') | 0) || 0;
const holdLean = num('lean', 0);
const cycleSusp = q.get('susp') === '1';
const spinPeriod = num('spin', 14) || 14;
const boost = Math.max(0, Math.min(1, num('boost', 0)));
const ghost = Math.max(0, Math.min(1, num('ghost', 0)));
const mud = Math.max(0, Math.min(1, num('mud', 0)));
/* `ang` pins the camera at a compass bearing in degrees instead of orbiting.
   Screenshot tooling cannot wait out a 14 s revolution, so the four canonical
   views are ang=0 (front), 90 (right), 180 (rear), 270 (left). */
const fixedAngle = q.has('ang') ? num('ang', 0) * Math.PI / 180 : null;
const useModel = q.get('model') !== '0';
const ammo = q.has('ammo') ? Math.max(0, num('ammo', 0) | 0) : null;
const envMode = q.get('env') || 'sky';

/* This page lives in dev/, so the served layout's 'assets/…' is one level
   up from here. Set BEFORE the Vehicle is built: the source is read at
   build time and the load starts there. */
setCarcassSource(useModel ? (id) => '../assets/models/' + id + '-carcass.glb' : null);

/* A pad, not a terrain: the same four methods Vehicle is contracted to use. */
const PAD = {
  heightAt: () => 0,
  normalAt(x, z, e, out) { return out.set(0, 1, 0); },
  surfaceAt: () => SURF.DIRT,
  onRoad: () => 1,
};

const engine = new Engine(document.getElementById('stage'), q.get('q') || 'high');
const sky = new Sky(engine.renderer, engine.scene, engine.quality, skyId);
engine.setLightTheme(SKY_THEMES[skyId] || SKY_THEMES.training);

/* ?env — P1's environment-map A/B. `image` hands the manifest's
   `env/<sky>` equirect to sky.setEnvImage (§8.5); `none` clears the scene
   environment after every sky update so the panels show the lights alone.
   setEnvImage lands with P1's sky.js, so both are guarded and the panel
   says when the call is not there yet rather than throwing. */
let envNote = '';
const hasEnvImage = typeof sky.setEnvImage === 'function';
if (envMode === 'image') {
  if (!hasEnvImage) envNote = 'sky.setEnvImage not landed — showing the shader env';
  else loadAssets('../assets/manifest.json').then((map) => {
    const tex = new Assets(map).get('env/' + skyId);
    if (tex) sky.setEnvImage(tex);
    else envNote = 'env/' + skyId + ' not in the manifest — showing the shader env';
  });
} else if (envMode === 'none' && hasEnvImage) {
  sky.setEnvImage(null);
}

/* Ground: a big disc with a faint grid so ride height and shadow read. */
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6a6258'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);          // one square per metre over a 60 m pad
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
  pad.receiveShadow = true;
  engine.scene.add(pad);
}

const spec = VEHICLE_BY_ID[vehId] || VEHICLES[0];
const veh = new Vehicle(engine.scene, PAD, spec, { livery });
veh.placeAt(0, 0, 0);
setMudLook(veh, mud);
if (ammo != null) veh.ammo = ammo;

/* ---- the triangle census -------------------------------------------------
   Counted at build and again the frame a carcass lands, because nothing
   else changes after the build: the model is merged per material and the
   only thing that moves is a transform. Grouped BY MATERIAL rather than by
   mesh, because that is the axis a budget is actually spent along — "the
   tyres are 2136" is an answer you can act on, "mesh 14 is 534" is not.
   Hidden meshes (the procedural panels under a carcass) are not counted:
   they are not drawn. */
function takeCensus() {
  const by = new Map();
  let meshes = 0, sprites = 0, total = 0, tyreSet = 0;
  veh.root.traverse(o => {
    if (o.isSprite) { sprites++; return; }
    if (!o.isMesh || !o.visible) return;
    meshes++;
    const g = o.geometry;
    const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
    total += t;
    const name = o.material.name || o.material.type;
    by.set(name, (by.get(name) || 0) + t);
  });
  for (const w of veh.wheels) {
    const g = w.hub.geometry;
    tyreSet += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  const lines = [...by].sort((a, b) => b[1] - a[1])
    .map(([k, t]) => `  ${k.padEnd(10)} ${String(Math.round(t)).padStart(5)}`);
  return { meshes, sprites, total, tyreSet, lines };
}
let census = takeCensus(), censusFor = veh.carcass;
/* The muzzle in body space, once: the same number vehicle.js's muzzleWorld
   derives from the published node every shot. */
const muzzleAt = muzzleLocal(spec, new THREE.Vector3(), new THREE.Vector3());

const NO_CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };
let t = 0, last = performance.now(), fps = 0, frames = 0, ft = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  t += dt;

  /* The pipe flare reads `max(driftTier/3, (extDriveMul − 1)/0.9)`, so
     driving the external multiplier exercises exactly the number the item
     layer writes — and, through the max, the mini-turbo path with it. */
  veh.extDriveMul = 1 + 0.9 * boost;
  veh.step(dt, NO_CTL);
  // the weapons layer owns v.ammo in a race; here the query string does
  if (ammo != null) veh.ammo = ammo;
  /* Ride the suspension by hand so the linkage is seen travelling. This writes
     `comp` straight, which the solver will fight next step — that is fine and
     is exactly why it is behind a flag. */
  if (cycleSusp) {
    const s = 0.5 + 0.5 * Math.sin(t * 1.4);
    for (const w of veh.wheels) w.comp = s * spec.suspTravel * 0.92;
    veh.sync();
  }
  veh.updateVisuals(dt);
  // race.js calls this every frame with `v.ghost ? 1 : 0`; so does the garage
  setGhostLook(veh, ghost);
  if (holdLean && veh.leanRoot) veh.leanRoot.rotation.z = holdLean;

  const a = fixedAngle != null ? fixedAngle : t / spinPeriod * Math.PI * 2;
  const R = 3.0 + spec.dims.L * 0.85;
  engine.camera.position.set(Math.cos(a) * R, 1.05 + spec.dims.H * 0.55, Math.sin(a) * R);
  engine.camera.lookAt(0, spec.dims.H * 0.28, 0);
  sky.update(dt, engine.camera);
  if (envMode === 'none') engine.scene.environment = null;
  engine.aimShadow(veh.pos, sky.sunDir);
  engine.render(dt);

  frames++; ft += dt;
  if (ft > 0.5) { fps = frames / ft; frames = 0; ft = 0; }
  if (veh.carcass !== censusFor) { censusFor = veh.carcass; census = takeCensus(); }

  const ci = veh._carcassInfo;
  const carcassLine = !useModel ? 'model off — procedural body'
    : ci ? `carcass ${ci.url.replace(/^.*\//, '')}   ${ci.kept} of ${ci.tris} tris after the wheel strip` +
        `   scale ${ci.fit.s.toFixed(3)}   yaw ${(ci.fit.yaw * 180 / Math.PI).toFixed(0)}°` +
        `   body ${(ci.box.max.z - ci.box.min.z).toFixed(2)}x${(ci.box.max.x - ci.box.min.x).toFixed(2)}x${(ci.box.max.y - ci.box.min.y).toFixed(2)} m`
    : 'carcass: loading, or not shipped — procedural body';
  const muzzleLine = veh._muzzle
    ? `launcher ${spec.launcher.tubes} tube(s)   muzzle (${muzzleAt.x.toFixed(2)}, ${muzzleAt.y.toFixed(2)}, ${muzzleAt.z.toFixed(2)}) body` +
      `   rack ${veh._rackShown < 0 ? 0 : veh._rackShown}/${veh._rack.length}`
    : 'no launcher on this spec';

  stats.textContent =
    `${spec.name}  (${spec.id}, ${spec.bodyStyle})   #${veh.livery === 0 ? spec.number : '—'}  ` +
    `${spec.team || ''}\n` +
    `livery ${livery}   sky ${skyId}   env ${envMode}${envNote ? ' (' + envNote + ')' : ''}   ${fps.toFixed(0)} fps\n` +
    `${spec.mass} kg   ${spec.dims.L}x${spec.dims.W}x${spec.dims.H} m   wheelbase ${(spec.wheelbase.front - spec.wheelbase.rear).toFixed(2)} m\n` +
    `ride ${veh.rideHz.toFixed(2)} Hz   sag ${(veh.sag * 100).toFixed(1)} cm   comHeight ${spec.comHeight} m\n` +
    `boost ${boost.toFixed(2)}   ghost ${ghost.toFixed(2)}   mud ${mud.toFixed(2)}` +
    (veh.leanRoot ? `   bank ${(veh.leanRoot.rotation.z * 180 / Math.PI).toFixed(1)}°` : '') + '\n' +
    `${carcassLine}\n${muzzleLine}\n` +
    `${census.meshes} meshes + ${census.sprites} sprites   ${Math.round(census.total)} tris` +
    `   (tyres ${Math.round(census.tyreSet)}/set, budget 2200)\n` +
    `${census.lines.join('\n')}`;

  requestAnimationFrame(frame);
}
addEventListener('resize', () => engine.resize());
requestAnimationFrame(frame);

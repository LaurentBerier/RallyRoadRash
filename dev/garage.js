/* ============================================================
   MODEL VIEWER — one vehicle, a flat pad, and an orbit.
   ------------------------------------------------------------
   dev/firstlight.html is the integration harness: it bakes a whole track,
   which takes tens of seconds and is the wrong tool entirely when the thing
   you are looking at is 2 m long. This page skips the world: a grey pad, the
   theme lighting, and the vehicle turning on the spot.

       dev/garage.html?veh=moto&livery=2&sky=canyon&lean=0.4&susp=1

     veh      hopper | ridgeback | redline | moto        (default hopper)
     livery   0..4 — which AI colour variant                (default 0)
     sky      training | canyon | forest | volcano         (default training)
     lean     radians of bike bank to hold, for checking the pivot   (default 0)
     susp     1 = cycle the suspension through its travel so the linkage moves
     spin     seconds per revolution of the camera                  (default 14)

   Physics runs, but on a flat plane with no controls, so the vehicle simply
   sits at static sag — which is the state you want to judge ride height in.
   ============================================================ */
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { Sky, SKY_THEMES } from '../src/world/sky.js';
import { Vehicle } from '../src/game/vehicle.js';
import { VEHICLES, VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { SURF } from '../src/world/surfaces.js';

const stats = document.getElementById('stats');
const err = document.getElementById('err');
window.addEventListener('error', (e) => { err.textContent += (e.message || e.error) + '\n'; });

const q = new URLSearchParams(location.search);
const vehId = q.get('veh') || 'hopper';
const skyId = q.get('sky') || 'training';
const livery = (q.get('livery') | 0) || 0;
const holdLean = parseFloat(q.get('lean') || '0') || 0;
const cycleSusp = q.get('susp') === '1';
const spinPeriod = parseFloat(q.get('spin') || '14') || 14;
/* `ang` pins the camera at a compass bearing in degrees instead of orbiting.
   Screenshot tooling cannot wait out a 14 s revolution, so the four canonical
   views are ang=0 (front), 90 (right), 180 (rear), 270 (left). */
const fixedAngle = q.has('ang') ? (parseFloat(q.get('ang')) || 0) * Math.PI / 180 : null;

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

const NO_CTL = { throttle: 0, steer: 0, brake: 0, handbrake: 0 };
let t = 0, last = performance.now(), fps = 0, frames = 0, ft = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  t += dt;

  veh.step(dt, NO_CTL);
  /* Ride the suspension by hand so the linkage is seen travelling. This writes
     `comp` straight, which the solver will fight next step — that is fine and
     is exactly why it is behind a flag. */
  if (cycleSusp) {
    const s = 0.5 + 0.5 * Math.sin(t * 1.4);
    for (const w of veh.wheels) w.comp = s * spec.suspTravel * 0.92;
    veh.sync();
  }
  veh.updateVisuals(dt);
  if (holdLean && veh.leanRoot) veh.leanRoot.rotation.z = holdLean;

  const a = fixedAngle != null ? fixedAngle : t / spinPeriod * Math.PI * 2;
  const R = 3.0 + spec.dims.L * 0.85;
  engine.camera.position.set(Math.cos(a) * R, 1.05 + spec.dims.H * 0.55, Math.sin(a) * R);
  engine.camera.lookAt(0, spec.dims.H * 0.28, 0);
  sky.update(dt, engine.camera);
  engine.aimShadow(veh.pos, sky.sunDir);
  engine.render(dt);

  frames++; ft += dt;
  if (ft > 0.5) { fps = frames / ft; frames = 0; ft = 0; }

  let meshes = 0, tris = 0;
  veh.root.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  stats.textContent =
    `${spec.name}  (${spec.id}, ${spec.bodyStyle})   livery ${livery}   sky ${skyId}   ${fps.toFixed(0)} fps\n` +
    `${spec.mass} kg   ${spec.dims.L}x${spec.dims.W}x${spec.dims.H} m   wheelbase ${(spec.wheelbase.front - spec.wheelbase.rear).toFixed(2)} m\n` +
    `ride ${veh.rideHz.toFixed(2)} Hz   sag ${(veh.sag * 100).toFixed(1)} cm   comHeight ${spec.comHeight} m\n` +
    `${meshes} visible meshes   ${Math.round(tris)} tris` +
    (veh.leanRoot ? `   bank ${(veh.leanRoot.rotation.z * 180 / Math.PI).toFixed(1)}°` : '');

  requestAnimationFrame(frame);
}
addEventListener('resize', () => engine.resize());
requestAnimationFrame(frame);

/* Integrator first-light harness: Wave-1 systems only (no main/ui/camera/ai —
   those are being written in parallel). Drives a vehicle down the track on a
   scripted line with a hand-rolled chase cam. ?track=canyon|forest|volcano|training */
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { bakeTrack, Terrain } from '../src/world/terrain.js';
import { TRACKS } from '../src/world/tracks/index.js';
import { Props } from '../src/world/props.js';
import { Sky, SKY_THEMES } from '../src/world/sky.js';
import { Dust } from '../src/world/dust.js';
import { Vehicle } from '../src/game/vehicle.js';
import { VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { SURFACES } from '../src/world/surfaces.js';

const stats = document.getElementById('stats');
const err = document.getElementById('err');
window.addEventListener('error', (e) => { err.textContent += (e.message || e.error) + '\n'; });

const q = new URLSearchParams(location.search);
const trackId = q.get('track') || 'training';
const vehId = q.get('veh') || 'hopper';

async function boot() {
  const def = TRACKS.find(t => t.id === trackId) || TRACKS[0];
  const engine = new Engine(document.getElementById('stage'), q.get('q') || 'high');

  const gen = bakeTrack(def, (p, m) => { stats.textContent = `bake ${(p * 100) | 0}% ${m || ''}`; });
  const baked = await new Promise((res) => {
    /* Race rAF against a timer and take whichever fires first — the same
       trick main.js uses. A harness driven by an automation tool, or left in
       a background tab, gets rAF at a couple of hertz, and a bake chunked at
       14 ms a frame then takes minutes instead of seconds. */
    const schedule = (fn) => {
      let fired = false;
      const go = () => { if (!fired) { fired = true; fn(); } };
      requestAnimationFrame(go);
      setTimeout(go, 24);
    };
    const pump = () => {
      const budget = document.hidden ? 1e9 : 14;
      const t0 = performance.now();
      let r; do { r = gen.next(); } while (!r.done && performance.now() - t0 < budget);
      if (r.done) res(r.value); else schedule(pump);
    };
    schedule(pump);
  });

  const terrain = new Terrain(engine.renderer, baked, engine.quality, engine.caps, def);
  engine.scene.add(terrain.group);
  const sky = new Sky(engine.renderer, engine.scene, engine.quality, def.theme);
  engine.setLightTheme(SKY_THEMES[def.theme]);
  const props = new Props(engine.scene, terrain, engine.quality, def, terrain.trackData);
  const dust = new Dust(engine.scene, terrain, terrain.uniforms.uSunDir, engine.quality.dust, def.theme);
  dust.setViewport(engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y);

  const veh = new Vehicle(engine.scene, terrain, VEHICLE_BY_ID[vehId]);
  const spline = terrain.spline, line = terrain.trackData.racingLine;
  const g0 = terrain.trackData.gridSlots[0];
  veh.placeAt(g0.x, g0.z, g0.yaw);

  /* Debug handle. Everything the harness built, so a console (or an
     automation tool that cannot wait out a lap) can teleport the car to a
     set piece: FL.at(575) drops it on the caldera leap. */
  window.FL = {
    engine, terrain, props, sky, dust, veh, def, spline,
    at(s, lat = 0) {
      const p = spline.offsetPoint(spline.wrapS(s), lat, {});
      const d = spline.dirAt(spline.wrapS(s), {});
      veh.placeAt(p.x, p.z, Math.atan2(d.x, d.z));
      return veh.pos.clone();
    },
    /* What the dressing pass actually produced, for a quick sanity read. */
    census() {
      const out = {};
      props.group.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry;
        const tris = (g.index ? g.index.count : g.attributes.position.count) / 3
          * (o.isInstancedMesh ? o.count : 1);
        const k = o.isInstancedMesh ? `inst x${o.count}` : 'mesh';
        out[k] = (out[k] || 0) + Math.round(tris);
      });
      return { draws: props.group.children.length, ...out };
    },
  };

  const _out = {}, _v = new THREE.Vector3();
  let elapsed = 0, last = performance.now(), frames = 0, ft = 0, fps = 0;

  function drive() {
    // steer toward the racing-line point ~14 m ahead, throttle to its speed
    const n = spline.nearest(veh.pos.x, veh.pos.z, _out);
    const step = spline.length / line.length;
    const sSteer = (n.s + 7 + veh.speed * 0.35) % spline.length;
    const p = line[Math.round(sSteer / step) % line.length];
    _v.set(p.x - veh.pos.x, 0, p.z - veh.pos.z).normalize();
    const f = veh.forward;
    // positive steer turns toward −X (chassis right); target-right ⇒ cross > 0
    const cross = f.x * _v.z - f.z * _v.x;
    const dot = f.x * _v.x + f.z * _v.z;
    const steer = Math.max(-1, Math.min(1, Math.atan2(cross, Math.max(-1, dot)) * 1.4));
    // brake against the slowest line speed inside the stopping distance
    let want = p.speed;
    const stop = veh.speed * veh.speed / (2 * 7.5) + 8;
    for (let d = 0; d < stop; d += step) {
      const q2 = line[Math.round(((n.s + d) % spline.length) / step) % line.length];
      if (q2.speed < want) want = q2.speed;
    }
    want *= 0.9;
    const throttle = veh.speed < want ? 1 : 0.1;
    const brake = veh.speed > want * 1.12 ? 0.85 : 0;
    return { throttle, steer, brake, handbrake: 0 };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.1) dt = 0.1;
    elapsed += dt;

    const ctl = q.get('orbit') ? { throttle: 0, steer: 0, brake: 1, handbrake: 1 }
      : veh.airborne ? { throttle: 0.5, steer: 0, brake: 0, handbrake: 0 } : drive();
    veh.step(dt, ctl);
    veh.updateVisuals(dt);

    // wheel dust + tyre marks, minimal port of the planned race loop
    for (const w of veh.wheels) {
      if (!w.contact) continue;
      const S = SURFACES[w.surface] || SURFACES[1];
      if ((w.slipLong > 0.25 || w.slipLat > 0.3) && Math.random() < S.dust * 0.5) {
        dust.spawn(1, w.worldPos.x, w.worldPos.y - 0.2, w.worldPos.z,
          0.4 + veh.speed * 0.03, 0.25, -veh.forward.x, -veh.forward.z,
          S.dustCol[0], S.dustCol[1], S.dustCol[2], 0);
      }
    }

    // hand-rolled chase cam (NOT the real rig — that's T8's). ?orbit=1 circles
    // the car slowly instead, for vehicle inspection.
    if (q.get('orbit')) {
      const a = elapsed * 0.45;
      engine.camera.position.set(veh.pos.x + Math.cos(a) * 6.5, veh.pos.y + 2.1, veh.pos.z + Math.sin(a) * 6.5);
      engine.camera.lookAt(veh.pos.x, veh.pos.y + 0.5, veh.pos.z);
    } else {
      const back = _v.copy(veh.forward).multiplyScalar(-8.5);
      engine.camera.position.copy(veh.pos).add(back);
      engine.camera.position.y = Math.max(veh.pos.y + 3.2,
        terrain.heightAt(engine.camera.position.x, engine.camera.position.z) + 1.2);
      engine.camera.lookAt(veh.pos.x + veh.forward.x * 6, veh.pos.y + 1, veh.pos.z + veh.forward.z * 6);
    }

    terrain.update(dt, engine.camera, sky.sunDir);
    sky.update(dt, engine.camera, elapsed);
    props.update(dt, elapsed, engine.camera);
    dust.update(dt);
    engine.aimShadow(veh.pos, sky.sunDir);
    engine.render(dt);

    frames++; ft += dt;
    if (ft > 0.5) { fps = frames / ft; frames = 0; ft = 0; }
    const n = spline.nearest(veh.pos.x, veh.pos.z, _out);
    stats.textContent =
      `track ${def.id}  veh ${vehId}  fps ${fps.toFixed(0)}\n` +
      `speed ${(veh.speed * 3.6).toFixed(0)} km/h  gear ${veh.gear ?? '-'}  rpm ${(veh.rpmNorm ?? 0).toFixed(2)}\n` +
      `s ${n.s.toFixed(0)}/${spline.length.toFixed(0)}  d ${n.d.toFixed(1)}  surf ${SURFACES[veh.surfaceId]?.name}\n` +
      `air ${veh.airborne} ${veh.airTime.toFixed(1)}s  hardHit ${veh.hardHit.toFixed(1)}\n` +
      `drawcalls ${engine.renderer.info.render.calls}  tris ${(engine.renderer.info.render.triangles / 1000).toFixed(0)}k`;
    window.__FL = { veh, terrain, engine, fps, s: n.s, d: n.d };
  }
  requestAnimationFrame(frame);
}

boot().catch(e => { err.textContent += (e.stack || e) + '\n'; });

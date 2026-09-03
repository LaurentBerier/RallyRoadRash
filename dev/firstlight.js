/* Integrator first-light harness: Wave-1 systems only (no main/ui/camera/ai —
   those are being written in parallel). Drives a vehicle down the track on a
   scripted line with a hand-rolled chase cam.
     ?track=canyon|forest|volcano|training|thunder
     ?veh=hopper|ridgeback|redline   ?q=low|medium|high|ultra
     ?orbit=1   slow circle around the car instead of driving
     ?fx=1      run every world/vfx.js effect at once, around the car
     ?env=sky|image|none
                the §8.5 environment-map A/B, on a real stage rather than the
                garage's grey pad. `sky` (default) lights the reflections from
                the physical dome; `image` hands sky.setEnvImage the
                manifest's env/<theme> equirect; `none` drops the environment
                entirely, so what is left on the chrome is the two lights.
                The overlay says which one is actually in force — a missing
                manifest entry falls back to `sky` and says so, because every
                asset in this game is optional and this is what that looks
                like from the outside.
   Console: FL.at(s) teleports, FL.census() counts the dressing,
   FL.frameMs() is the rolling mean frame time. */
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { bakeTrack, Terrain } from '../src/world/terrain.js';
import { TRACKS } from '../src/world/tracks/index.js';
import { Props, setHeroSource } from '../src/world/props.js';
import { Sky, SKY_THEMES } from '../src/world/sky.js';
import { Dust } from '../src/world/dust.js';
import { VFX } from '../src/world/vfx.js';
import { Vehicle } from '../src/game/vehicle.js';
import { VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { SURFACES } from '../src/world/surfaces.js';
import { loadAssets, Assets } from '../src/core/assets.js';

const stats = document.getElementById('stats');
const err = document.getElementById('err');
window.addEventListener('error', (e) => { err.textContent += (e.message || e.error) + '\n'; });

const q = new URLSearchParams(location.search);
const trackId = q.get('track') || 'training';
const vehId = q.get('veh') || 'hopper';
const envMode = q.get('env') || 'sky';
let envNote = '';

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
  // The terrain samples the real shadow map; without this the cars hover.
  engine.attachTerrain(terrain);
  const sky = new Sky(engine.renderer, engine.scene, engine.quality, def.theme);
  engine.setLightTheme(SKY_THEMES[def.theme]);

  /* ?env — the §8.5 A/B. Non-blocking on purpose: the stage is already up
     and racing, and the panorama arriving two seconds later is exactly what
     happens in the game. `none` is cleared every frame rather than once,
     because sky.update() rebuilds the env whenever it is marked dirty. */
  if (envMode === 'image') {
    loadAssets('../assets/manifest.json').then((map) => {
      /* The hero GLBs go through the manifest too, so their urls come out
         based on '../assets/' and resolve from dev/ rather than against this
         page. Set before the env texture below because it is the same map. */
      const A = new Assets(map);
      setHeroSource((key) => A.url(key));
      const tex = new Assets(map).get('env/' + def.theme);
      if (tex) { sky.setEnvImage(tex); envNote = 'image'; }
      else envNote = 'no env/' + def.theme + ' in the manifest — shader env';
    });
  }
  const props = new Props(engine.scene, terrain, engine.quality, def, terrain.trackData);
  const dust = new Dust(engine.scene, terrain, terrain.uniforms.uSunDir, engine.quality.dust, def.theme);
  const vfx = new VFX(engine.scene, dust, engine.quality, def.theme);
  props.setVfx(vfx, dust);
  const viewH = engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  dust.setViewport(viewH);
  vfx.setViewport(viewH);

  const veh = new Vehicle(engine.scene, terrain, VEHICLE_BY_ID[vehId]);
  const spline = terrain.spline, line = terrain.trackData.racingLine;
  const g0 = terrain.trackData.gridSlots[0];
  veh.placeAt(g0.x, g0.z, g0.yaw);

  /* Debug handle. Everything the harness built, so a console (or an
     automation tool that cannot wait out a lap) can teleport the car to a
     set piece: FL.at(575) drops it on the caldera leap. */
  window.FL = {
    engine, terrain, props, sky, dust, vfx, veh, def, spline,
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
    /* Rolling mean frame time in ms. `fps` on the overlay is a half-second
       bucket and it bounces around; this is the number to read when you are
       deciding whether a change cost anything. */
    frameMs() { return ftMean * 1000; },
  };

  const _out = {}, _v = new THREE.Vector3();
  let elapsed = 0, last = performance.now(), frames = 0, ft = 0, fps = 0;
  let ftMean = 1 / 60;

  /* ---------------- ?fx=1 : the VFX exerciser ----------------
     Everything world/vfx.js can do, on a loop, around the car: two ribbons
     chasing it, a flame on every racer slot, sparks off the wheels, a shock
     ring and a pad flash on a timer, and confetti every few seconds. The
     point is to see all three draw calls under load at once — sparks alone
     always look fine, and it is the ribbon-plus-ring-plus-pool frame that
     tells you whether the budget holds. */
  const fxOn = q.get('fx') === '1';
  let fxT = 0, fxSeq = 0;
  function exerciseVfx(dt) {
    fxT += dt;
    const p = veh.pos, f = veh.forward, r = veh.right;
    // two projectile trails orbiting the car
    for (let i = 0; i < 2; i++) {
      const a = fxT * (2.4 + i * 0.7) + i * Math.PI;
      vfx.ribbon(i).push(
        p.x + Math.cos(a) * 5.5, p.y + 1.4 + Math.sin(fxT * 3 + i) * 0.8, p.z + Math.sin(a) * 5.5,
        i ? 1.7 : 0.5, i ? 0.5 : 1.2, i ? 0.4 : 1.8);
    }
    // six flames, cycling tier so all three colours are on screen
    for (let ri = 0; ri < 6; ri++) {
      const a = fxT * 0.8 + ri * 1.047;
      vfx.flame(ri, 0.5 + 0.5 * Math.sin(fxT * 2 + ri),
        p.x + Math.cos(a) * (3 + ri), p.y + 0.6, p.z + Math.sin(a) * (3 + ri),
        -Math.cos(a), 0.2, -Math.sin(a), (ri % 3) + 1);
    }
    // sparks off whichever wheels are on the ground
    for (const w of veh.wheels) {
      if (!w.contact || Math.random() > 0.30) continue;
      vfx.sparks(2, w.worldPos.x, w.worldPos.y, w.worldPos.z,
        -f.x, 0.5, -f.z, 7, 0.7, 1.7, 1.1, 0.45, 0.35);
    }
    if (fxT > 0.9) {
      fxT = 0;
      const k = fxSeq++ % 3;
      if (k === 0) vfx.shock(p.x + r.x * 4, p.y, p.z + r.z * 4, 3.4, 1.5, 0.7, 0.25);
      else if (k === 1) vfx.padFlash(p.x + f.x * 8, terrain.heightAt(p.x + f.x * 8, p.z + f.z * 8),
        p.z + f.z * 8, f.x, f.z);
      else vfx.confetti(30, p.x, p.y + 2.5, p.z, 3.5);
    }
  }

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

    if (fxOn) exerciseVfx(dt);

    terrain.update(dt, engine.camera, sky.sunDir);
    sky.update(dt, engine.camera, elapsed);
    if (envMode === 'none') engine.scene.environment = null;
    props.update(dt, elapsed, engine.camera);
    dust.update(dt);
    vfx.update(dt, engine.camera);
    sky.projectSun(engine.camera, engine.final.uniforms.uSunUV.value);
    engine.aimShadow(veh.pos, sky.sunDir);
    engine.render(dt);

    frames++; ft += dt;
    ftMean = ftMean * 0.92 + dt * 0.08;
    if (ft > 0.5) { fps = frames / ft; frames = 0; ft = 0; }
    const n = spline.nearest(veh.pos.x, veh.pos.z, _out);
    stats.textContent =
      `track ${def.id}  veh ${vehId}  env ${envMode}${envNote ? ' (' + envNote + ')' : ''}\n` +
      `fps ${fps.toFixed(0)}  ${(ftMean * 1000).toFixed(1)} ms\n` +
      `speed ${(veh.speed * 3.6).toFixed(0)} km/h  gear ${veh.gear ?? '-'}  rpm ${(veh.rpmNorm ?? 0).toFixed(2)}\n` +
      `s ${n.s.toFixed(0)}/${spline.length.toFixed(0)}  d ${n.d.toFixed(1)}  surf ${SURFACES[veh.surfaceId]?.name}\n` +
      `air ${veh.airborne} ${veh.airTime.toFixed(1)}s  hardHit ${veh.hardHit.toFixed(1)}\n` +
      `drawcalls ${engine.renderer.info.render.calls}  tris ${(engine.renderer.info.render.triangles / 1000).toFixed(0)}k`;
    window.__FL = { veh, terrain, engine, fps, s: n.s, d: n.d };
  }
  requestAnimationFrame(frame);
}

boot().catch(e => { err.textContent += (e.stack || e) + '\n'; });

/* ============================================================
   RALLY ROAD RASH — sky smoke test
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/sky-check.mjs

   src/world/sky.js went physical in wave 8: the hand-tuned zenith ramp is
   gone and the vendored Preetham dome paints the sky, with the haze and fog
   colours read off the same model in JS. That buys consistency and it costs
   a whole class of failure that a screenshot is bad at catching — a model
   whose output is in the wrong units, a theme whose exposure was never
   re-derived after somebody moved its turbidity, a fog colour that came out
   as NaN because a phase function divided by zero. All of that is arithmetic,
   so all of it belongs here rather than in the integrator's eyes.

   What is asserted, and why each one matters:

     • sunDir is UNCHANGED, to six decimal places, for every theme. This is
       the most important assertion in the file and it is not about the sky at
       all: terrain-bake.js bakes a sun-occlusion mask against these exact
       vectors and main.js hands the same numbers to the shadow camera and to
       the terrain shader. Move one and every shadow on that stage points
       somewhere the light is not — and it will look "a bit off", not broken,
       which is the expensive kind of wrong. The golden table below is a COPY,
       on purpose: it fails if SKY_THEMES is edited, which is the point.

     • every theme carries a complete atmosphere. A missing turbidity silently
       falls back to the vendored default of 2, so the stage renders — as a
       clear noon, whatever it was supposed to be.

     • skyExposure puts the horizon back where the retired ramp had it, within
       ±15 %. The Preetham shader's output is HDR in units nobody chose; this
       is the number that maps them into ours, and the only way to know it is
       still right after a turbidity change is to measure both models and
       divide. Both expressions are evaluated here, in JS, from the same
       theme table the shader reads.

     • the fog colour is finite and inside [0,1] per channel. It is FogExp2's
       colour and the value distant terrain converges to, so a channel over 1
       is a horizon that blows out to white however the tone curve is tuned.

     • setEnvImage(null) really does go back to the shader env, and BOTH env
       paths dispose the render target they replace. A PMREM target is a cube
       mip chain; leaking one per race is how QA's three-race memory check
       finds a hundred megabytes that should not be there.

   No canvas and no WebGL here — sky.js's cloud sprites need a DOM and PMREM
   needs a renderer, so the class is exercised through its own pure functions
   and, where a method is the thing under test, against a stub with only the
   fields that method touches.
   ============================================================ */
import * as THREE from 'three';
import { Sky as VendoredSky } from 'three/addons/objects/Sky.js';
import {
  Sky, SKY_THEMES, HAZE_H, skyParams, skyRadiance, skyBandColor,
  deriveSkyColors, lum3
} from '../src/world/sky.js';

let failures = 0, checks = 0;
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

const THEMES = Object.keys(SKY_THEMES);

/* ============================================================
   1. THE SUN HAS NOT MOVED
   ============================================================
   A hand-copied golden table. Do NOT regenerate it from SKY_THEMES — the
   whole value of it is that it was written down somewhere else. If a stage
   genuinely wants a new sun, the terrain has to be re-baked and this table
   updated in the same commit, deliberately. */
const GOLDEN_SUN = {
  training: [0.359631, 0.882948, 0.301773],
  canyon: [0.723270, 0.469472, -0.506444],
  forest: [-0.435229, 0.374607, 0.818656],
  volcano: [-0.866729, 0.190809, -0.460847],
  thunder: [-0.463692, 0.156434, -0.872076]
};

head('1. SUN DIRECTION — the terrain is baked against these');
{
  ok('a golden entry for every theme', THEMES.every(t => GOLDEN_SUN[t])
    && Object.keys(GOLDEN_SUN).length === THEMES.length,
    `${THEMES.length} themes`);
  for (const name of THEMES) {
    const t = SKY_THEMES[name], g = GOLDEN_SUN[name] || [0, 0, 0];
    const d = [t.sunDir.x, t.sunDir.y, t.sunDir.z];
    // the table is literal six-decimal text, so this is an exact comparison
    const same = d.every((v, i) => Math.abs(v - g[i]) < 5e-7);
    ok(`${name}: sunDir unchanged to 6 dp`, same,
      same ? d.map(v => v.toFixed(6)).join(' ')
        : `table ${d.map(v => v.toFixed(6)).join(' ')} vs golden ${g.map(v => v.toFixed(6)).join(' ')}`);

    /* The published vector is normalize(table), and it always has been, so
       the table only has to be a unit vector to about the precision six
       decimal places can carry. The band is 1e-4 rather than 1e-6 because
       FOREST's x is a transcription slip — -0.435229 where cos(22)cos(118)
       is -0.435286, a 5.7e-5 error, 0.003 of a degree. It is NOT to be
       corrected: terrain-bake.js has already baked forest's sun mask against
       the number that is there, and a 0.003-degree improvement is not worth
       invalidating a bake for. This gate is here to catch a DIGIT, not a
       rounding difference. */
    const n = Math.hypot(d[0], d[1], d[2]);
    ok(`${name}: the table is a unit vector`, Math.abs(n - 1) < 1e-4, `|d|-1 ${f(n - 1, 8)}`);

    /* And it still agrees with the elevation/azimuth the comment claims,
       which catches the other way of getting this wrong: editing one of the
       two and not the other. */
    const el = t.sunEl * Math.PI / 180, az = t.sunAz * Math.PI / 180;
    const want = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const worst = Math.max(...want.map((v, i) => Math.abs(v - d[i])));
    ok(`${name}: matches its own sunEl ${t.sunEl}deg / sunAz ${t.sunAz}deg`, worst < 1e-4,
      `worst delta ${f(worst, 8)}`);
  }
}

/* ============================================================
   2. EVERY THEME BUILDS A COMPLETE PARAMETER SET
   ============================================================ */
head('2. ATMOSPHERE — a complete parameter set per theme');
{
  /* Ranges, not values. turbidity 0 is a vacuum and 100 is soup; a rayleigh
     under 1 makes rayleighCoefficient negative and the extinction blows up;
     mieG at 1 is a division by zero in the Henyey-Greenstein phase. These are
     "did somebody drop a zero" bounds, not a tuning review. */
  const FIELDS = [
    ['turbidity', 0.5, 60],
    ['rayleigh', 1.0, 6],
    ['mie', 0.0005, 0.1],
    ['mieG', 0.1, 0.95],
    ['skyExposure', 0.001, 20]
  ];
  for (const name of THEMES) {
    const t = SKY_THEMES[name];
    const bad = [];
    for (const [k, lo, hi] of FIELDS) {
      const v = t[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) bad.push(`${k}=${v}`);
    }
    ok(`${name}: turbidity/rayleigh/mie/mieG/skyExposure present and sane`, bad.length === 0,
      bad.length ? bad.join(' ') : `T${t.turbidity} R${t.rayleigh} m${t.mie} g${t.mieG} x${t.skyExposure}`);
    // the retired ramp's endpoints are the calibration reference in §3 — they
    // may not paint anything any more, but they may not vanish either
    ok(`${name}: the reference ramp endpoints are still here`,
      typeof t.zenith === 'number' && typeof t.horizon === 'number'
      && typeof t.hazeColor === 'number' && typeof t.groundHaze === 'number');
  }
}

/* ============================================================
   3. skyExposure IS CALIBRATED
   ============================================================
   Both expressions, in JS, at h = HAZE_H, averaged over azimuth — because the
   fog and the terrain haze each get ONE colour for every heading, so the
   number that matters is the average of every heading.

   The reference is the gradient dome exactly as it was before wave 8:

     col = mix(uHorizon, uZenith, pow(clamp(h,0,1), 0.55));
     col = mix(col, uHaze, exp(-abs(h)*7.5) * 0.80);
     col += uSunCol * (pow(s,46)*0.55 + pow(s,6)*0.17) * uHalo;

   with the below-horizon ground blend dropped (it is zero at h > 0) and the
   sun's own halo kept, since the physical side keeps its aureole too. */
const AZ = 64;
function legacyRamp(t, dx, dy, dz, out) {
  const hz = new THREE.Color(t.horizon), zn = new THREE.Color(t.zenith);
  const hazeC = new THREE.Color(t.hazeColor), sc = new THREE.Color(t.sunDiscColor);
  const kz = Math.pow(Math.min(1, Math.max(0, dy)), 0.55);
  const kh = Math.exp(-Math.abs(dy) * 7.5) * 0.80;
  const sd = t.sunDir, sn = Math.hypot(sd.x, sd.y, sd.z) || 1;
  const s = Math.max(0, (dx * sd.x + dy * sd.y + dz * sd.z) / sn);
  const halo = (Math.pow(s, 46) * 0.55 + Math.pow(s, 6) * 0.17) * t.haloStrength;
  const A = [hz.r, hz.g, hz.b], B = [zn.r, zn.g, zn.b];
  const H = [hazeC.r, hazeC.g, hazeC.b], S = [sc.r, sc.g, sc.b];
  for (let i = 0; i < 3; i++) {
    let c = A[i] + (B[i] - A[i]) * kz;
    c = c + (H[i] - c) * kh;
    out[i] = c + S[i] * halo;
  }
  return out;
}
function legacyBandLum(t, h) {
  const ch = Math.sqrt(Math.max(0, 1 - h * h));
  const o = [0, 0, 0];
  let acc = 0;
  for (let i = 0; i < AZ; i++) {
    const a = (i / AZ) * Math.PI * 2;
    legacyRamp(t, Math.cos(a) * ch, h, Math.sin(a) * ch, o);
    acc += lum3(o);
  }
  return acc / AZ;
}

head('3. skyExposure — the horizon lands within +-15 % of the retired ramp');
{
  const BAND = 0.15;
  for (const name of THEMES) {
    const t = SKY_THEMES[name];
    const p = skyParams(name);
    const physL = lum3(skyBandColor(p, HAZE_H, [0, 0, 0]));   // exposure already applied
    const oldL = legacyBandLum(t, HAZE_H);
    ok(`${name}: skyExposure is finite and positive`,
      Number.isFinite(p.exposure) && p.exposure > 0, f(p.exposure));
    const ratio = oldL > 1e-6 ? physL / oldL : Infinity;
    ok(`${name}: horizon luminance ratio inside +-15 %`,
      Number.isFinite(ratio) && Math.abs(ratio - 1) <= BAND,
      `ratio ${f(ratio, 4)}  (physical ${f(physL)} / ramp ${f(oldL)})`);
    if (Math.abs(ratio - 1) > BAND) {
      info(`re-derive it: skyExposure ${f(t.skyExposure)} -> ${f(t.skyExposure / ratio)}`);
    }
  }
}

/* ============================================================
   4. THE DERIVED COLOURS ARE USABLE COLOURS
   ============================================================ */
head('4. DERIVED HAZE / HORIZON / ZENITH');
{
  for (const name of THEMES) {
    const d = deriveSkyColors(SKY_THEMES[name]);
    const finite = (c) => c.length === 3 && c.every(v => Number.isFinite(v));
    const unit = (c) => c.every(v => v >= 0 && v <= 1);
    ok(`${name}: fog colour finite`, finite(d.haze), d.haze.map(v => f(v, 3)).join(' '));
    /* [0,1] per channel, and the reason is FogExp2 and nothing else: this is
       the value distant terrain converges to, so a channel over 1 is a
       horizon that clips to white whatever the tone curve does after it. */
    ok(`${name}: fog colour inside [0,1] per channel`, unit(d.haze),
      `L ${f(lum3(d.haze), 3)}`);
    ok(`${name}: horizon colour finite and in range`, finite(d.horizon) && unit(d.horizon));
    ok(`${name}: zenith colour finite and in range`, finite(d.zenith) && unit(d.zenith),
      d.zenith.map(v => f(v, 3)).join(' '));
    /* The zenith must be DARKER than the horizon. Every clear sky on earth is,
       because the optical path at the horizon is fifty times longer — and a
       theme that comes out the other way round has its parameters inverted. */
    ok(`${name}: zenith is darker than the horizon`,
      lum3(d.zenith) < lum3(d.horizon),
      `zenith ${f(lum3(d.zenith), 3)} < horizon ${f(lum3(d.horizon), 3)}`);
    // haze and horizon are deliberately the SAME number — see §8.5
    ok(`${name}: fog and horizon cannot disagree`,
      d.haze.every((v, i) => v === d.horizon[i]));
  }

  /* And the model has to behave everywhere, not just at the two elevations we
     sample: straight down, straight into the sun, and straight away from it. */
  head('4b. the model is finite in every direction');
  const o = [0, 0, 0];
  for (const name of THEMES) {
    const p = skyParams(name);
    const dirs = [
      ['zenith', [0, 1, 0]], ['nadir', [0, -1, 0]],
      ['at the sun', p.sun], ['away from it', p.sun.map(v => -v)],
      ['on the line', [1, 0, 0]], ['below it', [0.9, -0.44, 0]]
    ];
    let bad = '';
    for (const [lbl, d] of dirs) {
      skyRadiance(p, d[0], d[1], d[2], o);
      if (!o.every(v => Number.isFinite(v) && v >= 0)) bad += ` ${lbl}=${o.join(',')}`;
    }
    ok(`${name}: finite and non-negative in all six directions`, bad === '', bad);
  }
}

/* ============================================================
   5. THE VENDORED SHADER STILL HAS THE SHAPE THE PATCH EXPECTS
   ============================================================ */
head('5. THE SHADER PATCH');
{
  const src = VendoredSky.SkyShader.fragmentShader;
  ok('the vendored solar-disc line is where the patch looks for it',
    src.includes('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;'));
  ok('the vendored output line is where the patch looks for it',
    src.includes('gl_FragColor = vec4( retColor, 1.0 );'));

  /* Build a real dome the way the constructor does, minus everything that
     needs a canvas, and check the patch actually landed. A silent no-op here
     reads as a sky that is simply the wrong brightness, which looks like a
     tuning mistake rather than a failure. */
  for (const name of THEMES) {
    const t = SKY_THEMES[name];
    const s = Object.create(Sky.prototype);
    s.theme = t;
    s.skyModel = skyParams(name);
    s.sunDir = new THREE.Vector3(t.sunDir.x, t.sunDir.y, t.sunDir.z).normalize();
    s.group = new THREE.Group();
    s._buildSkyDome();
    const m = s.skyMesh.material;
    const u = m.uniforms;
    ok(`${name}: exposure uniform patched in`,
      m.fragmentShader.includes('uniform float uSkyExposure')
      && m.fragmentShader.includes('retColor * uSkyExposure'));
    ok(`${name}: the second sun is gone`, !m.fragmentShader.includes('19000.0'));
    ok(`${name}: the shader gets the theme's own atmosphere`,
      u.turbidity.value === t.turbidity && u.rayleigh.value === t.rayleigh
      && u.mieCoefficient.value === t.mie && u.mieDirectionalG.value === t.mieG
      && u.uSkyExposure.value === t.skyExposure);
    /* sunPosition is fed the UNIT direction, which is what pins vSunfade at 1
       and the output gamma at 1/2.4 — the JS port assumes both. */
    ok(`${name}: sunPosition is the unit sun direction`,
      Math.abs(u.sunPosition.value.length() - 1) < 1e-6
      && u.sunPosition.value.distanceTo(s.sunDir) < 1e-9);
    ok(`${name}: it is a background fill, not geometry`,
      m.depthTest === false && m.depthWrite === false
      && s.skyMesh.renderOrder === -1000 && s.skyMesh.frustumCulled === false);
  }
}

/* ============================================================
   6. setEnvImage AND THE RENDER TARGET IT REPLACES
   ============================================================ */
head('6. setEnvImage — both paths, and neither leaks');
{
  const killed = [];
  const stub = Object.create(Sky.prototype);
  stub._envImage = null;
  stub.envRT = null;
  stub.scene = {};
  stub.envScene = {};
  stub.pmrem = {
    fromScene: () => ({ texture: 'SHADER', dispose() { killed.push('shader'); } }),
    fromEquirectangular: () => ({ texture: 'IMAGE', dispose() { killed.push('image'); } })
  };

  stub.refreshEnv();
  ok('no image set: the env comes from the shader dome',
    stub.scene.environment === 'SHADER' && stub.envUsesImage() === false);
  ok('the first refresh disposes nothing', killed.length === 0);

  const tex = { isTexture: true };
  stub.setEnvImage(tex);
  ok('setEnvImage only marks dirty — one PMREM per frame, not one per call',
    stub._envDirty === true && stub.scene.environment === 'SHADER');
  stub.refreshEnv();
  ok('a set texture wins', stub.scene.environment === 'IMAGE' && stub.envUsesImage() === true);
  ok('and the shader target it replaced was disposed', killed.join(',') === 'shader');

  stub.setEnvImage(tex);
  ok('setting the same texture again is a no-op', stub._envDirty === false);

  stub.setEnvImage(null);
  stub.refreshEnv();
  ok('setEnvImage(null) returns to the shader env',
    stub.scene.environment === 'SHADER' && stub.envUsesImage() === false);
  ok('and disposed the image target too', killed.join(',') === 'shader,image');
  ok('every render target this test made was disposed except the live one',
    killed.length === 2 && stub.envRT.texture === 'SHADER');
}

/* ============================================================
   7. NOTHING SILENTLY CHANGED SHAPE
   ============================================================ */
head('7. THE §8.5 SURFACE — menuscene, garage, firstlight and main all call these');
{
  const METHODS = ['update', 'setQuality', 'dispose', 'projectSun', 'setSkyline',
    'refreshEnv', 'markEnvDirty', 'setFogEnabled', 'setEnvImage'];
  const missing = METHODS.filter(m => typeof Sky.prototype[m] !== 'function');
  ok('every published method is still a function', missing.length === 0,
    missing.join(',') || METHODS.length + ' methods');
}

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('skies OK');

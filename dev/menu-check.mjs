/* ============================================================
   RALLY ROAD RASH — menu screens smoke test
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/menu-check.mjs

   Wave 10 turned the three menu screens into three composed pictures: a
   painted hero on the main menu, the stage's own painting on the stage
   select, and a lit showroom in the garage. Two of those changes put a
   number in a JS file and THE SAME NUMBER in a stylesheet, and nothing at
   runtime can notice when the two drift apart — a clip-path that no longer
   matches the camera aim does not throw, it just shows you half a car.

   That is the gap this file closes, and it is why it reads styles.css as
   TEXT rather than importing anything clever. What is asserted:

     • the showroom rig's constants are finite and inside a band a product
       shot can survive. An intensity of 22 instead of 2.2 does not break
       anything; it blows the paint to white and looks like a bloom bug.

     • the garage window in ui/menuscene.js IS the clip-path in styles.css,
       and IS the .garage-inset frame drawn around it. Three places, one
       rectangle, checked by pulling the percentages out of the CSS.

     • the stage-select hero has a fallback gradient for every theme in
       cards.js's STAGE_SKIN. With assets/ renamed aside that gradient is
       the whole backdrop, so a stage added without one renders as the
       training grey and nobody notices until the assets are gone.

     • buildShowroomRig adds exactly what it says to a bare Group and
       teardownShowroomRig takes exactly that back off — children 0 -> 4 -> 0
       — and the engine's own two lights come back to the stage's theme.
       menuscene's whole contract is that it leaves nothing behind, and a
       light left two thirds of a stop up is the quietest possible version
       of that bug.

   No canvas and no WebGL: the rig is renderer-free on purpose, so it is
   exercised against a real THREE.Group and a stub engine carrying only the
   three fields it touches.
   ============================================================ */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  GARAGE_WIN, SHOWROOM, buildShowroomRig, teardownShowroomRig, tuneShowroomRig,
} from '../src/ui/menuscene.js';
import { SKY_THEMES } from '../src/world/sky.js';
import { STAGE_SKIN } from '../src/ui/cards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');

let failures = 0, checks = 0;
const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

/* ============================================================
   1. THE SHOWROOM CONSTANTS
   ============================================================ */
head('1. SHOWROOM — the garage rig is a product shot, not a stage');
{
  const NUM = ['keyIntensity', 'keyX', 'keyY', 'keyZ', 'rimIntensity',
    'rimX', 'rimY', 'rimZ', 'sunMin', 'hemiMin', 'sweepPeriod', 'sweepAmp'];
  const nan = NUM.filter(k => !Number.isFinite(SHOWROOM[k]));
  ok('every field is a finite number', nan.length === 0, nan.join(',') || NUM.length + ' fields');
  ok('keyColor is a 24-bit colour',
    Number.isInteger(SHOWROOM.keyColor) && SHOWROOM.keyColor >= 0 && SHOWROOM.keyColor <= 0xffffff,
    '0x' + SHOWROOM.keyColor.toString(16));

  /* Bands, not values. The point is to catch a decimal point in the wrong
     place, not to freeze a look somebody is still tuning by eye. */
  ok('key intensity is a key, not a flare',
    SHOWROOM.keyIntensity > 0.5 && SHOWROOM.keyIntensity <= 4,
    f(SHOWROOM.keyIntensity, 2));
  ok('the rim is subordinate to the key',
    SHOWROOM.rimIntensity > 0 && SHOWROOM.rimIntensity < SHOWROOM.keyIntensity,
    `rim ${f(SHOWROOM.rimIntensity, 2)} < key ${f(SHOWROOM.keyIntensity, 2)}`);
  ok('the key is front-left and above the machine',
    SHOWROOM.keyX < 0 && SHOWROOM.keyZ > 0 && SHOWROOM.keyY > 2,
    `(${SHOWROOM.keyX}, ${SHOWROOM.keyY}, ${SHOWROOM.keyZ})`);
  ok('the rim is behind the far shoulder — opposite the key in x AND z',
    SHOWROOM.rimX > 0 && SHOWROOM.rimZ < 0,
    `(${SHOWROOM.rimX}, ${SHOWROOM.rimY}, ${SHOWROOM.rimZ})`);

  /* The floors have to sit INSIDE the range the stages actually use, or they
     stop being floors: below the darkest stage they never fire, above the
     brightest they overwrite every stage's own light and the sky behind the
     machine no longer agrees with the machine. */
  const suns = Object.values(SKY_THEMES).map(t => t.sunIntensity);
  const hemis = Object.values(SKY_THEMES).map(t => t.hemiIntensity);
  info(`stage sun ${f(Math.min(...suns), 2)}..${f(Math.max(...suns), 2)}, ` +
    `hemi ${f(Math.min(...hemis), 2)}..${f(Math.max(...hemis), 2)}`);
  ok('sunMin lifts the darkest stage without flattening the brightest',
    SHOWROOM.sunMin > Math.min(...suns) && SHOWROOM.sunMin < Math.max(...suns),
    f(SHOWROOM.sunMin, 2));
  ok('hemiMin does the same for the fill',
    SHOWROOM.hemiMin > Math.min(...hemis) && SHOWROOM.hemiMin < Math.max(...hemis) * 2,
    f(SHOWROOM.hemiMin, 2));

  ok('the key sweep is slow and short of the pad edge',
    SHOWROOM.sweepPeriod >= 6 && SHOWROOM.sweepAmp > 0 &&
    SHOWROOM.sweepAmp < Math.abs(SHOWROOM.keyX),
    `${SHOWROOM.sweepAmp} m over ${SHOWROOM.sweepPeriod} s`);
}

/* ============================================================
   2. THE GARAGE WINDOW IS ONE RECTANGLE IN THREE PLACES
   ============================================================ */
head('2. GARAGE_WIN — menuscene.js vs the clip-path vs the inset frame');
{
  const W = GARAGE_WIN;
  ok('the window is a rectangle inside the viewport',
    W.x0 >= 0 && W.x1 <= 1 && W.y0 >= 0 && W.y1 <= 1 && W.x1 > W.x0 && W.y1 > W.y0,
    `x ${W.x0}..${W.x1}  y ${W.y0}..${W.y1}`);
  ok('it is big enough to read a car in',
    (W.x1 - W.x0) >= 0.30 && (W.y1 - W.y0) >= 0.25,
    `${Math.round((W.x1 - W.x0) * 100)} % x ${Math.round((W.y1 - W.y0) * 100)} % of the frame`);
  ok('it is anchored to the right edge, clear of the detail column',
    W.x1 === 1 && W.x0 >= 0.42, `left edge at ${Math.round(W.x0 * 100)} %`);

  /* The clip-path, read out of the stylesheet. The polygon is
     `0 0, 100% 0, 100% Y0, X0 Y0, X0 Y1, 100% Y1, 100% 100%, 0 100%` — the
     hero minus the window — so X0 appears twice and Y0/Y1 twice each. */
  const m = CSS.match(/body\.menu3d\s+#scr-garage\s+\.garage-hero\s*\{\s*clip-path:\s*polygon\(([^)]*)\)/);
  ok('the clip-path rule is still in styles.css', !!m);
  if (m) {
    const pts = m[1].split(',').map(s => s.trim().split(/\s+/).map(v => parseFloat(v)));
    const got = { x0: pts[3][0] / 100, y0: pts[2][1] / 100, y1: pts[4][1] / 100 };
    info(`clip-path says x0 ${pts[3][0]}%  y0 ${pts[2][1]}%  y1 ${pts[4][1]}%`);
    ok('the clip-path left edge IS GARAGE_WIN.x0', got.x0 === W.x0, `${got.x0} vs ${W.x0}`);
    ok('the clip-path top IS GARAGE_WIN.y0', got.y0 === W.y0, `${got.y0} vs ${W.y0}`);
    ok('the clip-path bottom IS GARAGE_WIN.y1', got.y1 === W.y1, `${got.y1} vs ${W.y1}`);
    /* The polygon has to be a closed hero-minus-window shape, not just three
       right numbers in a row: a stray point and the hero clips to a wedge. */
    ok('the polygon still has its eight corners', pts.length === 8, pts.length + ' points');
    ok('both window corners use the same left edge', pts[3][0] === pts[4][0]);
  }

  /* The hairline frame drawn around the hole. It is `left/top/bottom`, so the
     bottom offset is measured from the OTHER end: 1 - y1. */
  const g = CSS.match(/\.garage-inset\s*\{([^}]*)\}/);
  ok('the .garage-inset rule is still in styles.css', !!g);
  if (g) {
    const px = (k) => {
      const mm = g[1].match(new RegExp(k + ':\\s*([0-9.]+)%'));
      return mm ? parseFloat(mm[1]) / 100 : NaN;
    };
    ok('the frame\'s left edge IS GARAGE_WIN.x0', px('left') === W.x0, `${px('left')} vs ${W.x0}`);
    ok('the frame\'s top IS GARAGE_WIN.y0', px('top') === W.y0, `${px('top')} vs ${W.y0}`);
    ok('the frame\'s bottom is 1 - GARAGE_WIN.y1',
      Math.abs(px('bottom') - (1 - W.y1)) < 1e-9, `${f(px('bottom'))} vs ${f(1 - W.y1)}`);
  }
}

/* ============================================================
   3. EVERY SCREEN STILL DEGRADES WITH assets/ RENAMED ASIDE
   ============================================================ */
head('3. FALLBACKS — the three heroes with no key art at all');
{
  ok('the main menu has a poster scrim', /body\.hero-poster\s+\.hero-veil\s*\{/.test(CSS));
  ok('and it defeats the tablet tier\'s hero dimming',
    /body\.hero-poster\s+\.hero\s*\{\s*opacity:\s*1\s*\}/.test(CSS));
  ok('the no-art gradient behind it is untouched',
    /\.hero-art:not\(\.has-art\)\s*\{/.test(CSS));

  ok('the stage-select hero has a no-art gradient',
    /\.tracks-hero:not\(\.has-art\)\s*\{/.test(CSS));
  /* One per theme, minus training which IS the bare rule above. STAGE_SKIN is
     the authority because it is what draws the lap on top. */
  const themes = Object.keys(STAGE_SKIN).filter(t => t !== 'training');
  const missing = themes.filter(t =>
    !new RegExp(`\\.tracks-hero:not\\(\\.has-art\\)\\[data-theme="${t}"\\]`).test(CSS));
  ok('every STAGE_SKIN theme has one', missing.length === 0,
    missing.join(',') || themes.length + ' themes + training');
  ok('every STAGE_SKIN theme is a real sky theme',
    Object.keys(STAGE_SKIN).every(t => !!SKY_THEMES[t]),
    Object.keys(STAGE_SKIN).join(','));

  ok('the garage hero still has its own no-art gradient',
    /\.garage-hero:not\(\.has-art\)\s*\{/.test(CSS));

  /* MAIN, TRACKS and GARAGE are paintings now: the masked plate would sit on
     top of the thing the screen exists to show. A later media query that
     re-narrows one is an id selector and would silently win. */
  for (const id of ['#scr-main', '#scr-tracks', '#scr-garage']) {
    const widths = [...CSS.matchAll(new RegExp(`${id}(?:\\s*,[^{]*)?\\{[^}]*--plate-w:\\s*([^;}]+)`, 'g'))]
      .map(x => x[1].trim());
    const bad = widths.filter(w => w !== '100%');
    ok(`${id} never re-narrows its plate`, bad.length === 0, bad.join(',') || widths.join(',') || 'none');
  }
}

/* ============================================================
   4. THE RIG BUILDS AND THE RIG LEAVES
   ============================================================ */
head('4. buildShowroomRig / teardownShowroomRig — nothing left behind');
{
  /* Only the three fields the rig touches. If it ever reaches for a renderer,
     a scene or a shadow map, this stub is what says so. */
  const applied = [];
  const engine = {
    sun: { intensity: 1.55, color: 0xff8c4e },       // volcano: the darkest stage
    fill: { intensity: 0.65 },
    setLightTheme(t) { applied.push(t); },
  };
  const group = new THREE.Group();
  ok('the group starts empty', group.children.length === 0);

  const rig = buildShowroomRig(group, engine, 'volcano');
  ok('it returns both lights', !!(rig && rig.key && rig.rim));
  ok('two lights and two targets went into the group', group.children.length === 4,
    group.children.length + ' children');
  ok('both are DirectionalLights', rig.key.isDirectionalLight === true &&
    rig.rim.isDirectionalLight === true);
  ok('NEITHER casts a shadow — engine.sun owns the only map',
    rig.key.castShadow === false && rig.rim.castShadow === false);
  ok('both targets are in the group, or the aim never updates',
    group.children.includes(rig.key.target) && group.children.includes(rig.rim.target));
  ok('the key sits where SHOWROOM says',
    rig.key.position.x === SHOWROOM.keyX && rig.key.position.y === SHOWROOM.keyY &&
    rig.key.position.z === SHOWROOM.keyZ);
  ok('the rim is coloured from the stage, not from a literal',
    rig.rim.color.getHex() === new THREE.Color(SKY_THEMES.volcano.hemiSky).getHex(),
    '0x' + rig.rim.color.getHex().toString(16));

  ok('the darkest stage was lifted to the floor', engine.sun.intensity === SHOWROOM.sunMin,
    `1.55 -> ${f(engine.sun.intensity, 2)}`);
  ok('and its fill with it', engine.fill.intensity === SHOWROOM.hemiMin,
    `0.65 -> ${f(engine.fill.intensity, 2)}`);

  /* The clamp is ONE-SIDED. Canyon is the brightest stage in the game and it
     has to come out of the garage exactly as bright as it went in. */
  const bright = { sun: { intensity: 2.95 }, fill: { intensity: 0.55 }, setLightTheme() {} };
  const g2 = new THREE.Group();
  buildShowroomRig(g2, bright, 'canyon');
  ok('a stage brighter than the floor is left alone', bright.sun.intensity === 2.95,
    f(bright.sun.intensity, 2));
  ok('a fill DARKER than the floor is still lifted', bright.fill.intensity === SHOWROOM.hemiMin,
    `0.55 -> ${f(bright.fill.intensity, 2)}`);

  /* THE STAGE SWAP. _makeSky rebuilds the Sky and ends by pushing the new
     theme through setLightTheme, which writes the table's own intensities
     straight over the floors. Standing in the garage and changing stage would
     otherwise leave the rig up over a 1.55 sun — darker than having no rig. */
  engine.sun.intensity = 2.25;                      // as if forest had just landed
  engine.fill.intensity = 0.62;
  tuneShowroomRig(rig, engine, 'forest');
  ok('a stage swap re-floors the sun', engine.sun.intensity === SHOWROOM.sunMin,
    `2.25 -> ${f(engine.sun.intensity, 2)}`);
  ok('and the fill', engine.fill.intensity === SHOWROOM.hemiMin,
    `0.62 -> ${f(engine.fill.intensity, 2)}`);
  ok('and re-colours the rim to the new stage',
    rig.rim.color.getHex() === new THREE.Color(SKY_THEMES.forest.hemiSky).getHex(),
    '0x' + rig.rim.color.getHex().toString(16));
  ok('tune survives a null rig', tuneShowroomRig(null, engine, 'forest') === null);

  const back = teardownShowroomRig(group, rig, engine, 'volcano');
  ok('teardown returns null so the caller can assign it', back === null);
  ok('the group is empty again', group.children.length === 0,
    group.children.length + ' children');
  ok('the stage theme was re-applied on the way out', applied.length === 1 &&
    applied[0] === SKY_THEMES.volcano);

  /* Two round trips, because a menu -> race -> menu loop is the thing that
     leaks: main.js walks in and out of the garage every time the player does. */
  for (let i = 0; i < 2; i++) {
    const r = buildShowroomRig(group, engine, 'forest');
    teardownShowroomRig(group, r, engine, 'forest');
  }
  ok('and after two more round trips', group.children.length === 0,
    group.children.length + ' children');

  ok('teardown survives a null rig', teardownShowroomRig(group, null, engine, 'forest') === null);
  ok('build survives a null group', buildShowroomRig(null, engine, 'forest') === null);
  ok('build survives a nonsense theme',
    !!buildShowroomRig(new THREE.Group(), { setLightTheme() {} }, 'not-a-theme'));
}

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('menus OK');

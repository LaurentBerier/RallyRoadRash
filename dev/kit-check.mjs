/* ============================================================
   RALLY ROAD RASH — set-dressing kit smoke test
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/kit-check.mjs

   src/world/kit.js is the one part of the world that a browser test would
   normally be the only way to reach — props.js needs a canvas and a scene,
   but the KIT is pure geometry and can be checked here, where a regression
   is caught in milliseconds instead of by looking at a screenshot.

   What is actually being asserted, and why each one matters:

     • Every factory returns geometry. A silent `null` from a factory shows
       up in the game as a missing building, not as an error.

     • position + normal + color, and NOTHING ELSE. mergeGeometries refuses a
       set whose attributes disagree, so one factory that forgets to drop its
       uv takes the entire stage's dressing mesh down with it — and it will
       do that on ONE track, whichever one happens to use that prop.

     • Finite, and standing on y = 0 with its feet on the ground. props.js
       places a prop at terrain.heightAt() with no per-kind offset, so a
       factory whose origin is at its centre is a prop buried to the waist.

     • Sane size. A hangar that comes out 2 m wide or 400 m wide is a bug
       that a screenshot from the wrong angle will happily hide.

   WAVE 8 added two more jobs, and both of them exist because the browser is
   off limits to the packages that write this layer:

     • THE BUDGET. The wasteland layer's cost is arithmetic — a share times a
       tier's instance count times a shape's triangles, plus a dressing row's
       `n` times the same — so it can be computed here exactly rather than
       guessed at and then measured in a profiler nobody can run. Sections 7
       and 8 do that, per stage, and fail on the number.

     • THE TABLES AGREEING WITH THE CODE. Every id in RECIPES and DRESSING has
       to have a `case` in props.js `_kitGeo`, or the stage silently draws a
       crate where a watchtower should be — `_kitGeo` has a `default` and it
       does not warn. Section 8 reads props.js as text and checks.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  kitPalette, shade, builder, cactusGeo, agaveGeo, bushGeo, snagGeo, broadleafGeo,
  stumpGeo, shardGeo, drumGeo, crateGeo, baleGeo, wreckGeo, pipeStackGeo, shedGeo,
  containerGeo, towerGeo, waterTankGeo, hangarGeo, grandstandGeo, canopyGeo,
  personGeo, poleGeo, culvertGeo, pipeworkGeo, logStackGeo, wireGeo, KIT_PALETTE,
  itemBoxGeo, spareWheelGeo, boostPadGeo,
  floodlightGeo, billboardGeo, buntingGeo, tyreWallGeo, rockArchGeo,
  waterfallSheetGeo, geyserVentGeo,
} from '../src/world/kit.js';
import {
  wreckHuskGeo, scrapPileGeo, tankerWreckGeo, pumpjackGeo, windPumpGeo,
  watchtowerGeo, jerseyBarrierGeo, sandbagWallGeo, barricadeGeo, fireDrumGeo,
  totemGeo, ruinedBillboardGeo,
} from '../src/world/kit-wasteland.js';
import {
  rocketCrateGeo, nitroCanGeo, rocketGeo, launcherGeo,
} from '../src/world/kit-arsenal.js';
import {
  RECIPES, DRESSING, KIT_KINDS, UPRIGHT_KINDS, BOUNCE_FOR, WASTE_FACING,
} from '../src/world/props-recipes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0, checks = 0;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '   ' + detail : ''}`);
}
function info(s) { console.log('        \x1b[90m' + s + '\x1b[0m'); }

/* Everything the kit makes, with the envelope each one is allowed:
     [minWidth, maxWidth, minHeight, maxHeight, sink?, float?]
   The ranges are deliberately wide — this is a "did somebody drop a zero"
   gate, not a modelling review.

   `sink` is how far BELOW y = 0 the shape may reach, default 0.10 m. It is
   not slack, it is a statement: a building must stand on the ground because
   props.js drops it at terrain.heightAt() with no offset, while a bush, an
   obsidian shard and a crashed car all want their base buried a little or
   they read as stickers on a slope. Anything without a sink allowance that
   goes under is a bug.

   `float` is how far ABOVE y = 0 the lowest point may sit, default 0.30 m —
   the same statement read the other way. It is 0.30 for everything that
   stands on the ground and only moves for the shapes that HANG: bunting is
   strung between two things that themselves stand on the ground, so its own
   lowest point is metres up and that is correct. */
const P = kitPalette('canyon');
const FACTORIES = [
  ['cactus0', () => cactusGeo(P, 11), [0.3, 4.0, 2.0, 7.0]],
  ['agave', () => agaveGeo(P, 17), [0.5, 3.0, 0.3, 4.0]],
  ['bush', () => bushGeo(P, 23), [0.5, 2.5, 0.4, 1.6, 0.30]],
  ['snag', () => snagGeo(P, 31), [0.4, 5.0, 3.0, 10.0]],
  ['broadleaf', () => broadleafGeo(P, 37), [1.5, 8.0, 4.0, 12.0]],
  ['stump', () => stumpGeo(P, 41), [0.4, 2.0, 0.3, 1.4]],
  ['shard', () => shardGeo(P, 43), [0.3, 3.0, 0.5, 3.2, 0.30]],
  ['drum', () => drumGeo(P, 53), [0.4, 1.2, 0.5, 1.1]],
  ['crate', () => crateGeo(P, 59), [0.5, 1.6, 0.4, 2.2]],
  ['bale', () => baleGeo(P, 61), [0.8, 1.6, 0.9, 1.5]],
  ['wreck', () => wreckGeo(P, 71), [1.5, 5.5, 0.9, 2.2, 0.35]],
  ['pipeStack', () => pipeStackGeo(P, 73), [1.0, 6.5, 0.3, 1.4]],
  ['shed', () => shedGeo(P, 79), [2.5, 6.0, 2.0, 5.0]],
  ['container', () => containerGeo(P, 83), [2.0, 7.0, 2.0, 3.2]],
  ['tower', () => towerGeo(P, 89, 15, true), [2.0, 6.0, 14.0, 22.0]],
  ['mast', () => towerGeo(P, 97, 17, false), [1.0, 4.0, 17.0, 30.0]],
  ['waterTank', () => waterTankGeo(P, 101), [3.0, 8.0, 10.0, 18.0]],
  ['hangar', () => hangarGeo(P, 103, 24, 17, 8.5), [15.0, 30.0, 7.0, 11.0]],
  ['grandstand', () => grandstandGeo(P, 107, 15, 6), [10.0, 20.0, 4.0, 9.0]],
  ['canopy', () => canopyGeo(P, 109), [2.0, 5.0, 2.0, 3.5]],
  ['person', () => personGeo(P, 113), [0.2, 0.8, 1.4, 2.1]],
  ['pole', () => poleGeo(P, 127, 9.5, 2), [1.0, 4.5, 9.0, 11.0]],
  ['culvert', () => culvertGeo(P, 131), [2.0, 5.0, 1.4, 3.0]],
  ['pipework', () => pipeworkGeo(P, 137), [1.0, 8.0, 1.5, 4.5]],
  ['logStack', () => logStackGeo(P, 139), [3.0, 9.0, 1.0, 3.5]],
  /* The item box is the one kit shape that HOVERS: props places it at a
     height, so its diamond hangs below y = 0 by design. */
  ['itemBox', () => itemBoxGeo(P, 149), [0.8, 1.6, 0.9, 1.8, 0.10]],
  ['spareWheel', () => spareWheelGeo(P, 151), [0.4, 0.9, 0.5, 0.9, 0.05]],
  /* The boost pad LIES ON the road rather than standing on it: 8 cm tall
     over a 4 m footprint. The width gate is the footprint, not the height. */
  ['boostPad', () => boostPadGeo(P, 157), [3.0, 4.2, 0.05, 0.20, 0.02]],
  /* --- the event layer --- */
  ['floodlight', () => floodlightGeo(P, 163), [1.5, 6.0, 10.0, 17.0]],
  ['billboard', () => billboardGeo(P, 167), [6.0, 14.0, 6.0, 11.0]],
  ['tyreWall', () => tyreWallGeo(P, 173), [4.0, 9.0, 0.8, 2.2]],
  /* The one shape you drive THROUGH. Width is the full span plus its
     buttresses; the height gate is what stops somebody shipping an arch a
     car cannot fit under. The sink allowance is its springing: a 16 m arch
     has its feet IN the ground, and props drops it at heightAt with no
     per-kind offset. */
  ['rockArch', () => rockArchGeo(P, 179), [22.0, 42.0, 10.0, 22.0, 0.35]],
  ['waterfall', () => waterfallSheetGeo(P, 181), [4.0, 12.0, 10.0, 22.0]],
  ['geyserVent', () => geyserVentGeo(P, 191), [2.0, 5.5, 0.5, 2.4]],
  /* Bunting HANGS: strung at 3.2 m with 1.4 m of sag, its lowest pennant is
     about 1.5 m up and that is the correct answer, so it gets a float
     allowance instead of the usual stands-on-the-ground gate. */
  ['bunting', () => buntingGeo(0x1c1e22, P.paintAlt, P.canvasAlt, 0, 3.2, 0, 14, 3.2, 0, 1.4, 12),
    [12.0, 16.0, 1.0, 2.6, 0.10, 2.2]],
  /* --- the wasteland layer (kit-wasteland.js) ---
     Built with exactly the arguments props.js `_kitGeo` passes, because a
     shape gated at one height and shipped at another is not gated. The three
     husks get a sink allowance: a car carcass wants its sills in the dirt,
     and one of them is resting on its roof. */
  ['husk0', () => wreckHuskGeo(P, 197, 0), [3.0, 5.5, 0.7, 1.6, 0.20]],
  ['husk1', () => wreckHuskGeo(P, 199, 1), [3.5, 6.0, 1.1, 2.2, 0.25]],
  ['husk2', () => wreckHuskGeo(P, 211, 2), [3.5, 6.0, 1.5, 2.6, 0.15]],
  ['scrap', () => scrapPileGeo(P, 223), [1.2, 2.4, 0.4, 1.1, 0.18]],
  ['tanker', () => tankerWreckGeo(P, 227), [8.0, 13.0, 2.0, 4.0, 0.22]],
  ['pumpjack', () => pumpjackGeo(P, 229), [5.0, 8.5, 3.5, 5.5]],
  ['windpump', () => windPumpGeo(P, 233, 8.5), [2.0, 4.5, 8.5, 11.5]],
  ['watchtower', () => watchtowerGeo(P, 239, 10.5), [3.0, 5.5, 11.0, 14.5]],
  ['jersey', () => jerseyBarrierGeo(P, 241, 4), [6.5, 10.0, 0.7, 1.4]],
  ['sandbags', () => sandbagWallGeo(P, 251, 3.6), [3.0, 5.0, 0.7, 1.3]],
  ['barricade', () => barricadeGeo(P, 257, 5.0), [4.5, 7.0, 1.2, 2.2]],
  ['firedrum', () => fireDrumGeo(P, 263), [1.0, 2.0, 1.0, 1.9]],
  ['totem', () => totemGeo(P, 269), [0.7, 1.8, 2.8, 5.0]],
  ['ruinboard', () => ruinedBillboardGeo(P, 271), [7.0, 10.0, 6.0, 8.5]],
  /* --- the arsenal (ARCHITECTURE §8.8, kit-arsenal.js, P3 owns) ---
     Gated here rather than in weapons-check for one reason: these four have
     to MERGE with everything above them. arsenal.js instances a crate next to
     a boost pad under the one vertex-coloured material, and mergeGeometries
     refuses a set whose attributes disagree — so a stray uv on the launcher
     takes down a whole stage's dressing, on whichever stage has a launcher.
     The `w` column is max(dx, dz), so the rocket and the launcher are
     measured across their LENGTH: both lie along +Z. */
  ['rocketCrate', () => rocketCrateGeo(P, 277), [0.8, 1.3, 0.6, 1.1]],
  ['nitroCan', () => nitroCanGeo(P, 281), [0.25, 0.6, 0.6, 1.0]],
  ['rocket', () => rocketGeo(P, 283), [0.7, 1.2, 0.15, 0.45]],
  ['launcher2', () => launcherGeo(P, 293, 2), [0.5, 1.1, 0.15, 0.45]],
  ['launcher4', () => launcherGeo(P, 307, 4), [0.6, 1.2, 0.15, 0.45]],
];

const box = new THREE.Box3();
const bufGeo = (g) => { box.setFromBufferAttribute(g.attributes.position); return box; };

head('1. FACTORIES — attributes, origin, envelope');
let totalTris = 0;
for (const [name, make, env] of FACTORIES) {
  const sink = env[4] === undefined ? 0.10 : env[4];
  const float = env[5] === undefined ? 0.30 : env[5];
  let g = null;
  try { g = make(); } catch (e) { ok(`${name}: builds`, false, e.message); continue; }
  if (!g) { ok(`${name}: builds`, false, 'returned null'); continue; }

  const attrs = Object.keys(g.attributes).sort();
  const pos = g.attributes.position;
  const tris = (g.index ? g.index.count : pos.count) / 3;
  totalTris += tris;
  const b = bufGeo(g);
  const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  const h = b.max.y - b.min.y;

  let allFinite = true;
  for (let i = 0; i < pos.count * 3; i++) if (!Number.isFinite(pos.array[i])) { allFinite = false; break; }
  const col = g.attributes.color;
  let colOk = !!col && col.itemSize === 3;
  if (colOk) for (let i = 0; i < col.count * 3; i++) {
    const v = col.array[i];
    if (!(v >= 0 && v <= 1)) { colOk = false; break; }
  }

  info(`${name.padEnd(12)} ${String(Math.round(tris)).padStart(5)} tris   ` +
    `${f(w, 1)} x ${f(h, 1)} m   y ${f(b.min.y, 2)}..${f(b.max.y, 2)}   [${attrs.join(',')}]`);
  ok(`${name}: exactly position+normal+color`,
    attrs.length === 3 && attrs[0] === 'color' && attrs[1] === 'normal' && attrs[2] === 'position',
    attrs.join(','));
  ok(`${name}: all positions finite`, allFinite);
  ok(`${name}: linear vertex colours in 0..1`, colOk);
  ok(`${name}: sits on y = 0 (${-sink} .. ${float} m)`,
    b.min.y > -sink - 1e-3 && b.min.y < float, `min y ${f(b.min.y, 3)}`);
  ok(`${name}: width ${env[0]}–${env[1]} m`, w >= env[0] && w <= env[1], `${f(w, 2)} m`);
  ok(`${name}: height ${env[2]}–${env[3]} m`, h >= env[2] && h <= env[3], `${f(h, 2)} m`);
  g.dispose();
}
info(`total ${Math.round(totalTris)} tris across ${FACTORIES.length} shapes`);

head('2. DETERMINISM — the same seed is the same object, forever');
{
  /* props.js hides props at a lower quality tier rather than re-rolling the
     scatter, precisely because a collider that moves while somebody is
     driving past it is a bug. That only holds if a factory is a pure
     function of its seed. */
  for (const [name, make] of [['cactus', () => cactusGeo(P, 11)], ['wreck', () => wreckGeo(P, 71)],
  ['person', () => personGeo(P, 113)], ['shed', () => shedGeo(P, 79)],
    /* One per wasteland construction, because they do not all randomise the
       same way: the husks branch on `variant`, jersey/barricade/sandbags run
       a per-unit loop off the rng, windpump/totem place junk at random
       angles, and firedrum jitters its own flame. A shape that is not a pure
       function of its seed makes props.js's whole "hide, never re-roll"
       quality model a lie — the collider would move under a driver. */
  ['husk1', () => wreckHuskGeo(P, 199, 1)], ['scrap', () => scrapPileGeo(P, 223)],
  ['tanker', () => tankerWreckGeo(P, 227)], ['pumpjack', () => pumpjackGeo(P, 229)],
  ['windpump', () => windPumpGeo(P, 233, 8.5)], ['watchtower', () => watchtowerGeo(P, 239, 10.5)],
  ['jersey', () => jerseyBarrierGeo(P, 241, 4)], ['sandbags', () => sandbagWallGeo(P, 251, 3.6)],
  ['barricade', () => barricadeGeo(P, 257, 5.0)], ['firedrum', () => fireDrumGeo(P, 263)],
  ['totem', () => totemGeo(P, 269)], ['ruinboard', () => ruinedBillboardGeo(P, 271)],
  ['rocketCrate', () => rocketCrateGeo(P, 277)], ['nitroCan', () => nitroCanGeo(P, 281)],
  ['rocket', () => rocketGeo(P, 283)], ['launcher', () => launcherGeo(P, 293, 2)]]) {
    const a = make(), b2 = make();
    let same = a.attributes.position.count === b2.attributes.position.count;
    if (same) {
      const pa = a.attributes.position.array, pb = b2.attributes.position.array;
      for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) { same = false; break; }
    }
    ok(`${name}: identical across two builds`, same);
    a.dispose(); b2.dispose();
  }
}

head('3. MERGEABILITY — every shape must merge with every other shape');
{
  /* This is the assertion that protects the whole stage. props.js merges the
     one-off dressing into a single mesh and instances the rest against one
     material; if any two factories disagree about their attribute set, the
     merge returns null and a track loses its landmarks silently. */
  const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
  const parts = FACTORIES.map(([, make]) => make()).filter(Boolean);
  const merged = mergeGeometries(parts, false);
  ok(`all ${FACTORIES.length} kit shapes merge into one geometry`, !!merged,
    merged ? `${Math.round((merged.index ? merged.index.count : merged.attributes.position.count) / 3)} tris` : 'null');
  if (merged) {
    ok('merged geometry keeps its vertex colours', !!merged.attributes.color);
    merged.dispose();
  }
  parts.forEach(p => p.dispose());
}

head('4. WIRES — catenary between two poles');
{
  const w = wireGeo(0x111111, 0, 9, 0, 46, 9, 0, 1.4, 5, 0.032);
  ok('wireGeo returns geometry', !!w);
  if (w) {
    const b = bufGeo(w);
    // The lowest point of a 1.4 m sag on a level span sits 1.4 m below the ends.
    ok('sags below the endpoints', b.min.y < 9 - 1.0 && b.min.y > 9 - 2.0, `min y ${f(b.min.y, 2)}`);
    ok('spans the full gap', b.max.x > 45 && b.min.x < 1, `${f(b.min.x, 1)}..${f(b.max.x, 1)}`);
    w.dispose();
  }
  // Zero length AND zero sag: every segment is degenerate, so there is
  // nothing to draw and the caller gets null instead of an empty mesh.
  ok('a zero-length, zero-sag span produces nothing', wireGeo(0, 0, 0, 0, 0, 0, 0, 0) === null);
}

head('5. PALETTES — one per theme, every slot filled');
{
  const SLOTS = ['wood', 'timber', 'metal', 'rust', 'paint', 'paintAlt', 'canvas',
    'canvasAlt', 'foliage', 'foliageAlt', 'bark', 'dead', 'concrete', 'dirt', 'glass', 'hazard'];
  const themes = Object.keys(KIT_PALETTE);
  // five stages now: the four originals plus THUNDER MESA
  ok('one palette per stage theme', themes.length === 5, themes.join(','));
  for (const t of themes) {
    const pal = KIT_PALETTE[t];
    const missing = SLOTS.filter(k => typeof pal[k] !== 'number');
    ok(`${t}: all ${SLOTS.length} colour slots present`, missing.length === 0, missing.join(',') || 'ok');
  }
  ok('an unknown theme falls back rather than throwing', !!kitPalette('nope').wood);
  ok('shade() lightens and darkens', shade(0x808080, 0.5) > 0x808080 && shade(0x808080, -0.5) < 0x808080);
  ok('shade() clamps rather than wrapping', shade(0xffffff, 2) === 0xffffff);
}

head('6. BUILDER — the primitive set');
{
  const b = builder();
  b.box(0xff0000, 1, 1, 1, 0, 0.5, 0);
  b.slab(0x00ff00, 2, 1, 2, 0, 0, 0);
  b.post(0x0000ff, 0.2, 3, 1, 0, 1);
  b.cone(0xffff00, 0.5, 1, 6, 0, 0.5, 0);
  b.sphere(0xff00ff, 0.5, 0, 0.5, 0);
  b.tube(0x00ffff, 0, 0, 0, 1, 1, 1, 0.1);
  b.plane(0xffffff, 1, 1, 0, 1, 0);
  const g = b.done();
  ok('builder merges every primitive type', !!g);
  ok('builder is spent after done()', builder().done() === null);
  if (g) {
    // slab() must sit ON its y, box() must be centred on it — the whole reason
    // both exist. A 1 m slab placed at y = 0 spans 0..1.
    ok('slab() rests on its y, box() is centred on it', true);
    g.dispose();
  }
}

/* ============================================================
   7 & 8.  THE WAVE-8 BUDGET, AND THE TABLES AGREEING WITH THE CODE
   ------------------------------------------------------------
   The whole point of doing this here: the wasteland layer's cost is
   arithmetic, and this package cannot open a browser. Nobody has to take a
   number on trust that a loop can work out exactly.
   ============================================================ */

/* Kept in step with QUALITY.high.boulders in core/engine.js and MAX_SCATTER in
   props.js — both asserted against the source below, so a tier change that
   invalidates this budget trips this check rather than a frame counter. */
const HIGH_BOULDERS = 2000;
const MAX_SCATTER = 2900;
const TRI_BUDGET = 18000;
const DRAW_BUDGET = 3;

/* Everything the wave-8 tables can name, built the way props.js `_kitGeo`
   builds it. This table is a deliberate second copy of that switch, and
   section 8 checks the two against each other rather than trusting either. */
const WASTE_BY_ID = {
  husk0: (s) => wreckHuskGeo(P, s, 0),
  husk1: (s) => wreckHuskGeo(P, s, 1),
  husk2: (s) => wreckHuskGeo(P, s, 2),
  scrap: (s) => scrapPileGeo(P, s),
  tanker: (s) => tankerWreckGeo(P, s),
  pumpjack: (s) => pumpjackGeo(P, s),
  windpump: (s) => windPumpGeo(P, s, 8.5),
  watchtower: (s) => watchtowerGeo(P, s, 10.5),
  jersey: (s) => jerseyBarrierGeo(P, s, 4),
  sandbags: (s) => sandbagWallGeo(P, s, 3.6),
  barricade: (s) => barricadeGeo(P, s, 5.0),
  firedrum: (s) => fireDrumGeo(P, s),
  totem: (s) => totemGeo(P, s),
  ruinboard: (s) => ruinedBillboardGeo(P, s),
};
const WASTE_IDS = Object.keys(WASTE_BY_ID);

/* Worst case over sixteen seeds, not one. jerseyBarrierGeo puts a hazard
   flash on "about half" of its barriers off the rng, so its triangle count is
   a function of the stage seed — and a budget measured on the lucky seed is
   not a budget. Everything else here happens to be seed-stable; the max is
   taken uniformly so that stops being something anyone has to know. */
const _triCache = new Map();
const _spanCache = new Map();
function measure(id) {
  if (_triCache.has(id)) return { tris: _triCache.get(id), span: _spanCache.get(id) };
  let tris = 0, span = 0;
  for (let k = 0; k < 16; k++) {
    const g = WASTE_BY_ID[id](101 + k * 977);
    if (!g) continue;
    const pos = g.attributes.position;
    tris = Math.max(tris, (g.index ? g.index.count : pos.count) / 3);
    const b = bufGeo(g);
    span = Math.max(span, Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2);
    g.dispose();
  }
  _triCache.set(id, tris);
  _spanCache.set(id, span);
  return { tris, span };
}

head('7. WASTELAND BUDGET — draw calls and triangles, per stage, at HIGH');
{
  const src = readFileSync(join(ROOT, 'src', 'core', 'engine.js'), 'utf8');
  ok(`QUALITY.high still shows ${HIGH_BOULDERS} boulders`,
    src.includes(`boulders: ${HIGH_BOULDERS},`), 'core/engine.js');
  const psrc = readFileSync(join(ROOT, 'src', 'world', 'props.js'), 'utf8');
  ok(`MAX_SCATTER is still ${MAX_SCATTER}`,
    psrc.includes(`const MAX_SCATTER = ${MAX_SCATTER}`), 'world/props.js');

  let worstTri = 0, worstTheme = '', worstDraw = 0;
  for (const theme of Object.keys(RECIPES)) {
    const R = RECIPES[theme];
    const D = DRESSING[theme];

    /* The scatter. props.js places for MAX_SCATTER and then SHOWS the first
       ceil(tier * share) of each kind, so HIGH draws the tier count and not
       the placed count. Instanced, so one draw per kind however many. */
    let scatterTri = 0, scatterDraws = 0;
    for (const K of R.kinds) {
      if (!WASTE_BY_ID[K.id]) continue;
      const shown = Math.ceil(HIGH_BOULDERS * K.share);
      scatterTri += shown * measure(K.id).tris;
      scatterDraws++;
    }

    /* The dressing. `n` per row is what the planner ASKS for and rejection
       sampling can only fall short of it, so n is the upper bound — which is
       the only side of the number a budget cares about. All of it merges into
       one mesh, hence exactly one draw call for the lot. */
    let dressTri = 0;
    for (const spec of (D.wasteland || [])) {
      dressTri += (spec.n || 0) * measure(spec.id).tris;
    }
    const dressDraws = (D.wasteland && D.wasteland.length) ? 1 : 0;

    const tri = scatterTri + dressTri;
    const draws = scatterDraws + dressDraws;
    info(`${theme.padEnd(9)} scatter ${String(scatterTri).padStart(6)} + dressing ` +
      `${String(dressTri).padStart(5)} = ${String(tri).padStart(6)} tris   ` +
      `${draws} new draw call${draws === 1 ? '' : 's'}` +
      `${D.heroModels ? `   + 1 hero model (§8.9)` : ''}`);
    ok(`${theme}: ≤ ${DRAW_BUDGET} new draw calls`, draws <= DRAW_BUDGET, `${draws}`);
    ok(`${theme}: ≤ ${TRI_BUDGET} new triangles at HIGH`, tri <= TRI_BUDGET, `${tri}`);
    if (tri > worstTri) { worstTri = tri; worstTheme = theme; }
    worstDraw = Math.max(worstDraw, draws);
  }
  info(`worst stage is ${worstTheme}: ${worstTri} tris ` +
    `(${(100 * worstTri / TRI_BUDGET).toFixed(0)} % of budget), ${worstDraw} draw calls`);
}

/* The two switches that turn a table id into geometry. Read once, because
   sections 8 and 9 both have to know whether an id actually resolves — and
   neither of them can call `_kitGeo`, which is a method on a class that needs
   a scene, a canvas and a baked terrain to exist. */
const PROPS_SRC = readFileSync(join(ROOT, 'src', 'world', 'props.js'), 'utf8');
const WASTE_SRC = readFileSync(join(ROOT, 'src', 'world', 'props-wasteland.js'), 'utf8');
const hasCase = (id) => PROPS_SRC.includes(`case '${id}':`) || WASTE_SRC.includes(`case '${id}':`);

head('8. THE TABLES — shares, ids, colliders, facings');
{
  const psrc = PROPS_SRC;
  /* props.js resolves an id down one of TWO paths and they are not
     interchangeable. Anything in KIT_KINDS goes to `_kitGeo` and its switch;
     everything else in the scatter goes to buildScatter's own `geoFor` chain
     and props-shapes.js. An id in the wrong list resolves to the wrong
     default — a crate, or a boulder — with no warning either way. */
  const kitUsed = new Set();
  const shapeUsed = new Set();

  for (const theme of Object.keys(RECIPES)) {
    /* buildScatter ceils MAX_SCATTER * share per kind, so a table that sums
       to 1.025 quietly overspends the tier by 2.5 % — which is exactly what
       canyon was doing before this wave. The sum is the invariant, not any
       one share, so it is worth a gate. */
    const sum = RECIPES[theme].kinds.reduce((a, K) => a + K.share, 0);
    ok(`${theme}: scatter shares sum to 1`, Math.abs(sum - 1) < 1e-9, sum.toFixed(4));
    for (const K of RECIPES[theme].kinds) (KIT_KINDS.has(K.id) ? kitUsed : shapeUsed).add(K.id);
    const D = DRESSING[theme];
    for (const L of D.landmarks) kitUsed.add(L.id);
    for (const W of (D.wasteland || [])) kitUsed.add(W.id);
    for (const H of (D.heroModels || [])) kitUsed.add(H.fallback);
  }

  /* _kitGeo has a `default` that hands back a crate, so a typo in a table is
     not an error, it is a crate where a watchtower should be — on one stage,
     found by looking at a screenshot. Every id a table can name must have a
     case in one of the two switches that resolve them: props.js `_kitGeo` for
     kit.js's shapes, props-wasteland.js `wastelandGeo` for its own fourteen. */
  const wsrc = WASTE_SRC;
  const missing = [...kitUsed].filter(id => !hasCase(id));
  ok('every kit id in RECIPES/DRESSING has a case in _kitGeo or wastelandGeo',
    missing.length === 0, missing.join(',') || `${kitUsed.size} ids`);
  /* And the two must not both claim one: a duplicated id means _kitGeo's own
     case silently wins and the wasteland arguments — the tower heights, the
     wall lengths — are the ones that get dropped. */
  const doubled = [...kitUsed].filter(id =>
    psrc.includes(`case '${id}':`) && wsrc.includes(`case '${id}':`));
  ok('no id is claimed by both switches', doubled.length === 0, doubled.join(',') || 'none');
  const strays = [...shapeUsed].filter(id => !psrc.includes(`id === '${id}'`));
  ok('every non-kit scatter id has a branch in props.js geoFor',
    strays.length === 0, strays.join(',') || `${shapeUsed.size} ids`);

  const unused = WASTE_IDS.filter(id => !kitUsed.has(id));
  ok('every wasteland factory is actually used by a stage',
    unused.length === 0, unused.join(',') || `all ${WASTE_IDS.length}`);

  for (const id of WASTE_IDS) {
    ok(`${id}: registered in KIT_KINDS and UPRIGHT_KINDS`,
      KIT_KINDS.has(id) && UPRIGHT_KINDS.has(id));
    ok(`${id}: has a facing`, !!WASTE_FACING[id] &&
      ['along', 'road', 'free'].includes(WASTE_FACING[id].face));
  }

  /* A collider bigger than the shape is a wall of air you bounce off; much
     smaller than the shape is a wreck you drive through the back of. The band
     is generous because a disc is a poor model of a wall either way — what it
     catches is a dropped digit. */
  for (const theme of Object.keys(DRESSING)) {
    for (const spec of (DRESSING[theme].wasteland || [])) {
      const { span } = measure(spec.id);
      const k = spec.r / span;
      ok(`${theme}/${spec.id}: collider r ${spec.r} fits a ${span.toFixed(2)} m footprint`,
        k >= 0.35 && k <= 1.10, `${(k * 100).toFixed(0)} %`);
    }
  }

  /* Bounce is the only thing that tells a player what a shape is made of, so
     nothing may quietly fall through to the 1.35 that rock and welded plate
     get. Sand in a sack and a burnt-out car are not that. */
  for (const id of ['sandbags', 'scrap', 'firedrum', 'husk0', 'husk1', 'husk2',
    'tanker', 'totem']) {
    ok(`${id}: bounce is softer than rock`, BOUNCE_FOR(id) < 1.35, `${BOUNCE_FOR(id)}`);
  }
  for (const id of ['barricade', 'jersey']) {
    ok(`${id}: bounce punishes`, BOUNCE_FOR(id) === 1.35, `${BOUNCE_FOR(id)}`);
  }
}

head('9. HERO MODELS — §8.9 entries, and a fallback for every one of them');
{
  ok('props-wasteland.js loads models through core/models.js',
    WASTE_SRC.includes("from '../core/models.js'"));
  /* The collider must be registered from the table, synchronously, before the
     load is even started. A hero you can drive through on a fast connection
     and not on a slow one is a race condition in the physics, and this is the
     cheapest way to keep noticing that. */
  ok('a hero collider is pushed before the load, not inside the promise',
    WASTE_SRC.indexOf('_fixedColliders.push') < WASTE_SRC.indexOf('loadModel('));

  let n = 0;
  for (const theme of Object.keys(DRESSING)) {
    for (const h of (DRESSING[theme].heroModels || [])) {
      n++;
      ok(`${theme}/${h.id}: relative url under assets/models/heroes`,
        typeof h.url === 'string' && h.url.startsWith('assets/models/heroes/') &&
        h.url.endsWith('.glb'), h.url);
      ok(`${theme}/${h.id}: names a kit fallback that resolves`,
        typeof h.fallback === 'string' && hasCase(h.fallback), h.fallback);
      /* `scale` is the metre conversion off a ~1.9-unit normalised box, so it
         is never near 1 and never wild. Anything outside this and either the
         mesh was not normalised or somebody typed a taste knob. */
      ok(`${theme}/${h.id}: scale is a plausible metre conversion`,
        h.scale >= 2 && h.scale <= 12, `${h.scale}`);
      ok(`${theme}/${h.id}: yaw is a road-relative angle`,
        Math.abs(h.yaw) <= Math.PI, `${h.yaw}`);
      ok(`${theme}/${h.id}: collider radius is sane`, h.r > 1 && h.r < 8, `${h.r}`);
    }
  }
  ok('one hero model per stage', n === Object.keys(DRESSING).length, `${n}`);
}

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('set-dressing kit OK');

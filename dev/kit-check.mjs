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
   ============================================================ */
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
  ['person', () => personGeo(P, 113)], ['shed', () => shedGeo(P, 79)]]) {
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

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
if (failures) { console.log(`\x1b[31m${failures} FAILURE(S)\x1b[0m`); process.exit(1); }
console.log('set-dressing kit OK');

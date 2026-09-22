/* ============================================================
   MODEL CHECK — the optional carcass GLBs, gated from their bytes
   ------------------------------------------------------------
   Pure Node. No three, no loader shim: the container is parsed here —
   magic, version, JSON chunk, BIN chunk, accessors — because GLTFLoader
   wants a DOM and because a check that needs the renderer to answer "is
   this file within budget" is not a check you can run before a commit.

       node dev/model-check.mjs            (from the repo root)

   What is gated, per assets/models/*.glb:

     • it parses: GLB 2, JSON + BIN chunks, no Draco / meshopt (models.js
       ships no decoder, so such a file would silently fall back)
     • ≤ 40 k triangles, ≤ 4 textures, each ≤ 2048²
     • FIT — for a file named <id>-carcass.glb with an id in VEHICLES: the
       same carcassFit / wheelZones vehicle-carcass.js applies, run on the
       same vertices. After the strip the body's box must sit within
       0.7–1.4× of dims on every axis, its lowest point must be clear of
       the ground (tyres are the only thing on a car that reaches it), and
       nothing may remain in the tightened wheel cores.

   ABSENT FILES PASS. Assets are optional; a repo with no assets/models is
   a repo drawing its procedural bodies, which is a supported state and
   the QA gate for hard rule 1. assets/models/heroes/ is P4's and is not
   walked — kit-check gates it against its own budget.
   ============================================================ */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEHICLE_BY_ID } from '../src/game/vehicles.js';
import { carcassFit, wheelZones, inWheelZone, toBody } from '../src/game/vehicle-fit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets', 'models');
const MAX_TRIS = 40000, MAX_TEX = 4, MAX_TEX_SIZE = 2048;
const ASPECT_LO = 0.7, ASPECT_HI = 1.4;
/** The stripped body's lowest point, over the ground, in wheel radii. */
const FLOOR_CLEAR = 0.15;
/** Survivors allowed inside the tightened wheel cores, as a fraction. */
const CORE_FRAC = 0.003;

let fails = 0, gates = 0;
const ok = (name, cond, detail = '') => {
  gates++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const info = (s) => console.log('       ' + s);

/* ------------------------------------------------------------------ */
function main() {
  if (!existsSync(DIR)) {
    console.log('model-check: no assets/models — nothing to gate, procedural bodies everywhere. PASS');
    return 0;
  }
  const files = readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.glb$/i.test(d.name))
    .map((d) => d.name).sort();
  if (files.length === 0) {
    console.log('model-check: assets/models is empty — PASS');
    return 0;
  }
  for (const name of files) checkFile(name);
  console.log(`model-check: ${files.length} file(s), ${gates} gate(s), ${fails} failed${fails ? '' : ' — PASS'}`);
  return fails ? 1 : 0;
}

/* ------------------------------------------------------------------ */
function checkFile(name) {
  console.log(name);
  let glb;
  try { glb = parseGlb(readFileSync(join(DIR, name))); }
  catch (e) { ok('parses', false, e.message); return; }
  const { json, bin } = glb;
  ok('parses', true, `${json.asset && json.asset.generator || 'unknown generator'}`);

  const req = json.extensionsRequired || [];
  ok('no decoder needed',
    !req.some((x) => /draco|meshopt/i.test(x)), req.join(', ') || 'no required extensions');

  // ---- geometry -------------------------------------------------------
  let tris = 0;
  const prims = [];                       // { pos: Float32Array (world), idx: index array|null, count }
  try {
    for (const { node, world } of walkNodes(json)) {
      const mesh = json.meshes[node.mesh];
      for (const p of mesh.primitives) {
        const mode = p.mode == null ? 4 : p.mode;
        if (mode < 4) continue;           // points/lines carry no faces
        const pos = readAccessor(json, bin, p.attributes.POSITION);
        const idx = p.indices != null ? readAccessor(json, bin, p.indices).data : null;
        const n = idx ? idx.length : pos.count;
        const count = mode === 4 ? (n / 3) | 0 : Math.max(0, n - 2);
        tris += count;
        const world3 = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) xform(world, pos.data, i, world3);
        prims.push({ pos: world3, n: pos.count, idx, mode });
      }
    }
  } catch (e) { ok('geometry readable', false, e.message); return; }
  ok('geometry readable', true, `${prims.length} primitive(s)`);
  ok(`≤ ${MAX_TRIS} triangles`, tris <= MAX_TRIS, `${tris}`);

  // ---- textures -------------------------------------------------------
  const textures = json.textures || [], images = json.images || [];
  ok(`≤ ${MAX_TEX} textures`, textures.length <= MAX_TEX, `${textures.length}`);
  let texOk = true, texNote = [];
  for (let i = 0; i < images.length; i++) {
    const dim = imageSize(json, bin, images[i]);
    if (!dim) { texOk = false; texNote.push(`image ${i}: unreadable`); continue; }
    texNote.push(`${dim.w}×${dim.h}`);
    if (dim.w > MAX_TEX_SIZE || dim.h > MAX_TEX_SIZE) texOk = false;
  }
  ok(`textures ≤ ${MAX_TEX_SIZE}²`, texOk, texNote.join(' '));

  // ---- fit ------------------------------------------------------------
  const m = /^([a-z0-9]+)-carcass(?:-high)?\.glb$/i.exec(name);
  const spec = m && VEHICLE_BY_ID[m[1]];
  if (!spec) { info('no spec for this name — fit not checked'); return; }

  const raw = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  for (const pr of prims) {
    for (let i = 0; i < pr.n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = pr.pos[i * 3 + c];
        if (v < raw.min[c]) raw.min[c] = v;
        if (v > raw.max[c]) raw.max[c] = v;
      }
    }
  }
  const fit = carcassFit(spec, spec.id, raw);
  const zones = wheelZones(spec, spec.id, fit);
  const cores = zones.map((z) => ({ ...z, r: z.r * 0.85 }));
  const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  let kept = 0, inCore = 0;
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 };
  for (const pr of prims) {
    const tri = triangles(pr);
    for (let t = 0; t < tri.length; t += 3) {
      toBody(fit, pr.pos[tri[t] * 3], pr.pos[tri[t] * 3 + 1], pr.pos[tri[t] * 3 + 2], a);
      toBody(fit, pr.pos[tri[t + 1] * 3], pr.pos[tri[t + 1] * 3 + 1], pr.pos[tri[t + 1] * 3 + 2], b);
      toBody(fit, pr.pos[tri[t + 2] * 3], pr.pos[tri[t + 2] * 3 + 1], pr.pos[tri[t + 2] * 3 + 2], c);
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
      if (inWheelZone(zones, cx, cy, cz)) continue;
      kept++;
      if (inWheelZone(cores, cx, cy, cz)) inCore++;
      for (const p of [a, b, c]) {
        if (p.x < box.min[0]) box.min[0] = p.x; if (p.x > box.max[0]) box.max[0] = p.x;
        if (p.y < box.min[1]) box.min[1] = p.y; if (p.y > box.max[1]) box.max[1] = p.y;
        if (p.z < box.min[2]) box.min[2] = p.z; if (p.z > box.max[2]) box.max[2] = p.z;
      }
    }
  }
  const W = box.max[0] - box.min[0], H = box.max[1] - box.min[1], L = box.max[2] - box.min[2];
  const { dims } = spec;
  const rL = L / dims.L, rW = W / dims.W, rH = H / dims.H;
  info(`fit: yaw ${(fit.yaw * 180 / Math.PI).toFixed(0)}°  scale ${fit.s.toFixed(3)}  ` +
    `offset (${fit.x.toFixed(2)}, ${fit.y.toFixed(2)}, ${fit.z.toFixed(2)}) m  ` +
    `stripped ${tris - kept} of ${tris} tris`);
  info(`body after strip: ${L.toFixed(2)} × ${W.toFixed(2)} × ${H.toFixed(2)} m (L×W×H)` +
    ` = ${rL.toFixed(2)} / ${rW.toFixed(2)} / ${rH.toFixed(2)} of dims`);
  ok('stripped something', tris - kept > 0 || !zonesExpectWheels(spec),
    tris - kept > 0 ? `${tris - kept} tris` : 'no wheel faces found — the fit table may be off');
  const within = (r) => r >= ASPECT_LO && r <= ASPECT_HI;
  ok(`aspect ${ASPECT_LO}–${ASPECT_HI}× dims`, within(rL) && within(rW) && within(rH),
    `L ${rL.toFixed(2)} W ${rW.toFixed(2)} H ${rH.toFixed(2)}`);
  const ground = -spec.comHeight;
  const floor = box.min[1] - ground;
  ok('no tyre reaches the ground', floor >= FLOOR_CLEAR * spec.wheelR,
    `lowest point ${floor.toFixed(2)} m over the ground (needs ${(FLOOR_CLEAR * spec.wheelR).toFixed(2)})`);
  ok('wheel cores empty', inCore <= kept * CORE_FRAC, `${inCore} tris survive inside the cores`);
}

function zonesExpectWheels(spec) { return !!spec; }

/* ------------------------------------------------------------------
   GLB container
   ------------------------------------------------------------------ */
function parseGlb(buf) {
  if (buf.length < 20) throw new Error('too short to be a GLB');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('bad magic (not glTF binary)');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version}, need 2`);
  const total = dv.getUint32(8, true);
  if (total > buf.length) throw new Error(`truncated: header says ${total} bytes, file has ${buf.length}`);
  let off = 12, json = null, bin = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (off + 8 + len > total) throw new Error('chunk runs past the end of the file');
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004E4942) bin = body;
    off += 8 + len;
  }
  if (!json) throw new Error('no JSON chunk');
  if (!json.meshes || !json.meshes.length) throw new Error('no meshes');
  return { json, bin };
}

const COMP = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
  5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readAccessor(json, bin, i) {
  const a = json.accessors[i];
  if (!a) throw new Error(`accessor ${i} missing`);
  if (a.sparse) throw new Error('sparse accessors are not supported');
  const [T, sz] = COMP[a.componentType] || [];
  if (!T) throw new Error(`accessor ${i}: component type ${a.componentType}`);
  const n = NCOMP[a.type];
  const out = new T(a.count * n);
  if (a.bufferView == null) return { data: out, count: a.count, n };   // all zeros, per spec
  const bv = json.bufferViews[a.bufferView];
  if (bv.buffer !== 0 || !bin) throw new Error('geometry lives in an external buffer');
  const stride = bv.byteStride || sz * n;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  if (base + (a.count - 1) * stride + sz * n > bin.length) throw new Error(`accessor ${i} overruns the BIN chunk`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = T === Float32Array ? (o) => dv.getFloat32(o, true)
    : T === Uint32Array ? (o) => dv.getUint32(o, true)
    : T === Uint16Array ? (o) => dv.getUint16(o, true)
    : T === Int16Array ? (o) => dv.getInt16(o, true)
    : T === Uint8Array ? (o) => dv.getUint8(o) : (o) => dv.getInt8(o);
  for (let k = 0; k < a.count; k++) {
    const p = base + k * stride;
    for (let c = 0; c < n; c++) out[k * n + c] = get(p + c * sz);
  }
  return { data: out, count: a.count, n };
}

/** Triangle index list for a primitive, expanding strips and fans. */
function triangles(pr) {
  const n = pr.idx ? pr.idx.length : pr.n;
  const at = (i) => (pr.idx ? pr.idx[i] : i);
  if (pr.mode === 4) {
    const out = new Uint32Array(n - (n % 3));
    for (let i = 0; i < out.length; i++) out[i] = at(i);
    return out;
  }
  const out = new Uint32Array(Math.max(0, n - 2) * 3);
  for (let i = 0; i + 2 < n; i++) {
    if (pr.mode === 5) {                       // strip, alternating winding
      out[i * 3] = at(i); out[i * 3 + 1] = at(i + 1 + (i & 1)); out[i * 3 + 2] = at(i + 2 - (i & 1));
    } else {                                   // fan
      out[i * 3] = at(0); out[i * 3 + 1] = at(i + 1); out[i * 3 + 2] = at(i + 2);
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   node tree → world matrices (column-major, like glTF)
   ------------------------------------------------------------------ */
function* walkNodes(json) {
  const scene = json.scenes ? json.scenes[json.scene || 0] : null;
  const roots = scene ? scene.nodes || [] : (json.nodes || []).map((_, i) => i);
  const stack = roots.map((i) => [i, IDENT]);
  const seen = new Set();
  while (stack.length) {
    const [i, parent] = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const node = json.nodes[i];
    const world = mul(parent, localMatrix(node));
    if (node.mesh != null) yield { node, world };
    for (const ch of node.children || []) stack.push([ch, world]);
  }
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function localMatrix(n) {
  if (n.matrix) return n.matrix;
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
    (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
    (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function xform(m, p, i, out) {
  const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
  out[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/* ------------------------------------------------------------------
   image dimensions from the header bytes — PNG IHDR, JPEG SOFn
   ------------------------------------------------------------------ */
function imageSize(json, bin, im) {
  let bytes = null;
  if (im.bufferView != null) {
    const bv = json.bufferViews[im.bufferView];
    if (bv.buffer !== 0 || !bin) return null;
    bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  } else if (im.uri && im.uri.startsWith('data:')) {
    const comma = im.uri.indexOf(',');
    bytes = Buffer.from(im.uri.slice(comma + 1), 'base64');
  } else return null;                          // external file: not a single-file GLB
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      const mk = bytes[p + 1];
      if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { p += 2; continue; }
      const len = bytes.readUInt16BE(p + 2);
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
        return { h: bytes.readUInt16BE(p + 5), w: bytes.readUInt16BE(p + 7) };
      }
      p += 2 + len;
    }
  }
  return null;
}

// Last, after every table above is initialised (module consts are not hoisted).
process.exit(main());

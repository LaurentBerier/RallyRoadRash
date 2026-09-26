import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MODEL_FIT, carcassFit, toBody, clearBodyArches } from '../src/game/vehicle-fit.js';
import { VEHICLE_BY_ID } from '../src/game/vehicles.js';
const b = fs.readFileSync(new URL('../assets/models/ridgeback-custom.glb', import.meta.url));
const length = b.readUInt32LE(12), json = JSON.parse(b.subarray(20, 20 + length));
const primitive = json.meshes[0].primitives[0];
function accessor(id) {
  const a = json.accessors[id], view = json.bufferViews[a.bufferView];
  return { ...a, offset: 28 + length + (view.byteOffset || 0) + (a.byteOffset || 0), stride: view.byteStride };
}
const pos = accessor(primitive.attributes.POSITION), idx = accessor(primitive.indices);
const spec = VEHICLE_BY_ID.ridgeback, fit = carcassFit(spec, 'ridgeback-custom', pos);
const vertices = Array.from({length: pos.count}, (_, i) => {
  const o = {};
  toBody(fit, ...[0,1,2].map(k => b.readFloatLE(pos.offset + i*(pos.stride || 12) + k*4)), o);
  return clearBodyArches(o, spec, MODEL_FIT['ridgeback-custom'].archClearance);
});
const index = i => idx.componentType === 5125 ? b.readUInt32LE(idx.offset + i*4) : b.readUInt16LE(idx.offset + i*2);
let minimum = Infinity, checked = 0;
for (let i=0; i<idx.count; i+=3) {
  const [a,c,d] = [0,1,2].map(k => vertices[index(i+k)]);
  for(let u=0;u<=6;u++) for(let v=0;v<=6-u;v++) {
    const p={};for(const axis of ['x','y','z']) p[axis]=(a[axis]*u+c[axis]*v+d[axis]*(6-u-v))/6;
    if(Math.abs(Math.abs(p.x)-spec.track)>spec.wheelW*.6) continue;
    for(const axle of [spec.wheelbase.front,spec.wheelbase.rear]) {
      const distance=Math.hypot(p.z-axle,p.y-(spec.wheelR-spec.comHeight+.08));
      minimum=Math.min(minimum,distance); checked++;
    }
  }
}
assert(checked>1000);
assert(minimum>spec.wheelR*1.1, `Body penetrates tyre tread envelope: ${minimum}`);
console.log(`Ridgeback: ${checked} surface samples, ${(minimum-spec.wheelR*1.1).toFixed(3)} m minimum clearance beyond tyre tread.`);

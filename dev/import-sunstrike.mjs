// Preserve the source export; remove its baked launcher above the roof so the
// existing animated ammo/weapon rig remains the single gameplay attachment.
import {readFileSync,writeFileSync} from 'node:fs';
const source=process.argv[2];
if(!source)throw Error('Pass the original Meshy GLB path');
const bytes=readFileSync(source),jsonLength=bytes.readUInt32LE(12);
const j=JSON.parse(bytes.subarray(20,20+jsonLength)),bin=Buffer.from(bytes.subarray(28+jsonLength));
const p=j.meshes[0].primitives[0],pos=j.accessors[p.attributes.POSITION],pv=j.bufferViews[pos.bufferView];
const idx=j.accessors[p.indices],iv=j.bufferViews[idx.bufferView];
const base=(iv.byteOffset||0)+(idx.byteOffset||0),size=idx.componentType===5125?4:2;
const read=size===4?'readUInt32LE':'readUInt16LE',write=size===4?'writeUInt32LE':'writeUInt16LE';
const y=i=>bin.readFloatLE((pv.byteOffset||0)+(pos.byteOffset||0)+i*(pv.byteStride||12)+4);
const kept=[];for(let n=0;n<idx.count;n+=3){const tri=[0,1,2].map(k=>bin[read](base+(n+k)*size));if(tri.every(i=>y(i)<.245))kept.push(...tri);}
const removed=(idx.count-kept.length)/3;kept.forEach((v,i)=>bin[write](v,base+i*size));idx.count=kept.length;idx.min=[Math.min(...kept)];idx.max=[Math.max(...kept)];
j.asset.extras={...j.asset.extras,sunstrikeImport:{removedLauncherTriangles:removed,cutHeight:.245}};
const json=Buffer.from(JSON.stringify(j)),jl=Math.ceil(json.length/4)*4,bl=Math.ceil(bin.length/4)*4;
const out=Buffer.alloc(28+jl+bl);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(jl,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(32,20,20+jl);json.copy(out,20);out.writeUInt32LE(bl,20+jl);out.writeUInt32LE(0x004e4942,24+jl);bin.copy(out,28+jl);
writeFileSync('assets/models/hopper-sunstrike.glb',out);console.log({removed,triangles:kept.length/3});

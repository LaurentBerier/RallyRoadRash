import assert from 'node:assert/strict';
import * as THREE from 'three';
import {bakeTrack,Terrain} from '../src/world/terrain.js';
import thunder from '../src/world/tracks/thunder.js';
import {THEMES} from '../src/world/terrain-shader.js';
import {SKY_THEMES} from '../src/world/sky.js';
import {buildThunderPolish} from '../src/world/thunder-polish.js';
import {rockMaterial} from '../src/world/props-shapes.js';
import {buildCanyonVista} from '../src/world/canyon-vista.js';
const noop=()=>{};
globalThis.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:noop})})};
const bake=bakeTrack(thunder);let result;do{result=bake.next();}while(!result.done);
const terrain=Object.assign(Object.create(Terrain.prototype),result.value,{dentAt:()=>0});
const owned=[],p={data:result.value.trackData,terrain,def:thunder,group:new THREE.Group(),rockMat:rockMaterial(0x805940,0xa88e6d),
 _keepGeo:g=>(owned.push(g),g),_keepMat:m=>(owned.push(m),m),_keepTex:t=>(owned.push(t),t),
 _canPlace:(x,z)=>terrain.onRoad(x,z)<.015,_clearOfClaims:()=>true};
assert.deepEqual(THEMES.thunder.sun,Object.values(SKY_THEMES.thunder.sunDir),'terrain bake and rendered shadows use the same sun');
const before=terrain.heightAt(0,150);buildThunderPolish(p);
assert.equal(terrain.heightAt(0,150),before,'decorative pass cannot alter jump/physics heights');
assert.ok(p.thunderPolish.posts>10 && p.thunderPolish.bulbs>30);
const camera=new THREE.PerspectiveCamera();camera.position.set(0,4,20);
p.thunderPolish.update(1/60,camera);
p.group.traverse(o=>{
 if(o.isInstancedMesh){const m=new THREE.Matrix4();for(let i=0;i<o.count;i++){o.getMatrixAt(i,m);assert.ok(m.elements.every(Number.isFinite));}}
 if(o.isLineSegments){const a=o.geometry.attributes.position;for(let i=0;i<a.count;i++) assert.ok(terrain.onRoad(a.getX(i),a.getZ(i))<.03,'festoon cables never cross the driving corridor');}
});
assert.equal(p.thunderPolish.sheets,28,'wind VFX has a fixed resource budget');
const start=p.group.children.length;buildCanyonVista(p);
for(const mesh of p.group.children.slice(start)){
  mesh.updateMatrixWorld(true);
  const a=mesh.geometry.attributes.position;
  for(let i=0;i<96;i++){
    const v=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(mesh.matrixWorld);
    assert.ok(terrain.heightAt(v.x,v.z)-v.y>35,'vista perimeter remains buried in Thunder terrain');
    const n=p.data.spline.nearest(v.x,v.z,{});
    assert.ok(n.d>p.data.spline.widthAt(n.s)+100,'vista cannot intersect a jump or racing line');
  }
}
p.group.traverse(o=>{if(o.isInstancedMesh)o.dispose();});for(const r of owned)r.dispose();p.rockMat.dispose();
console.log('Thunder Park: synchronized sun, safe cables, finite instances, unchanged physics and bounded VFX pass.');

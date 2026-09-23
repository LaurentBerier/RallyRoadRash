import assert from 'node:assert/strict';
import * as THREE from 'three';
import {bakeTrack,Terrain} from '../src/world/terrain.js';
import {TRACKS} from '../src/world/tracks/index.js';
import {buildVolcanoGeology} from '../src/world/volcano-geology.js';
const def=TRACKS.find(t=>t.id==='volcano'),gen=bakeTrack(def);let result;
do{result=gen.next();}while(!result.done);
const terrain=Object.assign(Object.create(Terrain.prototype),result.value,{dentAt:()=>0});
const resources=[],p={def,terrain,data:result.value.trackData,group:new THREE.Group(),_fixedColliders:[],_claimed:[],
 _keepGeo:g=>(resources.push(g),g),_keepMat:m=>(resources.push(m),m),
 _canPlace:(x,z)=>terrain.onRoad(x,z)<.05,
 _clearOfClaims(x,z,r){return this._claimed.every(c=>Math.hypot(x-c.x,z-c.z)>r+c.r);}};
buildVolcanoGeology(p);
for(const mesh of p.group.children.filter(m=>!m.isInstancedMesh)) {
 mesh.updateMatrixWorld(true);
 for(let i=0;i<96;i++)for(let j=0;j<5;j++) {
  const a=mesh.geometry.attributes.position,v=new THREE.Vector3().fromBufferAttribute(a,i).lerp(new THREE.Vector3().fromBufferAttribute(a,i+1),j/5).applyMatrix4(mesh.matrixWorld);
  assert(terrain.heightAt(v.x,v.z)-v.y>30,'buttress perimeter buried in actual terrain');
  const near=p.data.spline.nearest(v.x,v.z,{});
  assert(near.d>p.data.spline.widthAt(near.s)+100,'distant cliff clears course');
 }
}
assert(p._fixedColliders.length>20,'basalt formations distributed around course');
for(const c of p._fixedColliders){const n=p.data.spline.nearest(c.x,c.z,{});assert(n.d>p.data.spline.widthAt(n.s)+c.r+10,'basalt collider outside racing corridor');}
resources.forEach(r=>r.dispose());
console.log('Volcanic cliff foundations and column clearance verified against baked course.');

import {gateTerrainProfile} from '../src/world/grounding.js';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {bakeTrack,Terrain} from '../src/world/terrain.js';
import {TRACKS} from '../src/world/tracks/index.js';
import {buildCanyonVista} from '../src/world/canyon-vista.js';
const gen=bakeTrack(TRACKS.find(t=>t.id==='canyon'));let step;
do {step=gen.next();} while(!step.done);
const terrain=Object.assign(Object.create(Terrain.prototype),step.value,{dentAt:()=>0});
const owned=[],p={terrain,group:new THREE.Group(),_keepGeo:g=>(owned.push(g),g),_keepMat:m=>(owned.push(m),m)};
buildCanyonVista(p);let minBurial=Infinity;
for(const mesh of p.group.children) {
 mesh.updateMatrixWorld(true);
 const a=mesh.geometry.attributes.position;
 // Every point on every perimeter edge, not only the mesh origin.
 for(let i=0;i<96;i++)for(let j=0;j<=8;j++) {
   const v=new THREE.Vector3().fromBufferAttribute(a,i).lerp(new THREE.Vector3().fromBufferAttribute(a,i+1),j/8).applyMatrix4(mesh.matrixWorld);
   const burial=terrain.heightAt(v.x,v.z)-v.y;minBurial=Math.min(minBurial,burial);
   assert(burial>35,'mesa perimeter must be buried under actual baked terrain');
 }
 const sp=step.value.trackData.spline;
 for(let i=0;i<96;i++) {
   const v=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(mesh.matrixWorld),n=sp.nearest(v.x,v.z,{});
   assert(n.d>sp.widthAt(n.s)+100,'mesa footprint clears the entire course');
 }
}
owned.forEach(o=>o.dispose());
console.log(`14 mesas: all perimeter edges grounded; minimum burial ${minBurial.toFixed(1)} m; full-course clearance passed.`);

const sp=step.value.trackData.spline;
for(const c of step.value.trackData.checkpoints.filter(c=>c.big&&!c.alt)) {
 const span=sp.widthAt(c.s)*2+2.6,fit=gateTerrainProfile(terrain,sp,c,span);
 for(let j=0;j<=24;j++) {
  const t=j/24,p=sp.offsetPoint(c.s,(t-.5)*span,{});
  const bottom=terrain.heightAt(c.x,c.z)+fit.left+(fit.right-fit.left)*t+3.55+fit.lift;
  assert(bottom-terrain.heightAt(p.x,p.z)>3.54,'banked checkpoint banner must clear ground across its full span');
 }
}
console.log('Every canyon checkpoint banner clears its banked roadbed.');

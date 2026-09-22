import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Vehicle} from '../src/game/vehicle.js';
import {VEHICLES} from '../src/game/vehicles.js';
import {GARAGE_PAD} from '../src/ui/garage-viewport.js';
import {addShowroomDetails} from '../src/ui/garage-vehicle-detail.js';
import {buildGarageInterior} from '../src/ui/garage-interior.js';
import {tireWear} from '../src/game/vehicle-wear.js';
const noop=()=>{};
const imageData=(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)});
const ctx=new Proxy({}, {get:(_,k)=>{
 if(k==='createLinearGradient'||k==='createRadialGradient')return ()=>({addColorStop:noop});
 if(k==='measureText')return ()=>({width:10});
 if(k==='createImageData')return imageData;
 if(k==='getImageData')return (x,y,w,h)=>imageData(w,h);
 return noop;
}});
globalThis.document={createElement:()=>({width:0,height:0,style:{},getContext:()=>ctx})};
const scene=new THREE.Scene();
for(const spec of VEHICLES){
 const v=new Vehicle(scene,GARAGE_PAD,spec,{livery:0});v.placeAt(0,0,0);
 for(let i=0;i<120;i++){v.step(1/60,{throttle:0,steer:0,brake:0,handbrake:0,roll:0});v.updateVisuals(1/60);}
 assert.ok(Number.isFinite(v.pos.y));
 assert.equal(v.mats.tyre.map,tireWear().map,`${spec.id}: race tires share the dirt albedo`);
 assert.equal(v.mats.tyre.color.getHex(),0xffffff,'dust must not be darkened by a black tint');
 for(const key of ['metal','dark','spring','arsenal']) {
  assert.ok(v.mats[key].map?.isDataTexture,`${spec.id}: ${key} has baked dirt detail`);
  assert.ok(v.mats[key].roughnessMap,`${spec.id}: ${key} has roughness variation`);
 }
 if(spec.bodyStyle!=='bike')for(const wheel of v.wheels){
  assert.ok(wheel.coilRoot.y<wheel.mount.y,`${spec.id}: shock pickup stays below shell mount`);
  assert.ok(Math.abs(wheel.coilRoot.x)>spec.track*.4,`${spec.id}: shock sits outboard`);
 }
 const remove=addShowroomDetails(v);let instanced=0;
 v.root.traverse(o=>{if(o.isInstancedMesh){instanced++;o.computeBoundingSphere();assert.ok(Number.isFinite(o.boundingSphere.radius));assert.equal(o.material.map,tireWear().map);assert.equal(o.material.color.getHex(),0xffffff);}});
 assert.equal(instanced,spec.bodyStyle==='bike'?2:4);
 remove();assert.equal(v.chassis.getObjectByName('showroom-machined-details'),undefined);v.dispose();
}
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({fillText(){}})})};
const room=buildGarageInterior();const bounds=new THREE.Box3().setFromObject(room);
assert.ok(bounds.max.y>=12);assert.ok(bounds.max.x>=12&&bounds.min.x<=-12);
assert.ok(room.children.length<20,'architecture should be batched by material');
let disposed=0;room.traverse(o=>o.geometry?.addEventListener('dispose',()=>disposed++));room.userData.dispose();assert.equal(disposed,room.children.length);
console.log('PASS: all four parked vehicles, detailed wheel bounds, detail cleanup, tall room bounds and batched geometry disposal');

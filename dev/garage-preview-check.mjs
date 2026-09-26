import assert from 'node:assert/strict';
import * as THREE from 'three';
import {setExhaustAtlas} from '../src/game/vehicle-art.js';
import {Vehicle} from '../src/game/vehicle.js';
import {VEHICLES} from '../src/game/vehicles.js';
import {GARAGE_PAD,groundGarageVehicle} from '../src/ui/garage-viewport.js';
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
const atlas=new THREE.DataTexture(new Uint8Array(16).fill(255),4,1);setExhaustAtlas(atlas);
const scene=new THREE.Scene();
for(const spec of VEHICLES){
 const v=new Vehicle(scene,GARAGE_PAD,spec,{livery:0});v.placeAt(0,0,0);
 for(let i=0;i<120;i++){v.step(1/60,{throttle:0,steer:0,brake:0,handbrake:0,roll:0});v.updateVisuals(1/60);}
 assert.equal(v.exhaust.material.map,atlas,'one shared flame atlas');
 assert.equal(v.exhaust.geometry.index.count,12,'two crossed quads replace cone');
 assert.ok(v._flameFrame>=0&&v._flameFrame<4);
 assert.ok(Number.isFinite(v.pos.y));
 const parked=v.wheels.map(w=>w.displaySpin||0);
 for(let i=0;i<240;i++){v.step(1/60,{throttle:0,steer:0,brake:1,handbrake:1,roll:0});v.updateVisuals(1/60);}
 for(let i=0;i<v.wheels.length;i++){
   assert.ok(Math.abs(v.wheels[i].spinVel)<.01,`${spec.id}: brakes cannot propel stationary wheels`);
   assert.equal(v.wheels[i].displaySpin||0,parked[i],`${spec.id}: stationary wheel picture stays fixed`);
 }

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
 groundGarageVehicle(v);v.root.updateMatrixWorld(true);
 const low=Math.min(...v.wheels.filter(w=>w.obj.visible).map(w=>new THREE.Box3().setFromObject(w.obj).min.y));
 assert.ok(Math.abs(low-.025)<1e-5,`${spec.id}: tyres sit above the floor`);
 groundGarageVehicle(v,.15);v.root.updateMatrixWorld(true);
 const splatLow=Math.min(...v.wheels.filter(w=>w.obj.visible).map(w=>new THREE.Box3().setFromObject(w.obj).min.y));
 assert.ok(Math.abs(splatLow-.15)<1e-5,`${spec.id}: all treads clear raised splat floor detail`);

 remove();assert.equal(v.chassis.getObjectByName('showroom-machined-details'),undefined);v.dispose();
}
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({fillText(){}})})};
const room=buildGarageInterior();const bounds=new THREE.Box3().setFromObject(room);
assert.ok(bounds.max.y>=12);assert.ok(bounds.max.x>=12&&bounds.min.x<=-12);
assert.ok(room.children.length<20,'architecture should be batched by material');
let disposed=0;room.traverse(o=>o.geometry?.addEventListener('dispose',()=>disposed++));room.userData.dispose();assert.equal(disposed,room.children.length);
console.log('PASS: all four parked vehicles, detailed wheel bounds, detail cleanup, tall room bounds and batched geometry disposal');

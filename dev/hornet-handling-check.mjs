import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Vehicle,resolveVehiclePair} from '../src/game/vehicle.js';
import {VEHICLES,VEHICLE_BY_ID} from '../src/game/vehicles.js';
import {SURF} from '../src/world/surfaces.js';
import {buildMuffler} from '../src/game/vehicle-exhaust.js';
import {buildArsenalRig,updateArsenalRig} from '../src/game/vehicle-carcass.js';
const terrain={heightAt:()=>0,normalAt:(x,z,e,out)=>out.set(0,1,0),surfaceAt:()=>SURF.DIRT,onRoad:()=>1};
const ctl=(throttle=0,steer=0,brake=0)=>({throttle,steer,brake,handbrake:0});
const make=S=>{const v=new Vehicle(null,terrain,S,{headless:true});v.placeAt(0,0,0);return v;};
const results=[];
for(const S of VEHICLES){
  let v=make(S),t=0;
  while(v.speed<30&&t<10){v.step(1/60,ctl(1));t+=1/60;}
  const accel=t;
  v=make(S);v.vel.set(0,0,18);for(const w of v.wheels)w.spinVel=18/S.wheelR;
  let yaw=0,speed=0;
  for(let i=0;i<540;i++){
    v.step(1/60,ctl(v.speed<18?.55:0,1));
    if(i>360){yaw+=Math.abs(v.omega.dot(v.up));speed+=v.speed;}
  }
  results.push({id:S.id,accel,radius:speed/yaw,top:S.topSpeed});
  const model={spec:S,tex:{},mats:{},geos:[],chassis:new THREE.Group(),exhaust:new THREE.Object3D()};
  model.exhaust.position.set(.3,.2,-1);buildMuffler(model);
  assert.ok(model._muffler.position.equals(model.exhaust.position),'muffler mouth follows flame origin');
  assert.equal(model._muffler.children.length,5);
  assert.ok(model.mats.exhaustRust.map===model.tex.exhaustRust);
  model.geos.forEach(g=>g.dispose());Object.values(model.mats).forEach(m=>m.dispose());model.tex.exhaustRust.dispose();
}
const bike=results.find(r=>r.id==='moto');
for(const car of results.filter(r=>r.id!=='moto')){
  assert.ok(bike.accel<car.accel,'Hornet accelerates to the same speed sooner');
  assert.ok(bike.radius<car.radius,'Hornet turns tighter at race speed');
  assert.ok(bike.top>car.top,'Hornet has the highest clean-air speed');
}
const a=make(VEHICLE_BY_ID.moto),b=make(VEHICLE_BY_ID.ridgeback);
const mount={chassis:new THREE.Group(),geos:[],ammo:6};
const material=new THREE.MeshStandardMaterial();
buildArsenalRig(mount,VEHICLE_BY_ID.moto,{arsenal:material,dark:material});
assert.equal(mount._muzzles.length,2,'bike has two working muzzle anchors');
assert.equal(mount._muzzles[0].position.x,-mount._muzzles[1].position.x,'launchers mirror across body');
assert.ok(mount._rack.every(r=>Math.abs(r.position.x)<=.28),'ammo stays tucked against bike');
updateArsenalRig(mount);const first=mount._muzzle;
mount.ammo=5;updateArsenalRig(mount);
assert.notEqual(mount._muzzle,first,'successive shots alternate launchers');
assert.equal(mount._rack.filter(r=>r.visible).length,5,'rack still reflects remaining ammunition');
mount.geos.forEach(g=>g.dispose());material.dispose();
a.placeAt(0,-2,0);b.placeAt(0,2,Math.PI);a.vel.set(0,0,15);b.vel.set(0,0,-15);
let hit=0,ratio=0;
for(let i=0;i<60&&!hit;i++){
  a.step(1/60,ctl());b.step(1/60,ctl());
  const av=a.vel.clone(),bv=b.vel.clone();hit=resolveVehiclePair(a,b);
  if(hit)ratio=a.vel.distanceTo(av)/b.vel.distanceTo(bv);
}
assert.ok(hit>20&&ratio>6,'light bike remains over six times more vulnerable to collision impulse');
console.table(results);console.log(`Hornet handling, exhaust alignment and collision vulnerability passed (${ratio.toFixed(2)}x truck delta-v).`);

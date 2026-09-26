import assert from 'node:assert/strict';
import {rocketRecoveryTarget,safeRecoveryS} from '../src/game/recovery.js';
import {RaceTracker} from '../src/game/racecore.js';
import {bakeTrack,Terrain} from '../src/world/terrain.js';
import {TRACKS} from '../src/world/tracks/index.js';
assert.ok(Math.abs(rocketRecoveryTarget(100,{liveS:100},{liveS:145},145,1000)-109.35)<1e-6);
assert.equal(rocketRecoveryTarget(100,{liveS:100},{liveS:95},95,1000),100);
assert.equal(rocketRecoveryTarget(100,{liveS:100},{liveS:1145},145,1000),100);
assert.ok(Math.abs(rocketRecoveryTarget(980,{liveS:980},{liveS:1020},20,1000)-986.6)<1e-6);
assert.equal(rocketRecoveryTarget(100,{liveS:100},null,NaN,1000),100);
const flat={length:1000,posAt(s,p){Object.assign(p,{x:s,y:0,z:0});},dirAt(s,p){Object.assign(p,{x:1,z:0});}};
const tr={lastSlotOf:()=>({s:0}),nextSlotOf:()=>({s:200})};
const base={target:160,tracker:tr,id:0,spline:flat,terrain:{heightAt:()=>0}};
assert.equal(safeRecoveryS({...base,target:990}),3,'target behind last gate cannot jump forward');
assert.ok(safeRecoveryS({...base,target:260})<200,'never skip pending checkpoint');
assert.ok(safeRecoveryS({...base,jumps:[{s:150,len:15,gap:25},{s:195,len:15,gap:25}]})<113,'avoid consecutive jump corridor');
assert.ok(safeRecoveryS({...base,terrain:{heightAt:x=>x>140?-15:0}})<140,'avoid ditch and require runout');
assert.ok(safeRecoveryS({...base,colliders:[{x:160,z:0,r:5}]})<150,'avoid obstacle');
let checked=0;
for(const def of TRACKS){
 const gen=bakeTrack(def);let r;do{r=gen.next();}while(!r.done);
 const terrain=Object.assign(Object.create(Terrain.prototype),r.value,{dentAt:()=>0});
 const d=r.value.trackData,L=d.spline.length;
 const tracker=new RaceTracker({ids:[0],laps:3,lapLength:L,checkpoints:d.checkpoints,spline:d.spline,routes:d.routes});
 for(let s=0;s<L;s+=2){
  const p=d.spline.posAt(s,{});tracker.update(0,p.x,p.z,s/30);
  if(s%40)continue;
  const next=tracker.nextSlotOf(0).s,from=tracker.lastSlotOf(0).s;
  const point=safeRecoveryS({target:(s+45)%L,tracker,id:0,spline:d.spline,jumps:d.jumps,terrain});
  assert.notEqual(point,null,`${def.id} at ${s}: recovery exists`);
  const delta=(point-from+L)%L,span=(next-from+L)%L||L;
  assert.ok(delta<span || L-delta<250,`${def.id}: only legal interval or backward retreat`);
  checked++;
 }
}
console.log(`Recovery: ${checked} baked-track positions, checkpoint safety, jumps, ditch, obstacles and attacker fairness passed.`);


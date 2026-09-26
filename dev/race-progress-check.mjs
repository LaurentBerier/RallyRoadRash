import assert from 'node:assert/strict';
import {RaceTracker} from '../src/game/racecore.js';
import {buildTrackData,raceCorridorHalfWidth} from '../src/world/track.js';
import {TRACKS} from '../src/world/tracks/index.js';
const tracker=(d,ids=['player'])=>new RaceTracker({ids,laps:3,lapLength:d.spline.length,checkpoints:d.checkpoints,spline:d.spline,routes:d.routes});
for(const def of TRACKS){
 const d=buildTrackData(def),L=d.spline.length;
 for(const side of [-1,1]){
  const tr=tracker(d,['player','rival']);
  for(let s=0;s<L+10;s+=.6){
   for(const id of ['player','rival']){
    const at=s-(id==='rival'?30:0);
    const lateral=id==='player'?side*(raceCorridorHalfWidth(d.spline,d.jumps,at)-2):0;
    const p=d.spline.offsetPoint(at,lateral,{});
    tr.update(id,p.x,p.z,s/30);
   }
   assert.equal(tr.progress('player').wrongWay,false,`${def.id}: legal shoulder direction at ${s}`);
   if(s>60)assert.equal(tr.position('player'),1,`${def.id}: leader on shoulder at ${s}`);
  }
  assert.equal(tr.progress('player').lap,1,`${def.id}: full shoulder lap`);
 }
 // A genuinely missed gate must not corrupt heading, or allow a free lap.
 const tr=tracker(d);let time=0;
 for(let s=300;s<600;s+=.6){const p=d.spline.posAt(s,{});tr.update('player',p.x,p.z,time);time+=.02;assert.equal(tr.progress('player').wrongWay,false);}
 assert.equal(tr.progress('player').lap,0);
 for(let s=600;s>480;s-=.6){const p=d.spline.posAt(s,{});tr.update('player',p.x,p.z,time);time+=.02;}
 assert.equal(tr.progress('player').wrongWay,true,`${def.id}: actual reverse detected`);
 const next=tr.nextSlotOf('player');assert.equal(tr.safeRespawnS('player',next.s+30),3,'cannot spawn beyond an uncleared gate');
 for(const route of d.routes){
  const tr=tracker(d);let t=0;
  for(let s=0;s<route.s0;s+=.6){const p=d.spline.posAt(s,{});tr.update('player',p.x,p.z,t);t+=.02;}
  for(let s=0;s<=route.spline.length;s+=.6){const p=route.spline.posAt(s,{});tr.update('player',p.x,p.z,t);t+=.02;assert.equal(tr.progress('player').wrongWay,false,`${def.id}/${route.id} direction`);}
  for(let s=route.s1;s<L+10;s+=.6){const p=d.spline.posAt(s,{});tr.update('player',p.x,p.z,t);t+=.02;}
  assert.equal(tr.progress('player').lap,1,`${def.id}/${route.id} valid alternate lap`);
 }
}
const gates=[{idx:0,s:0,x:0,z:0,r:2},{idx:1,s:100,x:100,z:0,r:2},{idx:2,s:200,x:200,z:0,r:2}];
const fast=new RaceTracker({ids:[0],checkpoints:gates,lapLength:300});
fast.update(0,94,1.8,0);fast.update(0,106,1.8,.2);assert.equal(fast.progress(0).nextCp,2,'swept near-edge hit');
const tele=new RaceTracker({ids:[0],checkpoints:gates,lapLength:300});
tele.update(0,94,1.8,0);tele.notifyTeleport(0,106,1.8);tele.update(0,106,1.8,.2);assert.equal(tele.progress(0).nextCp,1,'teleport cannot clear a gate');
console.log('Race progress: full-corridor leads on all 5 tracks, all alternates, reverse detection, sweeps and safe respawns passed.');

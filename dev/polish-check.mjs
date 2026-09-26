import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Props} from '../src/world/props.js';
import {bakeTrack,Terrain} from '../src/world/terrain.js';
import {TRACKS} from '../src/world/tracks/index.js';
import {Dust,DUST_KIND} from '../src/world/dust.js';
const noop=()=>{};
const ctx=new Proxy({}, {get:(_,k)=>k==='createLinearGradient'||k==='createRadialGradient'?()=>({addColorStop:noop}):k==='measureText'?()=>({width:10}):k==='createImageData'||k==='getImageData'?(w,h)=>({data:new Uint8ClampedArray((w||128)*(h||128)*4)}):noop});
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>ctx})};
for(const def of TRACKS){
 const gen=bakeTrack(def);let r;do{r=gen.next();}while(!r.done);
 const terrain=Object.assign(Object.create(Terrain.prototype),r.value,{dentAt:()=>0});
 const p={data:r.value.trackData,terrain,theme:def.theme,environmentAssets:{},postMat:new THREE.MeshBasicMaterial(),group:new THREE.Group(),_fixedColliders:[],_keepGeo:g=>g,_keepTex:t=>t,_keepMat:m=>m};
 Props.prototype.buildGates.call(p,'#ffaa22');
 for(const gate of p.gates){
  const banner=gate.children[2];assert.equal(banner.rotation.z,0,'level banner');
  const span=banner.geometry.parameters.width;const s=p.data.spline.nearest(gate.position.x,gate.position.z,{}).s;
  for(let i=0;i<=12;i++){
   const q=p.data.spline.offsetPoint(s,(i/12-.5)*span,{});
   assert.ok(gate.position.y+banner.position.y-.45-terrain.heightAt(q.x,q.z)>5,'banner clears whole terrain span');
  }
 }
}
const dust=new Dust(new THREE.Scene(),null,null,20);
dust.spawn(8,0,0,0,1,0,0,0,.6,.5,.4,DUST_KIND.CLOD);
assert.equal(dust.n,8);assert.ok(dust.col[0]<.3);assert.ok(dust.vel[1]>=1.65);
dust.burst(0,0,0,0,2);assert.equal(dust.n,20,'landing burst respects mobile particle cap');dust.dispose();
console.log('polish-check: level gates clear all five tracks; darker airborne debris respects pool cap');

const shadowDust=new Dust(new THREE.Scene(),{surfaceAt:()=>1,sunVis:()=>0},new THREE.Vector3(.72,.34,.60),20,'thunder');
const shaded=[...shadowDust.groundColorAt(12,18)];
shadowDust.terrain.sunVis=()=>1;
const lit=[...shadowDust.groundColorAt(12,18)];
assert.ok(shaded[0]<lit[0]*.5&&shaded[2]/shaded[0]>lit[2]/lit[0],'terrain shadow makes dust darker and cooler');
shadowDust.dispose();

const collision={colliders:[],barriers:[{ax:-10,az:0,bx:10,bz:0,r:.45,maxY:1.15}]};
Props.prototype._buildBroadphase.call(collision);
const probe={pos:new THREE.Vector3(0,4,.2),vel:new THREE.Vector3(0,0,-5),collideR:.3};
Props.prototype.resolve.call(collision,probe);assert.equal(probe.pos.z,.2,'airborne rockets clear finite rail');
probe.pos.y=.5;Props.prototype.resolve.call(collision,probe);assert.ok(probe.pos.z>.2,'ground-level objects still collide with rail');

const {RaceFX}=await import('../src/game/racefx.js');
const {themePalette}=await import('../src/world/terrain-shader.js');
const localDust=new Dust(new THREE.Scene(),{surfaceAt:x=>x<0?1:2},null,8,'canyon');
for(const theme of ['training','canyon','forest','volcano','thunder']){localDust.setTheme(theme);for(const c of localDust.groundPalette){assert.ok(c[0]>c[1]&&c[1]>c[2]&&c[0]<=.28,'dust remains muted brown on every surface');}}
assert.equal(localDust.mat.uniforms.uOpacity.value,.52);
localDust.dispose();
const landings=[];const fx={audio:{land:(...args)=>landings.push(args)},feel:null,hud:{airtime(){}},terrain:{heightAt:()=>0}};
for(const id of ['hopper','ridgeback','redline','moto']){
 RaceFX.prototype.touchdown.call(fx,{airPeak:.5,isPlayer:true},{hardHit:0,_airVy:-5,surfaceId:1,spec:{id}},0,0);
 assert.equal(landings.at(-1)[2],id);assert.ok(landings.at(-1)[0]>=1,'soft suspension still produces clear landing');
}
RaceFX.prototype.touchdown.call(fx,{airPeak:.05,isPlayer:true},{hardHit:0,_airVy:-1,surfaceId:1,spec:{id:'moto'}},0,0);
assert.equal(landings.length,4,'rut contact chatter does not retrigger touchdown');
console.log('terrain palette dust, transparency, four landing identities and cushioned touchdown pass');

const {VFX}=await import('../src/world/vfx.js');
const trails=new VFX(new THREE.Scene(),null,{});
let clearedHits=0;trails.hits.clear=()=>clearedHits++;
const ribbon=trails.ribbon(0);ribbon.push(0,0,0,1,1,1);ribbon.clear();
assert.equal(clearedHits,0,'clearing one rocket trail must not clear vehicle explosions');
trails.dispose();

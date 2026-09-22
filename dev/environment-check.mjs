import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildEnvironmentDressing, setEnvironmentQuality } from '../src/world/environment-dressing.js';
import { boulderGeo, pineGeo, rockMaterial } from '../src/world/props-shapes.js';

for (const make of [()=>boulderGeo(31,2),()=>pineGeo(1),()=>pineGeo(2),()=>pineGeo(3)]) {
  const g=make();
  assert(g && g.attributes.position.count>0);
  assert([...g.attributes.position.array,...g.attributes.normal.array].every(Number.isFinite));
  g.computeBoundingBox();
  assert(g.boundingBox.max.y>0);
  g.dispose();
}

function build(theme) {
  const owned=[];
  const spline={
    length:Math.PI*200,
    widthAt:()=>12,
    offsetPoint(s,l,out) { const a=s/100;out.x=Math.cos(a)*(100+l);out.z=Math.sin(a)*(100+l);return out; },
    nearest(x,z,out) { out.d=Math.abs(Math.hypot(x,z)-100);out.s=0;return out; },
  };
  const shortcut={widthAt:()=>6,nearest(x,z,out){out.d=Math.abs(z);out.s=0;return out;}};
  const p={theme,def:{seed:4101},quality:{name:'HIGH'},group:new THREE.Group(),
    data:{spline,shortcutSpline:shortcut,checkpoints:[{x:100,z:0,r:15}],gridSlots:[{x:0,z:100}]},
    terrain:{heightAt:()=>0,slopeAt:()=>0},_fixedColliders:[],_claimed:[],
    _keepGeo(g){owned.push(g);return g;},_keepMat(m){owned.push(m);return m;},
    _canPlace(x,z){return Math.abs(Math.hypot(x,z)-100)>16 && Math.abs(z)>8;},
    _clearOfClaims(x,z,r){return this._claimed.every(c=>Math.hypot(x-c.x,z-c.z)>r+c.r);},
  };
  p.rockMat=p._keepMat(rockMaterial(0x777766,0x888877));
  buildEnvironmentDressing(p);
  assert(p._fixedColliders.length>0,theme+' has outcrops');
  for(const c of p._fixedColliders) {
    assert(Math.abs(Math.hypot(c.x,c.z)-100)>12+c.r+9.99,theme+' road clearance');
    assert(Math.abs(c.z)>6+c.r+9.99,theme+' shortcut clearance');
    assert(Math.hypot(c.x-100,c.z)>15+c.r,theme+' checkpoint clearance');
    assert(Math.hypot(c.x,c.z-100)>8+c.r,theme+' grid clearance');
  }
  const full=p.environmentDetails.map(m=>m.count);
  const solids=JSON.stringify(p._fixedColliders);
  setEnvironmentQuality(p,{name:'LOW'});
  p.environmentDetails.forEach((m,i)=>assert(m.count<full[i]));
  assert.equal(JSON.stringify(p._fixedColliders),solids,'quality cannot hide solid outcrops');
  setEnvironmentQuality(p,{name:'HIGH'});
  assert.deepEqual(p.environmentDetails.map(m=>m.count),full);
  for(const m of p.group.children) {
    assert([...m.instanceMatrix.array].every(Number.isFinite));m.dispose();
  }
  owned.forEach(o=>o.dispose());
  return solids;
}
for(const theme of ['training','canyon','forest','volcano','thunder']) {
  assert.equal(build(theme),build(theme),theme+' deterministic placement');
}
console.log('Environment geometry, determinism, road/shortcut/grid clearance and quality tiers OK');

import { erodedRockArchGeo } from '../src/world/kit.js';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildEnvironmentDressing, setEnvironmentQuality } from '../src/world/environment-dressing.js';
import { boulderGeo, pineGeo, rockMaterial } from '../src/world/props-shapes.js';
import { dressLandmarkSite } from '../src/world/landmark-scenes.js';

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
    terrain:{heightAt:()=>0,slopeAt:(x,z)=>Math.hypot(x,z)>220?40:0},_fixedColliders:[],_claimed:[],
    _keepGeo(g){owned.push(g);return g;},_keepMat(m){owned.push(m);return m;},
    _canPlace(x,z){return Math.abs(Math.hypot(x,z)-100)>16 && Math.abs(z)>8;},
    _clearOfClaims(x,z,r){return this._claimed.every(c=>Math.hypot(x-c.x,z-c.z)>r+c.r);},
  };
  p.rockMat=p._keepMat(rockMaterial(0x777766,0x888877));
  buildEnvironmentDressing(p);
  if(theme==='training') assert(p.quarryCrags.count>0,'steep quarry faces receive crags');
  {
    const matrix=new THREE.Matrix4(),pos=new THREE.Vector3(),scale=new THREE.Vector3(),rot=new THREE.Quaternion();
    const banks=p._fixedColliders.filter(c=>c.kind==='quarry-boulder');
    for(let i=0;i<p.quarryMediumRocks.count;i++) {
      p.quarryMediumRocks.getMatrixAt(i,matrix);matrix.decompose(pos,rot,scale);
      assert(banks.some(c=>Math.hypot(pos.x-c.x,pos.z-c.z)+Math.max(scale.x,scale.z)*1.5<c.r+.001),
        'every rubble fragment fits its aggregate collision footprint');
    }
  }
  assert(p._fixedColliders.length>0,theme+' has outcrops');
  for(const c of p._fixedColliders) {
    const clearance=c.kind==='quarry-boulder'?5.99:9.99;
    assert(Math.abs(Math.hypot(c.x,c.z)-100)>12+c.r+clearance,theme+' road clearance');
    assert(Math.abs(c.z)>6+c.r+clearance,theme+' shortcut clearance');
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
    if(m.isInstancedMesh){assert([...m.instanceMatrix.array].every(Number.isFinite));m.dispose();}
    else {
      assert([...m.geometry.attributes.position.array,...m.geometry.attributes.normal.array].every(Number.isFinite));
      m.geometry.computeBoundingSphere();
      const points=m.geometry.attributes.position;let radius=0;
      for(let i=0;i<points.count;i++)radius=Math.max(radius,Math.hypot(points.getX(i)*m.scale.x,points.getZ(i)*m.scale.z));
      assert(Math.hypot(m.position.x,m.position.z)-radius>450,'distant mesas stay outside the race terrain');
    }
  }
  owned.forEach(o=>o.dispose());
  return solids;
}
for(const theme of ['training','canyon','forest','volcano','thunder']) {
  assert.equal(build(theme),build(theme),theme+' deterministic placement');
}
console.log('Environment geometry, determinism, road/shortcut/grid clearance and quality tiers OK');
{
 const group=new THREE.Group(),owned=[];
 const p={theme:'training',group,scatterMeshes:[],
  data:{spline:{posAt:()=>({x:-50,z:0})}},
  _canPlace:()=>false,_keepGeo:g=>(owned.push(g),g),
  dressMat:new THREE.MeshStandardMaterial({vertexColors:true})};
 dressLandmarkSite(p,{id:'training-conveyor',r:18},{x:0,y:0,z:0,low:0,yaw:.7,s:195});
 assert.equal(group.children.length,1,'industrial site remains one merged draw');
 const pos=group.children[0].geometry.attributes.position;
 for(let i=0;i<pos.count;i++) {
  assert(Number.isFinite(pos.getY(i)),'finite industrial geometry');
  assert(Math.hypot(pos.getX(i),pos.getZ(i))<18,'industrial structures fit the existing collider');
 }
 owned.forEach(g=>g.dispose());p.dressMat.dispose();
}

{
 const geo=erodedRockArchGeo({dirt:0x98785f},179),mat=new THREE.MeshBasicMaterial({side:THREE.DoubleSide});
 const mesh=new THREE.Mesh(geo,mat);mesh.updateMatrixWorld(true);
 const ray=new THREE.Raycaster(new THREE.Vector3(0,2,10),new THREE.Vector3(0,0,-1));
 assert.equal(ray.intersectObject(mesh).length,0,'arch driving opening is genuinely hollow');
 ray.ray.origin.x=13;assert(ray.intersectObject(mesh).length>0,'arch leg is real volume');
 const a=geo.attributes.position;
 for(let i=0;i<a.count;i++) if(a.getY(i)<2) {
   const d=Math.min(Math.hypot(a.getX(i)-13,a.getZ(i)),Math.hypot(a.getX(i)+13,a.getZ(i)));
   assert(d<3.001,'arch feet fit the existing colliders');
 }
 geo.dispose();mat.dispose();
}

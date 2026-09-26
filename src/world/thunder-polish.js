/* Thunder Park's decorative art pass. All placement is derived from the live
   spline; no collision or jump dimensions are changed. Resources belong to Props. */
import * as THREE from 'three';
import { makeRNG } from '../core/rng.js';
import { makeSmokeSprite } from './textures.js';

export function buildThunderPolish(p) {
  const rng=makeRNG(550713), sp=p.data.spline, q={}, dummy=new THREE.Object3D();
  // Coarse distant terrain rings flatten narrow hilltops. Loose scatter on
  // those peaks can hover above the rendered surface; keep the distant skyline
  // geological, with only the footprint-fitted vista meshes out there.
  const matrix=new THREE.Matrix4(),nearest={};
  for(let vi=0;vi<(p.scatterMeshes||[]).length;vi++){
    const mesh=p.scatterMeshes[vi];
    for(let i=0;i<mesh.userData.placed;i++){
      mesh.getMatrixAt(i,matrix);
      const x=matrix.elements[12],y=matrix.elements[13],z=matrix.elements[14];
      sp.nearest(x,z,nearest);
      if(y>25&&nearest.d>35){matrix.makeScale(0,0,0);mesh.setMatrixAt(i,matrix);p._scatterSolids[vi][i]=null;}
    }
    mesh.instanceMatrix.needsUpdate=true;
  }
  const steel=p._keepMat(new THREE.MeshStandardMaterial({color:0x343d43,roughness:.67,metalness:.72}));
  // Relief follows the geological beds in the existing triplanar material.
  // The derivative is in view space, matching Three's lighting normal.
  const rockCompile=p.rockMat.onBeforeCompile;
  p.rockMat.onBeforeCompile=sh=>{
    rockCompile(sh);
    sh.fragmentShader=sh.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
      float reliefFade=1.-smoothstep(45.,180.,length(vViewPosition));
      float rockHeight=(rkTri(vRkW,normalize(vRkN),3.7)*.09
        +sin(vRkW.y*8.+rkF(vRkW.xz*.2))*.014)*reliefFade;
      vec3 rockDx=dFdx(-vViewPosition),rockDy=dFdy(-vViewPosition);
      vec3 rockRx=cross(rockDy,normal),rockRy=cross(normal,rockDx);
      float rockDet=dot(rockDx,rockRx);
      if(abs(rockDet)>1e-7) normal=normalize(abs(rockDet)*normal-sign(rockDet)*
        (dFdx(rockHeight)*rockRx+dFdy(rockHeight)*rockRy));`);
  };
  p.rockMat.customProgramCacheKey=()=> 'thunder-sandstone-relief-v1';
  p.rockMat.envMapIntensity=.55;
  const lamp=p._keepMat(new THREE.MeshStandardMaterial({color:0xffd39a,emissive:0xffbb62,emissiveIntensity:4,roughness:.3}));
  const posts=[],bulbs=[],cables=[],previous={};
  // Knee-high dry bunchgrass breaks up the sterile shoulder. This cosmetic
  // scatter respects both road corridors without the large solid-rock buffer.
  const source=p.environmentDetails?.[1];
  if(source){
    const grass=new THREE.InstancedMesh(source.geometry,source.material,2000),near={};
    let n=0;
    const tint=new THREE.Color();
    for(let i=0;i<6500&&n<2000;i++){
      const s=rng()*sp.length,side=rng()<.5?-1:1;
      sp.offsetPoint(s,side*(sp.widthAt(s)+1.8+rng()*8),q);
      if(p.terrain.onRoad(q.x,q.z)>.015||p.terrain.slopeAt(q.x,q.z)>31||!p._clearOfClaims(q.x,q.z,.35))continue;
      if(p.data.shortcutSpline){p.data.shortcutSpline.nearest(q.x,q.z,near);if(near.d<p.data.shortcutSpline.widthAt(near.s)+1.5)continue;}
      const scale=.38+rng()*.55;
      dummy.position.set(q.x,p.terrain.heightAt(q.x,q.z)-.04,q.z);
      dummy.rotation.set(0,rng()*Math.PI*2,0);dummy.scale.set(scale,scale*(.85+rng()*.3),scale);dummy.updateMatrix();
      grass.setMatrixAt(n,dummy.matrix);tint.setRGB(.85+rng()*.25,.83+rng()*.16,.73+rng()*.15);grass.setColorAt(n++,tint);
    }
    grass.count=n;grass.userData.fullCount=n;grass.receiveShadow=true;grass.computeBoundingSphere();
    p.group.add(grass);p.environmentDetails.push(grass);dummy.scale.set(1,1,1);dummy.rotation.set(0,0,0);
  }
  // Small warm lamps trace the event perimeter; they never cross a jump lane.
  for(let s=18;s<sp.length;s+=38) {
    for(const side of [-1,1]) {
      const lat=side*(sp.widthAt(s)*1.55+3);
      sp.offsetPoint(s,lat,q);
      if(!p._canPlace(q.x,q.z,1.25)||!p._clearOfClaims(q.x,q.z,1.2)) continue;
      const y=p.terrain.heightAt(q.x,q.z);
      posts.push([q.x,y+3.4,q.z]);bulbs.push([q.x,y+6.8,q.z]);
      const a=previous[side],b=[q.x,y+3.4,q.z];
      previous[side]=b;
      const clear=a && Array.from({length:9},(_,i)=>i/8).every(f=>p.terrain.onRoad(a[0]+(b[0]-a[0])*f,a[2]+(b[2]-a[2])*f)<.02);
      if(clear && Math.hypot(a[0]-q.x,a[2]-q.z)<65) {
        for(let j=0;j<12;j++) {
          const t=j/12,u=(j+1)/12;
          for(const f of [t,u]) cables.push(a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f+3.4-Math.sin(f*Math.PI)*.7,a[2]+(b[2]-a[2])*f);
          if(j%2===0) bulbs.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t+3.3-Math.sin(t*Math.PI)*.7,a[2]+(b[2]-a[2])*t]);
        }
      }
    }
  }
  function instances(geo,mat,points){
    const mesh=new THREE.InstancedMesh(p._keepGeo(geo),mat,points.length);
    points.forEach((v,i)=>{dummy.position.set(...v);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
    mesh.computeBoundingSphere();p.group.add(mesh);return mesh;
  }
  instances(new THREE.CylinderGeometry(.065,.10,6.8,6),steel,posts);
  instances(new THREE.SphereGeometry(.095,6,4),lamp,bulbs);
  if(cables.length){const geo=p._keepGeo(new THREE.BufferGeometry());geo.setAttribute('position',new THREE.Float32BufferAttribute(cables,3));
    p.group.add(new THREE.LineSegments(geo,p._keepMat(new THREE.LineBasicMaterial({color:0x343638}))));}
  // Practical housings on the existing finish gantry. Emission blooms without
  // adding dozens of expensive point lights to every world material.
  for(const gantry of [p.gantry,...(p.jumpArches||[])].filter(Boolean)){
    const beam=gantry.children.find(o=>o.geometry?.type==='BoxGeometry' && o.geometry.parameters.width>10);
    const width=beam?.geometry.parameters.width||sp.widthAt(0)*2+5;
    const lampY=(beam?.position.y||7.2)-1.35;
    const housing=p._keepGeo(new THREE.BoxGeometry(.64,.28,.42));
    const lens=p._keepGeo(new THREE.PlaneGeometry(.43,.14));
    const housings=new THREE.InstancedMesh(housing,steel,7), lenses=new THREE.InstancedMesh(lens,lamp,7);
    for(let i=0;i<7;i++){
      const x=(i/6-.5)*width*.85;
      dummy.position.set(x,lampY,-.25);dummy.rotation.set(0,0,0);dummy.updateMatrix();housings.setMatrixAt(i,dummy.matrix);
      dummy.position.set(x,lampY-.01,-.47);dummy.rotation.y=Math.PI;dummy.updateMatrix();lenses.setMatrixAt(i,dummy.matrix);
    }
    housings.computeBoundingSphere();lenses.computeBoundingSphere();gantry.add(housings,lenses);
  }
  // Soft, low-density wind sheets. They hug the ground outside the racing line
  // and fade near the camera so there are no opaque sprite intersections.
  const tex=p._keepTex(makeSmokeSprite(128));
  const mat=p._keepMat(new THREE.MeshBasicMaterial({map:tex,color:0xc9b79b,transparent:true,
    opacity:.055,depthWrite:false,side:THREE.DoubleSide,fog:true}));
  const geo=p._keepGeo(new THREE.PlaneGeometry(1,1));
  const sheets=[];
  for(let i=0;i<28;i++){
    const s=rng()*sp.length,side=rng()<.5?-1:1;
    sp.offsetPoint(s,side*(sp.widthAt(s)*1.6+8+rng()*20),q);
    const mesh=new THREE.Mesh(geo,mat);mesh.scale.set(12+rng()*17,1.2+rng()*2.0,1);
    mesh.position.set(q.x,p.terrain.heightAt(q.x,q.z)+.8,q.z);
    mesh.renderOrder=2;p.group.add(mesh);
    sheets.push({mesh,x:q.x,z:q.z,phase:rng()*Math.PI*2});
  }
  let elapsed=0;
  p.thunderPolish={posts:posts.length,bulbs:bulbs.length,sheets:sheets.length,update(dt,camera){
    elapsed+=dt;
    for(const s of sheets){
      const x=s.x+Math.sin(elapsed*.09+s.phase)*5,z=s.z+Math.cos(elapsed*.07+s.phase)*2;
      s.mesh.position.set(x,p.terrain.heightAt(x,z)+1,z);s.mesh.quaternion.copy(camera.quaternion);
      const d=camera.position.distanceTo(s.mesh.position);
      s.mesh.visible=d>14&&d<260;
    }
  }};
}

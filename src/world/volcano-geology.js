import * as THREE from 'three';
import {makeRNG} from '../core/rng.js';
import {rockMaterial} from './props-shapes.js';
import {canyonFoundation} from './canyon-vista.js';

// Fractured basalt buttresses: fluted vertical faces, broken rim and talus.
export function volcanicButtressGeometry(seed) {
  const pos=[],index=[],N=96;
  const rings=[[0,1],[.16,.92],[.28,.74],[.32,.72],[.83,.69],[1,.65]];
  for(let j=0;j<rings.length;j++)for(let i=0;i<=N;i++) {
    const a=i/N*Math.PI*2,[h,r]=rings[j];
    const edge=1+.13*Math.sin(a*3+seed)+.08*Math.sin(a*7+seed*.7);
    const flute=(i%2 ? -.024:.024)*(j>1?1:.2);
    const top=h>.8 ? .08*Math.sin(a*11+seed)+.045*Math.cos(a*19):0;
    pos.push(Math.cos(a)*(r*edge+flute),h+top,Math.sin(a)*(r*edge+flute)*.72);
    if(j<rings.length-1&&i<N){const k=j*(N+1)+i;index.push(k,k+N+1,k+1,k+1,k+N+1,k+N+2);}
  }
  const cap=pos.length/3;pos.push(0,.96,0);
  for(let i=0;i<N;i++)index.push(cap,5*(N+1)+i+1,5*(N+1)+i);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(index);g.computeVertexNormals();return g;
}

export function buildVolcanoGeology(p) {
  const mat=p._keepMat(rockMaterial(0x505158,0x66636a,p.environmentAssets?.cliff));
  for(let i=0;i<12;i++) {
    const a=i/12*Math.PI*2+.2,r=850+(i%3)*155,x=Math.cos(a)*r,z=Math.sin(a)*r;
    const width=130+(i%4)*18,yaw=i*1.61;
    const foot=canyonFoundation(p.terrain,x,z,width,yaw);
    const mesh=new THREE.Mesh(p._keepGeo(volcanicButtressGeometry(i*1.7)),mat);
    mesh.position.set(x,foot.base,z);mesh.rotation.y=yaw;
    mesh.scale.set(width,Math.max(105+(i%3)*16,foot.relief*.70),width);
    mesh.receiveShadow=true;p.group.add(mesh);
  }
  const rng=makeRNG(p.def.seed^0xbaa1),sp=p.data.spline,point={},near={},dummy=new THREE.Object3D();
  const geo=p._keepGeo(new THREE.CylinderGeometry(.82,1,1,6,2));geo.translate(0,.5,0);
  const columns=new THREE.InstancedMesh(geo,mat,900);let n=0;
  // Column groups are geological features with one conservative collider.
  for(let i=0;i<900&&n+9<=900;i++) {
    const s=rng()*sp.length,side=rng()<.5?-1:1;
    sp.offsetPoint(s,side*(sp.widthAt(s)+22+rng()*48),point);
    const x=point.x,z=point.z,extent=6;
    if(!p._canPlace(x,z,2)||!p._clearOfClaims(x,z,extent+2))continue;
    sp.nearest(x,z,near);if(near.d<sp.widthAt(near.s)+extent+11)continue;
    if(p.data.shortcutSpline){p.data.shortcutSpline.nearest(x,z,near);if(near.d<p.data.shortcutSpline.widthAt(near.s)+extent+11)continue;}
    if(p.data.checkpoints.some(c=>Math.hypot(x-c.x,z-c.z)<c.r+extent+2)||p.data.gridSlots.some(g=>Math.hypot(x-g.x,z-g.z)<extent+9))continue;
    for(let j=0;j<9;j++) {
      const dx=(j%3-1)*1.65,dz=(Math.floor(j/3)-1)*1.65;
      const px=x+dx,pz=z+dz,radius=.85+rng()*.3,h=2.5+rng()*6;
      let base=p.terrain.heightAt(px,pz);
      for(let k=0;k<8;k++){const a=k*Math.PI/4;base=Math.min(base,p.terrain.heightAt(px+Math.cos(a)*radius,pz+Math.sin(a)*radius));}
      dummy.position.set(px,base-.5,pz);dummy.rotation.set(0,rng()*.25,0);dummy.scale.set(radius,h,radius);dummy.updateMatrix();columns.setMatrixAt(n++,dummy.matrix);
    }
    p._fixedColliders.push({x,z,r:extent,kind:'basalt',bounce:.55});p._claimed.push({x,z,r:extent});
  }
  columns.count=n;columns.castShadow=true;columns.receiveShadow=true;columns.computeBoundingSphere();p.group.add(columns);
}

import * as THREE from 'three';
import { rockMaterial } from './props-shapes.js';

// True-volume distant sandstone cliffs. Ring profiles form talus, benches,
// vertical fluted walls and an uneven cap; this is not a skyline billboard.
export function canyonMesaGeometry(seed=0) {
  const pos=[],idx=[],N=96;
  const profile=[[0,1],[.12,.92],[.21,.77],[.24,.72],[.28,.71],[.31,.63],[.58,.59],[.60,.57],[.64,.55],[.68,.49],[.94,.45],[1,.42]];
  for(let j=0;j<profile.length;j++)for(let i=0;i<=N;i++) {
    const a=i/N*Math.PI*2, [y,r]=profile[j];
    const outline=1+.11*Math.sin(a*3+seed)+.075*Math.sin(a*7+seed*.4)+.036*Math.sin(a*17);
    const flute=.025*Math.sin(a*29+seed)+.017*Math.sin(a*41);
    const radius=r*outline+flute*Math.sin(y*Math.PI);
    pos.push(Math.cos(a)*radius,y+(y>.9?.016*Math.sin(a*13+seed):0),Math.sin(a)*radius*.78);
    if(j<profile.length-1&&i<N){const k=j*(N+1)+i;idx.push(k,k+N+1,k+1,k+1,k+N+1,k+N+2);}
  }
  const cap=pos.length/3;pos.push(0,1,0);
  for(let i=0;i<N;i++)idx.push(cap,(profile.length-1)*(N+1)+i+1,(profile.length-1)*(N+1)+i);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);g.computeVertexNormals();return g;
}

export function buildCanyonVista(p) {
  // All silhouettes sit beyond the race and shortcut corridors. They remain
  // in every quality tier so lowering quality cannot change the horizon.
  const material=p._keepMat(rockMaterial(0x98785f,p.recipe?.dust||0xb49b78,p.environmentAssets?.cliff));
  for(let i=0;i<14;i++) {
    const a=i/14*Math.PI*2+.17, radius=790+(i%3)*175;
    const x=Math.cos(a)*radius,z=Math.sin(a)*radius;
    const mesh=new THREE.Mesh(p._keepGeo(canyonMesaGeometry(i*3.17)),material);
    mesh.position.set(x,p.terrain.heightAt(x,z)-15,z);
    mesh.scale.set(105+(i%4)*23,150+(i%3)*38,105+(i%4)*23);
    mesh.rotation.y=i*1.74;mesh.receiveShadow=true;
    p.group.add(mesh);
  }
}

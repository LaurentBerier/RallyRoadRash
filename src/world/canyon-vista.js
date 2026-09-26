import * as THREE from 'three';
import { rockMaterial } from './props-shapes.js';

// True-volume distant sandstone cliffs. Ring profiles form talus, benches,
// vertical fluted walls and an uneven cap; this is not a skyline billboard.
export function canyonMesaGeometry(seed=0) {
  const pos=[],idx=[],N=96;
  const profile=[[0,1],[.12,.93],[.22,.83],[.25,.81],[.29,.75],[.53,.72],[.56,.70],[.59,.65],[.67,.65],[.93,.63],[.98,.61],[1,.60]];
  for(let j=0;j<profile.length;j++)for(let i=0;i<=N;i++) {
    const a=i/N*Math.PI*2, [y,r]=profile[j];
    const outline=1+.11*Math.sin(a*3+seed)+.075*Math.sin(a*7+seed*.4)+.036*Math.sin(a*17);
    const flute=.012*Math.sin(a*29+seed)+.009*Math.sin(a*41);
    const radius=r*outline+flute*Math.sin(y*Math.PI);
    const ca=Math.cos(a),sa=Math.sin(a);
    pos.push(Math.sign(ca)*Math.pow(Math.abs(ca),.72)*radius,y+(y>.9?.016*Math.sin(a*13+seed):0),Math.sign(sa)*Math.pow(Math.abs(sa),.72)*radius*.78);
    if(j<profile.length-1&&i<N){const k=j*(N+1)+i;idx.push(k,k+N+1,k+1,k+1,k+N+1,k+N+2);}
  }
  const cap=pos.length/3;pos.push(0,1,0);
  for(let i=0;i<N;i++)idx.push(cap,(profile.length-1)*(N+1)+i+1,(profile.length-1)*(N+1)+i);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);g.computeVertexNormals();return g;
}

export function buildCanyonVista(p) {
  // All silhouettes sit beyond the race and shortcut corridors. They remain
  // in every quality tier so lowering quality cannot change the horizon.
  const material=p._keepMat(rockMaterial(0x755c52,p.recipe?.dust||0xb49b78,p.environmentAssets?.cliff));
  const shade=material.onBeforeCompile;
  material.onBeforeCompile=shader=>{
    shade(shader);shader.fragmentShader=shader.fragmentShader.replace('vRkW.y*3.2','vRkW.y*.65');
    if(p.theme==='thunder') shader.fragmentShader=shader.fragmentShader.replace('#include <fog_fragment>',`
      vec3 vistaView=normalize(vRkW-cameraPosition);
      float vistaSun=pow(max(dot(vistaView,vec3(.719846,.342020,.604023)),0.),3.);
      float vistaValley=exp(-max(vRkW.y,0.)*.016);
      float vistaFog=1.-exp(-max(length(vRkW-cameraPosition)-45.,0.)*.00165*(.42+.85*vistaValley));
      vec3 vistaAir=mix(vec3(.505,.611,.745),vec3(.78,.65,.48),vistaSun*.78);
      gl_FragColor.rgb=mix(gl_FragColor.rgb,vistaAir,clamp(vistaFog,0.,.92));
    `);
  };
  material.customProgramCacheKey=()=> 'canyon-vista-strata-v4-'+p.theme;
  for(let i=0;i<14;i++) {
    const a=i/14*Math.PI*2+.17, radius=790+(i%3)*175;
    const x=Math.cos(a)*radius,z=Math.sin(a)*radius;
    const geometry=p._keepGeo(canyonMesaGeometry(i*3.17));
    const width=135+(i%4)*20,yaw=i*1.74;
    const foundation=canyonFoundation(p.terrain,x,z,width,yaw);
    const mesh=new THREE.Mesh(geometry,material);
    mesh.position.set(x,foundation.base,z);
    mesh.scale.set(width,125+(i%3)*18,width);
    mesh.rotation.y=yaw;mesh.receiveShadow=true;
    mesh.userData.canyonFoundation=foundation;
    p.group.add(mesh);
  }
}

// Sample the complete footprint, not just the center. Bury the lower ring
// below its lowest point with room for far-clipmap mip interpolation.
export function canyonFoundation(terrain,x,z,width,yaw) {
  let low=Infinity,high=-Infinity;
  for(let dz=-1.4;dz<=1.401;dz+=.07)for(let dx=-1.4;dx<=1.401;dx+=.07) {
    const wx=x+width*(dx*Math.cos(yaw)+dz*Math.sin(yaw));
    const wz=z+width*(-dx*Math.sin(yaw)+dz*Math.cos(yaw));
    const h=terrain.heightAt(wx,wz);low=Math.min(low,h);high=Math.max(high,h);
  }
  return {base:low-45,relief:high-low+45,low,high};
}

import * as THREE from 'three';
import {makeRNG} from '../core/rng.js';

// World-anchored vent steam and airborne ash. Animation stays on the GPU;
// no particle allocations, physics bodies, or road visibility changes.
export function buildVolcanoVFX(p) {
  const rng=makeRNG(p.def.seed^0x5fea),centres=[],phases=[],sizes=[];
  const sp=p.data.spline,q={};
  for(let i=0;i<42;i++) {
    const s=(i+.3)/42*sp.length,side=i%2?1:-1;
    sp.offsetPoint(s,side*(sp.widthAt(s)+28+rng()*24),q);
    if(!p._canPlace(q.x,q.z,2))continue;
    for(let j=0;j<4;j++) {
      centres.push(q.x,p.terrain.heightAt(q.x,q.z)+.6,q.z);
      phases.push(rng());sizes.push(5+rng()*5.5);
    }
  }
  const base=new THREE.PlaneGeometry(1,1),g=p._keepGeo(new THREE.InstancedBufferGeometry());
  g.index=base.index.clone();for(const key of Object.keys(base.attributes))g.setAttribute(key,base.attributes[key].clone());base.dispose();
  g.setAttribute('aCentre',new THREE.InstancedBufferAttribute(new Float32Array(centres),3));
  g.setAttribute('aPhase',new THREE.InstancedBufferAttribute(new Float32Array(phases),1));
  g.setAttribute('aSize',new THREE.InstancedBufferAttribute(new Float32Array(sizes),1));g.instanceCount=phases.length;
  const time={value:0};
  const mat=p._keepMat(new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{uTime:time},
    vertexShader:`attribute vec3 aCentre;attribute float aPhase,aSize;uniform float uTime;varying vec2 vUv;varying float vLife,vSeed;
    void main(){float life=fract(aPhase+uTime*.035);vLife=life;vSeed=aPhase*73.;vUv=uv;
      vec3 c=aCentre+vec3(life*7.,life*10.,life*2.);vec4 view=modelViewMatrix*vec4(c,1.);
      view.xy+=position.xy*aSize*(.55+life*1.5);gl_Position=projectionMatrix*view;}`,
    fragmentShader:`precision highp float;varying vec2 vUv;varying float vLife,vSeed;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
    void main(){vec2 q=vUv*2.-1.;float n=noise(vUv*5.+vSeed)*.65+noise(vUv*11.+vSeed)*.35;
      float edge=1.-smoothstep(.15,1.,length(q)+(n-.5)*.35);
      float a=edge*(.4+n*.6)*sin(vLife*3.14159)*.30;
      gl_FragColor=vec4(mix(vec3(.24,.25,.27),vec3(.57,.49,.40),n),a);}`
  }));
  const steam=new THREE.Mesh(g,mat);steam.userData.volcanoEffect=true;steam.frustumCulled=false;steam.renderOrder=3;p.group.add(steam);
  const points=[],seeds=[];
  for(let i=0;i<700;i++){const s=rng()*sp.length;sp.offsetPoint(s,(rng()-.5)*110,q);points.push(q.x,p.terrain.heightAt(q.x,q.z)+2+rng()*20,q.z);seeds.push(rng());}
  const ag=p._keepGeo(new THREE.BufferGeometry());ag.setAttribute('position',new THREE.Float32BufferAttribute(points,3));ag.setAttribute('aSeed',new THREE.Float32BufferAttribute(seeds,1));
  const am=p._keepMat(new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{uTime:time},
    vertexShader:`attribute float aSeed;uniform float uTime;varying float vSeed,vFade;void main(){vSeed=aSeed;vec3 p=position;p.x+=sin(uTime*.18+aSeed*30.)*5.;p.y+=sin(uTime*.3+aSeed*19.)*2.;p.z+=cos(uTime*.15+aSeed*12.)*3.;vec4 v=modelViewMatrix*vec4(p,1.);vFade=1.-smoothstep(40.,180.,-v.z);gl_Position=projectionMatrix*v;gl_PointSize=clamp(190./max(1.,-v.z),1.,3.5);}`,
    fragmentShader:`precision highp float;varying float vSeed,vFade;void main(){float a=1.-smoothstep(.1,.5,length(gl_PointCoord-.5));vec3 c=vSeed>.95?vec3(1.,.28,.035):vec3(.42,.39,.36);gl_FragColor=vec4(c,a*vFade*.48);}`
  }));
  const ash=new THREE.Points(ag,am);ash.userData.volcanoEffect=true;ash.frustumCulled=false;p.group.add(ash);
  p.volcanoVFX={time,steam,ash,fullSteam:g.instanceCount};
}

export function setVolcanoVFXQuality(p,q) {
  const fx=p.volcanoVFX;if(!fx)return;
  const low=q.name==='LOW',medium=q.name==='MEDIUM';
  fx.steam.geometry.instanceCount=Math.floor(fx.fullSteam*(low?.35:medium?.65:1));
  fx.ash.geometry.setDrawRange(0,low?180:medium?350:700);
}

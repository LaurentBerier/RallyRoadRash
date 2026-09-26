import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {makeRNG,vnoise} from '../core/rng.js';

// The origin is the flame emitter. Tubes extend FORWARD into the chassis;
// the open, soot-dark mouth faces -Z, along the actual boost plume.
export function buildMuffler(v){
  const bike=v.spec.bodyStyle==='bike',r=bike?.075:.14,len=bike?.38:.68;
  const n=128,data=new Uint8Array(n*n*4),rng=makeRNG(931);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const k=(y*n+x)*4,patch=vnoise(x*.07,y*.07,91),pit=rng();
    const rust=THREE.MathUtils.smoothstep(patch,.30,.67);
    const steel=[92,91,83],oxide=[118,62,30];
    for(let c=0;c<3;c++)data[k+c]=(steel[c]*(1-rust)+oxide[c]*rust)*(.65+pit*.42);
    data[k+3]=255;
  }
  const tex=new THREE.DataTexture(data,n,n);tex.colorSpace=THREE.SRGBColorSpace;
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.generateMipmaps=true;tex.minFilter=THREE.LinearMipmapLinearFilter;tex.needsUpdate=true;
  v.tex.exhaustRust=tex;
  const rust=v.mats.exhaustRust=new THREE.MeshStandardMaterial({map:tex,bumpMap:tex,bumpScale:.009,metalness:.42,roughness:.85});
  const band=v.mats.exhaustBand=new THREE.MeshStandardMaterial({color:0x68645b,metalness:.72,roughness:.57});
  const soot=v.mats.exhaustSoot=new THREE.MeshStandardMaterial({color:0x080909,roughness:1});
  const rig=v._muffler=new THREE.Group();rig.name='rusty-exhaust-muffler';
  function mesh(geo,mat){v.geos.push(geo);const m=new THREE.Mesh(geo,mat);m.castShadow=m.receiveShadow=true;rig.add(m);return m;}
  const can=new THREE.CylinderGeometry(r,r*.94,len,14,1,true);can.rotateX(Math.PI/2);can.translate(0,0,len*.5+.07);mesh(can,rust);
  const pipe=new THREE.CylinderGeometry(r*.54,r*.54,.18,12,1,true);pipe.rotateX(Math.PI/2);pipe.translate(0,0,.075);mesh(pipe,rust);
  const rings=[];
  for(const z of [.0,.14,len*.82]){const g=new THREE.TorusGeometry(z===0?r*.55:r*1.025,r*.08,5,14);g.translate(0,0,z);rings.push(g);}
  const merged=mergeGeometries(rings,false);rings.forEach(g=>g.dispose());mesh(merged,band);
  const hole=new THREE.CircleGeometry(r*.48,12);hole.rotateY(Math.PI);hole.translate(0,0,.035);mesh(hole,soot);
  const cap=new THREE.CircleGeometry(r*.95,14);cap.translate(0,0,len+.07);mesh(cap,rust);
  rig.position.copy(v.exhaust.position);v.chassis.add(rig);
}

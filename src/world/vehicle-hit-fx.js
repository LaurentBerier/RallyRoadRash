import * as THREE from 'three';
import {vehicleWear} from '../game/vehicle-wear.js';
let atlas=null;
export function setVehicleExplosionAtlas(texture){atlas=texture;}
const dummy=new THREE.Object3D(),color=new THREE.Color();
export class VehicleHitFX {
 constructor(scene,terrain,low=false){
  this.scene=scene;this.terrain=terrain;this.capacity=low?24:48;this.effects=Array.from({length:6},()=>({age:2}));this.shards=Array.from({length:this.capacity},()=>({life:0}));
  const plane=new THREE.PlaneGeometry(1,1);const g=new THREE.InstancedBufferGeometry().copy(plane);plane.dispose();
  this.centers=new Float32Array(18);this.ages=new Float32Array(6).fill(2);this.sizes=new Float32Array(6);
  g.setAttribute('center',new THREE.InstancedBufferAttribute(this.centers,3));g.setAttribute('age',new THREE.InstancedBufferAttribute(this.ages,1));g.setAttribute('size',new THREE.InstancedBufferAttribute(this.sizes,1));g.instanceCount=6;
  const m=new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{sheet:{value:atlas}},vertexShader:`attribute vec3 center;attribute float age,size;varying vec2 vUv;varying float vAge;void main(){vUv=uv;vAge=age;vec4 p=viewMatrix*vec4(center,1.);p.xy+=position.xy*size;gl_Position=projectionMatrix*p;}`,fragmentShader:`uniform sampler2D sheet;varying vec2 vUv;varying float vAge;void main(){if(vAge>=1.)discard;float f=min(7.,floor(vAge*8.));vec2 cell=vec2(mod(f,4.),1.-floor(f/4.));vec4 t=texture2D(sheet,(clamp(vUv,.006,.994)+cell)/vec2(4.,2.));float a=t.a*smoothstep(.015,.16,max(t.r,max(t.g,t.b)))*(1.-smoothstep(.75,1.,vAge));vec2 edge=smoothstep(vec2(0.),vec2(.07),vUv)*smoothstep(vec2(0.),vec2(.07),1.-vUv);gl_FragColor=vec4(t.rgb*1.5,a*edge.x*edge.y);}`});
  this.fire=new THREE.Mesh(g,m);this.fire.frustumCulled=false;this.fire.renderOrder=7;scene.add(this.fire);
  // Share the same scratched, dusty metal maps as the vehicles. These cached
  // textures are owned by vehicleWear, not by an individual effect pool.
  const wear=vehicleWear();
  this.debrisMaterial=new THREE.MeshStandardMaterial({color:0xffffff,metalness:.42,roughness:.94,
    map:wear.map,roughnessMap:wear.roughnessMap,bumpMap:wear.bumpMap,bumpScale:.002});
  this.debrisMaterial.onBeforeCompile=shader=>{
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
      vec2 edgeUV=min(vMapUv,1.-vMapUv);
      float edge=min(edgeUV.x,edgeUV.y);
      float chip=1.-smoothstep(.018,.065+.025*sin(vMapUv.x*93.)*sin(vMapUv.y*71.),edge);
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.21,.19,.16),chip*.8);
    `);
  };
  this.debrisMaterial.customProgramCacheKey=()=> 'rocket-debris-chipped-edges-v1';
  const plate=new THREE.BoxGeometry(1,1,1,3,1,3),pos=plate.attributes.position;
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    // A bent sheet with a sheared corner; retain real thickness and UVs.
    pos.setXYZ(i,x*(z>.15?.78:1),y+(x*x-.10)*1.6+Math.max(0,z)*.55,z);
  }
  plate.computeVertexNormals();plate.computeBoundingSphere();
  this.debris=new THREE.InstancedMesh(plate,this.debrisMaterial,this.capacity);
  this.chunks=new THREE.InstancedMesh(new THREE.DodecahedronGeometry(.65,0),this.debrisMaterial,this.capacity);
  for(const mesh of [this.debris,this.chunks]){
    mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);scene.add(mesh);
  }
  this.light=new THREE.PointLight(0xff7622,0,16,2);scene.add(this.light);this.clear();
 }
 hit(x,y,z,tint=0x68605a){
  const e=this.effects.find(e=>e.age>=1)||this.effects.reduce((a,b)=>a.age>b.age?a:b);Object.assign(e,{x,y:y+.6,z,age:0});
  this.light.position.set(x,y+1,z);this.flash=1;
  const count=this.capacity===24?10:16;
  for(let n=0;n<count;n++){
   const p=this.shards.find(p=>p.life<=0);if(!p)break;
   const a=Math.random()*Math.PI*2;
   const chunk=n%4===3; // Three medium plates for each small solid fragment.
   Object.assign(p,{x,y:y+.3,z,vx:Math.cos(a)*(3+Math.random()*6),vy:3+Math.random()*6,vz:Math.sin(a)*(3+Math.random()*6),
     life:2.6+Math.random()*.6,chunk,rx:Math.random()*6,ry:Math.random()*6,rz:Math.random()*6,
     wx:(Math.random()-.5)*15,wy:(Math.random()-.5)*12,wz:(Math.random()-.5)*15,
     sx:chunk?.09+Math.random()*.10:.30+Math.random()*.25,
     sy:chunk?.08+Math.random()*.10:.025+Math.random()*.02,
     sz:chunk?.10+Math.random()*.12:.38+Math.random()*.28,settled:false});
   color.set(chunk?0x68635b:tint).lerp(new THREE.Color(0xa09a8d),chunk?.12:.65);
   const index=this.shards.indexOf(p);this.debris.setColorAt(index,color);this.chunks.setColorAt(index,color);
  }
  for(const mesh of [this.debris,this.chunks])if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
 }
 update(dt){
  for(let i=0;i<6;i++){const e=this.effects[i];e.age+=dt/1.6;this.ages[i]=e.age;this.centers[i*3]=e.x||0;this.centers[i*3+1]=e.y||0;this.centers[i*3+2]=e.z||0;this.sizes[i]=e.age<1?6.5+e.age*1.5:0;}
  this.fire.geometry.attributes.center.needsUpdate=true;this.fire.geometry.attributes.age.needsUpdate=true;this.fire.geometry.attributes.size.needsUpdate=true;
  this.fire.visible=!!atlas&&this.effects.some(e=>e.age<1);
  for(let i=0;i<this.capacity;i++){
   const p=this.shards[i];p.life-=dt;
   if(p.life>0){
    if(!p.settled){
      const drag=Math.exp(-dt*(p.chunk?.35:.85));p.vx*=drag;p.vz*=drag;
      p.vy-=9.81*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;
      p.rx+=p.wx*dt;p.ry+=p.wy*dt;p.rz+=p.wz*dt;
      const floor=(this.terrain?.heightAt(p.x,p.z)??0)+p.sy*.65;
      if(p.y<floor){
        p.y=floor;p.vy=Math.abs(p.vy)*(p.chunk?.32:.18);p.vx*=.58;p.vz*=.58;
        p.wx*=.4;p.wy*=.4;p.wz*=.4;
        if(p.vy<.7){p.settled=true;p.rx=0;p.rz=0;}
      }
    }
    dummy.position.set(p.x,p.y,p.z);dummy.rotation.set(p.rx,p.ry,p.rz);
    const fade=Math.min(1,p.life*3);dummy.scale.set(p.sx*fade,p.sy*fade,p.sz*fade);
   }else dummy.scale.setScalar(0);
   dummy.updateMatrix();
   const visible=p.chunk?this.chunks:this.debris,hidden=p.chunk?this.debris:this.chunks;
   visible.setMatrixAt(i,dummy.matrix);dummy.scale.setScalar(0);dummy.updateMatrix();hidden.setMatrixAt(i,dummy.matrix);
  }
  this.debris.visible=this.shards.some(p=>p.life>0&&!p.chunk);
  this.chunks.visible=this.shards.some(p=>p.life>0&&p.chunk);
  this.debris.instanceMatrix.needsUpdate=this.chunks.instanceMatrix.needsUpdate=true;
  this.flash=Math.max(0,(this.flash||0)-dt*4);this.light.intensity=this.flash*9;
 }
 clear(){for(const e of this.effects)e.age=2;for(const p of this.shards)p.life=0;this.flash=0;this.update(0);}
 dispose(){
  for(const o of [this.fire,this.debris,this.chunks,this.light])this.scene.remove(o);
  this.fire.geometry.dispose();this.fire.material.dispose();
  for(const mesh of [this.debris,this.chunks]){mesh.geometry.dispose();mesh.dispose();}
  this.debrisMaterial.dispose();this.light.dispose();
 }
}

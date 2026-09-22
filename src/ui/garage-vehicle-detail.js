import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { vehicleWear, tireWear } from '../game/vehicle-wear.js';

// Inspection-only geometry: the race keeps its cheaper running gear.
export function addShowroomDetails(v) {
  const geo=[],mats=[],groups=[];
  const own=g=>(geo.push(g),g);
  const material=p=>{const m=new THREE.MeshStandardMaterial({...vehicleWear(),...p});mats.push(m);return m;};
  const rubber=material({...tireWear(),color:0xffffff,roughness:1,metalness:0});
  const machined=material({color:0xb9c1c5,roughness:.65,metalness:.72});
  const armor=material({color:0x454d50,roughness:.43,metalness:.75});
  const recess=material({color:0x080c10,roughness:.85,metalness:.1});
  const mesh=(g,m,parent,x=0,y=0,z=0)=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;};
  const {spec}=v,bike=spec.bodyStyle==='bike',r=spec.wheelR,w=spec.wheelW*(spec.bodyStyle==='buggy'?1.16:1);
  // Smooth moulded tyre with actual chunky tread instead of noisy 128px dust.
  const points=[new THREE.Vector2(r*.53,-w*.48),new THREE.Vector2(r*.82,-w*.5),new THREE.Vector2(r*.96,-w*.37),new THREE.Vector2(r,.0),new THREE.Vector2(r*.96,w*.37),new THREE.Vector2(r*.82,w*.5),new THREE.Vector2(r*.53,w*.48)];
  const tire=own(new THREE.LatheGeometry(points,64).rotateZ(Math.PI/2));
  const lug=own(new THREE.BoxGeometry(w*.29,r*.18,r*.14));
  const ring=own(new THREE.TorusGeometry(r*.63,r*.018,8,64).rotateY(Math.PI/2));
  const bolt=own(new THREE.CylinderGeometry(.014,.014,.02,6).rotateZ(Math.PI/2));
  const dummy=new THREE.Object3D();
  for(const wheel of v.wheels){
    if(!wheel.obj||bike&&wheel.side>0)continue;
    wheel.hub.visible=false;
    const group=new THREE.Group();wheel.obj.add(group);groups.push(group);
    mesh(tire,rubber,group);
    const tread=new THREE.InstancedMesh(lug,rubber,84);tread.castShadow=true;tread.receiveShadow=true;group.add(tread);
    for(let i=0;i<28;i++)for(let row=0;row<3;row++){
      const a=(i+(row===1?.5:0))*Math.PI*2/28;
      dummy.position.set((row-1)*w*.28,Math.cos(a)*r,Math.sin(a)*r);
      dummy.rotation.set(a,0,(row-1)*.18);dummy.updateMatrix();tread.setMatrixAt(i*3+row,dummy.matrix);
    }
    tread.instanceMatrix.needsUpdate=true;tread.computeBoundingSphere();
    for(const side of [-1,1]){
      mesh(ring,machined,group,side*w*.51);
      for(let i=0;i<16;i++){const a=i*Math.PI/8;mesh(bolt,machined,group,side*w*.535,Math.cos(a)*r*.63,Math.sin(a)*r*.63);}
    }
  }
  const detail=new THREE.Group();detail.name='showroom-machined-details';v.chassis.add(detail);groups.push(detail);
  const box=(w,h,d,x,y,z,m=armor)=>mesh(own(new THREE.BoxGeometry(w,h,d)),m,detail,x,y,z);
  const tube=(a,b,r=.035)=>{const p=new THREE.Vector3(...a),q=new THREE.Vector3(...b),delta=q.clone().sub(p);const o=mesh(own(new THREE.CylinderGeometry(r,r,delta.length(),16)),machined,detail);o.position.copy(p).add(q).multiplyScalar(.5);o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return o;};
  if(!bike){
    const W=spec.dims.W,L=spec.dims.L;
    // Machined front bumper, lower skid and frame fasteners.
    tube([-W*.42,-.12,L*.46],[W*.42,-.12,L*.46],.055);
    for(const x of [-W*.36,W*.36]) tube([x,-.24,L*.40],[x,.10,L*.46],.04);
    const plate=box(W*.65,.035,.38,0,-.25,L*.4);plate.rotation.x=-.14;
    for(const side of [-1,1]){
      const x=side*W*.46;
      // Horizontal tread plate, outboard of the sill, supported by the rail.
      box(.24,.035,.72,side*(W*.46+.08),-.19,-.12);
      for(const z of [-.40,.16])box(.28,.045,.045,side*(W*.44),-.23,z);
      tube([x,-.23,-.55],[x,-.23,.55],.04);
    }
    if(spec.id==='ridgeback'||spec.id==='redline'){
      const y=spec.id==='ridgeback'?.53:.29;
      for(let i=0;i<7;i++)box(W*.33,.018,.03,0,y,.65+i*.07,recess);
    }
  }else{
    // Small mechanical fasteners read at close range on the bike engine.
    for(const x of [-.15,.15])for(let j=0;j<6;j++)box(.018,.022,.28,x,-.1+j*.035,0,machined);
  }
  // Source normal maps already encode dents; avoid a wet plastic coat over
  // baked rust. HDR reflections stay crisp on exposed metal and machined rims.
  const carcass=v.carcass?.high||v.carcass;
  carcass?.traverse(o=>{
    if(o.isMesh&&o.geometry){
      const copy=o.geometry.clone();copy.deleteAttribute('normal');
      const smooth=mergeVertices(copy,1e-5);copy.dispose();smooth.computeVertexNormals();o.geometry=own(smooth);
    }
    for(const m of (Array.isArray(o.material)?o.material:[o.material])){
    if(!m?.isMeshStandardMaterial)continue;
    m.envMapIntensity=1.25;
    if(m.isMeshPhysicalMaterial){m.clearcoat=.1;m.clearcoatRoughness=.3;}
    if(m.normalMap)m.normalScale.set(.35,.35);
  }});
  for(const group of groups)for(const material of mats){
    const meshes=group.children.filter(o=>o.isMesh&&!o.isInstancedMesh&&o.material===material);
    if(meshes.length<2)continue;
    const parts=meshes.map(o=>{o.updateMatrix();return o.geometry.clone().applyMatrix4(o.matrix);});
    const merged=mergeGeometries(parts);parts.forEach(g=>g.dispose());
    if(!merged)continue;own(merged);for(const o of meshes)group.remove(o);mesh(merged,material,group);
  }
  return ()=>{for(const group of groups)group.removeFromParent();for(const g of geo)g.dispose();for(const m of mats)m.dispose();};
}

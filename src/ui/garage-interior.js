import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A real 24 x 28 x 12 m hangar. All geometry/materials belong to this group;
// downloaded PBR maps are shared by the preview asset cache.
export function buildGarageInterior(textures = {}) {
  const root = new THREE.Group(); root.name = 'combat-racing-garage';
  const materials = [];
  const mat = p => { const m = new THREE.MeshStandardMaterial(p); materials.push(m); return m; };
  const steel = mat({color:0x29353c,metalness:.82,roughness:.36});
  const edge = mat({color:0x73808a,metalness:.86,roughness:.3});
  const orange = mat({color:0xb66421,metalness:.5,roughness:.47});
  const black = mat({color:0x10161b,metalness:.2,roughness:.75});
  const floor = mat({color:0x666970,map:textures.floorColor||null,normalMap:textures.floorNormal||null,
    normalScale:new THREE.Vector2(.35,.35),roughnessMap:textures.floorRough||null,roughness:.65,metalness:.12,envMapIntensity:.3});
  const wall = mat({color:0x62686e,map:textures.wallColor||null,normalMap:textures.wallNormal||null,
    normalScale:new THREE.Vector2(.65,.65),roughnessMap:textures.wallRough||null,roughness:.9,envMapIntensity:.35});
  const cool = mat({color:0xc9e5ee,emissive:0xb8dce8,emissiveIntensity:1.7,roughness:.3});
  const warm = mat({color:0xffbe68,emissive:0xff952d,emissiveIntensity:1.5,roughness:.3});
  function box(w,h,d,x,y,z,m=steel) {
    const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);o.position.set(x,y,z);
    o.castShadow=true;o.receiveShadow=true;root.add(o);return o;
  }
  function tube(a,b,r=.045,m=edge) {
    const p=new THREE.Vector3(...a),q=new THREE.Vector3(...b),v=q.clone().sub(p);
    const o=new THREE.Mesh(new THREE.CylinderGeometry(r,r,v.length(),12),m);
    o.position.copy(p).add(q).multiplyScalar(.5);o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),v.normalize());
    o.castShadow=true;root.add(o);return o;
  }
  // Continuous floor and thick walls: orbiting never exposes the old sky.
  box(24,.18,28,0,-.11,0,floor);
  box(24,12,.4,0,6,-14,wall);box(24,12,.4,0,6,14,wall);
  box(.4,12,28,-12,6,0,wall);box(.4,12,28,12,6,0,wall);
  box(24,.2,28,0,12,0,black);
  for(const z of [-11,-5,1,7,13]) {
    for(const x of [-11.7,11.7]) {
      box(.25,11,.42,x,5.5,z);box(.65,11,.1,x,5.5,z-.22);box(.65,11,.1,x,5.5,z+.22);
      box(.74,.3,.85,x,.15,z,orange);
      for(const y of [2.5,6.5,10.5]) box(.7,.22,.6,x,y,z,edge);
    }
    box(24,.28,.35,0,10.7,z);
    tube([-11.5,10.7,z],[0,11.65,z],.09);tube([0,11.65,z],[11.5,10.7,z],.09);
    box(4.2,.06,.2,-4,10.35,z,cool);box(4.2,.06,.2,4,10.35,z,cool);
  }
  // Shutter bays, separated slats and number stencils.
  for (const [i,x] of [-8,0,8].entries()) {
    box(6.5,7,.22,x,3.5,-13.65,black);
    for(let j=0;j<30;j++) box(6.15,.17,.10,x,.25+j*.22,-13.47,steel);
    for(const dx of [-3.3,3.3]) { box(.25,7.4,.35,x+dx,3.7,-13.3,edge);box(.5,1.6,.5,x+dx,.8,-13,orange); }
    box(5,.18,.25,x,7.4,-13.1,cool);
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
    const c=canvas.getContext('2d');c.fillStyle='#b9b7a7';c.font='bold 290px monospace';c.textAlign='center';c.fillText('0'+(i+1),256,355);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const m=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false});materials.push(m);
    const sign=new THREE.Mesh(new THREE.PlaneGeometry(2.8,2.8),m);sign.position.set(x,4.5,-13.38);root.add(sign);
  }
  // Upper catwalk, safety rails and suspended bridge crane.
  box(23,.14,1.5,0,7.9,-11.9,steel);
  for(let x=-11;x<=11;x+=1.5) tube([x,8,-11.1],[x,9.05,-11.1],.035,orange);
  for(const y of [8.45,9.05]) tube([-11.5,y,-11.1],[11.5,y,-11.1],.04,orange);
  for(const x of [-10.5,10.5]) {box(.28,.42,26,x,9.8,0,edge);box(.2,.75,2,x,9.6,-4,orange);}
  box(21,.75,.65,0,8.6,-10,orange);box(1.4,.45,1.3,2,8.05,-10,black);
  tube([2,7.85,-10],[2,5.35,-10],.03,black);
  const hook=new THREE.Mesh(new THREE.TorusGeometry(.19,.055,10,20,Math.PI*1.55),edge);hook.position.set(2,5.25,-10);root.add(hook);
  // Wall pipe bundles and warm practical lamps.
  for (const side of [-1,1]) {
    for (let j=0;j<3;j++) tube([side*(11.35-j*.16),1,-13],[side*(11.35-j*.16),10,-13],.055,j===0?orange:edge);
    for(const z of [-10,-3,5,11]) {box(.2,.6,.35,side*11.4,3.4,z,warm);box(.3,.8,.5,side*11.65,3.4,z,black);}
  }
  // Central pit bay: metal drainage grates and painted hazard perimeter.
  for(const x of [-3.6,3.6]) {
    box(.38,.018,8,x,.004,0,black);
    for(let z=-3.9;z<=4;z+=.15) box(.32,.025,.04,x,.016,z,edge);
    for(let z=-4;z<4;z+=.36) {const stripe=box(.14,.007,.26,x+.35,.001,z,orange);stripe.rotation.y=.6;}
  }
  for(const z of [-4,4]) box(6.6,.008,.045,0,.001,z,orange);
  // Workshop cabinets, bench and stored supplies outside the hero bay.
  for(const x of [-8.5,8.5]) {
    box(2.1,1.15,.85,x,.6,-10.8,orange);box(2.3,.1,1,x,1.2,-10.8,edge);
    for(let j=0;j<5;j++){box(1.94,.015,.03,x,.22+j*.19,-10.35,black);box(.62,.035,.06,x,.29+j*.19,-10.30,edge);}
    for(const dx of [-.65,.65]) {box(.18,.18,.18,x+dx,.09,-10.7,black);box(.18,.18,.18,x+dx,.09,-11.1,black);}
  }
  // Static architecture shares a handful of materials; merge it so a tall
  // detailed room does not cost hundreds of draw calls per orbit frame.
  for(const material of materials){
    if(material.isMeshBasicMaterial)continue;
    const meshes=root.children.filter(o=>o.isMesh&&o.material===material);
    if(meshes.length<2)continue;
    const parts=meshes.map(o=>{o.updateMatrix();return o.geometry.clone().applyMatrix4(o.matrix);});
    const merged=mergeGeometries(parts);parts.forEach(g=>g.dispose());
    if(!merged)continue;
    for(const o of meshes){root.remove(o);o.geometry.dispose();}
    const mesh=new THREE.Mesh(merged,material);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);
  }
  root.userData.dispose=()=>{
    root.traverse(o=>o.geometry?.dispose());
    for(const m of materials){if(m.isMeshBasicMaterial)m.map?.dispose();m.dispose();}
  };
  return root;
}

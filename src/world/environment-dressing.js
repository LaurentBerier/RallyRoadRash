import * as THREE from 'three';
import { makeRNG } from '../core/rng.js';
import { boulderGeo } from './props-shapes.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Three instanced draws bridge the empty gap between terrain pixels and hero
// models. Large rocks are solid; ankle-high gravel and flexible grass are not.
const BIOMES = {
  training: { stone: 0x95816b, grass: 0x777047, outcrops: 28, size: 1.0 },
  canyon:   { stone: 0xb07450, grass: 0x81724b, outcrops: 34, size: 1.3 },
  forest:   { stone: 0x707969, grass: 0x435d36, outcrops: 22, size: 0.8 },
  volcano:  { stone: 0x5b5150, grass: 0x615146, outcrops: 36, size: 1.2 },
  thunder:  { stone: 0x9f6950, grass: 0x79614b, outcrops: 26, size: 1.1 },
};

function grassGeometry(seed) {
  const rng = makeRNG(seed), pos = [], colors = [];
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 0.32;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 0.23 + rng() * 0.48, w = 0.025 + rng() * 0.035;
    const dx = Math.cos(a) * w, dz = Math.sin(a) * w;
    pos.push(x-dx,0,z-dz, x+dx,0,z+dz,
      x+Math.cos(a)*0.2,h,z+Math.sin(a)*0.2);
    colors.push(0.48,0.48,0.48, 0.48,0.48,0.48, 1,1,1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

export function buildEnvironmentDressing(p) {
  const b = BIOMES[p.theme] || BIOMES.training;
  const rng = makeRNG((p.def.seed | 0) ^ 0x73ca9);
  const sp = p.data.spline, dummy = new THREE.Object3D(), col = new THREE.Color();
  const point = {}, nearest = {};
  const stone = p._keepMat(new THREE.MeshStandardMaterial({
    color: b.stone, roughness: 0.97, metalness: 0, envMapIntensity: 0.35,
  }));
  const scrub=p.environmentAssets?.scrub || null;
  const grass = p._keepMat(new THREE.MeshStandardMaterial({
    color: scrub ? (p.theme==='forest'?0xb1c69c:0xffffff) : b.grass,
    vertexColors: !scrub, map: scrub, alphaTest: scrub ? 0.45 : 0,
    roughness: 1, metalness: 0,
    side: THREE.DoubleSide, envMapIntensity: 0.45,
    // Thin leaves transmit skylight; a small textured fill prevents the
    // crossed cards becoming black silhouettes when viewed against the sun.
    emissiveMap: scrub, emissive: scrub ? 0xffffff : 0x000000, emissiveIntensity: 0.12,
  }));
  const pebbles = new THREE.InstancedMesh(p._keepGeo(boulderGeo(19, 0)), stone, 2200);
  let tuftGeo;
  if(scrub) {
    const planes=[];
    for(let i=0;i<3;i++) {
      const g=new THREE.PlaneGeometry(1.8,1.35);
      g.translate(0,0.56,0);g.rotateY(i*Math.PI/3);planes.push(g);
    }
    tuftGeo=mergeGeometries(planes,false);planes.forEach(g=>g.dispose());
  } else tuftGeo=grassGeometry(43);
  const tufts = new THREE.InstancedMesh(p._keepGeo(tuftGeo), grass, 4200);
  const rocks = new THREE.InstancedMesh(p._keepGeo(boulderGeo(31, 2, 1)), p.rockMat, b.outcrops*3);
  for (const m of [pebbles, tufts, rocks]) {
    m.receiveShadow = true;
    m.frustumCulled = false;
    p.group.add(m);
  }
  rocks.castShadow = true;

  const put = (mesh, i, x, y, z, sx, sy, sz) => {
    dummy.position.set(x,y,z);
    dummy.rotation.set(0, rng()*Math.PI*2, 0);
    dummy.scale.set(sx,sy,sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    col.setScalar(0.72 + rng()*0.45);
    mesh.setColorAt(i,col);
  };

  // Repeated groups, rather than independent uniform points: each little
  // scree fan has a dense centre and an irregular edge. The existing road,
  // shortcut, checkpoint and landmark keep-outs still apply.
  for (const [mesh, isGrass] of [[pebbles,false],[tufts,true]]) {
    const max = mesh.count;
    let count = 0;
    for (let cluster=0; cluster<max/8; cluster++) {
      const s = rng()*sp.length, side = rng()<0.5 ? -1 : 1;
      const offset = sp.widthAt(s)*1.3 + 0.6 + Math.pow(rng(),2.2)*12;
      sp.offsetPoint(s,side*offset,point);
      const cx=point.x, cz=point.z;
      for(let j=0;j<14 && count<max;j++) {
        const x=cx+(rng()-0.5)*14, z=cz+(rng()-0.5)*14;
        if(!p._canPlace(x,z,1.12) || !p._clearOfClaims(x,z,1) || p.terrain.slopeAt(x,z)>38) continue;
        if(isGrass && p.theme==='volcano' && rng()<0.85) continue;
        const size=isGrass ? 0.55+rng()*1.05 : 0.06+rng()*0.25;
        put(mesh,count++,x,p.terrain.heightAt(x,z)-0.025,z,size,size*(isGrass?1:0.6),size);
      }
    }
    mesh.count=count;
    mesh.userData.fullCount=count;
  }

  let count=0;
  for(let i=0;i<b.outcrops;i++) {
    const s=(i+0.2+rng()*0.6)/b.outcrops*sp.length;
    const side=rng()<0.5?-1:1;
    sp.offsetPoint(s,side*(sp.widthAt(s)+32+rng()*42),point);
    const cx=point.x, cz=point.z;
    for(let j=0;j<3;j++) {
      const radius=(2.0+rng()*3.8)*b.size;
      const extent=radius*1.5;
      const x=cx+(rng()-0.5)*13,z=cz+(rng()-0.5)*13;
      if(!p._canPlace(x,z,1.8) || !p._clearOfClaims(x,z,extent+2) || p.terrain.slopeAt(x,z)>22) continue;
      sp.nearest(x,z,nearest);
      if(nearest.d<sp.widthAt(nearest.s)+extent+10) continue;
      const shortcut=p.data.shortcutSpline;
      if(shortcut) {
        shortcut.nearest(x,z,nearest);
        if(nearest.d<shortcut.widthAt(nearest.s)+extent+10) continue;
      }
      if(p.data.checkpoints.some(c=>Math.hypot(x-c.x,z-c.z)<c.r+extent+2)) continue;
      if(p.data.gridSlots.some(g=>Math.hypot(x-g.x,z-g.z)<extent+8)) continue;
      // Conservative footprint covers the displaced boulder, including its
      // nonuniform scale. Claim it before the next cluster can overlap.
      const h=radius*(0.8+rng()*0.65);
      put(rocks,count++,x,p.terrain.heightAt(x,z)+h*0.25,z,radius,h,radius*0.8);
      p._fixedColliders.push({x,z,r:extent,kind:'rock0',bounce:0.55});
      p._claimed.push({x,z,r:extent});
    }
  }
  rocks.count=count;
  if(p.theme==='training') buildQuarryFaces(p,rng);
  for(const m of [pebbles,tufts,rocks]) {
    m.instanceMatrix.needsUpdate=true;
    if(m.instanceColor) m.instanceColor.needsUpdate=true;
  }
  p.environmentDetails=[pebbles,tufts];
  setEnvironmentQuality(p,p.quality);
}

// Fractured slabs break the continuous heightfield bench silhouettes. Their
// feet are buried into the same baked terrain used by the car, and every
// solid footprint is checked against the road, shortcut and starting grid.
function buildQuarryFaces(p,rng) {
  const g=boulderGeo(53,1);g.scale(.5,.5,.5);
  const mesh=new THREE.InstancedMesh(p._keepGeo(g),p.rockMat,150);
  const dummy=new THREE.Object3D(), nearest={}, col=new THREE.Color();
  let count=0;
  for(let i=0;i<150;i++) {
    const angle=i*2.39996323, ring=i%3;
    const radial=[265,355,475][ring]+(rng()-.5)*25;
    const x=Math.cos(angle)*radial,z=Math.sin(angle)*radial;
    const width=24+rng()*20,depth=18+rng()*12,height=9+rng()*9;
    const radius=Math.hypot(width,depth)*.65;
    if(!p._clearOfClaims(x,z,radius+1)) continue;
    let safe=true;
    for(const sp of [p.data.spline,p.data.shortcutSpline]) {
      if(!sp) continue;
      sp.nearest(x,z,nearest);
      if(nearest.d<sp.widthAt(nearest.s)+radius+10) safe=false;
    }
    if(!safe || p.data.checkpoints.some(c=>Math.hypot(x-c.x,z-c.z)<c.r+radius+2) ||
      p.data.gridSlots.some(s=>Math.hypot(x-s.x,z-s.z)<radius+8)) continue;
    let foot=p.terrain.heightAt(x,z);
    for(let j=0;j<8;j++) {
      const a=j*Math.PI/4;
      foot=Math.min(foot,p.terrain.heightAt(x+Math.cos(a)*radius*.7,z+Math.sin(a)*radius*.7));
    }
    dummy.position.set(x,foot+height*.05,z);
    dummy.rotation.set((rng()-.5)*.12,-angle+Math.PI/2,(rng()-.5)*.15);
    dummy.scale.set(width,height,depth);dummy.updateMatrix();
    mesh.setMatrixAt(count,dummy.matrix);
    col.setScalar(.78+rng()*.34);mesh.setColorAt(count++,col);
    p._fixedColliders.push({x,z,r:radius,kind:'rock0',bounce:.55});
    p._claimed.push({x,z,r:radius});
  }
  mesh.count=count;mesh.castShadow=true;mesh.receiveShadow=true;
  mesh.instanceMatrix.needsUpdate=true;
  if(mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
  mesh.frustumCulled=false;p.group.add(mesh);
}

export function setEnvironmentQuality(p,q) {
  const factor=q.name==='LOW'?0.25:q.name==='MEDIUM'?0.55:1;
  for(const m of p.environmentDetails || []) m.count=Math.floor(m.userData.fullCount*factor);
}

/** World-space concrete segment following both endpoint ground heights. */
export function concreteBarrierGeo(a,b) {
  const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
  const g=new THREE.BoxGeometry(length*0.99,0.95,0.70);
  const pos=g.attributes.position;
  for(let i=0;i<pos.count;i++) {
    const x=pos.getX(i), y=pos.getY(i);
    pos.setXYZ(i,x,y+(b[1]-a[1])*x/Math.max(length,0.001),
      pos.getZ(i)*(y>0?0.62:1));
  }
  g.rotateY(-Math.atan2(dz,dx));
  g.translate((a[0]+b[0])*0.5,(a[1]+b[1])*0.5+0.43,(a[2]+b[2])*0.5);
  g.computeVertexNormals();
  return g;
}

import { buildForestUnderstory, fernGeometry } from './forest-understory.js';
import { buildVolcanoGeology } from './volcano-geology.js';
import { buildCanyonVista } from './canyon-vista.js';
import * as THREE from 'three';
import { makeRNG } from '../core/rng.js';
import { boulderGeo } from './props-shapes.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Three instanced draws bridge the empty gap between terrain pixels and hero
// models. Large rocks are solid; ankle-high gravel and flexible grass are not.
const BIOMES = {
  training: { stone: 0x95816b, grass: 0x777047, outcrops: 64, size: 0.8 },
  canyon:   { stone: 0xb07450, grass: 0x81724b, outcrops: 90, size: 1.3 },
  forest:   { stone: 0x707969, grass: 0x435d36, outcrops: 80, size: 0.8 },
  volcano:  { stone: 0x5b5150, grass: 0x615146, outcrops: 100, size: 1.2 },
  thunder:  { stone: 0x9f6950, grass: 0x79614b, outcrops: 80, size: 1.1 },
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
  const scrub=p.theme==='forest'?null:(p.environmentAssets?.scrub || null);
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
  } else tuftGeo=p.theme==='forest'?fernGeometry():grassGeometry(43);
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
        const size=isGrass ? .40+rng()*.65 : 0.06+rng()*0.25;
        put(mesh,count++,x,p.terrain.heightAt(x,z)-0.025,z,size,size*(isGrass?1:0.6),size);
      }
    }
    mesh.count=count;
    mesh.userData.fullCount=count;
  }

  const groundFoot=(x,z,r)=>{let h=p.terrain.heightAt(x,z);if(['canyon','forest','volcano'].includes(p.theme))for(let i=0;i<12;i++){const a=i*Math.PI/6;h=Math.min(h,p.terrain.heightAt(x+Math.cos(a)*r,z+Math.sin(a)*r));}return h;};
  let count=0;
  for(let i=0;i<b.outcrops;i++) {
    const s=(i+0.2+rng()*0.6)/b.outcrops*sp.length;
    const side=rng()<0.5?-1:1;
    sp.offsetPoint(s,side*(sp.widthAt(s)+(p.theme==='training'?16:32)+rng()*(p.theme==='training'?24:42)),point);
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
      put(rocks,count++,x,groundFoot(x,z,radius)+h*0.25,z,radius,h,radius*0.8);
      p._fixedColliders.push({x,z,r:extent,kind:'rock0',bounce:0.55});
      p._claimed.push({x,z,r:extent});
    }
  }
  rocks.count=count;
  {
    const bank=new THREE.InstancedMesh(p._keepGeo(boulderGeo(35,1)),p.rockMat,640);
    let bn=0;
    // Treat a rubble bank as one geological feature, not seven isolated
    // objects whose individual keep-outs prevent them ever touching.
    // The aggregate collider encloses every rock, on every quality tier.
    for(let i=0;i<1800 && bn+8<=640;i++) {
      const s=rng()*sp.length,side=rng()<.5?-1:1,extent=3.8+rng()*3.2;
      sp.offsetPoint(s,side*(sp.widthAt(s)+extent+6.5+rng()*12),point);
      const x=point.x,z=point.z;
      if(!p._canPlace(x,z,1.3)||!p._clearOfClaims(x,z,extent+.5)||p.terrain.slopeAt(x,z)>(p.theme==='forest'?48:24))continue;
      sp.nearest(x,z,nearest);
      if(nearest.d<sp.widthAt(nearest.s)+extent+6)continue;
      if(p.data.shortcutSpline){
        p.data.shortcutSpline.nearest(x,z,nearest);
        if(nearest.d<p.data.shortcutSpline.widthAt(nearest.s)+extent+6)continue;
      }
      if(p.data.checkpoints.some(c=>Math.hypot(x-c.x,z-c.z)<c.r+extent+2))continue;
      if(p.data.gridSlots.some(g=>Math.hypot(x-g.x,z-g.z)<extent+8))continue;
      for(let j=0;j<8;j++) {
        const radius=j===0?extent*.60:.45+rng()*extent*.23;
        const a=rng()*Math.PI*2,dist=j===0?0:rng()*(extent-radius*1.5);
        const rx=x+Math.cos(a)*dist,rz=z+Math.sin(a)*dist;
        const h=radius*(j===0?1.65+rng()*.45:.8+rng()*.65);
        put(bank,bn++,rx,groundFoot(rx,rz,radius)+h*.28,rz,radius,h,radius*(.65+rng()*.3));
      }
      p._fixedColliders.push({x,z,r:extent,kind:'quarry-boulder',bounce:.55});
      p._claimed.push({x,z,r:extent});
    }
    bank.count=bn;bank.instanceMatrix.needsUpdate=true;bank.receiveShadow=true;
    bank.computeBoundingSphere();p.group.add(bank);p.quarryMediumRocks=bank;
  }
  if(['training','forest','volcano'].includes(p.theme)) {
    const crags=new THREE.InstancedMesh(p._keepGeo(boulderGeo(93,2)),p.rockMat,140);
    let n=0;
    // Embed complete scanned forms in the quarry's actual escarpments.
    // They break the smooth heightfield silhouette without cut-plane cards.
    for(let i=0;i<1800 && n<140;i++) {
      const a=rng()*Math.PI*2,r=220+rng()*310;
      const x=Math.cos(a)*r,z=Math.sin(a)*r,radius=5+rng()*7;
      if(p.terrain.slopeAt(x,z)<24 || !p._canPlace(x,z,2) || !p._clearOfClaims(x,z,radius*1.5))continue;
      sp.nearest(x,z,nearest);
      if(nearest.d<sp.widthAt(nearest.s)+radius*1.5+10)continue;
      if(p.data.shortcutSpline){
        p.data.shortcutSpline.nearest(x,z,nearest);
        if(nearest.d<p.data.shortcutSpline.widthAt(nearest.s)+radius*1.5+10)continue;
      }
      if(p.data.checkpoints.some(c=>Math.hypot(x-c.x,z-c.z)<c.r+radius*1.5+2))continue;
      if(p.data.gridSlots.some(g=>Math.hypot(x-g.x,z-g.z)<radius*1.5+8))continue;
      let base=p.terrain.heightAt(x,z);
      for(const [dx,dz] of [[radius*.6,0],[-radius*.6,0],[0,radius*.6],[0,-radius*.6]]) {
        base=Math.min(base,p.terrain.heightAt(x+dx,z+dz));
      }
      const h=radius*(1+rng()*.55);
      put(crags,n++,x,base+h*.3,z,radius,h,radius*(.6+rng()*.35));
      p._fixedColliders.push({x,z,r:radius*1.5,kind:'rock0',bounce:.55});
      p._claimed.push({x,z,r:radius*1.5});
    }
    crags.count=n;crags.instanceMatrix.needsUpdate=true;crags.receiveShadow=true;
    crags.computeBoundingSphere();p.group.add(crags);p.quarryCrags=crags;
  }
  if(p.environmentAssets?.rockHigh) {
    p.quarryNearRocks=rocks;upgradeQuarryRocks(p,rocks);
  }
  for(const m of [pebbles,tufts,rocks]) {
    m.instanceMatrix.needsUpdate=true;
    if(m.instanceColor) m.instanceColor.needsUpdate=true;
  }
  p.environmentDetails=[pebbles,tufts];
  if(p.environmentAssets?.sagebrush) {
    const sageMat=p._keepMat(grass.clone());
    sageMat.map=p.environmentAssets.sagebrush;sageMat.emissiveMap=sageMat.map;
    const sage=new THREE.InstancedMesh(tuftGeo,sageMat,tufts.count);
    const matrix=new THREE.Matrix4(),widen=new THREE.Matrix4().makeScale(1.25,.80,1.25);
    let green=0,dry=0;
    for(let i=0;i<tufts.count;i++) {
      tufts.getMatrixAt(i,matrix);tufts.getColorAt(i,col);
      if(i%3!==0) {
        sage.setMatrixAt(green,matrix.multiply(widen));sage.setColorAt(green++,col);
      } else {tufts.setMatrixAt(dry,matrix);tufts.setColorAt(dry++,col);}
    }
    tufts.count=dry;tufts.userData.fullCount=dry;
    tufts.instanceMatrix.needsUpdate=true;tufts.instanceColor.needsUpdate=true;
    sage.count=green;sage.userData.fullCount=green;sage.receiveShadow=true;
    sage.instanceMatrix.needsUpdate=true;sage.instanceColor.needsUpdate=true;
    sage.computeBoundingSphere();p.group.add(sage);p.environmentDetails.push(sage);
  }
  {
    const scree=new THREE.InstancedMesh(p._keepGeo(boulderGeo(71,0)),stone,9000);
    let n=0;
    for(let i=0;i<16000 && n<9000;i++) {
      const s=rng()*sp.length,side=rng()<0.5?-1:1;
      // Loose, ankle-high gravel belongs on the driving shoulder as well as
      // beyond it. _canPlace rejects the entire road mask, which used to
      // hide all this relief behind the concrete barriers.
      sp.offsetPoint(s,side*(sp.widthAt(s)*.86+rng()*5.5),point);
      const x=point.x,z=point.z;
      if(!p._clearOfClaims(x,z,.2)||p.terrain.slopeAt(x,z)>35)continue;
      sp.nearest(x,z,nearest);
      if(nearest.d<sp.widthAt(nearest.s)*.84)continue;
      if(p.data.shortcutSpline) {
        p.data.shortcutSpline.nearest(x,z,nearest);
        if(nearest.d<p.data.shortcutSpline.widthAt(nearest.s)*.90)continue;
      }
      if(p.data.gridSlots.some(g=>Math.hypot(x-g.x,z-g.z)<5))continue;
      const r=0.045+Math.pow(rng(),2)*0.24;
      put(scree,n++,x,p.terrain.heightAt(x,z)+r*0.08,z,r,r*0.52,r*(0.7+rng()*0.6));
    }
    scree.count=n;scree.userData.fullCount=n;scree.instanceMatrix.needsUpdate=true;
    scree.receiveShadow=true;scree.frustumCulled=false;p.group.add(scree);
    p.environmentDetails.push(scree);
  }
  if(p.theme==='canyon') buildCanyonVista(p);
  if(p.theme==='forest') buildForestUnderstory(p);
  if(p.theme==='volcano') buildVolcanoGeology(p);
  setEnvironmentQuality(p,p.quality);
}

async function upgradeQuarryRocks(p,nearRocks) {
  const {loadModel,disposeModel}=await import('../core/models.js');
  const low=p.quality.name==='LOW' || p.quality.name==='MEDIUM';
  const request=p._quarryRequest=(p._quarryRequest||0)+1;
  const model=await loadModel(low?(p.environmentAssets.rockMobile||p.environmentAssets.rockLow):p.environmentAssets.rockHigh);
  if(!model) return;
  const distantModel=low?model:await loadModel(p.environmentAssets.rockLow);
  const release=()=>{disposeModel(model);if(distantModel&&distantModel!==model)disposeModel(distantModel);};
  if(p._disposed || request!==p._quarryRequest){release();return;}
  const currentLow=p.quality.name==='LOW' || p.quality.name==='MEDIUM';
  if(low!==currentLow){release();upgradeQuarryRocks(p,nearRocks);return;}
  model.updateMatrixWorld(true);
  let source;model.traverse(o=>{if(o.isMesh&&!source)source=o;});
  if(!source){release();return;}
  const geo=source.geometry.clone().applyMatrix4(source.matrixWorld);
  geo.computeBoundingBox();
  const size=new THREE.Vector3(),center=new THREE.Vector3();
  geo.boundingBox.getSize(size);geo.boundingBox.getCenter(center);
  geo.translate(-center.x,-center.y,-center.z);
  geo.scale(1/Math.max(size.x,size.z),1/Math.max(size.x,size.z),1/Math.max(size.x,size.z));
  let distantSource;
  distantModel?.updateMatrixWorld(true);
  distantModel?.traverse(o=>{if(o.isMesh&&!distantSource)distantSource=o;});
  const distantGeo=distantSource?distantSource.geometry.clone().applyMatrix4(distantSource.matrixWorld):geo.clone();
  if(distantSource){
    distantGeo.translate(-center.x,-center.y,-center.z);
    distantGeo.scale(1/Math.max(size.x,size.z),1/Math.max(size.x,size.z),1/Math.max(size.x,size.z));
  }
  const mat=source.material.clone();mat.color.set(0xffffff);
  mat.envMapIntensity=1;mat.roughness=1;mat.side=THREE.DoubleSide;
  const tint={training:[1.65,1.52,1.32],canyon:[1.40,.91,.64],forest:[1.05,1.12,1.04],volcano:[.48,.49,.53],thunder:[1.25,.86,.64]}[p.theme]||[1,1,1];
  mat.onBeforeCompile=shader=>{
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
      float stoneLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(stoneLuma),.7)*vec3(${tint.map(n=>n.toFixed(3)).join(',')});`);
  };
  mat.customProgramCacheKey=()=> 'biome-scan-'+p.theme;
  for(const old of p.quarryScans||[]) {p.group.remove(old);old.dispose();}
  for(const resource of p.quarryScanResources||[]) resource.dispose();
  p.quarryScanResources=[mat];
  p.quarryScans=[];
  for(const [old,factor] of [[nearRocks,2],[p.quarryMediumRocks,2],[p.quarryCrags,2]]) {
    if(!old)continue;
    // Bury the scan's underside and keep its silhouette low enough to read
    // as fallen scree. Its full footprint remains inside the solid collider.
    const g=(old===nearRocks&&p.theme==='training'?geo:distantGeo).clone().scale(factor,factor*0.72,factor);p.quarryScanResources.push(g);
    // Spatial batches let the camera and shadow frusta discard the quarry
    // behind the car, rather than drawing an entire ring on every pass.
    const buckets=new Map();
    for(let i=0;i<old.count;i++) {
      const a=old.instanceMatrix.array,offset=i*16;
      const bucket=p.theme==='training'
        ?Math.min(7,Math.floor((Math.atan2(a[offset+14],a[offset+12])+Math.PI)/(Math.PI*2)*8))
        :Math.floor(a[offset+12]/128)+','+Math.floor(a[offset+14]/128);
      if(!buckets.has(bucket))buckets.set(bucket,[]);
      const transform=a.slice(offset,offset+16);
      if(p.theme==='forest' || p.theme==='volcano') {
        // Scan silhouettes differ from their procedural placeholders. Seat
        // the lower third of the actual mesh, including its sloping footprint.
        g.computeBoundingBox();const lo=g.boundingBox.min.y,hi=g.boundingBox.max.y;
        const vertices=g.attributes.position,matrix=new THREE.Matrix4().fromArray(transform),v=new THREE.Vector3();
        let shift=0;
        for(let j=0;j<vertices.count;j++)if(vertices.getY(j)<lo+(hi-lo)*.30) {
          v.fromBufferAttribute(vertices,j).applyMatrix4(matrix);
          shift=Math.min(shift,p.terrain.heightAt(v.x,v.z)-v.y-.15);
        }
        transform[13]+=shift;
      }
      buckets.get(bucket).push(transform);
    }
    for(const matrices of buckets.values()) {
      if(!matrices.length)continue;
      const mesh=new THREE.InstancedMesh(g,mat,matrices.length);
      matrices.forEach((a,i)=>mesh.instanceMatrix.array.set(a,i*16));
      mesh.instanceMatrix.needsUpdate=true;
      mesh.castShadow=!low && old!==p.quarryCrags;mesh.receiveShadow=true;mesh.computeBoundingSphere();
      p.group.add(mesh);p.quarryScans.push(mesh);
    }
    old.visible=false;
  }
  geo.dispose();distantGeo.dispose();release();
  p.quarryScanStatus=low?'loaded-low':'loaded-high';
}

export function setEnvironmentQuality(p,q) {
  const factor=q.name==='LOW'?0.25:q.name==='MEDIUM'?0.55:1;
  for(const m of p.environmentDetails || []) m.count=Math.floor(m.userData.fullCount*factor);
  const tier=q.name==='LOW'||q.name==='MEDIUM'?'loaded-low':'loaded-high';
  if(p.quarryScanStatus && tier!==p.quarryScanStatus) upgradeQuarryRocks(p,p.quarryNearRocks);
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

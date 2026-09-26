import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// All scene dressing is built synchronously with its collision footprint.
// Downloading a model changes its appearance, never the physical course.
export function dressLandmarkSite(p, h, site) {
  const parts = [], m = new THREE.Matrix4(), o = new THREE.Object3D();
  const cy = Math.cos(site.yaw), sy = Math.sin(site.yaw);
  const world = (x,z) => ({x:site.x+x*cy+z*sy, z:site.z-x*sy+z*cy});
  const road=p.data.spline.posAt(site.s,{});
  const vx=site.x-road.x,vz=site.z-road.z, length2=vx*vx+vz*vz;
  const tint = (g, color) => {
    const c=new THREE.Color(color), a=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<a.length;i+=3) {a[i]=c.r;a[i+1]=c.g;a[i+2]=c.b;}
    g.setAttribute('color',new THREE.BufferAttribute(a,3));
    g.deleteAttribute('uv');
    return g;
  };
  const box = (x,y,z,w,ht,d,color,angle=0) => {
    const q=world(x,z), g=tint(new THREE.BoxGeometry(w,ht,d),color);
    o.position.set(q.x,site.y+y,q.z);o.rotation.set(0,site.yaw+angle,0);o.scale.setScalar(1);o.updateMatrix();
    g.applyMatrix4(o.matrix);parts.push(g);
  };
  const beam = (a,b,width,color) => {
    const start=world(a[0],a[2]),end=world(b[0],b[2]);
    const av=new THREE.Vector3(start.x,site.y+a[1],start.z);
    const bv=new THREE.Vector3(end.x,site.y+b[1],end.z);
    const delta=bv.clone().sub(av);
    const g=tint(new THREE.BoxGeometry(width,delta.length(),width),color);
    o.position.copy(av).add(bv).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
    o.scale.setScalar(1);o.updateMatrix();g.applyMatrix4(o.matrix);parts.push(g);
  };
  // Clear the construction footprint out of the preplanned scatter. Retain
  // instance indices so quality switches and the dynamic pool stay consistent.
  for(let vi=0;vi<p.scatterMeshes.length;vi++) {
    const mesh=p.scatterMeshes[vi];
    for(let i=0;i<mesh.userData.placed;i++) {
      mesh.getMatrixAt(i,m);
      const x=m.elements[12],z=m.elements[14];
      const t=Math.max(0,Math.min(1,((x-road.x)*vx+(z-road.z)*vz)/Math.max(1,length2)));
      const nearView=Math.hypot(x-road.x-vx*t,z-road.z-vz*t)<4+h.r*t*0.6;
      const kind=p.recipe.kinds[vi].id;
      const tall=kind.startsWith('pine')||kind==='hoodoo'||kind==='broadleaf';
      if(Math.hypot(x-site.x,z-site.z)>h.r+3 && !(tall&&nearView)) continue;
      m.makeScale(0,0,0);mesh.setMatrixAt(i,m);
      p._scatterSolids[vi][i]=null;
    }
    mesh.instanceMatrix.needsUpdate=true;
  }
  const rock=p.theme==='canyon', forest=p.theme==='forest';
  const base=rock ? 0x704b39 : forest ? 0x454b42 : 0x525356;
  const depth=Math.max(0.4,site.y-site.low+0.18), radius=h.r*0.94;
  if(h.id!=='tailsection') {
  const foundation=tint(new THREE.CylinderGeometry(h.natural ? radius*0.68 : radius,radius*1.025,depth,rock?11:8),h.natural ? 0x995b39 : base);
  if(h.natural) {
    const a=foundation.attributes.position;
    for(let i=0;i<a.count;i++) {
      const x=a.getX(i),z=a.getZ(i),angle=Math.atan2(z,x);
      const variation=0.90+0.10*Math.sin(angle*3+0.4)+0.05*Math.cos(angle*5);
      a.setXYZ(i,x*variation,a.getY(i),z*variation);
    }
    foundation.computeVertexNormals();
  }
  foundation.translate(site.x,site.y-depth/2,site.z);parts.push(foundation);
  }
  // A segmented lip breaks up the broad footing; all pieces stay within the
  // authored collider. The darker inset reads as a service deck, not a pedestal.
  if(!rock) {
    box(0,-0.01,0,radius*1.32,0.14,radius*1.32,forest?0x59503d:0x343b40);
    for(const side of [-1,1]) {
      box(side*radius*0.79,0.10,0,0.20,0.20,radius*0.9,0x999184);
      if(!forest) for(let k=-2;k<=2;k++) box(side*radius*0.79,0.22,k*radius*0.17,0.23,0.035,radius*0.08,k%2?0x20262a:0xc78936);
    }
  }
  if(h.id==='training-conveyor') {
    // The loading belt, its trestles and service walkways all fit inside the
    // existing 18 m site collider. One merged draw, no new runtime machinery.
    const steel=0x686055,rust=0x77503a,rail=0x999180;
    const beltY=x=>5+(x+12)*0.32;
    for(const z of [-5.8,-2.2]) {
      beam([-12,beltY(-12),z],[12,beltY(12),z],0.28,steel);
      beam([-12,beltY(-12)-1.8,z],[12,beltY(12)-1.8,z],0.25,rust);
      beam([-12,beltY(-12)+1,z],[12,beltY(12)+1,z],0.08,rail);
      for(let x=-12;x<12;x+=3) {
        beam([x,beltY(x),z],[x+3,beltY(x+3)-1.8,z],0.12,rust);
        beam([x,beltY(x),z],[x,beltY(x)+1,z],0.08,rail);
      }
    }
    for(let x=-12;x<=12;x+=1.5) {
      box(x,beltY(x)-0.10,-4,1.52,0.20,3.5,0x30302b);
    }
    for(const x of [-9,0,9]) {
      for(const z of [-5.8,-2.2]) beam([x,0,z],[x,beltY(x)-1.7,z],0.38,steel);
      beam([x,0,-5.8],[x,beltY(x)-1.7,-2.2],0.16,rust);
      beam([x,0,-2.2],[x,beltY(x)-1.7,-5.8],0.16,rust);
      box(x,0.3,-4,2,0.6,5,0x797365);
    }
    // Loading hopper and ribbed service cabinet at the low end of the belt.
    box(-10,3,2,5,5,5,0x6e6050);
    box(-10,5.6,2,6,0.5,6,0x393b37);
    for(let z=-0.3;z<4.5;z+=0.65) box(-12.55,3,z,0.13,4.8,0.12,rust);
    for(let x=-12;x<=-8;x+=1) box(x,3,4.55,0.12,4.8,0.13,rust);
    // Screening tower: open structure, intermediate service platforms,
    // diagonal braces and a corrugated control room establish human scale.
    for(const x of [5.8,11.8]) for(const z of [2,8]) {
      beam([x,0,z],[x,17,z],.34,steel);
      for(let y=0;y<15;y+=5) {
        const opposite=x===5.8?11.8:5.8;
        beam([x,y,z],[opposite,y+5,z],.16,rust);
      }
    }
    for(const y of [5,10,15]) {
      box(8.8,y,5,7,.25,7,0x575a51);
      for(const z of [1.6,8.4]) {
        beam([5.3,y+1.1,z],[12.3,y+1.1,z],.075,rail);
        for(let x=5.3;x<=12.3;x+=1.4) beam([x,y,z],[x,y+1.1,z],.075,rail);
      }
      // Short alternating flights on the outward face of the tower.
      for(let j=0;j<12;j++) box(12.8,y-4.8+j*.4,2+j*.48,1.2,.13,.52,steel);
    }
    box(8.8,16.5,5,4.8,3,4.7,0x9a907b);
    box(8.8,16.9,2.62,3.7,1.15,.10,0x334751);
    box(8.8,18.15,5,5.5,.22,5.4,0x55564d);
    for(let x=6.5;x<11.2;x+=.5)box(x,16.4,7.4,.07,2.9,.11,rail);
    // A second transfer chute feeds a stockpile inside the same solid site.
    for(const z of [10,12]) beam([-10,2,z],[7,12,z],.24,steel);
    for(let i=0;i<18;i++) {
      const x=-10+i, y=2+i*10/17;
      box(x,y,11,1.1,.18,2.1,0x393a32);
      if(i%4===0) for(const z of [10,12])beam([x,0,z],[x,y,z],.22,rust);
    }
    const pile=tint(new THREE.ConeGeometry(5.8,4.4,22,4),0x938675);
    const pa=pile.attributes.position;
    for(let i=0;i<pa.count;i++) {
      const x=pa.getX(i),z=pa.getZ(i),a=Math.atan2(z,x);
      const k=1+.08*Math.sin(a*5)+.045*Math.cos(a*9);
      pa.setXYZ(i,x*k,pa.getY(i),z*k);
    }
    pile.computeVertexNormals();const pq=world(-9,7);
    pile.translate(pq.x,site.y+2.05,pq.z);parts.push(pile);
  }
  // A few grounded, stage-specific satellites give the hero a working context.
  const ids=p.theme==='training'?['pipes','crate','drum','jersey']
    :rock?['scrap','husk0','drum','pipes']
    :forest?['logstack','stump','crate','logstack']
    :p.theme==='volcano'?['pipes','pipework','drum','jersey']
    :['tyrewall','drum','crate','tyrewall'];
  for(let i=0;i<ids.length;i++) {
    const a=(i*1.45+0.5), dist=h.r+4+(i%2)*2;
    const q=world(Math.cos(a)*dist,Math.sin(a)*dist);
    if(!p._canPlace(q.x,q.z,1.5)||p.terrain.slopeAt(q.x,q.z)>12) continue;
    const g=p._kitGeo(ids[i]);if(!g)continue;
    const clone=g.clone();
    o.position.set(q.x,p.terrain.heightAt(q.x,q.z)-0.04,q.z);
    o.rotation.set(0,site.yaw+i*0.3,0);o.scale.setScalar(0.8);o.updateMatrix();
    clone.applyMatrix4(o.matrix);parts.push(clone);
    p._fixedColliders.push({x:q.x,z:q.z,r:ids[i]==='logstack'||ids[i]==='tyrewall'?2.6:1.4,kind:'landmark-dressing',bounce:0.6});
    p._claimed.push({x:q.x,z:q.z,r:3});
  }
  const merged=mergeGeometries(parts,false);parts.forEach(g=>g.dispose());
  if(!merged)return;
  const mesh=new THREE.Mesh(p._keepGeo(merged),p.dressMat);
  mesh.name=h.id+'-setting';mesh.castShadow=true;mesh.receiveShadow=true;
  merged.computeBoundingSphere();p.group.add(mesh);
}

import * as THREE from 'three';
import { makeRNG } from '../core/rng.js';
import { pineGeo, patchFoliageMaterial } from './props-shapes.js';

// Curved fronds with paired leaflets: actual volume, no upright scrub cards.
export function fernGeometry() {
  const vertices=[],colors=[];
  for(let f=0;f<7;f++) {
    const a=f*Math.PI*2/7,dx=Math.cos(a),dz=Math.sin(a);
    for(let k=1;k<8;k++) {
      const t=k/8,r=t*.85,y=Math.sin(t*Math.PI*.85)*.55;
      const w=Math.sin(t*Math.PI)*.22;
      for(const side of [-1,1]) {
        vertices.push(dx*r,y,dz*r, dx*(r+.15)-dz*w*side,y+.025,dz*(r+.15)+dx*w*side,dx*(r+.12),y+.03,dz*(r+.12));
        colors.push(.42,.53,.29,.74,.83,.49,.58,.69,.37);
      }
    }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  g.computeVertexNormals();return g;
}

export function buildForestUnderstory(p) {
  // Farther groves fill the view from the ridge; the race's existing scatter
  // remains the interactive roadside layer. Fixed trunk colliders persist
  // across quality changes along with these inexpensive instanced stands.
  const rng=makeRNG(p.def.seed^0x78ab),sp=p.data.spline,point={},near={};
  const mat=p._keepMat(patchFoliageMaterial(new THREE.MeshStandardMaterial({
    vertexColors:true,map:p.foliageTexture||null,alphaTest:p.foliageTexture ? .42 : 0,
    side:THREE.DoubleSide,roughness:1,envMapIntensity:.45,
  })));
  const dummy=new THREE.Object3D();
  for(let v=0;v<3;v++) {
    const mesh=new THREE.InstancedMesh(p._keepGeo(pineGeo(v+11)),mat,260);let n=0;
    for(let i=0;i<2200&&n<260;i++) {
      const s=rng()*sp.length,side=rng()<.5?-1:1;
      sp.offsetPoint(s,side*(85+rng()*180),point);
      const x=point.x,z=point.z;
      if(!p._canPlace(x,z,2)||!p._clearOfClaims(x,z,3)||p.terrain.slopeAt(x,z)>43)continue;
      sp.nearest(x,z,near);if(near.d<sp.widthAt(near.s)+40)continue;
      if(p.data.shortcutSpline){p.data.shortcutSpline.nearest(x,z,near);if(near.d<p.data.shortcutSpline.widthAt(near.s)+40)continue;}
      const size=.8+rng()*1.1;
      dummy.position.set(x,p.terrain.heightAt(x,z)-.35,z);
      dummy.rotation.set(0,rng()*Math.PI*2,0);dummy.scale.set(size,size*(.9+rng()*.2),size);
      dummy.updateMatrix();mesh.setMatrixAt(n++,dummy.matrix);
      p._fixedColliders.push({x,z,r:.3*size,kind:'pine0',bounce:.35});
      p._claimed.push({x,z,r:2.5});
    }
    mesh.count=n;mesh.receiveShadow=true;mesh.computeBoundingSphere();p.group.add(mesh);
  }
}

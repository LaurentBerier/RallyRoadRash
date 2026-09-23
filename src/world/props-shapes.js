/* ============================================================
   SCATTER GEOMETRY AND THE ROCK SHADER
   ------------------------------------------------------------
   Split out of props.js, which owns PLACEMENT and had grown past the
   house line limit carrying three unrelated jobs. This half is the one
   that makes SHAPES the kit cannot: everything here is either displaced
   from a primitive (rocks, hoodoos, basalt) or built without vertex
   colours because it wants a real material (pines, logs, cones, tyres).

   kit.js is the other shape file and the rule between them is simple:
   if it carries its colour in the vertex stream and merges with a hay
   bale, it belongs in kit.js. If it needs its own material — a triplanar
   rock, a green pine, an orange cone — it belongs here.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRNG, vnoise, fbm } from '../core/rng.js';

/** Deterministic 0..1 from a world point. Cheap, uncorrelated on a lattice. */
export function hash2(x, z) {
  let h = Math.imul((x * 8192) | 0, 0x27d4eb2d) ^ Math.imul((z * 8192) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Irregular rock. Three octaves of displacement then a radius quantise, so
    the silhouette is angular at every scale you can see it at. */
export function boulderGeo(seed, detail = 2, squash = 0.76) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    n.copy(v).normalize();
    let d = 1.0;
    d += (fbm(n.x * 1.7 + seed, n.z * 1.7 - seed, 2, 2.1, 0.5, seed | 0) - 0.5) * 0.66;
    d += (fbm(n.x * 4.3 + seed * 2, n.y * 4.3 - seed, 3, 2.1, 0.5, (seed * 13) | 0) - 0.5) * 0.30;
    d += (vnoise(n.x * 11.0 + seed * 5, n.z * 11.0 - seed * 3, (seed * 31) | 0) - 0.5) * 0.11;
    d = Math.round(d * 11) / 11 * 0.34 + d * 0.66;      // facet the fracture planes
    d *= 1 - 0.32 * Math.max(0, -n.y);                  // flatter where it meets the ground
    v.copy(n).multiplyScalar(d);
    v.y *= squash;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');                              // triplanar in the shader
  g.deleteAttribute('normal');
  // Weld duplicated icosphere corners before recalculating normals. Computing
  // them on the triangle soup gave every boulder a low-poly jewel finish.
  const smooth = mergeVertices(g);
  smooth.computeVertexNormals();
  g.dispose();
  return smooth;
}

/** A hoodoo: stacked resistant caps on a soft column, which is exactly how the
    real ones form and the only reason they read at 200 m. */
export function hoodooGeo(seed, natural=false) {
  if(natural) {
    const g=new THREE.CylinderGeometry(.64,1.02,4.8,20,32),pos=g.attributes.position;
    for(let i=0;i<pos.count;i++) {
      const x=pos.getX(i),y=pos.getY(i)+2.4,z=pos.getZ(i),a=Math.atan2(z,x);
      const bed=1+.055*Math.sin(y*8.2)+.035*Math.sin(y*17.1);
      const neck=1-.19*Math.exp(-Math.pow((y-3.6)*2,2));
      const fracture=1+.065*Math.sin(a*5+seed)+.035*Math.sin(a*11+y);
      pos.setXYZ(i,x*bed*neck*fracture,y,z*bed*neck*fracture);
    }
    return finish([g]);
  }
  const rng = makeRNG((seed * 7919) | 1), parts=[];
  const levels=5, step=1.0;
  for(let i=0;i<levels;i++) {
    const t=i/(levels-1), radius=1.15*(1-t*0.35);
    const g=new THREE.CylinderGeometry(radius*(i===levels-1?1.15:0.91),radius,step*1.18,11,2);
    const pos=g.attributes.position;
    for(let j=0;j<pos.count;j++) {
      const x=pos.getX(j),y=pos.getY(j),z=pos.getZ(j),a=Math.atan2(z,x);
      const k=1+0.13*Math.sin(a*3+seed)+0.065*Math.sin(a*7+y*3+i);
      pos.setXYZ(j,x*k,y+0.08*Math.sin(a*4+i),z*k);
    }
    g.translate(Math.sin(i*.8+seed)*.18,i*step+.45,Math.cos(i*.6)*.12);
    parts.push(g);
  }
  return finish(parts);
}

/** Irregular branch whorls and a brown trunk, merged into one instanced draw. */
export function pineGeo(seed) {
  const rng = makeRNG((seed * 104729) | 1);
  const h = 8.8 + rng() * 5.2;
  const parts = [];
  const paint = (g, base, variation) => {
    const c = new THREE.Color(base), pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let j = 0; j < pos.count; j++) {
      const k = 0.80 + variation * (0.5 + 0.5 * Math.sin(pos.getX(j)*3 + pos.getY(j)*1.7 + pos.getZ(j)*5));
      colors[j*3] = c.r*k; colors[j*3+1] = c.g*k; colors[j*3+2] = c.b*k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  };
  const trunk = new THREE.CylinderGeometry(0.065, 0.23, h * 0.85, 7, 1);
  for(let i=0;i<trunk.attributes.uv.count;i++) trunk.attributes.uv.setXY(i,-1,0);
  trunk.translate(0, h * 0.425, 0);
  paint(trunk, 0x65513c, 0.22);
  // Open branch whorls leave sky between the limbs. The old stacked cones
  // made every tree a solid Christmas-tree silhouette even at arm's length.
  for (let i = 0; i < 13; i++) {
    const t = i/12, y=h*(0.20+t*0.75), radius=(2.65-t*2.35)*(0.66+rng()*0.65);
    const verts=[], uvs=[];
    const branches=6 + (i % 3);
    for(let j=0;j<branches;j++) {
      const a=j/branches*Math.PI*2+i*2.4+(rng()-0.5)*0.45;
      const r=radius*(0.72+rng()*0.46), dx=Math.cos(a), dz=Math.sin(a);
      const width=r*0.48, droop=0.25+rng()*0.48;
      const root=[0,y+0.42,0], left=[dx*r*0.58-dz*width,y-droop,dz*r*0.58+dx*width];
      const right=[dx*r*0.58+dz*width,y-droop,dz*r*0.58-dx*width];
      const tip=[dx*r,y-droop*0.55,dz*r];
      const ridge=[dx*r*0.55,y+0.17,dz*r*0.55];
      const uvFor=new Map([[root,[0.5,0]],[left,[0,0.4]],[tip,[0.5,1]],[right,[1,0.4]],[ridge,[0.5,0.45]]]);
      for(const tri of [[root,left,ridge],[left,tip,ridge],[tip,right,ridge],[right,root,ridge]]) {
        for(const v of tri) { verts.push(...v); uvs.push(...uvFor.get(v)); }
      }
    }
    const branch=new THREE.BufferGeometry();
    branch.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
    branch.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    branch.setIndex(Array.from({length:verts.length/3},(_,i)=>i));
    branch.computeVertexNormals();
    paint(branch,i%2?0x253f2c:0x344c32,0.40);
  }
  const g = finish(parts, true);
  g.userData.height = h;
  return g;
}

/** Fallen log, lying along X with a stub or two. */
export function logGeo(seed) {
  const rng = makeRNG((seed * 15485863) | 1);
  const len = 3.2 + rng() * 4.5, r = 0.22 + rng() * 0.18;
  const parts = [];
  const body = new THREE.CylinderGeometry(r * 0.8, r, len, 8, 1);
  body.rotateZ(Math.PI / 2);
  body.translate(0, r, 0);
  parts.push(body);
  for (let i = 0; i < 2; i++) {
    if (rng() > 0.55) continue;
    const s = new THREE.CylinderGeometry(0.05, 0.09, 0.5 + rng(), 5, 1);
    s.rotateZ((rng() - 0.5) * 1.6);
    s.translate((rng() - 0.5) * len * 0.7, r + 0.25, 0);
    parts.push(s);
  }
  return finish(parts);
}

/** Columnar basalt: a hexagonal prism, snapped off at an angle. */
export function basaltGeo(seed) {
  const rng = makeRNG((seed * 32452843) | 1);
  const parts = [];
  const n = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const h = 1.0 + rng() * 3.4;
    const r = 0.35 + rng() * 0.4;
    const c = new THREE.CylinderGeometry(r, r * 1.04, h, 6, 1);
    c.rotateY(rng() * 6.283);
    c.rotateZ((rng() - 0.5) * 0.42);
    c.translate((rng() - 0.5) * 1.7, h * 0.46, (rng() - 0.5) * 1.7);
    parts.push(c);
  }
  return finish(parts);
}

/** Spatter cone around a vent — open at the top so it reads as a hole. */
export function ventGeo(seed) {
  const rng = makeRNG((seed * 49979687) | 1);
  const h = 1.4 + rng() * 2.2;
  const g = new THREE.CylinderGeometry(0.55 + rng() * 0.4, 2.1 + rng() * 1.4, h, 12, 1, true);
  g.translate(0, h * 0.5, 0);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
}

/** Marker cone with a base. */
export function coneGeo() {
  return finish([
    new THREE.ConeGeometry(0.24, 0.68, 10, 1).translate(0, 0.36, 0),
    new THREE.BoxGeometry(0.52, 0.05, 0.52).translate(0, 0.025, 0)
  ]);
}

/** Stack of three tyres. Open cylinders, not tori: a torus of any usable
    smoothness is 170 triangles and there are four hundred of these — from a
    moving car the silhouette is a stack of dark rings either way. */
export function tyreStackGeo() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.CylinderGeometry(0.52, 0.52, 0.28, 11, 1, true);
    t.translate(0, 0.16 + i * 0.29, 0);
    parts.push(t);
  }
  return finish(parts);
}

/** A single upright quad from A to B, `h` metres tall, as its own geometry. */
export function railQuad(ax, ay, az, bx, by, bz, h) {
  const g = new THREE.BufferGeometry();
  const len = Math.hypot(bx - ax, bz - az);
  const u = Math.max(0.25, len / 4);
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    ax, ay - h * 0.5, az, bx, by - h * 0.5, bz,
    bx, by + h * 0.5, bz, ax, ay + h * 0.5, az
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u, 0, u, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Merge, renormal, drop the uv. Every factory above ends the same way. */
function finish(parts, keepUV = false) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  if (!keepUV) g.deleteAttribute('uv');
  return g;
}

// The negative UV marks bark, so one instanced tree draw can keep its trunk
// opaque while cutting the photographic needle silhouette out of its boughs.
// Install on both the color and depth material to make shadows agree.
export function patchFoliageMaterial(material) {
  material.onBeforeCompile = sh => {
    sh.fragmentShader=sh.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
      if(vMapUv.x >= 0.0) {
        vec4 needles=texture2D(map,vMapUv);
        diffuseColor.rgb=needles.rgb*1.10;
        diffuseColor.a*=needles.a;
      }
      #endif
    `);
    if(material.isMeshStandardMaterial) {
      // Thin needles retain a little transmitted skylight on the shaded
      // side. Opaque bark keeps its ordinary lighting and shadow response.
      sh.fragmentShader=sh.fragmentShader.replace('#include <emissivemap_fragment>',`
        #include <emissivemap_fragment>
        #ifdef USE_MAP
        if(vMapUv.x>=0.) totalEmissiveRadiance+=texture2D(map,vMapUv).rgb*.18;
        #endif
      `);
    }
  };
  material.customProgramCacheKey=()=> 'rrr-foliage-v3';
  return material;
}

/** Triplanar rock surface injected into a standard material: no UVs needed on
    an arbitrary lump, world-space so neighbouring rocks never repeat, and
    faded with distance so a pebble at 80 m is not a pixel-sized noise
    generator. */
export function rockMaterial(color, dustCol, rockTex = null) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.93, metalness: 0.0 });
  if(rockTex) m.defines={ROCK_TEXTURE:1};
  const dc = new THREE.Color(dustCol);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDustCol = { value: new THREE.Vector3(dc.r, dc.g, dc.b) };
    sh.uniforms.uRockTex = { value: rockTex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRkW; varying vec3 vRkN;')
      // After <begin_vertex> both `transformed` and `objectNormal` exist. The
      // instance matrix has to be applied by hand — every rock carries its own
      // rotation, and without it the detail sits in the wrong place.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 rkP = vec4(transformed, 1.0);
          vec3 rkN = objectNormal;
          #ifdef USE_INSTANCING
            rkP = instanceMatrix * rkP;
            rkN = mat3(instanceMatrix) * rkN;
          #endif
          vRkW = (modelMatrix * rkP).xyz;
          vRkN = normalize(mat3(modelMatrix) * rkN);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRkW; varying vec3 vRkN; uniform vec3 uDustCol;
        #ifdef ROCK_TEXTURE
        uniform sampler2D uRockTex;
        #endif
        float rkH(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
        float rkN2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(rkH(i),rkH(i+vec2(1,0)),f.x), mix(rkH(i+vec2(0,1)),rkH(i+vec2(1,1)),f.x), f.y); }
        float rkF(vec2 p){ return rkN2(p)*0.55 + rkN2(p*2.13+7.7)*0.28 + rkN2(p*4.31+19.3)*0.17; }
        float rkTri(vec3 w, vec3 n, float s){
          vec3 b = pow(abs(n), vec3(4.0)); b /= (b.x+b.y+b.z);
          return rkF(w.yz*s)*b.x + rkF(w.xz*s)*b.y + rkF(w.xy*s)*b.z;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 rn = normalize(vRkN);
          float fade = 1.0 - smoothstep(25.0, 110.0, length(vViewPosition));
          float coarse = rkTri(vRkW, rn, 1.7);
          float fine   = mix(0.5, rkTri(vRkW, rn, 8.0), fade);
          diffuseColor.rgb *= 0.72 + 0.34*coarse + 0.16*fine;
          // Sedimentary seams and mineral inclusions belong to the rock,
          // rather than a repeated UV stamp. Basalt gets the same fractures
          // through its own dark palette.
          float strata = sin(vRkW.y*3.2 + rkF(vRkW.xz*0.16)*2.0);
          float seam = smoothstep(0.72,0.98,strata);
          diffuseColor.rgb *= 1.0 - 0.20*seam;
          diffuseColor.rgb *= 0.88 + 0.20*smoothstep(0.24,0.70,fine);
          // dust settles on anything facing up
          float up = smoothstep(0.15, 0.85, rn.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, uDustCol, up*(0.22 + 0.28*coarse));
          #ifdef ROCK_TEXTURE
          vec3 tw=pow(abs(rn),vec3(4.0));tw/=max(dot(tw,vec3(1.0)),0.001);
          vec3 scan=texture2D(uRockTex,vRkW.zy*0.14).rgb*tw.x
            +texture2D(uRockTex,vRkW.xz*0.14).rgb*tw.y
            +texture2D(uRockTex,vRkW.xy*0.14).rgb*tw.z;
          float mineral=dot(scan,vec3(0.2126,0.7152,0.0722));
          diffuseColor.rgb*=clamp(mineral*4.0,0.25,1.6);
          #endif
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= 0.84 + 0.24*rkTri(vRkW, normalize(vRkN), 3.0);`);
  };
  m.customProgramCacheKey = () => 'rrr-rock-' + color.toString(16) + (rockTex ? '-scan' : '');
  return m;
}

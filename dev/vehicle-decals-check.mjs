import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyVehicleDecals, setVehicleDecalSource, DECAL_REGIONS } from '../src/game/vehicle-decals.js';
import { mudify } from '../src/game/vehicle-carcass.js';
import { bannerTex, gantryTex, sponsorTex } from '../src/world/props-recipes.js';

const image = { width: 2048, height: 1024 };
const texture = new THREE.Texture(image);
setVehicleDecalSource(() => null);
const plain = new THREE.MeshStandardMaterial();
const originalCompile = plain.onBeforeCompile;
assert.equal(applyVehicleDecals(plain, 'hopper', new THREE.Matrix4()), false);
assert.equal(plain.onBeforeCompile, originalCompile, 'missing art keeps original material');
setVehicleDecalSource(() => texture);
const keys = new Set();
for (const id of Object.keys(DECAL_REGIONS)) {
  const material = new THREE.MeshPhysicalMaterial();
  const mud = { value: .65 };
  mudify(material, mud);
  const matrix = new THREE.Matrix4().makeRotationY(Math.PI/2).setPosition(0,.3,0);
  assert.equal(applyVehicleDecals(material, id, matrix), true);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  material.onBeforeCompile(shader);
  matrix.identity();
  assert.equal(shader.uniforms.uMud, mud, 'live mud uniform survives decal patch');
  assert.equal(shader.uniforms.uRallyDecal.value, texture);
  assert.equal(shader.uniforms.uDecalBody.value.elements[13], .3, 'per-mesh transform is copied');
  assert.ok(shader.fragmentShader.indexOf('float rallyCoverage') < shader.fragmentShader.indexOf('float _mud'),
    'mud must cover stickers, not appear underneath them');
  assert.ok(shader.fragmentShader.includes('metalnessFactor = mix(metalnessFactor,0.08,rallyCoverage)'));
  assert.ok(shader.vertexShader.includes('uDecalNormal * normal'));
  assert.ok(shader.fragmentShader.includes('sign(vDecalP.x)'), 'opposite sides keep readable lettering');
  assert.ok(shader.fragmentShader.includes('-(vDecalP.z-uDecalSide.x)*sign(vDecalP.x)'), 'side text reads left-to-right from outside');
  assert.ok(shader.fragmentShader.includes('uDecalRear'), 'tail sponsor artwork is available to the chase camera');
  keys.add(material.customProgramCacheKey());
  let disposed = false; texture.addEventListener('dispose', () => { disposed = true; });
  material.dispose(); assert.equal(disposed, false, 'cars never dispose shared decal assets');
}
assert.equal(keys.size, 1, 'vehicle-specific uniforms share a shader program');

const calls = [];
const context = new Proxy({}, {get: (target,key) => key in target ? target[key] : (...args) => calls.push([key,...args])});
globalThis.document = {createElement: () => ({getContext: () => context})};
for (const [build,label] of [[() => gantryTex('#fff',texture),'ROAD RASH'],
  [() => bannerTex('CHECK','#fff',texture),'CHECK'],
  [() => sponsorTex('SUNSTRIKE','#fff',0,texture),'SUNSTRIKE']]) {
  calls.length = 0;
  const map = build();
  assert.equal(map.image.width,2048);assert.equal(map.image.height,512);
  assert.equal(calls.filter(c=>c[0]==='drawImage').length,2, 'fabric also textures printed labels');
  assert.ok(calls.some(c=>c[0]==='fillText'&&c[1]===label));
  assert.equal(map.colorSpace,THREE.SRGBColorSpace);
  map.dispose();
}
calls.length=0;
const fallback=bannerTex('CHECK','#fff');
assert.equal(fallback.image.width,512);
assert.equal(calls.filter(c=>c[0]==='drawImage').length,0, 'missing image uses procedural signage');
fallback.dispose();setVehicleDecalSource(null);plain.dispose();texture.dispose();
for (const [label,row] of [['CHECK',0],['BIG AIR',1],['SUNSTRIKE',2],['RIDGEBACK',3]]) {
  calls.length=0;
  const map=bannerTex(label,'#fff',{atlas:{image},fabric:texture});
  const draw=calls.find(c=>c[0]==='drawImage');
  assert.equal(draw[3],image.height*row/4,'each sign samples its own generated atlas row');
  assert.equal(calls.filter(c=>c[0]==='fillText').length,0,'finished image includes its own headline');
  map.dispose();
}
calls.length=0;
const finished=gantryTex('#fff',{gantry:{image}});
assert.equal(calls.filter(c=>c[0]==='fillText').length,0,'Road Rash uses the finished generated artwork');
finished.dispose();
console.log('PASS: four vehicle decal shaders, body transforms, mud composition, shared resources, banner images and fallback');

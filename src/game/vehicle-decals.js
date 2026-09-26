import * as THREE from 'three';

// Shared images belong to Assets, never to an individual car. Projection in
// body space keeps both GLB LODs aligned without changing their baked UVs.
let source = null;
export function setVehicleDecalSource(fn) { source = typeof fn === 'function' ? fn : null; }
export function vehicleDecal(id) { return source?.(id) || null; }

// Side region: centre Z/Y, width/height in metres. Restrict to outer body
// surfaces so the rider, glass, frame and interior do not acquire lettering.
export const DECAL_REGIONS = {
  hopper:    { side: [0, .15, 1.65, .68], outer: .53, hood: [1.18, .64, 1.08, .16] },
  ridgeback: { side: [.13, .30, 1.85, .78], outer: .66, hood: [1.65, .70, 1.35, .22] },
  redline:   { side: [-.10, .08, 1.75, .58], outer: .57, hood: [1.53, .62, 1.13, .10] },
  moto:     { side: [-.10, .02, .70, .35], outer: .07, hood: [0, 0, 0, 0] },
};
const HOOD_CROPS = {
  hopper: [.68, .28, .28, .60], ridgeback: [.59, .28, .30, .60],
  redline: [.68, .26, .29, .60], moto: [.60, .28, .34, .60],
};
const REAR_REGIONS = {
  hopper: [1.1,.25,.16,1.35], ridgeback: [1.5,.30,.22,1.95],
  redline: [1.3,.23,.02,1.65], moto: [0,0,0,100],
};

export function applyVehicleDecals(mat, id, bodyMatrix) {
  const texture = vehicleDecal(id), region = DECAL_REGIONS[id];
  if (!texture || !region || !mat.isMeshStandardMaterial) return false;
  const compile = mat.onBeforeCompile;
  const cacheKey = mat.customProgramCacheKey();
  const transform = bodyMatrix.clone();
  const normals = new THREE.Matrix3().getNormalMatrix(transform);
  texture.anisotropy = 16;
  mat.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    Object.assign(shader.uniforms, {
      uRallyDecal: { value: texture }, uDecalBody: { value: transform },
      uDecalNormal: { value: normals }, uDecalSide: { value: new THREE.Vector4(...region.side) },
      uDecalHood: { value: new THREE.Vector4(...region.hood) }, uDecalOuter: { value: region.outer },
      uHoodCrop: { value: new THREE.Vector4(...HOOD_CROPS[id]) },
      uDecalRear: { value: new THREE.Vector4(...REAR_REGIONS[id]) },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uDecalBody; uniform mat3 uDecalNormal; varying vec3 vDecalP; varying vec3 vDecalN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDecalP = (uDecalBody * vec4(position, 1.0)).xyz; vDecalN = normalize(uDecalNormal * normal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uRallyDecal;
uniform vec4 uDecalSide, uDecalHood, uHoodCrop, uDecalRear;
uniform float uDecalOuter;
varying vec3 vDecalP, vDecalN;
float rallyEdge(vec2 uv) {
  vec2 d = min(uv, 1.0 - uv);
  return smoothstep(0.0, 0.018, min(d.x, d.y));
}`)
      .replace('#include <color_fragment>', `
vec3 rallyN = normalize(vDecalN);
// Reverse projection on the far side so text reads forward on both doors.
vec2 rallyUV = vec2(-(vDecalP.z-uDecalSide.x)*sign(vDecalP.x)/uDecalSide.z,
                    (vDecalP.y-uDecalSide.y)/uDecalSide.w) + 0.5;
float rallyMask = rallyEdge(rallyUV) * smoothstep(0.65, 0.88, abs(rallyN.x))
                  * step(uDecalOuter, abs(vDecalP.x));
// Reuse just the cream number area for the hood; keep the sponsors on the sides.
vec2 hoodUV = vec2(vDecalP.x/max(uDecalHood.z,0.01),
                  -(vDecalP.z-uDecalHood.x)/max(uDecalHood.y,0.01)) + 0.5;
float hoodMask = rallyEdge(hoodUV) * smoothstep(0.70,0.92,rallyN.y)
                 * step(uDecalHood.w,vDecalP.y) * step(0.01,uDecalHood.y);
vec3 rallyInk = texture2D(uRallyDecal, clamp(rallyUV,0.0,1.0)).rgb;
vec3 hoodInk = texture2D(uRallyDecal, uHoodCrop.xy+clamp(hoodUV,0.0,1.0)*uHoodCrop.zw).rgb;
diffuseColor.rgb = mix(diffuseColor.rgb,rallyInk,rallyMask);
diffuseColor.rgb = mix(diffuseColor.rgb,hoodInk,hoodMask);
// Sponsor strip on the tail is visible from the normal chase camera.
vec2 rearUV = vec2(-vDecalP.x/max(uDecalRear.x,0.01),
                  (vDecalP.y-uDecalRear.z)/max(uDecalRear.y,0.01)) + 0.5;
float rearMask = rallyEdge(rearUV) * smoothstep(0.65,0.9,-rallyN.z)
                 * step(uDecalRear.w,-vDecalP.z);
vec3 rearInk = texture2D(uRallyDecal,vec2(.08,.04)+clamp(rearUV,0.0,1.0)*vec2(.77,.20)).rgb;
diffuseColor.rgb = mix(diffuseColor.rgb,rearInk,rearMask);
float rallyCoverage = max(max(rallyMask,hoodMask),rearMask);
#include <color_fragment>`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor,0.72,rallyCoverage);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor,0.08,rallyCoverage);');
  };
  mat.customProgramCacheKey = () => cacheKey + '|rally-decals-v1';
  mat.needsUpdate = true;
  return true;
}

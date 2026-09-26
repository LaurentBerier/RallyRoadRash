import * as THREE from 'three';

// Body-space micro relief supplements (never replaces) the authored normal
// atlas. Metre-scaled sampling gives close views extra detail without enlarging
// a low-resolution image. Fade frequencies before they become subpixel.
export function addVehicleSurface(material, bodyMatrix = new THREE.Matrix4()) {
  const previous = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const matrix = bodyMatrix.clone();
  material.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.uSurfaceBody = { value: matrix };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uSurfaceBody; varying vec3 vSurfaceP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfaceP = (uSurfaceBody * vec4(position,1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSurfaceP;
float rallyGrain(vec3 p, float frequency) {
  vec3 q = p * frequency;
  float fade = 1.0 - smoothstep(0.3, 1.2, length(fwidth(q)));
  return sin(q.x + sin(q.z)) * sin(q.y - q.z) * fade;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
// Fine peening and broader shallow scuffs, on top of dents and panel seams.
float relief = rallyGrain(vSurfaceP, 170.0) * 0.000055
             + rallyGrain(vSurfaceP, 43.0) * 0.00016;
vec3 surfX = dFdx(-vViewPosition), surfY = dFdy(-vViewPosition);
vec3 surfR1 = cross(surfY, normal), surfR2 = cross(normal, surfX);
float surfDet = dot(surfX, surfR1);
vec3 surfGradient = sign(surfDet) * (dFdx(relief)*surfR1 + dFdy(relief)*surfR2);
normal = normalize(abs(surfDet)*normal - surfGradient + normal*1e-12);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + rallyGrain(vSurfaceP,43.0)*0.035,0.24,1.0);`);
  };
  material.customProgramCacheKey = () => key + '|rally-surface-v1';
}

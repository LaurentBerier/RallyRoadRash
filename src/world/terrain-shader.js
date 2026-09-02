/* ============================================================
   RALLY ROAD RASH — terrain look
   ------------------------------------------------------------
   Themes (sun, sky, haze, palette), the shared height GLSL, and the two
   material factories the clipmap runs on. Nothing here bakes or samples a
   field: it is handed a live Terrain and reads its textures and its theme.

   The height GLSL in TERRAIN_GLSL is one half of a contract — the CPU half
   is Terrain.heightAt() in terrain.js. Read the parity table below before
   changing either.
   ============================================================ */
import * as THREE from 'three';
import {
  MACRO_EXT, MACRO_RES, FAR_EXT, FAR_RES, DET_TILE, DET_RES, DENT_EXT,
  SUNMASK_EXT, SURF_EXT, SURF_RES, DET_AMP, DET_AMP2, DET_SCALE2,
  FADE0, FADE1, CURVE_R,
} from './terrain-const.js';

/* ============================================================
   1.  THEMES — sun, sky, haze, palette
   ============================================================
   The sun does not move during a race, which is what lets the occlusion
   mask be baked once at load instead of every frame. */

/* Canonical surface albedos. Themes tint these and may override individual
   entries; the shader gets the resolved 7-entry table as a uniform array. */
const SURF_BASE = [
  [0.44, 0.42, 0.39],   // ROAD   hardpack, two-tone in the shader
  [0.42, 0.32, 0.22],   // DIRT
  [0.76, 0.65, 0.45],   // SAND
  [0.20, 0.15, 0.11],   // MUD
  [0.44, 0.42, 0.40],   // ROCK
  [0.29, 0.37, 0.19],   // GRASS
  [0.30, 0.11, 0.06]    // LAVA   crust; the glow is emissive
];

export const THEMES = {
  training: {
    name: 'PROVING GROUNDS',
    sun: [0.38, 0.70, 0.60], sunCol: [1.34, 1.30, 1.20],
    sky: [0.40, 0.53, 0.72], ground: [0.26, 0.24, 0.20], ambient: 0.62,
    haze: [0.66, 0.73, 0.83], hazeDensity: 0.00050, hazeStart: 90,
    tint: [1.00, 1.00, 1.00],
    surf: {}
  },
  canyon: {
    // Late afternoon, sun low across the wash. Clear warm air: you can see the
    // far mesas, which is the whole point of a desert.
    name: 'SUNSTRIKE CANYON',
    sun: [0.74, 0.34, -0.58], sunCol: [1.62, 1.34, 1.02],
    sky: [0.46, 0.52, 0.70], ground: [0.38, 0.27, 0.18], ambient: 0.58,
    haze: [0.80, 0.68, 0.52], hazeDensity: 0.00032, hazeStart: 140,
    tint: [1.08, 0.98, 0.88],
    surf: { 4: [0.52, 0.27, 0.18], 1: [0.50, 0.35, 0.22] }   // red rock, red dirt
  },
  forest: {
    // Overcast-bright and misty: the haze is doing the work here, stacking the
    // pine ridges into layers instead of one flat green wall.
    //
    // Ambient came down from 0.82 and DIRT/ROCK got their own entries after a
    // look at what the stage actually rendered: the default brown DIRT under
    // an 0.82 hemisphere fill tone-mapped to (207,195,168) — bone, not loam —
    // and the whole valley read as a desert with pine trees standing in it.
    // 0.72 with a darker, wetter substrate puts the ground back where the
    // track description has always claimed it is. The road stays legible: it
    // is ROAD/DIRT at 0.40-plus and now has something dark to contrast with.
    name: 'TIMBERLINE CLIMB',
    sun: [-0.30, 0.76, 0.58], sunCol: [1.14, 1.16, 1.12],
    sky: [0.52, 0.58, 0.64], ground: [0.19, 0.21, 0.16], ambient: 0.72,
    haze: [0.66, 0.71, 0.72], hazeDensity: 0.00125, hazeStart: 45,
    tint: [0.94, 0.98, 0.94],
    surf: {
      5: [0.24, 0.34, 0.16],    // GRASS
      3: [0.17, 0.13, 0.09],    // MUD
      1: [0.27, 0.21, 0.14],    // DIRT — forest loam, not desert hardpack
      4: [0.34, 0.35, 0.32],    // ROCK — damp grey granite, faintly green
    }
  },
  volcano: {
    // Low red sun through smoke. Everything not lit by it is lit by the ground.
    name: 'CALDERA RUN',
    sun: [-0.62, 0.28, 0.73], sunCol: [1.50, 0.94, 0.62],
    // Ambient raised from 0.50 after QA: away-from-sun climbs read as a wall
    // of murk at 0.50, and this track needs its road legible at 130 km/h.
    sky: [0.34, 0.24, 0.23], ground: [0.28, 0.14, 0.09], ambient: 0.64,
    haze: [0.36, 0.20, 0.17], hazeDensity: 0.00115, hazeStart: 70,
    tint: [1.02, 0.90, 0.86],
    surf: { 4: [0.25, 0.23, 0.23], 1: [0.31, 0.24, 0.19] }
  }
};

/** Resolved 7x3 albedo table for a theme. */
export function themePalette(theme) {
  const T = THEMES[theme] || THEMES.training;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const o = T.surf[i] || SURF_BASE[i];
    out.push([o[0] * T.tint[0], o[1] * T.tint[1], o[2] * T.tint[2]]);
  }
  return out;
}

/* ============================================================
   4.  GLSL — one height function, shared by every terrain shader
   ============================================================

   CPU / SHADER HEIGHT AGREEMENT
   -----------------------------
   Terrain.heightAt(x,z) and terrainH(p) below must return the same number
   for the same point, always. Term by term:

     term            CPU (heightAt)                     GPU (terrainH)
     ------------------------------------------------------------------
     macro field     bilinear(macro, MACRO_RES,         hMacro(): SAMPLE_H on
                       MACRO_EXT) — clamp-to-edge         uMacro, uv=p/uConst.x+0.5,
                       indexing, identical to             hardware LinearFilter or
                       GL_LINEAR/CLAMP_TO_EDGE            texBil() when the float
                                                          -linear extension is absent
     far field       bilinear(far, FAR_RES, FAR_EXT)    SAMPLE_H on uFar, same uv form
     macro->far      lerp by sstep(FADE0, FADE1,        mix by smoothstep(uConst3.z,
                       hypot(x,z))                        uConst3.w, length(p))
     road mask       bilinear(roadMask,MACRO_RES,       roadMaskAt(): texture2D on
                       MACRO_EXT)/255                     uRoad (R8, always LinearFilter
                                                          — no extension needed)
     bump            bilinear(bump, SURF_RES,           bumpAt(): texture2D on uBump
                       SURF_EXT)/255                      (R8, LinearFilter), uv=p/uConst3.x
     detail amp      (1-road*0.85)*(0.30+0.85*bump)     identical expression
     detail tile     bilinearWrap(det, DET_RES,         SAMPLE_H on uDetail with
                       x/DET_TILE, z/DET_TILE)*DET_AMP    RepeatWrapping, p/uConst.z,
                       + same at DET_SCALE2 with the      * uConst2.x, plus the
                       (0.37,0.71) offset * DET_AMP2      DET_SCALE2 tap * uConst2.y
     dent            -bilinear(dent,dentRes,DENT_EXT),  -hDent(): SAMPLE_H on uDent,
                       zero outside the field             zero outside 0.001..0.999

   There is deliberately NO camera-distance fade on the detail term and no
   per-ring amplitude scaling: either would be a height the CPU cannot see.
   The clipmap's sag (uSag) and the horizon curvature are applied AFTER
   terrainH, in the vertex shader only — they move where a vertex is drawn,
   not where the ground is.
   ============================================================ */
export const TERRAIN_GLSL = /* glsl */`
// ESSL 3.00 defaults samplers to lowp; the R32F height fields hold values to
// ~250 m, and a strict GLES driver's lowp is ±2. Desktop ANGLE ignores this —
// a mobile driver may not.
precision highp sampler2D;
uniform sampler2D uMacro, uFar, uDetail, uDent, uRoad, uBump, uLat;
uniform vec4 uConst;      // MACRO_EXT, FAR_EXT, DET_TILE, DENT_EXT
uniform vec4 uConst2;     // DET_AMP, DET_AMP2, DET_SCALE2, TRAIL_EXT
uniform vec4 uConst3;     // SURF_EXT, SURF_RES, FADE0, FADE1
uniform vec3 uCamXZ;
uniform vec2 uLod;
uniform vec4 uTexRes;     // macro, far, detail, dent texel counts

#ifdef MANUAL_BILINEAR
/* Four taps and a lerp — what the sampler would have done for us. Only the
   R32F height fields need this; the R8 masks filter natively everywhere. */
float texBil(sampler2D t, vec2 uv, float res){
  vec2 p = uv * res - 0.5;
  vec2 i = floor(p), f = fract(p);
  vec2 b = (i + 0.5) / res, e = vec2(1.0 / res, 0.0);
  float h00 = textureLod(t, b, 0.0).r;
  float h10 = textureLod(t, b + e.xy, 0.0).r;
  float h01 = textureLod(t, b + e.yx, 0.0).r;
  float h11 = textureLod(t, b + e.xx, 0.0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
  #define SAMPLE_H(t, uv, res, lod) texBil(t, uv, res)
#else
  #define SAMPLE_H(t, uv, res, lod) textureLod(t, uv, lod).r
#endif

float hMacro(vec2 p){
  vec2 uv = p / uConst.x + 0.5;
  float m = SAMPLE_H(uMacro, clamp(uv, 0.0005, 0.9995), uTexRes.x, uLod.x);
  float f = SAMPLE_H(uFar, clamp(p / uConst.y + 0.5, 0.0005, 0.9995), uTexRes.y, uLod.y);
  return mix(m, f, smoothstep(uConst3.z, uConst3.w, length(p)));
}
float roadMaskAt(vec2 p){
  return texture2D(uRoad, clamp(p / uConst.x + 0.5, 0.0005, 0.9995)).r;
}
float bumpAt(vec2 p){
  return texture2D(uBump, clamp(p / uConst3.x + 0.5, 0.0005, 0.9995)).r;
}
/* Signed offset ACROSS the road in half-widths: 0 on the crown, ±1 at the
   edge of the roadbed, saturating at ±1.4 out in the verge. Baked, because
   the height field is single-valued and carries no lateral channel. Off the
   carved corridor it reads 0, so gate every use on roadMaskAt() > 0. */
float latAt(vec2 p){
  return (texture2D(uLat, clamp(p / uConst3.x + 0.5, 0.0005, 0.9995)).r * 255.0 - 128.0) / 90.0;
}
float hDetail(vec2 p){
  // No fract() here: the tile is RepeatWrapping, and folding the coordinate by
  // hand would put a hard seam at every tile boundary in BOTH paths.
  float d  = SAMPLE_H(uDetail, p / uConst.z, uTexRes.z, 0.0) * uConst2.x;
  d += SAMPLE_H(uDetail, p / uConst2.z + vec2(0.37, 0.71), uTexRes.z, 0.0) * uConst2.y;
  return d;
}
float hDent(vec2 p){
  vec2 uv = p / uConst.w + 0.5;
  if (any(lessThan(uv, vec2(0.001))) || any(greaterThan(uv, vec2(0.999)))) return 0.0;
  return SAMPLE_H(uDent, uv, uTexRes.w, 0.0);
}
float terrainH(vec2 p){
  float road = roadMaskAt(p);
  float bmp  = bumpAt(p);
  float amp  = (1.0 - road * 0.85) * (0.30 + 0.85 * bmp);
  return hMacro(p) + hDetail(p) * amp - hDent(p);
}
`;

/* ============================================================
   MATERIALS
   ============================================================ */
export function buildTerrainMaterial(t) {
  const T = THEMES[t.theme] || THEMES.training;
  const pal = themePalette(t.theme).map(c => new THREE.Vector3(c[0], c[1], c[2]));

  const U = t.uniforms = {
    uMacro: { value: t.texMacro }, uFar: { value: t.texFar },
    uDetail: { value: t.texDetail }, uDent: { value: t.texDent },
    uRoad: { value: t.texRoad }, uSurf: { value: t.texSurf },
    uBump: { value: t.texBump }, uLat: { value: t.texLat },
    uTrail: { value: t.trailRT.texture },
    uSunMask: { value: t.sunRT.texture },
    uConst: { value: new THREE.Vector4(MACRO_EXT, FAR_EXT, DET_TILE, DENT_EXT) },
    uConst2: { value: new THREE.Vector4(DET_AMP, DET_AMP2, DET_SCALE2, t.TRAIL_EXT) },
    uConst3: { value: new THREE.Vector4(SURF_EXT, SURF_RES, FADE0, FADE1) },
    uCamXZ: { value: new THREE.Vector3() },
    uSunDir: { value: t.sunDir.clone() },
    uSunCol: { value: new THREE.Vector3(T.sunCol[0], T.sunCol[1], T.sunCol[2]) },
    uSkyCol: { value: new THREE.Vector3(T.sky[0], T.sky[1], T.sky[2]) },
    uGroundCol: { value: new THREE.Vector3(T.ground[0], T.ground[1], T.ground[2]) },
    uAmbient: { value: T.ambient },
    uHazeCol: { value: new THREE.Vector3(T.haze[0], T.haze[1], T.haze[2]) },
    uHaze: { value: new THREE.Vector2(T.hazeDensity, T.hazeStart) },
    uSurfCol: { value: pal },
    uSunMaskExt: { value: SUNMASK_EXT },
    uCurveR: { value: CURVE_R },
    uCell: { value: 0.3 },
    uSag: { value: 0.0 },
    uLod: { value: new THREE.Vector2(0, 0) },
    uTexRes: { value: new THREE.Vector4(MACRO_RES, FAR_RES, DET_RES, t.dentRes) },
    uTime: { value: 0 },
    uFogK: { value: 1.0 },
    // vehicles + props, from three's directional shadow map
    uRShadow: { value: null },
    uRShadowMat: { value: new THREE.Matrix4() },
    uRShadowOn: { value: 0 },
    uRShadowTexel: { value: 1 / 2048 }
  };

  const vert = /* glsl */`
    ${TERRAIN_GLSL}
    uniform float uCurveR, uCell, uSag;
    varying vec3 vW; varying vec3 vN; varying float vDent; varying float vRoad;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec2 p = wp.xz;
      float h = terrainH(p);
      float e = max(uCell, 0.25);
      float hx = terrainH(p + vec2(e, 0.0));
      float hz = terrainH(p + vec2(0.0, e));
      vN = normalize(vec3(h - hx, e, h - hz));
      vDent = hDent(p);
      vRoad = roadMaskAt(p);
      wp.y = h - uSag;
      wp.y -= dot(p - uCamXZ.xy, p - uCamXZ.xy) / (2.0 * uCurveR);   // horizon curvature
      vW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  const frag = /* glsl */`
    precision highp float;
    #include <packing>
    varying vec3 vW; varying vec3 vN; varying float vDent; varying float vRoad;
    uniform sampler2D uSunMask, uTrail, uSurf;
    uniform sampler2D uRShadow; uniform mat4 uRShadowMat;
    uniform float uRShadowOn, uRShadowTexel;
    uniform vec3 uSunDir, uSunCol, uSkyCol, uGroundCol, uHazeCol;
    uniform vec3 uSurfCol[7];
    uniform float uSunMaskExt, uTime, uFogK, uAmbient;
    uniform vec2 uHaze;
    uniform vec4 uConst2, uConst3;

    float h1(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
    float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(h1(i),h1(i+vec2(1,0)),f.x), mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x), f.y); }
    const mat2 RA = mat2(0.8090,-0.5878,0.5878,0.8090);
    const mat2 RB = mat2(0.3090,0.9511,-0.9511,0.3090);
    float fb(vec2 p){ return n2(p)*0.55 + n2(RA*p*2.17+7.7)*0.30 + n2(RB*p*4.01+19.3)*0.15; }

    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vW);
      float dist = distance(vW.xz, cameraPosition.xz);
      float near = 1.0 - smoothstep(26.0, 190.0, dist);

      /* ---- which surface are we standing on ----
         The map is NEAREST because an id has no meaning halfway between two
         values. To stop the 1.2 m texel grid reading as a checkerboard, the
         lookup point is dithered by up to one texel — the boundary between
         two surfaces becomes an interlocking noise rather than a staircase,
         which is also what a real edge between rock and sand looks like. */
      float texel = uConst3.x / uConst3.y;
      vec2 jit = (vec2(fb(vW.xz*0.9), fb(vW.xz*0.9+31.7)) - 0.5) * texel * 1.25;
      vec2 suv = clamp((vW.xz + jit) / uConst3.x + 0.5, 0.0005, 0.9995);
      int sid = int(texture2D(uSurf, suv).r * 255.0 + 0.5);

      /* three's own unroll pragma rather than a dynamic uSurfCol[sid]: the
         index is legal in GLSL ES 3.00, but a fixed seven-way select costs
         nothing and cannot be miscompiled by a mobile driver. */
      vec3 albedo = uSurfCol[0];
      #pragma unroll_loop_start
      for (int i = 0; i < 7; i++) { if (UNROLLED_LOOP_INDEX == sid) albedo = uSurfCol[i]; }
      #pragma unroll_loop_end

      float rough = 1.0;          // 1 = fully diffuse, lower = a spec lobe appears
      vec3 emis = vec3(0.0);

      /* ---- micro relief: the grain has to CATCH the light, not be painted on ---- */
      #define GRIT(P) (n2((P)*4.1)*0.58 + n2((P)*16.0)*0.42)
      float g0 = GRIT(vW.xz);
      float varN = fb(vW.xz*0.31);
      float speck = n2(vW.xz*9.3);
      float gritK = 0.55;

      if (sid == 0) {
        /* ROAD — hardpack. Two-tone along the direction of travel: the
           centre crown stays pale and dusty, the wheel tracks either side
           are polished darker by everything that has driven them. */
        float polish = smoothstep(0.35, 0.95, vRoad);
        albedo *= 0.86 + 0.30*fb(vW.xz*0.22);
        albedo *= mix(1.0, 0.80, polish * (0.45 + 0.55*n2(vW.xz*0.9)));
        rough = 0.82; gritK = 0.22;
      } else if (sid == 1) {
        albedo *= 0.84 + 0.34*varN + 0.16*g0;              // DIRT: clods
        albedo *= 0.92 + 0.20*speck;
      } else if (sid == 2) {
        // SAND: bright, and rippled at a wavelength you can see from the car
        float rip = 0.5 + 0.5*sin(vW.x*1.7 + vW.z*0.9 + fb(vW.xz*0.12)*9.0);
        albedo *= 0.92 + 0.14*rip + 0.10*varN;
        gritK = 0.38;
      } else if (sid == 3) {
        // MUD: dark, wet, and the only surface here with a real highlight
        albedo *= 0.80 + 0.34*varN;
        albedo = mix(albedo, albedo*0.62, smoothstep(0.4, 0.8, fb(vW.xz*0.6)));
        rough = 0.28; gritK = 0.30;
      } else if (sid == 4) {
        albedo *= 0.74 + 0.42*fb(vW.xz*0.55) + 0.18*g0;    // ROCK: mottled, hard
        rough = 0.72; gritK = 0.85;
      } else if (sid == 5) {
        // GRASS: green broken with brown, at two scales, or it reads as felt
        // 'patch' is reserved in ESSL 3.00 (tessellation) — hence the terse name.
        float pch = fb(vW.xz*0.28);
        albedo = mix(albedo, vec3(0.34,0.30,0.16), smoothstep(0.42,0.78,pch));
        albedo *= 0.82 + 0.36*n2(vW.xz*2.7);
        gritK = 0.70;
      } else if (sid == 6) {
        /* LAVA: black crust cracked over something moving. The pulse is slow
           and out of phase across the field, so a channel breathes rather
           than blinking. */
        float crack = fb(vW.xz*0.85 + vec2(0.0, uTime*0.035));
        float glow = smoothstep(0.46, 0.80, crack);
        float pulse = 0.62 + 0.38*sin(uTime*0.9 + vW.x*0.05 + vW.z*0.031);
        albedo *= 0.55 + 0.30*crack;
        emis = vec3(2.6, 0.72, 0.14) * glow * pulse;
        rough = 0.55; gritK = 0.45;
      }

      /* ---- past the edge of the world, everything is bedrock ----
         The surface map only covers ±620 m. Outside it the uv clamps, so the
         ENTIRE horizon — thousands of metres of relief — inherits whatever
         loose surface happens to sit on the border texel. On SUNSTRIKE
         CANYON that is SAND, albedo 0.82, which tone-maps to 0.93 and turns
         a desert's far mesas into a snowfield; on TIMBERLINE CLIMB it is
         DIRT and the ridges read as bone. It was the single worst thing in
         any of the four stages and it was the same bug in all of them.

         Distant relief is not loose material. Wind and water strip a slope
         that size back to rock, so fade toward the theme's ROCK palette,
         darkened, over the last 100 m of the map. Near ground is untouched:
         the crossfade finishes 520 m out and nothing is playable past 600. */
      {
        float edge = max(abs(vW.x), abs(vW.z)) / uConst3.x;
        float outside = smoothstep(0.42, 0.50, edge);
        albedo = mix(albedo, uSurfCol[4] * (0.66 + 0.24*fb(vW.xz*0.045)), outside);
        rough = mix(rough, 0.85, outside);
      }

      /* ---- steep ground can't hold its coat ----
         The surface map is painted in plan view, so an embankment cut by the
         road carve gets the same GRASS or SAND id as the flat beside it — and
         a 60° green wall reads as a hedge, a pale one as a snowdrift. Loose
         cover slides off a slope in reality; blend steep faces toward the
         ROCK palette (darkened raw substrate) regardless of painted id. */
      float steep = smoothstep(0.86, 0.62, N.y);   // 0 flat .. 1 past ~38°
      if (sid != 6) {                              // lava keeps its glow
        vec3 scree = uSurfCol[4] * (0.62 + 0.30*fb(vW.xz*0.5) + 0.14*g0);
        albedo = mix(albedo, scree, steep * 0.85);
        rough = mix(rough, 0.8, steep);
      }

      vec3 Nr = N;
      if (near > 0.002 && gritK > 0.01){
        float e = 0.05;
        float gx = GRIT(vW.xz + vec2(e, 0.0));
        float gz = GRIT(vW.xz + vec2(0.0, e));
        Nr = normalize(N + vec3(-(gx-g0), 0.0, -(gz-g0)) * gritK * near);
      }

      /* ---- freshly churned ground is DARKER and wetter, not brighter ----
         (the instinct to brighten a fresh cut is wrong for dirt: what a
         wheel turns up is damp subsoil.) */
      float churn = smoothstep(0.02, 0.35, abs(vDent));
      albedo *= 1.0 - 0.30 * churn;
      rough = mix(rough, rough*0.72, churn);

      /* ---- tyre marks ----
         Sampled per PIXEL, not per vertex: a 0.35 m mark across a 0.30 m
         clipmap cell would otherwise be smeared into nothing. */
      vec2 tuv = vec2(vW.x, -vW.z) / uConst2.w + 0.5;
      float trackFade = 1.0 - smoothstep(150.0, 520.0, dist);
      float tr = (tuv.x>0.004&&tuv.x<0.996&&tuv.y>0.004&&tuv.y<0.996)
               ? texture2D(uTrail, tuv).r * trackFade : 0.0;
      if (tr > 0.004){
        // Recover the direction of travel from the gradient of the trail
        // field so the tread lies ACROSS the mark instead of drifting through
        // it on some fixed diagonal.
        float e = 2.0 / uConst2.w;
        vec2 g = vec2(texture2D(uTrail, tuv + vec2(e,0.0)).r - texture2D(uTrail, tuv - vec2(e,0.0)).r,
                      texture2D(uTrail, tuv + vec2(0.0,e)).r - texture2D(uTrail, tuv - vec2(0.0,e)).r);
        vec2 across = vec2(g.x, -g.y);
        vec2 along = (length(across) > 1e-4) ? normalize(vec2(-across.y, across.x)) : vec2(1.0, 0.0);
        float tread = smoothstep(0.05, 0.9, 0.5 + 0.5*sin(dot(vW.xz, along * 34.0)));
        albedo *= mix(1.0, 0.46 + 0.24*tread, tr);
        rough = mix(rough, rough*0.80, tr);
        Nr = normalize(mix(Nr, N, tr*0.8));       // the grain is crushed flat
      }

      /* ---- shadowing: baked terrain self-shadow, sun is static per track ---- */
      vec2 smu = vW.xz / uSunMaskExt + 0.5;
      float sm = (smu.x>0.0&&smu.x<1.0&&smu.y>0.0&&smu.y<1.0) ? texture2D(uSunMask, smu).r : 1.0;

      /* ---- plus the cars and the props, from the real shadow map ----
         Without this the machine floats: nothing sells contact with a surface
         like the shadow it throws across it. */
      if (uRShadowOn > 0.5){
        vec4 sc = uRShadowMat * vec4(vW, 1.0);
        vec3 sp = sc.xyz / sc.w;
        if (sp.x > 0.001 && sp.x < 0.999 && sp.y > 0.001 && sp.y < 0.999 && sp.z < 1.0){
          float d = sp.z - 0.0016;
          float o = uRShadowTexel;
          float s = 0.0;
          s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2(-o,-o))));
          s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2( o,-o))));
          s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2(-o, o))));
          s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2( o, o))));
          s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy)));
          float edge = 1.0 - smoothstep(0.42, 0.5, max(abs(sp.x-0.5), abs(sp.y-0.5)));
          sm *= mix(1.0, s * 0.2, edge);
        }
      }

      /* ---- daylight: Lambert sun + hemisphere fill ---- */
      float ndl = max(dot(Nr, uSunDir), 0.0);
      vec3 col = albedo * uSunCol * ndl * sm;

      // hemisphere ambient: sky above, bounce off the ground below
      vec3 amb = mix(uGroundCol, uSkyCol, 0.5 + 0.5*N.y);
      col += albedo * amb * uAmbient;

      // one spec lobe, only where the surface earns it (wet mud, polished
      // hardpack, glassy lava crust)
      if (rough < 0.95){
        vec3 H = normalize(uSunDir + V);
        float sh2 = mix(4.0, 90.0, 1.0 - rough);
        float sp2 = pow(max(dot(Nr, H), 0.0), sh2) * (1.0 - rough) * 0.42;
        col += uSunCol * sp2 * sm;
      }
      col += emis;

      /* ---- distance haze toward the theme horizon ---- */
      float fogAmt = 1.0 - exp(-max(0.0, dist - uHaze.y) * uHaze.x * uFogK);
      col = mix(col, uHazeCol, clamp(fogAmt, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }`;

  t.material = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vert, fragmentShader: frag, fog: false,
    defines: t.manualBilinear ? { MANUAL_BILINEAR: 1 } : {}
  });
}

/** One clipmap ring's material: the same programme, its own cell/sag/lod. */
export function makeLevelMaterial(t, cell, i) {
  // Built directly rather than cloned: ShaderMaterial.clone() deep-copies the
  // uniforms, which warns on every render-target texture in the set and then
  // has its work thrown away by the three assignments below.
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, t.uniforms),      // share the value objects
    vertexShader: t.material.vertexShader,
    fragmentShader: t.material.fragmentShader,
    defines: t.material.defines,
    fog: false
  });
  mat.uniforms.uCell = { value: cell };
  // Sag rises with cell size so a coarser ring always sits UNDER the finer
  // one it overlaps, hiding both the LOD step and any snapping mismatch.
  mat.uniforms.uSag = { value: i === 0 ? 0 : 0.10 * cell };
  mat.uniforms.uLod = {
    value: new THREE.Vector2(
      Math.max(0, Math.log2(cell / (MACRO_EXT / MACRO_RES))),
      Math.max(0, Math.log2(cell / (FAR_EXT / FAR_RES))))
  };
  return mat;
}

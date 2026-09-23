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
    sun: [0.645496, 0.615661, -0.451975], sunCol: [1.40, 1.20, 0.95],
    sky: [0.40, 0.53, 0.72], ground: [0.26, 0.24, 0.20], ambient: 0.44,
    haze: [0.66, 0.73, 0.83], hazeDensity: 0.00050, hazeStart: 90,
    tint: [1.00, 1.00, 1.00],
    albedoScale: 0.62,
    surf: { 0: [0.36, 0.33, 0.28], 2: [0.45, 0.38, 0.29],
      4: [0.37, 0.33, 0.28], 5: [0.30, 0.27, 0.20] }
  },
  canyon: {
    // Late afternoon, sun low across the wash. Clear warm air: you can see the
    // far mesas, which is the whole point of a desert.
    name: 'SUNSTRIKE CANYON',
    albedoScale: 0.68,
    sun: [0.74, 0.34, -0.58], sunCol: [1.45, 1.33, 1.16],
    sky: [0.46, 0.52, 0.70], ground: [0.38, 0.27, 0.18], ambient: 0.58,
    haze: [0.66, 0.68, 0.73], hazeDensity: 0.00042, hazeStart: 140,
    tint: [0.97, 0.99, 1.01],
    surf: { 4: [0.52, 0.27, 0.18], 1: [0.43, 0.27, 0.18], 2: [0.58, 0.40, 0.25] }
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
    albedoScale: 0.70,
    sun: [-0.30, 0.76, 0.58], sunCol: [1.14, 1.16, 1.12],
    sky: [0.52, 0.58, 0.64], ground: [0.19, 0.21, 0.16], ambient: 0.72,
    haze: [0.66, 0.71, 0.72], hazeDensity: 0.00125, hazeStart: 45,
    tint: [0.94, 0.98, 0.94],
    surf: {
      5: [0.17, 0.27, 0.13],    // GRASS — shaded forest floor
      3: [0.17, 0.13, 0.09],    // MUD
      1: [0.27, 0.21, 0.14],    // DIRT — forest loam, not desert hardpack
      4: [0.34, 0.35, 0.32],    // ROCK — damp grey granite, faintly green
    }
  },
  volcano: {
    // Low red sun through smoke. Everything not lit by it is lit by the ground.
    name: 'CALDERA RUN',
    albedoScale: 0.78,
    sun: [-0.62, 0.28, 0.73], sunCol: [1.50, 0.94, 0.62],
    // Ambient raised from 0.50 after QA: away-from-sun climbs read as a wall
    // of murk at 0.50, and this track needs its road legible at 130 km/h.
    sky: [0.42, 0.46, 0.55], ground: [0.18, 0.17, 0.18], ambient: 0.76,
    haze: [0.27, 0.28, 0.33], hazeDensity: 0.0004, hazeStart: 90,
    tint: [0.88, 0.96, 1.03],
    surf: { 4: [0.19, 0.20, 0.22], 1: [0.25, 0.23, 0.22], 2: [0.25,0.25,0.27] }
  },
  thunder: {
    // The canyon family an hour later. Sun nine degrees off the deck, so the
    // ground reads almost entirely by its own ambient — which is why the
    // hemisphere is violet and lifted rather than the usual desert blue.
    // sun MUST equal SKY_THEMES.thunder.sunDir: the occlusion mask is baked
    // against exactly this vector.
    name: 'THUNDER MESA',
    albedoScale: 0.68,
    sun: [-0.463692, 0.156434, -0.872076], sunCol: [1.56, 1.10, 0.76],
    sky: [0.30, 0.28, 0.46], ground: [0.40, 0.26, 0.18], ambient: 0.60,
    haze: [0.86, 0.55, 0.32], hazeDensity: 0.00042, hazeStart: 110,
    tint: [1.10, 0.94, 0.82],
    surf: { 4: [0.50, 0.28, 0.20], 1: [0.48, 0.33, 0.22] }
  }
};

/** Resolved 7x3 albedo table for a theme. */
export function themePalette(theme) {
  const T = THEMES[theme] || THEMES.training;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const o = T.surf[i] || SURF_BASE[i];
    // These are linear reflectances, not display RGB. Keep earth below the
    // bright shoulder of ACES so grain and the key/fill ratio remain visible.
    const k = T.albedoScale || 1;
    out.push([o[0] * T.tint[0] * k, o[1] * T.tint[1] * k, o[2] * T.tint[2] * k]);
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
  /* Whoever builds the Terrain may hand it `assets.get('ground')` on the way
     in; nothing here requires it, and the procedural grain below is the
     look the stages were tuned against. */
  const ground = t.ground || null;

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
    uContactShadow: { value: new THREE.Vector4(0,0,0,0) },
    uRShadowTexel: { value: 1 / 2048 },
    /* Optional photographic ground detail, a DataArrayTexture in
       GROUND_LAYERS order. Absent is the normal case — see core/assets.js and
       setGroundTexture() below. The sampler is behind a #define so a null
       binding never reaches a driver. */
    uGround: { value: ground },
    uQuarryGround: { value: null },
    uQuarryNormal: { value: null },
    uQuarryCliff: { value: null },
    uQuarryCliffNormal: { value: null },
    uGroundOn: { value: ground ? 1 : 0 }
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
    /* ESSL 3.00 defaults samplers to LOWP in both stages, and three only ever
       declares float and int precision for us. Two things break without this
       line. uLat is now declared in the vertex shader (highp, from
       TERRAIN_GLSL) and here, and a precision mismatch on a shared uniform is
       a LINK error, not a warning. And uRShadow carries depth packed across
       four 8-bit channels — unpackRGBAToDepth on a lowp fetch throws away
       most of the range, which on a driver that honours lowp is a shadow map
       with about six usable steps. */
    precision highp sampler2D;
    #include <packing>
    varying vec3 vW; varying vec3 vN; varying float vDent; varying float vRoad;
    uniform sampler2D uSunMask, uTrail, uSurf, uLat;
    uniform sampler2D uRShadow; uniform mat4 uRShadowMat;
    uniform float uRShadowOn, uRShadowTexel;
    uniform vec4 uContactShadow;
    uniform vec3 uSunDir, uSunCol, uSkyCol, uGroundCol, uHazeCol;
    uniform vec3 uSurfCol[7];
    uniform float uSunMaskExt, uTime, uFogK, uAmbient;
    uniform vec2 uHaze;
    uniform vec4 uConst2, uConst3;
    #ifdef GROUND
    precision highp sampler2DArray;
    uniform sampler2DArray uGround;
    uniform float uGroundOn;
    #endif
    #ifdef QUARRY_GROUND
    uniform sampler2D uQuarryGround;
    #endif
    #ifdef QUARRY_NORMAL
    uniform sampler2D uQuarryNormal;
    #endif
    #ifdef QUARRY_CLIFF
    uniform sampler2D uQuarryCliff,uQuarryCliffNormal;
    #endif

    float h1(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
    float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(h1(i),h1(i+vec2(1,0)),f.x), mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x), f.y); }
    const mat2 RA = mat2(0.8090,-0.5878,0.5878,0.8090);
    const mat2 RB = mat2(0.3090,0.9511,-0.9511,0.3090);
    float fb(vec2 p){ return n2(p)*0.55 + n2(RA*p*2.17+7.7)*0.30 + n2(RB*p*4.01+19.3)*0.15; }

    /* The same signed-lateral helper the vertex shader has, sampled per PIXEL
       here on purpose: a wheel track is about a metre and a half across and
       the clipmap's outer rings put their vertices four metres apart, so a
       varying would smear every lane into a wash. Reads 0 off the carved
       corridor — hence every use below is gated on vRoad. */
    float latF(vec2 p){
      return (texture2D(uLat, clamp(p / uConst3.x + 0.5, 0.0005, 0.9995)).r * 255.0 - 128.0) / 90.0;
    }

    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vW);
      float dist = distance(vW.xz, cameraPosition.xz);
      float near = 1.0 - smoothstep(26.0, 190.0, dist);
      /* Two tighter fades for the things that are only worth computing under
         the wheels. dnear must reach zero BEFORE the innermost FAR clipmap
         ring starts (87 m at the tightest tier), or the perf guard below
         would draw a visible ring on the ground where the effects stop. */
      float dnear = 1.0 - smoothstep(30.0, 82.0, dist);
      float gnear = 1.0 - smoothstep(24.0, 60.0, dist);

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
      #ifdef FAR
        float g0 = 0.5;                    // neutral: nothing this far out has grain
      #else
        float g0 = GRIT(vW.xz);
      #endif
      float varN = fb(vW.xz*0.31);
      float speck = n2(vW.xz*9.3);
      float gritK = 0.55;

      if (sid == 0) {
        // ROAD — hardpack. The wheel tracks come from latF() below, which
        // knows where the road EDGE is; all this branch does is the base.
        albedo *= 0.86 + 0.30*fb(vW.xz*0.22);
        rough = 0.91; gritK = 0.52;
      } else if (sid == 1) {
        albedo *= 0.84 + 0.34*varN + 0.16*g0;              // DIRT: clods
        albedo *= 0.92 + 0.20*speck;
        // pebbles: hard little highlights that only exist close enough to see
        albedo *= 1.0 + 0.38*near*smoothstep(0.66, 0.88, n2(vW.xz*7.3));
      } else if (sid == 2) {
        // SAND: bright, and rippled at a wavelength you can see from the car
        float rip = 0.5 + 0.5*sin(vW.x*1.7 + vW.z*0.9 + fb(vW.xz*0.12)*9.0);
        albedo *= 0.92 + 0.14*rip + 0.10*varN;
        albedo *= 1.0 + 0.26*near*smoothstep(0.72, 0.92, n2(vW.xz*11.0));
        gritK = 0.38;
      } else if (sid == 3) {
        /* MUD: dark, wet, and the only surface here with a real highlight.
           The wet PATCHES are the point — an evenly glossy field reads as
           plastic, and what sells mud is that the shine is in the ruts and
           the hollows and nowhere else. */
        albedo *= 0.80 + 0.34*varN;
        float wet = smoothstep(0.40, 0.74, fb(vW.xz*0.55));
        albedo = mix(albedo, albedo*0.54, wet);
        rough = mix(0.40, 0.09, wet);
        gritK = 0.30 * (1.0 - 0.7*wet);                    // standing water is flat
      } else if (sid == 4) {
        albedo *= 0.74 + 0.42*fb(vW.xz*0.55) + 0.18*g0;    // ROCK: mottled, hard
        rough = 0.72; gritK = 0.85;
      } else if (sid == 5) {
        // GRASS: green broken with brown, at two scales, or it reads as felt
        // 'patch' is reserved in ESSL 3.00 (tessellation) — hence the terse name.
        float pch = fb(vW.xz*0.28);
        albedo = mix(albedo, uSurfCol[5]*1.15, smoothstep(0.42,0.78,pch));
        albedo *= 0.82 + 0.36*n2(vW.xz*2.7);
        gritK = 0.70;
      } else if (sid == 6) {
        /* LAVA: black crust cracked over something moving. The pulse is slow
           and out of phase across the field, so a channel breathes rather
           than blinking. The crack WALLS are rim-lit: what you actually see
           of a lava channel from a car is the glow catching the lip of the
           crust at a grazing angle, not the floor of the crack. */
        float crack = fb(vW.xz*0.85 + vec2(0.0, uTime*0.035));
        float glow = smoothstep(0.54, 0.80, crack);
        glow*=glow; // cooled crust surrounds the molten channels
        float pulse = 0.58 + 0.52*sin(uTime*0.9 + vW.x*0.05 + vW.z*0.031)
                           + 0.16*sin(uTime*2.7 + vW.z*0.11);
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);
        albedo *= 0.50 + 0.30*crack;
        emis = vec3(2.5, 0.60, 0.08) * glow * pulse * (1.0 + 1.3*rim);
        emis += vec3(1.9, 0.36, 0.05) * rim * 0.40 * smoothstep(0.28, 0.60, crack);
        rough = 0.55; gritK = 0.45;
      }

      /* ---- macro colour variation ----
         Real ground is not one colour over a kilometre: iron staining, old
         watercourses, where the wind drops what it is carrying. A 55 m
         wavelength at plus or minus 12 % is enough to stop a stage reading
         as one flat swatch, and small enough never to be mistaken for a
         feature you could drive to. */
      #ifdef FOREST_GROUND
      if(sid==3) {
        // Damp loam with isolated wet hollows, not a uniformly polished road.
        float wetHollow=smoothstep(.63,.77,fb(vW.xz*.19));
        rough=mix(.82,.32,wetHollow);gritK*=.38;
      }
      if(sid==5) albedo=mix(albedo,vec3(.19,.20,.145),.40);
      #endif
      albedo *= 0.74 + 0.45*fb(vW.xz*0.018);

      /* ---- the road surface itself ----
         latF() is 0 on the crown and +-1 at the edge of the roadbed, so it
         is the only thing in the shader that knows which part of the road it
         is standing on. Two wheel tracks polished darker and smoother, a
         paler shoulder where the loose stuff gets swept, and a dusted verge
         beyond the edge. Everything is gated on vRoad, because latF reads 0
         off the corridor and 0 is the CROWN — an ungated lane term would
         paint a stripe across the whole map. */
      #ifndef FAR
      if (vRoad > 0.02 && sid != 6) {
        float onRoad = smoothstep(0.02, 0.30, vRoad) * dnear;
        float al = abs(latF(vW.xz) + (fb(vW.xz*.065)-.5)*.16);
        float lane = smoothstep(0.24, 0.32, al) * (1.0 - smoothstep(0.48, 0.58, al));
        float shoulder = smoothstep(0.70, 0.98, al) * (1.0 - smoothstep(1.02, 1.22, al));
        float verge = smoothstep(1.00, 1.28, al);
        // wear is uneven along the lane: nobody drives exactly the same line
        lane *= 0.55 + 0.45*n2(vW.xz*0.55);
        albedo *= mix(1.0, 0.65, lane*onRoad);
        albedo *= 1.0 + 0.19*shoulder*onRoad;
        albedo = mix(albedo, uSurfCol[1]*1.15, verge*onRoad*0.55);
        rough = mix(rough, rough*0.66, lane*onRoad);
        #ifdef QUARRY_GROUND
        // Several worn wheel paths follow the course instead of a world-axis
        // texture. Broken edges prevent evenly painted racing stripes.
        float paths=pow(.5+.5*cos(al*49.0+fb(vW.xz*.033)*1.4),10.0);
        paths*=smoothstep(.04,.16,al)*(1.-smoothstep(.82,1.,al));
        paths*=.5+.5*fb(vW.xz*.17);
        albedo*=1.-paths*onRoad*.33;
        rough=mix(rough,.83,paths*onRoad);
        #endif
      }
      #endif

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
      float steep = 1.0 - smoothstep(0.62, 0.86, N.y);
      float rockCoverage = steep;
      #ifdef VOLCANIC_GROUND
      rockCoverage=max(steep,(1.-smoothstep(.72,.95,N.y))*(1.-smoothstep(.02,.2,vRoad)));
      if(sid!=6) {
        float ash=fb(vW.xz*.045);
        albedo=mix(albedo,vec3(.145,.155,.18),.48*(1.-vRoad));
        albedo*=.8+.35*ash;
      }
      #endif
      #ifdef FOREST_GROUND
      rockCoverage=max(rockCoverage,(1.-smoothstep(.70,.94,N.y))*(1.-smoothstep(.02,.20,vRoad)));
      albedo=mix(albedo,vec3(.29,.31,.29),rockCoverage*.72);
      #endif
      #ifdef QUARRY_PROFILE
      // Quarry benches are exposed bedrock too. Restricting the scan to
      // vertical normals left every upper ledge as a smooth sandy cap.
      rockCoverage=max(steep,smoothstep(200.,235.,length(vW.xz)));
      rockCoverage=max(rockCoverage,(1.-smoothstep(.88,.98,N.y))*(1.-smoothstep(0.,.05,vRoad)));
      #endif
      if (sid != 6) {                              // lava keeps its glow
        vec3 scree = uSurfCol[4] * (0.62 + 0.30*fb(vW.xz*0.5) + 0.14*g0);
        // Exposed cuts reveal strata and vertical water staining. This is
        // material relief only; collision heights remain the shared bake.
        float strata = fb(vec2(vW.y*0.72 + fb(vW.xz*0.07)*2.8, vW.x*0.013+vW.z*0.009));
        float streak = fb(vW.xz*0.35 + vec2(vW.y*0.035));
        scree *= 0.73 + 0.20*strata + 0.24*streak;
        albedo = mix(albedo, scree, rockCoverage * 0.85);
        rough = mix(rough, 0.8, steep);
      }

      /* ---- optional photographic ground detail ----
         A DataArrayTexture in GROUND_LAYERS order, picked by surface id and
         gone by 60 m. It MODULATES, never replaces: the theme palette is
         what makes a stage that stage, and a photo dropped straight on top
         would make all five look like the same quarry. Everything below runs
         identically with no assets at all — that is the contract. */
      float photoRelief = 0.0;
      #ifdef GROUND
      #ifdef CANYON_STRATA
      float cliffFade = (1.0-smoothstep(380.0,1450.0,dist))*rockCoverage;
      #else
      float cliffFade = (1.0-smoothstep(180.0,650.0,dist))*rockCoverage;
      #endif
      if ((gnear > 0.004 || cliffFade > 0.004) && sid != 6) {
        float lay = sid == 0 ? 5.0 : sid == 1 ? 0.0 : sid == 2 ? 1.0
                  : sid == 3 ? 3.0 : sid == 4 ? 2.0 : 4.0;
        /* 0.2158 is 50 % sRGB grey in linear: dividing by it keeps a
           normally exposed tile centred on 1.0, so a missing layer changes
           nothing. core/assets.js re-exposes every layer to exactly that on
           the way in, which is the only reason the constant can be trusted.

           Clamped anyway. This term MULTIPLIES the palette, so a tile that
           arrives brighter than it should is not a slightly-too-pale ground:
           it is ground with an albedo over 1, which out-runs the tone curve,
           crosses the bloom threshold and veils the whole frame from the
           middle out. That is exactly what a mis-composited set of tiles did
           here once. Two stops of headroom either side is all a photograph
           needs, and the ground can never again be a light source. */
        // Project cliffs on their vertical axes instead of stretching XZ tiles.
        // Flat roads use rotated layers; steep surfaces add triplanar cliff sampling.
        // Two rotated scales break recognisable repetitions. No UV fract:
        // implicit derivatives must stay continuous for the mip chain.
        vec2 guv = vW.xz * 0.34;
        vec3 sampleGround = mix(texture(uGround, vec3(guv, lay)).rgb,
          texture(uGround, vec3(RA * guv * 0.73 + 0.37, lay)).rgb, 0.38);
        // Packed quarry fines under loose, coarser stones. This also breaks
        // the uniform sandpaper appearance of a single aggregate scale.
        if(sid==0) sampleGround=mix(sampleGround,texture(uGround,vec3(guv*.8,1.0)).rgb,.55);
        #ifdef QUARRY_GROUND
        if(sid!=6) {
          // Keep the scanned-size aggregate crisp instead of resampling it
          // through the generic 512-pixel layer array. Break repeats with a
          // slow second scale while retaining the primary pebbles' edges.
          vec2 qUV=vW.xz*((sid==0||sid==1)? .38 : .22);
          vec3 fine=texture2D(uQuarryGround,qUV).rgb;
          fine=mix(fine,texture2D(uQuarryGround,RA*qUV*.51+.31).rgb,.18);
          #ifdef FOREST_GROUND
          sampleGround=mix(sampleGround,fine,.90*(1.-smoothstep(.05,.8,vRoad)*.8));
          #else
          sampleGround=mix(sampleGround,fine,.90);
          #endif
        }
        #endif
        if (rockCoverage > 0.02) {
          vec3 blend = pow(abs(N), vec3(4.0));
          blend /= max(dot(blend, vec3(1.0)), 0.001);
          vec3 rockY = texture(uGround, vec3(vW.xz * 0.14, 2.0)).rgb;
          vec3 rockX = texture(uGround, vec3(vW.zy * 0.14, 2.0)).rgb;
          vec3 rockZ = texture(uGround, vec3(vW.xy * 0.14, 2.0)).rgb;
          #ifdef QUARRY_CLIFF
          rockX=texture2D(uQuarryCliff,vW.zy*.065).rgb;
          rockY=texture2D(uQuarryCliff,vW.xz*.065).rgb;
          rockZ=texture2D(uQuarryCliff,vW.xy*.065).rgb;
          #endif
          sampleGround = mix(sampleGround, rockX*blend.x + rockY*blend.y + rockZ*blend.z, rockCoverage);
        }
        vec3 gt = clamp(sampleGround * (1.0 / 0.2158), 0.35, 1.70);
        float detailFade=max(gnear,cliffFade);
        albedo *= mix(vec3(1.0), gt, detailFade * uGroundOn * 0.95);
        photoRelief = dot(sampleGround,vec3(0.2126,0.7152,0.0722)) * mix(0.045,0.45,steep) * detailFade * uGroundOn;
      }
      #endif

      #ifdef CANYON_STRATA
      // Broad mineral variation breaks up uniformly orange terrain without
      // relying on tiny texture noise that disappears in the middle distance.
      float mineralPatch=fb(vW.xz*.026);
      albedo*=mix(vec3(.78,.82,.84),vec3(1.12,1.07,.99),mineralPatch);
      // Geological bedding remains legible past the texture detail cutoff.
      float cliffMask=smoothstep(.12,.62,1.0-N.y)*(1.0-vRoad);
      float bedHeight=vW.y+fb(vW.xz*.018)*1.8;
      float beds=sin(bedHeight*.85)+.28*sin(bedHeight*3.1);
      albedo*=1.0-cliffMask*(.12+.14*smoothstep(.3,1.1,beds));
      albedo=mix(albedo,albedo*vec3(.89,.95,1.06),cliffMask*.65);
      #endif
      vec3 Nr = N;
      #ifndef FAR
      if (dnear > 0.002 && gritK > 0.01){
        float e = 0.05;
        float gx = GRIT(vW.xz + vec2(e, 0.0));
        float gz = GRIT(vW.xz + vec2(0.0, e));
        Nr = normalize(N + vec3(-(gx-g0), 0.0, -(gz-g0)) * gritK * dnear);
      }
      #endif

      // Surface-gradient bump from the actual aggregate: the lighting follows
      // the texture's stones, instead of unrelated procedural speckles.
      #ifdef GROUND
      vec3 dpdx = dFdx(vW), dpdy = dFdy(vW);
      vec3 rx = cross(dpdy,Nr), ry = cross(Nr,dpdx);
      float det = dot(dpdx,rx);
      if(abs(det)>1e-7) Nr = normalize(abs(det)*Nr - sign(det)*
        (dFdx(photoRelief)*rx + dFdy(photoRelief)*ry));
      #endif

      // Scanned OpenGL normals add aggregate relief on the quarry floor.
      #ifdef QUARRY_NORMAL
      if(sid!=6 && dnear>.002) {
        vec3 detail=texture2D(uQuarryNormal,vW.xz*((sid==0||sid==1)? .38 : .22)).xyz*2.0-1.0;
        vec3 tangent=normalize(vec3(N.y,-N.x,0.0));
        vec3 bitangent=normalize(cross(tangent,N));
        vec3 scanned=normalize(tangent*detail.x+bitangent*detail.y+N*max(detail.z,.25));
        Nr=normalize(mix(Nr,scanned,dnear*.72));
      }
      #endif
      // Triplanar scanned normals follow the exposed cliff faces.
      #ifdef QUARRY_CLIFF
      if(rockCoverage>.02 && dist<650.) {
        vec3 w=pow(abs(N),vec3(4.));w/=max(dot(w,vec3(1.)),.001);
        vec3 nx=texture2D(uQuarryCliffNormal,vW.zy*.065).xyz*2.-1.;
        vec3 ny=texture2D(uQuarryCliffNormal,vW.xz*.065).xyz*2.-1.;
        vec3 nz=texture2D(uQuarryCliffNormal,vW.xy*.065).xyz*2.-1.;
        vec3 faceNormal=normalize(vec3(nx.z*sign(N.x),nx.y,nx.x)*w.x
          +vec3(ny.x,ny.z*sign(N.y),ny.y)*w.y
          +vec3(nz.x,nz.y,nz.z*sign(N.z))*w.z);
        Nr=normalize(mix(Nr,faceNormal,rockCoverage*.85*(1.-smoothstep(250.,650.,dist))));
      }
      #endif
      /* ---- freshly churned ground is DARKER and wetter, not brighter ----
         (the instinct to brighten a fresh cut is wrong for dirt: what a
         wheel turns up is damp subsoil.) */
      float churn = smoothstep(0.02, 0.35, abs(vDent));
      albedo *= 1.0 - 0.30 * churn;
      rough = mix(rough, rough*0.72, churn);

      #ifdef VOLCANIC_GROUND
      if(sid!=6) albedo*=mix(.52+.23*fb(vW.xz*.08),1.,smoothstep(.03,.7,vRoad));
      #endif

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
      // Low-tier grounding without another shadow-map pass. Height fades the
      // soft contact patch away during jumps; full shadow tiers leave w zero.
      vec2 contactDelta=(vW.xz-uContactShadow.xz)/1.55;
      col *= 1.0-uContactShadow.w*exp(-dot(contactDelta,contactDelta)*1.4);

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

  const defines = {};
  if (t.manualBilinear) defines.MANUAL_BILINEAR = 1;
  if (ground) defines.GROUND = 1;
  t.material = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vert, fragmentShader: frag, fog: false, defines
  });
}

/**
 * Swap the optional ground-detail array in after the fact — the assets load
 * asynchronously and a stage is usually already on screen by the time they
 * arrive. Pass null to go back to the procedural grain.
 *
 * Far rings retain cliff textures: a vertical quarry wall fills many pixels
 * at 200 m even though horizontal gravel has already faded away.
 */
export function setGroundTexture(t, tex, quarry = null, normal = null, cliff = null, cliffNormal = null) {
  if (!t || !t.material) return;
  t.ground = tex || null;
  const u = t.uniforms;
  u.uGround.value = t.ground;
  u.uGroundOn.value = t.ground ? 1 : 0;

  const want = !!t.ground;
  const D = t.material.defines;
  if(t.theme==='training') D.QUARRY_PROFILE=1;
  if(t.theme==='forest') D.FOREST_GROUND=1;
  if(t.theme==='volcano') D.VOLCANIC_GROUND=1;
  if(t.theme==='canyon') D.CANYON_STRATA=1;
  const cliffOn=!!(cliff&&cliffNormal);
  const quarryChanged=!!D.QUARRY_GROUND!==!!quarry || !!D.QUARRY_NORMAL!==!!normal || !!D.QUARRY_CLIFF!==cliffOn;
  u.uQuarryGround.value=quarry;
  u.uQuarryNormal.value=normal;
  u.uQuarryCliff.value=cliff;u.uQuarryCliffNormal.value=cliffNormal;
  if(cliffOn) D.QUARRY_CLIFF=1; else delete D.QUARRY_CLIFF;
  if(quarry) D.QUARRY_GROUND=1; else delete D.QUARRY_GROUND;
  if(normal) D.QUARRY_NORMAL=1; else delete D.QUARRY_NORMAL;
  if (!!D.GROUND === want && !quarryChanged) return;
  if (want) D.GROUND = 1; else delete D.GROUND;
  /* The near rings SHARE this defines object — makeLevelMaterial passes the
     reference straight through — so flipping the flag above has already
     changed theirs. What they still need, every one of them, is to be told
     to relink; testing their defines here would find the flag already set
     and skip them all. */
  t.material.needsUpdate = true;
  for (const L of t.levels || []) {
    const m = L.mesh.material;
    if (m && m.defines) {
      if(want) m.defines.GROUND=1; else delete m.defines.GROUND;
      if(quarry) m.defines.QUARRY_GROUND=1; else delete m.defines.QUARRY_GROUND;
      if(normal) m.defines.QUARRY_NORMAL=1; else delete m.defines.QUARRY_NORMAL;
      if(cliffOn) m.defines.QUARRY_CLIFF=1; else delete m.defines.QUARRY_CLIFF;
      if(t.theme==='training') m.defines.QUARRY_PROFILE=1;
      if(t.theme==='forest') m.defines.FOREST_GROUND=1;
      if(t.theme==='volcano') m.defines.VOLCANIC_GROUND=1;
      if(t.theme==='canyon') m.defines.CANYON_STRATA=1;
      m.needsUpdate = true;
    }
  }
}

/** One clipmap ring's material: the same programme, its own cell/sag/lod. */
export function makeLevelMaterial(t, cell, i) {
  /* PERF GUARD. Ring 4 begins about 87 m from the camera and the outermost
     reaches the horizon, and between them they are most of the pixels in a
     frame — every one of them at a grazing angle where the ground is four
     pixels tall and nobody can tell what it is made of. The near-field
     detail (grit albedo, the grit normal, the road lanes, the photographic
     ground layer on flat ground) is switched off there by define:
     it is not a saved instruction, it is a shorter programme. Everything it
     drops has already faded to zero by 82 m, so there is no seam. Steep
     cliff faces retain their triplanar material into the middle distance. */
  const far = i >= 4;
  const defines = far ? Object.assign({ FAR: 1 }, t.material.defines) : t.material.defines;
  // Built directly rather than cloned: ShaderMaterial.clone() deep-copies the
  // uniforms, which warns on every render-target texture in the set and then
  // has its work thrown away by the three assignments below.
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, t.uniforms),      // share the value objects
    vertexShader: t.material.vertexShader,
    fragmentShader: t.material.fragmentShader,
    defines,
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

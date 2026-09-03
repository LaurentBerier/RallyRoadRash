/* ============================================================
   RENDER ENGINE
   ------------------------------------------------------------
   WebGL2, linear HDR pipeline, MSAA-backed composer, bloom, and a
   final pass that treats the image as what it is in fiction: a
   camera bolted to the car, with sensor noise that rises in shadow.
   ============================================================ */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/* `pixels` is a hard ceiling on the framebuffer, and it is the single most
   important number here. A Retina MacBook reports devicePixelRatio 2, so a
   naive `setPixelRatio(dpr)` on a 1710-point-wide window renders 3420x2136 —
   7.3 megapixels through a terrain shader that ray-marches and triplanar
   samples. That is what makes it crawl, not the geometry. Capping total pixels
   rather than the ratio keeps the same budget on every display. */
export const QUALITY = {
  low: {
    name: 'LOW', maxDpr: 1.5, pixels: 0.85e6, clipM: 88, clipLevels: 7, clipCell: 0.28,
    stars: 2500, boulders: 520, trailRes: 1024, sunRes: 512, sunSteps: 36, dentRes: 2048,
    shadow: 0, bloom: false, msaa: 0, dust: 500
  },
  medium: {
    name: 'MEDIUM', maxDpr: 1.75, pixels: 1.6e6, clipM: 128, clipLevels: 8, clipCell: 0.20,
    stars: 6000, boulders: 1250, trailRes: 2048, sunRes: 768, sunSteps: 52, dentRes: 2048,
    shadow: 1024, bloom: true, msaa: 0, dust: 1200
  },
  /* clipM came down from 160/192. The ring count and the cell size set the
     DETAIL; the ring WIDTH sets how much of each ring is drawn edge-on at a
     grazing angle, where a triangle covers a fraction of a pixel and costs
     the same as one that covers a hundred. HIGH was drawing ~500 k triangles
     against a 450 k budget and the last 16 cells of every ring were the part
     nobody could see. */
  high: {
    name: 'HIGH', maxDpr: 2, pixels: 2.4e6, clipM: 144, clipLevels: 9, clipCell: 0.16,
    stars: 11000, boulders: 2000, trailRes: 4096, sunRes: 1024, sunSteps: 76, dentRes: 4096,
    shadow: 2048, bloom: true, msaa: 4, dust: 2200
  },
  ultra: {
    name: 'ULTRA', maxDpr: 2, pixels: 4.2e6, clipM: 176, clipLevels: 9, clipCell: 0.13,
    stars: 16000, boulders: 2900, trailRes: 4096, sunRes: 1536, sunSteps: 96, dentRes: 4096,
    shadow: 4096, bloom: true, msaa: 4, dust: 3200
  }
};

/* ACES fitted + the onboard-camera conceit */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    // daylight defaults: these are tuned for a sunlit rally stage, so the grain
    // and the aberration sit low and exposure is neutral. Push them up only for
    // a deliberately degraded look — the shader still supports it.
    uExposure: { value: 1.0 },
    /* Per-STAGE grade, distinct from uExposure on purpose. uExposure is
       feel.js's: it sits at exactly 1.0 and dips for a few frames on a hard
       landing, and dev/camera-check gates that it returns to 1.0 to the last
       decimal. A stage that simply wants to be a stop darker has nowhere to
       say so without breaking that contract, so it says it here instead —
       set once per race from SKY_THEMES.grade and never animated. */
    uGrade: { value: new THREE.Vector3(1, 1, 1) },
    /* Screen blind, 0..1, owned by game/itemworld.js (the dust storm).
       Deliberately NOT one of uVignette/uExposure/uFlash: feel.js owns those
       three exclusively and dev/camera-check asserts their exact reset
       values, so anything else that wants the screen needs somewhere of its
       own. Same reasoning that gave the per-stage grade its own uniform. */
    uBlind: { value: 0 },
    uVignette: { value: 0.85 },
    uGrain: { value: 0.35 },
    uAberr: { value: 0.5 },
    /* Sensor tear on a hit. Owned by whoever routes damage — one impulse,
       decayed to zero by the caller; nothing here animates it. */
    uGlitch: { value: 0.0 },
    uFlash: { value: 0.0 },
    uLetterbox: { value: 0.0 },
    /* Per-STAGE look, all three set once from SKY_THEMES by setLightTheme and
       never animated — the same reasoning that gave uGrade its own uniform. */
    uShaft: { value: 0.0 },      // god-ray strength toward uSunUV
    uSat: { value: 1.0 },
    uCon: { value: 1.0 },
    /* Radial speed smear, 0..1, written per frame by the race loop off road
       speed. Zero is the default so a stage with nobody driving is clean. */
    uSpeedBlur: { value: 0.0 },
    /* NITRO, 0..1 (§8.4). ONE writer: game/feel.js, via feel.nitro(k01), and
       feel.reset() zeroes it. It rides INSIDE this pass rather than adding
       another one — a second full-screen pass for four terms nobody sees for
       more than two seconds at a time is not a trade worth making.

       At uNitro === 0 this pass is bit-identical to what it was before nitro
       existed, and that is guaranteed BY CONSTRUCTION, not by testing: every
       nitro term is multiplied by the uniform and then added or subtracted,
       so at zero every one of them is exactly +0.0 and `x + 0.0 == x` for
       every finite x the pass can produce. Read the four sites below with
       that in mind — if you ever add a fifth, it has to hold there too. */
    uNitro: { value: 0.0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSunUV: { value: new THREE.Vector3(0.5, 0.5, 0) }   // xy = screen pos, z = visibility
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uExposure, uVignette, uGrain, uAberr, uGlitch, uFlash, uLetterbox;
    uniform vec3 uGrade;
    uniform float uBlind, uShaft, uSat, uCon, uSpeedBlur, uNitro;
    uniform vec2 uRes; uniform vec3 uSunUV;

    vec3 aces(vec3 x){
      const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
      return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
    }
    // Integer hash. The usual fract(sin(dot(...))) trick correlates hard on an
    // integer lattice like gl_FragCoord and lays a visible diagonal weave over
    // the whole frame — this one is actually white.
    float hash(vec2 p){
      uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
      uint n = (q.x ^ q.y) * 1597334673u;
      n = (n ^ (n >> 15u)) * 2246822519u;
      n = (n ^ (n >> 13u)) * 3266489917u;
      return float(n ^ (n >> 16u)) * (1.0 / 4294967295.0);
    }

    void main(){
      vec2 uv = vUv;
      float aspect = uRes.x / uRes.y;

      /* sensor tear when the chassis takes a hit */
      if (uGlitch > 0.001){
        float band = step(0.985 - uGlitch*0.25, hash(vec2(floor(uv.y*140.0), floor(uTime*22.0))));
        uv.x += band * (hash(vec2(floor(uv.y*140.0), 7.0))-0.5) * 0.055 * uGlitch;
      }

      /* NITRO 1/4 — the zoom warp. 1.5 % toward the centre, which is the
         cheapest way to say "the whole world just got closer": everything
         grows a little and the edges leave the frame. Applied to uv BEFORE d
         is taken, so the pinch, the smear and the vignette all agree about
         where the middle is. Adding (0.5 - uv) * 0.0 leaves uv exactly. */
      uv += (vec2(0.5) - uv) * (uNitro * 0.015);

      /* lateral chromatic aberration, zero at centre */
      vec2 d = uv - 0.5;
      float r2 = dot(d,d);
      /* NITRO 2/4 — the chromatic push. The same lateral split, harder and
         with a steeper r^2 term so it is invisible on the road ahead and
         obvious at the edges. */
      float k = uAberr * (0.0004 + 0.0026*r2) + uNitro * (0.0012 + 0.0090*r2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + d*k).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - d*k).b;

      /* speed smear: a radial blur toward the CENTRE of the frame, weighted
         by r^2 so the middle of the screen — where the road and the car you
         are chasing live — stays sharp and only the periphery streaks. That
         is the whole trick: an even blur reads as a dirty lens, a radial one
         reads as velocity. */
      /* NITRO 3/4 — the radial blur. Nitro rides the speed smear at 2.2x the
         weight and lifts its ceiling with it, because the point of nitro is
         that it is faster than fast and a term that clamps at the same 0.22
         would read as "already flat out". Same six taps: the cost is the
         branch it was already taking at speed. */
      float amt = clamp((uSpeedBlur + uNitro * 2.2) * r2 * 2.2, 0.0, 0.22 + uNitro * 0.16);
      if (amt > 0.002){
        vec3 acc = col;
        for (int i = 1; i <= 6; i++){
          acc += texture2D(tDiffuse, mix(uv, vec2(0.5), float(i) * (1.0/6.0) * amt)).rgb;
        }
        col = acc * (1.0 / 7.0);
      }

      /* NITRO 4/4 — the blue-white push. Cold, because the flame is: a
         hydrocarbon burning rich enough to matter goes blue, and the whole
         frame reading a stop cooler is what separates nitro from the warm
         mini-turbo. Weighted by r^2 like everything else here, and added
         BEFORE the grade so a sunset stage still owns its own colour. */
      col += vec3(0.42, 0.68, 1.0) * (uNitro * (0.05 + 0.30 * r2));

      /* anamorphic-ish veiling glare toward the sun — the one thing a vacuum
         cannot give you, but a scratched lens can */
      if (uSunUV.z > 0.001){
        vec2 sp = uSunUV.xy - uv;
        sp.x *= aspect;
        float dd = length(sp);
        float streak = exp(-abs(sp.y)*46.0) * exp(-abs(sp.x)*2.2);
        float halo = exp(-dd*7.0)*0.30 + exp(-dd*1.7)*0.06;
        col += vec3(1.0,0.93,0.80) * (streak*0.16 + halo) * uSunUV.z;
        // a couple of ghosts along the optical axis
        vec2 g1 = mix(uv, uSunUV.xy, 1.62); vec2 g2 = mix(uv, uSunUV.xy, 2.35);
        col += vec3(0.35,0.55,0.75) * exp(-length((g1-uSunUV.xy)*vec2(aspect,1.0))*16.0) * 0.13 * uSunUV.z;
        col += vec3(0.75,0.42,0.25) * exp(-length((g2-uSunUV.xy)*vec2(aspect,1.0))*22.0) * 0.10 * uSunUV.z;
      }

      /* Sun shafts. Twelve taps marching from this pixel TOWARD the sun,
         each one keeping only what it finds above a luminance threshold —
         so the rays are cast by the things that are actually bright (the
         disc, a ridge line lit from behind, a dust cloud) and the ground
         under the car contributes nothing. Weight decays along the march,
         which is what makes a ray taper instead of ending in a hard stripe.

         This is the cheapest of the three big skies-and-light wins and the
         one that reads instantly on a low sun, so it is per-theme: a noon
         airfield gets none, a caldera dusk gets a lot. */
      if (uShaft > 0.001 && uSunUV.z > 0.001){
        vec2 sd = (uSunUV.xy - uv) * (1.0/12.0) * 0.70;
        vec2 sp2 = uv;
        vec3 acc = vec3(0.0);
        float w = 1.0, wsum = 0.0;
        for (int i = 0; i < 12; i++){
          sp2 += sd;
          // clamped: with the sun just off frame the march runs past the edge,
          // and an unclamped tap smears the edge COLUMN across the shafts
          vec3 s = texture2D(tDiffuse, clamp(sp2, 0.0, 1.0)).rgb;
          acc += s * max(dot(s, vec3(0.299,0.587,0.114)) - 0.62, 0.0) * w;
          wsum += w;
          w *= 0.90;
        }
        // fade with angular distance so the shafts belong to the sun and do
        // not tint the opposite corner of the frame
        vec2 sv = (uSunUV.xy - uv) * vec2(aspect, 1.0);
        col += acc / max(wsum, 1e-4) * uShaft * uSunUV.z * exp(-length(sv) * 1.35);
      }

      /* The dust storm: warm grit over the lens and the contrast crushed
         out of it. Before the grade, so a stage's own key still applies. */
      if (uBlind > 0.001){
        col = mix(col, vec3(0.62, 0.50, 0.34), uBlind * 0.72);
        col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uBlind * 0.45);
      }

      /* Saturation and contrast, in LINEAR and before the grade: ACES pulls
         several stops of saturation out of anything bright, so an arcade
         stage that wants punchy colour has to ask for it on the way in. The
         contrast pivot is 0.18 — mid grey — so pushing contrast darkens the
         shadows and lifts the highlights around the same point the grade and
         the tone curve were tuned against. */
      float lm = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lm), col, uSat);
      col = max((col - 0.18) * uCon + 0.18, 0.0);
      col *= uGrade;
      col *= uExposure;
      col += uFlash;

      /* tone map in linear, then encode */
      col = aces(col);

      /* vignette + a faint barrel darkening at the corners. Nitro pinches it:
         deeper AND starting further in, so the frame closes down around the
         road. Both edges move by a term multiplied by uNitro, so at zero the
         smoothstep arguments are still exactly 0.28 and 0.92. */
      float vig = 1.0 - (uVignette + uNitro * 0.55)
        * smoothstep(0.28 - uNitro * 0.16, 0.92 - uNitro * 0.22, r2*1.65);
      col *= vig;

      /* sensor noise: rises where the signal is low, exactly like a real CMOS */
      float lum = dot(col, vec3(0.299,0.587,0.114));
      float n = hash(gl_FragCoord.xy + vec2(floor(uTime*61.0), floor(uTime*37.0))) - 0.5;
      col += n * uGrain * (0.012 + 0.034*(1.0 - smoothstep(0.0, 0.26, lum)));

      /* photo-mode letterbox */
      float lb = step(uv.y, uLetterbox*0.5) + step(1.0-uLetterbox*0.5, uv.y);
      col *= 1.0 - lb;

      col = pow(max(col, 0.0), vec3(1.0/2.2));
      gl_FragColor = vec4(col, 1.0);
    }`
};

export class Engine {
  constructor(canvas, qualityKey = 'high') {
    this.canvas = canvas;
    this.quality = QUALITY[qualityKey] || QUALITY.high;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false,
      powerPreference: 'high-performance', depth: true
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;      // the final pass owns tone mapping
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = true;

    this.renderScale = 1;      // governor multiplier on top of the pixel budget
    this.adaptive = true;
    this.caps = {
      floatLinear: this.renderer.extensions.has('OES_texture_float_linear'),
      maxTex: this.renderer.capabilities.maxTextureSize,
      aniso: this.renderer.capabilities.getMaxAnisotropy()
    };
    if (!this.caps.floatLinear) {
      console.warn('[RALLY ROAD RASH] OES_texture_float_linear unavailable — terrain sampling will be blocky.');
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.08, 26000);
    this.camera.position.set(0, 3, -8);

    /* ---- sun: one parallel key light, warm daylight by default ----
       Defaults are the training theme; world/sky.js pushes the real per-theme
       values through setLightTheme() when a race is built. The shadow box is
       sized for cars, not for a landscape: d=30 covers the player plus the two
       or three rivals close enough to matter, and anything further away is
       already inside the terrain's own baked sun mask. */
    this.sun = new THREE.DirectionalLight(0xfff3e2, 2.6);
    this._configureShadow();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // sky/ground fill: blue from above, bounce from the dirt below
    this.fill = new THREE.HemisphereLight(0xa8c8ff, 0x7a6a52, 0.60);
    this.scene.add(this.fill);

    this.buildComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /* Shadow frustum + filtering. Called from the constructor and again on every
     tier change: booting on LOW (shadow 0) and then raising quality used to
     leave the camera at three.js's default +-5 m box, which puts the shadow
     under the car and nowhere else. */
  _configureShadow() {
    this.sun.castShadow = this.quality.shadow > 0;
    if (!this.sun.castShadow) return;
    const S = this.quality.shadow;
    this.sun.shadow.mapSize.set(S, S);
    const d = 30;
    this.sun.shadow.camera.left = -d; this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d; this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 180;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0007;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 1.5;
  }

  buildComposer() {
    const q = this.quality;
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x), h = Math.max(2, size.y);
    // MSAA on a phone GPU costs more than it returns; the budget is better
    // spent on resolution.
    const samples = q.msaa && w * h <= 3.2e6 ? q.msaa : 0;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace
    });
    // EffectComposer.dispose() frees its own two targets and nothing else.
    // UnrealBloomPass carries a mip chain of eleven more, so rebuilding the
    // composer without walking the passes leaks eleven render targets every
    // time the quality tier changes — which used to be rare enough not to show.
    if (this.composer) {
      for (const p of this.composer.passes) p.dispose?.();
      this.composer.dispose();
    }
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    /* Threshold sits above sunlit white bodywork on purpose: any lower and
       bright panels bloom and veil the entire frame. In three's physical
       lighting a 0.9 albedo panel under the brightest key here resolves to
       about 1.0 — so 1.30 keeps every painted surface out and lets only the
       things that are genuinely emissive through: lamps, lava, embers, the
       sun disc, boost flames. Raised from 1.15 (which caught white liveries),
       and the strength went up / the radius down to match: a tighter, hotter
       bloom reads as arcade, a wide soft one reads as fog. */
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.62, 1.30);
    this.bloom.enabled = q.bloom;
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.final.renderToScreen = true;
    this.composer.addPass(this.final);
    this._applyLook();          // a rebuild must not lose the stage's look
  }

  setQuality(key) {
    this.quality = QUALITY[key] || QUALITY.high;
    this.renderer.shadowMap.enabled = this.quality.shadow > 0;
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this._configureShadow();
    this.resize();
    this.buildComposer();
    this.resize();
  }

  /** Device pixel ratio, clamped so the framebuffer never exceeds the budget. */
  _pixelRatio() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    let px = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    const over = (w * h * px * px) / this.quality.pixels;
    if (over > 1) px /= Math.sqrt(over);
    return Math.max(0.5, px * this.renderScale);
  }

  /** Rolling frame-time governor. Trades resolution for a steady frame rate
      before the player ever notices, and gives it back when there is headroom. */
  governor(dt) {
    if (!this.adaptive) return;
    this._ft = this._ft === undefined ? dt : this._ft * 0.92 + dt * 0.08;
    this._govT = (this._govT || 0) + dt;
    if (this._govT < 1.1) return;
    this._govT = 0;
    const ms = this._ft * 1000;
    const before = this.renderScale;
    if (ms > 23 && this.renderScale > 0.62) this.renderScale = Math.max(0.62, this.renderScale - 0.08);
    else if (ms < 13.5 && this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.06);
    if (Math.abs(this.renderScale - before) > 0.005) this.resize();
  }

  resize() {
    const px = this._pixelRatio();
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(px);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bw = Math.max(2, Math.floor(w * px)), bh = Math.max(2, Math.floor(h * px));
    if (this.composer) {
      this.composer.setSize(w, h);
      this.final.uniforms.uRes.value.set(bw, bh);
      if (this.bloom) this.bloom.setSize(bw, bh);
    }
  }

  /** Per-race lighting, from world/sky.js SKY_THEMES. Call once when the track
      is built (and again if the theme changes); every field is optional. */
  setLightTheme(t) {
    if (!t) return;
    if (t.sunColor !== undefined) this.sun.color.set(t.sunColor);
    if (t.sunIntensity !== undefined) this.sun.intensity = t.sunIntensity;
    if (t.hemiSky !== undefined) this.fill.color.set(t.hemiSky);
    if (t.hemiGround !== undefined) this.fill.groundColor.set(t.hemiGround);
    if (t.hemiIntensity !== undefined) this.fill.intensity = t.hemiIntensity;
    /* Optional per-stage grade. Absent means neutral, so a theme that says
       nothing looks exactly as it did before this existed. Held on the engine
       as well as in the uniform because a quality change rebuilds the whole
       composer, and a stage that silently went a stop brighter when the
       player touched a settings slider would be a nasty little bug. */
    this.grade = t.grade || null;
    this.shaft = t.shaft === undefined ? 0 : t.shaft;
    this.sat = t.sat === undefined ? 1 : t.sat;
    this.con = t.con === undefined ? 1 : t.con;
    this._applyLook();
  }

  _applyLook() {
    if (!this.final) return;
    const u = this.final.uniforms;
    const g = this.grade;
    if (g) u.uGrade.value.set(g[0], g[1], g[2]); else u.uGrade.value.set(1, 1, 1);
    u.uShaft.value = this.shaft || 0;
    u.uSat.value = this.sat === undefined ? 1 : this.sat;
    u.uCon.value = this.con === undefined ? 1 : this.con;
  }

  /**
   * Hand the terrain the real shadow map.
   *
   * The terrain's GLSL has always carried a complete dynamic-shadow path —
   * uRShadow / uRShadowMat / uRShadowOn / uRShadowTexel and a five-tap PCF
   * over three's RGBA-packed depth — and nothing ever switched it on, so
   * every car in the game floated a few centimetres above its own ground
   * with only the baked terrain self-shadow underneath it. This is the wire.
   *
   * Pass null when a stage is torn down, or the engine holds a disposed
   * material's uniforms across the next build.
   */
  attachTerrain(terrain) {
    if (this.terrain && this.terrain !== terrain) this._terrainShadow(0);
    this.terrain = terrain || null;
  }

  /** Flip the terrain's dynamic-shadow branch without touching anything else. */
  _terrainShadow(on) {
    const u = this.terrain && this.terrain.uniforms;
    if (u && u.uRShadowOn) u.uRShadowOn.value = on;
  }

  /** keep the shadow frustum tight around the car so 2 k feels like 8 k */
  aimShadow(target, sunDir) {
    if (!this.sun.castShadow) { this._terrainShadow(0); return; }
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(sunDir, 90);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();

    const u = this.terrain && this.terrain.uniforms;
    if (!u || !u.uRShadow) return;
    /* setQuality() disposes the map and leaves it null; three re-creates it
       inside the next shadow pass. Until then there is nothing to sample, and
       a null sampler bound to a live texture unit is an error on some
       drivers — so the branch goes off rather than reading garbage. */
    const map = this.sun.shadow.map;
    if (!map) { u.uRShadowOn.value = 0; return; }
    /* Recompute the shadow matrix HERE rather than using the one three left
       behind. three refreshes it during the shadow pass, which happens inside
       composer.render() — i.e. after this call — so the matrix sitting on the
       shadow right now belongs to the previous frame and to the previous
       position of the car. At 40 m/s that is two thirds of a metre of offset
       between a car and its own shadow. Calling updateMatrices with the light
       we have just aimed produces exactly the matrix the shadow pass is about
       to derive from the same inputs. */
    this.sun.shadow.updateMatrices(this.sun);
    u.uRShadow.value = map.texture;
    u.uRShadowOn.value = 1;
    u.uRShadowMat.value.copy(this.sun.shadow.matrix);
    u.uRShadowTexel.value = 1 / Math.max(1, this.sun.shadow.mapSize.x);
  }

  render(dt) {
    this.final.uniforms.uTime.value += dt;
    this.composer.render(dt);
    this.governor(dt);
  }
}

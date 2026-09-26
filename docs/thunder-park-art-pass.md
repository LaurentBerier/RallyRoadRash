# Thunder Park visual pass — 25 September 2026

The supplied game screenshot was used to generate `assets/concepts/thunder-park-benchmark.png`. The playable stage implements its warm ivory afternoon light, cool shadows, muted earth, layered desert atmosphere and festival lighting.

## Delivered

- Sun positioned at 20° elevation / 40° azimuth, ahead-left in the benchmark chase view, with matching terrain-bake, object light and panoramic sky directions. Cooler hemisphere fill, restrained filmic grade, stronger atmospheric separation.
- New panoramic sky, also used for material reflections. Optimized full and low-tier WebP versions.
- Dedicated compacted-dirt texture with two sampling scales, directional worn lanes, material relief, softer micro-noise and detail extending across distant jump faces.
- Natural eroded hoodoo geometry, sandstone relief and mineral layers, footprint-grounded boulders, neutral rock scans and 14 distant mesa silhouettes.
- Clustered dry shoulder grass, dark steel furniture, warm instanced gantry/festoon lamps and 28 bounded drifting dust sheets. Decorative cables stay outside the driving corridor.
- Low-tier contact shadow. Track layout, jumps and checkpoint logic are preserved. Hornet handling is upgraded as requested below.

## Visual review

Compare `thunder-park-final.jpg` with the benchmark. This is an art-direction comparison, not a measured percentage of a commercial AAA renderer. Lighting, palette, material separation and atmosphere are close to the concept; distant terrain silhouettes, vegetation complexity and small set-dressing detail remain simpler than the painting.

My overall visual assessment is approximately 80% of the concept target. This is a subjective review of the actual rendered frames, not an automated image-similarity score or a claim of equivalent rendering technology.

Platform review: [play the game](https://sandscape.app/creating?session=session_20260902_76c0fc310c184914d6a5c221bacd8d63), [concept benchmark](https://sandscape.app/creating?session=session_20260902_76c0fc310c184914d6a5c221bacd8d63&editor=assets&asset=30840d35-1e04-40ce-ba42-515b5e01a213), [sky](https://sandscape.app/creating?session=session_20260902_76c0fc310c184914d6a5c221bacd8d63&editor=assets&asset=c3e7997c-ddbe-4170-8403-558bd7633209), [dirt texture](https://sandscape.app/creating?session=session_20260902_76c0fc310c184914d6a5c221bacd8d63&editor=assets&asset=2b4d546c-0516-4e43-8d69-ca0c4f430006).

Review captures cover the start straight, Sky Hook at 265 m and the Big Gap approach at 920 m. High and low settings and the no-assets fallback were inspected. The local 1280×720 preview reported approximately 60 fps / 16.7 ms; this is not a hardware-independent performance guarantee. Final high-tier start view is approximately 223 draw calls and 1.93 million submitted triangles including rendering passes.

## Validation

- `npm test`: 34 / 35 tests passed. The existing audio-manifest audit fails on 20 unreferenced audio files already present before this pass; audio was not modified.
- `dev/sky-check.mjs`: 137 / 137 checks passed, including the new sun and atmospheric exposure calibration.
- `dev/camera-check.mjs`: 115 / 115 checks passed.
- `dev/environment-check.mjs`, `dev/polish-check.mjs` and `dev/thunder-polish-check.mjs`: passed.
- Runtime module dependency closure: 110 files resolved.
- Browser: production main menu rendered; high, low and no-assets track previews rendered without console errors.

## Asset generation

All three images were made using the built-in ImageGen tool. No Sandscape generation coins were used. Original PNGs are retained; runtime textures use WebP.

### Benchmark prompt

Use case: stylized-concept. Create a high-end AAA racing game art-direction paintover of this exact Thunder Park screenshot. Preserve the motorcycle rider, chase camera, wide dirt stunt track, red sandstone pillars, gantries and desert festival identity and road layout. Remove HUD and red handwritten annotations. Transform rendering quality: late-afternoon warm ivory directional sunlight from upper left, cool blue-gray ambient shadows, pale blue sky with delicate cream clouds, layered dusty atmospheric perspective separating distant desert mountains, realistic muted ochre compacted dirt with readable longitudinal tire ruts and fine gravel, subtle windblown dust along verges, weathered stratified sandstone with neutral shadow faces, clustered dry grasses and scrub, dark steel gantry and tasteful amber practical lights. Filmic highlight rolloff, physically plausible materials, balanced exposure, crisp foreground but calm distant detail. The terrain must not be uniformly orange or over-sharpened. Achievable premium real-time game art, not fantasy. Wide 16:9 landscape image. Keep layout and landmark placements closely faithful to input.

### Sky prompt

Create a game sky environment texture, 2:1 equirectangular 360 degree panorama, 3072x1536. Reference image provides the color and lighting direction only. Pale desaturated blue upper sky with delicate scattered ivory altocumulus clouds, late afternoon warm ivory sun glow towards left, dusty cool gray and pale mauve distant layered desert mountain ridges along horizon exactly at vertical center. Mountains occupy only a narrow band up to 8 degrees above horizon, tiny and very distant, atmospheric perspective. Lower hemisphere is muted sandy beige ground fading to neutral taupe bottom. Upper hemisphere all sky. No foreground objects, no roads, no cars, no buildings, no vegetation, no text, no HUD. Photorealistic AAA desert motorsport sky. Seamless left-right edges, no orange wash, no dramatic saturated sunset. The horizon is level. This is a usable lat-long sky dome texture not a perspective landscape.

The tool returned 1774×887 pixels; the runtime full-resolution WebP preserves those dimensions.

### Dirt prompt

Photorealistic seamless tileable PBR base-color texture for a premium desert motocross track, square 2048x2048. Orthographic straight-down scan of 4 meters of compacted dry brown earth. Muted neutral umber and taupe soil, dense fine gritty soil with scattered tiny angular beige gravel, subtle overlapping shallow tire compression and irregular cracked clods. Mostly smooth compacted areas interspersed with granular small patches. Consistent real world scale, natural variation across large patches, no giant rocks, no grass, no obvious straight lines or markings, no objects, no horizon, no text, no perspective. Flat diffuse shadowless lighting with zero baked directional shadows or specular highlights, physically plausible dry dirt albedo. Seamless four edges. AAA game scanned material, not illustration, not sand, not orange.

The tool returned 1254×1254 pixels; texture derivatives supply surface relief. No unrelated normal map is applied to this material.


## Follow-up: lighting, exhaust, dust and Hornet handling

- Corrected the sun from behind-right to ahead-left to match the concept. Long shadows now run back-right. Rotated the sky panorama with it, recalibrated the procedural fallback exposure, and kept the terrain occlusion bake synchronized.
- Distant terrain and mesa materials use height-dependent haze: cooler upper ridges and warm, sun-facing valley gradients. Foliage has darker roots, pale dry tips and restrained transmitted fill.
- Four primitive mufflers use deterministic rust/pitting textures, metallic clamps and dark recessed outlets. Both procedural and imported vehicle fits place them at the actual flame origin.
- Dust uses the actual ground surface, small local luminance variation and terrain sun visibility. Shadowed dust receives cooler, darker fill. Corrected the impostor light vector from world to view space. Distant puffs shrink up to 32%, fade to 20% opacity by 210 m, blend toward theme haze and disappear smoothly by 380 m. Embers retain their own emissive behavior.
- Hornet mass stays 245 kg. Power, grip, braking balance and speed-sensitive steering improve clean driving while collisions remain dangerous.

Measured on flat dirt using the shared simulation:

| Vehicle | 0–108 km/h | Turn radius at 65 km/h | Top speed |
|---|---:|---:|---:|
| Hopper | 3.35 s | 24.05 m | 140 km/h |
| Ridgeback | 3.93 s | 22.59 m | 122 km/h |
| Redline | 2.88 s | 22.57 m | 162 km/h |
| Hornet | 2.18 s | 21.95 m | 166 km/h |

Hornet braking from 108 km/h improves from 26.8 to 23.6 m. Its turning radius improves from 27.0 to 22.0 m. In a head-on collision it receives 6.86 times the Ridgeback's velocity change. All 204 vehicle checks pass, including landings, rollover margins and random-control stability. The new handling test verifies the actual roster comparison and collision behavior; dust checks cover cooler/darker ground shadow response.

Browser review covers the sunlit straight, shaded dust at 530 m (near, 35 m, 90 m and 170 m), low-tier bike exhaust at 265 m, and fallback rendering at 920 m. High and low previews reported 60 fps on this machine; no shader errors were reported. Captures: `thunder-park-final.jpg`, `thunder-dust-followup.jpg`, `thunder-bike-exhaust.jpg`.

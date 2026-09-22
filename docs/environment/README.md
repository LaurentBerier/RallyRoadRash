# Environment art pass — September 2026

`aaa-benchmark.png` is the AI-generated art target, based on the supplied
Proving Grounds gameplay screenshot. It is a concept image, not a capture of
the browser renderer. The playable implementation moves toward its material,
lighting and composition; it does not reproduce its offline-rendered fidelity.

## What the benchmark changes

| Area | Original screenshot | Target and implementation |
| --- | --- | --- |
| Lighting | Pale, nearly uniform road and landscape | Warm directional key, cooler fill, controlled terrain albedo, rough materials and local shadows |
| Ground | Long repeated streaks | Generated seamless aggregate, sand and loam; rotated texture sampling, irregular road wear and derivative bump relief |
| Quarry | Thin illustrated horizon and empty plain | Shared baked excavation benches, fractured relief, buried rock outcrops, cliff material extending into the middle distance |
| Verges | Sparse tiny props | Clustered scree and textured sagebrush, with per-biome colors and density tiers |
| Barriers | Paper-thin bright rail strips | Weathered blue and concrete Jersey-style blocks on Proving Grounds |
| Landmarks | Machinery too small to read | Enlarged conveyor and crusher, with placement and whole-footprint clearance checks |
| Forest | Stacked geometric cones | Irregular dense branch whorls, generated needle alpha texture and matching cutout shadow material |
| Sky and reflections | Illustrated skyline and an unrelated LDR panorama | Physical per-stage sky and its PMREM reflection environment, with matching key direction |

All five stages share the new material and dressing systems. Their lighting
identities remain distinct: quarry daylight, warm sandstone, cool wet forest,
volcanic dusk and sunset mesa. The existing vehicle models are retained.

## Runtime implementation

- `terrain-bake.js` owns quarry relief for both rendering and driving height.
- `terrain-shader.js` combines theme albedo, material textures, road wear,
  triplanar cliff projection, detail normals and distance fades. Far clipmap
  rings retain cliff detail; micro ground detail still fades out.
- `environment-dressing.js` instances gravel, scrub and outcrops. Decorative
  count scales with quality; solid outcrops and their colliders never disappear
  when switching quality. Placement checks road, shortcut, checkpoint, grid
  and existing landmark clearances.
- `props-shapes.js` builds pine branches and triplanar stone materials.
- `assets.js` retains the anonymous CORS loading path and skips seam-blurring
  averaging for tiles authored to repeat. Missing assets retain procedural
  fallbacks. The terrain texture array uses 512-pixel layers.

No paid Sandscape asset generation was used. The built-in image generator
created the benchmark and bitmap assets; existing Sandscape GLBs were reused.
The original image-generator outputs remain in the user's generated-images
folder. PNG master copies also remain locally under assets; quality-90 WebP
runtime copies preserve full dimensions and lossless alpha quality while
reducing the six textures from about 19 MB to about 4.2 MB. Only those WebP
copies are tracked and uploaded, alongside the benchmark PNG.

## Asset briefs

Generation mode: benchmark edit using the supplied gameplay screenshot;
new-image generation for individual material and foliage assets.

The benchmark brief preserves the rear chase camera, armed buggy, road curve
and racing HUD while depicting a photorealistic AAA quarry: fractured warm
limestone, layered distant ridges, industrial conveyor, weathered blue-white
concrete barriers, rough compacted gravel, scrub and rubble, warm sun and cool
shadows. The asset briefs derive from that target:

- `ground/gravel-v2.png`: seamless overhead fine quarry aggregate, neutral
  diffuse lighting, no baked tracks, directional shadows or perspective.
- `ground/cliff-v2.png`: seamless approximately six-metre limestone face with
  irregular blocks, fractures and strata; flat diffuse albedo illumination.
- `foliage/quarry-scrub.png`: isolated realistic sagebrush and dry grasses on
  transparent alpha, suitable for crossed vegetation cards.
- `foliage/spruce-bough.png`: isolated realistic spruce bough, root at bottom
  center and tip at top, transparent alpha and fine needle silhouettes.
- `ground/sand-v2.png`: seamless four-metre overhead sandy hardpack with small
  embedded stones, flat diffuse lighting, no tracks, grooves or repeating bands.
- `ground/soil-v2.png`: seamless four-metre overhead damp brown forest loam,
  fine clods, embedded pebbles and sparse needle fragments, no baked specular
  highlights, puddles, tracks or linear grooves.

## Review and validation

Run `npm test`. The suite includes environment geometry finiteness,
deterministic placement, conservative solid-object clearances and quality
switching, as well as the existing gameplay, asset and sky checks.

Run `node server.js 5189 --shots`, then open
`dev/firstlight.html?track=training&veh=hopper&q=high&still=1&s=60&capture=training`.
Change `track` to `canyon`, `forest`, `volcano` or `thunder`. The harness reports
frame timing, full-frame draw counts and landmark loading state. `noassets=1`
exercises fallbacks. Local `capture` writes the canvas after 150 rendered
frames to `.shots/`; it is disabled on non-local hosts. Compare a landscape
viewport with the benchmark, not a portrait crop.

Validation on September 22: all 23 automated tests passed. All five high-quality
stage harnesses loaded their two landmarks and rendered at approximately
60 fps on this machine in the inspected stationary views. The regular
menu → stage select → garage → six-car race flow reached gameplay. A second
local document origin with an injected base pointing at the asset origin
rendered Canyon, loaded the generated textures and both GLBs, and reported no
browser errors or warnings. These are smoke checks, not a full playthrough or
a benchmark across hardware.

`gameplay-after.png` is an actual local Proving Grounds canvas capture from
this implementation; compare it with the concept `aaa-benchmark.png`.

Remaining visual gap: the concept has much richer bespoke rock geometry,
volumetric clouds, vegetation diversity and high-resolution physical material
detail than this lightweight WebGL implementation. No claim of pixel parity
or general hardware performance is implied by a local screenshot or frame rate.

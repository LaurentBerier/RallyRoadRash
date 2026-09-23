# Proving Grounds — focused benchmark iteration

The active target remains at least 80% of the supplied AAA benchmark's perceived
quality, beginning with this level only. The previous pass did not meet that
target. This file records work in progress, not acceptance.

Visual acceptance requires strong agreement with the benchmark in foreground
surface detail, natural dense verges, fractured quarry geometry, industrial
composition, and photographic sky/atmospheric depth. Unit tests cannot establish
that visual acceptance. Compare the actual chase camera at multiple positions
and both directions, including a moving lap.

New work:

- Full spherical photographic quarry panorama for the sky and far background.
  Its rotated rendering is captured into PMREM, so reflections use the same
  photographic environment. This is an LDR generated image, not measured HDR.
- CC0 scanned complete boulder geometry and its normal/roughness maps, with separate
  desktop and low-detail geometry and texture payloads. See the license under
  `assets/models/quarry/`.
- Full-resolution 2K Rocky Trail diffuse and measured normal textures, scoped
  to Proving Grounds. Source and attribution are in `assets/ground/`.
- Rock instances are grouped into eight spatial sectors to cull the geometry
  outside the camera and shadow frusta. Changing quality reloads the appropriate
  geometry and textures; placement and collisions stay fixed.
- The high/low boulder meshes contain 4,296 / 1,124 triangles. A cut cliff scan
  was rejected because its rectangular edges remained visible as outcrops.
- Photographic 4K clouds blend above the generated distant ridge; the entire
  composition feeds PMREM. Low/medium boot uses a 2K sky and 1K ground maps.
  These image tiers are selected at boot; changing quality later retains the
  loaded image tier until reload. Model quality can change during the race.
- Steeper shared terrain benches, subdued blue concrete barriers, an inclined
  conveyor with braced supports, denser stone banks and 9,000 maximum shoulder
  pebbles. Low uses one quarter of the small decorative instances.
- A low-tier contact shadow grounds the player without a shadow-map pass.

Foliage generated with the built-in image tool (new-image mode), saved as
`assets/foliage/quarry-tussock-v3.webp`, preserving alpha. Prompt:

> Production game foliage cutout texture: one small dry Mediterranean roadside tussock, thin straw gold grass blades mixed with sparse olive sage leaves and branching brown stems. Photoreal botanical detail, open irregular airy silhouette with transparent gaps between stems, not a dense solid bush. Entire plant isolated on genuinely transparent alpha background, no colored background, no ground patch, no rocks, no cast shadow, no border or lettering. Straight-on side view at plant height, evenly lit diffuse daylight without baked directional shadows. Natural muted olive, straw and gray-brown only, absolutely no vivid red yellow fringes. Plant spans 90 percent image width, roots/base at 92 percent height, foliage top at 10 percent. One plant, square asset.

The image viewer shows colored RGB values in transparent pixels. A raw-pixel
check found no red pixels above the runtime alpha cutoff; this is not visible
colored foliage in the rendered scene.

Panorama generated with the built-in image tool (new-image mode), saved as
`assets/sky/quarry-panorama-v3.webp`. Generation prompt:

> Create a production photorealistic 360 degree equirectangular environment panorama, exactly 2:1 aspect ratio, full spherical projection, seamless left and right longitude edges. This is a skybox and distant background for a AAA off-road racing game set in a vast abandoned limestone quarry in an arid mountain basin. Camera at ground level. Horizon exactly at the vertical midpoint. Upper hemisphere: richly detailed realistic blue sky, crisp sculpted scattered cumulus clouds with silver edges, warm late-afternoon sun coming from upper left at 35 degrees elevation, cool atmospheric blue far mountains on the horizon. Distant rugged stratified ochre limestone quarry escarpments and muted mountain ridges rise only 5 to 12 degrees above horizon, layered atmospheric depth, fine erosion and geological detail. Lower hemisphere: neutral tan rocky quarry floor, no nearby objects. Absolutely no vehicles, roads, people, buildings, poles, text, borders or UI. This must look like real high resolution outdoor HDRI photography, not painted illustration or a stylized game. Rich but controlled natural color, warm limestone and cool shadows, sharp detailed cumulus clouds and mountains. Full 360 x 180 degree lat-long projection with correct zenith and nadir compression. No giant sun disc.

Validation: 23 automated checks pass, including terrain/track geometry,
deterministic solid placement, quality tiers, and linear normal-map decoding.
The conservative scripted driver (pace 0.55) passed the finish and continued
around the course; the faster harness driver rolled off course near the finish.
This is not a claim of full-speed driving validation. Desktop high and low
rendering were reviewed at s=60, with another view at s=420. Low rendering uses
smaller image payloads, fewer decorative instances and simpler scanned meshes;
a desktop browser at a phone viewport is not a real-device performance test.

The benchmark target is still open. The main remaining differences are the
quarry walls' smooth upper edges, industrial scale/composition and the natural
variety of the dense foreground. Do not propagate this recipe to other levels
before accepting Proving Grounds.

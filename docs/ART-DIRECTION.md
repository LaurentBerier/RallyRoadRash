# RALLY ROAD RASH — Art Direction

The look this game is aiming at, and the prompt language for the optional
generated imagery in `assets/`.

## The one-line brief

**Saturated sunny arcade off-road.** Painterly-realistic, not photoreal and not
cartoon: real materials and real light, pushed one stop brighter and one notch
more colourful than life. Mario Kart's readability and SSX's sense of altitude,
rendered with a rally photographer's respect for dust, low sun and distance.

## What the renderer already does, and what the images are for

Everything the game NEEDS is procedural — the terrain, the vehicles, the props,
the sky, the particles. The generated images are a **look upgrade on four
specific weaknesses**, and nothing else:

| Weakness | The image's job |
|---|---|
| The horizon is a gradient. | A skyline panorama band on the sky dome, behind the procedural vista ring. |
| Close ground is one flat albedo plus noise. | A photographic detail tile per surface, multiplied in under 60 m. |
| Stage cards are a wireframe loop on a flat plate. | Key art of that stage's signature set piece. |
| The menu is a black plate. | Title key art, behind the 3D hero or instead of it on low tiers. |

Every one of those has a procedural fallback that must keep looking deliberate
when the image is absent. See ARCHITECTURE hard rule 1.

## Global prompt language

Include in every prompt:

> saturated sunny arcade off-road racing game art, painterly-realistic,
> strong directional sunlight, clean readable silhouettes, no text, no logos,
> no watermark, no people

Include **"no vehicles"** on everything except the title key art. A buggy that
is not the player's buggy, sitting in the backdrop, reads as a bug.

Avoid: grimdark, desaturated, "cinematic teal-orange", lens flare (the renderer
owns the flare), HUD overlays, borders, frames, vignetting.

## Per-stage palette

These are the actual theme values the shader runs on. Prompts should describe
the same light, not a different one, or the panorama will not sit on the sky it
is drawn against.

### PROVING GROUNDS — `training`
Mid-morning, high sun, clean blue-grey sky. Neutral tint. Ordinary scrubland: a
place to learn, deliberately the least dramatic stage in the game.
Sky `#6688b8` · ground `#423d33` · haze `#a8bad4`.
**Skyline:** low ochre mesas and scattered scrub on a wide flat plain, midday,
pale blue sky, horizon about 40 % up the frame.

### SUNSTRIKE CANYON — `canyon`
Late afternoon, sun low and raking across the wash. Clear warm air — you can see
the far mesas, which is the whole point of a desert. Red rock, red dirt.
Sun `#ffab82`-warm · sky `#7585b3` · haze `#ccae85` · rock `#853f2d`.
**Skyline:** layered red sandstone mesas and buttes receding into warm haze,
late afternoon, long shadows, no sun in frame.
**Key art:** the MESA LAUNCHER — a wide ramp cut into red rock throwing a long
shadow, canyon dropping away beyond it.

### TIMBERLINE CLIMB — `forest`
Overcast-bright and misty. The haze does the work: it stacks the pine ridges
into layers instead of one flat green wall. Wet, dark loam — not a desert with
pine trees standing in it.
Sky `#858e9e` · ground `#31352a` · haze `#a8b5b8` · mud `#2b211a`.
**Skyline:** receding ridgelines of dark conifer forest layered in pale mist,
overcast bright, cool grey-green.
**Key art:** THE PLUNGE — a muddy track falling away down a forested mountain
shoulder, mist below.

### CALDERA RUN — `volcano`
Low red sun through smoke. Everything not lit by the sun is lit by the ground.
Ash grey rock, black basalt, orange fissure glow.
Sky `#573d3a` · ground `#472417` · haze `#5c332b`.
**Skyline:** a volcanic range of ash-grey cinder cones under a smoke-red sky,
faint orange glow along the base, heavy atmosphere.
**Key art:** the CALDERA LEAP — a broken basalt ramp over a glowing fissure.

### THUNDER PARK — `thunder` (bonus stunt stage)
Canyon family at sunset: the same red rock, an hour later and one shade more
theatrical. Sun 9° above the horizon, orange horizon band, cirrus. This is the
stunt stage, so the art should feel like a built venue rather than open country.
**Skyline:** red mesas silhouetted against a deep orange sunset, high cirrus
catching the last light, no sun disc in frame.
**Key art:** the SKY HOOK — a big dirt take-off on a plateau against a sunset
sky, floodlight towers and banners along the rim.

## Asset specs

| Asset | Files | Aspect | Notes |
|---|---|---|---|
| Skyline panorama ×5 | `assets/sky/<theme>-skyline.jpg` | widest available | **No sun in frame** — the renderer draws the sun and the sky would fight it. Horizon ≈ 40 % up. Edges get mirrored and cross-faded at load, so the panorama wraps at any aspect. ≤ 2048×512. |
| Ground tile ×6 | `assets/ground/<surface>.jpg` | 1:1 | DIRT, SAND, ROCK, MUD, GRASS, ROAD. "Seamless tileable texture, top-down, **flat even lighting, no shadows, no highlights**" — the renderer supplies the light, and any baked shadow tiles into a visible grid. 1024². |
| Stage key art ×5 | `assets/art/<trackId>.jpg` | 16:9 | The signature set piece above. No text. 1280×720. |
| Title key art ×1 | `assets/art/title.jpg` | 16:9 | Hero buggy mid-air over a canyon at golden hour. The one prompt that WANTS a vehicle. 1280×720. |

JPEG q ≈ 82; ≤ 3.5 MB for the whole set. Post-processing is done locally with
`System.Drawing` — no new dependencies.

## Judging a result

Reject and re-roll (**at most once per asset**) when:
- a panorama has a sun, a horizon far off 40 %, or a foreground object;
- a ground tile has baked shadows, a strong colour cast, or an obvious focal
  subject (it is a texture, not a picture of a thing);
- key art contains text, a logo, or a vehicle that is not the hero;
- the palette fights the stage's theme values above.

Otherwise keep it. The images are multiplied and faded into a procedural scene;
they do not have to be beautiful alone, they have to be *right underneath*.

## Production log — first pass

17 images, 170 coins at the live 10-coins-per-image price, no re-rolls spent.
Three things worth knowing before anyone generates the second pass:

**The widest aspect is 16:9, not 2:1.** The CLI accepts `--aspect 2:1` but the
image model rejects it (`unsupported aspect_ratio`); the run fails and is
refunded, so it costs nothing but a round trip. Panoramas are therefore
generated at 16:9 and **cropped locally to a 2048×512 horizon band** (rows
12 %–62 % of the frame). That crop is why the prompts ask for the horizon at
40 %: it puts the silhouette in the middle of the band with sky above and haze
below, and throws away the foreground the model insists on adding.

**The ground tiles arrived lit.** Only DIRT came back with genuinely flat
lighting; the other five have a directional key, and MUD came back as a
perspective photograph with depth-of-field rather than a top-down tile — the
prompt said "flat even ambient lighting, no shadows, no highlights, no
directional light" and the model did it anyway. They ship as generated,
because:

- `core/assets.js` cross-fades four half-tile-shifted copies of each tile when
  it builds the array texture, which suppresses large-scale variation as a side
  effect of making the tile seamless; and
- the terrain shader multiplies these in at low contrast as *close-range*
  detail, faded out by 60 m.

A local de-light (divide by the low-frequency luminance) was tried and made
five of the six measurably worse, so it was dropped rather than shipped
half-working. If P1 reports a visible tiling grid in the preview, the fix is a
re-roll with **texture-swatch vocabulary** — "flat albedo texture map, diffuse
only, unlit, orthographic swatch" — not photographic vocabulary, which is what
pulls the model toward a lit photograph. Do not re-run the de-light.

**The title art is the one prompt that wants a vehicle**, and it is the one
that came back best: a buggy mid-air off a dirt ramp over a red canyon at
golden hour. Keep that framing if it is ever regenerated.

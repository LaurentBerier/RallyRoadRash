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

## Production log — wasteland pass (wave 8)

Budget approved: **5,000 coins**. Live prices, each read from the first real `quote`
of its kind on 2026-09-03 — never quote these from memory, they are the platform's to
change:

| kind | price | planned calls | projected |
|---|---:|---:|---:|
| `image` | 10 | 17 | 170 |
| `3d` | 80 | 13 | 1,040 |
| `music` | 15 | 7 | 105 |
| `sfx` | 10 | 30 | 300 |
| | | | **1,615** |

Comfortably inside 5,000, so the wave runs as planned. The four probe calls that
established those prices produced real deliverables and are listed below.

**The image model still puts wheels on a car you told it not to.** The Hopper concept
prompt says "no wheels — empty wheel arches" and came back with four fat off-road tyres,
rendered better than anything else in the frame. Everything else landed: welded plate,
rust streaks, roll cage, exposed suspension, spikes, a clean white background.

**And the mesh comes back as ONE fused node.** `hopper-carcass.glb` is 1 mesh, 1 node,
1 material, 4 textures, 6,149 triangles, no Draco or meshopt — so `GLTFLoader` reads it
with no decoder, but there is **no node named `wheel` to delete**. A strip that walks the
node tree finds nothing to remove. Two ways out, and P2 owns the choice:

1. **Strip by triangle**, once, at load: drop faces whose centroid falls inside the wheel
   cylinders derived from `spec`, then recompute bounds. Costs one pass over 6 k triangles
   and works on every future carcass regardless of how the exporter groups them.
2. **Edit the concept first.** `generate image-edit "remove the wheels, leave empty wheel
   arches" --in <concept>` is 10 coins against 80 for a fresh `3d`, and it keeps the
   silhouette the concept already got right. Cheaper than a re-roll and much more likely
   to work than re-prompting from scratch.

**Also: the model's long axis is X, not Z.** Bounding box on the Hopper carcass is
1.897 × 0.831 × 1.256 (X × Y × Z), so the fit table starts from a 90° yaw. Assume nothing
per machine; measure each one.

**Generated audio arrives as 44.1 kHz 16-bit stereo WAV, and it is enormous.** The
training track is 105.0 s and **17.7 MB**; five of those plus a menu theme is over 100 MB,
against a repo where three.js is currently the largest thing in the download. SFX are
smaller but add up: 2.04 s of rocket launch is 352 KB, and there are twenty-six of them.

There is **no ffmpeg on this machine** (searched Program Files, ProgramData and both
AppData trees). The npm registry is reachable, so the encode is a **dev-time** step, run
from the scratchpad and never from the repo: install a pure-JS MP3 encoder outside the
project, transcode, and commit only the `.mp3`. The repo keeps its no-dependency promise
because nothing it contains depends on the encoder — the same way the ground tiles were
cropped locally with tools that are not in `package.json`. `server.js` already serves
`.mp3`, and now also `.wav`, `.glb` and `.gltf`.

One MP3 caveat that matters for music: the format carries encoder delay and padding, so a
decoded buffer does **not** loop gaplessly on its own. Set `loopStart` / `loopEnd` on the
`AudioBufferSourceNode` in samples to skip the padding rather than trusting `loop = true`.

### Probe deliverables, staged and unplaced

Left in `.sandscape/generated/` for the package that owns them:

- **Hopper concept** (image, 10) — `bb1bf4f5fd0e329318fa33305ce008af/`
  `hopper-carcass-concept_6273f6a4-….png` → P2, `assets/concepts/`.
- **Hopper carcass** (3d, 80) — `8569ebe853dcf36ebd65a60add0ddc8a/generated_assets/assets/`,
  two files; keep the **compressed** one (`…0856f78e….glb`, 3.3 MB), not the 16 MB raw
  mesh → P2, `assets/models/hopper-carcass.glb`.
- **Training music** (music, 15) — `f070882a0df923663bc9d3f8b947df23/generated_assets/audio/`
  `music-training_d71b1ec5-….wav`, 105.0 s → P5, `assets/music/`.
- **Rocket fire** (sfx, 10) — `999c5c58b79c1ef67e0eae6c4e21306e/generated_assets/audio/`
  `sfx-rocket-fire_d4385f6b-….wav`, 2.04 s → P5, `assets/sfx/`.

### Salvage after the session-limit stall

The first launch of the six-package wave was killed by an API session limit within a
couple of minutes. It had already **spent 495 coins**, and none of it had been placed.
Everything below is paid for and staged under `.sandscape/generated/`. **Regenerating any
of it burns coins for a file we already own.** Where a `3d` run produced two GLBs, the one
named here is the one `meta.primary_output` points at — always the smaller; the other is a
15 MB raw mesh and is not wanted.

**Hero concepts** (P4, 10 each). Canyon and volcano each have a `-clean` re-roll; prefer it.

| theme | file under `.sandscape/generated/` |
|---|---|
| canyon | `7a3f050ac4a386c1b3cd92d998deb421/canyon-hero-concept_be46a518-7a0d-446c-a461-ebdb6cbd77a1.png` |
| canyon (clean) | `23e4435a1441b69b41a6c1267f4f1809/canyon-hero-concept-clean_7080649c-52aa-4801-ab9d-7cfc6beca8e2.png` |
| forest | `35200500a4156816b5e3d563c85db670/forest-hero-concept_9a860943-b54f-4fe1-9ca8-105c1ecf2184.png` |
| volcano | `6a73de5db6b44d8caf6205bd2377e167/volcano-hero-concept_a14841bb-b026-419e-acb6-e66ed7c7036b.png` |
| volcano (clean) | `4aea401d89ee67729e844dc2f78e55c4/volcano-hero-concept-clean_a1ec3217-2fa9-4767-99ae-bc921b0b4664.png` |
| training | `8978d533a8a960516f06aac5a60b1bc2/training-hero-concept_d1f24341-49ca-4aa8-b20b-17301be33d9a.png` |
| thunder | `482719573afcc83e2ac5dd7441afa5e1/thunder-hero-concept_75ae5bd7-08d9-4bfa-9bad-db86a99f1ecc.png` |

**Hero models** (P4, 80 each — all five done, 400 coins):

| theme | file under `.sandscape/generated/…/generated_assets/assets/` |
|---|---|
| canyon | `8f83db672d1a29b1217bdd8fd2128c80/…/canyon-hero_2a4c3d19-2877-44ce-a6a7-2e52289eac22.glb` (2.8 MB) |
| forest | `208595727078f1758e4fc9e292fafd1a/…/forest-hero_c92c98f9-b438-426c-9556-19b671e7349a.glb` (3.0 MB) |
| volcano | `c0aaa815d615bc82e98806bd9f6b712c/…/volcano-hero_7a25c025-9439-472c-a9d5-841bc48ae086.glb` (2.9 MB) |
| training | `3b809a826fedd23f695b4b9608bb198f/…/training-hero_06a954a7-c4f6-41e7-8824-fe4f1318a9d4.glb` (3.3 MB) |
| thunder | `4eb261c9a9de7a79462ed52a096cf384/…/thunder-hero_31d3600c-10e8-4e75-a13d-9a62ce32848b.glb` (1.1 MB) |

**Env panorama** (P1, 10): `44a606818f89f02935f4d3a8055501cf/training-env_86d726c9-fa51-4d4d-894b-3cb46f28b6c6.png` (3.1 MB, 16:9 — still needs the local pad to 2:1 and the size reduction).

**Canyon music** (P5, 15): `c8d22fa409d6d57a61f5ef829ac4d643/generated_assets/audio/music-canyon_7e9ff58a-3d9d-4b52-9bbd-5040c5cf06fb.wav` (17.7 MB).

Two source files also survived the stall, both complete and both parsing:
`src/world/kit-arsenal.js` (all four §8.8 signatures) and `src/world/kit-wasteland.js`
(P4's twelve new factories, split out of `kit.js` because `kit.js` was already large).

---

## Wave 8 — the sky went physical, and the env A/B the lead has to judge

*P1, wave 8. Everything below is measured, not looked at: this package had no
browser.*

### What changed

`src/world/sky.js` no longer paints a gradient. The vendored Preetham dome
(`three/addons/objects/Sky.js`) is the sky; a **transparent overlay dome** sits
on top of it carrying exactly the three things a scattering integral cannot do
— the `SKYLINE` panorama band, the caldera's ash and ember blocks, and the
ground haze below the horizon. Sun billboard, clouds, vista ring and ash plume
are untouched.

Two edits to the vendored shader, applied to the material's own strings and
never to `vendor/`:

* **the solar disc is removed.** `sunAngularDiameterCos` gives a 0.53° dot at
  19 000× the sky, which lands *inside* our own sun billboard (1.1–3.4° per
  theme) and measures about seven times brighter than it. Two suns is one too
  many, and the billboard is the one with a per-theme colour and size.
* **an output multiplier, `skyExposure`,** because the shader's units are its
  own. See the table.

### skyExposure, and the numbers behind it

Calibrated by evaluating **both** models in JavaScript — the retired ramp
expression and the Preetham formula — at h = 0.02, averaged over 64 azimuths,
and dividing. `dev/sky-check.mjs` re-measures it and fails outside ±15 %, so
the calibration cannot silently rot when somebody retunes a turbidity.

| theme | turbidity | rayleigh | mie | mieG | skyExposure | measured ratio | dome over the 1.30 bloom threshold | brightest pixel (old dome) |
|---|---|---|---|---|---|---|---|---|
| training | 2.2 | 1.6 | 0.005 | 0.80 | 0.2668 | 1.0000 | 0.00 % | 0.77 (0.66) |
| canyon | 7.0 | 2.2 | 0.005 | 0.80 | 0.3048 | 1.0000 | 0.99 % | 1.73 (0.90) |
| forest | 10.0 | 2.0 | 0.004 | 0.70 | 0.4480 | 0.9999 | 4.07 % | 1.80 (1.19) |
| volcano | 20.0 | 3.0 | 0.020 | 0.85 | 0.0775 | 1.0004 | 0.40 % | 1.86 (0.49) |
| thunder | 8.0 | 2.6 | 0.012 | 0.80 | 0.3704 | 1.0000 | 2.81 % | 3.51 (0.85) |

Two mie values were pulled **below** the wave-8 brief's starting points, for
one measured reason each. Forest at mie 0.012 put **8.2 %** of the whole dome
over the bloom threshold with a peak of 4.02; thunder at the brief's 0.020
peaked at **6.05**, seven times the old dome's brightest pixel. Both are one
number away from the brief's look if the aureole turns out to be wanted: raise
mie and re-run `sky-check`, which prints the `skyExposure` to use with it.

### The visible consequence, stated plainly

`hazeColor` and `horizonColor` are now **derived** (§8.5) — the same value,
deliberately, so the `FogExp2` colour, the terrain's haze uniform and the dome
cannot disagree. Their **luminance** is unchanged to four decimal places. Their
**hue is not**, and on the three warm stages the change is large:

| theme | fog was (authored) | fog is (derived, linear RGB) |
|---|---|---|
| training | `0xc2d5e8` cool blue | 0.592 / 0.662 / 0.678 — near-neutral, faintly cool |
| canyon | `0xe0b58a` warm sand | 0.512 / 0.535 / 0.544 — neutral |
| forest | `0xcedcd4` pale green-grey | 0.723 / 0.728 / 0.725 — neutral |
| volcano | `0x6e2c1c` deep red | 0.090 / 0.084 / 0.084 — neutral, same darkness |
| thunder | `0xdd8846` orange | 0.446 / 0.375 / 0.360 — warm, about half as saturated |

This is not a bug and it is not fixable by tuning: Preetham's output gamma of
1/2.4 desaturates hard, and a parameter sweep (turbidity 4…60 × mie
0.005…0.10) could not get canyon's horizon past r/L 1.05 against the authored
1.47, or volcano's past 1.19 against 2.99. The stage's warmth now has to come
from where it already comes from — `grade`, `sat`, `con`, the sun colour, the
hemisphere fill, the vista ring, and the caldera's own ember block, all
unchanged. **If a stage reads grey in QA, that is the conversation to have, and
the honest fix is a stronger `grade`, not an authored fog colour: putting one
back re-opens exactly the drift §8.5 exists to close.**

### The env panorama

`assets/env/training-env.jpg` — **2048 × 1024, 315 KB, JPEG quality 92.**

The salvaged generation turned out to be a genuine full-sphere 360° equirect
already: the left and right columns match to within adjacent-column noise
(mean channel delta 5.9, against 4.7 for neighbouring columns and 16.9 for
columns 400 apart), the horizon sits at v ≈ 0.49, and the ground converges to
a nadir at the bottom centre. It was simply rendered into a 16:9 frame instead
of a 2:1 one.

So it was **not padded.** A 16:9 frame is *taller* than 2:1, so adding rows
moves it further from 2:1 rather than closer; and flat sky and ground bands
would have pushed the horizon off v = 0.5 and painted over a zenith and a
nadir the image already has. It was resampled 2560 × 1440 → 2048 × 1024 with a
Lanczos window (PIL, not GDI+ — the `DrawImage`/HighQualityBicubic box-average
trap recorded in project memory does not apply, and a 1.25× reduction would not
have triggered it anyway), which is exactly the 16:9 → 2:1 correction. The
brief's instruction was then honoured where it actually helps: the top and
bottom **ten rows** are ramped into the mean of the image's own top and bottom
four rows, so the poles carry no azimuthal variation for PMREM to smear into a
swirl.

**The lead must add to `assets/manifest.json`:**

```json
"env/training": { "url": "env/training-env.jpg", "kind": "equirect" }
```

`kind: "equirect"` already exists in `src/core/assets.js` — sRGB,
`EquirectangularReflectionMapping`, `RepeatWrapping` in longitude, no mipmaps.
Nothing needs adding there.

**And to `src/main.js`, next to the existing `setSkyline` call:**

```js
sky.setSkyline(App.assets.get('sky/' + theme));
sky.setEnvImage(App.assets.get('env/' + theme));   // null is the normal case
```

`setEnvImage(null)` leaves the shader env in place, so the call is safe on the
four themes that have no entry.

### The A/B, and how to decide it from screenshots alone

This package could not run a browser, so this is the whole handover. Two
harnesses carry `?env=sky|image|none`:

```
dev/garage.html?veh=hopper&sky=training&ang=45&env=sky
dev/garage.html?veh=hopper&sky=training&ang=45&env=image
dev/garage.html?veh=hopper&sky=training&ang=135&env=sky
dev/garage.html?veh=hopper&sky=training&ang=135&env=image
dev/firstlight.html?track=training&orbit=1&env=image
```

`ang=45` and `ang=135`, because those are the two bearings that lay the
Hopper's chrome roll cage across the frame at an angle; head-on and side-on
both hide it against its own bodywork. Take the same four shots with
`env=none` as the floor — that is the two lights answering alone, and any
"improvement" the image path shows has to beat `env=sky`, not `env=none`.

**Look at, in this order:**

1. **The Hopper's chrome cage.** With `env=sky` it carries a smooth
   bright-to-dark vertical gradient. With `env=image` it should carry
   something you can *read*: a horizon line, the dark mesa mass above it, sand
   below. A tube 40 mm across cannot show much, so the test is whether the
   horizon line is identifiable, not whether the mesa is.
2. **The rims.** Small, curved, and the busiest reflector on the car — this is
   where a 2048-wide panorama either adds detail or adds noise.
3. **The visor and the glass.** Broad and nearly flat, so they get the largest
   readable patch of the panorama. If it is legible anywhere, it is here.

**Pass criteria — all three must hold:**

* the panorama is **readable** in at least the visor and the cage, at `ang=45`
  or `ang=135`; not merely "different";
* **no blowout after ACES** — no clipped white patch on chrome or glass that
  `env=sky` did not also have. The panorama's sky rows sit near 0.9 linear
  after sRGB decode against the shader env's 0.59 at the same elevation, so
  this is the criterion that can genuinely fail;
* the **bloom threshold stays at 1.30**. If the image path only looks right
  after moving it, the image path has failed: that number is shared with the
  lamps, the lava, the embers and the boost flames.

**Keep the image path** if all three hold and the reflections gain readable
structure. The manifest entry above then ships, and `env/<theme>` becomes the
pattern for the other four stages.

**Drop it** — delete `assets/env/`, leave the manifest alone, and the shader
env stays — if the reflections gain nothing legible (a 40 mm tube may simply be
below the resolution at which a panorama matters), or if anything blows out, or
if it only works with a moved bloom threshold. Nothing else has to change:
`setEnvImage` is written so that `null` is the normal case, and
`dev/sky-check.mjs` gates that the shader env comes back cleanly and that
neither path leaks its render target.

### One thing found and deliberately not fixed

`SKY_THEMES.forest.sunDir.x` is `-0.435229`; `cos(22°)cos(118°)` is
`-0.435286`. A transcription slip of 5.7 × 10⁻⁵, three thousandths of a degree,
and it predates this wave. It must **not** be corrected: `terrain-bake.js` has
already baked forest's sun-occlusion mask against the number that is there, and
a 0.003° improvement is not worth invalidating a bake. `dev/sky-check.mjs`
gates the el/az agreement at 1 × 10⁻⁴ so it catches a wrong *digit* and not
this.

### Verifying this package

```
node --experimental-loader ./dev/loader.mjs dev/sky-check.mjs
node --check src/world/sky.js
node --check src/core/engine.js
node --check dev/firstlight.js
```

### The environment-map A/B — decided (lead)

Run as P1 specified: `garage.html?veh=hopper&sky=training&env=sky|image&ang=45`,
judging the Hopper's chrome cage, rims and visor.

**The image loses on the stated criterion, and it is kept anyway — for a
different reason than the one it was bought for.**

What the two look like is genuinely different and the difference is the right
way round: on `env=sky` the rims and cage are cool blue-white, because a
physical sky is blue and that is what a chrome wheel sitting under one reflects.
On `env=image` the same metal goes warm ochre, which is what a chrome wheel
sitting in a desert actually does — the ground fills most of a wheel's
reflection hemisphere, not the sky.

But **the panorama is not READABLE**. There are no mesas, no horizon line, no
recognisable features in the reflections at any angle — it resolves to a warm
average. P1's pass criterion was "the panorama must be readable in the
reflections", and by that test this fails. So:

- **The shader env stays the default** on all five themes.
- `assets/env/training-env.jpg` is kept. It is paid for, tagged, 315 KB, fully
  optional, and it measurably improves the training stage's metal.
- **The other four themes are NOT commissioned.** Forty coins and ~1.3 MB for a
  tint nobody can identify is the wrong trade.

**The cheap version of what the image was actually doing.** Its whole
contribution was "warm the ground half of the reflection hemisphere". P1 already
added a patched ground bounce beneath the env sky's horizon, so that colour
exists as a knob — making it per-theme would buy the same warmth on every stage
for no bytes and no coins. That is the follow-up worth doing, not four more
panoramas.

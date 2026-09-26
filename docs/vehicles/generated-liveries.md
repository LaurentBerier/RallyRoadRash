# Vehicle liveries and track banner artwork

Created using the built-in ImageGen tool, 2026-09-24. No Sandscape paid generation was used.

## Files and integration

- Benchmark: `docs/vehicles/livery-benchmark.png`.
- Vehicle masters: `assets/vehicles/{hopper,ridgeback,redline,moto}-livery.png`.
- Runtime vehicle textures: the matching `.jpg` files, JPEG quality 94 with original dimensions retained.
- Banner master: `assets/signage/rally-banner-fabric.png`; runtime texture: matching `.jpg`.

The benchmark uses the four existing `assets/art/veh-*.webp` vehicle images as identity references. Each vehicle texture was then generated with the benchmark as its reference, preserving the existing team names, colors and numbers.

GLB bodies use bounded body-space projection on outer side panels and number patches on the hood. Both LODs use the same coordinates. Existing UVs, normal maps, lights, geometry, mud, and ghost behavior remain in place. The procedural works-car fallback also uses the generated artwork. Privateer procedural liveries retain their existing unique numbers/layouts. GLB privateers share the team stickers and retain their paint tint.

Track start/finish, checkpoint, jump and sponsor banners use the generated fabric. Exact game labels are rendered on top at runtime, so track-specific names remain correct. Missing images fall back to the original signage and liveries.

The textures and all four vehicles were inspected in the local rendered garage. This caught and corrected mirrored side lettering. Hornet now uses physical side number boards instead of projecting graphics across the engine. Rear sponsor projection was added for the chase view. The finished Road Rash artwork was also verified on the local track. Automated integration tests cover shader composition, source ownership, transforms, banner drawing, atlas selection and missing-image fallback.

## Finished banner update

`assets/signage/road-rash-finished.png` and `assets/signage/track-banners-atlas.png` are the new generated masters; matching JPEGs are loaded at runtime. The atlas contains CHECKPOINT, BIG AIR, SUNSTRIKE and RIDGEBACK in four equal rows. The earlier plain fabric remains a fallback. Named jumps retain their specific names as small captions beneath the generated BIG AIR artwork.

ImageGen prompt — Road Rash:

Create a finished production game texture for a desert rally START / FINISH gantry banner. Wide 3:1 image, flat frontal orthographic scan, artwork fills frame edge to edge, no background scene or poles. Exact large central headline ROAD RASH, bold ivory condensed motorsport lettering with thin orange outline, taking 65% width. Exact smaller subtitle START / FINISH below, high contrast. Full richly detailed printed charcoal PVC fabric with real woven grain, reinforced stitched hem, metal eyelets, subtle tension wrinkles and dusty abrasions. Left and right end panels feature weathered black/cream checkerboard flags, orange racing chevrons and small technical motorsport badges. Restrained orange accent edge. High-end rally event identity, readable at race speed, no other big lettering, no watermark. Neutral diffuse lighting, no cast shadow or perspective. This is the final image including text to map directly onto the in-game ROAD RASH banner, not a blank background.

ImageGen prompt — banner atlas (using the Road Rash image as reference):

Create ONE production-ready game texture ATLAS matching the supplied ROAD RASH banner design and realistic material quality. Atlas layout: exactly FOUR equally tall horizontal banner strips stacked vertically, no gaps, each strip runs full width. Overall canvas landscape 3:2 so each strip is 6:1. Each strip occupies exactly 25% of image height. Every strip independently has thin stitched orange border, corner eyelets, charcoal woven PVC fabric, light dust and abrasion, weathered cream checkerboard endcaps, distinctive motorsport emblems. Row1 top exact huge text CHECKPOINT with small timing/stopwatch emblems. Row2 exact huge text BIG AIR with small jumping dirt-bike silhouette emblems. Row3 exact huge text SUNSTRIKE with smaller subtitle OFFICIAL RALLY FUEL, with sunburst and fuel pump emblems. Row4 bottom exact huge text RIDGEBACK with smaller subtitle TYRES / SUSPENSION / GLORY, mountain and tyre emblems. Bold condensed ivory typography legible at racing speed, orange accent outlines. All lettering is printed on the fabric with subtle wear. No labels outside the four strips, no blank margins or gutters, no scene or perspective, no watermarks. Each of the four rows must be precisely equal height and complete from left to right; this atlas will be sampled as four textures in a game.

## Final prompts

### Benchmark

Use case: stylized-concept. Create a high quality art-direction benchmark sheet for the existing RALLY ROAD RASH game vehicles shown in the four reference images. Preserve these four vehicle identities: riveted wasteland dune buggy, armored rally pickup, low wedge sports car, armored dirt bike. A landscape 2x2 concept sheet, each quadrant showing one whole vehicle from a clear side three-quarter view with neutral workshop lighting and a light charcoal background, plus a small close-up of its sticker-covered bodywork. Upgrade the surfaces with believable rally scrutineering decals, sponsor vinyl stickers, race number plates, technical safety arrows, torque witness marks, layered chipped paint, fine metal scratches, fasteners and subtle dried dust. Keep most of each rusty body visible; stickers concentrated on door/side panels and hood, never windows or tyres. Team colors and exact visible team text: buggy cobalt blue SUNSTRIKE WORKS number 7; truck forest green IRONHIDE HAUL number 12; wedge racing red REDLINE MOTORSPORT number 23; dirt bike yellow HORNET RACING number 41. Secondary small fictional sponsor text DUST FUEL and GRIT TYRE. Worn cream number plates with bold black numbers. Purpose: a practical benchmark that will guide subsequent flat decal texture generation; crisp realistic material detail, no magical lighting, no unrelated vehicle redesigns. No watermark.

### Hopper

Use case: game texture, stylized-concept. Reference is the approved vehicle surface benchmark, style reference only. Generate ONE flat rectangular 2:1 high-resolution vehicle livery texture for SUNSTRIKE WORKS, number 7. Entire image is the actual texture, edge to edge, no scene, no vehicle, no perspective, no presentation board, no margins. Cobalt blue worn rally vinyl and chipped blue paint surface. Left 60%: clear bold cream SUNSTRIKE WORKS lettering above a yellow angular arrow insignia. Right 30%: large cream rectangular race plate with black 7. Bottom row: small red DUST FUEL sticker and black GRIT TYRE sticker and tiny TOW directional arrow decal. Add believable peeled sticker corners, thin scratches, small bolt heads around outer perimeter, dried dusty specks concentrated bottom, subtle hairline panel seams, fine realistic detail. All letters should be crisp and exact. Mostly clean enough to read at gameplay distance, only 15% worn. Flat diffuse/albedo color only with uniform neutral lighting, no cast shadows, no perspective reflections, no simulated thickness outside image edges. Aim 2048x1024.

### Ridgeback

Use case: stylized-concept game texture. Use the reference benchmark's GREEN TRUCK livery as art direction. Generate one flat edge-to-edge 2:1 rectangular game albedo texture, forest-green worn paint with rally stickers. No vehicle, no scene, no perspective, no margins, no mockup. Left 60%: cream stylized mountain mark and clear bold IRONHIDE HAUL lettering; right 30%: large worn cream rectangular number plate with bold black 12. Bottom: red DUST FUEL sticker, black GRIT TYRE sticker, small TOW arrow. Fine chipped paint, sparse rust at outer edges, subtle rivets around outer border, tiny technical inspection marks, peeled vinyl corners. Keep 85% of graphics readable and clean; avoid excessive grunge in letters. Flat diffuse uniform neutral lighting, no cast shadow. Production ready sticker-covered truck door texture, 2048x1024 target.

### Redline

Use case: stylized-concept game texture. Use reference benchmark RED WEDGE SPORTS CAR livery as art direction. Generate ONE flat edge-to-edge rectangular 2:1 texture, 2048x1024 target. Racing red rally body panel with cream diagonal speed stripes and vinyl sponsor stickers. Left 60% clear large REDLINE MOTORSPORT typography; right 30% worn cream rectangular race number plate with black 23. Bottom small DUST FUEL red sticker, GRIT TYRE black sticker, TOW yellow arrow and a tiny white scrutineering seal. Realistic fine paint scratches, peeled sticker corners, outer perimeter fasteners, restrained chipped edges, dried dust. Keep 85% of graphics readable and clean. Flat diffuse/albedo image with no vehicle, perspective, scene, borders beyond texture, cast shadows or mockup. The image itself is the texture covering the full canvas. Preserve exact spelling.

### Hornet

Use case: stylized-concept game texture. Use the reference benchmark YELLOW HORNET DIRT BIKE livery as art direction. Generate ONE flat rectangular 2:1 full-frame diffuse/albedo texture, 2048x1024 target. Yellow worn motocross vinyl and painted metal, black hornet emblem and bold black HORNET RACING lettering on left 60%, worn cream rectangular race plate with black 41 on right 30%. Bottom DUST FUEL red sticker, GRIT TYRE black sticker, small TOW arrow and technical safety seal. Fine scratches, tiny paint chips, sparse dirt at lower edges, perimeter rivets, curled vinyl corners. Keep graphics crisp and 85% clean. Flat neutral illumination. Entire image is usable texture: no vehicle, no scene, no perspective, no outer margins, no mockup. Exact spelled lettering, strong contrast readable in the game.

### Track banner

Use case: photorealistic-natural game texture. Generate ONE production-ready front-facing race-track gantry banner texture. Very wide landscape 3:1 image. The entire frame is a single rectangular piece of charcoal black coated woven fabric, printed with weathered ivory checkerboard stripes restricted to the leftmost 15% and rightmost 15%, narrow faded warm ochre top and bottom hem, stitched double seams, metal eyelets in corners and at regular intervals along the very top and bottom, subtle tension ripples, realistic PVC-coated textile micrograin, minor rain streaks and dusty abrasion. The middle 65% must remain dark charcoal open area without logos or text for dynamic race labels in the game. It must look like real photographed outdoor motorsport banner fabric, evenly lit neutral diffuse albedo, orthographic scan. No scene, no poles, no sky, no transparency, no surrounding border, no perspective, no dramatic shadows, no baked lighting gradients, no text anywhere. Fabric fills every pixel of the image. Target 3072x1024.

“Approved” in the Hopper generation prompt denotes the selected working benchmark; the user has not provided separate visual sign-off. Actual generated dimensions are those of the saved images, not the prompt's requested targets.

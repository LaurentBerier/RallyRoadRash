# Proving Grounds — roadside composition

Actual rendered review: `quarry-v5-gameplay.png`. The 80% benchmark goal remains
active; this is a verified improvement, not a numerical visual-quality score.

## Changes

- Replaced isolated medium rocks with 80 irregular rubble clusters, containing
  640 scanned fragments. Each cluster has one conservative solid footprint;
  the test suite verifies that every fragment fits inside it. The road,
  shortcut, checkpoint and grid clearances remain enforced.
- Corrected the causeway-like terrain outside the road. Many rock placements
  previously sat 5–7 metres below the driving surface and were hidden by the
  barriers. Excavated spoil shoulders now rise outside the authored verge,
  with lower inner banks and higher outer banks, fading into the quarry floor.
  This is shared CPU/GPU terrain geometry, not floating scenery.
- Extended scanned cliff color and normals onto exposed ledge tops and spoil
  slopes. Previously only steep cliff faces received the material.
- Added generated gray-green sagebrush among the existing dry grass. Exact
  prompt, source path and built-in generation provenance are recorded in
  `assets/foliage/quarry-sagebrush-v1.md`. The WebP preserves transparent alpha.
- Reduced road aggregate scale and applied the scanned material to dirt too.
  Loose ankle-high stones now extend onto the outer driving shoulder, instead
  of being rejected by the road mask and hidden behind the barriers.
- Added a 296-triangle, 512-pixel mobile rock model, 337,596 bytes. Low/medium
  use it for all quarry rocks; high/ultra retain 4,296-triangle near outcrops
  and 1,124-triangle medium/distant rocks. The original CC0 license is retained.

## Validation

All 23 test groups pass, including aggregate collision containment and quality
tiers. A direct before/after terrain bake comparison verified all 56,571
nonzero road-mask height samples are bit-identical and the road mask itself is
unchanged. 154,645 off-road height samples changed; maximum rise was 13.42 m.

At s=60, the desktop high render reports about 1.59M triangles and 160 draws.
The low path at an 844×390 viewport reports about 345K triangles and 91 draws;
the viewport and canvas dimensions were verified through the DOM. Both reported
60 fps on this desktop and no console warnings/errors. This is not a real-phone
performance test. High → low → high runtime switching restored the high models
and AO without console errors while the scripted vehicle was driving.

Remaining gap: the benchmark still has more convincingly fractured geology,
larger industrial structures and richer local material variation. Keep this
recipe focused on Proving Grounds until its visual quality is satisfactory.

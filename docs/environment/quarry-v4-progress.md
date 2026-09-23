# Proving Grounds — cliff and industrial detail pass

The 80% visual-benchmark goal remains active. This records concrete progress,
not a claim that the benchmark threshold has been met.

- Added scanned Rock Face 03 color and linear OpenGL normal maps, projected
  along cliff faces. High uses 2K maps; low and medium boot use 1K maps.
- Broke up the shared terrain bench edges and embedded complete boulders in
  steep faces. Added medium boulders behind the barriers and lowered the scrub.
  The conservative colliders remain present on every quality tier.
- Added a screening tower, platforms, stairs, control room, transfer belt and
  stockpile inside the conveyor site's existing 18-metre collision footprint.
  The new structures share its existing merged draw.
- Added a depth-based contact AO pass on high/ultra in Proving Grounds only.
  It reads the actual displaced terrain depth; no second geometry pass is used.
  Low and medium do not run the AO pass or allocate its depth textures.
- Medium and distant rocks use the 1,124-triangle geometry even on high;
  the 4,296-triangle geometry is reserved for the large near outcrops.

Validation: all 23 test groups pass. The environment checks now exercise crag
placement, road/shortcut/grid/checkpoint clearances, and the industrial site's
finite geometry and full footprint. Fixed-pose AO A/B captures show mean RGB
darkening of 3.30/255 in the vehicle region and effectively zero in the sky;
small differences also include animated grain and lighting, so this is evidence
of localized operation rather than a pixel-exact visual-quality score.
The GPU smoke test at s=195 completed both high-to-low and low-to-high changes,
restored the high rock model and AO, and reported no WebGL warnings or errors.

The s=60 high view fell from 1.95M to 1.36M rendered triangles after the rock
LOD correction, with the same placement. Observed desktop frame rate was 60;
that is not evidence of real-phone performance. Low s=195 was approximately
431K triangles before the final LOD refactor (low geometry itself was unchanged).

Review image: `quarry-v4-gameplay.png`, an actual local gameplay render.
Remaining visual work: stronger foreground composition, natural variation in
the cliff profiles, and richer industrial materials. The benchmark's authored
geology and dense rubble still exceed this version. Keep changes focused on
Proving Grounds until that gap is resolved.

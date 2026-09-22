# Menu polish pass

The generated visual benchmark is `ui/benchmark.webp`. It is art direction, not a flattened menu or a promise of identical generated geometry. Capture references and full-size QA screenshots are retained locally in `.sandscape/ui-pass/`.

Implemented fixed header/footer, title/description slots, framed art, fixed thumbnail rails, independent settings/playbook content scrolling, reserved results record/unlock space and stable action slots. Desktop live garage uses a clean studio wall with decorative dust and floating tyre scenery removed. Small screens use predecoded vehicle art with horizontal thumbnail scrolling.

Boot now awaits the complete standalone image manifest and image decoding. Each request has a 15-second ceiling; failures settle to existing procedural fallbacks. The garage preview is covered until the car and close-detail LOD settle, with a 15-second fallback deadline that invalidates late model replacements. Race streaming remains separate from menu readiness.

23 runtime JPEG images were converted to WebP, quality 86, preserving pixel dimensions and original JPEG sources. Manifest image transfer falls from 4,221,395 to 3,282,660 bytes (22.2% reduction). Car GLB 2K textures and distance LODs remain intact; this compression applies to standalone images, not embedded GLB textures.

Validation: 21 automated test suites; image decode/missing/stalled request regression; desktop 1280x720, portrait 390x844 and landscape 844x390 browser inspections. Stage preview/detail/map/rail bounding rectangles are identical when switching between Proving Grounds and Sunstrike Canyon, including a stage with no records. Pause/results were checked using representative fixture data, rather than completing a full race for each capture.

Narrow screens scroll inside the fixed information panel. Original images remain in the project but are no longer fetched through the runtime manifest. Benchmark and documentation images are not loaded by the game.

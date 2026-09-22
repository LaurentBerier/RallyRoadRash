# Visual polish pass — September 19, 2026

This pass covers rendering, environment dressing, vehicle presentation and five new CLI-generated landmark structures. Generation cost 460 of the approved 900 coins: six concepts (one cropped forest draft rejected) and five models. The unused 440 coins were not spent.

## New landmarks

| Stage | Centerpiece | Triangles | Texture maps |
|---|---|---:|---|
| Proving Grounds | Quarry conveyor gantry | 6,012 | 2048 × 2048 |
| Sunstrike Canyon | Stratified sandstone arch | 6,264 | 2048 × 2048 |
| Timberline Climb | Logging trestle | 6,379 | 2048 × 2048 |
| Caldera Run | Geothermal pipe gantry | 6,780 | 2048 × 2048 |
| Thunder Park | Festival lighting gantry | 6,353 | 2048 × 2048 |

The full-resolution GLBs are retained rather than the platform's 1K compressed alternatives. They add approximately 74 MB across the five stages, loaded on demand. The CLI advertised advanced quality options but the server rejected those parameters with zero charge; supported default generation produced the measured meshes above. These are roadside scenery, with solid reserved footprints, not drive-through structures. Existing hero machinery remains in each stage.

## Changes

- Synchronized renderer, compositor and bloom dimensions. HIGH now renders real scene pixels at the selected output size; adaptive resolution changes all targets together.
- Fixed Hornet's missing Web Audio engine waveform. Waveforms are built for every declared family.
- Enlarged and restaged the five existing landmarks. Candidate sites check the entire footprint, foundation relief, elevation relative to the road and four terrain visibility rays. The Volcano derrick now sits around the caldera floor rather than hidden below the descent.
- Added grounded foundations and contextual equipment around landmarks, clearing intrusive scatter from footprints and tall foreground objects from sightlines. Physical footprints are registered before model downloads finish. Model/fallback/failed placement status is inspectable on props.landmarkStatus.
- Improved pine branch silhouettes and trunk colors; concentrated the existing Forest tree budget nearer the route. Replaced smooth tapered Canyon hoodoos with irregular layered rock columns.
- Added vertical texture projection on steep near terrain, reduced lane-striping contrast, adjusted ground palettes and lifted Volcano's cool fill for vehicle readability.
- Improved wheel materials and differentiated brake hardware from spokes. Hopper now has an open eight-spoke beadlock face. Imported vehicle bodies retain their original maps and geometry, with restrained clearcoat and saturation-based color masking to keep neutral parts out of rival tints. This heuristic is not a substitute for future authored paint masks or rebuilt bodies.
- Repaired firstlight asset setup and garage anisotropy. Corrected driving-harness arsenal statistics and renamed unfinished-field metrics to avoid calling still-racing rivals DNFs.
- Updated misleading boot and page-description copy.

## Validation

- npm test: 19/19 top-level suites pass, including physics, vehicles, props, model budgets, kit geometry, sky, audio manifests, weapons and progression.
- Reachable vendored Three.js module closure: no missing imports.
- Real browser Web Audio: all four engine families initialize and switch successfully.
- Browser world check: all ten landmarks loaded; each selected site passed four terrain visibility rays. These rays do not certify every racing-camera view or arbitrary vegetation occlusion.
- Resolution checks on all five worlds: buffer/composer pairs match at scale 1 (2065×1161) and scale 0.72 (1487×836).
- Visual inspection: all five landmark settings and Hopper materials, with no observed shader errors.
- 20 automated stage/vehicle runs: 19 finished within 600 simulation seconds; Hornet Training did not finish. This sweep preceded the final landmark footprint/elevation refinements and wheel-only change; the final world load/render checks cover the revised placement.

## Remaining work

- Investigate Training checkpoint/progression behavior: Ridgeback still has a long completion-time outlier and Hornet can keep driving without completing the race. Canyon/Volcano recovery hotspots remain. No physics changes were made to mask these results.
- Follow-up: car texture selection is fixed with the existing original 2K exports at close range and 1K exports at distance; see VEHICLE-LOD.md. Geometry is unchanged. Further geometric detail still requires replacement bodywork with clean wheel separation, glass and paint masks.
- Hardware performance, touch/gamepad feel, critical listening and the production cross-origin asset path need dedicated coverage. Local screenshots and simultaneous test tabs are not performance benchmarks.

Local raw results and screenshots are in the ignored .sandscape/polish directory. New files restored by the initial platform pull were preserved.

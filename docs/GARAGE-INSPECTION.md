# Garage inspection pass

The garage now renders inside its own canvas using antialiasing, ACES tone mapping and a maximum 2x display scale / 3 million pixel budget. It no longer shares race dynamic resolution, motion blur, film grain, or exaggerated headlamp sprites. Only the dedicated renderer draws while the interactive garage is open.

Drag/touch orbits, wheel/pinch zooms, and the viewport has zoom and reset buttons. Focus the canvas to use arrow keys, +/- and Home. The camera is bounded above the floor and within the room. The existing 3D-view OFF setting retains the static-art fallback.

The room is actual 24 x 28 x 12 metre geometry: shutter bays, structural columns, roof trusses, upper catwalk, suspended gantry hook, pipes, work lamps, drainage grates, hazard markings and tool cabinets. Floor and walls use 2048px albedo, OpenGL normal and roughness maps. A 2048x1024 Radiance HDR is convolved through PMREM to light PBR surfaces and vehicle reflections. These assets load lazily behind the preview loading cover and are cached for subsequent visits. Original texture JPEG masters stay local; runtime uses WebP.

Vehicle inspection forces the loaded 2K close LOD even when zooming out. It adds smooth 64-segment moulded tyres, separate tread lugs, bead-lock rings and fasteners, bumper/skid/side details, plus local smooth body normals and more restrained clearcoat. These geometry/material changes apply to the showroom instance only. Race meshes and LOD thresholds remain unchanged.

## Source-model limitation

The four existing high LOD bodies still originate from approximately 6,000-triangle generated models. A CLI request for an ultra 100,000-triangle / 4096px replacement was rejected by the Sandscape backend: only `asset_name` is accepted for this generation kind. Charge: 0 coins; approved budget remains 900, spent 460. No default-quality retry was charged. This pass improves display fidelity, modeled running gear and shading, but does not claim to replace those bodies with new high-poly or 4K assets.

## Capture and benchmark

`ui/garage-benchmark.webp` was generated from an actual before screenshot. Its warm/cool industrial lighting, tall shutter bays, gantry, catwalk and floor bay markings drove the implemented geometry. It is an art-direction reference, not a flattened background used in place of the interactive scene. Local snapshots are in `.sandscape/garage-pass/` (before, environment after, and individual vehicles).

## Validation

22 automated suites pass, including all four parked vehicles, detail geometry bounds, cleanup and batched room disposal. Browser QA confirms all four vehicles load high LOD with 2048px maps and the HDR environment. Drag orbit and zoom change camera position; reset restores the default. Rebuilding the viewport leaves one canvas. The environment is batched into about 12 draw calls; the complete preview measured 35–53 calls depending on vehicle and camera.

Manual review uses `dev/garage-preview.html`, with no progression or save changes. Final game checks also cover 390x844 responsive inspection and starting a race: the garage canvas is removed before the race-loading screen.

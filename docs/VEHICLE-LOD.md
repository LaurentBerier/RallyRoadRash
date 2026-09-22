# Vehicle resolution fix

The manifest previously exposed only Sandscape's compressed 1024px exports. The original generations already contained 2048px color, normal, roughness/metalness and emissive maps for all four vehicles. Their full-resolution GLBs are now retained as `*-carcass-high.glb`; no regeneration or coin spending was needed.

Cars load the small export first and request the full-resolution version when the camera comes within 40 equivalent metres. Below 23.8 metres the close version becomes active; it stays active until 28 metres. Distance accounts for camera zoom and field of view, so the garage and chase camera get the detailed maps. This hysteresis avoids flicker at the boundary. A failed high-resolution load leaves the low version visible and does not retry every frame.

This is texture/material LOD: the two exports have identical triangle counts and matching fitted dimensions. It restores four times as many texels per map and finer normal-map detail without changing the vehicle design, wheel clearances or physics. It does not invent additional geometric detail. Animated tyres, suspension and arsenal remain shared outside the body LOD. Fitting the high level does not apply lamp, launcher or exhaust offsets a second time. Materials receive the same mud, livery and ghost effects at both levels.

High assets total approximately 53 MB, streamed only on approach and cached per vehicle type. Instances share template textures. Loaded high textures remain cached for the session; moving away reduces the active texture resolution but does not evict the high maps from memory.

Validation covers both exports of all four vehicles (80 model/fit gates), LOD streaming thresholds, hysteresis, zoom, FOV and failure fallback. The garage exposes Close LOD / Far LOD buttons and reports the measured active texture width. `?lod=low` provides an A/B comparison; `?distance=90` starts outside the prefetch radius.

Browser checks confirmed all four player vehicles select their 2048px maps in an actual race, with no warnings or errors. Hopper switched 2K → 1K → 2K through the garage controls. Truck livery/mud and bike lean/ghost views were inspected. A two-origin local hosting check loaded Redline's high maps successfully with anonymous CORS. All 20 automated suites pass.

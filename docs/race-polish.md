# Race polish — 2026-09-25

- Braking opposes available wheel momentum/drive torque instead of reversing a stopped wheel. Parked visual wheels remain fixed below 0.15 m/s. Reset clears their visual rotation. Tested across all four vehicles with held grid brakes.
- Exhaust uses a shared 1024x256 four-frame generated atlas at 20 fps, rendered with two crossed quads (four triangles), with shorter/wider boost flare and subdued halo. No extra draw calls or per-frame texture allocations.
- Left/right/jump warnings use individual 256x256 generated image textures. Existing generated sponsor/banner textures remain in use. Added texture files total about 288 KiB compressed.
- Canyon aircraft has no pedestal and is pitched/rolled into the sand, sinking 1.1 m below terrain-based placement. Visual inspection confirmed the grounded silhouette.
- Checkpoint headers stay level. Posts adapt independently to terrain; normal headers use 6.5 m plus terrain relief, headers near jumps 10 m. Hero jump arches raised and fitted to all stage shoulders.
- Barriers move outward with extra jump clearance. Their colliders now have finite height, allowing airborne vehicles and rockets to clear the visible rail. Scatter clearance widens within 100 m of jumps.
- Clods are darker, smaller, and launched higher. Sparse rolling pebbles augment dust; landing clod bursts are smaller but more airborne. All use the existing fixed particle pool and one draw call.

Validation: 29 test suites passed before final cosmetic flame proportions; targeted garage/vehicle check repeated afterward. Real low-quality canyon browser preview ran around 60 fps on this desktop; this is not a physical-phone benchmark. Verified plane and checkpoint visuals, flame rendering, all-track gate clearance, stationary brakes, texture sharing, particle cap and airborne/ground rail collisions.

Sandscape image attempts charged 10 coins total, leaving 180 approved coins. The first drafts were unsuitable; final atlas/sign imagery was created with the built-in image-generation tool, then sliced and resized for runtime use. Original images remain in generation folders. Unreferenced audio registry copies re-downloaded by pull were preserved in .sandscape/backups/registry-audio-copies rather than loaded by the game.


September 25: Ridgeback imported-body brake bloom anchors moved onto the rear red lens sections with measured outward/upward offsets and narrower vertical glow sprites (checked rear view with brake held). Ground dust samples terrain.surfaceAt at each wheel emitter and uses the same per-theme surface palette as the terrain shader. Landing/reset bursts use their local terrain palette too. Cloud opacity reduced .78 to .52; clods, boost colors and ember opacity preserved. No additional particle slots, textures, GPU readbacks or draw calls. Firstlight ?dust=1 gives repeatable stationary burst previews.

## September 25 follow-up
Dust terrain palettes project to muted browns (red capped .28), including grass; drift charge no longer recolors wheel dust. Existing cloud transparency and particle budgets preserved.
Rocket wreck spectacle now lasts 2.9 seconds minimum / 4 seconds airborne deadline. Forward compensation capped at 24m with a 28m attacker gap and .55 factor, safe-forward search limited to 8m. Signed checkpoint-relative target prevents backward hit points wrapping toward the next checkpoint.
Pause menu follows generated assets/concepts/pause-menu-benchmark.png: dark steel race-control panel, orange Resume, race context and live frozen backdrop. Native buttons preserve keyboard/touch handling; compact layout for short screens.

## Clean image and stronger rivals
Removed sensor film grain from the final shader, ignoring legacy saved grain preferences. New persisted Contrast slider ranges 90–120%, default108%, neutral100%. Separate display contrast preserves authored stage grading and is reapplied after quality changes. Garage canvas uses the same setting. No extra full-screen shader pass.
Raised generated AI grid skill floor .30→.38 and maximum base .85→.91, consistency base .34→.42. Leading Normal/Hard rivals ease pace less (.98/.99 vs .95/.97). Existing vehicle physics, corner/jump safety limits, easy rubber-band settings and AI update budgets retained. AI driving/route/weapon suite, 55 menu checks and 115 camera checks pass.

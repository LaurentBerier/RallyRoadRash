# Imported Sunstrike Dune Hopper

Source: user-provided `Meshy_AI_Sunstrike_Wasteland_R_0924220938_texture.glb` (original remains unchanged in Downloads).
Runtime: `assets/models/hopper-sunstrike.glb`.

The source has 10,375 triangles, embedded 2048-square color and normal maps and one 4096-square metallic/roughness map. The importer removes 1,135 triangles above the roof at source Y .245 to remove the baked launcher. The existing functional launcher and ammo stay attached to the chassis. Remaining body: 9,240 triangles.

Both Hopper manifest model slots resolve to this single modest-poly body, preventing the old high LOD from replacing it. Existing previous carcass assets remain available for rollback. Body-specific fit uses the existing wheelbase and a .22m sill clearance adjustment. It skips wheel stripping and projected decals because this shell has no wheels and already has its own livery. The garage also avoids adding a second bumper over its authored bumper. Other vehicle fits are unchanged.

Independent wheel spin/steering, suspension, calipers, physics and muzzle logic remain active. Browser garage inspection confirmed loading, fit and a single launcher; 26 tests passed including fit and weapon checks.

Reimport command: `node dev/import-sunstrike.mjs <original-glb-path>`.

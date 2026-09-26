# Ironhide pickup import

Source: Sandscape-generated Ironhide pickup model.
Runtime: `assets/models/ridgeback-ironhide.glb`, selected for both Ridgeback body LOD entries.

The runtime copy keeps 9,933 body triangles and the original 2K albedo/normal and 4K metallic/roughness atlas. `dev/import-ironhide.mjs` removes 1,460 baked roof-launcher triangles above local Y 0.245 so the existing gameplay weapon rig remains separate. No wheel or suspension geometry is baked into this shell. The fit uses the existing Ridgeback axle anchors with 0.28 m body lift; physics is unchanged.

`src/game/vehicle-windshield.js` adds a two-triangle windshield screen with an alpha-cut welded grid texture, fitted to the cab opening. Its materials follow ghost opacity and release their geometry and texture when disposed. The unneeded procedural central roof-light bloom is hidden; the model's livery and authored hardware are preserved.

Validation: all 26 tests pass, including model budgets and fit checks. Browser inspection verified the imported shell, grid, running gear, and separate loaded weapon rack.

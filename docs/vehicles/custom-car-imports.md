# Ridgeback and Redline body imports

Imported 2026-09-25 from the user-supplied Downloads/ridgeBack.glb and Downloads/Redline.glb. Originals are unchanged; runtime copies are assets/models/ridgeback-custom.glb and assets/models/redline-custom.glb.

Ridgeback: 11,830 triangles. Redline: 12,840 triangles. Each retains its authored 4096-square color, normal and packed material textures. Both LOD manifest entries share the supplied model to avoid switching back to the previous body at distance; this prioritizes requested detail over lower texture memory use.

MODEL_FIT contains separate import fits, axle alignment and body-only flags. Wheels, shocks, steering, suspension, and weapon attachments remain on the existing dynamic rig. Baked livery is preserved and duplicate showroom bumper geometry is skipped.

vehicle-windshield.js adds four fitted alpha-cut metal grid panels per car: windshield, both side windows and rear window. These follow the carcass and participate in the ghost material lifecycle and disposal.

Validation: all 26 tests pass, including geometry, fit, LOD, physics and weapons checks. Both vehicles visually inspected in the local model viewer with suspension cycling; new meshes and front/side grids render correctly.

# Hornet dirt bike import

Runtime source: `assets/models/moto-custom.glb`. 10,046 triangles, authored material maps retained. Both manifest LOD entries use this body so it does not revert to the old bike at distance.

The wheel-less body faces -X and is fitted at yaw +90 degrees, scale approximately 1.180, with 0.32 m static body clearance. Live fork, swingarm and shock roots follow measured frame pickup positions. Wheels, steering, springs, lean and gameplay weapons retain the existing dynamic implementation.

The procedural rider is now a separate set of meshes so the body-only import retains a rider. Older bike GLBs which contain a rider hide this separate rider. Procedural number boards are hidden with the old body to avoid covering the authored #41 livery. Cars alone receive window grids.

Verified in the local vehicle viewer, including suspension cycling. All 26 existing tests pass.

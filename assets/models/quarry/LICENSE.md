# Boulder 01

Source: https://polyhaven.com/a/boulder_01

Author: Rico Cilliers.
License: CC0, as stated on the Poly Haven asset page. Downloaded September 22,
2026 through https://api.polyhaven.com/files/boulder_01.

Derived files: `boulder-high.glb`, `boulder-low.glb`, `boulder-mobile.glb`.
The downloaded mesh was welded and simplified with
glTF Transform and MeshoptSimplifier to 4,296 / 1,124 triangles. Source diffuse,
OpenGL normal and packed roughness textures were resized/re-encoded at 2048 /
1024 pixels and embedded in uncompressed glTF binary files. No runtime decoder
or external URL is required. The original scan's UVs and material channels are
retained. Runtime instancing and warm tint adapt the rock to Proving Grounds.
The mobile derivative uses 296 triangles and 512-pixel textures (337,596 bytes).
High/ultra retain the 1,124-triangle derivative for medium and distant rocks;
low/medium load the mobile derivative for all quarry rock instances.

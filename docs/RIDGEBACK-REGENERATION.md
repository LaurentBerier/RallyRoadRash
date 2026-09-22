# Ridgeback regeneration and tire dirt

Sandscape CLI request 9829c9a2e0f98cf8b44b285b10818244 generated a replacement body from the existing concept for 80 coins. Remaining approved budget: 360 coins.

The explicit 100,000-poly / 4K / ultra request was rejected by the backend with zero charge. The standard request returned 6,992 triangles and 2K textures (previous body: 6,754 triangles). It is a cleaner reconstruction with more legible cabin, grille and panel textures, but it is not the requested high-poly/4K output. Both near and distant model files now use the replacement; the wheel cutouts and launcher mount were adjusted to fit. Original generated outputs remain in the CLI staging directory.

Textures were repacked as quality-96 JPEGs without resizing: close model 8.17 MB (down from 15.82 MB), distant model 2.68 MB. Manifest version parameters invalidate cached old truck files.

All four vehicles use shared 512px rubber-and-dirt albedo plus roughness maps, in racing and showroom geometry. White material tint preserves visible tan dirt rather than multiplying it into near-black. The textures are generated once, mipmapped and reused, so there are no added downloads.

Validation: 22 test suites passed, including wheel clearance and all-car tire material checks. Browser inspection confirmed the replacement high LOD and 2048px textures, correct roof rack fit and no warning/error logs.

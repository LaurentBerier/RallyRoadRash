# Vehicle and menu finish pass

- All four showroom vehicles retain close LOD / 2K textures and receive shared dirt and roughness variation on added geometry. Base body meshes are unchanged.
- Metal, suspension, launcher and side-step materials use cached 256px mipmapped, seamless wear textures. Launcher meshes receive UVs for the dirt layer.
- Suspension upper visual pickups sit outboard and below the shell mount; physics geometry is unchanged. Side steps are horizontal and supported.
- Stage maps resize with their panel, preserve track proportions, and use theme-colored terrain fill, a survey grid and route casing.
- Stage selection uses the selected stage art as a full-screen background. Vehicle selection and other sheet menus use the generated industrial garage backdrop, decoded by the existing boot loader. WebP size: 253,402 bytes.
- Verified all four close LODs in the inspection harness, stage and garage desktop layouts, mobile stage scrolling, and a 706 x 563 map at the reported large viewport.
- Validation: 22 test suites passed; no browser warnings/errors in the inspection harness.

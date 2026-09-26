# Vehicle surface refinement

The vehicle materials separate physical clearcoat paint, metallic trim, and glass, with environment lighting and independent rotating wheels. The renderer uses ACES tone mapping, workshop HDR/PMREM and physical materials. This pass builds on those systems rather than replacing the current weathered art or vehicle rig.

- Carcass shader adds metre-scaled, derivative-filtered micro relief over authored normals. Frequencies fade before becoming subpixel to reduce shimmer. Existing decals, mud and ghost effects remain composed with it.
- Selective body clearcoat increased from .32 to .55; the garage no longer replaces it with .1 or reduces authored normal strength.
- Shared mechanical wear maps increase from 1024 to 2048 pixels with finer machining scratches and a subtle relief channel. The existing GLB atlases are preserved, not artificially upscaled. Two 2K RGBA maps cost roughly 43 MiB including mipmaps, shared across vehicles.
- Race tyres use 48 radial segments instead of 32. Merged wheel geometry adds hex nuts and rotor grooves, with smoother hubs and sharper metal response. It adds no extra per-wheel draw calls.
- Static shells, independent wheels, spin-cancelled calipers, suspension travel, weapon mounts and physics retain their existing ownership and logic.
- Geometry check estimates ~136k triangles under a new 150k vehicle allowance (documented total visible-scene budget 450k). This estimate does not replace a full-scene GPU performance measurement.

Validation: 26 automated checks pass, including physics, geometry, LOD fallback and garage disposal. Browser garage inspection confirmed all four high LODs, HDR and 2K body maps with no shader errors. This pass refines surface and running-gear detail; it does not regenerate the underlying static carcass meshes.

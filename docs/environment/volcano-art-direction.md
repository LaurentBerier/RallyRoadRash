# Caldera Run — volcanic environment pass

Generated benchmark: `volcano-benchmark.png`. Built-in OpenAI image generation, using the user's Caldera Run screenshot as a reference. This is an art-direction target, not gameplay. No Sandscape coin generation used.

## Prompt

Create a AAA real-time racing environment benchmark using the attached Caldera Run screenshot as composition reference. Preserve the rear chase camera, battered armed pickup in foreground, wide driveable volcanic gravel road climbing toward a jump gantry, open caldera landscape. Transform smooth orange hills into physically convincing charcoal basalt escarpments, fractured columnar outcrops, jagged lava ridges, ash fans and collapsed volcanic cliffs with layered distant crater walls. Ground the foreground in sharp cinders and cooled lava plates, dark gray materials with restrained rusty mineral staining, readable compacted driving line. Localized molten orange lava in off-road fissures and vent mouths, never a glowing road. Atmospheric volcanic dusk: warm low sun on ridge edges, cool ash-blue shadows with readable truck and road, drifting soft smoke from a few vents, layered distant haze. Natural weathered rock formations, coherent geological scale and silhouettes, subtle warm bounce near lava. No HUD. Wide landscape 16:9. Aim for a realistic detailed achievable 3D game environment, not surreal fantasy.

## Implementation and validation

Real volumetric basalt column groups and distant fluted buttresses, sharper outer ridges, scanned rock crags, darker volcanic ground, cooler ambient light, reduced distance haze, and lava with more cooled crust. Jump-sign legs fit both shoulders; banked checkpoint signs fit the ground. Rock scans use their actual lower mesh footprint for seating. Existing race route and lava hazard placement retained.

Reviewed 14 driving-camera positions around the 2,000 m course, plus Low quality at Caldera Leap. All 25 test groups pass, including actual baked-terrain foundation and course-clearance checks for the new volcanic geology. The game remains a procedural browser renderer; the generated benchmark guides the pass and is not a claim of photorealistic parity. Desktop checks do not establish mobile frame rates.

# Caldera Run — second benchmark and detail pass

Generated target: `volcano-benchmark-v2.png`, built-in OpenAI image generation using the user's latest Caldera Run screenshot. No Sandscape coin generation used. See `volcano-v2-review.html` for the target, actual before/after views and 14 positions around the course.

## Generation prompt

Using attached Caldera Run screenshot as exact composition reference, create the next AAA realistic volcanic racing game environment benchmark. Rear view of battered armed sports buggy on broad ash gravel road approaching small CHECK gantry, sunset over caldera. Replace the smooth snowy-looking background slopes and isolated upright columns with dense coherent dark basalt escarpments, crumbling outcrops embedded in slopes, irregular fractured cliffs, angular talus fans and layered rugged crater rim. No floating stones. Road: realistic compacted charcoal ash, mixed crushed gravel, worn wheel paths, shallow erosion grooves, scattered loose aggregate concentrated on shoulders; preserve clear racing corridor. Add convincing atmospheric VFX: soft drifting ground steam in low pockets, localized volcanic smoke, windblown ash and a few glowing embers, narrow molten cracks with orange bounce among black cooled crust away from the road. Warm sunset edge light, cool but dark gray readable shadows, atmospheric depth without whitewashing mountains. Grounded geological scale, physically based materials, richer fine and middle-distance detail. No HUD. Wide landscape. This is a believable achievable 3D racing environment art target, not fantasy.

## Analysis and implementation

The target's strongest cues are connected, fractured rock masses instead of isolated pillars; dark material continuity from nearby rubble into distant slopes; gravel concentrated on shoulders with visible wheel wear; and localized steam with sparse airborne ash.

Implemented stepped relief outside the racing corridor, angular basalt clusters and talus groups with sampled terrain foundations and course clearance, terrain-conforming distant buttresses, broader scanned rock coverage and longer material detail range. Reduced freestanding pillars in favor of rocks. Added gravel closer to outer road edges and fine rut shading.

Added GPU-animated soft steam at 42 off-road vent sites and drifting ash with sparse ember colors. High uses 168 steam instances and 700 particles; Low uses 58 and 180. Shared animation time updates through the normal props loop; effects dispose with the environment.

## Validation and limits

Reviewed all 14 course positions and High/Low rendering. The automated environment checks cover finite VFX geometry, transparent depth behavior, quality scaling, terrain foundations and course clearance. This remains a procedural browser game; the generated image is a direction, not a claim of matching photorealism. The race route, jumps and lava hazards remain gameplay features rather than being placed from the generated image.

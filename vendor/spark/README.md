# Spark 0.1.10

Vendored from @sparkjsdev/spark 0.1.10 (npm), MIT license in LICENSE. Embedded decoder/worker assets remain self-contained. https://github.com/sparkjsdev/spark

Compatibility with the game's Three.js r160: the namespace import uses three-compat.js, which re-exports the existing engine and the official MIT-licensed Matrix2 from Three.js r174. garage-splat.js declares sampler3D precision and adapts the existing synchronous pixel-read method to the Promise signature Spark expects. No global engine replacement or CDN dependencies.

Renderer cleanup explicitly releases viewpoints, accumulators and materials because this Spark version has no public renderer dispose method.

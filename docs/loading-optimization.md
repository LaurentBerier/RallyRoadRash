# First-run loading pass

- Main menu image payload: 32.28 MB / 46 unique files before, 2.12 MB / 13 after (93.4% less). Menu waits only for menu/card artwork. Stage textures load with the track bake, excluding unrelated stage panoramas and forest terrain on non-forest tracks.
- Image aliases share a single decoded texture; bounded six-worker queue avoids unbounded simultaneous image requests. Concurrent ensure requests share in-flight work; failures retain procedural fallbacks.
- Four authored vehicle GLBs plus rider: 155.1 MB to 66.2 MB (57.3% less). Embedded opaque images repacked as high-quality JPEG, original image dimensions, geometry, UVs and material parameters retained. Original GLBs retained locally; manifest selects new -stream files. Normal images use quality96, other images92, all without chroma subsampling. See loading-optimization.json for exact bytes and dev/compress-vehicle-textures.py for reproducibility.
- Garage preloads two models concurrently, still awaits fleet and environment before reveal. Existing desktop splat preserved and mobile fallback unchanged.
- Music loads menu first; chosen stage soundtrack preloads alongside terrain. Other stage soundtracks are not fetched/decoded until needed. Existing volume and mixing unchanged.
- Proving Grounds now uses3laps. Existing one-lap best total archived as legacyBestTotal; medals, unlocks and fastest lap preserved. Three-lap total starts a new comparable record.

Validation: complete automated suite; browser menu→garage→Proving Grounds with three-lap HUD, decoded compressed meshes and no runtime errors. Byte reductions are measured file payloads, not a claimed percentage improvement in wall-clock load time; network, splat decode and terrain bake still affect first race loading.

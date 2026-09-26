# Gritty death race garage

The garage inspection viewport uses the existing Sandscape `gritty_death_race_garage_world` asset (f748cd73-5d24-4362-9cac-6a983cfeb6d6), not the earlier rusty garage asset. Downloaded from the project's world files; no new generation.

Runtime: assets/worlds/gritty-death-race-garage.spz, 1,920,000 Gaussian splats (29.4 MB). Matching panorama supplies reflections and background coverage. The world rotates 180 degrees about X to convert its downward Y convention, scales 2.5 times, and raises 1.58 metres to align the floor with the parked vehicle pad. Vehicle meshes, controls, suspension and physics are unchanged.

Spark 0.1.10 is vendored locally with its embedded decoder and worker. See vendor/spark/README.md for the small r160 compatibility adapter. It loads only when the garage viewport is created. The original procedural room is retained only as a download/decoder failure fallback; world downloads time out after 30 seconds. Explicit resource cleanup supports rebuilding the viewport.

Validation: 26 tests pass. Browser inspection confirmed actual splat rendering, correctly placed Hopper and Ridgeback, vehicle switching, and viewport rebuild. The full-detail world is heavier than the old room and can cost more GPU memory and orbiting performance on lower-end devices.

## Full-screen and mobile inspection

The garage now fills the screen behind compact edge panels. Orbit distance is
limited to 3.4–10.5 m, with a 8.2 m horizontal boundary and a 0.5–6 m camera
height range. Portrait framing widens the field of view and starts at the outer
inspection distance. Landscape phones use compact vehicle selection buttons.

Coarse-pointer and mobile user-agent devices use the batched basic 3D room.
They do not request the splat, its panorama, or the Spark renderer. Their garage
renders at up to 30 FPS, 900k pixels, DPR 1.25 and 512px shadows, without the extra
showroom tyre geometry. Race rendering also caps mobile DPR at 1.5 and the frame
buffer at 1.4 million pixels; the existing frame governor can reduce it further.
`dev/garage-preview.html?mobile=1` exercises this environment path on desktop.

The parked vehicle root is adjusted after suspension and showroom detail updates
so the lowest wheel bounds sit 2.5 cm above the nominal floor. This adjustment
is confined to the garage; terrain-contact physics are unchanged. Ridgeback's
launcher sits rearward and higher with four support legs and mounting feet.
Touch controls keep FIRE/DRIFT in the driving cluster and place RESET/PAUSE at
the top right; the touch camera-cycle button is removed.

Validated with the 27-suite test run, all four parked wheel-grounding checks,
desktop/mobile-size layout checks, basic-room loading and browser console checks.
Physical-phone FPS and thermal performance have not been measured.


## Expanded room and preload gate

Both garage environments are scaled to 135% around the floor origin. Camera
reset distance now follows vehicle length (1.8x in landscape, 2x in portrait),
with a 6.6 m minimum default. The outer orbit limit is 10.5 m.

Garage entry keeps the loading artwork over the UI while the four vehicle
models and their material images decode, the room/reflections initialize, and
the selected vehicle renders its first ready frames. Desktop also pre-uploads
fleet textures; mobile avoids uploading unselected vehicles to conserve GPU
memory. Menus are inert during the gate. Asset timeouts retain the existing
basic/procedural fallback. Normal model caching avoids repeat downloads.

Menu music: menu-desert-country.mp3, generated 90-second instrumental desert
country brief (fingerpicked guitar, baritone twang, muted bass, sparse brushes).
160 kbps MP3, gentle boundary fades, original menu track retained locally under
.sandscape/backups. Sandscape generation cost: 15 coins, 345 remaining.

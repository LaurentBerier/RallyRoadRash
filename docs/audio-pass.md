# Mechanical sound pass — 2026-09-25

Menu: 90-second generated acoustic Rustbucket Stomp, prompted at 148 BPM with rusty resonator guitar, fast banjo, slap bass, boot stomps and washboard. Runtime file: assets/music/menu-rustbucket-stomp.mp3.

UI: hover, selection, confirmation, back, reject and warning use trimmed mechanical recordings (59–211 ms). Diesel toggles, ignition relays, compression coughs and ratchets replace electronic UI tones. Short fades prevent hard cutoffs; per-cue cooldowns prevent pointer chatter.

Vehicles: four looped recordings layered quietly under responsive RPM synthesis: buggy rasp, pickup diesel chug, race-car intake/exhaust rasp and single-cylinder dirtbike bark. Each follows engine family, RPM, load and airborne state. Existing road-surface, skid, wind and tyre simulation remains active. Rival synthesis now follows rival vehicle identity and distance.

Race moments: revised horn countdown/go/final-lap cues, pit bell checkpoints/laps, mechanical pickup and position cues, pressure-valve boost, gearbox shift and suspension impact recordings. Existing explosions, weapons, crashes, scrapes and crowd recordings retain their content with new gain, duration and repetition limits. Finish/unlock/reset/wrong-way/boost cues prefer natural samples over additional synth jingles.

Playback: maximum 16 one-shot voices, explicitly stop stolen sources, 12 ms ending fade, per-cue gain and duration profiles. Engine layers build once and mute with driving bus. Missing samples preserve procedural fallback.

Validation: npm test 28/28; manifest/disk agreement for 6 music tracks, 31 SFX and 4 engines. Browser WebAudio context running; all 31 SFX and four engines decoded, all cue paths and all vehicle engine updates exercised. Automated verification does not replace subjective listening on phone speakers/headphones.

Generation charged 155 coins this pass (one music job and 14 SFX jobs). Recorded approved budget: 900 total, 710 spent, 190 remaining. Original audio backed up under .sandscape/backups/audio-pass. Trim measurements: docs/audio-pass-measurements.json.


## Audio and driving-camera direction (v75)

The runtime uses this game's own engine and effects recordings. Audio balance analysis is documented in `audio-reference-analysis.json`.

Direction: the player's engine is the continuous foreground anchor. Preserve clear throttle-on, lift-off, upshift torque interruption, downshift and unloaded airborne states. Distinguish buggy rasp, pickup diesel body, turbo race-car intake and motocross single-cylinder bark. Support these with brief suspension, tyre, gravel and panel transients. Rocket pass-bys and explosions remain emphatic one-shot events; routine race notifications and wind must not mask driving feedback. Keep the existing gameplay music settings, levels and ducking unchanged.

Measured full-mix energy in 8-second windows: 44–58% at 80–400 Hz, 36–48% at 400–2000 Hz, and 2–4% at 2–6 kHz. Crest factors are 12–14 dB. Commentary can influence these measurements; they describe the mixed recording rather than an isolated engine. Its approximately -25 dBFS RMS is a capture level, not a target for game volume. Use the relative body/detail balance as guidance and retain transient headroom.

v75 implementation: family-specific low-shelf body, gentler presence emphasis and less open high-frequency filtering. Gear changes now come from actual vehicle gear telemetry rather than relying on a large inferred RPM drop; the recordings and synthesis share the clutch envelope. Airborne whoosh is quieter so engine revs and touchdown remain the cues.

Camera observations from 0–44 s: vehicle stays central, horizon remains level as the body rolls, and vehicle screen size is fairly stable across straights, bumps and turns. The source is portrait-cropped, so do not copy its apparent field of view literally. Use a 6.8 m resting chase boom, 10% speed extension, 10% airborne extension, 7-degree speed FOV expansion and 2.5-degree airborne expansion. Reduce lateral look-ahead, keep suspension movement visible, and preserve established crash/landing recovery. No camera changes to garage or hood view.

Checks: use the engine audition page for idle/acceleration/upshift/coast renders, camera tests at 30/60/120 Hz for continuity and terrain clearance, and `firstlight.html?chase=1` for the real chase rig in the track harness. Waveform/spectrum and rendered-level checks do not constitute subjective listening approval.


## Classic countdown revision — September 25
Replaced the short horn recordings with deterministically synthesized start-light tones: three identical 660 Hz / 180 ms beeps, then 1320 Hz / 460 ms GO. Five-millisecond eased attacks, soft releases and restrained harmonics avoid clicks and buzzer rasp. The shipped MP3s and immediate in-memory fallback share `countdown-tone.js`; the renderer is `dev/render-countdown.mjs`. Countdown alone bypasses sample pitch jitter. Its gain is .54 × .8 for counts and .64 × .9 for GO; music and engine levels are unchanged. Timing remains tied to the existing 3/2/1/GO race state transitions. No paid generation or coins used. Original recordings are backed up under `.sandscape/countdown/`.


## Per-vehicle landings — September 25
Four new Sandscape Foley recordings: Hopper (tubular chassis/spring clack), Ridgeback (heavy tire slam and pickup-bed rattle), Redline (tight suspension/underbody strike), Hornet (knobby tire/fork/chain impact). Source jobs: ffbdb3a9062ff35502c9136af817a1ca, 9955bf1faf486a2cbb1c1528bfee18ec, b67283d053a1b67135a609c9f7eba55e, 9c45496eab4c589302b3bc00ac1ddafd. Removed 31–81 ms of initial silence, normalized to -3 dBFS peak and faded short mono tails. Hornet has gentle saturation to give its small impact sufficient body. Runtime buffers total under four seconds, use the existing bounded voice pool, and retain the older generic/procedural fallback. Generation cost 40 coins, 60 remaining approved.

Touchdowns now use the last airborne descent speed as well as suspension bump-stop impact, with a 120 ms air gate to reject rut chatter. Player gain floor prevents cushioned landings being inaudible. Each vehicle uses its own sample, and rivals have a separate cooldown key so they cannot swallow the player's landing. Existing music and engine settings are retained.

## September 25: metal contact and pickup polish
- Added generated Metal Suspension Impact A/B, layered with vehicle-specific landings and collisions. Avoid immediate repeats, vary gain and pitch slightly, pitch Ridgeback lowest. All clips mono, onset trimmed, short, -3 dBFS peak.
- Replaced nitro pickup with a canister latch / pressure intake / low mechanical charge, raised its SFX presence; gameplay music settings unchanged.
- Countdown throttle now free-revs each vehicle engine while brake and clutch keep the grid stationary.
- Three generations cost 30 coins. Cumulative budget 870/900, 30 remaining.

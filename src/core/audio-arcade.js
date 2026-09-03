/* ============================================================
   ARCADE-LAYER SOUNDS — mini-turbo, tricks, boost pads, the spin
   ------------------------------------------------------------
   These are Audio methods that happen to live in another file. Each takes
   the Audio instance as `A` and uses its private synthesis kit exactly as
   the built-in cues do; audio.js carries one-line delegates so every call
   site still reads `this.audio.boostFire(2)`.

   Why split at all: audio.js is already past 1300 lines against a ~1400
   house limit. Splitting by FEATURE rather than by size keeps both files
   readable — audio.js stays "the car and the race", this file is "the
   handling flourishes". The rocket and pickup cues are NOT here: those are
   the weapon layer and live with the sample bank (contract 8.7), with a
   synth fallback each behind them.

   This file replaced core/audio-items.js in wave 8. Everything the old file
   exported that was a power-up cue — the roulette, the throw, the drop, the
   tow, the sled, the storm — went with the power-ups. What survived is the
   strict subset below, unchanged, so the import swap in audio.js is one
   line.

   THE SHARED SURFACE. This file uses `A.ready`, `A.now()`, `A._note`,
   `A._burst`, `A.busSfx` and `A.verb`. Those were private by convention and
   are a documented contract between two files. Everything below obeys the
   same three house rules as the rest of audio.js: bail if not ready,
   schedule against one `t`, and never use setTimeout — a future `when` is
   how sounds are spread in time, because an offline render cannot see a
   timer.

   Levels follow the existing bands: UI ticks ~0.045, race cues 0.07–0.12,
   crash body 0.34. Nothing here may mask the engine.
   ============================================================ */

/* D minor / D major, like everything else in the game — the mini-turbo chimes
   have to sit on top of the music rather than beside it. Tier 1/2/3 are the
   3rd, 5th and octave of the race chord, so climbing a tier is audibly a
   climb rather than three unrelated bleeps. */
const TIER_HZ = [698.46, 880.0, 1174.66];

/** A tier gained. Short, bright, and it happens mid-corner — keep it out of
    the way of the engine, which is loudest exactly then. */
export function boostTier(A, tier) {
  if (!A.ready) return;
  const i = tier < 1 ? 0 : tier > 3 ? 2 : tier - 1;
  const t = A.now();
  const g = A._note(A.busSfx, TIER_HZ[i], t, 0.22 + i * 0.04, 0.052 + i * 0.010, 'triangle', 0);
  g.connect(A.verb);
  // A whisper of noise on top so it reads as a mechanical charge rather than
  // a menu bleep. Rises with the tier.
  A._burst(t, 0.10, 'bandpass', 2600 + i * 900, 5200 + i * 1400, 2.4, 0.020 + i * 0.006, 0, A.busSfx);
}

/**
 * The boost firing. This is the payoff sound in the whole feature, so it gets
 * three layers: a noise whoosh that sweeps up (the release), a sawtooth stab
 * (the shove) and a low thump (the weight). Scaled by tier so a tier 3 is
 * unmistakably bigger than a tier 1 rather than just louder.
 *
 * @param gain 0..1 — race.js passes 1 for the player and much less for a
 *             rival, distance-gated, the same way crash() is handled.
 */
export function boostFire(A, tier, gain = 1) {
  if (!A.ready) return;
  const i = tier < 1 ? 0 : tier > 3 ? 2 : tier - 1;
  const t = A.now();
  const k = (0.62 + 0.19 * i) * gain;

  // release whoosh — sweeps UP, which is what makes it read as acceleration
  A._burst(t, 0.34 + i * 0.10, 'bandpass', 340, 3000 + i * 900, 1.5, 0.105 * k, 0, A.busSfx);
  // the shove: a short saw stab a fifth below the tier chime
  const g = A._note(A.busSfx, TIER_HZ[i] * 0.5, t, 0.26 + i * 0.06, 0.075 * k, 'sawtooth', -8);
  g.connect(A.verb);
  // weight underneath — the thing that stops it sounding like a UI sound
  A._note(A.busSfx, 73.42, t, 0.30, 0.115 * k, 'triangle', 0);
  if (i >= 1) A._note(A.busSfx, 110.0, t + 0.02, 0.22, 0.06 * k, 'sine', 0);
}

/* ============================================================
   TRICKS
   ------------------------------------------------------------
   A landed trick already fires boostFire() through the mini-turbo path, so
   these sit ON TOP of that rather than replacing it, and they have to earn
   their place next to it: the trick cue is the ARRIVAL — the moment the
   wheels take the weight — and the boost is the shove that follows. Keep
   them short and keep them high, or the two smear into one noise.
   ============================================================ */

/**
 * A trick landed cleanly. An ascending three-note figure off the tier chime,
 * so a combo is audibly further up the same scale a mini-turbo climbs —
 * the air and the drift pay into one pot and they should sound like it.
 *
 * @param tier 1..3 from tricks.js. Tier 0 (BIG AIR) still gets the smallest
 *             version: it scored, so it must make a sound.
 */
export function trickLand(A, tier) {
  if (!A.ready) return;
  const i = tier < 1 ? 0 : tier > 3 ? 2 : tier - 1;
  const t = A.now();
  const root = TIER_HZ[i];
  // 1 – 5th – octave, 45 ms apart: fast enough to read as one gesture.
  const g = A._note(A.busSfx, root, t, 0.20, 0.055 + i * 0.012, 'triangle', 0);
  g.connect(A.verb);
  A._note(A.busSfx, root * 1.5, t + 0.045, 0.20, 0.048 + i * 0.010, 'triangle', 0);
  const g3 = A._note(A.busSfx, root * 2, t + 0.090, 0.34, 0.052 + i * 0.014, 'sine', 0);
  g3.connect(A.verb);
  // the touchdown itself, under the figure — this is the only low content
  A._note(A.busSfx, 110.0, t, 0.16, 0.055 + i * 0.015, 'triangle', 0);
  if (i >= 2) A._burst(t, 0.30, 'highpass', 3200, 6800, 1.6, 0.035, 0, A.busSfx);
}

/** A trick that arrived instead of landing. Down, dull, and over quickly —
    it must read as the OPPOSITE of trickLand, not as a smaller version. */
export function trickCrash(A) {
  if (!A.ready) return;
  const t = A.now();
  A._burst(t, 0.34, 'lowpass', 1800, 240, 1.0, 0.135, 0, A.busSfx);
  A._note(A.busSfx, 98.0, t, 0.28, 0.095, 'sawtooth', -14);
  A._note(A.busSfx, 65.41, t + 0.03, 0.34, 0.075, 'triangle', 0);
}

/**
 * Crossing a boost pad. The most repeated cue in the arcade layer — you take
 * a dozen a lap — so it is the shortest and the quietest thing in this file.
 * A pad is punctuation, not an event.
 *
 * @param gain 0..1, distance-gated by the caller like every rival cue.
 */
export function padHit(A, gain = 1) {
  if (!A.ready) return;
  const t = A.now();
  A._burst(t, 0.14, 'bandpass', 1400, 4200, 2.0, 0.055 * gain, 0, A.busSfx);
  A._note(A.busSfx, 1174.66, t, 0.10, 0.030 * gain, 'square', 0);
  A._note(A.busSfx, 146.83, t, 0.12, 0.040 * gain, 'triangle', 0);
}

/**
 * A car spun. Down-sweep plus a tyre bark — it must read as LOSS. Kept from
 * the item layer because a rocket's direct hit still routes through
 * Vehicle.spinT, and the bang (rocketHit, contract 8.7) is the explosion,
 * not the car: this is the car.
 */
export function spinOut(A, gain = 1) {
  if (!A.ready) return;
  const t = A.now();
  A._burst(t, 0.42, 'bandpass', 2400, 300, 2.2, 0.16 * gain, 0, A.busSfx);
  A._note(A.busSfx, 110.0, t, 0.34, 0.085 * gain, 'sawtooth', 0);
  A._note(A.busSfx, 73.42, t + 0.04, 0.26, 0.06 * gain, 'triangle', 0);
}

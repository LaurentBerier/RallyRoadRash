/* ============================================================
   ARSENAL-LAYER SOUNDS — rockets, ammo, nitro (contract 8.7)
   ------------------------------------------------------------
   Bodies live here so audio.js stays under the house line — the same
   move P3 already made for audio-arcade.js, split by FEATURE rather than
   by size: audio.js is "the car and the race", audio-arcade.js is "the
   handling flourishes", this is "the weapon layer". Each function takes
   the Audio instance as `A` and uses its private synthesis kit exactly
   as the built-in cues do; audio.js carries one-line delegates so every
   call site still reads `this.audio.rocketFire(1, 0)`.

   Every cue here is sample-first: `A._sfx.play(name, opts)` from
   core/sfx.js runs before any of the synth code below, and returns early
   when a sample actually played. arsenal.js (P3) already calls all eight
   of these guarded (`if (A.rocketFire) …`), so they must be safe to call
   with no context and no samples loaded — same as every cue in audio.js.

   THE SHARED SURFACE. This file uses `A.ready`, `A.now()`, `A._note`,
   `A._burst`, `A._grain`, `A._sfx`, `A.busSfx` and `A.verb` — the same
   documented contract audio-arcade.js already established. Bail if not
   ready, schedule against one `t`, never use setTimeout.
   ============================================================ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** The tube fires: a compressed-air chuff, the tube's own metal ring,
    then the motor catching as the rocket clears the muzzle. */
export function rocketFire(A, gain = 1, pan = 0) {
  if (!A.ready) return;
  if (A._sfx.play('rocketFire', { gain: gain * 0.9, pan })) return;
  const t = A.now(), g = clamp(gain, 0, 1.5), pn = clamp(pan, -1, 1);
  A._burst(t, 0.10, 'highpass', 900, 2600, 1.6, 0.11 * g, pn, A.busSfx);
  A._note(A.busSfx, 130, t, 0.14, 0.10 * g, 'square', 0);
  A._burst(t + 0.03, 0.22, 'bandpass', 500, 1800, 1.2, 0.09 * g, pn, A.busSfx);
}

/** A rocket passes close by without hitting anything — a doppler whoosh
    and nothing else. Distance and direction are arsenal.js's job (it
    already computes `pan` from the flyby geometry); this is just the
    sound of the pass. */
export function rocketFlyby(A, pan = 0) {
  if (!A.ready) return;
  if (A._sfx.play('rocketFlyby', { gain: 1.15, pan })) return;
  const t = A.now(), pn = clamp(pan, -1, 1);
  A._burst(t, 0.30, 'bandpass', 2600, 700, 1.4, 0.075, pn, A.busSfx);
  A._burst(t + 0.02, 0.24, 'bandpass', 3200, 900, 1.2, 0.05, pn * 0.7, A.busSfx);
}

/** A hit lands — on the player, a rival, or a crate. `near` swaps the
    close crack-and-boom for the muffled distant version; `gain` is the
    same distance/ownership gate `crash()` already uses. */
export function rocketHit(A, gain = 1, pan = 0, near = true) {
  if (!A.ready) return;
  A.duckRace?.(.12,.65);
  if (A._sfx.play(near ? 'explodeNear' : 'explodeFar', { gain: gain * 1.2, pan })) { A.thud(Math.min(gain,1.2)*(near?.85:.35));return; }
  const t = A.now(), g = clamp(gain, 0, 1.5), pn = clamp(pan, -1, 1);
  A._burst(t, near ? 0.10 : 0.20, 'bandpass', near ? 2400 : 700, near ? 900 : 300, 1.6,
    (near ? 0.16 : 0.09) * g, pn, A.busSfx);
  A._note(A.busSfx, near ? 70 : 46, t, near ? 0.30 : 0.45, (near ? 0.22 : 0.14) * g, 'sine', 0);
  A._burst(t + 0.02, near ? 0.34 : 0.55, 'lowpass', near ? 500 : 220, near ? 160 : 90, 0.9,
    (near ? 0.17 : 0.10) * g, pn, A.busSfx);
  if (near) {
    for (let i = 0; i < 5; i++) {
      A._grain(true, t + 0.02 + i * 0.03 + Math.random() * 0.04, 0.06 * g * (0.4 + Math.random()),
        900 + Math.random() * 3200, 3 + Math.random() * 6, 0.03 + Math.random() * 0.05,
        0.8 + Math.random(), clamp(pn + (Math.random() - 0.5), -1, 1));
    }
  }
}

/** A rocket crate picked up. */
export function ammoPickup(A) {
  if (!A.ready) return;
  if (A._sfx.play('ammoPickup', { gain: 0.7 })) return;
  const t = A.now();
  A._note(A.busSfx, 987.77, t, 0.10, 0.075, 'square', 0);
  const g = A._note(A.busSfx, 1479.98, t + 0.06, 0.16, 0.06, 'triangle', 0);
  g.connect(A.verb);
}

/** A nitro can picked up. */
export function nitroPickup(A) {
  if (!A.ready) return;
  if (A._sfx.play('nitroPickup', { gain: 1.0, rate: .94 })) { A.thud(.30); return; }
  const t = A.now();
  A._burst(t, 0.12, 'highpass', 2200, 4200, 1.8, 0.045, 0, A.busSfx);
  const g = A._note(A.busSfx, 1318.51, t + 0.02, 0.18, 0.055, 'triangle', 0);
  g.connect(A.verb);
}

/** The can burns off — same weight class as a mini-turbo fire, but a
    pressurised gas whoosh instead of a mechanical shove. */
export function nitroBurst(A) {
  if (!A.ready) return;
  if (A._sfx.play('nitroBurst', { gain: 0.9 })) return;
  const t = A.now();
  A._burst(t, 0.36, 'bandpass', 500, 3400, 1.3, 0.11, 0, A.busSfx);
  A._note(A.busSfx, 92.5, t, 0.28, 0.10, 'triangle', 0);
}

/** Trigger pulled, tube empty. */
export function ammoEmpty(A) {
  if (!A.ready) return;
  if (A._sfx.play('ammoEmpty', { gain: 0.55 })) return;
  const t = A.now();
  A._burst(t, 0.04, 'highpass', 1800, 900, 3, 0.05, 0, A.busSfx);
  A._note(A.busSfx, 340, t, 0.03, 0.035, 'square', 0);
}

/** A rocket crate splinters instead of surviving the hit. */
export function crateBreak(A, gain = 1) {
  if (!A.ready) return;
  if (A._sfx.play('crateBreak', { gain: gain * 0.8 })) return;
  const t = A.now(), g = clamp(gain, 0, 1.5);
  A._burst(t, 0.14, 'bandpass', 900, 2600, 1.4, 0.11 * g, 0, A.busSfx);
  for (let i = 0; i < 4; i++) {
    A._grain(true, t + 0.01 + i * 0.02 + Math.random() * 0.02, 0.05 * g * (0.5 + Math.random()),
      700 + Math.random() * 2200, 3 + Math.random() * 5, 0.025 + Math.random() * 0.04,
      0.7 + Math.random() * 0.8, (Math.random() * 2 - 1) * 0.6);
  }
}

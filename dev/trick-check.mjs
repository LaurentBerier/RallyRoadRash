/* ============================================================
   RALLY ROAD RASH — air control and tricks
   ------------------------------------------------------------
       node --experimental-loader ./dev/loader.mjs dev/trick-check.mjs

   STUB. src/game/tricks.js does not exist yet; the air-control package
   (P4) writes it and replaces this file wholesale. It is registered in
   tests/all.test.mjs from day one on purpose: a check that appears in the
   suite the moment its module lands is a check somebody actually runs,
   and one bolted on afterwards is a check somebody argues about.

   What lands here, per the wave-6 contract in docs/ARCHITECTURE.md:

     A. Pure classification. Scripted quaternion sequences in, trick ids
        out — flips, spins, barrel rolls, the hop window, the combo
        multiplier, the fixed state shape, and that trickReset() clears
        the flight while trickClear() clears the totals.

     B. Integration on a real Vehicle, over a copy of vehicle-check's
        kicker mock. No-input flights at 24..36 m/s must land upright;
        0.9 s of held throttle must be a BACKFLIP that lands on its
        wheels and fires tier 2; handbrake plus full steer must be a
        BARREL; throttle held for the whole flight must crash without
        ever producing a NaN; and the AI's canned sequence must land
        upright at least nine times in ten.

   Until then this exits 0 and says so, which keeps `npm test` honest
   about what it is and is not covering.
   ============================================================ */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'src', 'game', 'tricks.js');

if (existsSync(MODULE)) {
  /* A tricks.js with no checks behind it is worse than no tricks.js: the
     suite would go green over an untested scoring system. Fail loudly so
     whoever lands the module lands its gates in the same change. */
  console.error('trick-check: src/game/tricks.js exists but dev/trick-check.mjs is '
    + 'still the stub. Write the real checks (see the header) before shipping.');
  process.exit(1);
}

console.log('trick-check: stub — src/game/tricks.js not written yet, 0 checks run');

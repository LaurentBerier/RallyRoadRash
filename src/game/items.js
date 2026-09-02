/* ============================================================
   POWER-UPS — the table, the roulette, and the rubber band
   ------------------------------------------------------------
   PURE. No three, no DOM, no audio, no imports at all — so
   dev/items-check.mjs can hammer a hundred thousand rolls under bare Node
   and a balance change is a data change. The live half (boxes, projectiles,
   effects, meshes) is src/game/itemworld.js.

   THE NAMES ARE OURS. The behaviours here are the kart-racer canon — a
   bouncing projectile, a dropped hazard, a speed pickup, a comeback rocket —
   but a rally game already has its own vocabulary for all of them, and
   borrowing somebody else's names and shapes would be both lazy and
   somebody else's trademark. A spare wheel bounding down a canyon is a
   better joke than a shell anyway.

   HOW THE RUBBER BAND ACTUALLY WORKS, in three parts
   --------------------------------------------------
   1. THE TABLE. One weight row per finishing position. The leader's row
      contains nothing but defence: 60 % oil, 28 % spare wheel, 12 % nitro —
      every one of which is either dropped behind or is the weakest offensive
      item in the set. P1 can hold a place. P1 cannot extend a gap. That
      asymmetry is the entire mechanism by which a lead evaporates.
   2. THE GATES. Weights alone misbehave at the edges, so the two big
      comeback items also carry hard conditions (see GATES below). A rocket
      sled fired through the finish line reads as a bug, not a comeback.
   3. THE GAP SHIFT. Position alone stops meaning anything once the field
      spreads out — on a three-lap stage, fourth place forty seconds adrift
      is in far more trouble than fourth place two seconds adrift, and the
      table cannot see the difference. `gapShift` rolls a badly-adrift racer
      one row further back. It is what stops the band quietly switching
      itself off in the second half of a race, which is exactly when it is
      supposed to be doing its job.

   The table is tuned for the "kart-classic: strong" setting the design asked
   for. If it ever needs softening, move the SLED and STORM weights first —
   they are the two items a player actually resents losing to.
   ============================================================ */

export const ITEM = {
  NONE: -1,
  NITRO: 0,
  TRIPLE: 1,
  WHEEL: 2,
  SLICK: 3,
  TOW: 4,
  SLED: 5,
  STORM: 6,
};

/* Every parameter an item has. itemworld.js reads these and nothing else, so
   a designer can retune the whole roster without opening a file that imports
   three.js.

     kind      how itemworld dispatches it
     charges   how many uses one pickup grants
     aimable   true if the fire direction (forward / behind) matters
     hud       display name and colour — the colours are the existing HUD
               palette, not new ones
     desc      what it DOES, for the playbook. One or two sentences, present
     tip       when to use it. These two and `icon` are the UI's fields
     icon      a src/ui/icons.js glyph id
               (ARCHITECTURE §6.9) and are the only ones ui/ owns in here.
               They exist because until wave 6 an item had a name in a HUD
               corner and nothing else anywhere in the game — no icon, no
               description, no hint that the table is rigged by position. */
export const ITEMS = [
  {
    id: ITEM.NITRO, name: 'NITRO', kind: 'boost', charges: 1, aimable: false,
    col: 0xff8a1a,
    icon: 'nitro',
    desc: 'A short, hard shove. Roughly twice the engine for a second and a half, ' +
      'and it lifts your terminal speed while it burns.',
    tip: 'Fire it on the exit, never the entry — a boost into a corner is a boost ' +
      'into the scenery. Best used where the road straightens after a crest.',
    force: 1.90,        // x motorForce
    top: 1.16,          // x topSpeed (drive-fade denominator)
    time: 1.6,          // s
  },
  {
    id: ITEM.TRIPLE, name: 'TRIPLE NITRO', kind: 'boost', charges: 3, aimable: false,
    col: 0xffd23f,
    icon: 'triple',
    desc: 'Three nitros on one pickup. Each one is the same shove; the slot stays ' +
      'full until you have spent all three.',
    tip: 'Holding a full slot means you drive past every box you pass, so spend ' +
      'them rather than hoarding them — three down a long straight is a lap gain.',
    force: 1.90, top: 1.16, time: 1.6,
  },
  {
    id: ITEM.WHEEL, name: 'SPARE WHEEL', kind: 'projectile', charges: 1, aimable: true,
    col: 0x9aa1a8,
    icon: 'wheel',
    desc: 'A truck tyre, thrown forward or dropped behind. It arcs, bounces off ' +
      'the ground up to five times, and spins out whoever it catches.',
    tip: 'It bounces, so aim it at the ROAD in front of a car rather than at the ' +
      'car. Hold reverse as you fire to send it backwards at whoever is nagging you.',
    speed: 34,          // m/s relative to the firing car
    lift: 2.2,          // m/s of initial vertical, so it arcs rather than skims
    bounce: 0.55,       // restitution against the ground
    maxBounce: 5,
    life: 6.0,          // s
    arm: 0.35,          // s before it can hit its owner
    radius: 0.36,       // m, added to the target's collision radius
    spin: 1.15,         // s of spin-out on a hit
  },
  {
    id: ITEM.SLICK, name: 'OIL SLICK', kind: 'hazard', charges: 1, aimable: false,
    col: 0x2a2420,
    icon: 'slick',
    desc: 'A patch of oil dropped three metres behind you. It sits there for nine ' +
      'seconds and spins out anyone who drives across it.',
    tip: 'Defence, and the leader\'s best item. Drop it on the racing line at a ' +
      'corner entry, where nobody has room to go around it.',
    drop: 3.2,          // m behind the car
    radius: 2.6,
    life: 9.0,
    immune: 0.6,        // s before the same car can be caught twice
    /* Shorter than the spare wheel on purpose: a slick is a mistake you can
       see coming and ought to be able to half-save. A projectile is not. */
    spin: 0.95,
  },
  {
    id: ITEM.TOW, name: 'TOW LINE', kind: 'tow', charges: 1, aimable: false,
    col: 0x4fd07a,
    icon: 'tow',
    desc: 'Hooks the car ahead inside a 35° cone. For a second and a half it drags ' +
      'you forward and holds them back — the line snaps if you get too close or ' +
      'they get too far.',
    tip: 'The overtaking item. Fire it on a straight where you can use the closing ' +
      'speed; fired into a corner you arrive far too fast to take it.',
    minDist: 8, maxDist: 55,   // m — the lock-on window
    cone: 0.61,                // rad (±35°)
    time: 1.4,                 // s
    pull: 6.5,                 // m/s² toward the target, for the firer
    drag: 4.0,                 // m/s² backwards, for the target
    breakNear: 6, breakFar: 70,
  },
  {
    id: ITEM.SLED, name: 'ROCKET SLED', kind: 'sled', charges: 1, aimable: false,
    col: 0xc46bff,
    icon: 'sled',
    desc: 'Three and a half seconds of autopilot at more than twice the engine. ' +
      'The car drives itself down the racing line and lets go the moment you reach ' +
      'third place.',
    tip: 'Last place only, and never on the run to the flag. Take your hands off — ' +
      'it steers better than you do, and fighting it only slows it down.',
    time: 3.4,
    force: 2.60, top: 1.45,
    /* Ends early on reaching this position — the point is to rescue a lost
       race, not to hand somebody the lead from last. */
    releaseAt: 3,
  },
  {
    id: ITEM.STORM, name: 'DUST STORM', kind: 'storm', charges: 1, aimable: false,
    col: 0xb99a6a,
    icon: 'storm',
    desc: 'Blows a wall of grit over everyone ahead of you. They lose a third of ' +
      'their drive for two and a half seconds, and if the leader is the player, ' +
      'they cannot see either.',
    tip: 'It hits the whole field in front, so it is worth most when they are ' +
      'nose-to-tail — fire it into a queue, not at one car.',
    time: 2.6,
    force: 0.72, top: 0.80,    // what it does to everyone ahead
    blind: 0.80,               // peak uBlind on the player, if they are ahead
  },
];

export const ITEM_BY_ID = ITEMS;

/* ============================================================
   THE DROP TABLE
   ------------------------------------------------------------
   Rows are 1-based position, columns are ITEM ids. Weights are relative and
   are normalised at roll time, so a row does not have to sum to anything.
   Read the two ends: P1 gets defence and the weakest boost in the set; three
   quarters of what last place draws is a comeback tool.
   ============================================================ */
export const DROP_WEIGHTS = [
  /* P1 */[6, 0, 14, 30, 0, 0, 0],
  /* P2 */[12, 3, 18, 22, 6, 0, 0],
  /* P3 */[14, 8, 16, 14, 16, 0, 0],
  /* P4 */[12, 14, 12, 8, 20, 0, 12],
  /* P5 */[8, 18, 8, 6, 18, 10, 18],
  /* P6 */[5, 20, 5, 4, 12, 24, 22],
];

export const ITEM_TUNE = {
  /* Seconds adrift of the leader beyond which a racer rolls one row further
     back than their position says. This is the lever that keeps the band
     working once the field has spread out. */
  gapShiftSec: 8,
  /* A rocket sled through the finish line reads as a bug. */
  sledLockoutM: 120,
  /* Rear-of-field only: STORM needs somebody ahead worth blinding. */
  stormMinPos: 4,
};

/* ============================================================
   GATES
   ------------------------------------------------------------
   Conditions the weights cannot express. Every one of these exists because
   the item is *wrong* in that situation, not because it is too strong.
   ============================================================ */
function gateOk(id, pos, field, ctx) {
  switch (id) {
    case ITEM.SLED:
      // Last place only, and never on the run to the flag.
      if (pos < field) return false;
      return !(ctx.toFinishM >= 0 && ctx.toFinishM < ITEM_TUNE.sledLockoutM);
    case ITEM.STORM:
      // Nothing to blind if you are not behind anybody.
      return pos >= ITEM_TUNE.stormMinPos && pos > 1;
    case ITEM.TOW:
      // A tow line with nothing to hook is a wasted pickup.
      return !!ctx.hasTarget;
    default:
      return true;
  }
}

/**
 * Roll one item.
 *
 * @param pos    1-based race position
 * @param field  how many cars are running
 * @param ctx    { toFinishM, hasTarget, behindSec } — all optional
 * @param rng    () => [0,1). MUST be the seeded race stream, not Math.random:
 *               dev/qa-drive.js compares lap times between builds and an
 *               unseeded roll here is enough noise to hide a regression.
 * @returns an ITEM id, never ITEM.NONE — every box gives you something.
 */
export function rollItem(pos, field, ctx, rng) {
  const c = ctx || EMPTY_CTX;
  const n = DROP_WEIGHTS.length;
  let row = (pos | 0) - 1;
  if (row < 0) row = 0;
  if (row > n - 1) row = n - 1;

  /* The gap shift. One row, never more, and never past the last row — a
     racer who is both last AND adrift is already drawing from the most
     generous row there is. */
  if (c.behindSec > ITEM_TUNE.gapShiftSec && row < n - 1) row++;

  const w = DROP_WEIGHTS[row];
  let total = 0;
  for (let i = 0; i < w.length; i++) {
    if (w[i] > 0 && gateOk(i, pos, field, c)) total += w[i];
  }
  /* Every gate can fail at once — P1 with no target rolls a row that is all
     defence anyway, but a two-car field in the last 120 m could in principle
     zero the row out. A box must always give you something. */
  if (total <= 0) return ITEM.NITRO;

  let x = rng() * total;
  for (let i = 0; i < w.length; i++) {
    if (w[i] <= 0 || !gateOk(i, pos, field, c)) continue;
    x -= w[i];
    if (x <= 0) return i;
  }
  return ITEM.NITRO;                    // float dust; unreachable in practice
}

const EMPTY_CTX = { toFinishM: -1, hasTarget: true, behindSec: 0 };

/* ============================================================
   INVENTORY
   ------------------------------------------------------------
   One slot, N charges. Deliberately not a queue: holding a stack of items is
   a different game, and a single slot is what makes "do I use this now or
   save it for the hairpin" a decision.
   ============================================================ */
export function makeInv() {
  return { id: ITEM.NONE, charges: 0, rollT: 0 };
}

export function clearInv(inv) {
  inv.id = ITEM.NONE; inv.charges = 0; inv.rollT = 0;
}

export function hasItem(inv) { return inv.id !== ITEM.NONE && inv.charges > 0; }

/** True if a box may be collected — a full slot means you drive past it. */
export function canTake(inv) { return !hasItem(inv) && inv.rollT <= 0; }

/**
 * Award an item. `rollT` is the roulette spin the HUD plays before the name
 * settles; the item is NOT usable until it runs out, which is what stops a
 * box being a zero-latency weapon.
 */
export function giveItem(inv, id, rollTime) {
  const def = ITEMS[id];
  inv.id = id;
  inv.charges = def ? def.charges : 1;
  inv.rollT = rollTime || 0;
  return inv;
}

/** Spend one charge. Returns the definition used, or null if there was none. */
export function consume(inv) {
  if (!hasItem(inv) || inv.rollT > 0) return null;
  const def = ITEMS[inv.id];
  inv.charges--;
  if (inv.charges <= 0) clearInv(inv);
  return def;
}

/** Tick the roulette. Call once per frame per racer. */
export function tickInv(inv, dt) {
  if (inv.rollT > 0) {
    inv.rollT -= dt;
    if (inv.rollT < 0) inv.rollT = 0;
  }
}

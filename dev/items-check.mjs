/* ============================================================
   RALLY ROAD RASH — the item table, the roulette and the rubber band
   ------------------------------------------------------------
       node dev/items-check.mjs

   Pure Node: no three, no loader shim, no track data. Everything here is a
   statement about BALANCE, and balance is the half of an item system that
   cannot be verified by looking at it. A hundred thousand seeded rolls per
   position is cheap and it is the only way to know that "strong catch-up"
   is actually what the table does rather than what it was meant to do.

   The two assertions that matter most:
     • P1's row contains nothing that can extend a lead.
     • Last place draws a comeback tool most of the time.
   Those two together ARE the rubber band. If either stops holding, the
   feature has quietly become decoration.
   ============================================================ */
import {
  ITEM, ITEMS, DROP_WEIGHTS, ITEM_TUNE,
  rollItem, makeInv, clearInv, giveItem, consume, hasItem, canTake, tickInv,
} from '../src/game/items.js';

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); }
};
const eq = (a, b, msg) => ok(a === b, `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const head = (s) => console.log(`\n=== ${s}`);
const pc = (n, d) => (100 * n / Math.max(1, d)).toFixed(1) + '%';

/* A seeded PRNG, copied in rather than imported so this file stays free of
   even core/rng.js — a failure here must be a failure in items.js. */
function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const FIELD = 6;
const N = 100000;
const NAMES = ITEMS.map(i => i.name);
const OFFENSIVE = [ITEM.WHEEL, ITEM.TOW, ITEM.SLED, ITEM.STORM];
const COMEBACK = [ITEM.SLED, ITEM.STORM, ITEM.TRIPLE];

/** Roll N items at a position and return a count per item id. */
function sample(pos, ctx, seed) {
  const r = rng32(seed || (0xC0FFEE ^ pos * 7919));
  const c = new Array(ITEMS.length).fill(0);
  for (let i = 0; i < N; i++) c[rollItem(pos, FIELD, ctx, r)]++;
  return c;
}

/* ============================================================
   a — the table itself
   ============================================================ */
head('a  drop table shape');
{
  eq(DROP_WEIGHTS.length, FIELD, 'one weight row per grid position');
  for (let p = 0; p < DROP_WEIGHTS.length; p++) {
    const row = DROP_WEIGHTS[p];
    eq(row.length, ITEMS.length, `P${p + 1} row covers every item`);
    let sum = 0, neg = 0;
    for (const w of row) { sum += w; if (w < 0) neg++; }
    eq(neg, 0, `P${p + 1} has no negative weights`);
    ok(sum > 0, `P${p + 1} row is not empty (sum ${sum})`);
  }
  for (let i = 0; i < ITEMS.length; i++) {
    const it = ITEMS[i];
    eq(it.id, i, `${it.name} id matches its index`);
    ok(typeof it.name === 'string' && it.name.length > 0, `item ${i} has a name`);
    ok(Number.isFinite(it.col), `${it.name} has a colour`);
    ok(it.charges >= 1, `${it.name} grants at least one charge`);
    for (const k in it) {
      const v = it[k];
      if (typeof v === 'number') ok(Number.isFinite(v), `${it.name}.${k} is finite`);
    }
  }
}

/* ============================================================
   b — THE RUBBER BAND. The two assertions the feature lives or dies on.
   ============================================================ */
head('b  rubber band: the leader is defenceless, last place is dangerous');
{
  const ctx = { toFinishM: 900, hasTarget: true, behindSec: 0 };
  const p1 = sample(1, ctx), p6 = sample(6, ctx);
  const line = (label, c) => {
    const parts = [];
    for (let i = 0; i < c.length; i++) if (c[i]) parts.push(`${NAMES[i]} ${pc(c[i], N)}`);
    console.log(`      ${label}  ${parts.join(' · ')}`);
  };
  line('P1', p1);
  line('P6', p6);

  /* P1 may draw the spare wheel — it is the weakest offensive item and it is
     as often used as a rear guard as forward. What P1 must NEVER draw is a
     tow line, a sled or a storm: those are the three that take time off
     somebody else, and a leader taking time off the field is the opposite of
     what this table is for. */
  eq(p1[ITEM.TOW], 0, 'P1 never draws a tow line');
  eq(p1[ITEM.SLED], 0, 'P1 never draws a rocket sled');
  eq(p1[ITEM.STORM], 0, 'P1 never draws a dust storm');
  eq(p1[ITEM.TRIPLE], 0, 'P1 never draws a triple');
  ok(p1[ITEM.SLICK] / N > 0.5, `P1 is mostly defensive (oil ${pc(p1[ITEM.SLICK], N)})`);

  let cb = 0;
  for (const id of COMEBACK) cb += p6[id];
  ok(cb / N > 0.6, `last place draws a comeback tool most of the time (${pc(cb, N)})`);
  ok(p6[ITEM.SLED] / N > 0.20, `…and a sled often enough to matter (${pc(p6[ITEM.SLED], N)})`);

  /* Monotonicity is the property that makes the band READ. A player who
     drops a place must feel the odds move in their favour, every time. */
  let prevOff = 2, prevCb = -1, mono = true, monoCb = true;
  for (let p = 1; p <= FIELD; p++) {
    const c = sample(p, ctx);
    let off = 0, back = 0;
    for (const id of OFFENSIVE) off += c[id];
    for (const id of COMEBACK) back += c[id];
    console.log(`      P${p}  offensive ${pc(off, N)}  comeback ${pc(back, N)}`);
    if (back / N < prevCb - 1e-9) monoCb = false;
    prevCb = back / N;
    prevOff = off / N;
  }
  ok(monoCb, 'comeback odds never fall as you drop down the order');
  void mono; void prevOff;
}

/* ============================================================
   c — the gates
   ============================================================ */
head('c  gates: the conditions weights cannot express');
{
  const near = { toFinishM: ITEM_TUNE.sledLockoutM - 1, hasTarget: true, behindSec: 0 };
  const c = sample(6, near);
  eq(c[ITEM.SLED], 0, 'no rocket sled on the run to the flag');
  ok(c[ITEM.STORM] > 0, '…but the rest of the row still works there');

  const noTarget = { toFinishM: 900, hasTarget: false, behindSec: 0 };
  const t = sample(3, noTarget);
  eq(t[ITEM.TOW], 0, 'no tow line with nothing to hook');

  for (let p = 1; p < ITEM_TUNE.stormMinPos; p++) {
    eq(sample(p, { toFinishM: 900, hasTarget: true, behindSec: 0 })[ITEM.STORM], 0,
      `P${p} never draws a dust storm`);
  }
  /* Every gate failing at once must still hand over an item — a box you
     drive through and get nothing from reads as a bug. */
  const dead = { toFinishM: 1, hasTarget: false, behindSec: 99 };
  let none = 0;
  const r = rng32(1234);
  for (let i = 0; i < 5000; i++) if (rollItem(6, FIELD, dead, r) === ITEM.NONE) none++;
  eq(none, 0, 'a box always gives you something, even with every gate shut');
}

/* ============================================================
   d — the gap shift
   ============================================================ */
head('d  gap shift: position stops meaning anything once the field spreads');
{
  const close = { toFinishM: 900, hasTarget: true, behindSec: 0 };
  const adrift = { toFinishM: 900, hasTarget: true, behindSec: ITEM_TUNE.gapShiftSec + 5 };
  const a = sample(4, close, 42), b = sample(4, adrift, 42);
  let ca = 0, cb = 0;
  for (const id of COMEBACK) { ca += a[id]; cb += b[id]; }
  console.log(`      P4 close ${pc(ca, N)} comeback  ·  P4 adrift ${pc(cb, N)} comeback`);
  ok(cb > ca, 'being adrift improves the odds at the same position');
  const p5 = sample(5, close, 42);
  let c5 = 0; for (const id of COMEBACK) c5 += p5[id];
  ok(Math.abs(cb - c5) / N < 0.05, 'an adrift P4 rolls approximately the P5 row');

  const lastAdrift = sample(6, adrift, 7);
  ok(lastAdrift[ITEM.SLED] > 0, 'the shift never falls off the end of the table');
}

/* ============================================================
   e — determinism
   ============================================================ */
head('e  determinism: the same seed is the same race');
{
  const ctx = { toFinishM: 900, hasTarget: true, behindSec: 0 };
  const a = rng32(2024), b = rng32(2024);
  let same = true;
  for (let i = 0; i < 10000; i++) {
    if (rollItem(1 + (i % 6), FIELD, ctx, a) !== rollItem(1 + (i % 6), FIELD, ctx, b)) { same = false; break; }
  }
  ok(same, '10 000 rolls from the same seed are identical');
  const c = rng32(2025);
  let diff = 0;
  const d = rng32(2024);
  for (let i = 0; i < 10000; i++) if (rollItem(3, FIELD, ctx, c) !== rollItem(3, FIELD, ctx, d)) diff++;
  ok(diff > 3000, 'a different seed is a different race');
}

/* ============================================================
   f — the inventory
   ============================================================ */
head('f  inventory: one slot, N charges, and a roulette you must wait out');
{
  const inv = makeInv();
  eq(hasItem(inv), false, 'starts empty');
  eq(canTake(inv), true, 'an empty slot can take a box');

  giveItem(inv, ITEM.WHEEL, 0.7);
  eq(inv.charges, 1, 'a spare wheel is one charge');
  eq(canTake(inv), false, 'a full slot drives past the next box');
  eq(consume(inv), null, 'an item cannot be fired while the roulette is spinning');
  tickInv(inv, 0.4);
  eq(consume(inv), null, '…still not, halfway through');
  tickInv(inv, 0.4);
  const used = consume(inv);
  ok(used && used.id === ITEM.WHEEL, 'once it settles, it fires');
  eq(hasItem(inv), false, 'and the slot is empty again');

  giveItem(inv, ITEM.TRIPLE, 0);
  eq(inv.charges, 3, 'a triple is three charges');
  ok(consume(inv) && inv.charges === 2, 'first charge spent');
  ok(consume(inv) && inv.charges === 1, 'second charge spent');
  eq(canTake(inv), false, 'a part-used triple still blocks the next box');
  ok(consume(inv) && inv.charges === 0, 'third charge spent');
  eq(hasItem(inv), false, 'and then it is gone');
  eq(consume(inv), null, 'an empty slot fires nothing');

  giveItem(inv, ITEM.SLED, 0.5);
  clearInv(inv);
  eq(hasItem(inv), false, 'clearInv empties it');
  eq(inv.rollT, 0, '…including the roulette');
  const keys = Object.keys(makeInv()).length;
  eq(Object.keys(inv).length, keys, 'the inventory has a fixed shape');
}

/* ---------------- verdict ---------------- */
console.log(`\n${failures ? '' : ''}${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
console.log('item table OK');

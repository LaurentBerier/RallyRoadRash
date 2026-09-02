/* ============================================================
   RALLY ROAD RASH — THE PLAYBOOK
   ------------------------------------------------------------
   The screen the game did not have. Before this, a power-up had a name in a
   HUD corner and nothing else anywhere: no icon, no description, no hint
   that the drop table is rigged by position, and no mention at all of the
   air controls or the trick modifier. A player could finish the championship
   without ever learning that holding DRIFT in the air turns steering into a
   barrel roll.

   Four tabs, and the split is by WHEN you need it: DRIVE is the ground game,
   AIR & TRICKS is everything that happens off it, POWER-UPS is the item set,
   CONTROLS is the reference you come back to.

   This module returns MARKUP, not DOM. ui.js owns the container, the focus
   attributes and the escaping helper, because the focus manager is shared
   and must not be reimplemented per screen. Icons are emitted as
   `<canvas data-ico>` placeholders and painted in one pass by icons.js.
   ============================================================ */
import { ITEMS, DROP_WEIGHTS } from '../game/items.js';

export const PLAYBOOK_TABS = ['DRIVE', 'AIR & TRICKS', 'POWER-UPS', 'CONTROLS'];

/* ------------------------------------------------------------------
   Extra binding rows that exist in the game but were in none of the
   tables. FIRE is the headline omission — the game ships a whole item
   system and never told anyone which key throws one.
   ------------------------------------------------------------------ */
const EXTRA_ROWS = {
  kb: [
    ['Fire power-up', 'F'],
    ['Fire it backwards', 'hold S + F'],
    ['Barrel roll (airborne)', 'Q / E'],
    ['Trick modifier', 'hold SPACE + steer'],
  ],
  pad: [
    ['Fire power-up', 'X'],
    ['Fire it backwards', 'hold LT + X'],
    ['Barrel roll (airborne)', 'LB / RB'],
    ['Trick modifier', 'hold A + stick'],
  ],
  touch: [
    ['Fire power-up', 'FIRE'],
    ['Fire it backwards', 'BRAKE + FIRE'],
    ['Barrel roll (airborne)', 'DRIFT + steer'],
    ['Trick modifier', 'hold DRIFT + steer'],
  ],
};

const METHOD_TITLE = { kb: 'KEYBOARD', pad: 'GAMEPAD', touch: 'TOUCH' };

/**
 * Which positions draw an item, and where it peaks.
 * Derived from DROP_WEIGHTS rather than written down, so a balance change is
 * still a data change (items.js header) and the playbook cannot go stale.
 */
export function drawnBy(id) {
  const rows = [];
  let peak = -1, peakShare = -1;
  for (let p = 0; p < DROP_WEIGHTS.length; p++) {
    const w = DROP_WEIGHTS[p];
    let tot = 0;
    for (let i = 0; i < w.length; i++) tot += w[i];
    if (!(w[id] > 0)) continue;
    rows.push(p + 1);
    const share = w[id] / Math.max(1, tot);
    if (share > peakShare) { peakShare = share; peak = p + 1; }
  }
  if (!rows.length) return { where: 'never drawn', peak: '' };
  const a = rows[0], b = rows[rows.length - 1];
  const contiguous = rows.length === b - a + 1;
  const where = rows.length === DROP_WEIGHTS.length ? 'any position'
    : contiguous ? (a === b ? `P${a} only` : `P${a}–P${b}`)
      : rows.map(p => 'P' + p).join(' · ');
  return { where, peak: `peaks at P${peak} (${Math.round(peakShare * 100)}%)` };
}

/* ============================================================
   COPY
   ------------------------------------------------------------
   Written as data so a tab is a loop, not four hundred characters of
   template string with markup mixed through it.
   ============================================================ */
const DRIVE = [
  ['boost', 'THROTTLE IS A DIAL, NOT A SWITCH',
    'Every machine here makes more grip under power than it does coasting, and ' +
    'less than it does braking. Lift for the entry, feed it back in from the apex. ' +
    'Standing on it through a corner is the slowest thing you can do.'],
  ['pad', 'THE GROUND CHANGES UNDER YOU',
    'Road, dirt, sand, mud, rock, grass. Sand and mud cost you a third of your grip ' +
    'and drag on the wheels; rock is nearly as good as tarmac but throws the car ' +
    'about. The dust colour off the tyres tells you which one you are on.'],
  ['boost', 'DRIFT CHARGES A BOOST',
    'Hold DRIFT and turn in. Once the car is genuinely sideways a charge builds, ' +
    'in three tiers — the tyre dust goes cyan, then orange, then violet. Let DRIFT ' +
    'go and the tier you banked fires as a boost. A throttle slide charges too, at ' +
    'a wider slip angle, so you can bank one without ever touching the handbrake.'],
  ['boost', 'BUT THE HANDBRAKE IS A ROTATION TOOL',
    'It is not a state you sit in. Past roughly half a second inside the slip band ' +
    'the car spins out however you steer it, which is why tier 1 is only 0.12 s: ' +
    'you are meant to fire twenty small ones a lap, not one enormous one.'],
  ['pad', 'BOOST PADS ARE FREE SPEED',
    'The cyan chevrons painted on the road. Cross one square-on and you get a ' +
    'push worth more than any drift tier. They are marked on the stage card and ' +
    'on the minimap.'],
  ['flag', 'CHECKPOINTS ARE IN ORDER',
    'Miss one and the lap will not count until you go back for it. The HUD says ' +
    'WRONG WAY the moment you turn around, and RETURN TO TRACK when you are far ' +
    'enough off it that the next checkpoint is out of reach.'],
  ['flag', 'RESET IS A HOLD, NOT A TAP',
    'Hold RESET and the ring fills. You come back at the last checkpoint, facing ' +
    'the right way, ghosted for a second and a half. The game also resets you by ' +
    'itself if you are upside down, stuck, or making no progress.'],
];

const AIR = [
  ['trick', 'YOU HAVE CONTROL IN THE AIR',
    'Throttle and brake pitch the nose up and down. Steering yaws it. That is ' +
    'enough to save a bad launch — land wheels-first and pointed down the road ' +
    'and you keep your speed; land nose-down or sideways and you do not.'],
  ['trick', 'HOLD DRIFT AND STEER TO ROLL',
    'The trick modifier. While airborne, holding DRIFT turns the steering axis ' +
    'into a ROLL axis instead of a yaw axis. That is how you throw a barrel roll ' +
    'without letting go of anything. Q and E (LB and RB on a pad) roll directly ' +
    'if you would rather have it on its own button.'],
  ['trick', 'TRICKS SCORE ON THE LANDING',
    'Nothing counts until the wheels are back down and still attached. A crash ' +
    'scores zero however pretty the rotation was. The bigger the rotation and the ' +
    'cleaner the landing, the higher the tier — and the pop on the HUD is coloured ' +
    'by it.'],
  ['trick', 'THE MOVE LIST',
    'STYLE HOP · BIG AIR · 360 · 720 · BACKFLIP · FRONTFLIP · BARREL ROLL · ' +
    'DOUBLE FLIP. Stack two rotations in one flight and it scores as a COMBO. ' +
    'Style accumulates across the race and is shown on the results board.'],
  ['pad', 'THE STAGE TELLS YOU WHERE THE AIR IS',
    'Kickers, tables, hips and drops are all marked on the stage card before you ' +
    'pick it, and on the minimap while you drive: a filled diamond is air you must ' +
    'carry speed into, a small ring is a kicker you can take flat.'],
];

/* ============================================================
   MARKUP
   ============================================================ */

/**
 * The pane for one tab.
 *
 * @param tab       0..3
 * @param method    'kb' | 'pad' | 'touch' — which controls table leads
 * @param bindings  ui.js's BINDINGS map (the single source for those rows)
 * @param esc       ui.js's HTML escaper
 */
export function playbookHTML(tab, method, bindings, esc) {
  const e = esc || ((s) => String(s == null ? '' : s));
  if (tab === 2) return itemsHTML(e);
  if (tab === 3) return controlsHTML(method, bindings, e);
  return notesHTML(tab === 1 ? AIR : DRIVE, e);
}

function notesHTML(rows, e) {
  let h = '<div class="pb-notes">';
  for (const [ico, title, body] of rows) {
    h += `<section class="pb-note">` +
      `<canvas class="ico" data-ico="${e(ico)}" data-size="30" aria-hidden="true"></canvas>` +
      `<div><h4>${e(title)}</h4><p>${e(body)}</p></div>` +
      `</section>`;
  }
  return h + '</div>';
}

function itemsHTML(e) {
  let h = '<p class="pb-lead">One slot, one item. A box you drive through rolls for a ' +
    'moment before it settles, and what it can roll is decided by WHERE YOU ARE: ' +
    'the leader draws defence and nothing else, last place draws comeback tools.</p>' +
    '<div class="pb-items">';
  for (const it of ITEMS) {
    const d = drawnBy(it.id);
    const col = '#' + ((it.col >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    h += `<article class="pb-item" style="--ic:${col}">` +
      `<canvas class="ico" data-ico="${e(it.icon || 'nitro')}" data-size="38" data-accent="${col}" aria-hidden="true"></canvas>` +
      `<div class="pb-item-body">` +
      `<h4>${e(it.name)}${it.charges > 1 ? `<span class="pb-charges">${it.charges}×</span>` : ''}</h4>` +
      `<p>${e(it.desc || '')}</p>` +
      `<p class="pb-tip"><b>TIP</b>${e(it.tip || '')}</p>` +
      `<p class="pb-who"><b>DRAWN BY</b>${e(d.where)}${d.peak ? ' · ' + e(d.peak) : ''}</p>` +
      `</div></article>`;
  }
  return h + '</div>';
}

function controlsHTML(method, bindings, e) {
  const order = ['kb', 'pad', 'touch'];
  // Lead with whatever the player is actually holding; the other two still
  // render, because a player on a keyboard is the one most likely to be
  // wondering whether a pad would work.
  order.sort((a, b) => (a === method ? -1 : b === method ? 1 : 0));
  let h = '<div class="pb-ctl">';
  for (const m of order) {
    const rows = (bindings && bindings[m]) || [];
    h += `<div class="pb-table${m === method ? ' lead' : ''}"><h4>${e(METHOD_TITLE[m] || m)}</h4>`;
    for (const [what, how] of rows) {
      h += `<div class="keyrow"><span>${e(what)}</span><b>${e(how)}</b></div>`;
    }
    for (const [what, how] of (EXTRA_ROWS[m] || [])) {
      h += `<div class="keyrow extra"><span>${e(what)}</span><b>${e(how)}</b></div>`;
    }
    h += '</div>';
  }
  h += '</div>' +
    '<p class="pb-lead">There is no remapper in this build. Every keyboard binding is ' +
    'read in one place — <code>src/core/input.js</code>, <code>Input.poll()</code>.</p>';
  return h;
}

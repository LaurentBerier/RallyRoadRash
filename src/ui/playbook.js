/* ============================================================
   RALLY ROAD RASH — THE PLAYBOOK
   ------------------------------------------------------------
   The screen the game did not have. Before this, a pickup had a name in a
   HUD corner and nothing else anywhere: no icon, no description, no mention
   at all of the air controls or the trick modifier. A player could finish
   the championship without ever learning that holding DRIFT in the air
   turns steering into a barrel roll.

   Four tabs, and the split is by WHEN you need it: DRIVE is the ground game,
   AIR & TRICKS is everything that happens off it, ARSENAL is the weapon and
   pickup set, CONTROLS is the reference you come back to.

   This module returns MARKUP, not DOM. ui.js owns the container, the focus
   attributes and the escaping helper, because the focus manager is shared
   and must not be reimplemented per screen. Icons are emitted as
   `<canvas data-ico>` placeholders and painted in one pass by icons.js.

   Wave 8: this tab used to read `ITEMS`/`DROP_WEIGHTS` straight out of
   game/items.js and render one card per rollable item plus a "drawn by"
   line derived from the drop table. items.js is gone — P3 deleted it this
   wave along with the roulette it described — so ARSENAL is written copy
   below, the same way DRIVE and AIR are, rather than data-driven. */

export const PLAYBOOK_TABS = ['DRIVE', 'AIR & TRICKS', 'ARSENAL', 'CONTROLS'];

/* ------------------------------------------------------------------
   Extra binding rows that exist in the game but are not in the base method
   tables (ui.js BINDINGS) above. FIRE and barrel-roll used to be the missing
   rows here too, but joined BINDINGS directly in a later wave — repeating
   them here would just show every row twice.
   ------------------------------------------------------------------ */
const EXTRA_ROWS = {
  kb: [
    ['Trick modifier', 'hold SPACE + steer'],
  ],
  pad: [
    ['Trick modifier', 'hold A + stick'],
  ],
  touch: [
    ['Trick modifier', 'hold DRIFT + steer'],
  ],
};

const METHOD_TITLE = { kb: 'KEYBOARD', pad: 'GAMEPAD', touch: 'TOUCH' };

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

/* No roulette, no rubber-banded drop table — everything here is a fixed
   pickup on the road, and boost pads and the drift boost were never
   pickups at all. Settings → WEAPONS turns off the top three; pads and the
   drift boost stay either way, which is worth saying since a player who
   switched weapons off would otherwise wonder why the road still glows. */
const ARSENAL = [
  ['rocket', 'ROCKETS',
    'One tube, six to twelve rounds depending on the machine. FIRE sends one straight ' +
    'ahead; hold the back key as you press FIRE and it launches behind you instead — the ' +
    'one answer to somebody who just passed you.'],
  ['crate', 'AMMO CRATES',
    'The boxes on the racing line. Drive through one and the tube tops up on the spot, no ' +
    'roulette and no wait. Run dry and FIRE does nothing until the next crate.'],
  ['nitro', 'NITRO CANS',
    'A timed speed burn the moment you drive through one — no aiming, no button, it just ' +
    'goes. Time one through a drift release and that is the fastest you move all race.'],
  ['pad', 'BOOST PADS',
    'Track furniture, not a pickup. The cyan chevrons painted on the road work with ' +
    'WEAPONS switched off — cross one square-on for a push worth more than any drift tier.'],
  ['boost', 'THE DRIFT BOOST',
    'Hold DRIFT through a corner and the tyre dust changes colour as a charge builds; let ' +
    'go and it fires as a mini-turbo. Handling, not a weapon — it never turns off, whatever ' +
    'WEAPONS is set to.'],
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
  if (tab === 2) return arsenalHTML(e);
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

function arsenalHTML(e) {
  let h = '<p class="pb-lead">What you pick up is what you get — no roulette, no waiting ' +
    'for it to land. The ammo count on the HUD says exactly how much of it you are ' +
    'carrying.</p>' +
    '<div class="pb-items">';
  for (const [ico, title, body] of ARSENAL) {
    h += `<article class="pb-item">` +
      `<canvas class="ico" data-ico="${e(ico)}" data-size="38" aria-hidden="true"></canvas>` +
      `<div class="pb-item-body">` +
      `<h4>${e(title)}</h4>` +
      `<p>${e(body)}</p>` +
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

# RALLY ROAD RASH — Controls

Prompts in the UI follow the input method you last used ('kb' | 'pad' |
'touch'); detection lives in `src/core/input.js` (`lastMethod`, 300 ms
debounce).

## Keyboard

| Action | Keys |
|---|---|
| Throttle | W or ↑ |
| Brake / reverse | S or ↓ (brakes while rolling forward, reverses from rest) |
| Steer | A / D or ← / → |
| Handbrake (drift / charge mini-turbo) | Space |
| Roll, airborne | Q / E |
| Trick modifier | hold Space in the air — steer ROLLS instead of yawing |
| Fire power-up | F (hold reverse to fire it backwards) |
| Reset to track | R — HOLD for ~0.8 s (ring fills on the HUD) |
| Camera (chase/hood) | C |
| Pause | Esc |
| Mute | M |
| Menus | Arrows / Enter / Esc / Tab |

## Gamepad (standard mapping)

| Action | Control |
|---|---|
| Steer | Left stick X |
| Throttle / brake | Right / left trigger |
| Handbrake | A (button 0) |
| Roll, airborne | LB / RB (buttons 4 / 5) |
| Trick modifier | hold A in the air — steer ROLLS instead of yawing |
| Fire power-up | X (button 2) |
| Reset (hold) | B (button 1) |
| Camera | Y (button 3) |
| Pause | Start (button 9) |
| Menus | D-pad or stick + A confirm, B back |

## In the air

Leaving a lip hands you full rotation on three axes, and what you do with
it is scored. Throttle pitches the nose up, brake pitches it down, steer
yaws — or ROLLS, if you are holding the handbrake. Q/E (LB/RB on a pad)
roll without the handbrake.

A full turn is a trick: BACKFLIP, FRONTFLIP, 360, 720, BARREL ROLL, or
DOUBLE FLIP. Two in one flight is a COMBO and pays a multiplier. Landing
is what banks it — come down sideways or nose-first and it is a CRASH
instead, however clean the rotation was. A landed trick feeds the
mini-turbo, so a big air pays you in speed as well as style.

**You do not have to do any of this.** Touch nothing in the air and a
predictive assist squares the car up to wherever it is actually going to
land. It only ever runs while you are NOT giving an input, so it can
never fight a flip you meant. SETTINGS → TRICK ASSIST scales it.

## Touch (phones / tablets, landscape recommended)

- **Steering pad** — bottom-left horizontal slider with centre detent; drag
  the nub. Absolute position → steering angle.
- **GAS / BRAKE pedals** — right edge, stacked; BRAKE reverses from rest.
- **DRIFT** (hold) · **FIRE** · **RESET** (hold) · **CAM** · **⏸** — round
  buttons between pad and pedals. Every target ≥60 px, multitouch-safe, no tap
  delay. (Portrait packs five into one column at 60 px; landscape uses two.)
- Controls appear automatically once the screen is touched (Settings →
  TOUCH CONTROLS = AUTO/ON/OFF). Portrait works; landscape is the intended
  layout and a one-time toast says so.

## Remapping

There is no in-game remapper in v1. All keyboard bindings are read in
`Input.poll()` (`src/core/input.js`, the `down('KeyW', 'ArrowUp')`-style
lines) and the race-action keys (`KeyR`, `KeyC`, `Escape`, `KeyM`) are
polled by `race.js`/`main.js` via `input.hit()/down()` (`KeyF` is an edge) — grep for the code
you want to move; each binding appears exactly once.

## Drifting, boosting and power-ups

**Mini-turbo.** Hold DRIFT through a corner. Once the car is genuinely
sideways the tyre dust changes colour — cyan, then orange, then violet — and
releasing DRIFT fires a boost of that tier. A throttle slide charges too, at
a wider slip angle, so you can bank a tier without ever touching the
handbrake. Spinning out cancels the charge. Mini-turbo is part of the
handling model and is always available.

**Power-ups.** The boxes are the glowing cyan cubes with a **?** on them,
hovering over the road in rows of three or four — they are the only object on
any stage that looks like that, and they respawn a few seconds after being
taken. Drive through one and a roulette spins for about two thirds of a
second; when it lands, the game tells you in as many words what you got and
what to do with it:

> `SPARE WHEEL — PRESS F TO THROW`
> `hold ↓ as you fire to throw it backwards`

The card in the bottom-right corner keeps the same three things on screen for
as long as you hold the item: the icon, the name, the verb, and the key. On a
pad the key reads **X**; on touch the **FIRE** button lights up in the item's
own colour instead.

| Item | What FIRE does |
|---|---|
| NITRO | BOOST |
| TRIPLE NITRO | BOOST ×3 — the slot stays full until all three are spent |
| SPARE WHEEL | THROW — hold the back key to send it behind you |
| OIL SLICK | DROP BEHIND YOU |
| TOW LINE | HOOK THE CAR AHEAD — with no car in range it fires as a NITRO, and says so |
| ROCKET SLED | LAUNCH — hands off, it steers itself |
| DUST STORM | BLIND EVERYONE AHEAD — a wall of dust across the road |

You can only hold one item at a time, so a box you drive through with a full
slot is wasted — the log in the bottom-left corner says `SLOT FULL — FIRE IT`
when that happens. That log is also where you find out what the rest of the
field is doing to you: `VOSS FIRED · SPARE WHEEL`, `HIT BY KIRA MOSS · OIL
SLICK`, `YOU HIT NAVA OKO · DUST STORM`. Pressing FIRE while the roulette is
still spinning is remembered, not swallowed — the shot goes off the moment
the item lands.

What you roll depends on where you are: the leader draws defensive items
almost exclusively, and the back of the field draws the two specials that
can rescue a race. Settings → POWER-UPS turns the whole item system off for
a clean time attack; records set with items on are flagged with a ⚡ on the
stage card so the two are never compared.

**Settings that change how a race feels.**

- **RIVALS** — EASY / NORMAL / HARD. How hard the AI races you: it moves the
  whole grid's skill and how tightly the field is held to your pace. Applies
  from the next race, not the one you are in.
- **TRICK ASSIST** — OFF / SOME / FULL, how much the game rotates the car
  towards flat as you come down from a jump. This setting reached no car at
  all before wave 7: the menu wrote it to your profile and nothing ever read
  it back. It now applies to YOUR car; rivals are pinned at FULL, because
  they cannot read a landing the way you can.

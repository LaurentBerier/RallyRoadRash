# RALLYE — Controls

Prompts in the UI follow the input method you last used ('kb' | 'pad' |
'touch'); detection lives in `src/core/input.js` (`lastMethod`, 300 ms
debounce).

## Keyboard

| Action | Keys |
|---|---|
| Throttle | W or ↑ |
| Brake / reverse | S or ↓ (brakes while rolling forward, reverses from rest) |
| Steer | A / D or ← / → |
| Handbrake (drift) | Space |
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
| Reset (hold) | B (button 1) |
| Camera | Y (button 3) |
| Pause | Start (button 9) |
| Menus | D-pad or stick + A confirm, B back |

## Touch (phones / tablets, landscape recommended)

- **Steering pad** — bottom-left horizontal slider with centre detent; drag
  the nub. Absolute position → steering angle.
- **GAS / BRAKE pedals** — right edge, stacked; BRAKE reverses from rest.
- **DRIFT** (hold) · **RESET** (hold) · **CAM** · **⏸** — round buttons
  between pad and pedals. Every target ≥64 px, multitouch-safe, no tap delay.
- Controls appear automatically once the screen is touched (Settings →
  TOUCH CONTROLS = AUTO/ON/OFF). Portrait works; landscape is the intended
  layout and a one-time toast says so.

## Remapping

There is no in-game remapper in v1. All keyboard bindings are read in
`Input.poll()` (`src/core/input.js`, the `down('KeyW', 'ArrowUp')`-style
lines) and the race-action keys (`KeyR`, `KeyC`, `Escape`, `KeyM`) are
polled by `race.js`/`main.js` via `input.hit()/down()` — grep for the code
you want to move; each binding appears exactly once.

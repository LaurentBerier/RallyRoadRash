/* ============================================================
   RALLY ROAD RASH — input: keyboard, mouse, gamepad, touch
   ------------------------------------------------------------
   Contract: docs/INTEGRATION-NOTES.md "Input (T7 owns input.js changes)".
     poll() -> { throttle -1..1, steer -1..1, brake 0..1, handbrake 0|1,
                 lookX, lookY, zoom }
     down(...codes) / hit(...codes) / endFrame() / showTouch(on) / lastMethod

   Three things worth knowing before you change anything here:

   1. ONE CHANNEL FOR BRAKE AND REVERSE. Back (S / ↓ / LT / the BRAKE pedal)
      is reported as NEGATIVE THROTTLE, never as `brake`. vehicle.js already
      converts negative throttle into braking while rolling forward and into
      reverse once stopped (vehicle.js "Pressing back while rolling forward is
      BRAKING"). Reporting the same press on both channels would apply the
      brakes and the reverse motor at the same time at a standstill, and the
      car would not reverse. `brake` therefore stays 0 for every input method
      we ship — it exists in the payload because the contract has it and
      because a real pedal set would use it.

   2. NO POINTER LOCK. This is a rally game played in short bursts; grabbing
      the cursor to look around is a survey-sim affordance that has no place
      here. Look is right-drag on desktop, right stick on a pad.

   3. THE GAMEPAD DRIVES MENUS THROUGH REAL KEY EVENTS. The d-pad and A/B
      dispatch synthetic KeyboardEvents on window while a screen is open (the
      UI sets `body.ui-open`), so the focus manager in ui.js needs no gamepad
      code at all, and our own keydown listener folds them into keys/pressed
      like everything else.
   ============================================================ */

const DZ = 0.14;                      // stick deadzone
const METHOD_DEBOUNCE = 300;          // ms — stop kb/pad/touch from flapping
const NAV_REPEAT_DELAY = 420, NAV_REPEAT_RATE = 130;   // ms, d-pad menu repeat

/* Codes we swallow so the page never scrolls or tab-traps mid-race. */
const EAT = ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'Slash'];

/* Module-level so poll() allocates no closures (hard rule 4). */
function padDz(v) { const a = v < 0 ? -v : v; return a < DZ ? 0 : (v - (v < 0 ? -DZ : DZ)) / (1 - DZ); }
function btnDown(bt, i) { const b = bt && bt[i]; return !!(b && (b.pressed || b.value > 0.5)); }
function btnVal(bt, i) { const b = bt && bt[i]; return b ? (b.value || (b.pressed ? 1 : 0)) : 0; }

export class Input {
  constructor(canvas) {
    this.canvas = canvas || null;
    this.keys = new Set();
    this.pressed = new Set();          // edge-triggered, cleared by endFrame()
    this.mouse = { dx: 0, dy: 0, wheel: 0, rdown: false };
    this.touch = { active: false, steer: 0, gas: 0, brake: 0 };
    this.pad = null;
    this.enabled = true;

    this._lastMethod = 'kb';
    this._methodT = 0;
    this._padPrev = Object.create(null);
    this._navT = 0;
    this._navCode = '';
    this._touchPref = 'auto';          // settings key showTouch
    this._wantTouch = false;           // "we are driving" — set by showTouch()
    this._ctls = [];                   // touch controls, for global release

    // Reused so poll() allocates nothing (hard rule 4).
    this._out = {
      throttle: 0, steer: 0, brake: 0, handbrake: 0,
      lookX: 0, lookY: 0, zoom: 0, looking: false
    };

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (EAT.includes(c)) e.preventDefault();
      this.keys.add(c); this.pressed.add(c);
      if (e.isTrusted) this._method('kb');
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this._panic());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._panic(); });

    if (this.canvas) {
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      this.canvas.addEventListener('mousedown', (e) => {
        if (e.button === 2) { this.mouse.rdown = true; e.preventDefault(); }
        this._method('kb');
      });
    }
    addEventListener('mouseup', (e) => { if (e.button === 2) this.mouse.rdown = false; });
    addEventListener('mousemove', (e) => {
      if (!this.mouse.rdown) return;
      this.mouse.dx += e.movementX || 0; this.mouse.dy += e.movementY || 0;
    });
    addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    addEventListener('gamepadconnected', (e) => { this.pad = e.gamepad.index; });
    addEventListener('gamepaddisconnected', (e) => { if (this.pad === e.gamepad.index) this.pad = null; });

    this.buildTouch();
  }

  /* ---------------- queries ---------------- */
  down(...codes) { for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i])) return true; return false; }
  hit(...codes) { for (let i = 0; i < codes.length; i++) if (this.pressed.has(codes[i])) return true; return false; }

  /** 'kb' | 'pad' | 'touch' — what the player last actually used. */
  get lastMethod() { return this._lastMethod; }

  _method(m) {
    const now = performance.now();
    if (m === this._lastMethod) { this._methodT = now; return; }
    if (now - this._methodT < METHOD_DEBOUNCE) return;
    this._lastMethod = m; this._methodT = now;
    this._applyTouchVis();
  }

  /** Everything up, everything zero. Alt-tab must never leave the throttle on. */
  _panic() {
    this.keys.clear();
    this.mouse.rdown = false; this.mouse.dx = this.mouse.dy = 0;
    for (let i = 0; i < this._ctls.length; i++) this._ctls[i].release();
    this._padPrev = Object.create(null);
  }

  /* ============================================================
     TOUCH
     Left: a horizontal steering pad (absolute position, centre detent).
     Chosen over a wheel or tilt because it is the only scheme that works
     the same on a table, in bed and one-handed, and because a thumb knows
     where the middle of a bar is without looking at it.
     Right: GAS (big, bottom) with BRAKE/REV above it at half height.
     Between them: DRIFT / RESET / CAM / PAUSE, 68 px circles.
     ============================================================ */
  buildTouch() {
    const coarse = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
      || 'ontouchstart' in window;
    if (!coarse) return;

    let wrap = document.getElementById('touch');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'touch';
      document.body.appendChild(wrap);
    }
    wrap.classList.add('hidden');
    let ticks = '';
    for (let i = 0; i < 9; i++) ticks += `<i class="${i === 4 ? 'mid' : ''}"></i>`;
    wrap.innerHTML =
      `<div class="pad"><div class="ticks">${ticks}</div><div class="nub"></div><label>STEER</label></div>` +
      `<div class="pedal gas">GAS</div>` +
      `<div class="pedal brk">BRAKE</div>` +
      `<div class="rcol">` +
        `<div class="rbtn fire">FIRE</div>
        <div class="rbtn drift">DRIFT</div>` +
        `<div class="rbtn reset">RESET</div>` +
        `<div class="rbtn cam">CAM</div>` +
        `<div class="rbtn pause">&#10073;&#10073;</div>` +
      `</div>`;
    this.touchEl = wrap;
    this.touch.active = true;

    /* ---- steering pad ---- */
    const pad = wrap.querySelector('.pad');
    const nub = pad.querySelector('.nub');
    const padCtl = {
      id: null,
      set: (x) => {
        const r = pad.getBoundingClientRect();
        const half = r.width * 0.5;
        let v = (x - r.left - half) / (half * 0.86);
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        if (Math.abs(v) < 0.06) v = 0;                  // centre detent
        this.touch.steer = v;
        nub.style.transform = `translateX(${(v * half * 0.86).toFixed(1)}px)`;
      },
      release: () => {
        padCtl.id = null; this.touch.steer = 0;
        nub.style.transform = ''; pad.classList.remove('on');
      }
    };
    this._ctls.push(padCtl);
    pad.addEventListener('touchstart', (e) => {
      e.preventDefault(); this._method('touch');
      if (padCtl.id === null) {
        const t = e.changedTouches[0];
        padCtl.id = t.identifier; pad.classList.add('on'); padCtl.set(t.clientX);
      }
    }, { passive: false });
    pad.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === padCtl.id) padCtl.set(t.clientX);
      }
    }, { passive: false });
    pad.addEventListener('touchend', (e) => this._endFor(e, padCtl), { passive: false });
    pad.addEventListener('touchcancel', (e) => this._endFor(e, padCtl), { passive: false });

    /* ---- pedals and buttons ----
       `hold` buttons latch a key for as long as the finger is down (the reset
       hold and the handbrake both need this); the rest fire one edge. */
    this._bindBtn(wrap.querySelector('.pedal.gas'), { axis: 'gas' });
    this._bindBtn(wrap.querySelector('.pedal.brk'), { axis: 'brake' });
    this._bindBtn(wrap.querySelector('.rbtn.fire'), { key: 'KeyF' });
    this._bindBtn(wrap.querySelector('.rbtn.drift'), { key: 'Space', hold: true });
    this._bindBtn(wrap.querySelector('.rbtn.reset'), { key: 'KeyR', hold: true });
    this._bindBtn(wrap.querySelector('.rbtn.cam'), { key: 'KeyC' });
    this._bindBtn(wrap.querySelector('.rbtn.pause'), { key: 'Escape' });

    /* Backstop against a stuck control: after every touch start/end/cancel,
       reconcile what we think is held against the live touch list. The
       per-element handlers above already release on their own touchend —
       this catches the cases they cannot see (a cancel delivered while the
       page is being scrolled away, a finger lost to a system gesture).
       It runs AFTER the element handlers because it is bound on window and
       touch events target the element the touch STARTED on. */
    this._live = new Set();
    const sync = (e) => {
      /* Any touch anywhere counts as touch input — including taps on menu
         buttons. Without this the 'auto' policy deadlocks: the controls only
         appear once lastMethod is 'touch', and lastMethod could only become
         'touch' by touching the controls. */
      if (e.type === 'touchstart') this._method('touch');
      this._live.clear();
      for (let i = 0; i < e.touches.length; i++) this._live.add(e.touches[i].identifier);
      for (let i = 0; i < this._ctls.length; i++) {
        const c = this._ctls[i];
        if (c.id !== null && !this._live.has(c.id)) c.release();
      }
    };
    addEventListener('touchstart', sync, { passive: true });
    addEventListener('touchend', sync, { passive: true });
    addEventListener('touchcancel', sync, { passive: true });
  }

  _endFor(e, ctl) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === ctl.id) { ctl.release(); return; }
    }
  }

  _bindBtn(el, opt) {
    if (!el) return;
    const ctl = {
      id: null,
      release: () => {
        ctl.id = null; el.classList.remove('on');
        if (opt.axis) this.touch[opt.axis] = 0;
        else if (opt.key) this.keys.delete(opt.key);
      }
    };
    this._ctls.push(ctl);
    el.addEventListener('touchstart', (e) => {
      e.preventDefault(); this._method('touch');
      if (ctl.id !== null) return;
      ctl.id = e.changedTouches[0].identifier;
      el.classList.add('on');
      if (opt.axis) this.touch[opt.axis] = 1;
      else if (opt.key) { this.keys.add(opt.key); this.pressed.add(opt.key); }
    }, { passive: false });
    const up = (e) => { e.preventDefault(); this._endFor(e, ctl); };
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  }

  /** "We are driving" — the race flow calls this at GRID and on results. */
  showTouch(on) { this._wantTouch = !!on; this._applyTouchVis(); }

  /** ADDITION for T5: the `showTouch` setting ('auto'|'on'|'off'). */
  setShowTouch(mode) {
    this._touchPref = (mode === 'on' || mode === 'off') ? mode : 'auto';
    this._applyTouchVis();
  }
  /** Alias — main.js already calls setTouchMode() for the same setting. */
  setTouchMode(mode) { this.setShowTouch(mode); }

  /* Pointer lock is gone (see the header). These stay as no-ops because
     race.js and main.js still call them; delete the call sites and then
     delete these. */
  lock() { /* no pointer lock in RALLY ROAD RASH */ }
  unlock() { /* no pointer lock in RALLY ROAD RASH */ }

  _applyTouchVis() {
    if (!this.touchEl) return;
    const pref = this._touchPref;
    const show = pref === 'off' ? false
      : pref === 'on' ? this._wantTouch
        : (this._wantTouch && this._lastMethod === 'touch');
    if (show === this._touchShown) return;
    this._touchShown = show;
    this.touchEl.classList.toggle('hidden', !show);
    document.body.classList.toggle('touch-controls', show);
    if (!show) for (let i = 0; i < this._ctls.length; i++) this._ctls[i].release();
  }

  /* ============================================================
     GAMEPAD
     ============================================================ */
  _pollPad(out) {
    if (this.pad === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.pad];
    if (!gp) return;

    const ax = gp.axes || [];
    const bt = gp.buttons || [];

    const steer = padDz(ax[0] || 0);
    const rt = btnVal(bt, 7), lt = btnVal(bt, 6);
    const lookX = padDz(ax[2] || 0), lookY = padDz(ax[3] || 0);

    if (Math.abs(steer) > 0.02 || rt > 0.06 || lt > 0.06 ||
        Math.abs(lookX) > 0.05 || Math.abs(lookY) > 0.05 ||
        btnDown(bt, 0) || btnDown(bt, 1) || btnDown(bt, 3) || btnDown(bt, 9) ||
        btnDown(bt, 12) || btnDown(bt, 13) || btnDown(bt, 14) || btnDown(bt, 15)) this._method('pad');

    out.steer += steer;
    out.throttle += rt - lt;               // one channel — see the header note
    out.lookX += lookX * 13;
    out.lookY += lookY * 13;
    if (Math.abs(lookX) + Math.abs(lookY) > 0.03) out.looking = true;

    const menu = document.body.classList.contains('ui-open');
    if (menu !== this._menuWas) {
      /* Crossing the menu boundary re-points A and B at different codes, so
         release whatever they were holding — a screen opened mid-handbrake
         would otherwise leave Space latched forever. The PRESSED state is
         deliberately kept: the physical button has not moved, and clearing it
         would re-fire an edge in the new mapping (START would pause and then
         instantly resume itself on the next frame). */
      this._menuWas = menu;
      this.keys.delete('Space'); this.keys.delete('KeyR'); this.keys.delete('KeyC');
      this._navCode = '';
    }

    if (menu) {
      /* Menus: d-pad + stick as arrows, A = Enter, B = Escape, with repeat.
         Dispatched as real key events so ui.js's focus manager and our own
         keys/pressed sets both see exactly one source of truth. */
      const upNav = btnDown(bt, 12) || (ax[1] || 0) < -0.6;
      const dnNav = btnDown(bt, 13) || (ax[1] || 0) > 0.6;
      const lfNav = btnDown(bt, 14) || steer < -0.6;
      const rtNav = btnDown(bt, 15) || steer > 0.6;
      const code = upNav ? 'ArrowUp' : dnNav ? 'ArrowDown' : lfNav ? 'ArrowLeft' : rtNav ? 'ArrowRight' : '';
      const now = performance.now();
      if (!code) { this._navCode = ''; this._navT = 0; }
      else if (code !== this._navCode) { this._navCode = code; this._navT = now + NAV_REPEAT_DELAY; this._synth(code); }
      else if (now >= this._navT) { this._navT = now + NAV_REPEAT_RATE; this._synth(code); }
      this._edge(bt, 0, 'Enter', true);
      this._edge(bt, 1, 'Escape', true);
      this._edge(bt, 9, 'Escape', true);
    } else {
      out.handbrake = out.handbrake || (btnDown(bt, 0) ? 1 : 0);
      this._edge(bt, 0, 'Space', false);   // handbrake also lands in keys, for uniformity
      this._edge(bt, 1, 'KeyR', false);    // reset is a HOLD — race.js reads down('KeyR')
      this._edge(bt, 3, 'KeyC', false);
      this._edge(bt, 2, 'KeyF', false);    // X — fire the held item
      this._edge(bt, 9, 'Escape', true);
      this._navCode = '';
    }
  }

  /** Rising/falling edge of a pad button → keys/pressed (+ a real key event
      when `synth`, so the DOM-side focus manager reacts). */
  _edge(bt, btn, code, synth) {
    const b = bt && bt[btn];
    const p = !!(b && (b.pressed || b.value > 0.5));
    const was = !!this._padPrev[btn];
    if (p && !was) {
      if (synth) this._synth(code);
      else { this.keys.add(code); this.pressed.add(code); }
    } else if (!p && was) {
      this.keys.delete(code);
    }
    this._padPrev[btn] = p;
  }

  _synth(code) {
    const key = code === 'Enter' ? 'Enter' : code === 'Escape' ? 'Escape'
      : code === 'Space' ? ' ' : code;
    try {
      dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }));
      dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
    } catch { /* very old engines: menus stay keyboard/touch driven */ }
  }

  /* ============================================================
     PER-FRAME
     Returns a REUSED object — copy anything you intend to keep.
     ============================================================ */
  poll() {
    const out = this._out;
    out.throttle = 0; out.steer = 0; out.brake = 0; out.handbrake = 0;
    out.lookX = 0; out.lookY = 0; out.zoom = 0; out.looking = false;
    if (!this.enabled) return out;

    /* ---- keyboard ---- */
    if (this.down('KeyW', 'ArrowUp')) out.throttle += 1;
    if (this.down('KeyS', 'ArrowDown')) out.throttle -= 1;
    if (this.down('KeyA', 'ArrowLeft')) out.steer -= 1;
    if (this.down('KeyD', 'ArrowRight')) out.steer += 1;
    if (this.down('Space')) out.handbrake = 1;

    /* ---- mouse look (right-drag only; no pointer lock) ---- */
    out.lookX += this.mouse.dx; out.lookY += this.mouse.dy;
    out.zoom += this.mouse.wheel;
    if (this.mouse.dx || this.mouse.dy) out.looking = true;
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;

    /* ---- touch ---- */
    if (this.touch.active && this._touchShown) {
      out.steer += this.touch.steer;
      out.throttle += this.touch.gas - this.touch.brake;
    }

    /* ---- gamepad ---- */
    this._pollPad(out);

    out.throttle = out.throttle < -1 ? -1 : out.throttle > 1 ? 1 : out.throttle;
    out.steer = out.steer < -1 ? -1 : out.steer > 1 ? 1 : out.steer;
    out.brake = out.brake < 0 ? 0 : out.brake > 1 ? 1 : out.brake;
    out.handbrake = out.handbrake ? 1 : 0;
    return out;
  }

  endFrame() { this.pressed.clear(); }
}

/* ============================================================
   RALLY ROAD RASH — EVERY SOUND IS SYNTHESISED
   ------------------------------------------------------------
   No sample files, no network. A rally car is mostly three
   noises stacked: a firing engine, four contact patches, and
   moving air. Each is built here from the cheapest primitive
   that still reads as the real thing —

     engine   band-limited pulse train (the cylinders firing)
              through a FIXED formant bank (the bodyshell). The
              excitation pitch revs, the resonances never move;
              that split is what stops it sounding like a siren.
     tyres    per-surface beds crossfaded by surface id, plus a
              granular scatter for anything loose. Gravel is
              thousands of impacts, not an EQ curve.
     air      speed-scaled filtered noise, stereo-detuned.

   Everything continuous is built ONCE and driven by AudioParam
   ramps — update() allocates nothing. Only discrete events build
   graphs, and those self-disconnect on ended.
   ============================================================ */

import { SURFACES, SURF } from '../world/surfaces.js';
import * as ARCADE_SFX from './audio-arcade.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/* Engine characters. `rev` scales the firing frequency (a truck lump turns
   slower for the same pedal), formants are the bodyshell and never move with
   rpm, only their gains open under load. */
const FAMILIES = {
  truck: {                                  // RIDGEBACK — deep, slow, lumpy
    roll: 0.075, odd: 0.78, rev: 0.86,
    f: [104, 292, 630, 1420], q: [7.0, 8.0, 9.0, 7.0], a: [1.00, 0.60, 0.32, 0.14],
    intake: 1.00, whistle: 0.0, crackle: 0.75, boom: 1.25, growl: 0.5,
  },
  buggy: {                                  // DUNE HOPPER — raspy midrange
    roll: 0.105, odd: 1.30, rev: 1.00,
    f: [178, 520, 1150, 2380], q: [5.0, 6.5, 8.0, 7.0], a: [0.90, 0.80, 0.50, 0.26],
    intake: 0.95, whistle: 0.0, crackle: 1.00, boom: 0.90, growl: 1.0,
  },
  wedge: {                                  // REDLINE — smooth, turbocharged
    roll: 0.135, odd: 1.00, rev: 1.12,
    f: [150, 432, 985, 2060], q: [4.0, 5.5, 7.0, 6.0], a: [0.95, 0.70, 0.44, 0.22],
    intake: 0.75, whistle: 1.0, crackle: 0.85, boom: 0.80, growl: 0.7,
  },
  thumper: {                                // HORNET — motocross 450 single
    /* One big cylinder. `odd` is pushed hard because a single is nothing but
       odd harmonics between the bangs, `rev` is high because it turns twice
       as fast as anything else here, and the formants sit high and thin —
       there is no bodyshell on a bike, just a header pipe and an airbox.
       `boom` is cut right back: the low end on a 450 is a rattle, not a
       chest thump, and leaving it at 1.0 made it sound like a small truck. */
    roll: 0.150, odd: 1.85, rev: 1.55,
    f: [232, 690, 1480, 2950], q: [3.2, 4.5, 6.0, 5.5], a: [0.72, 0.86, 0.62, 0.34],
    intake: 1.15, whistle: 0.0, crackle: 1.30, boom: 0.42, growl: 1.25,
  },
};
// vehicle spec ids map onto the engine characters so race flow can pass either
const SPEC_FAMILY = { hopper: 'buggy', ridgeback: 'truck', redline: 'wedge', moto: 'thumper' };

/* Music. D minor throughout so menu and race share a tonal centre and the
   crossfade never sounds like two radios fighting. Roots as MIDI. */
const MENU_CHORDS = [                        // one bar each, 8-bar loop
  [50, 53, 57], [46, 50, 53], [41, 45, 48], [48, 52, 55],
  [50, 53, 57], [46, 50, 53], [43, 46, 50], [45, 49, 52],
];
const RACE_CHORDS = [[50, 53, 57], [50, 53, 57], [46, 50, 53], [48, 52, 55]];
const BASS_16 = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0];

const GRAINS = 5;      // per bank (brown + white) — 10 scatter voices total
const GRAIN_RATE_MAX = 70;   // impacts/s; above this the pool eats its own tail
const PERCS = 4;       // music percussion voices

export class Audio {
  constructor() {
    // Safe before init(): no context, no window, no document touched here.
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.volSfx = 0.8; this.volMusic = 0.55;
    this.musicOn = true;
    this.musicMode = 'off';
    this.driving = true;
    this.timeBase = null;
    this.surfaceId = SURF.DIRT;
    this.fam = FAMILIES.buggy;
    this.familyName = 'buggy';

    // per-frame state, all primitives — nothing here allocates later
    this._air = 0; this._prevLoad = 0; this._liftT = 0; this._liftCd = 0;
    this._crackAcc = 0; this._grainAcc = 0; this._shiftCd = 0;
    this._scrapeReq = 0; this._scrapeSurf = SURF.ROCK;
    this._giB = 0; this._giW = 0; this._pi = 0;
    this._rpmRing = new Float32Array(24);
    this._rpmRingT = new Float32Array(24);
    this._rpmRingI = 0; this._clock = 0;
    this._surfW = new Float32Array(SURFACES.length);
    this._surfW[SURF.DIRT] = 1;
    this._step = 0; this._musicT0 = null; this._musicLastT = 0; this._inten = 0;
  }

  /* `external` lets the whole graph be built on an OfflineAudioContext, which is
     how a rendered demo soundtrack works: an offline context's currentTime does
     not advance while you schedule against it, so callers set `timeBase` per
     frame and every scheduling site reads now() instead of currentTime. That is
     also why nothing in this file uses setTimeout. */
  init(external) {
    if (this.ctx) return;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    const AC = g && (g.AudioContext || g.webkitAudioContext);
    if (!external && !AC) return;
    const ctx = this.ctx = external || new AC();

    this._buildMaster();
    this.noiseBuf = this._noise(6.0);     // brown-ish: body, grit, whumps
    this.whiteBuf = this._white(6.0);     // flat: hiss, crackle, squeal, air
    this._buildEngine();
    this._buildBeds();
    this._buildTyres();
    this._buildWind();
    this._buildGrains();
    this._buildMusic();
    this.ready = true;

    /* init() happens on the first user gesture, which can be long after the
       menu has already picked a car, a volume and a music mode. Replay the
       state we were holding onto instead of silently ignoring it. */
    const mode = this.musicMode;
    this.musicMode = 'off';
    this.setMusicMode(mode);
    this.setEngineCharacter(this.familyName);
    this.setVolumes(this.volSfx, this.volMusic);
    this.setDriving(this.driving);
    if (ctx.state === 'suspended') this.resume();
  }

  /** Must still be called from a user gesture — Safari and Chrome both refuse
      to start an autoplay context, and iOS re-suspends on backgrounding. */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
  }

  /** Scheduling clock. Realtime uses the context; offline renders override it. */
  now() { return this.timeBase != null ? this.timeBase : this.ctx.currentTime; }

  /* ---------------- buffers ---------------- */
  _noise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.021 * w) / 1.021;    // brown-ish: heavier at the bottom
      d[i] = last * 3.2;
    }
    return b;
  }
  _white(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  _impulse(sec, decay) {
    const rate = this.ctx.sampleRate, n = Math.floor(rate * sec);
    const b = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }
  /** A looping source is cheaper than restarting one-shots; offsetting the read
      head decorrelates beds that share a buffer so they do not phase together. */
  _loop(buf, offset) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(this.ctx.currentTime, offset % buf.duration);
    return s;
  }

  /* ---------------- master ---------------- */
  _buildMaster() {
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.85;

    // glue first, then a brick wall — a 40 m/s crash into a barrier must be
    // loud without ever handing the DAC a clipped sample
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 20; comp.ratio.value = 4;
    comp.attack.value = 0.005; comp.release.value = 0.20;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.08;
    this.master.connect(comp); comp.connect(lim); lim.connect(ctx.destination);
    this.comp = comp; this.limiter = lim;

    this.busSfx = ctx.createGain(); this.busSfx.gain.value = this.volSfx;
    this.busMusic = ctx.createGain(); this.busMusic.gain.value = this.volMusic;
    this.busSfx.connect(this.master); this.busMusic.connect(this.master);

    // everything that belongs to the car: one switch for pause/menus
    this.driveBus = ctx.createGain(); this.driveBus.gain.value = 1;
    this.driveBus.connect(this.busSfx);

    this.verb = ctx.createConvolver(); this.verb.buffer = this._impulse(1.1, 3.2);
    this.verbGain = ctx.createGain(); this.verbGain.gain.value = 0.20;
    this.verb.connect(this.verbGain); this.verbGain.connect(this.busSfx);
  }

  /* ---------------- engine ----------------
     A four-cylinder four-stroke fires twice per crank revolution, so the
     excitation is a pulse train at 28–190 Hz (≈800–7000 rpm). The pulse comes
     from a PeriodicWave, which the implementation band-limits for us: no
     aliasing at redline, unlike any hand-rolled saw. Everything above it —
     formants, intake, whistle — is a fixed structure the pulse train excites. */
  _pulseWave(roll, odd) {
    const N = 28, real = new Float32Array(N), imag = new Float32Array(N);
    for (let i = 1; i < N; i++) {
      let a = (1 / i) * Math.exp(-i * roll);
      a *= (i & 1) ? odd : (2 - odd);       // odd-heavy rasps, even-heavy lumps
      imag[i] = a;
    }
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  _buildEngine() {
    const ctx = this.ctx;
    this.engBus = ctx.createGain(); this.engBus.gain.value = 0.0001;
    this.engDuck = ctx.createGain(); this.engDuck.gain.value = 1;   // clutch dips
    this.engBus.connect(this.engDuck); this.engDuck.connect(this.driveBus);

    this.waves = {
      truck: this._pulseWave(FAMILIES.truck.roll, FAMILIES.truck.odd),
      buggy: this._pulseWave(FAMILIES.buggy.roll, FAMILIES.buggy.odd),
      wedge: this._pulseWave(FAMILIES.wedge.roll, FAMILIES.wedge.odd),
    };
    this.pOsc = ctx.createOscillator();
    this.pOsc.setPeriodicWave(this.waves.buggy);
    this.pOsc.frequency.value = 40;
    this.pDrive = ctx.createGain(); this.pDrive.gain.value = 1;
    this.pOsc.connect(this.pDrive); this.pOsc.start();

    // bodyshell formants, panned apart so the car has width around the camera
    this.form = [];
    const PAN = [-0.30, 0.26, -0.18, 0.22];
    for (let i = 0; i < 4; i++) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = FAMILIES.buggy.f[i]; bp.Q.value = FAMILIES.buggy.q[i];
      const g = ctx.createGain(); g.gain.value = FAMILIES.buggy.a[i];
      const p = ctx.createStereoPanner(); p.pan.value = PAN[i];
      this.pDrive.connect(bp); bp.connect(g); g.connect(p); p.connect(this.engBus);
      this.form.push({ bp, g });
    }
    // the part you feel rather than hear
    this.boomF = ctx.createBiquadFilter(); this.boomF.type = 'lowpass';
    this.boomF.frequency.value = 130; this.boomF.Q.value = 1.2;
    this.boomG = ctx.createGain(); this.boomG.gain.value = 0.6;
    this.pDrive.connect(this.boomF); this.boomF.connect(this.boomG);
    this.boomG.connect(this.engBus);

    /* Intake growl: a detuned saw pair at half the firing rate — that is crank
       order 1, the note you hear through the airbox. Its filter opens with the
       throttle, which is most of what "load" sounds like from inside a car. */
    this.inLp = ctx.createBiquadFilter(); this.inLp.type = 'lowpass';
    this.inLp.frequency.value = 500; this.inLp.Q.value = 1.6;
    this.inG = ctx.createGain(); this.inG.gain.value = 0;
    this.inOsc = [];
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = 20; o.detune.value = i ? 11 : -9;
      const g = ctx.createGain(); g.gain.value = 0.5;
      o.connect(g); g.connect(this.inLp); o.start();
      this.inOsc.push(o);
    }
    this.inLp.connect(this.inG); this.inG.connect(this.engBus);

    // turbo: spools with a lag, so lifting leaves it hanging for a moment
    this.whOsc = ctx.createOscillator(); this.whOsc.type = 'sine';
    this.whOsc.frequency.value = 1400;
    this.whBp = ctx.createBiquadFilter(); this.whBp.type = 'bandpass';
    this.whBp.frequency.value = 3000; this.whBp.Q.value = 1.4;
    this.whG = ctx.createGain(); this.whG.gain.value = 0;
    this.whLfo = ctx.createOscillator(); this.whLfo.frequency.value = 6.7;
    this.whLfoG = ctx.createGain(); this.whLfoG.gain.value = 16;
    this.whLfo.connect(this.whLfoG); this.whLfoG.connect(this.whOsc.detune);
    this.whOsc.connect(this.whBp); this.whBp.connect(this.whG); this.whG.connect(this.engBus);
    this.whOsc.start(); this.whLfo.start();

    /* Nearest rival: one oscillator, one resonator, one panner. Six fully
       voiced engines is not worth the CPU; one shadow behind you is. */
    this.rvOsc = ctx.createOscillator();
    this.rvOsc.setPeriodicWave(this.waves.buggy);
    this.rvOsc.frequency.value = 40;
    this.rvBp = ctx.createBiquadFilter(); this.rvBp.type = 'bandpass';
    this.rvBp.frequency.value = 560; this.rvBp.Q.value = 1.1;
    this.rvG = ctx.createGain(); this.rvG.gain.value = 0;
    this.rvPan = ctx.createStereoPanner(); this.rvPan.pan.value = 0;
    this.rvOsc.connect(this.rvBp); this.rvBp.connect(this.rvG);
    this.rvG.connect(this.rvPan); this.rvPan.connect(this.driveBus);
    this.rvOsc.start();
  }

  /** Race flow calls this at grid formation, before the countdown. Accepts
      `{family}`, `{id}` (a vehicle spec id) or a bare string. */
  setEngineCharacter(spec) {
    let name = 'buggy';
    if (typeof spec === 'string') name = SPEC_FAMILY[spec] || spec;
    else if (spec) name = spec.family || SPEC_FAMILY[spec.id] || 'buggy';
    if (!FAMILIES[name]) name = 'buggy';
    this.familyName = name;
    this.fam = FAMILIES[name];
    if (!this.ready) return;
    const t = this.now(), f = this.fam;
    this.pOsc.setPeriodicWave(this.waves[name]);
    for (let i = 0; i < 4; i++) {
      this.form[i].bp.frequency.setTargetAtTime(f.f[i], t, 0.05);
      this.form[i].bp.Q.setTargetAtTime(f.q[i], t, 0.05);
    }
    this.boomG.gain.setTargetAtTime(0.5 * f.boom, t, 0.05);
    this.rvOsc.setPeriodicWave(this.waves[name]);
  }

  /** Gate for the whole continuous car layer (engine, tyres, beds, wind,
      scrape). Race flow: false in menus/results/pause, true on the grid. */
  setDriving(on) {
    this.driving = !!on;
    if (!this.ready) return;
    this.driveBus.gain.setTargetAtTime(on ? 1 : 0.0001, this.now(), on ? 0.08 : 0.15);
  }

  /* ---------------- surface beds ----------------
     Seven surfaces, six beds: DIRT and ROCK share one grit bed whose filter and
     grain brightness slide between them. Weights are smoothed per frame so a
     surface transition is a crossfade, not a switch. */
  _buildBeds() {
    const ctx = this.ctx;
    this.bedBus = ctx.createGain(); this.bedBus.gain.value = 1;
    this.bedBus.connect(this.driveBus);

    this.srcBrown = this._loop(this.noiseBuf, 0.0);
    this.srcBrown2 = this._loop(this.noiseBuf, 2.7);
    this.srcWhite = this._loop(this.whiteBuf, 0.0);
    this.srcWhite2 = this._loop(this.whiteBuf, 3.1);
    this.srcWind = this._loop(this.whiteBuf, 1.4);

    // ROAD — tyre roar: a broad low band plus a tread whine that only shows up
    // at speed. Filters move, not playback rate: a resampled loop wobbles.
    this.rdBp = ctx.createBiquadFilter(); this.rdBp.type = 'bandpass';
    this.rdBp.frequency.value = 300; this.rdBp.Q.value = 0.65;
    this.rdPk = ctx.createBiquadFilter(); this.rdPk.type = 'peaking';
    this.rdPk.frequency.value = 1150; this.rdPk.Q.value = 1.4; this.rdPk.gain.value = 0;
    this.rdG = ctx.createGain(); this.rdG.gain.value = 0;
    this.srcBrown.connect(this.rdBp); this.rdBp.connect(this.rdPk);
    this.rdPk.connect(this.rdG); this.rdG.connect(this.bedBus);

    // DIRT / ROCK — bed under the grains, brightening toward rock
    this.gtBp = ctx.createBiquadFilter(); this.gtBp.type = 'bandpass';
    this.gtBp.frequency.value = 260; this.gtBp.Q.value = 0.55;
    this.gtSh = ctx.createBiquadFilter(); this.gtSh.type = 'highshelf';
    this.gtSh.frequency.value = 1700; this.gtSh.gain.value = -10;
    this.gtG = ctx.createGain(); this.gtG.gain.value = 0;
    this.srcBrown2.connect(this.gtBp); this.gtBp.connect(this.gtSh);
    this.gtSh.connect(this.gtG); this.gtG.connect(this.bedBus);

    // SAND — broadband hiss; the low whumps come from the grain bank
    this.sdHp = ctx.createBiquadFilter(); this.sdHp.type = 'highpass';
    this.sdHp.frequency.value = 800; this.sdHp.Q.value = 0.6;
    this.sdG = ctx.createGain(); this.sdG.gain.value = 0;
    this.srcWhite.connect(this.sdHp); this.sdHp.connect(this.sdG);
    this.sdG.connect(this.bedBus);

    /* MUD — lowpassed noise amplitude-modulated at the wheel rotation rate, so
       the slosh is locked to the tread rather than free-running. Two LFOs at a
       non-integer ratio keep it from sounding like a tremolo pedal. */
    this.mdLp = ctx.createBiquadFilter(); this.mdLp.type = 'lowpass';
    this.mdLp.frequency.value = 460; this.mdLp.Q.value = 1.3;
    this.mdG = ctx.createGain(); this.mdG.gain.value = 0;
    this.srcBrown.connect(this.mdLp); this.mdLp.connect(this.mdG);
    this.mdG.connect(this.bedBus);
    this.mdLfo = ctx.createOscillator(); this.mdLfo.type = 'triangle'; this.mdLfo.frequency.value = 4;
    this.mdLfoG = ctx.createGain(); this.mdLfoG.gain.value = 0;
    this.mdLfo.connect(this.mdLfoG); this.mdLfoG.connect(this.mdG.gain); this.mdLfo.start();
    this.mdLfo2 = ctx.createOscillator(); this.mdLfo2.type = 'sine'; this.mdLfo2.frequency.value = 6.1;
    this.mdLfoG2 = ctx.createGain(); this.mdLfoG2.gain.value = 0;
    this.mdLfo2.connect(this.mdLfoG2); this.mdLfoG2.connect(this.mdG.gain); this.mdLfo2.start();

    // GRASS — swish, gently pulsed at half the wheel rate
    this.grBp = ctx.createBiquadFilter(); this.grBp.type = 'bandpass';
    this.grBp.frequency.value = 1600; this.grBp.Q.value = 0.85;
    this.grG = ctx.createGain(); this.grG.gain.value = 0;
    this.srcWhite2.connect(this.grBp); this.grBp.connect(this.grG);
    this.grG.connect(this.bedBus);
    this.grLfo = ctx.createOscillator(); this.grLfo.type = 'sine'; this.grLfo.frequency.value = 3;
    this.grLfoG = ctx.createGain(); this.grLfoG.gain.value = 0;
    this.grLfo.connect(this.grLfoG); this.grLfoG.connect(this.grG.gain); this.grLfo.start();

    // LAVA — sizzle bed; the crackle pops come from the grain bank
    this.lvHp = ctx.createBiquadFilter(); this.lvHp.type = 'highpass';
    this.lvHp.frequency.value = 2800; this.lvHp.Q.value = 0.7;
    this.lvG = ctx.createGain(); this.lvG.gain.value = 0;
    this.srcWhite2.connect(this.lvHp); this.lvHp.connect(this.lvG);
    this.lvG.connect(this.bedBus);

    // body scraping the ground — a grind plus a screech, brightness by surface
    this.scLp = ctx.createBiquadFilter(); this.scLp.type = 'lowpass';
    this.scLp.frequency.value = 900; this.scLp.Q.value = 0.8;
    this.scBp = ctx.createBiquadFilter(); this.scBp.type = 'bandpass';
    this.scBp.frequency.value = 1300; this.scBp.Q.value = 2.6;
    this.scG = ctx.createGain(); this.scG.gain.value = 0;
    this.srcWhite.connect(this.scLp); this.scLp.connect(this.scG);
    this.srcWhite.connect(this.scBp); this.scBp.connect(this.scG);
    this.scG.connect(this.driveBus);
  }

  /* ---------------- tyres ----------------
     Squeal is a self-excited resonance: high-Q bandpasses on noise plus a sine
     riding the same frequency for the tonal edge. It only sings where the
     surface can polish the tread, which is exactly what SURFACES[].skid says. */
  _buildTyres() {
    const ctx = this.ctx;
    this.tyreBus = ctx.createGain(); this.tyreBus.gain.value = 1;
    this.tyreBus.connect(this.driveBus);

    this.sqG = ctx.createGain(); this.sqG.gain.value = 0;
    this.sqBp1 = ctx.createBiquadFilter(); this.sqBp1.type = 'bandpass';
    this.sqBp1.frequency.value = 1100; this.sqBp1.Q.value = 22;
    this.sqBp2 = ctx.createBiquadFilter(); this.sqBp2.type = 'bandpass';
    this.sqBp2.frequency.value = 1680; this.sqBp2.Q.value = 16;
    this.srcWhite.connect(this.sqBp1); this.srcWhite.connect(this.sqBp2);
    this.sqBp1.connect(this.sqG); this.sqBp2.connect(this.sqG);
    this.sqG.connect(this.tyreBus); this.sqG.connect(this.verb);
    this.sqSine = ctx.createOscillator(); this.sqSine.type = 'sine';
    this.sqSine.frequency.value = 1100;
    this.sqSineG = ctx.createGain(); this.sqSineG.gain.value = 0;
    this.sqSine.connect(this.sqSineG); this.sqSineG.connect(this.tyreBus);
    this.sqSine.start();

    // scrub: what the slip does on surfaces that cannot squeal — lower, dirtier
    this.scrBp = ctx.createBiquadFilter(); this.scrBp.type = 'bandpass';
    this.scrBp.frequency.value = 360; this.scrBp.Q.value = 3.2;
    this.scrG = ctx.createGain(); this.scrG.gain.value = 0;
    this.srcBrown2.connect(this.scrBp); this.scrBp.connect(this.scrG);
    this.scrG.connect(this.tyreBus);
  }

  /* ---------------- air ----------------
     Two slightly different bands hard-panned, each drifting on its own slow
     LFO. Identical noise in both ears is a wall; detuned noise is wind. */
  _buildWind() {
    const ctx = this.ctx;
    this.wndBus = ctx.createGain(); this.wndBus.gain.value = 0;
    this.wndBus.connect(this.driveBus);
    this.wnd = [];
    for (let i = 0; i < 2; i++) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = i ? 420 : 340; bp.Q.value = 0.55;
      const p = ctx.createStereoPanner(); p.pan.value = i ? 0.75 : -0.75;
      const lfo = ctx.createOscillator(); lfo.type = 'sine';
      lfo.frequency.value = i ? 0.31 : 0.23;
      const lg = ctx.createGain(); lg.gain.value = 70;
      lfo.connect(lg); lg.connect(bp.frequency); lfo.start();
      this.srcWind.connect(bp); bp.connect(p); p.connect(this.wndBus);
      this.wnd.push({ bp, lg });
    }
    // low buffet so the wind has weight at speed instead of just hissing
    this.wndLp = ctx.createBiquadFilter(); this.wndLp.type = 'lowpass';
    this.wndLp.frequency.value = 150; this.wndLp.Q.value = 0.9;
    this.wndLpG = ctx.createGain(); this.wndLpG.gain.value = 0.9;
    this.srcBrown2.connect(this.wndLp); this.wndLp.connect(this.wndLpG);
    this.wndLpG.connect(this.wndBus);
  }

  /* ---------------- grain banks ----------------
     A grain is one impact. Building a BufferSource per impact would allocate
     dozens of nodes a second, so each voice is built once with a permanently
     looping source and retriggered by scheduling an envelope on its gain. Two
     banks: brown for stones and whumps, white for crackle, sizzle and debris. */
  _buildGrains() {
    const ctx = this.ctx;
    this.grainBus = ctx.createGain(); this.grainBus.gain.value = 1;
    this.grainBus.connect(this.busSfx);
    this._gB = []; this._gW = [];
    for (let i = 0; i < GRAINS * 2; i++) {
      const brown = i < GRAINS;
      const src = ctx.createBufferSource();
      src.buffer = brown ? this.noiseBuf : this.whiteBuf; src.loop = true;
      src.playbackRate.value = 1;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 500; bp.Q.value = 2;
      const g = ctx.createGain(); g.gain.value = 0.0001;
      const p = ctx.createStereoPanner(); p.pan.value = 0;
      src.connect(bp); bp.connect(g); g.connect(p); p.connect(this.grainBus);
      src.start(ctx.currentTime, (i * 0.71) % src.buffer.duration);
      (brown ? this._gB : this._gW).push({ src, bp, g, p, until: 0 });
    }
  }

  /** Retrigger one pooled grain. `when` may be in the future — that is how the
      debris of a crash and the spray of a landing get scattered in time
      without setTimeout, which an offline render cannot see. */
  _grain(white, when, level, freq, q, dur, rate, pan) {
    const bank = white ? this._gW : this._gB;
    const i = white ? (this._giW = (this._giW + 1) % GRAINS) : (this._giB = (this._giB + 1) % GRAINS);
    const v = bank[i];
    v.until = when + dur;
    v.src.playbackRate.setValueAtTime(rate, when);
    v.bp.frequency.setValueAtTime(freq, when);
    v.bp.Q.setValueAtTime(q, when);
    v.p.pan.setValueAtTime(pan, when);
    const g = v.g.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(0.0001, when);
    g.linearRampToValueAtTime(Math.max(level, 0.0002), when + Math.min(0.004, dur * 0.25));
    g.exponentialRampToValueAtTime(0.0001, when + dur);
  }

  /* ---------------- generative score ----------------
     Two loops sharing one key, crossfaded. Notes are the only place this file
     creates nodes on a clock, and each one reaps itself. */
  _buildMusic() {
    const ctx = this.ctx;
    this.musicDuck = ctx.createGain(); this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.busMusic);
    this.mBus = ctx.createGain(); this.mBus.gain.value = this.musicOn ? 1 : 0.0001;
    this.mBus.connect(this.musicDuck);

    this.menuBus = ctx.createGain(); this.menuBus.gain.value = 0.0001;
    this.raceBus = ctx.createGain(); this.raceBus.gain.value = 0.0001;
    this.menuBus.connect(this.mBus); this.raceBus.connect(this.mBus);

    this.mVerb = ctx.createConvolver(); this.mVerb.buffer = this._impulse(2.6, 2.4);
    this.mVerbG = ctx.createGain(); this.mVerbG.gain.value = 0.42;
    this.menuBus.connect(this.mVerb); this.mVerb.connect(this.mVerbG);
    this.mVerbG.connect(this.musicDuck);

    // shared per-layer filters: notes only ever create an osc and a gain
    this.bassFilt = ctx.createBiquadFilter(); this.bassFilt.type = 'lowpass';
    this.bassFilt.frequency.value = 420; this.bassFilt.Q.value = 4.5;
    this.bassFilt.connect(this.raceBus);
    this.arpFilt = ctx.createBiquadFilter(); this.arpFilt.type = 'bandpass';
    this.arpFilt.frequency.value = 1500; this.arpFilt.Q.value = 1.1;
    this.arpFilt.connect(this.raceBus);
    this.padFilt = ctx.createBiquadFilter(); this.padFilt.type = 'lowpass';
    this.padFilt.frequency.value = 1300; this.padFilt.Q.value = 0.8;
    this.padFilt.connect(this.menuBus);
    this.mBassFilt = ctx.createBiquadFilter(); this.mBassFilt.type = 'lowpass';
    this.mBassFilt.frequency.value = 520; this.mBassFilt.Q.value = 3.0;
    this.mBassFilt.connect(this.menuBus);

    // percussion voices, same trick as the grains so the beat allocates nothing
    this._perc = [];
    for (let i = 0; i < PERCS; i++) {
      const src = ctx.createBufferSource();
      src.buffer = this.whiteBuf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 8000; bp.Q.value = 1.2;
      const g = ctx.createGain(); g.gain.value = 0.0001;
      const p = ctx.createStereoPanner(); p.pan.value = 0;
      src.connect(bp); bp.connect(g); g.connect(p); p.connect(this.raceBus);
      src.start(ctx.currentTime, (i * 1.13) % src.buffer.duration);
      this._perc.push({ src, bp, g, p });
    }
  }

  _percHit(when, freq, q, dur, level, pan) {
    const v = this._perc[this._pi = (this._pi + 1) % PERCS];
    v.bp.frequency.setValueAtTime(freq, when);
    v.bp.Q.setValueAtTime(q, when);
    v.p.pan.setValueAtTime(pan, when);
    const g = v.g.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(0.0001, when);
    g.linearRampToValueAtTime(Math.max(level, 0.0002), when + 0.002);
    g.exponentialRampToValueAtTime(0.0001, when + dur);
  }

  setMusic(on) {
    this.musicOn = !!on;
    if (!this.ready) return;
    this.mBus.gain.setTargetAtTime(on ? 1 : 0.0001, this.now(), 0.4);
  }

  /** 'menu' | 'race' | 'off'. Crossfades; the pattern clock restarts so the new
      loop always enters on its own bar one. */
  setMusicMode(mode) {
    if (mode !== 'menu' && mode !== 'race') mode = 'off';
    if (mode === this.musicMode) return;
    this.musicMode = mode;
    this._step = 0; this._musicT0 = null;
    if (!this.ready) return;
    const t = this.now();
    this.menuBus.gain.setTargetAtTime(mode === 'menu' ? 1 : 0.0001, t, mode === 'menu' ? 0.5 : 0.8);
    this.raceBus.gain.setTargetAtTime(mode === 'race' ? 1 : 0.0001, t, mode === 'race' ? 0.4 : 0.8);
  }

  /** Called every frame with the app clock. Steps are placed on the app clock
      and mapped onto the audio clock with a short lookahead, so a dropped frame
      shifts nothing and an offline render lands on the same grid. */
  musicTick(t, intensity = 0) {
    if (!this.ready || !this.musicOn || this.musicMode === 'off') return;
    const inten = clamp(intensity || 0, 0, 1);
    this._inten += (inten - this._inten) * 0.04;
    const race = this.musicMode === 'race';
    const spb = 60 / (race ? 132 : 100) / 4;              // one sixteenth
    if (this._musicT0 == null) { this._musicT0 = t; this._step = 0; }
    // a pause or a long hitch: keep the pattern position, move the anchor
    if (t < this._musicLastT || t - this._musicLastT > 0.5) {
      this._musicT0 = t - this._step * spb;
    }
    this._musicLastT = t;
    const audioNow = this.now();
    let guard = 0;
    while (this._musicT0 + this._step * spb < t + 0.18 && guard++ < 64) {
      const when = audioNow + (this._musicT0 + this._step * spb - t);
      const at = when < audioNow ? audioNow : when;
      if (race) this._raceStep(this._step, at, this._inten);
      else this._menuStep(this._step, at);
      this._step++;
    }
  }

  /* menu: 100 BPM, bass eighths, one-bar pad, an arp every fourth bar */
  _menuStep(s, when) {
    const k = s & 15, bar = (s >> 4) % 8;
    const ch = MENU_CHORDS[bar], root = ch[0];
    if (k === 0) {                                        // pad, one bar long
      const dur = 60 / 100 * 4;
      for (let i = 0; i < 3; i++) {
        this._pad(this.padFilt, hz(ch[i] + 12), when, dur * 1.05, 0.030 - i * 0.005, i * 7 - 7);
        this._pad(this.padFilt, hz(ch[i] + 12), when, dur * 1.05, 0.024 - i * 0.004, 9 - i * 6);
      }
    }
    if ((k & 1) === 0) {                                  // bass eighths
      const oct = (k === 12) ? 12 : 0;
      this._note(this.mBassFilt, hz(root - 12 + oct), when, 0.26, 0.090, 'sawtooth', 0);
    }
    if (k === 0 || k === 8) this._kick(this.menuBus, when, 0.30);
    if (k === 4 || k === 12) this._percHit(when, 7200, 1.1, 0.035, 0.020, k === 4 ? -0.2 : 0.2);
    if ((bar & 3) === 3 && k >= 8) {                      // sparse lead arp
      if ((k & 1) === 0) {
        const n = ch[(k >> 1) % 3] + 24;
        this._note(this.menuBus, hz(n), when, 0.36, 0.036, 'triangle', 5);
        this._note(this.menuBus, hz(n), when + 0.30, 0.30, 0.016, 'triangle', -5);
      }
    }
  }

  /* race: 132 BPM, layers ADD with intensity — the mix should tell you the
     race got serious before the HUD does */
  _raceStep(s, when, inten) {
    const k = s & 15, bar = (s >> 4) % 4;
    const ch = RACE_CHORDS[bar], root = ch[0];
    if (k === 0 || k === 4 || k === 8 || k === 12) this._kick(this.raceBus, when, 0.42 + inten * 0.16);
    if (inten > 0.55 && k === 14) this._kick(this.raceBus, when, 0.26);
    // hats: eighths always, sixteenths once it heats up
    if ((k & 1) === 0 || inten > 0.32) {
      const acc = (k & 1) === 0 ? 1 : 0.5;
      this._percHit(when, 8200, 1.3, (k & 3) === 2 ? 0.075 : 0.030,
        (0.014 + inten * 0.016) * acc, (k & 2) ? 0.22 : -0.22);
    }
    if (inten > 0.40 && (k === 4 || k === 12)) this._percHit(when, 1700, 0.8, 0.13, 0.055 + inten * 0.03, 0);
    if (BASS_16[k]) {
      const oct = (k === 6 || k === 13) ? 12 : 0;
      this.bassFilt.frequency.setTargetAtTime(340 + inten * 1750, when, 0.08);
      this._note(this.bassFilt, hz(root - 12 + oct), when, 0.16, 0.105, 'sawtooth', 0);
    }
    if (inten > 0.58) {                                   // arp layer
      const n = ch[(s >> 1) % 3] + 24 + (((s >> 3) & 1) ? 12 : 0);
      this._note(this.arpFilt, hz(n), when, 0.10, 0.030 + (inten - 0.58) * 0.05, 'square', 4);
    }
    if (inten > 0.85 && k === 0) {                        // final-lap stab
      for (let i = 0; i < 3; i++) {
        this._note(this.raceBus, hz(ch[i] + 12), when, 0.40, 0.026, 'sawtooth', i * 6 - 6);
      }
    }
  }

  /* ---------------- voices & cleanup ---------------- */
  /** One-shots must not leak: when the source ends, every node in its little
      chain is disconnected and becomes garbage. The rest-array allocation is
      fine here — this is only ever reached from a discrete event, never from
      update(). */
  _reap(src, ...nodes) {
    src.onended = () => {
      try { src.disconnect(); } catch (e) { /* already gone */ }
      for (let i = 0; i < nodes.length; i++) {
        try { nodes[i].disconnect(); } catch (e) { /* already gone */ }
      }
    };
  }

  _note(dest, freq, when, dur, peak, type = 'sine', detune = 0) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + dur + 0.02);
    this._reap(o, g);
    return g;
  }

  _pad(dest, freq, when, dur, peak, detune) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + dur + 0.05);
    this._reap(o, g);
  }

  _kick(dest, when, peak) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(132, when);
    o.frequency.exponentialRampToValueAtTime(44, when + 0.055);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.20);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + 0.24);
    this._reap(o, g);
  }

  /** Noise burst through one filter — the workhorse behind whooshes, crunches
      and splashes. Returns nothing; it cleans itself up. */
  _burst(when, dur, type, f0, f1, q, peak, pan, dest) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.whiteBuf;
    const off = Math.random() * Math.max(0, this.whiteBuf.duration - dur - 0.1);
    const f = ctx.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), when + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), when + Math.min(0.012, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    n.connect(f); f.connect(g); g.connect(p); p.connect(dest || this.busSfx);
    n.start(when, off, dur + 0.05); n.stop(when + dur + 0.05);
    this._reap(n, f, g, p);
  }

  /* ---------------- suspension & impacts ---------------- */
  /** A suspension stop taking a hit — dull, panned to the wheel's side. */
  clunk(force, pan = 0) {
    if (!this.ready || force < 0.08) return;
    const ctx = this.ctx, t = this.now();
    const amp = Math.min(force, 1) * 0.24;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(158 + Math.random() * 60, t);
    o.frequency.exponentialRampToValueAtTime(54, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(amp, 0.0002), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    o.connect(g); g.connect(p); p.connect(this.busSfx);
    o.start(t); o.stop(t + 0.2);
    this._reap(o, g, p);
    this._grain(false, t, amp * 0.5, 620, 1.6, 0.07, 1, clamp(pan, -1, 1));
  }

  /** Suspension out of travel — the clunk plus metal on its stops. */
  bottomOut(force = 1, pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = this.now();
    const f = clamp(force, 0.2, 2);
    this.clunk(Math.min(f, 1) * 0.9, pan);
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(96, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.09);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 340;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.20 * f, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    o.connect(lp); lp.connect(g); g.connect(p); p.connect(this.busSfx);
    o.start(t); o.stop(t + 0.18);
    this._reap(o, lp, g, p);
    // the metallic edge that says "that was the bumpstop, not the damper"
    this._burst(t, 0.13, 'bandpass', 2400, 1500, 7, 0.11 * f, clamp(pan, -1, 1), this.busSfx);
    this._grain(true, t + 0.01, 0.09 * f, 3400, 4, 0.05, 1.4, clamp(pan * 0.6, -1, 1));
  }

  /** Generic heavy landing body — the race flow still uses it. */
  thud(force = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = this.now(), f = Math.min(force, 2);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(124 * (0.7 + force * 0.4), t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.26);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.42 * f, 0.0002), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(g); g.connect(this.busSfx); g.connect(this.verb);
    o.start(t); o.stop(t + 0.5);
    this._reap(o, g);
    this._burst(t, 0.16, 'lowpass', 460, 200, 0.9, 0.20 * f, 0, this.busSfx);
  }

  /** Wheels back on the ground: chassis slam, four dampers, and whatever the
      tyres throw up. Surface picks the spray — mud splats, sand puffs. */
  land(force = 1, surface = null) {
    if (!this.ready) return;
    const t = this.now(), f = clamp(force, 0.15, 2.2);
    const sid = surface == null ? this.surfaceId : surface | 0;
    const s = SURFACES[sid] || SURFACES[SURF.DIRT];
    this.thud(f * 0.9);
    this.clunk(Math.min(f * 0.7, 1), -0.3);
    this.clunk(Math.min(f * 0.7, 1) * 0.85, 0.32);
    const wet = sid === SURF.MUD ? 1 : 0;
    const soft = sid === SURF.SAND || sid === SURF.MUD || sid === SURF.GRASS ? 1 : 0;
    // spray: grains scattered forward in time, so it flies rather than clicks
    const n = Math.min(7, 2 + Math.round(f * 3 * (0.4 + s.dust)));
    for (let i = 0; i < n; i++) {
      const d = i * 0.022 + Math.random() * 0.03;
      this._grain(!soft, t + d, 0.05 * f * (0.5 + Math.random()),
        wet ? 220 + Math.random() * 500 : 500 + Math.random() * 2600,
        wet ? 1.6 : 2.4 + Math.random() * 3,
        wet ? 0.10 : 0.05 + Math.random() * 0.06,
        0.7 + Math.random() * 0.9, (Math.random() * 2 - 1) * 0.8);
    }
    this._burst(t + 0.01, wet ? 0.22 : 0.16, wet ? 'lowpass' : 'highpass',
      wet ? 900 : 700, wet ? 300 : 2200, 0.8, 0.10 * f * (0.4 + s.dust), 0, this.busSfx);
  }

  /** Leaving the lip. Air noise swells as the suspension unloads. */
  jumpWhoosh(force = 1) {
    if (!this.ready) return;
    const t = this.now(), f = clamp(force, 0.2, 1.6);
    this._burst(t, 0.34, 'bandpass', 420, 1500, 1.1, 0.075 * f, -0.25, this.busSfx);
    this._burst(t + 0.02, 0.30, 'bandpass', 520, 1750, 1.0, 0.065 * f, 0.28, this.busSfx);
  }

  /** Panel-on-rock. Layered: a low body hit, three inharmonic metal rings that
      cannot resolve into a note, then debris. Force scales all three. */
  crash(force = 1, pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = this.now();
    const f = clamp(force, 0.15, 2.5), pn = clamp(pan, -1, 1);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.34 * f, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    const op = ctx.createStereoPanner(); op.pan.value = pn * 0.5;
    o.connect(og); og.connect(op); op.connect(this.busSfx); og.connect(this.verb);
    o.start(t); o.stop(t + 0.36);
    this._reap(o, og, op);

    const n = ctx.createBufferSource(); n.buffer = this.whiteBuf;
    const np = ctx.createStereoPanner(); np.pan.value = pn;
    np.connect(this.busSfx); np.connect(this.verb);
    const RINGS = [352, 781, 1287, 2130], RQ = [13, 17, 22, 26], RD = [0.42, 0.34, 0.26, 0.18];
    const chain = [np];
    for (let i = 0; i < 4; i++) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = RINGS[i] * (0.94 + Math.random() * 0.12); bp.Q.value = RQ[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.16 * f / (1 + i * 0.55), 0.0002), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + RD[i] * (0.7 + f * 0.3));
      n.connect(bp); bp.connect(g); g.connect(np);
      chain.push(bp, g);
    }
    n.start(t, Math.random() * 4, 0.6); n.stop(t + 0.6);
    this._reap(n, ...chain);

    const deb = Math.min(6, 2 + Math.round(f * 2.5));
    for (let i = 0; i < deb; i++) {
      this._grain(true, t + 0.03 + i * 0.035 + Math.random() * 0.05,
        0.07 * f * (0.4 + Math.random()), 900 + Math.random() * 3200,
        3 + Math.random() * 6, 0.025 + Math.random() * 0.05,
        0.8 + Math.random(), clamp(pn + (Math.random() - 0.5), -1, 1));
    }
  }

  /** Body dragging. Call every frame while it is happening; it decays out on
      its own about 200 ms after the calls stop. */
  scrape(surface = SURF.ROCK, amount = 1) {
    if (!this.ready) return;
    this._scrapeSurf = surface | 0;
    this._scrapeReq = Math.max(this._scrapeReq, clamp(amount, 0, 1));
  }

  /* ---------------- race cues ---------------- */
  ping(freq = 880, dur = 0.5, peak = 0.16, type = 'sine', when = null) {
    if (!this.ready) return;
    const t = when == null ? this.now() : when;
    const g = this._note(this.busSfx, freq, t, dur, peak, type, 0);
    g.connect(this.verb);
  }

  /* ---- arcade layer ----
     Bodies live in core/audio-arcade.js so this file stays under the house line;
     they take the Audio instance and use the same private synthesis kit.

     Six cues left with the roulette in wave 8 — itemRoll, itemThrow, itemDrop,
     towSnap, sledLaunch and stormHit spoke for a seven-item inventory that no
     longer exists. The rocket/nitro cues that replace them (contract 8.7) are
     P5's, and every caller in arsenal.js already guards them, so the arsenal
     is silent rather than broken until P5 lands. */
  boostTier(tier) { ARCADE_SFX.boostTier(this, tier); }
  boostFire(tier, gain) { ARCADE_SFX.boostFire(this, tier, gain); }
  spinOut(gain) { ARCADE_SFX.spinOut(this, gain); }

  /** 3, 2, 1 — deliberately low and dry so GO reads as a release. */
  countdownBeep(n = 3) {
    if (!this.ready) return;
    const t = this.now(), i = clamp(3 - (n | 0), 0, 2);
    const f = 196 * Math.pow(2, i / 24);          // barely rising: tension, not melody
    this._note(this.busSfx, f, t, 0.20, 0.17, 'square', 0);
    this._note(this.busSfx, f * 0.5, t, 0.16, 0.10, 'sine', 0);
    this._burst(t, 0.05, 'bandpass', 1600, 900, 3, 0.035, 0, this.busSfx);
  }

  /** GO — a bright major stab an octave above the beeps, with a lift under it. */
  countdownGo() {
    if (!this.ready) return;
    const t = this.now();
    const CH = [587.33, 739.99, 880.0, 1174.66];  // D major
    for (let i = 0; i < CH.length; i++) {
      const g = this._note(this.busSfx, CH[i], t, 0.55 - i * 0.06, 0.115 - i * 0.018, 'sawtooth', i * 7 - 10);
      g.connect(this.verb);
      this._note(this.busSfx, CH[i], t, 0.28, 0.055, 'square', -6);
    }
    this._note(this.busSfx, 146.83, t, 0.45, 0.20, 'triangle', 0);
    this._burst(t, 0.30, 'highpass', 1200, 5200, 0.8, 0.10, 0, this.busSfx);
  }

  /** Two notes, fast, up — has to survive being heard 14 times a lap. */
  checkpoint() {
    if (!this.ready) return;
    const t = this.now();
    this._note(this.busSfx, 1174.66, t, 0.10, 0.085, 'triangle', 0);
    const g = this._note(this.busSfx, 1567.98, t + 0.065, 0.22, 0.075, 'triangle', 0);
    g.connect(this.verb);
    this._note(this.busSfx, 3135.96, t + 0.065, 0.10, 0.018, 'sine', 0);
  }

  /** A struck bell is inharmonic — the partials below are what stops this
      sounding like a synth pad with a fast attack. `final` adds the riser. */
  lapBell(final = false) {
    if (!this.ready) return;
    const t = this.now(), base = final ? 784 : 659.25;
    const P = [1, 2.01, 2.76, 5.4, 8.93], A = [0.10, 0.055, 0.040, 0.020, 0.011];
    const D = [1.7, 1.2, 0.95, 0.55, 0.32];
    for (let i = 0; i < P.length; i++) {
      const g = this._note(this.busSfx, base * P[i], t, D[i], A[i], 'sine', (i - 2) * 4);
      if (i < 3) g.connect(this.verb);
    }
    if (final) {
      this._burst(t, 1.15, 'bandpass', 300, 3600, 2.2, 0.085, 0, this.busSfx);
      const g = this._note(this.busSfx, 196, t, 1.2, 0.075, 'sawtooth', 0);
      g.connect(this.verb);
      this._note(this.busSfx, 392, t + 0.9, 0.6, 0.06, 'square', 0);
      this._note(this.busSfx, 587.33, t + 1.05, 0.7, 0.05, 'square', 0);
    }
  }

  /** Won: a rising major phrase over a held chord. Otherwise: three notes that
      settle rather than celebrate — you finished, that is all. */
  finishFanfare(won = false) {
    if (!this.ready) return;
    const t = this.now();
    if (won) {
      const MEL = [587.33, 739.99, 880.0, 1174.66], OFF = [0, 0.13, 0.26, 0.42];
      for (let i = 0; i < 4; i++) {
        const g = this._note(this.busSfx, MEL[i], t + OFF[i], i === 3 ? 1.5 : 0.24, 0.13, 'sawtooth', -7);
        g.connect(this.verb);
        this._note(this.busSfx, MEL[i], t + OFF[i], i === 3 ? 1.4 : 0.22, 0.09, 'sawtooth', 8);
        this._note(this.busSfx, MEL[i] * 0.5, t + OFF[i], 0.30, 0.07, 'triangle', 0);
      }
      const CH = [146.83, 293.66, 440.0, 554.37];
      for (let i = 0; i < 4; i++) {
        const g = this._note(this.busSfx, CH[i], t + 0.42, 1.7, 0.075 - i * 0.008, 'sawtooth', i * 5 - 8);
        g.connect(this.verb);
      }
      this._burst(t + 0.40, 0.5, 'highpass', 2000, 6000, 0.7, 0.055, 0, this.busSfx);
    } else {
      const MEL = [440.0, 523.25, 587.33], OFF = [0, 0.17, 0.34];
      for (let i = 0; i < 3; i++) {
        const g = this._note(this.busSfx, MEL[i], t + OFF[i], i === 2 ? 1.1 : 0.26, 0.085, 'triangle', 0);
        g.connect(this.verb);
      }
      const CH = [146.83, 220.0, 293.66];
      for (let i = 0; i < 3; i++) this._note(this.busSfx, CH[i], t + 0.34, 1.3, 0.045, 'sine', 4);
    }
  }

  /** Position changes happen mid-corner: they must land in half a second and
      never mask the engine. A short whoosh with a tick on the landing. */
  positionUp() {
    if (!this.ready) return;
    const t = this.now();
    this._burst(t, 0.22, 'bandpass', 500, 2400, 2.4, 0.075, -0.2, this.busSfx);
    this._note(this.busSfx, 1318.51, t + 0.19, 0.11, 0.070, 'triangle', 0);
    this._note(this.busSfx, 1975.53, t + 0.19, 0.07, 0.030, 'sine', 0);
  }
  positionDown() {
    if (!this.ready) return;
    const t = this.now();
    this._burst(t, 0.24, 'bandpass', 2200, 420, 2.4, 0.070, 0.2, this.busSfx);
    this._note(this.busSfx, 440, t + 0.20, 0.14, 0.065, 'triangle', 0);
    this._note(this.busSfx, 293.66, t + 0.20, 0.16, 0.045, 'sine', 0);
  }

  /** Something unlocked: a pentatonic run in bell tones, no root resolution so
      it reads as "more to come". */
  unlockJingle() {
    if (!this.ready) return;
    const t = this.now();
    const N = [587.33, 698.46, 880.0, 1046.5, 1318.51, 1760.0, 2093.0];
    for (let i = 0; i < N.length; i++) {
      const w = t + i * 0.075;
      const g = this._note(this.busSfx, N[i], w, 0.9 - i * 0.06, 0.070 - i * 0.006, 'sine', 0);
      g.connect(this.verb);
      this._note(this.busSfx, N[i] * 2.76, w, 0.22, 0.014, 'sine', 0);
    }
    this._burst(t + 0.45, 0.6, 'highpass', 3000, 7000, 0.7, 0.030, 0, this.busSfx);
  }

  /** Wrong way — two low buzzes, unpleasant on purpose but not painful. */
  wrongWay() {
    if (!this.ready) return;
    const ctx = this.ctx, t = this.now();
    for (let i = 0; i < 2; i++) {
      const w = t + i * 0.22;
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 104;
      const m = ctx.createOscillator(); m.type = 'square'; m.frequency.value = 27;
      const mg = ctx.createGain(); mg.gain.value = 22;
      m.connect(mg); mg.connect(o.frequency);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 620; lp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, w);
      g.gain.linearRampToValueAtTime(0.15, w + 0.012);
      g.gain.setValueAtTime(0.15, w + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, w + 0.17);
      o.connect(lp); lp.connect(g); g.connect(this.busSfx);
      o.start(w); o.stop(w + 0.2); m.start(w); m.stop(w + 0.2);
      this._reap(o, lp, g); this._reap(m, mg);
    }
  }

  /** Respawn: a swish down and back up, with an arrival tick. */
  resetWhoosh() {
    if (!this.ready) return;
    const t = this.now();
    this._burst(t, 0.26, 'bandpass', 2600, 380, 1.8, 0.085, 0.5, this.busSfx);
    this._burst(t + 0.20, 0.30, 'bandpass', 400, 3000, 1.8, 0.075, -0.5, this.busSfx);
    const g = this._note(this.busSfx, 880, t, 0.28, 0.055, 'sine', 0);
    g.connect(this.verb);
    this._note(this.busSfx, 1760, t + 0.46, 0.12, 0.050, 'triangle', 0);
  }

  ui(kind = 'tick') {
    if (!this.ready) return;
    const t = this.now();
    if (kind === 'tick') this.ping(1900, 0.05, 0.045, 'square');
    else if (kind === 'hover') this.ping(2600, 0.03, 0.016, 'sine');
    else if (kind === 'ok') {
      this._note(this.busSfx, 880, t, 0.09, 0.070, 'square', 0);
      this._note(this.busSfx, 1320, t + 0.07, 0.14, 0.060, 'square', 0);
    } else if (kind === 'back') {
      this._note(this.busSfx, 780, t, 0.07, 0.050, 'square', 0);
      this._note(this.busSfx, 520, t + 0.06, 0.12, 0.045, 'square', 0);
    } else if (kind === 'bad') this.ping(220, 0.20, 0.10, 'sawtooth');
    else if (kind === 'warn') {
      this._note(this.busSfx, 660, t, 0.10, 0.080, 'square', 0);
      this._note(this.busSfx, 660, t + 0.16, 0.10, 0.080, 'square', 0);
    }
  }

  /* ---------------- gear change ----------------
     Real shift: torque drops, revs fall, the clutch bites again. Heard from
     outside that is a dip and a catch, roughly 100 ms end to end. */
  _shift(t, rpm) {
    const d = this.engDuck.gain;
    d.cancelScheduledValues(t);
    d.setTargetAtTime(0.30, t, 0.010);
    d.setTargetAtTime(1.0, t + 0.055, 0.045);
    this._grain(false, t + 0.005, 0.055 + rpm * 0.05, 300 + rpm * 260, 2.2, 0.05, 1, -0.1);
    this._burst(t + 0.06, 0.09, 'bandpass', 900 + rpm * 800, 400, 2.4,
      0.035 + rpm * 0.035, 0.12, this.driveBus);
  }

  /* ---------------- per-frame mix ----------------
     Nothing below allocates: every node exists already, every value is a
     primitive, and every ramp is a setTargetAtTime on a cached AudioParam. */
  update(dt, st) {
    if (!this.ready || !st) return;
    const t = this.now();
    const d = dt > 0.1 ? 0.1 : (dt > 0 ? dt : 0.016);
    this._clock += d;
    const k = 0.055, kf = 0.09;

    const rpm = clamp(st.rpm || 0, 0, 1);
    const load = clamp(st.load || 0, 0, 1);
    const speed = Math.abs(st.speed || 0);
    const slipLat = clamp(st.slipLat || 0, 0, 1);
    const slipLong = clamp(st.slipLong || 0, 0, 1);
    const contacts = st.contacts == null ? 4 : st.contacts;
    const cf = clamp(contacts * 0.25, 0, 1);
    const sid = st.surface == null ? this.surfaceId : (st.surface | 0);
    this.surfaceId = sid;
    const surf = SURFACES[sid] || SURFACES[SURF.DIRT];
    const drv = this.driving ? 1 : 0;

    const airT = st.airborne ? 1 : 0;
    this._air += (airT - this._air) * Math.min(1, d * 9);
    const air = this._air, grounded = 1 - air;

    const fam = this.fam;
    const spd = clamp(speed / 34, 0, 1);            // normalised road speed
    const roll = Math.pow(spd, 0.75) * cf * grounded * drv;
    const wheelHz = clamp(speed / 2.4, 0.5, 26);    // ~0.38 m rolling radius

    /* --- engine --- */
    /* Exponential rev map: a sweep should move by constant semitones, not
       constant hertz, or the top of the range sounds like it stops climbing.
       28→190 Hz of firing frequency is 840→5700 crank rpm on a four-cylinder
       four-stroke (two firings per revolution); `rev` spreads the families
       either side of that, so the wedge tops out near 6400. */
    const f0 = 28 * Math.pow(6.786, rpm) * fam.rev;
    this.pOsc.frequency.setTargetAtTime(f0, t, 0.035);
    for (let i = 0; i < 2; i++) this.inOsc[i].frequency.setTargetAtTime(f0 * 0.5, t, 0.035);
    // unloaded in the air, the engine loses its bottom end and gets shouty
    const bodyCut = 1 - air * 0.45;
    this.form[0].g.gain.setTargetAtTime(fam.a[0] * (0.75 + load * 0.25) * bodyCut, t, kf);
    this.form[1].g.gain.setTargetAtTime(fam.a[1] * (0.42 + load * 0.72 + rpm * 0.12), t, kf);
    this.form[2].g.gain.setTargetAtTime(fam.a[2] * (0.26 + load * 0.85 + rpm * 0.50), t, kf);
    this.form[3].g.gain.setTargetAtTime(fam.a[3] * (0.10 + load * 0.70 + rpm * 0.95), t, kf);
    this.form[2].bp.Q.setTargetAtTime(fam.q[2] * (1 + load * 0.35), t, 0.15);
    this.form[3].bp.Q.setTargetAtTime(fam.q[3] * (1 + load * 0.30), t, 0.15);
    this.boomF.frequency.setTargetAtTime(105 + rpm * 90, t, kf);
    this.boomG.gain.setTargetAtTime(0.5 * fam.boom * (0.6 + load * 0.6) * bodyCut, t, kf);
    // idle must be present at rpm 0.35 with no throttle — hence the floor
    this.engBus.gain.setTargetAtTime(
      (0.050 + load * 0.105 + rpm * 0.080 + rpm * load * 0.045) * drv, t, k);

    this.inLp.frequency.setTargetAtTime(280 + load * 1500 + rpm * 950, t, kf);
    this.inG.gain.setTargetAtTime(
      fam.intake * fam.growl * (0.020 + load * 0.075) * (0.35 + rpm * 0.65) * drv, t, k);

    // turbo spools slowly and hangs on lift — that lag is the whole character
    this.whOsc.frequency.setTargetAtTime(1050 + Math.pow(rpm, 1.5) * 5200, t, 0.22);
    this.whBp.frequency.setTargetAtTime(1300 + rpm * 5200, t, 0.22);
    this.whG.gain.setTargetAtTime(
      fam.whistle * Math.pow(rpm, 2.6) * (0.25 + load * 0.75) * 0.030 * drv, t, 0.18);

    /* --- gear change: a fast rpm drop with the throttle still down --- */
    const ri = this._rpmRingI;
    this._rpmRing[ri] = rpm; this._rpmRingT[ri] = this._clock;
    this._rpmRingI = (ri + 1) % this._rpmRing.length;
    this._shiftCd -= d;
    if (load > 0.5 && drv && this._shiftCd <= 0) {
      let peak = rpm;
      for (let i = 0; i < this._rpmRing.length; i++) {
        if (this._clock - this._rpmRingT[i] <= 0.080 && this._rpmRing[i] > peak) peak = this._rpmRing[i];
      }
      if (peak - rpm > 0.25) { this._shift(t, rpm); this._shiftCd = 0.30; }
    }

    /* --- exhaust crackle on lift --- */
    const dLoad = (load - this._prevLoad) / d;
    this._prevLoad = load;
    this._liftCd -= d;
    if (dLoad < -3.0 && rpm > 0.50 && drv && this._liftCd <= 0) {
      this._liftT = 0.14 + rpm * 0.26; this._liftCd = 0.34;
      if (fam.whistle > 0) {   // blow-off: the wastegate dumping boost
        this._burst(t, 0.20, 'highpass', 2600, 1200, 0.9, 0.075 * fam.whistle * rpm, 0.1, this.driveBus);
      }
    }
    if (this._liftT > 0) {
      this._liftT -= d;
      this._crackAcc += d * (10 + rpm * 34) * fam.crackle;
      let n = this._crackAcc | 0;
      this._crackAcc -= n;
      if (n > 3) n = 3;
      while (n-- > 0) {
        if (Math.random() < 0.72) {
          this._grain(true, t, (0.035 + rpm * 0.075) * fam.crackle,
            900 + Math.random() * 2600, 2.5 + Math.random() * 4,
            0.012 + Math.random() * 0.03, 0.9 + Math.random() * 0.7,
            (Math.random() * 2 - 1) * 0.4);
        }
      }
    }

    /* --- surface crossfade --- */
    const w = this._surfW, ks = Math.min(1, d * 6);
    for (let i = 0; i < w.length; i++) w[i] += ((i === sid ? 1 : 0) - w[i]) * ks;
    const wRoad = w[SURF.ROAD], wDirt = w[SURF.DIRT], wSand = w[SURF.SAND];
    const wMud = w[SURF.MUD], wRock = w[SURF.ROCK], wGrass = w[SURF.GRASS], wLava = w[SURF.LAVA];
    const grit = wDirt + wRock;
    const bright = grit > 0.001 ? wRock / grit : 0;     // dirt → rock blend

    this.rdBp.frequency.setTargetAtTime(240 + spd * 760, t, 0.12);
    this.rdPk.gain.setTargetAtTime(spd * spd * 9, t, 0.12);
    this.rdPk.frequency.setTargetAtTime(950 + spd * 900, t, 0.12);
    this.rdG.gain.setTargetAtTime(wRoad * roll * 0.085, t, k);

    this.gtBp.frequency.setTargetAtTime(200 + spd * 420 + bright * 400, t, 0.12);
    this.gtSh.gain.setTargetAtTime(-12 + bright * 10 + spd * 4, t, 0.12);
    this.gtG.gain.setTargetAtTime(grit * roll * 0.075, t, k);

    this.sdHp.frequency.setTargetAtTime(620 + spd * 1100, t, 0.12);
    this.sdG.gain.setTargetAtTime(wSand * roll * 0.085, t, k);

    const mudBase = wMud * roll * 0.115;
    this.mdLp.frequency.setTargetAtTime(380 + spd * 320, t, 0.12);
    this.mdG.gain.setTargetAtTime(mudBase, t, k);
    this.mdLfo.frequency.setTargetAtTime(wheelHz, t, 0.08);
    this.mdLfo2.frequency.setTargetAtTime(wheelHz * 1.53, t, 0.08);
    this.mdLfoG.gain.setTargetAtTime(mudBase * 0.70, t, k);
    this.mdLfoG2.gain.setTargetAtTime(mudBase * 0.32, t, k);

    const grBase = wGrass * roll * 0.060;
    this.grBp.frequency.setTargetAtTime(1300 + spd * 1500, t, 0.12);
    this.grG.gain.setTargetAtTime(grBase, t, k);
    this.grLfo.frequency.setTargetAtTime(wheelHz * 0.5, t, 0.08);
    this.grLfoG.gain.setTargetAtTime(grBase * 0.45, t, k);

    this.lvHp.frequency.setTargetAtTime(2500 + spd * 1400, t, 0.12);
    this.lvG.gain.setTargetAtTime(wLava * (0.012 + roll * 0.030) * cf * drv, t, k);

    /* --- grain scatter: loose surfaces only --- */
    // rate and weight both climb with speed, so gravel gets denser AND heavier
    const scatter = (grit * (0.55 + spd * 0.9) + wSand * 0.30 + wLava * 0.45) * roll;
    if (scatter > 0.02 || (slipLong > 0.15 && roll > 0.05)) {
      // the ceiling matters: past ~70 impacts a second the pool starts stealing
      // voices from itself and distinct stones smear into a hiss
      let rate = (12 + spd * 50 + slipLong * 38) * (scatter + slipLong * 0.30 * roll);
      if (rate > GRAIN_RATE_MAX) rate = GRAIN_RATE_MAX;
      this._grainAcc += d * rate;
      let n = this._grainAcc | 0;
      this._grainAcc -= n;
      if (n > 3) n = 3;
      while (n-- > 0) {
        const r = Math.random();
        const pan = (Math.random() * 2 - 1) * 0.8;
        if (wLava > 0.45 && r < 0.5) {                  // lava crackle
          this._grain(true, t, 0.030 + spd * 0.030, 1600 + Math.random() * 3400,
            4 + Math.random() * 6, 0.012 + Math.random() * 0.025, 1.1, pan);
        } else if (wSand > 0.45) {                      // sand whump
          this._grain(false, t, 0.030 + spd * 0.055, 62 + Math.random() * 90,
            1.5, 0.09 + Math.random() * 0.10, 0.5 + Math.random() * 0.4, pan);
        } else {                                        // dirt / rock stones
          const white = Math.random() < 0.35 + bright * 0.45;
          this._grain(white, t, 0.026 + spd * 0.048 + slipLong * 0.040,
            180 + Math.random() * (700 + bright * 2600 + spd * 900),
            1.4 + Math.random() * (2.6 + bright * 3),
            0.030 + Math.random() * (0.075 - bright * 0.035),
            0.5 + Math.random() * (1.0 + spd * 0.6), pan);
        }
      }
    } else this._grainAcc = 0;

    /* --- tyres ---
       skid decides which of the two slip voices gets the energy: tarmac and
       rock sing, sand and mud just rumble. */
    const skid = surf.skid;
    const lat = Math.max(0, slipLat - 0.16);
    const sqAmt = Math.pow(clamp(lat / 0.62, 0, 1), 1.25) * skid
      * clamp((speed - 3.5) / 9, 0, 1) * cf * grounded * drv;
    const sqF = 1020 + spd * 220 + lat * 340;
    this.sqBp1.frequency.setTargetAtTime(sqF, t, 0.06);
    this.sqBp2.frequency.setTargetAtTime(sqF * 1.53, t, 0.06);
    this.sqSine.frequency.setTargetAtTime(sqF, t, 0.06);
    this.sqG.gain.setTargetAtTime(sqAmt * 0.115, t, 0.05);
    this.sqSineG.gain.setTargetAtTime(Math.pow(sqAmt, 1.6) * 0.030, t, 0.05);

    const scrub = (lat * (1 - skid) * 1.5 + slipLong * 0.55) * roll;
    this.scrBp.frequency.setTargetAtTime(300 + spd * 240, t, 0.1);
    this.scrG.gain.setTargetAtTime(clamp(scrub, 0, 1.2) * 0.070, t, 0.06);

    /* --- air --- */
    const wv = Math.pow(clamp((speed - 18) / 22, 0, 1), 1.55);
    this.wnd[0].bp.frequency.setTargetAtTime(300 + speed * 15, t, 0.2);
    this.wnd[1].bp.frequency.setTargetAtTime(370 + speed * 13, t, 0.2);
    this.wndLp.frequency.setTargetAtTime(120 + speed * 2.4, t, 0.2);
    this.wndBus.gain.setTargetAtTime(wv * (1 + air * 0.65) * 0.115 * drv, t, 0.1);

    /* --- body scrape --- */
    const scReq = Math.max(clamp(st.scrape || 0, 0, 1), this._scrapeReq);
    this._scrapeReq = Math.max(0, this._scrapeReq - d * 5);
    const scSurf = SURFACES[this._scrapeSurf] || surf;
    this.scLp.frequency.setTargetAtTime(600 + spd * 900, t, 0.1);
    this.scBp.frequency.setTargetAtTime(700 + scSurf.skid * 1800 + spd * 700, t, 0.1);
    this.scG.gain.setTargetAtTime(scReq * (0.045 + spd * 0.085) * drv, t, 0.07);

    /* --- nearest rival --- */
    const rr = st.rivalRpm;
    if (rr != null && rr >= 0) {
      const rf = 28 * Math.pow(6.786, clamp(rr, 0, 1)) * fam.rev;
      this.rvOsc.frequency.setTargetAtTime(rf, t, 0.06);
      this.rvBp.frequency.setTargetAtTime(420 + clamp(rr, 0, 1) * 900, t, 0.1);
      this.rvPan.pan.setTargetAtTime(clamp(st.rivalPan || 0, -1, 1), t, 0.12);
      this.rvG.gain.setTargetAtTime((0.020 + clamp(rr, 0, 1) * 0.030) * drv, t, 0.15);
    } else {
      this.rvG.gain.setTargetAtTime(0.0001, t, 0.20);
    }

    /* --- music sits under the car: about -6 dB when the engine is working --- */
    const act = clamp(rpm * 0.35 + load * 0.65, 0, 1) * drv;
    this.musicDuck.gain.setTargetAtTime(1 - act * 0.5, t, 0.16);
  }

  setVolumes(sfx, music) {
    this.volSfx = sfx; this.volMusic = music;
    if (!this.ready) return;
    const t = this.now();
    this.busSfx.gain.setTargetAtTime(sfx, t, 0.1);
    this.busMusic.gain.setTargetAtTime(music, t, 0.1);
  }
}

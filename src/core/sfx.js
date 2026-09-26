import {countdownBuffer} from './countdown-tone.js';
import { SFX_MIX } from './audio-mix.js';
/* ============================================================
   RALLY ROAD RASH — sampled one-shots over the synth fallback
   ------------------------------------------------------------
   Contract 8.7. `assets/audio-manifest.json`'s `sfx` map names every
   sample; a missing entry, a 404, or a file that fails to decode just
   means play() returns false for that name and the caller's existing
   synth code runs instead — the same "optional, procedural fallback"
   rule as every other asset in this repo, applied one cue at a time.

   Voices are a fixed pool of GainNode -> StereoPannerNode -> busSfx
   triples, round-robin, stealing the one due to finish soonest once the
   pool is full: the same "recycle nodes, do not grow without bound" rule
   as `_grain()` in audio.js. A one-shot AudioBufferSourceNode cannot be
   restarted, so play() builds a fresh source per call and connects it
   into whichever voice's gain/pan it is handed — cheap, and it is the
   gain/pan pair that is actually the limited resource here.
   ============================================================ */

const MAX_VOICES = 16;
const PEAK_DBFS = -3;              // decode-time normalisation target
const RATE_JITTER = 0.04;          // +-4%

/** Every sfx cue name audio.js can request, whether or not a file exists
    for it yet. dev/audio-check.mjs cross-references this against
    assets/audio-manifest.json so a typo on either side fails the build
    instead of playing the synth fallback forever in silence about why. */
export const SFX_CUES = [
  'rocketFire', 'rocketFlyby', 'explodeNear', 'explodeFar',
  'ammoPickup', 'nitroPickup', 'nitroBurst', 'ammoEmpty', 'crateBreak',
  'crashHeavy', 'crashLight', 'landHeavy', 'landSoft', 'metalScrape',
  'spinOutSkid', 'checkpointChime', 'lapBell', 'finalLapHorn',
  'countdownBeep', 'countdownGo', 'finishCrowd',
  'landHopper','landRidgeback','landRedline','landHornet','metalImpactA','metalImpactB',
  'positionUp', 'positionDown', 'uiTick', 'uiConfirm', 'uiBack',
  'uiHover','uiReject','uiWarn','gearShift','suspensionImpact',
];

export class SfxBank {
  constructor(audio) {
    this.audio = audio;
    this.buffers = new Map();      // name -> AudioBuffer, peak-normalised
    this.ready = false;this.lastPlayed=new Map();
    this._voices = [];             // built lazily, capped at MAX_VOICES
  }

  /** Called once from Audio.init(), never before. Never throws: a
      missing manifest or an undecodable file just leaves that name out
      of `buffers`, and play() reports it as "no sample" like any other
      miss. */
  async load(manifestUrl = 'assets/audio-manifest.json') {
    const A = this.audio;
    if (!A.ctx) return;
    let manifest = null;
    try {
      const res = await fetch(manifestUrl, { cache: 'no-cache' });
      if (res.ok) manifest = await res.json();
    } catch { /* no manifest is the normal pre-launch case, not an error */ }
    const sfx = manifest && manifest.sfx;
    if (!sfx || typeof sfx !== 'object') { this.ready = true; return; }

    const base = manifestUrl.replace(/[^/]*$/, '');
    await Promise.all(Object.keys(sfx).map(async (name) => {
      const spec = sfx[name] || {};
      if (!spec.url) return;
      try {
        const res = await fetch(base + spec.url);
        if (!res.ok) return;
        const buf = await A.ctx.decodeAudioData(await res.arrayBuffer());
        if (buf) this.buffers.set(name, normalisePeak(buf, PEAK_DBFS));
      } catch { /* missing or undecodable -> that name has no sample */ }
    }));
    this.ready = true;
  }

  _voice() {
    const ctx = this.audio.ctx;
    if (this._voices.length < MAX_VOICES) {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      gain.connect(pan); pan.connect(this.audio.busSfx);
      const v = { gain, pan, until: 0 };
      this._voices.push(v);
      return v;
    }
    let best = this._voices[0];
    for (let i = 1; i < this._voices.length; i++) if (this._voices[i].until < best.until) best = this._voices[i];
    return best;
  }

  /** Play `name` if a sample exists for it.
      @param {object} opts  gain (default 1), pan (-1..1, default 0),
        rate (playback-rate multiplier before jitter, default 1),
        when (schedule time, default audio.now()).
      @returns {boolean} true if a sample actually played — the caller's
        one line is `if (this._sfx.play('name', {...})) return;` followed
        by the existing synth code, unchanged. */
  play(name, opts = {}) {
    const countdown=name==='countdownBeep'||name==='countdownGo';
    if (!this.ready && !countdown) return false;
    const buf = this.buffers.get(name) || (countdown && this.audio.ctx ? countdownBuffer(this.audio.ctx,name==='countdownGo') : null);
    if (!buf) return false;
    const A = this.audio, ctx = A.ctx;
    if (!ctx) return false;

    const when = opts.when != null ? opts.when : A.now();
    const profile=SFX_MIX[name]||[1,3,0];
    const cooldownKey=opts.cooldownKey||name;
    if(when-(this.lastPlayed.get(cooldownKey)??-Infinity)<profile[2])return true;
    this.lastPlayed.set(cooldownKey,when);
    const gain = (opts.gain != null ? opts.gain : 1)*profile[0];
    let pan = opts.pan != null ? opts.pan : 0;
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    const jitter = countdown ? 1 : 1 + (Math.random() * 2 - 1) * RATE_JITTER;
    const rate = (opts.rate != null ? opts.rate : 1) * jitter;

    const v = this._voice();
    if(v.source){try{v.source.stop(when);v.source.disconnect();}catch{}}
    const src = ctx.createBufferSource();v.source=src;
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(v.gain);
    v.gain.gain.cancelScheduledValues(when);
    v.gain.gain.setValueAtTime(Math.max(gain, 0.0001), when);
    v.pan.pan.setValueAtTime(pan, when);
    const duration=Math.min(buf.duration/rate,profile[1]);
    v.gain.gain.setValueAtTime(Math.max(gain,.0001),when+Math.max(0,duration-.012));
    v.gain.gain.linearRampToValueAtTime(.0001,when+duration);
    src.start(when,0,duration*rate);
    v.until = when + duration;
    src.onended = () => { if(v.source===src)v.source=null;try { src.disconnect(); } catch { /* already gone */ } };
    return true;
  }
}

/** Scans every channel for the true sample peak and scales the buffer so
    it lands at `dbfs` — done once at decode, never per play(), so play()
    stays a schedule-only hot path with no per-call analysis. Mutates the
    buffer in place; AudioBuffer data is a plain Float32Array, and this
    runs long before anything else reads it. */
function normalisePeak(buffer, dbfs) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
  }
  if (peak <= 0.0001) return buffer;               // silence — nothing to scale
  const target = Math.pow(10, dbfs / 20);
  const k = target / peak;
  if (k > 0.99 && k < 1.01) return buffer;          // already close enough, skip the pass
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buffer;
}

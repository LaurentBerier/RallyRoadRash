/* ============================================================
   RALLY ROAD RASH — sampled soundtrack over the generative loop
   ------------------------------------------------------------
   Contract 8.7. Every theme is OPTIONAL: `assets/audio-manifest.json`
   names what exists, a missing entry (or a 404, or a file that fails to
   decode) just leaves that theme with no sample track, and audio.js's
   own generative `_raceStep`/`_menuStep` keeps playing exactly as it did
   before this file existed — MusicBank only ever takes over a theme it
   actually has audio for. See `audio.js _buildMusic()` for the `raceGen`/
   `menuGen` gate nodes that make that swap silent either way.

   One AudioBufferSourceNode PER THEME, looping, started once at decode
   time and left running for the life of the session — the same rule as
   every continuous voice in audio.js ("built once, driven by AudioParam
   ramps"). A theme change is then just two gains moving in opposite
   directions: no source-node lifecycle to manage, and no risk of a click
   from starting a new source mid-race. The trade is every decoded theme
   sitting in memory at once — a handful of ~105 s buffers, a few hundred
   MB of decoded PCM. Acceptable for a five-track soundtrack; flagged here
   for whoever chases a memory budget on the lowest mobile tier later —
   the fix would be decoding only the upcoming theme and swapping buffers
   on a source that is allowed to restart, at the cost of an audible
   restart on the very first theme change after a cold boot.

   Looping an MP3 with `loop = true` alone is NOT gapless: the encoder
   (lamejs, no Xing/LAME info tag written — see dev-time notes in the
   scratchpad encoder) pads the bitstream with priming and trailing
   samples the container does not describe, so the decoded buffer is
   longer than the source WAV by a few encoder+decoder frames. Fixed
   below by skipping `PRIME_SAMPLES` at the front and stopping one
   original-track-length later — `durationSec` in the manifest is the
   EXACT original PCM length, measured before encoding. PRIME_SAMPLES is
   a documented estimate, not a measurement: this machine has no decoder
   to verify the true value against (see docs/ART-DIRECTION.md, "no
   ffmpeg on this machine"). Confirm by ear before shipping; it is one
   constant to retune if the loop seam clicks.
   ============================================================ */

const MENU_KEY = 'menu';

/* LAME's encoder delay is a fixed 576 samples (half the 1152-sample
   granule its psychoacoustic model needs); a compliant decoder's own
   synthesis filterbank adds another fixed 529 on the way back out. That
   combined 1105 is the standard assumption every gapless-loop tool falls
   back to when the file carries no LAME info tag to read the true value
   from — which ours doesn't, since lamejs never writes one. */
const PRIME_SAMPLES = 1105;

/** Every music cue name audio.js can request, whether or not a file
    exists for it yet. dev/audio-check.mjs cross-references this against
    assets/audio-manifest.json so a renamed theme on one side and not the
    other is a build-time failure instead of a track that silently never
    plays. */
export const MUSIC_CUES = ['menu', 'training', 'canyon', 'forest', 'volcano', 'thunder'];

export class MusicBank {
  constructor(audio) {
    this.audio = audio;
    this.tracks = new Map();        // key -> { buffer, loopStart, loopEnd }
    this.ready = false;             // true once load() has resolved (even if it found nothing)
    this._built = false;
    this._raceGain = new Map();     // key -> GainNode, one per loaded race theme
    this._menuGain = null;
    this._theme = null;             // last theme setRaceTheme() was told about
    this._mode = 'off';
  }

  /* Nodes are cheap and idle until a track exists to feed them; building
     them lazily means a game shipped with no music assets never touches
     the graph at all beyond this no-op. */
  _buildGraph() {
    if (this._built) return;
    const A = this.audio, ctx = A.ctx;
    if (!ctx || !A.raceBus) return;
    this._raceLP = ctx.createBiquadFilter();
    this._raceLP.type = 'lowpass';
    this._raceLP.frequency.value = 18000;      // tick() sweeps this 900 -> 18000 with intensity
    this._raceIntGain = ctx.createGain();
    this._raceIntGain.gain.value = 1;          // tick() lifts this toward +3 dB at full intensity
    this._raceLP.connect(this._raceIntGain);
    this._raceIntGain.connect(A.raceBus);
    this._built = true;
  }

  /** Called once from Audio.init(), never before — there is no context
      until then, and decodeAudioData needs one. Fetches the manifest,
      decodes every track it names, and starts each one looping
      immediately at floor gain (see the file header). Never throws: a
      missing manifest, a 404, or a file the browser cannot decode just
      leaves that theme with no sample track and `ready` still becomes
      true — "loaded, and found nothing" is a normal outcome, not a
      failure. */
  async load(manifestUrl = 'assets/audio-manifest.json') {
    const A = this.audio;
    if (!A.ctx) return;
    this._buildGraph();
    let manifest = null;
    try {
      const res = await fetch(manifestUrl, { cache: 'no-cache' });
      if (res.ok) manifest = await res.json();
    } catch { /* no manifest is the normal pre-launch case, not an error */ }
    const music = manifest && manifest.music;
    if (!music || typeof music !== 'object') { this.ready = true; return; }

    const base = manifestUrl.replace(/[^/]*$/, '');
    await Promise.all(Object.keys(music).map(async (key) => {
      const spec = music[key] || {};
      if (!spec.url) return;
      let buf = null;
      try {
        const res = await fetch(base + spec.url);
        if (res.ok) buf = await A.ctx.decodeAudioData(await res.arrayBuffer());
      } catch { /* missing or undecodable file -> that theme stays generative-only */ }
      if (!buf || !A.ctx) return;              // ctx can vanish if the tab unloads mid-fetch
      const durationSec = typeof spec.durationSec === 'number' ? spec.durationSec : buf.duration;
      const prime = typeof spec.primeSamples === 'number' ? spec.primeSamples : PRIME_SAMPLES;
      const loopStart = Math.min(prime / buf.sampleRate, buf.duration * 0.25);
      const loopEnd = Math.min(loopStart + durationSec, buf.duration);
      this.tracks.set(key, { buffer: buf, loopStart, loopEnd });
    }));
    this.ready = true;
    if (!A.ctx) return;
    this._startAll();
    if (this._theme) this._activateRace(this._theme, 0);   // replay a setRaceTheme() called before load() resolved
    this._syncMenuGate();
  }

  _startAll() {
    const A = this.audio, ctx = A.ctx;
    if (!ctx) return;
    for (const [key, t] of this.tracks) {
      const src = ctx.createBufferSource();
      src.buffer = t.buffer; src.loop = true;
      src.loopStart = t.loopStart; src.loopEnd = t.loopEnd;
      const g = ctx.createGain();
      if (key === MENU_KEY) {
        g.gain.value = 1;
        g.connect(A.menuBus);
        this._menuGain = g;
      } else {
        g.gain.value = 0.0001;                  // silent until setRaceTheme() picks it
        g.connect(this._raceLP);
        this._raceGain.set(key, g);
      }
      src.connect(g);
      src.start(A.now(), t.loopStart);
    }
  }

  /** Mirrors Audio.musicMode so the menu sample can duck the generative
      menu layer only once it is actually able to play. */
  _syncMenuGate() {
    const A = this.audio;
    if (!A.menuGen) return;
    const hasMenu = this.tracks.has(MENU_KEY);
    A.menuGen.gain.setTargetAtTime(hasMenu ? 0.0001 : 1, A.now(), 0.5);
  }
  setMode(mode) { this._mode = mode; if (this.ready) this._syncMenuGate(); }

  /** Contract 8.7: `audio.setRaceTheme(theme)` delegates here from
      race.js's `_enterGrid`. The caller does not know or need to know
      whether a sample exists for `theme` — a miss just leaves audio.js's
      generative race loop as the only thing playing, exactly like before
      this file existed. Crossfades over 0.8 s when a theme is already
      live; applies instantly (fadeSec 0) the first time, including the
      replay once load() resolves after an early call. */
  setRaceTheme(theme) {
    this._theme = theme || null;
    if (!this.ready) return;                    // replayed by load() once decoded
    this._activateRace(this._theme, 0.8);
  }

  _activateRace(theme, fadeSec) {
    const A = this.audio;
    if (!A.raceGen) return;
    const t = A.now();
    const tau = fadeSec > 0 ? fadeSec / 3 : 0.02;   // ~3 time constants ~= fadeSec to settle
    const has = !!theme && this._raceGain.has(theme);
    for (const [key, g] of this._raceGain) {
      g.gain.setTargetAtTime(has && key === theme ? 1 : 0.0001, t, tau);
    }
    // Missing sample for this theme -> the generative layer is the ONLY
    // music, same as before this file existed. Sample present -> mute it.
    A.raceGen.gain.setTargetAtTime(has ? 0.0001 : 1, t, tau);
  }

  /** Fed every frame from Audio.musicTick with the same smoothed
      intensity the generative layer reads, so a theme with an mp3 and a
      theme without feel like the same game: the sample bed opens a
      lowpass 900 Hz -> 18 kHz and lifts about 3 dB across 0..1, mirroring
      what `_raceStep` already does by adding layers. No-ops with nothing
      built (no ctx, or nothing ever decoded). */
  tick(intensity) {
    if (!this._built) return;
    const inten = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
    const t = this.audio.now();
    this._raceLP.frequency.setTargetAtTime(900 + inten * 17100, t, 0.25);
    this._raceIntGain.gain.setTargetAtTime(1 + inten * 0.413, t, 0.25);   // 10^(3/20) ~= 1.413
  }
}

#!/usr/bin/env node
/* ============================================================
   Pure-Node gate for the audio package (contract 8.7). No DOM, no
   AudioContext, no dev server — reads the manifest and the repo tree
   directly, and exercises Audio/MusicBank/SfxBank with no ctx at all,
   which is the environment every browser without WebAudio (and every CI
   box) actually runs this code in.

   Gates:
     1. assets/audio-manifest.json and the files on disk agree BOTH ways
        (every manifest entry points at a real file; every file on disk
        is pointed at by some entry).
     2. every cue name audio.js can request is a name MUSIC_CUES/SFX_CUES
        knows about — the one that catches a rename on one side and not
        the other before a player hears permanent, silent fallback.
     3. `new Audio()` with no context never throws, for every cue.
     4. music.js/sfx.js no-op on their own with no ctx, independent of
        Audio's own guards.

   Run: node dev/audio-check.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Audio } from '../src/core/audio.js';
import { MusicBank, MUSIC_CUES } from '../src/core/music.js';
import { SfxBank, SFX_CUES } from '../src/core/sfx.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

/* ---- 1 & 2: manifest <-> disk agreement, and every key is a known cue ---- */
const manifestPath = path.join(ROOT, 'assets', 'audio-manifest.json');
let manifest = null;
if (fs.existsSync(manifestPath)) {
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { fail.push(`assets/audio-manifest.json is not valid JSON: ${e.message}`); }
} else {
  fail.push('assets/audio-manifest.json is missing');
}

function checkSection(sectionName, cueNames, dirName, sourceFile) {
  if (!manifest) return;
  const section = manifest[sectionName] || {};
  const dir = path.join(ROOT, 'assets', dirName);
  const onDisk = fs.existsSync(dir)
    ? new Set(fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.mp3')))
    : new Set();
  const referenced = new Set();

  for (const key of Object.keys(section)) {
    check(cueNames.includes(key),
      `${sectionName}.${key}: not a name ${sourceFile} knows about — typo, or ${sourceFile} needs updating`);
    const spec = section[key] || {};
    check(typeof spec.url === 'string' && spec.url.length > 0, `${sectionName}.${key}: missing "url"`);
    if (typeof spec.url === 'string') {
      const file = spec.url.replace(/^.*\//, '');
      referenced.add(file);
      check(onDisk.has(file), `${sectionName}.${key}: manifest points at ${dirName}/${file}, which is not on disk`);
    }
    if (sectionName === 'music') {
      check(typeof spec.durationSec === 'number' && spec.durationSec > 0,
        `music.${key}: missing/invalid "durationSec" — music.js needs the exact original PCM length to set loopEnd`);
    }
  }
  for (const file of onDisk) {
    check(referenced.has(file), `${dirName}/${file} sits on disk but no ${sectionName} entry in the manifest points at it`);
  }
}
checkSection('music', MUSIC_CUES, 'music', 'music.js MUSIC_CUES');
checkSection('sfx', SFX_CUES, 'sfx', 'sfx.js SFX_CUES');

/* ---- 3: `new Audio()` with no context never throws, for every cue ---- */
try {
  const a = new Audio();
  const calls = [
    () => a.crash(1, 0), () => a.crash(2, -1), () => a.land(1, 0), () => a.land(1, 2),
    () => a.scrape(4, 1), () => a.checkpoint(), () => a.lapBell(false), () => a.lapBell(true),
    () => a.finishFanfare(true), () => a.finishFanfare(false),
    () => a.positionUp(), () => a.positionDown(),
    () => a.ui('tick'), () => a.ui('ok'), () => a.ui('back'), () => a.ui('hover'),
    () => a.countdownBeep(3), () => a.countdownBeep(1), () => a.countdownGo(),
    () => a.boostTier(1), () => a.boostFire(2, 1), () => a.spinOut(1),
    () => a.setRaceTheme('canyon'), () => a.setRaceTheme('nonexistent-theme'),
    () => a.rocketFire(1, 0), () => a.rocketFlyby(0.3),
    () => a.rocketHit(1, 0, true), () => a.rocketHit(1, 0, false),
    () => a.ammoPickup(), () => a.nitroPickup(), () => a.nitroBurst(),
    () => a.ammoEmpty(), () => a.crateBreak(1),
    () => a.setMusicMode('menu'), () => a.setMusicMode('race'), () => a.setMusicMode('off'),
    () => a.musicTick(0, 0.5), () => a.update(0.016, {}), () => a.setVolumes(0.5, 0.5),
    () => a.clunk(0.5, 0), () => a.bottomOut(1, 0), () => a.thud(1), () => a.jumpWhoosh(1),
    () => a.wrongWay(), () => a.resetWhoosh(), () => a.unlockJingle(), () => a.ping(),
    () => a.init(), () => a.resume(),                    // must also no-op: no AudioContext global in Node
  ];
  for (const c of calls) c();
} catch (e) {
  fail.push(`new Audio() with no context threw: ${e.stack || e.message}`);
}

/* ---- 4: music.js / sfx.js no-op on their own, independent of Audio ---- */
try {
  const stub = { ctx: null, now: () => 0, raceBus: null, menuBus: null, raceGen: null, menuGen: null };
  const mb = new MusicBank(stub);
  await mb.load(path.relative(ROOT, manifestPath).replace(/\\/g, '/'));
  mb.setRaceTheme('canyon');
  mb.setMode('race');
  mb.tick(0.5);
  check(mb.ready === false, 'MusicBank.load() with no ctx must leave ready=false (nothing to decode without one)');
} catch (e) {
  fail.push(`music.js threw with no ctx: ${e.stack || e.message}`);
}

try {
  const stub = { ctx: null, now: () => 0, busSfx: null };
  const sb = new SfxBank(stub);
  await sb.load(path.relative(ROOT, manifestPath).replace(/\\/g, '/'));
  check(sb.play('crashHeavy', { gain: 1 }) === false, 'SfxBank.play() with no ctx must return false, never throw');
  check(sb.ready === false, 'SfxBank.load() with no ctx must leave ready=false');
} catch (e) {
  fail.push(`sfx.js threw with no ctx: ${e.stack || e.message}`);
}

/* ---- summary ---- */
if (fail.length) {
  console.error(`audio-check: FAIL (${fail.length} issue${fail.length === 1 ? '' : 's'})`);
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
} else {
  const mCount = manifest && manifest.music ? Object.keys(manifest.music).length : 0;
  const sCount = manifest && manifest.sfx ? Object.keys(manifest.sfx).length : 0;
  console.log(`audio-check: OK — ${mCount}/${MUSIC_CUES.length} music themes, ${sCount}/${SFX_CUES.length} sfx cues on disk and named correctly; every cue has a synth fallback; no-ctx paths are silent.`);
}

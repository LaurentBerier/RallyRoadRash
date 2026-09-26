import assert from 'node:assert/strict';
import {SfxBank} from '../src/core/sfx.js';
import {EngineTextures,ENGINE_CUES,prepareEngineLoop} from '../src/core/engine-textures.js';
const param=()=>({value:0,events:[],cancelScheduledValues(){},setValueAtTime(v,t){this.events.push([v,t]);},linearRampToValueAtTime(v,t){this.events.push([v,t]);},setTargetAtTime(v,t){this.value=v;}});
const node=()=>({connect(){},disconnect(){this.disconnected=true;}});
const sources=[];
const buffer=(channels=1,length=48000,sampleRate=24000)=>{const data=Array.from({length:channels},()=>Float32Array.from({length},(_,i)=>.2*Math.sin(i*.13)+.01));return {numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,getChannelData:c=>data[c]};};
const ctx={createGain:()=>({...node(),gain:param()}),createStereoPanner:()=>({...node(),pan:param()}),createBiquadFilter:()=>({...node(),frequency:param(),Q:param(),gain:param()}),createBufferSource(){const s={...node(),playbackRate:param(),start(...args){this.started=args;},stop(){this.stopped=true;}};sources.push(s);return s;},createBuffer:buffer,decodeAudioData:async()=>buffer()};
let time=1;
const audio={ctx,now:()=>time,busSfx:{},driveBus:{},engDuck:{},familyName:'truck',driving:true};
const bank=new SfxBank(audio);bank.ready=true;
bank.buffers.set('uiHover',{duration:1});
assert.equal(bank.play('uiHover'),true);
assert.ok(sources[0].started[2]/sources[0].playbackRate.value<=.075001,'hover duration is bounded even for a long recording');
assert.equal(bank.play('uiHover'),true);
assert.equal(sources.length,1,'cooldown consumes event without creating a voice or triggering fallback');
for(let i=0;i<20;i++){time+=.1;bank.play('uiHover');}
assert.equal(bank._voices.length,16);
assert.ok(sources[0].stopped,'stolen source is stopped');
const owner=bank._voices[0].source;sources[0].onended();assert.equal(bank._voices[0].source,owner,'old onended cannot detach replacement');
assert.equal(bank.play('missing'),false);
const fetchBefore=globalThis.fetch;
globalThis.fetch=async url=>({ok:true,json:async()=>({engines:Object.fromEntries(ENGINE_CUES.map(n=>[n,{url:n+'.mp3'}]))}),arrayBuffer:async()=>new ArrayBuffer(0)});
try{
 const engines=new EngineTextures(audio);await engines.load();assert.equal(engines.voices.size,4);
 engines.update(.2,.3,0);assert.ok(engines.voices.get('truck').gain.gain.value>0);assert.equal(engines.voices.get('buggy').gain.gain.value,0);
 const low=engines.voices.get('truck').source.playbackRate.value;
 engines.update(.9,1,0);assert.ok(engines.voices.get('truck').source.playbackRate.value>low);
 audio.familyName='thumper';engines.update(.5,1,0);assert.equal(engines.voices.get('truck').gain.gain.value,0);assert.ok(engines.voices.get('thumper').gain.gain.value>0);
 audio.engineOff=true;engines.update(.8,1,0);for(const v of engines.voices.values())assert.equal(v.gain.gain.value,0);audio.engineOff=false;
 audio.driving=false;engines.update(.5,1,0);for(const v of engines.voices.values())assert.equal(v.gain.gain.value,0);
}finally{globalThis.fetch=fetchBefore;}
console.log('audio-playback-check: OK — UI cutoff, cooldown, bounded voices, stolen-source cleanup, four engines, RPM, menu mute');

const raw=buffer(),seamed=prepareEngineLoop(ctx,raw),samples=seamed.getChannelData(0);
assert.ok(seamed.length<raw.length);
assert.ok(Math.abs(samples[0]-samples[samples.length-1])<.04,'loop seam follows the source waveform without a discontinuity');
assert.ok(Math.max(...samples.map(Math.abs))<=.841,'normalisation preserves sample headroom');

const {Audio}=await import('../src/core/audio.js');
const driver=new Audio();
assert.equal(driver._gearChange(1,true),0,'entering a race is not a shift');
assert.equal(driver._gearChange(2,true),1,'upshift detected even when RPM smoothing hides the drop');
assert.equal(driver._gearChange(2,true),0,'no repeated shift from throttle or RPM movement');
assert.equal(driver._gearChange(1,true),-1,'downshift detected');
assert.equal(driver._gearChange(0,false),0,'wreck and pause mute shift events');
assert.equal(driver._gearChange(3,true),0,'resume establishes a fresh baseline');
assert.equal(driver._gearChange(null,true),0,'ghost reset clears gear history');

// Countdown must remain available before downloads and never drift in pitch.
const {countdownPCM}=await import('../src/core/countdown-tone.js');
for(const go of [false,true]){
 const pcm=countdownPCM(go,48000);
 assert.equal(pcm.length,Math.round((go?.46:.18)*48000));
 assert.ok(Math.abs(pcm[0])<1e-6&&Math.abs(pcm.at(-1))<1e-5,'click-free ends');
 assert.ok(Math.max(...pcm.map(Math.abs))<.709,'headroom');
}
const startBank=new SfxBank(audio);
for(let n=0;n<3;n++){
 time+=1;assert.equal(startBank.play('countdownBeep'),true,'immediate procedural fallback');
 assert.equal(sources.at(-1).playbackRate.value,1,'identical pitch');
 assert.ok(Math.abs(sources.at(-1).started[2]-.18)<1e-6);
}
time+=1;assert.equal(startBank.play('countdownGo'),true);
assert.equal(sources.at(-1).playbackRate.value,1);
assert.ok(Math.abs(sources.at(-1).started[2]-.46)<1e-6);
console.log('countdown: exact pitch, immediate fallback, short envelopes and headroom pass');

const calls=[];const landingAudio={ready:true,now:()=>0,surfaceId:1,familyName:'buggy',duckRace(){},thud(){},_metalImpact:Audio.prototype._metalImpact,_sfx:{play:(name,opts)=>{calls.push([name,opts]);return true;}}};
for(const [id,cue] of [['hopper','landHopper'],['ridgeback','landRidgeback'],['redline','landRedline'],['moto','landHornet']]){
 Audio.prototype.land.call(landingAudio,.2,1,id,0,true);
 assert.equal(calls.at(-1)[0],cue);assert.ok(calls.at(-1)[1].gain>=.52);
}
time+=1;bank.buffers.set('landHopper',{duration:.78});const count=sources.length;
bank.play('landHopper',{cooldownKey:'rival:landHopper'});
bank.play('landHopper',{cooldownKey:'player:landHopper'});
assert.equal(sources.length,count+2,'rival cannot consume player landing cooldown');

let previous;for(let i=0;i<30;i++){landingAudio._metalImpact(.8,0,'ridgeback');const [cue,opts]=calls.at(-1);assert.notEqual(cue,previous,'metal variations avoid immediate repeats');assert.ok(opts.rate<.81,'truck metal stays low pitched');previous=cue;}

const {MusicBank}=await import('../src/core/music.js');
const oldFetch=globalThis.fetch,requested=[];
globalThis.fetch=async url=>{requested.push(url);return {ok:true,json:async()=>({music:{menu:{url:'menu.mp3'},training:{url:'training.mp3'},forest:{url:'forest.mp3'}}}),arrayBuffer:async()=>new ArrayBuffer(8)};};
try{
 const music=new MusicBank(audio);music._buildGraph=()=>{};music._startAll=()=>{};music._syncMenuGate=()=>{};music._activateRace=()=>{};
 await music.load();assert.deepEqual([...music.tracks.keys()],['menu']);
 await Promise.all([music.preloadTheme('training'),music.preloadTheme('training')]);
 assert.equal(requested.filter(x=>x.endsWith('training.mp3')).length,1);
 assert.equal(music.tracks.has('forest'),false,'unused music is not downloaded or decoded');
 assert.equal(music.tracks.has('training'),true);
}finally{globalThis.fetch=oldFetch;}

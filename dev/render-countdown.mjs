import {mkdirSync,writeFileSync} from 'node:fs';
import {countdownPCM} from '../src/core/countdown-tone.js';
const rate=48000,dir='.sandscape/countdown';mkdirSync(dir,{recursive:true});
function wav(name,pcm){
 const b=Buffer.alloc(44+pcm.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(pcm.length*2,40);
 for(let i=0;i<pcm.length;i++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,pcm[i]))*32767),44+i*2);
 writeFileSync(`${dir}/${name}.wav`,b);
}
const beep=countdownPCM(false,rate),go=countdownPCM(true,rate);
wav('countdown-beep',beep);wav('countdown-go',go);
const sequence=new Float32Array(rate*4);
for(let n=0;n<4;n++){
 const cue=n===3?go:beep,gain=n===3?.9*.64:.8*.54;
 for(let i=0;i<cue.length;i++)sequence[n*rate+i]=cue[i]*gain;
}
wav('countdown-preview',sequence);
console.log('Rendered identical 660 Hz start tones and 1320 Hz GO, 180/460 ms.');

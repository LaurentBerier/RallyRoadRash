// Recordings are the primary engine voice; synthesis remains a quiet body layer
// and a complete fallback if assets cannot be decoded. All nodes are persistent.
export const ENGINE_CUES = ['buggy', 'truck', 'wedge', 'thumper'];
export const ENGINE_PROFILE = {
  buggy:   {base:.62,octaves:1.55,hp:48,presence:1350,boost:.8,body:2.0,bodyHz:200,open:3400,gain:1.00},
  truck:   {base:.60,octaves:1.28,hp:35,presence:750, boost:.5,body:3.0,bodyHz:170,open:2600,gain:1.08},
  wedge:   {base:.64,octaves:1.60,hp:55,presence:1750,boost:1.0,body:2.0,bodyHz:240,open:4200,gain:.97},
  thumper: {base:.72,octaves:1.55,hp:70,presence:2100,boost:1.2,body:1.0,bodyHz:280,open:4600,gain:1.02},
};

// Remove encoder edges, overlap the seam, then level-match RMS rather than
// peaks. Linear crossfade avoids a correlated +3dB bump on steady engine tones.
export function prepareEngineLoop(ctx, input) {
  const fade=Math.min(Math.round(input.sampleRate*.09),Math.floor(input.length/8));
  const length=input.length-fade;
  if(fade<2)return input;
  const output=ctx.createBuffer(input.numberOfChannels,length,input.sampleRate);
  let power=0,peak=0;
  for(let c=0;c<input.numberOfChannels;c++){
    const src=input.getChannelData(c),dst=output.getChannelData(c);
    let mean=0;for(let i=0;i<src.length;i++)mean+=src[i];mean/=src.length;
    for(let i=0;i<length;i++){
      let v=src[i+fade];
      if(i>=length-fade){const j=i-(length-fade),f=j/(fade-1);v=v*(1-f)+src[j]*f;}
      dst[i]=v-mean;power+=dst[i]*dst[i];peak=Math.max(peak,Math.abs(dst[i]));
    }
  }
  const rms=Math.sqrt(power/(length*input.numberOfChannels));
  const level=Math.min(Math.pow(10,-14/20)/Math.max(rms,1e-5),.84/Math.max(peak,1e-5),4);
  for(let c=0;c<output.numberOfChannels;c++){const dst=output.getChannelData(c);for(let i=0;i<length;i++)dst[i]*=level;}
  return output;
}

export class EngineTextures {
  constructor(audio) { this.audio=audio;this.voices=new Map(); }
  hasVoice(name){return this.voices.has(name);}
  async load() {
    const A=this.audio;if(!A.ctx)return;
    try {
      const res=await fetch('assets/audio-manifest.json',{cache:'no-cache'});
      const manifest=await res.json();
      await Promise.all(ENGINE_CUES.map(async name=>{
        try {
          const path=manifest.engines?.[name]?.url;if(!path)return;
          const r=await fetch('assets/'+path);if(!r.ok)return;
          const raw=await A.ctx.decodeAudioData(await r.arrayBuffer());
          const buffer=prepareEngineLoop(A.ctx,raw),P=ENGINE_PROFILE[name];
          const source=A.ctx.createBufferSource(),gain=A.ctx.createGain();
          const hp=A.ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=P.hp;hp.Q.value=.7;
          const body=A.ctx.createBiquadFilter();body.type='lowshelf';body.frequency.value=P.bodyHz;body.gain.value=P.body;
          const presence=A.ctx.createBiquadFilter();presence.type='peaking';presence.frequency.value=P.presence;presence.Q.value=.65;presence.gain.value=P.boost;
          const filter=A.ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=2400;filter.Q.value=.65;
          source.buffer=buffer;source.loop=true;gain.gain.value=0;
          source.connect(hp);hp.connect(body);body.connect(presence);presence.connect(filter);filter.connect(gain);
          // Share the clutch envelope with the synthetic engine: real torque
          // interruption and recovery, rather than a gear click over a flat loop.
          gain.connect(A.engDuck);source.start();
          this.voices.set(name,{source,gain,filter,hp,body,presence});
        }catch{/* The live synthesized engine remains a complete fallback. */}
      }));
    }catch{/* Optional recordings. */}
  }
  update(rpm,load,air) {
    const A=this.audio,t=A.now();
    for(const [name,v] of this.voices){
      const active=name===A.familyName&&A.driving&&!A.engineOff,P=ENGINE_PROFILE[name];
      const level=(.32+load*.70+rpm*.30)*P.gain;
      v.gain.gain.setTargetAtTime(active?level:0,t,active?.045:.025);
      if(active){
        v.source.playbackRate.setTargetAtTime(P.base*Math.pow(2,rpm*P.octaves),t,.035);
        // Lift-off darkens the exhaust but leaves the mechanical engine audible.
        v.filter.frequency.setTargetAtTime(1100+rpm*1800+load*P.open+air*700,t,.06);
      }
    }
  }
}

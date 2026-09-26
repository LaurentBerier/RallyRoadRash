// Classic start-light signal. Deterministic PCM, no noise or pitch randomisation.
// Also used to render the shipped samples, so missing assets sound identical.
export function countdownPCM(go=false,sampleRate=48000){
  const duration=go?.46:.18, frequency=go?1320:660;
  const pcm=new Float32Array(Math.round(duration*sampleRate));
  const attack=.005,release=go?.18:.07;
  let peak=0;
  for(let i=0;i<pcm.length;i++){
    const t=i/sampleRate,phase=2*Math.PI*frequency*t;
    const a=Math.min(1,t/attack),r=Math.min(1,(duration-t)/release);
    const envelope=Math.sin(a*Math.PI/2)**2*Math.sin(r*Math.PI/2)**2;
    // A restrained harmonic gives small speakers definition without buzzer rasp.
    const tone=Math.sin(phase)+.13*Math.sin(phase*2)+.025*Math.sin(phase*3);
    pcm[i]=tone*envelope;peak=Math.max(peak,Math.abs(pcm[i]));
  }
  for(let i=0;i<pcm.length;i++)pcm[i]*=Math.pow(10,-3/20)/peak;
  return pcm;
}

const cache=new WeakMap();
export function countdownBuffer(ctx,go=false){
  let pair=cache.get(ctx);if(!pair){pair=[];cache.set(ctx,pair);}
  const i=go?1:0;if(pair[i])return pair[i];
  const pcm=countdownPCM(go,ctx.sampleRate||48000);
  const buffer=ctx.createBuffer(1,pcm.length,ctx.sampleRate||48000);
  buffer.getChannelData(0).set(pcm);pair[i]=buffer;return buffer;
}

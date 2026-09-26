import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const source=(await readFile('src/core/assets.js','utf8')).replace("from 'three'",`from '${pathToFileURL(process.cwd()+'/vendor/three/three.module.js').href}'`);
const timers=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>timers(fn,ms===15000?30:ms,...args);
const decoded=[];
globalThis.Image=class {
 set src(url) { this.url=url; if(url.endsWith('slow.webp')||!url)return; queueMicrotask(()=>url.endsWith('missing.webp')?this.onerror?.():this.onload?.()); }
 async decode() { await new Promise(r=>timers(r,5)); decoded.push(this.url); }
};
globalThis.fetch=async()=>({ok:true,json:async()=>({art:{kind:'color',url:'ok.webp'},missing:{kind:'color',url:'missing.webp'},slow:{kind:'color',url:'slow.webp'},car:{kind:'model',url:'car.glb'}})});
try {
 const {loadAssets}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const progress=[];const map=await loadAssets('assets/manifest.json',p=>progress.push(p));
 assert.deepEqual(decoded,['assets/ok.webp']);assert.ok(map.get('art').isTexture);
 assert.equal(map.get('missing'),null);assert.equal(map.get('slow'),null);
 assert.equal(map.get('car'),'assets/car.glb');assert.equal(progress.at(-1),1);
 assert.ok(progress.every((p,i)=>i===0||p>=progress[i-1]));
 globalThis.fetch=async()=>({ok:true,json:async()=>({
  normal:{kind:'data-tile',url:'normal-2k.webp',lowUrl:'normal-1k.webp'},
  ground:{kind:'tile',url:'ground-2k.webp',lowUrl:'ground-1k.webp'}
 })});
 const low=await loadAssets('assets/manifest.json',()=>{},'LOW');
 assert.equal(low.get('normal').image.url,'assets/normal-1k.webp');
 assert.equal(low.get('normal').colorSpace,'','normal data must remain linear');
 assert.equal(low.get('ground').colorSpace,'srgb');
 assert.equal(low.get('normal').wrapS,low.get('ground').wrapS,'both tile kinds repeat');
 const high=await loadAssets('assets/manifest.json',()=>{},'HIGH');
 assert.equal(high.get('normal').image.url,'assets/normal-2k.webp');
 globalThis.fetch=async()=>({ok:true,json:async()=>({
  'art/menu':{kind:'color',url:'menu.webp'},'art/loading':{kind:'color',url:'menu.webp'},
  'terrain/forest':{kind:'tile',url:'forest.webp'},car:{kind:'model',url:'car.glb'}
 })});
 const before=decoded.length;
 const staged=await loadAssets('assets/manifest.json',()=>{},'HIGH',id=>id.startsWith('art/'));
 assert.equal(decoded.length-before,1,'menu aliases decode once');
 assert.equal(staged.get('art/menu'),staged.get('art/loading'));
 assert.equal(staged.has('terrain/forest'),false,'other tracks do not block first menu');
 assert.equal(staged.get('car'),'assets/car.glb','model URLs available before downloads');
 await Promise.all([staged.ensure(id=>id.startsWith('terrain/')),staged.ensure(id=>id.startsWith('terrain/'))]);
 assert.equal(decoded.length-before,2,'concurrent preload requests share work');
 assert.ok(staged.get('terrain/forest').isTexture);
 console.log('PASS: decoded readiness, missing image fallback, bounded slow request, progress, lazy model URL');
} finally { globalThis.setTimeout=timers; }

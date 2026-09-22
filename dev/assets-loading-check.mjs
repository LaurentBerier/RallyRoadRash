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
 console.log('PASS: decoded readiness, missing image fallback, bounded slow request, progress, lazy model URL');
} finally { globalThis.setTimeout=timers; }

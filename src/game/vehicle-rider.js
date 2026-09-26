import * as THREE from 'three';
let source=null,models=null;
export function setRiderSource(fn){source=typeof fn==='function'?fn:null;}
export function attachRider(v,spec){
  if(spec.id!=='moto'||!source||typeof window==='undefined')return;
  const url=source();if(!url)return;
  const generation=v._riderGeneration=(v._riderGeneration||0)+1;
  v._riderLoading=true;
  v._riderReady=import('../core/models.js').then(m=>{models=m;return m.loadModel(url);}).then(group=>{
    if(!group)return;
    if(!v.root||generation!==v._riderGeneration){models.disposeModel(group);return;}
    group.name='Hornet textured motocross rider';
    // Meshy posed character, +Z forward. Feet on the pegs; body follows the
    // existing bike lean/suspension hierarchy without an extra animation loop.
    const box=new THREE.Box3().setFromObject(group),size=box.getSize(new THREE.Vector3());
    const scale=1.35/size.y;
    group.scale.setScalar(scale);
    group.position.set(-(box.min.x+box.max.x)*.5*scale,.52-spec.comHeight-box.min.y*scale,-.04);
    group.traverse(o=>{
      if(!o.isMesh)return;
      o.castShadow=true;o.receiveShadow=true;
      for(const m of Array.isArray(o.material)?o.material:[o.material]){
        if(!m)continue;m.envMapIntensity=.75;
        v._ghost?.mats.push(m);
        if(v._ghost?.k>0){m.transparent=true;m.opacity=1-.58*v._ghost.k;}
      }
    });
    v.chassis.add(group);v.rider=group;
    for(const mesh of v._riderMeshes||[])mesh.visible=false;
  }).catch(e=>console.warn('[rider] keeping fallback:',e.message)).finally(()=>{v._riderLoading=false;});
}
export function detachRider(v){
  v._riderGeneration=(v._riderGeneration||0)+1;
  if(v.rider)models?.disposeModel(v.rider);
  v.rider=null;
}

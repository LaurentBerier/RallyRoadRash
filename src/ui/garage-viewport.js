import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Vehicle } from '../game/vehicle.js';
import { VEHICLES, VEHICLE_BY_ID } from '../game/vehicles.js';
import { SURF } from '../world/surfaces.js';
import { buildGarageInterior } from './garage-interior.js';
import { addShowroomDetails } from './garage-vehicle-detail.js';

export const GARAGE_PAD={heightAt:()=>0,normalAt:(x,z,e,out)=>out.set(0,1,0),surfaceAt:()=>SURF.ROAD,onRoad:()=>1};
const PAD=GARAGE_PAD;
const NO_CTL={throttle:0,steer:0,brake:0,handbrake:false,boost:false,roll:0};
let assetJob;
function loadTexture(url, color, repeat) {
  return new Promise(resolve=>{
    let settled=false;
    const timer=setTimeout(()=>{settled=true;resolve(null);},20000);
    new THREE.TextureLoader().load(url,t=>{
      if(settled){t.dispose();return;} settled=true;clearTimeout(timer);
      t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;
      t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(...repeat);
      t.anisotropy=8;resolve(t);
    },undefined,()=>{if(!settled){settled=true;clearTimeout(timer);resolve(null);}});
  });
}
export function loadGarageAssets() {
  if(assetJob)return assetJob;
  assetJob=(async()=>{
    const assets={};
    await Promise.all([
      ...['floor','wall'].flatMap((group)=>['Color','Normal','Rough'].map(async(channel)=>{
        const file=(group==='floor'?'concrete_floor':'concrete')+'-'+({Color:'Diffuse',Normal:'nor_gl',Rough:'Rough'}[channel])+'.webp';
        assets[group+channel]=await loadTexture('assets/garage/'+file,channel==='Color',group==='floor'?[6,7]:[6,3]);
      })),
      (async()=>{try{
        const res=await fetch('assets/garage/workshop.hdr',{signal:AbortSignal.timeout(20000)});
        if(!res.ok)throw Error('HDR unavailable');
        const p=new RGBELoader().parse(await res.arrayBuffer());
        const t=new THREE.DataTexture(p.data,p.width,p.height,THREE.RGBAFormat,p.type);
        t.mapping=THREE.EquirectangularReflectionMapping;t.colorSpace=THREE.LinearSRGBColorSpace;
        t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;t.flipY=true;t.needsUpdate=true;
        assets.hdr=t;
      }catch{assets.hdr=null;}})(),
    ]);
    return assets;
  })();
  return assetJob;
}

/** An isolated, antialiased product renderer, never downscaled by race FPS. */
export class GarageViewport {
  constructor(host) {
    this.host=host;this.disposed=false;this.assetsReady=false;this.generation=0;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x10151c);
    this.scene.fog=new THREE.Fog(0x141922,24,48);
    this.camera=new THREE.PerspectiveCamera(38,1,.1,70);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.9;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    const canvas=this.renderer.domElement;canvas.className='garage-canvas';canvas.tabIndex=0;
    canvas.setAttribute('aria-label','3D vehicle view. Drag to orbit, scroll or pinch to zoom. Arrow keys orbit; plus and minus zoom.');
    this.host.prepend(canvas);host.removeAttribute('aria-hidden');
    this.controls=new OrbitControls(this.camera,canvas);
    this.controls.enableDamping=true;this.controls.dampingFactor=.1;this.controls.enablePan=false;
    this.controls.minDistance=3.4;this.controls.maxDistance=13;
    this.controls.minPolarAngle=.3;this.controls.maxPolarAngle=Math.PI*.48;
    this.controls.zoomSpeed=.65;this.controls.rotateSpeed=.65;
    this.controls.autoRotate=false;
    this.toolbar=document.createElement('div');this.toolbar.className='garage-camera-tools';
    this.toolbar.innerHTML='<span>DRAG TO ORBIT · SCROLL / PINCH TO ZOOM</span><button type="button" aria-label="Zoom in">+</button><button type="button" aria-label="Zoom out">−</button><button type="button" aria-label="Reset vehicle camera">RESET VIEW</button>';
    this.toolbar.addEventListener('pointerdown',e=>e.stopPropagation());
    const buttons=this.toolbar.querySelectorAll('button');
    buttons[0].onclick=()=>this.zoom(.85);buttons[1].onclick=()=>this.zoom(1.18);buttons[2].onclick=()=>this.resetCamera();
    host.append(this.toolbar);
    this.onKey=e=>{
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(e.key)){
        e.preventDefault();e.stopPropagation();
        if(e.key==='Home')this.resetCamera();
        else if(['+','=','-'].includes(e.key))this.zoom(e.key==='-'?1.12:.89);
        else {const s=new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
          s.theta+=(e.key==='ArrowLeft'?.12:e.key==='ArrowRight'?-.12:0);
          s.phi=THREE.MathUtils.clamp(s.phi+(e.key==='ArrowUp'?-.08:e.key==='ArrowDown'?.08:0),.3,Math.PI*.48);
          this.camera.position.setFromSpherical(s).add(this.controls.target);this.controls.update();}
      }
    };
    canvas.addEventListener('keydown',this.onKey);
    this.scene.add(new THREE.HemisphereLight(0xc1d6e5,0x39302a,.22));
    const key=new THREE.DirectionalLight(0xffdfb6,2.5);key.position.set(-4,8,5);key.castShadow=true;
    key.shadow.mapSize.set(2048,2048);Object.assign(key.shadow.camera,{left:-6,right:6,top:6,bottom:-6,near:.5,far:26});
    key.shadow.normalBias=.025;key.shadow.bias=-.00015;this.scene.add(key);this.key=key;
    const rim=new THREE.DirectionalLight(0x9ecde5,1.7);rim.position.set(4,5,-4);this.scene.add(rim);
    for(const x of [-9,9]) {const lamp=new THREE.PointLight(0xffa452,85,15,2);lamp.position.set(x,3.7,-8);this.scene.add(lamp);}
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    this.resetCamera();this.resize();this.setBusy(true);
    const shadowCanvas=document.createElement('canvas');shadowCanvas.width=shadowCanvas.height=128;
    const ctx=shadowCanvas.getContext('2d'),gradient=ctx.createRadialGradient(64,64,12,64,64,64);
    gradient.addColorStop(0,'rgba(0,0,0,.65)');gradient.addColorStop(.6,'rgba(0,0,0,.32)');gradient.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
    this.contactTexture=new THREE.CanvasTexture(shadowCanvas);
    this.contact=new THREE.Mesh(new THREE.PlaneGeometry(3.2,5.3),new THREE.MeshBasicMaterial({map:this.contactTexture,transparent:true,depthWrite:false}));
    this.contact.rotation.x=-Math.PI/2;this.contact.position.y=.005;this.scene.add(this.contact);
    loadGarageAssets().then(assets=>{
      if(this.disposed)return;
      this.interior=buildGarageInterior(assets);this.scene.add(this.interior);
      if(assets.hdr){const gen=new THREE.PMREMGenerator(this.renderer);this.env=gen.fromEquirectangular(assets.hdr);gen.dispose();this.scene.environment=this.env.texture;}
      this.assetsReady=true;
      host.dataset.environment=assets.hdr?'hdr':'fallback';
    }).catch(()=>{if(!this.disposed){this.interior=buildGarageInterior();this.scene.add(this.interior);this.assetsReady=true;host.dataset.environment='fallback';}});
  }
  setBusy(busy) {this.host.classList.toggle('loading',busy);this.host.setAttribute('aria-busy',String(busy));}
  resize() {
    if(this.disposed)return;
    const r=this.host.getBoundingClientRect(),w=Math.max(1,r.width),h=Math.max(1,r.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2,Math.sqrt(3000000/(w*h))));
    this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();
  }
  resetCamera() {
    this.controls.enableDamping=false;this.controls.update();
    this.controls.enableDamping=true;
    const length=Math.max(3.1,this.vehicle?.spec.dims.L||4);
    this.controls.target.set(0,1.2,0);this.camera.position.set(-length*1.12,length*.63,length*1.42);
    this.controls.update();
  }
  zoom(factor) {const d=this.camera.position.clone().sub(this.controls.target);d.setLength(THREE.MathUtils.clamp(d.length()*factor,this.controls.minDistance,this.controls.maxDistance));this.camera.position.copy(this.controls.target).add(d);this.controls.update();}
  setVehicle(id) {
    const spec=VEHICLE_BY_ID[id]||VEHICLES[0];if(this.vehicle?.spec===spec)return;
    this.dropVehicle();const generation=++this.generation;
    const v=this.vehicle=new Vehicle(this.scene,PAD,spec,{livery:0});v.placeAt(0,0,0);v.root.visible=false;
    this.deadline=performance.now()+25000;this.readyFrames=0;this.setBusy(true);delete this.host.dataset.lod;delete this.host.dataset.texture;this.resetCamera();
    Promise.resolve(v._carcassReady).then(()=>{
      if(this.disposed||generation!==this.generation)return;
      const lod=v.carcass;
      if(lod?.isLOD&&lod.state==='idle'){lod.state='loading';lod.requestHigh();}
    });
  }
  update(dt) {
    if(this.disposed)return;this.controls.update();
    const v=this.vehicle;
    if(v){
      const d=Math.min(Math.max(dt||.016,.001),.05);v.step(d,NO_CTL);v.updateVisuals(d);
      if(v._glowRig)v._glowRig.visible=false; // exaggerated racing sprites obscure inspection
      const lod=v.carcass;
      let pending=v._carcassLoading||(lod?.isLOD&&['idle','loading'].includes(lod.state));
      if(pending&&performance.now()>this.deadline){v._carcassGen=(v._carcassGen|0)+1;v._carcassLoading=false;if(lod?.isLOD)lod.state='failed';pending=false;}
      if(!pending&&this.assetsReady){
        if(!this.details)this.details=addShowroomDetails(v);
        v.root.visible=true;
        // The menu is an inspection viewer: keep its loaded close LOD at all
        // orbit distances. Race LOD distance selection is untouched.
        if(lod?.isLOD&&lod.high){lod.autoUpdate=false;lod.low.visible=false;lod.high.visible=true;lod.active=lod.high;}
        this.host.dataset.vehicle=specId(v);this.host.dataset.lod=lod?.high?'high':'fallback';
        this.host.dataset.texture=String(lod?.high?.getObjectByProperty('isMesh',true)?.material?.map?.image?.width||0);
        if(++this.readyFrames>1)this.setBusy(false);
      }
    }
    this.renderer.render(this.scene,this.camera);
  }
  dropVehicle(){this.details?.();this.details=null;if(this.vehicle){this.vehicle.dispose();this.vehicle=null;}}
  dispose(){
    this.disposed=true;this.generation++;this.resizeObserver.disconnect();this.controls.dispose();
    this.dropVehicle();this.contact.geometry.dispose();this.contact.material.dispose();this.contactTexture.dispose();this.interior?.userData.dispose();this.env?.dispose();this.key.shadow.map?.dispose();
    this.renderer.domElement.removeEventListener('keydown',this.onKey);this.renderer.domElement.remove();this.toolbar.remove();
    this.renderer.dispose();this.renderer.forceContextLoss();this.setBusy(false);
  }
}
function specId(v){return v.spec.id;}

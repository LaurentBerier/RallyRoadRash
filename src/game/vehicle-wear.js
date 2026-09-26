import * as THREE from 'three';

// Shared, seamless dust and scuffed-metal tiles. Data textures also work in
// headless checks and avoid a network dependency for moving mechanical parts.
let cached;
let tireCached;
export function tireWear() {
  if(tireCached)return tireCached;
  const n=1024,albedo=new Uint8Array(n*n*4),rough=new Uint8Array(n*n*4);
  let seed=7831;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const grit=seed/4294967296;
    const clump=noise(x/n*12,y/n*12,12)*.65+noise(x/n*48,y/n*48,48)*.35;
    const dust=THREE.MathUtils.clamp((clump-.27)*1.8,0,.85);
    const i=(y*n+x)*4;
    // Albedo includes the rubber: use white material colour so the tan dust
    // isn't multiplied into invisibility by a near-black tyre tint.
    for(let c=0;c<3;c++)albedo[i+c]=[23,25,27][c]*(1-dust)+[139,109,72][c]*dust+grit*9;
    albedo[i+3]=255;
    rough[i]=rough[i+1]=rough[i+2]=215+35*dust+grit*5;rough[i+3]=255;
  }
  const make=(data,color)=>{const t=new THREE.DataTexture(data,n,n);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.generateMipmaps=true;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;t.needsUpdate=true;return t;};
  return tireCached={map:make(albedo,true),roughnessMap:make(rough,false)};
}
function noise(x,y,period) {
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const a=fx*fx*(3-2*fx),b=fy*fy*(3-2*fy);
  const hash=(u,v)=>((Math.imul((u%period)+17,374761393)^Math.imul((v%period)+31,668265263))>>>0)/4294967296;
  return (hash(ix,iy)*(1-a)+hash(ix+1,iy)*a)*(1-b)+(hash(ix,iy+1)*(1-a)+hash(ix+1,iy+1)*a)*b;
}
export function wearUV(geometry) {
  if (geometry.getAttribute('uv')) return geometry;
  const p=geometry.getAttribute('position'), normals=geometry.getAttribute('normal');
  const uv=new Float32Array(p.count*2);
  for(let i=0;i<p.count;i++){
    const nx=Math.abs(normals?.getX(i)||0),ny=Math.abs(normals?.getY(i)||0),nz=Math.abs(normals?.getZ(i)||0);
    uv[i*2]=(nx>ny&&nx>nz?p.getZ(i):p.getX(i))*2;
    uv[i*2+1]=(ny>nx&&ny>nz?p.getZ(i):p.getY(i))*2;
  }
  geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));return geometry;
}
export function vehicleWear() {
  if (cached) return cached;
  const n=2048, color=new Uint8Array(n*n*4), rough=new Uint8Array(n*n*4);
  let seed=1937;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const grain=seed/4294967296;
    const cloud=noise(x/n*8,y/n*8,8)*.7+noise(x/n*32,y/n*32,32)*.3;
    const dust=Math.max(0,Math.min(1,(cloud-.35)*1.7));
    // Fine machining lines and occasional narrow scratches now have their
    // own texels instead of disappearing into the broad dust colour tile.
    const scratch=(y%173===0&&x%389<235)?1:0;
    const brushed=Math.sin(y*.85)*.018;
    const i=(y*n+x)*4, shade=.85+grain*.12+brushed+scratch*.09;
    for(let c=0;c<3;c++) color[i+c]=(210*(1-dust)+[119,93,62][c]*dust)*shade;
    color[i+3]=255;
    rough[i]=rough[i+1]=rough[i+2]=170+75*dust+grain*10-scratch*35;rough[i+3]=255;
  }
  const make=(data,srgb)=>{const t=new THREE.DataTexture(data,n,n);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.generateMipmaps=true;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.needsUpdate=true;return t;};
  const roughnessMap=make(rough,false);
  return cached={map:make(color,true),roughnessMap,bumpMap:roughnessMap,bumpScale:.0007};
}

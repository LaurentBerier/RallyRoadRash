import * as THREE from 'three';

// Quads in the supplied exports' coordinates: bottom left/right, top left/right.
// Follow the static carcass, never the independently animated running gear.
export const CUSTOM_WINDOWS = {
  hopper: [
    [[-.235,.015,-.305],[-.235,.015,.305],[-.055,.205,-.278],[-.055,.205,.278]],
    ...[-1,1].map(s=>[[-.16,-.025,s*.333],[.30,-.015,s*.333],[-.045,.195,s*.285],[.285,.195,s*.285]]),
  ],
  ridgeback: [
    [[-.32,.055,-.30],[-.32,.055,.30],[-.13,.215,-.275],[-.13,.215,.275]],
    ...[-1,1].map(s=>[[-.28,.06,s*.327],[.085,.06,s*.327],[-.12,.207,s*.294],[.078,.207,s*.294]]),
    [[.14,.065,.29],[.14,.065,-.29],[.13,.207,.27],[.13,.207,-.27]],
  ],
  redline: [
    [[-.25,.098,-.335],[-.25,.098,.335],[-.015,.213,-.282],[-.015,.213,.282]],
    ...[-1,1].map(s=>[[-.235,.095,s*.349],[.235,.095,s*.349],[-.005,.207,s*.293],[.218,.207,s*.293]]),
    [[.46,.09,.32],[.46,.09,-.32],[.25,.205,.277],[.25,.205,-.277]],
  ],
};

export function addCustomWindowGrilles(group, vehicle, anisotropy, id) {
  const canvas=document.createElement('canvas'); canvas.width=canvas.height=512;
  const ctx=canvas.getContext('2d');
  for(let i=0;i<=512;i+=32){
    ctx.fillStyle='#242a29'; ctx.fillRect(i-3,0,6,512);ctx.fillRect(0,i-3,512,6);
    ctx.fillStyle='#99998c';ctx.fillRect(i-2,0,2,512);ctx.fillRect(0,i-2,512,2);
  }
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
  map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=anisotropy;
  const material=new THREE.MeshStandardMaterial({map,alphaTest:.45,side:THREE.DoubleSide,metalness:.75,roughness:.5});
  vehicle._ghost.mats.push(material);
  if(vehicle._ghost.k>0){material.transparent=true;material.opacity=1-.58*vehicle._ghost.k;}
  const geometries=[];
  for(const [i,points] of (CUSTOM_WINDOWS[id]||[]).entries()){
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points.flat(),3));
    const width=new THREE.Vector3(...points[0]).distanceTo(new THREE.Vector3(...points[1]));
    const height=new THREE.Vector3(...points[0]).distanceTo(new THREE.Vector3(...points[2]));
    g.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,width/.5,0,0,height/.5,width/.5,height/.5],2));
    g.setIndex([0,1,2,2,1,3]);g.computeVertexNormals();geometries.push(g);
    const mesh=new THREE.Mesh(g,material);mesh.name=id+'-window-grille-'+i;
    mesh.castShadow=mesh.receiveShadow=true;group.add(mesh);
  }
  material.addEventListener('dispose',()=>{for(const g of geometries)g.dispose();map.dispose();});
}

// An alpha-cut welded wire texture leaves the cabin visible between wires.
// Fitted in the Ironhide export's local coordinates, so it follows the body.
export function addIronhideWindshield(group, vehicle, anisotropy) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i <= 512; i += 32) {
    ctx.fillStyle = '#293033';
    ctx.fillRect(i - 3, 0, 6, 512); ctx.fillRect(0, i - 3, 512, 6);
    ctx.fillStyle = '#92948a';
    ctx.fillRect(i - 2, 0, 2, 512); ctx.fillRect(0, i - 2, 512, 2);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -.365,.005,-.290, -.365,.005,.290,
    -.175,.205,-.255, -.175,.205,.255,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0,0,1,0,0,.45,1,.45],2));
  geometry.setIndex([0,1,2,2,1,3]); geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({map, alphaTest:.5, side:THREE.DoubleSide, metalness:.72, roughness:.56});
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ironhide-windshield-grid'; mesh.castShadow = true; mesh.receiveShadow = true;
  vehicle._ghost.mats.push(material);
  if (vehicle._ghost.k > 0) { material.transparent = true; material.opacity = 1 - .58 * vehicle._ghost.k; }
  material.addEventListener('dispose', () => { geometry.dispose(); map.dispose(); });
  group.add(mesh);
}

// Offline close-LOD refinement. Run once per new source export; the marker
// prevents repeated subdivision. Embedded source textures are copied verbatim.
import { readFileSync, writeFileSync } from 'node:fs';

const dot = (a,b) => a.reduce((n,v,i)=>n+v*b[i],0);
const unit = a => { const n=Math.hypot(...a)||1; return a.map(v=>v/n); };
for (const id of ['hopper','redline','ridgeback','moto']) {
  const path = new URL(`../assets/models/${id}-carcass-high.glb`,import.meta.url);
  const source=readFileSync(path), jsonLength=source.readUInt32LE(12);
  const doc=JSON.parse(source.subarray(20,20+jsonLength));
  if(doc.asset.extras?.curvedRefinement===1) { console.log(`${id}: already refined`); continue; }
  const start=28+jsonLength, bin=source.subarray(start,start+source.readUInt32LE(start-8));
  const chunks=[bin]; let length=bin.length, before=0, after=0;
  const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
  const read=index=>{
    const a=doc.accessors[index], view=doc.bufferViews[a.bufferView], size=sizes[a.type];
    if(a.sparse||a.normalized||!size)throw Error('Unsupported accessor');
    const bytes={5126:4,5125:4,5123:2,5121:1}[a.componentType];
    if(!bytes)throw Error('Unsupported component');
    const fn={5126:'readFloatLE',5125:'readUInt32LE',5123:'readUInt16LE',5121:'readUInt8'}[a.componentType];
    return Array.from({length:a.count},(_,i)=>Array.from({length:size},(_,c)=>
      bin[fn]((view.byteOffset||0)+(a.byteOffset||0)+i*(view.byteStride||size*bytes)+c*bytes)));
  };
  const write=(rows,type,index=false)=>{
    const padding=(4-length%4)%4; if(padding){chunks.push(Buffer.alloc(padding));length+=padding;}
    const data=Buffer.alloc(rows.length*sizes[type]*4);
    rows.forEach((row,i)=>row.forEach((v,c)=>data[index?'writeUInt32LE':'writeFloatLE'](v,(i*sizes[type]+c)*4)));
    const bufferView=doc.bufferViews.length;
    doc.bufferViews.push({buffer:0,byteOffset:length,byteLength:data.length,target:index?34963:34962});
    chunks.push(data);length+=data.length;
    const accessor={bufferView,componentType:index?5125:5126,count:rows.length,type};
    if(type==='VEC3'){
      accessor.min=[0,1,2].map(c=>rows.reduce((n,r)=>Math.min(n,r[c]),Infinity));
      accessor.max=[0,1,2].map(c=>rows.reduce((n,r)=>Math.max(n,r[c]),-Infinity));
    }
    doc.accessors.push(accessor);return doc.accessors.length-1;
  };
  for(const mesh of doc.meshes)for(const p of mesh.primitives){
    if((p.mode??4)!==4||p.targets)throw Error('Expected static triangles');
    const attrs=Object.fromEntries(Object.entries(p.attributes).map(([k,v])=>[k,read(v)]));
    const pos=attrs.POSITION, normals=attrs.NORMAL;
    if(!normals)throw Error('Normals required for curved refinement');
    const indices=p.indices===undefined?pos.map((_,i)=>i):read(p.indices).flat();
    before+=indices.length/3;
    // Weld only the POSITION calculation, retaining independent UV/tangent
    // vertices at texture seams. Every geometric edge gets the same midpoint.
    const keys=pos.map(v=>v.map(x=>x.toFixed(6)).join(',')), welded=new Map();
    keys.forEach((key,i)=>{
      let entry=welded.get(key);
      if(!entry)welded.set(key,entry={p:pos[i],n:[0,0,0]});
      for(let c=0;c<3;c++)entry.n[c]+=normals[i][c];
    });
    for(const entry of welded.values())entry.n=unit(entry.n);
    const edges=new Map(), midpoints=new Map();
    const midpoint=(a,b)=>{
      const key=a<b?`${a}/${b}`:`${b}/${a}`;
      if(edges.has(key))return edges.get(key);
      const geomKey=[keys[a],keys[b]].sort().join('/');
      let point=midpoints.get(geomKey);
      if(!point){
        const A=welded.get(keys[a]),B=welded.get(keys[b]);
        const delta=B.p.map((v,c)=>v-A.p[c]), edgeLength=Math.hypot(...delta);
        // Cubic Hermite midpoint from the two endpoint tangent planes.
        // Suppress sharp folds and cap displacement to preserve panel fit.
        const curved=dot(A.n,B.n)>.65;
        let offset=delta.map((_,c)=>curved?(dot(delta,B.n)*B.n[c]-dot(delta,A.n)*A.n[c])/8:0);
        const amount=Math.hypot(...offset), limit=edgeLength*.08;
        if(amount>limit)offset=offset.map(v=>v*limit/amount);
        point=A.p.map((v,c)=>Math.max(Math.min(v,B.p[c]),
          Math.min(Math.max(v,B.p[c]),(v+B.p[c])*.5+offset[c])));
        midpoints.set(geomKey,point);
      }
      const i=pos.length;
      for(const [name,values] of Object.entries(attrs)){
        let value=values[a].map((v,c)=>(v+values[b][c])*.5);
        if(name==='POSITION')value=point;
        if(name==='NORMAL')value=unit(value);
        if(name==='TANGENT')value=[...unit(value.slice(0,3)),values[a][3]];
        values.push(value);
      }
      edges.set(key,i);return i;
    };
    const refined=[];
    for(let i=0;i<indices.length;i+=3){
      const [a,b,c]=indices.slice(i,i+3),ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);
      refined.push(a,ab,ca,ab,b,bc,ca,bc,c,ab,bc,ca);
    }
    for(const [name,rows] of Object.entries(attrs))p.attributes[name]=write(rows,doc.accessors[p.attributes[name]].type);
    p.indices=write(refined.map(v=>[v]),'SCALAR',true);after+=refined.length/3;
  }
  doc.asset.extras={...doc.asset.extras,curvedRefinement:1};
  doc.buffers[0].byteLength=length;
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const payload=Buffer.concat([...chunks,Buffer.alloc((4-length%4)%4)]);
  const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);
  header.writeUInt32LE(28+json.length+payload.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(payload.length);binHeader.writeUInt32LE(0x004e4942,4);
  writeFileSync(path,Buffer.concat([header,json,binHeader,payload]));
  console.log(`${id}: ${before} → ${after} triangles; source maps preserved`);
}

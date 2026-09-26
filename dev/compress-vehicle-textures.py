"""Repack GLB texture images without changing mesh buffers or image dimensions."""
import io,json,struct
from pathlib import Path
from PIL import Image
root=Path(__file__).resolve().parents[1]
report=[]
for name in ['hopper-sunstrike','ridgeback-custom','redline-custom','moto-custom','hornet-rider']:
 src=root/'assets/models'/f'{name}.glb';data=src.read_bytes()
 length=struct.unpack_from('<I',data,12)[0];g=json.loads(data[20:20+length]);binary=data[28+length:]
 imageviews={im['bufferView']:im for im in g.get('images',[]) if 'bufferView' in im}
 normalviews=set()
 for mat in g.get('materials',[]):
  tex=mat.get('normalTexture')
  if tex:normalviews.add(g['images'][g['textures'][tex['index']]['source']]['bufferView'])
 out=bytearray();unchanged=0
 for i,view in enumerate(g['bufferViews']):
  offset=view.get('byteOffset',0);payload=binary[offset:offset+view['byteLength']]
  if i in imageviews:
   im=Image.open(io.BytesIO(payload));buf=io.BytesIO()
   # These authored atlases are opaque; preserve alpha if a future export needs it.
   if 'A' not in im.getbands() or im.getchannel('A').getextrema()==(255,255):
    im.convert('RGB').save(buf,format='JPEG',quality=96 if i in normalviews else 92,subsampling=0,optimize=True)
    if buf.tell()<len(payload):payload=buf.getvalue();imageviews[i]['mimeType']='image/jpeg'
  else:unchanged+=len(payload)
  while len(out)%4:out.append(0)
  view['byteOffset']=len(out);view['byteLength']=len(payload);out.extend(payload)
 while len(out)%4:out.append(0)
 g['buffers'][0]['byteLength']=len(out)
 js=json.dumps(g,separators=(',',':')).encode();js+=b' '*((-len(js))%4)
 packed=struct.pack('<III',0x46546c67,2,28+len(js)+len(out))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(out),0x004e4942)+out
 dest=src.with_name(name+'-stream.glb');dest.write_bytes(packed)
 report.append(dict(source=src.name,output=dest.name,before=len(data),after=len(packed),geometryBytesPreserved=unchanged))
 print(name,round(len(data)/1e6,2),'->',round(len(packed)/1e6,2),'MB',flush=True)
(root/'docs/loading-optimization.json').write_text(json.dumps(report,indent=2))
manifest=root/'assets/manifest.json';m=json.loads(manifest.read_text())
for spec in m.values():
 for r in report:
  if spec.get('url')=='models/'+r['source']:spec['url']='models/'+r['output']
manifest.write_text(json.dumps(m,indent=2)+'\n')

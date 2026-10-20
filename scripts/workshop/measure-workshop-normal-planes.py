"""Compare chroma-independent grayscale normal planes without touching runtime."""
from pathlib import Path
import json
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/workshop-texture-candidates'
OUT.mkdir(parents=True,exist_ok=True)
BASELINE=ROOT/'artifacts/workshop-texture-baseline'
if not BASELINE.is_dir():
 raise RuntimeError('Create the high-quality WebP baseline with pack-workshop-textures.py without --compact first.')
report=[]
def direction(raw):
 v=raw.astype(np.float32)/127.5-1
 return v/np.maximum(np.linalg.norm(v,axis=2,keepdims=True),1e-8)
for layer in (0,2,5):
 raw=np.asarray(Image.open(BASELINE/f'prop-{layer}-normal.webp').convert('RGB'))
 wanted=direction(raw);h,w,_=raw.shape
 for planes in (3,2):
  gray=np.concatenate([raw[:,:,i] for i in range(planes)],axis=1)
  if planes==3:packed=Image.fromarray(gray,'L').convert('RGB')
  else:
   alpha=np.concatenate([np.where(raw[:,:,2]<128,254,255).astype(np.uint8)]*2,axis=1)
   packed=Image.fromarray(np.stack([gray,gray,gray,alpha],axis=2),'RGBA')
  for quality in (82,88,94):
   path=OUT/f'prop-{layer}-normal-planes{planes}-q{quality}.webp'
   packed.save(path,format='WEBP',quality=quality,method=6,exact=True)
   decoded=np.asarray(Image.open(path).convert('RGBA'))
   if planes==3:
    got=direction(np.stack([decoded[:,i*w:(i+1)*w,0] for i in range(3)],axis=2))
   else:
    xy=np.stack([decoded[:,i*w:(i+1)*w,0] for i in range(2)],axis=2).astype(np.float32)/127.5-1
    sign=np.where(decoded[:,:w,3]<255,-1,1)
    z=np.sqrt(np.maximum(0,1-np.sum(xy*xy,axis=2)))*sign
    got=np.concatenate((xy,z[:,:,None]),axis=2)
    got/=np.maximum(np.linalg.norm(got,axis=2,keepdims=True),1e-8)
   angle=np.rad2deg(np.arccos(np.clip(np.sum(got*wanted,axis=2),-1,1)))
   record={'file':path.name,'planes':planes,'quality':quality,'bytes':path.stat().st_size,
     'meanAngle':float(np.mean(angle)),'p95Angle':float(np.percentile(angle,95)),
     'p99Angle':float(np.percentile(angle,99)),'maxAngle':float(np.max(angle))}
   report.append(record);print(json.dumps(record),flush=True)
(OUT/'normal-plane-quality-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')

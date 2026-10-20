"""Compare shipping-codec candidates against current high-quality runtime texels.
No runtime asset is changed. Run before selecting a smaller shipping codec.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/workshop-texture-candidates'
OUT.mkdir(parents=True,exist_ok=True)
PUBLIC=ROOT/'artifacts/workshop-texture-baseline'
if not PUBLIC.is_dir():
    raise RuntimeError('Create a high-quality baseline with the texture packer without --compact, then copy its WebP maps into artifacts/workshop-texture-baseline.')
report=[]


def direction(data):
    v=data.astype(np.float32)/127.5-1
    return v/np.maximum(np.linalg.norm(v,axis=2,keepdims=True),1e-8)


for layer in (0,2,5):
    reference=Image.open(PUBLIC/f'prop-{layer}-normal.webp').convert('RGB')
    raw=np.asarray(reference);wanted=direction(raw)
    for kind in ('q96','q100','xy6','xy7'):
        candidate=reference
        if kind.startswith('xy'):
            bits=int(kind[2:]);step=2**(8-bits)
            xy=np.clip(np.rint((raw[:,:,:2].astype(np.float32)-128)/step)*step+128,0,255)
            v=xy/127.5-1
            z=np.sqrt(np.maximum(0,1-np.sum(v*v,axis=2)))
            candidate=Image.fromarray(np.concatenate((xy,np.rint((z[:,:,None]*.5+.5)*255)),axis=2).astype(np.uint8),'RGB')
        path=OUT/f'prop-{layer}-normal-{kind}.webp'
        candidate.save(path,format='WEBP',lossless=kind.startswith('xy'),quality=int(kind[1:]) if kind.startswith('q') else 90,method=6,exact=True)
        got=direction(np.asarray(Image.open(path).convert('RGB')))
        angle=np.rad2deg(np.arccos(np.clip(np.sum(wanted*got,axis=2),-1,1)))
        record={'file':path.name,'kind':'normal','bytes':path.stat().st_size,'meanAngle':float(np.mean(angle)),
                'p95Angle':float(np.percentile(angle,95)),'p99Angle':float(np.percentile(angle,99)),'maxAngle':float(np.max(angle))}
        report.append(record);print(json.dumps(record),flush=True)
for layer in (0,2,5):
    reference=Image.open(PUBLIC/f'prop-{layer}-orm.webp').convert('RGB');raw=np.asarray(reference)
    for kind in ('q98','gb6','gb7'):
        packed=raw.copy();packed[:,:,0]=255
        if kind.startswith('gb'):
            levels=2**int(kind[2:])-1
            packed[:,:,1:]=np.rint(np.rint(packed[:,:,1:].astype(np.float32)/255*levels)/levels*255).astype(np.uint8)
        path=OUT/f'prop-{layer}-orm-{kind}.webp'
        Image.fromarray(packed,'RGB').save(path,format='WEBP',lossless=kind.startswith('gb'),quality=98,method=6,exact=True)
        error=np.abs(np.asarray(Image.open(path).convert('RGB')).astype(np.float32)-raw)/255
        record={'file':path.name,'kind':'orm','bytes':path.stat().st_size,'roughness':{'p99':float(np.percentile(error[:,:,1],99)),'max':float(np.max(error[:,:,1]))},
                'metallic':{'p99':float(np.percentile(error[:,:,2],99)),'max':float(np.max(error[:,:,2]))}}
        report.append(record);print(json.dumps(record),flush=True)
for name in ('architecture-brick','architecture-concrete','architecture-vault','fixture-paint','fixture-brass','gauge-face'):
    reference=Image.open(PUBLIC/f'{name}.webp').convert('RGB');raw=np.asarray(reference,dtype=np.float32)
    for q in (94,96):
        path=OUT/f'{name}-q{q}.webp';reference.save(path,format='WEBP',quality=q,method=6)
        error=np.asarray(Image.open(path).convert('RGB'),dtype=np.float32)-raw
        psnr=float(20*np.log10(255/max(1e-8,np.sqrt(np.mean(error*error)))))
        record={'file':path.name,'kind':'surface','bytes':path.stat().st_size,'psnr':psnr}
        report.append(record);print(json.dumps(record),flush=True)
(OUT/'quality-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')

"""Ship compact WebP textures while keeping every authored source image intact.

Run after build-workshop.py and render-workshop-probe.py, before the production
build. This packs textures only; geometry packaging is an independent step.
Requires Pillow with WebP and NumPy. --remove-originals removes only public
images whose identical original has first been preserved and hash-verified.
--compact uses angular-error-checked XY normal planes, six-bit roughness and
metallic channels, and visually lossy surface color. RGBM always remains exact.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'public' / 'workshop'
SOURCE = ROOT / 'assets' / 'workshop' / 'texture-source'
SOURCE.mkdir(parents=True, exist_ok=True)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resize_channels(values: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    return np.stack([np.asarray(Image.fromarray(values[:, :, i]).resize(size, Image.Resampling.LANCZOS))
                     for i in range(values.shape[2])], axis=2)


def resized(image: Image.Image, kind: str, maximum: int | None) -> Image.Image:
    if maximum is None or max(image.size) <= maximum:
        return image.copy()
    factor = maximum / max(image.size)
    size = tuple(round(v * factor) for v in image.size)
    raw = np.asarray(image.convert('RGB'), dtype=np.float32) / 255
    if kind == 'normal':
        # Average actual signed vectors, then renormalize; no sRGB operation.
        vector = resize_channels(raw * 2 - 1, size)
        vector /= np.maximum(np.linalg.norm(vector, axis=2, keepdims=True), 1e-8)
        result = vector * .5 + .5
    elif kind == 'orm':
        # Average roughness variance, keeping metallic/occlusion linear.
        raw[:, :, 1] **= 2
        result = resize_channels(raw, size)
        result[:, :, 1] = np.sqrt(np.maximum(0, result[:, :, 1]))
    else:
        # Filter albedo in linear light, then encode its shipping sRGB image.
        linear = np.where(raw <= .04045, raw / 12.92, ((raw + .055) / 1.055) ** 2.4)
        linear = np.clip(resize_channels(linear, size), 0, 1)
        result = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
    return Image.fromarray(np.rint(np.clip(result, 0, 1) * 255).astype(np.uint8), 'RGB')


def direction(raw: np.ndarray) -> np.ndarray:
    vector = raw.astype(np.float32) / 127.5 - 1
    return vector / np.maximum(np.linalg.norm(vector, axis=2, keepdims=True), 1e-8)


def normal_planes(encoded: Image.Image, output: Path) -> dict:
    """Keep X and Y out of WebP's chroma subsampling; preserve Z sign in alpha.

    The GPU reconstructs and quantizes into its ordinary RGBA8 normal array.
    Measure that final array, not just a floating-point ideal reconstruction.
    """
    raw = np.asarray(encoded.convert('RGB'))
    h, w = raw.shape[:2]
    gray = np.concatenate((raw[:, :, 0], raw[:, :, 1]), axis=1)
    alpha = np.concatenate([np.where(raw[:, :, 2] < 128, 254, 255).astype(np.uint8)] * 2, axis=1)
    packed = Image.fromarray(np.stack((gray, gray, gray, alpha), axis=2), 'RGBA')
    wanted = direction(raw)
    for quality in (94, 96, 98, 100):
        packed.save(output, format='WEBP', quality=quality, method=6, exact=True)
        with Image.open(output) as image:
            decoded = np.asarray(image.convert('RGBA'))
        if decoded.shape != (h, w * 2, 4) or not np.array_equal(decoded[:, :, 3], alpha):
            raise RuntimeError('Normal layout/sign changed: ' + output.name)
        xy = np.stack((decoded[:, :w, 0], decoded[:, w:, 0]), axis=2).astype(np.float32) / 127.5 - 1
        z = np.sqrt(np.maximum(0, 1 - np.sum(xy * xy, axis=2))) * np.where(decoded[:, :w, 3] < 255, -1, 1)
        got = np.concatenate((xy, z[:, :, None]), axis=2)
        got /= np.maximum(np.linalg.norm(got, axis=2, keepdims=True), 1e-8)
        # Match the unorm8 GPU storage target and subsequent shader normalization.
        got = direction(np.rint(np.clip(got * .5 + .5, 0, 1) * 255).astype(np.uint8))
        angle = np.rad2deg(np.arccos(np.clip(np.sum(wanted * got, axis=2), -1, 1)))
        stats = {'meanDegrees': float(np.mean(angle)), 'p95Degrees': float(np.percentile(angle, 95)),
                 'p99Degrees': float(np.percentile(angle, 99)), 'maxDegrees': float(np.max(angle)),
                 'negativeZTexels': int(np.sum(raw[:, :, 2] < 128))}
        if stats['p95Degrees'] <= 2:
            return {'quality': quality, 'angularError': stats, 'shippingSize': [w * 2, h],
                    'normalEncoding': 'xy-gray', 'exactSignAlpha': True}
    raise RuntimeError('Normal error exceeds the two-degree p95 budget: ' + output.name)


parser = argparse.ArgumentParser()
parser.add_argument('--remove-originals', action='store_true')
parser.add_argument('--compact', action='store_true')
parser.add_argument('--only-reflections', action='store_true', help='Refresh six exact RGBM faces after a static room edit without recoding other maps.')
args = parser.parse_args()
if not features.check('webp'):
    raise RuntimeError('This Pillow build has no WebP encoder.')
manifest_path = PUBLIC / 'manifest.json'
manifest = json.loads(manifest_path.read_text('utf8'))
jobs: dict[str, tuple[str, int | None, bool]] = {}
for layer in manifest['textures']:
    for kind in ('baseColor', 'normal', 'orm'):
        filename = layer[kind]
        stem = Path(filename).stem
        # Source map extensions come from the original GLB, independent of
        # whether a prior packaging run has already changed the manifest.
        candidates = [p for p in SOURCE.glob(stem + '.*') if p.suffix.lower() in ('.png', '.jpg', '.jpeg')]
        source_name = candidates[0].name if candidates else filename
        jobs[source_name] = (kind, 1024 if kind == 'orm' else 2048, kind != 'baseColor')
for name in ('architecture-brick', 'architecture-concrete', 'architecture-vault', 'fixture-paint', 'fixture-brass', 'gauge-face'):
    jobs[name + '.png'] = ('surface', None, True)
for face in ('px', 'nx', 'py', 'ny', 'pz', 'nz'):
    jobs[f'reflection-{face}.png'] = ('rgbm', None, True)
if args.only_reflections:
    jobs = {name: spec for name, spec in jobs.items() if spec[0] == 'rgbm'}
records = []
replacements = {}
remove_after_verify = []
for filename, (kind, maximum, lossless) in jobs.items():
    public_source = PUBLIC / filename
    source = SOURCE / filename
    if public_source.exists():
        # A newer Blender render/export becomes the preserved source of truth.
        if not source.exists() or sha(public_source) != sha(source):
            shutil.copy2(public_source, source)
        if sha(public_source) != sha(source):
            raise RuntimeError('Original preservation failed: ' + filename)
        remove_after_verify.append(public_source)
    if not source.is_file():
        raise FileNotFoundError(source)
    output = PUBLIC / (source.stem + '.webp')
    with Image.open(source) as original:
        original.load()
        encoded = resized(original, kind, maximum)
        metrics = {}
        quality = 90
        if args.compact and kind == 'normal':
            lossless = False
            metrics = normal_planes(encoded, output)
            quality = metrics['quality']
        else:
            if args.compact and kind == 'orm':
                raw = np.asarray(encoded.convert('RGB'))
                quantized = raw.copy()
                # Meshy does not supply AO in R; the engine uses geometric AO.
                quantized[:, :, 0] = 255
                quantized[:, :, 1:] = np.rint(np.rint(raw[:, :, 1:].astype(np.float32) / 255 * 63) / 63 * 255).astype(np.uint8)
                error = np.abs(quantized[:, :, 1:].astype(np.float32) - raw[:, :, 1:]) / 255
                metrics = {'bitsPerScalar': 6, 'maxRoughnessError': float(error[:, :, 0].max()),
                           'maxMetallicError': float(error[:, :, 1].max())}
                encoded = Image.fromarray(quantized, 'RGB')
            if args.compact and kind == 'surface':
                lossless = False
                quality = 96 if source.stem == 'gauge-face' else 94
            encoded.save(output, format='WEBP', lossless=lossless, quality=quality, method=6, exact=True)
            with Image.open(output) as roundtrip:
                roundtrip.load()
                if roundtrip.size != encoded.size:
                    raise RuntimeError('Texture dimensions changed in codec: ' + filename)
                if lossless and not np.array_equal(np.asarray(roundtrip.convert(encoded.mode)), np.asarray(encoded)):
                    raise RuntimeError('Lossless channels changed in WebP: ' + filename)
                if not lossless:
                    delta = np.asarray(roundtrip.convert('RGB'), dtype=np.float32) - np.asarray(encoded.convert('RGB'), dtype=np.float32)
                    mse = float(np.mean(delta * delta))
                    metrics['colorPsnrDb'] = float(10 * np.log10(255 ** 2 / max(mse, 1e-10)))
        record = {'source': filename, 'sourceSha256': sha(source), 'file': output.name,
                  'kind': kind, 'sourceSize': list(original.size), 'runtimeSize': list(encoded.size),
                  'sourceBytes': source.stat().st_size, 'runtimeBytes': output.stat().st_size,
                  'losslessCodec': lossless, 'quality': quality, **metrics,
                  'filter': 'renormalized vector' if kind == 'normal' else
                      'roughness variance' if kind == 'orm' else 'linear-light albedo' if maximum else 'native dimensions'}
        records.append(record)
        print(json.dumps(record), flush=True)
    replacements[source.stem] = output.name

# Reread immediately before writing so geometry packaging cannot be overwritten
# by a stale manifest object while this slower offline texture job was running.
manifest = json.loads(manifest_path.read_text('utf8'))
for layer in manifest['textures']:
    for key in ('baseColor', 'normal', 'orm'):
        filename = layer[key]
        layer[key] = replacements.get(Path(filename).stem, filename)
    if not args.only_reflections:
        if args.compact:
            layer['normalEncoding'] = 'xy-gray'
        else:
            layer.pop('normalEncoding', None)
manifest['source'] = 'Blender 5.2 CAD architecture; image-generated atlas; full source geometry with packaged authored PBR maps; originals archived'
if not args.only_reflections:
    manifest['textureEncoding'] = ('WebP; XY-gray vector normals, six-bit roughness/metallic; exact RGBM; originals preserved'
                                  if args.compact else 'WebP; original source maps preserved; vector-normal and roughness-aware reduction')
manifest['gaugeFace'] = 'gauge-face.webp'
manifest.pop('reflectionProbe', None)
manifest_path.write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf8')
probe_path=ROOT/'assets/workshop/runtime-source/reflection-probe.json'
if probe_path.exists():
    probe=json.loads(probe_path.read_text('utf8'))
    probe['imageCodec']='lossless WebP; RGBM bytes and alpha retained exactly'
    for face in probe.get('faces',[]):face['file']=f"reflection-{face['face']}.webp"
    probe_path.write_text(json.dumps(probe,separators=(',',':')),encoding='utf8')
report_path = SOURCE / 'packing-report.json'
compact = args.compact
if args.only_reflections and report_path.is_file():
    previous = json.loads(report_path.read_text('utf8'))
    compact = previous.get('compact', False)
    records = [r for r in previous['textures'] if r['kind'] != 'rgbm'] + records
report = {'compact': compact, 'textures': records, 'sourceBytes': sum(r['sourceBytes'] for r in records),
          'runtimeBytes': sum(r['runtimeBytes'] for r in records)}
report_path.write_text(json.dumps(report, indent=2), encoding='utf8')
if args.remove_originals:
    for source in remove_after_verify:
        # Non-recursive exact paths, restricted to this task's public folder.
        if source.resolve().parent != PUBLIC.resolve() or sha(source) != sha(SOURCE / source.name):
            raise RuntimeError('Unsafe/unverified cleanup path: ' + str(source))
        source.unlink()
print('WORKSHOP TEXTURES PACKED ' + json.dumps({k: report[k] for k in ('sourceBytes', 'runtimeBytes')}), flush=True)

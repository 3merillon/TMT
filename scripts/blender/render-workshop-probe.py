"""Render an actual static-room HDR cubemap for the engine's interior IBL.

blender --background assets/workshop/workshop.blend --python-exit-code 1
        --python scripts/blender/render-workshop-probe.py

Source EXRs keep full linear radiance. Runtime RGBA PNGs use RGBM range32;
PNG rows deliberately retain Blender's bottom-up pixel order to match the
WebGPU samplerCube face convention documented in reflection-probe.json.
"""
import array
import json
import math
import os
import struct
import sys
import zlib

import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'workshop')
SOURCE = os.path.join(ROOT, 'assets', 'workshop', 'reflection-probe')
METADATA = os.path.join(ROOT, 'assets', 'workshop', 'runtime-source')
os.makedirs(METADATA, exist_ok=True)
os.makedirs(SOURCE, exist_ok=True)
SIZE = 512
RANGE = 32.0
POSITION = (0, 1.7, 0)
FACES = (
    ('px', (1, 0, 0), (0, -1, 0)),
    ('nx', (-1, 0, 0), (0, -1, 0)),
    ('py', (0, 1, 0), (0, 0, 1)),
    ('ny', (0, -1, 0), (0, 0, -1)),
    ('pz', (0, 0, 1), (0, -1, 0)),
    ('nz', (0, 0, -1), (0, -1, 0)),
)


def b(p):
    return Vector((p[0], -p[2], p[1]))


def png(path, pixels):
    """Write raw UNORM RGBA bytes without a gamma/ICC conversion or row flip."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\0' + row.tobytes() for row in pixels)
    with open(path, 'wb') as stream:
        stream.write(b'\x89PNG\r\n\x1a\n')
        stream.write(chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)))
        stream.write(chunk(b'IDAT', zlib.compress(rows, 9)))
        stream.write(chunk(b'IEND', b''))


scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.render.threads_mode = 'FIXED'
scene.render.threads = 8
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '32'
scene.render.image_settings.exr_codec = 'ZIP'
camera = scene.camera
camera.data.type = 'PERSP'
camera.data.sensor_fit = 'HORIZONTAL'
camera.data.sensor_width = 36
camera.data.lens = 18
camera.data.clip_start = .02
camera.data.clip_end = 100
camera.location = b(POSITION)
hidden = []
for obj in scene.objects:
    if 'ROTATING_FAN' in obj.name:
        obj.hide_render = True
        hidden.append(obj.name)

metadata = {
    'position': POSITION, 'size': SIZE, 'encoding': 'linear RGBM', 'range': RANGE,
    'orientation': 'WebGPU samplerCube; image rows uploaded unchanged, flipY=false',
    'faceCoordinates': {'px': 'sc=-Z, tc=-Y', 'nx': 'sc=+Z, tc=-Y',
                        'py': 'sc=+X, tc=+Z', 'ny': 'sc=+X, tc=-Z',
                        'pz': 'sc=+X, tc=-Y', 'nz': 'sc=-X, tc=-Y'},
    'boxProjection': {'min': [-7, -.8, -8.9], 'max': [7, 7.5, 8.8]},
    'source': 'workshop.blend static authored room, original PBR assets, practical room lighting',
    'excludedDynamicObjects': hidden,
    'faces': [],
}
for name, direction, up in FACES:
    d = b(direction).normalized()
    right = d.cross(b(up)).normalized()
    actual_up = right.cross(d).normalized()
    camera.rotation_euler = Matrix((right, actual_up, -d)).transposed().to_euler()
    exr_path = os.path.join(SOURCE, f'reflection-{name}.exr')
    scene.render.filepath = exr_path
    if '--encode-only' not in sys.argv or not os.path.isfile(exr_path):
        bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(exr_path, check_existing=False)
    pixels = np.empty(SIZE * SIZE * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    rgb = np.maximum(pixels.reshape(SIZE, SIZE, 4)[:, :, :3], 0)
    peak = float(np.max(rgb))
    clipped = int(np.count_nonzero(np.max(rgb, axis=2) > RANGE))
    multiplier = np.clip(np.ceil(np.max(rgb, axis=2) / RANGE * 255) / 255, 1/255, 1)
    rgba = np.concatenate((np.clip(rgb / (multiplier[:, :, None] * RANGE), 0, 1), multiplier[:, :, None]), axis=2)
    packed = np.rint(rgba * 255).astype(np.uint8)
    png(os.path.join(OUT, f'reflection-{name}.png'), packed)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_depth = '8'
    image.save_render(os.path.join(SOURCE, f'reflection-{name}-preview.png'), scene=scene)
    scene.render.image_settings.file_format = 'OPEN_EXR'
    scene.render.image_settings.color_depth = '32'
    bpy.data.images.remove(image)
    record = {'face': name, 'direction': direction, 'up': up, 'peakLinearRadiance': peak,
              'meanLinearLuminance': float(np.mean(rgb @ np.array([.2126,.7152,.0722]))),
              'clippedPixels': clipped, 'source': f'reflection-{name}.exr'}
    metadata['faces'].append(record)
    print('REFLECTION FACE ' + json.dumps(record), flush=True)
with open(os.path.join(METADATA, 'reflection-probe.json'), 'w', encoding='utf8') as stream:
    json.dump(metadata, stream, indent=2)
print('WORKSHOP HDR PROBE COMPLETE', flush=True)

"""Render static-source inspection views from the saved workshop .blend.

blender --background assets/workshop/workshop.blend --python
scripts/blender/review-workshop.py -- --views wide fan

These are Blender source inspections. The actual assembled tank, mechanical
robot, lift animation, gauge pointer and atmospheric effects belong to runtime.
"""
import argparse
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
VIEWS = {
    'hero': ((4.5, 3.7, 6.2), (0, 2.2, -2.3), 24, 'room-review.png'),
    'wide': ((1.3, 3.7, 7.7), (0, 2.7, -2.3), 20, 'room-wide.png'),
    'fan': ((0, 4.22, -4.6), (0, 4.22, -8.68), 22, 'fan-review.png'),
    'ordnance': ((-1.6, 1.65, 7.6), (-4.4, .52, 5.0), 48, 'ordnance-review.png'),
    'compressor': ((-2.3, 2.6, -2.8), (-5.23, 1.12, -6.3), 36, 'compressor-review.png'),
    'crates': ((-2.5, 2.85, -.6), (-5.72, 2.45, -2.7), 32, 'crates-review.png'),
    'door': ((-2.5, 2.7, 3.0), (0, 2.5, 8.75), 24, 'door-review.png'),
    'pit': ((3.1, 2.6, 4.2), (0, -.2, 0), 30, 'pit-review.png'),
    'crane': ((4.5, 5.2, 1.3), (.35, 3.75, -2.9), 30, 'crane-review.png'),
    'hook': ((1.45, 3.05, -1.40), (.78, 2.55, -2.9), 42, 'hook-review.png'),
    'stool': ((3.34, 1.28, 2.91), (4.58, .44, 1.22), 40, 'stool-review.png'),
}


def b(v):
    return Vector((v[0], -v[2], v[1]))


parser = argparse.ArgumentParser()
parser.add_argument('--views', nargs='+', choices=VIEWS, default=['hero', 'wide', 'fan'])
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
# build-workshop.py saves a copy to avoid replacing the user's current scene.
# Load that copy when this review follows a factory-startup build in one process,
# so //texture-source paths resolve relative to the saved .blend as intended.
if not bpy.data.filepath:
    bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT,'assets','workshop','workshop.blend'))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_depth = '8'
camera = scene.camera
camera.data.type = 'PERSP'
for name in args.views:
    position, target, lens, filename = VIEWS[name]
    camera.location = b(position)
    camera.rotation_euler = (b(target) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.lens = lens
    scene.render.filepath = os.path.join(ROOT, 'assets', 'workshop', filename)
    bpy.ops.render.render(write_still=True)

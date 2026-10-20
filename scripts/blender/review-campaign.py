"""Render exact runtime mesh exports in a neutral studio, with all sides visible.
Run export-campaign.ts first, then Blender --background --factory-startup --python this-file -- --models watchtower skimmer.
The saved .blend contains the exported rigid parts and named joints; runtime source remains the TypeScript recipe.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
parser = argparse.ArgumentParser()
parser.add_argument('--models', nargs='+', default=['watchtower', 'skimmer', 'relay', 'dragonfly', 'rustling', 'spire', 'brann', 'crawler'])
parser.add_argument('--samples', type=int, default=32)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
out = os.path.join(ROOT, 'artifacts', 'campaign-art')

def material(name, color, metal, rough, emission=0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metal; p.inputs['Roughness'].default_value = rough
    if emission:
        p.inputs['Emission Color'].default_value = (*color, 1)
        p.inputs['Emission Strength'].default_value = emission
    return m

def colmatrix(values):
    return Matrix([[values[c * 4 + r] for c in range(4)] for r in range(4)])

for name in args.models:
    with open(os.path.join(out, name + '.json'), encoding='utf-8') as f: data = json.load(f)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene; scene.render.engine = 'CYCLES'; scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    # Use the local GPU if Cycles exposes it; CPU remains a fully reproducible fallback.
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'; prefs.get_devices()
        for d in prefs.devices: d.use = d.type != 'CPU'
        if any(d.use for d in prefs.devices): scene.cycles.device = 'GPU'
    except Exception: pass
    palette = [(0.16, .23, .19), (.045, .055, .064), (.016, .021, .025), (.24, .28, .31), (.55, .33, .105), (.96, .68, .26), (.05, .15, .19), (.65, .70, .75)]
    materials = [material(str(i), color, [0, .65, 0, .85, .85, 0, .4, 1][i], [.34, .34, .75, .28, .26, .22, .16, .16][i], .6 if i == 5 else 0) for i, color in enumerate(palette)]
    # glTF/game Y-up, +Z nose -> Blender Z-up, -Y nose.
    convert = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    objects = []
    for part in data['parts']:
        pos = part['positions']; idx = part['indices']; normals = part['normals']
        mesh = bpy.data.meshes.new(part['name'])
        mesh.from_pydata([pos[i:i+3] for i in range(0, len(pos), 3)], [], [idx[i:i+3] for i in range(0, len(idx), 3)])
        for m in materials: mesh.materials.append(m)
        for i, poly in enumerate(mesh.polygons):
            poly.material_index = (part['attrs'][idx[i*3]] >> 16) & 255
            poly.use_smooth = True
        mesh.normals_split_custom_set_from_vertices([normals[i:i+3] for i in range(0, len(normals), 3)])
        matrices = [Matrix.Identity(4)]
        if part['instances']:
            ins = part['instances']; matrices = []
            for i in range(0, len(ins), 12): matrices.append(Matrix((ins[i:i+4], ins[i+4:i+8], ins[i+8:i+12], [0, 0, 0, 1])))
        for i, instance in enumerate(matrices):
            obj = bpy.data.objects.new(part['name'] + (str(i) if len(matrices) > 1 else ''), mesh)
            scene.collection.objects.link(obj); obj.matrix_world = convert @ colmatrix(part['matrix']) @ instance; objects.append(obj)
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(c) for obj in objects for c in obj.bound_box]
    lo = Vector([min(p[i] for p in corners) for i in range(3)]); hi = Vector([max(p[i] for p in corners) for i in range(3)])
    center = (lo + hi) / 2; span = max(hi - lo)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, lo.z-.015))
    bpy.context.object.data.materials.append(material('warm grey cyclorama', (.12, .13, .14), 0, .75))
    world = bpy.data.worlds.new('neutral studio'); world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (.24, .28, .34, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .35; scene.world = world
    for label, position, power, size, color in [
        ('large key', (3, -4, 6), 500, 4, (1, .88, .72)), ('cool fill', (-4, -1, 3), 250, 4, (.68, .83, 1)),
        ('edge strip', (1, 4, 4), 700, 3, (1, .92, .8))]:
        light = bpy.data.lights.new(label, 'AREA'); light.energy = power; light.shape = 'DISK'; light.size = size; light.color = color
        obj = bpy.data.objects.new(label, light); scene.collection.objects.link(obj); obj.location = position
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data = bpy.data.cameras.new('review-camera'); cam = bpy.data.objects.new('review-camera', cam_data); scene.collection.objects.link(cam); scene.camera = cam
    cam_data.type = 'ORTHO'; cam_data.ortho_scale = span * 1.25
    scene.render.resolution_x = 1200; scene.render.resolution_y = 1200; scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'AgX'; scene.render.image_settings.file_format = 'PNG'
    for label, yaw, pitch in [('front', 35, 21), ('rear', 215, 21), ('top', 35, 66)]:
        yaw = math.radians(yaw); pitch = math.radians(pitch)
        cam.location = center + Vector((math.sin(yaw)*math.cos(pitch), -math.cos(yaw)*math.cos(pitch), math.sin(pitch))) * span * 3
        cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out, name + '-' + label + '.png')
        bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, name + '.blend'))
    print('[campaign-art] rendered geometry:', name, 'LOD triangles:', data['lodTriangles'], flush=True)

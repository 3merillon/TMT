"""Render-only review of the kit v2 exports (W1-KIT).

The procedural kit in src/game/kit is the single source of every tank dimension; Blender never authors
geometry any more. This script imports the review GLBs written by `npx tsx scripts/kit/export-kit.ts`
(assets/kit/v2/*.glb, glTF Y-up -> Blender Z-up), lays them out in a row on a ground plane under a studio
light rig and renders a contact sheet plus one three-quarter still per tank into assets/kit/renders/.
Socket empties (turret_ring, trunnion, muzzle, sensor, utility, exhaust_*) are kept and drawn as small axes so
socket placement can be reviewed; their glTF extras (socket class, utility id) land in custom properties.

Usage (Blender 4.2+):
    blender --background --factory-startup --python scripts/blender/render-kit.py -- [--in assets/kit/v2]
        [--out assets/kit/renders] [--samples 32] [--size 1600x900]
"""
import argparse
import glob
import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--in", dest="src", default=os.path.join(ROOT, "assets", "kit", "v2"))
    parser.add_argument("--out", default=os.path.join(ROOT, "assets", "kit", "renders"))
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--size", default="1600x900")
    return parser.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    return scene


def import_tank(path, offset_x):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in imported if o.parent is None]
    for root in roots:
        root.location.x += offset_x
    for obj in imported:
        if obj.type == "EMPTY":
            obj.empty_display_type = "ARROWS"
            obj.empty_display_size = 0.08
            obj.hide_render = True
    return imported


def bounds(objects):
    bpy.context.view_layer.update()  # refresh matrix_world after moving the imported roots
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    return lo, hi


def studio(scene, lo, hi):
    # Ground plane at the tank's ground (glTF y = -0.5 -> Blender z = -0.5), a key, a fill and a rim light.
    bpy.ops.mesh.primitive_plane_add(size=1, location=((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, -0.5))
    ground = bpy.context.active_object
    ground.scale = (hi.x - lo.x + 8, hi.y - lo.y + 8, 1)
    mat = bpy.data.materials.new("studio-ground")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.42, 0.4, 0.37, 1)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    ground.data.materials.append(mat)
    for name, energy, rot, size in (("key", 4.0, (0.9, 0.0, 0.6), 0.2), ("fill", 1.2, (1.1, 0.0, -2.2), 1.0), ("rim", 2.5, (1.2, 0.0, 3.3), 0.3)):
        light = bpy.data.lights.new(name, "SUN")
        light.energy = energy
        light.angle = size
        obj = bpy.data.objects.new(name, light)
        obj.rotation_euler = rot
        scene.collection.objects.link(obj)
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.34, 0.4, 0.5, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    scene.world = world


def camera(scene, target, distance, yaw, pitch, lens=50):
    cam_data = bpy.data.cameras.new("camera")
    cam_data.lens = lens
    cam = bpy.data.objects.new("camera", cam_data)
    scene.collection.objects.link(cam)
    direction = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    cam.location = target + direction * distance
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return cam


def render(scene, path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"[render-kit] wrote {path}")


def main():
    args = parse_args()
    files = sorted(glob.glob(os.path.join(args.src, "kit-v2.*.glb")))
    if not files:
        raise SystemExit(f"no kit exports in {args.src}; run `npx tsx scripts/kit/export-kit.ts` first")
    os.makedirs(args.out, exist_ok=True)
    scene = reset_scene()
    width, height = (int(v) for v in args.size.split("x"))
    scene.render.resolution_x, scene.render.resolution_y = width, height
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = args.samples
    spacing = 3.2
    tanks = []
    for i, path in enumerate(files):
        tanks.append((os.path.basename(path)[len("kit-v2."):-len(".glb")], import_tank(path, (i - (len(files) - 1) / 2) * spacing)))
    lo, hi = bounds([o for _, objs in tanks for o in objs])
    studio(scene, lo, hi)
    centre = (lo + hi) / 2
    cam = camera(scene, centre, max(hi.x - lo.x, 4) * 1.1, math.radians(12), math.radians(26), lens=30)
    render(scene, os.path.join(args.out, "kit-contact-sheet.png"))
    for key, objs in tanks:
        tlo, thi = bounds(objs)
        bpy.data.objects.remove(cam)
        cam = camera(scene, (tlo + thi) / 2, 5.2, math.radians(35), math.radians(22))
        render(scene, os.path.join(args.out, f"kit-{key}.png"))


if __name__ == "__main__":
    main()

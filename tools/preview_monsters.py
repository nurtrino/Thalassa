"""Render a contact sheet of every generated monster GLB (Cycles CPU).

    python tools/preview_monsters.py [out.png] [ids...]
"""
import math
import os
import sys

import bpy
from mathutils import Vector

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.path.join(BASE, "static", "assets", "monsters")
TMP = os.environ.get("PREVIEW_TMP", "/tmp/monster_previews")


def render_one(path, out_png):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 24
    sc.cycles.use_denoising = False
    sc.render.resolution_x = sc.render.resolution_y = 300
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.42, 0.5, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0

    bpy.ops.import_scene.gltf(filepath=path)
    # measure bounds
    lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
    for o in sc.objects:
        if o.type == "MESH":
            for c in o.bound_box:
                w = o.matrix_world @ Vector(c)
                lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    center = (lo + hi) / 2
    size = max((hi - lo).length, 0.1)

    bpy.ops.mesh.primitive_plane_add(size=size * 8, location=(0, 0, lo.z))
    plane = bpy.context.active_object
    m = bpy.data.materials.new("ground"); m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.28, 0.3, 0.33, 1)
    plane.data.materials.append(m)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (0.9, 0.2, 0.6)
    sc.collection.objects.link(sun)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    d = size * 1.35
    cam.location = center + Vector((d * 0.85, -d * 0.85, d * 0.55))
    direction = center - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    sc.render.filepath = out_png
    bpy.ops.render.render(write_still=True)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/monsters_sheet.png"
    only = sys.argv[2:]
    os.makedirs(TMP, exist_ok=True)
    ids = sorted(f[:-4] for f in os.listdir(GLB) if f.endswith(".glb"))
    if only:
        ids = [i for i in ids if i in only]
    for sid in ids:
        png = os.path.join(TMP, f"{sid}.png")
        render_one(os.path.join(GLB, f"{sid}.glb"), png)
        print("rendered", sid)
    # montage with PIL
    from PIL import Image, ImageDraw
    cols = 6
    rows = math.ceil(len(ids) / cols)
    cell = 300
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 22)), (18, 22, 28))
    dr = ImageDraw.Draw(sheet)
    for i, sid in enumerate(ids):
        img = Image.open(os.path.join(TMP, f"{sid}.png"))
        x, y = (i % cols) * cell, (i // cols) * (cell + 22)
        sheet.paste(img, (x, y))
        dr.text((x + 8, y + cell + 4), sid, fill=(230, 220, 190))
    sheet.save(out)
    print("sheet:", out)


if __name__ == "__main__":
    main()

"""
Blender monster factory — every creature in Thalassa, generated headless.

    python tools/make_monsters.py            # writes static/assets/monsters/*.glb

Runs under Blender-as-a-python-module (pip install bpy). Each species is a
low-poly, flat-shaded rig built from primitives with an explicit part
hierarchy; the client animates parts BY NAME, so the naming contract below
is load-bearing:

    root       top-level empty (scaled so creatures share a height standard)
    body       main mass (breathing/bob)          head / jaw    look & bite
    legFL legFR legBL legBR                       quadruped legs (hip pivot)
    armL armR legL legR                           biped limbs (shoulder/hip)
    wingL wingR                                   flap (shoulder pivot)
    tail0..tailN                                  slither/sway chains
    vine0..vineN                                  plant-horror tentacles
    weapon shield                                 held props (swing)
    eye / core / wisp                             emissive bits (pulse)

Materials are Principled BSDF, roughness ~0.9 (matte clay look), with
emission on eyes/cores. A material literally named "PlayerTint" is recolored
by the client to the owning player's color (the captain figure uses it).
"""
from __future__ import annotations

import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "static", "assets", "monsters")

# ── palette ──────────────────────────────────────────────────────────────────
def C(hexstr, alpha=1.0):
    h = hexstr.lstrip("#")
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255,
            int(h[4:6], 16) / 255, alpha)

FUR_GREY = C("6d6a72"); FUR_DARK = C("4a4650"); FUR_SNOW = C("d8dde3")
FUR_RED = C("8a4b2f");  FUR_AMBER = C("9a6a3a"); BONE = C("cfc4a8")
HIDE = C("7a5c40");     LEAF = C("4f7a3a");      LEAF_DARK = C("35522a")
STONE = C("8b8578");    STONE_DARK = C("5d574c"); SAND = C("cbb083")
ICE = C("bfe4ef");      ICE_DEEP = C("7fb6cf");  MARBLE = C("e8e4d8")
CLOTH_RED = C("7d2f24"); CLOTH_BLUE = C("2e4a68"); GOLD = C("c9a227")
SKIN = C("b98a62");     SKIN_PALE = C("cdd7d4"); WOOD = C("6f4f30")
DARKWOOD = C("4a3520"); TEAL = C("2e6e62");      VIOLET = C("5a3f6e")
BLOOD = C("6e1f1f");    JADE = C("57876b");      MOSS = C("6a8a4a")

_mats = {}
def mat(name, rgba, rough=0.9, metal=0.0, emit=None, emit_str=2.0):
    key = (name)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = emit
        bsdf.inputs["Emission Strength"].default_value = emit_str
    _mats[key] = m
    return m


# ── scene helpers ────────────────────────────────────────────────────────────
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()


def _shade_flat(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = False


def prim(kind, name, material, scale=(1, 1, 1), loc=(0, 0, 0), rot=(0, 0, 0),
         pivot=(0, 0, 0), parent=None, segs=10, rings=8, jitter=0.0,
         seed=0):
    """Add a primitive whose ORIGIN sits at `pivot` (in its local frame),
    so rotating the object swings it around the joint."""
    if kind == "cube":
        bpy.ops.mesh.primitive_cube_add(size=1)
    elif kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings,
                                             radius=0.5)
    elif kind == "ico":
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.5)
    elif kind == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=0.5, radius2=0,
                                        depth=1)
    elif kind == "cyl":
        bpy.ops.mesh.primitive_cylinder_add(vertices=segs, radius=0.5, depth=1)
    else:
        raise ValueError(kind)
    obj = bpy.context.active_object
    obj.name = name
    me = obj.data
    me.transform(Matrix.Diagonal(Vector(scale)).to_4x4())
    if jitter:
        rng = random.Random(seed or hash(name) & 0xFFFF)
        for v in me.vertices:
            v.co += Vector((rng.uniform(-jitter, jitter),
                            rng.uniform(-jitter, jitter),
                            rng.uniform(-jitter, jitter)))
    me.transform(Matrix.Translation(Vector(pivot) * -1))
    _shade_flat(obj)
    if material:
        obj.data.materials.append(material)
    obj.location = loc
    obj.rotation_euler = rot
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(e)
    e.location = loc
    if parent is not None:
        e.parent = parent
    return e


def export(root, out_name, height=None):
    """Normalize the rig so its top sits at `height` (world units), feet at
    z≈0, then export the hierarchy to GLB."""
    bpy.context.view_layer.update()
    # measure the world bounds of all mesh descendants
    zs, xs = [], []
    def walk(o):
        if o.type == "MESH":
            for corner in o.bound_box:
                w = o.matrix_world @ Vector(corner)
                zs.append(w.z); xs.append(w.x)
        for c in o.children:
            walk(c)
    walk(root)
    if height and zs:
        h = max(zs) - min(zs)
        s = height / max(h, 1e-6)
        root.scale = (s, s, s)
        bpy.context.view_layer.update()
        zs2 = []
        def walk2(o):
            if o.type == "MESH":
                for corner in o.bound_box:
                    zs2.append((o.matrix_world @ Vector(corner)).z)
            for c in o.children:
                walk2(c)
        walk2(root)
        root.location.z -= min(zs2)
    for o in bpy.context.scene.objects:
        o.select_set(True)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{out_name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB",
                              use_selection=True, export_yup=True,
                              export_apply=False)
    return path


# ── archetype builders ───────────────────────────────────────────────────────
def build_quadruped(spec):
    """Wolves, boars, stags, jaguars, foxes — spec keys:
    fur, belly, bulk, snout, ears, horns ('tusks'|'antlers'|'horns'|None),
    tail ('brush'|'thin'|'curl'), lean, crown, spikes"""
    fur = mat("fur", spec.get("fur", FUR_GREY))
    dark = mat("furdark", spec.get("dark", FUR_DARK))
    root = empty("root")
    bulk = spec.get("bulk", 1.0)
    lean = spec.get("lean", 1.0)
    body = prim("sphere", "body", fur, scale=(1.9 * lean, 1.0 * bulk, 1.05 * bulk),
                loc=(0, 0, 1.05), parent=root, jitter=0.04)
    prim("sphere", "chest", fur, scale=(1.0, 0.95 * bulk, 1.0 * bulk),
         loc=(0.65, 0, 0.08), parent=body, jitter=0.03)
    hd = empty("head", loc=(1.15, 0, 0.42), parent=body)
    prim("sphere", "skull", fur, scale=(0.75, 0.62, 0.6), parent=hd, jitter=0.03)
    sn = spec.get("snout", 0.5)
    prim("cube", "snoutm", dark, scale=(sn, 0.3, 0.26), loc=(0.42, 0, -0.08),
         parent=hd)
    jaw = prim("cube", "jaw", dark, scale=(sn * 0.9, 0.26, 0.1),
               loc=(0.42, 0, -0.2), pivot=(-sn * 0.45, 0, 0), parent=hd)
    eye = mat("eye", C("111111"), emit=spec.get("eye", C("ffd08a")), emit_str=3)
    for sy in (-1, 1):
        prim("sphere", "eye", eye, scale=(0.1, 0.1, 0.1),
             loc=(0.3, 0.22 * sy, 0.14), parent=hd, segs=6, rings=4)
    if spec.get("ears", True):
        for sy in (-1, 1):
            prim("cone", "ear", dark, scale=(0.22, 0.14, 0.42),
                 loc=(-0.05, 0.3 * sy, 0.42), rot=(0.25 * sy, -0.2, 0), parent=hd)
    horns = spec.get("horns")
    if horns == "tusks":
        for sy in (-1, 1):
            prim("cone", "tusk", mat("bone", BONE), scale=(0.1, 0.1, 0.5),
                 loc=(0.55, 0.18 * sy, -0.18), rot=(0.35 * sy, 1.15, 0), parent=hd)
    elif horns == "antlers":
        bone = mat("bone", BONE)
        big = spec.get("antler_scale", 1.0)
        for sy in (-1, 1):
            a = empty("antler", loc=(-0.05, 0.2 * sy, 0.42), parent=hd)
            # a fan of tines rising from one root — reads as antlers, never
            # falls apart into floating sticks
            for i, (rx, ry, ln) in enumerate((
                    (0.55, -0.35, 0.9), (0.3, -0.75, 1.1),
                    (0.05, -1.1, 0.9), (0.42, -1.35, 0.6))):
                prim("cone", "tine", bone,
                     scale=(0.14, 0.14, ln * big),
                     pivot=(0, 0, -ln * big / 2),
                     rot=(rx * sy, ry, 0), parent=a, segs=5)
    elif horns == "horns":
        for sy in (-1, 1):
            prim("cone", "horn", mat("bone", BONE), scale=(0.14, 0.14, 0.5),
                 loc=(0.05, 0.26 * sy, 0.5), rot=(0.5 * sy, -0.4, 0), parent=hd)
    leg_r = 0.3 * bulk
    leg_l = spec.get("leg", 1.05)
    for nm, lx, ly in (("legFL", 0.55, 0.3), ("legFR", 0.55, -0.3),
                       ("legBL", -0.62, 0.3), ("legBR", -0.62, -0.3)):
        leg = prim("cyl", nm, dark, scale=(leg_r, leg_r, leg_l + 0.35),
                   pivot=(0, 0, (leg_l + 0.35) / 2 - 0.1),
                   loc=(lx, ly * bulk, -0.25), parent=body, segs=7)
        prim("sphere", "hip", dark, scale=(leg_r * 1.5, leg_r * 1.5, leg_r * 1.5),
             parent=leg, segs=7, rings=5)
    tail = spec.get("tail", "brush")
    if tail == "brush":
        prim("sphere", "tail0", fur, scale=(0.7, 0.24, 0.24),
             pivot=(0.32, 0, 0), loc=(-1.05, 0, 0.25), rot=(0, -0.5, 0),
             parent=body, jitter=0.03)
    elif tail == "thin":
        prim("cyl", "tail0", dark, scale=(0.08, 0.08, 0.8), pivot=(0, 0, 0.4),
             loc=(-1.05, 0, 0.2), rot=(0, 2.2, 0), parent=body, segs=6)
    elif tail == "curl":
        prim("sphere", "tail0", dark, scale=(0.22, 0.2, 0.3), loc=(-1.0, 0, 0.5),
             parent=body, jitter=0.02)
    if spec.get("mane"):
        prim("sphere", "mane", dark, scale=(0.8, 1.05, 1.1),
             loc=(0.7, 0, 0.25), parent=body, jitter=0.09)
    if spec.get("spikes"):
        smat = mat("spike", spec.get("spike_col", ICE), rough=0.35)
        for i in range(4):
            prim("cone", "spike", smat, scale=(0.16, 0.16, 0.55 - 0.07 * i),
                 loc=(0.55 - 0.5 * i, 0, 0.95 * bulk), rot=(0, 0.2, 0),
                 parent=body)
    if spec.get("crown"):
        add_crown(hd, (0, 0, 0.62))
    return root


def add_crown(parent, loc):
    g = mat("gold", GOLD, rough=0.35, metal=0.9)
    c = empty("crown", loc=loc, parent=parent)
    prim("cyl", "band", g, scale=(0.42, 0.42, 0.12), parent=c, segs=8)
    for i in range(5):
        a = i / 5 * math.tau
        prim("cone", "point", g, scale=(0.09, 0.09, 0.22),
             loc=(math.cos(a) * 0.19, math.sin(a) * 0.19, 0.14), parent=c, segs=4)


def build_biped(spec):
    """Raiders, fauns, cyclopes, golems, the drowned — spec keys:
    skin, cloth, bulk, head_scale, one_eye, horns, weapon
    ('sword'|'club'|'spear'|'staff'|None), shield, helmet, stone, seaweed"""
    skin = mat("skin", spec.get("skin", SKIN))
    cloth = mat("cloth", spec.get("cloth", CLOTH_RED))
    root = empty("root")
    bulk = spec.get("bulk", 1.0)
    stone = spec.get("stone", False)
    jit = 0.09 if stone else 0.03
    body = prim("sphere", "body", cloth if spec.get("clothed", True) else skin,
                scale=(0.85 * bulk, 0.65 * bulk, 1.15), loc=(0, 0, 1.75),
                parent=root, jitter=jit)
    hs = spec.get("head_scale", 1.0)
    hd = empty("head", loc=(0, 0, 0.85), parent=body)
    prim("sphere", "skull", skin, scale=(0.55 * hs, 0.5 * hs, 0.55 * hs),
         parent=hd, jitter=jit)
    eyec = spec.get("eye", C("ffb457"))
    eyem = mat("eye", C("101010"), emit=eyec, emit_str=3)
    if spec.get("one_eye"):
        prim("sphere", "eye", eyem, scale=(0.16, 0.16, 0.16),
             loc=(0.24 * hs, 0, 0.05), parent=hd, segs=6, rings=4)
    else:
        for sy in (-1, 1):
            prim("sphere", "eye", eyem, scale=(0.09, 0.09, 0.09),
                 loc=(0.22 * hs, 0.14 * sy * hs, 0.05), parent=hd, segs=6, rings=4)
    if spec.get("horns"):
        for sy in (-1, 1):
            prim("cone", "horn", mat("bone", BONE), scale=(0.1, 0.1, 0.34),
                 loc=(0.02, 0.2 * sy * hs, 0.3), rot=(0.6 * sy, -0.3, 0), parent=hd)
    if spec.get("helmet"):
        hm = mat("bronze", GOLD, rough=0.4, metal=0.8)
        prim("sphere", "helm", hm, scale=(0.6 * hs, 0.55 * hs, 0.55 * hs),
             loc=(0, 0, 0.1), parent=hd)
        prim("cube", "crest", mat("crest", CLOTH_RED),
             scale=(0.55, 0.09, 0.3), loc=(-0.04, 0, 0.38), parent=hd,
             jitter=0.02)
    arm_l = 0.95 * bulk
    for nm, sy in (("armL", 1), ("armR", -1)):
        arm = prim("cyl", nm, skin, scale=(0.24 * bulk, 0.24 * bulk, arm_l),
                   pivot=(0, 0, arm_l / 2 - 0.08),
                   loc=(0, 0.4 * bulk * sy, 0.5),
                   rot=(0.3 * sy, 0, 0), parent=body, segs=7, jitter=jit)
        prim("sphere", "shoulder", skin,
             scale=(0.32 * bulk,) * 3, parent=arm, segs=7, rings=5)
    leg_l = 1.25
    for nm, sy in (("legL", 1), ("legR", -1)):
        leg = prim("cyl", nm, mat("legs", spec.get("legs", DARKWOOD)),
                   scale=(0.28 * bulk, 0.28 * bulk, leg_l),
                   pivot=(0, 0, leg_l / 2 - 0.08),
                   loc=(0, 0.24 * bulk * sy, -0.5),
                   parent=body, segs=7, jitter=jit)
        prim("sphere", "hip", skin, scale=(0.3 * bulk,) * 3, parent=leg,
             segs=7, rings=5)
    hand_y = 0.4 * bulk + math.sin(0.3) * arm_l
    hand_z = 0.5 - math.cos(0.3) * arm_l
    wep = spec.get("weapon")
    if wep:
        wp = empty("weapon", loc=(0.1, -hand_y, hand_z), parent=body)
        wood = mat("haft", WOOD)
        steel = mat("steel", C("9aa2ac"), rough=0.35, metal=0.8)
        if wep == "sword":
            prim("cube", "blade", steel, scale=(0.16, 0.06, 1.1),
                 pivot=(0, 0, -0.5), rot=(0, 0.45, 0), parent=wp)
            prim("cube", "guard", wood, scale=(0.34, 0.1, 0.1),
                 loc=(0.05, 0, 0.06), parent=wp)
        elif wep == "club":
            prim("cone", "clubm", wood, scale=(0.55, 0.55, 1.3),
                 pivot=(0, 0, 0.5), rot=(0, 2.5, 0), parent=wp, segs=7,
                 jitter=0.05)
        elif wep == "spear":
            prim("cyl", "haftm", wood, scale=(0.1, 0.1, 2.1), parent=wp,
                 rot=(0.12, 0.5, 0), segs=6)
            prim("cone", "tip", steel, scale=(0.16, 0.16, 0.34),
                 loc=(math.sin(0.5) * 1.05, -0.12, math.cos(0.5) * 1.05),
                 rot=(0.12, 0.5, 0), parent=wp)
        elif wep == "staff":
            prim("cyl", "haftm", wood, scale=(0.1, 0.1, 1.7), parent=wp, segs=6)
            prim("ico", "orb", mat("orb", C("101418"),
                 emit=spec.get("eye", C("8ad2ff")), emit_str=4),
                 scale=(0.2, 0.2, 0.2), loc=(0, 0, 0.9), parent=wp)
    if spec.get("shield"):
        sh = empty("shield", loc=(0.28, hand_y, hand_z + 0.2), parent=body)
        prim("cyl", "shieldm", mat("bronze2", GOLD, rough=0.45, metal=0.7),
             scale=(0.9, 0.9, 0.1), rot=(0, 1.5708, 0.25), parent=sh, segs=10)
        prim("sphere", "boss", mat("bronze3", C("8a6c1c"), rough=0.4,
             metal=0.8), scale=(0.2, 0.2, 0.2), loc=(0.08, 0, 0), parent=sh,
             segs=6, rings=4)
    if spec.get("seaweed"):
        weed = mat("weed", TEAL)
        rng = random.Random(7)
        for i in range(5):
            prim("cone", "weed", weed, scale=(0.08, 0.08, 0.5),
                 loc=(rng.uniform(-0.3, 0.3), rng.uniform(-0.4, 0.4),
                      rng.uniform(0.2, 0.9)),
                 rot=(rng.uniform(-2.5, -1.2), 0, 0), parent=body)
    if spec.get("crown"):
        add_crown(hd, (0, 0, 0.5 * hs + 0.1))
    return root


def build_bird(spec):
    """Crows, vultures, harpies — spec keys: feathers, wing_span, bald,
    woman (harpy face/hair), tail_fan"""
    fe = mat("feathers", spec.get("feathers", FUR_DARK))
    root = empty("root")
    body = prim("sphere", "body", fe, scale=(1.0, 0.62, 0.62), loc=(0, 0, 1.3),
                parent=root, jitter=0.03)
    hd = empty("head", loc=(0.62, 0, 0.3), parent=body)
    skin = mat("skin", spec.get("skin", SKIN)) if spec.get("woman") else fe
    prim("sphere", "skull", skin, scale=(0.42, 0.4, 0.42), parent=hd, jitter=0.02)
    if spec.get("bald"):
        prim("sphere", "neck", mat("bald", SKIN_PALE), scale=(0.3, 0.28, 0.5),
             loc=(-0.15, 0, -0.3), parent=hd)
    beak = mat("beak", C("d8a53c"), rough=0.5)
    if not spec.get("woman"):
        prim("cone", "beakm", beak, scale=(0.14, 0.14, 0.42),
             loc=(0.4, 0, -0.02), rot=(0, 1.5708, 0), parent=hd)
    else:
        prim("sphere", "hair", mat("hair", FUR_DARK), scale=(0.44, 0.44, 0.4),
             loc=(-0.08, 0, 0.12), parent=hd, jitter=0.05)
    eyem = mat("eye", C("101010"), emit=spec.get("eye", C("ffd08a")), emit_str=3)
    for sy in (-1, 1):
        prim("sphere", "eye", eyem, scale=(0.07, 0.07, 0.07),
             loc=(0.26, 0.16 * sy, 0.08), parent=hd, segs=6, rings=4)
    span = spec.get("wing_span", 1.5)
    for nm, sy in (("wingL", 1), ("wingR", -1)):
        w = empty(nm, loc=(0.1, 0.45 * sy, 0.25), parent=body)
        prim("cube", "wpanel", fe, scale=(0.7, span, 0.07),
             pivot=(0, -span / 2 * sy, 0), rot=(0.15 * sy, 0, 0), parent=w)
        prim("cube", "wtip", fe, scale=(0.5, span * 0.55, 0.06),
             pivot=(0, -span * 0.27 * sy, 0),
             loc=(-0.08, span * sy, 0), rot=(0.35 * sy, 0, 0), parent=w)
    prim("cube", "tail0", fe, scale=(0.7, 0.4, 0.06), pivot=(0.35, 0, 0),
         loc=(-0.85, 0, 0.05), rot=(0, -0.25, 0), parent=body)
    talon = mat("talon", C("d8a53c"), rough=0.5)
    for sy in (-1, 1):
        prim("cyl", "leg", talon, scale=(0.06, 0.06, 0.6),
             pivot=(0, 0, 0.25), loc=(0.1, 0.2 * sy, -0.55), parent=body, segs=5)
    return root


def build_serpent(spec):
    """Sea serpents, dust serpents, the Boreal Wyrm — spec keys:
    scale_col, belly, segs, girth, fins, ice, hood, crown"""
    sc = mat("scales", spec.get("scale_col", TEAL))
    root = empty("root")
    girth = spec.get("girth", 0.55)
    n = spec.get("segs", 6)
    # head rears up at the front
    hd = empty("head", loc=(0.9, 0, 1.9), parent=root)
    prim("sphere", "skull", sc, scale=(0.9, 0.62, 0.55), rot=(0, 0.5, 0),
         parent=hd, jitter=0.03)
    jaw = prim("cube", "jaw", mat("maw", BLOOD), scale=(0.62, 0.4, 0.1),
               loc=(0.28, 0, -0.25), pivot=(-0.3, 0, 0), rot=(0, 0.5, 0),
               parent=hd)
    eyem = mat("eye", C("101010"), emit=spec.get("eye", C("aef2ff")), emit_str=4)
    for sy in (-1, 1):
        prim("sphere", "eye", eyem, scale=(0.1, 0.1, 0.1),
             loc=(0.3, 0.25 * sy, 0.2), parent=hd, segs=6, rings=4)
    if spec.get("hood"):
        prim("cube", "hood", sc, scale=(0.1, 1.1, 0.8), loc=(-0.35, 0, 0.1),
             parent=hd)
    if spec.get("horns"):
        for sy in (-1, 1):
            prim("cone", "horn", mat("bone", BONE), scale=(0.12, 0.12, 0.55),
                 loc=(-0.2, 0.25 * sy, 0.35), rot=(0.7 * sy, -0.7, 0), parent=hd)
    # neck arcs down into coils that trail behind
    pts = []
    for i in range(n):
        t = i / (n - 1)
        x = 0.55 - t * 2.6
        z = 1.45 * (1 - t) ** 1.6 + girth * 0.55
        pts.append((x, math.sin(t * 5.2) * 0.35 * t, z))
    prev_parent = root
    for i, (x, y, z) in enumerate(pts):
        seg = prim("sphere", f"tail{i}", sc,
                   scale=(girth * (1.15 - 0.1 * i / n),) * 2 +
                         (girth * (1.15 - 0.1 * i / n),),
                   loc=(x, y, z), parent=root, jitter=0.03, seed=i + 3)
        if spec.get("ice") and i % 2 == 0:
            prim("cone", "spike", mat("icem", ICE, rough=0.25),
                 scale=(0.14, 0.14, 0.5), loc=(x, y, z + girth * 0.8),
                 parent=root)
        if spec.get("fins") and i < 2:
            for sy in (-1, 1):
                prim("cube", "fin", mat("fin", spec.get("fin_col", ICE_DEEP)),
                     scale=(0.5, 0.08, 0.35),
                     loc=(x, (girth * 0.9) * sy, z + 0.1),
                     rot=(0.6 * sy, 0, 0), parent=root)
    prim("cone", "tailtip", sc, scale=(girth * 0.8, girth * 0.8, 0.9),
         loc=(pts[-1][0] - 0.7, pts[-1][1], girth * 0.5), rot=(0, -1.5708, 0),
         parent=root)
    if spec.get("crown"):
        add_crown(hd, (0, 0, 0.55))
    return root


def build_wraith(spec):
    """Wraiths, shades, sirens, mirage dancers — floating cloaked spirits.
    spec keys: cloak, inner, hood, arms, tatters, crown"""
    ck = mat("cloak", spec.get("cloak", C("3d4653", 1.0)))
    root = empty("root")
    body = prim("cone", "body", ck, scale=(0.9, 0.9, 1.9), loc=(0, 0, 1.5),
                rot=(0, 0, 0), parent=root, segs=9, jitter=0.06)
    # tattered hem: small dangling cones
    rng = random.Random(11)
    for i in range(7):
        a = i / 7 * math.tau
        prim("cone", "tatter", ck, scale=(0.14, 0.14, 0.45),
             loc=(math.cos(a) * 0.38, math.sin(a) * 0.38, -0.95),
             rot=(rng.uniform(-0.3, 0.3), math.pi, 0), parent=body, segs=5)
    hd = empty("head", loc=(0, 0, 0.95), parent=body)
    prim("sphere", "hood", ck, scale=(0.52, 0.5, 0.55), parent=hd, jitter=0.04)
    face = mat("void", C("07090c"))
    prim("sphere", "face", face, scale=(0.34, 0.36, 0.4), loc=(0.16, 0, -0.02),
         parent=hd)
    eyem = mat("eye", C("101010"), emit=spec.get("eye", C("9fe8ff")), emit_str=5)
    for sy in (-1, 1):
        prim("sphere", "eye", eyem, scale=(0.07, 0.07, 0.07),
             loc=(0.32, 0.12 * sy, 0.04), parent=hd, segs=6, rings=4)
    if spec.get("arms", True):
        for nm, sy in (("armL", 1), ("armR", -1)):
            prim("cone", nm, ck, scale=(0.16, 0.16, 0.9),
                 pivot=(0, 0, 0.45), loc=(0.15, 0.5 * sy, 0.35),
                 rot=(0.9 * sy, 0.4, 0), parent=body, segs=6)
    wisp = mat("wisp", C("0c0f14"), emit=spec.get("wisp", C("77c9e8")),
               emit_str=2.5)
    for i in range(3):
        a = i / 3 * math.tau
        prim("ico", "wisp", wisp, scale=(0.12, 0.12, 0.12),
             loc=(math.cos(a) * 0.8, math.sin(a) * 0.8, 0.2 + 0.3 * i),
             parent=root)
    if spec.get("crown"):
        add_crown(hd, (0, 0, 0.55))
    return root


def build_arthropod(spec):
    """Crabs and scorpions — spec keys: shell, legs(n per side), claws,
    sting (adds tail chain + stinger), glassy"""
    rough = 0.3 if spec.get("glassy") else 0.75
    sh = mat("shell", spec.get("shell", C("a04a32")), rough=rough)
    dk = mat("shelldark", spec.get("dark", C("6e3020")), rough=rough)
    root = empty("root")
    body = prim("sphere", "body", sh, scale=(1.9, 1.5, 0.8), loc=(0, 0, 0.85),
                parent=root, jitter=0.04)
    eyem = mat("eye", C("101010"), emit=spec.get("eye", C("ffd08a")), emit_str=3)
    for sy in (-1, 1):
        prim("sphere", "eye", eyem, scale=(0.12, 0.12, 0.12),
             loc=(0.8, 0.26 * sy, 0.3), parent=body, segs=6, rings=4)
    npairs = spec.get("legs", 3)
    for i in range(npairs):
        for sy in (-1, 1):
            lx = 0.35 - i * 0.45
            leg = empty(f"leg{i}{'L' if sy > 0 else 'R'}",
                        loc=(lx, 0.55 * sy, -0.15), parent=body)
            prim("cyl", "seg1", dk, scale=(0.16, 0.16, 0.9),
                 pivot=(0, 0, -0.45), rot=(1.05 * sy, 0, 0), parent=leg, segs=5)
            prim("cyl", "seg2", dk, scale=(0.13, 0.13, 0.85),
                 pivot=(0, 0, 0.4),
                 loc=(0, math.sin(1.05) * 0.9 * sy, -math.cos(1.05) * 0.9),
                 rot=(-0.35 * sy, 0, 0), parent=leg, segs=5)
    if spec.get("claws", True):
        for nm, sy in (("clawL", 1), ("clawR", -1)):
            cl = empty(nm, loc=(0.8, 0.5 * sy, 0.0), parent=body)
            prim("cyl", "clarm", dk, scale=(0.2, 0.2, 0.7),
                 pivot=(0, 0, -0.35), rot=(0.55 * sy, -1.2, 0), parent=cl, segs=6)
            prim("sphere", "pincer", sh, scale=(0.62, 0.4, 0.34),
                 loc=(0.62, 0.24 * sy, 0.22), parent=cl, jitter=0.03)
            prim("cone", "pincertip", dk, scale=(0.16, 0.26, 0.4),
                 loc=(0.98, 0.24 * sy, 0.26), rot=(0, 1.5708, 0), parent=cl)
    if spec.get("sting"):
        # tail: an absolute arc curling up and forward over the back
        pts = [(-1.0, 0, 0.45), (-1.35, 0, 0.95), (-1.4, 0, 1.5),
               (-1.1, 0, 1.95)]
        for i, (x, y, z) in enumerate(pts):
            prim("sphere", f"tail{i}", sh,
                 scale=(0.5 - i * 0.06,) * 3, loc=(x, y, z), parent=body,
                 jitter=0.02, seed=i + 5)
        prim("cone", "stinger", dk, scale=(0.2, 0.2, 0.6),
             loc=(-0.75, 0, 2.1), rot=(0, 1.9, 0), parent=body)
    return root


def build_plant(spec):
    """Briar beasts and the Strangler Matriarch — spec keys: bark, leaf,
    vines, maw, bloom, crown, bulk"""
    bark = mat("bark", spec.get("bark", DARKWOOD))
    leaf = mat("leaf", spec.get("leaf", LEAF))
    root = empty("root")
    bulk = spec.get("bulk", 1.0)
    body = prim("sphere", "body", bark, scale=(1.3 * bulk, 1.2 * bulk, 1.5 * bulk),
                loc=(0, 0, 1.4 * bulk), parent=root, jitter=0.12)
    prim("sphere", "moss", leaf, scale=(1.1 * bulk, 1.0 * bulk, 0.7 * bulk),
         loc=(0, 0, 0.8 * bulk), parent=body, jitter=0.14)
    if spec.get("maw", True):
        prim("sphere", "mawm", mat("maw", BLOOD), scale=(0.55, 0.8, 0.6),
             loc=(0.58 * bulk, 0, 0.05), parent=body, jitter=0.04)
        tooth = mat("bone", BONE)
        for i in range(5):
            a = (i / 4 - 0.5) * 2.4
            prim("cone", "tooth", tooth, scale=(0.1, 0.1, 0.26),
                 loc=(0.78 * bulk, math.sin(a) * 0.34,
                      0.05 + math.cos(a) * 0.28),
                 rot=(0, 1.5708 + 0.5 * math.cos(a), 0), parent=body)
    eyem = mat("eye", C("101010"), emit=spec.get("eye", C("d8ff9a")), emit_str=4)
    for sy in (-1, 1):
        prim("sphere", "eye", eyem, scale=(0.13, 0.13, 0.13),
             loc=(0.62 * bulk, 0.4 * sy, 0.65), parent=body, segs=6, rings=4)
    nv = spec.get("vines", 4)
    for i in range(nv):
        a = (i / nv) * math.tau + 0.4
        ca, sa = math.cos(a), math.sin(a)
        v = empty(f"vine{i}", loc=(ca * 0.7 * bulk, sa * 0.7 * bulk,
                                   0.6 * bulk), parent=body)
        # vine = arc of shrinking spheres reaching out and up, tip leaf-cone
        for k in range(1, 4):
            t = k / 3
            prim("sphere", "vseg", bark,
                 scale=(0.3 - 0.06 * k,) * 3,
                 loc=(ca * t * 1.2, sa * t * 1.2, 0.55 * t + 0.35 * t * t),
                 parent=v, jitter=0.03, seed=i * 7 + k)
        prim("cone", "vtip", leaf, scale=(0.28, 0.28, 0.55),
             loc=(ca * 1.35, sa * 1.35, 1.15), rot=(-sa * 0.5, ca * 0.5, 0),
             parent=v, segs=5)
    if spec.get("bloom"):
        petal = mat("petal", C("c95a7e"))
        bl = empty("bloom", loc=(0, 0, 1.5 * bulk), parent=body)
        for i in range(6):
            a = i / 6 * math.tau
            prim("cube", "petalm", petal, scale=(0.7, 0.3, 0.06),
                 pivot=(-0.35, 0, 0), rot=(0, -0.5, a), parent=bl)
        prim("ico", "core", mat("core", C("101010"), emit=C("ffe08a"),
             emit_str=4), scale=(0.3, 0.3, 0.3), parent=bl)
    if spec.get("crown"):
        add_crown(body, (0, 0, 1.9 * bulk))
    return root


def build_boat(spec):
    """The brigand skiff — a hostile little boat with a ragged sail."""
    wood = mat("hull", DARKWOOD)
    root = empty("root")
    body = prim("cube", "body", wood, scale=(2.4, 0.9, 0.5), loc=(0, 0, 0.55),
                parent=root, jitter=0.05)
    prim("cube", "keel", mat("keel", WOOD), scale=(2.6, 0.2, 0.2),
         loc=(0, 0, 0.3), parent=body)
    prim("cyl", "mast", wood, scale=(0.07, 0.07, 2.2), loc=(0.2, 0, 1.3),
         parent=body, segs=6)
    sail = mat("sail", C("8d8577"))
    prim("cube", "sailm", sail, scale=(1.3, 0.05, 1.4), loc=(-0.5, 0, 1.6),
         rot=(0, 0.12, 0), parent=body, jitter=0.06)
    for sy in (-1, 1):
        prim("cyl", "oar", wood, scale=(0.05, 0.05, 1.3),
             loc=(0.4, 0.75 * sy, 0.35), rot=(1.1 * sy, 0, 0), parent=body,
             segs=5)
    eyem = mat("lantern", C("101010"), emit=C("ffca6a"), emit_str=4)
    prim("ico", "eye", eyem, scale=(0.16, 0.16, 0.16), loc=(1.25, 0, 0.95),
         parent=body)
    return root


def build_colossus(spec):
    """The Dune Colossus / Glacier Golem chassis / the Warden — a giant of
    stacked masonry with a burning core. spec: stone, core, helmet, spear,
    crown, kilt"""
    st = mat("stone", spec.get("stone", SAND), rough=0.95)
    dk = mat("stonedark", spec.get("dark", STONE_DARK), rough=0.95)
    root = empty("root")
    body = prim("cube", "body", st, scale=(1.5, 1.1, 1.7), loc=(0, 0, 2.6),
                parent=root, jitter=0.1)
    prim("cube", "pelvis", dk, scale=(1.2, 0.9, 0.7), loc=(0, 0, -1.1),
         parent=body, jitter=0.08)
    core = prim("ico", "core", mat("core", C("15100a"),
                emit=spec.get("core", C("ffb347")), emit_str=6),
                scale=(0.5, 0.5, 0.5), loc=(0.72, 0, 0.15), parent=body)
    hd = empty("head", loc=(0, 0, 1.25), parent=body)
    prim("cube", "skull", st, scale=(0.75, 0.65, 0.7), parent=hd, jitter=0.06)
    eyem = mat("eye", C("101010"), emit=spec.get("core", C("ffb347")), emit_str=5)
    for sy in (-1, 1):
        prim("cube", "eye", eyem, scale=(0.12, 0.14, 0.08),
             loc=(0.38, 0.18 * sy, 0.08), parent=hd)
    if spec.get("helmet"):
        hm = mat("bronze", GOLD, rough=0.4, metal=0.85)
        prim("sphere", "helm", hm, scale=(0.85, 0.75, 0.7), loc=(0, 0, 0.2),
             parent=hd)
        prim("cube", "crest", mat("crest", CLOTH_BLUE), scale=(0.9, 0.12, 0.4),
             loc=(0, 0, 0.62), parent=hd)
    for nm, sy in (("armL", 1), ("armR", -1)):
        a = empty(nm, loc=(0, 1.3 * sy, 0.75), parent=body)
        prim("cube", "upper", dk, scale=(0.55, 0.5, 1.3), pivot=(0, 0, 0.55),
             rot=(0.14 * sy, 0, 0), parent=a, jitter=0.07)
        prim("cube", "fist", st, scale=(0.6, 0.55, 0.6), loc=(0.1, 0.15 * sy, -1.5),
             parent=a, jitter=0.07)
    for nm, sy in (("legL", 1), ("legR", -1)):
        prim("cube", nm, dk, scale=(0.62, 0.55, 1.6), pivot=(0, 0, 0.7),
             loc=(0, 0.55 * sy, -2.1), parent=body, jitter=0.07)
    if spec.get("spear"):
        wp = empty("weapon", loc=(0.3, -1.55, -0.4), parent=body)
        prim("cyl", "haftm", mat("haft", WOOD), scale=(0.09, 0.09, 4.6),
             parent=wp, segs=6)
        prim("cone", "tip", mat("steel", C("cfd6dd"), rough=0.3, metal=0.8),
             scale=(0.2, 0.2, 0.7), loc=(0, 0, 2.55), parent=wp)
    if spec.get("crown"):
        add_crown(hd, (0, 0, 0.75))
    return root


# ── species table ────────────────────────────────────────────────────────────
# id → (builder, spec, target height in world units)
SPECIES = {
    # hub packs
    "wolf":     (build_quadruped, {"fur": FUR_GREY, "dark": FUR_DARK,
                                   "eye": C("ffd08a"), "mane": True}, 1.5),
    "fox":      (build_quadruped, {"fur": C("c56a3a"), "dark": C("8a4526"),
                                   "snout": 0.6, "lean": 1.05,
                                   "tail": "brush"}, 1.2),
    "jackal":   (build_quadruped, {"fur": C("b39a6a"), "dark": C("7d6a45"),
                                   "lean": 1.15, "snout": 0.6}, 1.3),
    "boar":     (build_quadruped, {"fur": C("5d4a38"), "dark": C("3d2f22"),
                                   "bulk": 1.35, "snout": 0.42, "leg": 0.8,
                                   "horns": "tusks", "tail": "curl",
                                   "mane": True}, 1.5),
    "stag":     (build_quadruped, {"fur": C("8a6a48"), "dark": C("5d462e"),
                                   "lean": 1.1, "leg": 1.3, "horns": "antlers",
                                   "eye": C("bfe8ff"), "tail": "thin"}, 2.0),
    "jaguar":   (build_quadruped, {"fur": C("2c3436"), "dark": C("15191a"),
                                   "lean": 1.2, "eye": C("9fff70"),
                                   "tail": "thin"}, 1.4),
    "stalker":  (build_quadruped, {"fur": C("a9c4cd"), "dark": C("6f8f9c"),
                                   "lean": 1.3, "leg": 1.25, "spikes": True,
                                   "eye": C("bff4ff"), "tail": "thin"}, 1.7),
    "shambler": (build_quadruped, {"fur": C("6e5a33"), "dark": C("4a3c20"),
                                   "bulk": 1.4, "leg": 0.9, "horns": "horns",
                                   "eye": C("ffc46a"), "mane": True}, 1.9),
    "harpy":    (build_bird, {"feathers": C("5d4a5e"), "woman": True,
                              "wing_span": 1.6, "eye": C("ff9a7a")}, 1.7),
    "bird":     (build_bird, {"feathers": C("2f3338"), "eye": C("a8ff8a")}, 1.2),
    "vulture":  (build_bird, {"feathers": C("4a4038"), "bald": True,
                              "wing_span": 1.8, "eye": C("ffca6a")}, 1.5),
    "raider":   (build_biped, {"skin": SKIN, "cloth": CLOTH_RED,
                               "weapon": "sword", "shield": True}, 1.8),
    "faun":     (build_biped, {"skin": SKIN, "cloth": C("6a5638"),
                               "horns": True, "weapon": "spear",
                               "legs": C("6d5334")}, 1.7),
    "monkey":   (build_biped, {"skin": C("6a5340"), "cloth": C("6a5340"),
                               "clothed": False, "head_scale": 1.2,
                               "eye": C("ffe08a")}, 1.3),
    "cyclops":  (build_biped, {"skin": C("9a7a54"), "cloth": C("5d4a30"),
                               "bulk": 1.5, "one_eye": True, "weapon": "club",
                               "head_scale": 1.15}, 2.6),
    "drowned":  (build_biped, {"skin": C("7fa08f"), "cloth": C("3d5248"),
                               "seaweed": True, "weapon": "sword",
                               "eye": C("9fe8c8")}, 1.8),
    "golem":    (build_colossus, {"stone": STONE, "dark": STONE_DARK,
                                  "core": C("8ad2ff")}, 2.4),
    "siren":    (build_wraith, {"cloak": C("3d6e78"), "eye": C("aef2ff"),
                                "wisp": C("aef2ff")}, 1.8),
    "wraith":   (build_wraith, {"cloak": C("46525f"), "eye": C("9fe8ff")}, 1.8),
    "shade":    (build_wraith, {"cloak": C("3a3342"), "eye": C("d8a0ff"),
                                "wisp": C("b78aff")}, 1.8),
    "serpent":  (build_serpent, {"scale_col": TEAL, "fins": True}, 2.2),
    "drake":    (build_quadruped, {"fur": JADE, "dark": LEAF_DARK,
                                   "snout": 0.75, "horns": "horns",
                                   "spikes": True, "spike_col": C("8a5a2f"),
                                   "eye": C("ffe08a"), "tail": "thin",
                                   "ears": False}, 1.7),
    "briar":    (build_plant, {"bark": DARKWOOD, "leaf": MOSS,
                               "vines": 3, "bulk": 0.8}, 1.7),
    "crab":     (build_arthropod, {"shell": C("b06a4a"), "dark": C("7d452c"),
                                   "eye": C("aef2ff")}, 1.3),
    "scorpion": (build_arthropod, {"shell": C("d8cba8"), "dark": C("a89468"),
                                   "sting": True, "glassy": True,
                                   "eye": C("ffe4a0")}, 1.6),
    "skiff":    (build_boat, {}, 2.2),
    # the hero (desert battles put the captain on foot)
    "captain":  (build_biped, {"skin": SKIN, "cloth": C("8a8a8a"),
                               "helmet": True, "weapon": "spear",
                               "shield": True}, 1.8),
    # bosses — big, crowned, unmistakable
    "stag_king": (build_quadruped, {"fur": C("7d5f40"), "dark": C("52402a"),
                                    "lean": 1.15, "leg": 1.5, "bulk": 1.2,
                                    "horns": "antlers", "antler_scale": 1.8,
                                    "eye": C("ffde8a"), "tail": "thin",
                                    "crown": True}, 3.4),
    "wyrm":     (build_serpent, {"scale_col": ICE_DEEP, "girth": 0.8,
                                 "segs": 7, "ice": True, "fins": True,
                                 "horns": True, "eye": C("bff4ff"),
                                 "crown": True}, 3.6),
    "colossus": (build_colossus, {"stone": SAND, "dark": C("a8905f"),
                                  "core": C("ffb347"), "crown": True}, 4.2),
    "matriarch": (build_plant, {"bark": C("3d3524"), "leaf": LEAF_DARK,
                                "vines": 6, "bulk": 1.5, "bloom": True,
                                "eye": C("d8ff9a"), "crown": True}, 3.8),
    "warden":   (build_colossus, {"stone": MARBLE, "dark": C("b9b4a5"),
                                  "core": C("8ad2ff"), "helmet": True,
                                  "spear": True, "crown": True}, 4.6),
}


def main():
    only = set(sys.argv[1:])
    made = []
    for sid, (builder, spec, height) in SPECIES.items():
        if only and sid not in only:
            continue
        reset()
        random.seed(hash(sid) & 0xFFFF)
        root = builder(spec)
        root.name = "root"
        path = export(root, sid, height=height)
        kb = os.path.getsize(path) / 1024
        made.append((sid, kb))
        print(f"  {sid:<12} {kb:7.1f} KB")
    total = sum(kb for _, kb in made)
    print(f"{len(made)} models, {total/1024:.2f} MB total")


if __name__ == "__main__":
    main()

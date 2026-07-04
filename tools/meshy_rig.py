"""
meshy_rig.py — turn the single un-rigged Meshy meshes into game-ready GLBs that
obey Thalassa's named-part contract, headless (trimesh, no Blender GUI).

    python tools/meshy_rig.py                      # rig every creature -> _rigged/
    python tools/meshy_rig.py --only wolf,tyrant

WHAT IT DOES (a solid FIRST-PASS auto-rig)
  Each Meshy mesh is one fused blob, Y-up, roughly centred, facing ±Z. For each
  one this:
    1. reorients it to the game's convention — up +Y, FORWARD +X, feet on y=0;
    2. wraps the whole textured mesh as the `body` node under a `root`;
    3. adds the emissive proxy parts the animator pulses by name — `eye`(s),
       plus `core` for constructs and a gold `crown` for bosses — each a small
       node with its pivot at the right spot.
  The game animates children BY NAME, so the result breathes/bobs/lunges/
  flinches/crumples on `body`, and the eyes/core/crown pulse — no longer static.

WHAT IT DELIBERATELY DOESN'T DO
  It does NOT slice the fused blob into separate moving legs/jaw/wings/tail —
  cutting a watertight AI mesh along planes leaves torn seams and looks worse
  than a clean body-level rig. Per-limb articulation (legFL walk gait, jaw snap,
  wing flap) is the hand-rig / retopo step; the body-plan map below is where
  you'd hook that in. Treat this as "makes them live and load correctly", not
  "fully articulated like the procedural originals".

Output lands in static/assets/monsters/_rigged/. To use one in-game, copy it
over static/assets/monsters/<id>.glb (back up the procedural one first).
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial

import meshy_prompts as CRE

TEXSIZE = None   # --texsize N: downscale every texture map to NxN on export
_TEX_ATTRS = ("baseColorTexture", "metallicRoughnessTexture",
              "normalTexture", "emissiveTexture", "occlusionTexture")


def shrink_textures(mesh, n):
    """Meshy HD exports 8K PBR maps (~28-56MB/model). Downscale to NxN so the
    GLB is web-loadable; keeps the stylized look, kills the bloat."""
    mat = getattr(mesh.visual, "material", None)
    if not mat:
        return
    for a in _TEX_ATTRS:
        t = getattr(mat, a, None)
        if t is not None and max(t.size) > n:
            setattr(mat, a, t.resize((n, n), Image.LANCZOS))


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "static", "assets", "monsters", "_meshy")
OUT = os.path.join(ROOT, "static", "assets", "monsters", "_rigged")

BOSSES = {"stag_king", "wyrm", "sphinx", "kraken", "colossus",
          "matriarch", "tyrant", "warden"}
CORE = {"golem", "golem_tomb", "golem_jade", "warden", "matriarch"}
FLOATERS = {"wraith", "shade", "siren"}
NO_EYE = {"skiff"}                       # props / boats: no eye proxy

# body plan drives orientation + eye placement
PLAN = {
    "quadruped": {"wolf", "fox", "jackal", "boar", "stag", "jaguar", "stalker",
                  "shambler", "drake", "wolf_frost", "stag_king"},
    "serpent":   {"serpent", "serpent_dust", "serpent_bloom", "wyrm"},
    "arthropod": {"crab", "scorpion"},
    "bird":      {"bird", "bird_poison", "vulture", "harpy"},
    # everything else defaults to "biped"
}

# eye glow colour (linear-ish rgb) by id; sensible default otherwise
EYE_RGB = {
    "tyrant": (1.0, 0.12, 0.08), "wyrm": (0.5, 0.9, 1.0),
    "wraith": (0.4, 0.85, 1.0), "stalker": (0.6, 0.9, 1.0),
    "fox": (0.6, 0.9, 1.0), "harpy": (0.6, 0.9, 1.0), "crab": (0.6, 0.9, 1.0),
    "shade": (0.7, 0.4, 1.0), "jaguar": (0.4, 1.0, 0.5), "briar": (0.5, 1.0, 0.4),
    "matriarch": (0.6, 1.0, 0.4), "drake": (1.0, 0.7, 0.2),
    "golem": (0.4, 0.9, 1.0), "golem_tomb": (1.0, 0.75, 0.3),
    "golem_jade": (0.5, 1.0, 0.5), "siren": (0.3, 1.0, 0.9),
    "sphinx": (1.0, 0.85, 0.4), "kraken": (1.0, 0.8, 0.3),
}
DEFAULT_EYE = (1.0, 0.85, 0.4)
GOLD = (0.85, 0.65, 0.15)


def plan_of(mid):
    for k, ids in PLAN.items():
        if mid in ids:
            return k
    return "floater" if mid in FLOATERS else "biped"


def _emissive(color, name):
    c = list(color)
    return PBRMaterial(name=name, emissiveFactor=c,
                       baseColorFactor=c + [1.0], roughnessFactor=1.0,
                       metallicFactor=0.0)


def _yaw(mesh, deg):
    if deg:
        mesh.apply_transform(
            trimesh.transformations.rotation_matrix(np.radians(deg), [0, 1, 0]))


def reorient(mesh, plan):
    """Up +Y (given). Rotate so FORWARD = +X, then ground feet to y=0 and
    centre horizontally. Returns the grounded mesh (in place)."""
    ex, ey, ez = mesh.extents
    if plan in ("quadruped", "serpent", "bird"):
        # long horizontal axis is the body length -> make it X
        if ez > ex:
            _yaw(mesh, 90)
        # head end (tall mass) should point +X
        v = mesh.vertices
        hi = v[v[:, 1] > (v[:, 1].min() + 0.65 * (v[:, 1].max() - v[:, 1].min()))]
        if len(hi) and hi[:, 0].mean() < mesh.centroid[0]:
            _yaw(mesh, 180)
    else:
        # biped / arthropod / floater: face the SHORTER horizontal axis (depth)
        if ex > ez:
            _yaw(mesh, 90)
    # ground + centre
    b = mesh.bounds
    mesh.apply_translation([-(b[0][0] + b[1][0]) / 2,
                            -b[0][1],
                            -(b[0][2] + b[1][2]) / 2])
    return mesh


def _ball(r, color, name):
    s = trimesh.creation.uv_sphere(radius=r, count=[12, 12])
    s.visual.material = _emissive(color, name)
    return s


def rig_one(mid, src, out_dir):
    body = trimesh.load(src, force="mesh")
    plan = plan_of(mid)
    reorient(body, plan)
    if TEXSIZE:
        shrink_textures(body, TEXSIZE)
    xmin, ymin, zmin = body.bounds[0]
    xmax, ymax, zmax = body.bounds[1]
    H = ymax - ymin
    W = zmax - zmin

    scene = trimesh.Scene()
    scene.add_geometry(body, node_name="body", geom_name="body", parent_node_name="world")

    def add(name, geom, xyz):
        T = np.eye(4)
        T[:3, 3] = xyz
        scene.add_geometry(geom, node_name=name, geom_name=name,
                           parent_node_name="world", transform=T)

    # eyes — near the head (front-top). floaters: inside the hood.
    if mid not in NO_EYE:
        col = EYE_RGB.get(mid, DEFAULT_EYE)
        r = max(0.02, H * 0.035)
        if plan == "floater":
            add("eye", _ball(r, col, "eye"), [xmax * 0.35, H * 0.72, 0])
        elif mid == "cyclops":
            add("eye", _ball(r * 1.7, col, "eye"), [xmax * 0.7, H * 0.78, 0])
        else:
            ez = max(0.05, W * 0.22)
            add("eye", _ball(r, col, "eye"), [xmax * 0.7, H * 0.82, ez])
            add("eye", _ball(r, col, "eye"), [xmax * 0.7, H * 0.82, -ez])

    # glowing core in the chest for constructs / plant-queen
    if mid in CORE:
        add("core", _ball(H * 0.09, EYE_RGB.get(mid, (0.4, 0.9, 1.0)), "core"),
            [xmax * 0.35, H * 0.5, 0])

    # gold crown on bosses, at the crown of the head
    if mid in BOSSES:
        crown = trimesh.creation.annulus(r_min=H * 0.09, r_max=H * 0.13, height=H * 0.06)
        crown.apply_transform(trimesh.transformations.rotation_matrix(np.radians(90), [1, 0, 0]))
        crown.visual.material = PBRMaterial(name="crown", baseColorFactor=list(GOLD) + [1.0],
                                            metallicFactor=1.0, roughnessFactor=0.3,
                                            emissiveFactor=[0.3, 0.2, 0.02])
        add("crown", crown, [0, H * 0.99, 0])

    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, f"{mid}.glb")
    scene.export(dest)
    names = [g for g in scene.graph.nodes_geometry]
    return dest, names


def main():
    ap = argparse.ArgumentParser(description="First-pass auto-rig Meshy meshes to the game contract.")
    ap.add_argument("--only", help="comma list of ids (default: all creatures with a mesh)")
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--texsize", type=int,
                    help="downscale texture maps to NxN (e.g. 1024) for web-ready file sizes")
    args = ap.parse_args()

    global TEXSIZE
    TEXSIZE = args.texsize

    ids = ([s.strip() for s in args.only.split(",")] if args.only
           else sorted(m[:-4] for m in os.listdir(args.src) if m.endswith(".glb")))

    ok, fail = [], []
    for mid in ids:
        src = os.path.join(args.src, f"{mid}.glb")
        if not os.path.exists(src):
            print(f"  ? {mid}: no source mesh, skip"); continue
        try:
            dest, names = rig_one(mid, src, args.out)
            print(f"  ✓ {mid:14s} [{plan_of(mid):9s}] parts: {', '.join(names)}")
            ok.append(mid)
        except Exception as ex:
            print(f"  x {mid:14s} FAILED: {ex}")
            fail.append(mid)
    print(f"\nrigged {len(ok)} -> {os.path.relpath(args.out, ROOT)}/   failed: {fail or '—'}")


if __name__ == "__main__":
    main()

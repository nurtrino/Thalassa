"""
meshy_optimize.py — shrink the 8K PBR texture maps on generated GLBs to a
web-loadable size, in place, preserving the scene graph / node names.

    python tools/meshy_optimize.py ../static/assets/structures --texsize 1024

Use it on assets that aren't run through meshy_rig.py (the map structures).
Creatures get the same treatment via `meshy_rig.py --texsize`.
"""
import argparse
import os
import sys

import trimesh
from PIL import Image

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

TEX_ATTRS = ("baseColorTexture", "metallicRoughnessTexture",
             "normalTexture", "emissiveTexture", "occlusionTexture")


def optimize(path, n):
    scene = trimesh.load(path, force="scene")
    changed = False
    for g in scene.geometry.values():
        mat = getattr(g.visual, "material", None)
        if not mat:
            continue
        for a in TEX_ATTRS:
            t = getattr(mat, a, None)
            if t is not None and max(t.size) > n:
                setattr(mat, a, t.resize((n, n), Image.LANCZOS))
                changed = True
    if changed:                       # only rewrite files that actually shrank
        scene.export(path)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", help="folder of .glb files to optimize in place")
    ap.add_argument("--texsize", type=int, default=1024)
    args = ap.parse_args()
    files = sorted(f for f in os.listdir(args.dir) if f.endswith(".glb"))
    for f in files:
        p = os.path.join(args.dir, f)
        before = os.path.getsize(p)
        after = optimize(p, args.texsize)
        print(f"  {f:22s} {before/1048576:6.1f}MB -> {after/1048576:5.2f}MB")
    print(f"\noptimized {len(files)} files to {args.texsize}px")


if __name__ == "__main__":
    main()

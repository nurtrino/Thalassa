"""
meshy_ground_bake.py — pull the painted base-colour map out of each Meshy ground
tile and save it as a tileable terrain texture for the island material.

    python tools/meshy_ground_bake.py

Reads static/assets/ground/*.glb, extracts the largest (base-colour) texture,
centre-crops to a square, downscales, and writes static/assets/textures/<id>.jpg.
The island material tiles these with MirroredRepeat wrapping so seams disappear
without hand seam-fixing.
"""
import os
import sys

import trimesh
from PIL import Image

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "static", "assets", "ground")
OUT = os.path.join(ROOT, "static", "assets", "textures")
SIZE = 512


def base_image(path):
    m = trimesh.load(path, force="mesh")
    mat = getattr(m.visual, "material", None)
    if not mat:
        return None
    # prefer explicit base colour; fall back to any attached image
    for a in ("baseColorTexture", "emissiveTexture", "image"):
        t = getattr(mat, a, None)
        if t is not None:
            return t.convert("RGB")
    return None


def make_tile(img, size=SIZE):
    # centre square crop, then downscale
    w, h = img.size
    s = min(w, h)
    img = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    return img.resize((size, size), Image.LANCZOS)


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"no ground dir yet: {SRC}")
    os.makedirs(OUT, exist_ok=True)
    files = sorted(f for f in os.listdir(SRC) if f.endswith(".glb"))
    for f in files:
        img = base_image(os.path.join(SRC, f))
        if img is None:
            print(f"  ? {f}: no texture found"); continue
        tile = make_tile(img)
        dest = os.path.join(OUT, f.replace(".glb", ".jpg"))
        tile.save(dest, "JPEG", quality=88)
        print(f"  ✓ {f} -> {os.path.relpath(dest, ROOT)}  ({tile.size[0]}px)")
    print(f"\nbaked {len(files)} ground textures to {os.path.relpath(OUT, ROOT)}/")


if __name__ == "__main__":
    main()

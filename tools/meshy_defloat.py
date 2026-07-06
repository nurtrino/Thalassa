"""
meshy_defloat.py — remove FLOATING geometry islands (a stray tentacle, a
detached loop) that Meshy sometimes leaves hovering beside a model. Groups
vertices by spatial proximity and keeps only the main connected mass, dropping
anything separated from it by a real gap. Texture/UVs preserved.

    python meshy_defloat.py ../static/assets/monsters/_meshy/kraken.glb
"""
import argparse
import os
import sys

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def defloat(mesh, link=0.02):
    """Keep only the largest spatial-proximity cluster. link = fraction of the
    bounding diagonal used to connect nearby verts. Returns (mesh, removed_pct)."""
    V = mesh.vertices
    n = len(V)
    diag = float(np.linalg.norm(V.max(0) - V.min(0)))
    if diag <= 0 or n < 10:
        return mesh, 0.0
    pairs = cKDTree(V).query_pairs(link * diag, output_type="ndarray")
    if len(pairs) == 0:
        return mesh, 0.0
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    _, labels = connected_components(g, directed=False)
    main = np.bincount(labels).argmax()
    keep_v = labels == main
    removed = 100.0 * (1.0 - keep_v.sum() / n)
    if removed < 0.2:
        return mesh, 0.0                       # nothing meaningfully detached
    fmask = keep_v[mesh.faces].all(axis=1)
    out = mesh.copy()
    out.update_faces(fmask)
    out.remove_unreferenced_vertices()
    return out, removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--link", type=float, default=0.02)
    args = ap.parse_args()
    for p in args.paths:
        if not os.path.exists(p):
            print(f"  ? {p}: missing"); continue
        m = trimesh.load(p, force="mesh")
        out, removed = defloat(m, args.link)
        if removed > 0:
            out.export(p)
            print(f"  ✂ {os.path.basename(p)}: removed {removed:.1f}% floating geometry "
                  f"({len(m.vertices)}→{len(out.vertices)} verts)")
        else:
            print(f"  · {os.path.basename(p)}: no floating islands")


if __name__ == "__main__":
    main()

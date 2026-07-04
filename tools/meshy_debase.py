"""
meshy_debase.py — detect and cut off the flat display base/plinth Meshy loves to
add under statues, obelisks, temples, etc. Prompt negatives don't reliably stop
it, so we guarantee "no base, ever" geometrically.

    python meshy_debase.py ../static/assets/structures/obelisk.glb   # in place
    python meshy_debase.py --dir ../static/assets/props boulder cairn ...

HEURISTIC: ground the mesh, measure the XZ footprint radius in thin horizontal
slices bottom-up. A base is a contiguous run of BOTTOM slices whose footprint is
much wider than the object's body just above it (a slab/plinth/disc). Cut every
face below that transition and drop to y=0. If no clear wide bottom slab exists,
the mesh is left untouched (so we never chop legs/feet).
"""
import argparse
import os
import sys

import numpy as np
import trimesh

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def debase(mesh, widen=1.45, zone=0.34, nb=48, maxbase=0.16):
    """Return (trimmed_mesh, cut_height) or (mesh, 0.0) if no base found."""
    v = mesh.vertices
    ymin = v[:, 1].min()
    H = v[:, 1].max() - ymin
    if H <= 0:
        return mesh, 0.0
    cx = (v[:, 0].min() + v[:, 0].max()) / 2
    cz = (v[:, 2].min() + v[:, 2].max()) / 2
    r_all = np.sqrt((v[:, 0] - cx) ** 2 + (v[:, 2] - cz) ** 2)
    # body reference radius = mid-body, WELL above any base (0.4H–0.78H)
    midm = (v[:, 1] >= ymin + 0.4 * H) & (v[:, 1] <= ymin + 0.78 * H)
    if midm.sum() < 6:
        return mesh, 0.0
    body_r = np.percentile(r_all[midm], 92)
    if body_r <= 0:
        return mesh, 0.0
    # scan the bottom zone bottom-up; base = contiguous wide slices. Meshes are
    # very low-poly so many slices are empty — SKIP those, only stop at the
    # first NON-empty slice that is back down at body width.
    edges = np.linspace(ymin, ymin + zone * H, nb + 1)
    cut_y = 0.0
    for i in range(nb):
        m = (v[:, 1] >= edges[i]) & (v[:, 1] < edges[i + 1])
        if m.sum() < 3:
            continue                       # low-poly gap — keep scanning up
        ri = np.percentile(r_all[m], 92)
        if ri > widen * body_r:
            cut_y = edges[i + 1]           # this slice is base — cut above it
        else:
            break                          # reached the body
    if cut_y <= ymin + 1e-4:
        return mesh, 0.0
    # A real display base/disc/plinth is THIN. If the wide bottom region is tall
    # it's the object itself (tower tier, boat hull, barrel, boulder) — keep it.
    if (cut_y - ymin) > maxbase * H:
        return mesh, 0.0
    fv_y = v[mesh.faces][:, :, 1]
    keep = np.all(fv_y >= cut_y - 1e-4, axis=1)
    if keep.sum() < 4:
        return mesh, 0.0
    out = mesh.copy()
    out.update_faces(keep)
    out.remove_unreferenced_vertices()
    out.apply_translation([0, -out.vertices[:, 1].min(), 0])   # reground
    return out, cut_y - ymin


def process(path):
    scene = trimesh.load(path, force="scene")
    total_cut = 0.0
    for name, g in list(scene.geometry.items()):
        if not hasattr(g, "faces"):
            continue
        trimmed, cut = debase(g)
        if cut > 0:
            scene.geometry[name] = trimmed
            total_cut = max(total_cut, cut)
    if total_cut > 0:
        scene.export(path)
    return total_cut


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="glb files (or ids with --dir)")
    ap.add_argument("--dir", help="dir to resolve bare ids against")
    args = ap.parse_args()
    files = []
    for p in args.paths:
        files.append(os.path.join(args.dir, p + ".glb") if args.dir and not p.endswith(".glb") else p)
    for f in files:
        if not os.path.exists(f):
            print(f"  ? {f}: missing"); continue
        cut = process(f)
        tag = f"cut {cut:.3f} base" if cut > 0 else "no base found"
        print(f"  {'✂' if cut > 0 else '·'} {os.path.basename(f):22s} {tag}")


if __name__ == "__main__":
    main()

"""Travel audit — static geometry checks on the procedural chart.

Boards are rolled with a random seed per voyage (game.py), so a single
pretty layout proves nothing: this sweeps many seeds and reports every
geometry defect that makes sailing look or feel broken:

  · lane_through_island  — a sail line crosses a THIRD island's visual
                           footprint: the ship clips through terrain.
  · island_overlap       — two islands' visual footprints intersect.
  · island_clump         — islands closer than a readable margin.
  · long_hop             — a single d3 step covers a huge distance (slow,
                           boring sail animation; breaks "close" camera).
  · short_hop            — two stops so close the hop reads as a twitch.
  · wall_breach          — a hub node outside the mountain wall, or a
                           realm node inside it (pokes through the wall).
  · region_overlap       — two realms' footprints intersect (clumped
                           regions bleeding into each other).
  · dead_end             — a hub island with one lane (realm roads are
                           deliberately linear; the hub should loop).
  · disconnected         — any node unreachable from Home Port.

Usage:
    python tools/qa/travel_audit.py [--seeds N] [--json out.json]

Exit code 1 if any check at severity ERROR fired.
"""
import argparse
import collections
import json
import math
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

import board as board_mod  # noqa: E402

# Visual island footprints — mirrors ISLE_R in static/islands.js. buildIsland
# scales non-sea islands by up to ×1.23 (0.88 + rng*0.35); use the worst case.
ISLE_R = {"home": 13.0, "shrine": 10.0, "puzzle": 10.0, "haven": 11.0,
          "shop": 10.0, "monster": 11.0, "lair": 14.0, "pharos": 17.0,
          "gate": 2.0, "sea": 1.5}
MAX_SCALE = 1.23


def vis_r(node):
    r = ISLE_R.get(node["type"], 4.8)
    return r * (1.0 if node["type"] == "sea" else MAX_SCALE)


def dist(a, b):
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"])


def seg_point_dist(ax, az, bx, bz, px, pz):
    """Distance from point P to segment AB."""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    if L2 == 0:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


ISLAND_TYPES = {"home", "shrine", "puzzle", "haven", "shop",
                "monster", "lair", "pharos"}

# Hop-length taste thresholds. The camera hugs the ship, so a hop much past
# the hub waypoint target reads as an endless dolly through empty water.
# The sail animation runs ~700ms + 32ms/wu (scene.js startTravel): 110 wu
# ≈ 4.2s of sailing, the ceiling before travel starts to drag.
LONG_HOP = 110.0       # hub lanes aim for ~60; the board caps hops near ~90
SHORT_HOP = 7.0        # closer than this and the ship barely moves
CLUMP_MARGIN = 6.0     # open water wanted between two coasts


def audit_board(b, seed):
    """All findings for one rolled chart. Each finding is a dict."""
    F = []
    nodes = b.nodes
    ids = list(nodes)

    def add(kind, sev, msg, **extra):
        F.append({"seed": seed, "kind": kind, "sev": sev, "msg": msg, **extra})

    # ── connectivity ──────────────────────────────────────────────────────
    seen = {b.home}
    queue = [b.home]
    while queue:
        for nb in b.neighbors.get(queue.pop(), ()):
            if nb not in seen:
                seen.add(nb)
                queue.append(nb)
    for nid in ids:
        if nid not in seen:
            add("disconnected", "ERROR",
                f"{nid} ({nodes[nid]['type']}) unreachable from Home Port",
                node=nid)

    # ── hop lengths ───────────────────────────────────────────────────────
    hops = []
    for a, bb in b.edges:
        na, nb_ = nodes[a], nodes[bb]
        d = dist(na, nb_)
        # the Vale is deliberately walked stop-to-stop; skip its trail
        vale = na.get("region") == "autumn" and nb_.get("region") == "autumn"
        if not vale:
            hops.append(d)
        if d > LONG_HOP and not vale:
            add("long_hop", "ERROR",
                f"{a}→{bb} is {d:.0f} wu in one d3 step "
                f"({na.get('region') or 'hub'})",
                a=a, b=bb, length=round(d, 1))
        elif d < SHORT_HOP and not vale:
            add("short_hop", "WARN",
                f"{a}→{bb} is only {d:.1f} wu — a twitch, not a sail",
                a=a, b=bb, length=round(d, 1))

    # ── lanes that cut through other islands (ship clipping) ─────────────
    islands = [n for n in nodes.values() if n["type"] in ISLAND_TYPES]
    for a, bb in b.edges:
        na, nb_ = nodes[a], nodes[bb]
        # the Amber Vale walks a designed serpentine over FLUSH ground pads
        # (no raised islands) — its geometry is the Vale team's domain;
        # tally it as INFO for the handoff, don't gate on it.
        vale_lane = (na.get("region") == "autumn"
                     and nb_.get("region") == "autumn")
        for c in islands:
            if c["id"] in (a, bb):
                continue
            d = seg_point_dist(na["x"], na["z"], nb_["x"], nb_["z"],
                               c["x"], c["z"])
            if vale_lane:
                if d < vis_r(c):
                    add("vale_geometry", "INFO",
                        f"vale trail {a}→{bb} crosses {c['id']} "
                        f"({c['type']}) pad", a=a, b=bb, island=c["id"])
                continue
            if d < vis_r(c):
                add("lane_through_island", "ERROR",
                    f"lane {a}→{bb} cuts through {c['id']} "
                    f"({c['type']}, r≈{vis_r(c):.0f}, clearance {d:.1f})",
                    a=a, b=bb, island=c["id"], clearance=round(d, 1))
            elif d < vis_r(c) + 2.5:
                add("lane_grazes_island", "WARN",
                    f"lane {a}→{bb} grazes {c['id']} ({d:.1f} wu off its coast)",
                    a=a, b=bb, island=c["id"], clearance=round(d, 1))

    # ── island overlap / clumping ─────────────────────────────────────────
    for i, na in enumerate(islands):
        for nb_ in islands[i + 1:]:
            d = dist(na, nb_)
            need = vis_r(na) + vis_r(nb_)
            if d < need:
                add("island_overlap", "ERROR",
                    f"{na['id']} ({na['type']}) and {nb_['id']} "
                    f"({nb_['type']}) overlap: {d:.0f} < {need:.0f}",
                    a=na["id"], b=nb_["id"], gap=round(d - need, 1))
            elif d < need + CLUMP_MARGIN:
                add("island_clump", "WARN",
                    f"{na['id']} and {nb_['id']} nearly touch "
                    f"(coast gap {d - need:.1f})",
                    a=na["id"], b=nb_["id"], gap=round(d - need, 1))

    # ── the mountain wall ────────────────────────────────────────────────
    for n in nodes.values():
        r = math.hypot(n["x"], n["z"])
        if n["type"] == "gate":
            continue
        if not n.get("region") and r > board_mod.WALL_R - 12:
            add("wall_breach", "ERROR",
                f"hub node {n['id']} ({n['type']}) sits at r={r:.0f}, "
                f"inside the wall band (wall at {board_mod.WALL_R})",
                node=n["id"], r=round(r, 1))
        if n.get("region") and r < board_mod.WALL_R - 2:
            add("wall_breach", "ERROR",
                f"realm node {n['id']} ({n.get('region')}) at r={r:.0f} "
                f"is INSIDE the mountain wall",
                node=n["id"], r=round(r, 1))

    # ── region separation ────────────────────────────────────────────────
    regions = collections.defaultdict(list)
    for n in nodes.values():
        if n.get("region") and n["type"] != "gate":
            regions[n["region"]].append(n)
    keys = sorted(regions)
    cent = {}
    for k in keys:
        xs = [n["x"] for n in regions[k]]
        zs = [n["z"] for n in regions[k]]
        cx, cz = sum(xs) / len(xs), sum(zs) / len(zs)
        rad = max(math.hypot(n["x"] - cx, n["z"] - cz) for n in regions[k])
        cent[k] = (cx, cz, rad)
    for i, ka in enumerate(keys):
        for kb in keys[i + 1:]:
            ax, az, ar = cent[ka]
            bx, bz, br = cent[kb]
            gap = math.hypot(ax - bx, az - bz) - ar - br
            if gap < 0:
                # bounding circles are coarse (the Vale sprawls); judge by
                # the ACTUAL closest stops. Realms read as separate places
                # while their nearest stops stay well past fog distance.
                mind = min(dist(na, nb_) for na in regions[ka]
                           for nb_ in regions[kb])
                if mind < 40:
                    add("region_overlap", "ERROR",
                        f"realms {ka} and {kb} interleave "
                        f"(closest stops {mind:.0f} wu apart)",
                        a=ka, b=kb, min_dist=round(mind, 1))
                elif mind < 120:
                    add("region_overlap", "WARN",
                        f"realms {ka} and {kb} run close "
                        f"(closest stops {mind:.0f} wu apart)",
                        a=ka, b=kb, min_dist=round(mind, 1))

    # ── hub dead ends ────────────────────────────────────────────────────
    for n in nodes.values():
        if (not n.get("region") and n["type"] in ISLAND_TYPES
                and n["type"] not in ("pharos",)
                and len(b.neighbors.get(n["id"], [])) <= 1):
            add("dead_end", "WARN",
                f"hub island {n['id']} ({n['type']}) has "
                f"{len(b.neighbors.get(n['id'], []))} lane(s)",
                node=n["id"])

    return F, hops


def run(seeds=20, base=1000):
    all_f, all_hops = [], []
    for s in range(base, base + seeds):
        b = board_mod.Board(seed=s)
        f, hops = audit_board(b, s)
        all_f.extend(f)
        all_hops.extend(hops)
    return all_f, all_hops


def summarize(findings, hops, seeds):
    by_kind = collections.Counter((f["kind"], f["sev"]) for f in findings)
    lines = [f"boards audited: {seeds}",
             f"hops: n={len(hops)} median={statistics.median(hops):.0f} "
             f"p95={sorted(hops)[int(len(hops) * .95)]:.0f} "
             f"max={max(hops):.0f} min={min(hops):.1f}"]
    for (kind, sev), n in sorted(by_kind.items(),
                                 key=lambda kv: (kv[0][1] != "ERROR", kv[0])):
        lines.append(f"{sev:5} {kind:22} ×{n}  (~{n / seeds:.1f}/board)")
    if not by_kind:
        lines.append("clean: no findings")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--base", type=int, default=1000)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    findings, hops = run(args.seeds, args.base)
    print(summarize(findings, hops, args.seeds))
    errs = [f for f in findings if f["sev"] == "ERROR"]
    for f in errs[:25]:
        print(f"  seed {f['seed']}: {f['msg']}")
    if len(errs) > 25:
        print(f"  … and {len(errs) - 25} more errors")
    if args.json:
        with open(args.json, "w") as fh:
            json.dump({"findings": findings,
                       "hops": {"n": len(hops),
                                "median": statistics.median(hops),
                                "max": max(hops)}}, fh, indent=1)
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()

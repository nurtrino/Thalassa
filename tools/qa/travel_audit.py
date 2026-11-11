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
  · waypoint_on_shelf    — a sea waypoint (buoy, islet, rocks) sits on an
                           island's beach or its underwater shelf.
  · lane_blocked_by_islet — a lane runs through an islet / rock stack that
                           stands on ANOTHER lane's waypoint.
  · route_choice         — exact-roll landing choices (rolls 1–5) from the
                           hub's islands fell below the lattice's design.

Footprints come from board.py (ISLE_FOOT / footprint() / shelf()), the
same table the client's terrain is fitted to (static/islands.js ISLE_R).

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

# Visual island footprints: the client fits every island's coast INSIDE its
# radius (static/gfx/terrain.js fit) and buildIsland never exceeds ISLE_R
# (static/islands.js) — board.py keeps the matching table.
ISLE_R = dict(board_mod.ISLE_FOOT)


def vis_r(node):
    """Coast radius of the island (or islet / buoy) at a node."""
    return board_mod.footprint(node)


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
LONG_HOP = board_mod.HOP_BAND[1]     # hub lanes aim for ~60; never past this
SHORT_HOP = board_mod.HOP_BAND[0]    # closer than this and the ship barely moves
CLUMP_MARGIN = 8.0     # open water wanted between two coasts
LANE_MARGIN = board_mod.LANE_MARGIN  # water a lane keeps off a third coast


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
            add("short_hop", "ERROR",
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
            elif d < vis_r(c) + LANE_MARGIN:
                # inside the margin the hull (4–5 wu either side of the lane)
                # runs over the beach and its shelf
                add("lane_grazes_island", "ERROR",
                    f"lane {a}→{bb} grazes {c['id']} ({d - vis_r(c):.1f} wu "
                    f"off its coast, want {LANE_MARGIN:.0f})",
                    a=a, b=bb, island=c["id"], clearance=round(d, 1))

    # ── sea waypoints: never on a beach or shelf; islets never block lanes ─
    seas = [n for n in nodes.values() if n["type"] == "sea"
            and n.get("region") != "autumn"]
    for w in seas:
        for c in islands:
            d = dist(w, c)
            need = board_mod.shelf(c) + vis_r(w)
            if d < need:
                add("waypoint_on_shelf", "ERROR",
                    f"waypoint {w['id']} ({w.get('look', '-')}) sits "
                    f"{d:.1f} wu from {c['id']} ({c['type']}) — on its "
                    f"shelf (want ≥ {need:.0f})",
                    node=w["id"], island=c["id"], d=round(d, 1))
    solid_seas = [w for w in seas if w.get("look") in ("islet", "rocks")
                  and not w.get("region")]
    for a, bb in b.edges:
        na, nb_ = nodes[a], nodes[bb]
        if na.get("region") == "autumn" or nb_.get("region") == "autumn":
            continue
        for w in solid_seas:
            if w["id"] in (a, bb):
                continue
            d = seg_point_dist(na["x"], na["z"], nb_["x"], nb_["z"],
                               w["x"], w["z"])
            if d < vis_r(w) + LANE_MARGIN:
                add("lane_blocked_by_islet", "ERROR",
                    f"lane {a}→{bb} runs {d:.1f} wu from {w['look']} "
                    f"{w['id']}", a=a, b=bb, node=w["id"], d=round(d, 1))

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

    # ── route choice: exact-roll landing options from the hub isles ──────
    rc = route_choice(b)
    if rc < ROUTE_CHOICE_MIN:
        add("route_choice", "ERROR",
            f"mean landing choices per (isle, roll 1–5) is {rc:.2f} "
            f"(< {ROUTE_CHOICE_MIN})", value=round(rc, 2))

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


ROUTE_CHOICE_MIN = 3.0


def reachable(b, start, steps):
    """The engine's exact-roll movement on a bare board (game.py
    _reachable_for): no doubling straight back unless boxed in, the Pharos
    is a wall you may only land on, passes / havens / lairs halt or take any
    roll. Returns the set of legal landing stops."""
    nodes, nb = b.nodes, b.neighbors
    cur = {(start, None)}
    stops = set()
    for step in range(steps):
        last = step == steps - 1
        nxt = set()
        for node, came in cur:
            nbrs = nb[node]
            fwd = [x for x in nbrs if x != came] or list(nbrs)
            if not last and all(nodes[x]["type"] == "pharos" for x in fwd):
                fwd = list(nbrs)
            for x in fwd:
                t = nodes[x]["type"]
                if t == "pharos":
                    stops.add(x)
                    continue
                if t == "gate":
                    stops.add(x)
                    continue
                if t in ("lair", "haven"):
                    stops.add(x)
                nxt.add((x, node))
        cur = nxt
        if not cur:
            break
    stops.update(n for n, _ in cur)
    return stops


def route_choice(b):
    """Mean number of distinct landing stops over every hub island × roll
    1–5 — the lattice's loops are what make exact rolls steerable."""
    tot = cnt = 0
    for n in b.nodes.values():
        if n.get("region") or n["type"] not in ISLAND_TYPES - {"pharos"}:
            continue
        for roll in range(1, 6):
            tot += len(reachable(b, n["id"], roll))
            cnt += 1
    return tot / max(1, cnt)


CHOICE = []          # route_choice per audited board (for the summary)


def run(seeds=20, base=1000):
    all_f, all_hops = [], []
    CHOICE.clear()
    for s in range(base, base + seeds):
        b = board_mod.Board(seed=s)
        f, hops = audit_board(b, s)
        CHOICE.append(route_choice(b))
        all_f.extend(f)
        all_hops.extend(hops)
    return all_f, all_hops


def summarize(findings, hops, seeds):
    by_kind = collections.Counter((f["kind"], f["sev"]) for f in findings)
    lines = [f"boards audited: {seeds}",
             f"hops: n={len(hops)} median={statistics.median(hops):.0f} "
             f"p95={sorted(hops)[int(len(hops) * .95)]:.0f} "
             f"max={max(hops):.0f} min={min(hops):.1f}"]
    if CHOICE:
        lines.append(f"route choice (landing stops per hub isle × roll 1–5): "
                     f"mean {statistics.mean(CHOICE):.2f}, "
                     f"worst board {min(CHOICE):.2f}")
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
    ap.add_argument("--board", default=None,
                    help="audit another board.py (e.g. a baseline copy)")
    args = ap.parse_args()
    if args.board:
        import importlib.util
        global board_mod
        spec = importlib.util.spec_from_file_location("board_alt", args.board)
        alt = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(alt)
        for k in ("ISLE_FOOT", "footprint", "shelf", "LANE_MARGIN", "HOP_BAND"):
            if not hasattr(alt, k):
                setattr(alt, k, getattr(board_mod, k))
        board_mod = alt

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

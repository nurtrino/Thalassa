"""Chart geometry across many rolled boards — lanes, waypoints, hops, loops.

The client raises every island from a terrain FITTED inside its footprint
(static/isleshape.js ISLE_FOOT); board.py plans lanes round the same table.
These tests sweep 200 seeds and hold the generator to what the ship and its
buoys actually look like on screen:

  · no lane within LANE_MARGIN of a third island's coast (the hull would run
    over its beach / shelf), no waypoint on an island's shelf, no islet or
    rock stack standing in another lane;
  · every d3 step (outside the Amber Vale's designed trail) inside HOP_BAND;
  · the lattice keeps its loops — exact-roll landing choices for rolls 1–5
    stay at the level the hub was designed for;
  · each realm's fork keeps its designed shape (main road, elite shortcut,
    haven detour, junction → altar).
"""
import math
import os
import re
import statistics

import pytest

import board as B
from tools.qa import travel_audit as TA

SEEDS = range(200)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def boards():
    return [(s, B.Board(seed=s)) for s in SEEDS]


def _errors(b, seed):
    findings, _ = TA.audit_board(b, seed)
    return [f for f in findings if f["sev"] == "ERROR"]


def test_audit_is_clean_on_200_charts(boards):
    errs = []
    for s, b in boards:
        errs += _errors(b, s)
    kinds = sorted({e["kind"] for e in errs})
    assert not errs, f"{len(errs)} errors ({kinds}); first: {errs[0]['msg']}"


def test_no_lane_grazes_a_third_coast(boards):
    for s, b in boards:
        isles = [n for n in b.nodes.values() if n["type"] not in ("sea", "gate")
                 and n.get("region") != "autumn"]
        for a, c in b.edges:
            na, nc = b.nodes[a], b.nodes[c]
            if "autumn" in (na.get("region"), nc.get("region")):
                continue
            for i in isles:
                if i["id"] in (a, c):
                    continue
                d = TA.seg_point_dist(na["x"], na["z"], nc["x"], nc["z"], i["x"], i["z"])
                assert d >= B.footprint(i) + B.LANE_MARGIN - 1e-6, (s, a, c, i["id"], d)


def test_no_waypoint_sits_on_a_shelf(boards):
    for s, b in boards:
        isles = [n for n in b.nodes.values() if n["type"] not in ("sea", "gate")
                 and n.get("region") != "autumn"]
        for w in b.nodes.values():
            if w["type"] != "sea" or w.get("region") == "autumn":
                continue
            for i in isles:
                d = math.hypot(w["x"] - i["x"], w["z"] - i["z"])
                assert d >= B.shelf(i) + B.footprint(w) - 1e-6, (s, w["id"], i["id"], d)


def test_hops_stay_in_the_band(boards):
    lo, hi = B.HOP_BAND
    hops = []
    for s, b in boards:
        for a, c in b.edges:
            na, nc = b.nodes[a], b.nodes[c]
            if na.get("region") == "autumn" and nc.get("region") == "autumn":
                continue
            d = math.hypot(na["x"] - nc["x"], na["z"] - nc["z"])
            hops.append(d)
            assert lo <= d <= hi, (s, a, c, round(d, 1))
    # and the bulk of them sit where the sail animation is tuned (~55 wu)
    assert 40 <= statistics.median(hops) <= 70


def test_route_choice_is_kept(boards):
    # baseline (before the geometry pass, 200 seeds): mean 12.2, worst 9.6
    rc = [TA.route_choice(b) for _, b in boards]
    assert statistics.mean(rc) >= 11.8
    assert min(rc) >= 9.0


def test_hub_stays_a_lattice_of_loops(boards):
    for s, b in boards:
        hub_isles = [n for n in b.nodes.values() if not n.get("region")
                     and n["type"] not in ("sea", "pharos")]
        dead = [n["id"] for n in hub_isles if len(b.neighbors[n["id"]]) < 2]
        assert len(dead) <= 1, (s, dead)


def test_every_node_reachable_from_home(boards):
    for s, b in boards:
        seen, todo = {"home"}, ["home"]
        while todo:
            for nb in b.neighbors[todo.pop()]:
                if nb not in seen:
                    seen.add(nb)
                    todo.append(nb)
        assert seen == set(b.nodes), (s, set(b.nodes) - seen)


def _realm_path(b, src, dst, avoid=()):
    prev, todo = {src: None}, [src]
    while todo:
        cur = todo.pop(0)
        if cur == dst:
            break
        for nb in b.neighbors[cur]:
            if nb in prev or nb in avoid:
                continue
            if b.nodes[nb].get("region") != b.nodes[dst].get("region"):
                continue
            prev[nb] = cur
            todo.append(nb)
    return dst in prev


def test_realm_forks_keep_their_shape(boards):
    for s, b in boards:
        for gi, gate in enumerate(b.gates):
            region = b.nodes[gate]["region"]
            if region == "autumn":
                continue                         # grown later, per voyage
            lair, junc = f"r{gi}_L", f"r{gi}_j"
            # the altar hangs off the junction alone (through at most a
            # waypoint chain) — every road meets there
            assert _realm_path(b, gate, lair)
            assert not _realm_path(b, gate, lair, avoid={junc}), (s, region)
            # the elite shortcut and the haven detour both still exist
            assert f"r{gi}_s0" in b.nodes and f"r{gi}_s1" in b.nodes
            assert b.nodes[f"r{gi}_v0"]["type"] == "haven"
            # the designed stops stay near the plan: in the realm's wedge
            ga = b.nodes[gate]["gate_angle"]
            for nid, n in b.nodes.items():
                if n.get("region") != region:
                    continue
                a = math.atan2(n["z"], n["x"])
                assert abs(math.atan2(math.sin(a - ga), math.cos(a - ga))) < 0.75, (s, nid)
                assert math.hypot(n["x"], n["z"]) >= B.WALL_R - 2, (s, nid)


def test_vale_maze_is_untouched_by_the_declip():
    # the Vale is grown after the lane pass — its designed trail is kept
    b = B.Board(seed=3)
    lairs = b.grow_vale(["p1", "p2"])
    assert set(lairs) == {"p1", "p2"}
    vale = [n for n in b.nodes.values() if n.get("region") == "autumn"]
    assert any(n["type"] == "lair" for n in vale)
    assert all(not n["id"].startswith(("seab", "seas")) for n in vale)


def test_client_footprint_table_matches():
    """static/isleshape.js ISLE_FOOT / SEA_FOOT must equal board.py's."""
    src = open(os.path.join(ROOT, "static", "isleshape.js")).read()

    def table(name):
        body = re.search(name + r"\s*=\s*\{(.*?)\};", src, re.S).group(1)
        return {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", body)}
    isle = table("ISLE_FOOT")
    for k, v in B.ISLE_FOOT.items():
        assert isle.get(k) == v, (k, isle.get(k), v)
    sea = table("SEA_FOOT")
    for k, v in B.SEA_FOOT.items():
        assert sea.get(k) == v, (k, sea.get(k), v)
    assert re.search(r"SHELF_K\b", open(os.path.join(ROOT, "board.py")).read())

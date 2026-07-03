"""
Thalassa board — a small Aegean archipelago as a node/edge graph.

Two rings of six islands around sacred Delos:
  · outer ring — five Great Libraries and the starting Port
  · inner ring — the Agora, the Oracle, and four open islands (build plots)
Delos sits at the center, reachable only by players holding enough Laurels.

Positions (x, z) are baked in so the 3D client and the engine agree on the
world. +x is east, +z is south; the port sits at the southern edge.
"""
from __future__ import annotations

import math

# Domains — the four fields of knowledge and their patron gods.
DOMAINS = ["clio", "athena", "apollo", "dionysos"]
DOMAIN_INFO = {
    "clio":     {"name": "Clio",     "field": "History & Places"},
    "athena":   {"name": "Athena",   "field": "Science & Nature"},
    "apollo":   {"name": "Apollo",   "field": "Arts & Letters"},
    "dionysos": {"name": "Dionysos", "field": "Culture & Sport"},
}

_INNER_R = 13.0
_OUTER_R = 24.0


def _pos(angle_deg: float, radius: float) -> tuple[float, float]:
    a = math.radians(angle_deg)
    # angle 270 = due south (+z); angle 90 = due north (-z)
    return (round(radius * math.cos(a), 2), round(-radius * math.sin(a), 2))


def _node(nid, name, ntype, angle, radius):
    x, z = _pos(angle, radius)
    return {"id": nid, "name": name, "type": ntype, "x": x, "z": z}


# fmt: off
NODES = {n["id"]: n for n in [
    _node("delos",    "Delos",     "delos",   0,   0.0),
    # inner ring (spokes at 30/90/150/210/270/330 degrees)
    _node("agora",    "Agora of Mykonos", "agora",  90,  _INNER_R),
    _node("kalypso",  "Kalypso",   "open",   150, _INNER_R),
    _node("thera",    "Thera",     "open",   210, _INNER_R),
    _node("oracle",   "The Oracle","oracle", 270, _INNER_R),
    _node("naxos",    "Naxos",     "open",   330, _INNER_R),
    _node("melos",    "Melos",     "open",    30, _INNER_R),
    # outer ring
    _node("pergamon", "Library of Pergamon", "library",  90, _OUTER_R),
    _node("rhodos",   "Library of Rhodos",   "library", 150, _OUTER_R),
    _node("kos",      "Library of Kos",      "library", 210, _OUTER_R),
    _node("piraeus",  "Port of Piraeus",     "port",    270, _OUTER_R),
    _node("samos",    "Library of Samos",    "library", 330, _OUTER_R),
    _node("kythera",  "Library of Kythera",  "library",  30, _OUTER_R),
]}
# fmt: on

_INNER = ["agora", "kalypso", "thera", "oracle", "naxos", "melos"]
_OUTER = ["pergamon", "rhodos", "kos", "piraeus", "samos", "kythera"]

EDGES: list[tuple[str, str]] = []
for ring in (_INNER, _OUTER):
    for i, nid in enumerate(ring):
        EDGES.append((nid, ring[(i + 1) % len(ring)]))
EDGES += list(zip(_INNER, _OUTER))                    # spokes
EDGES += [("delos", "agora"), ("delos", "thera"), ("delos", "naxos")]

NEIGHBORS: dict[str, list[str]] = {nid: [] for nid in NODES}
for a, b in EDGES:
    NEIGHBORS[a].append(b)
    NEIGHBORS[b].append(a)

LIBRARIES = [nid for nid, n in NODES.items() if n["type"] == "library"]
OPEN_ISLES = [nid for nid, n in NODES.items() if n["type"] == "open"]
START = "piraeus"


def reachable(origins: set[str], max_steps: int, delos_ok: bool) -> dict[str, int]:
    """BFS distance to every node within max_steps of any origin.

    Delos is never entered or crossed unless delos_ok. Origins themselves are
    excluded from the result (you must sail to a *different* island).
    """
    dist: dict[str, int] = {o: 0 for o in origins}
    frontier = list(origins)
    while frontier:
        nxt = []
        for nid in frontier:
            d = dist[nid]
            if d == max_steps:
                continue
            for nb in NEIGHBORS[nid]:
                if nb == "delos" and not delos_ok:
                    continue
                if nb not in dist:
                    dist[nb] = d + 1
                    nxt.append(nb)
        frontier = nxt
    return {nid: d for nid, d in dist.items() if nid not in origins}


def to_dict() -> dict:
    """Static board data shipped to the client once per snapshot."""
    return {
        "nodes": list(NODES.values()),
        "edges": [list(e) for e in EDGES],
        "domains": DOMAIN_INFO,
        "start": START,
    }

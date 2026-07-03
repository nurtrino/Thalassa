"""
Thalassa board — a procedurally generated frontier archipelago.

Every game rolls a new sea chart: the Home Port anchors the south, and
bands of islands fan north toward the hidden isle of the Golden Fleece.
Farther bands hold harder questions, meaner monsters, and richer loot.

    band 0   home port
    band 1-2 shrines, puzzles, havens, first monsters
    band 3-5 relic lairs and their guardians
    band 6   the Golden Fleece (revealed when someone banks 3 relics)

Node types: home · shrine · puzzle · haven · monster · lair · fleece
The engine owns per-game state (monster hp, shrine charges, relics), so a
Board instance belongs to one Game and mutates freely.
"""
from __future__ import annotations

import random

# Domains — the four fields of knowledge; monsters and shrines carry one.
DOMAINS = ["clio", "athena", "apollo", "dionysos"]
DOMAIN_INFO = {
    "clio":     {"name": "Clio",     "field": "History & Places"},
    "athena":   {"name": "Athena",   "field": "Science & Nature"},
    "apollo":   {"name": "Apollo",   "field": "Arts & Letters"},
    "dionysos": {"name": "Dionysos", "field": "Culture & Sport"},
}

ISLAND_NAMES = [
    "Skyros", "Ikaria", "Paros", "Lesbos", "Melos", "Naxos", "Kalypso",
    "Thera", "Andros", "Tinos", "Serifos", "Sifnos", "Kea", "Kythnos",
    "Amorgos", "Folegandros", "Syros", "Chios", "Samos", "Kos", "Leros",
    "Patmos", "Astypalaia", "Karpathos", "Kasos", "Symi", "Tilos",
]

# (name, hp, power, tier) by rank — tier is the question difficulty asked.
MINIONS = [("Harpies", 2, 1, 2), ("Satyr Brigands", 2, 1, 2), ("Stymphalian Birds", 2, 1, 2)]
GUARDS = [("The Cyclops", 3, 2, 3), ("The Sirens", 3, 2, 3), ("The Hydra", 3, 2, 3),
          ("The Minotaur", 3, 2, 3), ("The Sphinx", 3, 2, 3), ("The Gorgon", 3, 2, 3)]
ELITES = [("Skylla", 4, 2, 3), ("The Chimera", 4, 2, 3), ("The Ketos", 4, 2, 3)]
DRAGON = ("The Colchian Dragon", 5, 3, 3)

RELICS_TOTAL = 6           # lairs on the map, one relic each
RELICS_TO_WIN = 3
SHRINE_CHARGES = 2

# band z rows (south → north) and how many islands in each
_BAND_Z = [40, 26, 12, -2, -16, -30, -44]
_BAND_N = [1, 4, 5, 5, 4, 3, 1]
_BAND_TYPES = {
    1: ["shrine", "shrine", "shrine", "puzzle"],
    2: ["shrine", "shrine", "monster", "haven", "puzzle"],
    3: ["lair", "lair", "monster", "shrine", "puzzle"],
    4: ["lair", "lair", "monster", "haven"],
    5: ["lair", "lair", "monster"],
}


class Board:
    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed)
        self.nodes: dict[str, dict] = {}
        self.edges: list[tuple[str, str]] = []
        self.neighbors: dict[str, list[str]] = {}
        self.home = "home"
        self.fleece = "fleece"
        self._generate()

    # ── generation ───────────────────────────────────────────────────────────
    def _generate(self):
        rng = self.rng
        names = ISLAND_NAMES[:]
        rng.shuffle(names)
        minions, guards, elites = MINIONS[:], GUARDS[:], ELITES[:]
        rng.shuffle(minions); rng.shuffle(guards); rng.shuffle(elites)

        bands: list[list[str]] = []
        for bi, (z, n) in enumerate(zip(_BAND_Z, _BAND_N)):
            row = []
            width = 30 if 1 <= bi <= 4 else 18
            for i in range(n):
                if bi == 0:
                    nid, ntype, name = "home", "home", "Home Port"
                elif bi == len(_BAND_Z) - 1:
                    nid, ntype, name = "fleece", "fleece", "Isle of the Fleece"
                else:
                    nid = f"n{bi}_{i}"
                    ntype = None                     # assigned below
                    name = names.pop()
                x = (-width + (2 * width) * (i / max(1, n - 1))) if n > 1 else 0.0
                x += rng.uniform(-4, 4)
                zz = z + rng.uniform(-3, 3)
                self.nodes[nid] = {"id": nid, "name": name, "type": ntype, "band": bi,
                                   "x": round(x, 2), "z": round(zz, 2)}
                row.append(nid)
            bands.append(row)

        # assign types per band (shuffled), then decorate with payloads
        relic_no = 1
        for bi in range(1, 6):
            types = _BAND_TYPES[bi][:]
            rng.shuffle(types)
            for nid, ntype in zip(bands[bi], types):
                node = self.nodes[nid]
                node["type"] = ntype
                if ntype == "shrine":
                    node["domain"] = rng.choice(DOMAINS)
                    node["charges"] = SHRINE_CHARGES
                    node["tier"] = 1 if bi <= 2 else 2
                elif ntype == "puzzle":
                    node["solved"] = False
                elif ntype == "monster":
                    pool = minions if bi <= 3 else guards
                    m = pool.pop() if pool else ("Sea Wolves", 2, 1, 2)
                    node["monster"] = self._monster(m, rng)
                elif ntype == "lair":
                    pool = guards if bi <= 4 else elites
                    m = pool.pop() if pool else elites.pop()
                    node["monster"] = self._monster(m, rng)
                    node["relic"] = relic_no
                    relic_no += 1
        self.nodes["fleece"]["monster"] = self._monster(DRAGON, rng)

        # edges: each node links to 1-2 nearest in the previous band
        for bi in range(1, len(bands)):
            for nid in bands[bi]:
                prev = sorted(bands[bi - 1], key=lambda p: self._dist(nid, p))
                self._link(nid, prev[0])
                if len(prev) > 1 and rng.random() < 0.55:
                    self._link(nid, prev[1])
        # lateral links inside a band for route choice
        for bi in range(1, 6):
            row = sorted(bands[bi], key=lambda p: self.nodes[p]["x"])
            for a, b in zip(row, row[1:]):
                if rng.random() < 0.6:
                    self._link(a, b)

        self._build_neighbors()
        self._ensure_connected(bands)

    def _monster(self, spec, rng) -> dict:
        name, hp, power, tier = spec
        return {"name": name, "hp": hp, "max_hp": hp, "power": power,
                "tier": tier, "domain": rng.choice(DOMAINS)}

    def _dist(self, a: str, b: str) -> float:
        na, nb = self.nodes[a], self.nodes[b]
        return ((na["x"] - nb["x"]) ** 2 + (na["z"] - nb["z"]) ** 2) ** 0.5

    def _link(self, a: str, b: str):
        if (a, b) not in self.edges and (b, a) not in self.edges:
            self.edges.append((a, b))

    def _build_neighbors(self):
        self.neighbors = {nid: [] for nid in self.nodes}
        for a, b in self.edges:
            self.neighbors[a].append(b)
            self.neighbors[b].append(a)

    def _ensure_connected(self, bands):
        seen = {"home"}
        frontier = ["home"]
        while frontier:
            cur = frontier.pop()
            for nb in self.neighbors[cur]:
                if nb not in seen:
                    seen.add(nb)
                    frontier.append(nb)
        for nid in self.nodes:
            if nid not in seen:
                band = self.nodes[nid]["band"]
                candidates = [p for p in seen
                              if abs(self.nodes[p]["band"] - band) <= 1 and p != nid]
                nearest = min(candidates, key=lambda p: self._dist(nid, p))
                self._link(nid, nearest)
                seen.add(nid)
        self._build_neighbors()

    # ── queries ──────────────────────────────────────────────────────────────
    def lairs(self) -> list[str]:
        return [nid for nid, n in self.nodes.items() if n["type"] == "lair"]

    def alive_monster(self, nid: str) -> dict | None:
        m = self.nodes[nid].get("monster")
        return m if m and m["hp"] > 0 else None

"""
Thalassa board — a vast ringed sea with the Pharos burning at its heart.

Every game rolls a new chart. The Pharos — a shining white colossus — stands
at the exact center of the world; Home Port sits in its shadow. Around them,
three rings of islands spread outward to the storm wall that seals the region:

    ring 1  the inner isles: temples, puzzle spires, two market isles
    ring 2  the middle waters: first trials, hunting grounds, more temples
    ring 3  the outer shoals: the great trials, the wild edge of the storm

Ring roads and spokes make the chart a lattice of LOOPS — exact-roll
movement needs circuits, and every route back to the center passes real
open water.

Node types: home · pharos · shrine · puzzle · haven · shop · monster · lair · sea
Lairs hold SOLO boss guardians and the relic seals; "monster" spots are
hunting grounds where a fresh random pack ambushes whoever lands (never a
wall). The engine owns per-game state (monster hp, shrine charges, relics),
so a Board instance belongs to one Game and mutates freely.
"""
from __future__ import annotations

import math
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
    "Rhodos", "Kythera", "Ithaka", "Zakynthos", "Kefalonia", "Lefkada",
    "Salamis", "Aegina", "Hydra", "Spetses", "Poros", "Skiathos",
]

# Bosses are SOLO — one great guardian per trial lair, where the relics are.
# (name, hp, power, tier) — tier is the question difficulty asked.
BOSSES = [("The Cyclops", 5, 2, 3), ("The Siren Queen", 5, 2, 3),
          ("The Hydra", 5, 2, 3), ("The Minotaur", 5, 2, 3),
          ("The Sphinx", 5, 2, 3), ("The Gorgon", 5, 2, 3),
          ("The Empusa", 5, 2, 3), ("The Laestrygonian King", 5, 2, 3)]
ELITES = [("Skylla", 6, 2, 3), ("The Chimera", 6, 2, 3), ("The Ketos", 6, 2, 3),
          ("Charybdis", 6, 3, 3), ("Typhon's Spawn", 6, 3, 3)]
WARDEN = ("The Warden of the Pharos", 8, 3, 3)

# Random encounter table for hunting grounds ("monster" spots): a fresh pack
# ambushes whoever LANDS there — they never wall off passage.
# (pack name, unit name, unit hp, unit power)
ENCOUNTERS_LIGHT = [
    ("Harpies", "Harpy", 1, 1),
    ("Sea Wolves", "Sea Wolf", 1, 1),
    ("Satyr Brigands", "Satyr Brigand", 1, 1),
    ("Stymphalian Birds", "Stymphalian Bird", 1, 1),
    ("Brigand Skiffs", "Brigand Skiff", 2, 1),
    ("Reef Serpents", "Reef Serpent", 2, 1),
]
ENCOUNTERS_HEAVY = [
    ("Laestrygonian Raiders", "Laestrygonian Raider", 2, 2),
    ("Cyclops Herdsmen", "Cyclops Herdsman", 3, 2),
    ("Storm Harpies", "Storm Harpy", 2, 2),
    ("The Drowned Crew", "Drowned Sailor", 2, 2),
    ("Sirens' Kin", "Siren", 2, 2),
    ("Deep Serpents", "Deep Serpent", 3, 2),
]

RELICS_TOTAL = 8           # trial lairs on the map, one relic seal each
RELICS_TO_WIN = 3
SHRINE_CHARGES = 2

# radial layout: ring radii (world units) and islands per ring
_RING_R = [175.0, 320.0, 460.0]
_HOME_R = 85.0                # Home Port, just south of the Pharos
WALL_R = 600.0                # the storm wall that seals the region
_WAYPOINT_EVERY = 34.0        # aim for a sea node roughly every N world units
_MAX_WAYPOINTS = 2            # per lane — tuned so a skilled voyage ends ~45 rolls
_FLOTSAM_CHANCE = 0.25
_SEA_LOOKS = ["buoy", "buoy", "buoy", "rocks", "rocks", "islet", "islet", "none"]
_RING_TYPES = {
    1: ["shrine", "shrine", "shrine", "puzzle", "puzzle", "shop", "shop", "haven"],
    2: ["lair", "lair", "monster", "monster", "monster",
        "shrine", "shrine", "puzzle", "puzzle", "shop"],
    3: ["lair", "lair", "lair", "lair", "lair", "lair", "monster", "haven"],
}


class Board:
    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed)
        self.nodes: dict[str, dict] = {}
        self.edges: list[tuple[str, str]] = []
        self.neighbors: dict[str, list[str]] = {}
        self.home = "home"
        self.pharos = "pharos"
        self._generate()

    # ── generation ───────────────────────────────────────────────────────────
    def _generate(self):
        rng = self.rng
        names = ISLAND_NAMES[:]
        rng.shuffle(names)
        bosses, elites = BOSSES[:], ELITES[:]
        rng.shuffle(bosses); rng.shuffle(elites)

        # the Pharos at the world's center, Home Port in its shadow
        self.nodes["pharos"] = {"id": "pharos", "name": "The Pharos",
                                "type": "pharos", "band": 0, "x": 0.0, "z": 0.0}
        self.nodes["home"] = {"id": "home", "name": "Home Port", "type": "home",
                              "band": 0, "x": round(rng.uniform(-18, 18), 2),
                              "z": round(_HOME_R + rng.uniform(-8, 8), 2)}

        rings: list[list[str]] = [["home"]]
        for ri, radius in enumerate(_RING_R, start=1):
            types = _RING_TYPES[ri][:]
            rng.shuffle(types)
            row = []
            base = rng.uniform(0, 6.28)
            for i, ntype in enumerate(types):
                a = base + (i / len(types)) * 6.28318 + rng.uniform(-0.14, 0.14)
                r = radius + rng.uniform(-26, 26)
                nid = f"n{ri}_{i}"
                node = {"id": nid, "name": names.pop(), "type": ntype, "band": ri,
                        "x": round(math.cos(a) * r, 2), "z": round(math.sin(a) * r, 2)}
                self.nodes[nid] = node
                row.append(nid)
            rings.append(row)

        # decorate payloads
        relic_no = 1
        for ri in range(1, 4):
            for nid in rings[ri]:
                node = self.nodes[nid]
                ntype = node["type"]
                if ntype == "shrine":
                    node["domain"] = rng.choice(DOMAINS)
                    node["charges"] = SHRINE_CHARGES
                    node["tier"] = 1 if ri == 1 else 2
                elif ntype == "puzzle":
                    node["solved"] = False
                elif ntype == "monster":
                    node["monster"] = None       # hunting grounds: packs spawn on landing
                    node["encounter"] = True
                elif ntype == "lair":
                    pool = bosses if ri <= 2 else (bosses if rng.random() < 0.4 and bosses else elites)
                    m = pool.pop() if pool else (elites.pop() if elites else bosses.pop())
                    node["monster"] = self._boss(m, rng)
                    node["relic"] = relic_no
                    relic_no += 1
        self.nodes["pharos"]["monster"] = self._boss(WARDEN, rng)

        # edges — ring roads (loops), spokes inward, a few long chords
        for ri in range(1, 4):
            row = rings[ri]
            for i in range(len(row)):                       # ring road
                if rng.random() < 0.92:
                    self._link(row[i], row[(i + 1) % len(row)])
        for nid in rings[1]:                                # ring 1 ↔ the center
            if rng.random() < 0.5:
                self._link(nid, "home")
        near_home = sorted(rings[1], key=lambda p: self._dist("home", p))
        for nid in near_home[:3]:
            self._link("home", nid)
        for nid in sorted(rings[1], key=lambda p: self._dist("pharos", p))[:3]:
            self._link("pharos", nid)                       # locked until the end
        for ri in (2, 3):                                   # spokes inward
            for nid in rings[ri]:
                inner = sorted(rings[ri - 1], key=lambda p: self._dist(nid, p))
                self._link(nid, inner[0])
                if rng.random() < 0.5 and len(inner) > 1:
                    self._link(nid, inner[1])
        for _ in range(3):                                  # rare long chords
            if rng.random() < 0.4:
                a = rng.choice(rings[1])
                b = min(rings[3], key=lambda p: self._dist(a, p))
                self._link(a, b)

        self._build_neighbors()
        self._ensure_connected()
        self._insert_waypoints(rng)

    def _insert_waypoints(self, rng):
        """Split every island-to-island edge into a chain of open-sea nodes,
        so distance is measured in real sailing turns."""
        island_edges = self.edges[:]
        self.edges = []
        wp = 0
        for a, b in island_edges:
            length = self._dist(a, b)
            n_way = min(_MAX_WAYPOINTS, max(1, round(length / _WAYPOINT_EVERY) - 1))
            na, nb = self.nodes[a], self.nodes[b]
            chain = [a]
            for k in range(1, n_way + 1):
                t = k / (n_way + 1)
                # perpendicular jitter so routes curve like real currents
                px, pz = -(nb["z"] - na["z"]), (nb["x"] - na["x"])
                plen = max(1e-6, (px * px + pz * pz) ** 0.5)
                jit = rng.uniform(-10.0, 10.0)
                nid = f"sea{wp}"
                wp += 1
                self.nodes[nid] = {
                    "id": nid, "name": "Open Sea", "type": "sea",
                    "band": max(na["band"], nb["band"]),
                    "x": round(na["x"] + (nb["x"] - na["x"]) * t + px / plen * jit, 2),
                    "z": round(na["z"] + (nb["z"] - na["z"]) * t + pz / plen * jit, 2),
                    "flotsam": rng.random() < _FLOTSAM_CHANCE,
                    "look": rng.choice(_SEA_LOOKS),
                }
                chain.append(nid)
            chain.append(b)
            for u, v in zip(chain, chain[1:]):
                self._link(u, v)
        self._build_neighbors()

    def _boss(self, spec, rng) -> dict:
        """A trial guardian: ONE great enemy — the boss battles of the voyage."""
        name, hp, power, tier = spec
        return {"name": name, "tier": tier, "domain": rng.choice(DOMAINS),
                "boss": True,
                "enemies": [{"name": name, "hp": hp, "max_hp": hp, "power": power}]}

    def random_pack(self, band: int, rng: random.Random | None = None) -> dict:
        """A fresh random encounter for a hunting-ground landing (1-3 enemies)."""
        rng = rng or self.rng
        pool = ENCOUNTERS_LIGHT if band <= 2 else ENCOUNTERS_HEAVY
        name, unit, hp, power = rng.choice(pool)
        count = rng.choice([2, 2, 3]) if hp <= 2 else rng.choice([1, 2])
        enemies = [{"name": f"{unit} {'ⅠⅡⅢ'[i]}" if count > 1 else unit,
                    "hp": hp, "max_hp": hp, "power": power} for i in range(count)]
        return {"name": name, "tier": 2 if band <= 2 else 3,
                "domain": rng.choice(DOMAINS), "enemies": enemies}

    def _dist(self, a: str, b: str) -> float:
        na, nb = self.nodes[a], self.nodes[b]
        return ((na["x"] - nb["x"]) ** 2 + (na["z"] - nb["z"]) ** 2) ** 0.5

    def _link(self, a: str, b: str):
        if a != b and (a, b) not in self.edges and (b, a) not in self.edges:
            self.edges.append((a, b))

    def _build_neighbors(self):
        self.neighbors = {nid: [] for nid in self.nodes}
        for a, b in self.edges:
            self.neighbors[a].append(b)
            self.neighbors[b].append(a)

    def _ensure_connected(self):
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
                candidates = [p for p in seen if p != nid]
                nearest = min(candidates, key=lambda p: self._dist(nid, p))
                self._link(nid, nearest)
                seen.add(nid)
        self._build_neighbors()

    # ── queries ──────────────────────────────────────────────────────────────
    def lairs(self) -> list[str]:
        return [nid for nid, n in self.nodes.items() if n["type"] == "lair"]

    def alive_monster(self, nid: str) -> dict | None:
        m = self.nodes[nid].get("monster")
        return m if m and any(e["hp"] > 0 for e in m["enemies"]) else None

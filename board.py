"""
Thalassa board — the Safe Isles ringed by storm, four gates to the wilds.

Every game rolls a new chart. The Pharos — a shining white colossus — stands
at the exact center; Home Port sits in its shadow. Three rings of islands
(the SAFE ISLES: temples, puzzle spires, market isles, havens, and small
hunting grounds — nothing worse) spread to the storm wall that seals the
world. Ring roads and spokes make the chart a lattice of LOOPS.

At the four compass points a GATE pierces the storm. Beyond each lies a
REGION drawn at random from a themed pool — a spine of hard water with a
couple of side loops, elite ambushes, one haven, and a solo BOSS at the
far end holding that region's sigil fragment. Bosses are personal trials:
every captain faces their own. Haul a fragment home to bank it; bank
RELICS_TO_WIN and the Pharos opens.

Node types: home · pharos · shrine · puzzle · haven · shop · monster ·
            lair · gate · sea
The engine owns per-game state (monster hp, shrine charges, fragments),
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
    "Alonissos", "Skopelos", "Euboia", "Delos", "Mykonos", "Anafi",
    "Nisyros", "Chalki", "Lipsi", "Fourni", "Psara", "Antikythera",
    "Gavdos", "Elafonisos", "Meganisi", "Kalamos",
]

WARDEN = ("The Warden of the Pharos", 8, 3, 3)

# ── the region pool: 4 are drawn per game, one per storm gate ────────────────
# Each region: palette theme id, display name, boss (solo, personal trial),
# and an elite encounter table for its hunting grounds.
REGION_POOL = {
    "autumn": {
        "name": "The Amber Vale", "boss": ("The Stag King", 6, 2, 3),
        "elites": [("Dire Boars", "Dire Boar", 3, 2),
                   ("Stag Spirits", "Stag Spirit", 2, 2),
                   ("Leafshade Wolves", "Leafshade Wolf", 2, 2)],
    },
    "ice": {
        "name": "The Frostfang Shores", "boss": ("The Boreal Wyrm", 6, 2, 3),
        "elites": [("Frost Wolves", "Frost Wolf", 2, 2),
                   ("Ice Wraiths", "Ice Wraith", 2, 2),
                   ("Rime Harpies", "Rime Harpy", 2, 2)],
    },
    "volcano": {
        "name": "The Cinderline", "boss": ("The Forge Tyrant", 6, 2, 3),
        "elites": [("Magma Hounds", "Magma Hound", 3, 2),
                   ("Ash Shades", "Ash Shade", 2, 2),
                   ("Cinder Serpents", "Cinder Serpent", 3, 2)],
    },
    "jungle": {
        "name": "The Verdigris Deep", "boss": ("The Strangler Matriarch", 6, 2, 3),
        "elites": [("Jaguar Shades", "Jaguar Shade", 2, 2),
                   ("Vine Horrors", "Vine Horror", 3, 2),
                   ("Poison Birds", "Poison Bird", 2, 2)],
    },
    "marsh": {
        "name": "The Mirefen", "boss": ("The Mire Hag", 6, 2, 3),
        "elites": [("Bog Drowned", "Drowned Thrall", 2, 2),
                   ("Fen Serpents", "Fen Serpent", 3, 2),
                   ("Will-o-Wisps", "Will-o-Wisp", 2, 2)],
    },
    "desert": {
        "name": "The Bleached Reach", "boss": ("The Dune Colossus", 6, 2, 3),
        "elites": [("Sand Raiders", "Sand Raider", 2, 2),
                   ("Bone Vultures", "Bone Vulture", 2, 2),
                   ("Glass Scorpions", "Glass Scorpion", 3, 2)],
    },
    "blossom": {
        "name": "The Petal Court", "boss": ("The Thorn Queen", 6, 2, 3),
        "elites": [("Petal Sprites", "Petal Sprite", 2, 2),
                   ("Briar Beasts", "Briar Beast", 3, 2),
                   ("Silk Moths", "Silk Moth", 2, 2)],
    },
    "reef": {
        "name": "The Drowned Reef", "boss": ("The Tide Wyrm", 6, 2, 3),
        "elites": [("Reef Lurkers", "Reef Lurker", 3, 2),
                   ("Coral Crabs", "Coral Crab", 3, 2),
                   ("Deep Sirens", "Deep Siren", 2, 2)],
    },
}

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

REGIONS_PER_GAME = 4       # gates through the storm, one region beyond each
RELICS_TO_WIN = 3          # sigil fragments needed to open the Pharos
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
    2: ["monster", "monster", "monster", "shrine", "shrine",
        "puzzle", "puzzle", "shop", "haven", "haven"],
    3: ["monster", "monster", "monster", "shrine", "puzzle", "haven", "shop", "haven"],
}
_GATE_ANGLES = [1.5707963, 3.1415927, 4.7123890, 0.0]   # N, W, S, E of the chart
_REGION_SPINE = (4, 6)        # spine stops per region (min, max)


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

        # decorate the Safe Isles — no lairs in here, only small trouble
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

        # ── the four storm gates and the regions beyond ──────────────────────
        self.gates = []
        self.regions = rng.sample(sorted(REGION_POOL), REGIONS_PER_GAME)
        for gi, (theme, base_a) in enumerate(zip(self.regions, _GATE_ANGLES)):
            self._grow_region(gi, theme, base_a + rng.uniform(-0.18, 0.18),
                              rings, names, rng)

        self._build_neighbors()
        self._ensure_connected()
        self._insert_waypoints(rng)

    def _grow_region(self, gi: int, theme: str, ang: float, rings, names, rng):
        """A gate through the wall, then a spine of hard water with side
        loops, elite hunting grounds, one haven, and the boss at the end."""
        info = REGION_POOL[theme]
        gate_id = f"gate{gi}"
        gx = math.cos(ang) * (WALL_R + 10)
        gz = math.sin(ang) * (WALL_R + 10)
        self.nodes[gate_id] = {"id": gate_id, "name": f"Gate of {info['name']}",
                               "type": "gate", "band": 4, "region": theme,
                               "gate_angle": round(ang, 4),
                               "x": round(gx, 2), "z": round(gz, 2)}
        self.gates.append(gate_id)
        near = min(rings[3], key=lambda p: self._dist(gate_id, p))
        self._link(gate_id, near)

        # the spine marches outward with a slow bend
        n_spine = rng.randint(*_REGION_SPINE)
        spine = [gate_id]
        bend = rng.uniform(-0.055, 0.055)
        for i in range(1, n_spine + 1):
            a = ang + bend * i + rng.uniform(-0.03, 0.03)
            r = (WALL_R + 10) + i * rng.uniform(72, 92)
            nid = f"r{gi}_{i}"
            # spine stops: mostly open water, salted with elite grounds
            self.nodes[nid] = {"id": nid, "name": "Open Sea", "type": "sea",
                               "band": 4, "region": theme,
                               "x": round(math.cos(a) * r, 2),
                               "z": round(math.sin(a) * r, 2),
                               "flotsam": rng.random() < 0.3,
                               "look": rng.choice(_SEA_LOOKS)}
            self._link(spine[-1], nid)
            spine.append(nid)

        # promote spine stops: elites, a haven checkpoint, maybe a temple
        interior = spine[1:-1]
        picks = rng.sample(interior, min(4, len(interior)))
        for i, nid in enumerate(picks):
            node = self.nodes[nid]
            node["name"] = names.pop()
            node.pop("flotsam", None)
            node.pop("look", None)
            if i < 2:
                node["type"] = "monster"
                node["monster"] = None
                node["encounter"] = True
                node["elite"] = True
            elif i == 2:
                node["type"] = "haven"
            else:
                node["type"] = "shrine"
                node["domain"] = rng.choice(DOMAINS)
                node["charges"] = SHRINE_CHARGES
                node["tier"] = 2

        # the boss altar at the spine's end
        end = spine[-1]
        node = self.nodes[end]
        node.pop("flotsam", None)
        node.pop("look", None)
        node["type"] = "lair"
        node["name"] = info["name"]
        node["region"] = theme
        node["boss_spec"] = list(info["boss"])
        node["monster"] = None            # a fresh boss spawns per challenger
        node["defeated"] = []             # pids who have beaten their trial
        node["stash"] = []                # pids with a fragment waiting here

        # 1-2 side loops for exact-roll steering
        for _ in range(rng.randint(1, 2)):
            if len(spine) < 4:
                break
            i0 = rng.randint(1, len(spine) - 3)
            i1 = i0 + rng.randint(1, 2)
            if i1 >= len(spine) - 1:
                i1 = len(spine) - 2
            if i0 >= i1:
                continue
            side = rng.choice([-1, 1])
            a0 = math.atan2(self.nodes[spine[i0]]["z"], self.nodes[spine[i0]]["x"])
            mid_r = (math.hypot(self.nodes[spine[i0]]["x"], self.nodes[spine[i0]]["z"]) +
                     math.hypot(self.nodes[spine[i1]]["x"], self.nodes[spine[i1]]["z"])) / 2
            nid = f"r{gi}_s{i0}"
            if nid in self.nodes:
                continue
            aa = a0 + side * 0.14
            self.nodes[nid] = {"id": nid, "name": "Open Sea", "type": "sea",
                               "band": 4, "region": theme,
                               "x": round(math.cos(aa) * mid_r, 2),
                               "z": round(math.sin(aa) * mid_r, 2),
                               "flotsam": rng.random() < 0.4,
                               "look": rng.choice(_SEA_LOOKS)}
            self._link(spine[i0], nid)
            self._link(nid, spine[i1])

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
                reg = na.get("region") or nb.get("region")
                if reg:
                    self.nodes[nid]["region"] = reg
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

    def random_pack(self, node: dict, rng: random.Random | None = None) -> dict:
        """A fresh random encounter for a hunting-ground landing (1-3 enemies).
        Region grounds draw from their theme's elite table."""
        rng = rng or self.rng
        theme = node.get("region")
        if theme and node.get("elite"):
            pool = REGION_POOL[theme]["elites"]
            tier = 3
        else:
            pool = ENCOUNTERS_LIGHT if node.get("band", 0) <= 2 else ENCOUNTERS_HEAVY
            tier = 2 if node.get("band", 0) <= 2 else 3
        name, unit, hp, power = rng.choice(pool)
        count = rng.choice([2, 2, 3]) if hp <= 2 else rng.choice([1, 2])
        enemies = [{"name": f"{unit} {'ⅠⅡⅢ'[i]}" if count > 1 else unit,
                    "hp": hp, "max_hp": hp, "power": power} for i in range(count)]
        return {"name": name, "tier": tier,
                "domain": rng.choice(DOMAINS), "enemies": enemies}

    def spawn_boss(self, nid: str) -> dict:
        """A fresh personal-trial boss for whoever just landed."""
        node = self.nodes[nid]
        node["monster"] = self._boss(tuple(node["boss_spec"]), self.rng)
        return node["monster"]

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

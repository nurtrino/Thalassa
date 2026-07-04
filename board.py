"""
Thalassa board — the Isles of Peace ringed by mountains, four passes to the wilds.

Every game rolls a new chart. The Pharos — a shining white colossus — stands
at the exact center; Home Port sits in its shadow. Three rings of islands
(the ISLES OF PEACE: temples, puzzle spires, market isles and havens — no
monsters, no ambushes, safe waters throughout) spread to the mountain wall
that seals the world. Ring roads and spokes make the chart a lattice of LOOPS.

At the four compass points a PASS pierces the mountains. Beyond each lies
one of the four REALMS — ice, desert, jungle, autumn — a dungeon-like spine
of hard travel where the enemies grow with every stop (depth 1..n), with a
couple of side loops, one haven checkpoint, and a solo BOSS at the far end
holding that realm's sigil fragment. Bosses are personal trials: every
captain faces their own. The desert is crossed ON FOOT — you beach your
ship at the pass. Haul a fragment home to bank it; bank RELICS_TO_WIN and
the Pharos opens.

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

WARDEN = ("The Dark Lord", 14, 3, 3)

# ── the four realms, one beyond each mountain pass ───────────────────────────
# Each realm: display name, travel mode ("sail" | "foot"), a boss (solo,
# personal trial: name, hp, power, question tier), the model id of its boss,
# and THREE encounter tiers — shallow / mid / deep — so the realm plays like
# a dungeon: the further from the pass, the worse what finds you.
# Encounter rows: (pack name, unit name, unit hp, unit power, model id)
REGION_POOL = {
    "autumn": {
        "name": "The Amber Vale", "mode": "sail",
        "boss": ("The Stag King", 12, 2, 3), "boss_model": "stag_king",
        "tiers": [
            [("Leafshade Wolves", "Leafshade Wolf", 2, 1, "wolf"),
             ("Thistle Fauns", "Thistle Faun", 1, 1, "faun"),
             ("Carrion Crows", "Carrion Crow", 1, 1, "bird")],
            [("Dire Boars", "Dire Boar", 3, 2, "boar"),
             ("Stag Spirits", "Stag Spirit", 2, 2, "stag"),
             ("Briar Beasts", "Briar Beast", 3, 2, "briar")],
            [("Wickerwood Shamblers", "Wicker Shambler", 4, 2, "shambler"),
             ("Horned Shades", "Horned Shade", 3, 3, "shade"),
             ("The Old Sounder", "Great Boar", 5, 2, "boar")],
        ],
    },
    "ice": {
        "name": "The Frostfang Reach", "mode": "sail",
        "boss": ("The Boreal Wyrm", 12, 2, 3), "boss_model": "wyrm",
        "tiers": [
            [("Frost Wolves", "Frost Wolf", 2, 1, "wolf"),
             ("Rime Harpies", "Rime Harpy", 1, 1, "harpy"),
             ("Snow Foxes", "Snow Fox", 1, 1, "fox")],
            [("Ice Wraiths", "Ice Wraith", 2, 2, "wraith"),
             ("Floe Stalkers", "Floe Stalker", 3, 2, "stalker"),
             ("Berg Crabs", "Berg Crab", 3, 2, "crab")],
            [("Glacier Golems", "Glacier Golem", 4, 2, "golem"),
             ("The Pale Court", "Pale Wraith", 3, 3, "wraith"),
             ("Frostfang Alphas", "Frostfang Alpha", 5, 2, "wolf")],
        ],
    },
    "desert": {
        "name": "The Bleached Reach", "mode": "foot",
        "boss": ("The Dune Colossus", 12, 2, 3), "boss_model": "colossus",
        "tiers": [
            [("Sand Raiders", "Sand Raider", 2, 1, "raider"),
             ("Bone Vultures", "Bone Vulture", 1, 1, "vulture"),
             ("Salt Jackals", "Salt Jackal", 1, 1, "jackal")],
            [("Glass Scorpions", "Glass Scorpion", 3, 2, "scorpion"),
             ("Mirage Dancers", "Mirage Dancer", 2, 2, "wraith"),
             ("Dust Serpents", "Dust Serpent", 3, 2, "serpent")],
            [("Tomb Sentinels", "Tomb Sentinel", 4, 2, "golem"),
             ("The Bleached Choir", "Bleached Priest", 3, 3, "shade"),
             ("Dune Scourges", "Dune Scourge", 5, 2, "scorpion")],
        ],
    },
    "jungle": {
        "name": "The Verdigris Deep", "mode": "sail",
        "boss": ("The Strangler Matriarch", 12, 2, 3), "boss_model": "matriarch",
        "tiers": [
            [("Poison Birds", "Poison Bird", 1, 1, "bird"),
             ("River Drakes", "River Drake", 2, 1, "drake"),
             ("Thorn Monkeys", "Thorn Monkey", 1, 1, "monkey")],
            [("Jaguar Shades", "Jaguar Shade", 2, 2, "jaguar"),
             ("Vine Horrors", "Vine Horror", 3, 2, "briar"),
             ("Bloom Serpents", "Bloom Serpent", 3, 2, "serpent")],
            [("Canopy Tyrants", "Canopy Tyrant", 4, 2, "drake"),
             ("The Emerald Watch", "Emerald Sentinel", 3, 3, "golem"),
             ("Strangler Brood", "Strangler Sapling", 5, 2, "matriarch")],
        ],
    },
}

# Random encounter table for hunting grounds ("monster" spots): a fresh pack
# ambushes whoever LANDS there — they never wall off passage.
# (pack name, unit name, unit hp, unit power, model id)
ENCOUNTERS_LIGHT = [
    ("Harpies", "Harpy", 1, 1, "harpy"),
    ("Sea Wolves", "Sea Wolf", 1, 1, "wolf"),
    ("Satyr Brigands", "Satyr Brigand", 1, 1, "raider"),
    ("Stymphalian Birds", "Stymphalian Bird", 1, 1, "bird"),
    ("Brigand Skiffs", "Brigand Skiff", 2, 1, "skiff"),
    ("Reef Serpents", "Reef Serpent", 2, 1, "serpent"),
]
ENCOUNTERS_HEAVY = [
    ("Laestrygonian Raiders", "Laestrygonian Raider", 2, 2, "raider"),
    ("Cyclops Herdsmen", "Cyclops Herdsman", 3, 2, "cyclops"),
    ("Storm Harpies", "Storm Harpy", 2, 2, "harpy"),
    ("The Drowned Crew", "Drowned Sailor", 2, 2, "drowned"),
    ("Sirens' Kin", "Siren", 2, 2, "siren"),
    ("Deep Serpents", "Deep Serpent", 3, 2, "serpent"),
]

REGIONS_PER_GAME = 4       # passes through the mountains, one realm beyond each
RELICS_TO_WIN = 3          # sigil fragments needed to open the Pharos
SHRINE_CHARGES = 2

# radial layout: ring radii (world units) and islands per ring.
# Distances are tuned for the d3: every lane is a single open-sea hop, so a
# neighbouring island is 2 exact steps away and the loops do the steering.
_RING_R = [150.0, 265.0, 380.0]
_HOME_R = 70.0                # Home Port, just south of the Pharos
WALL_R = 490.0                # the mountain wall that seals the Safe Isles
_WAYPOINT_EVERY = 60.0        # aim for a sea node roughly every N world units
_MAX_WAYPOINTS = 1            # per HUB lane — tuned for exact-roll d3 sailing
_WAYPOINT_EVERY_REALM = 42.0  # realms are finer-grained: a real crawl
_MAX_WAYPOINTS_REALM = 2      # per REALM lane
_FLOTSAM_CHANCE = 0.25
_SEA_LOOKS = ["buoy", "buoy", "buoy", "rocks", "rocks", "islet", "islet", "none"]
# The Isles of Peace are exactly that — no hunting grounds, no ambushes. All
# danger lives beyond the mountain passes. (Monsters are grown into the realm
# spines by _grow_region.)
_RING_TYPES = {
    1: ["shrine", "shrine", "shrine", "puzzle", "puzzle", "shop", "shop", "haven"],
    2: ["shrine", "shrine", "shrine", "puzzle", "puzzle",
        "shop", "shop", "haven", "haven", "puzzle"],
    3: ["shrine", "shrine", "puzzle", "puzzle", "haven", "shop", "haven", "shop"],
}
_GATE_ANGLES = [1.5707963, 3.1415927, 4.7123890, 0.0]   # N, W, S, E of the chart
_REGION_SPINE = (5, 7)        # spine stops per realm (min, max) — a real trek


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

        # decorate the Isles of Peace — temples, spires, markets, havens only
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

        # ── the four mountain passes and the realms beyond ───────────────────
        # Every game has all four realms; only which compass pass leads to
        # which realm is rolled.
        self.gates = []
        self.regions = sorted(REGION_POOL)
        rng.shuffle(self.regions)
        for gi, (theme, base_a) in enumerate(zip(self.regions, _GATE_ANGLES)):
            self._grow_region(gi, theme, base_a + rng.uniform(-0.18, 0.18),
                              rings, names, rng)

        self._build_neighbors()
        self._ensure_connected()
        self._insert_waypoints(rng)

    def _grow_region(self, gi: int, theme: str, ang: float, rings, names, rng):
        """A pass through the mountain wall, then a FORK: two ways to the boss.

          · The PERILOUS road — short and straight, but every stop is an elite
            hunting ground in deep water. Race it if your ship can take the
            beating.
          · The LONG road — a wide arc of many stops, mostly quiet sailing with
            a haven to camp and a shrine for scrolls, and only a couple of weak
            packs. Slow, but survivable.

        Both rejoin at a junction just short of the boss altar. The desert
        realm is crossed on foot; its 'sea' stops are dune trail, not water."""
        info = REGION_POOL[theme]
        mode = info.get("mode", "sail")
        trail = "Dune Trail" if mode == "foot" else "Open Sea"
        R0 = WALL_R + 10

        gate_id = f"gate{gi}"
        self.nodes[gate_id] = {"id": gate_id, "name": f"Pass of {info['name']}",
                               "type": "gate", "band": 4, "region": theme,
                               "gate_angle": round(ang, 4),
                               "x": round(math.cos(ang) * R0, 2),
                               "z": round(math.sin(ang) * R0, 2)}
        self.gates.append(gate_id)
        near = min(rings[3], key=lambda p: self._dist(gate_id, p))
        self._link(gate_id, near)

        def place(nid, radius, a, depth):
            node = {"id": nid, "name": trail, "type": "sea", "band": 4,
                    "region": theme, "depth": depth, "mode": mode,
                    "x": round(math.cos(a) * radius, 2),
                    "z": round(math.sin(a) * radius, 2),
                    "flotsam": rng.random() < 0.3, "look": rng.choice(_SEA_LOOKS)}
            self.nodes[nid] = node
            return node

        def make_monster(node, elite, depth):
            node["type"] = "monster"
            node["monster"] = None
            node["encounter"] = True
            node["depth"] = depth
            node["elite"] = elite
            node["name"] = names.pop()
            node.pop("look", None)
            node.pop("flotsam", None)

        # ── the boss altar, at the radial far end ────────────────────────────
        lair_id = f"r{gi}_L"
        lair = place(lair_id, R0 + 470, ang + rng.uniform(-0.03, 0.03), 9)
        lair.pop("flotsam", None)
        lair.pop("look", None)
        lair["type"] = "lair"
        lair["name"] = info["name"]
        lair["boss_spec"] = list(info["boss"])
        lair["monster"] = None
        lair["defeated"] = []
        lair["stash"] = []

        # a junction node both roads share, just before the altar
        junc_id = f"r{gi}_j"
        place(junc_id, R0 + 340, ang + rng.uniform(-0.03, 0.03), 8)

        # ── the FINAL LOOP: a ring of approach nodes circling the altar ──────
        # The boss sits on a small loop instead of a dead-end spur, so exact
        # rolls always have a way to land on it — circle the ring to line up
        # your step count instead of bouncing back and forth forever.
        appL_id, appR_id, appF_id = f"r{gi}_aL", f"r{gi}_aR", f"r{gi}_aF"
        place(appL_id, R0 + 405, ang - 0.16, 8)
        place(appR_id, R0 + 405, ang + 0.16, 8)
        place(appF_id, R0 + 445, ang + rng.uniform(-0.03, 0.03), 9)
        # junction feeds both sides of the ring; the ring wraps around the
        # altar and every ring node touches it, so there are many exact-step
        # approaches to choose from.
        self._link(junc_id, appL_id)
        self._link(junc_id, appR_id)
        self._link(appL_id, appF_id)
        self._link(appR_id, appF_id)
        self._link(appL_id, appR_id)          # close the loop behind the boss
        self._link(appL_id, lair_id)
        self._link(appR_id, lair_id)
        self._link(appF_id, lair_id)

        # ── the PERILOUS road: 3 elite grounds, straight and deep ────────────
        hard = [gate_id]
        for i in range(1, 4):
            nid = f"r{gi}_h{i}"
            a = ang + rng.uniform(-0.04, 0.04)
            make_monster(place(nid, R0 + i * 88, a, 4 + i), elite=True, depth=4 + i)
            hard.append(nid)
        hard.append(junc_id)
        for u, v in zip(hard, hard[1:]):
            self._link(u, v)

        # ── the LONG road: a wide safe arc with a haven and a shrine ─────────
        side = rng.choice([-1, 1])
        plan = ["sea", "weak", "haven", "sea", "weak", "shrine", "sea"]
        rng2 = plan[:]
        long = [gate_id]
        n = len(plan)
        for i, kind in enumerate(plan):
            t = (i + 1) / (n + 1)
            radius = R0 + 55 + t * (360 - 55)
            a = ang + side * 0.62 * math.sin(math.pi * t)     # bow out, then back
            depth = 1 + i // 3                                 # shallow: 1,1,1,2,2,2,3
            nid = f"r{gi}_e{i}"
            node = place(nid, radius, a, depth)
            if kind == "weak":
                make_monster(node, elite=False, depth=min(2, depth))
            elif kind == "haven":
                node["type"] = "haven"
                node["name"] = names.pop()
                node.pop("flotsam", None)
                node.pop("look", None)
            elif kind == "shrine":
                node["type"] = "shrine"
                node["name"] = names.pop()
                node["domain"] = rng.choice(DOMAINS)
                node["charges"] = SHRINE_CHARGES
                node["tier"] = 2
                node.pop("flotsam", None)
                node.pop("look", None)
            long.append(nid)
        long.append(junc_id)
        for u, v in zip(long, long[1:]):
            self._link(u, v)

    def _insert_waypoints(self, rng):
        """Split every island-to-island edge into a chain of open-sea nodes,
        so distance is measured in real sailing turns."""
        island_edges = self.edges[:]
        self.edges = []
        wp = 0
        for a, b in island_edges:
            length = self._dist(a, b)
            na, nb = self.nodes[a], self.nodes[b]
            # Realm lanes get MORE waypoints so a d3 only nudges you a spot or
            # two through the wilds — the trial is a careful crawl, not a
            # sprint. Hub lanes stay coarse so the Isles of Peace sail quickly.
            if na.get("region") and nb.get("region"):
                n_way = min(_MAX_WAYPOINTS_REALM,
                            max(2, round(length / _WAYPOINT_EVERY_REALM) - 1))
            else:
                n_way = min(_MAX_WAYPOINTS, max(1, round(length / _WAYPOINT_EVERY) - 1))
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
                # a lane belongs to a realm only when BOTH ends are inside it —
                # the approach from the Safe Isles to a pass is still Aegean.
                if na.get("region") and nb.get("region"):
                    self.nodes[nid]["region"] = na["region"]
                    mode = na.get("mode") or nb.get("mode")
                    if mode:
                        self.nodes[nid]["mode"] = mode
                        if mode == "foot":
                            self.nodes[nid]["name"] = "Dune Trail"
                    if na.get("depth") or nb.get("depth"):
                        self.nodes[nid]["depth"] = min(na.get("depth") or 99,
                                                       nb.get("depth") or 99)
                chain.append(nid)
            chain.append(b)
            for u, v in zip(chain, chain[1:]):
                self._link(u, v)
        self._build_neighbors()

    # Titles for a boss that has already been slain once and rises again,
    # harder, for the next challenger. Index by how many rivals beat it before.
    ESCALATION_TITLES = ["", "the Ascendant", "the Vengeful", "the Undying",
                         "the Eternal"]

    def _boss(self, spec, rng, model: str = "warden", escalate: int = 0) -> dict:
        """A trial guardian: ONE great enemy — the boss battles of the voyage.
        Bosses always counter, telegraph a heavy blow every third exchange,
        and enrage at half strength (the engine drives those rules).

        ``escalate`` is how many rivals have already felled this boss. Each
        prior victor leaves the guardian risen angrier: more health and, past
        the first, more bite — so the first to reach a lair fights the weakest
        form. A later challenger meets a titled, tougher version."""
        name, hp, power, tier = spec
        if escalate:
            hp += 5 * escalate
            power += min(2, escalate)
            ti = min(escalate, len(self.ESCALATION_TITLES) - 1)
            title = self.ESCALATION_TITLES[ti]
            if title:
                name = f"{name}, {title}"
        return {"name": name, "tier": tier, "domain": rng.choice(DOMAINS),
                "boss": True, "model": model, "enraged": False,
                "escalation": escalate,
                "enemies": [{"name": name, "hp": hp, "max_hp": hp,
                             "power": power, "model": model}]}

    def random_pack(self, node: dict, rng: random.Random | None = None) -> dict:
        """A fresh random encounter for a landing. Inside a realm the pack is
        drawn from that realm's tier table by DEPTH — the dungeon curve:
        depth 1-2 shallow, 3-4 mid, deeper is the worst the realm has."""
        rng = rng or self.rng
        theme = node.get("region")
        if theme and node.get("depth"):
            depth = node["depth"]
            tiers = REGION_POOL[theme]["tiers"]
            ti = 0 if depth <= 2 else (1 if depth <= 4 else 2)
            pool = tiers[ti]
            tier = 2 if ti == 0 else 3
            count_bonus = 1 if ti == 2 else 0
        else:
            pool = ENCOUNTERS_LIGHT if node.get("band", 0) <= 2 else ENCOUNTERS_HEAVY
            tier = 2 if node.get("band", 0) <= 2 else 3
            count_bonus = 0
        name, unit, hp, power, model = rng.choice(pool)
        count = (rng.choice([2, 2, 3]) if hp <= 2 else rng.choice([1, 2])) + count_bonus
        count = min(count, 3)
        enemies = [{"name": f"{unit} {'ⅠⅡⅢ'[i]}" if count > 1 else unit,
                    "hp": hp, "max_hp": hp, "power": power, "model": model}
                   for i in range(count)]
        return {"name": name, "tier": tier, "model": model,
                "domain": rng.choice(DOMAINS), "enemies": enemies}

    def spawn_boss(self, nid: str) -> dict:
        """A fresh personal-trial boss for whoever just landed. Every rival who
        already conquered this lair leaves the guardian risen harder for the
        next arrival — reward for reaching the trial first."""
        node = self.nodes[nid]
        theme = node.get("region")
        model = REGION_POOL[theme]["boss_model"] if theme else "warden"
        escalate = len(node.get("defeated", []))
        node["monster"] = self._boss(tuple(node["boss_spec"]), self.rng, model,
                                     escalate=escalate)
        return node["monster"]

    def reset_warden(self):
        """A fresh Warden for the next challenger — the final trial is
        personal too; nobody inherits a softened boss."""
        self.nodes["pharos"]["monster"] = self._boss(WARDEN, self.rng)

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

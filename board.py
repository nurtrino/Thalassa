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
the Pharos opens. (The Amber Vale is mid-rebuild: its pass stands, but the
realm beyond is EMPTY ground for now — see _grow_region.)

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

# the endgame wall: tankier than a realm boss (a normal boss is 12) so the final
# trial actually tests the upgrades you've hauled home — but not a slog when
# STRIKE only chips 1 (MAGIC / the Sword of Damocles swing for 3)
WARDEN = ("The Dark Presence", 24, 3, 3)
WARDEN_MODEL = "tyrant"            # the colossal dark biped who holds the Pharos

# ── the four realms, one beyond each mountain pass ───────────────────────────
# Each realm: display name, travel mode ("sail" | "foot"), a boss (solo,
# personal trial: name, hp, power, question tier), the model id of its boss,
# and THREE encounter tiers — shallow / mid / deep — so the realm plays like
# a dungeon: the further from the pass, the worse what finds you.
# Encounter rows: (pack name, unit name, unit hp, unit power, model id)
REGION_POOL = {
    "autumn": {
        "name": "The Amber Vale", "mode": "foot",
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
            [("Frost Wolves", "Frost Wolf", 2, 1, "wolf_frost"),
             ("Rime Harpies", "Rime Harpy", 1, 1, "harpy"),
             ("Snow Foxes", "Snow Fox", 1, 1, "fox")],
            [("Ice Wraiths", "Ice Wraith", 2, 2, "wraith"),
             ("Floe Stalkers", "Floe Stalker", 3, 2, "stalker"),
             ("Berg Crabs", "Berg Crab", 3, 2, "crab")],
            [("Glacier Golems", "Glacier Golem", 4, 2, "golem"),
             ("The Pale Court", "Pale Wraith", 3, 3, "wraith"),
             ("Frostfang Alphas", "Frostfang Alpha", 5, 2, "wolf_frost")],
        ],
    },
    "desert": {
        "name": "The Bleached Reach", "mode": "foot",
        "boss": ("The Sphinx", 12, 2, 3), "boss_model": "sphinx",
        "tiers": [
            [("Sand Raiders", "Sand Raider", 2, 1, "raider"),
             ("Bone Vultures", "Bone Vulture", 1, 1, "vulture"),
             ("Salt Jackals", "Salt Jackal", 1, 1, "jackal")],
            [("Glass Scorpions", "Glass Scorpion", 3, 2, "scorpion"),
             ("Mirage Dancers", "Mirage Dancer", 2, 2, "wraith"),
             ("Dust Serpents", "Dust Serpent", 3, 2, "serpent_dust")],
            [("Tomb Sentinels", "Tomb Sentinel", 4, 2, "golem_tomb"),
             ("The Bleached Choir", "Bleached Priest", 3, 3, "shade"),
             ("Dune Scourges", "Dune Scourge", 5, 2, "scorpion")],
        ],
    },
    "jungle": {
        "name": "The Verdigris Deep", "mode": "sail",
        "boss": ("The Strangler Matriarch", 12, 2, 3), "boss_model": "matriarch",
        "tiers": [
            [("Poison Birds", "Poison Bird", 1, 1, "bird_poison"),
             ("River Drakes", "River Drake", 2, 1, "drake"),
             ("Thorn Monkeys", "Thorn Monkey", 1, 1, "monkey")],
            [("Jaguar Shades", "Jaguar Shade", 2, 2, "jaguar"),
             ("Vine Horrors", "Vine Horror", 3, 2, "briar"),
             ("Bloom Serpents", "Bloom Serpent", 3, 2, "serpent_bloom")],
            [("Canopy Tyrants", "Canopy Tyrant", 4, 2, "drake"),
             ("The Emerald Watch", "Emerald Sentinel", 3, 3, "golem_jade"),
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
    # bronze constructs of the old myths — rare, imposing outer-water guardians
    # (both are boss-scale models, so they loom like a mini-boss when they rise)
    ("The Bronze Colossus", "Bronze Colossus", 5, 2, "colossus"),
    ("Bronze Sentinels", "Bronze Sentinel", 4, 2, "warden"),
]

def region_model_ids(region: str | None) -> list[str]:
    """Every monster GLB id that CAN rise in a region — the pack units across
    all three depth tiers plus its boss — so the client can preload the whole
    set the moment it enters the realm and never stall spawning a fresh beast.
    A None/unknown region is the open sea: the hub's random-encounter pool."""
    ids: set[str] = set()
    info = REGION_POOL.get(region) if region else None
    if info:
        for tier in info["tiers"]:
            for row in tier:
                ids.add(row[4])            # (name, unit, hp, power, MODEL)
        ids.add(info["boss_model"])
    else:
        for row in ENCOUNTERS_LIGHT + ENCOUNTERS_HEAVY:
            ids.add(row[4])
    return sorted(ids)


# region key → model ids, precomputed once. "hub" is the open-water encounter
# pool; the Pharos Warden guards the endgame everywhere.
REGION_MODELS = {**{r: region_model_ids(r) for r in REGION_POOL},
                 "hub": sorted(set(region_model_ids(None)) | {"warden"})}

REGIONS_PER_GAME = 4       # passes through the mountains, one realm beyond each
RELICS_TO_WIN = 3          # sigil fragments needed to open the Pharos
SHRINE_CHARGES = 2

# radial layout: ring radii (world units) and islands per ring.
# Distances are tuned for the d3: every lane is a single open-sea hop, so a
# neighbouring island is 2 exact steps away and the loops do the steering.
_RING_R = [150.0, 265.0, 380.0]
_HOME_R = 70.0                # Home Port, just south of the Pharos
WALL_R = 490.0                # the mountain wall that seals the Isles of Peace
_WAYPOINT_EVERY = 60.0        # aim for a sea node roughly every N world units
_MAX_WAYPOINTS = 3            # per HUB lane — ring-3 arcs run past 330 wu; one
                              # waypoint left 140+ wu hops that sailed forever
_WAYPOINT_EVERY_REALM = 42.0  # realms are finer-grained: a real crawl
_MAX_WAYPOINTS_REALM = 2      # per REALM lane
_SEA_LOOKS = ["buoy", "buoy", "buoy", "rocks", "rocks", "islet", "islet", "none"]
_FLOTSAM_CHANCE = 0.25        # open-water nodes that drift a scroll's worth of salvage
# approximate rendered island radii, so lane waypoints stay off the coasts
_NODE_CLEAR = {"home": 17.0, "lair": 18.0, "pharos": 22.0, "monster": 15.0,
               "haven": 15.0, "shrine": 13.0, "shop": 13.0, "puzzle": 13.0,
               "gate": 9.0}
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
        self.sword_node: str | None = None   # hidden islet holding the Sword of Damocles
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
        self.nodes["pharos"]["monster"] = self._boss(WARDEN, rng, WARDEN_MODEL)

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
        self._declip_lanes()
        self._place_sword(rng)

    def _grow_region(self, gi: int, theme: str, ang: float, rings, names, rng):
        """A pass through the mountain wall, then ONE MAIN ROAD to the boss —
        with teeth on the side:

          · The MAIN ROAD — a long arc of stops: quiet water, weak packs, a
            shrine. The spine every captain can walk.
          · The SHORTCUT — branches off the main road early and rejoins at the
            junction: far fewer stops, but every one an elite hunting ground
            in deep water. Risk it to shave turns.
          · The HAVEN LOOP — a short side-loop that leaves the main road and
            rejoins it one stop later, carrying a GUARANTEED haven checkpoint.
            Because it sits on a loop, an exact roll can always be tuned to
            land there — no more 'can't roll the checkpoint'.

        The desert is just as LONG but much simpler — one near-straight
        trail with a single elite fork and the haven bypass — and it is
        crossed on foot.

        THE AMBER VALE IS BARE GROUND: it is being redesigned from scratch,
        so only its pass is generated — the realm beyond holds no trail, no
        packs, no haven, no altar. The stage still renders its amber forest;
        content returns with the rebuild."""
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

        if theme == "autumn":
            # The Vale's interior is grown LATER, per captain, once the fleet
            # is known — see grow_vale(). Only the pass exists on the chart.
            self.vale_gate = gate_id
            return

        def place(nid, radius, a, depth):
            node = {"id": nid, "name": trail, "type": "sea", "band": 4,
                    "region": theme, "depth": depth, "mode": mode,
                    "x": round(math.cos(a) * radius, 2),
                    "z": round(math.sin(a) * radius, 2),
                    "flotsam": rng.random() < _FLOTSAM_CHANCE,
                    "look": rng.choice(_SEA_LOOKS)}
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

        # ── the boss altar, at the radial far end ────────────────────────────
        # The whole realm is packed TIGHT — stops a short hop apart, nothing
        # but themed wilds between them (waypoint count per lane is fixed, so
        # the road is the same number of turns as the old sprawling layout).
        lair_id = f"r{gi}_L"
        lair = place(lair_id, R0 + 385, ang + rng.uniform(-0.02, 0.02), 9)
        lair.pop("look", None)
        lair["type"] = "lair"
        lair["name"] = info["name"]
        lair["boss_spec"] = list(info["boss"])
        lair["monster"] = None
        lair["defeated"] = []
        lair["stash"] = []

        # a junction node both roads share, just before the altar
        junc_id = f"r{gi}_j"
        place(junc_id, R0 + 330, ang + rng.uniform(-0.02, 0.02), 8)

        # ── the FINAL APPROACH: one straight lane to the altar ──────────────
        # No ring, no loop: the movement rule lets ANY roll end on a lair it
        # can reach, so the boss door needs no exact-count machinery at all.
        self._link(junc_id, lair_id)

        def make_haven(node):
            node["type"] = "haven"
            node["name"] = names.pop()
            node.pop("look", None)

        def make_shrine(node):
            node["type"] = "shrine"
            node["name"] = names.pop()
            node["domain"] = rng.choice(DOMAINS)
            node["charges"] = SHRINE_CHARGES
            node["tier"] = 2
            node.pop("look", None)

        side = rng.choice([-1, 1])
        simple = mode == "foot" and theme == "desert"

        # ── the MAIN ROAD: a LONG arc of stops bowing out to one side ────────
        # Every realm is a proper trek now — eight stops thick with POIs. The
        # desert keeps the same length but stays SIMPLE: one elite fork and one
        # haven detour. The checkpoint NEVER sits on the through-road — it lives
        # out on the detour, so the two arms are a real choice.
        plan = (["weak", "sea", "weak", "sea", "weak", "sea", "shrine", "weak", "weak"]
                if simple else
                ["sea", "weak", "sea", "shrine", "sea", "weak", "sea", "weak"])
        main = [gate_id]
        n = len(plan)
        loop_a = loop_b = None                 # where the haven loop hangs
        sphinx_seas = 2                        # main-road Sphinx gates (a third is
        #                                       GUARANTEED at the junction below)
        for i, kind in enumerate(plan):
            t = (i + 1) / (n + 1)
            # the first isle sits WELL past the arch: sailing in means a real
            # stretch of open wilds before anything meets you
            radius = R0 + 80 + t * (330 - 88)
            bow = 0.13 if simple else 0.34
            a = ang + side * bow * math.sin(math.pi * t)      # bow out, then back
            depth = 1 + (i * 3) // n                          # 1 … 3 up the spine
            nid = f"r{gi}_m{i}"
            node = place(nid, radius, a, depth)
            if kind == "weak":
                make_monster(node, elite=False, depth=min(2, depth))
            elif kind == "haven":
                make_haven(node)
            elif kind == "shrine":
                make_shrine(node)
            elif kind == "sea" and simple and sphinx_seas > 0:
                # the desert's Sphinx gates: she BARS the path here (an unanswered
                # gate halts the sail, so she can't be skipped), one riddle apiece.
                node["sphinx"] = True
                sphinx_seas -= 1
            main.append(nid)
            # the haven detour hangs off a mid-road span in BOTH layouts: the
            # through-road runs loop_a → (one plain stop) → loop_b, and the
            # detour arm loop_a → v0(haven) → v1 → loop_b runs alongside it,
            # one hop longer. Roughly equal — you take the long arm to bank the
            # checkpoint, the short arm to save the turn.
            if i == 3:
                loop_a = nid                                  # loop leaves here
            elif i == (5 if simple else 4):
                loop_b = nid                                  # …and rejoins here
        main.append(junc_id)
        for u, v in zip(main, main[1:]):
            self._link(u, v)
        # the GUARANTEED Sphinx: the junction is the ONE gateway to the boss
        # altar (its only link to the lair), so every route — main road, haven
        # detour, or the elite shortcut — must face her here. At least one gate,
        # no matter the path; up to three if you take the long main road.
        if simple:
            self.nodes[junc_id]["sphinx"] = True

        # ── the HAVEN LOOP: the checkpoint sits OUT ON THE DETOUR ────────────
        # loop_a and loop_b are already joined through the main road; this arm
        # bulges away from the road's bow and carries the haven plus one more
        # stop, so it is a genuine two-isle side-track (never a lone cairn).
        v0, v1 = f"r{gi}_v0", f"r{gi}_v1"
        la, lb = self.nodes[loop_a], self.nodes[loop_b]
        ra = math.hypot(la["x"], la["z"])
        rb = math.hypot(lb["x"], lb["z"])
        aa = math.atan2(la["z"], la["x"])
        ab = math.atan2(lb["z"], lb["x"])
        bulge = 26 if simple else 13
        make_haven(place(v0, ra + bulge, aa - side * 0.15, 1))
        place(v1, rb + bulge, ab - side * 0.11, 1)
        self._link(loop_a, v0)
        self._link(v0, v1)
        self._link(v1, loop_b)

        # ── the SHORTCUT: fewer stops, elite grounds, rejoins at the junction ─
        # Always a TWO-isle fork so it never strands a single lone island out on
        # a side. On the sail realms both stops are elite hunting grounds; the
        # desert keeps its promised SINGLE elite (only the deep end bites) with a
        # quiet dune stop leading in.
        branch = main[1]                       # leaves the road at the first stop
        count = 2
        prev = branch
        for i in range(count):
            nid = f"r{gi}_s{i}"
            t = (i + 1) / (count + 1)
            radius = R0 + 70 + t * (330 - 95)
            a = ang - side * 0.19 * math.sin(math.pi * t)     # hugs the far side
            node = place(nid, radius, a, 5 + i)
            if not simple or i == count - 1:
                make_monster(node, elite=True, depth=5 + i)
            self._link(prev, nid)
            prev = nid
        self._link(prev, junc_id)

    # ── the Amber Vale: a private labyrinth per captain ──────────────────────
    VALE_NAMES = ["Bracken Hollow", "Foxglove Dell", "Eldergrove", "Stagmark",
                  "Rootway Cross", "Lantern Glade", "Whisper Thicket",
                  "Hartsfoot Rise", "Cindershade", "Mistling Hollow"]

    def grow_vale(self, pids: list[str]) -> dict[str, str]:
        """Grow the ONE shared Amber Vale labyrinth beyond the pass — called
        once when the voyage launches. Returns {pid: lair node id} (every
        captain shares the same barrow) so the engine can seed the beacon.

        THE VALE IS THE SAME FOR EVERYONE now: a single maze in the wedge,
        fully visible to all (no per-captain ownership, no fog) — so the
        spectator camera can follow a rival through it. Design rules, tuned
        for the d3:

          · LOOPS, NOT DEAD ENDS — three arc-roads crossed by staggered
            radial links, so a wrong turn is the long way round, never a
            wall. The couple of true dead ends both PAY (a cache, a
            shrine), so "lost" is a detour, never a waste.
          · the barrow sits at the far end behind two doors: one short
            and elite-guarded, one the long quiet way round.
          · fog is VISION, not movement — movement stays exact-roll
            sail; the engine reveals the woods lantern-radius by
            lantern-radius as you walk them."""
        gate_id = self.vale_gate
        gn = self.nodes[gate_id]
        ang = gn["gate_angle"]
        R0 = WALL_R + 10
        info = REGION_POOL["autumn"]
        lairs: dict[str, str] = {}
        lair_id = None
        for pi, pid in enumerate(pids[:1]):     # ONE shared maze for the whole fleet
            rng = random.Random(self.rng.randrange(2**31))
            names = self.VALE_NAMES[:]
            rng.shuffle(names)

            def put(nid, radius, a, depth, **extra):
                # no ``owner``: the Vale is shared and fully public now
                node = {"id": nid, "name": "Forest Trail", "type": "sea",
                        "band": 4, "region": "autumn", "mode": "foot",
                        "depth": depth, "look": "none",
                        "x": round(math.cos(a) * radius, 2),
                        "z": round(math.sin(a) * radius, 2),
                        "flotsam": rng.random() < 0.15}
                node.update(extra)
                self.nodes[nid] = node
                return node

            def adelta(a, b):        # wrapped angle difference, safe at ±π
                return math.atan2(math.sin(a - b), math.cos(a - b))

            def mid_of(a_id, b_id, k, depth, bow=0.0):
                """A waypoint between two stops (radial links are two hops)."""
                na, nb = self.nodes[a_id], self.nodes[b_id]
                r = (math.hypot(na["x"], na["z"]) + math.hypot(nb["x"], nb["z"])) / 2
                aa = math.atan2(na["z"], na["x"])
                ab = math.atan2(nb["z"], nb["x"])
                am = aa + adelta(ab, aa) / 2 + bow
                node = put(k, r, am, depth)
                self._link(a_id, k)
                self._link(k, b_id)
                return node

            # ── FOUR arc-roads across the wedge, offset counts so the way
            #    through zigzags the deep way; every arc is a chain you can
            #    run along. A long labyrinth: the barrow sits far out past the
            #    last road, so even the short way is a real trek. ──
            counts = [4, 5, 5, 4]
            radii = [R0 + 80, R0 + 172, R0 + 264, R0 + 356]
            span = 0.66
            arcs: list[list[str]] = []
            for ai, (cnt, rad) in enumerate(zip(counts, radii)):
                row = []
                for k in range(cnt):
                    a = ang + span * ((k + 0.5) / cnt - 0.5) + rng.uniform(-0.02, 0.02)
                    nid = f"av{pi}_a{ai}_{k}"
                    put(nid, rad + rng.uniform(-10, 10), a, ai + 1)
                    row.append(nid)
                for u, v in zip(row, row[1:]):
                    self._link(u, v)
                arcs.append(row)

            # the pass opens on a FORK: two ways into the first arc
            mouth = sorted(arcs[0], key=lambda n: abs(adelta(math.atan2(
                self.nodes[n]["z"], self.nodes[n]["x"]), ang)))[:2]
            for mi, m in enumerate(mouth):
                mid_of(gate_id, m, f"av{pi}_g{mi}", 1,
                       bow=rng.uniform(0.03, 0.06) * (1 if mi == 0 else -1))

            # staggered radial links between every pair of arcs (each carries
            # one waypoint) — offset indices so no straight shot lines up, and
            # only two crossings per gap so a wrong turn is the long way round
            for gap in range(len(arcs) - 1):
                a_row, b_row = arcs[gap], arcs[gap + 1]
                picks = rng.sample(range(len(a_row)), 2)
                for li, ak in enumerate(picks):
                    shift = (1 if (ak + li) % 2 == 0 else -1)
                    bk = max(0, min(len(b_row) - 1, ak + shift))
                    mid_of(a_row[ak], b_row[bk], f"av{pi}_r{gap}_{li}",
                           gap + 2, bow=rng.uniform(-0.04, 0.04))

            # ── the paying dead ends: a hidden HOARD and a hidden shrine.
            #    A dead end costs an exact roll in and a full turn back out,
            #    so its pay is a real trove (3 scrolls), not loose flotsam ──
            cache_host = rng.choice(arcs[1])
            hn = self.nodes[cache_host]
            ha = math.atan2(hn["z"], hn["x"])
            side = rng.choice([-1, 1])
            cache = put(f"av{pi}_c", math.hypot(hn["x"], hn["z"]) + rng.uniform(18, 26),
                        ha + side * 0.11, 2, cache=True, flotsam=False)
            self._link(cache_host, cache["id"])
            shrine_host = rng.choice(arcs[0] + arcs[-1])
            sn = self.nodes[shrine_host]
            sa = math.atan2(sn["z"], sn["x"])
            shrine = put(f"av{pi}_s", math.hypot(sn["x"], sn["z"]) + rng.uniform(-24, -16),
                         sa - side * 0.12, 2)
            shrine.pop("flotsam", None)
            shrine.pop("look", None)
            shrine["type"] = "shrine"
            shrine["name"] = names.pop()
            shrine["domain"] = rng.choice(DOMAINS)
            shrine["charges"] = SHRINE_CHARGES
            shrine["tier"] = 2
            self._link(shrine_host, shrine["id"])

            # a haven ON a middle road — the checkpoint sits on a loop, so
            # an exact roll can always be tuned to land there
            haven_id = rng.choice(arcs[len(arcs) // 2])
            hv = self.nodes[haven_id]
            hv["type"] = "haven"
            hv["name"] = names.pop()
            hv.pop("flotsam", None)
            hv.pop("look", None)

            # a few avoidable weak packs strung along the way through
            for host, depth in ((rng.choice(arcs[1]), 2),
                                (rng.choice(arcs[2]), 3),
                                (rng.choice(arcs[3]), 4)):
                node = self.nodes[host]
                if node["type"] != "sea":
                    continue
                node["type"] = "monster"
                node["monster"] = None
                node["encounter"] = True
                node["elite"] = False
                node["depth"] = depth
                node["name"] = names.pop()
                node.pop("flotsam", None)
                node.pop("look", None)

            # ── safety nets: no accidental walls, no orphaned stops ──
            mine = [nid for nid, n in self.nodes.items()
                    if n.get("region") == "autumn" and nid != gate_id]
            spurs = {cache["id"], shrine["id"]}
            self._build_neighbors()
            for nid in mine:
                if nid in spurs or len(self.neighbors[nid]) >= 2:
                    continue
                near = min((o for o in mine if o != nid
                            and o not in self.neighbors[nid]),
                           key=lambda o: self._dist(nid, o), default=None)
                if near:
                    self._link(nid, near)
            reach = {gate_id}
            frontier = [gate_id]
            allowed = set(mine) | {gate_id}
            self._build_neighbors()
            while frontier:
                cur = frontier.pop()
                for nb in self.neighbors[cur]:
                    if nb in allowed and nb not in reach:
                        reach.add(nb)
                        frontier.append(nb)
            for nid in mine:
                if nid not in reach:
                    near = min((o for o in reach if o != gate_id),
                               key=lambda o: self._dist(nid, o))
                    self._link(nid, near)
                    reach.add(nid)

            # ── the barrow LAST, behind TWO doors: a SHORT elite-guarded
            #    march from the arc stop closest (by hops) to the pass, or
            #    the LONG quiet way from the farthest — measured on the
            #    FINISHED trail graph (safety links included), so the
            #    "race the guard or plod around" tradeoff is real ──
            lair_id = f"av{pi}_L"
            lair = put(lair_id, R0 + 438, ang + rng.uniform(-0.05, 0.05), 6)
            lair.pop("flotsam", None)
            lair.pop("look", None)
            lair["type"] = "lair"
            lair["name"] = info["name"]
            lair["boss_spec"] = list(info["boss"])
            lair["monster"] = None
            lair["defeated"] = []
            lair["stash"] = []
            self._build_neighbors()
            hops = {gate_id: 0}
            frontier = [gate_id]
            while frontier:
                cur = frontier.pop(0)
                for nb in self.neighbors[cur]:
                    if nb not in hops and self.nodes[nb].get("region") == "autumn":
                        hops[nb] = hops[cur] + 1
                        frontier.append(nb)
            # doors hang off the OUTERMOST arc and prefer QUIET hosts: pinning
            # the guarded door to a hunting-ground stop would stack two fights
            # on one road
            hosts = ([n for n in arcs[-1] if self.nodes[n]["type"] == "sea"]
                     or arcs[-1])
            by_hops = sorted(hosts, key=lambda n: hops.get(n, 99))
            fast = mid_of(by_hops[0], lair_id, f"av{pi}_d0", 7,
                          bow=rng.uniform(0.05, 0.09))   # never dead-straight
            fast["type"] = "monster"
            fast["monster"] = None
            fast["encounter"] = True
            fast["elite"] = True
            fast["name"] = names.pop()
            fast.pop("flotsam", None)
            fast.pop("look", None)
            mid_of(by_hops[-1], lair_id, f"av{pi}_d1", 6,
                   bow=rng.uniform(0.05, 0.09))
            self._spread_vale_forks()
        self._build_neighbors()
        # every captain shares the one barrow (a personal trial on a shared node)
        lairs = {pid: lair_id for pid in pids} if lair_id else {}
        self.vale_lairs = lairs
        return lairs

    # trails leaving one stop must be readable as SEPARATE roads: with the
    # one-arrow wayfinder, two branches under ~30° apart draw overlapping
    # arrows and make every tap ambiguous. Rotate the flexible endpoint
    # (link waypoints and spur tips — never the structural arc stops) away
    # around the fork until every pair of outgoing trails clears MIN_SEP.
    _VALE_MIN_SEP = 0.55            # rad ≈ 31°

    def _spread_vale_forks(self) -> None:
        self._build_neighbors()

        def adelta(a, b):
            return math.atan2(math.sin(a - b), math.cos(a - b))

        def movable(nid):
            # anything that isn't structural may bend: mouth/radial waypoints,
            # doors, the cache and shrine spurs. Arc stops and the lair are
            # the maze's skeleton and stay put.
            n = self.nodes[nid]
            if n.get("region") != "autumn" or nid == self.vale_gate:
                return False
            tag = nid.split("_", 1)[1] if "_" in nid else ""
            return not tag.startswith("a") and not tag.startswith("L")

        def rotate(fork, nid, by):
            t = self.nodes[nid]
            a = math.atan2(t["z"] - fork["z"], t["x"] - fork["x"]) + by
            r = math.hypot(t["x"] - fork["x"], t["z"] - fork["z"])
            t["x"] = round(fork["x"] + math.cos(a) * r, 2)
            t["z"] = round(fork["z"] + math.sin(a) * r, 2)

        def bow_out(nid, away_from, fork, need):
            """A two-link waypoint caught lying along another trail: push it
            PERPENDICULAR to its own chord — widening its angle at BOTH
            endpoints at once, where rotating around one fork just
            ping-pongs it between the two. Always DEEPEN the bow it already
            has (monotone → the relaxation can't oscillate); only a
            dead-flat waypoint picks its side by fleeing the offender."""
            w = self.nodes[nid]
            ea, eb = self.neighbors[nid][:2]
            pa, pb = self.nodes[ea], self.nodes[eb]
            cx, cz = pb["x"] - pa["x"], pb["z"] - pa["z"]
            cl = math.hypot(cx, cz) or 1e-6
            px, pz = -cz / cl, cx / cl
            off = (w["x"] - pa["x"]) * px + (w["z"] - pa["z"]) * pz
            if abs(off) > 0.5:
                s = 1.0 if off > 0 else -1.0      # deepen the existing bow
            else:
                o = self.nodes[away_from]
                oside = (o["x"] - w["x"]) * px + (o["z"] - w["z"]) * pz
                s = -1.0 if oside > 0 else 1.0
            # step sized to the deficit AT THIS DISTANCE: a long mouth trail
            # needs a far bigger sideways push for the same angular gain
            df = math.hypot(w["x"] - fork["x"], w["z"] - fork["z"])
            step = min(48.0, max(9.0, need * df * 1.1))
            w["x"] = round(w["x"] + px * s * step, 2)
            w["z"] = round(w["z"] + pz * s * step, 2)

        # Deterministic, terminating: every movable trail is placed at most
        # ONCE (then frozen), fork by fork — the gate's mouth fork first,
        # since that's the first fork every captain meets. A violating pair
        # rotates its unfrozen movable member to exactly MIN_SEP × 1.08 from
        # its twin. No iteration on moved nodes → no oscillation, and a
        # single bounded rotation can never fold a trail into a hairpin.
        frozen: set[str] = set()          # each node is placed at most once
        forks = [self.vale_gate] + sorted(
            nid for nid, n in self.nodes.items()
            if n.get("region") == "autumn" and nid != self.vale_gate)
        for _round in range(3):
            acted = False
            for nid in forks:
                nbrs = self.neighbors.get(nid, [])
                if len(nbrs) < 2:
                    continue
                n = self.nodes[nid]
                ranked = sorted(
                    (math.atan2(self.nodes[b]["z"] - n["z"],
                                self.nodes[b]["x"] - n["x"]), b)
                    for b in nbrs)
                for k in range(len(ranked)):
                    a1, n1 = ranked[k]
                    a2, n2 = ranked[(k + 1) % len(ranked)]
                    gap = (a2 - a1) % (2 * math.pi)
                    if gap >= self._VALE_MIN_SEP:
                        continue
                    pick = [(x, ax, ox) for x, ax, ox in
                            ((n2, a2, a1), (n1, a1, a2))
                            if movable(x) and x not in frozen]
                    if not pick:
                        continue
                    tgt, ta, oa = pick[0]
                    s = 1.0 if adelta(ta, oa) >= 0 else -1.0
                    want = oa + s * self._VALE_MIN_SEP * 1.08
                    rotate(n, tgt, adelta(want, ta))
                    frozen.add(tgt)
                    acted = True
            if not acted:
                break

    def _insert_waypoints(self, rng):
        """Split every island-to-island edge into a chain of open-sea nodes,
        so distance is measured in real sailing turns."""
        island_edges = self.edges[:]
        self.edges = []
        wp = 0
        for a, b in island_edges:
            length = self._dist(a, b)
            na, nb = self.nodes[a], self.nodes[b]
            desert_lane = (na.get("region") == "desert"
                           and nb.get("region") == "desert")
            # Realm lanes get MORE waypoints so a d3 only nudges you a spot or
            # two through the wilds — the trial is a careful crawl, not a
            # sprint. The Bleached Reach stays SPARSE: cairns far apart on the sand.
            if desert_lane:
                n_way = 1
            elif na.get("region") and nb.get("region"):
                n_way = min(_MAX_WAYPOINTS_REALM,
                            max(2, round(length / _WAYPOINT_EVERY_REALM) - 1))
            else:
                n_way = min(_MAX_WAYPOINTS, max(1, round(length / _WAYPOINT_EVERY) - 1))
                # …but NEVER leave a hop past ~90 wu, however long the lane —
                # the chase camera turns those into featureless open-water
                # dollies. Only the very longest ring-3 arcs exceed the cap.
                n_way = max(n_way, math.ceil(length / 90.0) - 1)
            # keep waypoints OFF the coasts: reserve each island's visual
            # footprint at both ends of the lane, distribute between them
            ca = _NODE_CLEAR.get(na["type"], 4.0)
            cb = _NODE_CLEAR.get(nb["type"], 4.0)
            lo = min(0.45, ca / max(length, 1e-6) + 0.04)
            # on lanes shorter than the far island's footprint the waypoints
            # bunch near the START coast rather than landing on the island
            hi = max(lo + 0.08, 1 - cb / max(length, 1e-6) - 0.04)
            # once the coasts are reserved, short lanes may have almost no
            # open water left — cramming the quota in anyway stacked buoys
            # 4 wu apart (a "sail" that reads as a twitch). Thin the count
            # until every hop on the lane gets ≥ ~10 wu of water. (The Vale
            # never passes through here — its maze builds its own trails.)
            usable = (hi - lo) * length
            n_way = min(n_way, max(0, int(usable / 10.0) - 1))
            chain = [a]
            for k in range(1, n_way + 1):
                t = lo + (hi - lo) * (k / (n_way + 1))
                # perpendicular jitter so routes curve like real currents
                px, pz = -(nb["z"] - na["z"]), (nb["x"] - na["x"])
                plen = max(1e-6, (px * px + pz * pz) ** 0.5)
                # tighter lanes wander less — realm roads are packed close now
                amp = 6.0 if (na.get("region") and nb.get("region")) else 10.0
                jit = rng.uniform(-amp, amp)
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
                # the approach from the Isles of Peace to a pass is still Aegean.
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

    def _place_sword(self, rng):
        """Drop the Sword of Damocles islet into open water in the safe Isles of
        Peace, AFTER every lane waypoint exists, so it never overlaps another
        stop. Linked to the nearest node as a short detour hop; unmarked among
        the scenery until the trader's map circles it."""
        best = None
        for _ in range(200):
            ang = rng.uniform(0, 6.28318)
            rad = rng.uniform(280, 355)            # inside ring 3 (~380): safe waters
            sx, sz = round(math.cos(ang) * rad, 2), round(math.sin(ang) * rad, 2)
            near = min(math.hypot(sx - n["x"], sz - n["z"])
                       for n in self.nodes.values())
            if best is None or near > best[2]:
                best = (sx, sz, near)
            if near >= 24:
                break
        sx, sz, _ = best
        anchor = min((nid for nid in self.nodes),
                     key=lambda nid: math.hypot(sx - self.nodes[nid]["x"],
                                                sz - self.nodes[nid]["z"]))
        self.nodes["sword_isle"] = {
            "id": "sword_isle", "name": "Uncharted Islet", "type": "sea",
            "band": self.nodes[anchor]["band"], "x": sx, "z": sz,
            "look": "islet", "sword": True,
            "monster": self._sword_guardians(rng)}    # a four-front ambush guards it
        self._link("sword_isle", anchor)
        self.sword_node = "sword_isle"
        self._build_neighbors()

    def _sword_guardians(self, rng):
        """Three region-bosses stand guard over the Sword of Damocles — the
        Boreal Wyrm (ice), the Strangler Matriarch (jungle) and the Stag King
        (autumn) — but WEAKENED for the trial: each at 5 health with a depleted
        bite (power 1). Marked a ``pack`` so the engine treats it as a plain
        three-front fight (named cards, own low damage), not a boss battle."""
        enemies = []
        for region in ("ice", "jungle", "autumn"):
            name, _hp, _power, _tier = REGION_POOL[region]["boss"]
            enemies.append({"name": name, "hp": 5, "max_hp": 5,
                            "power": 1, "model": REGION_POOL[region]["boss_model"]})
        return {"name": "The Sword's Guardians", "tier": 3, "model": None,
                "domain": rng.choice(DOMAINS), "pack": True, "enemies": enemies}

    def _declip_lanes(self):
        """No lane may cross a third island's footprint — the ship (and the
        lane's buoys) would cut straight through its terrain. Two passes:
        shoo sea waypoints out of every island's clearance disc, then bend
        any island-to-island lane that still crosses one by dropping a bend
        buoy at the closest approach, pushed off the coast. The Amber Vale
        is left untouched: its serpentine trail is designed geometry."""
        def clear_r(n):
            return _NODE_CLEAR.get(n["type"], 0.0)

        def in_vale(n):
            return n.get("region") == "autumn"

        islands = [n for n in self.nodes.values() if clear_r(n) > 0]

        for _ in range(3):                      # repulsion can cascade a little
            moved = False
            for n in self.nodes.values():
                if n["type"] != "sea" or in_vale(n):
                    continue
                for isl in islands:
                    need = clear_r(isl) + 2.0
                    dx, dz = n["x"] - isl["x"], n["z"] - isl["z"]
                    d = math.hypot(dx, dz)
                    if d >= need:
                        continue
                    if d < 1e-6:
                        dx, dz, d = 1.0, 0.0, 1.0
                    n["x"] = round(isl["x"] + dx / d * need, 2)
                    n["z"] = round(isl["z"] + dz / d * need, 2)
                    moved = True
            if not moved:
                break

        bends = 0
        for _round in range(4):     # a bend's own halves can still cross
            dirty = False
            for a, b in self.edges[:]:
                na, nb = self.nodes[a], self.nodes[b]
                if in_vale(na) or in_vale(nb):
                    continue
                for isl in islands:
                    if isl["id"] in (a, b):
                        continue
                    need = clear_r(isl) + 1.0
                    ax, az, bx, bz = na["x"], na["z"], nb["x"], nb["z"]
                    dx, dz = bx - ax, bz - az
                    L2 = dx * dx + dz * dz
                    if L2 < 1e-9:
                        continue
                    t = max(0.0, min(1.0, ((isl["x"] - ax) * dx
                                           + (isl["z"] - az) * dz) / L2))
                    px, pz = ax + t * dx, az + t * dz
                    d = math.hypot(px - isl["x"], pz - isl["z"])
                    if d >= need or t in (0.0, 1.0):
                        continue
                    ox, oz = px - isl["x"], pz - isl["z"]
                    if d < 1e-6:
                        ox, oz, d = -dz, dx, math.hypot(dz, dx)
                    push = clear_r(isl) + 3.0
                    nid = f"seab{bends}"
                    bends += 1
                    self.nodes[nid] = {
                        "id": nid, "name": na["name"] if na["type"] == "sea"
                        else "Open Sea", "type": "sea",
                        "band": max(na["band"], nb["band"]),
                        "x": round(isl["x"] + ox / d * push, 2),
                        "z": round(isl["z"] + oz / d * push, 2),
                        "flotsam": False, "look": "buoy",
                    }
                    for k in ("region", "mode", "depth"):
                        if na.get(k) is not None and na.get(k) == nb.get(k):
                            self.nodes[nid][k] = na[k]
                    self.edges.remove((a, b))
                    self._link(a, nid)
                    self._link(nid, b)
                    dirty = True
                    break                        # this edge is gone; next edge
            if not dirty:
                break
        if bends:
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
        self.nodes["pharos"]["monster"] = self._boss(WARDEN, self.rng, WARDEN_MODEL)

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

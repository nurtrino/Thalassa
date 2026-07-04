"""
Thalassa rules engine — the Race to the Pharos. Pure state machine.

The server owns dice RNG, question fetching, and timers; this module owns
the rules. Every mutation either succeeds or raises GameError.

The voyage: the Isles of Peace ringed by a storm wall, the Pharos blazing at
the center, four storm gates leading to wild themed regions. Earn scrolls
and charms in the hub, then brave a region's spine to face its BOSS — a
personal trial; beat it once and it stays beaten for you. Its sigil
fragment must be HAULED home: shipwreck and it drifts back to the altar
(reclaim by landing — no refight). Bank RELICS_TO_WIN fragments and the
Pharos opens: defeat the Warden inside and the game is yours.

Phases:
    lobby → roll → sail → (shrine | haven | shop | battle | question …) → reveal
                                     battle: stance → question → reveal → stance…
    puzzle success → upgrade_pick.   finished when someone takes the Pharos.

Movement is EXACT: the die is how far you sail, no fewer — the chart's
loops are how you tune where you land. Live trial guardians and the Pharos
cannot be sailed through; the Pharos admits only captains with
RELICS_TO_WIN banked seals.

Battles are stance, target, trivia:
    STRIKE  tier-I/II question → 1 damage      miss → the front enemy hits
    MAGIC   tier-III question  → 3 damage      miss → 1 backfire self-damage
    GUARD   tier-I question    → riposte: read the blow, turn it aside AND
            drive it back on the attacker for its own power (2x on a heavy)
    FLEE    2 scrolls, 50/50: slip away clean, or take a free hit (no
            retreat from a trial or the Warden)

BOSSES fight like bosses: they counter EVERY exchange (a correct answer no
longer slips you out of reach), every HEAVY_EVERY-th blow is a telegraphed
heavy for double damage — guard it or eat it — and at half strength they
ENRAGE for +1 power. Beating one takes preparation: hull fittings, planks,
aegis charms, and guarding the right rounds.

Scrolls are the economy: temples pay them, shops spend them — hint stones,
gale charms, pitch & planks, aegis charms, war horns, permanent ship
fittings. Health 0 = shipwreck: unbanked seals return to their lairs,
scrolls halved, respawn at your haven checkpoint.
"""
from __future__ import annotations

import random

import puzzles
from board import Board, DOMAIN_INFO, DOMAINS, REGION_POOL, RELICS_TO_WIN

# ── tunables ─────────────────────────────────────────────────────────────────
MIN_PLAYERS = 1                    # solo runs are allowed for testing
MAX_PLAYERS = 6
TIER_REWARD = {1: 1, 2: 2, 3: 3}   # scrolls for a correct shrine wager
TIER3_PENALTY = 1
MAX_HULL = 6
STRIKE_DMG = 1                     # easy question, reliable chip damage
MAGIC_DMG = 3                      # hard question, big swing
MAGIC_BACKFIRE = 1                 # a missed spell burns the caster
STREAK_AT = 3                      # correct-answer streak that pays a bonus
SIDE_REWARD = 1                    # scrolls for a correct side answer
FLEE_COST = 1                      # scrolls to gamble on escaping a battle
GALE_BONUS = 2                     # extra movement from a Gale Charm
HORN_BONUS = 2                     # extra STRIKE damage from a War Horn
PLANKS_HEAL = 3                    # Health restored by Pitch & Planks
HEAVY_EVERY = 3                    # bosses telegraph a heavy every Nth exchange
HEAVY_MULT = 2                     # ...that lands for double damage
ITEM_CAP = 2                       # max carried of each consumable charm
KRAKEN_CHANCE = 0.10               # hub crossings: odds the kraken blocks you
KRAKEN_RIDDLES = 3                 # ...and how many mind-riddles it poses
SPHINX_CHANCE = 0.35               # desert crossings: odds the Sphinx stops you

COLORS = ["#e4572e", "#2e86ab", "#f6ae2d", "#8e5572", "#33ca7f", "#6457a6"]

UPGRADES = {
    "ram":        {"name": "Bronze Ram",        "desc": "+1 STRIKE damage"},
    "hull_plates": {"name": "Oak Hull Plates",  "desc": "+2 max Health, heal 2 now"},
    "star_chart": {"name": "Star Chart",        "desc": "Roll two dice, sail the higher"},
    "sandals":    {"name": "Hermes' Sandals",   "desc": "+1 to every roll"},
    "owl":        {"name": "Owl of Athena",     "desc": "Once per battle: remove 2 wrong options"},
    "lyre":       {"name": "Lyre of Orpheus",   "desc": "Once per battle: swap the question"},
    "trident":    {"name": "Storm Trident",     "desc": "+1 MAGIC damage"},
    "aegis":      {"name": "Aegis Shard",       "desc": "First hit each battle is halved"},
}

# Legendary relics — the shipwright's back room. These are NOT in the random
# fitting pool or the puzzle-reward pool: you buy exactly the one you want,
# outright, for a hoard of scrolls. They are the deep sink a lucky run saves
# toward. Each grants a permanent upgrade (stored in the same upgrade list).
RELICS = {
    "golden_fleece": {"name": "Golden Fleece", "cost": 30,
                      "desc": "+5 max Health and a full heal, here and now"},
    "poseidon_favor": {"name": "Poseidon's Favor", "cost": 26,
                       "desc": "The sea parts for you — crossings never ambush you"},
    "titan_ram":     {"name": "Adamant Ram", "cost": 34,
                      "desc": "+2 STRIKE damage (stacks with the Bronze Ram)"},
    "oracle_eye":    {"name": "Eye of the Oracle", "cost": 28,
                      "desc": "Every battle question opens with two lies already burned"},
}

# one lookup covering ordinary fittings and legendary relics alike
ALL_UPGRADES = {**UPGRADES, **RELICS}

# market-isle stock — consumables plus the shipwright's permanent fittings.
# Prices are tuned against the d3 economy: a good shrine visit pays 1-3
# scrolls, a cleared pack pays its total hp. Survival gear (planks, aegis)
# is what boss runs are saved up for.
SHOP_ITEMS = {
    "fitting": {"name": "Ship Fitting", "cost": 7,
                "desc": "Pick one of two permanent upgrades"},
    "hint":    {"name": "Hint Stone",   "cost": 2,
                "desc": "Removes 2 wrong answers on any question"},
    "gale":    {"name": "Gale Charm",   "cost": 2,
                "desc": f"+{GALE_BONUS} on your next roll"},
    "planks":  {"name": "Pitch & Planks", "cost": 3,
                "desc": f"Patch {PLANKS_HEAL} Health, even mid-battle"},
    "aegis_charm": {"name": "Aegis Charm", "cost": 4,
                "desc": "Blocks the next damage you take"},
    "horn":    {"name": "War Horn",     "cost": 4,
                "desc": f"+{HORN_BONUS} on your next STRIKE"},
}


class GameError(Exception):
    pass


class Player:
    def __init__(self, pid: str, token: str, name: str, idx: int, is_bot: bool = False):
        self.pid = pid
        self.token = token
        self.name = name
        self.color = COLORS[idx % len(COLORS)]
        self.connected = True
        self.is_bot = is_bot
        self.reset()

    def reset(self):
        self.node = "home"
        self.prev_node = "home"
        self.checkpoint = "home"           # shipwrecks send you back here
        self.scrolls = 3                   # seed money for the first shrine misses
        self.hull = MAX_HULL
        self.max_hull = MAX_HULL
        self.cargo: list[str] = []         # sigil fragments aboard (not yet safe)
        self.banked = 0
        self.upgrades: list[str] = []
        self.items = {"hint": 0, "gale": 0, "planks": 0,
                      "aegis_charm": 0, "horn": 0}
        self.next_roll_bonus = 0           # armed Gale Charms
        self.streak = 0
        self.puzzles_solved = 0
        self.skip_turns = 0                # turns owed to the kraken

    def has(self, upgrade: str) -> bool:
        return upgrade in self.upgrades

    def public(self) -> dict:
        return {
            "pid": self.pid, "name": self.name, "color": self.color,
            "node": self.node, "scrolls": self.scrolls,
            "hull": self.hull, "max_hull": self.max_hull,
            "cargo": len(self.cargo), "banked": self.banked,
            "checkpoint": self.checkpoint,
            "upgrades": self.upgrades, "items": self.items,
            "streak": self.streak, "skip_turns": self.skip_turns,
            "connected": self.connected, "bot": self.is_bot,
        }


class Game:
    def __init__(self, code: str, seed: int | None = None):
        self.code = code
        self.rng = random.Random(seed)
        self.board = Board(self.rng.randrange(2**31))
        self.players: list[Player] = []
        self.phase = "lobby"
        self.nonce = 0
        self.turn_idx = 0
        self.die: int | None = None
        self.reachable: dict[str, int] = {}
        self.qctx: dict | None = None      # kind: shrine|battle|puzzle
        self.question: dict | None = None
        self.question_deadline: float | None = None
        self.side_answers: dict[str, int] = {}
        self.reveal: dict | None = None
        self.battle: dict | None = None    # {node, stance, used_items, first_hit_taken}
        self.minigame: dict | None = None  # {kind, island, data, limit, deadline}
        self.kraken: dict | None = None    # {node, asked} — the gauntlet's progress
        self.upgrade_offer: list[str] | None = None
        self.used_puzzles: set[int] = set()
        self.pharos_open = False
        self.winner: str | None = None
        self.log: list[str] = []

    # ── plumbing ─────────────────────────────────────────────────────────────
    def _bump(self, phase: str):
        self.phase = phase
        self.nonce += 1

    def _say(self, msg: str):
        self.log.append(msg)
        self.log = self.log[-8:]

    def player_by_pid(self, pid):
        return next((p for p in self.players if p.pid == pid), None)

    def player_by_token(self, token):
        return next((p for p in self.players if p.token == token), None)

    @property
    def current(self) -> Player:
        return self.players[self.turn_idx]

    def _require_turn(self, pid, *phases):
        if self.phase not in phases:
            raise GameError("Not the moment for that.")
        if self.current.pid != pid:
            raise GameError("Not your turn.")

    # ── movement rules ───────────────────────────────────────────────────────
    def _wall(self, p: Player, nid: str) -> bool:
        """Nodes you cannot sail THROUGH — only (maybe) end a voyage on."""
        return self.board.nodes[nid]["type"] == "pharos"

    def _can_land(self, p: Player, nid: str) -> bool:
        if self.board.nodes[nid]["type"] == "pharos":
            return self._pharos_ok(p)
        return True

    def _reachable_for(self, p: Player, steps: int) -> dict[str, int]:
        """EXACT-roll movement: the die is how far you sail — no fewer, no
        more. Walks may not double straight back (unless boxed in), so the
        chart's loops are how you tune where you land. Walls (the Pharos,
        live trial guardians) can only be the final landfall.

        MOUNTAIN PASSES HALT THE VOYAGE: any sail that reaches a gate ends
        there, whatever the die said — you make landfall at the pass and
        cross into (or out of) the realm on a later turn. Without this,
        exact rolls near the wall strand you with destinations on the far
        side of the mountains."""
        cur = {(p.node, None)}
        stops: set[str] = set()
        for step in range(steps):
            last = step == steps - 1
            nxt = set()
            for node, came in cur:
                nbrs = self.board.neighbors[node]
                fwd = [nb for nb in nbrs if nb != came] or list(nbrs)
                if not last and all(self._wall(p, nb) for nb in fwd):
                    fwd = list(nbrs)               # walled in: allowed to turn back
                for nb in fwd:
                    if self._wall(p, nb) and (not last or not self._can_land(p, nb)):
                        continue
                    if self.board.nodes[nb]["type"] == "gate":
                        stops.add(nb)              # the pass halts the voyage
                        continue
                    nxt.add((nb, node))
            cur = nxt
            if not cur:
                break
        out = {node: steps for node, _ in cur if node != p.node}
        for g in stops:
            out[g] = steps
        return out

    def _pharos_ok(self, p: Player) -> bool:
        return self.pharos_open and p.banked >= RELICS_TO_WIN

    # ── lobby ────────────────────────────────────────────────────────────────
    def add_player(self, token: str, name: str, is_bot: bool = False) -> Player:
        if self.phase != "lobby":
            raise GameError("The voyage has already begun.")
        if len(self.players) >= MAX_PLAYERS:
            raise GameError("The fleet is full (6 captains).")
        name = (name or "").strip()[:16] or f"Captain {len(self.players) + 1}"
        pid = f"p{len(self.players) + 1}_{self.rng.randrange(16**4):04x}"
        p = Player(pid, token, name, len(self.players), is_bot=is_bot)
        self.players.append(p)
        return p

    def remove_player(self, host_pid: str, pid: str):
        if not self.players or self.players[0].pid != host_pid:
            raise GameError("Only the host can do that.")
        if pid == host_pid:
            raise GameError("The host cannot kick themselves.")
        p = self.player_by_pid(pid)
        if not p:
            return
        if self.phase == "lobby":
            self.players.remove(p)
            return
        was_turn = self.current.pid == pid
        removed_idx = self.players.index(p)
        self.players.remove(p)
        if removed_idx < self.turn_idx:
            self.turn_idx -= 1
        if self.turn_idx >= len(self.players):
            self.turn_idx = 0
        if len(self.players) == 1:
            self.winner = self.players[0].pid
            self._bump("finished")
        elif was_turn:
            self._start_turn()

    def start(self, pid: str):
        if self.phase != "lobby":
            raise GameError("Already sailing.")
        if not self.players or self.players[0].pid != pid:
            raise GameError("Only the host can launch the fleet.")
        if len(self.players) < MIN_PLAYERS:
            raise GameError(f"Need at least {MIN_PLAYERS} captain(s).")
        self.turn_idx = 0
        self._start_turn()

    def _start_turn(self):
        self.die = None
        self.reachable = {}
        self.qctx = None
        self.question = None
        self.side_answers = {}
        self.reveal = None
        self.battle = None
        self.minigame = None
        self.upgrade_offer = None
        self._bump("roll")

    # ── movement ─────────────────────────────────────────────────────────────
    def roll(self, pid: str, die: int):
        self._require_turn(pid, "roll")
        p = self.current
        self.die = die
        steps = die + (1 if p.has("sandals") else 0) + p.next_roll_bonus
        if p.next_roll_bonus:
            self._say(f"🌬 A gale fills {p.name}'s sails — +{p.next_roll_bonus}.")
            p.next_roll_bonus = 0
        self.reachable = self._reachable_for(p, steps)
        if not self.reachable:
            self._say(f"{p.name} is boxed in and waits out the tide.")
            self._next_turn()
            return
        self._bump("sail")

    def sail(self, pid: str, node: str):
        self._require_turn(pid, "sail")
        if node not in self.reachable:
            raise GameError("Your ship cannot reach those waters.")
        p = self.current
        p.prev_node = p.node
        p.node = node
        self.reachable = {}
        self._land(p, node)

    # ── landing dispatch ─────────────────────────────────────────────────────
    def _land(self, p: Player, nid: str):
        node = self.board.nodes[nid]
        ntype = node["type"]
        if node["type"] == "lair":
            if p.pid in node["defeated"]:
                if p.pid in node["stash"]:
                    node["stash"].remove(p.pid)
                    p.cargo.append(node["region"])
                    self._say(f"⚱ {p.name} reclaims the fragment of {node['name']}.")
                self._next_turn()
                return
            self.board.spawn_boss(nid)
            self.battle = {"node": nid, "stance": None, "round": 0,
                           "charging": False,
                           "used_items": [], "first_hit_taken": False}
            self._say(f"👑 {node['monster']['name']} rises — {p.name}'s trial begins!")
            self._bump("battle")
            return
        monster = self.board.alive_monster(nid)

        # ── the KRAKEN: hub crossings only. One in ten sailings, it rises and
        # bars the way with a gauntlet of three mind-riddles — miss one and it
        # drags your ship in circles for a turn. Poseidon's Favor parts it.
        if (ntype == "sea" and not node.get("region") and not monster
                and not p.has("poseidon_favor")
                and self.rng.random() < KRAKEN_CHANCE):
            self.kraken = {"node": nid, "asked": 0}
            self._say(f"🐙 The KRAKEN rises before {p.name} — answer its "
                      f"{KRAKEN_RIDDLES} riddles of the mind, or lose a turn!")
            self._kraken_deal()
            return

        # Danger scales with the passage. Realm hunting grounds bite on most
        # landings (deeper = surer) and realm open water can spring a sea
        # attack too. The Isles of Peace are far calmer — but not empty: a
        # stray raider still turns up now and then in the home waters.
        if node.get("encounter") and node.get("depth"):
            chance = min(0.85, 0.45 + 0.1 * node["depth"])
        elif ntype == "sea" and node.get("depth"):
            # quieter open water: battles are meatier now (puzzles!), and the
            # roads are longer — the hunting grounds carry the realm's teeth
            chance = min(0.35, 0.12 + 0.04 * node["depth"])
        elif ntype == "sea" and not node.get("region"):
            chance = 0.12          # a rare small skirmish in the hub sea-lanes
        else:
            chance = 0.0
        if ntype == "sea" and p.has("poseidon_favor"):
            chance = 0.0           # Poseidon's Favor: the deep never rises at you
        ambush = False
        if chance and not monster and self.rng.random() < chance:
            node["monster"] = self.board.random_pack(node, self.rng)
            monster = node["monster"]
            ambush = True
            if node.get("region"):
                if ntype == "sea":
                    self._say(f"⚔ {monster['name']} rise from the deep — "
                              f"{p.name} is beset mid-crossing!")
                else:
                    self._say(f"⚔ {monster['name']} ambush {p.name} in the wilds!")
            else:
                self._say(f"⚔ {monster['name']} waylay {p.name} "
                          f"in the home waters!")
        if monster:
            self.battle = {"node": nid, "stance": None, "round": 0,
                           "charging": False, "ambush": ambush,
                           "used_items": [], "first_hit_taken": False}
            if not node.get("encounter") and not ambush and ntype != "sea":
                self._say(f"{monster['name']} bars {p.name}'s way!")
            self._bump("battle")
            return

        # ── the SPHINX: the desert's toll-keeper. She stops quiet crossings
        # with a riddle; stumble and she sweeps you a space or two back.
        if (ntype == "sea" and node.get("region") == "desert"
                and self.rng.random() < SPHINX_CHANCE):
            deal = puzzles.deal_riddle(self.rng, self.used_puzzles)
            self.minigame = {"kind": "riddle", "island": nid, "data": deal,
                             "limit": deal["limit"], "deadline": None,
                             "sphinx": True,
                             "text": deal["text"], "category": deal["category"]}
            self._say(f"🦁 The Sphinx alights on the dunes before {p.name} — "
                      f"answer her riddle or be swept back!")
            self._bump("minigame")
            return

        if ntype == "sea":
            self._next_turn()
        elif ntype == "home":
            self._bank(p)
            self._next_turn()
        elif ntype == "shrine" and node.get("charges", 0) > 0:
            self._bump("shrine")
        elif ntype == "puzzle" and not node.get("solved"):
            deal = puzzles.deal(self.rng, self.used_puzzles)
            if deal["kind"] in puzzles.INTERACTIVE:
                self.minigame = {"kind": deal["kind"], "island": nid,
                                 "data": deal, "limit": deal["limit"],
                                 "deadline": None}
                self._bump("minigame")
            else:
                self.qctx = {"kind": "puzzle", "island": nid, "tier": 0,
                             "domain": None, "ptype": deal["kind"]}
                self.question = None
                self._pending_puzzle = {"text": deal["text"], "limit": deal["limit"],
                                        "options": deal["options"],
                                        "correct": deal["correct"]}
                self._bump("question")
        elif ntype == "haven":
            if p.checkpoint != nid:
                p.checkpoint = nid
                self._say(f"⚓ {p.name} makes camp — checkpoint set at {node['name']}.")
            self._bump("haven")        # repair or pass
        elif ntype == "shop":
            self._bump("shop")         # browse the trader's stall
        else:
            self._next_turn()                 # cleared / spent / empty waters

    def _bank(self, p: Player):
        if p.cargo:
            n = len(p.cargo)
            p.banked += n
            p.cargo = []
            self._say(f"{p.name} banks {n} seal{'s' if n > 1 else ''}. ({p.banked}/{RELICS_TO_WIN})")
        p.hull = p.max_hull
        if p.banked >= RELICS_TO_WIN and not self.pharos_open:
            self.pharos_open = True
            self._say(f"⚡ Three seals banked — the Pharos opens for {p.name}.")

    # ── shrine wagers ────────────────────────────────────────────────────────
    def wager(self, pid: str, tier: int):
        self._require_turn(pid, "shrine")
        p = self.current
        node = self.board.nodes[p.node]
        if node["type"] != "shrine" or node.get("charges", 0) <= 0:
            raise GameError("This shrine is spent.")
        if tier not in TIER_REWARD:
            raise GameError("Choose tier I, II, or III.")
        self.qctx = {"kind": "shrine", "island": p.node, "tier": tier,
                     "domain": node["domain"]}
        self.question = None
        self._bump("question")

    def pass_turn(self, pid: str):
        self._require_turn(pid, "shrine", "haven", "shop")
        self._next_turn()

    # ── haven ────────────────────────────────────────────────────────────────
    def repair(self, pid: str):
        self._require_turn(pid, "haven")
        p = self.current
        missing = p.max_hull - p.hull
        spend = min(missing, p.scrolls)
        if spend <= 0:
            raise GameError("Nothing to repair — or no scrolls to pay with.")
        p.scrolls -= spend
        p.hull += spend
        self._say(f"{p.name} patches {spend} Health at the haven.")
        self._next_turn()

    # ── markets ──────────────────────────────────────────────────────────────
    # The BASIC market (consumables) travels with you: buy any time before a
    # dice roll, or ashore at a market isle. The shipwright's permanent wares
    # — fittings and legendary relics — are sold at LAND markets only.
    def shop_buy(self, pid: str, item: str):
        """Buy from the trader. Consumables cap at ITEM_CAP so nobody stacks
        buffs; a fitting ends the shop visit with an upgrade choice."""
        if self.phase not in ("shop", "roll") or not self.players \
                or self.current.pid != pid:
            raise GameError("The trader isn't listening right now.")
        remote = self.phase == "roll"
        p = self.current
        if item in RELICS or item == "fitting":
            if remote:
                raise GameError("The shipwright's wares are sold ashore, "
                                "at a market isle.")
        if item in RELICS:
            relic = RELICS[item]
            if p.has(item):
                raise GameError(f"Your ship already bears the {relic['name']}.")
            if p.scrolls < relic["cost"]:
                raise GameError(f"The {relic['name']} costs {relic['cost']} scrolls.")
            p.scrolls -= relic["cost"]
            self._apply_upgrade(p, item)
            self._say(f"⚜ {p.name} bears away the {relic['name']} — {relic['cost']} scrolls.")
            return
        stock = SHOP_ITEMS.get(item)
        if not stock:
            raise GameError("The trader doesn't stock that.")
        if p.scrolls < stock["cost"]:
            raise GameError(f"{stock['name']} costs {stock['cost']} scrolls.")
        if item == "fitting":
            pool = [u for u in UPGRADES if not p.has(u)]
            if not pool:
                raise GameError("Your ship already carries every fitting.")
            p.scrolls -= stock["cost"]
            self.rng.shuffle(pool)
            self.upgrade_offer = pool[:2]
            self._say(f"{p.name} pays the shipwright {stock['cost']} scrolls.")
            self._bump("upgrade_pick")
            return
        if p.items.get(item, 0) >= ITEM_CAP:
            raise GameError(f"You can carry at most {ITEM_CAP} of each charm.")
        p.scrolls -= stock["cost"]
        p.items[item] = p.items.get(item, 0) + 1
        self.nonce += 1
        self._say(f"{p.name} buys a {stock['name']}.")

    # ── consumables ──────────────────────────────────────────────────────────
    def use_item_charm(self, pid: str, item: str):
        """Spend a carried consumable: hint (during your question), gale
        (before rolling), horn (before picking a battle stance), planks
        (patch the hull any time on your turn, even mid-battle).
        Aegis Charms trigger on their own when you take damage."""
        p = self.player_by_pid(pid)
        if not p or self.current.pid != pid:
            raise GameError("Not your turn.")
        if p.items.get(item, 0) <= 0:
            raise GameError("You don't carry one.")
        if item == "planks":
            if self.phase not in ("roll", "sail", "battle", "shrine", "haven", "shop"):
                raise GameError("Steady your hands first — not now.")
            if p.hull >= p.max_hull:
                raise GameError("The hull is already sound.")
            p.items["planks"] -= 1
            healed = min(PLANKS_HEAL, p.max_hull - p.hull)
            p.hull += healed
            self.nonce += 1
            self._say(f"🔨 {p.name} patches {healed} Health with pitch and planks.")
            return
        if item == "hint":
            if self.phase != "question" or self.question is None:
                raise GameError("No question to narrow.")
            if self.question.get("disabled"):
                raise GameError("The options are already narrowed.")
            if len(self.question["options"]) <= 2:
                raise GameError("Nothing left to narrow.")
            p.items["hint"] -= 1
            correct = self.question["correct"]
            wrong = [i for i in range(len(self.question["options"])) if i != correct]
            self.rng.shuffle(wrong)
            self.question["disabled"] = sorted(wrong[:2])
            self._say(f"📜 {p.name}'s hint stone burns away two false answers.")
        elif item == "gale":
            if self.phase != "roll":
                raise GameError("Use it before you roll.")
            p.items["gale"] -= 1
            p.next_roll_bonus += GALE_BONUS
            self.nonce += 1
            self._say(f"🌬 {p.name} cracks a gale charm — +{GALE_BONUS} to the coming roll.")
        elif item == "horn":
            if self.phase != "battle":
                raise GameError("Sound it in battle, before your move.")
            if self.battle.get("horn"):
                raise GameError("The horn already sounds.")
            p.items["horn"] -= 1
            self.battle["horn"] = True
            self.nonce += 1
            self._say(f"📯 {p.name} sounds the war horn — the next STRIKE lands harder.")
        else:
            raise GameError("That charm works on its own.")

    def _absorb(self, p: Player, dmg: int) -> tuple[int, bool]:
        """Aegis Charms eat the next damage automatically."""
        if dmg > 0 and p.items.get("aegis_charm", 0) > 0:
            p.items["aegis_charm"] -= 1
            self._say(f"🛡 {p.name}'s aegis charm shatters — the blow is turned aside.")
            return 0, True
        return dmg, False

    # ── battle (Paper-Mario turns: your move, then the enemies') ─────────────
    def stance(self, pid: str, stance: str, target: int = 0):
        self._require_turn(pid, "battle")
        if stance not in ("attack", "magic", "guard"):
            raise GameError("Choose STRIKE, MAGIC, or GUARD.")
        m = self.board.alive_monster(self.battle["node"])
        enemies = m["enemies"]
        if not (0 <= target < len(enemies)) or enemies[target]["hp"] <= 0:
            target = next(i for i, e in enumerate(enemies) if e["hp"] > 0)
        node = self.board.nodes[self.battle["node"]]
        boss = bool(m.get("boss")) or any(e["max_hp"] >= 5 for e in enemies)
        if stance == "guard":
            tier = 1                       # reading the blow to turn it back
        else:
            tier = (2 if boss else 1) if stance == "attack" else 3
        self.battle["stance"] = stance
        self.battle["target"] = target

        # ── what challenge does this round pose? ─────────────────────────────
        # Ordinary packs: an even coin — half trivia, half puzzles. Bosses
        # ALTERNATE, a trivia round then a puzzle round, so a trial tests the
        # whole mind. The Dark Lord draws trivia from EVERY category. Puzzles
        # in combat never include riddles (those belong to the Sphinx).
        if boss:
            puzzle_round = self.battle["round"] % 2 == 1
        else:
            puzzle_round = self.rng.random() < 0.5
        if puzzle_round:
            deal = puzzles.deal_battle(self.rng)
            self.minigame = {"kind": deal["kind"], "island": self.battle["node"],
                             "data": deal, "limit": deal["limit"],
                             "deadline": None, "battle": True}
            self.qctx = None
            self.question = None
            self.side_answers = {}
            self._bump("minigame")
            return
        domain = (self.rng.choice(DOMAINS) if node["type"] == "pharos"
                  else m["domain"])
        self.qctx = {"kind": "battle", "island": self.battle["node"],
                     "tier": tier, "domain": domain}
        self.question = None
        self.side_answers = {}
        self._bump("question")

    def flee(self, pid: str):
        """FLEE_COST scrolls buys a coin flip: slip away clean, or the front
        enemy lands a free hit and the fight goes on. Trials allow no retreat."""
        self._require_turn(pid, "battle")
        p = self.current
        m = self.board.alive_monster(self.battle["node"])
        if m.get("boss"):
            raise GameError("There is no retreat from a trial.")
        if p.scrolls < FLEE_COST:
            raise GameError(f"Fleeing costs {FLEE_COST} scrolls.")
        p.scrolls -= FLEE_COST
        if self.rng.random() < 0.5:
            p.node = p.prev_node
            self.battle = None
            self._say(f"🏃 {p.name} slips away from {m['name']}.")
            self._next_turn()
            return
        front = next(e for e in m["enemies"] if e["hp"] > 0)
        hit, blocked = self._absorb(p, front["power"])
        p.hull -= hit
        self._say(f"✗ {m['name']} cuts off the escape — "
                  + ("the aegis holds." if blocked else f"{front['name']} strikes for {hit}."))
        if p.hull <= 0:
            self._shipwreck(p)
            self.battle = None
            self._next_turn()
        else:
            self.nonce += 1        # still in the fight — choose again

    def use_item(self, pid: str, item: str):
        """Owl / Lyre, usable while a battle question is up."""
        self._require_turn(pid, "question")
        if self.qctx["kind"] != "battle" or self.question is None:
            raise GameError("No battle question to bend.")
        p = self.current
        if not p.has(item):
            raise GameError("You don't carry that.")
        if item in self.battle["used_items"]:
            raise GameError("Already used this battle.")
        if item == "owl":
            self.battle["used_items"].append("owl")
            correct = self.question["correct"]
            wrong = [i for i in range(len(self.question["options"])) if i != correct]
            self.rng.shuffle(wrong)
            self.question["disabled"] = sorted(wrong[:2])
        elif item == "lyre":
            self.battle["used_items"].append("lyre")
            self.question = None              # server fetches a fresh one
            self.nonce += 1                   # cancel the old question timer
        else:
            raise GameError("That trinket has no power here.")

    def _shipwreck(self, p: Player):
        returned = []
        for theme in p.cargo:
            for nid in self.board.lairs():
                node = self.board.nodes[nid]
                if node.get("region") == theme and p.pid not in node["stash"]:
                    node["stash"].append(p.pid)       # waits at the altar for you
                    returned.append(node["name"])
        p.cargo = []
        p.scrolls //= 2
        if p.checkpoint not in self.board.nodes:
            p.checkpoint = "home"
        p.node = p.checkpoint
        p.prev_node = p.checkpoint
        p.hull = p.max_hull
        where = self.board.nodes[p.checkpoint]["name"]
        msg = f"☠ {p.name}'s ship goes down! The crew washes ashore at {where}."
        if returned:
            msg += " Lost relics drift back to their lairs."
        self._say(msg)

    # ── questions (shrine / battle / puzzle all resolve here) ────────────────
    def set_question(self, q: dict, deadline: float | None = None):
        if self.phase != "question" or self.question is not None:
            return
        if self.qctx["kind"] == "puzzle" and getattr(self, "_pending_puzzle", None):
            q = self._pending_puzzle
            self._pending_puzzle = None
        self.question = q
        self.question_deadline = deadline
        # Eye of the Oracle: a battle question opens with two lies already gone.
        if (self.qctx["kind"] == "battle" and self.current.has("oracle_eye")
                and not q.get("disabled") and len(q.get("options", [])) > 2):
            wrong = [i for i in range(len(q["options"])) if i != q["correct"]]
            self.rng.shuffle(wrong)
            q["disabled"] = sorted(wrong[:2])

    def needs_puzzle(self) -> dict | None:
        """Server asks: is a locally-supplied puzzle pending?"""
        if self.phase == "question" and self.qctx and self.qctx["kind"] == "puzzle":
            return getattr(self, "_pending_puzzle", None)
        return None

    def side_answer(self, pid: str, idx: int):
        if self.phase != "question" or self.question is None:
            raise GameError("No question is open.")
        if pid == self.current.pid:
            raise GameError("Use answer for your own question.")
        p = self.player_by_pid(pid)
        if not p:
            raise GameError("Spectators watch in silence.")
        if pid in self.side_answers:
            raise GameError("You already answered.")
        self.side_answers[pid] = idx

    def answer(self, pid: str, idx: int):
        self._require_turn(pid, "question")
        if self.question is None:
            raise GameError("The question is still on its way.")
        if idx in self.question.get("disabled", []):
            raise GameError("The Owl has ruled that answer out.")
        self._resolve_question(idx == self.question["correct"], idx)

    def timeout_question(self):
        if self.phase == "question" and self.question is not None:
            self._resolve_question(False, -1)

    def _streak_bonus(self, p: Player) -> int:
        p.streak += 1
        if p.streak >= STREAK_AT:
            p.scrolls += 1
            return 1
        return 0

    def _settle_side_answers(self) -> dict:
        """Rivals who guessed the open question right skim a scroll."""
        side = {}
        if self.question is not None:
            for spid, sidx in self.side_answers.items():
                sp = self.player_by_pid(spid)
                if not sp:
                    continue
                ok = sidx == self.question["correct"]
                if ok:
                    sp.scrolls += SIDE_REWARD + self._side_streak(sp)
                else:
                    sp.streak = 0
                side[spid] = {"ok": ok, "chosen": sidx}
        self.side_answers = {}
        return side

    def _resolve_question(self, correct: bool, idx: int):
        p = self.current
        ctx = self.qctx
        kind = ctx["kind"]
        note = ""
        gained = 0

        if kind == "battle":
            side = self._settle_side_answers()
            self._resolve_battle(correct, idx, self.question["correct"], side,
                                 challenge="trivia")
            return

        if kind == "shrine":
            node = self.board.nodes[ctx["island"]]
            node["charges"] = max(0, node.get("charges", 1) - 1)
            if correct:
                gained = TIER_REWARD[ctx["tier"]] + self._streak_bonus(p)
                p.scrolls += TIER_REWARD[ctx["tier"]]
            else:
                p.streak = 0
                if ctx["tier"] == 3 and p.scrolls > 0:
                    p.scrolls -= TIER3_PENALTY
                    note = "The muse takes a scroll for your hubris."
        elif kind == "puzzle":
            if correct:
                self.board.nodes[ctx["island"]]["solved"] = True
                self._streak_bonus(p)
                pool = [u for u in UPGRADES if not p.has(u)]
                if pool:
                    self.rng.shuffle(pool)
                    self.upgrade_offer = pool[:2]
                    note = "The puzzle yields — choose your prize."
                else:
                    p.scrolls += 3
                    gained = 3
                    note = "The puzzle yields 3 scrolls."
            else:
                p.streak = 0
                note = "The puzzle keeps its secret. It can be tried again."

        side = self._settle_side_answers()
        self.reveal = {
            "correct": self.question["correct"], "chosen": idx,
            "was_correct": correct, "note": note, "gained": gained,
            "kind": kind, "domain": ctx.get("domain"), "side": side,
            "battle_over": False, "enemy_phase": None, "monster": None,
        }
        if note:
            self._say(note)
        self._bump("reveal")

    def _resolve_battle(self, correct: bool, idx: int, correct_idx,
                        side: dict | None = None, challenge: str = "trivia"):
        """One full battle exchange — your move, then the enemies'. Fed by a
        trivia answer OR a combat puzzle result; the rules don't care which."""
        p = self.current
        note = ""
        gained = 0
        battle_over = False
        if True:
            m = self.board.nodes[self.battle["node"]]["monster"]
            enemies = m["enemies"]
            stance = self.battle["stance"]
            boss = bool(m.get("boss"))
            heavy = bool(boss and self.battle.get("charging"))
            tgt = enemies[self.battle.get("target", 0)]
            enemy_phase = {"evaded": False, "backfire": False, "blocked": False,
                           "heavy": False, "attacker": None, "dmg": 0,
                           "target_idx": self.battle.get("target", 0),
                           "dealt": 0, "killed": False}
            if correct:
                self._streak_bonus(p)
            else:
                p.streak = 0

            # ── your move ────────────────────────────────────────────────────
            dmg = 0
            victim = tgt                       # which enemy my blow lands on
            if correct and stance == "attack":
                dmg = (STRIKE_DMG + (1 if p.has("ram") else 0)
                       + (2 if p.has("titan_ram") else 0))
                horn = self.battle.get("horn")
                if horn:
                    dmg += HORN_BONUS
                    self.battle["horn"] = False
                note = f"{'📯 ' if horn else ''}⚔ Your blade bites {tgt['name']} for {dmg}!"
            elif correct and stance == "magic":
                dmg = MAGIC_DMG + (1 if p.has("trident") else 0)
                note = f"✨ Arcane fire sears {tgt['name']} for {dmg}!"
            elif correct and stance == "guard":
                # riposte: read the incoming blow and drive it back on the
                # attacker — doubled if it was a telegraphed heavy. Reading a
                # heavy is your single biggest hit, so guard the right round.
                fi = next((i for i, e in enumerate(enemies) if e["hp"] > 0),
                          self.battle.get("target", 0))
                victim = enemies[fi]
                dmg = victim["power"] * (HEAVY_MULT if heavy else 1)
                enemy_phase["blocked"] = True
                enemy_phase["riposte"] = True
                enemy_phase["attacker"] = victim["name"]
                enemy_phase["heavy"] = heavy
                enemy_phase["target_idx"] = fi
                note = ("🛡 You read " + victim["name"] + "'s "
                        + ("HEAVY blow" if heavy else "attack")
                        + f" and turn it back for {dmg}!")
            if dmg:
                victim["hp"] -= dmg
                enemy_phase["dealt"] = dmg
                if victim["hp"] <= 0:
                    enemy_phase["killed"] = True
                    note += f" {victim['name']} falls!"

            alive = [e for e in enemies if e["hp"] > 0]
            if not alive:
                battle_over = True
                node = self.board.nodes[self.battle["node"]]
                if node["type"] == "pharos":
                    self.winner = p.pid
                    note = f"🏆 The Dark Lord falls — {p.name} takes the PHAROS!"
                else:
                    note += f" {m['name']} — defeated!"
                    if node["type"] == "lair":
                        node["defeated"].append(p.pid)
                        node["monster"] = None      # your trial is done, forever
                        p.cargo.append(node["region"])
                        note += " The sigil fragment is aboard — sail it home."
                    loot = sum(e["max_hp"] for e in enemies)
                    p.scrolls += loot
                    gained = loot
                    if node.get("encounter") or node["type"] == "sea":
                        node["monster"] = None     # the waters fall quiet — for now
            else:
                # a wounded boss enrages — and the fury lands this very round
                if boss and not m.get("enraged"):
                    if sum(e["hp"] for e in enemies) * 2 <= sum(e["max_hp"] for e in enemies):
                        m["enraged"] = True
                        for e in enemies:
                            e["power"] += 1
                        note += f" 🔥 {m['name']} ENRAGES — its blows land harder!"

                # ── the enemies' move ────────────────────────────────────────
                # Packs only punish a miss; a boss answers EVERY exchange.
                front = alive[0]
                if stance == "guard" and correct:
                    pass          # the blow was read and turned back in your-move
                elif not correct and stance == "magic" and not boss:
                    hit, blocked = self._absorb(p, MAGIC_BACKFIRE)
                    enemy_phase["backfire"] = True
                    enemy_phase["dmg"] = hit
                    note = ("🛡 The aegis charm eats the backfire."
                            if blocked else f"🔥 The spell backfires — {hit} damage!")
                    p.hull -= hit
                elif boss or not correct:
                    power = front["power"] * (HEAVY_MULT if heavy else 1)
                    hit, blocked = self._absorb(p, power)
                    pre = ""
                    if blocked:
                        pre = "🛡 The aegis charm turns the blow. "
                    elif p.has("aegis") and not self.battle["first_hit_taken"]:
                        hit = max(1, hit // 2)
                        self.battle["first_hit_taken"] = True
                        pre = "Your Aegis shard flares — "
                    enemy_phase["attacker"] = front["name"]
                    enemy_phase["dmg"] = hit
                    enemy_phase["heavy"] = heavy
                    if not blocked:
                        pre += (f"💥 {front['name']} lands a HEAVY blow for {hit}!"
                                if heavy else f"💥 {front['name']} strikes for {hit}!")
                    note = (note + " " + pre).strip()
                    p.hull -= hit
                else:
                    # your successful move carries you clear of the counter
                    enemy_phase["evaded"] = True
                    enemy_phase["attacker"] = front["name"]

                if p.hull <= 0:
                    battle_over = True
                    node = self.board.nodes[self.battle["node"]]
                    if node["type"] == "pharos":
                        self.board.reset_warden()   # a fresh Warden per challenger
                    self._shipwreck(p)
                elif boss:
                    # the exchange count drives the telegraphed heavy blows
                    self.battle["round"] += 1
                    self.battle["charging"] = (
                        self.battle["round"] % HEAVY_EVERY == HEAVY_EVERY - 1)
                    if self.battle["charging"]:
                        note += f" ⚠ {m['name']} rears back, gathering a heavy blow…"
            self._last_enemy_phase = enemy_phase

        self.reveal = {
            "correct": correct_idx, "chosen": idx,
            "was_correct": correct, "note": note, "gained": gained,
            "kind": "battle", "challenge": challenge,
            "domain": (self.qctx or {}).get("domain"), "side": side or {},
            "battle_over": battle_over,
            "enemy_phase": enemy_phase,
            "monster": self._battle_public(),
        }
        if note:
            self._say(note)
        if battle_over or self.winner:
            self.battle = None
        self._bump("reveal")

    def _side_streak(self, sp: Player) -> int:
        sp.streak += 1
        if sp.streak >= STREAK_AT:
            sp.scrolls += 1
            return 1
        return 0

    def advance_after_reveal(self):
        if self.phase != "reveal":
            return
        rv = self.reveal or {}
        self.question = None
        self.question_deadline = None
        if self.winner:
            self._bump("finished")
        elif self.upgrade_offer:
            self._bump("upgrade_pick")
        elif self.battle and not rv.get("battle_over"):
            self._bump("battle")           # next round: choose a stance again
        else:
            self._next_turn()

    # ── interactive puzzle minigames ─────────────────────────────────────────
    # Four flavours share the minigame phase: puzzle ISLES (retry until the
    # clock), BATTLE rounds (a solved puzzle lands your move), the KRAKEN's
    # three-riddle gauntlet (one wrong pick and you lose a turn), and the
    # SPHINX's riddle toll (fail and you're sent back down the road).
    def minigame_submit(self, pid: str, payload):
        self._require_turn(pid, "minigame")
        mg = self.minigame
        ok = puzzles.check(mg["kind"], mg["data"], payload)
        if mg.get("battle"):
            if ok:
                self.minigame = None
                self._resolve_battle(True, -2, None, challenge="puzzle")
            elif mg["kind"] == "simon":
                self.minigame = None
                self._resolve_battle(False, -2, None, challenge="puzzle")
            else:
                raise GameError("Not solved — the enemy circles…")
            return
        if mg.get("kraken"):
            if ok:
                self._kraken_next()
            else:
                self._kraken_fail()               # one wrong pick: it has you
            return
        if mg.get("sphinx"):
            if ok:
                self._sphinx_pass()
            else:
                raise GameError("The Sphinx narrows her eyes — try again.")
            return
        if ok:
            self._puzzle_success(mg["island"])
        elif mg["kind"] == "simon":
            self._puzzle_fail(mg["island"])       # one wrong note ends the echo
        else:
            raise GameError("Not solved yet — the isle waits.")

    def minigame_timeout(self):
        if self.phase != "minigame":
            return
        mg = self.minigame
        if mg.get("battle"):
            self.minigame = None
            self._resolve_battle(False, -2, None, challenge="puzzle")
        elif mg.get("kraken"):
            self._kraken_fail()
        elif mg.get("sphinx"):
            self._sphinx_fail()
        else:
            self._puzzle_fail(mg["island"])

    def resolve_minigame(self, success: bool):
        """Bot path: the driver decides success/failure directly."""
        if self.phase != "minigame":
            return
        mg = self.minigame
        if mg.get("battle"):
            self.minigame = None
            self._resolve_battle(success, -2, None, challenge="puzzle")
        elif mg.get("kraken"):
            self._kraken_next() if success else self._kraken_fail()
        elif mg.get("sphinx"):
            self._sphinx_pass() if success else self._sphinx_fail()
        elif success:
            self._puzzle_success(mg["island"])
        else:
            self._puzzle_fail(mg["island"])

    # ── the kraken's gauntlet ────────────────────────────────────────────────
    def _kraken_deal(self):
        deal = puzzles.deal_kind(self.rng, "ravens")
        self.kraken["asked"] += 1
        self.minigame = {"kind": "ravens", "island": self.kraken["node"],
                         "data": deal, "limit": deal["limit"],
                         "deadline": None, "kraken": True,
                         "kraken_no": self.kraken["asked"],
                         "kraken_need": KRAKEN_RIDDLES}
        self._bump("minigame")

    def _kraken_next(self):
        k = self.kraken
        if k["asked"] >= KRAKEN_RIDDLES:
            self.minigame = None
            self.kraken = None
            self._say(f"🐙 The kraken, satisfied, sinks back into the deep — "
                      f"{self.current.name} sails on.")
            self._next_turn()
        else:
            self._say(f"🐙 {self.current.name} answers — the kraken poses another…")
            self._kraken_deal()

    def _kraken_fail(self):
        p = self.current
        self.minigame = None
        self.kraken = None
        p.skip_turns += 1
        p.streak = 0
        self._say(f"🐙 The kraken drags {p.name}'s ship in circles — "
                  f"they lose their next turn!")
        self._next_turn()

    # ── the sphinx's toll ────────────────────────────────────────────────────
    def _sphinx_pass(self):
        self.minigame = None
        self._say(f"🦁 The Sphinx bows her head — {self.current.name} may pass.")
        self._next_turn()

    def _sphinx_fail(self):
        p = self.current
        self.minigame = None
        back = p.prev_node if p.prev_node in self.board.nodes else p.node
        steps = 1
        # sometimes she flings you TWO spaces down the road
        nbrs = [nb for nb in self.board.neighbors.get(back, [])
                if nb != p.node and self.board.nodes[nb]["type"] not in ("lair", "pharos")]
        if nbrs and self.rng.random() < 0.5:
            p.node = self.rng.choice(nbrs)
            p.prev_node = back
            steps = 2
        else:
            p.node = back
            p.prev_node = back
        p.streak = 0
        self._say(f"🦁 Wrong! The Sphinx's riddle stumps {p.name} — "
                  f"swept {steps} space{'s' if steps > 1 else ''} back down the road.")
        self._next_turn()

    def _puzzle_success(self, nid: str):
        p = self.current
        self.board.nodes[nid]["solved"] = True
        self.minigame = None
        p.puzzles_solved += 1
        self._streak_bonus(p)
        pool = [u for u in UPGRADES if not p.has(u)]
        if pool:
            self.rng.shuffle(pool)
            self.upgrade_offer = pool[:2]
            self._say(f"{p.name} cracks the puzzle of {self.board.nodes[nid]['name']}!")
            self._bump("upgrade_pick")
        else:
            p.scrolls += 3
            self._say(f"{p.name} cracks the puzzle — 3 scrolls.")
            self._next_turn()

    def _puzzle_fail(self, nid: str):
        p = self.current
        p.streak = 0
        kind = self.minigame["kind"] if self.minigame else None
        self.minigame = None
        msg = f"The puzzle of {self.board.nodes[nid]['name']} defeats {p.name} — it can be tried again."
        if kind == "simon" and p.scrolls > 0:
            p.scrolls -= 1                 # the Muses take a tithe for a broken echo
            msg += " The Muses take a scroll."
        self._say(msg)
        self._next_turn()

    # ── upgrades ─────────────────────────────────────────────────────────────
    def _apply_upgrade(self, p: Player, upgrade: str):
        """Fit an upgrade to a ship and apply any instant effect. Shared by the
        free fitting/puzzle picks and the shipwright's paid relics."""
        p.upgrades.append(upgrade)
        if upgrade == "hull_plates":
            p.max_hull += 2
            p.hull = min(p.max_hull, p.hull + 2)
        elif upgrade == "golden_fleece":
            p.max_hull += 5
            p.hull = p.max_hull                    # the fleece mends every plank
        self.nonce += 1

    def pick_upgrade(self, pid: str, upgrade: str):
        self._require_turn(pid, "upgrade_pick")
        if not self.upgrade_offer or upgrade not in self.upgrade_offer:
            raise GameError("That prize is not on offer.")
        p = self.current
        self._apply_upgrade(p, upgrade)
        self._say(f"{p.name} fits the {ALL_UPGRADES[upgrade]['name']}.")
        self.upgrade_offer = None
        self._next_turn()

    # ── turn / lifecycle ─────────────────────────────────────────────────────
    def skip_turn(self, host_pid: str):
        if not self.players or self.players[0].pid != host_pid:
            raise GameError("Only the host can skip a turn.")
        if self.phase in ("lobby", "finished"):
            raise GameError("Nothing to skip.")
        self.battle = None
        self.minigame = None
        self.kraken = None
        self.upgrade_offer = None
        self._next_turn()

    def _next_turn(self):
        if self.winner:
            self._bump("finished")
            return
        self.turn_idx = (self.turn_idx + 1) % len(self.players)
        # captains who owe the kraken a turn sit it out
        for _ in range(len(self.players)):
            nxt = self.players[self.turn_idx]
            if nxt.skip_turns <= 0:
                break
            nxt.skip_turns -= 1
            self._say(f"⏳ {nxt.name} loses this turn — the kraken's toll.")
            self.turn_idx = (self.turn_idx + 1) % len(self.players)
        self._start_turn()

    def rematch(self, pid: str):
        if self.phase != "finished":
            raise GameError("The voyage is not over.")
        if not self.players or self.players[0].pid != pid:
            raise GameError("Only the host can call a rematch.")
        self.board = Board(self.rng.randrange(2**31))     # a brand-new sea
        for p in self.players:
            p.reset()
        self.winner = None
        self.pharos_open = False
        self.kraken = None
        self.used_puzzles = set()
        self.log = []
        self.turn_idx = 0
        self._start_turn()

    # ── snapshots (per viewer — fog!) ────────────────────────────────────────
    def _battle_public(self) -> dict | None:
        if not self.battle:
            return None
        m = self.board.nodes[self.battle["node"]].get("monster")
        if not m:
            return None
        node = self.board.nodes[self.battle["node"]]
        boss = bool(m.get("boss")) or any(e["max_hp"] >= 5 for e in m["enemies"])
        return {"name": m["name"], "tier": m["tier"], "domain": m["domain"],
                "boss": boss, "model": m.get("model"),
                "enraged": bool(m.get("enraged")),
                "escalation": m.get("escalation", 0),
                "ambush": bool(self.battle.get("ambush")),
                "round": self.battle.get("round", 0),
                "charging": bool(self.battle.get("charging")),
                "enemies": [{"name": e["name"], "hp": max(0, e["hp"]),
                             "max_hp": e["max_hp"], "power": e["power"],
                             "model": e.get("model")}
                            for e in m["enemies"]],
                "strike_tier": 2 if boss else 1,
                "node": self.battle["node"], "is_lair": node["type"] == "lair",
                "is_pharos": node["type"] == "pharos",
                "region": node.get("region"),
                "target": self.battle.get("target", 0),
                "horn": bool(self.battle.get("horn")),
                "used_items": self.battle["used_items"]}

    def _node_view(self, nid: str) -> dict:
        node = self.board.nodes[nid]
        base = {"id": nid, "x": node["x"], "z": node["z"], "band": node["band"]}
        base["type"] = node["type"]
        base["name"] = node["name"]
        if node.get("region"):
            base["region"] = node["region"]
        if node.get("depth"):
            base["depth"] = node["depth"]
        if node.get("mode"):
            base["mode"] = node["mode"]
        if node.get("gate_angle") is not None:
            base["gate_angle"] = node["gate_angle"]
        if node["type"] == "sea":
            base["look"] = node.get("look", "buoy")
        elif node["type"] == "shrine":
            base["domain"] = node["domain"]
            base["charges"] = node["charges"]
            base["tier"] = node["tier"]
        elif node["type"] == "puzzle":
            base["solved"] = node.get("solved", False)
        elif node["type"] in ("monster", "lair", "pharos"):
            m = node.get("monster")
            alive = [e for e in (m["enemies"] if m else []) if e["hp"] > 0]
            base["monster"] = None if not alive else {
                "name": m["name"], "count": len(alive),
                "hp": sum(e["hp"] for e in alive),
                "max_hp": sum(e["max_hp"] for e in m["enemies"]),
                "power": max(e["power"] for e in alive), "domain": m["domain"],
                "boss": bool(m.get("boss"))}
            if node["type"] == "monster":
                base["encounter"] = True
                base["elite"] = node.get("elite", False)
            if node["type"] == "lair":
                base["boss_name"] = node["boss_spec"][0]
                base["defeated"] = node["defeated"]
                base["stash"] = node["stash"]
        return base

    def to_dict(self, viewer_pid: str | None = None) -> dict:
        nodes = [self._node_view(nid) for nid in self.board.nodes]
        edges = [[a, b] for a, b in self.board.edges]

        q = None
        if self.question is not None:
            q = {"text": self.question["text"], "options": self.question["options"],
                 "kind": self.qctx["kind"], "tier": self.qctx["tier"],
                 "domain": self.qctx["domain"], "deadline": self.question_deadline,
                 "disabled": self.question.get("disabled", [])}
        return {
            "code": self.code,
            "phase": self.phase,
            "board": {"nodes": nodes, "edges": edges,
                      "domains": DOMAIN_INFO, "home": "home",
                      "regions": {t: {"name": REGION_POOL[t]["name"],
                                      "mode": REGION_POOL[t].get("mode", "sail"),
                                      "boss": REGION_POOL[t]["boss"][0]}
                                  for t in self.board.regions}},
            "players": [p.public() for p in self.players],
            "host": self.players[0].pid if self.players else None,
            "turn": self.current.pid if self.players and self.phase != "lobby" else None,
            "die": self.die,
            "reachable": self.reachable if viewer_pid is None or
                         (self.players and self.phase != "lobby"
                          and self.current.pid == viewer_pid) else {},
            "question": q,
            "side_answered": list(self.side_answers.keys()),
            "reveal": self.reveal if self.phase == "reveal" else None,
            "battle": self._battle_public(),
            "minigame": ({k: v for k, v in {**self.minigame,
                          **self.minigame["data"]}.items()
                          if k not in ("data", "secret")}
                         if self.phase == "minigame" and self.minigame else None),
            "upgrade_offer": self.upgrade_offer if self.phase == "upgrade_pick" else None,
            "upgrade_info": ALL_UPGRADES,
            "pharos_open": self.pharos_open,
            "winner": self.winner,
            "log": self.log,
            "config": {"relics_to_win": RELICS_TO_WIN, "tier_reward": TIER_REWARD,
                       "streak_at": STREAK_AT, "max_hull": MAX_HULL,
                       "flee_cost": FLEE_COST, "shop_items": SHOP_ITEMS,
                       "relics": RELICS, "item_cap": ITEM_CAP,
                       "die_sides": 3, "heavy_every": HEAVY_EVERY,
                       "heavy_mult": HEAVY_MULT, "planks_heal": PLANKS_HEAL},
        }

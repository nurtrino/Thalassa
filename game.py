"""
Thalassa rules engine — the Race to the Pharos. Pure state machine.

The server owns dice RNG, question fetching, and timers; this module owns
the rules. Every mutation either succeeds or raises GameError.

The voyage: the Safe Isles ringed by a storm wall, the Pharos blazing at
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
    GUARD   tier-I question    → no damage; success turns the enemy blow
            aside entirely (the answer is how well you read the attack)
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
BOUNTIES_PER_GAME = 3              # public race-goals posted at Home Port
STREAK_AT = 3                      # correct-answer streak that pays a bonus
SIDE_REWARD = 1                    # scrolls for a correct side answer
FLEE_COST = 1                      # scrolls to gamble on escaping a battle
GALE_BONUS = 2                     # extra movement from a Gale Charm
HORN_BONUS = 2                     # extra STRIKE damage from a War Horn
PLANKS_HEAL = 3                    # Health restored by Pitch & Planks
HEAVY_EVERY = 3                    # bosses telegraph a heavy every Nth exchange
HEAVY_MULT = 2                     # ...that lands for double damage

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
            "streak": self.streak,
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
        self.upgrade_offer: list[str] | None = None
        self.used_puzzles: set[int] = set()
        self.pharos_open = False
        self.winner: str | None = None
        self.log: list[str] = []
        self.bounties: list[dict] = self._make_bounties()

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

    # ── bounties: public race-goals, first captain to do it gets paid ────────
    def _make_bounties(self) -> list[dict]:
        lair_names = [REGION_POOL[t]["boss"][0] for t in self.board.regions]
        self.rng.shuffle(lair_names)
        pool = [
            {"kind": "slay", "name": lair_names[0],
             "text": f"Slay {lair_names[0]}", "reward": 6},
            {"kind": "slay", "name": lair_names[1],
             "text": f"Slay {lair_names[1]}", "reward": 6},
            {"kind": "bank1", "text": "First to bank a relic", "reward": 4},
            {"kind": "bank2", "text": "First to bank 2 relics", "reward": 6},
            {"kind": "puzzles2", "text": "First to crack 2 puzzle isles", "reward": 5},
            {"kind": "far", "text": "First to reach the storm's edge", "reward": 5},
            {"kind": "scrolls12", "text": "First to hold 12 scrolls", "reward": 5},
        ]
        self.rng.shuffle(pool)
        picked, kinds = [], set()
        for b in pool:
            if b["kind"] in kinds:
                continue
            kinds.add(b["kind"])
            b["claimed_by"] = None
            picked.append(b)
            if len(picked) == BOUNTIES_PER_GAME:
                break
        return picked

    def _bounty_event(self, event: str, p: Player, **data):
        for b in self.bounties:
            if b["claimed_by"]:
                continue
            hit = (
                (b["kind"] == "slay" and event == "slay" and data.get("name") == b["name"]) or
                (b["kind"] == "bank1" and event == "bank" and p.banked >= 1) or
                (b["kind"] == "bank2" and event == "bank" and p.banked >= 2) or
                (b["kind"] == "puzzles2" and event == "puzzle" and p.puzzles_solved >= 2) or
                (b["kind"] == "far" and event == "land" and data.get("band", 0) >= 3) or
                (b["kind"] == "scrolls12" and p.scrolls >= 12)
            )
            if hit:
                b["claimed_by"] = p.pid
                p.scrolls += b["reward"]
                self._say(f"🏴 BOUNTY CLAIMED: {b['text']} — {p.name} +{b['reward']} scrolls!")

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
        if ntype != "sea":
            self._bounty_event("land", p, band=node.get("band", 0))
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
        # drifting flotsam is grabbed the moment you arrive — even if
        # something is about to rise out of the water after it
        if ntype == "sea" and node.get("flotsam"):
            node["flotsam"] = False
            p.scrolls += 1
            self._say(f"{p.name} hauls drifting flotsam aboard — +1 scroll.")

        monster = self.board.alive_monster(nid)
        # The Isles of Peace are safe: NO ambushes in the hub. All danger is
        # beyond the passes — realm hunting grounds bite on most landings
        # (deeper = surer) and realm open water can spring a sea attack too.
        if node.get("encounter") and node.get("depth"):
            chance = min(0.85, 0.45 + 0.1 * node["depth"])
        elif ntype == "sea" and node.get("depth"):
            chance = min(0.5, 0.2 + 0.05 * node["depth"])
        else:
            chance = 0.0
        if chance and not monster and self.rng.random() < chance:
            node["monster"] = self.board.random_pack(node, self.rng)
            monster = node["monster"]
            if ntype == "sea":
                self._say(f"⚔ {monster['name']} rise from the deep — "
                          f"{p.name} is beset mid-crossing!")
            else:
                self._say(f"⚔ {monster['name']} ambush {p.name}"
                          + (" in the wilds!" if node.get("region") else " in open water!"))
        if monster:
            self.battle = {"node": nid, "stance": None, "round": 0,
                           "charging": False,
                           "used_items": [], "first_hit_taken": False}
            if not node.get("encounter") and ntype != "sea":
                self._say(f"{monster['name']} bars {p.name}'s way!")
            self._bump("battle")
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
            self._bounty_event("bank", p)
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

    # ── market isles ─────────────────────────────────────────────────────────
    def shop_buy(self, pid: str, item: str):
        """Buy from the trader's stall. Consumables stack; a fitting ends
        the visit with an upgrade choice."""
        self._require_turn(pid, "shop")
        p = self.current
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
        boss = bool(m.get("boss")) or any(e["max_hp"] >= 5 for e in enemies)
        if stance == "guard":
            tier = 1                       # reading the blow, not landing one
        else:
            tier = (2 if boss else 1) if stance == "attack" else 3
        self.battle["stance"] = stance
        self.battle["target"] = target
        self.qctx = {"kind": "battle", "island": self.battle["node"],
                     "tier": tier, "domain": m["domain"]}
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

    def _resolve_question(self, correct: bool, idx: int):
        p = self.current
        ctx = self.qctx
        kind = ctx["kind"]
        note = ""
        gained = 0
        battle_over = False

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
                    note = "The riddle yields — choose your prize."
                else:
                    p.scrolls += 3
                    gained = 3
                    note = "The riddle yields 3 scrolls."
            else:
                p.streak = 0
                note = "The riddle keeps its secret. It can be tried again."
        elif kind == "battle":
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
            if correct and stance == "attack":
                dmg = STRIKE_DMG + (1 if p.has("ram") else 0)
                horn = self.battle.get("horn")
                if horn:
                    dmg += HORN_BONUS
                    self.battle["horn"] = False
                note = f"{'📯 ' if horn else ''}⚔ Your blade bites {tgt['name']} for {dmg}!"
            elif correct and stance == "magic":
                dmg = MAGIC_DMG + (1 if p.has("trident") else 0)
                note = f"✨ Arcane fire sears {tgt['name']} for {dmg}!"
            elif correct and stance == "guard":
                note = "🛡 You read the attack and set your stance."
            if dmg:
                tgt["hp"] -= dmg
                enemy_phase["dealt"] = dmg
                if tgt["hp"] <= 0:
                    enemy_phase["killed"] = True
                    note += f" {tgt['name']} falls!"

            alive = [e for e in enemies if e["hp"] > 0]
            if not alive:
                battle_over = True
                node = self.board.nodes[self.battle["node"]]
                if node["type"] == "pharos":
                    self.winner = p.pid
                    note = f"🏆 The Warden falls — {p.name} takes the PHAROS!"
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
                    self._bounty_event("slay", p, name=m["name"])
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
                    if boss or True:            # a read blow is always turned
                        enemy_phase["blocked"] = True
                        enemy_phase["attacker"] = front["name"]
                        enemy_phase["heavy"] = heavy
                        note += (f" {front['name']}'s "
                                 + ("HEAVY blow " if heavy else "attack ")
                                 + "glances off your guard!")
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

        # side answers: rivals who guessed right skim a scroll
        side = {}
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

        self.reveal = {
            "correct": self.question["correct"], "chosen": idx,
            "was_correct": correct, "note": note, "gained": gained,
            "kind": kind, "domain": ctx.get("domain"), "side": side,
            "battle_over": battle_over,
            "enemy_phase": getattr(self, "_last_enemy_phase", None) if kind == "battle" else None,
            "monster": self._battle_public() if kind == "battle" else None,
        }
        if note:
            self._say(note)
        if battle_over or self.winner:
            self.battle = None
        self._bounty_event("scrolls", p)
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
    def minigame_submit(self, pid: str, payload):
        self._require_turn(pid, "minigame")
        mg = self.minigame
        if puzzles.check(mg["kind"], mg["data"], payload):
            self._puzzle_success(mg["island"])
        elif mg["kind"] == "simon":
            self._puzzle_fail(mg["island"])       # one wrong note ends the echo
        else:
            raise GameError("Not solved yet — the isle waits.")

    def minigame_timeout(self):
        if self.phase == "minigame":
            self._puzzle_fail(self.minigame["island"])

    def resolve_minigame(self, success: bool):
        """Bot path: the driver decides success/failure directly."""
        if self.phase != "minigame":
            return
        if success:
            self._puzzle_success(self.minigame["island"])
        else:
            self._puzzle_fail(self.minigame["island"])

    def _puzzle_success(self, nid: str):
        p = self.current
        self.board.nodes[nid]["solved"] = True
        self.minigame = None
        p.puzzles_solved += 1
        self._bounty_event("puzzle", p)
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
    def pick_upgrade(self, pid: str, upgrade: str):
        self._require_turn(pid, "upgrade_pick")
        if not self.upgrade_offer or upgrade not in self.upgrade_offer:
            raise GameError("That prize is not on offer.")
        p = self.current
        p.upgrades.append(upgrade)
        if upgrade == "hull_plates":
            p.max_hull += 2
            p.hull = min(p.max_hull, p.hull + 2)
        self._say(f"{p.name} fits the {UPGRADES[upgrade]['name']}.")
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
        self.upgrade_offer = None
        self._next_turn()

    def _next_turn(self):
        if self.winner:
            self._bump("finished")
            return
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
        self.bounties = self._make_bounties()
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
            base["flotsam"] = node.get("flotsam", False)
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
            "upgrade_info": UPGRADES,
            "pharos_open": self.pharos_open,
            "bounties": self.bounties,
            "winner": self.winner,
            "log": self.log,
            "config": {"relics_to_win": RELICS_TO_WIN, "tier_reward": TIER_REWARD,
                       "streak_at": STREAK_AT, "max_hull": MAX_HULL,
                       "flee_cost": FLEE_COST, "shop_items": SHOP_ITEMS,
                       "die_sides": 3, "heavy_every": HEAVY_EVERY,
                       "heavy_mult": HEAVY_MULT, "planks_heal": PLANKS_HEAL},
        }

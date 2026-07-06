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
    …every normal turn then ends on TRADE — a last word with the ship's
    trader before the dice pass (the ONLY time the basic market answers
    at sea; never before you roll). puzzle success → upgrade_pick.
    finished when someone takes the Pharos.

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
longer slips you out of reach), and every blow lands in the 2–4 band — every
HEAVY_EVERY-th is a telegraphed heavy at the top of it. Beating one takes
preparation: hull fittings, planks, aegis charms, and reading the dodges.

Scrolls are the economy: temples pay them, shops spend them — hint stones,
gale charms, pitch & planks, aegis charms, war horns, permanent ship
fittings. Health 0 = shipwreck: unbanked seals return to their lairs,
scrolls halved, respawn at your haven checkpoint.
"""
from __future__ import annotations

import random

import puzzles
import questions
from board import (Board, DOMAIN_INFO, DOMAINS, REGION_POOL, REGION_MODELS,
                   RELICS_TO_WIN, WARDEN, WARDEN_MODEL,
                   ENCOUNTERS_LIGHT, ENCOUNTERS_HEAVY)

# ── tunables ─────────────────────────────────────────────────────────────────
MIN_PLAYERS = 1                    # solo runs are allowed for testing
MAX_PLAYERS = 6
TIER_REWARD = {1: 1, 2: 2, 3: 3}   # scrolls for a correct shrine wager
TIER3_PENALTY = 1
MAX_HULL = 6
STRIKE_DMG = 1                     # easy question, reliable chip damage
MAGIC_DMG = 3                      # hard question, big swing
SWORD_DMG = 3                      # Sword of Damocles: magic-pool question, 3 damage
MAGIC_BACKFIRE = 1                 # a missed spell burns the caster
MAP_COST = 30                      # scrolls the trader charges to unroll his map
STREAK_AT = 3                      # correct-answer streak that pays a bonus
SIDE_REWARD = 1                    # scrolls for a correct side answer
FLEE_COST = 1                      # scrolls to gamble on escaping a battle
GALE_BONUS = 2                     # extra movement from a Gale Charm
HORN_BONUS = 2                     # extra STRIKE damage from a War Horn
PLANKS_HEAL = 3                    # Health restored by Pitch & Planks
HEAVY_EVERY = 3                    # bosses telegraph a heavy every Nth exchange
HEAVY_MULT = 2                     # ...that lands for double damage
DODGE_SECS = 3.0                   # window to time the dodge before it lands
ATTACK_RUN_CAP = 2                 # an enemy may strike at most twice in a row
ITEM_CAP = 2                       # max carried of each consumable charm
KRAKEN_CHANCE = 0.10               # hub crossings: odds the kraken blocks you
KRAKEN_RIDDLES = 3                 # ...and how many mind-riddles it poses
VALE_LANTERN = 3                   # hops of the Amber Vale your lantern shows

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

# quest treasures — not sold, not in the fitting pool. Earned by sailing to a
# hidden islet the trader's map reveals. Stored in the same upgrade list.
QUEST_ITEMS = {
    "sword_of_damocles": {"name": "Sword of Damocles",
                          "desc": "A third option against the Dark Presence: a MAGIC-tier "
                                  "question for 3 damage — and no backfire"},
}

# one lookup covering ordinary fittings, legendary relics, and quest treasures
ALL_UPGRADES = {**UPGRADES, **RELICS, **QUEST_ITEMS}

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
        self.map_bought = False            # paid the trader to reveal the sword islet
        self.streak = 0
        self.puzzles_solved = 0
        self.skip_turns = 0                # turns owed to the kraken
        # the Amber Vale is a private fog-of-war maze: this is the captain's
        # own map of it — every stop their lantern has ever shown. Monotonic;
        # persists all game, so the crossing home is walked on known ground.
        self.seen: set[str] = set()

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
            "map_bought": self.map_bought,
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
        self.walk: dict | None = None      # Vale arrow-walk: {pid,node,came,steps,path,options}
        self.qctx: dict | None = None      # kind: shrine|battle|puzzle
        self.question: dict | None = None
        self.question_deadline: float | None = None
        self.dodge_deadline: float | None = None
        self.jboard: dict | None = None      # the Jeopardy category board
        self.jchoose_deadline: float | None = None
        self._pending_jeopardy: dict | None = None   # clue chosen off the board
        self.gate_walk: dict | None = None   # pending carry-through at a pass
        self.no_autowalk = False             # DEV: freeze the gate carry-through
        self.side_answers: dict[str, int] = {}
        self.reveal: dict | None = None
        self.battle: dict | None = None    # {node, stance, used_items, first_hit_taken}
        self.minigame: dict | None = None  # {kind, island, data, limit, deadline}
        self.kraken: dict | None = None    # {node, asked} — the gauntlet's progress
        self.flash: dict | None = None     # transient right/wrong banner {ok, text, seq}
        self._flash_seq = 0
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

    def _flash(self, ok: bool, text: str):
        """A one-shot right/wrong banner for the client (kraken riddles, etc.)."""
        self._flash_seq += 1
        self.flash = {"ok": bool(ok), "text": text, "seq": self._flash_seq}

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
    def _blocked(self, p: Player, nid: str) -> bool:
        """A rival's private Vale trails: invisible AND unwalkable — each
        captain's labyrinth belongs to them alone."""
        owner = self.board.nodes[nid].get("owner")
        return owner is not None and owner != p.pid

    def _wall(self, p: Player, nid: str) -> bool:
        """Nodes you cannot sail THROUGH — only (maybe) end a voyage on."""
        return self.board.nodes[nid]["type"] == "pharos"

    def _can_land(self, p: Player, nid: str) -> bool:
        # the Pharos SHORE is open to anyone — sail up, stand before the
        # great door, see it sealed. Only stepping THROUGH needs the seals
        # (enter_pharos guards that).
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
        side of the mountains.

        THE TYRANTS' ALTARS TAKE ANY ROLL: a lair your sail touches is
        always a legal landfall, however much die is left — no circling in
        front of the boss door to line up an exact count."""
        cur = {(p.node, None)}
        stops: set[str] = set()
        for step in range(steps):
            last = step == steps - 1
            nxt = set()
            for node, came in cur:
                nbrs = [nb for nb in self.board.neighbors[node]
                        if not self._blocked(p, nb)]
                fwd = [nb for nb in nbrs if nb != came] or list(nbrs)
                if not last and all(self._wall(p, nb) for nb in fwd):
                    fwd = list(nbrs)               # walled in: allowed to turn back
                for nb in fwd:
                    # A WALL is never sailed THROUGH. But a wall you may land on
                    # — the open Pharos door — is a valid finish on ANY roll that
                    # reaches it, just like a lair altar: no circling out front
                    # to line up an exact count.
                    if self._wall(p, nb):
                        if self._can_land(p, nb):
                            stops.add(nb)
                        continue
                    ntype = self.board.nodes[nb]["type"]
                    if ntype == "gate":
                        stops.add(nb)              # the pass halts the voyage
                        continue
                    if ntype == "monster" and self.board.nodes[nb].get("owner"):
                        # a hunting ground on the Vale's narrow trails HALTS
                        # the trek — the guarded door to the barrow is only
                        # passed by facing what holds it (open-water hunting
                        # grounds elsewhere never wall passage)
                        stops.add(nb)
                        continue
                    if ntype == "lair":
                        stops.add(nb)              # the altar takes ANY roll
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
        self._grow_vale()
        self.turn_idx = 0
        self._start_turn()

    def _grow_vale(self):
        """Each captain gets a private Amber Vale labyrinth; their barrow is
        on their map from the first turn — the golden beacon you steer by.
        Direction, never route."""
        lairs = self.board.grow_vale([p.pid for p in self.players])
        for p in self.players:
            p.seen.add(lairs[p.pid])

    def _start_turn(self):
        self.die = None
        self.reachable = {}
        self.walk = None
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
        # in the Vale, every stop this roll can land on is ALWAYS shown — and
        # so are the trails BETWEEN here and there, or a gale-boosted roll
        # would paint landing rings floating in the fog with no lane to them
        if steps > VALE_LANTERN:
            self._reveal_vale(p, radius=steps)
        p.seen.update(nid for nid in self.reachable
                      if self.board.nodes[nid].get("owner"))
        if not self.reachable:
            self._say(f"{p.name} is boxed in and waits out the tide.")
            self._end_turn()
            return
        # in the Vale the roll can also be STEERED: golden arrows offer each
        # trail out of your stop; tap one and the walk carries you that far,
        # pausing at every fork for the next arrow. (Landing beacons still
        # work as a direct pick until the first arrow commits you.)
        if self.board.nodes[p.node].get("region") == "autumn":
            self._begin_walk(p, steps)
        self._bump("sail")

    def sail(self, pid: str, node: str):
        self._require_turn(pid, "sail")
        if node not in self.reachable:
            raise GameError("Your ship cannot reach those waters.")
        p = self.current
        self.walk = None                     # a direct pick waives the arrows
        p.prev_node = p.node
        p.node = node
        self.reachable = {}
        self._land(p, node)

    # ── the Amber Vale's arrow-walk: steer the roll, fork by fork ────────────
    def _walk_ways(self, p: Player, node: str, came: str | None) -> list[str]:
        """Trails that open from a stop: your own maze (plus the pass home),
        never straight back the way you came — unless that is all there is."""
        nbrs = [nb for nb in self.board.neighbors.get(node, [])
                if not self._blocked(p, nb)
                and (self.board.nodes[nb].get("owner") == p.pid
                     or self.board.nodes[nb]["type"] == "gate")]
        return [nb for nb in nbrs if nb != came] or nbrs

    def _walk_halts(self, nid: str) -> bool:
        """Stops a walk the moment you step onto them: the pass, the barrow,
        camps, markets, oracles, unsolved spires and hunting grounds —
        plain trail stops are glided through."""
        n = self.board.nodes[nid]
        t = n["type"]
        if t in ("lair", "gate", "haven", "shop", "shrine", "monster"):
            return True
        if t == "puzzle" and not n.get("solved"):
            return True
        return bool(self.board.alive_monster(nid))

    def _begin_walk(self, p: Player, steps: int):
        ways = self._walk_ways(p, p.node, p.prev_node)
        if not ways:
            return                           # nothing to steer: beacons only
        self.walk = {"pid": p.pid, "node": p.node, "came": p.prev_node,
                     "steps": steps, "path": [p.node], "options": sorted(ways)}

    def walk_step(self, pid: str, node: str):
        """Take the golden arrow down a branch: the remaining roll glides
        along it, pausing at the next fork, halting at any real stop."""
        self._require_turn(pid, "sail")
        w = self.walk
        if not w or not w.get("options"):
            raise GameError("There is no trail to take here.")
        if node not in w["options"]:
            raise GameError("That trail does not open from here.")
        p = self.current
        self.reachable = {}                  # committed: steer by arrows now
        w["options"] = None
        self._walk_take(p, node)
        self._walk_advance(p)

    def _walk_take(self, p: Player, nxt: str):
        w = self.walk
        w["came"] = w["node"]
        w["node"] = nxt
        w["steps"] -= 1
        w["path"].append(nxt)
        self._reveal_vale(p, nid=nxt)        # the lantern walks with you

    def _walk_advance(self, p: Player):
        """Glide down corridors; pause at forks for the next arrow; halt at
        real stops, at trail's end, or when the roll runs out."""
        w = self.walk
        while w["steps"] > 0 and not self._walk_halts(w["node"]):
            fwd = [nb for nb in self._walk_ways(p, w["node"], w["came"])
                   if nb != w["came"]]
            if not fwd:
                break                        # the trail simply ends: make camp
            if len(fwd) > 1:
                w["options"] = sorted(fwd)   # a fork: wait for the next arrow
                self.nonce += 1
                return
            self._walk_take(p, fwd[0])
        self._walk_finish(p)

    def _walk_finish(self, p: Player):
        w = self.walk
        self.walk = None
        p.prev_node = w["path"][-2] if len(w["path"]) >= 2 else p.prev_node
        p.node = w["node"]
        self.reachable = {}
        self._land(p, w["node"])

    # ── the Amber Vale's fog: vision, never movement ─────────────────────────
    def _reveal_vale(self, p: Player, radius: int = VALE_LANTERN,
                     nid: str | None = None):
        """The captain's lantern: everything within ``radius`` hops of
        where they stand joins their personal map of the Vale — monotonic,
        the woods never go dark again. Covers a d3 from a standstill, so
        the maze is read a clearing at a time, not solved from above."""
        nid = nid or p.node
        node = self.board.nodes.get(nid)
        if not node or node.get("region") != "autumn":
            return
        depth = {nid: 0}
        frontier = [nid]
        while frontier:
            cur = frontier.pop(0)
            if depth[cur] >= radius:
                continue
            for nb in self.board.neighbors[cur]:
                if nb in depth or self._blocked(p, nb):
                    continue
                depth[nb] = depth[cur] + 1
                frontier.append(nb)
        p.seen.update(depth)

    # ── landing dispatch ─────────────────────────────────────────────────────
    def _land(self, p: Player, nid: str):
        node = self.board.nodes[nid]
        ntype = node["type"]
        self._reveal_vale(p)                 # the lantern lights the next bend
        if (node.get("owner") == p.pid
                and self.board.nodes.get(p.prev_node, {}).get("type") == "gate"):
            self._say(f"🍂 {p.name} passes beneath the amber boughs — "
                      f"the woods close behind.")
        # the Vale's HOARD: the dead-end cache pays like a real detour —
        # a hidden trove, once per voyage, worth steering a whole turn for
        if node.get("cache"):
            node["cache"] = False
            p.scrolls += 3
            self._say(f"⚱ {p.name} unearths a hoard beneath the leaves — +3 scrolls.")
        # a lost cache is picked up the moment you arrive — even if something is
        # about to rise up after it. On foot it's a dropped satchel in the dust;
        # at sea, flotsam hauled aboard.
        if ntype == "sea" and node.get("flotsam"):
            node["flotsam"] = False
            p.scrolls += 1
            if node.get("mode") == "foot":
                self._say(f"⚓ {p.name} finds a lost cache in the dust — +1 scroll.")
            else:
                self._say(f"⚓ {p.name} hauls drifting flotsam aboard — +1 scroll.")
        if node["type"] == "lair":
            if p.pid in node["defeated"]:
                if p.pid in node["stash"]:
                    node["stash"].remove(p.pid)
                    p.cargo.append(node["region"])
                    self._say(f"⚱ {p.name} reclaims the fragment of {node['name']}.")
                self._end_turn()
                return
            self.board.spawn_boss(nid)
            self.battle = {"node": nid, "stance": None, "round": 0,
                           "charging": False,
                           "used_items": [], "first_hit_taken": False}
            self._arm_battle()
            self._say(f"👑 {node['monster']['name']} rises — {p.name}'s trial begins!")
            self._bump("battle")
            return
        if ntype == "pharos":
            # The final door. Anyone may land on the shore and stand before
            # it; with the seals banked the CEREMONY plays (set the seals,
            # the leaves grind open, darkness spills out) and enter_pharos()
            # begins the trial. Without them there is only sealed bronze —
            # no handle, no keyhole — and the way back to your ship.
            if self._pharos_ok(p):
                self._say(f"🕯 {p.name} stands before the Pharos door — set the seals and enter.")
            else:
                self._say(f"🚪 {p.name} lands at the Pharos. The great door is "
                          f"sealed fast — three empty sockets, no way in. "
                          f"({p.banked}/{RELICS_TO_WIN} seals banked)")
            self._bump("pharos")
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

        # Danger by ground: an ELITE hunting ground bites EVERY time — the
        # Vale's door guard is a true toll — while weak packs keep a
        # depth-scaled chance. Realm open water can spring a sea attack
        # (deeper = surer; the Vale's quiet trails only rarely), and the
        # Isles of Peace are far calmer — but not empty.
        if node.get("encounter"):
            chance = (1.0 if node.get("elite")
                      else min(0.85, 0.45 + 0.1 * (node.get("depth") or 1)))
        elif ntype == "sea" and node.get("region") == "autumn":
            chance = 0.10          # the Vale's plain trail: a hush, mostly
        elif ntype == "sea" and node.get("region") == "desert":
            chance = 0.0           # the desert only stops you at its Sphinx gates
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
            guarded = bool(node.get("sword"))
            self.battle = {"node": nid, "stance": None, "round": 0,
                           "charging": False, "ambush": ambush or guarded,
                           "used_items": [], "first_hit_taken": False}
            self._arm_battle()
            if guarded:
                self._say(f"⚔ {p.name} sets foot on the islet — its four guardians "
                          f"rise as one to bar the way to the sword in the stone!")
            elif not node.get("encounter") and not ambush and ntype != "sea":
                self._say(f"{monster['name']} bars {p.name}'s way!")
            self._bump("battle")
            return

        # ── the SPHINX: the desert's toll-keeper. She bars your path at each of
        # the three marked gates — one riddle apiece. Answer it or fight the
        # pack she sends at you. She rises only ONCE per gate.
        if node.get("sphinx") and not node.get("sphinx_done"):
            deal = puzzles.deal_riddle(self.rng, self.used_puzzles)
            # stage the Sphinx in the BATTLE SCREEN — she rises before you like a
            # boss, but poses a riddle instead of trading blows: answer or be
            # swept back. The staged 'monster' is only for the diorama.
            node["monster"] = {"name": "The Sphinx", "tier": 2, "domain": "apollo",
                               "boss": True, "model": "sphinx", "riddle": True,
                               "enemies": [{"name": "The Sphinx", "hp": 1,
                                            "max_hp": 1, "power": 0, "model": "sphinx"}]}
            self.battle = {"node": nid, "sphinx": True, "stance": None, "round": 0,
                           "charging": False, "used_items": [], "first_hit_taken": False}
            self.minigame = {"kind": "riddle", "island": nid, "data": deal,
                             "limit": deal["limit"], "deadline": None,
                             "sphinx": True,
                             "text": deal["text"], "category": deal["category"]}
            self._say(f"🦁 The Sphinx blocks {p.name}'s path — "
                      f"answer her riddle, or fight the pack she sends!")
            self._bump("minigame")
            return

        if ntype == "gate":
            # the pass CARRIES YOU THROUGH: a beat after landfall the server
            # walks you on to the far side's NEAREST first waypoint, so you
            # spawn inside the region proper — never left standing in the
            # arch. Even a forked mouth (the Amber Vale's) advances to its
            # closest stop; the fork choice then happens from there.
            region = node.get("region")
            from_realm = (self.board.nodes.get(p.prev_node, {})
                          .get("region") == region)
            cands = [nb for nb in self.board.neighbors.get(nid, [])
                     if ((self.board.nodes[nb].get("region") == region)
                         != from_realm)
                     and self.board.nodes[nb].get("owner") in (None, p.pid)]
            if cands and not self.no_autowalk:
                gx, gz = node["x"], node["z"]
                dest = min(cands, key=lambda c: (self.board.nodes[c]["x"] - gx) ** 2
                           + (self.board.nodes[c]["z"] - gz) ** 2)
                self.gate_walk = {"pid": p.pid, "gate": nid, "to": dest}
            self._end_turn()
        elif ntype == "sea":
            self._end_turn()
        elif ntype == "home":
            self._bank(p)
            self._end_turn()
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
                if node.get("owner"):
                    # a hidden camp in a private labyrinth: the shared log
                    # never names a Vale stop
                    self._say(f"⚓ {p.name} makes camp in a hidden clearing "
                              f"of the Amber Vale.")
                else:
                    self._say(f"⚓ {p.name} makes camp — checkpoint set at {node['name']}.")
            self._bump("haven")        # repair or pass
        elif ntype == "shop":
            self._bump("shop")         # browse the trader's stall
        else:
            self._end_turn()                  # cleared / spent / empty waters

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

    def enter_pharos(self, pid: str):
        """Step THROUGH the open Pharos door. The seal-setting ceremony plays
        client-side; this begins the final trial against the Dark Presence."""
        self._require_turn(pid, "pharos")
        p = self.current
        nid = p.node
        if self.board.nodes[nid]["type"] != "pharos":
            raise GameError("There is no tower here.")
        if not self._pharos_ok(p):
            raise GameError("The door is sealed — bank three sigil seals to open it.")
        if not self.board.alive_monster(nid):
            self.board.reset_warden()          # a fresh Warden for this challenger
        self.battle = {"node": nid, "stance": None, "round": 0,
                       "charging": False,
                       "used_items": [], "first_hit_taken": False}
        self._arm_battle()
        self._say(f"🌑 The Pharos door yawns wide — the Dark Presence rises to meet {p.name}.")
        self._bump("battle")

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
        self._require_turn(pid, "shrine", "haven", "shop", "trade", "pharos")
        # leaving the land market or the trade beat ends the turn outright;
        # walking away from a shrine, haven or the sealed Pharos door still
        # earns the trade beat
        if self.phase in ("shop", "trade"):
            self._next_turn()
        else:
            self._end_turn()

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
        self._end_turn()

    # ── markets ──────────────────────────────────────────────────────────────
    # The BASIC market (consumables) travels with you, but the trader keeps
    # STRICT hours: he answers in the TRADE beat at the end of your turn —
    # after your sail has resolved, before the dice pass on — or ashore at a
    # market isle. Never before you roll. The shipwright's permanent wares —
    # fittings and legendary relics — are sold at LAND markets only.
    def shop_buy(self, pid: str, item: str):
        """Buy from the trader. Consumables cap at ITEM_CAP so nobody stacks
        buffs; a fitting ends the shop visit with an upgrade choice."""
        if not self.players or self.current.pid != pid \
                or self.phase not in ("shop", "trade"):
            raise GameError("The trader isn't listening right now.")
        p = self.current
        at_market = self.phase == "shop"
        remote = not at_market
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

    def buy_map(self, pid: str):
        """The trader unrolls his chart — for a price — and circles the hidden
        islet where the Sword of Damocles waits in the Isles of Peace."""
        if not self.players or self.current.pid != pid \
                or self.phase not in ("shop", "trade"):
            raise GameError("The trader isn't listening right now.")
        p = self.current
        if p.map_bought:
            return                          # already unrolled — read it freely
        if not getattr(self.board, "sword_node", None):
            raise GameError("The trader has no such chart.")
        if p.has("sword_of_damocles"):
            raise GameError("You already bear the Sword — the map is worthless to you.")
        if p.scrolls < MAP_COST:
            raise GameError(f"The trader wants {MAP_COST} scrolls to unroll his map.")
        p.scrolls -= MAP_COST
        p.map_bought = True
        self.nonce += 1
        self._say(f"🗺 {p.name} buys the trader's chart — a lone islet in the "
                  f"Isles of Peace is circled in red.")

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
            if self.phase not in ("roll", "sail", "battle", "shrine", "haven",
                                  "shop", "trade"):
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
            if self.question.get("typed"):
                raise GameError("A typed clue has no options to narrow.")
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
            if self.phase not in ("roll", "trade"):
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

    # ── enemy attack order ────────────────────────────────────────────────
    # Foes take turns striking back off an internal queue (never shown to the
    # player): every living foe gets its licks in, and none may strike more
    # than ATTACK_RUN_CAP times in a row.
    def _attack_queue(self, enemies) -> list[int]:
        b = self.battle
        q = [i for i in b.get("order", []) if enemies[i]["hp"] > 0]
        alive = [i for i, e in enumerate(enemies) if e["hp"] > 0]
        while alive and len(q) < 4:
            hist = (b.get("hist", []) + q)
            run = hist[-ATTACK_RUN_CAP:]
            cands = alive
            if (len(run) == ATTACK_RUN_CAP and len(set(run)) == 1
                    and len(alive) > 1):
                cands = [i for i in alive if i != run[0]]
            # lean toward foes that haven't struck lately, so the whole pack
            # stays in the fight — but let a foe press the attack sometimes
            recent = set(hist[-len(alive):]) if alive else set()
            fresh = [i for i in cands if i not in recent]
            if fresh and self.rng.random() < 0.65:
                q.append(self.rng.choice(fresh))
            else:
                q.append(self.rng.choice(cands))
        b["order"] = q
        return q

    def _arm_battle(self) -> None:
        """Seed the internal attack queue the moment a fight begins, so a
        counter-attacker is ready before the first stance is picked."""
        m = self.board.nodes[self.battle["node"]].get("monster")
        if m:
            self._attack_queue(m["enemies"])

    # ── dev cheats (unlocked with code 783 / DEV_CHEATS=1) ────────────────────
    def dev_grant_relics(self, pid: str) -> None:
        """Give the caller every legendary relic and a WINNING set of banked
        seals, then swing the Pharos open — so the endgame can be reached
        without hauling fragments home."""
        p = self.player_by_pid(pid)
        if not p:
            return
        for r in RELICS:
            if r not in p.upgrades:
                self._apply_upgrade(p, r)         # fire instant effects (Fleece heal, etc.)
        p.cargo = list(REGION_POOL.keys())        # one of every sigil aboard
        p.banked = max(p.banked, RELICS_TO_WIN)   # …and a full set already banked
        self.pharos_open = True
        self._say(f"⚜ [DEV] {p.name} is granted every relic and a full set of "
                  f"seals — the Pharos stands open.")
        self.nonce += 1

    def dev_fight(self, pid: str, spec: dict) -> None:
        """Spawn ANY enemy at the caller's current stop and open a battle —
        boss, warden, or a region pack, on demand."""
        p = self.player_by_pid(pid)
        if not p or p.node not in self.board.nodes:
            return
        monster = self._dev_monster(spec or {})
        if not monster:
            return
        idx = next((i for i, pl in enumerate(self.players) if pl.pid == pid), None)
        if idx is not None:
            self.turn_idx = idx                   # the fight belongs to the dev
        self.board.nodes[p.node]["monster"] = monster
        self.battle = {"node": p.node, "stance": None, "round": 0,
                       "charging": False, "ambush": False,
                       "used_items": [], "first_hit_taken": False}
        self._arm_battle()
        self._say(f"⚔ [DEV] {monster['name']} rise against {p.name}!")
        self._bump("battle")

    def _dev_monster(self, spec: dict) -> dict | None:
        """Build a monster dict from a dev fight spec: {kind:'boss'|'pack',
        region, tier, row}. Region '' / None means the open-sea rabble."""
        kind = spec.get("kind")
        region = spec.get("region") or None
        if kind == "boss":
            if region == "warden":
                return self.board._boss(WARDEN, self.rng, WARDEN_MODEL)
            info = REGION_POOL.get(region)
            return (self.board._boss(tuple(info["boss"]), self.rng, info["boss_model"])
                    if info else None)
        if kind == "pack":
            tier = max(0, min(2, int(spec.get("tier", 0))))
            if region in REGION_POOL:
                rows = REGION_POOL[region]["tiers"][tier]
            else:
                rows = ENCOUNTERS_LIGHT if tier == 0 else ENCOUNTERS_HEAVY
            row = spec.get("row")
            name, unit, hp, power, model = (
                rows[row] if isinstance(row, int) and 0 <= row < len(rows)
                else self.rng.choice(rows))
            count = int(spec["count"]) if spec.get("count") else (3 if hp <= 2 else 2)
            count = max(1, min(3, count))
            enemies = [{"name": f"{unit} {'ⅠⅡⅢ'[i]}" if count > 1 else unit,
                        "hp": hp, "max_hp": hp, "power": power, "model": model}
                       for i in range(count)]
            return {"name": name, "tier": 2 if tier == 0 else 3, "model": model,
                    "domain": self.rng.choice(DOMAINS), "enemies": enemies}
        return None

    def _advance_attacker(self, enemies) -> None:
        q = self._attack_queue(enemies)
        if not q:
            return
        i = q.pop(0)
        h = self.battle.setdefault("hist", [])
        h.append(i)
        del h[:-ATTACK_RUN_CAP]
        self._attack_queue(enemies)          # keep the queue topped up

    # ── the dodge (Paper-Mario action command) ────────────────────────────
    # There is no guard stance: when a foe strikes back, the captain gets a
    # DODGE_SECS beat to time a dodge. Read it right and half the blow is
    # nulled; the timing window itself lives client-side and is TIGHT.
    def dodge(self, pid: str, hit, full=False) -> None:
        self._require_turn(pid, "dodge")
        self._finish_dodge(bool(hit), bool(full))

    def dodge_timeout(self) -> None:
        if self.phase == "dodge":
            self._finish_dodge(False, False)

    def _finish_dodge(self, dodged: bool, full: bool = False) -> None:
        p = self.current
        inc = (self.battle or {}).get("incoming") or {}
        self.battle["incoming"] = None
        self.dodge_deadline = None
        m = self.board.nodes[self.battle["node"]]["monster"]
        boss = bool(m.get("boss"))
        attacker = inc.get("attacker", "the foe")
        heavy = bool(inc.get("heavy"))
        power = int(inc.get("power", 1))
        # the blow gets its own reveal, AFTER the answer's verdict has had its
        # beat on screen — carry your move's stats so the snapshot stays whole
        enemy_phase = dict(inc.get("move_phase") or {})
        enemy_phase.pop("pending", None)
        enemy_phase["enemy_turn"] = True

        # a successful dodge is a clean block: read the blow at all — gold OR
        # the bright core — and you slip it ENTIRELY, no damage. (The core still
        # reads as a "PERFECT!" on the wheel for flourish.) Freeze up or miss
        # the window and the blow lands full.
        full = bool(full) and dodged
        base = 0 if dodged else power
        hit_dmg, blocked = self._absorb(p, base)
        note = ""
        if blocked:
            note = "🛡 The aegis charm turns the blow. "
            enemy_phase["blocked"] = True
        elif p.has("aegis") and hit_dmg > 0 and not self.battle["first_hit_taken"]:
            hit_dmg = max(1, hit_dmg // 2)
            self.battle["first_hit_taken"] = True
            note = "Your Aegis shard flares — "
        enemy_phase["attacker"] = attacker
        enemy_phase["heavy"] = heavy
        enemy_phase["dodged"] = dodged
        enemy_phase["dmg"] = hit_dmg
        if not blocked:
            blow = "HEAVY blow" if heavy else "blow"
            if dodged and hit_dmg <= 0:
                note += f"🌀 You read {attacker}'s {blow} and slip clear!"
            elif dodged:
                note += (f"🌀 You twist aside — {attacker}'s {blow} "
                         f"only grazes for {hit_dmg}!")
            else:
                note += (f"💥 {attacker} lands a HEAVY blow for {hit_dmg}!"
                         if heavy else f"💥 {attacker} strikes for {hit_dmg}!")
        note = note.strip()
        p.hull -= hit_dmg

        battle_over = False
        player_dead = False
        if p.hull <= 0:
            battle_over = True
            player_dead = True
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

        # the ENEMY-TURN reveal: a bare beat for the blow itself (no question
        # card — that verdict already had its own reveal a moment ago)
        self._emit_battle_reveal(
            bool(inc.get("was_correct")), -2, None, {},
            "enemy", note, 0,
            battle_over, player_dead, enemy_phase)

    # ── battle (Paper-Mario turns: your move, then the enemies') ─────────────
    def stance(self, pid: str, stance: str, target: int = 0):
        self._require_turn(pid, "battle")
        if stance not in ("attack", "magic", "sword"):
            raise GameError("Choose STRIKE, MAGIC, or the SWORD.")
        node = self.board.nodes[self.battle["node"]]
        if stance == "sword":
            if not self.current.has("sword_of_damocles"):
                raise GameError("You bear no Sword of Damocles.")
            if node["type"] != "pharos":
                raise GameError("The Sword of Damocles answers only the Dark Presence.")
        m = self.board.alive_monster(self.battle["node"])
        enemies = m["enemies"]
        if not (0 <= target < len(enemies)) or enemies[target]["hp"] <= 0:
            target = next(i for i, e in enumerate(enemies) if e["hp"] > 0)
        boss = bool(m.get("boss")) or (not m.get("pack")
                                       and any(e["max_hp"] >= 5 for e in enemies))
        # STRIKE draws the easy tier; MAGIC and the SWORD both draw the hard tier-III pool
        tier = (2 if boss else 1) if stance == "attack" else 3
        self.battle["stance"] = stance
        self.battle["target"] = target

        # ── what challenge does this round pose? ─────────────────────────────
        # Every battle — pack OR boss alike — draws from THREE decks on the same
        # weighting: 31.25% general trivia (multiple-choice, from the live Trivia
        # API), 31.25% combat puzzles, 37.5% typed JEOPARDY! boards. Temples keep
        # the themed-category gimmick; battles don't. Combat puzzles can now
        # include a typed riddle (the Sphinx's toll turns up here too).
        r = self.rng.random()
        mode = ("puzzle" if r < 0.3125
                else ("mc" if r < 0.625 else "jeopardy"))
        forced = getattr(self, "_force_mode", None)     # DEV_CHEATS test hook only
        if forced:
            mode = forced
            self._force_mode = None
        if mode == "puzzle":
            deal = puzzles.deal_battle(self.rng, tier, self.used_puzzles)
            self.minigame = {"kind": deal["kind"], "island": self.battle["node"],
                             "data": deal, "limit": deal["limit"],
                             "deadline": None, "battle": True}
            self.qctx = None
            self.question = None
            self.side_answers = {}
            self._bump("minigame")
            return
        self.qctx = {"kind": "battle", "island": self.battle["node"],
                     "tier": tier, "domain": None, "mode": mode}
        self.question = None
        self.side_answers = {}
        if mode == "jeopardy":
            # a JEOPARDY! board: four categories to choose from. STRIKE deals the
            # low money ($200/$400), MAGIC the high ($800/$1000). The chosen clue
            # becomes the typed question.
            band = "high" if stance == "magic" else "low"
            self.jboard = {"band": band, "node": self.battle["node"],
                           "cells": questions.jeopardy_board(self.rng, band)}
            self.jchoose_deadline = None
            self._bump("jchoose")
            return
        # MC trivia shares the question phase; the server fetches from `mode`.
        self._bump("question")

    def jpick(self, pid: str, idx: int):
        """Choose one of the four Jeopardy categories on the board; that clue
        becomes the typed question."""
        self._require_turn(pid, "jchoose")
        board = self.jboard
        if not board or not (0 <= idx < len(board["cells"])):
            raise GameError("Pick a category.")
        self._pending_jeopardy = questions.jeopardy_question(board["cells"][idx])
        self.jboard = None
        self.jchoose_deadline = None
        self.question = None
        self._bump("question")

    def jchoose_timeout(self):
        """No pick in time — the board makes the choice for you."""
        if self.phase == "jchoose" and self.jboard:
            self.jpick(self.current.pid, self.rng.randrange(len(self.jboard["cells"])))

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
        if item == "owl" and self.question.get("typed"):
            raise GameError("The Owl can't narrow a typed clue.")
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
                # a Vale seal drifts back to YOUR barrow — every captain's
                # labyrinth (and altar) is their own
                if (node.get("region") == theme
                        and node.get("owner") in (None, p.pid)
                        and p.pid not in node["stash"]):
                    node["stash"].append(p.pid)       # waits at the altar for you
                    returned.append(node["name"])
        p.cargo = []
        p.scrolls //= 2
        if p.checkpoint not in self.board.nodes:
            p.checkpoint = "home"
        p.node = p.checkpoint
        p.prev_node = p.checkpoint
        p.hull = p.max_hull
        cp = self.board.nodes[p.checkpoint]
        where = ("their hidden camp in the Amber Vale" if cp.get("owner")
                 else cp["name"])
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
        if self.question.get("typed"):
            raise GameError("A typed clue is the challenger's alone.")
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
        if self.question.get("typed"):
            raise GameError("Type your answer for this clue.")
        if idx in self.question.get("disabled", []):
            raise GameError("The Owl has ruled that answer out.")
        self._resolve_question(idx == self.question["correct"], idx)

    def answer_text(self, pid: str, text: str):
        """Typed JEOPARDY! answer — free text, matched leniently (see
        questions.check_jeopardy). Sentinel idx -3 marks a typed response."""
        self._require_turn(pid, "question")
        if self.question is None:
            raise GameError("The clue is still on its way.")
        if not self.question.get("typed"):
            raise GameError("This one's multiple choice.")
        ok = questions.check_jeopardy(str(text or ""), self.question["answer"])
        self._resolve_question(ok, -3)

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
                ok = sidx == self.question.get("correct")
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
            typed = bool(self.question.get("typed"))
            side = self._settle_side_answers()
            self._resolve_battle(correct, idx, self.question.get("correct"), side,
                                 challenge="jeopardy" if typed else "trivia")
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
        player_dead = False
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
            elif correct and stance == "sword":
                dmg = SWORD_DMG
                note = f"🗡 The Sword of Damocles falls on {tgt['name']} for {dmg}!"
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
                        # victory carries you home: no long haul back through
                        # the realm — the tide bears you to Home Port and the
                        # seal goes straight into the vault (hull patched, as
                        # any homecoming does)
                        p.prev_node = p.node
                        p.node = "home"
                        self._bank(p)
                        note += " ⚓ The tide bears you HOME — the seal is banked."
                    # spoils: one scroll per basic foe, ten for a boss-tier one
                    loot = sum(10 if e["max_hp"] >= 5 else 1 for e in enemies)
                    p.scrolls += loot
                    gained = loot
                    if node.get("encounter") or node["type"] == "sea":
                        node["monster"] = None     # the waters fall quiet — for now
                    # the islet's guardians are down — the sword is yours to draw
                    if node.get("sword") and not p.has("sword_of_damocles"):
                        p.upgrades.append("sword_of_damocles")
                        self._sword_claimed = True
                        note += (" 🗡 Beyond the fallen guard a sword juts from a "
                                 "weathered stone — you set your hand to it.")
            else:
                # ── the enemies' move ────────────────────────────────────────
                # EVERY foe answers EVERY exchange now — no more "your right
                # answer makes them whiff." The DODGE is the only way a blow
                # is turned aside. The counter does NOT land yet: first the
                # reveal shows how YOUR move went, then the foe winds up and
                # the DODGE action command interrupts.
                front_idx = self._attack_queue(enemies)[0]
                front = enemies[front_idx]
                if not correct and stance == "magic" and not boss:
                    hit, blocked = self._absorb(p, MAGIC_BACKFIRE)
                    enemy_phase["backfire"] = True
                    enemy_phase["dmg"] = hit
                    note = ("🛡 The aegis charm eats the backfire."
                            if blocked else f"🔥 The spell backfires — {hit} damage!")
                    p.hull -= hit
                else:
                    self._advance_attacker(enemies)
                    # bosses ALL land in the 2–4 band (a telegraphed heavy sits
                    # at the top of it); packs strike for their own power
                    if boss:
                        power = min(4, max(2, front["power"] * (HEAVY_MULT if heavy else 1)))
                    else:
                        power = front["power"]
                    enemy_phase["attacker"] = front["name"]
                    enemy_phase["pending"] = True   # a blow hangs over the reveal
                    self.battle["incoming"] = {
                        "attacker_idx": front_idx, "attacker": front["name"],
                        "power": power, "heavy": heavy,
                        "was_correct": correct,
                        "move_phase": dict(enemy_phase),
                    }

                if p.hull <= 0:               # only the backfire bites here
                    battle_over = True
                    player_dead = True
                    node = self.board.nodes[self.battle["node"]]
                    if node["type"] == "pharos":
                        self.board.reset_warden()   # a fresh Warden per challenger
                    self._shipwreck(p)

        self._emit_battle_reveal(correct, idx, correct_idx, side or {},
                                 challenge, note, gained,
                                 battle_over, player_dead, enemy_phase)

    def _emit_battle_reveal(self, correct, idx, correct_idx, side, challenge,
                            note, gained, battle_over, player_dead,
                            enemy_phase):
        self._last_enemy_phase = enemy_phase
        self.reveal = {
            "correct": correct_idx, "chosen": idx,
            "was_correct": correct, "note": note, "gained": gained,
            "kind": "battle", "challenge": challenge,
            "domain": (self.qctx or {}).get("domain"), "side": side or {},
            "battle_over": battle_over,
            "player_dead": player_dead,
            "enemy_phase": enemy_phase,
            "monster": self._battle_public(),
            # the sword-in-the-stone beat: set on the exchange that clears the
            # islet's guardians, so the client can play the draw + shine + claim
            "sword_claimed": getattr(self, "_sword_claimed", False),
        }
        self._sword_claimed = False
        # typed JEOPARDY! rounds have no options to light up — reveal the answer
        # text and flash the verdict so the challenger sees right/wrong at a glance
        q = self.question or {}
        if q.get("typed"):
            ans = q.get("answer", "")
            self.reveal["typed"] = True
            self.reveal["answer_text"] = ans
            self.reveal["category"] = q.get("category", "")
            self._flash(correct, "Correct!" if correct
                        else (f"Wrong — the answer was {ans}" if ans else "Wrong!"))
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
        # a counter hangs over this reveal — now that YOUR move has been shown
        # plainly, the foe winds up and the DODGE action command interrupts
        if self.battle and self.battle.get("incoming") and not rv.get("battle_over"):
            self._bump("dodge")
            return
        if self.winner:
            self._bump("finished")
        elif self.upgrade_offer:
            self._bump("upgrade_pick")
        elif self.battle and not rv.get("battle_over"):
            self._bump("battle")           # next round: choose a stance again
        else:
            self._end_turn()

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
            elif mg["kind"] in ("simon", "memory", "ravens", "visual_memory"):
                # a ONE-ATTEMPT trial (echo the tones, the one missing pattern
                # tile, or the flashed board recalled until the lives run out):
                # the result stands whether right or wrong — a miss is a botched
                # round, not a free retry. (Without ravens here a wrong tile
                # only raised "not solved" and let you keep clicking, so the
                # fight seemed to accept ONLY the correct tile.)
                self.minigame = None
                self._resolve_battle(False, -2, None, challenge="puzzle")
            else:
                raise GameError("Not solved — the enemy circles…")
            return
        if mg.get("kraken"):
            if ok:
                self._flash(True, "Correct!")
                self._kraken_next()
            else:
                self._flash(False, "Wrong — the Kraken drags you under. Lose a turn!")
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
        elif mg["kind"] in ("simon", "memory", "ravens", "visual_memory"):
            # a one-attempt challenge (the echo, the pattern tile, the flashed
            # board): one failed run ENDS it — no reward, no retry at the obelisk
            self._puzzle_fail(mg["island"])
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
            self._end_turn()
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
    def _clear_sphinx_stage(self):
        """Tear down the staged Sphinx battle-screen diorama (she never fights)."""
        if self.battle and self.battle.get("sphinx"):
            node = self.board.nodes.get(self.battle["node"], {})
            if isinstance(node.get("monster"), dict) and node["monster"].get("riddle"):
                node["monster"] = None
            self.battle = None

    def _sphinx_pass(self):
        nid = self.battle["node"] if self.battle else self.current.node
        node = self.board.nodes.get(nid)
        if node is not None:
            node["sphinx_done"] = True    # this gate is answered — she stays down
        self._clear_sphinx_stage()
        self.minigame = None
        self._say(f"🦁 The Sphinx bows her head — {self.current.name} may pass.")
        self._end_turn()

    def _sphinx_fail(self):
        # Miss the riddle and she sends her pack: the diorama swaps from the
        # riddling Sphinx to a real fight, right here on the gate.
        p = self.current
        nid = self.battle["node"] if self.battle else p.node
        ans = puzzles.answer_text("riddle", self.minigame.get("data")) if self.minigame else ""
        self._clear_sphinx_stage()
        self.minigame = None
        self._flash(False, f"Wrong — the answer was {ans}" if ans else "The Sphinx sends her guard!")
        node = self.board.nodes.get(nid)
        if node is None:                  # safety: nothing to fight, just move on
            self._next_turn()
            return
        node["sphinx_done"] = True        # she has risen; the fight settles the gate
        node["monster"] = self.board.random_pack(node, self.rng)
        monster = node["monster"]
        self.battle = {"node": nid, "stance": None, "round": 0,
                       "charging": False, "ambush": True,
                       "used_items": [], "first_hit_taken": False}
        self._arm_battle()
        self._say(f"🦁 Wrong! The Sphinx sends her guard at {p.name} — "
                  f"{monster['name']} close in!")
        self._bump("battle")

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
        ans = puzzles.answer_text(kind, self.minigame.get("data")) if self.minigame else ""
        self.minigame = None
        self._flash(False, f"Wrong — the answer was {ans}" if ans else "Time's up!")
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

    def _end_turn(self):
        """A LAST WORD WITH THE TRADER: a normal turn doesn't pass the dice
        until the acting captain says so — one quiet beat to spend scrolls
        before the tide turns. Punishment endings (shipwreck, the kraken's
        lost turn, the Sphinx's sweep) skip the beat and advance hard."""
        if self.winner:
            self._bump("finished")
            return
        self._bump("trade")

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
        self._grow_vale()                  # fresh private labyrinths too
        self.winner = None
        self.battle = None
        self.dodge_deadline = None
        self.gate_walk = None
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
        boss = bool(m.get("boss")) or (not m.get("pack")
                                       and any(e["max_hp"] >= 5 for e in m["enemies"]))
        return {"name": m["name"], "tier": m["tier"], "domain": m["domain"],
                "boss": boss, "model": m.get("model"),
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
                # sent explicitly: spectators may get a VEILED node id (a
                # private Vale fight), so the client can't look mode up
                "mode": node.get("mode"),
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
            if node.get("flotsam") or node.get("cache"):
                base["flotsam"] = True     # the Vale's hoard wears the same marker
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

    def _vale_shown(self, viewer_pid: str | None):
        """Which nodes a viewer may see. Everything unowned is public; a
        captain's private Vale trails show only to THEM, and only the stops
        their lantern has found (their own barrow is seeded from turn one —
        the beacon). An anonymous viewer (spectator socket, lost token) is
        NOT a debug backdoor: they see no private ground at all."""
        viewer = self.player_by_pid(viewer_pid) if viewer_pid else None

        def shown(nid):
            owner = self.board.nodes[nid].get("owner")
            if owner is None:
                return True
            if viewer is None or owner != viewer_pid:
                return False
            # you never lose sight of the ground you stand on, whatever
            # state got you there (reconnects, dev drops)
            return nid in viewer.seen or nid == viewer.node
        return shown

    def to_dict(self, viewer_pid: str | None = None) -> dict:
        shown = self._vale_shown(viewer_pid)
        viewer = self.player_by_pid(viewer_pid)
        nodes = [self._node_view(nid) for nid in self.board.nodes if shown(nid)]
        edges = [[a, b] for a, b in self.board.edges if shown(a) and shown(b)]
        # rivals inside their own labyrinth are VEILED: from outside you see
        # them make landfall at the pass, and nothing more until they emerge
        gate = getattr(self.board, "vale_gate", None)
        players = []
        for p in self.players:
            d = p.public()
            if gate:
                if not shown(d["node"]):
                    d["node"] = gate
                    d["veiled"] = True
                if not shown(d["checkpoint"]):
                    d["checkpoint"] = gate
            players.append(d)
        # a battle fought inside a private labyrinth: spectators get the fight
        # (the diorama needs no chart), but the stop id itself stays veiled
        battle = self._battle_public()
        if battle and gate and not shown(battle["node"]):
            battle = {**battle, "node": gate}
        reveal = self.reveal if self.phase == "reveal" else None
        if (reveal and reveal.get("monster")
                and gate and not shown(reveal["monster"]["node"])):
            reveal = {**reveal, "monster": {**reveal["monster"], "node": gate}}
        minigame = ({k: v for k, v in {**self.minigame,
                     **self.minigame["data"]}.items()
                     if k not in ("data", "secret")}
                    if self.phase == "minigame" and self.minigame else None)
        if minigame and gate and not shown(minigame.get("island", "home")):
            minigame = {**minigame, "island": gate}
        # the arrow-walk is the walker's own business: only they get it
        walk = None
        if self.walk and viewer_pid == self.walk["pid"]:
            walk = {"node": self.walk["node"], "steps": self.walk["steps"],
                    "options": self.walk["options"]}
        q = None
        if self.question is not None:
            # typed JEOPARDY! clues have NO options — indexing ["options"]
            # here crashed EVERY snapshot the moment a jeopardy round was
            # dealt, freezing the whole table on "A herald fetches the
            # question…" (and hiding that jeopardy existed at all). The
            # answer itself never ships to clients.
            q = {"text": self.question["text"],
                 "options": self.question.get("options", []),
                 "typed": bool(self.question.get("typed")),
                 "category": self.question.get("category", ""),
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
            "players": players,
            # the islet the trader's map circles — only revealed to a buyer
            "sword_node": (getattr(self.board, "sword_node", None)
                           if viewer and viewer.map_bought else None),
            "host": self.players[0].pid if self.players else None,
            "turn": self.current.pid if self.players and self.phase != "lobby" else None,
            "die": self.die,
            "reachable": self.reachable if (self.players and self.phase != "lobby"
                          and self.current.pid == viewer_pid) else {},
            "walk": walk,
            "question": q,
            # the JEOPARDY! board: four categories to pick from (clue text and
            # answers stay server-side — only the category + value show)
            "jboard": ({"band": self.jboard["band"],
                        "deadline": self.jchoose_deadline,
                        "cells": [{"category": c["category"], "value": c["value"]}
                                  for c in self.jboard["cells"]]}
                       if self.phase == "jchoose" and self.jboard else None),
            # the incoming blow awaiting its dodge (Paper-Mario action beat)
            "dodge": ({"attacker": self.battle["incoming"]["attacker"],
                       "attacker_idx": self.battle["incoming"]["attacker_idx"],
                       "power": self.battle["incoming"]["power"],
                       "heavy": self.battle["incoming"]["heavy"],
                       "deadline": self.dodge_deadline}
                      if self.phase == "dodge" and self.battle
                      and self.battle.get("incoming") else None),
            "side_answered": list(self.side_answers.keys()),
            "reveal": reveal,
            "battle": battle,
            "minigame": minigame,
            "upgrade_offer": self.upgrade_offer if self.phase == "upgrade_pick" else None,
            "upgrade_info": ALL_UPGRADES,
            "pharos_open": self.pharos_open,
            "flash": self.flash,
            "winner": self.winner,
            "log": self.log,
            "config": {"relics_to_win": RELICS_TO_WIN, "tier_reward": TIER_REWARD,
                       "streak_at": STREAK_AT, "max_hull": MAX_HULL,
                       "flee_cost": FLEE_COST, "shop_items": SHOP_ITEMS,
                       "relics": RELICS, "item_cap": ITEM_CAP,
                       "die_sides": 3, "heavy_every": HEAVY_EVERY,
                       "heavy_mult": HEAVY_MULT, "planks_heal": PLANKS_HEAL,
                       # every monster model a realm can field, so the client
                       # preloads a region's whole bestiary on arrival
                       "region_models": REGION_MODELS,
                       # the dev fight menu (code 783): every boss + pack by name
                       "dev_bestiary": {
                           "warden": WARDEN[0],
                           "regions": {r: {"boss": info["boss"][0],
                                           "tiers": [[row[0] for row in tier]
                                                     for tier in info["tiers"]]}
                                       for r, info in REGION_POOL.items()}}},
        }

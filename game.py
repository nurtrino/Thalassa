"""
Thalassa rules engine — the Race for the Golden Fleece. Pure state machine.

The server owns dice RNG, question fetching, and timers; this module owns
the rules. Every mutation either succeeds or raises GameError.

The voyage: a fog-covered procedural archipelago. Sail out, answer trivia at
shrines for scrolls, solve brain-teaser puzzles for ship upgrades, and fight
the monsters guarding relic lairs. Haul relics HOME to bank them — cargo is
lost if your ship goes down. Bank RELICS_TO_WIN relics and the Isle of the
Fleece appears: beat the Colchian Dragon there and the Fleece — and the
game — is yours.

Phases:
    lobby → roll → sail → (shrine | haven | battle | question …) → reveal → …
                                     battle: stance → question → reveal → stance…
    puzzle success → upgrade_pick.   finished when someone claims the Fleece.

Fog of war is per player: `known` nodes show their true type, `seen` nodes
are silhouettes, everything else is open sea. You can sail only through
known, safe water; entering a silhouette ends your movement (exploration).

Battles are stance (strategy) → question (trivia) → damage die (luck):
    ATTACK  correct → your die +1 damage   wrong → take power +1
    GUARD   correct → your die −1 (min 1)  wrong → take power −1 (min 1)
    FLEE    scrape away: lose 1 hull, retreat to the node you came from
Hull 0 = shipwreck: unbanked relics return to their lairs (guardians rise
again), scrolls halved, ship limps home. Never eliminated.
"""
from __future__ import annotations

import random

import puzzles
from board import Board, DOMAIN_INFO, DOMAINS, RELICS_TO_WIN

# ── tunables ─────────────────────────────────────────────────────────────────
MIN_PLAYERS = 1                    # solo runs are allowed for testing
MAX_PLAYERS = 6
TIER_REWARD = {1: 1, 2: 2, 3: 3}   # scrolls for a correct shrine wager
TIER3_PENALTY = 1
MAX_HULL = 6
DMG_TABLE = {1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3}    # damage die → damage
MONSTER_LOOT = {2: 2, 3: 3, 4: 4, 5: 0}             # scrolls by monster max_hp
STREAK_AT = 3                      # correct-answer streak that pays a bonus
SIDE_REWARD = 1                    # scrolls for a correct side answer

COLORS = ["#e4572e", "#2e86ab", "#f6ae2d", "#8e5572", "#33ca7f", "#6457a6"]

UPGRADES = {
    "ram":        {"name": "Bronze Ram",        "desc": "+1 damage on every strike"},
    "hull_plates": {"name": "Oak Hull Plates",  "desc": "+2 max hull (and heal 2 now)"},
    "star_chart": {"name": "Star Chart",        "desc": "Landing reveals two waves of islands"},
    "sandals":    {"name": "Hermes' Sandals",   "desc": "+1 to every movement roll"},
    "owl":        {"name": "Owl of Athena",     "desc": "Once per battle: remove 2 wrong options"},
    "lyre":       {"name": "Lyre of Orpheus",   "desc": "Once per battle: swap the question"},
    "boar_spear": {"name": "Boar Spear",        "desc": "Critical hits on 5 and 6"},
    "aegis":      {"name": "Aegis Shard",       "desc": "The first hit you take each battle is halved"},
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
        self.scrolls = 3                   # seed money for the first shrine misses
        self.hull = MAX_HULL
        self.max_hull = MAX_HULL
        self.cargo: list[int] = []         # relic numbers aboard (not yet safe)
        self.banked = 0
        self.upgrades: list[str] = []
        self.streak = 0
        self.known: set[str] = set()       # fog: full knowledge
        self.seen: set[str] = set()        # fog: silhouettes

    def has(self, upgrade: str) -> bool:
        return upgrade in self.upgrades

    def public(self) -> dict:
        return {
            "pid": self.pid, "name": self.name, "color": self.color,
            "node": self.node, "scrolls": self.scrolls,
            "hull": self.hull, "max_hull": self.max_hull,
            "cargo": len(self.cargo), "banked": self.banked,
            "upgrades": self.upgrades, "streak": self.streak,
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
        self.fleece_revealed = False
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

    # ── fog of war ───────────────────────────────────────────────────────────
    def _reveal_for(self, p: Player, nid: str):
        """Landing on nid: it becomes known; neighbors become silhouettes.
        A Star Chart pushes both waves one ring further."""
        p.known.add(nid)
        p.seen.add(nid)
        for nb in self.board.neighbors[nid]:
            p.seen.add(nb)
            if p.has("star_chart"):
                p.known.add(nb)
                for nb2 in self.board.neighbors[nb]:
                    p.seen.add(nb2)

    def _passable(self, p: Player, nid: str) -> bool:
        """Can p sail THROUGH nid (not merely stop there)?"""
        if nid not in p.known:
            return False
        node = self.board.nodes[nid]
        if node["type"] == "fleece":
            return False
        if self.board.alive_monster(nid):
            return False
        return True

    def _reachable_for(self, p: Player, steps: int) -> dict[str, int]:
        dist = {p.node: 0}
        frontier = [p.node]
        while frontier:
            nxt = []
            for nid in frontier:
                d = dist[nid]
                if d == steps or (nid != p.node and not self._passable(p, nid)):
                    continue                       # stop-nodes end movement
                for nb in self.board.neighbors[nid]:
                    if nb in dist or nb not in p.seen:
                        continue
                    if self.board.nodes[nb]["type"] == "fleece" and not self._fleece_ok(p):
                        continue
                    dist[nb] = d + 1
                    nxt.append(nb)
            frontier = nxt
        dist.pop(p.node, None)
        return dist

    def _fleece_ok(self, p: Player) -> bool:
        return self.fleece_revealed and p.banked >= RELICS_TO_WIN

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
        for p in self.players:
            self._reveal_for(p, "home")
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
        steps = die + (1 if p.has("sandals") else 0)
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
        self._reveal_for(p, node)
        self._land(p, node)

    # ── landing dispatch ─────────────────────────────────────────────────────
    def _land(self, p: Player, nid: str):
        node = self.board.nodes[nid]
        ntype = node["type"]
        monster = self.board.alive_monster(nid)
        if monster:
            self.battle = {"node": nid, "stance": None,
                           "used_items": [], "first_hit_taken": False}
            self._say(f"{monster['name']} bars {p.name}'s way!")
            self._bump("battle")
            return
        if ntype == "home":
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
            if p.hull < p.max_hull and p.scrolls > 0:
                self._bump("haven")
            else:
                self._next_turn()
        else:
            self._next_turn()                 # cleared / spent / empty waters

    def _bank(self, p: Player):
        if p.cargo:
            n = len(p.cargo)
            p.banked += n
            p.cargo = []
            self._say(f"{p.name} banks {n} relic{'s' if n > 1 else ''}! ({p.banked}/{RELICS_TO_WIN})")
        p.hull = p.max_hull
        if p.banked >= RELICS_TO_WIN and not self.fleece_revealed:
            self.fleece_revealed = True
            for q in self.players:
                q.seen.add("fleece")
                q.known.add("fleece")
            self._say("⚡ The Isle of the Golden Fleece emerges from the mist!")

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
        self._require_turn(pid, "shrine", "haven")
        self._next_turn()

    # ── haven ────────────────────────────────────────────────────────────────
    def repair(self, pid: str):
        self._require_turn(pid, "haven")
        p = self.current
        missing = p.max_hull - p.hull
        spend = min(missing, p.scrolls)
        if spend <= 0:
            raise GameError("Nothing to repair (or no scrolls).")
        p.scrolls -= spend
        p.hull += spend
        self._say(f"{p.name} patches {spend} hull at the haven.")
        self._next_turn()

    # ── battle ───────────────────────────────────────────────────────────────
    def stance(self, pid: str, stance: str):
        self._require_turn(pid, "battle")
        if stance not in ("attack", "guard"):
            raise GameError("Choose ATTACK or GUARD.")
        m = self.board.alive_monster(self.battle["node"])
        self.battle["stance"] = stance
        self.qctx = {"kind": "battle", "island": self.battle["node"],
                     "tier": m["tier"], "domain": m["domain"]}
        self.question = None
        self.side_answers = {}
        self._bump("question")

    def flee(self, pid: str):
        self._require_turn(pid, "battle")
        p = self.current
        p.hull -= 1
        m = self.board.alive_monster(self.battle["node"])
        self._say(f"{p.name} breaks off from {m['name']}, hull scraped.")
        if p.hull <= 0:
            self._shipwreck(p)
        else:
            p.node = p.prev_node
        self.battle = None
        self._next_turn()

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
        for relic in p.cargo:
            for nid in self.board.lairs():
                node = self.board.nodes[nid]
                if node.get("relic") == relic:
                    node["monster"]["hp"] = node["monster"]["max_hp"]
                    node["taken"] = False
                    returned.append(node["name"])
        p.cargo = []
        p.scrolls //= 2
        p.node = "home"
        p.prev_node = "home"
        p.hull = p.max_hull
        msg = f"☠ {p.name}'s ship goes down! The crew washes ashore at Home Port."
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
            m = self.board.alive_monster(self.battle["node"])
            stance = self.battle["stance"]
            if correct:
                self._streak_bonus(p)
                roll = self.rng.randint(1, 6)
                crit_at = 5 if p.has("boar_spear") else 6
                dmg = 3 if roll >= crit_at else DMG_TABLE[roll]
                if p.has("ram"):
                    dmg += 1
                if stance == "attack":
                    dmg += 1
                else:
                    dmg = max(1, dmg - 1)
                m["hp"] -= dmg
                note = f"⚔ You strike for {dmg} (rolled {roll})!"
                if m["hp"] <= 0:
                    battle_over = True
                    note += f" {m['name']} is defeated!"
                    loot = MONSTER_LOOT.get(m["max_hp"], 2)
                    node = self.board.nodes[self.battle["node"]]
                    if node["type"] == "fleece":
                        self.winner = p.pid
                        note = f"🏆 {m['name']} falls — {p.name} seizes the GOLDEN FLEECE!"
                    elif node.get("relic") and not node.get("taken"):
                        node["taken"] = True
                        p.cargo.append(node["relic"])
                        note += f" The relic is aboard — sail it home!"
                    if loot:
                        p.scrolls += loot
                        gained = loot
            else:
                p.streak = 0
                hit = m["power"] + (1 if stance == "attack" else -1)
                hit = max(1, hit)
                if p.has("aegis") and not self.battle["first_hit_taken"]:
                    hit = max(1, hit // 2)
                    self.battle["first_hit_taken"] = True
                    note = "Your Aegis shard flares — "
                p.hull -= hit
                note += f"💥 {m['name']} strikes for {hit}!"
                if p.hull <= 0:
                    battle_over = True
                    self._shipwreck(p)

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
            "monster": self._battle_public() if kind == "battle" else None,
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
    def minigame_submit(self, pid: str, payload):
        self._require_turn(pid, "minigame")
        mg = self.minigame
        if puzzles.check(mg["kind"], mg["data"], payload):
            self._puzzle_success(mg["island"])
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
        self.minigame = None
        self._say(f"The puzzle of {self.board.nodes[nid]['name']} defeats {p.name} — it can be tried again.")
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
        self.fleece_revealed = False
        self.used_puzzles = set()
        self.log = []
        self.turn_idx = 0
        for p in self.players:
            self._reveal_for(p, "home")
        self._start_turn()

    # ── snapshots (per viewer — fog!) ────────────────────────────────────────
    def _battle_public(self) -> dict | None:
        if not self.battle:
            return None
        m = self.board.nodes[self.battle["node"]].get("monster")
        if not m:
            return None
        node = self.board.nodes[self.battle["node"]]
        return {"name": m["name"], "hp": max(0, m["hp"]), "max_hp": m["max_hp"],
                "power": m["power"], "tier": m["tier"], "domain": m["domain"],
                "node": self.battle["node"], "is_lair": node["type"] == "lair",
                "is_fleece": node["type"] == "fleece",
                "used_items": self.battle["used_items"]}

    def _node_view(self, nid: str, viewer: Player | None) -> dict | None:
        node = self.board.nodes[nid]
        full = viewer is None or self.phase == "finished"
        if not full and nid not in viewer.seen:
            return None
        base = {"id": nid, "x": node["x"], "z": node["z"], "band": node["band"]}
        if not full and nid not in viewer.known:
            base["type"] = "mist"
            base["name"] = "Uncharted Isle"
            return base
        base["type"] = node["type"]
        base["name"] = node["name"]
        if node["type"] == "shrine":
            base["domain"] = node["domain"]
            base["charges"] = node["charges"]
            base["tier"] = node["tier"]
        elif node["type"] == "puzzle":
            base["solved"] = node.get("solved", False)
        elif node["type"] in ("monster", "lair", "fleece"):
            m = node.get("monster")
            base["monster"] = None if not m or m["hp"] <= 0 else {
                "name": m["name"], "hp": m["hp"], "max_hp": m["max_hp"],
                "power": m["power"], "domain": m["domain"]}
            if node["type"] == "lair":
                base["relic_taken"] = node.get("taken", False)
        return base

    def to_dict(self, viewer_pid: str | None = None) -> dict:
        viewer = self.player_by_pid(viewer_pid) if viewer_pid else None
        nodes = []
        for nid in self.board.nodes:
            if self.board.nodes[nid]["type"] == "fleece" and not self.fleece_revealed \
                    and self.phase != "finished":
                continue
            v = self._node_view(nid, viewer)
            if v:
                nodes.append(v)
        shown = {n["id"] for n in nodes}
        edges = [[a, b] for a, b in self.board.edges if a in shown and b in shown]

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
                      "domains": DOMAIN_INFO, "home": "home"},
            "players": [p.public() for p in self.players],
            "host": self.players[0].pid if self.players else None,
            "turn": self.current.pid if self.players and self.phase != "lobby" else None,
            "die": self.die,
            "reachable": self.reachable if viewer is None or
                         (self.players and self.current.pid == viewer_pid) else {},
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
            "fleece_revealed": self.fleece_revealed,
            "winner": self.winner,
            "log": self.log,
            "config": {"relics_to_win": RELICS_TO_WIN, "tier_reward": TIER_REWARD,
                       "streak_at": STREAK_AT, "max_hull": MAX_HULL},
        }

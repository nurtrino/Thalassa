"""
Thalassa rules engine — pure state machine, no IO.

The server owns dice RNG, question fetching, and timers; this module owns the
rules. Every mutation is a method that either succeeds or raises GameError
with a player-readable message.

Flow of one turn:
    roll ──► sail ──► (island action) ──► question ──► reveal ──► next turn
                         │                                 │
                         ├─ library: wager tier / trial    ├─ oracle win: claim
                         ├─ oracle: accept / pass          └─ symposium win: game over
                         ├─ agora: trade / pass
                         ├─ open isle: build / pass  (rival academy → tuition question first)
                         └─ delos: symposium vote by opponents

Victory: earn LAURELS_NEEDED laurels (each from a different domain's Trial at
a library currently showing that domain), then land on Delos and answer the
Symposium question in a domain your opponents vote on.
"""
from __future__ import annotations

import random

import board

# ── tunables ─────────────────────────────────────────────────────────────────
MIN_PLAYERS = 2
MAX_PLAYERS = 6
TIER_REWARD = {1: 1, 2: 2, 3: 3}      # scrolls for a correct wager, by tier
TIER3_PENALTY = 1                     # scrolls lost on a missed tier-3 wager
TRIAL_COST = 2                        # domain scrolls consumed by a passed Trial
LAURELS_NEEDED = 3
ORACLE_FEE = 1
ORACLE_REWARD = 3                     # scrolls of the winner's choosing
ACADEMY_COST = 3                      # any mix of scrolls
HARBOR_COST = 2
DECK_COPIES = 3                       # domain cards per domain in the rotation deck

COLORS = ["#e4572e", "#2e86ab", "#f6ae2d", "#8e5572", "#33ca7f", "#6457a6"]


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
        self.node = board.START
        self.scrolls = {d: 0 for d in board.DOMAINS}
        self.laurels: list[str] = []
        self.last_library: str | None = None

    # scroll helpers -----------------------------------------------------------
    def total_scrolls(self) -> int:
        return sum(self.scrolls.values())

    def richest_domain(self) -> str | None:
        held = [(n, d) for d, n in self.scrolls.items() if n > 0]
        if not held:
            return None
        held.sort(key=lambda t: (-t[0], board.DOMAINS.index(t[1])))
        return held[0][1]

    def spend_any(self, amount: int):
        """Deduct scrolls greedily from the richest domains."""
        if self.total_scrolls() < amount:
            raise GameError("Not enough scrolls.")
        for _ in range(amount):
            self.scrolls[self.richest_domain()] -= 1

    def public(self) -> dict:
        return {
            "pid": self.pid, "name": self.name, "color": self.color,
            "node": self.node, "scrolls": self.scrolls, "laurels": self.laurels,
            "connected": self.connected, "bot": self.is_bot,
        }


class Game:
    def __init__(self, code: str, seed: int | None = None):
        self.code = code
        self.rng = random.Random(seed)
        self.players: list[Player] = []
        self.phase = "lobby"
        self.nonce = 0                 # bumped on any phase change; guards timers
        self.turn_idx = 0
        self.dice: tuple[int, int] | None = None
        self.reachable: dict[str, int] = {}
        self.library_domains: dict[str, str] = {}
        self._deck: list[str] = []
        self.plots: dict[str, dict | None] = {nid: None for nid in board.OPEN_ISLES}
        # question context: kind wager|trial|tuition|oracle|symposium
        self.qctx: dict | None = None
        self.question: dict | None = None      # {text, options[4], correct}
        self.question_deadline: float | None = None
        self.reveal: dict | None = None
        self.votes: dict[str, str] = {}
        self.oracle_claim_due: str | None = None   # pid owed an oracle reward
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

    def _draw_domain(self) -> str:
        if not self._deck:
            self._deck = board.DOMAINS * DECK_COPIES
            self.rng.shuffle(self._deck)
        return self._deck.pop()

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
        else:
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
            raise GameError(f"Need at least {MIN_PLAYERS} captains.")
        for lib in board.LIBRARIES:
            self.library_domains[lib] = self._draw_domain()
        self.turn_idx = 0
        self._start_turn()

    def _start_turn(self):
        self.dice = None
        self.reachable = {}
        self.qctx = None
        self.question = None
        self.reveal = None
        self.votes = {}
        self._bump("roll")

    # ── movement ─────────────────────────────────────────────────────────────
    def roll(self, pid: str, d1: int, d2: int):
        self._require_turn(pid, "roll")
        p = self.current
        self.dice = (d1, d2)
        origins = {p.node} | {
            nid for nid, plot in self.plots.items()
            if plot and plot["kind"] == "harbor" and plot["owner"] == pid
        }
        delos_ok = len(p.laurels) >= LAURELS_NEEDED
        self.reachable = board.reachable(origins, max(d1, d2), delos_ok)
        if not self.reachable:                      # can't happen on this board
            self._next_turn()
            return
        self._bump("sail")

    def sail(self, pid: str, node: str):
        self._require_turn(pid, "sail")
        if node not in self.reachable:
            raise GameError("Your ship cannot reach that island.")
        p = self.current
        p.node = node
        self.reachable = {}
        self._land(p, node)

    # ── landing dispatch ─────────────────────────────────────────────────────
    def _land(self, p: Player, node: str):
        ntype = board.NODES[node]["type"]
        if ntype == "open":
            plot = self.plots[node]
            if plot and plot["kind"] == "academy" and plot["owner"] != p.pid:
                owner = self.player_by_pid(plot["owner"])
                self.qctx = {
                    "kind": "tuition", "island": node, "tier": 1,
                    "domain": self.rng.choice(board.DOMAINS),
                    "owner": owner.pid if owner else None,
                }
                self._bump("question")
                return
            self._enter_island(node)
        elif ntype == "library":
            self._enter_island(node)
        elif ntype in ("oracle", "agora"):
            self._enter_island(node)
        elif ntype == "delos":
            if len(p.laurels) < LAURELS_NEEDED:
                raise GameError("Delos is closed to you.")   # unreachable; BFS guards
            self.votes = {}
            self._bump("symposium_vote")
        else:                                       # port — nothing to do
            self._next_turn()

    def island_actions(self) -> list[str]:
        """What the current player may do in the 'island' phase."""
        if self.phase != "island":
            return []
        p = self.current
        node = p.node
        ntype = board.NODES[node]["type"]
        acts: list[str] = []
        if ntype == "library":
            if p.last_library != node:
                acts += ["wager1", "wager2", "wager3"]
                dom = self.library_domains[node]
                if dom not in p.laurels and p.scrolls[dom] >= TRIAL_COST:
                    acts.append("trial")
        elif ntype == "oracle":
            if p.total_scrolls() >= ORACLE_FEE:
                acts.append("oracle")
        elif ntype == "agora":
            if any(n >= 3 for n in p.scrolls.values()):
                acts.append("trade")
        elif ntype == "open" and self.plots[node] is None:
            if p.total_scrolls() >= ACADEMY_COST:
                acts.append("academy")
            if p.total_scrolls() >= HARBOR_COST:
                acts.append("harbor")
        acts.append("pass")
        return acts

    def _enter_island(self, node: str):
        self._bump("island")
        if self.island_actions() == ["pass"]:
            self._next_turn()

    # ── island actions ───────────────────────────────────────────────────────
    def wager(self, pid: str, tier: int):
        self._require_turn(pid, "island")
        p = self.current
        node = p.node
        if board.NODES[node]["type"] != "library":
            raise GameError("There is no librarian here.")
        if p.last_library == node:
            raise GameError("The librarian remembers you — study elsewhere first.")
        if tier not in TIER_REWARD:
            raise GameError("Choose tier I, II, or III.")
        self.qctx = {
            "kind": "wager", "island": node, "tier": tier,
            "domain": self.library_domains[node],
        }
        self._bump("question")

    def trial(self, pid: str):
        self._require_turn(pid, "island")
        p = self.current
        node = p.node
        if board.NODES[node]["type"] != "library":
            raise GameError("Trials are held in the Great Libraries.")
        if p.last_library == node:
            raise GameError("The librarian remembers you — study elsewhere first.")
        dom = self.library_domains[node]
        if dom in p.laurels:
            raise GameError(f"You already wear the laurel of {board.DOMAIN_INFO[dom]['name']}.")
        if p.scrolls[dom] < TRIAL_COST:
            raise GameError(f"A trial demands {TRIAL_COST} scrolls of the domain.")
        self.qctx = {"kind": "trial", "island": node, "tier": 3, "domain": dom}
        self._bump("question")

    def oracle_accept(self, pid: str):
        self._require_turn(pid, "island")
        p = self.current
        if board.NODES[p.node]["type"] != "oracle":
            raise GameError("The Pythia is not here.")
        if p.total_scrolls() < ORACLE_FEE:
            raise GameError("The Oracle demands a scroll.")
        p.spend_any(ORACLE_FEE)
        self.qctx = {"kind": "oracle", "island": p.node, "tier": 4,
                     "domain": self.rng.choice(board.DOMAINS)}
        self._bump("question")

    def trade(self, pid: str, give: str, get: str):
        self._require_turn(pid, "island")
        p = self.current
        if board.NODES[p.node]["type"] != "agora":
            raise GameError("No merchants on this island.")
        if give not in board.DOMAINS or get not in board.DOMAINS or give == get:
            raise GameError("Trade one domain for a different one.")
        if p.scrolls[give] < 3:
            raise GameError("The merchants want 3 scrolls for 1.")
        p.scrolls[give] -= 3
        p.scrolls[get] += 1
        self._say(f"{p.name} traded at the Agora.")
        self._next_turn()

    def build(self, pid: str, kind: str):
        self._require_turn(pid, "island")
        p = self.current
        node = p.node
        if board.NODES[node]["type"] != "open" or self.plots[node] is not None:
            raise GameError("No free plot here.")
        if kind == "academy":
            p.spend_any(ACADEMY_COST)
        elif kind == "harbor":
            p.spend_any(HARBOR_COST)
        else:
            raise GameError("Build an academy or a harbor.")
        self.plots[node] = {"kind": kind, "owner": pid}
        self._say(f"{p.name} built a {kind} on {board.NODES[node]['name']}.")
        self._next_turn()

    def pass_turn(self, pid: str):
        self._require_turn(pid, "island")
        self._next_turn()

    def skip_turn(self, host_pid: str):
        """Host skips a stuck/disconnected player's turn."""
        if not self.players or self.players[0].pid != host_pid:
            raise GameError("Only the host can skip a turn.")
        if self.phase in ("lobby", "finished"):
            raise GameError("Nothing to skip.")
        self._next_turn()

    # ── questions ────────────────────────────────────────────────────────────
    def set_question(self, q: dict, deadline: float | None = None):
        """Server installs the fetched question: {text, options[4], correct}."""
        if self.phase != "question" or self.question is not None:
            return
        self.question = q
        self.question_deadline = deadline

    def answer(self, pid: str, idx: int):
        self._require_turn(pid, "question")
        if self.question is None:
            raise GameError("The question is still on its way.")
        correct = idx == self.question["correct"]
        self._resolve_question(correct, idx)

    def timeout_question(self):
        """Server question timer expired — counts as a miss."""
        if self.phase == "question" and self.question is not None:
            self._resolve_question(False, -1)

    def _resolve_question(self, correct: bool, idx: int):
        p = self.current
        ctx = self.qctx
        kind = ctx["kind"]
        dom = ctx["domain"]
        gained: dict[str, int] = {}
        note = ""

        if kind == "wager":
            if correct:
                p.scrolls[dom] += TIER_REWARD[ctx["tier"]]
                gained[dom] = TIER_REWARD[ctx["tier"]]
            elif ctx["tier"] == 3:
                loss = min(TIER3_PENALTY, p.total_scrolls())
                for _ in range(loss):
                    lose_from = dom if p.scrolls[dom] > 0 else p.richest_domain()
                    p.scrolls[lose_from] -= 1
                if loss:
                    note = f"The librarian confiscates {loss} scroll."
            self._rotate_library(ctx["island"], p)
        elif kind == "trial":
            if correct:
                p.scrolls[dom] -= TRIAL_COST
                p.laurels.append(dom)
                note = f"{p.name} earns the laurel of {board.DOMAIN_INFO[dom]['name']}!"
            self._rotate_library(ctx["island"], p)
        elif kind == "tuition":
            owner = self.player_by_pid(ctx.get("owner") or "")
            if owner:
                owner.scrolls[dom] += 1
            if correct:
                p.scrolls[dom] += 1
                gained[dom] = 1
        elif kind == "oracle":
            if correct:
                self.oracle_claim_due = p.pid
                note = "The Pythia smiles."
            else:
                note = "The Pythia keeps your offering."
        elif kind == "symposium":
            if correct:
                self.winner = p.pid
                note = f"{p.name} triumphs at the Symposium of Delos!"

        self.reveal = {
            "correct": self.question["correct"], "chosen": idx,
            "was_correct": correct, "gained": gained, "note": note,
            "kind": kind, "domain": dom,
        }
        if note:
            self._say(note)
        self._bump("reveal")

    def _rotate_library(self, node: str, p: Player):
        """The Muse moves on: new domain card, and the librarian remembers you."""
        self.library_domains[node] = self._draw_domain()
        p.last_library = node

    def advance_after_reveal(self):
        """Server reveal timer expired."""
        if self.phase != "reveal":
            return
        self.question = None
        self.question_deadline = None
        if self.winner:
            self._bump("finished")
        elif self.oracle_claim_due:
            self._bump("oracle_claim")
        else:
            self._next_turn()

    def oracle_claim(self, pid: str, domains: list[str]):
        if self.phase != "oracle_claim" or self.oracle_claim_due != pid:
            raise GameError("No boon awaits you.")
        if len(domains) != ORACLE_REWARD or any(d not in board.DOMAINS for d in domains):
            raise GameError(f"Choose {ORACLE_REWARD} scrolls.")
        p = self.player_by_pid(pid)
        for d in domains:
            p.scrolls[d] += 1
        self.oracle_claim_due = None
        self._say(f"{p.name} claims the Oracle's boon.")
        self._next_turn()

    # ── the Symposium (endgame) ──────────────────────────────────────────────
    def vote_domain(self, pid: str, domain: str):
        if self.phase != "symposium_vote":
            raise GameError("No vote is underway.")
        if pid == self.current.pid:
            raise GameError("The challenger does not vote.")
        if domain not in board.DOMAINS:
            raise GameError("Unknown domain.")
        if not self.player_by_pid(pid):
            raise GameError("Spectators cannot vote.")
        self.votes[pid] = domain

    def all_votes_in(self) -> bool:
        eligible = [p for p in self.players
                    if p.pid != self.current.pid and p.connected]
        return len(self.votes) >= len(eligible) and self.phase == "symposium_vote"

    def tally_votes(self, tiebreak: int):
        """Majority of cast votes; ties broken by injected randomness."""
        if self.phase != "symposium_vote":
            return
        counts: dict[str, int] = {}
        for d in self.votes.values():
            counts[d] = counts.get(d, 0) + 1
        if counts:
            top = max(counts.values())
            tied = sorted([d for d, c in counts.items() if c == top],
                          key=board.DOMAINS.index)
            dom = tied[tiebreak % len(tied)]
        else:
            dom = board.DOMAINS[tiebreak % len(board.DOMAINS)]
        self.qctx = {"kind": "symposium", "island": "delos", "tier": 3, "domain": dom}
        self._bump("question")

    # ── turn / lifecycle ─────────────────────────────────────────────────────
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
        for p in self.players:
            p.reset()
        self.winner = None
        self.oracle_claim_due = None
        self.plots = {nid: None for nid in board.OPEN_ISLES}
        self.library_domains = {lib: self._draw_domain() for lib in board.LIBRARIES}
        self.log = []
        self.turn_idx = 0
        self._start_turn()

    # ── snapshot ─────────────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        q = None
        if self.question is not None:
            q = {"text": self.question["text"], "options": self.question["options"],
                 "kind": self.qctx["kind"], "tier": self.qctx["tier"],
                 "domain": self.qctx["domain"], "deadline": self.question_deadline}
        return {
            "code": self.code,
            "phase": self.phase,
            "board": board.to_dict(),
            "players": [p.public() for p in self.players],
            "host": self.players[0].pid if self.players else None,
            "turn": self.current.pid if self.players and self.phase != "lobby" else None,
            "dice": self.dice,
            "reachable": self.reachable,
            "library_domains": self.library_domains,
            "plots": self.plots,
            "actions": self.island_actions(),
            "question": q,
            "qkind": self.qctx["kind"] if self.qctx and self.phase == "question" else None,
            "reveal": self.reveal if self.phase == "reveal" else None,
            "votes_in": len(self.votes) if self.phase == "symposium_vote" else 0,
            "oracle_claim_due": self.oracle_claim_due,
            "winner": self.winner,
            "log": self.log,
            "config": {"trial_cost": TRIAL_COST, "laurels_needed": LAURELS_NEEDED,
                       "academy_cost": ACADEMY_COST, "harbor_cost": HARBOR_COST,
                       "tier_reward": TIER_REWARD, "oracle_fee": ORACLE_FEE,
                       "oracle_reward": ORACLE_REWARD},
        }

#!/usr/bin/env python3
"""
Thalassa headless simulator / rules fuzzer.

Drives ``game.Game`` directly — no server, no sockets, no clock — the way
server.py does (dice, question delivery, reveal advance, timers, the gate
carry-through, bot decisions, the idle-turn autopilot), and checks the
engine's invariants after EVERY action.

    python3 tools/sim.py --games 500 --seed 1

Game ``i`` of a batch is played on seed ``seed + i``; its player count
(1–6) and table kind follow from that seed alone, so any game of any batch
replays exactly with ``--games 1 --seed <its seed> [--verbose]``.

Two kinds of table (alternating by seed unless --mode says otherwise):

  bots   honest voyages: every captain is one of the server's philosopher
         bots (bots.py decision functions, the same accuracy / puzzle odds
         server.bot_move uses). No cheats — these produce the balance
         numbers (turns to each seal, shipwrecks, boss win rates, where the
         scrolls come from). ``--skill sharp|casual`` keeps the bots' routing
         but gives them a strong / an ordinary human's answers.

  chaos  robustness fuzzing: captains take random-but-legal actions through
         every phase, while the harness injects illegal / out-of-turn /
         malformed calls (which must raise GameError and leave the state
         untouched), stale server timers (which must be no-ops), host kicks
         and disconnects at any phase, the idle clock acting for an absent
         captain, and dev-style teleports and grants so every corner of the
         rules (lairs, the Sphinx, the kraken, the sword islet, the Pharos,
         the Warden, rematch) is reached quickly.

Invariants (``Table.check`` / ``check_snapshot`` / ``check_fresh``): a known
phase; a valid turn index; purses ≥ 0, hulls in (0, max] on half-hearts,
charms within their cap; seal conservation (every boss a captain beat left
its seal in exactly one place — hold, altar stash, or vault); per-phase
structure and NOTHING left over from an earlier phase or a departed captain
(battle, question, minigame, kraken, Jeopardy board, upgrade offer, walk,
side answers, the staged Sphinx); snapshots for every kind of viewer that
serialise to strict JSON and never carry an answer key, a puzzle secret,
another captain's reachable set or the sword islet; every dealt minigame
solvable; a legal action always available (no softlock); every turn over
within a bounded number of actions; a rematch that resets everything.

Exit status is non-zero if any game trips an invariant.

    --mode bots --max-turns 3000      let honest games run to the end
    --study stances                   boss / Warden win rates by stance
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import random
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import bots                      # noqa: E402
import game as G                 # noqa: E402
import puzzles                   # noqa: E402
import events as EV              # noqa: E402
import eventgames as EG          # noqa: E402
import questions                 # noqa: E402
import tetromino6                # noqa: E402
from board import REGION_POOL, RELICS_TO_WIN, WARDEN  # noqa: E402
from game import Game, GameError  # noqa: E402

PHASES = {"lobby", "roll", "sail", "shrine", "haven", "shop", "trade",
          "pharos", "battle", "jchoose", "question", "reveal",
          "minigame", "upgrade_pick", "finished", "event"}
# snapshot keys that must never reach a client while a challenge is open
SECRET_KEYS = {"correct", "answer", "secret", "accept", "word", "data"}
ONE_ATTEMPT = ("simon", "memory", "ravens", "visual_memory")
MAX_TURN_ACTIONS = 4000          # one turn never needs more than this


class InvariantError(AssertionError):
    """The engine broke one of its promises."""


# ── the harness's own question herald ────────────────────────────────────────
# The rules never look inside a question beyond {text, options, correct} or
# {text, answer, typed}. The harness deals them itself, from the bundled data
# when it is there, so a seeded game replays identically: questions.py keeps
# process-wide "already served" pools (and its Jeopardy board shuffles a whole
# ~28k-clue band per deal, ≈30 ms), which would make a replay depend on what
# the process had dealt before. ``--real-jeopardy`` puts the real board
# dealer back in the loop.
_REAL_JEOPARDY_BOARD = questions.jeopardy_board
_BAND_POOLS: dict[str, list] = {}
_MC_POOLS: dict[str, list] | None = None


def _band_pool(band: str) -> list:
    pool = _BAND_POOLS.get(band)
    if pool is None:
        pool = []
        try:
            bands = getattr(questions, "JEOPARDY_BANDS", {"low": ("200", "400"),
                                                          "high": ("800", "1000")})
            for v in bands.get(band, bands["low"]):
                for cell in getattr(questions, "JEOPARDY", {}).get(v, []):
                    cat, clue, ans = cell[0], cell[1], cell[2]
                    if isinstance(cat, str) and isinstance(clue, str) and isinstance(ans, str):
                        pool.append((int(v), cat, clue, ans))
        except Exception:                                # noqa: BLE001
            pool = []
        _BAND_POOLS[band] = pool
    return pool


def _fast_jeopardy_board(rng: random.Random, band: str = "low", n: int = 4) -> list:
    """Same contract as questions.jeopardy_board: n cells {category, value,
    text, answer}, all DISTINCT categories — sampled instead of shuffled."""
    pool = _band_pool(band)
    cells, used = [], set()
    tries = 0
    while len(cells) < n and pool and tries < 200:
        tries += 1
        v, cat, clue, ans = pool[rng.randrange(len(pool))]
        if cat.lower() in used:
            continue
        used.add(cat.lower())
        cells.append({"category": cat, "value": v, "text": clue, "answer": ans})
    while len(cells) < n:                                # no bundle: synthetic clues
        k = len(cells) + 1
        cells.append({"category": f"MYSTERY {k}", "value": 200 * k,
                      "text": f"Synthetic clue {rng.randrange(10 ** 6)}",
                      "answer": f"answer {rng.randrange(10 ** 6)}"})
    return cells


FAST_JEOPARDY = True              # run_game swaps the dealer in for its own run only

# who sits at a "bots" table. "bots": the server's six philosophers, with the
# odds server.bot_move gives them. "sharp": the same routing, shopping and
# battle choices (bots.py), but a strong human's answers — 90/80/65 % by
# tier, 80 % puzzles — to separate "the bots play badly" from "the rules
# are slow". "casual": the same with a weaker hand (70/55/40, 60 % puzzles).
# (There is no reflex input left to model: defence is decided by answers.)
SKILL = "bots"
SHARP = bots.Skill("Sharp", 0.90, 0.80, 0.65)
# a casual table: an ordinary pub-quiz hand — to check a weaker player can
# still finish a voyage
CASUAL = bots.Skill("Casual", 0.70, 0.55, 0.40)


def minigame_odds(skill) -> float:
    """How often a captain solves a combat / isle puzzle."""
    if skill is SHARP:
        return 0.80
    if skill is CASUAL:
        return 0.60
    return min(0.85, skill.t3 + 0.25)


def _typed_clue(rng: random.Random) -> dict:
    cell = _fast_jeopardy_board(rng, "low", 1)[0]
    return {"text": cell["text"], "answer": cell["answer"], "typed": True,
            "kind": "jeopardy", "category": cell["category"], "value": cell["value"]}


def _mc_question(rng: random.Random, domain: str | None) -> dict:
    """A multiple-choice question in the shape questions._shape produces."""
    global _MC_POOLS
    if _MC_POOLS is None:
        _MC_POOLS = {}
        try:
            for dom, items in getattr(questions, "TRIVIA", {}).items():
                good = [it for it in items if isinstance(it, dict)
                        and isinstance(it.get("q"), str) and isinstance(it.get("a"), str)
                        and isinstance(it.get("w"), list) and it["w"]
                        and all(isinstance(w, str) for w in it["w"])]
                if good:
                    _MC_POOLS[dom] = good
        except Exception:                                # noqa: BLE001
            _MC_POOLS = {}
        _MC_POOLS["*"] = [it for dom in sorted(_MC_POOLS) for it in _MC_POOLS[dom]]
    pool = _MC_POOLS.get(domain) or _MC_POOLS["*"]
    if pool:
        it = pool[rng.randrange(len(pool))]
        options = [it["a"]] + [w for w in it["w"][:3] if w != it["a"]]
        text = it["q"]
    else:
        options = ["alpha", "beta", "gamma", "delta"]
        text = f"Synthetic question {rng.randrange(10 ** 6)}?"
    answer = options[0]
    rng.shuffle(options)
    return {"text": text, "options": options, "correct": options.index(answer)}


# ── the server's idle-turn autopilot (optional) ──────────────────────────────
_IDLE_STEP = False                # False = not looked up yet; None = unavailable


def idle_step_fn():
    """server.idle_step — the pure function the server calls when a captain's
    idle clock runs out (forfeit the roll, flee-or-strike, time the phase
    out…). Imported lazily and only if the server module loads; the harness
    falls back to a plain forfeit otherwise."""
    global _IDLE_STEP
    if _IDLE_STEP is False:
        try:
            import logging
            import server
            logging.getLogger("thalassa").setLevel(logging.CRITICAL)
            _IDLE_STEP = getattr(server, "idle_step", None)
        except Exception:                                # noqa: BLE001
            _IDLE_STEP = None
    return _IDLE_STEP


# ── minigame solvers (the harness may peek at the server-side secret) ────────
def _solve_tetromino(data: dict):
    w, h, pieces = data["w"], data["h"], data["pieces"]
    for inst in tetromino6.BANK:                      # the 6×6 bank ships solutions
        if inst["public"]["pieces"] == pieces and inst["public"]["w"] == w:
            return list(inst["solution"])
    grid = [-1] * (w * h)
    used = [False] * len(pieces)

    def rec() -> bool:
        try:
            i = grid.index(-1)
        except ValueError:
            return True
        y0, x0 = divmod(i, w)
        for pi, cells in enumerate(pieces):
            if used[pi]:
                continue
            for ax, ay in cells:                      # which cell covers (x0,y0)
                spot = []
                for cx, cy in cells:
                    x, y = x0 + cx - ax, y0 + cy - ay
                    if not (0 <= x < w and 0 <= y < h) or grid[y * w + x] != -1:
                        spot = None
                        break
                    spot.append(y * w + x)
                if spot:
                    for k in spot:
                        grid[k] = pi
                    used[pi] = True
                    if rec():
                        return True
                    used[pi] = False
                    for k in spot:
                        grid[k] = -1
        return False

    return grid if rec() else None


def _line_patterns(n: int, clue: list[int]) -> list[list[int]]:
    out = []
    for mask in range(1 << n):
        line = [(mask >> i) & 1 for i in range(n)]
        if puzzles._clues(line) == clue:
            out.append(line)
    return out


def _solve_nonogram(data: dict):
    n = data["n"]
    row_opts = [_line_patterns(n, c) for c in data["rows"]]
    grid: list[list[int]] = []

    def rec(r: int) -> bool:
        if r == n:
            return all(puzzles._clues([grid[i][c] for i in range(n)]) == data["cols"][c]
                       for c in range(n))
        for opt in row_opts[r]:
            grid.append(opt)
            if rec(r + 1):
                return True
            grid.pop()
        return False

    return [v for row in grid for v in row] if rec(0) else None


def _solve_lights_out(data: dict):
    n = data["n"]
    start = 0
    for r in range(n):
        for c in range(n):
            if data["board"][r][c]:
                start |= 1 << (r * n + c)
    masks = []
    for r in range(n):
        for c in range(n):
            m = 0
            for rr, cc in ((r, c), (r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < n and 0 <= cc < n:
                    m |= 1 << (rr * n + cc)
            masks.append(m)
    for combo in range(1 << (n * n)):
        state, k, bits = start, 0, combo
        while bits:
            if bits & 1:
                state ^= masks[k]
            bits >>= 1
            k += 1
        if state == 0:
            return [[i // n, i % n] for i in range(n * n) if (combo >> i) & 1]
    return None


def solve_minigame(mg: dict):
    """A payload the engine's checker must accept for this minigame."""
    kind, data = mg["kind"], mg["data"]
    if kind == "tetromino":
        return _solve_tetromino(data)
    if kind == "nonogram":
        return _solve_nonogram(data)
    if kind in ("simon", "memory"):
        return list(data["seq"])
    if kind == "visual_memory":
        return list(data["flash"])
    if kind == "anagram":
        return data["secret"]["word"]
    if kind == "ravens":
        return data["secret"]["correct"]
    if kind in ("riddle", "sequence"):
        return data["secret"]["answer"]
    if kind == "lights_out":
        return _solve_lights_out(data)
    if kind == "sliding":
        return list(data["goal"])
    raise InvariantError(f"harness has no solver for minigame kind {kind!r}")


def wrong_payload(mg: dict):
    kind, data = mg["kind"], mg["data"]
    if kind == "ravens":
        return (data["secret"]["correct"] + 1) % len(data["options"])
    if kind in ("simon", "memory"):
        return [(v + 1) % data["pad"] for v in data["seq"]]
    if kind == "visual_memory":
        return list(data["flash"])[:-1]
    if kind in ("riddle", "anagram"):
        return "zzzzzz"
    if kind == "sequence":
        return int(data["secret"]["answer"]) + 1
    if kind == "sliding":
        return list(data["board"])
    if kind == "lights_out":
        return []
    return [0] * 4


# ── state fingerprint: "an illegal call changed NOTHING" ─────────────────────
def _node_sig(n: dict):
    t = n["type"]
    m = n.get("monster")
    if t == "sea":
        return (repr(m) if m else None, n.get("flotsam"), n.get("cache"),
                n.get("sphinx_done"))
    if t == "shrine":
        return n["charges"]
    if t == "puzzle":
        return n.get("solved")
    if t == "lair":
        return (repr(m) if m else None, tuple(n["defeated"]), tuple(n["stash"]))
    return repr(m) if m else None


def fingerprint(g: Game) -> tuple:
    players = tuple(
        (p.pid, p.node, p.prev_node, p.checkpoint, p.scrolls, p.hull, p.max_hull,
         tuple(p.cargo), p.banked, tuple(p.upgrades), tuple(sorted(p.items.items())),
         p.next_roll_bonus, p.map_bought, p.streak, p.puzzles_solved,
         p.cheated_death, p.skip_turns, len(p.seen), p.connected,
         repr(sorted(getattr(p, "buffs", {}).items())))
        for p in g.players)
    nodes = tuple(map(_node_sig, g.board.nodes.values()))
    return (g.phase, g.nonce, g.turn_idx, g.die, repr(g.reachable), repr(g.walk),
            repr(g.qctx), repr(g.question), repr(g.side_answers), repr(g.reveal),
            repr(g.battle), repr(g.minigame), repr(g.kraken), repr(g.flash),
            repr(g.upgrade_offer), repr(sorted(g.used_puzzles)), g.pharos_open,
            g.winner, tuple(g.log), repr(g.jboard),
            repr(getattr(g, "_pending_jeopardy", None)), repr(g.gate_walk),
            hash(g.rng.getstate()), players, nodes, repr(getattr(g, "ev", None)))


def _walk_keys(obj, path=""):
    """Yield (path, key, value) for every dict entry in a JSON-ish tree."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield path, k, v
            yield from _walk_keys(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from _walk_keys(v, f"{path}[{i}]")


def _values(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _values(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _values(v)
    else:
        yield obj


JUNK = [None, "", "zzz", -1, 0, 1, 2, 3, 4, 99, 10 ** 9, 1.5, float("nan"),
        True, False, [], [1, 2], {}, {"a": 1}, "home", "pharos", "attack",
        "magic", "heal", "sword", "mc", "jeopardy", "puzzle", "planks", "gale",
        "hint", "horn", "aegis_charm", "fitting", "owl", "lyre", "ram",
        "golden_fleece", "sword_of_damocles", "sword_isle", "x" * 300]


class Table:
    """One voyage and everything server.py would be doing around it."""

    def __init__(self, seed: int, n_players: int, mode: str,
                 max_turns: int, snapshot_every: int = 8, verbose: bool = False):
        self.seed = seed
        self.mode = mode
        self.n_players = n_players
        self.seats = n_players                            # as planned (for the replay line)
        self.max_turns = max_turns
        self.snapshot_every = snapshot_every
        self.verbose = verbose
        self.rng = random.Random(seed * 7919 + 13)        # the harness's own dice
        self.g = Game("SIM", seed=seed)
        self.clock = 1000.0
        self.trail = collections.deque(maxlen=60)         # last actions, for a repro
        self.actions = 0
        self.turns = 0
        self.turn_actions = 0
        self.max_turn_actions = 0
        self.games_played = 0
        self.rematches = 0
        self.kicks = 0
        self.probes = 0
        self.probe_rejects = 0
        self.granted: dict[str, int] = {}                 # dev-style seal grants
        self.pending_gate: dict | None = None
        self.skills: dict[str, bots.Skill] = {}
        self.policy: dict[str, str] = {}
        self.stats = collections.Counter()
        self.phases_seen = collections.Counter()
        self.first_finish: dict | None = None
        self.first_three: int | None = None               # turn the Pharos first opened
        self.kicked_to_win = False                        # last captain standing
        self.first_seal: int | None = None
        self._last_battle = None
        self._boss_ctx = None
        self._fight = None               # the fight being watched (combat report)
        self._tried = set()              # (captain, lair) pairs already attempted
        self._wrong_tries = 0
        self._seen_challenge = None
        self._snap_at = -1
        self._earned: dict[str, tuple] = {}
        self._ev_fired = 0
        self._ev_counts: dict[str, int] = {}
        self._last_label = ""
        self._install_hooks()

    # ── setup ────────────────────────────────────────────────────────────────
    def _install_hooks(self):
        g = self.g
        start_turn, shipwreck = g._start_turn, g._shipwreck

        def counted_start_turn():
            self.turns += 1
            self.max_turn_actions = max(self.max_turn_actions, self.turn_actions)
            self.turn_actions = 0
            self._wrong_tries = 0
            start_turn()
            if g.players and g.phase != "finished":     # where the turn is spent
                self.stats["stage_turns_" + EV.stage_of(g.board.nodes.get(g.current.node, {}))] += 1

        def counted_shipwreck(p, **kw):
            self.stats["shipwrecks"] += 1
            node = g.board.nodes.get(g.battle["node"]) if g.battle else None
            if node is not None:
                self.stats[f"wreck_at_{node['type']}"] += 1
            shipwreck(p, **kw)

        next_turn = g._next_turn

        def checked_next_turn():
            # the dice pass strictly round the table; the only captains ever
            # skipped are those who owe the kraken a turn — and they pay it
            order = [p.pid for p in g.players]
            owed = {p.pid: p.skip_turns for p in g.players}
            won = g.winner
            i = g.turn_idx
            next_turn()
            if won or g.phase == "finished":
                return
            n = len(order)
            j = (i + 1) % n
            paid = []
            for _ in range(n):
                if owed[order[j]] <= 0:
                    break
                paid.append(order[j])
                j = (j + 1) % n
            if g.current.pid != order[j]:
                self.fail(f"turn order broken: after {order[i]} came {g.current.pid}, "
                          f"expected {order[j]} (owed turns: {owed})")
            for pid in paid:
                if g.player_by_pid(pid).skip_turns != owed[pid] - 1:
                    self.fail(f"{pid} was skipped without paying the kraken's toll")

        g._start_turn = counted_start_turn
        g._shipwreck = counted_shipwreck
        g._next_turn = checked_next_turn

    def _seat(self):
        g, rng = self.g, self.rng
        pool = bots.PHILOSOPHERS[:]
        rng.shuffle(pool)
        for i in range(self.n_players):
            p = g.add_player(f"tok{i}", f"Cap{i}", is_bot=(self.mode == "bots" and i > 0))
            self.skills[p.pid] = (SHARP if self.mode == "bots" and SKILL == "sharp"
                                  else CASUAL if self.mode == "bots" and SKILL == "casual"
                                  else pool[i % len(pool)])
            if self.mode == "bots":
                self.policy[p.pid] = "bot"
            else:
                self.policy[p.pid] = rng.choice(["random", "random", "bot"])
        if self.mode == "chaos":
            self._lobby_fuzz()
        g.start(self.host())
        self.check()

    def _lobby_fuzz(self):
        """Lobby rules: only the host launches / kicks, the table caps at six,
        a kicked seat can be refilled."""
        g, rng = self.g, self.rng
        pids = [p.pid for p in g.players]
        if len(pids) > 1:
            self.expect_error("lobby start by non-host", lambda: g.start(pids[-1]))
            self.expect_error("lobby kick by non-host",
                              lambda: g.remove_player(pids[-1], pids[0]))
            self.expect_error("host kicks self", lambda: g.remove_player(pids[0], pids[0]))
        for meth in ("roll", "sail", "pass_turn", "flee", "answer", "repair"):
            args = {"roll": (2,), "sail": ("home",), "answer": (0,)}.get(meth, ())
            self.expect_error(f"lobby {meth}",
                              lambda m=meth, a=args: getattr(g, m)(pids[0], *a))
        if len(pids) > 1 and rng.random() < 0.5:
            victim = pids[-1]
            g.remove_player(pids[0], victim)
            self.policy.pop(victim, None)
            self.skills.pop(victim, None)
            p = g.add_player("tokR", "Refill")
            self.policy[p.pid] = "random"
            self.skills[p.pid] = bots.PHILOSOPHERS[0]
            colors = [q.color for q in g.players]
            if len(set(colors)) != len(colors):
                raise InvariantError(f"two captains share a colour after a lobby "
                                     f"kick + rejoin: {colors}")
        while len(g.players) < G.MAX_PLAYERS and rng.random() < 0.15:
            p = g.add_player(f"tokx{len(g.players)}", "Late")
            self.policy[p.pid] = "random"
            self.skills[p.pid] = bots.PHILOSOPHERS[-1]
        if len(g.players) == G.MAX_PLAYERS:
            self.expect_error("seventh captain", lambda: g.add_player("tok7", "Seven"))
        self.n_players = len(g.players)

    def host(self) -> str | None:
        g = self.g
        hp = getattr(g, "host_pid", None)
        if hp is not None:
            return hp
        return g.players[0].pid if g.players else None

    # ── tiny helpers ─────────────────────────────────────────────────────────
    def note(self, text: str):
        self._last_label += " | " + text
        self.trail.append(f"[t{self.turns} a{self.actions} {self.g.phase}] {text}")
        if self.verbose:
            print(self.trail[-1])

    def fail(self, msg: str):
        raise InvariantError(msg)

    def expect_error(self, label: str, fn):
        """An illegal call: must raise GameError and change nothing."""
        g = self.g
        before = fingerprint(g)
        try:
            fn()
        except GameError:
            if fingerprint(g) != before:
                self.fail(f"{label}: GameError raised but state was mutated")
            return
        except Exception as e:                           # noqa: BLE001
            self.fail(f"{label}: raised {type(e).__name__}: {e} (must be GameError)")
        self.fail(f"{label}: illegal call was accepted")

    # ── what server.py does between actions ──────────────────────────────────
    def server_duties(self):
        g = self.g
        self.clock += 1.0
        # the pass carries you through (server.gate_walk_task, 1.8 s later)
        if self.pending_gate and (self.rng.random() < 0.8 or self.mode == "bots"):
            gw, self.pending_gate = self.pending_gate, None
            self._carry_through(gw)
        if g.gate_walk:
            gw, g.gate_walk = g.gate_walk, None
            if self.mode == "bots" or self.rng.random() < 0.7:
                self._carry_through(gw)
            else:
                self.pending_gate = gw                   # a fast table: it lands late
        if g.phase == "jchoose" and g.jchoose_deadline is None:
            g.jchoose_deadline = self.clock + 12
        elif g.phase == "minigame" and g.minigame and g.minigame["deadline"] is None:
            if g.minigame["limit"]:
                g.minigame["deadline"] = self.clock + g.minigame["limit"]

    def _carry_through(self, gw: dict):
        g = self.g
        carry = getattr(g, "gate_carry", None)
        if carry is not None:
            carry(gw["pid"], gw["gate"], gw["to"])
            return
        p = g.player_by_pid(gw["pid"])
        if p and p.node == gw["gate"]:
            p.prev_node = p.node
            p.node = gw["to"]
            g._reveal_vale(p)
            g.nonce += 1

    def deliver_question(self):
        """server.fetch_question, minus the network."""
        g = self.g
        ctx = g.qctx
        if ctx is None:
            self.fail("question phase with no qctx — the herald has nothing to fetch")
        pending = g.needs_puzzle()
        pending_j = getattr(g, "_pending_jeopardy", None)
        mode = ctx.get("mode")
        if pending_j is not None:
            g._pending_jeopardy = None
            q = pending_j
            if ctx.get("kind") != "battle":
                self.fail("a stale Jeopardy clue was served to a "
                          f"{ctx.get('kind')} question")
        elif pending is not None:
            q = pending
        elif mode == "jeopardy":
            q = _typed_clue(g.rng)                       # e.g. after a Lyre swap
        else:
            q = _mc_question(self.rng, ctx.get("domain"))
        g.set_question(q, deadline=self.clock + 35)
        if g.question is None:
            self.fail("set_question did not deliver")
        self.note("deliver question")

    # ── the legal action menu for whoever's turn it is ───────────────────────
    def do_roll(self, pid: str):
        g, rng = self.g, self.rng
        die = rng.randint(1, 3)
        if g.player_by_pid(pid).has("star_chart"):
            die = max(die, rng.randint(1, 3))
        g.roll(pid, die)

    def legal(self) -> list[tuple[str, object, float]]:
        g, rng = self.g, self.rng
        p = g.current
        pid, ph = p.pid, g.phase
        A: list[tuple[str, object, float]] = []

        def add(label, fn, w=1.0):
            A.append((label, fn, w))

        if ph in ("roll", "sail", "battle", "shrine", "haven", "shop", "trade") \
                and p.items.get("planks", 0) > 0 and p.hull < p.max_hull:
            add("use planks", lambda: g.use_item_charm(pid, "planks"), 0.4)
        gale_cap = getattr(G, "GALE_STACK_CAP", None)
        gale_ok = p.items.get("gale", 0) > 0 and (
            gale_cap is None or p.next_roll_bonus < gale_cap)
        if ph == "roll":
            add("roll", lambda: self.do_roll(pid), 4)
            if gale_ok:
                add("use gale", lambda: g.use_item_charm(pid, "gale"), 0.6)
        elif ph == "sail":
            for nid in g.reachable:
                add(f"sail {nid}", lambda n=nid: g.sail(pid, n))
            if g.walk and g.walk.get("options"):
                for nid in g.walk["options"]:
                    add(f"walk {nid}", lambda n=nid: g.walk_step(pid, n), 1.5)
        elif ph == "shrine":
            for t in (1, 2, 3):
                add(f"wager {t}", lambda t=t: g.wager(pid, t))
            add("pass", lambda: g.pass_turn(pid), 0.4)
        elif ph == "haven":
            if p.hull < p.max_hull and p.scrolls > 0:
                add("repair", lambda: g.repair(pid), 2)
            add("pass", lambda: g.pass_turn(pid))
        elif ph in ("shop", "trade"):
            add("pass", lambda: g.pass_turn(pid), 3)
            for item, stock in G.SHOP_ITEMS.items():
                if item == "fitting":
                    if ph == "shop" and p.scrolls >= stock["cost"] \
                            and any(not p.has(u) for u in G.UPGRADES):
                        add("buy fitting", lambda: g.shop_buy(pid, "fitting"), 0.8)
                elif p.scrolls >= stock["cost"] and p.items.get(item, 0) < G.ITEM_CAP:
                    add(f"buy {item}", lambda i=item: g.shop_buy(pid, i), 0.3)
            if ph == "shop":
                for rid, r in G.RELICS.items():
                    if not p.has(rid) and p.scrolls >= r["cost"]:
                        add(f"buy {rid}", lambda r_=rid: g.shop_buy(pid, r_), 0.8)
            if (p.scrolls >= G.MAP_COST and not p.map_bought
                    and not p.has("sword_of_damocles")):
                add("buy map", lambda: g.buy_map(pid), 0.5)
            if ph == "trade" and gale_ok:
                add("use gale", lambda: g.use_item_charm(pid, "gale"), 0.3)
        elif ph == "pharos":
            if g._pharos_ok(p):
                add("enter pharos", lambda: g.enter_pharos(pid), 4)
            add("pass", lambda: g.pass_turn(pid))
        elif ph == "battle":
            node = g.board.nodes[g.battle["node"]]
            m = g.board.alive_monster(g.battle["node"])
            if not m:
                self.fail("battle phase with no living monster")
            alive = [i for i, e in enumerate(m["enemies"]) if e["hp"] > 0]
            tgt = rng.choice(alive + [0, 7, -1])
            add("strike", lambda: g.stance(pid, "attack", tgt), 3)
            add("magic", lambda: g.stance(pid, "magic", tgt), 3)
            if g.battle.get("charging"):                # BRACE answers a telegraphed heavy
                add("brace", lambda: g.stance(pid, "guard", tgt), 3)
            if p.hull < p.max_hull:                      # a hymn at full Health is refused
                for mode in ("mc", "jeopardy", "puzzle"):
                    add(f"heal {mode}", lambda m_=mode: g.stance(pid, "heal", 0, m_), 0.25)
            if p.has("sword_of_damocles") and node["type"] == "pharos":
                add("sword", lambda: g.stance(pid, "sword", tgt), 4)
            if not m.get("boss") and p.scrolls >= G.FLEE_COST:
                add("flee", lambda: g.flee(pid), 0.5)
            if p.items.get("horn", 0) > 0 and not g.battle.get("horn"):
                if node["type"] == "pharos":             # a STRIKE only chips there
                    self.expect_error("horn at the Pharos",
                                      lambda: g.use_item_charm(pid, "horn"))
                else:
                    add("use horn", lambda: g.use_item_charm(pid, "horn"), 0.5)
        elif ph == "jchoose":
            if not g.jboard or not g.jboard.get("cells"):
                self.fail("jchoose phase with no Jeopardy board")
            for i in range(len(g.jboard["cells"])):
                add(f"jpick {i}", lambda i=i: g.jpick(pid, i))
            add("jchoose timeout", g.jchoose_timeout, 0.3)
        elif ph == "question":
            q = g.question
            acc = 0.6
            if q.get("typed"):
                add("type right", lambda: g.answer_text(pid, q["answer"]), 3 * acc)
                add("type wrong", lambda: g.answer_text(pid, "no idea at all"), 3 * (1 - acc))
            else:
                disabled = set(q.get("disabled", []))
                for i in range(len(q["options"])):
                    if i in disabled:
                        continue
                    w = 3 * acc if i == q["correct"] else (1 - acc)
                    add(f"answer {i}{'*' if i == q['correct'] else ''}",
                        lambda i=i: g.answer(pid, i), w)
                if (p.items.get("hint", 0) > 0 and not disabled
                        and len(q["options"]) > 2):
                    add("use hint", lambda: g.use_item_charm(pid, "hint"), 0.6)
            if g.qctx["kind"] == "battle":
                used = g.battle["used_items"]
                if p.has("owl") and "owl" not in used and not q.get("typed") \
                        and not q.get("disabled"):
                    add("owl", lambda: g.use_item(pid, "owl"), 0.6)
                if p.has("lyre") and "lyre" not in used:
                    add("lyre", lambda: g.use_item(pid, "lyre"), 0.6)
            add("question timeout", g.timeout_question, 0.25)
        elif ph == "minigame":
            mg = g.minigame
            if not mg:
                self.fail("minigame phase with no minigame")
            add("solve", lambda: self._submit_solution(pid), 3)
            add("solve wrong", lambda: self._submit_wrong(pid), 1)
            add("minigame timeout", g.minigame_timeout, 0.5)
            add("bot solve", lambda: g.resolve_minigame(True), 0.5)
            add("bot fail", lambda: g.resolve_minigame(False), 0.5)
        elif ph == "upgrade_pick":
            for u in g.upgrade_offer or []:
                add(f"pick {u}", lambda u=u: g.pick_upgrade(pid, u))
        elif ph == "event":
            for label, msg, val in EV.legal_moves(g, pid):
                add(f"event {label}", lambda m=msg, v=val: self.ev_send(pid, m, v), 2)
            act = g.ev["active"]
            if act and act["step"] == "game":
                add("event game junk", lambda: self._ev_junk(pid), 0.3)
            if act and act["step"] == "table":
                add("event table timeout", lambda: EV.timeout(g), 0.3)
        return A

    # ── events (events.py) ───────────────────────────────────────────────────
    def ev_send(self, pid: str, msg: str, val):
        g = self.g
        {"event_choose": EV.choose, "event_move": EV.game_move,
         "event_answer": EV.answer, "event_bet": EV.bet}[msg](g, pid, val)

    def _ev_junk(self, pid: str):
        """Malformed moves at an open event game: refused, nothing changes."""
        g = self.g
        gs = g.ev["active"]["game"]
        for junk in self.rng.sample(EG.junk_payloads(gs), 3):
            before = fingerprint(g)
            try:
                EV.game_move(g, pid, junk)
            except GameError:
                if fingerprint(g) != before:
                    self.fail(f"a refused event move {junk!r} mutated state")
                continue
            return                                       # it happened to be legal

    def _ev_others_pending(self) -> bool:
        g = self.g
        act = g.ev["active"]
        if not act:
            return False
        cur = g.current.pid
        if act["step"] == "table":
            return any(p.pid not in act["table"]["answers"] and p.pid != cur
                       for p in g.players)
        if act["step"] in ("game", "puzzle"):
            return any(p.pid not in act["bets"] and p.pid != act["pid"]
                       for p in g.players) and self.rng.random() < 0.25
        return False

    def ev_table_round(self):
        """Everyone at a TABLE event answers (bots by policy, others at random)
        and rivals bet on an event game — what the bot driver and the other
        captains' clients do while the acting captain thinks."""
        g, rng = self.g, self.rng
        act = g.ev["active"] if g.phase in ("event", "minigame") else None
        if not act:
            return
        for p in list(g.players):
            if g.ev["active"] is not act or g.phase not in ("event", "minigame"):
                return
            if act["step"] == "table" and p.pid not in act["table"]["answers"]:
                if self.policy.get(p.pid) == "bot" or rng.random() < 0.7:
                    if self.policy.get(p.pid) == "bot":
                        mv = EV.bot_decide(g, p.pid, self.skills.get(
                            p.pid, bots.PHILOSOPHERS[0]).t2, rng)
                    else:
                        opts = EV.legal_moves(g, p.pid)
                        mv = rng.choice(opts)[1:] if opts else None
                    if mv:
                        self.note(f"{p.pid}: table answer {mv[1]!r}")
                        self.ev_send(p.pid, *mv)
                        self.expect_error("second table answer",
                                          lambda q=p.pid: EV.answer(g, q, mv[1]))
            elif act["step"] in ("game", "puzzle") and p.pid != act["pid"] \
                    and p.pid not in act["bets"] and rng.random() < 0.3:
                self.note(f"{p.pid}: event bet")
                EV.bet(g, p.pid, rng.random() < 0.5)

    def _submit_solution(self, pid: str):
        g = self.g
        mg = g.minigame
        payload = solve_minigame(mg)
        if payload is None:
            self.fail(f"minigame {mg['kind']} was dealt UNSOLVABLE: "
                      f"{ {k: v for k, v in mg['data'].items() if k != 'secret'} }")
        nonce = g.nonce
        g.minigame_submit(pid, payload)
        if g.minigame is mg and g.nonce == nonce:
            self.fail(f"a correct {mg['kind']} solution did not resolve the minigame")

    def _submit_wrong(self, pid: str):
        g = self.g
        mg = g.minigame
        before = fingerprint(g)
        try:
            g.minigame_submit(pid, wrong_payload(mg))
        except GameError:
            if fingerprint(g) != before:
                self.fail("a refused minigame answer mutated state")
            if mg["kind"] in ONE_ATTEMPT and not (mg.get("kraken") or mg.get("sphinx")):
                self.fail(f"one-attempt {mg['kind']} offered a retry")
            self._wrong_tries += 1
            if self._wrong_tries > 3:                    # the clock runs out
                g.minigame_timeout()

    # ── acting ───────────────────────────────────────────────────────────────
    def act_random(self):
        acts = self.legal()
        if not acts:
            self.fail(f"SOFTLOCK: no legal action for {self.g.current.pid} "
                      f"in phase {self.g.phase}")
        label, fn, _ = self.rng.choices(acts, weights=[w for _, _, w in acts])[0]
        self.note(f"{self.g.current.pid}: {label}")
        try:
            fn()
        except GameError as e:
            self.fail(f"legal action refused — {label!r} in {self.g.phase}: {e}")

    def side_answers(self, chance: float):
        """Rivals skim the open question (MC only), as the bot driver does."""
        g, rng = self.g, self.rng
        q = g.question
        if q is None or q.get("typed"):
            return
        for p in list(g.players):
            if p.pid == g.current.pid or p.pid in g.side_answers:
                continue
            if rng.random() < chance:
                skill = self.skills.get(p.pid, bots.PHILOSOPHERS[0])
                idx = bots.decide_answer(g, skill, rng)
                self.note(f"{p.pid}: side answer {idx}")
                g.side_answer(p.pid, idx)
                self.expect_error("second side answer",
                                  lambda pid=p.pid: g.side_answer(pid, idx))

    def act_bot(self):
        """server.bot_move, one action per call. A GameError the server has
        no fallback for would leave a real bot stuck forever — so it fails."""
        g, rng = self.g, self.rng
        p = g.current
        pid, ph = p.pid, g.phase
        skill = self.skills[pid]

        def must(label, fn):
            self.note(f"{pid}(bot): {label}")
            try:
                fn()
            except GameError as e:
                self.fail(f"BOT STUCK — {label!r} in {ph}: {e}")

        def attempt(label, fn) -> bool:
            self.note(f"{pid}(bot): {label}")
            try:
                fn()
                return True
            except GameError:
                return False

        if ph == "roll":
            must("roll", lambda: self.do_roll(pid))
        elif ph == "trade":
            buy = bots.decide_remote_buy(g, pid)
            if buy:
                attempt(f"buy {buy}", lambda: g.shop_buy(pid, buy))
            must("pass", lambda: g.pass_turn(pid))
        elif ph == "sail":
            node = bots.decide_sail(g, pid, rng)
            if not node:
                self.fail("BOT STUCK — decide_sail found no move")
            must(f"sail {node}", lambda: g.sail(pid, node))
        elif ph == "shrine":
            tier = bots.decide_shrine_tier(g, pid, skill, rng)
            if not attempt(f"wager {tier}", lambda: g.wager(pid, tier)):
                must("pass", lambda: g.pass_turn(pid))
        elif ph == "haven":
            if not attempt("repair", lambda: g.repair(pid)):
                must("pass", lambda: g.pass_turn(pid))
        elif ph == "pharos":
            if not attempt("enter pharos", lambda: g.enter_pharos(pid)):
                must("pass", lambda: g.pass_turn(pid))
        elif ph == "shop":
            buy = bots.decide_shop(g, pid)
            if not buy or not attempt(f"buy {buy}", lambda: g.shop_buy(pid, buy)):
                must("pass", lambda: g.pass_turn(pid))
        elif ph == "battle":
            choice = bots.decide_battle(g, pid, rng, skill)
            if choice == "planks":
                if not attempt("planks", lambda: g.use_item_charm(pid, "planks")):
                    must("magic", lambda: g.stance(pid, "magic"))
            elif choice == "flee":
                if not attempt("flee", lambda: g.flee(pid)):
                    must("strike", lambda: g.stance(pid, "attack"))
            elif choice == "heal":
                must("heal", lambda: g.stance(pid, "heal", 0, "mc"))
            else:
                must(choice, lambda: g.stance(pid, choice))
        elif ph == "jchoose":
            n = len(g.jboard["cells"]) if g.jboard else 1
            must("jpick", lambda: g.jpick(pid, rng.randrange(n)))
        elif ph == "question":
            self.side_answers(0.9)
            if g.question.get("typed"):
                text = bots.decide_typed_answer(g, skill, rng)
                must("type", lambda: g.answer_text(pid, text))
            else:
                idx = bots.decide_answer(g, skill, rng)
                must(f"answer {idx}", lambda: g.answer(pid, idx))
        elif ph == "minigame":
            ok = rng.random() < minigame_odds(skill)
            self.note(f"{pid}(bot): minigame {'solved' if ok else 'failed'}")
            g.resolve_minigame(ok)
        elif ph == "upgrade_pick":
            must("pick", lambda: g.pick_upgrade(pid, bots.decide_upgrade(g, pid)))
        elif ph == "event":
            mv = EV.bot_decide(g, pid, skill.t2, rng)
            if mv is None:                               # answered: the table waits
                must("event idle", lambda: EV.idle_default(g, pid))
            else:
                must(f"{mv[0]} {mv[1]!r}", lambda: self.ev_send(pid, *mv))
        else:
            self.fail(f"bot has no move for phase {ph}")

    # ── adversarial input ────────────────────────────────────────────────────
    def junk(self):
        g, rng = self.g, self.rng
        r = rng.random()
        if r < 0.2:
            return rng.choice(list(g.board.nodes))
        if r < 0.3 and g.reachable:
            return rng.choice(list(g.reachable))
        if r < 0.38 and g.players:
            return rng.choice(g.players).pid
        return rng.choice(JUNK)

    def probe(self):
        """One illegal / out-of-turn / malformed / lucky-legal call."""
        g, rng = self.g, self.rng
        pids = [p.pid for p in g.players]
        cur = g.current.pid if g.players and g.phase != "lobby" else None
        others = [x for x in pids if x != cur]
        who = rng.choice([cur, cur, cur,
                          rng.choice(others) if others else "ghost",
                          rng.choice(others) if others else None,
                          "ghost", None, 7, ""])
        j, j2, j3 = self.junk(), self.junk(), self.junk()
        is_s = lambda v: isinstance(v, str)                         # noqa: E731
        is_i = lambda v: type(v) is int                             # noqa: E731
        host = self.host()
        table = [
            ("sail", lambda: g.sail(who, j), is_s(j), True),
            ("walk_step", lambda: g.walk_step(who, j), is_s(j), True),
            ("jpick", lambda: g.jpick(who, j), is_i(j), True),
            ("wager", lambda: g.wager(who, j), is_i(j), True),
            ("pass_turn", lambda: g.pass_turn(who), True, True),
            ("enter_pharos", lambda: g.enter_pharos(who), True, True),
            ("repair", lambda: g.repair(who), True, True),
            ("shop_buy", lambda: g.shop_buy(who, j), is_s(j), True),
            ("buy_map", lambda: g.buy_map(who), True, True),
            ("use_item_charm", lambda: g.use_item_charm(who, j), is_s(j), True),
            ("stance", lambda: g.stance(who, j, j2, j3),
             is_s(j) and is_i(j2) and (j3 is None or is_s(j3)), True),
            ("flee", lambda: g.flee(who), True, True),
            ("use_item", lambda: g.use_item(who, j), is_s(j), True),
            ("answer", lambda: g.answer(who, j), is_i(j), True),
            ("side_answer", lambda: g.side_answer(who, j), is_i(j), False),
            ("answer_text", lambda: g.answer_text(who, j), True, True),
            ("minigame_submit", lambda: g.minigame_submit(who, j), True, True),
            ("pick_upgrade", lambda: g.pick_upgrade(who, j), is_s(j), True),
            ("roll", lambda: g.roll(who, j), is_i(j) and 1 <= j <= 6, True),
            ("event_choose", lambda: EV.choose(g, who, j), is_i(j), True),
            ("event_move", lambda: EV.game_move(g, who, j), True, True),
            ("event_answer", lambda: EV.answer(g, who, j), True, False),
            ("event_bet", lambda: EV.bet(g, who, j), type(j) is bool, False),
            ("start", lambda: g.start(who), True, False),
            ("add_player", lambda: g.add_player("late", "Late"), False, False),
        ]
        if who != host:
            table.append(("remove_player", lambda: g.remove_player(who, j), False, False))
            table.append(("rematch", lambda: g.rematch(who), False, False))
        name, call, args_ok, turn_gated = rng.choice(table)
        label = f"probe {name}(who={who!r}, {j!r}, {j2!r}, {j3!r})"
        before = fingerprint(g)
        phase_before = g.phase
        self.probes += 1
        try:
            call()
        except GameError:
            self.probe_rejects += 1
            if fingerprint(g) != before:
                self.note(label)
                self.fail(f"{label} in {phase_before}: GameError raised "
                          f"but state was mutated")
            return
        except Exception as e:                           # noqa: BLE001
            self.note(label)
            self.fail(f"{label} in {phase_before}: raised {type(e).__name__}: {e} "
                      f"(must be GameError)")
        changed = fingerprint(g) != before
        if not changed:
            return                                       # a silent no-op is fine
        self.note(label + " → accepted")
        if who not in pids:
            self.fail(f"{label} in {phase_before}: accepted from a non-player")
        if turn_gated and who != cur:
            self.fail(f"{label} in {phase_before}: accepted out of turn")
        if not args_ok:
            self.fail(f"{label} in {phase_before}: malformed arguments were accepted")
        if name == "minigame_submit":
            self._wrong_tries = 0

    def stale_timers(self):
        """Timers firing in the wrong phase must be perfect no-ops."""
        g = self.g
        before = fingerprint(g)
        ph = g.phase
        try:
            if ph != "question" or g.question is None:
                g.timeout_question()
            if ph != "minigame":
                g.minigame_timeout()
                g.resolve_minigame(True)
                g.resolve_minigame(False)
            if ph != "jchoose":
                g.jchoose_timeout()
            if ph != "event":
                EV.timeout(g)
            if ph != "reveal":
                g.advance_after_reveal()
            if ph != "question" or g.question is not None:
                g.set_question({"text": "stale?", "options": ["a", "b", "c", "d"],
                                "correct": 0})
        except Exception as e:                           # noqa: BLE001
            self.fail(f"stale timer in {ph} raised {type(e).__name__}: {e}")
        if fingerprint(g) != before:
            self.fail(f"a stale timer mutated state in phase {ph}")

    def kick(self):
        g, rng = self.g, self.rng
        host = self.host()
        victims = [p.pid for p in g.players if p.pid != host]
        if not victims:
            return
        cur = g.current.pid
        victim = cur if (cur in victims and rng.random() < 0.6) else rng.choice(victims)
        phase = g.phase
        self.note(f"KICK {victim} (current={cur}) by {host}")
        g.remove_player(host, victim)
        if len(g.players) == 1:
            self.kicked_to_win = True
        self.kicks += 1
        self.stats[f"kick_in_{phase}"] += 1
        self.policy.pop(victim, None)
        if g.player_by_pid(victim) is not None:
            self.fail("kicked player is still seated")
        if self.pending_gate and self.pending_gate["pid"] == victim:
            self.pending_gate = None

    def afk(self):
        """The captain whose turn it is has walked away: the server's idle
        clock acts for them (server.idle_step), in whatever phase this is."""
        g = self.g
        if g.phase in ("lobby", "finished", "reveal") or \
                (g.phase == "question" and g.question is None):
            return
        cur = g.current.pid
        phase, turn, nonce = g.phase, self.turns, g.nonce
        step = idle_step_fn()
        self.note(f"AFK {cur}: the idle clock acts")
        self.stats[f"afk_in_{phase}"] += 1
        if step is not None:
            step(g, cur)
        elif phase in ("roll", "sail"):
            g._next_turn()                               # the plain forfeit
        else:
            return
        if g.phase == phase and self.turns == turn and g.nonce == nonce:
            self.fail(f"the idle clock could not move an absent captain on from {phase}")

    def teleport(self):
        """DEV-style drop (server 'dev' message with land=1): put the captain
        whose roll it is straight onto an interesting stop and resolve it."""
        g, rng = self.g, self.rng
        p = g.current
        nodes = g.board.nodes
        want = rng.choice(["lair", "lair", "pharos", "sword", "sphinx", "puzzle",
                           "shrine", "haven", "shop", "vale", "vale_monster",
                           "gate", "home", "elite", "hubsea", "any"])
        pick = {
            "lair": lambda n: n["type"] == "lair",
            "pharos": lambda n: n["type"] == "pharos",
            "sword": lambda n: n.get("sword"),
            "sphinx": lambda n: n.get("sphinx"),
            "puzzle": lambda n: n["type"] == "puzzle",
            "shrine": lambda n: n["type"] == "shrine",
            "haven": lambda n: n["type"] == "haven",
            "shop": lambda n: n["type"] == "shop",
            "vale": lambda n: n.get("region") == "autumn",
            "vale_monster": lambda n: n.get("region") == "autumn" and n["type"] == "monster",
            "gate": lambda n: n["type"] == "gate",
            "home": lambda n: n["type"] == "home",
            "elite": lambda n: n.get("elite"),
            "hubsea": lambda n: n["type"] == "sea" and not n.get("region"),
            "any": lambda n: True,
        }[want]
        cands = [nid for nid, n in nodes.items() if pick(n)]
        if not cands:
            return
        nid = rng.choice(cands)
        self.note(f"TELEPORT {p.pid} → {nid} ({want})")
        p.prev_node = p.node
        p.node = nid
        g._reveal_vale(p)
        g._land(p, nid)

    def grant(self):
        g, rng = self.g, self.rng
        p = rng.choice(g.players)
        kind = rng.choice(["scrolls", "scrolls", "seals", "upgrade", "items",
                           "wound", "sword", "broke", "warden"])
        self.note(f"GRANT {kind} → {p.pid}")
        if kind == "scrolls":
            p.scrolls += rng.choice([5, 20, 60])
        elif kind == "broke":
            p.scrolls = 0
        elif kind == "seals":
            if p.banked < RELICS_TO_WIN:
                self.granted[p.pid] = self.granted.get(p.pid, 0) + RELICS_TO_WIN - p.banked
                p.banked = RELICS_TO_WIN
            g.pharos_open = True
        elif kind == "upgrade":
            # (never one that is on the table as a prize right now — only a
            # pick can hand those over)
            pool = [u for u in list(G.UPGRADES) + list(G.RELICS)
                    if not p.has(u) and u not in (g.upgrade_offer or ())]
            if pool:
                g._apply_upgrade(p, rng.choice(pool))
        elif kind == "items":
            for it in p.items:
                p.items[it] = rng.randint(0, G.ITEM_CAP)
        elif kind == "wound":
            p.hull = rng.choice([0.5, 1, 1.5, 2])
        elif kind == "sword":
            if not p.has("sword_of_damocles"):
                p.upgrades.append("sword_of_damocles")
        elif kind == "warden":
            # wear the Dark Presence down so random play still reaches the
            # victory screen (answers decide every blow now — no lucky dodges)
            m = g.board.alive_monster("pharos")
            if m:
                m["enemies"][0]["hp"] = min(m["enemies"][0]["hp"], rng.choice([1, 2, 3]))

    def chaos(self):
        g, rng = self.g, self.rng
        if g.phase in ("lobby", "finished"):
            return
        r = rng.random()
        if r < 0.30:
            for _ in range(rng.randint(1, 3)):
                self.probe()
                if g.phase == "finished":
                    return
        if rng.random() < 0.05:
            self.stale_timers()
        if rng.random() < 0.004 and self.kicks < 2 and len(g.players) > 1:
            self.kick()
            return
        if rng.random() < 0.01:
            p = rng.choice(g.players)
            p.connected = not p.connected                # a dropped / returning socket
            self.note(f"CONNECTED {p.pid} = {p.connected}")
        if rng.random() < 0.012:
            self.afk()
            if g.phase == "finished":
                return
        if g.phase == "roll" and rng.random() < 0.10:
            self.teleport()
        if rng.random() < 0.02:
            self.grant()

    # ── invariants ───────────────────────────────────────────────────────────
    def check(self, snapshots: bool | None = None):
        g = self.g
        ph = g.phase
        if ph not in PHASES:
            self.fail(f"unknown phase {ph!r}")
        self.phases_seen[ph] += 1
        if ph == "lobby":
            return
        if not g.players:
            self.fail("a running game has no players")
        if not (0 <= g.turn_idx < len(g.players)):
            self.fail(f"turn_idx {g.turn_idx} out of range ({len(g.players)} players)")
        pids = [p.pid for p in g.players]
        if len(set(pids)) != len(pids):
            self.fail(f"duplicate pids {pids}")
        nodes = g.board.nodes
        lairs = [nodes[n] for n in g.board.lairs()]
        for p in g.players:
            who = f"{p.name}/{p.pid}"
            if type(p.scrolls) is not int or p.scrolls < 0:
                self.fail(f"{who}: scrolls = {p.scrolls!r}")
            if not (0 < p.hull <= p.max_hull):
                self.fail(f"{who}: hull {p.hull} outside (0, {p.max_hull}]")
            if (p.hull * 2) != int(p.hull * 2):
                self.fail(f"{who}: hull {p.hull} is not a half-heart value")
            if p.max_hull < G.MAX_HULL:
                self.fail(f"{who}: max_hull shrank to {p.max_hull}")
            for it, n in p.items.items():
                if type(n) is not int or not (0 <= n <= G.ITEM_CAP):
                    self.fail(f"{who}: carries {n!r} × {it}")
            if len(set(p.upgrades)) != len(p.upgrades):
                self.fail(f"{who}: duplicate upgrades {p.upgrades}")
            # what is earned stays earned (until a rematch)
            was = self._earned.get(p.pid)
            now = (p.banked, p.max_hull, len(p.upgrades), p.cheated_death)
            if was and any(a < b for a, b in zip(now, was)):
                self.fail(f"{who}: lost something permanent — "
                          f"(banked, max_hull, upgrades, phoenix) {was} → {now}")
            self._earned[p.pid] = now
            for u in p.upgrades:
                if u not in G.ALL_UPGRADES:
                    self.fail(f"{who}: unknown upgrade {u!r}")
            for attr in ("node", "prev_node", "checkpoint"):
                if getattr(p, attr) not in nodes:
                    self.fail(f"{who}: {attr} = {getattr(p, attr)!r} is not on the chart")
            if nodes[p.checkpoint]["type"] not in ("home", "haven"):
                self.fail(f"{who}: checkpoint on a {nodes[p.checkpoint]['type']}")
            if p.streak < 0 or p.skip_turns < 0 or p.next_roll_bonus < 0:
                self.fail(f"{who}: negative counter")
            if p.skip_turns > 1:
                self.fail(f"{who}: owes the kraken {p.skip_turns} turns")
            gale_cap = getattr(G, "GALE_STACK_CAP", None)
            if gale_cap is not None and p.next_roll_bonus > gale_cap:
                self.fail(f"{who}: armed gale bonus {p.next_roll_bonus} > cap")
            # seal conservation: every boss you beat left its seal in exactly
            # one place — your hold, the altar's stash, or the vault at home
            beaten = sum(1 for n in lairs if p.pid in n["defeated"])
            stashed = sum(1 for n in lairs if p.pid in n["stash"])
            held = len(p.cargo)
            if len(set(p.cargo)) != held:
                self.fail(f"{who}: duplicate seals aboard {p.cargo}")
            if p.banked + held + stashed != beaten + self.granted.get(p.pid, 0):
                self.fail(f"{who}: seal conservation broken — banked {p.banked} + "
                          f"cargo {held} + stashed {stashed} != beaten {beaten} "
                          f"(+{self.granted.get(p.pid, 0)} granted)")
        for n in lairs:
            if len(set(n["defeated"])) != len(n["defeated"]):
                self.fail(f"lair {n['id']}: a captain defeated it twice")
            if not set(n["stash"]) <= set(n["defeated"]):
                self.fail(f"lair {n['id']}: stash holds a seal nobody earned")
        cur = g.current
        # ── per-phase structure ──────────────────────────────────────────────
        battleish = ph in ("battle", "jchoose", "question", "minigame", "reveal")
        if g.battle is not None and not battleish:
            self.fail(f"battle state left over in phase {ph}")
        if g.battle is not None:
            bn = g.battle.get("node")
            if bn not in nodes:
                self.fail("battle on a node that is not on the chart")
        if ph == "battle":
            if g.battle is None:
                self.fail("battle phase without battle state")
            if not g.board.alive_monster(g.battle["node"]):
                self.fail("battle phase with nothing left to fight")
            if cur.node != g.battle["node"]:
                self.fail(f"{cur.pid} fights at {g.battle['node']} but stands on {cur.node}")
            if g.battle.get("sphinx"):
                self.fail("the staged Sphinx reached the stance phase")
        if g.battle and g.battle.get("incoming"):
            self.fail("a blow left hanging (the dodge beat is gone)")
        if ph == "battle" and g.battle.get("charging") is None:
            self.fail("battle state lost its heavy-blow rhythm")
        if ph == "minigame":
            mg = g.minigame
            if not mg:
                self.fail("minigame phase without a minigame")
            if mg.get("battle") and g.battle is None:
                self.fail("battle minigame without a battle")
            if mg.get("kraken") and not g.kraken:
                self.fail("kraken riddle without the kraken")
            if mg.get("sphinx") and not (g.battle and g.battle.get("sphinx")):
                self.fail("sphinx riddle without her stage")
            if mg["kind"] not in puzzles._CHECKERS:
                self.fail(f"minigame kind {mg['kind']!r} has no checker")
        elif g.minigame is not None:
            self.fail(f"minigame left over in phase {ph}")
        self.check_events()
        if g.kraken is not None and not (ph == "minigame" and g.minigame.get("kraken")):
            self.fail(f"kraken state left over in phase {ph}")
        if ph == "jchoose":
            if not g.jboard or g.qctx is None:
                self.fail("jchoose phase without a board / question context")
        elif g.jboard is not None:
            self.fail(f"Jeopardy board left over in phase {ph}")
        if getattr(g, "_pending_jeopardy", None) is not None \
                and not (ph == "question" and g.question is None):
            self.fail(f"a picked Jeopardy clue is left over in phase {ph}")
        if ph == "question":
            if g.qctx is None:
                self.fail("question phase without a question context")
            if g.qctx["kind"] == "battle" and g.battle is None:
                self.fail("battle question without a battle")
        elif g.question is not None and ph != "reveal":
            self.fail(f"a question is left over in phase {ph}")
        if g.question is not None and g.qctx is None:
            self.fail("a question with no context (snapshots would crash)")
        if ph == "reveal" and g.reveal is None:
            self.fail("reveal phase with nothing to reveal")
        if ph == "upgrade_pick":
            if not g.upgrade_offer:
                self.fail("upgrade_pick with an empty offer")
            for u in g.upgrade_offer:
                if cur.has(u) or u not in G.ALL_UPGRADES:
                    self.fail(f"upgrade offer holds {u!r} (owned or unknown)")
        elif g.upgrade_offer and ph != "reveal":
            self.fail(f"upgrade offer left over in phase {ph}")
        if ph == "sail":
            if not g.reachable and not (g.walk and g.walk.get("options")):
                self.fail("SOFTLOCK: sail phase with nowhere to go")
            for nid in g.reachable:
                if nid not in nodes:
                    self.fail(f"reachable holds {nid!r}, not on the chart")
        else:
            if g.reachable:
                self.fail(f"reachable set left over in phase {ph}")
            if g.walk is not None:
                self.fail(f"arrow-walk left over in phase {ph}")
        if g.walk is not None and g.walk["pid"] != cur.pid:
            self.fail("the arrow-walk belongs to someone whose turn it is not")
        if ph == "shrine":
            n = nodes[cur.node]
            if n["type"] != "shrine" or n.get("charges", 0) <= 0:
                self.fail("shrine phase away from a charged shrine")
        if ph == "haven" and nodes[cur.node]["type"] != "haven":
            self.fail("haven phase away from a haven")
        if ph == "shop" and nodes[cur.node]["type"] != "shop":
            self.fail("shop phase away from a market")
        if ph == "pharos" and nodes[cur.node]["type"] != "pharos":
            self.fail("pharos phase away from the Pharos")
        if g.winner is not None:
            if ph not in ("reveal", "finished"):
                self.fail(f"a winner is declared but the phase is {ph}")
            if g.winner not in pids:
                self.fail(f"winner {g.winner!r} is not at the table")
            w = g.player_by_pid(g.winner)
            if len(pids) > 1 and not self.kicked_to_win and not (
                    w.banked >= RELICS_TO_WIN and g.pharos_open
                    and w.node == "pharos"):
                self.fail(f"{g.winner} won without three banked seals at the Pharos "
                          f"(banked {w.banked}, at {w.node})")
        if ph == "finished" and g.winner is None:
            self.fail("finished with no winner")
        for spid in g.side_answers:
            if spid not in pids:
                self.fail(f"side answer from {spid!r}, who is not at the table")
            if spid == cur.pid and ph == "question":
                self.fail("the challenger holds a side answer on their own question")
        if g.side_answers and ph not in ("question", "jchoose", "minigame"):
            self.fail(f"side answers left over in phase {ph}")
        # the Sphinx's diorama must never outlive her riddle
        staged = [nid for nid, n in nodes.items()
                  if isinstance(n.get("monster"), dict) and n["monster"].get("riddle")]
        if staged and not (g.battle and g.battle.get("sphinx")):
            self.fail(f"a staged Sphinx was left standing at {staged}")
        for nid, n in nodes.items():
            if n["type"] == "shrine" and n.get("charges", 0) < 0:
                self.fail(f"shrine {nid} has negative charges")
            m = n.get("monster")
            if m and not m.get("enemies"):
                self.fail(f"monster with no enemies at {nid}")
        hp = getattr(g, "host_pid", None)
        if hp is not None and hp not in pids:
            self.fail("the host is not at the table")
        # ── snapshots ────────────────────────────────────────────────────────
        # every viewer the moment a new challenge (question / minigame /
        # Jeopardy board) is on the table — that is when a leak would matter —
        # and one random viewer every few actions otherwise
        challenge = (g.question if ph == "question" else
                     g.minigame if ph == "minigame" else
                     g.jboard if ph == "jchoose" else None)
        fresh = challenge is not None and challenge is not self._seen_challenge
        if fresh:
            self._seen_challenge = challenge
        if snapshots:
            for v in pids + [None, "ghost"]:
                self.check_snapshot(v)
        elif fresh:
            # the challenge subtree is the same for every viewer: the
            # challenger, one rival / spectator
            self.check_snapshot(cur.pid)
            self.check_snapshot(self.rng.choice(
                [x for x in pids if x != cur.pid] + [None, "ghost"]))
        elif snapshots is None and self.actions != self._snap_at \
                and self.actions % self.snapshot_every == 0:
            self._snap_at = self.actions
            self.check_snapshot(self.rng.choice(pids + [None]))

    def check_events(self):
        """events.py invariants: one open event, owned by the acting captain,
        in a phase that can show it; world wonders on the chart; sane buffs."""
        g = self.g
        ph = g.phase
        act = g.ev["active"]
        if ph == "event":
            if not act:
                self.fail("event phase with no open event")
            if act["pid"] != g.current.pid:
                self.fail(f"the open event belongs to {act['pid']}, not {g.current.pid}")
            if act["step"] not in ("card", "game", "table"):
                self.fail(f"event phase on step {act['step']!r}")
            if act["step"] == "card" and not any(o["ok"] for o in act["options"]):
                self.fail(f"event {act['id']} offers no choosable option")
            if act["step"] == "game" and (not act["game"] or act["game"].get("done")):
                self.fail("event game step with no live game")
            if act["step"] == "table":
                for pid in act["table"]["answers"]:
                    if g.player_by_pid(pid) is None:
                        self.fail(f"a table answer from {pid}, who is not at the table")
        elif ph == "minigame" and g.minigame and g.minigame.get("event"):
            if not act or act["step"] != "puzzle":
                self.fail("an event puzzle with no open event")
        elif act is not None:
            self.fail(f"event {act['id']} left open in phase {ph}")
        if g.minigame and not g.minigame.get("event") and act is not None:
            self.fail("an open event under a non-event minigame")
        for w in g.ev["world"]:
            if w["node"] not in g.board.nodes:
                self.fail(f"world wonder {w['id']} on {w['node']!r}, not on the chart")
            if w["rounds"] <= 0:
                self.fail(f"world wonder {w['id']} outlived its rounds")
        ids = [w["id"] for w in g.ev["world"]]
        if len(ids) != len(set(ids)):
            self.fail(f"duplicate world wonders {ids}")
        for p in g.players:
            for bid, n in p.buffs.items():
                if bid not in EV.BUFFS or type(n) is not int or not 1 <= n <= EV.BUFF_CAP:
                    self.fail(f"{p.pid} carries buff {bid}x{n!r}")

    def check_snapshot(self, viewer):
        g = self.g
        try:
            snap = g.to_dict(viewer)
            text = json.dumps(snap, allow_nan=False)
        except Exception as e:                           # noqa: BLE001
            self.fail(f"snapshot for {viewer!r} in {g.phase}: "
                      f"{type(e).__name__}: {e}")
        self.stats["snapshots"] += 1
        ph = g.phase
        if snap["phase"] != ph:
            self.fail("snapshot phase mismatch")
        cur = g.current.pid
        if snap["turn"] != cur:
            self.fail("snapshot turn mismatch")
        if viewer != cur and snap["reachable"]:
            self.fail(f"reachable set leaked to {viewer!r}")
        if snap["walk"] is not None and viewer != cur:
            self.fail(f"arrow-walk leaked to {viewer!r}")
        vp = g.player_by_pid(viewer) if viewer else None
        if snap["sword_node"] is not None and not (vp and vp.map_bought):
            self.fail(f"the sword islet leaked to {viewer!r}")
        if ph != "reveal" and snap["reveal"] is not None:
            self.fail(f"a reveal is published in phase {ph}")
        if ph != "upgrade_pick" and snap["upgrade_offer"] is not None:
            self.fail(f"an upgrade offer is published in phase {ph}")
        for n in snap["board"]["nodes"]:
            owner = g.board.nodes[n["id"]].get("owner")
            if owner is not None and owner != viewer:
                self.fail(f"fogged Vale stop {n['id']} shown to {viewer!r}")
        shown = {n["id"] for n in snap["board"]["nodes"]}
        for pl in snap["players"]:
            if pl["node"] not in shown:
                self.fail(f"player {pl['pid']} stands on a stop the snapshot hides")
        # nothing that answers an OPEN challenge may be on the wire
        for part in ("question", "minigame", "jboard", "event"):
            sub = snap.get(part)
            if sub is None:
                continue
            for path, k, _v in _walk_keys(sub):
                if k in SECRET_KEYS:
                    self.fail(f"snapshot[{part}{path}] carries the key {k!r} "
                              f"in phase {ph} (viewer {viewer!r})")
        if ph == "question" and g.question is not None and snap["question"] is None:
            self.fail("an open question is missing from the snapshot")
        if snap["question"] is not None:
            allowed = {"text", "options", "typed", "category", "kind", "tier",
                       "domain", "deadline", "disabled"}
            extra = set(snap["question"]) - allowed
            if extra:
                self.fail(f"question snapshot carries unexpected fields {sorted(extra)}")
            if g.question.get("typed") and snap["question"]["options"]:
                self.fail("a typed clue went out with options attached")
        if ph == "minigame" and g.minigame:
            sec = (g.minigame["data"].get("secret") or {})
            mg_vals = [v for v in _values(snap["minigame"]) if isinstance(v, str)]
            for key in ("word", "answer"):
                s = sec.get(key)
                if isinstance(s, str) and len(s) > 2 and any(
                        s.lower() == v.lower() for v in mg_vals):
                    self.fail(f"minigame secret {key!r} is on the wire")
            if snap["minigame"] is None:
                self.fail("an open minigame is missing from the snapshot")
        ev = snap.get("event")
        if ev and ev.get("table"):
            act = g.ev["active"]
            if ev["table"].get("mine_in") and viewer not in act["table"]["answers"]:
                self.fail("a table answer is shown as mine to someone who gave none")
            for path, k, v in _walk_keys(ev):
                if k == "answers":
                    self.fail(f"sealed table answers on the wire (viewer {viewer!r})")
        if ev and ev.get("game") and "secret" in ev["game"]:
            self.fail("an event game's secret is on the wire")
        if ph == "jchoose":
            jb = snap["jboard"]
            if not jb or any(set(c) - {"category", "value"} for c in jb["cells"]):
                self.fail("the Jeopardy board shows more than category + value")
        if snap["host"] not in [p.pid for p in g.players]:
            self.fail("snapshot host is not at the table")
        return text

    # ── rematch ──────────────────────────────────────────────────────────────
    def check_fresh(self, old_board):
        g = self.g
        if g.board is old_board:
            self.fail("rematch kept the old board")
        if g.phase != "roll" or g.turn_idx != 0 or g.winner is not None:
            self.fail("rematch did not reset to the first roll")
        leftovers = {
            "battle": g.battle, "minigame": g.minigame, "kraken": g.kraken,
            "question": g.question, "qctx": g.qctx, "reveal": g.reveal,
            "walk": g.walk, "jboard": g.jboard, "upgrade_offer": g.upgrade_offer,
            "gate_walk": g.gate_walk, "die": g.die, "flash": g.flash,
            "_pending_jeopardy": getattr(g, "_pending_jeopardy", None),
            "_pending_puzzle": getattr(g, "_pending_puzzle", None),
            "jchoose_deadline": g.jchoose_deadline,
            "question_deadline": g.question_deadline,
        }
        for k, v in leftovers.items():
            if v:
                self.fail(f"rematch left {k} = {v!r}")
        if g.reachable or g.side_answers or g.used_puzzles or g.log or g.pharos_open:
            self.fail("rematch left table state behind")
        for p in g.players:
            fresh = (p.node == p.prev_node == p.checkpoint == "home"
                     and p.scrolls == 3 and p.hull == p.max_hull == G.MAX_HULL
                     and not p.cargo and p.banked == 0 and not p.upgrades
                     and not any(p.items.values()) and p.next_roll_bonus == 0
                     and not p.map_bought and p.streak == 0 and p.skip_turns == 0
                     and not p.cheated_death and p.puzzles_solved == 0)
            if not fresh:
                self.fail(f"rematch did not reset {p.pid}: {p.public()}")
        for nid, n in g.board.nodes.items():
            if n["type"] == "lair" and (n["defeated"] or n["stash"]):
                self.fail("rematch board has a used lair")

    def do_rematch(self):
        g = self.g
        host = self.host()
        for p in g.players:
            if p.pid != host:
                self.expect_error("rematch by non-host", lambda pid=p.pid: g.rematch(pid))
        old = g.board
        self.note("REMATCH")
        g.rematch(host)
        self.granted.clear()
        self.kicked_to_win = False
        self._earned.clear()
        self.pending_gate = None
        self._last_battle = None
        self._fight = None
        self._tried.clear()
        self._ev_fired, self._ev_counts = 0, {}
        self.rematches += 1
        self.check_fresh(old)

    # ── bookkeeping for the balance report ───────────────────────────────────
    def observe(self):
        g = self.g
        b = g.battle
        if b is not None and b is not self._last_battle and not b.get("sphinx"):
            node = g.board.nodes[b["node"]]
            kind = node["type"]
            self.stats["battles"] += 1
            if kind == "lair":
                self.stats["boss_fights"] += 1
                # how many rivals already beat this boss (it rises harder)
                self.stats[f"boss_fights_risen{min(3, len(node['defeated']))}"] += 1
                self._boss_ctx = ("lair", g.current.pid, b["node"],
                                  len(node["defeated"]))
            elif kind == "pharos":
                self.stats["warden_fights"] += 1
            elif node.get("sword"):
                self.stats["sword_fights"] += 1
            elif node.get("elite"):
                self.stats["elite_fights"] += 1
        self._watch_fight(b)
        self._last_battle = b
        fired = sum(g.ev["fired"].values())
        if fired > self._ev_fired:
            for eid, n in g.ev["fired"].items():
                k = n - self._ev_counts.get(eid, 0)
                if k > 0:
                    ev = EV.EVENTS_BY_ID[eid]
                    self.stats["events"] += k
                    self.stats[f"events_{ev['kind']}"] += k
                    self.stats[f"events_{ev['stage']}"] += k
                    if ev.get("world"):
                        self.stats["events_world"] += k
            self._ev_counts = dict(g.ev["fired"])
        self._ev_fired = fired
        if self.first_three is None and self.rematches == 0 and not self.granted:
            top = max(p.banked for p in g.players)
            if top >= 1 and self.first_seal is None:
                self.first_seal = self.turns
            if top >= RELICS_TO_WIN:
                self.first_three = self.turns
        if self._boss_ctx:
            _, pid, nid, before = self._boss_ctx
            node = g.board.nodes.get(nid)
            if node is None or g.battle is None:
                if node is not None and len(node["defeated"]) > before:
                    self.stats["boss_wins"] += 1
                    self.stats[f"boss_wins_risen{min(3, before)}"] += 1
                self._boss_ctx = None

    def _watch_fight(self, b):
        """Per-fight combat report: exchanges per fight, and how often a
        captain's FIRST attempt at a trial (each realm boss, the Warden) wins."""
        g = self.g
        f = self._fight
        if f and g.phase == "reveal" and g.reveal is not f["rv"] \
                and (g.reveal or {}).get("kind") == "battle":
            f["rv"] = g.reveal
            f["ex"] += 1
        if f and b is not f["b"]:
            node = g.board.nodes.get(f["nid"])
            p = g.player_by_pid(f["pid"])
            if f["kind"] == "boss":
                won = node is not None and f["pid"] in node.get("defeated", [])
            elif f["kind"] == "warden":
                won = g.winner == f["pid"]
            else:
                won = (self.stats["shipwrecks"] == f["wrecks"] and node is not None
                       and g.board.alive_monster(f["nid"]) is None)
            k = f["kind"]
            self.stats[f"fx_{k}_n"] += 1
            self.stats[f"fx_{k}_ex"] += f["ex"]
            self.stats[f"fx_{k}_won"] += bool(won)
            if f["first"]:
                self.stats[f"fx_{k}_first_n"] += 1
                self.stats[f"fx_{k}_first_won"] += bool(won)
                if not f["eased"]:
                    self.stats[f"fx_{k}_fresh_n"] += 1
                    self.stats[f"fx_{k}_fresh_won"] += bool(won)
            if k == "pack" and p is not None and won:
                self.stats["fx_pack_hull_lost"] += max(0, f["hull"] - p.hull)
            self._fight = None
        if b is not None and self._fight is None and not b.get("sphinx"):
            node = g.board.nodes[b["node"]]
            kind = ("boss" if node["type"] == "lair" else
                    "warden" if node["type"] == "pharos" else "pack")
            key = (g.current.pid, b["node"])
            first = key not in self._tried
            self._tried.add(key)
            if first and kind != "pack":
                cp = g.current
                self.stats[f"fx_{kind}_ready"] += bots.readiness(cp)
                self.stats[f"fx_{kind}_maxhull"] += cp.max_hull
            self._fight = {"b": b, "kind": kind, "nid": b["node"], "pid": g.current.pid,
                           "first": first and kind != "pack", "ex": 0, "rv": None,
                           "wrecks": self.stats["shipwrecks"], "hull": g.current.hull,
                           "eased": bool((g.board.nodes[b["node"]].get("monster") or {})
                                         .get("escalation"))}

    # ── the main loop ────────────────────────────────────────────────────────
    def _ledger(self, actor: str, purse: dict, wrecks: int, ev_seq: int = -1):
        """Where scrolls come from and go (bots tables — the economy report)."""
        g = self.g
        label = self._last_label
        rv = g.reveal if g.phase == "reveal" else None
        # an event concluded this step (its result card was posted): its
        # scrolls — prizes, fines, bets — are event money, by stage
        ev_stage = None
        if ev_seq >= 0 and g.ev.get("seq", 0) != ev_seq and g.ev.get("card"):
            ev_stage = EV.EVENTS_BY_ID.get(g.ev["card"]["id"], {}).get("stage", "hub")
        for p in g.players:
            d = p.scrolls - purse.get(p.pid, p.scrolls)
            if d and ev_stage:
                self.stats["in_events" if d > 0 else "out_events"] += abs(d)
                self.stats[f"{'in' if d > 0 else 'out'}_events_{ev_stage}"] += abs(d)
                continue
            if d > 0:
                if p.pid != actor:
                    key = "in_side_answers"
                elif rv and rv.get("kind") == "shrine":
                    key = "in_shrines"
                elif rv and rv.get("kind") == "battle":
                    key = "in_battle_loot"
                elif ": sail" in label or ": walk" in label or "): sail" in label:
                    key = "in_salvage"
                else:
                    key = "in_other"
                self.stats[key] += d
            elif d < 0:
                if p.pid == actor and self.stats["shipwrecks"] > wrecks:
                    key = "out_shipwreck"
                elif ": buy" in label or "(bot): buy" in label:
                    key = "out_shop"
                elif "repair" in label:
                    key = "out_repair"
                elif "flee" in label:
                    key = "out_flee"
                else:
                    key = "out_other"
                self.stats[key] -= d

    def step(self):
        g = self.g
        self.server_duties()
        ph = g.phase
        actor = g.current.pid
        self._last_label = ""
        purse = {p.pid: p.scrolls for p in g.players}
        wrecks = self.stats["shipwrecks"]
        ev_seq = g.ev.get("seq", 0)
        if ph == "reveal":
            self.note("advance reveal")
            g.advance_after_reveal()
            if g.phase == "reveal":
                self.fail("SOFTLOCK: the reveal did not advance")
        elif ph == "question" and g.question is None:
            self.deliver_question()
        elif ph in ("event", "minigame") and g.ev["active"] and self._ev_others_pending() \
                and (self.mode == "bots" or self.rng.random() < 0.6):
            self.ev_table_round()
        elif self.policy.get(g.current.pid) == "bot":
            self.act_bot()
        else:
            if ph == "question":
                self.side_answers(0.5)
            self.act_random()
        self._ledger(actor, purse, wrecks, ev_seq)
        self.actions += 1
        self.turn_actions += 1
        if self.turn_actions > MAX_TURN_ACTIONS:
            self.fail(f"SOFTLOCK: one turn has taken {self.turn_actions} actions "
                      f"(phase {g.phase})")
        self.observe()

    def run(self) -> dict:
        g = self.g
        result = {"seed": self.seed, "players": self.n_players, "mode": self.mode,
                  "finished": False, "failure": None}
        result["replay"] = (f"python3 tools/sim.py --games 1 --seed {self.seed} "
                            f"--mode {self.mode} --players {self.seats} "
                            f"--max-turns {self.max_turns}"
                            + (f" --skill {SKILL}" if self.mode == "bots" and SKILL != "bots"
                               else "") + " --verbose")
        try:
            self._seat()
            while True:
                if g.phase == "finished":
                    self.check(snapshots=True)
                    if self.first_finish is None:
                        w = g.player_by_pid(g.winner)
                        self.first_finish = {
                            "turns": self.turns, "by_kick": self.kicks > 0
                            and not self.stats["warden_wins_seen"],
                            "winner_upgrades": list(w.upgrades) if w else []}
                    self.games_played += 1
                    if self.mode == "chaos" and self.rematches < 1:
                        self.do_rematch()
                        self.check(snapshots=True)
                        continue
                    result["finished"] = True
                    break
                if self.turns >= self.max_turns:
                    break
                if self.mode == "chaos":
                    self.chaos()
                    self.check()
                    if g.phase == "finished":
                        continue
                won_before = g.winner
                self.step()
                if g.winner and not won_before and not self.kicks:
                    self.stats["warden_wins_seen"] += 1
                self.check()
        except InvariantError as e:
            result["failure"] = str(e)
        except Exception as e:                           # noqa: BLE001
            result["failure"] = (f"CRASH {type(e).__name__}: {e}\n"
                                 + traceback.format_exc(limit=8))
        result["players"] = self.n_players                # a chaos lobby may add seats
        result.update(
            turns=self.turns, actions=self.actions, rematches=self.rematches,
            kicks=self.kicks, probes=self.probes, probe_rejects=self.probe_rejects,
            max_turn_actions=max(self.max_turn_actions, self.turn_actions),
            stats=dict(self.stats), phases=dict(self.phases_seen),
            first_finish=self.first_finish, trail=list(self.trail),
            first_three=self.first_three, first_seal=self.first_seal,
            final_players=len(g.players),
            banked=[p.banked for p in g.players],
            scrolls=[p.scrolls for p in g.players],
            upgrades=[len(p.upgrades) for p in g.players])
        return result


# ── batch driver ─────────────────────────────────────────────────────────────
def plan_for(seed: int, players: int | None, mode: str) -> tuple[int, str]:
    """Player count and table kind derive from the game seed alone, so
    ``--games 1 --seed N`` replays any game from a bigger batch."""
    n = players or (seed % G.MAX_PLAYERS) + 1
    if mode == "mixed":
        mode = "chaos" if (seed // G.MAX_PLAYERS) % 2 else "bots"
    return n, mode


def run_game(seed: int, players: int | None = None, mode: str = "mixed",
             max_turns: int | None = None, verbose: bool = False) -> dict:
    n, m = plan_for(seed, players, mode)
    if max_turns is None:
        max_turns = 200 * n + 300 if m == "bots" else 160
    dealer = questions.jeopardy_board
    if FAST_JEOPARDY:
        questions.jeopardy_board = _fast_jeopardy_board
    try:
        return Table(seed, n, m, max_turns, verbose=verbose).run()
    finally:
        questions.jeopardy_board = dealer


def _job(args) -> dict:
    return run_game(*args)


def run_batch(games: int, seed: int, players: int | None = None,
              mode: str = "mixed", max_turns: int | None = None,
              verbose: bool = False, progress: bool = False,
              jobs: int = 1) -> list[dict]:
    """Play ``games`` games on seeds seed … seed+games-1 (each game depends
    on its own seed only, so the batch is reproducible whatever ``jobs`` is)."""
    todo = [(seed + i, players, mode, max_turns, verbose) for i in range(games)]
    out: list[dict] = []
    t0 = time.time()

    def tick():
        if progress and len(out) % 25 == 0:
            bad = sum(1 for r in out if r["failure"])
            print(f"  … {len(out)}/{games} games, {bad} failing, "
                  f"{time.time() - t0:.0f}s", file=sys.stderr, flush=True)

    if jobs > 1 and games > 1:
        import multiprocessing as mp
        with mp.Pool(jobs) as pool:
            for r in pool.imap_unordered(_job, todo, chunksize=1):
                out.append(r)
                tick()
        out.sort(key=lambda r: r["seed"])
    else:
        for t in todo:
            out.append(_job(t))
            tick()
    return out


def _mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def summarize(results: list[dict]) -> str:
    L = []
    fails = [r for r in results if r["failure"]]
    L.append(f"games: {len(results)}   failures: {len(fails)}   "
             f"actions: {sum(r['actions'] for r in results):,}   "
             f"turns: {sum(r['turns'] for r in results):,}")
    for mode in ("bots", "chaos"):
        rs = [r for r in results if r["mode"] == mode]
        if not rs:
            continue
        tot = collections.Counter()
        phases = collections.Counter()
        for r in rs:
            tot.update(r["stats"])
            phases.update(r["phases"])
        fin = [r for r in rs if r["finished"]]
        L.append("")
        if mode == "bots":
            L.append(f"── bots tables (honest voyages): {len(rs)} games, {len(fin)} "
                     f"finished inside the turn cap ({100 * len(fin) / len(rs):.0f}%), "
                     f"avg {_mean(r['turns'] for r in rs):.0f} turns ──")
        else:
            won = sum(1 for r in rs if r["phases"].get("finished"))
            L.append(f"── chaos tables (fuzzing, short turn cap by design): {len(rs)} games, "
                     f"avg {_mean(r['turns'] for r in rs):.0f} turns, {won} reached a "
                     f"victory screen ──")
        if mode == "bots":
            def med(xs):
                xs = sorted(xs)
                return xs[len(xs) // 2] if xs else None

            def cell(v, width, per=1):
                return f"{'—' if v is None else round(v / per):>{width}}"

            L.append("  captains  games   finished    median turn of the…       per captain   "
                     " wrecks per  trial bosses    Warden    Pharos")
            L.append("                               1st seal  3rd seal    win   3rd seal   win "
                     "  100 turns   won/fought   won/fought  opened")
            for n in range(1, G.MAX_PLAYERS + 1):
                rn = [r for r in rs if r["players"] == n]
                if not rn:
                    continue
                fn = [r for r in rn if r["finished"]]
                tn = collections.Counter()
                for r in rn:
                    tn.update(r["stats"])
                seal = med(r["first_seal"] for r in rn if r["first_seal"] is not None)
                opened = [r["first_three"] for r in rn if r["first_three"] is not None]
                three = med(opened)
                win = med(r["turns"] for r in fn)
                turns = sum(r["turns"] for r in rn) or 1
                L.append(
                    f"  {n:^8}  {len(rn):^5}  {len(fn):>3} ({100 * len(fn) / len(rn):3.0f}%)  "
                    f"{cell(seal, 8)}  {cell(three, 8)} {cell(win, 6)}   "
                    f"{cell(three, 8, n)} {cell(win, 5, n)}   "
                    f"{100 * tn['shipwrecks'] / turns:>8.1f}    "
                    f"{tn['boss_wins']:>4}/{tn['boss_fights']:<6} "
                    f"{len(fn):>4}/{tn['warden_fights']:<6} {len(opened):>3}/{len(rn)}")
            turns_all = sum(r["turns"] for r in rs) or 1
            per = lambda k: 100 * tot[k] / turns_all                   # noqa: E731
            L.append(f"  scrolls per 100 turns — in: shrines {per('in_shrines'):.1f} · "
                     f"battle loot {per('in_battle_loot'):.1f} · side answers "
                     f"{per('in_side_answers'):.1f} · salvage {per('in_salvage'):.1f} · "
                     f"other {per('in_other'):.1f}  |  out: market {per('out_shop'):.1f} · "
                     f"repairs {per('out_repair'):.1f} · flee {per('out_flee'):.1f} · "
                     f"shipwreck {per('out_shipwreck'):.1f} · other {per('out_other'):.1f}")
            def rate(a, b):
                return f"{tot[a]}/{tot[b]} ({100 * tot[a] / max(1, tot[b]):.0f}%)"

            def avg(a, b):
                return f"{tot[a] / max(1, tot[b]):.1f}"
            L.append(f"  fights — realm boss first try {rate('fx_boss_first_won', 'fx_boss_first_n')}"
                     f" (unweakened {rate('fx_boss_fresh_won', 'fx_boss_fresh_n')})"
                     f", every try {rate('fx_boss_won', 'fx_boss_n')}, "
                     f"{avg('fx_boss_ex', 'fx_boss_n')} exchanges · Warden first try "
                     f"{rate('fx_warden_first_won', 'fx_warden_first_n')}, every try "
                     f"{rate('fx_warden_won', 'fx_warden_n')}, "
                     f"{avg('fx_warden_ex', 'fx_warden_n')} exchanges · packs won "
                     f"{rate('fx_pack_won', 'fx_pack_n')}, {avg('fx_pack_ex', 'fx_pack_n')} "
                     f"exchanges, {avg('fx_pack_hull_lost', 'fx_pack_won')} Health lost per win")
            L.append(f"  kit at a first try (bots.readiness / max Health): realm boss "
                     f"{avg('fx_boss_ready', 'fx_boss_first_n')} / "
                     f"{avg('fx_boss_maxhull', 'fx_boss_first_n')} · Warden "
                     f"{avg('fx_warden_ready', 'fx_warden_first_n')} / "
                     f"{avg('fx_warden_maxhull', 'fx_warden_first_n')}")
            L.append(f"  turns per captain to the win (median, all tables): "
                     f"{cell(med([r['turns'] / r['players'] for r in fin]) if fin else None, 4)}"
                     f" · shipwrecks per captain {sum(r['stats'].get('shipwrecks', 0) for r in rs) / max(1, sum(r['players'] for r in rs)):.1f}")
            L.append("  trial bosses by how many rivals beat them first (they rise WEAKER — catch-up): "
                     + " · ".join(
                         f"{lab} {tot[f'boss_wins_risen{k}']}/{tot[f'boss_fights_risen{k}']}"
                         for k, lab in ((0, "fresh"), (1, "once"), (2, "twice"), (3, "3+"))))
            L.append(f"  totals: battles {tot['battles']:,} · trial bosses "
                     f"{tot['boss_wins']:,}/{tot['boss_fights']:,} won · Warden "
                     f"{len(fin)}/{tot['warden_fights']:,} won · shipwrecks "
                     f"{tot['shipwrecks']:,} (at lairs {tot['wreck_at_lair']:,}, in the "
                     f"Pharos {tot['wreck_at_pharos']:,}, elsewhere "
                     f"{tot['shipwrecks'] - tot['wreck_at_lair'] - tot['wreck_at_pharos']:,})")
        else:
            L.append(f"  probes {sum(r['probes'] for r in rs):,} "
                     f"({sum(r['probe_rejects'] for r in rs):,} correctly refused) · "
                     f"kicks {sum(r['kicks'] for r in rs)} · rematches "
                     f"{sum(r['rematches'] for r in rs)} · snapshots {tot['snapshots']:,} · "
                     f"shipwrecks {tot['shipwrecks']:,} · boss fights {tot['boss_fights']:,} "
                     f"· Warden fights {tot['warden_fights']:,}")
            L.append("  phases visited: " + ", ".join(
                f"{k} {v:,}" for k, v in sorted(phases.items(), key=lambda kv: -kv[1])))
            missing = PHASES - set(phases) - {"lobby"}
            if missing:
                L.append(f"  PHASES NEVER REACHED: {sorted(missing)}")
        L.append(f"  longest single turn: {max(r['max_turn_actions'] for r in rs)} actions")
        turns_m = sum(r["turns"] for r in rs) or 1
        L.append(f"  events: {tot['events']:,} ({100 * tot['events'] / turns_m:.1f} per 100 turns"
                 f" — hub {tot['events_hub']:,}, vale {tot['events_autumn']:,}) · by kind: "
                 + ", ".join(f"{k} {tot['events_' + k]:,}"
                             for k in ("instant", "choice", "game", "table", "world"))
                 + f" · actions per turn {sum(r['actions'] for r in rs) / turns_m:.2f}")
        stages = sorted({k[len("events_"):] for k in tot if k.startswith("events_")}
                        - {"instant", "choice", "game", "table", "world"})
        L.append("  events per 100 turns by stage: " + ", ".join(
            f"{s} {100 * tot['events_' + s] / turns_m:.1f}" for s in stages))
        L.append("  events per 100 turns SPENT in each stage: " + ", ".join(
            f"{s} {100 * tot['events_' + s] / max(1, tot['stage_turns_' + s]):.1f}"
            f" ({tot['stage_turns_' + s]:,} turns)" for s in stages))
        if mode == "bots":
            L.append(f"  event scrolls per 100 turns: in {100 * tot['in_events'] / turns_m:.1f}"
                     f" · out {100 * tot['out_events'] / turns_m:.1f} · net "
                     f"{100 * (tot['in_events'] - tot['out_events']) / turns_m:.1f} — by stage (net): "
                     + ", ".join(f"{s} {100 * (tot['in_events_' + s] - tot['out_events_' + s]) / turns_m:.1f}"
                                 for s in stages))
    if fails:
        L.append("")
        L.append(f"══ {len(fails)} INVARIANT FAILURE(S) ══")
        seen = collections.Counter()
        for r in fails:
            key = r["failure"].splitlines()[0][:90]
            seen[key] += 1
            if seen[key] > 2:
                continue
            L.append(f"seed {r['seed']} ({r['players']} players, {r['mode']}): {r['failure']}")
            L.append(f"   replay: {r['replay']}")
            for line in r["trail"][-8:]:
                L.append("     " + line)
        L.append("")
        L.append("failure kinds:")
        for key, n in seen.most_common():
            L.append(f"  {n:>4} × {key}")
    return "\n".join(L)


# ── the stance study ─────────────────────────────────────────────────────────
# Kits a captain can carry into a fight: (label, max Health, planks, aegis
# charms, upgrades). "prepared" is what bots.readiness() asks of a realm
# trial; "endgame" a captain who has hauled fittings home for the Warden.
KITS = {
    "bare":     ("6 Health, empty hold", 6, 0, 0, ()),
    "prepared": ("8 Health, 1 planks, 1 aegis charm", 8, 1, 1, ()),
    "stocked":  ("11 Health, 2 planks, 1 aegis charm", 11, 2, 1, ()),
    "endgame":  ("13 Health, 2 planks, 2 aegis, trident+ram", 13, 2, 2, ("trident", "ram")),
}


def study_fight(g, pid, nid, skill, policy, kit, rng, risen=0, extra=(),
                pack=None):
    """One fight to the end. ``policy`` is 'bot' (bots.decide_battle) or a
    fixed stance ('attack' | 'magic' | 'sword'), optionally suffixed '!' to
    never BRACE. Planks are used as the bot would. Returns (won, exchanges,
    health lost, braces)."""
    _label, hull, planks, aegis, ups = KITS[kit]
    p = g.player_by_pid(pid)
    node = g.board.nodes[nid]
    p.reset()
    p.max_hull = p.hull = hull
    p.items = {"planks": planks, "aegis_charm": aegis}
    p.upgrades = list(ups) + list(extra)
    p.scrolls = 0
    g.winner = None
    g._start_turn()
    node.pop("falls", None)            # every study fight is a FIRST try
    if pack is not None:
        node["monster"] = pack(g)
        g.battle = {"node": nid, "stance": None, "round": 0, "charging": False,
                    "ambush": False, "used_items": [], "first_hit_taken": False}
        p.prev_node, p.node = p.node, nid
        g._arm_battle()
        g._bump("battle")
    elif nid == "pharos":
        p.banked = RELICS_TO_WIN
        g.pharos_open = True
        g.board.reset_warden()
        p.prev_node, p.node = p.node, nid
        g._land(p, nid)
        g.enter_pharos(pid)
    else:
        node["defeated"][:] = [f"rival{i}" for i in range(risen)]
        node["monster"] = None
        p.prev_node, p.node = p.node, nid
        g._land(p, nid)
    rounds = braces = 0
    start = last = p.hull + PLANKS_HEAL_OF(p)
    fixed = policy.rstrip("!")
    while g.phase not in ("trade", "finished", "roll") and rounds < 400:
        if g.phase == "battle":
            if policy == "bot":
                choice = bots.decide_battle(g, pid, rng, skill)
            else:
                choice = fixed
                if p.items.get("planks", 0) and p.hull <= p.max_hull - G.PLANKS_HEAL \
                        and p.hull <= 4:
                    choice = "planks"
                elif g.battle.get("charging") and not policy.endswith("!"):
                    choice = "guard"
            if choice == "planks":
                g.use_item_charm(pid, "planks")
                continue
            if choice == "flee":
                choice = "attack"            # the study fights to the end
            rounds += 1
            braces += choice == "guard"
            g._force_mode = "mc"
            g.stance(pid, choice, 0, "mc" if choice == "heal" else None)
        elif g.phase == "question":
            ok = rng.random() < skill.accuracy(g.qctx["tier"])
            g.set_question({"text": "?", "options": ["a", "b", "c", "d"],
                            "correct": 0})
            g.answer(pid, 0 if ok else 1)
            if g.phase == "reveal" and not g.reveal.get("player_dead"):
                last = p.hull + PLANKS_HEAL_OF(p)    # before a win carries you home
        elif g.phase == "reveal":
            g.advance_after_reveal()
        else:
            break
    if pack is not None:
        won = g.board.alive_monster(nid) is None and p.node == nid
    else:
        won = (g.winner == pid) if nid == "pharos" else p.banked > 0
    lost = start - last if won else start
    return won, rounds, lost, braces


def PLANKS_HEAL_OF(p):            # health still in the hold
    return G.PLANKS_HEAL * p.items.get("planks", 0)


def stance_study(fights: int, seed: int) -> str:
    """Does one stance embarrass another? Win rate, exchanges per fight and
    braces per fight for fixed stances and the bot policy, by kit, against a
    realm boss (fresh and eased), the Warden, and realm packs."""
    rng = random.Random(seed)
    lines = [f"stance study — {fights} fights a row: win % · avg exchanges · "
             "avg braces (fixed stances BRACE on a telegraphed heavy unless "
             "marked '!'; planks used at ≤4 Health)"]

    def table():
        g = Game("STUDY", seed=rng.randrange(2 ** 31))
        pid = g.add_player("a", "A").pid
        g.start(pid)
        return g, pid

    def row(label, skill, policy, where, kit, **kw):
        g, pid = table()
        nid = where
        if where == "lair":
            nid = next(n for n in g.board.lairs() if g.board.nodes[n]["region"] != "autumn")
        elif where == "sea":
            nid = next(n for n, d in g.board.nodes.items()
                       if d["type"] == "sea" and not d.get("region") and not d.get("sword"))
        res = [study_fight(g, pid, nid, skill, policy, kit, rng, **kw)
               for _ in range(fights)]
        wins = [r for r in res if r[0]]
        w = 100 * len(wins) / fights
        lost = _mean(r[2] for r in wins) if wins else float("nan")
        return (f"{label:<30} {w:5.1f}%  {_mean(r[1] for r in res):4.1f} ex  "
                f"{_mean(r[3] for r in res):3.1f} br  (won: −{lost:.1f} hp)")

    def pack_of(unit_hp, power, count, name="Pack"):
        def mk(g):
            return {"name": name, "tier": 3, "model": "wolf", "domain": "ares",
                    "enemies": [{"name": f"Unit {i}", "hp": unit_hp, "max_hp": unit_hp,
                                 "power": power, "model": "wolf"} for i in range(count)]}
        return mk

    sharp, casual = SHARP, CASUAL
    for skill in (sharp, casual, bots.PHILOSOPHERS[0], bots.PHILOSOPHERS[5]):
        lines.append(f"\n{skill.name} (tier I/II/III accuracy "
                     f"{skill.t1:.2f}/{skill.t2:.2f}/{skill.t3:.2f})")
        _n, bhp, bpow, _t = next(iter(REGION_POOL.values()))["boss"]
        lines.append(f"  realm boss ({bhp} HP, hits {bpow} / heavy "
                     f"{min(G.HEAVY_CAP, bpow * G.HEAVY_MULT)}):")
        for kit in ("bare", "prepared", "stocked"):
            lines.append(f"   {KITS[kit][0]}:")
            for lab, pol in (("STRIKE (+brace)", "attack"), ("MAGIC (+brace)", "magic"),
                             ("STRIKE, never brace", "attack!"),
                             ("MAGIC, never brace", "magic!"), ("bot policy", "bot")):
                lines.append("     " + row(lab, skill, pol, "lair", kit))
        lines.append("  boss already felled by rivals (catch-up), prepared:")
        for r in (1, 2):
            lines.append("     " + row(f"felled ×{r} · bot policy", skill, "bot", "lair",
                                       "prepared", risen=r))
        lines.append(f"  the Warden ({WARDEN[1]} HP, hits {WARDEN[2]} / heavy "
                     f"{min(G.HEAVY_CAP, WARDEN[2] * G.HEAVY_MULT)}):")
        for kit in ("bare", "stocked", "endgame"):
            lines.append("     " + row(f"{kit} · bot policy", skill, "bot", "pharos", kit))
            lines.append("     " + row(f"{kit} · +Sword · bot policy", skill, "bot",
                                       "pharos", kit, extra=("sword_of_damocles",)))
        lines.append("  packs, 6 Health, empty hold:")
        for lab, mk in (("3 × 1-HP, power 1", pack_of(1, 1, 3)),
                        ("2 × 2-HP, power 2", pack_of(2, 2, 2)),
                        ("3 × 3-HP, power 2 (deep)", pack_of(3, 2, 3)),
                        ("2 × 5-HP, power 2 (brutes)", pack_of(5, 2, 2))):
            for pl, pol in (("STRIKE", "attack"), ("MAGIC", "magic"), ("bot", "bot")):
                lines.append("     " + row(f"{lab} · {pl}", skill, pol, "sea", "bare",
                                           pack=mk))
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--games", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--players", type=int, default=None,
                    help="force a player count (default: cycles 1–6 by seed)")
    ap.add_argument("--mode", choices=["mixed", "bots", "chaos"], default="mixed")
    ap.add_argument("--max-turns", type=int, default=None,
                    help="turn cap per game (default: 200·players+300 for bots, "
                         "160 for chaos)")
    ap.add_argument("--skill", choices=["bots", "sharp", "casual"], default="bots",
                    help="who plays the bots tables: the server's philosophers, or "
                         "the same routing with a strong / an ordinary human's answers")
    ap.add_argument("--study", choices=["stances"], default=None)
    ap.add_argument("--fights", type=int, default=400)
    ap.add_argument("--verbose", action="store_true",
                    help="print every action (use with --games 1)")
    ap.add_argument("--json", metavar="PATH", help="also dump raw results as JSON")
    ap.add_argument("--jobs", type=int, default=0,
                    help="worker processes (default: all cores; 1 = in-process)")
    ap.add_argument("--real-jeopardy", action="store_true",
                    help="deal Jeopardy boards with questions.jeopardy_board "
                         "itself (≈30 ms a board) instead of the sampled twin")
    args = ap.parse_args(argv)
    global FAST_JEOPARDY, SKILL
    FAST_JEOPARDY = not args.real_jeopardy
    SKILL = args.skill
    if args.study == "stances":
        print(stance_study(args.fights, args.seed))
        return 0
    t0 = time.time()
    jobs = args.jobs or (os.cpu_count() or 1)
    results = run_batch(args.games, args.seed, args.players, args.mode,
                        args.max_turns, args.verbose,
                        progress=sys.stderr.isatty() or args.games >= 100,
                        jobs=1 if args.verbose else jobs)
    print(summarize(results))
    print(f"\n{time.time() - t0:.1f}s")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh)
    return 1 if any(r["failure"] for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())

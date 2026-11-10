"""
Thalassa server — one shared voyage, WebSockets, and the orchestration
around game.py (the Race for the Golden Fleece).

FastAPI + native WebSockets, one process, ONE game: everyone who opens the
site lands in the same voyage. The first player to join is the host. The
engine (game.py) owns the rules; this file owns IO: dice RNG, question
fetching (questions.py), puzzle/battle timers, the idle-turn clock, bots,
and PER-VIEWER snapshots (each captain gets their own reachable-stops view).

    GET  /              → the app (static/index.html)
    GET  /healthz       → ok (health check)
    POST /reset         → wipe the table back to an empty lobby
    WS   /ws            → game protocol (JSON text frames)

Client → server: hello{token,name} · add_bot · start · roll · sail{node}
                 · walk{node} · wager{tier} · pass · repair · shop_buy{item}
                 · buy_map · use{item} · stance{stance,target,mode} · flee
                 · dodge{hit,full} · jpick{idx} · item{id} · pharos_enter
                 · answer{idx} (turn OR side answer) · answer_text{text}
                 · pick{upgrade} · solve{payload} (minigame) · kick{pid}
                 · rematch · ping
Server → client: snapshot{you,room} · dice{pid,value} · error{msg} · pong

The room in a snapshot is game.to_dict(viewer) plus two server-side fields:
    turn_deadline   epoch seconds at which the server will act FOR the
                    captain whose turn it is (idle / disconnected), or null
    away            pids currently on autopilot (timed out, not yet back)
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import secrets
import time
import unicodedata

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import bots
import questions
from game import DODGE_SECS, RELICS_TO_WIN, Game, GameError
from questions import QuestionBank, TriviaAPIBank

log = logging.getLogger("thalassa")

BASE = os.path.dirname(os.path.abspath(__file__))


def _env_float(name: str, default: float) -> float:
    """A float from the environment; a typo'd value must not stop the boot."""
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        log.warning("ignoring %s=%r (not a number)", name, os.environ.get(name))
        return float(default)


QUESTION_SECS = _env_float("QUESTION_SECS", 35)
JEOPARDY_SECS = _env_float("JEOPARDY_SECS", 20)   # 20s to type (no read lock)
JCHOOSE_SECS = _env_float("JCHOOSE_SECS", 12)     # pick a category
REVEAL_SECS = _env_float("REVEAL_SECS", 5)
ABANDON_RESET_SECS = _env_float("ABANDON_RESET_SECS", 300)
BOT_TEMPO = _env_float("BOT_TEMPO", 1.0)
BOT_POLL_SECS = 0.5            # how often the bot driver looks at the table
GATE_WALK_SECS = 1.8           # the beat before a pass carries you through
TIMER_GRACE = 1.0              # slack after a deadline before the server calls it
DODGE_GRACE = 0.5

# ── the idle-turn clock ──────────────────────────────────────────────────────
# Most phases (roll, sail, shrine, haven, shop, trade, the Pharos door, a
# battle stance, an upgrade pick, a clockless minigame) wait on the captain
# whose turn it is and have NO engine timer. With the host's skip-turn button
# gone, a captain who walks away — or whose phone dies — would freeze the
# table forever. So the server keeps one clock per decision and, when it runs
# out, takes the SAFE default for them (see idle_act) and marks them "away":
#   IDLE_TURN_SECS  a connected captain, per decision              (120)
#                   — doubled for a captain's FIRST decision of the
#                   voyage: the opening fly-over and the rules card
#                   play before a newcomer can even reach the dice
#   GONE_TURN_SECS  a captain with no live socket, from the moment
#                   they dropped                                    (30)
#   AWAY_TURN_SECS  a captain who already timed out and has not
#                   touched anything since — every later decision
#                   moves at this pace                              (20)
# A captain who is both away AND disconnected is played at AUTO_STEP_SECS,
# their questions / puzzles / dodges timed out without the wait.
# Any action from them clears "away". IDLE_TURN_SECS=0 switches the clock
# off; DEV_CHEATS=1 servers (screenshot/QA rigs that park on a phase for
# minutes) default to off unless IDLE_TURN_SECS is set explicitly.
_DEV = os.environ.get("DEV_CHEATS") == "1"
IDLE_TURN_SECS = _env_float("IDLE_TURN_SECS", 0 if _DEV else 120)
GONE_TURN_SECS = _env_float("GONE_TURN_SECS", 30)
AWAY_TURN_SECS = _env_float("AWAY_TURN_SECS", 20)
AUTO_STEP_SECS = 1.5
CLOCKLESS_MINIGAME_SECS = 120  # floor for simon/memory, which run unclocked
IDLE_POLL_SECS = 0.25
BOT_STUCK_SECS = 20.0          # a bot holding one decision this long is stuck

# ── socket hygiene: one bad client must not crash or stall the table ─────────
WS_MAX_MSG = 16 * 1024         # chars; real messages are a few hundred bytes
WS_RATE = 20.0                 # sustained messages/second per socket…
WS_BURST = 40.0                # …after a burst of this many
WS_SEND_QUEUE = 64             # snapshots queued for one socket before it is cut
WS_MAX_SOCKETS = int(_env_float("WS_MAX_SOCKETS", 200))   # a safety valve: every
                               # open socket costs a ~50 KB frame per broadcast
WS_SEND_TIMEOUT = 10.0         # seconds one send may take before it is cut
MAX_TEXT = 200                 # a typed answer / id longer than this is junk

# The in-game dev panel unlocks with this code (the client sends it). Set
# DEV_CODE= (empty) in production to switch the panel's cheats off entirely.
DEV_CODE = os.environ.get("DEV_CODE", "783")

IDLE_PHASES = frozenset({"roll", "sail", "shrine", "haven", "shop", "trade",
                         "pharos", "battle", "upgrade_pick"})
TIMED_PHASES = frozenset({"question", "minigame", "dodge", "jchoose"})
BOT_PHASES = IDLE_PHASES | TIMED_PHASES


class Table:
    """The single shared game and its connections."""

    def __init__(self):
        self.game = Game("THALASSA")
        self.sockets: dict[WebSocket, str | None] = {}   # ws → pid (None = spectator)
        self.outbox: dict[WebSocket, asyncio.Queue] = {}  # ws → pending frames
        self.writers: dict[WebSocket, asyncio.Task] = {}
        self.bots: dict[str, bots.Skill] = {}
        self.bot_rng = random.Random()
        self.acted: set[tuple] = set()
        self.last_active = time.monotonic()
        self._clear_clocks()

    def _clear_clocks(self):
        self.away: set[str] = set()            # pids on autopilot
        self.seen: set[str] = set()            # humans who have acted this voyage
        self.gone_since: dict[str, float] = {}  # pid → when their last socket closed
        self.idle_game = None                  # what the idle clock is timing
        self.idle_key = None
        self.idle_since = time.time()
        self.armed: dict[str, object] = {}     # timer kind → the object it times
        self.stuck_key = None                  # bot-stall detector
        self.stuck_since = time.monotonic()
        self.stuck_tries = 0

    def touch(self):
        self.last_active = time.monotonic()

    def reset(self):
        self.game = Game("THALASSA")
        self.bots = {}
        self.acted = set()
        self._clear_clocks()
        for ws in self.sockets:
            self.sockets[ws] = None

    def here(self, pid: str | None) -> bool:
        """Does this captain have at least one live socket?"""
        return pid is not None and pid in self.sockets.values()


table = Table()
bank = QuestionBank()          # temples: themed by domain
trivia_bank = TriviaAPIBank()  # battles: live The Trivia API, buffered offline-safe


@contextlib.asynccontextmanager
async def lifespan(_app):
    """Start the background loops with the app and stop them with it."""
    _startup()
    try:
        yield
    finally:
        await _shutdown()


app = FastAPI(title="Thalassa", lifespan=lifespan)


# ── background tasks: referenced, logged, never silently dead ────────────────
_tasks: set[asyncio.Task] = set()


def schedule(coro, name: str | None = None) -> asyncio.Task:
    """Run a coroutine in the background. The task is kept referenced (asyncio
    only holds weak refs — an unreferenced task can be collected mid-flight)
    and an exception is LOGGED instead of vanishing: a timer that dies
    silently is exactly how a table ends up frozen on a card."""
    label = name or getattr(coro, "__qualname__", "task")

    async def guarded():
        try:
            return await coro
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("background task %s died", label)

    task = asyncio.get_running_loop().create_task(guarded(), name=label)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    # cancelled before its first step (shutdown), the wrapped coroutine was
    # never started: close it so it is not reported as "never awaited"
    task.add_done_callback(lambda _t: coro.close())
    return task


# ── broadcast (per-viewer snapshots — reachable stops are personal) ──────────
def _dumps(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


async def _send(ws: WebSocket, payload) -> bool:
    """Queue one frame for a socket. NEVER waits on the network: each socket
    has its own writer task, so a client that stops reading (a locked phone,
    a hostile peer) fills only its own queue — and is cut when that is full —
    instead of blocking every other captain's snapshot behind it."""
    q = table.outbox.get(ws)
    if q is None:                       # already cut loose — nothing to tell it
        return False
    try:
        q.put_nowait(payload if isinstance(payload, str) else _dumps(payload))
        return True
    except asyncio.QueueFull:
        return False


async def _writer(ws: WebSocket, q: asyncio.Queue):
    """Drain one socket's queue onto the wire; cut the socket if it stalls."""
    try:
        while True:
            text = await q.get()
            await asyncio.wait_for(ws.send_text(text), WS_SEND_TIMEOUT)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass                            # closed, or too slow — fall through
    table.writers.pop(ws, None)
    await _drop_socket(ws, close=True)


async def _close(ws: WebSocket):
    with contextlib.suppress(Exception):
        await asyncio.wait_for(ws.close(code=1013), 3)


def _extras() -> dict:
    """The server-side fields added to every snapshot's room."""
    try:
        return {"turn_deadline": idle_deadline(), "away": sorted(table.away)}
    except Exception:                   # the clock must never cost a broadcast
        log.exception("idle clock failed")
        return {"turn_deadline": None, "away": []}


async def broadcast():
    dead = []
    extras = _extras()
    cache: dict[str | None, str] = {}   # one build per distinct viewer
    for ws, pid in list(table.sockets.items()):
        text = cache.get(pid)
        if text is None:
            # one bad field in one viewer's snapshot must never freeze the
            # whole table's stream (a to_dict crash here once soft-locked every
            # client on a stale card) — log it loudly and keep the others flowing
            try:
                snap = table.game.to_dict(pid)
                snap.update(extras)
                text = _dumps({"type": "snapshot", "you": pid, "room": snap})
            except Exception:
                log.exception("snapshot build failed for viewer %s", pid)
                continue
            cache[pid] = text
        if not await _send(ws, text):
            dead.append(ws)
    for ws in dead:
        await _drop_socket(ws, close=True)


async def broadcast_event(payload: dict):
    text = _dumps(payload)
    for ws in list(table.sockets):
        await _send(ws, text)


def _mark_gone(pid: str | None) -> bool:
    """A captain's last socket is gone: flag them. True if anything changed."""
    if not pid or table.here(pid):
        return False
    p = table.game.player_by_pid(pid)
    if not p or not p.connected:
        return False
    p.connected = False
    table.gone_since[pid] = time.time()
    return True


async def _drop_socket(ws: WebSocket, close: bool = False):
    known = ws in table.sockets or ws in table.outbox
    pid = table.sockets.pop(ws, None)
    table.outbox.pop(ws, None)
    writer = table.writers.pop(ws, None)
    if writer is not None and writer is not asyncio.current_task():
        writer.cancel()
    if close and known:
        schedule(_close(ws), "close")
    if _mark_gone(pid):
        await broadcast()


# ── the idle-turn clock ──────────────────────────────────────────────────────
def _turn_human(g: Game):
    """The human captain the table is waiting on, or None."""
    if not g.players or g.phase not in BOT_PHASES:
        return None
    p = g.current
    if p.is_bot or p.pid in table.bots:
        return None
    return p


def _clockless(g: Game) -> bool:
    return (g.phase == "minigame" and bool(g.minigame)
            and not g.minigame.get("deadline") and not g.minigame.get("limit"))


def idle_deadline() -> float | None:
    """Epoch seconds at which the server acts for the captain whose turn it
    is — or None when no idle clock is running (a bot's turn, a phase with
    its own engine timer and a present captain, the lobby, the clock off)."""
    if IDLE_TURN_SECS <= 0:
        return None
    g = table.game
    p = _turn_human(g)
    if p is None:
        table.idle_key = None
        return None
    here = table.here(p.pid)
    away = p.pid in table.away
    untimed = g.phase in IDLE_PHASES or _clockless(g)
    if not untimed:
        # question / minigame / dodge / category pick keep their own clocks
        # (the ones the client draws). The idle clock only hurries them for a
        # captain who is on autopilot AND has no socket — nobody is watching
        # that countdown, and the table should not sit through it.
        if not (away and not here) or (g.phase == "question" and g.question is None):
            table.idle_key = None
            return None
    key = (g.nonce, g.phase, p.pid, here)
    if table.idle_game is not g or table.idle_key != key:
        table.idle_game, table.idle_key = g, key
        table.idle_since = time.time()     # a fresh decision → a fresh clock
    if not here:
        window = AUTO_STEP_SECS if away else GONE_TURN_SECS
    elif away:
        window = AWAY_TURN_SECS
    else:
        window = max(IDLE_TURN_SECS, CLOCKLESS_MINIGAME_SECS) \
            if _clockless(g) else IDLE_TURN_SECS
        if p.pid not in table.seen:
            window *= 2                # still watching the intro, most likely
    return table.idle_since + window


def _force_pass(g: Game):
    """Last resort: nothing sane could be done for this captain — strike the
    turn's set and hand the dice on, so the table can never stay frozen."""
    abandon = getattr(g, "_abandon_turn", None)
    if abandon:
        abandon()
    g.battle = None
    g.minigame = None
    g.kraken = None
    g.upgrade_offer = None
    g._next_turn()


def idle_step(g: Game, pid: str) -> str:
    """Take the SAFE default action for the captain holding the turn (a human
    whose idle clock ran out, or a bot whose own move failed). Synchronous and
    total: afterwards the game has always moved on. Returns what was done.

      roll           the tide passes them by — the turn is forfeited, the
                     ship stays where it is (no roll is wasted on a gale)
      sail           the ship stays at anchor (a walk already under way in
                     the Vale takes its first trail)
      shrine/haven/  walk away (pass), and wave the trader off too
      pharos
      shop / trade   pass
      upgrade pick   take a prize (it was earned) — never forfeit it
      battle         try to flee (the engine's own retreat); if that is
                     refused (a trial, or no scrolls) STRIKE and fight on
      question,      the engine's own timeout for that phase
      minigame, dodge, category pick
    """
    phase, nonce = g.phase, g.nonce
    p = g.player_by_pid(pid)
    name = p.name if p else "A captain"
    done = phase
    try:
        if phase == "roll":
            g._say(f"⏳ {name} is away — the tide passes them by.")
            g._next_turn()
            done = "forfeit"
        elif phase == "sail":
            w = g.walk
            if w and w.get("options") and not g.reachable:
                g.walk_step(pid, sorted(w["options"])[0])
                done = "walk"
            else:
                g._say(f"⏳ {name} is away — the ship stays at anchor.")
                g._next_turn()
                done = "forfeit"
        elif phase in ("shrine", "haven", "pharos"):
            g.pass_turn(pid)
            if g.phase == "trade" and g.players and g.current.pid == pid:
                g.pass_turn(pid)
            done = "pass"
        elif phase in ("shop", "trade"):
            g.pass_turn(pid)
            done = "pass"
        elif phase == "upgrade_pick":
            g.pick_upgrade(pid, bots.decide_upgrade(g, pid))
            done = "pick"
        elif phase == "battle":
            try:
                g.flee(pid)
                done = "flee"
            except GameError:
                g.stance(pid, "attack", 0)
                done = "strike"
        elif phase == "minigame":
            g.minigame_timeout()
            done = "timeout"
        elif phase == "question":
            g.timeout_question()
            done = "timeout"
        elif phase == "dodge":
            g.dodge_timeout()
            done = "timeout"
        elif phase == "jchoose":
            g.jchoose_timeout()
            done = "timeout"
    except Exception:
        log.exception("idle default for %s in %s failed", pid, phase)
    if g.phase == phase and g.nonce == nonce and phase in BOT_PHASES:
        try:
            _force_pass(g)
            done = "forced"
        except Exception:
            log.exception("could not force the turn on from %s", phase)
    return done


async def idle_act():
    """The idle clock ran out: act for the captain and tell the table."""
    g = table.game
    p = _turn_human(g)
    if p is None:
        return
    if (g.phase in IDLE_PHASES and g.phase != "trade") or _clockless(g):
        # from here on they are on autopilot. (Not for the trade beat: a
        # captain who played the turn and merely forgot END TURN is not away.)
        table.away.add(p.pid)
    done = idle_step(g, p.pid)
    log.info("idle clock: %s for %s", done, p.pid)
    after_phase_change()
    await broadcast()


async def turn_keeper():
    """Polls the idle clock (and the bot-stall detector). A poll, not a
    one-shot timer per phase: there is nothing here to lose or double-arm."""
    while True:
        await asyncio.sleep(IDLE_POLL_SECS)
        try:
            deadline = idle_deadline()
            if deadline is not None and time.time() >= deadline:
                await idle_act()
            await _unstick_bot()
        except Exception:
            log.exception("turn keeper tick failed")


async def _unstick_bot():
    """A bot that has held ONE decision far longer than its thinking time is
    stuck (its move task was lost, or its move keeps being refused). First
    let the driver try again; if that does not move it, play the safe
    default — a philosopher never holds the table hostage."""
    g = table.game
    if (not g.players or not table.bots or g.phase not in BOT_PHASES
            or g.current.pid not in table.bots
            or (g.phase == "question" and g.question is None)):
        table.stuck_key = None
        return
    key = (id(g), g.nonce, g.phase)
    now = time.monotonic()
    if key != table.stuck_key:
        table.stuck_key, table.stuck_since, table.stuck_tries = key, now, 0
        return
    if now - table.stuck_since < BOT_STUCK_SECS + 16 * BOT_TEMPO:
        return
    table.stuck_since = now
    table.stuck_tries += 1
    if table.stuck_tries == 1:
        log.warning("bot %s stuck in %s — retrying", g.current.pid, g.phase)
        table.acted.discard((g.nonce, g.phase))
        return
    log.warning("bot %s still stuck in %s — safe default", g.current.pid, g.phase)
    idle_step(g, g.current.pid)
    after_phase_change()
    await broadcast()


# ── phase timers ─────────────────────────────────────────────────────────────
# Every timer is guarded by the IDENTITY of the thing it times (this question,
# this reveal, this minigame…), never by the game nonce: an unrelated nonce
# bump (the pass carrying the previous captain through, a rival's purchase)
# used to cancel the current captain's timer and leave the table waiting on
# the watchdog, and after a table reset a stale timer could fire into the NEW
# game the moment it reached the same nonce.
def _arm(kind: str, obj) -> bool:
    """True the first time a timer is armed for this object (no doubles)."""
    if table.armed.get(kind) is obj:
        return False
    table.armed[kind] = obj
    return True


async def fetch_question(nonce: int = 0):
    g = table.game
    ctx = g.qctx
    if ctx is None or g.phase != "question" or g.question is not None:
        return                # nothing is waiting (a second herald, a stale one)
    try:
        pending = g.needs_puzzle()
        mode = ctx.get("mode")
        pending_j = getattr(g, "_pending_jeopardy", None)
        if pending_j is not None:            # a clue picked off the Jeopardy board
            g._pending_jeopardy = None
            limit = JEOPARDY_SECS
            q = pending_j
        elif pending is not None:
            limit = pending.get("limit", 60)
            q = pending
        elif mode == "jeopardy":             # typed clue, 15s on the clock
            limit = JEOPARDY_SECS
            q = questions.jeopardy_pick(g.rng)
        elif mode == "mc":                    # battle MC — live Trivia API (buffered)
            limit = QUESTION_SECS             # STRIKE (tier I/II) easier than MAGIC (III)
            q = trivia_bank.get(ctx.get("tier", 2))
        else:                                 # temples: themed by domain + tier
            limit = QUESTION_SECS
            q = await bank.get(ctx.get("domain"), ctx.get("tier", 2))
    except Exception:
        log.exception("question fetch failed")
        return                # the phase watchdog re-summons the herald
    # Deliver iff THIS question round is still waiting. The guard is the
    # IDENTITY of the qctx — never the nonce: an unrelated nonce bump while
    # the herald ran used to strand the table on "A herald fetches the
    # question…" forever, because a one-shot task never retried.
    g = table.game
    if g.qctx is ctx and g.phase == "question" and g.question is None:
        g.set_question(q, deadline=time.time() + limit)
        if g.question is not None and _arm("question", g.question):
            schedule(question_timer(g.question, limit), "question_timer")
        await broadcast()


async def question_timer(q: dict, limit: float):
    await asyncio.sleep(limit + TIMER_GRACE)
    g = table.game
    if g.question is q and g.phase == "question":
        g.timeout_question()
        after_phase_change()
        await broadcast()


async def reveal_timer(rv: dict):
    g = table.game
    # battle reveals are snappy — the card flashes the answer then clears so
    # the diorama plays your move and the enemy's, and the next stance is
    # quick to arrive. But a battle that ENDS (a kill, or your shipwreck) gets a
    # long hold so the final blow lands and the VICTORY / YOU DIED screen reads
    # before we cut away. Shrine/puzzle reveals get the full reading window.
    if rv.get("kind") == "battle":
        if rv.get("battle_over"):
            dur = 5.6                        # a kill / shipwreck: hold on the ending
        elif g.battle and g.battle.get("incoming"):
            dur = 1.4                        # a dodge is coming — snap to the DODGE prompt
        else:
            dur = 3.4
        dur = _env_float("BATTLE_REVEAL_SECS", dur)   # QA speed hook
    else:
        dur = REVEAL_SECS
    await asyncio.sleep(dur)
    g = table.game
    if g.reveal is rv and g.phase == "reveal":
        g.advance_after_reveal()
        after_phase_change()
        await broadcast()


async def minigame_timer(mg: dict, limit: float):
    await asyncio.sleep(limit + TIMER_GRACE)
    g = table.game
    if g.minigame is mg and g.phase == "minigame":
        g.minigame_timeout()
        after_phase_change()          # a timed-out puzzle-battle → arm the reveal timer
        await broadcast()


async def dodge_timer(incoming: dict, limit: float):
    await asyncio.sleep(limit + DODGE_GRACE)
    g = table.game
    if g.phase == "dodge" and g.battle and g.battle.get("incoming") is incoming:
        g.dodge_timeout()             # frozen at the tiller — the blow lands full
        after_phase_change()
        await broadcast()


async def jchoose_timer(board: dict, limit: float):
    await asyncio.sleep(limit + TIMER_GRACE)
    g = table.game
    if g.jboard is board and g.phase == "jchoose":
        g.jchoose_timeout()           # no pick → the board chooses for you
        after_phase_change()          # arm the fetch for the chosen clue
        await broadcast()


async def gate_walk_task(g: Game, pid: str, gate: str, dest: str):
    """The pass carries you through: a beat after landfall, walk the captain
    on to the far side's first waypoint (they spawn IN the region, never
    standing in the arch). Positional only — no landing effects fire."""
    await asyncio.sleep(GATE_WALK_SECS)
    if table.game is not g:
        return                            # the table was reset meanwhile
    carry = getattr(g, "gate_carry", None)
    if carry is not None:                 # the engine's own guarded carry
        moved = carry(pid, gate, dest)
    else:
        p = g.player_by_pid(pid)
        moved = bool(p and p.node == gate and dest in g.board.nodes)
        if moved:                         # still standing in the arch
            p.prev_node = p.node
            p.node = dest
            g._reveal_vale(p)             # the lantern lights the new ground
            g.nonce += 1
    if moved:
        await broadcast()


def after_phase_change():
    """Kick off whatever the new phase demands (fetches, timers)."""
    g = table.game
    if getattr(g, "gate_walk", None):
        gw, g.gate_walk = g.gate_walk, None
        schedule(gate_walk_task(g, gw["pid"], gw["gate"], gw["to"]), "gate_walk")
    if g.phase == "question" and g.question is None:
        schedule(fetch_question(g.nonce), "fetch_question")
    elif g.phase == "jchoose" and g.jboard and g.jchoose_deadline is None:
        g.jchoose_deadline = time.time() + JCHOOSE_SECS
        schedule(jchoose_timer(g.jboard, JCHOOSE_SECS), "jchoose_timer")
    elif g.phase == "minigame" and g.minigame and g.minigame["deadline"] is None:
        limit = g.minigame["limit"]
        if limit:                            # simon runs without a clock (the
            g.minigame["deadline"] = time.time() + limit   # idle clock backs it)
            schedule(minigame_timer(g.minigame, limit), "minigame_timer")
    elif g.phase == "dodge" and g.dodge_deadline is None \
            and g.battle and g.battle.get("incoming"):
        g.dodge_deadline = time.time() + DODGE_SECS
        schedule(dodge_timer(g.battle["incoming"], DODGE_SECS), "dodge_timer")
    elif g.phase == "reveal" and g.reveal is not None:
        # ANY path into a reveal must arm the timer that advances it — trivia
        # answers, puzzle-battle solves, timeouts, all of it. Missing this on the
        # puzzle-solve path froze the battle after the enemy's blow. One timer
        # per reveal: a rejoin or a rival's click must not stack another.
        if _arm("reveal", g.reveal):
            schedule(reveal_timer(g.reveal), "reveal_timer")


# ── shared action dispatch (humans over WS, bots from the driver) ───────────
def _host_pid(g: Game) -> str | None:
    """Who holds the host's powers right now (the engine may pass them to a
    connected captain while the first one in is away)."""
    if hasattr(g, "host_pid"):
        return g.host_pid
    return g.players[0].pid if g.players else None


def _text(v, limit: int = MAX_TEXT) -> str:
    """A client-supplied id / answer: a string, and a short one."""
    return v[:limit] if isinstance(v, str) else ""


async def dispatch(pid: str | None, kind: str, msg: dict) -> str | None:
    """Apply one action. → None on success (state broadcast), else the error
    text for the sender alone."""
    g = table.game
    woke = False
    if pid is not None and pid not in table.bots:
        woke = pid in table.away
        table.away.discard(pid)           # they touched something: back at the helm
        table.seen.add(pid)
        if g.players and g.phase != "lobby" and g.current.pid == pid:
            table.idle_since = time.time()
    err = await _apply(pid, kind, msg)
    if err and woke:
        await broadcast()                 # the table should see them return
    return err


async def _apply(pid: str | None, kind: str, msg: dict) -> str | None:
    g = table.game
    try:
        if kind == "start":
            g.start(pid)
            table.seen.clear()            # the voyage (and its intro) begins now
        elif kind == "add_bot":
            if not g.players or _host_pid(g) != pid:
                raise GameError("Only the host can invite philosophers.")
            taken = {table.bots[b].name for b in table.bots}
            free = [s for s in bots.PHILOSOPHERS if s.name not in taken]
            if not free:
                raise GameError("Every philosopher is already aboard.")
            skill = table.bot_rng.choice(free[:3])
            p = g.add_player(f"bot:{secrets.token_hex(4)}", skill.name, is_bot=True)
            table.bots[p.pid] = skill
        elif kind == "roll":
            die = secrets.randbelow(3) + 1       # a d3: close-quarters sailing
            p = g.player_by_pid(pid)
            if p and p.has("star_chart"):        # roll two, sail with the higher
                die = max(die, secrets.randbelow(3) + 1)
            g.roll(pid, die)
            await broadcast_event({"type": "dice", "pid": pid, "value": die})
        elif kind == "sail":
            g.sail(pid, _text(msg.get("node")))
        elif kind == "walk":
            g.walk_step(pid, _text(msg.get("node")))
        elif kind == "jpick":
            g.jpick(pid, int(msg.get("idx", 0)))
        elif kind == "wager":
            g.wager(pid, int(msg.get("tier", 0)))
        elif kind == "pass":
            g.pass_turn(pid)
        elif kind == "pharos_enter":
            g.enter_pharos(pid)
        elif kind == "repair":
            g.repair(pid)
        elif kind == "shop_buy":
            g.shop_buy(pid, _text(msg.get("item")))
        elif kind == "buy_map":
            g.buy_map(pid)
        elif kind == "use":
            g.use_item_charm(pid, _text(msg.get("item")))
        elif kind == "stance":
            mode = msg.get("mode")
            g.stance(pid, _text(msg.get("stance")), int(msg.get("target", 0)),
                     mode if isinstance(mode, str) else None)
        elif kind == "dodge":
            g.dodge(pid, bool(msg.get("hit")), bool(msg.get("full")))
        elif kind == "flee":
            g.flee(pid)
        elif kind == "item":
            g.use_item(pid, _text(msg.get("id")))
            # a lyre swap leaves question None — after_phase_change re-fetches
        elif kind == "answer":
            idx = int(msg.get("idx", -1))
            if g.phase == "question" and g.players and g.current.pid != pid:
                g.side_answer(pid, idx)
            else:
                g.answer(pid, idx)   # → reveal timer armed by after_phase_change
        elif kind == "answer_text":
            g.answer_text(pid, _text(msg.get("text")))     # typed Jeopardy clue
        elif kind == "solve":
            g.minigame_submit(pid, msg.get("payload"))
        elif kind == "pick":
            g.pick_upgrade(pid, _text(msg.get("upgrade")))
        elif kind == "kick":
            target = _text(msg.get("pid"))
            g.remove_player(pid, target)
            _forget_departed()
        elif kind == "rematch":
            g.rematch(pid)
            table.away.clear()
        elif kind == "dev" and (os.environ.get("DEV_CHEATS") == "1"
                                or (DEV_CODE and str(msg.get("code")) == DEV_CODE)):
            # dev teleport — the test harness (DEV_CHEATS) or the in-game dev
            # panel (unlocked with DEV_CODE): teleport-and-(maybe)-land
            p = g.player_by_pid(pid)
            if p is None:                      # a watcher has no ship to cheat with
                raise GameError("Join the voyage first.")
            if p and msg.get("win"):           # force the curtain call
                g.winner = p.pid
                g._bump("finished")
            if p and msg.get("bank"):          # bank the seals + open the Pharos
                p.banked = RELICS_TO_WIN
                g.pharos_open = True
            if msg.get("battle_mode"):         # force the next battle round's deck
                g._force_mode = str(msg["battle_mode"])
            if msg.get("reset"):               # exit dev: drop every dev-only toggle
                g.no_autowalk = False
                g._force_mode = None
            if "autowalk" in msg:              # freeze/unfreeze the gate carry-through
                g.no_autowalk = not bool(msg["autowalk"])
            if msg.get("relics") and p:        # grant every relic + a winning set of seals
                g.dev_grant_relics(pid)
            if msg.get("scrolls") and p:        # top up the purse (map / relic testing)
                p.scrolls += max(-10_000, min(10_000, int(msg["scrolls"])))
                g.nonce += 1
            if msg.get("sword") and p:          # unlock the Sword of Damocles quest:
                p.scrolls += 100                # coin to spare for the chart + gear.
                g.nonce += 1                    # (NOT map_bought — leave the chart flow
                                                #  intact so the trader's prompt still plays)
            if msg.get("fight") and p:         # simulate a fight with anything
                if not isinstance(msg["fight"], dict):
                    raise GameError("Malformed message.")
                g.dev_fight(pid, msg["fight"])
            node = _text(msg.get("node"))
            region = msg.get("region")
            if not isinstance(region, str):
                region = None
            if p and region and node not in g.board.nodes:
                # the dev bar names a REGION, not a stop — resolve a landing
                # spot server-side (prefer a quiet interior stop, else anything;
                # in the Vale only YOUR OWN labyrinth counts)
                pool = [nid for nid, n in g.board.nodes.items()
                        if n.get("region") == region
                        and n.get("owner") in (None, pid)] if region != "hub" else \
                       [nid for nid, n in g.board.nodes.items() if not n.get("region")]
                if region == "pharos":
                    pool = [nid for nid, n in g.board.nodes.items() if n["type"] == "pharos"]
                # drop in on a shallow INTERIOR stop (a plain sea/trail node near
                # the entrance) so the client actually switches to the region's
                # stage — a gate is a hub/realm boundary and would keep you on the
                # hub. Fall back to the gate, then anything in the region.
                shallow = sorted((nid for nid in pool if g.board.nodes[nid]["type"] == "sea"),
                                 key=lambda nid: g.board.nodes[nid].get("depth", 9))
                pick = (shallow
                        or [nid for nid in pool if g.board.nodes[nid]["type"] == "gate"]
                        or pool)
                node = pick[0] if pick else node
            if (p and node in g.board.nodes
                    # never into a RIVAL's private labyrinth — the dev hook
                    # must not pierce the ownership model (a guessed node id
                    # like 'av1_L' would otherwise loot a rival's barrow)
                    and g.board.nodes[node].get("owner") in (None, p.pid)):
                p.prev_node = p.node
                p.node = node
                g._reveal_vale(p)          # a Vale drop still lights its ground
                if msg.get("land"):
                    g._land(p, node)
                else:
                    g.nonce += 1
        else:
            return f"Unknown message: {kind[:32]}"
    except GameError as e:
        return str(e)
    except (TypeError, ValueError, OverflowError):
        return "Malformed message."
    except Exception:
        # an engine bug reached through a client message must cost that
        # message, never the socket loop (or the bot driver) that sent it
        log.exception("dispatch(%s) failed for %s", kind, pid)
        return "Malformed message."
    after_phase_change()          # set deadlines BEFORE the snapshot goes out
    await broadcast()
    return None


def _forget_departed():
    """After a kick: drop everything keyed to captains who are no longer
    aboard — their bot brain, their autopilot flag, and their sockets' seat
    (a kicked captain's tab becomes a watcher; it must not keep a stale pid)."""
    g = table.game
    aboard = {p.pid for p in g.players}
    table.bots = {b: s for b, s in table.bots.items() if b in aboard}
    table.away &= aboard
    table.seen &= aboard
    table.gone_since = {k: v for k, v in table.gone_since.items() if k in aboard}
    for ws, spid in list(table.sockets.items()):
        if spid is not None and spid not in aboard:
            table.sockets[ws] = None


# ── bot driver ───────────────────────────────────────────────────────────────
def _bot_delay(tag: str) -> float:
    base = {"roll": 1.0, "sail": 1.6, "shrine": 1.2, "haven": 1.0,
            "battle": 1.6, "question": 3.5, "minigame": 9.0, "dodge": 1.2,
            "upgrade_pick": 1.4, "side": 2.2, "trade": 0.8}.get(tag, 1.0)
    return (base + table.bot_rng.random() * base * 0.7) * BOT_TEMPO


async def bot_move(nonce: int, tag: str, pid: str):
    g = table.game
    await asyncio.sleep(_bot_delay(tag))
    if table.game is not g or g.nonce != nonce:
        return
    rng = table.bot_rng
    skill = table.bots.get(pid)
    if skill is None:
        return
    if tag == "side":
        try:
            if g.phase == "question" and g.question is not None \
                    and not g.question.get("typed") \
                    and pid not in g.side_answers and g.current.pid != pid:
                idx = bots.decide_answer(g, skill, rng)
                await dispatch(pid, "answer", {"idx": idx})
        except Exception:
            log.exception("[bot %s] side answer failed", pid)
        return
    phase = g.phase
    if not g.players or g.current.pid != pid:
        return
    err = None
    try:
        err = await _bot_turn(g, pid, phase, skill, rng)
    except Exception:
        log.exception("[bot %s] %s move raised", pid, phase)
        err = "exception"
    if err:
        log.warning("[bot %s] %s: %s", pid, phase, err)
        # the move was refused (or blew up) and nothing changed: a one-shot
        # task will not be re-sent for this (nonce, phase), so without a
        # fallback the bot would hold the turn forever. Play the safe default.
        if table.game is g and g.nonce == nonce and g.phase == phase \
                and g.players and g.current.pid == pid:
            idle_step(g, pid)
            after_phase_change()
            await broadcast()


async def _bot_turn(g: Game, pid: str, phase: str, skill, rng) -> str | None:
    """One bot decision for the phase it holds. Returns an error string if
    the move it chose was refused."""
    err = None
    if phase == "roll":
        err = await dispatch(pid, "roll", {})
    elif phase == "trade":
        # the end-of-turn beat: a prepared captain provisions before the
        # dice pass on
        buy = bots.decide_remote_buy(g, pid)
        if buy:
            await dispatch(pid, "shop_buy", {"item": buy})
        err = await dispatch(pid, "pass", {})
    elif phase == "sail":
        node = bots.decide_sail(g, pid, rng)
        err = await dispatch(pid, "sail", {"node": node}) if node else "no move"
    elif phase == "shrine":
        tier = bots.decide_shrine_tier(g, pid, skill, rng)
        err = await dispatch(pid, "wager", {"tier": tier})
        if err:
            err = await dispatch(pid, "pass", {})
    elif phase == "haven":
        err = await dispatch(pid, "repair", {})
        if err:
            err = await dispatch(pid, "pass", {})
    elif phase == "pharos":
        err = await dispatch(pid, "pharos_enter", {})
        if err:                       # the door is sealed: turn away
            err = await dispatch(pid, "pass", {})
    elif phase == "shop":
        buy = bots.decide_shop(g, pid)
        if buy:
            err = await dispatch(pid, "shop_buy", {"item": buy})
        if not buy or err:
            err = await dispatch(pid, "pass", {})
    elif phase == "battle":
        choice = bots.decide_battle(g, pid, rng)
        if choice == "planks":
            err = await dispatch(pid, "use", {"item": "planks"})
            if err:                                    # can't patch: fight on
                err = await dispatch(pid, "stance", {"stance": "magic"})
        elif choice == "flee":
            err = await dispatch(pid, "flee", {})
            if err:                                    # broke, or it's a trial
                err = await dispatch(pid, "stance", {"stance": "attack"})
        else:
            err = await dispatch(pid, "stance", {"stance": choice})
    elif phase == "jchoose":
        n = len(g.jboard["cells"]) if g.jboard else 1
        err = await dispatch(pid, "jpick", {"idx": rng.randrange(n)})
    elif phase == "question":
        if g.question is None:
            return None
        if g.question.get("typed"):
            text = bots.decide_typed_answer(g, skill, rng)
            err = await dispatch(pid, "answer_text", {"text": text})
        else:
            idx = bots.decide_answer(g, skill, rng)
            err = await dispatch(pid, "answer", {"idx": idx})
    elif phase == "minigame":
        p_solve = min(0.85, skill.t3 + 0.25)
        g.resolve_minigame(rng.random() < p_solve)
        after_phase_change()
        await broadcast()
    elif phase == "dodge":
        # philosopher reflexes: sharper minds read the blow more often
        err = await dispatch(pid, "dodge",
                             {"hit": rng.random() < 0.25 + skill.t1 * 0.4})
    elif phase == "upgrade_pick":
        err = await dispatch(pid, "pick", {"upgrade": bots.decide_upgrade(g, pid)})
    else:
        err = f"no move for phase {phase}"
    return err


def bot_tick():
    """One look at the table: schedule whatever the bots owe it."""
    g = table.game
    if g.phase in ("lobby", "finished") or not table.bots:
        table.acted.clear()
        return
    if len(table.acted) > 512:
        table.acted = {k for k in table.acted if k[0] >= g.nonce}

    # side answers from every bot that isn't acting (typed clues are the
    # challenger's alone — no side guesses)
    if g.phase == "question" and g.question is not None \
            and not g.question.get("typed") and g.players:
        for p in g.players:
            if p.pid in table.bots and p.pid != g.current.pid \
                    and p.pid not in g.side_answers \
                    and table.bot_rng.random() < 0.9:
                key = (g.nonce, f"side:{p.pid}")
                if key not in table.acted:
                    table.acted.add(key)
                    schedule(bot_move(g.nonce, "side", p.pid), "bot_side")

    if not g.players or g.current.pid not in table.bots:
        return
    if g.phase in BOT_PHASES:
        if g.phase == "question" and g.question is None:
            return
        key = (g.nonce, g.phase)
        if key not in table.acted:
            table.acted.add(key)
            schedule(bot_move(g.nonce, g.phase, g.current.pid), "bot_move")


async def bot_driver():
    while True:
        await asyncio.sleep(BOT_POLL_SECS)
        try:
            bot_tick()
        except Exception:                     # the driver itself never dies
            log.exception("bot driver tick failed")


# ── HTTP ─────────────────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz():
    return {"ok": True, "phase": table.game.phase,
            "players": len(table.game.players), "bots": len(table.bots),
            "questions": bank.counts()}


@app.middleware("http")
async def never_stale(request, call_next):
    """Browsers were caching /static JS for hours (no Cache-Control header →
    heuristic caching), so pushed fixes never showed up in-game without a
    hard refresh. no-cache forces a revalidation on every load — ETags turn
    that into cheap 304s, so even the big GLBs aren't re-downloaded."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.startswith("/static"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))


@app.post("/reset")
async def reset_table():
    """Wipe the single shared table back to a fresh, empty lobby. Exposed over
    HTTP so the join screen can offer it before any WebSocket is opened."""
    table.reset()
    table.touch()
    await broadcast()
    return {"ok": True}


app.mount("/static", StaticFiles(directory=os.path.join(BASE, "static")), name="static")


# ── WebSocket protocol ───────────────────────────────────────────────────────
def clean_name(raw) -> str:
    """A captain's name as the table will show it: printable, single-spaced,
    at most 16 characters. Control and invisible characters (newlines, zero
    width joiners, right-to-left overrides) are dropped — a name must not be
    able to forge a log line or scramble a rival's HUD. Empty → the engine
    picks "Captain N"."""
    if not isinstance(raw, str):
        return ""
    raw = unicodedata.normalize("NFKC", raw[:256])
    raw = "".join(" " if c.isspace() else c for c in raw
                  if c.isspace() or unicodedata.category(c)[0] != "C")
    return " ".join(raw.split())[:16].strip()


async def _hello(ws: WebSocket, msg: dict):
    g = table.game
    token = msg.get("token")
    token = token[:64] if isinstance(token, str) else ""
    if token.startswith("bot:"):
        token = ""                      # a philosopher's seat is never claimable
    name = clean_name(msg.get("name"))
    old = table.sockets.get(ws)
    seated = old is not None and g.player_by_pid(old) is not None
    existing = g.player_by_token(token) if token else None
    if existing is not None and existing.is_bot:
        existing = None
    pid = old if seated else None
    if existing is not None:
        pid = existing.pid
        if g.phase == "lobby" and name:
            existing.name = name        # re-joining the lobby under a new name
    elif seated:
        # one socket, one seat: a second hello under a new token must not
        # mint another captain (six hellos would fill the fleet from one tab)
        await _send(ws, {"type": "error", "msg": "You already have a seat at this table."})
    elif g.phase == "lobby":
        try:
            pid = g.add_player(token, name).pid
        except GameError as e:
            await _send(ws, {"type": "error", "msg": str(e)})
            pid = None
    table.sockets[ws] = pid
    if pid is not None:
        p = g.player_by_pid(pid)
        if p is not None:
            p.connected = True
        table.gone_since.pop(pid, None)
    if old != pid:
        _mark_gone(old)                 # this socket left its previous seat
    # a (re)join re-kicks any pending fetch/timer for the current
    # phase — a refresh must heal a stuck card, never inherit it
    after_phase_change()
    await broadcast()


async def _handle(ws: WebSocket, msg: dict):
    kind = msg["type"]
    table.touch()
    if kind == "ping":
        await _send(ws, '{"type":"pong"}')
        return
    if kind == "hello":
        await _hello(ws, msg)
        return
    if ws not in table.sockets:
        await _send(ws, {"type": "error", "msg": "Say hello first."})
        return
    # the seat is read from the table every time — never cached per socket —
    # so a kick or a table reset takes effect on the very next message
    err = await dispatch(table.sockets[ws], kind, msg)
    if err:
        await _send(ws, {"type": "error", "msg": err})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    if len(table.outbox) >= WS_MAX_SOCKETS:
        await _close(ws)                # 1013 "try again later"
        return
    q: asyncio.Queue = asyncio.Queue(maxsize=WS_SEND_QUEUE)
    table.outbox[ws] = q
    table.writers[ws] = schedule(_writer(ws, q), "ws_writer")
    tokens, stamp, warned = WS_BURST, time.monotonic(), 0.0
    try:
        while ws in table.outbox:
            frame = await ws.receive()
            if frame.get("type") == "websocket.disconnect":
                break
            # a token bucket per socket: a client that floods is ignored, not
            # obeyed — every accepted message can cost a full table broadcast
            now = time.monotonic()
            tokens = min(WS_BURST, tokens + (now - stamp) * WS_RATE)
            stamp = now
            if tokens < 1:
                if now - warned > 1:
                    warned = now
                    await _send(ws, {"type": "error", "msg": "Slow down."})
                await asyncio.sleep(0)
                continue
            tokens -= 1
            text = frame.get("text")
            msg = None
            if text is not None and len(text) <= WS_MAX_MSG:
                try:
                    msg = json.loads(text)
                except Exception:       # bad JSON, or nesting deep enough to recurse out
                    msg = None
            if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
                await _send(ws, {"type": "error", "msg": "Malformed message."})
                await asyncio.sleep(0)
                continue
            try:
                await _handle(ws, msg)
            except Exception:           # never let one message end the socket loop
                log.exception("message %r failed", msg.get("type"))
                await _send(ws, {"type": "error", "msg": "Malformed message."})
            # let this socket's writer drain before reading on: a burst of
            # frames already buffered would otherwise be answered without
            # ever yielding, fill our own send queue, and cut a healthy client
            await asyncio.sleep(0)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("socket loop ended unexpectedly")
    finally:
        await _drop_socket(ws)


# ── background upkeep ────────────────────────────────────────────────────────
def heal_stuck_phase(g, stuck: float) -> str | None:
    """One healing step for a phase that has overstayed what its timers
    allow. Returns what was done ('refetch' needs no broadcast bump —
    fetch_question broadcasts itself when the question lands)."""
    now = time.time()
    if g.phase == "question" and g.question is None and stuck > 2.5:
        schedule(fetch_question(g.nonce), "fetch_question")   # re-summon the herald
        return "refetch"
    if (g.phase == "question" and g.question is not None
            and g.question_deadline and now > g.question_deadline + 3):
        g.timeout_question()                  # the question timer was lost
        return "timeout"
    if (g.phase == "minigame" and g.minigame
            and g.minigame.get("deadline")
            and now > g.minigame["deadline"] + 3):
        g.minigame_timeout()
        return "timeout"
    if (g.phase == "dodge" and g.dodge_deadline
            and now > g.dodge_deadline + 2):
        g.dodge_timeout()
        return "timeout"
    if (g.phase == "jchoose" and g.jchoose_deadline
            and now > g.jchoose_deadline + 3):
        g.jchoose_timeout()                   # the pick timer was lost
        return "timeout"
    if g.phase == "reveal" and stuck > 15:
        g.advance_after_reveal()              # the reveal timer was lost
        return "advance"
    return None


async def phase_watchdog():
    """The engine is driven by ONE-SHOT asyncio tasks (fetch the question,
    time the answer window, advance the reveal…). If any of them is lost —
    an exception, a raced guard, an event-loop hiccup — the table softlocks
    on a card forever. This loop notices any phase that has sat still past
    what its timers allow and heals it. Cheap, idempotent, always on."""
    last = (None, None, None)
    since = time.monotonic()
    while True:
        await asyncio.sleep(2)
        try:
            g = table.game
            cur = (id(g), g.phase, g.nonce)
            if cur != last:
                last = cur
                since = time.monotonic()
                continue
            action = heal_stuck_phase(g, time.monotonic() - since)
            if action == "refetch":
                since = time.monotonic()      # give the herald a fresh window
            elif action:
                log.warning("watchdog healed a stuck %s (%s)", cur[1], action)
                after_phase_change()
                await broadcast()
        except Exception:                     # the watchdog itself never dies
            log.exception("phase watchdog tick failed")


async def abandoned_game_reset():
    while True:
        await asyncio.sleep(min(30.0, max(0.05, ABANDON_RESET_SECS / 4)))
        try:
            g = table.game
            if g.phase == "lobby" and not g.players:
                continue                      # already an empty lobby
            aboard = {p.pid for p in g.players}
            anyone_here = any(pid in aboard for pid in table.sockets.values())
            idle = time.monotonic() - table.last_active
            if not anyone_here and idle > ABANDON_RESET_SECS:
                # nobody is at the table: a deserted voyage (bots sailing on
                # alone, or a finished one) AND a lobby of ghosts both go back
                # to a clean, joinable lobby
                log.info("table abandoned in %s — resetting", g.phase)
                table.reset()
                await broadcast()
        except Exception:
            log.exception("abandoned-table check failed")


def _startup():
    schedule(bank.refill_loop(), "bank_refill")
    schedule(trivia_bank.refill_loop(), "trivia_refill")
    schedule(bot_driver(), "bot_driver")
    schedule(abandoned_game_reset(), "abandoned_game_reset")
    schedule(phase_watchdog(), "phase_watchdog")
    schedule(turn_keeper(), "turn_keeper")
    # the typed-answer matcher's deck index takes ~0.3 s to build: do it now,
    # off the event loop, not under the first captain's first typed answer
    schedule(asyncio.to_thread(questions.known_answers), "warm_matcher")


async def _shutdown():
    loop = asyncio.get_running_loop()
    tasks = [t for t in _tasks
             if t is not asyncio.current_task() and t.get_loop() is loop]
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

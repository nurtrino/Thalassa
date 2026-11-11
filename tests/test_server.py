"""Server / IO-layer tests — the real app, real WebSockets.

Every test here starts the actual FastAPI app in-process (uvicorn on a free
loopback port, in the test's own event loop) and drives it with raw WebSocket
clients, the way static/app.js does: hello{token,name}, then game messages.
Timers are shrunk to milliseconds; questions come from the offline bundle.

    python3 -m pytest tests/test_server.py -q                 # the keepers (~25 s)
    THALASSA_SLOW=1 python3 -m pytest tests/test_server.py -q # + whole voyages
"""
import asyncio
import contextlib
import json
import os
import random
import socket
import time

import pytest
import uvicorn
import websockets

import bots
import game as G
import puzzles
import questions
import server as S

slow = pytest.mark.skipif(not os.environ.get("THALASSA_SLOW"),
                          reason="slow voyage test — set THALASSA_SLOW=1 to run")


# ════════════════════════════════════════════════════════════════════════════
# harness
# ════════════════════════════════════════════════════════════════════════════
class _Dice:
    """A seeded stand-in for the `secrets` module the server rolls with."""

    def __init__(self, seed):
        self.rng = random.Random(seed)

    def randbelow(self, n):
        return self.rng.randrange(n)

    def token_hex(self, n):
        return "%0*x" % (2 * n, self.rng.getrandbits(8 * n))


@pytest.fixture
def fast(monkeypatch):
    """A clean table and millisecond timers. Yields a dict of knobs."""
    monkeypatch.setenv("BATTLE_REVEAL_SECS", "0.03")
    monkeypatch.delenv("DEV_CHEATS", raising=False)
    for name, value in dict(
            QUESTION_SECS=30.0, JEOPARDY_SECS=30.0, JCHOOSE_SECS=30.0,
            REVEAL_SECS=0.03, BOT_TEMPO=0.0, BOT_POLL_SECS=0.005,
            GATE_WALK_SECS=0.02, TIMER_GRACE=0.02, SHOWN_ALLOW_SECS=0.0,
            IDLE_POLL_SECS=0.01, IDLE_TURN_SECS=0.0,
            GONE_TURN_SECS=0.3, AWAY_TURN_SECS=0.1, AUTO_STEP_SECS=0.02,
            ABANDON_RESET_SECS=300.0, BOT_STUCK_SECS=20.0,
            WS_RATE=5000.0, WS_BURST=5000.0).items():
        monkeypatch.setattr(S, name, value)
    monkeypatch.setattr(S, "secrets", _Dice(11))
    monkeypatch.setattr(questions, "OFFLINE", True)
    S.table.sockets.clear()
    S.table.outbox.clear()
    S.table.writers.clear()
    S.table.reset()
    S.table.game = G.Game("THALASSA", seed=7)
    S.table.bot_rng = random.Random(5)
    S.trivia_bank.buffer.clear()
    yield S
    S.table.sockets.clear()
    S.table.outbox.clear()
    S.table.writers.clear()
    S.table.reset()


class Live:
    """The real app on a loopback port, inside the running loop."""

    async def __aenter__(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        self.http = f"http://127.0.0.1:{self.port}"
        self.ws = f"ws://127.0.0.1:{self.port}/ws"
        self.server = uvicorn.Server(uvicorn.Config(
            S.app, log_level="error", lifespan="on"))
        self.task = asyncio.ensure_future(self.server.serve(sockets=[sock]))
        for _ in range(500):
            if self.server.started:
                break
            await asyncio.sleep(0.01)
        assert self.server.started, "server never came up"
        self.caps = []
        return self

    async def __aexit__(self, *exc):
        for c in self.caps:
            await c.close()
        self.server.should_exit = True
        await asyncio.wait_for(self.task, 10)

    async def cap(self, name=None, token=None, hello=True):
        c = Cap(await websockets.connect(self.ws, max_size=None), name, token)
        self.caps.append(c)
        if hello:
            await c.hello()
        return c

    async def get(self, path, method="GET"):
        """A bare HTTP/1.1 request → (status, json body)."""
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(f"{method} {path} HTTP/1.1\r\nHost: t\r\n"
                     f"Content-Length: 0\r\nConnection: close\r\n\r\n".encode())
        raw = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        head, _, body = raw.partition(b"\r\n\r\n")
        return int(head.split()[1]), json.loads(body)


class Cap:
    """One captain's raw socket — what static/app.js is to the browser."""
    seq = 0

    def __init__(self, ws, name=None, token=None):
        Cap.seq += 1
        self.ws = ws
        self.name = name if name is not None else f"Cap{Cap.seq}"
        self.token = token if token is not None else f"tok-{Cap.seq}-{os.getpid()}"
        self.you = None
        self.room = None
        self.snaps = 0
        self.phases = []
        self.trail = []                 # (turn, phase, turn_deadline) per snapshot
        self.reveal = None
        self.errors = []
        self.events = []
        self.pongs = 0
        self.closed = False
        self.reader = asyncio.ensure_future(self._read())

    async def _read(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if m["type"] == "snapshot":
                    self.you, self.room = m["you"], m["room"]
                    self.snaps += 1
                    self.phases.append(self.room["phase"])
                    self.trail.append((self.room["turn"], self.room["phase"],
                                       self.room.get("turn_deadline")))
                    if self.room.get("reveal"):
                        self.reveal = self.room["reveal"]   # reveals are brief
                    assert_no_secrets(self.room, self.you)
                elif m["type"] == "error":
                    self.errors.append(m["msg"])
                elif m["type"] == "pong":
                    self.pongs += 1
                else:
                    self.events.append(m)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.closed = True

    async def send(self, type, **fields):
        await self.ws.send(json.dumps({"type": type, **fields}))

    async def raw(self, data):
        await self.ws.send(data)

    async def hello(self):
        n = self.snaps
        await self.send("hello", token=self.token, name=self.name)
        await self.until(lambda: self.snaps > n, "a snapshot after hello")
        return self

    async def until(self, pred, what="condition", timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.reader.done() and self.reader.exception():
                raise self.reader.exception()          # a leak assertion
            if pred():
                return
            await asyncio.sleep(0.003)
        raise AssertionError(
            f"timed out waiting for {what} (phase={self.room and self.room['phase']}, "
            f"errors={self.errors[-3:]})")

    async def phase(self, *phases, timeout=5.0):
        await self.until(lambda: self.room and self.room["phase"] in phases,
                         f"phase in {phases}", timeout)

    async def alive(self):
        """The socket loop is still serving: a ping comes back as a pong."""
        n = self.pongs
        await self.send("ping")
        await self.until(lambda: self.pongs > n, "a pong")

    async def error(self, type, **fields):
        """Send something that must be refused; return the error text."""
        n = len(self.errors)
        await self.send(type, **fields)
        await self.until(lambda: len(self.errors) > n, f"an error for {type}")
        return self.errors[-1]

    async def close(self):
        with contextlib.suppress(Exception):
            await self.ws.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.reader, 2)


def run(coro, timeout=40):
    """Run a test coroutine on a private loop (never the global one — other
    test modules still call asyncio.get_event_loop())."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(asyncio.wait_for(coro, timeout))
    finally:
        with contextlib.suppress(Exception):
            loop.run_until_complete(S._shutdown())     # stray timers of this loop
            loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


async def settle(pred, what="condition", timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        await asyncio.sleep(0.003)
    g = S.table.game
    raise AssertionError(f"timed out waiting for {what} "
                         f"(phase={g.phase}, nonce={g.nonce})")


# ── what a snapshot may never carry ─────────────────────────────────────────
def _keys(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, f"{path}.{k}"
            yield from _keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _keys(v, f"{path}[{i}]")


def assert_no_secrets(room, you):
    """Checked on EVERY snapshot EVERY test client receives."""
    for key, where in _keys({k: v for k, v in room.items() if k != "board"}):
        assert key not in ("secret", "token", "data", "accept"), where
        if key in ("correct", "answer", "answer_text"):
            # an answer key may only ride the REVEAL card
            assert where.startswith(".reveal"), where
    q = room.get("question")
    if q:
        assert set(q) <= {"text", "options", "typed", "category", "kind",
                          "tier", "domain", "deadline", "disabled"}, set(q)
    if room.get("jboard"):
        for cell in room["jboard"]["cells"]:
            assert set(cell) == {"category", "value"}, cell
    if room.get("turn") != you:
        assert room.get("reachable") == {}, "a rival's landing beacons leaked"
        assert room.get("walk") is None, "a rival's arrow-walk leaked"
    me = next((p for p in room["players"] if p["pid"] == you), None)
    if not (me and me.get("map_bought")):
        assert room.get("sword_node") is None, "the trader's secret islet leaked"
    assert "turn_deadline" in room and "away" in room


# ── table helpers (in-process peeks — the tests run inside the server) ──────
def game():
    return S.table.game


def node_of(kind, pred=lambda n: True):
    g = game()
    return next(nid for nid, n in g.board.nodes.items()
                if n["type"] == kind and pred(n))


async def lobby(live, humans=2, bots_n=0, start=True):
    """Seat `humans` captains (+ bots), optionally set sail. → list of Caps."""
    caps = [await live.cap() for _ in range(humans)]
    for _ in range(bots_n):
        n = len(game().players)
        await caps[0].send("add_bot")
        await settle(lambda: len(game().players) == n + 1, "a bot to board")
    for c in caps:                      # every client has caught up with the roster
        await c.until(lambda: len(c.room["players"]) == humans + bots_n, "the roster")
    if start:
        await caps[0].send("start")
        for c in caps:
            await c.phase("roll")
    return caps


def cap_of(caps, pid):
    return next(c for c in caps if c.you == pid)


async def take_turn_holder(caps):
    """The Cap whose turn it is."""
    await settle(lambda: game().players and game().phase != "lobby", "a turn")
    return cap_of(caps, game().current.pid)


def solve_payload(mg):
    """The right answer for the minigames whose secret is a simple value."""
    data, kind = mg["data"], mg["kind"]
    sec = data.get("secret") or {}
    if kind == "ravens":
        return sec["correct"]
    if kind == "riddle":
        return sec["answer"]
    if kind == "sequence":
        return sec["answer"]
    if kind == "anagram":
        return sec["word"]
    if kind in ("simon", "memory"):
        return list(data["seq"])
    return None


async def play_one(cap, right=True):
    """One protocol action for `cap` in whatever phase it holds — a scripted
    human. Returns the phase it acted in (None if it is not cap's move)."""
    g = game()
    if not g.players or g.phase in ("lobby", "finished", "reveal"):
        return None
    if g.current.pid != cap.you:
        return None
    phase = g.phase
    nonce = g.nonce
    if phase == "roll":
        await cap.send("roll")
    elif phase == "sail":
        if g.reachable:
            await cap.send("sail", node=sorted(g.reachable)[0])
        else:
            await cap.send("walk", node=sorted(g.walk["options"])[0])
    elif phase == "shrine":
        await cap.send("wager", tier=1)
    elif phase in ("haven", "shop", "trade", "pharos"):
        await cap.send("pass")
    elif phase == "battle":
        await cap.send("stance", stance="attack", target=0)
    elif phase == "jchoose":
        await cap.send("jpick", idx=0)
    elif phase == "question":
        if g.question is None:
            await settle(lambda: g.question is not None or g.phase != "question",
                         "the herald")
            return "question"
        q = g.question
        if q.get("typed"):
            await cap.send("answer_text", text=q["answer"] if right else "zzzz")
        else:
            wrong = next(i for i in range(len(q["options"]))
                         if i != q["correct"] and i not in q.get("disabled", []))
            await cap.send("answer", idx=q["correct"] if right else wrong)
    elif phase == "minigame":
        payload = solve_payload(g.minigame) if right else None
        if payload is None:
            g.minigame_timeout()               # a grid puzzle: let its clock run out
            S.after_phase_change()
            await S.broadcast()
        else:
            await cap.send("solve", payload=payload)
    elif phase == "upgrade_pick":
        await cap.send("pick", upgrade=g.upgrade_offer[0])
    await settle(lambda: game().nonce != nonce or game().phase != phase,
                 f"{phase} to resolve")
    return phase


async def play_until(caps, stop, limit=400):
    """Scripted humans play until stop() — returns the phases they acted in."""
    seen = []
    for _ in range(limit):
        if stop():
            return seen
        g = game()
        if g.phase == "reveal" or (g.players and g.current.pid in S.table.bots):
            await asyncio.sleep(0.005)
            continue
        acted = await play_one(cap_of(caps, g.current.pid))
        if acted:
            seen.append(acted)
    raise AssertionError(f"play_until: no stop after {limit} actions "
                         f"(phase={game().phase})")


async def dev(cap, **fields):
    """A DEV_CHEATS message (the fixture's test must have enabled them)."""
    nonce = game().nonce
    await cap.send("dev", **fields)
    await settle(lambda: game().nonce != nonce, "the dev hook")


async def to_my_roll(caps, cap):
    await play_until(caps, lambda: game().phase == "roll"
                     and game().current.pid == cap.you)


# ════════════════════════════════════════════════════════════════════════════
# lobby, identity, reconnects
# ════════════════════════════════════════════════════════════════════════════
def test_join_add_bots_start(fast):
    async def main():
        async with Live() as live:
            a = await live.cap("Ada")
            b = await live.cap("Bo")
            assert a.you and b.you and a.you != b.you
            assert a.room["phase"] == "lobby" and a.room["host"] == a.you
            # only the host invites philosophers or launches
            assert "host" in await b.error("add_bot")
            assert "host" in await b.error("start")
            await a.send("add_bot")
            await a.send("add_bot")
            await a.until(lambda: len(a.room["players"]) == 4, "two bots")
            assert [p["bot"] for p in a.room["players"]] == [False, False, True, True]
            assert len({p["name"] for p in a.room["players"]}) == 4
            await a.send("start")
            await b.phase("roll")
            assert b.room["turn"] == a.you
            assert "Already" in await a.error("start")
    run(main())


def test_names_are_sanitised_and_capped(fast):
    assert S.clean_name("  Ada \n\t Lovelace  ") == "Ada Lovelace"
    assert S.clean_name("x" * 500) == "x" * 16
    assert S.clean_name("Zo​e‮!") == "Zoe!"          # zero-width + RTL override
    assert S.clean_name("\x00\x07") == ""
    assert S.clean_name(None) == "" and S.clean_name(["a"]) == "" and S.clean_name(7) == ""

    async def main():
        async with Live() as live:
            a = await live.cap("Evil\nLine‮" + "z" * 100)
            b = await live.cap("")
            c = await live.cap(hello=False)
            await c.send("hello", token=["not", "a", "string"], name={"x": 1})
            await c.until(lambda: c.you, "a seat")
            await a.until(lambda: len(a.room["players"]) == 3, "three captains")
            names = [p["name"] for p in a.room["players"]]
            assert names[0] == "Evil Linezzzzzzz" and len(names[0]) <= 16
            assert names[1] == "Captain 2" and names[2] == "Captain 3"
    run(main())


def test_one_socket_one_seat_and_no_bot_seats(fast):
    async def main():
        async with Live() as live:
            a = await live.cap("Ada")
            # a second hello under fresh tokens must not mint more captains
            for i in range(8):
                await a.send("hello", token=f"other-{i}", name="Sock")
            await a.alive()
            assert len(game().players) == 1
            assert any("already have a seat" in e for e in a.errors)
            await a.send("add_bot")
            await a.until(lambda: len(a.room["players"]) == 2, "a bot")
            bot = game().players[1]
            # a bot's token is not a seat anyone can claim
            thief = await live.cap(hello=False)
            await thief.send("hello", token=bot.token, name="Thief")
            await thief.until(lambda: thief.you, "a seat")
            assert thief.you != bot.pid and bot.pid in S.table.bots
    run(main())


def test_rejoining_the_lobby_updates_the_name(fast):
    async def main():
        async with Live() as live:
            a = await live.cap("Captain", token="same-token")
            pid = a.you
            await a.close()
            a2 = await live.cap("Odysseus", token="same-token")
            assert a2.you == pid
            assert [p["name"] for p in a2.room["players"]] == ["Odysseus"]
    run(main())


def test_reconnect_mid_question_keeps_seat_and_question(fast):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            g = game()
            shrine = node_of("shrine", lambda n: n.get("charges", 0) > 0)
            g.current.node = shrine
            g._land(g.current, shrine)
            S.after_phase_change()
            await S.broadcast()
            await a.send("wager", tier=2)
            await b.until(lambda: b.room["question"], "the question")
            deadline = b.room["question"]["deadline"]
            await a.close()                                   # phone locks
            await b.until(lambda: not b.room["players"][0]["connected"], "a to drop")
            assert g.phase == "question"
            a2 = await live.cap(token=a.token)
            assert a2.you == a.you
            assert a2.room["phase"] == "question"
            assert a2.room["question"]["deadline"] == deadline  # same clock, not a new one
            await b.until(lambda: b.room["players"][0]["connected"], "a back")
            await a2.send("answer", idx=g.question["correct"])
            await b.phase("reveal", "trade")
            assert b.room["players"][0]["scrolls"] == 5         # 3 + tier II
    run(main())


def test_reconnect_mid_battle_keeps_the_fight(fast, monkeypatch):
    monkeypatch.setenv("DEV_CHEATS", "1")

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            await dev(a, fight={"kind": "pack", "tier": 0}, battle_mode="mc")
            await a.phase("battle")
            await a.close()
            await b.until(lambda: not b.room["players"][0]["connected"], "a to drop")
            a2 = await live.cap(token=a.token)
            assert a2.you == a.you and a2.room["phase"] == "battle"
            assert a2.room["battle"]["enemies"]
            await a2.send("stance", stance="attack", target=0)
            await a2.until(lambda: a2.room["question"], "the battle question")
            # …and drop again while the exchange plays out: the foe's blow
            # resolves in the same reveal, no reflex beat to strand on
            await a2.send("answer", idx=game().question["correct"])
            await b.phase("reveal")
            await a2.close()
            a3 = await live.cap(token=a.token)
            assert a3.room["phase"] in ("reveal", "battle", "trade", "roll")
            assert a3.room["dodge"] is None          # vestigial, always empty
            # an OLD client's dodge tap is refused harmlessly
            assert "unknown" in (await a3.error("dodge", hit=True, full=True)).lower()
            await b.phase("battle", "trade", "roll")
    run(main())


def test_second_tab_same_token_shares_the_seat(fast):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            tab = await live.cap(token=a.token)
            assert tab.you == a.you and len(game().players) == 2
            await tab.send("roll")                      # either tab may play
            await a.phase("sail")
            await tab.phase("sail")
            assert a.room["reachable"] and tab.room["reachable"]
            await a.close()                             # one tab closes…
            await tab.alive()
            await asyncio.sleep(0.05)
            assert game().players[0].connected          # …the captain is still here
            assert b.room["players"][0]["connected"]
            await tab.close()                           # the last one goes
            await b.until(lambda: not b.room["players"][0]["connected"], "a gone")
    run(main())


def test_host_powers_pass_while_the_host_is_away(fast):
    if not hasattr(G.Game, "host_pid"):
        pytest.skip("engine has no host hand-over")

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2, start=False)
            assert b.room["host"] == a.you
            await a.close()
            await b.until(lambda: b.room["host"] == b.you, "the host hand-over")
            await b.send("add_bot")                     # the server's own host check
            await b.until(lambda: len(b.room["players"]) == 3, "a bot")
            await b.send("start")
            await b.phase("roll")
    run(main())


def test_kick_in_lobby_and_mid_game(fast):
    async def main():
        async with Live() as live:
            a, b, c = await lobby(live, 3, start=False)
            assert "host" in (await b.error("kick", pid=c.you)).lower()
            await a.send("kick", pid=c.you)
            await c.until(lambda: c.you is None, "c to lose the seat")
            assert len(c.room["players"]) == 2
            await a.send("start")
            await b.phase("roll")
            # the kicked tab is a watcher now: nothing it sends moves the game
            nonce = game().nonce
            await c.error("roll")
            assert game().nonce == nonce
            # kick the captain who HOLDS the turn mid-question: the dice pass on
            await play_until([a, b], lambda: game().current.pid == b.you
                             and game().phase == "roll")
            await a.send("add_bot")                      # refused mid-voyage
            await b.send("roll")
            await b.phase("sail")
            await a.send("kick", pid=b.you)
            await b.until(lambda: b.you is None, "b to lose the seat")
            assert a.room["phase"] == "finished" and a.room["winner"] == a.you
            assert b.you not in S.table.away and not S.table.gone_since
    run(main())


def test_kicking_a_bot_forgets_its_brain(fast):
    async def main():
        async with Live() as live:
            (a,) = await lobby(live, 1, bots_n=2, start=False)
            bot = game().players[1].pid
            await a.send("kick", pid=bot)
            await a.until(lambda: len(a.room["players"]) == 2, "the bot to leave")
            assert bot not in S.table.bots and len(S.table.bots) == 1
    run(main())


def test_rematch_after_a_finish(fast, monkeypatch):
    monkeypatch.setenv("DEV_CHEATS", "1")

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2, bots_n=1)
            await dev(a, win=True)
            await b.phase("finished")
            assert b.room["winner"] == a.you
            assert "host" in (await b.error("rematch")).lower()
            await a.send("rematch")
            await b.phase("roll")
            assert b.room["winner"] is None and b.room["turn"] == a.you
            assert all(p["scrolls"] == 3 and p["banked"] == 0 for p in b.room["players"])
            assert len(S.table.bots) == 1                   # the philosopher stayed
            await play_until([a, b], lambda: game().current.pid == b.you)
    run(main())


def test_table_reset_returns_everyone_to_an_empty_lobby(fast):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2, bots_n=1)
            old_game = game()
            status, body = await live.get("/reset", "POST")
            assert status == 200 and body == {"ok": True}
            await a.until(lambda: a.room["phase"] == "lobby" and a.you is None, "reset")
            await b.until(lambda: b.you is None, "reset")
            assert game() is not old_game and not game().players and not S.table.bots
            # the old sockets are watchers of the NEW table — their old seats are void
            assert "host" in (await a.error("start")).lower()
            assert game().phase == "lobby" and not game().players
            # …until they say hello again
            await b.hello()
            assert b.you and b.room["host"] == b.you and len(b.room["players"]) == 1
    run(main())


def test_late_joiner_watches_and_cannot_play(fast):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            w = await live.cap("Latecomer")
            assert w.you is None and w.room["phase"] == "roll"
            assert len(w.room["players"]) == 2
            nonce = game().nonce
            for kind, fields in [("roll", {}), ("pass", {}), ("start", {}),
                                 ("add_bot", {}), ("kick", {"pid": b.you}),
                                 ("answer", {"idx": 0}), ("rematch", {})]:
                await w.error(kind, **fields)
            assert game().nonce == nonce and len(game().players) == 2
            # they keep receiving the voyage (asserted leak-free on arrival)
            await a.send("roll")
            await w.phase("sail")
            await a.phase("sail")
            assert w.room["reachable"] == {} and a.room["reachable"]
            await w.close()
            assert all(p.connected for p in game().players)
    run(main())


# ════════════════════════════════════════════════════════════════════════════
# a voyage through every phase, with rivals answering from the side
# ════════════════════════════════════════════════════════════════════════════
def test_humans_play_through_every_phase(fast, monkeypatch):
    monkeypatch.setenv("DEV_CHEATS", "1")

    async def main():
        async with Live() as live:
            a, b = caps = await lobby(live, 2, bots_n=1)
            seen = set()

            async def visit(cap, node, until_roll=True, **devmsg):
                """Teleport `cap` onto a stop on its own turn and play it out."""
                await to_my_roll(caps, cap)
                await dev(cap, node=node, land=1, **devmsg)
                seen.add(game().phase)
                if until_roll:
                    done = lambda: (game().phase == "roll"            # noqa: E731
                                    and game().current.pid != cap.you)
                    seen.update(await play_until(caps, done))

            # a normal turn first: roll → sail → (landing) → trade → pass
            seen.update(await play_until(caps, lambda: game().current.pid != a.you))
            assert {"roll", "sail"} <= seen
            assert any(e["type"] == "dice" and e["pid"] == a.you
                       and 1 <= e["value"] <= 3 for e in b.events)

            # shrine → question → reveal, with b answering from the side
            shrine = node_of("shrine", lambda n: n.get("charges", 0) > 0)
            await visit(a, shrine, until_roll=False)
            assert game().phase == "shrine"
            await a.send("wager", tier=3)
            await b.until(lambda: b.room["question"], "the shrine question")
            assert b.room["question"]["tier"] == 3
            assert game().question["d"] == 3                   # tier III → brutal
            before = game().player_by_pid(b.you).scrolls
            await b.send("answer", idx=game().question["correct"])   # a side answer
            await a.until(lambda: b.you in a.room["side_answered"], "side answer")
            assert "already" in (await b.error("answer", idx=0)).lower()
            b.reveal = None
            await a.send("answer", idx=game().question["correct"])
            await b.until(lambda: b.reveal, "the reveal")
            assert b.reveal["side"][b.you]["ok"] is True
            assert b.reveal["was_correct"] is True and b.reveal["kind"] == "shrine"
            assert game().player_by_pid(b.you).scrolls == before + 1
            seen.update(["shrine", "question", "reveal"])
            seen.update(await play_until(caps, lambda: game().current.pid != a.you))

            # haven, market (a fitting → upgrade pick), the sealed Pharos door
            await visit(b, node_of("haven"))
            await to_my_roll(caps, a)
            await dev(a, scrolls=40)
            await dev(a, node=node_of("shop"), land=1)
            assert game().phase == "shop"
            await a.send("shop_buy", item="planks")
            await a.send("shop_buy", item="fitting")
            await a.phase("upgrade_pick")
            # (b's snapshot rides its own socket: wait for it, don't race it)
            await b.until(lambda: b.room.get("upgrade_offer"), "the upgrade offer")
            assert a.room["upgrade_offer"] and b.room["upgrade_offer"]
            seen.update(["shop", "upgrade_pick"])
            seen.update(await play_until(caps, lambda: game().current.pid != a.you))
            await visit(b, "pharos")
            assert "pharos" in seen

            # a puzzle spire
            spire = node_of("puzzle", lambda n: not n.get("solved"))
            await visit(a, spire)

            # a mountain pass: landfall, then the carry-through
            gate = node_of("gate")
            await to_my_roll(caps, b)
            await dev(b, node=gate, land=1)
            await settle(lambda: game().player_by_pid(b.you).node != gate,
                         "the pass to carry b through")
            seen.update(await play_until(caps, lambda: game().current.pid != b.you))

            # battles: all three decks and a kill
            for mode in ("mc", "jeopardy", "puzzle"):
                await to_my_roll(caps, a)
                await dev(a, fight={"kind": "pack", "tier": 0, "count": 1},
                          battle_mode=mode)
                assert game().phase == "battle"
                await a.send("stance", stance="attack", target=0)
                want = {"mc": "question", "jeopardy": "jchoose",
                        "puzzle": "minigame"}[mode]
                await b.phase(want)
                seen.add("battle")
                if mode == "jeopardy":
                    assert b.room["jboard"]["deadline"]
                    await a.send("jpick", idx=1)
                    await b.until(lambda: b.room["question"]
                                  and b.room["question"]["typed"], "the typed clue")
                    assert "typed" in (await b.error("answer", idx=0)).lower()
                    seen.add("jchoose")
                # fight it out (each round re-forces the same deck)
                for _ in range(60):
                    if game().phase == "roll" or game().current.pid != a.you:
                        break
                    if game().phase == "battle":
                        game()._force_mode = mode
                    acted = await play_one(a) if game().phase != "reveal" else None
                    if acted:
                        seen.add(acted)
                    else:
                        await asyncio.sleep(0.005)
                seen.update(await play_until(
                    caps, lambda: game().phase == "roll" and game().current.pid != a.you))
            assert {"battle", "question", "jchoose", "minigame",
                    "trade"} <= seen, seen
            assert "dodge" not in seen                # the reflex beat is gone
            assert seen >= {"roll", "sail", "shrine", "haven", "shop", "pharos",
                            "upgrade_pick"}, seen
            # nobody was ever put on autopilot, and both sockets are still served
            assert not S.table.away
            await a.alive()
            await b.alive()
    run(main(), timeout=60)


# ════════════════════════════════════════════════════════════════════════════
# hostile and broken clients
# ════════════════════════════════════════════════════════════════════════════
JUNK_FRAMES = [
    "not json", "", " ", "[1,2,3]", "42", "null", '"str"', "{}", "true",
    '{"type":5}', '{"type":null}', '{"type":["x"]}', '{"type":{"a":1}}',
    '{"type":"nope"}', '{"type":"' + "x" * 100_000 + '"}',
    "[" * 6000,                                        # nests past the recursion limit
    '{"type":"wager","tier":1e999}',                   # float('inf') → OverflowError
    '{"type":"wager","tier":NaN}', '{"type":"wager","tier":"x"}',
    '{"type":"wager"}', '{"type":"wager","tier":[1]}',
    '{"type":"sail"}', '{"type":"sail","node":{"a":1}}', '{"type":"sail","node":7}',
    '{"type":"walk","node":null}',
    '{"type":"stance","stance":7,"target":[1]}', '{"type":"stance","target":1e999}',
    '{"type":"stance","stance":"heal","mode":{"x":1}}',
    '{"type":"answer","idx":null}', '{"type":"answer","idx":"0"}', '{"type":"answer"}',
    '{"type":"answer_text","text":"' + "a" * 15_000 + '"}',
    '{"type":"answer_text","text":{"a":[1]}}',
    '{"type":"solve","payload":[[[[[[]]]]]]}', '{"type":"solve"}',
    '{"type":"solve","payload":"' + "9" * 9000 + '"}',
    '{"type":"kick","pid":17}', '{"type":"kick"}', '{"type":"pick"}',
    '{"type":"pick","upgrade":["hull_plates"]}',
    '{"type":"jpick","idx":"NaN"}', '{"type":"jpick","idx":1e400}',
    '{"type":"dodge"}', '{"type":"dodge","hit":{"a":1}}',
    '{"type":"use","item":["planks"]}', '{"type":"use"}',
    '{"type":"shop_buy","item":null}', '{"type":"shop_buy","item":"' + "z" * 9000 + '"}',
    '{"type":"item","id":0}', '{"type":"buy_map","x":1}', '{"type":"flee","now":true}',
    '{"type":"repair"}', '{"type":"pharos_enter"}', '{"type":"rematch"}',
    '{"type":"dev","code":"000","win":true}', '{"type":"dev"}',
    '{"type":"dev","code":"783","fight":"boom"}',
    '{"type":"dev","code":"783","fight":{"kind":"pack","tier":"x"}}',
    '{"type":"dev","code":"783","scrolls":1e999}',
    '{"type":"dev","code":"783","region":["hub"],"node":{"x":1}}',
    '{"type":"skip"}',                                  # the removed host button
    '{"type":"hello","token":null,"name":null}',
    '{"type":"hello","token":"' + "t" * 5000 + '","name":"' + "n" * 5000 + '"}',
]


def test_malformed_messages_never_kill_the_socket_or_the_table(fast):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2, bots_n=1)
            g = game()
            before = (g.phase, g.turn_idx, len(g.players))
            # from the captain holding the turn, from a rival, and from a
            # socket that never said hello
            stranger = await live.cap(hello=False)
            for cap in (a, b, stranger):
                for frame in JUNK_FRAMES:
                    await cap.raw(frame)
                await cap.raw(b"\x00\xff\x10binary")            # a binary frame
                await cap.alive()                               # loop still serving
            assert (g.phase, g.turn_idx, len(g.players)) == before
            assert game() is g and g.winner is None
            assert not a.closed and not b.closed and not stranger.closed
            assert all("Malformed" in e or "Unknown" in e or "hello" in e.lower()
                       or e for e in stranger.errors)
            # and the voyage simply continues
            await a.send("roll")
            await b.phase("sail")
            await play_until([a, b], lambda: game().current.pid == b.you
                             and game().phase == "roll")
    run(main())


def test_out_of_turn_and_wrong_phase_messages_change_nothing(fast):
    actions = [("roll", {}), ("sail", {"node": "home"}), ("walk", {"node": "home"}),
               ("wager", {"tier": 1}), ("pass", {}), ("repair", {}),
               ("shop_buy", {"item": "planks"}), ("buy_map", {}),
               ("use", {"item": "planks"}), ("stance", {"stance": "attack", "target": 0}),
               ("flee", {}), ("dodge", {"hit": True}), ("jpick", {"idx": 0}),
               ("item", {"id": "owl"}), ("pharos_enter", {}), ("answer", {"idx": 0}),
               ("answer_text", {"text": "x"}), ("pick", {"upgrade": "ram"}),
               ("solve", {"payload": 1}), ("rematch", {}), ("start", {}),
               ("add_bot", {})]

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            g = game()
            snap = json.dumps(g.to_dict(None), sort_keys=True, default=str)
            for kind, fields in actions:                 # the rival, out of turn
                await b.error(kind, **fields)
            for kind, fields in actions:                 # the right captain, wrong phase
                if kind != "roll":
                    await a.error(kind, **fields)
            assert json.dumps(g.to_dict(None), sort_keys=True, default=str) == snap
            assert len(a.errors) == len(actions) - 1 and len(b.errors) == len(actions)
    run(main())


def test_an_engine_exception_costs_one_message_not_the_socket(fast, monkeypatch):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)

            def boom(self, pid):
                raise RuntimeError("engine bug")
            monkeypatch.setattr(G.Game, "repair", boom)
            assert "Malformed" in await a.error("repair")
            await a.alive()
            await a.send("roll")
            await b.phase("sail")
    run(main())


def test_one_viewers_broken_snapshot_does_not_starve_the_others(fast, monkeypatch):
    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            real = G.Game.to_dict

            def flaky(self, viewer=None):
                if viewer == b.you:
                    raise KeyError("bad field")
                return real(self, viewer)
            monkeypatch.setattr(G.Game, "to_dict", flaky)
            await a.send("roll")
            await a.phase("sail")                         # a still gets the stream
            assert b.room["phase"] == "roll"              # b just missed a frame
            monkeypatch.setattr(G.Game, "to_dict", real)
            await a.send("sail", node=sorted(game().reachable)[0])
            await b.until(lambda: b.room["phase"] != "roll", "b's stream to resume")
    run(main())


def test_a_flooding_client_is_throttled_not_obeyed(fast, monkeypatch):
    monkeypatch.setattr(S, "WS_RATE", 20.0)
    monkeypatch.setattr(S, "WS_BURST", 40.0)
    builds = []
    real = G.Game.to_dict
    monkeypatch.setattr(G.Game, "to_dict",
                        lambda self, v=None: builds.append(v) or real(self, v))

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            builds.clear()
            t0 = time.monotonic()
            for _ in range(600):                          # 600 hellos = 600 broadcasts
                await b.send("hello", token=b.token, name=b.name)
            await b.until(lambda: "Slow down." in b.errors, "the throttle")
            await asyncio.sleep(0.2)
            # at most the burst plus the sustained rate — not 600 broadcasts
            # (each one builds a snapshot for both viewers)
            allowed = S.WS_BURST + S.WS_RATE * (time.monotonic() - t0) + 5
            assert len(builds) <= 2 * allowed < 2 * 600, (len(builds), allowed)
            await a.alive()                               # the table never stalled
            await a.send("roll")
            await a.phase("sail")
            await asyncio.sleep(0.3)                      # the bucket refills
            await b.alive()
    run(main())


def test_socket_count_is_capped(fast, monkeypatch):
    monkeypatch.setattr(S, "WS_MAX_SOCKETS", 3)

    async def main():
        async with Live() as live:
            a, b, c = [await live.cap() for _ in range(3)]
            extra = await live.cap(hello=False)
            await extra.until(lambda: extra.closed, "the extra socket to be refused")
            assert extra.ws.close_code == 1013 and len(S.table.outbox) == 3
            await a.alive()
            await c.close()                               # a slot frees up…
            await settle(lambda: len(S.table.outbox) == 2, "the slot")
            d = await live.cap()                          # …and is usable again
            assert d.you
    run(main())


async def _stalled_socket(port, token):
    """A raw WebSocket client that says hello and then NEVER reads again."""
    import base64
    loop = asyncio.get_running_loop()
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
    sock.setblocking(False)
    await loop.sock_connect(sock, ("127.0.0.1", port))
    key = base64.b64encode(os.urandom(16)).decode()
    await loop.sock_sendall(sock, (
        f"GET /ws HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    assert b"101" in await loop.sock_recv(sock, 1024)
    payload = json.dumps({"type": "hello", "token": token, "name": "Stall"}).encode()
    mask = os.urandom(4)
    frame = bytes([0x81, 0x80 | len(payload)]) + mask + bytes(
        c ^ mask[i % 4] for i, c in enumerate(payload))
    await loop.sock_sendall(sock, frame)
    return sock


def test_a_client_that_stops_reading_cannot_stall_the_table(fast):
    async def main():
        async with Live() as live:
            a = await live.cap("Ada")
            sock = await _stalled_socket(live.port, "stalled-token")
            try:
                await settle(lambda: len(game().players) == 2, "the stalled captain")
                stalled = game().players[1]
                assert stalled.connected
                worst, start, seen = 0.0, a.snaps, 0
                for i in range(1500):
                    t = time.perf_counter()
                    await S.broadcast()                   # must never wait on a socket
                    worst = max(worst, time.perf_counter() - t)
                    await asyncio.sleep(0)
                    if not stalled.connected:
                        seen = i
                        break
                assert worst < 0.5, f"a broadcast blocked for {worst:.2f}s"
                assert not stalled.connected, "the dead socket was never cut"
                assert len(S.table.sockets) == 1 and len(S.table.outbox) == 1
                await a.until(lambda: a.snaps >= start + seen, "a's own stream")
                await a.alive()
            finally:
                sock.close()
    run(main())


# ════════════════════════════════════════════════════════════════════════════
# the idle-turn clock (no host skip button: the table must free itself)
# ════════════════════════════════════════════════════════════════════════════
def _solo_table(n=2, seed=3, bots_n=0):
    """An in-process table with no sockets: n human seats (+ bots)."""
    S.table.reset()
    g = S.table.game = G.Game("THALASSA", seed=seed)
    pids = [g.add_player(f"tok{i}", f"P{i}").pid for i in range(n)]
    for i in range(bots_n):
        p = g.add_player(f"bot:{i}", bots.PHILOSOPHERS[i].name, is_bot=True)
        S.table.bots[p.pid] = bots.PHILOSOPHERS[i]
    g.start(pids[0])
    return g, pids


def _land_on(g, pid, nid):
    p = g.player_by_pid(pid)
    p.prev_node, p.node = p.node, nid
    g._land(p, nid)


def test_idle_default_for_every_untimed_phase(fast):
    # roll: the turn is forfeited, the ship does not move
    g, (a, b) = _solo_table()
    where = g.player_by_pid(a).node
    assert S.idle_step(g, a) == "forfeit"
    assert g.phase == "roll" and g.current.pid == b
    assert g.player_by_pid(a).node == where and "away" in g.log[-1]

    # sail: at anchor
    g, (a, b) = _solo_table()
    g.roll(a, 2)
    assert g.phase == "sail"
    assert S.idle_step(g, a) == "forfeit"
    assert g.current.pid == b and g.phase == "roll" and not g.reachable

    # shrine / haven / the sealed Pharos door: walk away, and wave the trader off
    for kind in ("shrine", "haven", "pharos"):
        g, (a, b) = _solo_table()
        nid = "pharos" if kind == "pharos" else next(
            n for n, d in g.board.nodes.items() if d["type"] == kind
            and (kind != "shrine" or d.get("charges", 0) > 0))
        _land_on(g, a, nid)
        assert g.phase == kind
        assert S.idle_step(g, a) == "pass"
        assert g.phase == "roll" and g.current.pid == b, kind

    # market and the trade beat
    g, (a, b) = _solo_table()
    _land_on(g, a, next(n for n, d in g.board.nodes.items() if d["type"] == "shop"))
    assert g.phase == "shop" and S.idle_step(g, a) == "pass" and g.current.pid == b
    g, (a, b) = _solo_table()
    g._end_turn()
    assert g.phase == "trade" and S.idle_step(g, a) == "pass" and g.current.pid == b

    # an upgrade pick is TAKEN, never forfeited
    g, (a, b) = _solo_table()
    g.upgrade_offer = ["ram", "sandals"]
    g._bump("upgrade_pick")
    assert S.idle_step(g, a) == "pick"
    assert g.player_by_pid(a).upgrades in (["ram"], ["sandals"]) and g.current.pid == b


def test_idle_default_finishes_a_walk_already_under_way(fast):
    """The Amber Vale's arrow-walk: once a captain has committed to a trail
    and stands at a fork, 'stay at anchor' is no longer true — the default
    takes the first trail instead of teleporting them back."""
    import copy
    for seed in (1, 2, 3):
        g, (a, b) = _solo_table(seed=seed)
        vale = [nid for nid, n in g.board.nodes.items()
                if n.get("region") == "autumn" and n["type"] == "sea"]
        for nid in vale:
            g2 = copy.deepcopy(g)
            p = g2.player_by_pid(a)
            p.node = p.prev_node = nid
            p.next_roll_bonus = 2
            g2.roll(a, 1)
            if g2.phase != "sail" or not g2.walk:
                continue
            for opt in list(g2.walk["options"]):
                g3 = copy.deepcopy(g2)
                g3.walk_step(a, opt)
                if not (g3.phase == "sail" and g3.walk and g3.walk.get("options")
                        and not g3.reachable):
                    continue
                # paused at a fork, beacons waived: the idle default walks on
                S.table.game = g3
                first = sorted(g3.walk["options"])[0]
                assert S.idle_step(g3, a) == "walk"
                assert g3.walk is None or first in g3.walk["path"]
                assert g3.phase != "sail" or g3.walk       # it moved on or paused anew
                # …and repeated defaults always end the turn
                for _ in range(12):
                    if g3.current.pid != a:
                        break
                    S.idle_step(g3, a)
                assert g3.current.pid == b
                return
    pytest.skip("no forked Vale trail on these charts")


def _fight(g, pid, boss=False):
    spec = {"kind": "boss", "region": "warden"} if boss else \
        {"kind": "pack", "tier": 0, "count": 1}
    g.dev_fight(pid, spec)
    assert g.phase == "battle"


def test_idle_default_in_battle_flees_or_fights_on(fast):
    # a pack: try the engine's own retreat (a scroll, a coin flip)
    g, (a, b) = _solo_table()
    _fight(g, a)
    scrolls = g.player_by_pid(a).scrolls
    assert S.idle_step(g, a) == "flee"
    assert g.player_by_pid(a).scrolls == scrolls - G.FLEE_COST
    assert g.phase in ("battle", "roll")               # cut off, or away clean

    # no scrolls → cannot flee → STRIKE (the fight must still move)
    g, (a, b) = _solo_table()
    _fight(g, a)
    g.player_by_pid(a).scrolls = 0
    assert S.idle_step(g, a) == "strike"
    assert g.phase in ("question", "jchoose", "minigame")
    assert g.battle["stance"] == "attack"

    # a trial allows no retreat → STRIKE
    g, (a, b) = _solo_table()
    _fight(g, a, boss=True)
    assert S.idle_step(g, a) == "strike"
    assert g.phase in ("question", "jchoose", "minigame")


def test_idle_default_for_timed_phases_is_the_engines_own_timeout(fast):
    g, (a, b) = _solo_table()
    _fight(g, a)
    g._force_mode = "mc"
    g.stance(a, "attack", 0)
    g.set_question({"text": "Q?", "options": list("abcd"), "correct": 1})
    hull = g.player_by_pid(a).hull
    assert S.idle_step(g, a) == "timeout" and g.phase == "reveal"
    assert g.reveal["was_correct"] is False
    # no reflex beat follows: the foe's blow landed in full in that reveal
    assert g.reveal["enemy_phase"]["counter"] and not g.reveal["enemy_phase"]["blunted"]
    assert g.player_by_pid(a).hull < hull
    g.advance_after_reveal()
    assert g.phase == "battle"

    g, (a, b) = _solo_table()
    _fight(g, a)
    g._force_mode = "jeopardy"
    g.stance(a, "attack", 0)
    assert g.phase == "jchoose"
    assert S.idle_step(g, a) == "timeout" and g.phase == "question"

    # a CLOCKLESS minigame (simon / memory have no timer at all)
    g, (a, b) = _solo_table()
    _fight(g, a)
    deal = puzzles.deal_kind(g.rng, "simon")
    assert deal["limit"] is None
    g.battle["stance"], g.battle["target"] = "attack", 0
    g.minigame = {"kind": "simon", "island": g.battle["node"], "data": deal,
                  "limit": None, "deadline": None, "battle": True}
    g._bump("minigame")
    assert S._clockless(g)
    assert S.idle_step(g, a) == "timeout" and g.phase == "reveal"


def test_idle_default_never_leaves_the_turn_stuck(fast, monkeypatch):
    # even if the engine refuses EVERYTHING, the dice still pass
    g, (a, b) = _solo_table()
    _fight(g, a)

    def refuse(*_a, **_k):
        raise RuntimeError("engine bug")
    monkeypatch.setattr(g, "flee", refuse)
    monkeypatch.setattr(g, "stance", refuse)
    assert S.idle_step(g, a) == "forced"
    assert g.phase == "roll" and g.current.pid == b and g.battle is None


def test_turn_deadline_is_published_and_only_when_a_clock_runs(fast, monkeypatch):
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 60.0)

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2, bots_n=1)
            now = time.time()
            assert a.room["turn"] == a.you
            # a captain's first decision of the voyage gets a double window
            # (the opening fly-over and the rules card come first)
            assert now + 110 < a.room["turn_deadline"] <= now + 121
            assert b.room["turn_deadline"] == a.room["turn_deadline"]   # same for all
            assert a.room["away"] == []
            await a.send("roll")
            await a.phase("sail")
            now = time.time()                              # a fresh decision, a fresh clock
            assert now + 50 < a.room["turn_deadline"] <= now + 61
            # a timed phase with its captain present runs on its OWN clock
            g = game()
            shrine = node_of("shrine", lambda n: n.get("charges", 0) > 0)
            g.reachable = {shrine: 1}
            await a.send("sail", node=shrine)
            await a.phase("shrine")
            await a.send("wager", tier=1)
            await a.until(lambda: a.room["question"], "the question")
            assert a.room["turn_deadline"] is None
            assert a.room["question"]["deadline"]
            # a bot's turn: no idle clock (the driver plays it)
            await a.send("answer", idx=g.question["correct"])
            await play_until([a, b], lambda: game().current.pid in S.table.bots, 50)
            bot_frames = lambda: [t for t in a.trail if t[0] in S.table.bots]  # noqa: E731
            await a.until(bot_frames, "a frame from the bot's turn")
            assert all(deadline is None for _turn, _phase, deadline in bot_frames())
    run(main())


def test_an_idle_connected_captain_is_passed_over_then_wakes(fast, monkeypatch):
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 0.25)
    monkeypatch.setattr(S, "AWAY_TURN_SECS", 0.08)

    async def main():
        async with Live() as live:
            (a,) = await lobby(live, 1, bots_n=2)
            t0 = time.monotonic()
            assert a.room["turn"] == a.you and a.room["away"] == []
            # a says nothing at all: the tide passes them by…
            await a.until(lambda: a.room["turn"] != a.you, "the turn to pass")
            assert time.monotonic() - t0 >= 0.45            # 2 × 0.25: a first decision
            assert a.you in a.room["away"]
            assert any("away" in line for line in a.room["log"])
            # …the bots play on, and a's later turns pass at the AWAY pace
            await settle(lambda: sum("away" in x for x in game().log) >= 2
                         or game().nonce > 60, "more rounds", 8)
            # any touch at all brings them back to the helm
            await a.error("pass") if game().current.pid != a.you else await a.send("roll")
            await a.until(lambda: a.you not in a.room["away"], "a to wake")
    run(main())


def test_forgetting_end_turn_passes_the_dice_without_marking_away(fast, monkeypatch):
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 0.15)

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            await a.send("roll")
            await a.phase("sail")
            g = game()
            quiet = next(n for n in sorted(g.board.nodes) if g.board.nodes[n]["type"] == "home")
            g.reachable = {quiet: 1}
            await a.send("sail", node=quiet)                 # home port: straight to trade
            await a.phase("trade")
            assert a.room["turn_deadline"] is not None
            await b.until(lambda: b.room["turn"] == b.you, "the dice to pass")
            assert b.room["away"] == []                      # a played; a is not "away"
    run(main())


def test_a_disconnected_captain_does_not_freeze_the_table(fast, monkeypatch):
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 30.0)        # present captains: no rush
    monkeypatch.setattr(S, "GONE_TURN_SECS", 0.25)
    monkeypatch.setenv("DEV_CHEATS", "1")

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            # a drops, comes back inside the grace: nothing is taken from them
            await a.close()
            await b.until(lambda: not b.room["players"][0]["connected"], "a to drop")
            gone_deadline = b.room["turn_deadline"]
            assert gone_deadline < time.time() + 1
            a = await live.cap(token=a.token)
            await asyncio.sleep(0.4)
            assert game().current.pid == a.you and game().phase == "roll"
            assert a.room["turn_deadline"] > time.time() + 20 and not a.room["away"]
            # a starts a FIGHT and vanishes for good, mid-battle
            await dev(a, fight={"kind": "pack", "tier": 0}, battle_mode="mc")
            await a.close()
            t0 = time.monotonic()
            await b.until(lambda: b.room["turn"] == b.you and b.room["phase"] == "roll",
                          "the table to come back to b", timeout=12)
            assert time.monotonic() - t0 >= 0.2
            assert a.you in b.room["away"]
            # b plays a turn; a's NEXT turn is passed at once (already known gone)
            await play_until([b], lambda: game().current.pid == a.you)
            t1 = time.monotonic()
            await b.until(lambda: b.room["turn"] == b.you and b.room["phase"] == "roll",
                          "a's turn to be passed over")
            assert time.monotonic() - t1 < 1.0
            # when a finally returns and acts, they are a captain again
            a = await live.cap(token=a.token)
            await a.error("roll")
            await b.until(lambda: b.room["away"] == [], "a back at the helm")
    run(main())


def test_timed_phases_keep_their_own_clock_unless_away_and_gone(fast, monkeypatch):
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 60.0)
    g, a, b = _question_table()
    g.set_question({"text": "Q?", "options": list("abcd"), "correct": 0},
                   deadline=time.time() + 35)
    seat = object()                                   # stands in for a's live socket
    S.table.sockets[seat] = a
    assert S.idle_deadline() is None                  # present: the question's own 35 s
    S.table.away.add(a)
    assert S.idle_deadline() is None                  # away but connected: the clock the
    S.table.sockets.clear()                           # client draws still stands
    now = time.time()
    assert now <= S.idle_deadline() <= now + S.AUTO_STEP_SECS + 0.5   # away AND gone
    S.table.away.clear()
    assert S.idle_deadline() is None                  # just dropped: give them the 35 s
    # an untimed phase always has a deadline, sized by who is (not) there
    g.timeout_question()
    g.advance_after_reveal()
    assert g.phase == "trade"
    now = time.time()
    assert now + 1 > S.idle_deadline() - S.GONE_TURN_SECS > now - 1
    S.table.sockets[seat] = a
    assert S.idle_deadline() > now + 100              # first decision: 2 × 60 s
    S.table.seen.add(a)
    assert now + 55 < S.idle_deadline() < now + 65
    S.table.away.add(a)
    assert S.idle_deadline() < now + S.AWAY_TURN_SECS + 1


def test_idle_clock_can_be_switched_off(fast, monkeypatch):
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 0.0)
    g, (a, b) = _solo_table()
    assert S.idle_deadline() is None
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 5.0)
    assert S.idle_deadline() is not None


# ════════════════════════════════════════════════════════════════════════════
# timers
# ════════════════════════════════════════════════════════════════════════════
def _question_table(seed=3):
    g, (a, b) = _solo_table(seed=seed)
    shrine = next(n for n, d in g.board.nodes.items()
                  if d["type"] == "shrine" and d.get("charges", 0) > 0)
    _land_on(g, a, shrine)
    g.wager(a, 1)
    return g, a, b


def test_question_timer_survives_an_unrelated_nonce_bump(fast, monkeypatch):
    monkeypatch.setattr(S, "QUESTION_SECS", 0.1)

    async def main():
        g, a, b = _question_table()
        S.after_phase_change()
        await settle(lambda: g.question is not None, "the herald")
        g.nonce += 5              # e.g. the pass carrying the previous captain through
        await settle(lambda: g.phase in ("reveal", "trade"), "the question to time out", 2)
        assert g.reveal["was_correct"] is False and g.reveal["chosen"] == -1
    run(main())


def test_a_stale_timer_cannot_fire_into_a_new_game(fast, monkeypatch):
    monkeypatch.setattr(S, "QUESTION_SECS", 0.1)

    async def main():
        old, a, b = _question_table()
        S.after_phase_change()
        await settle(lambda: old.question is not None, "the herald")
        # the table is reset and a NEW voyage reaches the same phase and nonce
        # before the old question's clock runs out
        monkeypatch.setattr(S, "QUESTION_SECS", 30.0)
        new, a2, b2 = _question_table(seed=4)
        new.nonce = old.nonce
        S.after_phase_change()
        await settle(lambda: new.question is not None, "the new herald")
        await asyncio.sleep(0.3)                           # the old timer's moment
        assert new.phase == "question" and new.question is not None
        assert old.phase == "question"                     # and it touched nothing
    run(main())


def test_reveal_timer_is_armed_once_per_reveal(fast, monkeypatch):
    monkeypatch.setattr(S, "REVEAL_SECS", 0.15)

    async def main():
        g, a, b = _question_table()
        S.after_phase_change()
        await settle(lambda: g.question is not None, "the herald")
        g.answer(a, g.question["correct"])
        for _ in range(6):                    # six rejoins / rival clicks mid-reveal
            S.after_phase_change()
        loop = asyncio.get_running_loop()
        timers = [t for t in S._tasks if t.get_name() == "reveal_timer"
                  and t.get_loop() is loop and not t.done()]
        assert len(timers) == 1
        await settle(lambda: g.phase != "reveal", "the reveal to advance", 2)
        assert g.phase == "trade"
    run(main())


def test_background_tasks_log_and_do_not_vanish(fast, caplog):
    async def main():
        async def boom():
            raise RuntimeError("timer bug")
        t = S.schedule(boom(), "boom")
        assert t in S._tasks                          # referenced while running
        await asyncio.sleep(0.01)
        assert t.done() and t.exception() is None     # swallowed…
        assert t not in S._tasks
    with caplog.at_level("ERROR", logger="thalassa"):
        run(main())
    assert "background task boom died" in caplog.text  # …but never silently


def test_watchdog_and_keeper_survive_their_own_exceptions(fast, monkeypatch, caplog):
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 4:
            raise RuntimeError("tick bug")
        return None
    monkeypatch.setattr(S, "idle_deadline", flaky)
    monkeypatch.setattr(S, "_extras", lambda: {"turn_deadline": None, "away": []})

    async def main():
        async with Live():
            await settle(lambda: calls["n"] >= 8, "the keeper to keep ticking", 3)
    with caplog.at_level("ERROR", logger="thalassa"):
        run(main())
    assert "turn keeper tick failed" in caplog.text


# ════════════════════════════════════════════════════════════════════════════
# the bot driver
# ════════════════════════════════════════════════════════════════════════════
async def _watch_progress(seconds, stall_limit=1.0, until=None):
    """Let the table run; fail if it ever sits still. → (turns, actions):
    turns begun and engine state changes while watching."""
    g = game()
    turns = [0]
    real_start = g._start_turn

    def counting_start():
        turns[0] += 1
        return real_start()
    g._start_turn = counting_start
    end = time.monotonic() + seconds
    first = g.nonce
    last, last_change = (g.nonce, g.phase), time.monotonic()
    try:
        while time.monotonic() < end and g.phase != "finished" \
                and not (until and until()):
            await asyncio.sleep(0.002)
            assert game() is g, "the table was reset under the voyage"
            cur = (g.nonce, g.phase)
            now = time.monotonic()
            if cur != last:
                last, last_change = cur, now
            else:
                assert now - last_change < stall_limit, (
                    f"table stalled {now - last_change:.2f}s in {g.phase} "
                    f"(turn of {g.current.name}, bot={g.current.pid in S.table.bots}, "
                    f"question={g.question is not None}, log={g.log[-2:]})")
    finally:
        del g._start_turn
    return turns[0], g.nonce - first


def _bots_table(n=4, seed=1):
    S.table.reset()
    g = S.table.game = G.Game("THALASSA", seed=seed)
    for i in range(n):
        p = g.add_player(f"bot:{i}", bots.PHILOSOPHERS[i].name, is_bot=True)
        S.table.bots[p.pid] = bots.PHILOSOPHERS[i]
    g.start(g.players[0].pid)
    return g


def _zero_tempo(monkeypatch):
    """Bots think instantly and every animation hold is skipped."""
    monkeypatch.setenv("BATTLE_REVEAL_SECS", "0")
    for name in ("BOT_POLL_SECS", "REVEAL_SECS", "GATE_WALK_SECS", "BOT_TEMPO"):
        monkeypatch.setattr(S, name, 0.0)


@pytest.mark.parametrize("seed", [1])
def test_bots_only_voyage_runs_to_completion(fast, monkeypatch, seed):
    _zero_tempo(monkeypatch)

    async def main():
        async with Live():
            g = _bots_table(4, seed=seed)
            S.table.bot_rng = random.Random(seed)
            turns, actions = await _watch_progress(60, stall_limit=1.0)
            assert g.phase == "finished" and g.winner, (g.phase, turns, actions)
            assert g.player_by_pid(g.winner).banked >= G.RELICS_TO_WIN
            assert all(p.pid in S.table.bots for p in g.players)
    run(main(), timeout=90)


def test_bots_and_one_idle_human_never_stall(fast, monkeypatch):
    _zero_tempo(monkeypatch)
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 0.05)
    monkeypatch.setattr(S, "AWAY_TURN_SECS", 0.02)

    async def main():
        async with Live() as live:
            (a,) = await lobby(live, 1, bots_n=3)         # a never touches anything
            g = game()
            turns, actions = await _watch_progress(1.5)
            assert turns >= 20 and actions >= 60, (turns, actions)
            assert a.you in S.table.away
            human = g.player_by_pid(a.you)
            assert human.node == "home" and human.hull == human.max_hull
            assert not a.closed                           # and still gets the stream
    run(main())


def test_bots_play_on_after_the_host_leaves_then_the_table_resets(fast, monkeypatch):
    _zero_tempo(monkeypatch)
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 5.0)
    monkeypatch.setattr(S, "GONE_TURN_SECS", 0.05)
    monkeypatch.setattr(S, "ABANDON_RESET_SECS", 0.6)

    async def main():
        async with Live() as live:
            (a,) = await lobby(live, 1, bots_n=2)
            g = game()
            await a.close()                               # the only human walks out
            turns, _ = await _watch_progress(0.5)
            assert turns >= 6                             # philosophers sail on alone
            assert not any(p.pid in S.table.bots for p in g.players[:1])  # no bot host
            # …and, nobody having come back, the deserted table resets itself
            await settle(lambda: game() is not g, "the abandoned table to reset", 4)
            assert game().phase == "lobby" and not game().players and not S.table.bots
            b = await live.cap("Newcomer")
            assert b.room["host"] == b.you
    run(main())


def test_a_lobby_of_ghosts_is_swept(fast, monkeypatch):
    monkeypatch.setattr(S, "ABANDON_RESET_SECS", 0.2)

    async def main():
        async with Live() as live:
            caps = await lobby(live, 3, start=False)
            for c in caps:
                await c.close()
            await settle(lambda: not game().players, "the ghost lobby to clear", 4)
    run(main())


def test_a_bot_whose_move_blows_up_still_yields_the_turn(fast, monkeypatch, caplog):
    _zero_tempo(monkeypatch)

    def boom(*_a, **_k):
        raise KeyError("bot bug")
    monkeypatch.setattr(bots, "decide_sail", boom)        # every sail decision dies
    monkeypatch.setattr(bots, "decide_battle", boom)

    async def main():
        async with Live():
            _bots_table(3, seed=2)
            turns, _ = await _watch_progress(0.4)
            assert turns >= 10
    with caplog.at_level("WARNING", logger="thalassa"):
        run(main())
    assert "sail move raised" in caplog.text


def test_a_bot_whose_move_is_refused_still_yields_the_turn(fast, monkeypatch):
    _zero_tempo(monkeypatch)
    monkeypatch.setattr(bots, "decide_sail", lambda *a, **k: "atlantis")
    monkeypatch.setattr(bots, "decide_upgrade", lambda *a, **k: "")

    async def main():
        async with Live():
            _bots_table(3, seed=2)
            turns, _ = await _watch_progress(0.4)
            assert turns >= 10
    run(main())


def test_the_driver_outlives_a_bad_tick_and_a_lost_move(fast, monkeypatch, caplog):
    monkeypatch.setattr(S, "BOT_POLL_SECS", 0.005)
    monkeypatch.setattr(S, "BOT_STUCK_SECS", 0.1)
    real_tick, n = S.bot_tick, {"n": 0}

    def flaky_tick():
        n["n"] += 1
        if n["n"] <= 3:
            raise RuntimeError("driver bug")
        return real_tick()
    monkeypatch.setattr(S, "bot_tick", flaky_tick)

    async def main():
        async with Live():
            g = _bots_table(2, seed=3)
            # the bot's move task is "lost": marked as sent, never run
            S.table.acted.add((g.nonce, g.phase))
            nonce = g.nonce
            await settle(lambda: g.nonce != nonce, "the stuck bot to be freed", 3)
            await _watch_progress(0.3)
    with caplog.at_level("WARNING", logger="thalassa"):
        run(main())
    assert "bot driver tick failed" in caplog.text
    assert "stuck" in caplog.text


def test_every_engine_phase_has_a_driver(fast):
    """A phase added to game.py with no bot move and no idle default would be
    a place the table can freeze. Fail loudly when one appears."""
    import inspect
    import re
    src = inspect.getsource(G)
    phases = set(re.findall(r'_bump\("(\w+)"\)', src)) | {"lobby"}
    handled = S.BOT_PHASES | {"lobby", "finished", "reveal"}
    assert phases <= handled, f"phases with no driver: {phases - handled}"
    # and each of them has a branch in the bot's turn AND the idle default
    for fn in (S._bot_turn, S.idle_step):
        body = inspect.getsource(fn)
        for ph in S.BOT_PHASES:
            assert f'"{ph}"' in body, f"{fn.__name__} has no branch for {ph}"


@slow
@pytest.mark.parametrize("seed", range(20, 32))
def test_many_bots_only_voyages_run_to_completion(fast, monkeypatch, seed):
    _zero_tempo(monkeypatch)

    async def main():
        async with Live():
            g = _bots_table(2 + seed % 5, seed=seed)
            S.table.bot_rng = random.Random(seed)
            await _watch_progress(600, stall_limit=2.0)
            assert g.phase == "finished" and g.winner
    run(main(), timeout=700)


@slow
@pytest.mark.parametrize("gone", [False, True])
def test_bots_and_an_idle_human_voyage_runs_to_completion(fast, monkeypatch, gone):
    """One human who never acts — sitting there (gone=False) or disconnected
    for good (gone=True) — and three philosophers: the voyage still ends."""
    _zero_tempo(monkeypatch)
    monkeypatch.setattr(S, "IDLE_TURN_SECS", 0.02)
    monkeypatch.setattr(S, "AWAY_TURN_SECS", 0.005)
    monkeypatch.setattr(S, "GONE_TURN_SECS", 0.02)

    async def main():
        async with Live() as live:
            (a,) = await lobby(live, 1, bots_n=3)
            g = game()
            if gone:
                await a.close()
            await _watch_progress(600, stall_limit=2.0)
            assert g.phase == "finished" and g.winner != a.you
    run(main(), timeout=700)


# ════════════════════════════════════════════════════════════════════════════
# snapshots, health, deploy hygiene
# ════════════════════════════════════════════════════════════════════════════
def test_snapshot_is_built_once_per_distinct_viewer(fast, monkeypatch):
    builds = []
    real = G.Game.to_dict
    monkeypatch.setattr(G.Game, "to_dict",
                        lambda self, v=None: builds.append(v) or real(self, v))

    async def main():
        async with Live() as live:
            a, b = await lobby(live, 2)
            tab = await live.cap(token=a.token)           # a's second tab
            w1, w2, w3 = [await live.cap() for _ in range(3)]   # three watchers
            assert w1.you is None
            builds.clear()
            await S.broadcast()
            assert sorted(builds, key=str) == sorted([a.you, b.you, None], key=str)
            n = w3.snaps
            await S.broadcast()
            await w3.until(lambda: w3.snaps > n, "the watcher's frame")
            size = len(json.dumps(w3.room))
            assert size < 150_000, size                   # one frame stays small
            assert tab.room["players"] == a.room["players"]
    run(main())


def test_healthz_is_cheap_and_startup_uses_lifespan(fast):
    assert not S.app.router.on_startup and not S.app.router.on_shutdown

    async def main():
        async with Live() as live:
            await lobby(live, 2, bots_n=1)
            t = time.perf_counter()
            status, body = await live.get("/healthz")
            assert status == 200 and time.perf_counter() - t < 0.5
            assert body["ok"] is True and body["phase"] == "roll"
            assert body["players"] == 3 and body["bots"] == 1
            assert set(body["questions"]) == set(questions.TRIVIA)
            names = {t.get_name() for t in S._tasks}
            assert {"bot_driver", "phase_watchdog", "turn_keeper",
                    "abandoned_game_reset"} <= names
        # …and the lifespan's exit stopped every loop it started
        await asyncio.sleep(0)
        loop = asyncio.get_running_loop()
        assert not [t for t in S._tasks if t.get_loop() is loop and not t.done()]
    run(main())


def test_dev_panel_code_can_be_switched_off(fast, monkeypatch):
    async def main():
        g, (a, b) = _solo_table()
        monkeypatch.setattr(S, "DEV_CODE", "")
        assert "Unknown" in await S.dispatch(a, "dev", {"code": "783", "win": True})
        assert "Unknown" in await S.dispatch(a, "dev", {"code": "", "win": True})
        assert g.winner is None
        monkeypatch.setattr(S, "DEV_CODE", "783")
        # a watcher (no seat) can never use the hook, even with the code
        assert "Join" in await S.dispatch(None, "dev", {"code": "783", "autowalk": False})
        assert g.no_autowalk is False
        assert await S.dispatch(a, "dev", {"code": "783", "win": True}) is None
        assert g.winner == a
    run(main())


def test_env_defaults_and_a_typo_in_the_environment(tmp_path):
    """The idle clock is ON by default, OFF on DEV_CHEATS rigs (which park on
    a phase for minutes) unless asked for, and a mistyped number in the
    environment must not stop the server from booting."""
    import subprocess
    import sys
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    probe = ("import server as S; print(S.IDLE_TURN_SECS, S.GONE_TURN_SECS, "
             "S.AWAY_TURN_SECS, S.QUESTION_SECS, S.DEV_CODE)")

    def boot(**env):
        base = {k: v for k, v in os.environ.items()
                if k not in ("DEV_CHEATS", "IDLE_TURN_SECS", "GONE_TURN_SECS",
                             "AWAY_TURN_SECS", "QUESTION_SECS", "DEV_CODE")}
        out = subprocess.run([sys.executable, "-W", "error::DeprecationWarning",
                              "-c", probe], cwd=root, env={**base, **env},
                             capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        return out.stdout.split()

    assert boot() == ["120.0", "30.0", "20.0", "50.0", "783"]
    assert boot(DEV_CHEATS="1")[0] == "0.0"
    assert boot(DEV_CHEATS="1", IDLE_TURN_SECS="45")[0] == "45.0"
    assert boot(QUESTION_SECS="thirty", IDLE_TURN_SECS="", DEV_CODE="")[:4] == \
        ["120.0", "30.0", "20.0", "50.0"]


# ════════════════════════════════════════════════════════════════════════════
# answer clocks start when the card can be SEEN (playtest H3) — and are
# generous (no reflexes)
# ════════════════════════════════════════════════════════════════════════════
def test_answer_clocks_are_generous():
    """Nothing in the game may reward fast reflexes: every answer clock is a
    generous backstop, never the challenge."""
    import server as S2
    assert S2.QUESTION_SECS >= 45 or os.environ.get("QUESTION_SECS")
    assert S2.JEOPARDY_SECS >= 45 and S2.JCHOOSE_SECS >= 45
    assert S2.EVENT_TABLE_SECS >= 60
    for kind, limit in puzzles.TIME_LIMITS.items():
        assert limit is None or limit >= 45, kind
    assert puzzles.TET4_LIMIT >= 45
    for tier in (1, 2, 3):
        rng = random.Random(tier)
        for _ in range(60):
            d = puzzles.deal_battle(rng, tier, set())
            assert d["limit"] is None or d["limit"] >= 45, d["kind"]


def test_question_clock_carries_the_arrival_allowance_until_shown(fast, monkeypatch):
    monkeypatch.setattr(S, "QUESTION_SECS", 30.0)
    monkeypatch.setattr(S, "SHOWN_ALLOW_SECS", 12.0)

    async def main():
        g, a, b = _question_table()
        S.after_phase_change()
        await settle(lambda: g.question is not None, "the herald")
        armed = g.question_deadline
        # the ship may still be sailing in: limit + allowance
        assert 41.0 < armed - time.time() <= 42.1
        # a rival's report (another stage, no arrival seen) changes nothing
        assert S.card_shown(b, "question") is False
        assert g.question_deadline == armed
        # a report about some other card changes nothing either
        assert S.card_shown(a, "minigame") is False
        # the actor's card is on screen: the plain limit, from now
        n0 = g.nonce
        assert S.card_shown(a, "question") is True
        assert 29.0 < g.question_deadline - time.time() <= 30.1
        assert g.nonce > n0                    # the new clock is broadcast
        # once per card
        again = g.question_deadline
        assert S.card_shown(a, "question") is False
        assert g.question_deadline == again
    run(main())


def test_a_silent_client_holds_the_table_only_for_the_allowance(fast, monkeypatch):
    monkeypatch.setattr(S, "QUESTION_SECS", 0.1)
    monkeypatch.setattr(S, "SHOWN_ALLOW_SECS", 0.3)

    async def main():
        g, a, b = _question_table()
        S.after_phase_change()
        await settle(lambda: g.question is not None, "the herald")
        t0 = time.monotonic()
        await settle(lambda: g.phase in ("reveal", "trade"), "the timeout", 3)
        assert time.monotonic() - t0 >= 0.3          # it waited the allowance…
        assert g.reveal["chosen"] == -1              # …then timed out
    run(main())


def test_the_timer_follows_a_clock_restarted_by_shown(fast, monkeypatch):
    monkeypatch.setattr(S, "QUESTION_SECS", 0.2)
    monkeypatch.setattr(S, "SHOWN_ALLOW_SECS", 30.0)

    async def main():
        g, a, b = _question_table()
        S.after_phase_change()
        await settle(lambda: g.question is not None, "the herald")
        assert S.card_shown(a, "question") is True
        # the sleeping timer re-reads the moved deadline (not limit+allowance)
        await settle(lambda: g.phase in ("reveal", "trade"), "the timeout", 3)
        assert g.reveal["chosen"] == -1
    run(main())


def test_shown_over_the_socket_starts_the_clock_without_waking_away(fast, monkeypatch):
    monkeypatch.setattr(S, "SHOWN_ALLOW_SECS", 15.0)

    async def main():
        g, (a, b) = _solo_table()
        spire = next(n for n, d in g.board.nodes.items()
                     if d["type"] == "puzzle" and not d.get("solved"))
        # force an interactive, clocked puzzle at the spire
        monkeypatch.setattr(puzzles, "deal",
                            lambda rng, used: puzzles.deal_kind(rng, "ravens"))
        _land_on(g, a, spire)
        assert g.phase == "minigame"
        S.after_phase_change()
        limit = g.minigame["limit"]
        assert limit >= 45
        assert abs(g.minigame["deadline"] - (time.time() + limit + 15.0)) < 1.0
        S.table.away.add(a)
        ws = object()
        S.table.sockets[ws] = a
        try:
            await S._handle(ws, {"type": "shown", "what": "minigame"})
        finally:
            S.table.sockets.pop(ws, None)
        assert abs(g.minigame["deadline"] - (time.time() + limit)) < 1.0
        assert a in S.table.away          # an automatic report is not an action
    run(main())


def test_jchoose_clock_takes_the_allowance(fast, monkeypatch):
    monkeypatch.setattr(S, "JCHOOSE_SECS", 45.0)
    monkeypatch.setattr(S, "SHOWN_ALLOW_SECS", 10.0)

    async def main():
        g, (a, b) = _solo_table()
        g.jboard = {"band": "low", "node": "home", "cells": []}
        g.phase = "jchoose"
        g.jchoose_deadline = None
        S.after_phase_change()
        assert 54.0 < g.jchoose_deadline - time.time() <= 55.1
        assert S.card_shown(a, "jchoose") is True
        assert 44.0 < g.jchoose_deadline - time.time() <= 45.1
    run(main())


def test_a_reload_peek_reclaims_a_seat_but_never_takes_one(fast, monkeypatch):
    """X2: a page reload says hello with rejoin=True — it silently reclaims
    the captain's own seat, and never seats a stranger in the lobby."""
    async def quiet(*a, **k):
        return True
    monkeypatch.setattr(S, "broadcast", quiet)
    monkeypatch.setattr(S, "_send", quiet)

    async def main():
        g = S.table.game
        ws1, ws2 = object(), object()
        try:
            await S._hello(ws1, {"type": "hello", "token": "tok-a", "name": "Ann",
                                 "rejoin": True})
            assert S.table.sockets[ws1] is None and not g.players   # a watcher
            await S._hello(ws1, {"type": "hello", "token": "tok-a", "name": "Ann"})
            pid = S.table.sockets[ws1]
            assert pid and g.player_by_pid(pid).name == "Ann"
            await S._hello(ws2, {"type": "hello", "token": "tok-a", "name": "Ann",
                                 "rejoin": True})
            assert S.table.sockets[ws2] == pid                      # the same seat
            assert len(g.players) == 1
        finally:
            S.table.sockets.pop(ws1, None)
            S.table.sockets.pop(ws2, None)
    run(main())

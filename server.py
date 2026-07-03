"""
Thalassa server — one shared game, WebSockets, and the orchestration
around game.py.

FastAPI + native WebSockets, one process, ONE game: everyone who opens the
site lands in the same voyage. The first player to join is the host. The
engine (game.py) owns the rules; this file owns IO: dice RNG, question
fetching (questions.py), phase timers, broadcast.

    GET  /              → the app (static/index.html)
    GET  /healthz       → ok (health check)
    WS   /ws            → game protocol (JSON messages)

Client → server: hello{token,name} · start · roll · sail{node} · wager{tier}
                 · trial · oracle · claim{domains[3]} · trade{give,get}
                 · build{kind} · pass · answer{idx} · vote{domain}
                 · skip · kick{pid} · rematch · ping
Server → client: snapshot{you,room} · dice{pid,d1,d2} · error{msg} · pong

If the table empties out mid-game it resets to a fresh lobby after a grace
period, so a finished or abandoned voyage never blocks new players.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from game import Game, GameError
from questions import QuestionBank

BASE = os.path.dirname(os.path.abspath(__file__))
QUESTION_SECS = float(os.environ.get("QUESTION_SECS", "35"))
REVEAL_SECS = float(os.environ.get("REVEAL_SECS", "5"))
VOTE_SECS = float(os.environ.get("VOTE_SECS", "25"))
ABANDON_RESET_SECS = float(os.environ.get("ABANDON_RESET_SECS", "300"))


class Table:
    """The single shared game and its connections."""

    def __init__(self):
        self.game = Game("THALASSA")
        self.sockets: dict[WebSocket, str | None] = {}   # ws → pid (None = spectator)
        self.last_active = time.monotonic()

    def touch(self):
        self.last_active = time.monotonic()

    def reset(self):
        self.game = Game("THALASSA")
        for ws in self.sockets:
            self.sockets[ws] = None      # everyone rejoins via a fresh hello


table = Table()
bank = QuestionBank()
app = FastAPI(title="Thalassa")


# ── broadcast / snapshots ─────────────────────────────────────────────────────
async def _send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False


async def broadcast():
    snap = table.game.to_dict()
    dead = []
    for ws, pid in list(table.sockets.items()):
        if not await _send(ws, {"type": "snapshot", "you": pid, "room": snap}):
            dead.append(ws)
    for ws in dead:
        await _drop_socket(ws)


async def broadcast_event(payload: dict):
    for ws in list(table.sockets):
        await _send(ws, payload)


async def _drop_socket(ws: WebSocket):
    pid = table.sockets.pop(ws, None)
    if pid and pid not in table.sockets.values():
        p = table.game.player_by_pid(pid)
        if p:
            p.connected = False
            await broadcast()


# ── phase timers (all guarded by the game nonce) ─────────────────────────────
def schedule(coro):
    asyncio.get_running_loop().create_task(coro)


async def fetch_question(nonce: int):
    g = table.game
    if g.qctx is None:
        return
    q = await bank.get(g.qctx["domain"], g.qctx["tier"])
    if g.nonce == nonce and g.phase == "question" and g.question is None:
        g.set_question(q, deadline=time.time() + QUESTION_SECS)
        schedule(question_timer(g.nonce))
        await broadcast()


async def question_timer(nonce: int):
    await asyncio.sleep(QUESTION_SECS + 1)
    g = table.game
    if g.nonce == nonce and g.phase == "question":
        g.timeout_question()
        await broadcast()
        if g.phase == "reveal":
            schedule(reveal_timer(g.nonce))


async def reveal_timer(nonce: int):
    await asyncio.sleep(REVEAL_SECS)
    g = table.game
    if g.nonce == nonce and g.phase == "reveal":
        g.advance_after_reveal()
        await broadcast()
        after_phase_change()


async def vote_timer(nonce: int):
    await asyncio.sleep(VOTE_SECS)
    g = table.game
    if g.nonce == nonce and g.phase == "symposium_vote":
        await finish_vote()


async def finish_vote():
    g = table.game
    g.tally_votes(secrets.randbelow(4))
    await broadcast()
    schedule(fetch_question(g.nonce))


def after_phase_change():
    """Kick off whatever the new phase demands (question fetch, vote timer)."""
    g = table.game
    if g.phase == "question" and g.question is None:
        schedule(fetch_question(g.nonce))
    elif g.phase == "symposium_vote":
        schedule(vote_timer(g.nonce))


# ── HTTP ─────────────────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz():
    return {"ok": True, "phase": table.game.phase,
            "players": len(table.game.players), "questions": bank.counts()}


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))


app.mount("/static", StaticFiles(directory=os.path.join(BASE, "static")), name="static")


# ── WebSocket protocol ───────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    pid: str | None = None
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            g = table.game
            table.touch()

            if kind == "ping":
                await _send(ws, {"type": "pong"})
                continue

            if kind == "hello":
                token = str(msg.get("token", ""))[:64]
                existing = g.player_by_token(token) if token else None
                if existing:
                    pid = existing.pid
                    existing.connected = True
                elif g.phase == "lobby":
                    try:
                        pid = g.add_player(token, str(msg.get("name", ""))).pid
                    except GameError as e:
                        await _send(ws, {"type": "error", "msg": str(e)})
                        pid = None       # table full → stay as spectator
                # else: game in progress → spectator
                table.sockets[ws] = pid
                await broadcast()
                continue

            if ws not in table.sockets:
                await _send(ws, {"type": "error", "msg": "Say hello first."})
                continue

            try:
                if kind == "start":
                    g.start(pid)
                    await broadcast()
                elif kind == "roll":
                    d1, d2 = secrets.randbelow(6) + 1, secrets.randbelow(6) + 1
                    g.roll(pid, d1, d2)
                    await broadcast_event({"type": "dice", "pid": pid, "d1": d1, "d2": d2})
                    await broadcast()
                elif kind == "sail":
                    g.sail(pid, str(msg.get("node", "")))
                    await broadcast()
                    after_phase_change()
                elif kind == "wager":
                    g.wager(pid, int(msg.get("tier", 0)))
                    await broadcast()
                    after_phase_change()
                elif kind == "trial":
                    g.trial(pid)
                    await broadcast()
                    after_phase_change()
                elif kind == "oracle":
                    g.oracle_accept(pid)
                    await broadcast()
                    after_phase_change()
                elif kind == "claim":
                    doms = [str(d) for d in (msg.get("domains") or [])]
                    g.oracle_claim(pid, doms)
                    await broadcast()
                elif kind == "trade":
                    g.trade(pid, str(msg.get("give", "")), str(msg.get("get", "")))
                    await broadcast()
                elif kind == "build":
                    g.build(pid, str(msg.get("kind", "")))
                    await broadcast()
                elif kind == "pass":
                    g.pass_turn(pid)
                    await broadcast()
                elif kind == "answer":
                    g.answer(pid, int(msg.get("idx", -1)))
                    await broadcast()
                    if g.phase == "reveal":
                        schedule(reveal_timer(g.nonce))
                elif kind == "vote":
                    g.vote_domain(pid, str(msg.get("domain", "")))
                    if g.all_votes_in():
                        await finish_vote()
                    else:
                        await broadcast()
                elif kind == "skip":
                    g.skip_turn(pid)
                    await broadcast()
                elif kind == "kick":
                    g.remove_player(pid, str(msg.get("pid", "")))
                    await broadcast()
                elif kind == "rematch":
                    g.rematch(pid)
                    await broadcast()
                else:
                    await _send(ws, {"type": "error", "msg": f"Unknown message: {kind}"})
            except GameError as e:
                await _send(ws, {"type": "error", "msg": str(e)})
            except (TypeError, ValueError):
                await _send(ws, {"type": "error", "msg": "Malformed message."})
    except WebSocketDisconnect:
        pass
    finally:
        await _drop_socket(ws)


# ── background upkeep ────────────────────────────────────────────────────────
async def abandoned_game_reset():
    """A deserted mid-game table goes back to a fresh lobby so the single
    shared game can never get stuck for the next visitors."""
    while True:
        await asyncio.sleep(30)
        g = table.game
        if g.phase == "lobby":
            continue
        anyone_here = any(pid for pid in table.sockets.values())
        idle = time.monotonic() - table.last_active
        if not anyone_here and idle > ABANDON_RESET_SECS:
            table.reset()
            await broadcast()


@app.on_event("startup")
async def startup():
    schedule(bank.refill_loop())
    schedule(abandoned_game_reset())

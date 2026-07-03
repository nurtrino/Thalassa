"""
Thalassa server — one shared game, WebSockets, and the orchestration
around game.py.

FastAPI + native WebSockets, one process, ONE game: everyone who opens the
site lands in the same voyage. The first player to join is the host. The
engine (game.py) owns the rules; this file owns IO: dice RNG, question
fetching (questions.py), phase timers, bots (bots.py), broadcast.

    GET  /              → the app (static/index.html)
    GET  /healthz       → ok (health check)
    WS   /ws            → game protocol (JSON messages)

Client → server: hello{token,name} · add_bot · start · roll · sail{node}
                 · wager{tier} · trial · oracle · claim{domains[3]}
                 · trade{give,get} · build{kind} · pass · answer{idx}
                 · vote{domain} · skip · kick{pid} · rematch · ping
Server → client: snapshot{you,room} · dice{pid,d1,d2} · error{msg} · pong

Bot captains (added from the lobby by the host) are ordinary players in the
engine; a background driver watches the game and plays their turns with
human-ish delays. If the table empties out mid-game it resets to a fresh
lobby after a grace period.
"""
from __future__ import annotations

import asyncio
import os
import random
import secrets
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import bots
from game import Game, GameError
from questions import QuestionBank

BASE = os.path.dirname(os.path.abspath(__file__))
QUESTION_SECS = float(os.environ.get("QUESTION_SECS", "35"))
REVEAL_SECS = float(os.environ.get("REVEAL_SECS", "5"))
VOTE_SECS = float(os.environ.get("VOTE_SECS", "25"))
ABANDON_RESET_SECS = float(os.environ.get("ABANDON_RESET_SECS", "300"))
BOT_TEMPO = float(os.environ.get("BOT_TEMPO", "1.0"))   # scale bot thinking time


class Table:
    """The single shared game and its connections."""

    def __init__(self):
        self.game = Game("THALASSA")
        self.sockets: dict[WebSocket, str | None] = {}   # ws → pid (None = spectator)
        self.bots: dict[str, bots.Skill] = {}            # pid → skill
        self.bot_rng = random.Random()
        self.acted: set[tuple] = set()                   # (nonce, tag) bot dedupe
        self.last_active = time.monotonic()

    def touch(self):
        self.last_active = time.monotonic()

    def reset(self):
        self.game = Game("THALASSA")
        self.bots = {}
        self.acted = set()
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


# ── shared action dispatch (humans over WS, bots from the driver) ───────────
async def dispatch(pid: str | None, kind: str, msg: dict) -> str | None:
    """Apply one game action. Returns an error string, or None on success."""
    g = table.game
    try:
        if kind == "start":
            g.start(pid)
            await broadcast()
        elif kind == "add_bot":
            if not g.players or g.players[0].pid != pid:
                raise GameError("Only the host can invite philosophers.")
            taken = {table.bots[b].name for b in table.bots}
            free = [s for s in bots.PHILOSOPHERS if s.name not in taken]
            if not free:
                raise GameError("Every philosopher is already aboard.")
            skill = table.bot_rng.choice(free[:3])
            p = g.add_player(f"bot:{secrets.token_hex(4)}", skill.name, is_bot=True)
            table.bots[p.pid] = skill
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
            table.bots = {b: s for b, s in table.bots.items()
                          if g.player_by_pid(b) is not None}
            await broadcast()
        elif kind == "rematch":
            g.rematch(pid)
            await broadcast()
        else:
            return f"Unknown message: {kind}"
    except GameError as e:
        return str(e)
    except (TypeError, ValueError):
        return "Malformed message."
    return None


# ── bot driver ───────────────────────────────────────────────────────────────
def _bot_delay(phase: str) -> float:
    base = {"roll": 1.1, "sail": 1.6, "island": 1.3, "question": 3.5,
            "oracle_claim": 1.2, "vote": 1.5}.get(phase, 1.0)
    return (base + table.bot_rng.random() * base * 0.8) * BOT_TEMPO


async def bot_move(nonce: int, tag: str, pid: str):
    """One bot action, delayed to feel human, nonce-guarded like the timers."""
    g = table.game
    phase = g.phase
    await asyncio.sleep(_bot_delay(tag if tag == "vote" else phase))
    if table.game is not g or g.nonce != nonce:
        return                                    # world moved on while thinking
    rng = table.bot_rng
    skill = table.bots.get(pid)
    if skill is None:
        return
    err = None
    if phase == "roll":
        err = await dispatch(pid, "roll", {})
    elif phase == "sail":
        node = bots.decide_sail(g, pid, rng)
        err = await dispatch(pid, "sail", {"node": node}) if node else "no move"
    elif phase == "island":
        kind, payload = bots.decide_island(g, pid, skill, rng)
        err = await dispatch(pid, kind, payload)
        if err:                                   # belt & braces: never stall a turn
            err = await dispatch(pid, "pass", {})
    elif phase == "question":
        idx = bots.decide_answer(g, skill, rng)
        err = await dispatch(pid, "answer", {"idx": idx})
    elif phase == "oracle_claim":
        err = await dispatch(pid, "claim", {"domains": bots.decide_claim(g, pid)})
    elif phase == "symposium_vote":
        err = await dispatch(pid, "vote", {"domain": bots.decide_vote(g, rng)})
    if err:
        print(f"[bot {pid}] {phase}: {err}")


async def bot_driver():
    """Watch the game; whenever a bot owes an action, schedule it exactly once."""
    while True:
        await asyncio.sleep(0.5)
        g = table.game
        if g.phase in ("lobby", "finished") or not table.bots:
            table.acted.clear()
            continue
        if len(table.acted) > 512:
            table.acted = {k for k in table.acted if k[0] >= g.nonce}

        if g.phase == "symposium_vote":
            for p in g.players:
                if (p.pid in table.bots and p.pid != g.current.pid
                        and p.pid not in g.votes):
                    key = (g.nonce, f"vote:{p.pid}")
                    if key not in table.acted:
                        table.acted.add(key)
                        schedule(bot_move(g.nonce, "vote", p.pid))
            continue
        if g.phase == "oracle_claim" and g.oracle_claim_due in table.bots:
            key = (g.nonce, "claim")
            if key not in table.acted:
                table.acted.add(key)
                schedule(bot_move(g.nonce, "claim", g.oracle_claim_due))
            continue
        if g.players and g.current.pid in table.bots \
                and g.phase in ("roll", "sail", "island", "question"):
            if g.phase == "question" and g.question is None:
                continue                          # wait for the fetch
            key = (g.nonce, g.phase)
            if key not in table.acted:
                table.acted.add(key)
                schedule(bot_move(g.nonce, g.phase, g.current.pid))


# ── HTTP ─────────────────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz():
    return {"ok": True, "phase": table.game.phase,
            "players": len(table.game.players), "bots": len(table.bots),
            "questions": bank.counts()}


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

            err = await dispatch(pid, kind, msg)
            if err:
                await _send(ws, {"type": "error", "msg": err})
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
    schedule(bot_driver())
    schedule(abandoned_game_reset())

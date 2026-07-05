"""
Thalassa server — one shared voyage, WebSockets, and the orchestration
around game.py (the Race for the Golden Fleece).

FastAPI + native WebSockets, one process, ONE game: everyone who opens the
site lands in the same voyage. The first player to join is the host. The
engine (game.py) owns the rules; this file owns IO: dice RNG, question
fetching (questions.py), puzzle/battle timers, bots, and PER-VIEWER
snapshots (each captain gets their own reachable-stops view).

    GET  /              → the app (static/index.html)
    GET  /healthz       → ok (health check)
    WS   /ws            → game protocol (JSON messages)

Client → server: hello{token,name} · add_bot · start · roll · sail{node}
                 · wager{tier} · pass · repair · shop_buy{item} · use{item}
                 · stance{stance,target} · flee · item{id}
                 · answer{idx} (turn OR side answer) · pick{upgrade}
                 · solve{payload} (minigame) · skip · kick{pid} · rematch · ping
Server → client: snapshot{you,room} · dice{pid,value} · error{msg} · pong
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
import questions
from game import DODGE_SECS, Game, GameError
from questions import QuestionBank, TriviaAPIBank

BASE = os.path.dirname(os.path.abspath(__file__))
QUESTION_SECS = float(os.environ.get("QUESTION_SECS", "35"))
JEOPARDY_SECS = float(os.environ.get("JEOPARDY_SECS", "15"))   # typed clues
REVEAL_SECS = float(os.environ.get("REVEAL_SECS", "5"))
ABANDON_RESET_SECS = float(os.environ.get("ABANDON_RESET_SECS", "300"))
BOT_TEMPO = float(os.environ.get("BOT_TEMPO", "1.0"))


class Table:
    """The single shared game and its connections."""

    def __init__(self):
        self.game = Game("THALASSA")
        self.sockets: dict[WebSocket, str | None] = {}   # ws → pid (None = spectator)
        self.bots: dict[str, bots.Skill] = {}
        self.bot_rng = random.Random()
        self.acted: set[tuple] = set()
        self.last_active = time.monotonic()

    def touch(self):
        self.last_active = time.monotonic()

    def reset(self):
        self.game = Game("THALASSA")
        self.bots = {}
        self.acted = set()
        for ws in self.sockets:
            self.sockets[ws] = None


table = Table()
bank = QuestionBank()          # temples: themed by domain
trivia_bank = TriviaAPIBank()  # battles: live The Trivia API, buffered offline-safe
app = FastAPI(title="Thalassa")


# ── broadcast (per-viewer snapshots — reachable stops are personal) ──────────
async def _send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False


async def broadcast():
    dead = []
    for ws, pid in list(table.sockets.items()):
        snap = table.game.to_dict(pid)
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
    pending = g.needs_puzzle()
    mode = g.qctx.get("mode")
    if pending is not None:
        limit = pending.get("limit", 60)
        q = pending
    elif mode == "jeopardy":                 # typed clue, 15s on the clock
        limit = JEOPARDY_SECS
        q = questions.jeopardy_pick(g.rng)
    elif mode == "mc":                        # battle MC — live Trivia API (buffered)
        limit = QUESTION_SECS
        q = trivia_bank.get()
    else:                                     # temples: themed by domain
        limit = QUESTION_SECS
        q = await bank.get(g.qctx["domain"], g.qctx["tier"])
    if g.nonce == nonce and g.phase == "question" and g.question is None:
        g.set_question(q, deadline=time.time() + limit)
        schedule(question_timer(g.nonce, limit))
        await broadcast()


async def question_timer(nonce: int, limit: float):
    await asyncio.sleep(limit + 1)
    g = table.game
    if g.nonce == nonce and g.phase == "question":
        g.timeout_question()
        await broadcast()
        if g.phase == "reveal":
            schedule(reveal_timer(g.nonce))


async def reveal_timer(nonce: int):
    g = table.game
    # battle reveals are snappy — the card flashes the answer then clears so
    # the diorama plays your move and the enemy's, and the next stance is
    # quick to arrive. But a battle that ENDS (a kill, or your shipwreck) gets a
    # long hold so the final blow lands and the VICTORY / YOU DIED screen reads
    # before we cut away. Shrine/puzzle reveals get the full reading window.
    rv = g.reveal or {}
    if rv.get("kind") == "battle":
        dur = 5.6 if rv.get("battle_over") else 3.4
    else:
        dur = REVEAL_SECS
    await asyncio.sleep(dur)
    g = table.game
    if g.nonce == nonce and g.phase == "reveal":
        g.advance_after_reveal()
        after_phase_change()
        await broadcast()


async def minigame_timer(nonce: int, limit: float):
    await asyncio.sleep(limit + 1)
    g = table.game
    if g.nonce == nonce and g.phase == "minigame":
        g.minigame_timeout()
        after_phase_change()          # a timed-out puzzle-battle → arm the reveal timer
        await broadcast()


async def dodge_timer(nonce: int, limit: float):
    await asyncio.sleep(limit + 0.5)
    g = table.game
    if g.nonce == nonce and g.phase == "dodge":
        g.dodge_timeout()             # frozen at the tiller — the blow lands full
        after_phase_change()
        await broadcast()


def after_phase_change():
    """Kick off whatever the new phase demands (fetches, timers)."""
    g = table.game
    if g.phase == "question" and g.question is None:
        schedule(fetch_question(g.nonce))
    elif g.phase == "minigame" and g.minigame and g.minigame["deadline"] is None:
        limit = g.minigame["limit"]
        if limit:                            # simon runs without a clock
            g.minigame["deadline"] = time.time() + limit
            schedule(minigame_timer(g.nonce, limit))
    elif g.phase == "dodge" and g.dodge_deadline is None:
        g.dodge_deadline = time.time() + DODGE_SECS
        schedule(dodge_timer(g.nonce, DODGE_SECS))
    elif g.phase == "reveal":
        # ANY path into a reveal must arm the timer that advances it — trivia
        # answers, puzzle-battle solves, timeouts, all of it. Missing this on the
        # puzzle-solve path froze the battle after the enemy's blow. The nonce
        # guard makes a duplicate schedule a harmless no-op.
        schedule(reveal_timer(g.nonce))


# ── shared action dispatch (humans over WS, bots from the driver) ───────────
async def dispatch(pid: str | None, kind: str, msg: dict) -> str | None:
    g = table.game
    try:
        if kind == "start":
            g.start(pid)
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
        elif kind == "roll":
            die = secrets.randbelow(3) + 1       # a d3: close-quarters sailing
            p = g.player_by_pid(pid)
            if p and p.has("star_chart"):        # roll two, sail with the higher
                die = max(die, secrets.randbelow(3) + 1)
            g.roll(pid, die)
            await broadcast_event({"type": "dice", "pid": pid, "value": die})
        elif kind == "sail":
            g.sail(pid, str(msg.get("node", "")))
        elif kind == "walk":
            g.walk_step(pid, str(msg.get("node", "")))
        elif kind == "wager":
            g.wager(pid, int(msg.get("tier", 0)))
        elif kind == "pass":
            g.pass_turn(pid)
        elif kind == "pharos_enter":
            g.enter_pharos(pid)
        elif kind == "repair":
            g.repair(pid)
        elif kind == "shop_buy":
            g.shop_buy(pid, str(msg.get("item", "")))
        elif kind == "use":
            g.use_item_charm(pid, str(msg.get("item", "")))
        elif kind == "stance":
            g.stance(pid, str(msg.get("stance", "")), int(msg.get("target", 0)))
        elif kind == "dodge":
            g.dodge(pid, bool(msg.get("hit")))
        elif kind == "flee":
            g.flee(pid)
        elif kind == "item":
            g.use_item(pid, str(msg.get("id", "")))
            if g.question is None:                    # lyre swapped the question
                schedule(fetch_question(g.nonce))
        elif kind == "answer":
            idx = int(msg.get("idx", -1))
            if g.phase == "question" and g.players and g.current.pid != pid:
                g.side_answer(pid, idx)
            else:
                g.answer(pid, idx)   # → reveal timer armed by after_phase_change
        elif kind == "answer_text":
            g.answer_text(pid, str(msg.get("text", "")))   # typed Jeopardy clue
        elif kind == "solve":
            g.minigame_submit(pid, msg.get("payload"))
        elif kind == "pick":
            g.pick_upgrade(pid, str(msg.get("upgrade", "")))
        elif kind == "skip":
            g.skip_turn(pid)
        elif kind == "kick":
            g.remove_player(pid, str(msg.get("pid", "")))
            table.bots = {b: s for b, s in table.bots.items()
                          if g.player_by_pid(b) is not None}
        elif kind == "rematch":
            g.rematch(pid)
        elif kind == "dev" and (os.environ.get("DEV_CHEATS") == "1"
                                or str(msg.get("code")) == "783"):
            # dev teleport — the test harness (DEV_CHEATS) or the in-game dev
            # panel (unlocked with code 783): teleport-and-(maybe)-land
            p = g.player_by_pid(pid)
            if p and msg.get("win"):           # force the curtain call
                g.winner = p.pid
                g._bump("finished")
            if msg.get("battle_mode"):         # force the next battle round's deck
                g._force_mode = str(msg["battle_mode"])
            node = str(msg.get("node", ""))
            region = msg.get("region")
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
            return f"Unknown message: {kind}"
    except GameError as e:
        return str(e)
    except (TypeError, ValueError):
        return "Malformed message."
    after_phase_change()          # set deadlines BEFORE the snapshot goes out
    await broadcast()
    return None


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
    err = None
    if tag == "side":
        if g.phase == "question" and g.question is not None \
                and pid not in g.side_answers and g.current.pid != pid:
            idx = bots.decide_answer(g, skill, rng)
            err = await dispatch(pid, "answer", {"idx": idx})
        return
    phase = g.phase
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
    elif phase == "haven":
        err = await dispatch(pid, "repair", {})
        if err:
            err = await dispatch(pid, "pass", {})
    elif phase == "pharos":
        err = await dispatch(pid, "pharos_enter", {})
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
    elif phase == "question":
        if g.question is None:
            return
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
    if err:
        print(f"[bot {pid}] {phase}: {err}")
        if phase in ("shrine", "haven"):
            await dispatch(pid, "pass", {})


async def bot_driver():
    while True:
        await asyncio.sleep(0.5)
        g = table.game
        if g.phase in ("lobby", "finished") or not table.bots:
            table.acted.clear()
            continue
        if len(table.acted) > 512:
            table.acted = {k for k in table.acted if k[0] >= g.nonce}

        # side answers from every bot that isn't acting (typed clues are the
        # challenger's alone — no side guesses)
        if g.phase == "question" and g.question is not None \
                and not g.question.get("typed"):
            for p in g.players:
                if p.pid in table.bots and p.pid != g.current.pid \
                        and p.pid not in g.side_answers \
                        and table.bot_rng.random() < 0.9:
                    key = (g.nonce, f"side:{p.pid}")
                    if key not in table.acted:
                        table.acted.add(key)
                        schedule(bot_move(g.nonce, "side", p.pid))

        if not g.players or g.current.pid not in table.bots:
            continue
        if g.phase in ("roll", "sail", "shrine", "haven", "shop", "battle",
                       "question", "minigame", "dodge", "upgrade_pick",
                       "trade", "pharos"):
            if g.phase == "question" and g.question is None:
                continue
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
                        pid = None
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
    schedule(trivia_bank.refill_loop())
    schedule(bot_driver())
    schedule(abandoned_game_reset())

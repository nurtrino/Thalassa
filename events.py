"""
Thalassa EVENTS — the things that happen between the shrines and the fights.

game.py calls in at a handful of points (``on_land``, ``on_turn_start``,
``roll_mod``, ``clear_turn``, ``forget``, ``reset``, ``snapshot``, and the
event-puzzle branch of the minigame plumbing); everything else lives here,
driven by DATA in ``event_data.py``. Adding a region's events (ice, jungle,
desert…) is a data job: write records with ``stage`` set to the region key.

════════════════════════════════════════════════════════════════════════════
THE SCHEMA (full prose version with examples: docs/EVENTS.md)
════════════════════════════════════════════════════════════════════════════
An EVENT is a dict:

  id        unique string
  stage     "hub" (the Isles of Peace) or a region key ("autumn", "ice", …)
  kind      "instant" | "choice" | "game" | "table"
              instant  resolves on landing; the captain just reads the card
              choice   a story card with 2–4 OPTIONS
              game     a choice whose main option deals a GAME (eventgames.py)
                       or an existing PUZZLE kind (puzzles.py); always offer a
                       way to decline
              table    EVERYONE at the table answers at once (sealed)
  title     card title;  text  flavour (second person, present tense)
  art       illustration key for the client (static/events.js ART table)
  where     node classes it can fire on: "sea" (open water / Vale trail),
            "islet" (a spent shrine or a solved spire), "haven", "shop",
            "shrine" (a charged one — the wager follows the event)
  weight    relative odds among eligible events (default 3)
  once      None | "game" (once per voyage) | "player" (once per captain)
  hostile   True: Poseidon's Favor wards it off (sea monsters, storms)
  heavy     True: a game / table / fight — a captain rarely gets two in a row
  when      optional conditions: {"min_turn": n, "min_scrolls": n,
            "players_min": n, "hurt": True, "has_item": id,
            "lacks_upgrade": id, "has_cargo": True}
  world     only fires when a captain meets this WORLD entity (never at random)
  options   (choice/game) list of OPTION
  outcome   (instant) an OUTCOME, or "roll": [[weight, OUTCOME], …]
  table     (table) {"kind": bid|guess|vote|gamble|lanes|lowest, "params": {},
            and per kind: "prize": OUTCOME (bid/guess/lowest), "choices":
            [{"label", "outcome"}] (vote — applies to everyone), "win":
            OUTCOME + "odds" (gamble), "lanes": {name: OUTCOME} (lanes)}

An OPTION: {"label", "stakes" (shown on the button), "requires": {"scrolls":
n, "item": id, "upgrade": id, "hull_gt": n, "hurt": True}, and "outcome":
OUTCOME or "roll": [[weight, OUTCOME], …]}.

An OUTCOME (every key optional; "text" is the line shown on the result card):
  scrolls ±n   hull ±n (heals cap at max; event damage never sinks you)
  item id      upgrade True (offer a fitting pick)   buff [id, n]
  move {"toward": "home"|"haven"|"lair"|"gate"|"random", "steps": n}
  skip True (lose your next turn)   reveal "sword"|"vale"
  fight True | {"name", "unit", "hp", "power", "model", "count"}
  kraken n (the kraken's riddle gauntlet, n riddles)
  game {"kind", "params", "win": OUTCOME, "lose": OUTCOME,
        "score": [[threshold, OUTCOME], …] (highest met wins)}
  puzzle {"kind", "win": OUTCOME, "lose": OUTCOME}
  table {…as above}       spawn world-id       remove_world True
  log  a short line for the shared log (defaults to the title)

A WORLD entity (event_data.WORLD): {"id", "stage", "title", "text", "art",
"model" (client 3D piece), "rounds" (lifetime), "moves" (hops per round, 0 =
fixed), "where" ("sea" | "islet"), "radius" (0 = meet on its stop, 1 = also
the stops next to it), "meet" (the EVENT id fired when a captain lands on /
next to it), "weight", "max" (at once)}.

════════════════════════════════════════════════════════════════════════════
PROTOCOL (all additive)
════════════════════════════════════════════════════════════════════════════
phase   "event"  — the acting captain's card / game, or a table event that
                   everyone answers. (An event PUZZLE plays in the existing
                   "minigame" phase with ``minigame.event = true``.)
client → server   event_choose{idx} · event_move{payload} ·
                  event_answer{value} (anyone, table step) ·
                  event_bet{value: bool} (a rival, game step)
snapshot fields   event (the open event, secrets stripped, sealed answers
                  hidden) · event_card (the last result card, {seq,…}) ·
                  world (visible world entities) · event_info (buff/game
                  names) · players[].buffs
"""
from __future__ import annotations

import random

import eventgames as EG
import puzzles

# ── tunables ────────────────────────────────────────────────────────────────
# chance a quiet landing meets an event, by stage; then scaled by node class
CHANCE = {"hub": 0.40, "autumn": 0.50, "desert": 0.45, "ice": 0.50, "jungle": 0.50}
CHANCE_DEFAULT = 0.30
CLASS_MULT = {"sea": 1.0, "islet": 0.8, "haven": 0.45, "shop": 0.45, "shrine": 0.3,
              "wild": 0.6}    # wild: a realm hunting ground where nothing rose
HEAVY_COOLDOWN = 2          # own turns after a heavy event with only light ones
TABLE_SECS = 40             # generous: everyone answers at once
WORLD_HUB_MAX = 5
WORLD_VALE_MAX = 3
# how each stage keeps its wonders: "always" = on the chart from turn one (the
# hub); otherwise they rise near captains travelling the realm. Any stage with
# WORLD records and no rule here takes the default.
WORLD_RULES = {"hub": {"always": True, "max": WORLD_HUB_MAX, "min": 3, "p": 0.7},
               "autumn": {"max": WORLD_VALE_MAX, "min": 2, "p": 0.7},
               "desert": {"max": 3, "min": 2, "p": 0.7}}
# (min: below it a round raises two wonders instead of one)
WORLD_RULE_DEFAULT = {"max": 2, "p": 0.6}
EVENT_PUZZLES = ("lights_out", "sequence", "anagram", "riddle", "ravens",
                 "sliding", "nonogram")
PUZZLE_LIMIT_FLOOR = 60     # event puzzles get a generous clock

BUFFS = {
    "fair_wind": {"name": "Fair Wind", "desc": "+1 to each roll", "roll": 1, "good": True},
    "becalmed": {"name": "Becalmed", "desc": "−1 to each roll (never below 1)",
                 "roll": -1, "good": False},
    "fortune": {"name": "Fortune's Favour",
                "desc": "the next chancy event falls your way", "good": True},
    "jinx": {"name": "Jinxed", "desc": "the next chancy event falls against you",
             "good": False},
}
BUFF_CAP = 3


class EventError(Exception):
    """Raised for an illegal event action; game.py's GameError wraps it."""


def _err(msg):
    import game                                  # late: game imports us
    raise game.GameError(msg)


# ── content ─────────────────────────────────────────────────────────────────
from event_data import EVENTS, WORLD             # noqa: E402

EVENTS_BY_ID = {e["id"]: e for e in EVENTS}
WORLD_BY_ID = {w["id"]: w for w in WORLD}
WORLD_STAGES = list(dict.fromkeys(w["stage"] for w in WORLD))   # hub first, as listed


def new_state() -> dict:
    """Per-game event state (lives on Game.ev)."""
    return {"active": None, "world": [], "fired": {}, "seen": {},
            "last_heavy": {}, "turn": 0, "round_left": 0, "card": None,
            "seq": 0, "wid": 0}


def _st(g) -> dict:
    st = getattr(g, "ev", None)
    if st is None:                                # an engine built before events
        st = g.ev = new_state()
    return st


# ── where are we? ───────────────────────────────────────────────────────────
def stage_of(node: dict) -> str:
    return node.get("region") or "hub"


def node_class(g, nid: str) -> str | None:
    n = g.board.nodes[nid]
    t = n["type"]
    if n.get("sword") or n.get("sphinx"):
        return None
    if t == "sea":
        return "sea"
    if t == "shrine":
        return "shrine" if n.get("charges", 0) > 0 else "islet"
    if t == "puzzle":
        return "islet" if n.get("solved") else None
    if t == "monster":                  # a realm hunting ground that stayed quiet
        return None if g.board.alive_monster(nid) else "wild"
    if t in ("haven", "shop"):
        return t
    return None


def _quiet_stop(g, nid: str) -> bool:
    """A stop an event may move a captain onto (never a door or a fight)."""
    n = g.board.nodes[nid]
    return (n["type"] in ("sea", "shrine", "puzzle", "haven", "shop", "home")
            and not n.get("sword") and not n.get("sphinx")
            and not g.board.alive_monster(nid))


# ── conditions ──────────────────────────────────────────────────────────────
def _when_ok(g, p, ev) -> bool:
    w = ev.get("when") or {}
    st = _st(g)
    if w.get("min_turn") and st["turn"] < w["min_turn"]:
        return False
    if w.get("min_scrolls") and p.scrolls < w["min_scrolls"]:
        return False
    if w.get("players_min") and len(g.players) < w["players_min"]:
        return False
    if w.get("hurt") and p.hull >= p.max_hull:
        return False
    if w.get("has_item") and p.items.get(w["has_item"], 0) <= 0:
        return False
    if w.get("lacks_upgrade") and p.has(w["lacks_upgrade"]):
        return False
    if w.get("has_cargo") and not p.cargo:
        return False
    if w.get("no_sword") and (p.has("sword_of_damocles") or p.map_bought
                              or not getattr(g.board, "sword_node", None)):
        return False
    return True


def _requires_ok(p, req: dict | None) -> tuple[bool, str]:
    req = req or {}
    if req.get("scrolls") and p.scrolls < req["scrolls"]:
        return False, f"needs {req['scrolls']} scrolls"
    if req.get("item") and p.items.get(req["item"], 0) <= 0:
        import game
        return False, f"needs a {game.SHOP_ITEMS.get(req['item'], {}).get('name', req['item'])}"
    if req.get("upgrade") and not p.has(req["upgrade"]):
        import game
        return False, f"needs the {game.ALL_UPGRADES.get(req['upgrade'], {}).get('name', req['upgrade'])}"
    if req.get("hull_gt") and p.hull <= req["hull_gt"]:
        return False, "your hull is too battered"
    if req.get("hurt") and p.hull >= p.max_hull:
        return False, "your hull is already whole"
    return True, ""


def eligible(g, p, nid: str) -> list[dict]:
    node = g.board.nodes[nid]
    stage, cls = stage_of(node), node_class(g, nid)
    if cls is None:
        return []
    st = _st(g)
    out = []
    for ev in EVENTS:
        where = ev.get("where", ("sea",))
        if ev["stage"] != stage or ev.get("world") or not (
                cls in where or (cls == "wild" and "sea" in where)):
            continue
        if ev.get("hostile") and p.has("poseidon_favor"):
            continue
        once = ev.get("once")
        if once == "game" and st["fired"].get(ev["id"]):
            continue
        if once == "player" and ev["id"] in st["seen"].get(p.pid, ()):
            continue
        if ev["kind"] == "table" and len(g.players) < 2:
            continue
        if not _when_ok(g, p, ev):
            continue
        out.append(ev)
    return out


# ═══ the landing hook ═══════════════════════════════════════════════════════
def on_land(g, p, nid: str) -> bool:
    """Called from Game._land on a quiet landing (no fight, no lair, no door).
    True if an event took over the turn (the caller must return)."""
    if not getattr(g, "events_on", True):
        return False
    st = _st(g)
    node = g.board.nodes[nid]
    if node["type"] in ("gate", "lair"):   # the pass carries you on; a lair is a trial
        return False
    # a WORLD entity met here takes precedence over a random event
    for w in st["world"]:
        if p.pid in w["met"]:
            continue
        if w["node"] == nid or (WORLD_BY_ID[w["id"]].get("radius")
                                and nid in g.board.neighbors.get(w["node"], ())):
            if not _shown_to(g, p.pid, w["node"]):
                continue
            ev = EVENTS_BY_ID.get(WORLD_BY_ID[w["id"]]["meet"])
            if ev and not (ev.get("hostile") and p.has("poseidon_favor")):
                w["met"].append(p.pid)
                start(g, p, nid, ev, world=w["wid"])
                return True
    cls = node_class(g, nid)
    if cls is None:
        return False
    chance = CHANCE.get(stage_of(node), CHANCE_DEFAULT) * CLASS_MULT.get(cls, 0)
    cooling = st["turn"] - st["last_heavy"].get(p.pid, -99) <= HEAVY_COOLDOWN * len(g.players)
    if cooling:
        chance *= 0.6
    if not chance or g.rng.random() >= chance:
        return False
    pool = [ev for ev in eligible(g, p, nid) if not (cooling and ev.get("heavy"))]
    if not pool:
        return False
    seen = st["seen"].get(p.pid, ())
    weights = [ev.get("weight", 3) * (0.25 if ev["id"] in seen else 1.0) for ev in pool]
    ev = g.rng.choices(pool, weights=weights)[0]
    start(g, p, nid, ev)
    return True


def start(g, p, nid: str, ev: dict, world: int | None = None):
    st = _st(g)
    st["fired"][ev["id"]] = st["fired"].get(ev["id"], 0) + 1
    st["seen"].setdefault(p.pid, [])
    if ev["id"] not in st["seen"][p.pid]:
        st["seen"][p.pid].append(ev["id"])
    if ev.get("heavy"):
        st["last_heavy"][p.pid] = st["turn"]
    act = {"id": ev["id"], "pid": p.pid, "node": nid, "kind": ev["kind"],
           "title": ev["title"], "text": ev["text"], "art": ev.get("art", "sea"),
           "stage": ev["stage"], "step": "card", "world": world, "bets": {},
           "options": None, "game": None, "gspec": None, "table": None,
           "puzzle": None}
    g._say(f"✦ {p.name} — {ev['title']}.")
    if ev["kind"] == "instant":
        st["active"] = act
        out = _pick(g, p, ev)
        _conclude(g, p, act, out)
        return
    if ev["kind"] == "table":
        st["active"] = act
        _open_table(g, p, act, ev["table"])
        g._bump("event")
        return
    act["options"] = []
    for opt in ev["options"]:
        ok, why = _requires_ok(p, opt.get("requires"))
        if ok and opt.get("when") and not _when_ok(g, p, opt):
            ok, why = False, "not now"
        act["options"].append({"label": opt["label"], "stakes": opt.get("stakes", ""),
                               "ok": ok, "why": why})
    if not any(o["ok"] for o in act["options"]):
        act["options"][-1]["ok"] = True           # data guard: never a dead end
        act["options"][-1]["why"] = ""
    st["active"] = act
    g._bump("event")


# ── outcomes ────────────────────────────────────────────────────────────────
def _value(out: dict | None) -> float:
    """A rough worth of an outcome (bots + the luck buffs)."""
    if not out:
        return 0.0
    v = float(out.get("scrolls", 0)) + 1.5 * float(out.get("hull", 0))
    v += 1.5 * (bool(out.get("item")) + len(out.get("items") or []))
    if out.get("upgrade"):
        v += 4
    if out.get("buff"):
        v += 1.5 if BUFFS.get(out["buff"][0], {}).get("good") else -1.5
    if out.get("skip"):
        v -= 3.5
    if out.get("fight"):
        v -= 2
    if out.get("kraken"):
        v -= 1.5
    if out.get("reveal"):
        v += 1.5
    if out.get("move") or out.get("swap"):
        v += 0.5
    for k in ("game", "puzzle"):
        if out.get(k):
            sub = out[k]
            v += 0.5 * _value(sub.get("win")) + 0.3 * _value(sub.get("lose"))
            if sub.get("score"):
                v += 0.4 * max(_value(o) for _, o in sub["score"])
    return v


def _pick(g, p, spec: dict) -> dict:
    """The outcome of an option / instant event, luck buffs applied."""
    if spec.get("roll"):
        opts = spec["roll"]
        weights = [w for w, _ in opts]
        a = g.rng.choices(opts, weights=weights)[0][1]
        luck = None
        if p.buffs.get("fortune"):
            luck = "fortune"
        elif p.buffs.get("jinx"):
            luck = "jinx"
        if luck:
            b = g.rng.choices(opts, weights=weights)[0][1]
            better = a if _value(a) >= _value(b) else b
            worse = b if better is a else a
            a = better if luck == "fortune" else worse
            _use_buff(p, luck)
        return a
    return spec.get("outcome") or {}


def _use_buff(p, bid: str):
    n = p.buffs.get(bid, 0) - 1
    if n > 0:
        p.buffs[bid] = n
    else:
        p.buffs.pop(bid, None)


def _apply_simple(g, q, out: dict, lines: list) -> None:
    """Effects that can land on ANY captain (table prizes use only these)."""
    import game as G
    if not out:
        return
    if out.get("scrolls"):
        n = int(out["scrolls"])
        before = q.scrolls
        q.scrolls = max(0, q.scrolls + n)
        d = q.scrolls - before
        if d:
            lines.append(f"{'+' if d > 0 else '−'}{abs(d)} scroll{'s' if abs(d) != 1 else ''}")
    if out.get("hull"):
        n = float(out["hull"])
        if n > 0:
            healed = min(n, q.max_hull - q.hull)
            q.hull += healed
            if healed:
                lines.append(f"+{G.fmt_hp(healed)} Health")
        else:
            dmg, blocked = g._absorb(q, -n)
            if blocked:
                lines.append("your aegis charm turns the harm aside")
            elif dmg:
                # an event bruises — it never sinks a ship
                new = max(min(q.hull, 1), G.round_half(q.hull - dmg))
                if new < q.hull:
                    lines.append(f"−{G.fmt_hp(q.hull - new)} Health")
                q.hull = new
    if out.get("item_spend") and q.items.get(out["item_spend"], 0) > 0:
        q.items[out["item_spend"]] -= 1
        lines.append(f"−1 {G.SHOP_ITEMS[out['item_spend']]['name']}")
    for it in ([out["item"]] if out.get("item") else []) + list(out.get("items") or []):
        if q.items.get(it, 0) < G.ITEM_CAP:
            q.items[it] = q.items.get(it, 0) + 1
            lines.append(f"+1 {G.SHOP_ITEMS[it]['name']}")
        else:
            q.scrolls += 1
            lines.append(f"your hold is full of {G.SHOP_ITEMS[it]['name']}s — sold for +1 scroll")
    for bid, n in ([out["buff"]] if out.get("buff") else []) + list(out.get("buffs") or []):
        n = int(n)
        q.buffs[bid] = min(BUFF_CAP, max(q.buffs.get(bid, 0), n))
        # a fair wind blows away a calm and vice versa
        rival = {"fair_wind": "becalmed", "becalmed": "fair_wind",
                 "fortune": "jinx", "jinx": "fortune"}.get(bid)
        if rival:
            q.buffs.pop(rival, None)
        lines.append(f"{BUFFS[bid]['name']} ({BUFFS[bid]['desc']}) ×{q.buffs[bid]}")


def _conclude(g, p, act: dict, out: dict | None, lines: list | None = None,
              ok: bool | None = None):
    """Apply an outcome to the acting captain, post the result card, and send
    the turn on its way (a fight, a fitting pick, a riddle, or simply the
    rest of the landing)."""
    import game as G
    st = _st(g)
    out = out or {}
    lines = list(lines or [])
    if out.get("remove_world") and act.get("world") is not None:
        st["world"] = [w for w in st["world"] if w["wid"] != act["world"]]
        act["world"] = None
    # sub-steps first: these keep the event open
    if out.get("game"):
        _open_game(g, p, act, out)
        return
    if out.get("puzzle"):
        _open_puzzle(g, p, act, out)
        return
    if out.get("table"):
        _open_table(g, p, act, out["table"], text=out.get("text"))
        g._bump("event")
        return
    if out.get("text"):
        lines.insert(0, out["text"])
    _apply_simple(g, p, out, lines)
    flow = None
    if out.get("reveal") == "sword":
        if getattr(g.board, "sword_node", None) and not p.map_bought \
                and not p.has("sword_of_damocles"):
            p.map_bought = True
            lines.append("a lone islet is circled on your chart")
        else:
            p.scrolls += 2
            lines.append("+2 scrolls")
    elif out.get("reveal") == "vale":
        g._reveal_vale(p, radius=6)
        lines.append("the woods ahead are lit on your map")
    if out.get("skip"):
        p.skip_turns = max(p.skip_turns, 1)
        lines.append("you will lose your next turn")
    if out.get("spawn"):
        spawn_world(g, out["spawn"], near=act["node"])
    if out.get("move") and p.node == act["node"]:
        if _move(g, p, out["move"]):
            flow = "move"
            lines.append("you are carried onward")
    if out.get("swap") and p.node == act["node"] and flow is None:
        q = _swap(g, p)
        if q is not None:
            flow = "move"
            lines.append(f"you and {q.name} have traded places")
        else:
            lines.append("there is nobody to trade places with")
    if out.get("rival"):
        q = _rival(g, p)
        if q is not None:
            sub = []
            _apply_simple(g, q, out["rival"], sub)
            if sub:
                lines.append(f"{q.name}: " + ", ".join(sub))
    if out.get("upgrade"):
        pool = [u for u in G.UPGRADES if not p.has(u)]
        if pool:
            g.rng.shuffle(pool)
            g.upgrade_offer = pool[:2]
            flow = "upgrade"
            lines.append("choose a fitting")
        else:
            p.scrolls += 3
            lines.append("+3 scrolls")
    if out.get("fight") and flow is None:
        flow = "fight"
    if out.get("kraken") and flow is None:
        flow = "kraken"
    # the card everyone sees
    st["seq"] += 1
    st["card"] = {"seq": st["seq"], "pid": p.pid, "id": act["id"], "title": act["title"],
                  "art": act["art"], "lines": lines,
                  "ok": ok if ok is not None else (_value(out) >= 0)}
    summary = "; ".join(lines[1:] if out.get("text") else lines) or "the moment passes"
    g._say(f"✦ {p.name}: {out.get('log') or act['title']} — {summary}.")
    st["active"] = None
    nid = act["node"]
    if flow == "fight":
        _start_fight(g, p, nid, out["fight"])
    elif flow == "kraken":
        g.kraken = {"node": nid, "asked": 0, "need": int(out["kraken"])}
        g._kraken_deal()
    elif flow == "upgrade":
        g._bump("upgrade_pick")
    elif flow == "move":
        g._end_turn()
    else:
        g._land_tail(p, nid)


def _swap(g, p):
    """The ghost ship's trick: trade places with a rival on quiet water in the
    same waters (never into a fight, a door or someone's private trail)."""
    stage = stage_of(g.board.nodes[p.node])
    pool = [q for q in g.players if q.pid != p.pid and q.node in g.board.nodes
            and stage_of(g.board.nodes[q.node]) == stage
            and g.board.nodes[q.node].get("owner") is None
            and _quiet_stop(g, q.node) and q.node != p.node]
    if not pool or not _quiet_stop(g, p.node):
        return None
    q = g.rng.choice(pool)
    p.prev_node, q.prev_node = p.node, q.node
    p.node, q.node = q.node, p.node
    return q


def _rival(g, p):
    """A captain other than ``p`` (an outcome that lands on someone else —
    a parcel delivered to the wrong ship)."""
    pool = [q for q in g.players if q.pid != p.pid]
    return g.rng.choice(pool) if pool else None


def _start_fight(g, p, nid: str, spec):
    import game as G
    node = g.board.nodes[nid]
    if isinstance(spec, dict):
        count = max(1, min(3, int(spec.get("count", 1))))
        unit = spec.get("unit", spec.get("name", "Beast"))
        enemies = [{"name": f"{unit} {'ⅠⅡⅢ'[i]}" if count > 1 else unit,
                    "hp": spec["hp"], "max_hp": spec["hp"], "power": spec["power"],
                    "model": spec.get("model")} for i in range(count)]
        monster = {"name": spec.get("name", unit), "tier": spec.get("tier", 2),
                   "model": spec.get("model"), "domain": g.rng.choice(G.DOMAINS),
                   "enemies": enemies}
    else:
        monster = g.board.random_pack(node, g.rng)
    node["monster"] = monster
    g.battle = {"node": nid, "stance": None, "round": 0, "charging": False,
                "ambush": True, "used_items": [], "first_hit_taken": False}
    g._arm_battle()
    g._say(f"⚔ {monster['name']} close on {p.name}!")
    g._bump("battle")


def _move(g, p, spec: dict) -> bool:
    """Carry a captain along the chart (a tow, a will-o'-wisp, a current).
    Positional only — no landing effects — and never onto a door or a fight."""
    steps = int(spec.get("steps", 2))
    stage = stage_of(g.board.nodes[p.node])

    def ok(nid):
        n = g.board.nodes[nid]
        return (stage_of(n) == stage and n.get("owner") in (None, p.pid)
                and n["type"] not in ("gate", "lair", "pharos", "monster")
                and not (n.get("sphinx") and not n.get("sphinx_done")))

    toward = spec.get("toward", "random")
    targets = {nid for nid, n in g.board.nodes.items() if ok(nid) and (
        (toward == "home" and n["type"] == "home")
        or (toward == "haven" and n["type"] == "haven")
        or (toward == "shop" and n["type"] == "shop"))}
    if toward in ("lair", "gate"):
        # walk toward the barrow / the pass, stopping short of it
        goal = {nid for nid, n in g.board.nodes.items()
                if n["type"] == toward and stage_of(n) == stage
                and n.get("owner") in (None, p.pid)}
        targets = {nb for gl in goal for nb in g.board.neighbors.get(gl, ()) if ok(nb)}
    # BFS from the captain over allowed stops
    prev = {p.node: None}
    order = [p.node]
    for cur in order:
        for nb in g.board.neighbors.get(cur, ()):
            if nb not in prev and ok(nb):
                prev[nb] = cur
                order.append(nb)
    path = None
    if targets & set(prev):
        tgt = next(nid for nid in order if nid in targets)
        path = []
        while tgt is not None:
            path.append(tgt)
            tgt = prev[tgt]
        path.reverse()
    else:
        cand = [nid for nid in order[1:] if _quiet_stop(g, nid)]
        if not cand:
            return False
        far = [nid for nid in cand if nid in order[: 1 + 6 * steps]]
        tgt = g.rng.choice(far or cand)
        path = []
        while tgt is not None:
            path.append(tgt)
            tgt = prev[tgt]
        path.reverse()
    # step along the path, as far as `steps` allows, stopping on quiet ground
    dest = None
    for nid in path[1: steps + 1]:
        if _quiet_stop(g, nid):
            dest = nid
    if not dest or dest == p.node:
        return False
    p.prev_node = p.node
    p.node = dest
    g._reveal_vale(p)
    return True


# ── a GAME ──────────────────────────────────────────────────────────────────
def _open_game(g, p, act: dict, out: dict):
    spec = out["game"]
    act["step"] = "game"
    act["game"] = EG.gen(spec["kind"], g.rng, spec.get("params"))
    act["gspec"] = {"win": spec.get("win"), "lose": spec.get("lose"),
                    "score": spec.get("score"), "text": out.get("text")}
    act["bets"] = {}
    _st(g)["active"] = act
    if out.get("text"):
        act["intro"] = out["text"]
    g._bump("event")


def _game_outcome(act: dict) -> tuple[dict, bool]:
    gs, spec = act["game"], act["gspec"]
    won = gs.get("result") == "win"
    if spec.get("score"):
        best = None
        for thr, o in sorted(spec["score"], key=lambda t: t[0]):
            if gs.get("score", 0) >= thr:
                best = o
        if best is not None:
            return best, True
        return spec.get("lose") or {}, False
    return (spec.get("win") or {}) if won else (spec.get("lose") or {}), won


def _settle_bets(g, act: dict, won: bool, lines: list):
    winners = []
    for bpid, guess in act.get("bets", {}).items():
        q = g.player_by_pid(bpid)
        if q and bool(guess) == won:
            q.scrolls += 1
            winners.append(q.name)
    if winners:
        lines.append(f"{', '.join(winners)} called it (+1 scroll)")


def _finish_game(g, p, act: dict):
    out, won = _game_outcome(act)
    label = EG.GAME_LABEL.get(act["game"]["kind"], "the game")
    lines = [f"{label}: {'won' if won else 'lost'}"]
    _settle_bets(g, act, won, lines)
    _conclude(g, p, act, out, lines, ok=won)


# ── a PUZZLE (an existing puzzles.py kind, played in the minigame phase) ────
def _open_puzzle(g, p, act: dict, out: dict):
    spec = out["puzzle"]
    kind = spec.get("kind") or g.rng.choice(EVENT_PUZZLES)
    if kind == "riddle":
        deal = puzzles.deal_riddle(g.rng, g.used_puzzles)
    else:
        deal = puzzles.deal_kind(g.rng, kind)
    limit = deal.get("limit")
    if limit:
        limit = max(limit * 2, PUZZLE_LIMIT_FLOOR)
        deal["limit"] = limit
    act["step"] = "puzzle"
    act["puzzle"] = {"kind": kind, "win": spec.get("win"), "lose": spec.get("lose")}
    act["bets"] = {}
    _st(g)["active"] = act
    g.minigame = {"kind": deal["kind"], "island": act["node"], "data": deal,
                  "limit": limit, "deadline": None, "event": True,
                  "event_title": act["title"]}
    if deal["kind"] == "riddle":
        g.minigame.update({"text": deal["text"], "category": deal["category"]})
    g._bump("minigame")


def puzzle_done(g, ok: bool):
    """The event puzzle resolved (solved, failed, timed out, or a bot's call)."""
    st = _st(g)
    act = st["active"]
    mg = g.minigame or {}
    g.minigame = None
    p = g.current
    if not act or act.get("step") != "puzzle":
        g._end_turn()
        return
    ans = puzzles.answer_text(mg.get("kind"), mg.get("data")) if not ok else ""
    lines = ["the puzzle yields" if ok else
             (f"the puzzle wins — the answer was {ans}" if ans else "the puzzle wins")]
    _settle_bets(g, act, ok, lines)
    out = (act["puzzle"].get("win") if ok else act["puzzle"].get("lose")) or {}
    _conclude(g, p, act, out, lines, ok=ok)


# ── a TABLE event ───────────────────────────────────────────────────────────
def _open_table(g, p, act: dict, spec: dict, text: str | None = None):
    act["step"] = "table"
    params = dict(spec.get("params") or {})
    if spec["kind"] == "lanes":
        params["lanes"] = list(spec["lanes"])
    tst = EG.gen_table(spec["kind"], g.rng, params)
    if spec["kind"] == "vote":
        tst["choices"] = [c["label"] for c in spec["choices"]]
    act["table"] = {"st": tst, "spec": spec, "answers": {}, "deadline": None,
                    "prompt": spec.get("prompt", "")}
    if text:
        act["intro"] = text
    _st(g)["active"] = act


def table_waiting(g) -> list[str]:
    act = _st(g)["active"]
    if g.phase != "event" or not act or act["step"] != "table":
        return []
    return [q.pid for q in g.players if q.pid not in act["table"]["answers"]]


def _resolve_table(g):
    import game as G
    st = _st(g)
    act = st["active"]
    t = act["table"]
    tst, spec, ans = t["st"], t["spec"], t["answers"]
    kind = tst["kind"]
    lines: list[str] = []
    p = g.current
    by = {q.pid: q for q in g.players}
    named = lambda pids: ", ".join(by[x].name for x in pids if x in by)   # noqa: E731
    results = {}
    if kind == "bid":
        bids = {pid: v for pid, v in ans.items() if isinstance(v, int) and v > 0 and pid in by}
        if not bids:
            lines.append("nobody bids — the prize sinks with a bubble")
        else:
            top = max(bids.values())
            tops = [pid for pid, v in bids.items() if v == top]
            if len(tops) > 1:
                lines.append(f"{named(tops)} tie at {top} — the auctioneer storms off")
            else:
                w = by[tops[0]]
                w.scrolls -= top
                sub = [f"{w.name} wins for {top} scroll{'s' if top != 1 else ''}"]
                _apply_simple(g, w, spec.get("prize"), sub)
                lines.append(" · ".join(sub))
        results = {pid: v for pid, v in ans.items()}
    elif kind == "guess":
        target = tst["secret"]["target"]
        guesses = {pid: v for pid, v in ans.items() if isinstance(v, int) and pid in by}
        lines.append(f"the answer was {target}")
        if guesses:
            best = min(abs(v - target) for v in guesses.values())
            wins = [pid for pid, v in guesses.items() if abs(v - target) == best]
            for pid in wins:
                sub = [f"{by[pid].name} is closest"]
                _apply_simple(g, by[pid], spec.get("prize"), sub)
                lines.append(" · ".join(sub))
        else:
            lines.append("nobody ventured a guess")
        results = dict(guesses)
        results["_target"] = target
    elif kind == "vote":
        tally = [0] * len(spec["choices"])
        for pid, v in ans.items():
            if isinstance(v, int) and 0 <= v < len(tally):
                tally[v] += 1
        top = max(tally)
        if top == 0:
            pick = g.rng.randrange(len(tally))
            lines.append("nobody votes — the gods decide")
        else:
            tops = [i for i, n in enumerate(tally) if n == top]
            pick = g.rng.choice(tops)
        ch = spec["choices"][pick]
        lines.append(f"the table chooses: {ch['label']}")
        out = ch.get("outcome") or {}
        if out.get("text"):
            lines.append(out["text"])
        for q in g.players:
            sub = []
            _apply_simple(g, q, out, sub)
            if sub:
                lines.append(f"{q.name}: " + ", ".join(sub))
        results = {"tally": tally, "pick": pick}
    elif kind == "gamble":
        ins = [pid for pid, v in ans.items() if v == "in" and pid in by
               and by[pid].scrolls >= tst["ante"]]
        if not ins:
            lines.append("nobody antes in")
        else:
            for pid in ins:
                by[pid].scrolls -= tst["ante"]
            hit = g.rng.random() < float(spec.get("odds", 0.5))
            lines.append(spec.get("hit_text" if hit else "miss_text",
                                  "the dice favour the bold" if hit else "the dice say no"))
            if hit:
                for pid in ins:
                    sub = []
                    _apply_simple(g, by[pid], spec.get("win"), sub)
                    lines.append(f"{by[pid].name}: " + ", ".join(sub))
            else:
                lines.append(f"{named(ins)} lose their ante")
        results = {"in": ins}
    elif kind == "lanes":
        lanes = tst["secret"]["lanes"]
        effects = spec.get("lanes", {})
        lines.append("the lanes were: " + ", ".join(
            f"{i + 1} {name}" for i, name in enumerate(lanes)))
        for pid, v in ans.items():
            if isinstance(v, int) and 0 <= v < len(lanes) and pid in by:
                sub = []
                _apply_simple(g, by[pid], effects.get(lanes[v]), sub)
                lines.append(f"{by[pid].name} ({lanes[v]}): " + (", ".join(sub) or "no change"))
        results = {"lanes": lanes}
    elif kind == "lowest":
        picks = {pid: v for pid, v in ans.items() if isinstance(v, int) and pid in by}
        counts: dict[int, int] = {}
        for v in picks.values():
            counts[v] = counts.get(v, 0) + 1
        uniq = sorted(v for v, n in counts.items() if n == 1)
        if uniq:
            w = next(pid for pid, v in picks.items() if v == uniq[0])
            sub = [f"{by[w].name} wins with a lone {uniq[0]}"]
            _apply_simple(g, by[w], spec.get("prize"), sub)
            lines.append(" · ".join(sub))
        else:
            lines.append("no number stood alone — nobody wins")
        results = dict(picks)
    elif kind == "race":
        sec = tst["secret"]
        win = sec["winner"]
        lines.extend(sec["legs"])
        lines.append(f"{tst['runners'][win]} wins the race!")
        pays = spec.get("pays") or []
        purse = pays[win] if win < len(pays) else spec.get("prize")
        backers = [pid for pid, v in ans.items() if v == win and pid in by]
        for pid in backers:
            sub = [f"{by[pid].name} backed the winner"]
            _apply_simple(g, by[pid], purse, sub)
            lines.append(" · ".join(sub))
        if not backers:
            lines.append("nobody backed the winner")
        results = {"winner": win, **{pid: v for pid, v in ans.items() if pid in by}}
    t["results"] = results
    _conclude(g, p, act, {"log": spec.get("log")}, lines, ok=None)


# ═══ actions (server dispatch → these) ═════════════════════════════════════
def _require(g, pid, step: str):
    act = _st(g)["active"]
    if g.phase != "event" or not act or act["step"] != step:
        _err("Not the moment for that.")
    if not g.players or g.current.pid != pid:
        _err("Not your turn.")
    return act


def choose(g, pid, idx):
    act = _require(g, pid, "card")
    if type(idx) is not int or not (0 <= idx < len(act["options"])):
        _err("Pick one of the options.")
    if not act["options"][idx]["ok"]:
        _err(act["options"][idx]["why"] or "You cannot choose that.")
    ev = EVENTS_BY_ID[act["id"]]
    p = g.current
    out = _pick(g, p, ev["options"][idx])
    act["chosen"] = idx
    _conclude(g, p, act, out)


def game_move(g, pid, payload):
    act = _require(g, pid, "game")
    gs = act["game"]
    snap = repr(gs)
    rng_state = g.rng.getstate()
    try:
        EG.move(gs, payload, g.rng)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError) as e:
        g.rng.setstate(rng_state)
        if repr(gs) != snap:                       # belt and braces
            raise RuntimeError("an event game mutated on a refused move") from None
        _err(str(e) if isinstance(e, ValueError) else "Malformed move.")
    if gs.get("done"):
        _finish_game(g, g.current, act)
    else:
        g.nonce += 1


def answer(g, pid, value):
    act = _st(g)["active"]
    if g.phase != "event" or not act or act["step"] != "table":
        _err("There is nothing to answer.")
    q = g.player_by_pid(pid)
    if q is None:
        _err("Spectators watch in silence.")
    t = act["table"]
    if pid in t["answers"]:
        _err("You already answered.")
    if not EG.table_valid(t["st"], value, q):
        _err("That is not a valid answer.")
    t["answers"][pid] = value
    g.nonce += 1
    if not table_waiting(g):
        _resolve_table(g)


def bet(g, pid, value):
    act = _st(g)["active"]
    if not act or act["step"] not in ("game", "puzzle") or \
            g.phase not in ("event", "minigame"):
        _err("There is nothing to bet on.")
    if pid == act["pid"]:
        _err("You cannot bet on your own game.")
    if g.player_by_pid(pid) is None:
        _err("Spectators watch in silence.")
    if pid in act["bets"]:
        _err("Your bet is already down.")
    if type(value) is not bool:
        _err("Bet yes or no.")
    act["bets"][pid] = value
    g.nonce += 1


def timeout(g):
    """The table clock ran out (or a stale timer fired): absent captains take
    the do-nothing default and the table resolves. A no-op otherwise."""
    act = _st(g)["active"]
    if g.phase != "event" or not act or act["step"] != "table":
        return
    t = act["table"]
    for q in g.players:
        if q.pid not in t["answers"]:
            t["answers"][q.pid] = EG.table_default(t["st"])
    _resolve_table(g)


def idle_default(g, pid) -> str:
    """The safe default for the captain whose turn it is (idle clock / a bot
    whose move failed). Always moves the event on."""
    act = _st(g)["active"]
    if g.phase != "event" or not act:
        return "none"
    p = g.current
    if act["step"] == "card":
        # the LAST enabled option is, by convention, the cautious one
        idx = max(i for i, o in enumerate(act["options"]) if o["ok"])
        choose(g, pid, idx)
        return "choose"
    if act["step"] == "game":
        pay = EG.idle(act["game"])
        if pay is not None:
            game_move(g, pid, pay)
        else:
            EG.forfeit(act["game"])
            _finish_game(g, p, act)
        return "forfeit"
    if act["step"] == "table":
        if pid not in act["table"]["answers"]:
            # the do-nothing answer ("sits it out") — recorded, not validated
            act["table"]["answers"][pid] = EG.table_default(act["table"]["st"])
            g.nonce += 1
            if not table_waiting(g):
                _resolve_table(g)
            return "answer"
        timeout(g)
        return "timeout"
    return "none"


# ── bots ────────────────────────────────────────────────────────────────────
def bot_decide(g, pid, skill: float, rng: random.Random):
    """(message type, value) a philosopher would send now, or None."""
    act = _st(g)["active"]
    if not act or g.phase != "event":
        return None
    p = g.player_by_pid(pid)
    if p is None:
        return None
    if act["step"] == "table":
        if pid in act["table"]["answers"]:
            return None
        return ("event_answer", EG.table_bot(act["table"]["st"], rng, p, skill))
    if g.current.pid != pid:
        return None
    if act["step"] == "card":
        ev = EVENTS_BY_ID[act["id"]]
        best, best_v = None, -1e9
        for i, (o, spec) in enumerate(zip(act["options"], ev["options"])):
            if not o["ok"]:
                continue
            if spec.get("roll"):
                tot = sum(w for w, _ in spec["roll"]) or 1
                v = sum(w * _value(out) for w, out in spec["roll"]) / tot
            else:
                v = _value(spec.get("outcome"))
            v += rng.uniform(-1.2, 1.2)
            if p.hull <= 2 and any(_hurts(out) for out in _outs(spec)):
                v -= 3
            if v > best_v:
                best, best_v = i, v
        return ("event_choose", best if best is not None else 0)
    if act["step"] == "game":
        return ("event_move", EG.bot(act["game"], rng, skill))
    return None


def _outs(spec):
    if spec.get("roll"):
        return [o for _, o in spec["roll"]]
    return [spec.get("outcome") or {}]


def _hurts(out):
    return bool(out) and (out.get("fight") or (out.get("hull") or 0) < 0)


def bot_bet(g, pid, rng: random.Random):
    act = _st(g)["active"]
    if (not act or act["step"] not in ("game", "puzzle") or pid == act["pid"]
            or pid in act["bets"]):
        return None
    return rng.random() < 0.55


def legal_moves(g, pid) -> list[tuple[str, str, object]]:
    """Every sensible (label, message, value) for ``pid`` right now — the
    fuzzer's menu. Table answers include every valid value class."""
    act = _st(g)["active"]
    out = []
    if not act or g.phase != "event":
        return out
    p = g.player_by_pid(pid)
    if p is None:
        return out
    if act["step"] == "table":
        if pid in act["table"]["answers"]:
            return out
        tst = act["table"]["st"]
        k = tst["kind"]
        vals = {"bid": list(range(0, min(tst.get("cap", 0), p.scrolls) + 1))[:5],
                "guess": [tst.get("lo"), tst.get("hi"),
                          (tst.get("lo", 0) + tst.get("hi", 0)) // 2],
                "vote": list(range(len(tst.get("choices", [])))),
                "gamble": ["out"] + (["in"] if p.scrolls >= tst.get("ante", 1) else []),
                "lanes": list(range(tst.get("n", 0))),
                "lowest": list(range(1, tst.get("max", 0) + 1)),
                "race": list(range(tst.get("n", 0)))}.get(k, [])
        return [(f"table {v!r}", "event_answer", v) for v in vals
                if EG.table_valid(tst, v, p)]
    if g.current.pid != pid:
        if act["step"] in ("game",) and pid not in act["bets"]:
            out += [("bet yes", "event_bet", True), ("bet no", "event_bet", False)]
        return out
    if act["step"] == "card":
        return [(f"choose {i}", "event_choose", i)
                for i, o in enumerate(act["options"]) if o["ok"]]
    if act["step"] == "game":
        gs = act["game"]
        rng = random.Random(len(repr(gs)))
        moves = [("game solve", "event_move", EG.solve(gs)),
                 ("game bot", "event_move", EG.bot(gs, rng, 0.3))]
        if EG.idle(gs) is not None:
            moves.append(("game stop", "event_move", EG.idle(gs)))
        return moves
    return out


# ═══ engine hooks ═══════════════════════════════════════════════════════════
def roll_mod(g, p) -> int:
    """Called from Game.roll: the wind buffs, consumed one roll at a time."""
    mod = 0
    for bid in list(p.buffs):
        r = BUFFS.get(bid, {}).get("roll")
        if r:
            mod += r
            _use_buff(p, bid)
    return mod


def clear_turn(g):
    """Called whenever the dice pass: an open event belongs to one turn."""
    st = _st(g)
    st["active"] = None


def forget(g, pid: str):
    """A captain left the table: strike their sealed answer and their bet."""
    act = _st(g)["active"]
    if not act:
        return
    if act.get("table"):
        act["table"]["answers"].pop(pid, None)
    act.get("bets", {}).pop(pid, None)
    for w in _st(g)["world"]:
        if pid in w["met"]:
            w["met"].remove(pid)


def reset(g):
    """A rematch: a brand-new sea, no leftover wonders."""
    g.ev = new_state()


def on_turn_start(g):
    """Called at every turn start: the world turns once per round."""
    if not g.players or not getattr(g, "events_on", True):
        return
    st = _st(g)
    st["turn"] += 1
    st["round_left"] -= 1
    if st["round_left"] > 0:
        return
    st["round_left"] = max(1, len(g.players))
    _tick_world(g)


# ═══ WORLD entities ════════════════════════════════════════════════════════
def _world_nodes(g, stage: str, where: str, owner: str | None = None) -> list[str]:
    out = []
    for nid, n in g.board.nodes.items():
        if stage_of(n) != stage or n.get("owner") not in (None, owner):
            continue
        cls = node_class(g, nid)
        if where == "sea" and cls != "sea":
            continue
        if where == "islet" and n["type"] not in ("shrine", "puzzle", "haven", "shop"):
            continue
        out.append(nid)
    return out


def spawn_world(g, wid_kind: str, near: str | None = None, owner: str | None = None):
    st = _st(g)
    spec = WORLD_BY_ID.get(wid_kind)
    if not spec:
        return None
    if any(w["id"] == wid_kind for w in st["world"]):
        return None
    cands = _world_nodes(g, spec["stage"], spec.get("where", "sea"), owner)
    occupied = {w["node"] for w in st["world"]} | {q.node for q in g.players}
    cands = [c for c in cands if c not in occupied] or cands
    if not cands:
        return None
    if near and near in g.board.nodes:
        nx, nz = g.board.nodes[near]["x"], g.board.nodes[near]["z"]
        cands.sort(key=lambda c: (g.board.nodes[c]["x"] - nx) ** 2
                   + (g.board.nodes[c]["z"] - nz) ** 2)
        node = g.rng.choice(cands[1:6] or cands[:1])
    else:
        node = g.rng.choice(cands)
    st["wid"] += 1
    w = {"wid": st["wid"], "id": wid_kind, "node": node,
         "rounds": int(spec.get("rounds", 5)), "met": []}
    st["world"].append(w)
    if st["turn"] > 1:                    # the opening wonders arrive unannounced
        g._say(f"✦ {spec['title']} — {spec.get('log', 'sighted on the chart')}.")
    g.nonce += 1
    return w


def _tick_world(g):
    st = _st(g)
    keep = []
    for w in st["world"]:
        spec = WORLD_BY_ID[w["id"]]
        w["rounds"] -= 1
        if w["rounds"] <= 0:
            g._say(f"✦ {spec['title']} {spec.get('gone', 'is gone from the chart')}.")
            continue
        hops = int(spec.get("moves", 0))
        for _ in range(hops):
            nbrs = [nb for nb in g.board.neighbors.get(w["node"], ())
                    if node_class(g, nb) == "sea"
                    and stage_of(g.board.nodes[nb]) == spec["stage"]
                    and g.board.nodes[nb].get("owner") is None]
            if nbrs:
                w["node"] = g.rng.choice(nbrs)
                w["met"] = []                      # a new meeting place
        keep.append(w)
    st["world"] = keep
    # new wonders, by stage (WORLD_RULES): the Isles of Peace keep a few on
    # the chart from the first turn; a realm stirs when someone travels it
    for stage in WORLD_STAGES:
        rule = WORLD_RULES.get(stage, WORLD_RULE_DEFAULT)
        have = [w for w in st["world"] if WORLD_BY_ID[w["id"]]["stage"] == stage]
        if rule.get("always"):
            if len(have) < rule["max"] and (st["turn"] <= 1 or g.rng.random() < rule["p"]):
                low = st["turn"] <= 1 or len(have) < rule.get("min", 0)
                _spawn_random(g, stage, count=min(2 if low else 1, rule["max"] - len(have)))
            continue
        walkers = [q for q in g.players
                   if stage_of(g.board.nodes.get(q.node, {})) == stage]
        if walkers and len(have) < rule["max"] and g.rng.random() < rule["p"]:
            low = len(have) < rule.get("min", 0)
            _spawn_random(g, stage, near=g.rng.choice(walkers).node,
                          count=min(2 if low else 1, rule["max"] - len(have)))


def _spawn_random(g, stage: str, count: int = 1, near: str | None = None):
    st = _st(g)
    have = {w["id"] for w in st["world"]}
    for _ in range(count):
        pool = [w for w in WORLD if w["stage"] == stage and w["id"] not in have]
        if not pool:
            return
        spec = g.rng.choices(pool, weights=[w.get("weight", 3) for w in pool])[0]
        if spawn_world(g, spec["id"], near=near):
            have.add(spec["id"])


def _shown_to(g, viewer_pid, nid) -> bool:
    owner = g.board.nodes.get(nid, {}).get("owner")
    return owner is None or owner == viewer_pid


# ═══ snapshot ══════════════════════════════════════════════════════════════
def _public_event(g, act: dict, viewer: str | None) -> dict:
    view = {k: act[k] for k in ("id", "pid", "kind", "title", "text", "art",
                                "stage", "step", "options") if k in act}
    view["intro"] = act.get("intro")
    view["bets"] = dict(act.get("bets", {}))
    if act.get("game"):
        view["game"] = EG.public(act["game"])
    if act.get("puzzle"):
        view["puzzle"] = {"kind": act["puzzle"]["kind"]}
    if act.get("table"):
        t = act["table"]
        tv = {k: v for k, v in t["st"].items() if k not in ("secret",)}
        view["table"] = {"st": tv, "answered": sorted(t["answers"]),
                         "deadline": t["deadline"], "prompt": t.get("prompt", ""),
                         "mine": t["answers"].get(viewer) if viewer else None,
                         "mine_in": bool(viewer and viewer in t["answers"])}
    return view


def snapshot(g, viewer_pid: str | None, shown) -> dict:
    st = _st(g)
    act = st["active"]
    ev = None
    if act and g.phase in ("event", "minigame"):
        ev = _public_event(g, act, viewer_pid)
    world = []
    for w in st["world"]:
        if not shown(w["node"]):
            continue
        spec = WORLD_BY_ID[w["id"]]
        world.append({"wid": w["wid"], "id": w["id"], "title": spec["title"],
                      "text": spec["text"], "art": spec.get("art", "sea"),
                      "model": spec.get("model", w["id"]), "node": w["node"],
                      "rounds": w["rounds"], "radius": spec.get("radius", 0)})
    return {"event": ev, "event_card": st["card"], "world": world,
            "event_info": {"buffs": {k: {"name": v["name"], "desc": v["desc"],
                                         "good": v["good"]} for k, v in BUFFS.items()},
                           "games": EG.GAME_LABEL}}


# ═══ dev hook ══════════════════════════════════════════════════════════════
def dev_force(g, pid: str, eid: str):
    """DEV: fire event ``eid`` (or spawn world entity ``eid``) on the
    caller's stop right now, whatever their phase."""
    p = g.player_by_pid(pid)
    if not p:
        return
    if eid in WORLD_BY_ID:
        st = _st(g)
        st["world"] = [w for w in st["world"] if w["id"] != eid]
        w = spawn_world(g, eid, near=p.node)
        if w is not None:
            nbrs = [nb for nb in g.board.neighbors.get(p.node, ())
                    if node_class(g, nb) == "sea"
                    and stage_of(g.board.nodes[nb]) == WORLD_BY_ID[eid]["stage"]]
            if nbrs:
                w["node"] = nbrs[0]
        return
    ev = EVENTS_BY_ID.get(eid)
    if not ev:
        _err("No such event.")
    idx = next((i for i, q in enumerate(g.players) if q.pid == pid), None)
    g._abandon_turn()
    g._clear_turn_state()
    if idx is not None:
        g.turn_idx = idx
    start(g, p, p.node, ev)


def bot_wonder_score(g, p, nid: str):
    """Route intent for a philosopher (bots._target_score): a world wonder on
    ``nid`` it would sail for (the merchant with scrolls to spend, a wreck,
    dolphins when far from home) or shun (a serpent or hound unless the hull
    is sound). None: no opinion — score the stop as usual."""
    for w in _st(g)["world"]:
        if w["node"] != nid or p.pid in w["met"]:
            continue
        kind = w["id"]
        if kind in ("serpent", "hound"):
            return 20 if p.hull >= p.max_hull - 1 and p.hull >= 5 else -1
        if kind in ("whirlpool", "fog"):
            return -1
        if kind == "merchant":
            return 30 if p.scrolls >= 3 else 8
        if kind in ("wreck", "festival", "feymarket", "dolphins"):
            return 25
        if kind == "ring":
            return 10
        # realm wonders say what a bot thinks of them in their record ("bot")
        pref = WORLD_BY_ID.get(kind, {}).get("bot")
        if pref == "fight":
            return 20 if p.hull >= p.max_hull - 1 and p.hull >= 5 else -1
        if pref == "shun":
            return -1
        if pref == "shop":
            return 30 if p.scrolls >= 3 else 8
        if pref == "seek":
            return 25
        if pref == "curious":
            return 10
    return None

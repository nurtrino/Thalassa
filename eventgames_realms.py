"""
Event mini-games for the REALMS (the Frostfang Reach and the Verdigris Deep),
registered into ``eventgames.GAMES`` / ``GAME_LABEL`` at import. Same contract
as every kind in eventgames.py: ``gen(rng, params)``, ``move(st, payload,
rng)`` (a ValueError leaves the state untouched), ``bot(st, rng, skill)``,
``solve(st)`` (a strong line — it may read the secret, the fuzzer only needs
a winning line to exist), and an idle default ("stop" cashes out, None
forfeits). Every one is turn-based thinking: no clocks, no reflexes.

  floe    cross a floe field row by row. Each hop goes to the next row, at
          most one column aside. The floe you stand on tells how many of the
          floes you could hop to are THIN; a sounding pole tests one floe;
          the bear's footprints mark one sound floe in every other row.
          Stop on any floe to cash out what you have crossed; a thin floe
          sends you swimming with nothing.
  pairs   a memory match: twelve face-down tiles, six pairs, a fixed number
          of tries (a try = turning two tiles). No clock at all; tiles you
          have already seen are marked "seen". Stop whenever you like.
  drums   "what beat comes next?" — three rounds, each a row of drum
          patterns (BOOM and tak) following a rule; pick the next one of
          four.
  plates  the lost temple's pressure plates: press the four plates in the
          one order that fits the carved clues. A wrong plate pops them all
          back up and costs a dart (you can survive two).
"""
from __future__ import annotations

import itertools
import random


def _need(cond: bool, msg: str = "Malformed move."):
    if not cond:
        raise ValueError(msg)


def _is_int(v) -> bool:
    return type(v) is int


def _end(state: dict, result: str, score: int = 0):
    state["done"] = True
    state["result"] = result
    state["score"] = score


def _dict_key(payload, key):
    """The int under ``key`` of a one-key dict payload, or a ValueError."""
    _need(isinstance(payload, dict) and set(payload) == {key}, "Malformed move.")
    v = payload[key]
    _need(_is_int(v), "Malformed move.")
    return v


# ═══ floe — cross the floe field ═════════════════════════════════════════════
def _floe_reach(st, row=None, col=None):
    """Columns of the next row reachable from (row, col); the shore reaches all."""
    row = st["row"] if row is None else row
    col = st["col"] if col is None else col
    if row + 1 >= st["rows"]:
        return []
    if col is None:
        return list(range(st["cols"]))
    return [c for c in (col - 1, col, col + 1) if 0 <= c < st["cols"]]


def _floe_ok(thin, rows, cols):
    """Every sound floe (and the shore) can reach a sound floe in the next row."""
    for r in range(-1, rows - 1):
        starts = [None] if r < 0 else [c for c in range(cols) if c not in thin[r]]
        for c in starts:
            reach = range(cols) if c is None else [x for x in (c - 1, c, c + 1) if 0 <= x < cols]
            if all(x in thin[r + 1] for x in reach):
                return False
    return True


def gen_floe(rng, params):
    rows = max(3, min(8, int(params.get("rows", 6))))
    cols = max(3, min(5, int(params.get("cols", 4))))
    for _ in range(400):
        # the bear's way across: a random walk, always sound
        bear = [rng.randrange(cols)]
        for _r in range(rows - 1):
            bear.append(max(0, min(cols - 1, bear[-1] + rng.choice((-1, 0, 1)))))
        thin = []
        for r in range(rows):
            n = rng.choice((1, 1, 2)) if r else 1
            free = [c for c in range(cols) if c != bear[r]]
            thin.append(sorted(rng.sample(free, n)))
        if _floe_ok(thin, rows, cols):
            break
    else:                                             # pragma: no cover
        thin = [[(bear[r] + 2) % cols] for r in range(rows)]
    known = {}
    for r in range(1, rows, 2):                       # footprints on every other row
        known[f"{r},{bear[r]}"] = "print"
    st = {"kind": "floe", "rows": rows, "cols": cols, "row": -1, "col": None,
          "poles": int(params.get("poles", 3)), "goal": int(params.get("goal", 3)),
          "known": known, "path": [], "near": 0, "done": False, "result": None,
          "score": 0, "secret": {"thin": thin}}
    st["near"] = _floe_near(st)
    return st


def _floe_near(st):
    if st["row"] + 1 >= st["rows"]:
        return 0
    thin = st["secret"]["thin"][st["row"] + 1]
    return sum(1 for c in _floe_reach(st) if c in thin)


def move_floe(st, payload, rng):
    _need(not st["done"], "The game is over.")
    if payload == "stop":
        crossed = st["row"] + 1
        _end(st, "win" if crossed >= st["goal"] else "lose", crossed)
        return
    _need(isinstance(payload, dict) and len(payload) == 1
          and ("hop" in payload or "sound" in payload), "Hop or sound a floe.")
    act = "hop" if "hop" in payload else "sound"
    c = payload[act]
    _need(_is_int(c) and c in _floe_reach(st), "You can only reach the floes just ahead.")
    r = st["row"] + 1
    key = f"{r},{c}"
    thin = c in st["secret"]["thin"][r]
    if act == "sound":
        _need(st["poles"] > 0, "Your sounding poles are spent.")
        _need(key not in st["known"], "You already know that floe.")
        st["poles"] -= 1
        st["known"][key] = "thin" if thin else "sound"
        return
    st["path"].append(c)
    if thin:
        st["known"][key] = "thin"
        st["row"], st["col"] = r, c
        st["splash"] = True
        _end(st, "lose", 0)
        return
    st["known"].setdefault(key, "sound")
    st["row"], st["col"] = r, c
    if r + 1 >= st["rows"]:
        _end(st, "win", st["rows"])
        return
    st["near"] = _floe_near(st)


def _floe_safe_next(st):
    """Reachable columns known to be sound (prints, soundings)."""
    r = st["row"] + 1
    return [c for c in _floe_reach(st) if st["known"].get(f"{r},{c}") in ("print", "sound")]


def solve_floe(st):
    if st["done"] or st["row"] + 1 >= st["rows"]:
        return "stop"
    thin = st["secret"]["thin"][st["row"] + 1]
    safe = [c for c in _floe_reach(st) if c not in thin]
    return {"hop": safe[0]} if safe else "stop"


def bot_floe(st, rng, skill=0.5):
    if st["done"] or st["row"] + 1 >= st["rows"]:
        return "stop"
    r = st["row"] + 1
    reach = _floe_reach(st)
    safe = _floe_safe_next(st)
    if safe:
        return {"hop": rng.choice(safe)}
    unknown = [c for c in reach if f"{r},{c}" not in st["known"]]
    if st["near"] == 0 and unknown:
        return {"hop": rng.choice(unknown)}
    if st["poles"] > 0 and unknown:
        return {"sound": rng.choice(unknown)}
    if st["row"] + 1 >= st["goal"] and rng.random() < 0.75:
        return "stop"
    if rng.random() < 0.3 + 0.6 * skill:
        return solve_floe(st)
    return {"hop": rng.choice(unknown or reach)}


# ═══ pairs — a memory match with no clock ════════════════════════════════════
def gen_pairs(rng, params):
    pairs = max(3, min(8, int(params.get("pairs", 6))))
    faces = [f for f in range(pairs) for _ in range(2)]
    rng.shuffle(faces)
    n = len(faces)
    return {"kind": "pairs", "n": n, "pairs": pairs, "set": str(params.get("set", "ice")),
            "tries": int(params.get("tries", 12)), "goal": int(params.get("goal", 3)),
            "found": 0, "matched": [None] * n, "seen": [False] * n, "open": None,
            "last": None, "done": False, "result": None, "score": 0,
            "secret": {"faces": faces}}


def move_pairs(st, payload, rng):
    _need(not st["done"], "The game is over.")
    if payload == "stop":
        _need(st["open"] is None, "Turn the second tile first.")
        _end(st, "win" if st["found"] >= st["goal"] else "lose", st["found"])
        return
    i = _dict_key(payload, "flip")
    _need(0 <= i < st["n"], "No such tile.")
    _need(st["matched"][i] is None, "That pair is already matched.")
    _need(st["open"] is None or st["open"]["i"] != i, "That tile is already turned.")
    face = st["secret"]["faces"][i]
    if st["open"] is None:
        st["open"] = {"i": i, "face": face}
        st["last"] = None
        st["seen"][i] = True
        return
    j, fj = st["open"]["i"], st["open"]["face"]
    st["seen"][i] = True
    st["open"] = None
    st["tries"] -= 1
    match = fj == face
    st["last"] = {"a": j, "fa": fj, "b": i, "fb": face, "match": match}
    if match:
        st["matched"][i] = st["matched"][j] = face
        st["found"] += 1
    if st["found"] >= st["pairs"]:
        _end(st, "win", st["found"])
    elif st["tries"] <= 0:
        _end(st, "win" if st["found"] >= st["goal"] else "lose", st["found"])


def solve_pairs(st):
    if st["done"]:
        return "stop"
    faces = st["secret"]["faces"]
    if st["open"] is not None:
        i = st["open"]["i"]
        return {"flip": next(j for j in range(st["n"]) if j != i and faces[j] == faces[i])}
    return {"flip": next(j for j in range(st["n"]) if st["matched"][j] is None)}


def bot_pairs(st, rng, skill=0.5):
    """A captain with a decent (not perfect) memory of the tiles they saw."""
    if st["done"]:
        return "stop"
    faces = st["secret"]["faces"]
    live = [j for j in range(st["n"]) if st["matched"][j] is None]
    remember = 0.45 + 0.45 * skill
    if st["open"] is not None:
        i = st["open"]["i"]
        partner = next(j for j in live if j != i and faces[j] == faces[i])
        if st["seen"][partner] and rng.random() < remember:
            return {"flip": partner}
        fresh = [j for j in live if j != i and not st["seen"][j]]
        return {"flip": rng.choice(fresh or [j for j in live if j != i])}
    if st["tries"] <= 2 and st["found"] >= st["goal"] and rng.random() < 0.5:
        return "stop"
    seen = [j for j in live if st["seen"][j]]
    for j in seen:
        if any(k != j and faces[k] == faces[j] for k in seen) and rng.random() < remember:
            return {"flip": j}
    fresh = [j for j in live if not st["seen"][j]]
    return {"flip": rng.choice(fresh or live)}


# ═══ drums — what beat comes next? ═══════════════════════════════════════════
BEATS_ = "Bt"               # B = BOOM (the low drum), t = tak (the high drum)


def _flip(c):
    return "t" if c == "B" else "B"


def _drum_rule(rng, level):
    """(name, four terms, answer) for a rule of roughly this difficulty."""
    r = rng.choice({0: ("grow", "alternate", "count"),
                    1: ("rotate", "count", "grow", "mirror"),
                    2: ("rotate", "fill", "sandwich", "mirror")}[min(2, level)])
    if r == "grow":                       # one more beat of the same drum each time
        base = rng.choice(("B", "t", "Bt", "tB"))
        x = rng.choice(BEATS_)
        seq = [base + x * k for k in range(5)]
    elif r == "alternate":                # two patterns taking turns
        a = "".join(rng.choice(BEATS_) for _ in range(3))
        b = a[::-1] if a[::-1] != a else _flip(a[0]) + a[1:]
        seq = [a, b, a, b, a]
    elif r == "count":                    # BOOMs grow, the tak stays
        x, y = rng.sample(BEATS_, 2)
        seq = [x * k + y for k in range(1, 6)]
    elif r == "rotate":                   # the pattern turns one beat each time
        while True:
            a = "".join(rng.choice(BEATS_) for _ in range(4))
            if len({a[k:] + a[:k] for k in range(4)}) == 4:
                break
        seq = [a[k:] + a[:k] for k in range(5)]
    elif r == "mirror":                   # a pattern, then its echo, growing
        a = "".join(rng.choice(BEATS_) for _ in range(2))
        if a[0] == a[1]:
            a = a[0] + _flip(a[0])
        x = a[1]                          # (a + a[0] would read the same both ways)
        seq = [a, a[::-1], a + x, (a + x)[::-1], a + x + x]
    elif r == "fill":                     # one drum takes over, a beat at a time
        x = rng.choice(BEATS_)
        y = _flip(x)
        seq = [x * k + y * (5 - k) for k in range(5)]
    else:                                 # sandwich: one drum wraps the other
        x = rng.choice(BEATS_)
        y = _flip(x)
        seq = [x * k + y + x * k for k in range(5)]
    return r, seq[:4], seq[4]


def _drum_round(rng, level):
    for _ in range(50):
        rule, seq, ans = _drum_rule(rng, level)
        wrong = set()
        tries = 0
        while len(wrong) < 3 and tries < 60:
            tries += 1
            k = rng.randrange(4)
            if k == 0 and len(ans) > 1:          # drop the last beat
                w = ans[:-1]
            elif k == 1:                         # one beat flipped
                i = rng.randrange(len(ans))
                w = ans[:i] + _flip(ans[i]) + ans[i + 1:]
            elif k == 2:                         # an extra beat
                w = ans + rng.choice(BEATS_)
            else:                                # repeat the last term
                w = seq[-1]
            if w and w != ans:
                wrong.add(w)
        wrong.discard(ans)
        if len(wrong) >= 3:
            choices = [ans] + sorted(wrong)[:3]
            rng.shuffle(choices)
            return {"seq": seq, "choices": choices, "level": level}, choices.index(ans), rule
    return {"seq": ["B", "BB", "BBB", "BBBB"], "choices": ["BBBBB", "BBBB", "BBBt", "tBBBB"],
            "level": level}, 0, "count"


def gen_drums(rng, params):
    rounds = max(1, min(5, int(params.get("rounds", 3))))
    st = {"kind": "drums", "rounds": rounds, "need": int(params.get("need", 2)),
          "round": 1, "right": 0, "history": [], "done": False, "result": None,
          "score": 0, "secret": {}}
    rd, ans, rule = _drum_round(rng, 0)
    st.update(rd)
    st["secret"] = {"ans": ans, "rule": rule}
    return st


def move_drums(st, payload, rng):
    _need(not st["done"], "The game is over.")
    i = _dict_key(payload, "pick")
    _need(0 <= i < len(st["choices"]), "Pick one of the four patterns.")
    ans = st["secret"]["ans"]
    right = i == ans
    st["right"] += right
    st["history"].append({"seq": st["seq"], "pick": st["choices"][i],
                          "was": st["choices"][ans], "right": right})
    if st["round"] >= st["rounds"]:
        _end(st, "win" if st["right"] >= st["need"] else "lose", st["right"])
        return
    st["round"] += 1
    rd, ans, rule = _drum_round(rng, st["round"] - 1)
    st.update(rd)
    st["secret"] = {"ans": ans, "rule": rule}


def solve_drums(st):
    return {"pick": st["secret"].get("ans", 0)}


def bot_drums(st, rng, skill=0.5):
    if rng.random() < 0.45 + 0.4 * skill - 0.08 * st.get("level", 0):
        return solve_drums(st)
    return {"pick": rng.randrange(len(st.get("choices") or [0]))}


# ═══ plates — the lost temple's pressure plates ═════════════════════════════
PLATES = ("sun", "moon", "jaguar", "serpent")


def _clue_true(c, order):
    pos = {p: i for i, p in enumerate(order)}
    k = c[0]
    if k == "before":
        return pos[c[1]] < pos[c[2]]
    if k == "next":
        return pos[c[2]] == pos[c[1]] + 1
    if k == "first":
        return pos[c[1]] == 0
    if k == "last":
        return pos[c[1]] == len(order) - 1
    if k == "not_first":
        return pos[c[1]] != 0
    if k == "not_last":
        return pos[c[1]] != len(order) - 1
    if k == "not_next":
        return abs(pos[c[1]] - pos[c[2]]) != 1
    return False


def _clue_text(c, names):
    n = [names[i].upper() for i in c[1:]]
    return {"before": "The {0} plate sinks before the {1} plate.",
            "next": "The {1} plate is pressed straight after the {0}.",
            "first": "The {0} plate is pressed first.",
            "last": "The {0} plate is pressed last.",
            "not_first": "The {0} plate is not pressed first.",
            "not_last": "The {0} plate is not pressed last.",
            "not_next": "The {0} and the {1} are never pressed one after the other.",
            }[c[0]].format(*n)


def _plates_consistent(clues, n):
    return [list(o) for o in itertools.permutations(range(n))
            if all(_clue_true(c, o) for c in clues)]


def gen_plates(rng, params):
    n = len(PLATES)
    for _ in range(200):
        order = list(range(n))
        rng.shuffle(order)
        clues = []
        for _k in range(40):
            kind = rng.choice(("before", "before", "next", "first", "last",
                               "not_first", "not_last", "not_next"))
            a, b = rng.sample(range(n), 2)
            c = (kind, a, b) if kind in ("before", "next", "not_next") else (kind, a)
            if c in clues or not _clue_true(c, order):
                continue
            clues.append(c)
            if len(_plates_consistent(clues, n)) == 1:
                break
        if len(_plates_consistent(clues, n)) != 1:
            continue
        for c in list(clues):                    # trim the redundant ones
            rest = [x for x in clues if x != c]
            if len(_plates_consistent(rest, n)) == 1:
                clues = rest
        if 2 <= len(clues) <= 5:
            break
    else:                                        # pragma: no cover — a plain fallback
        clues = [("first", order[0]), ("next", order[0], order[1]), ("last", order[3])]
    rng.shuffle(clues)
    return {"kind": "plates", "plates": list(PLATES), "n": n,
            "clues": [_clue_text(c, PLATES) for c in clues],
            "pressed": [], "darts": int(params.get("darts", 2)), "log": [],
            "done": False, "result": None, "score": 0,
            "secret": {"order": order, "rules": [list(c) for c in clues]}}


def move_plates(st, payload, rng):
    _need(not st["done"], "The game is over.")
    i = _dict_key(payload, "press")
    _need(0 <= i < st["n"], "No such plate.")
    _need(i not in st["pressed"], "That plate is already down.")
    order = st["secret"]["order"]
    if order[len(st["pressed"])] == i:
        st["pressed"].append(i)
        st["log"].append({"plate": i, "ok": True})
        if len(st["pressed"]) == st["n"]:
            _end(st, "win", st["darts"] + 1)
        return
    st["log"].append({"plate": i, "ok": False, "after": list(st["pressed"])})
    st["pressed"] = []
    if st["darts"] <= 0:
        _end(st, "lose", 0)
        return
    st["darts"] -= 1


def _plates_next(st):
    rules = [tuple(c) for c in st["secret"]["rules"]]
    cands = [o for o in _plates_consistent(rules, st["n"]) if o[:len(st["pressed"])] == st["pressed"]]
    return cands[0][len(st["pressed"])] if cands else st["secret"]["order"][len(st["pressed"])]


def solve_plates(st):
    if st["done"]:
        return {"press": 0}
    return {"press": _plates_next(st)}


def bot_plates(st, rng, skill=0.5):
    if st["done"]:
        return {"press": 0}
    if rng.random() < 0.55 + 0.4 * skill:
        return solve_plates(st)
    return {"press": rng.choice([i for i in range(st["n"]) if i not in st["pressed"]])}


# ── registry (merged into eventgames.GAMES by eventgames.py) ────────────────
GAMES = {
    "floe": (gen_floe, move_floe, bot_floe, solve_floe, "stop"),
    "pairs": (gen_pairs, move_pairs, bot_pairs, solve_pairs, "stop"),
    "drums": (gen_drums, move_drums, bot_drums, solve_drums, None),
    "plates": (gen_plates, move_plates, bot_plates, solve_plates, None),
}
LABELS = {
    "floe": "The Floe Field", "pairs": "Matching Pairs",
    "drums": "What Beat Comes Next?", "plates": "The Pressure Plates",
}

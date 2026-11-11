"""
Event mini-games — small, self-contained, SERVER-AUTHORITATIVE games that an
event can deal (see events.py). Every one is turn-based or untimed thinking:
nothing here rewards fast hands. Two families:

SOLO games (one captain plays, rivals watch and may bet):

  knucklebones  push-your-luck: throw the astragalos (faces 1·3·4·6); a 1
                ("the dog") busts the pot. Stop whenever you like.
  higher_lower  the oracle's tiles 1–9 (two of each): call the next tile
                higher or lower. The spent tiles are public — count them.
  codebreak     a three-glyph seal from four glyphs (no repeats); five tries,
                each answered with "placed" / "present" counts.
  shells        three cups, three signs; the rule says how many signs tell
                the truth. Pure deduction — exactly one cup is consistent.
  weigh         nine amphorae, one heavier; a balance and three weighings.
  crossing      ferry a wolf, a goat and your charts across a strait; the
                skiff holds you and one more. Leave the wrong pair alone
                and something gets eaten.
  rps           stone / scroll / shears against a satyr. Each round he
                shows a TELL; his tells never lie, but you must learn them.
  nim           a philosopher's pebble pile: take 1–3, whoever takes the
                last pebble wins. He errs now and then.
  haggle        a trader with a hidden reserve price: offer, hear "an
                insult" or "tempting", offer higher; the closer your deal
                to his reserve, the better. His patience runs out.

TABLE games (everyone at the table answers at once, sealed):

  bid           sealed-bid auction for a prize (highest bid pays and wins)
  guess         closest guess to a hidden number wins
  vote          majority picks one of the options; it applies to all
  gamble        ante in or stay out; one throw decides for everyone in
  lanes         a regatta: each captain secretly picks a lane
  lowest        lowest UNIQUE number wins
  race          back one runner of a field with public form; the server
                runs the race and pays the winner's backers its purse

API (every kind): ``gen(rng, params) -> state`` (public fields + a
``secret`` dict that never leaves the server), ``move(state, payload, rng)``
(raises ValueError for a malformed or illegal payload WITHOUT mutating the
state; sets ``state["done"]`` and ``state["result"]`` = "win" | "lose" plus
``state["score"]`` when it ends), ``bot(state, rng, skill)`` → a payload a
sensible (not optimal) captain would send, ``solve(state)`` → a strong
payload for the harness, ``idle(state)`` → the safe default payload (or
None: forfeit via ``forfeit(state)``). ``public(state)`` strips the secret.

Table kinds: ``gen_table(kind, rng, params)``, ``table_valid(kind, st,
value, player)`` and ``table_default`` / ``table_bot`` — resolution lives in
events.py because it touches the players.
"""
from __future__ import annotations

import itertools
import random

# ── shared helpers ──────────────────────────────────────────────────────────


def _need(cond: bool, msg: str = "Malformed move."):
    if not cond:
        raise ValueError(msg)


def _is_int(v) -> bool:
    return type(v) is int


def public(state: dict) -> dict:
    """The state as a client may see it: no secret, no private RNG plumbing."""
    return {k: v for k, v in state.items() if k != "secret"}


def _end(state: dict, result: str, score: int = 0):
    state["done"] = True
    state["result"] = result
    state["score"] = score


# ═══ knucklebones (push-your-luck) ═══════════════════════════════════════════
KNUCKLE_FACES = (1, 3, 4, 6)      # 1 = "the dog": bust


def gen_knucklebones(rng, params):
    return {"kind": "knucklebones", "pot": 0, "throws": [], "done": False,
            "result": None, "score": 0, "cap": int(params.get("cap", 24)),
            "goals": list(params.get("goals", [6, 12, 18])), "secret": {}}


def move_knucklebones(st, payload, rng):
    _need(payload in ("throw", "stop"))
    _need(not st["done"], "The game is over.")
    if payload == "stop":
        _end(st, "win" if st["pot"] >= st["goals"][0] else "lose", st["pot"])
        return
    face = rng.choice(KNUCKLE_FACES)
    st["throws"].append(face)
    if face == 1:
        st["pot"] = 0
        _end(st, "lose", 0)
        st["bust"] = True
        return
    st["pot"] += face
    if st["pot"] >= st["cap"]:
        _end(st, "win", st["pot"])


def bot_knucklebones(st, rng, skill=0.5):
    stop_at = 9 + int(skill * 6) + rng.randint(-2, 2)
    return "stop" if st["pot"] >= stop_at else "throw"


def solve_knucklebones(st):
    return "stop" if st["pot"] >= 12 else "throw"


# ═══ higher or lower (the oracle's tiles) ════════════════════════════════════
def gen_higher_lower(rng, params):
    deck = [v for v in range(1, 10) for _ in range(2)]
    rng.shuffle(deck)
    first = deck.pop()
    return {"kind": "higher_lower", "tile": first, "spent": [first],
            "streak": 0, "need": int(params.get("need", 5)),
            "done": False, "result": None, "score": 0,
            "secret": {"deck": deck}}


def _hl_odds(st):
    left = [v for v in range(1, 10) for _ in range(2)]
    for v in st["spent"]:
        left.remove(v)
    hi = sum(1 for v in left if v > st["tile"])
    lo = sum(1 for v in left if v < st["tile"])
    return hi, lo, len(left)


def move_higher_lower(st, payload, rng):
    _need(payload in ("higher", "lower", "stop"))
    _need(not st["done"], "The game is over.")
    if payload == "stop":
        _end(st, "win" if st["streak"] >= 2 else "lose", st["streak"])
        return
    deck = st["secret"]["deck"]
    _need(bool(deck), "The tiles are spent.")
    nxt = deck.pop()
    prev = st["tile"]
    st["tile"] = nxt
    st["spent"].append(nxt)
    st["last"] = {"call": payload, "from": prev, "to": nxt}
    if nxt == prev:
        return                                   # a tie: no harm, no streak
    right = (nxt > prev) == (payload == "higher")
    if not right:
        _end(st, "lose", 0)
        return
    st["streak"] += 1
    if st["streak"] >= st["need"] or not deck:
        _end(st, "win", st["streak"])


def bot_higher_lower(st, rng, skill=0.5):
    hi, lo, n = _hl_odds(st)
    best = max(hi, lo) / max(1, n)
    if st["streak"] >= 2 and best < 0.55 + 0.1 * rng.random():
        return "stop"
    if st["streak"] >= 3 and rng.random() < 0.5:
        return "stop"
    if rng.random() > 0.6 + skill * 0.4:
        return rng.choice(["higher", "lower"])
    return "higher" if hi >= lo else "lower"


def solve_higher_lower(st):
    hi, lo, n = _hl_odds(st)
    if st["streak"] >= 2 and max(hi, lo) / max(1, n) < 0.7:
        return "stop"
    return "higher" if hi >= lo else "lower"


# ═══ codebreak (mastermind-lite) ═════════════════════════════════════════════
CODE_GLYPHS = 4
CODE_LEN = 3


def gen_codebreak(rng, params):
    code = rng.sample(range(CODE_GLYPHS), CODE_LEN)
    return {"kind": "codebreak", "glyphs": CODE_GLYPHS, "length": CODE_LEN,
            "tries": int(params.get("tries", 6)), "guesses": [],
            "done": False, "result": None, "score": 0,
            "secret": {"code": code}}


def _code_feedback(code, guess):
    placed = sum(1 for a, b in zip(code, guess) if a == b)
    present = len(set(code) & set(guess)) - placed
    return placed, present


def _valid_code(g, n=CODE_LEN):
    return (isinstance(g, list) and len(g) == n and all(_is_int(x) for x in g)
            and all(0 <= x < CODE_GLYPHS for x in g) and len(set(g)) == n)


def move_codebreak(st, payload, rng):
    _need(_valid_code(payload), "Choose three different glyphs.")
    _need(not st["done"], "The game is over.")
    placed, present = _code_feedback(st["secret"]["code"], payload)
    st["guesses"].append({"glyphs": list(payload), "placed": placed,
                          "present": present})
    if placed == CODE_LEN:
        _end(st, "win", st["tries"] - len(st["guesses"]) + 1)
    elif len(st["guesses"]) >= st["tries"]:
        _end(st, "lose", 0)


def _code_consistent(st):
    out = []
    for cand in itertools.permutations(range(CODE_GLYPHS), CODE_LEN):
        if all(_code_feedback(list(cand), g["glyphs"]) == (g["placed"], g["present"])
               for g in st["guesses"]):
            out.append(list(cand))
    return out


def bot_codebreak(st, rng, skill=0.5):
    cands = _code_consistent(st)
    if cands and rng.random() < 0.55 + skill * 0.45:
        return rng.choice(cands)
    return rng.sample(range(CODE_GLYPHS), CODE_LEN)


def solve_codebreak(st):
    cands = _code_consistent(st)
    return cands[0] if cands else [0, 1, 2]


# ═══ shells (a deduction cup game) ═══════════════════════════════════════════
CUP_NAMES = ("left", "middle", "right")


def _sign_text(sign, cup):
    kind, k = sign
    if kind == "here":
        return "The pearl is under this cup."
    if kind == "not_here":
        return "The pearl is not under this cup."
    if kind == "is":
        return f"The pearl is under the {CUP_NAMES[k]} cup."
    if kind == "not":
        return f"The pearl is not under the {CUP_NAMES[k]} cup."
    if kind == "left_of":
        return "The pearl is somewhere to the left of this cup."
    return "The pearl is somewhere to the right of this cup."


def _sign_true(sign, cup, pearl):
    kind, k = sign
    return {"here": pearl == cup, "not_here": pearl != cup, "is": pearl == k,
            "not": pearl != k, "left_of": pearl < cup,
            "right_of": pearl > cup}[kind]


def _shell_solutions(signs, truths):
    return [p for p in range(3)
            if sum(_sign_true(s, c, p) for c, s in enumerate(signs)) == truths]


def gen_shells(rng, params):
    kinds = ["here", "not_here", "is", "not", "left_of", "right_of"]
    for _ in range(500):
        signs = []
        for cup in range(3):
            kind = rng.choice(kinds)
            if kind == "left_of" and cup == 0:
                kind = "right_of"
            if kind == "right_of" and cup == 2:
                kind = "left_of"
            signs.append((kind, rng.randrange(3)))
        truths = rng.choice([1, 1, 2])
        sols = _shell_solutions(signs, truths)
        if len(sols) == 1:
            return {"kind": "shells", "truths": truths,
                    "signs": [_sign_text(s, c) for c, s in enumerate(signs)],
                    "done": False, "result": None, "score": 0, "picked": None,
                    "secret": {"pearl": sols[0],
                               "rules": [list(s) for s in signs]}}
    # a fallback that is always unique
    signs = [("not_here", 0), ("not", 0), ("here", 0)]
    return {"kind": "shells", "truths": 1,
            "signs": [_sign_text(s, c) for c, s in enumerate(signs)],
            "done": False, "result": None, "score": 0, "picked": None,
            "secret": {"pearl": _shell_solutions(signs, 1)[0],
                       "rules": [list(s) for s in signs]}}


def move_shells(st, payload, rng):
    _need(_is_int(payload) and 0 <= payload < 3, "Pick a cup.")
    _need(not st["done"], "The game is over.")
    st["picked"] = payload
    st["pearl"] = st["secret"]["pearl"]          # revealed with the lift
    _end(st, "win" if payload == st["secret"]["pearl"] else "lose", 1)


def bot_shells(st, rng, skill=0.5):
    if rng.random() < 0.45 + skill * 0.5:
        return st["secret"]["pearl"]
    return rng.randrange(3)


def solve_shells(st):
    rules = [tuple(r) for r in st["secret"]["rules"]]
    return _shell_solutions(rules, st["truths"])[0]


# ═══ weigh the amphorae ══════════════════════════════════════════════════════
def gen_weigh(rng, params):
    n = int(params.get("jars", 9))
    return {"kind": "weigh", "jars": n, "weighings_left": int(params.get("weighings", 3)),
            "log": [], "done": False, "result": None, "score": 0, "picked": None,
            "secret": {"odd": rng.randrange(n)}}


def move_weigh(st, payload, rng):
    _need(isinstance(payload, dict), "Malformed move.")
    _need(not st["done"], "The game is over.")
    n = st["jars"]
    if "pick" in payload:
        k = payload["pick"]
        _need(_is_int(k) and 0 <= k < n, "Pick a jar.")
        st["picked"] = k
        st["odd"] = st["secret"]["odd"]
        _end(st, "win" if k == st["secret"]["odd"] else "lose", st["weighings_left"])
        return
    left, right = payload.get("left"), payload.get("right")
    _need(isinstance(left, list) and isinstance(right, list), "Malformed move.")
    _need(all(_is_int(x) and 0 <= x < n for x in left + right), "No such jar.")
    _need(len(set(left + right)) == len(left) + len(right), "A jar cannot be on both pans.")
    _need(bool(left) and bool(right), "Put jars on both pans.")
    _need(len(left) == len(right), "Weigh equal numbers of jars.")
    _need(st["weighings_left"] > 0, "The balance is spent — choose a jar.")
    odd = st["secret"]["odd"]
    tip = "left" if odd in left else ("right" if odd in right else "level")
    st["weighings_left"] -= 1
    st["log"].append({"left": sorted(left), "right": sorted(right), "tip": tip})


def _weigh_suspects(st):
    sus = set(range(st["jars"]))
    for w in st["log"]:
        if w["tip"] == "left":
            sus &= set(w["left"])
        elif w["tip"] == "right":
            sus &= set(w["right"])
        else:
            sus -= set(w["left"]) | set(w["right"])
    return sorted(sus)


def solve_weigh(st):
    sus = _weigh_suspects(st)
    if len(sus) == 1 or st["weighings_left"] <= 0:
        return {"pick": sus[0] if sus else 0}
    k = (len(sus) + 2) // 3
    return {"left": sus[:k], "right": sus[k:2 * k]}


def bot_weigh(st, rng, skill=0.5):
    sus = _weigh_suspects(st)
    if len(sus) == 1 or st["weighings_left"] <= 0:
        return {"pick": rng.choice(sus) if sus else 0}
    if rng.random() < 0.5 + skill * 0.5:
        return solve_weigh(st)
    k = max(1, len(sus) // 2)                   # the naive halving
    return {"left": sus[:k], "right": sus[k:2 * k]}


# ═══ the crossing (wolf, goat, charts) ═══════════════════════════════════════
CROSSERS = ("wolf", "goat", "charts")
_EATS = (("wolf", "goat"), ("goat", "charts"))


def gen_crossing(rng, params):
    return {"kind": "crossing", "near": list(CROSSERS), "far": [], "boat": "near",
            "trips": 0, "max_trips": int(params.get("max_trips", 11)),
            "done": False, "result": None, "score": 0, "eaten": None,
            "secret": {}}


def move_crossing(st, payload, rng):
    _need(isinstance(payload, dict) and "take" in payload, "Malformed move.")
    _need(not st["done"], "The game is over.")
    take = payload["take"]
    side = st["boat"]
    _need(take is None or (isinstance(take, str) and take in st[side]),
          "That is not on this bank.")
    other = "far" if side == "near" else "near"
    if take:
        st[side].remove(take)
        st[other].append(take)
    st["boat"] = other
    st["trips"] += 1
    left_alone = st[side]
    for a, b in _EATS:
        if a in left_alone and b in left_alone:
            st["eaten"] = [a, b]
            _end(st, "lose", 0)
            return
    if len(st["far"]) == 3:
        _end(st, "win", st["max_trips"] - st["trips"])
    elif st["trips"] >= st["max_trips"]:
        _end(st, "lose", 0)


def _crossing_key(st):
    return (tuple(sorted(st["near"])), st["boat"])


def _crossing_plan(st):
    from collections import deque
    start = (frozenset(st["near"]), st["boat"])
    q = deque([(start, [])])
    seen = {start}
    while q:
        (near, boat), path = q.popleft()
        if not near and boat == "far":
            return path
        bank = near if boat == "near" else frozenset(CROSSERS) - near
        for take in [None] + sorted(bank):
            nn = set(near)
            if take:
                if boat == "near":
                    nn.discard(take)
                else:
                    nn.add(take)
            nb = "far" if boat == "near" else "near"
            alone = nn if nb == "far" else set(CROSSERS) - nn
            if any(a in alone and b in alone for a, b in _EATS):
                continue
            key = (frozenset(nn), nb)
            if key not in seen:
                seen.add(key)
                q.append((key, path + [take]))
    return None


def solve_crossing(st):
    plan = _crossing_plan(st)
    return {"take": plan[0] if plan else None}


def bot_crossing(st, rng, skill=0.5):
    if rng.random() < 0.75 + skill * 0.25:
        return solve_crossing(st)
    side = st[st["boat"]]
    return {"take": rng.choice([None] + list(side))}


# ═══ stone · scroll · shears against a satyr with tells ══════════════════════
THROWS = ("stone", "scroll", "shears")
BEATS = {"stone": "shears", "scroll": "stone", "shears": "scroll"}   # key beats value
TELLS = ("He scratches his left horn.", "His tail flicks twice.",
         "He hums a goatish little tune.", "He stamps a hoof.",
         "He licks his lips.", "His ears go flat.")


def gen_rps(rng, params):
    tells = rng.sample(TELLS, 3)
    mapping = dict(zip(THROWS, tells))
    nxt = rng.choice(THROWS)
    return {"kind": "rps", "need": int(params.get("need", 3)), "you": 0, "satyr": 0,
            "rounds": [], "tell": mapping[nxt], "max_rounds": 9,
            "done": False, "result": None, "score": 0,
            "secret": {"next": nxt, "tells": mapping}}


def move_rps(st, payload, rng):
    _need(isinstance(payload, str) and payload in THROWS, "Throw stone, scroll or shears.")
    _need(not st["done"], "The game is over.")
    his = st["secret"]["next"]
    if BEATS[payload] == his:
        winner = "you"
        st["you"] += 1
    elif BEATS[his] == payload:
        winner = "satyr"
        st["satyr"] += 1
    else:
        winner = "tie"
    st["rounds"].append({"you": payload, "satyr": his, "tell": st["tell"],
                         "winner": winner})
    if st["you"] >= st["need"]:
        _end(st, "win", st["you"])
        return
    if st["satyr"] >= st["need"] or len(st["rounds"]) >= st["max_rounds"]:
        _end(st, "win" if st["you"] > st["satyr"] else "lose", st["you"])
        return
    nxt = rng.choice(THROWS)
    st["secret"]["next"] = nxt
    st["tell"] = st["secret"]["tells"][nxt]


def _rps_counter(throw):
    return next(t for t in THROWS if BEATS[t] == throw)


def bot_rps(st, rng, skill=0.5):
    learned = {r["tell"]: r["satyr"] for r in st["rounds"]}
    if st["tell"] in learned and rng.random() < 0.6 + skill * 0.4:
        return _rps_counter(learned[st["tell"]])
    return rng.choice(THROWS)


def solve_rps(st):
    return _rps_counter(st["secret"]["next"])


# ═══ nim with a philosopher ══════════════════════════════════════════════════
def gen_nim(rng, params):
    pile = rng.choice([13, 14, 15, 17, 18, 19])          # never a multiple of 4
    return {"kind": "nim", "pile": pile, "max_take": 3, "history": [],
            "err": float(params.get("err", 0.3)),
            "done": False, "result": None, "score": 0, "secret": {}}


def move_nim(st, payload, rng):
    _need(isinstance(payload, dict) and _is_int(payload.get("take")), "Take 1, 2 or 3.")
    _need(not st["done"], "The game is over.")
    k = payload["take"]
    _need(1 <= k <= min(st["max_take"], st["pile"]), "Take 1, 2 or 3 pebbles.")
    st["pile"] -= k
    st["history"].append({"who": "you", "take": k})
    if st["pile"] == 0:
        _end(st, "win", 1)
        return
    # the philosopher answers: leave a multiple of four — unless he muses
    best = st["pile"] % 4
    if best == 0 or rng.random() < st["err"]:
        his = rng.randint(1, min(3, st["pile"]))
    else:
        his = best
    st["pile"] -= his
    st["history"].append({"who": "sage", "take": his})
    if st["pile"] == 0:
        _end(st, "lose", 0)


def solve_nim(st):
    best = st["pile"] % 4
    return {"take": best if best else 1}


def bot_nim(st, rng, skill=0.5):
    if rng.random() < 0.5 + skill * 0.5:
        return solve_nim(st)
    return {"take": rng.randint(1, min(3, st["pile"]))}


# ═══ haggle (a bazaar trader with a hidden reserve price) ════════════════════
# The trader will sell for no less than a secret RESERVE price. Each offer
# below it is refused with an honest grumble — "an insult" (four or more
# short) or "tempting" (one to three short) — and costs him a little
# patience. An offer at or above the reserve is taken on the spot: the closer
# to his reserve, the better the bargain (score 4 = his very lowest price).
# The server keeps the deduced floor / ceiling public, so nobody has to do
# the bookkeeping in their head. No clock; pure judgement.
HAGGLE_INSULT = 4


def gen_haggle(rng, params):
    lo, hi = (int(x) for x in params.get("range", [2, 14]))
    return {"kind": "haggle", "lo": lo, "hi": hi, "floor": lo, "ceil": hi,
            "patience": int(params.get("patience", 4)), "offers": [],
            "done": False, "result": None, "score": 0, "paid": None,
            "secret": {"reserve": rng.randint(lo, hi)}}


def move_haggle(st, payload, rng):
    _need(isinstance(payload, dict) and _is_int(payload.get("offer")), "Name a price.")
    _need(not st["done"], "The game is over.")
    x = payload["offer"]
    _need(st["lo"] <= x <= st["hi"], f"Offer between {st['lo']} and {st['hi']}.")
    _need(all(x > o["offer"] for o in st["offers"]), "He has already refused that much.")
    res = st["secret"]["reserve"]
    if x >= res:
        st["offers"].append({"offer": x, "reply": "deal"})
        st["paid"] = x
        st["reserve"] = res                       # revealed with the handshake
        _end(st, "win", max(1, 4 - (x - res)))
        return
    gap = res - x
    if gap >= HAGGLE_INSULT:
        st["offers"].append({"offer": x, "reply": "insult"})
        st["floor"] = max(st["floor"], x + HAGGLE_INSULT)
    else:
        st["offers"].append({"offer": x, "reply": "close"})
        st["floor"] = max(st["floor"], x + 1)
        st["ceil"] = min(st["ceil"], x + HAGGLE_INSULT - 1)
    if len(st["offers"]) >= st["patience"]:
        st["reserve"] = res
        _end(st, "lose", 0)


def solve_haggle(st):
    left = st["patience"] - len(st["offers"])
    if left <= 1:
        return {"offer": st["ceil"]}              # the last word: a sure deal
    return {"offer": st["floor"]}                 # probe at the lowest he might take


def bot_haggle(st, rng, skill=0.5):
    if rng.random() < 0.5 + skill * 0.5:
        return solve_haggle(st)
    top = max([o["offer"] for o in st["offers"]] + [st["lo"] - 1])
    lo = max(st["floor"], top + 1)
    return {"offer": min(st["hi"], lo + rng.randint(0, 3))}


# ── the solo registry ───────────────────────────────────────────────────────
GAMES = {
    "knucklebones": (gen_knucklebones, move_knucklebones, bot_knucklebones,
                     solve_knucklebones, "stop"),
    "higher_lower": (gen_higher_lower, move_higher_lower, bot_higher_lower,
                     solve_higher_lower, "stop"),
    "codebreak": (gen_codebreak, move_codebreak, bot_codebreak, solve_codebreak, None),
    "shells": (gen_shells, move_shells, bot_shells, solve_shells, None),
    "weigh": (gen_weigh, move_weigh, bot_weigh, solve_weigh, None),
    "crossing": (gen_crossing, move_crossing, bot_crossing, solve_crossing, None),
    "rps": (gen_rps, move_rps, bot_rps, solve_rps, None),
    "nim": (gen_nim, move_nim, bot_nim, solve_nim, None),
    "haggle": (gen_haggle, move_haggle, bot_haggle, solve_haggle, None),
}

# what each game's idle default does when a captain walks away: games with a
# "stop" cash out what they hold; the rest are forfeited
GAME_LABEL = {
    "knucklebones": "Knucklebones", "higher_lower": "The Oracle's Tiles",
    "codebreak": "The Seal of Three", "shells": "The Cups and the Pearl",
    "weigh": "The Nine Amphorae", "crossing": "The Crossing",
    "rps": "Stone, Scroll, Shears", "nim": "The Philosopher's Pebbles",
    "haggle": "The Haggle",
}

# the realm kinds (floe, pairs, drums, plates) live in eventgames_realms.py
from eventgames_realms import GAMES as _REALM_GAMES, LABELS as _REALM_LABELS  # noqa: E402
GAMES.update(_REALM_GAMES)
GAME_LABEL.update(_REALM_LABELS)


def gen(kind: str, rng: random.Random, params: dict | None = None) -> dict:
    return GAMES[kind][0](rng, dict(params or {}))


def move(state: dict, payload, rng: random.Random) -> None:
    """Apply one move. A ValueError leaves ``state`` exactly as it was."""
    _need(not state.get("done"), "The game is over.")
    GAMES[state["kind"]][1](state, payload, rng)


def bot(state: dict, rng: random.Random, skill: float = 0.5):
    return GAMES[state["kind"]][2](state, rng, skill)


def solve(state: dict):
    return GAMES[state["kind"]][3](state)


def idle(state: dict):
    return GAMES[state["kind"]][4]


def forfeit(state: dict) -> None:
    """End the game where it stands (idle clock, kick): cash out a pot game,
    lose the rest."""
    if state.get("done"):
        return
    if GAMES[state["kind"]][4] == "stop":
        move(state, "stop", random.Random(0))
    else:
        _end(state, "lose", 0)


def junk_payloads(state: dict) -> list:
    """Malformed / illegal payloads the fuzzer throws at a game."""
    return [None, "", "zzz", -1, 99, 1.5, [], [9, 9, 9], [0, 0, 0], {},
            {"take": 7}, {"take": "dragon"}, {"pick": 99}, {"left": [0], "right": [0]},
            {"left": [0, 1], "right": [2]}, {"left": "x", "right": []}, True,
            [0, 1, 2, 3], "stone!", {"take": None, "x": 1},
            {"offer": -3}, {"offer": 999}, {"offer": "a lot"}, {"offer": True}]


# ═══ TABLE games ════════════════════════════════════════════════════════════
TABLE_KINDS = ("bid", "guess", "vote", "gamble", "lanes", "lowest", "race")

# race: every captain secretly backs one runner of a field whose FORM (its
# chance in a hundred) is public; the server runs the race (a few legs of
# commentary, then the winner, drawn by those chances) and pays each backer
# of the winner that runner's purse — the long shots pay more.
RACE_FIELD = [["The Favourite", "never loses, often", 5],
              ["The Plodder", "steady as a temple", 3],
              ["The Long Shot", "fast when it remembers", 2]]
RACE_LEGS = ("At the first turn", "Round the far post", "Into the last stretch")


def _race_legs(rng, names, weights, winner, legs):
    out = []
    for i, leg in enumerate(legs):
        if i == len(legs) - 1:
            lead = winner if rng.random() < 0.6 else rng.choices(range(len(names)), weights)[0]
        else:
            lead = rng.choices(range(len(names)), weights=[1] * len(names))[0]
        out.append(f"{leg}: {names[lead]} leads")
    return out


def gen_table(kind: str, rng: random.Random, params: dict | None = None) -> dict:
    params = dict(params or {})
    st = {"kind": kind, "params": {k: v for k, v in params.items()
                                   if k not in ("secret",)}, "secret": {}}
    if kind == "guess":
        lo, hi = params.get("range", [10, 60])
        st["lo"], st["hi"] = lo, hi
        st["secret"]["target"] = rng.randint(lo, hi)
    elif kind == "lanes":
        lanes = list(params.get("lanes", ["swift", "calm", "rocky"]))
        rng.shuffle(lanes)
        st["n"] = len(lanes)
        st["secret"]["lanes"] = lanes
    elif kind == "lowest":
        st["max"] = int(params.get("max", 5))
    elif kind == "vote":
        st["choices"] = [c["label"] for c in params.get("choices", [])]
    elif kind == "bid":
        st["cap"] = int(params.get("cap", 8))
    elif kind == "gamble":
        st["ante"] = int(params.get("ante", 1))
    elif kind == "race":
        field = params.get("field") or RACE_FIELD
        names = [f[0] for f in field]
        weights = [max(1, int(f[2])) for f in field]
        tot = sum(weights)
        st["n"] = len(field)
        st["runners"] = names
        st["form"] = [f[1] for f in field]
        st["chance"] = [round(100 * w / tot) for w in weights]
        winner = rng.choices(range(len(field)), weights=weights)[0]
        st["secret"]["winner"] = winner
        st["secret"]["legs"] = _race_legs(rng, names, weights, winner,
                                          params.get("legs") or RACE_LEGS)
    return st


def table_valid(st: dict, value, player) -> bool:
    k = st["kind"]
    if k == "bid":
        return _is_int(value) and 0 <= value <= min(st["cap"], player.scrolls)
    if k == "guess":
        return _is_int(value) and st["lo"] <= value <= st["hi"]
    if k == "vote":
        return _is_int(value) and 0 <= value < len(st["choices"])
    if k == "gamble":
        return value in ("in", "out") and (value == "out" or player.scrolls >= st["ante"])
    if k == "lanes":
        return _is_int(value) and 0 <= value < st["n"]
    if k == "lowest":
        return _is_int(value) and 1 <= value <= st["max"]
    if k == "race":
        return _is_int(value) and 0 <= value < st["n"]
    return False


def table_default(st: dict):
    """What an absent / idle captain 'answers': the do-nothing choice
    (None = sits it out — no bid, no guess, no vote, no entry)."""
    return {"gamble": "out"}.get(st["kind"])


def table_bot(st: dict, rng: random.Random, player, skill: float = 0.5):
    k = st["kind"]
    if k == "bid":
        top = min(st["cap"], player.scrolls)
        if top <= 0:
            return 0
        worth = int(st["params"].get("worth", 4))
        return rng.randint(0, max(0, min(top, worth - 1 + rng.randint(-1, 1))))
    if k == "guess":
        mid = (st["lo"] + st["hi"]) // 2
        span = max(1, (st["hi"] - st["lo"]) // 3)
        return max(st["lo"], min(st["hi"], mid + rng.randint(-span, span)))
    if k == "vote":
        return rng.randrange(len(st["choices"]))
    if k == "gamble":
        return "in" if player.scrolls >= st["ante"] + 2 and rng.random() < 0.6 else "out"
    if k == "lanes":
        return rng.randrange(st["n"])
    if k == "lowest":
        return rng.choice([1, 1, 2, 2, 2, 3, 3, 4, 5][: 4 + st["max"]])
    if k == "race":
        # mostly the form book, now and then a punt on a long shot
        if rng.random() < 0.3:
            return rng.randrange(st["n"])
        return rng.choices(range(st["n"]), weights=st["chance"])[0]
    return None

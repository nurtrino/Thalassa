"""
Question service.

  · TEMPLE multiple-choice questions come from a bundled, audited trivia set —
    data/trivia.json, grouped into the four Thalassa domains
    (clio/athena/apollo/dionysos). Each item may carry a difficulty "d"
    (1 = "hmm", 2 = hard, 3 = brutal; absent → 2). QuestionBank serves temples
    by domain AND tier, fully offline, never repeating a question until the
    pool it came from is exhausted.
  · BATTLE multiple-choice questions come from the LIVE The Trivia API
    (TriviaAPIBank), pulled into a background buffer so the request path is
    instant; if the API is slow, unreachable or switched off (TRIVIA_OFFLINE=1)
    it falls back to the bundle. STRIKE draws easier questions than MAGIC.
  · Typed clues are the JEOPARDY! deck (data/jeopardy.json) and its lenient
    matcher, check_jeopardy.
  · FALLBACK (bottom of file) is a tiny hand-written safety net.

The battle bank NEVER blocks the request path — get() returns from the buffer
or the offline bundle — so a shrine or battle can't hang on
"A herald fetches the question…".
"""
from __future__ import annotations

import asyncio
import functools
import html
import json
import os
import pathlib
import random
import re
import unicodedata

try:
    import httpx
except Exception:                      # pragma: no cover - httpx should be present
    httpx = None

# The live The Trivia API (the-trivia-api.com). A key isn't required for basic
# /questions requests — it only lifts the rate limit. It is read from the
# environment and NOWHERE else: no key means the public endpoint (or, with
# TRIVIA_OFFLINE=1, no network at all). Never commit one.
_TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions"
_TRIVIA_API_KEY = os.environ.get("TRIVIA_API_KEY", "").strip()
# TRIVIA_OFFLINE=1 → never touch the network; everything comes from the bundle.
OFFLINE = os.environ.get("TRIVIA_OFFLINE", "").strip().lower() in ("1", "true", "yes", "on")

TIER_DIFFICULTY = {1: "medium", 2: "hard", 3: "hard", 4: "hard"}

# Difficulty ladder. A tier asks for its own "d" first and widens to the
# neighbours only when that pool is thin: shrine tier I → d1 (then 2),
# tier II → d2, tier III → d3 (then 2). Battle STRIKE is tier I (II against
# bosses) and MAGIC tier III, so a STRIKE question is never harder than MAGIC's.
D_PREFERENCE = {1: (1, 2, 3), 2: (2, 1, 3), 3: (3, 2, 1)}
THIN_POOL = 12                 # fewer candidates than this → widen to the next d
_API_DIFFICULTY = {"easy": 1, "medium": 1, "hard": 2}


def _shape(text: str, correct: str, incorrect: list[str], rng: random.Random) -> dict:
    options = [correct] + list(incorrect[:3])
    rng.shuffle(options)
    return {"text": text, "options": options, "correct": options.index(correct)}


# ── bundled offline multiple-choice trivia (no network, ever) ────────────────
# An audited question set grouped into the four THALASSA domains. Everything
# can be served from here — the host needn't reach any trivia API, so a shrine
# or battle NEVER hangs fetching a question.
_TRIVIA_PATH = pathlib.Path(__file__).with_name("data") / "trivia.json"


def _valid_item(it) -> bool:
    return (isinstance(it, dict) and isinstance(it.get("q"), str) and it["q"]
            and isinstance(it.get("a"), str) and it["a"]
            and isinstance(it.get("w"), list) and len(it["w"]) >= 1
            and all(isinstance(w, str) for w in it["w"]))


try:
    _raw_trivia = json.loads(_TRIVIA_PATH.read_text(encoding="utf-8"))
    # one malformed entry (the file is hand-audited and regenerated) must not
    # take a whole domain down with a KeyError at question time
    TRIVIA: dict[str, list[dict]] = {
        dom: [it for it in lst if _valid_item(it)]
        for dom, lst in _raw_trivia.items() if isinstance(lst, list)}
except Exception:
    TRIVIA = {}
_ALL_TRIVIA = [q for lst in TRIVIA.values() for q in lst]


def difficulty(it: dict) -> int:
    """An item's difficulty: its optional integer "d" (1/2/3), else 2."""
    d = it.get("d", 2)
    return d if d in (1, 2, 3) and not isinstance(d, bool) else 2


def _shape_item(it: dict, rng: random.Random) -> dict:
    q = _shape(it["q"], it["a"], it["w"], rng)
    q["d"] = difficulty(it)
    return q


# NO REPEATS: every question text dealt by this process is remembered, and a
# pool only deals what it has not dealt yet. When a pool runs dry its own
# cards (and only those) are shuffled back in. Shared by temples and battles,
# so a shrine never re-asks what a sea fight just asked — across voyages too.
_SERVED: set[str] = set()


def _ladder(tier) -> tuple:
    """The difficulty order a tier draws in; anything odd is treated as II."""
    return D_PREFERENCE.get(tier if isinstance(tier, int) else 2, D_PREFERENCE[2])


def _candidates(items: list[dict], tier: int) -> list[dict]:
    """The pool a tier draws from: its preferred difficulty, widened down the
    ladder while it is thin (a file with no "d" fields is all d=2, so every
    tier simply gets everything)."""
    pool: list[dict] = []
    for d in _ladder(tier):
        pool += [it for it in items if difficulty(it) == d]
        if len(pool) >= THIN_POOL:
            break
    return pool


def _draw(pool: list[dict], rng: random.Random) -> dict:
    fresh = [it for it in pool if it["q"] not in _SERVED]
    if not fresh:                          # exhausted → reshuffle THIS pool
        for it in pool:
            _SERVED.discard(it["q"])
        fresh = pool
    it = rng.choice(fresh)
    _SERVED.add(it["q"])
    return it


def _fallback_pick(rng: random.Random, domain: str | None, tier: int) -> dict:
    """The hand-written safety net, for a missing/empty bundle."""
    first, second = ("medium", "hard") if tier == 1 else ("hard", "medium")
    doms = [FALLBACK[domain]] if domain in FALLBACK else list(FALLBACK.values())
    pool = [{"q": r[0], "a": r[1], "w": list(r[2])}
            for diff in (first, second) for d in doms for r in d[diff]]
    head = pool[:sum(len(d[first]) for d in doms)]
    it = _draw(head if any(x["q"] not in _SERVED for x in head) else pool, rng)
    q = _shape(it["q"], it["a"], it["w"], rng)
    q["d"] = 1 if tier == 1 else 2
    return q


def trivia_pick(rng: random.Random, tier: int = 2, domain: str | None = None) -> dict:
    """A multiple-choice question drawn INSTANTLY from the offline bundle —
    synchronous, no network, so the herald never waits. ``tier`` picks the
    difficulty (see D_PREFERENCE); ``domain`` narrows it to one muse."""
    items = (TRIVIA.get(domain) if domain else None) or _ALL_TRIVIA
    pool = _candidates(items, tier)
    if pool:
        return _shape_item(_draw(pool, rng), rng)
    return _fallback_pick(rng, domain, tier)


class TriviaAPIBank:
    """BATTLES: general multiple-choice trivia from the LIVE The Trivia API,
    kept in a background-filled BUFFER so a battle question is always instant.
    get() takes from the buffer; if nothing there fits (API slow, unreachable,
    or TRIVIA_OFFLINE=1) it falls straight back to the offline bundle — the
    herald therefore never hangs, and never sees a network error."""

    LOW = 12                       # refill when the buffer dips below this
    FILL = 40                      # questions to pull per refill
    RETRY_MIN = 4.0                # seconds between refill checks…
    RETRY_MAX = 300.0              # …backing off to this while the API fails

    def __init__(self):
        self.rng = random.Random()
        self.buffer: list[dict] = []

    def get(self, tier: int = 2) -> dict:
        """One battle question for a stance tier (STRIKE I/II, MAGIC III).
        Walk the difficulty ladder: a buffered live question of that
        difficulty, else the bundle's (if it has a real pool of them)."""
        try:
            for d in _ladder(tier):
                for i in range(len(self.buffer) - 1, -1, -1):
                    if self.buffer[i].get("d", 2) == d:
                        q = self.buffer.pop(i)
                        _SERVED.add(q["text"])
                        return q
                if sum(1 for it in _ALL_TRIVIA if difficulty(it) == d) >= THIN_POOL:
                    return _shape_item(
                        _draw([it for it in _ALL_TRIVIA if difficulty(it) == d],
                              self.rng), self.rng)
            if self.buffer:
                q = self.buffer.pop()
                _SERVED.add(q["text"])
                return q
        except Exception:
            pass                              # a bad buffered item — use the bundle
        return trivia_pick(self.rng, tier)    # instant offline fallback

    def counts(self) -> dict:
        return {"buffered": len(self.buffer)}

    def _parse(self, payload) -> list[dict]:
        """Shape an API response defensively — the wire is not trusted."""
        out = []
        if not isinstance(payload, list):
            return out
        for it in payload:
            try:
                if it.get("type") != "text_choice":
                    continue
                q = (it.get("question") or {}).get("text")
                a = it.get("correctAnswer")
                w = it.get("incorrectAnswers") or []
                if not (isinstance(q, str) and isinstance(a, str) and q.strip()
                        and a.strip() and len(w) >= 3
                        and all(isinstance(x, str) and x.strip() for x in w[:3])):
                    continue
                q, a = html.unescape(q).strip(), html.unescape(a).strip()
                w = [html.unescape(x).strip() for x in w[:3]]
                if len({x.lower() for x in [a] + w}) < 4:      # duplicate options
                    continue
                if len(q) > 300 or any(len(x) > 120 for x in [a] + w):
                    continue
                if q in _SERVED or any(b["text"] == q for b in self.buffer + out):
                    continue                                    # no repeats
                shaped = _shape(q, a, w, self.rng)
                shaped["d"] = _API_DIFFICULTY.get(it.get("difficulty"), 2)
                out.append(shaped)
            except Exception:
                continue
        return out

    async def _fetch(self, n: int) -> list[dict]:
        if httpx is None or OFFLINE:
            return []
        params = {"limit": str(min(50, n)), "types": "text_choice",
                  "difficulties": "medium,hard"}
        headers = {"X-API-Key": _TRIVIA_API_KEY} if _TRIVIA_API_KEY else {}
        async with httpx.AsyncClient(timeout=8.0, trust_env=True) as client:
            r = await client.get(_TRIVIA_API_URL, params=params, headers=headers)
            r.raise_for_status()
            return self._parse(r.json())

    async def refill_loop(self):
        """Background top-up. Runs OFF the request path; any failure (DNS,
        timeout, 4xx/5xx, junk JSON) just backs off — it never raises."""
        if OFFLINE or httpx is None:
            return                            # bundle only — nothing to fetch
        delay = self.RETRY_MIN
        while True:
            try:
                if len(self.buffer) < self.LOW:
                    got = await self._fetch(self.FILL)
                    self.buffer = got + self.buffer
                    delay = self.RETRY_MIN if got else min(self.RETRY_MAX, delay * 2)
            except asyncio.CancelledError:
                raise
            except Exception:
                delay = min(self.RETRY_MAX, delay * 2)   # API hiccup — bundle covers it
            await asyncio.sleep(delay)


class QuestionBank:
    """TEMPLES: themed multiple-choice trivia, by domain and tier. Offline."""

    def __init__(self):
        self.rng = random.Random()

    def counts(self) -> dict:
        return {d: len(v) for d, v in TRIVIA.items()}

    async def get(self, domain: str, tier: int) -> dict:
        """Tier I → d1 (falling back to 2), II → d2, III → d3 (falling back
        to 2); an unknown domain draws from every muse. Never repeats until
        the pool is exhausted; never raises."""
        return trivia_pick(self.rng, tier, domain)

    def _fallback(self, domain: str, diff: str) -> dict:
        return _fallback_pick(self.rng, domain, 1 if diff == "medium" else 2)

    async def refill_loop(self):
        return          # offline bundle — nothing to fetch


class OpenTDBBank:
    """BATTLES: general multiple-choice trivia drawn from EVERY domain. Offline.
    (Name kept for the import; it no longer touches the network.)"""

    def __init__(self):
        self.rng = random.Random()

    async def get(self, tier: int = 2) -> dict:
        return trivia_pick(self.rng, tier)

    def _fallback(self) -> dict:
        return _fallback_pick(self.rng, None, 2)

    async def refill_loop(self):
        return          # offline bundle — nothing to fetch


# ── BATTLE questions: the JEOPARDY! board ─────────────────────────────────────
# A real deck: ~55k clues from the show, bucketed by dollar value
# (data/jeopardy.json), EVERY topic. STRIKE deals the low band ($200/$400),
# MAGIC the high band ($800/$1000). A round offers four DISTINCT categories.
_JEOPARDY_PATH = os.path.join(os.path.dirname(__file__), "data", "jeopardy.json")
JEOPARDY: dict[str, list] = {}
try:
    with open(_JEOPARDY_PATH, encoding="utf-8") as _jf:
        JEOPARDY = json.load(_jf)          # {"200":[[cat,clue,ans],...], ...}
except Exception:
    JEOPARDY = {}

JEOPARDY_BANDS = {"low": ("200", "400"), "high": ("800", "1000")}
_J_SERVED: set[tuple[str, int]] = set()    # (band value, index) dealt this process


def jeopardy_board(rng: random.Random, band: str = "low", n: int = 4) -> list:
    """A mini board: n clues from the band's dollar values, all DISTINCT
    categories. Each cell: {category, value, text, answer}. Clues are SAMPLED
    (the old full shuffle of 28k clues cost ~15 ms on the event loop per
    round) and never dealt twice by one process until half the deck is spent."""
    vals = JEOPARDY_BANDS.get(band, JEOPARDY_BANDS["low"])
    decks = [(v, JEOPARDY[v]) for v in vals
             if isinstance(JEOPARDY.get(v), list) and JEOPARDY[v]]
    total = sum(len(d) for _, d in decks)
    if len(_J_SERVED) > sum(len(d) for d in JEOPARDY.values()
                            if isinstance(d, list)) // 2:
        _J_SERVED.clear()
    cells: list[dict] = []
    used: set[str] = set()
    for _ in range(60 * n if total else 0):
        if len(cells) >= n:
            break
        i = rng.randrange(total)               # uniform over the band's clues
        for v, deck in decks:
            if i < len(deck):
                break
            i -= len(deck)
        if (v, i) in _J_SERVED:
            continue
        try:
            cat, clue, ans = deck[i]
            key = cat.lower()
        except Exception:
            continue                           # a malformed row — skip it
        if key in used or not (clue and ans):
            continue
        used.add(key)
        _J_SERVED.add((v, i))
        cells.append({"category": cat, "value": int(v),
                      "text": clue, "answer": ans})
    # never stall a battle if the bundle is missing/short — a typed fallback
    while len(cells) < n:
        raw = rng.choice(FALLBACK["clio"]["hard"] + FALLBACK["athena"]["hard"])
        cells.append({"category": f"MYSTERY {len(cells) + 1}",
                      "value": int(vals[len(cells) % len(vals)]),
                      "text": raw[0], "answer": raw[1]})
    return cells


def jeopardy_question(cell: dict) -> dict:
    """Turn a chosen board cell into a typed battle question."""
    return {"text": cell["text"], "answer": cell["answer"], "typed": True,
            "kind": "jeopardy", "category": cell.get("category", ""),
            "value": cell.get("value", 0)}


def jeopardy_pick(rng: random.Random) -> dict:
    """One typed clue (legacy single-clue path / fallback)."""
    return jeopardy_question(jeopardy_board(rng, "low", 1)[0])


# ── typed-answer matching ────────────────────────────────────────────────────
# check_jeopardy(given, answer) is LENIENT about how a right answer is typed
# and STRICT about what counts as the right answer:
#
#   accepted  · case, accents, punctuation, a leading article, "what is …"
#             · plurals ("cats"/"cat"), spacing ("V8"/"V-8", "AC DC"/"AC/DC")
#             · numbers as words or digits ("twelve"/"12", "Henry the
#               Eighth"/"Henry VIII", "5280"/"5,280")
#             · a typo or two in a long word ("Hemmingway", "Beethovan")
#             · a surname for a full name ("Mozart"), a place without its
#               class word ("Mississippi" for "Mississippi River"), a fuller
#               form of a short answer ("Abraham Lincoln" for "Lincoln")
#             · initials ("JFK", "FDR", "U.S.A." / "USA")
#             · a parenthesised (optional) part left out, and a parenthesised
#               ALTERNATIVE on its own: "Burma (Myanmar)" takes either;
#               "X or Y" takes either side; "A & B" in either order
#   rejected  · a stray word of the answer ("of", "and", "John", "New")
#             · a different number ("Apollo 11" for "Apollo 13", "World War I"
#               for "World War II") or a missing one ("Henry" for "Henry VIII")
#             · one half of a pair ("Lewis" for "Lewis & Clark")
#             · shotgun guessing ("paris london rome berlin", "iran or iraq")
#             · a near-miss that is really ANOTHER answer in the deck
#               ("Monet" for "Manet", "Iceland" for "Ireland")
#             · anything fuzzy on a short word ("Iraq"/"Iran", "gold"/"cold")
_STOP = frozenset("a an the of and or in on at to for with from by".split())
_FILLER = _STOP | frozenset("is its it i think maybe my your his her their "
                            "our some just probably".split())
_TITLES = frozenset(
    "president king queen emperor empress pope sir dr doctor mr mrs ms miss "
    "general captain prince princess lord lady senator professor judge "
    "justice chief saint st".split())
# class words a place/thing may be named without ("the Nile" for "Nile River")
_CLASS = frozenset("river mount mt mountain mountains ocean sea lake desert "
                   "falls university inc co corp company corporation".split())
# words that make it a DIFFERENT place when dropped ("York" is not "New York")
_QUALIFIERS = frozenset(
    "north south east west northern southern eastern western new upper lower "
    "central san santa fort port cape".split())
# head nouns that never stand in for a full name ("Bridge" for "Golden Gate
# Bridge") — the surname rule skips these
_GENERIC = frozenset("""
    war wars party bridge tower revolution court house act day night prize
    award awards street road avenue park square building center centre club
    band show story book man woman men women boy girl boys girls time year
    years world game games series cup bowl league team state states city town
    island islands kingdom republic empire union army navy force church school
    college museum library hotel station garden gardens palace castle wall
    gate hall dam canal bay gulf strait valley canyon peninsula county
    province country nation age era period dynasty treaty battle movement
    theory law laws rule effect syndrome disease fever test code bill
    amendment rock stone stones sox""".split()) | _CLASS
_SUFFIXES = frozenset("jr sr junior senior".split())
# spellings that are the same word ("Saint Louis" / "St. Louis")
_ALIASES = {"saint": "st", "mount": "mt", "doctor": "dr", "fort": "ft",
            "versus": "vs", "mister": "mr", "junior": "jr", "senior": "sr",
            "and": "and", "percent": "pct", "okay": "ok"}

_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve "
    "thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split())}
_TENS = {w: (i + 2) * 10 for i, w in enumerate(
    "twenty thirty forty fifty sixty seventy eighty ninety".split())}
_MULTS = {"thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000}
_ORDINALS = {w: i + 1 for i, w in enumerate(
    "first second third fourth fifth sixth seventh eighth ninth tenth "
    "eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth "
    "eighteenth nineteenth twentieth".split())}
_ORDINALS.update(thirtieth=30, fortieth=40, fiftieth=50, hundredth=100)
_ROMAN = re.compile(r"^(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})$")
_ROMAN_VAL = {"i": 1, "v": 5, "x": 10}
_Q_PREFIX = re.compile(r"^(?:what|who|where|when)(?:s| is| are| was| were)? ")
_MAX_GIVEN = 120               # typed answers longer than this are not answers


def _roman(tok: str) -> int:
    total = 0
    for a, b in zip(tok, tok[1:] + " "):
        v = _ROMAN_VAL[a]
        total += -v if _ROMAN_VAL.get(b, 0) > v else v
    return total


def _norm_answer(s: str) -> str:
    """Lower-case, accent-free, punctuation-free, single-spaced; a leading
    article dropped; dotted or spaced initials closed up (J.F.K. → jfk)."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", s)          # 5,280 → 5280
    s = re.sub(r"['’`]", "", s)                            # don't → dont
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\b[a-z](?: [a-z]\b)+", lambda m: m.group().replace(" ", ""), s)
    for art in ("the ", "a ", "an "):
        if s.startswith(art) and len(s) > len(art):
            s = s[len(art):]
            break
    return s


def _stem(w: str) -> str:
    """Crude singular: enough that 'cats'/'cat' and 'cities'/'city' agree."""
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith(("sses", "shes", "ches", "xes", "zes")):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


@functools.lru_cache(maxsize=8192)
def _words(norm: str) -> tuple:
    """Normalized text → ((raw, canon), …). ``canon`` spells every number the
    same way — digits — whether it was typed as a word ('twelve', 'twenty
    one'), an ordinal ('eighth', '5th') or a Roman numeral ('VIII'); other
    words are stemmed. ``raw`` keeps what was typed, for typo distance."""
    toks = norm.split()
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in _UNITS or t in _TENS:
            # a run of number words: "twenty one" → 21, "two hundred" → 200,
            # "nineteen eighty four" → 19 84 (a spoken year, joined on compare)
            total = cur = 0
            last = None
            j = i
            while j < len(toks):
                w = toks[j]
                if w in _UNITS:
                    u = _UNITS[w]
                    if last == "unit" or (last == "tens" and u >= 10):
                        break
                    cur += u
                    last = "unit"
                elif w in _TENS:
                    if last in ("unit", "tens"):
                        break
                    cur += _TENS[w]
                    last = "tens"
                elif w == "hundred" and last in ("unit", "tens") and cur < 100:
                    cur *= 100
                    last = "hundred"
                elif w in _MULTS and last is not None and cur:
                    total += cur * _MULTS[w]
                    cur = 0
                    last = "mult"
                else:
                    break
                j += 1
            out.append((" ".join(toks[i:j]), str(total + cur)))
            i = j
            continue
        m = re.fullmatch(r"(\d+)(?:st|nd|rd|th)", t)
        if m:
            canon = m.group(1)
        elif t in _ORDINALS:
            canon = str(_ORDINALS[t])
        elif (_ROMAN.match(t) and i > 0
              and (len(t) > 1 or i == len(toks) - 1)) \
                or (len(toks) == 1 and len(t) > 1 and _ROMAN.match(t)):
            canon = str(_roman(t))             # Henry VIII, Rocky II, Louis XIV
        elif t.isdigit():
            canon = str(int(t)) if len(t) < 12 else t
        else:
            canon = _ALIASES.get(t) or _stem(t)
        out.append((t, canon))
        i += 1
    return tuple(out)


def _numeric(w: tuple) -> bool:
    return any(c.isdigit() for c in w[1])


def _answer_forms(answer: str) -> list[tuple[str, bool]]:
    """Every string that counts as THE answer: parenthesised parts are
    optional ('(Ernest) Hemingway'); a parenthesised part at the END — or one
    standing in for the word before it — is an ALTERNATIVE on its own
    ('Burma (Myanmar)', 'movie (motion) picture camera'); 'X or Y' accepts
    either side; 'Salinas, California' accepts the city."""
    answer = (answer or "").strip()
    parts = re.split(r"\(([^()]*)\)", answer)        # text, paren, text, paren…
    forms: list[str] = []
    n_par = len(parts) // 2
    if n_par == 0:
        forms.append(answer)
    else:
        # every keep/drop combination of the optional parts (capped)
        combos = range(1 << n_par) if n_par <= 3 else (0, (1 << n_par) - 1)
        for mask in combos:
            forms.append(" ".join(
                p for k, p in enumerate(parts)
                if k % 2 == 0 or mask >> (k // 2) & 1))
        for k in range(1, len(parts), 2):
            alt = re.sub(r"^\s*or\s+", "", parts[k])
            before = " ".join(parts[:k:2]).strip()
            after = " ".join(parts[k + 1::2]).strip()
            if before and not after:                  # trailing → alternative
                forms.append(alt)
            elif before and after and " " not in alt.strip():
                # mid-answer: it replaces the word it follows — unless it
                # follows a connector ("(Dean) Martin & (Jerry) Lewis": an
                # optional first name, not another word for "&")
                head = parts[k - 1].rstrip().rsplit(" ", 1)
                if re.sub(r"[^a-z0-9]", "", head[-1].lower()) not in ("", "and", "or"):
                    forms.append(" ".join(
                        parts[:k - 1:2] + [head[0] if len(head) > 1 else "", alt]
                        + parts[k + 1::2]))
    out = list(forms)
    for f in forms:
        sides = re.split(r"\s+or\s+", f, flags=re.I)
        if len(sides) > 1 and all(len(_norm_answer(x)) >= 2 for x in sides):
            out.extend(sides)
        if f.count(",") == 1 and not re.search(r"&|\band\b|\bor\b", f, re.I):
            head, tail = f.split(",")
            if len(_norm_answer(head)) >= 4 and 1 <= len(tail.split()) <= 2:
                out.append(head)                      # "Salinas, California"
    seen, uniq = set(), []
    for f in out:
        n = _norm_answer(f)
        if n and n not in seen:
            seen.add(n)
            uniq.append((n, _namelike(f)))
    return uniq


_PARTICLES = frozenset("de la le du da di del della van von der den bin ibn "
                       "al el y".split())


def _namelike(raw: str) -> bool:
    """Does this answer READ like a personal name — 'Wolfgang Amadeus Mozart',
    'Vincent van Gogh', 'H.L. Mencken' — rather than a phrase ('pool table',
    'the Red Death', 'Gulliver's Travels')? Only names may be answered by
    their last word alone. Judged by how the deck itself writes it: two to
    four capitalised words, no leading article, no possessive, no numbers."""
    toks = [t.strip(".,;:!?\"'") for t in raw.split()]
    toks = [t for t in toks if t]
    if not 2 <= len(toks) <= 5 or toks[0].lower() in ("the", "a", "an"):
        return False
    for i, t in enumerate(toks):
        if any(c.isdigit() for c in t):
            return False
        if i < len(toks) - 1 and t.lower().endswith(("'s", "s'")):
            return False
        if not (t[0].isupper() or t.lower() in _PARTICLES):
            return False
    return True


def _levenshtein(a: str, b: str) -> int:
    """Edit distance for TYPED text: insert / delete / substitute, and a swap
    of two neighbouring letters counts as ONE slip ('Einstien'), since that
    is the commonest typo there is. Iterative, three rows."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev2: list[int] = []
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            d = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                d = min(d, prev2[j - 2] + 1)
            cur.append(d)
        prev2, prev = prev, cur
    return prev[-1]


def _typo_tol(n: int) -> int:
    """How many letters a word of length n may be off by. Short words stay
    STRICT (iran vs iraq, gold vs cold are different answers, not typos);
    longer ones tolerate the odd slip, scaling with length."""
    if n < 5:
        return 0
    if n < 8:
        return 1
    if n < 12:
        return 2
    return 3


def _weq(g: tuple, v: tuple) -> int:
    """Word match: 0 no · 1 same word (or its plural / same number) ·
    2 a typo's distance apart. Numbers are never fuzzy."""
    if g[1] == v[1]:
        return 1
    if _numeric(g) or any(c.isdigit() for c in v[0]):
        return 0
    tol = _typo_tol(len(v[0]))
    if tol and abs(len(g[0]) - len(v[0])) <= tol \
            and _levenshtein(g[0], v[0]) <= tol:
        return 2
    return 0


def _squash(ws) -> str:
    return "".join(w[1] if _numeric(w) else w[0].replace(" ", "") for w in ws)


def _initials(ws, stops: bool) -> str:
    return "".join(w[0][0] for w in ws if stops or w[0] not in _STOP)


def _core(ws) -> list:
    """The words that carry the answer (no articles, class words, titles)."""
    return [w for w in ws
            if w[0] not in _STOP and w[0] not in _CLASS
            and w[0] not in _TITLES and w[0] not in _QUALIFIERS]


def _partial_ok(V, matched: list[int], namelike: bool) -> bool:
    """The player typed only SOME of the answer's words (in order). Enough?"""
    kept = [V[i] for i in matched]
    left = [i for i in range(len(V)) if i not in matched]
    omitted = [V[i] for i in left]
    if any(_numeric(w) for w in omitted):
        return False                     # "Henry" is not "Henry VIII"
    if any(w[0] in _QUALIFIERS for w in omitted):
        return False                     # "York" is not "New York"
    core = _core(kept)
    solid = bool(core) and (sum(len(w[0]) for w in core) >= 3
                            or any(_numeric(w) for w in core))
    if solid and all(V[i][0] in _STOP or V[i][0] in _CLASS
                     or (V[i][0] in _TITLES and i < matched[0])
                     for i in left):
        return True                      # "Mississippi (River)", "(Queen) Victoria"
    # most of a long answer, from the start: "New York" for "New York City"
    said = [w for w in kept if w[0] not in _STOP]
    if (len(said) >= 2 and matched == list(range(len(matched)))
            and len(said) * 3 >= 2 * sum(1 for w in V if w[0] not in _STOP)):
        return True
    # the surname rule: "Mozart" for "Wolfgang Amadeus Mozart"
    last = len(V) - 1
    while last > 0 and V[last][0] in _SUFFIXES:
        last -= 1
    names = V[:last + 1]
    if (namelike and 2 <= len(names) <= 4 and matched and matched[-1] >= last
            and not any(w[0] in _STOP for w in names)
            and not any(_numeric(w) for w in V)
            and len(V[last][0]) >= 3 and V[last][0] not in _GENERIC):
        return True
    return False


def _subsequence(G, V):
    """Match G's words, in order, to some of V's. → (indices, fuzzy?) or None."""
    idx, fuzzy, j = [], False, 0
    for g in G:
        while j < len(V) and not _weq(g, V[j]):
            j += 1
        if j >= len(V):
            return None
        fuzzy = fuzzy or _weq(g, V[j]) == 2
        idx.append(j)
        j += 1
    return idx, fuzzy


def _match(G, V, namelike: bool, loose_extras: bool) -> int:
    """0 no · 1 yes, every word right · 2 yes, but only by typo tolerance."""
    if not G or not V:
        return 0
    # the same words (plurals / number spellings aside), any spacing
    if len(G) == len(V) and all(g[1] == v[1] for g, v in zip(G, V)):
        return 1
    sg, sv = _squash(G), _squash(V)
    if sg == sv:
        return 1
    # the same content words in another order: "Clark & Lewis", "July 4th"
    bg = sorted(w[1] for w in G if w[0] not in _STOP)
    bv = sorted(w[1] for w in V if w[0] not in _STOP)
    if bg and bg == bv:
        return 1
    # initials for a name ("JFK", "FDR", "USA")
    if len(G) == 1 and len(V) >= 2 and 2 <= len(G[0][0]) <= 6 \
            and G[0][0].isalpha() \
            and G[0][0] in (_initials(V, True), _initials(V, False)):
        return 1
    best = 0
    # word for word, typos forgiven
    if len(G) == len(V):
        kinds = [_weq(g, v) for g, v in zip(G, V)]
        if all(kinds):
            edits = sum(_levenshtein(g[0], v[0]) for g, v, k in zip(G, V, kinds)
                        if k == 2)
            if edits <= 3:
                best = 2
    # fewer words than the answer: a surname, a place without its class word
    if not best and len(G) < len(V):
        sub = _subsequence(G, V)
        if sub and _partial_ok(V, sub[0], namelike):
            if not sub[1]:
                return 1
            best = 2
    # more words than the answer: it must sit whole inside what was typed,
    # after at most two words of lead-in ("Abraham Lincoln", "I think Mozart")
    # and followed only by filler/class words — never a list of guesses
    if not best and len(G) > len(V) and (len(sv) >= 3 or _numeric(V[0])):
        for i in range(len(G) - len(V) + 1):
            kinds = [_weq(g, v) for g, v in zip(G[i:], V)]
            if not all(kinds):
                continue
            lead, tail = G[:i], G[i + len(V):]
            lead_free = [w for w in lead if w[0] not in _FILLER
                         and w[0] not in _TITLES and w[0] not in _CLASS]
            ok_tail = all(w[0] in _FILLER or w[0] in _CLASS for w in tail) \
                or (len(tail) == 1 and tail[0][0].isalpha()      # "5280 feet"
                    and all(_numeric(x) for x in V))
            room = 2 if loose_extras and not _numeric(V[0]) else 0
            if (ok_tail and len(lead_free) <= room
                    and not any(_numeric(w) for w in lead + tail)
                    and not any(w[0] in ("or", "and") for w in lead + tail)):
                if all(k == 1 for k in kinds):
                    return 1
                best = 2
                break
    # one slip across a word break: "heming way", "rosemarys baby"
    if not best and len(sv) >= 6 and abs(len(G) - len(V)) <= 1 \
            and abs(len(sg) - len(sv)) <= 1 \
            and re.findall(r"\d+", sg) == re.findall(r"\d+", sv) \
            and _levenshtein(sg, sv) <= 1:
        best = 2
    return best


_KNOWN: set[str] | None = None


def known_answers() -> set[str]:
    """Every answer in the deck, normalized — built once, on first need (the
    server warms it at startup). A NEAR-miss that is itself another real
    answer ('Monet' for 'Manet') is a wrong answer, not a typo."""
    global _KNOWN
    if _KNOWN is None:
        known: set[str] = set()
        for deck in JEOPARDY.values():
            if not isinstance(deck, list):
                continue
            for cell in deck:
                try:
                    ans = cell[2]
                except Exception:
                    continue
                known.add(_norm_answer(re.sub(r"\([^)]*\)", " ", ans)))
                if "(" in ans:
                    known.update(_norm_answer(x)
                                 for x in re.findall(r"\(([^)]*)\)\s*$", ans))
        known.discard("")
        _KNOWN = known
    return _KNOWN


def check_jeopardy(given: str, answer: str) -> bool:
    """Is ``given`` an acceptable typed response for ``answer``? See the
    accepted/rejected table above. Never raises; cheap on the hot path."""
    try:
        given = str(given or "")
        if len(given) > _MAX_GIVEN:
            return False                 # an essay is not an answer (and
        g = _norm_answer(given)          # edit distance is quadratic)
        if not g:
            return False
        answer = str(answer or "")
        if g == _norm_answer(answer):
            return True
        forms = _answer_forms(answer)
        if any(g == vf for vf, _ in forms):
            return True
        g_forms = [g]
        stripped = _Q_PREFIX.sub("", g, count=1)       # "what is …", "who's …"
        for art in ("the ", "a ", "an "):
            if stripped.startswith(art):
                stripped = stripped[len(art):]
                break
        if stripped and stripped != g:
            g_forms.append(stripped)
        # several guesses at once ("iran, iraq" / "iran or iraq") earn no
        # leeway for extra words — unless the answer itself reads that way
        listy = bool(re.search(r"[,;/]|\bor\b", given, re.I))
        fuzzy = False
        for gf in g_forms:
            G = _words(gf)
            for vf, namelike in forms:
                r = _match(G, _words(vf), namelike, not listy)
                if r == 1:
                    return True
                fuzzy = fuzzy or r == 2
        # the acronym spelled out: "Federal Bureau of Investigation" for "FBI"
        if re.fullmatch(r"(?:the\s+)?(?:[A-Z]\.?\s?){2,6}", answer.strip()):
            acro = _norm_answer(answer).replace(" ", "")
            for gf in g_forms:
                G = _words(gf)
                if len(G) >= 2 and acro in (_initials(G, True), _initials(G, False)):
                    return True
        if fuzzy:
            known = known_answers()
            return not any(gf in known for gf in g_forms)
        return False
    except Exception:
        return False


# ── offline fallback set ─────────────────────────────────────────────────────
# (question, correct, [wrong, wrong, wrong]) — used in dev or if the API is
# unreachable. Floor stays "you might not know this", per the game's charter.
FALLBACK: dict[str, dict[str, list]] = {
    "clio": {
        "medium": [
            ("Which empire built the Royal Road running from Sardis to Susa?",
             "The Achaemenid Persian Empire",
             ["The Roman Empire", "The Ottoman Empire", "The Maurya Empire"]),
            ("The 1494 Treaty of Tordesillas divided newly explored lands between which two powers?",
             "Spain and Portugal",
             ["England and France", "Spain and England", "Portugal and the Netherlands"]),
            ("Which ancient city did Rome destroy at the end of the Third Punic War in 146 BC?",
             "Carthage", ["Corinth", "Syracuse", "Numantia"]),
            ("The Defenestration of Prague in 1618 helped ignite which conflict?",
             "The Thirty Years' War",
             ["The Hundred Years' War", "The War of Spanish Succession", "The Seven Years' War"]),
            ("Which strait connects the Sea of Marmara to the Aegean Sea?",
             "The Dardanelles", ["The Bosporus", "The Strait of Otranto", "The Kerch Strait"]),
            ("Hadrian's Wall marked the northern frontier of which Roman province?",
             "Britannia", ["Gallia", "Germania Inferior", "Hispania"]),
        ],
        "hard": [
            ("Which Byzantine emperor ordered the legal compilation known as the Corpus Juris Civilis?",
             "Justinian I", ["Constantine VII", "Basil II", "Heraclius"]),
            ("The 1571 Battle of Lepanto pitted the Ottoman fleet against which Christian alliance?",
             "The Holy League", ["The Hanseatic League", "The Delian League", "The League of Cambrai"]),
            ("Mansa Musa, famed for his gold-laden pilgrimage to Mecca in 1324, ruled which empire?",
             "The Mali Empire", ["The Songhai Empire", "The Ghana Empire", "The Kanem Empire"]),
            ("Which 732 battle halted the Umayyad advance into Frankish territory?",
             "The Battle of Tours", ["The Battle of Manzikert", "The Battle of Yarmouk", "The Battle of Roncevaux Pass"]),
            ("The Svalbard archipelago in the Arctic is administered by which country?",
             "Norway", ["Denmark", "Russia", "Iceland"]),
            ("The ruins of Persepolis stand in which modern-day country?",
             "Iran", ["Iraq", "Turkey", "Syria"]),
        ],
    },
    "athena": {
        "medium": [
            ("What is the second most abundant element in Earth's crust, after oxygen?",
             "Silicon", ["Aluminium", "Iron", "Calcium"]),
            ("Which planet in our solar system has the shortest day?",
             "Jupiter", ["Mercury", "Neptune", "Mars"]),
            ("Which particle mediates the electromagnetic force?",
             "The photon", ["The gluon", "The W boson", "The graviton"]),
            ("In biological classification, which rank sits directly above 'family'?",
             "Order", ["Genus", "Class", "Phylum"]),
            ("Which acid is found in the venom of most ants?",
             "Formic acid", ["Citric acid", "Tannic acid", "Oxalic acid"]),
            ("What is the name of the supercontinent that began breaking apart about 200 million years ago?",
             "Pangaea", ["Gondwana", "Laurasia", "Rodinia"]),
        ],
        "hard": [
            ("Who formulated the exclusion principle stating that no two electrons can occupy the same quantum state?",
             "Wolfgang Pauli", ["Werner Heisenberg", "Niels Bohr", "Paul Dirac"]),
            ("What is the name of the ~1.4-solar-mass ceiling above which a white dwarf cannot remain stable?",
             "The Chandrasekhar limit", ["The Eddington limit", "The Roche limit", "The Schwarzschild limit"]),
            ("Which organelle carries its own DNA and is inherited almost exclusively from the mother in humans?",
             "The mitochondrion", ["The ribosome", "The lysosome", "The Golgi apparatus"]),
            ("Which element is the most electronegative on the Pauling scale?",
             "Fluorine", ["Oxygen", "Chlorine", "Nitrogen"]),
            ("Which geological period immediately preceded the Jurassic?",
             "The Triassic", ["The Permian", "The Cretaceous", "The Devonian"]),
            ("Magnetic flux is measured in which SI unit?",
             "The weber", ["The tesla", "The henry", "The farad"]),
        ],
    },
    "apollo": {
        "medium": [
            ("Which Russian writer produced the novel 'Dead Souls'?",
             "Nikolai Gogol", ["Ivan Turgenev", "Fyodor Dostoevsky", "Anton Chekhov"]),
            ("'The Garden of Earthly Delights' triptych was painted by which artist?",
             "Hieronymus Bosch", ["Pieter Bruegel the Elder", "Jan van Eyck", "Albrecht Dürer"]),
            ("Which epic poem opens by invoking the wrath of Achilles?",
             "The Iliad", ["The Odyssey", "The Aeneid", "The Argonautica"]),
            ("Which classical order of architecture is identified by scroll-shaped volutes on its capitals?",
             "Ionic", ["Doric", "Corinthian", "Tuscan"]),
            ("Who composed the opera 'The Magic Flute'?",
             "Wolfgang Amadeus Mozart", ["Ludwig van Beethoven", "Gioachino Rossini", "Joseph Haydn"]),
            ("Which Nobel laureate wrote 'One Hundred Years of Solitude'?",
             "Gabriel García Márquez", ["Mario Vargas Llosa", "Jorge Luis Borges", "Pablo Neruda"]),
        ],
        "hard": [
            ("The 14th-century allegorical poem 'Piers Plowman' is attributed to which writer?",
             "William Langland", ["Geoffrey Chaucer", "John Gower", "Thomas Malory"]),
            ("'The Tale of Genji', often called the first novel, was written by which author?",
             "Murasaki Shikibu", ["Sei Shōnagon", "Matsuo Bashō", "Izumi Shikibu"]),
            ("Which sculptor created 'The Ecstasy of Saint Teresa'?",
             "Gian Lorenzo Bernini", ["Antonio Canova", "Donatello", "Michelangelo"]),
            ("James Joyce's 'Ulysses' unfolds over a single day in which year?",
             "1904", ["1899", "1916", "1922"]),
            ("The poetry collection 'Leaves of Grass' was written by whom?",
             "Walt Whitman", ["Emily Dickinson", "Ralph Waldo Emerson", "Henry Wadsworth Longfellow"]),
            ("Which Greek tragedian wrote the 'Oresteia' trilogy?",
             "Aeschylus", ["Sophocles", "Euripides", "Aristophanes"]),
        ],
    },
    "dionysos": {
        "medium": [
            ("Which country has won the most FIFA World Cup titles?",
             "Brazil", ["Germany", "Italy", "Argentina"]),
            ("The Vezina Trophy honors the best goaltender in which sport?",
             "Ice hockey", ["Lacrosse", "Baseball", "Field hockey"]),
            ("Who composed the score for 'The Good, the Bad and the Ugly'?",
             "Ennio Morricone", ["Nino Rota", "John Barry", "Bernard Herrmann"]),
            ("Which spirit forms the base of a classic Negroni?",
             "Gin", ["Vodka", "Rye whiskey", "White rum"]),
            ("Which board game began life in 1904 as 'The Landlord's Game'?",
             "Monopoly", ["The Game of Life", "Risk", "Clue"]),
            ("Which jazz trumpeter recorded the 1959 album 'Kind of Blue'?",
             "Miles Davis", ["Dizzy Gillespie", "Chet Baker", "Louis Armstrong"]),
        ],
        "hard": [
            ("Which chess opening begins 1.e4 e5 2.Nf3 Nc6 3.Bb5?",
             "The Ruy López", ["The Italian Game", "The Sicilian Defence", "The Caro-Kann"]),
            ("In fencing, which weapon counts the entire body as valid target area?",
             "Épée", ["Foil", "Sabre", "Rapier"]),
            ("Which French chef codified the five 'mother sauces' of classical cuisine?",
             "Auguste Escoffier", ["Marie-Antoine Carême", "Paul Bocuse", "Fernand Point"]),
            ("Which cyclist won five consecutive Tours de France from 1991 to 1995?",
             "Miguel Induráin", ["Greg LeMond", "Bernard Hinault", "Laurent Fignon"]),
            ("What is the highest rank a sumo wrestler can attain?",
             "Yokozuna", ["Ōzeki", "Sekiwake", "Komusubi"]),
            ("Which 1962 film launched the James Bond series in cinemas?",
             "Dr. No", ["From Russia with Love", "Goldfinger", "Thunderball"]),
        ],
    },
}

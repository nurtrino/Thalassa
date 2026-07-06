"""
Question service.

  · TEMPLE multiple-choice questions come from a bundled slice of the
    uberspot/OpenTriviaQA set — data/trivia.json, ~3200 questions grouped into
    the four Thalassa domains (clio/athena/apollo/dionysos). QuestionBank serves
    temples by domain, fully offline.
  · BATTLE multiple-choice questions come from the LIVE The Trivia API
    (TriviaAPIBank), pulled into a background buffer so the request path is
    instant; if the API is slow or unreachable it falls back to the bundle.
  · Typed clues are drawn from the same offline bundle — history, science,
    pop culture and wordplay only; nothing musical or literary.
  · FALLBACK (bottom of file) is a tiny hand-written safety net.

The battle bank NEVER blocks the request path — get() returns from the buffer
or the offline bundle — so a shrine or battle can't hang on
"A herald fetches the question…".
"""
from __future__ import annotations

import asyncio
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
# /questions requests but lifts the rate limit — read one from the environment,
# falling back to the project key.
_TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions"
_TRIVIA_API_KEY = os.environ.get("TRIVIA_API_KEY", "iLE7akLJFkCQAK5fCCMqgybzC")

TIER_DIFFICULTY = {1: "medium", 2: "hard", 3: "hard", 4: "hard"}


def _shape(text: str, correct: str, incorrect: list[str], rng: random.Random) -> dict:
    options = [correct] + list(incorrect[:3])
    rng.shuffle(options)
    return {"text": text, "options": options, "correct": options.index(correct)}


# ── bundled offline multiple-choice trivia (no network, ever) ────────────────
# A curated slice of the uberspot/OpenTriviaQA set, grouped into the four
# THALASSA domains. Everything is served from here — the host can't (and needn't)
# reach any trivia API, so a shrine or battle NEVER hangs fetching a question.
_TRIVIA_PATH = pathlib.Path(__file__).with_name("data") / "trivia.json"
try:
    TRIVIA: dict[str, list[dict]] = json.loads(_TRIVIA_PATH.read_text(encoding="utf-8"))
except Exception:
    TRIVIA = {}
_ALL_TRIVIA = [q for lst in TRIVIA.values() for q in lst]


def _shape_item(it: dict, rng: random.Random) -> dict:
    return _shape(it["q"], it["a"], it["w"], rng)


def trivia_pick(rng: random.Random) -> dict:
    """BATTLES: a general multiple-choice trivia question, drawn INSTANTLY from
    the offline bundle — synchronous, no network, so the herald never waits."""
    if _ALL_TRIVIA:
        return _shape_item(rng.choice(_ALL_TRIVIA), rng)
    pools = []
    for d in FALLBACK.values():
        pools += d["medium"] + d["hard"]
    raw = rng.choice(pools)
    return _shape(raw[0], raw[1], list(raw[2]), rng)


class TriviaAPIBank:
    """BATTLES: general multiple-choice trivia from the LIVE The Trivia API,
    kept in a background-filled BUFFER so a battle question is always instant.
    get() pops the buffer; if it's empty (API slow or unreachable) it falls
    straight back to the offline bundle — the herald therefore never hangs."""

    LOW = 12                       # refill when the buffer dips below this
    FILL = 40                      # questions to pull per refill

    def __init__(self):
        self.rng = random.Random()
        self.buffer: list[dict] = []

    def get(self) -> dict:
        if self.buffer:
            return self.buffer.pop()
        return trivia_pick(self.rng)          # instant offline fallback

    def counts(self) -> dict:
        return {"buffered": len(self.buffer)}

    async def _fetch(self, n: int) -> list[dict]:
        if httpx is None:
            return []
        params = {"limit": str(min(50, n)), "types": "text_choice",
                  "difficulties": "medium,hard"}
        headers = {"X-API-Key": _TRIVIA_API_KEY} if _TRIVIA_API_KEY else {}
        async with httpx.AsyncClient(timeout=8.0, trust_env=True) as client:
            r = await client.get(_TRIVIA_API_URL, params=params, headers=headers)
            r.raise_for_status()
            out = []
            for it in r.json():
                if it.get("type") != "text_choice":
                    continue
                q = (it.get("question") or {}).get("text")
                a = it.get("correctAnswer")
                w = it.get("incorrectAnswers") or []
                if q and a and len(w) >= 3:
                    out.append(_shape(html.unescape(q), html.unescape(a),
                                      [html.unescape(x) for x in w[:3]], self.rng))
            return out

    async def refill_loop(self):
        while True:
            try:
                if len(self.buffer) < self.LOW:
                    got = await self._fetch(self.FILL)
                    if got:
                        self.buffer = got + self.buffer
            except Exception:
                pass                          # API hiccup — the offline bundle covers it
            await asyncio.sleep(4)


class QuestionBank:
    """TEMPLES: themed multiple-choice trivia, by domain. Fully offline."""

    def __init__(self):
        self.rng = random.Random()

    def counts(self) -> dict:
        return {d: len(v) for d, v in TRIVIA.items()}

    async def get(self, domain: str, tier: int) -> dict:
        pool = TRIVIA.get(domain) or _ALL_TRIVIA
        if pool:
            return _shape_item(self.rng.choice(pool), self.rng)
        return self._fallback(domain, "hard")

    def _fallback(self, domain: str, diff: str) -> dict:
        candidates = FALLBACK[domain][diff] + FALLBACK[domain]["medium" if diff == "hard" else "hard"]
        raw = self.rng.choice(candidates)
        return _shape(raw[0], raw[1], list(raw[2]), self.rng)

    async def refill_loop(self):
        return          # offline bundle — nothing to fetch


class OpenTDBBank:
    """BATTLES: general multiple-choice trivia drawn from EVERY domain. Offline.
    (Name kept for the import; it no longer touches the network.)"""

    def __init__(self):
        self.rng = random.Random()

    async def get(self) -> dict:
        if _ALL_TRIVIA:
            return _shape_item(self.rng.choice(_ALL_TRIVIA), self.rng)
        return self._fallback()

    def _fallback(self) -> dict:
        pools = []
        for d in FALLBACK.values():
            pools += d["medium"] + d["hard"]
        raw = self.rng.choice(pools)
        return _shape(raw[0], raw[1], list(raw[2]), self.rng)

    async def refill_loop(self):
        return          # offline bundle — nothing to fetch


# ── BATTLE questions: the JEOPARDY! board ─────────────────────────────────────
# A real deck now: ~56k clues scraped from Seasons 1–41 of the show, bucketed
# by dollar value (data/jeopardy.json), EVERY topic (no filter — music,
# literature, the lot). STRIKE deals the low band ($200/$400), MAGIC the high
# band ($800/$1000). A round offers four DISTINCT categories to choose from.
_JEOPARDY_PATH = os.path.join(os.path.dirname(__file__), "data", "jeopardy.json")
JEOPARDY: dict[str, list] = {}
try:
    with open(_JEOPARDY_PATH, encoding="utf-8") as _jf:
        JEOPARDY = json.load(_jf)          # {"200":[[cat,clue,ans],...], ...}
except Exception:
    JEOPARDY = {}

JEOPARDY_BANDS = {"low": ("200", "400"), "high": ("800", "1000")}


def jeopardy_board(rng: random.Random, band: str = "low", n: int = 4) -> list:
    """A mini board: n clues from the band's dollar values, all DISTINCT
    categories. Each cell: {category, value, text, answer}."""
    vals = JEOPARDY_BANDS.get(band, JEOPARDY_BANDS["low"])
    pool = [(v, cell) for v in vals for cell in JEOPARDY.get(v, [])]
    rng.shuffle(pool)
    cells: list[dict] = []
    used: set[str] = set()
    for v, cell in pool:
        cat, clue, ans = cell
        key = cat.lower()
        if key in used:
            continue
        used.add(key)
        cells.append({"category": cat, "value": int(v),
                      "text": clue, "answer": ans})
        if len(cells) >= n:
            break
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
_ARTICLES = ("the ", "a ", "an ")


def _norm_answer(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    for art in _ARTICLES:
        if s.startswith(art):
            s = s[len(art):]
    return s.strip()


def _answer_variants(answer: str) -> set[str]:
    # "(Ernest) Hemingway" → {"ernest hemingway", "hemingway"}
    out = set()
    for v in (answer, re.sub(r"[()]", "", answer), re.sub(r"\([^)]*\)", "", answer)):
        n = _norm_answer(v)
        if n:
            out.add(n)
    return out


def _levenshtein(a: str, b: str) -> int:
    """Classic edit distance (insert/delete/substitute), iterative two-row."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _typo_tol(n: int) -> int:
    """How many letters a word/answer of length n may be off by. Short answers
    stay STRICT (iran vs iraq, gold vs cold are different answers, not typos);
    longer ones tolerate the odd slip, scaling with length."""
    if n < 5:
        return 0
    if n < 8:
        return 1
    if n < 12:
        return 2
    return 3


def check_jeopardy(given: str, answer: str) -> bool:
    """Lenient typed match: normalized equality, one being a whole-word run of the
    other ('Hemingway' matches 'Ernest Hemingway'), OR a near-miss within a few
    letters (a typo or dropped letter) — both on the whole answer and on its key
    word, so 'Hemmingway' or 'Carthag' still count."""
    g = _norm_answer(given)
    if not g:
        return False
    g_words = g.split()
    for v in _answer_variants(answer):
        if g == v:
            return True
        if len(v) >= 4 and (f" {v} " in f" {g} " or f" {g} " in f" {v} "):
            return True
        # whole-answer near-miss (a typo or two in the full string)
        if _levenshtein(g, v) <= _typo_tol(len(v)):
            return True
        # key-word near-miss: the head noun/surname (longest word) mistyped
        v_words = v.split()
        kw = max(v_words, key=len) if v_words else ""
        if len(kw) >= 5:
            tol = _typo_tol(len(kw))
            if any(_levenshtein(w, kw) <= tol for w in g_words):
                return True
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

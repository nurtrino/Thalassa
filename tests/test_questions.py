"""Question service tests — the bundled bank (difficulty tiers, no repeats),
the live-API buffer (never blocks, never throws, no committed key), the
Jeopardy board, and the typed-answer matcher."""
import asyncio
import collections
import pathlib
import random

import pytest

import questions as Q

C = Q.check_jeopardy


def run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _items(domain, d, n):
    out = []
    for i in range(n):
        it = {"q": f"{domain} d{d} #{i}?", "a": "right", "w": ["x", "y", "z"]}
        if d is not None:
            it["d"] = d
        out.append(it)
    return out


@pytest.fixture
def bundle(monkeypatch):
    """Swap in a synthetic bundle: bundle(clio={1: 30, 2: 40, 3: 5}, …)."""
    def install(**domains):
        trivia = {dom: [it for d, n in spec.items() for it in _items(dom, d, n)]
                  for dom, spec in domains.items()}
        monkeypatch.setattr(Q, "TRIVIA", trivia)
        monkeypatch.setattr(Q, "_ALL_TRIVIA", [q for v in trivia.values() for q in v])
        monkeypatch.setattr(Q, "_SERVED", set())
        return trivia
    return install


# ── the API key ──────────────────────────────────────────────────────────────
def test_no_api_key_is_committed():
    src = pathlib.Path(Q.__file__).read_text()
    assert "iLE7akLJFkCQAK5fCCMqgybzC" not in src
    assert 'os.environ.get("TRIVIA_API_KEY", "")' in src       # env only, empty default


def test_environment_is_the_only_source_of_key_and_offline_flag():
    import os
    import subprocess
    import sys
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    probe = "import questions as Q; print(repr(Q._TRIVIA_API_KEY), Q.OFFLINE)"

    def boot(**env):
        base = {k: v for k, v in os.environ.items()
                if k not in ("TRIVIA_API_KEY", "TRIVIA_OFFLINE")}
        out = subprocess.run([sys.executable, "-c", probe], cwd=root,
                             env={**base, **env}, capture_output=True, text=True,
                             timeout=60)
        assert out.returncode == 0, out.stderr
        return out.stdout.split()

    assert boot() == ["''", "False"]                      # nothing set: no key at all
    assert boot(TRIVIA_API_KEY=" abc ", TRIVIA_OFFLINE="1") == ["'abc'", "True"]
    assert boot(TRIVIA_OFFLINE="0") == ["''", "False"]


def test_key_is_sent_only_when_configured(monkeypatch):
    sent = []

    class FakeClient:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, params=None, headers=None):
            sent.append(dict(headers or {}))

            class R:
                def raise_for_status(self):
                    pass

                def json(self):
                    return [{"type": "text_choice", "difficulty": "hard",
                             "question": {"text": f"Live Q{len(sent)}?"},
                             "correctAnswer": "A",
                             "incorrectAnswers": ["B", "C", "D"]}]
            return R()

    monkeypatch.setattr(Q.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(Q, "OFFLINE", False)
    bank = Q.TriviaAPIBank()
    monkeypatch.setattr(Q, "_TRIVIA_API_KEY", "")
    got = run(bank._fetch(5))
    assert sent[-1] == {} and len(got) == 1 and got[0]["d"] == 2    # no key → no header
    monkeypatch.setattr(Q, "_TRIVIA_API_KEY", "from-the-env")
    run(bank._fetch(5))
    assert sent[-1] == {"X-API-Key": "from-the-env"}


# ── the live-API path never blocks or throws into the request path ──────────
def test_offline_flag_means_no_network(monkeypatch):
    monkeypatch.setattr(Q, "OFFLINE", True)

    class Boom:
        def __init__(self, **kw):
            raise AssertionError("TRIVIA_OFFLINE=1 must never open a client")
    monkeypatch.setattr(Q.httpx, "AsyncClient", Boom)
    bank = Q.TriviaAPIBank()
    assert run(bank._fetch(10)) == []
    assert run(asyncio.wait_for(bank.refill_loop(), 1)) is None    # returns at once
    assert bank.get(1)["options"]                                   # bundle serves


def test_refill_loop_survives_a_failing_api_and_backs_off(monkeypatch):
    monkeypatch.setattr(Q, "OFFLINE", False)
    calls, sleeps = [], []

    async def failing(self, n):
        calls.append(n)
        raise RuntimeError("503 / DNS / junk")

    async def fake_sleep(d):
        sleeps.append(d)
        if len(sleeps) >= 8:
            raise asyncio.CancelledError
    monkeypatch.setattr(Q.TriviaAPIBank, "_fetch", failing)
    monkeypatch.setattr(Q.asyncio, "sleep", fake_sleep)
    bank = Q.TriviaAPIBank()
    with pytest.raises(asyncio.CancelledError):
        run(bank.refill_loop())
    assert len(calls) == 8                       # it kept going after every failure
    assert sleeps == sorted(sleeps) and sleeps[-1] > sleeps[0]      # …more slowly
    assert sleeps[-1] <= Q.TriviaAPIBank.RETRY_MAX
    assert bank.get(3)["options"]                # and battles never noticed


def test_api_payload_is_parsed_defensively(monkeypatch):
    monkeypatch.setattr(Q, "_SERVED", set())
    bank = Q.TriviaAPIBank()
    good = {"type": "text_choice", "difficulty": "medium",
            "question": {"text": "Good &amp; proper?"}, "correctAnswer": "Yes",
            "incorrectAnswers": ["No", "Maybe", "Never"]}
    junk = [None, 7, "str", [], {}, {"type": "image_choice"},
            {**good, "question": None}, {**good, "correctAnswer": 5},
            {**good, "incorrectAnswers": ["No"]},
            {**good, "incorrectAnswers": ["Yes", "No", "Maybe"]},      # answer among the wrongs
            {**good, "question": {"text": "x" * 5000}},
            {**good, "incorrectAnswers": ["No", None, "Never"]}]
    assert bank._parse("not a list") == [] and bank._parse(None) == []
    out = bank._parse(junk + [good, dict(good)])                     # + a duplicate
    assert len(out) == 1
    q = out[0]
    assert q["text"] == "Good & proper?" and q["d"] == 1
    assert q["options"][q["correct"]] == "Yes" and len(q["options"]) == 4


def test_get_never_raises_even_with_a_corrupt_buffer(bundle):
    bundle(clio={None: 20})
    bank = Q.TriviaAPIBank()
    bank.buffer = [None, {"nope": 1}, 5]
    for tier in (0, 1, 2, 3, 4, 99, None, "x"):
        q = bank.get(tier)
        assert q["options"][q["correct"]] == "right"


def test_live_questions_are_not_repeated_and_respect_tier(bundle):
    bundle(clio={1: 20, 2: 20, 3: 20})
    bank = Q.TriviaAPIBank()
    bank.buffer = [{"text": "live medium", "options": list("abcd"), "correct": 0, "d": 1},
                   {"text": "live hard", "options": list("abcd"), "correct": 0, "d": 2}]
    assert bank.get(1)["text"] == "live medium"            # STRIKE takes the easier one
    assert bank.get(3)["d"] == 3                           # MAGIC: the bundle's brutal pool
    assert bank.get(2)["text"] == "live hard"
    assert "live medium" in Q._SERVED and not bank.buffer
    # a later refill offering the same question again is dropped
    again = bank._parse([{"type": "text_choice", "difficulty": "medium",
                          "question": {"text": "live medium"}, "correctAnswer": "a",
                          "incorrectAnswers": ["b", "c", "d"]}])
    assert again == []


# ── difficulty tiers ─────────────────────────────────────────────────────────
def test_tiers_map_to_difficulty(bundle):
    bundle(clio={1: 30, 2: 30, 3: 30}, athena={1: 30, 2: 30, 3: 30})
    bank = Q.QuestionBank()
    for tier in (1, 2, 3):
        for _ in range(25):
            q = run(bank.get("clio", tier))
            assert q["d"] == tier and q["text"].startswith("clio")


def test_bundle_without_d_fields_serves_every_tier(bundle):
    bundle(clio={None: 30}, apollo={None: 30})             # today's file: no "d" at all
    bank = Q.QuestionBank()
    for tier in (1, 2, 3):
        q = run(bank.get("apollo", tier))
        assert q["d"] == 2 and q["text"].startswith("apollo")
    assert Q.TriviaAPIBank().get(1)["d"] == 2
    assert Q.TriviaAPIBank().get(3)["d"] == 2


def test_thin_pools_fall_back_gracefully(bundle):
    # no d1 and no d3 at all → both fall back to 2
    bundle(clio={2: 30})
    bank = Q.QuestionBank()
    assert run(bank.get("clio", 1))["d"] == 2
    assert run(bank.get("clio", 3))["d"] == 2
    # a THIN d3 pool (3 cards) is widened with d2 rather than recycled at once
    bundle(clio={1: 30, 2: 30, 3: 3})
    seen = collections.Counter(run(bank.get("clio", 3))["d"] for _ in range(33))
    assert seen == {3: 3, 2: 30}                           # all 33 distinct cards
    # tier I prefers 1, then 2 — never jumps to brutal while 2 exists
    bundle(clio={1: 2, 2: 30, 3: 30})
    seen = collections.Counter(run(bank.get("clio", 1))["d"] for _ in range(32))
    assert seen == {1: 2, 2: 30}
    # an unknown domain / odd tier still gets a question
    assert run(bank.get("nowhere", 2))["options"]
    assert run(bank.get(None, 7))["options"]
    assert run(bank.get("clio", "III"))["options"]


def test_bad_d_values_are_treated_as_hard(bundle):
    t = bundle(clio={2: 20})
    for it, d in zip(t["clio"], [0, 4, "1", None, True, 2.5, -1]):
        it["d"] = d
    assert all(Q.difficulty(it) == 2 for it in t["clio"])


def test_strike_is_never_harder_than_magic(bundle):
    bundle(clio={1: 40, 2: 40, 3: 40})
    bank = Q.TriviaAPIBank()
    strike = [bank.get(1)["d"] for _ in range(30)]         # STRIKE vs a pack
    boss = [bank.get(2)["d"] for _ in range(30)]           # STRIKE vs a boss
    magic = [bank.get(3)["d"] for _ in range(30)]          # MAGIC / the Sword / heal
    assert set(strike) == {1} and set(boss) == {2} and set(magic) == {3}


def test_real_bundle_honours_d_when_present():
    ds = collections.Counter(Q.difficulty(it) for it in Q._ALL_TRIVIA)
    assert Q._ALL_TRIVIA and set(ds) <= {1, 2, 3}
    bank = Q.QuestionBank()
    for dom in Q.TRIVIA:
        have = {Q.difficulty(it) for it in Q.TRIVIA[dom]}
        for tier in (1, 2, 3):
            q = run(bank.get(dom, tier))
            assert len(q["options"]) == 4 and 0 <= q["correct"] < 4
            if sum(1 for it in Q.TRIVIA[dom] if Q.difficulty(it) == tier) >= Q.THIN_POOL:
                assert q["d"] == tier
            else:
                assert q["d"] in have


# ── no repeats ───────────────────────────────────────────────────────────────
def test_no_repeat_until_the_pool_is_exhausted(bundle):
    bundle(clio={1: 15, 2: 25})
    bank = Q.QuestionBank()
    first = [run(bank.get("clio", 2))["text"] for _ in range(25)]
    assert len(set(first)) == 25                           # every card once…
    second = [run(bank.get("clio", 2))["text"] for _ in range(25)]
    assert len(set(second)) == 25 and set(second) == set(first)   # …then a reshuffle


def test_no_repeat_spans_banks_voyages_and_battles(bundle):
    bundle(clio={2: 20}, athena={2: 20})
    temple, other_voyage, battle = Q.QuestionBank(), Q.QuestionBank(), Q.TriviaAPIBank()
    seen = [run(temple.get("clio", 2))["text"] for _ in range(10)]
    seen += [run(other_voyage.get("clio", 2))["text"] for _ in range(10)]
    assert len(set(seen)) == 20                            # a new bank shares the memory
    seen += [battle.get(2)["text"] for _ in range(20)]     # battles draw from every muse…
    assert len(set(seen)) == 40                            # …and skip what temples asked
    seen += [Q.trivia_pick(random.Random(1))["text"]]
    assert len(set(seen)) == 40                            # all spent → only now a repeat


def test_real_bundle_does_not_repeat_within_a_long_session():
    Q._SERVED.clear()
    bank, battle = Q.QuestionBank(), Q.TriviaAPIBank()
    battle.buffer.clear()
    texts = []
    rng = random.Random(4)
    for _ in range(300):                                   # several voyages' worth
        if rng.random() < 0.5:
            texts.append(run(bank.get(rng.choice(list(Q.TRIVIA)), rng.choice((1, 2, 3))))["text"])
        else:
            texts.append(battle.get(rng.choice((1, 2, 3)))["text"])
    assert len(set(texts)) == 300


def test_missing_bundle_falls_back_to_the_safety_net(bundle):
    bundle()                                               # data/trivia.json unreadable
    bank = Q.QuestionBank()
    seen = [run(bank.get("clio", 1))["text"] for _ in range(12)]
    assert len(set(seen)) == 12                            # 6 medium + 6 hard, no repeat
    assert all(len(run(bank.get(d, t))["options"]) == 4
               for d in ("athena", "nowhere", None) for t in (1, 2, 3))
    assert Q.TriviaAPIBank().get(3)["options"]
    assert Q.trivia_pick(random.Random(0))["options"]


def test_malformed_bundle_rows_are_dropped_at_load():
    assert Q._valid_item({"q": "Q?", "a": "A", "w": ["B"]})
    for bad in (None, [], "x", {}, {"q": "Q?"}, {"q": "", "a": "A", "w": ["B"]},
                {"q": "Q?", "a": "A", "w": []}, {"q": "Q?", "a": "A", "w": [1, 2, 3]},
                {"q": 5, "a": "A", "w": ["B"]}):
        assert not Q._valid_item(bad)


# ── the Jeopardy board ───────────────────────────────────────────────────────
def test_jeopardy_board_shape_bands_and_no_repeats():
    Q._J_SERVED.clear()
    rng = random.Random(2)
    seen = set()
    for band, values in (("low", {200, 400}), ("high", {800, 1000})):
        for _ in range(150):
            cells = Q.jeopardy_board(rng, band)
            assert len(cells) == 4
            assert len({c["category"].lower() for c in cells}) == 4
            for c in cells:
                assert c["value"] in values and c["text"] and c["answer"]
                assert (c["text"], c["answer"]) not in seen
                seen.add((c["text"], c["answer"]))
    q = Q.jeopardy_question(cells[0])
    assert q["typed"] is True and q["answer"] == cells[0]["answer"]
    assert Q.jeopardy_pick(rng)["typed"] is True


def test_jeopardy_board_survives_a_missing_or_damaged_deck(monkeypatch):
    monkeypatch.setattr(Q, "JEOPARDY", {})
    cells = Q.jeopardy_board(random.Random(0), "high")
    assert len(cells) == 4 and all(c["answer"] for c in cells)
    monkeypatch.setattr(Q, "JEOPARDY", {"200": [["A", "clue", "ans"], ["bad"], None, 7],
                                        "400": "not a list"})
    monkeypatch.setattr(Q, "_J_SERVED", set())
    cells = Q.jeopardy_board(random.Random(0), "low")
    assert len(cells) == 4 and cells[0]["answer"]
    assert Q.jeopardy_board(random.Random(0), "nonsense-band")


# ── the typed-answer matcher ─────────────────────────────────────────────────
ACCEPT = [
    # the engine suite's own cases (tests/test_game.py) — kept
    ("Hemingway", "(Ernest) Hemingway"), ("ernest hemingway", "(Ernest) Hemingway"),
    ("the jordan", "Jordan"), ("jordan", "the Jordan"),
    ("Mozart", "Wolfgang Amadeus Mozart"), ("a raisin in the sun", "A Raisin in the Sun"),
    ("Hemmingway", "(Ernest) Hemingway"), ("Carthag", "Carthage"),
    ("dardanells", "The Dardanelles"), ("Beethovan", "Beethoven"),
    # numbers: words ↔ digits, ordinals, Roman numerals, thousands separators
    ("twelve", "12"), ("12", "twelve"), ("twenty one", "21"), ("twenty-one", "21"),
    ("5280", "5,280"), ("5,280 feet", "5,280"), ("nineteen eighty four", "1984"),
    ("Henry the Eighth", "Henry VIII"), ("henry 8", "Henry VIII"),
    ("world war 2", "World War II"), ("world war two", "World War II"),
    ("july 4th", "the Fourth of July"), ("4th of july", "the Fourth of July"),
    ("seven eight", "7, 8"), ("1980's", "the 1980s"),
    # initials and acronyms
    ("JFK", "John F. Kennedy"), ("J.F.K.", "JFK"), ("jfk", "J.F.K."),
    ("usa", "U.S.A."), ("u s a", "USA"), ("FDR", "Franklin Delano Roosevelt"),
    ("john kennedy", "John F. Kennedy"), ("kennedy", "John F. Kennedy"),
    ("federal bureau of investigation", "FBI"), ("united states", "the U.S."),
    ("hl mencken", "H.L. Mencken"), ("mencken", "H.L. Mencken"),
    ("washington dc", "Washington, D.C."), ("washington d.c.", "Washington, DC"),
    # plurals
    ("cats", "cat"), ("cat", "cats"), ("eggs", "an egg"), ("cities", "city"),
    # "what is …", articles, spacing, apostrophes
    ("what is tea", "tea"), ("who is mozart", "Mozart"), ("What's a calf?", "a calf"),
    ("who", "Who"), ("the who", "The Who"), ("whos the boss", "Who's the Boss"),
    ("v8", "V-8"), ("acdc", "AC/DC"), ("ac dc", "AC/DC"),
    ("rosemarys baby", "Rosemary's Baby"), ("heming way", "Hemingway"),
    # alternatives: trailing parentheses, "X or Y", a replaced word
    ("Myanmar", "Burma (Myanmar)"), ("burma", "Burma (Myanmar)"),
    ("flee", "flea (flee)"), ("flea", "flea (flee)"),
    ("rein", "reign (rein) (rain)"), ("rain", "reign (rein) (rain)"),
    ("bison", "bison or buffalo"), ("buffalo", "bison or buffalo"),
    ("prow", "the bow or the prow"),
    ("motion picture camera", "movie (motion) picture camera"),
    ("movie picture camera", "movie (motion) picture camera"),
    # optional parts, pairs in either order
    ("Burton and Taylor", "(Richard) Burton & (Elizabeth) Taylor"),
    ("taylor & burton", "(Richard) Burton & (Elizabeth) Taylor"),
    ("Richard Burton and Taylor", "(Richard) Burton & (Elizabeth) Taylor"),
    ("clark and lewis", "Lewis & Clark"), ("lord of rings", "The Lord of the Rings"),
    # surnames, class words, titles, fuller forms
    ("lincoln", "Abraham Lincoln"), ("abraham lincoln", "Lincoln"),
    ("president lincoln", "Lincoln"), ("I think it's mozart", "Mozart"),
    ("king", "Martin Luther King Jr."), ("martin luther king", "Martin Luther King, Jr."),
    ("poe", "Edgar Allan Poe"), ("van gogh", "Vincent van Gogh"),
    ("mississippi", "the Mississippi River"), ("everest", "Mount Everest"),
    ("lake erie", "Erie"), ("victoria", "Queen Victoria"), ("queen victoria", "Victoria"),
    ("new york", "New York City"), ("Salinas", "Salinas, California"),
    ("quinn", "Anthony Quinn"), ("de gaulle", "Charles de Gaulle"),
    ("nemo", "Captain Nemo"), ("seuss", "Dr. Seuss"), ("milne", "A.A. Milne"),
    ("saint louis", "St. Louis"), ("st louis", "Saint Louis"),
    ("mt everest", "Mount Everest"),
    # typos (one swap is one slip), common misspellings of names
    ("shakespere", "William Shakespeare"), ("william shakespere", "Shakespeare"),
    ("einstien", "Albert Einstein"), ("tchaikovski", "Tchaikovsky"),
    ("katherine hepburn", "Katharine Hepburn"), ("jane austin", "Jane Austen"),
    # odd but real deck answers match themselves
    ("or", "or"), ("I", "I"), ("7, 8", "7, 8"), ("N", "N"),
]

REJECT = [
    ("Beethoven", "Mozart"), ("", "Mozart"), ("   ", "Mozart"), ("?!", "Mozart"),
    ("Iraq", "Iran"), ("gold", "cold"), ("Corinth", "Carthage"),
    # one stray word of the answer
    ("of", "the Gulf of Mexico"), ("and", "Gilbert & Sullivan"),
    ("the", "The Lord of the Rings"), ("a", "A Raisin in the Sun"),
    ("sun", "A Raisin in the Sun"), ("mexico", "the Gulf of Mexico"),
    ("gulf", "the Gulf of Mexico"), ("john", "John Adams"),
    ("wolfgang", "Wolfgang Amadeus Mozart"), ("new", "New York"), ("york", "New York"),
    ("bridge", "Golden Gate Bridge"), ("party", "Boston Tea Party"),
    ("war", "the Civil War"), ("sea", "the Dead Sea"), ("lake", "Lake Titicaca"),
    ("river", "the Mississippi River"), ("kansas", "Kansas City"),
    ("president", "President Lincoln"), ("mr", "Mr. T"),
    # the last word of a PHRASE is not a surname
    ("cat", "the Sphinx cat"), ("table", "pool table"), ("pie", "Boston cream pie"),
    ("travels", "Gulliver's Travels"), ("death", "the Red Death"),
    ("poetic", "poetic justice"), ("commanders", "commanders in chief"),
    ("lewis", "(Dean) Martin & (Jerry) Lewis"), ("martin", "(Dean) Martin & (Jerry) Lewis"),
    # half of a pair
    ("gilbert", "Gilbert & Sullivan"), ("sullivan", "Gilbert & Sullivan"),
    ("lewis", "Lewis & Clark"), ("juliet", "Romeo and Juliet"),
    # shotgun guessing
    ("paris london rome berlin madrid", "Rome"), ("iraq iran syria", "Iran"),
    ("iran or iraq", "Iran"), ("iran, iraq", "Iran"), ("iran/iraq", "Iraq"),
    # numbers are exact
    ("thirteen", "12"), ("11", "twelve"), ("apollo 11", "Apollo 13"),
    ("apollo", "Apollo 13"), ("world war i", "World War II"), ("world war", "World War II"),
    ("henry vii", "Henry VIII"), ("henry", "Henry VIII"), ("louis xvi", "Louis XIV"),
    ("1985", "1984"), ("10001", "10000"), ("seventy", "seventh"), ("sixth", "sixty"),
    ("elizabeth", "Elizabeth II"), ("elizabeth i", "Elizabeth II"),
    # a near-miss that is really a different answer
    ("south carolina", "North Carolina"), ("north korea", "South Korea"),
    ("monet", "Manet"), ("manet", "Monet"), ("iceland", "Ireland"),
    ("austria", "Australia"), ("plato", "Pluto"), ("keats", "Yeats"),
    ("fluorine", "chlorine"), ("slovenia", "Slovakia"), ("mars", "Marx"),
    # a different person who shares a word
    ("magic johnson", "Andrew Johnson"), ("henry fielding", "Henry James"),
    ("the east river", "the Mississippi River"), ("chita rivera", "China"),
    ("tommy lee jones", "Bones"), ("heart of darkness", "Patty Hearst"),
]


@pytest.mark.parametrize("given,answer", ACCEPT)
def test_matcher_accepts(given, answer):
    assert C(given, answer)


@pytest.mark.parametrize("given,answer", REJECT)
def test_matcher_rejects(given, answer):
    assert not C(given, answer)


def test_matcher_is_total_and_bounded():
    import time
    for given in (None, 5, ["x"], {"a": 1}, b"bytes", 3.5):
        assert C(given, "Mozart") is False
    assert C("Mozart", None) is False and C("x", "") is False
    # an essay is refused outright — edit distance on it would be quadratic
    t = time.perf_counter()
    assert C("mozart " * 3000, "Mozart") is False
    assert C("a" * 100_000, "b" * 30) is False
    assert time.perf_counter() - t < 0.2


def test_matcher_typo_tolerance_scales_with_length():
    assert not C("par", "Paris") and not C("tee", "tea") and not C("Irak", "Iraq")
    assert C("Parris", "Paris")                       # 5–7 letters: one slip
    assert not C("Parrris", "Paris")
    assert C("Missisippi", "Mississippi") and C("Mississipi River", "the Mississippi River")
    assert C("Tutankamon", "Tutankhamun")             # 8–11 letters: two slips
    assert not C("Tutenkamon", "Tutankhamun")         # …not three


def test_whole_deck_stays_typeable():
    """A fast slice of tests/test_jeopardy_data.py: every answer, lower-cased,
    upper-cased and Jeopardy-style ("what is …"), is accepted."""
    rng = random.Random(8)
    answers = sorted({c[2] for deck in Q.JEOPARDY.values() for c in deck})
    for ans in rng.sample(answers, min(4000, len(answers))):
        assert C(ans, ans) and C(ans.lower(), ans) and C(ans.upper(), ans), ans
        assert C("what is " + ans, ans), ans


def test_distinct_deck_answers_rarely_cross_accept():
    """Statistical guard on false accepts: pick two different answers from the
    deck at random — one must (almost) never be accepted for the other. The
    old matcher let ~40 in 100,000 through; the survivors now are true
    equivalents (plurals, 'Harry Truman' / 'Truman')."""
    rng = random.Random(5)
    raw = [c[2] for deck in Q.JEOPARDY.values() for c in deck]
    hits = 0
    for _ in range(40_000):
        a, b = rng.choice(raw), rng.choice(raw)
        if Q._norm_answer(a) != Q._norm_answer(b) and C(a, b):
            hits += 1
    assert hits <= 8, hits

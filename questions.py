"""
Question service — The Trivia API (the-trivia-api.com/v2) with offline fallback.

The four Thalassa domains map onto the API's fixed category list; game tiers
map onto API difficulties (never "easy" — the floor is medium, by design).

    tier 1 (wager I)            → medium
    tier 2 (wager II)           → hard
    tier 3 (wager III / trials) → hard
    tier 4 (the Oracle)         → hard

Set TRIVIA_API_KEY for authenticated access (higher rate limits; required for
commercial use per the API's terms). Set TRIVIA_OFFLINE=1 to skip the network
entirely and play from the built-in fallback set (dev / airgapped).
"""
from __future__ import annotations

import asyncio
import os
import random
import time

import httpx

API = "https://the-trivia-api.com/v2/questions"
DOMAIN_CATEGORIES = {
    "clio": ["history", "geography"],
    "athena": ["science"],
    "apollo": ["arts_and_literature", "general_knowledge"],
    "dionysos": ["music", "film_and_tv", "sport_and_leisure",
                 "society_and_culture", "food_and_drink"],
}
TIER_DIFFICULTY = {1: "medium", 2: "hard", 3: "hard", 4: "hard"}
LOW_WATER = 6          # refill a pool when it drops below this
BATCH = 25
MIN_REQ_INTERVAL = 1.5


def _shape(text: str, correct: str, incorrect: list[str], rng: random.Random) -> dict:
    options = [correct] + list(incorrect[:3])
    rng.shuffle(options)
    return {"text": text, "options": options, "correct": options.index(correct)}


class QuestionBank:
    def __init__(self):
        self.rng = random.Random()
        self.offline = os.environ.get("TRIVIA_OFFLINE") == "1"
        self.api_key = os.environ.get("TRIVIA_API_KEY", "")
        self.pools: dict[tuple[str, str], list[dict]] = {
            (d, diff): [] for d in DOMAIN_CATEGORIES for diff in ("medium", "hard")
        }
        self.seen: set[str] = set()
        self._last_req = 0.0
        self._api_ok = not self.offline

    def counts(self) -> dict:
        return {f"{d}/{diff}": len(q) for (d, diff), q in self.pools.items()}

    async def get(self, domain: str, tier: int) -> dict:
        """Return one shaped question; never blocks on the network for long."""
        diff = TIER_DIFFICULTY.get(tier, "hard")
        pool = self.pools[(domain, diff)]
        if not pool and self._api_ok:
            try:
                await self._refill(domain, diff)
            except Exception:
                pass
        if pool:
            return pool.pop(self.rng.randrange(len(pool)))
        return self._fallback(domain, diff)

    def _fallback(self, domain: str, diff: str) -> dict:
        candidates = FALLBACK[domain][diff] + FALLBACK[domain]["medium" if diff == "hard" else "hard"]
        raw = self.rng.choice(candidates)
        return _shape(raw[0], raw[1], list(raw[2]), self.rng)

    async def _refill(self, domain: str, diff: str):
        now = time.monotonic()
        wait = MIN_REQ_INTERVAL - (now - self._last_req)
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_req = time.monotonic()
        params = {
            "limit": str(BATCH),
            "categories": ",".join(DOMAIN_CATEGORIES[domain]),
            "difficulties": diff,
            "types": "text_choice",
        }
        headers = {"X-API-Key": self.api_key} if self.api_key else {}
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(API, params=params, headers=headers)
            r.raise_for_status()
            items = r.json()
        pool = self.pools[(domain, diff)]
        for it in items:
            qid = it.get("id")
            if not qid or qid in self.seen:
                continue
            self.seen.add(qid)
            try:
                pool.append(_shape(it["question"]["text"], it["correctAnswer"],
                                   it["incorrectAnswers"], self.rng))
            except (KeyError, TypeError):
                continue
        if len(self.seen) > 20000:      # unbounded-growth guard
            self.seen.clear()

    async def refill_loop(self):
        """Background top-up so questions appear instantly during play."""
        if self.offline:
            return
        while True:
            for (domain, diff), pool in self.pools.items():
                if len(pool) < LOW_WATER:
                    try:
                        await self._refill(domain, diff)
                        self._api_ok = True
                    except Exception:
                        self._api_ok = False
                        await asyncio.sleep(30)
                        break
            await asyncio.sleep(5)


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

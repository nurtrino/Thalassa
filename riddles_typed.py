"""
THALASSA — Typed-answer riddles for "Riddle of the Isle" (30s clock).

Drop-in replacement / expansion for RIDDLES in puzzles.py.

Format per entry:
    category : themed group (10 each)
    prompt   : the riddle text shown to the player (safe to send to client)
    answer   : canonical answer (kept SERVER-SIDE -> data["secret"])
    accept   : extra normalized strings the checker will accept

Server contract:
  - Only `prompt` (and category, if you want) is sent to the client.
  - `answer` / `accept` go under data["secret"] and are stripped in server.py.
  - check_riddle() normalizes: lowercase, strip, drop leading "a "/"an "/"the ",
    strip trailing punctuation, collapse whitespace. Matches answer OR any accept.

All answers are single words -> fast to type inside a 30-second budget.
"""

import random


def _norm(s: str) -> str:
    s = (s or "").strip().lower()
    for lead in ("the ", "a ", "an "):
        if s.startswith(lead):
            s = s[len(lead):]
    s = s.strip(" .,!?'\"-")
    return " ".join(s.split())


def check_riddle(secret: dict, guess: str) -> bool:
    """Server-side check. `secret` = {"answer":..., "accept":[...]}."""
    g = _norm(guess)
    if not g:
        return False
    valid = {_norm(secret["answer"])}
    valid.update(_norm(a) for a in secret.get("accept", []))
    return g in valid


def deal_riddle(rng: random.Random, used: set):
    """Pick an unused riddle. Returns (public_payload, secret). Rerolls category-fair."""
    pool = [r for i, r in enumerate(RIDDLES) if i not in used]
    if not pool:
        used.clear()
        pool = list(RIDDLES)
    choice = rng.choice(pool)
    idx = RIDDLES.index(choice)
    used.add(idx)
    public = {"kind": "riddle", "category": choice["category"], "prompt": choice["prompt"]}
    secret = {"answer": choice["answer"], "accept": choice["accept"]}
    return public, secret


RIDDLES = [

    # ── The Sea & The Ship ─────────────────────────────────────────────
    {"category": "The Sea & The Ship",
     "prompt": "I bite the seabed to hold you still,\niron-jawed, though I drink no wind.\nHaul me up when you would roam. What am I?",
     "answer": "anchor", "accept": ["an anchor"]},
    {"category": "The Sea & The Ship",
     "prompt": "Wind is my master, cloth is my skin;\nI swell with his breath and pull you in.\nFurl me at dusk, unfurl me at dawn.",
     "answer": "sail", "accept": ["a sail", "sails"]},
    {"category": "The Sea & The Ship",
     "prompt": "Tallest tree on a deck of oak,\nbare of leaves yet bearing the sail.",
     "answer": "mast", "accept": ["the mast", "mainmast"]},
    {"category": "The Sea & The Ship",
     "prompt": "I have no eyes, yet I always find north.",
     "answer": "compass", "accept": ["a compass", "the compass"]},
    {"category": "The Sea & The Ship",
     "prompt": "I stand on the rock and never set sail;\nmy one eye burns to keep ships from the gale.",
     "answer": "lighthouse", "accept": ["a lighthouse", "light house", "beacon"]},
    {"category": "The Sea & The Ship",
     "prompt": "I am born far out, I run to the shore,\nI break myself there and am seen no more.",
     "answer": "wave", "accept": ["a wave", "waves"]},
    {"category": "The Sea & The Ship",
     "prompt": "I open my arms to the weary at sea:\nstone walls for a hug, still water for tea.",
     "answer": "harbor", "accept": ["harbour", "a harbor", "port", "the harbor"]},
    {"category": "The Sea & The Ship",
     "prompt": "In pairs we pull though we never grow tired,\nwe dip and we rise as the rower desired.",
     "answer": "oar", "accept": ["oars", "an oar", "the oars"]},
    {"category": "The Sea & The Ship",
     "prompt": "A grain of grief inside a shell\nbecomes a small moon I can sell.",
     "answer": "pearl", "accept": ["a pearl", "pearls"]},
    {"category": "The Sea & The Ship",
     "prompt": "Cast overboard, I measure the deep;\na knotted line is the count I keep.",
     "answer": "sounding", "accept": ["lead line", "sounding lead", "plumb", "lead"]},

    # ── Gods & Heroes ──────────────────────────────────────────────────
    {"category": "Gods & Heroes",
     "prompt": "Three-pronged spear and a beard of foam,\nthe shaking earth and the sea are my home.",
     "answer": "poseidon", "accept": ["neptune"]},
    {"category": "Gods & Heroes",
     "prompt": "Wax and feather lifted me high;\nthe sun's warm kiss let me fall from the sky.",
     "answer": "icarus", "accept": []},
    {"category": "Gods & Heroes",
     "prompt": "Ten years to war and ten years to roam;\nby wit, not by strength, I steered myself home.",
     "answer": "odysseus", "accept": ["ulysses"]},
    {"category": "Gods & Heroes",
     "prompt": "All that I touched turned golden and cold —\neven my bread, even my child.",
     "answer": "midas", "accept": ["king midas"]},
    {"category": "Gods & Heroes",
     "prompt": "Upon my shoulders the heavens sit;\nI dare not shrug, or the sky would split.",
     "answer": "atlas", "accept": []},
    {"category": "Gods & Heroes",
     "prompt": "Winged at the heel, I carry the word:\nthief, guide, and messenger, swift as a bird.",
     "answer": "hermes", "accept": ["mercury"]},
    {"category": "Gods & Heroes",
     "prompt": "I loved the face in the still pool so,\nI could not leave, and I withered slow.",
     "answer": "narcissus", "accept": []},
    {"category": "Gods & Heroes",
     "prompt": "Each dawn I drive my fiery cart\nfrom east to west across the sky.",
     "answer": "helios", "accept": ["apollo", "sol"]},
    {"category": "Gods & Heroes",
     "prompt": "Half the year in the dark I dwell,\nhalf in the light — my mother knows the tale.",
     "answer": "persephone", "accept": ["kore", "proserpina"]},
    {"category": "Gods & Heroes",
     "prompt": "Loom by day, unravelled by night —\nI wove to keep the suitors from my sight.",
     "answer": "penelope", "accept": []},

    # ── Beasts & Monsters ──────────────────────────────────────────────
    {"category": "Beasts & Monsters",
     "prompt": "Man below, bull above, I pace a maze\nand wait for the tribute the city pays.",
     "answer": "minotaur", "accept": ["the minotaur"]},
    {"category": "Beasts & Monsters",
     "prompt": "Look upon my hair and you turn to stone;\nsnakes for my locks, I sit alone.",
     "answer": "medusa", "accept": ["gorgon"]},
    {"category": "Beasts & Monsters",
     "prompt": "One round eye in the middle of me;\nI herd my sheep in a cave by the sea.",
     "answer": "cyclops", "accept": ["polyphemus"]},
    {"category": "Beasts & Monsters",
     "prompt": "My song on the rocks is honey and doom;\nfollow my voice to a watery tomb.",
     "answer": "siren", "accept": ["sirens", "a siren"]},
    {"category": "Beasts & Monsters",
     "prompt": "Cut off one head and two will grow;\na fetid swamp is the lair I know.",
     "answer": "hydra", "accept": ["the hydra"]},
    {"category": "Beasts & Monsters",
     "prompt": "Answer my riddle or never pass:\nlion of body, woman of face.",
     "answer": "sphinx", "accept": ["the sphinx"]},
    {"category": "Beasts & Monsters",
     "prompt": "Three heads I keep at the gate of the dead;\nno soul slips out once I have been fed.",
     "answer": "cerberus", "accept": []},
    {"category": "Beasts & Monsters",
     "prompt": "Born of a slain Gorgon's blood, with wings I fly —\na white horse that gallops across the sky.",
     "answer": "pegasus", "accept": []},
    {"category": "Beasts & Monsters",
     "prompt": "Lion in front, a serpent behind,\ngoat in the middle and fire in the mind.",
     "answer": "chimera", "accept": ["chimaera"]},
    {"category": "Beasts & Monsters",
     "prompt": "Deep I sleep till the tide runs black,\nthen arms like masts drag the ship back.",
     "answer": "kraken", "accept": ["the kraken"]},

    # ── Sky, Land & Element ────────────────────────────────────────────
    {"category": "Sky, Land & Element",
     "prompt": "Feed me and I live; give me a drink and I die.",
     "answer": "fire", "accept": ["flame", "a flame"]},
    {"category": "Sky, Land & Element",
     "prompt": "You cannot see me, cannot hold;\nI bend the trees and carry the cold.",
     "answer": "wind", "accept": ["the wind", "air", "breeze"]},
    {"category": "Sky, Land & Element",
     "prompt": "I follow you all day in the sun,\nbut hide in the dark and then I am none.",
     "answer": "shadow", "accept": ["a shadow", "your shadow"]},
    {"category": "Sky, Land & Element",
     "prompt": "I wax and I wane through the month's long night;\nI borrow from the sun to lend you my light.",
     "answer": "moon", "accept": ["the moon"]},
    {"category": "Sky, Land & Element",
     "prompt": "I am in every sea yet I weigh nothing at all;\nI season the bread and I ring in your tears.",
     "answer": "salt", "accept": []},
    {"category": "Sky, Land & Element",
     "prompt": "I run but never walk, I have a mouth but never talk,\nI have a bed but never sleep.",
     "answer": "river", "accept": ["a river", "the river"]},
    {"category": "Sky, Land & Element",
     "prompt": "I have a foot and a face and a spine,\nyet I never move — I stand through all time.",
     "answer": "mountain", "accept": ["a mountain"]},
    {"category": "Sky, Land & Element",
     "prompt": "After the storm I arch through the sky —\nseven colours, no two alike, then I die.",
     "answer": "rainbow", "accept": ["a rainbow"]},
    {"category": "Sky, Land & Element",
     "prompt": "A thousand thousand grains of me\nmake the beach where the waves meet the sea.",
     "answer": "sand", "accept": []},
    {"category": "Sky, Land & Element",
     "prompt": "I bring the black cloud and the fork of light,\nand beat my drum through the rattling night.",
     "answer": "storm", "accept": ["a storm", "thunderstorm", "tempest"]},

    # ── Wordplay & Wit ─────────────────────────────────────────────────
    {"category": "Wordplay & Wit",
     "prompt": "The more you take, the more you leave behind. What am I?",
     "answer": "footsteps", "accept": ["footprints", "steps", "footstep"]},
    {"category": "Wordplay & Wit",
     "prompt": "I have keys but no locks, space but no room;\nyou can enter, but you cannot go in.",
     "answer": "keyboard", "accept": ["a keyboard"]},
    {"category": "Wordplay & Wit",
     "prompt": "I have a neck but no head, two arms but no hands.",
     "answer": "shirt", "accept": ["a shirt"]},
    {"category": "Wordplay & Wit",
     "prompt": "I have hands but cannot clap, a face but never a smile.",
     "answer": "clock", "accept": ["a clock", "watch"]},
    {"category": "Wordplay & Wit",
     "prompt": "I have one eye but cannot see, and I trail a tail of thread.",
     "answer": "needle", "accept": ["a needle"]},
    {"category": "Wordplay & Wit",
     "prompt": "I have many teeth but I never bite;\nI run through your hair each morning light.",
     "answer": "comb", "accept": ["a comb"]},
    {"category": "Wordplay & Wit",
     "prompt": "I travel the whole world while stuck in a corner. What am I?",
     "answer": "stamp", "accept": ["a stamp", "postage stamp"]},
    {"category": "Wordplay & Wit",
     "prompt": "The more I dry, the wetter I become. What am I?",
     "answer": "towel", "accept": ["a towel"]},
    {"category": "Wordplay & Wit",
     "prompt": "The taller I stand the shorter I grow, and my breath is a flame.",
     "answer": "candle", "accept": ["a candle"]},
    {"category": "Wordplay & Wit",
     "prompt": "A box without hinges, key, or lid,\nyet golden treasure inside is hid.",
     "answer": "egg", "accept": ["an egg"]},
]


# ── quick self-test ────────────────────────────────────────────────────
if __name__ == "__main__":
    from collections import Counter

    cats = Counter(r["category"] for r in RIDDLES)
    print(f"{len(RIDDLES)} riddles across {len(cats)} categories:")
    for c, n in cats.items():
        print(f"  {n:2d}  {c}")

    # every riddle must be checkable by its own answer + all accepts
    for r in RIDDLES:
        sec = {"answer": r["answer"], "accept": r["accept"]}
        assert check_riddle(sec, r["answer"]), r["prompt"]
        assert check_riddle(sec, r["answer"].upper()), r["prompt"]
        for a in r["accept"]:
            assert check_riddle(sec, a), (r["prompt"], a)
        # a clearly wrong guess is rejected
        assert not check_riddle(sec, "zzzznotananswer"), r["prompt"]

    # no duplicate prompts
    prompts = [r["prompt"] for r in RIDDLES]
    assert len(prompts) == len(set(prompts)), "duplicate prompt"

    print("all self-tests passed.")

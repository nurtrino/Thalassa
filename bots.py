"""
Bot captains — AI opponents for the Race for the Golden Fleece.

The server drives them: on a bot's turn it asks these pure functions what to
do and sends the same actions a human client would. Bots don't see answers;
they "know" a question with a per-tier probability, so different philosophers
are genuinely easier or harder to beat. They explore honestly — their fog is
the same fog yours is.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

import game as G


@dataclass(frozen=True)
class Skill:
    name: str
    t1: float
    t2: float
    t3: float

    def accuracy(self, tier: int) -> float:
        return {0: max(0.2, self.t3 - 0.05),   # puzzles
                1: self.t1, 2: self.t2, 3: self.t3}.get(tier, self.t3)


PHILOSOPHERS = [
    Skill("Sokrates", 0.85, 0.70, 0.55),
    Skill("Hypatia", 0.80, 0.65, 0.50),
    Skill("Pythagoras", 0.75, 0.60, 0.45),
    Skill("Herodotos", 0.70, 0.55, 0.40),
    Skill("Sappho", 0.70, 0.50, 0.35),
    Skill("Diogenes", 0.55, 0.40, 0.30),
]

UPGRADE_WISHLIST = ["hull_plates", "ram", "sandals", "star_chart",
                    "owl", "aegis", "boar_spear", "lyre"]


def decide_sail(g: G.Game, pid: str, rng: random.Random) -> str:
    p = g.player_by_pid(pid)
    best, best_score = None, -1e9
    for nid in g.reachable:
        node = g.board.nodes[nid]
        known = nid in p.known
        ntype = node["type"] if known else None
        monster = g.board.alive_monster(nid)
        score = 5.0
        if ntype == "fleece":
            score = 500                                     # end it
        elif ntype == "home":
            score = 40 + 80 * len(p.cargo) + (30 if p.hull <= 2 else 0)
        elif not known:
            score = 55                                      # the fog calls
        elif ntype == "lair" and monster:
            strength = p.hull + (2 if p.has("ram") else 0)
            score = 20 + strength * 8 - monster["hp"] * 6
        elif ntype == "monster" and monster:
            score = 12 + p.hull * 3 - monster["hp"] * 4
        elif ntype == "shrine" and node.get("charges", 0) > 0:
            score = 45 if p.scrolls < 6 else 25
        elif ntype == "puzzle" and not node.get("solved"):
            score = 60 if len(p.upgrades) < 4 else 20
        elif ntype == "haven":
            score = 70 if (p.hull <= p.max_hull - 2 and p.scrolls > 0) else 5
        score += rng.random() * 6
        if score > best_score:
            best, best_score = nid, score
    return best


def decide_shrine_tier(g: G.Game, pid: str, skill: Skill, rng: random.Random) -> int:
    p = g.player_by_pid(pid)
    if skill.t3 >= 0.45 or p.scrolls >= 4:
        return 3
    return 2 if skill.t2 >= 0.45 else (1 if rng.random() < 0.6 else 2)


def decide_battle(g: G.Game, pid: str, rng: random.Random) -> str:
    """'attack' | 'guard' | 'flee' for the stance phase."""
    p = g.player_by_pid(pid)
    m = g.board.alive_monster(g.battle["node"])
    if p.hull <= 1 or (p.hull <= 2 and m["hp"] >= 3):
        return "flee"
    if p.hull <= m["power"] + 1:
        return "guard"
    return "attack"


def decide_answer(g: G.Game, skill: Skill, rng: random.Random) -> int:
    correct = g.question["correct"]
    disabled = set(g.question.get("disabled", []))
    if rng.random() < skill.accuracy(g.qctx["tier"]):
        return correct
    wrong = [i for i in range(len(g.question["options"]))
             if i != correct and i not in disabled]
    return rng.choice(wrong) if wrong else correct


def decide_upgrade(g: G.Game, pid: str) -> str:
    offer = g.upgrade_offer or []
    for want in UPGRADE_WISHLIST:
        if want in offer:
            return want
    return offer[0]

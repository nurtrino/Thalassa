"""
Bot captains — AI opponents for playtesting.

The server drives them: on a bot's turn it asks these pure functions what to
do and sends the same actions a human client would. Bots don't see answers;
they "know" a question with a per-tier probability, so different philosophers
are genuinely easier or harder to beat.

Everything here is engine-read-only. The only state a bot has is its skill.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

import board
import game as G


@dataclass(frozen=True)
class Skill:
    name: str
    t1: float          # P(correct) on a tier-I question
    t2: float
    t3: float

    def accuracy(self, tier: int) -> float:
        return {1: self.t1, 2: self.t2, 3: self.t3, 4: max(0.1, self.t3 - 0.1)}[tier]


PHILOSOPHERS = [
    Skill("Sokrates", 0.85, 0.70, 0.55),
    Skill("Hypatia", 0.80, 0.65, 0.50),
    Skill("Pythagoras", 0.75, 0.60, 0.45),
    Skill("Herodotos", 0.70, 0.55, 0.40),
    Skill("Sappho", 0.70, 0.50, 0.35),
    Skill("Diogenes", 0.55, 0.40, 0.30),
]


def _needs(p) -> list[str]:
    """Domains the bot still needs a laurel in, most-scrolls first."""
    doms = [d for d in board.DOMAINS if d not in p.laurels]
    doms.sort(key=lambda d: -p.scrolls[d])
    return doms


# ── decisions ────────────────────────────────────────────────────────────────
def decide_sail(g: G.Game, pid: str, rng: random.Random) -> str:
    """Pick a destination from g.reachable."""
    p = g.player_by_pid(pid)
    needs = _needs(p)
    best, best_score = None, -1
    for nid in g.reachable:
        ntype = board.NODES[nid]["type"]
        score = 10.0
        if ntype == "delos":
            score = 200
        elif ntype == "library" and p.last_library != nid:
            dom = g.library_domains[nid]
            if dom not in p.laurels and p.scrolls[dom] >= G.TRIAL_COST:
                score = 120                       # a trial awaits
            elif dom in needs[:2]:
                score = 60                        # scrolls toward a needed laurel
            else:
                score = 45
        elif ntype == "open" and g.plots.get(nid) is None and p.total_scrolls() >= G.HARBOR_COST:
            score = 38 if p.total_scrolls() >= G.ACADEMY_COST else 30
        elif ntype == "oracle" and p.total_scrolls() >= G.ORACLE_FEE + 1:
            score = 33
        elif ntype == "agora" and _surplus(p):
            score = 40
        score += rng.random() * 8                 # a little chaos, like a real player
        if score > best_score:
            best, best_score = nid, score
    return best


def _surplus(p) -> str | None:
    """A domain with 3+ scrolls that already has its laurel (safe to trade)."""
    for d in board.DOMAINS:
        if d in p.laurels and p.scrolls[d] >= 3:
            return d
    return None


def decide_island(g: G.Game, pid: str, skill: Skill, rng: random.Random) -> tuple[str, dict]:
    """Return (kind, payload) for the island action phase."""
    p = g.player_by_pid(pid)
    acts = g.island_actions()
    if "trial" in acts:
        return "trial", {}
    if "wager1" in acts:
        # wager as high as the bot's own confidence justifies
        if skill.t3 >= 0.45 or p.total_scrolls() >= 3:
            tier = 3
        elif skill.t2 >= 0.45:
            tier = 2
        else:
            tier = 1 if rng.random() < 0.6 else 2
        return "wager", {"tier": tier}
    if "oracle" in acts and p.total_scrolls() >= 2:
        return "oracle", {}
    if "academy" in acts:
        return "build", {"kind": "academy"}
    if "harbor" in acts and rng.random() < 0.6:
        return "build", {"kind": "harbor"}
    if "trade" in acts:
        give = _surplus(p)
        if give:
            needs = _needs(p)
            get = needs[0] if needs else board.DOMAINS[0]
            if get != give:
                return "trade", {"give": give, "get": get}
    return "pass", {}


def decide_answer(g: G.Game, skill: Skill, rng: random.Random) -> int:
    """The bot 'knows' the answer with tier-dependent probability."""
    correct = g.question["correct"]
    tier = g.qctx["tier"]
    if rng.random() < skill.accuracy(tier):
        return correct
    wrong = [i for i in range(len(g.question["options"])) if i != correct]
    return rng.choice(wrong)


def decide_claim(g: G.Game, pid: str) -> list[str]:
    """Oracle boon: push the nearest-to-trial domain to the trial cost, then spread."""
    p = g.player_by_pid(pid)
    needs = _needs(p)
    picks: list[str] = []
    for d in needs:
        while len(picks) < G.ORACLE_REWARD and p.scrolls[d] + picks.count(d) < G.TRIAL_COST:
            picks.append(d)
        if len(picks) >= G.ORACLE_REWARD:
            break
    while len(picks) < G.ORACLE_REWARD:
        picks.append(needs[0] if needs else board.DOMAINS[0])
    return picks[:G.ORACLE_REWARD]


def decide_vote(g: G.Game, rng: random.Random) -> str:
    """Symposium: pick the challenger's weakest-looking domain."""
    challenger = g.current
    doms = sorted(board.DOMAINS, key=lambda d: (challenger.scrolls[d], rng.random()))
    return doms[0]

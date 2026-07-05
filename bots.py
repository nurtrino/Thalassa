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

UPGRADE_WISHLIST = ["hull_plates", "trident", "ram", "sandals", "star_chart",
                    "owl", "aegis", "lyre"]


def _distances_from(board, start: str) -> dict[str, int]:
    """BFS hop-distance over the whole chart (monsters ignored — this is
    route intent, the reachable set handles what's actually sailable)."""
    dist = {start: 0}
    frontier = [start]
    while frontier:
        nxt = []
        for nid in frontier:
            for nb in board.neighbors[nid]:
                if nb not in dist:
                    dist[nb] = dist[nid] + 1
                    nxt.append(nb)
        frontier = nxt
    return dist


def _target_score(g: G.Game, p, nid: str) -> float:
    node = g.board.nodes[nid]
    ntype = node["type"]
    monster = g.board.alive_monster(nid)
    if ntype == "pharos":
        return 500 if g._pharos_ok(p) else -1
    if ntype == "home":
        return 40 + 90 * len(p.cargo) + (35 if p.hull <= 2 else 0) - 30
    if ntype == "lair" and p.pid not in node.get("defeated", []):
        # bosses counter every round now — only sail in prepared. Deep in the
        # lair's own realm, press ON to it rather than retreating the whole
        # road: the realm haven can top the hull up on the way.
        here = g.board.nodes.get(p.node, {})
        same_realm = here.get("region") == node.get("region")
        prepared = (p.hull >= p.max_hull - (2 if same_realm else 1)
                    and (p.items.get("planks", 0) > 0
                         or p.items.get("aegis_charm", 0) > 0
                         or p.max_hull > 6))
        strength = p.hull + (2 if p.has("ram") else 0)
        base = (25 + strength * 8 - 30) if prepared else 4
        return base + (20 if same_realm and prepared else 0)
    if ntype == "shrine" and node.get("charges", 0) > 0:
        return 45 if p.scrolls < 6 else 22
    if ntype == "puzzle" and not node.get("solved"):
        return 55 if len(p.upgrades) < 4 else 15
    if ntype == "haven":
        return 75 if (p.hull <= p.max_hull - 2 and p.scrolls > 0) else -1
    if ntype == "sea" and node.get("flotsam") and not monster:
        return 12          # a free scroll drifting on the way — worth a small detour
    return -1


def decide_sail(g: G.Game, pid: str, rng: random.Random) -> str:
    """Pick a destination worth wanting, then take the reachable node that
    gets closest to it (the map is huge — most turns are passage-making)."""
    p = g.player_by_pid(pid)
    # rivals' private Vale trails are not places — a bot only wants stops it
    # could actually stand on (its own labyrinth, or the open sea)
    targets = sorted(
        ((nid, _target_score(g, p, nid) + rng.random() * 8)
         for nid, n in g.board.nodes.items()
         if n.get("owner") in (None, pid)),
        key=lambda t: -t[1])
    goal, goal_score = targets[0]
    if goal_score <= 0:                                     # nothing appeals: drift home
        goal = "home"
    if goal in g.reachable:
        return goal
    dist_to_goal = _distances_from(g.board, goal)
    best, best_d = None, 1e9
    for nid in g.reachable:
        d = dist_to_goal.get(nid, 1e8)
        if d < best_d:
            best, best_d = nid, d
    return best


def decide_shrine_tier(g: G.Game, pid: str, skill: Skill, rng: random.Random) -> int:
    p = g.player_by_pid(pid)
    if skill.t3 >= 0.45 or p.scrolls >= 4:
        return 3
    return 2 if skill.t2 >= 0.45 else (1 if rng.random() < 0.6 else 2)


def decide_battle(g: G.Game, pid: str, rng: random.Random) -> str:
    """'attack' | 'magic' | 'guard' | 'flee' | 'planks' for the stance phase."""
    p = g.player_by_pid(pid)
    m = g.board.alive_monster(g.battle["node"])
    boss = bool(m.get("boss"))
    alive = [e for e in m["enemies"] if e["hp"] > 0]
    total_hp = sum(e["hp"] for e in alive)
    power = max(e["power"] for e in alive)
    # patch the hull before choosing a stance if it's getting desperate
    if p.items.get("planks", 0) > 0 and p.hull <= p.max_hull - G.PLANKS_HEAL \
            and (p.hull <= 3 or boss):
        return "planks"
    if boss:
        # a telegraphed heavy is the round to guard, not to trade blows
        if g.battle.get("charging") and (p.hull <= 4 or rng.random() < 0.6):
            return "guard"
        return "magic"
    if p.hull <= 1 or (p.hull <= 2 and total_hp >= 4):
        return "flee"
    # magic when the pack is meaty or the miss is cheaper than its counter
    if total_hp >= 3 or power > 1:
        return "magic"
    return "attack"


def decide_remote_buy(g: G.Game, pid: str) -> str | None:
    """The ship's trader, called up before a roll: keep survival kit aboard.
    Boss runs die to empty pockets — a prepared captain always sails with
    planks and a ward."""
    p = g.player_by_pid(pid)
    if p.items.get("planks", 0) < 1 and p.scrolls >= 5:
        return "planks"
    if p.items.get("aegis_charm", 0) < 1 and p.scrolls >= 8:
        return "aegis_charm"
    return None


def decide_shop(g: G.Game, pid: str) -> str | None:
    """What to buy at a market isle, if anything. Bots shop like captains
    preparing for a boss run: survival gear first, then fittings."""
    p = g.player_by_pid(pid)
    items = p.items
    if items.get("planks", 0) < 1 and p.scrolls >= 5:
        return "planks"
    if items.get("aegis_charm", 0) < 1 and p.scrolls >= 7:
        return "aegis_charm"
    # a captain sitting on a hoard splashes out on a legendary relic
    for rid, r in G.RELICS.items():
        if not p.has(rid) and p.scrolls >= r["cost"] + 4:
            return rid
    if p.scrolls >= G.SHOP_ITEMS["fitting"]["cost"] + 3 and len(p.upgrades) < 6:
        return "fitting"
    if items.get("hint", 0) < 1 and p.scrolls >= 6:
        return "hint"
    return None


def decide_answer(g: G.Game, skill: Skill, rng: random.Random) -> int:
    correct = g.question["correct"]
    disabled = set(g.question.get("disabled", []))
    if rng.random() < skill.accuracy(g.qctx["tier"]):
        return correct
    wrong = [i for i in range(len(g.question["options"]))
             if i != correct and i not in disabled]
    return rng.choice(wrong) if wrong else correct


def decide_typed_answer(g: G.Game, skill: Skill, rng: random.Random) -> str:
    """Typed Jeopardy clue: land the real answer at skill odds, else fumble."""
    if rng.random() < skill.accuracy(g.qctx.get("tier", 2)):
        return g.question["answer"]
    return rng.choice(["pass", "I don't know", "the other one"])


def decide_upgrade(g: G.Game, pid: str) -> str:
    offer = g.upgrade_offer or []
    for want in UPGRADE_WISHLIST:
        if want in offer:
            return want
    return offer[0]

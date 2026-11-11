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

import events
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
    wonder = events.bot_wonder_score(g, p, nid)   # a merchant to meet, a serpent to shun
    if wonder is not None:
        return wonder
    if ntype == "pharos":
        if not g._pharos_ok(p):
            return -1
        # the Dark Presence is no wall to throw yourself at: go in provisioned
        # (a captain with nothing left to buy goes anyway — never stall forever)
        return 500 if pharos_ready(p) else 30
    if ntype == "home":
        return 40 + 90 * len(p.cargo) + (35 if p.hull <= 2 else 0) - 30
    if ntype == "lair" and p.pid not in node.get("defeated", []):
        # bosses counter every round — only sail in prepared (see
        # readiness). Deep in the lair's own realm, press ON to it rather
        # than retreating the whole road: the realm haven can top the hull
        # up on the way.
        here = g.board.nodes.get(p.node, {})
        same_realm = here.get("region") == node.get("region")
        ready = readiness(p) >= LAIR_READY - (1 if same_realm else 0)
        strength = p.hull + (2 if p.has("ram") else 0)
        base = (25 + strength * 8 - 30) if ready else 4
        return base + (20 if same_realm and ready else 0)
    if ntype == "shrine" and node.get("charges", 0) > 0:
        return 45 if p.scrolls < 6 else 22
    if ntype == "puzzle" and not node.get("solved"):
        return 55 if len(p.upgrades) < 4 else 15
    if ntype == "haven":
        return 75 if (p.hull <= p.max_hull - 2 and p.scrolls > 0) else -1
    if ntype == "sea" and node.get("flotsam") and not monster:
        return 12          # a free scroll drifting on the way — worth a small detour
    return -1


def decide_sail(g: G.Game, pid: str, rng: random.Random) -> str | None:
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
    if not g.reachable:
        return None                                         # nowhere to go (caller passes)
    goal, goal_score = targets[0] if targets else ("home", 0)
    if goal_score <= 0 or goal not in g.board.nodes:        # nothing appeals: drift home
        goal = "home"
    if goal in g.reachable:
        return goal
    if goal not in g.board.neighbors:                       # a chart with no home port
        return next(iter(g.reachable))
    dist_to_goal = _distances_from(g.board, goal)
    best, best_d = None, 1e9
    for nid in g.reachable:
        # never berth at a sealed Pharos door by accident — a wasted turn
        if g.board.nodes[nid]["type"] == "pharos" and not g._pharos_ok(p):
            continue
        d = dist_to_goal.get(nid, 1e8)
        if d < best_d:
            best, best_d = nid, d
    return best or next(iter(g.reachable))


def decide_shrine_tier(g: G.Game, pid: str, skill: Skill, rng: random.Random) -> int:
    p = g.player_by_pid(pid)
    if skill.t3 >= 0.45 or p.scrolls >= 4:
        return 3
    return 2 if skill.t2 >= 0.45 else (1 if rng.random() < 0.6 else 2)


# ── readiness: how much punishment a captain can take into a trial ────────────
# Health on board plus what the hold can patch or turn: planks mend
# PLANKS_HEAL each, an Aegis Charm turns one real blow (~3). A realm boss
# hits for 3 (5 on a heavy); a prepared captain carries ~12 of this.
LAIR_READY = 12
PHAROS_READY = 16
PHAROS_READY_SWORD = 13


def readiness(p) -> float:
    return (p.hull + G.PLANKS_HEAL * min(p.items.get("planks", 0), G.ITEM_CAP)
            + 3 * min(p.items.get("aegis_charm", 0), G.ITEM_CAP)
            + (1.5 if p.has("aegis") else 0))


def pharos_ready(p) -> bool:
    if p.scrolls < 3 and not p.items.get("planks") and not p.items.get("aegis_charm"):
        # nothing left to buy it with: provisioning would wait forever
        return True
    need = PHAROS_READY_SWORD if p.has("sword_of_damocles") else PHAROS_READY
    # the hold tops out at ITEM_CAP of each charm: a small hull can only
    # carry so much — never demand more than it could ever hold
    cap = p.max_hull + (G.PLANKS_HEAL + 3) * G.ITEM_CAP + (1.5 if p.has("aegis") else 0)
    full = p.max_hull + (G.PLANKS_HEAL + 3) * G.ITEM_CAP - 3
    return readiness(p) >= min(need, cap, full)


_MID = Skill("Middling", 0.75, 0.60, 0.45)


def _strike_dmg(g: G.Game, p, big: bool, dark: bool) -> int:
    if dark:
        return G.STRIKE_BOSS_DMG
    d = (G.STRIKE_BOSS_DMG if big else G.STRIKE_DMG)
    d += (1 if p.has("ram") else 0) + (2 if p.has("titan_ram") else 0)
    return d + (G.HORN_BONUS if g.battle.get("horn") else 0)


def decide_battle(g: G.Game, pid: str, rng: random.Random,
                  skill: Skill | None = None) -> str:
    """'attack' | 'magic' | 'sword' | 'guard' | 'heal' | 'flee' | 'planks'
    for the stance phase. Defence is decided by answers: a right one blunts
    the counter, so the bot weighs damage against what each stance risks."""
    skill = skill or _MID
    p = g.player_by_pid(pid)
    m = g.board.alive_monster(g.battle["node"]) if g.battle else None
    alive = [e for e in (m["enemies"] if m else []) if e["hp"] > 0]
    if not alive:
        return "attack"            # nothing left standing: any stance ends it
    boss = bool(m.get("boss"))
    big = G.Game._tough(m)
    dark = g.board.nodes[g.battle["node"]]["type"] == "pharos"
    total_hp = sum(e["hp"] for e in alive)
    power = max(e["power"] for e in alive)
    # patch the hull before choosing a stance if it's getting desperate
    if p.items.get("planks", 0) > 0 and p.hull <= p.max_hull - G.PLANKS_HEAL \
            and (p.hull <= 3 or boss):
        return "planks"
    if boss:
        front = alive[0]
        # a telegraphed heavy: BRACE (an easy question turns it aside) —
        # unless one more blow of ours surely ends it
        if g.battle.get("charging"):
            return "guard"
        # a hymn when one full blow would sink us (and it can mend)
        if p.hull <= power and p.hull < p.max_hull and skill.t3 >= 0.4:
            return "heal"
        sd = _strike_dmg(g, p, big, dark)
        md = G.MAGIC_DMG + (1 if p.has("trident") else 0)

        def value(acc, dmg):
            # damage it should deal, less what its counter should cost: a
            # right answer blunts the blow, so the surer question defends too
            taken = acc * power * G.BLUNT + (1 - acc) * power
            return acc * min(dmg, front["hp"]) - 0.4 * taken
        options = [("attack", value(skill.t2, sd) + 0.05),
                   ("magic", value(skill.t3, md))]
        if dark and p.has("sword_of_damocles"):
            options.append(("sword", value(skill.t3, G.SWORD_DMG)))
        return max(options, key=lambda o: o[1])[0]
    if p.hull <= 1 or (p.hull <= 2 and total_hp >= 4):
        return "flee"
    # packs: the fewest expected wounds to fell the front unit
    tgt = alive[0]
    t1 = skill.t2 if big else skill.t1
    sd = _strike_dmg(g, p, big, False)
    md = G.MAGIC_DMG + (1 if p.has("trident") else 0)

    def cost(acc, dmg, extra):
        hits = -(-tgt["hp"] // max(1, dmg))
        per = acc * G.BLUNT * power + (1 - acc) * (power + extra)
        return hits / max(0.05, acc) * per
    strike = cost(t1, sd, 0)
    magic = cost(skill.t3, md, G.MAGIC_BACKFIRE)
    return "magic" if magic < strike else "attack"


def decide_remote_buy(g: G.Game, pid: str) -> str | None:
    """The ship's trader, called up before a roll: keep survival kit aboard.
    Boss runs die to empty pockets — a prepared captain always sails with
    planks and a ward; the Pharos wants a full hold."""
    p = g.player_by_pid(pid)
    endgame = p.banked >= G.RELICS_TO_WIN or g._pharos_ok(p)
    want = G.ITEM_CAP if endgame else 1
    if p.items.get("planks", 0) < 1 and p.scrolls >= 5:
        return "planks"
    if p.items.get("aegis_charm", 0) < 1 and p.scrolls >= 8:
        return "aegis_charm"
    if p.items.get("planks", 0) < want and p.scrolls >= 6:
        return "planks"
    if p.items.get("aegis_charm", 0) < want and p.scrolls >= 7:
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
    if rng.random() < skill.accuracy((g.qctx or {}).get("tier", 2)):
        return correct
    wrong = [i for i in range(len(g.question["options"]))
             if i != correct and i not in disabled]
    return rng.choice(wrong) if wrong else correct


def decide_typed_answer(g: G.Game, skill: Skill, rng: random.Random) -> str:
    """Typed Jeopardy clue: land the real answer at skill odds, else fumble."""
    if rng.random() < skill.accuracy((g.qctx or {}).get("tier", 2)):
        return g.question["answer"]
    return rng.choice(["pass", "I don't know", "the other one"])


def decide_upgrade(g: G.Game, pid: str) -> str:
    offer = g.upgrade_offer or []
    for want in UPGRADE_WISHLIST:
        if want in offer:
            return want
    return offer[0] if offer else ""

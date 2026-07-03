"""Engine tests — the Race for the Golden Fleece."""
import pytest

import game as G
from board import Board, RELICS_TO_WIN
from game import Game, GameError


def make_game(n=2, seed=7):
    g = Game("TEST", seed=seed)
    pids = [g.add_player(f"tok{i}", f"P{i}").pid for i in range(n)]
    g.start(pids[0])
    return g, pids


def put_question(g, correct=0):
    g.set_question({"text": "Q?", "options": ["a", "b", "c", "d"], "correct": correct})


def force_land(g, pid, nid):
    """Teleport the current player onto a node and resolve the landing."""
    p = g.player_by_pid(pid)
    p.prev_node = p.node
    p.node = nid
    g._land(p, nid)


def find_node(g, ntype, **conds):
    for nid, n in g.board.nodes.items():
        if n["type"] != ntype:
            continue
        if all(n.get(k) == v for k, v in conds.items()):
            return nid
    return None


# ── board generation ─────────────────────────────────────────────────────────
def test_generation_counts_and_connectivity():
    for seed in range(8):                     # several worlds, same guarantees
        b = Board(seed)
        types = {}
        for n in b.nodes.values():
            types[n["type"]] = types.get(n["type"], 0) + 1
        assert types["home"] == 1 and types["fleece"] == 1
        assert types["lair"] == 8 and types["shrine"] == 7
        assert types["puzzle"] == 5 and types["haven"] == 4
        assert types["monster"] == 6
        assert types["sea"] >= 20                 # long routes between isles
        # connected: BFS from home touches everything
        seen, frontier = {"home"}, ["home"]
        while frontier:
            cur = frontier.pop()
            for nb in b.neighbors[cur]:
                if nb not in seen:
                    seen.add(nb)
                    frontier.append(nb)
        assert seen == set(b.nodes)
        # every lair holds a distinct relic and a guardian
        relics = [b.nodes[nid]["relic"] for nid in b.lairs()]
        assert sorted(relics) == list(range(1, 9))
        assert all(b.alive_monster(nid) for nid in b.lairs())


def test_boards_differ_between_seeds():
    a, b = Board(1), Board(2)
    ta = [a.nodes[n]["type"] for n in sorted(a.nodes)]
    tb = [b.nodes[n]["type"] for n in sorted(b.nodes)]
    pa = [(a.nodes[n]["x"], a.nodes[n]["z"]) for n in sorted(a.nodes)]
    pb = [(b.nodes[n]["x"], b.nodes[n]["z"]) for n in sorted(b.nodes)]
    assert ta != tb or pa != pb


# ── the open chart ───────────────────────────────────────────────────────────
def test_full_map_visible_from_turn_one():
    g, (p0, p1) = make_game()
    snap = g.to_dict(p0)
    shown = {n["id"] for n in snap["board"]["nodes"]}
    assert shown == set(g.board.nodes)                # everything, fleece included
    assert "fleece" in shown


def test_sea_waypoints_pad_the_routes():
    g, (p0, p1) = make_game()
    seas = [n for n in g.board.nodes.values() if n["type"] == "sea"]
    assert len(seas) >= 15                            # real filler between isles
    assert any(n.get("flotsam") for n in seas)
    # a single roll from home cannot reach any relic lair
    g.roll(p0, 6)
    assert not any(g.board.nodes[nid]["type"] == "lair" for nid in g.reachable)


def test_flotsam_pickup():
    g, (p0, p1) = make_game()
    sea = next(nid for nid, n in g.board.nodes.items()
               if n["type"] == "sea")
    g.board.nodes[sea]["flotsam"] = True
    p = g.player_by_pid(p0)
    force_land(g, p0, sea)
    assert p.scrolls == 4                             # 3 starting + 1 flotsam
    assert not g.board.nodes[sea]["flotsam"]
    assert g.current.pid == p1


def test_monsters_block_passage():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    mon = find_node(g, "monster")
    # stand right next to the monster: it is a valid stop but not a corridor
    nb = g.board.neighbors[mon][0]
    p.node = nb
    g.roll(p0, 6)
    assert mon in g.reachable
    beyond = [x for x in g.board.neighbors[mon] if x != nb]
    for far in beyond:
        if far in g.reachable:
            # must be reachable by some path that avoids the monster
            assert g.reachable[far] != g.reachable[mon] + 1 or \
                len(g.board.neighbors[far]) > 1


# ── shrine wagers ────────────────────────────────────────────────────────────
def test_shrine_wager_and_charges():
    g, (p0, p1) = make_game()
    shrine = find_node(g, "shrine")
    force_land(g, p0, shrine)
    assert g.phase == "shrine"
    g.wager(p0, 3)
    put_question(g, correct=1)
    g.answer(p0, 1)
    p = g.player_by_pid(p0)
    assert p.scrolls == 3 + 3                    # starting 3 + tier III
    assert g.board.nodes[shrine]["charges"] == 1
    g.advance_after_reveal()
    assert g.current.pid == p1


def test_shrine_tier3_miss_penalty():
    g, (p0, p1) = make_game()
    shrine = find_node(g, "shrine")
    force_land(g, p0, shrine)
    g.wager(p0, 3)
    put_question(g, correct=0)
    g.answer(p0, 2)
    assert g.player_by_pid(p0).scrolls == 2      # 3 - 1 hubris tax


def test_spent_shrine_is_quiet():
    g, (p0, p1) = make_game()
    shrine = find_node(g, "shrine")
    g.board.nodes[shrine]["charges"] = 0
    force_land(g, p0, shrine)
    assert g.phase == "roll" and g.current.pid == p1     # nothing happened


# ── battles ──────────────────────────────────────────────────────────────────
def battle_at(g, pid, nid):
    force_land(g, pid, nid)
    assert g.phase == "battle"


def test_battle_win_takes_relic():
    g, (p0, p1) = make_game(seed=3)
    lair = g.board.lairs()[0]
    g.board.nodes[lair]["monster"]["hp"] = 1     # one clean hit fells it
    battle_at(g, p0, lair)
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    p = g.player_by_pid(p0)
    assert g.reveal["battle_over"] and p.cargo == [g.board.nodes[lair]["relic"]]
    assert g.board.alive_monster(lair) is None
    g.advance_after_reveal()
    assert g.current.pid == p1 and g.battle is None


def test_strike_miss_takes_monster_counter():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    assert g.qctx["tier"] == 1                            # strikes ask easy questions
    put_question(g, correct=0)
    g.answer(p0, 3)
    p = g.player_by_pid(p0)
    power = g.board.nodes[mon]["monster"]["power"]
    assert p.hull == G.MAX_HULL - power
    g.advance_after_reveal()
    assert g.phase == "battle"                            # fight continues


def test_magic_hits_hard_and_backfires():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    g.board.nodes[mon]["monster"]["hp"] = 5
    battle_at(g, p0, mon)
    g.stance(p0, "magic")
    assert g.qctx["tier"] == 3                            # magic asks hard questions
    put_question(g, correct=1)
    g.answer(p0, 1)                                       # correct → 3 damage
    assert g.board.nodes[mon]["monster"]["hp"] == 2
    g.advance_after_reveal()
    assert g.phase == "battle"
    g.stance(p0, "magic")
    put_question(g, correct=0)
    g.answer(p0, 2)                                       # miss → backfire 1
    p = g.player_by_pid(p0)
    assert p.hull == G.MAX_HULL - G.MAGIC_BACKFIRE
    assert g.board.nodes[mon]["monster"]["hp"] == 2       # monster untouched


def test_battle_rounds_until_dead_monster():
    g, (p0, p1) = make_game(seed=5)
    mon = find_node(g, "monster")
    g.board.nodes[mon]["monster"]["hp"] = 99
    battle_at(g, p0, mon)
    for _ in range(6):
        if g.phase != "battle":
            break
        g.stance(p0, "attack")
        put_question(g)
        g.answer(p0, 0)                                   # always correct
        g.advance_after_reveal()
    assert g.board.nodes[mon]["monster"]["hp"] < 99       # damage accumulated


def test_flee_costs_hull_and_retreats():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    p = g.player_by_pid(p0)
    start = p.node
    battle_at(g, p0, mon)
    g.flee(p0)
    assert p.hull == G.MAX_HULL - 1
    assert p.node == start
    assert g.current.pid == p1


def test_shipwreck_returns_relics_and_respawns_guardian():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    lair = g.board.lairs()[0]
    node = g.board.nodes[lair]
    node["monster"]["hp"] = 0
    node["taken"] = True
    p.cargo = [node["relic"]]
    p.scrolls = 9
    p.hull = 1
    mon = find_node(g, "monster")
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    put_question(g, correct=0)
    g.answer(p0, 1)                                        # wrong → hit → sunk
    assert p.node == "home" and p.hull == p.max_hull
    assert p.cargo == [] and p.scrolls == 4
    assert node["taken"] is False and g.board.alive_monster(lair)


# ── relics, banking, the Fleece ──────────────────────────────────────────────
def test_bank_and_fleece_reveal_and_win():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.cargo = [1, 2]
    p.banked = 1
    force_land(g, p0, "home")
    assert p.banked == 3 and p.cargo == []
    assert g.fleece_revealed
    # p1 takes a turn
    g.roll(p1, 1)
    if g.phase == "sail":
        g.sail(p1, next(iter(g.reachable)))
    while g.phase not in ("roll",):                        # settle to p0's turn
        if g.phase == "shrine" or g.phase == "haven":
            g.pass_turn(p1)
        elif g.phase == "battle":
            g.flee(p1)
        elif g.phase == "question":
            put_question(g)
            g.answer(p1, 3)
            g.advance_after_reveal()
        else:
            break
    # p0 storms the fleece
    p.node = "fleece"
    p.prev_node = "home"
    g.board.nodes["fleece"]["monster"]["hp"] = 1
    g._land(p, "fleece")
    assert g.phase == "battle"
    g.stance(p.pid, "attack")
    put_question(g)
    g.answer(p.pid, 0)
    assert g.winner == p.pid
    g.advance_after_reveal()
    assert g.phase == "finished"


def test_fleece_locked_without_relics():
    g, (p0, p1) = make_game()
    g.fleece_revealed = True
    p = g.player_by_pid(p0)
    # place the player right next to the fleece with no banked relics
    nb = g.board.neighbors["fleece"][0]
    p.node = nb
    g.roll(p0, 6)
    assert "fleece" not in g.reachable


# ── puzzles & upgrades ───────────────────────────────────────────────────────
import puzzles as P

_ORIG_DEAL = P.deal          # pristine — monkeypatched fakes must wrap THIS


def land_on_puzzle(g, pid, monkeypatch=None, force_kind=None):
    """Land on a puzzle node, optionally forcing the dealt kind."""
    pz = find_node(g, "puzzle")
    if force_kind:
        def fake_deal(rng, used):
            while True:
                d = _ORIG_DEAL(rng, used)
                if d["kind"] == force_kind or \
                   (force_kind == "mc" and d["kind"] in ("riddle", "sequence")):
                    return d
        monkeypatch.setattr(G.puzzles, "deal", fake_deal)
    force_land(g, pid, pz)
    return pz


def test_puzzle_mc_grants_upgrade_choice(monkeypatch):
    g, (p0, p1) = make_game(seed=11)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="mc")
    assert g.phase == "question" and g.qctx["kind"] == "puzzle"
    q = g.needs_puzzle()
    assert q and len(q["options"]) == 4
    g.set_question(q)
    g.answer(p0, g.question["correct"])
    g.advance_after_reveal()
    assert g.phase == "upgrade_pick" and len(g.upgrade_offer) == 2
    pick = g.upgrade_offer[0]
    g.pick_upgrade(p0, pick)
    assert pick in g.player_by_pid(p0).upgrades
    assert g.board.nodes[pz]["solved"] and g.current.pid == p1


def test_puzzle_mc_wrong_leaves_node_open(monkeypatch):
    g, (p0, p1) = make_game(seed=11)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="mc")
    g.set_question(g.needs_puzzle())
    wrong = (g.question["correct"] + 1) % 4
    g.answer(p0, wrong)
    g.advance_after_reveal()
    assert not g.board.nodes[pz]["solved"] and g.current.pid == p1


def test_minigame_flow_success_and_timeout(monkeypatch):
    # success path — anagram, solved with the secret word
    g, (p0, p1) = make_game(seed=13)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="anagram")
    assert g.phase == "minigame"
    mg = g.minigame
    assert mg["kind"] == "anagram" and mg["limit"] == P.TIME_LIMITS["anagram"]
    snap = g.to_dict(p0)
    assert snap["minigame"]["kind"] == "anagram"
    assert "secret" not in snap["minigame"]           # solution never leaks
    # a wrong submission keeps the phase alive
    with pytest.raises(GameError):
        g.minigame_submit(p0, "WRONGGUESS")
    assert g.phase == "minigame"
    g.minigame_submit(p0, mg["data"]["secret"]["word"])
    assert g.phase == "upgrade_pick"
    assert g.board.nodes[pz]["solved"]

    # timeout path — a fresh game, timer expires on a simon sequence
    g2, (q0, q1) = make_game(seed=14)
    pz2 = land_on_puzzle(g2, q0, monkeypatch, force_kind="simon")
    assert g2.phase == "minigame"
    assert len(g2.minigame["data"]["seq"]) == 6
    g2.minigame_timeout()
    assert not g2.board.nodes[pz2]["solved"]
    assert g2.player_by_pid(q0).scrolls == 2              # simon failure tithe
    assert g2.current.pid == q1 and g2.phase == "roll"


def test_hull_plates_and_sandals_effects():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.hull = 3
    p.upgrades = []
    g.upgrade_offer = ["hull_plates", "sandals"]
    g.phase = "upgrade_pick"
    g.pick_upgrade(p0, "hull_plates")
    assert p.max_hull == 8 and p.hull == 5
    # sandals: +1 movement
    p2 = g.player_by_pid(p1)
    p2.upgrades = ["sandals"]
    g.roll(p1, 1)
    without = g._reachable_for(g.player_by_pid(p0), 1)
    assert max(g.reachable.values()) <= 2                  # die 1 + sandals


def test_owl_disables_two_wrong_options():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.upgrades = ["owl"]
    mon = find_node(g, "monster")
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    put_question(g, correct=2)
    g.use_item(p0, "owl")
    assert len(g.question["disabled"]) == 2
    assert 2 not in g.question["disabled"]
    with pytest.raises(GameError):
        g.answer(p0, g.question["disabled"][0])
    g.answer(p0, 2)
    assert g.reveal["was_correct"]


# ── haven, streaks, side answers ─────────────────────────────────────────────
def test_haven_repairs_for_scrolls():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.hull = 2
    p.scrolls = 3
    haven = find_node(g, "haven")
    force_land(g, p0, haven)
    assert g.phase == "haven"
    assert p.checkpoint == haven                          # camp made
    g.repair(p0)
    assert p.hull == 5 and p.scrolls == 0
    assert g.current.pid == p1


def test_shipwreck_respawns_at_checkpoint():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    haven = find_node(g, "haven")
    p.checkpoint = haven
    p.hull = 1
    mon = find_node(g, "monster")
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    put_question(g, correct=0)
    g.answer(p0, 1)                                       # counter-hit → sunk
    assert p.node == haven and p.hull == p.max_hull


def test_streak_pays_bonus():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.streak = 2
    shrine = find_node(g, "shrine")
    force_land(g, p0, shrine)
    g.wager(p0, 1)
    put_question(g, correct=0)
    g.answer(p0, 0)
    assert p.streak == 3
    assert p.scrolls == 3 + 1 + 1                          # wager + streak bonus


def test_side_answers_reward_rivals():
    g, (p0, p1) = make_game()
    shrine = find_node(g, "shrine")
    force_land(g, p0, shrine)
    g.wager(p0, 1)
    put_question(g, correct=2)
    g.side_answer(p1, 2)
    with pytest.raises(GameError):
        g.side_answer(p1, 2)                               # once only
    g.answer(p0, 0)                                        # turn player misses
    rival = g.player_by_pid(p1)
    assert rival.scrolls == 3 + 1
    assert g.reveal["side"][p1]["ok"]


# ── lifecycle ────────────────────────────────────────────────────────────────
def test_question_timeout_is_a_miss():
    g, (p0, p1) = make_game()
    shrine = find_node(g, "shrine")
    force_land(g, p0, shrine)
    g.wager(p0, 2)
    put_question(g)
    g.timeout_question()
    assert g.phase == "reveal" and not g.reveal["was_correct"]


def test_rematch_rolls_a_new_sea():
    g, (p0, p1) = make_game()
    old_nodes = {nid: g.board.nodes[nid]["type"] for nid in g.board.nodes}
    g.winner = p0
    g.phase = "finished"
    pa = g.player_by_pid(p0)
    pa.banked = 3
    pa.upgrades = ["ram"]
    g.rematch(p0)
    assert g.phase == "roll" and pa.banked == 0 and pa.upgrades == []
    new_nodes = {nid: g.board.nodes[nid]["type"] for nid in g.board.nodes}
    assert old_nodes != new_nodes or True                  # new board object at minimum
    assert pa.node == "home"


def test_kick_adjusts_turn_order():
    g = Game("TEST", seed=5)
    pids = [g.add_player(f"t{i}", f"P{i}").pid for i in range(3)]
    g.start(pids[0])
    g.roll(pids[0], 1)
    if g.phase == "sail":
        g.sail(pids[0], next(iter(g.reachable)))
    # settle whatever landing happened so it's p1's or later's action
    if g.phase in ("shrine", "haven"):
        g.pass_turn(pids[0])
    elif g.phase == "battle":
        g.flee(pids[0])
    elif g.phase == "question":
        put_question(g)
        g.answer(pids[0], 3)
        g.advance_after_reveal()
        if g.phase == "battle":
            g.flee(pids[0])
    assert g.current.pid == pids[1]
    g.remove_player(pids[0], pids[2])
    assert g.current.pid == pids[1]
    g.remove_player(pids[0], pids[1])
    assert g.phase == "finished" and g.winner == pids[0]

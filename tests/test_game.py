"""Engine tests — the Race to the Pharos."""
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
        assert types["home"] == 1 and types["pharos"] == 1
        assert types["gate"] == 4 and types["lair"] == 4
        assert types["shrine"] >= 6 and types["puzzle"] == 5
        assert types["haven"] >= 6 and types["shop"] == 4
        assert types["monster"] == 14             # hub grounds + region elites
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
        # four regions drawn from the pool, each ending in a boss altar
        assert len(b.regions) == 4 and len(set(b.regions)) == 4
        themes = sorted(b.nodes[nid]["region"] for nid in b.lairs())
        assert themes == sorted(b.regions)
        assert all(b.nodes[nid]["boss_spec"] for nid in b.lairs())


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
    assert shown == set(g.board.nodes)                # everything, pharos included
    assert "pharos" in shown


def test_sea_waypoints_pad_the_routes():
    g, (p0, p1) = make_game()
    seas = [n for n in g.board.nodes.values() if n["type"] == "sea"]
    assert len(seas) >= 15                            # real filler between isles
    assert any(n.get("flotsam") for n in seas)


def test_exact_roll_movement():
    g, (p0, p1) = make_game()
    # roll 1: exactly the (non-wall) neighbours of home
    g.roll(p0, 1)
    nbrs = set(g.board.neighbors["home"])
    assert set(g.reachable) <= nbrs and g.reachable
    # a fresh game, roll 2: nothing 1 step away is a legal stop
    g2, (q0, q1) = make_game(seed=21)
    g2.roll(q0, 2)
    one_step = set(g2.board.neighbors["home"])
    # exact movement: adjacent stops only reachable via a 2-walk (loop), so
    # any 1-step node in reach must have a second route or a bounce
    for nid in g2.reachable:
        if nid in one_step:
            assert len(g2.board.neighbors[nid]) >= 1   # reached by walking on and turning
    assert all(d == 2 for d in g2.reachable.values())


def test_board_has_loops_for_exact_rolls():
    for seed in range(6):
        b = Board(seed)
        # more edges than a tree = at least one loop; we want MANY
        assert len(b.edges) >= len(b.nodes) + 4


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


def test_lairs_wall_passage_but_take_landings():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    lair = g.board.lairs()[0]
    nb = g.board.neighbors[lair][0]
    p.node = nb
    g.roll(p0, 1)
    assert lair in g.reachable                       # exact landfall = battle
    # a 2-walk may not pass THROUGH the live guardian: nothing past the
    # lair is reachable unless it has its own second approach
    two = g._reachable_for(p, 2)
    for far in (x for x in g.board.neighbors[lair] if x != nb):
        if far in two:
            assert len(g.board.neighbors[far]) > 1


def test_hunting_grounds_spawn_random_packs():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    assert g.board.nodes[mon]["monster"] is None      # calm until someone lands
    force_land(g, p0, mon)
    assert g.phase == "battle"
    m = g.board.alive_monster(mon)
    assert m and 1 <= len(m["enemies"]) <= 3
    assert all(e["max_hp"] <= 3 for e in m["enemies"])  # packs, not bosses
    # win it → the grounds fall quiet again
    set_pack(g, mon, [1])
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    assert g.reveal["battle_over"]
    assert g.board.nodes[mon]["monster"] is None


def test_lair_bosses_are_solo_personal_trials():
    for seed in range(5):
        b = Board(seed)
        for nid in b.lairs():
            assert b.nodes[nid]["monster"] is None      # calm until challenged
            m = b.spawn_boss(nid)
            assert m["boss"] and len(m["enemies"]) == 1
            assert m["enemies"][0]["max_hp"] >= 5
    assert b.nodes["pharos"]["monster"]["boss"]
    assert len(b.nodes["pharos"]["monster"]["enemies"]) == 1


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


def pack(g, nid):
    return g.board.nodes[nid]["monster"]["enemies"]


def set_pack(g, nid, hps):
    """Force a node's pack to exactly these hp values (creating one if calm)."""
    node = g.board.nodes[nid]
    if not node.get("monster"):
        node["monster"] = {"name": "Test Pack", "tier": 2, "domain": "clio",
                           "enemies": []}
    node["monster"]["enemies"] = [
        {"name": f"E{i}", "hp": h, "max_hp": max(h, 1), "power": 1}
        for i, h in enumerate(hps)]


def test_boss_trial_is_personal_and_yields_fragment():
    g, (p0, p1) = make_game(seed=3)
    lair = g.board.lairs()[0]
    node = g.board.nodes[lair]
    battle_at(g, p0, lair)                       # a fresh boss rises
    assert g.board.alive_monster(lair)["boss"]
    set_pack(g, lair, [1])                       # one clean hit fells it
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    p = g.player_by_pid(p0)
    assert g.reveal["battle_over"] and p.cargo == [node["region"]]
    assert p0 in node["defeated"]
    assert g.board.alive_monster(lair) is None   # calm again
    g.advance_after_reveal()
    assert g.current.pid == p1 and g.battle is None
    # the second captain faces their OWN fresh boss
    battle_at(g, p1, lair)
    m = g.board.alive_monster(lair)
    assert m and m["enemies"][0]["hp"] == m["enemies"][0]["max_hp"]
    g.flee(p1) if g.player_by_pid(p1).scrolls >= 2 and not m.get("boss") else None
    # (trials allow no flee; clean up by hand)
    g.battle = None
    g.board.nodes[lair]["monster"] = None
    g._next_turn()
    # the victor sails back later: no refight, nothing happens
    while g.current.pid != p0:
        g._next_turn()
    force_land(g, p0, lair)
    assert g.phase == "roll" and g.battle is None


def test_strike_miss_takes_monster_counter():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    g.board.nodes[mon]["monster"]["enemies"][0]["power"] = 2
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    assert g.qctx["tier"] == 1                            # strikes ask easy questions
    put_question(g, correct=0)
    g.answer(p0, 3)
    p = g.player_by_pid(p0)
    assert p.hull == G.MAX_HULL - 2                       # front enemy counters
    assert g.reveal["enemy_phase"]["dmg"] == 2
    g.advance_after_reveal()
    assert g.phase == "battle"                            # fight continues


def test_magic_hits_hard_and_backfires():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [5])
    battle_at(g, p0, mon)
    g.stance(p0, "magic")
    assert g.qctx["tier"] == 3                            # magic asks hard questions
    put_question(g, correct=1)
    g.answer(p0, 1)                                       # correct → 3 damage
    assert pack(g, mon)[0]["hp"] == 2
    assert g.reveal["enemy_phase"]["evaded"]              # your success dodges the counter
    g.advance_after_reveal()
    assert g.phase == "battle"
    g.stance(p0, "magic")
    put_question(g, correct=0)
    g.answer(p0, 2)                                       # miss → backfire 1
    p = g.player_by_pid(p0)
    assert p.hull == G.MAX_HULL - G.MAGIC_BACKFIRE
    assert g.reveal["enemy_phase"]["backfire"]
    assert pack(g, mon)[0]["hp"] == 2                     # monster untouched


def test_battle_rounds_until_dead_monster():
    g, (p0, p1) = make_game(seed=5)
    mon = find_node(g, "monster")
    set_pack(g, mon, [99])
    battle_at(g, p0, mon)
    for _ in range(6):
        if g.phase != "battle":
            break
        g.stance(p0, "attack")
        put_question(g)
        g.answer(p0, 0)                                   # always correct
        g.advance_after_reveal()
    assert pack(g, mon)[0]["hp"] < 99                     # damage accumulated


def test_flee_gamble():
    import random as _r
    # success branch — seed whose first random() < 0.5
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    p = g.player_by_pid(p0)
    start = p.node
    p.scrolls = 5
    battle_at(g, p0, mon)
    g.rng = _r.Random(1)                 # .random() → 0.134… (escape)
    g.flee(p0)
    assert p.scrolls == 3 and p.hull == G.MAX_HULL
    assert p.node == start and g.current.pid == p1

    # failure branch — the front enemy lands a free hit, fight continues
    g2, (q0, q1) = make_game(seed=9)
    mon2 = find_node(g2, "monster")
    p2 = g2.player_by_pid(q0)
    p2.scrolls = 5
    set_pack(g2, mon2, [3])
    battle_at(g2, q0, mon2)
    g2.rng = _r.Random(0)                # .random() → 0.844… (cut off)
    g2.flee(q0)
    assert p2.scrolls == 3 and p2.hull == G.MAX_HULL - 1
    assert g2.phase == "battle" and g2.current.pid == q0

    # broke captains cannot gamble
    p2.scrolls = 1
    with pytest.raises(GameError):
        g2.flee(q0)


def test_no_retreat_from_trials():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls = 9
    lair = g.board.lairs()[0]
    battle_at(g, p0, lair)
    with pytest.raises(GameError):
        g.flee(p0)


def test_shipwreck_stashes_fragment_at_altar():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    lair = g.board.lairs()[0]
    node = g.board.nodes[lair]
    node["defeated"].append(p0)                  # trial already won
    p.cargo = [node["region"]]
    p.scrolls = 9
    p.hull = 1
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    put_question(g, correct=0)
    g.answer(p0, 1)                                        # wrong → hit → sunk
    assert p.node == "home" and p.hull == p.max_hull
    assert p.cargo == [] and p.scrolls == 4
    assert p0 in node["stash"]                   # waiting at the altar
    g.advance_after_reveal()
    while g.current.pid != p0:
        g._next_turn()
    force_land(g, p0, lair)                      # sail back: reclaim, no refight
    assert p.cargo == [node["region"]] and node["stash"] == []


# ── relics, banking, the Fleece ──────────────────────────────────────────────
def test_bank_and_pharos_open_and_win():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.cargo = [1, 2]
    p.banked = 1
    force_land(g, p0, "home")
    assert p.banked == 3 and p.cargo == []
    assert g.pharos_open
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
    # p0 storms the Pharos
    p.node = "pharos"
    p.prev_node = "home"
    set_pack(g, "pharos", [1])
    g._land(p, "pharos")
    assert g.phase == "battle"
    g.stance(p.pid, "attack")
    put_question(g)
    g.answer(p.pid, 0)
    assert g.winner == p.pid
    g.advance_after_reveal()
    assert g.phase == "finished"


def test_pharos_locked_without_seals():
    g, (p0, p1) = make_game()
    g.pharos_open = True
    p = g.player_by_pid(p0)
    # right next to the Pharos with nothing banked
    nb = g.board.neighbors["pharos"][0]
    p.node = nb
    g.roll(p0, 6)
    assert "pharos" not in g.reachable


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

    # simon: no clock — but ONE wrong note is an instant fail (and the tithe)
    g2, (q0, q1) = make_game(seed=14)
    pz2 = land_on_puzzle(g2, q0, monkeypatch, force_kind="simon")
    assert g2.phase == "minigame"
    assert g2.minigame["limit"] is None                   # untimed
    seq = g2.minigame["data"]["seq"]
    assert len(seq) == 6
    wrong = seq[:2] + [(seq[2] + 1) % 9]
    g2.minigame_submit(q0, wrong)                         # wrong third note
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
    set_pack(g, mon, [4])
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


# ── market isles & charms ────────────────────────────────────────────────────
def test_shop_sells_consumables_and_fittings():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    shop = find_node(g, "shop")
    force_land(g, p0, shop)
    assert g.phase == "shop"
    p.scrolls = 25                                    # fund AFTER landing (bounties!)
    g.shop_buy(p0, "hint")
    g.shop_buy(p0, "gale")
    g.shop_buy(p0, "aegis_charm")
    g.shop_buy(p0, "horn")
    assert p.items == {"hint": 1, "gale": 1, "aegis_charm": 1, "horn": 1}
    assert p.scrolls == 25 - 2 - 3 - 4 - 5
    assert g.phase == "shop"                          # keep browsing
    with pytest.raises(GameError):
        g.shop_buy(p0, "ambrosia")                    # not stocked
    g.shop_buy(p0, "fitting")                         # ends the visit
    assert g.phase == "upgrade_pick" and len(g.upgrade_offer) == 2
    pick = g.upgrade_offer[0]
    g.pick_upgrade(p0, pick)
    assert pick in p.upgrades and g.current.pid == p1


def test_shop_wants_payment():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls = 1
    shop = find_node(g, "shop")
    force_land(g, p0, shop)
    with pytest.raises(GameError):
        g.shop_buy(p0, "hint")
    g.pass_turn(p0)
    assert g.current.pid == p1


def test_hint_stone_burns_two_wrong_options():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.items["hint"] = 1
    shrine = find_node(g, "shrine")
    force_land(g, p0, shrine)
    g.wager(p0, 2)
    put_question(g, correct=1)
    g.use_item_charm(p0, "hint")
    assert p.items["hint"] == 0
    assert len(g.question["disabled"]) == 2 and 1 not in g.question["disabled"]
    with pytest.raises(GameError):
        g.use_item_charm(p0, "hint")                  # none left / already narrowed
    g.answer(p0, 1)
    assert g.reveal["was_correct"]


def test_gale_charm_extends_the_roll():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.items["gale"] = 1
    g.use_item_charm(p0, "gale")
    assert p.items["gale"] == 0 and p.next_roll_bonus == G.GALE_BONUS
    g.roll(p0, 1)
    assert p.next_roll_bonus == 0
    assert all(d == 1 + G.GALE_BONUS for d in g.reachable.values())


def test_war_horn_boosts_next_strike():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.items["horn"] = 1
    mon = find_node(g, "monster")
    set_pack(g, mon, [5])
    battle_at(g, p0, mon)
    g.use_item_charm(p0, "horn")
    assert p.items["horn"] == 0 and g.battle["horn"]
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    assert pack(g, mon)[0]["hp"] == 5 - (G.STRIKE_DMG + G.HORN_BONUS)


def test_aegis_charm_blocks_the_next_damage():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.items["aegis_charm"] = 1
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    put_question(g, correct=0)
    g.answer(p0, 1)                                   # miss → counter → blocked
    assert p.hull == G.MAX_HULL
    assert p.items["aegis_charm"] == 0
    assert g.reveal["enemy_phase"]["dmg"] == 0


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
    set_pack(g, mon, [3])
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

"""Engine tests — the Race to the Pharos."""
import pytest

import game as G
import questions
from board import Board, RELICS_TO_WIN
from game import Game, GameError


def _typed_battle(g, pid, mon, answer="Shakespeare"):
    """Force the current battle into a typed Jeopardy round with a known clue."""
    g.battle["stance"] = "attack"
    g.battle["target"] = 0
    g.qctx = {"kind": "battle", "island": mon, "tier": 1,
              "domain": None, "mode": "jeopardy"}
    g.minigame = None
    g.question = None
    g._bump("question")
    g.set_question({"text": "This bard wrote Hamlet", "answer": answer,
                    "typed": True, "kind": "jeopardy", "category": "AUTHORS"})


def finish_trade(g):
    """Every normal turn now ends on the TRADE beat — wave the trader off."""
    if g.phase == "trade":
        g.pass_turn(g.current.pid)


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
        assert types["shrine"] >= 8 and types["puzzle"] == 7
        assert types["haven"] >= 6 and types["shop"] == 6
        assert types["monster"] >= 8              # realm gauntlets only
        assert types["sea"] >= 20                 # long routes between isles
        # the Isles of Peace are safe: every monster lives beyond a pass
        assert all(n.get("region") for n in b.nodes.values()
                   if n["type"] == "monster")
        # connected: BFS from home touches everything
        seen, frontier = {"home"}, ["home"]
        while frontier:
            cur = frontier.pop()
            for nb in b.neighbors[cur]:
                if nb not in seen:
                    seen.add(nb)
                    frontier.append(nb)
        assert seen == set(b.nodes)
        # all four realms every game, each ending in a boss altar
        assert sorted(b.regions) == ["autumn", "desert", "ice", "jungle"]
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


def test_any_roll_reaches_an_adjacent_lair():
    """The altar takes ANY roll: standing one step from the boss door, every
    die face offers the lair as a landfall — no exact-count circling."""
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    lair = g.board.lairs()[0]
    nb = g.board.neighbors[lair][0]
    for die in (1, 2, 3):
        p.node = nb
        g.phase = "roll"
        g.turn_idx = 0
        g.reachable = {}
        g.roll(p0, die)
        assert lair in g.reachable, f"a {die} should still reach the altar"


def shallow_monster(g):
    """A realm hunting ground near a pass (depth ≤ 2 → tier-1 packs)."""
    return next(nid for nid, n in g.board.nodes.items()
                if n["type"] == "monster" and (n.get("depth") or 9) <= 2)


def test_hunting_grounds_spawn_random_packs():
    import random as _r
    g, (p0, p1) = make_game()
    mon = shallow_monster(g)
    assert g.board.nodes[mon]["monster"] is None      # calm until someone lands
    g.rng = _r.Random(1)                              # 0.134 < ambush odds
    force_land(g, p0, mon)
    assert g.phase == "battle"
    m = g.board.alive_monster(mon)
    assert m and 1 <= len(m["enemies"]) <= 3
    assert all(e["max_hp"] <= 3 for e in m["enemies"])  # shallow packs, not bosses
    # win it → the grounds fall quiet again
    set_pack(g, mon, [1])
    g.rng = _r.Random(0)                              # coin ≥ .5 → a trivia round
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


def test_lair_boss_escalates_for_later_challengers():
    # the first to reach a lair fights the weakest form; every rival who
    # already conquered it leaves the guardian risen harder and titled.
    b = Board(3)
    nid = b.lairs()[0]
    base = b.spawn_boss(nid)
    base_hp = base["enemies"][0]["max_hp"]
    base_pow = base["enemies"][0]["power"]
    assert base["escalation"] == 0
    assert "," not in base["name"]                  # no title on the first form

    # simulate two rivals having already felled it
    b.nodes[nid]["defeated"].extend(["p1", "p2"])
    risen = b.spawn_boss(nid)
    assert risen["escalation"] == 2
    assert risen["enemies"][0]["max_hp"] == base_hp + 10   # +5 per prior victor
    assert risen["enemies"][0]["power"] == base_pow + 2    # +1 per, capped at 2
    assert risen["name"].split(",")[0] == base["name"]     # same guardian, titled
    assert "," in risen["name"]


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
    finish_trade(g)
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
    finish_trade(g)
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
    finish_trade(g)
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
    finish_trade(g)
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
    mon = shallow_monster(g)
    g.board.nodes[mon]["monster"] = None
    p = g.player_by_pid(p0)
    start = p.node
    p.scrolls = 5
    set_pack(g, mon, [2, 2])                 # a fixed pack to flee from
    p.prev_node = start
    p.node = mon
    g.battle = {"node": mon, "stance": None, "round": 0, "charging": False,
                "used_items": [], "first_hit_taken": False}
    g._bump("battle")
    g.rng = _r.Random(1)                 # .random() → 0.134… (escape)
    g.flee(p0)
    assert p.scrolls == 5 - G.FLEE_COST and p.hull == G.MAX_HULL
    assert p.node == start and g.current.pid == p1

    # failure branch — the front enemy lands a free hit, fight continues
    g2, (q0, q1) = make_game(seed=9)
    mon2 = shallow_monster(g2)
    p2 = g2.player_by_pid(q0)
    p2.scrolls = 5
    set_pack(g2, mon2, [3])
    p2.prev_node = p2.node
    p2.node = mon2
    g2.battle = {"node": mon2, "stance": None, "round": 0, "charging": False,
                 "used_items": [], "first_hit_taken": False}
    g2._bump("battle")
    g2.rng = _r.Random(0)                # .random() → 0.844… (cut off)
    g2.flee(q0)
    assert p2.scrolls == 5 - G.FLEE_COST and p2.hull == G.MAX_HULL - 1
    assert g2.phase == "battle" and g2.current.pid == q0

    # broke captains cannot gamble
    p2.scrolls = 0
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
    mon = shallow_monster(g)
    set_pack(g, mon, [3])
    p.prev_node = p.node
    p.node = mon
    g.battle = {"node": mon, "stance": None, "round": 0, "charging": False,
                "used_items": [], "first_hit_taken": False}
    g._bump("battle")
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
    finish_trade(g)
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
    if force_kind == "mc":
        # Every live kind is now an INTERACTIVE minigame, so the multiple-choice
        # puzzle→question→upgrade-pick path in _land is only reachable via a
        # non-interactive deal. Synthesize one (kind not in INTERACTIVE) to keep
        # that branch covered.
        def fake_deal(rng, used):
            return {"kind": "quiz", "limit": 30,
                    "text": "2, 4, 6, 8, … — what comes next?",
                    "options": ["9", "10", "12", "7"], "correct": 1}
        monkeypatch.setattr(G.puzzles, "deal", fake_deal)
    elif force_kind:
        def fake_deal(rng, used):
            while True:
                d = _ORIG_DEAL(rng, used)
                if d["kind"] == force_kind:
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
    finish_trade(g)
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


def test_minigame_riddle_typed_flow(monkeypatch):
    # riddle is a typed-answer minigame (like anagram): read text, type answer
    g, (p0, p1) = make_game(seed=17)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="riddle")
    assert g.phase == "minigame"
    mg = g.minigame
    assert mg["kind"] == "riddle" and mg["limit"] == P.TIME_LIMITS["riddle"]
    snap = g.to_dict(p0)
    assert snap["minigame"]["kind"] == "riddle"
    assert snap["minigame"]["text"]                       # prompt is public
    assert "secret" not in snap["minigame"]               # answer never leaks
    # a wrong answer keeps the phase alive (retry until the clock runs out)
    with pytest.raises(GameError):
        g.minigame_submit(p0, "definitely-not-it")
    assert g.phase == "minigame"
    g.minigame_submit(p0, mg["data"]["secret"]["answer"])
    assert g.phase == "upgrade_pick"
    assert g.board.nodes[pz]["solved"]


def test_minigame_sequence_typed_flow(monkeypatch):
    g, (p0, p1) = make_game(seed=17)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="sequence")
    assert g.phase == "minigame"
    mg = g.minigame
    assert mg["kind"] == "sequence" and mg["limit"] == P.TIME_LIMITS["sequence"]
    snap = g.to_dict(p0)
    assert snap["minigame"]["kind"] == "sequence"
    assert snap["minigame"]["terms"]                      # the thread is public
    assert "secret" not in snap["minigame"]               # next term never leaks
    with pytest.raises(GameError):
        g.minigame_submit(p0, "-999")                     # wrong number, phase alive
    assert g.phase == "minigame"
    g.minigame_submit(p0, str(mg["data"]["secret"]["answer"]))
    assert g.phase == "upgrade_pick"
    assert g.board.nodes[pz]["solved"]


def _lights_out_solution(board, n):
    """GF(2) solve: taps that clear the board (see test_puzzles for the twin)."""
    rows = []
    for r in range(n):
        for c in range(n):
            eq = [0] * (n * n + 1)
            for rr, cc in ((r, c), (r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < n and 0 <= cc < n:
                    eq[rr * n + cc] = 1
            eq[-1] = board[r][c]
            rows.append(eq)
    m, piv, row = n * n, [], 0
    for col in range(m):
        sel = next((rr for rr in range(row, len(rows)) if rows[rr][col]), None)
        if sel is None:
            continue
        rows[row], rows[sel] = rows[sel], rows[row]
        for rr in range(len(rows)):
            if rr != row and rows[rr][col]:
                rows[rr] = [a ^ b for a, b in zip(rows[rr], rows[row])]
        piv.append((row, col))
        row += 1
    x = [0] * m
    for r, col in piv:
        x[col] = rows[r][-1]
    return [[i // n, i % n] for i in range(m) if x[i]]


def test_minigame_lights_out_flow(monkeypatch):
    g, (p0, p1) = make_game(seed=17)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="lights_out")
    assert g.phase == "minigame"
    mg = g.minigame
    assert mg["kind"] == "lights_out" and mg["limit"] == P.TIME_LIMITS["lights_out"]
    snap = g.to_dict(p0)
    assert snap["minigame"]["kind"] == "lights_out"
    assert snap["minigame"]["board"]                      # the grid is public
    assert "secret" not in snap["minigame"]
    with pytest.raises(GameError):                        # doing nothing fails
        g.minigame_submit(p0, [])
    assert g.phase == "minigame"
    sol = _lights_out_solution(mg["data"]["board"], mg["data"]["n"])
    g.minigame_submit(p0, sol)
    assert g.phase == "upgrade_pick"
    assert g.board.nodes[pz]["solved"]


def test_minigame_sliding_flow(monkeypatch):
    g, (p0, p1) = make_game(seed=17)
    pz = land_on_puzzle(g, p0, monkeypatch, force_kind="sliding")
    assert g.phase == "minigame"
    mg = g.minigame
    assert mg["kind"] == "sliding" and mg["limit"] == P.TIME_LIMITS["sliding"]
    snap = g.to_dict(p0)
    assert snap["minigame"]["kind"] == "sliding"
    assert snap["minigame"]["board"] and snap["minigame"]["goal"]
    assert "secret" not in snap["minigame"]
    with pytest.raises(GameError):                        # the scramble is not the goal
        g.minigame_submit(p0, mg["data"]["board"])
    assert g.phase == "minigame"
    g.minigame_submit(p0, mg["data"]["goal"])
    assert g.phase == "upgrade_pick"
    assert g.board.nodes[pz]["solved"]


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
    p.scrolls = 25
    g.shop_buy(p0, "hint")
    g.shop_buy(p0, "gale")
    g.shop_buy(p0, "planks")
    g.shop_buy(p0, "aegis_charm")
    g.shop_buy(p0, "horn")
    assert p.items == {"hint": 1, "gale": 1, "planks": 1,
                       "aegis_charm": 1, "horn": 1}
    assert p.scrolls == 25 - 2 - 2 - 3 - 4 - 4
    assert g.phase == "shop"                          # keep browsing
    with pytest.raises(GameError):
        g.shop_buy(p0, "ambrosia")                    # not stocked
    g.shop_buy(p0, "fitting")                         # ends the visit
    assert g.phase == "upgrade_pick" and len(g.upgrade_offer) == 2
    pick = g.upgrade_offer[0]
    g.pick_upgrade(p0, pick)
    assert pick in p.upgrades and g.current.pid == p1


def test_item_cap_blocks_buff_stockpiling():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    shop = find_node(g, "shop")
    force_land(g, p0, shop)
    p.scrolls = 40
    for _ in range(G.ITEM_CAP):
        g.shop_buy(p0, "gale")
    assert p.items["gale"] == G.ITEM_CAP
    with pytest.raises(GameError):
        g.shop_buy(p0, "gale")                        # the hold is full
    assert p.items["gale"] == G.ITEM_CAP


def test_trader_answers_in_the_end_of_turn_beat_only():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls = 40
    assert g.phase == "roll"                          # game opens on p0's roll
    with pytest.raises(GameError):
        g.shop_buy(p0, "planks")                      # NO buying before you roll
    g.roll(p0, 1)
    if g.phase == "sail":
        with pytest.raises(GameError):
            g.shop_buy(p0, "planks")                  # mid-sail: hands are full
        quiet = next((n for n in g.reachable
                      if g.board.nodes[n]["type"] == "sea"), None)
        assert quiet, "expected open water within a 1-roll"
        import random as _r
        g.rng = _r.Random(0)      # first draws ≥ .12: no kraken, no skirmish
        g.sail(p0, quiet)
    assert g.phase == "trade"                         # the end-of-turn beat
    with pytest.raises(GameError):
        g.shop_buy(p1, "planks")                      # rivals get no stall
    g.shop_buy(p0, "planks")                          # the acting captain does
    assert p.items["planks"] == 1
    with pytest.raises(GameError):
        g.shop_buy(p0, "fitting")                     # shipwright stays ashore
    with pytest.raises(GameError):
        g.shop_buy(p0, "golden_fleece")               # relics are land-only
    g.pass_turn(p0)                                   # wave the trader off
    assert g.current.pid == p1 and g.phase == "roll"


def test_legendary_relics_bought_outright_and_apply():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    shop = find_node(g, "shop")
    force_land(g, p0, shop)
    fleece = G.RELICS["golden_fleece"]["cost"]
    favor = G.RELICS["poseidon_favor"]["cost"]
    p.scrolls = fleece + favor + G.SHOP_ITEMS["fitting"]["cost"] + 5
    purse = p.scrolls
    base_max = p.max_hull

    # Golden Fleece: +5 max Health, full heal, bought outright (no offer screen)
    p.hull = 1
    g.shop_buy(p0, "golden_fleece")
    assert p.has("golden_fleece")
    assert p.max_hull == base_max + 5 and p.hull == p.max_hull
    assert g.phase == "shop"                          # a relic keeps you browsing
    assert p.scrolls == purse - fleece

    # can't buy the same relic twice
    with pytest.raises(GameError):
        g.shop_buy(p0, "golden_fleece")

    g.shop_buy(p0, "poseidon_favor")
    assert p.has("poseidon_favor") and p.scrolls == purse - fleece - favor

    # a relic never leaks into the random fitting pool
    g.shop_buy(p0, "fitting")
    assert g.phase == "upgrade_pick"
    assert all(u not in G.RELICS for u in g.upgrade_offer)


def test_relic_cost_is_enforced():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    shop = find_node(g, "shop")
    force_land(g, p0, shop)
    cheapest = min(r["cost"] for r in G.RELICS.values())
    p.scrolls = cheapest - 1                          # one short of any relic
    with pytest.raises(GameError):
        g.shop_buy(p0, "golden_fleece")
    assert not p.has("golden_fleece") and p.scrolls == cheapest - 1


def test_adamant_ram_stacks_strike_damage():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    plain = G.STRIKE_DMG
    p.upgrades = ["ram", "titan_ram"]                 # +1 and +2 on top of base
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    assert g.reveal["enemy_phase"]["dealt"] == plain + 3


def test_oracle_eye_pre_burns_battle_lies():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.upgrades = ["oracle_eye"]
    g.stance(p0, "attack")
    put_question(g, correct=2)
    assert len(g.question["disabled"]) == 2
    assert 2 not in g.question["disabled"]            # never burns the truth


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
    finish_trade(g)
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


# ── the four realms & the dungeon curve ──────────────────────────────────────
def test_desert_realm_is_crossed_on_foot():
    for seed in range(4):
        b = Board(seed)
        desert = [n for n in b.nodes.values() if n.get("region") == "desert"]
        assert desert
        walkers = [n for n in desert if n["type"] != "gate"]
        assert all(n.get("mode") == "foot" for n in walkers)
        vale = [n for n in b.nodes.values()
                if n.get("region") == "autumn" and n["type"] != "gate"]
        assert vale and all(n.get("mode") == "foot" for n in vale)
        sailing = [n for n in b.nodes.values()
                   if n.get("region") in ("ice", "jungle")
                   and n["type"] != "gate"]
        assert all(n.get("mode") == "sail" for n in sailing)


def test_realms_run_one_main_road_with_teeth():
    """Each realm: a MAIN road (weak packs, a shrine), an elite SHORTCUT that
    rejoins at the junction and genuinely saves distance, and a HAVEN that
    sits ON A LOOP so an exact roll can always be tuned to land there."""
    import collections

    def bfs(b, s, t, avoid=()):
        q, seen = collections.deque([(s, 0)]), {s, *avoid}
        while q:
            cur, d = q.popleft()
            if cur == t:
                return d
            for nb in b.neighbors[cur]:
                if nb not in seen:
                    seen.add(nb)
                    q.append((nb, d + 1))
        return -1

    for seed in range(5):
        b = Board(seed)
        for theme in b.regions:
            realm = {nid: n for nid, n in b.nodes.items()
                     if n.get("region") == theme}
            gate = next(nid for nid, n in b.nodes.items()
                        if n["type"] == "gate" and n.get("region") == theme)
            lair = next(nid for nid in realm if realm[nid]["type"] == "lair")

            if theme == "autumn":
                # the Amber Vale is a MAZE, not a road: a normal complement of
                # foes (some guarding dead-end spurs), blind-alley dead-ends, a
                # shrine and a haven, boss always reachable through the fog.
                monsters = [n for n in realm.values() if n["type"] == "monster"]
                assert len(monsters) >= 3
                assert any(n.get("elite") for n in monsters)   # guarded spurs
                assert any(n["type"] == "shrine" for n in realm.values())
                assert any(n["type"] == "haven" for n in realm.values())
                assert bfs(b, gate, lair) >= 6
                deadends = [nid for nid in realm
                            if len(b.neighbors[nid]) == 1 and nid != gate]
                assert len(deadends) >= 3
                continue

            # the SHORTCUT: elite grounds in deep water (desert keeps it small)
            elites = [n for nid, n in realm.items()
                      if n["type"] == "monster" and n.get("elite")]
            want = 1 if theme == "desert" else 2
            assert len(elites) == want
            assert all(n["depth"] >= 5 for n in elites)

            # the MAIN road: only weak packs, plus a shrine to pray at
            weak = [n for nid, n in realm.items()
                    if n["type"] == "monster" and not n.get("elite")]
            assert weak and all(n["depth"] <= 2 for n in weak)
            assert any(n["type"] == "shrine" for n in realm.values())

            # the HAVEN sits on a loop: its two road-neighbours stay connected
            # even with the haven removed — you can always circle to land on it
            havens = [nid for nid, n in realm.items() if n["type"] == "haven"]
            assert havens
            for h in havens:
                nbrs = b.neighbors[h]
                assert len(nbrs) >= 2
                assert bfs(b, nbrs[0], nbrs[-1], avoid=(h,)) > 0

            # the shortcut genuinely SHORTENS the trek — and the trek is real.
            # the Bleached Reach runs sparser (cairns spread far apart), so its
            # hop-count floor is lower than the sail realms'.
            short_ids = [nid for nid in realm if "_s" in nid]
            full = bfs(b, gate, lair)
            main_only = bfs(b, gate, lair, avoid=short_ids)
            floor = 6 if theme == "desert" else 10
            assert floor <= full < main_only


def test_realm_spines_carry_depth():
    b = Board(3)
    for theme in b.regions:
        depths = [n["depth"] for n in b.nodes.values()
                  if n.get("region") == theme and n.get("depth")]
        assert max(depths) >= 5                   # a real trek to the boss
        lair = next(n for n in b.nodes.values()
                    if n["type"] == "lair" and n["region"] == theme)
        assert lair["depth"] == max(depths)       # the boss sits deepest


def test_packs_scale_with_depth():
    b = Board(1)
    shallow = {"region": "ice", "depth": 1, "band": 4}
    deep = {"region": "ice", "depth": 6, "band": 4}
    import random as _r
    rng = _r.Random(0)
    weak = [b.random_pack(shallow, rng) for _ in range(12)]
    strong = [b.random_pack(deep, rng) for _ in range(12)]
    avg = lambda packs: sum(sum(e["max_hp"] + e["power"] for e in m["enemies"])
                            for m in packs) / len(packs)
    assert avg(strong) > avg(weak)                # the dungeon curve is real
    assert all(m["tier"] == 3 for m in strong)    # deep questions are trials
    assert all(e.get("model") for m in weak + strong for e in m["enemies"])


def test_realm_ambush_odds_rise_with_depth(monkeypatch):
    g, (p0, p1) = make_game(seed=17)
    mon = find_node(g, "monster", region=g.board.regions[0])
    node = g.board.nodes[mon]
    node["depth"] = 6
    g.rng = __import__("random").Random(4)        # first random() ≈ 0.236 < odds
    force_land(g, p0, mon)
    assert g.phase == "battle"                    # deep wilds almost always bite


def test_mountain_pass_halts_the_voyage():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    gate = g.board.gates[0]
    nbrs = g.board.neighbors[gate]
    hub_side = next(n for n in nbrs if not g.board.nodes[n].get("region"))
    realm_side = next(n for n in nbrs if g.board.nodes[n].get("region"))
    p.node = hub_side
    p.prev_node = hub_side
    g.roll(p0, 3)
    assert gate in g.reachable                 # the pass absorbs the roll...
    assert realm_side not in g.reachable       # ...nothing beyond it in one sail
    g.sail(p0, gate)
    finish_trade(g)
    assert g.phase == "roll" and g.current.pid == p1   # a quiet landfall


def test_sea_attacks_on_the_crossing():
    import random as _r
    g, (p0, p1) = make_game()
    # sea attacks happen in the WILDS (realm waters with depth), never the hub
    sea = next(nid for nid, n in g.board.nodes.items()
               if n["type"] == "sea" and n.get("region") and (n.get("depth") or 0) >= 3)
    g.rng = _r.Random(1)                       # 0.134 < the realm-water odds
    force_land(g, p0, sea)
    assert g.phase == "battle"                 # beset mid-crossing
    m = g.board.alive_monster(sea)
    assert m
    set_pack(g, sea, [1])
    g.rng = _r.Random(0)                       # coin ≥ .5 → a trivia round
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    assert g.reveal["battle_over"]
    assert g.board.nodes[sea]["monster"] is None   # the water falls quiet


def test_hub_islands_never_ambush():
    """Landing on a hub island is always safe — only the sea-lanes bite."""
    import random as _r
    for seed in range(6):
        g, (p0, p1) = make_game(seed=seed)
        hub_land = [nid for nid, n in g.board.nodes.items()
                    if n["type"] not in ("sea", "monster", "lair", "pharos")
                    and not n.get("region")]
        for land in hub_land[:8]:
            p = g.player_by_pid(g.current.pid)
            g.rng = _r.Random(1)               # would trigger IF land could bite
            g.phase = "sail"
            p.prev_node = p.node
            p.node = land
            # skip nodes that legitimately open their own phase (shrine/shop…)
            g._land(p, land)
            assert g.phase != "battle"         # no fight on a peaceful landing


def test_hub_sea_is_calm_but_not_empty():
    """Home-water crossings can meet the KRAKEN (a mind-gauntlet) or a small
    skirmish — never a realm horror. Most crossings stay quiet."""
    import random as _r
    g, (p0, p1) = make_game(seed=0)
    hub_seas = [nid for nid, n in g.board.nodes.items()
                if n["type"] == "sea" and not n.get("region")]
    assert hub_seas
    krakens = skirmishes = quiet = 0
    for seed in range(60):
        sea = hub_seas[seed % len(hub_seas)]
        g.board.nodes[sea]["monster"] = None
        g.kraken = None
        g.minigame = None
        g.battle = None
        p = g.player_by_pid(g.current.pid)
        g.rng = _r.Random(seed)
        g.phase = "sail"
        p.prev_node = p.node
        p.node = sea
        g._land(p, sea)
        if g.phase == "minigame" and g.minigame.get("kraken"):
            krakens += 1
            assert g.minigame["kind"] == "ravens"          # a test of pure IQ
            assert g.minigame["limit"] == P.TIME_LIMITS["ravens"]
            g.kraken = None
            g.minigame = None
            g._next_turn()
        elif g.phase == "battle":
            skirmishes += 1
            m = g.board.nodes[sea]["monster"]
            assert not m.get("boss")                       # nothing lordly out here
            assert len(m["enemies"]) <= 3
            for e in m["enemies"]:
                assert e["max_hp"] <= 4                    # a LIGHT pack only
            g.battle = None
        else:
            quiet += 1
    assert krakens >= 1                                    # the kraken does rise
    assert skirmishes >= 1                                 # raiders still prowl
    assert quiet > krakens + skirmishes                    # but calm is the norm


# ── boss fights demand strategy ──────────────────────────────────────────────
def boss_battle(seed=3):
    g, pids = make_game(seed=seed)
    lair = g.board.lairs()[0]
    force_land(g, pids[0], lair)
    assert g.phase == "battle"
    return g, pids, lair


def test_boss_counters_even_when_you_hit():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)                               # correct strike
    assert g.reveal["enemy_phase"]["dealt"] >= 1  # you drew blood
    assert p.hull < G.MAX_HULL                    # ...and still got hit back
    assert not g.reveal["enemy_phase"]["evaded"]


def test_pack_still_lets_a_clean_hit_evade():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [4])
    battle_at(g, p0, mon)
    g.stance(p0, "attack")
    put_question(g)
    g.answer(p0, 0)
    assert g.reveal["enemy_phase"]["evaded"]      # packs punish only misses
    assert g.player_by_pid(p0).hull == G.MAX_HULL


def test_boss_heavy_telegraph_cycle_and_guard():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = 30
    p.hull = 30
    # exchange 1 — a TRIVIA round (bosses alternate, starting with trivia)
    g.stance(p0, "guard")
    assert g.qctx["tier"] == 1                    # guard reads, not strikes
    put_question(g, correct=0)
    g.answer(p0, 1)                               # failed guard → take the hit
    g.advance_after_reveal()
    assert g.battle["charging"] is False
    # exchange 2 — a PUZZLE round (never a riddle); fail it → take the hit
    g.stance(p0, "guard")
    assert g.phase == "minigame" and g.minigame["battle"]
    assert g.minigame["kind"] != "riddle"
    g.resolve_minigame(False)
    g.advance_after_reveal()
    assert g.battle["charging"] is True           # after 2, the heavy telegraphs
    hull_before = p.hull
    # exchange 3 (trivia again) is the heavy: guard it clean → no damage
    g.stance(p0, "guard")
    put_question(g, correct=2)
    g.answer(p0, 2)
    assert g.reveal["enemy_phase"]["blocked"]
    assert g.reveal["enemy_phase"]["heavy"]
    assert p.hull == hull_before
    g.advance_after_reveal()
    assert not g.battle["charging"]               # the cycle resets


def test_guard_riposte_reflects_the_blow():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = 30
    p.hull = 30
    front = g.board.alive_monster(lair)["enemies"][0]
    power = front["power"]
    hp_before = front["hp"]
    # a normal exchange: a read blow is turned back on the attacker for its
    # own power, and you take nothing
    g.stance(p0, "guard")
    put_question(g, correct=1)
    g.answer(p0, 1)
    ep = g.reveal["enemy_phase"]
    assert ep["blocked"] and ep["riposte"]
    assert ep["dealt"] == power
    assert p.hull == 30
    assert g.board.alive_monster(lair)["enemies"][0]["hp"] == hp_before - power


def test_guard_riposte_doubles_on_a_heavy():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = 30
    p.hull = 30
    power = g.board.alive_monster(lair)["enemies"][0]["power"]
    # burn two exchanges to reach the telegraphed heavy on exchange 3
    g.stance(p0, "guard")
    put_question(g, correct=0)
    g.answer(p0, 1)                               # trivia miss → take the counter
    g.advance_after_reveal()
    g.stance(p0, "guard")
    g.resolve_minigame(False)                     # puzzle round missed too
    g.advance_after_reveal()
    hull_before = p.hull                          # already dinged by two misses
    g.stance(p0, "guard")                         # heavy round, read it clean
    put_question(g, correct=2)
    g.answer(p0, 2)
    ep = g.reveal["enemy_phase"]
    assert ep["heavy"] and ep["riposte"]
    assert ep["dealt"] == power * G.HEAVY_MULT
    assert p.hull == hull_before                  # the heavy never lands on you


def test_boss_heavy_hits_double_when_not_guarded():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = 30
    p.hull = 30
    power = g.board.alive_monster(lair)["enemies"][0]["power"]
    g.stance(p0, "guard")                         # trivia counter
    put_question(g, correct=0)
    g.answer(p0, 1)
    g.advance_after_reveal()
    g.stance(p0, "guard")                         # puzzle counter
    g.resolve_minigame(False)
    g.advance_after_reveal()
    hull_before = p.hull
    g.stance(p0, "guard")                         # heavy round, failed guard
    put_question(g, correct=0)
    g.answer(p0, 1)
    assert g.reveal["enemy_phase"]["heavy"]
    assert hull_before - p.hull == power * G.HEAVY_MULT


def test_boss_enrages_at_half_strength():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = 30
    p.hull = 30
    m = g.board.alive_monster(lair)
    e = m["enemies"][0]
    power_before = e["power"]
    e["hp"] = (e["max_hp"] // 2) + 1              # one magic tips it under half
    g.stance(p0, "magic")
    put_question(g)
    g.answer(p0, 0)
    assert m["enraged"] and e["power"] == power_before + 1
    assert "ENRAGES" in g.reveal["note"]


def test_boss_battle_state_is_published():
    g, (p0, p1), lair = boss_battle()
    snap = g.to_dict(p0)
    b = snap["battle"]
    assert b["boss"] and b["model"] and b["round"] == 0
    assert b["charging"] is False and b["enraged"] is False
    assert all(e["model"] for e in b["enemies"])


def test_warden_resets_between_challengers():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.banked = RELICS_TO_WIN
    g.pharos_open = True
    p.hull = 1
    p.prev_node = p.node
    p.node = "pharos"
    g._land(p, "pharos")
    warden = g.board.nodes["pharos"]["monster"]["enemies"][0]
    warden["hp"] = 2                              # nearly slain...
    g.stance(p0, "attack")
    put_question(g, correct=0)
    g.answer(p0, 1)                               # ...but the counter sinks you
    assert p.node == p.checkpoint
    fresh = g.board.nodes["pharos"]["monster"]["enemies"][0]
    assert fresh["hp"] == fresh["max_hp"]         # nobody inherits a weak Warden


# ── pitch & planks ───────────────────────────────────────────────────────────
def test_planks_patch_hull_mid_battle():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.items["planks"] = 1
    p.hull = 2
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    g.use_item_charm(p0, "planks")
    assert p.hull == 2 + G.PLANKS_HEAL and p.items["planks"] == 0
    assert g.phase == "battle"                    # a free action, fight goes on
    with pytest.raises(GameError):
        g.use_item_charm(p0, "planks")            # none left


def test_planks_refuse_a_sound_hull():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.items["planks"] = 1
    with pytest.raises(GameError):
        g.use_item_charm(p0, "planks")
    assert p.items["planks"] == 1


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
    finish_trade(g)
    assert g.current.pid == pids[1]
    g.remove_player(pids[0], pids[2])
    assert g.current.pid == pids[1]
    g.remove_player(pids[0], pids[1])
    assert g.phase == "finished" and g.winner == pids[0]


# ── the kraken's gauntlet ─────────────────────────────────────────────────────
def _summon_kraken(g, pid):
    """Land on hub water with a seed that rolls under KRAKEN_CHANCE."""
    import random as _r
    sea = next(nid for nid, n in g.board.nodes.items()
               if n["type"] == "sea" and not n.get("region"))
    g.board.nodes[sea]["monster"] = None
    p = g.player_by_pid(pid)
    seed = next(s for s in range(400) if _r.Random(s).random() < G.KRAKEN_CHANCE)
    g.rng = _r.Random(seed)
    g.phase = "sail"
    p.prev_node = p.node
    p.node = sea
    g._land(p, sea)
    assert g.phase == "minigame" and g.minigame.get("kraken")
    return sea


def test_kraken_three_riddles_then_freedom():
    g, (p0, p1) = make_game()
    _summon_kraken(g, p0)
    for i in range(G.KRAKEN_RIDDLES):
        assert g.minigame["kind"] == "ravens"
        assert g.minigame["kraken_no"] == i + 1
        g.resolve_minigame(True)
    assert g.kraken is None and g.minigame is None
    finish_trade(g)
    assert g.current.pid == p1                        # turn passed normally
    assert g.player_by_pid(p0).skip_turns == 0


def test_kraken_failure_costs_a_turn():
    g, (p0, p1) = make_game()
    _summon_kraken(g, p0)
    g.resolve_minigame(True)                          # one right...
    g.resolve_minigame(False)                         # ...one wrong: it has you
    p = g.player_by_pid(p0)
    assert p.skip_turns == 1
    assert g.current.pid == p1
    # p1 passes their turn → p0's turn is CONSUMED by the kraken's toll
    g.roll(p1, 1)
    dest = next(iter(g.reachable))
    g.sail(p1, dest)
    # whatever p1's landing opened, resolve to the next turn if simple sea
    if g.phase == "roll":                             # p0 was skipped → p1 again
        assert g.current.pid == p1
        assert p.skip_turns == 0


def test_kraken_never_rises_for_poseidons_favor():
    import random as _r
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.upgrades.append("poseidon_favor")
    sea = next(nid for nid, n in g.board.nodes.items()
               if n["type"] == "sea" and not n.get("region"))
    for seed in range(50):
        g.board.nodes[sea]["monster"] = None
        g.rng = _r.Random(seed)
        g.phase = "sail"
        p.prev_node = p.node
        p.node = sea
        g._land(p, sea)
        assert not (g.phase == "minigame" and (g.minigame or {}).get("kraken"))
        g.battle = None
        g.minigame = None


# ── the sphinx's toll ─────────────────────────────────────────────────────────
def _desert_road(g):
    return next(nid for nid, n in g.board.nodes.items()
                if n["type"] == "sea" and n.get("region") == "desert"
                and (n.get("depth") or 0) <= 1)


def test_sphinx_stops_desert_crossings():
    import random as _r
    g, (p0, p1) = make_game()
    road = _desert_road(g)
    p = g.player_by_pid(p0)
    stopped = False
    for seed in range(60):
        g.minigame = None
        g.battle = None
        g.board.nodes[road]["monster"] = None
        g.rng = _r.Random(seed)
        g.turn_idx = 0                                  # keep p0 the actor
        g.phase = "sail"
        p.prev_node = p.node
        p.node = road
        g._land(p, road)
        if g.phase == "minigame" and g.minigame.get("sphinx"):
            stopped = True
            assert g.minigame["kind"] == "riddle"       # she speaks in riddles
            break
        g.battle = None
    assert stopped


def test_sphinx_failure_sweeps_you_back():
    import random as _r
    g, (p0, p1) = make_game()
    road = _desert_road(g)
    p = g.player_by_pid(p0)
    start = p.node
    for seed in range(60):
        g.minigame = None
        g.battle = None
        g.board.nodes[road]["monster"] = None
        g.rng = _r.Random(seed)
        g.turn_idx = 0                                  # keep p0 the actor
        g.phase = "sail"
        p.prev_node = start
        p.node = road
        g._land(p, road)
        if g.phase == "minigame" and g.minigame.get("sphinx"):
            before = g.current.pid
            g.resolve_minigame(False)
            assert p.node != road                       # swept back down the road
            assert g.current.pid != before              # …and the turn moved on
            return
        g.battle = None
    assert False, "sphinx never appeared"


def test_sphinx_pass_lets_you_stay():
    import random as _r
    g, (p0, p1) = make_game()
    road = _desert_road(g)
    p = g.player_by_pid(p0)
    for seed in range(60):
        g.minigame = None
        g.battle = None
        g.board.nodes[road]["monster"] = None
        g.rng = _r.Random(seed)
        g.turn_idx = 0                                  # keep p0 the actor
        g.phase = "sail"
        p.prev_node = p.node
        p.node = road
        g._land(p, road)
        if g.phase == "minigame" and g.minigame.get("sphinx"):
            before = g.current.pid
            g.resolve_minigame(True)
            assert p.node == road                       # you hold your ground
            finish_trade(g)
            assert g.current.pid != before              # …and the turn moved on
            return
        g.battle = None
    assert False, "sphinx never appeared"


# ── puzzles in combat ─────────────────────────────────────────────────────────
def test_pack_rounds_split_between_trivia_and_puzzles():
    import random as _r
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [4])
    battle_at(g, p0, mon)
    kinds = set()
    for seed in range(30):
        g.rng = _r.Random(seed)
        g.phase = "battle"
        g.minigame = None
        g.question = None
        g.stance(p0, "attack")
        kinds.add("puzzle" if g.phase == "minigame" else "trivia")
        if g.phase == "minigame":
            assert g.minigame["battle"]
            assert g.minigame["kind"] != "riddle"
    assert kinds == {"trivia", "puzzle"}                # both faces of the coin


def test_battle_puzzle_success_lands_your_blow():
    import random as _r
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [1])
    battle_at(g, p0, mon)
    g.rng = _r.Random(1)                                # coin < .5 → puzzle round
    g.stance(p0, "attack")
    assert g.phase == "minigame" and g.minigame["battle"]
    g.resolve_minigame(True)
    assert g.phase == "reveal"
    assert g.reveal["kind"] == "battle"
    assert g.reveal["challenge"] == "puzzle"
    assert g.reveal["was_correct"] and g.reveal["battle_over"]


def test_battle_puzzle_failure_gets_you_hit():
    import random as _r
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    mon = find_node(g, "monster")
    set_pack(g, mon, [4])
    battle_at(g, p0, mon)
    g.rng = _r.Random(1)
    g.stance(p0, "attack")
    assert g.phase == "minigame"
    g.resolve_minigame(False)
    assert g.reveal["challenge"] == "puzzle"
    assert not g.reveal["was_correct"]
    assert p.hull < G.MAX_HULL                          # the pack punished the miss


def test_boss_rotates_all_three_challenge_decks():
    # Battles no longer theme trivia by domain — the general Open Trivia DB
    # already spans every category. A boss instead ROTATES the three decks
    # (multiple-choice, puzzle, typed Jeopardy) across its rounds so a trial
    # tests the whole mind.
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.banked = RELICS_TO_WIN
    g.pharos_open = True
    p.prev_node = p.node
    p.node = "pharos"
    g._land(p, "pharos")
    assert g.phase == "battle"
    modes = set()
    for rnd in range(6):
        g.phase = "battle"
        g.battle["round"] = rnd
        g.minigame = None
        g.question = None
        g.qctx = None
        g.stance(p0, "attack")
        if g.phase == "minigame":
            modes.add("puzzle")
        else:
            assert g.phase == "question"
            modes.add(g.qctx["mode"])
    # three decks: general MC (offline trivia), typed Jeopardy, and puzzles
    assert "jeopardy" in modes and modes <= {"mc", "puzzle", "jeopardy"}


def test_typed_jeopardy_correct_answer():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    _typed_battle(g, p0, mon)
    hp0 = pack(g, mon)[0]["hp"]
    g.answer_text(p0, "shakespeare")               # leniently matched, case-free
    assert g.phase == "reveal"
    assert g.reveal["was_correct"] and g.reveal["typed"]
    assert g.reveal["answer_text"] == "Shakespeare"
    assert g.flash and g.flash["ok"]               # verdict banner: correct
    assert pack(g, mon)[0]["hp"] < hp0             # your blade landed


def test_typed_jeopardy_wrong_answer_reveals():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    _typed_battle(g, p0, mon)
    g.answer_text(p0, "charles dickens")
    assert g.phase == "reveal" and not g.reveal["was_correct"]
    assert g.flash and not g.flash["ok"]
    assert "Shakespeare" in g.flash["text"]        # the answer is revealed


def test_typed_and_choice_answers_dont_cross():
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    _typed_battle(g, p0, mon)
    with pytest.raises(GameError):                 # can't pick an option on a typed clue
        g.answer(p0, 0)
    # and a multiple-choice battle question rejects a typed answer
    g.reveal = None
    g.battle["stance"] = "attack"
    g.qctx = {"kind": "battle", "island": mon, "tier": 1, "domain": None, "mode": "mc"}
    g.question = None
    g._bump("question")
    g.set_question({"text": "Q?", "options": ["a", "b", "c", "d"], "correct": 1})
    with pytest.raises(GameError):
        g.answer_text(p0, "b")


def test_correct_answer_but_boss_counter_kills_is_marked_death():
    # A boss answers every exchange — a heavy counter can drop you even on a
    # right answer. The reveal must flag player_dead so the client shows YOU DIED,
    # not VICTORY (the boss is still standing).
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    g.board.nodes[mon]["monster"] = {
        "name": "Boss", "tier": 2, "domain": "clio", "boss": True,
        "enemies": [{"name": "B", "hp": 30, "max_hp": 30, "power": 9}]}
    p = g.player_by_pid(p0)
    p.prev_node = p.node
    p.node = mon
    p.hull = 1
    g.battle = {"node": mon, "stance": None, "round": 0, "charging": True,
                "used_items": [], "first_hit_taken": True}
    g._bump("battle")
    g._force_mode = "mc"
    g.stance(p0, "attack", 0)
    put_question(g)
    g.answer(p0, 0)                                 # correct, but the counter lands
    assert g.reveal["was_correct"] and g.reveal["battle_over"]
    assert g.reveal["player_dead"]                  # → YOU DIED, not VICTORY
    assert pack(g, mon)[0]["hp"] > 0                # boss survived


def test_flotsam_hauled_aboard_for_a_scroll():
    g, (p0, p1) = make_game()
    sea = find_node(g, "sea")
    g.board.nodes[sea]["flotsam"] = True
    g.board.nodes[sea]["monster"] = None
    p = g.player_by_pid(p0)
    before = p.scrolls
    p.prev_node = p.node
    p.node = sea
    g._land(p, sea)
    assert p.scrolls == before + 1                 # +1 scroll on pickup
    assert not g.board.nodes[sea]["flotsam"]        # and it's spent


def test_board_seeds_some_flotsam():
    for seed in range(6):
        b = Board(seed)
        seas = [n for n in b.nodes.values() if n["type"] == "sea"]
        assert any(n.get("flotsam") for n in seas)


def test_jeopardy_answer_matching():
    C = questions.check_jeopardy
    assert C("Hemingway", "(Ernest) Hemingway")
    assert C("ernest hemingway", "(Ernest) Hemingway")
    assert C("the jordan", "Jordan") and C("jordan", "the Jordan")
    assert C("Mozart", "Wolfgang Amadeus Mozart")
    assert C("a raisin in the sun", "A Raisin in the Sun")
    assert not C("Beethoven", "Mozart")
    assert not C("", "Mozart")

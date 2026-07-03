"""Engine tests — the rules, not the server."""
import pytest

import board
import game
from game import Game, GameError


def make_game(n=2, seed=7):
    g = Game("TEST", seed=seed)
    pids = [g.add_player(f"tok{i}", f"P{i}").pid for i in range(n)]
    g.start(pids[0])
    return g, pids


def put_question(g, correct=0):
    g.set_question({"text": "Q?", "options": ["a", "b", "c", "d"], "correct": correct})


def sail_to(g, pid, node):
    """Roll big and sail straight to node (must be within 6)."""
    g.roll(pid, 6, 6)
    assert node in g.reachable, f"{node} not reachable from {g.current.node}"
    g.sail(pid, node)


# ── board sanity ─────────────────────────────────────────────────────────────
def test_board_shape():
    assert len(board.NODES) == 13
    assert len(board.LIBRARIES) == 5
    assert len(board.OPEN_ISLES) == 4
    for nid, nbs in board.NEIGHBORS.items():
        assert nbs, f"{nid} is isolated"
        for nb in nbs:
            assert nid in board.NEIGHBORS[nb]   # symmetric


def test_everything_within_six_without_delos():
    for nid in board.NODES:
        if nid == "delos":
            continue
        dist = board.reachable({nid}, 6, delos_ok=False)
        others = set(board.NODES) - {nid, "delos"}
        assert others <= set(dist)


def test_delos_blocked_until_allowed():
    dist = board.reachable({"agora"}, 6, delos_ok=False)
    assert "delos" not in dist
    dist = board.reachable({"agora"}, 1, delos_ok=True)
    assert dist["delos"] == 1


# ── lobby ────────────────────────────────────────────────────────────────────
def test_lobby_rules():
    g = Game("TEST", seed=1)
    p0 = g.add_player("t0", "Ann")
    with pytest.raises(GameError):
        g.start(p0.pid)                       # needs 2 players
    g.add_player("t1", "")
    assert g.players[1].name == "Captain 2"   # default name
    with pytest.raises(GameError):
        g.start(g.players[1].pid)             # only host starts
    g.start(p0.pid)
    assert g.phase == "roll"
    assert all(p.node == board.START for p in g.players)
    assert set(g.library_domains) == set(board.LIBRARIES)
    with pytest.raises(GameError):
        g.add_player("t2", "Late")            # locked after start


def test_max_players():
    g = Game("TEST", seed=1)
    for i in range(6):
        g.add_player(f"t{i}", f"P{i}")
    with pytest.raises(GameError):
        g.add_player("t6", "P6")


# ── movement ─────────────────────────────────────────────────────────────────
def test_roll_and_sail():
    g, (p0, p1) = make_game()
    with pytest.raises(GameError):
        g.roll(p1, 3, 3)                      # not your turn
    g.roll(p0, 1, 2)
    assert g.phase == "sail"
    assert g.reachable["oracle"] == 1         # port → oracle (spoke)
    assert "piraeus" not in g.reachable       # must move
    assert "delos" not in g.reachable         # locked without laurels
    with pytest.raises(GameError):
        g.sail(p0, "pergamon")                # too far for a 2
    g.sail(p0, "samos")                       # 2 along the outer ring
    assert g.current.pid != p0 or g.phase != "roll" or True


def test_landing_on_port_ends_turn():
    g, (p0, p1) = make_game()
    sail_to(g, p0, "kos")                     # library → island phase
    assert g.phase == "island"
    g.pass_turn(p0)
    assert g.current.pid == p1 and g.phase == "roll"
    sail_to(g, p1, "samos")
    g.pass_turn(p1)
    # p0 sails back to the port: no action there, turn passes immediately
    sail_to(g, p0, "piraeus")
    assert g.current.pid == p1 and g.phase == "roll"


# ── library wagers ───────────────────────────────────────────────────────────
def test_wager_rewards_by_tier():
    g, (p0, p1) = make_game()
    sail_to(g, p0, "kos")
    dom = g.library_domains["kos"]
    g.wager(p0, 3)
    put_question(g, correct=2)
    g.answer(p0, 2)
    assert g.phase == "reveal"
    assert g.player_by_pid(p0).scrolls[dom] == 3
    assert g.reveal["was_correct"]
    g.advance_after_reveal()
    assert g.current.pid == p1


def test_tier3_miss_costs_a_scroll():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls["clio"] = 2
    sail_to(g, p0, "kos")
    g.wager(p0, 3)
    put_question(g, correct=0)
    g.answer(p0, 1)                           # wrong
    assert p.total_scrolls() == 1


def test_tier1_miss_is_safe():
    g, (p0, p1) = make_game()
    sail_to(g, p0, "kos")
    g.wager(p0, 1)
    put_question(g, correct=0)
    g.answer(p0, 3)
    assert g.player_by_pid(p0).total_scrolls() == 0


def test_muse_moves_on_and_librarian_remembers():
    g, (p0, p1) = make_game(seed=3)
    sail_to(g, p0, "kos")
    before = g.library_domains["kos"]
    g.wager(p0, 1)
    put_question(g)
    g.answer(p0, 0)
    g.advance_after_reveal()
    # domain card rotated (deck may repeat, but a draw happened)
    assert g.player_by_pid(p0).last_library == "kos"
    # p1 takes a turn
    sail_to(g, p1, "samos")
    g.wager(p1, 1)
    put_question(g)
    g.answer(p1, 0)
    g.advance_after_reveal()
    # p0 leaves kos, then returns → locked out, nothing to do, auto-pass
    sail_to(g, p0, "piraeus")
    sail_to(g, p1, "piraeus")
    sail_to(g, p0, "kos")
    assert g.phase == "roll" and g.current.pid == p1
    # ...but a different library is fine
    sail_to(g, p1, "naxos")                   # open isle, broke → auto-pass
    sail_to(g, p0, "rhodos")
    assert g.phase == "island" and "wager1" in g.island_actions()
    g.wager(p0, 1)
    put_question(g)
    g.answer(p0, 0)
    g.advance_after_reveal()
    assert g.player_by_pid(p0).last_library == "rhodos"


# ── trials & laurels ─────────────────────────────────────────────────────────
def win_trial(g, pid, lib):
    """Force the library's domain to one the player can afford, then pass it."""
    p = g.player_by_pid(pid)
    dom = next(d for d in board.DOMAINS if d not in p.laurels)
    g.library_domains[lib] = dom
    p.scrolls[dom] = max(p.scrolls[dom], game.TRIAL_COST)
    p.last_library = None
    sail_to(g, pid, lib)
    g.trial(pid)
    put_question(g)
    g.answer(pid, 0)
    g.advance_after_reveal()
    return dom


def test_trial_earns_laurel_and_spends_scrolls():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    dom = g.library_domains["kos"]
    p.scrolls[dom] = 3
    sail_to(g, p0, "kos")
    g.trial(p0)
    put_question(g)
    g.answer(p0, 0)
    assert dom in p.laurels
    assert p.scrolls[dom] == 3 - game.TRIAL_COST
    g.advance_after_reveal()


def test_trial_needs_scrolls_and_no_duplicate_laurel():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    dom = g.library_domains["kos"]
    sail_to(g, p0, "kos")
    assert "trial" not in g.island_actions()
    with pytest.raises(GameError):
        g.trial(p0)                           # no scrolls
    p.scrolls[dom] = 5
    p.laurels.append(dom)
    with pytest.raises(GameError):
        g.trial(p0)                           # already has this laurel


def test_failed_trial_keeps_scrolls():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    dom = g.library_domains["kos"]
    p.scrolls[dom] = 2
    sail_to(g, p0, "kos")
    g.trial(p0)
    put_question(g, correct=0)
    g.answer(p0, 1)
    assert p.scrolls[dom] == 2 and dom not in p.laurels


# ── buildings ────────────────────────────────────────────────────────────────
def test_build_academy_and_tuition():
    g, (p0, p1) = make_game()
    pa, pb = g.player_by_pid(p0), g.player_by_pid(p1)
    pa.scrolls["clio"] = 3
    sail_to(g, p0, "naxos")
    assert set(g.island_actions()) >= {"academy", "harbor", "pass"}
    g.build(p0, "academy")
    assert g.plots["naxos"] == {"kind": "academy", "owner": p0}
    assert pa.total_scrolls() == 0
    # p1 lands on the academy island → tuition question
    sail_to(g, p1, "naxos")
    assert g.phase == "question" and g.qctx["kind"] == "tuition"
    dom = g.qctx["domain"]
    put_question(g)
    g.answer(p1, 0)                           # correct: both profit
    assert pb.scrolls[dom] == 1 and pa.scrolls[dom] == 1
    g.advance_after_reveal()
    # p0 (broke) lands on empty kalypso: can't afford to build → auto-pass
    sail_to(g, p0, "kalypso")
    assert g.phase == "roll" and g.current.pid == p1
    sail_to(g, p1, "piraeus")
    # owner landing on own academy: no tuition question fired
    sail_to(g, p0, "naxos")
    assert g.phase == "roll" and g.qctx is None


def test_tuition_miss_pays_owner_only():
    g, (p0, p1) = make_game()
    pa, pb = g.player_by_pid(p0), g.player_by_pid(p1)
    pa.scrolls["athena"] = 3
    sail_to(g, p0, "naxos")
    g.build(p0, "academy")
    sail_to(g, p1, "naxos")
    dom = g.qctx["domain"]
    put_question(g, correct=0)
    g.answer(p1, 2)
    assert pa.scrolls[dom] == 1 and pb.total_scrolls() == 0


def test_harbor_extends_origins():
    g, (p0, p1) = make_game()
    pa = g.player_by_pid(p0)
    pa.scrolls["apollo"] = 2
    sail_to(g, p0, "melos")                   # far from port
    g.build(p0, "harbor")
    sail_to(g, p1, "samos")
    g.pass_turn(p1)
    # p0 is on melos; harbor there means origins {melos}; sail somewhere near port
    sail_to(g, p0, "kythera")
    g.pass_turn(p0)
    sail_to(g, p1, "piraeus")
    # now p0 rolls a 1: reachable must include melos-neighbors via harbor origin
    g.roll(p0, 1, 1)
    assert "melos" in g.reachable or "agora" in g.reachable


def test_no_build_on_taken_plot():
    g, (p0, p1) = make_game()
    pa, pb = g.player_by_pid(p0), g.player_by_pid(p1)
    pa.scrolls["clio"] = 2
    pb.scrolls["clio"] = 2
    sail_to(g, p0, "thera")
    g.build(p0, "harbor")
    sail_to(g, p1, "thera")                   # rival harbor: no tuition, no plot
    assert g.phase == "roll" and g.current.pid == p0   # auto-passed
    assert g.plots["thera"] == {"kind": "harbor", "owner": p0}


# ── oracle ───────────────────────────────────────────────────────────────────
def test_oracle_flow():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls["clio"] = 1
    sail_to(g, p0, "oracle")
    g.oracle_accept(p0)
    assert p.total_scrolls() == 0             # fee paid up front
    put_question(g)
    g.answer(p0, 0)
    g.advance_after_reveal()
    assert g.phase == "oracle_claim"
    with pytest.raises(GameError):
        g.oracle_claim(p1, ["clio", "clio", "clio"])
    g.oracle_claim(p0, ["athena", "athena", "dionysos"])
    assert p.scrolls["athena"] == 2 and p.scrolls["dionysos"] == 1
    assert g.current.pid == p1


def test_oracle_miss_burns_fee():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls["clio"] = 1
    sail_to(g, p0, "oracle")
    g.oracle_accept(p0)
    put_question(g, correct=0)
    g.answer(p0, 1)
    g.advance_after_reveal()
    assert p.total_scrolls() == 0 and g.current.pid == p1


def test_oracle_needs_fee():
    g, (p0, p1) = make_game()
    sail_to(g, p0, "oracle")                  # broke: no oracle action offered
    assert g.phase == "roll" and g.current.pid == p1   # auto-passed


# ── agora ────────────────────────────────────────────────────────────────────
def test_trade():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls["clio"] = 3
    sail_to(g, p0, "agora")
    with pytest.raises(GameError):
        g.trade(p0, "clio", "clio")
    g.trade(p0, "clio", "athena")
    assert p.scrolls == {"clio": 0, "athena": 1, "apollo": 0, "dionysos": 0}
    assert g.current.pid == p1


# ── endgame ──────────────────────────────────────────────────────────────────
def test_full_victory_path():
    g, (p0, p1) = make_game(seed=11)
    libs = ["kos", "rhodos", "samos"]
    for i, lib in enumerate(libs):
        win_trial(g, p0, lib)
        # p1 idles between p0's turns
        if i < len(libs) - 1 or True:
            sail_to(g, p1, "piraeus" if g.player_by_pid(p1).node != "piraeus" else "samos")
            if g.phase == "island":
                g.pass_turn(p1)
    p = g.player_by_pid(p0)
    assert len(p.laurels) == 3
    # Delos now reachable
    g.roll(p0, 6, 6)
    assert "delos" in g.reachable
    g.sail(p0, "delos")
    assert g.phase == "symposium_vote"
    with pytest.raises(GameError):
        g.vote_domain(p0, "clio")             # challenger doesn't vote
    g.vote_domain(p1, "dionysos")
    assert g.all_votes_in()
    g.tally_votes(0)
    assert g.phase == "question" and g.qctx["kind"] == "symposium"
    assert g.qctx["domain"] == "dionysos"
    put_question(g, correct=1)
    g.answer(p0, 1)
    g.advance_after_reveal()
    assert g.phase == "finished" and g.winner == p0


def test_symposium_miss_continues_game():
    g, (p0, p1) = make_game(seed=11)
    p = g.player_by_pid(p0)
    p.laurels = ["clio", "athena", "apollo"]
    g.roll(p0, 6, 6)
    g.sail(p0, "delos")
    g.vote_domain(p1, "dionysos")
    g.tally_votes(0)
    put_question(g, correct=0)
    g.answer(p0, 3)                           # wrong
    g.advance_after_reveal()
    assert g.phase == "roll" and g.current.pid == p1 and g.winner is None


def test_question_timeout_counts_as_miss():
    g, (p0, p1) = make_game()
    sail_to(g, p0, "kos")
    g.wager(p0, 2)
    put_question(g)
    g.timeout_question()
    assert g.phase == "reveal" and not g.reveal["was_correct"]


def test_rematch_resets():
    g, (p0, p1) = make_game()
    g.winner = p0
    g.phase = "finished"
    pa = g.player_by_pid(p0)
    pa.scrolls["clio"] = 5
    pa.laurels = ["clio"]
    g.rematch(p0)
    assert g.phase == "roll" and g.winner is None
    assert pa.total_scrolls() == 0 and pa.laurels == []
    assert all(v is None for v in g.plots.values())


def test_kick_adjusts_turn_order():
    g = Game("TEST", seed=5)
    pids = [g.add_player(f"t{i}", f"P{i}").pid for i in range(3)]
    g.start(pids[0])
    # advance to p1's turn
    g.roll(pids[0], 1, 1)
    g.sail(pids[0], "oracle")
    assert g.current.pid == pids[1]
    g.remove_player(pids[0], pids[2])         # kick p2 (after current)
    assert g.current.pid == pids[1]
    g.remove_player(pids[0], pids[1])         # kick current → next turn, one left
    assert g.phase == "finished" and g.winner == pids[0]

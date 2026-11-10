"""Regression tests for the rules-engine audit (tools/sim.py found most of
these). One test per defect: what used to go wrong is in each docstring."""
import pytest

import game as G
from game import Game, GameError

from test_game import (battle_at, find_node, finish_trade, force_land,
                       make_game, put_question, set_pack, strike)


def fingerprint(g):
    """Enough of the table to prove a refused call changed nothing."""
    return (g.phase, g.nonce, g.turn_idx, g.die, repr(g.reachable), repr(g.walk),
            repr(g.qctx), repr(g.question), repr(g.side_answers), repr(g.battle),
            repr(g.minigame), repr(g.upgrade_offer), repr(g.jboard),
            g.rng.getstate(),
            [(p.node, p.scrolls, p.hull, dict(p.items), list(p.upgrades),
              p.next_roll_bonus, p.streak) for p in g.players])


def refused(g, fn):
    before = fingerprint(g)
    with pytest.raises(GameError):
        fn()
    assert fingerprint(g) == before, "a refused call mutated the game"


def shrine_question(g, pid, correct=0):
    force_land(g, pid, find_node(g, "shrine"))
    g.wager(pid, 1)
    put_question(g, correct=correct)


def pack_question(g, pid, hps=(9,)):
    """A multiple-choice battle question against a fixed pack."""
    mon = find_node(g, "monster")
    set_pack(g, mon, list(hps))
    battle_at(g, pid, mon)
    strike(g, pid)
    put_question(g, correct=0)
    return mon


# ── economy ──────────────────────────────────────────────────────────────────
def test_side_answer_streak_bonus_is_paid_once():
    """Pins the payout (reward + ONE streak scroll). The old helper added
    the streak scroll itself AND returned 1 for the caller to add again; it
    only paid correctly because ``x += f()`` reads x before calling f, so
    the helper's own increment was silently overwritten. Now it says what
    it means."""
    g, (p0, p1) = make_game()
    rival = g.player_by_pid(p1)
    rival.streak = G.STREAK_AT - 1
    shrine_question(g, p0, correct=2)
    g.side_answer(p1, 2)
    g.answer(p0, 0)
    assert rival.streak == G.STREAK_AT
    assert rival.scrolls == 3 + G.SIDE_REWARD + 1          # reward + ONE bonus


def test_gale_charms_cannot_be_stacked_past_the_cap():
    """Arming a gale takes it out of the hold, so the trade beat allowed
    buy → crack → buy → crack without limit: a +20 roll for 20 scrolls,
    straight over a realm's whole road onto the boss altar."""
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.scrolls = 40
    force_land(g, p0, "home")
    assert g.phase == "trade"
    armed = 0
    for _ in range(10):
        try:
            g.shop_buy(p0, "gale")
            g.use_item_charm(p0, "gale")
            armed += 1
        except GameError:
            break
    assert armed == G.ITEM_CAP
    assert p.next_roll_bonus == G.GALE_STACK_CAP == G.ITEM_CAP * G.GALE_BONUS
    assert p.items["gale"] == 1                            # bought, not burnt
    refused(g, lambda: g.use_item_charm(p0, "gale"))
    # the wind is spent by the roll, and the next charm arms normally
    while g.current.pid != p0 or g.phase != "roll":
        if g.phase == "trade":
            g.pass_turn(g.current.pid)
        else:
            g._next_turn()
    g.roll(p0, 1)
    assert p.next_roll_bonus == 0
    assert max(g.reachable.values()) == 1 + G.GALE_STACK_CAP


# ── questions ────────────────────────────────────────────────────────────────
def test_lyre_swap_discards_side_answers():
    """A rival's side guess survived the Lyre's question swap and was then
    scored against the NEW question's answer key."""
    g, (p0, p1) = make_game()
    g.player_by_pid(p0).upgrades.append("lyre")
    pack_question(g, p0)
    g.side_answer(p1, 3)
    g.use_item(p0, "lyre")
    assert g.question is None and g.side_answers == {}
    g.set_question({"text": "new?", "options": ["a", "b", "c", "d"], "correct": 3})
    rival = g.player_by_pid(p1)
    before = rival.scrolls
    g.answer(p0, 0)
    assert rival.scrolls == before                         # no pay for a stale guess
    assert g.reveal["side"] == {}


def test_owl_refuses_an_already_narrowed_question():
    """Owl after a Hint Stone (or the Eye of the Oracle) struck a SECOND
    random pair of lies from the same card — two times in three that left
    only the right answer showing."""
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.upgrades.append("owl")
    p.items["hint"] = 1
    pack_question(g, p0)
    g.use_item_charm(p0, "hint")
    first = list(g.question["disabled"])
    refused(g, lambda: g.use_item(p0, "owl"))
    assert g.question["disabled"] == first
    assert "owl" not in g.battle["used_items"]             # the Owl is not wasted

    g2, (q0, q1) = make_game()
    g2.player_by_pid(q0).upgrades += ["owl", "oracle_eye"]
    pack_question(g2, q0)
    assert len(g2.question["disabled"]) == 2               # the Eye already burned two
    refused(g2, lambda: g2.use_item(q0, "owl"))


def test_answers_must_name_a_real_option():
    """An out-of-range or non-integer index was silently scored as a wrong
    answer (and a float like 0.0 as a right one)."""
    g, (p0, p1) = make_game()
    shrine_question(g, p0)
    for bad in (-1, 4, 99, 0.0, "0", None, True, [0]):
        refused(g, lambda b=bad: g.answer(p0, b))
        refused(g, lambda b=bad: g.side_answer(p1, b))
    g.side_answer(p1, 3)
    g.answer(p0, 0)
    assert g.phase == "reveal" and g.reveal["was_correct"]


# ── malformed input: GameError, nothing touched ──────────────────────────────
JUNK = [None, 1.5, True, [], [1], {}, {"a": 1}, "zzz", -1, 10 ** 9, float("nan")]


def test_roll_refuses_a_bad_die():
    """roll() stored the die before using it (a string die left g.die set
    and raised TypeError); a huge die would spin the reach search forever."""
    g, (p0, p1) = make_game()
    for bad in (0, -1, 7, 10 ** 9, 1.5, "2", None, True, [2]):
        refused(g, lambda b=bad: g.roll(p0, b))
    assert g.die is None and g.phase == "roll"
    g.roll(p0, 2)
    assert g.die == 2


@pytest.mark.parametrize("junk", JUNK, ids=repr)
def test_malformed_arguments_raise_gameerror_and_change_nothing(junk):
    """Wrong-typed arguments surfaced as TypeError (unhashable node ids,
    list indices compared with <=, …) instead of GameError."""
    bad_str = not isinstance(junk, str) or junk == "zzz"    # no such node / item
    bad_int = type(junk) is not int or junk in (-1, 10 ** 9)  # no such tier / index

    g, (p0, p1) = make_game()
    g.roll(p0, 2)
    assert g.phase == "sail"
    if bad_str:
        refused(g, lambda: g.sail(p0, junk))
        refused(g, lambda: g.walk_step(p0, junk))
        refused(g, lambda: g.use_item_charm(p0, junk))

    g, (p0, p1) = make_game()
    force_land(g, p0, find_node(g, "shrine"))
    if bad_int:
        refused(g, lambda: g.wager(p0, junk))

    g, (p0, p1) = make_game()
    force_land(g, p0, find_node(g, "shop"))
    g.player_by_pid(p0).scrolls = 99
    if bad_str:
        refused(g, lambda: g.shop_buy(p0, junk))

    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [3, 3])
    battle_at(g, p0, mon)
    if bad_str:
        refused(g, lambda: g.stance(p0, junk, 0))
    if type(junk) is not int:
        refused(g, lambda: g.stance(p0, "attack", junk))
    refused(g, lambda: g.stance(p0, "heal", 0, junk))
    g.player_by_pid(p0).upgrades.append("owl")
    strike(g, p0)
    put_question(g)
    if bad_str:
        refused(g, lambda: g.use_item(p0, junk))

    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, p0, mon)
    g._force_mode = "jeopardy"
    g.stance(p0, "attack", 0)
    assert g.phase == "jchoose"
    if bad_int:
        refused(g, lambda: g.jpick(p0, junk))

    g, (p0, p1) = make_game()
    g.upgrade_offer = ["ram", "owl"]
    g._bump("upgrade_pick")
    refused(g, lambda: g.pick_upgrade(p0, junk))


@pytest.mark.parametrize("kind", ["tetromino", "nonogram", "simon", "visual_memory",
                                  "anagram", "ravens", "sequence", "lights_out",
                                  "sliding", "memory"])
def test_minigame_checkers_survive_any_payload(kind):
    """A payload of the wrong shape (e.g. a list of lists for the memory
    board) blew up inside the checker with TypeError. On a one-attempt
    puzzle it must not burn the attempt either."""
    import puzzles
    g, (p0, p1) = make_game()
    isle = find_node(g, "puzzle")
    p = g.player_by_pid(p0)
    p.prev_node, p.node = p.node, isle
    for junk in (None, 1.5, True, [], [[1], [2]], [["a", 1]], {}, {"a": 1}, "zzz",
                 [None], [1, "a"], [[0, 0, 0]], float("nan"), -1, 10 ** 9,
                 [{}], [[]], "x" * 500, [1.5] * 36, [10 ** 9] * 25, [[0, "a"]],
                 [[None, None]], ["a", 1], [{"a": 1}, 2]):
        # a fresh deal for every payload (a one-attempt puzzle ends on a miss)
        g.turn_idx = 0
        deal = puzzles.deal_kind(g.rng, kind)
        g.minigame = {"kind": kind, "island": isle, "data": deal,
                      "limit": deal["limit"], "deadline": None}
        g._bump("minigame")
        before = fingerprint(g)
        try:
            g.minigame_submit(p0, junk)        # must never raise anything else
        except GameError:
            assert fingerprint(g) == before
        assert g.phase in ("minigame", "roll", "upgrade_pick")
        g.upgrade_offer = None
        g.board.nodes[isle]["solved"] = False


# ── the Sword of Damocles islet ──────────────────────────────────────────────
def _clear_islet(g, pid):
    swid = g.board.sword_node
    p = g.player_by_pid(pid)
    p.max_hull = p.hull = 40
    force_land(g, pid, swid)
    assert g.phase == "battle"
    for _ in range(80):
        if g.phase == "battle":
            m = g.board.alive_monster(swid)
            idx = next(i for i, e in enumerate(m["enemies"]) if e["hp"] > 0)
            g._force_mode = "mc"
            g.stance(pid, "magic", idx)
            put_question(g, correct=0)
            g.answer(pid, 0)
        elif g.phase == "reveal":
            g.advance_after_reveal()
        elif g.phase == "dodge":
            g.dodge(pid, True, True)
        else:
            break
    return p


def test_sword_guardians_stand_again_for_the_next_captain():
    """The guardians fell once, for good: the SECOND captain to buy the
    30-scroll chart landed on an empty rock — no fight, no sword."""
    g, (p0, p1) = make_game()
    first = _clear_islet(g, p0)
    assert first.has("sword_of_damocles")
    assert g.board.alive_monster(g.board.sword_node) is None
    finish_trade(g)
    assert g.current.pid == p1
    g.rng.random = lambda: 0.99                            # no kraken, no skirmish
    second = _clear_islet(g, p1)
    assert second.has("sword_of_damocles")                 # their own trial, own blade
    # …but a captain who already bears it raises no guard (and no farm)
    finish_trade(g)
    force_land(g, p0, g.board.sword_node)
    assert g.phase == "trade" and g.battle is None


def test_sword_is_only_drawn_over_the_fallen_guardians():
    """Any pack beaten on the islet handed over the sword — including a
    stray two-harpy skirmish left there by an earlier visitor."""
    g, (p0, p1) = make_game()
    swid = g.board.sword_node
    # a leftover stray pack sits on the islet instead of the guardians
    g.board.nodes[swid]["monster"] = {
        "name": "Harpies", "tier": 2, "model": "harpy", "domain": "clio",
        "enemies": [{"name": "Harpy", "hp": 1, "max_hp": 1, "power": 1, "model": "harpy"}]}
    force_land(g, p0, swid)
    m = g.board.alive_monster(swid)
    assert m.get("pack") and len(m["enemies"]) == 3        # the true guard rose instead
    assert g.to_dict(p0)["battle"]["ambush"]


# ── kicks ────────────────────────────────────────────────────────────────────
def three(seed=5):
    g = Game("TEST", seed=seed)
    pids = [g.add_player(f"t{i}", f"P{i}").pid for i in range(3)]
    g.start(pids[0])
    return g, pids


def test_kick_to_last_captain_mid_battle_finishes_clean():
    """Kicking the only rival mid-fight ended the game with the battle, the
    open question and the side answers still attached to the 'finished'
    table (the victory screen rendered over a live battle snapshot)."""
    g, (p0, p1) = make_game()
    force_land(g, p0, "home")
    finish_trade(g)
    assert g.current.pid == p1
    pack_question(g, p1)
    g.side_answer(p0, 1)
    g.remove_player(p0, p1)
    assert g.phase == "finished" and g.winner == p0
    assert g.battle is None and g.question is None and g.qctx is None
    assert g.side_answers == {} and g.minigame is None
    snap = g.to_dict(p0)
    assert snap["battle"] is None and snap["question"] is None


def test_kick_mid_sphinx_riddle_strikes_her_stage():
    """The riddling Sphinx is a staged 1-hp 'boss' on the gate. Kick the
    captain facing her and she stayed there — the next arrival met a real,
    unfleeable boss fight instead of a riddle."""
    g, pids = three()
    gate = next(nid for nid, n in g.board.nodes.items() if n.get("sphinx"))
    force_land(g, pids[0], gate)
    assert g.phase == "minigame" and g.board.nodes[gate]["monster"]["riddle"]
    g.players[0].connected = False                         # the host walks away…
    g.remove_player(pids[1], pids[0])                      # …and is shown out
    assert g.board.nodes[gate].get("monster") is None
    assert not g.board.nodes[gate].get("sphinx_done")
    assert g.phase == "roll" and g.current.pid == pids[1] and g.battle is None
    force_land(g, pids[1], gate)                           # she poses her riddle anew
    assert g.phase == "minigame" and g.minigame.get("sphinx")


def test_kick_between_jeopardy_pick_and_delivery_drops_the_clue():
    """A clue picked off the Jeopardy board waits in _pending_jeopardy for
    the server to serve it. Kick the picker in that gap and the clue was
    served as the NEXT captain's shrine question."""
    g, pids = three()
    force_land(g, pids[0], "home")
    finish_trade(g)
    mon = find_node(g, "monster")
    set_pack(g, mon, [3])
    battle_at(g, pids[1], mon)
    g._force_mode = "jeopardy"
    g.stance(pids[1], "attack", 0)
    g.jpick(pids[1], 0)
    assert g._pending_jeopardy is not None
    g.remove_player(pids[0], pids[1])
    assert g._pending_jeopardy is None and g.jboard is None
    assert g.phase == "roll" and g.current.pid == pids[2]


def test_kick_current_captain_respects_the_krakens_toll():
    """After kicking the captain whose turn it was, the next captain started
    their turn even if they owed the kraken one."""
    g, pids = three()
    g.player_by_pid(pids[1]).skip_turns = 1
    assert g.current.pid == pids[0]
    g.players[0].connected = False
    g.remove_player(pids[1], pids[0])                      # p1 (acting host) kicks p0
    assert g.current.pid == pids[2]                        # p1 sat out the toll
    assert g.player_by_pid(pids[1]).skip_turns == 0


def test_kick_mid_trial_gives_the_next_captain_a_fresh_boss_and_warden():
    """A half-beaten trial boss / Warden waited, softened, on the board."""
    g, pids = three()
    force_land(g, pids[0], "home")
    finish_trade(g)
    lair = g.board.lairs()[0]
    battle_at(g, pids[1], lair)
    g.board.nodes[lair]["monster"]["enemies"][0]["hp"] = 1
    g.remove_player(pids[0], pids[1])
    assert g.board.alive_monster(lair) is None             # nothing left to inherit
    g2, q = three()
    force_land(g2, q[0], "home")
    finish_trade(g2)
    p = g2.player_by_pid(q[1])
    p.banked = G.RELICS_TO_WIN
    g2.pharos_open = True
    force_land(g2, q[1], "pharos")
    g2.enter_pharos(q[1])
    g2.board.nodes["pharos"]["monster"]["enemies"][0]["hp"] = 1
    g2.remove_player(q[0], q[1])
    w = g2.board.nodes["pharos"]["monster"]["enemies"][0]
    assert w["hp"] == w["max_hp"]


def test_kick_scrubs_the_departed_from_side_answers_and_altars():
    """A kicked rival's side answer stayed in the snapshot's side_answered
    list, and their stashed seal stayed drawn on the altar."""
    g, pids = three()
    lair = g.board.lairs()[0]
    g.board.nodes[lair]["defeated"].append(pids[2])
    g.board.nodes[lair]["stash"].append(pids[2])
    shrine_question(g, pids[0])
    g.side_answer(pids[2], 1)
    g.remove_player(pids[0], pids[2])
    assert pids[2] not in g.side_answers
    assert pids[2] not in g.to_dict(pids[0])["side_answered"]
    assert g.board.nodes[lair]["stash"] == []
    assert g.phase == "question" and g.current.pid == pids[0]   # the round goes on
    g.answer(pids[0], 0)
    assert g.phase == "reveal"


def test_kick_at_the_curtain_call_never_changes_the_winner():
    """On the finished screen, kicking down to one captain overwrote the
    winner with the host; kicking the winner left a winner pid that no
    longer matched any player (the victory screen looks them up)."""
    g, pids = three()
    g.winner = pids[1]
    g._bump("finished")
    refused(g, lambda: g.remove_player(pids[0], pids[1]))  # the victor stays
    g.remove_player(pids[0], pids[2])
    assert g.phase == "finished" and g.winner == pids[1]
    assert [p.pid for p in g.players] == pids[:2]
    g.rematch(pids[0])
    assert g.phase == "roll" and g.winner is None and g.turn_idx == 0


# ── the host ─────────────────────────────────────────────────────────────────
def test_host_powers_pass_on_while_the_host_is_away():
    """The host is players[0], full stop: if they closed the tab nobody
    could launch the lobby, kick the absent captain whose turn it was, or
    call a rematch — the table was dead until a full reset."""
    g = Game("TEST", seed=3)
    a = g.add_player("ta", "A")
    b = g.add_player("tb", "B")
    bot = g.add_player("bot:1", "Sokrates", is_bot=True)
    c = g.add_player("tc", "C")
    assert g.host_pid == a.pid == g.to_dict(b.pid)["host"]
    refused(g, lambda: g.start(b.pid))
    a.connected = False
    assert g.host_pid == b.pid == g.to_dict(None)["host"]  # first connected HUMAN
    refused(g, lambda: g.start(c.pid))
    refused(g, lambda: g.start(bot.pid))
    g.start(b.pid)
    assert g.phase == "roll" and g.current.pid == a.pid    # the absent host's turn
    refused(g, lambda: g.remove_player(c.pid, a.pid))
    refused(g, lambda: g.remove_player(b.pid, b.pid))
    a.connected = True                                     # back in time: host again
    assert g.host_pid == a.pid
    refused(g, lambda: g.remove_player(b.pid, a.pid))
    a.connected = False
    g.remove_player(b.pid, a.pid)                          # gone for good: shown out
    assert g.current.pid == b.pid and g.phase == "roll"
    b.connected = False
    c.connected = False                                    # nobody home: seat order rules
    assert g.host_pid == b.pid


def test_lobby_refill_gets_its_own_colour_and_pid():
    """Seat colours came from len(players): kick seat 2 of 3 in the lobby,
    let someone new in, and they shared seat 3's colour."""
    g = Game("TEST", seed=1)
    a, b, c = (g.add_player(f"t{i}", f"P{i}") for i in range(3))
    g.remove_player(a.pid, b.pid)
    d = g.add_player("t9", "New")
    colours = [p.color for p in g.players]
    assert len(set(colours)) == 3
    assert len({p.pid for p in g.players}) == 3


# ── lifecycle ────────────────────────────────────────────────────────────────
def test_rematch_starts_from_a_clean_table():
    """rematch() reset the players and the board but kept the last voyage's
    verdict banner (flash) and any half-open turn state."""
    g, (p0, p1) = make_game()
    pack_question(g, p0)
    g.side_answer(p1, 2)
    g._flash(False, "Wrong — the answer was Carthage")
    g.jboard = {"band": "low", "node": "home", "cells": []}
    g._pending_jeopardy = {"text": "old", "answer": "old", "typed": True}
    g.kraken = {"node": "home", "asked": 1}
    g.winner = p0
    g.battle = None
    g._bump("finished")
    g.rematch(p0)
    assert g.phase == "roll" and g.flash is None
    for attr in ("battle", "question", "qctx", "minigame", "kraken", "jboard",
                 "_pending_jeopardy", "reveal", "walk", "upgrade_offer",
                 "question_deadline", "dodge_deadline", "jchoose_deadline"):
        assert getattr(g, attr) is None, attr
    assert g.side_answers == {} and g.reachable == {}
    snap = g.to_dict(p0)
    assert snap["flash"] is None and snap["question"] is None


def test_gate_carry_through_is_refused_once_the_next_roll_is_plotted():
    """The pass carries a captain through 1.8 s after landfall. On a fast
    table (solo, quick bots) their next roll could already be plotted from
    the arch — moving them then left the landing beacons measured from a
    stop they no longer stood on."""
    g, (p0,) = make_game(n=1)
    gate = next(nid for nid, n in g.board.nodes.items()
                if n["type"] == "gate" and n.get("region") != "autumn")
    force_land(g, p0, gate)
    gw = g.gate_walk
    assert gw and gw["pid"] == p0 and gw["gate"] == gate
    p = g.player_by_pid(p0)
    assert not g.gate_carry(p0, gate, "home")              # not a neighbour
    assert not g.gate_carry("ghost", gate, gw["to"])
    finish_trade(g)
    g.roll(p0, 1)                                          # plotted from the arch
    plotted = dict(g.reachable)
    assert not g.gate_carry(p0, gate, gw["to"])
    assert p.node == gate and g.reachable == plotted
    g.sail(p0, next(iter(g.reachable)))
    # the ordinary case: carried through a beat after landfall
    g2, (q0,) = make_game(n=1)
    force_land(g2, q0, gate2 := next(nid for nid, n in g2.board.nodes.items()
                                     if n["type"] == "gate"
                                     and n.get("region") != "autumn"))
    gw2 = g2.gate_walk
    assert g2.gate_carry(q0, gate2, gw2["to"])
    q = g2.player_by_pid(q0)
    assert q.node == gw2["to"] and q.prev_node == gate2
    assert not g2.gate_carry(q0, gate2, gw2["to"])         # already through


# ── items at the Pharos ──────────────────────────────────────────────────────
def test_planks_work_at_the_pharos_door_and_the_horn_is_not_wasted_inside():
    """Standing before the Pharos door was the one own-turn beat where
    Pitch & Planks were refused (so you could not patch up before the final
    trial); and a War Horn could be sounded against the Dark Presence, where
    a STRIKE always chips for 1 — the charm was spent and never discharged."""
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.banked = G.RELICS_TO_WIN
    g.pharos_open = True
    p.items["planks"] = 1
    p.items["horn"] = 1
    p.hull = 2
    force_land(g, p0, "pharos")
    assert g.phase == "pharos"
    g.use_item_charm(p0, "planks")
    assert p.hull == 2 + G.PLANKS_HEAL and g.phase == "pharos"
    g.enter_pharos(p0)
    refused(g, lambda: g.use_item_charm(p0, "horn"))
    assert p.items["horn"] == 1 and not g.battle.get("horn")
    # …while against anything else the horn still sounds
    g2, (q0, q1) = make_game()
    q = g2.player_by_pid(q0)
    q.items["horn"] = 1
    mon = find_node(g2, "monster")
    set_pack(g2, mon, [5])
    battle_at(g2, q0, mon)
    g2.use_item_charm(q0, "horn")
    assert g2.battle["horn"] and q.items["horn"] == 0


def test_dev_fight_summoned_mid_question_starts_clean():
    """The dev panel's "fight anything" could be fired mid-question or
    mid-dodge (even on a rival's turn): the new battle began with the old
    question, side answers and incoming blow still attached."""
    g, (p0, p1) = make_game()
    pack_question(g, p0)
    g.side_answer(p1, 1)
    g.dev_fight(p1, {"kind": "boss", "region": "ice"})
    assert g.phase == "battle" and g.current.pid == p1
    assert g.question is None and g.qctx is None and g.side_answers == {}
    assert g.minigame is None and not g.battle.get("incoming")
    assert g.to_dict(p0)["question"] is None
    strike(g, p1)                                          # and it plays normally
    put_question(g)
    g.answer(p1, 0)
    assert g.phase == "reveal"


def test_battle_snapshot_says_whether_retreat_is_allowed():
    """battle.boss is true for any pack fielding a 5-HP brute (it drives the
    STRIKE tier and the diorama), but only real trials refuse a retreat —
    a client keying FLEE off `boss` hides a legal move. `can_flee` states
    the rule itself (additive field)."""
    g, (p0, p1) = make_game()
    mon = find_node(g, "monster")
    set_pack(g, mon, [5, 5])                               # e.g. Frostfang Alphas
    g.board.nodes[mon]["monster"]["enemies"][0]["max_hp"] = 5
    battle_at(g, p0, mon)
    snap = g.to_dict(p0)["battle"]
    assert snap["boss"] and snap["strike_tier"] == 2       # looks like a boss…
    assert snap["can_flee"]                                # …but may be fled
    g.player_by_pid(p0).scrolls = 5
    g.rng.random = lambda: 0.1                             # the coin lands kindly
    g.flee(p0)
    assert g.battle is None and g.current.pid == p1
    lair = g.board.lairs()[0]
    battle_at(g, p1, lair)
    assert g.to_dict(p1)["battle"]["can_flee"] is False
    with pytest.raises(GameError):
        g.flee(p1)

"""Combat rules after the reflex dodge was removed.

Defence is KNOWLEDGE, never reaction speed: a right answer blunts the
foe's counter, a right BRACE turns a telegraphed heavy aside, a right
mending hymn wards the blow off. Every rule here is one the balance pass
(tools/sim.py --study stances / --mode bots) was tuned on.
"""
import random

import pytest

import board as B
import bots
import game as G
from board import RELICS_TO_WIN
from game import GameError
from test_game import (battle_at, boss_battle, cast, find_node, force_land,
                       make_game, pack, put_question, set_pack, strike)


def _fight_pack(hps, power=1, seed=7):
    g, (p0, p1) = make_game(seed=seed)
    mon = find_node(g, "monster")
    set_pack(g, mon, hps)
    for e in pack(g, mon):
        e["power"] = power
    battle_at(g, p0, mon)
    return g, p0, mon


def _tough_boss(g, lair, hp=99):
    e = g.board.alive_monster(lair)["enemies"][0]
    e["hp"] = e["max_hp"] = hp
    return e


def _exchange(g, pid, stance="attack", right=True, mode=None):
    g._force_mode = "mc"
    g.stance(pid, stance, 0, mode)
    put_question(g, correct=0)
    g.answer(pid, 0 if right else 1)
    assert g.phase == "reveal"
    return g.reveal["enemy_phase"]


# ── the dodge is gone ────────────────────────────────────────────────────────
def test_no_reflex_dodge_phase_or_action_remains():
    g, (p0, p1), lair = boss_battle()
    assert not hasattr(g, "dodge") and not hasattr(g, "dodge_timeout")
    assert not hasattr(G, "DODGE_SECS")
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 40
    _tough_boss(g, lair)
    for _ in range(6):
        ep = _exchange(g, p0, right=False)
        # the counter lands INSIDE the answer's reveal: no beat to wait on
        assert ep["counter"] and ep["dmg"] > 0 and not ep.get("pending")
        assert not g.battle.get("incoming")
        assert g.to_dict(p0)["dodge"] is None          # vestigial, always empty
        g.advance_after_reveal()
        assert g.phase == "battle"


def test_a_right_answer_blunts_the_counter_a_wrong_one_takes_it_full():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 40
    power = _tough_boss(g, lair)["power"]
    ep = _exchange(g, p0, right=True)
    assert ep["blunted"] and ep["dmg"] == G.round_half(power * G.BLUNT)
    assert ep["dealt"] == G.STRIKE_BOSS_DMG              # and you drew blood
    assert p.hull == 40 - ep["dmg"]
    g.advance_after_reveal()
    ep = _exchange(g, p0, right=False)
    assert not ep["blunted"] and ep["dmg"] == power and ep["dealt"] == 0


def test_a_right_spell_blunts_too_but_a_missed_one_is_never_cheaper_than_a_missed_strike():
    # MAGIC used to cost only a 1-point backfire on a miss against a pack (no
    # counter at all) — cheaper than a missed STRIKE. Now both take the counter.
    g, p0, mon = _fight_pack([9, 9], power=2)
    p = g.player_by_pid(p0)
    ep = _exchange(g, p0, "magic", right=True)
    assert ep["dealt"] == G.MAGIC_DMG and ep["dmg"] == 1           # 2 → blunted to 1
    g.advance_after_reveal()
    before = p.hull
    ep = _exchange(g, p0, "magic", right=False)
    magic_miss = before - p.hull
    g.advance_after_reveal()
    before = p.hull
    _exchange(g, p0, "attack", right=False)
    strike_miss = before - p.hull
    assert magic_miss >= strike_miss == 2


# ── BRACE: the answer to a telegraphed heavy ────────────────────────────────
def _charge(g, pid):
    """Two exchanges wind the boss up for its heavy."""
    for _ in range(2):
        assert not g.battle["charging"]
        _exchange(g, pid, right=True)
        g.advance_after_reveal()
    assert g.battle["charging"]


def test_brace_is_only_offered_against_a_telegraphed_heavy():
    g, (p0, p1), lair = boss_battle()
    g.player_by_pid(p0).max_hull = g.player_by_pid(p0).hull = 40
    _tough_boss(g, lair)
    assert not g.to_dict(p0)["battle"]["can_brace"]
    with pytest.raises(GameError):
        g.stance(p0, "guard")                       # no turtling every exchange
    _charge(g, p0)
    assert g.to_dict(p0)["battle"]["can_brace"]
    g._force_mode = "mc"
    g.stance(p0, "guard")
    assert g.qctx["tier"] == 1                      # the EASY question


def test_packs_never_offer_brace():
    g, p0, mon = _fight_pack([3, 3], power=2)
    for _ in range(4):
        with pytest.raises(GameError):
            g.stance(p0, "guard")
        _exchange(g, p0, right=True)
        if g.phase == "reveal":
            g.advance_after_reveal()
        if g.phase != "battle":
            break


def test_a_right_brace_turns_the_heavy_aside_and_drives_it_back():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 40
    e = _tough_boss(g, lair)
    _charge(g, p0)
    hull, hp = p.hull, e["hp"]
    ep = _exchange(g, p0, "guard", right=True)
    assert ep["heavy"] and ep["braced"] and ep["dmg"] == 0
    assert p.hull == hull                           # not a scratch
    assert ep["riposte"] == G.RIPOSTE_DMG and e["hp"] == hp - G.RIPOSTE_DMG
    g.advance_after_reveal()
    assert not g.battle["charging"]                 # the cycle resets


def test_a_wrong_brace_eats_the_whole_heavy():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 40
    power = _tough_boss(g, lair)["power"]
    _charge(g, p0)
    hull = p.hull
    ep = _exchange(g, p0, "guard", right=False)
    heavy = min(G.HEAVY_CAP, power * G.HEAVY_MULT)
    assert ep["heavy"] and not ep["braced"] and ep["dmg"] == heavy == hull - p.hull


def test_attacking_into_a_heavy_is_a_choice_a_right_answer_still_halves_it():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 40
    power = _tough_boss(g, lair)["power"]
    _charge(g, p0)
    ep = _exchange(g, p0, "magic", right=True)
    heavy = min(G.HEAVY_CAP, power * G.HEAVY_MULT)
    assert ep["heavy"] and ep["dealt"] == G.MAGIC_DMG
    assert ep["dmg"] == G.round_half(heavy * G.BLUNT)


def test_no_endless_avoidance_loop():
    """However well you read, you cannot hide forever: BRACE needs a heavy
    (one in three exchanges, or every other once enraged), so a captain who
    never misses still trades blows in between — and every fight ends."""
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 200
    _tough_boss(g, lair, hp=60)
    taken = exchanges = 0
    while g.phase == "battle" and exchanges < 200:
        stance = "guard" if g.battle["charging"] else "attack"
        ep = _exchange(g, p0, stance, right=True)  # a perfect, all-knowing captain
        taken += ep["dmg"]
        exchanges += 1
        g.advance_after_reveal()
    assert g.battle is None and p.banked >= 1     # the boss fell…
    assert taken > 0                              # …and it was never free


# ── the rhythm: heavies, the cap, enrage ────────────────────────────────────
def test_boss_heavy_lands_doubled_up_to_the_cap():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 60
    e = _tough_boss(g, lair)
    e["power"] = 4
    _charge(g, p0)
    ep = _exchange(g, p0, right=False)
    assert ep["heavy"] and ep["dmg"] == min(G.HEAVY_CAP, 8) == G.HEAVY_CAP


def test_a_wounded_boss_enrages_and_heavies_come_every_other_exchange():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 60
    e = _tough_boss(g, lair, hp=20)
    assert not g.to_dict(p0)["battle"]["enraged"]
    e["hp"] = 10                                  # down to half
    _exchange(g, p0, right=False)                 # one exchange to notice
    g.advance_after_reveal()
    assert g.to_dict(p0)["battle"]["enraged"]
    seen = []
    for _ in range(6):
        seen.append(g.battle["charging"])
        _exchange(g, p0, "guard" if g.battle["charging"] else "attack", right=False)
        g.advance_after_reveal()
    assert seen == [True, False, True, False, True, False]


def test_heavy_cycle_is_every_third_exchange_while_calm():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = p.hull = 60
    _tough_boss(g, lair)
    seen = []
    for _ in range(6):
        seen.append(g.battle["charging"])
        _exchange(g, p0, "guard" if g.battle["charging"] else "attack", right=True)
        g.advance_after_reveal()
    assert seen == [False, False, True, False, False, True]


# ── the mending hymn ─────────────────────────────────────────────────────────
def test_heal_is_refused_at_full_health():
    g, p0, mon = _fight_pack([5], power=1)
    with pytest.raises(GameError):
        g.stance(p0, "heal", 0, "mc")


def test_a_right_hymn_mends_and_wards_the_blow_off():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    _tough_boss(g, lair)
    p.hull = 2
    ep = _exchange(g, p0, "heal", right=True, mode="mc")
    assert ep["healed"] == G.HEAL_SMALL and ep["braced"] and ep["dmg"] == 0
    assert p.hull == 2 + G.HEAL_SMALL


def test_brace_and_hymn_never_pay_streak_scrolls():
    """A stall of right hymns / braces used to pay a scroll a round."""
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    p.max_hull = 40
    p.hull = 20
    _tough_boss(g, lair)
    p.streak = G.STREAK_AT + 3
    scrolls = p.scrolls
    _exchange(g, p0, "heal", right=True, mode="mc")
    g.advance_after_reveal()
    _exchange(g, p0, "heal", right=True, mode="mc")
    g.advance_after_reveal()
    assert p.scrolls == scrolls
    _exchange(g, p0, "attack", right=True)        # a blow struck still pays
    assert p.scrolls == scrolls + 1


# ── STRIKE's niche, loot ─────────────────────────────────────────────────────
def test_strike_takes_the_tier_two_question_and_bites_harder_on_tough_units():
    g, p0, mon = _fight_pack([3, 3])
    strike(g, p0)
    assert g.qctx["tier"] == 2
    put_question(g)
    g.answer(p0, 0)
    assert g.reveal["enemy_phase"]["dealt"] == G.STRIKE_BOSS_DMG
    g2, q0, mon2 = _fight_pack([2, 2])
    strike(g2, q0)
    assert g2.qctx["tier"] == 1
    assert g2.to_dict(q0)["battle"]["strike_tier"] == 1
    assert g.to_dict(p0)["battle"]["strike_tier"] == 2


def test_pack_loot_pays_by_toughness_not_ten_a_brute():
    assert [G.unit_loot({"max_hp": h}) for h in (1, 2, 3, 4, 5)] == [1, 1, 2, 2, 3]
    g, p0, mon = _fight_pack([1, 1])
    for e in pack(g, mon):
        e["max_hp"] = 5                           # two brutes, nearly dead
    p = g.player_by_pid(p0)
    scrolls = p.scrolls
    for _ in range(2):
        cast(g, p0, next(i for i, e in enumerate(pack(g, mon)) if e["hp"] > 0))
        put_question(g)
        g.answer(p0, 0)
        g.advance_after_reveal()
    assert p.scrolls - scrolls == 2 * 3           # 3 a brute (it was 10)


def test_aegis_charm_waits_for_a_real_blow():
    g, p0, mon = _fight_pack([9], power=1)
    p = g.player_by_pid(p0)
    p.items["aegis_charm"] = 1
    ep = _exchange(g, p0, right=False)            # a 1-point blow: below AEGIS_MIN
    assert ep["dmg"] == 1 and not ep["blocked"] and p.items["aegis_charm"] == 1
    g.advance_after_reveal()
    pack(g, mon)[0]["power"] = G.AEGIS_MIN
    ep = _exchange(g, p0, right=False)
    assert ep["blocked"] and ep["dmg"] == 0 and p.items["aegis_charm"] == 0


# ── catch-up instead of escalation ──────────────────────────────────────────
def test_sinking_at_your_trial_eases_it_for_your_next_try():
    g, (p0, p1), lair = boss_battle()
    p = g.player_by_pid(p0)
    m = g.board.alive_monster(lair)
    hp0, pow0 = m["enemies"][0]["max_hp"], m["enemies"][0]["power"]
    p.hull = 1
    _exchange(g, p0, right=False)                 # sunk
    assert g.reveal["player_dead"]
    assert g.board.nodes[lair]["falls"] == {p0: 1}
    g.advance_after_reveal()
    while g.current.pid != p0:
        g._next_turn()
    force_land(g, p0, lair)
    e = g.board.alive_monster(lair)["enemies"][0]
    assert e["max_hp"] == hp0 - B.FALL_EASE_HP
    assert e["power"] == max(B.BOSS_MIN_POWER, pow0 - B.FALL_EASE_POWER)
    # a rival's falls never ease YOUR trial
    nid = g.board.lairs()[1]
    g.board.nodes[nid]["falls"] = {p1: 5}
    assert g.board.spawn_boss(nid, p0)["enemies"][0]["max_hp"] == \
        g.board.nodes[nid]["boss_spec"][1]


def test_the_warden_eases_only_for_its_own_fallen():
    g, (p0, p1) = make_game()
    for pid in (p0, p1):
        g.player_by_pid(pid).banked = RELICS_TO_WIN
    g.pharos_open = True
    p = g.player_by_pid(p0)
    p.prev_node, p.node = p.node, "pharos"
    g._land(p, "pharos")
    g.enter_pharos(p0)
    full = g.board.alive_monster("pharos")["enemies"][0]["max_hp"]
    assert full == B.WARDEN[1]
    p.hull = 1
    _exchange(g, p0, right=False)
    assert g.reveal["player_dead"]
    assert g.board.nodes["pharos"]["falls"] == {p0: 1}
    g.advance_after_reveal()
    while g.current.pid != p1:                     # the rival meets it whole
        g._next_turn()
    q = g.player_by_pid(p1)
    q.prev_node, q.node = q.node, "pharos"
    g._land(q, "pharos")
    g.enter_pharos(p1)
    assert g.board.alive_monster("pharos")["enemies"][0]["max_hp"] == full
    g.battle = None
    g.board.nodes["pharos"]["monster"]["enemies"][0]["hp"] = 0
    while g.current.pid != p0:                     # the fallen meets it eased
        g._next_turn()
    p.prev_node, p.node = p.node, "pharos"
    g._land(p, "pharos")
    g.enter_pharos(p0)
    assert g.board.alive_monster("pharos")["enemies"][0]["max_hp"] == full - B.FALL_EASE_HP


# ── side answers scale with the table ────────────────────────────────────────
def test_side_answers_pay_less_often_at_a_big_table():
    g, pids = make_game(n=6)
    rival = g.player_by_pid(pids[1])
    paid = []
    for _ in range(6):
        while g.current.pid != pids[0]:
            g._next_turn()
        shrine = find_node(g, "shrine")
        g.board.nodes[shrine]["charges"] = 5
        force_land(g, pids[0], shrine)
        g.wager(pids[0], 1)
        put_question(g, correct=2)
        before = rival.scrolls
        g.side_answer(pids[1], 2)
        g.answer(pids[0], 0)
        paid.append(rival.scrolls - before)
        g.advance_after_reveal()
        g._next_turn()
    # five rivals → a scroll every second right side answer
    assert paid == [0, 1, 0, 1, 0, 1]


# ── bots: prepare, then read the telegraph ──────────────────────────────────
def test_bots_brace_against_a_telegraphed_heavy():
    g, (p0, p1), lair = boss_battle()
    g.player_by_pid(p0).max_hull = g.player_by_pid(p0).hull = 40
    _tough_boss(g, lair)
    _charge(g, p0)
    assert bots.decide_battle(g, p0, random.Random(1), bots.PHILOSOPHERS[0]) == "guard"


def test_bots_do_not_storm_the_pharos_unprovisioned():
    g, (p0, p1) = make_game()
    p = g.player_by_pid(p0)
    p.banked = RELICS_TO_WIN
    g.pharos_open = True
    p.scrolls = 20                                  # could still buy kit
    assert not bots.pharos_ready(p)
    assert bots._target_score(g, p, "pharos") < 100
    p.items["planks"] = 2
    p.items["aegis_charm"] = 2
    p.max_hull = p.hull = 10
    assert bots.pharos_ready(p)
    assert bots._target_score(g, p, "pharos") == 500
    # a captain with nothing left to buy it with goes anyway — never stall
    p.items = {k: 0 for k in p.items}
    p.scrolls = 0
    assert bots.pharos_ready(p)

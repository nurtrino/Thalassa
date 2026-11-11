"""Events: the framework (events.py), the content tables (event_data.py),
every game kind's generator/checker (eventgames.py), every outcome type,
and the server plumbing (dispatch, idle defaults, bots, table clock)."""
import asyncio
import json
import random

import pytest

import event_data
import eventgames as EG
import events as EV
import game as G
import puzzles
from game import Game, GameError


def make_game(n=3, seed=11):
    g = Game("EVT", seed=seed)
    pids = [g.add_player(f"tok{i}", f"P{i}").pid for i in range(n)]
    g.start(pids[0])
    return g, pids


def hub_sea(g, i=0):
    return [nid for nid, n in g.board.nodes.items()
            if n["type"] == "sea" and not n.get("region") and not n.get("sword")][i]


def vale_trail(g):
    return next(nid for nid, n in g.board.nodes.items()
                if n.get("region") == "autumn" and n["type"] == "sea")


def at(g, pid, nid):
    p = g.player_by_pid(pid)
    p.prev_node, p.node = p.node, nid
    return p


def force(g, pid, eid, nid=None):
    at(g, pid, nid or hub_sea(g))
    EV.dev_force(g, pid, eid)
    return g.ev["active"]


def state(g):
    return (repr(g.ev), g.phase, g.nonce, repr([p.public() for p in g.players]),
            g.rng.getstate())


# ═══ content ════════════════════════════════════════════════════════════════
OUT_KEYS = {"text", "scrolls", "hull", "item", "items", "item_spend", "upgrade",
            "buff", "buffs", "move", "skip", "reveal", "fight", "kraken", "game",
            "puzzle", "table", "spawn", "remove_world", "log", "swap", "rival"}


def _check_out(out, where):
    assert isinstance(out, dict), where
    assert set(out) <= OUT_KEYS, (where, set(out) - OUT_KEYS)
    for it in ([out["item"]] if out.get("item") else []) + list(out.get("items") or []):
        assert it in G.SHOP_ITEMS, where
    for b in ([out["buff"]] if out.get("buff") else []) + list(out.get("buffs") or []):
        assert b[0] in EV.BUFFS and 1 <= b[1] <= EV.BUFF_CAP, where
    if out.get("game"):
        assert out["game"]["kind"] in EG.GAMES, where
        for k in ("win", "lose"):
            if out["game"].get(k):
                _check_out(out["game"][k], where + f".{k}")
        for _, o in out["game"].get("score") or []:
            _check_out(o, where + ".score")
    if out.get("puzzle"):
        assert out["puzzle"]["kind"] in EV.EVENT_PUZZLES, where
    if out.get("table"):
        _check_table(out["table"], where)
    if out.get("move"):
        assert out["move"]["toward"] in ("home", "haven", "lair", "gate", "random", "shop")
    if out.get("reveal"):
        assert out["reveal"] in ("sword", "vale")


def _check_table(t, where):
    assert t["kind"] in EG.TABLE_KINDS, where
    if t["kind"] == "vote":
        assert len(t["choices"]) >= 2
        for c in t["choices"]:
            _check_out(c["outcome"], where)
            assert not ({"game", "puzzle", "table", "fight", "move", "kraken",
                         "upgrade"} & set(c["outcome"])), "table prizes are simple"
    if t["kind"] == "lanes":
        assert len(t["lanes"]) >= 2
    for k in ("prize", "win"):
        if t.get(k):
            _check_out(t[k], where)


def test_content_is_large_varied_and_well_formed():
    ids = [e["id"] for e in EV.EVENTS]
    assert len(ids) == len(set(ids))
    hub = [e for e in EV.EVENTS if e["stage"] == "hub"]
    vale = [e for e in EV.EVENTS if e["stage"] == "autumn"]
    assert len(hub) >= 25 and len(vale) >= 20
    for stage in (hub, vale):
        kinds = {e["kind"] for e in stage}
        assert {"instant", "choice", "game", "table"} <= kinds
        assert any(e.get("world") for e in stage)          # WORLD meetings too
    for e in EV.EVENTS:
        assert e["kind"] in ("instant", "choice", "game", "table")
        assert e["title"] and len(e["text"]) > 30
        assert set(e.get("where", ["sea"])) <= set(EV.CLASS_MULT)
        if e["kind"] in ("choice", "game"):
            assert 2 <= len(e["options"]) <= 4, e["id"]
            # the last option is the cautious one: the idle clock picks it
            assert not e["options"][-1].get("requires"), e["id"]
            for o in e["options"]:
                assert o["label"] and o.get("stakes"), e["id"]
                if o.get("roll"):
                    for w, out in o["roll"]:
                        assert w > 0
                        _check_out(out, e["id"])
                else:
                    _check_out(o["outcome"], e["id"])
            if e["kind"] == "game":
                assert any((o.get("outcome") or {}).get("game")
                           or (o.get("outcome") or {}).get("puzzle")
                           for o in e["options"]), e["id"]
        elif e["kind"] == "instant":
            for _, out in e.get("roll") or [[1, e.get("outcome")]]:
                _check_out(out, e["id"])
        else:
            _check_table(e["table"], e["id"])
    for w in EV.WORLD:
        assert EV.EVENTS_BY_ID[w["meet"]].get("world"), w["id"]
        assert w["rounds"] >= 3 and w["stage"] in ("hub", "autumn", "desert", "ice", "jungle")
    assert {"hub", "autumn"} <= {w["stage"] for w in EV.WORLD}


def test_every_game_kind_is_used_somewhere():
    used = set()

    def walk(o):
        if isinstance(o, dict):
            if "game" in o and isinstance(o["game"], dict):
                used.add(o["game"]["kind"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(event_data.EVENTS)
    assert used == set(EG.GAMES)


# ═══ the game kinds ═════════════════════════════════════════════════════════
@pytest.mark.parametrize("kind", sorted(EG.GAMES))
def test_game_kind_plays_to_an_end_and_hides_its_secret(kind):
    for seed in range(40):
        rng = random.Random(seed)
        st = EG.gen(kind, rng)
        pub = EG.public(st)
        assert "secret" not in pub
        json.dumps(pub)
        for _ in range(60):
            if st["done"]:
                break
            EG.move(st, EG.bot(st, rng, 0.5), rng)
        assert st["done"] and st["result"] in ("win", "lose")
        with pytest.raises(ValueError):
            EG.move(st, EG.solve(st) if kind != "knucklebones" else "throw", rng)


@pytest.mark.parametrize("kind", ["codebreak", "shells", "weigh", "crossing", "rps", "nim"])
def test_the_solver_always_wins_a_deduction_game(kind):
    for seed in range(60):
        rng = random.Random(seed)
        st = EG.gen(kind, rng)
        for _ in range(40):
            if st["done"]:
                break
            EG.move(st, EG.solve(st), rng)
        assert st["result"] == "win", (kind, seed, EG.public(st))


@pytest.mark.parametrize("kind", sorted(EG.GAMES))
def test_a_malformed_move_is_refused_and_changes_nothing(kind):
    rng = random.Random(5)
    st = EG.gen(kind, rng)
    for junk in EG.junk_payloads(st):
        before = repr(st)
        try:
            EG.move(st, junk, rng)
        except (ValueError, TypeError, KeyError):
            assert repr(st) == before, junk
            continue
        st = EG.gen(kind, random.Random(5))       # it was legal: start over


def test_knucklebones_busts_on_the_dog_and_cashes_out_on_stop():
    st = EG.gen("knucklebones", random.Random(0))
    rigged = random.Random(0)
    rigged.choice = lambda seq: 6
    EG.move(st, "throw", rigged)
    EG.move(st, "throw", rigged)
    assert st["pot"] == 12 and not st["done"]
    EG.move(st, "stop", rigged)
    assert st["done"] and st["result"] == "win" and st["score"] == 12
    st = EG.gen("knucklebones", random.Random(0))
    rigged.choice = lambda seq: 1
    EG.move(st, "throw", rigged)
    assert st["done"] and st["result"] == "lose" and st["pot"] == 0


def test_higher_lower_ties_are_free_and_a_wrong_call_loses():
    st = EG.gen("higher_lower", random.Random(1))
    st["tile"] = 5
    st["secret"]["deck"].append(5)
    EG.move(st, "higher", random.Random())
    assert st["streak"] == 0 and not st["done"]          # a tie: no harm
    st["secret"]["deck"].append(9)
    EG.move(st, "lower", random.Random())
    assert st["done"] and st["result"] == "lose"


def test_codebreak_feedback_counts_placed_and_present():
    st = EG.gen("codebreak", random.Random(2))
    st["secret"]["code"] = [0, 1, 2]
    EG.move(st, [2, 1, 3], random.Random())
    assert st["guesses"][-1] == {"glyphs": [2, 1, 3], "placed": 1, "present": 1}
    EG.move(st, [0, 1, 2], random.Random())
    assert st["result"] == "win"


def test_shells_always_have_exactly_one_consistent_cup():
    for seed in range(200):
        st = EG.gen("shells", random.Random(seed))
        rules = [tuple(r) for r in st["secret"]["rules"]]
        assert EG._shell_solutions(rules, st["truths"]) == [st["secret"]["pearl"]]


def test_weigh_reports_the_heavy_pan_and_counts_weighings():
    st = EG.gen("weigh", random.Random(3))
    st["secret"]["odd"] = 4
    EG.move(st, {"left": [0, 1, 2], "right": [3, 4, 5]}, random.Random())
    assert st["log"][-1]["tip"] == "right" and st["weighings_left"] == 2
    with pytest.raises(ValueError):
        EG.move(st, {"left": [0, 1], "right": [2]}, random.Random())   # unequal pans
    EG.move(st, {"pick": 4}, random.Random())
    assert st["result"] == "win"


def test_crossing_eats_the_goat_left_with_the_wolf():
    st = EG.gen("crossing", random.Random())
    EG.move(st, {"take": "charts"}, random.Random())     # wolf + goat left alone
    assert st["done"] and st["result"] == "lose" and st["eaten"] == ["wolf", "goat"]


def test_rps_tells_are_honest():
    rng = random.Random(4)
    st = EG.gen("rps", rng)
    for _ in range(9):
        if st["done"]:
            break
        tell, his = st["tell"], st["secret"]["next"]
        assert st["secret"]["tells"][his] == tell
        EG.move(st, "stone", rng)


def test_nim_philosopher_takes_the_last_pebble_when_you_slip():
    st = EG.gen("nim", random.Random())
    st["pile"], st["err"] = 5, 0.0
    EG.move(st, {"take": 3}, random.Random())            # leaves 2: he takes both
    assert st["done"] and st["result"] == "lose"


def test_forfeit_cashes_out_a_pot_game_and_loses_the_rest():
    st = EG.gen("knucklebones", random.Random())
    st["pot"] = 13
    EG.forfeit(st)
    assert st["result"] == "win" and st["score"] == 13
    st = EG.gen("codebreak", random.Random())
    EG.forfeit(st)
    assert st["result"] == "lose"


@pytest.mark.parametrize("kind", EG.TABLE_KINDS)
def test_table_kinds_validate_and_default(kind):
    g, pids = make_game()
    p = g.players[0]
    p.scrolls = 5
    params = {"choices": [{"label": "a"}, {"label": "b"}],
              "lanes": ["swift", "calm", "rocky"]}
    st = EG.gen_table(kind, random.Random(1), params)
    for _ in range(30):
        v = EG.table_bot(st, random.Random(_), p)
        assert EG.table_valid(st, v, p), (kind, v)
    d = EG.table_default(st)
    assert d is None or EG.table_valid(st, d, p)
    for junk in (None, "x", -5, 999, [], {}, 1.5, True):
        if kind == "bid" and junk is True:
            continue
        assert not EG.table_valid(st, junk, p), (kind, junk)


# ═══ the framework ══════════════════════════════════════════════════════════
def test_events_fire_often_on_quiet_water_but_not_when_switched_off():
    g, (a, b, c) = make_game(seed=3)
    g.ev["world"] = []
    sea = hub_sea(g, 3)
    fired = 0
    for seed in range(200):
        g._clear_turn_state()
        g.turn_idx = 0
        g.board.nodes[sea]["monster"] = None
        g.ev["last_heavy"] = {}
        g.rng = random.Random(seed)
        g.phase = "sail"
        p = at(g, a, sea)
        g._land(p, sea)
        fired += g.phase == "event" or g.ev["card"] is not None and \
            g.ev["card"]["seq"] > fired
        g.ev["card"] = None
    assert 40 <= fired <= 140, fired                    # a real chance, not every time
    g.events_on = False
    g._clear_turn_state()
    g.turn_idx = 0
    g.rng = random.Random(1)
    p = at(g, a, sea)
    g.phase = "sail"
    g._land(p, sea)
    assert g.phase != "event"


def test_eligibility_filters():
    g, (a, b, c) = make_game()
    p = g.player_by_pid(a)
    sea = hub_sea(g)
    pool = {e["id"] for e in EV.eligible(g, p, sea)}
    assert "kraken" in pool and "echo" not in pool         # stage-bound
    assert not any(EV.EVENTS_BY_ID[e].get("world") for e in pool)   # only by meeting
    p.upgrades.append("poseidon_favor")
    assert "kraken" not in {e["id"] for e in EV.eligible(g, p, sea)}
    p.upgrades.remove("poseidon_favor")
    g.ev["seen"][a] = ["zeno"]
    assert "zeno" not in {e["id"] for e in EV.eligible(g, p, sea)}   # once per captain
    assert "zeno" in {e["id"] for e in EV.eligible(g, g.player_by_pid(b), sea)}
    solo, (s0,) = make_game(n=1)
    assert not any(e["kind"] == "table" for e in
                   EV.eligible(solo, solo.players[0], hub_sea(solo)))
    trail = vale_trail(g)
    vpool = {e["id"] for e in EV.eligible(g, p, trail)}
    assert "echo" in vpool and "kraken" not in vpool
    assert EV.eligible(g, p, "home") == [] and EV.eligible(g, p, "pharos") == []


def test_a_choice_card_publishes_options_with_stakes_and_gating():
    g, (a, b, c) = make_game()
    g.player_by_pid(a).scrolls = 0
    act = force(g, a, "kraken")
    assert g.phase == "event" and act["step"] == "card"
    snap = g.to_dict(b)["event"]
    assert [o["label"] for o in snap["options"]][0] == "Answer its riddles"
    toll = snap["options"][1]
    assert toll["ok"] is False and "scrolls" in toll["why"]
    with pytest.raises(GameError):
        EV.choose(g, a, 1)                                # gated
    with pytest.raises(GameError):
        EV.choose(g, b, 0)                                # not their turn
    with pytest.raises(GameError):
        EV.choose(g, a, "0")                              # malformed


def test_refused_actions_change_nothing():
    g, (a, b, c) = make_game()
    force(g, a, "sophist_cups")
    for call in (lambda: EV.choose(g, a, 9), lambda: EV.choose(g, b, 0),
                 lambda: EV.game_move(g, a, "stop"), lambda: EV.answer(g, b, 1),
                 lambda: EV.bet(g, b, True)):
        before = state(g)
        with pytest.raises(GameError):
            call()
        assert state(g) == before
    EV.choose(g, a, 1)                                    # play for honour
    assert g.ev["active"]["step"] == "game"
    for junk in EG.junk_payloads(g.ev["active"]["game"]):
        before = state(g)
        try:
            EV.game_move(g, a, junk)
        except GameError:
            assert state(g) == before, junk
            continue
        break


def test_game_event_runs_to_its_outcome_and_settles_bets():
    g, (a, b, c) = make_game()
    p = g.player_by_pid(a)
    p.scrolls = 5
    force(g, a, "sophist_cups")
    EV.choose(g, a, 0)                                    # wager a scroll
    act = g.ev["active"]
    EV.bet(g, b, True)
    EV.bet(g, c, False)
    with pytest.raises(GameError):
        EV.bet(g, b, False)                               # one bet each
    with pytest.raises(GameError):
        EV.bet(g, a, True)                                # never on yourself
    sb, sc = g.player_by_pid(b).scrolls, g.player_by_pid(c).scrolls
    EV.game_move(g, a, act["game"]["secret"]["pearl"])
    assert g.ev["active"] is None and g.phase == "trade"
    assert p.scrolls == 8
    assert g.player_by_pid(b).scrolls == sb + 1 and g.player_by_pid(c).scrolls == sc
    card = g.ev["card"]
    assert card["ok"] and card["pid"] == a and any("called it" in x for x in card["lines"])


def test_event_puzzle_uses_the_minigame_plumbing():
    g, (a, b, c) = make_game()
    force(g, a, "taxman")
    p = g.player_by_pid(a)
    p.scrolls = 4
    EV.choose(g, a, 0)                                    # claim an exemption
    assert g.phase == "minigame" and g.minigame["event"]
    assert g.minigame["kind"] == "riddle" and g.minigame["limit"] >= 60
    snap = g.to_dict(b)
    assert snap["event"]["step"] == "puzzle" and "secret" not in json.dumps(snap["minigame"])
    with pytest.raises(GameError):
        g.minigame_submit(a, "certainly not the answer")   # typed: try again
    g.minigame_submit(a, g.minigame["data"]["secret"]["answer"])
    assert p.scrolls == 6 and g.phase == "trade" and g.ev["active"] is None
    # a timeout loses it
    force(g, a, "taxman")
    EV.choose(g, a, 0)
    g.minigame_timeout()
    assert p.scrolls == 4 and g.phase == "trade"
    # the bot path
    force(g, a, "owl_trial", vale_trail(g))
    EV.choose(g, a, 0)
    g.resolve_minigame(True)
    assert g.ev["active"] is None and g.phase == "trade"


def _table(g, eid, actor):
    force(g, actor, eid)
    act = g.ev["active"]
    assert g.phase == "event" and act["step"] == "table"
    return act


def test_table_bid_highest_unique_bid_pays_and_wins():
    g, (a, b, c) = make_game()
    for p in g.players:
        p.scrolls = 6
    _table(g, "auction", a)
    EV.answer(g, b, 4)
    snap = g.to_dict(c)["event"]["table"]
    assert snap["answered"] == [b] and snap["mine"] is None      # sealed
    assert g.to_dict(b)["event"]["table"]["mine"] == 4
    with pytest.raises(GameError):
        EV.answer(g, b, 1)
    with pytest.raises(GameError):
        EV.answer(g, c, 7)                                        # more than they hold
    EV.answer(g, c, 2)
    EV.answer(g, a, 0)
    pb = g.player_by_pid(b)
    assert pb.scrolls == 2 and pb.items["aegis_charm"] == 1 and pb.items["planks"] == 1
    assert g.player_by_pid(c).scrolls == 6 and g.phase == "trade"


def test_table_bid_tie_wins_nothing():
    g, (a, b, c) = make_game()
    for p in g.players:
        p.scrolls = 6
    _table(g, "auction", a)
    for pid in (a, b, c):
        EV.answer(g, pid, 3)
    assert all(p.scrolls == 6 for p in g.players)
    assert any("tie" in x for x in g.ev["card"]["lines"])


def test_table_guess_closest_wins_and_absent_captains_sit_out():
    g, (a, b, c) = make_game()
    act = _table(g, "olives", a)
    target = act["table"]["st"]["secret"]["target"]
    EV.answer(g, a, 20 if target > 50 else 80)
    EV.answer(g, b, target)
    sb, sc = g.player_by_pid(b).scrolls, g.player_by_pid(c).scrolls
    EV.timeout(g)                                         # c never answered
    assert g.player_by_pid(b).scrolls == sb + 3 and g.player_by_pid(c).scrolls == sc


def test_table_vote_applies_the_choice_to_everyone():
    g, (a, b, c) = make_game()
    for p in g.players:
        p.scrolls = 3
    _table(g, "zeus_mood", a)
    EV.answer(g, a, 0)
    EV.answer(g, b, 0)
    EV.answer(g, c, 1)
    assert all(p.scrolls == 2 and p.buffs.get("fortune") == 1 for p in g.players)


def test_table_gamble_and_lanes_and_lowest():
    g, (a, b, c) = make_game()
    for p in g.players:
        p.scrolls = 3
    g.player_by_pid(a).scrolls = 0
    _table(g, "festival_lottery", a)
    with pytest.raises(GameError):
        EV.answer(g, a, "in")                             # cannot cover the ante
    EV.answer(g, a, "out")
    EV.answer(g, b, "in")
    EV.answer(g, c, "out")
    assert g.player_by_pid(b).scrolls in (2, 5) and g.player_by_pid(c).scrolls == 3
    g._next_turn()
    g.turn_idx = 0
    act = _table(g, "regatta", a)
    lanes = act["table"]["st"]["secret"]["lanes"]
    rocky = lanes.index("rocky")
    hb = g.player_by_pid(b).hull
    for pid in (a, b, c):
        EV.answer(g, pid, rocky if pid == b else lanes.index("swift"))
    assert g.player_by_pid(b).hull == hb - 1
    assert g.player_by_pid(c).buffs.get("fair_wind") == 1
    g._next_turn()
    g.turn_idx = 0
    _table(g, "lottery", a)
    before = {p.pid: p.scrolls for p in g.players}
    EV.answer(g, a, 1)
    EV.answer(g, b, 1)
    EV.answer(g, c, 3)
    assert g.player_by_pid(c).scrolls == before[c] + 2     # the lone 3 wins
    assert g.player_by_pid(a).scrolls == before[a]


def test_kicking_a_captain_mid_table_and_mid_event_leaves_a_clean_table():
    g, (a, b, c) = make_game()
    _table(g, "olives", a)
    EV.answer(g, c, 40)
    g.remove_player(a, c)                                 # host kicks c
    assert c not in g.ev["active"]["table"]["answers"]
    EV.answer(g, a, 30)
    EV.answer(g, b, 50)
    assert g.ev["active"] is None
    # the acting captain is kicked mid-card: the event dies with their turn
    g, (a, b, c) = make_game()
    g.turn_idx = 1
    force(g, b, "kraken")
    g.remove_player(a, b)
    assert g.ev["active"] is None and g.phase == "roll"


def test_rematch_resets_events_buffs_and_wonders():
    g, (a, b, c) = make_game()
    p = g.player_by_pid(a)
    p.buffs["fair_wind"] = 2
    force(g, a, "merchant")
    assert any(w["id"] == "merchant" for w in g.ev["world"])
    g.winner = a
    g._bump("finished")
    g.rematch(a)
    assert p.buffs == {} and g.ev["active"] is None and g.ev["card"] is None
    assert all(w["met"] == [] for w in g.ev["world"])
    assert g.log == []                                    # the opening wonders are quiet


# ═══ outcomes ═══════════════════════════════════════════════════════════════
def conclude(g, pid, out, nid=None):
    p = at(g, pid, nid or hub_sea(g, 2))
    act = {"id": "t", "pid": pid, "node": p.node, "kind": "choice", "title": "T",
           "text": "", "art": "sea", "stage": "hub", "step": "card", "world": None,
           "bets": {}, "options": [], "game": None, "gspec": None, "table": None,
           "puzzle": None}
    g.ev["active"] = act
    g._bump("event")
    EV._conclude(g, p, act, out)
    return p


def test_outcome_scrolls_hull_items_never_sink():
    g, (a, b, c) = make_game()
    p = conclude(g, a, {"scrolls": -99})
    assert p.scrolls == 0 and g.phase == "trade"
    g.phase = "sail"
    p.hull = 1
    conclude(g, a, {"hull": -3})
    assert p.hull == 1                                     # an event bruises, never sinks
    p.hull = 3
    p.items["aegis_charm"] = 1
    conclude(g, a, {"hull": -2})
    assert p.hull == 3 and p.items["aegis_charm"] == 0    # the charm turns it
    p.hull = 3
    conclude(g, a, {"hull": 10})
    assert p.hull == p.max_hull
    p.items["planks"] = G.ITEM_CAP
    s0 = p.scrolls
    conclude(g, a, {"items": ["planks", "gale"]})
    assert p.items["planks"] == G.ITEM_CAP and p.items["gale"] == 1 and p.scrolls == s0 + 1
    conclude(g, a, {"item_spend": "gale", "scrolls": 3})
    assert p.items["gale"] == 0 and p.scrolls == s0 + 4


def test_outcome_buffs_bend_the_roll_and_cancel_each_other():
    g, (a, b, c) = make_game()
    p = conclude(g, a, {"buff": ["fair_wind", 2]})
    assert p.buffs == {"fair_wind": 2}
    conclude(g, a, {"buff": ["becalmed", 1]})
    assert p.buffs == {"becalmed": 1}                     # the calm blows the wind away
    g._next_turn()
    g.turn_idx = 0
    g._start_turn()
    g.roll(a, 1)
    assert set(g.reachable.values()) == {1}               # never below one step
    assert p.buffs == {}
    p.buffs["fair_wind"] = 1
    g._start_turn()
    g.roll(a, 1)
    assert set(g.reachable.values()) == {2}


def test_fortune_and_jinx_tilt_a_chancy_option():
    g, (a, b, c) = make_game()
    spec = {"roll": [[1, {"scrolls": 5}], [1, {"hull": -1}]]}
    p = g.player_by_pid(a)
    lucky = 0
    for seed in range(40):
        g.rng = random.Random(seed)
        p.buffs = {"fortune": 1}
        lucky += EV._pick(g, p, spec) == {"scrolls": 5}
        assert p.buffs == {}                              # spent on use
    assert lucky > 20                                     # the better of two throws
    wins = 0
    for seed in range(40):
        g.rng = random.Random(seed)
        p.buffs = {"jinx": 1}
        wins += EV._pick(g, p, spec) == {"scrolls": 5}
    assert wins < 20


def test_outcome_upgrade_offers_a_fitting():
    g, (a, b, c) = make_game()
    conclude(g, a, {"upgrade": True})
    assert g.phase == "upgrade_pick" and len(g.upgrade_offer) == 2
    g.pick_upgrade(a, g.upgrade_offer[0])
    assert g.current.pid == b


def test_outcome_skip_costs_the_next_turn():
    g, (a, b, c) = make_game()
    p = conclude(g, a, {"skip": True})
    assert p.skip_turns == 1
    g.pass_turn(a)
    g.turn_idx = 2
    g._next_turn()
    assert g.current.pid == b and p.skip_turns == 0


def test_outcome_move_toward_home_haven_and_the_barrow():
    g, (a, b, c) = make_game()
    sea = max((nid for nid, n in g.board.nodes.items()
               if n["type"] == "sea" and not n.get("region") and not n.get("sword")),
              key=lambda nid: g.board._dist(nid, "home"))
    p = conclude(g, a, {"move": {"toward": "home", "steps": 3}}, sea)
    assert p.node != sea and g.phase == "trade"
    assert g.board._dist(p.node, "home") < g.board._dist(sea, "home")
    assert not g.board.nodes[p.node].get("region")
    g.phase = "sail"
    trail = vale_trail(g)
    p = conclude(g, a, {"move": {"toward": "lair", "steps": 3}}, trail)
    assert g.board.nodes[p.node].get("region") == "autumn"
    assert g.board.nodes[p.node]["type"] not in ("lair", "gate", "monster")
    g.phase = "sail"
    p = conclude(g, a, {"move": {"toward": "random", "steps": 4}}, sea)
    assert EV._quiet_stop(g, p.node)


def test_outcome_reveal_fight_kraken_and_world():
    g, (a, b, c) = make_game()
    p = conclude(g, a, {"reveal": "sword"})
    assert p.map_bought and g.to_dict(a)["sword_node"]
    g.phase = "sail"
    conclude(g, a, {"fight": {"name": "X", "unit": "Serpent", "hp": 4, "power": 1,
                              "model": "serpent", "count": 1}})
    assert g.phase == "battle" and g.battle["node"] == p.node
    assert g.board.alive_monster(p.node)["enemies"][0]["hp"] == 4
    g.battle = None
    g.board.nodes[p.node]["monster"] = None
    g.phase = "sail"
    conclude(g, a, {"fight": True})
    assert g.phase == "battle"
    g.battle = None
    g.board.nodes[p.node]["monster"] = None
    g.phase = "sail"
    conclude(g, a, {"kraken": 2})
    assert g.phase == "minigame" and g.minigame["kraken"] and g.minigame["kraken_need"] == 2
    g.resolve_minigame(True)
    g.resolve_minigame(True)
    assert g.phase == "trade" and g.kraken is None
    g.ev["world"] = []
    conclude(g, a, {"spawn": "wreck"})
    assert [w["id"] for w in g.ev["world"]] == ["wreck"]
    trail = vale_trail(g)
    g.phase = "sail"
    p = conclude(g, a, {"reveal": "vale"}, trail)
    assert len(p.seen) > 10


def test_world_wonders_spawn_move_expire_and_are_met_once():
    g, (a, b, c) = make_game()
    assert len(g.ev["world"]) >= 2                        # the chart is alive from turn one
    g.ev["world"] = []
    w = EV.spawn_world(g, "merchant")
    nid = w["node"]
    p = at(g, a, nid)
    g.phase = "sail"
    g._land(p, nid)
    assert g.phase == "event" and g.ev["active"]["id"] == "meet_merchant"
    assert a in w["met"]
    EV.idle_default(g, a)
    assert g.phase == "trade"
    g.phase = "sail"
    g.rng = random.Random(0)
    g.rng.random = lambda: 0.99                          # no random event either
    g._land(p, nid)
    assert g.phase == "trade"                             # met once per captain
    g.rng = random.Random(1)
    rounds = w["rounds"]
    for _ in range(len(g.players)):
        EV.on_turn_start(g)
    assert w["rounds"] == rounds - 1
    for _ in range(len(g.players) * 10):
        EV.on_turn_start(g)
    assert w not in g.ev["world"]


def test_whirlpool_catches_ships_beside_it():
    g, (a, b, c) = make_game()
    g.ev["world"] = []
    w = EV.spawn_world(g, "whirlpool")
    nb = next(x for x in g.board.neighbors[w["node"]] if EV.node_class(g, x))
    p = at(g, a, nb)
    g.phase = "sail"
    g._land(p, nb)
    assert g.phase == "event" and g.ev["active"]["id"] == "meet_whirlpool"


def test_snapshots_never_leak_secrets_or_sealed_answers():
    g, (a, b, c) = make_game()
    force(g, a, "sealed_jar")
    EV.choose(g, a, 0)
    for v in (a, b, None):
        ev = json.dumps(g.to_dict(v)["event"])
        assert "secret" not in ev and '"code"' not in ev
    g.ev["active"] = None
    g._next_turn()
    g.turn_idx = 0
    act = _table(g, "olives", a)
    EV.answer(g, b, 33)
    for v in (a, c, None):
        ev = g.to_dict(v)["event"]
        assert "answers" not in json.dumps(ev) and ev["table"]["mine"] is None
        assert "target" not in json.dumps(ev)
    assert act["table"]["st"]["secret"]["target"]


def test_idle_default_moves_every_step_on():
    g, (a, b, c) = make_game()
    force(g, a, "kraken")
    EV.idle_default(g, a)                                 # card → the cautious option
    assert g.ev["active"] is None
    g, (a, b, c) = make_game()
    force(g, a, "satyr_dice")
    g.player_by_pid(a).scrolls = 3
    g.ev["active"]["options"][0]["ok"] = True
    EV.choose(g, a, 0)
    EV.idle_default(g, a)                                 # game → cash out
    assert g.ev["active"] is None and g.phase in ("trade", "roll")
    g, (a, b, c) = make_game()
    _table(g, "olives", a)
    EV.idle_default(g, a)                                 # table → my default answer
    assert a in g.ev["active"]["table"]["answers"]
    EV.idle_default(g, a)                                 # → then close the table
    assert g.ev["active"] is None


def test_bots_play_every_kind_sensibly():
    rng = random.Random(3)
    for eid in [e["id"] for e in EV.EVENTS if not e.get("world")] + \
            [e["id"] for e in EV.EVENTS if e.get("world")]:
        g, (a, b, c) = make_game(seed=rng.randrange(999))
        ev = EV.EVENTS_BY_ID[eid]
        nid = vale_trail(g) if ev["stage"] == "autumn" else hub_sea(g)
        g.player_by_pid(a).scrolls = 6
        force(g, a, eid, nid)
        for _ in range(80):
            if g.phase not in ("event", "minigame") or not g.ev["active"]:
                break
            if g.phase == "minigame":
                g.resolve_minigame(rng.random() < 0.5)
                continue
            act = g.ev["active"]
            if act["step"] == "table":
                for pid in EV.table_waiting(g):
                    mv = EV.bot_decide(g, pid, 0.5, rng)
                    assert mv and mv[0] == "event_answer"
                    EV.answer(g, pid, mv[1])
                continue
            mv = EV.bot_decide(g, a, 0.5, rng)
            assert mv, (eid, act["step"])
            {"event_choose": EV.choose, "event_move": EV.game_move}[mv[0]](g, a, mv[1])
        assert g.ev["active"] is None, eid


def test_legal_moves_are_all_accepted():
    g, (a, b, c) = make_game()
    force(g, a, "goat")
    for label, msg, val in EV.legal_moves(g, a):
        assert msg == "event_choose"
    EV.choose(g, a, 0)
    for _ in range(30):
        if not g.ev["active"]:
            break
        moves = EV.legal_moves(g, a)
        assert moves
        EV.game_move(g, a, moves[0][2])
    assert g.ev["active"] is None


# ═══ server plumbing ════════════════════════════════════════════════════════
def _server():
    import server as S
    return S


def test_server_idle_step_handles_the_event_phase():
    S = _server()
    g, (a, b, c) = make_game()
    force(g, a, "goat")
    done = S.idle_step(g, a)
    assert done.startswith("event") and g.phase != "event"
    assert "event" in S.IDLE_PHASES and "event" in S.BOT_PHASES


def test_server_dispatches_event_messages_and_the_dev_hook():
    S = _server()

    async def main():
        g, (a, b, c) = make_game()
        S.table.game = g
        S.table.bots = {}
        S.table.sockets = {object(): pid for pid in (a, b, c)}   # all at the table
        err = await S.dispatch(a, "dev", {"code": S.DEV_CODE, "event": "olives"})
        assert err is None and g.phase == "event"
        act = g.ev["active"]
        assert act["table"]["deadline"] is not None          # the table clock is armed
        assert await S.dispatch(b, "event_answer", {"value": 40}) is None
        assert await S.dispatch(b, "event_answer", {"value": 41})   # twice: refused
        assert await S.dispatch(c, "event_answer", {"value": "x"})
        await S.dispatch(c, "event_answer", {"value": 50})
        await S.dispatch(a, "event_answer", {"value": 60})
        assert g.ev["active"] is None
        g.phase = "sail"
        await S.dispatch(a, "dev", {"code": S.DEV_CODE, "event": "sophist_cups"})
        assert await S.dispatch(a, "event_choose", {"idx": 2}) is None
        assert g.ev["active"] is None
        await S.dispatch(a, "dev", {"code": S.DEV_CODE, "event": "codebreak"})
        assert g.ev["active"] is None                        # (no such event)
        await S.dispatch(a, "dev", {"code": S.DEV_CODE, "event": "serpent"})
        assert any(w["id"] == "serpent" for w in g.ev["world"])
        S.table.reset()
    asyncio.run(main())


def test_server_closes_a_table_nobody_left_can_answer():
    S = _server()

    async def main():
        g, (a, b, c) = make_game()
        S.table.game = g
        S.table.bots = {}
        S.table.sockets = {}
        await S.dispatch(a, "dev", {"code": S.DEV_CODE, "event": "olives"})
        # nobody has a live socket: the table closes on everyone's default
        assert g.ev["active"] is None and g.phase != "event"
        S.table.reset()
    asyncio.run(main())

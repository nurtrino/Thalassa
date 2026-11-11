"""Events, second wave: the Bleached Reach (desert) set, the second Isles of
Peace set, the haggle game, the race table, the ghost ship's swap, the
misdelivered parcel, desert landings, and the world-wonder cadence."""
import random

import pytest

import event_data_desert as DES
import event_data_hub2 as HUB2
import eventgames as EG
import events as EV
from test_events import _check_out, _check_table, at, make_game


def desert_trail(g, i=0):
    return [nid for nid, n in g.board.nodes.items()
            if n.get("region") == "desert" and n["type"] == "sea"
            and not n.get("sphinx")][i]


def hub_sea(g, i=0):
    return [nid for nid, n in g.board.nodes.items()
            if n["type"] == "sea" and not n.get("region") and not n.get("sword")][i]


def force(g, pid, eid, nid):
    at(g, pid, nid)
    EV.dev_force(g, pid, eid)
    return g.ev["active"]


NEW = DES.EVENTS + HUB2.EVENTS


# ═══ content ════════════════════════════════════════════════════════════════
def test_new_sets_are_large_varied_and_well_formed():
    des = [e for e in DES.EVENTS if not e.get("world")]
    hub2 = HUB2.EVENTS
    assert len(des) >= 22 and len(hub2) >= 14
    assert {"instant", "choice", "game", "table"} <= {e["kind"] for e in des}
    assert {e["stage"] for e in DES.EVENTS} == {"desert"}
    assert {e["stage"] for e in HUB2.EVENTS} == {"hub"}
    assert 3 <= len(DES.WORLD) <= 4 and len(HUB2.WORLD) >= 6
    for e in NEW:
        assert EV.EVENTS_BY_ID[e["id"]] is e                 # merged, ids unique
        assert e["title"] and len(e["text"]) > 30
        assert set(e.get("where", ["sea"])) <= set(EV.CLASS_MULT)
        if e["kind"] in ("choice", "game"):
            assert 2 <= len(e["options"]) <= 4, e["id"]
            assert not e["options"][-1].get("requires"), e["id"]
            assert not e["options"][-1].get("when"), e["id"]
            for o in e["options"]:
                assert o["label"] and o.get("stakes"), e["id"]
                for _, out in (o.get("roll") or [[1, o.get("outcome")]]):
                    _check_out(out, e["id"])
        elif e["kind"] == "instant":
            for _, out in e.get("roll") or [[1, e.get("outcome")]]:
                _check_out(out, e["id"])
        else:
            _check_table(e["table"], e["id"])
            if e["table"]["kind"] == "race":
                field = e["table"]["params"]["field"]
                assert len(e["table"]["pays"]) == len(field) >= 2
                for out in e["table"]["pays"]:
                    _check_out(out, e["id"])
                    assert set(out) <= {"text", "scrolls", "hull", "item", "items", "buff",
                                        "buffs"}
    for w in DES.WORLD + HUB2.WORLD:
        assert EV.EVENTS_BY_ID[w["meet"]].get("world"), w["id"]
        assert EV.EVENTS_BY_ID[w["meet"]]["stage"] == w["stage"]
        assert w["rounds"] >= 3 and w.get("model")


def _walk_outs(e):
    for o in e.get("options") or []:
        for _, out in (o.get("roll") or [[1, o.get("outcome")]]):
            yield out
    for _, out in (e.get("roll") or ([[1, e["outcome"]]] if e.get("outcome") else [])):
        yield out


def test_desert_outcomes_suit_the_desert():
    """No Vale-only reveal, no tow 'home' (there is no home port out there)."""
    for e in DES.EVENTS:
        for out in _walk_outs(e):
            for sub in [out] + [out[k].get(x) or {} for k in ("game", "puzzle") if out.get(k)
                                for x in ("win", "lose")]:
                assert sub.get("reveal") != "vale", e["id"]
                assert (sub.get("move") or {}).get("toward") not in ("home", "shop", "gate"), e["id"]


# ═══ the haggle ═════════════════════════════════════════════════════════════
def test_haggle_solver_always_strikes_a_deal_and_feedback_is_honest():
    for seed in range(200):
        rng = random.Random(seed)
        st = EG.gen("haggle", rng, {"range": [2, 14], "patience": 4})
        res = st["secret"]["reserve"]
        while not st["done"]:
            EG.move(st, EG.solve(st), rng)
            assert st["floor"] <= res <= st["ceil"] or st["done"]
        assert st["result"] == "win" and 1 <= st["score"] <= 4
        for o in st["offers"]:
            gap = res - o["offer"]
            assert o["reply"] == ("deal" if gap <= 0 else "close" if gap < 4 else "insult")


def test_haggle_refuses_bad_offers_and_runs_out_of_patience():
    st = EG.gen("haggle", random.Random(1), {"range": [2, 14], "patience": 3})
    st["secret"]["reserve"] = 14
    for bad in ({"offer": 1}, {"offer": 15}, {"offer": "x"}, {"offer": True}, {}, None, 7):
        before = repr(st)
        with pytest.raises(ValueError):
            EG.move(st, bad, random.Random(0))
        assert repr(st) == before
    EG.move(st, {"offer": 5}, random.Random(0))
    assert st["offers"][-1]["reply"] == "insult" and st["floor"] == 9
    with pytest.raises(ValueError):                          # already refused that much
        EG.move(st, {"offer": 5}, random.Random(0))
    EG.move(st, {"offer": 11}, random.Random(0))
    assert st["offers"][-1]["reply"] == "close" and (st["floor"], st["ceil"]) == (12, 14)
    EG.move(st, {"offer": 12}, random.Random(0))
    assert st["done"] and st["result"] == "lose" and st["reserve"] == 14
    st = EG.gen("haggle", random.Random(2), {})
    st["secret"]["reserve"] = 6
    EG.move(st, {"offer": 8}, random.Random(0))
    assert st["result"] == "win" and st["score"] == 2 and st["paid"] == 8
    assert EG.idle(st) is None                               # an idle captain forfeits


def test_haggle_bots_play_sensibly():
    wins = 0
    for seed in range(100):
        rng = random.Random(seed)
        st = EG.gen("haggle", rng, {})
        while not st["done"]:
            EG.move(st, EG.bot(st, rng, 0.5), rng)
        wins += st["result"] == "win"
    assert wins >= 70


# ═══ the race table ═════════════════════════════════════════════════════════
def test_race_table_validates_and_pays_the_winners_backers():
    g, (a, b, c) = make_game()
    at(g, a, desert_trail(g))
    EV.dev_force(g, a, "camel_race")
    act = g.ev["active"]
    assert act["step"] == "table"
    tst = act["table"]["st"]
    pub = g.to_dict(b)["event"]["table"]["st"]
    assert "secret" not in pub and pub["runners"] and sum(pub["chance"]) in (99, 100, 101)
    for junk in (None, -1, 3, "Humphrey", 1.0, True):
        assert not EG.table_valid(tst, junk, g.player_by_pid(a))
    win = tst["secret"]["winner"]
    lose = (win + 1) % tst["n"]
    before = {q.pid: q.scrolls for q in g.players}
    EV.answer(g, a, win)
    EV.answer(g, b, lose)
    EV.answer(g, c, win)
    assert g.ev["active"] is None
    pays = EV.EVENTS_BY_ID["camel_race"]["table"]["pays"][win]["scrolls"]
    assert g.player_by_pid(a).scrolls == before[a] + pays
    assert g.player_by_pid(c).scrolls == before[c] + pays
    assert g.player_by_pid(b).scrolls == before[b]
    card = g.ev["card"]
    assert any("wins the race" in ln for ln in card["lines"])


# ═══ desert landings ════════════════════════════════════════════════════════
def test_desert_landings_produce_desert_events_and_never_at_a_fight_or_door():
    g, (a, b, c) = make_game(seed=5)
    trail = [nid for nid, n in g.board.nodes.items()
             if n.get("region") == "desert" and n["type"] == "sea" and not n.get("sphinx")]
    assert len(trail) >= 6
    fired, stages = 0, set()
    for seed in range(160):
        nid = trail[seed % len(trail)]
        g._clear_turn_state()
        g.turn_idx = 0
        g.ev["active"] = None
        g.ev["world"] = []
        g.ev["last_heavy"] = {}
        g.ev["card"] = None
        g.rng = random.Random(seed)
        g.phase = "sail"
        p = at(g, a, nid)
        g._land(p, nid)
        if g.phase in ("event", "minigame") and g.ev["active"]:
            fired += 1
            stages.add(EV.EVENTS_BY_ID[g.ev["active"]["id"]]["stage"])
        elif g.ev["card"]:
            fired += 1
            stages.add(EV.EVENTS_BY_ID[g.ev["card"]["id"]]["stage"])
    assert 30 <= fired <= 130, fired
    assert stages == {"desert"}
    # never on the pass, the lair, a Sphinx gate, or a hunting ground that rises
    for nid, n in g.board.nodes.items():
        if n.get("region") != "desert":
            continue
        if n["type"] in ("gate", "lair") or n.get("sphinx"):
            assert EV.node_class(g, nid) is None or not EV.eligible(g, g.players[0], nid), nid


def test_a_tow_never_carries_a_captain_past_an_unanswered_sphinx():
    g, (a, b, c) = make_game(seed=9)
    sph = [nid for nid, n in g.board.nodes.items() if n.get("sphinx")]
    assert sph
    for gate in sph:
        g.board.nodes[gate]["sphinx_done"] = False
    for nid in [x for x, n in g.board.nodes.items()
                if n.get("region") == "desert" and EV._quiet_stop(g, x)]:
        for seed in range(6):
            g.rng = random.Random(seed)
            p = at(g, a, nid)
            start = nid
            if EV._move(g, p, {"toward": "lair", "steps": 4}):
                # every stop on the shortest path between start and dest is
                # allowed ground — so no Sphinx lies on it
                assert not g.board.nodes[p.node].get("sphinx")
                path = _bfs(g, start, p.node)
                assert not any(g.board.nodes[x].get("sphinx") for x in path), (start, p.node)


def _bfs(g, a, b):
    prev = {a: None}
    order = [a]
    for cur in order:
        for nb in g.board.neighbors.get(cur, ()):
            n = g.board.nodes[nb]
            if nb not in prev and n.get("region") == "desert" and not n.get("sphinx") \
                    and n["type"] not in ("monster", "gate", "lair"):
                prev[nb] = cur
                order.append(nb)
    assert b in prev, "the tow went somewhere unreachable without crossing a gate"
    out = []
    while b is not None:
        out.append(b)
        b = prev[b]
    return out


# ═══ every new event plays to its end ═══════════════════════════════════════
@pytest.mark.parametrize("eid", [e["id"] for e in NEW])
def test_every_new_event_resolves_with_bots(eid):
    rng = random.Random(len(eid))
    g, (a, b, c) = make_game(seed=rng.randrange(999))
    ev = EV.EVENTS_BY_ID[eid]
    nid = desert_trail(g) if ev["stage"] == "desert" else hub_sea(g, 2)
    for q in g.players:
        q.scrolls = 6
        q.hull = q.max_hull - 2
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
                EV.answer(g, pid, mv[1])
            continue
        mv = EV.bot_decide(g, a, 0.5, rng)
        {"event_choose": EV.choose, "event_move": EV.game_move}[mv[0]](g, a, mv[1])
    assert g.ev["active"] is None, eid


@pytest.mark.parametrize("eid", [e["id"] for e in NEW if e["kind"] in ("choice", "game")])
def test_every_option_of_every_new_card_resolves(eid):
    ev = EV.EVENTS_BY_ID[eid]
    for i in range(len(ev["options"])):
        for seed in range(3):
            g, (a, b, c) = make_game(seed=seed + 40)
            for q in g.players:
                q.scrolls = 6
                q.hull = q.max_hull - 2
                q.items["hint"] = 1
                q.items["gale"] = 1
            nid = desert_trail(g) if ev["stage"] == "desert" else hub_sea(g, 2)
            act = force(g, a, eid, nid)
            if not act["options"][i]["ok"]:
                continue
            g.rng = random.Random(seed)
            EV.choose(g, a, i)
            for _ in range(60):
                act = g.ev["active"]
                if not act or g.phase not in ("event", "minigame"):
                    break
                if g.phase == "minigame":
                    g.resolve_minigame(seed % 2 == 0)
                elif act["step"] == "game":
                    EV.game_move(g, a, EG.solve(act["game"]))
                elif act["step"] == "table":
                    for pid in EV.table_waiting(g):
                        EV.answer(g, pid, EV.bot_decide(g, pid, 0.5, random.Random(1))[1])
            assert g.ev["active"] is None, (eid, i)
            assert all(q.scrolls >= 0 and 0 < q.hull <= q.max_hull for q in g.players)


# ═══ the ghost ship and the misdelivered parcel ═════════════════════════════
def test_ghost_ship_swaps_two_captains_in_the_isles():
    g, (a, b, c) = make_game()
    sa, sb = hub_sea(g, 1), hub_sea(g, 6)
    at(g, b, sb)
    at(g, c, desert_trail(g))                              # a captain far away
    force(g, a, "meet_ghostship", sa)
    EV.choose(g, a, 0)
    pa, pb = g.player_by_pid(a), g.player_by_pid(b)
    assert pa.node == sb and pb.node == sa
    assert g.player_by_pid(c).node == desert_trail(g)       # never across the wall
    assert g.ev["active"] is None and g.phase != "event"
    # nobody to trade with: it says so and nothing moves
    g, (a, b, c) = make_game()
    at(g, b, desert_trail(g))
    at(g, c, desert_trail(g, 1))
    force(g, a, "meet_ghostship", hub_sea(g, 1))
    EV.choose(g, a, 0)
    assert g.player_by_pid(a).node == hub_sea(g, 1)
    assert any("nobody" in ln for ln in g.ev["card"]["lines"])


def test_hermes_delivers_to_a_rival():
    g, (a, b, c) = make_game()
    before = {q.pid: q.scrolls for q in g.players}
    force(g, a, "meet_hermes", hub_sea(g, 1))
    EV.choose(g, a, 1)
    assert g.player_by_pid(a).scrolls == before[a] + 1
    gained = [q.pid for q in g.players if q.pid != a and q.scrolls == before[q.pid] + 2]
    assert len(gained) == 1


# ═══ world wonders ══════════════════════════════════════════════════════════
def test_the_isles_keep_three_to_five_wonders_and_the_desert_stirs_for_walkers():
    g, (a, b, c) = make_game(seed=21)
    hub_counts = []
    for _ in range(len(g.players) * 60):
        EV.on_turn_start(g)
        hub_counts.append(sum(1 for w in g.ev["world"]
                              if EV.WORLD_BY_ID[w["id"]]["stage"] == "hub"))
    late = hub_counts[len(g.players) * 4:]
    assert max(late) <= EV.WORLD_HUB_MAX
    assert 3 <= sum(late) / len(late) <= 5, sum(late) / len(late)
    # nobody in the desert: no desert wonders
    assert not any(EV.WORLD_BY_ID[w["id"]]["stage"] == "desert" for w in g.ev["world"])
    at(g, a, desert_trail(g, 2))
    des = []
    for _ in range(len(g.players) * 30):
        EV.on_turn_start(g)
        des.append(sum(1 for w in g.ev["world"]
                       if EV.WORLD_BY_ID[w["id"]]["stage"] == "desert"))
    late = des[len(g.players) * 4:]
    assert 1.5 <= sum(late) / len(late) <= 3
    for w in g.ev["world"]:
        if EV.WORLD_BY_ID[w["id"]]["stage"] == "desert":
            assert EV.node_class(g, w["node"]) == "sea"
            assert g.board.nodes[w["node"]].get("region") == "desert"


def test_meeting_a_desert_wonder_fires_its_card():
    for kind, meet in (("caravan", "meet_caravan"), ("sandstorm", "meet_sandstorm"),
                       ("mirage", "meet_mirage"), ("beetle", "meet_beetle")):
        g, (a, b, c) = make_game()
        g.ev["world"] = []
        w = EV.spawn_world(g, kind, near=desert_trail(g, 3))
        assert w and g.board.nodes[w["node"]]["region"] == "desert"
        p = at(g, a, w["node"])
        g.phase = "sail"
        g._land(p, w["node"])
        assert g.phase == "event" and g.ev["active"]["id"] == meet, kind


def test_snapshot_of_a_haggle_hides_the_reserve():
    g, (a, b, c) = make_game()
    force(g, a, "bazaar_duel", desert_trail(g))
    EV.choose(g, a, 0)
    g.ev["active"]["game"]["secret"]["reserve"] = 10
    EV.game_move(g, a, {"offer": 2})
    for v in (a, b, None):
        gv = g.to_dict(v)["event"]["game"]
        assert "secret" not in gv and "reserve" not in gv

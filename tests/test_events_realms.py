"""Events in the realms: the Frostfang Reach (ice) and the Verdigris Deep
(jungle) — content (event_data_ice.py / event_data_jungle.py), the realm game
kinds (eventgames_realms.py: floe, pairs, drums, plates), where events may
fire on a realm board, and the realm world wonders."""
import json
import pathlib
import random
import re

import pytest

import event_data_ice
import event_data_jungle
import eventgames as EG
import eventgames_realms as RG
import events as EV
from game import Game

ROOT = pathlib.Path(__file__).resolve().parent.parent
REALMS = ("ice", "jungle")
REALM_KINDS = ("floe", "pairs", "drums", "plates")


def make_game(n=3, seed=11):
    g = Game("RLM", seed=seed)
    pids = [g.add_player(f"tok{i}", f"P{i}").pid for i in range(n)]
    g.start(pids[0])
    return g, pids


def realm_nodes(g, realm, ntype="sea"):
    return [nid for nid, n in g.board.nodes.items()
            if n.get("region") == realm and n["type"] == ntype]


def at(g, pid, nid):
    p = g.player_by_pid(pid)
    p.prev_node, p.node = p.node, nid
    return p


def play_out(g, a, rng, skill=0.5):
    """Drive an open event to its end with the bots' policies."""
    for _ in range(120):
        if g.phase not in ("event", "minigame") or not g.ev["active"]:
            return
        if g.phase == "minigame":
            g.resolve_minigame(rng.random() < 0.5)
            continue
        act = g.ev["active"]
        if act["step"] == "table":
            for pid in EV.table_waiting(g):
                mv = EV.bot_decide(g, pid, skill, rng)
                EV.answer(g, pid, mv[1])
            continue
        mv = EV.bot_decide(g, a, skill, rng)
        assert mv, (act["id"], act["step"])
        {"event_choose": EV.choose, "event_move": EV.game_move}[mv[0]](g, a, mv[1])
    raise AssertionError("the event never closed")


# ═══ content ════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("realm,mod", [("ice", event_data_ice), ("jungle", event_data_jungle)])
def test_each_realm_has_a_full_varied_set(realm, mod):
    plain = [e for e in mod.EVENTS if not e.get("world")]
    meets = [e for e in mod.EVENTS if e.get("world")]
    assert len(plain) >= 22, len(plain)
    assert all(e["stage"] == realm for e in mod.EVENTS)
    kinds = {e["kind"] for e in plain}
    assert {"instant", "choice", "game", "table"} <= kinds
    for k in ("instant", "choice", "game", "table"):
        assert sum(e["kind"] == k for e in plain) >= 4, k
    assert 3 <= len(mod.WORLD) <= 4 and len(meets) == len(mod.WORLD)
    for w in mod.WORLD:
        assert w["stage"] == realm and EV.EVENTS_BY_ID[w["meet"]]["stage"] == realm
        assert w["bot"] in ("seek", "shun", "fight", "shop", "curious")
    # every one is in the merged framework tables
    for e in mod.EVENTS:
        assert EV.EVENTS_BY_ID[e["id"]] is e
    for w in mod.WORLD:
        assert EV.WORLD_BY_ID[w["id"]] is w
    assert realm in EV.CHANCE and realm in EV.WORLD_STAGES


def test_no_emoji_in_realm_text():
    text = json.dumps(event_data_ice.EVENTS + event_data_jungle.EVENTS
                      + event_data_ice.WORLD + event_data_jungle.WORLD, ensure_ascii=False)
    assert not re.search("[\U0001F000-\U0001FAFF☀-➿]", text)


def test_every_new_game_kind_is_dealt_by_some_realm_event():
    used = set()

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("game"), dict):
                used.add(o["game"]["kind"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(event_data_ice.EVENTS + event_data_jungle.EVENTS)
    assert set(REALM_KINDS) <= used


def test_the_client_knows_every_realm_art_key_world_model_and_game():
    js = (ROOT / "static" / "events_realms.js").read_text()
    fx = (ROOT / "static" / "worldfx_realms.js").read_text()
    for mod in (event_data_ice, event_data_jungle):
        for e in mod.EVENTS:
            art = e["art"]
            assert re.search(rf"\b{art}:", js) or re.search(
                rf"\b{art}:", (ROOT / "static" / "events.js").read_text()), art
        for w in mod.WORLD:
            assert re.search(rf"\b{w['model']}: make\w+", fx), w["model"]     # a builder
            assert re.search(rf"\b{w['model']}: {{ ", fx), w["model"]        # its REALM_LOOK
    for k in REALM_KINDS:
        assert re.search(rf"\b{k}:", js), k


# ═══ every option resolves, in its own realm ════════════════════════════════
@pytest.mark.parametrize("eid", [e["id"] for e in event_data_ice.EVENTS + event_data_jungle.EVENTS])
def test_every_option_of_every_realm_event_resolves(eid):
    ev = EV.EVENTS_BY_ID[eid]
    n_opts = len(ev.get("options") or [None])
    for idx in range(n_opts):
        for seed in range(3):
            g, (a, b, c) = make_game(seed=seed * 7 + idx)
            rng = random.Random(seed)
            nid = realm_nodes(g, ev["stage"])[2]
            p = at(g, a, nid)
            p.scrolls = 9
            p.hull = max(1, p.max_hull - 2)                   # hurt: heal options open
            p.items["hint"] = 1
            if ev.get("world"):
                wspec = next(w for w in EV.WORLD if w["meet"] == eid)
                EV.dev_force(g, a, wspec["id"])
                w = next(x for x in g.ev["world"] if x["id"] == wspec["id"])
                p = at(g, a, w["node"])
                g.phase = "sail"
                g._land(p, w["node"])
                if g.phase == "battle":                       # an ambush rose first
                    continue
                assert g.ev["active"]["id"] == eid
            else:
                EV.dev_force(g, a, eid)
            act = g.ev["active"]
            if ev["kind"] in ("choice", "game"):
                assert act["step"] == "card"
                if not act["options"][idx]["ok"]:
                    continue
                EV.choose(g, a, idx)
            play_out(g, a, rng)
            assert g.ev["active"] is None, (eid, idx)
            assert g.phase in ("roll", "trade", "battle", "upgrade_pick", "minigame",
                               "haven", "shrine", "sail"), (eid, idx, g.phase)
            json.dumps(g.to_dict(b))


# ═══ the realm game kinds ═══════════════════════════════════════════════════
@pytest.mark.parametrize("kind", REALM_KINDS)
def test_realm_kind_is_registered_with_a_label(kind):
    assert kind in EG.GAMES and kind in EG.GAME_LABEL
    assert EG.GAMES[kind][4] in ("stop", None)


@pytest.mark.parametrize("kind", REALM_KINDS)
def test_the_solver_always_wins_a_realm_game(kind):
    for seed in range(150):
        rng = random.Random(seed)
        st = EG.gen(kind, rng)
        for _ in range(60):
            if st["done"]:
                break
            EG.move(st, EG.solve(st), rng)
        assert st["result"] == "win", (kind, seed, EG.public(st))


@pytest.mark.parametrize("kind", REALM_KINDS)
def test_bad_realm_moves_are_refused_and_change_nothing(kind):
    bad = [None, "", "zzz", -1, 99, 1.5, [], {}, True, {"hop": 9}, {"hop": "x"},
           {"sound": -1}, {"flip": 99}, {"flip": "0"}, {"flip": 1.0}, {"pick": 7},
           {"pick": -1}, {"press": 4}, {"press": None}, {"hop": 0, "sound": 1},
           {"flip": 0, "x": 1}, [0], "throw"]
    for seed in range(10):
        rng = random.Random(seed)
        st = EG.gen(kind, rng)
        for _ in range(4):                         # also mid-game
            for junk in bad + EG.junk_payloads(st):
                before = repr(st)
                state = rng.getstate()
                try:
                    EG.move(st, junk, rng)
                except (ValueError, TypeError, KeyError):
                    assert repr(st) == before, (kind, junk)
                    rng.setstate(state)
                    continue
                assert junk in ("stop",) or isinstance(junk, dict), (kind, junk)
                st = EG.gen(kind, random.Random(seed))
            if st["done"]:
                break
            EG.move(st, EG.solve(st), rng)
        pub = EG.public(st)
        assert "secret" not in pub
        json.dumps(pub)


@pytest.mark.parametrize("kind", REALM_KINDS)
def test_bots_and_forfeit_end_every_realm_game(kind):
    for seed in range(60):
        rng = random.Random(seed)
        st = EG.gen(kind, rng)
        for _ in range(80):
            if st["done"]:
                break
            EG.move(st, EG.bot(st, rng, rng.random()), rng)
        assert st["done"] and st["result"] in ("win", "lose")
        with pytest.raises(ValueError):
            EG.move(st, EG.solve(st), rng)
        st = EG.gen(kind, random.Random(seed))
        EG.forfeit(st)
        assert st["done"]


def test_floe_rules():
    rng = random.Random(4)
    st = EG.gen("floe", rng, {"rows": 6, "cols": 4, "poles": 2, "goal": 3})
    thin = st["secret"]["thin"]
    assert len(thin) == 6 and all(1 <= len(r) <= 2 for r in thin)
    # the bear's prints are always sound ice
    for key, v in st["known"].items():
        r, c = map(int, key.split(","))
        assert v == "print" and c not in thin[r]
    # from the shore every floe of row 0 is in reach; afterwards only ±1 column
    assert RG._floe_reach(st) == [0, 1, 2, 3]
    safe0 = next(c for c in range(4) if c not in thin[0])
    EG.move(st, {"hop": safe0}, rng)
    assert st["row"] == 0 and st["near"] == sum(c in thin[1] for c in RG._floe_reach(st))
    far = next(c for c in range(4) if abs(c - safe0) > 1)
    with pytest.raises(ValueError):
        EG.move(st, {"hop": far}, rng)
    # a sounding reveals and spends a pole; a second sounding of it is refused
    c = RG._floe_reach(st)[0]
    EG.move(st, {"sound": c}, rng)
    assert st["poles"] == 1 and st["known"][f"1,{c}"] in ("thin", "sound", "print")
    with pytest.raises(ValueError):
        EG.move(st, {"sound": c}, rng)
    # stopping before the goal is a loss, but pays what was crossed
    EG.move(st, "stop", rng)
    assert st["done"] and st["result"] == "lose" and st["score"] == 1
    # hopping on thin ice ends it with nothing
    st = EG.gen("floe", random.Random(4))
    bad = st["secret"]["thin"][0][0]
    EG.move(st, {"hop": bad}, random.Random(0))
    assert st["done"] and st["result"] == "lose" and st["score"] == 0 and st["splash"]


def test_floe_generator_never_strands_a_sound_floe():
    for seed in range(300):
        st = EG.gen("floe", random.Random(seed))
        assert RG._floe_ok(st["secret"]["thin"], st["rows"], st["cols"]), seed


def test_pairs_rules():
    rng = random.Random(2)
    st = EG.gen("pairs", rng, {"pairs": 6, "tries": 12, "goal": 3})
    faces = st["secret"]["faces"]
    assert sorted(faces) == sorted(list(range(6)) * 2)
    i = 0
    j = next(k for k in range(1, 12) if faces[k] != faces[0])
    EG.move(st, {"flip": i}, rng)
    assert st["open"] == {"i": 0, "face": faces[0]} and st["tries"] == 12
    with pytest.raises(ValueError):
        EG.move(st, {"flip": 0}, rng)                  # the same tile twice
    with pytest.raises(ValueError):
        EG.move(st, "stop", rng)                       # not with a tile turned
    EG.move(st, {"flip": j}, rng)
    assert st["tries"] == 11 and st["last"]["match"] is False and st["matched"][0] is None
    assert st["seen"][0] and st["seen"][j]
    k = next(x for x in range(1, 12) if faces[x] == faces[0])
    EG.move(st, {"flip": 0}, rng)
    EG.move(st, {"flip": k}, rng)
    assert st["found"] == 1 and st["matched"][0] == st["matched"][k] == faces[0]
    with pytest.raises(ValueError):
        EG.move(st, {"flip": k}, rng)                  # already matched
    pub = json.dumps(EG.public(st))
    assert "faces" not in pub
    EG.move(st, "stop", rng)
    assert st["done"] and st["result"] == "lose" and st["score"] == 1


def test_drums_rounds_have_one_right_answer_among_four():
    for seed in range(200):
        rng = random.Random(seed)
        st = EG.gen("drums", rng)
        for _ in range(st["rounds"]):
            assert len(st["choices"]) == 4 == len(set(st["choices"]))
            assert all(set(x) <= {"B", "t"} and x for x in st["choices"] + st["seq"])
            assert len(st["seq"]) == 4
            EG.move(st, EG.solve(st), rng)
        assert st["done"] and st["score"] == st["rounds"]
    st = EG.gen("drums", random.Random(1))
    wrong = next(i for i in range(4) if i != st["secret"]["ans"])
    EG.move(st, {"pick": wrong}, random.Random(1))
    assert st["right"] == 0 and st["history"][0]["right"] is False and st["round"] == 2


def test_plates_clues_fix_exactly_one_order_and_a_wrong_plate_resets():
    for seed in range(150):
        st = EG.gen("plates", random.Random(seed))
        rules = [tuple(r) for r in st["secret"]["rules"]]
        assert RG._plates_consistent(rules, 4) == [st["secret"]["order"]], seed
        assert 2 <= len(st["clues"]) <= 5
    st = EG.gen("plates", random.Random(3), {"darts": 2})
    order = st["secret"]["order"]
    EG.move(st, {"press": order[0]}, None)
    assert st["pressed"] == [order[0]]
    with pytest.raises(ValueError):
        EG.move(st, {"press": order[0]}, None)          # already down
    EG.move(st, {"press": order[2]}, None)              # wrong: all pop up, a dart
    assert st["pressed"] == [] and st["darts"] == 1 and not st["done"]
    EG.move(st, {"press": order[1]}, None)              # wrong again (order[0] is first)
    assert st["darts"] == 0 and not st["done"]
    EG.move(st, {"press": order[3]}, None)              # third miss: out
    assert st["done"] and st["result"] == "lose"


# ═══ where realm events fire ════════════════════════════════════════════════
def _land_many(g, a, nid, n=200):
    fired = 0
    for seed in range(n):
        g._clear_turn_state()
        g.turn_idx = 0
        g.board.nodes[nid]["monster"] = None
        g.ev["last_heavy"] = {}
        g.ev["world"] = []
        g.ev["card"] = None
        g.rng = random.Random(seed)
        g.phase = "sail"
        p = at(g, a, nid)
        p.upgrades.append("poseidon_favor")          # no sea ambush: only events
        g._land(p, nid)
        p.upgrades.remove("poseidon_favor")
        fired += g.phase == "event" or (g.ev["card"] is not None)
        EV.clear_turn(g)
    return fired


@pytest.mark.parametrize("realm", REALMS)
def test_realm_open_water_meets_realm_events(realm):
    g, (a, b, c) = make_game(seed=5)
    sea = realm_nodes(g, realm)[4]
    fired = _land_many(g, a, sea)
    assert 50 <= fired <= 150, fired
    pool = {e["id"] for e in EV.eligible(g, g.player_by_pid(a), sea)}
    assert pool and all(EV.EVENTS_BY_ID[e]["stage"] == realm for e in pool)


@pytest.mark.parametrize("realm", REALMS)
def test_a_quiet_hunting_ground_can_meet_an_event_but_a_fight_comes_first(realm):
    g, (a, b, c) = make_game(seed=6)
    weak = next(nid for nid in realm_nodes(g, realm, "monster")
                if not g.board.nodes[nid].get("elite"))
    assert EV.node_class(g, weak) == "wild"
    p = g.player_by_pid(a)
    pool = EV.eligible(g, p, weak)
    assert pool and all("sea" in e.get("where", ["sea"]) for e in pool)
    # an elite ground always fights: never an event
    elite = next(nid for nid in realm_nodes(g, realm, "monster")
                 if g.board.nodes[nid].get("elite"))
    for seed in range(30):
        g._clear_turn_state()
        g.turn_idx = 0
        g.board.nodes[elite]["monster"] = None
        g.rng = random.Random(seed)
        g.phase = "sail"
        g._land(at(g, a, elite), elite)
        assert g.phase == "battle" and g.ev["active"] is None
        g.battle = None
    # a weak ground: sometimes a fight, sometimes an event, never both
    seen = set()
    for seed in range(60):
        g._clear_turn_state()
        g.turn_idx = 0
        g.board.nodes[weak]["monster"] = None
        g.ev["last_heavy"] = {}
        g.rng = random.Random(seed)
        g.phase = "sail"
        g._land(at(g, a, weak), weak)
        seen.add(g.phase)
        if g.phase == "battle":
            assert g.ev["active"] is None
        g.battle = None
        EV.clear_turn(g)
    assert "battle" in seen and "event" in seen


@pytest.mark.parametrize("realm", REALMS)
def test_never_at_the_gate_or_the_lair(realm):
    g, (a, b, c) = make_game(seed=7)
    gate = realm_nodes(g, realm, "gate")[0]
    lair = realm_nodes(g, realm, "lair")[0]
    assert EV.node_class(g, gate) is None and EV.node_class(g, lair) is None
    assert EV.eligible(g, g.player_by_pid(a), gate) == []
    # a wonder that reaches its neighbours (radius 1) still leaves the gate alone
    spec = next(w for w in EV.WORLD if w["stage"] == realm and w["radius"])
    nb = next(x for x in g.board.neighbors[gate]
              if g.board.nodes[x].get("region") == realm and EV.node_class(g, x) == "sea")
    g.ev["world"] = [{"wid": 99, "id": spec["id"], "node": nb, "rounds": 5, "met": []}]
    g.no_autowalk = True
    p = at(g, a, gate)
    g.phase = "sail"
    g._land(p, gate)
    assert g.ev["active"] is None and g.phase != "event"


@pytest.mark.parametrize("realm", REALMS)
def test_realm_wonders_rise_near_travellers_and_stay_in_their_realm(realm):
    g, (a, b, c) = make_game(seed=8)
    g.ev["world"] = [w for w in g.ev["world"] if EV.WORLD_BY_ID[w["id"]]["stage"] == "hub"]
    for q in g.players:
        at(g, q.pid, realm_nodes(g, realm)[3])
    g.rng = random.Random(2)
    for _ in range(len(g.players) * 12):
        EV.on_turn_start(g)
    mine = [w for w in g.ev["world"] if EV.WORLD_BY_ID[w["id"]]["stage"] == realm]
    assert 1 <= len(mine) <= EV.WORLD_RULE_DEFAULT["max"]
    for w in mine:
        n = g.board.nodes[w["node"]]
        assert n.get("region") == realm and EV.node_class(g, w["node"]) == "sea"
    # nobody in the realm: nothing new rises there
    g2, _ = make_game(seed=8)
    g2.rng = random.Random(2)
    for _ in range(len(g2.players) * 12):
        EV.on_turn_start(g2)
    assert not any(EV.WORLD_BY_ID[w["id"]]["stage"] == realm for w in g2.ev["world"])


def test_meeting_a_realm_wonder_and_bot_route_opinions():
    g, (a, b, c) = make_game(seed=9)
    p = g.player_by_pid(a)
    for wid, want in (("aurora_whale", 25), ("berg_giant", None), ("monkey_raft", None),
                      ("sloth", 10), ("walrus", 10)):
        g.ev["world"] = []
        realm = EV.WORLD_BY_ID[wid]["stage"]
        at(g, a, realm_nodes(g, realm)[5])
        w = EV.spawn_world(g, wid, near=p.node)
        assert w and g.board.nodes[w["node"]].get("region") == realm
        score = EV.bot_wonder_score(g, p, w["node"])
        if want is not None:
            assert score == want, wid
        else:
            assert score in (-1, 8, 20, 30), wid
    g.ev["world"] = []
    w = EV.spawn_world(g, "penguins", near=realm_nodes(g, "ice")[5])
    p = at(g, a, w["node"])
    p.upgrades.append("poseidon_favor")
    g.phase = "sail"
    g._land(p, w["node"])
    assert g.phase == "event" and g.ev["active"]["id"] == "meet_penguins"
    snap = g.to_dict(b)
    assert any(x["model"] == "penguins" for x in snap["world"])


@pytest.mark.parametrize("kind", REALM_KINDS)
def test_public_realm_state_avoids_the_fuzzers_secret_key_names(kind):
    """tools/sim.py flags these key names anywhere in a snapshot as a leak."""
    banned = {"correct", "answer", "secret", "accept", "word", "data"}

    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield k
                yield from keys(v)
        elif isinstance(o, list):
            for v in o:
                yield from keys(v)
    for seed in range(20):
        rng = random.Random(seed)
        st = EG.gen(kind, rng)
        for _ in range(40):
            assert not set(keys(EG.public(st))) & banned, kind
            if st["done"]:
                break
            EG.move(st, EG.bot(st, rng, 0.5), rng)

"""A fast batch of the headless simulator (tools/sim.py).

The full run is ``python3 tools/sim.py --games 500 --seed 1``; this keeps a
small, quick slice of it in the unit suite so an engine change that breaks
an invariant (a softlock, a leaked answer key, state left over after a
kick, a non-GameError exception on bad input…) fails here first."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "tools"))
import sim  # noqa: E402

import game as G  # noqa: E402
import puzzles  # noqa: E402


def _ok(result):
    assert result["failure"] is None, (
        f"seed {result['seed']} ({result['players']} players, {result['mode']}): "
        f"{result['failure']}\n" + "\n".join(result["trail"][-12:]))
    return result


@pytest.mark.parametrize("seed", range(100, 112))
def test_chaos_table_holds_every_invariant(seed):
    """Random-legal play + illegal / out-of-turn / malformed calls, stale
    timers, kicks, disconnects, teleports — 1 to 6 captains."""
    r = _ok(sim.run_game(seed, players=seed % 6 + 1, mode="chaos", max_turns=70))
    assert r["turns"] >= 1 and r["actions"] > 50


@pytest.mark.parametrize("players", [1, 2, 3, 4, 5, 6])
def test_bot_table_never_sticks(players):
    """The server's own bot decisions, driven the way server.bot_move drives
    them: no softlock, no bot left without a move, every snapshot clean."""
    r = _ok(sim.run_game(4200 + players, players=players, mode="bots", max_turns=150))
    assert r["turns"] == 150 or r["finished"]


def test_chaos_batch_reaches_every_phase():
    seen = set()
    for seed in range(200, 204):
        seen |= set(_ok(sim.run_game(seed, mode="chaos", max_turns=80))["phases"])
    assert sim.PHASES - {"lobby"} <= seen, sorted(sim.PHASES - seen)


def test_a_seed_replays_identically():
    a = sim.run_game(7, mode="chaos", max_turns=60)
    b = sim.run_game(7, mode="chaos", max_turns=60)
    assert a["trail"] == b["trail"] and a["actions"] == b["actions"]
    assert a["scrolls"] == b["scrolls"]


def test_every_dealt_minigame_is_solvable_and_accepted():
    """Each puzzle the engine can deal — isles, all three battle tiers, the
    Sphinx — has a solution its own checker accepts (so none is unwinnable),
    and that solution is not accepted by accident: the wrong payload fails."""
    import random
    rng = random.Random(5)
    kinds = set()
    for i in range(400):
        used = set()
        deal = (puzzles.deal(rng, used) if i % 4 == 0
                else puzzles.deal_battle(rng, 1 + i % 3, used))
        mg = {"kind": deal["kind"], "data": deal}
        kinds.add(deal["kind"])
        answer = sim.solve_minigame(mg)
        assert answer is not None, f"{deal['kind']} dealt unsolvable"
        assert puzzles.check(deal["kind"], deal, answer), deal["kind"]
        assert not puzzles.check(deal["kind"], deal, sim.wrong_payload(mg)), deal["kind"]
    assert {"tetromino", "nonogram", "simon", "ravens", "riddle", "sequence",
            "lights_out", "sliding", "visual_memory", "anagram"} <= kinds


def test_the_harness_catches_a_broken_engine(monkeypatch):
    """The simulator has teeth: break a rule and it says so."""
    # 1) an answer key on the wire
    real_to_dict = G.Game.to_dict

    def leaky(self, viewer_pid=None):
        snap = real_to_dict(self, viewer_pid)
        if snap["question"] is not None and self.question is not None:
            snap["question"]["correct"] = self.question.get("correct")
        return snap

    monkeypatch.setattr(G.Game, "to_dict", leaky)
    r = sim.run_game(3, players=3, mode="chaos", max_turns=120)
    assert r["failure"] and "correct" in r["failure"]
    monkeypatch.setattr(G.Game, "to_dict", real_to_dict)

    # 2) an out-of-turn action accepted
    monkeypatch.setattr(G.Game, "_require_turn", lambda self, pid, *phases: None)
    r = sim.run_game(3, players=3, mode="chaos", max_turns=120)
    assert r["failure"]


def test_cli_summary_and_exit_code(capsys):
    assert sim.main(["--games", "3", "--seed", "50", "--max-turns", "40",
                     "--jobs", "1"]) == 0
    out = capsys.readouterr().out
    assert "games: 3" in out and "failures: 0" in out

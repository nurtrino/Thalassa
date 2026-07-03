"""Tests for the pre-built puzzle bank and the typed-answer riddle set.

These modules ship self-contained content (10 vetted instances per puzzle kind,
plus 50 typed-answer riddles). Here we assert the same invariants their internal
self-tests check, but through pytest so CI catches regressions:

  · every stored solution validates against its checker
  · a deliberately-wrong answer is rejected
  · nothing under `secret` leaks into the client-facing `public` payload
"""
import pytest

import puzzle_bank as pb
import riddles_typed as rt


# ── puzzle bank ──────────────────────────────────────────────────────────────

def test_bank_has_ten_of_each():
    assert set(pb.BANKS) == set(pb._CHECKERS)
    for kind, bank in pb.BANKS.items():
        assert len(bank) == 10, f"{kind}: {len(bank)} instances"


def test_bank_self_tests_pass():
    # solution validates, wrong answer rejected, secret never leaks
    assert pb.run_self_tests() == 90


@pytest.mark.parametrize("kind", sorted(pb.BANKS))
def test_no_secret_leaks(kind):
    for inst in pb.BANKS[kind]:
        for skey in inst["secret"]:
            assert skey not in inst["public"], f"{kind} leaks '{skey}'"


def test_mastermind_feedback():
    assert pb.mastermind_feedback([0, 1, 2, 3], [0, 1, 2, 3]) == (4, 0)
    assert pb.mastermind_feedback([0, 1, 2, 3], [3, 2, 1, 0]) == (0, 4)
    assert pb.mastermind_feedback([0, 0, 1, 1], [0, 1, 1, 2]) == (2, 1)


# ── typed-answer riddles ─────────────────────────────────────────────────────

def test_fifty_riddles_five_categories():
    from collections import Counter
    cats = Counter(r["category"] for r in rt.RIDDLES)
    assert len(rt.RIDDLES) == 50
    assert all(n == 10 for n in cats.values())
    assert len(cats) == 5


def test_every_riddle_answer_checks():
    for r in rt.RIDDLES:
        sec = {"answer": r["answer"], "accept": r["accept"]}
        assert rt.check_riddle(sec, r["answer"])
        assert rt.check_riddle(sec, r["answer"].upper())          # case-insensitive
        for alt in r["accept"]:
            assert rt.check_riddle(sec, alt)
        assert not rt.check_riddle(sec, "zzzznotananswer")


def test_riddle_normalization():
    sec = {"answer": "anchor", "accept": []}
    assert rt.check_riddle(sec, "  The Anchor. ")                  # article + punctuation
    assert not rt.check_riddle(sec, "")


def test_riddle_prompts_unique():
    prompts = [r["prompt"] for r in rt.RIDDLES]
    assert len(prompts) == len(set(prompts))

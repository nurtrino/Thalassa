"""Structural invariants of the cleaned typed-answer deck (data/jeopardy.json).

The deck is produced by tools/clean_jeopardy.py; these checks catch a bad
regeneration (scraper damage, media clues or an over-pruned band) in CI.
"""
import json
import os
import re
import sys

import pytest

import questions

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECK_PATH = os.path.join(ROOT, "data", "jeopardy.json")
BANDS = ("200", "400", "800", "1000")
BAND_FLOOR = 10_000          # each dollar band keeps well over this many clues


@pytest.fixture(scope="module")
def deck():
    with open(DECK_PATH, encoding="utf-8") as f:
        return json.load(f)


def _cells(deck):
    for band in BANDS:
        for cell in deck[band]:
            yield band, cell


def test_schema_and_band_sizes(deck):
    assert set(deck) == set(BANDS)
    for band in BANDS:
        assert len(deck[band]) >= BAND_FLOOR, f"band {band}: {len(deck[band])}"
        for cell in deck[band]:
            assert isinstance(cell, list) and len(cell) == 3
            assert all(isinstance(x, str) and x.strip() == x and x for x in cell), cell


def test_no_markup_escapes_or_garble(deck):
    bad = re.compile(r"\\|<[a-z/][^>]*>|&[a-z]+;|&#\d+|  |\u00c3|\u00e2\u20ac|https?://")
    for _band, cell in _cells(deck):
        for field in cell:
            assert not bad.search(field), cell


def test_quotes_balanced_in_categories(deck):
    # the scraper stripped a leading/trailing '"' — the cleaner restores it
    odd = [c for _b, c in _cells(deck) if c[0].count('"') % 2]
    assert len(odd) < 25, odd[:10]


def test_no_media_clues(deck):
    media = re.compile(r"clue crew|\[[^\]]*\]|seen here|shown here|pictured here|"
                       r"heard here|highlighted here", re.I)
    for _band, cell in _cells(deck):
        assert not media.search(cell[1]), cell


def test_answers_are_typeable(deck):
    for _band, (_cat, _clue, ans) in _cells(deck):
        assert re.search(r"[A-Za-z0-9]", ans), ans
        assert ans.count("(") == ans.count(")"), ans
        short = re.sub(r"\([^)]*\)", "", ans)
        assert len(short) <= 34, ans


def test_every_answer_matches_itself(deck):
    # the stored answer, and its short form without (optional) parts, must be
    # accepted by the game's matcher
    for _band, (_cat, _clue, ans) in _cells(deck):
        assert questions.check_jeopardy(ans, ans), ans
        short = re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", "", ans)).strip()
        if short:
            assert questions.check_jeopardy(short, ans), ans


def test_cleaner_is_idempotent(deck):
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    try:
        import clean_jeopardy
    finally:
        sys.path.pop(0)
    out, stats, _ = clean_jeopardy.clean(deck)
    assert not stats, dict(stats)
    assert out == deck

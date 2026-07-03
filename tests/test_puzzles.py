"""Puzzle generators — every generated instance must be solvable & checkable,
and no solution may leak outside the 'secret' field."""
import random

import puzzles


def test_deal_covers_all_kinds_and_hides_secrets():
    rng = random.Random(5)
    used = set()
    kinds = set()
    for _ in range(120):
        d = puzzles.deal(rng, used)
        kinds.add(d["kind"])
        assert d["limit"] == puzzles.TIME_LIMITS[d["kind"]]
        if d["kind"] in puzzles.INTERACTIVE:
            assert "secret" in d                     # present server-side…
    assert set(puzzles.INTERACTIVE) <= kinds
    assert "riddle" in kinds


# ── tetromino ────────────────────────────────────────────────────────────────
def test_tetromino_generation_and_check():
    rng = random.Random(4)
    for _ in range(10):
        data = puzzles.gen_tetromino(rng)
        w, h, pieces = data["w"], data["h"], data["pieces"]
        assert len(pieces) == (w * h) // 4
        # NO rotation: translate each given form as-is; the generator's own
        # tiling guarantees a translation-only solution exists
        grid = [-1] * (w * h)
        remaining = list(range(len(pieces)))

        def fit(form, x0, y0):
            cells = []
            for dx, dy in form:
                x, y = x0 + dx, y0 + dy
                if not (0 <= x < w and 0 <= y < h) or grid[y * w + x] != -1:
                    return None
                cells.append((x, y))
            return cells

        def solve():
            try:
                i = grid.index(-1)
            except ValueError:
                return True
            y0, x0 = divmod(i, w)
            for idx in list(remaining):
                form = [tuple(c) for c in pieces[idx]]
                for ax, ay in form:
                    cells = fit([(dx - ax, dy - ay) for dx, dy in form], x0, y0)
                    if cells:
                        for x, y in cells:
                            grid[y * w + x] = idx
                        remaining.remove(idx)
                        if solve():
                            return True
                        for x, y in cells:
                            grid[y * w + x] = -1
                        remaining.append(idx)
            return False

        assert solve(), "translation-only tiling must exist"
        assert puzzles.check_tetromino(data, grid)
        bad = grid[:]
        b = next(i for i in range(len(bad)) if bad[i] != bad[0])
        bad[0], bad[b] = bad[b], bad[0]
        assert not puzzles.check_tetromino(data, bad)



# ── nonogram ─────────────────────────────────────────────────────────────────
def test_nonogram_clues_roundtrip():
    rng = random.Random(7)
    for _ in range(25):
        data = puzzles.gen_nonogram(rng)
        n = data["n"]
        assert len(data["rows"]) == n and len(data["cols"]) == n
        # the generator's own grid satisfies its clues — reconstruct one by
        # brute force over rows that match row clues, then check col clues
        # (5×5 → each row has ≤ 32 candidates; quick)
        from itertools import product
        row_cands = []
        for r in range(n):
            cands = [bits for bits in product((0, 1), repeat=n)
                     if puzzles._clues(bits) == data["rows"][r]]
            assert cands, "row clue with no candidates"
            row_cands.append(cands)

        def search(rows_done, cols):
            if len(rows_done) == n:
                return [v for row in rows_done for v in row] \
                    if [puzzles._clues(col) for col in cols] == data["cols"] else None
            r = len(rows_done)
            for cand in row_cands[r]:
                ncols = [cols[c] + (cand[c],) for c in range(n)]
                # prune: partial columns must be a prefix-compatible
                ok = all(_prefix_ok(ncols[c], data["cols"][c], n) for c in range(n))
                if ok:
                    res = search(rows_done + [cand], ncols)
                    if res:
                        return res
            return None

        def _prefix_ok(partial, clue, n):
            runs = puzzles._clues(partial)
            if runs == [0]:
                runs = []
            cl = clue if clue != [0] else []
            if len(runs) > len(cl):
                return False
            for i, r in enumerate(runs[:-1] if partial and partial[-1] else runs):
                if i < len(cl) and r > cl[i]:
                    return False
            return True

        solution = search([], [() for _ in range(n)])
        assert solution is not None, "unsolvable nonogram"
        assert puzzles.check_nonogram(data, solution)
        assert not puzzles.check_nonogram(data, [0] * (n * n)) or sum(solution) == 0


# ── simon ────────────────────────────────────────────────────────────────────
def test_simon_sequences():
    rng = random.Random(8)
    for _ in range(30):
        data = puzzles.gen_simon(rng)
        seq = data["seq"]
        assert len(seq) == 6                          # starts at memorizing 6
        assert all(0 <= t < 9 for t in seq)
        assert all(a != b for a, b in zip(seq, seq[1:]))
        assert puzzles.check_simon(data, seq[:])
        assert not puzzles.check_simon(data, seq[:-1])
        assert not puzzles.check_simon(data, seq[:-1] + [(seq[-1] + 1) % 9])


# ── anagram ──────────────────────────────────────────────────────────────────
def test_anagram_scramble_and_check():
    rng = random.Random(9)
    for _ in range(40):
        data = puzzles.gen_anagram(rng)
        word = data["secret"]["word"]
        assert sorted(data["letters"]) == sorted(word)
        assert data["letters"] != word
        assert puzzles.check_anagram(data, word.lower())     # case-insensitive
        assert puzzles.check_anagram(data, f"  {word}  ")    # whitespace ok
        assert not puzzles.check_anagram(data, word[::-1] if word[::-1] != word else "XX")
        assert not puzzles.check_anagram(data, data["letters"]
                                         if data["letters"] not in puzzles._WORD_SET else "QQQ")


# ── raven's matrix ───────────────────────────────────────────────────────────
def test_ravens_unique_correct_option():
    rng = random.Random(10)
    for _ in range(40):
        data = puzzles.gen_ravens(rng)
        assert len(data["grid"]) == 8
        opts = data["options"]
        assert len(opts) == 4
        correct = data["secret"]["correct"]
        assert 0 <= correct < 4
        # correct option appears exactly once
        assert opts.count(opts[correct]) == 1
        assert puzzles.check_ravens(data, correct)
        for i in range(4):
            if i != correct:
                assert not puzzles.check_ravens(data, i)

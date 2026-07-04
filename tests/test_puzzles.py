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
    # every interactive kind turns up on the isles EXCEPT 'memory', which is a
    # battle-only tier-I puzzle (see puzzles.BATTLE_TIERS)
    assert set(puzzles.INTERACTIVE) - {"memory"} <= kinds
    assert "memory" not in kinds
    assert "riddle" in kinds


def test_battle_puzzles_are_tiered_and_exclude_slow_kinds():
    rng = random.Random(11)
    seen = {1: set(), 2: set(), 3: set()}
    for tier in (1, 2, 3):
        for _ in range(80):
            d = puzzles.deal_battle(rng, tier)
            seen[tier].add(d["kind"])
            assert d["limit"] == puzzles.TIME_LIMITS[d["kind"]]
    allkinds = seen[1] | seen[2] | seen[3]
    assert "anagram" not in allkinds and "tetromino" not in allkinds
    assert "memory" in seen[1]                    # the 4-item memory is tier I
    assert "nonogram" in seen[3]                  # picross is tier III
    assert "memory" not in seen[3] and "nonogram" not in seen[1]


def test_memory_puzzle_generate_and_check():
    rng = random.Random(2)
    d = puzzles.gen_memory(rng)
    assert d["pad"] == 4 and len(d["seq"]) == 4
    assert all(0 <= t < 4 for t in d["seq"])
    assert all(d["seq"][i] != d["seq"][i - 1] for i in range(1, 4))   # no repeats
    assert puzzles.check("memory", d, d["seq"])
    assert not puzzles.check("memory", d, [0, 0, 0, 0])   # repeats can't be the seq


# ── riddle (typed answer) ────────────────────────────────────────────────────
def test_riddle_typed_deal_and_check():
    rng = random.Random(3)
    used: set[int] = set()
    seen = 0
    for _ in range(400):
        d = puzzles.deal(rng, used)
        if d["kind"] != "riddle":
            continue
        seen += 1
        assert d["limit"] == puzzles.TIME_LIMITS["riddle"]
        assert isinstance(d["text"], str) and d["text"]
        assert d["category"]
        # answer lives ONLY in secret — never in the client-facing payload
        assert "answer" in d["secret"]
        assert "answer" not in {k for k in d if k != "secret"}
        ans = d["secret"]["answer"]
        assert puzzles.check("riddle", d, ans)
        assert puzzles.check("riddle", d, f"  The {ans.upper()}. ")   # normalized
        for alt in d["secret"]["accept"]:
            assert puzzles.check("riddle", d, alt)
        assert not puzzles.check("riddle", d, "zzzznotananswer")
        assert not puzzles.check("riddle", d, 123)                    # non-str rejected
    assert seen >= 3, "riddle should be dealt within 400 draws"


def test_riddle_pool_does_not_repeat_until_exhausted():
    rng = random.Random(1)
    used: set[int] = set()
    texts = []
    for _ in range(2000):
        d = puzzles.deal(rng, used)
        if d["kind"] == "riddle":
            texts.append(d["text"])
        if len(used) >= len(puzzles.RIDDLES):
            break
    # no repeat while the pool still has fresh riddles
    assert len(texts) == len(set(texts))


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


# ── sequence: "The Fates' Thread" (typed next term) ──────────────────────────
def test_sequence_answer_solves_and_wrong_rejected():
    rng = random.Random(11)
    for _ in range(30):
        data = puzzles.gen_sequence(rng)
        assert len(data["terms"]) >= 4
        ans = data["secret"]["answer"]
        # answer lives ONLY in secret — never in the client-facing payload
        assert "answer" not in {k for k in data if k != "secret"}
        assert puzzles.check_sequence(data, ans)
        assert puzzles.check_sequence(data, str(ans))          # typed string
        assert puzzles.check_sequence(data, f"  {ans} ")       # trimmed
        assert not puzzles.check_sequence(data, ans + 1)
        assert not puzzles.check_sequence(data, "not a number")
        assert not puzzles.check_sequence(data, None)


# ── lights out: "The Gorgon's Gaze" ──────────────────────────────────────────
def _solve_lights_out(board, n):
    """GF(2) solve: which cells to tap to clear the board. 16 vars for 4x4."""
    def idx(r, c):
        return r * n + c
    # augmented matrix: each equation is one cell's parity; each var is a tap
    rows = []
    for r in range(n):
        for c in range(n):
            eq = [0] * (n * n + 1)
            for rr, cc in ((r, c), (r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < n and 0 <= cc < n:
                    eq[idx(rr, cc)] = 1
            eq[-1] = board[r][c]
            rows.append(eq)
    m = n * n
    piv = []
    row = 0
    for col in range(m):
        sel = next((rr for rr in range(row, len(rows)) if rows[rr][col]), None)
        if sel is None:
            continue
        rows[row], rows[sel] = rows[sel], rows[row]
        for rr in range(len(rows)):
            if rr != row and rows[rr][col]:
                rows[rr] = [a ^ b for a, b in zip(rows[rr], rows[row])]
        piv.append((row, col))
        row += 1
    x = [0] * m
    for r, col in piv:
        x[col] = rows[r][-1]
    return [[i // n, i % n] for i in range(m) if x[i]]


def test_lights_out_solvable_and_rejects_wrong():
    rng = random.Random(12)
    for _ in range(30):
        data = puzzles.gen_lights_out(rng)
        n = data["n"]
        assert n == 4 and len(data["board"]) == n
        assert any(v for row in data["board"] for v in row)   # not already solved
        assert data["secret"] == {}                            # nothing hidden
        sol = _solve_lights_out(data["board"], n)
        assert puzzles.check_lights_out(data, sol)             # the solution clears it
        assert not puzzles.check_lights_out(data, [])          # doing nothing fails
        assert not puzzles.check_lights_out(data, "nope")      # malformed
        assert not puzzles.check_lights_out(data, [[9, 9]])    # out of bounds
        assert not puzzles.check_lights_out(data, [[0]])       # wrong shape


# ── sliding tile: "The Shifting Mosaic" ──────────────────────────────────────
def test_sliding_goal_solves_and_scramble_rejected():
    rng = random.Random(13)
    for _ in range(30):
        data = puzzles.gen_sliding(rng)
        assert sorted(data["board"]) == list(range(9))         # a real permutation
        assert data["goal"] == [1, 2, 3, 4, 5, 6, 7, 8, 0]
        assert data["board"] != data["goal"]                   # actually scrambled
        assert data["secret"] == {}
        assert puzzles.check_sliding(data, data["goal"])       # goal order solves it
        assert not puzzles.check_sliding(data, data["board"])  # scramble does not
        assert not puzzles.check_sliding(data, "nope")
        assert not puzzles.check_sliding(data, list(range(9)))

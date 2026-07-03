"""Puzzle generators — every generated instance must be solvable & checkable."""
import random

import puzzles


def test_sequence_options_contain_one_correct():
    rng = random.Random(1)
    for _ in range(60):
        q = puzzles.gen_sequence(rng)
        assert len(q["options"]) == 4
        assert len(set(q["options"])) == 4          # no duplicate options
        assert 0 <= q["correct"] < 4


def _inversions(tiles):
    seq = [t for t in tiles if t != 0]
    return sum(1 for i in range(len(seq)) for j in range(i + 1, len(seq))
               if seq[i] > seq[j])


def test_sliding_scrambles_are_solvable_by_parity():
    # a 3x3 eight-puzzle is solvable iff its inversion count is even —
    # cheap to verify for many scrambles
    rng = random.Random(2)
    for _ in range(40):
        data = puzzles.gen_sliding(rng)
        tiles = data["tiles"]
        assert sorted(tiles) == list(range(9))
        assert tiles != list(range(1, 9)) + [0]     # never starts solved
        assert _inversions(tiles) % 2 == 0, "unsolvable scramble generated"


def test_sliding_replay_checker_accepts_a_real_solution():
    # small scramble → tiny BFS finds the solution fast; replay must validate
    from collections import deque
    rng = random.Random(6)
    data = puzzles.gen_sliding(rng, scramble=10)
    goal = tuple(list(range(1, 9)) + [0])
    start = tuple(data["tiles"])
    seen = {start: None}
    dq = deque([start])
    while dq and goal not in seen:
        cur = dq.popleft()
        b = cur.index(0)
        r, c = divmod(b, 3)
        for m in (b - 3, b + 3, b - 1, b + 1):
            if not 0 <= m < 9:
                continue
            mr, mc = divmod(m, 3)
            if abs(mr - r) + abs(mc - c) != 1:
                continue
            nxt = list(cur)
            nxt[b], nxt[m] = nxt[m], nxt[b]
            nxt = tuple(nxt)
            if nxt not in seen:
                seen[nxt] = (cur, m)
                dq.append(nxt)
    assert goal in seen
    moves = []
    cur = goal
    while seen[cur] is not None:
        prev, m = seen[cur]
        moves.append(m)
        cur = prev
    moves.reverse()
    assert puzzles.check_sliding(data, moves)


def test_sliding_rejects_illegal_moves():
    data = {"tiles": [1, 2, 3, 4, 5, 6, 7, 0, 8]}
    assert not puzzles.check_sliding(data, [0])          # not adjacent to blank
    assert puzzles.check_sliding(data, [8])              # slide the 8 left → solved


def test_lightsout_generated_grids_check_out():
    rng = random.Random(3)
    for _ in range(30):
        data = puzzles.gen_lightsout(rng)
        assert any(data["grid"])                          # never starts solved
        # lights out is self-inverse: pressing every lit-generating press again solves.
        # find a solution by brute force over 2^16 (fine at 4x4… use linearity: chase)
        w, h = data["w"], data["h"]
        best = None
        for mask in range(2 ** w):                        # chase-light method
            grid = data["grid"][:]
            presses = []
            for c in range(w):
                if mask >> c & 1:
                    puzzles._toggle(grid, c, w, h)
                    presses.append(c)
            for r in range(1, h):
                for c in range(w):
                    if grid[(r - 1) * w + c]:
                        i = r * w + c
                        puzzles._toggle(grid, i, w, h)
                        presses.append(i)
            if not any(grid):
                best = presses
                break
        assert best is not None, "unsolvable lights-out generated"
        assert puzzles.check_lightsout(data, best)


def test_tetromino_generation_and_check():
    rng = random.Random(4)
    for _ in range(10):
        data = puzzles.gen_tetromino(rng)
        assert len(data["pieces"]) == (data["w"] * data["h"]) // 4
        # rebuild a correct assignment by re-tiling with the exact same pieces
        # (the generator guarantees one exists; find it by backtracking)
        w, h, pieces = data["w"], data["h"], data["pieces"]
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
                for form in puzzles.ROTATIONS[pieces[idx]]:
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

        assert solve(), "generated tetromino region cannot be re-tiled"
        assert puzzles.check_tetromino(data, grid)
        # sabotage: swapping two cells of different pieces must fail
        bad = grid[:]
        a = 0
        b = next(i for i in range(len(bad)) if bad[i] != bad[a])
        bad[a], bad[b] = bad[b], bad[a]
        assert not puzzles.check_tetromino(data, bad)


def test_deal_covers_all_kinds():
    rng = random.Random(5)
    used = set()
    kinds = {puzzles.deal(rng, used)["kind"] for _ in range(80)}
    assert {"sliding", "lightsout", "tetromino", "sequence"} <= kinds

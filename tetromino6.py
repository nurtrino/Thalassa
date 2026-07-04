"""6×6 tetromino puzzles (9 pieces, NO rotation). Same contract as puzzles.py.
Solvable by construction: region is tiled first (rotations only during
generation), pieces handed in placed orientation → translate only."""
import random

TETROMINOES = {
    "I": [(0, 0), (1, 0), (2, 0), (3, 0)], "O": [(0, 0), (1, 0), (0, 1), (1, 1)],
    "T": [(0, 0), (1, 0), (2, 0), (1, 1)], "S": [(1, 0), (2, 0), (0, 1), (1, 1)],
    "Z": [(0, 0), (1, 0), (1, 1), (2, 1)], "L": [(0, 0), (0, 1), (0, 2), (1, 2)],
    "J": [(1, 0), (1, 1), (1, 2), (0, 2)],
}


def _normalize(cells):
    xs = min(x for x, y in cells)
    ys = min(y for x, y in cells)
    return tuple(sorted((x - xs, y - ys) for x, y in cells))


def _rotations(shape):
    out, cur = [], list(shape)
    for _ in range(4):
        cur = [(y, -x) for x, y in cur]
        n = _normalize(cur)
        if n not in out:
            out.append(n)
    return out


ROTATIONS = {k: _rotations(v) for k, v in TETROMINOES.items()}


def gen_tetromino(rng, w=6, h=6):
    """Returns (public, solution). public = {"w","h","pieces","secret"};
    solution = flat cell->piece-index list of length w*h."""
    grid = [-1] * (w * h)
    forms = []

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
        names = list(ROTATIONS)
        rng.shuffle(names)
        for name in names:
            for form in ROTATIONS[name]:
                for ax, ay in form:
                    cells = fit([(dx - ax, dy - ay) for dx, dy in form], x0, y0)
                    if cells:
                        idx = len(forms)
                        for x, y in cells:
                            grid[y * w + x] = idx
                        forms.append(_normalize(cells))
                        if solve():
                            return True
                        for x, y in cells:
                            grid[y * w + x] = -1
                        forms.pop()
        return False

    solve()
    order = list(range(len(forms)))
    rng.shuffle(order)
    pieces = [[list(c) for c in forms[i]] for i in order]
    handed_of = {orig: new for new, orig in enumerate(order)}
    solution = [handed_of[grid[k]] for k in range(w * h)]
    return {"w": w, "h": h, "pieces": pieces, "secret": {}}, solution


def check_tetromino(data, assignment):
    w, h, pieces = data["w"], data["h"], data["pieces"]
    if not isinstance(assignment, list) or len(assignment) != w * h:
        return False
    groups = {}
    for i, v in enumerate(assignment):
        if not isinstance(v, int) or not 0 <= v < len(pieces):
            return False
        groups.setdefault(v, []).append((i % w, i // w))
    if len(groups) != len(pieces):
        return False
    for idx, cells in groups.items():
        want = tuple(sorted(tuple(c) for c in pieces[idx]))
        if len(cells) != 4 or _normalize(cells) != want:
            return False
    return True


def build_bank(n=20, seed=1000):
    out, seen, s = [], set(), 0
    while len(out) < n:
        pub, sol = gen_tetromino(random.Random(seed + s), 6, 6)
        s += 1
        if tuple(sol) in seen:
            continue
        seen.add(tuple(sol))
        out.append({"public": pub, "secret": {}, "solution": sol})
    return out


BANK = build_bank(20)


if __name__ == "__main__":
    assert len(BANK) == 20
    for inst in BANK:
        data = {**inst["public"], **inst["secret"]}
        assert len(inst["public"]["pieces"]) == 9
        assert check_tetromino(data, inst["solution"])
    print(f"tetromino6 OK — {len(BANK)} unique solvable 6x6 boards, 9 pieces each")

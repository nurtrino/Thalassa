"""
THALASSA — Pre-built puzzle bank.

10 vetted, solvable instances for every non-riddle puzzle kind, each with its
solution and a server-authoritative checker. Instances are produced by seeded
generators so the bank is reproducible and every instance is provably solvable
by construction (we tile / scramble-from-solved first, then hand the puzzle out).

Kinds covered (10 each):
    tetromino   nonogram   simon   ravens
    lights_out  mastermind sliding
    (+ anagram, sequence — the other authored typed-answer kinds)

Each instance is a dict:
    {"public": <sent to client>, "secret": <stripped in server.py>, "solution": <a valid answer>}

Every check_<kind>(data, answer) takes the MERGED public+secret dict (what the
server holds) and returns True/False (mastermind also exposes feedback()).

Run `python thalassa_puzzle_bank.py` to build the bank and run all self-tests.
"""

import random
from copy import deepcopy
from collections import Counter


# ════════════════════════════════════════════════════════════════════════
#  TETROMINO  — pack a (possibly masked) region with pre-oriented pieces
# ════════════════════════════════════════════════════════════════════════

_TETROMINOES = {
    "I": [(0, 0), (0, 1), (0, 2), (0, 3)],
    "O": [(0, 0), (0, 1), (1, 0), (1, 1)],
    "T": [(0, 0), (0, 1), (0, 2), (1, 1)],
    "S": [(0, 1), (0, 2), (1, 0), (1, 1)],
    "Z": [(0, 0), (0, 1), (1, 1), (1, 2)],
    "J": [(0, 0), (1, 0), (1, 1), (1, 2)],
    "L": [(0, 2), (1, 0), (1, 1), (1, 2)],
}


def _normalize(cells):
    mr = min(r for r, c in cells)
    mc = min(c for r, c in cells)
    return frozenset((r - mr, c - mc) for r, c in cells)


def _rotations(cells):
    out, cur = set(), set(cells)
    for _ in range(4):
        cur = {(c, -r) for r, c in cur}
        out.add(_normalize(cur))
    return out


def _canon(cells):
    """Rotation-invariant canonical form of a shape."""
    return min(_rotations(cells), key=lambda s: tuple(sorted(s)))


# all (name, oriented-shape) variants, used by the tiler
_ALL_ORIENTED = []
for _name, _base in _TETROMINOES.items():
    for _rot in _rotations(_base):
        _ALL_ORIENTED.append((_name, _rot))


def _tile_region(region, rng, fuel=200000):
    """Backtrack a full tiling of `region` (a set of cells). Returns list of
    (name, placed-cells) or None. Fuel guard keeps 6x6 fast."""
    region = set(region)
    counter = {"fuel": fuel}
    placements = []

    def solve(remaining):
        if not remaining:
            return True
        counter["fuel"] -= 1
        if counter["fuel"] < 0:
            return False
        target = min(remaining)  # top-left-most empty cell
        variants = _ALL_ORIENTED[:]
        rng.shuffle(variants)
        for name, shape in variants:
            for anchor in shape:  # align this shape cell onto target
                dr = target[0] - anchor[0]
                dc = target[1] - anchor[1]
                placed = {(r + dr, c + dc) for r, c in shape}
                if placed <= remaining:
                    placements.append((name, placed))
                    if solve(remaining - placed):
                        return True
                    placements.pop()
        return False

    return placements if solve(region) else None


def gen_tetromino(rng, region, rotatable=False):
    """Region is a set of (r,c). Returns an instance or None (retile failed)."""
    placed = _tile_region(region, rng, fuel=300000)
    if placed is None:
        return None
    cells = sorted(region)
    r0 = min(r for r, c in cells)
    c0 = min(c for r, c in cells)
    w = max(c for r, c in cells) - c0 + 1
    h = max(r for r, c in cells) - r0 + 1

    pieces, solution = [], {}
    order = list(range(len(placed)))
    rng.shuffle(order)
    for new_idx, old_idx in enumerate(order):
        name, pcells = placed[old_idx]
        # hand the player the piece in its own normalized frame
        handed = sorted(_normalize(pcells))
        pieces.append({"id": new_idx, "cells": [list(c) for c in handed]})
        for (r, c) in pcells:
            solution[f"{r-r0},{c-c0}"] = new_idx

    public = {
        "kind": "tetromino",
        "w": w, "h": h,
        "region": [[r - r0, c - c0] for r, c in cells],
        "pieces": pieces,
        "rotatable": rotatable,
    }
    return {"public": public, "secret": {}, "solution": solution}


def check_tetromino(data, assignment):
    """assignment: {"r,c": piece_id}. Region tiled once, each piece-group a
    rotation of the shape that was handed out."""
    region = {tuple(c) for c in data["region"]}
    # allowed shapes = canonical forms of handed pieces, as a multiset
    want = Counter(_canon([tuple(c) for c in p["cells"]]) for p in data["pieces"])

    groups = {}
    covered = []
    for key, pid in assignment.items():
        r, c = (int(x) for x in key.split(","))
        groups.setdefault(pid, []).append((r, c))
        covered.append((r, c))

    if sorted(covered) != sorted(region):      # exact cover, no overlaps/gaps
        return False
    if len(covered) != len(set(covered)):
        return False

    got = Counter()
    for pid, cells in groups.items():
        if len(cells) != 4:
            return False
        got[_canon(cells)] += 1
    return got == want


# ════════════════════════════════════════════════════════════════════════
#  NONOGRAM — 5x5 picross, half pre-revealed
# ════════════════════════════════════════════════════════════════════════

def _line_clue(line):
    runs, run = [], 0
    for v in line:
        if v:
            run += 1
        elif run:
            runs.append(run); run = 0
    if run:
        runs.append(run)
    return runs


def gen_nonogram(rng, n=5, density=0.55):
    grid = [[1 if rng.random() < density else 0 for _ in range(n)] for _ in range(n)]
    filled = sum(sum(row) for row in grid)
    if not (n + 2 <= filled <= n * n - 3):
        return None
    rows = [_line_clue(grid[r]) for r in range(n)]
    cols = [_line_clue([grid[r][c] for r in range(n)]) for c in range(n)]
    filled_cells = [(r, c) for r in range(n) for c in range(n) if grid[r][c]]
    rng.shuffle(filled_cells)
    given = sorted(filled_cells[: len(filled_cells) // 2])
    public = {"kind": "nonogram", "n": n, "row_clues": rows,
              "col_clues": cols, "given": [list(g) for g in given]}
    return {"public": public, "secret": {}, "solution": grid}


def check_nonogram(data, grid):
    n = data["n"]
    if len(grid) != n or any(len(row) != n for row in grid):
        return False
    if any(v not in (0, 1) for row in grid for v in row):
        return False
    for (r, c) in data["given"]:
        if grid[r][c] != 1:          # locked givens must stay filled
            return False
    rows = [_line_clue(grid[r]) for r in range(n)]
    cols = [_line_clue([grid[r][c] for r in range(n)]) for c in range(n)]
    return rows == data["row_clues"] and cols == data["col_clues"]


# ════════════════════════════════════════════════════════════════════════
#  SIMON — memorise a 9-pad sequence
# ════════════════════════════════════════════════════════════════════════

def gen_simon(rng, length=6, pads=9):
    seq = []
    while len(seq) < length:
        t = rng.randrange(pads)
        if not seq or t != seq[-1]:
            seq.append(t)
    public = {"kind": "simon", "pads": pads, "sequence": seq}  # public: client flashes it
    return {"public": public, "secret": {}, "solution": list(seq)}


def check_simon(data, taps):
    return list(taps) == list(data["sequence"])


# ════════════════════════════════════════════════════════════════════════
#  RAVEN'S MATRIX — 3x3, pick the missing 9th glyph
# ════════════════════════════════════════════════════════════════════════

_ATTRS = ("shape", "count", "fill")   # each in 0..2


def _rule_value(kind, base, r, c):
    if kind == "row":
        return (base + r) % 3
    if kind == "col":
        return (base + c) % 3
    return (base + r + c) % 3          # latin


def gen_ravens(rng):
    rules = {a: (rng.choice(("row", "col", "latin")), rng.randrange(3)) for a in _ATTRS}

    def cell(r, c):
        return tuple(_rule_value(rules[a][0], rules[a][1], r, c) for a in _ATTRS)

    grid = [[cell(r, c) for c in range(3)] for r in range(3)]
    answer = grid[2][2]

    options = [answer]
    guard = 0
    while len(options) < 4 and guard < 200:
        guard += 1
        mut = list(answer)
        i = rng.randrange(3)
        mut[i] = (mut[i] + rng.choice((1, 2))) % 3
        mut = tuple(mut)
        if mut not in options:
            options.append(mut)
    if len(options) < 4:
        return None
    rng.shuffle(options)
    ans_idx = options.index(answer)

    cells = [list(grid[r][c]) for r in range(3) for c in range(3)][:8]  # first 8
    public = {"kind": "ravens", "cells": cells,
              "options": [list(o) for o in options]}
    return {"public": public, "secret": {"answer": ans_idx}, "solution": ans_idx}


def check_ravens(data, choice):
    return int(choice) == int(data["answer"])


# ════════════════════════════════════════════════════════════════════════
#  LIGHTS-OUT — clear the grid; tap flips a cell + orthogonal neighbours
# ════════════════════════════════════════════════════════════════════════

def _lo_toggle(board, n, r, c):
    for dr, dc in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        rr, cc = r + dr, c + dc
        if 0 <= rr < n and 0 <= cc < n:
            board[rr][cc] ^= 1


def gen_lights_out(rng, n=4, depth=5):
    counts = Counter()
    for _ in range(depth):
        counts[(rng.randrange(n), rng.randrange(n))] += 1
    solution = sorted(cell for cell, k in counts.items() if k % 2)
    if not solution:                    # already solved -> reroll
        return None
    board = [[0] * n for _ in range(n)]
    for (r, c) in solution:
        _lo_toggle(board, n, r, c)
    public = {"kind": "lights_out", "n": n, "board": board}
    return {"public": public, "secret": {}, "solution": [list(c) for c in solution]}


def check_lights_out(data, taps):
    n = data["n"]
    board = deepcopy(data["board"])
    for (r, c) in taps:
        if not (0 <= r < n and 0 <= c < n):
            return False
        _lo_toggle(board, n, r, c)
    return all(v == 0 for row in board for v in row)


# ════════════════════════════════════════════════════════════════════════
#  MASTERMIND — deduce a 4-slot colour code
# ════════════════════════════════════════════════════════════════════════

def mastermind_feedback(code, guess):
    """Returns (black, white). Black = right colour & place; white = right
    colour, wrong place. Standard non-double-counting rules."""
    black = sum(a == b for a, b in zip(code, guess))
    cc, gc = Counter(code), Counter(guess)
    total = sum(min(cc[k], gc[k]) for k in cc)
    return black, total - black


def gen_mastermind(rng, slots=4, colors=6, max_guesses=8):
    code = [rng.randrange(colors) for _ in range(slots)]
    public = {"kind": "mastermind", "slots": slots, "colors": colors,
              "max_guesses": max_guesses}
    return {"public": public, "secret": {"code": code}, "solution": list(code)}


def check_mastermind(data, guess):
    """A submitted guess solves it iff it equals the code (4 black pegs)."""
    if len(guess) != data["slots"]:
        return False
    black, _ = mastermind_feedback(data["code"], list(guess))
    return black == data["slots"]


# ════════════════════════════════════════════════════════════════════════
#  SLIDING TILE — restore a 3x3 glyph (0 = blank)
# ════════════════════════════════════════════════════════════════════════

_SLIDE_GOAL = [1, 2, 3, 4, 5, 6, 7, 8, 0]


def _slide_moves(board):
    z = board.index(0)
    r, c = divmod(z, 3)
    out = []
    for dr, dc, name in ((-1, 0, "U"), (1, 0, "D"), (0, -1, "L"), (0, 1, "R")):
        nr, nc = r + dr, c + dc
        if 0 <= nr < 3 and 0 <= nc < 3:
            out.append((nr * 3 + nc, name))
    return out


def gen_sliding(rng, scramble=25):
    board = list(_SLIDE_GOAL)
    blank_path = [board.index(0)]            # b0, b1, ... bk  (blank position each step)
    last_blank = None
    for _ in range(scramble):
        z = board.index(0)
        neighbors = [pos for pos, _ in _slide_moves(board)]
        opts = [p for p in neighbors if p != last_blank] or neighbors
        pos = rng.choice(opts)               # tile clicked -> slides into blank
        last_blank = z
        board[z], board[pos] = board[pos], board[z]
        blank_path.append(pos)               # blank is now at `pos`
    if board == _SLIDE_GOAL:                 # too-easy shuffle -> reroll
        return None
    public = {"kind": "sliding", "board": board, "goal": list(_SLIDE_GOAL)}
    # to solve, walk the blank back down its path: click b_{k-1}, ... , b0
    solution = list(reversed(blank_path[:-1]))
    return {"public": public, "secret": {}, "solution": solution}


def _apply_slide(board, click_pos):
    z = board.index(0)
    if click_pos in {p for p, _ in _slide_moves(board)}:
        board[z], board[click_pos] = board[click_pos], board[z]
        return True
    return False


def check_sliding(data, board_or_moves, as_moves=False):
    """Accepts either a final board (default) or a list of blank-swap click
    positions to replay from the start."""
    if as_moves:
        board = list(data["board"])
        for pos in board_or_moves:
            if not _apply_slide(board, pos):
                return False
        return board == data["goal"]
    return list(board_or_moves) == data["goal"]


# ════════════════════════════════════════════════════════════════════════
#  ANAGRAM — unscramble a themed word (typed)
# ════════════════════════════════════════════════════════════════════════

_ANAGRAM_WORDS = [
    ("trident", []), ("harpoon", []), ("mariner", []), ("compass", []),
    ("odyssey", []), ("kraken", []), ("nautilus", []), ("leviathan", []),
    ("aegean", []), ("admiral", []),
]
# (word, extra-accepted anagrams-from-same-letters); most have none


def gen_anagram(rng, entry):
    word, accept = entry
    letters = list(word)
    scrambled = word
    while scrambled == word:
        rng.shuffle(letters)
        scrambled = "".join(letters)
    public = {"kind": "anagram", "scramble": scrambled, "length": len(word)}
    secret = {"answer": word, "accept": accept}
    return {"public": public, "secret": secret, "solution": word}


def check_anagram(data, guess):
    g = "".join((guess or "").split()).lower()
    valid = {data["answer"].lower(), *(a.lower() for a in data.get("accept", []))}
    return g in valid


# ════════════════════════════════════════════════════════════════════════
#  SEQUENCE — "The Fates' Thread": type the next term
# ════════════════════════════════════════════════════════════════════════

_SEQUENCES = [
    ([2, 4, 6, 8, 10], 12, "add 2"),
    ([3, 6, 12, 24], 48, "double"),
    ([1, 1, 2, 3, 5, 8], 13, "Fibonacci"),
    ([1, 4, 9, 16, 25], 36, "square numbers"),
    ([2, 3, 5, 7, 11], 13, "primes"),
    ([1, 3, 6, 10, 15], 21, "triangular numbers"),
    ([100, 90, 81, 73, 66], 60, "subtract 10, 9, 8, 7 ..."),
    ([1, 2, 4, 7, 11], 16, "add 1, 2, 3, 4 ..."),
    ([81, 27, 9, 3], 1, "divide by 3"),
    ([1, 8, 27, 64], 125, "cube numbers"),
]


def gen_sequence(rng, entry):
    terms, answer, rule = entry
    public = {"kind": "sequence", "terms": list(terms)}
    secret = {"answer": answer, "rule": rule}
    return {"public": public, "secret": secret, "solution": answer}


def check_sequence(data, guess):
    try:
        return int(str(guess).strip()) == int(data["answer"])
    except (ValueError, TypeError):
        return False


# ════════════════════════════════════════════════════════════════════════
#  BUILD THE BANK — 10 vetted instances per kind, seeded & reproducible
# ════════════════════════════════════════════════════════════════════════

def _collect(gen, seed, count=10, tries=4000):
    """Call gen(rng) repeatedly until `count` non-None, deduped instances."""
    rng = random.Random(seed)
    out, seen = [], set()
    for _ in range(tries):
        inst = gen(rng)
        if inst is None:
            continue
        key = repr((inst["public"], inst["secret"]))
        if key in seen:
            continue
        seen.add(key)
        out.append(inst)
        if len(out) == count:
            break
    if len(out) < count:
        raise RuntimeError(f"only produced {len(out)}/{count}")
    return out


def _rect(w, h):
    return {(r, c) for r in range(h) for c in range(w)}


def _build_tetromino():
    rng = random.Random(700)
    regions = [
        _rect(4, 4), _rect(4, 4), _rect(4, 4), _rect(4, 4),   # easy 4-piece
        _rect(6, 4), _rect(6, 4), _rect(4, 6),                # 6-piece
        _rect(6, 4), _rect(4, 6), _rect(6, 4),                # more 6-piece
    ]
    rots = [False, False, False, False, True, True, True, True, True, True]
    out = []
    for region, rot in zip(regions, rots):
        inst = None
        while inst is None:
            inst = gen_tetromino(rng, region, rotatable=rot)
        out.append(inst)
    return out


BANKS = {
    "tetromino":  _build_tetromino(),
    "nonogram":   _collect(lambda r: gen_nonogram(r), seed=101),
    "simon":      _collect(lambda r: gen_simon(r), seed=202),
    "ravens":     _collect(lambda r: gen_ravens(r), seed=303),
    "lights_out": _collect(lambda r: gen_lights_out(r), seed=404),
    "mastermind": _collect(lambda r: gen_mastermind(r), seed=505),
    "sliding":    _collect(lambda r: gen_sliding(r), seed=606),
    "anagram":    [gen_anagram(random.Random(800 + i), e)
                   for i, e in enumerate(_ANAGRAM_WORDS)],
    "sequence":   [gen_sequence(random.Random(900 + i), e)
                   for i, e in enumerate(_SEQUENCES)],
}

_CHECKERS = {
    "tetromino": check_tetromino, "nonogram": check_nonogram, "simon": check_simon,
    "ravens": check_ravens, "lights_out": check_lights_out,
    "mastermind": check_mastermind, "sliding": check_sliding,
    "anagram": check_anagram, "sequence": check_sequence,
}


def merged(inst):
    """What the server holds: public + secret. (server.py strips secret before send.)"""
    return {**inst["public"], **inst["secret"]}


# ════════════════════════════════════════════════════════════════════════
#  SELF-TESTS
# ════════════════════════════════════════════════════════════════════════

def _wrong_answer(kind, inst):
    """Produce a definitely-invalid answer for negative testing."""
    sol = inst["solution"]
    if kind == "tetromino":
        bad = dict(inst["solution"])
        # move one cell into a different piece so two groups are malformed
        keys = list(bad)
        k0 = keys[0]
        other = next(k for k in keys if bad[k] != bad[k0])
        bad[k0] = bad[other]
        return bad
    if kind == "nonogram":
        g = [[0] * inst["public"]["n"] for _ in range(inst["public"]["n"])]
        return g
    if kind == "simon":
        return list(reversed(sol)) if sol[0] != sol[-1] else sol[:-1]
    if kind == "ravens":
        return (sol + 1) % 4
    if kind == "lights_out":
        return []                       # do nothing -> board stays lit
    if kind == "mastermind":
        bad = list(sol); bad[0] = (bad[0] + 1) % inst["public"]["colors"]; return bad
    if kind == "sliding":
        return list(inst["public"]["board"])   # unsolved start
    if kind == "anagram":
        return "zzzzzzzz"
    if kind == "sequence":
        return sol + 1
    return None


def run_self_tests():
    total = 0
    for kind, bank in BANKS.items():
        assert len(bank) == 10, f"{kind}: {len(bank)} instances, want 10"
        check = _CHECKERS[kind]
        for i, inst in enumerate(bank):
            data = merged(inst)
            # 1) the stored solution must validate
            if kind == "sliding":
                assert check(data, inst["solution"], as_moves=True), f"{kind}[{i}] solution (moves) failed"
                assert check(data, data["goal"]), f"{kind}[{i}] goal board failed"
            else:
                assert check(data, inst["solution"]), f"{kind}[{i}] solution failed"
            # 2) a wrong answer must be rejected
            wrong = _wrong_answer(kind, inst)
            if kind == "sliding":
                assert not check(data, wrong), f"{kind}[{i}] accepted wrong board"
            else:
                assert not check(data, wrong), f"{kind}[{i}] accepted wrong answer"
            # 3) secret must never appear in the public payload
            for skey in inst["secret"]:
                assert skey not in inst["public"], f"{kind}[{i}] leaks '{skey}'"
            total += 1
    return total


if __name__ == "__main__":
    print("THALASSA puzzle bank")
    print("=" * 52)
    for kind, bank in BANKS.items():
        print(f"  {len(bank):2d}  {kind}")
    n = run_self_tests()
    print("=" * 52)
    print(f"{len(BANKS)} kinds x 10 = {sum(len(b) for b in BANKS.values())} instances")
    print(f"{n} instances passed all self-tests "
          "(solution validates, wrong answer rejected, no secret leak).")

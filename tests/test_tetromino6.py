import tetromino6, puzzles, random


def test_bank_solvable_and_strict():
    assert len(tetromino6.BANK) == 20
    for inst in tetromino6.BANK:
        data = {**inst["public"], **inst["secret"]}
        assert len(inst["public"]["pieces"]) == 9
        assert tetromino6.check_tetromino(data, inst["solution"])
        bad = list(inst["solution"])
        j = next(k for k in range(len(bad)) if bad[k] != bad[0])
        bad[0], bad[j] = bad[j], bad[0]
        assert not tetromino6.check_tetromino(data, bad)


def test_deal_yields_6x6_no_secret_leak():
    rng = random.Random(0)
    used = set()
    for _ in range(200):
        d = puzzles.deal(rng, used)
        if d["kind"] == "tetromino":
            assert d["w"] == 6 and d["h"] == 6 and len(d["pieces"]) == 9
            assert d["limit"] == 90
            assert "secret" not in {k for k in d if k != "secret"}
            break
    else:
        assert False, "no tetromino dealt"

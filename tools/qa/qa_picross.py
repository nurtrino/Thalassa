"""Capture the STRIKE picross (5 givens) and the MAGIC picross (0 givens) in a
combat round — same 5x5 board, different toe-hold."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from tools.qa.harness import DevServer, browser_client, run   # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_out", "picross")


async def spawn_foe(c):
    await c.send({"type": "dev", "relics": True})               # hull cushion
    await c.send({"type": "dev", "fight": {"kind": "boss", "region": "warden"}},
                 settle=900)


async def reach_picross(c, stance):
    """Fish for the nonogram: force puzzle mode + the stance; on ANY other puzzle
    just respawn a fresh fight and redraw (a wrong solve on the non-one-shot
    battle puzzles is rejected, not failed, so we can't 'skip' them otherwise)."""
    await spawn_foe(c)
    for _ in range(80):
        r = await c.room()
        ph = r["phase"]
        mk = (r.get("minigame") or {}).get("kind")
        if ph == "minigame" and mk == "nonogram":
            return r["minigame"]
        if ph == "minigame":
            await spawn_foe(c)                          # wrong puzzle — redraw
        elif ph == "battle":
            await c.send({"type": "dev", "battle_mode": "puzzle"})
            await c.send({"type": "stance", "stance": stance, "target": 0}, settle=600)
        elif ph == "dodge":
            await c.send({"type": "dodge", "hit": False}, settle=600)
        elif ph == "reveal":
            await c.page.wait_for_timeout(1200)
        else:
            await spawn_foe(c)
    return None


async def main():
    with DevServer() as srv:
        async with browser_client(srv.url, name="Odysseus") as c:
            await c.settle_to_roll(rounds=3)

            mg = await reach_picross(c, "attack")
            print("STRIKE picross givens:", len(mg["given"]) if mg else None,
                  "n:", mg and mg["n"], "limit:", mg and mg["limit"])
            await c.page.wait_for_timeout(500)
            await c.shot(os.path.join(OUT, "strike_5given.png"), delay=250)

            # clear this puzzle, then go again for MAGIC
            await c.send({"type": "solve", "payload": []}, settle=900)
            mg = await reach_picross(c, "magic")
            print("MAGIC picross givens:", len(mg["given"]) if mg else None,
                  "n:", mg and mg["n"], "limit:", mg and mg["limit"])
            await c.page.wait_for_timeout(500)
            await c.shot(os.path.join(OUT, "magic_0given.png"), delay=250)
            print("errors:", [e for e in c.errors if "favicon" not in e][:6])


run(main())

"""Fail the Sphinx's riddle and confirm the diorama swaps her out for the
real guard pack (she must vanish; her Sand Raiders take her place)."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from tools.qa.harness import DevServer, browser_client, run   # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_out", "sphinx_fail")


async def main():
    with DevServer() as srv:
        async with browser_client(srv.url, name="Odysseus") as c:
            await c.teleport_region("desert", land=False, settle=2500)
            await c.wait_ship_settled()
            nodes = await c.page.evaluate(
                "() => window.__room.board.nodes"
                ".filter(n => n.region === 'desert' && n.type === 'sea')"
                ".map(n => n.id)")
            hit = None
            for nid in nodes:
                await c.teleport(nid, land=True, settle=1500)
                r = await c.room()
                if r["phase"] == "minigame" and (r.get("minigame") or {}).get("sphinx"):
                    hit = nid
                    break
                await c.settle_to_roll(rounds=4)
            print("sphinx gate:", hit)
            await c.wait_ship_settled()
            await c.page.wait_for_function(
                "() => window.__world.currentStage() === 'battle'", timeout=8000)
            await c.page.wait_for_timeout(1200)          # let her intro pass
            print("before:", (await c.room())["battle"]["name"])
            await c.shot(os.path.join(OUT, "1_before_riddle.png"), delay=200)

            # answer WRONG — one shot, no retry: she springs her guard
            await c.send({"type": "solve", "payload": "wrong-answer"}, settle=1600)
            r = await c.room()
            print("after phase:", r["phase"], "foe:", (r.get("battle") or {}).get("name"))
            await c.page.wait_for_timeout(1200)
            await c.shot(os.path.join(OUT, "2_after_fail.png"), delay=200)
            print("errors:", [e for e in c.errors if "favicon" not in e][:8])


run(main())

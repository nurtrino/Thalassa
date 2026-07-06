"""Snapshot a desert haven — confirm no little palm trees ring the oasis /
tents anymore, just the pool, reeds and tents."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from tools.qa.harness import DevServer, browser_client, run   # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_out", "haven")


async def main():
    with DevServer() as srv:
        async with browser_client(srv.url, name="Odysseus") as c:
            await c.teleport_region("desert", land=False, settle=2500)
            await c.wait_ship_settled()
            havens = await c.page.evaluate(
                "() => window.__room.board.nodes"
                ".filter(n => n.region === 'desert' && n.type === 'haven')"
                ".map(n => n.id)")
            print("desert havens:", havens)
            if not havens:
                print("!! no desert haven found")
                return
            await c.teleport(havens[0], land=True, settle=2000)
            await c.wait_ship_settled()
            await c.page.wait_for_timeout(900)
            await c.shot(os.path.join(OUT, "haven.png"), delay=250)
            print("errors:", [e for e in c.errors if "favicon" not in e][:8])


run(main())

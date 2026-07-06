"""Snapshot the Bleached Reach: confirm no ridge crescent, no sun/shimmer —
just bare sand into haze."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from tools.qa.harness import DevServer, browser_client, run   # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_out", "desert")


async def main():
    with DevServer() as srv:
        async with browser_client(srv.url, name="Odysseus") as c:
            await c.teleport_region("desert", land=False, settle=2600)
            await c.wait_ship_settled()
            await c.page.wait_for_timeout(800)
            await c.shot(os.path.join(OUT, "reach.png"), delay=200)
            # pan the camera around to check the whole horizon ring
            for i, key in enumerate(["ArrowLeft", "ArrowLeft", "ArrowRight",
                                     "ArrowRight", "ArrowRight", "ArrowRight"]):
                await c.page.keyboard.press(key)
            await c.page.wait_for_timeout(600)
            await c.shot(os.path.join(OUT, "reach_panned.png"), delay=200)
            print("errors:", [e for e in c.errors if "favicon" not in e][:8])


run(main())

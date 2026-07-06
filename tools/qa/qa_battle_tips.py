"""Hover each battle action and confirm a styled tooltip explains its terms."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from tools.qa.harness import DevServer, browser_client, run   # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_out", "battletips")


async def main():
    with DevServer() as srv:
        async with browser_client(srv.url, name="Odysseus") as c:
            await c.settle_to_roll(rounds=3)
            # a pack so FLEE is offered too; give scrolls so it isn't disabled
            await c.send({"type": "dev", "scrolls": 20})
            await c.send({"type": "dev",
                          "fight": {"kind": "pack", "tier": 0, "count": 1}}, settle=1200)
            await c.wait_ship_settled()
            await c.page.wait_for_timeout(800)

            labels = await c.page.evaluate(
                "() => [...document.querySelectorAll('#bactions button')]"
                ".map(b => b.getAttribute('aria-label'))")
            print("tips:")
            for t in labels:
                print("  -", t)

            # hover STRIKE and MAGIC and FLEE, capturing the tooltip each time
            for i, name in [(0, "strike"), (1, "magic")]:
                await c.page.hover(f"#bactions button:nth-child({i + 1})")
                await c.page.wait_for_timeout(350)
                await c.shot(os.path.join(OUT, f"{name}.png"), delay=150)
            # flee is the last battlebtn (ghost); hover it
            await c.page.hover("#bactions .flee")
            await c.page.wait_for_timeout(350)
            await c.shot(os.path.join(OUT, "flee.png"), delay=150)
            print("errors:", [e for e in c.errors if "favicon" not in e][:6])


run(main())

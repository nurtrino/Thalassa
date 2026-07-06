"""Capture the Sphinx ambush choreography: the flash, the held sphinx +
spoken terms, then the riddle scroll."""
import asyncio
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from tools.qa.harness import DevServer, browser_client, run   # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_out", "sphinx")


async def main():
    with DevServer() as srv:
        async with browser_client(srv.url, name="Odysseus") as c:
            # load the desert stage, then hunt its sea stops for a Sphinx gate
            await c.teleport_region("desert", land=False, settle=2500)
            await c.wait_ship_settled()
            nodes = await c.page.evaluate(
                "() => window.__room.board.nodes"
                ".filter(n => n.region === 'desert' && n.type === 'sea')"
                ".map(n => n.id)")
            print("desert sea stops:", nodes)

            hit = None
            for nid in nodes:
                await c.teleport(nid, land=True, settle=1500)
                r = await c.room()
                if r["phase"] == "minigame" and (r.get("minigame") or {}).get("sphinx"):
                    hit = nid
                    break
                # not her — clear whatever we landed in and try the next stop
                await c.settle_to_roll(rounds=4)
            print("sphinx gate:", hit)
            if not hit:
                print("!! no sphinx gate reached")
                return

            # let the ship finish sailing up so the battle diorama is on stage
            # (it's held until arrival), then replay the intro from a known t0
            await c.wait_ship_settled()
            await c.page.wait_for_function(
                "() => window.__world.currentStage() === 'battle'", timeout=8000)
            await c.page.wait_for_timeout(600)
            await c.page.evaluate("() => window.__beginSphinxAmbush "
                                  "&& window.__beginSphinxAmbush()")

            async def probe(t):
                return await c.page.evaluate(
                    "() => ({announce: !!document.querySelector('[style*=\"z-index:19\"]'),"
                    " speak: !!document.querySelector('.sphinxspeak'),"
                    " speakIn: !!document.querySelector('.sphinxspeak.in'),"
                    " modalHidden: document.getElementById('mgmodal')"
                    ".classList.contains('hidden')})")

            for label, wait in [("1_ambush_flash", 450), ("2_sphinx_speaks", 1100),
                                ("3_riddle", 1900)]:
                await c.page.wait_for_timeout(wait)
                print(label, await probe(wait))
                await c.shot(os.path.join(OUT, label + ".png"), delay=0)
            print("errors:", [e for e in c.errors if "favicon" not in e][:8])


run(main())

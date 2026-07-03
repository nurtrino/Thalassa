"""Smoke-shots of the world renderer via scenetest.html (no app.js needed)."""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

URL = os.environ.get("THALASSA_URL", "http://127.0.0.1:5071")
CHROME = "/opt/pw-browsers/chromium"


async def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/scene_shots"
    os.makedirs(outdir, exist_ok=True)
    errors = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=CHROME,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = await browser.new_page(viewport={"width": 1500, "height": 940})
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}")
                if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        await page.goto(f"{URL}/static/scenetest.html", wait_until="load")
        try:
            await page.wait_for_function("() => window.__ready", timeout=20000)
        except Exception:
            print("PAGE NEVER READY")
        await page.wait_for_timeout(3500)

        async def shot(name, delay=2500):
            await page.wait_for_timeout(delay)
            await page.screenshot(path=os.path.join(outdir, f"{name}.png"))
            print("shot", name)

        await shot("hub", 1500)

        fx = json.load(open("/home/user/Thalassa/static/fixture.json"))
        nodes = fx["room"]["board"]["nodes"]

        def first(pred):
            for n in nodes:
                if pred(n):
                    return n["id"]

        for realm in ("ice", "desert", "jungle", "autumn"):
            nid = first(lambda n: n.get("region") == realm
                        and n["type"] in ("sea", "haven", "monster"))
            if nid:
                await page.evaluate("id => window.__moveTo(id)", nid)
                await shot(f"realm_{realm}", 3200)

        # battle vs a pack (ice realm theme)
        await page.evaluate("""() => window.__battle({
          node: window.__room.board.nodes.find(n=>n.type==='lair'&&n.region==='ice').id,
          name: 'Frost Wolves', model: 'wolf', boss: false, region: 'ice',
          enemies: [
            {name:'Frost Wolf Ⅰ', hp:2, max_hp:2, power:1, model:'wolf'},
            {name:'Frost Wolf Ⅱ', hp:2, max_hp:2, power:1, model:'wolf'},
            {name:'Frost Wolf Ⅲ', hp:2, max_hp:2, power:1, model:'wolf'}],
        })""")
        await shot("battle_pack", 4000)
        await page.evaluate("() => window.__play('player_hit', {idx:1, dmg:3, stance:'magic'})")
        await shot("battle_hit", 900)
        await page.evaluate("() => window.__play('enemy_attack', {dmg:2, heavy:true})")
        await shot("battle_heavy", 900)

        # boss battle (desert colossus, on foot)
        await page.evaluate("""() => window.__battle({
          node: window.__room.board.nodes.find(n=>n.type==='lair'&&n.region==='desert').id,
          name: 'The Dune Colossus', model: 'colossus', boss: true, region: 'desert',
          charging: true, enraged: true,
          enemies: [{name:'The Dune Colossus', hp:7, max_hp:12, power:3, model:'colossus'}],
        })""")
        await shot("battle_boss", 4000)
        await page.evaluate("() => window.__play('charge_telegraph', {})")
        await shot("battle_charge", 1200)
        await page.evaluate("() => window.__endBattle()")
        await shot("after_battle", 2000)

        if errors:
            print("\n=== console errors (%d) ===" % len(errors))
            seen = set()
            for e in errors:
                k = e[:120]
                if k not in seen:
                    seen.add(k)
                    print(" ", e[:300])
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

"""Screenshot driver — boots the game in headless Chromium and captures
every major state for visual review.

    python tools/shoot.py [outdir] [scenario ...]

Scenarios: title lobby hub sail realm_ice realm_desert realm_jungle
           realm_autumn battle boss shop question uidemo
Requires the server running with DEV_CHEATS=1 TRIVIA_OFFLINE=1 on :5071
(tools/serve_dev.sh starts one), or set THALASSA_URL.
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

URL = os.environ.get("THALASSA_URL", "http://127.0.0.1:5071")
CHROME = "/opt/pw-browsers/chromium"


async def send(page, msg):
    await page.evaluate("m => window.__send(m)", msg)
    await page.wait_for_timeout(350)


async def room(page):
    return await page.evaluate("() => window.__room")


async def my_pid(page):
    return await page.evaluate("() => window.__you ?? null")


async def wait_phase(page, *phases, timeout=15000):
    await page.wait_for_function(
        "phases => window.__room && phases.includes(window.__room.phase)",
        arg=list(phases), timeout=timeout)


async def join_and_start(page):
    await page.goto(URL, wait_until="networkidle")
    await page.wait_for_timeout(1200)
    await page.fill("#nameInput", "Odysseus")
    await page.click("#joinBtn")
    await page.wait_for_timeout(800)
    await page.click("#startBtn")
    await wait_phase(page, "roll")
    await page.wait_for_timeout(1200)
    try:
        await page.click("#introGo", timeout=3000)   # dismiss the rules card
    except Exception:
        pass
    await page.wait_for_timeout(600)


def find_node(r, pred):
    for n in r["board"]["nodes"]:
        if pred(n):
            return n
    return None


async def teleport(page, node_id, land=False):
    await send(page, {"type": "dev", "node": node_id, "land": land})
    await page.wait_for_timeout(2500 if not land else 1500)


async def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots"
    wanted = set(sys.argv[2:])
    os.makedirs(outdir, exist_ok=True)

    def want(s):
        return not wanted or s in wanted

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=CHROME,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = await browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("console", lambda m: errors.append(m.text)
                if m.type in ("error",) else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        errors = []

        async def shot(name, delay=400):
            await page.wait_for_timeout(delay)
            await page.screenshot(path=os.path.join(outdir, f"{name}.png"))
            print("shot", name)

        if want("uidemo"):
            await page.goto(f"{URL}/static/uidemo.html", wait_until="load")
            await shot("uidemo", 900)

        if want("title"):
            await page.goto(URL, wait_until="networkidle")
            await shot("title", 2500)

        await join_and_start(page)
        if want("hub"):
            await shot("hub_roll", 1200)

        if want("sail"):
            await send(page, {"type": "roll"})
            await wait_phase(page, "sail", "roll", timeout=8000)
            await shot("sail_choices", 1800)
            r = await room(page)
            if r["phase"] == "sail" and r["reachable"]:
                await send(page, {"type": "sail",
                                  "node": list(r["reachable"])[0]})
                await shot("sailing", 1200)
                await page.wait_for_timeout(2500)

        r = await room(page)
        # settle whatever phase we ended in back to roll if possible
        for _ in range(4):
            r = await room(page)
            if r["phase"] in ("shrine", "haven", "shop"):
                await send(page, {"type": "pass"})
            elif r["phase"] == "battle":
                await send(page, {"type": "flee"})
            elif r["phase"] == "question":
                await send(page, {"type": "answer", "idx": 0})
                await page.wait_for_timeout(6500)
            elif r["phase"] == "minigame":
                await send(page, {"type": "solve", "payload": None})
                await page.wait_for_timeout(800)
            else:
                break

        # realm tours via teleport
        r = await room(page)
        for realm in ("ice", "desert", "jungle", "autumn"):
            if not want(f"realm_{realm}"):
                continue
            n = find_node(r, lambda n: n.get("region") == realm
                          and n["type"] in ("sea", "haven", "shrine"))
            if n:
                await teleport(page, n["id"])
                await shot(f"realm_{realm}", 2600)

        if want("shop"):
            n = find_node(r, lambda n: n["type"] == "shop")
            if n:
                await teleport(page, n["id"], land=True)
                await shot("shop", 1200)
                await send(page, {"type": "pass"})

        if want("question"):
            n = find_node(r, lambda n: n["type"] == "shrine"
                          and not n.get("region"))
            if n:
                await teleport(page, n["id"], land=True)
                await send(page, {"type": "wager", "tier": 2})
                await wait_phase(page, "question")
                await shot("question", 1500)
                await send(page, {"type": "answer", "idx": 1})
                await shot("reveal", 1500)
                await page.wait_for_timeout(6000)

        if want("battle"):
            r = await room(page)
            n = find_node(r, lambda n: n["type"] == "monster"
                          and (n.get("depth") or 0) >= 3)
            n = n or find_node(r, lambda n: n["type"] == "monster")
            if n:
                for attempt in range(4):     # ambush odds: retry until it bites
                    await teleport(page, n["id"], land=True)
                    rr = await room(page)
                    if rr["phase"] == "battle":
                        break
                await shot("battle_stance", 2600)
                rr = await room(page)
                if rr["phase"] == "battle":
                    await send(page, {"type": "stance", "stance": "magic"})
                    await wait_phase(page, "question", timeout=8000)
                    await shot("battle_question", 1200)
                    await send(page, {"type": "answer", "idx": 2})
                    await shot("battle_reveal", 2200)
                    await page.wait_for_timeout(7000)
                    rr = await room(page)
                    if rr["phase"] == "battle":
                        await send(page, {"type": "flee"})
                        await page.wait_for_timeout(1000)

        if want("boss"):
            r = await room(page)
            n = find_node(r, lambda n: n["type"] == "lair")
            if n:
                await teleport(page, n["id"], land=True)
                await shot("boss_battle", 3000)
                rr = await room(page)
                if rr["phase"] == "battle":
                    await send(page, {"type": "stance", "stance": "guard"})
                    await wait_phase(page, "question", timeout=8000)
                    await shot("boss_guard_question", 1000)

        if errors:
            print("\n=== console errors ===")
            for e in errors[:30]:
                print(" ", e[:300])
        with open(os.path.join(outdir, "console.json"), "w") as f:
            json.dump(errors, f, indent=1)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

"""QA harness — fresh dev servers and instrumented browser clients.

Every suite gets its OWN server (the game is one shared table in process
memory, so reusing a server bleeds state between suites) and its own
Chromium page with console/pageerror capture. The client knows how to get
past the two cinematics that poisoned earlier harnesses: the rules card
(#introGo) and the 42-second opening fly-over tour, which OWNS the stage
while it runs — screenshots taken without ending it show tour frames, not
the game.
"""
import asyncio
import contextlib
import os
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHROME = os.environ.get("QA_CHROME", "/opt/pw-browsers/chromium")
PYTHON = sys.executable


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DevServer:
    """A throwaway game server: offline questions, dev cheats, long timers."""

    def __init__(self, env=None):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.env = {**os.environ,
                    "TRIVIA_OFFLINE": "1", "DEV_CHEATS": "1",
                    "QUESTION_SECS": "3600", "BOT_TEMPO": "0.2",
                    **(env or {})}
        self.proc = None

    def start(self, timeout=30):
        self.proc = subprocess.Popen(
            [PYTHON, "-m", "uvicorn", "server:app",
             "--port", str(self.port), "--log-level", "warning"],
            cwd=ROOT, env=self.env,
            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                urllib.request.urlopen(self.url, timeout=1)
                return self
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError("dev server died on startup")
                time.sleep(0.3)
        raise RuntimeError("dev server never came up")

    def stop(self):
        if self.proc:
            self.proc.terminate()
            with contextlib.suppress(Exception):
                self.proc.wait(timeout=5)
            self.proc = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()


class Client:
    """One captain's browser. Wraps a Playwright page with game verbs."""

    def __init__(self, page, url):
        self.page = page
        self.url = url
        self.errors = []          # console errors + uncaught exceptions
        page.on("console", lambda m: self.errors.append(m.text)
                if m.type == "error" else None)
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.on("response", lambda r: self.errors.append(
            f"HTTP {r.status} {r.url}") if r.status >= 400 else None)

    # ── lifecycle ─────────────────────────────────────────────────────────
    async def join(self, name="Odysseus"):
        await self.page.goto(self.url, wait_until="networkidle")
        await self.page.wait_for_selector("#nameInput", timeout=15000)
        await self.page.fill("#nameInput", name)
        await self.page.click("#joinBtn")
        await self.page.wait_for_timeout(600)

    async def start_voyage(self):
        """Set sail if the table is still in the lobby (joining an already
        sailing table is fine too), dismiss the rules card, end the tour."""
        r = await self.room()
        if r and r.get("phase") == "lobby":
            await self.page.click("#startBtn")
        await self.wait_phase("roll", "sail", "battle", "question", "shrine",
                              "haven", "shop", "minigame")
        with contextlib.suppress(Exception):
            await self.page.click("#introGo", timeout=4000)
        await self.end_tour()
        await self.page.wait_for_timeout(400)

    async def end_tour(self):
        """Cut the opening fly-over short and wait for the real stage."""
        await self.page.evaluate(
            "() => window.__world && window.__world.tourActive()"
            " && window.__world.endTour()")
        # the final swoop-down cinematic still plays; a tap cuts it too
        await self.page.mouse.down()
        await self.page.mouse.up()
        await self.page.wait_for_function(
            "() => window.__world && !window.__world.tourActive()",
            timeout=8000)
        await self.page.wait_for_timeout(600)

    # ── state ─────────────────────────────────────────────────────────────
    async def room(self):
        return await self.page.evaluate("() => window.__room")

    async def me(self):
        return await self.page.evaluate(
            "() => window.__room.players.find(p => p.pid === window.__you)")

    async def stage(self):
        return await self.page.evaluate(
            "() => window.__world ? window.__world.currentStage() : null")

    async def send(self, msg, settle=350):
        await self.page.evaluate("m => window.__send(m)", msg)
        await self.page.wait_for_timeout(settle)

    async def wait_phase(self, *phases, timeout=15000):
        await self.page.wait_for_function(
            "ps => window.__room && ps.includes(window.__room.phase)",
            arg=list(phases), timeout=timeout)

    async def wait_ship_settled(self, timeout=20000):
        """Wait until no ship is mid-sail animation."""
        await self.page.wait_for_function(
            "() => window.__world && !window.__world.animating()",
            timeout=timeout)

    # ── actions ───────────────────────────────────────────────────────────
    async def teleport(self, node_id, land=False, settle=1800):
        await self.send({"type": "dev", "node": node_id, "land": land},
                        settle=settle)

    async def teleport_region(self, region, land=False, settle=2200):
        """Let the server pick the landing spot — required for the Amber
        Vale, whose stops are fogged out of the client snapshot."""
        await self.send({"type": "dev", "region": region, "node": "?",
                         "land": land}, settle=settle)

    async def settle_to_roll(self, rounds=10):
        """Drive whatever phase we're in back to a roll if possible. Battles
        are fled when affordable, otherwise fought round by round."""
        for _ in range(rounds):
            r = await self.room()
            ph = r["phase"]
            if ph in ("shrine", "haven", "shop", "trade", "puzzle_pick"):
                await self.send({"type": "pass"})
            elif ph == "battle":
                me = await self.me()
                if (me or {}).get("scrolls", 0) >= 2:
                    await self.send({"type": "flee"}, settle=1200)
                else:                      # can't afford to run — swing away
                    await self.send({"type": "dev", "battle_mode": "mc"})
                    await self.send({"type": "stance", "stance": "attack"})
            elif ph == "question":
                await self.send({"type": "answer", "idx": 0})
                await self.page.wait_for_timeout(6200)
            elif ph == "minigame":
                await self.send({"type": "solve", "payload": None},
                                settle=1200)
            elif ph == "upgrade_pick":
                r2 = await self.room()
                ups = (r2.get("upgrade_offer") or ["fitting"])
                await self.send({"type": "pick", "upgrade": ups[0]})
            else:
                return r
        return await self.room()

    async def shot(self, path, delay=400):
        await self.page.wait_for_timeout(delay)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        await self.page.screenshot(path=path)


@contextlib.asynccontextmanager
async def browser_client(url, name="Odysseus", width=1600, height=1000,
                         start=True, join=True):
    """A (optionally joined and sailing) client on a fresh page. join=False
    stays on the title screen without creating a player — important when a
    later client on the same server must be the host."""
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=CHROME,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = await browser.new_page(
            viewport={"width": width, "height": height})
        c = Client(page, url)
        if join:
            await c.join(name)
            if start:
                await c.start_voyage()
        else:
            await page.goto(url, wait_until="networkidle")
        try:
            yield c
        finally:
            await browser.close()


def run(coro):
    return asyncio.run(coro)

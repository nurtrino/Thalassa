"""The Thalassa QA pipeline — one command, one verdict.

    python tools/qa/run_qa.py [outdir] [suite ...]

Suites (default: all):
    unit          pytest engine/puzzle suites
    js            syntax-check every ES module
    board         static travel audit across many rolled charts
    smoke         server boots, title renders, zero console errors
    flow          join → set sail → roll → sail → land, phases verified
    realms        dev-teleport to every realm; rendered stage must match
    battle        pack fight: every stance answers a question and resolves
    sail_monitor  animated sails sampled for island clipping + duration
    visual        the screenshot set reviewers work from

Each suite runs against its OWN fresh server (the table is process-global
state). Output: <outdir>/report.md, report.json, shots/*.png. Exit 1 on
any FAIL.
"""
import asyncio
import contextlib
import datetime
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
from tools.qa import travel_audit                          # noqa: E402
from tools.qa.harness import ROOT, DevServer, browser_client  # noqa: E402

PY = sys.executable
RESULTS = []          # {suite, status, took, notes: [..], artifacts: [..]}


def record(suite, status, notes=None, artifacts=None, took=0.0):
    RESULTS.append({"suite": suite, "status": status, "took": round(took, 1),
                    "notes": notes or [], "artifacts": artifacts or []})
    mark = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}[status]
    print(f"{mark} {suite} ({took:.1f}s)")
    for n in (notes or [])[:8]:
        print(f"     {n}")


def suite(fn):
    """Isolate a suite: any exception is a FAIL, not a pipeline crash."""
    def run(outdir):
        t0 = time.time()
        try:
            fn(outdir)
        except Exception as e:  # noqa: BLE001 — report, don't die
            record(fn.__name__, "FAIL", [f"crashed: {e!r}"],
                   took=time.time() - t0)
    run.__name__ = fn.__name__
    return run


# ── static suites ─────────────────────────────────────────────────────────
@suite
def unit(outdir):
    t0 = time.time()
    r = subprocess.run([PY, "-m", "pytest", "tests/", "-q"],
                       cwd=ROOT, capture_output=True, text=True)
    tail = (r.stdout.strip().splitlines() or ["no output"])[-1]
    record("unit", "PASS" if r.returncode == 0 else "FAIL", [tail],
           took=time.time() - t0)


@suite
def js(outdir):
    t0 = time.time()
    r = subprocess.run(["node", "tools/checkjs.mjs"],
                       cwd=ROOT, capture_output=True, text=True)
    notes = [ln for ln in (r.stdout + r.stderr).splitlines() if ln.strip()]
    record("js", "PASS" if r.returncode == 0 else "FAIL", notes[:6],
           took=time.time() - t0)


@suite
def board(outdir):
    t0 = time.time()
    findings, hops = travel_audit.run(seeds=15)
    errs = [f for f in findings if f["sev"] == "ERROR"]
    warns = [f for f in findings if f["sev"] == "WARN"]
    notes = travel_audit.summarize(findings, hops, 15).splitlines()
    path = os.path.join(outdir, "travel_static.json")
    with open(path, "w") as fh:
        json.dump(findings, fh, indent=1)
    record("board", "FAIL" if errs else ("WARN" if warns else "PASS"),
           notes, [path], took=time.time() - t0)


# ── browser suites ────────────────────────────────────────────────────────
def shots_dir(outdir):
    d = os.path.join(outdir, "shots")
    os.makedirs(d, exist_ok=True)
    return d


def console_verdict(c, notes):
    """Console errors demote a suite to FAIL; returns the status."""
    errors = list(c.errors)
    if not errors:
        return "PASS"
    seen = []
    for e in errors:
        k = e[:110]
        if k not in seen:
            seen.append(k)
    notes += [f"console: {k}" for k in seen[:6]]
    if len(seen) > 6:
        notes.append(f"console: … {len(seen) - 6} more distinct errors")
    return "FAIL"


@suite
def smoke(outdir):
    t0 = time.time()

    async def go():
        notes = []
        with DevServer() as srv:
            async with browser_client(srv.url, start=False) as c:
                await c.page.wait_for_timeout(2500)
                await c.shot(os.path.join(shots_dir(outdir), "smoke_title.png"))
                status = console_verdict(c, notes)
        record("smoke", status, notes,
               [os.path.join(shots_dir(outdir), "smoke_title.png")],
               took=time.time() - t0)
    asyncio.run(go())


@suite
def flow(outdir):
    t0 = time.time()

    async def go():
        notes = []
        sd = shots_dir(outdir)
        with DevServer() as srv:
            async with browser_client(srv.url) as c:
                r = await c.room()
                assert r["phase"] == "roll", f"expected roll, got {r['phase']}"
                await c.shot(os.path.join(sd, "flow_hub.png"), delay=900)

                await c.send({"type": "roll"})
                await c.wait_phase("sail", "roll", timeout=10000)
                r = await c.room()
                if r["phase"] == "sail":
                    reach = list(r["reachable"] or [])
                    assert reach, "sail phase with nothing reachable"
                    notes.append(f"rolled {r.get('die')} → "
                                 f"{len(reach)} choices")
                    await c.shot(os.path.join(sd, "flow_sail.png"))
                    await c.send({"type": "sail", "node": reach[0]})
                    await c.wait_ship_settled()
                    notes.append("sail animated and settled")
                else:
                    notes.append("roll resolved instantly (event en route)")
                await c.settle_to_roll()
                r = await c.room()
                notes.append(f"settled back to phase={r['phase']}")
                status = console_verdict(c, notes)
        record("flow", status, notes, took=time.time() - t0)
    asyncio.run(go())


@suite
def realms(outdir):
    t0 = time.time()

    async def go():
        notes = []
        arts = []
        sd = shots_dir(outdir)
        bad = False
        with DevServer() as srv:
            async with browser_client(srv.url) as c:
                r = await c.room()
                nodes = r["board"]["nodes"]
                for realm in ("ice", "desert", "jungle", "autumn", "hub"):
                    # region teleports let the server resolve a stop — the
                    # only route into the fog-of-war Amber Vale
                    await c.teleport_region(
                        "hub" if realm == "hub" else realm, settle=2600)
                    # stage switches ride an ink fade and can queue; give the
                    # renderer a moment to catch up before calling mismatch
                    try:
                        await c.page.wait_for_function(
                            "want => window.__world.currentStage() === want",
                            arg=realm, timeout=9000)
                        stage = realm
                    except Exception:
                        stage = await c.stage()
                    ok = stage == realm
                    bad |= not ok
                    notes.append(f"{realm}: stage={stage} "
                                 f"{'✓' if ok else '✗ MISMATCH'}")
                    p = os.path.join(sd, f"realm_{realm}.png")
                    await c.shot(p, delay=1200)
                    arts.append(p)
                status = console_verdict(c, notes)
                if bad:
                    status = "FAIL"
        record("realms", status, notes, arts, took=time.time() - t0)
    asyncio.run(go())


async def _pick_fight(c, want_boss=False, tries=6):
    """Land on a monster node (or lair) until a battle actually starts.
    Hunting grounds only exist in the realms now — shallow ones first so
    the pack is beatable."""
    r = await c.room()
    if want_boss:
        pool = [n for n in r["board"]["nodes"] if n["type"] == "lair"]
    else:
        pool = sorted((n for n in r["board"]["nodes"]
                       if n["type"] == "monster"),
                      key=lambda n: n.get("depth") or 0)
    if not pool:
        return None
    for i in range(tries):
        n = pool[i % len(pool)]
        await c.teleport(n["id"], land=True, settle=1600)
        r = await c.room()
        if r["phase"] == "battle":
            return r
        await c.settle_to_roll()
    return None


@suite
def battle(outdir):
    t0 = time.time()

    async def go():
        notes = []
        arts = []
        sd = shots_dir(outdir)
        bad = False
        with DevServer() as srv:
            async with browser_client(srv.url) as c:
                r = await _pick_fight(c)
                if not r:
                    record("battle", "FAIL", ["never got ambushed in 6 lands"],
                           took=time.time() - t0)
                    return
                p = os.path.join(sd, "battle_stance.png")
                await c.shot(p, delay=2400)
                arts.append(p)

                # every stance must deal its challenge and resolve. Battles
                # draw from THREE decks (mc / jeopardy / puzzle); the dev
                # hook pins the deck so each path is tested deterministically.
                # A wrong move triggers the DODGE beat — the suite must see
                # it appear and resolve it.
                dodges = 0
                plans = [("attack", "mc"), ("magic", "jeopardy"),
                         ("attack", "puzzle")]
                for stance, deck in plans:
                    r = await c.room()
                    if r["phase"] != "battle":
                        r = await _pick_fight(c)
                        if not r:
                            notes.append(f"{stance}: no fight available")
                            bad = True
                            continue
                    await c.send({"type": "dev", "battle_mode": deck})
                    await c.send({"type": "stance", "stance": stance})
                    want = "minigame" if deck == "puzzle" else "question"
                    try:
                        await c.wait_phase(want, timeout=9000)
                    except Exception:
                        rr = await c.room()
                        notes.append(f"{stance}/{deck}: STALLED in "
                                     f"phase={rr['phase']} — no {want}")
                        bad = True
                        continue
                    resolve_ms = 12000
                    if deck == "mc":
                        await c.send({"type": "answer", "idx": 0})
                    elif deck == "jeopardy":
                        await c.send({"type": "answer_text", "text": "alpha"})
                    else:
                        # most puzzle kinds reject wrong submissions and only
                        # resolve on their own deadline — wait the limit out
                        r = await c.room()
                        limit = (r.get("minigame") or {}).get("limit") or 45
                        await c.send({"type": "solve", "payload": None})
                        resolve_ms = min(95, limit + 10) * 1000
                    try:
                        await c.wait_phase("battle", "roll", "reveal", "dodge",
                                           timeout=resolve_ms)
                    except Exception:
                        rr = await c.room()
                        notes.append(f"{stance}/{deck}: never resolved "
                                     f"(phase={rr['phase']})")
                        bad = True
                        continue
                    r = await c.room()
                    if r["phase"] == "dodge":     # the action beat appeared
                        dodges += 1
                        await c.send({"type": "dodge", "hit": True})
                        try:
                            await c.wait_phase("battle", "roll", "reveal",
                                               timeout=9000)
                        except Exception:
                            notes.append(f"{stance}/{deck}: dodge never "
                                         "resolved")
                            bad = True
                            continue
                    await c.page.wait_for_timeout(6500)   # reveal + fx settle
                    notes.append(f"{stance}/{deck}: dealt and resolved ✓")
                notes.append(f"dodge beats seen: {dodges}")
                if dodges == 0:
                    notes.append("no dodge beat ever appeared — is the "
                                 "counter-attack flow wired?")
                    bad = True

                status = console_verdict(c, notes)
                if bad:
                    status = "FAIL"
        record("battle", status, notes, arts, took=time.time() - t0)
    asyncio.run(go())


SAMPLER = """
() => {
  const T = window.__thalassa, W = window.__world;
  window.__qaClips = [];
  window.__qaLegs = [];
  let cur = null;
  const isles = {};
  const R = { home: 13.0, shrine: 10.0, puzzle: 10.0, haven: 11.0,
              shop: 10.0, monster: 11.0, lair: 14.0, pharos: 17.0 };
  for (const n of window.__room.board.nodes) {
    if (R[n.type]) isles[n.id] = { x: n.x, z: n.z, r: R[n.type] * 1.23,
                                   type: n.type, region: n.region || null };
  }
  window.__qaTick = setInterval(() => {
    const pid = W.animating();
    if (!pid) {
      if (cur) { cur.end = performance.now(); window.__qaLegs.push(cur); cur = null; }
      return;
    }
    const rec = T.ships[pid];
    if (!rec) return;
    const p = rec.root.position;
    if (!cur) cur = { pid, start: performance.now(), from: rec.prevNode || rec.node,
                      samples: 0 };
    cur.samples++;
    for (const [id, o] of Object.entries(isles)) {
      // berthing at the destination (or casting off from the origin) island
      // is not a clip — only THIRD islands count
      if (id === rec.node || id === cur.from) continue;
      const d = Math.hypot(p.x - o.x, p.z - o.z);
      if (d < o.r - 0.5) {
        const last = window.__qaClips[window.__qaClips.length - 1];
        if (!last || last.island !== id)
          window.__qaClips.push({ island: id, type: o.type, d: +d.toFixed(1),
                                  x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
      }
    }
  }, 50);
}
"""


@suite
def sail_monitor(outdir):
    t0 = time.time()

    async def go():
        notes = []
        bad = False
        with DevServer() as srv:
            async with browser_client(srv.url) as c:
                await c.page.evaluate(SAMPLER)
                r = await c.room()
                nodes = {n["id"]: n for n in r["board"]["nodes"]}
                sailed = 0
                # walk real rolls for a while — this is what players do
                you = await c.page.evaluate("() => window.__you")
                for _ in range(20):
                    r = await c.settle_to_roll()
                    if r["phase"] != "roll" or r["turn"] != you:
                        continue
                    await c.send({"type": "roll"})
                    await c.wait_phase("sail", "roll", "battle", "question",
                                       timeout=10000)
                    r = await c.room()
                    if r["phase"] != "sail" or not r["reachable"]:
                        continue
                    # prefer a fresh node so the tour covers ground
                    pick = list(r["reachable"])[0]
                    await c.send({"type": "sail", "node": pick})
                    await c.wait_ship_settled(timeout=30000)
                    sailed += 1
                legs = await c.page.evaluate("() => window.__qaLegs")
                clips = await c.page.evaluate("() => window.__qaClips")
                await c.page.evaluate(
                    "() => clearInterval(window.__qaTick)")
                durs = sorted((l["end"] - l["start"]) / 1000 for l in legs
                              if l.get("end"))
                if durs:
                    notes.append(
                        f"{sailed} sails, {len(durs)} legs — median "
                        f"{durs[len(durs) // 2]:.1f}s, max {durs[-1]:.1f}s")
                    if durs[-1] > 9.0:
                        notes.append(f"leg over 9s: travel drags")
                        bad = True
                for cl in clips[:8]:
                    n = nodes.get(cl["island"], {})
                    notes.append(f"CLIP: ship inside {cl['island']} "
                                 f"({cl['type']}, {n.get('region') or 'hub'}) "
                                 f"— {cl['d']}wu from centre")
                if clips:
                    bad = True
                status = console_verdict(c, notes)
                if bad:
                    status = "FAIL"
        record("sail_monitor", status, notes, took=time.time() - t0)
    asyncio.run(go())


@suite
def visual(outdir):
    """The screenshot set the reviewer panel works from."""
    t0 = time.time()

    async def go():
        notes = []
        arts = []
        sd = shots_dir(outdir)

        async def keep(c, name, delay=1000):
            p = os.path.join(sd, f"{name}.png")
            await c.shot(p, delay=delay)
            arts.append(p)

        with DevServer() as srv:
            async with browser_client(srv.url, join=False) as c:
                await keep(c, "vis_title", 2500)
            async with browser_client(srv.url, name="Penelope") as c:
                await keep(c, "vis_hub", 1400)
                r = await c.room()
                nodes = r["board"]["nodes"]
                for realm in ("ice", "desert", "jungle"):
                    n = next((n for n in nodes if n.get("region") == realm
                              and n["type"] in ("sea", "haven", "monster")), None)
                    if n:
                        await c.teleport(n["id"], settle=2600)
                        await keep(c, f"vis_{realm}", 1400)
                shop = next((n for n in nodes if n["type"] == "shop"), None)
                if shop:
                    await c.teleport(shop["id"], land=True)
                    # the stall sheet appears only after the arrival camera
                    # settles, then fades in over 250ms — shooting early
                    # catches a ghost frame and reads as a transparency bug
                    with contextlib.suppress(Exception):
                        await c.page.wait_for_selector(
                            "#shopPanel:not(.hidden)", timeout=8000)
                    await keep(c, "vis_shop", 1400)
                    await c.send({"type": "pass"})
                shrine = next((n for n in nodes if n["type"] == "shrine"
                               and not n.get("region")), None)
                if shrine:
                    await c.teleport(shrine["id"], land=True)
                    await c.send({"type": "wager", "tier": 2})
                    with contextlib.suppress(Exception):
                        await c.wait_phase("question")
                        await keep(c, "vis_question", 1200)
                        await c.send({"type": "answer", "idx": 1})
                        await c.page.wait_for_timeout(6200)
                r = await _pick_fight(c)
                if r:
                    await keep(c, "vis_battle", 2400)
                notes.append(f"{len(arts)} captures")
                status = console_verdict(c, notes)
        record("visual", status, notes, arts, took=time.time() - t0)
    asyncio.run(go())


# ── report ────────────────────────────────────────────────────────────────
def write_report(outdir):
    fails = sum(1 for r in RESULTS if r["status"] == "FAIL")
    warns = sum(1 for r in RESULTS if r["status"] == "WARN")
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"# Thalassa QA report — {stamp}", "",
             f"**Verdict: {'❌ ' + str(fails) + ' failing' if fails else ('⚠️ warnings' if warns else '✅ all green')}**",
             "", "| suite | status | time | notes |", "|---|---|---|---|"]
    for r in RESULTS:
        mark = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}[r["status"]]
        note = "; ".join(r["notes"])[:400].replace("|", "\\|") or "—"
        lines.append(f"| {r['suite']} | {mark} {r['status']} "
                     f"| {r['took']}s | {note} |")
    lines += ["", "## Detail", ""]
    for r in RESULTS:
        lines.append(f"### {r['suite']} — {r['status']}")
        lines += [f"- {n}" for n in r["notes"]]
        for a in r["artifacts"]:
            rel = os.path.relpath(a, outdir)
            lines.append(f"- artifact: `{rel}`")
        lines.append("")
    with open(os.path.join(outdir, "report.md"), "w") as fh:
        fh.write("\n".join(lines))
    with open(os.path.join(outdir, "report.json"), "w") as fh:
        json.dump(RESULTS, fh, indent=1)
    print(f"\nreport → {outdir}/report.md")
    return fails


SUITES = [unit, js, board, smoke, flow, realms, battle, sail_monitor, visual]


def main():
    args = sys.argv[1:]
    outdir = args[0] if args and not args[0].startswith("-") else "qa_report/latest"
    wanted = set(args[1:]) if len(args) > 1 else set()
    os.makedirs(outdir, exist_ok=True)
    for s in SUITES:
        if wanted and s.__name__ not in wanted:
            continue
        s(outdir)
    sys.exit(1 if write_report(outdir) else 0)


if __name__ == "__main__":
    main()

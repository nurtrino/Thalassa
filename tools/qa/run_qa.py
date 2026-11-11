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
                # Every exchange ends in the foe's counter, resolved inside
                # the move's own reveal (there is no reflex beat any more).
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
                    if deck == "jeopardy":
                        # typed clues come off a category board: pick one
                        # rather than waiting out the 12s auto-pick
                        with contextlib.suppress(Exception):
                            await c.wait_phase("jchoose", "question", timeout=6000)
                        if (await c.room())["phase"] == "jchoose":
                            await c.send({"type": "jpick", "idx": 0})
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
                        # the clue must actually RENDER (typed input on
                        # screen), not just reach the question phase — a
                        # snapshot crash once froze exactly here while the
                        # engine looked healthy
                        try:
                            await c.page.wait_for_selector(
                                "#qtypedInput", timeout=8000)
                        except Exception:
                            notes.append(f"{stance}/{deck}: typed input "
                                         "never rendered — snapshot broken?")
                            bad = True
                        await c.send({"type": "answer_text", "text": "alpha"})
                    else:
                        # most puzzle kinds reject wrong submissions and only
                        # resolve on their own deadline — wait the limit out
                        r = await c.room()
                        limit = (r.get("minigame") or {}).get("limit") or 45
                        await c.send({"type": "solve", "payload": None})
                        resolve_ms = min(95, limit + 10) * 1000
                    # ride the whole exchange: your move and the foe's
                    # counter play out in ONE reveal, then (battle/roll).
                    import time as _t
                    end = _t.time() + resolve_ms / 1000 + 8
                    resolved = False
                    while _t.time() < end:
                        rr = await c.room()
                        ph = rr["phase"]
                        if ph in ("battle", "roll", "trade", "upgrade_pick"):
                            resolved = True
                            break
                        await c.page.wait_for_timeout(400)   # reveal / fx
                    if not resolved:
                        notes.append(f"{stance}/{deck}: never resolved "
                                     f"(phase={(await c.room())['phase']})")
                        bad = True
                        continue
                    notes.append(f"{stance}/{deck}: dealt and resolved ✓")
                if (await c.room())["phase"] == "dodge":
                    notes.append("a retired 'dodge' phase appeared")
                    bad = True

                status = console_verdict(c, notes)
                if bad:
                    status = "FAIL"
        record("battle", status, notes, arts, took=time.time() - t0)
    asyncio.run(go())


SAMPLER = """
() => {
  // Samples every moving vessel at 50 ms against what is REALLY on screen in
  // its stage: island coasts (the built R — terrain is fitted inside it), the
  // realm field's solids (bergs, stacks, trunks — scene.js' obstacle index),
  // and every other vessel. Also tracks helm quality: how fast the bow
  // swings (spinning in place) and how far the motion slips off the bow
  // (sliding sideways), and the camera's clearance over the ground.
  const T = window.__thalassa, W = window.__world;
  window.__qaClips = [];
  window.__qaLegs = [];
  window.__qaHelm = { maxTurn: 0, maxSlip: 0, camLow: 99 };
  const cur = {};
  const last = {};
  window.__qaTick = setInterval(() => {
    const now = performance.now();
    for (const [pid, rec] of Object.entries(T.ships)) {
      const st = T.stages[rec.stageId];
      if (!rec.anim || !st) {
        if (cur[pid]) { cur[pid].end = now; window.__qaLegs.push(cur[pid]); delete cur[pid]; }
        delete last[pid];
        continue;
      }
      const p = rec.root.position;
      // one leg per travel animation (a Vale walk is several, fork to fork)
      if (cur[pid] && cur[pid].anim !== rec.anim) {
        cur[pid].end = now; window.__qaLegs.push(cur[pid]); delete cur[pid]; delete last[pid];
      }
      if (!cur[pid]) cur[pid] = { pid, stage: st.id, start: now, from: rec.prevNode,
                                  to: rec.node, samples: 0, foot: rec.mode === 'foot',
                                  anim: rec.anim, dur: rec.anim.dur };
      const leg = cur[pid];
      leg.samples++;
      const foot = rec.mode === 'foot';
      const slack = foot ? 0.3 : 0.5;
      const clip = (what, type, d) => {
        const lc = window.__qaClips[window.__qaClips.length - 1];
        if (!lc || lc.what !== what)
          window.__qaClips.push({ what, type, stage: st.id, d: +d.toFixed(1),
                                  x: +p.x.toFixed(1), z: +p.z.toFixed(1), foot });
      };
      // islands (not the stops this leg leaves from or berths at)
      for (const [id, isle] of Object.entries(st.islands)) {
        if (id === rec.node || id === leg.from || id === leg.to) continue;
        const n = window.__room.board.nodes.find((q) => q.id === id);
        if (!n || n.type === 'gate') continue;
        if (st.id === 'autumn') continue;           // flush clearings, walked over
        if (n.type === 'sea' && !(n.look === 'islet' || n.look === 'rocks')) continue;
        const d = Math.hypot(p.x - n.x, p.z - n.z);
        if (d < isle.R - slack) clip(id, n.type, d);
      }
      // the realm field's solids
      if (st.obstacles) {
        const near = st.obstacles.near(p.x, p.z, p.x, p.z, 6, []);
        for (const c of near) {
          const d = Math.hypot(p.x - c.x, p.z - c.z);
          if (d < c.r * 0.85) clip('field@' + c.x.toFixed(0) + ',' + c.z.toFixed(0), 'field', d);
        }
      }
      // other vessels
      for (const [opid, o] of Object.entries(T.ships)) {
        if (opid === pid || o.stageId !== rec.stageId) continue;
        const d = Math.hypot(p.x - o.root.position.x, p.z - o.root.position.z);
        if (d < (foot ? 0.8 : 3.5)) clip('ship:' + opid, 'ship', d);
      }
      // helm: turn rate and slip off the bow
      const yaw = rec.root.rotation.y;
      const L = last[pid];
      // (a placement — the far side of a pass, a dev drop — is not helm work)
      if (L && Math.hypot(p.x - L.x, p.z - L.z) < 6 && leg.samples > 3) {
        const dt = (now - L.t) / 1000;
        let dy = yaw - L.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
        const vx = p.x - L.x, vz = p.z - L.z, sp = Math.hypot(vx, vz) / dt;
        if (dt > 0) window.__qaHelm.maxTurn = Math.max(window.__qaHelm.maxTurn, Math.abs(dy) / dt);
        if (sp > 2.5) {
          const fx = Math.cos(yaw), fz = -Math.sin(yaw);
          const slip = Math.acos(Math.max(-1, Math.min(1, (vx * fx + vz * fz) / (Math.hypot(vx, vz) || 1))));
          if (slip * 180 / Math.PI > window.__qaHelm.maxSlip) {
            window.__qaHelm.maxSlip = slip * 180 / Math.PI;
            window.__qaHelm.slipAt = st.id + (foot ? ' (foot)' : '') + ' @' + p.x.toFixed(0) + ',' + p.z.toFixed(0);
          }
        }
      }
      last[pid] = { t: now, yaw, x: p.x, z: p.z };
      // the camera stays above the ground it looks over
      const cam = T.camera.position;
      const gy = st.surf && st.surf.heightAt ? Math.max(0, st.surf.heightAt(cam.x, cam.z)) : 0;
      window.__qaHelm.camLow = Math.min(window.__qaHelm.camLow, cam.y - gy);
    }
  }, 50);
}
"""


async def _sail_some(c, rounds, notes, label):
    """Roll and sail/walk `rounds` times from wherever we stand."""
    you = await c.page.evaluate("() => window.__you")
    sailed = 0
    for _ in range(rounds):
        try:
            sailed += await _sail_once(c, you)
        except Exception as e:             # a slow beat / stray phase: next round
            notes.append(f"{label}: round skipped ({type(e).__name__})")
    notes.append(f"{label}: {sailed} voyages")
    return sailed


async def _sail_once(c, you):
    if True:
        r = await c.settle_to_roll()
        if r["phase"] != "roll" or r["turn"] != you:
            return 0
        await c.send({"type": "roll"})
        await c.wait_phase("sail", "roll", "battle", "question", "event",
                           "minigame", timeout=20000)
        r = await c.room()
        if r["phase"] != "sail":
            return 0
        walk = r.get("walk") or {}
        if r["reachable"]:
            # prefer a stop that stays in this realm: the tour should cover
            # its waters, not bounce back out through the pass
            here = {n["id"]: n for n in r["board"]["nodes"]}
            opts = sorted(r["reachable"], key=lambda k: (
                here.get(k, {}).get("type") == "gate", k))
            await c.send({"type": "sail", "node": opts[0]})
        elif walk.get("options"):
            for _step in range(6):          # the Vale's arrow-walk, fork by fork
                r = await c.room()
                w = r.get("walk") or {}
                if r["phase"] != "sail" or not w.get("options"):
                    break
                await c.send({"type": "walk", "node": sorted(w["options"])[0]},
                             settle=900)
                await c.wait_ship_settled(timeout=30000)
        else:
            return 0
        await c.wait_ship_settled(timeout=30000)
        return 1


@suite
def sail_monitor(outdir):
    t0 = time.time()

    async def go():
        notes = []
        bad = False
        with DevServer() as srv:
            async with browser_client(srv.url) as c:
                await c.page.evaluate(SAMPLER)
                # the hub first — this is what players do most
                await _sail_some(c, 14, notes, "hub")
                # then each realm: sail realms, both walked realms
                for realm in ("ice", "jungle", "desert", "autumn"):
                    await c.teleport_region(realm, settle=2600)
                    with contextlib.suppress(Exception):
                        await c.page.wait_for_function(
                            "want => window.__world.currentStage() === want",
                            arg=realm, timeout=20000)
                    await c.page.wait_for_timeout(800)
                    await _sail_some(c, 5, notes, realm)
                legs = await c.page.evaluate(
                    "() => window.__qaLegs.map(({anim, ...l}) => l)")
                clips = await c.page.evaluate("() => window.__qaClips")
                helm = await c.page.evaluate("() => window.__qaHelm")
                await c.page.evaluate("() => clearInterval(window.__qaTick)")
                # the PLANNED duration (wall-clock legs stretch on a starved
                # software renderer and say nothing about the game)
                durs = sorted(l["dur"] / 1000 for l in legs if l.get("end"))
                stages = sorted({l["stage"] for l in legs})
                if durs:
                    notes.append(
                        f"{len(durs)} legs over {', '.join(stages)} — median "
                        f"{durs[len(durs) // 2]:.1f}s, max {durs[-1]:.1f}s")
                    if durs[-1] > 11.0:
                        notes.append("leg over 11s: travel drags")
                        bad = True
                notes.append(f"helm: max turn {helm['maxTurn']:.1f} rad/s, "
                             f"max slip {helm['maxSlip']:.0f}° ({helm.get('slipAt', '-')}), camera min "
                             f"{helm['camLow']:.1f} wu over ground")
                if helm["maxSlip"] > 35:
                    notes.append("SLIDE: a vessel moved >35° off its bow")
                    bad = True
                if helm["camLow"] < 0.8:
                    notes.append("CAMERA under the ground")
                    bad = True
                for cl in clips[:10]:
                    notes.append(f"CLIP ({cl['stage']}{', foot' if cl['foot'] else ''}): "
                                 f"inside {cl['what']} ({cl['type']}) — "
                                 f"{cl['d']}wu from its centre at ({cl['x']}, {cl['z']})")
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
            async with browser_client(srv.url, join=False, gfx="medium") as c:
                await keep(c, "vis_title", 2500)
            async with browser_client(srv.url, name="Penelope", gfx="medium") as c:
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

#!/usr/bin/env python3
"""
meshy_forge.py — render Thalassa's creatures through the Meshy AI API,
most-complicated-first, in a shared low-poly board-game style.

WHAT IT DOES
  * Takes the prompt manifest in meshy_prompts.py (bosses ranked first).
  * For each model: submits a text-to-3D *preview* job, waits, then a *refine*
    job (adds texture), waits, and downloads the .glb (+ thumbnail).
  * Realm re-tints (frost wolf, tomb golem, poison bird ...) are done as cheap
    *retexture* passes over the already-built base mesh instead of a fresh
    generation — the "reuse common textures" strategy.
  * Everything is checkpointed to a state file, so re-running resumes instead
    of re-spending credits. Ctrl-C is safe.

USAGE
  export MESHY_API_KEY=msy_...            # or pass --key
  python tools/meshy_forge.py --plan                 # show order + credit estimate
  python tools/meshy_forge.py --tier boss            # just the showpieces
  python tools/meshy_forge.py --only tyrant,wyrm     # specific models
  python tools/meshy_forge.py --max 3                # first 3 by complexity
  python tools/meshy_forge.py --tier boss --max 2 --budget 120
  python tools/meshy_forge.py --preview-only         # skip the refine/texture pass
  python tools/meshy_forge.py --status               # print state file summary

OUTPUT
  Models land in  static/assets/monsters/_meshy/<id>.glb  by default (a staging
  dir, so the working procedural GLBs are never clobbered). Pass
  --out static/assets/monsters to write in place once you're happy.

CAVEAT (important): Meshy returns ONE un-rigged mesh. It does NOT contain the
named parts (body/head/jaw/legFL/...) the game's animator drives by name. Treat
these as high-detail showpiece / retopo-reference meshes; an in-game animated
creature still needs a rig pass to the contract in docs/ENEMY-ROSTER.md.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import importlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

# Default manifest; override with --manifest (e.g. meshy_structures). The
# manifest module must expose STYLE, NEGATIVE, TIER_POLY, MODELS, ordered().
import meshy_prompts as MP

# Windows consoles default to cp1252 and choke on the status glyphs; make
# stdout/stderr tolerant so the tool runs the same everywhere.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

API = "https://api.meshy.ai/openapi"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATE_PATH = os.path.join(HERE, ".meshy_state.json")
DEFAULT_OUT = os.path.join(ROOT, "static", "assets", "monsters", "_meshy")

# Concurrency: one process, a thread pool of N models in flight at once, all
# sharing one state file guarded by a lock. CONCURRENT tweaks progress printing
# so parallel pollers don't fight over a single \r line.
CONCURRENT = False
HD = False              # --hd: 4K HD textures on the refine pass
FORCE = False           # --force: re-render even if the file exists
_state_lock = threading.Lock()

# Rough public Meshy pricing (credits). Used only for the estimate/guard.
COST_PREVIEW = 5
COST_REFINE = 10
COST_RETEXTURE = 10


# ── tiny HTTP helpers (stdlib only, no deps) ─────────────────────────────────
def _req(method, path, key, body=None):
    url = path if path.startswith("http") else f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"message": raw}


def balance(key):
    _, b = _req("GET", "/v1/balance", key)
    return b.get("balance", "?")


def _submit(path, key, body, what, tries=10):
    """POST with backoff on 429 (NoMoreConcurrentTasks / RateLimit) and 5xx —
    lets many shards share the account's 10-task concurrency cap without failing."""
    delay = 4
    code, msg = None, ""
    for i in range(tries):
        code, r = _req("POST", path, key, body)
        if code < 300:
            return r
        msg = str(r.get("message", r))
        transient = code == 429 or code >= 500 or "Concurrent" in msg or "RateLimit" in msg
        if transient and i < tries - 1:
            time.sleep(delay)
            delay = min(45, delay + 6)
            continue
        raise RuntimeError(f"{what} failed [{code}]: {msg}")
    raise RuntimeError(f"{what} failed after retries [{code}]: {msg}")


# ── state ────────────────────────────────────────────────────────────────────
def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {"models": {}}


def save_state(st):
    with _state_lock:
        tmp = STATE_PATH + f".tmp{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(st, f, indent=2)
        os.replace(tmp, STATE_PATH)


def _entry(st, mid):
    with _state_lock:
        return st["models"].setdefault(mid, {})


# ── prompt assembly ──────────────────────────────────────────────────────────
def full_prompt(model):
    p = model["prompt"].strip().rstrip(".")
    return f"{p}. {MP.STYLE}"[:600]


def poly_for(model):
    return MP.TIER_POLY.get(model["tier"], 6000)


# ── Meshy operations ─────────────────────────────────────────────────────────
def submit_preview(key, model):
    body = {
        "mode": "preview",
        "prompt": full_prompt(model),
        "negative_prompt": (model.get("negative") or MP.NEGATIVE)[:800],
        "ai_model": "meshy-6",
        "model_type": "lowpoly",
        "topology": "triangle",
        "target_polycount": poly_for(model),
        "should_remesh": True,
        "target_formats": ["glb"],
    }
    return _submit("/v2/text-to-3d", key, body, "preview submit")["result"]


def submit_refine(key, preview_task_id, texture_prompt=None, hd=False):
    body = {
        "mode": "refine",
        "preview_task_id": preview_task_id,
        "ai_model": "meshy-6",
        "enable_pbr": True,
        "target_formats": ["glb"],
    }
    if hd:
        body["hd_texture"] = True     # 4K texture maps
    if texture_prompt:
        body["texture_prompt"] = texture_prompt[:600]
    return _submit("/v2/text-to-3d", key, body, "refine submit")["result"]


def submit_retexture(key, model_url, style_prompt):
    body = {
        "model_url": model_url,
        "text_style_prompt": f"{style_prompt}. {MP.STYLE}"[:600],
        "negative_prompt": MP.NEGATIVE[:800],
        "enable_pbr": True,
    }
    return _submit("/v1/retexture", key, body, "retexture submit")["result"]


def poll(key, kind, task_id, label, timeout=1800):
    """kind: 'ttd' (text-to-3d) or 'rtx' (retexture). Returns the task dict."""
    path = f"/v2/text-to-3d/{task_id}" if kind == "ttd" else f"/v1/retexture/{task_id}"
    t0 = time.time()
    last = -1
    last_status = None
    while True:
        _, r = _req("GET", path, key)
        status = r.get("status")
        prog = r.get("progress", 0)
        if CONCURRENT:
            # many pollers share the log: print only on status change, no \r
            if status != last_status:
                print(f"    {label}: {status} {prog:3d}%", flush=True)
                last_status = status
        elif prog != last:
            sys.stdout.write(f"\r    {label}: {status} {prog:3d}%   ")
            sys.stdout.flush()
            last = prog
        if status == "SUCCEEDED":
            if not CONCURRENT:
                print()
            return r
        if status in ("FAILED", "CANCELED"):
            if not CONCURRENT:
                print()
            raise RuntimeError(f"{label} {status}: {r.get('task_error', r)}")
        if time.time() - t0 > timeout:
            if not CONCURRENT:
                print()
            raise TimeoutError(f"{label} timed out after {timeout}s")
        time.sleep(6)


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(url, timeout=180) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def _stage(key, e, task_key, submit_fn, kind, label, st, tries=3):
    """Submit (if not already checkpointed) then poll. On a transient failure
    (Meshy 'service_unavailable', a FAILED task, a timeout) clear the dead task
    id so the next attempt resubmits fresh instead of re-polling a corpse."""
    for attempt in range(tries):
        try:
            if not e.get(task_key):
                e[task_key] = submit_fn()
                save_state(st)
            return poll(key, kind, e[task_key], label)
        except Exception as ex:
            e.pop(task_key, None)
            save_state(st)
            if attempt == tries - 1:
                raise
            print(f"    … {label} retry {attempt + 1}/{tries - 1} after: {str(ex)[:120]}",
                  flush=True)
            time.sleep(10)


# ── per-model pipeline ───────────────────────────────────────────────────────
def forge_model(key, model, out_dir, st, preview_only=False):
    mid = model["id"]
    e = _entry(st, mid)
    dest = os.path.join(out_dir, f"{mid}.glb")

    if FORCE:
        for k in ("preview_task", "refine_task", "retex_task", "glb", "base_model_url"):
            e.pop(k, None)
        # also invalidate this base's variants so they re-tint off the new mesh
        for v in model.get("variants", []):
            vp = os.path.join(out_dir, f"{v['id']}.glb")
            if os.path.exists(vp):
                os.remove(vp)
            ve = _entry(st, v["id"])
            for k in ("retex_task", "glb"):
                ve.pop(k, None)

    if os.path.exists(dest) and os.path.getsize(dest) > 0 and not FORCE and not e.get("force"):
        print(f"  ✔ {mid}: already downloaded ({os.path.relpath(dest, ROOT)})")
        # base is done, but earlier variants may have failed — fill any gaps
        # by retexturing off the stored base mesh url.
        base = e.get("base_model_url")
        if base and model.get("variants"):
            for v in model["variants"]:
                try:
                    forge_variant(key, v, base, out_dir, st)
                except Exception as ex:
                    print(f"    x variant {v['id']} FAILED: {str(ex)[:140]}", flush=True)
        return e

    print(f"  ▶ {mid} [{model['tier']}, {poly_for(model)} tris]")

    # 1) preview (checkpointed, transient-retry)
    prev = _stage(key, e, "preview_task",
                  lambda: submit_preview(key, model), "ttd", f"{mid} preview", st)
    e["preview_glb"] = prev.get("model_urls", {}).get("glb")
    save_state(st)

    final = prev
    if not preview_only:
        # 2) refine / texture (checkpointed, transient-retry)
        final = _stage(key, e, "refine_task",
                       lambda: submit_refine(key, e["preview_task"], hd=HD), "ttd",
                       f"{mid} refine", st)

    # 3) download the textured glb
    glb = final.get("model_urls", {}).get("glb")
    if not glb:
        raise RuntimeError(f"{mid}: no glb url in result")
    download(glb, dest)
    e["glb"] = glb
    e["base_model_url"] = glb            # variants retexture from here
    e["thumb"] = final.get("thumbnail_url")
    e["file"] = os.path.relpath(dest, ROOT)
    e["done_at"] = int(time.time())
    e.pop("force", None)
    save_state(st)
    print(f"    ↓ saved {e['file']}")

    # 4) realm re-tint variants via retexture (reuse the base mesh). Isolate
    # each — a failed variant must not abort its siblings or fail the base.
    for v in model.get("variants", []):
        try:
            forge_variant(key, v, e["base_model_url"], out_dir, st)
        except Exception as ex:
            print(f"    x variant {v['id']} FAILED: {str(ex)[:140]}", flush=True)
    return e


def forge_variant(key, variant, base_url, out_dir, st):
    vid = variant["id"]
    e = _entry(st, vid)
    dest = os.path.join(out_dir, f"{vid}.glb")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"    ✔ {vid} (variant): already downloaded")
        return
    print(f"    ◈ {vid}: retexture of base mesh", flush=True)
    e["is_variant"] = True
    res = _stage(key, e, "retex_task",
                 lambda: submit_retexture(key, base_url, variant["prompt"]), "rtx",
                 f"{vid} retexture", st)
    glb = res.get("model_urls", {}).get("glb")
    if not glb:
        raise RuntimeError(f"{vid}: no glb url in retexture result")
    download(glb, dest)
    e["glb"] = glb
    e["thumb"] = res.get("thumbnail_url")
    e["file"] = os.path.relpath(dest, ROOT)
    e["done_at"] = int(time.time())
    save_state(st)
    print(f"      ↓ saved {e['file']}")


# ── selection / planning ─────────────────────────────────────────────────────
def select(args):
    models = MP.ordered()
    if args.only:
        want = {s.strip() for s in args.only.split(",")}
        models = [m for m in models if m["id"] in want]
    if args.tier:
        tiers = {t.strip() for t in args.tier.split(",")}
        models = [m for m in models if m["tier"] in tiers]
    if args.max:
        models = models[: args.max]
    return models


def estimate(models, preview_only):
    c = 0
    for m in models:
        c += COST_PREVIEW + (0 if preview_only else COST_REFINE)
        c += len(m.get("variants", [])) * COST_RETEXTURE
    return c


def print_plan(models, preview_only, key):
    print(f"\nMeshy forge plan — {len(models)} base model(s), "
          f"most-complicated-first:\n")
    print(f"  {'#':>2}  {'id':<14}{'tier':<8}{'tris':>7}  variants")
    for i, m in enumerate(models, 1):
        vs = ",".join(v["id"] for v in m.get("variants", [])) or "—"
        print(f"  {i:>2}  {m['id']:<14}{m['tier']:<8}{poly_for(m):>7}  {vs}")
    est = estimate(models, preview_only)
    print(f"\n  est. cost ≈ {est} credits"
          f"{' (preview only)' if preview_only else ' (preview+refine, +retexture variants)'}")
    if key:
        print(f"  balance    = {balance(key)} credits")
    print()


# ── CLI ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Render Thalassa creatures via Meshy AI.")
    ap.add_argument("--key", default=os.environ.get("MESHY_API_KEY"),
                    help="Meshy API key (or set MESHY_API_KEY)")
    ap.add_argument("--manifest", default="meshy_prompts",
                    help="manifest module (default meshy_prompts; e.g. meshy_structures)")
    ap.add_argument("--state", help="state/checkpoint file (default .meshy_state.json)")
    ap.add_argument("--only", help="comma list of model ids")
    ap.add_argument("--tier", help="comma list of tiers (boss,elite,heavy,mid,grunt,hero,prop)")
    ap.add_argument("--max", type=int, help="cap to first N (by complexity)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output dir")
    ap.add_argument("--preview-only", action="store_true", help="skip refine/texture")
    ap.add_argument("--hd", action="store_true",
                    help="4K HD texture maps on the refine pass (higher quality, more credits)")
    ap.add_argument("--force", action="store_true",
                    help="re-render selected models even if their file already exists")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="how many models to render in parallel (Meshy caps at 30 concurrent tasks/account)")
    ap.add_argument("--budget", type=int, help="abort if estimate exceeds this many credits")
    ap.add_argument("--plan", action="store_true", help="show plan + estimate, do nothing")
    ap.add_argument("--status", action="store_true", help="print state-file summary")
    ap.add_argument("--yes", action="store_true", help="don't prompt before spending")
    args = ap.parse_args()

    # Pluggable manifest + per-manifest state file, so independent runs
    # (creatures vs structures) never race the same checkpoint.
    global MP, STATE_PATH, HD, FORCE
    HD = args.hd
    FORCE = args.force
    if args.manifest != "meshy_prompts":
        MP = importlib.import_module(args.manifest)
    if args.state:
        STATE_PATH = args.state if os.path.isabs(args.state) else os.path.join(HERE, args.state)

    if args.status:
        st = load_state()
        done = [k for k, v in st["models"].items() if v.get("glb")]
        pend = [k for k, v in st["models"].items() if not v.get("glb")]
        print(f"done ({len(done)}): {', '.join(sorted(done)) or '—'}")
        print(f"pending ({len(pend)}): {', '.join(sorted(pend)) or '—'}")
        return

    models = select(args)
    if not models:
        print("nothing selected."); return

    if args.plan:
        print_plan(models, args.preview_only, args.key)
        return

    if not args.key:
        sys.exit("no API key — set MESHY_API_KEY or pass --key")

    print_plan(models, args.preview_only, args.key)
    est = estimate(models, args.preview_only)
    if args.budget and est > args.budget:
        sys.exit(f"estimate {est} exceeds --budget {args.budget}; narrow the selection.")
    if not args.yes:
        try:
            if input("proceed? [y/N] ").strip().lower() not in ("y", "yes"):
                print("aborted."); return
        except EOFError:
            sys.exit("no TTY for confirmation; pass --yes to run non-interactively.")

    st = load_state()
    os.makedirs(args.out, exist_ok=True)
    ok, failed = [], []
    conc = max(1, args.concurrency)

    def run_one(m):
        forge_model(args.key, m, args.out, st, preview_only=args.preview_only)
        return m["id"]

    if conc == 1:
        for m in models:
            try:
                run_one(m)
                ok.append(m["id"])
            except KeyboardInterrupt:
                print("\ninterrupted — progress saved; re-run to resume.")
                break
            except Exception as ex:
                print(f"  x {m['id']} FAILED: {ex}")
                failed.append(m["id"])
    else:
        global CONCURRENT
        CONCURRENT = True
        print(f"rendering {len(models)} models at concurrency {conc}...\n", flush=True)
        with cf.ThreadPoolExecutor(max_workers=conc) as pool:
            futs = {pool.submit(run_one, m): m for m in models}
            for fut in cf.as_completed(futs):
                mid = futs[fut]["id"]
                try:
                    fut.result()
                    ok.append(mid)
                    print(f"  [done] {mid}  ({len(ok)}/{len(models)})", flush=True)
                except Exception as ex:
                    print(f"  x {mid} FAILED: {ex}", flush=True)
                    failed.append(mid)

    print(f"\ndone. ok={ok} failed={failed}")
    print(f"remaining balance ≈ {balance(args.key)} credits")
    print(f"files in {os.path.relpath(args.out, ROOT)}/  ·  state in {os.path.relpath(STATE_PATH, ROOT)}")


if __name__ == "__main__":
    main()

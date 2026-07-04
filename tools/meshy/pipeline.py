#!/usr/bin/env python3
"""
Meshy AI model-generation workflow for THALASSA.

Generates the game's creature GLBs through the Meshy Text-to-3D API
(preview -> refine -> download), post-processes each file to fit the game's
procedural-animation contract (root/body wrapper, +X facing, feet at y=0,
matte materials), and stages results for review before installing them over
the Blender placeholders in static/assets/monsters/.

Prompts live in tools/meshy/manifest.json, ordered so the most complicated
models (bosses, hero, elites) generate first. Common beasts are 'library'
models: search the Meshy community database (https://www.meshy.ai/discover)
with the manifest's library_query, download the GLB, and bring it into the
game with `import`. Realm color variants reuse one mesh via `retexture`.

Auth: export MESHY_API_KEY=msy_...   (never commit the key)

Typical session:
    python tools/meshy/pipeline.py balance
    python tools/meshy/pipeline.py plan
    python tools/meshy/pipeline.py run --tier boss          # generate + wait
    python tools/meshy/pipeline.py status
    python tools/meshy/pipeline.py install --models tyrant  # go live

Everything is resume-safe: task ids persist in tools/meshy/state.json, so a
killed `run` continues with `poll --watch`.

Stdlib only — no dependencies.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import shutil
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MANIFEST_PATH = HERE / "manifest.json"
STATE_PATH = HERE / "state.json"
STAGING_DIR = ROOT / "static" / "assets" / "meshy"
INSTALL_DIR = ROOT / "static" / "assets" / "monsters"

BASE_URL = os.environ.get("MESHY_BASE_URL", "https://api.meshy.ai")
TEXT_TO_3D = "/openapi/v2/text-to-3d"
TEXT_TO_TEXTURE = "/openapi/v1/text-to-texture"
BALANCE = "/openapi/v1/balance"

TIER_ORDER = ["boss", "hero", "elite", "mid", "grunt"]
FLOATERS = {"wraith", "shade", "siren", "warden"}  # hover; keep baked height
POLL_SECONDS = 20

# Roster height targets (units) — informational; the game rescales by
# measured height, but a wildly off proportion is worth flagging.
HEIGHT_RANGE = {"boss": (3.4, 4.6), "hero": (1.6, 2.0), "elite": (1.7, 2.4),
                "mid": (1.2, 2.0), "grunt": (1.0, 1.8)}


# ── small utilities ─────────────────────────────────────────────────────────

def rel(p: Path) -> str:
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return str(p)


def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def api_key() -> str:
    key = os.environ.get("MESHY_API_KEY", "").strip()
    if not key:
        die("MESHY_API_KEY is not set. Get a key at https://www.meshy.ai "
            "(Settings -> API) and run:  export MESHY_API_KEY=msy_...")
    return key


def request(method: str, path: str, body: dict | None = None,
            raw_url: str | None = None, retries: int = 4) -> dict | bytes:
    """One HTTP call with auth, JSON handling and 429/5xx backoff."""
    url = raw_url or (BASE_URL + path)
    data = json.dumps(body).encode() if body is not None else None
    delay = 3.0
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        if not raw_url:
            req.add_header("Authorization", f"Bearer {api_key()}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                if raw_url and "json" not in ctype:
                    return payload  # binary download
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                print(f"  http {e.code}, retrying in {delay:.0f}s ...")
                time.sleep(delay)
                delay *= 2
                continue
            die(f"Meshy API {method} {url} -> HTTP {e.code}: {detail}")
        except urllib.error.URLError as e:
            if attempt < retries:
                print(f"  network error ({e.reason}), retrying in {delay:.0f}s ...")
                time.sleep(delay)
                delay *= 2
                continue
            die(f"cannot reach {url}: {e.reason}")
    raise AssertionError("unreachable")


def load_manifest() -> dict:
    m = json.loads(MANIFEST_PATH.read_text())
    m["models"].sort(key=lambda e: e.get("priority", 999))
    return m


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"models": {}}


def save_state(state: dict):
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n")


def entry_for(manifest: dict, model_id: str) -> dict:
    for e in manifest["models"]:
        if e["id"] == model_id:
            return e
    die(f"unknown model '{model_id}' (see `plan` for the roster)")
    raise AssertionError


def select_models(manifest: dict, args) -> list[dict]:
    models = manifest["models"]
    if getattr(args, "models", None):
        wanted = [m.strip() for m in args.models.split(",") if m.strip()]
        return [entry_for(manifest, m) for m in wanted]
    tier = getattr(args, "tier", None)
    if tier and tier != "all":
        models = [e for e in models if e["tier"] == tier]
    limit = getattr(args, "limit", None)
    return models[:limit] if limit else models


def full_prompt(manifest: dict, entry: dict) -> str:
    p = manifest["style_prefix"] + entry["prompt"]
    if len(p) > 600:  # Meshy prompt cap
        p = p[:597] + "..."
    return p


def full_texture_prompt(manifest: dict, entry: dict, variant: str | None = None) -> str:
    base = entry.get("texture_prompt", "")
    if variant:
        variants = entry.get("variants") or {}
        if variant not in variants:
            die(f"model '{entry['id']}' has no variant '{variant}' "
                f"(available: {', '.join(variants) or 'none'})")
        base = variants[variant]
    return (base + manifest["texture_style"]).strip()


# ── GLB post-processing (pure stdlib) ───────────────────────────────────────
#
# The game animates creatures by moving named child nodes every frame
# (static/monsters.js). Meshy returns one unnamed mesh, so we rewrite the
# GLB's JSON chunk to wrap everything as  root -> body -> [original nodes]:
# body-level animation (breathe, bob, lunge, flinch, die) then works as-is,
# limbs simply ride along. We also yaw the model to face +X, drop the feet
# to y=0, and force matte materials to match the game's look.

def read_glb(path: Path) -> tuple[dict, bytes]:
    blob = path.read_bytes()
    magic, version, _length = struct.unpack_from("<III", blob, 0)
    if magic != 0x46546C67:
        die(f"{path} is not a GLB file")
    off, gltf, bin_chunk = 12, None, b""
    while off < len(blob):
        clen, ctype = struct.unpack_from("<II", blob, off)
        chunk = blob[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(chunk)
        elif ctype == 0x004E4942:
            bin_chunk = chunk
        off += 8 + clen
    if gltf is None:
        die(f"{path}: no JSON chunk")
    return gltf, bin_chunk


def write_glb(path: Path, gltf: dict, bin_chunk: bytes):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bn = bin_chunk + b"\0" * (-len(bin_chunk) % 4)
    total = 12 + 8 + len(js) + (8 + len(bn) if bn else 0)
    with path.open("wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        if bn:
            f.write(struct.pack("<II", len(bn), 0x004E4942))
            f.write(bn)


def scene_min_y(gltf: dict, node_ids: list[int]) -> float:
    """Lowest Y across POSITION accessor bounds, following node translation
    and scale (rotations are rare in Meshy output; warned and ignored)."""
    lowest = math.inf

    def walk(idx: int, ty: float, sy: float):
        nonlocal lowest
        node = gltf["nodes"][idx]
        if node.get("rotation") and node["rotation"] != [0, 0, 0, 1]:
            print("  note: node rotation present; grounding is approximate")
        t = node.get("translation", [0, 0, 0])
        s = node.get("scale", [1, 1, 1])
        ty, sy = ty + t[1] * sy, sy * s[1]
        if "mesh" in node:
            for prim in gltf["meshes"][node["mesh"]].get("primitives", []):
                acc = prim.get("attributes", {}).get("POSITION")
                if acc is not None and "min" in gltf["accessors"][acc]:
                    lowest = min(lowest, ty + gltf["accessors"][acc]["min"][1] * sy)
        for child in node.get("children", []):
            walk(child, ty, sy)

    for nid in node_ids:
        walk(nid, 0.0, 1.0)
    return 0.0 if lowest is math.inf else lowest


def postprocess_glb(src: Path, dst: Path, entry: dict, defaults: dict):
    gltf, bin_chunk = read_glb(src)
    scene = gltf["scenes"][gltf.get("scene", 0)]
    old_roots = scene.get("nodes", [])
    nodes = gltf.setdefault("nodes", [])

    # matte, non-metallic materials (the game's flat board-game look)
    for mat in gltf.get("materials", []):
        pbr = mat.setdefault("pbrMetallicRoughness", {})
        if "metallicRoughnessTexture" not in pbr:
            pbr["metallicFactor"] = 0.0
            pbr["roughnessFactor"] = max(0.85, pbr.get("roughnessFactor", 1.0))

    if [nodes[i].get("name") for i in old_roots] == ["root"]:
        # already conforms to the rig contract (e.g. a Blender export or a
        # previously processed file) — don't touch its transforms
        print(f"  {entry['id']}: already rig-wrapped, materials pass only")
    else:
        body_idx = len(nodes)
        nodes.append({"name": "body", "children": old_roots})
        root_idx = len(nodes)
        nodes.append({"name": "root", "children": [body_idx]})
        scene["nodes"] = [root_idx]

        # face +X: glTF models conventionally face +Z; yaw about Y
        yaw = math.radians(entry.get("yaw_deg", defaults.get("yaw_deg", 90)))
        nodes[root_idx]["rotation"] = [0.0, round(math.sin(yaw / 2), 6), 0.0,
                                       round(math.cos(yaw / 2), 6)]

        # feet on the ground (skips floaters and skinned meshes)
        if entry["id"] not in FLOATERS and not gltf.get("skins"):
            min_y = scene_min_y(gltf, nodes[body_idx]["children"])
            if abs(min_y) > 1e-4:
                nodes[body_idx]["translation"] = [0.0, round(-min_y, 6), 0.0]

    dst.parent.mkdir(parents=True, exist_ok=True)
    write_glb(dst, gltf, bin_chunk)

    lo, hi = HEIGHT_RANGE.get(entry["tier"], (0.5, 8.0))
    print(f"  {entry['id']}: wrote {rel(dst)} "
          f"(roster proportions target {lo}-{hi}u; the game rescales by height)")


# ── task lifecycle ──────────────────────────────────────────────────────────

def mstate(state: dict, model_id: str) -> dict:
    return state["models"].setdefault(model_id, {"stage": "new"})


def start_preview(manifest: dict, entry: dict, state: dict):
    d = manifest["defaults"]
    body = {
        "mode": "preview",
        "prompt": full_prompt(manifest, entry),
        "art_style": "realistic",
        "ai_model": entry.get("ai_model", d["ai_model"]),
        "topology": entry.get("topology", d["topology"]),
        "target_polycount": entry.get("polycount", d["polycount"]),
        "symmetry_mode": entry.get("symmetry_mode", d["symmetry_mode"]),
        "should_remesh": True,
    }
    res = request("POST", TEXT_TO_3D, body)
    ms = mstate(state, entry["id"])
    ms.update(stage="preview", preview_task=res["result"])
    save_state(state)
    print(f"  {entry['id']}: preview task {res['result']}")


def start_refine(manifest: dict, entry: dict, state: dict):
    ms = mstate(state, entry["id"])
    body = {
        "mode": "refine",
        "preview_task_id": ms["preview_task"],
        "enable_pbr": entry.get("enable_pbr", manifest["defaults"].get("enable_pbr", False)),
        "texture_prompt": full_texture_prompt(manifest, entry),
    }
    res = request("POST", TEXT_TO_3D, body)
    ms.update(stage="refine", refine_task=res["result"])
    save_state(state)
    print(f"  {entry['id']}: refine task {res['result']}")


def download_and_finish(manifest: dict, entry: dict, state: dict, task: dict):
    ms = mstate(state, entry["id"])
    url = (task.get("model_urls") or {}).get("glb")
    if not url:
        die(f"{entry['id']}: task succeeded but returned no GLB url")
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    raw = STAGING_DIR / f"{entry['id']}.raw.glb"
    print(f"  {entry['id']}: downloading model ...")
    raw.write_bytes(request("GET", "", raw_url=url))
    final = STAGING_DIR / f"{entry['id']}.glb"
    postprocess_glb(raw, final, entry, manifest["defaults"])
    raw.unlink()
    ms.update(stage="staged", glb=str(final.relative_to(ROOT)))
    save_state(state)


def advance(manifest: dict, state: dict) -> tuple[int, int]:
    """One poll pass over every in-flight model. Returns (active, staged)."""
    active = staged = 0
    for entry in manifest["models"]:
        ms = state["models"].get(entry["id"])
        if not ms:
            continue
        stage = ms.get("stage")
        if stage in ("staged", "installed", "failed"):
            staged += stage != "failed"
            continue
        task_id = ms.get("refine_task") if stage == "refine" else ms.get("preview_task")
        if not task_id:
            continue
        task = request("GET", f"{TEXT_TO_3D}/{task_id}")
        status = task.get("status")
        if status in ("PENDING", "IN_PROGRESS"):
            active += 1
            print(f"  {entry['id']}: {stage} {task.get('progress', 0)}%")
        elif status == "SUCCEEDED":
            if stage == "preview":
                start_refine(manifest, entry, state)
                active += 1
            else:
                download_and_finish(manifest, entry, state, task)
                staged += 1
        else:
            msg = task.get("task_error", {}).get("message", status)
            ms.update(stage="failed", error=str(msg))
            save_state(state)
            print(f"  {entry['id']}: FAILED — {msg}")
    return active, staged


# ── commands ────────────────────────────────────────────────────────────────

def cmd_balance(_args):
    res = request("GET", BALANCE)
    print(f"Meshy credit balance: {res.get('balance', res)}")


def cmd_plan(args):
    manifest = load_manifest()
    state = load_state()
    print(f"{'#':>2} {'model':<12} {'tier':<6} {'method':<9} {'stage':<10} prompt / library query")
    for e in select_models(manifest, args):
        ms = state["models"].get(e["id"], {})
        hint = e.get("library_query") if e["method"] == "library" else e["prompt"][:58] + "..."
        print(f"{e['priority']:>2} {e['id']:<12} {e['tier']:<6} {e['method']:<9} "
              f"{ms.get('stage', '-'):<10} {hint}")
    gen = [e for e in select_models(manifest, args) if e["method"] == "generate"]
    print(f"\n{len(gen)} models to generate (~{len(gen) * 15} credits at "
          f"5/preview + 10/refine); the rest come from the Meshy library + retexture.")


def cmd_generate(args):
    manifest = load_manifest()
    state = load_state()
    selected = select_models(manifest, args)
    started = 0
    for e in selected:
        if e["method"] == "library" and not args.models:
            continue  # library models only generate when named explicitly
        ms = state["models"].get(e["id"], {})
        if ms.get("stage") in ("preview", "refine", "staged", "installed") and not args.force:
            print(f"  {e['id']}: already {ms['stage']} (use --force to redo)")
            continue
        start_preview(manifest, e, state)
        started += 1
    print(f"started {started} preview task(s). Follow with `poll --watch`.")
    if args.watch:
        cmd_poll(args)


def cmd_poll(args):
    manifest = load_manifest()
    state = load_state()
    deadline = time.time() + args.timeout
    while True:
        active, staged = advance(manifest, state)
        print(f"poll: {active} in flight, {staged} staged")
        if active == 0 or not getattr(args, "watch", False):
            break
        if time.time() > deadline:
            print("watch timeout reached; resume later with `poll --watch`")
            break
        time.sleep(POLL_SECONDS)


def cmd_run(args):
    args.watch = True
    cmd_generate(args)


def cmd_retexture(args):
    """Texture a realm variant onto an existing GLB via Text-to-Texture."""
    manifest = load_manifest()
    state = load_state()
    entry = entry_for(manifest, args.model)
    src = ROOT / (state["models"].get(entry["id"], {}).get("glb", "") or
                  f"static/assets/monsters/{entry['id']}.glb")
    if not src.exists():
        die(f"no base GLB for '{entry['id']}' — generate or import it first")
    data_uri = "data:model/gltf-binary;base64," + base64.b64encode(src.read_bytes()).decode()
    body = {
        "model_url": data_uri,
        "object_prompt": entry["prompt"][:300],
        "style_prompt": full_texture_prompt(manifest, entry, args.variant),
        "enable_original_uv": True,
        "enable_pbr": False,
        "art_style": "fake-3d-hand-drawn",
        "resolution": "1024",
    }
    res = request("POST", TEXT_TO_TEXTURE, body)
    task_id = res["result"]
    print(f"  {entry['id']}[{args.variant or 'default'}]: texture task {task_id}")
    while True:
        task = request("GET", f"{TEXT_TO_TEXTURE}/{task_id}")
        if task["status"] == "SUCCEEDED":
            url = (task.get("model_urls") or {}).get("glb")
            suffix = f".{args.variant}" if args.variant else ".retex"
            out = STAGING_DIR / f"{entry['id']}{suffix}.glb"
            STAGING_DIR.mkdir(parents=True, exist_ok=True)
            out.write_bytes(request("GET", "", raw_url=url))
            print(f"  wrote {rel(out)}")
            return
        if task["status"] in ("FAILED", "CANCELED"):
            die(f"texture task failed: {task.get('task_error')}")
        print(f"  ... {task.get('progress', 0)}%")
        time.sleep(POLL_SECONDS)


def cmd_import(args):
    """Bring a GLB downloaded from the Meshy library into the game contract."""
    manifest = load_manifest()
    state = load_state()
    entry = entry_for(manifest, args.model)
    src = Path(args.file)
    if not src.exists():
        die(f"file not found: {src}")
    final = STAGING_DIR / f"{entry['id']}.glb"
    postprocess_glb(src, final, entry, manifest["defaults"])
    ms = mstate(state, entry["id"])
    ms.update(stage="staged", glb=str(final.relative_to(ROOT)), source="library")
    save_state(state)


def cmd_install(args):
    manifest = load_manifest()
    state = load_state()
    for e in select_models(manifest, args):
        ms = state["models"].get(e["id"], {})
        if ms.get("stage") not in ("staged", "installed"):
            continue
        src = ROOT / ms["glb"]
        dst = INSTALL_DIR / f"{e['id']}.glb"
        if dst.exists():
            bak = dst.with_suffix(".glb.bak")
            if not bak.exists():
                shutil.copy2(dst, bak)  # keep the Blender placeholder once
        shutil.copy2(src, dst)
        ms["stage"] = "installed"
        print(f"  installed {rel(dst)} (placeholder kept as .bak)")
    save_state(state)


def cmd_status(_args):
    manifest = load_manifest()
    state = load_state()
    print(f"{'model':<12} {'tier':<6} {'stage':<10} detail")
    for e in manifest["models"]:
        ms = state["models"].get(e["id"], {})
        detail = ms.get("error") or ms.get("glb") or \
            (f"library: search '{e['library_query']}'" if e["method"] == "library" else "")
        print(f"{e['id']:<12} {e['tier']:<6} {ms.get('stage', '-'):<10} {detail}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 prog="pipeline.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, tiers=True):
        if tiers:
            p.add_argument("--tier", choices=TIER_ORDER + ["all"], default=None,
                           help="select every model of one tier")
            p.add_argument("--models", help="comma-separated model ids")
            p.add_argument("--limit", type=int, help="cap how many models run")

    sub.add_parser("balance", help="show Meshy credit balance")
    common(sub.add_parser("plan", help="show the roster, prompts and cost estimate"))

    g = sub.add_parser("generate", help="start Text-to-3D preview tasks")
    common(g)
    g.add_argument("--force", action="store_true", help="regenerate even if staged")
    g.add_argument("--watch", action="store_true", help="poll until done")
    g.add_argument("--timeout", type=int, default=5400)

    p = sub.add_parser("poll", help="advance in-flight tasks (refine, download)")
    p.add_argument("--watch", action="store_true")
    p.add_argument("--timeout", type=int, default=5400)

    r = sub.add_parser("run", help="generate + watch to completion")
    common(r)
    r.add_argument("--force", action="store_true")
    r.add_argument("--timeout", type=int, default=5400)

    t = sub.add_parser("retexture", help="realm-variant texture on an existing model")
    t.add_argument("model")
    t.add_argument("--variant", help="variant key from the manifest (e.g. frost)")

    i = sub.add_parser("import", help="post-process a GLB downloaded from the Meshy library")
    i.add_argument("model")
    i.add_argument("file")

    common(sub.add_parser("install", help="copy staged GLBs over the game placeholders"))
    sub.add_parser("status", help="pipeline state for every model")

    args = ap.parse_args()
    {"balance": cmd_balance, "plan": cmd_plan, "generate": cmd_generate,
     "poll": cmd_poll, "run": cmd_run, "retexture": cmd_retexture,
     "import": cmd_import, "install": cmd_install, "status": cmd_status}[args.cmd](args)


if __name__ == "__main__":
    main()

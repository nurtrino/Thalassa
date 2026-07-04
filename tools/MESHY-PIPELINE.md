# Thalassa × Meshy — AI Asset Pipeline

End-to-end pipeline for generating Thalassa's 3D art with the **Meshy AI** API
in one consistent stylized low-poly board-game look, then rigging it for the
game. Three stages: **generate → rig → gallery**.

```
tools/
  meshy_forge.py        # generate models (text-to-3D preview→refine→download)
  meshy_prompts.py      # prompt manifest: 35 creatures (+ realm re-tint variants)
  meshy_structures.py   # prompt manifest: map landmarks (pharos, temples, ship…)
  meshy_rig.py          # first-pass auto-rig meshes → game's named-part contract
  meshy_gallery.py      # build a contact-sheet montage of every render
  MESHY-FORGE.md        # forge CLI reference
  MESHY-PIPELINE.md     # ← this file
```

Output (staging, never overwrites the procedural GLBs):
```
static/assets/monsters/_meshy/     # raw generated creature meshes
static/assets/monsters/_rigged/    # rigged, game-ready creatures
static/assets/structures/          # generated map landmarks
tools/samples/gallery.png          # visual contact sheet
```

---

## 0. Setup

```bash
export MESHY_API_KEY=msy_...            # your Meshy key (never commit it)
python -m pip install trimesh numpy     # only needed for meshy_rig.py
```

The forge itself is stdlib-only. State/log files (`.meshy*state.json`,
`.forge_*.log`) and `samples/` are gitignored — they can contain signed URLs and
are reproducible.

---

## 1. Generate

Most-complicated-first ordering (bosses lead). Preview builds the shape, refine
adds textures.

```bash
# see the plan + credit estimate, spend nothing
python tools/meshy_forge.py --plan

# render everything, 20 at a time (Meshy caps at 30 concurrent tasks/account)
python tools/meshy_forge.py --concurrency 20 --yes

# a subset
python tools/meshy_forge.py --only tyrant,wyrm --yes
python tools/meshy_forge.py --tier boss --yes

# map landmarks (separate manifest + state file + out dir)
python tools/meshy_forge.py --manifest meshy_structures \
    --state .meshy_structures_state.json --out ../static/assets/structures \
    --concurrency 6 --yes
```

Key flags: `--hd` (4K textures), `--force` (re-render even if the file exists,
also re-tints a base's variants), `--preview-only`, `--budget N`, `--status`.

**Quality knobs that matter:**
- `--hd` for hero/boss models (4K maps; files get big, 30–56 MB).
- Per-model `negative` in the manifest to ban unwanted looks (e.g. the golems
  carry `robot, mech, metal panels…` so they read as stone, not sci-fi).
- Shared `STYLE` + `NEGATIVE` in the manifests are the style lock — edit those
  to shift the whole set at once.

**Robustness:** resume-safe (every paid task id is checkpointed before waiting),
429-backoff for concurrency limits, and transient-failure retry (Meshy
occasionally returns `service_unavailable` mid-refine; it clears the dead task
and resubmits). Ctrl-C and re-run to resume.

### "Search the Meshy database for common textures"
Meshy has no public library-search API, so realm re-tints (frost wolf, tomb/jade
golem, poison bird, dust/bloom serpent, temple colours) are done as cheap
`retexture` passes over an already-built base mesh — build the shape once,
re-skin per realm. See the `variants` field in the manifests.

---

## 2. Rig

Meshy returns one **un-rigged** fused mesh. The game animates creatures by moving
**named child objects** every frame (`body/head/jaw/legFL/…/eye/core/crown` — see
`docs/ENEMY-ROSTER.md`). `meshy_rig.py` produces a game-ready GLB:

```bash
python tools/meshy_rig.py                 # rig every creature → _rigged/
python tools/meshy_rig.py --only wolf,tyrant
```

It reorients each mesh to the game convention (**up +Y, forward +X, feet on
y=0**), wraps the textured mesh as `body` under `root`, and adds the emissive
proxy parts the animator pulses: `eye`(s), `core` (constructs), gold `crown`
(bosses).

**Scope (important):** this is a first-pass **"oriented wrap"** — it makes models
load correctly and animate at the body level (breathe/bob/lunge/flinch/crumple)
with glowing eyes/core/crown. It does **not** slice the fused mesh into separate
moving legs/jaw/wings/tail; per-limb articulation is a hand-rig / retopo step. The
`PLAN` map in `meshy_rig.py` is where that hooks in.

**To ship a rigged model:** copy `_rigged/<id>.glb` over
`static/assets/monsters/<id>.glb` (back up the procedural one first — it stays the
animation-ready fallback until a model is promoted).

---

## 3. Gallery

```bash
python tools/meshy_gallery.py             # → tools/samples/gallery.png
```

Reads thumbnail URLs from the state files and tiles every render into one
labelled contact sheet.

---

## 4. Map upgrade — island props & terrain textures

Two more manifests + a bake step dress the board:

```bash
# island filler props (rocks, ruins, wrecks, crystals, bones, idols…)
python tools/meshy_forge.py --manifest meshy_props --state .meshy_props_state.json \
    --out ../static/assets/props --concurrency 7 --yes
python tools/meshy_optimize.py ../static/assets/props --texsize 1024

# biome ground tiles → tileable terrain textures
python tools/meshy_forge.py --manifest meshy_ground --state .meshy_ground_state.json \
    --out ../static/assets/ground --concurrency 6 --yes
python tools/meshy_ground_bake.py        # → static/assets/textures/ground_*.jpg
```

**REQUIRED final pass — mesh + texture crunch.** Raw Meshy GLBs are ~25k verts
and 4-6 MB each; the realms scatter hundreds of clones (the Vale alone plants
560 trees), so unoptimized drops are unplayable and balloon the pre-game load.
After any props/structures drop, run gltf-transform over the new files
(NEVER over `monsters/` — flatten/join destroys the rigged node names):

```bash
# heavy-scatter flora (trees, dunes, bergs, shards, lily pads, scrub):
npx @gltf-transform/cli optimize static/assets/props/<id>.glb static/assets/props/<id>.glb \
    --compress quantize --texture-compress webp --texture-size 512 \
    --simplify-ratio 0.08 --simplify-error 0.02
# other props: same but --simplify-ratio 0.25 --simplify-error 0.01
# structures:  same but --texture-size 1024 --simplify-ratio 0.35 --simplify-error 0.005
```

Quantize + WebP load natively in three's GLTFLoader (KHR_mesh_quantization /
EXT_texture_webp) — no extra decoders. Verify with `static/scaletest.html`
after crunching; heights must still match props.js / islands.js targets.

Wiring (already in the frontend):
- `static/props.js` loads the prop GLBs; `islands.js` scatters them across the
  realm field per biome (the "filler in the maps").
- `islands.js` `makeTerrain` UV-maps the biome texture onto the terrain,
  multiplied by the existing height-based vertex colours (MirroredRepeat hides
  seams). Textures come from Meshy ground tiles via `meshy_ground_bake.py`.
- `static/islandtest.html` is a standalone harness that renders one island per
  biome for quick visual checks (served by the app at `/static/islandtest.html`).

## Credits & cost

~15 credits per model (preview 5 + refine 10), +10 per retexture variant, more
with `--hd`. Full roster ≈ 600 credits. The forge prints an estimate and your
live balance before spending and honours `--budget`.

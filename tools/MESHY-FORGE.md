# Meshy Forge — AI-rendered creatures for Thalassa

A workflow that renders Thalassa's creatures through the **Meshy AI** text-to-3D
API, starting with the most complicated models (bosses) and working down to the
grunts, all in one shared low-poly board-game art style.

## Files

| File | What it is |
|---|---|
| `meshy_prompts.py` | The prompt manifest — one style-consistent prompt per model, ranked most-complicated-first. Edit prompts here. |
| `meshy_forge.py` | The driver — submits jobs, polls, downloads GLBs, resumes. |
| `.meshy_state.json` | Auto-written checkpoint (task ids + results). Safe to delete to start over. |
| `static/assets/monsters/_meshy/*.glb` | Output (a **staging** dir — the working procedural GLBs are never touched). |

## How it keeps the game's look

Every generation shares one `STYLE` suffix and one `NEGATIVE` prompt
(`meshy_prompts.py`), lifted from `docs/ENEMY-ROSTER.md`'s global art direction:
*flat-shaded low-poly, faceted, matte clay, solid hand-painted colours,
tabletop-miniature silhouette, neutral forward pose, plain background.* The
per-model text only describes the creature; the shared style is what makes 35
separate renders read as one game.

## "Search the Meshy database for common textures" → base-mesh reuse

Meshy has **no public community/library search API** (the asset library is
web-only). The credit-efficient equivalent, which the forge implements, is
**build the shape once and re-skin it per realm** with the `retexture` endpoint:

- `wolf` → `wolf_frost`
- `golem` → `golem_tomb`, `golem_jade`
- `serpent` → `serpent_dust`, `serpent_bloom`
- `bird` → `bird_poison`

A retexture pass reuses the base geometry and only repaints it, so realm tints
cost ~1 texture job instead of a full generation — exactly the reuse the game
already does (one `wolf` model serves four named enemies).

## Usage

```bash
export MESHY_API_KEY=msy_...          # your key

python tools/meshy_forge.py --plan                 # show order + credit estimate, spend nothing
python tools/meshy_forge.py --tier boss --yes      # render the 8 showpiece bosses
python tools/meshy_forge.py --only tyrant,wyrm --yes
python tools/meshy_forge.py --max 3 --yes          # first 3 by complexity
python tools/meshy_forge.py --preview-only         # skip the texture pass (cheaper)
python tools/meshy_forge.py --budget 120 --tier boss   # abort if estimate > 120 credits
python tools/meshy_forge.py --status               # what's done / pending
```

Selection flags (`--only`, `--tier`, `--max`) combine. `--tier` accepts
`boss,elite,heavy,mid,grunt,hero,prop`.

### Resume / safety

- Every job id is checkpointed to `.meshy_state.json` **before** waiting, so
  Ctrl-C or a crash never loses a paid job — re-run the same command and it
  picks up where it left off.
- Already-downloaded models are skipped.
- It prints the credit estimate and your live balance and asks before spending
  (pass `--yes` to skip the prompt, e.g. for background runs).

## Credit budget

Approx public pricing per model: preview ~5 + refine ~10 = **~15 credits**, plus
~10 per retexture variant. Full roster ≈ **585 credits**. Do the bosses first
(~120) and continue as budget allows — that is the default ordering.

## ⚠️ Rigging caveat (important)

Meshy returns **one un-rigged watertight mesh**. It does **not** contain the
named child parts (`body`, `head`, `jaw`, `legFL`, `wingL`, `eye`, `crown`, …)
that the game's procedural animator drives *by name* (see the rig contract in
`docs/ENEMY-ROSTER.md`). Loaded as-is via `monsters.js`, a Meshy mesh will
display and be auto-scaled, but it will **not articulate** — the animator only
moves parts it can find by name.

So treat these outputs as:

1. **Showpiece / hero stills** and high-detail display meshes, and/or
2. **Retopo & sculpt references** for a hand-rig pass that splits the mesh into
   the contracted named parts.

The procedural `make_monsters.py` GLBs remain the animation-ready source; the
forge writes to `_meshy/` so you can compare side-by-side and promote a model
into `static/assets/monsters/` (with `--out`) only after it's been rigged.

# THALASSA — Meshy AI Model Pipeline

A workflow that replaces the procedural Blender placeholders in
`static/assets/monsters/` with AI-generated models from
[Meshy](https://www.meshy.ai), starting with the most complicated ones
(bosses → hero → elites → floaters), while the common beasts come from the
Meshy community model database.

Everything lives in `tools/meshy/`:

| File | Role |
|---|---|
| `manifest.json` | Per-model Meshy prompts (derived from `docs/ENEMY-ROSTER.md`), priority order, tiers, realm texture variants, library search queries. |
| `pipeline.py` | The workflow CLI — generation, polling, download, post-processing, install. Stdlib only, no dependencies. |
| `state.json` | Resume-safe task state (created on first run; safe to commit). |

Staged output goes to `static/assets/meshy/<id>.glb` for review;
`install` promotes a model into `static/assets/monsters/` (the Blender
placeholder is kept once as `<id>.glb.bak`).

## Setup

1. Get an API key at meshy.ai → Settings → API.
   **Never commit the key.** If a key has ever been pasted into a chat,
   issue tracker, or commit, rotate it — treat it as leaked.
2. Locally: `export MESHY_API_KEY=msy_...`
   On GitHub: add it as the Actions secret `MESHY_API_KEY`.

## The workflow

```bash
python tools/meshy/pipeline.py balance        # credits left
python tools/meshy/pipeline.py plan           # roster, prompts, cost estimate
python tools/meshy/pipeline.py run --tier boss    # generate + wait (the big ones)
python tools/meshy/pipeline.py status
python tools/meshy/pipeline.py install --models tyrant,wyrm   # go live
```

`run` starts a Text-to-3D **preview** task per model (geometry), then a
**refine** task (textures) using the manifest's `texture_prompt`, downloads
the GLB and post-processes it. Preview ≈ 5 credits, refine ≈ 10, so budget
roughly **15 credits per model** (~330 for the whole generated set). Kill it
any time; `poll --watch` resumes from `state.json`.

Generation order is the manifest's `priority` — the most complicated,
most distinctive silhouettes first:

1. **Bosses** — tyrant (The Dark Lord), wyrm, matriarch, colossus,
   stag_king, warden
2. **Hero** — captain
3. **Elites & constructs** — shambler, golem, harpy, wraith, shade
4. **Distinctive mids/grunts** — siren, briar, stalker, drowned, cyclops,
   scorpion, drake, faun, raider, skiff

### CI alternative (no local setup)

Actions → **Meshy model generation** → Run workflow. Pick a tier or list
model ids; staged GLBs are committed back to the branch and uploaded as an
artifact. (Note: Claude Code cloud sandboxes block `api.meshy.ai`, so run
the pipeline locally or via this Action.)

## Common models: search the Meshy database

Everyday beasts (wolf, fox, jackal, boar, stag, jaguar, bird, vulture,
monkey, crab, serpent) don't need bespoke generation — the
[Meshy community library](https://www.meshy.ai/discover) is full of good
low-poly ones. Their manifest entries are `method: "library"` and carry a
ready-made `library_query` (e.g. `low poly wolf stylized`):

1. Search the query on meshy.ai/discover, pick a model that matches the
   game's flat-shaded board-game look, download the **GLB**.
2. Bring it into the game contract:
   `python tools/meshy/pipeline.py import wolf ~/Downloads/wolf.glb`
3. Review, then `install --models wolf`.

(There is no public API endpoint for searching the community library, so
this step is a short manual loop; every library model still gets a full
generation prompt as a fallback — `generate --models wolf` works too.)

## Realm texture variants

Models reused across realms (frost wolf, tomb/emerald golem, dust/bloom
serpent, poison bird, mirage wraith) reuse **one mesh** with a Meshy
Text-to-Texture pass driven by the manifest's `variants`:

```bash
python tools/meshy/pipeline.py retexture golem --variant tomb
```

This writes `static/assets/meshy/golem.tomb.glb`. The game also tints
per-instance, so only make a texture variant when a tint isn't enough.

## Keeping the game's look

Every prompt is wrapped by the manifest's `style_prefix` / `texture_style`
(low-poly, flat-shaded, faceted, matte solid colors, board-game miniature,
Greek-myth palette) so generated models sit next to the hand-built world.
Post-processing (`pipeline.py` → `postprocess_glb`) then enforces the
contract from `docs/ENEMY-ROSTER.md`:

- wraps the mesh as `root → body → …` so the procedural animator
  (`static/monsters.js`) drives body-level animation (breathe, bob, attack
  lunge, flinch, death crumple);
- yaws the model 90° so it faces **+X** (override per model with a
  `yaw_deg` manifest field if a generation comes out facing oddly);
- drops the feet to `y = 0` (skipped for floaters — wraith, shade, siren,
  warden — which hover);
- forces matte, non-metallic materials;
- height doesn't matter — the game rescales by measured height.

### Known degradations (accepted)

- **Limb articulation:** Meshy outputs a single mesh, so named parts
  (`legFL`, `jaw`, `wingL`, `tail0`…) don't exist and those animations
  no-op; the model still breathes/lunges/dies via `body`. If a showpiece
  needs full articulation, split and name its parts in Blender afterward —
  the rig contract in `docs/ENEMY-ROSTER.md` §0 is all you need.
- **Emissive parts:** `eye`/`core` glow pulses and boss enrage (eyes shift
  red) need named emissive nodes; baked-in glow textures read fine but
  won't animate.
- **Captain tint:** the game recolors a material named `PlayerTint`
  (fallback `cloth`). After generating the captain, rename its tunic
  material accordingly in Blender or players won't get their colors.

## Reviewing before install

`tools/preview_monsters.py` renders the GLBs; or run the game
(`uvicorn server:app`) after `install` — battles pull models by id. If a
generation is bad, `generate --models <id> --force` rerolls it.

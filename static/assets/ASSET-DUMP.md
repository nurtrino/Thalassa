# Thalassa — Meshy Asset Dump

**Generated 2026-07-04** via the Meshy AI pipeline (`tools/MESHY-PIPELINE.md`).
A complete, style-consistent set of stylized low-poly board-game assets:
creatures, map structures, island props, biome flora, and environment dressing.
All share one flat-shaded matte "board-game miniature" look; textures on the
GLBs are downscaled to web-loadable sizes (≤1024px).

## What's in the dump

| Category | Path | Count | Notes |
|---|---|---|---|
| **Creatures (rigged)** | `monsters/_rigged/*.glb` | 41 | 35 species + 6 realm re-tints. Reoriented (+X fwd, grounded), `body`+`eye`(+`core`/`crown`) named parts. |
| **Map structures** | `structures/*.glb` | 14 | Pharos, temples (+4 realm tints), ship, obelisk, lighthouse, dock, market, tents, gate, sand-spire. Base-free. |
| **Filler props** | `props/*.glb` | 14 | boulder, ruined_column, shipwreck, crystal_cluster, broken_statue, cairn, dead_tree, driftwood, amphora_pile, coral, mushroom_cluster, ice_shard, bone_pile, mossy_idol |
| **Biome flora** | `props/*.glb` | 11 | pine_tree, pine_snow, palm_tree, cypress_tree, olive_tree, autumn_tree, jungle_tree, cactus, dead_scrub, fern_cluster, reeds |
| **Environment props** | `props/*.glb` | 12 | iceberg, sand_dune, barrel, fishing_net, brazier, stone_well, sarcophagus, ruined_arch, banner_pole, campfire, lily_pads, tide_pool |

(Flora + environment props live in `props/` too — they load and scatter through
the same `static/props.js` path.)

## How it's wired into the game

- **Props / flora / environment** — `static/props.js` loads them; `islands.js`
  scatters a biome-appropriate mix across each realm's field (the map filler).
  `propGroup(id)` works for any id above; add ids to a biome's scatter list in
  `buildIsland`'s realm block.
- **Terrain** — solid stylized colour. The island keeps its height-based vertex
  colours (sand/grass/rock) and multiplies in one neutral procedurally-painted
  mottle (`paintedGroundTexture()` in `islands.js`) for a hand-painted feel. No
  texture image files — recolour islands purely via the theme `palette`. *(The
  earlier Meshy photo-ground textures were pulled — too busy for the style.)*
- **Creatures** — staged in `monsters/_rigged/`. To use one in-game, copy it
  over `monsters/<id>.glb` (back up the procedural one first).

## Not shipped (reproducible from the pipeline)

- `monsters/_meshy/` — raw 8K-textured intermediates (gitignored).
- `ground/` — raw Meshy ground-tile GLBs (gitignored; superseded by the
  procedural terrain).

## Regenerate / extend

See `tools/MESHY-PIPELINE.md`. Manifests: `meshy_prompts.py` (creatures),
`meshy_structures.py` (landmarks), `meshy_props.py` (filler), `meshy_flora.py`
(plants), `meshy_env.py` (environment). Rig with `meshy_rig.py`, shrink textures
with `meshy_optimize.py`.

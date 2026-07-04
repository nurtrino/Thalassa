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
| **Realm backdrops** | `backdrops/*.glb` | 5 | mountains_aegean, mountains_ice, mountains_desert, mountains_jungle, hills_autumn — horizon mountain-wall / crescent ranges matched to `theme.wall.*`, for `wall.js` |
| **Environment props** | `props/*.glb` | 18 | iceberg, sand_dune, barrel, fishing_net, brazier, stone_well, sarcophagus, ruined_arch, banner_pole, campfire, lily_pads, tide_pool, **buoy, ice_floe, tomb, barrow, monster_totem, waymarker_stone** |

(Flora + environment props live in `props/` too — they load and scatter through
the same `static/props.js` path.)

### Which procedural map element each prop can replace

| Procedural (islands.js) | Meshy prop | Status |
|---|---|---|
| desert waypoint `makeCairn`/`makeRibs` | `cairn` / `bone_pile` | in the desert scatter pool |
| hub rock clusters `makeRock` | `boulder` | in the universal scatter pool |
| boss den `makeTomb`/`makeBarrow` | `tomb` / `barrow` | **wired** at the lair-on-foot node |
| ice `makeFloe`/`makeBerg` | `ice_floe` / `iceberg` | in the ice scatter pool |
| sea `makeBuoy` | `buoy` | in the hub scatter pool |
| Vale waymarker stones | `waymarker_stone` | in the autumn scatter pool |
| monster-node `makeMonsterTotem` | `monster_totem` | *left procedural* — it carries the ember light + red-eye glow that signal an ACTIVE monster node; swap the model but keep that FX if you wire it |

FX-only elements (foam rings, shallow discs, beacons, Pharos fire/beam, shrine
flames, glow sprites, sky/clouds/weather, battle backdrops) stay procedural —
they're light/particle effects, not meshes.

### Realm backdrops & boss lairs (wall.js / islands.js)

- **Mountain wall + horizon crescents** (`backdrops/`) — Meshy versions of
  `wall.js`'s `buildMountainWall` / `buildRealmBackdrop`, one range per realm.
  To use: load the biome's range and repeat/scale it around the ~560-unit ring
  in place of the procedural peaks (keep the gate-channel gaps). Left procedural
  by default — the ring is a tuned single-draw-call set-piece — so these ship as
  drop-in alternates.
- **Boss lairs** — `tomb` (desert) and `barrow` (Vale) are **wired** at the
  lair-on-foot node in `islands.js` (replacing `makeTomb`/`makeBarrow`), scaled
  ~2.6×, with the relic-beacon FX kept.

### Bases

- **Creatures / scattered props** — regenerated base-free. Any residual thin
  base rim is hidden by `props.js`, which grounds every prop then sinks it ~8%
  so it nestles into the terrain (no floating disc).
- **Architecture** (temples, market, tents) — keep their stepped stone
  stylobate; that reads as intentional and is fine placed on an island.

### QA pass (2026-07-04)

Every model was zoomed and defect-checked. Fixes regenerated with corrected
prompts: `sarcophagus` (was a chest → anthropoid coffin), `cyclops` (two eyes →
one, now holding the club), `serpent`/`_dust`/`_bloom` (heads faced the sky →
forward), `kraken` (removed a floating tentacle ring), `skiff` (mast re-seated
upright), `shambler` (mesh artifacts), `jaguar` (removed a black puddle),
`stag` (melted legs), `stag_king` (removed a stray figure at the antlers),
`scorpion` (restored the stinger tail), `stalker` (was a spindly mess), `tomb`
(tidied the collapsed top). Each carries a targeted `negative` in its manifest.

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

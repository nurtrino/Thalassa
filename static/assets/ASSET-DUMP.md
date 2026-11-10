# Thalassa — Meshy Asset Dump

**Generated 2026-07-04** via the Meshy AI pipeline (`tools/MESHY-PIPELINE.md`).
A complete, style-consistent set of stylized low-poly board-game assets:
creatures, map structures, island props, biome flora, and environment dressing.
All share one flat-shaded matte "board-game miniature" look; textures on the
GLBs are downscaled to web-loadable sizes (≤1024px).

> **V2 triage (2026-11).** The set below is what SHIPS after the V2 model
> triage: weak sculpts, the unused mountain backdrops and the duplicate
> `monsters/_rigged/` folder were deleted (381 MB → 164 MB). The catalogue —
> kept / removed (with reasons and stand-ins) / to remake — is
> **`docs/MODELS.md`**; the live contact sheet is `/static/modeltest.html`.
> The "flat-shaded matte miniature" wording above describes the original
> generation prompts; in V2 the kept sculpts are finished per material class
> for the HDR renderer by `static/modelmat.js`.

## What's in the dump

| Category | Path | Count | Notes |
|---|---|---|---|
| **Creatures** | `monsters/*.glb` | 32 | 28 sculpts + 4 realm re-skins (`golem_tomb`, `golem_jade`, `serpent_dust`, `serpent_bloom`). +X forward, grounded; one fused `body` mesh plus auto-rig helper meshes (`eye`/`core`/`crown`) that `monsters.js` strips or rebuilds. Nine more model ids are served by stand-ins (`STAND_INS` in `static/monsters.js`). |
| **Map structures** | `structures/*.glb` | 14 | pharos, lighthouse, temple (+4 realm tints), ice_temple, market, dock, obelisk, tents, ship, gate_portal. (`ship` and `gate_portal` are kept but not mounted.) |
| **Filler props** | `props/*.glb` | 13 | boulder, shipwreck, crystal_cluster, broken_statue, cairn, dead_tree, driftwood, amphora_pile, coral, mushroom_cluster, ice_shard, bone_pile, mossy_idol |
| **Environment props** | `props/*.glb` | 14 | barrel, fishing_net, brazier, stone_well, sarcophagus, ruined_arch, banner_pole, campfire, lily_pads, tide_pool, tomb, barrow, waymarker_stone, jungle_dungeon |
| **Biome flora** | `props/*.glb` | 9 | pine_tree, pine_snow, palm_tree, cypress_tree, olive_tree, jungle_tree, dead_scrub, fern_cluster, reeds (+ `amber_tree`, a recoloured `olive_tree` variant defined in `props.js`) |

**Removed in V2** (never requested by the client any more): creatures `bird`,
`bird_poison`, `fox`, `jaguar`, `monkey`, `cyclops`, `stag`, `wolf`,
`wolf_frost`; props `ruined_column`, `sand_dune`, `ice_floe`, `iceberg`,
`monster_totem`, `buoy`, `cactus`, `autumn_tree`; structure `sand_spire`; all of
`backdrops/` and `monsters/_rigged/`.

(Flora + environment props live in `props/` too — they load and scatter through
the same `static/props.js` path.)

### Which procedural map element each prop can replace

| Procedural (islands.js) | Meshy prop | Status |
|---|---|---|
| desert waypoint `makeCairn`/`makeRibs` | `cairn` / `bone_pile` | in the desert scatter pool |
| hub rock clusters `makeRock` | `boulder` | in the universal scatter pool |
| boss den `makeTomb`/`makeBarrow` | `tomb` / `barrow` | **wired** at the lair-on-foot node |
| ice `makeFloe`/`makeBerg` | ~~`ice_floe` / `iceberg`~~ | **removed in V2** — bergs/floes are to be rebuilt (docs/MODELS.md) |
| sea `makeBuoy` | ~~`buoy`~~ | **removed in V2** — the waypoint buoy is procedural again (`makeBuoy`, a lathe-turned spar buoy) |
| Vale waymarker stones | `waymarker_stone` | in the autumn scatter pool |
| monster-node `makeMonsterTotem` | ~~`monster_totem`~~ → `waymarker_stone` + `bone_pile` | **removed in V2**; the node marker is now a rune stone over a bone heap, with the same ember light + haze FX |

FX-only elements (foam rings, shallow discs, beacons, Pharos fire/beam, shrine
flames, glow sprites, sky/clouds/weather, battle backdrops) stay procedural —
they're light/particle effects, not meshes.

### Realm backdrops & boss lairs (wall.js / islands.js)

- **Mountain wall + horizon ranges** — procedural and lit (`static/gfx/mountains.js`,
  `wall.js`). The five Meshy `backdrops/` ranges were never mounted and were
  deleted in V2.
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
- **Creatures** — `static/monsters.js` loads `monsters/<id>.glb`, finishes the
  material, normalizes the height and animates by named part. Ids without a
  file are mapped to a recoloured kept sculpt by `STAND_INS`.
- **Landmarks** — `static/structures.js` (`glbProp`), mounted by `islands.js`.

## Not shipped (reproducible from the pipeline)

- `monsters/_meshy/` — raw 8K-textured intermediates (gitignored).
- `monsters/_rigged/` — the auto-rig's staging output (promote a keeper to
  `monsters/<id>.glb`, then delete; never commit the folder).
- `ground/` — raw Meshy ground-tile GLBs (gitignored; superseded by the
  procedural terrain).

## Regenerate / extend

See `tools/MESHY-PIPELINE.md`. Manifests: `meshy_prompts.py` (creatures),
`meshy_structures.py` (landmarks), `meshy_props.py` (filler), `meshy_flora.py`
(plants), `meshy_env.py` (environment). Rig with `meshy_rig.py`, shrink textures
with `meshy_optimize.py`.

# Thalassa — model catalogue (V2)

The 3D models are GLB files under `static/assets/`. This file is the single
source of truth for **what is kept, what was removed and why, what stands in
for the removed ones, and what should be remade** (with an art note per model).

- **Live contact sheet:** `/static/modeltest.html` — every kept model, through
  the real loaders and the real renderer, under any stage's lighting
  (`?set=monsters|standins|captains|props|structures&look=hub|ice|desert|jungle|autumn|pharos`).
- **Battle check:** `/static/battletest.html?model=<ids>&region=<stage>` stages
  any enemy (including stand-in ids) in the real battle scene.
- **Regeneration pipeline:** `tools/MESHY-PIPELINE.md`, `tools/MESHY-FORGE.md`
  (prompt manifests: `tools/meshy_prompts.py` creatures, `meshy_props.py`,
  `meshy_env.py`, `meshy_flora.py`, `meshy_structures.py`).

| | before V2 | after V2 |
|---|---|---|
| `static/assets` | 381 MB | 164 MB |
| creature files | 41 (+41 byte-identical copies in `_rigged/`) | 32 |
| prop files | 44 | 36 |
| structure files | 15 | 14 |
| backdrop files | 5 (never loaded) | 0 |

## How a model gets on screen

| Kind | Loader | Notes |
|---|---|---|
| creatures | `static/monsters.js` — `getMonster(id)` | finish → species height → clone per instance → procedural animation by named part |
| props, flora | `static/props.js` — `propGroup(id, scale)` | finish → natural height → grounded and sunk 8% |
| landmarks | `static/structures.js` — `glbProp(id, {h | len})` | finish → world height; mounted by `islands.js` |
| material finish | `static/modelmat.js` | shared by all three (see below) |

**Material finish.** Every sculpt ships one baked PBR material (base colour,
metal/roughness, normal, usually emissive). Raw, the roughness maps average
~0.5 (everything looked glazed), some stone is flagged half-metal, and several
emissive maps contain plain white surfaces (snow, marble, pale fur). The finish
pass gives each model a class — `stone marble wood cloth foliage hide wet metal
ice crystal ember` — which sets: the range the baked roughness is remapped
into, how much of the baked metal map is honoured, the HDR gain of the
emissive map (values above 1.0 bloom), a chroma gate that rejects white
"emissive" texels, single- vs double-sided rendering, and optionally a
desaturate + tint recolour or a hue-keyed "painted glow" (eyes, visor slits,
flames that the emissive map missed). The per-model tables are `MONSTER_FINISH`
(monsters.js), `PROP_FINISH` (props.js) and `STRUCT_FINISH` (structures.js).

**Geometry repair (also in `modelmat.js`, once per geometry at load).**

- *Zero-length normals.* Six kept files contain vertices whose normal is
  (0,0,0): `props/jungle_tree` (14 vertices), `props/jungle_dungeon` (4),
  `props/lily_pads` (2), `structures/dock` (2), `structures/lighthouse` (8),
  `structures/tents` (23) — 53 in all. A zero normal becomes a NaN pixel, and
  the bloom blur spreads one NaN over the whole HDR frame (a black screen at
  some angles). The loader replaces each with the average normal of its
  faces (else of a co-located vertex, else +Y). The files themselves are
  unchanged — fix them at the source when they are next re-exported.
- *Creatures have no normals at all.* None of the 32 creature GLBs carries a
  normal attribute (the auto-rig export dropped it), so three.js was
  flat-shading them under normal maps baked for smooth surfaces. The loader
  now builds crease-aware smooth normals (welded across UV seams by position,
  split at edges sharper than 62°). A re-export should write real normals.
- No creature file has a zero-length normal (they have none to be zero).

**Auto-rig helper meshes.** `tools/meshy_rig.py` adds `eye` balls, a `core`
ball and a gold `crown` ring to each creature at bounding-box guesses; they
float off the sculpt. The loader removes `eye` and `core` (the real eyes and
crystal cores glow from the emissive map / painted-glow key instead) and
rebuilds `crown` as a 3D gold circlet with a ruby, seated on the boss's head
(the highest point of the front of the body), which the animator sways.

---

## Round 2 — inventory of every old model on screen, and what replaced it

The procedural models live in `static/models/` (no new binary assets):

| file | what |
|---|---|
| `models/kit.js` | the workshop: cached materials (vertex colour × tiling grain: stone, ashlar, marble, plaster, wood, cloth, tiles, bronze, gold), `Parts` (merge a model per material → few draw calls), `lathe` (crease rows, flutes), soft-bevelled `box`, `tube`, `blob`, **`rockGeometry`** (the one rock generator: fracture planes, strata, bleached tops, moss/snow cover), HDR `flame`, `animate(obj, fn)` (self-animation via onBeforeRender, no scene hook) |
| `models/landmarks.js` | Pharos (+ isle dressing, sealed gate), shrine temples, puzzle spire, haven camps, checkpoint lamp, market, home-port town, harbour lighthouse, lair altar, relic urn, realm gates, wall-pass lintel + fire-bowl pillars, `battleStructure()` (battle-set temples / lighthouse) |
| `models/props.js` | `makeRock`, `makeRockCluster`, fishing caique, crate / amphora / barrel geometries, flotsam raft, turn marker, reach beacon, sea lane, foot trail |
| `models/eventprops.js` | the event set pieces (API in the file header) |
| `models/catalog.js` | every procedural model by id — `modeltest.html?set=procedural` (labels show triangles and draw calls) |

| model (old) | where it is used | verdict | status / replacement |
|---|---|---|---|
| `pharos` GLB + sphere fire + vertical beam cylinder | the Pharos | redesign | **done** `makePharos()`: stepped podium, battered square tier with pilasters and window rows, octagon, drum, 8-column lantern, verdigris dome, sun-disc finial; lantern fire (`pharosfire`), twin soft beams sweeping the horizon, one point light |
| Pharos isle (bare sand mesa) | the Pharos | redesign | **done** `dressPharosIsle()`: rocky shoulder (shore layer), curved harbour mole with lamp, ruined peristyle with lintels, cypresses/olives; dry-grass palette |
| `makePharosGate` (flat boxes — and it was **never mounted**) | Pharos door | redesign | **done** marble door frame with gable, bronze panelled/studded leaves on `doorPivotL/R`, gold-ringed `sigil0..2`; now mounted, so scene.js's seal sockets and door swing work again |
| `temple`, `temple_ice/desert/jungle/autumn` GLBs (five near-identical gazebos) + a point light each | shrines | redesign | **done** `makeShrineTemple(hex, realm, spent, seed)`: tholos or tetrastyle prostyle (hub picks by domain), fluted columns, painted frieze in the domain colour, tiled roofs, realm weathering (snow + icicles, sand, moss + creepers, autumn ivy); domain-coloured HDR flame on a tripod / altar; *spent* = darker stone and dull embers. No point light |
| `obelisk` GLB (464 tris) + point light | puzzle isles | redesign | **done** `makePuzzleSpire()`: slate obelisk with glowing glyph inlays on a labyrinth-mosaic plaza ringed by glyph stelae, a slowly turning gilt armillary sphere with a glowing orb; solved = dim and nearly still |
| `tents` GLB + point light | havens (sea, desert, Vale) | redesign | **done** `makeCampHaven({kind})`: striped awnings, net rack, campfire, stores (sea); bell tents + awning (desert / Vale); fishing caiques drawn up by the jetty (`boatsAt`) |
| checkpoint post + sphere | havens | redesign | **done** `makeCheckpointBeacon()`: bronze lamp-stand with azure glazed lantern, fading beam (children order kept: halo is `children[3]`) |
| `market` GLB (23k tris) | shop isles | redesign | **done** `makeMarketSquare()`: round agora, open double-colonnade stoa, four striped stalls with fruit / cloth / fish / pots, fountain |
| `lighthouse` GLB ("melted") + point light | home port | redesign | **done** `makeLighthouse()` (whitewashed tower, blue cupola, lit lantern) |
| home port (dock + tower + palms) | home | redesign | **done** `makeHomeTown()`: whitewashed cube houses with blue doors/shutters stepping up from a stone quay, blue-domed chapel with bell, caiques; layout follows the harbour bearing |
| gate portal (displaced boxes, cones, `_grandColumn`) + 2 point lights | the four realm passes (hub side) | redesign | **done** `makeGatePortal(..., realm)`: battered ashlar pylons with crenellations, a 15-voussoir arch over the open channel, the realm's emblem (snowflake / sun / serpent / antlers) glowing over the keystone, colossal fluted columns, swallow-tail banners, bronze fire bowls with blooming fire; one light |
| wall pass lintel (displaced box) + cylinder braziers, 2 lights per pass | `wall.js` | redesign | **done** `makePassLintel`, `makeBrazierPillar`; one light per pass (was two); realm backdrops likewise |
| lair altar (displaced cylinders/cones) + point light | sail lairs | redesign | **done** `makeLairAltar()`: faceted basalt dais, altar block, four curling bone horns, bronze fire bowls in the realm accent; no light |
| relic urn (flat sphere) | lairs | redesign | **done** `makeRelicBeacon()`: gilt amphora on a stone pedestal (still `beacon`, spun by scene.js) |
| `makeRock` (displaced dodecahedron, flat) | island dressing, sea rocks, puzzle, monster isles | redesign | **done** `models/props.js makeRock` (sea stacks now on the shore layer → surf) |
| `makeColumn` (box + cylinder) | Pharos terrace | redesign | **done** (peristyle above) |
| `makeFlotsam` (flat boxes) | salvage on lanes | redesign | **done** lashed plank raft, crates, barrel, coin heap + glint (`bob`) |
| hub monster stake (cylinder + displaced sphere) | calm hunting grounds | fix | **done** `footkit.warningStake` (the foot realms' skull stake) |
| monster totem point light | every monster isle | fix | **done** removed (the ember haze blooms) |
| `makeCypress/Olive/Pine/DeadScrub/JungleTree` | nowhere (dead code) | remove | **done** |
| turn marker (flat cone) | scene.js | redesign | **done** faceted gold gem + glow, HDR, fog-free |
| reach beacons (flat rings, cone chevron) | scene.js | redesign | **done** soft-edged ring, pool of light, fading shaft, gold gem chevron (same roles) |
| sea lanes (`LineDashedMaterial`) | scene.js | redesign | **done** `makeSeaLane`: soft painted wake-dashes on a faint S, fading toward both stops |
| foot trail (a draw call per cylinder stone) | scene.js | redesign | **done** `makeFootTrail`: one merged mesh of irregular flagstones per lane |
| boss crown (flat gold ring hovering over the top) | bosses | redesign | **done** thick 3D circlet with beaded points and a ruby, seated on the head (front-of-body top), sways a touch |
| battle-set `temple`, `temple_autumn`, `lighthouse` GLBs | hub / autumn battles | redesign | **done** via `battleStructure()` (islands.js hands it to the battle sets) |
| `obelisk`, `tents` GLBs in the desert battle set | desert battle | keep for now | still GLB (battle sets are the realm owner's) |
| buoy (`makeBuoy`) | sea waypoints | keep | already a good lathe model |
| barrow beacon | Vale | keep | it is a light pillar, not a model |
| name tags | ships | keep | canvas UI, reads well |
| `dock`, `ice_temple` | jetties, ice lair | keep | |
| `gate_portal`, `ship` GLBs | not mounted | keep on disk | |

Creature stand-ins — **kept** (judged side by side in the contact sheet): the
nine stand-ins are 9–14k-triangle hand-painted sculpts; a procedural
blob-and-tube wolf, fox, crow or stag would read as a toy next to the jackal,
boar and vulture sculpts under the same light, so none was swapped. Only the
grey wolf's tint was fixed (it read as a pale blue-white jackal; now a darker
warm grey).

---

## Kept — creatures (32 files)

All are single fused sculpts (`body`), 1024² maps, facing +X, feet on y = 0.
Height is the in-game species height (the captain is 1.8).

| id | used for | height | tris | finish | notes |
|---|---|---|---|---|---|
| `captain` | the player on foot (Vale, desert), battle hero | 1.8 | 19k | metal | cloak/tunic take the player colour; bronze helmet and shield are real metal |
| `tyrant` | **final boss** — the Dark Presence at the Pharos | 4.2 | 15k | metal | red eyes/horn embers glow |
| `stag_king` | **boss**, Amber Vale; also plays `stag` | 3.4 | 14k | hide | |
| `wyrm` | **boss**, Frostfang Reach | 3.6 | 22k | wet | |
| `sphinx` | **boss**, Bleached Reach | 3.6 | 9k | hide | |
| `matriarch` | **boss**, Verdigris Deep; Strangler Saplings (elite) | 4.2 | 21k | wet | lifted ×1.6, the sculpt is very dark |
| `kraken` | the Kraken riddle gauntlet (rises from the hub sea) | 4.4 | 16k | wet | eye glows |
| `colossus` | Bronze Colossus (rare hub heavy) | 4.2 | 7k | stone | red eyes glow |
| `warden` | Bronze Sentinels (rare hub heavy) | 4.6 | 16k | metal | marble hoplite, bronze helm |
| `golem` | Glacier Golems (ice); plays `cyclops` | 2.4 | 14k | stone | cyan crystal core blooms |
| `golem_tomb` | Tomb Sentinels (desert) | 2.4 | 14k | stone | amber core |
| `golem_jade` | Emerald Watch (jungle) | 2.4 | 14k | marble (polished) | green core |
| `serpent` | Reef / Deep Serpents (hub) | 2.2 | 17k | wet | |
| `serpent_dust` | Dust Serpents (desert) | 2.2 | 17k | hide | |
| `serpent_bloom` | Bloom Serpents (jungle) | 2.2 | 17k | wet | |
| `harpy` | Harpies, Storm Harpies (hub), Rime Harpies (ice) | 1.7 | 17k | hide | hovers |
| `vulture` | Bone Vultures (desert); plays `bird`, `bird_poison` | 1.25 | 13k | hide | hovers |
| `raider` | Sand Raiders (desert), Satyr Brigands, Laestrygonian Raiders (hub) | 1.8 | 16k | hide + metal blade | |
| `faun` | Thistle Fauns (autumn); plays `monkey` | 1.7 | 13k | hide | |
| `jackal` | Salt Jackals (desert); plays `wolf`, `wolf_frost`, `fox` | 1.1 | 14k | hide | |
| `boar` | Dire Boars, the Old Sounder (autumn) | 1.5 | 11k | hide | |
| `stalker` | Floe Stalkers (ice); plays `jaguar` | 1.7 | 13k | wet | |
| `shambler` | Wickerwood Shamblers (autumn) | 1.9 | 21k | wood | |
| `briar` | Briar Beasts (autumn), Vine Horrors (jungle) | 1.7 | 22k | wood | green eyes glow |
| `drake` | River Drakes, Canopy Tyrants (jungle) | 1.7 | 13k | wet | |
| `crab` | Berg Crabs (ice) | 1.3 | 13k | wet | |
| `scorpion` | Glass Scorpions, Dune Scourges (desert) | 1.6 | 9k | wet (glassy) | |
| `wraith` | Ice Wraiths, the Pale Court (ice), Mirage Dancers (desert) | 1.8 | 17k | cloth | hovers; eyes bloom |
| `shade` | Horned Shades (autumn), the Bleached Choir (desert); unknown ids | 1.8 | 21k | cloth | hovers; lifted ×2.3 (near-black sculpt) |
| `siren` | Sirens' Kin (hub) | 1.8 | 18k | wet | hovers; faint teal glow |
| `drowned` | the Drowned Crew (hub) | 1.8 | 20k | wet | orange eyes glow |
| `skiff` | Brigand Skiffs (hub) | 2.2 | 13k | wood | rides the swell |

## Kept — props and flora (36 files, 512² maps)

| id | used for | height | tris | finish |
|---|---|---|---|---|
| `boulder` | sea stacks and island rocks, all realms | 1.4 | 2k | stone |
| `cairn` | desert waypoints, ice/desert dressing | 1.4 | 7k | stone |
| `waymarker_stone` | Vale waymarkers; the monster-node marker (with `bone_pile`) | 1.6 | 3k | stone |
| `mossy_idol` | jungle island set piece | 1.6 | 4k | stone |
| `ruined_arch` | hub / jungle / desert ruin set piece | 3.0 | 2k | stone |
| `broken_statue` | hub island set piece | 1.6 | 3k | marble |
| `tomb` | the desert boss lair | 1.6 (×3.9) | 21k | stone |
| `barrow` | the Vale boss lair | 1.6 (×3.4) | 5k | stone |
| `jungle_dungeon` | the jungle boss lair | 2.4 (×2.6) | 3k | stone |
| `stone_well` | jungle / autumn camps | 2.0 | 2k | stone |
| `bone_pile` | desert dressing; the monster-node marker | 0.7 | 8k | marble (bone) |
| `amphora_pile` | hub / desert island dressing | 1.0 | 3k | marble (ceramic) |
| `sarcophagus` | desert dressing | 1.4 | 2k | metal (gold mask) |
| `shipwreck` | hub sea scatter | 3.0 | 4k | wood |
| `driftwood` | hub / jungle water scatter | 0.8 | 3k | wood |
| `dead_tree` | autumn, desert flora; Vale scatter | 2.8 | 2k | wood |
| `barrel` | autumn camps | 0.9 | 4k | wood + iron bands |
| `fishing_net` | hub sea scatter | 0.6 | 7k | cloth |
| `banner_pole` | hub island dressing | 2.6 | 5k | cloth |
| `brazier` | gate portal, lair altars, hub dressing, mountain wall | 1.2 | 3k | ember (fire blooms) |
| `campfire` | autumn camps | 0.8 | 3k | stone + painted-glow flames |
| `coral` | hub / jungle water scatter | 1.1 | 6k | wet |
| `tide_pool` | hub island dressing | 0.5 | 2k | wet |
| `lily_pads` | jungle channels (`makeVineMat`) | 0.35 | 5k | foliage (waxy) |
| `mushroom_cluster` | autumn / jungle dressing | 1.0 | 5k | foliage (glossy caps) |
| `crystal_cluster` | ice dressing | 1.6 | 3k | crystal (glows) |
| `ice_shard` | ice drift chunks (`makeFloe`), ice dressing | 1.6 | 2k | ice |
| `pine_tree`, `pine_snow` | ice flora | 3.8 | 4k / 3k | foliage |
| `palm_tree` | hub and jungle flora | 3.6 | 2k | foliage |
| `cypress_tree`, `olive_tree` | hub flora | 3.6 / 2.6 | 5k / 4k | foliage |
| `jungle_tree` | jungle flora, the jungle battle set | 3.4 | 11k | foliage |
| `dead_scrub` | desert flora | 1.0 | 3k | foliage (dry) |
| `fern_cluster`, `reeds` | jungle / hub undergrowth | 0.9 / 1.5 | 7k / 8k | foliage |

Variant (no file of its own): **`amber_tree`** — `olive_tree` desaturated and
tinted autumn copper (`PROP_VARIANTS` in props.js). It is the Amber Vale's
tree until a real autumn tree is generated.

## Kept — landmarks (14 files)

| id | used for | height | tris | finish |
|---|---|---|---|---|
| `pharos` | not mounted on the board any more (procedural `makePharos`) | 31.2 | 3k | marble |
| `lighthouse` | not mounted (procedural `makeLighthouse`) | 4.6 | 4k | marble (plaster) |
| `temple` | not mounted (procedural `makeShrineTemple`) | 4.6 | 3k | marble |
| `temple_ice`, `temple_desert`, `temple_jungle`, `temple_autumn` | not mounted (procedural shrines) | 4.6 | 3k | ice / stone / marble |
| `ice_temple` | the ice boss lair | 9.0 | 44k | ice |
| `market` | not mounted (procedural `makeMarketSquare`) | 5.0 | 23k | marble |
| `dock` | jetties on every inhabited island | 5–5.6 long | 3k | wood |
| `obelisk` | desert battle set only (puzzle spires are procedural) | 5.4 | 0.5k | stone, gold cap glows |
| `tents` | desert battle set only (havens are procedural) | 2.3 | 9k | cloth |
| `ship` | **kept, not mounted** (the player galley is procedural `makeShip`) | — | 4k | wood |
| `gate_portal` | **kept, not mounted** (the realm gates are procedural `makeGatePortal`) | — | 4k | stone |

---

## Removed in V2

Files deleted; the client never requests them. `propGroup(<removed prop>)` and
`glbProp('sand_spire')` return an empty group silently (`REMOVED_PROPS`,
`REMOVED_STRUCTURES`); removed creature ids are served by `STAND_INS`.

### Creatures (the server still names these ids — board.py is unchanged)

| id | enemies | why it was cut | stands in now |
|---|---|---|---|
| `wolf` | Leafshade Wolves (autumn), Sea Wolves (hub); also battle.js's default id | faceted low-poly with flat grey paint — the old style, clashes with the smooth sculpts | `jackal` ×1.3, desaturated grey coat |
| `wolf_frost` | Frost Wolves, Frostfang Alphas (ice) | same mesh, white repaint | `jackal` ×1.35, bleached to rime-blue |
| `fox` | Snow Foxes (ice) | faceted, untextured white, reads as an unpainted blank | `jackal` at fox size, white |
| `bird` | Carrion Crows (autumn), Stymphalian Birds (hub) | stiff turkey-fan pose, solid black, no readable features | `vulture` at 1.0, black plumage |
| `bird_poison` | Poison Birds (jungle) | same mesh, garish green repaint | `vulture` at 1.0, venom green |
| `jaguar` | Jaguar Shades (jungle) | featureless black blob, head-down pose, no face | `stalker` in a night-black coat, green glow |
| `monkey` | Thorn Monkeys (jungle) | a photoreal crouching chimp — wrong style, nothing "thorn" about it | `faun` at 1.15, darkened |
| `cyclops` | Cyclops Herdsmen (hub) | muddy red figure, fist hides the one eye, stray club stub | `golem` at 2.6 in weathered umber, ember crystals |
| `stag` | Stag Spirits (autumn) | faceted low-poly, melted-thin legs | `stag_king` at 2.0, no crown |

Any id the client has never heard of is shown as a tinted `shade` (and logged
once); if a GLB fails to load at all, a small procedural hooded spectre takes
its place (`buildFallback` in monsters.js).

### Props, structures, folders

| id | why it was cut | what happens now |
|---|---|---|
| `ruined_column` | a fallen hollow tube — reads as a pipe, not a fluted column | empty; hub dressing uses `ruined_arch` / `broken_statue` |
| `sand_dune` | an orange rock heap; dunes are real terrain now | empty (`makeDune`) |
| `ice_floe` | a square slab, reads as a floor tile | empty; `makeFloe` uses `ice_shard` |
| `iceberg` | low faceted cone on a skirt, plastic at 4.5u | empty (`makeBerg`) — the ice realm needs a new berg |
| `monster_totem` | a black post with two red dots | the node marker is `waymarker_stone` + `bone_pile` with the same ember light |
| `buoy` | bottle-shaped toy with a lantern clipped to its side | procedural spar buoy (`makeBuoy` in islands.js) |
| `cactus` | cartoon saguaro, flat green, wrong continent | empty; desert flora is `dead_scrub` / `dead_tree` |
| `autumn_tree` | glossy orange blob canopy | empty; autumn flora is the `amber_tree` variant + `dead_tree` |
| `sand_spire` (structure) | melted chess-piece lump, never mounted | empty |
| `backdrops/` (5 files) | never loaded; ranges are procedural and lit (`gfx/mountains.js`) | deleted |
| `monsters/_rigged/` (41 files, 170 MB) | byte-identical copies of `monsters/*.glb` (auto-rig staging output) | deleted; it is a staging folder, never commit it |
| `monsters new.rar` (repo root) | obsolete archive of the old procedural models | deleted |
| `static/music/game.mp3` | byte-identical to `hub.mp3`; only ever a fallback name | deleted; `audio.js` falls back to `hub` |

---

## To remake — prioritised

**Before generating anything, change the style prompt.** `STYLE` in
`tools/meshy_prompts.py` still asks for *"low-poly, flat-shaded, faceted, hard
edges"* — that is exactly what made `wolf`, `fox` and `stag` unusable next to
the kept sculpts. The V2 look is: **smooth-shaded stylized sculpt, hand-painted
albedo with soft painted shading, clear readable silhouette, slightly
exaggerated proportions, no photoreal detail, no base**. Match the kept
`jackal`, `boar`, `vulture`, `raider` as style anchors.

**Budgets.** Grunts 8–12k triangles, elites/bosses 14–22k; props 2–6k;
landmarks 3–10k. Maps 1024² (creatures, landmarks) or 512² (props): base
colour + normal + metal/roughness, **emissive only if something really glows**
(keep it black elsewhere — never white surfaces). Ship WebP + quantized
(`gltf-transform optimize`, see MESHY-PIPELINE.md §props) — the current
creature GLBs carry PNG maps and weigh 3–6 MB each; re-encoding them the way
the props were would take `static/assets` from 164 MB to roughly 25 MB.

**Named parts (creatures).** The animator drives children BY NAME; pivots at
the joint, facing +X, feet on y = 0. A fused `body` works (breathes, lunges,
flinches as one piece); an articulated export animates fully:

- quadruped — `body`, `head`, `jaw`, `legFL` `legFR` `legBL` `legBR`, `tail0..2`
- bird — `body`, `head`, `jaw` (beak), `wingL` `wingR`, `legL` `legR`, `tail0`
- biped — `body`, `head`, `jaw`, `armL` `armR`, `legL` `legR`, `weapon`, `shield`

Do **not** add `eye` / `core` / `crown` helper meshes — paint the glow into the
emissive map instead. After promoting a file: add the id to `MONSTER_IDS`,
`HEIGHTS`, `MONSTER_FINISH`, delete its `STAND_INS` row, check modeltest.

### Priority 1 — enemies players meet constantly (currently stand-ins)

1. **`wolf`** (+ `wolf_frost` as a retexture). Four packs across hub, autumn
   and ice, plus the default enemy. *A lean, rangy timber wolf, head low and
   forward, hackles raised into a shaggy neck ruff, long muzzle with visible
   teeth, brush tail level with the spine.* Silhouette must differ from the
   jackal: heavier chest, smaller ears, thicker tail. Grey coat with a paler
   belly and dark saddle; pale amber eyes (emissive). Frost: white-to-ice-blue
   coat, cyan eyes, frost on the ruff. 1.5u tall at the ears, ~10k tris.
2. **`bird`** (+ `bird_poison` retexture). Three packs. *A big carrion crow
   caught mid-flap: wings half-spread and raised, body pitched forward, heavy
   dagger beak open, ragged primary feathers.* It hovers in game, so legs
   tucked/trailing, not standing. Black with blue-violet sheen (let the
   roughness map carry the sheen), bronze beak for the Stymphalian read.
   Poison: emerald and black with a yellow eye and bright throat. 1.0u, ~8k.
3. **`stag`**. *A young forest stag, alert, head high, modest 6-point antlers,
   slim but solid legs (no spindles), white throat and tail patch.* Russet
   coat; a faint spectral cyan rim/eyes is welcome ("Stag Spirit"). Must read
   as kin to `stag_king` at 60% of its size. 2.0u at the antler tips, ~10k.
4. **`jaguar`**. *A heavy-shouldered jungle cat in a low prowl, head level,
   jaw slightly open, thick tail curling up.* "Jaguar Shade": charcoal coat
   with ghost-rosettes one step lighter, luminous green eyes (emissive). The
   face must be visible from the front three-quarter view. 1.4u, ~10k.

### Priority 2 — rarer enemies and realm identity

5. **`fox`**. *A small arctic fox, oversized brush tail, big triangular ears,
   dainty stance, head cocked.* Painted white fur with blue-grey shading (not
   blank white), dark nose and eye. 0.95u, ~8k.
6. **`monkey`**. *A wiry, long-armed jungle imp-monkey, knuckle-walking
   stance, thorny ridge down the spine and a crown of leaves/thorns, long
   prehensile tail.* Stylized (big hands, mask-like face), mossy green-brown
   with a pale face and yellow eyes. 1.1u, ~8k.
7. **`cyclops`**. *A towering barrel-chested herdsman, one large eye clearly
   visible in the centre of the brow, heavy jaw, sheepskin kilt, a gnarled
   club resting on the shoulder (arms away from the face).* Sun-browned skin,
   the eye amber (emissive). 2.6u, ~14k.
8. **`autumn_tree`** — the Amber Vale's signature. *A broad old oak/beech,
   twisted trunk with visible roots, three or four distinct leaf masses with
   gaps showing branches — not one blob.* Leaves from gold through copper to
   deep red, matte. 3.2u (it is scaled ×5–10 for the Vale's titan trees, so
   keep the trunk detailed), ~5k, double-sided leaves.
9. **`iceberg`** — the Frostfang Reach's signature. *A tall, sheer drifting
   berg: one dominant spire with a lower shoulder, undercut waterline notch,
   crisp fracture planes.* White crown shading to deep cyan at the waterline,
   no base skirt (it is sunk into the sea). Glossy roughness, emissive only as
   a faint blue core. 4.5u, ~3k.
10. **`ruined_column`** — hub identity. *A standing broken Doric column: fluted
    shaft on a square plinth-less footing, snapped at two-thirds height, one
    fallen drum beside it.* Weathered white marble with lichen. 1.6u, ~2k.

### Priority 3 — nice to have

11. **desert flora** to replace `cactus`: a date palm cluster, a tamarisk or
    a thorn acacia (Old-World desert, not a saguaro). 2.2–3.6u, ~3k.
12. **`monster_totem`**: a carved menhir with a beast skull lashed to it and
    ember-lit eye sockets (emissive). 2.2u, ~3k. (The rune stone + bones
    composition in use now is acceptable.)
13. **`sand_spire`**: a wind-cut sandstone hoodoo or rock arch for the dune
    sea's middle distance. 4–6u, ~4k.
14. **`ice_floe`**, **`sand_dune`**, **`buoy`**, **mountain backdrops**: do
    not remake as models — terrain, ocean and the procedural buoy cover them.

### Kept, but weak — remake when convenient

- `skiff`, `shade`, `matriarch` are very dark sculpts (lifted in the finish).
- `ice_temple` (44k) and `market` (23k) are heavy for what they are; a retopo
  to ~10k would help phones.
- The fused creatures cannot move limbs, jaws or wings; an articulated export
  of the bosses (`tyrant`, `wyrm`, `stag_king`) would pay off most.

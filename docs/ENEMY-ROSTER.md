# THALASSA — Enemy Roster & Modeling Brief

Every creature in the game, described for a Blender modeler. There are **32
distinct models** (one GLB each). Many are reused across several named
enemies and realms — e.g. one `wolf` model serves Leafshade Wolves, Frost
Wolves, Sea Wolves and Frostfang Alphas — so each model must read well in a
few tints/sizes. Where a model is reused, all its in-game uses are listed.

---

## 0. Global art direction (read first)

- **Style:** flat-shaded **low-poly**, faceted, no smooth normals. Think
  hand-painted board-game pieces, not realistic creatures. Chunky silhouettes
  that read at a distance and in a tiny battle diorama.
- **Materials:** matte (roughness ~0.9), solid colors, minimal texture. A few
  parts are **emissive** (glowing eyes, magic cores, wisps) — call those out.
- **Height standard:** the game re-scales every model to a target height, so
  build at any convenient size but keep **proportions** as described. Grunts
  sit around 1.2–1.8 units tall, elites ~1.7–2.4, **bosses 3.4–4.6** and
  should feel massive next to a ~1.8-unit hero.
- **Facing:** creatures face **+X** (their "forward"). Ground creatures stand
  with feet at **z = 0** (Y-up on export). The camera views them from the
  front-left in battle.
- **Origin/root:** one top-level empty named `root`; everything parents under
  it.

### THE RIG NAMING CONTRACT (critical — animations are procedural)

The game has **no baked animation clips**. It animates each creature by moving
child objects **by name** every frame (walk, attack lunge, jaw snap, wing
flap, tail sway, hurt flinch, death crumple, magic glow). If a part is named
correctly the animation just works; if not, that part sits still. **Please
keep these exact child names** (a Blender `.001` suffix is fine — the game
strips it):

| Part name | What it is | How it's animated |
|---|---|---|
| `body` | main mass / torso | breathes, bobs, lunges on attack, flinches on hurt |
| `head` | head (empty pivot or mesh) | tracks, dips on attack |
| `jaw` | lower jaw / mandible | snaps open on attack |
| `legFL` `legFR` `legBL` `legBR` | quadruped legs (front/back, L/R) | diagonal-pair walk gait; pivot at the hip |
| `legL` `legR` | biped legs | counter-swing walk; pivot at the hip |
| `armL` `armR` | biped arms | swing / raise; pivot at the shoulder |
| `wingL` `wingR` | wings | flap about their root; pivot at the shoulder |
| `tail0` `tail1` … `tailN` | tail segments, base→tip | sinusoidal sway; ≥4 segments animate as a slithering chain |
| `vine0` `vine1` … `vineN` | tentacle/vine limbs | writhe with phase offsets |
| `weapon` | held weapon (empty holding the blade/club/etc.) | swings on attack |
| `shield` | held shield | raises on guard/hurt |
| `eye` | glowing eye(s) — **emissive** | pulses; may shift red when a boss enrages |
| `core` | glowing heart/core — **emissive** | pulses on cast/charge |
| `wisp` | free-floating glowing motes — **emissive** | orbit the body |
| `crown` | boss crown — **gold, metallic** | present on bosses only; marks them |

Everything else (fur, plates, horns, decoration) can be named anything.

**Pivots matter.** For a limb to swing correctly its **origin must sit at the
joint** (hip/shoulder/base), not at the limb's center.

### Player-tinted material (captain only)

The `captain` model must give its **cloth/tunic** a material literally named
**`PlayerTint`**. The game recolors that material to the owning player's
color (red/blue/gold/etc.), so leave it a neutral mid-tone.

---

## 1. BOSSES (5) — the showpieces

Each realm ends in a boss (HP 12, tier-III questions); the Pharos holds the
Warden (HP 14). Bosses are ~2× the size of a grunt, **crowned** (`crown`
part, gold), and should be unmistakable and threatening. They telegraph a
"heavy blow" (a big wind-up) and **enrage** at half health (eyes shift red),
so give them a clear head/jaw and readable arms or maw.

### `stag_king` — **The Stag King** (Amber Vale / autumn, boss)
A towering elk-lord of the autumn forest. Massive stag body on long legs,
regal posture. **Enormous branching antlers** (the signature — make them
huge, 1.5–2× a normal stag's, many tines), a russet-and-bronze coat, pale
glowing eyes. A small gold `crown` nestled between the antlers. Parts:
`body, head, jaw, legFL/FR/BL/BR, tail0, eye, crown` + antlers. Palette:
deep amber/chestnut fur, bone-white antlers, autumn-gold accents.

### `wyrm` — **The Boreal Wyrm** (Frostfang Reach / ice, boss)
A great ice serpent/dragon that rears up out of the sea. Thick coiling body
of icy scales (segments `tail0…tail6`, base→tip), a horned draconic head
that rears high, fanged maw (`jaw`), swept **fins** and a ridge of ice
spikes down the spine, glowing pale-cyan eyes, a gold `crown` behind the
horns. Reads as the classic sea-dragon boss. Palette: deep glacier-blue
scales, frost-white belly/spikes, cyan glow.

### `matriarch` — **The Strangler Matriarch** (Verdigris Deep / jungle, boss)
A monstrous carnivorous plant-queen. Bulbous bark-and-moss body with a
gaping **maw** of thorn-teeth (`jaw`), glowing green eyes, and a crown of
**writhing vines** (`vine0…vine5`) reaching out from her shoulders, topped by
a lurid **bloom** (petals + emissive `core`). A gold `crown` at the apex.
Palette: dark wet bark, deep jungle green moss, a magenta/pink flower, sickly
green eye-glow, blood-red maw.

### `sphinx` — **The Sphinx** (Bleached Reach / desert, boss)
The desert's riddling tyrant: a lion couchant in sandstone gold with a human
face beneath a lapis-and-gold **nemes** headdress, folded lapis-tipped wings
(`wingL/R`), a tufted tail (`tail0`), a gold collar, glowing gold eyes, and
the boss `crown`. Rig: `body`, `head`, `jaw`, `legFL/FR/BL/BR`, `wingL/R`,
`tail0`, `eye`. She also haunts the desert road itself, stopping crossings
with typed riddles (wrong → swept 1-2 spaces back).

### `kraken` — **The Kraken** (Safe Isles, special encounter)
A mountain of teal mantle rising from the hub sea on eight thick tentacles
(vine-rigged `vine0..vine7` so they sway), heavy-lidded amber lamp-eyes, a
bone beak (`jaw`). Not a battle: it blocks a crossing (1-in-10) and poses
three ravens mind-riddles at 15s each — one miss costs your next turn. It
surfaces in the world beside the blocked ship while its gauntlet runs.

### `colossus` — **The Dune Colossus** (asset, unused)
The desert's former boss — kept as an asset; the Sphinx rules the Bleached
Reach now.

### `tyrant` — **The Dark Lord** (final boss, the Pharos)
The horror that holds the Pharos. A colossal near-black armored biped — the
largest model in the game (~7.4u, ~2× the other bosses; the frontend trims its
boss scale so it towers without punching out of frame). Red glowing `eye`s, a
dark-iron `crown` with ember tips, horns, spiked pauldrons, back-spines, and
claws. Rig contract: `body`, `head`, `armL/R`, `legL/R`, `eye`, `crown` — so it
animates like the other bipeds. Palette: near-black iron, ember-orange crown
tips, red eye-glow.

### `warden` — **The Warden of the Pharos** (asset, unused)
The former final boss — a colossal pale-marble sentinel: plumed **bronze
helmet**, a long **spear** (`weapon`), a **shield** (`shield`), a cyan `core`,
a gold `crown`. Kept as an asset; the Pharos now belongs to the Dark Lord
(`tyrant`).

---

## 2. THE HERO — `captain`
Used as the player avatar when a realm is crossed **on foot** (the desert).
A Greek hoplite: bronze **plumed helmet**, round **shield** (`shield`), a
**spear** (`weapon`), a short tunic. The tunic material MUST be named
`PlayerTint` (recolored per player). Parts: `body, head, armL/R, legL/R,
weapon, shield`. Palette: bronze helm/shield, neutral tunic (tinted in game),
tanned skin.

---

## 3. BEASTS & MONSTERS (26)

Grouped by body plan. For each: the in-game enemies that use it, and the
build. Reused models should hold up across the listed tints/sizes.

### Quadrupeds (four-legged) — rig: `body, head, jaw, legFL/FR/BL/BR, tail0(+), eye`

- **`wolf`** — Leafshade Wolves (autumn), Frost Wolves & Frostfang Alphas
  (ice, alphas are bigger/tougher), Sea Wolves (hub-lore). A lean predatory
  wolf: pointed ears, snout with `jaw`, a shaggy neck ruff/`mane`, brush
  `tail0`, glowing eyes. Must read at grunt size and at a larger "alpha"
  scale. Palette: grey (default), snow-white/pale-blue (frost), amber-grey.
- **`fox`** — Snow Foxes (ice). Smaller, daintier wolf-cousin: big ears,
  slender legs, long bushy `tail0`, pointed snout. Palette: white/silver
  (ice) or rust.
- **`jackal`** — Salt Jackals (desert). Lean scavenger canine, longer legs,
  narrow snout, thin `tail0`, tall ears. Palette: bleached tan/bone.
- **`boar`** — Dire Boars (autumn) and **Great Boar / "The Old Sounder"**
  (autumn elite, bigger). Bulky, low-slung, humped shoulders, short legs,
  **tusks** (bone), a bristly `mane`, a small curly `tail0`, blunt snout.
  Palette: dark brown/black bristle, ivory tusks.
- **`stag`** — Stag Spirits (autumn). A graceful deer with modest **antlers**
  (bone), slim legs, thin `tail0`, gentle glowing eyes (spectral). Distinct
  from the Stag King: normal-sized, ghostly. Palette: soft brown, pale-blue
  spectral eye-glow.
- **`jaguar`** — Jaguar Shades (jungle). A sleek big cat, low prowling
  stance, long `tail0` (thin), muscular, glowing green eyes (shade-spirit).
  Palette: near-black/charcoal with a faint green glow.
- **`stalker`** — Floe Stalkers (ice). A gaunt, elongated predator with a
  **row of ice spikes** down the back, long legs, thin `tail0`, an eerie
  glow. Palette: pale ice-blue, translucent spikes.
- **`shambler`** — Wickerwood Shamblers (autumn elite). A hulking four-legged
  beast made of tangled wood/wicker — bulky, `horns`, a `mane` of twigs,
  amber eye-glow. Palette: dry brown wood, moss accents.
- **`drake`** — River Drakes (jungle) and **Canopy Tyrants** (jungle elite,
  bigger). A small wingless dragon/reptile that walks on four legs: horned
  head, a **row of back spikes**, a long reptilian `tail0`, no ears, fanged
  `jaw`, amber eyes. Palette: jade/emerald green with sandy spikes.

### Birds & winged — rig: `body, head, wingL, wingR, tail0, eye` (+ `jaw`/beak)

- **`bird`** — Carrion Crows (autumn), Poison Birds (jungle), Stymphalian
  Birds (hub-lore). A menacing corvid/raptor: sharp beak, broad flapping
  wings (`wingL/wingR`), fanned tail, small glowing eyes. Palette: black
  (crow), toxic-green (poison bird).
- **`vulture`** — Bone Vultures (desert). A hunched carrion bird with a
  **bald neck/head**, ragged broad wings, a hooked beak, beady glowing eyes.
  Palette: dusty brown feathers, pale bald head.
- **`harpy`** — Rime Harpies (ice), Storm Harpies (hub-lore). A winged
  woman-bird: a humanlike head with wild hair on a feathered body, large
  wings (`wingL/wingR`), talon legs, a `tail0` fan. Palette: dusky feathers,
  pale-blue rime accents.

### Bipeds (humanoid) — rig: `body, head, armL/R, legL/R, eye` (+ `weapon`, `shield`, `horns`)

- **`raider`** — Sand Raiders (desert), Satyr Brigands & Laestrygonian
  Raiders (hub-lore). A wiry humanoid marauder with a **sword** (`weapon`)
  and **round shield** (`shield`), leather garb, glowing eyes. Palette:
  sun-worn tan/red cloth, bronze blade.
- **`faun`** — Thistle Fauns (autumn). A goat-legged satyr: **horns**, a
  **spear** (`weapon`), shaggy lower legs, mischievous face. Palette: forest
  browns/greens.
- **`monkey`** — Thorn Monkeys (jungle). A small, quick primate: long arms,
  big head, no weapon, glowing eyes, agile crouch. Palette: dark jungle brown.
- **`cyclops`** — Cyclops Herdsmen (hub-lore). A big, heavy one-eyed brute:
  **single large glowing eye** (`eye`, centered), a **club** (`weapon`),
  slab shoulders, bulky torso. Palette: ruddy giant skin, crude hide.
- **`drowned`** — Drowned Sailors / The Drowned Crew (hub-lore). A waterlogged
  undead sailor: **seaweed** draping the body, a rusted **sword** (`weapon`),
  pallid greenish skin, hollow glowing eyes. Palette: drowned grey-green,
  kelp accents.

### Spirits / cloaked (floaters — NO legs; they hover and sway)
Rig: `body` (a hovering cloaked cone/mass), `head` (hood), `armL/R` (cloak
arms), `eye` (glowing, inside the hood), `wisp0…` (orbiting emissive motes),
plus ragged `tatter` hem pieces. These float — build them **without feet**,
resting slightly above the ground.

- **`wraith`** — Ice Wraiths (ice), Mirage Dancers (desert), **Pale Wraiths /
  "The Pale Court"** (ice elite). A hooded phantom, tattered robe trailing to
  a wispy point, a dark void face with two glowing eyes, ghostly arm-drapes,
  orbiting wisps. Palette: cold grey-blue robe, cyan eye/wisp glow (ice);
  shimmering heat-pale (mirage).
- **`shade`** — Horned Shades (autumn elite), Bleached Priests / "The Bleached
  Choir" (desert elite). Like the wraith but **darker and horned/mitred** — a
  more sinister, priestly silhouette, violet glow. Palette: near-black robe,
  purple eye/wisp glow.
- **`siren`** — Sirens' Kin (hub-lore). A sea-spirit: cloaked/robed hovering
  figure with a luring, watery glow (teal), flowing form. Palette: teal robe,
  aqua glow.

### Serpents (long-bodied) — rig: `head, jaw, tail0…tailN (≥4, base→tip), eye`
A reared head at the front (`head`, `jaw`) with the body a chain of shrinking
segments trailing back; ≥4 segments makes it slither. Optional `fins`.

- **`serpent`** — Dust Serpents (desert), Bloom Serpents (jungle), Reef
  Serpents & Deep Serpents (hub-lore). A sea/sand snake: scaled coils, a
  fanged head, side **fins**, glowing eyes. Palette: teal (reef/deep),
  dusty tan (desert), green (jungle bloom — add small blossoms).

### Arthropods — rig: `body, eye, leg{i}L/leg{i}R` (per pair), `clawL/clawR`, `tail…` + `stinger` (scorpion)

- **`crab`** — Berg Crabs (ice). A wide armored crab: domed shell, several
  jointed legs per side, two big **claws** (`clawL/clawR`), stalk eyes.
  Palette: cold blue-grey shell, icy sheen.
- **`scorpion`** — Glass Scorpions (desert) and **Dune Scourges** (desert
  elite, bigger). A desert scorpion: flat body, walking legs, big pincer
  **claws**, and a **tail arc curling forward over the back to a stinger**
  (`tail0…tail3` + `stinger`). "Glass" = translucent/pale, faceted, glassy.
  Palette: pale desert-glass tan, amber eye-glow.

### Constructs / plants / vehicle

- **`golem`** — Glacier Golems (ice), Tomb Sentinels (desert elite), Emerald
  Sentinels / "The Emerald Watch" (jungle elite). A blocky stone/ice
  construct humanoid: cube torso, slab limbs (`armL/R`, `legL/R`), a glowing
  **core** in the chest (`core`), deep glowing eyes. Retextures per realm:
  glacier-ice (cyan), tomb-sandstone (amber), jade/moss-covered (green).
- **`briar`** — Briar Beasts (autumn), Vine Horrors (jungle). A tangled
  plant-monster: a knot of bark and thorns for a `body`, a toothy `maw`
  (`jaw`), glowing eyes, and a few reaching **vines** (`vine0…vine2`).
  Smaller sibling of the Matriarch. Palette: dark bark, green moss/leaves.
- **`skiff`** — Brigand Skiffs (hub-lore). A hostile little **boat** (not a
  creature): a ragged-sailed raider dinghy with a mast, a torn sail, oars,
  and a menacing lantern "eye" at the prow (emissive). Bobs on the water.
  Palette: dark weathered wood, dirty sail, amber lantern glow.

---

## 4. Quick reference table

| Model | Used by (enemies) | Realm(s) | Role | HP·Power |
|---|---|---|---|---|
| stag_king | The Stag King | autumn | BOSS | 12·2 |
| wyrm | The Boreal Wyrm | ice | BOSS | 12·2 |
| sphinx | The Sphinx | desert | BOSS | 12·2 |
| kraken | The Kraken | hub sea | special (riddle gauntlet) | — |
| colossus | (former desert boss — asset, unused) | — | — | — |
| matriarch | The Strangler Matriarch (+ Strangler Saplings) | jungle | BOSS (+elite) | 12·2 |
| tyrant | The Dark Lord | the Pharos | FINAL BOSS | 14·3 |
| warden | (former final boss — asset, unused) | — | — | — |
| captain | the player, on foot | desert | hero | — |
| wolf | Leafshade/Frost Wolves, Frostfang Alphas | autumn/ice | grunt/elite | 2·1 / 5·2 |
| fox | Snow Foxes | ice | grunt | 1·1 |
| jackal | Salt Jackals | desert | grunt | 1·1 |
| boar | Dire Boars, Great Boar (Old Sounder) | autumn | mid/elite | 3·2 / 5·2 |
| stag | Stag Spirits | autumn | mid | 2·2 |
| jaguar | Jaguar Shades | jungle | mid | 2·2 |
| stalker | Floe Stalkers | ice | mid | 3·2 |
| shambler | Wickerwood Shamblers | autumn | elite | 4·2 |
| drake | River Drakes, Canopy Tyrants | jungle | grunt/elite | 2·1 / 4·2 |
| bird | Carrion Crows, Poison Birds, Stymphalian Birds | autumn/jungle | grunt | 1·1 |
| vulture | Bone Vultures | desert | grunt | 1·1 |
| harpy | Rime Harpies, Storm Harpies | ice | grunt | 1·1 / 2·2 |
| raider | Sand Raiders, Satyr Brigands, Laestrygonians | desert | grunt | 2·1 |
| faun | Thistle Fauns | autumn | grunt | 1·1 |
| monkey | Thorn Monkeys | jungle | grunt | 1·1 |
| cyclops | Cyclops Herdsmen | (lore) | heavy | 3·2 |
| drowned | Drowned Sailors | (lore) | heavy | 2·2 |
| wraith | Ice Wraiths, Mirage Dancers, Pale Court | ice/desert | mid/elite | 2·2 / 3·3 |
| shade | Horned Shades, Bleached Choir | autumn/desert | elite | 3·3 |
| siren | Sirens' Kin | (lore) | heavy | 2·2 |
| serpent | Dust/Bloom/Reef/Deep Serpents | desert/jungle | mid | 3·2 |
| crab | Berg Crabs | ice | mid | 3·2 |
| scorpion | Glass Scorpions, Dune Scourges | desert | mid/elite | 3·2 / 5·2 |
| golem | Glacier Golems, Tomb Sentinels, Emerald Watch | ice/desert/jungle | elite | 4·2 |
| briar | Briar Beasts, Vine Horrors | autumn/jungle | mid | 3·2 |
| skiff | Brigand Skiffs | (lore) | grunt-boat | 2·1 |

*(HP·Power are the base per-unit values; packs field 1–3 of them, and deeper
in a realm the same model appears in tougher variants.)*

The current programmatically-generated placeholders live in
`static/assets/monsters/<model>.glb`, built by `tools/make_monsters.py` —
useful as scale/proportion reference for the hand-modeled replacements.

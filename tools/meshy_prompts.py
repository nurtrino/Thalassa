"""
Thalassa × Meshy — prompt manifest.

One entry per model. Prompts are authored from docs/ENEMY-ROSTER.md so every
creature keeps the game's shared look: flat-shaded low-poly, faceted, matte
"board-game piece" clay, solid colours, a couple of emissive bits. The forge
(meshy_forge.py) appends STYLE + NEGATIVE to every prompt, so the per-model
text below only needs to describe the *creature*, not the render style.

Ordering: `rank` sorts most-complicated-first, so the forge renders the
showpiece bosses before the grunts (that is the point of the exercise).

Variants: realm re-tints (frost wolf, tomb golem, poison bird ...) are NOT
re-generated — they are cheap `retexture` passes over an already-built base
mesh. That is the "search the Meshy database for common textures" idea done
credit-efficiently: build the shape once, re-skin it per realm.

NOTE ON RIGGING (read this): Meshy returns a single un-rigged watertight mesh.
It will NOT contain the named child parts (body/head/jaw/legFL/...) the game's
procedural animator drives. These meshes are showpiece / retopo-reference
quality; turning one into an in-game animated creature still needs a rig pass
(split + name parts to the contract in docs/ENEMY-ROSTER.md). The forge writes
to a staging dir by default so it never clobbers the working procedural GLBs.
"""
from __future__ import annotations

# ── shared style ─────────────────────────────────────────────────────────────
# Appended to every prompt. This is what keeps 34 separate generations looking
# like one game.
STYLE = (
    "low-poly, flat-shaded, faceted with hard edges and no smooth normals, "
    "matte clay finish (roughness ~0.9), solid flat hand-painted colours, "
    "stylized tabletop board-game miniature, chunky silhouette that reads at a "
    "distance, full body, standing in a neutral relaxed pose facing forward, "
    "centered, symmetrical, supported ONLY by its own feet/body with absolutely "
    "nothing underneath it — no base, no plinth, no disc, no ground — plain "
    "empty background, single character, game-ready clean topology"
)

# The single most-repeated art note: NOTHING may sit under a model. Reused by
# every manifest (structures/props/flora/env import it) so the ban is uniform.
NO_BASE = (
    ", base, plinth, pedestal, platform, stand, podium, dais, stylobate, socle, "
    "slab, disc under the feet, round base, display base, figurine base, trophy "
    "base, statue base, mount, ground plane, floor, tile, paved ground, terrain, "
    "diorama base, nothing underneath, standing on a base"
)

NEGATIVE = (
    "photorealistic, realistic skin pores, smooth subsurface scattering, "
    "high-frequency surface noise, grungy PBR dirt, busy cluttered background, "
    "text, logo, watermark, signature, multiple characters, extra limbs, "
    "deformed anatomy, motion blur, depth of field" + NO_BASE
)

# tier → default target polycount (low-poly budget). Bosses read big, so they
# get more geometry; grunts stay cheap.
TIER_POLY = {
    "boss": 14000,
    "hero": 9000,
    "elite": 8000,
    "heavy": 7000,
    "grunt": 5000,
    "prop": 4500,
}

# ── the manifest ─────────────────────────────────────────────────────────────
# rank : lower = more complicated = rendered first
# tier : boss | hero | elite | heavy | grunt | prop
# prompt: creature description (STYLE/NEGATIVE added by the forge)
# variants: list of {"id","prompt"} rendered as retexture passes over this base
MODELS = [
    # ── BOSSES / showpieces (1) ──────────────────────────────────────────────
    dict(id="tyrant", rank=1, tier="boss",
         prompt=(
             "The Dark Lord: a colossal near-black armored demonic biped, the "
             "largest and most menacing creature in the game. Heavy iron plate "
             "armor, spiked pauldrons, a ridge of back-spines, curved horns on "
             "the head, clawed hands. A dark-iron crown with glowing ember-"
             "orange tips. Red glowing eyes. Towering, threatening, broad "
             "shouldered. Palette: near-black iron, ember-orange crown glow, "
             "red eye glow.")),
    dict(id="wyrm", rank=2, tier="boss",
         prompt=(
             "The Boreal Wyrm: a great ice sea-dragon serpent rearing up. Thick "
             "coiling segmented body of glacier-blue icy scales, a horned "
             "draconic head reared high with a fanged open maw, swept fins, and "
             "a ridge of jagged frost-white ice spikes down the spine. A small "
             "gold crown behind the horns. Glowing pale-cyan eyes. Palette: "
             "deep glacier-blue scales, frost-white belly and spikes, cyan "
             "glow.")),
    dict(id="matriarch", rank=3, tier="boss",
         prompt=(
             "The Strangler Matriarch: a monstrous carnivorous plant-queen. A "
             "bulbous body of dark wet bark and deep-green moss with a gaping "
             "maw of thorn-teeth and a blood-red throat, a crown of writhing "
             "green vines reaching from the shoulders, topped by a lurid "
             "magenta-pink flower bloom with a glowing core. A small gold crown "
             "at the apex. Sickly green glowing eyes. Palette: dark bark, "
             "jungle-green moss, magenta bloom, green glow.")),
    dict(id="sphinx", rank=4, tier="boss",
         negative=(NEGATIVE + ", two heads, second head, extra head, lion head, "
                   "multiple heads, animal head, building, temple, architecture, "
                   "realistic, photorealistic, highly detailed, smooth realistic "
                   "anatomy, hyperrealistic, bright polished gold, cute, serene"),
         prompt=(
             "A stylized low-poly Sphinx boss creature standing alert on all "
             "four lion paws on the ground (NOT lying down, NOT resting on a "
             "stone slab or plinth, no base beneath it, just the creature). The "
             "body of a lion with ONE SINGLE head (exactly one head, no lion "
             "head, no second head) wearing a striped pharaoh nemes headdress, "
             "and folded feathered wings on its back. Stern, imposing and "
             "predatory, a menacing face with glowing amber eyes, poised to "
             "strike. Chunky simplified faceted low-poly forms, flat matte "
             "hand-painted colours, a hand-painted board-game miniature, clearly "
             "stylized not realistic. A small tarnished dark-gold crown. "
             "Palette: weathered tan-and-grey sandstone body, blue-and-gold "
             "striped headdress, amber eye-glow.")),
    dict(id="stag_king", rank=5, tier="boss",
         negative=(NEGATIVE + ", human figure, person, rider, humanoid, human "
                   "face on the body, second creature, man sitting on the stag"),
         prompt=(
             "The Stag King: a towering regal elk-lord of the autumn forest on "
             "long legs, a majestic DEER/ELK animal only (no human figure, no "
             "rider, no person on its back). Enormous branching bone-white "
             "antlers with many tines (the signature feature, huge), a deep amber "
             "and chestnut coat with autumn-gold accents, and a small gold crown "
             "resting between the antlers on the head. Pale glowing eyes. "
             "Palette: deep amber-chestnut fur, bone-white antlers, autumn-gold "
             "accents.")),
    dict(id="kraken", rank=6, tier="boss",
         negative=(NEGATIVE + ", floating ring, detached loop, separate tentacle, "
                   "disconnected part, floating object, halo"),
         prompt=(
             "The Kraken: a mountainous sea-monster rising from the water on "
             "eight thick muscular tentacles that curl and sway. All eight "
             "tentacles are firmly attached to the body — no detached or floating "
             "loops or rings. A huge teal mantle head with heavy-lidded amber "
             "lamp-eyes and a hooked bone beak. Barnacle and suction-cup detail. "
             "Palette: teal and deep sea-green mantle, amber glowing eyes, bone "
             "beak.")),
    dict(id="warden", rank=7, tier="boss",
         prompt=(
             "The Warden of the Pharos: a colossal pale-marble sentinel guardian "
             "in the shape of an ancient Greek hoplite statue. A plumed bronze "
             "helmet, a long bronze spear, a large round bronze-rimmed shield, "
             "and a glowing cyan core set in the chest. A gold crown. Palette: "
             "pale marble body, bronze helmet and weapons, cyan core glow.")),
    dict(id="colossus", rank=8, tier="boss",
         negative=(NEGATIVE + ", robot, mech, mecha, android, machine, metal "
                   "plating, mechanical joints, panels, wires, technology, "
                   "sci-fi, futuristic"),
         prompt=(
             "The Dune Colossus: a colossal ancient desert giant carved from "
             "massive cracked sandstone blocks, like a crumbling weathered stone "
             "statue come to life. A towering rough-hewn humanoid of eroded "
             "sandstone with a blocky featureless carved face, heavy craggy "
             "stone arms and legs, chips and cracks and blowing sand, and deep "
             "glowing amber light in its eyes and in the cracks between the "
             "stones. Pure weathered rock, an ancient stone monument — not a "
             "robot or machine, no metal. Palette: sun-bleached sandstone tan, "
             "amber glow.")),

    # ── ELITES (2) ───────────────────────────────────────────────────────────
    dict(id="golem", rank=10, tier="elite",
         negative=(NEGATIVE + ", robot, mech, mecha, android, cyborg, machine, "
                   "metal armor plating, mechanical joints, panels, screws, "
                   "bolts, wires, technology, sci-fi, futuristic, glossy metal"),
         prompt=(
             "A Glacier Golem: a hulking humanoid monster built from rough "
             "natural stone boulders and jagged raw ice, like a walking heap of "
             "cracked grey rock and frozen slabs. Crude, primitive and ancient: "
             "lumpy uneven rocky arms and legs, a rough boulder head, moss and "
             "frost in the cracks, and a glowing cyan crystal core embedded deep "
             "in its rocky chest with matching glowing cyan eyes. Made purely of "
             "carved rough rock and ice — a stone elemental, absolutely not a "
             "robot or machine. Palette: weathered pale-grey stone, glacier "
             "ice-blue, cyan crystal glow."),
         variants=[
             dict(id="golem_tomb",
                  prompt="ancient tomb golem carved from weathered amber "
                         "sandstone boulders etched with worn hieroglyphs, "
                         "cracked desert rock, warm amber crystal core and eyes"),
             dict(id="golem_jade",
                  prompt="jungle sentinel golem of mossy jade-green rock "
                         "boulders overgrown with moss, leaves and creeping "
                         "vines, green crystal core and eyes"),
         ]),
    dict(id="shambler", rank=11, tier="elite",
         negative=(NEGATIVE + ", floating debris, disconnected branches, holes, "
                   "gaps, hollow arch, broken mesh, stray twigs floating"),
         prompt=(
             "A Wickerwood Shambler: a hulking FOUR-LEGGED beast standing solidly "
             "on four sturdy wooden legs, its body a bulky mass of tangled dry-"
             "brown wood and wicker branches with a clear head at the front. A "
             "bristling mane of twigs, curved horns, moss accents, amber glowing "
             "eyes. A solid readable animal silhouette — no floating loose twigs, "
             "no holes, not a hollow arch. Palette: dry brown wood, green moss, "
             "amber glow.")),
    dict(id="scorpion", rank=12, tier="elite",
         negative=(NEGATIVE + ", missing tail, no tail, no stinger, tailless"),
         prompt=(
             "A Glass Scorpion: a desert scorpion with a flat faceted body, eight "
             "walking legs, two large pincer claws at the front, and — most "
             "importantly — a long segmented TAIL that arcs up and forward over "
             "its back ending in a sharp curved STINGER (the raised curled tail "
             "and stinger MUST be present and prominent). Translucent pale desert-"
             "glass material, glassy and faceted. Amber glowing eyes. Palette: "
             "pale glassy tan, amber glow.")),
    dict(id="shade", rank=13, tier="elite",
         prompt=(
             "A Horned Shade: a sinister hooded phantom priest with no legs, "
             "hovering above the ground. A tattered near-black robe trailing to "
             "a wispy point, curved horns and a mitre-like peaked hood over a "
             "dark void face with two glowing violet eyes, ghostly draping arm-"
             "sleeves. Palette: near-black robe, purple-violet glow.")),
    dict(id="drake", rank=14, tier="elite",
         prompt=(
             "A River Drake: a small wingless four-legged dragon-reptile. A "
             "horned fanged head, a row of sandy back spikes, a long reptilian "
             "tail, jade-emerald scales. Amber eyes. Low prowling stance. "
             "Palette: jade-emerald green scales, sandy-tan spikes, amber "
             "eyes.")),
    dict(id="briar", rank=15, tier="elite",
         prompt=(
             "A Briar Beast: a tangled plant-monster, a knot of dark bark and "
             "thorns forming the body, a toothy maw, a few reaching thorny "
             "vines, green moss and small leaves, glowing green eyes. Palette: "
             "dark bark, green moss and leaves, green glow.")),
    dict(id="harpy", rank=16, tier="elite",
         prompt=(
             "A Rime Harpy: a winged woman-bird. A pale humanlike head with wild "
             "windswept hair on a feathered dusky body, large feathered wings, "
             "clawed talon legs, and a fanned tail. Pale-blue rime frost "
             "accents. Palette: dusky grey-brown feathers, pale-blue rime "
             "accents.")),
    dict(id="stalker", rank=17, tier="elite",
         negative=(NEGATIVE + ", melted, spindly mess, blob, unrecognizable, "
                   "too many legs, tangled thin legs, formless"),
         prompt=(
             "A Floe Stalker: a gaunt four-legged ice predator beast with a "
             "clear solid readable body, a wolfish head, and four distinct sturdy "
             "legs it stands on. A row of translucent ice spikes down its back "
             "and a thin tail, an eerie pale glow. A recognizable animal, NOT "
             "spindly, melted, or formless. Palette: pale ice-blue body, "
             "translucent back spikes.")),

    # ── HEAVIES / mid (3) ────────────────────────────────────────────────────
    dict(id="cyclops", rank=20, tier="heavy",
         negative=(NEGATIVE + ", two eyes, second eye, pair of eyes, normal face"),
         prompt=(
             "A Cyclops Herdsman: a big heavy one-eyed brute giant. EXACTLY ONE "
             "single large eye centered in the middle of its forehead (one-eyed, "
             "cyclops, NO second eye, no pair of eyes, just one big central eye). "
             "Slab shoulders, a bulky torso, crude hide garb, and one hand "
             "gripping a big heavy wooden club raised over the shoulder. Ruddy "
             "giant skin. Palette: ruddy skin, brown hide, pale glowing single "
             "eye.")),
    dict(id="drowned", rank=21, tier="heavy",
         prompt=(
             "A Drowned Sailor: a waterlogged undead sailor with pallid greenish "
             "skin, strands of seaweed and kelp draping the body, tattered "
             "sailor's clothes, hollow glowing eyes, and a rusted sword. "
             "Palette: drowned grey-green skin, kelp green accents, rust.")),
    dict(id="siren", rank=22, tier="heavy",
         prompt=(
             "A Siren's Kin: a hovering sea-spirit with no legs, a flowing teal "
             "robe trailing to a wispy point, a luring watery aqua glow, long "
             "flowing hair, ghostly arms. Palette: teal robe, aqua glow.")),
    dict(id="serpent", rank=23, tier="mid",
         prompt=(
             "A Reef Serpent: a long sea-snake reared up with its fanged head "
             "held level and tilted FORWARD, looking straight ahead at the viewer "
             "(the head faces forward, NOT tilted up at the sky), mouth snarling. "
             "Side fins and a body of shrinking teal scaled coils trailing behind. "
             "Glowing eyes. Palette: teal scales, glowing eyes."),
         variants=[
             dict(id="serpent_dust",
                  prompt="desert dust-serpent, dusty tan and sand-brown scales, "
                         "sun-bleached, amber eyes"),
             dict(id="serpent_bloom",
                  prompt="jungle bloom-serpent, green scales with small pink "
                         "and white blossoms growing along the coils"),
         ]),
    dict(id="crab", rank=24, tier="mid",
         prompt=(
             "A Berg Crab: a wide armored crab with a domed shell, several "
             "jointed legs per side, two big pincer claws, and eyes on stalks. "
             "Cold blue-grey shell with an icy sheen. Palette: blue-grey shell, "
             "icy highlights.")),
    dict(id="boar", rank=25, tier="mid",
         prompt=(
             "A Dire Boar: a bulky low-slung wild boar with humped shoulders, "
             "short legs, curved ivory tusks, a blunt snout, a bristly mane, and "
             "a small curly tail. Palette: dark brown-black bristle, ivory "
             "tusks.")),
    dict(id="jaguar", rank=26, tier="mid",
         negative=(NEGATIVE + ", puddle, splat, black pool, shadow, shadow plane, "
                   "liquid, melted mass, blob, spilled ink, smoke, mist, wisp, "
                   "ghostly trail, aura on the ground"),
         prompt=(
             "A sleek muscular SOLID black panther big cat, an ordinary opaque "
             "solid-bodied jaguar standing firmly and clearly on all four paws in "
             "a low prowling stance, with a long tail and glowing green eyes. A "
             "completely solid clean cat with nothing beneath its paws — no "
             "shadow, no puddle, no pool, no splat, no melted mass, no smoke. "
             "Palette: solid matte charcoal-black fur, green glowing eyes.")),
    dict(id="wolf", rank=27, tier="mid",
         prompt=(
             "A grey wolf: a lean predatory wolf with pointed ears, a snout, a "
             "shaggy neck ruff, a brush tail, and glowing eyes. Palette: grey "
             "fur, pale glowing eyes."),
         variants=[
             dict(id="wolf_frost",
                  prompt="frost wolf, snow-white and pale ice-blue fur, frosted "
                         "ruff, cold cyan glowing eyes"),
         ]),
    dict(id="stag", rank=28, tier="mid",
         negative=(NEGATIVE + ", melted legs, merged legs, fused legs, webbed "
                   "legs, malformed legs, legs blending together"),
         prompt=(
             "A Stag Spirit: a graceful slender deer standing on FOUR clean "
             "separate slim legs, each a distinct straight leg ending in a small "
             "hoof (legs not merged, melted, or webbed together). Modest bone "
             "antlers, a thin tail, gentle pale-blue spectral glowing eyes. "
             "Ghostly. Palette: soft brown, pale-blue spectral glow.")),

    # ── GRUNTS (4) ───────────────────────────────────────────────────────────
    dict(id="raider", rank=30, tier="grunt",
         prompt=(
             "A Sand Raider: a wiry humanoid desert marauder in sun-worn tan and "
             "red leather garb, holding a short bronze sword and a small round "
             "shield. Glowing eyes. Palette: tan and red cloth, bronze blade.")),
    dict(id="faun", rank=31, tier="grunt",
         prompt=(
             "A Thistle Faun: a goat-legged satyr with small curved horns, "
             "shaggy lower goat legs, a mischievous face, and a wooden spear. "
             "Palette: forest browns and greens.")),
    dict(id="drowned_bird_placeholder", rank=99, tier="grunt", skip=True,
         prompt="(placeholder — ignored)"),
    dict(id="bird", rank=32, tier="grunt",
         prompt=(
             "A Carrion Crow: a menacing black corvid raptor with a sharp beak, "
             "broad feathered wings spread mid-flap, a fanned tail, and small "
             "glowing eyes. Palette: glossy black feathers, faint glowing "
             "eyes."),
         variants=[
             dict(id="bird_poison",
                  prompt="toxic poison-bird, sickly toxic-green and black "
                         "plumage, dripping venom sheen, green glowing eyes"),
         ]),
    dict(id="vulture", rank=33, tier="grunt",
         prompt=(
             "A Bone Vulture: a hunched carrion bird with a bald pale neck and "
             "head, ragged broad wings, a hooked beak, and beady glowing eyes. "
             "Palette: dusty brown feathers, pale bald head.")),
    dict(id="monkey", rank=34, tier="grunt",
         prompt=(
             "A Thorn Monkey: a small quick primate with long arms, a big head, "
             "an agile crouch, and glowing eyes. Dark jungle-brown fur. Palette: "
             "dark brown, glowing eyes.")),
    dict(id="jackal", rank=35, tier="grunt",
         prompt=(
             "A Salt Jackal: a lean scavenger desert canine with long legs, a "
             "narrow snout, tall ears, and a thin tail. Bleached tan bone "
             "colour. Palette: bleached tan, pale eyes.")),
    dict(id="fox", rank=36, tier="grunt",
         prompt=(
             "A Snow Fox: a small dainty fox with big ears, slender legs, a long "
             "bushy tail, and a pointed snout. White and silver winter coat. "
             "Palette: white-silver fur.")),
    dict(id="wraith", rank=37, tier="grunt",
         prompt=(
             "An Ice Wraith: a hooded phantom with no legs hovering above the "
             "ground, a tattered cold grey-blue robe trailing to a wispy point, "
             "a dark void face with two glowing cyan eyes, and ghostly draping "
             "arms. Palette: grey-blue robe, cyan glow.")),

    # ── HERO + PROP ──────────────────────────────────────────────────────────
    dict(id="captain", rank=9, tier="hero",
         prompt=(
             "A Greek hoplite captain hero: a bronze plumed helmet, a large "
             "round bronze-rimmed shield, a long spear, and a short neutral "
             "mid-grey tunic (kept a plain neutral tone so it can be team-"
             "tinted), tanned skin, a confident heroic stance. Palette: bronze "
             "helm and shield, neutral grey tunic, tanned skin.")),
    dict(id="skiff", rank=40, tier="prop",
         prompt=(
             "A hostile little raider skiff boat with a SINGLE straight upright "
             "mast standing vertically from the centre of the deck carrying one "
             "torn dirty square sail, a row of oars along the sides, and a "
             "menacing glowing amber lantern at the pointed prow. The mast is "
             "centred and vertical, firmly stepped into the deck, not tilted, "
             "not floating, not misplaced. Palette: dark weathered wood, dirty "
             "sail, amber lantern glow.")),
]

# Drop the intentional placeholder / any skipped rows.
MODELS = [m for m in MODELS if not m.get("skip")]


def ordered(models=None):
    """Manifest sorted most-complicated-first."""
    return sorted(models or MODELS, key=lambda m: m["rank"])


def by_id():
    return {m["id"]: m for m in MODELS}

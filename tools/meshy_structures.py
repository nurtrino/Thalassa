"""
Thalassa × Meshy — MAP STRUCTURES manifest.

The landmarks that dress the board: the great Pharos lighthouse, the domain
temples, the player's galley, desert spires, the obelisk, docks, the
shipwright market, and raider camps. Authored from static/islands.js
(makePharos / makeShrine / makeShip / makeSandSpire / makeObelisk /
makeLighthouse / makeDock / makeMarket / makeTents / makeGatePortal) and the
COL palette, so the AI builds match what the game draws by hand.

Same forge, separate state file — run with:
    python meshy_forge.py --manifest meshy_structures \
        --state .meshy_structures_state.json \
        --out ../static/assets/structures --yes

Style note: these are isolated set-dressing PROPS/BUILDINGS, not characters, so
STRUCT_STYLE drops the "character/forward-facing" language and asks for a single
centered diorama piece instead. Colours quote the game's hexes.
"""
from __future__ import annotations

# Reuse the exact negative prompt from the creature manifest for consistency.
from meshy_prompts import NEGATIVE as _CRE_NEG  # already carries the NO_BASE ban

# structures share the creature negative (which bans bases). Kept separate name
# so props/flora/env can import it.
NEGATIVE = _CRE_NEG

STYLE = (
    "low-poly, flat-shaded, faceted with hard edges and no smooth normals, "
    "matte clay finish, solid flat hand-painted colours, stylized tabletop "
    "board-game piece, chunky readable forms. IMPORTANT: the object is "
    "completely isolated and floating in empty space with absolutely NOTHING "
    "underneath it — no base, no platform, no plinth, no stepped floor, no "
    "ground of any kind; the walls/columns/legs simply end where the object "
    "ends. Plain empty background, clean game-ready topology, three-quarter view"
)

# Structures don't share the creature tiers; give each a sensible budget.
TIER_POLY = {
    "landmark": 24000,   # the Pharos — the showpiece
    "building": 9000,
    "vehicle": 9000,
    "prop": 6000,
}

MODELS = [
    # ── THE showpiece — the great lighthouse ─────────────────────────────────
    dict(id="pharos", rank=1, tier="landmark",
         prompt=(
             "The Pharos, a colossal ancient Greek lighthouse like the "
             "Lighthouse of Alexandria, carved entirely from PRISTINE PURE "
             "WHITE polished marble. Four clearly-stacked tapering tiers: a wide "
             "square base tier, a tall octagonal middle tier, a slender round "
             "upper tier, capped by a small round lantern room, each tier "
             "stepping in like a ziggurat with crisp clean edges. A ring of "
             "slender white marble columns around the base gallery. A single "
             "warm golden flame beacon glowing softly in the lantern at the very "
             "top. At its foot a white marble gateway with twin bronze doors and "
             "three small glowing golden sigil discs. Monumental, elegant, "
             "immaculate. Almost entirely bright clean white marble with only a "
             "faint warm beacon glow as accent — NOT cream, NOT beige, NOT "
             "terracotta.")),

    # ── temples / shrines ────────────────────────────────────────────────────
    dict(id="temple", rank=2, tier="building",
         prompt=(
             "A small circular Greek tholos temple / oracle shrine: a round "
             "stepped pale-marble base, a ring of four slender fluted marble "
             "columns, and a conical roof, with a small glowing golden fire "
             "brazier burning at the centre. Serene and sacred. Palette: pale "
             "marble #f7f4ec and #e4ddc9, warm gold brazier glow, a deep-blue "
             "roof."),
         variants=[
             dict(id="temple_autumn",
                  prompt="tholos temple with a warm amber-orange terracotta "
                         "conical roof, autumn oracle"),
             dict(id="temple_ice",
                  prompt="tholos temple with a pale icy-cyan blue conical roof, "
                         "frost oracle, faint frost on the marble"),
             dict(id="temple_desert",
                  prompt="tholos temple with a sandy tan-gold conical roof, "
                         "sun-bleached desert marble"),
             dict(id="temple_jungle",
                  prompt="tholos temple with a deep jade-green conical roof, "
                         "moss and small vines creeping up the marble columns"),
         ]),

    # ── the player's boat ────────────────────────────────────────────────────
    dict(id="ship", rank=3, tier="vehicle",
         prompt=(
             "A small ancient Aegean galley sailing ship: a curved wooden hull "
             "with a swept-up bow post and stern post, a planked deck, a single "
             "central mast carrying a square cloth sail on a horizontal yard, "
             "simple rigging ropes, a steering oar at the stern, a painted rail "
             "along the top, and a classic painted eye near the bow. Palette: "
             "warm brown wood #9a6b3f and #74502f, a terracotta-and-cream sail, "
             "a painted blue trim rail.")),

    # ── desert spires ────────────────────────────────────────────────────────
    dict(id="sand_spire", rank=4, tier="prop",
         prompt=(
             "A wind-carved sandstone hoodoo spire: three or four stacked "
             "eroded rounded sandstone discs of decreasing size tapering up to a "
             "rounded knobbly cap, weathered and layered by desert wind. "
             "Palette: warm desert sandstone in three tones #c98a4a, #d9a266, "
             "#b87a40.")),
    dict(id="obelisk", rank=5, tier="prop",
         prompt=(
             "An ancient tapering four-sided stone obelisk on a square marble "
             "base, topped with a glowing golden pyramidion tip, faintly "
             "radiating a soft magical blue light, carved with worn glyphs. "
             "Palette: pale blue-grey stone #8d94b8, marble base, glowing gold "
             "tip, soft blue glow.")),

    # ── harbour lighthouse (small, distinct from the Pharos) ─────────────────
    dict(id="lighthouse", rank=6, tier="building",
         prompt=(
             "A small harbour lighthouse: a short tapering round marble tower "
             "with a deep-blue painted band near the top, a glowing warm-amber "
             "lamp room in a little cage, capped by a terracotta-orange conical "
             "roof. Cozy and welcoming, marks a safe home port. Palette: pale "
             "marble tower, aegean-blue band #2d5bb9, amber lamp glow, "
             "terracotta cap.")),

    # ── docks & buildings ────────────────────────────────────────────────────
    dict(id="dock", rank=7, tier="prop",
         prompt=(
             "A simple wooden jetty dock: a straight planked wooden walkway "
             "raised on round wooden pilings/posts over water, weathered timber. "
             "Palette: warm brown planks #9a6b3f, darker posts #74502f.")),
    dict(id="market", rank=8, tier="building",
         model_type="standard", polycount=60000,
         style=("a detailed refined hand-painted stylized building with smooth "
                "crisp sculpted stonework, matte colours, a solid three-"
                "dimensional building set-piece sitting naturally on its own small "
                "base, plain empty background, three-quarter view, game-ready — "
                "higher-poly and detailed, NOT low-poly or faceted"),
         negative=(NEGATIVE + ", text, letters, words, writing, signage, "
                   "cluttered, clutter, junk pile, messy, crowded stall, awning, "
                   "cloth tent, wooden booth, low-poly, faceted"),
         prompt=(
             "An elegant clean Roman marketplace shop (a taberna): an open-"
             "fronted white marble shopfront with a neat row of slender fluted "
             "white MARBLE COLUMNS along the front holding up a terracotta-tiled "
             "roof, a simple stone display counter, and just a few tidy terracotta "
             "amphora jars — uncluttered, elegant and orderly, classical Roman "
             "architecture. Palette: white marble columns, warm cream stone, "
             "terracotta-red tiled roof, a couple of terracotta amphorae."),
         variants=[]),
    dict(id="tents", rank=9, tier="prop",
         prompt=(
             "A small raider desert camp: a cluster of three conical cloth tents "
             "in muted red, plum-purple and blue, arranged around a central "
             "stone fire pit with glowing embers. Palette: muted red, plum, and "
             "blue tents, grey stone pit, warm ember glow.")),

    # ── realm gateway ────────────────────────────────────────────────────────
    dict(id="gate_portal", rank=10, tier="prop",
         prompt=(
             "A mystical stone gateway arch standing in the sea, marking a "
             "passage between realms: two weathered rough-hewn standing stone "
             "pillars supporting a lintel, with a faintly glowing magical portal "
             "shimmer suspended in the opening. Ancient and arcane. Palette: "
             "grey weathered stone #8a8f98, a soft glowing arcane portal.")),
]


def ordered(models=None):
    return sorted(models or MODELS, key=lambda m: m["rank"])


def by_id():
    return {m["id"]: m for m in MODELS}

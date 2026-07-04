"""
Thalassa × Meshy — ENVIRONMENT PROPS.

Extra world-dressing beyond the core filler props: water features, camp gear,
tomb pieces, ruins. No-base stylized look (reuses structures STYLE/NEGATIVE).
"""
from __future__ import annotations

from meshy_structures import STYLE, NEGATIVE  # noqa: F401  (no-base style)

TIER_POLY = {"prop": 5000}


def P(pid, prompt, rank=50, **extra):
    return dict(id=pid, rank=rank, tier="prop", prompt=prompt, **extra)


MODELS = [
    P("iceberg",
      "A floating iceberg, a chunky faceted block of pale blue-white ice with a "
      "jagged peak above the waterline. Palette: glacier blue-white ice."),
    P("sand_dune",
      "A smooth wind-heaped sand dune mound with a soft curved crest and faint "
      "wind ripples. Palette: warm golden desert sand."),
    P("barrel",
      "A wooden storage barrel with iron hoop bands, weathered staves. Palette: "
      "brown wood, dark iron bands."),
    P("fishing_net",
      "A bundled fishing net with cork floats and a few wooden buoys, heaped in "
      "a pile. Palette: tan rope net, orange-red floats."),
    P("brazier",
      "A tall bronze fire brazier bowl on a tripod stand with glowing orange "
      "flames and embers. Palette: bronze metal, glowing orange fire."),
    P("stone_well",
      "An old round stone well with a low circular wall, a little wooden roof on "
      "posts, and a bucket on a rope. Palette: grey mossy stone, brown wood."),
    P("sarcophagus",
      "An ancient Egyptian anthropoid mummy sarcophagus: a closed coffin shaped "
      "like a wrapped human body, with a large stylized golden pharaoh face and "
      "headdress carved on the lid and crossed arms over the chest. It is a solid "
      "one-piece mummy-case coffin standing slightly tilted — NOT a treasure "
      "chest, NOT a rectangular box, no hinged opening lid. Palette: gold face "
      "and blue-striped nemes headdress, sandstone body.",
      negative=(NEGATIVE + ", treasure chest, box, crate, hinged lid, open chest, "
                "rectangular trunk, coffer")),
    P("ruined_arch",
      "A broken ancient stone archway, two weathered pillars holding a cracked "
      "arch with chunks missing, vines creeping up. Palette: weathered grey "
      "stone, green vines."),
    P("banner_pole",
      "A tall wooden pole flying a tattered cloth banner or pennant, frayed at "
      "the edge, waving. Palette: dark wood pole, faded red-and-gold banner."),
    P("campfire",
      "A campfire: a ring of stones around stacked burning logs with bright "
      "orange flames and glowing embers. Palette: grey stones, brown logs, "
      "glowing orange fire."),
    P("lily_pads",
      "A cluster of flat round green lily pads floating with a couple of pink "
      "water-lily blossoms. Palette: green pads, pink blossoms."),
    P("tide_pool",
      "A low weathered rock shelf holding a small tide pool of water with bits "
      "of seaweed and a starfish. Palette: grey wet rock, teal water, green "
      "seaweed."),
    P("buoy",
      "A floating sea marker buoy, a striped conical float with a small caged "
      "warning lantern on top, bobbing. Palette: red-and-white stripes, amber "
      "lantern."),
    P("ice_floe",
      "A flat floating raft of pack ice, a low jagged slab of pale blue-white "
      "ice floating flat on the water surface. Palette: glacier blue-white "
      "ice."),
    P("tomb",
      "An ancient Egyptian tomb entrance: a clean solid sandstone doorway with a "
      "flat lintel and a dark rectangular opening, flanked by two seated jackal "
      "statues. Tidy and intact — no jumbled broken rubble or messy debris piled "
      "on top. Ominous boss lair. Palette: sandstone tan, dark opening, faded "
      "blue-and-gold trim.",
      negative=(NEGATIVE + ", rubble on top, jumbled blocks, messy debris, "
                "broken collapsed roof, floating stones")),
    P("barrow",
      "An ancient burial barrow, a grassy earthen mound with a dark stone "
      "doorway of three big lintel stones leading inside, ringed by a few leaning "
      "mossy standing stones. Ominous boss lair. Palette: green grassy mound, "
      "grey mossy stone, dark entrance."),
    P("monster_totem",
      "A menacing dark stone totem megalith, a tall jagged spiked black monolith "
      "carved with a snarling face and glowing red eyes, ominous and tribal. "
      "Palette: near-black stone, glowing red eyes."),
    P("waymarker_stone",
      "A weathered carved waymarker standing stone, a tall runestone slab "
      "leaning slightly, covered in moss with faint carved markings. Palette: "
      "grey mossy stone."),
]


def ordered(models=None):
    return sorted(models or MODELS, key=lambda m: m["rank"])


def by_id():
    return {m["id"]: m for m in MODELS}

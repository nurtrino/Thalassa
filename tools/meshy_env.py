"""
Thalassa × Meshy — ENVIRONMENT PROPS.

Extra world-dressing beyond the core filler props: water features, camp gear,
tomb pieces, ruins. No-base stylized look (reuses structures STYLE/NEGATIVE).
"""
from __future__ import annotations

from meshy_structures import STYLE, NEGATIVE  # noqa: F401  (no-base style)

TIER_POLY = {"prop": 5000}


def P(pid, prompt, rank=50):
    return dict(id=pid, rank=rank, tier="prop", prompt=prompt)


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
      "An ancient Egyptian stone sarcophagus, a carved rectangular coffin with a "
      "stylized pharaoh face and hieroglyphs, lid slightly ajar. Palette: "
      "sandstone tan with faded blue and gold paint."),
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
]


def ordered(models=None):
    return sorted(models or MODELS, key=lambda m: m["rank"])


def by_id():
    return {m["id"]: m for m in MODELS}

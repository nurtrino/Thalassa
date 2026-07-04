"""
Thalassa × Meshy — BIOME FLORA.

Stylized trees & plants, one set covering every realm. Same no-base look as the
structures/props (reuses their STYLE/NEGATIVE). Loaded + scattered by the same
props.js path as the filler props.
"""
from __future__ import annotations

from meshy_structures import STYLE, NEGATIVE  # noqa: F401  (no-base style)

TIER_POLY = {"prop": 5000}


def P(pid, prompt, rank=50, **extra):
    return dict(id=pid, rank=rank, tier="prop", prompt=prompt, **extra)


MODELS = [
    P("pine_tree",
      "A tall stylized conifer pine tree, a straight trunk with tiered layered "
      "green needle branches tapering to a point. Palette: dark green needles, "
      "brown trunk."),
    P("pine_snow",
      "A tall conifer pine tree laden with snow, layered green branches dusted "
      "white with snow. Palette: dark green and snow white, brown trunk."),
    P("palm_tree",
      "A tropical palm tree, a tall curved slender trunk topped with a crown of "
      "long arching green fronds and a few coconuts. Palette: green fronds, "
      "tan trunk."),
    P("cypress_tree",
      "A tall narrow dark-green Mediterranean cypress tree, a slim vertical "
      "column of dense foliage. Palette: deep green, slim brown base."),
    P("olive_tree",
      "A gnarled old olive tree, a twisted knotty trunk with a rounded canopy "
      "of silvery-green leaves. Palette: silvery sage-green leaves, grey-brown "
      "gnarled trunk."),
    P("autumn_tree",
      "A broadleaf autumn tree with a FULL smooth rounded domed canopy of fiery "
      "orange, red and gold leaves, the leaves forming one clean solid rounded "
      "leafy crown that completely covers the top with NO bare branches, twigs or "
      "stems poking out through or above the leaves — just a tidy smooth blanket "
      "of foliage — on a sturdy brown trunk. Palette: autumn orange, red and gold "
      "foliage, brown trunk.",
      negative=(NEGATIVE + ", tubes, pipes, stems sticking out, bare branches "
                "poking out, twigs sticking out above the leaves, straws, "
                "tentacles, spikes, antennae, flat top, cut-off top, bald top")),
    P("jungle_tree",
      "A tall emergent jungle canopy tree, a straight trunk with a broad flat "
      "crown of lush deep-green leaves and a few hanging vines. Palette: deep "
      "jungle green, brown trunk."),
    P("cactus",
      "A tall saguaro desert cactus with a thick ribbed green trunk and two "
      "upraised arms, a few tiny spines. Palette: desert green, faint yellow "
      "spines."),
    P("dead_scrub",
      "A dry dead desert shrub, a low tangle of bare bleached twiggy branches, "
      "leafless and windblown. Palette: pale bleached tan wood."),
    P("fern_cluster",
      "A cluster of big lush jungle ferns, arching feathery green fronds "
      "fanning out from a low base. Palette: vivid jungle green."),
    P("reeds",
      "A cluster of tall water reeds and cattails, slender green stalks with "
      "brown seed heads, growing from a shallow-water tuft. Palette: green "
      "stalks, brown cattail heads."),
]


def ordered(models=None):
    return sorted(models or MODELS, key=lambda m: m["rank"])


def by_id():
    return {m["id"]: m for m in MODELS}

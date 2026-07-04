"""
Thalassa × Meshy — REALM BACKDROPS (the mountain wall ring & horizon crescents).

Meshy versions of wall.js's procedural set pieces: the great mountain wall that
pens in the Isles of Peace, and the per-realm mountain/hill crescent seen on the
horizon inside each realm. Each is a wide low-poly RANGE meant to sit far out on
the skyline, scaled up and repeated around the ring. Colours match theme.wall.*.
"""
from __future__ import annotations

from meshy_prompts import NEGATIVE as _CRE_NEG

# backdrops legitimately meet the ground — only ban the display-disc, not a base
NEGATIVE = (_CRE_NEG + ", single mountain, one peak, isolated rock, character, "
            "creature, building")

STYLE = (
    "stylized low-poly, flat-shaded, faceted, matte hand-painted colours, a WIDE "
    "long horizontal panoramic CRESCENT RANGE of many mountains in a row (a "
    "backdrop skyline set-piece, much wider than it is tall), chunky readable "
    "peaks, plain empty background, three-quarter aerial view, game-ready"
)

TIER_POLY = {"backdrop": 14000}


def B(bid, prompt, **extra):
    return dict(id=bid, rank=1, tier="backdrop", prompt=prompt, **extra)


MODELS = [
    B("mountains_aegean",
      "A long crescent range of rugged Mediterranean mountains, grey-brown "
      "rock with pale stone peaks and sparse green scrub, the great wall ringing "
      "the Isles of Peace. Palette: grey-brown rock #6d7681, pale peaks."),
    B("mountains_ice",
      "A long crescent range of jagged frozen mountains, cold blue-grey rock "
      "with bright white snow caps and glaciers, sharp icy peaks. Palette: "
      "blue-grey rock #5c7590, pure white snow."),
    B("mountains_desert",
      "A long crescent range of flat-topped desert mesas and buttes, layered "
      "red-orange and tan sandstone cliffs eroded into steppes, sun-baked. "
      "Palette: orange-tan sandstone #a8703e, pale sand caps."),
    B("mountains_jungle",
      "A big SOLID rounded green mountain massif completely blanketed in dense "
      "green jungle rainforest treetops, a chunky solid filled hill of layered "
      "green canopy, smooth solid rounded hillside. Palette: deep jungle green "
      "#46584a, pale-green misty top.",
      negative=(NEGATIVE + ", hollow, holes, gaps, arches, openings, ring, wall, "
                "fortress, ruins, latticework, hollow shell, cage, building")),
    B("hills_autumn",
      "A long crescent range of rolling autumn hills blanketed in warm orange, "
      "amber and gold forest, soft wooded ridges. Palette: warm brown rock "
      "#74584a, amber-gold autumn canopy."),
]


def ordered(models=None):
    return list(models or MODELS)


def by_id():
    return {m["id"]: m for m in MODELS}

"""
Thalassa × Meshy — BIOME GROUND TILES (texture source).

Flat square top-down ground tiles, one per biome. We generate them, then
extract the base-colour map (meshy_ground_bake.py) and tile it onto the island
terrain material. So these are a TEXTURE SOURCE, not props — the geometry is
throwaway; only the painted top face matters.
"""
from __future__ import annotations

from meshy_prompts import NEGATIVE as _CRE_NEG

NEGATIVE = (_CRE_NEG + ", 3d objects, rocks sticking up, props, plants sticking "
            "up, side view, perspective, horizon, sky, vignette, shadows")

# a flat top-down tileable ground; only the painted surface matters
STYLE = (
    "a perfectly flat square ground tile seen from directly straight above "
    "(orthographic top-down bird's-eye view, no perspective), a seamless "
    "tileable repeating ground texture, stylized low-poly hand-painted matte "
    "board-game look, evenly lit, fills the whole square edge to edge, "
    "flat lay, no objects standing up"
)

TIER_POLY = {"ground": 2000}


def G(gid, prompt):
    return dict(id=gid, rank=1, tier="ground", prompt=prompt)


MODELS = [
    G("ground_grass", "lush green meadow grass ground with small flowers and "
                      "subtle dirt patches, Aegean hillside turf"),
    G("ground_sand", "rippled golden desert sand dunes ground with faint wind "
                     "ripples and a few tiny pebbles"),
    G("ground_rock", "cracked rocky mountain ground, grey stone flagstones and "
                     "gravel with moss in the cracks"),
    G("ground_snow", "fresh white snow ground with pale blue shadows, soft "
                     "drifts and a little exposed ice"),
    G("ground_jungle", "dense jungle floor ground, deep green moss and ferns "
                       "with scattered leaves, roots and small stones"),
    G("ground_autumn", "autumn forest floor ground blanketed in fallen orange, "
                       "red and gold leaves over brown soil"),
    G("ground_marble", "polished pale marble plaza floor with subtle grey "
                       "veining and faint tile seams, temple courtyard"),
    G("ground_gravel", "dry desert gravel and pebble ground, small scattered "
                       "tan and grey stones over packed dirt"),
    G("ground_cobble", "old grey cobblestone path, rounded fitted stones with "
                       "moss and dirt in the gaps"),
    G("ground_mud", "dark wet jungle mud and soil ground with puddles, roots "
                    "and scattered leaves"),
]


def ordered(models=None):
    return list(models or MODELS)


def by_id():
    return {m["id"]: m for m in MODELS}

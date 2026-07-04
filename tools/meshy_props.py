"""
Thalassa × Meshy — ISLAND FILLER PROPS.

Decoration scattered across the island tiles to make the map read rich: rocks,
ruins, wrecks, crystals, bones, flora. Same no-base stylized look as the
structures (reuses their STYLE/NEGATIVE so nothing sits on a slab). Wired into
the island builder's scatter system.
"""
from __future__ import annotations

from meshy_structures import STYLE, NEGATIVE  # noqa: F401  (no-base style)

TIER_POLY = {"prop": 5000}


def P(pid, prompt, rank=50):
    return dict(id=pid, rank=rank, tier="prop", prompt=prompt)


MODELS = [
    P("boulder",
      "A cluster of two or three rounded weathered grey granite boulders with "
      "patches of green moss, natural rock. Palette: grey stone, green moss."),
    P("ruined_column",
      "A toppled broken ancient Greek marble column lying on its side, cracked "
      "into a couple of drum segments, weathered and chipped. Palette: pale "
      "cream marble."),
    P("shipwreck",
      "The broken half-sunken wreck of an old wooden sailing ship: a shattered "
      "hull with snapped ribs and a broken mast, weathered grey driftwood "
      "planks, tattered rigging. Palette: weathered grey-brown wood."),
    P("crystal_cluster",
      "A cluster of jagged glowing crystals jutting up from a small rocky base, "
      "faceted translucent gems with a soft inner glow. Palette: glowing "
      "amethyst-purple and teal crystals."),
    P("broken_statue",
      "A weathered broken ancient Greek statue: a cracked marble torso of a "
      "robed figure missing its head and arms, eroded and mossy. Palette: pale "
      "weathered marble, faint moss."),
    P("cairn",
      "A stacked stone cairn: five or six flat rounded grey stones balanced in "
      "a tapering pile, a trail marker. Palette: grey weathered stone."),
    P("dead_tree",
      "A bare gnarled dead tree, a twisted leafless trunk with a few broken "
      "clawing branches, weathered pale wood. Palette: bleached grey-brown "
      "wood."),
    P("driftwood",
      "A large piece of bleached driftwood, a smooth twisted weathered log with "
      "worn branch stubs. Palette: pale silvery driftwood."),
    P("amphora_pile",
      "A small cluster of ancient terracotta amphora jars, three or four "
      "rounded two-handled clay pots leaning together, one cracked. Palette: "
      "warm terracotta orange-brown clay."),
    P("coral",
      "A vibrant coral formation, branching and brain corals clustered together "
      "for a shallow reef. Palette: warm pink, orange and teal coral."),
    P("mushroom_cluster",
      "A cluster of big stylized toadstool mushrooms of varied heights with "
      "rounded caps, chunky and whimsical. Palette: red and cream caps, autumn "
      "orange, pale stems."),
    P("ice_shard",
      "A cluster of jagged translucent ice crystal spikes thrusting up at "
      "angles, sharp faceted frozen shards. Palette: pale glacier-blue and "
      "white translucent ice."),
    P("bone_pile",
      "A pile of sun-bleached bones in the sand: a curved ribcage and a "
      "weathered skull with scattered bones, ancient desert remains. Palette: "
      "bleached bone white and pale tan."),
    P("mossy_idol",
      "An ancient carved stone idol head half-buried and overgrown, a weathered "
      "monolithic tiki-like face of dark stone covered in green moss and small "
      "vines and leaves. Palette: dark grey stone, jungle-green moss."),
]


def ordered(models=None):
    return sorted(models or MODELS, key=lambda m: m["rank"])


def by_id():
    return {m["id"]: m for m in MODELS}

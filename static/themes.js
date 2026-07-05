/*
 * themes.js — the five stage moods (owner: Agent A).
 * One THEME object per stage; every field the contract lists is present.
 * Art direction:
 *   hub    — bright Aegean noon: turquoise water, high white sun, warm haze.
 *   ice    — pale low sun, steel-blue water, aurora, everything slightly hushed.
 *   desert — blazing ochre; you stand on SAND (ground:'sand'), heat in the air.
 *   jungle — emerald waterways swallowed by dense green fog, warm god-ray sun.
 *   autumn — golden hour: bronze water, amber light, drifting leaves.
 */

export const DOMAIN_COLORS = {
  clio: '#d9a441', athena: '#2e9e8f', apollo: '#7d5ba6', dionysos: '#e4572e',
};

export const REALM_INFO = {
  ice:    { name: 'The Frostfang Reach', accent: '#7fd4ef', icon: 'ice' },
  desert: { name: 'The Bleached Reach',  accent: '#e8c27a', icon: 'desert' },
  jungle: { name: 'The Verdigris Deep',  accent: '#6fd490', icon: 'jungle' },
  autumn: { name: 'The Amber Vale',      accent: '#f0a24f', icon: 'autumn' },
  hub:    { name: 'The Isles of Peace',  accent: '#d9a441', icon: 'hub' },
};

const THEMES = {
  hub: {
    id: 'hub',
    water: { deep: 0x1272a8, shallow: 0x3fd0cf, sparkle: 1.0, chop: 1.0 },
    ground: 'water',
    sky: { zenith: 0x2c86d8, mid: 0x8fd0ee, horizon: 0xfdeed3 },
    fog: { color: 0xcfe9f3, near: 90, far: 520 },
    sun: { color: 0xfff1d6, intensity: 1.75, position: [180, 260, 120] },
    hemi: { sky: 0xd6ecff, ground: 0x3e7d5a, intensity: 0.85 },
    ambient: 0x28394a,
    palette: { grass: 0x5cb04b, grass2: 0x3d7d3a, sand: 0xeadfae, rock: 0x93999e },
    flora: 'aegean',
    particles: null,
    wall: { rock: 0x6d7681, snow: 0xf4f8fa, glow: 0xd9a441 },
  },

  ice: {
    id: 'ice',
    water: { deep: 0x16384e, shallow: 0x7fc4d4, sparkle: 1.35, chop: 0.5 },
    ground: 'water',
    sky: { zenith: 0x2e4a6e, mid: 0x9cc0d4, horizon: 0xf3ddc4 },
    fog: { color: 0xb9cfdb, near: 42, far: 270 },
    sun: { color: 0xffdfae, intensity: 1.1, position: [260, 70, -80] },
    hemi: { sky: 0xcfe4f2, ground: 0x54718a, intensity: 0.65 },
    ambient: 0x24333f,
    palette: { grass: 0xe3ecf2, grass2: 0xbccddb, sand: 0xdfe9ef, rock: 0x8ba4ba },
    flora: 'pine',
    particles: 'snow',
    wall: { rock: 0x5c7590, snow: 0xffffff, glow: 0x7fd4ef },
  },

  desert: {
    id: 'desert',
    water: { deep: 0x1a7f8e, shallow: 0x53d3c4, sparkle: 1.2, chop: 0.7 },
    ground: 'sand',
    sky: { zenith: 0x2470c2, mid: 0x8ec8e6, horizon: 0xf9e3ae },
    fog: { color: 0xeeddb0, near: 55, far: 310 },
    sun: { color: 0xfff3cd, intensity: 2.15, position: [120, 300, 60] },
    hemi: { sky: 0xffe9c0, ground: 0xb08a56, intensity: 0.75 },
    ambient: 0x3d3322,
    palette: { grass: 0xc9ae6e, grass2: 0xa8905a, sand: 0xf0dfae, rock: 0xc98a4a },
    flora: 'cactus',
    particles: 'dust',
    wall: { rock: 0xa8703e, snow: 0xf3e3b4, glow: 0xe8c27a },
  },

  jungle: {
    id: 'jungle',
    // silt-brown river water — the Verdigris Deep runs muddy, not blue
    water: { deep: 0x4a3a1c, shallow: 0x8a7440, sparkle: 0.4, chop: 0.7 },
    ground: 'water',
    sky: { zenith: 0x1f7fae, mid: 0x7cc4ad, horizon: 0xdcecb4 },
    // lifted ~8% (was 0x86b294): green fog on green islands collapsed the
    // stage's value separation — the murk needs to sit lighter than the isles
    fog: { color: 0x93bfa0, near: 24, far: 260 },
    sun: { color: 0xffe9ac, intensity: 1.85, position: [140, 220, -100] },
    hemi: { sky: 0xbfe4c8, ground: 0x2c6440, intensity: 0.9 },
    ambient: 0x1e3226,
    palette: { grass: 0x2e8a3a, grass2: 0x1c5c2c, sand: 0xd8cb96, rock: 0x5a6b4a },
    flora: 'jungle',
    particles: 'motes',
    wall: { rock: 0x46584a, snow: 0xcfe3c2, glow: 0x6fd490 },
  },

  autumn: {
    id: 'autumn',
    // crossed ON FOOT now: the 'ground' plane is a leaf-litter forest floor
    water: { deep: 0x4e3c1e, shallow: 0xd0913c, sparkle: 1.5, chop: 0.85 },
    ground: 'sand',
    sky: { zenith: 0x3c4e88, mid: 0xd88c50, horizon: 0xf8ce74 },
    // the Vale is a fog-of-war maze: THICK amber murk, pressing in close —
    // the flat golden trail arrows, landing beacons and barrow beam are all
    // fog-free, so the WAY always reads even when the woods beyond it don't
    fog: { color: 0xe3b184, near: 14, far: 135 },
    sun: { color: 0xffc274, intensity: 1.65, position: [250, 85, 150] },
    hemi: { sky: 0xf3d2a0, ground: 0x6e4a2e, intensity: 0.7 },
    ambient: 0x362619,
    palette: { grass: 0xc9772e, grass2: 0x5e5a24, sand: 0x9a8a46, rock: 0x8a6a52 },
    flora: 'autumn',
    particles: 'leaves',
    wall: { rock: 0x74584a, snow: 0xf6e9d2, glow: 0xf0a24f },
  },

  // The Dark Presence's arena — the top of the Pharos at a starless midnight.
  // Battle-only theme (never a board): obsidian floor, storm-black sky, the
  // great beacon smouldering ember-red overhead. Reached by climbing the
  // lighthouse, so everything is high, cold and lit only by fire.
  pharos: {
    id: 'pharos',
    water: { deep: 0x090b12, shallow: 0x17111e, sparkle: 0.15, chop: 0.25 },
    ground: 'sand',                       // solid dark-stone floor via sand disc
    sky: { zenith: 0x04050a, mid: 0x140f22, horizon: 0x3a1626 },
    fog: { color: 0x0a0b14, near: 26, far: 140 },
    sun: { color: 0xff6a34, intensity: 1.2, position: [24, 120, -52] },
    hemi: { sky: 0x2a2140, ground: 0x110a12, intensity: 0.5 },
    ambient: 0x0b0912,
    palette: { grass: 0x26272f, grass2: 0x121319, sand: 0x33343e, rock: 0x24252d },
    flora: 'none',
    particles: null,
    wall: { rock: 0x1b1c24, snow: 0x3a3b46, glow: 0xff6a34 },
  },
};

export function themeFor(stageId) {
  return THEMES[stageId] || THEMES.hub;
}

/*
 * gfx/looks.js — the lighting script for every stage.
 *
 * A "look" is everything about how a stage is LIT and GRADED: where the sun
 * sits and what colour it burns, the sky behind it, how thick and how warm
 * the haze is, the exposure, bloom and film grade. Geometry palettes and
 * gameplay fog distances stay in themes.js; this file is purely the light.
 *
 *   hub     high Aegean afternoon — crisp white sun, cobalt zenith, fair clouds
 *   ice     polar low sun — amber light raking across blue shadow, aurora above
 *   desert  blazing noon — hard overhead sun, bleached haze, almost no cloud
 *   jungle  humid late morning — sun shafts through green-gold vapour
 *   autumn  golden hour — the sun on the horizon, everything amber and long-shadowed
 *   pharos  starless midnight at the top of the lighthouse — ember firelight
 */

const LOOKS = {
  hub: {
    sun: { az: 38, el: 37, color: 0xffeccc, intensity: 2.8 },
    sky: { zenith: 0x1856bd, ground: 0x2d7fa6, curve: 0.52, glow: 0.5, disc: 30,
           clouds: { cover: 0.38, scale: 1.0, speed: 0.010, soft: 0.26, lit: 0xffffff, shade: 0x8fa3bd } },
    cloudShadow: { strength: 0.55, size: 190, speed: 2.6 },
    fog: { color: 0x86b8e4, sunColor: 0xffdca6, sunGlow: 0.32, heightFalloff: 0.024, heightBase: 5, heightAmount: 0.94 },
    env: 0.62, fill: { sky: 0xc4dcff, ground: 0x4a7f72, intensity: 0.16 },
    shadow: { strength: 0.9, radius: 2.5 },
    exposure: 0.9, bloom: { strength: 0.30, radius: 0.55, threshold: 1.05 },
    shafts: 0.35, shaftColor: 0xfff0cf,
    grade: { contrast: 1.09, saturation: 1.10, shadows: 0xeef8ff, highlights: 0xfff7e8, vignette: 0.26 },
  },

  ice: {
    sun: { az: -17, el: 12, color: 0xffcf96, intensity: 3.0 },
    sky: { zenith: 0x16305e, ground: 0x2c4f66, curve: 0.44, glow: 0.9, disc: 22, aurora: 0.85, stars: 0.3,
           clouds: { cover: 0.30, scale: 0.8, speed: 0.006, soft: 0.34, lit: 0xffe2c2, shade: 0x6c84a6 } },
    fog: { color: 0xb4cadb, sunColor: 0xf8c690, sunGlow: 0.34, heightFalloff: 0.018, heightBase: 5, heightAmount: 0.9 },
    cloudShadow: { strength: 0.32, size: 260, speed: 1.6 },
    // snow and ice throw the sky back up at everything: a strong ambient
    env: 1.1, fill: { sky: 0xbfd9f2, ground: 0x8fa9c4, intensity: 0.40 },
    shadow: { strength: 0.85, radius: 3.0 },
    exposure: 0.95, bloom: { strength: 0.22, radius: 0.7, threshold: 1.18 },
    shafts: 0.6, shaftColor: 0xffd9a8,
    grade: { contrast: 1.05, saturation: 1.02, shadows: 0xeaf4ff, highlights: 0xfff3e2, vignette: 0.30 },
  },

  desert: {
    sun: { az: 27, el: 41, color: 0xffedc6, intensity: 4.0 },
    sky: { zenith: 0x1a62c6, ground: 0xc9a96a, curve: 0.27, glow: 0.7, disc: 34,
           clouds: { cover: 0.08, scale: 1.4, speed: 0.006, soft: 0.22, lit: 0xffffff, shade: 0xc9b89a } },
    fog: { color: 0xecd6a2, sunColor: 0xfff0c2, sunGlow: 0.5, heightFalloff: 0.014, heightBase: 5, heightAmount: 0.85 },
    // the shade is COOL (sky-blue fill against the hot sun): dunes read by colour, not just value
    env: 0.58, fill: { sky: 0xe9e2ee, ground: 0xd8a868, intensity: 0.30 },
    cloudShadow: { strength: 0.34, size: 300, speed: 3.4, cover: 0.3 },
    shadow: { strength: 0.95, radius: 2.0 },
    exposure: 0.88, bloom: { strength: 0.34, radius: 0.6, threshold: 1.1 },
    shafts: 0.2, shaftColor: 0xfff0c8,
    grade: { contrast: 1.13, saturation: 1.10, shadows: 0xf0eeff, highlights: 0xfff8e6, vignette: 0.24 },
  },

  jungle: {
    sun: { az: -35, el: 38, color: 0xffe6a6, intensity: 3.2 },
    sky: { zenith: 0x2a86b0, ground: 0x3c5a34, curve: 0.52, glow: 1.0, disc: 24,
           clouds: { cover: 0.55, scale: 1.1, speed: 0.008, soft: 0.36, lit: 0xfff6dc, shade: 0x7d9a88 } },
    fog: { color: 0xa9c79c, sunColor: 0xf6e9a4, sunGlow: 1.0, heightFalloff: 0.020, heightBase: 4, heightAmount: 0.9 },
    env: 0.9, fill: { sky: 0xbfe4c8, ground: 0x2c6440, intensity: 0.28 },
    cloudShadow: { strength: 0.5, size: 150, speed: 1.8 },
    shadow: { strength: 0.88, radius: 3.0 },
    exposure: 1.04, bloom: { strength: 0.42, radius: 0.75, threshold: 1.0 },
    shafts: 0.95, shaftColor: 0xf3ecae,
    grade: { contrast: 1.08, saturation: 1.10, shadows: 0xeefff2, highlights: 0xfffbe4, vignette: 0.32 },
  },

  autumn: {
    sun: { az: 31, el: 16, color: 0xffc080, intensity: 3.4 },
    sky: { zenith: 0x35488a, ground: 0x6b4a2c, curve: 0.55, glow: 1.2, disc: 20,
           clouds: { cover: 0.42, scale: 0.9, speed: 0.007, soft: 0.32, lit: 0xffc890, shade: 0x8a6a72 } },
    fog: { color: 0xdca878, sunColor: 0xffc878, sunGlow: 0.8, heightFalloff: 0.030, heightBase: 9, heightAmount: 0.7 },
    // the shade under the trees is COOL (lavender fill against the amber sun) —
    // that contrast is what makes the light pools on the floor read as gold
    env: 1.15, fill: { sky: 0xc9b6d6, ground: 0x7a5a40, intensity: 0.5 },
    cloudShadow: { strength: 0.38, size: 160, speed: 1.5 },
    shadow: { strength: 0.82, radius: 3.5 },
    exposure: 1.0, bloom: { strength: 0.46, radius: 0.8, threshold: 1.0 },
    shafts: 1.0, shaftColor: 0xffc27a,
    grade: { contrast: 1.1, saturation: 1.08, shadows: 0xf3eeff, highlights: 0xfff1d8, vignette: 0.34 },
  },

  pharos: {
    sun: { az: -65, el: 62, color: 0xff7a3e, intensity: 2.4 },
    sky: { zenith: 0x03040a, ground: 0x08080e, curve: 0.6, glow: 0.0, disc: 0, stars: 1.0,
           clouds: { cover: 0.55, scale: 0.7, speed: 0.016, soft: 0.4, lit: 0x3a2030, shade: 0x0b0a12 } },
    fog: { color: 0x0b0c16, sunColor: 0x4a1a1a, sunGlow: 0.5, heightFalloff: 0.02, heightBase: 10, heightAmount: 0.5 },
    env: 0.9, fill: { sky: 0x3a3358, ground: 0x180c12, intensity: 0.5 },
    shadow: { strength: 0.9, radius: 3.0 },
    exposure: 1.1, bloom: { strength: 0.6, radius: 0.85, threshold: 0.9 },
    shafts: 0, shaftColor: 0xff8a50,
    grade: { contrast: 1.1, saturation: 1.05, shadows: 0xeef0ff, highlights: 0xffeede, vignette: 0.42 },
  },
};

export function lookFor(stageId) {
  return LOOKS[stageId] || LOOKS.hub;
}

/*
 * modelmat.js — finishing pass for the GLB models (creatures, props, landmarks).
 *
 * Every kept Meshy sculpt ships ONE baked PBR material: base colour, a
 * metal/roughness map, a normal map and usually an emissive map. Raw, they
 * were authored for a neutral viewer and read wrong under the game's HDR
 * sky light: the roughness maps average ~0.5 (everything looks glazed), some
 * stone is flagged half-metal, and a few emissive maps contain the whole
 * surface. finishModel() converts each material into a ModelMaterial and
 * applies a per-model FINISH spec:
 *
 *   rough [lo, hi]  the baked roughness map (0..1) is REMAPPED into this
 *                   range, so the painted variation survives but stone and
 *                   cloth stay matte while ice, crystal, wet hide and bronze
 *                   keep a believable gloss
 *   metal           scales the baked metalness map (0 = fully dielectric)
 *   glow            emissive intensity for the baked emissive map; the frame
 *                   is linear HDR, so anything that ends up above 1.0 blooms
 *   glowTint        colour multiplied into the emissive map
 *   glowGate        0..1 — how strictly WHITE emissive texels are rejected
 *                   (Meshy bakes snow, marble and pale fur into the emissive
 *                   map; only coloured light is real glow). Default 1.
 *   eyes            { key, gain, tol, min } "painted glow": albedo texels
 *                   whose hue matches `key` self-illuminate — eyes, visor
 *                   slits, lava cracks that the emissive map missed
 *   side            'front' for closed sculpts (cheaper, cleaner shadows),
 *                   'double' for foliage / cloth / open shells
 *   tint, desat     recolour: desaturate the baked albedo, then multiply —
 *                   how one sculpt stands in for another creature
 *
 * ModelMaterial is a MeshStandardMaterial subclass (same shader, same
 * `type`), so clone() keeps the finish and three's renderer treats it as a
 * standard material. Its compile hook binds the shared atmosphere uniforms
 * (gfx/atmosphere.js) like every other material in the game.
 */
import * as THREE from 'three';
import { bindAtmosphere } from './gfx/atmosphere.js';

const _white = new THREE.Color(1, 1, 1);
const _key = new THREE.Color();

/* hex / css colour, or a LINEAR [r, g, b] multiplier (may exceed 1 to brighten) */
function setColor(c, v) {
  if (Array.isArray(v)) c.setRGB(v[0], v[1], v[2]);
  else c.set(v);
  return c;
}

export class ModelMaterial extends THREE.MeshStandardMaterial {
  constructor() {
    super();
    this.isModelMaterial = true;
    // x: roughness lo, y: roughness hi, z: desaturate 0..1, w: player-tint amount 0..1
    this.finish = new THREE.Vector4(0, 1, 0, 0);
    this.tint = new THREE.Color(1, 1, 1);         // multiplied into the albedo
    this.playerTint = new THREE.Color(1, 1, 1);   // replaces neutral-grey cloth (captain)
    // painted glow: texels whose HUE matches rgb emit light. w = gain (0 = off)
    this.glowKey = new THREE.Vector4(1, 1, 1, 0);
    // x: hue-match threshold (cosine), y: min brightness, z: emissive-map chroma gate 0..1
    this.glowParams = new THREE.Vector4(0.95, 0.3, 1, 0);
  }

  copy(src) {
    super.copy(src);
    if (src.isModelMaterial) {
      this.finish.copy(src.finish);
      this.tint.copy(src.tint);
      this.playerTint.copy(src.playerTint);
      this.glowKey.copy(src.glowKey);
      this.glowParams.copy(src.glowParams);
    }
    return this;
  }

  onBeforeCompile(shader) {
    bindAtmosphere(shader);
    shader.uniforms.uMMFinish = { value: this.finish };
    shader.uniforms.uMMTint = { value: this.tint };
    shader.uniforms.uMMPlayer = { value: this.playerTint };
    shader.uniforms.uMMKey = { value: this.glowKey };
    shader.uniforms.uMMGlow = { value: this.glowParams };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform vec4 uMMFinish;
        uniform vec3 uMMTint;
        uniform vec3 uMMPlayer;
        uniform vec4 uMMKey;
        uniform vec4 uMMGlow;
        vec3 mmKeyGlow;`)
      .replace('#include <map_fragment>', /* glsl */`#include <map_fragment>
        {
          vec3 mmC = diffuseColor.rgb;
          float mmL = dot(mmC, vec3(0.2126, 0.7152, 0.0722));
          float mmHi = max(mmC.r, max(mmC.g, mmC.b));
          float mmLo = min(mmC.r, min(mmC.g, mmC.b));
          float mmSat = (mmHi - mmLo) / max(mmHi, 0.02);
          // painted glow (eyes, runes, embers): hue-keyed self-illumination
          float mmSim = dot(normalize(mmC + 1e-4), normalize(uMMKey.rgb + 1e-4));
          mmKeyGlow = mmC * (uMMKey.w * smoothstep(uMMGlow.x, mix(uMMGlow.x, 1.0, 0.6), mmSim)
                    * smoothstep(uMMGlow.y, uMMGlow.y + 0.18, mmHi));
          // player colours: neutral-grey cloth takes the hue, its shading stays
          float mmGrey = (1.0 - smoothstep(0.10, 0.24, mmSat))
                       * smoothstep(0.035, 0.12, mmL) * uMMFinish.w;
          mmC = mix(mmC, uMMPlayer * min(mmL * 2.6, 1.15), mmGrey);
          diffuseColor.rgb = mix(mmC, vec3(mmL), uMMFinish.z * (1.0 - mmGrey)) * uMMTint;
        }`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
        roughnessFactor = mix(uMMFinish.x, uMMFinish.y, roughnessFactor);`)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        {
          // Meshy's emissive maps also contain plain WHITE surfaces (snow,
          // marble, pale fur). Only coloured light is real glow: gate by chroma.
          float mmEHi = max(totalEmissiveRadiance.r, max(totalEmissiveRadiance.g, totalEmissiveRadiance.b));
          float mmELo = min(totalEmissiveRadiance.r, min(totalEmissiveRadiance.g, totalEmissiveRadiance.b));
          float mmESat = (mmEHi - mmELo) / max(mmEHi, 1e-3);
          totalEmissiveRadiance *= mix(1.0, smoothstep(0.16, 0.40, mmESat), uMMGlow.z);
          totalEmissiveRadiance += mmKeyGlow;
        }`);
  }

  customProgramCacheKey() { return 'thalassa-model-v2'; }
}

/* ── finish presets by material class ────────────────────────────────────── */
export const FINISH = {
  stone:   { rough: [0.80, 1.00], metal: 0, glow: 0, side: 'front' },
  marble:  { rough: [0.55, 0.95], metal: 0, glow: 0, side: 'front' },
  wood:    { rough: [0.72, 0.98], metal: 0, glow: 0, side: 'front' },
  cloth:   { rough: [0.82, 1.00], metal: 0, glow: 0, side: 'double' },
  foliage: { rough: [0.62, 0.95], metal: 0, glow: 0, side: 'double' },
  hide:    { rough: [0.62, 0.98], metal: 0, glow: 1, side: 'front' },
  wet:     { rough: [0.22, 0.72], metal: 0, glow: 1, side: 'front' },
  metal:   { rough: [0.30, 0.90], metal: 1, glow: 1, side: 'front' },
  ice:     { rough: [0.06, 0.42], metal: 0, glow: 0.22, side: 'front' },
  crystal: { rough: [0.05, 0.35], metal: 0, glow: 0.9, side: 'front' },
  ember:   { rough: [0.60, 0.95], metal: 0.6, glow: 3.0, side: 'double' },
};

const ANISO = 4;       // clamped to the device maximum by the renderer
const _done = new WeakMap();   // source material → finished ModelMaterial

function toModelMaterial(src, spec) {
  if (src.isModelMaterial) return src;
  let m = _done.get(src);
  if (m) return m;
  if (!src.isMeshStandardMaterial) return src;   // basic/unlit helper — leave it
  m = new ModelMaterial();
  m.copy(src);
  m.name = src.name;
  const r = spec.rough || [0.6, 1];
  if (m.roughnessMap) {
    m.roughness = 1;                              // the map drives it, remapped in-shader
    m.finish.x = r[0]; m.finish.y = r[1];
  } else {
    m.finish.x = 0; m.finish.y = 1;               // no map → remap the scalar here
    m.roughness = THREE.MathUtils.clamp(m.roughness, r[0], r[1]);
  }
  m.metalness = m.metalnessMap ? (spec.metal ?? 0) : Math.min(m.metalness, spec.metal ?? 0);
  const glows = m.emissiveMap || (m.emissive.r + m.emissive.g + m.emissive.b) > 0.01;
  if (glows) {
    m.emissiveIntensity = spec.glow ?? 1;
    if (spec.glowTint != null) m.emissive.set(spec.glowTint);
    if (!(m.emissiveIntensity > 0)) { m.emissive.setRGB(0, 0, 0); m.emissiveMap = null; }
  }
  m.side = spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide;
  m.flatShading = false;      // GLTFLoader sets it when a mesh has no normals; repairGeometry adds them
  if (spec.desat != null) m.finish.z = spec.desat;
  m.tint.copy(_white);
  if (spec.tint != null) setColor(m.tint, spec.tint);
  m.glowParams.z = spec.glowGate ?? 1;
  if (spec.eyes) {
    const e = spec.eyes;
    setColor(_key, e.key);
    m.glowKey.set(_key.r, _key.g, _key.b, e.gain ?? 3);
    m.glowParams.x = e.tol ?? 0.95;
    m.glowParams.y = e.min ?? 0.3;
  }
  if (spec.normalScale != null && m.normalMap) m.normalScale.setScalar(spec.normalScale);
  for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) {
    const t = m[k];
    if (t && t.anisotropy < ANISO) { t.anisotropy = ANISO; t.needsUpdate = true; }
  }
  _done.set(src, m);
  return m;
}

/* ── geometry repair ─────────────────────────────────────────────────────────
 * Two defects in the shipped GLBs are fixed here, once per geometry (clones
 * share it), before anything renders:
 *
 *  · ZERO-LENGTH NORMALS. A handful of prop/landmark vertices carry a normal
 *    of (0,0,0) (degenerate triangles in the source mesh). normalize() of
 *    that is NaN, one NaN pixel in an HDR frame is smeared over the whole
 *    screen by the bloom blur → black frame. Each such normal is replaced by
 *    the average of its faces, else of its co-located neighbours, else +Y.
 *
 *  · NO NORMALS AT ALL. Every creature GLB was exported without a normal
 *    attribute, so GLTFLoader fell back to flat shading — faceted sculpts
 *    under a tangent-space normal map that was baked for smooth ones. They
 *    get crease-aware smooth normals: averaged across the UV seams that
 *    split the mesh (by position), but not across edges sharper than CREASE,
 *    so armour plates and stone blocks keep their corners.
 */
const CREASE_COS = Math.cos(THREE.MathUtils.degToRad(62));
const _repaired = new WeakSet();
export const repairStats = { healed: 0, smoothed: 0 };   // read by modeltest.html

function positionGroups(pos) {
  // co-located vertices → linked lists (head by quantized position, next by index)
  const n = pos.count;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const q = 65535 / Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-9);
  const head = new Map();
  const next = new Int32Array(n).fill(-1);
  const first = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.round((pos.getX(i) - x0) * q)
            + Math.round((pos.getY(i) - y0) * q) * 65536
            + Math.round((pos.getZ(i) - z0) * q) * 4294967296;
    const h = head.get(k);
    if (h === undefined) { head.set(k, i); first[i] = i; }
    else { next[i] = next[h]; next[h] = i; first[i] = h; }
  }
  return { first, next };
}

function repairGeometry(geo) {
  if (_repaired.has(geo)) return;
  _repaired.add(geo);
  const pos = geo.getAttribute('position');
  if (!pos) return;
  let nrm = geo.getAttribute('normal');
  if (!nrm) {
    // no normals: per-chart normals first, then weld across seams below the crease angle
    geo.computeVertexNormals();
    nrm = geo.getAttribute('normal');
    const n = nrm.count;
    const src = Float32Array.from(nrm.array);
    const { first, next } = positionGroups(pos);
    const out = nrm.array;
    for (let i = 0; i < n; i++) {
      const ax = src[i * 3], ay = src[i * 3 + 1], az = src[i * 3 + 2];
      const lone = ax * ax + ay * ay + az * az < 1e-12;   // degenerate faces only: take any neighbour
      let sx = 0, sy = 0, sz = 0;
      for (let j = first[i]; j !== -1; j = next[j]) {
        const bx = src[j * 3], by = src[j * 3 + 1], bz = src[j * 3 + 2];
        if (lone || ax * bx + ay * by + az * bz >= CREASE_COS) { sx += bx; sy += by; sz += bz; }
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-6) { out[i * 3] = sx / l; out[i * 3 + 1] = sy / l; out[i * 3 + 2] = sz / l; }
      else { out[i * 3] = 0; out[i * 3 + 1] = 1; out[i * 3 + 2] = 0; }
    }
    nrm.needsUpdate = true;
    repairStats.smoothed++;
    return;
  }
  // normals present: heal the zero-length ones
  const bad = [];
  for (let i = 0; i < nrm.count; i++) {
    const x = nrm.getX(i), y = nrm.getY(i), z = nrm.getZ(i);
    if (!(x * x + y * y + z * z > 1e-12)) bad.push(i);
  }
  if (!bad.length) return;
  const fix = new Map(bad.map((i) => [i, [0, 0, 0]]));
  const idx = geo.index;
  const tri = idx ? idx.count : pos.count;
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  for (let t = 0; t < tri; t += 3) {
    const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
    const f0 = fix.get(i0), f1 = fix.get(i1), f2 = fix.get(i2);
    if (!f0 && !f1 && !f2) continue;
    _a.fromBufferAttribute(pos, i0); _b.fromBufferAttribute(pos, i1); _c.fromBufferAttribute(pos, i2);
    _b.sub(_a); _c.sub(_a); _b.cross(_c);            // area-weighted face normal
    for (const f of [f0, f1, f2]) if (f) { f[0] += _b.x; f[1] += _b.y; f[2] += _b.z; }
  }
  let groups = null;
  for (const [i, f] of fix) {
    let l = Math.hypot(f[0], f[1], f[2]);
    if (!(l > 1e-9)) {
      // every face on it is degenerate: borrow from a vertex at the same place
      groups = groups || positionGroups(pos);
      for (let j = groups.first[i]; j !== -1; j = groups.next[j]) {
        if (fix.has(j)) continue;
        f[0] += nrm.getX(j); f[1] += nrm.getY(j); f[2] += nrm.getZ(j);
      }
      l = Math.hypot(f[0], f[1], f[2]);
    }
    if (l > 1e-9) nrm.setXYZ(i, f[0] / l, f[1] / l, f[2] / l);
    else nrm.setXYZ(i, 0, 1, 0);
    repairStats.healed++;
  }
  if (nrm.isInterleavedBufferAttribute) nrm.data.needsUpdate = true;
  else nrm.needsUpdate = true;
}

/**
 * Apply a finish spec to every mesh under `root` (in place). `spec` is a
 * FINISH preset or a custom object of the same shape; `skip(mesh)` may veto
 * meshes that carry their own hand-made materials.
 */
export function finishModel(root, spec = FINISH.stone, { castShadow = true, skip = null } = {}) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (skip && skip(o)) return;
    o.castShadow = castShadow;
    o.receiveShadow = true;
    repairGeometry(o.geometry);
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => (m ? toModelMaterial(m, spec) : m))
      : toModelMaterial(o.material, spec);
  });
  return root;
}

/** preset + overrides, e.g. finishOf('stone', { glow: 2 }) */
export { setColor as setModelColor };

export function finishOf(name, over = null) {
  const base = FINISH[name] || FINISH.stone;
  return over ? { ...base, ...over } : base;
}

/* a soft round additive glow texture, shared by every model halo */
let _glowTex = null;
export function modelGlowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

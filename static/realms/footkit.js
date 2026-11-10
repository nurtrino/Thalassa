/*
 * realms/footkit.js — shared pieces for the two realms crossed ON FOOT
 * (the Bleached Reach and the Amber Vale).
 *
 *   · trail geometry helpers   distance to the lane network, node bubbles
 *   · makeTrailField           a small signed-distance texture of the trail
 *                              network; the floor shaders read it to paint the
 *                              packed lane (crisp at any width, 1 byte/texel)
 *   · shader glue              world-space varyings for MeshStandardMaterial
 *   · small geometry helpers   merged, vertex-coloured, smooth-shaded builds
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bindAtmosphere } from '../gfx/atmosphere.js';

export const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, k) => a + (b - a) * k;

/* distance from (x,z) to the nearest lane segment [x0,z0,x1,z1] */
export function makeSegDist(segs) {
  const S = segs.map((s) => {
    const dx = s[2] - s[0], dz = s[3] - s[1];
    return [s[0], s[1], dx, dz, 1 / (dx * dx + dz * dz || 1)];
  });
  return (x, z) => {
    let d2 = 1e18;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      let t = ((x - s[0]) * s[2] + (z - s[1]) * s[3]) * s[4];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = s[0] + s[2] * t - x, ez = s[1] + s[3] * t - z;
      const e = ex * ex + ez * ez;
      if (e < d2) d2 = e;
    }
    return Math.sqrt(d2);
  };
}

/* the stops of a lane network: unique segment endpoints with their degree */
export function trailStops(segs) {
  const m = new Map();
  const add = (x, z) => {
    const k = Math.round(x * 4) + ':' + Math.round(z * 4);
    const e = m.get(k);
    if (e) e.deg++; else m.set(k, { x, z, deg: 1 });
  };
  for (const s of segs) { add(s[0], s[1]); add(s[2], s[3]); }
  return [...m.values()];
}

/*
 * makeTrailField — distance-to-trail baked into an R8 texture.
 * Texel value = distance to the nearest lane centreline (or stop disc),
 * 0 … `reach` world units mapped to 0 … 1. Bilinear filtering of a distance
 * field reconstructs a clean edge at any threshold, so a 1.3 u/texel map
 * still draws a crisp, smooth-sided path. set() rebuilds it (cheap: only the
 * texels near each segment are touched) — the Vale calls it as its trails
 * are revealed.
 */
export function makeTrailField({ cx = 0, cz = 0, half = 400, res = 512, reach = 12 } = {}) {
  const data = new Uint8Array(res * res).fill(255);
  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const ox = cx - half, oz = cz - half;
  const k = res / (half * 2);                      // texels per world unit
  const pad = reach + 2 / k;

  // stamp a capsule (segment + radius r0 of "zero distance") into the field
  const stamp = (x0, z0, x1, z1, r0) => {
    const i0 = Math.max(1, Math.floor((Math.min(x0, x1) - pad - r0 - ox) * k));
    const i1 = Math.min(res - 2, Math.ceil((Math.max(x0, x1) + pad + r0 - ox) * k));
    const j0 = Math.max(1, Math.floor((Math.min(z0, z1) - pad - r0 - oz) * k));
    const j1 = Math.min(res - 2, Math.ceil((Math.max(z0, z1) + pad + r0 - oz) * k));
    const dx = x1 - x0, dz = z1 - z0, inv = 1 / (dx * dx + dz * dz || 1);
    for (let j = j0; j <= j1; j++) {
      const wz = oz + (j + 0.5) / k;
      for (let i = i0; i <= i1; i++) {
        const wx = ox + (i + 0.5) / k;
        let t = ((wx - x0) * dx + (wz - z0) * dz) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x0 + dx * t - wx, z0 + dz * t - wz) - r0;
        const v = d <= 0 ? 0 : d >= reach ? 255 : (d / reach) * 255;
        const o = j * res + i;
        if (v < data[o]) data[o] = v;
      }
    }
  };

  let key = '';
  return {
    texture: tex,
    reach,
    /** uniforms for TRAIL_GLSL (shared objects — bind into any shader) */
    uniforms: {
      uTrailTex: { value: tex },
      uTrailXf: { value: new THREE.Vector4(ox, oz, 1 / (half * 2), reach) },
    },
    /** segs: [[x0,z0,x1,z1]…] world space; discs: [[x,z,r]…] trodden clearings */
    set(segs = [], discs = []) {
      const nk = segs.length + '|' + discs.length + '|'
        + segs.reduce((a, s) => a + s[0] * 3 + s[1] * 7 + s[2] * 11 + s[3] * 13, 0).toFixed(1)
        + discs.reduce((a, s) => a + s[0] + s[1] * 3 + s[2] * 5, 0).toFixed(1);
      if (nk === key) return false;
      key = nk;
      data.fill(255);
      for (const s of segs) stamp(s[0], s[1], s[2], s[3], 0);
      for (const d of discs) stamp(d[0], d[1], d[0], d[1], d[2]);
      tex.needsUpdate = true;
      return true;
    },
  };
}

/* GLSL: trailDist(worldXZ) → world units to the trail centreline (≤ reach) */
export const TRAIL_GLSL = /* glsl */`
uniform sampler2D uTrailTex;
uniform vec4 uTrailXf;
float trailDist(vec2 xz) {
  vec2 uv = (xz - uTrailXf.xy) * uTrailXf.z;
  return texture2D(uTrailTex, uv).r * uTrailXf.w;
}`;

/*
 * World-space varyings for a MeshStandardMaterial patch: vWPos (world
 * position, instancing-aware) and vWNrm (world normal). Call from inside
 * onBeforeCompile; it also binds the shared atmosphere uniforms, which every
 * material with its own compile hook must do.
 */
export function addWorldVaryings(shader) {
  bindAtmosphere(shader);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
    .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
      {
        vec4 wp4 = vec4(transformed, 1.0);
        vec3 wn3 = objectNormal;
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
          wn3 = mat3(instanceMatrix) * wn3;
        #endif
        vWPos = (modelMatrix * wp4).xyz;
        vWNrm = normalize(mat3(modelMatrix) * wn3);
      }`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;');
}

/* cheap value-noise in GLSL (2 octaves available via fkNoise twice) */
export const NOISE_GLSL = /* glsl */`
float fkHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float fkNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fkHash(i), fkHash(i + vec2(1.0, 0.0)), u.x),
             mix(fkHash(i + vec2(0.0, 1.0)), fkHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

/* ── geometry helpers ────────────────────────────────────────────────────── */

/* paint a whole geometry one vertex colour (optionally shaded by a function
   of the vertex position: shade(x,y,z) → multiplier) */
export function tint(geo, hex, shade = null) {
  const p = geo.attributes.position;
  const c = new THREE.Color(hex);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = shade ? shade(p.getX(i), p.getY(i), p.getZ(i)) : 1;
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/* merge vertex-coloured parts into one indexed geometry (all parts must carry
   position / normal / uv / color). Returns null for an empty list. */
export function merge(parts) {
  const list = parts.filter(Boolean).map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') n.deleteAttribute(k);
    }
    return n;
  });
  if (!list.length) return null;
  const g = mergeGeometries(list, false);
  for (const p of parts) if (p) p.dispose();
  return g;
}

/* lumpy organic solid: an icosphere pushed around by smooth 3D value noise,
   re-normalled so it shades as one soft mass (no facets) */
export function lumpGeometry(radius, detail, amount, seed, freq = 1.6) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const h3 = (x, y, z) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 13.37) * 43758.5453;
    return s - Math.floor(s);
  };
  const n3 = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(h3(ix, iy, iz), h3(ix + 1, iy, iz), ux), l(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), ux), uy),
             l(l(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), ux), l(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), ux), uy), uz);
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (n3(x * freq + 5, y * freq + 9, z * freq + 3) - 0.5) * 2 * amount
                + (n3(x * freq * 2.7 + 1, y * freq * 2.7, z * freq * 2.7 + 7) - 0.5) * amount * 0.6;
    p.setXYZ(i, x * k * radius, y * k * radius, z * k * radius);
  }
  // icospheres are non-indexed per face: weld normals by position so the
  // mass shades smooth
  smoothNormals(g);
  return g;
}

/* position-welded smooth normals for a non-indexed geometry */
export function smoothNormals(g) {
  g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal;
  const acc = new Map();
  const key = (i) => Math.round(p.getX(i) * 1e3) + ',' + Math.round(p.getY(i) * 1e3) + ',' + Math.round(p.getZ(i) * 1e3);
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    let a = acc.get(k);
    if (!a) { a = [0, 0, 0]; acc.set(k, a); }
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
  }
  for (let i = 0; i < p.count; i++) {
    const a = acc.get(key(i));
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
  }
  return g;
}

/* a tapered tube along a smooth curve through `pts` (radius r0 → r1).
   UVs run (around · uRep, along · vRep) so bark/grain textures follow the limb. */
export function taperTube(pts, r0, r1, segs = 10, radial = 6, uRep = 1, vRep = 1) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const p = g.attributes.position, uv = g.attributes.uv;
  const cp = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, cp);
    const rr = r0 + (r1 - r0) * Math.pow(i / segs, 0.8);
    for (let j = 0; j <= radial; j++) {
      const o = i * (radial + 1) + j;
      p.setXYZ(o, cp.x + (p.getX(o) - cp.x) * rr, cp.y + (p.getY(o) - cp.y) * rr, cp.z + (p.getZ(o) - cp.z) * rr);
      uv.setXY(o, (j / radial) * uRep, (i / segs) * vRep);
    }
  }
  g.computeVertexNormals();
  // close the shading seam: first and last vertex of each ring coincide
  const n = g.attributes.normal;
  for (let i = 0; i <= segs; i++) {
    const a = i * (radial + 1), b = a + radial;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/* a canvas the caller paints, wrapped as a repeating sRGB (or data) texture */
export function canvasTexture(size, paint, { srgb = true, aniso = 8 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  paint(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

/* the hunting-ground warning: a leaning, weathered stake crowned with a skull
   and crossed thigh bones — ambushes happen here. One merged mesh. */
let _stakeMat = null;
export function warningStake(rng, s = 1) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const parts = [];
  const lean = (rng() - 0.5) * 0.5;
  const top = V(lean * 0.9 * s, 2.5 * s, 0.1 * s);
  const pole = taperTube([V(0, -0.3 * s, 0), V(lean * 0.3 * s, 1.0 * s, 0), top], 0.11 * s, 0.07 * s, 5, 6);
  parts.push(tint(pole, 0x6b4d33, (x, y) => 0.7 + clamp01(y / (2.5 * s)) * 0.4));
  for (const side of [-1, 1]) {
    const b = taperTube([V(top.x - 0.62 * s, top.y - 0.95 * s - side * 0.42 * s, 0.12 * s),
                         V(top.x, top.y - 0.9 * s, 0.16 * s),
                         V(top.x + 0.62 * s, top.y - 0.95 * s + side * 0.42 * s, 0.12 * s)], 0.06 * s, 0.06 * s, 3, 5);
    parts.push(tint(b, 0xe9e1cc));
    for (const e of [-1, 1]) {                       // knuckle ends
      const k = new THREE.SphereGeometry(0.085 * s, 6, 4);
      k.translate(top.x + e * 0.62 * s, top.y - 0.95 * s + e * side * 0.42 * s, 0.12 * s);
      parts.push(tint(k, 0xe9e1cc));
    }
  }
  // the skull: cranium, cheek block, two dark sockets and a nose notch
  const cranium = lumpGeometry(1, 1, 0.07, 17, 1.2);
  cranium.scale(0.33 * s, 0.34 * s, 0.38 * s);
  cranium.translate(top.x, top.y + 0.18 * s, top.z);
  parts.push(tint(cranium, 0xefe8d6, (x, y) => 0.8 + clamp01((y - top.y) / (0.4 * s)) * 0.22));
  const jaw = new THREE.BoxGeometry(0.34 * s, 0.2 * s, 0.26 * s, 1, 1, 1);
  jaw.translate(top.x, top.y - 0.12 * s, top.z + 0.12 * s);
  parts.push(tint(jaw, 0xddd4bd));
  for (const e of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.085 * s, 7, 5);
    eye.translate(top.x + e * 0.13 * s, top.y + 0.16 * s, top.z + 0.3 * s);
    parts.push(tint(eye, 0x120d0a));
  }
  const nose = new THREE.SphereGeometry(0.045 * s, 5, 4);
  nose.translate(top.x, top.y + 0.03 * s, top.z + 0.35 * s);
  parts.push(tint(nose, 0x120d0a));
  const m = new THREE.Mesh(merge(parts), _stakeMat || (_stakeMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.7, metalness: 0 })));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

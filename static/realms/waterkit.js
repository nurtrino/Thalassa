/*
 * realms/waterkit.js — small geometry kit shared by the two water realms
 * (realms/ice.js, realms/jungle.js).
 *
 * Everything the realm builders make is SMOOTH-shaded, vertex-coloured and
 * merged or instanced, so a whole berg field or a whole river bank costs a
 * handful of draw calls:
 *   makeNoise3(seed)            3D value noise (0..1)
 *   icoBase(detail)             cached INDEXED unit icosphere (shared verts)
 *   radialGeo(detail, shape)    star-shaped solid from a per-direction function
 *   paint(geo, colourOf)        per-vertex colour from position + normal
 *   mergeGeos([...])            one indexed geometry out of many
 *   tubeAlong(points, r0, r1)   a tapering limb along a polyline (roots, trunks)
 *   laneTools(nodes, segs)      distance-to-lane / distance-to-stop queries
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const SEA_Y = -0.3;                     // keep in step with gfx/ocean.js WATER_Y

export const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
export const lerp = (a, b, k) => a + (b - a) * k;

/* ── 3D value noise ──────────────────────────────────────────────────────── */
export function makeNoise3(seed = 1) {
  const s = (seed % 9973) * 0.137 + 0.71;
  const h = (x, y, z) => {
    const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 19.19) * 43758.5453;
    return v - Math.floor(v);
  };
  const noise = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    const a = lerp(lerp(h(ix, iy, iz), h(ix + 1, iy, iz), sx),
                   lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), sx), sy);
    const b = lerp(lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), sx),
                   lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), sx), sy);
    return lerp(a, b, sz);
  };
  noise.fbm = (x, y, z) => (noise(x, y, z) + 0.5 * noise(x * 2.03 + 17.1, y * 2.03 - 9.3, z * 2.03 + 4.7)
                            + 0.25 * noise(x * 4.11 - 31.9, y * 4.11 + 23.4, z * 4.11 - 12.2)) / 1.75;
  return noise;
}

/* ── icosphere with SHARED vertices (so displaced lumps shade smooth) ────── */
const _ico = new Map();
export function icoBase(detail) {
  let g = _ico.get(detail);
  if (!g) {
    const raw = new THREE.IcosahedronGeometry(1, detail);
    raw.deleteAttribute('normal');
    raw.deleteAttribute('uv');
    g = mergeVertices(raw, 1e-4);
    raw.dispose();
    _ico.set(detail, g);
  }
  return g;
}

/*
 * radialGeo — a star-shaped solid. shape(dir, out) receives each unit
 * direction and writes the vertex position. Normals are recomputed smooth.
 */
const _d = new THREE.Vector3(), _o = new THREE.Vector3();
export function radialGeo(detail, shape) {
  const base = icoBase(detail);
  const src = base.attributes.position;
  const pos = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    _d.fromBufferAttribute(src, i).normalize();
    shape(_d, _o);
    pos[i * 3] = _o.x; pos[i * 3 + 1] = _o.y; pos[i * 3 + 2] = _o.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(Array.from(base.index.array));
  geo.computeVertexNormals();
  return geo;
}

/* per-vertex colour: colourOf(p, n, outColor) */
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Color();
export function paint(geo, colourOf) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    _n.fromBufferAttribute(nor, i);
    colourOf(_p, _n, _c);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/* merge indexed/non-indexed geometries carrying position + normal + color */
export function mergeGeos(geos, { dispose = true } = {}) {
  let nv = 0, ni = 0;
  for (const g of geos) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, vo * 3);
    else col.fill(1, vo * 3, (vo + n) * 3);
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io++] = a[i] + vo;
    } else {
      for (let i = 0; i < n; i++) idx[io++] = vo + i;
    }
    vo += n;
    if (dispose) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/* move/rotate/scale a geometry in place and hand it back (chainable) */
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _t = new THREE.Vector3(), _s = new THREE.Vector3();
export function xform(geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1, sx = 1, sy = 1, sz = 1 } = {}) {
  _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ'));
  _m.compose(_t.set(x, y, z), _q, _s.set(s * sx, s * sy, s * sz));
  geo.applyMatrix4(_m);
  return geo;
}

/*
 * tubeAlong — a smooth tapering limb through a list of Vector3 points
 * (Catmull-Rom). Used for trunks, buttress and mangrove roots, vines.
 * colourOf(t, out) paints along the length (t = 0 root … 1 tip).
 */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
export function tubeAlong(points, r0, r1, { radial = 5, steps = 6, colourOf = null, cap = false } = {}) {
  const curve = new THREE.CatmullRomCurve3(points);
  const pos = [], nor = [], col = [], idx = [];
  const c = new THREE.Color(1, 1, 1);
  // a stable frame: carry the previous normal forward
  _u.set(0.31, 0.2, 0.93).normalize();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    curve.getPoint(t, _a);
    curve.getTangent(t, _b).normalize();
    _v.crossVectors(_b, _u).normalize();          // side
    _u.crossVectors(_v, _b).normalize();          // up, re-orthogonalised
    const r = lerp(r0, r1, t);
    if (colourOf) colourOf(t, c);
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const cx = Math.cos(a), sx = Math.sin(a);
      const nx = _v.x * cx + _u.x * sx, ny = _v.y * cx + _u.y * sx, nz = _v.z * cx + _u.z * sx;
      pos.push(_a.x + nx * r, _a.y + ny * r, _a.z + nz * r);
      nor.push(nx, ny, nz);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * radial + k, b = i * radial + (k + 1) % radial;
      const d = a + radial, e = b + radial;
      idx.push(a, d, b, b, d, e);
    }
  }
  if (cap) {
    const tip = pos.length / 3;
    curve.getPoint(1, _a);
    curve.getTangent(1, _b).normalize();
    pos.push(_a.x + _b.x * r1 * 0.6, _a.y + _b.y * r1 * 0.6, _a.z + _b.z * r1 * 0.6);
    nor.push(_b.x, _b.y, _b.z);
    col.push(c.r, c.g, c.b);
    const ring = steps * radial;
    for (let k = 0; k < radial; k++) idx.push(ring + k, tip, ring + (k + 1) % radial);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/*
 * laneTools — where the road and the stops are, so the wilds keep clear.
 * nodes: realm board nodes; segs: lane segments [x1, z1, x2, z2].
 */
export function laneTools(nodes, segs) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const segDist = (x, z) => {
    let d = 1e9;
    for (const s of segs) {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / L2));
      const ex = s[0] + dx * t - x, ez = s[1] + dz * t - z;
      d = Math.min(d, ex * ex + ez * ez);
    }
    return Math.sqrt(d);
  };
  // every stop keeps a clearing sized to what stands on it
  const clearOf = (n) => {
    if (n.type === 'gate') return 30;
    if (n.type === 'lair') return 27;
    if (!n.type || n.type === 'sea') return n.look === 'islet' ? 10 : 7;
    return 23;
  };
  /* > 0 = that far outside every stop's clearing (plus pad) */
  const nodeGap = (x, z, pad = 0) => {
    let d = 1e9;
    for (const n of nodes) d = Math.min(d, Math.hypot(n.x - x, n.z - z) - clearOf(n) - pad);
    return d;
  };
  return { minX, maxX, minZ, maxZ, segDist, nodeGap, clearOf,
           cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

/*
 * models/kit.js — the shared workshop for the procedural models in
 * static/models/ (landmarks, props, event props, markers).
 *
 * Everything here is built to sit beside the kept GLB sculpts under the HDR
 * renderer: smooth or crease-aware normals, vertex-colour painted albedo that
 * multiplies a small tiling grain texture (stone, marble, plaster, wood,
 * cloth, tile), PBR roughness per material class, and HDR emissive/flame
 * sprites that bloom on their own.
 *
 *   cached(key, make)            memo for geometry / materials / textures
 *   mat.<class>()                shared vertex-colour PBR materials
 *   P (parts list)               P.add(geo, colour, matrix?) … P.mesh(material)
 *   lathe(profile, segs, opts)   surface of revolution, crease rows, flutes
 *   box(w, h, d, bevel)          softly bevelled block (smooth corners)
 *   tube(pts, r0, r1, …)         tapered swept tube (rope, branch, horn, rail)
 *   rockGeometry(seed, opts)     the one rock generator (strata, moss, snow)
 *   flame(opts) / glow(…)        HDR fire tongues + halo; userData.update(t)
 *   animate(obj, fn)             per-frame self-animation via onBeforeRender
 *                                (no scene.js hook needed)
 *
 * Shared GPU resources are flagged userData.shared. scene.js disposes island
 * groups on rebuild; three simply re-uploads a shared buffer the next time it
 * is drawn, so sharing stays safe.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, softDiscTexture } from '../util.js';
import { makeNoise2D, SHORE_LAYER } from '../gfx/terrain.js';

export { THREE, SHORE_LAYER, mulberry32 };

const _cache = new Map();
export function cached(key, make) {
  let v = _cache.get(key);
  if (v === undefined) {
    v = make();
    if (v && typeof v === 'object' && v.userData) v.userData.shared = true;
    _cache.set(key, v);
  }
  return v;
}

export const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ── textures ────────────────────────────────────────────────────────────── */
function canvasTex(key, size, paint, { srgb = true, repeat = true } = {}) {
  return cached('tex:' + key, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    paint(cv.getContext('2d'), size);
    const t = new THREE.CanvasTexture(cv);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  });
}

/* value-noise grain: a near-white field (so vertex colour stays the albedo)
   with soft blotches and fine speckle — the "painted" surface */
function grain(ctx, S, seed, { lo = 0.82, hi = 1.0, blot = 0.5, speck = 0.35, veins = 0 }) {
  const n = makeNoise2D(seed);
  const img = ctx.createImageData(S, S);
  const rng = mulberry32(seed + 1);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // tileable: sample on a torus
      const a = (x / S) * Math.PI * 2, b = (y / S) * Math.PI * 2;
      const u = Math.cos(a) * 1.6, v = Math.sin(a) * 1.6, w = Math.cos(b) * 1.6, z = Math.sin(b) * 1.6;
      let f = n(u + w * 0.7, v + z * 0.7) * 0.5 + n(u * 2.3 + z, v * 2.3 - w) * 0.3
            + n(u * 5.1 - w * 2, z * 5.1 + v) * 0.2;
      f = f * blot + (1 - blot) * 0.5;
      let k = lo + (hi - lo) * (0.5 + (f - 0.5) * 1.6);
      if (veins) {
        const vv = Math.abs(Math.sin((u * 1.3 + w * 0.9 + n(u * 3, w * 3) * 3.2) * 2.2));
        k -= veins * Math.pow(1 - vv, 14);
      }
      k += (rng() - 0.5) * speck * 0.12;
      const c = Math.max(0, Math.min(255, Math.round(k * 255)));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export const tex = {
  stone: () => canvasTex('stone', 256, (c, S) => grain(c, S, 11, { lo: 0.72, hi: 1.0, blot: 0.8, speck: 0.8 })),
  marble: () => canvasTex('marble', 256, (c, S) => grain(c, S, 23, { lo: 0.9, hi: 1.0, blot: 0.6, speck: 0.15, veins: 0.16 })),
  plaster: () => canvasTex('plaster', 128, (c, S) => grain(c, S, 37, { lo: 0.88, hi: 1.0, blot: 0.7, speck: 0.4 })),
  wood: () => canvasTex('wood', 256, (c, S) => {
    const n = makeNoise2D(53);
    const img = c.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const a = (x / S) * Math.PI * 2;
        const g = Math.sin(y / S * Math.PI * 2 * 9 + n(Math.cos(a) * 3, Math.sin(a) * 3 + y / S * 6) * 5);
        const plank = (x % 64) < 2 ? 0.55 : 1;
        const k = (0.78 + 0.12 * g + 0.1 * n(x * 0.05, y * 0.4)) * plank;
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(Math.max(0, Math.min(1, k)) * 255);
        img.data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }),
  cloth: () => canvasTex('cloth', 128, (c, S) => {
    const img = c.createImageData(S, S);
    const rng = mulberry32(71);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const k = 0.86 + 0.06 * Math.sin(x * 1.6) * Math.sin(y * 1.6) + (rng() - 0.5) * 0.06;
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(k * 255);
        img.data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }),
  /* roof tiles: rows of half-round pantiles (u across the roof, v up the slope) */
  tiles: () => canvasTex('tiles', 256, (c, S) => {
    c.fillStyle = '#fff'; c.fillRect(0, 0, S, S);
    const rows = 8, cols = 8;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const x = k * S / cols, y = r * S / rows;
        const g = c.createLinearGradient(x, 0, x + S / cols, 0);
        g.addColorStop(0, 'rgb(150,150,150)'); g.addColorStop(0.5, 'rgb(255,255,255)');
        g.addColorStop(1, 'rgb(120,120,120)');
        c.fillStyle = g; c.fillRect(x, y, S / cols, S / rows);
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x, y + S / rows - 4, S / cols, 4);
      }
    }
  }),
  /* coursed ashlar: block joints in a running bond */
  ashlar: () => canvasTex('ashlar', 256, (c, S) => {
    grain(c, S, 89, { lo: 0.8, hi: 1.0, blot: 0.8, speck: 0.7 });
    c.strokeStyle = 'rgba(60,54,48,0.32)'; c.lineWidth = 3;
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const y = r * S / rows;
      c.beginPath(); c.moveTo(0, y + 1.5); c.lineTo(S, y + 1.5); c.stroke();
      const off = (r % 2) * S / 4;
      for (let k = 0; k < 2; k++) {
        const x = (off + k * S / 2) % S;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + S / rows); c.stroke();
      }
    }
  }),
  /* labyrinth mosaic (the puzzle plaza): a classical seven-course maze */
  maze: () => canvasTex('maze', 512, (c, S) => {
    c.fillStyle = '#d9cfb8'; c.fillRect(0, 0, S, S);
    c.translate(S / 2, S / 2);
    c.strokeStyle = '#3d4a78'; c.lineCap = 'round';
    c.lineWidth = S * 0.026;
    const R0 = S * 0.07, dr = S * 0.055;
    for (let i = 0; i < 7; i++) {
      const r = R0 + i * dr;
      const gap = 0.32 + (i % 2) * 0.18;
      const rot = i * 1.1;
      c.beginPath(); c.arc(0, 0, r, rot + gap, rot + Math.PI * 2 - gap); c.stroke();
      // a radial wall bridging to the next course
      if (i < 6) {
        c.beginPath();
        c.moveTo(Math.cos(rot + gap) * r, Math.sin(rot + gap) * r);
        c.lineTo(Math.cos(rot + gap) * (r + dr), Math.sin(rot + gap) * (r + dr));
        c.stroke();
      }
    }
    c.lineWidth = S * 0.012; c.strokeStyle = '#b08a3a';
    c.beginPath(); c.arc(0, 0, S * 0.47, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(0, 0, S * 0.445, 0, Math.PI * 2); c.stroke();
    // meander key band
    c.lineWidth = S * 0.008; c.strokeStyle = '#3d4a78';
    for (let k = 0; k < 40; k++) {
      const a = k / 40 * Math.PI * 2;
      c.save(); c.rotate(a); c.translate(S * 0.457, 0);
      c.strokeRect(-S * 0.006, -S * 0.012, S * 0.012, S * 0.024);
      c.restore();
    }
  }, { repeat: false }),
  flame: () => canvasTex('flame', 64, (c) => {
    c.clearRect(0, 0, 64, 64);
    c.globalCompositeOperation = 'lighter';
    for (const [y, r, a] of [[48, 16, 0.9], [36, 12, 0.7], [24, 8, 0.55], [14, 5, 0.45]]) {
      const g = c.createRadialGradient(32, y, 0, 32, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    }
  }, { repeat: false }),
  /* vertical light shaft: bright core across, fading at both ends */
  shaft: () => canvasTex('shaft', 64, (c, S) => {
    const img = c.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = Math.abs(x / (S - 1) - 0.5) * 2, v = y / (S - 1);
        const k = Math.pow(1 - u * u, 1.5) * smooth(0, 0.18, v) * (1 - smooth(0.35, 1, v));
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(k * 255);
      }
    }
    c.putImageData(img, 0, 0);
  }, { repeat: false }),
  /* soft ring for UI markers */
  ring: () => canvasTex('ring', 128, (c, S) => {
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.0)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');
    g.addColorStop(0.86, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
  }, { repeat: false }),
};

/* ── materials (vertex colour × grain) ──────────────────────────────────── */
function std(key, opts) {
  return cached('mat:' + key, () => new THREE.MeshStandardMaterial({ vertexColors: true, ...opts }));
}
export const mat = {
  stone: () => std('stone', { map: tex.stone(), roughness: 0.9, metalness: 0 }),
  ashlar: () => std('ashlar', { map: tex.ashlar(), roughness: 0.88, metalness: 0 }),
  marble: () => std('marble', { map: tex.marble(), roughness: 0.5, metalness: 0 }),
  plaster: () => std('plaster', { map: tex.plaster(), roughness: 0.82, metalness: 0 }),
  wood: () => std('wood', { map: tex.wood(), roughness: 0.78, metalness: 0 }),
  cloth: () => std('cloth', { map: tex.cloth(), roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
  tiles: () => std('tiles', { map: tex.tiles(), roughness: 0.7, metalness: 0 }),
  bronze: () => std('bronze', { roughness: 0.38, metalness: 0.85 }),
  gold: () => std('gold', { roughness: 0.28, metalness: 1.0 }),
  wet: () => std('wet', { roughness: 0.35, metalness: 0 }),
  plain: () => std('plain', { roughness: 0.85, metalness: 0 }),
  rock: () => std('rock', { map: tex.stone(), roughness: 0.92, metalness: 0 }),
  /* self-lit HDR colour (blooms when > 1); fogged unless told otherwise */
  glow: (hex, k = 2.5, fog = true) => cached(`glow:${hex}:${k}:${fog}`, () =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), fog })),
  /* a lit surface with an emissive glaze (lantern glass, glyph inlay) */
  lamp: (hex, k = 2.2) => cached(`lamp:${hex}:${k}`, () =>
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.3, metalness: 0,
      emissive: new THREE.Color(hex), emissiveIntensity: k })),
};

/* ── geometry helpers ───────────────────────────────────────────────────── */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3();
export function M(x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(_v.set(x, y, z),
    _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
}

/* paint a geometry's vertex colours: hex, THREE.Color, or fn(x,y,z,nx,ny,nz,c) */
export function paint(geo, col) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const arr = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  if (typeof col === 'function') {
    for (let i = 0; i < p.count; i++) {
      c.setRGB(1, 1, 1);
      col(p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0, c);
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
  } else {
    c.set(col);
    for (let i = 0; i < p.count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/* box-projected UVs (world-ish scale) so a grain map tiles evenly on any part */
export function boxUV(geo, scale = 0.5) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* a parts list: add (geo, colour, matrix) pieces, then one merged mesh per
   material. Geometry passed in is consumed (transformed in place). */
export class Parts {
  constructor() { this.list = []; }
  /* local: paint in the part's own frame (before the matrix) — stripes,
     height bands; otherwise colours see model-space positions */
  add(geo, col = 0xffffff, m = null, uvScale = 0, local = false) {
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (local && col !== null) paint(geo, col);
    if (m) geo.applyMatrix4(m);
    if (uvScale) boxUV(geo, uvScale);
    if (!geo.attributes.uv) boxUV(geo, 0.5);
    if (!local && col !== null) paint(geo, col);
    this.list.push(geo);
    return geo;
  }
  geometry() {
    if (!this.list.length) return null;
    const list = this.list.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(n.attributes)) {
        if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') n.deleteAttribute(k);
      }
      return n;
    });
    const g = mergeGeometries(list, false);
    for (const p of this.list) p.dispose();
    this.list = [];
    g.computeBoundingSphere();
    return g;
  }
  mesh(material, { cast = true, receive = true } = {}) {
    const g = this.geometry();
    if (!g) return null;
    const m = new THREE.Mesh(g, material);
    m.castShadow = cast; m.receiveShadow = receive;
    return m;
  }
}

/* a mesh on a cached geometry (shared between every instance) */
export function sharedMesh(key, makeGeo, material, { cast = true, receive = true } = {}) {
  const g = cached('geo:' + key, () => { const gg = makeGeo(); gg.userData.shared = true; return gg; });
  const m = new THREE.Mesh(g, material);
  m.castShadow = cast; m.receiveShadow = receive;
  return m;
}

/* Surface of revolution about +Y. profile rows [r, y] (y ascending); repeat a
   row to split the shading into a crisp crease (cornice edges, steps).
   opts.flutes: n concave flutes cut into rows whose y is in [f0, f1]. */
export function lathe(profile, segs = 24, { flutes = 0, depth = 0.08, f0 = -1e9, f1 = 1e9, phase = 0,
  cap = false, closeTop = false } = {}) {
  const rows = profile.length;
  const W = segs + 1;
  const pos = new Float32Array(rows * W * 3);
  const uv = new Float32Array(rows * W * 2);
  let vacc = 0;
  for (let j = 0; j < rows; j++) {
    const [r, y] = profile[j];
    if (j > 0) vacc += Math.hypot(r - profile[j - 1][0], y - profile[j - 1][1]);
    const fl = flutes && y >= f0 - 1e-6 && y <= f1 + 1e-6;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2 + phase;
      let rr = r;
      if (fl) {
        const k = Math.abs(Math.sin((i / segs) * Math.PI * flutes));
        rr = r * (1 - depth * Math.pow(k, 0.6));
      }
      const o = (j * W + i) * 3;
      pos[o] = Math.cos(a) * rr; pos[o + 1] = y; pos[o + 2] = Math.sin(a) * rr;
      uv[(j * W + i) * 2] = (i / segs) * 4; uv[(j * W + i) * 2 + 1] = vacc;
    }
  }
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    const same = profile[j][0] === profile[j + 1][0] && profile[j][1] === profile[j + 1][1];
    if (same) continue;                         // crease: no faces across a repeated row
    for (let i = 0; i < segs; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam column's normals
  const n = g.attributes.normal;
  for (let j = 0; j < rows; j++) {
    const a = j * W, b = a + segs;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  // rows with r = 0 (poles) get straight up/down normals
  for (let j = 0; j < rows; j++) {
    if (profile[j][0] > 1e-5) continue;
    const up = j === rows - 1 ? 1 : -1;
    for (let i = 0; i <= segs; i++) n.setXYZ(j * W + i, 0, up, 0);
  }
  return g;
}

/* a block with softly rounded edges (bevel b): reads as cut stone, not a
   debug cube. Flat faces, smooth quarter-round edges and corners.
   seg = bevel rings (1 → 108 triangles, 2 → 300). */
export function box(w, h, d, b = 0.06, seg = 1) {
  // a bevel under ~3 cm is invisible at board distance: a plain 12-triangle
  // box is enough (small trim, windows, slats, studs)
  const bb = b < 0.03 ? 0 : Math.min(b, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  if (bb <= 1e-3) { const g0 = new THREE.BoxGeometry(w, h, d); g0.deleteAttribute('uv'); return g0; }
  const N = 2 * seg + 1;
  const g = new THREE.BoxGeometry(1, 1, 1, N, N, N);
  const p = g.attributes.position;
  const nrm = g.attributes.normal;
  const half = [w / 2 - bb, h / 2 - bb, d / 2 - bb];
  const c = [0, 0, 0], o = [0, 0, 0];
  for (let i = 0; i < p.count; i++) {
    c[0] = p.getX(i); c[1] = p.getY(i); c[2] = p.getZ(i);
    for (let k = 0; k < 3; k++) {
      const t = c[k] * N, a = Math.abs(t), sg = Math.sign(t) || 1;
      if (a <= 0.5 + 1e-6) { o[k] = 0; c[k] = (t / 0.5) * half[k]; }
      else { o[k] = sg * Math.min(1, (a - 0.5) / seg); c[k] = sg * half[k]; }
    }
    const l = Math.hypot(o[0], o[1], o[2]) || 1;
    const nx = o[0] / l, ny = o[1] / l, nz = o[2] / l;
    p.setXYZ(i, c[0] + nx * bb, c[1] + ny * bb, c[2] + nz * bb);
    nrm.setXYZ(i, nx, ny, nz);
  }
  g.deleteAttribute('uv');          // Parts.add box-projects at model scale
  return g;
}

/* tapered swept tube through points (rope, rails, branches, horns) */
export function tube(pts, r0, r1 = r0, segs = 8, radial = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(pts, closed);
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, closed);
  const p = g.attributes.position;
  const cp = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(Math.min(1, i / segs), cp);
    const rr = r0 + (r1 - r0) * (i / segs);
    for (let j = 0; j <= radial; j++) {
      const o = i * (radial + 1) + j;
      p.setXYZ(o, cp.x + (p.getX(o) - cp.x) * rr, cp.y + (p.getY(o) - cp.y) * rr, cp.z + (p.getZ(o) - cp.z) * rr);
    }
  }
  g.computeVertexNormals();
  const n = g.attributes.normal;
  for (let i = 0; i <= segs; i++) {
    const a = i * (radial + 1), b = a + radial;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/* flat-shaded copy (faceted dais, square tiers, gems) */
export function facet(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/* a smooth closed blob (fruit, sack, bun of foliage) */
export function blob(r, detail = 1, sy = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  const m = mergeVertices(g, 1e-5);
  m.scale(1, sy, 1);
  m.computeVertexNormals();
  return m;
}

/* ── the rock generator ─────────────────────────────────────────────────────
 * One generator for every boulder, sea stack, outcrop and ruin rubble: an
 * icosphere pushed by 3D value noise, flattened against a few fracture planes
 * (so it reads as broken stone, not a potato), squashed onto a base, then
 * painted: darker crevices, horizontal STRATA bands, a sun-bleached top, and
 * optionally moss / snow / lichen on the up-facing surfaces.
 *   opts: r, sy (height ratio), detail (1–3), facets, rough,
 *         rock (hex), top (hex|null), cover 0..1 (moss/snow amount),
 *         strata 0..1, base (−1..0: how far below its centre it is cut flat) */
const _rockBase = new Map();
export function rockGeometry(seed, { r = 1, sy = 0.7, detail = 2, facets = 6, rough = 0.16,
  rock = 0x8f8b84, top = null, cover = 0, strata = 0.5, base = -0.35 } = {}) {
  let src = _rockBase.get(detail);
  if (!src) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    src = mergeVertices(g, 1e-5);
    _rockBase.set(detail, src);
  }
  const rng = mulberry32(seed >>> 0);
  const n2 = makeNoise2D((seed * 2654435761) >>> 0);
  const n3 = (x, y, z) => (n2(x + 17, y * 1.3 + z * 0.7) + n2(y - 9, z * 1.3 + x * 0.7)
                           + n2(z + 31, x * 1.3 + y * 0.7)) / 3;
  const planes = [];
  for (let k = 0; k < facets; k++) {
    const a = rng() * Math.PI * 2, e = k === 0 ? 1.2 + rng() * 0.3 : (rng() - 0.3) * 1.1;
    planes.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.62 + rng() * 0.3]);
  }
  const g = src.clone();
  const p = g.attributes.position;
  const sx = 0.85 + rng() * 0.3, sz = 0.85 + rng() * 0.3;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let k = 1;
    for (const pl of planes) {
      const d = x * pl[0] + y * pl[1] + z * pl[2];
      if (d > 0.05) k = Math.min(k, pl[3] / d + (1 - pl[3] / d) * 0.06);
    }
    k *= 1 + rough * (n3(x * 1.8, y * 1.8, z * 1.8) - 0.5) * 2
           + rough * 0.35 * (n3(x * 4.6 + 3, y * 4.6, z * 4.6) - 0.5) * 2;
    const yy = Math.max(base, y * k);
    p.setXYZ(i, x * k * r * sx, yy * r * sy, z * k * r * sz);
  }
  g.computeVertexNormals();
  // paint
  const nrm = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  const cR = new THREE.Color(rock), cD = cR.clone().multiplyScalar(0.5), cL = cR.clone().lerp(new THREE.Color(0xf2ece0), 0.28);
  const cT = top != null ? new THREE.Color(top) : null;
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ny = nrm.getY(i);
    const f = n3(x * 1.1 / r, y * 1.1 / r, z * 1.1 / r);
    const band = 0.5 + 0.5 * Math.sin((y / r) * 9 + f * 6);
    c.copy(cD).lerp(cR, 0.35 + f * 0.65);
    c.multiplyScalar(1 - strata * 0.16 + strata * band * 0.22);
    c.lerp(cL, smooth(0.2, 0.9, ny) * 0.5);                          // sun-bleached top
    c.multiplyScalar(0.72 + 0.28 * smooth(base * r * sy, base * r * sy + 0.35 * r, y));   // damp foot
    if (cT && cover > 0) c.lerp(cT, smooth(0.45, 0.85, ny + (f - 0.5) * 0.6) * cover);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  boxUV(g, 0.9 / Math.max(0.3, r));
  return g;
}

/* ── fire and glow ──────────────────────────────────────────────────────── */
/* HDR flame: stacked additive tongues + halo, flickering. Returns a Group
   with userData.update(t). `color` tints it (realm accents for gates). */
export function flame({ w = 0.6, h = 1.0, color = 0xff9a3d, glow = 1, seed = 1, halo = 0.45, fog = true } = {}) {
  const g = new THREE.Group();
  const base = new THREE.Color(color);
  const rng = mulberry32(seed);
  const tongues = [];
  // outer body → hot core: colour shifts toward white in the core
  const layers = [[1.0, 1.0, 1.6, 0.85], [0.72, 0.82, 2.6, 0.9], [0.42, 0.55, 4.2, 0.95]];
  layers.forEach(([kw, kh, gain, op], i) => {
    const c = base.clone().lerp(new THREE.Color(1, 0.95, 0.8), i * 0.3).multiplyScalar(gain * glow);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.flame(), color: c, transparent: true,
      opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog }));
    sp.center.set(0.5, 0.12);
    sp.scale.set(w * kw, h * kh, 1);
    g.add(sp);
    tongues.push({ sp, w: w * kw, h: h * kh, ph: rng() * 6.283 });
  });
  const hs = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDiscTexture(),
    color: base.clone().multiplyScalar(0.9 * glow), transparent: true, opacity: halo,
    blending: THREE.AdditiveBlending, depthWrite: false, fog }));
  hs.scale.setScalar(w * 3.4);
  hs.position.y = h * 0.3;
  g.add(hs);
  g.userData.update = (t) => {
    for (const f of tongues) {
      const k = 0.86 + Math.sin(t * 8.7 + f.ph) * 0.1 + Math.sin(t * 21 + f.ph * 2.3) * 0.06;
      f.sp.scale.set(f.w * (1.04 - (k - 0.86) * 0.8), f.h * k, 1);
      f.sp.position.x = Math.sin(t * 6.1 + f.ph) * f.w * 0.06;
    }
    hs.material.opacity = halo * (0.9 + Math.sin(t * 12.3 + seed) * 0.12);
  };
  animate(g, g.userData.update);
  return g;
}

export function glowSprite(hex, scale = 3, opacity = 0.5, fog = true) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDiscTexture(),
    color: new THREE.Color(hex), transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, fog }));
  sp.scale.set(scale, scale, 1);
  return sp;
}

/* Self-animation without a scene.js hook: the first renderable child gets an
   onBeforeRender that runs fn(t) at most once per frame. The change lands on
   the next frame's matrices — invisible at 60 fps. */
let _frameT = 0, _frameId = -1;
const now = () => performance.now() / 1000;
export function animate(obj, fn) {
  let host = null;
  obj.traverse((o) => { if (!host && (o.isMesh || o.isSprite || o.isPoints)) host = o; });
  if (!host) {
    // nothing renderable yet: a tiny invisible sprite carries the callback
    host = new THREE.Sprite(cached('mat:inv', () => new THREE.SpriteMaterial({ opacity: 0, transparent: true, depthWrite: false })));
    host.scale.setScalar(0.001);
    obj.add(host);
  }
  let last = -1;
  const prev = host.onBeforeRender;
  host.onBeforeRender = function (renderer, ...rest) {
    const id = renderer.info.render.frame;
    if (id !== last) { last = id; if (id !== _frameId) { _frameId = id; _frameT = now(); } fn(_frameT); }
    if (prev) prev.call(this, renderer, ...rest);
  };
  host.frustumCulled = false;
  return obj;
}

/* place a mesh on the shore layer so the ocean paints shallows + surf round it */
export function onShore(o) {
  o.traverse((m) => { if (m.isMesh) m.layers.enable(SHORE_LAYER); });
  return o;
}

/* count triangles + draw calls of a built model (modeltest + docs) */
export function stats(root) {
  let tris = 0, calls = 0;
  root.traverse((o) => {
    if (!o.visible) return;
    if (o.isMesh) {
      calls++;
      const g = o.geometry;
      const n = g.index ? g.index.count : g.attributes.position.count;
      tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
    } else if (o.isSprite) calls++;
  });
  return { tris: Math.round(tris), calls };
}

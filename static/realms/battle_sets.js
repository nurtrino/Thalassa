/*
 * realms/battle_sets.js — the battle dioramas: one composed SET per stage.
 *
 * battle.js frames every fight from a fixed over-the-shoulder camera at about
 * (-17, 5, 7) looking down +x (and a little toward -z): the hero stands at
 * x = -9, the enemy line at x = 6…11. Each set is built for that one view:
 *
 *   · an ARENA FLOOR the creatures read against — never their own colour:
 *     wet sandbar (hub), blue pack ice (ice), slate flagstones (desert), pale
 *     river silt (jungle), a straw-gold clearing (autumn), fire-glossed
 *     paving on top of the lighthouse (pharos)
 *   · a mid-ground LANDMARK straight behind the enemy line
 *   · flanking masses and a foreground framing piece at the right edge
 *   · depth to the horizon: far islets / dunes / trees, then a hazed range
 *
 * Water arenas float on the real ocean (battle.js lays gfx/ocean.js under the
 * set): everything solid that stands in the water is on SHORE_LAYER so the
 * baked shore map gives it shallows and surf. Land creatures get an emergent
 * shoal to stand on; packs that swim or sail (opts.afloat) get the same shoal
 * sunk into turquoise shallows instead.
 *
 *   buildBattleSet(theme, opts, kit) → Group
 *     opts.afloat           enemies are water-borne
 *     kit.structure(id, o)  islands.js's landmark-GLB mounter
 *     group.userData.update(t)   per-frame animation (fire, embers, leaves)
 *     group.userData.shore       {x, z, size} to bake for the ocean, or null
 *
 * Shared GPU resources (GLB clones, cached textures) are flagged
 * userData.keep / userData.shared so battle.js does not dispose them.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hashStr, mulberry32, softDiscTexture } from '../util.js';
import { propGroup } from '../props.js';
import { makeTerrain, makeNoise2D, makeGroundMaterial, SHORE_LAYER, GROUND_TILE } from '../gfx/terrain.js';
import { makeRidge } from '../gfx/mountains.js';

const SEA = -0.3;
const CAM_X = -17, CAM_Z = 7;                 // the pack camera, on the ground plane
const FX = 0.923, FZ = -0.384;                // its view axis

const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/* a point `d` units down the camera's view axis and `s` units to screen-right */
const P = (d, s = 0) => [CAM_X + FX * d - FZ * s, CAM_Z + FZ * d + FX * s];

const _c1 = new THREE.Color(), _c2 = new THREE.Color();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();

function fbm2(seed) {
  const n = makeNoise2D(seed >>> 0);
  return (x, z) => (n(x, z) + 0.5 * n(x * 2.13 + 37.7, z * 2.13 - 19.1)
                    + 0.25 * n(x * 4.31 - 53.3, z * 4.31 + 11.9)) / 1.75;
}

const keep = (o) => { o.userData.keep = true; return o; };

/* ── heightfield patch: analytic normals, vertex colour, world-planar uv ─── */
function heightfield({ cx = 0, cz = 0, hx, hz, nx, nz, warp = 0, height, paint, material, mask = null }) {
  const W = nx + 1, H = nz + 1;
  const pos = [], nor = [], col = [], uv = [];
  const remap = new Int32Array(W * H).fill(-1);
  const axis = (k, n, half) => {
    const u = (k / n) * 2 - 1;
    return half * ((1 - warp) * u + warp * u * u * u);
  };
  const c = new THREE.Color();
  let count = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = cx + axis(i, nx, hx), z = cz + axis(j, nz, hz);
      if (mask && !mask(x, z)) continue;
      const y = height(x, z);
      const e = 0.3;
      const gx = (height(x - e, z) - height(x + e, z)) / (2 * e);
      const gz = (height(x, z - e) - height(x, z + e)) / (2 * e);
      const inv = 1 / Math.hypot(gx, 1, gz);
      paint(x, z, y, inv, c);
      remap[j * W + i] = count++;
      pos.push(x, y, z); nor.push(gx * inv, inv, gz * inv); col.push(c.r, c.g, c.b);
      uv.push(x / GROUND_TILE, z / GROUND_TILE);
    }
  }
  const idx = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = remap[j * W + i], b = remap[j * W + i + 1];
      const d = remap[(j + 1) * W + i], e = remap[(j + 1) * W + i + 1];
      if (a < 0 || b < 0 || d < 0 || e < 0) continue;
      idx.push(a, d, e, a, e, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  if (!material) return geo;
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

/* ── the shoal under the enemy line (water arenas) ───────────────────────── */
function makeShoal({ cx, cz, rx, rz, top, seed, dry, wet, accent = null }) {
  const f = fbm2(seed);
  const coast = Math.min(SEA + 0.05, top - 0.3);
  const rrOf = (x, z) => {
    const dx = (x - cx) / rx, dz = (z - cz) / rz;
    const a = Math.atan2(dz, dx);
    return Math.hypot(dx, dz) / (0.86 + 0.34 * f(Math.cos(a) * 1.6 + 9.1, Math.sin(a) * 1.6 - 4.3));
  };
  const height = (x, z) => {
    const rr = rrOf(x, z);
    if (rr <= 1) {
      return top + (coast - top) * smooth(0.66, 1, rr)
        + (f(x * 0.45, z * 0.45) - 0.5) * 0.07 * (1 - smooth(0.5, 1, rr));
    }
    const s1 = smooth(1, 1.5, rr), s2 = smooth(1.3, 2.05, rr);
    return coast - 2.3 * s1 - 20 * s2 * s2;
  };
  const cDry = new THREE.Color(dry), cWet = new THREE.Color(wet);
  const cAcc = accent ? new THREE.Color(accent) : null;
  const cDeep = cWet.clone().multiplyScalar(0.45);
  const mesh = heightfield({
    cx, cz, hx: rx * 2.15, hz: rz * 2.15,
    nx: Math.round(rx * 4.3 / 0.9), nz: Math.round(rz * 4.3 / 0.9),
    height,
    mask: (x, z) => rrOf(x, z) < 2.2,
    paint: (x, z, y, ny, c) => {
      const n = f(x * 0.3 + 4, z * 0.3 - 7);
      // dry and pale where the creatures stand, dark and wet toward the surf
      c.copy(cWet).lerp(cDry, smooth(0.95, 0.5, rrOf(x, z)) * (0.6 + n * 0.5));
      if (cAcc) c.lerp(cAcc, smooth(0.52, 0.72, f(x * 0.21 - 11, z * 0.21 + 5)) * smooth(0.45, 0.95, rrOf(x, z)) * 0.8);
      c.multiplyScalar(0.9 + n * 0.2);
      if (y < SEA - 0.4) c.lerp(cDeep, smooth(SEA - 0.4, SEA - 5, y));
    },
    // matte on purpose: the stock tide gloss turns a bar this low into a mirror
    material: makeGroundMaterial({ tide: false, bump: 0.9 }),
  });
  mesh.layers.enable(SHORE_LAYER);
  mesh.name = 'arena';
  return mesh;
}

/* ── rocks and bergs: welded icospheres, noise-worn or plane-cut ─────────── */
const _lumpBase = new Map();
function lumpBase(detail) {
  let g = _lumpBase.get(detail);
  if (g) return g;
  g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g, 1e-4);
  _lumpBase.set(detail, g);
  return g;
}

/* specs: {x, y, z, sx, sy, sz, ry, seed, detail, facets, rough, base}
   paint(pos, normal, out, spec) colours each vertex once normals are known */
function lumps(specs, paint, material) {
  const pos = [], idx = [], owner = [];
  for (const sp of specs) {
    const src = lumpBase(sp.detail ?? 4);
    const rng = mulberry32(sp.seed ?? 1);
    const n = makeNoise2D(((sp.seed ?? 1) * 2654435761) >>> 0);
    const n3 = (x, y, z) => (n(x + 17, y * 1.3 + z * 0.7) + n(y - 9, z * 1.3 + x * 0.7)
                             + n(z + 31, x * 1.3 + y * 0.7)) / 3;
    const planes = [];
    for (let k = 0; k < (sp.facets ?? 0); k++) {
      const a = rng() * 6.283, e = (rng() - 0.25) * 1.5;
      planes.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.6 + rng() * 0.4]);
    }
    const rough = sp.rough ?? 0.3, base = sp.base ?? -0.45;
    const sp0 = src.attributes.position, off = pos.length / 3;
    const cy = Math.cos(sp.ry ?? 0), sy = Math.sin(sp.ry ?? 0);
    for (let i = 0; i < sp0.count; i++) {
      const x = sp0.getX(i), y = sp0.getY(i), z = sp0.getZ(i);
      let r = 1;
      for (const pl of planes) {
        const d = x * pl[0] + y * pl[1] + z * pl[2];
        if (d > 0.05) r = Math.min(r, pl[3] / d);
      }
      r *= 1 + rough * (n3(x * 1.7, y * 1.7, z * 1.7) - 0.5) * 2
             + rough * 0.4 * (n3(x * 4.3 + 5, y * 4.3, z * 4.3) - 0.5) * 2;
      const lx = x * r * (sp.sx ?? 1), ly = Math.max(base, y * r) * (sp.sy ?? 1), lz = z * r * (sp.sz ?? 1);
      pos.push(sp.x + lx * cy + lz * sy, (sp.y ?? 0) + ly, sp.z - lx * sy + lz * cy);
      owner.push(sp);
    }
    const si = src.index;
    for (let i = 0; i < si.count; i++) idx.push(off + si.getX(i));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const nor = geo.attributes.normal;
  const col = new Float32Array(pos.length), uv = new Float32Array(pos.length / 3 * 2);
  const c = new THREE.Color();
  for (let i = 0; i < pos.length / 3; i++) {
    _v1.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    _v2.fromBufferAttribute(nor, i);
    paint(_v1, _v2, c, owner[i]);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    uv[i * 2] = (_v1.x + _v1.y * 0.5) / GROUND_TILE * 2;
    uv[i * 2 + 1] = (_v1.z + _v1.y * 0.5) / GROUND_TILE * 2;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/* weathered stone: pale and sun-bleached (or mossy / snowy) on top */
function rockPaint(seed, rockHex, topHex, topK = 0.6) {
  const f = fbm2(seed);
  const rock = new THREE.Color(rockHex), dark = rock.clone().multiplyScalar(0.55);
  const top = new THREE.Color(topHex);
  return (p, n, c) => {
    const g = f(p.x * 0.35 + p.y * 0.2, p.z * 0.35 - p.y * 0.2);
    const strata = 0.5 + 0.5 * Math.sin(p.y * 2.6 + g * 7);
    c.copy(dark).lerp(rock, 0.3 + g * 0.7).multiplyScalar(0.88 + strata * 0.2);
    c.lerp(top, smooth(0.5, 0.86, n.y + (g - 0.5) * 0.3) * topK);
  };
}

/* shallows where nothing shows above the water: shore-map only, never drawn */
function shelfMesh(spots) {
  const geos = spots.map(([x, z, r, topY = SEA - 0.2]) => {
    const g = new THREE.ConeGeometry(r, 9, 20, 1, true);
    g.translate(x, topY - 4.5, z);
    return g;
  });
  const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial());
  m.layers.set(SHORE_LAYER);
  return m;
}

/* ── canvas textures ─────────────────────────────────────────────────────── */
const _tex = new Map();
function cached(key, make) {
  let t = _tex.get(key);
  if (!t) { t = make(); t.userData.shared = true; _tex.set(key, t); }
  return t;
}
function canvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return [cv, cv.getContext('2d')];
}

/* running-bond flagstones: worn slabs, dark joints, the odd crack */
const SLAB_ROWS = 6;
function slabRow(r) {                       // slab edges across one tile, 0..1
  const rng = mulberry32(977 + r * 131);
  const cuts = [rng() * 0.2];
  while (cuts[cuts.length - 1] < 1) cuts.push(cuts[cuts.length - 1] + 0.2 + rng() * 0.2);
  return cuts;
}
function flagstoneTexture() {
  return cached('flag', () => {
    const S = 512, [cv, ctx] = canvas(S, S);
    const rng = mulberry32(4411);
    ctx.fillStyle = '#3c3a38'; ctx.fillRect(0, 0, S, S);
    const rh = S / SLAB_ROWS;
    for (let r = 0; r < SLAB_ROWS; r++) {
      const cuts = slabRow(r);
      for (let k = 0; k < cuts.length - 1; k++) {
        const x0 = cuts[k] * S, x1 = cuts[k + 1] * S, y0 = r * rh;
        const v = 168 + Math.floor(rng() * 70);
        for (const ox of [0, -S]) {
          ctx.fillStyle = `rgb(${v},${v - 3},${v - 8})`;
          ctx.fillRect(x0 + ox + 3, y0 + 3, x1 - x0 - 6, rh - 6);
          ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x0 + ox + 3, y0 + 3, x1 - x0 - 6, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(x0 + ox + 3, y0 + rh - 7, x1 - x0 - 6, 4);
        }
        if (rng() < 0.35) {
          ctx.strokeStyle = 'rgba(30,26,24,0.55)'; ctx.lineWidth = 1.5;
          ctx.beginPath();
          let x = x0 + (x1 - x0) * rng(), y = y0 + 4;
          ctx.moveTo(x, y);
          while (y < y0 + rh - 6) { x += (rng() - 0.5) * 16; y += 6 + rng() * 10; ctx.lineTo(x, y); }
          ctx.stroke();
        }
      }
    }
    for (let i = 0; i < 2600; i++) {                     // pitting
      const v = rng() < 0.5 ? 40 : 255;
      ctx.fillStyle = `rgba(${v},${v},${v},${0.04 + rng() * 0.07})`;
      ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 3, 1 + rng() * 3);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/* which slabs of a half-buried court survive: an alpha mask in the slab grid */
function courtMask(R, tile, seed) {
  const S = 512, [cv, ctx] = canvas(S, S);
  const rng = mulberry32(seed);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  const rh = tile / SLAB_ROWS, px = S / (2 * R);
  for (let row = Math.floor(-R / rh); row <= Math.ceil(R / rh); row++) {
    // the map's canvas rows run top-down while v runs up, hence the mirrored row
    const cuts = slabRow((((5 - row) % SLAB_ROWS) + SLAB_ROWS) % SLAB_ROWS);
    for (let t = Math.floor(-R / tile) - 1; t <= Math.ceil(R / tile); t++) {
      for (let k = 0; k < cuts.length - 1; k++) {
        const x0 = (t + cuts[k]) * tile, x1 = (t + cuts[k + 1]) * tile, z0 = row * rh;
        const d = Math.hypot((x0 + x1) / 2, z0 + rh / 2) / R;
        if (d > 0.62 + rng() * 0.36) continue;
        ctx.fillRect((x0 + R) * px, (z0 + R) * px, (x1 - x0) * px, rh * px);
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.channel = 1;
  return t;
}

/* the lighthouse roof: rings of wedge slabs round an inlaid star */
function terraceTexture() {
  return cached('terrace', () => {
    const S = 1024, [cv, ctx] = canvas(S, S);
    const rng = mulberry32(1777);
    ctx.fillStyle = '#26242a'; ctx.fillRect(0, 0, S, S);
    const C = S / 2, rings = [0.10, 0.20, 0.31, 0.43, 0.56, 0.70, 0.84, 1.0];
    for (let r = 0; r < rings.length - 1; r++) {
      const r0 = rings[r] * C, r1 = rings[r + 1] * C;
      const n = Math.round(8 + r * 6.5), a0 = rng() * 6.283;
      for (let k = 0; k < n; k++) {
        const v = 132 + Math.floor(rng() * 84) - (r === rings.length - 2 ? 34 : 0);
        ctx.fillStyle = `rgb(${v},${v - 2},${v + 5})`;
        const pad = 2.6 / ((r0 + r1) / 2);
        ctx.beginPath();
        ctx.arc(C, C, r1 - 2.5, a0 + (k / n) * 6.283 + pad, a0 + ((k + 1) / n) * 6.283 - pad);
        ctx.arc(C, C, r0 + 2.5, a0 + ((k + 1) / n) * 6.283 - pad, a0 + (k / n) * 6.283 + pad, true);
        ctx.closePath(); ctx.fill();
      }
    }
    // the star at the heart: ember-red points on dark bronze
    ctx.fillStyle = '#5a4630'; ctx.beginPath(); ctx.arc(C, C, rings[0] * C - 3, 0, 6.3); ctx.fill();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 6.283;
      ctx.fillStyle = k % 2 ? '#8a2f1c' : '#c08a3c';
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a) * rings[1] * C * (k % 2 ? 0.78 : 0.98), C + Math.sin(a) * rings[1] * C * (k % 2 ? 0.78 : 0.98));
      ctx.lineTo(C + Math.cos(a + 0.3) * rings[0] * C * 0.5, C + Math.sin(a + 0.3) * rings[0] * C * 0.5);
      ctx.lineTo(C + Math.cos(a - 0.3) * rings[0] * C * 0.5, C + Math.sin(a - 0.3) * rings[0] * C * 0.5);
      ctx.closePath(); ctx.fill();
    }
    for (let i = 0; i < 7000; i++) {
      const v = rng() < 0.55 ? 20 : 255;
      ctx.fillStyle = `rgba(${v},${v},${v},${0.03 + rng() * 0.06})`;
      ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 3, 1 + rng() * 3);
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/* bare glacier ice: pressure cracks and frost veins */
function iceTexture() {
  return cached('ice', () => {
    const S = 512, [cv, ctx] = canvas(S, S);
    const rng = mulberry32(8080);
    ctx.fillStyle = '#e6eef2'; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 60; i++) {
      const x = rng() * S, y = rng() * S, r = 20 + rng() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rng() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(150,185,205,0.30)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
    }
    for (let i = 0; i < 26; i++) {
      const x = rng() * S, y = rng() * S, a = rng() * 6.283;
      const deep = rng() < 0.5;
      ctx.strokeStyle = deep ? 'rgba(60,110,150,0.55)' : 'rgba(255,255,255,0.7)';
      ctx.lineWidth = deep ? 1.6 + rng() * 1.6 : 1;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const r2 = mulberry32(i * 77 + 5);
        let xx = x, yy = y, aa = a;
        ctx.beginPath(); ctx.moveTo(xx + ox, yy + oy);
        for (let k = 0; k < 14; k++) {
          aa += (r2() - 0.5) * 0.9; xx += Math.cos(aa) * 18; yy += Math.sin(aa) * 18;
          ctx.lineTo(xx + ox, yy + oy);
        }
        ctx.stroke();
      }
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/* a soft teardrop for flames; a tall soft streak for light shafts */
function flameTexture() {
  return cached('flame', () => {
    const [cv, ctx] = canvas(64, 128);
    ctx.globalCompositeOperation = 'lighter';
    for (const [y, r, a] of [[96, 30, 0.9], [70, 24, 0.75], [46, 17, 0.6], [26, 10, 0.5]]) {
      const g = ctx.createRadialGradient(32, y, 0, 32, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 128);
    }
    return new THREE.CanvasTexture(cv);
  });
}
function shaftTexture() {
  return cached('shaft', () => {
    const [cv, ctx] = canvas(64, 256);
    const g = ctx.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 256);
    ctx.globalCompositeOperation = 'destination-in';
    const v = ctx.createLinearGradient(0, 0, 0, 256);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(0.25, 'rgba(0,0,0,1)');
    v.addColorStop(0.7, 'rgba(0,0,0,0.8)'); v.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, 64, 256);
    return new THREE.CanvasTexture(cv);
  });
}

/* ── fire: stacked camera-facing tongues in HDR, so the pipeline blooms it ─ */
function makeFire(anims, { x, y, z, w, h, seed = 1, glow = 1 }) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const rng = mulberry32(seed);
  const tongues = [];
  const layers = [[1.0, 1.0, 1.5, 0.30, 0.05, 0.85], [0.7, 0.8, 3.0, 1.15, 0.2, 0.9],
                  [0.42, 0.56, 5.2, 3.4, 1.25, 0.95], [0.5, 1.25, 1.2, 0.2, 0.03, 0.5]];
  for (const [kw, kh, r, gg, b, op] of layers) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flameTexture(), color: new THREE.Color(r * glow, gg * glow, b * glow), transparent: true,
      opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    sp.center.set(0.5, 0.16);
    sp.scale.set(w * kw, h * kh, 1);
    g.add(sp);
    tongues.push({ sp, w: w * kw, h: h * kh, ph: rng() * 6.283, x0: 0 });
  }
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: new THREE.Color(1.1 * glow, 0.36 * glow, 0.08 * glow),
    transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  halo.scale.set(w * 3.4, w * 3.4, 1);
  halo.position.y = h * 0.3;
  g.add(halo);
  anims.push((t) => {
    for (const f of tongues) {
      const k = 0.86 + Math.sin(t * 8.7 + f.ph) * 0.1 + Math.sin(t * 21 + f.ph * 2.3) * 0.06;
      f.sp.scale.set(f.w * (1.04 - (k - 0.86) * 0.8), f.h * k, 1);
      f.sp.position.x = Math.sin(t * 6.1 + f.ph) * f.w * 0.07;
    }
    halo.material.opacity = 0.44 + Math.sin(t * 12.3) * 0.07;
  });
  return g;
}

/* drifting sparks / leaves: one Points cloud cycled in place */
function makeDrift(anims, { n, box, origin, rise, sway, size, color, map = null, additive = true, seed = 3 }) {
  const rng = mulberry32(seed);
  const base = new Float32Array(n * 4), arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    base[i * 4] = (rng() - 0.5) * box[0]; base[i * 4 + 1] = rng();
    base[i * 4 + 2] = (rng() - 0.5) * box[2]; base[i * 4 + 3] = rng() * 6.283;
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(arr, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size, color, map: map || softDiscTexture(), transparent: true, opacity: 0.95, depthWrite: false,
    sizeAttenuation: true, fog: !additive,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
  pts.frustumCulled = false;
  anims.push((t) => {
    for (let i = 0; i < n; i++) {
      const ph = base[i * 4 + 3];
      let k = (base[i * 4 + 1] + t * rise * (0.6 + (ph % 1) * 0.8) / box[1]) % 1;
      if (k < 0) k += 1;
      const spread = rise > 0 ? 0.25 + k : 1;
      arr[i * 3] = origin[0] + base[i * 4] * spread + Math.sin(t * 0.9 + ph) * sway;
      arr[i * 3 + 1] = origin[1] + k * box[1];
      arr[i * 3 + 2] = origin[2] + base[i * 4 + 2] * spread + Math.cos(t * 0.7 + ph * 1.7) * sway;
    }
    attr.needsUpdate = true;
  });
  return pts;
}

/* ── a broad-leafed tree in autumn colour (the Vale's own; 3 cached shapes) ─ */
const _treeGeo = new Map();
function autumnTreeGeometry(variant) {
  let geo = _treeGeo.get(variant);
  if (geo) return geo;
  const rng = mulberry32(5150 + variant * 97);
  const parts = [];
  const tint = (g, fn) => {
    const p = g.attributes.position, n = g.attributes.normal;
    const col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      fn(_v1.fromBufferAttribute(p, i), _v2.fromBufferAttribute(n, i), c);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.count * 2), 2));
    return g;
  };
  // trunk and two boughs: tapered tubes, flared at the root
  const bark = new THREE.Color(0x3d2a20), barkLit = new THREE.Color(0x6a4a34);
  const lean = (rng() - 0.5) * 0.5;
  const limb = (pts, r0, r1, flare) => {
    const curve = new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q)));
    const g = new THREE.TubeGeometry(curve, 10, 1, 7, false);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = Math.floor(i / 8) / 10;
      curve.getPointAt(k, _v1);
      const r = (r0 + (r1 - r0) * k) * (1 + flare * Math.pow(1 - k, 6) * 1.6);
      _v2.fromBufferAttribute(p, i).sub(_v1).multiplyScalar(r).add(_v1);
      p.setXYZ(i, _v2.x, _v2.y, _v2.z);
    }
    g.computeVertexNormals();
    return tint(g, (pp, nn, c) => c.copy(bark).lerp(barkLit, 0.25 + 0.5 * Math.max(0, nn.x * 0.6 + nn.y * 0.4 + 0.3)));
  };
  parts.push(limb([[0, -0.3, 0], [lean * 0.3, 1.2, 0.05], [lean * 0.8, 2.5, 0], [lean, 3.6, -0.1]], 0.3, 0.16, 1));
  parts.push(limb([[lean * 0.6, 2.0, 0], [lean + 0.7, 2.9, 0.4], [lean + 1.3, 3.6, 0.6]], 0.14, 0.06, 0));
  parts.push(limb([[lean * 0.7, 2.3, 0], [lean - 0.6, 3.1, -0.5], [lean - 1.2, 3.9, -0.7]], 0.13, 0.06, 0));
  // the crown: overlapping leaf masses, each its own hue, lit from above
  const HUES = [0xd9862a, 0xc2512a, 0xe9b23c, 0xa94a26, 0xe0993a, 0xcf6a2c];
  const n = makeNoise2D(900 + variant * 13);
  const crown = [[lean, 4.3, 0, 1.55], [lean + 1.25, 3.9, 0.55, 1.1], [lean - 1.2, 4.1, -0.6, 1.15],
                 [lean + 0.3, 5.2, -0.3, 1.15], [lean - 0.5, 4.0, 0.9, 1.0], [lean + 0.6, 4.1, -1.0, 0.95],
                 [lean - 0.2, 5.0, 0.6, 0.9]];
  for (const [bx, by, bz, br] of crown) {
    const g = lumpBase(3).clone();
    const hue = new THREE.Color(HUES[Math.floor(rng() * HUES.length)]);
    const hue2 = new THREE.Color(HUES[Math.floor(rng() * HUES.length)]);
    const p = g.attributes.position, sx = 0.9 + rng() * 0.3, sy = 0.7 + rng() * 0.2, o = rng() * 50;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = br * (0.82 + 0.36 * n(x * 2.2 + o, z * 2.2 + y * 1.7) + 0.12 * n(x * 6 + o, y * 6 - z * 5));
      p.setXYZ(i, bx + x * r * sx, by + y * r * sy, bz + z * r * sx);
    }
    g.computeVertexNormals();
    parts.push(tint(g, (pp, nn, c) => {
      const sp = n(pp.x * 3.1 + o, pp.z * 3.1 - pp.y * 2);
      c.copy(hue).lerp(hue2, sp).multiplyScalar(0.5 + 0.62 * smooth(-0.7, 0.9, nn.y) + (sp - 0.5) * 0.2);
    }));
  }
  geo = mergeGeometries(parts.map((g) => {
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position);
    out.setAttribute('normal', g.attributes.normal);
    out.setAttribute('color', g.attributes.color);
    out.setIndex(g.index);
    return out;
  }));
  geo.userData.shared = true;
  _treeGeo.set(variant, geo);
  return geo;
}
let _treeMat = null;
function autumnTrees(spots) {                 // spots: [x, y, z, scale, ry, variant]
  const g = new THREE.Group();
  _treeMat = _treeMat || new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  _treeMat.userData.shared = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (let v = 0; v < 3; v++) {
    const list = spots.filter((sp) => (sp[5] ?? 0) % 3 === v);
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(autumnTreeGeometry(v), _treeMat, list.length);
    list.forEach(([x, y, z, sc, ry], i) => {
      q.setFromAxisAngle(yAxis, ry);
      m4.compose(p.set(x, y, z), q, s.set(sc, sc * (0.92 + (i % 3) * 0.07), sc));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, _c1.setHSL(0.08, 0.1, 0.86 + ((i * 7) % 5) * 0.035));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.frustumCulled = false;
    keep(im);
    g.add(im);
  }
  return g;
}

/* ── classical columns for the lighthouse crown (instanced) ──────────────── */
let _colGeo = null, _stumpGeo = null;
function columnGeometries() {
  if (_colGeo) return [_colGeo, _stumpGeo];
  const prof = (rows) => rows.map(([r, y]) => new THREE.Vector2(r, y));
  // a Doric column of unit height: plinth, torus, shaft with entasis, echinus, abacus
  _colGeo = new THREE.LatheGeometry(prof([
    [0, 0], [0.105, 0], [0.105, 0.03], [0.09, 0.04], [0.095, 0.06], [0.078, 0.075],
    [0.08, 0.3], [0.076, 0.6], [0.066, 0.9], [0.07, 0.915], [0.066, 0.925], [0.1, 0.96],
    [0.105, 0.965], [0.105, 1], [0, 1]]), 18);
  // a shattered one: same foot, the shaft snapped off on a slant
  _stumpGeo = new THREE.LatheGeometry(prof([
    [0, 0], [0.105, 0], [0.105, 0.03], [0.09, 0.04], [0.095, 0.06], [0.078, 0.075],
    [0.08, 0.3], [0.079, 0.42], [0.05, 0.44], [0, 0.43]]), 18);
  {
    const p = _stumpGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > 0.4) p.setY(i, p.getY(i) + p.getX(i) * 0.9 + Math.sin(p.getZ(i) * 60) * 0.012);
    }
    _stumpGeo.computeVertexNormals();
  }
  _colGeo.userData.shared = _stumpGeo.userData.shared = true;
  return [_colGeo, _stumpGeo];
}
function fluteTexture() {
  return cached('flute', () => {
    const [cv, ctx] = canvas(256, 8);
    for (let x = 0; x < 256; x++) {
      const v = Math.round(128 + 110 * Math.abs(Math.sin((x / 256) * Math.PI * 20)));
      ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, 8);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}
function columns(spots, hex) {                // spots: [x, y, z, height, broken, ry]
  const g = new THREE.Group();
  const [colGeo, stumpGeo] = columnGeometries();
  const mat = new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.62, metalness: 0, bumpMap: fluteTexture(), bumpScale: 2.2 });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const e = new THREE.Euler();
  for (const broken of [false, true]) {
    const list = spots.filter((sp) => !!sp[4] === broken);
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(broken ? stumpGeo : colGeo, mat, list.length);
    list.forEach(([x, y, z, h, , ry = 0], i) => {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(x, y, z), q, s.set(h * 1.25, h, h * 1.25));
      im.setMatrixAt(i, m4);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.frustumCulled = false;
    keep(im);
    g.add(im);
  }
  return g;
}

/* ── the set builder ─────────────────────────────────────────────────────── */
const RANGES = {
  hub:    { height: 78, jag: 1, snowline: 0.9,
            palette: { rock: 0xa39a8a, rockDark: 0x6a655e, strata: 0xcdb48c, foot: 0x6f8450, snow: 0xf7f9fb } },
  ice:    { height: 96, jag: 1, snowline: 0.3,
            palette: { rock: 0x6f86a0, rockDark: 0x3d5068, strata: 0x9fb4c8, foot: 0xdfe9f0, snow: 0xffffff } },
  desert: { height: 44, jag: 0.4, snowline: 2,
            palette: { rock: 0xc98a4a, rockDark: 0x8a5a34, strata: 0xe6bd80, foot: 0xe2c88c, snow: 0xf3e3b4 } },
  jungle: { height: 70, jag: 0.4, snowline: 2,
            palette: { rock: 0x4f6a4a, rockDark: 0x2c4530, strata: 0x7a8a5a, foot: 0x2f7a3c, snow: 0xcfe3c2 } },
  autumn: { height: 52, jag: 0, snowline: 2,
            palette: { rock: 0x8a6a52, rockDark: 0x5a4234, strata: 0xb08a5a, foot: 0xb8692a, snow: 0xf6e9d2 } },
};

export function buildBattleSet(theme, opts = {}, kit = {}) {
  const g = new THREE.Group();
  const id = theme.id;
  const seed = hashStr('battle-set:' + id);
  const rng = mulberry32(seed);
  const anims = [];
  const afloat = !!opts.afloat;
  const structure = kit.structure || (() => new THREE.Group());

  /* placement helpers */
  const prop = (pid, x, y, z, s = 1, ry = rng() * 6.283, parent = g) => {
    const p = propGroup(pid, s);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    parent.add(keep(p));
    return p;
  };
  const landmark = (sid, x, y, z, o, parent = g) => {
    const s = structure(sid, o);
    s.position.set(x, y, z);
    parent.add(keep(s));
    return s;
  };
  /* an islet with a real beach and shelf (the board's own terrain engine).
     Returns {group, top, put(propId, angle, rr, scale), at(angle, rr)} */
  const isle = (x, z, R, H, mode, cover) => {
    const t = makeTerrain({ seed: (seed ^ Math.round(x * 31 + z * 17 + R * 7)) >>> 0, R, H, mode,
      palette: theme.palette, cover });
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    t.mesh.children.forEach(keep);            // ground cover shares cached geometry
    grp.add(t.mesh);
    g.add(grp);
    return {
      group: grp, top: t.heightAt(0),
      at: (a, rr) => t.place(a, rr),
      put: (pid, a, rr, s, ry) => { const q = t.place(a, rr); return prop(pid, q.x, q.y, q.z, s, ry, grp); },
    };
  };
  const range = (o = {}) => {
    const R = RANGES[id];
    if (!R) return;
    const m = makeRidge({
      radius: 215, depth: 170, arcStart: -1.42, arcLength: 2.0, rows: 20, segsPerUnit: 0.13,
      seed: hashStr('battle-range:' + id), rootY: -5, ...R, ...o });
    m.layers.disable(SHORE_LAYER);            // far outside the baked rect
    m.position.set(CAM_X, 0, CAM_Z);
    g.add(m);
  };
  const shaft = (x, y, z, w, h, hex, op, rz, ry = 0.5) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: shaftTexture(), color: hex, transparent: true, opacity: op, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    m.position.set(x, y, z);
    m.rotation.set(0, ry, rz);
    g.add(m);
    return m;
  };

  const ARENA = { cx: 9.5, cz: 0, rx: 11, rz: 16 };
  let shore = { x: 14, z: -6, size: 170 };

  if (id === 'hub') {
    /* ── Aegean afternoon: a sandbar off a temple isle ── */
    g.add(makeShoal({ ...ARENA, top: afloat ? SEA - 1.5 : -0.03, seed: seed + 1,
      dry: 0xe6d6a4, wet: 0x9c8a62 }));

    const [tx, tz] = P(55, 4);
    const temple = isle(tx, tz, 10, 3.2, 'mesa', 'meadow');
    landmark('temple', 0, temple.top - 0.1, 0, { h: 7.5 }, temple.group);
    temple.put('cypress_tree', 1.1, 0.56, 1.5); temple.put('cypress_tree', 4.5, 0.56, 1.3);
    temple.put('cypress_tree', -0.2, 0.52, 1.45); temple.put('olive_tree', 0.5, 0.56, 1.3);
    temple.put('broken_statue', 2.4, 0.8, 1.6, -1.9); temple.put('amphora_pile', 3.3, 0.82, 1.3);

    const [rx, rz] = P(41, 25);
    const right = isle(rx, rz, 7, 2.0, 'hill', 'meadow');
    right.put('olive_tree', 0.5, 0.2, 1.5); right.put('cypress_tree', 3.4, 0.3, 1.3);
    right.put('ruined_arch', 2.2, 0.45, 1.1, 0.4);

    const [lx, lz] = P(64, -27);
    const left = isle(lx, lz, 9, 5.5, 'peak', 'meadow');
    left.put('cypress_tree', 1.2, 0.5, 1.4); left.put('cypress_tree', 2.0, 0.6, 1.2);
    left.put('olive_tree', 4.2, 0.55, 1.3);

    const [fx, fz] = P(125, -34);
    const far = isle(fx, fz, 13, 3.4, 'hill', 'none');
    landmark('lighthouse', 0, far.top - 0.2, 0, { h: 17 }, far.group);

    // a wreck on the reef to the left of the fight; sea stacks framing the right
    const [wx, wz] = P(40, -15);
    const [sx, sz] = P(13.5, 9.6);
    const paint = rockPaint(seed + 2, theme.palette.rock, 0xd9d2bf, 0.55);
    const rocks = lumps([
      { x: wx, z: wz, y: -0.5, sx: 4.4, sy: 1.5, sz: 3.2, seed: 11, detail: 5, rough: 0.34 },
      { x: wx + 3.6, z: wz - 2.2, y: -0.4, sx: 1.7, sy: 2.4, sz: 1.5, seed: 12, facets: 5, rough: 0.2 },
      { x: sx, z: sz, y: -0.5, sx: 2.3, sy: 3.4, sz: 2.0, seed: 13, detail: 5, facets: 6, rough: 0.22 },
      { x: sx + 2.4, z: sz + 1.6, y: -0.5, sx: 1.6, sy: 1.5, sz: 1.9, seed: 14, rough: 0.3 },
      { x: sx - 2.6, z: sz + 2.4, y: -0.6, sx: 1.2, sy: 0.9, sz: 1.0, seed: 15, rough: 0.3 },
      { x: 21, z: 12.5, y: -0.5, sx: 1.6, sy: 0.9, sz: 1.3, seed: 16, rough: 0.3 },
      { x: 19.5, z: -15, y: -0.5, sx: 1.3, sy: 1.1, sz: 1.5, seed: 17, facets: 4, rough: 0.25 },
      { x: -2, z: -17, y: -0.6, sx: 1.5, sy: 0.8, sz: 1.2, seed: 18, rough: 0.3 },
    ], paint, makeGroundMaterial({ tide: true, bump: 1.4 }));
    rocks.layers.enable(SHORE_LAYER);
    g.add(rocks);
    g.add(shelfMesh([[wx, wz, 9], [sx, sz, 6], [21, 12.5, 4], [19.5, -15, 4]]));
    prop('shipwreck', wx - 0.4, 0.5, wz + 0.3, 2.3, 2.5);
    prop('driftwood', 14.5, -0.02, 9.5, 1.3);
    if (!afloat) { prop('amphora_pile', 15.5, -0.04, -10.5, 1.1); prop('coral', 4.4, -0.2, 11.5, 0.9); }
    range();
  } else if (id === 'ice') {
    /* ── the Frostfang Reach: blue pack ice under a low amber sun ── */
    const ice = new THREE.Color(0x6aa2c2), deepIce = new THREE.Color(0x3d7ea6), snow = new THREE.Color(0xf1f6fa);
    const edgeIce = new THREE.Color(0x66c0dc);
    const iceMat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: iceTexture(), bumpMap: iceTexture(), bumpScale: 0.7,
      roughness: 0.3, metalness: 0, emissive: 0x0a2b3c, emissiveIntensity: 0.55 });
    const plate = (cx, cz, rx, rz, top, sd, cell, bare) => {
      const f = fbm2(sd);
      const rrOf = (x, z) => {
        const dx = (x - cx) / rx, dz = (z - cz) / rz, a = Math.atan2(dz, dx);
        // angular, not round: the edge is a noisy polygon
        const poly = 0.9 + 0.1 * Math.cos(a * 5 + sd) + 0.07 * Math.cos(a * 9 - sd * 2);
        return Math.hypot(dx, dz) / (poly * (0.9 + 0.22 * f(Math.cos(a) * 2.2 + 3, Math.sin(a) * 2.2 - 8)));
      };
      const height = (x, z) => {
        const rr = rrOf(x, z);
        const drift = smooth(0.62, 0.92, f(x * 0.22 + 1.5, z * 0.22 - 6)) * (bare ? smooth(0.5, 0.85, rr) : 1);
        const ridge = smooth(0.7, 0.96, rr) * 0.16 * f(x * 0.9, z * 0.9);
        return top + drift * 0.22 + ridge - 3.4 * smooth(1.0, 1.05, rr);
      };
      return heightfield({
        cx, cz, hx: rx * 1.3, hz: rz * 1.3, nx: Math.round(rx * 2.6 / cell), nz: Math.round(rz * 2.6 / cell),
        height, mask: (x, z) => rrOf(x, z) < 1.14,
        paint: (x, z, y, ny, c) => {
          const rr = rrOf(x, z), n = f(x * 0.35 - 3, z * 0.35 + 2);
          c.copy(deepIce).lerp(ice, 0.35 + n * 0.75);
          c.lerp(snow, Math.min(1, smooth(0.04, 0.2, y - top) + (bare ? smooth(0.72, 0.96, rr) * 0.8 : 0.75)));
          if (ny < 0.75) c.lerp(edgeIce, smooth(0.75, 0.4, ny));
          if (y < SEA) c.lerp(deepIce, 0.6);
        },
      });
    };
    const sheet = new THREE.Mesh(plate(ARENA.cx, ARENA.cz, 12, 17, -0.03, seed + 3, 0.5, true), iceMat);
    sheet.receiveShadow = true;
    sheet.layers.enable(SHORE_LAYER);
    sheet.name = 'arena';
    g.add(sheet);
    const floeGeos = [];
    for (const [x, z, r, sd] of [[-3, -12, 3.2, 1], [-12, -9, 2.2, 2], [-6, 9.5, 2.6, 3], [3, 21, 3.4, 4],
      [-14, 14, 2.4, 5], [22, 21, 4.2, 6], [26, -17, 3.6, 7], [9, -24, 4.4, 8], [34, 4, 3.0, 9],
      [-22, -20, 3.0, 10], [44, -30, 5, 11], [48, 16, 4.2, 12], [16, 30, 3, 13], [-9, 22, 2, 14]]) {
      floeGeos.push(plate(x, z, r, r * (0.75 + (sd % 3) * 0.2), -0.1, seed + 20 + sd, 0.55, false));
    }
    const floes = new THREE.Mesh(mergeGeometries(floeGeos), iceMat);
    floes.receiveShadow = true;
    floes.layers.enable(SHORE_LAYER);
    g.add(floes);

    // the temple of the reach on a snow-capped skerry; bergs either side of it
    const [tx, tz] = P(56, 5);
    const temple = isle(tx, tz, 10, 2.6, 'mesa', 'rocks');
    landmark('ice_temple', 0, temple.top - 0.3, 0, { h: 8.5, ry: Math.PI * 0.62 }, temple.group);
    temple.put('pine_snow', 1.2, 0.6, 1.5); temple.put('pine_snow', 4.4, 0.6, 1.25);
    temple.put('pine_snow', -0.3, 0.56, 1.4); temple.put('cairn', 2.3, 0.8, 1.3);

    const bergPaint = (() => {
      const f = fbm2(seed + 9);
      return (p, n, c) => {
        const k = f(p.x * 0.3 + p.y * 0.25, p.z * 0.3);
        c.copy(deepIce).lerp(edgeIce, smooth(-0.5, 5, p.y) * 0.8 + k * 0.3);
        c.lerp(snow, smooth(0.42, 0.78, n.y + (k - 0.5) * 0.3));
      };
    })();
    const B = (d, s, w, h, sd, f = 7) => {
      const [x, z] = P(d, s);
      return { x, z, y: -1.2, sx: w, sy: h, sz: w * 0.8, seed: sd, detail: 7, facets: f, rough: 0.1, base: -0.5, ry: sd };
    };
    const bergs = lumps([
      B(44, -23, 6.5, 12, 31, 8), B(52, -31, 4.5, 6.5, 32), B(40, 27, 5, 7.5, 33, 6),
      B(84, -8, 9, 15, 34, 9), B(100, 36, 8, 9, 35), B(120, -58, 12, 18, 36, 8),
      { ...B(13, 10.2, 1.6, 2.6, 37, 5), detail: 4 }, { ...B(30, -19, 1.8, 1.6, 38, 5), detail: 4 },
    ], bergPaint, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.22, metalness: 0, emissive: 0x0d3a52, emissiveIntensity: 0.6 }));
    bergs.layers.enable(SHORE_LAYER);
    g.add(bergs);
    const [ix, iz] = P(14.5, 8.2);
    prop('ice_shard', ix, -0.1, iz, 1.3); prop('ice_shard', 22, -0.02, 13, 1.5); prop('ice_shard', 20.5, -0.02, -14, 1.2);
    range();
  } else if (id === 'desert') {
    /* ── the Bleached Reach: a slate forecourt before a tomb, dunes beyond ── */
    shore = null;
    const f = fbm2(seed + 4);
    const sand = new THREE.Color(theme.palette.sand), shade = new THREE.Color(0xc9a567), crest = new THREE.Color(0xfff0c8);
    const height = (x, z) => {
      const d = Math.hypot(x - 1, z);
      const dune = smooth(30, 85, d);
      const ridge = 1 - Math.abs(2 * f(x * 0.018 + 3 + z * 0.006, z * 0.03 - 5) - 1);
      return (Math.sin(x * 0.22 + z * 0.3) * 0.18 + Math.sin(z * 0.12) * 0.14) * smooth(15, 26, d)
        + dune * (ridge * ridge * 11 + f(x * 0.05, z * 0.05) * 4 - 2.5);
    };
    g.add(heightfield({
      cx: 30, cz: -10, hx: 330, hz: 330, nx: 130, nz: 130, warp: 0.72, height,
      paint: (x, z, y, ny, c) => {
        const n = f(x * 0.12 + 9, z * 0.12 - 4);
        const ripple = 0.5 + 0.5 * Math.sin(x * 1.3 + z * 1.9 + n * 8);
        c.copy(shade).lerp(sand, 0.55 + n * 0.4 + ripple * 0.08).lerp(crest, smooth(3, 10, y) * 0.5);
      },
      material: makeGroundMaterial({ tide: false, bump: 1.0 }),
    }));
    // the court: cool slate against warm sand, so sand-coloured beasts stand out
    {
      const R = 18.5, TILE = 9, CX = 1.5;
      const geo = new THREE.CircleGeometry(R, 48);
      geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position, uv = geo.attributes.uv;
      const uv1 = new Float32Array(p.count * 2);
      for (let i = 0; i < p.count; i++) {
        uv.setXY(i, p.getX(i) / TILE, p.getZ(i) / TILE);
        uv1[i * 2] = (p.getX(i) + R) / (2 * R); uv1[i * 2 + 1] = 1 - (p.getZ(i) + R) / (2 * R);
      }
      geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
      const court = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: flagstoneTexture(), bumpMap: flagstoneTexture(), bumpScale: 2.4, color: 0x7d7684,
        alphaMap: courtMask(R, TILE, seed + 5), alphaTest: 0.5, roughness: 0.74, metalness: 0 }));
      court.position.set(CX, 0.035, 0);
      court.receiveShadow = true;
      court.name = 'arena';
      g.add(court);
    }
    const [tx, tz] = P(56, 4);
    landmark('tomb', tx, height(tx, tz) - 0.4, tz, { h: 10, ry: -Math.PI / 2 - 0.42 });
    for (const [d, s] of [[41, -8.5], [43, 15]]) {
      const [x, z] = P(d, s);
      landmark('obelisk', x, height(x, z) - 0.3, z, { h: 9.5, ry: 0.4 });
    }
    const sit = (pid, d, s, sc, ry) => { const [x, z] = P(d, s); return prop(pid, x, height(x, z), z, sc, ry); };
    sit('sarcophagus', 47.5, 0.5, 1.5, -1.9); sit('sarcophagus', 48.5, 8.5, 1.5, -1.9);
    sit('ruined_arch', 37, -21, 2.3, 0.5); sit('bone_pile', 30, -13, 1.8); sit('bone_pile', 20, 13.5, 1.3);
    sit('amphora_pile', 22, -13.5, 1.4); sit('dead_scrub', 33, 17, 1.6); sit('dead_scrub', 17, -12.5, 1.2);
    sit('palm_tree', 13.2, 9.8, 2.0, 2.2); sit('palm_tree', 16.5, 11.6, 1.5, 0.6); sit('dead_scrub', 12.5, 7.6, 1.1);
    sit('palm_tree', 70, -30, 1.9); sit('palm_tree', 73, -26, 1.6); sit('palm_tree', 75, 30, 1.8);
    {
      const [x, z] = P(66, -31);
      landmark('tents', x, height(x, z) - 0.2, z, { h: 4.2, ry: 0.9 });
    }
    range({ radius: 250, depth: 120 });
  } else if (id === 'jungle') {
    /* ── the Verdigris Deep: a pale silt bar in a brown river, canopy walls ── */
    g.add(makeShoal({ ...ARENA, top: afloat ? SEA - 1.5 : -0.03, seed: seed + 1,
      dry: 0xdccd98, wet: 0x8f7d54, accent: 0x6f8a44 }));
    const [tx, tz] = P(55, 4);
    const ruin = isle(tx, tz, 11.5, 1.5, 'flat', 'meadow');
    landmark('jungle_dungeon', 0, ruin.top - 0.2, 0, { h: 9.5, ry: -Math.PI / 2 - 0.42 }, ruin.group);
    ruin.put('mossy_idol', 2.25, 0.74, 2.0, -1.9); ruin.put('mossy_idol', 3.35, 0.74, 2.0, -1.9);
    ruin.put('jungle_tree', 0.4, 0.7, 2.8); ruin.put('jungle_tree', -1.4, 0.72, 3.1);
    ruin.put('fern_cluster', 3.4, 0.86, 1.6);
    const wall = (d, s, R, trees) => {
      const [x, z] = P(d, s);
      const b = isle(x, z, R, 1.2, 'flat', 'meadow');
      trees.forEach(([a, rr, sc]) => b.put('jungle_tree', a, rr, sc));
      return b;
    };
    wall(36, -27, 9, [[0.3, 0.3, 3.0], [2.4, 0.5, 2.6], [4.4, 0.45, 3.3]]).put('fern_cluster', 1.2, 0.8, 1.8);
    wall(70, -37, 12, [[0.6, 0.4, 3.4], [2.8, 0.5, 3.0], [4.8, 0.3, 3.6], [1.8, 0.75, 2.8]]);
    wall(36, 27, 8.5, [[1.0, 0.3, 3.1], [3.2, 0.5, 2.7], [5.2, 0.45, 2.9]]).put('fern_cluster', 3.9, 0.82, 1.7);
    wall(74, 30, 11, [[0.2, 0.4, 3.3], [2.2, 0.45, 3.5], [4.1, 0.5, 3.0]]);
    wall(100, -6, 13, [[0.5, 0.4, 3.6], [2.0, 0.3, 3.9], [3.4, 0.55, 3.3], [5.0, 0.5, 3.6]]);
    // foreground: reeds and fern on a mud lip, lilies on the slack water
    const [bx, bz] = P(13.5, 9.4);
    const paint = rockPaint(seed + 2, 0x6a5a40, 0x587a3a, 0.85);
    const mud = lumps([
      { x: bx, z: bz, y: -0.45, sx: 3.2, sy: 0.9, sz: 2.4, seed: 21, rough: 0.25 },
      { x: 20.5, z: 13.5, y: -0.5, sx: 2.2, sy: 1.0, sz: 1.7, seed: 22, rough: 0.3 },
      { x: 20, z: -15.5, y: -0.5, sx: 2.0, sy: 1.2, sz: 1.6, seed: 23, rough: 0.3 },
    ], paint, makeGroundMaterial({ tide: true, bump: 1.2 }));
    mud.layers.enable(SHORE_LAYER);
    g.add(mud);
    g.add(shelfMesh([[bx, bz, 6], [20.5, 13.5, 4.5], [20, -15.5, 4.5]]));
    prop('reeds', bx - 0.6, 0.25, bz + 0.6, 1.7); prop('fern_cluster', bx + 1.3, 0.3, bz - 0.2, 1.5);
    prop('reeds', 20.8, 0.3, 13.8, 1.5); prop('fern_cluster', 20, 0.5, -15.5, 1.4);
    prop('lily_pads', -2.5, SEA + 0.05, -7.5, 2.4); prop('lily_pads', 2.5, SEA + 0.05, 17.5, 2.0);
    prop('lily_pads', 24, SEA + 0.05, -6, 2.2);
    if (!afloat) prop('driftwood', 14, -0.02, -9.5, 1.4);
    // sun through the canopy
    shaft(18, 13, -16, 7, 34, new THREE.Color(1.3, 1.2, 0.72), 0.2, -0.42);
    shaft(31, 14, -4, 9, 38, new THREE.Color(1.3, 1.2, 0.72), 0.16, -0.42);
    shaft(6, 12, -22, 5, 30, new THREE.Color(1.3, 1.2, 0.72), 0.14, -0.42);
    range();
  } else if (id === 'autumn') {
    /* ── the Amber Vale: a straw-gold clearing ringed by the turning wood ── */
    shore = null;
    const f = fbm2(seed + 4);
    const straw = new THREE.Color(0xd8b56c), earth = new THREE.Color(0x8a6238), litter = new THREE.Color(0xb5612a);
    const moss = new THREE.Color(0x77763a);
    const height = (x, z) => {
      const d = Math.hypot(x - 2, z);
      return (f(x * 0.05 + 3, z * 0.05 - 5) - 0.5) * 7 * smooth(26, 80, d)
        + (f(x * 0.22, z * 0.22) - 0.5) * 0.5 * smooth(15, 30, d);
    };
    g.add(heightfield({
      cx: 30, cz: -10, hx: 300, hz: 300, nx: 120, nz: 120, warp: 0.72, height,
      paint: (x, z, y, ny, c) => {
        const d = Math.hypot(x - 2, z * 0.85), n = f(x * 0.16 + 9, z * 0.16 - 4), n2 = f(x * 0.6, z * 0.6);
        // trodden straw in the clearing → leaf litter and moss under the trees
        c.copy(straw).lerp(earth, smooth(0.55, 0.8, n2) * 0.35);
        c.lerp(litter, smooth(14, 26, d + (n - 0.5) * 12) * (0.55 + n2 * 0.4));
        c.lerp(moss, smooth(0.6, 0.85, n) * smooth(20, 40, d) * 0.6);
        c.multiplyScalar(0.9 + n2 * 0.2);
      },
      material: makeGroundMaterial({ tide: false, bump: 1.3 }),
    }));
    const [tx, tz] = P(55, 4);
    landmark('temple_autumn', tx, height(tx, tz) - 0.15, tz, { h: 8 });
    const sit = (pid, d, s, sc, ry) => { const [x, z] = P(d, s); return prop(pid, x, height(x, z), z, sc, ry); };
    sit('waymarker_stone', 40, -4.5, 1.7, 0.4); sit('waymarker_stone', 41.5, 10.5, 1.7, -0.5);
    const T = (d, s, sc, v) => { const [x, z] = P(d, s); return [x, height(x, z) - 0.1, z, sc, rng() * 6.283, v]; };
    g.add(autumnTrees([
      T(11.5, 10.2, 2.5, 0),                                   // the framing trunk, right foreground
      T(30, -20.5, 2.1, 1), T(40, -27, 2.5, 2), T(52, -22, 2.2, 0), T(64, -15, 2.7, 1),
      T(70, 6, 2.6, 2), T(62, 21, 2.4, 0), T(46, 27, 2.3, 1), T(33, 24, 2.0, 2),
      T(84, -36, 3.0, 0), T(92, -10, 3.2, 1), T(90, 24, 3.0, 2), T(108, -52, 3.4, 1),
      T(112, 8, 3.5, 0), T(110, 44, 3.2, 2), T(72, -44, 2.8, 2), T(74, 42, 2.8, 0),
      T(140, -30, 4, 0), T(138, 30, 4, 1), T(132, -74, 4, 2), T(22, -17, 1.7, 2),
    ]));
    sit('dead_tree', 34, -15, 1.6); sit('dead_tree', 50, 18, 1.8); sit('dead_tree', 26, 19, 1.3);
    sit('boulder', 29, -14.5, 1.7); sit('boulder', 24, 14.5, 1.3); sit('boulder', 45, -12, 2.2);
    sit('mushroom_cluster', 13.5, 7.6, 0.9); sit('mushroom_cluster', 31, -16.5, 1.1); sit('mushroom_cluster', 27, 16, 0.8);
    sit('fern_cluster', 12.5, 8.6, 1.0);
    {
      const [x, z] = P(23, -11.5);
      prop('campfire', x, height(x, z), z, 1.5);
      g.add(makeFire(anims, { x, y: height(x, z) + 0.35, z, w: 1.0, h: 1.7, seed: 5, glow: 0.8 }));
    }
    // low sun raking between the trunks; leaves letting go
    shaft(20, 11, -18, 8, 30, new THREE.Color(1.5, 0.95, 0.42), 0.16, -0.5);
    shaft(34, 12, -6, 10, 34, new THREE.Color(1.5, 0.95, 0.42), 0.13, -0.5);
    g.add(makeDrift(anims, { n: 70, box: [60, 16, 50], origin: [10, 0.2, -4], rise: -1.1, sway: 1.6,
      size: 0.34, color: 0xe0872e, additive: false, seed: 9 }));
    range({ radius: 200, depth: 150 });
  } else if (id === 'pharos') {
    /* ── the crown of the lighthouse, midnight: the beacon burns behind the foe ── */
    shore = null;
    const CX = 2, R = 27, BX = 24, BZ = -3;
    const stone = 0x55525e;
    {
      const geo = new THREE.CircleGeometry(R, 72);
      geo.rotateX(-Math.PI / 2);
      const floor = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: terraceTexture(), bumpMap: terraceTexture(), bumpScale: 3, color: 0x8f8a9c,
        roughness: 0.4, metalness: 0.05 }));
      floor.position.set(CX, 0, 0);
      floor.receiveShadow = true;
      floor.name = 'arena';
      g.add(floor);
      // the drum of the tower falling away below, and the parapet round the far side
      const drum = new THREE.Mesh(
        new THREE.LatheGeometry([new THREE.Vector2(R, 0), new THREE.Vector2(R + 0.6, -0.7),
          new THREE.Vector2(R - 0.4, -1.4), new THREE.Vector2(R - 2.5, -60)], 64),
        new THREE.MeshStandardMaterial({ color: 0x2a2830, roughness: 0.9 }));
      drum.position.set(CX, 0, 0);
      g.add(drum);
      const SPAN = 4.25;                                     // radians of wall, centred on +x
      const wall = new THREE.Mesh(
        new THREE.LatheGeometry([[R - 1.1, 0], [R - 1.1, 1.05], [R - 1.3, 1.1], [R - 1.3, 1.36],
          [R - 0.1, 1.36], [R - 0.1, 1.1], [R - 0.3, 1.05], [R - 0.3, 0]].map(([r, y]) => new THREE.Vector2(r, y)),
          56, Math.PI / 2 - SPAN / 2, SPAN),
        new THREE.MeshStandardMaterial({ color: stone, roughness: 0.78, map: flagstoneTexture(),
          bumpMap: flagstoneTexture(), bumpScale: 2 }));
      {
        const uv = wall.geometry.attributes.uv, p = wall.geometry.attributes.position;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 18, p.getY(i) * 0.35);
      }
      wall.position.set(CX, 0, 0);
      wall.castShadow = true; wall.receiveShadow = true;
      g.add(wall);
      // the colonnade on the parapet: standing drums and broken stumps
      const spots = [];
      const N = 15;
      for (let k = 0; k < N; k++) {
        const a = -SPAN / 2 + 0.12 + (k / (N - 1)) * (SPAN - 0.24);
        const x = CX + Math.cos(a) * (R - 0.7), z = Math.sin(a) * (R - 0.7);
        if (Math.hypot(x - BX, z - BZ) < 6.5) continue;       // the beacon's own bay stays open
        const broken = [1, 4, 9, 13].includes(k);
        spots.push([x, 1.36, z, broken ? 5 + rng() * 2 : 8.2 + rng() * 1.2, broken, rng() * 6.283]);
      }
      g.add(columns(spots, 0x6c6876));
    }
    // the great beacon: stepped dais, bronze bowl, a fire you can feel
    {
      const prof = (rows) => rows.map(([r, y]) => new THREE.Vector2(r, y));
      const dais = new THREE.Mesh(new THREE.LatheGeometry(prof([
        [0, 0], [6.2, 0], [6.2, 0.55], [5.1, 0.55], [5.1, 1.1], [4.0, 1.1], [4.0, 1.65], [0, 1.65]]), 40),
        new THREE.MeshStandardMaterial({ color: 0x5c5866, roughness: 0.6, map: flagstoneTexture() }));
      dais.position.set(BX, 0, BZ);
      dais.castShadow = true; dais.receiveShadow = true;
      g.add(dais);
      const bowl = new THREE.Mesh(new THREE.LatheGeometry(prof([
        [0, 1.65], [1.5, 1.65], [1.25, 1.95], [0.85, 2.3], [0.8, 2.9], [1.3, 3.25], [2.6, 3.7], [3.5, 4.5],
        [3.7, 4.55], [3.45, 4.62], [2.5, 4.0], [0, 3.8]]), 36),
        new THREE.MeshStandardMaterial({ color: 0x8a5a2c, roughness: 0.38, metalness: 0.85 }));
      bowl.position.set(BX, 0, BZ);
      bowl.castShadow = true;
      g.add(bowl);
      const coals = new THREE.Mesh(new THREE.CircleGeometry(3.3, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 1.5, 0.3), map: softDiscTexture(), fog: false }));
      coals.position.set(BX, 4.42, BZ);
      g.add(coals);
      g.add(makeFire(anims, { x: BX, y: 4.3, z: BZ, w: 7.5, h: 12.5, seed: 2, glow: 1.25 }));
      const light = new THREE.PointLight(0xff7a30, 520, 90, 2);
      light.position.set(BX - 1.5, 9, BZ + 0.5);
      g.add(light);
      anims.push((t) => { light.intensity = 520 * (0.88 + Math.sin(t * 9.3) * 0.07 + Math.sin(t * 23.1 + 1) * 0.05); });
      g.add(makeDrift(anims, { n: 110, box: [5, 24, 5], origin: [BX, 5, BZ], rise: 2.6, sway: 0.9,
        size: 0.3, color: new THREE.Color(4.0, 1.4, 0.3), seed: 4 }));
      // dark obelisks flank the fire
      for (const s of [-1, 1]) landmark('obelisk', BX - 1 - s * 1.2, 0, BZ + s * 9.5, { h: 13 });
    }
    // braziers along the fight's flanks: bronze bowls on turned stands
    {
      const prof = [[0, 0], [0.55, 0], [0.5, 0.12], [0.18, 0.3], [0.14, 1.2], [0.2, 1.32], [0.62, 1.55],
        [0.78, 1.95], [0.84, 1.97], [0.7, 1.8], [0, 1.72]].map(([r, y]) => new THREE.Vector2(r, y));
      const standGeo = new THREE.LatheGeometry(prof, 16);
      const standMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.42, metalness: 0.85 });
      const SPOTS = [[5, -12.5, 1], [16.5, 11.5, 1], [-11, -10.5, 0], [-3, 13.5, 0]];
      SPOTS.forEach(([x, z, lit], i) => {
        const st = new THREE.Mesh(standGeo, standMat);
        st.position.set(x, 0, z);
        st.castShadow = true;
        g.add(st);
        g.add(makeFire(anims, { x, y: 1.85, z, w: 1.25, h: 2.3, seed: 10 + i }));
        if (lit) {
          const l = new THREE.PointLight(0xff8a3c, 60, 30, 2);
          l.position.set(x, 3.1, z);
          g.add(l);
          anims.push((t) => { l.intensity = 60 * (0.86 + Math.sin(t * 11 + i) * 0.09 + Math.sin(t * 27 + i * 2) * 0.05); });
        }
      });
    }
    prop('banner_pole', CX + Math.cos(0.92) * (R - 2.6), 0, Math.sin(0.92) * (R - 2.6), 2.6, 2.2);
    prop('banner_pole', CX + Math.cos(-1.15) * (R - 2.6), 0, Math.sin(-1.15) * (R - 2.6), 2.6, 0.6);
    prop('bone_pile', 19, 0, 12.5, 1.6); prop('sarcophagus', 14, 0, -19, 1.9, 0.5);
  }

  if (anims.length) g.userData.update = (t) => { for (const a of anims) a(t); };
  g.userData.shore = shore;
  return g;
}

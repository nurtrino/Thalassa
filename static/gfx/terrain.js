/*
 * gfx/terrain.js — island terrain, rebuilt.
 *
 * Each island is a dense heightfield on a regular grid (no radial fans, no
 * pinwheel triangles), smooth-shaded, with:
 *   · an organic noise-warped coastline and a real BEACH PROFILE — dry sand
 *     climbing out of wet sand, never a hard lip at the waterline
 *   · an underwater SHELF that falls away gently, then steeply. It is never
 *     seen directly; the ocean reads it from the baked shore map to paint
 *     turquoise shallows, caustics and surf exactly where the seabed rises
 *   · biome colour from height, SLOPE and noise: sand → meadow in two tones
 *     → bare rock wherever the ground is too steep to hold soil
 *   · a shader pass that adds world-space grain, darkens and glosses the
 *     wet sand at the tide line, and deepens the creases
 *
 * The contract islands.js builds on is unchanged:
 *   makeTerrain({seed, R, H, mode, palette, lobes}) →
 *     { mesh, heightAt(rr), place(angle, rr), surfaceY(x, z), rng }
 * The heart of every island still sits exactly on heightAt() so buildings
 * and flora stand on the ground.
 */
import * as THREE from 'three';
import { mulberry32 } from '../util.js';
import { bindAtmosphere } from './atmosphere.js';

export const SHORE_LAYER = 3;          // meshes on this layer are baked into the shore map
const SEA = -0.3;                      // keep in step with ocean.js WATER_Y

const COL = {
  sand: 0xf3e3b4, sandWet: 0xcdb98a, grass: 0x5cb56e, grass2: 0x3f9e58,
  rock: 0x93999e, rockDark: 0x5c6166,
};

export function makeNoise2D(seed) {
  const rng = mulberry32(seed);
  const perm = new Uint8Array(512);
  const src = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = src[i & 255];
  const val = (ix, iz) => perm[(ix & 255) + perm[iz & 255]] / 255;
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = val(ix, iz), b = val(ix + 1, iz);
    const c = val(ix, iz + 1), d = val(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
}

const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/* ── shared ground detail textures (grain + relief), generated once ──────── */
let _grainTex = null, _bumpTex = null;
function blotch(ctx, S, rng, n, rMin, rMax, ink) {
  for (let i = 0; i < n; i++) {
    const x = rng() * S, y = rng() * S, r = rMin + rng() * (rMax - rMin);
    ctx.fillStyle = ink(rng);
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, 6.2832); ctx.fill();
    }
  }
}
export function groundGrainTexture() {
  if (_grainTex) return _grainTex;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);
  const rng = mulberry32(24239);
  blotch(ctx, S, rng, 90, 40, 110, (r) => { const v = 196 + ((r() * 59) | 0); return `rgba(${v},${v},${v},${0.05 + r() * 0.07})`; });
  blotch(ctx, S, rng, 420, 8, 30, (r) => { const v = 186 + ((r() * 69) | 0); return `rgba(${v},${v},${v},${0.05 + r() * 0.07})`; });
  blotch(ctx, S, rng, 7000, 0.6, 2.2, (r) => { const v = r() < 0.6 ? 160 + ((r() * 50) | 0) : 255; return `rgba(${v},${v},${v},${0.05 + r() * 0.08})`; });
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _grainTex = t;
  return t;
}
export function groundReliefTexture() {
  if (_bumpTex) return _bumpTex;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, S, S);
  const rng = mulberry32(77121);
  blotch(ctx, S, rng, 260, 14, 60, (r) => { const v = 96 + ((r() * 128) | 0); return `rgba(${v},${v},${v},${0.10 + r() * 0.10})`; });
  blotch(ctx, S, rng, 9000, 0.7, 2.6, (r) => { const v = r() < 0.5 ? 40 + ((r() * 60) | 0) : 190 + ((r() * 65) | 0); return `rgba(${v},${v},${v},${0.14 + r() * 0.16})`; });
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  _bumpTex = t;
  return t;
}

/* ── the ground material: standard PBR + tide line + creases ─────────────── */
export const GROUND_TILE = 14;         // world units per grain repeat

export function makeGroundMaterial({ bump = 0.6, tide = true, extra = {} } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0,
    map: groundGrainTexture(), bumpMap: groundReliefTexture(), bumpScale: bump,
    ...extra,
  });
  if (!tide) return mat;                 // dry floors (desert, forest) skip the tide line
  mat.onBeforeCompile = (shader) => {
    bindAtmosphere(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vGroundY;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGroundY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGroundY;')
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        // the tide line: sand within reach of the swell is dark and glossy
        float tideK = 1.0 - smoothstep(${(SEA + 0.05).toFixed(2)}, ${(SEA + 0.75).toFixed(2)}, vGroundY);
        roughnessFactor = mix(roughnessFactor, 0.34, tideK * 0.85);
        diffuseColor.rgb *= mix(1.0, 0.62, tideK);`);
  };
  mat.customProgramCacheKey = () => 'thalassa-ground-v2';
  return mat;
}

/* ── the island ──────────────────────────────────────────────────────────── */
export function makeTerrain({ seed, R, H, mode = 'hill', palette = {}, lobes = 0, shelf = null, cover = null,
                              fit = false, cove = null, cliff = null, lagoon = 0 }) {
  const dry = !!palette.dry;             // stands on sand / forest floor, not in the sea
  if (shelf === null) shelf = !dry;
  const rng = mulberry32(seed);
  const noise = makeNoise2D((seed ^ 0x9e3779) >>> 0);
  const fbm = (x, z) => (noise(x, z) + 0.5 * noise(x * 2.13 + 37.7, z * 2.13 - 19.1)
                         + 0.25 * noise(x * 4.31 - 53.3, z * 4.31 + 11.9)) / 1.75;
  const ex = 0.8 + rng() * 0.5;
  const ez = 0.8 + rng() * 0.5;
  const rugged = 0.6 + rng() * (mode === 'mesa' ? 0.5 : 1.0);
  const hueDrift = (c, dh, ds, dl) => {
    const hsl = {};
    c.getHSL(hsl);
    c.setHSL((hsl.h + dh + 1) % 1, Math.min(1, Math.max(0, hsl.s + ds)),
             Math.min(1, Math.max(0, hsl.l + dl)));
    return c;
  };
  // palette.drift (default 1) scales the per-island hue wander; a stop that
  // must match a shared floor (the desert's sand pads) passes 0
  const driftK = palette.drift ?? 1;
  const gShift = (rng() - 0.5) * 0.06 * driftK, sShift = (rng() - 0.5) * 0.03 * driftK;
  const P = {
    sand: hueDrift(new THREE.Color(palette.sand ?? COL.sand), sShift, 0, (rng() - 0.5) * 0.06),
    sandWet: new THREE.Color(palette.sandWet ?? COL.sandWet),
    grass: hueDrift(new THREE.Color(palette.grass ?? COL.grass), gShift, (rng() - 0.5) * 0.1, 0),
    grass2: hueDrift(new THREE.Color(palette.grass2 ?? COL.grass2), gShift, 0, (rng() - 0.5) * 0.08),
    rock: new THREE.Color(palette.rock ?? COL.rock),
  };
  P.rockDark = P.rock.clone().multiplyScalar(0.62);
  P.sandWet.lerp(P.sand, 0.35);

  // the coastline: noise around the unit circle — organic and closed
  const eoff = rng() * 90;
  const ephase = rng() * 6.28;
  // a COVE bites a bay out of the coast at cove.a (depth 0..~0.5, width rad)
  const coveK = (a) => {
    if (!cove) return 1;
    const d = Math.atan2(Math.sin(a - cove.a), Math.cos(a - cove.a)) / (cove.w ?? 0.5);
    return 1 - (cove.depth ?? 0.35) * Math.exp(-d * d * 2.2);
  };
  const edge0 = (a) => (0.78 + 0.52 * rugged
                        * fbm(Math.cos(a) * 2.3 + eoff, Math.sin(a) * 2.3 + eoff))
                      * (1 + lobes * Math.sin(2 * a + ephase)) * coveK(a);
  // FIT: scale the coastline so its farthest point sits exactly at R — the
  // footprint gameplay plans lanes around (board.py ISLE_FOOT) is then the
  // real one; without it the noise could throw a headland out to ~1.8 R
  let fitK = 1;
  if (fit) {
    let m = 0;
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      m = Math.max(m, edge0(a) * Math.hypot(ex * Math.cos(a), ez * Math.sin(a)));
    }
    fitK = m > 0 ? 1 / m : 1;
  }
  const edge = (a) => edge0(a) * fitK;
  const profile0 = (rr) => {
    if (mode === 'mesa') return H * (1 - smooth(0.60, 0.93, rr));
    // TERRACES: a temple plateau, a broad step below it, then the beach
    if (mode === 'terrace') return H * (1 - 0.45 * smooth(0.34, 0.46, rr) - 0.55 * smooth(0.66, 0.93, rr));
    if (mode === 'peak') return H * Math.pow(Math.max(0, 1 - rr), 1.35);
    if (mode === 'flat') return H * (1 - smooth(0.74, 0.98, rr));
    if (mode === 'atoll') return H * (smooth(0.14, 0.4, rr) - smooth(0.55, 0.92, rr));
    return H * (1 - smooth(0.15, 0.95, rr)) * (0.75 + 0.25 * Math.cos(rr * 3));
  };
  // a LAGOON: the heart of an atoll drowned under clear shallow water
  const profile = lagoon > 0
    ? (rr) => profile0(rr) - (H + 0.9) * lagoon * (1 - smooth(0.12, 0.34, rr))
    : profile0;
  // CLIFFS on one side: the land holds its height right to the coast and
  // drops sheer (cliff.a = bearing, cliff.k = strength 0..1)
  const cliffK = (a) => {
    if (!cliff) return 0;
    const c = Math.cos(a - cliff.a);
    return c > 0 ? (cliff.k ?? 0.8) * c * c : 0;
  };
  const profileAt = (rr, a) => {
    const k = cliffK(a);
    const base = profile(rr);
    if (k <= 0) return base;
    const top = Math.max(base, H * 0.85 * (1 - smooth(0.9, 0.995, rr)));
    return base + (top - base) * k;
  };
  const heightAt = (rr) => Math.max(0, profile(Math.min(rr, 1)));
  const relief = (px, pz, rr) =>
    1 + (fbm(px * 0.16 + 5.1, pz * 0.16 - 8.7) - 0.5)
        * 0.8 * rugged * smooth(0.4, 0.95, Math.min(rr, 1));

  // normalized radius of a local point (1 = the nominal coast)
  const radiusOf = (x, z) => {
    const ax = x / ex, az = z / ez;
    return Math.hypot(ax, az) / (R * edge(Math.atan2(az, ax)) || 1);
  };
  const BEACH = dry ? 0.03 : 0.16;       // land height at the nominal coast (rr = 1)
  // full surface: land inside rr<1, beach + shelf beyond
  const surface = (x, z) => {
    const rr = radiusOf(x, z);
    if (rr <= 1) {
      // the land, easing onto a low beach berm at the coast (no lip, no cliff edge)
      // …then down the foreshore so the WATERLINE sits at the nominal coast
      // (rr = 1): the isle's footprint is exactly the radius gameplay expects
      const a = Math.atan2(z / ez, x / ex);
      const land = profileAt(rr, a);
      // (a lagoon's floor sits UNDER the sea: no relief lifting it to land)
      return (land < 0 ? land : land * relief(x, z, rr)) + BEACH * smooth(0.55, 0.9, rr)
             - (BEACH + 0.36) * smooth(0.9, 1.0, rr);
    }
    // foreshore → shelf → drop-off, with a little wander so the shallows aren't a ring
    const w = (fbm(x * 0.11 + 3.3, z * 0.11 - 6.1) - 0.5);
    const s1 = smooth(1.0, 1.42 + w * 0.22, rr);
    const s2 = smooth(1.3 + w * 0.2, 1.92, rr);
    return -0.36 - 2.3 * s1 - 24 * s2 * s2;
  };
  const surfaceY = (x, z) => {
    const rr = Math.min(1, radiusOf(x, z));
    return Math.max(0, profileAt(rr, Math.atan2(z / ez, x / ex))) * relief(x, z, rr);
  };
  const place = (a, rr) => {
    const wr = rr * R * edge(a);
    const x = Math.cos(a) * wr * ex, z = Math.sin(a) * wr * ez;
    return { x, y: Math.max(0, profileAt(Math.min(rr, 1), a)) * relief(x, z, rr), z };
  };
  /* the true coast (waterline) at bearing `a` — for docks and stacks */
  const coastAt = (a) => {
    // place() takes the PARAMETRIC angle; solve for the world bearing a
    const pa = Math.atan2(Math.sin(a) / ez, Math.cos(a) / ex);
    const wr = R * edge(pa);
    return { x: Math.cos(pa) * wr * ex, z: Math.sin(pa) * wr * ez, pa };
  };

  /* ── mesh: regular grid, trimmed to the shelf's footprint ── */
  const reach = shelf ? 1.95 : 1.06;
  // edge() tops out ≈ 1.3 unfitted; a fitted coast never passes R
  const ext = R * (fit ? 1.03 : 1.32 * Math.max(ex, ez)) * reach;
  // (a fitted isle spends its grid on a tighter square: cap it so an island
  // stays near ~4k triangles however large the Pharos rock grows)
  const N = fit ? Math.max(28, Math.min(58, Math.round(ext * 2 / 0.9)))
                : Math.max(28, Math.min(76, Math.round(ext * 2 / 0.72)));
  const step = (ext * 2) / N;
  const W = N + 1;
  const hgt = new Float32Array(W * W);
  const rrs = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const x = -ext + i * step, z = -ext + j * step;
      hgt[j * W + i] = surface(x, z);
      rrs[j * W + i] = radiusOf(x, z);
    }
  }
  const pos = [], col = [], uvs = [], nor = [], remap = new Int32Array(W * W).fill(-1);
  const c = new THREE.Color(), c2 = new THREE.Color();
  const hAt = (i, j) => hgt[Math.min(N, Math.max(0, j)) * W + Math.min(N, Math.max(0, i))];
  let count = 0;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const rr = rrs[j * W + i];
      if (rr > reach + 0.12) continue;
      const x = -ext + i * step, z = -ext + j * step;
      const y = hgt[j * W + i];
      // analytic-ish normal from the height grid
      const nx = (hAt(i - 1, j) - hAt(i + 1, j)) / (2 * step);
      const nz = (hAt(i, j - 1) - hAt(i, j + 1)) / (2 * step);
      const inv = 1 / Math.hypot(nx, 1, nz);
      const slope = 1 - inv;                              // 0 flat → 1 vertical

      const n = fbm(x * 0.42 + 11.3, z * 0.42 - 23.9);
      const n2 = fbm(x * 1.3 - 4.7, z * 1.3 + 9.2);
      const dither = (n - 0.5) * 0.24;
      const beachTop = Math.min(0.36, 0.20 + H * 0.06) + dither * Math.min(0.6, H * 0.3);
      const hFrac = y / Math.max(H, 0.001);
      if (!dry && (y < BEACH * 0.4 || rr > 1.0)) {
        c.copy(P.sandWet).lerp(P.sand, smooth(SEA, BEACH, y) * 0.6);
        if (y < SEA - 0.3) c.lerp(P.rockDark, smooth(SEA - 0.5, SEA - 6, y) * 0.5);
      } else {
        // meadow in two tones, sun-dried patches
        c.copy(P.grass).lerp(P.grass2, fbm(x * 0.5 - 31.7, z * 0.5 + 47.3));
        c.lerp(P.sand, smooth(0.62, 0.92, n) * 0.16);
        c.multiplyScalar(0.92 + n2 * 0.16);
        // beach → meadow, dithered so the shore is never a hard ring
        // the beach is the outer rim of the island (and anything barely above
        // the tide), whatever the height profile — never half the isle
        const k = Math.min(smooth(0.03, 0.03 + Math.min(0.3, 0.1 + H * 0.1), y),
                           1 - smooth(0.80 + dither * 0.5, 0.93 + dither * 0.5, rr));
        c2.copy(P.sand).multiplyScalar(0.96 + n2 * 0.08);
        c.lerpColors(c2, c, k);
        // rock: wherever it's steep, plus mode accents
        let rockK = smooth(0.16, 0.34, slope + dither * 0.35);
        if (mode === 'mesa') rockK = Math.max(rockK, smooth(0.5, 0.62, rr + dither * 0.5) * (1 - smooth(0.9, 0.98, rr)) * smooth(0.08, 0.3, slope + 0.1));
        if (mode === 'peak') rockK = Math.max(rockK, smooth(0.5, 0.72, hFrac + dither));
        if (rockK > 0) {
          c2.copy(P.rock).lerp(P.rockDark, smooth(0.3, 0.75, n2) * 0.6 + (mode === 'peak' ? smooth(0.55, 1, hFrac) * 0.35 : 0));
          c.lerp(c2, Math.min(1, rockK) * k);
        }
      }
      remap[j * W + i] = count++;
      pos.push(x, y, z);
      nor.push(nx * inv, inv, nz * inv);
      col.push(c.r, c.g, c.b);
      uvs.push(x / GROUND_TILE, z / GROUND_TILE);
    }
  }
  const idx = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = remap[j * W + i], b = remap[j * W + i + 1];
      const d = remap[(j + 1) * W + i], e = remap[(j + 1) * W + i + 1];
      if (a < 0 || b < 0 || d < 0 || e < 0) continue;
      // split along the diagonal with the smaller height difference
      if (Math.abs(hgt[j * W + i] - hgt[(j + 1) * W + i + 1]) <= Math.abs(hgt[j * W + i + 1] - hgt[(j + 1) * W + i])) {
        idx.push(a, d, e, a, e, b);
      } else {
        idx.push(a, d, b, b, d, e);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, makeGroundMaterial({ tide: !dry }));
  mesh.receiveShadow = true;
  mesh.castShadow = H > 2.2;            // only real hills throw a shadow
  if (!dry) mesh.layers.enable(SHORE_LAYER);
  mesh.name = 'terrain';

  /* ── ground cover: grass tufts, low bushes, beach pebbles (instanced) ── */
  const coverKind = cover ?? palette.cover ?? 'meadow';
  if (coverKind !== 'none') {
    const crng = mulberry32((seed ^ 0x51ed27) >>> 0);
    const area = Math.PI * R * R * ex * ez;
    const tufts = [], bushes = [], stones = [];
    const tries = R < 3 ? 0 : Math.min(420, Math.round(area * 1.6));
    const beachTop = Math.min(0.36, 0.20 + H * 0.06);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < tries; i++) {
      const x = (crng() * 2 - 1) * ext / reach * 1.08, z = (crng() * 2 - 1) * ext / reach * 1.08;
      const rr = radiusOf(x, z);
      if (rr > 1.02) continue;
      const y = surface(x, z);
      const sl = Math.hypot(surface(x + 0.3, z) - surface(x - 0.3, z), surface(x, z + 0.3) - surface(x, z - 0.3)) / 0.6;
      const n = fbm(x * 0.5 - 31.7, z * 0.5 + 47.3);
      const roll = crng();
      const heart = rr < 0.3 && mode !== 'peak' && mode !== 'hill';   // keep building floors clear
      if (y > 0.2 && rr < 0.84 && sl < 0.5 && !heart && coverKind === 'meadow') {
        if (roll < 0.05 && rr > 0.34 && bushes.length < 12) {
          bushes.push([x, y, z, 0.45 + crng() * 0.5, crng() * 6.28, n]);
        } else if (roll < 0.8 && tufts.length < 170) {
          tufts.push([x, y, z, 0.6 + crng() * 0.8, crng() * 6.28, n]);
        }
      } else if (roll < 0.09 && stones.length < 26 && y > SEA - 0.1 && (rr > 0.86 || sl >= 0.5 || coverKind === 'rocks')) {
        stones.push([x, y, z, 0.12 + crng() * crng() * 0.5, crng() * 6.28, n]);
      }
    }
    const put = (list, geo, mat, colorOf, sy = 1) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const cc = new THREE.Color();
      list.forEach(([x, y, z, s, ry, n], i) => {
        q.setFromAxisAngle(yAxis, ry);
        m4.compose(pp.set(x, y - 0.03 * s, z), q, sc.set(s, s * sy, s));
        im.setMatrixAt(i, m4);
        im.setColorAt(i, colorOf(cc, n));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.receiveShadow = true;
      im.castShadow = false;
      im.name = 'cover';
      mesh.add(im);
    };
    put(tufts, tuftGeometry(), coverMaterial(), (cc, n) =>
      cc.copy(P.grass).lerp(P.grass2, n * 0.7).multiplyScalar(1.0 + crng() * 0.3));
    put(bushes, bushGeometry(), coverMaterial(), (cc, n) =>
      cc.copy(P.grass2).lerp(P.grass, n * 0.5).multiplyScalar(0.72 + crng() * 0.22), 0.72);
    put(stones, stoneGeometry(), stoneMaterial(), (cc, n) =>
      cc.copy(P.rock).lerp(P.sand, 0.25 + n * 0.35).multiplyScalar(0.85 + crng() * 0.25), 0.62);
  }

  return { mesh, heightAt, place, surfaceY, rng, coastAt, R };
}

/* ── ground-cover geometry (shared, built once) ──────────────────────────── */
let _tuftGeo = null, _bushGeo = null, _stoneGeo = null, _coverMat = null, _stoneMat = null;
function tuftGeometry() {
  if (_tuftGeo) return _tuftGeo;
  // four curved blades fanned from one root; vertex colour darkens the base
  const pos = [], col = [], nor = [], idx = [];
  const rnd = mulberry32(991);
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2 + rnd() * 0.6;
    const lean = 0.16 + rnd() * 0.26, h = 0.24 + rnd() * 0.2, w = 0.08 + rnd() * 0.04;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    const base = pos.length / 3;
    for (let k = 0; k <= 2; k++) {
      const t = k / 2, off = lean * t * t, ww = w * (1 - t * 0.85);
      const cx = dx * (0.05 + off), cz = dz * (0.05 + off), y = h * t;
      pos.push(cx - px * ww, y, cz - pz * ww, cx + px * ww, y, cz + pz * ww);
      const shade = 0.72 + 0.28 * t;
      col.push(shade, shade, shade, shade, shade, shade);
      nor.push(dx * 0.3, 0.95, dz * 0.3, dx * 0.3, 0.95, dz * 0.3);   // up-facing: lit like the meadow
    }
    for (let k = 0; k < 2; k++) {
      const o = base + k * 2;
      // both windings, same up-facing normals: a blade is lit alike from either side
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  _tuftGeo = g;
  return g;
}
function lumpGeometry(seed, detail, jitter) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    const k = 1 + ((h - Math.floor(h)) - 0.5) * jitter;
    p.setXYZ(i, x * k, Math.max(-0.25, y * k), z * k);
    const shade = 0.7 + 0.3 * Math.max(0, y);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
function bushGeometry() { return _bushGeo || (_bushGeo = lumpGeometry(3.1, 1, 0.38)); }
function stoneGeometry() { return _stoneGeo || (_stoneGeo = lumpGeometry(8.7, 0, 0.5)); }
function coverMaterial() {
  return _coverMat || (_coverMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0 }));
}
function stoneMaterial() {
  return _stoneMat || (_stoneMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0, flatShading: true }));
}

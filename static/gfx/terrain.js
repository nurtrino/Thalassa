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

export function makeGroundMaterial({ bump = 0.6, extra = {} } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0,
    map: groundGrainTexture(), bumpMap: groundReliefTexture(), bumpScale: bump,
    ...extra,
  });
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
export function makeTerrain({ seed, R, H, mode = 'hill', palette = {}, lobes = 0, shelf = true }) {
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
  const gShift = (rng() - 0.5) * 0.06, sShift = (rng() - 0.5) * 0.03;
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
  const edge = (a) => (0.78 + 0.52 * rugged
                        * fbm(Math.cos(a) * 2.3 + eoff, Math.sin(a) * 2.3 + eoff))
                      * (1 + lobes * Math.sin(2 * a + ephase));
  const profile = (rr) => {
    if (mode === 'mesa') return H * (1 - smooth(0.52, 0.88, rr));
    if (mode === 'peak') return H * Math.pow(Math.max(0, 1 - rr), 1.35);
    if (mode === 'flat') return H * (1 - smooth(0.7, 0.97, rr));
    if (mode === 'atoll') return H * (smooth(0.14, 0.4, rr) - smooth(0.55, 0.92, rr));
    return H * (1 - smooth(0.15, 0.95, rr)) * (0.75 + 0.25 * Math.cos(rr * 3));
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
  const BEACH = 0.16;                    // land height at the nominal coast (rr = 1)
  // full surface: land inside rr<1, beach + shelf beyond
  const surface = (x, z) => {
    const rr = radiusOf(x, z);
    if (rr <= 1) {
      // the land, easing onto a low beach berm at the coast (no lip, no cliff edge)
      return Math.max(0, profile(rr)) * relief(x, z, rr) + BEACH * smooth(0.55, 1.0, rr);
    }
    // foreshore → shelf → drop-off, with a little wander so the shallows aren't a ring
    const w = (fbm(x * 0.11 + 3.3, z * 0.11 - 6.1) - 0.5);
    const s1 = smooth(1.0, 1.42 + w * 0.22, rr);
    const s2 = smooth(1.3 + w * 0.2, 1.92, rr);
    return BEACH - 2.6 * s1 - 24 * s2 * s2;
  };
  const surfaceY = (x, z) => {
    const rr = Math.min(1, radiusOf(x, z));
    return Math.max(0, profile(rr)) * relief(x, z, rr);
  };
  const place = (a, rr) => {
    const wr = rr * R * edge(a);
    const x = Math.cos(a) * wr * ex, z = Math.sin(a) * wr * ez;
    return { x, y: Math.max(0, profile(Math.min(rr, 1))) * relief(x, z, rr), z };
  };

  /* ── mesh: regular grid, trimmed to the shelf's footprint ── */
  const reach = shelf ? 1.95 : 1.06;
  const ext = R * 1.32 * Math.max(ex, ez) * reach;       // edge() tops out ≈ 1.3
  const N = Math.max(36, Math.min(112, Math.round(ext * 2 / 0.42)));
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
      const beachTop = Math.min(0.5, 0.26 + H * 0.12) + dither * Math.min(1, H * 0.55);
      const hFrac = y / Math.max(H, 0.001);
      if (y < BEACH * 0.4 || rr > 1.0) {
        c.copy(P.sandWet).lerp(P.sand, smooth(SEA, BEACH, y) * 0.6);
        if (y < SEA - 0.3) c.lerp(P.rockDark, smooth(SEA - 0.5, SEA - 6, y) * 0.5);
      } else {
        // meadow in two tones, sun-dried patches
        c.copy(P.grass).lerp(P.grass2, fbm(x * 0.5 - 31.7, z * 0.5 + 47.3));
        c.lerp(P.sand, smooth(0.62, 0.92, n) * 0.16);
        c.multiplyScalar(0.92 + n2 * 0.16);
        // beach → meadow, dithered so the shore is never a hard ring
        const k = smooth(beachTop, beachTop + Math.min(0.42, 0.18 + H * 0.2), y);
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

  const mesh = new THREE.Mesh(geo, makeGroundMaterial());
  mesh.receiveShadow = true;
  mesh.castShadow = H > 2.2;            // only real hills throw a shadow
  mesh.layers.enable(SHORE_LAYER);
  mesh.name = 'terrain';

  return { mesh, heightAt, place, surfaceY, rng };
}

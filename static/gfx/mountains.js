/*
 * gfx/mountains.js — mountain ranges as real, lit terrain.
 *
 * makeRidge() raises a band of ridged-noise mountains along an arc (a full
 * ring for the hub's great wall, a crescent for a realm's horizon). It is a
 * single heightfield mesh: roots under the waterline, scrubby foothills,
 * banded rock faces, snow on the high shoulders. Because it is ordinary lit
 * geometry it takes the stage's sun, sky ambient and aerial haze like
 * everything else — the peaks stand clear of the fog their feet are lost in.
 *
 * gates: [{angle, width}] carve sheer-walled passes straight through.
 */
import * as THREE from 'three';
import { mulberry32 } from '../util.js';
import { makeNoise2D, makeGroundMaterial, SHORE_LAYER, GROUND_TILE } from './terrain.js';

const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function makeRidge({
  radius = 560,            // inner edge of the range (where it meets the sea)
  depth = 250,             // how far back the range runs
  height = 120,            // tallest summits
  arcStart = 0, arcLength = Math.PI * 2,
  gates = [],              // [{angle, width}]
  palette = {},            // {rock, rockDark, foot, snow, strata}
  snowline = 0.72,         // fraction of height where snow begins (>1 = none)
  seed = 1,
  segsPerUnit = 0.2,       // angular resolution along the inner edge
  rows = 30,
  rootY = -7,
  jag = 1,                 // 0 = rolling hills, 1 = alpine
}) {
  const rng = mulberry32(seed);
  const n1 = makeNoise2D((seed * 7919) >>> 0);
  const n2 = makeNoise2D((seed * 104729 + 13) >>> 0);
  const rock = new THREE.Color(palette.rock ?? 0x8f8a80);
  const rockDark = new THREE.Color(palette.rockDark ?? rock.clone().multiplyScalar(0.58));
  const strata = new THREE.Color(palette.strata ?? rock.clone().lerp(new THREE.Color(0xd9b98a), 0.35));
  const foot = new THREE.Color(palette.foot ?? 0x6f7f4e);
  const snow = new THREE.Color(palette.snow ?? 0xf4f8fa);
  const full = arcLength >= Math.PI * 2 - 1e-3;
  const segs = Math.max(48, Math.round(radius * arcLength * segsPerUnit));
  const o1 = rng() * 500, o2 = rng() * 500;

  const ridged = (x, z) => {
    let a = 0.5, s = 0, f = 1, norm = 0;
    for (let i = 0; i < 5; i++) {
      const v = (i % 2 ? n2 : n1)(x * f + o1 + i * 31.7, z * f + o2 - i * 17.3);
      const r = 1 - Math.abs(2 * v - 1);
      s += a * (jag > 0.5 ? r * r : (r * 0.6 + v * 0.4));
      norm += a; a *= 0.5; f *= 2.07;
    }
    return s / norm;
  };

  const gateCut = (theta, r) => {
    let k = 1;
    for (const g of gates) {
      const d = Math.abs(wrap(theta - g.angle)) * r;
      const half = (g.width ?? 26) / 2;
      k = Math.min(k, smooth(half, half + 30, d));
    }
    return k;
  };
  // ends of a crescent taper into the sea rather than stopping dead
  const endTaper = (t) => (full ? 1 : smooth(0, 0.12, t) * smooth(1, 0.88, t));

  const heightAt = (theta, u, t) => {
    const r = radius + u * depth;
    const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
    const env = smooth(0.0, 0.34, u) * (1 - smooth(0.72, 1.0, u) * 0.75);
    const big = ridged(x * 0.0058, z * 0.0058);
    const massif = 0.45 + 0.55 * n1(x * 0.0021 + 91, z * 0.0021 - 47);   // some stretches loom
    let h = env * (0.18 + 0.82 * big) * massif * height;
    h *= gateCut(theta, r) * endTaper(t);
    return rootY + h + smooth(0, 0.1, u) * (0 - rootY) * gateCutFloor(theta, r);
  };
  // inside a pass the floor stays under water so ships sail through
  const gateCutFloor = (theta, r) => gateCut(theta, r);

  const W = segs + (full ? 0 : 1), H = rows + 1;
  const P = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) {
    const u = Math.pow(j / rows, 1.15);
    for (let i = 0; i < W; i++) {
      const t = i / segs;
      const theta = arcStart + t * arcLength;
      const r = radius + u * depth;
      const k = (j * W + i) * 3;
      P[k] = Math.cos(theta) * r;
      P[k + 1] = heightAt(theta, u, t);
      P[k + 2] = Math.sin(theta) * r;
    }
  }
  const at = (i, j) => {
    const ii = full ? ((i % W) + W) % W : Math.min(W - 1, Math.max(0, i));
    const jj = Math.min(H - 1, Math.max(0, j));
    return (jj * W + ii) * 3;
  };
  const nor = new Float32Array(W * H * 3);
  const col = new Float32Array(W * H * 3);
  const uvs = new Float32Array(W * H * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  const c = new THREE.Color(), c2 = new THREE.Color();
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 3;
      const l = at(i - 1, j), r = at(i + 1, j), d = at(i, j - 1), up = at(i, j + 1);
      a.set(P[r] - P[l], P[r + 1] - P[l + 1], P[r + 2] - P[l + 2]);
      b.set(P[up] - P[d], P[up + 1] - P[d + 1], P[up + 2] - P[d + 2]);
      n.crossVectors(b, a).normalize();
      if (n.y < 0) n.multiplyScalar(-1);
      nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z;
      const x = P[k], y = P[k + 1], z = P[k + 2];
      const hf = Math.max(0, y) / height;
      const slope = 1 - n.y;
      const grain = n2(x * 0.05 + 7, z * 0.05 - 3);
      // rock faces, banded with strata that tilt gently across the range
      const band = 0.5 + 0.5 * Math.sin(y * 0.33 + n1(x * 0.012, z * 0.012) * 9 + x * 0.004);
      c.copy(rockDark).lerp(rock, 0.35 + grain * 0.65);
      c.lerp(strata, smooth(0.62, 0.95, band) * 0.5);
      // scrub and scree on the gentle lower slopes
      const footK = (1 - smooth(0.10, 0.34, hf + (grain - 0.5) * 0.12)) * (1 - smooth(0.22, 0.5, slope));
      c2.copy(foot).multiplyScalar(0.8 + grain * 0.4);
      c.lerp(c2, footK * 0.85);
      // snow lies where the ground is high and not too steep
      const snowK = smooth(snowline - 0.06, snowline + 0.08, hf + (grain - 0.5) * 0.14)
                  * (1 - smooth(0.42, 0.7, slope));
      c.lerp(snow, snowK);
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      uvs[(j * W + i) * 2] = x / (GROUND_TILE * 3);
      uvs[(j * W + i) * 2 + 1] = z / (GROUND_TILE * 3);
    }
  }
  const idx = [];
  const cols = full ? W : W - 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const i1 = full ? (i + 1) % W : i + 1;
      const p = j * W + i, q = j * W + i1, r = (j + 1) * W + i, s = (j + 1) * W + i1;
      idx.push(p, q, r, q, s, r);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, makeGroundMaterial({ bump: 1.6 }));
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.layers.enable(SHORE_LAYER);
  mesh.name = 'ridge';
  return mesh;
}

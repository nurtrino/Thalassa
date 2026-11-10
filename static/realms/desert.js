/*
 * realms/desert.js — the Bleached Reach: a dune sea crossed on foot.
 *
 * Mood: blazing noon. Hard overhead sun, bleached haze, vast and ancient.
 *
 *   makeDesertGround   the walked-on floor. Transverse dunes with sharp
 *                      wind-cut crests and soft slip faces, marching away
 *                      from the sun so every slip face falls into shade. The
 *                      trail corridor and every stop stay dead flat; dunes
 *                      rise away from the road no steeper than the lowest
 *                      camera's sight line, so nothing ever hides the captain.
 *                      The mesh is aligned to the wind and its vertices are
 *                      snapped onto the crest lines, so crests are real edges.
 *                      Wind ripples and the packed trail are painted in the
 *                      material (no extra geometry).
 *   makeDesertField    the set dressing: half-buried colonnades, colossal
 *                      statue fragments, the ribs of something enormous,
 *                      cairns and dead scrub. The far horizon stays bare by
 *                      design (sand dissolving into haze) — the MIDDLE
 *                      distance carries the ruins and the dune ridgelines.
 *   desertWaypoint     an open stop on the trek: a worn ring of flagstones
 *                      and a traveller's cairn beside it.
 *   makeOasis          the haven's pool: still water, wet sand, reeds, a well.
 *   sandApron          feathers a stop's raised pad into the dune floor.
 */
import * as THREE from 'three';
import { mulberry32, hashStr } from '../util.js';
import { makeGroundMaterial, makeNoise2D, groundGrainTexture, GROUND_TILE } from '../gfx/terrain.js';
import { lookFor } from '../gfx/looks.js';
import { propGroup } from '../props.js';
import {
  smooth, clamp01, makeSegDist, trailStops, makeTrailField, TRAIL_GLSL, NOISE_GLSL,
  addWorldVaryings, tint, merge, lumpGeometry, taperTube, warningStake,
} from './footkit.js';

const GY = -0.04;                      // floor datum: a hair under the stops' pads
const frac = (x) => x - Math.floor(x);

/* the wind blows AWAY from the sun (a little off-axis), so slip faces — the
   steep lee sides — turn from the light and the dune sea reads in relief even
   under a noon sun */
function windDir() {
  const az = THREE.MathUtils.degToRad((lookFor('desert').sun.az ?? 27) + 180 + 24);
  return { x: Math.cos(az), z: Math.sin(az) };
}

/* ── the dune field: one height function for mesh, props and placement ──── */
const SYS = [
  // megadunes: long, high, slow — the ridgelines of the middle distance
  { lam: 176, c: 0.72, warp: 0.46, wl: 420, off: 3.7 },
  // the near dunes that ride on and between them
  { lam: 40, c: 0.74, warp: 0.6, wl: 120, off: 11.1 },
];
const profile = (s, c) => (s < c ? Math.pow(s / c, 1.7) : Math.pow(1 - (s - c) / (1 - c), 1.5));

function makeDuneField(cx, cz, segs) {
  const noise = makeNoise2D(hashStr('reach:dunes'));
  const fbm = (x, z) => (noise(x, z) + 0.5 * noise(x * 2.07 + 31.4, z * 2.07 - 12.9)) / 1.5;
  const segD = makeSegDist(segs);
  // every stop keeps a flat apron; dead ends (the pass, the tomb) a wider one
  const stops = trailStops(segs).map((s) => ({ x: s.x, z: s.z, r: s.deg <= 1 ? 20 : 13 }));
  const trailD = (x, z) => {
    let d = segs.length ? segD(x, z) : 1e9;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const e = Math.hypot(s.x - x, s.z - z) - s.r;
      if (e < d) d = e;
    }
    return d;
  };
  const w = windDir();
  const phase = (k, u, v) => {
    const S = SYS[k];
    return u / S.lam + S.off + S.warp * (fbm(v / S.wl + S.off, u / (S.wl * 2.5) - S.off) * 2 - 1);
  };
  const out = { h: 0, dl: 0, amp: 0, crest: 0, lane: 0 };
  // full sample at world (x,z); fills `out`, returns the height
  const sample = (x, z) => {
    const dl = trailD(x, z);
    out.dl = dl;
    const L = smooth(6, 22, dl);
    out.lane = L;
    if (L <= 0) { out.h = 0; out.amp = 0; out.crest = 0; return 0; }
    const lx = x - cx, lz = z - cz;
    const u = lx * w.x + lz * w.z, v = -lx * w.z + lz * w.x;
    // the amphitheatre rule: dunes rise away from the road at ≤ 0.24 — under
    // the lowest chase camera's sight line to the captain
    const cap = 0.24 * Math.max(0, dl - 6);
    const far = smooth(60, 260, dl);
    const s0 = frac(phase(0, u, v)), s1 = frac(phase(1, u, v));
    const env0 = 0.4 + 0.6 * fbm(lx / 520 + 7.7, lz / 520 - 3.1);
    const a0 = Math.min((8 + 15 * far) * env0, cap);
    const slip0 = s0 > SYS[0].c ? Math.sin(Math.PI * (s0 - SYS[0].c) / (1 - SYS[0].c)) : 0;
    const env1 = 0.4 + 0.6 * smooth(0.22, 0.6, fbm(lx / 170 - 11.3, lz / 170 + 4.9));
    const a1 = Math.min(5.2 * env1 * (1 - 0.75 * slip0), cap);
    const base = (fbm(lx / 85 + 2.2, lz / 85 + 9.1) - 0.5) * 1.8;
    const h = (base + a0 * profile(s0, SYS[0].c) + a1 * profile(s1, SYS[1].c)) * L;
    out.h = h;
    out.amp = (a0 + a1) * L;
    // how close to a crest line (world units → 0..1), weighted by its dune
    const c0 = Math.abs(s0 - SYS[0].c) * SYS[0].lam, c1 = Math.abs(s1 - SYS[1].c) * SYS[1].lam;
    out.crest = Math.max((1 - smooth(0, 7, c0)) * clamp01(a0 / 5), (1 - smooth(0, 3, c1)) * clamp01(a1 / 2.5)) * L;
    return h;
  };
  const heightAt = (x, z) => sample(x, z);
  // signed along-wind distance from (u,v) to the nearest crest of system k
  const crestOffset = (k, u, v) => {
    let d = SYS[k].c - frac(phase(k, u, v));
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return d * SYS[k].lam;
  };
  return { heightAt, sample, out, trailD, stops, wind: w, crestOffset, fbm };
}

/* ── wind ripples: a tileable slope + height map (RG = slope, B = height) ── */
let _rippleTex = null;
function rippleTexture() {
  if (_rippleTex) return _rippleTex;
  const S = 512, N = 26, TAU = Math.PI * 2;
  const H = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const V = y / S;
    for (let x = 0; x < S; x++) {
      const U = x / S;
      const warp = 0.42 * Math.sin(TAU * (V * 2 + 0.13))
                 + 0.26 * Math.sin(TAU * (V * 5 + U) + 1.7)
                 + 0.14 * Math.sin(TAU * (V * 9 - U * 2) + 4.1)
                 + 0.09 * Math.sin(TAU * (U * 3 + V * 13) + 0.6);
      const ph = TAU * (N * U + warp);
      const a = 0.72 + 0.28 * Math.sin(TAU * (U * 3 + V * 4) + 2.0);
      H[y * S + x] = (0.5 + 0.5 * Math.sin(ph + 0.65 * Math.sin(ph))) * a;
    }
  }
  const data = new Uint8Array(S * S * 4);
  const at = (x, y) => H[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.6, dy = (at(x, y + 1) - at(x, y - 1)) * 2.6;
      data[o] = 127.5 + 127.5 * Math.max(-1, Math.min(1, dx));
      data[o + 1] = 127.5 + 127.5 * Math.max(-1, Math.min(1, dy));
      data[o + 2] = 255 * at(x, y);
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  _rippleTex = t;
  return t;
}

function sandMaterial(trail, wind) {
  const mat = makeGroundMaterial({ bump: 0.22, tide: false, extra: { roughness: 0.9 } });
  const uniforms = {
    ...trail.uniforms,
    uRipple: { value: rippleTexture() },
    uWind: { value: new THREE.Vector2(wind.x, wind.z) },
  };
  mat.onBeforeCompile = (shader) => {
    addWorldVaryings(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uRipple;
        uniform vec2 uWind;
        ${TRAIL_GLSL}
        ${NOISE_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        vec2 rWxz = vWPos.xz;
        float rGrain = fkNoise(rWxz * 0.8) * 0.6 + fkNoise(rWxz * 2.9) * 0.4;
        float rTD = trailDist(rWxz);
        // the packed lane: a firm core, a scuffed margin where feet stray
        float rPath = 1.0 - smoothstep(1.7, 3.0, rTD + (rGrain - 0.5) * 1.7);
        float rScuff = 1.0 - smoothstep(2.6, 7.5, rTD + (rGrain - 0.5) * 3.2);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.95, 0.92, 0.86), rScuff * 0.7);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.80, 0.70, 0.55) * (0.94 + rGrain * 0.12), rPath * 0.9);
        // wind ripples: fine ones underfoot, broad ones that carry to mid distance.
        // Strong on the windward flanks, combed almost smooth on the slip faces
        // and trodden out on the lane.
        vec2 rUv = vec2(dot(rWxz, uWind), dot(rWxz, vec2(-uWind.y, uWind.x)));
        vec4 rFine = texture2D(uRipple, rUv / 9.5);
        vec4 rMega = texture2D(uRipple, rUv / 61.0 + 0.37);
        float rLee = clamp(dot(normalize(vWNrm).xz, uWind) * 2.4, 0.0, 1.0);
        float rAmt = (1.0 - rPath) * (1.0 - rScuff * 0.45) * (1.0 - rLee * 0.7);
        float rFineK = rAmt * (1.0 - smoothstep(12.0, 44.0, length(vViewPosition)));
        float rMegaK = rAmt * 0.6 * smoothstep(0.3, 0.75, fkNoise(rWxz * 0.021 + 3.7));
        diffuseColor.rgb *= 1.0 + (rFine.b - 0.5) * 0.17 * rFineK + (rMega.b - 0.5) * 0.12 * rMegaK;`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
        {
          vec2 rG = (rFine.rg - 0.5) * 1.5 * rFineK + (rMega.rg - 0.5) * 1.25 * rMegaK;
          vec2 rGw = uWind * rG.x + vec2(-uWind.y, uWind.x) * rG.y;
          vec3 rNw = normalize(vWNrm);
          vec3 rNp = normalize(rNw - vec3(rGw.x, 0.0, rGw.y));
          normal = normalize(normal + (viewMatrix * vec4(rNp - rNw, 0.0)).xyz);
        }`);
  };
  mat.customProgramCacheKey = () => 'thalassa-reach-sand-v1';
  return mat;
}

/* a 1-D grid axis: fine over [lo,hi], cells growing geometrically out to ±limit */
function gridAxis(lo, hi, step, growth, limit) {
  const n = Math.max(2, Math.ceil((hi - lo) / step));
  const a = [];
  for (let i = 0; i <= n; i++) a.push(lo + ((hi - lo) * i) / n);
  let s = step, x = hi;
  while (x < limit) { s *= growth; x += s; a.push(x); }
  s = step; x = lo;
  while (x > -limit) { s *= growth; x -= s; a.unshift(x); }
  return a;
}

export function makeDesertGround(theme, size = 3000, opts = {}) {
  const cx = opts.center?.x ?? 0, cz = opts.center?.z ?? 0;
  const segs = opts.segs || [];
  const F = makeDuneField(cx, cz, segs);
  const w = F.wind;
  const half = size / 2;

  /* grid in wind-aligned (u,v): fine over the travelled country, coarse beyond */
  let u0 = -60, u1 = 60, v0 = -60, v1 = 60;
  if (F.stops.length) {
    u0 = v0 = 1e9; u1 = v1 = -1e9;
    for (const s of F.stops) {
      const lx = s.x - cx, lz = s.z - cz;
      const u = lx * w.x + lz * w.z, v = -lx * w.z + lz * w.x;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  }
  const FINE = 3.3, MARGIN = 95;
  const U = gridAxis(u0 - MARGIN, u1 + MARGIN, FINE, 1.2, half);
  const V = gridAxis(v0 - MARGIN, v1 + MARGIN, FINE * 1.15, 1.2, half);
  const NU = U.length, NV = V.length;

  /* vertices: snap each onto a crest line when one passes within half a cell,
     so the crests are continuous mesh edges, not a staircase */
  const px = new Float32Array(NU * NV), pz = new Float32Array(NU * NV), py = new Float32Array(NU * NV);
  const nrm = new Float32Array(NU * NV * 3), col = new Float32Array(NU * NV * 3);
  const sand = new THREE.Color(theme.palette.sand);
  const sandDeep = new THREE.Color(theme.palette.grass2 ?? 0xb99a60);
  const sandHot = sand.clone().lerp(new THREE.Color(0xfff6dc), 0.55);
  const sandLee = new THREE.Color(theme.palette.sandLee ?? 0xb98248);
  const hardpan = new THREE.Color(theme.palette.hardpan ?? 0xd6c59c);
  const c = new THREE.Color();
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      let u = U[i];
      const v = V[j];
      const du = 0.5 * (U[Math.min(NU - 1, i + 1)] - U[Math.max(0, i - 1)]);
      for (let k = 0; k < SYS.length; k++) {
        if (SYS[k].lam < du * 5) continue;
        const d = F.crestOffset(k, u, v);
        if (Math.abs(d) < du * 0.5) { u += d; u += F.crestOffset(k, u, v); break; }
      }
      const x = cx + u * w.x - v * w.z, z = cz + u * w.z + v * w.x;
      const o = j * NU + i;
      const h = F.sample(x, z);
      const amp = F.out.amp, crest = F.out.crest, lane = F.out.lane;
      px[o] = x - cx; pz[o] = z - cz; py[o] = h;
      const e = Math.min(0.8, du * 0.3);
      const nx = (F.heightAt(x - e, z) - F.heightAt(x + e, z)) / (2 * e);
      const nz = (F.heightAt(x, z - e) - F.heightAt(x, z + e)) / (2 * e);
      const inv = 1 / Math.hypot(nx, 1, nz);
      nrm[o * 3] = nx * inv; nrm[o * 3 + 1] = inv; nrm[o * 3 + 2] = nz * inv;
      // colour: bleached crests, warm shaded slip faces, pale gravelly flats
      const n1 = F.fbm((x - cx) / 46 + 5.5, (z - cz) / 46 - 8.2);
      const n2 = F.fbm((x - cx) / 13 - 2.1, (z - cz) / 13 + 6.6);
      c.copy(sandDeep).lerp(sand, 0.5 + n1 * 0.5);
      const lee = smooth(0.1, 0.46, (nx * w.x + nz * w.z) * inv);
      c.lerp(sandLee, lee * 0.75);
      c.lerp(sandHot, crest * 0.7 * (1 - lee));
      const flats = (1 - smooth(0.4, 2.6, amp)) * lane;
      c.lerp(hardpan, flats * (0.25 + n2 * 0.4));
      c.multiplyScalar(0.95 + n2 * 0.1);
      col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
    }
  }

  /* the trail, baked as a distance field for the material to paint */
  let bx0 = cx - 80, bx1 = cx + 80, bz0 = cz - 80, bz1 = cz + 80;
  for (const s of F.stops) {
    bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
    bz0 = Math.min(bz0, s.z); bz1 = Math.max(bz1, s.z);
  }
  const trail = makeTrailField({
    cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2,
    half: Math.max(bx1 - bx0, bz1 - bz0) / 2 + 30, res: 512, reach: 12,
  });
  trail.set(segs, F.stops.map((s) => [s.x, s.z, 1.4]));
  const material = sandMaterial(trail, w);

  /* chunked so the frustum culls what the camera can't see */
  const group = new THREE.Group();
  group.name = 'ground';
  const CH = 44;
  for (let cj = 0; cj < NV - 1; cj += CH) {
    for (let ci = 0; ci < NU - 1; ci += CH) {
      const i1 = Math.min(NU - 1, ci + CH), j1 = Math.min(NV - 1, cj + CH);
      const wN = i1 - ci + 1, hN = j1 - cj + 1;
      const pos = new Float32Array(wN * hN * 3), nor = new Float32Array(wN * hN * 3);
      const cl = new Float32Array(wN * hN * 3), uv = new Float32Array(wN * hN * 2);
      for (let j = 0; j < hN; j++) {
        for (let i = 0; i < wN; i++) {
          const o = (cj + j) * NU + ci + i, q = j * wN + i;
          pos[q * 3] = px[o]; pos[q * 3 + 1] = py[o]; pos[q * 3 + 2] = pz[o];
          nor[q * 3] = nrm[o * 3]; nor[q * 3 + 1] = nrm[o * 3 + 1]; nor[q * 3 + 2] = nrm[o * 3 + 2];
          cl[q * 3] = col[o * 3]; cl[q * 3 + 1] = col[o * 3 + 1]; cl[q * 3 + 2] = col[o * 3 + 2];
          uv[q * 2] = px[o] / GROUND_TILE; uv[q * 2 + 1] = pz[o] / GROUND_TILE;
        }
      }
      const idx = [];
      for (let j = 0; j < hN - 1; j++) {
        for (let i = 0; i < wN - 1; i++) {
          const a = j * wN + i, b = a + 1, d = a + wN, e = d + 1;
          // split along the diagonal with the smaller height difference —
          // this is what keeps a crest running corner to corner a clean edge
          if (Math.abs(pos[a * 3 + 1] - pos[e * 3 + 1]) <= Math.abs(pos[b * 3 + 1] - pos[d * 3 + 1])) {
            idx.push(a, d, e, a, e, b);
          } else {
            idx.push(a, d, b, b, d, e);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(cl, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const m = new THREE.Mesh(geo, material);
      m.receiveShadow = true;
      m.castShadow = false;            // a noon sun: dunes shade by their own slope
      m.name = 'ground';
      group.add(m);
    }
  }
  group.position.y = GY;

  const heightAt = (wx, wz) => GY + F.heightAt(wx, wz);
  heightAt.reach = { trailD: F.trailD, wind: w };   // read by makeDesertField
  return { mesh: group, update() {}, heightAt };
}

/* ══ set dressing ═════════════════════════════════════════════════════════ */

let _fluteTex = null;
/* one flute across u (arris → channel → arris), streaked and pitted down v */
function fluteTexture() {
  if (_fluteTex) return _fluteTex;
  const W = 64, Hh = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = Hh;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, Hh);
  const rnd = mulberry32(9917);
  const streak = new Float32Array(Hh);
  for (let y = 0; y < Hh; y++) streak[y] = rnd();
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const t = x / W;
      const ch = 1 - Math.sin(Math.PI * t);               // 1 on the arris, 0 in the channel
      const pit = (rnd() - 0.5) * 0.10 + (streak[y] - 0.5) * 0.10;
      const vv = Math.max(0, Math.min(1, 0.58 + ch * 0.42 + pit));
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 * vv;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _fluteTex = t;
  return t;
}
let _stoneMat = null, _slabMat = null, _boneMat = null;
function ruinMaterial() {
  return _stoneMat || (_stoneMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0,
    map: fluteTexture(), bumpMap: fluteTexture(), bumpScale: 1.6 }));
}
function slabMaterial() {
  return _slabMat || (_slabMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0,
    map: groundGrainTexture(), bumpMap: groundGrainTexture(), bumpScale: 0.5 }));
}
function boneMaterial() {
  return _boneMat || (_boneMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.62, metalness: 0 }));
}

const FLUTES = 20;
/* scale a part's UVs so the flute texture wraps FLUTES times round a shaft;
   blocks get a constant u (sitting on an arris) so they stay smooth-faced */
function fluteUV(geo, vScale, block = false) {
  const uv = geo.attributes.uv, p = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    if (block) uv.setXY(i, 0, p.getY(i) * 0.21 + p.getX(i) * 0.05);
    else uv.setXY(i, uv.getX(i) * FLUTES, uv.getY(i) * vScale);
  }
  return geo;
}

const STONE = 0xe2cfa4, STONE_DK = 0xb89c6c;
/* weathering: darker and warmer toward the sand line, bleached up top */
function weather(geo, y0, y1, seed) {
  const lo = new THREE.Color(STONE_DK), hi = new THREE.Color(STONE);
  const p = geo.attributes.position;
  const colr = new Float32Array(p.count * 3);
  const cc = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const s = Math.sin(p.getX(i) * 3.1 + p.getZ(i) * 2.3 + y * 0.7 + seed) * 0.5 + 0.5;
    const k = clamp01((y - y0) / Math.max(0.01, y1 - y0));
    cc.copy(lo).lerp(hi, Math.pow(k, 0.6) * 0.85 + s * 0.15).multiplyScalar(0.9 + s * 0.14);
    colr[i * 3] = cc.r; colr[i * 3 + 1] = cc.g; colr[i * 3 + 2] = cc.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  return geo;
}

/* one Doric column, base on y=0. kind: 'full' (capital), 'broken', 'stump' */
function columnParts(rng, r, fullH, kind) {
  const parts = [];
  const h = kind === 'full' ? fullH : kind === 'broken' ? fullH * (0.42 + rng() * 0.36) : fullH * (0.1 + rng() * 0.14);
  const RINGS = 7, SEG = 18;
  const rAt = (t) => r * (1 - 0.06 * t - 0.14 * t * t);          // entasis
  const pts = [];
  for (let i = 0; i <= RINGS; i++) pts.push(new THREE.Vector2(rAt((i / RINGS) * (h / fullH)), (i / RINGS) * h));
  const shaft = fluteUV(new THREE.LatheGeometry(pts, SEG), h / (r * 3.2));
  const rTop = rAt(h / fullH);
  if (kind !== 'full') {
    // a ragged break: the top ring dips and rises, capped with a rough face
    const p = shaft.attributes.position;
    const tiltA = rng() * 6.28, tilt = 0.25 + rng() * 0.5;
    const jag = [];
    for (let s = 0; s <= SEG; s++) jag.push((rng() - 0.5) * r * 0.5);
    jag[SEG] = jag[0];
    const cap = [], capUv = [];
    const topY = (s) => {
      const a = (s / SEG) * Math.PI * 2;
      return h + Math.cos(a - tiltA) * rTop * tilt + jag[s];
    };
    for (let s = 0; s <= SEG; s++) p.setY(s * (RINGS + 1) + RINGS, topY(s));
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
      // LatheGeometry sweeps x = r·sin(φ), z = r·cos(φ)
      cap.push(0, h + (rng() - 0.5) * r * 0.3, 0,
               Math.sin(a0) * rTop, topY(s), Math.cos(a0) * rTop,
               Math.sin(a1) * rTop, topY(s + 1), Math.cos(a1) * rTop);
      capUv.push(0, 0.3, 0, 0.6, 0, 0.9);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cap, 3));
    cg.setAttribute('uv', new THREE.Float32BufferAttribute(capUv, 2));
    cg.computeVertexNormals();
    parts.push(cg);
    shaft.computeVertexNormals();
  } else {
    // echinus + abacus
    const ech = fluteUV(new THREE.LatheGeometry([
      new THREE.Vector2(rTop * 0.99, 0), new THREE.Vector2(rTop * 1.06, r * 0.16),
      new THREE.Vector2(rTop * 1.42, r * 0.5), new THREE.Vector2(rTop * 1.48, r * 0.64)], SEG), 1, true);
    ech.translate(0, h, 0);
    const ab = fluteUV(new THREE.BoxGeometry(rTop * 3.1, r * 0.46, rTop * 3.1), 1, true);
    ab.translate(0, h + r * 0.64 + r * 0.23, 0);
    parts.push(ech, ab);
  }
  parts.push(shaft);
  return { parts, h: kind === 'full' ? h + r * 1.1 : h, rTop };
}

/* a ruined colonnade: a row of colossal columns in every state of collapse,
   a run of architrave still bridging the best of them, drums in the sand */
function makeColonnade(rng, heightAt, x0, z0, yaw, scale = 1) {
  const r = 1.25 * scale, fullH = 13.5 * scale, gap = 6.2 * scale;
  const n = 5 + Math.floor(rng() * 3);
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const parts = [];
  const tops = [];
  const seed = rng() * 50;
  const place = (geos, x, y, z, m) => {
    for (const g of geos) {
      if (m) g.applyMatrix4(m);
      g.translate(x, y, z);
      parts.push(g);
    }
  };
  let yMin = 1e9, yMax = -1e9;
  // the row keeps a clear rhythm: most columns standing, the ends ruined
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) * gap;
    const lx = dx * t, lz = dz * t;
    const end = i === 0 || i === n - 1;
    const roll = rng();
    const kind = roll < (end ? 0.2 : 0.55) ? 'full' : roll < 0.85 ? 'broken' : 'stump';
    const col = columnParts(rng, r, fullH, kind);
    const gy = heightAt(x0 + lx, z0 + lz) - 0.9 * scale - rng() * 1.6 * scale;   // sunk in the drift
    place(col.parts, lx, gy, lz, null);
    tops.push(kind === 'full' ? { lx, lz, y: gy + col.h } : null);
    yMin = Math.min(yMin, gy); yMax = Math.max(yMax, gy + col.h);
  }
  // architrave across neighbouring full columns
  for (let i = 0; i < n - 1; i++) {
    const a = tops[i], b = tops[i + 1];
    if (!a || !b || rng() < 0.25) continue;
    const beam = fluteUV(new THREE.BoxGeometry(gap + r * 2.2, r * 1.15, r * 2.3), 1, true);
    const m = new THREE.Matrix4().makeRotationY(-yaw);
    const y = Math.max(a.y, b.y) + r * 0.56;
    place([beam], (a.lx + b.lx) / 2, y, (a.lz + b.lz) / 2, m);
    yMax = Math.max(yMax, y + r);
  }
  // fallen drums and a toppled block or two, half swallowed
  const nd = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nd; i++) {
    const t = (rng() - 0.5) * n * gap, off = (rng() < 0.5 ? -1 : 1) * (2.5 + rng() * 5) * scale;
    const lx = dx * t - dz * off, lz = dz * t + dx * off;
    const len = r * (1.1 + rng() * 1.6);
    const drum = fluteUV(new THREE.CylinderGeometry(r * 0.9, r * 0.94, len, 18, 1), len / (r * 3.2));
    const m = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(Math.PI / 2 + (rng() - 0.5) * 0.5, rng() * 6.28, (rng() - 0.5) * 0.4, 'YXZ'));
    const gy = heightAt(x0 + lx, z0 + lz) + r * (0.1 + rng() * 0.45);
    place([drum], lx, gy, lz, m);
    yMin = Math.min(yMin, gy - r);
  }
  // the stylobate: two worn steps, mostly drifted over
  for (let s = 0; s < 2; s++) {
    const step = fluteUV(new THREE.BoxGeometry(n * gap + r * (3 - s * 1.4), 0.7 * scale, r * (5.2 - s * 1.6)), 1, true);
    const m = new THREE.Matrix4().makeRotationY(-yaw);
    const gy = heightAt(x0, z0) - 0.95 * scale + s * 0.6 * scale;
    place([step], 0, gy, 0, m);
  }
  for (const g of parts) weather(g, yMin, yMin + (yMax - yMin) * 0.8, seed);
  const mesh = new THREE.Mesh(merge(parts), ruinMaterial());
  mesh.position.set(x0, 0, z0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'colonnade';
  return mesh;
}

/* the bleached ribs of something enormous, rising out of a dune */
export function makeGiantRibs(rng, s = 1) {
  const parts = [];
  const n = 8 + Math.floor(rng() * 3);
  const L = n * 1.55 * s;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  // the spine, arched and mostly under the sand
  parts.push(taperTube([V3(-L / 2 - 1.5 * s, -0.5 * s, 0), V3(-L / 4, 0.25 * s, 0.1 * s), V3(L / 4, 0.3 * s, -0.1 * s), V3(L / 2 + 2.5 * s, -0.7 * s, 0)],
    0.42 * s, 0.2 * s, 12, 7));
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = (t - 0.5) * L;
    const bell = Math.sin(Math.PI * (0.12 + t * 0.8));
    const H = (2.2 + 4.0 * bell) * s, W = (1.5 + 2.1 * bell) * s, lean = (0.5 + rng() * 0.5) * s;
    for (const side of [-1, 1]) {
      if (rng() < 0.12) continue;                        // a rib long since fallen
      const k = 0.85 + rng() * 0.3;
      parts.push(taperTube([
        V3(x, -0.6 * s, side * 0.35 * s), V3(x + lean * 0.2, H * 0.5 * k, side * W),
        V3(x + lean * 0.7, H * k, side * W * 0.78), V3(x + lean * 1.2, H * 1.13 * k, side * W * 0.34)],
        0.26 * s, 0.07 * s, 10, 6));
    }
  }
  const bone = new THREE.Color(0xefe7d2), stain = new THREE.Color(0xbfa77c);
  for (const g of parts) {
    const p = g.attributes.position;
    const colr = new Float32Array(p.count * 3);
    const cc = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const k = smooth(-0.2 * s, 2.2 * s, p.getY(i));
      cc.copy(stain).lerp(bone, 0.35 + 0.65 * k);
      colr[i * 3] = cc.r; colr[i * 3 + 1] = cc.g; colr[i * 3 + 2] = cc.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  }
  const mesh = new THREE.Mesh(merge(parts), boneMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.rotation.z = (rng() - 0.5) * 0.22;                // one flank deeper in the drift
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

/* worn flagstones: irregular, bevelled, smooth — a ring the size of a stop */
function flagstones(rng, radius, count, hex = 0xd9c9a2) {
  const parts = [];
  const base = new THREE.Color(hex);
  const cc = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const ring = i === 0 ? 0 : 1;
    const a = ring ? ((i - 1) / (count - 1)) * 6.283 + rng() * 0.3 : 0;
    const rr = ring ? radius * (0.62 + rng() * 0.14) : 0;
    const sz = radius * (ring ? 0.3 + rng() * 0.12 : 0.36);
    const g = lumpGeometry(1, 1, 0.16, rng() * 99, 1.3);
    g.scale(sz * (0.9 + rng() * 0.35), 0.11 + rng() * 0.05, sz * (0.9 + rng() * 0.3));
    g.rotateY(rng() * 6.28);
    g.translate(Math.cos(a) * rr, 0.02, Math.sin(a) * rr);
    cc.copy(base).multiplyScalar(0.84 + rng() * 0.22);
    tint(g, cc.getHex(), (x, y) => 0.8 + clamp01(y * 6) * 0.2);
    parts.push(g);
  }
  const m = new THREE.Mesh(merge(parts), slabMaterial());
  m.receiveShadow = true;
  m.castShadow = false;
  return m;
}

/* a traveller's cairn: wind-smoothed stones stacked high, a few fallen at
   its foot (procedural — a dozen of these cost less than one GLB) */
export function makeCairn(rng, s = 1) {
  const parts = [];
  const cc = new THREE.Color();
  const n = 5 + Math.floor(rng() * 3);
  let y = 0, r = (0.5 + rng() * 0.12) * s;
  for (let i = 0; i < n; i++) {
    const g = lumpGeometry(1, 1, 0.2, rng() * 99, 1.3);
    const h = r * (0.42 + rng() * 0.16);
    g.scale(r * (0.95 + rng() * 0.25), h, r * (0.85 + rng() * 0.2));
    g.rotateY(rng() * 6.28);
    g.rotateZ((rng() - 0.5) * 0.14);
    g.translate((rng() - 0.5) * r * 0.22, y + h * 0.8, (rng() - 0.5) * r * 0.22);
    cc.set(rng() < 0.3 ? 0xb9a27c : 0xd4c19a).multiplyScalar(0.86 + rng() * 0.2);
    const yb = y;
    tint(g, cc.getHex(), (px, py) => 0.72 + clamp01((py - yb) / (h * 1.4)) * 0.3);
    parts.push(g);
    y += h * 1.45;
    r *= 0.8 + rng() * 0.08;
  }
  for (let i = 0; i < 3; i++) {
    const a = rng() * 6.28, d = (0.6 + rng() * 0.5) * s, q = (0.14 + rng() * 0.14) * s;
    const g = lumpGeometry(1, 1, 0.2, rng() * 99);
    g.scale(q * 1.3, q * 0.7, q);
    g.rotateY(rng() * 6.28);
    g.translate(Math.cos(a) * d, q * 0.25, Math.sin(a) * d);
    tint(g, 0xc9b58c, (px, py) => 0.75 + clamp01(py * 3) * 0.25);
    parts.push(g);
  }
  const m = new THREE.Mesh(merge(parts), slabMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  const grp = new THREE.Group();
  grp.add(m);
  return grp;
}

/* an open stop on the trek */
export function desertWaypoint(rng) {
  const g = new THREE.Group();
  g.add(flagstones(rng, 2.3, 7));
  // the marker stands BESIDE the stop — the captain halts on the stones
  const a = rng() * 6.28;
  const marker = makeCairn(rng, 1.15 + rng() * 0.45);
  marker.position.set(Math.cos(a) * 3.3, 0, Math.sin(a) * 3.3);
  g.add(marker);
  if (rng() < 0.3) {
    const b = a + 1.6 + rng() * 2.4;
    const scrub = propGroup('dead_scrub', 0.8 + rng() * 0.6);
    scrub.position.set(Math.cos(b) * 4.6, 0, Math.sin(b) * 4.6);
    scrub.rotation.y = rng() * 6.28;
    g.add(scrub);
  }
  return g;
}

/* feather a stop's raised pad into the dune floor: a soft-edged skirt of
   sand in the floor's own colour (replaces the old ripple rings) */
export function sandApron(R, sandHex) {
  const SEG = 40, RINGS = 3;
  const pos = [], colr = [], uv = [], idx = [];
  const c = new THREE.Color(sandHex);
  const radii = [R * 0.86, R * 1.12, R * 1.5], alpha = [0.0, 0.85, 0.0];
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const wob = 1 + 0.07 * Math.sin(a * 3 + R) + 0.05 * Math.sin(a * 7 + R * 2.3);
      const x = Math.cos(a) * radii[r] * wob, z = Math.sin(a) * radii[r] * wob;
      pos.push(x, 0.012 + (r === 1 ? 0.02 : 0), z);
      colr.push(c.r, c.g, c.b, alpha[r]);
      uv.push(x / GROUND_TILE, z / GROUND_TILE);
    }
  }
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SEG; s++) {
      const a = r * (SEG + 1) + s, b = a + 1, d = a + SEG + 1, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 4));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = makeGroundMaterial({ bump: 0.22, tide: false,
    extra: { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  m.renderOrder = 1;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/* the haven's oasis: a still pool that mirrors the sky, dark wet sand at its
   lip, reeds and rim stones, a well beside it. No palms (by design). */
export function makeOasis(rng, theme, wellAngle = null) {
  const g = new THREE.Group();
  const SEG = 36, R = 2.4;
  const edge = (a) => R * (1 + 0.16 * Math.sin(a * 2 + 1.3) + 0.09 * Math.sin(a * 3 + 4.0) + 0.05 * Math.sin(a * 5));
  // water
  {
    const pos = [0, 0, 0], idx = [];
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      pos.push(Math.cos(a) * edge(a), 0, Math.sin(a) * edge(a));
      if (s < SEG) idx.push(0, s + 2, s + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.water.shallow).lerp(new THREE.Color(theme.water.deep), 0.55),
      roughness: 0.06, metalness: 0.0, envMapIntensity: 1.6,
      emissive: theme.water.deep, emissiveIntensity: 0.12 }));
    water.position.y = 0.07;
    water.receiveShadow = true;
    g.add(water);
  }
  // wet sand lip: dark at the water, feathering out into the dry pad
  {
    const pos = [], colr = [], idx = [], uv = [];
    const wet = new THREE.Color(theme.palette.sand).multiplyScalar(0.5);
    const radii = [0.9, 1.1, 1.42], alpha = [1, 0.9, 0];
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s <= SEG; s++) {
        const a = (s / SEG) * Math.PI * 2;
        const x = Math.cos(a) * edge(a) * radii[r], z = Math.sin(a) * edge(a) * radii[r];
        pos.push(x, 0.035 + (r === 0 ? 0.0 : 0.02), z);
        colr.push(wet.r, wet.g, wet.b, alpha[r]);
        uv.push(x / 6, z / 6);
      }
    }
    for (let r = 0; r < 2; r++) {
      for (let s = 0; s < SEG; s++) {
        const a = r * (SEG + 1) + s, b = a + 1, d = a + SEG + 1, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 4));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const lip = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, depthWrite: false, roughness: 0.35,
      map: groundGrainTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    lip.receiveShadow = true;
    g.add(lip);
  }
  // rim stones
  {
    const parts = [];
    const n = 9 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.28, s = 0.22 + rng() * 0.3;
      const st = lumpGeometry(1, 1, 0.22, rng() * 99);
      st.scale(s * (1 + rng() * 0.5), s * 0.6, s);
      st.rotateY(rng() * 6.28);
      const rr = edge(a) * (1.02 + rng() * 0.16);
      st.translate(Math.cos(a) * rr, s * 0.2, Math.sin(a) * rr);
      tint(st, 0xcdb994, (x, y) => 0.72 + clamp01(y * 3) * 0.3);
      parts.push(st);
    }
    const stones = new THREE.Mesh(merge(parts), slabMaterial());
    stones.castShadow = true;
    stones.receiveShadow = true;
    g.add(stones);
  }
  // reeds crowd one bank; a well stands on the other
  const bank = wellAngle === null ? rng() * 6.28 : wellAngle + Math.PI;
  for (let i = 0; i < 2; i++) {
    const a = bank + (rng() - 0.5) * 1.6;
    const reed = propGroup('reeds', 0.7 + rng() * 0.5);
    const rr = edge(a) * (0.94 + rng() * 0.2);
    reed.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    reed.rotation.y = rng() * 6.28;
    g.add(reed);
  }
  const well = propGroup('stone_well', 0.95);
  well.position.set(Math.cos(bank + Math.PI) * (R + 2.4), 0, Math.sin(bank + Math.PI) * (R + 2.4));
  well.rotation.y = rng() * 6.28;
  g.add(well);
  const jars = propGroup('amphora_pile', 0.9);
  jars.position.set(Math.cos(bank + Math.PI + 0.7) * (R + 2.0), 0, Math.sin(bank + Math.PI + 0.7) * (R + 2.0));
  jars.rotation.y = rng() * 6.28;
  g.add(jars);
  return g;
}

/* wind-rounded sandstone boulders, merged (n stones scattered by `where(i)`) */
function sandstoneBoulders(rng, n, where) {
  const parts = [];
  const cc = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const p = where(i);
    if (!p) continue;
    const r = p.r ?? (0.35 + rng() * 0.55);
    const g = lumpGeometry(1, r > 0.6 ? 2 : 1, 0.24, rng() * 99, 1.4);
    g.scale(r * (1 + rng() * 0.4), r * (0.6 + rng() * 0.25), r);
    g.rotateY(rng() * 6.28);
    g.translate(p.x, p.y + r * 0.22, p.z);
    cc.set(rng() < 0.4 ? 0xb39468 : 0xc9ad7e).multiplyScalar(0.88 + rng() * 0.2);
    const y0 = p.y;
    tint(g, cc.getHex(), (px, py) => 0.7 + clamp01((py - y0) / (r * 0.9)) * 0.32);
    parts.push(g);
  }
  const geo = merge(parts);
  if (!geo) return null;
  const m = new THREE.Mesh(geo, slabMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/* what stands on a stop's pad in the Reach (called from dressIsland).
   Sparse on purpose: each kind of stop gets one clear idea. */
export function dressReachIsland(g, rng, theme, R, terrain, node = null) {
  const type = node?.type;
  const at = (a, rr) => terrain.place(a, rr);
  const put = (o, a, rr, sink = 0.05) => {
    const p = at(a, rr);
    o.position.set(p.x, p.y - sink, p.z);
    g.add(o);
    return o;
  };
  // every pad: a few rounded boulders on its shoulder
  const a0 = rng() * 6.28;
  const rocks = sandstoneBoulders(rng, 3 + Math.floor(rng() * 3), (i) => at(a0 + i * 1.9 + rng(), 0.62 + rng() * 0.25));
  if (rocks) g.add(rocks);
  if (type === 'monster') {
    // a hunting ground: picked ribs arching out of the knoll, bones below
    const ribs = makeGiantRibs(rng, 0.42);
    ribs.rotation.y = rng() * 6.28;
    put(ribs, a0 + 2.6, 0.5, 0.15);
    const heap = propGroup('bone_pile', 1.3);
    heap.rotation.y = rng() * 6.28;
    put(heap, a0 + 4.4, 0.62);
    if (!node.monster) {                         // calm: the warning stake
      const stake = warningStake(rng, 1.25);
      stake.rotation.y = Math.atan2(-node.x, -node.z) + (rng() - 0.5);
      put(stake, 0, 0.12, 0);
    }
  } else if (type === 'lair') {
    for (const side of [-1, 1]) {                // braziers flank the approach
      const b = propGroup('brazier', 1.5);
      const face = Math.atan2(-node.x, -node.z);
      const bx = Math.sin(face) * R * 0.62 + Math.cos(face) * side * 3.4;
      const bz = Math.cos(face) * R * 0.62 - Math.sin(face) * side * 3.4;
      b.position.set(bx, terrain.surfaceY(bx, bz) - 0.05, bz);
      g.add(b);
    }
    const sar = propGroup('sarcophagus', 1.2);
    sar.rotation.y = rng() * 6.28;
    put(sar, a0 + 3.3, 0.78);
  } else if (type === 'shrine') {
    const jars = propGroup('amphora_pile', 1.1);
    jars.rotation.y = rng() * 6.28;
    put(jars, a0 + 2.2, 0.66);
  } else if (type !== 'haven') {
    const scrub = propGroup('dead_scrub', 0.9 + rng() * 0.5);
    put(scrub, a0 + 3.0, 0.7);
  }
}

/* ── the wilds between the stops ─────────────────────────────────────────── */
export function makeDesertField(theme, nodes, segs, rng, heightAt = null) {
  const g = new THREE.Group();
  g.name = 'reachfield';
  if (!nodes.length) return g;
  const groundY = heightAt || (() => 0);
  const segD = makeSegDist(segs);
  const trailD = heightAt?.reach?.trailD || ((x, z) => (segs.length ? segD(x, z) : 1e9));
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const taken = [];
  // a spot whose distance to the trail lies in [d0,d1], clear of other pieces
  const spot = (d0, d1, gap, margin = d1) => {
    for (let t = 0; t < 60; t++) {
      const x = minX - margin + rng() * (maxX - minX + margin * 2);
      const z = minZ - margin + rng() * (maxZ - minZ + margin * 2);
      const d = trailD(x, z);
      if (d < d0 || d > d1) continue;
      let ok = true;
      for (const p of taken) if (Math.hypot(p.x - x, p.z - z) < gap + p.gap) { ok = false; break; }
      if (!ok) continue;
      taken.push({ x, z, gap });
      return { x, z };
    }
    return null;
  };
  const seat = (o, p, sink = 0) => {
    o.position.set(p.x, groundY(p.x, p.z) - sink, p.z);
    g.add(o);
    return o;
  };
  const prop = (id, s, p, sink = 0, tilt = 0) => {
    const o = propGroup(id, s);
    o.rotation.set((rng() - 0.5) * tilt, rng() * 6.28, (rng() - 0.5) * tilt);
    return seat(o, p, sink);
  };

  /* 1 — ruined colonnades: two within reach of the road, two colossal ones
         out in the haze */
  for (const [d0, d1, sc] of [[24, 42, 1], [30, 60, 1], [95, 160, 2.1], [120, 210, 2.6]]) {
    const p = spot(d0, d1, 26 * sc);
    if (!p) continue;
    g.add(makeColonnade(rng, groundY, p.x, p.z, rng() * Math.PI, sc));
    // the temple's litter: jars, a coffin, a toppled statue
    if (sc === 1) {
      for (const id of ['amphora_pile', 'sarcophagus', 'broken_statue']) {
        const a = rng() * 6.28, r = 7 + rng() * 6;
        const q = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
        if (trailD(q.x, q.z) > 9) prop(id, id === 'broken_statue' ? 1.7 : 1.2, q, 0.12, 0.25);
      }
    }
  }
  /* 2 — colossi: fragments of statues far larger than life, leaning out of
         the dunes */
  for (const [d0, d1, s] of [[20, 36, 3.2], [45, 90, 5.5], [80, 150, 8.5]]) {
    const p = spot(d0, d1, 9 + s * 2);
    if (p) prop('broken_statue', s, p, s * 0.28, 0.35);
  }
  /* 3 — the dead: one great rib cage near the road, another far off, and
         bone heaps where the trail bends */
  for (const [d0, d1, s] of [[18, 34, 1.0], [60, 120, 1.9]]) {
    const p = spot(d0, d1, 16 * s);
    if (!p) continue;
    const ribs = makeGiantRibs(rng, s);
    ribs.rotation.y = rng() * 6.28;
    seat(ribs, p, 0.5 * s);
  }
  for (let i = 0; i < 3; i++) {
    const p = spot(8.5, 16, 10);
    if (p) prop('bone_pile', 1.2 + rng() * 0.9, p, 0.03);
  }
  /* 4 — arches standing alone in the sand */
  for (const [d0, d1, s] of [[26, 48, 1.8], [70, 130, 3.4]]) {
    const p = spot(d0, d1, 12 * s);
    if (p) prop('ruined_arch', s, p, s * 0.3, 0.12);
  }
  /* 5 — the living margin of the road: cairns, dead trees, dry scrub */
  for (let i = 0; i < 8; i++) {
    const p = spot(8, 13, 14);
    if (p) seat(makeCairn(rng, 0.9 + rng() * 0.7), p, 0.02);
  }
  for (let i = 0; i < 5; i++) {
    const p = spot(10, 40, 12);
    if (p) prop('dead_tree', 1.0 + rng() * 0.7, p, 0.05, 0.2);
  }
  for (let i = 0; i < 9; i++) {
    const p = spot(8, 30, 5);
    if (p) prop('dead_scrub', 0.8 + rng() * 0.9, p, 0.02);
  }
  return g;
}

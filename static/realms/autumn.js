/*
 * realms/autumn.js — the Amber Vale: a fog-bound maze walked through a wood
 * of titans at golden hour.
 *
 * The camera is locked close here (20–26 units), so the frame is trunks and
 * forest floor; this file is mostly about those two things.
 *
 *   makeValeGround   the forest floor: one flat plane whose material does the
 *                    work — a painted leaf-litter carpet, drifts and damp
 *                    hollows, the worn earth of the trail (read from a
 *                    distance field that grows as trails are revealed), and
 *                    long pools of low sun raking between the trunks.
 *   makeValeField    the wood itself. Three tree silhouettes (spreading oak,
 *                    tall beech, forked giant) with flared, rooted trunks and
 *                    layered crowns in amber / gold / russet. Everything is
 *                    instanced per 52-unit cell with a near and a far level of
 *                    detail, so the whole wood costs a few dozen draw calls.
 *                    Crowns and any trunk standing between the camera and the
 *                    captain dissolve (screen-door) so the view is never
 *                    blocked. Ferns, mushrooms and leaf drifts gather at the
 *                    roots; shafts of light slant through the gaps.
 *   valeWaystone     the stepping stone that marks a stop on the trail.
 *
 * Gameplay contracts kept:
 *   · the field's direct children carry real world positions; scene.js parts
 *     the wood along revealed trails by removing the children that stand on
 *     them. Every tree is represented there by a light "handle" object — when
 *     scene.js removes it, the tree's instances are hidden.
 *   · the floor is dead flat at y = 0 (stones, camps and the barrow sit flush)
 *   · canopies and trunks cast no real shadows of their own (a short shadow
 *     proxy per trunk throws the long golden-hour stripes instead — full-height
 *     shadows at this sun angle would black out the whole floor)
 */
import * as THREE from 'three';
import { mulberry32, hashStr } from '../util.js';
import { lookFor } from '../gfx/looks.js';
import { groundGrainTexture } from '../gfx/terrain.js';
import { propGroup } from '../props.js';
import {
  smooth, clamp01, makeSegDist, makeTrailField, TRAIL_GLSL, NOISE_GLSL,
  addWorldVaryings, tint, merge, lumpGeometry, smoothNormals, taperTube,
} from './footkit.js';

const TAU = Math.PI * 2;
const LITTER_TILE = 12;                // world units per leaf-litter repeat

/* ── the sun, shared by floor, trunks and shafts ─────────────────────────── */
function sunInfo() {
  const s = lookFor('autumn').sun;
  const az = THREE.MathUtils.degToRad(s.az), el = THREE.MathUtils.degToRad(s.el);
  return { hx: Math.cos(az), hz: Math.sin(az), cot: 1 / Math.tan(el), el,
           dir: new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)) };
}

/* shared uniform OBJECTS: one set drives every Vale material */
const U = {
  uDapple: { value: null },
  uSunH: { value: new THREE.Vector4(1, 0, 3.7, 0.2) },   // xy sun heading, z cot(elevation), w shade floor
  uPort: { value: new THREE.Vector4(23, 0.445, 0, 0) },  // x focus distance, y tan(fov/2)
  uValeT: { value: 0 },
};

/* ── sun pools: a tileable, histogram-flat noise the shaders AND the shaft
      placement both read, so a beam always lands in a pool of light ──────── */
const DAP = 256;
let _dap = null;
function dapple() {
  if (_dap) return _dap;
  const rnd = mulberry32(4411);
  const lattice = (gx, gy) => {
    const g = new Float32Array(gx * gy);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (x, y) => {                   // x,y in tile units 0..1, wraps
      const fx = x * gx, fy = y * gy;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const a = g[(iy % gy) * gx + (ix % gx)], b = g[(iy % gy) * gx + ((ix + 1) % gx)];
      const c = g[((iy + 1) % gy) * gx + (ix % gx)], d = g[((iy + 1) % gy) * gx + ((ix + 1) % gx)];
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    };
  };
  // long along x (the sun's heading), narrow across: streaks, not blobs
  const l1 = lattice(5, 16), l2 = lattice(11, 37);
  const f = new Float32Array(DAP * DAP);
  for (let y = 0; y < DAP; y++) {
    for (let x = 0; x < DAP; x++) f[y * DAP + x] = l1(x / DAP, y / DAP) * 0.68 + l2(x / DAP, y / DAP) * 0.32;
  }
  // rank-equalise: the value IS the percentile, so thresholds are coverage
  const order = Array.from(f.keys()).sort((a, b) => f[a] - f[b]);
  const data = new Uint8Array(DAP * DAP);
  for (let r = 0; r < order.length; r++) data[order[r]] = Math.round((r / (order.length - 1)) * 255);
  const tex = new THREE.DataTexture(data, DAP, DAP, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const tap = (u, v) => {                // bilinear, wrapped — mirrors the GPU
    const fx = (u - Math.floor(u)) * DAP - 0.5, fy = (v - Math.floor(v)) * DAP - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const at = (i, j) => data[((j + DAP) % DAP) * DAP + ((i + DAP) % DAP)] / 255;
    return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
  };
  const sun = sunInfo();
  U.uDapple.value = tex;
  U.uSunH.value.set(sun.hx, sun.hz, sun.cot, 0.16);
  /** how sunlit is the floor at (x,z)? 0 shade … 1 full pool (same maths as DAPPLE_GLSL) */
  const at = (x, z) => {
    const a = x * sun.hx + z * sun.hz, b = -x * sun.hz + z * sun.hx;
    const d = tap(a / 150, b / 38) * 0.65 + tap(a / 61 + 0.31, b / 17 + 0.57) * 0.35;
    return smooth(0.47, 0.63, d);
  };
  _dap = { tex, at, sun };
  return _dap;
}

const DAPPLE_GLSL = /* glsl */`
uniform sampler2D uDapple;
uniform vec4 uSunH;
// 0 = canopy shade, 1 = a pool of low sun. Points above the floor slide down
// the sun ray first, so a beam paints trunks and floor as one shaft.
float valeDapple(vec3 wp) {
  vec2 g = wp.xz - uSunH.xy * (max(wp.y, 0.0) * uSunH.z);
  float a = dot(g, uSunH.xy), b = dot(g, vec2(-uSunH.y, uSunH.x));
  float d = texture2D(uDapple, vec2(a / 150.0, b / 38.0)).r * 0.65
          + texture2D(uDapple, vec2(a / 61.0 + 0.31, b / 17.0 + 0.57)).r * 0.35;
  return smoothstep(0.47, 0.63, d);
}`;

const PORT_GLSL = /* glsl */`
uniform vec4 uPort;
float valeIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// the sight tunnel: 1 = solid, 0 = dissolved. Fragments inside a circle round
// the screen centre (rIn..rOut, in half-screen-heights) AND nearer than the
// focus plane (dNear..dFar × focus distance) are cut away.
float valePort(float rIn, float rOut, float dNear, float dFar) {
  vec3 vp = -vViewPosition;
  float depth = max(-vp.z, 0.001);
  float rr = length(vp.xy) / (depth * uPort.y);
  float inHole = 1.0 - smoothstep(rIn, rOut, rr);
  float gate = 1.0 - smoothstep(uPort.x * dNear, uPort.x * dFar, depth);
  return 1.0 - inHole * gate;
}`;

const f3 = (x) => x.toFixed(3);
/* patch a MeshStandardMaterial with the Vale's light: sun pools, the sight
   tunnel, and (for leaves) the glow of low sun shining through them */
function valePatch(mat, key, { dapple: dk = 0, port = null, glow = 0 } = {}) {
  dapple();
  mat.onBeforeCompile = (shader) => {
    addWorldVaryings(shader);
    shader.uniforms.uDapple = U.uDapple;
    shader.uniforms.uSunH = U.uSunH;
    shader.uniforms.uPort = U.uPort;
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DAPPLE_GLSL}\n${PORT_GLSL}`);
    if (port) {
      fs = fs.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
        if (valePort(${port.map(f3).join(', ')}) < valeIGN(gl_FragCoord.xy)) discard;`);
    }
    if (dk) {
      fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          float vd = mix(1.0, mix(uSunH.w, 1.0, valeDapple(vWPos)), ${f3(dk)});
          reflectedLight.directDiffuse *= vd;
          reflectedLight.directSpecular *= vd;
        }`);
    }
    if (glow) {
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_FOG
        {
          // low sun THROUGH the leaves: looking sunward, thin edges light up
          vec3 gV = normalize(vViewPosition);
          float gBack = pow(max(dot(-gV, uAtmoSunView.xyz), 0.0), 2.5);
          float gRim = 0.35 + 0.65 * (1.0 - abs(dot(normal, gV)));
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.66, 0.30) * (gBack * gRim * ${f3(glow)});
        }
        #endif`);
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'thalassa-vale-' + key;
  return mat;
}

/* ── painted textures ────────────────────────────────────────────────────── */
function leafShape(ctx, x, y, len, wid, rot, fill, rib) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(-len / 2, 0);
  ctx.quadraticCurveTo(-len * 0.08, -wid, len / 2, 0);
  ctx.quadraticCurveTo(-len * 0.08, wid, -len / 2, 0);
  ctx.fillStyle = fill;
  ctx.fill();
  if (rib) {
    ctx.strokeStyle = rib;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.lineTo(len / 2, 0);
    ctx.stroke();
  }
  ctx.restore();
}
/* scatter leaves over a tile (wrapping at the edges). pal: css colours;
   hctx (optional) gets the same leaves as a height map, later = higher */
function paintLeaves(ctx, hctx, S, rnd, n, pal, lo, hi, rib) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * S, y = rnd() * S;
    const len = lo + rnd() * (hi - lo), wid = len * (0.34 + rnd() * 0.22), rot = rnd() * TAU;
    const fill = pal[(rnd() * pal.length) | 0];
    const hv = Math.round(60 + 190 * (i / n) * (0.7 + 0.3 * rnd()));
    const xs = x < hi ? [0, S] : x > S - hi ? [0, -S] : [0];
    const ys = y < hi ? [0, S] : y > S - hi ? [0, -S] : [0];
    for (const ox of xs) for (const oy of ys) {
      leafShape(ctx, x + ox, y + oy, len, wid, rot, fill, rib);
      if (hctx) leafShape(hctx, x + ox, y + oy, len, wid, rot, `rgb(${hv},${hv},${hv})`, null);
    }
  }
}
function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return [cv, cv.getContext('2d')];
}
function asTexture(cv, srgb = true) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const jitterPal = (hexes, rnd, n = 6, amt = 0.07) => {
  const out = [], c = new THREE.Color(), hsl = {};
  for (const [hex, weight] of hexes) {
    for (let i = 0; i < n * weight; i++) {
      c.set(hex).getHSL(hsl);
      c.setHSL(hsl.h + (rnd() - 0.5) * 0.02, clamp01(hsl.s + (rnd() - 0.5) * 0.1), clamp01(hsl.l + (rnd() - 0.5) * 2 * amt));
      out.push('#' + c.getHexString());
    }
  }
  return out;
};

let _litter = null;
/* the forest floor: thousands of fallen leaves over dark humus */
function litterTextures() {
  if (_litter) return _litter;
  const S = 1024;
  const [cv, ctx] = makeCanvas(S, S);
  const [hv, hctx] = makeCanvas(S, S);
  const rnd = mulberry32(60217);
  ctx.fillStyle = '#35261a';
  ctx.fillRect(0, 0, S, S);
  hctx.fillStyle = '#202020';
  hctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {          // humus mottling
    const x = rnd() * S, y = rnd() * S, r = 20 + rnd() * 70;
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(20,12,6,0.16)' : 'rgba(90,62,36,0.14)';
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, TAU); ctx.fill();
    }
  }
  const pal = jitterPal([
    ['#c9791f', 3], ['#dc9a2c', 3], ['#e6b53c', 2], ['#b55a1f', 3], ['#96421c', 2],
    ['#7c5230', 3], ['#5d3f25', 2], ['#a8953a', 1], ['#d8672a', 1]], rnd);
  // old brown leaves first (the mat), the bright fresh fall on top
  paintLeaves(ctx, hctx, S, rnd, 5200, jitterPal([['#6e4a2b', 3], ['#59391f', 3], ['#85582e', 2], ['#4a2f1a', 2]], rnd), 12, 24, 'rgba(30,16,8,0.4)');
  paintLeaves(ctx, hctx, S, rnd, 6200, pal, 11, 25, 'rgba(60,28,10,0.42)');
  _litter = { map: asTexture(cv), bump: asTexture(hv, false) };
  return _litter;
}

let _barkTex = null;
/* deep vertical furrows; tiles both ways */
function barkTexture() {
  if (_barkTex) return _barkTex;
  const W = 256, H = 512;
  const [cv, ctx] = makeCanvas(W, H);
  const rnd = mulberry32(8123);
  ctx.fillStyle = '#6d5646';
  ctx.fillRect(0, 0, W, H);
  const furrow = (x0, width, style, amp) => {
    const k1 = 1 + ((rnd() * 3) | 0), k2 = 2 + ((rnd() * 5) | 0), p1 = rnd() * TAU, p2 = rnd() * TAU;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    for (const ox of [-W, 0, W]) {
      ctx.beginPath();
      for (let y = -8; y <= H + 8; y += 8) {
        const x = x0 + ox + amp * Math.sin((y / H) * TAU * k1 + p1) + amp * 0.5 * Math.sin((y / H) * TAU * k2 + p2);
        if (y === -8) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };
  for (let i = 0; i < 46; i++) furrow(rnd() * W, 5 + rnd() * 9, `rgba(128,104,84,${0.25 + rnd() * 0.3})`, 7);   // plates
  for (let i = 0; i < 60; i++) furrow(rnd() * W, 2 + rnd() * 4, `rgba(34,22,16,${0.45 + rnd() * 0.4})`, 6);     // furrows
  for (let i = 0; i < 70; i++) furrow(rnd() * W, 1, `rgba(170,146,120,${0.2 + rnd() * 0.25})`, 6);              // lit edges
  for (let i = 0; i < 300; i++) {            // cross cracks
    const x = rnd() * W, y = rnd() * H;
    ctx.fillStyle = 'rgba(30,20,14,0.35)';
    ctx.fillRect(x, y, 4 + rnd() * 12, 1 + rnd() * 1.5);
  }
  _barkTex = asTexture(cv);
  return _barkTex;
}

let _clumpTex = null;
/* leaf dabs in near-white: the crown material's tint supplies the colour */
function clumpTexture() {
  if (_clumpTex) return _clumpTex;
  const S = 512;
  const [cv, ctx] = makeCanvas(S, S);
  const rnd = mulberry32(31337);
  ctx.fillStyle = '#7d7468';
  ctx.fillRect(0, 0, S, S);
  paintLeaves(ctx, null, S, rnd, 2600, jitterPal([['#b9ad9c', 3], ['#d8cdb8', 3], ['#f4ecd8', 3], ['#a3907a', 1], ['#fff7e0', 1]], rnd, 6, 0.05), 16, 34, 'rgba(70,50,30,0.25)');
  _clumpTex = asTexture(cv);
  return _clumpTex;
}

let _fernTex = null;
/* one bracken frond, tip up, on a transparent ground */
function fernTexture() {
  if (_fernTex) return _fernTex;
  const W = 128, H = 256;
  const [cv, ctx] = makeCanvas(W, H);
  const N = 17;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const y = H - 14 - t * (H - 26);
    const len = (W * 0.47) * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.7) * (1 - 0.5 * t) + 3;
    const g = Math.round(150 + t * 70), r = Math.round(150 + t * 90), b = Math.round(60 + t * 30);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(W / 2, y);
      ctx.rotate(side * (1.15 - t * 0.25));
      ctx.beginPath();
      ctx.ellipse(0, -len / 2, 5.2 - t * 2.4, len / 2, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.strokeStyle = 'rgb(120,96,50)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(W / 2, H); ctx.lineTo(W / 2, 10); ctx.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _fernTex = t;
  return t;
}

/* ══ the floor ════════════════════════════════════════════════════════════ */
export function makeValeGround(theme, size = 3000, opts = {}) {
  const cx = opts.center?.x ?? 0, cz = opts.center?.z ?? 0;
  const lit = litterTextures();
  dapple();
  const trail = makeTrailField({ cx, cz, half: 640, res: 1024, reach: 12 });

  const mat = new THREE.MeshStandardMaterial({
    map: lit.map, bumpMap: lit.bump, bumpScale: 2.2, roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    addWorldVaryings(shader);
    Object.assign(shader.uniforms, trail.uniforms);
    shader.uniforms.uDapple = U.uDapple;
    shader.uniforms.uSunH = U.uSunH;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TRAIL_GLSL}\n${NOISE_GLSL}\n${DAPPLE_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        vec2 fXz = vWPos.xz;
        float fDrift = fkNoise(fXz * 0.043) * 0.65 + fkNoise(fXz * 0.17 + 7.3) * 0.35;
        float fGrain = fkNoise(fXz * 1.3) * 0.6 + fkNoise(fXz * 4.1) * 0.4;
        // a second, far larger read of the same litter breaks the tile
        vec3 fBig = texture2D(map, vMapUv * 0.23 + vec2(0.31, 0.77)).rgb;
        diffuseColor.rgb *= 0.72 + 0.9 * dot(fBig, vec3(0.33));
        // golden drifts where the leaves have heaped, dark damp hollows between
        diffuseColor.rgb *= mix(vec3(0.58, 0.52, 0.50), vec3(1.16, 1.07, 0.92), smoothstep(0.30, 0.68, fDrift));
        // the trail: bare trodden earth, leaves kicked to its edges
        float fTD = trailDist(fXz);
        float fLeaf = dot(sampledDiffuseColor.rgb, vec3(0.5, 0.4, 0.1));
        float fPath = 1.0 - smoothstep(1.5, 2.9, fTD + (fGrain - 0.5) * 1.7 + fLeaf * 0.9);
        float fScuff = 1.0 - smoothstep(2.4, 6.5, fTD + (fGrain - 0.5) * 2.6);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.74, 0.70, 0.66), fScuff * 0.6);
        vec3 fEarth = vec3(0.150, 0.092, 0.050) * (0.75 + fGrain * 0.5);
        diffuseColor.rgb = mix(diffuseColor.rgb, fEarth, fPath * 0.9);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.78, fPath);`)
      .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
        {
          float fd = mix(uSunH.w, 1.0, valeDapple(vWPos));
          reflectedLight.directDiffuse *= fd;
          reflectedLight.directSpecular *= fd;
        }`);
  };
  mat.customProgramCacheKey = () => 'thalassa-vale-floor-v1';

  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + cx) / LITTER_TILE, (p.getZ(i) + cz) / LITTER_TILE);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';

  /* trails are revealed as the lantern finds them: setTrails() repaints the
     worn earth. segs: [[x0,z0,x1,z1]…]; stops: [{x,z,type}…] */
  const setTrails = (segs, stops = []) => trail.set(segs,
    stops.map((n) => [n.x, n.z, n.type === 'gate' ? 9 : (!n.type || n.type === 'sea') ? 1.7 : 7]));
  setTrails(opts.segs || []);

  /* STOPGAP until scene.js hands revealed trails to field.userData.setTrails
     (one line where it already computes them for the tree-parting): read the
     board the app keeps on window.__room, a few times a second. */
  let seen = '', nextPoll = 0;
  const poll = () => {
    const now = performance.now();
    if (now < nextPoll) return;
    nextPoll = now + 400;
    const b = globalThis.__room?.board;
    if (!b || !b.nodes || !b.edges) return;
    const key = b.nodes.length + ':' + b.edges.length;
    if (key === seen) return;
    seen = key;
    const by = new Map();
    for (const n of b.nodes) if (n.region === 'autumn') by.set(n.id, n);
    const segs = [];
    for (const [a, c] of b.edges) {
      const na = by.get(a), nb = by.get(c);
      if (na && nb) segs.push([na.x, na.z, nb.x, nb.z]);
    }
    setTrails(segs, [...by.values()]);
  };

  const heightAt = () => 0;
  heightAt.vale = { setTrails, stopPolling() { nextPoll = Infinity; } };
  return { mesh, update: poll, heightAt };
}

/* ══ the trees ════════════════════════════════════════════════════════════ */
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/* three silhouettes. limbs: [x,y,z (tip, from the trunk top), radius];
   crown: [x,y,z, radius, squash, detail, tone] */
const VARIANTS = [
  { // spreading oak
    H: 12.5, r0: 1.45, r1: 0.85, lean: 0.6, sway: 0.35, roots: 6, gap: 13,
    limbs: [[5.5, 5.5, 1.5, 0.5], [-4.5, 6, 3, 0.48], [-1.5, 6.5, -5.5, 0.46], [2.5, 8, -1, 0.5]],
    crown: [[0, 22.5, 0, 5.6, 0.72, 2, 0], [6, 19.6, 2, 4.4, 0.7, 2, 1], [-5.5, 20, 3.5, 4.6, 0.7, 2, 2],
            [-2, 20.5, -6.2, 4.2, 0.72, 1, 3], [3.5, 24.6, -3, 3.2, 0.75, 1, 1], [-3, 25, 1, 3.0, 0.75, 1, 3],
            [1, 18.4, 5.5, 3.0, 0.7, 1, 0]],
    far: [1, 1, 1],
  },
  { // tall beech
    H: 17, r0: 1.15, r1: 0.6, lean: 0.2, sway: 0.5, roots: 5, gap: 10.5,
    limbs: [[2.8, 6, 0.8, 0.36], [-2.6, 7.5, -1.5, 0.36], [0.4, 10.5, 2.2, 0.34]],
    crown: [[0, 30, 0.5, 4.2, 0.95, 2, 3], [2.8, 25, 1, 3.6, 0.85, 2, 0], [-2.8, 26.5, -1.8, 3.7, 0.85, 1, 1],
            [0.5, 22.6, 3.2, 2.9, 0.8, 1, 2], [-1, 21.6, -2.6, 2.6, 0.8, 1, 0], [1.5, 33, -0.5, 2.6, 0.9, 1, 1]],
    far: [0.6, 1.32, 0.6],
  },
  { // forked giant
    H: 8.5, r0: 1.85, r1: 1.25, lean: 1.0, sway: 0.3, roots: 7, gap: 14,
    limbs: [[5, 9, -2, 0.85], [-5.5, 10.5, 2.5, 0.8], [1, 13, 4, 0.5], [0, 8.5, -5, 0.45]],
    crown: [[5.5, 21, -2.2, 5.2, 0.7, 2, 1], [-6, 22.5, 2.8, 5.4, 0.7, 2, 0], [0.8, 24.6, 3.8, 4.4, 0.72, 2, 3],
            [0, 19.6, -5.5, 3.4, 0.72, 1, 2], [-2, 26.5, -1, 3.4, 0.75, 1, 1], [8.5, 18.6, 2.5, 3.0, 0.7, 1, 2],
            [-8.5, 19.6, -2.5, 3.0, 0.7, 1, 3]],
    far: [1.08, 0.98, 1.08],
  },
];
const CROWN_TONES = [[1, 1, 1], [1.0, 0.86, 0.68], [0.9, 0.72, 0.6], [1.08, 1.02, 0.8]];
/* whole-tree tints (instance colour): amber, gold, russet, deep red, orange, olive-gold */
const TREE_TINTS = [0xd98a2a, 0xd98a2a, 0xe6b032, 0xe6b032, 0xb5521f, 0x9c3a1e, 0xd96c22, 0xd96c22, 0xa8962f];

function buildTree(v) {
  const P = VARIANTS[v];
  const rnd = mulberry32(977 + v * 131);
  const SEG = 12;
  const TS = [0, 0.03, 0.07, 0.12, 0.19, 0.31, 0.5, 0.72, 1.0];
  const Y0 = -0.8;
  const p1 = rnd() * TAU, p2 = rnd() * TAU, mossA = rnd() * TAU;
  const roots = [];
  for (let k = 0; k < P.roots; k++) roots.push({ a: (k / P.roots) * TAU + (rnd() - 0.5) * 0.5, w: 0.65 + rnd() * 0.7 });
  const bend = (tt) => [P.lean * tt * tt + P.sway * Math.sin(tt * 3.1 + p1) * tt,
                        -P.lean * 0.4 * tt * tt + P.sway * Math.sin(tt * 2.3 + p2) * tt];
  const radiusAt = (tt, a) => {
    const r = P.r0 + (P.r1 - P.r0) * Math.pow(tt, 0.75);
    let butt = 0;
    for (const rt of roots) butt += rt.w * Math.pow(Math.max(0, Math.cos(a - rt.a)), 5);
    const lump = 1 + 0.06 * Math.sin(a * 3 + tt * 9 + p1) + 0.04 * Math.sin(a * 7 - tt * 17 + p2);
    return r * (1 + Math.exp(-tt * 16) * 0.5 + Math.exp(-tt * 9) * 1.45 * butt) * lump;
  };
  const pos = [], uv = [], col = [], idx = [];
  for (let i = 0; i < TS.length; i++) {
    const y = Y0 + TS[i] * (P.H - Y0);
    const tt = Math.max(0, y / P.H);
    const [bx, bz] = bend(tt);
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * TAU;
      const rad = radiusAt(tt, a);
      pos.push(bx + Math.cos(a) * rad, y, bz + Math.sin(a) * rad);
      uv.push((s / SEG) * 3, y / 3.6);
      // damp and dark at the foot, moss up the shaded side of the roots
      const k = 0.6 + 0.4 * smooth(0, 5, y);
      const moss = (1 - smooth(0.2, 4.5, y)) * Math.pow(Math.max(0, Math.cos(a - mossA)), 2) * 0.85;
      col.push(k * (1 - moss) + 0.50 * moss, k * (1 - moss) + 0.66 * moss, k * (1 - moss) + 0.26 * moss);
    }
  }
  for (let i = 0; i < TS.length - 1; i++) {
    for (let s = 0; s < SEG; s++) {
      const a = i * (SEG + 1) + s, b = a + 1, c = a + SEG + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const trunk = new THREE.BufferGeometry();
  trunk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  trunk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  trunk.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  trunk.setIndex(idx);
  trunk.computeVertexNormals();
  {                                           // weld the seam's normals
    const n = trunk.attributes.normal;
    for (let i = 0; i < TS.length; i++) {
      const a = i * (SEG + 1), b = a + SEG;
      const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
    }
  }
  const parts = [trunk];
  const [tx, tz] = bend(1);
  // limbs, forking up into the crown
  for (const [lx, ly, lz, lr] of P.limbs) {
    const g = taperTube([V3(tx, P.H - 1.2, tz), V3(tx + lx * 0.3, P.H + ly * 0.42, tz + lz * 0.3),
                         V3(tx + lx * 0.75, P.H + ly * 0.8, tz + lz * 0.75), V3(tx + lx, P.H + ly, tz + lz)],
      Math.min(P.r1 * 0.82, lr * 1.5), lr * 0.3, 6, 6, 2, 3);
    parts.push(tint(g, 0xffffff));
  }
  // roots running out from each buttress and diving into the litter
  for (const rt of roots) {
    const len = (2.6 + rnd() * 2.6) * rt.w, r0 = radiusAt(0.03, rt.a);
    const ca = Math.cos(rt.a), sa = Math.sin(rt.a), wob = (rnd() - 0.5) * 0.9;
    const g = taperTube([V3(ca * r0 * 0.7, 0.75, sa * r0 * 0.7),
                         V3(ca * (r0 + len * 0.35) - sa * wob * 0.4, 0.34, sa * (r0 + len * 0.35) + ca * wob * 0.4),
                         V3(ca * (r0 + len * 0.7) - sa * wob, 0.12, sa * (r0 + len * 0.7) + ca * wob),
                         V3(ca * (r0 + len) - sa * wob * 1.4, -0.3, sa * (r0 + len) + ca * wob * 1.4)],
      0.36 * rt.w + 0.1, 0.08, 5, 5, 1, 2);
    parts.push(tint(g, 0xffffff, (x, y) => 0.55 + clamp01(y * 0.9) * 0.3));
  }
  const trunkGeo = merge(parts);

  // crown: layered masses, each shaded dark below → bright on top
  const blobs = [];
  for (const [x, y, z, r, sy, detail, tone] of P.crown) {
    const g = lumpGeometry(1, detail, 0.3, v * 17 + blobs.length * 3.1 + 1, 1.5);
    const T = CROWN_TONES[tone];
    const pp = g.attributes.position;
    const cc = new Float32Array(pp.count * 3);
    for (let i = 0; i < pp.count; i++) {
      const k = 0.42 + 0.58 * smooth(-0.85, 0.55, pp.getY(i));
      cc[i * 3] = T[0] * k; cc[i * 3 + 1] = T[1] * k; cc[i * 3 + 2] = T[2] * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    g.scale(r, r * sy, r);
    g.translate(tx + x, y, tz + z);
    const u2 = g.attributes.uv;
    for (let i = 0; i < pp.count; i++) {
      u2.setXY(i, pp.getX(i) * 0.085 + pp.getZ(i) * 0.05, pp.getY(i) * 0.1 - pp.getZ(i) * 0.03);
    }
    blobs.push(g);
  }
  return { trunk: trunkGeo, crown: merge(blobs) };
}

/* the far tree: one generic silhouette, stretched per variant */
function buildFarTree() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.8, 1.6, 17, 6, 1, true);
  trunk.translate(0, 8.5, 0);
  parts.push(tint(trunk, 0x3a2a1e));
  for (const [x, y, z, r, sy, seed, det] of [[0, 22.5, 0, 7.4, 0.62, 3, 2], [4.6, 20, 1.5, 4.6, 0.7, 5, 1], [-4.4, 20.5, -1.8, 4.8, 0.7, 9, 1]]) {
    const g = lumpGeometry(1, det, 0.28, seed, 1.4);
    const pp = g.attributes.position;
    const cc = new Float32Array(pp.count * 3);
    for (let i = 0; i < pp.count; i++) {
      const k = 0.45 + 0.55 * smooth(-0.85, 0.55, pp.getY(i));
      cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    g.scale(r, r * sy, r);
    g.translate(x, y, z);
    const u2 = g.attributes.uv;
    for (let i = 0; i < pp.count; i++) u2.setXY(i, pp.getX(i) * 0.085 + pp.getZ(i) * 0.05, pp.getY(i) * 0.1);
    parts.push(g);
  }
  return merge(parts);
}

/* a rosette of arching bracken fronds (alpha-cut texture) */
function buildFern() {
  const rnd = mulberry32(551);
  const pos = [], uv = [], nor = [], col = [], idx = [];
  const N = 9, SEGS = 4;
  for (let f = 0; f < N; f++) {
    const a = (f / N) * TAU + rnd() * 0.5, L = 1.5 + rnd() * 0.9, W = 0.42 + rnd() * 0.14, rise = 0.55 + rnd() * 0.5;
    const dx = Math.cos(a), dz = Math.sin(a);
    const base = pos.length / 3;
    for (let k = 0; k <= SEGS; k++) {
      const t = k / SEGS;
      const out = 0.1 + t * L, y = Math.sin(t * 2.25) * rise * L * 0.55;
      for (const side of [-1, 1]) {
        pos.push(dx * out - dz * side * W, y, dz * out + dx * side * W);
        uv.push(side < 0 ? 0 : 1, t);
        nor.push(-dx * 0.25, 0.95, -dz * 0.25);
        const sh = 0.7 + 0.3 * t;
        col.push(sh, sh, sh);
      }
    }
    for (let k = 0; k < SEGS; k++) {
      const o = base + k * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/* a huddle of toadstools */
function buildShrooms() {
  const rnd = mulberry32(88);
  const parts = [];
  for (const [x, z, s] of [[0, 0, 1], [0.42, 0.2, 0.62], [-0.3, 0.36, 0.5], [0.12, -0.44, 0.74], [-0.5, -0.2, 0.4]]) {
    const h = 0.5 * s + rnd() * 0.12;
    const stem = new THREE.CylinderGeometry(0.07 * s, 0.1 * s, h, 6, 1, true);
    stem.translate(x, h / 2, z);
    parts.push(tint(stem, 0xeadfc6, (xx, y) => 0.75 + clamp01(y / h) * 0.25));
    const cap = new THREE.SphereGeometry(0.3 * s, 9, 5, 0, TAU, 0, Math.PI * 0.55);
    cap.scale(1, 0.62, 1);
    cap.translate(x, h - 0.02, z);
    parts.push(tint(cap, rnd() < 0.5 ? 0xb5482a : 0xc77a3a, (xx, y) => 0.8 + clamp01((y - h) / (0.2 * s)) * 0.35));
  }
  return merge(parts);
}

/* a heap of fallen leaves */
function buildDrift() {
  const g = lumpGeometry(1, 1, 0.22, 41, 1.3);
  g.scale(1, 0.2, 0.8);
  const p = g.attributes.position, uv = g.attributes.uv;
  const cc = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, p.getX(i) / 3.1, p.getZ(i) / 3.1);
    const k = 0.78 + 0.34 * clamp01(p.getY(i) * 6);
    cc[i * 3] = k * 1.08; cc[i * 3 + 1] = k; cc[i * 3 + 2] = k * 0.86;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  return g;
}

/* a shaft of light: two crossed ribbons along +Y (base at the floor) */
function buildShaft() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}
function shaftMaterial() {
  const look = lookFor('autumn');
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(look.shaftColor ?? 0xffc27a).multiplyScalar(0.55) },
      uValeT: U.uValeT,
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec3 vView;
      varying float vFace;
      varying float vSeed;
      void main() {
        vUv = uv;
        mat4 mi = modelMatrix * instanceMatrix;
        vec4 mv = viewMatrix * (mi * vec4(position, 1.0));
        vView = mv.xyz;
        vec3 n = normalize(mat3(viewMatrix) * (mat3(mi) * normal));
        vFace = abs(dot(n, normalize(mv.xyz)));
        vSeed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.73;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uValeT;
      varying vec2 vUv;
      varying vec3 vView;
      varying float vFace;
      varying float vSeed;
      void main() {
        float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
        across = across * across * (3.0 - 2.0 * across);
        float along = smoothstep(0.0, 0.10, vUv.y) * (1.0 - smoothstep(0.30, 1.0, vUv.y));
        float dist = length(vView);
        float fade = smoothstep(5.0, 13.0, dist) * (1.0 - smoothstep(36.0, 64.0, dist));
        float streak = 0.72 + 0.28 * sin(vUv.x * 21.0 + vSeed * 5.0);
        float breathe = 0.82 + 0.18 * sin(uValeT * 0.6 + vSeed);
        float a = across * along * fade * streak * breathe * smoothstep(0.12, 0.55, vFace);
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
  });
}

let _kit = null;
function treeKit() {
  if (_kit) return _kit;
  const lit = litterTextures();
  const trees = VARIANTS.map((_, v) => buildTree(v));
  // slimmer than the trunk it stands inside, so it never shadows its own bark
  const proxy = new THREE.CylinderGeometry(0.42, 0.9, 11, 8, 1, true);
  proxy.translate(0, 5.5, 0);
  const crownOpts = { vertexColors: true, roughness: 0.86, metalness: 0,
    map: clumpTexture(), bumpMap: clumpTexture(), bumpScale: 1.1 };
  _kit = {
    trees,
    far: buildFarTree(),
    proxy,
    fern: buildFern(),
    shrooms: buildShrooms(),
    drift: buildDrift(),
    shaft: buildShaft(),
    bark: valePatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0,
      map: barkTexture(), bumpMap: barkTexture(), bumpScale: 2.4 }), 'bark-v1',
      { dapple: 0.9, port: [0.15, 0.30, 0.70, 0.90] }),
    crown: valePatch(new THREE.MeshStandardMaterial(crownOpts), 'crown-v1',
      { port: [0.62, 1.0, 0.92, 1.36], glow: 1.5 }),
    proxyMat: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    fernMat: valePatch(new THREE.MeshStandardMaterial({ vertexColors: true, map: fernTexture(), alphaTest: 0.45,
      side: THREE.DoubleSide, roughness: 0.8, metalness: 0 }), 'fern-v1', { dapple: 0.8 }),
    shroomMat: valePatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 }), 'shroom-v1', { dapple: 0.8 }),
    driftMat: valePatch(new THREE.MeshStandardMaterial({ vertexColors: true, map: lit.map, bumpMap: lit.bump, bumpScale: 2.2,
      roughness: 0.92, metalness: 0 }), 'drift-v1', { dapple: 1.0 }),
    shaftMat: shaftMaterial(),
  };
  return _kit;
}

const CELL = 52;
const NEAR_R = 82;                     // cells whose centre is nearer wear full detail

export function makeValeField(theme, nodes, segs, rng, heightAt = null) {
  const g = new THREE.Group();
  g.name = 'valefield';
  if (!nodes.length) return g;
  const kit = treeKit();
  const dap = dapple();
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const M = 55;
  minX -= M; maxX += M; minZ -= M; maxZ += M;
  const segD = makeSegDist(segs);
  const laneD = (x, z) => (segs.length ? segD(x, z) : 1e9);
  // POIs keep a proper clearing; plain trail stops just room for their stone
  const poiClear = (n) => (!n.type || n.type === 'sea' ? 0 : n.type === 'gate' ? 17 : n.type === 'lair' ? 13 : 11);
  const nearNode = (x, z, extra) => {
    for (const n of nodes) if (Math.hypot(n.x - x, n.z - z) < extra + poiClear(n)) return true;
    return false;
  };

  /* ── plant the wood: dart-throwing with a personal bubble per silhouette ── */
  const HASH = 14;
  const grid = new Map();
  const gkey = (x, z) => Math.floor(x / HASH) * 73856093 ^ Math.floor(z / HASH) * 19349663;
  const crowded = (x, z, gap) => {
    const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = grid.get((gx + i) * 73856093 ^ (gz + j) * 19349663);
      if (!list) continue;
      for (const t of list) if (Math.hypot(t.x - x, t.z - z) < (gap + t.gap) * 0.5) return true;
    }
    return false;
  };
  const trees = [];
  for (let tries = 0; tries < 6500 && trees.length < 1900; tries++) {
    const x = minX + rng() * (maxX - minX), z = minZ + rng() * (maxZ - minZ);
    const r = rng();
    const v = r < 0.42 ? 0 : r < 0.76 ? 1 : 2;
    const gap = VARIANTS[v].gap;
    if (laneD(x, z) < 8.5 || nearNode(x, z, 6) || crowded(x, z, gap)) continue;
    const s = 0.86 + rng() * 0.36;
    const t = { x, z, v, gap, s, sy: s * (0.92 + rng() * 0.2), yaw: rng() * TAU,
                tint: TREE_TINTS[(rng() * TREE_TINTS.length) | 0], shade: 0.82 + rng() * 0.3, slots: [] };
    trees.push(t);
    const k = gkey(x, z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  }

  /* ── bucket into cells ── */
  const cells = new Map();
  const cellOf = (x, z) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const k = cx + ':' + cz;
    let c = cells.get(k);
    if (!c) {
      c = { cx: (cx + 0.5) * CELL, cz: (cz + 0.5) * CELL, trees: [], ferns: [], shrooms: [], drifts: [], shafts: [] };
      cells.set(k, c);
    }
    return c;
  };
  for (const t of trees) {
    const c = cellOf(t.x, t.z);
    c.trees.push(t);
    const r0 = VARIANTS[t.v].r0 * t.s;
    // the understory gathers at the roots (and goes with its tree if the
    // trail claims it)
    const nF = 2 + ((rng() * 3) | 0);
    for (let i = 0; i < nF; i++) {
      const a = rng() * TAU, d = r0 * 1.6 + 0.8 + rng() * 3.2;
      c.ferns.push({ x: t.x + Math.cos(a) * d, z: t.z + Math.sin(a) * d, s: 0.75 + rng() * 0.8, yaw: rng() * TAU, t,
                     col: rng() < 0.3 ? 0x9aa644 : rng() < 0.6 ? 0xd6a23a : 0xc9772c });
    }
    if (rng() < 0.55) {
      const a = rng() * TAU, d = r0 * 1.9 + rng() * 1.2;
      c.shrooms.push({ x: t.x + Math.cos(a) * d, z: t.z + Math.sin(a) * d, s: 0.8 + rng() * 1.0, yaw: rng() * TAU, t });
    }
    const nD = 1 + ((rng() * 2) | 0);
    for (let i = 0; i < nD; i++) {
      const a = rng() * TAU, d = r0 * 1.5 + 0.5 + rng() * 2.6;
      c.drifts.push({ x: t.x + Math.cos(a) * d, z: t.z + Math.sin(a) * d, s: 1.2 + rng() * 1.6, yaw: rng() * TAU, t });
    }
  }
  /* shafts of low sun: a few per cell, each landing in a pool of light */
  for (const c of cells.values()) {
    let found = 0;
    for (let i = 0; i < 26 && found < 3; i++) {
      const x = c.cx + (rng() - 0.5) * CELL, z = c.cz + (rng() - 0.5) * CELL;
      if (dap.at(x, z) < 0.92 || crowded(x, z, 5)) continue;
      c.shafts.push({ x, z, w: 2.6 + rng() * 2.4, len: 34 + rng() * 16 });
      found++;
    }
  }

  /* ── build the instanced meshes ── */
  const forest = new THREE.Group();      // sits at the world origin: never "on a trail"
  forest.name = 'valewood';
  g.add(forest);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const inst = (parent, geo, mat, list, place, { shadow = false, receive = true, color = null } = {}) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((o, i) => {
      place(o);
      im.setMatrixAt(i, m4);
      if (color) im.setColorAt(i, color(o));
      (o.t || o).slots?.push([im, i, o.x, o.z]);
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = shadow;
    im.receiveShadow = receive;
    im.computeBoundingSphere();
    parent.add(im);
    return im;
  };
  const treeM = (t) => m4.compose(pp.set(t.x, 0, t.z), q.setFromAxisAngle(yAxis, t.yaw), sc.set(t.s, t.sy, t.s));
  const treeTint = (t) => col.set(t.tint).multiplyScalar(t.shade);
  const sun = dap.sun;
  const shaftQ = new THREE.Quaternion().setFromUnitVectors(yAxis, sun.dir);
  const cellList = [];
  for (const c of cells.values()) {
    const near = new THREE.Group(), far = new THREE.Group();
    near.visible = false;
    for (let v = 0; v < VARIANTS.length; v++) {
      const list = c.trees.filter((t) => t.v === v);
      inst(near, kit.trees[v].trunk, kit.bark, list, treeM);
      inst(near, kit.trees[v].crown, kit.crown, list, treeM, { color: treeTint });
    }
    // the long shadows: a short proxy per trunk (see header)
    inst(near, kit.proxy, kit.proxyMat, c.trees,
      (t) => m4.compose(pp.set(t.x, 0, t.z), q.identity(),
        sc.set(VARIANTS[t.v].r0 * t.s, Math.min(1, (VARIANTS[t.v].H * t.sy) / 11.5), VARIANTS[t.v].r0 * t.s)),
      { shadow: true, receive: false });
    const low = (o) => m4.compose(pp.set(o.x, 0, o.z), q.setFromAxisAngle(yAxis, o.yaw), sc.set(o.s, o.s, o.s));
    inst(near, kit.fern, kit.fernMat, c.ferns, low, { color: (o) => col.set(o.col) });
    inst(near, kit.shrooms, kit.shroomMat, c.shrooms, low, { shadow: true });
    inst(near, kit.drift, kit.driftMat, c.drifts,
      (o) => m4.compose(pp.set(o.x, -0.02, o.z), q.setFromAxisAngle(yAxis, o.yaw), sc.set(o.s, o.s * 0.8, o.s)));
    const sh = inst(near, kit.shaft, kit.shaftMat, c.shafts,
      (o) => m4.compose(pp.set(o.x, 0.05, o.z), shaftQ, sc.set(o.w, o.len, o.w)), { receive: false });
    if (sh) sh.renderOrder = 3;
    inst(far, kit.far, kit.crown, c.trees, (t) => {
      const F = VARIANTS[t.v].far;
      return m4.compose(pp.set(t.x, 0, t.z), q.setFromAxisAngle(yAxis, t.yaw), sc.set(t.s * F[0], t.sy * F[1], t.s * F[2]));
    }, { color: treeTint });
    forest.add(near, far);
    cellList.push({ cx: c.cx, cz: c.cz, near, far });
  }

  /* ── handles: what scene.js sees (and removes) for each tree ── */
  const dirty = new Set();
  const hide = (t) => {
    for (const [im, i, x, z] of t.slots) {
      im.setMatrixAt(i, m4.makeScale(0, 0, 0).setPosition(x, -50, z));
      dirty.add(im);
    }
  };
  for (const t of trees) {
    const h = new THREE.Object3D();
    h.position.set(t.x, 0, t.z);
    h.matrixAutoUpdate = false;
    h.visible = false;
    h.addEventListener('removed', () => hide(t));
    g.add(h);
  }

  /* ── set pieces among the trunks (GLB props; individually removable) ── */
  const placed = [];
  const scatter = (count, laneClear, isleClear, gap, make) => {
    let done = 0;
    for (let tries = 0; done < count && tries < count * 16; tries++) {
      const x = minX + rng() * (maxX - minX), z = minZ + rng() * (maxZ - minZ);
      if (laneD(x, z) < laneClear || nearNode(x, z, isleClear) || crowded(x, z, 5.5)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < gap)) continue;
      placed.push({ x, z });
      const o = make();
      o.position.set(x, 0, z);
      o.rotation.y = rng() * TAU;
      g.add(o);
      done++;
    }
  };
  const pick = (ids, lo, hi) => () => propGroup(ids[(rng() * ids.length) | 0], lo + rng() * (hi - lo));
  scatter(40, 6, 7, 6, pick(['dead_tree', 'mushroom_cluster', 'mushroom_cluster', 'fern_cluster'], 1.4, 2.4));
  scatter(22, 6, 7, 8, pick(['waymarker_stone', 'waymarker_stone', 'stone_well', 'campfire', 'barrel'], 0.9, 1.5));
  // a few rings of standing stones, half lost among the roots
  scatter(5, 14, 16, 30, () => {
    const ring = new THREE.Group();
    const n = 5 + ((rng() * 3) | 0), rad = 4.2 + rng() * 1.6;
    for (let i = 0; i < n; i++) {
      if (rng() < 0.15) continue;
      const a = (i / n) * TAU + rng() * 0.2;
      const st = propGroup('waymarker_stone', 1.3 + rng() * 0.9);
      st.position.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);
      st.rotation.set((rng() - 0.5) * 0.25, rng() * TAU, (rng() - 0.5) * 0.25);
      ring.add(st);
    }
    return ring;
  });

  /* ── the driver: per-frame LOD + shared uniforms, from whatever camera
        is drawing this wood ── */
  const driver = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(9, 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  driver.frustumCulled = false;
  driver.name = 'valedriver';
  const fwd = new THREE.Vector3();
  driver.onBeforeRender = (renderer, scene, camera) => {
    if (!camera.isPerspectiveCamera) return;
    camera.getWorldDirection(fwd);
    const camPos = camera.position;
    // focus = where the view axis meets the captain's height
    let focus = -fwd.y > 0.04 ? (camPos.y - 1.2) / -fwd.y : 26;
    focus = Math.min(34, Math.max(14, focus));
    U.uPort.value.set(focus, Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5), 0, 0);
    U.uValeT.value = performance.now() / 1000;
    for (const c of cellList) {
      const isNear = Math.hypot(c.cx - camPos.x, c.cz - camPos.z) < NEAR_R;
      if (c.near.visible !== isNear) { c.near.visible = isNear; c.far.visible = !isNear; }
    }
    if (dirty.size) {
      for (const im of dirty) im.instanceMatrix.needsUpdate = true;
      dirty.clear();
    }
  };
  forest.add(driver);

  /* scene.js may hand revealed trails straight to the floor through here */
  g.userData.setTrails = (s, stops) => {
    heightAt?.vale?.stopPolling();
    heightAt?.vale?.setTrails(s, stops);
  };
  g.userData.treeCount = trees.length;
  return g;
}

/* ══ stops ════════════════════════════════════════════════════════════════ */
let _stoneMat = null;
function stoneMaterial() {
  return _stoneMat || (_stoneMat = valePatch(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.84, metalness: 0,
    map: groundGrainTexture(), bumpMap: groundGrainTexture(), bumpScale: 0.6 }), 'stone-v1', { dapple: 0.9 }));
}

/* a waypoint on the forest track: one broad, foot-worn stepping stone, moss
   creeping over its rim, a few cobbles kicked in beside it */
export function valeWaystone(rng) {
  const parts = [];
  const slab = lumpGeometry(1, 2, 0.13, rng() * 99, 1.25);
  slab.scale(1.8, 0.34, 1.5);
  {
    const p = slab.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > 0.1) p.setY(i, 0.1 + (y - 0.1) * 0.3);          // worn flat on top
    }
    smoothNormals(slab);
    const stone = new THREE.Color(0x9a9082), moss = new THREE.Color(0x6f7f3a), cc = new THREE.Color();
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const rim = smooth(0.55, 1.0, Math.hypot(x / 1.8, z / 1.5));
      const n = Math.sin(x * 3.7 + z * 2.9) * 0.5 + 0.5;
      cc.copy(stone).multiplyScalar(0.82 + n * 0.22).lerp(moss, rim * (1 - smooth(0.02, 0.14, y)) * 0.8 + rim * n * 0.25);
      col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    }
    slab.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const uv = slab.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) * 0.4, p.getZ(i) * 0.4);
  }
  slab.rotateY(rng() * TAU);
  slab.translate(0, 0.06, 0);
  parts.push(slab);
  const n = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU, d = 1.9 + rng() * 0.7, s = 0.18 + rng() * 0.22;
    const c = lumpGeometry(1, 1, 0.2, rng() * 99);
    c.scale(s * 1.3, s * 0.7, s);
    c.rotateY(rng() * TAU);
    c.translate(Math.cos(a) * d, s * 0.2, Math.sin(a) * d);
    parts.push(tint(c, 0x8a8174, (x, y) => 0.75 + clamp01(y * 4) * 0.3));
  }
  const m = new THREE.Mesh(merge(parts), stoneMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

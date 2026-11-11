/*
 * realms/ice.js — the Frostfang Reach: everything that floats or freezes.
 *
 * The Reach is sailed under a polar low sun, so its set dressing is built to
 * catch raking light: glacial bergs with flat cleaved facets and soft bevels
 * (a smooth-min of random cutting planes, not noise lumps), a pale aquamarine
 * band at the waterline, and a wide underwater foot that is never seen
 * directly — it is baked into the shore map (SHORE_LAYER), so the ocean paints
 * turquoise shallows and a line of surf around every piece of ice.
 *
 *   buildIceField(theme, nodes, segs, rng)   the wilds: bergs, pack ice, growlers
 *   iceMooring(node, rng)                    brash ice round an open-water stop
 *   dressIceIsland(g, rng, theme, R, terrain) pines, snow boulders, an ice foot
 *   makeIceberg(rng, s) / makeIceFloe(rng, s) single pieces (battle backdrops etc.)
 *
 * All geometry is merged per cluster: a berg with its bergy bits and brash is
 * one draw call, a whole pack-ice patch is one draw call.
 */
import * as THREE from 'three';
import { SHORE_LAYER } from '../gfx/terrain.js';
import { bindAtmosphere } from '../gfx/atmosphere.js';
import { propGroup } from '../props.js';
import { rockGeometry } from '../models/kit.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEA_Y, smooth, lerp, makeNoise3, radialGeo, paint, mergeGeos, xform, laneTools } from './waterkit.js';

/* ── palette (sRGB hex; vertex colours) ──────────────────────────────────── */
const C = {
  snow: new THREE.Color(0xf6faff), snowShade: new THREE.Color(0xd9e8f4),
  ice: new THREE.Color(0x93c6e6), deep: new THREE.Color(0x3f8fca),
  aqua: new THREE.Color(0x86e2e4), bare: new THREE.Color(0xc4dcea),
  slate: new THREE.Color(0x56697e), slateDark: new THREE.Color(0x36465a),
};

/* ── the ice material: a little gloss + light bleeding through the shadow side */
const _mats = new Map();
export function iceMaterial(roughness = 0.38) {
  let m = _mats.get(roughness);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    bindAtmosphere(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      #ifdef USE_FOG
      {
        // sunlight carried THROUGH the ice: faces turned from the sun glow
        // glacier-blue instead of going grey, and silhouettes pick up a rim
        vec3 iceN = normalize(vNormal);
        float iceBack = max(dot(iceN, -uAtmoSunView.xyz) * 0.5 + 0.5, 0.0);
        float iceRim = pow(1.0 - max(dot(iceN, normalize(vViewPosition)), 0.0), 3.0);
        totalEmissiveRadiance += vec3(0.07, 0.34, 0.52) * diffuseColor.rgb
                               * (iceBack * iceBack * 0.34 + iceRim * 0.16);
      }
      #endif`);
  };
  m.customProgramCacheKey = () => 'thalassa-ice-v1';
  _mats.set(roughness, m);
  return m;
}

/* ── one glacial lump ────────────────────────────────────────────────────────
   A convex polytope (random cutting planes) evaluated with a smooth-min so the
   facets stay flat but every edge is softly bevelled, then melted a little by
   noise, undercut at the waterline and flared into an underwater foot.
   Local space: y = 0 is the sea surface. */
const _col = new THREE.Color();
function glacialLump(rng, noise, { R, H, kind = 'crag', detail = 2, p = 30, ex = 1, ez = 1,
                                   depth = 13, lumpy = 0.05, foot = 0.9 }) {
  const cy = Math.min(H * 0.3, 1.2);              // star centre, just above the sea
  const topH = H - cy;
  const planes = [];
  const through = (nx, ny, nz, px, py, pz) => {
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    planes.push([nx, ny, nz, Math.max(0.05, nx * px + ny * py + nz * pz)]);
  };
  const a0 = rng() * 6.283;
  if (kind === 'tabular' || kind === 'shelf') {
    const tilt = kind === 'shelf' ? 0.02 : 0.03 + rng() * 0.06;
    through(Math.cos(a0) * tilt, 1, Math.sin(a0) * tilt, 0, topH, 0);
    if (kind === 'tabular') {                     // one corner calved off on a slant
      const b = a0 + 1.8 + rng() * 2.4;
      through(Math.cos(b) * 0.85, 1, Math.sin(b) * 0.85, Math.cos(b) * R * 0.62, topH, Math.sin(b) * R * 0.62);
    }
  } else if (kind === 'wedge') {                  // a tilted slab: one end high, one awash
    const phi = 0.26 + rng() * 0.16;
    through(Math.sin(phi) * Math.cos(a0), Math.cos(phi), Math.sin(phi) * Math.sin(a0),
            -Math.cos(a0) * R * 0.8, topH, -Math.sin(a0) * R * 0.8);
    through(-Math.cos(a0) * 0.6, 1, -Math.sin(a0) * 0.6, -Math.cos(a0) * R * 0.7, topH, -Math.sin(a0) * R * 0.7);
  } else {
    // 'pinnacle' (steep, 3–4 faces meeting at an off-centre summit) or a
    // 'crag' (a broken crown of six cleaved faces)
    const steep = kind === 'pinnacle';
    const n = steep ? 3 + (rng() < 0.5 ? 1 : 0) : 6;
    const ax = (rng() - 0.5) * R * 0.5, az = (rng() - 0.5) * R * 0.5;
    for (let i = 0; i < n; i++) {
      const a = a0 + ((i + (rng() - 0.5) * 0.6) / n) * 6.283;
      const phi = steep ? Math.atan2(topH, R * (0.5 + rng() * 0.6)) : 0.4 + rng() * 0.6;
      const jx = steep ? 0 : (rng() - 0.5) * R * 0.7, jz = steep ? 0 : (rng() - 0.5) * R * 0.7;
      through(Math.sin(phi) * Math.cos(a), Math.cos(phi), Math.sin(phi) * Math.sin(a), ax + jx, topH, az + jz);
    }
    // chips: secondary cleavage planes that knock corners off the flanks, so
    // the mass reads as fractured crystal rather than a smooth cone
    const chips = steep ? 5 : 3;
    for (let i = 0; i < chips; i++) {
      const a = rng() * 6.283, e = 0.3 + rng() * 0.65, hgt = topH * (0.25 + rng() * 0.5);
      const rr = R * (0.72 - 0.42 * hgt / topH) * (0.85 + rng() * 0.3);
      through(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), Math.cos(a) * rr, hgt, Math.sin(a) * rr);
    }
  }
  // the cliffs: a ring of near-vertical cleavage planes, some leaning, some overhung
  const K = 6 + Math.floor(rng() * 4);
  for (let k = 0; k < K; k++) {
    const a = a0 + ((k + rng() * 0.7) / K) * 6.283;
    const psi = kind === 'pinnacle' ? rng() * 0.3 : -0.16 + rng() * 0.42;
    const h = R * (0.74 + rng() * 0.3);
    planes.push([Math.cos(psi) * Math.cos(a), Math.sin(psi), Math.cos(psi) * Math.sin(a), h]);
  }
  planes.push([0, -1, 0, cy + depth]);            // the keel

  const ox = rng() * 40, oy = rng() * 40, oz = rng() * 40;
  const geo = radialGeo(detail, (d, out) => {
    let s = 0;
    for (const pl of planes) {
      const k = d.x * pl[0] + d.y * pl[1] + d.z * pl[2];
      if (k > 0) s += Math.pow(k / pl[3], p);
    }
    let r = Math.pow(s, -1 / p);
    r *= 1 + (noise.fbm(d.x * 1.6 + ox, d.y * 1.6 + oy, d.z * 1.6 + oz) - 0.5) * 2 * lumpy
           + (noise(d.x * 6 + oz, d.y * 6 + ox, d.z * 6 + oy) - 0.5) * 0.035;
    let x = d.x * r * ex, y = d.y * r + cy, z = d.z * r * ez;
    // wave-cut notch at the waterline, then the foot spreading out below it
    const km = 1 - 0.08 * smooth(1.0, 0.25, y) * smooth(-0.5, 0.1, y)
             + foot * (0.45 * smooth(-0.25, -1.4, y) + 0.55 * smooth(-1.4, -depth, y));
    x *= km; z *= km;
    out.set(x, Math.max(-depth, y), z);
  });
  // colour: snow on what faces the sky, blue cleaved faces with veins of
  // deeper ice, an aquamarine band where the sea washes it
  const vx = 0.3 + rng() * 0.5, vz = (rng() - 0.5) * 0.8, vf = 1.5 + rng() * 1.4;
  paint(geo, (q, n, c) => {
    const up = n.y;
    c.copy(C.ice).lerp(C.snow, smooth(0.5, 0.82, up));
    c.lerp(C.snowShade, smooth(0.15, 0.5, up) * (1 - smooth(0.5, 0.82, up)) * 0.6);
    const band = 0.5 + 0.5 * Math.sin(q.y * vf + q.x * vx + q.z * vz + noise(q.x * 0.35, q.y * 0.35, q.z * 0.35) * 6);
    c.lerp(C.deep, smooth(0.45, 0.9, band) * (1 - smooth(0.3, 0.7, up)) * 0.62);
    if (up < 0) c.lerp(C.deep, Math.min(1, -up * 1.6) * 0.55);
    c.lerp(C.aqua, smooth(1.5, 0.05, q.y) * 0.7);
    c.multiplyScalar(0.92 + 0.12 * noise(q.x * 0.9 + 7, q.y * 0.9, q.z * 0.9 - 3));
  });
  return geo;
}

/* ── a flat floe: a slab of sea ice with a FRACTURED outline (a few long
   straight breaks between sharp corners, the odd notch bitten out of it),
   a snow blanket lying a little in from the edge on a domed top, a bevelled
   rim of bare blue ice, a thick vertical edge standing out of the water, and
   an aquamarine underwater skirt that slopes away into deep water (so the
   turquoise halo the ocean paints round it fades instead of stopping).
   Normals are creased: the top, bevel and wall each shade smooth, with a
   crisp break between them. ── */
const _floeTop = new THREE.Color(0xdcefff), _floeWall = new THREE.Color(0xa9d8ee), _floeSkirt = new THREE.Color(0x4fc0d8);
function floeGeo(rng, r, { top = 0.26, snowy = true, sides = 0 } = {}) {
  const big = r > 1.5;
  // corners of the break, at irregular bearings, joined by straight edges
  const m = sides || (r > 3.2 ? 9 : big ? 7 : 5) + Math.floor(rng() * 2);
  const el = Math.sqrt(1 + rng() * 0.55), ph = rng() * 6.283;
  const co = Math.cos(ph), si = Math.sin(ph);
  const cs = [];
  for (let i = 0; i < m; i++) cs.push((i + 0.15 + rng() * 0.7) / m * 6.283);
  const corner = cs.map(() => 0.78 + rng() * 0.3);
  const ux = [], uz = [];                          // the outline, at unit scale
  for (let i = 0; i < m; i++) {
    const a0 = cs[i], a1 = i + 1 < m ? cs[i + 1] : cs[0] + 6.283;
    const r0 = corner[i], r1 = corner[(i + 1) % m];
    const x0 = Math.cos(a0) * r0, z0 = Math.sin(a0) * r0, x1 = Math.cos(a1) * r1, z1 = Math.sin(a1) * r1;
    // a straight break, split once with a small kink (or a bitten notch)
    const notch = rng() < 0.18;
    const t = 0.35 + rng() * 0.3, kink = notch ? 0.78 : 0.97 + rng() * 0.06;
    const pts = [[x0, z0], [(x0 + (x1 - x0) * t) * kink, (z0 + (z1 - z0) * t) * kink]];
    for (const [x, z] of pts) {
      const X = x * r * el, Z = z * r / el;
      ux.push(X * co - Z * si); uz.push(X * si + Z * co);
    }
  }
  const n = ux.length;
  const thick = 0.1 + Math.min(0.22, r * 0.05);   // freeboard of the edge above the sea
  const snowC = _col.copy(snowy ? C.snow : _floeTop).multiplyScalar(0.95 + rng() * 0.06).clone();
  const rimC = snowy ? C.snowShade.clone().lerp(_floeTop, 0.6) : _floeTop.clone().lerp(C.ice, 0.3);
  const wallC = _floeWall, skirtC = _floeSkirt;
  const dome = top * 0.3 + (big ? 0.08 : 0.03);
  const yt = thick + top * 0.35;                   // the flat of the top at the rim
  const pos = [0, yt + dome, 0], col = [snowC.r, snowC.g, snowC.b];
  // [scale, y, colour, wobble] rings from the crown out and down
  const rings = [
    [0.55, yt + dome * 0.75, snowC, 0.0],
    [0.86, yt + 0.02, snowC, 0.05],                // the snow's edge (wobbly)
    [0.93, yt, rimC, 0.0],                         // bare-ice rim
    [0.985, yt - 0.04, rimC, 0.0],                 // bevel
    [1.0, yt - 0.09, wallC, 0.0],                  // top of the wall
    [1.0, -0.02, wallC, 0.0],                      // waterline
    [1.06, -0.32, skirtC, 0.0],
    [1.3, -1.3, C.aqua, 0.0],
    [1.9, -14, C.aqua, 0.0],
  ];
  if (!snowy) for (const rg of rings.slice(0, 2)) rg[2] = _floeTop;
  for (const [k, y, c, wob] of rings) {
    for (let i = 0; i < n; i++) {
      const kk = k * (1 - wob * rng());
      pos.push(ux[i] * kk, y, uz[i] * kk);
      col.push(c.r, c.g, c.b);
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(0, 1 + (i + 1) % n, 1 + i);
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = 1 + j * n + i, b = 1 + j * n + (i + 1) % n, d = a + n, e = b + n;
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const out = toCreasedNormals(geo, 0.62);
  geo.dispose();
  return out;
}

/* a pressure ridge: slabs of ice shouldered up along a line across a floe */
function ridgeGeos(rng, noise, x0, z0, x1, z1, y, out) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(3, Math.round(len / 1.1));
  for (let i = 0; i < n; i++) {
    const t = (i + rng() * 0.6) / n;
    const s = 0.55 + rng() * 0.75;
    const slab = glacialLump(rng, noise, { R: s, H: s * (0.5 + rng() * 0.5), kind: 'wedge', detail: 1,
      p: 9, depth: 0.25, foot: 0, ex: 1.2 + rng() * 0.6, ez: 0.7 });
    xform(slab, { x: lerp(x0, x1, t) + (rng() - 0.5) * 0.8, y: y - 0.05, z: lerp(z0, z1, t) + (rng() - 0.5) * 0.8,
      ry: rng() * 6.283, rx: (rng() - 0.5) * 0.7, rz: (rng() - 0.5) * 0.7 });
    out.push(slab);
  }
}

/* ── iceberg archetypes: returns a list of geometries in berg-local space ──── */
function bergGeos(rng, noise, s = 1, kind = null) {
  const out = [];
  kind = kind || ['cathedral', 'tabular', 'wedge', 'cathedral', 'twin'][Math.floor(rng() * 5)];
  const ry = rng() * 6.283;
  const place = (geo, x, z, extra = {}) => out.push(xform(geo, { x, z, ry: rng() * 6.283, ...extra }));
  let R;                                           // footprint radius, for the brash ring
  if (kind === 'cathedral') {
    R = (5.2 + rng() * 1.8) * s;
    const H = (13 + rng() * 7) * s;
    place(glacialLump(rng, noise, { R, H, kind: 'pinnacle', detail: s > 1.4 ? 5 : 7, ex: 1.15, p: 40 }), 0, 0);
    const a = rng() * 6.283;
    place(glacialLump(rng, noise, { R: R * 0.62, H: H * (0.42 + rng() * 0.2), kind: 'pinnacle', detail: 4 }),
      Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95);
    place(glacialLump(rng, noise, { R: R * 0.95, H: (0.7 + rng() * 0.5) * s, kind: 'shelf', detail: 3, ex: 1.3 }),
      Math.cos(a + 2.4) * R * 0.85, Math.sin(a + 2.4) * R * 0.85);
    R *= 1.5;
  } else if (kind === 'tabular') {
    R = (8 + rng() * 4) * s;
    const H = (3.6 + rng() * 2.2) * s;
    place(glacialLump(rng, noise, { R, H, kind: 'tabular', detail: s > 1.4 ? 5 : 7, ex: 1.45, ez: 0.95, p: 40, lumpy: 0.035 }), 0, 0);
    const a = rng() * 6.283;
    place(glacialLump(rng, noise, { R: R * 0.36, H: H * 0.7, kind: 'tabular', detail: 4, p: 36 }),
      Math.cos(a) * R * 1.55, Math.sin(a) * R * 1.2);
    R *= 1.5;
  } else if (kind === 'wedge') {
    R = (7 + rng() * 3) * s;
    const H = (8.5 + rng() * 4.5) * s;
    place(glacialLump(rng, noise, { R, H, kind: 'wedge', detail: s > 1.4 ? 5 : 7, ex: 1.25, p: 40 }), 0, 0);
    const a = rng() * 6.283;
    place(glacialLump(rng, noise, { R: R * 0.6, H: (0.6 + rng() * 0.4) * s, kind: 'shelf', detail: 3, ex: 1.4 }),
      Math.cos(a) * R * 1.0, Math.sin(a) * R * 1.0);
    R *= 1.4;
  } else {                                         // 'twin': two weathered domes on one foot
    R = (5 + rng() * 2) * s;
    const H = (7 + rng() * 4) * s;
    place(glacialLump(rng, noise, { R, H, kind: 'crag', detail: 6, p: 40 }), -R * 0.5, 0);
    place(glacialLump(rng, noise, { R: R * 0.8, H: H * 0.66, kind: 'crag', detail: 4 }), R * 0.75, R * 0.3);
    place(glacialLump(rng, noise, { R: R * 1.25, H: 0.6 * s, kind: 'shelf', detail: 3, ex: 1.4 }), 0.1 * R, 0.1 * R);
    R *= 1.6;
  }
  // bergy bits calved off it, and a skirt of brash drifting in its lee
  const bits = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < bits; i++) {
    const a = rng() * 6.283, d = R * (0.95 + rng() * 0.5);
    const br = (1.1 + rng() * 1.3) * s;
    place(glacialLump(rng, noise, { R: br, H: br * (0.7 + rng() * 0.7), kind: rng() < 0.5 ? 'crag' : 'wedge', detail: 2, p: 16, depth: 9 }),
      Math.cos(a) * d, Math.sin(a) * d);
  }
  const brash = 5 + Math.floor(rng() * 5);
  for (let i = 0; i < brash; i++) {
    const a = rng() * 6.283, d = R * (1.0 + rng() * 0.75);
    place(floeGeo(rng, (0.7 + rng() * 1.3) * s, { top: 0.16 + rng() * 0.12, snowy: rng() < 0.6 }), Math.cos(a) * d, Math.sin(a) * d);
  }
  for (const g of out) g.rotateY(ry);
  return { geos: out, R: R * 1.6 };
}

function iceMesh(geos, { rough = 0.38, cast = true } = {}) {
  const mesh = new THREE.Mesh(mergeGeos(geos), iceMaterial(rough));
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.layers.enable(SHORE_LAYER);                // the ocean paints shallows + surf round it
  mesh.position.y = SEA_Y;
  return mesh;
}

let _sharedNoise = null;
const sharedNoise = () => _sharedNoise || (_sharedNoise = makeNoise3(4711));

/* a single iceberg as an Object3D standing in the sea at its position (y = 0) */
export function makeIceberg(rng, s = 1, kind = null) {
  const g = new THREE.Group();
  const { geos } = bergGeos(rng, sharedNoise(), s, kind);
  g.add(iceMesh(geos));
  return g;
}

/* a small raft of drift ice */
export function makeIceFloe(rng, s = 1) {
  const g = new THREE.Group();
  const geos = [];
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.283, d = i === 0 ? 0 : (1.6 + rng() * 1.6) * s;
    geos.push(xform(floeGeo(rng, (i === 0 ? 1.6 : 0.6 + rng() * 0.8) * s, { snowy: rng() < 0.7 }),
      { x: Math.cos(a) * d, z: Math.sin(a) * d }));
  }
  g.add(iceMesh(geos, { rough: 0.6, cast: false }));
  return g;
}

/* ── a patch of pack ice: big floes first, then the gaps choked with small ── */
function packPatch(rng, noise, tools, cx, cz, rad, geos) {
  const placed = [];
  const tryPut = (r, tries) => {
    for (let t = 0; t < tries; t++) {
      const a = rng() * 6.283, d = rad * Math.pow(rng(), 0.65);
      const x = cx + Math.cos(a) * d * 1.25, z = cz + Math.sin(a) * d * 0.85;
      // the sailing lane stays an open lead through the pack
      if (tools.segDist(x, z) < r + 7.5 || tools.nodeGap(x, z) < r + 1.5) continue;
      let ok = true;
      for (const q of placed) {
        if (Math.hypot(q.x - x, q.z - z) < (q.r + r) * 1.06 + 0.35) { ok = false; break; }
      }
      if (ok) { placed.push({ x, z, r }); return true; }
    }
    return false;
  };
  const big = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < big; i++) tryPut(4.2 + rng() * 3.4, 24);
  const med = 7 + Math.floor(rad * 0.25);
  for (let i = 0; i < med; i++) tryPut(2.0 + rng() * 1.8, 20);
  const small = 12 + Math.floor(rad * 0.7);
  for (let i = 0; i < small; i++) tryPut(0.7 + rng() * 1.1, 14);
  for (const q of placed) {
    const top = 0.18 + Math.min(0.2, q.r * 0.035) + rng() * 0.06;
    const snowy = q.r > 1.6 ? rng() < 0.85 : rng() < 0.45;
    geos.push(xform(floeGeo(rng, q.r, { top, snowy, }),
      { x: q.x, z: q.z, rx: (rng() - 0.5) * 0.03, rz: (rng() - 0.5) * 0.03 }));
    if (q.r > 4.4 && rng() < 0.7) {               // a pressure ridge across the big floes
      const a = rng() * 6.283, l = q.r * (0.55 + rng() * 0.2);
      const ox = (rng() - 0.5) * q.r * 0.4, oz = (rng() - 0.5) * q.r * 0.4;
      ridgeGeos(rng, noise, q.x + ox - Math.cos(a) * l, q.z + oz - Math.sin(a) * l,
                q.x + ox + Math.cos(a) * l, q.z + oz + Math.sin(a) * l, top, geos);
    }
  }
  return placed;
}

/* ── the wilds of the Reach ────────────────────────────────────────────────── */
export function buildIceField(theme, nodes, segs, rng) {
  const g = new THREE.Group();
  g.name = 'icefield';
  const tools = laneTools(nodes, segs);
  const noise = sharedNoise();
  const M = 70;
  const x0 = tools.minX - M, x1 = tools.maxX + M, z0 = tools.minZ - M, z1 = tools.maxZ + M;
  const taken = [];                                // {x, z, r} of everything big
  const freeOf = (x, z, r) => {
    for (const q of taken) if (Math.hypot(q.x - x, q.z - z) < q.r + r) return false;
    return true;
  };
  const pick = (laneMin, laneMax, r, tries = 60) => {
    for (let t = 0; t < tries; t++) {
      const x = x0 + rng() * (x1 - x0), z = z0 + rng() * (z1 - z0);
      const sd = tools.segDist(x, z);
      if (sd < laneMin || sd > laneMax) continue;
      if (tools.nodeGap(x, z) < r * 0.6) continue;
      if (!freeOf(x, z, r)) continue;
      return { x, z };
    }
    return null;
  };

  /* bergs in three ranks: heroes standing just off the lane, a scatter of
     smaller bergs that keeps the middle distance busy, and giants far out
     whose blue silhouettes break the horizon through the haze */
  const kinds = ['cathedral', 'tabular', 'wedge', 'twin', 'cathedral', 'tabular', 'wedge'];
  const putBerg = (laneMin, laneMax, s, i) => {
    const kind = kinds[i % kinds.length];
    const span = (kind === 'tabular' ? 15 : 10) * s;
    const p = pick(laneMin + span, laneMax + span, span + 7, 120);
    if (!p) return;
    const { geos, R } = bergGeos(rng, noise, s, kind);
    const m = iceMesh(geos);
    m.position.set(p.x, SEA_Y, p.z);
    g.add(m);
    taken.push({ x: p.x, z: p.z, r: R * 0.8 });
  };
  for (let i = 0; i < 9; i++) putBerg(8, 30, 0.75 + rng() * 0.4, i);
  for (let i = 0; i < 8; i++) putBerg(34, 150, 1.5 + rng() * 0.9, i + 2);
  for (let i = 0; i < 13; i++) {                   // the fill: single weathered lumps
    const s = 0.7 + rng() * 0.8;
    const p = pick(12, 110, 9 * s, 80);
    if (!p) continue;
    const R = (3 + rng() * 2) * s;
    const kind = ['pinnacle', 'crag', 'wedge', 'tabular'][i % 4];
    const geos = [glacialLump(rng, noise, { R, H: R * (kind === 'pinnacle' ? 1.9 : kind === 'tabular' ? 0.6 : 1.1) * (0.8 + rng() * 0.5),
      kind, detail: 4, ex: 1 + rng() * 0.4 })];
    const a = rng() * 6.283;
    geos.push(xform(glacialLump(rng, noise, { R: R * 0.8, H: 0.5 + rng() * 0.4, kind: 'shelf', detail: 2, ex: 1.3, depth: 9 }),
      { x: Math.cos(a) * R * 0.9, z: Math.sin(a) * R * 0.9, ry: rng() * 6.283 }));
    for (let k = 0; k < 4; k++) {
      const b = rng() * 6.283, d = R * (1.5 + rng() * 0.9);
      geos.push(xform(floeGeo(rng, 0.6 + rng() * 1.1, { top: 0.14 + rng() * 0.1, snowy: rng() < 0.6 }), { x: Math.cos(b) * d, z: Math.sin(b) * d }));
    }
    const m = iceMesh(geos);
    m.position.set(p.x, SEA_Y, p.z);
    m.rotation.y = rng() * 6.283;
    g.add(m);
    taken.push({ x: p.x, z: p.z, r: R * 2.2 });
  }

  /* pack ice: patches that crowd the lane on both sides, so the route reads
     as a lead of open water threading through it */
  let wreckSpot = null;
  for (let i = 0; i < 9; i++) {
    const rad = 15 + rng() * 13;
    const p = pick(i < 6 ? 4 : 16, i < 6 ? 30 : 95, rad * 0.55);
    if (!p) continue;
    const geos = [];
    const placed = packPatch(rng, noise, tools, p.x, p.z, rad, geos);
    if (!geos.length) continue;
    const m = iceMesh(geos, { rough: 0.6, cast: false });
    g.add(m);
    taken.push({ x: p.x, z: p.z, r: rad * 0.75 });
    if (!wreckSpot) wreckSpot = placed.find((q) => q.r > 4.6) || null;
  }

  /* growlers: house-sized lumps awash everywhere else, one merged mesh */
  {
    const geos = [];
    let n = 0, tries = 0;
    while (n < 24 && tries++ < 900) {
      const x = x0 + rng() * (x1 - x0), z = z0 + rng() * (z1 - z0);
      const sd = tools.segDist(x, z);
      if (sd < 9 || sd > 150 || tools.nodeGap(x, z) < 3 || !freeOf(x, z, 2)) continue;
      const r = 0.8 + rng() * rng() * 2.2;
      geos.push(xform(glacialLump(rng, noise, { R: r, H: r * (0.55 + rng() * 0.8), kind: rng() < 0.5 ? 'crag' : 'wedge',
        detail: 2, p: 16, depth: 8 }), { x, z, ry: rng() * 6.283 }));
      n++;
    }
    if (geos.length) g.add(iceMesh(geos));
  }

  /* a ship that did not make it: locked into the pack, hull canted over */
  if (wreckSpot) {
    const wreck = propGroup('shipwreck', 1.5);
    wreck.position.set(wreckSpot.x, 0.05, wreckSpot.z);
    wreck.rotation.set(0.1, rng() * 6.283, 0.22);
    g.add(wreck);
  }

  /* crystal spires: the Reach's signature shards, rooted in the pack near the lane */
  for (let i = 0; i < 3; i++) {
    const p = pick(10, 34, 4, 40);
    if (!p) continue;
    const sp = new THREE.Group();
    sp.position.set(p.x, 0, p.z);
    const shard = propGroup('ice_shard', 1.6 + rng() * 1.1);
    shard.position.y = 0.05;
    shard.rotation.y = rng() * 6.283;
    sp.add(shard);
    const base = iceMesh([floeGeo(rng, 3.4 + rng() * 1.4, { top: 0.3 })], { rough: 0.6, cast: false });
    sp.add(base);
    g.add(sp);
    taken.push({ x: p.x, z: p.z, r: 5 });
  }
  return g;
}

/* ── an open-water stop: brash and pancake ice ringing the berth ───────────── */
export function iceMooring(node, rng) {
  const g = new THREE.Group();
  const noise = sharedNoise();
  const geos = [];
  // pancake ice: thin plates barely proud of the water — a hull shoulders through them
  const n = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.283, d = 6.5 + rng() * 9;
    geos.push(xform(floeGeo(rng, 0.6 + rng() * 1.0, { top: 0.1 + rng() * 0.06, snowy: rng() < 0.5 }),
      { x: Math.cos(a) * d, z: Math.sin(a) * d }));
  }
  if (node.look === 'rocks') {                     // bergy bits standing off the berth
    const a0 = rng() * 6.283;
    for (let i = 0; i < 2; i++) {
      const a = a0 + i * (1.7 + rng()), d = 8.5 + rng() * 3;
      const r = 1.5 + rng() * 1.3;
      geos.push(xform(glacialLump(rng, noise, { R: r, H: r * (0.9 + rng() * 0.9), kind: i ? 'wedge' : 'crag',
        detail: 3, p: 24, depth: 9 }), { x: Math.cos(a) * d, z: Math.sin(a) * d, ry: rng() * 6.283 }));
    }
  } else if (node.look === 'islet') {              // a grounded tabular floe, big enough to stand on
    const a = rng() * 6.283, d = 9.5 + rng() * 2;
    const r = 3.4 + rng() * 1.4, h = 1.0 + rng() * 0.7;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    geos.push(xform(glacialLump(rng, noise, { R: r, H: h, kind: 'tabular', detail: 3, p: 30, ex: 1.3, lumpy: 0.035 }),
      { x, z, ry: rng() * 6.283 }));
    if (rng() < 0.3) {
      const top = propGroup('ice_shard', 0.9 + rng() * 0.5);
      top.position.set(x, SEA_Y + h - 0.12, z);
      top.rotation.y = rng() * 6.283;
      g.add(top);
    } else {                                       // a clutch of frost spires
      const ns = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < ns; i++) {
        const sr = 0.45 + rng() * 0.3;
        geos.push(xform(glacialLump(rng, noise, { R: sr, H: sr * (3.2 + rng() * 2.2), kind: 'pinnacle', detail: 2, p: 12, depth: 0.3, foot: 0 }),
          { x: x + (rng() - 0.5) * r * 0.7, y: h - 0.15, z: z + (rng() - 0.5) * r * 0.7, ry: rng() * 6.283, rx: (rng() - 0.5) * 0.3, rz: (rng() - 0.5) * 0.3 }));
      }
    }
  }
  g.add(iceMesh(geos, { rough: 0.5 }));
  return g;
}

/* ── island dressing: stands of pine, snow-capped boulders, an ice foot ────── */
function snowBoulder(rng, noise, r) {
  // the kit's craggy rock (fracture planes, creased normals, strata) in
  // Frostfang slate, snow lying on every ledge that faces the sky
  return rockGeometry(Math.floor(rng() * 1e9), { r, sy: 0.65 + rng() * 0.3, detail: 2, rough: 0.14,
    rock: 0x56697e, top: 0xf6faff, cover: 0.95, strata: 0.4, base: -0.3 });
}
let _rockMat = null;
const rockMaterial = () => _rockMat || (_rockMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.86, metalness: 0 }));

export function dressIceIsland(g, rng, theme, R, terrain) {
  const noise = sharedNoise();
  // pines stand in one or two tight groves off the heart of the isle
  const groves = 1 + (rng() < 0.3 ? 1 : 0);
  let a0 = rng() * 6.283;
  for (let k = 0; k < groves; k++) {
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i - (n - 1) / 2) * (0.34 + rng() * 0.12), rr = 0.46 + rng() * 0.2;
      const p = terrain.place(a, rr);
      if (p.y < 0.25) continue;
      const tree = propGroup(rng() < 0.75 ? 'pine_snow' : 'pine_tree', 0.9 + rng() * 0.55);
      tree.position.set(p.x, p.y - 0.05, p.z);
      tree.rotation.y = rng() * 6.283;
      g.add(tree);
    }
    a0 += 2.0 + rng() * 2.2;
  }
  // boulders shouldering out of the snow
  const rocks = [];
  const nb = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < nb; i++) {
    const a = rng() * 6.283, rr = 0.42 + rng() * 0.42;
    const p = terrain.place(a, rr);
    if (p.y < 0.1) continue;
    const r = 0.45 + rng() * 0.75;
    rocks.push(xform(snowBoulder(rng, noise, r), { x: p.x, y: p.y + r * 0.12, z: p.z, ry: rng() * 6.283 }));
  }
  if (rocks.length) {
    const m = new THREE.Mesh(mergeGeos(rocks), rockMaterial());
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  // the ice foot: shore-fast floes grounded round the beach
  const ice = [];
  const nf = 5 + Math.floor(rng() * 5);
  for (let i = 0; i < nf; i++) {
    const a = rng() * 6.283;
    const p = terrain.place(a, 1.16 + rng() * 0.3);
    ice.push(xform(floeGeo(rng, 0.9 + rng() * 1.5, { top: 0.14 + rng() * 0.12, snowy: rng() < 0.7 }), { x: p.x, z: p.z }));
  }
  g.add(iceMesh(ice, { rough: 0.6, cast: false }));
  // …and now and then a crystal outcrop
  if (rng() < 0.35) {
    const p = terrain.place(rng() * 6.283, 0.36 + rng() * 0.2);
    if (p.y >= 0.2) {
      const pr = propGroup(rng() < 0.3 ? 'crystal_cluster' : 'ice_shard', 0.8 + rng() * 0.5);
      pr.position.set(p.x, p.y - 0.06, p.z);
      pr.rotation.y = rng() * 6.283;
      g.add(pr);
    }
  }
}

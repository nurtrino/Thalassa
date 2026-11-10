/*
 * realms/jungle.js — the Verdigris Deep: a drowned forest sailed by river.
 *
 * The realm is meant to feel ENCLOSED: the lanes are channels between low mud
 * banks crowded with canopy trees, mangroves wading out on stilt roots, reeds
 * and lily rafts in the slack water, and the odd ruin going under. Hand-sculpted
 * GLB trees are far too heavy to plant by the hundred (≈10k triangles each), so
 * the mass of the forest is procedural and INSTANCED — a few tree, mangrove,
 * fern, reed and lily shapes drawn many times — and the GLB heroes are spent
 * only where the eye lands (island tops, the ruins by the lane).
 *
 *   buildJungleField(theme, nodes, segs, rng)   banks, tree lines, shoals, ruins
 *   jungleMooring(node, rng)                    a lily raft / islet at a water stop
 *   dressJungleIsland(g, rng, theme, R, terrain, node)
 *   makeLilyRaft(rng, s)                        a drifting raft of pads (single piece)
 *
 * Banks and shoals go on SHORE_LAYER so the river shows silty shallows over
 * them and lies calm where the lilies float.
 */
import * as THREE from 'three';
import { SHORE_LAYER, makeGroundMaterial, GROUND_TILE } from '../gfx/terrain.js';
import { bindAtmosphere } from '../gfx/atmosphere.js';
import { propGroup } from '../props.js';
import { SEA_Y, smooth, lerp, makeNoise3, radialGeo, paint, mergeGeos, xform, tubeAlong, laneTools } from './waterkit.js';

const hex = (h) => new THREE.Color(h);
const C = {
  leafDark: hex(0x0d2a15), leafMid: hex(0x1e5524), leafLit: hex(0x3f8a2c), leafTip: hex(0x8dbb40),
  mangDark: hex(0x14331a), mangMid: hex(0x34692a), mangLit: hex(0x6f9c38),
  bark: hex(0x6d5a44), barkLight: hex(0x8f7c5e), barkWet: hex(0x3a3024), moss: hex(0x4d6a2c),
  mud: hex(0x57482e), mudWet: hex(0x3f3524), litter: hex(0x5b6230), turf: hex(0x3a7a30), turf2: hex(0x24592a),
  pad: hex(0x4c9a3e), padRim: hex(0x2c6c30), padDry: hex(0x7fa84a), lotus: hex(0xf3a9cb), lotusTip: hex(0xfff0f6),
  reed: hex(0x6f9a3c), reedBase: hex(0x3d6a2a), cattail: hex(0x5a3a22),
  stone: hex(0x6b6e5c), stoneDark: hex(0x3f4638),
};
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

let _noise = null;
const noise3 = () => _noise || (_noise = makeNoise3(9173));

/* ── materials ───────────────────────────────────────────────────────────── */
let _foliage = null, _card = null, _wood = null, _stone = null, _bank = null;
/* a tiling sheet of painted leaf-dabs: light, mid and dark strokes laid over
   one another. Projected triplanar onto every canopy so the leaf masses read
   as foliage, not as smooth green balloons. */
let _leafTex = null;
function leafTexture() {
  if (_leafTex) return _leafTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgb(92,104,84)';
  ctx.fillRect(0, 0, S, S);
  let sd = 77123;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * S, y = rnd() * S, L = 9 + rnd() * 15, W = L * (0.34 + rnd() * 0.2), a = rnd() * 6.283;
    const t = rnd();
    const v = t < 0.22 ? 70 + rnd() * 40 : t < 0.72 ? 130 + rnd() * 50 : 200 + rnd() * 55;
    const warm = t >= 0.72 ? 1.06 : t < 0.22 ? 0.9 : 1.0;
    ctx.fillStyle = `rgba(${Math.min(255, v * warm) | 0},${Math.min(255, v * 1.04) | 0},${(v * (2 - warm) * 0.86) | 0},0.82)`;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox < -40 || x + ox > S + 40 || y + oy < -40 || y + oy > S + 40) continue;
      ctx.beginPath();
      ctx.ellipse(x + ox, y + oy, L, W, a, 0, 6.2832);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return (_leafTex = t);
}
/* canopy: leaf-dab albedo, and sunlight glowing THROUGH leaves that face away */
function foliageMaterial() {
  if (_foliage) return _foliage;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0 });
  const uLeafTex = { value: leafTexture() };
  m.onBeforeCompile = (shader) => {
    bindAtmosphere(shader);
    shader.uniforms.uLeafTex = uLeafTex;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafP;\nvarying vec3 vLeafN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLeafP = position;\nvLeafN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uLeafTex;\nvarying vec3 vLeafP;\nvarying vec3 vLeafN;')
      .replace('#include <color_fragment>', /* glsl */`
      #include <color_fragment>
      float leafK = 1.0;
      {
        vec3 lw = abs(vLeafN); lw *= lw; lw /= (lw.x + lw.y + lw.z + 1e-4);
        vec3 lp = vLeafP * 0.21;
        vec3 dab = texture2D(uLeafTex, lp.zy).rgb * lw.x + texture2D(uLeafTex, lp.xz).rgb * lw.y
                 + texture2D(uLeafTex, lp.xy).rgb * lw.z;
        // bark (red ≥ green) keeps its own colour; leaves take the dabs
        leafK = smoothstep(0.0, 0.05, diffuseColor.g - diffuseColor.r);
        diffuseColor.rgb *= mix(vec3(1.0), dab * 2.6, leafK);
      }`)
      .replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      #ifdef USE_FOG
      {
        float leafBack = max(dot(normalize(vNormal), -uAtmoSunView.xyz) * 0.5 + 0.5, 0.0);
        totalEmissiveRadiance += vec3(0.34, 0.40, 0.05) * diffuseColor.rgb * leafBack * leafBack * 0.5 * leafK;
      }
      #endif`);
  };
  m.customProgramCacheKey = () => 'thalassa-foliage-v2';
  return (_foliage = m);
}
/* thin leaves — pads, reeds, ferns — seen from both sides */
const cardMaterial = () => _card || (_card = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide }));
const stoneMaterial = () => _stone || (_stone = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.9, metalness: 0 }));
const bankMaterial = () => _bank || (_bank = makeGroundMaterial({ bump: 0.7, tide: true }));

/* ── canopy tree ─────────────────────────────────────────────────────────────
   A leaning trunk on buttress roots under an umbrella crown of billowed leaf
   masses. The crown's normals are bent toward "outward from the crown" so the
   whole canopy shades as one soft volume rather than as separate lumps. */
function crownBlob(rng, noise, r, sy, detail, cx, cy, cz, pal) {
  const ox = rng() * 50, oy = rng() * 50, oz = rng() * 50;
  const geo = radialGeo(detail, (d, out) => {
    const n = noise.fbm(d.x * 1.7 + ox, d.y * 1.7 + oy, d.z * 1.7 + oz);
    const billow = 1 - Math.abs(2 * noise(d.x * 3.1 + oz, d.y * 3.1 + ox, d.z * 3.1 + oy) - 1);
    const k = r * (0.74 + 0.32 * n + 0.2 * billow);
    out.set(d.x * k, d.y * k * (d.y < 0 ? sy * 0.5 : sy), d.z * k);
  });
  paint(geo, (q, n, c) => {
    const h = smooth(-0.45, 0.95, q.y / (r * sy));
    c.copy(pal[0]).lerp(pal[1], smooth(0.0, 0.5, h));
    c.lerp(pal[2], smooth(0.4, 0.95, h) * 0.9);
    c.lerp(pal[3], smooth(0.55, 0.85, noise(q.x * 0.9 + ox, q.y * 0.9, q.z * 0.9 + oz)) * smooth(0.45, 1, h) * 0.55);
  });
  // soften: blend the true normals toward the blob's radial direction
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i) + r * 0.25, z = pos.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    x = lerp(nor.getX(i), x / l, 0.55); y = lerp(nor.getY(i), y / l, 0.55); z = lerp(nor.getZ(i), z / l, 0.55);
    const m = Math.hypot(x, y, z) || 1;
    nor.setXYZ(i, x / m, y / m, z / m);
  }
  geo.translate(cx, cy, cz);
  return geo;
}

function barkPaint(t, c) { c.copy(C.barkWet).lerp(C.bark, smooth(0.0, 0.25, t)).lerp(C.barkLight, smooth(0.5, 1, t) * 0.5); }

function canopyTreeGeo(seed, near) {
  let s = seed >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const noise = noise3();
  const H = 7.2;
  const la = rng() * 6.283, lean = 0.3 + rng() * 0.7;
  const lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
  const geos = [];
  geos.push(tubeAlong([V3(0, -0.7, 0), V3(lx * 0.15, H * 0.22, lz * 0.15), V3(lx * 0.6, H * 0.45, lz * 0.6), V3(lx, H * 0.7, lz)],
    0.58, 0.27, { radial: near ? 5 : 4, steps: near ? 4 : 2, colourOf: barkPaint }));
  const roots = near ? 3 : 0;                      // far trees stand in undergrowth — no roots to see
  for (let i = 0; i < roots; i++) {
    const a = la + (i / roots) * 6.283 + rng() * 0.5, d = 1.2 + rng() * 0.5;
    geos.push(tubeAlong([V3(Math.cos(a) * 0.15, 1.7 + rng() * 0.5, Math.sin(a) * 0.15), V3(Math.cos(a) * d * 0.55, 0.4, Math.sin(a) * d * 0.55),
      V3(Math.cos(a) * d, -0.6, Math.sin(a) * d)], 0.27, 0.12, { radial: 3, steps: 2, colourOf: (t, c) => c.copy(C.bark).lerp(C.barkWet, t) }));
  }
  // the crown: one high dome with a ring of lower lumps crowding under it
  const pal = [C.leafDark, C.leafMid, C.leafLit, C.leafTip];
  const cr = H * (0.3 + rng() * 0.04);
  geos.push(crownBlob(rng, noise, cr, 0.74, near ? 2 : 1, lx, H * 0.86, lz, pal));
  const side = near ? 4 : 3;
  const a0 = rng() * 6.283;
  for (let i = 0; i < side; i++) {
    const a = a0 + (i / side) * 6.283 + (rng() - 0.5) * 0.6, d = cr * (0.78 + rng() * 0.25);
    geos.push(crownBlob(rng, noise, cr * (0.66 + rng() * 0.2), 0.74, 1,
      lx + Math.cos(a) * d, H * (0.64 + rng() * 0.12), lz + Math.sin(a) * d, pal));
  }
  return mergeGeos(geos);
}

/* ── a whole bank's canopy as ONE mesh: overlapping leaf domes on bare trunks.
   This is what makes the forest read as a wall — a dozen crowns for the price
   of two trees. spots: [{x, y, z, r}] crown centres in world space. */
function canopyMassGeos(rng, noise, spots, out) {
  const pal = [C.leafDark, C.leafMid, C.leafLit, C.leafTip];
  spots.forEach((sp, i) => {
    const tint = 0.86 + rng() * 0.28;
    const blob = crownBlob(rng, noise, sp.r, 0.72 + rng() * 0.12, i < 2 && spots.length > 3 ? 2 : 1, sp.x, sp.y, sp.z, pal);
    const col = blob.attributes.color;
    for (let v = 0; v < col.count; v++) col.setXYZ(v, col.getX(v) * tint * (0.95 + rng() * 0.1), col.getY(v) * tint, col.getZ(v) * tint * 0.92);
    out.push(blob);
    const gx = sp.x + (rng() - 0.5) * 1.2, gz = sp.z + (rng() - 0.5) * 1.2;
    out.push(tubeAlong([V3(gx, sp.g - 0.5, gz), V3((gx + sp.x) / 2 + (rng() - 0.5) * 0.5, (sp.g + sp.y) / 2, (gz + sp.z) / 2), V3(sp.x, sp.y - sp.r * 0.1, sp.z)],
      0.42, 0.2, { radial: 4, steps: 2, colourOf: barkPaint }));
  });
}

/* ── mangrove: a short crooked trunk standing on arching stilt roots ───────── */
function mangroveGeo(seed) {
  let s = seed >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const noise = noise3();
  const geos = [];
  const tx = (rng() - 0.5) * 0.8, tz = (rng() - 0.5) * 0.8;
  geos.push(tubeAlong([V3(0, 1.2, 0), V3(tx * 0.5, 2.2, tz * 0.5), V3(tx, 3.3, tz)], 0.26, 0.14,
    { radial: 4, steps: 2, colourOf: (t, c) => c.copy(C.bark).lerp(C.barkLight, t * 0.6) }));
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + rng() * 0.6, d = 1.3 + rng() * 1.2, h = 1.0 + rng() * 0.9;
    geos.push(tubeAlong([V3(Math.cos(a) * 0.1, h, Math.sin(a) * 0.1), V3(Math.cos(a) * d * 0.6, h * 0.95, Math.sin(a) * d * 0.6),
      V3(Math.cos(a) * d, 0.1, Math.sin(a) * d), V3(Math.cos(a) * d * 1.08, -1.0, Math.sin(a) * d * 1.08)], 0.15, 0.08,
      { radial: 3, steps: 3, colourOf: (t, c) => c.copy(C.bark).lerp(C.barkWet, smooth(0.45, 0.8, t)) }));
  }
  const pal = [C.mangDark, C.mangMid, C.mangLit, C.leafTip];
  geos.push(crownBlob(rng, noise, 2.2 + rng() * 0.4, 0.62, 1, tx, 3.8, tz, pal));
  const a = rng() * 6.283;
  geos.push(crownBlob(rng, noise, 1.7, 0.62, 1, tx + Math.cos(a) * 1.6, 3.3, tz + Math.sin(a) * 1.6, pal));
  return mergeGeos(geos);
}

/* a low broad-leaved shrub that hides the trunks and closes the tree line */
function bushGeo(seed) {
  let s = seed >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return crownBlob(rng, noise3(), 1.2, 0.72, 1, 0, 0.45, 0, [C.leafDark, C.turf2, C.turf, C.leafLit]);
}

/* ── leaf cards: fern, reeds, lily pad, lotus ──────────────────────────────── */
function stripGeo(strips) {
  // strips: [{pts:[[x,y,z,halfWidth,(r,g,b)]], side:[sx,sz]}]
  const pos = [], nor = [], col = [], idx = [];
  for (const st of strips) {
    const base = pos.length / 3;
    for (const p of st.pts) {
      pos.push(p[0] - st.side[0] * p[3], p[1], p[2] - st.side[1] * p[3], p[0] + st.side[0] * p[3], p[1], p[2] + st.side[1] * p[3]);
      nor.push(st.n[0], st.n[1], st.n[2], st.n[0], st.n[1], st.n[2]);
      col.push(p[4].r, p[4].g, p[4].b, p[4].r, p[4].g, p[4].b);
    }
    for (let k = 0; k < st.pts.length - 1; k++) {
      const o = base + k * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
function fernGeo() {
  let s = 5150;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const strips = [];
  const c0 = C.turf2.clone(), c1 = C.turf.clone(), c2 = C.leafLit.clone();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 6.283 + rng() * 0.5, L = 0.9 + rng() * 0.5, rise = 0.55 + rng() * 0.35;
    const dx = Math.cos(a), dz = Math.sin(a);
    const pts = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      pts.push([dx * L * t, rise * Math.sin(t * 2.3) + 0.03, dz * L * t, 0.17 * (1 - t * 0.9) * (0.5 + Math.sin(t * 3.14)),
        k === 0 ? c0 : k < 3 ? c1 : c2]);
    }
    strips.push({ pts, side: [-dz, dx], n: [dx * 0.35, 0.93, dz * 0.35] });
  }
  return stripGeo(strips);
}
function reedGeo() {
  let s = 8086;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const strips = [];
  for (let i = 0; i < 7; i++) {
    const a = rng() * 6.283, d = rng() * 0.38, h = 1.3 + rng() * 1.2, bend = (rng() - 0.3) * 0.5;
    const x = Math.cos(a) * d, z = Math.sin(a) * d, dx = Math.cos(a), dz = Math.sin(a);
    const tall = i < 2;                              // two stalks carry a cattail
    const pts = [[x, -0.5, z, 0.045, C.reedBase], [x + dx * bend * 0.3, h * 0.55, z + dz * bend * 0.3, 0.04, C.reed],
                 [x + dx * bend, h, z + dz * bend, 0.012, C.padDry]];
    if (tall) {
      pts[2] = [x + dx * bend * 0.6, h * 0.82, z + dz * bend * 0.6, 0.03, C.reed];
      pts.push([x + dx * bend * 0.62, h * 0.84, z + dz * bend * 0.62, 0.075, C.cattail],
               [x + dx * bend * 0.72, h * 1.02, z + dz * bend * 0.72, 0.07, C.cattail],
               [x + dx * bend * 0.75, h * 1.1, z + dz * bend * 0.75, 0.01, C.cattail]);
    }
    const sa = a + 1.2 + rng();
    strips.push({ pts, side: [Math.cos(sa), Math.sin(sa)], n: [dx * 0.5, 0.8, dz * 0.5] });
  }
  return stripGeo(strips);
}
function padGeo() {
  // a round leaf with the lily's V-notch, rim lifted a hair
  const pos = [0, 0.012, 0], col = [C.padDry.r, C.padDry.g, C.padDry.b], nor = [0, 1, 0], idx = [];
  const N = 11;
  for (let i = 0; i <= N; i++) {
    const a = 0.22 + (i / N) * (6.283 - 0.44);
    const r = 1 + 0.05 * Math.sin(a * 5);
    pos.push(Math.cos(a) * r, 0.03 * Math.sin(a * 3) + 0.01, Math.sin(a) * r);
    const c = i % 2 ? C.pad : C.padRim;
    col.push(c.r, c.g, c.b);
    nor.push(Math.cos(a) * 0.12, 0.99, Math.sin(a) * 0.12);
    if (i < N) idx.push(0, i + 2, i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
function lotusGeo() {
  const strips = [];
  for (let ring = 0; ring < 2; ring++) {
    const n = ring ? 5 : 7, open = ring ? 0.35 : 0.8, L = ring ? 0.3 : 0.42;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + ring * 0.4, dx = Math.cos(a), dz = Math.sin(a);
      strips.push({ pts: [[dx * 0.04, 0.05, dz * 0.04, 0.05, C.lotus], [dx * L * open * 0.6, 0.05 + L * 0.5, dz * L * open * 0.6, 0.12, C.lotus],
                          [dx * L * open, 0.05 + L, dz * L * open, 0.01, C.lotusTip]], side: [-dz, dx], n: [dx * 0.5, 0.85, dz * 0.5] });
    }
  }
  return stripGeo(strips);
}

/* ── shared instanced kit (built once) ─────────────────────────────────────── */
let _kit = null;
function kit() {
  if (_kit) return _kit;
  const fol = foliageMaterial(), card = cardMaterial();
  _kit = {
    treeNear0: { geo: canopyTreeGeo(11, true), mat: fol, cast: true },
    treeNear1: { geo: canopyTreeGeo(29, true), mat: fol, cast: true },
    treeNear2: { geo: canopyTreeGeo(47, true), mat: fol, cast: true },
    treeFar0: { geo: canopyTreeGeo(63, false), mat: fol, cast: true },
    treeFar1: { geo: canopyTreeGeo(85, false), mat: fol, cast: true },
    mangrove0: { geo: mangroveGeo(7), mat: fol, cast: true },
    mangrove1: { geo: mangroveGeo(19), mat: fol, cast: true },
    bush: { geo: bushGeo(3), mat: fol, cast: false },
    fern: { geo: fernGeo(), mat: card, cast: false },
    reed: { geo: reedGeo(), mat: card, cast: false },
    pad: { geo: padGeo(), mat: card, cast: false },
    lotus: { geo: lotusGeo(), mat: card, cast: false },
  };
  return _kit;
}

/* collects instances, then emits one InstancedMesh per (kind, cell) */
function makeBatch() {
  const lists = new Map();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  return {
    add(kind, cell, x, y, z, s, ry, tint = null, sy = 1, rx = 0, rz = 0) {
      const key = kind + '|' + cell;
      let l = lists.get(key);
      if (!l) lists.set(key, l = { kind, m: [], c: [] });
      q.setFromEuler(e.set(rx, ry, rz, 'YXZ'));
      m4.compose(p.set(x, y, z), q, sc.set(s, s * sy, s));
      l.m.push(...m4.elements);
      if (tint) l.c.push(tint[0], tint[1], tint[2]); else l.c.push(1, 1, 1);
    },
    build(group) {
      const K = kit();
      for (const l of lists.values()) {
        const k = K[l.kind], n = l.m.length / 16;
        const im = new THREE.InstancedMesh(k.geo, k.mat, n);
        im.instanceMatrix.array.set(l.m);
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(l.c), 3);
        im.castShadow = k.cast;
        im.receiveShadow = true;
        im.name = 'jungle:' + l.kind;
        im.computeBoundingSphere?.();
        group.add(im);
      }
    },
    /* small sets (a mooring, one island): bake the instances into ONE mesh
       per material instead — two draw calls, whatever the mix of plants */
    buildMerged(group) {
      const K = kit();
      const byMat = new Map();
      const c = new THREE.Color();
      for (const l of lists.values()) {
        const k = K[l.kind], n = l.m.length / 16;
        let slot = byMat.get(k.mat);
        if (!slot) byMat.set(k.mat, slot = { geos: [], cast: false });
        slot.cast = slot.cast || k.cast;
        for (let i = 0; i < n; i++) {
          const geo = k.geo.clone();
          geo.applyMatrix4(m4.fromArray(l.m, i * 16));
          const col = geo.attributes.color;
          c.setRGB(l.c[i * 3], l.c[i * 3 + 1], l.c[i * 3 + 2]);
          for (let v = 0; v < col.count; v++) col.setXYZ(v, col.getX(v) * c.r, col.getY(v) * c.g, col.getZ(v) * c.b);
          slot.geos.push(geo);
        }
      }
      for (const [mat, slot] of byMat) {
        const mesh = new THREE.Mesh(mergeGeos(slot.geos), mat);
        mesh.castShadow = slot.cast;
        mesh.receiveShadow = true;
        mesh.name = 'jungle:set';
        group.add(mesh);
      }
    },
  };
}

const greenTint = (rng) => { const v = 0.84 + rng() * 0.3; return [v * (0.92 + rng() * 0.2), v, v * (0.82 + rng() * 0.22)]; };

/* ── a mud bank / shoal: low mound, wet margin, underwater apron ───────────── */
const RINGS = [0, 0.22, 0.42, 0.6, 0.76, 0.88, 0.96, 1.03, 1.14, 1.3, 1.62];
function bankGeo(rng, noise, { R, H, ex = 1, ez = 1, ry = 0, x = 0, z = 0, segs = 18 }) {
  const ox = rng() * 60, oz = rng() * 60;
  const co = Math.cos(ry), si = Math.sin(ry);
  const edge = (a) => 0.72 + 0.56 * noise.fbm(Math.cos(a) * 1.4 + ox, 3.3, Math.sin(a) * 1.4 + oz);
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let j = 0; j < RINGS.length; j++) {
    const u = RINGS[j];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * 6.283;
      const r = R * edge(a) * u;
      const lx = Math.cos(a) * r * ex, lz = Math.sin(a) * r * ez;
      const wx = x + lx * co - lz * si, wz = z + lx * si + lz * co;
      const n = noise.fbm(wx * 0.21 + 5, 1.7, wz * 0.21 - 9);
      let y;
      if (u <= 0.96) y = SEA_Y + 0.22 + H * (1 - smooth(0.15, 0.97, u)) * (0.7 + 0.6 * n);
      else if (u < 1.1) y = SEA_Y - 0.12;
      else if (u < 1.2) y = SEA_Y - 0.55;
      else if (u < 1.4) y = SEA_Y - 1.7;
      else y = SEA_Y - 7.5;
      pos.push(wx, y, wz);
      const hk = smooth(SEA_Y + 0.2, SEA_Y + 0.9, y);
      c.copy(C.mudWet).lerp(C.mud, smooth(SEA_Y - 0.3, SEA_Y + 0.3, y));
      c.lerp(C.litter, hk * 0.8);
      c.lerp(n > 0.5 ? C.turf : C.turf2, smooth(SEA_Y + 0.5, SEA_Y + 1.2, y) * (0.55 + 0.45 * n));
      c.multiplyScalar(0.88 + 0.24 * noise(wx * 0.6, 4.1, wz * 0.6));
      col.push(c.r, c.g, c.b);
      if (j === 0) break;                          // the centre is a single vertex
    }
  }
  const at = (j, i) => (j === 0 ? 0 : 1 + (j - 1) * segs + ((i + segs) % segs));
  for (let i = 0; i < segs; i++) idx.push(0, at(1, i + 1), at(1, i));
  for (let j = 1; j < RINGS.length - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = at(j, i), b = at(j, i + 1), d = at(j + 1, i), e = at(j + 1, i + 1);
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // height query for seating things on the bank (local polar, same maths)
  const heightAt = (wx, wz) => {
    const dx = wx - x, dz = wz - z;
    const lx = (dx * co + dz * si) / ex, lz = (-dx * si + dz * co) / ez;
    const a = Math.atan2(lz, lx), u = Math.hypot(lx, lz) / (R * edge(a));
    if (u > 0.96) return SEA_Y - 0.12;
    const n = noise.fbm(wx * 0.21 + 5, 1.7, wz * 0.21 - 9);
    return SEA_Y + 0.22 + H * (1 - smooth(0.15, 0.97, u)) * (0.7 + 0.6 * n);
  };
  const at2 = (a, u) => {                           // world point at local angle / normalized radius
    const r = R * edge(a) * u;
    const lx = Math.cos(a) * r * ex, lz = Math.sin(a) * r * ez;
    return { x: x + lx * co - lz * si, z: z + lx * si + lz * co };
  };
  return { geo, heightAt, at: at2 };
}
function bankMesh(geos) {
  const geo = mergeGeos(geos);
  const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / GROUND_TILE; uv[i * 2 + 1] = p.getZ(i) / GROUND_TILE; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mesh = new THREE.Mesh(geo, bankMaterial());
  mesh.receiveShadow = true;
  mesh.layers.enable(SHORE_LAYER);
  mesh.name = 'jungle:banks';
  return mesh;
}
/* an underwater shoal only the shore map sees: a low cone, so the water over
   it lies calm and silty for the lilies and fades off with no hard edge */
function shoalGeo(x, z, r) {
  const N = 12, pos = [x, SEA_Y - 0.55, z], idx = [];
  for (const [k, y] of [[1, SEA_Y - 0.85], [1.7, SEA_Y - 2.4], [2.5, SEA_Y - 8]]) {
    for (let i = 0; i < N; i++) { const a = (i / N) * 6.283; pos.push(x + Math.cos(a) * r * k, y, z + Math.sin(a) * r * k); }
  }
  for (let i = 0; i < N; i++) idx.push(0, 1 + (i + 1) % N, 1 + i);
  for (let j = 0; j < 2; j++) for (let i = 0; i < N; i++) {
    const p = 1 + j * N + i, q = 1 + j * N + (i + 1) % N;
    idx.push(p, q, p + N, q, q + N, p + N);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length).fill(0.2), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mossBoulder(rng, noise, r) {
  const ox = rng() * 30, oz = rng() * 30, sy = 0.62 + rng() * 0.3;
  const geo = radialGeo(1, (d, out) => {
    const k = r * (0.76 + 0.5 * noise.fbm(d.x * 1.3 + ox, d.y * 1.3, d.z * 1.3 + oz));
    out.set(d.x * k, Math.max(-0.5 * r, d.y * k * sy), d.z * k);
  });
  return paint(geo, (q, n, c) => {
    c.copy(C.stoneDark).lerp(C.stone, noise(q.x * 1.5 + ox, q.y * 1.5, q.z * 1.5));
    c.lerp(C.moss, smooth(0.25, 0.7, n.y + (noise(q.x * 2.1, q.y, q.z * 2.1 + oz) - 0.5) * 0.5) * 0.85);
  });
}

/* a raft of lily pads (and the odd lotus) into the batch */
function lilyRaft(batch, cell, rng, x, z, rad, count) {
  const y = SEA_Y + 0.075;
  for (let i = 0; i < count; i++) {
    const a = rng() * 6.283, d = rad * Math.sqrt(rng());
    const s = 0.34 + rng() * 0.5;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    const v = 0.85 + rng() * 0.3;
    batch.add('pad', cell, px, y + rng() * 0.02, pz, s, rng() * 6.283, [v, v, v * 0.9]);
    if (rng() < 0.13) batch.add('lotus', cell, px + (rng() - 0.5) * s, y + 0.01, pz + (rng() - 0.5) * s, 0.7 + rng() * 0.5, rng() * 6.283);
  }
}

/* the planting of one bank: its canopy mass (into massGeos), a few individual
   trees breaking the edge, shrubs at the margin, then the wet fringe */
function plantBank(batch, cell, rng, bank, o, massGeos, { crowns, near }) {
  const scale = o.treeScale || 1;
  const spots = [];
  let tries = 0;
  while (spots.length < crowns && tries++ < crowns * 10) {
    const p = bank.at(rng() * 6.283, 0.05 + Math.sqrt(rng()) * 0.6);
    const r = (2.7 + rng() * 1.5) * scale;
    if (spots.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < (q.r + r) * 0.52)) continue;
    const g0 = bank.heightAt(p.x, p.z);
    spots.push({ x: p.x, z: p.z, g: g0, r, y: g0 + (3.6 + rng() * 2.6) * scale });
  }
  canopyMassGeos(rng, noise3(), spots, massGeos);
  const edge = o.edgeTrees ?? (near ? 1 + (rng() < 0.3 ? 1 : 0) : 0);
  for (let i = 0; i < edge; i++) {
    const p = bank.at(rng() * 6.283, 0.66 + rng() * 0.2);
    const kind = near && !o.lod ? 'treeNear' + Math.floor(rng() * 3) : 'treeFar' + Math.floor(rng() * 2);
    batch.add(kind, cell, p.x, bank.heightAt(p.x, p.z) - 0.1, p.z, (0.8 + rng() * 0.45) * scale, rng() * 6.283, greenTint(rng), 0.92 + rng() * 0.25);
  }
  const nb = o.sparse ? 2 : near ? 2 + Math.floor(rng() * 2) : 2;
  for (let i = 0; i < nb; i++) {
    const p = bank.at(rng() * 6.283, 0.7 + rng() * 0.22);
    batch.add('bush', cell, p.x, bank.heightAt(p.x, p.z), p.z, (1.0 + rng() * 0.9) * scale, rng() * 6.283, greenTint(rng), 0.8 + rng() * 0.4);
  }
  if (!near) return;
  const nf = o.sparse ? 2 : 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nf; i++) {
    const p = bank.at(rng() * 6.283, 0.62 + rng() * 0.3);
    batch.add('fern', cell, p.x, bank.heightAt(p.x, p.z), p.z, 0.9 + rng() * 0.8, rng() * 6.283, greenTint(rng));
  }
  const nm = o.sparse ? 1 : 1 + (rng() < 0.3 ? 1 : 0);
  for (let i = 0; i < nm; i++) {
    const p = bank.at(rng() * 6.283, 0.93 + rng() * 0.12);
    batch.add('mangrove' + Math.floor(rng() * 2), cell, p.x, SEA_Y, p.z, 0.8 + rng() * 0.5, rng() * 6.283, greenTint(rng));
  }
  const nr = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nr; i++) {
    const p = bank.at(rng() * 6.283, 0.97 + rng() * 0.12);
    batch.add('reed', cell, p.x, SEA_Y + 0.05, p.z, 0.8 + rng() * 0.6, rng() * 6.283, greenTint(rng));
  }
  if (rng() < 0.7) {
    const p = bank.at(rng() * 6.283, 1.14 + rng() * 0.12);
    lilyRaft(batch, cell, rng, p.x, p.z, 1.6 + rng() * 1.4, 5 + Math.floor(rng() * 8));
  }
}
function massMesh(geos) {
  const mesh = new THREE.Mesh(mergeGeos(geos), foliageMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'jungle:canopy';
  return mesh;
}

/* ── the wilds of the Deep ─────────────────────────────────────────────────── */
export function buildJungleField(theme, nodes, segs, rng) {
  const g = new THREE.Group();
  g.name = 'junglefield';
  const tools = laneTools(nodes, segs);
  const noise = noise3();
  const batch = makeBatch();
  const cellOf = (x, z) => (x < tools.cx ? 0 : 1) + (z < tools.cz ? 0 : 2);
  const bankGeos = [[], [], [], []];
  const massGeos = [[], [], [], []];
  const banks = [];                                  // {x, z, r}
  const fits = (x, z, r, lane) => {
    if (tools.segDist(x, z) < lane) return false;
    if (tools.nodeGap(x, z) < r * 0.75) return false;
    for (const b of banks) if (Math.hypot(b.x - x, b.z - z) < (b.r + r) * 0.66) return false;
    return true;
  };
  const addBank = (x, z, R, ry, near) => {
    const ex = 1.25 + rng() * 0.45, ez = 0.78 + rng() * 0.2;
    const bank = bankGeo(rng, noise, { R, H: 0.8 + rng() * 0.9, ex, ez, ry, x, z });
    const cell = cellOf(x, z);
    bankGeos[cell].push(bank.geo);
    banks.push({ x, z, r: R });
    plantBank(batch, cell, rng, bank, { treeScale: near ? 1 : 1.35 }, massGeos[cell],
      { crowns: near ? Math.max(4, Math.min(8, Math.round(R * R * ex * ez / 20))) : 8, near });
  };

  /* the channel walls: banks marched down both sides of every lane */
  for (const s of segs) {
    const dx = s[2] - s[0], dz = s[3] - s[1];
    const len = Math.hypot(dx, dz);
    if (len < 6) continue;
    const ux = dx / len, uz = dz / len, ry = Math.atan2(uz, ux);
    for (let d = rng() * 9; d < len && banks.length < 38; d += 15 + rng() * 6) {
      for (const side of [-1, 1]) {
        if (rng() < 0.2) continue;
        const R = 7 + rng() * 4.5;
        const off = R * 0.85 + 12.5 + rng() * 7;
        const x = s[0] + ux * d - uz * side * off, z = s[1] + uz * d + ux * side * off;
        if (!fits(x, z, R, R * 0.8 + 10.5)) continue;
        addBank(x, z, R, ry + (rng() - 0.5) * 0.5, true);
      }
    }
  }
  /* the forest behind: bigger wooded islands that fill the middle distance */
  {
    const M = 80;
    let placed = 0, tries = 0;
    while (placed < 13 && tries++ < 500) {
      const x = tools.minX - M + rng() * (tools.maxX - tools.minX + 2 * M);
      const z = tools.minZ - M + rng() * (tools.maxZ - tools.minZ + 2 * M);
      const sd = tools.segDist(x, z);
      const R = 11 + rng() * 6;
      if (sd < 40 || sd > 130 || !fits(x, z, R, 40)) continue;
      addBank(x, z, R, rng() * 6.283, false);
      placed++;
    }
  }

  /* lily shoals in the slack water just off the lanes */
  const shoals = [[], [], [], []];
  {
    let placed = 0, tries = 0;
    const M = 20;
    while (placed < 16 && tries++ < 600) {
      const x = tools.minX - M + rng() * (tools.maxX - tools.minX + 2 * M);
      const z = tools.minZ - M + rng() * (tools.maxZ - tools.minZ + 2 * M);
      const sd = tools.segDist(x, z);
      if (sd < 6.5 || sd > 13 || tools.nodeGap(x, z) < 2) continue;
      if (banks.some((b) => Math.hypot(b.x - x, b.z - z) < b.r * 1.5)) continue;
      const cell = cellOf(x, z), rad = 2.2 + rng() * 2.2;
      shoals[cell].push(shoalGeo(x, z, rad + 1.2));
      lilyRaft(batch, cell, rng, x, z, rad, 9 + Math.floor(rng() * 12));
      if (rng() < 0.55) batch.add('reed', cell, x + (rng() - 0.5) * rad, SEA_Y + 0.05, z + (rng() - 0.5) * rad, 0.8 + rng() * 0.5, rng() * 6.283, greenTint(rng));
      placed++;
    }
  }

  /* ruins going under: an arch, a toppled colossus, drowned columns — each on
     its own mud shoal beside the lane where the captain sails right past */
  const RUINS = [['ruined_arch', 2.3, 0.75], ['broken_statue', 2.4, 0.5], ['ruined_arch', 1.9, 0.9], ['ruined_column', 2.6, 0.6], ['mossy_idol', 2.2, 0.35]];
  {
    let placed = 0, tries = 0;
    const M = 10;
    while (placed < RUINS.length && tries++ < 700) {
      const x = tools.minX - M + rng() * (tools.maxX - tools.minX + 2 * M);
      const z = tools.minZ - M + rng() * (tools.maxZ - tools.minZ + 2 * M);
      const sd = tools.segDist(x, z);
      if (sd < 10.5 || sd > 17 || tools.nodeGap(x, z) < 6) continue;
      if (banks.some((b) => Math.hypot(b.x - x, b.z - z) < b.r * 1.2 + 4)) continue;
      const [id, scale, sink] = RUINS[placed];
      const cell = cellOf(x, z);
      const bank = bankGeo(rng, noise, { R: 4.2 + rng() * 1.4, H: 0.35, x, z, segs: 14, ry: rng() * 6.283 });
      bankGeos[cell].push(bank.geo);
      banks.push({ x, z, r: 5 });
      const ruin = propGroup(id, scale);
      ruin.position.set(x, SEA_Y - sink, z);
      ruin.rotation.set((rng() - 0.5) * 0.24, rng() * 6.283, (rng() - 0.5) * 0.3);
      g.add(ruin);
      for (let i = 0; i < 4; i++) {
        const p = bank.at(rng() * 6.283, 0.8 + rng() * 0.3);
        batch.add(i < 3 ? 'reed' : 'fern', cell, p.x, i < 3 ? SEA_Y + 0.05 : bank.heightAt(p.x, p.z), p.z, 0.8 + rng() * 0.6, rng() * 6.283, greenTint(rng));
      }
      if (placed % 2 === 0) {
        const p = bank.at(rng() * 6.283, 0.9);
        batch.add('mangrove' + (placed % 4 ? 1 : 0), cell, p.x, SEA_Y, p.z, 0.9, rng() * 6.283, greenTint(rng));
      }
      const lp = bank.at(rng() * 6.283, 1.2);
      lilyRaft(batch, cell, rng, lp.x, lp.z, 2, 8);
      placed++;
    }
  }

  for (let c = 0; c < 4; c++) {
    const geos = bankGeos[c].concat(shoals[c]);
    if (geos.length) g.add(bankMesh(geos));
    if (massGeos[c].length) g.add(massMesh(massGeos[c]));
  }
  batch.build(g);
  return g;
}

/* ── a water stop: lilies in slack water, sometimes an islet or mossy rocks ── */
export function jungleMooring(node, rng) {
  const g = new THREE.Group();
  const noise = noise3();
  const batch = makeBatch();
  const geos = [];
  const a0 = rng() * 6.283;
  // two lily rafts lying off the berth (never on it — the ship moors in the middle)
  for (let i = 0; i < 2; i++) {
    const a = a0 + i * (2 + rng() * 2), d = 5.5 + rng() * 3.5, rad = 1.7 + rng() * 1.5;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    geos.push(shoalGeo(x, z, rad + 1.2));
    lilyRaft(batch, 0, rng, x, z, rad, 7 + Math.floor(rng() * 9));
    if (rng() < 0.6) batch.add('reed', 0, x + (rng() - 0.5) * rad, SEA_Y + 0.05, z + (rng() - 0.5) * rad, 0.8 + rng() * 0.5, rng() * 6.283, greenTint(rng));
  }
  if (node.look === 'islet') {
    const a = a0 + 1.1, d = 8.5 + rng() * 2;
    const bank = bankGeo(rng, noise, { R: 4.4 + rng() * 1.6, H: 0.9, x: Math.cos(a) * d, z: Math.sin(a) * d, segs: 16, ry: rng() * 6.283, ex: 1.25 });
    geos.push(bank.geo);
    const mass = [];
    plantBank(batch, 0, rng, bank, { treeScale: 0.7, edgeTrees: 0, sparse: true }, mass, { crowns: 3, near: true });
    g.add(massMesh(mass));
  } else if (node.look === 'rocks') {
    const rocks = [];
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const a = a0 + 0.9 + i * 0.5 + rng() * 0.3, d = 6.5 + rng() * 2.5, r = 0.9 + rng() * 1.0;
      rocks.push(xform(mossBoulder(rng, noise, r), { x: Math.cos(a) * d, y: SEA_Y + r * 0.1, z: Math.sin(a) * d, ry: rng() * 6.283 }));
      geos.push(shoalGeo(Math.cos(a) * d, Math.sin(a) * d, r + 1.6));
    }
    const m = new THREE.Mesh(mergeGeos(rocks), stoneMaterial());
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    batch.add('fern', 0, Math.cos(a0 + 1.1) * 7, SEA_Y + 0.5, Math.sin(a0 + 1.1) * 7, 0.9, rng() * 6.283, greenTint(rng));
  }
  if (geos.length) g.add(bankMesh(geos));
  batch.buildMerged(g);
  return g;
}

/* a single drifting raft of pads, for anything else that wants one */
export function makeLilyRaft(rng, s = 1) {
  const g = new THREE.Group();
  const batch = makeBatch();
  lilyRaft(batch, 0, rng, 0, 0, 1.6 * s, Math.round(8 + 6 * s));
  batch.buildMerged(g);
  return g;
}

/* ── island dressing: a horseshoe of forest round the building, wet margins ── */
export function dressJungleIsland(g, rng, theme, R, terrain, node) {
  const batch = makeBatch();
  const type = node?.type;
  // forest rings the back and flanks as one canopy; one side stays open so
  // the landmark shows, and a couple of free-standing trees break the edge
  const open = rng() * 6.283;
  const n = 6 + Math.floor(rng() * 3);
  const spots = [];
  for (let i = 0; i < n; i++) {
    const a = open + 0.95 + (i / (n - 1)) * (6.283 - 1.9) + (rng() - 0.5) * 0.25;
    const p = terrain.place(a, 0.6 + rng() * 0.2);
    if (p.y < 0.2) continue;
    spots.push({ x: p.x, z: p.z, g: p.y, r: 2.1 + rng() * 1.1, y: p.y + 3.0 + rng() * 2.2 });
    if (rng() < 0.6) {
      const q = terrain.place(a + (rng() - 0.5) * 0.4, 0.74 + rng() * 0.16);
      if (q.y > 0.15) batch.add('bush', 0, q.x, q.y, q.z, 0.7 + rng() * 0.6, rng() * 6.283, greenTint(rng));
    }
  }
  if (spots.length) {
    const mass = [];
    canopyMassGeos(rng, noise3(), spots, mass);
    g.add(massMesh(mass));
  }
  for (let i = 0; i < 2; i++) {
    const p = terrain.place(open + (i ? 1.0 : -1.0) + (rng() - 0.5) * 0.3, 0.62 + rng() * 0.12);
    if (p.y < 0.2) continue;
    batch.add('treeNear' + Math.floor(rng() * 3), 0, p.x, p.y - 0.15, p.z, 0.6 + rng() * 0.2, rng() * 6.283, greenTint(rng), 0.9 + rng() * 0.2);
  }
  for (let i = 0; i < 7; i++) {
    const p = terrain.place(rng() * 6.283, 0.4 + rng() * 0.5);
    if (p.y > 0.2) batch.add('fern', 0, p.x, p.y, p.z, 0.7 + rng() * 0.7, rng() * 6.283, greenTint(rng));
  }
  // the wet margin: mangroves wading off the beach, reeds, a lily raft
  const nm = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nm; i++) {
    const p = terrain.place(open + 1.2 + rng() * 3.9, 1.0 + rng() * 0.08);
    batch.add('mangrove' + Math.floor(rng() * 2), 0, p.x, SEA_Y, p.z, 0.75 + rng() * 0.4, rng() * 6.283, greenTint(rng));
  }
  for (let i = 0; i < 6; i++) {
    const p = terrain.place(rng() * 6.283, 1.0 + rng() * 0.1);
    batch.add('reed', 0, p.x, SEA_Y + 0.05, p.z, 0.8 + rng() * 0.6, rng() * 6.283, greenTint(rng));
  }
  for (let i = 0; i < 2; i++) {
    const p = terrain.place(rng() * 6.283, 1.18 + rng() * 0.12);
    lilyRaft(batch, 0, rng, p.x, p.z, 1.6 + rng() * 1.2, 6 + Math.floor(rng() * 8));
  }
  batch.buildMerged(g);

  // hand-sculpted heroes, spent where the eye lands
  const hero = (id, s, a, rr, sink = 0.06) => {
    const p = terrain.place(a, rr);
    if (p.y < 0.15) return;
    const pr = propGroup(id, s);
    pr.position.set(p.x, p.y - sink, p.z);
    pr.rotation.y = rng() * 6.283;
    g.add(pr);
  };
  if (type === 'lair') hero('jungle_tree', 1.8 + rng() * 0.3, open + 3.14, 0.52);
  if (type === 'haven') { hero('palm_tree', 1.2, open + 0.7, 0.5); hero('palm_tree', 1.4, open - 0.75, 0.55); }
  if (type === 'monster') hero(['mossy_idol', 'mushroom_cluster', 'ruined_arch', 'broken_statue', 'ruined_column'][Math.floor(rng() * 5)], 0.9 + rng() * 0.3, open + (rng() - 0.5) * 0.9, 0.42);
  if (type === 'shrine' || type === 'puzzle' || type === 'shop') hero(rng() < 0.5 ? 'mushroom_cluster' : 'mossy_idol', 0.8, open + 0.6, 0.5);
}

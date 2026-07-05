/*
 * islands.js — terrain, flora, buildings, ships, particles, battle backdrops
 * (owner: Agent A). Everything here is deterministic per node id and themed
 * via the THEME objects from themes.js.
 */
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { hashStr, mulberry32, flat, displace, seedFrom, softDiscTexture } from './util.js';
import { DOMAIN_COLORS, REALM_INFO } from './themes.js';
import { propGroup } from './props.js';

/* ── stylized "painted" ground overlay ──────────────────────────────────────
 * Terrain keeps its solid height-based vertex colours (the real biome colour);
 * we just multiply in ONE neutral, procedurally-painted mottle so the flat
 * facets read as hand-painted gouache instead of dead-flat. No image files,
 * no per-biome art — the island colour is "painted on" purely via the palette,
 * and islands generate cleanly. Tweak the greys below to taste. */
const GROUND_TILE = 9;   // world units per texture repeat

/* draw a wrap-safe blotch field onto a canvas context */
function blotch(ctx, S, rng, n, rMin, rMax, ink) {
  for (let i = 0; i < n; i++) {
    const x = rng() * S, y = rng() * S, r = rMin + rng() * (rMax - rMin);
    ctx.fillStyle = ink(rng);
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, 6.2832); ctx.fill();
    }
  }
}

let _paintedTex = null;
export function paintedGroundTexture() {
  if (_paintedTex) return _paintedTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);                       // base = no tint (solid colour)
  const rng = mulberry32(24239);                  // deterministic detail layers
  // broad soft patches → meadows read as ground, not paint
  blotch(ctx, S, rng, 70, 22, 52, (r) => {
    const v = 200 + ((r() * 50) | 0);
    return `rgba(${v},${v},${v},${0.06 + r() * 0.07})`;
  });
  // mid clumps
  blotch(ctx, S, rng, 240, 6, 18, (r) => {
    const v = 192 + ((r() * 63) | 0);
    return `rgba(${v},${v},${v},${0.06 + r() * 0.08})`;
  });
  // fine stipple — the tooth that reads at deck height
  blotch(ctx, S, rng, 2400, 0.6, 1.8, (r) => {
    const dark = r() < 0.6;
    const v = dark ? 168 + ((r() * 50) | 0) : 255;
    return `rgba(${v},${v},${v},${0.05 + r() * 0.07})`;
  });
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _paintedTex = t;
  return t;
}

/* matching greyscale relief — bump-mapped so grass, sand and rock catch the
   sun with actual surface tooth instead of reading as smooth plastic */
let _bumpTex = null;
export function groundBumpTexture() {
  if (_bumpTex) return _bumpTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, S, S);
  const rng = mulberry32(77121);
  blotch(ctx, S, rng, 120, 10, 34, (r) => {
    const v = 96 + ((r() * 128) | 0);
    return `rgba(${v},${v},${v},${0.10 + r() * 0.10})`;
  });
  blotch(ctx, S, rng, 2600, 0.6, 2.2, (r) => {
    const v = r() < 0.5 ? 40 + ((r() * 60) | 0) : 190 + ((r() * 65) | 0);
    return `rgba(${v},${v},${v},${0.16 + r() * 0.16})`;
  });
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  _bumpTex = t;
  return t;
}

/* ── Meshy landmark GLBs (static/assets/structures) ─────────────────────────
   The AI-generated set ships centred at arbitrary unit scale; mount() grounds
   the feet on y=0 and normalizes to a WORLD height (or length). Templates are
   cached; instances are cheap clones that share geometry and textures. */
const _structLoader = new GLTFLoader();
const _structTpls = new Map();     // id → Promise<Scene|null>

function structTemplate(id) {
  let p = _structTpls.get(id);
  if (p) return p;
  p = _structLoader.loadAsync(`/static/assets/structures/${id}.glb`)
    .then((gltf) => {
      const s = gltf.scene;
      s.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          // matte the Meshy PBR down so landmarks sit in the faceted world
          if (o.material && 'roughness' in o.material) {
            o.material.roughness = Math.max(0.85, o.material.roughness);
          }
        }
      });
      s.userData.box = new THREE.Box3().setFromObject(s);
      return s;
    })
    .catch((err) => {
      console.warn(`structures: failed to load '${id}'`, err);
      return null;
    });
  _structTpls.set(id, p);
  return p;
}

/* Every landmark the map mounts — preloaded by the loading screen */
export function preloadStructures() {
  return ['pharos', 'temple', 'temple_ice', 'temple_desert', 'temple_jungle',
          'temple_autumn', 'market', 'dock', 'obelisk', 'tents', 'lighthouse',
          'sand_spire', 'ice_temple']
    .map((id) => structTemplate(id));
}

/* Returns a group NOW; the landmark pops in when its GLB lands. opts:
   h = target height, len = target length along x (one of the two), ry yaw. */
function glbProp(id, { h = null, len = null, ry = 0, onReady = null } = {}) {
  const g = new THREE.Group();
  structTemplate(id).then((tpl) => {
    if (!tpl) return;
    const box = tpl.userData.box;
    const k = h ? h / Math.max(0.05, box.max.y - box.min.y)
                : len / Math.max(0.05, box.max.x - box.min.x);
    const inst = tpl.clone(true);
    inst.scale.setScalar(k);
    inst.position.set(-(box.max.x + box.min.x) / 2 * k, -box.min.y * k,
                      -(box.max.z + box.min.z) / 2 * k);
    g.rotation.y = ry;
    g.add(inst);
    if (onReady) onReady(inst);
  });
  return g;
}

const COL = {
  sand: 0xf3e3b4, sandWet: 0xd9c489, grass: 0x5cb56e, grass2: 0x3f9e58,
  rock: 0x93999e, rockDark: 0x5c6166, basalt: 0x4a4a52,
  trunk: 0x8a5a33, frond: 0x2f9e44, frond2: 0x47b858, cypress: 0x1f6e3d,
  marble: 0xf7f4ec, marbleShade: 0xe4ddc9,
  aegeanBlue: 0x2d5bb9, terracotta: 0xc96f4a, gold: 0xd9a441,
  wood: 0x9a6b3f, woodDark: 0x74502f, bone: 0xe8e2d2,
};

/* ── terrain — REVAMPED procedural island engine ─────────────────────────
 * Real-island rules, no radial artifacts:
 *   · the COASTLINE is seeded 2D noise sampled around a circle — every isle
 *     an organic, asymmetric blob (never a star, never symmetric)
 *   · HEIGHT follows the mode profile, with noise RELIEF that fades in
 *     toward the rim — the heart of the island stays exactly on heightAt()
 *     so buildings and flora never float
 *   · COLOURS band by elevation like a real shore — wet sand, dry beach, a
 *     dithered blend into grass, noise-patched rock — with every band line
 *     wavered by world-space noise. NOTHING is a function of angle: no
 *     pinwheels, no bullseyes, no swirl.
 */
function makeNoise2D(seed) {
  const rng = mulberry32(seed);
  const perm = new Uint8Array(512);
  const srcp = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = srcp[i]; srcp[i] = srcp[j]; srcp[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = srcp[i & 255];
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

export function makeTerrain({ seed, R, H, mode = 'hill', palette = {}, lobes = 0, tex = null }) {
  const rng = mulberry32(seed);
  const noise = makeNoise2D((seed ^ 0x9e3779) >>> 0);
  const fbm = (x, z) => (noise(x, z) + 0.5 * noise(x * 2.13 + 37.7, z * 2.13 - 19.1)
                         + 0.25 * noise(x * 4.31 - 53.3, z * 4.31 + 11.9)) / 1.75;
  const SEG_A = 48, SEG_R = 13;
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
  // the coastline: noise around the unit circle — organic and closed
  const eoff = rng() * 90;
  const ephase = rng() * 6.28;
  const edge = (a) => (0.78 + 0.52 * rugged
                        * fbm(Math.cos(a) * 2.3 + eoff, Math.sin(a) * 2.3 + eoff))
                      * (1 + lobes * Math.sin(2 * a + ephase));
  const smooth = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  const profile = (rr) => {
    if (mode === 'mesa') return H * (1 - smooth(0.52, 0.88, rr));
    if (mode === 'peak') return H * Math.pow(Math.max(0, 1 - rr), 1.35);
    if (mode === 'flat') return H * (1 - smooth(0.7, 0.97, rr));
    if (mode === 'atoll') return H * (smooth(0.14, 0.4, rr) - smooth(0.55, 0.92, rr));
    return H * (1 - smooth(0.15, 0.95, rr)) * (0.75 + 0.25 * Math.cos(rr * 3));
  };

  const pos = [], col = [], idx = [], uvs = [];
  const RINGS = SEG_R + 3;
  const heightAt = (rr) => Math.max(0, profile(Math.min(rr, 1)));
  const _sand = new THREE.Color();

  for (let ri = 0; ri <= RINGS; ri++) {
    for (let ai = 0; ai < SEG_A; ai++) {
      const a = (ai / SEG_A) * Math.PI * 2;
      let rr;
      if (ri <= SEG_R) rr = ri / SEG_R;
      else rr = 1 + (ri - SEG_R) * 0.09;
      const wr = rr * R * edge(a);
      const px = Math.cos(a) * wr * ex, pz = Math.sin(a) * wr * ez;
      let y;
      if (ri <= SEG_R) {
        // relief fades IN toward the rim: the heart stays on heightAt()
        const relief = 1 + (fbm(px * 0.16 + 5.1, pz * 0.16 - 8.7) - 0.5)
                         * 0.8 * rugged * smooth(0.4, 0.95, rr);
        y = heightAt(rr) * relief;
        if (ri === SEG_R) y = 0.08;                     // the waterline lip
      } else {
        y = -(ri - SEG_R) * 1.15;                       // submerged flank
      }
      pos.push(px, y, pz);
      uvs.push(px / GROUND_TILE, pz / GROUND_TILE);

      const c = new THREE.Color();
      const hFrac = y / Math.max(H, 0.001);
      const n = fbm(px * 0.42 + 11.3, pz * 0.42 - 23.9); // slow world mottle
      const dither = (n - 0.5) * 0.24;                   // wavers every band line
      if (ri > SEG_R) {
        c.copy(ri === SEG_R + 1 ? P.sandWet : P.rock).multiplyScalar(0.75);
      } else {
        const beachTop = Math.min(0.34, H * 0.2)
          + dither * Math.min(1, H * 0.55);              // wandering shoreline
        if (rr > 0.94) c.copy(P.sandWet);
        else if (y < beachTop) c.copy(P.sand);
        else if (mode === 'mesa' && rr > 0.5 + dither * 0.5 && rr < 0.96) {
          c.copy(P.rock);   // the carved cliff walls
        } else if (mode === 'peak' && hFrac + dither > 0.53) {
          c.copy(P.rock).lerp(new THREE.Color(COL.rockDark),
            Math.min(1, Math.max(0, (hFrac - 0.53) * 1.6)));
        } else {
          // grassland: two tones in soft world-space patches, sun-dried in spots
          c.copy(P.grass).lerp(P.grass2, fbm(px * 0.5 - 31.7, pz * 0.5 + 47.3));
          c.lerp(P.sand, smooth(0.62, 0.92, n) * 0.16);
          // dithered beach→grass blend so the shore is never a hard ring
          const k = smooth(beachTop, beachTop + Math.min(0.32, H * 0.24), y);
          _sand.copy(P.sand);
          c.lerpColors(_sand, c, k);
        }
      }
      col.push(c.r, c.g, c.b);
    }
  }
  const capY = heightAt(0);
  pos.push(0, capY, 0);
  uvs.push(0, 0);
  const capC = mode === 'peak' ? new THREE.Color(COL.rockDark) : P.grass;
  col.push(capC.r, capC.g, capC.b);
  const capIdx = pos.length / 3 - 1;

  const vid = (ri, ai) => ri * SEG_A + (ai % SEG_A);
  for (let ai = 0; ai < SEG_A; ai++) idx.push(capIdx, vid(0, ai + 1), vid(0, ai));
  for (let ri = 0; ri < RINGS; ri++) {
    for (let ai = 0; ai < SEG_A; ai++) {
      const a0 = vid(ri, ai), a1 = vid(ri, ai + 1), b0 = vid(ri + 1, ai), b1 = vid(ri + 1, ai + 1);
      idx.push(a0, a1, b0, a1, b1, b0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.95,
    map: paintedGroundTexture(),        // neutral painted mottle × vertex colour
    bumpMap: groundBumpTexture(),       // …with real tooth under the sun
    bumpScale: 0.55,
  }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  // exact surface samplers so props sit ON the sculpted ground, not on the
  // smooth radial profile (which ignores the noise relief and the ex/ez /
  // coastline warp — the cause of floating / half-buried trees).
  const relief = (px, pz, rr) =>
    1 + (fbm(px * 0.16 + 5.1, pz * 0.16 - 8.7) - 0.5)
        * 0.8 * rugged * smooth(0.4, 0.95, Math.min(rr, 1));
  // world point for a compass direction + normalized radius (matches a vertex)
  const place = (a, rr) => {
    const wr = rr * R * edge(a);
    const x = Math.cos(a) * wr * ex, z = Math.sin(a) * wr * ez;
    return { x, y: Math.max(0, profile(Math.min(rr, 1))) * relief(x, z, rr), z };
  };
  // surface height beneath any local (x,z)
  const surfaceY = (x, z) => {
    const ax = x / ex, az = z / ez;
    const a = Math.atan2(az, ax);
    const rr = Math.min(1, Math.hypot(ax, az) / (R * edge(a) || 1));
    return Math.max(0, profile(rr)) * relief(x, z, rr);
  };
  return { mesh, heightAt, place, surfaceY, rng };
}

// a jetty seated on the real coastline at `angle`, sized to the island so it
// rests on the beach and reaches over the water — never clipping or floating
function placeDock(terrain, angle, len = 5.0) {
  const p = terrain.place(angle, 0.9);
  const dock = makeDock(len);
  dock.position.set(p.x, Math.max(0.12, p.y), p.z);
  dock.rotation.y = -angle - Math.PI / 2;    // planks run seaward along the radius
  return dock;
}

/* ── water-line dressings ───────────────────────────────────────────────── */
const _shallowTexCache = new Map();
function shallowDisc(radius, shallowHex = 0x60e0d5) {
  let tex = _shallowTexCache.get(shallowHex);
  if (!tex) {
    const cc = new THREE.Color(shallowHex);
    const r = Math.round(cc.r * 255), g = Math.round(cc.g * 255), b = Math.round(cc.b * 255);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const gr = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
    gr.addColorStop(0, `rgba(${r},${g},${b},0.62)`);
    gr.addColorStop(0.55, `rgba(${r},${g},${b},0.34)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 256, 256);
    tex = new THREE.CanvasTexture(c);
    _shallowTexCache.set(shallowHex, tex);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius, radius),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = -0.05;
  return m;
}

function foamRing(R) {
  const foam = new THREE.Mesh(
    new THREE.RingGeometry(R * 1.06, R * 1.3, 36),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3,
      side: THREE.DoubleSide, depthWrite: false }));
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = 0.03;
  foam.name = 'foam';
  return foam;
}

/* the desert-trek analogue of the foam ring: wind ripples in the sand */
function sandRippleRing(R, sandHex) {
  const g = new THREE.Group();
  const c = new THREE.Color(sandHex).lerp(new THREE.Color(0xffffff), 0.35);
  for (let i = 0; i < 3; i++) {
    const r0 = R * (1.05 + i * 0.16);
    const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r0 + R * 0.045, 40),
      new THREE.MeshBasicMaterial({ color: c, transparent: true,
        opacity: 0.22 - i * 0.05, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04 + i * 0.01;
    if (i === 0) ring.name = 'foam';
    g.add(ring);
  }
  return g;
}

/* ── flora: five realm sets ─────────────────────────────────────────────── */
function makePalm(rng, scale = 1, frondA = COL.frond, frondB = COL.frond2) {
  const g = new THREE.Group();
  const lean = (rng() - 0.5) * 0.5;
  let x = 0, y = 0;
  for (let i = 0; i < 4; i++) {
    const h = 0.62 * scale;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075 * scale * (1 - i * 0.14), 0.1 * scale * (1 - i * 0.14), h, 5),
      flat(COL.trunk));
    seg.position.set(x, y + h / 2, 0);
    seg.rotation.z = lean * (i + 0.5) * 0.3;
    seg.castShadow = true;
    g.add(seg);
    x += Math.sin(lean * (i + 1) * 0.3) * h;
    y += Math.cos(lean * (i + 1) * 0.3) * h;
  }
  const top = new THREE.Vector3(x, y + 0.05 * scale, 0);
  const nF = 7 + Math.floor(rng() * 3);
  for (let i = 0; i < nF; i++) {
    const fg = new THREE.PlaneGeometry(1.7 * scale, 0.42 * scale, 5, 1);
    const p = fg.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const fx = Math.max(0, p.getX(v) / (1.7 * scale) + 0.5);
      p.setY(v, p.getY(v) * (1 - fx * 0.55));
      p.setZ(v, -Math.pow(fx, 1.7) * 0.55 * scale);
    }
    fg.computeVertexNormals();
    const frond = new THREE.Mesh(fg, flat(i % 2 ? frondA : frondB, { side: THREE.DoubleSide }));
    frond.position.copy(top);
    frond.rotation.y = (i / nF) * Math.PI * 2 + rng() * 0.4;
    frond.translateX(0.7 * scale);
    frond.castShadow = true;
    g.add(frond);
  }
  return g;
}

function makeCypress(rng, scale = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.4 * scale, 5), flat(COL.trunk));
  trunk.position.y = 0.2 * scale;
  g.add(trunk);
  let y = 0.35 * scale;
  for (const [r, h] of [[0.42, 1.1], [0.3, 0.85], [0.16, 0.6]]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * scale, h * scale, 6), flat(COL.cypress));
    cone.position.y = y + (h * scale) / 2;
    cone.castShadow = true;
    g.add(cone);
    y += h * scale * 0.55;
  }
  g.rotation.y = rng() * 6.28;
  return g;
}

function makeOlive(rng, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.14 * s, 0.9 * s, 5), flat(0x7a6248));
  trunk.position.y = 0.45 * s;
  trunk.rotation.z = (rng() - 0.5) * 0.35;
  g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const puff = new THREE.Mesh(
      displace(new THREE.IcosahedronGeometry((0.32 + rng() * 0.16) * s, 0), 0.06 * s, seedFrom(rng)),
      flat(0x8fa05a));
    puff.position.set((rng() - 0.5) * 0.55 * s, (0.95 + rng() * 0.35) * s, (rng() - 0.5) * 0.55 * s);
    puff.castShadow = true;
    g.add(puff);
  }
  return g;
}

/* snowy conifer — tiers of deep blue-green with white snow shoulders */
function makePine(rng, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.11 * s, 0.7 * s, 5), flat(0x4a3a2c));
  trunk.position.y = 0.35 * s;
  g.add(trunk);
  const tiers = 3 + (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < tiers; i++) {
    const r = (0.58 - i * 0.12) * s, h = 0.62 * s;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), flat(0x2e5a48));
    cone.position.y = (0.72 + i * 0.4) * s;
    cone.castShadow = true;
    g.add(cone);
    const snow = new THREE.Mesh(new THREE.ConeGeometry(r * 0.82, h * 0.42, 7), flat(0xeef4f8));
    snow.position.y = (0.72 + i * 0.4) * s + h * 0.32;
    g.add(snow);
  }
  g.rotation.y = rng() * 6.28;
  return g;
}

/* saguaro: ribbed column with elbowed arms and a rare bloom */
function makeCactus(rng, s = 1) {
  const g = new THREE.Group();
  const green = 0x4d8a4f, greenDim = 0x3d7040;
  const h = (1.4 + rng() * 0.9) * s;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.2 * s, h, 7), flat(green));
  body.position.y = h / 2;
  body.castShadow = true;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16 * s, 7, 5), flat(green));
  cap.position.y = h;
  g.add(body, cap);
  const nArms = rng() < 0.25 ? 0 : 1 + Math.floor(rng() * 2);
  for (let i = 0; i < nArms; i++) {
    const side = i === 0 ? 1 : -1;
    const ay = h * (0.4 + rng() * 0.25);
    const out = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * s, 0.12 * s, 0.42 * s, 6), flat(greenDim));
    out.rotation.z = side * Math.PI / 2;
    out.position.set(side * 0.32 * s, ay, 0);
    const up = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * s, 0.12 * s, (0.5 + rng() * 0.4) * s, 6), flat(green));
    up.position.set(side * 0.5 * s, ay + 0.32 * s, 0);
    up.castShadow = true;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1 * s, 6, 5), flat(green));
    knob.position.set(side * 0.5 * s, ay + 0.62 * s, 0);
    g.add(out, up, knob);
  }
  if (rng() < 0.3) {
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.09 * s, 6, 5), flat(0xe86a8a));
    bloom.position.y = h + 0.14 * s;
    g.add(bloom);
  }
  g.rotation.y = rng() * 6.28;
  return g;
}

function makeDeadScrub(rng, s = 1) {
  const g = new THREE.Group();
  const wood = 0x9a8262;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * s, 0.1 * s, 0.9 * s, 5), flat(wood));
  trunk.position.y = 0.45 * s;
  trunk.rotation.z = (rng() - 0.5) * 0.3;
  g.add(trunk);
  for (let i = 0; i < 4; i++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.04 * s, 0.6 * s, 4), flat(wood));
    br.position.set((rng() - 0.5) * 0.3 * s, (0.6 + rng() * 0.4) * s, (rng() - 0.5) * 0.3 * s);
    br.rotation.set((rng() - 0.5) * 1.4, rng() * 6.28, 0.5 + rng() * 0.9);
    g.add(br);
  }
  return g;
}

/* wind-carved sandstone hoodoo */
function makeSandSpire(rng, s = 1) {
  // the Meshy sculpted hoodoo; ~2.6u tall at s=1, randomly spun
  return glbProp('sand_spire', { h: 2.6 * s, ry: rng() * 6.28 });
}

/* tall emergent canopy tree with hanging vines */
function makeJungleTree(rng, s = 1) {
  const g = new THREE.Group();
  const h = (1.8 + rng() * 0.9) * s;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.16 * s, h, 6), flat(0x6a4a30));
  trunk.position.y = h / 2;
  trunk.rotation.z = (rng() - 0.5) * 0.14;
  trunk.castShadow = true;
  g.add(trunk);
  const greens = [0x1d6e30, 0x2a8a3e, 0x17552a];
  const nP = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < nP; i++) {
    const puff = new THREE.Mesh(
      displace(new THREE.IcosahedronGeometry((0.42 + rng() * 0.24) * s, 0), 0.1 * s, seedFrom(rng)),
      flat(greens[i % 3]));
    puff.position.set((rng() - 0.5) * 0.8 * s, h + (rng() - 0.2) * 0.4 * s, (rng() - 0.5) * 0.8 * s);
    puff.castShadow = true;
    g.add(puff);
  }
  const nV = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < nV; i++) {
    const len = (0.6 + rng() * 0.7) * s;
    const vine = new THREE.Mesh(new THREE.CylinderGeometry(0.015 * s, 0.02 * s, len, 3), flat(0x3f7a35));
    const a = rng() * 6.28;
    vine.position.set(Math.cos(a) * 0.5 * s, h - len / 2 + 0.1 * s, Math.sin(a) * 0.5 * s);
    vine.rotation.x = (rng() - 0.5) * 0.2;
    g.add(vine);
    const tip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06 * s, 0), flat(0x4f9a40));
    tip.position.set(Math.cos(a) * 0.5 * s, h - len + 0.1 * s, Math.sin(a) * 0.5 * s);
    g.add(tip);
  }
  return g;
}

/* amber/red broadleaf */
function makeAutumnTree(rng, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.15 * s, 1.05 * s, 5), flat(0x5a4030));
  trunk.position.y = 0.52 * s;
  trunk.rotation.z = (rng() - 0.5) * 0.3;
  trunk.castShadow = true;
  g.add(trunk);
  const tones = [0xd07828, 0xb44b2a, 0xe0a030, 0xc96a20];
  const nP = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < nP; i++) {
    const puff = new THREE.Mesh(
      displace(new THREE.IcosahedronGeometry((0.36 + rng() * 0.18) * s, 0), 0.08 * s, seedFrom(rng)),
      flat(tones[Math.floor(rng() * tones.length)]));
    puff.position.set((rng() - 0.5) * 0.6 * s, (1.1 + rng() * 0.45) * s, (rng() - 0.5) * 0.6 * s);
    puff.castShadow = true;
    g.add(puff);
  }
  return g;
}

function makeRock(rng, r, color = COL.rock) {
  const geo = displace(new THREE.DodecahedronGeometry(r, 0), r * 0.55, rng() * 100);
  geo.scale(1, 0.65 + rng() * 0.3, 1);
  const rock = new THREE.Mesh(geo, flat(color));
  rock.castShadow = true;
  rock.rotation.y = rng() * 6.28;
  return rock;
}

/* dispatch a tree/plant for the theme's flora set — Meshy flora now, at
   the same call-site scales (natural heights come from props.js) */
function floraFor(theme, rng, s = 1) {
  const kind = theme.flora;
  if (kind === 'pine') return propGroup(rng() < 0.3 ? 'pine_tree' : 'pine_snow', s);
  if (kind === 'cactus') return propGroup(rng() < 0.5 ? 'cactus' : 'dead_scrub', s);
  if (kind === 'jungle') return propGroup(rng() < 0.72 ? 'jungle_tree' : 'palm_tree', s);
  if (kind === 'autumn') return propGroup('autumn_tree', s);
  // aegean
  const r = rng();
  if (r < 0.5) return propGroup('palm_tree', s);
  if (r < 0.8) return propGroup('cypress_tree', s);
  return propGroup('olive_tree', s);
}

/* ── buildings & props ──────────────────────────────────────────────────── */
function makeColumn(h = 1.6, r = 0.13) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(r * 2.6, r * 0.7, r * 2.6), flat(COL.marbleShade));
  base.position.y = r * 0.35;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.14, h, 8), flat(COL.marble));
  shaft.position.y = r * 0.7 + h / 2;
  shaft.castShadow = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(r * 3, r * 0.8, r * 3), flat(COL.marbleShade));
  cap.position.y = r * 0.7 + h + r * 0.4;
  g.add(base, shaft, cap);
  return g;
}

function makeShrine(domainHex, themeId = 'hub', spent = false) {
  const g = new THREE.Group();
  const temple = { ice: 'temple_ice', desert: 'temple_desert',
                   jungle: 'temple_jungle', autumn: 'temple_autumn' }[themeId]
                 || 'temple';
  g.add(glbProp(temple, {
    h: 4.6,
    onReady: spent ? (inst) => inst.traverse((o) => {
      if (o.isMesh && o.material?.color) {
        o.material = o.material.clone();
        o.material.color.multiplyScalar(0.55);
      }
    }) : null,
  }));
  // the oracle's domain still reads at a glance: a tinted flame over the roof
  const glow = glowSprite(domainHex, 3.4);
  glow.material.opacity = spent ? 0.12 : 0.75;
  glow.position.y = 5.3;
  g.add(glow);
  const light = new THREE.PointLight(new THREE.Color(domainHex), spent ? 0.8 : 4, 11, 2);
  light.position.y = 4.4;
  g.add(light);
  return g;
}

function makeObelisk() {
  const g = new THREE.Group();
  g.add(glbProp('obelisk', { h: 5.4 }));   // 150% up
  const glow = new THREE.PointLight(0x9fb4ff, 5, 9);
  glow.position.y = 2.4;
  g.add(glow);
  return g;
}

function makeTents(rng) {
  const g = new THREE.Group();
  g.add(glbProp('tents', { h: 2.3, ry: rng() * 6.28 }));
  const fire = new THREE.PointLight(0xff9a3d, 5, 8);
  fire.position.y = 1.2;
  g.add(fire);
  return g;
}

function makeLighthouse() {
  const g = new THREE.Group();
  g.add(glbProp('lighthouse', { h: 4.6 }));
  // a warm glimmer, not a floodlight — was washing out Home Port
  const light = new THREE.PointLight(0xffd9a0, 1.6, 9, 2);
  light.position.y = 3.7;
  g.add(light);
  return g;
}

function makeDock(len = 5.2) {
  const g = new THREE.Group();
  const glb = glbProp('dock', { len, ry: Math.PI / 2 });
  glb.position.z = -len / 2;         // extend from the shore anchor seaward
  g.add(glb);
  return g;
}

function makeMarket(rng, ry = 0) {
  const g = new THREE.Group();
  g.add(glbProp('market', { h: 5.0, ry }));   // marble taberna, porch faces `ry`
  return g;
}

function glowSprite(cssOrHex, scale = 6, name = '') {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: new THREE.Color(cssOrHex), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.set(scale, scale, 1);
  if (name) sp.name = name;
  return sp;
}

function makePharos() {
  const g = new THREE.Group();
  // the tower itself is the Meshy landmark; the FIRE, the beam, the halo and
  // the sealed sigil gate are the game's own — scene.js drives them by name
  g.add(glbProp('pharos', { h: 31.2 }));   // 20% taller
  const fire = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffdf90 }));
  fire.position.y = 22.4;
  fire.name = 'pharosfire';
  // a lit beacon, not a sun — the old 42-intensity/range-300 lamp bleached
  // the whole hub white
  const light = new THREE.PointLight(0xffe2a0, 6, 90, 2);
  light.position.y = 22.4;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.8, 70, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.09,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  beam.position.y = 56;
  const halo = glowSprite(0xffeecb, 15);
  halo.material.opacity = 0.4;
  halo.position.y = 22.4;
  g.add(fire, light, beam, halo);
  // (the old propylaea doorway is gone — the Meshy tower carries its own
  // carved door; makePharosGate stays available if a sealed-door set piece
  // is ever wanted again)
  return g;
}

/* The sealed door at the Pharos' foot: a marble portal, twin bronze leaves,
   and three sigil sockets across the lintel. The sockets sit BLANK (dark) and
   the leaves stay shut until a captain banks all three seals — the scene lights
   a socket per banked seal and swings the leaves once all three answer. Parts
   are named so scene.js can drive that state per frame. */
function makePharosGate() {
  const gate = new THREE.Group();
  gate.name = 'pharosgate';
  gate.position.set(0, 0, 7.4);                 // front face, toward the berth
  const stone = flat(COL.marbleShade);
  const jamb = (x) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5.4, 0.9), stone);
    m.position.set(x, 2.7, 0);
    m.castShadow = true;
    return m;
  };
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.9, 1.0), stone);
  lintel.position.set(0, 5.7, 0);
  lintel.castShadow = true;
  const sill = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.4, 1.2), stone);
  sill.position.set(0, 0.2, 0.1);
  gate.add(jamb(-2.0), jamb(2.0), lintel, sill);

  // twin bronze leaves on hinge pivots at the jambs
  const bronze = new THREE.MeshStandardMaterial({
    color: 0x5b4a2a, flatShading: true, metalness: 0.5, roughness: 0.55,
    emissive: 0x120c04, emissiveIntensity: 1 });
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'doorPivotL' : 'doorPivotR';
    pivot.position.set(side * 1.7, 2.9, 0.35);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.62, 4.9, 0.28), bronze);
    leaf.position.set(-side * 0.85, 0, 0);      // extends inward, leaves meet at centre
    leaf.castShadow = true;
    // a raised stud line down each leaf
    const stud = new THREE.Mesh(new THREE.BoxGeometry(0.16, 4.2, 0.12),
      flat(0x8a7038, { emissive: 0x2a1e08 }));
    stud.position.set(-side * 0.85, 0, 0.2);
    pivot.add(leaf, stud);
    gate.add(pivot);
  }

  // three sigil sockets across the lintel — dark carved discs that light up
  const socketMat = flat(0x2a2620);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 1.5;
    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.22, 12), socketMat);
    socket.rotation.x = Math.PI / 2;            // face the disc toward the berth
    socket.position.set(x, 5.7, 0.55);
    const sigil = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.14, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a352c, flatShading: true,
        emissive: 0xffd66a, emissiveIntensity: 0 }));   // blank until banked
    sigil.rotation.x = Math.PI / 2;
    sigil.position.set(x, 5.7, 0.64);
    sigil.name = 'sigil' + i;
    gate.add(socket, sigil);
  }
  return gate;
}

function makeRelicBeacon() {
  // no pillar of light — just a small gold urn marking the relic spot
  const g = new THREE.Group();
  const urn = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), flat(COL.gold, { emissive: 0x9a6a10 }));
  urn.position.y = 1.4;
  g.add(urn);
  g.name = 'beacon';
  return g;
}

/* the BARROW beacon: the Amber Vale is a fog-of-war maze, so its goal wears
   a great golden pillar of light that burns THROUGH the murk (fog-free) —
   you always know the direction, never the route */
function makeBarrowBeacon() {
  const g = new THREE.Group();
  const GOLD = 0xffc14d;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 3.2, 190, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.34,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      fog: false }));
  beam.position.y = 95;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.1, 190, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      fog: false }));
  core.position.y = 95;
  const halo = glowSprite(GOLD, 16);
  halo.material.opacity = 0.55;
  halo.material.fog = false;
  halo.position.y = 6;
  const crown = glowSprite(0xfff3d0, 26);
  crown.material.opacity = 0.4;
  crown.material.fog = false;
  crown.position.y = 120;
  const light = new THREE.PointLight(GOLD, 14, 60, 1.8);
  light.position.y = 8;
  g.add(beam, core, halo, crown, light);
  g.name = 'barrowbeacon';
  return g;
}

/* the CHECKPOINT light: every haven wears a permanent azure beam — you can
   read where you'll respawn from anywhere on the water */
function makeCheckpointBeacon() {
  const g = new THREE.Group();
  const AZURE = 0x3fa8ff;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 2.6, 7),
    flat(COL.marbleShade));
  post.position.y = 1.3;
  post.castShadow = true;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xbfe4ff }));
  lamp.position.y = 2.9;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.85, 26, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: AZURE, transparent: true, opacity: 0.3,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  beam.position.y = 15.5;
  const halo = glowSprite(AZURE, 7);
  halo.material.opacity = 0.5;
  halo.position.y = 2.9;
  const light = new THREE.PointLight(AZURE, 3.2, 34, 2);
  light.position.y = 3.2;
  g.add(post, lamp, beam, halo, light);
  g.name = 'checkpoint';
  return g;
}

function makeBuoy(rng) {
  const g = new THREE.Group();
  const float_ = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.38, 0.42, 8), flat(0xd9534f));
  float_.position.y = 0.28;
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.14, 8), flat(0xf7f4ec));
  stripe.position.y = 0.34;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 5), flat(COL.woodDark));
  pole.position.y = 1.0;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5),
    flat(0xffd97a, { emissive: 0x9a7a1a }));
  lamp.position.y = 1.6;
  g.add(float_, stripe, pole, lamp);
  g.rotation.y = rng() * 6.28;
  g.name = 'bob';
  return g;
}


/* drifting flotsam: a raft of crates & a barrel with a gold glint — sail onto
   it to haul it aboard for a scroll. Named 'bob' so it rides the swell. */
function makeFlotsam(rng) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.55), flat(COL.woodDark));
    const a = rng() * 6.28;
    crate.position.set(Math.cos(a) * (0.4 + rng() * 0.5), 0.16, Math.sin(a) * (0.4 + rng() * 0.5));
    crate.rotation.y = rng() * 1.5;
    g.add(crate);
  }
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 8), flat(COL.wood));
  barrel.rotation.z = Math.PI / 2;
  barrel.position.y = 0.2;
  g.add(barrel);
  const glint = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5),
    flat(COL.gold, { emissive: 0x9a6a10 }));
  glint.position.y = 0.5;
  g.add(glint);
  g.name = 'bob';
  return g;
}


/* desert-trek waypoint: a traveller's cairn with a prayer flag */
function makeCairn(rng) {
  const g = new THREE.Group();
  let y = 0;
  for (let i = 0; i < 5; i++) {
    const r = 0.55 - i * 0.09;
    const stone = new THREE.Mesh(
      displace(new THREE.DodecahedronGeometry(r, 0), r * 0.4, seedFrom(rng)), flat(0xd8cdb4));
    stone.scale.y = 0.6;
    stone.position.set((rng() - 0.5) * 0.12, y + r * 0.4, (rng() - 0.5) * 0.12);
    stone.castShadow = true;
    g.add(stone);
    y += r * 0.66;
  }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.4, 4), flat(COL.woodDark));
  pole.position.y = y + 0.5;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.28),
    flat(0xc0392b, { side: THREE.DoubleSide }));
  flag.position.set(0.26, y + 1.05, 0);
  flag.name = 'pennant';
  g.add(pole, flag);
  g.rotation.y = rng() * 6.28;
  return g;
}

/* desert-trek waypoint: bleached ribs of something enormous */
function makeRibs(rng) {
  const g = new THREE.Group();
  const n = 4 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const r = 1.5 - i * 0.22;
    const rib = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07 + r * 0.02, 5, 10, Math.PI * 0.95), flat(COL.bone));
    rib.position.set(i * 0.9 - n * 0.45, 0.05, 0);
    rib.rotation.set(0, Math.PI / 2, 0.12 + (rng() - 0.5) * 0.15);
    rib.castShadow = true;
    g.add(rib);
  }
  const skull = new THREE.Mesh(
    displace(new THREE.SphereGeometry(0.6, 8, 6), 0.14, seedFrom(rng)), flat(COL.bone));
  skull.scale.set(1.3, 0.8, 0.9);
  skull.position.set(-n * 0.45 - 1.1, 0.35, 0);
  g.add(skull);
  g.rotation.y = rng() * 6.28;
  return g;
}

/* ── realm wilds: the stuff that fills the water/sand BETWEEN stops ─────── */

/* a drifting iceberg — the Meshy berg, scaled by the old berg sizes */
export function makeBerg(rng, s = 1) {
  return propGroup('iceberg', s);
}

/* drift chunks between the bergs — small crystalline shards awash */
export function makeFloe(rng, s = 1) {
  return propGroup('ice_shard', 0.4 + s * 0.45);
}

/* a floating tangle on the brown water: the Meshy lily pads, ringed by
   snaking procedural vines so the channels still read vine-choked */
export function makeVineMat(rng, s = 1) {
  const g = new THREE.Group();
  g.add(propGroup('lily_pads', 1.1 + s * 0.9));
  const vine = flat(0x3f6d2a);
  for (let i = 0; i < 3; i++) {
    const arc = new THREE.Mesh(
      new THREE.TorusGeometry((1.3 + rng() * 1.6) * s, 0.07, 5, 10, Math.PI * (0.6 + rng() * 0.5)),
      vine);
    const a = rng() * 6.28;
    arc.position.set(Math.cos(a) * 1.6 * s, 0.1, Math.sin(a) * 1.6 * s);
    arc.rotation.set(Math.PI / 2, 0, rng() * 6.28);
    g.add(arc);
  }
  g.name = 'bob';
  return g;
}

/* a wind-heaped dune — the Meshy dune, at the old ridge footprints
   (sandHex kept in the signature for call-site compatibility) */
export function makeDune(rng, sandHex, s = 1) {
  return propGroup('sand_dune', 0.9 + s * 0.9);
}

/* the desert tyrant's LAIR: a stepped sandstone tomb half-swallowed by the
   dunes — mastaba tiers, a black doorway, twin obelisks on the approach */
export function makeTomb(rng) {
  const g = new THREE.Group();
  const stone = flat(0xd9c49a);
  const stoneDk = flat(0xb99f74);
  const tiers = [
    [10.4, 1.2, 8.2, 0.6],
    [8.6, 1.7, 6.8, 1.95],
    [6.6, 1.6, 5.2, 3.55],
    [4.6, 1.5, 3.6, 5.05],
  ];
  tiers.forEach(([w, h, d, y], i) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), i % 2 ? stoneDk : stone);
    t.position.y = y;
    t.castShadow = true;
    t.receiveShadow = true;
    g.add(t);
  });
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.6, 4), stone);
  cap.rotation.y = Math.PI / 4;
  cap.position.y = 6.6;
  cap.castShadow = true;
  g.add(cap);
  // the doorway: a black void in a raised stone frame, facing the trail
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.0, 0.7), stoneDk);
  frame.position.set(0, 1.5, 4.15);
  frame.castShadow = true;
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.2, 0.3),
    flat(0x14100a, { emissive: 0x000000 }));
  door.position.set(0, 1.25, 4.45);
  g.add(frame, door);
  // twin sandstone obelisks flanking the approach
  for (const x of [-3.6, 3.6]) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.55, 3.4, 4), stone);
    shaft.rotation.y = Math.PI / 4;
    shaft.position.set(x, 1.7, 5.4);
    shaft.castShadow = true;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.6, 4),
      flat(COL.gold, { emissive: 0x7a5a10, emissiveIntensity: 0.5 }));
    tip.rotation.y = Math.PI / 4;
    tip.position.set(x, 3.7, 5.4);
    g.add(shaft, tip);
  }
  const bones = makeRibs(rng);
  bones.scale.setScalar(0.8);
  bones.position.set(-4.6, 0.05, 3.4);
  g.add(bones);
  const glow = new THREE.PointLight(0xffb066, 4, 12, 2);
  glow.position.set(0, 2.2, 5.2);
  g.add(glow);
  return g;
}

/* the Amber Vale's LAIR: a mossy barrow — an earthen crypt-mound with a
   megalith door and a ring of leaning standing stones */
export function makeBarrow(rng) {
  const g = new THREE.Group();
  const earth = flat(0x5c5433);
  const moss = flat(0x51682d);
  const mound = new THREE.Mesh(
    displace(new THREE.SphereGeometry(6.2, 10, 8), 0.5, seedFrom(rng)), earth);
  mound.scale.set(1.15, 0.5, 1);
  mound.position.y = 0.2;
  mound.castShadow = true;
  mound.receiveShadow = true;
  g.add(mound);
  for (let i = 0; i < 4; i++) {                 // moss creeping up the mound
    const patch = new THREE.Mesh(new THREE.SphereGeometry(1.6 + rng() * 1.2, 7, 5), moss);
    patch.scale.y = 0.3;
    const a = rng() * 6.28, r = 2.5 + rng() * 2.5;
    patch.position.set(Math.cos(a) * r, 1.4 + rng() * 0.9, Math.sin(a) * r * 0.8);
    g.add(patch);
  }
  // megalithic portal set into the mound's face
  const rock = flat(0x6f6a5c);
  for (const x of [-1.35, 1.35]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3.0, 1.0), rock);
    jamb.position.set(x, 1.5, 5.6);
    jamb.rotation.z = -x * 0.04;
    jamb.castShadow = true;
    g.add(jamb);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 1.2), rock);
  lintel.position.set(0, 3.2, 5.6);
  lintel.castShadow = true;
  const maw = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.4, 0.4), flat(0x0c0f08));
  maw.position.set(0, 1.2, 5.75);
  g.add(lintel, maw);
  // a ring of leaning stones keeps watch around the mound
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const st = new THREE.Mesh(
      new THREE.BoxGeometry(0.8 + rng() * 0.4, 1.7 + rng() * 1.2, 0.6), rock);
    st.position.set(Math.cos(a) * 8.6, 0.85, Math.sin(a) * 8.0);
    st.rotation.set((rng() - 0.5) * 0.25, rng() * 6.28, (rng() - 0.5) * 0.25);
    st.castShadow = true;
    g.add(st);
  }
  const skull = new THREE.Mesh(
    displace(new THREE.SphereGeometry(0.5, 8, 6), 0.12, seedFrom(rng)), flat(COL.bone));
  skull.scale.set(1.2, 0.8, 0.9);
  skull.position.set(2.6, 0.3, 6.4);
  g.add(skull);
  const glow = new THREE.PointLight(0x9fd8a0, 3.5, 11, 2);
  glow.position.set(0, 1.8, 6.4);
  g.add(glow);
  return g;
}

/* The ambient wilds BETWEEN the stops — a berg field, a dune sea, vine-
   choked channels, or the Vale's unbroken forest. `nodes` are the region's
   board nodes and `segs` its lane segments [x1,z1,x2,z2]; everything lands
   clear of both so the road itself stays readable. */
export function makeRealmField(theme, nodes, segs, rng, heightAt = null) {
  const g = new THREE.Group();
  if (!nodes.length) return g;
  const groundY = heightAt || (() => 0);           // seat props on the dunes
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const M = 55;                                   // the wilds spill past the road
  minX -= M; maxX += M; minZ -= M; maxZ += M;
  const nodeDist = (x, z) => {
    let d = 1e9;
    for (const n of nodes) d = Math.min(d, Math.hypot(n.x - x, n.z - z));
    return d;
  };
  const segDist = (x, z) => {
    let d = 1e9;
    for (const s of segs) {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / L2));
      d = Math.min(d, Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z));
    }
    return d;
  };
  const scatter = (count, laneClear, isleClear, reach, make, yOff = 0) => {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < count * 16) {
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
      // no lanes at all (the Vale before its trails reveal): fill freely
      const sd = segs.length ? segDist(x, z) : laneClear + 1;
      if (sd < laneClear || sd > reach || nodeDist(x, z) < isleClear) continue;
      const o = make();
      o.position.set(x, groundY(x, z) + yOff, z);
      o.rotation.y = rng() * 6.28;
      g.add(o);
      placed++;
    }
  };
  // Meshy filler props. The field floor is WATER in sail realms and sand/
  // leaf-litter in foot realms — so open-water scatters get only props that
  // can plausibly float or break the surface (wrecks, drift ice, pads,
  // sea-stack boulders); ruins, trees and furniture live on the ISLANDS
  // (see dressIsland). prop(id, s) picks a random member each time.
  const foot = theme.id === 'desert' || theme.id === 'autumn';
  const prop = (ids, lo, hi) => () =>
    propGroup(ids[(rng() * ids.length) | 0], lo + rng() * (hi - lo));

  // a worn dirt path laid over the trail: crisp ribbon quads down each lane
  // segment, riding the ground height so it never floats or sinks. The route
  // reads at a glance and the tree band stands well clear of it either side.
  // NOT in the Vale: its trails reveal over time (live flagstones do that
  // job), and a ribbon baked from the few build-time edges would lie.
  if (foot && theme.id !== 'autumn' && segs.length) {
    const HW = 2.6;                                 // path half-width
    const pathCol = theme.id === 'autumn' ? 0x8a6a3e : 0xc7a468;
    const verts = [];
    for (const s of segs) {
      const ax = s[0], az = s[1], bx = s[2], bz = s[3];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz) || 1e-6;
      const px = -dz / len * HW, pz = dx / len * HW;   // perpendicular offset
      const ay = groundY(ax, az) + 0.06, by = groundY(bx, bz) + 0.06;
      // two triangles: (A+perp, A-perp, B-perp) and (A+perp, B-perp, B+perp)
      const A1 = [ax + px, ay, az + pz], A2 = [ax - px, ay, az - pz];
      const B1 = [bx + px, by, bz + pz], B2 = [bx - px, by, bz - pz];
      verts.push(...A1, ...A2, ...B2, ...A1, ...B2, ...B1);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    pg.computeVertexNormals();
    const pathMesh = new THREE.Mesh(pg,
      new THREE.MeshStandardMaterial({ color: pathCol, roughness: 1, flatShading: true }));
    pathMesh.receiveShadow = true;
    pathMesh.renderOrder = 1;
    g.add(pathMesh);
  }
  if (foot && theme.id !== 'autumn') {
    // ruins + boulders belong to the open desert; the Vale floor stays clear of
    // rocky bumps — just trees, litter and the odd camp
    scatter(7, 11, 16, 120, prop(['boulder', 'ruined_column', 'broken_statue', 'cairn', 'ruined_arch'], 0.7, 1.3));
  } else if (!foot) {
    scatter(6, 12, 17, 120, prop(['boulder'], 0.7, 1.2));   // sea stacks
  }
  if (theme.id === 'ice') {
    // bergs live OUT in the open water, well off the sailing lane; the crystals
    // ride low on the surface and are flung far and wide
    scatter(38, 36, 28, 280, () => makeBerg(rng, 0.5 + rng() * 0.6));
    scatter(30, 32, 26, 280, () => makeFloe(rng, 0.8 + rng() * 0.9));
    scatter(16, 30, 24, 280, prop(['ice_shard', 'crystal_cluster', 'ice_floe'], 0.7, 1.2), -0.35);
    scatter(4, 22, 24, 200, prop(['shipwreck', 'driftwood'], 0.9, 1.4));
  } else if (theme.id === 'jungle') {
    scatter(80, 13, 20, 115, () => makeVineMat(rng, 0.65 + rng() * 0.7));
    scatter(18, 12, 18, 115, prop(['lily_pads', 'lily_pads', 'coral', 'driftwood'], 0.8, 1.4));
  } else if (theme.id === 'desert') {
    // an OPEN Reach: the ground itself carries the broad dune swells, and the
    // sand is nearly bare — only cactus, dry scrub and the odd cairn, all
    // spread far apart (big reach) so the desert feels vast and empty
    scatter(22, 12, 16, 240, () => propGroup('cactus', 0.8 + rng() * 0.6));
    scatter(20, 12, 16, 240, () => propGroup('dead_scrub', 0.8 + rng() * 0.6));
    scatter(9, 22, 24, 240, () => propGroup('cairn', 1.0 + rng() * 0.6));
  } else if (theme.id === 'autumn') {
    // the Vale is a THICK wood on a FLAT floor: the maze's stops reveal over
    // time, so the trees fill the WHOLE wedge (huge reach — not hugging the
    // known lanes) and the fog does the hiding. No rocky bumps, boulders or
    // cairns — just soft litter (fallen trunks, mushrooms) and the odd camp.
    scatter(3200, 4.5, 5, 9999, () => floraFor(theme, rng, 1.1 + rng() * 0.9));
    scatter(46, 5, 7, 9999, prop(['dead_tree', 'mushroom_cluster'], 0.7, 1.4));
    scatter(26, 5, 7, 9999, prop(['autumn_tree', 'campfire', 'stone_well', 'barrel', 'waymarker_stone'], 0.8, 1.5));
  } else {
    // hub / aegean open water: flotsam only — the good stuff is ashore
    scatter(8, 12, 17, 120, prop(['driftwood', 'fishing_net', 'buoy'], 0.7, 1.1));
  }
  return g;
}

/* map totem for an active monster node: dark spiked megalith, watching eyes */
function makeMonsterTotem(rng, m) {
  const g = new THREE.Group();
  const hp = Math.min(10, m?.max_hp ?? 4);
  const s = 1 + hp * 0.12;
  // the Meshy carved totem (dark stone, red eyes) marks the lurking foe;
  // the ember light + haze below are the gameplay "danger here" signal and
  // stand in until the model streams in
  g.add(propGroup('monster_totem', s * 0.85));
  const ember = new THREE.PointLight(0xff5030, 3 + hp, 7 + hp);
  ember.position.y = 2.2 * s;
  const haze = glowSprite(0xff4a26, 3.4 * s);
  haze.material.opacity = 0.4;
  haze.position.y = 1.6 * s;
  g.add(ember, haze);
  g.name = 'monster';
  return g;
}

/* the boss trial altar on lair isles */
function makeLairAltar(accentHex, rng) {
  const g = new THREE.Group();
  const accent = new THREE.Color(accentHex);
  const slab = new THREE.Mesh(
    displace(new THREE.CylinderGeometry(1.7, 2.1, 0.6, 8), 0.16, seedFrom(rng)),
    flat(COL.basalt));
  slab.position.y = 0.3;
  slab.castShadow = true;
  const step = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 0.3, 9), flat(0x3a3a42));
  step.position.y = 0.05;
  g.add(slab, step);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const horn = new THREE.Mesh(
      displace(new THREE.ConeGeometry(0.22, 2.2 + (i % 2) * 0.6, 5), 0.14, seedFrom(rng)),
      flat(0x2c2830));
    horn.position.set(Math.cos(a) * 1.9, 1.2, Math.sin(a) * 1.9);
    horn.rotation.set(Math.sin(a) * -0.35, 0, Math.cos(a) * 0.35);
    horn.castShadow = true;
    g.add(horn);
  }
  for (const side of [-1, 1]) {
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.16, 0.3, 6),
      flat(0x4a4a52, { emissive: accent, emissiveIntensity: 0.4 }));
    bowl.position.set(side * 1.3, 0.75, 0);
    const fl = glowSprite(accent, 1.8, 'brazier');
    fl.position.set(side * 1.3, 1.15, 0);
    g.add(bowl, fl);
  }
  const glow = new THREE.PointLight(accent, 9, 22, 1.7);
  glow.position.y = 2.4;
  g.add(glow);
  return g;
}

/* a tall fluted temple column with a proper base and echinus/abacus capital */
function _grandColumn(h, r) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.5, r * 1.75, r * 1.3, 10),
    flat(COL.marbleShade));
  base.position.y = r * 0.65;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r, h, 14),
    flat(COL.marble));
  shaft.position.y = r * 1.3 + h / 2;
  shaft.castShadow = true;
  const echinus = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.35, r * 0.86, r * 0.8, 14),
    flat(COL.marble));
  echinus.position.y = r * 1.3 + h + r * 0.4;
  const abacus = new THREE.Mesh(new THREE.BoxGeometry(r * 3, r * 0.7, r * 3), flat(COL.marbleShade));
  abacus.position.y = r * 1.3 + h + r * 0.9;
  g.add(base, shaft, echinus, abacus);
  return g;
}

/* THE MOUNTAIN PASS — a monumental carved gateway into a trial realm.
 * Two great strata towers on a stone dais, framed by temple colonnades and
 * flanked by guardian obelisks; a corbelled arch with keystone, a glowing
 * carved frieze, a pediment crown, brazier plinths and hanging banners in the
 * realm's colour. Local frame: the channel runs along ±Z, the structure
 * flanks along ±X (the caller rotates it so the channel opens radially). */
function makeGatePortal(accentHex, seed, rockHex = 0x8a8f98) {
  const g = new THREE.Group();
  const accent = new THREE.Color(accentHex);
  const rock = new THREE.Color(rockHex);
  const rockLt = rock.clone().multiplyScalar(1.16);
  const rockDk = rock.clone().multiplyScalar(0.6);
  const rng = mulberry32(seed);
  const CH = 9;                       // half-width of the sailing channel

  // ── two stepped stone quays, one under each tower — the sailing channel
  //    between them (|x| < CH) stays OPEN WATER so a ship passes straight
  //    through the arch instead of fetching up against a solid dais ──
  for (const qs of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(15 - i * 2.4, 1.15, 27 - i * 3.2),
        flat(i % 2 ? rockDk : rock));
      step.position.set(qs * (CH + 5.5), -0.3 + i * 0.85, 0);
      step.receiveShadow = true;
      g.add(step);
    }
  }
  // a low threshold sill bridging the quays at the back of the arch, kept
  // below the waterline so it reads as a submerged causeway, not a wall
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2 * CH + 2, 0.7, 3.2), flat(rockDk));
  sill.position.set(0, -0.55, -6.5);
  g.add(sill);

  for (const side of [-1, 1]) {
    const tx = side * (CH + 4);

    // ── great flanking tower: three tapering strata blocks + jagged crown ──
    const tiers = [[8.4, 7.2, 10, 5], [7, 6, 9, 14.5], [5.6, 5, 8, 23]];
    tiers.forEach(([w, d, h, y], k) => {
      const c = k === 0 ? rockDk : k === 1 ? rock : rockLt;
      const blk = new THREE.Mesh(
        displace(new THREE.BoxGeometry(w, h, d, 2, 2, 2), 0.32, seed + side * 7 + y),
        flat(c, { flatShading: true }));
      blk.position.set(tx, y, 0);
      blk.castShadow = true;
      g.add(blk);
      const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.5, d + 0.7), flat(rockDk));
      band.position.set(tx, y + h / 2, 0);
      g.add(band);
    });
    const crown = new THREE.Mesh(
      displace(new THREE.ConeGeometry(3.6, 9, 6, 2), 1.9, seed + side * 13),
      flat(rockLt, { flatShading: true }));
    crown.position.set(tx, 31, 0);
    crown.castShadow = true;
    g.add(crown);
    // a buttress wedge bracing the tower toward the channel
    const butt = new THREE.Mesh(new THREE.BoxGeometry(3.4, 12, 4.4), flat(rockDk));
    butt.position.set(tx - side * 3.4, 6, 0);
    butt.rotation.z = side * 0.42;
    g.add(butt);
    // glowing carved arrow-slit on the inner face
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.5, 0.5),
      flat(0x161219, { emissive: accent, emissiveIntensity: 1.25 }));
    slit.position.set(tx - side * 3.7, 15, 0);
    g.add(slit);

    // ── temple colonnade framing the channel mouth (a column fore & aft) ──
    for (const zz of [-5, 5]) {
      const col = _grandColumn(11, 0.9);
      col.position.set(side * (CH - 1.2), 0.9, zz);
      g.add(col);
    }
    const entablature = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.5, 13.5),
      flat(COL.marbleShade));
    entablature.position.set(side * (CH - 1.2), 13.3, 0);
    entablature.castShadow = true;
    g.add(entablature);

    // ── tall brazier plinth at the fore mouth ──
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 6.5, 8), flat(rockDk));
    plinth.position.set(side * (CH + 0.8), 3.2, 7);
    g.add(plinth);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 0.9, 1.3, 8),
      flat(0x39343f, { emissive: accent, emissiveIntensity: 0.75 }));
    bowl.position.set(side * (CH + 0.8), 6.7, 7);
    g.add(bowl);
    const fl = glowSprite(accent, 3.6, 'brazier');
    fl.position.set(side * (CH + 0.8), 8.1, 7);
    g.add(fl);
    const glow = new THREE.PointLight(accent, 7, 28, 2);
    glow.position.set(side * (CH + 0.8), 8.1, 7);
    g.add(glow);

    // ── guardian obelisk standing watch out front ──
    const ob = new THREE.Mesh(
      displace(new THREE.CylinderGeometry(0.55, 1.4, 10, 5), 0.28, seed + side * 17),
      flat(rockLt, { flatShading: true }));
    ob.position.set(side * (CH + 2.5), 5, 12);
    ob.castShadow = true;
    g.add(ob);
    const obcap = new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.8, 4),
      flat(0x161219, { emissive: accent, emissiveIntensity: 0.9 }));
    obcap.position.set(side * (CH + 2.5), 10.7, 12);
    g.add(obcap);
  }

  // ── monumental archway spanning the channel ──
  for (const side of [-1, 1]) {                    // corbel brackets stepping in
    for (let k = 0; k < 3; k++) {
      const cb = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.2, 3.2), flat(k % 2 ? rock : rockDk));
      cb.position.set(side * (CH + 1.6 - k * 1.2), 16.5 + k * 1.2, 0);
      cb.castShadow = true;
      g.add(cb);
    }
  }
  const lintel = new THREE.Mesh(
    displace(new THREE.BoxGeometry(2 * CH + 7, 3.2, 4.2, 8, 1, 1), 0.4, seed + 31),
    flat(rockLt, { flatShading: true }));
  lintel.position.y = 21.5;
  lintel.castShadow = true;
  g.add(lintel);
  const keystone = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.9, 4.6), flat(rock));
  keystone.position.set(0, 21.5, 0);
  g.add(keystone);
  // carved frieze band with a row of glowing glyphs (dark stone, not a hole)
  const frieze = new THREE.Mesh(new THREE.BoxGeometry(2 * CH + 2.5, 1.5, 4.3),
    flat(rockDk.clone().multiplyScalar(0.85)));
  frieze.position.y = 19.2;
  g.add(frieze);
  for (let i = -4; i <= 4; i++) {
    const gl = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.95, 0.4),
      new THREE.MeshBasicMaterial({ color: accent }));
    gl.position.set(i * 2.05, 19.2, 2.2);
    g.add(gl);
  }
  // a low pediment crowning the arch — a proper triangular gable that faces
  // straight down the channel (built as an extruded triangle, so it never
  // twists off-axis the way a flattened-then-rotated pyramid did)
  const pw = CH + 3.5, ph = 5.5;
  const pedShape = new THREE.Shape();
  pedShape.moveTo(-pw, 0);
  pedShape.lineTo(pw, 0);
  pedShape.lineTo(0, ph);
  pedShape.closePath();
  const pedGeo = new THREE.ExtrudeGeometry(pedShape, { depth: 3.8, bevelEnabled: false });
  pedGeo.translate(0, 0, -1.9);                 // centre the depth on the channel axis
  const ped = new THREE.Mesh(pedGeo, flat(rock, { flatShading: true }));
  ped.position.set(0, 22.9, 0);
  ped.castShadow = true;
  g.add(ped);

  // ── long banners in the realm's colour hanging beside the opening ──
  for (const side of [-1, 1]) {
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 9.5),
      new THREE.MeshStandardMaterial({ color: accent, side: THREE.DoubleSide,
        roughness: 0.85, emissive: accent, emissiveIntensity: 0.18 }));
    ban.position.set(side * 6.2, 13.6, 2.3);
    g.add(ban);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 0.2), flat(COL.gold));
    trim.position.set(side * 6.2, 18.1, 2.3);
    g.add(trim);
  }

  // a soft accent glow breathing in the opening (subtle, not a flat plane)
  const haze = glowSprite(accent, 13);
  haze.material.opacity = 0.16;
  haze.position.set(0, 9.5, 0);
  g.add(haze);

  // marker ring on the water (keeps the pulse-animation hook)
  const ring = new THREE.Mesh(new THREE.RingGeometry(5, 7, 32),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.3,
      side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 1.35;
  ring.name = 'foam';
  g.add(ring);
  return g;
}

/* a pocket oasis: still pool ringed with reeds and palms (foot-mode havens) */
function makeOasis(rng, theme) {
  const g = new THREE.Group();
  const pool = new THREE.Mesh(new THREE.CircleGeometry(2.4, 18),
    new THREE.MeshStandardMaterial({ color: theme.water.shallow, flatShading: true,
      emissive: theme.water.deep, emissiveIntensity: 0.25 }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.06;
  g.add(pool);
  for (let i = 0; i < 4; i++) {
    const a = rng() * 6.28;
    const palm = makePalm(rng, 0.8 + rng() * 0.5);
    palm.position.set(Math.cos(a) * (2.7 + rng()), 0, Math.sin(a) * (2.7 + rng()));
    g.add(palm);
  }
  for (let i = 0; i < 6; i++) {
    const a = rng() * 6.28;
    const reed = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.8 + rng() * 0.5, 4), flat(0x6a8a3e));
    reed.position.set(Math.cos(a) * 2.5, 0.4, Math.sin(a) * 2.5);
    g.add(reed);
  }
  return g;
}

/* scattered coast dressing so islands feel dense and hand-made */
/* Meshy props that belong ON LAND, dealt per biome to the island tops */
const ISLE_PROPS = {
  hub: ['amphora_pile', 'banner_pole', 'brazier', 'tide_pool', 'ruined_column',
        'broken_statue', 'olive_tree', 'cypress_tree', 'reeds'],
  ice: ['crystal_cluster', 'pine_snow', 'ice_shard', 'cairn'],
  jungle: ['mossy_idol', 'mushroom_cluster', 'fern_cluster', 'ruined_arch',
           'stone_well', 'jungle_tree', 'ruined_column'],
  desert: ['bone_pile', 'amphora_pile', 'cactus', 'sarcophagus'],
  autumn: ['mushroom_cluster', 'campfire', 'barrel', 'dead_tree'],
};

function dressIsland(g, rng, theme, R, terrain) {
  // props ride the ACTUAL surface via terrain.place(a, rr) — no more trees
  // hovering over the noise bumps or sinking through them. Kept in the solid
  // interior (rr ≤ ~0.6) so nothing perches on the wavy coastline.
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.28;
    const rr = 0.34 + rng() * 0.26;
    const p = terrain.place(a, rr);
    if (p.y < 0.15) continue;
    if (rng() < 0.6) {
      const f = floraFor(theme, rng, 0.6 + rng() * 0.5);
      f.position.set(p.x, p.y, p.z);
      g.add(f);
    } else {
      const rk = makeRock(rng, 0.3 + rng() * 0.4, theme.palette.rock);
      rk.position.set(p.x, p.y + 0.1, p.z);
      g.add(rk);
    }
  }
  // …and roughly every other isle carries a Meshy set piece on solid ground
  const pool = ISLE_PROPS[theme.id] || ISLE_PROPS.hub;
  if (rng() < 0.55) {
    const a = rng() * 6.28;
    const p = terrain.place(a, 0.3 + rng() * 0.25);
    if (p.y >= 0.15) {
      const pr = propGroup(pool[(rng() * pool.length) | 0], 0.55 + rng() * 0.35);
      pr.position.set(p.x, p.y - 0.06, p.z);
      pr.rotation.y = rng() * 6.28;
      g.add(pr);
    }
  }
}

/* ── island assembly ────────────────────────────────────────────────────── */
const ISLE_R = { home: 13.0, shrine: 10.0, puzzle: 10.0, haven: 11.0,
                 shop: 10.0, monster: 11.0, lair: 14.0, pharos: 17.0,
                 gate: 2.0, sea: 1.5 };

export function buildIsland(node, theme, domains) {
  const g = new THREE.Group();
  const seed = hashStr(node.id);
  const rng0 = mulberry32(seed + 7);
  const R = (ISLE_R[node.type] ?? 4.8) * (node.type === 'sea' ? 1 : 0.88 + rng0() * 0.35);
  const foot = node.mode === 'foot';
  const pal = theme.palette;
  // In the Amber Vale the POIs sit DIRECTLY ON THE GROUND — no raised island.
  // Flatten every terrain to a flush pad so shrines, camps and the barrow stand
  // on the forest floor with the trees, not perched on their own little mounds.
  const flatFoot = foot && theme.id === 'autumn';
  const mt = (opts) => makeTerrain(flatFoot ? { ...opts, H: 0.05, mode: 'flat' } : opts);
  let terrain;

  /* waterline dressing appropriate to sea or sand footing */
  const addSkirt = (radius) => {
    if (foot) {
      g.add(sandRippleRing(radius, pal.sand));
    } else {
      g.add(shallowDisc(radius * 4.0, theme.water.shallow));
      g.add(foamRing(radius));
    }
  };

  if (node.type === 'sea') {
    if (foot) {
      if (theme.id === 'autumn') {
        // a waypoint on the forest track: a single large flat stepping
        // stone set into the path — no dirt splotch, no grove.
        const stone = makeRock(rng0, 1.7, 0x9b938a);
        stone.scale.y = 0.34;                       // a flattened slab, walk-on
        stone.position.y = 0.12;
        stone.castShadow = true;
        stone.receiveShadow = true;
        g.add(stone);
        g.position.set(node.x, 0, node.z);
        return { group: g, R: 1.9, plateauY: 0 };
      }
      // an open waypoint on the trek: just a cairn, maybe a lone cactus or
      // dry bush — the sand stays flat and empty (no heaped dune mounds)
      const marker = propGroup(rng0() < 0.7 ? 'cairn' : 'bone_pile',
        1.0 + rng0() * 0.4);
      g.add(marker);
      if (rng0() < 0.7) {
        const fl = propGroup(rng0() < 0.5 ? 'cactus' : 'dead_scrub', 0.8 + rng0() * 0.5);
        const a = rng0() * 6.28;
        fl.position.set(Math.cos(a) * 3.4, 0, Math.sin(a) * 3.4);
        g.add(fl);
      }
      g.add(sandRippleRing(2.2, pal.sand));
      g.position.set(node.x, 0, node.z);
      return { group: g, R: 3, plateauY: 0 };
    }
    if (theme.id === 'ice' && node.region) {
      // Frostfang water: the mooring is OPEN water — bergs live far out in the
      // field (see makeRealmField), not crowding the stop. Only a couple of low
      // drift-floes ring the berth so the ship never parks against a wall.
      for (let i = 0; i < 2; i++) {
        const f = makeFloe(rng0, 0.6 + rng0() * 0.4);
        const a = rng0() * 6.28, r = 10 + rng0() * 4;
        f.position.set(Math.cos(a) * r, -0.3, Math.sin(a) * r);
        g.add(f);
      }
      g.add(shallowDisc(16, theme.water.shallow));
      g.position.set(node.x, 0, node.z);
      return { group: g, R: 4.4, plateauY: 0 };
    }
    if (theme.id === 'jungle' && node.region) {
      // Verdigris water: vine tangles knot the channels between the isles
      g.add(makeVineMat(rng0, 1.0 + rng0() * 0.5));
      if (node.look === 'islet') {
        const t = mt({ seed, R: 3.6 + rng0() * 1.6, H: 0.9, mode: 'hill',
          palette: { ...pal } });
        const zoff = -2 + rng0() * 4;
        t.mesh.position.set(4.5, 0, zoff);
        g.add(t.mesh);
        const fl = floraFor(theme, rng0, 0.9);
        fl.position.set(4.5, Math.max(0.3, t.heightAt(0.15)), zoff);
        g.add(fl);
      }
      g.add(shallowDisc(16, theme.water.shallow));
      g.position.set(node.x, 0, node.z);
      return { group: g, R: 3.2, plateauY: 0 };
    }
    if (node.look === 'rocks') {
      for (let i = 0; i < 2 + Math.floor(rng0() * 2); i++) {
        const rk = makeRock(rng0, 0.9 + rng0() * 1.1, rng0() < 0.4 ? 0xd8d4c8 : pal.rock);
        const a = rng0() * 6.28;
        rk.position.set(Math.cos(a) * rng0() * 2.4, 0.35, Math.sin(a) * rng0() * 2.4);
        g.add(rk);
      }
      g.add(shallowDisc(15, theme.water.shallow));
    } else if (node.look === 'islet') {
      const style = rng0();
      const t = mt({
        seed, R: 4.6 + rng0() * 2.6,
        H: style < 0.33 ? 0.8 : 1.1,
        mode: style < 0.33 ? 'atoll' : 'hill',
        lobes: style > 0.66 ? 0.42 : 0,
        palette: { ...pal, ...(rng0() < 0.5 ? { sand: 0xf7ecc8 } : {}) },
      });
      g.add(t.mesh);
      g.add(shallowDisc(22, theme.water.shallow));
      const fl = floraFor(theme, rng0, 1.0);
      const fr = style < 0.33 ? 0.3 : 0.15;
      fl.position.set(t.heightAt(fr) ? 0.8 : 0, Math.max(0.3, t.heightAt(fr)), 0);
      g.add(fl);
    } else if (node.look === 'none') {
      const ripple = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.5, 24),
        new THREE.MeshBasicMaterial({ color: 0xeafcff, transparent: true, opacity: 0.28,
          side: THREE.DoubleSide, depthWrite: false }));
      ripple.rotation.x = -Math.PI / 2;
      ripple.position.y = 0.06;
      ripple.name = 'foam';
      g.add(ripple);
    } else {
      const buoy = makeBuoy(rng0);
      buoy.scale.setScalar(1.7);
      g.add(buoy);
    }
    if (node.flotsam) {              // salvage drifting on the lane — grab it for a scroll
      const fl = makeFlotsam(rng0);
      fl.scale.setScalar(1.55);
      fl.position.set((rng0() - 0.5) * 3, 0, (rng0() - 0.5) * 3);
      g.add(fl);
    }
    g.position.set(node.x, 0, node.z);
    return { group: g, R: node.look === 'islet' ? 5.2 : node.look === 'rocks' ? 3.6 : R, plateauY: 0 };
  }

  if (node.type === 'gate') {
    const accent = REALM_INFO[node.region]?.accent ?? '#d9a441';
    // the Meshy stone portal marks the pass; the procedural towers/braziers
    // stand in until it streams and keep the accent-lit flavor beside it
    const fogFree = (o) => {
      if (!o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.fog = false;
    };
    const portal = makeGatePortal(accent, seed, theme?.wall?.rock ?? 0x8a8f98);
    // the pass sits way out at the mountain wall — render it fog-free like the
    // wall itself so the gateway reads clearly instead of washing into haze
    portal.traverse(fogFree);
    g.add(portal);
    // The pass stands ON its node (radius ~500). You BERTH on the isles-facing
    // side of it (see gateBerth), so the arch is always AHEAD of you and you
    // sail OUT through it into the realm — never spawning inside the mouth.
    g.position.set(node.x, 0, node.z);
    // the channel must open RADIALLY (boat sails in from the isles, out to
    // the realm); towers flank it tangentially. π/2 − angle, not −angle,
    // or a tower sits square in the fairway.
    g.rotation.y = Math.PI / 2 - Math.atan2(node.z, node.x);
    return { group: g, R: 13, plateauY: 0 };
  }

  // foot-mode isles are outcrops: rockier palettes, no beach-wet band
  const footPal = foot
    ? { ...pal, grass: pal.sand, grass2: pal.rock, sandWet: pal.sand }
    : pal;

  if (node.type === 'home') {
    terrain = mt({ seed, R, H: 1.7, mode: 'mesa', palette: { ...footPal } });
    g.add(placeDock(terrain, 0.5, 6.0));           // jetty on the real shoreline
    const lh = makeLighthouse();
    lh.scale.setScalar(2.3);                       // a proper landmark tower
    const lhp = terrain.place(3.9, 0.22);          // near the crown, on the surface
    lh.position.set(lhp.x, lhp.y, lhp.z);
    g.add(lh);
    // a little grove ringing Home Port — Meshy palms with a couple of olives
    // and a cypress for variety, all seated on the actual surface
    const homeTrees = [
      ['palm_tree', 2.2, 0.6], ['palm_tree', 3.7, 0.62], ['palm_tree', 5.1, 0.55],
      ['olive_tree', 1.2, 0.5], ['cypress_tree', 0.4, 0.58], ['palm_tree', 4.6, 0.44],
    ];
    for (const [id, a, rr] of homeTrees) {
      const tree = propGroup(id, 0.9 + rng0() * 0.3);
      const pp = terrain.place(a + (rng0() - 0.5) * 0.3, rr);
      tree.position.set(pp.x, pp.y, pp.z);
      g.add(tree);
    }
  } else if (node.type === 'shrine') {
    const hex = DOMAIN_COLORS[node.domain] || '#d9a441';
    terrain = mt({ seed, R, H: 2.2, mode: 'mesa', palette: { ...footPal } });
    const spent = (node.charges ?? 0) <= 0;
    const shrine = makeShrine(hex, theme.id, spent);
    shrine.position.y = terrain.heightAt(0);
    g.add(shrine);
    if (foot) {
      const oasisPalm = makePalm(rng0, 0.9);
      oasisPalm.position.set(R * 0.45, terrain.surfaceY(R * 0.45, R * 0.2), R * 0.2);
      g.add(oasisPalm);
    } else {
      const fl = floraFor(theme, rng0, 1.0);
      fl.position.set(R * 0.45, terrain.surfaceY(R * 0.45, R * 0.2), R * 0.2);
      g.add(fl);
    }
  } else if (node.type === 'puzzle') {
    terrain = mt({ seed, R, H: 2.4, mode: 'mesa',
      palette: { ...footPal, grass: foot ? footPal.grass : 0x6fae8f } });
    const ob = makeObelisk();
    ob.position.y = terrain.heightAt(0);
    if (node.solved) ob.children.forEach((ch) => { if (ch.isPointLight) ch.intensity = 0; });
    g.add(ob);
    const rk = makeRock(rng0, 0.5, 0x8d94b8);
    rk.position.set(-R * 0.4, terrain.surfaceY(-R * 0.4, R * 0.3) + 0.2, R * 0.3);
    g.add(rk);
  } else if (node.type === 'haven') {
    terrain = mt({ seed, R, H: foot ? 1.2 : 1.8, mode: 'flat', palette: { ...footPal } });
    if (foot && theme.id === 'autumn') {
      // a woodland camp: tents in a clearing ringed by amber trees
      const t = makeTents(rng0);
      t.position.y = terrain.heightAt(0.2);
      g.add(t);
      for (let i = 0; i < 3; i++) {
        const tree = floraFor(theme, rng0, 0.9 + rng0() * 0.4);
        const a = rng0() * 6.28;
        const tx = Math.cos(a) * R * 0.55, tz = Math.sin(a) * R * 0.55;
        tree.position.set(tx, terrain.surfaceY(tx, tz), tz);
        g.add(tree);
      }
    } else if (foot) {
      const oasis = makeOasis(rng0, theme);
      oasis.position.y = terrain.heightAt(0.15) + 0.02;
      g.add(oasis);
      const t = makeTents(rng0);
      t.position.set(R * 0.35, terrain.surfaceY(R * 0.35, -R * 0.3), -R * 0.3);
      t.scale.setScalar(0.85);
      g.add(t);
    } else {
      const t = makeTents(rng0);
      t.position.y = terrain.heightAt(0.2);
      g.add(t);
      g.add(placeDock(terrain, Math.PI + (rng0() - 0.5), 4.0));
      const fl = floraFor(theme, rng0, 1.0);
      fl.position.set(-R * 0.5, terrain.surfaceY(-R * 0.5, -R * 0.2), -R * 0.2);
      g.add(fl);
    }
    // the checkpoint light: a permanent azure beam so a haven is
    // unmistakable from anywhere on the water
    const cp = makeCheckpointBeacon();
    cp.position.set(-R * 0.25, terrain.heightAt(0.25), R * 0.25);
    g.add(cp);
  } else if (node.type === 'lair' && foot) {
    // ON FOOT the tyrant doesn't get a dark island — it gets a HOUSE:
    // a sandstone tomb in the Bleached Reach, a mossy barrow in the Vale
    terrain = mt({ seed, R, H: 1.2, mode: 'flat', palette: { ...footPal } });
    // Meshy boss-den model (falls back to nothing until loaded; the relic
    // beacon + totem FX below still mark the lair)
    const isTomb = theme.id === 'desert';
    const den = propGroup(isTomb ? 'tomb' : 'barrow', isTomb ? 3.9 : 3.38);  // tomb 150% / barrow 130%
    den.position.y = terrain.heightAt(0.1);
    den.rotation.y = Math.atan2(-node.x, -node.z) + (isTomb ? Math.PI : 0);  // tomb turned 180°
    g.add(den);
    const beacon = makeRelicBeacon();
    beacon.position.set(-R * 0.52, terrain.surfaceY(-R * 0.52, R * 0.34), R * 0.34);
    g.add(beacon);
    if (theme.id === 'autumn') {
      // the maze's lodestar: a golden pillar over the barrow, visible
      // through the fog from every corner of the Vale
      const lode = makeBarrowBeacon();
      lode.position.y = terrain.heightAt(0.1);
      g.add(lode);
    }
    if (node.monster) {
      const totem = makeMonsterTotem(rng0, node.monster);
      totem.position.set(R * 0.5, terrain.surfaceY(R * 0.5, R * 0.2) + 0.3, R * 0.2);
      g.add(totem);
    }
  } else if (node.type === 'monster' || node.type === 'lair') {
    const dark = node.type === 'lair';
    // the jungle tyrant gets a sunken stone DUNGEON on a flatter isle (not the
    // basalt spike the other sail lairs use) so the temple sits and reads
    const jungleLair = dark && theme.id === 'jungle';
    // the ice tyrant gets a frozen TEMPLE set-piece on a flat snowy mesa (like
    // the jungle dungeon) so the stepped base seats and the temple reads
    const iceLair = dark && theme.id === 'ice';
    const flatLair = jungleLair || iceLair;
    terrain = mt({ seed, R, H: flatLair ? 1.6 : (dark ? 3.6 : 2.6),
      mode: flatLair ? 'mesa' : 'peak',
      palette: { ...footPal, ...(dark && !flatLair ? { rock: COL.basalt } : {}) } });
    if (node.type === 'lair') {
      const accent = REALM_INFO[node.region]?.accent ?? '#ff5030';
      if (jungleLair) {
        const den = propGroup('jungle_dungeon', 2.6);
        den.position.y = terrain.heightAt(0.08);
        den.rotation.y = Math.atan2(-node.x, -node.z);
        g.add(den);
      } else if (iceLair) {
        const den = glbProp('ice_temple', { h: 9.0,
          ry: Math.atan2(-node.x, -node.z) });   // frozen temple faces the approach
        den.position.y = terrain.heightAt(0.08);
        g.add(den);
      } else {
        const altar = makeLairAltar(accent, rng0);
        altar.position.set(R * 0.1, terrain.heightAt(0.25) + 0.2, 0);
        g.add(altar);
      }
      const beacon = makeRelicBeacon();
      beacon.position.set(-R * 0.3, terrain.heightAt(0.35), -R * 0.25);
      g.add(beacon);
    }
    if (node.monster) {
      const totem = makeMonsterTotem(rng0, node.monster);
      totem.position.set(R * 0.1, terrain.heightAt(0.25) + 0.3, 0);
      g.add(totem);
    } else if (node.type === 'monster') {
      // calm hunting grounds: bone-stake warning that ambushes happen here
      const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 2.4, 6), flat(COL.woodDark));
      stake.position.set(R * 0.1, terrain.heightAt(0.25) + 1.1, 0);
      const skull = new THREE.Mesh(displace(new THREE.SphereGeometry(0.34, 8, 6), 0.07, seed + 9),
        flat(COL.bone));
      skull.position.set(R * 0.1, terrain.heightAt(0.25) + 2.4, 0);
      g.add(stake, skull);
      for (const side of [-1, 1]) {
        const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 5), flat(COL.bone));
        bone.position.set(R * 0.1, terrain.heightAt(0.25) + 1.7, 0.05);
        bone.rotation.z = side * 0.8;
        g.add(bone);
      }
    }
    for (let i = 0; i < 3; i++) {
      const rk = makeRock(rng0, 0.4 + rng0() * 0.4, dark ? COL.basalt : pal.rock);
      const a = rng0() * 6.28;
      rk.position.set(Math.cos(a) * R * 0.7, terrain.heightAt(0.7) + 0.15, Math.sin(a) * R * 0.7);
      g.add(rk);
    }
  } else if (node.type === 'pharos') {
    terrain = mt({ seed, R, H: 3.0, mode: 'mesa',
      palette: { grass: 0xdfd9c6, grass2: 0xcfc7b2, sand: 0xf6efdc, rock: 0xe8e2d2 } });
    const ph = makePharos();
    ph.position.y = terrain.heightAt(0);
    g.add(ph);
    for (const a of [0.6, 1.9, 3.2, 4.5, 5.8]) {
      const c = makeColumn(1.6, 0.14);
      c.position.set(Math.cos(a) * R * 0.72, terrain.heightAt(0.72), Math.sin(a) * R * 0.72);
      g.add(c);
    }
  } else if (node.type === 'shop') {
    terrain = mt({ seed, R, H: 1.6, mode: 'flat', palette: { ...footPal } });
    const stall = makeMarket(rng0, Math.PI);       // porch faces the dock/arrival
    const sp = terrain.place(Math.PI / 2, 0.1);    // planted in the middle of the isle
    stall.position.set(sp.x, sp.y, sp.z);
    g.add(stall);
    if (!foot) g.add(placeDock(terrain, -Math.PI / 2 + (rng0() - 0.5) * 0.5, 4.6));
    const fa = 2.2 + rng0();
    const fp = terrain.place(fa, 0.5);
    const fl = floraFor(theme, rng0, 1.0);
    fl.position.set(fp.x, fp.y, fp.z);
    g.add(fl);
  } else {
    terrain = mt({ seed, R, H: 2.0, mode: 'hill', palette: { ...footPal } });
  }

  // the home port is hand-composed (dock, tower, palms) — no random set pieces
  if (node.type !== 'pharos' && node.type !== 'home') dressIsland(g, rng0, theme, R, terrain);

  // In the Amber Vale the POIs stand DIRECTLY on the shared forest floor — no
  // raised pad at all, so nothing floats and nothing z-fights the ground.
  if (!flatFoot) g.add(terrain.mesh);
  if (!flatFoot) addSkirt(R);          // no beach/leaf skirt around a flush pad
  g.position.set(node.x, 0, node.z);
  return { group: g, R, plateauY: terrain.heightAt(0) };
}

/* ── ships (ported verbatim from legacy — it's good) ────────────────────── */
function sailTexture(colorHex) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f6efdc';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = colorHex;
  for (let i = 0; i < 4; i++) ctx.fillRect(0, 6 + i * 16, 64, 7);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeShip(colorHex) {
  /* A little Aegean galley, lofted from cross-sections: swept bow and
     stern posts, bronze ram, painted rail, square sail on a yard,
     rigging, steering oars, and the classic eye at the bow. */
  const g = new THREE.Group();
  const accent = new THREE.Color(colorHex);

  // hull loft — stations stern → bow: [x, halfWidth, railY, keelY]
  const ST = [
    [-1.70, 0.06, 0.86, 0.42],
    [-1.52, 0.30, 0.74, 0.16],
    [-1.00, 0.50, 0.62, 0.03],
    [-0.30, 0.58, 0.56, 0.00],
    [ 0.40, 0.57, 0.56, 0.00],
    [ 1.05, 0.48, 0.60, 0.03],
    [ 1.55, 0.26, 0.72, 0.14],
    [ 1.82, 0.05, 0.88, 0.40],
  ];
  const ring = (st) => {
    const [x, w, ry, ky] = st;
    const my = ky + (ry - ky) * 0.45;
    return [
      [x, ry, w], [x, my, w * 0.92], [x, ky + 0.04, w * 0.42], [x, ky - 0.05, 0],
      [x, ky + 0.04, -w * 0.42], [x, my, -w * 0.92], [x, ry, -w],
    ];
  };
  const rings = ST.map(ring);
  const pos = [];
  const quad = (a, b, c, d) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let j = 0; j < r0.length - 1; j++) {
      quad(r0[j], r1[j], r1[j + 1], r0[j + 1]);
    }
    quad(r0[r0.length - 1], r1[r1.length - 1], r1[0], r0[0]);
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hullGeo.computeVertexNormals();
  // DoubleSide so the interior walls render — otherwise the sea shows through
  // the culled inner faces and looks like water sloshing inside the boat
  const hull = new THREE.Mesh(hullGeo, flat(COL.wood, { side: THREE.DoubleSide }));
  hull.castShadow = true;
  g.add(hull);

  // a planked deck lofted across the hull's interior, so you look down onto
  // boards — never the water plane below
  const deckPos = [];
  const dq = (a, b, c, d) => { deckPos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  const DY = 0.5;
  for (let i = 0; i < ST.length - 1; i++) {
    const [x0, w0] = ST[i], [x1, w1] = ST[i + 1];
    const iw0 = w0 * 0.9, iw1 = w1 * 0.9;
    dq([x0, DY, iw0], [x1, DY, iw1], [x1, DY, -iw1], [x0, DY, -iw0]);
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckPos, 3));
  deckGeo.computeVertexNormals();
  const deck = new THREE.Mesh(deckGeo,
    flat(COL.woodDark, { side: THREE.DoubleSide }));
  deck.receiveShadow = true;
  g.add(deck);

  for (const side of [-1, 1]) {
    const railPts = ST.map(([x, w, ry]) => new THREE.Vector3(x, ry + 0.015, side * w));
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 24, 0.045, 5),
      flat(accent));
    g.add(rail);
  }

  // (no curved bow/stern prow ornaments — they read as floating hooks above
  // the rail no matter how they're seated; the swept hull tips stand on their own)

  // (no bronze ram — anything forward of the stem reads as floating in water)

  // mast planted through the deck into the hull (base y≈0.2), top unchanged at ~3.0
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2.8, 7), flat(COL.woodDark));
  mast.position.set(0.05, 1.6, 0);
  mast.castShadow = true;
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 6), flat(COL.woodDark));
  yard.rotation.x = Math.PI / 2;
  yard.position.set(0.05, 2.72, 0);
  g.add(mast, yard);

  const sailGeo = new THREE.PlaneGeometry(1.5, 1.5, 8, 8);
  {
    const p = sailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const fx = p.getX(i) / 1.5 + 0.5, fy = p.getY(i) / 1.5 + 0.5;
      const belly = Math.sin(fx * Math.PI) * (0.42 - fy * 0.22);
      p.setZ(i, belly);
      p.setX(i, p.getX(i) * (0.82 + fy * 0.18));
    }
    sailGeo.computeVertexNormals();
  }
  const sail = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({
    map: sailTexture(colorHex), side: THREE.DoubleSide, flatShading: true }));
  sail.rotation.y = Math.PI / 2;
  sail.position.set(0.05, 1.92, 0);
  sail.castShadow = true;
  g.add(sail);

  const line = (from, to) => {
    const d = to.clone().sub(from);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, d.length(), 3), flat(0x5a4a33));
    m.position.copy(from).add(d.multiplyScalar(0.5));
    m.lookAt(to);
    m.rotateX(Math.PI / 2);
    return m;
  };
  const masthead = new THREE.Vector3(0.05, 2.95, 0);
  g.add(line(masthead, new THREE.Vector3(1.82, 0.9, 0)));
  g.add(line(masthead, new THREE.Vector3(-1.68, 0.9, 0)));
  g.add(line(new THREE.Vector3(0.05, 2.72, 0.85), new THREE.Vector3(-0.6, 0.6, 0.5)));
  g.add(line(new THREE.Vector3(0.05, 2.72, -0.85), new THREE.Vector3(-0.6, 0.6, -0.5)));

  // steering oars slung over the stern quarters: the loom rests up at the
  // rail, the blade rakes aft and down alongside the hull — never through it
  for (const side of [-1, 1]) {
    const oar = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 1.15, 5), flat(COL.woodDark));
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.42, 0.16), flat(COL.woodDark));
    blade.position.y = -0.66;
    oar.add(shaft, blade);
    oar.position.set(-1.5, 0.78, side * 0.34);
    oar.rotation.x = side * 0.3;       // splay the blade a touch outboard
    oar.rotation.z = -1.02;            // rake aft: loom high-forward, blade low-aft
    g.add(oar);
  }

  const pennant = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18),
    flat(accent, { side: THREE.DoubleSide }));
  pennant.position.set(0.32, 3.05, 0);
  pennant.name = 'pennant';
  g.add(pennant);
  return g;
}

/* floating name tag above a captain's ship — must read at a glance */
export function nameSprite(name, colorHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 30px Georgia, serif';
  const w = Math.min(244, ctx.measureText(name).width + 30);
  ctx.fillStyle = 'rgba(22,17,30,0.78)';
  ctx.beginPath(); ctx.roundRect(128 - w / 2, 8, w, 48, 14); ctx.fill();
  ctx.strokeStyle = colorHex; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#f6efdc';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, fog: false, depthTest: false }));
  sp.scale.set(5.6, 1.4, 1);
  sp.position.y = 4.7;
  sp.renderOrder = 8;
  sp.name = 'nametag';
  return sp;
}

/* ── ambient particles: snow / leaves / motes / dust ────────────────────── */
let _leafTex = null;
function leafTexture() {
  if (_leafTex) return _leafTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.translate(32, 32);
  ctx.rotate(0.6);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 20, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-20, 0); ctx.lineTo(20, 0); ctx.stroke();
  _leafTex = new THREE.CanvasTexture(c);
  return _leafTex;
}

const PARTICLE_DEFS = {
  snow:   { size: 1.0, opacity: 0.9,  fall: 3.2, sway: 2.2, additive: false,
            tex: softDiscTexture, tones: [0xffffff, 0xeaf4fb, 0xdcecf6] },
  leaves: { size: 1.3, opacity: 0.95, fall: 2.2, sway: 5.0, additive: false,
            tex: leafTexture, tones: [0xd07828, 0xb44b2a, 0xe0a030, 0x9c4f22] },
  motes:  { size: 0.65, opacity: 0.55, fall: -0.7, sway: 3.0, additive: true,
            tex: softDiscTexture, tones: [0xfff2b8, 0xd8f0c0, 0xffe9dc] },
  dust:   { size: 1.7, opacity: 0.22, fall: 0.5, sway: 14.0, additive: false,
            tex: softDiscTexture, tones: [0xf0dfae, 0xe3cb92, 0xd9bd85] },
};

export function makeParticles(kind) {
  const def = PARTICLE_DEFS[kind] || PARTICLE_DEFS.snow;
  const N = 200, RAD = 180, TOP = 60;
  const rng = mulberry32(hashStr('particles:' + kind));

  const posArr = new Float32Array(N * 3);
  const colArr = new Float32Array(N * 3);
  const bx = new Float32Array(N), bz = new Float32Array(N), by = new Float32Array(N);
  const ph = new Float32Array(N), spd = new Float32Array(N);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const a = rng() * 6.28, r = Math.sqrt(rng()) * RAD;
    bx[i] = Math.cos(a) * r;
    bz[i] = Math.sin(a) * r;
    by[i] = rng() * TOP;
    ph[i] = rng() * 6.28;
    spd[i] = 0.7 + rng() * 0.6;
    c.set(def.tones[Math.floor(rng() * def.tones.length)]);
    colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    posArr[i * 3] = bx[i]; posArr[i * 3 + 1] = by[i]; posArr[i * 3 + 2] = bz[i];
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(posArr, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

  const mat = new THREE.PointsMaterial({
    size: def.size, map: def.tex(), transparent: true, opacity: def.opacity,
    vertexColors: true, depthWrite: false, sizeAttenuation: true,
    blending: def.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = 'particles:' + kind;

  const fall = def.fall, sway = def.sway;
  function update(t) {
    for (let i = 0; i < N; i++) {
      let y = (by[i] - t * fall * spd[i]) % TOP;
      if (y < 0) y += TOP;
      posArr[i * 3]     = bx[i] + Math.sin(t * 0.5 * spd[i] + ph[i]) * sway;
      posArr[i * 3 + 1] = y;
      posArr[i * 3 + 2] = bz[i] + Math.cos(t * 0.4 * spd[i] + ph[i] * 1.7) * sway * 0.7;
    }
    posAttr.needsUpdate = true;
  }
  return { points, update };
}

/* ── battle diorama backdrops — the game's showpiece view ───────────────── */
function dioramaWaterDisc(theme, R = 36) {
  // radial vertex-colored disc: shallow sparkle near center, deep at rim
  const geo = new THREE.CircleGeometry(R, 40, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const deep = new THREE.Color(theme.water.deep);
  const shallow = new THREE.Color(theme.water.shallow);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i)) / R;
    c.copy(shallow).lerp(deep, Math.min(1, r * 1.25));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.1 }));
  m.position.y = -0.08;
  m.receiveShadow = true;
  return m;
}

function dioramaSandDisc(theme, R = 36) {
  const geo = new THREE.CircleGeometry(R, 40);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const sand = new THREE.Color(theme.palette.sand);
  const dark = new THREE.Color(theme.palette.grass2 ?? 0xa8905a);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, Math.sin(x * 0.22 + z * 0.3) * 0.25 + Math.sin(z * 0.12) * 0.2);
    const stripe = 0.5 + 0.5 * Math.sin(x * 0.5 + z * 0.8);
    c.copy(dark).lerp(sand, 0.5 + stripe * 0.5);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1 }));
  m.position.y = -0.08;
  m.receiveShadow = true;
  return m;
}

function hazePlane(hex, w, h, opacity, x = 0, y = 0, z = 0) {
  // soft radial falloff — an additive plane with hard edges reads as a
  // white band across the sky; the disc texture melts it into the air
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: softDiscTexture(), color: hex,
      transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false }));
  m.position.set(x, y, z);
  return m;
}

export function makeBattleBackdrop(theme) {
  const g = new THREE.Group();
  const rng = mulberry32(hashStr('battle:' + theme.id));
  const id = theme.id;

  // floor — desert and the Pharos arena stand on solid ground, not water
  g.add(id === 'desert' || id === 'pharos'
    ? dioramaSandDisc(theme) : dioramaWaterDisc(theme));

  // horizon rim: broken ring of dark rock so the disc never ends in nothing
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rng() * 0.3;
    if (Math.cos(a) < -0.55) continue;               // keep the camera side open
    const rk = makeRock(rng, 1.6 + rng() * 2.4, theme.wall.rock);
    rk.position.set(Math.cos(a) * (30 + rng() * 4), -0.5, Math.sin(a) * (30 + rng() * 4));
    g.add(rk);
  }

  // sun / sky glow behind the enemies — a soft accent, never a blowout
  const sun = glowSprite(theme.sun.color, id === 'desert' ? 18 : 14);
  sun.material.opacity = id === 'ice' ? 0.22 : 0.3;
  sun.material.fog = false;
  sun.position.set(44, id === 'ice' || id === 'autumn' ? 14 : 22, -30);
  g.add(sun);

  if (id === 'hub') {
    // marble ruin shelf behind the foe, olives and cypress framing
    const shelf = makeRock(rng, 3.4, 0xd8d4c8);
    shelf.position.set(20, -0.8, -10);
    g.add(shelf);
    const heights = [1.9, 2.3, 1.4];
    heights.forEach((h, i) => {
      const col = makeColumn(h, 0.22);
      col.position.set(18 + i * 3.2, 1.2, -9 - i * 1.6);
      col.rotation.z = (rng() - 0.5) * 0.12;
      g.add(col);
    });
    const arch = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 0.7), flat(COL.marbleShade));
    arch.position.set(19.6, 3.6, -9.8);
    g.add(arch);
    for (const [x, z, s] of [[16, 10, 1.2], [24, 4, 1.0], [-16, -14, 1.1]]) {
      const isle = makeRock(rng, 2.2 * s, theme.palette.rock);
      isle.position.set(x, -0.6, z);
      g.add(isle);
      const fl = rng() < 0.5 ? makeCypress(rng, s) : makeOlive(rng, s);
      fl.position.set(x, 0.7 * s, z);
      g.add(fl);
    }
    const palm = makePalm(rng, 1.4);
    palm.position.set(-8, 0, 21);
    g.add(palm);
  } else if (id === 'ice') {
    // drift ice underfoot, two great bergs on the horizon
    for (let i = 0; i < 8; i++) {
      const a = rng() * 6.28, r = 12 + rng() * 18;
      const floe = new THREE.Mesh(
        displace(new THREE.CylinderGeometry(1 + rng() * 2.2, 1.2 + rng() * 2.2, 0.4, 7), 0.3, seedFrom(rng)),
        flat(0xe8f2f8));
      floe.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
      g.add(floe);
    }
    for (const [x, z, s] of [[26, -8, 1], [20, 14, 0.7]]) {
      const berg = new THREE.Mesh(
        displace(new THREE.ConeGeometry(4.5 * s, 11 * s, 6, 2), 1.6 * s, seedFrom(rng)),
        flat(0xdcecf6, { emissive: 0x7fd4ef, emissiveIntensity: 0.08 }));
      berg.position.set(x, 3.5 * s, z);
      berg.castShadow = true;
      g.add(berg);
    }
    const floePine = makePine(rng, 1.2);
    floePine.position.set(-15, 0, -12);
    g.add(floePine);
    g.add(hazePlane(0xbfe0f0, 70, 16, 0.1, 20, 6, -22));
  } else if (id === 'desert') {
    // hoodoos and saguaro under a hammering sun; old bones half-buried
    for (const [x, z, s] of [[22, -10, 1.6], [26, 6, 1.2], [-18, -13, 1.3]]) {
      const spire = makeSandSpire(rng, s * 2.2);
      spire.position.set(x, -0.3, z);
      g.add(spire);
    }
    for (const [x, z] of [[15, 12], [-10, 19], [19, 2]]) {
      const cac = makeCactus(rng, 1.5);
      cac.position.set(x, 0, z);
      g.add(cac);
    }
    const ribs = makeRibs(rng);
    ribs.scale.setScalar(1.5);
    ribs.position.set(6, 0, -16);
    g.add(ribs);
    g.add(hazePlane(0xf9e3ae, 80, 12, 0.12, 24, 4, -20));
  } else if (id === 'jungle') {
    // canopy walls close in on both flanks; light shafts rake the water
    for (let i = 0; i < 7; i++) {
      const a = -0.9 + (i / 6) * 1.8;                 // arc behind the foe
      const t = makeJungleTree(rng, 2.2 + rng() * 1.4);
      t.position.set(Math.cos(a) * 26 + 4, -0.4, Math.sin(a) * 26);
      g.add(t);
    }
    for (const [x, z, s] of [[-16, -14, 2.4], [-27, 17, 2.0]]) {
      const t = makeJungleTree(rng, s);
      t.position.set(x, -0.3, z);
      g.add(t);
    }
    for (let i = 0; i < 3; i++) {
      const shaft = hazePlane(0xfff2c0, 3.5, 26, 0.14);
      shaft.position.set(8 + i * 6, 12, -6 + i * 5);
      shaft.rotation.set(0.15, 0.5, -0.35);
      g.add(shaft);
    }
    const stone = makeRock(rng, 2.2, 0x5a6b4a);
    stone.position.set(14, -0.6, 13);
    g.add(stone);
  } else if (id === 'autumn') {
    // amber groves on rocky banks, low gold sun, a leaf-strewn bronze mirror
    for (const [x, z, s] of [[20, -10, 1.8], [24, 6, 1.4], [16, 14, 1.2], [-16, -12, 1.5], [-27, 17, 1.2]]) {
      const bank = makeRock(rng, 1.8 * s, theme.palette.rock);
      bank.position.set(x, -0.7, z);
      g.add(bank);
      const tree = makeAutumnTree(rng, 1.6 * s);
      tree.position.set(x, 0.4 * s, z);
      g.add(tree);
    }
    // a few floating leaves caught on the water
    for (let i = 0; i < 10; i++) {
      const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.16 + rng() * 0.1, 6),
        flat([0xd07828, 0xb44b2a, 0xe0a030][i % 3]));
      leaf.rotation.x = -Math.PI / 2;
      const a = rng() * 6.28, r = 4 + rng() * 20;
      leaf.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
      g.add(leaf);
    }
    g.add(hazePlane(0xf8ce74, 70, 14, 0.14, 26, 6, -16));
  } else if (id === 'pharos') {
    // the crown of the lighthouse: a ring of shattered parapet columns, iron
    // braziers throwing the only warm light, the great beacon smouldering red
    // high behind the foe, and a storm pressing black against the rail.
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + rng() * 0.12;
      if (Math.cos(a) < -0.5) continue;              // leave the camera side open
      const col = makeColumn(2.2 + rng() * 2.8, 0.26);
      col.traverse((o) => { if (o.isMesh) o.material = flat(0x24242c, { roughness: 0.9 }); });
      col.position.set(Math.cos(a) * 22, 0.4, Math.sin(a) * 22);
      col.rotation.z = (rng() - 0.5) * 0.14;
      g.add(col);
    }
    for (const [x, z] of [[10, -12], [20, 2], [-12, -12], [6, 16]]) {
      const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.72, 1.8, 6), flat(0x17171d));
      stub.position.set(x, 0.9, z);
      stub.castShadow = true;
      g.add(stub);
      const fire = glowSprite(0xff7a2a, 3.4);
      fire.material.opacity = 0.9; fire.material.fog = false;
      fire.position.set(x, 2.5, z);
      g.add(fire);
      const core = glowSprite(0xffd25a, 1.5);
      core.material.opacity = 0.85; core.material.fog = false;
      core.position.set(x, 2.3, z);
      g.add(core);
    }
    const beacon = glowSprite(0xff5626, 26);
    beacon.material.opacity = 0.5; beacon.material.fog = false;
    beacon.position.set(30, 22, -34);
    g.add(beacon);
    for (const [x, z, s] of [[24, -8, 1.4], [-18, -14, 1.2]]) {
      const rk = makeRock(rng, 2.0 * s, 0x1e1f26);
      rk.position.set(x, -0.5, z);
      g.add(rk);
    }
    g.add(hazePlane(0x5a1020, 80, 20, 0.22, 20, 8, -24));
    g.add(hazePlane(0x1c1030, 92, 28, 0.3, 0, 16, -30));
  }

  // Meshy prop dressing: a handful of the good GLB props scattered on the
  // far banks so battles share the realms' set dressing. Water themes float
  // the floatable props and stand the rest on rock shelves; desert sits
  // everything straight on the sand.
  const BATTLE_PROPS = {
    hub: ['ruined_column', 'amphora_pile', 'broken_statue', 'olive_tree', 'cypress_tree'],
    ice: ['iceberg', 'ice_shard', 'pine_snow', 'crystal_cluster'],
    desert: ['ruined_arch', 'bone_pile', 'cactus', 'sarcophagus'],
    jungle: ['jungle_tree', 'mossy_idol', 'fern_cluster', 'mushroom_cluster', 'ruined_arch'],
    autumn: ['autumn_tree', 'dead_tree', 'mushroom_cluster', 'campfire', 'boulder'],
    pharos: ['ruined_column', 'broken_statue', 'sarcophagus', 'bone_pile'],
  };
  const FLOATS = new Set(['iceberg', 'ice_shard', 'lily_pads', 'driftwood']);
  const picks = BATTLE_PROPS[id] || BATTLE_PROPS.hub;
  const n = picks.length + 2;                        // every pick shows at least once
  for (let i = 0; i < n; i++) {
    // spread along the arc BEHIND the foe; ±1.35 keeps the arc's ends from
    // looming into the camera's flanks (the camera sits past ±1.93 on -x)
    const a = -1.35 + (i / (n - 1)) * 2.7 + (rng() - 0.5) * 0.24;
    const r = 17 + rng() * 10;
    const pid = picks[i % picks.length];
    const p = propGroup(pid, 0.9 + rng() * 0.5);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (id === 'desert' || id === 'pharos' || FLOATS.has(pid)) {
      p.position.set(x, 0, z);
    } else {
      const base = makeRock(rng, 1.3 + rng() * 0.7, theme.palette.rock);
      base.position.set(x, -0.7, z);
      g.add(base);
      p.position.set(x, 0.55, z);
    }
    g.add(p);
  }

  return g;
}

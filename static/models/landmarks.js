/*
 * models/landmarks.js — the procedural landmarks players see most.
 *
 * Every function returns a THREE.Group at the origin, feet on y = 0, built
 * from merged, shared-material parts (see models/kit.js) so a landmark costs
 * a handful of draw calls. islands.js mounts them through small hooks where
 * the old GLB / primitive builders used to be.
 *
 *   makePharos()                    the great lighthouse (≈31 u) with its lit
 *                                   lantern, sweeping beams, named FX objects
 *                                   'pharosfire' and 'pharosgate' (scene.js)
 *   dressPharosIsle(g, terrain, R)  rocky shore, harbour mole, colonnade
 *   makeShrineTemple(hex, themeId, spent, seed)
 *                                   per-realm temple (tholos / prostyle), the
 *                                   domain-coloured flame; `spent` = embers
 *   makePuzzleSpire({solved, seed}) obelisk + slowly turning armillary over a
 *                                   labyrinth mosaic
 *   makeCampHaven({kind, seed})     harbour camp: awnings, boats, nets, fire
 *   makeCheckpointBeacon()          the haven's azure lamp ('checkpoint')
 *   makeMarketSquare(ry, {seed})    stalls, awnings, wares, a little stoa
 *   makeHomeTown(terrain, R, seed)  Cycladic harbour town + lighthouse
 *   makeLighthouse()                the white harbour light (home port)
 *   makeLairAltar(accentHex, seed)  the boss trial altar (sail lairs)
 *   makeRelicBeacon()               the relic urn ('beacon', spun by scene.js)
 *   makeGatePortal(accentHex, seed, rockHex, realm)
 *                                   the monumental realm gateway
 *
 * Budgets: ≤ ~8k triangles per landmark, merged per material; no new point
 * lights except the Pharos lantern and one per realm gate (fire is emissive
 * HDR + bloom).
 */
import {
  THREE, cached, mat, tex, Parts, M, paint, lathe, box, tube, blob, rockGeometry,
  flame, glowSprite, animate, onShore, smooth, mulberry32, facet,
} from './kit.js';
import { hashStr } from '../util.js';
import { makeFishingBoat, makeCrate, makeAmphora, makeBarrelGeo } from './props.js';
import { propGroup } from '../props.js';

/* ── shared architecture ─────────────────────────────────────────────────── */

/* the classical column, unit height: torus base, a shaft with entasis, neck
   ring, echinus and a square abacus. 16-sided; the flutes are a bump map on
   the column material (cheap, and they catch the raking light). */
function columnGeo() {
  return cached('geo:column', () => {
    const g = lathe([
      [0.122, 0.0], [0.122, 0.022], [0.122, 0.022], [0.112, 0.03], [0.116, 0.046],
      [0.094, 0.062], [0.088, 0.072], [0.084, 0.42], [0.075, 0.86], [0.072, 0.9],
      [0.072, 0.9], [0.081, 0.908], [0.074, 0.918], [0.104, 0.948], [0.114, 0.962],
    ], 16);
    const ab = box(0.26, 0.04, 0.26, 0.008, 1);
    ab.translate(0, 0.982, 0);
    const p = new Parts();
    p.add(g, null); p.add(ab, null);
    const out = p.geometry();
    out.deleteAttribute('color');
    // uv: around → flutes, along → height
    const pos = out.attributes.position, uv = out.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i)) / (Math.PI * 2) + 0.5;
      uv.setXY(i, a, pos.getY(i));
    }
    out.userData.shared = true;
    return out;
  });
}

function fluteTexture() {
  return cached('tex:flute', () => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 4;
    const c = cv.getContext('2d');
    for (let x = 0; x < 256; x++) {
      const k = Math.abs(Math.sin((x / 256) * Math.PI * 20));
      const v = Math.round(60 + 195 * Math.pow(k, 0.45));
      c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(x, 0, 1, 4);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
}

/* column material: vertex colour (per instance tint) × marble grain + flutes */
function columnMat() {
  return cached('mat:column', () => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0,
    bumpMap: fluteTexture(), bumpScale: 1.6 }));
}

/* push a column (height h, centre x/z, base y) into a parts list */
function addColumn(parts, x, y, z, h, col, broken = 0) {
  const g = columnGeo().clone();
  if (broken > 0) {
    // snapped shaft: drop everything above the break, tilt the break plane
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const top = 1 - broken;
      if (p.getY(i) > top) p.setY(i, top + p.getX(i) * 0.6 + p.getZ(i) * 0.25);
    }
    g.computeVertexNormals();
  }
  const r = h * 1.0;
  parts.add(g, col, M(x, y, z, 0, r, h, r));
}

/* a pediment gable: triangular prism facing ±z, width w, height h, depth d */
function gable(w, h, d) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g.toNonIndexed();
}

/* a pitched tiled roof over a w × d rectangle (ridge along z), eaves at y */
function pitchedRoof(w, d, rise, over = 0.25) {
  const half = w / 2 + over;
  const slope = Math.hypot(half, rise);
  const parts = [];
  for (const side of [-1, 1]) {
    const g = new THREE.BoxGeometry(slope, 0.12, d + over * 2);
    // uv: u across the slope (tiles), v along the ridge
    const ang = Math.atan2(rise, half);
    g.rotateZ(side * -ang);
    g.translate(side * half / 2, rise / 2, 0);
    // pantile channels run from ridge to eave: u along the ridge, v down-slope
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getZ(i) * 0.55, (rise - p.getY(i)) * 1.4);
    parts.push(g);
  }
  return parts;
}

/* tholos-style conical roof */
function coneRoof(r0, r1, h) {
  return lathe([[r0 + 0.12, -0.08], [r0 + 0.12, 0], [r0, 0.05], [r1 * 0.6 + r0 * 0.4, h * 0.55], [r1, h * 0.92], [0.0, h]], 24);
}

/* ── the flame on an altar / tripod (domain colour) ─────────────────────── */
function bronzeTripod(parts, x, y, z, s = 1) {
  // bowl
  parts.add(lathe([[0.0, 0.0], [0.14, 0.0], [0.32, 0.12], [0.42, 0.3], [0.44, 0.34], [0.4, 0.34], [0.0, 0.28]], 16),
    0xb98a46, M(x, y + 0.9 * s, z, 0, s));
  // three legs
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    parts.add(tube([new THREE.Vector3(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5),
      new THREE.Vector3(Math.cos(a) * 0.32, 0.55, Math.sin(a) * 0.32),
      new THREE.Vector3(Math.cos(a) * 0.36, 0.98, Math.sin(a) * 0.36)], 0.035, 0.03, 6, 5),
    0x9a7038, M(x, y, z, 0, s));
  }
}

/* ═════════════════════════════════════════════════════════════════════════
 *  SHRINE — per realm, per domain
 * ═══════════════════════════════════════════════════════════════════════ */
const SHRINE_PAL = {
  hub:    { stone: 0xf2ede2, col: 0xf6f2ea, roof: 0xb4613c, trim: 0xd9cfb6, top: null, kind: null },
  ice:    { stone: 0xdde8f1, col: 0xeef4fa, roof: 0x8fa6ba, trim: 0xbdd0df, top: 0xffffff, kind: 'prostyle' },
  desert: { stone: 0xdcb784, col: 0xe6c895, roof: 0xb7774a, trim: 0xa3633a, top: 0xead2a4, kind: 'prostyle' },
  jungle: { stone: 0xa7ad96, col: 0xb8bda6, roof: 0x5f6e4e, trim: 0x7d8a6a, top: 0x4f7a3a, kind: 'tholos' },
  autumn: { stone: 0xcfc2a8, col: 0xdbd0b8, roof: 0x8a4f32, trim: 0xa98a64, top: 0x9c6a2a, kind: 'prostyle' },
};

export function makeShrineTemple(domainHex, themeId = 'hub', spent = false, seed = 1, form = null) {
  const pal = SHRINE_PAL[themeId] || SHRINE_PAL.hub;
  const rng = mulberry32(seed);
  // the hub's shrines vary by domain: round tholos or porched prostyle
  const kind = form || pal.kind || ((hashStr(String(domainHex)) & 1) ? 'tholos' : 'prostyle');
  const g = new THREE.Group();
  const dom = new THREE.Color(domainHex);
  const k = spent ? 0.78 : 1;
  const tone = (hex, j = 0) => {
    const c = new THREE.Color(hex).multiplyScalar(k * (1 + (rng() - 0.5) * j));
    return c;
  };
  // weathering: the realm's cover (snow, moss, sand, leaves) on up-facing faces
  const weather = (base, amt = 0.7) => (x, y, z, nx, ny, nz, c) => {
    c.copy(base);
    const n = Math.sin(x * 3.1 + z * 2.3) * 0.5 + Math.sin(x * 7.7 - y * 5.1 + z * 4.3) * 0.5;
    c.multiplyScalar(0.94 + n * 0.05);
    c.multiplyScalar(0.8 + 0.2 * smooth(0, 0.6, y));               // damp at the foot
    if (pal.top != null && ny > 0.5) c.lerp(new THREE.Color(pal.top), smooth(0.5, 0.95, ny + n * 0.15) * amt);
  };
  const stoneP = new Parts(), colP = new Parts(), roofP = new Parts(), bronzeP = new Parts(), darkP = new Parts();
  const stone = tone(pal.stone), trim = tone(pal.trim);
  const frieze = new THREE.Color(pal.trim).lerp(dom, 0.55).multiplyScalar(k);
  let flameY = 0, flameX = 0, flameZ = 0;

  if (kind === 'tholos') {
    // three circular steps
    const steps = [[3.5, 0.0, 0.24], [3.18, 0.24, 0.22], [2.88, 0.46, 0.22]];
    for (const [r, y, h] of steps) {
      stoneP.add(lathe([[r, y], [r, y + h - 0.03], [r - 0.03, y + h], [r - 0.03, y + h], [0, y + h]], 32),
        weather(stone, 0.6));
    }
    const top = 0.68, H = 3.0, RR = 2.4, N = 10;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + Math.PI / 2 + Math.PI / N;     // a bay opens on +z
      addColumn(colP, Math.cos(a) * RR, top, Math.sin(a) * RR, H, tone(pal.col, 0.04));
    }
    // inner cella drum, a door facing +z
    stoneP.add(lathe([[1.6, top], [1.6, top + H * 0.92], [1.66, top + H * 0.92], [1.66, top + H * 0.97], [0, top + H * 0.97]], 24),
      weather(stone.clone().multiplyScalar(0.94), 0.3));
    darkP.add(box(0.9, 1.9, 0.3, 0.03), 0x241d17, M(0, top + 0.95, 1.52));
    stoneP.add(box(1.2, 0.18, 0.4, 0.04), trim, M(0, top + 2.0, 1.55));
    // entablature ring: architrave, painted frieze band, cornice
    const eY = top + H;
    stoneP.add(lathe([[2.7, eY], [2.7, eY + 0.3], [2.7, eY + 0.3], [2.74, eY + 0.34], [2.74, eY + 0.62],
      [2.74, eY + 0.62], [2.92, eY + 0.68], [2.92, eY + 0.78], [2.0, eY + 0.78], [2.0, eY], [2.7, eY]], 40),
    (x, y, z, nx, ny, nz, c) => { c.copy(y > eY + 0.32 && y < eY + 0.62 && Math.hypot(x, z) > 2.6 ? frieze : stone); });
    // tiled cone roof + bronze finial
    roofP.add(coneRoof(2.95, 0.5, 1.55), (x, y, z, nx, ny, nz, c) => {
      c.copy(tone(pal.roof));
      if (pal.top != null) c.lerp(new THREE.Color(pal.top), smooth(0.55, 0.9, ny) * 0.55);
    }, M(0, eY + 0.78, 0));
    bronzeP.add(lathe([[0.22, 0], [0.14, 0.18], [0.2, 0.32], [0.08, 0.5], [0.12, 0.62], [0.0, 0.9]], 12), 0xc7963f,
      M(0, eY + 0.78 + 1.5, 0));
    // the flame burns on a round altar before the door, in the open bay
    stoneP.add(lathe([[0.62, 0], [0.62, 0.12], [0.5, 0.18], [0.46, 0.72], [0.6, 0.8], [0.6, 0.9], [0.0, 0.9]], 18),
      weather(trim, 0.3), M(0, 0, 4.25));
    bronzeP.add(lathe([[0.0, 0], [0.3, 0], [0.48, 0.14], [0.5, 0.2], [0.0, 0.12]], 16), 0xb98a46, M(0, 0.9, 4.25));
    flameX = 0; flameY = 1.02; flameZ = 4.25;
    g.userData.footR = 4.9;
  } else {
    // stepped stylobate, rectangular; the porch faces +z
    const W = 4.6, D = 6.8;
    for (let i = 0; i < 3; i++) {
      stoneP.add(box(W + 0.9 - i * 0.4, 0.24, D + 0.9 - i * 0.4, 0.04), weather(stone, 0.6), M(0, 0.12 + i * 0.23, 0));
    }
    const top = 0.69, H = 3.0;
    // cella walls behind the porch
    const cz0 = -D / 2 + 0.35, cz1 = D / 2 - 1.95, cw = W - 1.2;
    const wallH = H * 0.96;
    stoneP.add(box(cw, wallH, 0.32, 0.03), weather(stone, 0.25), M(0, top + wallH / 2, cz0));
    for (const s of [-1, 1]) {
      stoneP.add(box(0.32, wallH, cz1 - cz0, 0.03), weather(stone, 0.25), M(s * cw / 2, top + wallH / 2, (cz0 + cz1) / 2));
      stoneP.add(box((cw - 1.0) / 2, wallH, 0.32, 0.03), weather(stone, 0.25), M(s * (cw / 4 + 0.25), top + wallH / 2, cz1));
      // antae (pilasters) ending the side walls
      stoneP.add(box(0.42, wallH, 0.42, 0.03), trim, M(s * cw / 2, top + wallH / 2, cz1 + 0.02));
    }
    stoneP.add(box(1.0, wallH - 2.1, 0.32, 0.02), weather(stone, 0.25), M(0, top + 2.1 + (wallH - 2.1) / 2, cz1));
    darkP.add(box(1.0, 2.1, 0.2), 0x1e1813, M(0, top + 1.05, cz1 - 0.02));
    // four porch columns + two at the back corners
    const xs = [-1.65, -0.55, 0.55, 1.65];
    for (const x of xs) addColumn(colP, x, top, D / 2 - 0.55, H, tone(pal.col, 0.04));
    for (const x of [-1.65, 1.65]) addColumn(colP, x, top, -D / 2 + 0.55, H, tone(pal.col, 0.04));
    // entablature: architrave, painted frieze (triglyph rhythm), cornice
    const eY = top + H;
    stoneP.add(box(W + 0.1, 0.34, D + 0.1, 0.03), stone, M(0, eY + 0.17, 0));
    stoneP.add(box(W + 0.12, 0.3, D + 0.12, 0.02), (x, y, z, nx, ny, nz, c) => {
      const along = Math.abs(nz) > 0.5 ? x : z;
      c.copy(Math.sin(along * 5.2) > 0.35 ? trim.clone().multiplyScalar(0.7) : frieze);
    }, M(0, eY + 0.49, 0));
    stoneP.add(box(W + 0.5, 0.16, D + 0.5, 0.04), weather(stone, 0.5), M(0, eY + 0.72, 0));
    // pediments front and back
    const gw = W + 0.5, gh = 1.05;
    for (const s of [-1, 1]) {
      stoneP.add(gable(gw - 0.25, gh * 0.9, 0.3), weather(stone, 0.2), M(0, eY + 0.8, s * (D / 2 + 0.05)));
      // a domain-coloured disc in the tympanum
      bronzeP.add(lathe([[0.0, 0], [0.24, 0], [0.26, 0.04], [0.0, 0.08]], 14), 0xc9973f,
        M(0, eY + 1.15, s * (D / 2 + 0.22), 0, 1, 1, 1, Math.PI / 2 * s));
      // acroteria
      bronzeP.add(lathe([[0.0, 0], [0.1, 0], [0.16, 0.18], [0.05, 0.3], [0.0, 0.42]], 8), 0xc29245,
        M(0, eY + 0.8 + gh, s * (D / 2 + 0.1)));
    }
    for (const r of pitchedRoof(gw - 0.1, D + 0.2, gh, 0.12)) {
      roofP.add(r, (x, y, z, nx, ny, nz, c) => {
        c.copy(tone(pal.roof));
        c.multiplyScalar(0.92 + 0.08 * Math.sin(z * 7));
        if (pal.top != null) c.lerp(new THREE.Color(pal.top), smooth(0.4, 0.95, ny) * 0.6);
      }, M(0, eY + 0.8, 0));
    }
    // the flame: a bronze tripod on the porch, in front of the door
    bronzeTripod(bronzeP, 0, top, D / 2 - 1.25, 0.95);
    flameX = 0; flameY = top + 1.18; flameZ = D / 2 - 1.25;
    g.userData.footR = 4.2;
    // realm touches
    if (themeId === 'ice') {
      // icicles along the cornice edges
      for (let i = 0; i < 18; i++) {
        const s = i % 2 ? 1 : -1;
        const z = -D / 2 + 0.3 + rng() * (D - 0.6);
        const len = 0.18 + rng() * 0.45;
        stoneP.add(new THREE.ConeGeometry(0.05, len, 5).rotateX(Math.PI), 0xe8f4ff,
          M(s * (W / 2 + 0.24), eY + 0.64 - len / 2, z));
      }
    }
    if (themeId === 'jungle' || themeId === 'autumn') {
      // creepers trailing over the cornice and down a column or two
      const vine = themeId === 'jungle' ? 0x3f6b2c : 0x9a4a22;
      for (let i = 0; i < 4; i++) {
        const s = rng() < 0.5 ? -1 : 1;
        const z = -D / 2 + 0.6 + rng() * (D - 1.2);
        const x = s * (W / 2 + 0.28);
        const len = 1.2 + rng() * 1.6;
        stoneP.add(tube([new THREE.Vector3(x - s * 0.3, eY + 0.82, z), new THREE.Vector3(x, eY + 0.6, z + 0.1),
          new THREE.Vector3(x + s * 0.05, eY + 0.4 - len * 0.5, z - 0.1), new THREE.Vector3(x, eY + 0.2 - len, z + 0.05)],
        0.05, 0.02, 8, 4), vine);
      }
    }
  }

  // assemble
  const meshes = [stoneP.mesh(mat.marble()), colP.mesh(columnMat()), roofP.mesh(mat.tiles()),
    bronzeP.mesh(mat.bronze()), darkP.mesh(mat.plain(), { cast: false })];
  for (const m of meshes) if (m) g.add(m);

  // the oracle's flame in the domain colour — or a few dull embers once spent
  const fl = flame({ w: spent ? 0.38 : 0.78, h: spent ? 0.32 : 1.25, color: domainHex,
    glow: spent ? 0.35 : 1.15, seed, halo: spent ? 0.15 : 0.5 });
  fl.position.set(flameX, flameY, flameZ);
  g.add(fl);
  if (!spent) {
    // a soft domain glow that carries the colour from a distance
    const gl = glowSprite(domainHex, 3.2, 0.35);
    gl.position.set(flameX, flameY + 0.8, flameZ);
    g.add(gl);
  }
  g.userData.kind = kind;
  return g;
}

/* ═════════════════════════════════════════════════════════════════════════
 *  THE PHAROS
 * ═══════════════════════════════════════════════════════════════════════ */

/* a square (or octagonal) tapering tier with flat faces */
function tier(r0, r1, y0, y1, sides = 4) {
  const g = lathe([[r0, y0], [r1, y1]], sides, { phase: Math.PI / sides }).toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/* beam material: additive, soft at its rim (view-angle fade) and along its
   length, so the sweeping beam reads as light in haze, not a plastic cone */
function beamMaterial() {
  return cached('mat:beam', () => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.86, 0.55) }, uK: { value: 0.32 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying float vT;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vT = uv.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uK;
      varying vec3 vN; varying vec3 vV; varying float vT;
      void main() {
        float rim = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
        float along = pow(1.0 - vT, 1.6) * smoothstep(0.0, 0.04, vT);
        gl_FragColor = vec4(uColor * rim * along * uK, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
  }));
}

export function makePharos() {
  const g = new THREE.Group();
  const stoneP = new Parts(), colP = new Parts(), darkP = new Parts(), bronzeP = new Parts();
  const marble = new THREE.Color(0xeee6d4), marbleShade = new THREE.Color(0xd8ccb2);
  const weathered = (base) => (x, y, z, nx, ny, nz, c) => {
    c.copy(base);
    c.multiplyScalar(0.9 + 0.1 * smooth(0, 6, y));                       // sea-stained foot
    c.multiplyScalar(0.96 + 0.04 * Math.sin(y * 2.3 + x * 0.7));
    if (ny > 0.6) c.multiplyScalar(1.04);
  };

  // podium: two broad steps and a front stair up to the door
  stoneP.add(box(16, 0.9, 16, 0.12), weathered(marbleShade), M(0, 0.45, 0));
  stoneP.add(box(13.4, 0.8, 13.4, 0.1), weathered(marble), M(0, 1.3, 0));
  for (let k = 0; k < 3; k++) {
    // podium-1 top (0.9) up to podium-2 top (1.7), in front of the door
    const top = 0.9 + (k + 1) * 0.27, dep = (3 - k) * 0.42;
    stoneP.add(box(4.4, top - 0.85, dep, 0.04), weathered(marbleShade), M(0, 0.85 + (top - 0.85) / 2, 6.7 + dep / 2));
    // ground up to podium-1 (0.9)
    const top0 = (k + 1) * 0.3, dep0 = (3 - k) * 0.42;
    stoneP.add(box(5.2, top0, dep0, 0.04), weathered(marbleShade), M(0, top0 / 2, 8.0 + dep0 / 2));
  }
  const y1 = 1.7;

  // TIER 1 — the square shaft: tapering, corner pilasters, rows of windows
  const t1h = 12.6, r1a = 5.2 * Math.SQRT2, r1b = 4.4 * Math.SQRT2;
  stoneP.add(tier(r1a, r1b, y1, y1 + t1h), weathered(marble));
  const hw = (y) => 5.2 + (4.4 - 5.2) * ((y - y1) / t1h);
  // corner pilasters, plinth and string courses
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = box(0.8, t1h, 0.8, 0.06);
      // taper the pilaster with the wall
      const pos = p.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const yy = pos.getY(i) + t1h / 2 + y1;
        const h = hw(yy) - 0.18;
        pos.setX(i, pos.getX(i) + sx * h);
        pos.setZ(i, pos.getZ(i) + sz * h);
        pos.setY(i, yy);
      }
      stoneP.add(p, weathered(marbleShade));
    }
  }
  stoneP.add(box(11.0, 0.5, 11.0, 0.08), weathered(marbleShade), M(0, y1 + 0.25, 0));
  for (const yy of [y1 + 4.4, y1 + 8.6]) {
    const w = hw(yy) * 2 + 0.3;
    stoneP.add(box(w, 0.28, w, 0.06), marbleShade, M(0, yy, 0));
  }
  // cornice crowning tier 1
  const c1 = y1 + t1h;
  stoneP.add(box(9.6, 0.4, 9.6, 0.08), marbleShade, M(0, c1 + 0.1, 0));
  stoneP.add(box(10.2, 0.3, 10.2, 0.08), marble, M(0, c1 + 0.42, 0));
  // windows: dark slits in deep frames on every face (not on the door bay)
  const lean = Math.atan2(5.2 - 4.4, t1h);
  for (let face = 0; face < 4; face++) {
    const ry = face * Math.PI / 2;
    for (const [yy, xs] of [[y1 + 6.3, [-2.2, 0, 2.2]], [y1 + 10.5, [-1.6, 1.6]], [y1 + 2.6, face === 0 ? [] : [-2.6, 2.6]]]) {
      for (const xx of xs) {
        const d = hw(yy) + 0.02;
        const m = (o) => {
          const v = new THREE.Vector3(xx, yy, d + o).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
          return M(v.x, v.y, v.z, ry, 1, 1, 1, -lean);
        };
        stoneP.add(box(0.95, 1.7, 0.24, 0.04), marbleShade, m(0.02));
        darkP.add(box(0.55, 1.3, 0.1), 0x16120f, m(0.12));
      }
    }
  }

  // TIER 2 — the octagon
  const y2 = c1 + 0.57, t2h = 7.6;
  stoneP.add(tier(3.9, 3.35, y2, y2 + t2h, 8), weathered(marble));
  stoneP.add(facet(lathe([[4.2, y2 - 0.05], [4.2, y2 + 0.3], [3.9, y2 + 0.32]], 8, { phase: Math.PI / 8 })), marbleShade);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8 + Math.PI / 8;
    // a slit window on each face, alternate heights
    const yy = y2 + (i % 2 ? 2.4 : 4.6);
    const r = (3.9 + (3.35 - 3.9) * ((yy - y2) / t2h)) * Math.cos(Math.PI / 8) - 0.02;
    const ry = -a + Math.PI / 2;
    stoneP.add(box(0.7, 1.3, 0.2, 0.03), marbleShade, M(Math.cos(a) * (r + 0.05), yy, Math.sin(a) * (r + 0.05), ry));
    darkP.add(box(0.36, 1.0, 0.08), 0x16120f, M(Math.cos(a) * (r + 0.14), yy, Math.sin(a) * (r + 0.14), ry));
  }
  const c2 = y2 + t2h;
  stoneP.add(facet(lathe([[3.35, c2], [3.75, c2 + 0.25], [3.75, c2 + 0.5], [3.75, c2 + 0.5], [2.3, c2 + 0.5]], 8,
    { phase: Math.PI / 8 })), marbleShade);

  // TIER 3 — the round drum with its lantern colonnade
  const y3 = c2 + 0.5;
  stoneP.add(lathe([[2.5, y3], [2.35, y3 + 2.4], [2.35, y3 + 2.4], [2.7, y3 + 2.55], [2.7, y3 + 2.75], [2.7, y3 + 2.75], [0, y3 + 2.75]], 24),
    weathered(marble));
  const yL = y3 + 2.75, lanH = 2.5;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addColumn(colP, Math.cos(a) * 2.2, yL, Math.sin(a) * 2.2, lanH, 0xf2ece0);
  }
  // lantern ceiling ring + dome + bronze crown
  const yD = yL + lanH;
  stoneP.add(lathe([[2.6, yD], [2.6, yD + 0.35], [2.6, yD + 0.35], [2.75, yD + 0.45], [0, yD + 0.45]], 24), marbleShade);
  bronzeP.add(lathe([[2.4, 0], [2.3, 0.4], [1.9, 0.95], [1.2, 1.35], [0.4, 1.55], [0.0, 1.58]], 24), 0x6f8a6a,
    M(0, yD + 0.45, 0));           // verdigris copper dome
  // a bronze sun disc on a spire — the Pharos' crown
  bronzeP.add(lathe([[0.26, 0], [0.12, 0.3], [0.08, 1.2], [0.0, 1.5]], 10), 0xc9993f, M(0, yD + 1.95, 0));
  bronzeP.add(new THREE.TorusGeometry(0.55, 0.08, 6, 20), 0xd9a441, M(0, yD + 3.2, 0));
  bronzeP.add(lathe([[0.0, -0.05], [0.42, -0.05], [0.42, 0.05], [0.0, 0.05]], 16), 0xe0b048,
    M(0, yD + 3.2, 0, 0, 1, 1, 1, Math.PI / 2));

  for (const [p, m] of [[stoneP, mat.marble()], [colP, columnMat()], [darkP, mat.plain()], [bronzeP, mat.bronze()]]) {
    const mesh = p.mesh(m);
    if (mesh) g.add(mesh);
  }

  // THE FIRE — a hot core inside the lantern; scene.js pulses 'pharosfire'
  const fire = new THREE.Group();
  fire.name = 'pharosfire';
  fire.position.y = yL + 0.9;
  const core = new THREE.Mesh(cached('geo:pharoscore', () => new THREE.SphereGeometry(0.9, 16, 12)),
    mat.glow(0xffd98a, 4.0));
  core.userData.keep = true;
  fire.add(core);
  const fl = flame({ w: 2.0, h: 2.6, color: 0xffa040, glow: 1.4, seed: 7, halo: 0.5 });
  fl.position.y = -0.9;
  fire.add(fl);
  g.add(fire);
  const halo = glowSprite(0xffe2a8, 16, 0.45);
  halo.position.y = yL + 1.0;
  g.add(halo);
  const light = new THREE.PointLight(0xffd59a, 6, 90, 2);
  light.position.y = yL + 1.0;
  g.add(light);

  // twin beams sweeping slowly round the horizon
  const beamGeo = cached('geo:pharosbeam', () => {
    const c = new THREE.CylinderGeometry(7.5, 0.7, 64, 20, 1, true);
    c.translate(0, -32, 0);                    // apex at the origin, opening along −y
    // uv.y: 0 at the lantern → 1 at the far end
    const uv = c.attributes.uv, p = c.attributes.position;
    for (let i = 0; i < p.count; i++) uv.setY(i, -p.getY(i) / 64);
    c.rotateZ(Math.PI / 2);                    // now opens along +x
    return c;
  });
  const sweep = new THREE.Group();
  sweep.userData.noFit = true;
  sweep.position.y = yL + 1.0;
  for (const s of [0, Math.PI]) {
    const b = new THREE.Mesh(beamGeo, beamMaterial());
    b.rotation.y = s;
    b.rotation.z = -0.06;                      // dipping a touch toward the sea
    b.renderOrder = 4;
    b.frustumCulled = false;
    sweep.add(b);
  }
  g.add(sweep);
  animate(sweep, (t) => { sweep.rotation.y = t * 0.22; });

  // the sealed door at the foot
  const gate = makePharosGate();
  gate.position.set(0, y1, 5.2 + 0.08);
  g.add(gate);
  g.userData.height = yD + 3.8;
  return g;
}

/* The sealed door at the Pharos' foot: moulded marble frame, twin bronze
   leaves on hinge pivots ('doorPivotL/R'), three sigil sockets across the
   lintel ('sigil0..2', blank until the captain banks seals). scene.js drives
   the sockets' emissiveIntensity and the leaves' swing by these names. */
function makePharosGate() {
  const gate = new THREE.Group();
  gate.name = 'pharosgate';
  const frame = new Parts(), bronze = new Parts(), dark = new Parts();
  const mrb = 0xe3d8c0, mrb2 = 0xd2c4a6;
  for (const s of [-1, 1]) {
    frame.add(box(0.7, 5.6, 0.7, 0.06), mrb, M(s * 2.05, 2.8, 0.15));
    frame.add(box(0.9, 0.5, 0.9, 0.06), mrb2, M(s * 2.05, 0.25, 0.15));
  }
  frame.add(box(5.4, 0.9, 0.9, 0.08), mrb, M(0, 6.05, 0.2));
  frame.add(box(5.9, 0.3, 1.1, 0.06), mrb2, M(0, 6.65, 0.25));
  frame.add(gable(5.9, 1.1, 0.7), mrb, M(0, 6.8, 0.2));
  dark.add(box(3.4, 5.6, 0.3), 0x0f0c0a, M(0, 2.8, -0.2));
  const fm = frame.mesh(mat.marble()); gate.add(fm);
  const dm = dark.mesh(mat.plain(), { cast: false }); gate.add(dm);

  // twin bronze leaves, panelled and studded, on pivots at the jambs
  const leafGeo = cached('geo:pharosleaf', () => {
    const p = new Parts();
    p.add(box(1.66, 5.0, 0.2, 0.04), 0x9a7a40);
    for (const yy of [-1.5, 0.2, 1.7]) p.add(box(1.2, 1.2, 0.08, 0.05), 0xb48e48, M(0, yy, 0.12));
    for (let r = 0; r < 4; r++) {
      for (const xx of [-0.68, 0.68]) p.add(blob(0.05, 1), 0xc29a4a, M(xx, -2.2 + r * 1.45, 0.14));
    }
    const geo = p.geometry(); geo.userData.shared = true;
    return geo;
  });
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'doorPivotL' : 'doorPivotR';
    pivot.position.set(side * 1.7, 2.75, 0.0);
    const leaf = new THREE.Mesh(leafGeo, mat.bronze());
    leaf.position.set(-side * 0.85, 0, 0);
    leaf.castShadow = true;
    pivot.add(leaf);
    gate.add(pivot);
  }
  // three sigil sockets in the lintel
  const ringGeo = cached('geo:sigilring', () => new THREE.TorusGeometry(0.4, 0.07, 8, 24));
  const discGeo = cached('geo:sigildisc', () => new THREE.CylinderGeometry(0.34, 0.34, 0.1, 20).rotateX(Math.PI / 2));
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 1.5;
    const ring = new THREE.Mesh(ringGeo, mat.gold());
    ring.position.set(x, 6.05, 0.68);
    const sigil = new THREE.Mesh(discGeo, new THREE.MeshStandardMaterial({
      color: 0x2c2620, roughness: 0.4, metalness: 0.3, emissive: 0xffc650, emissiveIntensity: 0 }));
    sigil.position.set(x, 6.05, 0.66);
    sigil.name = 'sigil' + i;
    gate.add(ring, sigil);
  }
  return gate;
}

/* the Pharos isle: a rocky shoulder ringing the plateau, a curved harbour
   mole with a lamp at its head, and a short colonnade on the terrace */
export function dressPharosIsle(g, terrain, R, seed = 1) {
  const rng = mulberry32(seed);
  const rocks = new Parts();
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.25;
    if (Math.abs(((a - 0.8 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.55) continue;   // keep the harbour open
    const rr = 0.86 + rng() * 0.16;
    const p = terrain.place(a, rr);
    const r = 1.4 + rng() * 1.9;
    rocks.add(rockGeometry(seed * 31 + i, { r, sy: 0.65 + rng() * 0.4, rock: 0xa49c8c, top: 0xd7cdb2,
      cover: 0.4, detail: 2, strata: 0.7 }), null, M(p.x, Math.max(-0.6, p.y - r * 0.25), p.z, rng() * 6.28));
  }
  const rm = rocks.mesh(mat.rock());
  if (rm) { onShore(rm); g.add(rm); }

  // the mole: a curving breakwater of dressed blocks from the shore out round
  // the harbour mouth (the first berth sits off its head)
  const mole = new Parts();
  const a0 = 0.8 - 0.75, steps = 11;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const a = a0 - k * 0.15;
    const rr = R * (0.88 + k * 0.42);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const yaw = -a;
    mole.add(box(2.4, 1.5, 2.2, 0.12), (x0, y0, z0, nx, ny, nz, c) => {
      c.setHex(0xcfc4ab);
      c.multiplyScalar(0.55 + 0.45 * smooth(-0.6, 0.6, y0));
    }, M(x, 0.1, z, yaw));
  }
  const head = new THREE.Vector3(Math.cos(a0 - 0.15) * R * 1.3, 0, Math.sin(a0 - 0.15) * R * 1.3);
  mole.add(lathe([[0.7, 0], [0.6, 2.2], [0.75, 2.3], [0.75, 2.45], [0, 2.45]], 12), 0xe6dcc6, M(head.x, 0.8, head.z));
  const mm = mole.mesh(mat.ashlar());
  if (mm) { onShore(mm); g.add(mm); }
  const lampMesh = new THREE.Mesh(cached('geo:molelamp', () => new THREE.SphereGeometry(0.32, 12, 8)), mat.glow(0xffc070, 3));
  lampMesh.position.set(head.x, 3.55, head.z);
  g.add(lampMesh);
  const lf = flame({ w: 0.5, h: 0.7, seed: 3 });
  lf.position.set(head.x, 3.4, head.z);
  g.add(lf);

  // a ruined peristyle on the terrace: columns in pairs carrying lintels,
  // a few broken, framing the tower from the berths
  const cols = new Parts(), lint = new Parts();
  const top = terrain.heightAt(0.72);
  const ring = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + 0.11;
    if (Math.abs(((a - Math.PI / 2 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.42) continue;   // the stair
    if (Math.abs(((a - 0.05 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.3) continue;            // the mole
    ring.push(a);
  }
  const rr = R * 0.6, H = 5.0;
  const tops = [];
  ring.forEach((a, i) => {
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const y = terrain.surfaceY(x, z) - 0.1;
    const broken = (i * 7 + seed) % 5 === 0 ? 0.35 + rng() * 0.3 : 0;
    addColumn(cols, x, y, z, H, 0xf0e9da, broken);
    tops.push(broken ? null : [x, y + H, z]);
  });
  for (let i = 0; i + 1 < tops.length; i++) {
    const a = tops[i], b = tops[i + 1];
    if (!a || !b || i % 3 === 2) continue;                // gaps where the lintels fell
    const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2, my = Math.max(a[1], b[1]);
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]) + 1.0;
    lint.add(box(len, 0.62, 0.9, 0.06), (x, y, z, nx, ny, nz, c) => { c.setHex(0xe8dfcc); c.multiplyScalar(ny > 0.5 ? 1.03 : 0.95); },
      M(mx, my + 0.31, mz, -Math.atan2(b[2] - a[2], b[0] - a[0])));
  }
  // a fallen lintel and drums in the grass
  for (let k = 0; k < 3; k++) {
    const a = rng() * 6.28, d = R * (0.45 + rng() * 0.2);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    lint.add(lathe([[0.62, 0], [0.62, 0.9], [0, 0.9]], 16), 0xe2d8c2, M(x, terrain.surfaceY(x, z) + 0.55, z, rng() * 3, 1, 1, 1, Math.PI / 2));
  }
  const cm = cols.mesh(columnMat());
  if (cm) g.add(cm);
  const lm = lint.mesh(mat.marble());
  if (lm) g.add(lm);
  // dark cypresses and an olive or two between the columns and the shore
  for (const [a, k, id] of [[1.0, 0.76, 'cypress_tree'], [2.3, 0.74, 'cypress_tree'], [2.9, 0.7, 'olive_tree'],
    [3.8, 0.75, 'cypress_tree'], [4.6, 0.72, 'olive_tree'], [5.4, 0.76, 'cypress_tree']]) {
    const p = terrain.place(a + (rng() - 0.5) * 0.2, k);
    if (p.y < 0.4) continue;
    const t = propGroup(id, 1.1 + rng() * 0.3);
    t.position.set(p.x, p.y, p.z);
    t.rotation.y = rng() * 6.28;
    g.add(t);
  }
  return top;
}

/* ═════════════════════════════════════════════════════════════════════════
 *  PUZZLE SPIRE — obelisk, armillary sphere, labyrinth floor
 * ═══════════════════════════════════════════════════════════════════════ */
export function makePuzzleSpire({ solved = false, seed = 1 } = {}) {
  const g = new THREE.Group();
  const rng = mulberry32(seed);
  const stone = new Parts(), dark = new Parts(), gold = new Parts();
  const slate = 0x8f93a8, slateDk = 0x6d7088;
  // round plaza with the mosaic labyrinth inlaid
  stone.add(lathe([[3.6, 0], [3.6, 0.22], [3.5, 0.28], [3.5, 0.28], [0, 0.28]], 40), slateDk);
  const maze = new THREE.Mesh(cached('geo:mazedisc', () => new THREE.CircleGeometry(3.35, 48).rotateX(-Math.PI / 2)),
    cached('mat:maze', () => new THREE.MeshStandardMaterial({ map: tex.maze(), roughness: 0.6, metalness: 0 })));
  maze.position.y = 0.285;
  maze.receiveShadow = true;
  g.add(maze);
  // the obelisk on a stepped plinth
  stone.add(box(1.7, 0.4, 1.7, 0.05), slate, M(0, 0.48, 0));
  stone.add(box(1.35, 0.35, 1.35, 0.05), slate, M(0, 0.85, 0));
  const ob = new THREE.CylinderGeometry(0.34 * Math.SQRT2, 0.52 * Math.SQRT2, 4.2, 4, 1, false).rotateY(Math.PI / 4).toNonIndexed();
  ob.computeVertexNormals();
  stone.add(ob, (x, y, z, nx, ny, nz, c) => { c.setHex(slate); c.multiplyScalar(0.85 + 0.15 * smooth(-2, 2, y)); }, M(0, 1.02 + 2.1, 0));
  const tip = new THREE.ConeGeometry(0.34 * Math.SQRT2, 0.6, 4, 1).rotateY(Math.PI / 4).toNonIndexed();
  tip.computeVertexNormals();
  gold.add(tip, 0xd9a441, M(0, 1.02 + 4.2 + 0.3, 0));
  // glyph columns inlaid down each face (light when unsolved)
  const glyph = new Parts();
  for (let f = 0; f < 4; f++) {
    const ry = f * Math.PI / 2;
    for (let k = 0; k < 5; k++) {
      const yy = 1.6 + k * 0.7;
      const w = 0.5 - (yy - 1.0) * 0.04;
      const v = new THREE.Vector3((rng() - 0.5) * 0.12, yy, w / Math.SQRT2 * Math.SQRT2 * 0.5 * 1.0 + 0.0);
      const d = 0.52 - (yy - 1.02) / 4.2 * 0.18 + 0.01;
      const p = new THREE.Vector3(0, yy, d).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      glyph.add(box(0.16 + (k % 2) * 0.1, 0.16, 0.04, 0.01), 0xffffff, M(p.x + v.x * 0, p.y, p.z, ry));
    }
  }
  const glowHex = solved ? 0x6f7aa0 : 0x9fc0ff;
  const glyphMesh = glyph.mesh(mat.glow(glowHex, solved ? 0.6 : 2.6), { cast: false });
  // eight stelae round the plaza, a glyph on each
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const x = Math.cos(a) * 3.0, z = Math.sin(a) * 3.0;
    stone.add(box(0.42, 1.05, 0.2, 0.05), slateDk, M(x, 0.28 + 0.52, z, -a + Math.PI / 2));
    dark.add(box(0.16, 0.16, 0.03, 0.01), 0xffffff, M(x * 0.955, 0.98, z * 0.955, -a + Math.PI / 2));
  }
  for (const [p, m] of [[stone, mat.stone()], [gold, mat.gold()]]) { const mm = p.mesh(m); if (mm) g.add(mm); }
  g.add(glyphMesh);
  const dm = dark.mesh(mat.glow(glowHex, solved ? 0.5 : 1.8), { cast: false }); g.add(dm);

  // the armillary: three gilt rings nested round a glowing orb, turning
  const arm = new THREE.Group();
  arm.position.y = 6.75;
  const ringGeo = (r) => cached('geo:arm' + r, () => new THREE.TorusGeometry(r, 0.045, 8, 48));
  const rings = [];
  for (const [r, tilt] of [[0.95, 0.0], [0.8, 1.2], [0.66, -0.7]]) {
    const piv = new THREE.Group();
    piv.rotation.x = tilt;
    const m = new THREE.Mesh(ringGeo(r), mat.gold());
    m.castShadow = true;
    piv.add(m);
    arm.add(piv);
    rings.push(piv);
  }
  // ecliptic band with zodiac studs
  const band = new THREE.Mesh(cached('geo:armband', () => new THREE.TorusGeometry(0.95, 0.09, 4, 48)), mat.bronze());
  band.rotation.x = Math.PI / 2 + 0.41;
  arm.add(band);
  const orb = new THREE.Mesh(cached('geo:armorb', () => new THREE.SphereGeometry(0.26, 16, 12)),
    mat.glow(solved ? 0x8090b0 : 0xb8d0ff, solved ? 0.8 : 3.2));
  arm.add(orb);
  const halo = glowSprite(0x9fb4ff, solved ? 1.4 : 3.2, solved ? 0.15 : 0.45);
  arm.add(halo);
  // a gilt stem from the obelisk tip up to the sphere
  const stem = new THREE.Mesh(cached('geo:armstem', () => new THREE.CylinderGeometry(0.03, 0.05, 0.9, 6)), mat.gold());
  stem.position.y = -0.6;
  arm.add(stem);
  g.add(arm);
  animate(arm, (t) => {
    const k = solved ? 0.15 : 1;
    rings[0].rotation.y = t * 0.35 * k;
    rings[1].rotation.z = t * 0.22 * k;
    rings[2].rotation.y = -t * 0.5 * k;
    band.rotation.z = t * 0.12 * k;
    arm.position.y = 6.75 + Math.sin(t * 1.1) * 0.06;
  });
  g.userData.footR = 3.6;
  return g;
}

/* ═════════════════════════════════════════════════════════════════════════
 *  RELIC URN and LAIR ALTAR
 * ═══════════════════════════════════════════════════════════════════════ */
export function makeRelicBeacon() {
  const g = new THREE.Group();
  g.name = 'beacon';
  const p = new Parts(), au = new Parts();
  p.add(lathe([[0.55, 0], [0.55, 0.12], [0.42, 0.18], [0.36, 0.7], [0.48, 0.78], [0.48, 0.86], [0, 0.86]], 16), 0x8d8578);
  // a gilt amphora: foot, belly, shoulder, neck, lip; two handles
  au.add(lathe([[0.12, 0], [0.16, 0.04], [0.1, 0.1], [0.24, 0.3], [0.3, 0.5], [0.24, 0.72], [0.1, 0.84], [0.09, 0.98],
    [0.14, 1.02], [0.12, 1.05], [0.0, 1.0]], 18), 0xe3b350, M(0, 0.86, 0));
  for (const s of [-1, 1]) {
    au.add(tube([new THREE.Vector3(s * 0.09, 1.8, 0), new THREE.Vector3(s * 0.26, 1.82, 0), new THREE.Vector3(s * 0.25, 1.55, 0)],
      0.025, 0.025, 6, 5), 0xe3b350);
  }
  const pm = p.mesh(mat.stone()); g.add(pm);
  const am = au.mesh(mat.gold()); g.add(am);
  const gl = glowSprite(0xffcf6a, 2.0, 0.4);
  gl.position.y = 1.5;
  g.add(gl);
  return g;
}

export function makeLairAltar(accentHex, seed = 1) {
  const g = new THREE.Group();
  const rng = mulberry32(seed);
  const basalt = 0x403d45, basaltLt = 0x5b5762;
  const stone = new Parts(), bone = new Parts(), bronze = new Parts();
  const accent = new THREE.Color(accentHex);
  // a round stepped dais of dark basalt
  for (const [r, y, h] of [[2.8, 0, 0.32], [2.35, 0.32, 0.3], [1.9, 0.62, 0.26]]) {
    stone.add(facet(lathe([[r, y], [r, y + h - 0.04], [r - 0.05, y + h], [r - 0.05, y + h], [0, y + h]], 9)),
      (x, yy, z, nx, ny, nz, c) => { c.setHex(ny > 0.5 ? basaltLt : basalt); }, M(0, 0, 0, rng() * 6));
  }
  // the altar block, with a channel cut in its top
  stone.add(box(1.7, 0.95, 1.05, 0.08), basaltLt, M(0, 0.88 + 0.47, 0));
  stone.add(box(1.9, 0.18, 1.25, 0.05), basalt, M(0, 0.88 + 0.98, 0));
  // four great horns curling up round it
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ca = Math.cos(a), sa = Math.sin(a);
    const h = 2.2 + (i % 2) * 0.7;
    bone.add(tube([new THREE.Vector3(ca * 2.15, 0.5, sa * 2.15), new THREE.Vector3(ca * 2.35, h * 0.45, sa * 2.35),
      new THREE.Vector3(ca * 2.1, h * 0.85, sa * 2.1), new THREE.Vector3(ca * 1.65, h, sa * 1.65)], 0.26, 0.03, 12, 8),
    (x, y, z, nx, ny, nz, c) => { c.setHex(0xd9d0b8); c.multiplyScalar(0.55 + 0.45 * smooth(0.5, h, y)); });
  }
  // two bronze fire bowls flanking the altar
  const fires = [];
  for (const s of [-1, 1]) {
    bronze.add(lathe([[0.1, 0], [0.22, 0], [0.12, 0.25], [0.1, 0.7], [0.36, 0.84], [0.46, 1.02], [0.42, 1.04], [0.0, 0.96]], 14),
      0x7d5a2c, M(s * 1.5, 0.88, 0));
    fires.push([s * 1.5, 0.88 + 1.0, 0]);
  }
  for (const [p, m] of [[stone, mat.stone()], [bone, mat.marble()], [bronze, mat.bronze()]]) { const mm = p.mesh(m); if (mm) g.add(mm); }
  for (const [x, y, z] of fires) {
    const f = flame({ w: 0.62, h: 1.1, color: accent.getHex(), glow: 1.3, seed: seed + x * 7 });
    f.position.set(x, y, z);
    f.name = 'brazier';
    g.add(f);
  }
  // a smoulder of the accent in the altar channel
  const ember = glowSprite(accent.getHex(), 2.6, 0.45);
  ember.position.y = 2.15;
  g.add(ember);
  return g;
}

/* ═════════════════════════════════════════════════════════════════════════
 *  CHECKPOINT BEACON — the haven's azure lamp
 *  children order is part of the contract: [post, lamp, beam, halo, …]
 *  (scene.js breathes children[3] at a base scale of 7)
 * ═══════════════════════════════════════════════════════════════════════ */
export function makeCheckpointBeacon() {
  const g = new THREE.Group();
  g.name = 'checkpoint';
  const AZURE = 0x3fa8ff;
  const post = sharedMesh('cppost', () => {
    const p = new Parts();
    p.add(box(0.9, 0.3, 0.9, 0.06), 0xd8cfbc, M(0, 0.15, 0));
    p.add(lathe([[0.2, 0], [0.16, 0.3], [0.13, 2.3], [0.2, 2.4], [0.2, 2.5], [0, 2.5]], 12), 0x9a7a44, M(0, 0.3, 0));
    // lantern cage: four bronze bars round the glass, a cap with a ring
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      p.add(new THREE.CylinderGeometry(0.03, 0.03, 0.85, 5), 0x8a6a36, M(Math.cos(a) * 0.36, 3.2, Math.sin(a) * 0.36));
    }
    p.add(lathe([[0.5, 0], [0.42, 0.12], [0.2, 0.32], [0.06, 0.42], [0.0, 0.5]], 12), 0x8a6a36, M(0, 3.62, 0));
    p.add(lathe([[0.46, 0], [0.46, 0.08], [0, 0.08]], 12), 0x8a6a36, M(0, 2.72, 0));
    return p.geometry();
  }, mat.bronze());
  const lamp = sharedMesh('cplamp', () => new THREE.SphereGeometry(0.34, 16, 12).scale(1, 1.25, 1), mat.glow(0xa8dcff, 3.2), { cast: false });
  lamp.position.y = 3.2;
  const beam = new THREE.Mesh(cached('geo:cpbeam', () => {
    const c = new THREE.CylinderGeometry(0.5, 0.9, 26, 16, 1, true);
    const uv = c.attributes.uv, p = c.attributes.position;
    for (let i = 0; i < p.count; i++) uv.setY(i, (p.getY(i) + 13) / 26);
    return c;
  }), cached('mat:cpbeam', () => new THREE.MeshBasicMaterial({ color: new THREE.Color(AZURE).multiplyScalar(1.3),
    alphaMap: verticalFade(), transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending })));
  beam.position.y = 16.5;
  beam.userData.noFit = true;
  const halo = glowSprite(AZURE, 7, 0.5);
  halo.position.y = 3.2;
  g.add(post, lamp, beam, halo);
  return g;
}

/* alpha fading out toward the top of a beam (v = 0 bottom → 1 top) */
export function verticalFade() {
  return cached('tex:vfade', () => {
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 128;
    const c = cv.getContext('2d');
    const gr = c.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, 'rgb(255,255,255)'); gr.addColorStop(0.5, 'rgb(150,150,150)'); gr.addColorStop(1, 'rgb(0,0,0)');
    c.fillStyle = gr; c.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(cv);
  });
}

function sharedMesh(key, makeGeo, material, { cast = true } = {}) {
  const geo = cached('geo:' + key, () => { const gg = makeGeo(); gg.userData.shared = true; return gg; });
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast; m.receiveShadow = true;
  return m;
}
export { sharedMesh };

/* ═════════════════════════════════════════════════════════════════════════
 *  HAVEN — a harbour camp (sea), or a caravan / woodland camp (on foot)
 * ═══════════════════════════════════════════════════════════════════════ */

/* a striped canvas awning on four poles, sloping toward +z */
function awning(cloth, wood, x, z, ry, w, d, h, stripeA, stripeB) {
  const m = M(x, 0, z, ry);
  for (const [px, pz, ph] of [[-w / 2, -d / 2, h], [w / 2, -d / 2, h], [-w / 2, d / 2, h * 0.78], [w / 2, d / 2, h * 0.78]]) {
    wood.add(new THREE.CylinderGeometry(0.05, 0.06, ph, 6), 0x7a5634, M(px, ph / 2, pz).premultiply(m));
  }
  // the canvas: a sagging sheet between the poles, scalloped valance in front
  const nx = 10, nz = 6;
  const geo = new THREE.PlaneGeometry(w + 0.2, d + 0.25, nx, nz).rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / (w + 0.2) + 0.5, v = p.getZ(i) / (d + 0.25) + 0.5;
    const sag = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.16;
    p.setY(i, h + (h * 0.78 - h) * v - sag + 0.02);
  }
  geo.computeVertexNormals();
  cloth.add(geo, (xx, yy, zz, a, b, c, col) => {
    const k = Math.floor((xx / (w + 0.2) + 0.5) * 7) % 2;
    col.setHex(k ? stripeA : stripeB);
  }, m, 0, true);
  const val = new THREE.PlaneGeometry(w + 0.2, 0.32, 14, 1);
  const vp = val.attributes.position;
  for (let i = 0; i < vp.count; i++) {
    if (vp.getY(i) < 0) vp.setY(i, vp.getY(i) + Math.abs(Math.sin(vp.getX(i) * 6)) * 0.12);
  }
  val.computeVertexNormals();
  cloth.add(val, stripeA, M(0, h * 0.78 - 0.14, d / 2 + 0.12).premultiply(m));
}

/* a bell tent (on-foot camps): canvas cone on a centre pole, guy ropes */
function bellTent(cloth, wood, x, z, s, hex) {
  const g = lathe([[1.6, 0], [1.55, 0.35], [1.25, 0.75], [0.6, 1.55], [0.12, 2.15], [0.0, 2.2]], 20);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {      // sagging panels between the seams
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const k = 1 - 0.05 * Math.pow(Math.abs(Math.sin(a * 4)), 0.7) * Math.min(1, p.getY(i));
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  cloth.add(g, (xx, yy, zz, a, b, c, col) => {
    col.setHex(hex);
    col.multiplyScalar(0.8 + 0.2 * smooth(0, 1.5, yy));
    if (yy < 0.38) col.multiplyScalar(0.78);
  }, M(x, 0, z, 0, s));
  wood.add(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 5), 0x6a4a2a, M(x, 2.35 * s, z));
  // door flap: a dark triangle on +z
  const door = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0), new THREE.Vector3(0, 1.1, -0.35)]);
  door.computeVertexNormals();
  cloth.add(door, 0x3a2a1c, M(x, 0.01, z + 1.6 * s, 0, s));
}

/* a ring of fire-blackened stones, logs and a flame */
function campfire(stone, wood, g, x, z, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    stone.add(rockGeometry(seed + i, { r: 0.2 + rng() * 0.08, sy: 0.7, detail: 1, rock: 0x6f6a64, strata: 0 }), null,
      M(x + Math.cos(a) * 0.62, 0.05, z + Math.sin(a) * 0.62, rng() * 6));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    wood.add(tube([new THREE.Vector3(Math.cos(a) * 0.5, 0.05, Math.sin(a) * 0.5), new THREE.Vector3(Math.cos(a) * 0.08, 0.32, Math.sin(a) * 0.08)],
      0.07, 0.05, 2, 6), (xx, yy, zz, a1, b, c, col) => { col.setHex(yy > 0.2 ? 0x2a1d14 : 0x6a4a2c); }, M(x, 0, z));
  }
  const f = flame({ w: 0.8, h: 1.2, seed });
  f.position.set(x, 0.12, z);
  g.add(f);
}

export function makeCampHaven({ kind = 'sea', seed = 1 } = {}) {
  const g = new THREE.Group();
  const rng = mulberry32(seed);
  const cloth = new Parts(), wood = new Parts(), stone = new Parts(), cer = new Parts();
  if (kind === 'sea') {
    awning(cloth, wood, -1.6, -0.4, 0.25, 2.6, 2.0, 2.2, 0xd8d0bc, 0x2f6fae);
    awning(cloth, wood, 1.8, -1.2, -0.35, 2.2, 1.8, 2.0, 0xe6dcc4, 0xb5482f);
    // nets heaped to dry with a pair of oars across them
    cloth.add(blob(0.55, 1, 0.42), (x, y, z, nx, ny, nz, c) => { c.setHex(0xb59a6a); c.multiplyScalar(0.8 + 0.2 * Math.sin(x * 11) * Math.sin(z * 11)); },
      M(0.9, 0.15, 2.1, 0.4, 1.3, 1, 1));
    for (const o of [-0.25, 0.25]) wood.add(new THREE.CylinderGeometry(0.035, 0.035, 2.2, 5).rotateZ(Math.PI / 2), 0x8a6238, M(0.9, 0.42, 2.1 + o, 0.4 + o));
    campfire(stone, wood, g, 0.2, 0.6, seed + 5);
  } else {
    const hexes = kind === 'autumn' ? [0xb9a07a, 0x8f6b48, 0xc8b490] : [0xe6d6b4, 0xc69a62, 0xd9c49c];
    bellTent(cloth, wood, -1.9, -0.8, 1.0, hexes[0]);
    bellTent(cloth, wood, 1.9, -1.4, 0.85, hexes[1]);
    awning(cloth, wood, 0.4, 2.0, 0.1, 2.2, 1.6, 1.9, hexes[2], kind === 'autumn' ? 0x7c3a22 : 0xa4462a);
    campfire(stone, wood, g, 0.0, 0.4, seed + 5);
  }
  // stores: crates, barrels, amphorae against the awnings
  const crate = makeCrate(), amph = makeAmphora(), barrel = makeBarrelGeo();
  const spots = [[-2.6, 0.7], [-2.2, 1.2], [2.9, -0.2], [3.1, 0.5], [-0.6, -2.0], [1.0, -2.6]];
  spots.forEach(([x, z], i) => {
    const pick = i % 3;
    const geo = (pick === 0 ? crate : pick === 1 ? amph : barrel).clone();
    const s = 0.8 + rng() * 0.35;
    (pick === 1 ? cer : wood).add(geo, null, M(x, 0, z, rng() * 6.28, s));
  });
  for (const [p, m] of [[cloth, mat.cloth()], [wood, mat.wood()], [stone, mat.rock()], [cer, mat.plaster()]]) {
    const mm = p.mesh(m);
    if (mm) g.add(mm);
  }
  g.userData.footR = 3.6;
  // board scale: the map's ships ride at ×2, so the camp is built up to meet them
  for (const c of [...g.children]) { c.scale.multiplyScalar(1.35); c.position.multiplyScalar(1.35); }
  return g;
}

/* a pair of fishing boats drawn up / moored — haven and home port */
export function boatsAt(g, terrain, angle, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < 2; i++) {
    const a = angle + (i - 0.5) * 0.32;
    const p = terrain.place(a, i ? 1.02 : 0.96);
    const b = makeFishingBoat({ seed: seed + i, hull: i ? 0x3d6f9e : 0xb2452e });
    b.position.set(p.x, Math.max(-0.22, p.y - 0.1), p.z);
    b.rotation.y = -a + (rng() - 0.5) * 0.6;
    b.rotation.z = i ? 0 : 0.12;           // the beached one lists on its bilge
    g.add(b);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
 *  MARKET — stalls under striped awnings, wares, a little stoa behind
 * ═══════════════════════════════════════════════════════════════════════ */
export function makeMarketSquare(ry = 0, { seed = 1 } = {}) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = ry;
  inner.scale.setScalar(1.35);                 // board scale (the ships ride at ×2)
  g.add(inner);
  const rng = mulberry32(seed);
  const stone = new Parts(), cols = new Parts(), roof = new Parts(), cloth = new Parts(), wood = new Parts(),
    ware = new Parts(), cer = new Parts();
  // a round paved agora with a kerb
  stone.add(lathe([[4.6, 0], [4.6, 0.16], [4.45, 0.22], [4.45, 0.22], [0, 0.22]], 40), 0xd9cfb9);
  // an open stoa along the back: two rows of columns under a tiled roof —
  // you see straight through it from any side
  const sz = -3.1;
  stone.add(box(7.4, 0.22, 2.2, 0.04), 0xe7dfcd, M(0, 0.33, sz));
  for (const zz of [sz + 0.75, sz - 0.75]) {
    for (let i = 0; i < 5; i++) addColumn(cols, -3.0 + i * 1.5, 0.44, zz, 2.5, 0xf3eee2);
    stone.add(box(7.4, 0.34, 0.42, 0.04), 0xe7dfcd, M(0, 0.44 + 2.5 + 0.17, zz));
  }
  for (const r of pitchedRoof(2.1, 7.6, 0.75, 0.15)) {
    roof.add(r, (x, y, z, nx, ny, nz, c) => { c.setHex(0xb4613c); c.multiplyScalar(0.92 + 0.08 * Math.sin(z * 7)); },
      M(0, 3.28, sz, Math.PI / 2));
  }
  for (const s of [-1, 1]) stone.add(gable(2.3, 0.7, 0.25), 0xeee6d6, M(s * 3.72, 3.28, sz, Math.PI / 2));
  // four stalls round a fountain, each facing into the square
  const stripes = [0x2f6fae, 0xb5482f, 0xc89a2c, 0x3f8a5a];
  const kinds = ['fruit', 'cloth', 'fish', 'pots'];
  [[-2.6, 0.9, Math.PI / 2 - 0.3], [2.6, 0.9, -Math.PI / 2 + 0.3], [-1.8, 3.0, Math.PI * 0.82], [1.8, 3.0, -Math.PI * 0.82]].forEach(([x, z, r], i) => {
    const m = M(x, 0.22, z, r);
    awning(cloth, wood, 0, 0, 0, 1.9, 1.4, 2.0, 0xece3cc, stripes[i]);
    // (awning() placed it at the origin: move those last parts into the stall's frame)
    for (const geo of [...cloth.list.slice(-2), ...wood.list.slice(-4)]) geo.applyMatrix4(m);
    wood.add(box(1.7, 0.1, 0.7, 0.02), 0x9a6b3f, M(0, 0.88, 0.2).premultiply(m));
    wood.add(box(1.6, 0.78, 0.06, 0.02), 0x7d5530, M(0, 0.43, 0.54).premultiply(m));
    for (const sx of [-0.78, 0.78]) wood.add(box(0.07, 0.82, 0.62, 0.01), 0x7d5530, M(sx, 0.41, 0.2).premultiply(m));
    if (kinds[i] === 'fruit') {
      for (let k = 0; k < 12; k++) {
        ware.add(blob(0.1, 1), [0xd8902a, 0xb8341e, 0xcdb836][k % 3],
          M(-0.6 + (k % 6) * 0.24, 1.0 + (k % 2) * 0.03, 0.08 + Math.floor(k / 6) * 0.22).premultiply(m));
      }
    } else if (kinds[i] === 'cloth') {
      [0x2f6fae, 0xb5482f, 0xd8b04a, 0x6d3f8a].forEach((c, k) => {
        cloth.add(new THREE.CylinderGeometry(0.11, 0.11, 0.62, 10).rotateZ(Math.PI / 2), c, M(-0.5 + k * 0.33, 1.04, 0.2).premultiply(m));
      });
    } else if (kinds[i] === 'fish') {
      for (let k = 0; k < 5; k++) {
        const fish = blob(0.11, 1, 0.45);
        fish.scale(2.6, 1, 0.8);
        ware.add(fish, 0x9fb2ba, M(-0.56 + k * 0.28, 0.97, 0.2, 0.3).premultiply(m));
      }
    } else {
      for (let k = 0; k < 3; k++) cer.add(makeAmphora().clone(), null, M(-0.5 + k * 0.5, 0.93, 0.2, k, 0.55).premultiply(m));
    }
    cer.add(makeAmphora().clone(), null, M(1.15, 0, 0.6, rng() * 3, 0.8).premultiply(m));
  });
  // the fountain: a basin, a stem and a bowl
  stone.add(lathe([[1.0, 0], [1.0, 0.5], [0.9, 0.55], [0.82, 0.55], [0.82, 0.25], [0, 0.25]], 24), 0xd2c6ad, M(0, 0.22, 0.9));
  stone.add(lathe([[0.16, 0], [0.12, 0.7], [0.45, 0.85], [0.48, 0.95], [0, 0.9]], 16), 0xe0d6c0, M(0, 0.45, 0.9));
  const water = new THREE.Mesh(cached('geo:fountainw', () => new THREE.CircleGeometry(0.82, 24).rotateX(-Math.PI / 2)), mat.wet());
  water.material = cached('mat:fountainw', () => new THREE.MeshStandardMaterial({ color: 0x3f8fa8, roughness: 0.08, metalness: 0 }));
  water.position.set(0, 0.7, 0.9);
  inner.add(water);
  for (const [p, m] of [[stone, mat.marble()], [cols, columnMat()], [roof, mat.tiles()], [cloth, mat.cloth()],
    [wood, mat.wood()], [ware, mat.wet()], [cer, mat.plaster()]]) {
    const mm = p.mesh(m);
    if (mm) inner.add(mm);
  }
  g.userData.footR = 6.2;
  return g;
}

/* ═════════════════════════════════════════════════════════════════════════
 *  HOME PORT — a small Cycladic harbour town with its lighthouse
 * ═══════════════════════════════════════════════════════════════════════ */
export function makeLighthouse() {
  const g = new THREE.Group();
  const p = new Parts(), dark = new Parts(), metal = new Parts();
  p.add(box(2.0, 0.5, 2.0, 0.08), 0xe9e4d8, M(0, 0.25, 0));
  p.add(lathe([[0.82, 0], [0.62, 4.6], [0.62, 4.6], [0.88, 4.7], [0.88, 4.9], [0.88, 4.9], [0, 4.9]], 20),
    (x, y, z, nx, ny, nz, c) => { c.setHex(0xf4f1ea); c.multiplyScalar(0.92 + 0.08 * smooth(0, 1.2, y)); }, M(0, 0.5, 0));
  for (const yy of [1.9, 3.4]) dark.add(box(0.26, 0.5, 0.1), 0x1b2a44, M(0, 0.5 + yy, 0.76 - yy * 0.042, 0, 1, 1, 1, -0.04));
  dark.add(box(0.5, 0.95, 0.12), 0x2a5aa8, M(0, 0.95, 0.8, 0, 1, 1, 1, -0.04));
  // lantern: glazing posts + blue cupola
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    metal.add(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 5), 0x2c3a4c, M(Math.cos(a) * 0.48, 5.8, Math.sin(a) * 0.48));
  }
  metal.add(lathe([[0.62, 0], [0.55, 0.15], [0.35, 0.4], [0.08, 0.6], [0, 0.7]], 16), 0x2a5aa8, M(0, 6.17, 0));
  metal.add(new THREE.TorusGeometry(0.85, 0.03, 4, 24).rotateX(Math.PI / 2), 0x2c3a4c, M(0, 5.75, 0));
  for (const [pp, m] of [[p, mat.plaster()], [dark, mat.plain()], [metal, mat.bronze()]]) { const mm = pp.mesh(m); if (mm) g.add(mm); }
  const lamp = new THREE.Mesh(cached('geo:lhlamp', () => new THREE.SphereGeometry(0.3, 12, 10)), mat.glow(0xffe0a0, 3.2));
  lamp.position.y = 5.8;
  g.add(lamp);
  const halo = glowSprite(0xffd8a0, 2.4, 0.35);
  halo.position.y = 5.8;
  g.add(halo);
  return g;
}

/* one whitewashed house: a cube (or two) with a flat roof parapet, blue door
   and shutters; sometimes a blue dome. Base sunk well into the slope. */
function cycladicHouse(wall, trim, x, y, z, ry, w, d, h, rng, domeP) {
  const m = M(x, y, z, ry);
  const sink = 1.2;
  wall.add(box(w, h + sink, d, 0.09), (xx, yy, zz, nx, ny, nz, c) => {
    c.setHex(0xf6f3ec);
    c.multiplyScalar(0.9 + 0.1 * smooth(-0.5, 0.3, yy + (h + sink) / 2 - sink));
  }, M(0, (h - sink) / 2, 0).premultiply(m), 0, true);
  wall.add(box(w + 0.1, 0.16, d + 0.1, 0.05), 0xfbf9f4, M(0, h + 0.08, 0).premultiply(m));
  // door + two shutters on the +z face
  trim.add(box(0.5, 1.0, 0.06, 0.02), 0x2b5fae, M((rng() - 0.5) * (w - 0.9), 0.5, d / 2 + 0.02).premultiply(m));
  for (const s of [-1, 1]) {
    if (w < 1.4 && s > 0) continue;
    trim.add(box(0.3, 0.34, 0.05, 0.015), 0x2b5fae, M(s * w * 0.28, h * 0.62, d / 2 + 0.02).premultiply(m));
  }
  if (rng() < 0.4) {
    // a stacked upper room, set back
    const w2 = w * 0.55, h2 = h * 0.7;
    wall.add(box(w2, h2, d * 0.6, 0.08), 0xf4f1ea, M(-w * 0.18, h + h2 / 2, -d * 0.15).premultiply(m));
    trim.add(box(0.28, 0.3, 0.05, 0.015), 0x2b5fae, M(-w * 0.18, h + h2 * 0.55, -d * 0.15 + d * 0.3 + 0.02).premultiply(m));
  }
  if (domeP) {
    domeP.add(lathe([[0.8, 0], [0.79, 0.26], [0.64, 0.6], [0.36, 0.84], [0.0, 0.92]], 16), 0x2459a8, M(0, h + 0.3, 0).premultiply(m));
    domeP.add(new THREE.CylinderGeometry(0.84, 0.88, 0.3, 16), 0xf6f3ec, M(0, h + 0.15, 0).premultiply(m));
    trim.add(box(0.07, 0.55, 0.07, 0.01), 0xc9a24a, M(0, h + 1.45, 0).premultiply(m));
    trim.add(box(0.3, 0.07, 0.07, 0.01), 0xc9a24a, M(0, h + 1.56, 0).premultiply(m));
    // a bell gable on the front edge
    wall.add(box(0.7, 0.9, 0.18, 0.04), 0xf6f3ec, M(0, h + 0.45, d / 2 - 0.1).premultiply(m));
    trim.add(blob(0.13, 1, 1.2), 0xb08a3a, M(0, h + 0.42, d / 2 - 0.1).premultiply(m));
  }
}

/* the town is laid out up the slope facing the jetty (terrain angle `dockA`) */
export function makeHomeTown(g, terrain, R, dockA, seed = 1) {
  const rng = mulberry32(seed);
  const wall = new Parts(), trim = new Parts(), dome = new Parts();
  const spots = [];
  // houses in two terraces either side of the lane down to the jetty
  // (a tight cluster, board-scaled like the ships: whitewashed cubes jostling
  // up the slope either side of the lane down to the jetty)
  for (let i = 0; i < 22 && spots.length < 10; i++) {
    const side = i % 2 ? 1 : -1;
    const a = dockA + side * (0.26 + rng() * 0.62);
    const rr = 0.22 + rng() * 0.4;
    const p = terrain.place(a, rr);
    if (p.y < 0.35) continue;
    let ok = true;
    for (const q of spots) if (Math.hypot(q.x - p.x, q.z - p.z) < 2.5) { ok = false; break; }
    if (!ok) continue;
    spots.push(p);
    const w = 1.8 + rng() * 0.9, d = 1.6 + rng() * 0.7, h = 1.4 + rng() * 0.8;
    // face the harbour: front (+z local) toward the dock direction
    const ry = Math.atan2(Math.cos(dockA), Math.sin(dockA)) + (rng() - 0.5) * 0.3;
    cycladicHouse(wall, trim, p.x, p.y - 0.05, p.z, ry, w, d, h, rng, null);
  }
  // the chapel: a whitewashed cube under a blue dome with a bell gable
  {
    const p = terrain.place(dockA + Math.PI * 0.62, 0.3);
    const ry = Math.atan2(Math.cos(dockA), Math.sin(dockA));
    cycladicHouse(wall, trim, p.x, p.y - 0.05, p.z, ry, 2.2, 2.2, 2.0, mulberry32(seed + 9), dome);
  }
  for (const [p, m] of [[wall, mat.plaster()], [trim, mat.plain()], [dome, mat.plaster()]]) {
    const mm = p.mesh(m);
    if (mm) g.add(mm);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
 *  THE REALM GATE — a monumental carved gateway over the sailing channel
 *  Local frame: the channel runs along ±Z, the structure flanks along ±X.
 * ═══════════════════════════════════════════════════════════════════════ */
const MOTIF = {
  ice: 'flake', desert: 'sun', jungle: 'serpent', autumn: 'antler',
};
function motifTexture(kind) {
  return cached('tex:motif:' + kind, () => {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    c.translate(S / 2, S / 2);
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineCap = 'round'; c.lineJoin = 'round';
    c.lineWidth = 12;
    c.beginPath(); c.arc(0, 0, S * 0.45, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 10;
    if (kind === 'flake') {
      for (let k = 0; k < 6; k++) {
        c.save(); c.rotate(k * Math.PI / 3);
        c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -S * 0.36); c.stroke();
        for (const t of [0.15, 0.26]) {
          c.beginPath(); c.moveTo(0, -S * t); c.lineTo(-S * 0.07, -S * (t + 0.07)); c.moveTo(0, -S * t); c.lineTo(S * 0.07, -S * (t + 0.07)); c.stroke();
        }
        c.restore();
      }
    } else if (kind === 'sun') {
      c.beginPath(); c.arc(0, 0, S * 0.14, 0, Math.PI * 2); c.fill();
      for (let k = 0; k < 12; k++) {
        c.save(); c.rotate(k * Math.PI / 6);
        c.beginPath(); c.moveTo(-S * 0.03, -S * 0.2); c.lineTo(0, -S * (k % 2 ? 0.31 : 0.38)); c.lineTo(S * 0.03, -S * 0.2); c.fill();
        c.restore();
      }
    } else if (kind === 'serpent') {
      c.lineWidth = 14;
      c.beginPath();
      for (let k = 0; k <= 60; k++) {
        const t = k / 60, a = t * Math.PI * 3.2, r = S * (0.33 - t * 0.24);
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.beginPath(); c.ellipse(S * 0.33, 0, S * 0.06, S * 0.04, 0, 0, Math.PI * 2); c.fill();
    } else {
      // antlers rising from a stag's brow
      c.beginPath(); c.moveTo(-S * 0.06, S * 0.2); c.lineTo(0, S * 0.3); c.lineTo(S * 0.06, S * 0.2); c.lineTo(0, S * 0.08); c.closePath(); c.fill();
      for (const s of [-1, 1]) {
        c.beginPath(); c.moveTo(s * S * 0.04, S * 0.08);
        c.quadraticCurveTo(s * S * 0.22, -S * 0.02, s * S * 0.2, -S * 0.32); c.stroke();
        for (const [t0, t1, t2] of [[0.12, 0.3, -0.04], [0.18, 0.32, -0.16], [0.2, 0.08, -0.22]]) {
          c.beginPath(); c.moveTo(s * S * t0, -S * Math.abs(t2) * 0.4 - S * 0.02 + S * t2 * 0.5);
          c.lineTo(s * S * t1, S * t2 - S * 0.08); c.stroke();
        }
      }
    }
    const t = new THREE.CanvasTexture(cv);
    t.anisotropy = 8;
    return t;
  });
}

export function makeGatePortal(accentHex, seed, rockHex = 0x8a8f98, realm = '') {
  const g = new THREE.Group();
  const accent = new THREE.Color(accentHex);
  const rng = mulberry32(seed);
  const CH = 9;
  const rock = new THREE.Color(rockHex);
  const stoneC = rock.clone().lerp(new THREE.Color(0xeae2d2), 0.68);
  const stoneD = stoneC.clone().multiplyScalar(0.72);
  const ash = new Parts(), cols = new Parts(), bronze = new Parts(), rocks = new Parts(), glyph = new Parts();
  const weather = (base) => (x, y, z, nx, ny, nz, c) => {
    c.copy(base);
    c.multiplyScalar(0.62 + 0.38 * smooth(-0.5, 3.5, y));      // sea-darkened foot
    c.multiplyScalar(0.95 + 0.05 * Math.sin(y * 1.7 + x * 0.3));
    if (ny > 0.6) c.multiplyScalar(1.06);
  };

  // stepped quays under each tower; the channel between stays open water
  for (const qs of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      ash.add(box(15 - i * 2.4, 1.15, 27 - i * 3.2, 0.12), weather(i % 2 ? stoneD : stoneC),
        M(qs * (CH + 5.5), -0.3 + i * 0.85, 0));
    }
    // rubble and boulders at the quay feet
    for (let k = 0; k < 5; k++) {
      const r = 1.2 + rng() * 1.6;
      rocks.add(rockGeometry(seed + qs * 13 + k, { r, sy: 0.6, rock: rockHex, cover: 0, strata: 0.8, detail: 1 }), null,
        M(qs * (CH + 5.5 + (rng() - 0.5) * 12), -0.6, (rng() < 0.5 ? -1 : 1) * (12 + rng() * 3), rng() * 6));
    }
  }

  for (const side of [-1, 1]) {
    const tx = side * (CH + 4);
    // battered pylon towers in three courses, each with a moulded cap
    const tiers = [[8.4, 7.2, 10, 5], [7.2, 6.2, 9, 14.5], [6.0, 5.2, 7.5, 22.75]];
    for (const [w, d, h, y] of tiers) {
      const b = box(w, h, d, 0.18, 1);
      const p = b.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const k = 1 - 0.07 * (p.getY(i) / h + 0.5);      // batter: lean inward as it rises
        p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
      }
      ash.add(b, weather(stoneC), M(tx, y, 0), 0.22);
      ash.add(box(w * 0.98 + 0.6, 0.55, d * 0.98 + 0.6, 0.12), stoneD, M(tx, y + h / 2 + 0.1, 0));
    }
    // crenellated crown
    for (let k = 0; k < 3; k++) {
      for (const zz of [-1.9, 0, 1.9]) {
        ash.add(box(1.3, 1.6, 1.1, 0.12), weather(stoneC), M(tx + (k - 1) * 1.9, 27.4, zz));
      }
    }
    // a tall accent-lit window slit on the inner face, in a carved frame
    ash.add(box(0.5, 6.2, 1.8, 0.1), stoneD, M(tx - side * 3.35, 15, 0));
    glyph.add(box(0.2, 4.6, 0.7), 0xffffff, M(tx - side * 3.62, 15, 0));
    // colossal columns framing the channel mouth, fore & aft, with entablature
    for (const zz of [-5, 5]) {
      addColumn(cols, side * (CH - 1.2), 0.9, zz, 12.4, stoneC.clone().lerp(new THREE.Color(0xffffff), 0.25));
    }
    ash.add(box(3.2, 1.5, 13.5, 0.1), stoneC, M(side * (CH - 1.2), 14.2, 0));
    // a bronze fire bowl on a fluted stand at the fore mouth
    bronze.add(lathe([[1.4, 0], [1.2, 0.5], [0.8, 1.0], [0.75, 5.2], [1.0, 5.4], [1.0, 5.4], [1.9, 6.2], [2.0, 6.5], [1.85, 6.55], [0.0, 6.3]], 16),
      (x, y, z, nx, ny, nz, c) => { c.setHex(y > 5.3 ? 0x8a6230 : 0x6a5a48); }, M(side * (CH + 0.8), 0.9, 7));
  }

  // the great arch: a semicircular vault of voussoirs with a keystone
  {
    const R0 = CH + 0.6, R1 = CH + 3.4, springY = 12.0, depth = 4.4, n = 15;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI, a1 = ((i + 1) / n) * Math.PI;
      const s = new THREE.Shape();
      const gap = 0.012;
      s.moveTo(Math.cos(a0 + gap) * R0, Math.sin(a0 + gap) * R0);
      s.lineTo(Math.cos(a0 + gap) * R1, Math.sin(a0 + gap) * R1);
      s.lineTo(Math.cos(a1 - gap) * R1, Math.sin(a1 - gap) * R1);
      s.lineTo(Math.cos(a1 - gap) * R0, Math.sin(a1 - gap) * R0);
      s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 1, curveSegments: 1 });
      geo.translate(0, 0, -depth / 2);
      const key = i === (n - 1) / 2;
      ash.add(geo.toNonIndexed(), weather(key ? stoneC.clone().multiplyScalar(1.1) : (i % 2 ? stoneC : stoneC.clone().multiplyScalar(0.94))),
        M(0, springY, 0, 0, key ? 1.06 : 1), 0.22);
    }
    // the spandrel walls and attic above the arch
    ash.add(box(2 * CH + 8, 4.0, 4.0, 0.14), weather(stoneC), M(0, springY + R1 + 1.4, 0), 0.22);
    ash.add(box(2 * CH + 9, 0.7, 4.8, 0.14), stoneD, M(0, springY + R1 + 3.7, 0));
    // the realm's emblem: a carved roundel over the keystone that glows
    const medal = new THREE.Mesh(cached('geo:gatemedal', () => new THREE.CircleGeometry(2.1, 40)),
      new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(2.2), alphaMap: motifTexture(MOTIF[realm] || 'sun'),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    medal.position.set(0, springY + R1 + 1.35, 2.18);
    g.add(medal);
    const medalB = medal.clone();
    medalB.position.z = -2.18; medalB.rotation.y = Math.PI;
    g.add(medalB);
    ash.add(lathe([[2.5, 0], [2.5, 0.25], [2.3, 0.35], [0, 0.35]], 32), stoneD, M(0, springY + R1 + 1.35, 1.75, 0, 1, 1, 1, Math.PI / 2));
    ash.add(lathe([[2.5, 0], [2.5, 0.25], [2.3, 0.35], [0, 0.35]], 32), stoneD, M(0, springY + R1 + 1.35, -1.75, 0, 1, 1, 1, -Math.PI / 2));
    // glowing glyph band along the attic
    for (let i = -6; i <= 6; i++) {
      if (Math.abs(i) < 2) continue;
      glyph.add(box(0.7, 0.8, 0.12), 0xffffff, M(i * 1.6, springY + R1 + 0.2, 2.06));
    }
  }

  // long banners in the realm's colour beside the opening
  const ban = new Parts();
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(2.4, 9.5, 2, 8);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setZ(i, Math.sin(p.getY(i) * 0.7 + side) * 0.18);
      if (p.getY(i) < -4.6) p.setY(i, p.getY(i) - Math.abs(p.getX(i)) * 0.35 + 0.42);  // swallow-tail
    }
    geo.computeVertexNormals();
    ban.add(geo, (x, y, z, nx, ny, nz, c) => {
      c.copy(accent);
      if (y > 4.2 || Math.abs(x) > 1.0) c.lerp(new THREE.Color(0xd9a441), 0.8);
    }, M(side * (CH - 3.0), 10.0, 2.4), 0, true);
    bronze.add(new THREE.CylinderGeometry(0.08, 0.08, 2.9, 6).rotateZ(Math.PI / 2), 0xc9993f, M(side * (CH - 3.0), 14.8, 2.4));
  }

  for (const [p, m] of [[ash, mat.ashlar()], [cols, columnMat()], [bronze, mat.bronze()], [rocks, mat.rock()], [ban, mat.cloth()]]) {
    const mm = p.mesh(m);
    if (mm) { if (p === ash || p === rocks) onShore(mm); g.add(mm); }
  }
  const gm = glyph.mesh(mat.glow(accent.getHex(), 2.4), { cast: false });
  if (gm) g.add(gm);

  // the fire bowls blaze in the accent (bloom carries them; ONE real light)
  for (const side of [-1, 1]) {
    const f = flame({ w: 2.6, h: 3.8, color: accent.clone().lerp(new THREE.Color(0xffb060), 0.35).getHex(),
      glow: 1.4, seed: seed + side * 5, halo: 0.55, fog: false });
    f.position.set(side * (CH + 0.8), 0.9 + 6.4, 7);
    f.name = 'brazier';
    g.add(f);
  }
  const light = new THREE.PointLight(accent, 9, 46, 1.8);
  light.position.set(0, 9, 7);
  g.add(light);

  // a soft accent haze breathing in the opening
  const haze = glowSprite(accent.getHex(), 13, 0.16);
  haze.position.set(0, 8.5, 0);
  g.add(haze);
  // marker ring on the water (keeps the 'foam' pulse hook)
  const ring = new THREE.Mesh(cached('geo:gatering', () => new THREE.RingGeometry(5, 7, 48).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.28, depthWrite: false,
      side: THREE.DoubleSide, map: tex.ring() }));
  ring.position.y = 0.05;
  ring.name = 'foam';
  g.add(ring);
  return g;
}

/* the wall pass dressing (wall.js): a carved lintel block with a glowing
   groove — returns {group, flames} with the flames for wall.js to flicker */
export function makePassLintel(rockHex, accentHex, seed) {
  const g = new THREE.Group();
  const stoneC = new THREE.Color(rockHex).lerp(new THREE.Color(0xd8d0c0), 0.35);
  const p = new Parts(), gl = new Parts();
  // long enough that both ends bite deep into the pass walls (never floats)
  p.add(box(10, 5, 84, 0.3), (x, y, z, nx, ny, nz, c) => { c.copy(stoneC); c.multiplyScalar(0.85 + 0.15 * Math.sin(z * 0.9)); }, M(0, 30, 0), 0.2);
  p.add(box(11, 0.8, 85, 0.15), stoneC.clone().multiplyScalar(0.8), M(0, 32.8, 0));
  for (let k = -7; k <= 7; k++) gl.add(box(10.4, 0.8, 0.9), 0xffffff, M(0, 28.2, k * 2.2));
  const pm = p.mesh(mat.ashlar()); g.add(pm);
  g.add(gl.mesh(mat.glow(accentHex, 2.2), { cast: false }));
  return g;
}

/* a monumental fire bowl on a stone pillar (wall passes, realm backdrops) */
export function makeBrazierPillar(accentHex, h = 9, seed = 1) {
  const g = new THREE.Group();
  const p = new Parts(), b = new Parts();
  p.add(lathe([[1.7, 0], [1.7, 0.6], [1.5, 0.7], [1.15, 1.0], [1.0, h - 0.6], [1.3, h - 0.4], [1.3, h], [0, h]], 12), 0x6c6660);
  b.add(lathe([[0.9, 0], [1.5, 0.5], [1.95, 1.3], [2.0, 1.45], [1.85, 1.5], [0, 1.2]], 16), 0x7a5a32, M(0, h, 0));
  g.add(p.mesh(mat.stone()), b.mesh(mat.bronze()));
  const f = flame({ w: 2.6, h: 3.6, color: new THREE.Color(accentHex).lerp(new THREE.Color(0xffb060), 0.35).getHex(),
    glow: 1.5, seed, halo: 0.6 });
  f.position.y = h + 1.2;
  f.name = 'brazier';
  g.add(f);
  return g;
}

/* ── battle-set landmarks ───────────────────────────────────────────────────
 * The battle dioramas (realms/battle_sets.js) mount landmarks through a kit
 * function `structure(id, {h, ry, onReady})`. islands.js hands them this one:
 * ids with a procedural remake get it (scaled to the requested height),
 * everything else falls through to the GLB loader `fallback`. */
const BATTLE_REMAKES = {
  temple: () => makeShrineTemple('#ffc060', 'hub', false, 11, 'prostyle'),
  temple_autumn: () => makeShrineTemple('#ff8a3a', 'autumn', false, 12, 'prostyle'),
  lighthouse: () => makeLighthouse(),
};
const _hb = new THREE.Box3(), _hm = new THREE.Box3();
export function battleStructure(fallback) {
  return (id, opts = {}) => {
    const make = BATTLE_REMAKES[id];
    if (!make) return fallback(id, opts);
    const g = new THREE.Group();
    const m = make();
    // height of the solid model (sprites and flames don't count)
    m.updateMatrixWorld(true);
    _hb.makeEmpty();
    m.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _hb.union(_hm.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
    });
    const hNow = Math.max(0.05, _hb.max.y - Math.max(0, _hb.min.y));
    if (opts.h) m.scale.multiplyScalar(opts.h / hNow);
    g.rotation.y = opts.ry || 0;
    g.add(m);
    if (opts.onReady) opts.onReady(m);
    return g;
  };
}

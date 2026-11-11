/*
 * models/wonders.js — set pieces for the roaming WORLD wonders that
 * models/eventprops.js does not already cover (events.py → room.world →
 * worldfx.js). Same contract as eventprops.js: every builder returns a
 * THREE.Group with its origin at its foot / at the sea-level reference
 * (things that float sit right when the group is at y = 0 and the group is
 * placed at the sea surface), cached shared geometry and materials, and a
 * self-animating userData.update(t) (pass { auto: false } to drive it).
 *
 *   makeWonderBeacon({ color, r, h })   soft light pool + a tall light shaft,
 *                                       so a wonder reads from the board camera
 *   makeCaravan()                       three laden camels and a drover
 *   makeSandstorm()                     a turning column of blown sand
 *   makeMirage()                        palms and a pool that shimmer in and out
 *   makeScarab()                        a giant beetle rolling a ball of gold
 *   makeBarge()                         a garlanded party barge, goat aboard
 *   makeGoldfish()                      a golden fish leaping round its spot
 *   makeGhostShip()                     a translucent green galley in a mist
 *   makeWhales()                        two humpbacks surfacing and spouting
 *   makeHermesParcel()                  a winged parcel with a winged hat
 *   makeAutomaton()                     a bronze pebble-player on a raft
 *   makeTurtleIsle()                    a sea turtle with a palm island on its back
 *   makeIcarusWreck()                   feathered wings awash, a sulking boy on a rock
 *
 * WONDER_PROPS maps a short id to each builder (modeltest.html contact sheet).
 * Budget: each is a handful of merged meshes and a few sprites.
 */
import { THREE, cached, mat, Parts, M, lathe, box, tube, blob, rockGeometry, glowSprite, animate,
  smooth, mulberry32, tex } from './kit.js';
import { makeShip } from '../ship.js';
import { softDiscTexture } from '../util.js';
import { makeFestivalPavilion, makeGoat } from './eventprops.js';

function finish(g, update, opts) {
  if (update) {
    g.userData.update = update;
    if (opts.auto !== false) animate(g, update);
  }
  return g;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* a lofted body along +x: prof(u) → [x, ry (half-height), rz (half-width), yc] */
function loftX(prof, NX = 20, NR = 12) {
  const pos = [], idx = [];
  for (let i = 0; i <= NX; i++) {
    const [x, ry, rz, yc] = prof(i / NX);
    for (let j = 0; j <= NR; j++) {
      const a = (j / NR) * Math.PI * 2;
      pos.push(x, yc + Math.sin(a) * Math.max(0.004, ry), Math.cos(a) * Math.max(0.004, rz));
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j, b = a + 1, c = a + NR + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);              // outward-facing
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* a thin tapered blade (leaf, feather, fin) along +x, drooping by `droop` */
function blade(len, w, droop = 0, segs = 6) {
  const g = new THREE.PlaneGeometry(len, w, segs, 1).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) + len / 2) / len;
    const taper = Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.95)) * (1 - u * 0.35);
    p.setXYZ(i, u * len, -droop * u * u * len, p.getZ(i) * taper);
  }
  g.computeVertexNormals();
  return g;
}

/* ── the beacon: a soft light pool and a shaft of light ─────────────────── */
export function makeWonderBeacon(opts = {}) {
  const color = new THREE.Color(opts.color ?? 0xffd070);
  const r = opts.r ?? 6, h = opts.h ?? 16;
  const g = new THREE.Group();
  const pool = new THREE.Mesh(cached('geo:wbpool', () => new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color, map: softDiscTexture(), transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  pool.scale.setScalar(r);
  pool.position.y = 0.22;
  pool.renderOrder = 1;
  g.add(pool);
  const beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.shaft(), color: color.clone().multiplyScalar(1.4),
    transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false }));
  beam.center.set(0.5, 0.0);
  beam.scale.set(1.5, h, 1);
  beam.position.y = 0.2;
  g.add(beam);
  const ph = (opts.seed ?? 1) * 1.7;
  return finish(g, (t) => {
    const k = 0.5 + 0.5 * Math.sin(t * 1.6 + ph);
    pool.material.opacity = 0.24 + 0.14 * k;
    beam.material.opacity = 0.26 + 0.16 * k;
    beam.scale.x = 1.3 + 0.4 * k;
  }, opts);
}

/* ── palms (shared by the mirage and the turtle isle) ──────────────────── */
function palmParts(p, x, z, h, lean, seed, base = 0) {
  const rng = mulberry32(seed);
  const top = V(x + Math.cos(lean) * h * 0.22, base + h, z + Math.sin(lean) * h * 0.22);
  p.add(tube([V(x, base, z), V(x + Math.cos(lean) * h * 0.06, base + h * 0.5, z + Math.sin(lean) * h * 0.06), top],
    0.16 * h / 4, 0.09 * h / 4, 8, 6), (px, py, pz, nx, ny, nz, c) => {
    c.setHex(0x8a6a44);
    if (Math.sin(py * 9) > 0.6) c.setHex(0x6e5236);           // ringed trunk
  });
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rng() * 0.4;
    const lf = blade(h * 0.42, h * 0.11, 0.55 + rng() * 0.3);
    p.add(lf, (px, py, pz, nx, ny, nz, c) => { c.setHex(0x3f7a32).lerp(new THREE.Color(0x8fb04a), smooth(0.2, 1, Math.abs(ny))); },
      M(top.x, top.y, top.z, -a, 1, 1, 1, 0, 0.18));
  }
  p.add(blob(0.12 * h / 4, 1), 0x5a3a1c, M(top.x, top.y - 0.08, top.z));
}

/* ── caravan ────────────────────────────────────────────────────────────── */
function camelParts(load) {
  return cached('geo:camel:' + load, () => {
    const hide = (x, y, z, nx, ny, nz, c) => { c.setHex(0xc39260).lerp(new THREE.Color(0xe8cfa2), smooth(0.1, -0.8, ny) * 0.7); };
    const b = new Parts(), cloth = new Parts(), head = new Parts();
    b.add(blob(0.5, 2), hide, M(0, 1.55, 0, 0, 1.55, 0.78, 0.7));
    b.add(blob(0.42, 2), hide, M(-0.05, 1.95, 0, 0, 1.0, 0.85, 0.85));            // the hump
    b.add(tube([V(0.6, 1.6, 0), V(0.95, 1.85, 0), V(1.1, 2.35, 0)], 0.2, 0.13, 8, 8), hide);
    for (const [x, z] of [[0.48, 0.2], [0.48, -0.2], [-0.5, 0.2], [-0.5, -0.2]]) {
      b.add(tube([V(x, 1.4, z), V(x + 0.05, 0.75, z), V(x - 0.02, 0.06, z)], 0.11, 0.06, 6, 6), hide);
      b.add(blob(0.08, 1, 0.5), 0x5a4632, M(x + 0.03, 0.03, z, 0, 1.4, 1, 1.1));
    }
    b.add(tube([V(-0.72, 1.7, 0), V(-0.86, 1.3, 0), V(-0.84, 1.0, 0)], 0.04, 0.02, 5, 4), 0x8a6a44);
    // head (pivot at the neck top): long muzzle, droopy lip, ears
    head.add(blob(0.17, 2), hide, M(0.12, 0.02, 0, 0, 1.75, 0.85, 0.8));
    head.add(blob(0.1, 1), 0xb08050, M(0.34, -0.05, 0, 0, 1.2, 0.8, 0.9));
    head.add(new THREE.SphereGeometry(0.025, 6, 4), 0x1a1410, M(0.15, 0.08, 0.1));
    head.add(new THREE.SphereGeometry(0.025, 6, 4), 0x1a1410, M(0.15, 0.08, -0.1));
    for (const s of [-1, 1]) head.add(new THREE.ConeGeometry(0.035, 0.1, 5), 0xa07a4c, M(-0.04, 0.14, s * 0.08, 0, 1, 1, 1, s * 0.4));
    if (load) {
      // a striped saddle rug, two panniers and a lashed bundle of pots
      const rug = (x, y, z, nx, ny, nz, c) => { c.setHex(Math.floor((x + 2) * 6) % 2 ? 0x9a2e2a : 0xd9a441); };
      cloth.add(box(0.95, 0.06, 0.95, 0.03), rug, M(-0.05, 2.32, 0));
      for (const s of [-1, 1]) {
        cloth.add(box(0.5, 0.42, 0.22, 0.08), 0x3f5f8a, M(-0.05, 1.82, s * 0.5));
        cloth.add(blob(0.18, 1), 0xb8714a, M(0.1, 1.98, s * 0.55, 0, 1, 1.3, 1));
      }
      cloth.add(new THREE.CylinderGeometry(0.15, 0.15, 0.8, 10).rotateX(Math.PI / 2), 0xe8dcc0, M(-0.05, 2.5, 0));
    }
    return { body: b.geometry(), cloth: load ? cloth.geometry() : null, head: head.geometry() };
  });
}
function makeCamel(load, seed) {
  const g = new THREE.Group();
  const parts = camelParts(load);
  const body = new THREE.Mesh(parts.body, mat.plain());
  body.castShadow = true;
  const head = new THREE.Mesh(parts.head, mat.plain());
  head.position.set(1.12, 2.4, 0);
  head.castShadow = true;
  g.add(body, head);
  if (parts.cloth) {
    const c = new THREE.Mesh(parts.cloth, mat.cloth());
    c.castShadow = true;
    g.add(c);
  }
  g.userData.head = head;
  g.userData.ph = seed * 1.3;
  return g;
}
function drover() {
  return cached('geo:drover', () => {
    const p = new Parts();
    p.add(lathe([[0.0, 0], [0.3, 0], [0.28, 0.4], [0.22, 0.9], [0.17, 1.15], [0.0, 1.2]], 14), 0xe9e0cc);
    p.add(blob(0.14, 2), 0x8a5a3a, M(0, 1.33, 0));
    p.add(blob(0.17, 2), 0x2f5f8a, M(0, 1.4, 0, 0, 1, 0.7, 1));
    p.add(tube([V(0, 1.42, -0.12), V(-0.1, 1.2, -0.22), V(-0.12, 0.95, -0.2)], 0.05, 0.04, 5, 5), 0x2f5f8a);
    p.add(tube([V(0.2, 0.0, 0.25), V(0.18, 1.6, 0.25)], 0.03, 0.025, 2, 5), 0x6a4a2c);     // a staff
    return p.geometry();
  });
}
export function makeCaravan(opts = {}) {
  const g = new THREE.Group();
  const camels = [];
  for (let i = 0; i < 3; i++) {
    const c = makeCamel(true, i);
    c.position.set(-i * 2.6, 0, Math.sin(i * 1.4) * 0.6);
    c.rotation.y = Math.sin(i * 1.4) * 0.2;
    g.add(c);
    camels.push(c);
  }
  // a lead rope between them
  const rope = new Parts();
  for (let i = 0; i < 2; i++) {
    const a = camels[i].position, b = camels[i + 1].position;
    rope.add(tube([V(a.x - 0.85, 1.65, a.z), V((a.x + b.x) / 2 + 0.3, 1.25, (a.z + b.z) / 2), V(b.x + 1.35, 2.2, b.z)], 0.02, 0.02, 8, 3), 0x6a5034);
  }
  g.add(rope.mesh(mat.wood(), { cast: false }));
  const man = new THREE.Mesh(drover(), mat.cloth());
  man.position.set(2.0, 0, 0.5);
  man.castShadow = true;
  g.add(man);
  g.scale.setScalar(opts.scale ?? 1.25);
  return finish(g, (t) => {
    for (const c of camels) {
      const ph = t * 1.1 + c.userData.ph;
      c.userData.head.rotation.z = Math.sin(ph) * 0.12 - 0.05;
      c.userData.head.rotation.y = Math.sin(ph * 0.4) * 0.25;
      c.position.y = Math.abs(Math.sin(ph * 0.5)) * 0.03;
    }
    man.rotation.y = Math.sin(t * 0.3) * 0.5;
  }, opts);
}

/* ── sandstorm ──────────────────────────────────────────────────────────── */
function dustTexture() {
  return cached('tex:dust', () => {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    const rng = mulberry32(41);
    for (let i = 0; i < 26; i++) {
      const x = S * (0.2 + rng() * 0.6), y = S * (0.25 + rng() * 0.5), rr = S * (0.1 + rng() * 0.2);
      const gr = c.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr; c.fillRect(0, 0, S, S);
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}
export function makeSandstorm(opts = {}) {
  const g = new THREE.Group();
  const rng = mulberry32(opts.seed ?? 5);
  const dark = new THREE.SpriteMaterial({ map: dustTexture(), color: 0xa8784a, transparent: true, opacity: 0.85, depthWrite: false });
  const light = new THREE.SpriteMaterial({ map: dustTexture(), color: 0xe0b47a, transparent: true, opacity: 0.7, depthWrite: false });
  const puffs = [];
  const N = 18, H = opts.h ?? 13;
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1);
    const sp = new THREE.Sprite(i % 3 ? dark : light);
    const s = 3.2 + k * 5.5 + rng() * 1.5;
    sp.scale.set(s * 1.25, s, 1);
    g.add(sp);
    puffs.push({ sp, k, r: 0.6 + k * 3.2, y: 0.8 + k * H, a: rng() * 6.28, sp0: 1.3 - k * 0.6 });
  }
  // a skirt of low dust and a dark scour on the ground
  for (let i = 0; i < 5; i++) {
    const sp = new THREE.Sprite(dark);
    sp.scale.set(7, 2.6, 1);
    g.add(sp);
    puffs.push({ sp, k: 0, r: 4.2, y: 0.9, a: (i / 5) * 6.28, sp0: 0.5 });
  }
  const scour = new THREE.Mesh(cached('geo:wbpool', () => new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: 0x3a2412, map: softDiscTexture(), transparent: true, opacity: 0.35, depthWrite: false }));
  scour.scale.setScalar(6.5);
  scour.position.y = 0.06;
  g.add(scour);
  return finish(g, (t) => {
    for (const p of puffs) {
      const a = p.a + t * p.sp0;
      const sway = Math.sin(t * 0.5 + p.k * 3) * p.k * 1.4;
      p.sp.position.set(Math.cos(a) * p.r + sway, p.y + Math.sin(t * 0.9 + p.a) * 0.3, Math.sin(a) * p.r);
    }
  }, opts);
}

/* ── mirage ─────────────────────────────────────────────────────────────── */
export function makeMirage(opts = {}) {
  const g = new THREE.Group();
  const p = new Parts();
  palmParts(p, -1.6, 0.4, 4.4, 0.4, 3);
  palmParts(p, 1.4, -0.9, 3.6, 2.6, 7);
  palmParts(p, 0.3, 2.1, 3.1, 1.6, 11);
  p.add(rockGeometry(23, { r: 0.7, sy: 0.5, rock: 0xc9a06a, detail: 1 }), null, M(2.0, 0.05, 1.2));
  const ghost = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, transparent: true, opacity: 0.8 });
  const palms = p.mesh(ghost, { cast: false });
  g.add(palms);
  const water = new THREE.Mesh(cached('geo:miragepool', () => new THREE.CircleGeometry(1, 36).rotateX(-Math.PI / 2)),
    new THREE.MeshStandardMaterial({ color: 0x2f8fa8, emissive: 0x2a9ac0, emissiveIntensity: 0.6, roughness: 0.05,
      metalness: 0.1, transparent: true, opacity: 0.8 }));
  water.scale.set(2.8, 1, 1.9);
  water.position.set(0, 0.08, 0.2);
  g.add(water);
  const shimmer = glowSprite(0xbff4ff, 7, 0.35);
  shimmer.position.y = 1.4;
  g.add(shimmer);
  return finish(g, (t) => {
    // it wavers: fades, stretches, swims sideways in the heat
    const k = 0.5 + 0.5 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1);
    ghost.opacity = 0.35 + 0.55 * k;
    water.material.opacity = 0.3 + 0.6 * k;
    palms.scale.set(1 + Math.sin(t * 2.3) * 0.02, 1 + Math.sin(t * 1.7) * 0.05, 1);
    palms.position.x = Math.sin(t * 1.3) * 0.12;
    shimmer.material.opacity = 0.15 + 0.3 * (1 - k);
  }, opts);
}

/* ── scarab and its golden ball ─────────────────────────────────────────── */
function scarabParts() {
  return cached('geo:scarab', () => {
    const shell = new Parts(), legs = new Parts();
    const sheen = (x, y, z, nx, ny, nz, c) => { c.setHex(0x1f3a2c).lerp(new THREE.Color(0x4a8a5a), smooth(0.3, 1, ny) * 0.6); };
    shell.add(blob(0.7, 2), sheen, M(-0.2, 0.55, 0, 0, 1.25, 0.6, 0.95));
    shell.add(box(0.04, 0.3, 1.2, 0.0), 0x0e1a14, M(-0.2, 0.92, 0));                  // the wing seam
    shell.add(blob(0.42, 2), sheen, M(0.62, 0.5, 0, 0, 0.8, 0.6, 1.1));               // pronotum
    shell.add(blob(0.24, 1), 0x15241c, M(0.98, 0.42, 0, 0, 0.8, 0.5, 1.2));           // head
    for (let k = 0; k < 5; k++) shell.add(new THREE.ConeGeometry(0.05, 0.16, 4).rotateZ(-Math.PI / 2), 0x15241c, M(1.18, 0.42, -0.2 + k * 0.1));
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const x = 0.55 - k * 0.5;
        legs.add(tube([V(x, 0.4, s * 0.45), V(x + 0.1, 0.55, s * 0.95), V(x + 0.25 - k * 0.2, 0.02, s * 1.2)], 0.06, 0.03, 6, 5), 0x15241c);
      }
    }
    return { shell: shell.geometry(), legs: legs.geometry() };
  });
}
export function makeScarab(opts = {}) {
  const g = new THREE.Group();
  const parts = scarabParts();
  const bug = new THREE.Group();
  const shell = new THREE.Mesh(parts.shell, cached('mat:scarab', () => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.25, metalness: 0.55 })));
  shell.castShadow = true;
  const legs = new THREE.Mesh(parts.legs, mat.plain());
  bug.add(shell, legs);
  bug.rotation.y = Math.PI;                      // it pushes backwards, head down
  bug.rotation.z = -0.25;
  bug.position.set(1.9, 0.15, 0);
  g.add(bug);
  const ball = new THREE.Mesh(cached('geo:goldball', () => {
    const geo = blob(1.0, 3);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.05 * Math.sin(x * 7 + y * 5) * Math.sin(z * 6);
      p.setXYZ(i, x * k, y * k, z * k);
    }
    geo.computeVertexNormals();
    return geo;
  }), mat.gold());
  if (!ball.geometry.attributes.color) {
    const n = ball.geometry.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = 0.95; col[i * 3 + 1] = 0.72; col[i * 3 + 2] = 0.3; }
    ball.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  ball.position.set(0, 1.0, 0);
  ball.castShadow = true;
  g.add(ball);
  const glint = glowSprite(0xffe08a, 2.6, 0.5);
  glint.position.set(-0.3, 1.6, 0.4);
  g.add(glint);
  g.scale.setScalar(opts.scale ?? 1.3);
  return finish(g, (t) => {
    ball.rotation.z = t * 0.9;
    bug.position.y = 0.15 + Math.abs(Math.sin(t * 5)) * 0.04;
    legs.rotation.x = Math.sin(t * 9) * 0.06;
    glint.material.opacity = 0.3 + 0.4 * Math.max(0, Math.sin(t * 2.7));
  }, opts);
}

/* ── the runaway festival barge ─────────────────────────────────────────── */
function bargeParts() {
  return cached('geo:barge', () => {
    const p = new Parts();
    // a broad flat hull with a swept prow and stern post
    const hull = loftX((u) => {
      const x = -4.2 + u * 8.4;
      const end = Math.min(1, Math.min(u, 1 - u) * 5);
      return [x, 0.55 * (0.6 + 0.4 * end), 2.0 * Math.sqrt(end), 0.15 + (1 - end) * 0.35];
    }, 24, 14);
    p.add(hull, (x, y, z, nx, ny, nz, c) => {
      c.setHex(y > 0.35 ? 0xb88a52 : 0x6a4a2e);
      if (Math.abs(y - 0.45) < 0.06) c.setHex(0x2f6fae);                // a painted band
    });
    p.add(box(7.4, 0.12, 3.4, 0.04), 0xc9a06a, M(0, 0.62, 0));                          // the deck
    p.add(tube([V(4.0, 0.6, 0), V(4.6, 1.3, 0), V(4.5, 2.0, 0)], 0.16, 0.1, 8, 7), 0x8a5a34);   // prow post
    p.add(tube([V(-4.0, 0.6, 0), V(-4.4, 1.4, 0), V(-4.0, 1.9, 0)], 0.16, 0.08, 8, 7), 0x8a5a34);
    for (const s of [-1, 1]) {
      p.add(tube([V(-3.4, 0.95, s * 1.62), V(0, 1.0, s * 1.75), V(3.4, 0.95, s * 1.62)], 0.05, 0.05, 10, 5), 0xe9dcc0);
      for (let k = 0; k < 7; k++) p.add(new THREE.CylinderGeometry(0.04, 0.04, 0.38, 5), 0xe9dcc0, M(-3.2 + k * 1.07, 0.8, s * 1.68));
    }
    // amphorae, a wine krater and a drum on deck
    for (const [x, z] of [[-2.8, 0.9], [-2.9, -0.8], [2.7, 1.0]]) p.add(lathe([[0, 0], [0.14, 0], [0.26, 0.25], [0.22, 0.55], [0.1, 0.68], [0.12, 0.78], [0, 0.76]], 12), 0xb8643c, M(x, 0.68, z));
    p.add(lathe([[0, 0], [0.3, 0], [0.3, 0.32], [0, 0.32]], 14), 0xd9a441, M(2.6, 0.68, -0.9));
    return p.geometry();
  });
}
export function makeBarge(opts = {}) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(bargeParts(), mat.wood());
  deck.castShadow = true; deck.receiveShadow = true;
  deck.position.y = -0.55;
  g.add(deck);
  const pav = makeFestivalPavilion({ hue: opts.hue ?? 0x2f6fae });
  pav.scale.setScalar(0.62);
  pav.position.set(-0.3, 0.12, 0);
  g.add(pav);
  const goat = makeGoat({ coat: 0xe8e0d0, seed: 3 });
  goat.scale.setScalar(1.0);
  goat.position.set(2.4, 0.12, 0.6);
  goat.rotation.y = 2.4;
  g.add(goat);
  const glow = glowSprite(0xffb050, 6, 0.35);
  glow.position.y = 2.2;
  g.add(glow);
  return finish(g, (t) => {
    glow.material.opacity = 0.28 + 0.1 * Math.sin(t * 3.1);
  }, opts);
}

/* ── the golden fish ────────────────────────────────────────────────────── */
function goldfishGeo() {
  return cached('geo:goldfish', () => {
    const p = new Parts();
    const body = loftX((u) => {
      const x = -1 + u * 2;
      const r = Math.sin(Math.PI * Math.min(1, 0.08 + u * 0.98)) ** 0.8;
      return [x, 0.42 * r + 0.03, 0.2 * r + 0.02, 0.04 * Math.sin(u * Math.PI)];
    }, 18, 12);
    p.add(body, (x, y, z, nx, ny, nz, c) => {
      c.setHex(0xf2b030).lerp(new THREE.Color(0xfff0b0), smooth(-0.2, -0.9, ny) * 0.6);
      if (x > 0.62 && x < 0.74 && y > 0.06 && Math.abs(z) > 0.08) c.setHex(0x1a1208);    // eye
    });
    // a forked tail, a sail-like dorsal and two trailing pelvic fins
    const tail = new THREE.BufferGeometry().setFromPoints([
      V(-0.95, 0, 0), V(-1.6, 0.55, 0), V(-1.35, 0, 0), V(-0.95, 0, 0), V(-1.35, 0, 0), V(-1.6, -0.5, 0)]);
    p.add(tail, 0xe89a20);
    const dorsal = new THREE.BufferGeometry().setFromPoints([V(0.35, 0.38, 0), V(-0.6, 0.3, 0), V(-0.15, 0.85, 0)]);
    p.add(dorsal, 0xe89a20);
    for (const s of [-1, 1]) {
      p.add(new THREE.BufferGeometry().setFromPoints([V(0.2, -0.3, s * 0.1), V(-0.35, -0.32, s * 0.14), V(-0.2, -0.7, s * 0.3)]), 0xe89a20);
    }
    return p.geometry();
  });
}
export function makeGoldfish(opts = {}) {
  const g = new THREE.Group();
  const r = opts.r ?? 3.5;
  const fish = new THREE.Mesh(goldfishGeo(), cached('mat:goldfish', () => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.22, metalness: 0.75, emissive: 0x7a4a08, emissiveIntensity: 0.5,
    side: THREE.DoubleSide })));
  fish.castShadow = true;
  fish.scale.setScalar(opts.scale ?? 1.3);
  g.add(fish);
  const ring = new THREE.Mesh(cached('geo:goldring', () => new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
      depthWrite: false }));
  ring.position.y = 0.25;
  g.add(ring);
  const sparks = [];
  for (let i = 0; i < 4; i++) {
    const s = glowSprite(0xffe9a0, 0.9, 0.0);
    g.add(s);
    sparks.push(s);
  }
  const PERIOD = 2.6;
  return finish(g, (t) => {
    const a = t * 0.55;
    const k = (t % PERIOD) / PERIOD;
    const leap = k < 0.5 ? Math.sin((k / 0.5) * Math.PI) : 0;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    fish.position.set(x, -0.6 + leap * 2.8, z);
    fish.rotation.set(0, -a - Math.PI / 2, 0);
    fish.rotateZ(k < 0.5 ? Math.cos((k / 0.5) * Math.PI) * 0.8 : 0);
    fish.rotateX(Math.sin(t * 9) * 0.08);
    fish.visible = fish.position.y > -0.5;
    // the splash ring where it went in, and a glitter of drops
    const ks = (k + 0.5) % 1;
    ring.position.x = Math.cos(a - 0.5) * r;
    ring.position.z = Math.sin(a - 0.5) * r;
    ring.scale.setScalar(0.6 + ks * 2.6);
    ring.material.opacity = 0.55 * (1 - ks);
    for (let i = 0; i < sparks.length; i++) {
      const q = (ks + i * 0.07) % 1;
      sparks[i].position.set(ring.position.x + Math.cos(i * 1.7) * q * 1.2, 0.3 + Math.sin(q * Math.PI) * 1.4, ring.position.z + Math.sin(i * 1.7) * q * 1.2);
      sparks[i].material.opacity = 0.8 * (1 - q) * (q > 0.02 ? 1 : 0);
    }
  }, opts);
}

/* ── the ghost ship ─────────────────────────────────────────────────────── */
export function makeGhostShip(opts = {}) {
  const g = new THREE.Group();
  const ship = makeShip('#9fb8a8');
  const ghost = cached('mat:ghostship', () => new THREE.MeshStandardMaterial({
    color: 0x9fd8c0, emissive: 0x2aff9a, emissiveIntensity: 0.55, roughness: 0.6, transparent: true,
    opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
  ship.traverse((o) => {
    if (o.isMesh && o.name === 'wash') o.visible = false;
    else if (o.isMesh) { o.material = ghost; o.castShadow = false; }
    else if (o.isSprite || o.isPoints) o.visible = false;
  });
  ship.scale.setScalar(opts.scale ?? 1.9);
  g.add(ship);
  const mist = [];
  const mm = new THREE.SpriteMaterial({ map: softDiscTexture(), color: 0x8affc8, transparent: true, opacity: 0.18,
    blending: THREE.AdditiveBlending, depthWrite: false });
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Sprite(mm);
    s.scale.set(5.5, 2.4, 1);
    g.add(s);
    mist.push({ s, a: (i / 6) * Math.PI * 2 });
  }
  const lamp = glowSprite(0x6affb8, 3.2, 0.55);
  lamp.position.set(-2.2, 2.4, 0);
  g.add(lamp);
  return finish(g, (t) => {
    ghost.opacity = 0.4 + 0.15 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 7.1);
    for (const m of mist) m.s.position.set(Math.cos(m.a + t * 0.2) * 4.2, 0.7 + Math.sin(t + m.a) * 0.2, Math.sin(m.a + t * 0.2) * 2.2);
    lamp.material.opacity = 0.4 + 0.25 * Math.sin(t * 2.2);
  }, opts);
}

/* ── whales ─────────────────────────────────────────────────────────────── */
function whaleGeo() {
  return cached('geo:whale', () => {
    const p = new Parts();
    const body = loftX((u) => {
      const x = -3 + u * 6;
      const r = Math.sin(Math.PI * Math.min(1, 0.06 + u * 0.96)) ** 0.7;
      return [x, 0.8 * r + 0.04, 0.95 * r + 0.04, -0.1 * u];
    }, 24, 14);
    p.add(body, (x, y, z, nx, ny, nz, c) => {
      c.setHex(0x34475a).lerp(new THREE.Color(0xd8dfe2), smooth(-0.1, -0.8, ny));
      if (ny < -0.3 && Math.sin(z * 30) > 0.5 && x > -0.5) c.multiplyScalar(0.8);     // throat grooves
      if (Math.sin(x * 11) * Math.sin(z * 13) > 0.92 && ny > 0) c.setHex(0x8a949a);    // barnacles
    });
    for (const s of [-1, 1]) {
      const fin = blade(2.4, 0.6, 0.35, 6);
      p.add(fin, (x, y, z, nx, ny, nz, c) => { c.setHex(0xcfd8dc); }, M(1.2, -0.35, s * 0.6, s * -2.2, 1, 1, 1, 0, -0.3));
    }
    const fluke = (s) => new THREE.BufferGeometry().setFromPoints([
      V(-2.85, 0, 0), V(-3.9, 0.05, s * 1.25), V(-3.5, 0, s * 0.2), V(-2.85, 0, 0), V(-3.5, 0, s * 0.2), V(-3.4, 0, 0)]);
    p.add(fluke(1), 0x34475a);
    p.add(fluke(-1), 0x34475a);
    p.add(blob(0.12, 1), 0x2a3a48, M(0.9, 0.62, 0, 0, 1.4, 0.6, 1));               // blowhole hump
    return p.geometry();
  });
}
export function makeWhales(opts = {}) {
  const g = new THREE.Group();
  const m = cached('mat:whale', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38,
    metalness: 0, side: THREE.DoubleSide }));
  const whales = [];
  for (let i = 0; i < 2; i++) {
    const w = new THREE.Mesh(whaleGeo(), m);
    w.castShadow = true;
    w.scale.setScalar(i ? 1.3 : 1.6);
    g.add(w);
    whales.push(w);
  }
  const spoutM = new THREE.SpriteMaterial({ map: softDiscTexture(), color: 0xf2fbff, transparent: true, opacity: 0.0,
    depthWrite: false });
  const spout = [];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Sprite(spoutM);
    g.add(s);
    spout.push(s);
  }
  return finish(g, (t) => {
    // the big one rolls slowly along the surface, its back awash; the
    // smaller one arcs up and under on a long cycle
    const a = whales[0];
    a.position.set(Math.sin(t * 0.15) * 2.0, -0.55 + Math.sin(t * 0.6) * 0.18, -1.5);
    a.rotation.set(Math.sin(t * 0.4) * 0.12, 0.3 + Math.sin(t * 0.15) * 0.2, Math.sin(t * 0.6 + 1) * 0.05);
    const k = (t % 9) / 9;
    const arc = k < 0.45 ? Math.sin((k / 0.45) * Math.PI) : 0;
    const b = whales[1];
    b.position.set(-2.5 + k * 6, -1.6 + arc * 1.7, 2.2);
    b.rotation.set(0, -0.2, k < 0.45 ? Math.cos((k / 0.45) * Math.PI) * 0.35 : -0.4);
    b.visible = b.position.y > -1.55;
    // the spout: every few seconds from the big one's blowhole
    const ks = (t % 5) / 5;
    const on = ks < 0.35;
    spoutM.opacity = on ? 0.55 * (1 - ks / 0.35) : 0;
    for (let i = 0; i < spout.length; i++) {
      const q = i / spout.length;
      spout[i].position.set(a.position.x + 1.1 + q * 0.4, 0.4 + (ks / 0.35) * 3.2 * (0.4 + q), a.position.z);
      spout[i].scale.setScalar(0.6 + q * 1.6 + ks * 2);
    }
  }, opts);
}

/* ── Hermes' misdelivered parcel ────────────────────────────────────────── */
function wingGeo() {
  return cached('geo:featherwing', () => {
    const p = new Parts();
    for (let k = 0; k < 7; k++) {
      const len = 0.55 + k * 0.1;
      p.add(blade(len, 0.16, 0.05, 4), (x, y, z, nx, ny, nz, c) => { c.setHex(0xf6f1e4).lerp(new THREE.Color(0xd9b65a), smooth(0.4, 0.9, x / len) * 0.5); },
        M(0, 0, 0, -0.15 - k * 0.17, 1, 1, 1, 0, 0.18 + k * 0.05));
    }
    return p.geometry();
  });
}
export function makeHermesParcel(opts = {}) {
  const g = new THREE.Group();
  const fly = new THREE.Group();
  g.add(fly);
  const parcel = new Parts();
  parcel.add(box(0.9, 0.6, 0.7, 0.05), 0xb8935a, M(0, 0, 0));
  parcel.add(box(0.94, 0.05, 0.08, 0.0), 0x7a3a2a, M(0, 0.0, 0));
  parcel.add(box(0.08, 0.64, 0.74, 0.0), 0x7a3a2a, M(0, 0, 0));
  parcel.add(tube([V(0, 0.3, 0), V(0.12, 0.45, 0.08), V(-0.05, 0.42, -0.1), V(0, 0.3, 0)], 0.03, 0.03, 8, 4), 0x7a3a2a);
  // the petasos: a broad-brimmed traveller's hat, floating above
  parcel.add(lathe([[0.0, 0.0], [0.6, 0.0], [0.62, 0.04], [0.3, 0.08], [0.24, 0.3], [0.0, 0.34]], 20), 0xd9b65a, M(0, 0.62, 0));
  const pm = parcel.mesh(mat.cloth());
  fly.add(pm);
  const wings = [];
  for (const [y, s, sc] of [[0.05, 1, 1.4], [0.05, -1, 1.4], [0.72, 1, 0.7], [0.72, -1, 0.7]]) {
    const w = new THREE.Mesh(wingGeo(), mat.cloth());
    w.position.set(-0.1, y, s * (sc > 1 ? 0.38 : 0.3));
    w.scale.set(sc, sc, s * sc);
    w.rotation.y = Math.PI / 2 + 0.3;
    fly.add(w);
    wings.push({ w, s, base: w.rotation.x });
  }
  const trail = [];
  for (let i = 0; i < 6; i++) {
    const s = glowSprite(0xffe39a, 0.7 - i * 0.07, 0.5 - i * 0.07);
    g.add(s);
    trail.push(s);
  }
  g.scale.setScalar(opts.scale ?? 1.8);
  const r = opts.r ?? 2.2;
  return finish(g, (t) => {
    const a = t * 0.8;
    fly.position.set(Math.cos(a) * r, 3.2 + Math.sin(t * 2.2) * 0.35, Math.sin(a) * r);
    fly.rotation.y = -a;
    const f = Math.sin(t * 14) * 0.6;
    for (const w of wings) w.w.rotation.x = w.s * f;
    for (let i = 0; i < trail.length; i++) {
      const b = a - 0.18 * (i + 1);
      trail[i].position.set(Math.cos(b) * r, 3.2 + Math.sin(t * 2.2 - (i + 1) * 0.3) * 0.35, Math.sin(b) * r);
    }
  }, opts);
}

/* ── Daedalus' automaton ────────────────────────────────────────────────── */
function automatonParts() {
  return cached('geo:automaton', () => {
    const wood = new Parts(), bronze = new Parts(), arm = new Parts(), stone = new Parts();
    // a raft of lashed logs, a low table and a stool
    for (let k = 0; k < 7; k++) wood.add(new THREE.CylinderGeometry(0.22, 0.22, 4.2, 8).rotateX(Math.PI / 2), 0x8a6a44, M(-1.5 + k * 0.5, 0, 0));
    for (const z of [-1.5, 1.5]) wood.add(box(3.8, 0.08, 0.2, 0.0), 0x5a4030, M(0, 0.2, z));
    wood.add(lathe([[0.75, 0.62], [0.75, 0.7], [0.0, 0.7]], 20), 0xa77a4c, M(0.8, 0.2, 0));
    wood.add(new THREE.CylinderGeometry(0.08, 0.14, 0.62, 8), 0x7a5634, M(0.8, 0.51, 0));
    // the automaton: a bronze barrel torso on a pedestal, a helmed head, gears
    bronze.add(lathe([[0, 0], [0.5, 0], [0.42, 0.2], [0.34, 0.5], [0.42, 0.9], [0.46, 1.25], [0.3, 1.42], [0, 1.45]], 18),
      (x, y, z, nx, ny, nz, c) => { c.setHex(0xb07a3a); if (Math.abs(y - 0.95) < 0.04 || Math.abs(y - 0.55) < 0.04) c.setHex(0x6a4420); },
      M(-0.6, 0.2, 0));
    bronze.add(blob(0.3, 2), 0xc08a44, M(-0.6, 1.88, 0, 0, 1, 1.1, 1));
    bronze.add(box(0.12, 0.08, 0.42, 0.02), 0x2a1a0a, M(-0.33, 1.92, 0));                 // the visor slit
    bronze.add(lathe([[0.0, 0.0], [0.34, 0.0], [0.3, 0.1], [0.0, 0.2]], 16), 0xa06a30, M(-0.6, 2.12, 0));
    bronze.add(new THREE.TorusGeometry(0.28, 0.07, 6, 14), 0x8a5a28, M(-1.08, 1.2, 0, Math.PI / 2));
    bronze.add(tube([V(-0.6, 1.4, -0.42), V(-0.5, 1.0, -0.62), V(-0.35, 0.75, -0.5)], 0.08, 0.06, 6, 6), 0xb07a3a);
    // the playing arm (separate: it reaches over the board)
    arm.add(tube([V(0, 0, 0), V(0.35, -0.2, 0), V(0.75, -0.35, 0.05)], 0.08, 0.06, 6, 6), 0xb07a3a);
    arm.add(blob(0.09, 1), 0xc08a44, M(0.8, -0.36, 0.05));
    // a heap of pebbles on the board
    for (let k = 0; k < 9; k++) stone.add(blob(0.07, 1), 0xd8d0c0, M(0.7 + Math.cos(k * 2.4) * 0.2 * (k % 3), 0.95, Math.sin(k * 2.4) * 0.2 * (k % 3)));
    return { wood: wood.geometry(), bronze: bronze.geometry(), arm: arm.geometry(), stone: stone.geometry() };
  });
}
export function makeAutomaton(opts = {}) {
  const g = new THREE.Group();
  const parts = automatonParts();
  const wood = new THREE.Mesh(parts.wood, mat.wood());
  wood.receiveShadow = true;
  const bz = new THREE.Mesh(parts.bronze, mat.bronze());
  bz.castShadow = true;
  const arm = new THREE.Mesh(parts.arm, mat.bronze());
  arm.position.set(-0.45, 1.45, 0.42);
  const stones = new THREE.Mesh(parts.stone, mat.plaster());
  g.add(wood, bz, arm, stones);
  const eyes = glowSprite(0x7ad8ff, 0.7, 0.8);
  eyes.position.set(-0.3, 1.94, 0);
  g.add(eyes);
  g.scale.setScalar(opts.scale ?? 1.6);
  return finish(g, (t) => {
    const k = (t % 3.2) / 3.2;
    arm.rotation.z = -0.1 - Math.sin(Math.min(1, k * 2) * Math.PI) * 0.35;
    arm.rotation.y = Math.sin(t * 0.7) * 0.2;
    eyes.material.opacity = 0.5 + 0.4 * Math.max(0, Math.sin(t * 3.3));
  }, opts);
}

/* ── the island that is a turtle ────────────────────────────────────────── */
function turtleParts() {
  return cached('geo:turtleisle', () => {
    const shell = new Parts(), skin = new Parts(), flip = new Parts();
    const dome = lathe([[5.2, -0.5], [5.0, 0.2], [4.3, 0.95], [3.2, 1.5], [1.8, 1.85], [0.0, 1.95]], 40);
    shell.add(dome, (x, y, z, nx, ny, nz, c) => {
      // sand and turf on top, scute plates on the flanks
      const a = Math.atan2(z, x), r = Math.hypot(x, z);
      const scute = Math.abs(Math.sin(a * 6)) < 0.08 || Math.abs(Math.sin(r * 1.3)) < 0.06;
      c.setHex(0x5a6a3a).lerp(new THREE.Color(0x3c4a2c), smooth(0.6, 0.2, ny));
      if (scute) c.multiplyScalar(0.7);
      if (y > 1.2) c.setHex(0xd9c08a).lerp(new THREE.Color(0x6f9a42), smooth(1.4, 1.9, y) * 0.7);
    }, M(0, 0, 0, 0, 1, 1, 0.85));
    palmParts(shell, -0.8, 0.3, 3.6, 0.5, 13, 1.75);
    palmParts(shell, 1.0, -0.6, 3.0, 2.3, 17, 1.75);
    palmParts(shell, 0.2, 1.1, 2.6, 4.0, 19, 1.75);
    skin.add(blob(0.95, 2), (x, y, z, nx, ny, nz, c) => { c.setHex(0x6a7a52).lerp(new THREE.Color(0xc8c09a), smooth(0, -0.7, ny)); },
      M(6.1, 0.15, 0, 0, 1.35, 0.85, 0.95));
    skin.add(new THREE.SphereGeometry(0.11, 8, 6), 0x101008, M(6.9, 0.45, 0.42));
    skin.add(new THREE.SphereGeometry(0.11, 8, 6), 0x101008, M(6.9, 0.45, -0.42));
    flip.add(blob(1.0, 2), (x, y, z, nx, ny, nz, c) => { c.setHex(0x6a7a52); }, M(1.0, 0, 0, 0, 1.6, 0.18, 0.7));
    return { shell: shell.geometry(), skin: skin.geometry(), flip: flip.geometry() };
  });
}
export function makeTurtleIsle(opts = {}) {
  const g = new THREE.Group();
  const parts = turtleParts();
  const shell = new THREE.Mesh(parts.shell, mat.plain());
  shell.castShadow = true; shell.receiveShadow = true;
  const head = new THREE.Mesh(parts.skin, mat.wet());
  head.castShadow = true;
  g.add(shell, head);
  const flips = [];
  for (const [x, z, s] of [[2.8, 3.6, 1], [2.8, -3.6, -1], [-3.0, 3.2, 1], [-3.0, -3.2, -1]]) {
    const f = new THREE.Mesh(parts.flip, mat.wet());
    f.position.set(x, -0.15, z);
    f.rotation.y = s * (x > 0 ? -0.9 : -2.3);
    g.add(f);
    flips.push({ f, s, base: f.rotation.y, front: x > 0 });
  }
  g.scale.setScalar(opts.scale ?? 1);
  return finish(g, (t) => {
    for (const q of flips) q.f.rotation.y = q.base + q.s * Math.sin(t * (q.front ? 0.9 : 0.7)) * 0.35;
    head.rotation.y = Math.sin(t * 0.3) * 0.12;
    head.position.y = Math.sin(t * 0.5) * 0.08;
  }, opts);
}

/* ── Icarus, crash-landed ───────────────────────────────────────────────── */
function bigWingGeo() {
  return cached('geo:icaruswing', () => {
    const p = new Parts();
    p.add(tube([V(0, 0, 0), V(1.6, 0.1, 0.2), V(3.4, 0.05, 0.1)], 0.06, 0.04, 8, 5), 0x7a5a3a);     // the frame
    for (let k = 0; k < 17; k++) {
      const x = 0.15 + k * 0.19, len = 1.1 + Math.sin((k / 16) * Math.PI) * 1.0;
      const burnt = k > 11;
      p.add(blade(len, 0.62, 0.08, 4), (px, py, pz, nx, ny, nz, c) => {
        c.setHex(burnt ? 0x8a7a68 : 0xf4efe2).lerp(new THREE.Color(burnt ? 0x2a2018 : 0xd8b860), smooth(0.4, 1, px / 4));
      }, M(x, 0.02 + (k % 2) * 0.012, 0.1, -Math.PI / 2 - 0.3 + k * 0.035));
    }
    for (let k = 0; k < 6; k++) p.add(blob(0.06, 1, 0.5), 0xe8c050, M(0.6 + k * 0.45, 0.05, 0.4 + (k % 2) * 0.3));   // wax drips
    return p.geometry();
  });
}
export function makeIcarusWreck(opts = {}) {
  const g = new THREE.Group();
  const wm = mat.cloth();
  const w1 = new THREE.Mesh(bigWingGeo(), wm);
  w1.position.set(-0.6, 0.1, 0.4);
  w1.rotation.set(0.1, 0.5, 0.06);
  const w2 = new THREE.Mesh(bigWingGeo(), wm);
  w2.position.set(0.4, 0.15, -0.5);
  w2.rotation.set(-0.15, -2.4, 0.2);
  w1.castShadow = w2.castShadow = true;
  g.add(w1, w2);
  const rk = new THREE.Mesh(rockGeometry(29, { r: 1.3, sy: 0.7, rock: 0x8d877c, top: 0x6f8a4a, cover: 0.3, detail: 2 }), mat.rock());
  rk.position.set(2.6, -0.2, 1.6);
  rk.castShadow = true;
  g.add(rk);
  const boy = new THREE.Mesh(cached('geo:icarusboy', () => {
    const p = new Parts();
    p.add(lathe([[0.0, 0], [0.34, 0], [0.3, 0.3], [0.2, 0.62], [0.12, 0.78], [0.0, 0.8]], 14), 0xe9e0cc);
    p.add(blob(0.15, 2), 0xc8946a, M(0.08, 0.92, 0));
    p.add(blob(0.16, 2), 0x4a2e1a, M(0.03, 0.99, 0, 0, 1, 0.7, 1));
    p.add(tube([V(0.05, 0.6, 0.2), V(0.25, 0.35, 0.25), V(0.15, 0.1, 0.3)], 0.05, 0.04, 5, 5), 0xc8946a);
    p.add(tube([V(0.05, 0.6, -0.2), V(0.28, 0.4, -0.2), V(0.25, 0.75, -0.08)], 0.05, 0.04, 5, 5), 0xc8946a);    // chin on hand
    return p.geometry();
  }), mat.cloth());
  boy.position.set(2.6, 0.6, 1.6);
  boy.rotation.y = 2.6;
  boy.castShadow = true;
  g.add(boy);
  // a few feathers drifting down and a curl of smoke
  const feathers = [];
  const fm = cached('mat:feather', () => new THREE.MeshStandardMaterial({ color: 0xf4efe2, roughness: 0.9, side: THREE.DoubleSide }));
  const fg = cached('geo:feather', () => blade(0.5, 0.14, 0.05, 3));
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Mesh(fg, fm);
    g.add(f);
    feathers.push({ f, ph: i * 1.3, x: (i % 3 - 1) * 1.6, z: (i % 2 ? 1 : -1) * 1.2 });
  }
  const smoke = [];
  const sm = new THREE.SpriteMaterial({ map: softDiscTexture(), color: 0x5a5450, transparent: true, opacity: 0.25, depthWrite: false });
  for (let i = 0; i < 4; i++) { const s = new THREE.Sprite(sm); g.add(s); smoke.push(s); }
  g.scale.setScalar(opts.scale ?? 1.5);
  return finish(g, (t) => {
    for (const q of feathers) {
      const k = ((t * 0.12 + q.ph * 0.1) % 1);
      q.f.position.set(q.x + Math.sin(t * 1.3 + q.ph) * 0.6, 6 * (1 - k) + 0.2, q.z + Math.cos(t * 1.1 + q.ph) * 0.5);
      q.f.rotation.set(Math.sin(t * 2 + q.ph) * 0.6, t * 0.8 + q.ph, Math.cos(t * 1.7 + q.ph) * 0.5);
    }
    for (let i = 0; i < smoke.length; i++) {
      const k = ((t * 0.2 + i / smoke.length) % 1);
      smoke[i].position.set(1.2 + k * 0.8, 0.4 + k * 4, -0.4 + Math.sin(t + i) * 0.3);
      smoke[i].scale.setScalar(0.6 + k * 2.2);
    }
  }, opts);
}

export const WONDER_PROPS = {
  beacon: makeWonderBeacon, caravan: makeCaravan, sandstorm: makeSandstorm, mirage: makeMirage, scarab: makeScarab,
  barge: makeBarge, goldfish: makeGoldfish, ghostship: makeGhostShip, whales: makeWhales, hermes: makeHermesParcel,
  automaton: makeAutomaton, turtleisle: makeTurtleIsle, icarus: makeIcarusWreck,
};

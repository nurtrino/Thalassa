/*
 * worldfx_realms.js — the WORLD wonders of the Frostfang Reach and the
 * Verdigris Deep, as 3D set pieces beside their stop (events.py → room.world,
 * drawn by worldfx.js, which calls buildRealmWonder(model) for any model it
 * does not build itself).
 *
 *   walrus        a walrus toll-keeper sprawled on a floe, brass badge, sign
 *   aurora_whale  a whale of northern light swimming in a slow circle in the
 *                 air, trailing green and violet ribbons
 *   berg_giant    an iceberg with a sleeping face, frosty beard and snore-mist
 *   penguins      the Penguin Parliament: rows of penguins on a floe, the
 *                 Speaker in a wig on an ice lectern
 *   monkey_raft   a bamboo raft heaped with loot, crewed by monkeys in hats
 *   orchid        a giant carnivorous orchid on a raft of roots, glowing heart
 *   sloth         a dead tree standing in the river, an ancient sloth hanging
 *   jaguar        a jaguar (the kept GLB) lounging on a drifting mossy log
 *
 * Every piece: origin at its stop-side anchor with the sea surface at y = −0.3
 * (worldfx leaves the group at y = 0), shared cached geometry/materials, a
 * handful of draw calls, no lights, self-animating via kit.animate (a pure
 * function of time). A piece that owns per-instance GPU state sets
 * userData.realmDispose (worldfx calls it when the wonder leaves the chart).
 *
 * REALM_LOOK is merged into worldfx's LOOK table (how each piece rides the
 * swell, the colour of its light pool, clearance beside the stop).
 */
import { THREE, cached, mat, Parts, M, lathe, box, tube, blob, rockGeometry, glowSprite, animate,
  smooth, mulberry32 } from './models/kit.js';
import { makeCrate, makeAmphora, makeBarrelGeo } from './models/props.js';
import { getMonster, animateMonster, disposeMonster } from './monsters.js';
import { softDiscTexture } from './util.js';

const SEA = -0.3;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ── shared materials ───────────────────────────────────────────────────── */
const iceMat = () => cached('mat:rw:ice', () => new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.22, metalness: 0, envMapIntensity: 1.2 }));
const furMat = () => cached('mat:rw:fur', () => new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.82, metalness: 0 }));
const skinMat = () => cached('mat:rw:skin', () => new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.45, metalness: 0, side: THREE.DoubleSide }));
const auroraMat = () => cached('mat:rw:aurora', () => new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending,
  depthWrite: false, side: THREE.DoubleSide, fog: true }));

/* a lofted body along +x (u 0 tail → 1 nose): prof(u) → [radius, centre-y,
   width-squash]; NR rings round. Smooth normals. */
function loft(prof, NX = 22, NR = 14, x0 = -1, x1 = 1) {
  const pos = [], idx = [];
  for (let i = 0; i <= NX; i++) {
    const u = i / NX, x = x0 + u * (x1 - x0);
    const [r, yc, sq = 0.85] = prof(u);
    for (let j = 0; j <= NR; j++) {
      const a = (j / NR) * Math.PI * 2;
      pos.push(x, yc + Math.sin(a) * r, Math.cos(a) * r * sq);
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j, b = a + 1, c = a + NR + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);                // outward-facing
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* a flat floe: a squashed ice rock, top at about y = 0.35 above the sea */
function floeGeo(seed, r) {
  return cached(`geo:rw:floe:${seed}:${r}`, () => {
    const p = new Parts();
    p.add(rockGeometry(seed, { r, sy: 0.22, detail: 3, facets: 7, rough: 0.1, rock: 0xcfe6f0,
      top: 0xf6fbfd, cover: 0.9, strata: 0.25, base: -0.9 }), null, M(0, SEA + 0.12, 0));
    return p.geometry();
  });
}

/* ═══ the Frostfang Reach ═══════════════════════════════════════════════════ */

/* ── the walrus toll-keeper ─────────────────────────────────────────────── */
function walrusGeo() {
  return cached('geo:rw:walrus', () => {
    const hide = (x, y, z, nx, ny, nz, c) => {
      c.setHex(0x8b6450);
      c.lerp(new THREE.Color(0x5e4032), smooth(0.3, 0.9, ny) * 0.35);
      c.lerp(new THREE.Color(0xb48f78), smooth(0.0, -0.7, ny) * 0.5);
    };
    const body = new Parts(), head = new Parts();
    // a great sack of a body, lying along +x, fattest at the chest
    body.add(loft((u) => {
      const r = 0.12 + 0.92 * Math.pow(Math.sin(Math.min(1, u * 1.02) * Math.PI * 0.95), 0.75);
      return [r * (u > 0.82 ? 1 - (u - 0.82) * 2.2 : 1), 0.05 * Math.sin(u * Math.PI), 0.95];
    }, 24, 16, -1.7, 1.2), hide, M(0, 0.82, 0));
    // fore-flippers and tail flukes
    for (const s of [-1, 1]) {
      body.add(blob(0.42, 2), 0x6e4c3c, M(0.55, 0.14, s * 0.85, s * 0.5, 1.3, 0.28, 0.7));
      body.add(blob(0.36, 1), 0x6e4c3c, M(-1.85, 0.2, s * 0.35, s * 0.9, 1.2, 0.22, 0.6));
    }
    // head (pivot at the neck), muzzle pads, whiskers, eyes, tusks
    head.add(blob(0.62, 2), hide, M(0.35, 0.05, 0, 0, 1.1, 0.95, 1.0));
    for (const s of [-1, 1]) {
      head.add(blob(0.3, 2), 0xa88470, M(0.8, -0.12, s * 0.22, 0, 1, 0.9, 1));
      head.add(new THREE.SphereGeometry(0.06, 8, 6), 0x140e0a, M(0.62, 0.3, s * 0.33));
      head.add(tube([V(0.86, -0.32, s * 0.2), V(0.95, -0.8, s * 0.24), V(0.9, -1.25, s * 0.22)],
        0.07, 0.025, 8, 6), 0xf2ead6);
      for (let k = 0; k < 3; k++) {
        head.add(tube([V(0.95, -0.1 - k * 0.07, s * 0.3), V(1.05, -0.12 - k * 0.1, s * 0.62)],
          0.012, 0.006, 2, 3), 0xd9cbb0);
      }
    }
    return { body: body.geometry(), head: head.geometry() };
  });
}

function signGeo() {
  return cached('geo:rw:tollsign', () => {
    const p = new Parts();
    p.add(tube([V(0, 0, 0), V(0.05, 1.3, 0), V(0, 2.4, 0)], 0.08, 0.06, 4, 6), 0x5a3f28);
    p.add(box(1.3, 0.62, 0.08, 0.04), 0x8a6a42, M(0, 2.2, 0.08, 0, 1, 1, 1, 0, 0.06));
    p.add(box(1.0, 0.1, 0.02, 0), 0x2a1c12, M(0, 2.28, 0.13, 0, 1, 1, 1, 0, 0.06));
    p.add(box(0.7, 0.08, 0.02, 0), 0x2a1c12, M(0, 2.12, 0.13, 0, 1, 1, 1, 0, 0.06));
    return p.geometry();
  });
}

function makeWalrus() {
  const g = new THREE.Group();
  const floe = new THREE.Mesh(floeGeo(41, 3.0), iceMat());
  floe.receiveShadow = true;
  const geo = walrusGeo();
  const beast = new THREE.Group();
  const body = new THREE.Mesh(geo.body, furMat());
  const head = new THREE.Mesh(geo.head, furMat());
  body.castShadow = head.castShadow = true;
  head.position.set(1.15, 1.25, 0);
  const badge = new THREE.Mesh(cached('geo:rw:badge', () => new THREE.CylinderGeometry(0.17, 0.17, 0.04, 16)
    .rotateZ(Math.PI / 2)), mat.gold());
  badge.position.set(0.95, 1.0, 0.55);
  badge.rotation.y = -0.5;
  beast.add(body, head, badge);
  beast.position.y = SEA + 0.3;
  beast.rotation.y = 0.5;
  const sign = new THREE.Mesh(signGeo(), mat.wood());
  sign.position.set(-1.2, SEA + 0.3, -1.6);
  sign.rotation.y = 0.9;
  sign.castShadow = true;
  g.add(floe, beast, sign);
  g.scale.setScalar(1.5);
  return animate(g, (t) => {
    const br = Math.sin(t * 0.9);
    body.scale.set(1, 1 + br * 0.025, 1 + br * 0.02);
    head.rotation.z = 0.15 + Math.sin(t * 0.45) * 0.08;
    head.rotation.y = Math.sin(t * 0.21) * 0.45;
    g.children[0].position.y = Math.sin(t * 0.8) * 0.04;
    beast.position.y = SEA + 0.3 + Math.sin(t * 0.8) * 0.04;
  });
}

/* ── the aurora whale ───────────────────────────────────────────────────── */
const _wc = new THREE.Color();
const whaleMat = () => cached('mat:rw:whalebody', () => new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.88, depthWrite: true, side: THREE.FrontSide, fog: false }));
function whaleGeo() {
  return cached('geo:rw:whale', () => {
    const p = new Parts();
    // a body of night-sky colour with the aurora running along it: deep
    // teal-violet core (so it holds its shape against a pale sky instead of
    // washing out to a ghost), saturated green/violet bands that glow (HDR
    // > 1 → bloom), a pale grooved throat
    const glowCol = (x, y, z, nx, ny, nz, c) => {
      const u = (x + 1.6) / 3.2;
      const band = Math.pow(0.5 + 0.5 * Math.sin(u * 15 + y * 9 + z * 2), 4);
      c.setRGB(0.04, 0.2, 0.22).lerp(new THREE.Color(0.16, 0.06, 0.3), smooth(0.2, 0.9, 1 - u));
      _wc.setRGB(0.3, 1.6, 0.9).lerp(new THREE.Color(1.1, 0.5, 1.6), smooth(0.25, 0.9, 1 - u));
      c.lerp(_wc, 0.18 + 0.6 * band * smooth(-0.2, 0.6, ny));
      if (ny < -0.45) c.lerp(_wc.setRGB(0.6, 0.95, 0.9), 0.45 * (0.5 + 0.5 * Math.sin(z * 40)));   // throat grooves
    };
    p.add(loft((u) => {
      const r = 0.07 + 0.62 * Math.pow(Math.sin(Math.min(1, u * 1.03) * Math.PI * 0.93), 1.05)
        * (u > 0.86 ? 1 - (u - 0.86) * 3 : 1);
      return [Math.max(0.05, r), 0.06 * Math.sin(u * Math.PI) - (u > 0.7 ? (u - 0.7) * 0.25 : 0), 0.9];
    }, 26, 16, -1.6, 1.6), glowCol);
    // throat grooves (lighter streaks) are in the colour; flippers as thin blades
    for (const s of [-1, 1]) {
      p.add(blob(0.3, 1), glowCol, M(0.55, -0.35, s * 0.62, s * 0.6, 2.4, 0.16, 0.7, 0, -0.4));
    }
    return p.geometry();
  });
}
function flukeGeo() {
  return cached('geo:rw:fluke', () => {
    const p = new Parts();
    const col = (x, y, z, nx, ny, nz, c) => { c.setRGB(0.16, 0.06, 0.3).lerp(_wc.setRGB(1.1, 0.5, 1.6), 0.35 + 0.4 * Math.abs(z)); };
    p.add(blob(0.36, 1), col, M(-0.3, 0, 0.45, 0.5, 1.8, 0.12, 0.8));
    p.add(blob(0.36, 1), col, M(-0.3, 0, -0.45, -0.5, 1.8, 0.12, 0.8));
    return p.geometry();
  });
}
function ribbonGeo(len, w, seed) {
  return cached(`geo:rw:ribbon:${seed}`, () => {
    const N = 24;
    const pos = [], col = [], idx = [];
    const rng = mulberry32(seed);
    const ph = rng() * 6;
    const c = new THREE.Color();
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const x = -u * len, y = Math.sin(u * 5 + ph) * 0.5 * u, z = Math.cos(u * 3.3 + ph) * 0.8 * u;
      const fade = (1 - u) * smooth(0, 0.12, u);
      c.setRGB(0.3, 1.0, 0.6).lerp(new THREE.Color(0.8, 0.4, 1.0), u).multiplyScalar(fade * 1.6);
      for (const s of [-1, 1]) {
        pos.push(x, y + s * w * (1 - u * 0.6), z);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
  });
}

function makeAuroraWhale() {
  const g = new THREE.Group();
  const whale = new THREE.Group();
  const body = new THREE.Mesh(whaleGeo(), whaleMat());
  const fluke = new THREE.Mesh(flukeGeo(), whaleMat());
  fluke.position.x = -1.55;
  const eye = glowSprite(0xeafff4, 0.5, 0.9);
  eye.position.set(0.95, 0.05, 0.42);
  const halo = glowSprite(0x6cffc0, 6.5, 0.18);
  whale.add(body, fluke, eye, halo);
  const ribbons = [];
  for (let k = 0; k < 3; k++) {
    const r = new THREE.Mesh(ribbonGeo(3.2 + k * 0.8, 0.2 - k * 0.04, 7 + k), auroraMat());
    r.position.set(-1.4, (k - 1) * 0.3, (k - 1) * 0.25);
    whale.add(r);
    ribbons.push(r);
  }
  whale.scale.setScalar(2.2);
  g.add(whale);
  // its shimmer on the water below
  const pool = glowSprite(0x58e6b0, 9, 0.12);
  pool.position.y = SEA + 0.2;
  pool.scale.set(12, 4, 1);
  g.add(pool);
  return animate(g, (t) => {
    const a = t * 0.12;
    const R = 4.0;
    whale.position.set(Math.cos(a) * R, 8.5 + Math.sin(t * 0.5) * 0.6, Math.sin(a) * R);
    whale.rotation.set(0, -a - Math.PI / 2, Math.sin(t * 0.5 + 1.2) * 0.12);
    fluke.rotation.z = Math.sin(t * 0.9) * 0.35;
    body.rotation.z = Math.sin(t * 0.9 - 0.8) * 0.05;
    for (let k = 0; k < ribbons.length; k++) ribbons[k].rotation.x = Math.sin(t * 0.6 + k * 2) * 0.35;
    halo.material.opacity = 0.14 + Math.sin(t * 0.7) * 0.05;
    pool.position.x = whale.position.x;
    pool.position.z = whale.position.z;
  });
}

/* ── the sleeping berg giant ───────────────────────────────────────────── */
function bergGeo() {
  return cached('geo:rw:berg', () => {
    const p = new Parts();
    // the bulk: a tall ice rock, cut flat under the sea
    const bulk = rockGeometry(1907, { r: 4.2, sy: 1.25, detail: 3, facets: 8, rough: 0.12, rock: 0xa9d3e6,
      top: 0xf4fbff, cover: 0.85, strata: 0.6, base: -0.55 });
    bulk.translate(0, 1.2, 0);
    // find the berg's real front (+x) where the face goes: the fracture planes
    // move it from seed to seed, so measure instead of guessing
    let face = 2.4;
    const bp = bulk.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      if (Math.abs(bp.getZ(i)) < 1.4 && bp.getY(i) > 0.9 && bp.getY(i) < 3.6) face = Math.max(face, bp.getX(i));
    }
    face -= 0.25;
    p.add(bulk, null);
    // a shoulder berg leaning on it (behind the face)
    p.add(rockGeometry(77, { r: 2.4, sy: 0.9, detail: 2, facets: 6, rough: 0.14, rock: 0x9fcbe0,
      top: 0xf4fbff, cover: 0.8, strata: 0.5, base: -0.5 }), null, M(-3.4, 0.2, 1.4));
    // THE FACE, big enough to read from the board camera: a slab of clear
    // blue ice as the face plate, a heavy snow brow, deep-shadowed shut
    // eyes, a great nose, a down-turned snoring mouth, a beard of icicles
    p.add(blob(1.5, 2), 0xbfe2f2, M(face - 0.55, 2.2, 0, 0, 0.55, 1.35, 1.25));           // face plate
    p.add(blob(0.95, 2), 0xf4fbff, M(face + 0.05, 3.2, 0, 0, 0.6, 0.42, 2.0));            // brow (snow)
    for (const s of [-1, 1]) {
      p.add(blob(0.42, 2), 0x2d5a78, M(face + 0.12, 2.7, s * 0.68, 0, 0.35, 0.5, 0.8));   // eye socket
      p.add(tube([V(face + 0.38, 2.74, s * 0.38), V(face + 0.5, 2.6, s * 0.68), V(face + 0.38, 2.72, s * 1.0)],
        0.08, 0.08, 6, 5), 0x14324a);                                                    // the shut lid
      p.add(blob(0.32, 1), 0xd7eef8, M(face + 0.2, 1.95, s * 0.95, 0, 0.5, 0.45, 0.6));  // cheek
    }
    p.add(blob(0.62, 2), 0xd0eaf6, M(face + 0.45, 2.15, 0, 0, 1.25, 1.15, 0.8));          // nose
    p.add(blob(0.5, 2), 0x1d3e58, M(face + 0.18, 1.35, 0, 0, 0.4, 0.32, 0.95));           // open snoring mouth
    p.add(tube([V(face + 0.3, 1.62, -0.85), V(face + 0.48, 1.68, 0), V(face + 0.3, 1.62, 0.85)],
      0.12, 0.12, 6, 5), 0xf4fbff);                                                       // frosted moustache
    for (let k = 0; k < 11; k++) {                                                         // the beard
      const z = (k - 5) * 0.3, l = 1.3 + (k % 3) * 0.5 - Math.abs(k - 5) * 0.1;
      p.add(new THREE.ConeGeometry(0.2, l, 6).rotateX(Math.PI), 0xe8f6fc,
        M(face + 0.1 - Math.abs(k - 5) * 0.06, 1.05 - l / 2, z));
    }
    const geo = p.geometry();
    geo.userData.face = face;
    return geo;
  });
}

function makeBergGiant() {
  const g = new THREE.Group();
  const berg = new THREE.Mesh(bergGeo(), iceMat());
  berg.castShadow = true;
  berg.receiveShadow = true;
  berg.position.y = SEA - 0.2;
  g.add(berg);
  const puffs = [];
  const pm = cached('mat:rw:snore', () => new THREE.SpriteMaterial({ map: softDiscTexture(),
    color: 0xe8f4fa, transparent: true, opacity: 0.5, depthWrite: false, fog: true }));
  for (let k = 0; k < 3; k++) {
    const s = new THREE.Sprite(pm.clone());
    s.userData.ph = k / 3;
    g.add(s);
    puffs.push(s);
  }
  g.userData.realmDispose = () => { for (const s of puffs) s.material.dispose(); };
  // (worldfx turns the face, +x, toward the stop — faceStop in REALM_LOOK)
  return animate(g, (t) => {
    // a slow snore: in (the berg swells a little), out (a puff of mist from the nose)
    const breath = Math.sin(t * 0.55);
    berg.scale.set(1 + breath * 0.012, 1 + breath * 0.02, 1 + breath * 0.012);
    for (const s of puffs) {
      const k = ((t * 0.18 + s.userData.ph) % 1);
      s.position.set((berg.geometry.userData.face ?? 3.5) + 0.8 + k * 2.4, SEA + 1.6 + k * 1.8, Math.sin(k * 6 + s.userData.ph * 9) * 0.4);
      s.scale.setScalar(0.8 + k * 2.6);
      s.material.opacity = 0.45 * Math.sin(k * Math.PI);
    }
  });
}

/* ── the Penguin Parliament ─────────────────────────────────────────────── */
function penguinGeo() {
  return cached('geo:rw:penguin', () => {
    const p = new Parts();
    const coat = (x, y, z, nx, ny, nz, c) => {
      const belly = nx > 0.05 && y < 0.66 && y > 0.04;
      c.setHex(belly ? 0xf2f0ea : 0x1d2228);
      if (!belly && y > 0.7 && nx > 0.3 && Math.abs(nz) > 0.2 && y < 0.82) c.setHex(0xe8b030); // cheek
    };
    p.add(lathe([[0.0, 0], [0.17, 0.02], [0.24, 0.18], [0.23, 0.42], [0.17, 0.6], [0.12, 0.68],
      [0.13, 0.78], [0.1, 0.9], [0.0, 0.95]], 14), coat, M(0, 0, 0, 0, 1, 1, 0.9));
    p.add(new THREE.ConeGeometry(0.04, 0.16, 6).rotateZ(-Math.PI / 2), 0xe0802a, M(0.18, 0.82, 0));
    for (const s of [-1, 1]) {
      p.add(blob(0.12, 1), 0x1d2228, M(0, 0.42, s * 0.2, 0, 0.35, 1.9, 0.5, s * 0.25, 0));   // flipper
      p.add(blob(0.07, 1), 0xe0802a, M(0.08, 0.02, s * 0.08, 0, 1.4, 0.4, 1));             // foot
      p.add(new THREE.SphereGeometry(0.025, 6, 4), 0x0a0a0a, M(0.11, 0.84, s * 0.07));     // eye
    }
    return p.geometry();
  });
}
function lecternGeo() {
  return cached('geo:rw:lectern', () => {
    const p = new Parts();
    p.add(box(0.9, 1.0, 0.7, 0.08), 0xd9eef6, M(0, 0.5, 0));
    p.add(box(1.1, 0.12, 0.85, 0.04), 0xeaf6fb, M(0, 1.04, 0));
    // the Speaker's wig: a stack of white curls
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      p.add(blob(0.11, 1), 0xf4f1e8, M(Math.cos(a) * 0.15, 2.15 - (k % 2) * 0.1, Math.sin(a) * 0.15));
    }
    for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
      p.add(blob(0.1, 1), 0xf4f1e8, M(-0.05, 2.0 - k * 0.16, s * 0.2));
    }
    return p.geometry();
  });
}

function makePenguins() {
  const g = new THREE.Group();
  const floe = new THREE.Mesh(floeGeo(97, 3.6), iceMat());
  floe.receiveShadow = true;
  g.add(floe);
  const top = SEA + 0.3;
  // the House: rows of members facing the Speaker (+x)
  const seats = [];
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < 5 - row; k++) {
      seats.push([-0.4 - row * 1.05, (k - (4 - row) / 2) * 0.95, 1.9 - row * 0.12]);
    }
  }
  const N = seats.length;
  const pm = cached('mat:rw:penguin', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  const house = new THREE.InstancedMesh(penguinGeo(), pm, N);
  house.castShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(),
    p = new THREE.Vector3();
  g.add(house);
  const lect = new THREE.Mesh(lecternGeo(), iceMat());
  lect.position.set(1.6, top, 0);
  lect.scale.setScalar(1.5);
  lect.castShadow = true;
  const speaker = new THREE.Mesh(penguinGeo(), pm);
  speaker.position.set(1.95, top + 1.68, 0);
  speaker.rotation.y = Math.PI;
  speaker.scale.setScalar(1.5);
  g.add(lect, speaker);
  g.scale.setScalar(1.3);
  const set = (t) => {
    for (let i = 0; i < N; i++) {
      const [x, z, sc] = seats[i];
      const bob = Math.max(0, Math.sin(t * 2.2 + i * 1.7)) * 0.06;
      p.set(x, top + bob, z);
      q.setFromEuler(e.set(0, Math.sin(t * 0.7 + i) * 0.25, Math.sin(t * 1.3 + i * 2.1) * 0.06));
      s.setScalar(sc * (0.9 + (i % 3) * 0.06));
      house.setMatrixAt(i, m4.compose(p, q, s));
    }
    house.instanceMatrix.needsUpdate = true;
  };
  set(0);
  house.computeBoundingSphere();
  return animate(g, (t) => {
    set(t);
    speaker.rotation.z = Math.sin(t * 1.4) * 0.12;          // gesticulating
    speaker.rotation.y = Math.PI + Math.sin(t * 0.5) * 0.4;
  });
}

/* ═══ the Verdigris Deep ════════════════════════════════════════════════════ */

/* ── the monkey traders' raft ───────────────────────────────────────────── */
function raftGeo() {
  return cached('geo:rw:raft', () => {
    const p = new Parts();
    const bamboo = (x, y, z, nx, ny, nz, c) => {
      c.setHex(0xb59a52);
      if (Math.abs(Math.sin(x * 3.1)) > 0.96) c.setHex(0x6d5a2a);       // nodes
      c.lerp(new THREE.Color(0x7e8a3a), smooth(-0.2, -0.8, ny) * 0.6);
    };
    for (let k = 0; k < 9; k++) {
      p.add(new THREE.CylinderGeometry(0.17, 0.17, 4.6, 8).rotateZ(Math.PI / 2), bamboo,
        M(((k * 37) % 5) * 0.06 - 0.12, 0, (k - 4) * 0.34));
    }
    for (const x of [-1.6, 0, 1.6]) {
      p.add(new THREE.CylinderGeometry(0.1, 0.1, 3.4, 6).rotateX(Math.PI / 2), 0x8a7440, M(x, 0.18, 0));
    }
    // mast, yard and a patched sail
    p.add(tube([V(-0.6, 0.1, 0), V(-0.62, 2.4, 0), V(-0.6, 4.4, 0)], 0.09, 0.06, 4, 6), 0x7b6232);
    p.add(tube([V(-0.6, 4.1, -1.3), V(-0.6, 4.15, 1.3)], 0.05, 0.05, 2, 5), 0x7b6232);
    return p.geometry();
  });
}
function sailGeo() {
  return cached('geo:rw:raftsail', () => {
    const g = new THREE.PlaneGeometry(2.5, 2.6, 6, 6);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, Math.sin((x / 2.5 + 0.5) * Math.PI) * 0.35 * (0.6 + 0.4 * (y / 2.6 + 0.5)));
    }
    g.computeVertexNormals();
    const p = new Parts();
    p.add(g, (x, y, z, nx, ny, nz, c) => {
      c.setHex(0xd8c49a);
      if (x > 0.2 && x < 0.9 && y > -0.5 && y < 0.3) c.setHex(0x9a3f3a);     // a patch
      if (x < -0.4 && y > 0.6) c.setHex(0x3f6a8a);                           // another
    }, M(-0.6, 2.85, 0, Math.PI / 2));
    return p.geometry();
  });
}
function monkeyGeo() {
  return cached('geo:rw:monkey', () => {
    const p = new Parts();
    const fur = 0x6b4a2e, face = 0xd6b48a;
    p.add(blob(0.3, 2), fur, M(0, 0.42, 0, 0, 0.9, 1.25, 0.85));                 // body
    p.add(blob(0.22, 2), fur, M(0.06, 0.9, 0));                                   // head
    p.add(blob(0.15, 1), face, M(0.2, 0.86, 0, 0, 0.6, 0.85, 1.0));               // face
    for (const s of [-1, 1]) {
      p.add(blob(0.08, 1), face, M(0.0, 0.98, s * 0.22, 0, 0.5, 1, 1));           // ears
      p.add(new THREE.SphereGeometry(0.03, 6, 4), 0x120c08, M(0.29, 0.92, s * 0.07));
      p.add(tube([V(0.05, 0.62, s * 0.2), V(0.25, 0.45, s * 0.32), V(0.32, 0.2, s * 0.28)], 0.06, 0.05, 4, 5), fur);
      p.add(tube([V(-0.05, 0.2, s * 0.14), V(0.15, 0.08, s * 0.2), V(0.18, 0.0, s * 0.18)], 0.07, 0.05, 3, 5), fur);
    }
    p.add(tube([V(-0.22, 0.25, 0), V(-0.55, 0.3, 0), V(-0.6, 0.7, 0), V(-0.4, 0.85, 0)], 0.04, 0.025, 10, 5), fur);
    return p.geometry();
  });
}
function hatGeo(kind) {
  return cached('geo:rw:hat:' + kind, () => {
    const p = new Parts();
    if (kind === 0) {           // a sun hat
      p.add(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 16), 0xd9c48a, M(0, 1.1, 0));
      p.add(new THREE.CylinderGeometry(0.15, 0.17, 0.16, 12), 0xd9c48a, M(0, 1.18, 0));
      p.add(new THREE.CylinderGeometry(0.175, 0.175, 0.04, 12), 0x9a3f3a, M(0, 1.13, 0));
    } else if (kind === 1) {    // a captain's tricorn, stolen
      p.add(new THREE.CylinderGeometry(0.28, 0.3, 0.14, 3), 0x22201e, M(0, 1.14, 0));
    } else {                    // a fez
      p.add(new THREE.CylinderGeometry(0.11, 0.14, 0.2, 12), 0xa8322a, M(0, 1.17, 0));
    }
    return p.geometry();
  });
}

function makeMonkeyRaft() {
  const g = new THREE.Group();
  const raft = new THREE.Group();
  const deck = new THREE.Mesh(raftGeo(), mat.wood());
  deck.castShadow = deck.receiveShadow = true;
  const sail = new THREE.Mesh(sailGeo(), mat.cloth());
  sail.castShadow = true;
  // the loot: crates, amphorae, a barrel, a heap of bananas
  const loot = cached('geo:rw:loot', () => {
    const p = new Parts();
    for (const [x, z, s, k, r] of [[0.9, -0.6, 0.62, 0, 0.3], [0.9, 0.3, 0.55, 0, -0.2], [1.0, -0.15, 0.5, 0, 0.8],
      [-1.6, 0.7, 0.5, 1, 0], [-1.7, 0.2, 0.46, 1, 0.5], [0.2, 0.9, 0.55, 2, 0]]) {
      const geo = (k === 0 ? makeCrate() : k === 1 ? makeAmphora() : makeBarrelGeo()).clone();
      p.add(geo, null, M(x, 0.18, z, r, s));
    }
    for (let k = 0; k < 7; k++) {
      p.add(tube([V(0, 0, 0), V(0.12, 0.08, 0), V(0.2, 0.22, 0)], 0.055, 0.035, 4, 5), 0xf0d040,
        M(1.0 + (k % 3) * 0.08, 0.9 + Math.floor(k / 3) * 0.08, 0.6 + k * 0.05, k * 0.7));
    }
    return p.geometry();
  });
  const pile = new THREE.Mesh(loot, mat.wood());
  pile.castShadow = true;
  raft.add(deck, sail, pile);
  const crew = [];
  const fm = furMat();
  for (const [x, z, ry, hat] of [[-0.1, -0.7, 0.4, 0], [0.4, 0.55, -1.2, 1], [-1.4, -0.4, 2.4, 2]]) {
    const m = new THREE.Group();
    const body = new THREE.Mesh(monkeyGeo(), fm);
    body.castShadow = true;
    const h = new THREE.Mesh(hatGeo(hat), mat.plain());
    m.add(body, h);
    m.position.set(x, 0.18, z);
    m.rotation.y = ry;
    m.scale.setScalar(1.1);
    raft.add(m);
    crew.push(m);
  }
  // a lookout at the masthead
  const look = new THREE.Group();
  look.add(new THREE.Mesh(monkeyGeo(), fm));
  look.position.set(-0.6, 4.0, 0);
  raft.add(look);
  raft.position.y = SEA + 0.05;
  g.add(raft);
  g.scale.setScalar(1.45);
  return animate(g, (t) => {
    raft.position.y = SEA + 0.05 + Math.sin(t * 1.2) * 0.06;
    raft.rotation.x = Math.sin(t * 0.9) * 0.03;
    raft.rotation.z = Math.sin(t * 1.1 + 1) * 0.03;
    raft.rotation.y = Math.sin(t * 0.08) * 0.6;
    sail.rotation.y = Math.sin(t * 0.7) * 0.06;
    for (let k = 0; k < crew.length; k++) {
      const hop = Math.max(0, Math.sin(t * 2.6 + k * 2.2));
      crew[k].position.y = 0.18 + hop * hop * 0.35;
    }
    look.rotation.z = Math.sin(t * 1.3) * 0.5;               // swinging off the mast
    look.rotation.x = Math.sin(t * 0.7) * 0.2;
  });
}

/* ── the hungry orchid ──────────────────────────────────────────────────── */
function petalGeo(len, wid, curl) {
  return cached(`geo:rw:petal:${len}:${wid}:${curl}`, () => {
    const NU = 10, NV = 6;
    const pos = [], idx = [];
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      const w = wid * Math.sin(Math.PI * Math.pow(u, 0.75)) * (1 - 0.25 * u);
      for (let j = 0; j <= NV; j++) {
        const v = j / NV - 0.5;
        const x = v * w;
        const y = u * len;
        const z = curl * u * u * len - (v * v) * w * 0.9;
        pos.push(x, y, z);
      }
    }
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = i * (NV + 1) + j, b = a + 1, c = a + NV + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const p = new Parts();
    p.add(g, (x, y, z, nx, ny, nz, c) => {
      const u = y / len;
      c.setHex(0xf4b0d8).lerp(new THREE.Color(0xc23a8a), smooth(0.05, 0.6, u));
      c.lerp(new THREE.Color(0xfff2c0), smooth(0.2, 0.0, u) * 0.8);                 // pale throat
      if (Math.abs(Math.sin(x * 9 / Math.max(0.3, wid))) < 0.12 && u > 0.15) c.multiplyScalar(0.7);  // veins
    });
    return p.geometry();
  });
}
function rootsGeo() {
  return cached('geo:rw:roots', () => {
    const p = new Parts();
    const rng = mulberry32(5);
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + rng() * 0.4;
      const r1 = 2.4 + rng() * 1.6;
      p.add(tube([V(0, 0.3, 0), V(Math.cos(a) * r1 * 0.5, 0.15 + rng() * 0.2, Math.sin(a) * r1 * 0.5),
        V(Math.cos(a + 0.3) * r1, -0.1, Math.sin(a + 0.3) * r1)], 0.28, 0.05, 8, 6), 0x4c5a2a);
    }
    // a great lily pad round the stem, with its notch
    const pad = new THREE.CircleGeometry(3.4, 40, 0.25, Math.PI * 2 - 0.5).rotateX(-Math.PI / 2);
    p.add(pad, (x, y, z, nx, ny, nz, c) => {
      c.setHex(0x3f7a3a).lerp(new THREE.Color(0x6aa64e), Math.abs(Math.sin(Math.atan2(z, x) * 14)) * 0.35);
    }, M(0, 0.02, 0));
    p.add(lathe([[0.42, 0], [0.36, 0.8], [0.3, 1.6], [0.5, 2.0], [0.0, 2.15]], 12), 0x557a2e);   // stem
    return p.geometry();
  });
}

function makeOrchid() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(rootsGeo(), skinMat());
  base.position.y = SEA;
  base.receiveShadow = true;
  base.castShadow = true;
  g.add(base);
  const bloom = new THREE.Group();
  bloom.position.y = SEA + 2.0;
  const petals = [];
  for (let k = 0; k < 6; k++) {
    const big = k % 2 === 0;
    const pm = new THREE.Mesh(petalGeo(big ? 3.4 : 2.7, big ? 2.2 : 1.6, big ? 0.32 : 0.45), skinMat());
    pm.castShadow = true;
    const holder = new THREE.Group();
    holder.rotation.y = (k / 6) * Math.PI * 2;
    holder.add(pm);
    bloom.add(holder);
    petals.push(pm);
  }
  // the heart: a glowing throat ringed with teeth
  const heart = cached('geo:rw:heart', () => {
    const p = new Parts();
    p.add(lathe([[0.0, -0.2], [0.7, 0.0], [0.85, 0.35], [0.55, 0.55], [0.0, 0.3]], 18), 0x7a1640);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      p.add(new THREE.ConeGeometry(0.07, 0.32, 5), 0xf4efe2, M(Math.cos(a) * 0.62, 0.62, Math.sin(a) * 0.62, 0, 1, 1, 1,
        Math.sin(a) * 0.5, -Math.cos(a) * 0.5));
    }
    return p.geometry();
  });
  const throat = new THREE.Mesh(heart, mat.plain());
  const glow = glowSprite(0xff5ab4, 4.5, 0.55);
  glow.position.y = 0.6;
  const core = new THREE.Mesh(cached('geo:rw:core', () => new THREE.SphereGeometry(0.35, 14, 10)),
    mat.glow(0xff7ac8, 3.2));
  core.position.y = 0.25;
  bloom.add(throat, core, glow);
  g.add(bloom);
  g.scale.setScalar(1.15);
  return animate(g, (t) => {
    const open = 0.5 + 0.5 * Math.sin(t * 0.45);            // breathes open and shut
    for (let k = 0; k < petals.length; k++) {
      petals[k].rotation.x = -(0.35 + open * 0.75) - (k % 2) * 0.12 + Math.sin(t * 1.1 + k) * 0.03;
    }
    bloom.rotation.y = Math.sin(t * 0.2) * 0.3;
    bloom.rotation.z = Math.sin(t * 0.37) * 0.06;
    glow.material.opacity = 0.35 + 0.3 * open;
  });
}

/* ── the sloth oracle in its dead tree ─────────────────────────────────── */
function snagGeo() {
  return cached('geo:rw:snag', () => {
    const p = new Parts();
    const bark = (x, y, z, nx, ny, nz, c) => {
      c.setHex(0x6e6252).lerp(new THREE.Color(0x4a5a30), smooth(0.4, 0.95, ny) * 0.7);
      c.multiplyScalar(0.85 + 0.15 * Math.sin(y * 5 + Math.atan2(z, x) * 3));
    };
    p.add(tube([V(0, -1.2, 0), V(0.2, 2, 0.1), V(-0.1, 4.6, 0), V(0.3, 7.2, -0.2), V(0.1, 8.4, 0)], 0.7, 0.18, 12, 9), bark);
    p.add(tube([V(0.15, 5.1, 0), V(1.6, 5.6, 0.2), V(3.4, 5.5, 0.1), V(4.2, 6.1, 0)], 0.3, 0.1, 10, 7), bark);  // the sloth's branch
    p.add(tube([V(0.1, 6.6, 0), V(-1.2, 7.3, -0.4), V(-2.2, 8.4, -0.6)], 0.22, 0.06, 8, 6), bark);
    p.add(tube([V(0.0, 3.2, 0), V(-1.0, 3.6, 0.6), V(-1.8, 3.4, 1.2)], 0.18, 0.05, 6, 6), bark);
    for (const [a, r] of [[0.3, 1.1], [2.2, 1.3], [4.1, 0.9]]) {                     // roots into the water
      p.add(tube([V(0, 0.1, 0), V(Math.cos(a) * r * 0.6, -0.2, Math.sin(a) * r * 0.6), V(Math.cos(a) * r, -1.0, Math.sin(a) * r)],
        0.3, 0.12, 5, 6), bark);
    }
    // hanging moss and vines
    for (const [x, y, z, l] of [[2.2, 5.5, 0.15, 1.6], [3.0, 5.6, 0.1, 2.2], [1.2, 5.4, 0.15, 1.1], [-1.4, 7.4, -0.45, 1.8],
      [-1.2, 3.5, 0.75, 1.2]]) {
      p.add(tube([V(x, y, z), V(x + 0.1, y - l * 0.5, z + 0.05), V(x - 0.05, y - l, z)], 0.07, 0.02, 5, 4), 0x5f7d34);
    }
    return p.geometry();
  });
}
function slothGeo() {
  return cached('geo:rw:sloth', () => {
    const p = new Parts();
    // pale buff fur with the green algae tint sloths really wear (it was a
    // dark brown that went to silhouette under the canopy)
    const fur = (x, y, z, nx, ny, nz, c) => { c.setHex(0xc4b08a).lerp(new THREE.Color(0x9aa86a), smooth(0.2, 0.9, -ny) * 0.45); };
    // it hangs UNDER the branch: origin at the branch, body below
    p.add(blob(0.55, 2), fur, M(0, -1.05, 0, 0, 1.35, 0.85, 0.75));
    p.add(blob(0.36, 2), fur, M(0.28, -0.75, 0, 0, 1.0, 0.95, 0.95));                     // head (tipped back)
    p.add(blob(0.27, 2), 0xf4ead2, M(0.52, -0.8, 0, 0, 0.55, 0.9, 1.05));                // pale face
    for (const s of [-1, 1]) {
      p.add(tube([V(0.58, -0.68, s * 0.12), V(0.62, -0.78, s * 0.2), V(0.58, -0.92, s * 0.18)], 0.045, 0.045, 4, 5), 0x3a2a1c); // eye mask
      p.add(new THREE.SphereGeometry(0.035, 6, 4), 0x0c0806, M(0.66, -0.8, s * 0.13));
      p.add(tube([V(0.05, -0.7, s * 0.35), V(0.05, -0.3, s * 0.32), V(0.0, 0.0, s * 0.3)], 0.12, 0.08, 6, 6), fur);  // fore-arm
      p.add(tube([V(-0.3, -1.4, s * 0.3), V(-0.45, -0.7, s * 0.4), V(-0.5, 0.0, s * 0.35)], 0.13, 0.08, 6, 6), fur); // hind-leg
      for (const x of [0.0, -0.5]) {
        p.add(tube([V(x - 0.1, 0.05, s * 0.33), V(x, 0.16, s * 0.33), V(x + 0.12, 0.04, s * 0.33)], 0.025, 0.015, 4, 4), 0x2c2418);
      }
    }
    p.add(new THREE.SphereGeometry(0.05, 6, 4), 0x2a1c12, M(0.72, -0.86, 0));            // nose
    p.add(tube([V(0.62, -0.97, -0.08), V(0.66, -1.0, 0), V(0.62, -0.97, 0.08)], 0.015, 0.015, 3, 4), 0x2a1c12); // smile
    return p.geometry();
  });
}

function makeSloth() {
  const g = new THREE.Group();
  const snag = new THREE.Mesh(snagGeo(), mat.wood());
  snag.castShadow = true;
  snag.position.y = SEA;
  const hang = new THREE.Group();
  hang.position.set(2.4, SEA + 5.62, 0.15);
  const sloth = new THREE.Mesh(slothGeo(), cached('mat:rw:slothfur', () => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0, emissive: 0x2a2416 })));   // a touch of lift in the shade
  sloth.castShadow = true;
  sloth.scale.setScalar(1.55);                 // big enough to read from the board camera
  hang.add(sloth);
  g.add(snag, hang);
  g.scale.setScalar(1.3);
  return animate(g, (t) => {
    // the slowest creature on the river: a sway every half-minute, a blink of a head-turn
    hang.rotation.x = Math.sin(t * 0.21) * 0.08;
    hang.rotation.z = Math.sin(t * 0.13) * 0.05;
    sloth.rotation.y = Math.sin(t * 0.07) * 0.5;   // face (+x) toward the stop, turning slowly
  });
}

/* ── the jaguar on her drifting log ────────────────────────────────────── */
function logGeo() {
  return cached('geo:rw:log', () => {
    const p = new Parts();
    const bark = (x, y, z, nx, ny, nz, c) => {
      c.setHex(0x5e4a34).lerp(new THREE.Color(0x4f6a2c), smooth(0.5, 0.95, ny) * 0.8);   // moss on top
    };
    p.add(tube([V(-3.0, 0, 0.1), V(-1, 0.05, -0.1), V(1, 0.02, 0.1), V(3.0, -0.05, 0)], 0.55, 0.42, 10, 10), bark);
    p.add(tube([V(1.4, 0.2, 0.2), V(2.0, 0.6, 0.8), V(2.3, 0.9, 1.4)], 0.16, 0.05, 5, 6), bark);           // a snag
    p.add(lathe([[0.55, 0], [0.55, 0.01], [0.0, 0.02]], 10).rotateZ(-Math.PI / 2), 0xb9955e, M(3.0, -0.05, 0));  // cut end
    for (let k = 0; k < 6; k++) {                                                                       // leaves
      p.add(blob(0.25, 1), 0x3f7a34, M(-2.4 + k * 0.9, 0.5, (k % 2 ? 0.35 : -0.35), k, 1.6, 0.25, 0.8));
    }
    return p.geometry();
  });
}

function makeJaguar() {
  const g = new THREE.Group();
  const log = new THREE.Mesh(logGeo(), mat.wood());
  log.castShadow = log.receiveShadow = true;
  g.add(log);
  let mon = null, dead = false;
  getMonster('jaguar', { scale: 1.9 }).then((m) => {
    if (dead) { disposeMonster(m); return; }
    mon = m;
    m.position.set(-0.3, 0.45, 0);
    m.rotation.y = Math.PI / 2;
    g.add(m);
  }).catch(() => {});
  g.userData.realmDispose = () => { dead = true; if (mon) disposeMonster(mon); };
  return animate(g, (t) => {
    log.position.y = SEA + 0.1 + Math.sin(t * 1.0) * 0.06;
    log.rotation.z = Math.sin(t * 0.8) * 0.025;
    g.rotation.y = Math.sin(t * 0.05) * 0.5;
    if (mon) {
      mon.position.y = log.position.y + 0.45;
      animateMonster(mon, t, 'idle');
    }
  });
}

/* ── entry ──────────────────────────────────────────────────────────────── */
export const REALM_LOOK = {
  walrus: { ride: true, beacon: 0x9fe8ff, off: 1 },
  aurora_whale: { beacon: 0x7affc8, off: 1 },
  berg_giant: { beacon: 0xbfe8ff, off: 3, r: 8, faceStop: true },
  penguins: { ride: true, beacon: 0xffe39a, off: 1 },
  monkey_raft: { ride: true, beacon: 0xffc860, face: true },
  orchid: { beacon: 0xff6ab8, off: 1 },
  sloth: { beacon: 0xd8f08a, faceStop: true },
  jaguar: { ride: true, beacon: 0xff5a4a, face: true },
};

const BUILD = {
  walrus: makeWalrus, aurora_whale: makeAuroraWhale, berg_giant: makeBergGiant, penguins: makePenguins,
  monkey_raft: makeMonkeyRaft, orchid: makeOrchid, sloth: makeSloth, jaguar: makeJaguar,
};
export const REALM_WONDERS = Object.keys(BUILD);

/* a set piece for a realm wonder model, or null (worldfx falls through) */
export function buildRealmWonder(model) {
  const f = BUILD[model];
  return f ? f() : null;
}

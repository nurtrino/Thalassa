/*
 * islands.js — terrain, flora, buildings, ships, particles, battle backdrops
 * (owner: Agent A). Everything here is deterministic per node id and themed
 * via the THEME objects from themes.js.
 */
import * as THREE from 'three';
import { hashStr, mulberry32, flat, displace, seedFrom, softDiscTexture } from './util.js';
import { DOMAIN_COLORS, REALM_INFO } from './themes.js';
import { propGroup } from './props.js';
import { buildIceField, iceMooring, dressIceIsland, makeIceberg, makeIceFloe } from './realms/ice.js';
import { buildJungleField, jungleMooring, dressJungleIsland, makeLilyRaft } from './realms/jungle.js';
import { makeDesertField, desertWaypoint, sandApron, dressReachIsland, makeOasis as makeReachOasis } from './realms/desert.js';
import { makeValeField, valeWaystone, dressValeIsland } from './realms/autumn.js';
import { glbProp, preloadStructures } from './structures.js';
import { makeTerrain, makeNoise2D, makeGroundMaterial, groundGrainTexture, groundReliefTexture, SHORE_LAYER, GROUND_TILE } from './gfx/terrain.js';

/* ground grain/relief textures now live with the terrain engine (gfx/terrain.js);
   re-exported under their old names for the sand floors in water.js */
export const paintedGroundTexture = groundGrainTexture;
export const groundBumpTexture = groundReliefTexture;

/* ── Meshy landmark GLBs (static/assets/structures) ─────────────────────────
   The loader, the per-landmark material finish and glbProp() live in
   structures.js; preloadStructures is re-exported for the loading screen. */
export { preloadStructures };

const COL = {
  sand: 0xf3e3b4, sandWet: 0xd9c489, grass: 0x5cb56e, grass2: 0x3f9e58,
  rock: 0x93999e, rockDark: 0x5c6166, basalt: 0x4a4a52,
  trunk: 0x8a5a33, frond: 0x2f9e44, frond2: 0x47b858, cypress: 0x1f6e3d,
  marble: 0xf7f4ec, marbleShade: 0xe4ddc9,
  aegeanBlue: 0x2d5bb9, terracotta: 0xc96f4a, gold: 0xd9a441,
  wood: 0x9a6b3f, woodDark: 0x74502f, bone: 0xe8e2d2,
};

/* terrain: see gfx/terrain.js (makeTerrain is imported above and re-exported) */
export { makeTerrain };

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
/* shallows and surf are painted by the ocean itself now (from the baked shore
   map — gfx/shoremap.js), so these old overlay discs are intentionally empty */
function shallowDisc() { return new THREE.Group(); }
function foamRing() { return new THREE.Group(); }

/* ── flora: five realm sets ─────────────────────────────────────────────── */
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
function floraFor(theme, rng, s = 1, castShadow = true) {
  const kind = theme.flora;
  if (kind === 'pine') return propGroup(rng() < 0.3 ? 'pine_tree' : 'pine_snow', s, castShadow);
  if (kind === 'cactus') return propGroup(rng() < 0.5 ? 'dead_tree' : 'dead_scrub', s, castShadow);
  if (kind === 'jungle') return propGroup(rng() < 0.72 ? 'jungle_tree' : 'palm_tree', s, castShadow);
  if (kind === 'autumn') return propGroup(rng() < 0.78 ? 'amber_tree' : 'dead_tree', s, castShadow);
  // aegean
  const r = rng();
  if (r < 0.5) return propGroup('palm_tree', s, castShadow);
  if (r < 0.8) return propGroup('cypress_tree', s, castShadow);
  return propGroup('olive_tree', s, castShadow);
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

/* The sea-lane marker: a turned spar buoy in Aegean red and white with a
   small storm lantern on its mast. Smooth lathe forms, wet-paint gloss, and a
   lamp bright enough to bloom at dusk. Geometry and materials are built once
   and shared by every waypoint (two draw calls each). scene.js rides the
   group named 'bob' on the swell, so the hull is offset inside it to sit at
   the waterline (sea level is y = -0.3). */
let _buoyParts = null;
function buoyParts() {
  if (_buoyParts) return _buoyParts;
  const col = new THREE.Color();
  const paint = (geo, fn) => {
    const pos = geo.getAttribute('position');
    const c = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      col.set(fn(pos.getY(i)));
      c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo.toNonIndexed();
  };
  // float: keel → belly at the waterline (y = 0) → shoulder → collar
  // (paired rings at 0.03/0.07 and 0.29/0.31 keep the paint bands crisp)
  const prof = [[0.0, -0.62], [0.16, -0.56], [0.36, -0.36], [0.47, -0.12], [0.5, 0.03],
                [0.498, 0.07], [0.47, 0.2], [0.425, 0.29], [0.415, 0.31], [0.36, 0.38],
                [0.2, 0.56], [0.12, 0.66], [0.1, 0.74], [0.0, 0.76]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const hull = paint(new THREE.LatheGeometry(prof, 20), (y) =>
    (y < -0.2 ? 0x4a2a24 : y < 0.05 ? 0x33201c : y < 0.3 ? 0xf2ead8 : 0xc23b2e));
  const tarred = () => 0x2c2622, iron = () => 0x23252b;
  const mast = paint(new THREE.CylinderGeometry(0.03, 0.045, 0.82, 7).translate(0, 1.15, 0), tarred);
  const yard = paint(new THREE.CylinderGeometry(0.02, 0.02, 0.36, 5).rotateZ(Math.PI / 2).translate(0, 1.42, 0), tarred);
  const cage = paint(new THREE.CylinderGeometry(0.105, 0.105, 0.035, 10).translate(0, 1.58, 0), iron);
  const cap = paint(new THREE.ConeGeometry(0.13, 0.14, 10).translate(0, 1.86, 0), iron);
  const finial = paint(new THREE.SphereGeometry(0.03, 8, 6).translate(0, 1.95, 0), iron);
  const parts = [hull, mast, yard, cage, cap, finial];
  let n = 0;
  for (const g of parts) n += g.getAttribute('position').count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    P.set(g.getAttribute('position').array, o);
    N.set(g.getAttribute('normal').array, o);
    C.set(g.getAttribute('color').array, o);
    o += g.getAttribute('position').count * 3;
    g.dispose();
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.BufferAttribute(P, 3));
  body.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  body.setAttribute('color', new THREE.BufferAttribute(C, 3));
  _buoyParts = {
    body,
    bodyMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.46, metalness: 0 }),
    lamp: new THREE.SphereGeometry(0.085, 12, 9).scale(1, 1.3, 1).translate(0, 1.7, 0),
    lampMat: new THREE.MeshStandardMaterial({ color: 0x3a2a10, roughness: 0.3,
      emissive: 0xffb648, emissiveIntensity: 2.6 }),
  };
  return _buoyParts;
}

function makeBuoy(rng) {
  const parts = buoyParts();
  const g = new THREE.Group();
  const hull = new THREE.Mesh(parts.body, parts.bodyMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  const lamp = new THREE.Mesh(parts.lamp, parts.lampMat);
  const inner = new THREE.Group();          // waterline (profile y = 0) → sea level
  inner.position.y = -0.3 / 1.7;            // callers scale the buoy ×1.7
  inner.rotation.z = (rng() - 0.5) * 0.12;  // each one lists a little differently
  inner.add(hull, lamp);
  g.add(inner);
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


/* ── realm wilds: the stuff that fills the water/sand BETWEEN stops ─────── */

/* a drifting iceberg — procedural glacial ice (realms/ice.js); s ≈ 0.5–1.2 */
export function makeBerg(rng, s = 1) {
  return makeIceberg(rng, s);
}

/* drift ice between the bergs — a small raft of floes awash */
export function makeFloe(rng, s = 1) {
  return makeIceFloe(rng, s);
}

/* a raft of lily pads on the green water (realms/jungle.js) — the old name
   is kept for call-site compatibility; the vine tubes are gone */
export function makeVineMat(rng, s = 1) {
  return makeLilyRaft(rng, s);
}

/* The ambient wilds BETWEEN the stops — a berg field, a dune sea, vine-
   choked channels, or the Vale's unbroken forest. `nodes` are the region's
   board nodes and `segs` its lane segments [x1,z1,x2,z2]; everything lands
   clear of both so the road itself stays readable. */
export function makeRealmField(theme, nodes, segs, rng, heightAt = null) {
  const g = new THREE.Group();
  if (!nodes.length) return g;
  // the two WATER realms build their wilds in their own modules (static/realms/)
  if (theme.id === 'ice') { g.add(buildIceField(theme, nodes, segs, rng)); return g; }
  if (theme.id === 'jungle') { g.add(buildJungleField(theme, nodes, segs, rng)); return g; }
  // …and so do the two realms crossed on foot
  if (theme.id === 'desert') return makeDesertField(theme, nodes, segs, rng, heightAt);
  if (theme.id === 'autumn') return makeValeField(theme, nodes, segs, rng, heightAt);
  const groundY = heightAt || (() => 0);           // seat props on the dunes
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const M = 55;                                   // the wilds spill past the road
  minX -= M; maxX += M; minZ -= M; maxZ += M;
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
  // POIs carve a proper CLEARING out of the wilds — a shrine, camp, barrow
  // or hunting ground stands in the open, nothing clipping through it
  const poiClear = (n) => {
    if (!n.type || n.type === 'sea') return 0;
    if (n.type === 'gate') return 17;
    if (n.type === 'lair') return 13;
    return 11;
  };
  const placedPts = [];                 // props with a personal-space bubble
  const scatter = (count, laneClear, isleClear, reach, make, yOff = 0, minGap = 0) => {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < count * 16) {
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
      // no lanes at all (the Vale before its trails reveal): fill freely
      const sd = segs.length ? segDist(x, z) : laneClear + 1;
      if (sd < laneClear || sd > reach) continue;
      let blocked = false;
      for (const n of nodes) {
        if (Math.hypot(n.x - x, n.z - z) < isleClear + poiClear(n)) {
          blocked = true;
          break;
        }
      }
      if (!blocked && minGap > 0) {
        for (const p of placedPts) {
          if (Math.abs(p.x - x) < minGap && Math.abs(p.z - z) < minGap
              && Math.hypot(p.x - x, p.z - z) < minGap) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;
      if (minGap > 0) placedPts.push({ x, z });
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
  const prop = (ids, lo, hi) => () =>
    propGroup(ids[(rng() * ids.length) | 0], lo + rng() * (hi - lo));
  // (every realm returned above — ice/jungle in realms/ice.js + jungle.js, the
  // two foot realms in realms/desert.js + autumn.js; what is left is open sea)
  scatter(6, 12, 17, 120, prop(['boulder'], 0.7, 1.2));   // sea stacks
  // hub / aegean open water: flotsam only — the good stuff is ashore
  scatter(8, 12, 17, 120, prop(['driftwood', 'fishing_net'], 0.7, 1.1));
  return g;
}

/* map totem for an active monster node: dark spiked megalith, watching eyes */
function makeMonsterTotem(rng, m) {
  const g = new THREE.Group();
  const hp = Math.min(10, m?.max_hp ?? 4);
  const s = 1 + hp * 0.12;
  // a rune-cut standing stone leaning over a heap of picked bones marks the
  // lurking foe; the ember light + haze below are the gameplay "danger here"
  // signal and stand in until the models stream in
  const stone = propGroup('waymarker_stone', s * 1.25);
  stone.rotation.set(0.07, rng() * 6.28, -0.09);
  const bones = propGroup('bone_pile', s * 1.5);
  bones.position.set(0.5 * s, 0, 0.75 * s);
  bones.rotation.y = rng() * 6.28;
  g.add(stone, bones);
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

/* scattered coast dressing so islands feel dense and hand-made */
/* Meshy props that belong ON LAND, dealt per biome to the island tops */
const ISLE_PROPS = {
  hub: ['amphora_pile', 'banner_pole', 'brazier', 'tide_pool', 'ruined_arch',
        'broken_statue', 'olive_tree', 'cypress_tree', 'reeds'],
  ice: ['crystal_cluster', 'pine_snow', 'ice_shard', 'cairn'],
  jungle: ['mossy_idol', 'mushroom_cluster', 'fern_cluster', 'ruined_arch',
           'stone_well', 'jungle_tree'],
  desert: ['bone_pile', 'amphora_pile', 'dead_scrub', 'sarcophagus'],
  autumn: ['mushroom_cluster', 'campfire', 'barrel', 'dead_tree'],
};

function dressIsland(g, rng, theme, R, terrain, node = null) {
  // the water realms dress their own isles (static/realms/)
  if (theme.id === 'ice') return dressIceIsland(g, rng, theme, R, terrain, node);
  if (theme.id === 'jungle') return dressJungleIsland(g, rng, theme, R, terrain, node);
  // …and so do the two foot realms
  if (theme.id === 'desert') return dressReachIsland(g, rng, theme, R, terrain, node);
  if (theme.id === 'autumn') return dressValeIsland(g, rng, theme, R, terrain, node);
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
      g.add(sandApron(radius, pal.pad ?? pal.sand));   // feather the pad into the dune floor
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
        g.add(valeWaystone(rng0));                  // realms/autumn.js
        g.position.set(node.x, 0, node.z);
        return { group: g, R: 1.9, plateauY: 0 };
      }
      // an open waypoint on the trek: a worn ring of flagstones to stand on,
      // a cairn beside it — the sand around stays flat (realms/desert.js)
      g.add(desertWaypoint(rng0));
      g.position.set(node.x, 0, node.z);
      return { group: g, R: 3, plateauY: 0 };
    }
    if (theme.id === 'ice' && node.region) {
      // Frostfang water: the mooring is OPEN water — bergs live far out in the
      // field (see realms/ice.js), not crowding the stop. Only brash and pancake
      // ice ring the berth so the ship never parks against a wall.
      g.add(iceMooring(node, rng0));
      // the pale shoal marks the mooring; the ship berths in its MIDDLE (see
      // slotFor), so it reads as a stop the boat settles into — not a patch it
      // plows across.
      g.add(shallowDisc(16, theme.water.shallow));
      g.position.set(node.x, 0, node.z);
      return { group: g, R: 4.4, plateauY: 0 };
    }
    if (theme.id === 'jungle' && node.region) {
      // Verdigris water: lily rafts in the slack water off the berth, and now
      // and then a wooded islet or mossy rocks (see realms/jungle.js)
      g.add(jungleMooring(node, rng0));
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
    // wall itself so the gateway reads clearly instead of washing into haze.
    // NOT in the Amber Vale, though: its thick fog is meant to SWALLOW the pass
    // like every trunk around it, so the same gate seen from the WOODS must
    // fog normally (else its stone shines through the haze). The hub-side copy
    // of the gate still builds fog-free, keeping it a clear landmark from sea.
    if (theme?.id !== 'autumn') portal.traverse(fogFree);
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
  // (pad/pad2: the tones of the realm's own floor, so a stop's pad melts into
  // it; drift 0 = no per-island hue wander against that shared floor)
  const footPal = foot
    ? { ...pal, grass: pal.pad ?? pal.sand, grass2: pal.pad2 ?? pal.rock,
        sand: pal.pad ?? pal.sand, sandWet: pal.sand, drift: 0 }
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
    // (no decorative tree beside the shrine — buildings no longer generate the
    // little trees around them)
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
      // a woodland camp: tents in a clearing (the Vale's own giant trees ring
      // it — the camp no longer spawns its own little trees)
      const t = makeTents(rng0);
      t.position.y = terrain.heightAt(0.2);
      g.add(t);
    } else if (foot) {
      const oasis = makeReachOasis(rng0, theme, 3.75);
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
      // (no decorative tree beside the tents)
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
      mode: flatLair ? 'mesa' : (foot ? 'hill' : 'peak'),   // on foot: a rounded knoll, not a spike
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
    } else if (node.type === 'monster' && !foot) {
      // calm hunting grounds: bone-stake warning that ambushes happen here
      // (the foot realms plant their own — see realms/footkit.js warningStake)
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
    // (the water realms scatter their own smooth boulders in dressIsland)
    for (let i = 0; i < (theme.id === 'ice' || theme.id === 'jungle' || foot ? 0 : 3); i++) {
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
    // (no decorative tree beside the market — buildings no longer generate them)
  } else {
    terrain = mt({ seed, R, H: 2.0, mode: 'hill', palette: { ...footPal } });
  }

  // the home port is hand-composed (dock, tower, palms) — no random set pieces
  if (node.type !== 'pharos' && node.type !== 'home') dressIsland(g, rng0, theme, R, terrain, node);

  // In the Amber Vale the POIs stand DIRECTLY on the shared forest floor — no
  // raised pad at all, so nothing floats and nothing z-fights the ground.
  if (!flatFoot) g.add(terrain.mesh);
  if (!flatFoot) addSkirt(R);          // no beach/leaf skirt around a flush pad
  g.position.set(node.x, 0, node.z);
  return { group: g, R, plateauY: terrain.heightAt(0) };
}

/* ── ships: the player's galley now lives in ship.js (re-exported here so
   scene.js / battle.js keep importing it from islands.js) ─────────────── */
export { makeShip, sailTexture } from './ship.js';

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

/* ── battle diorama backdrops — the game's showpiece view ─────────────────
   The six sets (hub ice desert jungle autumn pharos) are composed in
   realms/battle_sets.js; this is the hook battle.js calls. opts.afloat: the
   enemies swim or sail, so a water arena keeps its shoal under the surface.
   The returned group carries userData.update(t) (fire, embers, leaves) and
   userData.shore ({x, z, size} for the ocean's shore map, null on land). */
import { buildBattleSet } from './realms/battle_sets.js';
export function makeBattleBackdrop(theme, opts = {}) {
  return buildBattleSet(theme, opts, { structure: glbProp });
}

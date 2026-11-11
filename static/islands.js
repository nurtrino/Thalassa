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
import { makePharos as makePharosTower, dressPharosIsle, makeShrineTemple, makePuzzleSpire, makeCampHaven,
  makeCheckpointBeacon as makeCheckpointLamp, makeMarketSquare, makeHomeTown, makeLighthouse as makeHarbourLight,
  makeLairAltar as makeTrialAltar, makeRelicBeacon as makeRelicUrn, makeGatePortal as makeRealmGate, boatsAt,
  battleStructure,
} from './models/landmarks.js';
import { makeRock as procRock, makeFlotsam as procFlotsam } from './models/props.js';
import { onShore } from './models/kit.js';
import { warningStake } from './realms/footkit.js';
import { makeTerrain, makeNoise2D, makeGroundMaterial, groundGrainTexture, groundReliefTexture, SHORE_LAYER, GROUND_TILE } from './gfx/terrain.js';
import { ISLE_FOOT, FOOT_K, MIN_R, isleShape } from './isleshape.js';

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
  // `angle` is a world BEARING (the lane's); the coast there is found on the
  // fitted terrain, the jetty footed on the beach just above the waterline
  const c = terrain.coastAt ? terrain.coastAt(angle) : null;
  const p = terrain.place(c ? c.pa : angle, 0.86);
  const dock = makeDock(Math.max(len, (c ? Math.hypot(c.x, c.z) - Math.hypot(p.x, p.z) : 0) + 3.5));
  dock.position.set(p.x, Math.max(0.12, p.y), p.z);
  dock.rotation.y = -Math.atan2(p.z, p.x) - Math.PI / 2;   // planks run seaward
  return dock;
}

/* ── water-line dressings ───────────────────────────────────────────────── */
/* shallows and surf are painted by the ocean itself now (from the baked shore
   map — gfx/shoremap.js), so these old overlay discs are intentionally empty */
function shallowDisc() { return new THREE.Group(); }
function foamRing() { return new THREE.Group(); }

/* ── rocks: one procedural generator for every boulder (models/props.js:
   strata, sun-bleached tops, moss/snow cover, smooth normals) ─────────── */
function makeRock(rng, r, color = COL.rock, opts = {}) {
  return procRock(rng, r, color, opts);
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

/* ── buildings & props ─────────────────────────────────────────────────────
   The landmarks are procedural now (static/models/landmarks.js); these thin
   wrappers keep the old call sites. */
function makeShrine(domainHex, themeId = 'hub', spent = false, seed = 1) {
  return makeShrineTemple(domainHex, themeId, spent, seed);
}

function makeObelisk(solved = false, seed = 1) {
  return makePuzzleSpire({ solved: !!solved, seed });
}

/* a camp: harbour awnings + nets (sea), caravan / woodland tents (on foot) */
function makeTents(rng, kind = 'sea') {
  const g = makeCampHaven({ kind, seed: Math.floor(rng() * 1e9) });
  g.rotation.y = rng() * 6.28;
  return g;
}

/* the white harbour light at Home Port (callers scale ×2.3 as for the old
   4.6-unit model) */
function makeLighthouse() {
  const g = new THREE.Group();
  const lh = makeHarbourLight();
  lh.scale.setScalar(0.68);
  g.add(lh);
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
  return makeMarketSquare(ry, { seed: Math.floor(rng() * 1e9) });
}

function glowSprite(cssOrHex, scale = 6, name = '') {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: new THREE.Color(cssOrHex), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.set(scale, scale, 1);
  if (name) sp.name = name;
  return sp;
}

/* the Pharos: tower, lantern fire ('pharosfire'), sweeping beams and the
   sealed door ('pharosgate') — models/landmarks.js */
function makePharos() {
  return makePharosTower();
}

function makeRelicBeacon() {
  return makeRelicUrn();
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
   read where you'll respawn from anywhere on the water (models/landmarks.js;
   children[3] is the halo scene.js breathes) */
function makeCheckpointBeacon() {
  return makeCheckpointLamp();
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


/* drifting flotsam: a lashed raft of crates and a barrel with a gold glint —
   sail onto it to haul it aboard for a scroll. Named 'bob' (models/props.js) */
function makeFlotsam(rng) {
  return procFlotsam(rng);
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
  // (no point light per monster isle — the ember haze blooms on its own)
  const haze = glowSprite(new THREE.Color(0xff4a26).multiplyScalar(1.6), 3.4 * s);
  haze.material.opacity = 0.5;
  haze.position.y = 1.6 * s;
  g.add(haze);
  g.name = 'monster';
  return g;
}

/* the boss trial altar on lair isles (models/landmarks.js) */
function makeLairAltar(accentHex, rng) {
  return makeTrialAltar(accentHex, Math.floor(rng() * 1e9));
}

/* THE MOUNTAIN PASS — a monumental carved gateway into a trial realm
   (models/landmarks.js): pylon towers on stepped quays, a voussoir arch over
   the open sailing channel, the realm's emblem glowing over the keystone,
   colossal columns, accent banners and fire bowls. Local frame: the channel
   runs along ±Z, the structure flanks along ±X. */
function makeGatePortal(accentHex, seed, rockHex = 0x8a8f98, realm = '') {
  return makeRealmGate(accentHex, seed, rockHex, realm);
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
// Largest coast radius per node type — importance reads as size (the Pharos
// and Home Port lead). The terrain is FITTED so its coast never passes R, and
// board.py plans every lane round the same table (isleshape.js ISLE_FOOT).
const ISLE_R = ISLE_FOOT;

/* a rocky sea stack standing off the main isle, inside its footprint */
function seaStack(st, R, seed, pal) {
  const rs = R * st.r;
  const t = makeTerrain({ seed: seed + 77, R: rs, H: st.H, mode: 'peak', fit: true,
    shelf: true, cover: 'rocks',
    palette: { ...pal, grass: pal.rock ?? 0x8f8a80, grass2: pal.rock ?? 0x8f8a80 } });
  const d = R - rs * 1.05;
  t.mesh.position.set(Math.cos(st.a) * d, 0, Math.sin(st.a) * d);
  return t.mesh;
}

export function buildIsland(node, theme, domains) {
  const g = new THREE.Group();
  const seed = hashStr(node.id);
  const rng0 = mulberry32(seed + 7);
  const foot = node.mode === 'foot';
  // size: the type's footprint × a little per-isle variety, never more than
  // the free water round the node (node.room, measured by scene.js)
  const solid = node.type !== 'sea' && node.type !== 'gate';
  const maxR = (ISLE_R[node.type] ?? 4.8) * (solid && foot ? FOOT_K : 1);
  let R = maxR * (solid ? 0.84 + rng0() * 0.16 : 1);
  if (solid && node.room != null) {
    R = Math.max(foot ? maxR * 0.45 : (MIN_R[node.type] ?? maxR * 0.45), Math.min(R, node.room));
  }
  // silhouette: harbour cove toward the lane, lobes, stack, terraces, cliffs
  const shape = solid ? isleShape(node, node.dockA ?? null, foot) : null;
  const pal = theme.palette;
  // In the Amber Vale the POIs sit DIRECTLY ON THE GROUND — no raised island.
  // Flatten every terrain to a flush pad so shrines, camps and the barrow stand
  // on the forest floor with the trees, not perched on their own little mounds.
  const flatFoot = foot && theme.id === 'autumn';
  const mt = (opts) => {
    if (flatFoot) return makeTerrain({ ...opts, H: 0.05, mode: 'flat' });
    const o = { fit: true, ...opts };
    if (shape && opts.R === R) {
      Object.assign(o, shape.terrain);
      if (shape.mode && opts.mode === 'mesa') o.mode = shape.mode;
      if (shape.mainK !== 1) o.R = R * shape.mainK;     // room for the stack
    }
    return makeTerrain(o);
  };
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
    let isletR = 5.2;
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
        rk.position.set(Math.cos(a) * rng0() * 2.4, -0.1, Math.sin(a) * rng0() * 2.4);
        g.add(onShore(rk));               // the sea paints surf round the stacks
      }
      g.add(shallowDisc(15, theme.water.shallow));
    } else if (node.look === 'islet') {
      const style = rng0();
      // ≤ SEA_FOOT.islet (7) and never past the water round it; a third are
      // atolls round a drowned lagoon
      isletR = Math.max(3.2, Math.min(7, node.room ?? 7, 4.6 + rng0() * 2.6));
      const t = mt({
        seed, R: isletR,
        H: style < 0.33 ? 0.8 : 1.1,
        mode: style < 0.33 ? 'atoll' : 'hill',
        lagoon: style < 0.33 ? 0.6 : 0,
        lobes: style > 0.66 ? 0.42 : 0,
        palette: { ...pal, ...(rng0() < 0.5 ? { sand: 0xf7ecc8 } : {}) },
      });
      g.add(t.mesh);
      g.add(shallowDisc(22, theme.water.shallow));
      const fl = floraFor(theme, rng0, 1.0);
      const fr = style < 0.33 ? 0.5 : 0.15;         // atoll: on the ring, not in the lagoon
      const fp = t.place(1.1, fr);                  // seated on the real surface
      fl.position.set(fp.x, Math.max(0.05, fp.y), fp.z);
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
    return { group: g, R: node.look === 'islet' ? isletR : node.look === 'rocks' ? 3.6 : R, plateauY: 0 };
  }

  if (node.type === 'gate') {
    const accent = REALM_INFO[node.region]?.accent ?? '#d9a441';
    // the Meshy stone portal marks the pass; the procedural towers/braziers
    // stand in until it streams and keep the accent-lit flavor beside it
    const fogFree = (o) => {
      if (!o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.fog = false;
    };
    const portal = makeGatePortal(accent, seed, theme?.wall?.rock ?? 0x8a8f98, node.region);
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
    const hd = node.dockA ?? 0.5;                  // the harbour faces the lane in
    g.add(placeDock(terrain, hd, 6.0));            // jetty on the real shoreline
    const lh = makeLighthouse();
    lh.scale.setScalar(2.3);                       // a proper landmark tower
    const lhp = terrain.place(hd + 3.4, 0.22);     // near the crown, across from the harbour
    lh.position.set(lhp.x, lhp.y, lhp.z);
    g.add(lh);
    // a little grove ringing Home Port — Meshy palms with a couple of olives
    // and a cypress for variety, all seated on the actual surface
    // …and the town itself: whitewashed houses stepping up from a stone quay,
    // a blue-domed chapel, fishing boats at the jetty (models/landmarks.js)
    makeHomeTown(g, terrain, R, hd, seed);
    boatsAt(g, terrain, hd + 0.42, seed + 3);
    const homeTrees = [
      ['palm_tree', 2.2, 0.6], ['palm_tree', 3.7, 0.62], ['palm_tree', 5.1, 0.55],
      ['olive_tree', 2.8, 0.5], ['cypress_tree', 1.9, 0.58], ['palm_tree', 4.6, 0.44],
    ];
    for (const [id, a, rr] of homeTrees) {
      const tree = propGroup(id, 0.9 + rng0() * 0.3);
      // (angles were laid out for a harbour at 0.5 — keep them clear of the
      // town, which follows the harbour round)
      const pp = terrain.place(a - 0.5 + hd + (rng0() - 0.5) * 0.3, rr);
      tree.position.set(pp.x, pp.y, pp.z);
      g.add(tree);
    }
  } else if (node.type === 'shrine') {
    const hex = DOMAIN_COLORS[node.domain] || '#d9a441';
    terrain = mt({ seed, R, H: 2.2, mode: 'mesa', palette: { ...footPal } });
    const spent = (node.charges ?? 0) <= 0;
    const shrine = makeShrine(hex, theme.id, spent, seed);
    shrine.position.y = terrain.heightAt(0);
    g.add(shrine);
    // (no decorative tree beside the shrine — buildings no longer generate the
    // little trees around them)
  } else if (node.type === 'puzzle') {
    terrain = mt({ seed, R, H: 2.4, mode: 'mesa',
      palette: { ...footPal, grass: foot ? footPal.grass : 0x6fae8f } });
    const ob = makeObelisk(node.solved, seed);
    ob.position.y = terrain.heightAt(0);
    if (node.solved) ob.children.forEach((ch) => { if (ch.isPointLight) ch.intensity = 0; });
    g.add(ob);
    const rk = makeRock(rng0, 0.6, 0x8d94b8, { moss: !foot });
    rk.position.set(-R * 0.48, terrain.surfaceY(-R * 0.48, R * 0.36) + 0.05, R * 0.36);
    g.add(rk);
  } else if (node.type === 'haven') {
    terrain = mt({ seed, R, H: foot ? 1.2 : 1.8, mode: 'flat', palette: { ...footPal } });
    if (foot && theme.id === 'autumn') {
      // a woodland camp: tents in a clearing (the Vale's own giant trees ring
      // it — the camp no longer spawns its own little trees)
      const t = makeTents(rng0, 'autumn');
      t.position.y = terrain.heightAt(0.2);
      g.add(t);
    } else if (foot) {
      const oasis = makeReachOasis(rng0, theme, 3.75);
      oasis.position.y = terrain.heightAt(0.15) + 0.02;
      g.add(oasis);
      const t = makeTents(rng0, 'desert');
      t.position.set(R * 0.35, terrain.surfaceY(R * 0.35, -R * 0.3), -R * 0.3);
      t.scale.setScalar(0.72);
      g.add(t);
    } else {
      const t = makeTents(rng0, 'sea');
      t.position.y = terrain.heightAt(0.2);
      g.add(t);
      const dockA = node.dockA ?? Math.PI + (rng0() - 0.5);
      g.add(placeDock(terrain, dockA, 4.0));
      boatsAt(g, terrain, dockA + 0.5, seed + 1);     // caiques drawn up by the jetty
      // (no decorative tree beside the tents)
    }
    // the checkpoint light: a permanent azure beam so a haven is
    // unmistakable from anywhere on the water
    const cp = makeCheckpointBeacon();
    cp.position.set(-R * 0.25, terrain.surfaceY(-R * 0.25, R * 0.25), R * 0.25);
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
        altar.position.set(R * 0.1, terrain.surfaceY(R * 0.1, 0) + 0.2, 0);
        g.add(altar);
      }
      const beacon = makeRelicBeacon();
      beacon.position.set(-R * 0.3, terrain.surfaceY(-R * 0.3, -R * 0.25), -R * 0.25);
      g.add(beacon);
    }
    if (node.monster) {
      const totem = makeMonsterTotem(rng0, node.monster);
      totem.position.set(R * 0.1, terrain.surfaceY(R * 0.1, 0) + 0.3, 0);
      g.add(totem);
    } else if (node.type === 'monster' && !foot) {
      // calm hunting grounds: bone-stake warning that ambushes happen here
      // (the same weathered skull stake the foot realms plant — footkit.js)
      const stake = warningStake(rng0, 1.1);
      stake.position.set(R * 0.1, terrain.surfaceY(R * 0.1, 0), 0);
      g.add(stake);
    }
    // (the water realms scatter their own smooth boulders in dressIsland)
    for (let i = 0; i < (theme.id === 'ice' || theme.id === 'jungle' || foot ? 0 : 3); i++) {
      const rk = makeRock(rng0, 0.4 + rng0() * 0.4, dark ? COL.basalt : pal.rock);
      const a = rng0() * 6.28;
      const rp = terrain.place(a, 0.62);            // on the shoulder, never in the surf
      rk.position.set(rp.x, rp.y + 0.15, rp.z);
      g.add(rk);
    }
  } else if (node.type === 'pharos') {
    // a rocky islet with a dry-grass terrace — not a bare sand disc
    terrain = mt({ seed, R, H: 3.0, mode: 'mesa',
      palette: { grass: 0x9fa86e, grass2: 0x8a935c, sand: 0xeadcb6, rock: 0xa49c8c } });
    const ph = makePharos();
    ph.position.y = terrain.heightAt(0);
    g.add(ph);
    // rocky shoulder, harbour mole with its lamp, a ring of old columns
    dressPharosIsle(g, terrain, R, seed);
  } else if (node.type === 'shop') {
    terrain = mt({ seed, R, H: 1.6, mode: 'flat', palette: { ...footPal } });
    const stall = makeMarket(rng0, Math.PI);       // porch faces the dock/arrival
    const sp = terrain.place(Math.PI / 2, 0.1);    // planted in the middle of the isle
    stall.position.set(sp.x, sp.y, sp.z);
    g.add(stall);
    if (!foot) {
      const sd = -Math.PI / 2 + (rng0() - 0.5) * 0.5;
      g.add(placeDock(terrain, node.dockA ?? sd, 4.6));
    }
    // (no decorative tree beside the market — buildings no longer generate them)
  } else {
    terrain = mt({ seed, R, H: 2.0, mode: 'hill', palette: { ...footPal } });
  }

  // the home port is hand-composed (dock, tower, palms) — no random set pieces
  if (node.type !== 'pharos' && node.type !== 'home') dressIsland(g, rng0, theme, R, terrain, node);

  // In the Amber Vale the POIs stand DIRECTLY on the shared forest floor — no
  // raised pad at all, so nothing floats and nothing z-fights the ground.
  if (!flatFoot) g.add(terrain.mesh);
  if (shape?.stack && !flatFoot) g.add(seaStack(shape.stack, R, seed, footPal));
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
  return buildBattleSet(theme, opts, { structure: battleStructure(glbProp) });
}

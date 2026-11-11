/*
 * monsters.js — creatures: loading, stand-ins, per-instance clones, animation.
 *
 * THE MODELS. static/assets/monsters holds the kept Meshy sculpts (see
 * docs/MODELS.md). Each GLB is ONE fused, textured mesh named `body` under a
 * `world` root, plus a few heuristic helper meshes the auto-rig dropped in
 * (`eye` balls, a `core` ball, a `crown` ring — tools/meshy_rig.py). Those
 * helpers float off the sculpt, so prepareTemplate() deals with them:
 *   eye / core  removed — the baked emissive map (golem crystals, wraith
 *               eyes) and the hue-keyed "painted glow" in modelmat.js light
 *               the real eyes and cores on the sculpt itself, in HDR, so they
 *               bloom;
 *   crown       rebuilt as a gold circlet with a ruby, seated on the boss's
 *               head (the highest point of the front of the body); the
 *               animator sways it a touch so it catches the light.
 *
 * THE ANIMATOR drives creatures procedurally BY NAMED PART (body/head/jaw/
 * legXX/armX/wingX/tail0..N/vine0..N/weapon/shield/crown/wisp/tatter...). A
 * fused sculpt only offers `body` (+ `crown`), so today's creatures breathe,
 * hover, lunge, flinch and crumple as one piece; an articulated remake that
 * exports the other names animates fully with no code change. The remake
 * notes in docs/MODELS.md list the names per creature.
 *
 * STAND-INS. Some server model ids (board.py REGION_POOL / encounter tables)
 * have no model any more — the sculpts were cut in the V2 triage. STAND_INS
 * maps each to a kept model with a recolour and a species height, so the
 * enemy still reads as itself until it is remade. No file is ever requested
 * for a stand-in id.
 *
 * Player colours: the captain's cloak and tunic are baked neutral grey;
 * retint() hands the player colour to the material's grey-cloth key
 * (ModelMaterial.playerTint), so bronze, skin and leather keep their paint.
 *
 * Axis note: creatures face +X, up is +Y, flanks are ±Z. Limb fore-aft swings
 * are rotations about Z, wing flaps about X, tail wags about Y.
 *
 * animateMonster(group, t, mode):
 *   'idle' | 'walk' | 'cast' | 'charge'  → t is GLOBAL time (seconds)
 *   'attack' | 'hurt' | 'die'            → t is LOCAL time since the action
 *                                          started (attack ~0.9s, hurt ~0.5s,
 *                                          die ~1.2s then holds)
 * The animator only ever touches CHILDREN of the returned wrapper group —
 * callers own the wrapper's own position/rotation/scale entirely.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hashStr } from './util.js';
import { finishModel, finishOf, setModelColor, modelGlowTexture } from './modelmat.js';

/* every creature file on disk (static/assets/monsters/<id>.glb) */
export const MONSTER_IDS = [
  'jackal', 'boar', 'stalker', 'shambler', 'harpy', 'vulture', 'raider',
  'faun', 'drowned', 'golem', 'siren', 'wraith', 'shade', 'serpent', 'drake',
  'briar', 'crab', 'scorpion', 'skiff', 'captain', 'stag_king', 'wyrm',
  'colossus', 'matriarch', 'warden', 'tyrant', 'kraken', 'sphinx',
  // realm re-skins — same sculpt family, painted for its home realm
  'golem_tomb', 'golem_jade', 'serpent_dust', 'serpent_bloom',
];
const HAVE = new Set(MONSTER_IDS);

/* The whole game (battle sizing, map placement, camera framing) is tuned in
 * WORLD heights; the sculpts come out at arbitrary sizes. Every template is
 * normalized to its species height at load. */
const HEIGHTS = {
  jackal: 1.1, boar: 1.5, stalker: 1.7, shambler: 1.9, harpy: 1.7,
  vulture: 1.25, raider: 1.8, faun: 1.7, drowned: 1.8,
  golem: 2.4, siren: 1.8, wraith: 1.8, shade: 1.8, serpent: 2.2, drake: 1.7,
  briar: 1.7, crab: 1.3, scorpion: 1.6, skiff: 2.2, captain: 1.8,
  stag_king: 3.4, wyrm: 3.6, colossus: 4.2, matriarch: 4.2, warden: 4.6,
  tyrant: 4.2, kraken: 4.4, sphinx: 3.6,
  golem_tomb: 2.4, golem_jade: 2.4, serpent_dust: 2.2, serpent_bloom: 2.2,
};

/* ── stand-ins for the creatures cut in the V2 triage ──────────────────────
 * id → { use, height, finish }. `use` is the kept sculpt that plays the part,
 * `height` the species height the game expects for this id, and `finish`
 * overrides the sculpt's material finish (modelmat.js): `desat` drains the
 * baked colour, `tint` is the new coat (hex, or a LINEAR [r,g,b] multiplier
 * that may exceed 1 to bleach a coat white), `eyes` relights the eyes.
 * Remove a row when the real model is regenerated (docs/MODELS.md). */
export const STAND_INS = {
  // Leafshade Wolf / Sea Wolf — the lean jackal, bulked up, in a grey coat
  wolf:        { use: 'jackal', height: 1.45,
                 finish: { desat: 0.92, tint: [0.56, 0.52, 0.48] } },
  // Frost Wolf / Frostfang Alpha — the same hound bleached to rime
  wolf_frost:  { use: 'jackal', height: 1.5,
                 finish: { desat: 1.0, tint: [1.22, 1.38, 1.62], rough: [0.4, 0.9] } },
  // Snow Fox — the jackal at fox size, white
  fox:         { use: 'jackal', height: 0.95,
                 finish: { desat: 1.0, tint: [1.62, 1.6, 1.58] } },
  // Carrion Crow / Stymphalian Bird — a small vulture in black plumage
  bird:        { use: 'vulture', height: 1.0,
                 finish: { desat: 0.95, tint: [0.62, 0.62, 0.78] } },
  // Poison Bird — the same, in venom green
  bird_poison: { use: 'vulture', height: 1.0,
                 finish: { desat: 0.9, tint: [0.62, 1.6, 0.42] } },
  // Jaguar Shade — the stalker in a night-black coat, eyes lit green
  jaguar:      { use: 'stalker', height: 1.4,
                 finish: { desat: 1.0, tint: [0.16, 0.17, 0.22], glowTint: 0x66ff88, glow: 3 } },
  // Thorn Monkey — a small, dark thorn-imp cut from the faun
  monkey:      { use: 'faun', height: 1.15,
                 finish: { desat: 0.55, tint: [0.62, 0.52, 0.42] } },
  // Cyclops Herdsman — the golem's bulk in weathered umber, crystals as embers
  cyclops:     { use: 'golem', height: 2.6,
                 finish: { desat: 0.85, tint: [0.95, 0.60, 0.42], glowTint: 0xff5a10, glow: 5 } },
  // Stag Spirit — the Stag King at herd size, uncrowned
  stag:        { use: 'stag_king', height: 2.0, crown: false, finish: {} },
};
/* an id the client has never heard of (a newer server): a nameless shade */
const UNKNOWN_STAND_IN = { use: 'shade', height: 1.8, float: true,
  finish: { desat: 0.6, tint: [1.7, 1.6, 2.4] } };

export const BOSS_IDS = new Set(['stag_king', 'wyrm', 'colossus', 'matriarch',
  'warden', 'tyrant', 'sphinx', 'kraken']);
const FLOATERS = new Set(['wraith', 'shade', 'siren',
  // fliers hover too — wings out, feet never on the ground
  'vulture', 'harpy', 'bird', 'bird_poison']);
const BOATS = new Set(['skiff']);

/* a few sculpts came out of the auto-rig facing ±Z instead of the game's +X
 * convention — square them up at template time. */
const MODEL_YAW = {
  sphinx: Math.PI / 2, harpy: Math.PI / 2,
  // the vulture sculpt sits a further quarter-turn off its avian kin
  vulture: 0,
  shade: Math.PI / 2, scorpion: Math.PI / 2, tyrant: Math.PI / 2,
  skiff: 3 * Math.PI / 2, wyrm: 3 * Math.PI / 2,
};

/* ── material finish per creature (classes in modelmat.js) ─────────────────
 * hide = fur/feather/skin, matte with a little sheen · wet = sea-slick scale
 * and chitin · metal = the baked metal map is honoured (bronze, iron) · stone
 * = constructs. `glow` lifts the baked emissive map into HDR so crystals and
 * eyes bloom; `eyes` is the painted-glow key for sculpts whose emissive map
 * is empty (hue of the painted eye, gain, hue tolerance, min brightness). */
const eyes = (key, gain = 3, tol = 0.95, min = 0.35) => ({ key, gain, tol, min });
const MONSTER_FINISH = {
  jackal:        finishOf('hide'),
  boar:          finishOf('hide', { side: 'double' }),     // not watertight (tusks, bristles)
  vulture:       finishOf('hide'),
  harpy:         finishOf('hide'),
  faun:          finishOf('hide'),
  stag_king:     finishOf('hide'),
  sphinx:        finishOf('hide', { rough: [0.5, 0.95] }),
  raider:        finishOf('hide', { metal: 1, rough: [0.42, 0.98] }),
  captain:       finishOf('metal', { rough: [0.34, 0.96] }),
  warden:        finishOf('metal', { rough: [0.36, 0.92] }),
  tyrant:        finishOf('metal', { rough: [0.30, 0.90], eyes: eyes(0xff3a10, 3.2, 0.955, 0.4) }),
  colossus:      finishOf('stone', { rough: [0.70, 1.0], eyes: eyes(0xff2a12, 4, 0.96, 0.3) }),
  golem:         finishOf('stone', { rough: [0.62, 1.0], glow: 3.0 }),
  golem_tomb:    finishOf('stone', { rough: [0.66, 1.0], glow: 3.0 }),
  golem_jade:    finishOf('marble', { rough: [0.34, 0.9], glow: 3.0 }),
  shambler:      finishOf('wood'),
  briar:         finishOf('wood', { rough: [0.6, 0.98], eyes: eyes(0x3cff5a, 4, 0.955, 0.45) }),
  matriarch:     finishOf('wet', { rough: [0.42, 0.92], tint: [1.6, 1.7, 1.5] }),
  skiff:         finishOf('wood', { side: 'double', tint: [1.55, 1.45, 1.35] }),
  wraith:        finishOf('cloth', { glow: 3.2 }),
  shade:         finishOf('cloth', { rough: [0.5, 0.92], tint: [2.3, 2.2, 2.7], eyes: eyes(0xa24dff, 5, 0.95, 0.3) }),
  siren:         finishOf('wet', { glow: 1.1 }),
  drowned:       finishOf('wet', { rough: [0.34, 0.9], eyes: eyes(0xff8a14, 4, 0.97, 0.55) }),
  serpent:       finishOf('wet'),
  serpent_dust:  finishOf('hide', { rough: [0.5, 0.95] }),
  serpent_bloom: finishOf('wet', { rough: [0.3, 0.8] }),
  drake:         finishOf('wet', { rough: [0.3, 0.8] }),
  stalker:       finishOf('wet', { glow: 1.6 }),
  crab:          finishOf('wet', { rough: [0.2, 0.7] }),
  scorpion:      finishOf('wet', { rough: [0.12, 0.6], glow: 1.6 }),
  kraken:        finishOf('wet', { side: 'double', glow: 2.4, eyes: eyes(0xffa018, 3.5, 0.975, 0.6) }),
  wyrm:          finishOf('wet', { rough: [0.2, 0.7], side: 'double' }),
};

const loader = new GLTFLoader();
const templates = new Map();     // id → Promise<Group>  (never rejects)
const _warned = new Set();

/* ── loading ──────────────────────────────────────────────────────────────── */

function ensureTemplate(id) {
  let p = templates.get(id);
  if (p) return p;
  if (id === '_spectre') {
    // preview hook for static/modeltest.html: the last-resort fallback itself
    p = Promise.resolve(prepareTemplate(buildFallback(), id));
  } else if (HAVE.has(id)) {
    p = loader.loadAsync(`/static/assets/monsters/${id}.glb`)
      .then((gltf) => prepareTemplate(gltf.scene, id))
      .catch((err) => {
        console.warn(`monsters: failed to load '${id}', using the spectre fallback`, err);
        return prepareTemplate(buildFallback(id), id);
      });
  } else {
    let spec = STAND_INS[id];
    if (!spec) {
      if (!_warned.has(id)) {
        _warned.add(id);
        console.warn(`monsters: unknown model id '${id}' — shown as a nameless shade`);
      }
      spec = UNKNOWN_STAND_IN;
    }
    p = ensureTemplate(spec.use).then((src) => makeStandIn(src, id, spec));
  }
  templates.set(id, p);
  return p;
}

export function preloadMonsters(ids) {
  return ids.map((id) => ensureTemplate(id));
}

const RX_SUFFIX = /\.\d+$/;
const baseName = (n) => n.replace(RX_SUFFIX, '');
const _box = new THREE.Box3();

/* Finish the materials, replace the auto-rig's helper meshes, square up the
 * facing and normalize to the species height — once, on the shared template. */
function prepareTemplate(scene, id) {
  const procedural = !!scene.userData.procedural;
  let crowned = false;
  if (MODEL_YAW[id]) scene.rotation.y = MODEL_YAW[id];
  if (!procedural) {
    const helpers = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const n = baseName(o.name || '');
      if (n === 'eye' || n === 'core' || n === 'crown') helpers.push(o);
    });
    for (const o of helpers) o.parent.remove(o);
    finishModel(scene, MONSTER_FINISH[id] || finishOf('hide'));
    crowned = helpers.some((o) => baseName(o.name) === 'crown');
  }
  scene.updateMatrixWorld(true);
  _box.setFromObject(scene);
  const rawH = Math.max(0.05, _box.max.y - _box.min.y);
  const target = HEIGHTS[id];
  if (target && Math.abs(rawH - target) > 0.05) {
    scene.scale.multiplyScalar(target / rawH);   // feet stay on y=0
  }
  if (crowned) addCrown(scene);                  // after sizing: the crown is not "height"
  scene.userData.height = target || Math.max(0.6, rawH);
  scene.userData.monsterId = id;
  return scene;
}

/* The boss crown: a real 3D circlet — a thick gold band with eight raised
 * points tipped with beads and a glowing ruby on the brow — SEATED on the
 * creature's head, not floating over it. The head is found on the fused
 * sculpt itself: creatures face +X, so it is the highest point of the front
 * part of the body (front 45% of its length); the band is sized to the
 * spread of that crown-of-the-head slice and sunk a little into it, then
 * tilted to follow the slope of the head. Parented to `body` so it rides
 * every bob and lunge; named 'crown' so the animator turns it gently.
 * Set BOSS_CROWNS to false to drop the marker entirely. */
const BOSS_CROWNS = true;
let _crownGeo = null, _crownMat = null, _crownJewelMat = null, _crownJewelGeo = null;
function crownParts() {
  if (_crownGeo) return;
  // a thick band (outer + inner wall + rims) whose top rises into 8 points;
  // unit radius, band height ~0.42, points to ~0.95
  const SEG = 48, rows = [[1.0, 0.0], [1.04, 0.06], [1.02, 0.36], [1.0, 0.42]];
  const pos = [], idx = [];
  const ring = (r, y, pointy) => {
    const base = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const k = Math.abs(((i / SEG) * 8 + 0.5) % 1 - 0.5) * 2;     // 1 at a point, 0 between
      const yy = pointy ? y + Math.pow(Math.max(0, k), 2.2) * 0.55 : y;
      const rr = pointy ? r * (1 - 0.06 * Math.pow(k, 2)) : r;
      pos.push(Math.cos(a) * rr, yy, Math.sin(a) * rr);
    }
    return base;
  };
  const strips = [];
  for (const [r, y] of rows) strips.push(ring(r, y, false));
  strips.push(ring(0.99, 0.43, true));                  // outer face of the points
  strips.push(ring(0.9, 0.43, true));                   // inner face
  strips.push(ring(0.9, 0.0, false));                   // inner wall
  strips.push(strips[0]);                               // close the loop at the bottom
  for (let s = 0; s < strips.length - 1; s++) {
    const a0 = strips[s], b0 = strips[s + 1];
    for (let i = 0; i < SEG; i++) {
      const a = a0 + i, b = a0 + i + 1, c = b0 + i, d = b0 + i + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // beads on the eight points
  const parts = [geo];
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;             // the point tips
    const b = new THREE.SphereGeometry(0.075, 8, 6);
    b.translate(Math.cos(a) * 0.94, 1.0, Math.sin(a) * 0.94);
    parts.push(b);
  }
  for (const p of parts) if (p.attributes.uv) p.deleteAttribute('uv');
  geo = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  _crownGeo = geo;
  _crownMat = new THREE.MeshStandardMaterial({
    color: 0xf2bf4a, metalness: 1, roughness: 0.26,
    emissive: 0xff9a1a, emissiveIntensity: 0.35 });
  _crownJewelGeo = new THREE.SphereGeometry(0.16, 12, 8).scale(0.6, 1, 1);
  _crownJewelMat = new THREE.MeshStandardMaterial({
    color: 0x5a0610, roughness: 0.15, metalness: 0, emissive: 0xff2a3a, emissiveIntensity: 2.2 });
}
function addCrown(scene) {
  if (!BOSS_CROWNS) return;
  let body = null;
  scene.traverse((o) => { if (!body && o.isMesh && baseName(o.name || '') === 'body') body = o; });
  if (!body) return;
  crownParts();
  const pos = body.geometry.getAttribute('position');
  body.geometry.computeBoundingBox();
  const bb = body.geometry.boundingBox;
  // the body's local frame is the sculpt's; the template may be yawed so
  // that the creature faces world +X — find "forward" in body space
  scene.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const fwd = new THREE.Vector3(1, 0, 0).transformDirection(inv);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
  fwd.normalize();
  const H = bb.max.y - bb.min.y;
  let f0 = Infinity, f1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const f = pos.getX(i) * fwd.x + pos.getZ(i) * fwd.z;
    if (f < f0) f0 = f; if (f > f1) f1 = f;
  }
  const fCut = f0 + (f1 - f0) * 0.55;            // the front 45% of the body
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getX(i) * fwd.x + pos.getZ(i) * fwd.z >= fCut && pos.getY(i) > top) top = pos.getY(i);
  }
  if (!isFinite(top)) top = bb.max.y;
  // the slice just under that top: its centroid and spread size the band
  const slab = H * 0.05;
  let sx = 0, sz = 0, n = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y >= top - slab && pos.getX(i) * fwd.x + pos.getZ(i) * fwd.z >= fCut) { sx += pos.getX(i); sz += pos.getZ(i); n++; }
  }
  const cx = n ? sx / n : 0, cz = n ? sz / n : 0;
  let spread = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y >= top - slab * 1.6) {
      const d = Math.hypot(pos.getX(i) - cx, pos.getZ(i) - cz);
      if (d < H * 0.2 && d > spread) spread = d;
    }
  }
  const R = THREE.MathUtils.clamp(spread * 1.05, H * 0.045, H * 0.1);
  const crown = new THREE.Group();
  crown.name = 'crown';
  crown.position.set(cx, top - R * 0.32, cz);
  const band = new THREE.Mesh(_crownGeo, _crownMat);
  band.scale.setScalar(R);
  band.castShadow = true;
  const jewel = new THREE.Mesh(_crownJewelGeo, _crownJewelMat);
  // the ruby sits on the brow: the band's forward face
  jewel.position.set(fwd.x * R * 1.03, R * 0.22, fwd.z * R * 1.03);
  jewel.scale.setScalar(R);
  jewel.lookAt(jewel.position.clone().multiplyScalar(2));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: modelGlowTexture(), color: new THREE.Color(1.0, 0.7, 0.26),
    transparent: true, opacity: 0.18, depthWrite: false,
    blending: THREE.AdditiveBlending }));
  halo.position.y = R * 0.5;
  halo.scale.setScalar(R * 4);
  crown.add(band, jewel, halo);
  crown.userData.fwd = fwd.clone();
  body.add(crown);
}

/* A removed creature played by a kept sculpt: same geometry and textures, its
 * own recoloured material, its own species height. */
function makeStandIn(src, id, spec) {
  const s = src.clone(true);
  if (spec.crown === false) {
    const crowns = [];
    s.traverse((o) => { if (o.name === 'crown') crowns.push(o); });
    for (const o of crowns) o.parent.remove(o);
  }
  const mats = new Map();
  const f = spec.finish || {};
  s.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.isModelMaterial) return;
    let m = mats.get(o.material);
    if (!m) {
      m = o.material.clone();
      if (f.desat != null) m.finish.z = f.desat;
      if (f.tint != null) setModelColor(m.tint, f.tint);
      if (f.rough) { m.finish.x = f.rough[0]; m.finish.y = f.rough[1]; }
      if (f.glow != null) m.emissiveIntensity = f.glow;
      if (f.glowTint != null) { m.emissive.set(f.glowTint); m.glowParams.z = 0; }
      if (f.eyes) {
        setModelColor(_col, f.eyes.key);
        m.glowKey.set(_col.r, _col.g, _col.b, f.eyes.gain ?? 3);
        m.glowParams.x = f.eyes.tol ?? 0.95;
        m.glowParams.y = f.eyes.min ?? 0.35;
      }
      mats.set(o.material, m);
    }
    o.material = m;
  });
  s.scale.multiplyScalar(spec.height / src.userData.height);
  s.userData = { height: spec.height, monsterId: id, standIn: spec.use, float: !!spec.float };
  return s;
}
const _col = new THREE.Color();

/* Last resort — a GLB failed to load (offline, bad deploy). A small hooded
 * spectre built from smooth primitives: robe, cowl, two lit eyes, drifting
 * motes. It is named on the animator's contract (body/head/eye/wisp)
 * so it hovers, sways and fights like any other creature, and it is clearly
 * a deliberate "something is here" figure rather than a debug blob. */
function buildFallback() {
  const root = new THREE.Group();
  root.name = 'root';
  root.userData.procedural = true;
  root.userData.float = true;      // it drifts, whatever it is standing in for
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);
  const robeMat = new THREE.MeshStandardMaterial({
    color: 0x343650, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    emissive: 0x1a2460, emissiveIntensity: 0.1 });
  // robe: a lathe profile, narrow shoulders flaring to a ragged, open hem
  const prof = [];
  const P = [[0.50, 0.00], [0.46, 0.10], [0.36, 0.42], [0.30, 0.78], [0.27, 1.05],
             [0.25, 1.22], [0.17, 1.32], [0.0, 1.36]];
  for (const [r, y] of P) prof.push(new THREE.Vector2(r, y));
  const robeGeo = new THREE.LatheGeometry(prof, 28);
  const rp = robeGeo.getAttribute('position');
  for (let i = 0; i < rp.count; i++) {              // tattered hem
    const y = rp.getY(i);
    if (y < 0.12) {
      const a = Math.atan2(rp.getZ(i), rp.getX(i));
      rp.setY(i, y + Math.max(0, Math.sin(a * 7)) * 0.13 + Math.sin(a * 3 + 1) * 0.03);
    }
  }
  robeGeo.computeVertexNormals();
  const robe = new THREE.Mesh(robeGeo, robeMat);
  robe.castShadow = true; robe.receiveShadow = true;
  robe.name = 'robe';
  body.add(robe);
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 1.42, 0);
  body.add(head);
  // cowl: a sphere shell open toward +X (the face)
  const cowl = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 24, 16, 0.55, Math.PI * 2 - 1.1), robeMat);
  cowl.rotation.y = Math.PI;
  cowl.scale.set(1.05, 1.15, 1);
  cowl.castShadow = true;
  head.add(cowl);
  const dark = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x05060c }));
  dark.position.x = 0.02;
  head.add(dark);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10, emissive: 0x7fd8ff, emissiveIntensity: 3.2, roughness: 0.4 });
  for (const sz of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.036, 10, 8), eyeMat);
    e.name = 'eye';
    e.position.set(0.19, 0.0, 0.075 * sz);
    head.add(e);
  }
  const moteMat = new THREE.SpriteMaterial({
    map: modelGlowTexture(), color: new THREE.Color(0.6, 1.2, 1.7), transparent: true,
    opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
  for (let i = 0; i < 3; i++) {
    const w = new THREE.Sprite(moteMat);
    w.name = 'wisp';
    const a = i * 2.1;
    w.position.set(Math.cos(a) * 0.5, 0.75 + i * 0.22, Math.sin(a) * 0.5);
    w.scale.setScalar(0.2);
    body.add(w);
  }
  return root;
}

/* ── instancing ───────────────────────────────────────────────────────────── */

export async function getMonster(id, { tint = null, scale = 1 } = {}) {
  const tpl = await ensureTemplate(id);
  const inner = tpl.clone(true);
  const wrapper = new THREE.Group();
  wrapper.name = `monster:${id}`;
  wrapper.add(inner);

  // per-instance material clones for anything we animate (glow pulse) or
  // recolor (player tint) — everything else keeps sharing the cached material.
  const ownedMats = [];
  const emissives = [];
  const tintables = [];
  const cloneMap = new Map();
  inner.traverse((o) => {
    if (!o.isMesh && !o.isSprite) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    let changed = false;
    const out = mats.map((m) => {
      if (!m) return m;
      const sprite = !!m.isSpriteMaterial;
      const glows = sprite || (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.001
        && m.emissiveIntensity > 0) || (m.isModelMaterial && m.glowKey.w > 0);
      const tintable = !!m.isModelMaterial && id === 'captain';
      if (!glows && !tintable) return m;
      let c = cloneMap.get(m);
      if (!c) {
        c = m.clone();
        cloneMap.set(m, c);
        ownedMats.push(c);
        if (glows) {
          emissives.push({
            mat: c, sprite,
            baseI: sprite ? c.opacity : c.emissiveIntensity,
            baseE: sprite ? null : c.emissive.clone(),
            baseK: c.isModelMaterial ? c.glowKey.w : 0,
          });
        }
        if (tintable) tintables.push(c);
      }
      changed = true;
      return c;
    });
    if (changed) o.material = Array.isArray(o.material) ? out : out[0];
  });

  const rig = buildRig(inner, id);
  rig.emissives = emissives;
  wrapper.userData = {
    monsterId: id,
    rig,
    ownedMats,
    tintables,
    phase: (hashStr(id) % 628) / 100 + Math.random() * 2,
    height: tpl.userData.height,
    float: FLOATERS.has(id) || !!tpl.userData.float,
    boat: BOATS.has(id),
  };
  if (tint) retint(wrapper, tint);
  if (scale !== 1) wrapper.scale.setScalar(scale);
  return wrapper;
}

/* Player colour → the captain's neutral-grey cloth (cloak, tunic, crest). */
export function retint(group, cssColor) {
  const tintables = group.userData && group.userData.tintables;
  if (!tintables || !tintables.length) return;
  for (const m of tintables) {
    m.playerTint.set(cssColor);
    m.finish.w = 1;
  }
}

/* ── rig discovery ────────────────────────────────────────────────────────── */

function snap(node) {
  return {
    node,
    p: node.position.clone(),
    r: node.rotation.clone(),
    s: node.scale.clone(),
  };
}

function buildRig(inner, id) {
  const rig = {
    inner: snap(inner),
    body: null, head: null, jaw: null, weapon: null, shield: null,
    crown: null, bloom: null, stinger: null, tailtip: null, sail: null,
    legFL: null, legFR: null, legBL: null, legBR: null,
    armL: null, armR: null, legL: null, legR: null,
    wingL: null, wingR: null, clawL: null, clawR: null,
    tails: [], vines: [], wisps: [], bugLegs: [], tatters: [], weeds: [],
    all: [],       // every snapped part, for the per-frame reset
    emissives: [],
  };
  const grab = (sn) => { rig.all.push(sn); return sn; };
  inner.traverse((o) => {
    if (o === inner) return;
    const n = baseName(o.name || '');
    let m;
    if (n === 'body' || n === 'head' || n === 'jaw' || n === 'weapon' ||
        n === 'shield' || n === 'crown' || n === 'bloom' || n === 'stinger' ||
        n === 'tailtip' || n === 'sailm' ||
        n === 'legFL' || n === 'legFR' || n === 'legBL' || n === 'legBR' ||
        n === 'armL' || n === 'armR' || n === 'legL' || n === 'legR' ||
        n === 'wingL' || n === 'wingR' || n === 'clawL' || n === 'clawR') {
      const key = n === 'sailm' ? 'sail' : n;
      if (!rig[key]) rig[key] = grab(snap(o));
    } else if ((m = n.match(/^tail(\d+)$/))) {
      rig.tails[+m[1]] = grab(snap(o));
    } else if ((m = n.match(/^vine(\d+)$/))) {
      rig.vines[+m[1]] = grab(snap(o));
    } else if (n === 'wisp') {
      rig.wisps.push(grab(snap(o)));
    } else if (n === 'tatter') {
      rig.tatters.push(grab(snap(o)));
    } else if (n === 'weed') {
      rig.weeds.push(grab(snap(o)));
    } else if ((m = n.match(/^leg(\d+)([LR])$/))) {
      rig.bugLegs.push(Object.assign(grab(snap(o)), { i: +m[1], side: m[2] === 'L' ? 1 : -1 }));
    }
  });
  rig.tails = rig.tails.filter(Boolean);
  rig.vines = rig.vines.filter(Boolean);
  rig.quadruped = !!(rig.legFL && rig.legFR && rig.legBL && rig.legBR);
  rig.biped = !!(rig.legL && rig.legR);
  rig.slither = rig.tails.length >= 4;   // serpents: positional coil segments
  return rig;
}

function resetRig(rig) {
  for (const sn of rig.all) {
    sn.node.position.copy(sn.p);
    sn.node.rotation.copy(sn.r);
    sn.node.scale.copy(sn.s);
  }
  const inn = rig.inner;
  inn.node.position.copy(inn.p);
  inn.node.rotation.copy(inn.r);
  inn.node.scale.copy(inn.s);
  for (const e of rig.emissives) {
    if (e.sprite) { e.mat.opacity = e.baseI; continue; }
    e.mat.emissiveIntensity = e.baseI;
    e.mat.emissive.copy(e.baseE);
    if (e.baseK) e.mat.glowKey.w = e.baseK;
  }
}

/* scale every glowing thing on the creature (baked emissive, painted eyes,
 * halo sprites) by k — the animator's one knob for "power" */
function setGlow(rig, k) {
  for (const e of rig.emissives) {
    if (e.sprite) { e.mat.opacity = Math.min(1, e.baseI * k); continue; }
    e.mat.emissiveIntensity = e.baseI * k;
    if (e.baseK) e.mat.glowKey.w = e.baseK * k;
  }
}

/* ── the animator ─────────────────────────────────────────────────────────── */

const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeIn = (k) => k * k;
const clamp01 = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);
const _red = new THREE.Color(0xff3524);

export function animateMonster(group, t, mode) {
  const u = group.userData;
  if (!u || !u.rig) return;
  const rig = u.rig;
  const ph = u.phase;
  resetRig(rig);
  switch (mode) {
    case 'walk': poseLocomotion(rig, u, t, ph, true); break;
    case 'attack': poseAttack(rig, u, t, ph); break;
    case 'hurt': poseHurt(rig, u, t, ph); break;
    case 'die': poseDie(rig, u, t, ph); break;
    case 'cast': poseLocomotion(rig, u, t, ph, false); poseCast(rig, u, t, ph, false); break;
    case 'charge': poseLocomotion(rig, u, t, ph, false); poseCast(rig, u, t, ph, true); break;
    default: poseLocomotion(rig, u, t, ph, false); break;
  }
}

/* shared idle/walk body language */
function poseLocomotion(rig, u, t, ph, walking) {
  const body = rig.body;
  const w = t * (walking ? 7.5 : 2.1) + ph;

  if (body) {
    // breath: gentle vertical swell
    body.node.scale.y = body.s.y * (1 + Math.sin(t * 2.3 + ph) * 0.025);
    if (walking) {
      body.node.position.y = body.p.y + Math.abs(Math.sin(w)) * 0.07;
      body.node.rotation.z = body.r.z + Math.sin(w * 2) * 0.02;
    }
    if (u.float) {
      // wraith hover: bob high, slow figure-eight sway, no footwork
      body.node.position.y = body.p.y + 0.3 + Math.sin(t * 1.7 + ph) * 0.17;
      body.node.rotation.x = body.r.x + Math.sin(t * 0.9 + ph) * 0.07;
      body.node.rotation.z = body.r.z + Math.cos(t * 0.7 + ph) * 0.06;
    }
    if (u.boat) {
      body.node.position.y = body.p.y + Math.sin(t * 1.6 + ph) * 0.08;
      body.node.rotation.x = body.r.x + Math.sin(t * 1.1 + ph) * 0.05;
      body.node.rotation.z = body.r.z + Math.sin(t * 1.4 + ph + 2) * 0.04;
    }
  }

  if (rig.head) {
    const h = rig.head;
    h.node.rotation.y = h.r.y + Math.sin(t * 0.55 + ph) * 0.14;
    h.node.rotation.z = h.r.z + Math.sin(t * 0.8 + ph + 1.7) * 0.05
      + (walking ? Math.sin(w * 2) * 0.03 : 0);
  }

  // quadruped gait: diagonal pairs (FL+BR vs FR+BL)
  if (rig.quadruped) {
    const amp = walking ? 0.55 : 0.03;
    const a = Math.sin(w) * amp;
    rig.legFL.node.rotation.z = rig.legFL.r.z + a;
    rig.legBR.node.rotation.z = rig.legBR.r.z + a;
    rig.legFR.node.rotation.z = rig.legFR.r.z - a;
    rig.legBL.node.rotation.z = rig.legBL.r.z - a;
  }

  // biped gait + arm counterswing
  if (rig.biped) {
    const amp = walking ? 0.5 : 0.02;
    const a = Math.sin(w) * amp;
    rig.legL.node.rotation.z = rig.legL.r.z + a;
    rig.legR.node.rotation.z = rig.legR.r.z - a;
    if (rig.armL) rig.armL.node.rotation.z = rig.armL.r.z - a * 0.7 + (walking ? 0 : Math.sin(t * 1.9 + ph) * 0.05);
    if (rig.armR) rig.armR.node.rotation.z = rig.armR.r.z + a * 0.7 + (walking ? 0 : Math.sin(t * 1.9 + ph + 2) * 0.05);
  } else if (u.float) {
    // wraith arms drift like kelp
    if (rig.armL) rig.armL.node.rotation.x = rig.armL.r.x + Math.sin(t * 1.3 + ph) * 0.18;
    if (rig.armR) rig.armR.node.rotation.x = rig.armR.r.x - Math.sin(t * 1.3 + ph + 1.1) * 0.18;
  }

  // wings: soft idle flap, hard travel flap
  if (rig.wingL && rig.wingR) {
    const f = walking ? Math.sin(t * 9 + ph) * 0.55
                      : 0.1 + Math.sin(t * 2.6 + ph) * 0.16;
    rig.wingL.node.rotation.x = rig.wingL.r.x + f;
    rig.wingR.node.rotation.x = rig.wingR.r.x - f;
    if (rig.body && walking) {
      rig.body.node.position.y = rig.body.p.y + 0.2 + Math.sin(t * 9 + ph - 1.2) * 0.12;
    }
  }

  // tails: short tails wag, long serpent coils slither positionally
  if (rig.slither) {
    const n = rig.tails.length;
    for (let i = 0; i < n; i++) {
      const seg = rig.tails[i];
      const k = i / n;
      seg.node.position.z = seg.p.z + Math.sin(t * 2.4 + ph + i * 0.85) * 0.16 * (0.25 + k);
      seg.node.position.y = seg.p.y + Math.sin(t * 3.1 + ph + i * 1.2) * 0.05 * k;
    }
    if (rig.tailtip) {
      rig.tailtip.node.position.z = rig.tailtip.p.z + Math.sin(t * 2.4 + ph + n * 0.85) * 0.22;
    }
  } else {
    for (let i = 0; i < rig.tails.length; i++) {
      const seg = rig.tails[i];
      seg.node.rotation.y = seg.r.y + Math.sin(t * (walking ? 6 : 2.2) + ph + i * 0.7) * 0.28;
    }
    if (rig.stinger) {
      rig.stinger.node.rotation.z = rig.stinger.r.z + Math.sin(t * 2.0 + ph) * 0.1;
    }
  }

  // plant-horror vines writhe with phase offsets
  for (let i = 0; i < rig.vines.length; i++) {
    const v = rig.vines[i];
    v.node.rotation.y = v.r.y + Math.sin(t * 1.6 + ph + i * 1.9) * 0.22;
    v.node.rotation.x = v.r.x + Math.sin(t * 1.1 + ph + i * 2.6) * 0.14;
  }
  if (rig.bloom) {
    rig.bloom.node.rotation.y = rig.bloom.r.y + t * 0.25;
  }

  // arthropod scuttle
  if (rig.bugLegs.length) {
    const amp = walking ? 0.3 : 0.04;
    for (const l of rig.bugLegs) {
      const a = Math.sin(w * 1.35 + l.i * 2.1 + (l.side > 0 ? 0 : Math.PI)) * amp;
      l.node.rotation.x = l.r.x + a * l.side * 0.6;
      l.node.rotation.y = l.r.y + a;
    }
  }
  if (rig.clawL) rig.clawL.node.rotation.y = rig.clawL.r.y + Math.sin(t * 1.7 + ph) * 0.1;
  if (rig.clawR) rig.clawR.node.rotation.y = rig.clawR.r.y - Math.sin(t * 1.7 + ph + 0.8) * 0.1;

  // spectral wisps orbit their anchors
  for (let i = 0; i < rig.wisps.length; i++) {
    const wp = rig.wisps[i];
    wp.node.position.x = wp.p.x + Math.sin(t * 1.4 + i * 2.1 + ph) * 0.16;
    wp.node.position.z = wp.p.z + Math.cos(t * 1.4 + i * 2.1 + ph) * 0.16;
    wp.node.position.y = wp.p.y + Math.sin(t * 2.2 + i * 1.3 + ph) * 0.12;
  }
  for (let i = 0; i < rig.tatters.length; i++) {
    const tt = rig.tatters[i];
    tt.node.rotation.x = tt.r.x + Math.sin(t * 3.1 + i * 1.4 + ph) * 0.12;
  }
  for (let i = 0; i < rig.weeds.length; i++) {
    const wd = rig.weeds[i];
    wd.node.rotation.z = wd.r.z + Math.sin(t * 2.2 + i * 1.7 + ph) * 0.09;
  }
  if (rig.sail) {
    rig.sail.node.rotation.y = rig.sail.r.y + Math.sin(t * 1.2 + ph) * 0.05;
  }
  // the boss crown turns slowly and rides a small bob of its own
  if (rig.crown) {
    // seated on the head: it only catches the light with a slow glint-sway
    const c = rig.crown;
    c.node.rotation.y = c.r.y + Math.sin(t * 0.6 + ph) * 0.12;
  }
}

/* attack: coiled windup → jaw-snapping lunge → recover.  t is LOCAL. */
function poseAttack(rig, u, t, ph) {
  const DUR = 0.9;
  const k = clamp01(t / DUR);
  // motion curve: -0.35 windup until 0.32, whipcrack to +1 at 0.5, ease home
  let drive;
  if (k < 0.32) drive = -easeOut(k / 0.32) * 0.38;
  else if (k < 0.52) drive = -0.38 + easeIn((k - 0.32) / 0.2) * 1.38;
  else drive = 1 - easeOut((k - 0.52) / 0.48);
  const body = rig.body;
  if (body) {
    body.node.position.x = body.p.x + drive * 0.55;
    body.node.rotation.z = body.r.z + (drive < 0 ? -drive * 0.35 : -drive * 0.12);
    if (u.float) body.node.position.y = body.p.y + 0.3 - Math.max(0, drive) * 0.15;
  }
  if (rig.head) {
    rig.head.node.rotation.z = rig.head.r.z - Math.max(0, drive) * 0.25
      + Math.min(0, drive) * 0.4;
  }
  // jaw snaps: gapes through the windup+lunge, clacks shut at contact
  if (rig.jaw) {
    const open = k < 0.5 ? easeOut(clamp01(k / 0.32)) : Math.max(0, 1 - (k - 0.5) / 0.12);
    rig.jaw.node.rotation.z = rig.jaw.r.z - open * 0.55;
  }
  // weapon arm hews down through the strike
  if (rig.weapon) {
    const swing = k < 0.32 ? -easeOut(k / 0.32) * 0.7
      : k < 0.55 ? -0.7 + easeIn((k - 0.32) / 0.23) * 1.6
      : 0.9 - easeOut((k - 0.55) / 0.45) * 0.9;
    rig.weapon.node.rotation.z = rig.weapon.r.z + swing;
  }
  if (rig.armR) rig.armR.node.rotation.z = rig.armR.r.z + drive * 0.9;
  if (rig.armL) rig.armL.node.rotation.z = rig.armL.r.z - drive * 0.35;
  if (rig.clawL) rig.clawL.node.rotation.y = rig.clawL.r.y + Math.max(0, drive) * 0.7;
  if (rig.clawR) rig.clawR.node.rotation.y = rig.clawR.r.y - Math.max(0, drive) * 0.7;
  if (rig.stinger) rig.stinger.node.rotation.z = rig.stinger.r.z - Math.max(0, drive) * 0.8;
  for (let i = 0; i < rig.vines.length; i++) {
    const v = rig.vines[i];
    v.node.rotation.y = v.r.y + drive * 0.5 * (i % 2 ? 1 : -1);
    v.node.rotation.x = v.r.x - Math.max(0, drive) * 0.3;
  }
  if (rig.wingL && rig.wingR) {
    const f = Math.sin(t * 22 + ph) * 0.5 * (1 - k * 0.5);
    rig.wingL.node.rotation.x = rig.wingL.r.x + f - Math.max(0, drive) * 0.4;
    rig.wingR.node.rotation.x = rig.wingR.r.x - f + Math.max(0, drive) * 0.4;
  }
  // emissives spike at the moment of contact
  setGlow(rig, 1 + Math.max(0, drive) * 1.6);
}

/* flinch: sharp recoil + decaying shudder.  t is LOCAL. */
function poseHurt(rig, u, t, ph) {
  const DUR = 0.5;
  const k = clamp01(t / DUR);
  const decay = 1 - k;
  const shudder = Math.sin(k * Math.PI * 4 + ph) * decay;
  const body = rig.body;
  if (body) {
    body.node.position.x = body.p.x - easeOut(Math.min(1, k * 3)) * decay * 0.3;
    body.node.rotation.x = body.r.x + shudder * 0.14;
    body.node.rotation.z = body.r.z + decay * 0.12;
    if (u.float) body.node.position.y = body.p.y + 0.3 - decay * 0.1;
  }
  if (rig.head) {
    rig.head.node.rotation.z = rig.head.r.z + decay * 0.3;
    rig.head.node.rotation.y = rig.head.r.y + shudder * 0.2;
  }
  if (rig.jaw) rig.jaw.node.rotation.z = rig.jaw.r.z - decay * 0.3;
  setGlow(rig, 1 + decay * 1.2);
}

/* death: crumple, shrink, sink.  t is LOCAL; pose holds at t>=1.2s. */
function poseDie(rig, u, t) {
  const k = easeIn(clamp01(t / 1.2));
  const inn = rig.inner;
  const s = Math.max(0.04, 1 - k * 0.92);
  inn.node.scale.set(inn.s.x * s, inn.s.y * s, inn.s.z * s);
  inn.node.position.y = inn.p.y - k * u.height * 0.55;
  inn.node.rotation.z = inn.r.z + k * 0.5;
  inn.node.rotation.x = inn.r.x + k * 0.25;
  if (rig.jaw) rig.jaw.node.rotation.z = rig.jaw.r.z - clamp01(t / 0.25) * 0.4;
  setGlow(rig, Math.max(0, 1 - k * 1.4));
}

/* cast / charge: emissive pulse; charge also rears up, burning red. */
function poseCast(rig, u, t, ph, heavy) {
  const rate = heavy ? 12 : 8;
  const pulse = heavy ? 1.9 + Math.sin(t * rate + ph) * 1.4
                      : 1.5 + Math.sin(t * rate + ph) * 0.9;
  setGlow(rig, pulse);
  if (heavy) {
    const k = 0.55 + Math.sin(t * rate + ph) * 0.25;
    for (const e of rig.emissives) if (!e.sprite) e.mat.emissive.lerpColors(e.baseE, _red, k);
  }
  const body = rig.body;
  if (heavy && body) {
    // rear up, front lifted, trembling with held power
    body.node.rotation.z = body.r.z + 0.2 + Math.sin(t * 7 + ph) * 0.03;
    body.node.position.y = body.p.y + (u.float ? 0.42 : 0.14);
    if (rig.legFL) rig.legFL.node.rotation.z = rig.legFL.r.z + 0.55;
    if (rig.legFR) rig.legFR.node.rotation.z = rig.legFR.r.z + 0.45;
    if (rig.head) rig.head.node.rotation.z = rig.head.r.z + 0.18;
    if (rig.jaw) rig.jaw.node.rotation.z = rig.jaw.r.z - 0.35;
  }
  if (!heavy && rig.armL && rig.armR) {
    // arms raised in incantation
    rig.armL.node.rotation.z = rig.armL.r.z - 0.6 + Math.sin(t * 3 + ph) * 0.08;
    rig.armR.node.rotation.z = rig.armR.r.z - 0.6 + Math.sin(t * 3 + ph + 1) * 0.08;
  }
  if (rig.weapon && heavy) {
    rig.weapon.node.rotation.z = rig.weapon.r.z - 0.5;
  }
  for (let i = 0; i < rig.vines.length; i++) {
    const v = rig.vines[i];
    v.node.rotation.x = v.r.x - (heavy ? 0.4 : 0.2) + Math.sin(t * 5 + i * 1.9) * 0.1;
  }
}

/* Dispose the per-instance materials getMonster created (geometry stays —
 * it is shared with the cached template). battle.js calls this on exit. */
export function disposeMonster(group) {
  const u = group.userData;
  if (u && u.ownedMats) {
    for (const m of u.ownedMats) m.dispose();
    u.ownedMats.length = 0;
  }
}

/*
 * props.js — the island filler props and biome flora (static/assets/props).
 *
 * Loads each decoration GLB once, gives it its material finish for the HDR
 * renderer (modelmat.js), normalizes it to its natural WORLD height sitting
 * on the ground, and hands out clones. propGroup() returns an EMPTY group
 * immediately and drops the model in when the GLB finishes loading, so the
 * synchronous island builder can scatter props without waiting.
 *
 * docs/MODELS.md is the catalogue: what every kept prop is for, what was
 * removed in the V2 triage and why, and the remake list.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { finishModel, finishOf, setModelColor } from './modelmat.js';

/* every prop file on disk */
export const PROP_IDS = [
  // core filler props
  'boulder', 'shipwreck', 'crystal_cluster', 'broken_statue',
  'cairn', 'dead_tree', 'driftwood', 'amphora_pile', 'coral',
  'mushroom_cluster', 'ice_shard', 'bone_pile', 'mossy_idol',
  // environment props
  'barrel', 'fishing_net', 'brazier', 'stone_well',
  'sarcophagus', 'ruined_arch', 'banner_pole', 'campfire', 'lily_pads', 'tide_pool',
  'tomb', 'barrow', 'waymarker_stone', 'jungle_dungeon',
  // biome flora
  'pine_tree', 'pine_snow', 'palm_tree', 'cypress_tree', 'olive_tree',
  'jungle_tree', 'dead_scrub', 'fern_cluster', 'reeds',
];

/* Removed in the V2 model triage — the sculpts were not good enough to ship
   (docs/MODELS.md has the reasons and the remake notes). propGroup() of one
   of these is an EMPTY group: nothing is fetched and nothing is logged, so a
   legacy call site degrades to "no prop here" instead of a 404. */
export const REMOVED_PROPS = new Set([
  'ruined_column', 'sand_dune', 'ice_floe', 'iceberg', 'monster_totem',
  'buoy', 'cactus', 'autumn_tree',
]);

/* Natural WORLD height per prop (units; the captain is 1.8). */
const PROP_HEIGHTS = {
  // core filler
  boulder: 1.4, shipwreck: 3.0, crystal_cluster: 1.6,
  broken_statue: 1.6, cairn: 1.4, dead_tree: 2.8, driftwood: 0.8,
  amphora_pile: 1.0, coral: 1.1, mushroom_cluster: 1.0, ice_shard: 1.6,
  bone_pile: 0.7, mossy_idol: 1.6,
  // environment
  barrel: 0.9, fishing_net: 0.6, brazier: 1.2,
  stone_well: 2.0, sarcophagus: 1.4, ruined_arch: 3.0, banner_pole: 2.6,
  campfire: 0.8, lily_pads: 0.35, tide_pool: 0.5,
  tomb: 1.6, barrow: 1.6, waymarker_stone: 1.6, jungle_dungeon: 2.4,
  // biome flora
  pine_tree: 3.8, pine_snow: 3.8, palm_tree: 3.6, cypress_tree: 3.6,
  olive_tree: 2.6, jungle_tree: 3.4,
  dead_scrub: 1.0, fern_cluster: 0.9, reeds: 1.5,
};

/* Material finish per prop (classes in modelmat.js). Stone, timber, cloth and
   leaves stay matte; ice, crystal, wet rock and glazed caps keep their gloss;
   iron bands and the gold mask are real metal; fire and crystal light bloom.
   `side: 'double'` is for foliage, cloth and open shells — everything else is
   a closed sculpt and renders single-sided (cheaper, cleaner shadows). */
const FIRE = { key: 0xffa41c, gain: 4.5, tol: 0.93, min: 0.5 };
const PROP_FINISH = {
  boulder:          finishOf('stone'),
  cairn:            finishOf('stone'),
  mossy_idol:       finishOf('stone'),
  ruined_arch:      finishOf('stone'),
  waymarker_stone:  finishOf('stone'),
  tomb:             finishOf('stone', { rough: [0.74, 1.0] }),
  barrow:           finishOf('stone'),
  jungle_dungeon:   finishOf('stone', { rough: [0.70, 1.0] }),
  stone_well:       finishOf('stone', { side: 'double' }),
  broken_statue:    finishOf('marble'),
  bone_pile:        finishOf('marble', { rough: [0.60, 0.95] }),
  amphora_pile:     finishOf('marble', { rough: [0.58, 0.92] }),
  shipwreck:        finishOf('wood', { side: 'double' }),
  dead_tree:        finishOf('wood', { side: 'double' }),
  driftwood:        finishOf('wood', { rough: [0.62, 0.95] }),
  barrel:           finishOf('wood', { metal: 0.9, rough: [0.45, 0.95] }),
  fishing_net:      finishOf('cloth'),
  banner_pole:      finishOf('cloth'),
  sarcophagus:      finishOf('metal', { rough: [0.32, 0.92] }),
  brazier:          finishOf('ember', { eyes: FIRE }),
  campfire:         finishOf('stone', { side: 'double', eyes: FIRE }),
  coral:            finishOf('wet', { rough: [0.38, 0.85], glow: 0 }),
  tide_pool:        finishOf('wet', { rough: [0.16, 0.85], glow: 0 }),
  lily_pads:        finishOf('foliage', { rough: [0.36, 0.85] }),
  mushroom_cluster: finishOf('foliage', { rough: [0.34, 0.85], side: 'front' }),
  crystal_cluster:  finishOf('crystal', { glowGate: 0.5 }),
  ice_shard:        finishOf('ice', { glowGate: 0 }),
  pine_tree:        finishOf('foliage'),
  pine_snow:        finishOf('foliage'),
  palm_tree:        finishOf('foliage'),
  cypress_tree:     finishOf('foliage'),
  olive_tree:       finishOf('foliage'),
  jungle_tree:      finishOf('foliage'),
  dead_scrub:       finishOf('foliage', { rough: [0.8, 1.0] }),
  fern_cluster:     finishOf('foliage'),
  reeds:            finishOf('foliage'),
};

/* Recoloured variants of kept sculpts — a new id that shares another prop's
   geometry and textures but gets its own colour (desat + tint, see modelmat.js)
   and height. Used where a
   realm needs a tree the kept set doesn't have yet (docs/MODELS.md):
     amber_tree   the gnarled olive in autumn copper — the Amber Vale's tree
                  until a real autumn oak/beech is generated */
const PROP_VARIANTS = {
  amber_tree: { use: 'olive_tree', height: 3.0, desat: 0.9, tint: [3.4, 1.55, 0.42] },
};
export const PROP_VARIANT_IDS = Object.keys(PROP_VARIANTS);

const loader = new GLTFLoader();
const templates = new Map();   // id → Promise<Group|null> (never rejects)
const _none = Promise.resolve(null);

function ensure(id) {
  if (REMOVED_PROPS.has(id)) return _none;
  let p = templates.get(id);
  if (p) return p;
  const variant = PROP_VARIANTS[id];
  if (variant) {
    // same geometry + textures as the source prop, its own recoloured material
    p = ensure(variant.use).then((src) => {
      if (!src) return null;
      const s = src.clone(true);
      const mats = new Map();
      s.traverse((o) => {
        if (!o.isMesh || !o.material || !o.material.isModelMaterial) return;
        let m = mats.get(o.material);
        if (!m) {
          m = o.material.clone();
          if (variant.desat != null) m.finish.z = variant.desat;
          if (variant.tint != null) setModelColor(m.tint, variant.tint);
          mats.set(o.material, m);
        }
        o.material = m;
      });
      const k = variant.height / (PROP_HEIGHTS[variant.use] || 1.6);
      s.scale.multiplyScalar(k);
      s.position.y *= k;
      return s;
    });
    templates.set(id, p);
    return p;
  }
  p = loader.loadAsync(`/static/assets/props/${id}.glb`)
    .then((gltf) => {
      const s = gltf.scene;
      finishModel(s, PROP_FINISH[id] || finishOf('stone', { side: 'double' }));
      // normalize to the prop's NATURAL height and rest it on the ground
      const box = new THREE.Box3().setFromObject(s);
      const h = Math.max(0.001, box.max.y - box.min.y);
      s.scale.setScalar((PROP_HEIGHTS[id] || 1.6) / h);
      const b2 = new THREE.Box3().setFromObject(s);
      // Ground it, then SINK ~8% so any base slab/disc/pot Meshy insists on
      // adding is buried below the terrain surface — no floating base ever, and
      // props nestle into the ground like real board-game pieces.
      s.position.y -= b2.min.y + 0.08 * (b2.max.y - b2.min.y);
      return s;
    })
    .catch(() => null);   // missing prop → placed as nothing
  templates.set(id, p);
  return p;
}

export function preloadProps(ids = PROP_IDS) {
  return ids.map((id) => ensure(id));
}

/* An Object3D placed on the map NOW; the model appears inside it once loaded.
   Pass castShadow=false for dense filler (e.g. the Vale's titan trees) whose
   big soft ground shadows would sprawl across the floor like drifting cloud
   shadows — they still RECEIVE shadow, they just don't throw one. */
export function propGroup(id, scale = 1, castShadow = true) {
  const g = new THREE.Group();
  ensure(id).then((t) => {
    if (!t) return;
    const c = t.clone(true);
    c.scale.multiplyScalar(scale);
    if (!castShadow) c.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    // RE-GROUND at the final scale. The template's ground offset was baked
    // for scale 1, but many Meshy models pivot near their VERTICAL CENTRE —
    // so scaling up (the Vale's ×5–10 titan trees) dragged the base metres
    // below the floor and the trunks clipped into the ground. Clear that
    // offset and seat the SCALED base on y≈0, with a small sink (capped, so
    // giants don't bury) to hide any base slab.
    c.position.set(0, 0, 0);
    c.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(c);
    if (isFinite(bb.min.y)) {
      const sink = Math.min(0.4, 0.08 * (bb.max.y - bb.min.y));
      c.position.y = -bb.min.y - sink;
    }
    g.add(c);
  });
  return g;
}

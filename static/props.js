/*
 * props.js — Meshy-baked island filler props.
 *
 * Loads the decoration GLBs (tools/meshy_props.py) once, normalizes each to a
 * unit height sitting on the ground, and hands out clones. propGroup() returns
 * an EMPTY group immediately and drops the model in when the GLB finishes
 * loading, so the synchronous island builder can scatter props without waiting.
 */
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';

export const PROP_IDS = [
  // core filler props
  'boulder', 'ruined_column', 'shipwreck', 'crystal_cluster', 'broken_statue',
  'cairn', 'dead_tree', 'driftwood', 'amphora_pile', 'coral',
  'mushroom_cluster', 'ice_shard', 'bone_pile', 'mossy_idol',
  // environment props
  'iceberg', 'sand_dune', 'barrel', 'fishing_net', 'brazier', 'stone_well',
  'sarcophagus', 'ruined_arch', 'banner_pole', 'campfire', 'lily_pads', 'tide_pool',
  'buoy', 'ice_floe', 'tomb', 'barrow', 'monster_totem', 'waymarker_stone',
  // biome flora
  'pine_tree', 'pine_snow', 'palm_tree', 'cypress_tree', 'olive_tree',
  'autumn_tree', 'jungle_tree', 'cactus', 'dead_scrub', 'fern_cluster', 'reeds',
];

/* Natural WORLD height per prop (units; captain = 1.8). The old flat 1.6
 * normalization made palms shorter than a man and icebergs knee-high —
 * every id is now sized from the scale-review contact sheets
 * (static/scaletest.html + tools sheets in the session log). */
const PROP_HEIGHTS = {
  // core filler
  boulder: 1.4, ruined_column: 1.3, shipwreck: 3.0, crystal_cluster: 1.6,
  broken_statue: 1.6, cairn: 1.4, dead_tree: 2.8, driftwood: 0.8,
  amphora_pile: 1.0, coral: 1.1, mushroom_cluster: 1.0, ice_shard: 1.6,
  bone_pile: 0.7, mossy_idol: 1.6,
  // environment
  iceberg: 4.5, sand_dune: 1.4, barrel: 0.9, fishing_net: 0.6, brazier: 1.2,
  stone_well: 2.0, sarcophagus: 1.4, ruined_arch: 3.0, banner_pole: 2.6,
  campfire: 0.8, lily_pads: 0.35, tide_pool: 0.5,
  buoy: 1.2, ice_floe: 0.5, tomb: 1.6, barrow: 1.6, monster_totem: 2.2,
  waymarker_stone: 1.6,
  // biome flora
  pine_tree: 3.8, pine_snow: 3.8, palm_tree: 3.6, cypress_tree: 3.6,
  olive_tree: 2.6, autumn_tree: 3.2, jungle_tree: 3.4, cactus: 2.2,
  dead_scrub: 1.0, fern_cluster: 0.9, reeds: 1.5,
};

const loader = new GLTFLoader();
const templates = new Map();   // id → Promise<Group|null> (never rejects)

function ensure(id) {
  let p = templates.get(id);
  if (p) return p;
  p = loader.loadAsync(`/static/assets/props/${id}.glb`)
    .then((gltf) => {
      const s = gltf.scene;
      s.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
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

/* An Object3D placed on the map NOW; the model appears inside it once loaded. */
export function propGroup(id, scale = 1) {
  const g = new THREE.Group();
  ensure(id).then((t) => {
    if (!t) return;
    const c = t.clone(true);
    c.scale.multiplyScalar(scale);
    g.add(c);
  });
  return g;
}

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
  // biome flora
  'pine_tree', 'pine_snow', 'palm_tree', 'cypress_tree', 'olive_tree',
  'autumn_tree', 'jungle_tree', 'cactus', 'dead_scrub', 'fern_cluster', 'reeds',
];

const loader = new GLTFLoader();
const templates = new Map();   // id → Promise<Group|null> (never rejects)

function ensure(id) {
  let p = templates.get(id);
  if (p) return p;
  p = loader.loadAsync(`/static/assets/props/${id}.glb`)
    .then((gltf) => {
      const s = gltf.scene;
      s.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      // normalize to ~1.6 units tall and rest its base on the ground
      const box = new THREE.Box3().setFromObject(s);
      const h = Math.max(0.001, box.max.y - box.min.y);
      s.scale.setScalar(1.6 / h);
      const b2 = new THREE.Box3().setFromObject(s);
      s.position.y -= b2.min.y;
      return s;
    })
    .catch(() => null);   // missing prop → placed as nothing
  templates.set(id, p);
  return p;
}

export function preloadProps(ids = PROP_IDS) {
  for (const id of ids) ensure(id);
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

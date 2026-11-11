/*
 * structures.js — the landmark GLBs (static/assets/structures).
 *
 * The Meshy landmark set ships centred at arbitrary unit scale; glbProp()
 * grounds the feet on y=0 and normalizes to a WORLD height (or length).
 * Templates are cached; instances are cheap clones that share geometry,
 * textures and the finished materials (see modelmat.js for the finish pass).
 *
 * islands.js mounts these; docs/MODELS.md lists what each one is used for.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { finishModel, finishOf } from './modelmat.js';

/* every landmark file on disk */
export const STRUCTURE_IDS = [
  'pharos', 'lighthouse', 'temple', 'temple_ice', 'temple_desert',
  'temple_jungle', 'temple_autumn', 'ice_temple', 'market', 'dock',
  'obelisk', 'tents', 'ship', 'gate_portal',
];

/* Removed in the V2 model triage (see docs/MODELS.md). A legacy call site that
   still asks for one gets an empty group — never a 404, never a console line. */
export const REMOVED_STRUCTURES = new Set(['sand_spire']);

/* Material finish per landmark. White plaster and marble keep a soft sheen,
   timber and canvas stay matte, the ice shrine is glazed. `glow` scales the
   baked emissive map (windows, lamps, inlays) into HDR so it blooms; the
   chroma gate in modelmat.js already drops Meshy's "white = glowing" texels.
   `side: 'double'` marks the sculpts that are not watertight (open-edge audit
   in modeltest.html: window.__audit()); the rest render single-sided. */
const STRUCT_FINISH = {
  pharos:        finishOf('marble', { rough: [0.50, 0.92], side: 'double' }),
  lighthouse:    finishOf('marble', { rough: [0.62, 0.95], glow: 1.6 }),
  temple:        finishOf('marble', { glow: 1.4 }),
  temple_ice:    finishOf('ice', { rough: [0.14, 0.55], glow: 1.2, glowGate: 0.85 }),
  temple_desert: finishOf('stone', { rough: [0.74, 1.0], glow: 1.4 }),
  temple_jungle: finishOf('marble', { rough: [0.40, 0.90], glow: 1.4 }),
  temple_autumn: finishOf('marble', { rough: [0.60, 0.96], glow: 1.4 }),
  ice_temple:    finishOf('ice', { rough: [0.12, 0.60], glow: 0.9, glowGate: 0.8 }),
  market:        finishOf('marble', { rough: [0.66, 0.98], side: 'double' }),
  dock:          finishOf('wood', { side: 'double' }),
  obelisk:       finishOf('stone', { rough: [0.55, 0.95], glow: 2.6, side: 'double' }),
  tents:         finishOf('cloth', { glow: 2.4 }),
  ship:          finishOf('wood', { side: 'double' }),
  gate_portal:   finishOf('stone', { glow: 2.0 }),
};

const _loader = new GLTFLoader();
const _tpls = new Map();           // id → Promise<Scene|null>  (never rejects)
const _none = Promise.resolve(null);

export function structTemplate(id) {
  if (REMOVED_STRUCTURES.has(id)) return _none;
  let p = _tpls.get(id);
  if (p) return p;
  p = _loader.loadAsync(`/static/assets/structures/${id}.glb`)
    .then((gltf) => {
      const s = gltf.scene;
      finishModel(s, STRUCT_FINISH[id] || finishOf('stone'));
      s.userData.box = new THREE.Box3().setFromObject(s);
      return s;
    })
    .catch((err) => {
      console.warn(`structures: failed to load '${id}'`, err);
      return null;
    });
  _tpls.set(id, p);
  return p;
}

/* Every landmark GLB the map still mounts — preloaded by the loading screen.
   The Pharos, shrines, puzzle spire, market, havens and lighthouse are
   procedural now (static/models/landmarks.js); their GLBs stay on disk for
   the contact sheet and the desert battle set (obelisk, tents) only. */
export function preloadStructures() {
  return ['dock', 'ice_temple', 'obelisk', 'tents']
    .map((id) => structTemplate(id));
}

/* Returns a group NOW; the landmark pops in when its GLB lands. opts:
   h = target height, len = target length along x (one of the two), ry yaw. */
export function glbProp(id, { h = null, len = null, ry = 0, onReady = null } = {}) {
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

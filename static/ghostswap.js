/*
 * ghostswap.js — the Ghost Ship's trick on screen. When two captains trade
 * places (events.py _swap), each vessel dissolves into a column of spectral
 * green mist where it lay, is gone for a beat, and condenses again at the
 * other's berth — instead of two hulls gliding through each other.
 *
 *   spectralSwap(scene, root, to)   root: the ship's root Object3D (its
 *                                   current position is where it fades out),
 *                                   to: Vector3 where it fades back in
 *
 * Self-driving (kit.animate on its own sprite): no per-frame hook in
 * scene.js. Costs two additive sprites for ~1.4 s, then removes itself.
 */
import * as THREE from 'three';
import { glowSprite, animate } from './models/kit.js';

const OUT = 0.6, GAP = 0.15, IN = 0.65;      // seconds

export function spectralSwap(scene, root, to) {
  const from = root.position.clone();
  const dest = to.clone();
  const s0 = root.scale.clone();
  const fx = new THREE.Group();
  const mistA = glowSprite(0x6affb8, 7, 0, false);
  const mistB = glowSprite(0x6affb8, 7, 0, false);
  mistA.position.set(from.x, 2.2, from.z);
  mistB.position.set(dest.x, 2.2, dest.z);
  mistA.renderOrder = mistB.renderOrder = 6;
  fx.add(mistA, mistB);
  scene.add(fx);
  let t0 = -1, moved = false;
  const ease = (k) => k * k * (3 - 2 * k);
  animate(fx, (t) => {
    if (t0 < 0) t0 = t;
    const e = t - t0;
    if (e < OUT) {
      // dissolving: the hull thins upward into mist, the mist swells
      const k = ease(e / OUT);
      root.scale.set(s0.x * (1 + k * 0.25), s0.y * (1 - k * 0.95), s0.z * (1 + k * 0.25));
      mistA.material.opacity = 0.8 * Math.sin(k * Math.PI * 0.5);
      mistA.scale.setScalar(5 + k * 5);
      mistA.position.y = 1.6 + k * 2.4;
    } else if (e < OUT + GAP + IN) {
      if (!moved) {
        moved = true;
        root.position.x = dest.x; root.position.z = dest.z;
      }
      const k = ease(Math.max(0, e - OUT - GAP) / IN);
      root.scale.set(s0.x * (1.25 - k * 0.25), s0.y * (0.05 + k * 0.95), s0.z * (1.25 - k * 0.25));
      mistA.material.opacity = 0.8 * (1 - ease(Math.min(1, (e - OUT) / 0.4)));
      mistB.material.opacity = 0.8 * Math.sin(Math.min(1, (e - OUT) / (GAP + IN)) * Math.PI);
      mistB.scale.setScalar(10 - k * 5);
      mistB.position.y = 4 - k * 2.4;
    } else {
      root.scale.copy(s0);
      root.position.x = dest.x; root.position.z = dest.z;
      scene.remove(fx);
      mistA.material.dispose(); mistB.material.dispose();
    }
  });
  return fx;
}

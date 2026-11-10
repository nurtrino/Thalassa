/*
 * gfx/lighting.js — the sun rig.
 *
 * One directional sun with a shadow map that TRAVELS WITH THE VIEW: the
 * shadow frustum is a tight box around whatever the camera is looking at,
 * sized to the camera distance (close shots get crisp shadows, pulled-back
 * shots still cover the frame) and snapped to shadow texels so edges never
 * crawl while the ship glides.
 *
 * Ambient light comes from the baked sky (scene.environment — see sky.js);
 * a faint hemisphere fill gives non-PBR materials something to stand on.
 */
import * as THREE from 'three';
import { sunDirection } from './atmosphere.js';

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();

export function makeLightRig(look, { mapSize = 2048 } = {}) {
  const sunDir = sunDirection(look.sun.az, look.sun.el);
  const sun = new THREE.DirectionalLight(look.sun.color, look.sun.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.35;
  sun.shadow.radius = look.shadow?.radius ?? 2.5;
  if ('intensity' in sun.shadow) sun.shadow.intensity = look.shadow?.strength ?? 0.9;
  sun.position.copy(sunDir).multiplyScalar(400);

  const fill = new THREE.HemisphereLight(look.fill.sky, look.fill.ground, look.fill.intensity);

  const group = new THREE.Group();
  group.name = 'lightRig';
  group.add(sun, sun.target, fill);

  let extent = 0;

  /** keep the shadow box on the view. target: Vector3 looked at; dist: camera distance */
  function follow(target, dist = 60) {
    const want = THREE.MathUtils.clamp(dist * 1.55, 46, 240);
    // re-size only on meaningful change (resizing re-quantizes the texel grid)
    if (Math.abs(want - extent) > extent * 0.12 + 1) {
      extent = want;
      const cam = sun.shadow.camera;
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }
    // snap the anchor to whole shadow texels in light space
    const texel = (extent * 2) / sun.shadow.mapSize.x;
    _dir.copy(sunDir);
    _right.set(0, 1, 0).cross(_dir).normalize();
    _up.copy(_dir).cross(_right).normalize();
    const rx = Math.round(target.dot(_right) / texel) * texel;
    const uy = Math.round(target.dot(_up) / texel) * texel;
    const dz = target.dot(_dir);
    _c.set(0, 0, 0).addScaledVector(_right, rx).addScaledVector(_up, uy).addScaledVector(_dir, dz);
    sun.target.position.copy(_c);
    sun.position.copy(_c).addScaledVector(sunDir, 420);
  }

  return { group, sun, fill, sunDir, follow };
}

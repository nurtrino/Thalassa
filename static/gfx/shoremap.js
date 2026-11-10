/*
 * gfx/shoremap.js — a top-down height map of everything solid in the water.
 *
 * The ocean cannot know where the islands are, so we tell it: every mesh on
 * SHORE_LAYER (island terrain and its underwater shelf, bergs, sea rocks) is
 * rendered from straight above with an orthographic camera into a single
 * half-float texture whose red channel is WORLD HEIGHT. The ocean samples it
 * to get water depth at every fragment — which is what drives the turquoise
 * shallows, the seabed caustics, the surf line, and the calming of the swell
 * as it runs up a beach.
 *
 *   const shore = makeShoreMap(renderer, { res: 2048 });
 *   shore.bake(scene, { x: cx, z: cz, size: 1300 });   // when islands change
 *   ocean.setShoreMap(shore.texture, shore.rect);
 */
import * as THREE from 'three';
import { SHORE_LAYER } from './terrain.js';

const DEEP = -60;

export function makeShoreMap(renderer, { res = 2048 } = {}) {
  const max = renderer.capabilities.maxTextureSize || 2048;
  const size = Math.min(res, max);
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType, format: THREE.RedFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: true, generateMipmaps: false,
  });
  rt.texture.name = 'shoreMap';
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
  cam.rotation.x = -Math.PI / 2;               // look straight down; screen-up = world −Z
  cam.layers.set(SHORE_LAYER);
  const heightMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying float vY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying float vY;
      void main() { gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }`,
    side: THREE.DoubleSide, fog: false,
  });
  heightMat.onBeforeCompile = () => {};
  const rect = { x: 0, z: 0, size: 1 };
  const _clear = new THREE.Color();

  function bake(scene, { x, z, size: span }) {
    cam.left = -span / 2; cam.right = span / 2;
    cam.top = span / 2; cam.bottom = -span / 2;
    cam.position.set(x, 300, z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const prev = {
      target: renderer.getRenderTarget(), override: scene.overrideMaterial,
      bg: scene.background, env: scene.environment, fog: scene.fog,
      alpha: renderer.getClearAlpha(), shadow: renderer.shadowMap.autoUpdate,
    };
    renderer.getClearColor(_clear);
    scene.overrideMaterial = heightMat;
    scene.background = null; scene.environment = null; scene.fog = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(new THREE.Color(DEEP, 0, 0), 1);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev.target);
    renderer.setClearColor(_clear, prev.alpha);
    scene.overrideMaterial = prev.override;
    scene.background = prev.bg; scene.environment = prev.env; scene.fog = prev.fog;
    renderer.shadowMap.autoUpdate = prev.shadow;

    // uv = (xz − rect.xy) · rect.zw  with v flipped (screen-up is −Z)
    rect.x = x - span / 2;
    rect.z = z + span / 2;
    rect.size = span;
  }

  return {
    texture: rt.texture, rect, bake,
    /** uShoreRect for the ocean: minX, maxZ, 1/size, −1/size */
    rectVec4(out = new THREE.Vector4()) {
      return out.set(rect.x, rect.z, 1 / rect.size, -1 / rect.size);
    },
    dispose() { rt.dispose(); heightMat.dispose(); },
  };
}

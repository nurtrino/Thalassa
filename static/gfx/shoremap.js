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

  /* A soft blur over the baked heights. Raw, a sheer solid (an iceberg, a
     sea stack, a quay) jumps from its top to the deep clear value across a
     single texel, so the ocean's turquoise rim and surf line traced the texel
     grid — a stepped, aliased edge. Heights are clamped to the range the
     ocean actually reads (deep below ~−20 looks the same as −60; land above
     +2 is just land) and blurred over a few texels, so every iso-depth line
     the ocean draws is smooth. Two separable 9-tap passes, once per bake. */
  const rtB = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType, format: THREE.RedFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, generateMipmaps: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tMap; uniform vec2 uDir;
      varying vec2 vUv;
      float h(vec2 o) { return clamp(texture2D(tMap, vUv + o).r, -20.0, 2.0); }
      void main() {
        float s = h(vec2(0.0)) * 0.2042;
        s += (h(uDir * 1.0) + h(-uDir * 1.0)) * 0.1802;
        s += (h(uDir * 2.0) + h(-uDir * 2.0)) * 0.1238;
        s += (h(uDir * 3.0) + h(-uDir * 3.0)) * 0.0663;
        s += (h(uDir * 4.0) + h(-uDir * 4.0)) * 0.0276;
        gl_FragColor = vec4(s, 0.0, 0.0, 1.0);
      }`,
    depthTest: false, depthWrite: false, fog: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function blur() {
    blurMat.uniforms.tMap.value = rt.texture;
    blurMat.uniforms.uDir.value.set(1 / size, 0);
    renderer.setRenderTarget(rtB);
    renderer.render(quadScene, quadCam);
    blurMat.uniforms.tMap.value = rtB.texture;
    blurMat.uniforms.uDir.value.set(0, 1 / size);
    renderer.setRenderTarget(rt);
    renderer.render(quadScene, quadCam);
  }
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
    blur();
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
    dispose() { rt.dispose(); rtB.dispose(); heightMat.dispose(); blurMat.dispose(); quad.geometry.dispose(); },
  };
}

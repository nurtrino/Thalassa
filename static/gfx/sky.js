/*
 * gfx/sky.js — the sky dome and the image-based light baked from it.
 *
 * makeSky() is a camera-centred dome that draws the shared atmosphere model
 * (gradient, sun disc + glow, drifting clouds, stars, aurora) in linear HDR —
 * the sun disc is deliberately far above 1.0 so the bloom pass catches it.
 *
 * bakeEnvironment() renders that same sky (minus the sun disc, which the
 * directional light already represents) into a prefiltered cube map. Set as
 * scene.environment it gives every PBR surface sky-coloured ambient light
 * and reflections that match the stage's mood exactly.
 */
import * as THREE from 'three';
import { ATMO, SKY_UNIFORMS_GLSL, SKY_FUNC, skyUniforms } from './atmosphere.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;            // pinned to the far plane, never clips
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
${SKY_UNIFORMS_GLSL}
uniform float uOctaves;
varying vec3 vDir;
${SKY_FUNC}
void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyColor(d, int(uOctaves));
  gl_FragColor = vec4(c, 1.0);
}`;

export function makeSky({ octaves = 5 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...skyUniforms(), uOctaves: { value: octaves } },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.name = 'sky';
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/* ── environment bake ────────────────────────────────────────────────────── */
let _pmrem = null, _envScene = null;

/** Bake the CURRENT atmosphere (call after applyLook) → PMREM texture. */
export function bakeEnvironment(renderer) {
  if (!_pmrem) {
    _pmrem = new THREE.PMREMGenerator(renderer);
    _envScene = new THREE.Scene();
    const dome = makeSky({ octaves: 3 });
    dome.scale.setScalar(50);
    dome.updateMatrix();
    _envScene.add(dome);
  }
  const fx = ATMO.uSkyFx.value;
  const prevFlag = fx.z;
  fx.z = 1;                                  // no sun disc in the ambient bake
  const rt = _pmrem.fromScene(_envScene, 0, 0.1, 200);
  fx.z = prevFlag;
  return rt;                                  // caller owns it: rt.texture, rt.dispose()
}

/*
 * gfx/pipeline.js — the HDR frame: scene → bloom → sun shafts → film grade.
 *
 * The world renders in linear HDR into a multisampled half-float target, so
 * the sun, beacons, braziers and spell bolts can be genuinely brighter than
 * white. Bloom spreads that energy; the final pass adds light shafts around
 * the sun, tone-maps (ACES), then grades in display space: contrast,
 * saturation, split-toned shadows/highlights, vignette, and a breath of
 * dither so sky gradients never band.
 *
 *   const pipe = createPipeline(renderer);
 *   pipe.setSize(w, h);
 *   pipe.setLook(look);                 // per stage: exposure, bloom, grade
 *   pipe.render(scene, camera, dt);     // every frame
 *
 * Quality tiers ('low' | 'medium' | 'high') trade MSAA, bloom and shafts for
 * frame time; an adaptive governor steps down automatically if a device
 * can't hold its frame rate (and remembers the choice).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ATMO } from './atmosphere.js';

const FinalShader = {
  name: 'ThalassaFinal',
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.08 },
    uShadowTint: { value: new THREE.Color(0.96, 0.99, 1.04) },
    uHighTint: { value: new THREE.Color(1.03, 1.0, 0.96) },
    uVignette: { value: new THREE.Vector2(0.28, 0.72) },   // strength, start radius
    uSunScreen: { value: new THREE.Vector3(0.5, 0.5, 0) },  // uv.xy, visibility
    uShafts: { value: 0.0 },                                // strength (0 = off)
    uShaftColor: { value: new THREE.Color(1, 0.92, 0.75) },
    uAspect: { value: 1.0 },
    uTime: { value: 0 },
    uFade: { value: 0 },                                    // 0..1 dip to ink (transitions)
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure, uContrast, uSaturation, uShafts, uAspect, uTime, uFade;
    uniform vec3 uShadowTint, uHighTint, uShaftColor;
    uniform vec2 uVignette;
    uniform vec3 uSunScreen;
    varying vec2 vUv;

    // ACES filmic (Stephen Hill's fit) — same curve three ships
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 color) {
      const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color = inM * color;
      color = RRTAndODTFit(color);
      color = outM * color;
      return clamp(color, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      #ifdef SHAFTS
      if (uShafts > 0.001 && uSunScreen.z > 0.001) {
        // light shafts: march toward the sun gathering only very bright sky
        vec2 delta = (uSunScreen.xy - vUv);
        float dist = length(delta * vec2(uAspect, 1.0));
        delta *= 0.92 / float(SHAFT_TAPS);
        vec2 uv = vUv;
        float jitter = hash(gl_FragCoord.xy + uTime);
        uv += delta * jitter;
        float acc = 0.0, w = 1.0;
        for (int i = 0; i < SHAFT_TAPS; i++) {
          uv += delta;
          vec3 s = texture2D(tDiffuse, clamp(uv, 0.001, 0.999)).rgb;
          float l = max(max(s.r, s.g), s.b);
          acc += smoothstep(1.6, 5.0, l) * w;
          w *= 0.955;
        }
        acc /= float(SHAFT_TAPS);
        float falloff = exp(-dist * 1.6);
        c += uShaftColor * acc * uShafts * uSunScreen.z * falloff * 3.2;
      }
      #endif

      c = aces(c * uExposure / 0.6);
      // grade in display-linear space
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c *= mix(uShadowTint, uHighTint, smoothstep(0.0, 0.7, l));
      c = (c - 0.5) * uContrast + 0.5;
      c = toSRGB(clamp(c, 0.0, 1.0));
      // vignette (in display space so it reads as lens, not exposure)
      vec2 q = (vUv - 0.5) * vec2(min(uAspect, 1.9) / 1.6, 1.0);
      float v = smoothstep(uVignette.y, 1.25, length(q) * 1.9);
      c *= 1.0 - v * uVignette.x;
      // dither: breaks 8-bit banding in sky gradients and fog
      c += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
      c = mix(c, vec3(0.024, 0.035, 0.05), uFade);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

const TIERS = {
  low:    { samples: 0, bloom: false, shafts: 0,  maxPixelRatio: 1.0 },
  medium: { samples: 2, bloom: true,  shafts: 0,  maxPixelRatio: 1.5 },
  high:   { samples: 4, bloom: true,  shafts: 20, maxPixelRatio: 2.0 },
};
const ORDER = ['low', 'medium', 'high'];

function softwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|llvmpipe|software/i.test(name);
  } catch { return false; }
}

export function createPipeline(renderer, { quality = null } = {}) {
  const isSoft = softwareRenderer(renderer);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let saved = null;
  try { saved = localStorage.getItem('thalassa_gfx'); } catch { /* private mode */ }
  // ?gfx=low|medium|high pins a tier (testing, or a player's bookmark)
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(location.search).get('gfx'); } catch { /* no location */ }
  if (!ORDER.includes(fromUrl)) fromUrl = null;
  let tierName = quality || fromUrl
    || (ORDER.includes(saved) ? saved : (coarse || isSoft ? 'medium' : 'high'));
  let userLocked = !!(quality || fromUrl);

  renderer.toneMapping = THREE.NoToneMapping;       // the final pass tone-maps
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // …and encodes sRGB

  const hdrOK = renderer.extensions.has('EXT_color_buffer_float')
             || renderer.extensions.has('EXT_color_buffer_half_float');

  let composer = null, renderPass = null, bloomPass = null, finalPass = null;
  let width = 2, height = 2;
  const look = { exposure: 1, bloom: { strength: 0.35, radius: 0.6, threshold: 1.0 }, shafts: 0 };

  function build() {
    if (composer) { composer.dispose(); bloomPass?.dispose(); finalPass?.dispose?.(); }
    const tier = TIERS[tierName];
    const pr = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio);
    renderer.setPixelRatio(pr);
    const rt = new THREE.WebGLRenderTarget(2, 2, {
      type: hdrOK ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: tier.samples, depthBuffer: true,
    });
    composer = new EffectComposer(renderer, rt);
    renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    composer.addPass(renderPass);
    bloomPass = null;
    if (tier.bloom) {
      bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.6, 1.0);
      composer.addPass(bloomPass);
    }
    const shader = { ...FinalShader, uniforms: THREE.UniformsUtils.clone(FinalShader.uniforms) };
    if (tier.shafts > 0) shader.defines = { SHAFTS: 1, SHAFT_TAPS: tier.shafts };
    finalPass = new ShaderPass(shader);
    composer.addPass(finalPass);
    composer.setPixelRatio(pr);
    renderer.setSize(width, height);
    composer.setSize(width, height);
    finalPass.uniforms.uAspect.value = width / height;
    applyLookUniforms();
  }

  function applyLookUniforms() {
    if (!finalPass) return;
    const u = finalPass.uniforms;
    const g = look.grade || {};
    u.uExposure.value = look.exposure ?? 1;
    u.uContrast.value = g.contrast ?? 1.06;
    u.uSaturation.value = g.saturation ?? 1.08;
    u.uShadowTint.value.set(g.shadows ?? 0xf5fcff);
    u.uHighTint.value.set(g.highlights ?? 0xfffdf5);
    u.uVignette.value.set(g.vignette ?? 0.28, 0.72);
    u.uShafts.value = look.shafts ?? 0;
    u.uShaftColor.value.set(look.shaftColor ?? 0xffe9bf);
    if (bloomPass) {
      bloomPass.strength = look.bloom?.strength ?? 0.35;
      bloomPass.radius = look.bloom?.radius ?? 0.6;
      bloomPass.threshold = look.bloom?.threshold ?? 1.0;
    }
  }

  build();

  /* ── adaptive governor ─────────────────────────────────────────────── */
  let acc = 0, frames = 0, slowWindows = 0, settled = 0;
  function govern(dt) {
    if (userLocked || isSoft) return;
    acc += dt; frames++;
    if (acc < 2.5) return;
    const fps = frames / acc;
    acc = 0; frames = 0;
    if (settled < 2) { settled++; return; }           // ignore load-in hitches
    if (fps < 32) slowWindows++; else slowWindows = Math.max(0, slowWindows - 1);
    if (slowWindows >= 2) {
      const i = ORDER.indexOf(tierName);
      if (i > 0) {
        tierName = ORDER[i - 1];
        try { localStorage.setItem('thalassa_gfx', tierName); } catch { /* ignore */ }
        build();
      }
      slowWindows = 0; settled = 0;
    }
  }

  const _sun = new THREE.Vector3();
  let time = 0;

  return {
    get quality() { return tierName; },
    software: isSoft,
    setQuality(q) {
      if (!TIERS[q] || q === tierName) return;
      tierName = q; userLocked = true;
      try { localStorage.setItem('thalassa_gfx', q); } catch { /* ignore */ }
      build();
    },
    setSize(w, h) {
      width = Math.max(2, w); height = Math.max(2, h);
      renderer.setSize(width, height);
      composer.setSize(width, height);
      finalPass.uniforms.uAspect.value = width / height;
    },
    /** per-stage look: {exposure, bloom:{strength,radius,threshold}, shafts, shaftColor, grade:{…}} */
    setLook(l) {
      Object.assign(look, l);
      applyLookUniforms();
    },
    /** 0..1 dip to ink — for stage transitions without a DOM curtain */
    setFade(k) { finalPass.uniforms.uFade.value = k; },
    render(scene, camera, dt = 0.016) {
      time += dt;
      renderPass.scene = scene;
      renderPass.camera = camera;
      const u = finalPass.uniforms;
      u.uTime.value = time;
      // where is the sun on screen? (drives the light shafts)
      _sun.copy(camera.position).addScaledVector(ATMO.uSunDir.value, 1000).project(camera);
      const onScreen = _sun.z < 1
        ? Math.max(0, 1 - Math.max(Math.abs(_sun.x), Math.abs(_sun.y)) * 0.72) : 0;
      u.uSunScreen.value.set(_sun.x * 0.5 + 0.5, _sun.y * 0.5 + 0.5, Math.min(1, onScreen * 1.6));
      composer.render(dt);
      govern(dt);
    },
    dispose() { composer.dispose(); },
  };
}

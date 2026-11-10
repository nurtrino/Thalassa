/*
 * gfx/atmosphere.js — the shared sky/sun/fog model every surface agrees on.
 *
 * One set of uniform OBJECTS (shared by reference) describes the active
 * stage's atmosphere: where the sun is, what colour the sky and haze are,
 * how the clouds drift. The sky dome, the ocean's reflections and the fog on
 * every material all read the same values, so the horizon is seamless and
 * the haze glows toward the sun everywhere at once.
 *
 * Fog: three's stock fog is a flat colour by view depth. installAtmosphere()
 * patches the fog shader chunks ONCE so that every fogged material — terrain,
 * GLB models, sprites, particles — gets aerial perspective instead:
 *   · radial distance (no flat "wall" that swings as the camera turns)
 *   · a soft exponential curve between scene.fog.near and .far
 *   · height falloff — peaks and towers rise out of the haze
 *   · in-scatter — the haze warms and brightens toward the sun
 * scene.fog (THREE.Fog) stays the control surface: near/far/colour still
 * work exactly as before, and `fog: false` materials stay fog-free.
 */
import * as THREE from 'three';

/* ── shared uniforms ─────────────────────────────────────────────────────── */
export const ATMO = {
  // sky model (world space)
  uSunDir:      { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
  uSunColor:    { value: new THREE.Color(1, 0.95, 0.85) },   // HDR sun radiance tint
  uSkyZenith:   { value: new THREE.Color(0x2c6fd0) },
  uSkyHorizon:  { value: new THREE.Color(0xcfe9f3) },
  uSkyGround:   { value: new THREE.Color(0x6f8794) },
  // x: horizon falloff exponent, y: sun glow strength, z: sun disc intensity, w: time
  uSkyParams:   { value: new THREE.Vector4(0.42, 0.6, 28, 0) },
  // x: cover 0..1, y: scale, z: speed, w: softness
  uCloud:       { value: new THREE.Vector4(0.42, 1.0, 0.012, 0.28) },
  uCloudLit:    { value: new THREE.Color(1, 1, 1) },
  uCloudShade:  { value: new THREE.Color(0.55, 0.62, 0.72) },
  // x: stars, y: aurora, z: env-bake flag (1 = no sun disc), w: unused
  uSkyFx:       { value: new THREE.Vector4(0, 0, 0, 0) },
  // fog model
  uFogSunColor: { value: new THREE.Color(1, 0.9, 0.7) },     // haze colour looking into the sun
  // x: sun in-scatter strength, y: height falloff (1/units), z: height base, w: height amount 0..1
  uFogParams:   { value: new THREE.Vector4(0.6, 0.012, 6, 0.85) },
  // per-frame camera-dependent values (set by updateAtmosphere)
  uAtmoSunView: { value: new THREE.Vector4(0, 1, 0, 0) },    // xyz sun dir in VIEW space
  uAtmoCamY:    { value: new THREE.Vector4(0, 1, 0, 0) },    // row 1 of camera.matrixWorld
};

const FOG_UNIFORM_KEYS = ['uFogSunColor', 'uFogParams', 'uAtmoSunView', 'uAtmoCamY'];

/* inject the shared fog uniforms into any shader about to compile */
export function bindAtmosphere(shader) {
  for (const k of FOG_UNIFORM_KEYS) shader.uniforms[k] = ATMO[k];
}

/* ── GLSL: fog ───────────────────────────────────────────────────────────── */
export const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif`;

export const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif`;

/* thalassaFog(color, viewPos) — shared by the chunk patch and custom shaders */
export const FOG_FUNC = /* glsl */`
uniform vec3 uFogSunColor;
uniform vec4 uFogParams;
uniform vec4 uAtmoSunView;
uniform vec4 uAtmoCamY;
vec3 thalassaFogColor(vec3 base, vec3 viewDir) {
  float s = max(dot(viewDir, uAtmoSunView.xyz), 0.0);
  float glow = (pow(s, 5.0) * 0.55 + pow(s, 28.0) * 0.45) * uFogParams.x;
  return mix(base, uFogSunColor, clamp(glow, 0.0, 1.0));
}
float thalassaFogAmount(vec3 viewPos, float fNear, float fFar) {
  float dist = length(viewPos);
  float t = clamp((dist - fNear) / max(fFar - fNear, 0.001), 0.0, 1.0);
  float f = (1.0 - exp(-3.4 * t * sqrt(t))) / 0.9666;
  float worldY = dot(uAtmoCamY.xyz, viewPos) + uAtmoCamY.w;
  float hAtt = exp(-max(worldY - uFogParams.z, 0.0) * uFogParams.y);
  return clamp(f * mix(1.0, hAtt, uFogParams.w), 0.0, 1.0);
}`;

export const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${FOG_FUNC}
#endif`;

export const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = thalassaFogAmount( vFogView, fogNear, fogFar );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, thalassaFogColor( fogColor, normalize( vFogView ) ), fogFactor );
#endif`;

let _installed = false;
export function installAtmosphere() {
  if (_installed) return;
  _installed = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  // every material's compile hook hands it the shared uniform objects. A
  // material that sets its own onBeforeCompile must call bindAtmosphere().
  THREE.Material.prototype.onBeforeCompile = function (shader) { bindAtmosphere(shader); };
}

/* ── GLSL: sky ───────────────────────────────────────────────────────────── */
export const SKY_UNIFORMS_GLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec4 uSkyParams;
uniform vec4 uCloud;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec4 uSkyFx;
uniform vec3 uFogSunColorW;
uniform vec4 uFogParamsW;`;

export const SKY_FUNC = /* glsl */`
float skyHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float skyNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1, 0)), u.x),
             mix(skyHash(i + vec2(0, 1)), skyHash(i + vec2(1, 1)), u.x), u.y);
}
float skyFbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * skyNoise(p);
    p = r * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
/* the clear-air gradient + sun glow (no disc, no clouds) */
vec3 skyAir(vec3 d) {
  float up = max(d.y, 0.0);
  float k = pow(1.0 - up, 1.0 / max(uSkyParams.x, 0.05));
  float s = max(dot(d, uSunDir), 0.0);
  // the horizon band matches the fog exactly so land dissolves into sky
  float glowF = (pow(s, 5.0) * 0.55 + pow(s, 28.0) * 0.45) * uFogParamsW.x;
  vec3 horizon = mix(uSkyHorizon, uFogSunColorW, clamp(glowF, 0.0, 1.0));
  vec3 c = mix(uSkyZenith, horizon, k);
  // forward scattering around the sun, higher up than the haze reaches
  c += uSunColor * (pow(s, 12.0) * 0.10 + pow(s, 180.0) * 0.55) * uSkyParams.y;
  if (d.y < 0.0) {
    float g = clamp(-d.y * 5.0, 0.0, 1.0);
    c = mix(horizon, uSkyGround, g);
  }
  return c;
}
/* clouds: one drifting fbm deck, lit toward the sun, thinning at the horizon */
vec4 skyClouds(vec3 d, int oct) {
  if (uCloud.x <= 0.001 || d.y <= 0.005) return vec4(0.0);
  vec2 uv = d.xz / (d.y + 0.14) * uCloud.y * 1.35 + vec2(uSkyParams.w * uCloud.z, uSkyParams.w * uCloud.z * 0.37);
  float n = skyFbm(uv, oct);
  float lo = 1.0 - uCloud.x;
  float dens = smoothstep(lo - uCloud.w * 0.5, lo + uCloud.w * 0.5, n * 1.25);
  if (dens <= 0.001) return vec4(0.0);
  // cheap self-shadow: is the deck thicker toward the sun?
  float n2 = skyFbm(uv + normalize(uSunDir.xz + 1e-4) * 0.22, oct > 2 ? oct - 1 : oct);
  float lit = clamp(0.62 - (n2 - n) * 3.2, 0.0, 1.0);
  float s = max(dot(d, uSunDir), 0.0);
  vec3 col = mix(uCloudShade, uCloudLit, lit);
  col += uSunColor * pow(s, 10.0) * 0.55 * (1.0 - dens * 0.6);   // silver lining
  // toward the horizon the deck foreshortens into an even white veil — thin
  // it out there so the horizon keeps the haze's own colour
  float horizonFade = smoothstep(0.03, 0.34, d.y);
  col = mix(skyAir(vec3(d.x, 0.0, d.z)), col, horizonFade * 0.85 + 0.15);
  return vec4(col, dens * horizonFade * horizonFade);
}
vec3 skyStars(vec3 d) {
  if (uSkyFx.x <= 0.001 || d.y < 0.0) return vec3(0.0);
  vec2 uv = d.xz / (d.y + 0.35) * 46.0;
  vec2 id = floor(uv), f = fract(uv) - 0.5;
  float h = skyHash(id);
  float star = step(0.93, h) * smoothstep(0.24, 0.0, length(f + (vec2(skyHash(id + 3.1), skyHash(id + 7.7)) - 0.5) * 0.5));
  float tw = 0.7 + 0.3 * sin(uSkyParams.w * (1.5 + h * 3.0) + h * 40.0);
  return vec3(0.85, 0.9, 1.0) * star * tw * uSkyFx.x * smoothstep(0.0, 0.25, d.y) * 2.2;
}
vec3 skyAurora(vec3 d) {
  if (uSkyFx.y <= 0.001 || d.y < 0.02) return vec3(0.0);
  vec2 uv = d.xz / (d.y + 0.4);
  float t = uSkyParams.w * 0.05;
  float band = skyFbm(vec2(uv.x * 1.6 + t, uv.y * 0.35 - t * 0.6), 3);
  float curtain = pow(smoothstep(0.42, 0.78, band), 1.6);
  float rays = 0.55 + 0.45 * skyNoise(vec2(uv.x * 22.0 + t * 6.0, uv.y * 2.0));
  float mask = smoothstep(0.05, 0.3, d.y) * smoothstep(0.95, 0.45, d.y);
  vec3 c = mix(vec3(0.15, 1.0, 0.55), vec3(0.45, 0.35, 1.0), smoothstep(0.2, 0.75, d.y));
  return c * curtain * rays * mask * uSkyFx.y;
}
/* the full sky seen along direction d (normalized, world space) */
vec3 skyColor(vec3 d, int oct) {
  vec3 c = skyAir(d);
  c += skyStars(d) + skyAurora(d);
  if (uSkyFx.z < 0.5) {
    float s = dot(d, uSunDir);
    float disc = smoothstep(0.99962, 0.99982, s);
    c += uSunColor * disc * uSkyParams.z;
  }
  vec4 cl = skyClouds(d, oct);
  c = mix(c, cl.rgb, cl.a);
  return c;
}`;

/* uniforms a custom ShaderMaterial needs to call skyColor() */
export function skyUniforms() {
  return {
    uSunDir: ATMO.uSunDir, uSunColor: ATMO.uSunColor,
    uSkyZenith: ATMO.uSkyZenith, uSkyHorizon: ATMO.uSkyHorizon, uSkyGround: ATMO.uSkyGround,
    uSkyParams: ATMO.uSkyParams, uCloud: ATMO.uCloud,
    uCloudLit: ATMO.uCloudLit, uCloudShade: ATMO.uCloudShade, uSkyFx: ATMO.uSkyFx,
    uFogSunColorW: ATMO.uFogSunColor, uFogParamsW: ATMO.uFogParams,
  };
}

/* ── applying a look ─────────────────────────────────────────────────────── */
const _c = new THREE.Color();

export function sunDirection(az, el, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  return out.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize();
}

/** copy a stage look (see looks.js) into the shared uniforms */
export function applyLook(look) {
  sunDirection(look.sun.az, look.sun.el, ATMO.uSunDir.value);
  ATMO.uSunColor.value.set(look.sun.color).multiplyScalar(look.sky.sunGain ?? 1);
  ATMO.uSkyZenith.value.set(look.sky.zenith);
  ATMO.uSkyHorizon.value.set(look.fog.color);
  ATMO.uSkyGround.value.set(look.sky.ground);
  ATMO.uSkyParams.value.set(look.sky.curve ?? 0.42, look.sky.glow ?? 0.6, look.sky.disc ?? 28,
                            ATMO.uSkyParams.value.w);
  const cl = look.sky.clouds || {};
  ATMO.uCloud.value.set(cl.cover ?? 0, cl.scale ?? 1, cl.speed ?? 0.012, cl.soft ?? 0.28);
  ATMO.uCloudLit.value.set(cl.lit ?? 0xffffff);
  ATMO.uCloudShade.value.set(cl.shade ?? 0x8c9db3);
  ATMO.uSkyFx.value.set(look.sky.stars ?? 0, look.sky.aurora ?? 0, 0, 0);
  ATMO.uFogSunColor.value.set(look.fog.sunColor ?? look.sun.color);
  ATMO.uFogParams.value.set(look.fog.sunGlow ?? 0.6, look.fog.heightFalloff ?? 0.012,
                            look.fog.heightBase ?? 6, look.fog.heightAmount ?? 0.85);
}

/** per-frame: time + camera-dependent fog terms. Call right before rendering. */
const _v = new THREE.Vector3();
export function updateAtmosphere(camera, t) {
  ATMO.uSkyParams.value.w = t;
  camera.updateMatrixWorld();
  _v.copy(ATMO.uSunDir.value).transformDirection(camera.matrixWorldInverse);
  ATMO.uAtmoSunView.value.set(_v.x, _v.y, _v.z, 0);
  const e = camera.matrixWorld.elements;
  ATMO.uAtmoCamY.value.set(e[1], e[5], e[9], e[13]);
}

export { _c as scratchColor };

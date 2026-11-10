/*
 * gfx/ocean.js — the sea.
 *
 * A camera-following polar grid (dense under the ship, sparse at the horizon)
 * displaced by a sum of Gerstner swells. The fragment shader builds the
 * surface from the same swells plus two scrolling detail-normal layers, then
 * shades it like water:
 *   · fresnel reflection of the REAL sky (the shared atmosphere model, clouds
 *     and all) and a sun glitter path broken up by the detail normals
 *   · depth-tinted body colour — a baked top-down "shore map" of the terrain
 *     tells every fragment how deep the water is, so shallows turn clear and
 *     turquoise over the sand, with caustics dancing on the seabed
 *   · foam where swells break on the beach, and lace on the wave crests
 *   · light scattering through the crests toward the sun
 *   · the same aerial-perspective fog as the land, so sea meets sky cleanly
 *
 *   const sea = makeOcean(theme, look);
 *   sea.update(t, focusVec3, scene.fog);        // each frame
 *   sea.setShoreMap(texture, {x, z, size});     // from shoremap.js
 */
import * as THREE from 'three';
import { ATMO, SKY_UNIFORMS_GLSL, SKY_FUNC, FOG_FUNC, skyUniforms } from './atmosphere.js';

export const WATER_Y = -0.3;

/* five swells: [dirX, dirZ, wavelength, amplitude, steepness, speedScale] */
const WAVES = [
  [0.86, 0.51, 41.0, 0.200, 0.55, 0.55],
  [0.42, 0.91, 26.0, 0.135, 0.50, 0.60],
  [0.98, -0.20, 15.5, 0.080, 0.45, 0.70],
  [-0.31, 0.95, 9.2, 0.045, 0.40, 0.80],
  [0.71, -0.70, 5.6, 0.026, 0.35, 0.90],
];

/* JS mirror of the vertex displacement — lets boats ride the real surface */
export function waveHeight(x, z, t, chop = 1) {
  let y = 0;
  for (const [dx, dz, L, a, , sp] of WAVES) {
    const k = (Math.PI * 2) / L;
    const w = Math.sqrt(9.8 * k) * sp * 0.55;
    y += a * chop * Math.sin(k * (dx * x + dz * z) - w * t);
  }
  return WATER_Y + y;
}

/* ── tileable detail normal map (rgb = normal, a = height) ───────────────── */
let _detailTex = null;
function detailNormalTexture() {
  if (_detailTex) return _detailTex;
  const S = 256;
  const h = new Float32Array(S * S);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // periodic value noise, summed over octaves
  for (let o = 0; o < 5; o++) {
    const freq = 4 << o, amp = 1 / (1 << o);
    const lattice = new Float32Array(freq * freq);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    for (let y = 0; y < S; y++) {
      const fy = (y / S) * freq, iy = Math.floor(fy), ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * freq, ix = Math.floor(fx), tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const a = lattice[(iy % freq) * freq + (ix % freq)];
        const b = lattice[(iy % freq) * freq + ((ix + 1) % freq)];
        const c = lattice[((iy + 1) % freq) * freq + (ix % freq)];
        const d = lattice[((iy + 1) % freq) * freq + ((ix + 1) % freq)];
        h[y * S + x] += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amp;
      }
    }
  }
  const data = new Uint8Array(S * S * 4);
  const at = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 6.0;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 6.0;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[i + 3] = Math.round(Math.min(1, at(x, y) / 1.94) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _detailTex = tex;
  return tex;
}

/* 1×1 "everything is deep" stand-in until a shore map is baked */
let _noShore = null;
function noShoreTexture() {
  if (_noShore) return _noShore;
  _noShore = new THREE.DataTexture(new Float32Array([-60, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  _noShore.needsUpdate = true;
  return _noShore;
}

/* ── geometry: polar grid, exponential rings ─────────────────────────────── */
function polarGrid(rings = 84, segs = 144, r0 = 1.4, rMax = 2600) {
  const pos = new Float32Array((rings * segs + 1) * 3);
  const idx = [];
  const g = Math.pow(rMax / r0, 1 / (rings - 1));
  let p = 3;                                    // vertex 0 = centre
  for (let r = 0; r < rings; r++) {
    const rad = r0 * Math.pow(g, r);
    // stagger alternate rings half a step so triangles don't line up in spokes
    const off = (r % 2) * 0.5;
    for (let s = 0; s < segs; s++) {
      const a = ((s + off) / segs) * Math.PI * 2;
      pos[p++] = Math.cos(a) * rad; pos[p++] = 0; pos[p++] = Math.sin(a) * rad;
    }
  }
  const v = (r, s) => 1 + r * segs + ((s + segs) % segs);
  for (let s = 0; s < segs; s++) idx.push(0, v(0, s + 1), v(0, s));
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const a = v(r, s), b = v(r, s + 1), c = v(r + 1, s), d = v(r + 1, s + 1);
      if (r % 2 === 0) idx.push(a, b, c, b, d, c);
      else idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

const WAVE_GLSL = WAVES.map((w, i) =>
  `const vec4 W${i}A = vec4(${w[0].toFixed(4)}, ${w[1].toFixed(4)}, ${(Math.PI * 2 / w[2]).toFixed(5)}, ${w[3].toFixed(4)});
   const vec2 W${i}B = vec2(${w[4].toFixed(3)}, ${(Math.sqrt(9.8 * Math.PI * 2 / w[2]) * w[5] * 0.55).toFixed(5)});`).join('\n');

const WAVE_SUM = (fn) => WAVES.map((_, i) => `${fn}(W${i}A, W${i}B, xz, amp, p, n);`).join('\n    ');

const COMMON = /* glsl */`
uniform float uTime;
uniform float uChop;
uniform float uWaterY;
uniform sampler2D uShoreTex;
uniform vec4 uShoreRect;     // minX, minZ, 1/sizeX, 1/sizeZ
${WAVE_GLSL}
void gerstner(vec4 A, vec2 B, vec2 xz, float amp, inout vec3 p, inout vec3 n) {
  float ph = A.z * dot(A.xy, xz) - B.y * uTime;
  float a = A.w * amp;
  float s = sin(ph), c = cos(ph);
  p.xz += B.x * a * A.xy * c;
  p.y += a * s;
  n.xz -= A.xy * (A.z * a * c);
  n.y -= B.x * A.z * a * s;
}
float shoreHeight(vec2 xz) {
  vec2 uv = (xz - uShoreRect.xy) * uShoreRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -60.0;
  return texture2D(uShoreTex, uv).r;
}`;

const VERT = /* glsl */`
${COMMON}
varying vec3 vWorld;
varying vec2 vBaseXZ;
varying vec3 vView;
varying float vCrest;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 xz = wp.xz;
  vBaseXZ = xz;
  float dist = length(xz - cameraPosition.xz);
  float depth = uWaterY - shoreHeight(xz);
  // swells die away at the horizon (no shimmering) and in the shallows
  float amp = uChop * (1.0 - smoothstep(220.0, 900.0, dist)) * smoothstep(0.0, 3.0, depth + 0.6);
  vec3 p = vec3(xz.x, uWaterY, xz.y);
  vec3 n = vec3(0.0, 1.0, 0.0);
  ${WAVE_SUM('gerstner')}
  vCrest = (p.y - uWaterY) / max(0.48 * max(uChop, 0.05), 0.001);
  vWorld = p;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
precision highp float;
${COMMON}
${SKY_UNIFORMS_GLSL}
uniform sampler2D uDetail;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSeabed;
uniform vec3 uScatter;
uniform vec3 uLight;          // how bright the stage's light makes the water body
uniform vec3 uSunSpec;        // sun radiance for the glitter
uniform vec4 uOpts;           // x: sparkle, y: foam amount, z: clarity, w: reflectivity
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vWorld;
varying vec2 vBaseXZ;
varying vec3 vView;
varying float vCrest;
${SKY_FUNC}
${FOG_FUNC}
void main() {
  vec2 xz = vBaseXZ;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float depth = uWaterY - shoreHeight(vWorld.xz);
  float shallow = smoothstep(0.0, 3.0, depth + 0.6);

  // swell normal, recomputed per fragment
  float amp = uChop * (1.0 - smoothstep(220.0, 900.0, dist)) * shallow;
  vec3 p = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  ${WAVE_SUM('gerstner')}

  // detail ripples: three layers at incommensurate scales and headings
  float t = uTime;
  vec4 d1 = texture2D(uDetail, xz * 0.071 + vec2(t * 0.021, t * 0.013));
  vec4 d2 = texture2D(uDetail, xz * 0.193 + vec2(-t * 0.027, t * 0.031));
  vec4 d3 = texture2D(uDetail, xz * 0.0157 + vec2(t * 0.004, -t * 0.006));
  vec2 dn = (d1.xy - 0.5) * 1.3 + (d2.xy - 0.5) * 0.9 + (d3.xy - 0.5) * 0.8;
  float rippleFade = 1.0 / (1.0 + dist * 0.011);
  n.xz += dn * (0.16 + 0.22 * uChop) * rippleFade;
  vec3 N = normalize(n);

  // ── the body of the water ──
  float NdotV = max(dot(N, V), 0.0);
  float depthK = 1.0 - exp(-max(depth, 0.0) * 0.30 * (2.0 - uOpts.z));
  vec3 body = mix(uShallow, uDeep, depthK);
  // looking straight down you see into the water; at a glance it's surface colour
  body = mix(body, uDeep, (1.0 - NdotV) * 0.25);
  // the seabed shows through clear shallows, dappled by caustics
  float bedVis = exp(-max(depth, 0.0) * (1.25 - 0.6 * uOpts.z)) * uOpts.z;
  float ca = texture2D(uDetail, vWorld.xz * 0.16 + N.xz * 0.6 + vec2(t * 0.03, 0.0)).a
           * texture2D(uDetail, vWorld.xz * 0.11 - vec2(0.0, t * 0.025)).a;
  float caustic = smoothstep(0.16, 0.42, ca) * 1.1;
  vec3 bed = uSeabed * (0.62 + caustic * 0.75);
  body = mix(body, bed, clamp(bedVis, 0.0, 0.92));
  body *= uLight;
  // sunlight scattering through the swell crests
  float sunSide = max(dot(normalize(V.xz + 1e-4), -normalize(uSunDir.xz + 1e-4)), 0.0);
  body += uScatter * uLight * smoothstep(0.15, 1.0, vCrest) * (0.25 + 0.75 * sunSide) * 0.55 * shallow;

  // ── reflection ──
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.02;
  R = normalize(R);
  vec3 refl = skyAir(R);
  vec4 cl = skyClouds(R, 3);
  refl = mix(refl, cl.rgb, cl.a);
  float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  fres = clamp(fres * uOpts.w, 0.0, 1.0);
  vec3 col = mix(body, refl, fres);

  // sun glitter: a tight core plus a broad sheen, both shattered by ripples
  float sdot = max(dot(R, uSunDir), 0.0);
  float glint = pow(sdot, 900.0) * 9.0 + pow(sdot, 160.0) * 0.20 + pow(sdot, 22.0) * 0.016;
  float sparkleMask = 0.45 + 1.1 * smoothstep(0.52, 0.62, d2.a) * smoothstep(0.4, 0.7, d1.a + 0.15);
  col += uSunSpec * glint * sparkleMask * uOpts.x * (0.25 + 0.75 * fres * 4.0);

  // ── foam ──
  float fn = d1.a * 0.6 + d2.a * 0.4;
  // shoreline: a soft band right at the sand, then lapping lines further out
  float shoreBand = smoothstep(0.95, 0.0, depth + (fn - 0.5) * 0.7);
  float lap = sin(depth * 4.2 - t * 1.5 + fn * 5.0) * 0.5 + 0.5;
  float lapBand = smoothstep(0.72, 0.98, lap) * smoothstep(3.2, 0.5, depth) * smoothstep(0.42, 0.62, fn + 0.12);
  // crests: only the steepest tops break
  float fine = texture2D(uDetail, xz * 0.33 + vec2(t * 0.03, -t * 0.02)).a;
  float crest = smoothstep(0.78, 1.05, vCrest + (fine - 0.5) * 0.5) * smoothstep(0.52, 0.64, fine) * 0.4 * shallow;
  float foam = clamp((shoreBand * 0.95 + lapBand * 0.7) * step(-0.5, depth) + crest, 0.0, 1.0) * uOpts.y;
  vec3 foamCol = vec3(0.95, 0.98, 1.0) * (uLight * 0.9 + 0.12);
  col = mix(col, foamCol, foam);

  // ── atmosphere ──
  float fogF = thalassaFogAmount(vView, uFogNear, uFogFar * 1.12);
  col = mix(col, thalassaFogColor(uFogColor, normalize(vView)), fogF);
  gl_FragColor = vec4(col, 1.0);
}`;

export function makeOcean(theme, look) {
  const geo = polarGrid();
  const sunEl = THREE.MathUtils.degToRad(look.sun.el);
  const sunCol = new THREE.Color(look.sun.color);
  // water-body illumination: sun (by elevation) + a share of the sky
  const light = sunCol.clone().multiplyScalar(0.30 + 0.70 * Math.sin(sunEl))
    .lerp(new THREE.Color(look.sky.zenith).multiplyScalar(1.6), 0.18);
  const w = theme.water;
  // optional theme override (theme.water.light): a stage whose sun sits on the
  // horizon has its sea lit by the SKY, which the sun-elevation model above
  // under-counts (it turned the polar sea black). Unset = unchanged.
  if (w.light !== undefined) light.set(w.light);
  const uniforms = {
    ...skyUniforms(),
    uFogSunColor: ATMO.uFogSunColor, uFogParams: ATMO.uFogParams,
    uAtmoSunView: ATMO.uAtmoSunView, uAtmoCamY: ATMO.uAtmoCamY,
    uTime: { value: 0 },
    uChop: { value: w.chop ?? 1 },
    uWaterY: { value: WATER_Y },
    uShoreTex: { value: noShoreTexture() },
    uShoreRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uDetail: { value: detailNormalTexture() },
    uDeep: { value: new THREE.Color(w.deep) },
    uShallow: { value: new THREE.Color(w.shallow) },
    uSeabed: { value: new THREE.Color(w.seabed ?? theme.palette.sand) },
    uScatter: { value: new THREE.Color(w.scatter ?? w.shallow) },
    uLight: { value: light },
    uSunSpec: { value: sunCol.clone().multiplyScalar(look.sun.intensity * 0.9) },
    uOpts: { value: new THREE.Vector4(w.sparkle ?? 1, w.foam ?? 1, w.clarity ?? 1, w.reflect ?? 1) },
    uFogColor: { value: new THREE.Color(look.fog.color) },
    uFogNear: { value: 100 },
    uFogFar: { value: 500 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: false,
  });
  mat.onBeforeCompile = () => {};            // owns its fog uniforms already
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'water';
  mesh.renderOrder = -5;

  return {
    mesh, uniforms,
    heightAt: () => 0,
    waveHeight: (x, z, t) => waveHeight(x, z, t, uniforms.uChop.value),
    /** shore = makeShoreMap(...) handle, or null for open deep water */
    setShoreMap(shore) {
      uniforms.uShoreTex.value = shore ? shore.texture : noShoreTexture();
      if (shore) shore.rectVec4(uniforms.uShoreRect.value);
    },
    /** t seconds; focus = point the camera looks at; fog = scene.fog */
    update(t, focus, fog) {
      uniforms.uTime.value = t;
      if (focus) {
        // glide with the view; snapping keeps the fine near-rings from swimming
        mesh.position.set(Math.round(focus.x / 2) * 2, 0, Math.round(focus.z / 2) * 2);
      }
      if (fog) {
        uniforms.uFogColor.value.copy(fog.color);
        uniforms.uFogNear.value = fog.near;
        uniforms.uFogFar.value = fog.far;
      }
    },
  };
}

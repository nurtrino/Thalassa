/*
 * Thalassa 3D world — a fogged frontier archipelago, fully procedural.
 * The board is dynamic: islands appear as you explore (mist silhouettes →
 * real isles), monsters fall, shrines spend out, the Pharos burns at center.
 * Each island group is keyed by its view-state and rebuilt on change.
 */
import * as THREE from 'three';
import { OrbitControls } from '/static/vendor/OrbitControls.js';

export const DOMAIN_COLORS = {
  clio: '#d9a441', athena: '#2e9e8f', apollo: '#7d5ba6', dionysos: '#e4572e',
};

const COL = {
  waterDeep: 0x1272a8, waterShallow: 0x3fd0cf, foam: 0xeafcff,
  sand: 0xf3e3b4, sandWet: 0xd9c489, grass: 0x5cb56e, grass2: 0x3f9e58,
  rock: 0x93999e, rockDark: 0x5c6166, basalt: 0x4a4a52,
  trunk: 0x8a5a33, frond: 0x2f9e44, frond2: 0x47b858, cypress: 0x1f6e3d,
  olive: 0x9db87a, marble: 0xf7f4ec, marbleShade: 0xe4ddc9,
  aegeanBlue: 0x2d5bb9, terracotta: 0xc96f4a, gold: 0xd9a441,
  wood: 0x9a6b3f, woodDark: 0x74502f, mist: 0x9aa5ad, monster: 0x2f2a33,
};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, ...extra });

/* displace vertices by a hash of their POSITION so shared/duplicated vertices
 * move identically — organic jitter with no torn faces or holes */
function displace(geo, amt, seed = 0) {
  const p = geo.attributes.position;
  const h = (x, y, z, k) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + k * 91.7 + seed) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i,
      x + (h(x, y, z, 1) - 0.5) * amt,
      y + (h(x, y, z, 2) - 0.5) * amt,
      z + (h(x, y, z, 3) - 0.5) * amt);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ── sky / sun / water (unchanged aesthetics) ───────────────────────────── */
function makeSky() {
  const geo = new THREE.SphereGeometry(2600, 24, 14);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x5fb0e6) },
      mid: { value: new THREE.Color(0xa5d9ef) },
      horizon: { value: new THREE.Color(0xfdeed3) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 zenith; uniform vec3 mid; uniform vec3 horizon; varying vec3 vP;
      void main(){
        float h = normalize(vP).y;
        vec3 c = h > 0.25 ? mix(mid, zenith, smoothstep(0.25, 0.8, h))
                          : mix(horizon, mid, smoothstep(-0.05, 0.25, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

function makeSunGlow() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,250,225,1)');
  g.addColorStop(0.18, 'rgba(255,240,190,0.9)');
  g.addColorStop(0.5, 'rgba(255,225,150,0.25)');
  g.addColorStop(1, 'rgba(255,220,140,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sp.scale.set(70, 70, 1);
  return sp;
}

function puffTexture(r, g, b) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const blob = (x, y, rad, a) => {
    const gr = ctx.createRadialGradient(x, y, rad * 0.12, x, y, rad);
    gr.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    gr.addColorStop(0.6, `rgba(${r},${g},${b},${a * 0.45})`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 256, 256);
  };
  blob(128, 148, 96, 0.9);
  blob(84, 128, 66, 0.85);
  blob(174, 124, 70, 0.85);
  blob(126, 102, 56, 0.8);
  // shade the underside so puffs read as lit from above
  ctx.globalCompositeOperation = 'source-atop';
  const sh = ctx.createLinearGradient(0, 60, 0, 240);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(1, `rgba(${Math.round(r*0.55)},${Math.round(g*0.55)},${Math.round(b*0.62)},0.5)`);
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, 256, 256);
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ── the storm wall: continuous animated cloud, shader-built ─────────────
   Concentric shells sample seamless 3D value-noise in WORLD space, so the
   wall has no seams, a ragged boiling top, and depth from parallax. A
   lightning angle/intensity uniform lets bolts glow through the cloud. */
const STORM_VERT = `
  varying vec3 vW;
  varying float vH;
  uniform float uH0; uniform float uH1;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vH = (wp.y - uH0) / (uH1 - uH0);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const STORM_FRAG = `
  precision highp float;
  varying vec3 vW;
  varying float vH;
  uniform float t; uniform float uOp; uniform float uScale; uniform float uDrift;
  uniform float uSolid;
  uniform vec3 cA; uniform vec3 cB;
  uniform float boltA; uniform float boltI;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0; float a = 0.52;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 11.5; a *= 0.5; }
    return v;
  }
  void main() {
    // slow angular drift keeps the wall churning around the ring
    float ca = cos(t * 0.008 * uDrift), sa = sin(t * 0.008 * uDrift);
    vec3 q = vec3(vW.x * ca - vW.z * sa, vW.y * 0.55, vW.x * sa + vW.z * ca) * uScale;
    float n1 = fbm(q + vec3(0.0, -t * 0.045, 0.0));
    float n2 = fbm(q * 1.9 + vec3(t * 0.03, t * 0.018, 4.7));
    float d = n1 * 0.68 + n2 * 0.32;
    // ragged top silhouette and a base that melts into the sea
    float top = smoothstep(1.04, 0.42 + d * 0.5, vH);
    float base = smoothstep(-0.1, 0.14, vH);
    float aWisp = smoothstep(0.38, 0.66, d) * top * base;
    float aSolid = top * step(-1.0, vH);          // opaque core: only the crown fades
    float alpha = mix(aWisp, aSolid, uSolid) * uOp;
    vec3 col = mix(cA, cB, clamp(smoothstep(0.3, 0.85, d) * 0.75 + vH * 0.35, 0.0, 1.0));
    // lightning diffusing through the cloud around the bolt angle
    float ang = atan(vW.z, vW.x);
    float dd = abs(mod(ang - boltA + 3.14159, 6.28318) - 3.14159);
    float glow = boltI * exp(-5.0 * dd);
    col += vec3(0.72, 0.78, 1.0) * glow * (0.4 + d);
    alpha = min(1.0, alpha + glow * 0.15);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }`;

function stormWallMaterial(opts) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: !!opts.solid, side: THREE.DoubleSide,
    uniforms: {
      t: { value: 0 },
      uOp: { value: opts.op }, uScale: { value: opts.scale },
      uDrift: { value: opts.drift }, uSolid: { value: opts.solid || 0 },
      cA: { value: new THREE.Color(opts.cA) }, cB: { value: new THREE.Color(opts.cB) },
      uH0: { value: opts.h0 }, uH1: { value: opts.h1 },
      boltA: { value: 0 }, boltI: { value: 0 },
    },
    vertexShader: STORM_VERT,
    fragmentShader: STORM_FRAG,
  });
}
const TEX_CLOUD = puffTexture(255, 255, 255);
const TEX_MIST = puffTexture(226, 236, 240);

function cloudSprite(tex, size, opacity = 1) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity, depthWrite: false }));
  sp.scale.set(size, size * 0.62, 1);
  return sp;
}

/* a cumulus: several soft sprites clumped with a flat-ish base */
function makeCloud(big) {
  const cl = new THREE.Group();
  const n = 4 + Math.floor(Math.random() * 3);
  for (let j = 0; j < n; j++) {
    const sp = cloudSprite(TEX_CLOUD, (16 + Math.random() * 18) * big, 0.9);
    sp.position.set((j - n / 2) * 9 * big + (Math.random() - 0.5) * 6,
                    Math.random() * 5 * big, (Math.random() - 0.5) * 8 * big);
    cl.add(sp);
  }
  return cl;
}

function makeWater(sunDir) {
  const geo = new THREE.PlaneGeometry(4200, 4200, 220, 220);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      t: { value: 0 },
      deep: { value: new THREE.Color(COL.waterDeep) },
      shallow: { value: new THREE.Color(COL.waterShallow) },
      sky: { value: new THREE.Color(0xbfe6f2) },
      sunDir: { value: sunDir.clone().normalize() },
    },
    vertexShader: /* glsl */`
      uniform float t;
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 p = position;
        float w1 = sin(p.x*0.14 + t*1.05), w2 = cos(p.z*0.17 + t*0.8),
              w3 = sin((p.x+p.z)*0.075 + t*0.5);
        p.y += w1*0.34 + w2*0.30 + w3*0.28;
        float dx = 0.14*cos(p.x*0.14 + t*1.05)*0.34 + 0.075*cos((p.x+p.z)*0.075 + t*0.5)*0.28;
        float dz = -0.17*sin(p.z*0.17 + t*0.8)*0.30 + 0.075*cos((p.x+p.z)*0.075 + t*0.5)*0.28;
        vN = normalize(vec3(-dx, 1.0, -dz));
        vW = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 deep; uniform vec3 shallow; uniform vec3 sky; uniform vec3 sunDir; uniform float t;
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        vec3 N = normalize(vN);
        float lift = clamp(0.62 + N.x*1.4 + N.z*0.9, 0.0, 1.0);
        vec3 c = mix(deep, shallow, lift * 0.75);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        c = mix(c, sky, fres * 0.55);
        vec3 R = reflect(-sunDir, N);
        float spec = pow(max(dot(R, V), 0.0), 90.0);
        c += vec3(1.0, 0.95, 0.8) * spec * 0.8;
        float sparkle = pow(max(0.0, sin(vW.x*1.3 + t*2.1) * sin(vW.z*1.7 - t*1.7)), 18.0);
        c += vec3(0.9, 0.97, 1.0) * sparkle * 0.06;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.62;
  return mesh;
}

let _shallowTex = null;
function shallowDisc(radius) {
  if (!_shallowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
    g.addColorStop(0, 'rgba(96,224,213,0.62)');
    g.addColorStop(0.55, 'rgba(96,224,213,0.34)');
    g.addColorStop(1, 'rgba(96,224,213,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    _shallowTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius, radius),
    new THREE.MeshBasicMaterial({ map: _shallowTex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = -0.05;
  return m;
}

/* ── terrain (radial sculpted mesh, vertex-colored) ─────────────────────── */
function makeTerrain({ seed, R, H, mode = 'hill', palette = {}, lobes = 0 }) {
  const rng = mulberry32(seed);
  const SEG_A = 44, SEG_R = 13;
  // every island drifts its own way: stretched, rugged, lush or parched
  const ex = 0.78 + rng() * 0.55;             // east-west stretch
  const ez = 0.78 + rng() * 0.55;             // north-south stretch
  const rugged = 0.8 + rng() * (mode === 'mesa' ? 0.7 : 1.4);
  const hueDrift = (c, dh, ds, dl) => {
    const hsl = {};
    c.getHSL(hsl);
    c.setHSL((hsl.h + dh + 1) % 1, Math.min(1, Math.max(0, hsl.s + ds)),
             Math.min(1, Math.max(0, hsl.l + dl)));
    return c;
  };
  const gShift = (rng() - 0.5) * 0.06, sShift = (rng() - 0.5) * 0.03;
  const P = {
    sand: hueDrift(new THREE.Color(palette.sand ?? COL.sand), sShift, 0, (rng() - 0.5) * 0.06),
    sandWet: new THREE.Color(palette.sandWet ?? COL.sandWet),
    grass: hueDrift(new THREE.Color(palette.grass ?? COL.grass), gShift, (rng() - 0.5) * 0.1, 0),
    grass2: hueDrift(new THREE.Color(palette.grass2 ?? COL.grass2), gShift, 0, (rng() - 0.5) * 0.08),
    rock: new THREE.Color(palette.rock ?? COL.rock),
  };
  const h1a = (0.07 + rng() * 0.12) * rugged, h1k = 2 + Math.floor(rng() * 2), h1p = rng() * 6.28;
  const h2a = (0.05 + rng() * 0.09) * rugged, h2k = 4 + Math.floor(rng() * 3), h2p = rng() * 6.28;
  const h3a = (0.02 + rng() * 0.07) * rugged, h3k = 7 + Math.floor(rng() * 5), h3p = rng() * 6.28;
  const edge = (a) => (1 + h1a * Math.sin(a * h1k + h1p) + h2a * Math.sin(a * h2k + h2p)
                         + h3a * Math.sin(a * h3k + h3p))
                      * (1 + lobes * Math.sin(2 * a + h1p));
  const bump = (a, rr) => 1 + 0.16 * Math.sin(a * 3 + h1p + rr * 5) * rr;
  const smooth = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  const profile = (rr) => {
    if (mode === 'mesa') return H * (1 - smooth(0.52, 0.88, rr));
    if (mode === 'peak') return H * Math.pow(Math.max(0, 1 - rr), 1.35);
    if (mode === 'flat') return H * (1 - smooth(0.7, 0.97, rr));
    if (mode === 'atoll') return H * (smooth(0.14, 0.4, rr) - smooth(0.55, 0.92, rr));
    return H * (1 - smooth(0.15, 0.95, rr)) * (0.75 + 0.25 * Math.cos(rr * 3));
  };

  const pos = [], col = [], idx = [];
  const RINGS = SEG_R + 3;
  const heightAt = (rr) => Math.max(0, profile(Math.min(rr, 1)));

  for (let ri = 0; ri <= RINGS; ri++) {
    for (let ai = 0; ai < SEG_A; ai++) {
      const a = (ai / SEG_A) * Math.PI * 2;
      let rr, y;
      if (ri <= SEG_R) {
        rr = ri / SEG_R;
        y = heightAt(rr) * bump(a, rr);
        if (ri === SEG_R) y = 0.08;
      } else {
        const k = ri - SEG_R;
        rr = 1 + k * 0.09;
        y = -k * 1.15;
      }
      const wr = rr * R * edge(a);
      pos.push(Math.cos(a) * wr * ex, y, Math.sin(a) * wr * ez);
      const c = new THREE.Color();
      const hFrac = y / Math.max(H, 0.001);
      if (ri > SEG_R) c.copy(ri === SEG_R + 1 ? P.sandWet : P.rock).multiplyScalar(0.75);
      else if (y < 0.42) c.copy(rr > 0.93 ? P.sandWet : P.sand);
      else if (mode === 'mesa' && hFrac > 0.62 && rr > 0.42) c.copy(P.rock);
      else if (mode === 'peak' && hFrac > 0.55) c.copy(P.rock).lerp(new THREE.Color(COL.rockDark), (hFrac - 0.55) * 1.6);
      else c.copy(P.grass).lerp(P.grass2, (Math.sin(a * 5 + rr * 9 + h2p) + 1) / 2);
      col.push(c.r, c.g, c.b);
    }
  }
  const capY = heightAt(0);
  pos.push(0, capY, 0);
  const capC = mode === 'peak' ? new THREE.Color(COL.rockDark) : P.grass;
  col.push(capC.r, capC.g, capC.b);
  const capIdx = pos.length / 3 - 1;

  const vid = (ri, ai) => ri * SEG_A + (ai % SEG_A);
  for (let ai = 0; ai < SEG_A; ai++) idx.push(capIdx, vid(0, ai + 1), vid(0, ai));
  for (let ri = 0; ri < RINGS; ri++) {
    for (let ai = 0; ai < SEG_A; ai++) {
      const a0 = vid(ri, ai), a1 = vid(ri, ai + 1), b0 = vid(ri + 1, ai), b1 = vid(ri + 1, ai + 1);
      idx.push(a0, a1, b0, a1, b1, b0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return { mesh, heightAt, rng };
}

/* ── flora & props ──────────────────────────────────────────────────────── */
function makePalm(rng, scale = 1) {
  const g = new THREE.Group();
  const lean = (rng() - 0.5) * 0.5;
  let x = 0, y = 0;
  for (let i = 0; i < 4; i++) {
    const h = 0.62 * scale;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075 * scale * (1 - i * 0.14), 0.1 * scale * (1 - i * 0.14), h, 5),
      flat(COL.trunk));
    seg.position.set(x, y + h / 2, 0);
    seg.rotation.z = lean * (i + 0.5) * 0.3;
    seg.castShadow = true;
    g.add(seg);
    x += Math.sin(lean * (i + 1) * 0.3) * h;
    y += Math.cos(lean * (i + 1) * 0.3) * h;
  }
  const top = new THREE.Vector3(x, y + 0.05 * scale, 0);
  const nF = 7 + Math.floor(rng() * 3);
  for (let i = 0; i < nF; i++) {
    const fg = new THREE.PlaneGeometry(1.7 * scale, 0.42 * scale, 5, 1);
    const p = fg.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const fx = Math.max(0, p.getX(v) / (1.7 * scale) + 0.5);
      p.setY(v, p.getY(v) * (1 - fx * 0.55));
      p.setZ(v, -Math.pow(fx, 1.7) * 0.55 * scale);
    }
    fg.computeVertexNormals();
    const frond = new THREE.Mesh(fg, flat(i % 2 ? COL.frond : COL.frond2, { side: THREE.DoubleSide }));
    frond.position.copy(top);
    frond.rotation.y = (i / nF) * Math.PI * 2 + rng() * 0.4;
    frond.translateX(0.7 * scale);
    frond.castShadow = true;
    g.add(frond);
  }
  return g;
}

function makeCypress(rng, scale = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.4 * scale, 5), flat(COL.trunk));
  trunk.position.y = 0.2 * scale;
  g.add(trunk);
  let y = 0.35 * scale;
  for (const [r, h] of [[0.42, 1.1], [0.3, 0.85], [0.16, 0.6]]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * scale, h * scale, 6), flat(COL.cypress));
    cone.position.y = y + (h * scale) / 2;
    cone.castShadow = true;
    g.add(cone);
    y += h * scale * 0.55;
  }
  g.rotation.y = rng() * 6.28;
  return g;
}

function makeRock(rng, r, color = COL.rock) {
  const geo = displace(new THREE.DodecahedronGeometry(r, 0), r * 0.55, rng() * 100);
  geo.scale(1, 0.65 + rng() * 0.3, 1);
  const rock = new THREE.Mesh(geo, flat(color));
  rock.castShadow = true;
  rock.rotation.y = rng() * 6.28;
  return rock;
}

function makeColumn(h = 1.6, r = 0.13) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(r * 2.6, r * 0.7, r * 2.6), flat(COL.marbleShade));
  base.position.y = r * 0.35;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.14, h, 8), flat(COL.marble));
  shaft.position.y = r * 0.7 + h / 2;
  shaft.castShadow = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(r * 3, r * 0.8, r * 3), flat(COL.marbleShade));
  cap.position.y = r * 0.7 + h + r * 0.4;
  g.add(base, shaft, cap);
  return g;
}

function makeShrine(domainHex) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.4, 10), flat(COL.marbleShade));
  base.position.y = 0.2;
  base.castShadow = true;
  g.add(base);
  for (let i = 0; i < 4; i++) {
    const c = makeColumn(1.1, 0.1);
    const a = (i / 4) * Math.PI * 2 + 0.4;
    c.position.set(Math.cos(a) * 0.85, 0.4, Math.sin(a) * 0.85);
    g.add(c);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.35, 0.65, 10), flat(new THREE.Color(domainHex)));
  roof.position.y = 2.15;
  roof.castShadow = true;
  const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.14, 0.4, 6), flat(COL.gold, { emissive: 0x6a4a10 }));
  brazier.position.y = 0.6;
  g.add(roof, brazier);
  return g;
}

function makeObelisk() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.4, 1.3), flat(COL.marbleShade));
  base.position.y = 0.2;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 2.6, 4), flat(0x8d94b8));
  shaft.position.y = 1.7;
  shaft.rotation.y = Math.PI / 4;
  shaft.castShadow = true;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.5, 4), flat(COL.gold, { emissive: 0x9a6a10, emissiveIntensity: 0.6 }));
  tip.position.y = 3.25;
  tip.rotation.y = Math.PI / 4;
  const glow = new THREE.PointLight(0x9fb4ff, 5, 9);
  glow.position.y = 2.4;
  g.add(base, shaft, tip, glow);
  return g;
}

function makeTents(rng) {
  const g = new THREE.Group();
  const hues = [0xc96f4a, 0x8e5572, 0x3a7ca5];
  hues.forEach((hex, i) => {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.0, 6), flat(hex));
    const a = i * 2.1 + rng() * 0.5;
    tent.position.set(Math.cos(a) * 1.5, 0.5, Math.sin(a) * 1.5);
    tent.castShadow = true;
    g.add(tent);
  });
  const fire = new THREE.PointLight(0xff9a3d, 5, 8);
  fire.position.y = 1.2;
  const pit = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.2, 8), flat(COL.rockDark));
  pit.position.y = 0.1;
  g.add(fire, pit);
  return g;
}

function makeLighthouse() {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.62, 3.4, 9), flat(COL.marble));
  tower.position.y = 1.7;
  tower.castShadow = true;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.5, 9), flat(COL.aegeanBlue));
  band.position.y = 1.4;
  const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 6), flat(0xffd97a, { emissive: 0xb98a1a }));
  cage.position.y = 3.65;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 8), flat(COL.terracotta));
  cap.position.y = 4.15;
  cap.castShadow = true;
  const light = new THREE.PointLight(0xffd97a, 8, 16);
  light.position.y = 3.7;
  g.add(tower, band, cage, cap, light);
  return g;
}

function makeDock(len = 5.2) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.22, len), flat(COL.wood));
  deck.position.set(0, 0.55, -len / 2);
  deck.castShadow = true;
  g.add(deck);
  for (let i = 0; i <= 2; i++) {
    for (const px of [-0.95, 0.95]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 5), flat(COL.woodDark));
      post.position.set(px, 0.1, -0.4 - i * (len - 0.9) / 2);
      g.add(post);
    }
  }
  return g;
}

/* map monster totem: the SAME archetype model the battle uses, so what you
   see on the chart is what you fight — plus a menacing ember glow */
function makeMonster(rng, m) {
  const per = m.count > 1 ? Math.max(1, Math.round(m.max_hp / m.count)) : m.max_hp;
  const g = makeEnemy(m.name, Math.min(8, per));
  const glow = new THREE.PointLight(0xff5030, 3 + m.max_hp, 7 + m.max_hp);
  glow.position.y = 2.2;
  g.add(glow);
  g.name = 'monster';
  return g;
}

function makeRelicBeacon() {
  const g = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.55, 9, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: COL.gold, transparent: true, opacity: 0.28,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  beam.position.y = 5.5;
  const urn = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), flat(COL.gold, { emissive: 0x9a6a10 }));
  urn.position.y = 1.4;
  g.add(beam, urn);
  g.name = 'beacon';
  return g;
}

function makePharos() {
  const g = new THREE.Group();
  const white = (e) => new THREE.MeshStandardMaterial({
    color: 0xf7f4ea, flatShading: true, emissive: 0xfff3d0, emissiveIntensity: e });
  const tiers = [
    [7.4, 8.8, 3.4, 1.7, 10],
    [5.2, 6.6, 5.4, 6.0, 10],
    [3.1, 4.3, 7.0, 12.0, 9],
    [1.7, 2.6, 6.6, 18.6, 8],
  ];
  for (const [rt, rb, h, y, segs] of tiers) {
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), white(0.12 + y * 0.006));
    tier.position.y = y;
    tier.castShadow = true;
    g.add(tier);
  }
  for (let i = 0; i < 10; i++) {                     // colonnade on the first tier
    const a = (i / 10) * Math.PI * 2;
    const col = makeColumn(3.0, 0.3);
    col.position.set(Math.cos(a) * 7.7, 3.4, Math.sin(a) * 7.7);
    g.add(col);
  }
  const fire = new THREE.Mesh(new THREE.SphereGeometry(1.5, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8 }));
  fire.position.y = 23.2;
  fire.name = 'pharosfire';
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.4, 2.6, 8), white(0.25));
  cap.position.y = 26.0;
  const light = new THREE.PointLight(0xffe2a0, 42, 300, 1.6);
  light.position.y = 23.2;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.8, 70, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.15,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  beam.position.y = 56;
  const halo = makeSunGlow();
  halo.scale.set(52, 52, 1);
  halo.position.y = 23.2;
  g.add(fire, cap, light, beam, halo);
  return g;
}

function makeMarket(rng) {
  const g = new THREE.Group();
  const hut = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.8, 2.2), flat(0xf1e8d2));
  hut.position.y = 0.9;
  hut.castShadow = true;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.2, 1.3, 4), flat(0xc0392b));
  roof.position.y = 2.45;
  roof.rotation.y = Math.PI / 4;
  const awn = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.4, 4, 1),
    flat(0xd9a441, { side: THREE.DoubleSide }));
  awn.position.set(0, 1.75, 1.95);
  awn.rotation.x = -0.55;
  g.add(hut, roof, awn);
  for (let i = 0; i < 3; i++) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), flat(0x9a7448));
    crate.rotation.y = rng() * 0.8;
    crate.position.set(-1.7 + i * 0.9, 0.35, 1.9 + (i % 2) * 0.6);
    g.add(crate);
  }
  const amph = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), flat(0xb1543a));
  amph.scale.y = 1.5;
  amph.position.set(1.8, 0.65, 1.6);
  const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.12, 12),
    flat(0xd9a441, { emissive: 0x7a5a10 }));
  sign.rotation.x = Math.PI / 2;
  sign.position.set(0, 2.1, 1.35);
  g.add(amph, sign);
  return g;
}

/* open-sea waypoints: a buoy, or bobbing flotsam worth a scroll */
function makeBuoy(rng) {
  const g = new THREE.Group();
  const float = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.38, 0.42, 8),
    flat(0xd9534f));
  float.position.y = 0.28;
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.14, 8),
    flat(0xf7f4ec));
  stripe.position.y = 0.34;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 5),
    flat(COL.woodDark));
  pole.position.y = 1.0;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5),
    flat(0xffd97a, { emissive: 0x9a7a1a }));
  lamp.position.y = 1.6;
  g.add(float, stripe, pole, lamp);
  g.rotation.y = rng() * 6.28;
  g.name = 'bob';
  return g;
}

function makeFlotsam(rng) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.55), flat(COL.woodDark));
    const a = rng() * 6.28;
    crate.position.set(Math.cos(a) * (0.4 + rng() * 0.5), 0.16, Math.sin(a) * (0.4 + rng() * 0.5));
    crate.rotation.y = rng() * 1.5;
    g.add(crate);
  }
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 8), flat(COL.wood));
  barrel.rotation.z = Math.PI / 2;
  barrel.position.y = 0.2;
  g.add(barrel);
  const glint = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5),
    flat(COL.gold, { emissive: 0x9a6a10 }));
  glint.position.y = 0.5;
  g.add(glint);
  g.name = 'bob';
  return g;
}

/* ── battle enemies: five procedural archetypes, tinted per name ────────── */
function enemyArchetype(name) {
  const n = name.toLowerCase();
  if (/harp|bird/.test(n)) return 'wing';
  if (/wolf|lion|boar/.test(n)) return 'beast';
  if (/siren|empusa|gorgon|sphinx|drowned/.test(n)) return 'spirit';
  if (/hydra|ketos|skylla|charybdis|typhon|dragon|serpent/.test(n)) return 'serpent';
  return 'brute';
}

const ENEMY_TINTS = [0x3a2e4f, 0x2e463f, 0x4f2e2e, 0x2e3a4f, 0x443047];

function makeEnemy(name, maxHp) {
  const seed = hashStr(name);
  const rng = mulberry32(seed);
  const tint = ENEMY_TINTS[seed % ENEMY_TINTS.length];
  const s = 0.85 + maxHp * 0.28;
  const g = new THREE.Group();
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
  const addEyes = (y, z, spread = 0.22) => {
    for (const dx of [-spread, spread]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09 * s, 6, 5), eyeMat);
      eye.position.set(dx * s, y, z);
      g.add(eye);
    }
  };
  const kind = enemyArchetype(name);
  if (kind === 'wing') {
    const body = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.6 * s, 1), 0.2 * s, seed), flat(tint));
    body.position.y = 1.2 * s;
    body.castShadow = true;
    g.add(body);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(1.5 * s, 0.6 * s, 3, 1),
        flat(tint, { side: THREE.DoubleSide }));
      wing.position.set(side * 0.75 * s, 1.45 * s, 0);
      wing.rotation.z = side * 0.3;
      wing.name = side < 0 ? 'wingL' : 'wingR';
      wing.castShadow = true;
      g.add(wing);
    }
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.12 * s, 0.4 * s, 5), flat(0xc9a227));
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 1.3 * s, 0.62 * s);
    g.add(beak);
    addEyes(1.45 * s, 0.5 * s, 0.18);
  } else if (kind === 'spirit') {
    const robe = new THREE.Mesh(displace(new THREE.ConeGeometry(0.7 * s, 1.9 * s, 8), 0.16 * s, seed), flat(tint));
    robe.position.y = 1.35 * s;
    robe.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34 * s, 8, 6), flat(tint));
    head.position.y = 2.4 * s;
    const aura = new THREE.Mesh(new THREE.SphereGeometry(1.1 * s, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x9f7dd6, transparent: true, opacity: 0.14,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    aura.position.y = 1.6 * s;
    g.add(robe, head, aura);
    addEyes(2.44 * s, 0.28 * s, 0.14);
    g.userData.float = true;
  } else if (kind === 'serpent') {
    const boss = maxHp >= 5;
    const segs = boss ? 6 : 5;
    for (let i = 0; i < segs; i++) {
      const k = i / (segs - 1);
      const r = (0.5 - k * 0.24) * s;
      const seg = new THREE.Mesh(displace(new THREE.SphereGeometry(r, 8, 6), r * 0.3, seed + i), flat(tint));
      seg.position.set(-Math.sin(k * 2.4) * 0.8 * s, 0.4 * s + k * 1.9 * s, Math.cos(k * 2.2) * 0.25 * s);
      seg.castShadow = true;
      g.add(seg);
    }
    const head = new THREE.Mesh(displace(new THREE.ConeGeometry(0.4 * s, 0.9 * s, 6), 0.12 * s, seed), flat(tint));
    head.rotation.x = Math.PI / 2.4;
    head.position.set(-Math.sin(2.4) * 0.8 * s, 2.5 * s, 0.5 * s);
    head.castShadow = true;
    g.add(head);
    addEyes(2.5 * s, 0.62 * s, 0.16);
    if (boss) {
      // swept membrane fins, tilted to catch the light
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.PlaneGeometry(1.0 * s, 0.55 * s, 3, 1),
          flat(0x7a4646, { side: THREE.DoubleSide }));
        wing.position.set(side * 0.55 * s, 1.7 * s, -0.15 * s);
        wing.rotation.set(-0.6, side * 0.5, side * 0.55);
        wing.name = side < 0 ? 'wingL' : 'wingR';
        g.add(wing);
      }
      for (let i = 0; i < 4; i++) {                 // dorsal spines up the back
        const k = i / 3;
        const spine = new THREE.Mesh(new THREE.ConeGeometry(0.07 * s, 0.4 * s, 4), flat(0x8a5050));
        spine.position.set(-Math.sin(k * 2.4) * 0.8 * s, (0.7 + k * 1.5) * s,
                           Math.cos(k * 2.2) * 0.25 * s - 0.3 * s);
        spine.rotation.x = -0.5;
        g.add(spine);
      }
    }
  } else if (kind === 'beast') {                  // quadruped: wolves & kin
    const body = new THREE.Mesh(displace(new THREE.SphereGeometry(0.62 * s, 8, 6), 0.14 * s, seed), flat(tint));
    body.scale.set(1.55, 0.85, 0.8);
    body.position.y = 0.85 * s;
    body.castShadow = true;
    g.add(body);
    for (const fx of [-0.55, 0.55]) {
      for (const fz of [-0.28, 0.28]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.07 * s, 0.8 * s, 5), flat(tint));
        leg.position.set(fx * s, 0.4 * s, fz * s);
        g.add(leg);
      }
    }
    const head = new THREE.Mesh(displace(new THREE.SphereGeometry(0.34 * s, 8, 6), 0.08 * s, seed + 3), flat(tint));
    head.position.set(0.95 * s, 1.15 * s, 0);
    head.castShadow = true;
    g.add(head);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.14 * s, 0.42 * s, 5), flat(tint));
    snout.rotation.z = -Math.PI / 2;
    snout.position.set(1.3 * s, 1.08 * s, 0);
    g.add(snout);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.09 * s, 0.28 * s, 4), flat(tint));
      ear.position.set(0.88 * s, 1.48 * s, side * 0.18 * s);
      g.add(ear);
    }
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09 * s, 0.7 * s, 5), flat(tint));
    tail.rotation.z = Math.PI / 2 + 0.5;
    tail.position.set(-1.0 * s, 1.05 * s, 0);
    g.add(tail);
    for (const dz of [-0.13, 0.13]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07 * s, 6, 5), eyeMat);
      eye.position.set(1.16 * s, 1.24 * s, dz * s);
      g.add(eye);
    }
  } else {                                        // brute
    const body = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.75 * s, 1), 0.22 * s, seed), flat(tint));
    body.scale.set(1, 1.35, 0.9);
    body.position.y = 1.15 * s;
    body.castShadow = true;
    g.add(body);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.18 * s, 1.1 * s, 6), flat(tint));
      arm.position.set(side * 0.85 * s, 1.15 * s, 0.1 * s);
      arm.rotation.z = side * 0.55;
      arm.castShadow = true;
      g.add(arm);
    }
    const head = new THREE.Mesh(displace(new THREE.SphereGeometry(0.4 * s, 8, 6), 0.1 * s, seed + 5), flat(tint));
    head.position.y = 2.25 * s;
    head.castShadow = true;
    g.add(head);
    const oneEye = /cyclops/.test(name.toLowerCase());
    if (oneEye) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.15 * s, 6, 5), eyeMat);
      eye.position.set(0, 2.32 * s, 0.36 * s);
      g.add(eye);
    } else {
      addEyes(2.3 * s, 0.34 * s, 0.16);
    }
    if (/minotaur|typhon/.test(name.toLowerCase())) {
      for (const side of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.09 * s, 0.5 * s, 5), flat(0xd8d4c8));
        horn.position.set(side * 0.3 * s, 2.6 * s, 0);
        horn.rotation.z = side * -0.5;
        g.add(horn);
      }
    }
    if (/satyr/.test(name.toLowerCase())) {
      for (const side of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06 * s, 0.3 * s, 4), flat(0xb9a06a));
        horn.position.set(side * 0.22 * s, 2.55 * s, 0.06 * s);
        horn.rotation.z = side * -0.85;
        g.add(horn);
      }
    }
    if (/raider|laestrygon|brigand/.test(name.toLowerCase())) {
      // shoulder pauldrons: raiders read as armed men, not blobs
      for (const side of [-1, 1]) {
        const pad = new THREE.Mesh(new THREE.SphereGeometry(0.24 * s, 6, 5), flat(0x6a5a40));
        pad.scale.y = 0.6;
        pad.position.set(side * 0.62 * s, 1.85 * s, 0);
        g.add(pad);
      }
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.06 * s, 0.9 * s, 4), flat(0xd8d4c8));
      blade.position.set(0.95 * s, 1.95 * s, 0.15 * s);
      blade.rotation.z = -0.3;
      g.add(blade);
    }
  }
  // bosses wear a golden crown — the relic guardians should read instantly
  if (maxHp >= 5) {
    const crown = new THREE.Group();
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, 0.34 * s, 0.16 * s, 8, 1, true),
      flat(0xd9a441, { emissive: 0x7a5a10, side: THREE.DoubleSide }));
    crown.add(band);
    for (let i = 0; i < 5; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05 * s, 0.2 * s, 4), flat(0xd9a441, { emissive: 0x7a5a10 }));
      const a = (i / 5) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.3 * s, 0.16 * s, Math.sin(a) * 0.3 * s);
      crown.add(spike);
    }
    const crownY = { wing: 1.85, spirit: 2.75, serpent: 2.95, beast: 1.62, brute: 2.62 }[kind] ?? 2.6;
    crown.position.y = crownY * s;
    if (kind === 'beast') crown.position.x = 0.95 * s;
    if (kind === 'serpent') crown.position.x = -Math.sin(2.4) * 0.8 * s;
    crown.name = 'crown';
    g.add(crown);
  }
  g.userData.scaleS = s;
  return g;
}

/* ── ships ──────────────────────────────────────────────────────────────── */
function sailTexture(colorHex) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f6efdc';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = colorHex;
  for (let i = 0; i < 4; i++) ctx.fillRect(0, 6 + i * 16, 64, 7);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeShip(colorHex) {
  /* A little Aegean galley, lofted from cross-sections: swept bow and
     stern posts, bronze ram, painted rail, square sail on a yard,
     rigging, steering oars, and the classic eye at the bow. */
  const g = new THREE.Group();
  const accent = new THREE.Color(colorHex);

  // hull loft — stations stern → bow: [x, halfWidth, railY, keelY]
  const ST = [
    [-1.70, 0.06, 0.86, 0.42],
    [-1.52, 0.30, 0.74, 0.16],
    [-1.00, 0.50, 0.62, 0.03],
    [-0.30, 0.58, 0.56, 0.00],
    [ 0.40, 0.57, 0.56, 0.00],
    [ 1.05, 0.48, 0.60, 0.03],
    [ 1.55, 0.26, 0.72, 0.14],
    [ 1.82, 0.05, 0.88, 0.40],
  ];
  const ring = (st) => {
    const [x, w, ry, ky] = st;
    const my = ky + (ry - ky) * 0.45;
    return [
      [x, ry, w], [x, my, w * 0.92], [x, ky + 0.04, w * 0.42], [x, ky - 0.05, 0],
      [x, ky + 0.04, -w * 0.42], [x, my, -w * 0.92], [x, ry, -w],
    ];
  };
  const rings = ST.map(ring);
  const pos = [];
  const quad = (a, b, c, d) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let j = 0; j < r0.length - 1; j++) {
      quad(r0[j], r1[j], r1[j + 1], r0[j + 1]);
    }
    // close the top with a deck strip between the two rails
    quad(r0[r0.length - 1], r1[r1.length - 1], r1[0], r0[0]);
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hullGeo.computeVertexNormals();
  const hull = new THREE.Mesh(hullGeo, flat(COL.wood));
  hull.castShadow = true;
  g.add(hull);

  // painted rail stripe in the captain's color, port and starboard
  for (const side of [-1, 1]) {
    const railPts = ST.map(([x, w, ry]) => new THREE.Vector3(x, ry + 0.015, side * w));
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 24, 0.045, 5),
      flat(accent));
    g.add(rail);
  }

  // swept stern post (curls inward) and bow stem
  const post = (x, lean) => {
    const p = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.055, 6, 10, 2.1), flat(COL.woodDark));
    p.position.set(x, 0.98, 0);
    p.rotation.z = lean;
    return p;
  };
  g.add(post(-1.72, -0.5), post(1.84, Math.PI - 2.6));

  // bronze ram at the waterline
  const ram = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.5, 6), flat(0xc9a227, { emissive: 0x4a3a10 }));
  ram.rotation.z = -Math.PI / 2;
  ram.position.set(2.02, 0.12, 0);
  g.add(ram);

  // the eye of the ship, both bows
  for (const side of [-1, 1]) {
    const white = new THREE.Mesh(new THREE.CircleGeometry(0.085, 10),
      new THREE.MeshBasicMaterial({ color: 0xf4efe2 }));
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.04, 8),
      new THREE.MeshBasicMaterial({ color: 0x22303c }));
    white.position.set(1.42, 0.52, side * 0.335);
    pupil.position.set(1.435, 0.52, side * 0.345);
    white.rotation.y = side * (Math.PI / 2 + 0.25);
    pupil.rotation.y = side * (Math.PI / 2 + 0.25);
    g.add(white, pupil);
  }

  // mast, yard, and a braced square sail
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 2.5, 7), flat(COL.woodDark));
  mast.position.set(0.05, 1.75, 0);
  mast.castShadow = true;
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 6), flat(COL.woodDark));
  yard.rotation.x = Math.PI / 2;
  yard.position.set(0.05, 2.72, 0);
  g.add(mast, yard);

  const sailGeo = new THREE.PlaneGeometry(1.5, 1.5, 8, 8);
  {
    const p = sailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const fx = p.getX(i) / 1.5 + 0.5, fy = p.getY(i) / 1.5 + 0.5;
      const belly = Math.sin(fx * Math.PI) * (0.42 - fy * 0.22);
      p.setZ(i, belly);
      p.setX(i, p.getX(i) * (0.82 + fy * 0.18));   // sail narrows toward the foot
    }
    sailGeo.computeVertexNormals();
  }
  const sail = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({
    map: sailTexture(colorHex), side: THREE.DoubleSide, flatShading: true }));
  sail.rotation.y = Math.PI / 2;
  sail.position.set(0.05, 1.92, 0);
  sail.castShadow = true;
  g.add(sail);

  // rigging: forestay, backstay, and two braces
  const line = (from, to) => {
    const d = to.clone().sub(from);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, d.length(), 3), flat(0x5a4a33));
    m.position.copy(from).add(d.multiplyScalar(0.5));
    m.lookAt(to);
    m.rotateX(Math.PI / 2);
    return m;
  };
  const masthead = new THREE.Vector3(0.05, 2.95, 0);
  g.add(line(masthead, new THREE.Vector3(1.82, 0.9, 0)));
  g.add(line(masthead, new THREE.Vector3(-1.68, 0.9, 0)));
  g.add(line(new THREE.Vector3(0.05, 2.72, 0.85), new THREE.Vector3(-0.6, 0.6, 0.5)));
  g.add(line(new THREE.Vector3(0.05, 2.72, -0.85), new THREE.Vector3(-0.6, 0.6, -0.5)));

  // steering oars on both stern quarters
  for (const side of [-1, 1]) {
    const oar = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), flat(COL.woodDark));
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.14), flat(COL.woodDark));
    blade.position.y = -0.5;
    oar.add(shaft, blade);
    oar.position.set(-1.35, 0.45, side * 0.42);
    oar.rotation.x = side * 0.35;
    oar.rotation.z = 0.25;
    g.add(oar);
  }

  const pennant = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18),
    flat(accent, { side: THREE.DoubleSide }));
  pennant.position.set(0.32, 3.05, 0);
  pennant.name = 'pennant';
  g.add(pennant);
  return g;
}

/* ── banners ────────────────────────────────────────────────────────────── */
function bannerTexture(title, sub, colorHex, dark = false) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 176;
  const ctx = c.getContext('2d');
  ctx.fillStyle = dark ? '#241f2b' : '#f6eed7';
  ctx.beginPath(); ctx.roundRect(8, 8, 496, 160, 20); ctx.fill();
  ctx.strokeStyle = colorHex; ctx.lineWidth = 6; ctx.stroke();
  ctx.fillStyle = dark ? '#ffd7c9' : colorHex;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 52px Georgia, serif';
  ctx.fillText(title, 256, 60);
  ctx.fillStyle = dark ? '#c9bfd4' : '#5a4a2f';
  ctx.font = 'italic 36px Georgia, serif';
  ctx.fillText(sub, 256, 124);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ── regions: the archipelago transforms as you sail north ──────────────── */
// the Safe Isles — one tropical home region; subtle palette drift by ring
const REGIONS = [
  { bands: [0, 1],
    palette: { grass: 0x5cb04b, grass2: 0x3d7d3a, sand: 0xeadfae }, flora: 'palm' },
  { bands: [2],
    palette: { grass: 0xa8b06b, grass2: 0x7d9455, sand: 0xf6efdc, rock: 0xdad5c8 },
    flora: 'olive' },
  { bands: [3],
    palette: { grass: 0x63985a, grass2: 0x40684a, sand: 0xdccf9f, rock: 0x8a8474 },
    flora: 'cypress' },
];
const regionFor = (band) => REGIONS.find((r) => r.bands.includes(band ?? 0)) || REGIONS[0];

function makeOlive(rng, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.14 * s, 0.9 * s, 5), flat(0x7a6248));
  trunk.position.y = 0.45 * s;
  trunk.rotation.z = (rng() - 0.5) * 0.35;
  g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const puff = new THREE.Mesh(
      displace(new THREE.IcosahedronGeometry((0.32 + rng() * 0.16) * s, 0), 0.06 * s, (seedFrom(rng))),
      flat(0x8fa05a));
    puff.position.set((rng() - 0.5) * 0.55 * s, (0.95 + rng() * 0.35) * s, (rng() - 0.5) * 0.55 * s);
    puff.castShadow = true;
    g.add(puff);
  }
  return g;
}

function makeDeadTree(rng, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07 * s, 0.15 * s, 1.6 * s, 5), flat(0x3e3630));
  trunk.position.y = 0.8 * s;
  trunk.rotation.z = (rng() - 0.5) * 0.25;
  g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * s, 0.05 * s, 0.9 * s, 4), flat(0x3e3630));
    br.position.set((rng() - 0.5) * 0.4 * s, (1.15 + rng() * 0.55) * s, (rng() - 0.5) * 0.4 * s);
    br.rotation.set((rng() - 0.5) * 1.5, rng() * 6.28, 0.5 + rng() * 0.8);
    g.add(br);
  }
  return g;
}

function seedFrom(rng) { return Math.floor(rng() * 1e9); }

function regionFlora(rng, region, s = 1) {
  if (region.flora === 'palm') return makePalm(rng, s);
  if (region.flora === 'olive') return makeOlive(rng, s);
  if (region.flora === 'dead') return makeDeadTree(rng, s);
  return makeCypress(rng, s);
}

/* scattered coast dressing so islands feel dense and hand-made */
function dressIsland(g, rng, region, R, terrain) {
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.28;
    const rr = 0.55 + rng() * 0.3;
    const y = terrain.heightAt(rr);
    if (y < 0.15) continue;
    if (rng() < 0.6) {
      const f = regionFlora(rng, region, 0.6 + rng() * 0.5);
      f.position.set(Math.cos(a) * R * rr, y, Math.sin(a) * R * rr);
      g.add(f);
    } else {
      const rk = makeRock(rng, 0.3 + rng() * 0.4, region.palette.rock ?? COL.rock);
      rk.position.set(Math.cos(a) * R * rr, y + 0.1, Math.sin(a) * R * rr);
      g.add(rk);
    }
  }
  if (region.ember) {
    const ember = new THREE.Mesh(
      displace(new THREE.IcosahedronGeometry(0.4, 0), 0.12, seedFrom(rng)),
      new THREE.MeshStandardMaterial({ color: 0x2c2430, flatShading: true,
        emissive: 0xff4f26, emissiveIntensity: 0.85 }));
    const a = rng() * 6.28;
    ember.position.set(Math.cos(a) * R * 0.5, terrain.heightAt(0.5) + 0.2, Math.sin(a) * R * 0.5);
    g.add(ember);
  }
}

/* ── island assembly (keyed by view state) ──────────────────────────────── */
const ISLE_R = { home: 13.0, shrine: 10.0, puzzle: 10.0, haven: 11.0,
                 shop: 10.0, monster: 11.0, lair: 13.0, pharos: 17.0, sea: 1.5 };

function viewKey(node) {
  return [node.type, node.monster ? node.monster.hp : '-',
          node.charges ?? '-', node.solved ?? '-', node.relic_taken ?? '-',
          node.flotsam ?? '-'].join(':');
}

function buildIsland(node, domains) {
  const g = new THREE.Group();
  const seed = hashStr(node.id);
  const rng0 = mulberry32(seed + 7);
  const R = (ISLE_R[node.type] ?? 4.8) * (node.type === 'sea' ? 1 : 0.88 + rng0() * 0.35);
  const region = regionFor(node.band);
  let terrain;

  if (node.type === 'sea') {
    // open-water stops come in flavors: cargo, buoys, rocks, tiny islets, ripples
    if (node.flotsam) {
      const fl = makeFlotsam(rng0);
      fl.scale.setScalar(1.6);
      g.add(fl);
    } else if (node.look === 'rocks') {
      for (let i = 0; i < 2 + Math.floor(rng0() * 2); i++) {
        const rk = makeRock(rng0, 0.9 + rng0() * 1.1, rng0() < 0.4 ? 0xd8d4c8 : COL.rock);
        const a = rng0() * 6.28;
        rk.position.set(Math.cos(a) * rng0() * 2.4, 0.35, Math.sin(a) * rng0() * 2.4);
        g.add(rk);
      }
      g.add(shallowDisc(15));
    } else if (node.look === 'islet') {
      const style = rng0();
      const t = makeTerrain({
        seed, R: 4.6 + rng0() * 2.6,
        H: style < 0.33 ? 0.8 : 1.1,
        mode: style < 0.33 ? 'atoll' : 'hill',
        lobes: style > 0.66 ? 0.42 : 0,
        palette: { ...region.palette, ...(rng0() < 0.5 ? { sand: 0xf7ecc8 } : {}) },
      });
      g.add(t.mesh);
      g.add(shallowDisc(22));
      const flora = regionFlora(rng0, region, 1.0);
      const fr = style < 0.33 ? 0.3 : 0.15;      // atolls grow on the ring
      flora.position.set(t.heightAt(fr) ? 0.8 : 0, Math.max(0.3, t.heightAt(fr)), 0);
      g.add(flora);
    } else if (node.look === 'none') {
      const ripple = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.5, 24),
        new THREE.MeshBasicMaterial({ color: 0xeafcff, transparent: true, opacity: 0.28,
          side: THREE.DoubleSide, depthWrite: false }));
      ripple.rotation.x = -Math.PI / 2;
      ripple.position.y = 0.06;
      ripple.name = 'foam';
      g.add(ripple);
    } else {
      const buoy = makeBuoy(rng0);
      buoy.scale.setScalar(1.7);
      g.add(buoy);
    }
    g.position.set(node.x, 0, node.z);
    return { group: g, R: node.look === 'islet' ? 5.2 : node.look === 'rocks' ? 3.6 : R, plateauY: 0 };
  } else if (node.type === 'home') {
    terrain = makeTerrain({ seed, R, H: 1.7, mode: 'mesa', palette: { ...region.palette } });
    const dock = makeDock(6.0);
    dock.position.set(1.2, 0.4, R * 0.72);
    dock.rotation.y = Math.PI;
    g.add(dock);
    const lh = makeLighthouse();
    lh.position.set(-R * 0.38, terrain.heightAt(0.38), -R * 0.15);
    g.add(lh);
    for (const a of [2.6, 3.6]) {
      const palm = makePalm(rng0, 1.1);
      palm.position.set(Math.cos(a) * R * 0.6, terrain.heightAt(0.6), Math.sin(a) * R * 0.6);
      g.add(palm);
    }
  } else if (node.type === 'shrine') {
    const hex = DOMAIN_COLORS[node.domain] || '#d9a441';
    terrain = makeTerrain({ seed, R, H: 2.2, mode: 'mesa', palette: { ...region.palette } });
    const spent = (node.charges ?? 0) <= 0;
    const shrine = makeShrine(hex);
    shrine.position.y = terrain.heightAt(0);
    if (spent) shrine.traverse((o) => { if (o.material?.color) o.material = o.material.clone(), o.material.color.multiplyScalar(0.6); });
    g.add(shrine);
    const cy = regionFlora(rng0, region, 1.0);
    cy.position.set(R * 0.45, terrain.heightAt(0.45), R * 0.2);
    g.add(cy);
  } else if (node.type === 'puzzle') {
    terrain = makeTerrain({ seed, R, H: 2.4, mode: 'mesa',
      palette: { ...region.palette, grass: 0x6fae8f } });
    const ob = makeObelisk();
    ob.position.y = terrain.heightAt(0);
    if (node.solved) ob.children.forEach((ch) => { if (ch.isPointLight) ch.intensity = 0; });
    g.add(ob);
    const rk = makeRock(rng0, 0.5, 0x8d94b8);
    rk.position.set(-R * 0.4, terrain.heightAt(0.4) + 0.2, R * 0.3);
    g.add(rk);
  } else if (node.type === 'haven') {
    terrain = makeTerrain({ seed, R, H: 1.8, mode: 'flat', palette: { ...region.palette } });
    const t = makeTents(rng0);
    t.position.y = terrain.heightAt(0.2);
    g.add(t);
    const dock = makeDock(3.8);
    dock.position.set(0.5, 0.4, R * 0.8);
    dock.rotation.y = Math.PI;
    g.add(dock);
    const palm = regionFlora(rng0, region, 1.0);
    palm.position.set(-R * 0.5, terrain.heightAt(0.5), -R * 0.2);
    g.add(palm);
  } else if (node.type === 'monster' || node.type === 'lair') {
    const dark = node.type === 'lair';
    terrain = makeTerrain({ seed, R, H: dark ? 3.4 : 2.6, mode: 'peak',
      palette: dark
        ? { grass: 0x74875e, grass2: 0x5a7050, rock: COL.basalt, sand: 0xcbb489 }
        : { ...region.palette } });
    if (node.monster) {
      const beast = makeMonster(rng0, node.monster);
      beast.position.y = terrain.heightAt(0.25) + 0.55;   // clear of the slope
      beast.position.x = R * 0.1;
      g.add(beast);
    } else if (node.type === 'monster') {
      // calm hunting grounds: a bone-stake warning that ambushes happen here
      const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 2.4, 6), flat(COL.woodDark));
      stake.position.set(R * 0.1, terrain.heightAt(0.25) + 1.1, 0);
      const skull = new THREE.Mesh(displace(new THREE.SphereGeometry(0.34, 8, 6), 0.07, seed + 9), flat(0xe8e2d2));
      skull.position.set(R * 0.1, terrain.heightAt(0.25) + 2.4, 0);
      g.add(stake, skull);
      for (const side of [-1, 1]) {
        const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 5), flat(0xe8e2d2));
        bone.position.set(R * 0.1, terrain.heightAt(0.25) + 1.7, 0.05);
        bone.rotation.z = side * 0.8;
        g.add(bone);
      }
    }
    if (node.type === 'lair' && !node.relic_taken) {
      const beacon = makeRelicBeacon();
      beacon.position.set(-R * 0.3, terrain.heightAt(0.35), -R * 0.25);
      g.add(beacon);
    }
    for (let i = 0; i < 3; i++) {
      const rk = makeRock(rng0, 0.4 + rng0() * 0.4, dark ? COL.basalt : COL.rock);
      const a = rng0() * 6.28;
      rk.position.set(Math.cos(a) * R * 0.7, terrain.heightAt(0.7) + 0.15, Math.sin(a) * R * 0.7);
      g.add(rk);
    }
  } else if (node.type === 'pharos') {
    terrain = makeTerrain({ seed, R, H: 3.0, mode: 'mesa',
      palette: { grass: 0xdfd9c6, grass2: 0xcfc7b2, sand: 0xf6efdc, rock: 0xe8e2d2 } });
    const ph = makePharos();
    ph.position.y = terrain.heightAt(0);
    g.add(ph);
    for (const a of [0.6, 1.9, 3.2, 4.5, 5.8]) {
      const c = makeColumn(1.6, 0.14);
      c.position.set(Math.cos(a) * R * 0.72, terrain.heightAt(0.72), Math.sin(a) * R * 0.72);
      g.add(c);
    }
  } else if (node.type === 'shop') {
    terrain = makeTerrain({ seed, R, H: 1.6, mode: 'flat', palette: { ...region.palette } });
    const stall = makeMarket(rng0);
    stall.position.y = terrain.heightAt(0.15);
    g.add(stall);
    const dock = makeDock(4.4);
    dock.position.set(0.8, 0.4, R * 0.86);
    dock.rotation.y = Math.PI;
    g.add(dock);
    const fl = regionFlora(rng0, region, 1.0);
    fl.position.set(-R * 0.45, terrain.heightAt(0.45), -R * 0.25);
    g.add(fl);
  } else {
    terrain = makeTerrain({ seed, R, H: 2.0, mode: 'hill', palette: { ...region.palette } });
  }

  if (node.type !== 'pharos') dressIsland(g, rng0, region, R, terrain);

  {
    g.add(terrain.mesh);
    g.add(shallowDisc(R * 4.0));
    const foam = new THREE.Mesh(
      new THREE.RingGeometry(R * 1.06, R * 1.3, 36),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    foam.rotation.x = -Math.PI / 2;
    foam.position.y = 0.03;
    foam.name = 'foam';
    g.add(foam);
  }
  g.position.set(node.x, 0, node.z);
  return { group: g, R, plateauY: terrain.heightAt(0) };
}

function bannerFor(node, domains) {
  if (node.type === 'shrine' && (node.charges ?? 0) > 0) {
    const info = domains[node.domain];
    return bannerTexture(node.name || info?.name || '?',
      `${info?.field || ''} · ${'✦'.repeat(node.charges)}`,
      DOMAIN_COLORS[node.domain]);
  }
  if (node.type === 'lair' && node.monster) {
    return bannerTexture(node.monster.name, `👑 boss · relic of ${node.name || '?'}`, '#c0392b', true);
  }
  if (node.type === 'monster') {
    return node.monster
      ? bannerTexture(node.monster.name, `ambush at ${node.name || '?'}`, '#c0392b', true)
      : bannerTexture(node.name || 'Hunting Grounds', '⚔ chance of ambush', '#b1543a', true);
  }
  if (node.type === 'pharos') {
    return bannerTexture('THE PHAROS', node.monster ? 'bank 3 seals to enter' : '', '#d9a441');
  }
  if (node.type === 'shop') {
    return bannerTexture(node.name || 'Market', '🪙 charms & fittings', '#c9a227');
  }
  if (node.type === 'haven') return bannerTexture(node.name || 'Haven', '⚓ repairs & shipwright', '#2e9e8f');
  if (node.type === 'puzzle' && !node.solved) return bannerTexture(node.name || 'Puzzle Isle', '🧩 upgrades await', '#7d5ba6');
  if (node.type === 'home') return bannerTexture('Home Port', 'bank relics here', '#2d5bb9');
  return null;
}

/* floating name tag above a captain's ship — units must read at a glance */
function nameSprite(name, colorHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 30px Georgia, serif';
  const w = Math.min(244, ctx.measureText(name).width + 30);
  ctx.fillStyle = 'rgba(22,17,30,0.78)';
  ctx.beginPath(); ctx.roundRect(128 - w / 2, 8, w, 48, 14); ctx.fill();
  ctx.strokeStyle = colorHex; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#f6efdc';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, fog: false, depthTest: false }));
  sp.scale.set(5.6, 1.4, 1);
  sp.position.y = 4.7;
  sp.renderOrder = 8;
  sp.name = 'nametag';
  return sp;
}

/* ── the world ──────────────────────────────────────────────────────────── */
export function createWorld(container, onIslandClick) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd6ecf5, 420, 2000);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 6000);
  camera.position.set(0, 46, 240);              // re-anchored to home on board load

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = 1.26;
  controls.minDistance = 16;
  controls.maxDistance = 950;                   // zoom out to the storm wall, not past it
  controls.enablePan = false;                   // the camera belongs to your boat
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.target.set(0, 1.5, -10);

  const sky = makeSky();
  scene.add(sky);
  scene.add(new THREE.HemisphereLight(0xd6ecff, 0x3e7d5a, 0.85));
  const sunPos = new THREE.Vector3(300, 420, 150);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.75);
  sun.position.copy(sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -640; sun.shadow.camera.right = 640;
  sun.shadow.camera.top = 640; sun.shadow.camera.bottom = -640;
  sun.shadow.camera.far = 1800;
  sun.shadow.bias = -0.0004;
  sun.target.position.set(0, 0, 0);             // the Pharos at world center
  scene.add(sun.target);
  scene.add(sun);
  const glow = makeSunGlow();
  glow.scale.set(240, 240, 1);
  glow.position.copy(sunPos.clone().normalize().multiplyScalar(2400));
  scene.add(glow);

  const water = makeWater(sunPos);
  scene.add(water);

  const clouds = [];
  for (let i = 0; i < 14; i++) {
    const cl = makeCloud(0.9 + Math.random() * 1.6);
    cl.userData = { a: Math.random() * Math.PI * 2, r: 200 + Math.random() * 480 };
    cl.position.y = 80 + Math.random() * 80;
    clouds.push(cl);
    scene.add(cl);
  }
  // low sea haze drifting over the water
  const mists = [];
  for (let i = 0; i < 10; i++) {
    const m = cloudSprite(TEX_MIST, 70 + Math.random() * 90, 0.12 + Math.random() * 0.08);
    m.position.set(-500 + Math.random() * 1000, 3 + Math.random() * 4,
                   -500 + Math.random() * 1000);
    m.userData = { vx: (Math.random() - 0.5) * 0.9, vz: (Math.random() - 0.5) * 0.9 };
    mists.push(m);
    scene.add(m);
  }

  // the storm wall — a ring of boiling dark cloud that seals the region
  const WALL_R = 640;
  const storm = new THREE.Group();
  const stormMats = [];
  {
    const shell = (geo, opts) => {
      const m = stormWallMaterial(opts);
      stormMats.push(m);
      const mesh = new THREE.Mesh(geo, m);
      mesh.renderOrder = 3;
      storm.add(mesh);
      return mesh;
    };
    // the CORE: fully opaque — no sky, no sun, no light passes through
    const core = shell(new THREE.CylinderGeometry(WALL_R + 8, WALL_R + 20, 380, 160, 40, true),
      { op: 1.0, scale: 0.011, drift: 0.8, cA: 0x191722, cB: 0x59536a,
        h0: -40, h1: 330, solid: 1 });
    core.position.y = 160;
    core.renderOrder = 2;
    // outer rampart — tall, dense, slightly flared
    shell(new THREE.CylinderGeometry(WALL_R + 30, WALL_R + 55, 340, 160, 30, true),
      { op: 1.0, scale: 0.0105, drift: 1.0, cA: 0x1f1c2a, cB: 0x6e6880,
        h0: -30, h1: 300 }).position.y = 135;
    // inner face — lighter, counter-drifting for parallax depth
    shell(new THREE.CylinderGeometry(WALL_R - 45, WALL_R - 20, 260, 150, 26, true),
      { op: 0.6, scale: 0.016, drift: -1.5, cA: 0x363240, cB: 0x8d8799,
        h0: -20, h1: 235 }).position.y = 112;
    // the roll cloud grinding along the sea at the wall's foot
    const roll = shell(new THREE.TorusGeometry(WALL_R - 30, 58, 16, 120),
      { op: 0.92, scale: 0.02, drift: 0.7, cA: 0x2b2836, cB: 0x7b7488,
        h0: -40, h1: 85 });
    roll.rotation.x = Math.PI / 2;
    roll.position.y = 12;
  }
  scene.add(storm);
  // lightning inside the wall
  const lightning = new THREE.PointLight(0xcfe0ff, 0, 900, 1.1);
  scene.add(lightning);
  const SKY_DAY = { zenith: new THREE.Color(0x5fb0e6), mid: new THREE.Color(0xa5d9ef),
                    horizon: new THREE.Color(0xfdeed3) };
  const SKY_STORM = { zenith: new THREE.Color(0x3f4456), mid: new THREE.Color(0x5c6070),
                      horizon: new THREE.Color(0x8a8494) };
  const FOG_DAY = new THREE.Color(0xd6ecf5);
  const FOG_STORM = new THREE.Color(0x767283);
  let stormF = 0;

  const birds = [];
  for (let i = 0; i < 6; i++) {
    const bird = new THREE.Group();
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28),
        flat(0xffffff, { side: THREE.DoubleSide }));
      wing.position.x = s * 0.45;
      wing.userData.side = s;
      bird.add(wing);
    }
    bird.userData = { r: 60 + Math.random() * 200, h: 24 + Math.random() * 24,
                      speed: 0.05 + Math.random() * 0.08, phase: Math.random() * 6.28,
                      flap: 4 + Math.random() * 3 };
    birds.push(bird);
    scene.add(bird);
  }

  // dolphin pods porpoising through open water — the sea should feel lived-in
  const dolphinPods = [];
  for (let i = 0; i < 6; i++) {
    const pod = new THREE.Group();
    const n = 2 + Math.floor(Math.random() * 2);
    for (let j = 0; j < n; j++) {
      const d = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.0, 3, 6), flat(0x3d6b7d));
      body.rotation.x = Math.PI / 2;
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.32, 4), flat(0x2f4e5c));
      fin.position.y = 0.3;
      d.add(body, fin);
      d.userData = { off: j * 1.9 };
      pod.add(d);
    }
    pod.userData = { cx: -420 + Math.random() * 840, cz: -420 + Math.random() * 840,
                     r: 16 + Math.random() * 26, speed: 0.09 + Math.random() * 0.07,
                     ph: Math.random() * 6.28 };
    dolphinPods.push(pod);
    scene.add(pod);
  }

  // dynamic board state
  const islands = {};      // id → {key, group, proxy, R}
  let nbrs = {};           // id → [ids] (for sail-path routing)
  let nodeMeta = {};       // id → {x, z, type, blocked}
  const banners = {};      // id → {key, sprite}
  const ships = {};        // pid → {group, target, idx, phase, anim}
  const traders = [];      // neutral NPC ships drifting the lanes (set dressing)
  let laneGroup = new THREE.Group();
  let laneKey = '';
  let boardSig = '';
  const highlights = new THREE.Group();
  scene.add(highlights, laneGroup);

  // camera choreography: glide targets, battle focus, home anchor
  let glideTo = null;                 // Vector3 the view is drifting toward
  let battleFocus = null;             // { node } while a fight is on
  let savedView = null;               // camera state to restore after battle
  let cameraAnchored = false;
  let lastFollowPid = null;
  let followShip = null;              // pid whose sailing ship the camera tracks
  let myPid = null;                   // the viewer's own captain

  /* ── the battle arena: a Paper-Mario stage far off the chart ───────────── */
  const ARENA = new THREE.Vector3(1500, 0, 420);
  const arena = { group: null, key: null, ship: null, slots: [], anims: [] };

  function buildArenaSet() {
    const g = new THREE.Group();
    g.position.copy(ARENA);
    // backdrop sandbar with palms, the "stage"
    const bar = makeTerrain({ seed: 77, R: 15, H: 1.6, mode: 'flat',
      palette: { sand: 0xf7ecc8 } });
    bar.mesh.position.set(6, 0, -14);
    g.add(bar.mesh);
    const rngA = mulberry32(99);
    for (const [x, z, s] of [[-2, -16, 1.3], [9, -18, 1.1], [16, -12, 1.2]]) {
      const palm = makePalm(rngA, s);
      palm.position.set(x, 1.4, z);
      g.add(palm);
    }
    for (const [x, z] of [[-14, -8], [20, -4]]) {
      const rk = makeRock(rngA, 1.2);
      rk.position.set(x, 0.3, z);
      g.add(rk);
    }
    // the combat shoal: solid ground under the enemy line
    const shoal = makeTerrain({ seed: 88, R: 14, H: 0.9, mode: 'flat',
      palette: { sand: 0xf2e4bb } });
    shoal.mesh.position.set(10, 0, 1);
    g.add(shoal.mesh);
    g.add(shallowDisc(70));
    const light = new THREE.DirectionalLight(0xfff1d6, 0.9);
    light.position.set(-20, 30, 20);
    g.add(light);
    scene.add(g);
    return g;
  }

  function syncArena(room) {
    const b = room.battle;
    if (!b) {
      if (arena.group) arena.group.visible = false;
      arena.key = null;
      return;
    }
    if (!arena.group) {
      arena.group = buildArenaSet();
      arena.stage = new THREE.Group();
      arena.group.add(arena.stage);
    }
    arena.group.visible = true;
    const fighter = room.players.find((p) => p.pid === room.turn);
    const key = b.node + ':' + b.enemies.map((e) => e.name).join('|') + ':' + (fighter?.pid || '');
    if (arena.key !== key) {
      arena.key = key;
      arena.stage.clear();
      arena.slots = [];
      arena.anims = [];
      const ship = makeShip(fighter?.color || '#e4572e');
      ship.position.set(-10, 0, 2);
      ship.rotation.y = -0.4;                    // quarter view: sail + prow both read
      ship.scale.setScalar(1.4);
      arena.stage.add(ship);
      arena.ship = ship;
      b.enemies.forEach((e, i) => {
        const model = makeEnemy(e.name, e.max_hp);
        const home = new THREE.Vector3(5.5 + i * 4.8, 0.82, -0.5 + (i % 2) * 3);
        model.position.copy(home);
        model.rotation.y = -Math.PI / 2;         // face the ship
        model.scale.setScalar(1.45);
        arena.stage.add(model);
        arena.slots.push({ model, home, dead: false, phase: Math.random() * 6 });
      });
    }
    // deaths: sink models whose hp hit zero
    b.enemies.forEach((e, i) => {
      const slot = arena.slots[i];
      if (slot && e.hp <= 0 && !slot.dead) {
        slot.dead = true;
        slot.dying = performance.now();
      }
    });
  }

  /** app-triggered battle beats: lunges, hits, misses */
  function arenaPlay(kind, payload = {}) {
    if (!arena.group) return;
    const now = performance.now();
    if (kind === 'enemy_attack' || kind === 'enemy_miss') {
      const idx = arena.slots.findIndex((s) => !s.dead);
      if (idx >= 0) arena.anims.push({ kind, idx, t0: now, dur: 1100 });
    } else if (kind === 'player_hit') {
      arena.anims.push({ kind: 'ship_lunge', t0: now, dur: 900 });
      const slot = arena.slots[payload.idx];
      if (slot) arena.anims.push({ kind: 'flinch', idx: payload.idx, t0: now + 450, dur: 500 });
    } else if (kind === 'backfire') {
      arena.anims.push({ kind: 'ship_flash', t0: now, dur: 600 });
    }
  }

  function tickArena(t) {
    if (!arena.group || !arena.group.visible) return;
    for (const slot of arena.slots) {
      const m = slot.model;
      if (slot.dead) {
        const k = Math.min(1, (performance.now() - slot.dying) / 900);
        m.scale.setScalar(Math.max(0.001, 1 - k));
        m.position.y = slot.home.y - k * 1.5;
        continue;
      }
      m.position.y = slot.home.y + (m.userData.float ? 0.5 : 0) +
        Math.sin(t * 2 + slot.phase) * 0.12;
      const wl = m.getObjectByName('wingL'), wr = m.getObjectByName('wingR');
      if (wl) { wl.rotation.z = 0.3 + Math.sin(t * 6 + slot.phase) * 0.35; }
      if (wr) { wr.rotation.z = -0.3 - Math.sin(t * 6 + slot.phase) * 0.35; }
    }
    if (arena.ship) {
      arena.ship.position.y = Math.sin(t * 1.8) * 0.12;
      arena.ship.rotation.z = Math.sin(t * 1.3) * 0.03;
    }
    const now = performance.now();
    arena.anims = arena.anims.filter((a) => now - a.t0 < a.dur + 50);
    for (const a of arena.anims) {
      const k = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
      const arc = Math.sin(k * Math.PI);
      if ((a.kind === 'enemy_attack' || a.kind === 'enemy_miss') && arena.slots[a.idx]) {
        const slot = arena.slots[a.idx];
        const toward = a.kind === 'enemy_attack' ? 1 : 1.25;   // a miss overshoots
        slot.model.position.x = slot.home.x + (arena.ship.position.x + 3 - slot.home.x) * arc * toward * 0.9;
        slot.model.position.z = slot.home.z + (2 - slot.home.z) * arc * 0.9;
      } else if (a.kind === 'ship_lunge' && arena.ship) {
        arena.ship.position.x = -10 + arc * 6;
      } else if (a.kind === 'flinch' && arena.slots[a.idx]) {
        arena.slots[a.idx].model.rotation.z = Math.sin(k * Math.PI * 3) * 0.25;
      } else if (a.kind === 'ship_flash' && arena.ship) {
        arena.ship.rotation.z = Math.sin(k * Math.PI * 4) * 0.12;
      }
    }
  }

  function anchorToHome() {
    const home = islands.home;
    if (!home || cameraAnchored) return;
    cameraAnchored = true;
    const hp = home.group.position;
    controls.target.set(hp.x, 1.5, hp.z - 6);
    camera.position.set(hp.x, 42, hp.z + 36);
  }

  function setBattleFocus(nodeId) {
    if (nodeId && (!battleFocus || battleFocus.node !== nodeId)) {
      if (!savedView) {
        savedView = { pos: camera.position.clone(), target: controls.target.clone() };
      }
      battleFocus = { node: nodeId };
      controls.enabled = false;
      glideTo = null;
    } else if (!nodeId && battleFocus) {
      battleFocus = null;
      controls.enabled = true;
      if (savedView) {
        camera.position.copy(savedView.pos);
        controls.target.copy(savedView.target);
        savedView = null;
      }
    }
  }

  function clearBoard() {
    for (const tr of traders.splice(0)) scene.remove(tr.group);
    for (const id of Object.keys(islands)) {
      scene.remove(islands[id].group);
      scene.remove(islands[id].proxy);
      delete islands[id];
    }
    for (const id of Object.keys(banners)) {
      scene.remove(banners[id].sprite);
      delete banners[id];
    }
    scene.remove(laneGroup);
    laneGroup = new THREE.Group();
    scene.add(laneGroup);
    laneKey = '';
  }

  function syncBoard(room) {
    const nodes = room.board.nodes || [];
    nodeMeta = {};
    for (const n of nodes) {
      nodeMeta[n.id] = { x: n.x, z: n.z, type: n.type,
                         blocked: n.type === 'pharos' ||
                                  (n.type === 'lair' && !!n.monster) };
    }
    nbrs = {};
    for (const [a, b] of room.board.edges || []) {
      (nbrs[a] = nbrs[a] || []).push(b);
      (nbrs[b] = nbrs[b] || []).push(a);
    }
    const sig = nodes.length && nodes.map((n) => n.id).sort().join(',').slice(0, 40) +
                `:${nodes[0]?.x},${nodes[0]?.z}`;
    const homeNode = nodes.find((n) => n.id === 'home');
    const fullSig = `${homeNode?.x},${homeNode?.z}:${room.code}`;
    if (boardSig && boardSig !== fullSig) clearBoard();     // new sea (rematch)
    boardSig = fullSig;

    const present = new Set();
    for (const node of nodes) {
      present.add(node.id);
      const key = viewKey(node);
      const existing = islands[node.id];
      if (!existing || existing.key !== key) {
        if (existing) {
          scene.remove(existing.group);
          scene.remove(existing.proxy);
        }
        const { group, R } = buildIsland(node, room.board.domains);
        const proxy = new THREE.Mesh(new THREE.CylinderGeometry(R + 2.0, R + 2.0, 9, 8),
          new THREE.MeshBasicMaterial({ visible: false }));
        proxy.position.set(node.x, 3, node.z);
        proxy.userData.node = node.id;
        scene.add(group, proxy);
        islands[node.id] = { key, group, proxy, R };
      }
      // banner
      const wantTex = bannerFor(node, room.board.domains);
      const bkey = wantTex ? key : null;
      const existing_b = banners[node.id];
      if (existing_b && existing_b.key !== bkey) {
        scene.remove(existing_b.sprite);
        delete banners[node.id];
      }
      if (wantTex && (!banners[node.id])) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: wantTex, transparent: true, fog: false }));
        sp.scale.set(8.2, 2.8, 1);
        sp.position.set(node.x, 8.6, node.z);
        scene.add(sp);
        banners[node.id] = { key: bkey, sprite: sp };
      }
    }
    // islands that fell out of view (shouldn't happen mid-game, but rematch safety)
    for (const id of Object.keys(islands)) {
      if (!present.has(id)) {
        scene.remove(islands[id].group);
        scene.remove(islands[id].proxy);
        delete islands[id];
        if (banners[id]) { scene.remove(banners[id].sprite); delete banners[id]; }
      }
    }
    // lanes
    const ekey = (room.board.edges || []).map((e) => e.join('~')).join('|');
    if (ekey !== laneKey) {
      laneKey = ekey;
      scene.remove(laneGroup);
      laneGroup = new THREE.Group();
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
      for (const [a, b] of room.board.edges || []) {
        const na = byId[a], nb = byId[b];
        if (!na || !nb) continue;
        const pa = new THREE.Vector3(na.x, 0.16, na.z);
        const pb = new THREE.Vector3(nb.x, 0.16, nb.z);
        const dir = pb.clone().sub(pa);
        const len = dir.length();
        dir.normalize();
        const gapA = (islands[a]?.R ?? 5) * 1.3, gapB = (islands[b]?.R ?? 5) * 1.3;
        if (len < gapA + gapB + 2) continue;
        const pts = [pa.clone().addScaledVector(dir, gapA),
                     pa.clone().addScaledVector(dir, len - gapB)];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({
          color: 0xffffff, transparent: true, opacity: 0.4, dashSize: 2.0, gapSize: 2.8 });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        laneGroup.add(line);
      }
      scene.add(laneGroup);
    }
  }

  /** shortest lane path a ship can actually sail (visual routing) */
  function sailPath(from, to) {
    if (!nbrs[from] || !nbrs[to]) return null;
    const prev = { [from]: null };
    const dq = [from];
    while (dq.length) {
      const cur = dq.shift();
      if (cur === to) break;
      for (const nb of nbrs[cur] || []) {
        if (nb in prev) continue;
        if (nb !== to && nodeMeta[nb]?.blocked) continue;   // no cutting past monsters
        prev[nb] = cur;
        dq.push(nb);
      }
    }
    if (!(to in prev)) return null;
    const path = [];
    for (let cur = to; cur !== null; cur = prev[cur]) path.unshift(cur);
    return path;
  }

  function slotFor(nodeId, slotIdx) {
    const isle = islands[nodeId];
    const node = isle ? isle.group.position : new THREE.Vector3();
    const a = (slotIdx / 6) * Math.PI * 2 + 0.8;
    const r = (isle?.R ?? 5) * 1.55 + 1.2;
    return new THREE.Vector3(node.x + Math.cos(a) * r, 0, node.z + Math.sin(a) * r);
  }

  /* neutral traders: little grey-sailed merchantmen forever working the lanes */
  function ensureTraders() {
    if (traders.length || Object.keys(nodeMeta).length < 20) return;
    const ids = Object.keys(nodeMeta).filter((id) => !nodeMeta[id].blocked);
    for (let i = 0; i < 3; i++) {
      const g = makeShip('#9aa3ad');
      g.scale.setScalar(1.15);
      const at = ids[Math.floor(Math.random() * ids.length)];
      g.position.set(nodeMeta[at].x, 0, nodeMeta[at].z);
      scene.add(g);
      traders.push({ group: g, at, prev: null, anim: null });
    }
  }

  function traderPoint(nid, fromPos) {
    // aim beside islands, not through their peaks
    const meta = nodeMeta[nid];
    const p = new THREE.Vector3(meta.x, 0, meta.z);
    if (meta.type !== 'sea') {
      const r = (islands[nid]?.R ?? 8) * 1.25 + 3.5;
      const dir = p.clone().sub(fromPos).normalize();
      p.add(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(r));
    }
    return p;
  }

  function tickTraders(now) {
    for (const tr of traders) {
      if (!tr.anim) {
        const all = (nbrs[tr.at] || []).filter((nb) => nodeMeta[nb]);
        const opts = all.filter((nb) => !nodeMeta[nb].blocked && nb !== tr.prev);
        const pool = opts.length ? opts : all;
        if (!pool.length) continue;
        const next = pool[Math.floor(Math.random() * pool.length)];
        const from = tr.group.position.clone();
        const to = traderPoint(next, from);
        tr.anim = { from, to, t0: now, dur: 2000 + from.distanceTo(to) * 160 };
        tr.prev = tr.at;
        tr.at = next;
      } else {
        const k = (now - tr.anim.t0) / tr.anim.dur;
        if (k >= 1) { tr.group.position.copy(tr.anim.to); tr.anim = null; continue; }
        const pos = tr.anim.from.clone().lerp(tr.anim.to, k);
        pos.y = Math.sin(now * 0.0021 + tr.anim.dur) * 0.09;
        tr.group.position.copy(pos);
        const dir = tr.anim.to.clone().sub(tr.anim.from);
        const want = Math.atan2(dir.x, dir.z);
        let dd = want - tr.group.rotation.y;
        while (dd > Math.PI) dd -= Math.PI * 2;
        while (dd < -Math.PI) dd += Math.PI * 2;
        tr.group.rotation.y += dd * 0.06;
      }
    }
  }

  function update(room, you) {
    myPid = you;
    syncBoard(room);
    ensureTraders();
    syncArena(room);
    anchorToHome();
    controls.autoRotate = room.phase === 'lobby' && !battleFocus;

    // glide the view to whoever's turn is starting (unless a battle owns the camera)
    if (!battleFocus && room.phase === 'roll' && room.turn && room.turn !== lastFollowPid) {
      lastFollowPid = room.turn;
      const p = room.players.find((x) => x.pid === room.turn);
      const isle = p && islands[p.node];
      if (isle) glideTo = isle.group.position.clone().setY(1.5);
    }

    const playersByPid = Object.fromEntries(room.players.map((p) => [p.pid, p]));
    room.players.forEach((p, idx) => {
      if (!ships[p.pid]) {
        const group = makeShip(p.color);
        group.scale.setScalar(2);                 // doubled world, doubled boats
        const tag = nameSprite(p.name, p.color);
        tag.scale.set(4.4, 1.1, 1);
        group.add(tag);
        group.position.copy(slotFor(p.node, idx));
        scene.add(group);
        ships[p.pid] = { group, target: p.node, idx, phase: Math.random() * 6, anim: null };
      }
      const sh = ships[p.pid];
      sh.idx = idx;
      if (sh.target !== p.node) {
        // sail the actual lanes: build a polyline through the route's nodes
        const route = sailPath(sh.target, p.node);
        const pts = [sh.group.position.clone()];
        if (route && route.length > 2) {
          for (const nid of route.slice(1, -1)) {
            if (nodeMeta[nid]) pts.push(traderPoint(nid, pts[pts.length - 1]));
          }
        }
        pts.push(slotFor(p.node, idx));
        let total = 0;
        const legs = [];
        for (let i = 1; i < pts.length; i++) {
          const len = pts[i].distanceTo(pts[i - 1]);
          legs.push(len);
          total += len;
        }
        sh.anim = { pts, legs, total, t0: performance.now(),
                    dur: Math.min(5200, 500 + total * 26) };
        sh.target = p.node;
        if (p.pid === room.turn && !battleFocus) followShip = p.pid;
      }
    });
    for (const pid of Object.keys(ships)) {
      if (!playersByPid[pid]) { scene.remove(ships[pid].group); delete ships[pid]; }
    }

    highlights.clear();
    const myTurn = room.turn === you && room.phase === 'sail';
    if (myTurn) {
      for (const nid of Object.keys(room.reachable || {})) {
        const R = islands[nid]?.R ?? 5;
        const ring = new THREE.Mesh(new THREE.RingGeometry(R * 1.34, R * 1.52, 40),
          new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(islands[nid]?.group.position.x ?? 0, 0.35, islands[nid]?.group.position.z ?? 0);
        ring.renderOrder = 5;
        highlights.add(ring);
      }
    }

    const turnPid = room.turn;
    for (const [pid, sh] of Object.entries(ships)) {
      let marker = sh.group.getObjectByName('turnMarker');
      if (pid === turnPid && room.phase !== 'lobby' && room.phase !== 'finished') {
        if (!marker) {
          marker = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.75, 6), flat(COL.gold, { emissive: 0x9a6a10 }));
          marker.name = 'turnMarker';
          marker.rotation.x = Math.PI;
          marker.position.y = 4.0;
          sh.group.add(marker);
        }
      } else if (marker) {
        sh.group.remove(marker);
      }
    }
  }

  /* clicking islands */
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 6) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(pointer, camera);
    const proxies = Object.values(islands).map((i) => i.proxy);
    const hit = ray.intersectObjects(proxies, false)[0];
    if (hit) onIslandClick(hit.object.userData.node);
  });

  /* render loop */
  const clock = new THREE.Clock();
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    water.material.uniforms.t.value = t;
    for (const cl of clouds) {
      cl.userData.a += 0.00022;
      cl.position.x = Math.cos(cl.userData.a) * cl.userData.r;
      cl.position.z = Math.sin(cl.userData.a) * cl.userData.r;
    }
    for (const bird of birds) {
      const u = bird.userData;
      const a = t * u.speed + u.phase;
      bird.position.set(Math.cos(a) * u.r, u.h + Math.sin(t * 0.7 + u.phase) * 1.2, Math.sin(a) * u.r);
      bird.rotation.y = -a - Math.PI / 2;
      for (const wing of bird.children) {
        wing.rotation.x = Math.sin(t * u.flap) * 0.55 * wing.userData.side;
      }
    }
    tickTraders(performance.now());
    for (const pod of dolphinPods) {
      const u = pod.userData;
      const a = t * u.speed + u.ph;
      for (const d of pod.children) {
        const off = d.userData.off;
        const aa = a - off * 0.045;
        const hop = Math.sin(t * 1.9 + u.ph + off);
        d.position.set(u.cx + Math.cos(aa) * u.r, hop * 1.0 - 0.4, u.cz + Math.sin(aa) * u.r);
        d.rotation.y = -aa;
        d.rotation.x = -Math.cos(t * 1.9 + u.ph + off) * 0.55;
      }
    }
    for (const isle of Object.values(islands)) {
      const foam = isle.group.getObjectByName('foam');
      if (foam) {
        const s = 1 + Math.sin(t * 1.3 + isle.group.position.x) * 0.045;
        foam.scale.set(s, s, 1);
      }
      const bob = isle.group.getObjectByName('bob');
      if (bob) {
        bob.position.y = Math.sin(t * 1.7 + isle.group.position.x * 0.5) * 0.14;
        bob.rotation.z = Math.sin(t * 1.3 + isle.group.position.z * 0.4) * 0.08;
      }
      const beast = isle.group.getObjectByName('monster');
      if (beast) beast.position.y += Math.sin(t * 2 + isle.group.position.z) * 0.0035;
      const beacon = isle.group.getObjectByName('beacon');
      if (beacon) beacon.rotation.y = t * 0.5;
      const fire = isle.group.getObjectByName('pharosfire');
      if (fire) {
        const pulse = 1 + Math.sin(t * 2.2) * 0.16;
        fire.scale.set(pulse, pulse, pulse);
      }
    }
    for (const [pid, sh] of Object.entries(ships)) {
      if (sh.anim) {
        const k = Math.min(1, (performance.now() - sh.anim.t0) / sh.anim.dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        // walk the polyline at eased progress
        let dAlong = e * sh.anim.total;
        let seg = 0;
        while (seg < sh.anim.legs.length - 1 && dAlong > sh.anim.legs[seg]) {
          dAlong -= sh.anim.legs[seg];
          seg++;
        }
        const a = sh.anim.pts[seg], b = sh.anim.pts[seg + 1];
        const f = sh.anim.legs[seg] > 0 ? dAlong / sh.anim.legs[seg] : 1;
        sh.group.position.lerpVectors(a, b, Math.min(1, f));
        const dir = b.clone().sub(a);
        if (dir.lengthSq() > 0.01) {
          const want = Math.atan2(-dir.z, dir.x);
          let cur = sh.group.rotation.y;
          let diff = want - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          sh.group.rotation.y = cur + diff * 0.15;      // smooth helm turns
        }
        if (k >= 1) {
          sh.anim = null;
          if (followShip === pid) followShip = null;
        }
      }
      sh.group.position.y = Math.sin(t * 1.9 + sh.phase) * 0.1;
      sh.group.rotation.z = Math.sin(t * 1.4 + sh.phase) * 0.04;
      const marker = sh.group.getObjectByName('turnMarker');
      if (marker) {
        marker.rotation.y = t * 2.2;
        marker.position.y = 4.0 + Math.sin(t * 2.6) * 0.18;
      }
    }
    let hi = 0;
    for (const ring of highlights.children) {
      ring.material.opacity = 0.55 + Math.sin(t * 3.5 + hi++) * 0.25;
      const s = 1 + Math.sin(t * 3.5 + hi) * 0.035;
      ring.scale.set(s, s, 1);
    }

    tickArena(t);

    // camera choreography — while a battle owns the camera, OrbitControls
    // must NOT update (its damping fights the cinematic and wins)
    if (battleFocus) {
      const sway = Math.sin(t * 0.5) * 1.6;
      const want = ARENA.clone().add(new THREE.Vector3(-1 + sway, 8.5, 27));
      const look = ARENA.clone().add(new THREE.Vector3(1, 2.6, 0));
      const dist = camera.position.distanceTo(want);
      camera.position.lerp(want, dist > 400 ? 0.5 : dist > 60 ? 0.22 : 0.08);
      camera.lookAt(look);
      controls.target.copy(look);
    } else {
      const mine = myPid && ships[myPid];
      if (mine) {
        // the camera belongs to your boat — it goes where you go
        const want = mine.group.position.clone().setY(1.5);
        const delta = want.sub(controls.target);
        if (delta.lengthSq() > 0.0001) {
          delta.multiplyScalar(mine.anim ? 0.09 : 0.06);
          controls.target.add(delta);
          camera.position.add(delta);
        }
        glideTo = null;
      } else if (glideTo) {
        const delta = glideTo.clone().sub(controls.target);
        if (delta.length() < 0.6) {
          glideTo = null;
        } else {
          delta.multiplyScalar(0.06);
          controls.target.add(delta);
          camera.position.add(delta);
        }
      }
      controls.update();
    }

    // the storm broods: the wall churns, and bolts glow through the cloud
    for (const m of stormMats) {
      m.uniforms.t.value = t;
      if (m.uniforms.boltI.value > 0.01) m.uniforms.boltI.value *= 0.86;
    }
    for (const m of mists) {
      m.position.x += m.userData.vx * 0.05;
      m.position.z += m.userData.vz * 0.05;
      if (Math.hypot(m.position.x, m.position.z) > 560) {
        m.position.set(-Math.random() * 400 + 200, m.position.y, -Math.random() * 400 + 200);
      }
    }
    if (Math.random() < 0.007) {
      const a = Math.random() * Math.PI * 2;
      lightning.position.set(Math.cos(a) * (WALL_R - 70), 55 + Math.random() * 60,
                             Math.sin(a) * (WALL_R - 70));
      lightning.intensity = 1600 + Math.random() * 900;
      for (const m of stormMats) {
        m.uniforms.boltA.value = a;
        m.uniforms.boltI.value = 1.15;
      }
    }
    if (lightning.intensity > 1) lightning.intensity *= 0.82;
    {
      const mine = myPid && ships[myPid];
      const d = mine ? Math.hypot(mine.group.position.x, mine.group.position.z) / WALL_R : 0;
      const target = THREE.MathUtils.smoothstep(d, 0.5, 0.92);
      stormF += (target - stormF) * 0.03;
      sky.material.uniforms.zenith.value.lerpColors(SKY_DAY.zenith, SKY_STORM.zenith, stormF);
      sky.material.uniforms.mid.value.lerpColors(SKY_DAY.mid, SKY_STORM.mid, stormF);
      sky.material.uniforms.horizon.value.lerpColors(SKY_DAY.horizon, SKY_STORM.horizon, stormF);
      scene.fog.color.lerpColors(FOG_DAY, FOG_STORM, stormF);
      sun.intensity = 1.75 * (1 - 0.45 * stormF);
    }
    renderer.render(scene, camera);
  });

  // debug handle (used by dev tooling/screenshot scripts; harmless in prod)
  window.__thalassa = { scene, camera, controls, ships, islands };

  return { update, setBattleFocus, arenaPlay };
}

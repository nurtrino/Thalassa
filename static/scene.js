/*
 * Thalassa 3D world — a fogged frontier archipelago, fully procedural.
 * The board is dynamic: islands appear as you explore (mist silhouettes →
 * real isles), monsters fall, shrines spend out, the Fleece isle emerges.
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

/* monsters: dark spiked beasts with burning eyes; scale by max hp */
function makeMonster(rng, m) {
  const g = new THREE.Group();
  const scale = 0.8 + m.max_hp * 0.22;
  const body = new THREE.Mesh(
    displace(new THREE.IcosahedronGeometry(0.9 * scale, 1), 0.42 * scale, rng() * 100),
    flat(COL.monster));
  body.position.y = 0.95 * scale;
  body.castShadow = true;
  g.add(body);
  const nSpikes = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < nSpikes; i++) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.14 * scale, 0.7 * scale, 5), flat(0x1d1a22));
    const a = rng() * 6.28, t = rng() * 1.2;
    sp.position.set(Math.cos(a) * 0.7 * scale, (0.8 + t) * scale, Math.sin(a) * 0.7 * scale);
    sp.rotation.set(rng() - 0.5, 0, rng() - 0.5);
    sp.castShadow = true;
    g.add(sp);
  }
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
  for (const dx of [-0.28, 0.28]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09 * scale, 6, 5), eyeMat);
    eye.position.set(dx * scale, 1.15 * scale, 0.78 * scale);
    g.add(eye);
  }
  const glow = new THREE.PointLight(0xff5030, 3 + m.max_hp, 7 + m.max_hp);
  glow.position.y = 1.4 * scale;
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

function makeFleeceTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 2.2, 7), flat(COL.woodDark));
  trunk.position.y = 1.1;
  trunk.castShadow = true;
  const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3, 0), flat(0x3f9e58));
  canopy.position.y = 2.6;
  canopy.castShadow = true;
  const fleece = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0),
    flat(COL.gold, { emissive: 0xb98a1a, emissiveIntensity: 0.8 }));
  fleece.position.set(0.9, 1.9, 0.4);
  fleece.name = 'fleece';
  const glow = new THREE.PointLight(0xffd97a, 10, 16);
  glow.position.y = 2.2;
  g.add(trunk, canopy, fleece, glow);
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

/* ── battle enemies: four procedural archetypes, tinted per name ────────── */
function enemyArchetype(name) {
  const n = name.toLowerCase();
  if (/harp|bird/.test(n)) return 'wing';
  if (/siren|empusa|gorgon|sphinx/.test(n)) return 'spirit';
  if (/hydra|ketos|skylla|charybdis|typhon|dragon/.test(n)) return 'serpent';
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
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.PlaneGeometry(1.8 * s, 1.0 * s, 3, 1),
          flat(0x5a2e2e, { side: THREE.DoubleSide }));
        wing.position.set(side * 0.9 * s, 1.9 * s, -0.2 * s);
        wing.rotation.z = side * 0.5;
        wing.name = side < 0 ? 'wingL' : 'wingR';
        g.add(wing);
      }
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
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13 * s, 6, 5), eyeMat);
      eye.position.set(0, 2.3 * s, 0.36 * s);
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
  const g = new THREE.Group();
  const outline = new THREE.Shape();
  outline.moveTo(-1.35, 0);
  outline.quadraticCurveTo(-1.32, 0.52, -0.55, 0.58);
  outline.lineTo(0.75, 0.58);
  outline.quadraticCurveTo(1.55, 0.42, 1.85, 0);
  outline.quadraticCurveTo(1.55, -0.42, 0.75, -0.58);
  outline.lineTo(-0.55, -0.58);
  outline.quadraticCurveTo(-1.32, -0.52, -1.35, 0);
  const hullGeo = new THREE.ExtrudeGeometry(outline,
    { depth: 0.55, bevelEnabled: true, bevelSize: 0.1, bevelThickness: 0.12 });
  hullGeo.rotateX(Math.PI / 2);
  hullGeo.translate(0, 0.64, 0);
  const hull = new THREE.Mesh(hullGeo, flat(COL.wood));
  hull.castShadow = true;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.3, 6), flat(COL.woodDark));
  mast.position.set(0.05, 1.75, 0);
  const sailGeo = new THREE.PlaneGeometry(1.35, 1.45, 6, 6);
  {
    const p = sailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const fx = p.getX(i) / 1.35 + 0.5, fy = p.getY(i) / 1.45 + 0.5;
      p.setZ(i, Math.sin(fx * Math.PI) * 0.3 * (0.4 + fy * 0.6));
    }
    sailGeo.computeVertexNormals();
  }
  const sail = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({
    map: sailTexture(colorHex), side: THREE.DoubleSide, flatShading: true }));
  sail.rotation.y = Math.PI / 2;
  sail.position.set(0.05, 1.82, 0);
  sail.castShadow = true;
  const pennant = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18),
    flat(new THREE.Color(colorHex), { side: THREE.DoubleSide }));
  pennant.position.set(0.3, 2.95, 0);
  g.add(hull, mast, sail, pennant);
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

/* ── island assembly (keyed by view state) ──────────────────────────────── */
const ISLE_R = { home: 6.2, shrine: 4.6, puzzle: 4.6, haven: 5.0,
                 monster: 5.2, lair: 5.8, fleece: 7.2, sea: 1.5 };

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
  let terrain;

  if (node.type === 'sea') {
    // open-water stops come in flavors: cargo, buoys, rocks, tiny islets, ripples
    if (node.flotsam) {
      g.add(makeFlotsam(rng0));
    } else if (node.look === 'rocks') {
      for (let i = 0; i < 2 + Math.floor(rng0() * 2); i++) {
        const rk = makeRock(rng0, 0.5 + rng0() * 0.6, rng0() < 0.4 ? 0xd8d4c8 : COL.rock);
        const a = rng0() * 6.28;
        rk.position.set(Math.cos(a) * rng0() * 1.3, 0.25, Math.sin(a) * rng0() * 1.3);
        g.add(rk);
      }
      g.add(shallowDisc(9));
    } else if (node.look === 'islet') {
      const style = rng0();
      const t = makeTerrain({
        seed, R: 2.6 + rng0() * 1.4,
        H: style < 0.33 ? 0.8 : 1.1,
        mode: style < 0.33 ? 'atoll' : 'hill',
        lobes: style > 0.66 ? 0.42 : 0,
        palette: rng0() < 0.5 ? { sand: 0xf7ecc8 } : {},
      });
      g.add(t.mesh);
      g.add(shallowDisc(13));
      const flora = rng0() < 0.6 ? makePalm(rng0, 0.75) : makeCypress(rng0, 0.7);
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
      g.add(makeBuoy(rng0));
    }
    g.position.set(node.x, 0, node.z);
    return { group: g, R: node.look === 'islet' ? 2.8 : node.look === 'rocks' ? 2.2 : R, plateauY: 0 };
  } else if (node.type === 'home') {
    terrain = makeTerrain({ seed, R, H: 1.7, mode: 'mesa' });
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
    terrain = makeTerrain({ seed, R, H: 2.2, mode: 'mesa' });
    const spent = (node.charges ?? 0) <= 0;
    const shrine = makeShrine(hex);
    shrine.position.y = terrain.heightAt(0);
    if (spent) shrine.traverse((o) => { if (o.material?.color) o.material = o.material.clone(), o.material.color.multiplyScalar(0.6); });
    g.add(shrine);
    const cy = makeCypress(rng0, 1.0);
    cy.position.set(R * 0.45, terrain.heightAt(0.45), R * 0.2);
    g.add(cy);
  } else if (node.type === 'puzzle') {
    terrain = makeTerrain({ seed, R, H: 2.4, mode: 'mesa', palette: { grass: 0x6fae8f } });
    const ob = makeObelisk();
    ob.position.y = terrain.heightAt(0);
    if (node.solved) ob.children.forEach((ch) => { if (ch.isPointLight) ch.intensity = 0; });
    g.add(ob);
    const rk = makeRock(rng0, 0.5, 0x8d94b8);
    rk.position.set(-R * 0.4, terrain.heightAt(0.4) + 0.2, R * 0.3);
    g.add(rk);
  } else if (node.type === 'haven') {
    terrain = makeTerrain({ seed, R, H: 1.8, mode: 'flat' });
    const t = makeTents(rng0);
    t.position.y = terrain.heightAt(0.2);
    g.add(t);
    const dock = makeDock(3.8);
    dock.position.set(0.5, 0.4, R * 0.8);
    dock.rotation.y = Math.PI;
    g.add(dock);
    const palm = makePalm(rng0, 1.0);
    palm.position.set(-R * 0.5, terrain.heightAt(0.5), -R * 0.2);
    g.add(palm);
  } else if (node.type === 'monster' || node.type === 'lair') {
    const dark = node.type === 'lair';
    terrain = makeTerrain({ seed, R, H: dark ? 3.4 : 2.6, mode: 'peak',
      palette: dark ? { grass: 0x74875e, grass2: 0x5a7050, rock: COL.basalt, sand: 0xcbb489 } : {} });
    if (node.monster) {
      const beast = makeMonster(rng0, node.monster);
      beast.position.y = terrain.heightAt(0.25) + 0.55;   // clear of the slope
      beast.position.x = R * 0.1;
      g.add(beast);
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
  } else if (node.type === 'fleece') {
    terrain = makeTerrain({ seed, R, H: 3.2, mode: 'mesa', palette: { grass: 0x7fc06f } });
    const tree = makeFleeceTree();
    tree.position.y = terrain.heightAt(0);
    g.add(tree);
    if (node.monster) {
      const beast = makeMonster(mulberry32(seed + 13), node.monster);
      beast.position.set(R * 0.35, terrain.heightAt(0.4), R * 0.2);
      g.add(beast);
    }
    for (const a of [1.0, 2.8, 4.6]) {
      const c = makeColumn(1.4, 0.12);
      c.position.set(Math.cos(a) * R * 0.6, terrain.heightAt(0.6), Math.sin(a) * R * 0.6);
      g.add(c);
    }
  } else {
    terrain = makeTerrain({ seed, R, H: 2.0, mode: 'hill' });
  }

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
    return bannerTexture(info?.name || '?', `${info?.field || ''} · ${'✦'.repeat(node.charges)}`,
      DOMAIN_COLORS[node.domain]);
  }
  if ((node.type === 'monster' || node.type === 'lair') && node.monster) {
    const sub = node.type === 'lair' ? '⚱ relic lair' : 'blocks the way';
    return bannerTexture(node.monster.name, sub, '#c0392b', true);
  }
  if (node.type === 'fleece') {
    return bannerTexture('The Golden Fleece', node.monster ? 'guarded by the dragon' : '', '#d9a441');
  }
  if (node.type === 'haven') return bannerTexture('Haven', 'repairs for scrolls', '#2e9e8f');
  if (node.type === 'puzzle' && !node.solved) return bannerTexture('Puzzle Isle', 'upgrades await', '#7d5ba6');
  if (node.type === 'home') return bannerTexture('Home Port', 'bank relics here', '#2d5bb9');
  return null;
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
  controls.minDistance = 14;
  controls.maxDistance = 1100;
  controls.enablePan = true;
  controls.panSpeed = 0.6;
  controls.screenSpacePanning = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.target.set(0, 1.5, -10);

  scene.add(makeSky());
  scene.add(new THREE.HemisphereLight(0xd6ecff, 0x3e7d5a, 0.85));
  const sunPos = new THREE.Vector3(300, 420, 150);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.75);
  sun.position.copy(sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -360; sun.shadow.camera.right = 360;
  sun.shadow.camera.top = 360; sun.shadow.camera.bottom = -360;
  sun.shadow.camera.far = 1400;
  sun.shadow.bias = -0.0004;
  sun.target.position.set(0, 0, -70);           // center of the grand chart
  scene.add(sun.target);
  scene.add(sun);
  const glow = makeSunGlow();
  glow.scale.set(240, 240, 1);
  glow.position.copy(sunPos.clone().normalize().multiplyScalar(2400));
  scene.add(glow);

  const water = makeWater(sunPos);
  scene.add(water);

  const clouds = [];
  for (let i = 0; i < 16; i++) {
    const cl = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    const big = 1 + Math.random() * 2.2;
    for (let j = 0; j < n; j++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry((2.0 + Math.random() * 2.2) * big, 0),
        new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, transparent: true, opacity: 0.9 }));
      puff.position.set((j * 2.6 - n * 1.2) * big, Math.random() * 0.8, (Math.random() - 0.5) * 2.4 * big);
      puff.scale.y = 0.42;
      cl.add(puff);
    }
    cl.userData = { a: Math.random() * Math.PI * 2, r: 260 + Math.random() * 560 };
    cl.position.y = 70 + Math.random() * 70;
    clouds.push(cl);
    scene.add(cl);
  }

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

  // dynamic board state
  const islands = {};      // id → {key, group, proxy, R}
  const banners = {};      // id → {key, sprite}
  const ships = {};        // pid → {group, target, idx, phase, anim}
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
        const home = new THREE.Vector3(5 + i * 5.5, 0, -1 + (i % 2) * 3.5);
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

  function slotFor(nodeId, slotIdx) {
    const isle = islands[nodeId];
    const node = isle ? isle.group.position : new THREE.Vector3();
    const a = (slotIdx / 6) * Math.PI * 2 + 0.8;
    const r = (isle?.R ?? 5) * 1.55 + 1.2;
    return new THREE.Vector3(node.x + Math.cos(a) * r, 0, node.z + Math.sin(a) * r);
  }

  function update(room, you) {
    syncBoard(room);
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
        group.position.copy(slotFor(p.node, idx));
        scene.add(group);
        ships[p.pid] = { group, target: p.node, idx, phase: Math.random() * 6, anim: null };
      }
      const sh = ships[p.pid];
      sh.idx = idx;
      if (sh.target !== p.node) {
        const to = slotFor(p.node, idx);
        const dist = sh.group.position.distanceTo(to);
        sh.anim = { from: sh.group.position.clone(), to, t0: performance.now(),
                    dur: Math.min(2600, 600 + dist * 26) };
        sh.target = p.node;
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
      const fleece = isle.group.getObjectByName('fleece');
      if (fleece) {
        fleece.rotation.y = t * 0.8;
        fleece.position.y = 1.9 + Math.sin(t * 1.6) * 0.12;
      }
    }
    for (const sh of Object.values(ships)) {
      if (sh.anim) {
        const k = Math.min(1, (performance.now() - sh.anim.t0) / sh.anim.dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        sh.group.position.lerpVectors(sh.anim.from, sh.anim.to, e);
        const dir = sh.anim.to.clone().sub(sh.anim.from);
        if (dir.lengthSq() > 0.01) sh.group.rotation.y = Math.atan2(-dir.z, dir.x);
        if (k >= 1) sh.anim = null;
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
      if (glideTo) {
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
    renderer.render(scene, camera);
  });

  // debug handle (used by dev tooling/screenshot scripts; harmless in prod)
  window.__thalassa = { scene, camera, controls, ships, islands };

  return { update, setBattleFocus, arenaPlay };
}

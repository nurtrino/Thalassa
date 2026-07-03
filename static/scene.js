/*
 * Thalassa 3D world — a stylized tropical Aegean, fully procedural.
 * No downloaded assets: terrain is sculpted radial meshes with vertex
 * colors, flora/buildings/ships are composed primitives, and every island
 * is seeded by its id so each one has its own recognizable silhouette.
 */
import * as THREE from 'three';
import { OrbitControls } from '/static/vendor/OrbitControls.js';

export const DOMAIN_COLORS = {
  clio: '#d9a441', athena: '#2e9e8f', apollo: '#7d5ba6', dionysos: '#e4572e',
};

const COL = {
  waterDeep: 0x0f6ea6, waterShallow: 0x46d7cf, horizon: 0xcfeaf4,
  sand: 0xf3e3b4, sandWet: 0xd9c489, grass: 0x5cb56e, grass2: 0x3f9e58,
  rock: 0x93999e, rockDark: 0x5c6166, basalt: 0x4a4a52, basaltTop: 0x6f6a5e,
  trunk: 0x8a5a33, frond: 0x2f9e44, frond2: 0x47b858, cypress: 0x1f6e3d,
  olive: 0x9db87a, marble: 0xf7f4ec, marbleShade: 0xe4ddc9,
  aegeanBlue: 0x2d5bb9, terracotta: 0xc96f4a, gold: 0xd9a441,
  wood: 0x9a6b3f, woodDark: 0x74502f,
};

/* seeded rng so each island keeps its shape between renders */
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

/* ── sky ────────────────────────────────────────────────────────────────── */
function makeSky() {
  const geo = new THREE.SphereGeometry(340, 24, 14);
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

/* ── water ──────────────────────────────────────────────────────────────── */
function makeWater(sunDir) {
  const geo = new THREE.PlaneGeometry(640, 640, 96, 96);
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

/* turquoise shallows fading out around every island */
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

/* ── terrain ────────────────────────────────────────────────────────────── */
/*
 * Radial mesh: SEG_A spokes × rings from center to shore, plus an
 * underwater skirt. Silhouette wobbles per angle; height profile is a
 * mesa (flat build platform) or a hill/peak; vertex colors paint beach,
 * meadow, and rock so no textures are needed.
 */
function makeTerrain({ seed, R, H, mode = 'hill', palette = {} }) {
  const rng = mulberry32(seed);
  const SEG_A = 44, SEG_R = 13;
  const P = {
    sand: new THREE.Color(palette.sand ?? COL.sand),
    sandWet: new THREE.Color(palette.sandWet ?? COL.sandWet),
    grass: new THREE.Color(palette.grass ?? COL.grass),
    grass2: new THREE.Color(palette.grass2 ?? COL.grass2),
    rock: new THREE.Color(palette.rock ?? COL.rock),
  };
  // silhouette harmonics
  const h1a = 0.06 + rng() * 0.09, h1k = 2 + Math.floor(rng() * 2), h1p = rng() * 6.28;
  const h2a = 0.04 + rng() * 0.07, h2k = 4 + Math.floor(rng() * 3), h2p = rng() * 6.28;
  const h3a = 0.02 + rng() * 0.05, h3k = 7 + Math.floor(rng() * 4), h3p = rng() * 6.28;
  const edge = (a) => 1 + h1a * Math.sin(a * h1k + h1p) + h2a * Math.sin(a * h2k + h2p)
                        + h3a * Math.sin(a * h3k + h3p);
  const bump = (a, rr) => 1 + 0.16 * Math.sin(a * 3 + h1p + rr * 5) * rr;

  const profile = (rr) => {
    if (mode === 'mesa')  return H * (1 - smooth(0.52, 0.88, rr));
    if (mode === 'peak')  return H * Math.pow(Math.max(0, 1 - rr), 1.35);
    return H * (1 - smooth(0.15, 0.95, rr)) * (0.75 + 0.25 * Math.cos(rr * 3));
  };
  const smooth = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };

  const pos = [], col = [], idx = [];
  const RINGS = SEG_R + 3;                     // +3 skirt rings below the waterline
  const heightAt = (rr) => Math.max(0, profile(Math.min(rr, 1)));

  for (let ri = 0; ri <= RINGS; ri++) {
    for (let ai = 0; ai < SEG_A; ai++) {
      const a = (ai / SEG_A) * Math.PI * 2;
      let rr, y;
      if (ri <= SEG_R) {
        rr = ri / SEG_R;
        y = heightAt(rr) * bump(a, rr);
        if (ri === SEG_R) y = 0.08;            // shoreline
      } else {                                  // skirt
        const k = ri - SEG_R;
        rr = 1 + k * 0.09;
        y = -k * 1.15;
      }
      const wr = rr * R * edge(a);
      pos.push(Math.cos(a) * wr, y, Math.sin(a) * wr);

      // color by elevation
      const c = new THREE.Color();
      const hFrac = y / Math.max(H, 0.001);
      if (ri > SEG_R) c.copy(ri === SEG_R + 1 ? P.sandWet : P.rock).multiplyScalar(0.75);
      else if (y < 0.42) c.copy(rr > 0.93 ? P.sandWet : P.sand);
      else if (mode === 'mesa' && hFrac > 0.62 && rr > 0.42) c.copy(P.rock); // mesa cliff band
      else if (mode === 'peak' && hFrac > 0.55) c.copy(P.rock).lerp(new THREE.Color(COL.rockDark), (hFrac - 0.55) * 1.6);
      else c.copy(P.grass).lerp(P.grass2, (Math.sin(a * 5 + rr * 9 + h2p) + 1) / 2);
      col.push(c.r, c.g, c.b);
    }
  }
  // center cap vertex
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

/* ── flora ──────────────────────────────────────────────────────────────── */
function makePalm(rng, scale = 1) {
  const g = new THREE.Group();
  const lean = (rng() - 0.5) * 0.5;
  const segs = 4;
  let x = 0, y = 0;
  for (let i = 0; i < segs; i++) {
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
      const fx = Math.max(0, p.getX(v) / (1.7 * scale) + 0.5);   // 0..1 along frond
      p.setY(v, p.getY(v) * (1 - fx * 0.55));                     // taper
      p.setZ(v, -Math.pow(fx, 1.7) * 0.55 * scale);               // droop
    }
    fg.computeVertexNormals();
    const frond = new THREE.Mesh(fg, flat(i % 2 ? COL.frond : COL.frond2, { side: THREE.DoubleSide }));
    frond.position.copy(top);
    frond.rotation.y = (i / nF) * Math.PI * 2 + rng() * 0.4;
    frond.translateX(0.7 * scale);
    frond.castShadow = true;
    g.add(frond);
  }
  for (let i = 0; i < 2; i++) {
    const nut = new THREE.Mesh(new THREE.SphereGeometry(0.09 * scale, 5, 4), flat(0x6b4d2b));
    nut.position.set(top.x + (rng() - 0.5) * 0.24, top.y - 0.1, (rng() - 0.5) * 0.24);
    g.add(nut);
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

function makeOlive(rng, scale = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.7 * scale, 5), flat(COL.woodDark));
  trunk.position.y = 0.35 * scale;
  trunk.rotation.z = (rng() - 0.5) * 0.3;
  trunk.castShadow = true;
  g.add(trunk);
  for (let i = 0; i < 4; i++) {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry((0.32 + rng() * 0.2) * scale, 0), flat(COL.olive));
    blob.position.set((rng() - 0.5) * 0.7 * scale, (0.75 + rng() * 0.45) * scale, (rng() - 0.5) * 0.7 * scale);
    blob.castShadow = true;
    g.add(blob);
  }
  return g;
}

function makeBush(rng, scale = 1) {
  const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3 * scale, 0), flat(COL.grass2));
  b.scale.y = 0.65;
  b.castShadow = true;
  b.rotation.y = rng() * 6.28;
  return b;
}

function scatterFlowers(g, rng, R, heightAt, n) {
  const colors = [0xff8fb1, 0xfff2f2, 0xffd166];
  for (let i = 0; i < n; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.09, 4, 3),
      flat(colors[Math.floor(rng() * colors.length)], { emissiveIntensity: 0 }));
    const a = rng() * 6.28, rr = 0.2 + rng() * 0.45;
    f.position.set(Math.cos(a) * rr * R, heightAt(rr) + 0.06, Math.sin(a) * rr * R);
    g.add(f);
  }
}

function makeRock(rng, r, color = COL.rock) {
  const geo = new THREE.DodecahedronGeometry(r, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * (0.8 + rng() * 0.4), p.getY(i) * (0.6 + rng() * 0.5), p.getZ(i) * (0.8 + rng() * 0.4));
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, flat(color));
  rock.castShadow = true;
  rock.rotation.y = rng() * 6.28;
  return rock;
}

function makeAmphora(rng) {
  const pts = [];
  for (const [r, y] of [[0.02, 0], [0.16, 0.08], [0.22, 0.3], [0.16, 0.55], [0.09, 0.66], [0.12, 0.74]]) {
    pts.push(new THREE.Vector2(r, y));
  }
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 8), flat(COL.terracotta));
  m.castShadow = true;
  m.rotation.y = rng() * 6.28;
  return m;
}

/* ── buildings ──────────────────────────────────────────────────────────── */
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

function makeRoof(w, d, hRatio, color) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, w * hRatio); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  const m = new THREE.Mesh(geo, flat(color));
  m.castShadow = true;
  return m;
}

function makeTemple({ w = 4.6, d = 3.3, colH = 1.7, gold = false, roof = COL.aegeanBlue } = {}) {
  const g = new THREE.Group();
  let y = 0;
  for (const [ww, dd, hh] of [[w + 1.9, d + 1.9, 0.24], [w + 1.3, d + 1.3, 0.24], [w + 0.7, d + 0.7, 0.26]]) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(ww, hh, dd), flat(y ? COL.marble : COL.marbleShade));
    step.position.y = y + hh / 2;
    step.receiveShadow = true;
    g.add(step);
    y += hh;
  }
  const cella = new THREE.Mesh(new THREE.BoxGeometry(w - 1.1, colH, d - 1.1), flat(COL.marbleShade));
  cella.position.y = y + colH / 2;
  g.add(cella);
  const nx = 4, nz = 3;
  for (let i = 0; i < nx; i++) {
    for (const zz of [-d / 2 + 0.28, d / 2 - 0.28]) {
      const c = makeColumn(colH, 0.14);
      c.position.set(-w / 2 + 0.32 + i * ((w - 0.64) / (nx - 1)), y, zz);
      g.add(c);
    }
  }
  for (let j = 1; j < nz - 1; j++) {
    for (const xx of [-w / 2 + 0.32, w / 2 - 0.32]) {
      const c = makeColumn(colH, 0.14);
      c.position.set(xx, y, -d / 2 + 0.28 + j * ((d - 0.56) / (nz - 1)));
      g.add(c);
    }
  }
  const entH = 0.36;
  const ent = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, entH, d + 0.5),
    flat(gold ? COL.gold : COL.marble));
  ent.position.y = y + colH + 0.62 * entH;
  ent.castShadow = true;
  g.add(ent);
  const ped = makeRoof(w + 0.5, d + 0.5, 0.2, roof);
  ped.position.y = y + colH + entH + 0.05;
  g.add(ped);
  if (gold) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 6), flat(COL.gold, { emissive: 0x7a5a10 }));
    fin.position.y = y + colH + entH + (w + 0.5) * 0.2 + 0.3;
    g.add(fin);
  }
  return g;
}

function makeTholos() {
  const g = new THREE.Group();
  let y = 0;
  for (const [r, hh] of [[2.35, 0.22], [2.05, 0.22]]) {
    const step = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, 14), flat(COL.marbleShade));
    step.position.y = y + hh / 2;
    step.receiveShadow = true;
    g.add(step);
    y += hh;
  }
  for (let i = 0; i < 8; i++) {
    const c = makeColumn(1.55, 0.13);
    const a = (i / 8) * Math.PI * 2;
    c.position.set(Math.cos(a) * 1.5, y, Math.sin(a) * 1.5);
    g.add(c);
  }
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 0.3, 14), flat(COL.marble));
  ring.position.y = y + 1.95;
  ring.castShadow = true;
  g.add(ring);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.72, 14, 9, 0, Math.PI * 2, 0, Math.PI / 2),
    flat(COL.aegeanBlue));
  dome.position.y = y + 2.1;
  dome.castShadow = true;
  g.add(dome);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.4, 6), flat(COL.gold, { emissive: 0x7a5a10 }));
  fin.position.y = y + 2.1 + 1.72 + 0.2;
  g.add(fin);
  return g;
}

function makeStall(rng, hex) {
  const stall = new THREE.Group();
  const counter = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.75, 1.0), flat(COL.wood));
  counter.position.y = 0.38;
  counter.castShadow = true;
  stall.add(counter);
  for (const dx of [-0.72, 0.72]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 5), flat(COL.woodDark));
    post.position.set(dx, 0.95, -0.4);
    stall.add(post);
  }
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  for (let s = 0; s < 8; s++) { ctx.fillStyle = s % 2 ? '#f7f4ec' : hex; ctx.fillRect(s * 8, 0, 8, 64); }
  const awnTex = new THREE.CanvasTexture(c);
  awnTex.colorSpace = THREE.SRGBColorSpace;
  const awning = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.25),
    new THREE.MeshStandardMaterial({ map: awnTex, side: THREE.DoubleSide }));
  awning.position.set(0, 1.72, 0.12);
  awning.rotation.x = -0.55;
  awning.castShadow = true;
  stall.add(awning);
  const goods = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.22, 0.4), flat(0xc9a227));
  goods.position.set((rng() - 0.5) * 0.8, 0.87, 0.15);
  stall.add(goods);
  return stall;
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

function makeFlag(colorHex) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.8, 5), flat(COL.woodDark));
  pole.position.y = 0.9;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.42),
    flat(new THREE.Color(colorHex), { side: THREE.DoubleSide }));
  cloth.position.set(0.36, 1.5, 0);
  g.add(pole, cloth);
  return g;
}

function makeAcademy(colorHex) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.24, 1.8), flat(COL.marbleShade));
  base.position.y = 0.12;
  const hall = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 1.35), flat(COL.marble));
  hall.position.y = 0.24 + 0.52;
  hall.castShadow = true;
  for (const dx of [-0.75, 0.75]) {
    const c = makeColumn(0.95, 0.09);
    c.position.set(dx, 0.24, 0.8);
    g.add(c);
  }
  const roof = makeRoof(2.0, 1.7, 0.24, COL.aegeanBlue);
  roof.position.y = 1.34;
  const flag = makeFlag(colorHex);
  flag.position.set(1.25, 0.2, 0.6);
  g.add(base, hall, roof, flag);
  return g;
}

function makeHarborPlot(colorHex) {
  const g = new THREE.Group();
  const dock = makeDock(3.6);
  g.add(dock);
  const flag = makeFlag(colorHex);
  flag.position.set(-0.6, 0.55, -3.0);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), flat(COL.woodDark));
  crate.position.set(0.6, 0.9, -1.2);
  crate.castShadow = true;
  g.add(flag, crate);
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
  const keelStripe = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.14, 1.24), flat(new THREE.Color(colorHex)));
  keelStripe.position.y = 0.62;
  // curled stern & prow posts
  const stern = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.0, 5), flat(COL.woodDark));
  stern.position.set(-1.28, 1.0, 0);
  stern.rotation.z = 0.5;
  const prow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.9, 5), flat(COL.woodDark));
  prow.position.set(1.72, 0.95, 0);
  prow.rotation.z = -0.6;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.3, 6), flat(COL.woodDark));
  mast.position.set(0.05, 1.75, 0);
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 5), flat(COL.woodDark));
  yard.rotation.x = Math.PI / 2;
  yard.position.set(0.05, 2.6, 0);
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
  g.add(hull, keelStripe, stern, prow, mast, yard, sail, pennant);
  return g;
}

/* ── banners (library domain cards) ─────────────────────────────────────── */
function bannerTexture(title, sub, colorHex) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 224;
  const ctx = c.getContext('2d');
  // parchment card
  ctx.fillStyle = '#f6eed7';
  ctx.beginPath(); ctx.roundRect(8, 8, 496, 208, 22); ctx.fill();
  ctx.strokeStyle = '#b89d6a'; ctx.lineWidth = 6; ctx.stroke();
  // ribbon
  ctx.fillStyle = colorHex;
  ctx.beginPath(); ctx.roundRect(8, 8, 496, 92, 22); ctx.fill();
  ctx.fillRect(8, 56, 496, 44);          // square off the ribbon's bottom edge
  // medallion
  ctx.beginPath(); ctx.arc(74, 112, 46, 0, 6.29); ctx.fillStyle = '#f6eed7'; ctx.fill();
  ctx.lineWidth = 5; ctx.strokeStyle = colorHex; ctx.stroke();
  ctx.fillStyle = colorHex;
  ctx.font = 'bold 56px Georgia, serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(title[0], 74, 116);
  // text
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 54px Georgia, serif';
  ctx.fillText(title, 296, 56);
  ctx.fillStyle = '#5a4a2f';
  ctx.font = 'italic 40px Georgia, serif';
  ctx.fillText(sub, 280, 158);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ── island assembly ────────────────────────────────────────────────────── */
const ISLE_R = { library: 6.4, oracle: 5.8, agora: 6.0, port: 6.2, open: 5.4, delos: 8.4 };

function buildIsland(node) {
  const g = new THREE.Group();
  const R = ISLE_R[node.type];
  const seed = hashStr(node.id);
  let terrain;

  if (node.type === 'library') {
    terrain = makeTerrain({ seed, R, H: 2.7, mode: 'mesa' });
    const t = makeTemple();
    t.position.y = terrain.heightAt(0);
    g.add(t);
    const rng = terrain.rng;
    for (const a of [0.9, 2.4]) {
      const cy = makeCypress(rng, 1.15);
      cy.position.set(Math.cos(a) * R * 0.42, terrain.heightAt(0.42), Math.sin(a) * R * 0.42);
      g.add(cy);
    }
    const palm = makePalm(rng, 1.0);
    palm.position.set(Math.cos(4.2) * R * 0.8, 0.35, Math.sin(4.2) * R * 0.8);
    g.add(palm);
  } else if (node.type === 'oracle') {
    terrain = makeTerrain({ seed, R, H: 4.6, mode: 'mesa', palette: { rock: 0x8b8f96 } });
    const t = makeTholos();
    t.position.y = terrain.heightAt(0);
    g.add(t);
    const rng = terrain.rng;
    for (let i = 0; i < 4; i++) {
      const a = 0.6 + i * 1.5;
      const cy = makeCypress(rng, 0.95);
      cy.position.set(Math.cos(a) * R * 0.52, terrain.heightAt(0.52), Math.sin(a) * R * 0.52);
      g.add(cy);
    }
    const brazier = new THREE.PointLight(0xff9a3d, 7, 12);
    brazier.position.set(0, terrain.heightAt(0) + 3.4, 0);
    g.add(brazier);
    // smoke plume (animated in the render loop via userData)
    const smoke = new THREE.Group();
    smoke.name = 'smoke';
    for (let i = 0; i < 5; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.28 + i * 0.09, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xdedad2, transparent: true, opacity: 0.5 - i * 0.08 }));
      puff.position.y = terrain.heightAt(0) + 4.2 + i * 0.7;
      puff.userData.baseY = puff.position.y;
      puff.userData.i = i;
      smoke.add(puff);
    }
    g.add(smoke);
  } else if (node.type === 'agora') {
    terrain = makeTerrain({ seed, R, H: 1.9, mode: 'mesa' });
    const rng = terrain.rng;
    const hues = ['#e4572e', '#2d5bb9', '#2e9e8f', '#c9a227'];
    hues.forEach((hex, i) => {
      const stall = makeStall(rng, hex);
      const a = (i / hues.length) * Math.PI * 2 + 0.6;
      stall.position.set(Math.cos(a) * 1.9, terrain.heightAt(0.25), Math.sin(a) * 1.9);
      stall.rotation.y = -a + Math.PI;
      g.add(stall);
    });
    for (let i = 0; i < 3; i++) {
      const am = makeAmphora(rng);
      am.position.set(Math.cos(i * 2.4) * R * 0.55, terrain.heightAt(0.55), Math.sin(i * 2.4) * R * 0.55);
      g.add(am);
    }
    const palm = makePalm(rng, 1.1);
    palm.position.set(R * 0.62, 0.4, -R * 0.35);
    g.add(palm);
  } else if (node.type === 'port') {
    terrain = makeTerrain({ seed, R, H: 1.7, mode: 'mesa' });
    const rng = terrain.rng;
    const dock = makeDock(6.0);
    dock.position.set(1.2, 0.4, R * 0.72);
    dock.rotation.y = Math.PI;
    g.add(dock);
    const lh = makeLighthouse();
    lh.position.set(-R * 0.38, terrain.heightAt(0.38), -R * 0.15);
    g.add(lh);
    for (let i = 0; i < 3; i++) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), flat(COL.woodDark));
      crate.position.set(1.9 - i * 0.7, terrain.heightAt(0.3) + 0.28, R * 0.35 - (i % 2) * 0.6);
      crate.rotation.y = i;
      crate.castShadow = true;
      g.add(crate);
    }
    for (const a of [2.6, 3.6]) {
      const palm = makePalm(rng, 1.15);
      palm.position.set(Math.cos(a) * R * 0.6, terrain.heightAt(0.6), Math.sin(a) * R * 0.6);
      g.add(palm);
    }
  } else if (node.type === 'delos') {
    terrain = makeTerrain({ seed, R, H: 3.6, mode: 'mesa', palette: { grass: 0x6fbf76 } });
    const t = makeTemple({ w: 5.6, d: 4.0, colH: 2.1, gold: true, roof: COL.gold });
    t.position.y = terrain.heightAt(0);
    g.add(t);
    const rng = terrain.rng;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const c = makeColumn(1.5, 0.12);
      c.position.set(Math.cos(a) * R * 0.5, terrain.heightAt(0.5), Math.sin(a) * R * 0.5);
      g.add(c);
    }
    for (const a of [1.2, 4.3]) {
      const cy = makeCypress(rng, 1.3);
      cy.position.set(Math.cos(a) * R * 0.62, terrain.heightAt(0.62), Math.sin(a) * R * 0.62);
      g.add(cy);
    }
  } else {
    // open isles — each gets its own personality
    const variants = {
      kalypso: () => {                                     // lagoon of palms
        terrain = makeTerrain({ seed, R, H: 2.3, mode: 'hill', palette: { sand: 0xf7ecc8 } });
        const rng = terrain.rng;
        for (let i = 0; i < 7; i++) {
          const a = rng() * 6.28, rr = 0.25 + rng() * 0.5;
          const palm = makePalm(rng, 0.9 + rng() * 0.5);
          palm.position.set(Math.cos(a) * rr * R, terrain.heightAt(rr), Math.sin(a) * rr * R);
          g.add(palm);
        }
        scatterFlowers(g, rng, R, terrain.heightAt, 6);
      },
      thera: () => {                                       // volcanic — dark cliffs
        terrain = makeTerrain({
          seed, R, H: 4.2, mode: 'peak',
          palette: { grass: 0x7a9160, grass2: 0x5c7a4a, rock: COL.basalt, sand: 0xcbb489 },
        });
        const rng = terrain.rng;
        for (let i = 0; i < 4; i++) {
          const a = rng() * 6.28, rr = 0.55 + rng() * 0.3;
          const rk = makeRock(rng, 0.5 + rng() * 0.5, COL.basalt);
          rk.position.set(Math.cos(a) * rr * R, terrain.heightAt(rr) + 0.2, Math.sin(a) * rr * R);
          g.add(rk);
        }
        const palm = makePalm(rng, 0.85);
        palm.position.set(R * 0.7, 0.3, R * 0.25);
        g.add(palm);
        const smoke = new THREE.Group();
        smoke.name = 'smoke';
        for (let i = 0; i < 4; i++) {
          const puff = new THREE.Mesh(new THREE.SphereGeometry(0.3 + i * 0.12, 6, 5),
            new THREE.MeshBasicMaterial({ color: 0xc9c4bb, transparent: true, opacity: 0.4 - i * 0.07 }));
          puff.position.y = terrain.heightAt(0) + 0.5 + i * 0.8;
          puff.userData.baseY = puff.position.y;
          puff.userData.i = i;
          smoke.add(puff);
        }
        g.add(smoke);
      },
      naxos: () => {                                       // olive groves & quarry
        terrain = makeTerrain({ seed, R, H: 2.6, mode: 'hill' });
        const rng = terrain.rng;
        for (let i = 0; i < 4; i++) {
          const a = 0.8 + i * 1.5, rr = 0.3 + rng() * 0.35;
          const ol = makeOlive(rng, 0.95 + rng() * 0.3);
          ol.position.set(Math.cos(a) * rr * R, terrain.heightAt(rr), Math.sin(a) * rr * R);
          g.add(ol);
        }
        for (let i = 0; i < 2; i++) {
          const block = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 0.7), flat(COL.marble));
          block.position.set(-R * 0.45 + i * 0.9, terrain.heightAt(0.45) + 0.27, R * 0.3);
          block.rotation.y = i * 0.5;
          block.castShadow = true;
          g.add(block);
        }
      },
      melos: () => {                                       // white rocks & wildflowers
        terrain = makeTerrain({ seed, R, H: 2.1, mode: 'hill', palette: { rock: 0xd8d4c8 } });
        const rng = terrain.rng;
        for (let i = 0; i < 3; i++) {
          const a = 1.1 + i * 2.0;
          const rk = makeRock(rng, 0.6 + rng() * 0.5, 0xd8d4c8);
          rk.position.set(Math.cos(a) * R * 0.45, terrain.heightAt(0.45) + 0.2, Math.sin(a) * R * 0.45);
          g.add(rk);
        }
        for (let i = 0; i < 3; i++) {
          const b = makeBush(rng, 1 + rng() * 0.5);
          const a = rng() * 6.28, rr = 0.3 + rng() * 0.4;
          b.position.set(Math.cos(a) * rr * R, terrain.heightAt(rr) + 0.15, Math.sin(a) * rr * R);
          g.add(b);
        }
        scatterFlowers(g, terrain.rng, R, terrain.heightAt, 10);
        const palm = makePalm(rng, 1.0);
        palm.position.set(0, terrain.heightAt(0.1), -R * 0.15);
        g.add(palm);
      },
    };
    (variants[node.id] || variants.kalypso)();
  }

  g.add(terrain.mesh);
  g.add(shallowDisc(R * 4.2));

  // gentle foam ring at the shoreline
  const foam = new THREE.Mesh(
    new THREE.RingGeometry(R * 1.06, R * 1.3, 36),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = 0.03;
  foam.name = 'foam';
  g.add(foam);

  g.position.set(node.x, 0, node.z);
  return { group: g, R, plateauY: terrain.heightAt(0) };
}

/* ── the world ──────────────────────────────────────────────────────────── */
export function createWorld(container, onIslandClick) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd6ecf5, 110, 320);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 800);
  camera.position.set(0, 66, 94);

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
  controls.minDistance = 24;
  controls.maxDistance = 150;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.target.set(0, 1.5, 0);

  scene.add(makeSky());
  scene.add(new THREE.HemisphereLight(0xd6ecff, 0x3e7d5a, 0.85));
  const sunPos = new THREE.Vector3(60, 84, 30);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.75);
  sun.position.copy(sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -62; sun.shadow.camera.right = 62;
  sun.shadow.camera.top = 62; sun.shadow.camera.bottom = -62;
  sun.shadow.camera.far = 260;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  const glow = makeSunGlow();
  glow.position.copy(sunPos.clone().normalize().multiplyScalar(300));
  scene.add(glow);

  const water = makeWater(sunPos);
  scene.add(water);

  // clouds
  const clouds = [];
  for (let i = 0; i < 8; i++) {
    const cl = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0 + Math.random() * 2.2, 0),
        new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, transparent: true, opacity: 0.9 }));
      puff.position.set(j * 2.6 - n * 1.2, Math.random() * 0.8, (Math.random() - 0.5) * 2.4);
      puff.scale.y = 0.42;
      cl.add(puff);
    }
    // clouds live on a far ring so they hug the horizon, never the foreground
    cl.userData = { a: Math.random() * Math.PI * 2, r: 130 + Math.random() * 70 };
    cl.position.y = 42 + Math.random() * 20;
    clouds.push(cl);
    scene.add(cl);
  }

  // gulls
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
    bird.userData = {
      r: 26 + Math.random() * 42, h: 16 + Math.random() * 8,
      speed: 0.1 + Math.random() * 0.12, phase: Math.random() * 6.28,
      flap: 4 + Math.random() * 3,
    };
    birds.push(bird);
    scene.add(bird);
  }

  // populated by setBoard / update
  const anchors = {};
  const isleR = {};
  const plateau = {};
  const hitProxies = [];
  const banners = {};
  const plotMeshes = {};
  const ships = {};
  const smokes = [];
  const foams = [];
  const highlights = new THREE.Group();
  const delosAura = new THREE.Group();
  delosAura.visible = false;
  scene.add(highlights, delosAura);

  let boardBuilt = false;

  function setBoard(board) {
    if (boardBuilt) return;
    boardBuilt = true;
    for (const node of board.nodes) {
      anchors[node.id] = new THREE.Vector3(node.x, 0, node.z);
      const { group, R, plateauY } = buildIsland(node);
      isleR[node.id] = R;
      plateau[node.id] = plateauY;
      scene.add(group);
      const smoke = group.getObjectByName('smoke');
      if (smoke) smokes.push(smoke);
      const foam = group.getObjectByName('foam');
      if (foam) foams.push(foam);
      const proxy = new THREE.Mesh(new THREE.CylinderGeometry(R + 2.2, R + 2.2, 9, 8),
        new THREE.MeshBasicMaterial({ visible: false }));
      proxy.position.set(node.x, 3, node.z);
      proxy.userData.node = node.id;
      hitProxies.push(proxy);
      scene.add(proxy);
    }
    for (const [a, b] of board.edges) {
      const pa = anchors[a].clone().setY(0.16);
      const pb = anchors[b].clone().setY(0.16);
      const dir = pb.clone().sub(pa);
      const len = dir.length();
      dir.normalize();
      const gapA = isleR[a] * 1.45, gapB = isleR[b] * 1.45;
      if (len < gapA + gapB + 2) continue;
      const pts = [pa.clone().addScaledVector(dir, gapA),
                   pa.clone().addScaledVector(dir, len - gapB)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const isDelos = a === 'delos' || b === 'delos';
      const mat = new THREE.LineDashedMaterial({
        color: isDelos ? COL.gold : 0xffffff, transparent: true,
        opacity: isDelos ? 0.7 : 0.42, dashSize: 0.8, gapSize: 1.1,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      scene.add(line);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(isleR.delos * 1.35, isleR.delos * 1.48, 48),
      new THREE.MeshBasicMaterial({ color: COL.gold, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    delosAura.add(ring);
  }

  function slotFor(nodeId, slotIdx) {
    const base = anchors[nodeId];
    const a = (slotIdx / 6) * Math.PI * 2 + 0.8;
    const r = isleR[nodeId] * 1.55 + 1.2;
    return new THREE.Vector3(base.x + Math.cos(a) * r, 0, base.z + Math.sin(a) * r);
  }

  function update(room, you) {
    setBoard(room.board);
    controls.autoRotate = room.phase === 'lobby';

    for (const [lib, dom] of Object.entries(room.library_domains || {})) {
      const info = room.board.domains[dom];
      if (!banners[lib]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, fog: false }));
        sp.scale.set(11.8, 5.16, 1);
        sp.position.copy(anchors[lib]).add(new THREE.Vector3(0, plateau[lib] + 9.6, 0));
        banners[lib] = { sprite: sp, key: null };
        scene.add(sp);
      }
      if (banners[lib].key !== dom) {
        banners[lib].key = dom;
        banners[lib].sprite.material.map?.dispose();
        banners[lib].sprite.material.map = bannerTexture(info.name, info.field, DOMAIN_COLORS[dom]);
        banners[lib].sprite.material.needsUpdate = true;
      }
    }

    const playersByPid = Object.fromEntries(room.players.map(p => [p.pid, p]));
    for (const [nid, plot] of Object.entries(room.plots || {})) {
      const key = plot ? `${plot.kind}:${plot.owner}` : 'empty';
      if (plotMeshes[nid]?.key === key) continue;
      if (plotMeshes[nid]?.mesh) scene.remove(plotMeshes[nid].mesh);
      let mesh = null;
      if (plot) {
        const color = playersByPid[plot.owner]?.color || '#ffffff';
        if (plot.kind === 'academy') {
          mesh = makeAcademy(color);
          mesh.position.copy(anchors[nid]).add(new THREE.Vector3(1.2, plateau[nid] * 0.55 + 0.4, 1.2));
          mesh.rotation.y = Math.atan2(anchors[nid].x, anchors[nid].z) + Math.PI;
        } else {
          mesh = makeHarborPlot(color);
          const out = anchors[nid].clone().normalize();
          mesh.position.copy(anchors[nid]).addScaledVector(out, isleR[nid] * 0.8);
          mesh.position.y = 0.15;
          mesh.lookAt(anchors[nid].clone().setY(0.15));
          mesh.rotateY(Math.PI);
        }
        scene.add(mesh);
      }
      plotMeshes[nid] = { key, mesh };
    }

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
        const R = isleR[nid];
        const ring = new THREE.Mesh(new THREE.RingGeometry(R * 1.34, R * 1.52, 40),
          new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(anchors[nid]).setY(0.35);
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

    const anyEligible = room.players.some(p => p.laurels.length >= (room.config?.laurels_needed ?? 3));
    delosAura.visible = anyEligible;
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
    const hit = ray.intersectObjects(hitProxies, false)[0];
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
    for (const smoke of smokes) {
      for (const puff of smoke.children) {
        const k = (t * 0.5 + puff.userData.i * 0.22) % 1;
        puff.position.y = puff.userData.baseY + k * 1.8;
        puff.position.x = Math.sin(t * 0.8 + puff.userData.i) * 0.3;
        puff.material.opacity = (0.5 - puff.userData.i * 0.07) * (1 - k * 0.7);
      }
    }
    let fi = 0;
    for (const foam of foams) {
      const s = 1 + Math.sin(t * 1.3 + fi++ * 1.7) * 0.045;
      foam.scale.set(s, s, 1);
      foam.material.opacity = 0.22 + Math.sin(t * 1.3 + fi) * 0.08;
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
      ring.material.opacity = 0.5 + Math.sin(t * 3.5 + hi++) * 0.25;
      const s = 1 + Math.sin(t * 3.5 + hi) * 0.035;
      ring.scale.set(s, s, 1);
    }
    if (delosAura.visible && delosAura.children.length) {
      delosAura.rotation.y = t * 0.35;
      delosAura.children[0].material.opacity = 0.35 + Math.sin(t * 2.2) * 0.2;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  // debug handle (used by dev tooling/screenshot scripts; harmless in prod)
  window.__thalassa = { scene, camera, controls, ships, anchors };

  return { update, setBoard };
}

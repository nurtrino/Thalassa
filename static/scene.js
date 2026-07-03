/*
 * Thalassa 3D world — a procedural tropical Aegean built from primitives.
 * No downloaded models: islands, temples, palms, and triremes are all
 * generated here so the whole scene stays one coherent low-poly style.
 */
import * as THREE from 'three';
import { OrbitControls } from '/static/vendor/OrbitControls.js';

export const DOMAIN_COLORS = {
  clio: '#d9a441', athena: '#2e9e8f', apollo: '#7d5ba6', dionysos: '#e4572e',
};

const COL = {
  waterDeep: 0x1272a8, waterShallow: 0x3fd0cf, foam: 0xeafcff,
  sand: 0xf0dfae, grass: 0x53b06a, grassDark: 0x2f8f52, rock: 0x8f979e,
  trunk: 0x8a5a33, frond: 0x2f9e44, marble: 0xf7f4ec, marbleShade: 0xe7e2d4,
  aegeanBlue: 0x2d5bb9, gold: 0xd9a441, wood: 0x9a6b3f, woodDark: 0x74502f,
};

const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, ...extra });

function jitter(geo, amt) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) + (Math.random() - 0.5) * amt,
      p.getY(i) + (Math.random() - 0.5) * amt * 0.6,
      p.getZ(i) + (Math.random() - 0.5) * amt);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ── water ──────────────────────────────────────────────────────────────── */
function makeWater() {
  const geo = new THREE.PlaneGeometry(420, 420, 80, 80);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      t: { value: 0 },
      deep: { value: new THREE.Color(COL.waterDeep) },
      shallow: { value: new THREE.Color(COL.waterShallow) },
    },
    vertexShader: /* glsl */`
      uniform float t; varying float vWave; varying vec3 vPos;
      void main() {
        vec3 p = position;
        float w = sin(p.x*0.16 + t*1.1)*0.38 + cos(p.z*0.19 + t*0.8)*0.34
                + sin((p.x+p.z)*0.10 + t*0.5)*0.25;
        p.y += w;
        vWave = w; vPos = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 deep; uniform vec3 shallow; uniform float t;
      varying float vWave; varying vec3 vPos;
      void main() {
        float d = length(vPos.xz);
        float mixv = clamp(0.68 + vWave*0.4 - d*0.0035, 0.0, 1.0);
        vec3 c = mix(deep, shallow, mixv);
        float glint = pow(max(0.0, sin(vPos.x*0.9 + t*2.0) * sin(vPos.z*1.1 - t*1.6)), 14.0);
        c += vec3(0.9, 0.95, 1.0) * glint * 0.09;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.55;
  return mesh;
}

/* ── flora & rocks ──────────────────────────────────────────────────────── */
function makePalm(scale = 1) {
  const g = new THREE.Group();
  let y = 0, lean = (Math.random() - 0.5) * 0.35;
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09 * scale * (1 - i * 0.18), 0.12 * scale * (1 - i * 0.18), 0.75 * scale, 5),
      flat(COL.trunk));
    seg.position.set(lean * i * 0.4 * scale, y + 0.37 * scale, 0);
    seg.rotation.z = lean * (i + 1) * 0.35;
    seg.castShadow = true;
    g.add(seg);
    y += 0.68 * scale;
  }
  const top = new THREE.Vector3(lean * 1.1 * scale, y + 0.1 * scale, 0);
  for (let i = 0; i < 6; i++) {
    const frond = new THREE.Mesh(new THREE.PlaneGeometry(1.5 * scale, 0.4 * scale, 3, 1),
      flat(COL.frond, { side: THREE.DoubleSide }));
    const a = (i / 6) * Math.PI * 2;
    frond.position.copy(top);
    frond.rotation.y = a;
    frond.rotation.z = -0.45 - Math.random() * 0.25;
    frond.translateX(0.62 * scale);
    frond.castShadow = true;
    g.add(frond);
  }
  return g;
}

function makeRock(r) {
  const rock = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(r, 0), r * 0.35), flat(COL.rock));
  rock.castShadow = true;
  return rock;
}

/* ── island bases ───────────────────────────────────────────────────────── */
function islandBase(radius) {
  const g = new THREE.Group();
  const sand = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(radius, radius * 1.35, 1.6, 9, 2), 0.28),
    flat(COL.sand));
  sand.position.y = 0.15;
  sand.receiveShadow = true;
  g.add(sand);
  const grass = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(radius * 0.68, radius * 0.9, 0.7, 9), 0.22),
    flat(COL.grass));
  grass.position.y = 1.15;
  grass.receiveShadow = true;
  g.add(grass);
  const foam = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.32, radius * 1.62, 28),
    new THREE.MeshBasicMaterial({ color: COL.foam, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = 0.02;
  g.add(foam);
  for (let i = 0; i < 3; i++) {
    const rk = makeRock(0.28 + Math.random() * 0.25);
    const a = Math.random() * Math.PI * 2;
    rk.position.set(Math.cos(a) * radius * (0.9 + Math.random() * 0.25), 0.85,
                    Math.sin(a) * radius * (0.9 + Math.random() * 0.25));
    g.add(rk);
  }
  return g;
}

function scatterPalms(g, radius, n, topY = 1.5) {
  for (let i = 0; i < n; i++) {
    const palm = makePalm(0.8 + Math.random() * 0.5);
    const a = Math.random() * Math.PI * 2;
    const r = radius * (0.45 + Math.random() * 0.35);
    palm.position.set(Math.cos(a) * r, topY, Math.sin(a) * r);
    palm.rotation.y = Math.random() * Math.PI * 2;
    g.add(palm);
  }
}

/* ── buildings ──────────────────────────────────────────────────────────── */
function makeColumn(h = 1.5, r = 0.13) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.12, h, 7), flat(COL.marble));
  shaft.position.y = h / 2;
  shaft.castShadow = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(r * 3, r * 0.8, r * 3), flat(COL.marbleShade));
  cap.position.y = h + r * 0.4;
  g.add(shaft, cap);
  return g;
}

function makePediment(w, d) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, w * 0.22); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  const m = new THREE.Mesh(geo, flat(COL.aegeanBlue));
  m.castShadow = true;
  return m;
}

function makeTemple({ w = 3.6, d = 2.6, big = false, gold = false } = {}) {
  const g = new THREE.Group();
  const s = big ? 1.5 : 1;
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w * s + 0.8, 0.5, d * s + 0.8), flat(COL.marbleShade));
  plinth.position.y = 0.25; plinth.receiveShadow = true; plinth.castShadow = true;
  const step = new THREE.Mesh(new THREE.BoxGeometry(w * s + 1.5, 0.28, d * s + 1.5), flat(COL.marble));
  step.position.y = 0.05;
  g.add(step, plinth);
  const colH = 1.5 * s;
  const nx = big ? 4 : 3;
  for (let i = 0; i < nx; i++) {
    for (const zz of [-(d * s) / 2 + 0.25, (d * s) / 2 - 0.25]) {
      const c = makeColumn(colH, 0.13 * s);
      c.position.set(-(w * s) / 2 + 0.35 + i * ((w * s - 0.7) / (nx - 1)), 0.5, zz);
      g.add(c);
    }
  }
  const ent = new THREE.Mesh(new THREE.BoxGeometry(w * s + 0.6, 0.34, d * s + 0.6),
    flat(gold ? COL.gold : COL.marble));
  ent.position.y = 0.5 + colH + 0.32; ent.castShadow = true;
  g.add(ent);
  const ped = makePediment(w * s + 0.6, d * s + 0.6);
  ped.position.y = 0.5 + colH + 0.49;
  g.add(ped);
  return g;
}

function makeTholos() {                       // the Oracle — round temple, blue dome
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 0.5, 12), flat(COL.marbleShade));
  base.position.y = 0.25; base.castShadow = true; base.receiveShadow = true;
  g.add(base);
  for (let i = 0; i < 7; i++) {
    const c = makeColumn(1.4, 0.12);
    const a = (i / 7) * Math.PI * 2;
    c.position.set(Math.cos(a) * 1.25, 0.5, Math.sin(a) * 1.25);
    g.add(c);
  }
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.26, 12), flat(COL.marble));
  ring.position.y = 2.05; g.add(ring);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.45, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    flat(COL.aegeanBlue));
  dome.position.y = 2.16; dome.castShadow = true;
  g.add(dome);
  return g;
}

function makeStalls() {                       // the Agora — striped market awnings
  const g = new THREE.Group();
  const stripes = ['#e4572e', '#2d5bb9', '#2e9e8f'];
  stripes.forEach((hex, i) => {
    const stall = new THREE.Group();
    const counter = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 0.9), flat(COL.wood));
    counter.position.y = 0.35; counter.castShadow = true;
    stall.add(counter);
    for (const dx of [-0.65, 0.65]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 5), flat(COL.woodDark));
      post.position.set(dx, 0.85, -0.35);
      stall.add(post);
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    for (let sIdx = 0; sIdx < 8; sIdx++) {
      ctx.fillStyle = sIdx % 2 ? '#f7f4ec' : hex;
      ctx.fillRect(sIdx * 8, 0, 8, 64);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const awning = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.1),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide }));
    awning.position.set(0, 1.55, 0.1);
    awning.rotation.x = -0.5;
    awning.castShadow = true;
    stall.add(awning);
    const a = (i / 3) * Math.PI * 2 + 0.5;
    stall.position.set(Math.cos(a) * 1.3, 0, Math.sin(a) * 1.3);
    stall.rotation.y = -a + Math.PI / 2;
    g.add(stall);
  });
  return g;
}

function makeDock() {                         // the Port — planks and barrels
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 4.6), flat(COL.wood));
  deck.position.set(0, 0.6, -2.2); deck.castShadow = true;
  g.add(deck);
  for (const [px, pz] of [[-1, -0.4], [1, -0.4], [-1, -4], [1, -4]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.4, 5), flat(COL.woodDark));
    post.position.set(px, 0.2, pz);
    g.add(post);
  }
  for (let i = 0; i < 3; i++) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 8), flat(COL.woodDark));
    barrel.position.set(-0.7 + i * 0.7, 0.95, -1.4 - (i % 2) * 0.5);
    barrel.castShadow = true;
    g.add(barrel);
  }
  return g;
}

function makePlotStones() {                   // an unclaimed build plot
  const g = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const st = makeRock(0.14);
    st.position.set(Math.cos(a) * 0.9, 0.06, Math.sin(a) * 0.9);
    g.add(st);
  }
  return g;
}

function makeFlag(colorHex) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 5), flat(COL.woodDark));
  pole.position.y = 0.8;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.4),
    flat(new THREE.Color(colorHex), { side: THREE.DoubleSide }));
  cloth.position.set(0.33, 1.35, 0);
  g.add(pole, cloth);
  return g;
}

function makeAcademy(colorHex) {              // white hall, blue roof, owner flag
  const g = new THREE.Group();
  const hall = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 1.1), flat(COL.marble));
  hall.position.y = 0.45; hall.castShadow = true;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.05, 0.7, 4), flat(COL.aegeanBlue));
  roof.position.y = 1.25; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
  const flag = makeFlag(colorHex);
  flag.position.set(0.9, 0, 0.4);
  g.add(hall, roof, flag);
  return g;
}

function makeHarbor(colorHex) {               // small jetty + owner flag
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 2.6), flat(COL.wood));
  deck.position.set(0, 0.5, -1.1); deck.castShadow = true;
  for (const pz of [-0.2, -2.2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 5), flat(COL.woodDark));
    post.position.set(0.4, 0.15, pz);
    g.add(post);
  }
  const flag = makeFlag(colorHex);
  flag.position.set(-0.4, 0.55, -2.1);
  g.add(deck, flag);
  return g;
}

/* ── ships ──────────────────────────────────────────────────────────────── */
function makeShip(colorHex) {
  const g = new THREE.Group();
  const outline = new THREE.Shape();
  outline.moveTo(-1.15, 0);
  outline.quadraticCurveTo(-1.15, 0.5, -0.5, 0.55);
  outline.lineTo(0.7, 0.55);
  outline.quadraticCurveTo(1.35, 0.45, 1.5, 0);
  outline.quadraticCurveTo(1.35, -0.45, 0.7, -0.55);
  outline.lineTo(-0.5, -0.55);
  outline.quadraticCurveTo(-1.15, -0.5, -1.15, 0);
  const hullGeo = new THREE.ExtrudeGeometry(outline, { depth: 0.5, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08 });
  hullGeo.rotateX(Math.PI / 2);
  hullGeo.translate(0, 0.58, 0);
  const hull = new THREE.Mesh(hullGeo, flat(COL.wood));
  hull.castShadow = true;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.9, 5), flat(COL.woodDark));
  mast.position.set(0.1, 1.45, 0);
  const sailGeo = new THREE.PlaneGeometry(1.15, 1.25, 4, 4);
  {
    const p = sailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / 1.15 + 0.5) * Math.PI) * 0.22);
    sailGeo.computeVertexNormals();
  }
  const sail = new THREE.Mesh(sailGeo, flat(new THREE.Color(colorHex), { side: THREE.DoubleSide }));
  sail.position.set(0.12, 1.5, 0);
  sail.castShadow = true;
  const pennant = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.16),
    flat(new THREE.Color(colorHex), { side: THREE.DoubleSide }));
  pennant.position.set(0.3, 2.42, 0);
  g.add(hull, mast, sail, pennant);
  return g;
}

/* ── banners (library domain cards) ─────────────────────────────────────── */
function bannerTexture(title, sub, colorHex) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 176;
  const ctx = c.getContext('2d');
  ctx.fillStyle = colorHex;
  ctx.beginPath();
  ctx.roundRect(6, 6, 500, 164, 26);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 62px Georgia, serif';
  ctx.fillText(title, 256, 78);
  ctx.font = '40px Georgia, serif';
  ctx.fillText(sub, 256, 136);
  return new THREE.CanvasTexture(c);
}

/* ── the world ──────────────────────────────────────────────────────────── */
export function createWorld(container, onIslandClick) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fd8ea);
  scene.fog = new THREE.Fog(0xaadcec, 70, 190);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
  camera.position.set(0, 42, 55);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = 1.28;
  controls.minDistance = 16;
  controls.maxDistance = 90;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;

  scene.add(new THREE.HemisphereLight(0xcfeaff, 0x3e7d5a, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.7);
  sun.position.set(34, 52, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
  sun.shadow.camera.far = 140;
  scene.add(sun);

  const water = makeWater();
  scene.add(water);

  // drifting clouds
  const clouds = [];
  for (let i = 0; i < 7; i++) {
    const cl = new THREE.Group();
    for (let j = 0; j < 3; j++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(1.6 + Math.random() * 1.6, 7, 5),
        new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, transparent: true, opacity: 0.92 }));
      puff.position.set(j * 2.2 - 2, Math.random(), Math.random() * 1.5);
      puff.scale.y = 0.45;
      cl.add(puff);
    }
    cl.position.set((Math.random() - 0.5) * 160, 26 + Math.random() * 10, (Math.random() - 0.5) * 160);
    clouds.push(cl);
    scene.add(cl);
  }

  // populated by setBoard / update
  const anchors = {};          // nodeId → Vector3
  const hitProxies = [];       // invisible cylinders for clicking
  const banners = {};          // libId → sprite
  const plotMeshes = {};       // nodeId → {key, mesh}
  const ships = {};            // pid → {group, from, to, t0, dur, phase}
  const highlights = new THREE.Group();
  const delosAura = new THREE.Group();
  delosAura.visible = false;
  scene.add(highlights, delosAura);

  let boardBuilt = false;

  function islandFor(node) {
    const g = new THREE.Group();
    const r = { library: 4.2, oracle: 3.6, agora: 3.8, port: 4.0, open: 3.4, delos: 5.2 }[node.type];
    g.add(islandBase(r));
    if (node.type === 'library') {
      const t = makeTemple();
      t.position.y = 1.5;
      g.add(t);
      scatterPalms(g, r, 3);
    } else if (node.type === 'oracle') {
      const t = makeTholos();
      t.position.y = 1.5;
      g.add(t);
      scatterPalms(g, r, 2);
      const brazier = new THREE.PointLight(0xff9a3d, 6, 9);
      brazier.position.set(0, 3.2, 0);
      g.add(brazier);
    } else if (node.type === 'agora') {
      const t = makeStalls();
      t.position.y = 1.5;
      g.add(t);
      scatterPalms(g, r, 2);
    } else if (node.type === 'port') {
      const t = makeDock();
      t.position.y = 1.0;
      t.rotation.y = Math.PI;          // dock reaches toward open water (south)
      g.add(t);
      scatterPalms(g, r, 3);
    } else if (node.type === 'delos') {
      const t = makeTemple({ big: true, gold: true });
      t.position.y = 1.5;
      g.add(t);
      scatterPalms(g, r, 4);
    } else {
      scatterPalms(g, r, 4);
      const stones = makePlotStones();
      stones.position.y = 1.55;
      g.add(stones);
    }
    g.position.set(node.x, 0, node.z);
    // invisible click proxy
    const proxy = new THREE.Mesh(new THREE.CylinderGeometry(r + 1.2, r + 1.2, 6, 8),
      new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(node.x, 2, node.z);
    proxy.userData.node = node.id;
    hitProxies.push(proxy);
    scene.add(proxy);
    return g;
  }

  function setBoard(board) {
    if (boardBuilt) return;
    boardBuilt = true;
    for (const node of board.nodes) {
      anchors[node.id] = new THREE.Vector3(node.x, 0, node.z);
      scene.add(islandFor(node));
    }
    for (const [a, b] of board.edges) {
      const pa = anchors[a].clone().setY(0.14);
      const pb = anchors[b].clone().setY(0.14);
      const dir = pb.clone().sub(pa);
      const len = dir.length();
      const gap = 3.4;                      // keep lanes off the beaches
      if (len < gap * 2 + 1) continue;
      dir.normalize();
      const pts = [pa.clone().addScaledVector(dir, gap),
                   pa.clone().addScaledVector(dir, len - gap)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const isDelos = a === 'delos' || b === 'delos';
      const mat = new THREE.LineDashedMaterial({
        color: isDelos ? COL.gold : 0xffffff, transparent: true,
        opacity: isDelos ? 0.65 : 0.38, dashSize: 0.65, gapSize: 0.85,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      scene.add(line);
    }
    // golden shimmer ring around Delos
    const ring = new THREE.Mesh(new THREE.RingGeometry(6.4, 7.0, 40),
      new THREE.MeshBasicMaterial({ color: COL.gold, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    delosAura.add(ring);
  }

  /* ships park at per-player slots around each island */
  function slotFor(nodeId, slotIdx) {
    const base = anchors[nodeId];
    const a = (slotIdx / 6) * Math.PI * 2 + 0.8;
    const r = 6.1;
    return new THREE.Vector3(base.x + Math.cos(a) * r, 0, base.z + Math.sin(a) * r);
  }

  function update(room, you) {
    setBoard(room.board);
    controls.autoRotate = room.phase === 'lobby';

    // library banners
    for (const [lib, dom] of Object.entries(room.library_domains || {})) {
      const info = room.board.domains[dom];
      const key = `${dom}`;
      if (!banners[lib]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }));
        sp.scale.set(7.4, 2.55, 1);
        sp.position.copy(anchors[lib]).add(new THREE.Vector3(0, 6.4, 0));
        banners[lib] = { sprite: sp, key: null };
        scene.add(sp);
      }
      if (banners[lib].key !== key) {
        banners[lib].key = key;
        banners[lib].sprite.material.map?.dispose();
        banners[lib].sprite.material.map = bannerTexture(info.name, info.field, DOMAIN_COLORS[dom]);
        banners[lib].sprite.material.needsUpdate = true;
      }
    }

    // plots (academies / harbors)
    const playersByPid = Object.fromEntries(room.players.map(p => [p.pid, p]));
    for (const [nid, plot] of Object.entries(room.plots || {})) {
      const key = plot ? `${plot.kind}:${plot.owner}` : 'empty';
      if (plotMeshes[nid]?.key === key) continue;
      if (plotMeshes[nid]) scene.remove(plotMeshes[nid].mesh);
      let mesh = null;
      if (plot) {
        const color = playersByPid[plot.owner]?.color || '#ffffff';
        mesh = plot.kind === 'academy' ? makeAcademy(color) : makeHarbor(color);
        mesh.position.copy(anchors[nid]).add(new THREE.Vector3(0, 1.5, 0));
        if (plot.kind === 'harbor') {
          mesh.position.y = 1.0;
          mesh.lookAt(new THREE.Vector3(0, 1.0, 0));   // jetty faces open water
          mesh.rotateY(Math.PI);
        }
        scene.add(mesh);
      }
      plotMeshes[nid] = { key, mesh };
    }

    // ships
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
        sh.anim = {
          from: sh.group.position.clone(),
          to: slotFor(p.node, idx),
          t0: performance.now(), dur: 1400,
        };
        sh.target = p.node;
      }
    });
    for (const pid of Object.keys(ships)) {
      if (!playersByPid[pid]) { scene.remove(ships[pid].group); delete ships[pid]; }
    }

    // reachable highlights (only meaningful for the current captain)
    highlights.clear();
    const myTurn = room.turn === you && room.phase === 'sail';
    if (myTurn) {
      for (const nid of Object.keys(room.reachable || {})) {
        const big = nid === 'delos' ? 1.3 : 1;
        const ring = new THREE.Mesh(new THREE.RingGeometry(6.2 * big, 7.1 * big, 36),
          new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(anchors[nid]).setY(0.28);
        ring.userData.node = nid;
        highlights.add(ring);
      }
    }

    // turn marker
    const turnPid = room.turn;
    for (const [pid, sh] of Object.entries(ships)) {
      let marker = sh.group.getObjectByName('turnMarker');
      if (pid === turnPid && room.phase !== 'lobby' && room.phase !== 'finished') {
        if (!marker) {
          marker = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.7, 6), flat(COL.gold, { emissive: 0x9a6a10 }));
          marker.name = 'turnMarker';
          marker.rotation.x = Math.PI;
          marker.position.y = 3.4;
          sh.group.add(marker);
        }
      } else if (marker) {
        sh.group.remove(marker);
      }
    }

    // Delos aura glows when someone is eligible
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
    if (moved > 6) return;                    // it was a drag, not a click
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
      cl.position.x += 0.014;
      if (cl.position.x > 110) cl.position.x = -110;
    }
    for (const sh of Object.values(ships)) {
      if (sh.anim) {
        const k = Math.min(1, (performance.now() - sh.anim.t0) / sh.anim.dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOut
        sh.group.position.lerpVectors(sh.anim.from, sh.anim.to, e);
        const dir = sh.anim.to.clone().sub(sh.anim.from);
        if (dir.lengthSq() > 0.01) sh.group.rotation.y = Math.atan2(-dir.z, dir.x);
        if (k >= 1) sh.anim = null;
      }
      sh.group.position.y = Math.sin(t * 1.9 + sh.phase) * 0.09;
      sh.group.rotation.z = Math.sin(t * 1.4 + sh.phase) * 0.035;
      const marker = sh.group.getObjectByName('turnMarker');
      if (marker) marker.rotation.y = t * 2.2;
    }
    let hi = 0;
    for (const ring of highlights.children) {
      ring.material.opacity = 0.45 + Math.sin(t * 3.5 + hi++) * 0.25;
      const s = 1 + Math.sin(t * 3.5 + hi) * 0.04;
      ring.scale.set(s, s, 1);
    }
    if (delosAura.visible && delosAura.children.length) {
      delosAura.rotation.y = t * 0.4;
      delosAura.children[0].material.opacity = 0.35 + Math.sin(t * 2.2) * 0.2;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  // debug handle (used by dev tooling/screenshot scripts; harmless in prod)
  window.__thalassa = { scene, camera, controls, ships, anchors };

  return { update, setBoard };
}

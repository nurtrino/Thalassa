/*
 * scene.js — Thalassa world orchestrator (Agent B).
 *
 * One renderer, many stages. A Stage is a self-contained THREE.Scene for one
 * region of the game world: the hub archipelago or one of the four realms
 * behind the mountain wall. The battle diorama (battle.js) is a further,
 * separate stage. The viewer sees exactly one stage at a time; switches go
 * through a 0.6s ink fade (div.scenefade, styled by Agent D).
 *
 * Contract notes / deviations (see docs/FRONTEND-CONTRACTS.md, Agent B):
 * - battlePlay('target'|'targeted', {idx}) is forwarded to
 *   battleStage.setTargeted(idx) — scene.js is app.js's only path to the
 *   battle stage, and the contract gives setTargeted no other transport.
 *   Every other kind goes straight to battleStage.play(kind, payload).
 * - buildRealmBackdrop groups are positioned at the realm's node centroid
 *   and yawed so their dense side faces away from the realm's gate node
 *   (realm node coordinates come from the server and are not origin-centred).
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { hashStr, mulberry32, flat } from './util.js';
import { themeFor } from './themes.js';
import { makeWater, makeGround } from './water.js';
import { buildIsland, makeShip, makeParticles, nameSprite, makeRealmField, preloadStructures } from './islands.js';
import { preloadProps } from './props.js';
import { buildMountainWall, buildRealmBackdrop } from './wall.js';
import { getMonster, animateMonster, preloadMonsters, disposeMonster } from './monsters.js';
import { createBattleStage } from './battle.js';

const FADE_MS = 480;               // fade-to-black hold before the swap
const GOLD = 0xffd75e;

/* preallocated scratch — the render loop must not allocate */
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();

/* ── little canvas textures (clouds, sun glow, wake foam) ───────────────── */

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
  ctx.globalCompositeOperation = 'source-atop';
  const sh = ctx.createLinearGradient(0, 90, 0, 240);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(120,130,150,0.34)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [k, col] of stops) g.addColorStop(k, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let TEX_CLOUD = null, TEX_GLOW = null, TEX_WAKE = null;
function ensureTextures() {
  if (TEX_CLOUD) return;
  TEX_CLOUD = puffTexture(255, 255, 255);
  TEX_GLOW = radialTexture([
    [0, 'rgba(255,250,225,1)'], [0.18, 'rgba(255,240,190,0.9)'],
    [0.5, 'rgba(255,225,150,0.25)'], [1, 'rgba(255,220,140,0)'],
  ]);
  TEX_WAKE = radialTexture([
    [0, 'rgba(255,255,255,0.85)'], [0.45, 'rgba(230,250,255,0.5)'],
    [1, 'rgba(220,245,255,0)'],
  ]);
}

/* ── per-stage sky dome (legacy shader, themed) ─────────────────────────── */
function makeSky(sky) {
  const geo = new THREE.SphereGeometry(1500, 24, 14);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(sky.zenith) },
      mid: { value: new THREE.Color(sky.mid) },
      horizon: { value: new THREE.Color(sky.horizon) },
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
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -10;
  return m;
}

function makeSunGlow(colorHex) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: TEX_GLOW, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, color: new THREE.Color(colorHex).lerp(new THREE.Color(0xffffff), 0.4),
  }));
  sp.scale.set(220, 220, 1);
  return sp;
}

function makeCloud(rng, big, tint) {
  const cl = new THREE.Group();
  const n = 4 + Math.floor(rng() * 3);
  for (let j = 0; j < n; j++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX_CLOUD, transparent: true, opacity: 0.88, depthWrite: false, color: tint,
    }));
    const s = (16 + rng() * 18) * big;
    sp.scale.set(s, s * 0.62, 1);
    sp.position.set((j - n / 2) * 9 * big + (rng() - 0.5) * 6,
                    rng() * 5 * big, (rng() - 0.5) * 8 * big);
    cl.add(sp);
  }
  return cl;
}

/* gulls: two flapping wing planes on a slow circle (hub ambience) */
function makeGulls(rng, count) {
  const gulls = [];
  for (let i = 0; i < count; i++) {
    const bird = new THREE.Group();
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28),
        flat(0xffffff, { side: THREE.DoubleSide }));
      wing.position.x = s * 0.45;
      wing.userData.side = s;
      bird.add(wing);
    }
    bird.userData = {
      r: 50 + rng() * 170, h: 22 + rng() * 22,
      speed: 0.05 + rng() * 0.08, phase: rng() * 6.28, flap: 4 + rng() * 3,
    };
    gulls.push(bird);
  }
  return gulls;
}

/* dolphin pods porpoising through open water (hub only) */
function makeDolphins(rng, count) {
  const pods = [];
  for (let i = 0; i < count; i++) {
    const pod = new THREE.Group();
    const n = 2 + Math.floor(rng() * 2);
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
    pod.userData = {
      cx: -200 + rng() * 400, cz: -200 + rng() * 400,
      r: 16 + rng() * 26, speed: 0.09 + rng() * 0.07, ph: rng() * 6.28,
    };
    pods.push(pod);
  }
  return pods;
}

/* ── view keys: island groups rebuild only when this changes ────────────── */
function viewKey(node) {
  return [node.type, node.monster ? node.monster.hp : '-',
          node.charges ?? '-', node.solved ?? '-',
          (node.defeated || []).length, (node.stash || []).length,
          node.depth ?? '-', node.mode ?? '-',
          node.region ?? '-'].join(':');
}

function disposeDeep(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (Array.isArray(m)) { for (const mm of m) mm.dispose(); }
    else if (m) {
      if (o.name === 'nametag' && m.map) m.map.dispose();  // per-ship canvas
      m.dispose();
    }
  });
}

/* ═════════════════════════════════════════════════════════════════════════
 *  createWorld
 * ═══════════════════════════════════════════════════════════════════════ */
export function createWorld(container, handlers = {}) {
  ensureTextures();
  preloadProps();          // start loading Meshy island filler props

  /* renderer */
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  /* the fade curtain — CSS (Agent D) provides the .45s opacity transition */
  const fadeEl = document.createElement('div');
  fadeEl.className = 'scenefade';
  fadeEl.style.opacity = '0';
  container.appendChild(fadeEl);

  /* camera + close chase controls */
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4000);
  camera.position.set(0, 34, 58);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 16;
  controls.maxDistance = 84;
  controls.maxPolarAngle = 1.12;
  controls.autoRotateSpeed = 0.45;
  controls.target.set(0, 1.5, 0);

  /* battle stage (separate module, rendered instead of a board stage) */
  const battleStage = createBattleStage(renderer);

  /* ── board bookkeeping ──────────────────────────────────────────────── */
  const stages = {};          // stageId → Stage
  let nodeById = {};          // id → node snapshot
  let nbrs = {};              // id → [ids]
  let boardSig = '';
  let lastRoom = null;
  let myPid = null;
  let viewFollowPid = null;   // whose ship the camera hugs this frame
  let lobbyMode = false;
  let cameraAnchored = false;
  let preloadedCaptain = false;
  let wasLobby = true;        // to catch the lobby → voyage transition
  let cine = null;            // active establishing pan-over, or null
  const seenStages = new Set();

  let activeBoardId = null;   // board stage currently shown (also under battle)
  let battleOn = false;
  let battleKey = null;
  let fading = false;
  let pendingTarget = null;
  let savedCam = null;        // board camera frozen while battling

  const ships = {};           // pid → ship record

  /* shared groups that ride along into whichever stage is active */
  const highlights = new THREE.Group();   // reachable rings
  let hiKey = '';
  /* the Vale's WAYFINDER: in the maze you can't see the stops, so the trail
     itself points the way — gold chevrons along every legal route; tapping
     one sails you toward its destination */
  const valeArrows = new THREE.Group();
  let valeKey = '';
  const ARROW_GEO = new THREE.ConeGeometry(0.55, 1.6, 4);
  const ARROW_MAT = new THREE.MeshStandardMaterial({
    color: 0xffd061, emissive: 0xb9791c, emissiveIntensity: 1.1,
    flatShading: true });
  // a wide, invisible-but-clickable ribbon laid along each Vale trail so you can
  // tap the GROUND you want to walk, not just the little chevrons
  const VALE_STRIP_GEO = new THREE.BoxGeometry(1, 1, 1);   // shared; scaled per strip
  const VALE_STRIP_MAT = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0, depthWrite: false });
  const fx = new THREE.Group();           // wake sprites live here

  /* wake pool: fixed sprites, zero allocation during play */
  const WAKE_N = 90;
  const wakePool = [];
  for (let i = 0; i < WAKE_N; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX_WAKE, transparent: true, depthWrite: false, opacity: 0,
    }));
    sp.visible = false;
    sp.userData = { t0: 0, life: 1.5 };
    fx.add(sp);
    wakePool.push(sp);
  }
  let wakeHead = 0;
  function spawnWake(x, y, z, size) {
    const sp = wakePool[wakeHead];
    wakeHead = (wakeHead + 1) % WAKE_N;
    sp.visible = true;
    sp.position.set(x, y, z);
    sp.scale.set(size, size, 1);
    sp.userData.t0 = performance.now();
    sp.userData.s0 = size;
  }
  function tickWake(now) {
    for (let i = 0; i < WAKE_N; i++) {
      const sp = wakePool[i];
      if (!sp.visible) continue;
      const k = (now - sp.userData.t0) / 1500;
      if (k >= 1) { sp.visible = false; sp.material.opacity = 0; continue; }
      sp.material.opacity = 0.5 * (1 - k) * (1 - k);
      const s = sp.userData.s0 * (1 + k * 1.9);
      sp.scale.set(s, s, 1);
    }
  }

  /* ── stage membership ───────────────────────────────────────────────── */
  function stageHasNode(stageId, nodeId) {
    const n = nodeById[nodeId];
    if (!n) return false;
    if (stageId === 'hub') return !n.region || n.type === 'gate';
    return n.region === stageId;
  }
  function memberNodes(stageId, room) {
    const out = [];
    for (const n of room.board?.nodes || []) {
      if (stageId === 'hub' ? (!n.region || n.type === 'gate') : n.region === stageId) out.push(n);
    }
    return out;
  }
  function stageForViewer(room, you) {
    const me = room.players?.find((p) => p.pid === you);
    if (!me || !me.node) return activeBoardId || 'hub';
    const n = nodeById[me.node];
    if (!n) return activeBoardId || 'hub';
    if (n.type === 'gate') {
      // landing on a pass means you are CROSSING: face the side you came
      // from the other of — arrive from the isles, behold the realm.
      const rec = ships[you];
      const prev = rec?.prevNode ? nodeById[rec.prevNode] : null;
      if (prev && prev.type !== 'gate') {
        const from = prev.region || 'hub';
        const dest = from === 'hub' ? (n.region || 'hub') : 'hub';
        // don't load the realm until the boat has actually SAILED UP to the pass:
        // while it's still crossing (animating in the stage it left from), hold
        // the old stage so the new environment doesn't pop in early.
        if (rec && rec.anim && activeBoardId && activeBoardId !== dest
            && stageHasNode(activeBoardId, rec.prevNode)) {
          return activeBoardId;
        }
        return dest;
      }
      if (activeBoardId && stageHasNode(activeBoardId, me.node)) return activeBoardId;
      return n.region || 'hub';
    }
    return n.region || 'hub';
  }

  /* ── stage construction ─────────────────────────────────────────────── */
  function stageCenter(stageId, room) {
    if (stageId === 'hub') return new THREE.Vector3(0, 0, 0);
    const nodes = memberNodes(stageId, room);
    const c = new THREE.Vector3();
    if (!nodes.length) return c;
    for (const n of nodes) { c.x += n.x; c.z += n.z; }
    c.x /= nodes.length; c.z /= nodes.length;
    return c;
  }

  function buildStage(stageId, room) {
    const theme = themeFor(stageId);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.fog.color);
    scene.fog = new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far);
    const center = stageCenter(stageId, room);
    const rng = mulberry32(hashStr('stage:' + stageId));

    const sky = makeSky(theme.sky);
    sky.position.set(center.x, 0, center.z);
    scene.add(sky);

    const sunDir = new THREE.Vector3().fromArray(theme.sun.position).normalize();
    const sun = new THREE.DirectionalLight(theme.sun.color, theme.sun.intensity);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 900;
    sun.shadow.bias = -0.0004;
    sun.position.copy(center).addScaledVector(sunDir, 380);
    sun.target.position.copy(center);
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity));
    scene.add(new THREE.AmbientLight(theme.ambient, 0.35));

    const glow = makeSunGlow(theme.sun.color);
    glow.position.copy(center).addScaledVector(sunDir, 1300);
    scene.add(glow);

    // trail segments (world space) — needed up-front so the desert floor can
    // keep the LANES flat and roll dunes only in the wilds between them
    let groundSegs = [];
    if (stageId !== 'hub') {
      const gm = memberNodes(stageId, room);
      const gById = new Map(gm.map((n) => [n.id, n]));
      for (const [a, b] of room.board?.edges || []) {
        const na = gById.get(a), nb = gById.get(b);
        if (na && nb) groundSegs.push([na.x, na.z, nb.x, nb.z]);
      }
    }
    const surf = theme.ground === 'sand'
      ? makeGround(theme, 3000, { center, segs: groundSegs })
      : makeWater(theme, 3000);
    surf.mesh.position.x += center.x;
    surf.mesh.position.z += center.z;
    scene.add(surf.mesh);

    /* enclosure: hub gets the mountain wall with its four passes; realms a
     * surrounding crescent backdrop, dense side away from the way home */
    let wall = null;
    if (stageId === 'hub') {
      const gates = (room.board?.nodes || [])
        .filter((n) => n.type === 'gate')
        .map((n) => ({
          angle: n.gate_angle !== undefined ? n.gate_angle : Math.atan2(n.z, n.x),
          realm: n.region,
        }));
      wall = buildMountainWall({ radius: 560, gates, theme });
    } else if (theme.id !== 'autumn') {
      // The Amber Vale has NO mountain backdrop — it's a flat wood that just
      // fades into fog at the edges. Every other realm gets its crescent ridge.
      wall = buildRealmBackdrop(theme, { radius: 520 });
      wall.position.set(center.x, 0, center.z);
      const gate = memberNodes(stageId, room).find((n) => n.type === 'gate');
      if (gate) wall.rotation.y = Math.atan2(gate.x - center.x, gate.z - center.z) + Math.PI;
    }
    if (wall) scene.add(wall);

    /* the wilds between the stops: berg fields, dune seas, vine channels,
       or the Vale's unbroken forest — every realm is FULL, no empty water */
    if (stageId !== 'hub') {
      const members = memberNodes(stageId, room);
      const byId = new Map(members.map((n) => [n.id, n]));
      const segs = [];
      for (const [a, b] of room.board?.edges || []) {
        const na = byId.get(a), nb = byId.get(b);
        if (na && nb) segs.push([na.x, na.z, nb.x, nb.z]);
      }
      scene.add(makeRealmField(theme, members, segs, rng, surf.heightAt));
    }

    /* drifting clouds, tinted faintly toward the horizon color */
    const cloudTint = new THREE.Color(0xffffff).lerp(new THREE.Color(theme.sky.horizon), 0.22);
    const clouds = [];
    for (let i = 0; i < 10; i++) {
      const cl = makeCloud(rng, 0.9 + rng() * 1.6, cloudTint);
      cl.userData = { a: rng() * Math.PI * 2, r: 140 + rng() * 300 };
      cl.position.y = 72 + rng() * 70;
      clouds.push(cl);
      scene.add(cl);
    }

    /* themed particles (snow / leaves / motes / dust); follow the camera */
    let particles = null;
    if (theme.particles) {
      particles = makeParticles(theme.particles);
      scene.add(particles.points);
    }

    /* hub-only fauna */
    let gulls = null, dolphins = null;
    if (stageId === 'hub') {
      gulls = makeGulls(rng, 6);
      for (const b of gulls) scene.add(b);
      dolphins = makeDolphins(rng, 4);
      for (const p of dolphins) scene.add(p);
    }

    const laneGroup = new THREE.Group();
    scene.add(laneGroup);

    return {
      id: stageId, theme, scene, center, rng,
      sun, sunDir, glow, surf, wall, clouds, particles, gulls, dolphins,
      islands: {},           // nodeId → {key, group, proxy, R, plateauY, fxBits}
      proxyList: [],
      laneGroup, laneKey: '',
    };
  }

  function destroyStage(st) {
    disposeDeep(st.scene);
    st.scene.clear();
  }

  /* ── island / lane sync (viewKey semantics) ─────────────────────────── */
  const FX_NAMES = ['foam', 'bob', 'beacon', 'pharosfire', 'monster', 'pharosgate', 'checkpoint'];
  function cacheIslandFx(isle) {
    isle.fxBits = {};
    for (const nm of FX_NAMES) {
      const o = isle.group.getObjectByName(nm);
      if (o) isle.fxBits[nm] = o;
    }
  }

  /* Light one sigil socket per seal the local captain has banked, and swing
     the bronze leaves once all three answer. Blank + shut is the default the
     player meets before earning the seals. */
  function drivePharosGate(gate, t) {
    const me = lastRoom?.players?.find((p) => p.pid === myPid);
    const need = lastRoom?.config?.relics_to_win ?? 3;
    const banked = Math.min(3, me ? me.banked : 0);
    for (let i = 0; i < 3; i++) {
      const s = gate.getObjectByName('sigil' + i);
      if (!s) continue;
      const lit = i < banked;
      const target = lit ? 1.15 + Math.sin(t * 3 + i * 1.7) * 0.4 : 0;
      s.material.emissiveIntensity += (target - s.material.emissiveIntensity) * 0.15;
    }
    const open = banked >= need;
    const cur = gate.userData.open ?? 0;
    const next = cur + ((open ? 1 : 0) - cur) * 0.045;
    gate.userData.open = next;
    const swing = next * Math.PI * 0.6;
    const L = gate.getObjectByName('doorPivotL');
    const R = gate.getObjectByName('doorPivotR');
    if (L) L.rotation.y = swing;
    if (R) R.rotation.y = -swing;
  }

  function syncStage(st, room) {
    const nodes = memberNodes(st.id, room);
    const domains = room.board?.domains || {};
    const present = new Set();
    let proxiesDirty = false;
    for (const node of nodes) {
      present.add(node.id);
      const key = viewKey(node);
      const existing = st.islands[node.id];
      if (existing && existing.key === key) continue;
      if (existing) {
        st.scene.remove(existing.group, existing.proxy);
        disposeDeep(existing.group);
        existing.proxy.geometry.dispose();
      }
      const built = buildIsland(node, st.theme, domains);
      built.group.position.set(node.x, 0, node.z);
      const R = built.R;
      const proxy = new THREE.Mesh(
        new THREE.CylinderGeometry(R + 2.0, R + 2.0, 9, 8),
        new THREE.MeshBasicMaterial({ visible: false }));
      proxy.position.set(node.x, 3, node.z);
      proxy.userData.node = node.id;
      st.scene.add(built.group, proxy);
      st.islands[node.id] = {
        key, group: built.group, proxy, R, plateauY: built.plateauY,
      };
      cacheIslandFx(st.islands[node.id]);
      proxiesDirty = true;
    }
    for (const id of Object.keys(st.islands)) {
      if (present.has(id)) continue;
      const isle = st.islands[id];
      st.scene.remove(isle.group, isle.proxy);
      disposeDeep(isle.group);
      isle.proxy.geometry.dispose();
      delete st.islands[id];
      proxiesDirty = true;
    }
    if (proxiesDirty) st.proxyList = Object.values(st.islands).map((i) => i.proxy);

    /* lanes: subtle dashes between member nodes only */
    const memberSet = present;
    const edges = (room.board?.edges || []).filter(([a, b]) => memberSet.has(a) && memberSet.has(b));
    const ekey = edges.map((e) => e.join('~')).join('|');
    if (ekey !== st.laneKey) {
      st.laneKey = ekey;
      disposeDeep(st.laneGroup);
      st.laneGroup.clear();
      for (const [a, b] of edges) {
        const na = nodeById[a], nb = nodeById[b];
        if (!na || !nb) continue;
        _vA.set(na.x, 0.16, na.z);
        _vB.set(nb.x, 0.16, nb.z);
        _vC.subVectors(_vB, _vA);
        const len = _vC.length();
        _vC.normalize();
        const gapA = (st.islands[a]?.R ?? 5) * 1.3, gapB = (st.islands[b]?.R ?? 5) * 1.3;
        if (len < gapA + gapB + 2) continue;
        if (na.mode === 'foot' || nb.mode === 'foot') {
          // The Amber Vale is a MAZE — no trail is drawn between stops at all;
          // you read the forest and the glowing waypoints and find your own way.
          if (st.theme.id === 'autumn') continue;
          // The desert trail is a real line of worn flagstones through the sand.
          const stoneHex = st.theme.id === 'autumn' ? 0x8d7c60 : 0xe6d7ae;
          const trailRng = mulberry32(hashStr('trail:' + a + '~' + b));
          const run = len - gapA - gapB;
          const nStones = Math.max(2, Math.floor(run / 3.2));
          const stoneMat = flat(stoneHex);
          for (let i = 0; i <= nStones; i++) {
            const d = gapA + (i / nStones) * run;
            const stone = new THREE.Mesh(
              new THREE.CylinderGeometry(0.45 + trailRng() * 0.35,
                                         0.55 + trailRng() * 0.4, 0.12, 6),
              stoneMat);
            stone.position.set(
              na.x + _vC.x * d + (trailRng() - 0.5) * 1.4, 0.07,
              na.z + _vC.z * d + (trailRng() - 0.5) * 1.4);
            stone.rotation.y = trailRng() * 3.14;
            stone.receiveShadow = true;
            st.laneGroup.add(stone);
          }
          continue;
        }
        const pts = [_vA.clone().addScaledVector(_vC, gapA),
                     _vA.clone().addScaledVector(_vC, len - gapB)];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({
          color: 0xffffff, transparent: true, opacity: 0.32,
          dashSize: 2.0, gapSize: 2.8 });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        st.laneGroup.add(line);
      }
    }
  }

  function syncValeArrows(room) {
    const me = room?.players?.find((p) => p.pid === myPid);
    const want = activeBoardId === 'autumn' && !battleOn && !fading
      && room?.phase === 'sail' && room.turn === myPid
      && me && room.reachable && Object.keys(room.reachable).length;
    const key = want
      ? me.node + '|' + Object.keys(room.reachable).sort().join(',')
      : '';
    if (key === valeKey) return;
    valeKey = key;
    valeArrows.clear();
    if (!want) return;
    const _dir = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);
    for (const dest of Object.keys(room.reachable)) {
      const path = sailPath(me.node, dest);
      if (!path || path.length < 2) continue;
      // sample chevrons at fixed distances down the trail (the fog line is
      // close — only the first stretch is ever visible anyway)
      const pts = path.map((id) => nodeById[id]).filter(Boolean);
      // a wide invisible click-ribbon along the visible trail toward this fork —
      // tap anywhere on the GROUND path to take it
      let acc = 0;
      for (let i = 0; i + 1 < pts.length && acc < 34; i++) {
        const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
        const seg = Math.hypot(bx - ax, bz - az) || 1e-6;
        const L = Math.min(seg, 34 - acc);
        const strip = new THREE.Mesh(VALE_STRIP_GEO, VALE_STRIP_MAT);
        strip.scale.set(9, 0.9, L + 2.5);
        strip.position.set(ax + (bx - ax) * (L / 2 / seg), 0.45, az + (bz - az) * (L / 2 / seg));
        strip.rotation.y = Math.atan2(bx - ax, bz - az);
        strip.userData.node = dest;                 // no ph → not bobbed
        valeArrows.add(strip);
        acc += seg;
      }
      let target = 6;
      let walked = 0;
      for (let i = 0; i + 1 < pts.length && target <= 30; i++) {
        const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
        const seg = Math.hypot(bx - ax, bz - az) || 1e-6;
        while (target <= walked + seg && target <= 30) {
          const t = (target - walked) / seg;
          const arrow = new THREE.Mesh(ARROW_GEO, ARROW_MAT);
          arrow.position.set(ax + (bx - ax) * t, 0.5, az + (bz - az) * t);
          _dir.set(bx - ax, 0, bz - az).normalize();
          arrow.quaternion.setFromUnitVectors(_up, _dir);
          arrow.userData.node = dest;
          arrow.userData.ph = target;
          valeArrows.add(arrow);
          target += 6.5;
        }
        walked += seg;
      }
    }
  }

  /* ── routing helpers (visual sail paths along real lanes) ───────────── */
  function sailPath(from, to) {
    if (!nbrs[from] || !nbrs[to]) return null;
    const prev = { [from]: null };
    const dq = [from];
    while (dq.length) {
      const cur = dq.shift();
      if (cur === to) break;
      for (const nb of nbrs[cur] || []) {
        if (nb in prev) continue;
        if (nb !== to && nodeById[nb]?.type === 'pharos') continue;
        prev[nb] = cur;
        dq.push(nb);
      }
    }
    if (!(to in prev)) return null;
    const path = [];
    for (let cur = to; cur !== null; cur = prev[cur]) path.unshift(cur);
    return path;
  }

  function gateBerth(n, st, slotIdx) {
    // Berth a ship on the channel centerline (the radial axis through the arch),
    // on the side of the arch that belongs to the stage we're viewing — the hub
    // side while approaching, the realm side once across — so you come at the
    // pass head-on and pass THROUGH it, never around it. A small lateral fan
    // lets two ships share the mouth without overlapping.
    const rad = new THREE.Vector3(n.x, 0, n.z).normalize();   // outward (radial)
    const inRealm = !!(st && st.id !== 'hub');
    // HUB side (approaching): berth INWARD of the pass so the arch is ahead and
    // you sail/step OUT through it. REALM side (arrived): berth just PAST the
    // arch, out on the realm ground, so you stand clear of the structure at the
    // gate and simply walk on to the first waypoint — never spawning inside it.
    const along = inRealm ? 26 : 14;
    const dir = inRealm ? 1 : -1;                    // realm: outward; hub: inward
    const fan = ((slotIdx % 3) - 1) * 3.0;
    return new THREE.Vector3(
      n.x + dir * rad.x * along - rad.z * fan, 0,
      n.z + dir * rad.z * along + rad.x * fan);
  }

  function slotFor(nodeId, slotIdx, st) {
    const n = nodeById[nodeId];
    if (n && n.type === 'gate') return gateBerth(n, st, slotIdx);
    const isle = st && st.islands[nodeId];
    const R = isle?.R ?? 4;
    const a = (slotIdx / 6) * Math.PI * 2 + 0.8;
    const r = R * 1.55 + 1.2;
    return new THREE.Vector3((n?.x ?? 0) + Math.cos(a) * r, 0, (n?.z ?? 0) + Math.sin(a) * r);
  }

  function lanePoint(nid, fromPos, st) {
    const n = nodeById[nid];
    const p = new THREE.Vector3(n.x, 0, n.z);
    if (n.type !== 'sea') {
      const r = (st?.islands[nid]?.R ?? 8) * 1.25 + 3.5;
      _vD.subVectors(p, fromPos).normalize();
      p.x += -_vD.z * r;
      p.z += _vD.x * r;
    }
    return p;
  }

  /* ── ships & the walking captain ────────────────────────────────────── */
  function makeTurnMarker() {
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.75, 6),
      flat(GOLD, { emissive: 0x9a6a10 }));
    m.name = 'turnMarker';
    m.rotation.x = Math.PI;
    m.position.y = 4.6;
    return m;
  }

  function ensureShip(p, idx) {
    let rec = ships[p.pid];
    const tagKey = p.name + '|' + p.color;
    if (rec && rec.tagKey !== tagKey) { removeShip(p.pid); rec = null; }
    if (rec) return rec;
    const root = new THREE.Group();
    const galley = makeShip(p.color);
    galley.scale.setScalar(2);
    galley.name = 'galley';
    const tag = nameSprite(p.name, p.color);
    tag.position.y = 5.2;
    root.add(galley, tag);
    rec = {
      pid: p.pid, root, galley, captain: null, captainReq: false,
      tag, tagKey, color: p.color,
      node: p.node, idx, stageId: null, mode: 'sail',
      anim: null, phase: Math.random() * 6, lastWake: 0, needPlace: true,
    };
    ships[p.pid] = rec;
    return rec;
  }

  function removeShip(pid) {
    const rec = ships[pid];
    if (!rec) return;
    if (rec.stageId && stages[rec.stageId]) stages[rec.stageId].scene.remove(rec.root);
    disposeDeep(rec.root);
    delete ships[pid];
  }

  function setShipStage(rec, stageId) {
    if (rec.stageId === stageId) return;
    if (rec.stageId && stages[rec.stageId]) stages[rec.stageId].scene.remove(rec.root);
    rec.stageId = stageId;
    if (stageId && stages[stageId]) {
      stages[stageId].scene.add(rec.root);
      rec.needPlace = true;
    }
  }

  function applyMode(rec) {
    const foot = rec.mode === 'foot';
    rec.galley.visible = !foot || !rec.captain;
    if (rec.captain) rec.captain.visible = foot;
    if (foot && !rec.captain && !rec.captainReq) {
      rec.captainReq = true;
      getMonster('captain', { tint: rec.color }).then((g) => {
        if (!ships[rec.pid]) return;               // player left meanwhile
        g.name = 'captain';
        g.scale.setScalar(1.8);
        rec.captain = g;
        rec.root.add(g);
        applyMode(rec);
      }).catch(() => {});
    }
  }

  function avoidIslands(rawPts, st) {
    /* Densify the route, then push every sample out of each island's
       footprint — the hull arcs around land instead of cutting across it.
       Endpoints (current position, destination slot) stay fixed. */
    // Clearance is island footprint + a berth wide enough for the GALLEY's
    // own reach: its bow and stern sit ~4 units off centre and swing inward on
    // a turn, so the path (which only tracks the hull's centre) must stand off
    // far enough that the whole hull clears, not just its midpoint.
    const HULL_CLEAR = 5.0;
    const solids = [];
    for (const [nid, isle] of Object.entries(st.islands)) {
      const n = nodeById[nid];
      if (!n || n.type === 'sea' || n.type === 'gate') continue;
      solids.push({ x: n.x, z: n.z, r: (isle.R ?? 8) * 1.2 + HULL_CLEAR });
    }
    const pts = [];
    pts.push(rawPts[0].clone());
    for (let i = 1; i < rawPts.length; i++) {
      const a = rawPts[i - 1], b = rawPts[i];
      const nSeg = Math.max(1, Math.ceil(a.distanceTo(b) / 2));   // finer: less chord sag
      for (let s = 1; s <= nSeg; s++) {
        pts.push(new THREE.Vector3().lerpVectors(a, b, s / nSeg));
      }
    }
    if (!solids.length || pts.length < 3) return pts;
    const pushOut = () => {
      for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i];
        for (const c of solids) {
          const dx = p.x - c.x, dz = p.z - c.z;
          const d = Math.hypot(dx, dz);
          if (d >= c.r) continue;
          if (d > 1e-4) {
            const k = c.r / d;
            p.x = c.x + dx * k;
            p.z = c.z + dz * k;
          } else {
            p.x = c.x + c.r;                 // dead center: pick a side
          }
        }
      }
    };
    pushOut();
    for (let pass = 0; pass < 3; pass++) {   // soften the tangent kinks…
      for (let i = 1; i < pts.length - 1; i++) {
        pts[i].x = pts[i].x * 0.6 + (pts[i - 1].x + pts[i + 1].x) * 0.2;
        pts[i].z = pts[i].z * 0.6 + (pts[i - 1].z + pts[i + 1].z) * 0.2;
      }
      pushOut();                             // …but never back onto land
    }
    return pts;
  }

  function startTravel(rec, toNode, st) {
    const route = sailPath(rec.prevNode, toNode);
    const raw = [rec.root.position.clone()];
    if (route && route.length > 2) {
      for (const nid of route.slice(1, -1)) {
        if (nodeById[nid]) raw.push(lanePoint(nid, raw[raw.length - 1], st));
      }
    }
    const dest = nodeById[toNode];
    if (dest && dest.type === 'gate') {
      // approach the isles-facing berth straight down the channel (the berth
      // itself is inward of the arch — see gateBerth), so run in from further in
      const rad = _vD.set(dest.x, 0, dest.z).normalize();
      raw.push(new THREE.Vector3(dest.x - rad.x * 46, 0, dest.z - rad.z * 46));
    }
    raw.push(slotFor(toNode, rec.idx, st));
    const pts = avoidIslands(raw, st);
    rec.arrivalPending = true;
    let total = 0;
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
      const len = pts[i].distanceTo(pts[i - 1]);
      legs.push(len);
      total += len;
    }
    const foot = rec.mode === 'foot';
    // unhurried: a voyage should read as a voyage, not a teleport
    rec.anim = {
      pts, legs, total, t0: performance.now(),
      dur: foot ? Math.min(9000, 900 + total * 52) : Math.min(8000, 700 + total * 40),
    };
  }

  /* a realm crossed on foot (the desert): its captain walks, no boat */
  function isFootStage(stageId) {
    return !!(stageId && stageId !== 'hub'
      && lastRoom?.board?.regions?.[stageId]?.mode === 'foot');
  }

  function syncShips(room, you) {
    const playersByPid = {};
    room.players?.forEach((p, idx) => {
      playersByPid[p.pid] = p;
      const rec = ensureShip(p, idx);
      rec.idx = idx;

      const moved = rec.node !== p.node;
      if (moved) { rec.prevNode = rec.node; rec.node = p.node; }

      // which stage does this ship live in now? (gates belong to two)
      const targetStage = stageHasNode(activeBoardId, rec.node) ? activeBoardId : null;
      // the ship's form follows that STAGE: afloat on water, on foot on sand —
      // so you become the captain the moment you're shown in the desert (even
      // at its pass), and never a boat gliding over the dunes.
      const foot = isFootStage(targetStage);
      const modeChanged = foot !== (rec.mode === 'foot');
      if (modeChanged) rec.mode = foot ? 'foot' : 'sail';

      let doTravel = false;
      if (moved) {
        const inActive = stageHasNode(activeBoardId, p.node);
        const fromIn = stageHasNode(activeBoardId, rec.prevNode);
        if (inActive && fromIn && rec.stageId === activeBoardId && !rec.needPlace) {
          doTravel = true;
        } else {
          rec.anim = null;
          rec.needPlace = true;
        }
      }
      setShipStage(rec, targetStage);
      if (modeChanged || (foot && !rec.captain)) applyMode(rec);
      if (doTravel) startTravel(rec, rec.node, stages[activeBoardId]);
      if (rec.needPlace && rec.stageId && stages[rec.stageId]) {
        rec.root.position.copy(slotFor(rec.node, rec.idx, stages[rec.stageId]));
        // spawned at a realm pass: face INTO the realm (outward, away from the
        // gate) so you're looking at the road ahead, not back at the wall
        const pn = nodeById[rec.node];
        const st = stages[rec.stageId];
        if (pn && pn.type === 'gate' && st && st.id !== 'hub') {
          rec.root.rotation.y = Math.atan2(-pn.z, pn.x);   // outward radial heading
        }
        rec.needPlace = false;
      }
      /* turn marker */
      const isTurn = p.pid === room.turn && room.phase !== 'lobby' && room.phase !== 'finished';
      let marker = rec.root.getObjectByName('turnMarker');
      if (isTurn && !marker) rec.root.add(makeTurnMarker());
      else if (!isTurn && marker) {
        rec.root.remove(marker);
        marker.geometry.dispose();
        marker.material.dispose();
      }
    });
    for (const pid of Object.keys(ships)) {
      if (!playersByPid[pid]) removeShip(pid);
    }
    // viewFollowPid is recomputed every frame in tickCamera (it depends on
    // live sail-animation state, not just the snapshot).
  }

  /* whose ship is mid-voyage right now, if anyone's (turn-based → at most
   * one). The camera stays glued to a moving ship even after the turn has
   * advanced, so a captain finishes sailing on-screen before the view hands
   * off to the next. */
  function animatingPid() {
    for (const pid in ships) {
      if (ships[pid].anim) return pid;
    }
    return null;
  }

  function focusPid(room) {
    const moving = animatingPid();
    if (moving) return moving;                       // watch the sail finish
    if (room && room.phase !== 'lobby' && room.phase !== 'finished'
        && ships[room.turn]) return room.turn;        // then the active captain
    return ships[myPid] ? myPid : (room ? room.turn : null);
  }

  /* ── reachable highlight rings ──────────────────────────────────────── */
  function syncHighlights(room, you) {
    const st = stages[activeBoardId];
    if (!st) return;
    const myTurn = room.turn === you && room.phase === 'sail' && !room.battle;
    // standing on a pass, destinations straddle the wall — show them ALL
    // (rings past the pass mouth read as "through there"); everywhere else,
    // only this stage's waters light up.
    const onGate = nodeById[room.players?.find((p) => p.pid === you)?.node]?.type === 'gate';
    const ids = myTurn
      ? Object.keys(room.reachable || {})
          .filter((id) => onGate || stageHasNode(activeBoardId, id)).sort()
      : [];
    const key = activeBoardId + '#' + ids.join(',');
    if (key === hiKey) return;
    hiKey = key;
    disposeDeep(highlights);
    highlights.clear();
    for (const nid of ids) addBeacon(nid, nodeById[nid], st.islands[nid]?.R ?? 5);
  }

  /* A bold "you can land here" beacon: a bright ring on the water, a shaft of
   * gold light, and a big downward chevron hovering over the spot. Unmistakable
   * from the low chase camera, and steady (gentle bob, no harsh flicker).
   * Every piece is a click target and carries userData.node. */
  const HL_BRIGHT = 0xffe27a;
  function addBeacon(nid, n, R) {
    const x = n?.x ?? 0, z = n?.z ?? 0;
    const rr = Math.max(3.6, R);
    const bmat = () => new THREE.MeshBasicMaterial({ color: HL_BRIGHT,
      transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false });

    const ring = new THREE.Mesh(new THREE.RingGeometry(rr * 1.25, rr * 1.55, 44), bmat());
    ring.material.opacity = 0.85;
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.32, z);
    ring.renderOrder = 6;
    ring.userData = { node: nid, role: 'ring' };

    // a soft second ring for a halo so it reads on bright sand too
    const halo = new THREE.Mesh(new THREE.RingGeometry(rr * 0.2, rr * 1.25, 40), bmat());
    halo.material.opacity = 0.14;
    halo.material.blending = THREE.AdditiveBlending;
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(x, 0.28, z);
    halo.renderOrder = 5;
    halo.userData = { node: nid, role: 'halo' };

    // a slim shaft of light — narrow enough to leave the island readable
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(rr * 0.28, rr * 0.5, 13, 20, 1, true), bmat());
    beam.material.opacity = 0.12;
    beam.material.blending = THREE.AdditiveBlending;
    beam.position.set(x, 7.5, z);
    beam.renderOrder = 6;
    beam.userData = { node: nid, role: 'beam' };

    // a bright downward chevron floating well above the spot
    const chSize = Math.min(rr * 0.5, 2.6);
    const chev = new THREE.Mesh(new THREE.ConeGeometry(chSize, chSize * 1.5, 4), bmat());
    chev.material.opacity = 1;
    chev.rotation.x = Math.PI;                       // point down at the spot
    chev.position.set(x, 9, z);
    chev.renderOrder = 8;
    chev.userData = { node: nid, role: 'chev', ph: (hashStr(nid) % 628) / 100 };

    const disc = new THREE.Mesh(new THREE.CircleGeometry(rr * 1.8, 16),
      new THREE.MeshBasicMaterial({ visible: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.4, z);
    disc.userData = { node: nid, role: 'disc' };

    highlights.add(ring, halo, beam, chev, disc);
  }

  /* ── stage switching (with the ink fade) ────────────────────────────── */
  function snapBehindShip(rec) {
    const yaw = rec.root.rotation.y;
    _vA.set(Math.cos(yaw), 0, -Math.sin(yaw));            // ship forward (+x model axis)
    controls.target.copy(rec.root.position).addScaledVector(_vA, 3);
    controls.target.y = 1.6;
    camera.position.copy(rec.root.position).addScaledVector(_vA, -26);
    camera.position.y = 13;
  }

  function activateBoard(stageId) {
    if (!stages[stageId] && lastRoom) stages[stageId] = buildStage(stageId, lastRoom);
    const st = stages[stageId];
    if (!st) return;
    const prevId = activeBoardId;
    activeBoardId = stageId;
    if (lastRoom) syncStage(st, lastRoom);
    /* move the ride-along groups into this scene */
    st.scene.add(highlights, fx, valeArrows);
    hiKey = '';
    for (const sp of wakePool) sp.visible = false;
    if (lastRoom) {
      syncShips(lastRoom, myPid);
      syncHighlights(lastRoom, myPid);
    }
    if (prevId !== stageId) {
      const mine = ships[myPid];
      if (mine && mine.stageId === stageId) snapBehindShip(mine);
    }
  }

  function enterBattle(room) {
    const b = room.battle;
    const node = nodeById[b.node];
    const theme = themeFor(b.is_pharos ? 'pharos' : (b.region || node?.region || 'hub'));
    const fighter = room.players?.find((p) => p.pid === room.turn);
    // the final trial is fought on foot atop the Pharos — the captain climbs
    // the lighthouse to face the Dark Presence, boat left far below.
    const heroKind = (b.is_pharos || node?.mode === 'foot') ? 'captain' : 'ship';
    battleKey = b.node + '|' + (fighter?.pid || '') + '|' + (b.round != null ? 'r' : '');
    battleStage.enter({
      battle: b, room, you: myPid, theme,
      heroColor: fighter?.color || '#e4572e', heroKind,
    });
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    battleStage.resize(w, h);
  }

  function applyTarget(tgt) {
    if (tgt === 'battle') {
      if (!battleOn) {
        savedCam = { pos: camera.position.clone(), target: controls.target.clone(), stage: activeBoardId };
        battleOn = true;
        controls.enabled = false;
        if (lastRoom?.battle) enterBattle(lastRoom);
      }
    } else {
      const wasBattle = battleOn;
      if (battleOn) {
        battleStage.exit();
        battleOn = false;
        battleKey = null;
        controls.enabled = true;
      }
      activateBoard(tgt);
      if (wasBattle && savedCam) {
        if (savedCam.stage === tgt) {
          camera.position.copy(savedCam.pos);
          controls.target.copy(savedCam.target);
        } else {
          const mine = ships[myPid];
          if (mine && mine.stageId === tgt) snapBehindShip(mine);
        }
        savedCam = null;
      }
    }
  }

  /* true while the player whose turn it is has a ship still sailing to its
   * landing node in the stage we're watching — the cue app.js uses to hold
   * combat / puzzle cards until the boat actually arrives. */
  function arriving(room) {
    const mover = room?.turn;
    const rec = mover && ships[mover];
    return !!(rec && rec.anim && rec.stageId === activeBoardId);
  }

  function onShipArrive(pid) {
    if (!lastRoom) return;
    // a boat just made landfall — re-home the view (the moving ship may have
    // been carrying the camera; now hand off to the active captain / battle)
    requestStage(desiredTarget(lastRoom));
    // let the UI re-render on ANY arrival: the turn captain's own encounter
    // card waits on their boat, and the *next* captain's roll button waits on
    // the previous captain's boat parking (the handoff case).
    handlers.onArrive?.(pid);
  }

  function desiredTarget(room) {
    if (!room) return activeBoardId || 'hub';
    // hold the cut to the battle stage until the boat finishes sailing up
    if (room.battle && !arriving(room)) return 'battle';
    // stay in the stage of whoever is actually on the move (or the active
    // captain once everyone's parked)
    return stageForViewer(room, focusPid(room) || myPid);
  }

  function requestStage(target) {
    const current = battleOn ? 'battle' : activeBoardId;
    if (fading) { pendingTarget = target; return; }
    if (target === current) return;
    if (activeBoardId === null && target !== 'battle') {
      /* very first board: no curtain, just appear */
      activateBoard(target);
      handlers.onStageChange?.(target);
      return;
    }
    fading = true;
    pendingTarget = target;
    fadeEl.style.opacity = '1';
    setTimeout(() => {
      const tgt = pendingTarget;
      applyTarget(tgt);
      fadeEl.style.opacity = '0';
      fading = false;
      pendingTarget = null;
      handlers.onStageChange?.(tgt);
      /* the world may have moved on while the curtain was down — but the
       * opening tour owns the stage while it runs */
      const want = tour ? tour.legs[tour.i]?.stage : desiredTarget(lastRoom);
      if (want && want !== (battleOn ? 'battle' : activeBoardId)) requestStage(want);
    }, FADE_MS);
  }

  /* ── snapshot sync (idempotent) ─────────────────────────────────────── */
  function clearWorld() {
    for (const pid of Object.keys(ships)) removeShip(pid);
    for (const id of Object.keys(stages)) {
      destroyStage(stages[id]);
      delete stages[id];
    }
    activeBoardId = null;
    hiKey = '';
    cameraAnchored = false;
    cine = null;
    wasLobby = true;
    loadGate = false;      // rematch: gate again (cached promises resolve fast)
    seenStages.clear();
  }

  function update(room, you) {
    myPid = you;
    lastRoom = room;
    if (!room) return;
    lobbyMode = room.phase === 'lobby';

    const nodes = room.board?.nodes || [];
    nodeById = {};
    for (const n of nodes) nodeById[n.id] = n;
    nbrs = {};
    for (const [a, b] of room.board?.edges || []) {
      (nbrs[a] = nbrs[a] || []).push(b);
      (nbrs[b] = nbrs[b] || []).push(a);
    }
    if (!nodes.length) return;

    /* rematch / new sea detection */
    const home = nodeById.home;
    const sig = `${home?.x},${home?.z}:${room.code}:${nodes.length}`;
    if (boardSig && boardSig !== sig) clearWorld();
    boardSig = sig;

    if (!preloadedCaptain && nodes.some((n) => n.mode === 'foot')) {
      preloadedCaptain = true;
      preloadMonsters(['captain']);
    }

    /* bootstrap the very first board so ships have a stage to sync into */
    if (activeBoardId === null) requestStage(desiredTarget(room));

    /* keep the visible board stage in sync (also under a battle, so the
     * return trip is instant). Sync ships BEFORE choosing the stage below:
     * a captain who just began sailing must be recognized as the focus, or
     * the view flips to the next captain's realm for a frame and snaps back
     * — the "region shows up then switches right back" glitch. */
    if (activeBoardId && stages[activeBoardId]) {
      syncStage(stages[activeBoardId], room);
      syncShips(room, you);
      syncHighlights(room, you);
    }

    /* now pick the stage — stays glued to whoever is mid-sail, and only hands
     * off to the next captain once their boat has actually parked. The
     * opening tour owns the stage while it runs. */
    if (!tour) requestStage(desiredTarget(room));

    /* establishing pan: once when the voyage begins, and each time you first
     * cross into a new realm (never in the lobby, never mid-battle) */
    if (wasLobby && !lobbyMode && activeBoardId && !battleOn) {
      seenStages.add(activeBoardId);
      gateTourThenStart();               // preload → loading bar → fly-over
    }
    wasLobby = lobbyMode;

    /* battle re-key: a brand-new fight arriving while one is showing */
    if (battleOn && room.battle) {
      const fighter = room.players?.find((p) => p.pid === room.turn);
      const key = room.battle.node + '|' + (fighter?.pid || '') + '|' + (room.battle.round != null ? 'r' : '');
      if (key !== battleKey) {
        battleStage.exit();
        enterBattle(room);
      }
    }

    /* lobby: park the view on Home Port and drift */
    if (lobbyMode && !cameraAnchored && stages[activeBoardId]?.islands.home) {
      cameraAnchored = true;
      const hp = nodeById.home;
      controls.target.set(hp.x, 1.5, hp.z);
      camera.position.set(hp.x + 8, 26, hp.z + 48);
    }
  }

  /* ── clicking islands (proxy cylinders on the active stage) ─────────── */
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    downAt = [e.clientX, e.clientY];
    skipCinematic();          // any touch cuts the establishing pan short
    endTour();                // …and the opening tour
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 6 || battleOn || fading || mapMode) return;  // the chart is view-only
    const st = stages[activeBoardId];
    if (!st || !st.proxyList.length) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(
      [...st.proxyList, ...highlights.children, ...valeArrows.children], false)
      .find((h) => h.object.userData.node);
    if (hit) handlers.onNodeClick?.(hit.object.userData.node);
  });

  /* ── resize ─────────────────────────────────────────────────────────── */
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    battleStage.resize(w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ── per-frame animation ────────────────────────────────────────────── */
  function tickAmbience(st, t) {
    st.surf.update(t);
    st.wall?.userData?.update?.(t);
    if (st.particles) {
      st.particles.points.position.x = controls.target.x;
      st.particles.points.position.z = controls.target.z;
      st.particles.update(t);
    }
    for (let i = 0; i < st.clouds.length; i++) {
      const cl = st.clouds[i];
      cl.userData.a += 0.00022;
      cl.position.x = st.center.x + Math.cos(cl.userData.a) * cl.userData.r;
      cl.position.z = st.center.z + Math.sin(cl.userData.a) * cl.userData.r;
    }
    if (st.gulls) {
      for (const bird of st.gulls) {
        const u = bird.userData;
        const a = t * u.speed + u.phase;
        bird.position.set(Math.cos(a) * u.r, u.h + Math.sin(t * 0.7 + u.phase) * 1.2, Math.sin(a) * u.r);
        bird.rotation.y = -a - Math.PI / 2;
        for (const wing of bird.children) {
          wing.rotation.x = Math.sin(t * u.flap) * 0.55 * wing.userData.side;
        }
      }
    }
    if (st.dolphins) {
      for (const pod of st.dolphins) {
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
    }
    /* island bits cached at build: foam pulse, buoy bob, beacon spin, fires */
    for (const id in st.islands) {
      const isle = st.islands[id];
      const fxb = isle.fxBits;
      const px = isle.group.position.x, pz = isle.group.position.z;
      if (fxb.foam) {
        const s = 1 + Math.sin(t * 1.3 + px) * 0.045;
        fxb.foam.scale.set(s, s, 1);
      }
      if (fxb.bob) {
        fxb.bob.position.y = Math.sin(t * 1.7 + px * 0.5) * 0.14;
        fxb.bob.rotation.z = Math.sin(t * 1.3 + pz * 0.4) * 0.08;
      }
      if (fxb.beacon) fxb.beacon.rotation.y = t * 0.5;
      if (fxb.pharosfire) {
        const pulse = 1 + Math.sin(t * 2.2) * 0.16;
        fxb.pharosfire.scale.set(pulse, pulse, pulse);
      }
      if (fxb.pharosgate) drivePharosGate(fxb.pharosgate, t);
      if (fxb.checkpoint) {
        // the azure checkpoint light breathes slowly — alive, never off
        const k = 1 + Math.sin(t * 1.4 + px * 0.3) * 0.12;
        const halo = fxb.checkpoint.children[3];
        if (halo) halo.scale.set(7 * k, 7 * k, 1);
      }
      if (fxb.monster) fxb.monster.position.y += Math.sin(t * 2 + pz) * 0.0035;
    }
  }

  function tickShips(st, t, now) {
    let arrived = null;
    for (const pid in ships) {
      const rec = ships[pid];
      if (rec.stageId !== st.id) continue;
      let moving = false;
      if (rec.anim) {
        const k = Math.min(1, (now - rec.anim.t0) / rec.anim.dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        let dAlong = e * rec.anim.total;
        let seg = 0;
        while (seg < rec.anim.legs.length - 1 && dAlong > rec.anim.legs[seg]) {
          dAlong -= rec.anim.legs[seg];
          seg++;
        }
        const a = rec.anim.pts[seg], b = rec.anim.pts[seg + 1];
        const f = rec.anim.legs[seg] > 0 ? dAlong / rec.anim.legs[seg] : 1;
        rec.root.position.lerpVectors(a, b, Math.min(1, f));
        _vA.subVectors(b, a);
        if (_vA.lengthSq() > 0.01) {
          const want = Math.atan2(-_vA.z, _vA.x);
          let diff = want - rec.root.rotation.y;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          rec.root.rotation.y += diff * 0.15;          // smooth helm turns
        }
        moving = true;
        if (k >= 1) {
          rec.anim = null; moving = false;
          if (rec.arrivalPending) { rec.arrivalPending = false; arrived = rec.pid; }
        }
        /* wake foam while the galley sails */
        if (moving && rec.galley.visible && now - rec.lastWake > 95) {
          rec.lastWake = now;
          const yaw = rec.root.rotation.y;
          spawnWake(
            rec.root.position.x - Math.cos(yaw) * 2.6,
            0.14,
            rec.root.position.z + Math.sin(yaw) * 2.6,
            1.3 + Math.random() * 0.5);
        }
      }
      if (rec.galley.visible) {
        rec.galley.position.y = Math.sin(t * 1.9 + rec.phase) * 0.1;
        rec.galley.rotation.z = Math.sin(t * 1.4 + rec.phase) * 0.04;
      }
      if (rec.captain && rec.captain.visible) {
        animateMonster(rec.captain, t + rec.phase, moving ? 'walk' : 'idle');
      }
      const marker = rec.root.getObjectByName('turnMarker');
      if (marker) {
        marker.rotation.y = t * 2.2;
        marker.position.y = 4.6 + Math.sin(t * 2.6) * 0.18;
      }
    }
    if (arrived) onShipArrive(arrived);
  }

  function tickHighlights(t) {
    for (const o of highlights.children) {
      const role = o.userData.role;
      if (role === 'ring') {
        o.material.opacity = 0.7 + Math.sin(t * 2.0) * 0.15;   // steady breathe
      } else if (role === 'halo') {
        o.material.opacity = 0.1 + Math.sin(t * 2.0 + 0.6) * 0.05;
      } else if (role === 'beam') {
        o.material.opacity = 0.12 + Math.sin(t * 2.0 + 1.0) * 0.05;
      } else if (role === 'chev') {
        o.position.y = 8.6 + Math.sin(t * 2.4 + o.userData.ph) * 0.45;  // gentle bob
        o.rotation.y = t * 1.4;                                  // slow spin
      }
    }
  }

  /* ── establishing pan-over: sweep the map, then swoop to your boat ───── */
  function stageCentroid(st) {
    let sx = 0, sz = 0, n = 0;
    for (const id in st.islands) {
      const nd = nodeById[id];
      if (!nd) continue;
      sx += nd.x; sz += nd.z; n++;
    }
    return n ? new THREE.Vector3(sx / n, 0, sz / n) : new THREE.Vector3();
  }

  function startCinematic(st) {
    // orbit the arrival point (your boat), not the whole realm — keeps the
    // boat framed and the camera clear of distant backdrop glows
    const fp = focusPid(lastRoom);
    const rec = fp ? ships[fp] : null;
    const origin = (rec && rec.stageId === st.id)
      ? rec.root.position.clone() : stageCentroid(st);
    origin.y = 0;
    // SAILING INTO A REALM: ride in WITH the ship — start just behind the
    // pass, glide through the arch and out into the open wilds. (The ship
    // record may not have crossed stages yet, so read the mover's NODE.)
    if (st.id !== 'hub') {
      const mover = fp ? lastRoom?.players?.find((pl) => pl.pid === fp) : null;
      const mnode = mover ? nodeById[mover.node] : null;
      const gate = Object.values(nodeById).find(
        (n) => n.type === 'gate' && n.region === st.id);
      if (gate && mnode && mnode.region === st.id
          && Math.hypot(mnode.x - gate.x, mnode.z - gate.z) < 140) {
        const gl = Math.hypot(gate.x, gate.z) || 1;
        cine = {
          t0: performance.now(), dur: 5200, mode: 'gate',
          origin: new THREE.Vector3(mnode.x, 0, mnode.z),
          gate: { x: gate.x, z: gate.z },
          from: { x: gate.x * (gl - 42) / gl, z: gate.z * (gl - 42) / gl },
        };
        return;
      }
    }
    const startAzi = Math.atan2(camera.position.z - origin.z,
                                camera.position.x - origin.x);
    cine = { t0: performance.now(), dur: 4400, origin, startAzi };
  }

  function skipCinematic() { cine = null; }

  function tickCinematic(st, now) {
    const k = (now - cine.t0) / cine.dur;
    if (k >= 1) { cine = null; return false; }
    const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (cine.mode === 'gate') {
      // through the arch: hub side of the pass → low over the channel →
      // settle in behind the boat, the realm opening up ahead
      const o = cine.origin;
      let dx = o.x - cine.gate.x, dz = o.z - cine.gate.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const ex = o.x - dx * 22, ez = o.z - dz * 22;   // end: just astern
      const cx = cine.from.x + (ex - cine.from.x) * ease;
      const cz = cine.from.z + (ez - cine.from.z) * ease;
      camera.position.set(cx, 8 + 5 * ease, cz);
      controls.target.set(
        cine.gate.x + (o.x - cine.gate.x) * ease,
        7 - 5.4 * ease,
        cine.gate.z + (o.z - cine.gate.z) * ease);
      controls.update();
      st.sun.position.copy(controls.target).addScaledVector(st.sunDir, 380);
      st.sun.target.position.copy(controls.target);
      return true;
    }
    const o = cine.origin;
    const azi = cine.startAzi + 1.0 * ease;                 // slow orbit sweep
    const radius = 132 - 106 * ease;                        // wide → chase
    const height = 92 - 79 * ease;                          // high → low
    camera.position.set(o.x + Math.cos(azi) * radius, height,
                        o.z + Math.sin(azi) * radius);
    controls.target.set(o.x, 1.6, o.z);                     // always on the boat
    controls.update();
    st.sun.position.copy(controls.target).addScaledVector(st.sunDir, 380);
    st.sun.target.position.copy(controls.target);
    return true;
  }

  function tickCamera(st, t, dt = 0.016) {
    if (window.__freezeCam) {              // dev/screenshot hook only
      st.sun.position.copy(controls.target).addScaledVector(st.sunDir, 380);
      st.sun.target.position.copy(controls.target);
      controls.update();
      return;
    }
    controls.autoRotate = lobbyMode && !cine;
    viewFollowPid = focusPid(lastRoom);   // follow the mover, then the next captain
    if (cine) { if (tickCinematic(st, performance.now())) return; }
    // the Amber Vale is a maze: the eye stays pressed close to the captain,
    // easing in/out as you cross its passes (fog does the rest)
    const wantMax = st.theme.id === 'autumn' && !lobbyMode ? 24 : 84;
    if (Math.abs(controls.maxDistance - wantMax) > 0.5) {
      controls.maxDistance += (wantMax - controls.maxDistance) * Math.min(1, dt * 2.5);
    }
    if (!lobbyMode) {
      const rec = viewFollowPid ? ships[viewFollowPid] : null;
      if (rec && rec.stageId === st.id) {
        _vA.copy(rec.root.position);
        _vA.y = 1.6;
        _vB.subVectors(_vA, controls.target);
        if (_vB.lengthSq() > 0.0001) {
          _vB.multiplyScalar(rec.anim ? 0.1 : 0.06);
          controls.target.add(_vB);
          camera.position.add(_vB);
        }
      }
      // the Kraken bars the way: the eye pushes IN on the standoff
      if (krakenRec && krakenRec.obj) {
        _vB.subVectors(camera.position, controls.target);
        const d = _vB.length();
        if (d > 27) {
          _vB.multiplyScalar((27 / d - 1) * Math.min(1, dt * 1.4));
          camera.position.add(_vB);
        }
      }
    }
    controls.update();
    /* keep the tight shadow frustum (and the sun) glued to the action */
    st.sun.position.copy(controls.target).addScaledVector(st.sunDir, 380);
    st.sun.target.position.copy(controls.target);
  }

  /* ── the OPENING TOUR: fly the Isles of Peace, then every realm, then land
     on the Pharos — narrating the rules as it goes. Any tap skips it. ──── */
  let tour = null;   // {legs, i, startedAt}

  const TOUR_RULES = {
    hub: ['The Isles of Peace',
      'Roll the bronze die and sail EXACTLY that far. Trade, pray, patch your hull — and mind the Kraken.'],
    ice: ['The Frostfang Reach',
      'One main road to each tyrant. Brave the elite shortcut — or loop past the blue haven checkpoint.'],
    desert: ['The Bleached Reach',
      'Crossed on foot. The Sphinx bars the way — answer her riddles or be swept back.'],
    jungle: ['The Verdigris Deep',
      'Muddy waters, hungry wilds. Enemies test you with trivia AND puzzles — solve, or take the hit.'],
    autumn: ['The Amber Vale',
      'A forest track beneath amber boughs. When your ship goes down, you wake at your last haven.'],
    pharos: ['The Pharos',
      'Slay tyrants and bank THREE sigil seals to open its door — then face the Dark Lord. First to take the tower wins the sea.'],
  };

  const _easeIO = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

  /* the hub's fog is tuned for deck height — from the tour's altitude it
     erases the very isles the fly-over is meant to show. Stash-and-extend
     while a hub-stage leg plays, restore the moment we leave it. */
  let tourFog = null;   // {st, near, far}
  function tourFogOpen(st, extent) {
    if (tourFog?.st === st) return;
    tourFogClose();
    if (!st.scene.fog) return;
    tourFog = { st, near: st.scene.fog.near, far: st.scene.fog.far };
    st.scene.fog.near = extent * 1.6;
    st.scene.fog.far = extent * 5.0;
  }
  function tourFogClose() {
    if (!tourFog) return;
    const f = tourFog.st.scene.fog;
    if (f) { f.near = tourFog.near; f.far = tourFog.far; }
    tourFog = null;
  }

  /* the voyage begins: hold the grand fly-over until every GLB is truly in
   * memory, so nothing pops in mid-cinematic. Progress is reported to the
   * UI (loading bar); a 60s race means a stalled download never soft-locks
   * the game — the tour simply starts with whatever arrived. */
  let loadGate = false;
  function gateTourThenStart() {
    if (loadGate) return;
    loadGate = true;
    const jobs = [
      ...preloadStructures(),
      ...preloadProps(),
      ...preloadMonsters(['captain', 'kraken', 'sphinx']),
    ];
    let done = 0;
    handlers.onLoadStart?.(jobs.length);
    const bump = () => handlers.onLoadProgress?.(++done, jobs.length);
    for (const j of jobs) Promise.resolve(j).then(bump, bump);
    const timeout = new Promise((r) => setTimeout(r, 60000));
    Promise.race([Promise.allSettled(jobs), timeout]).then(() => {
      handlers.onLoadDone?.();
      if (!battleOn && lastRoom && lastRoom.phase !== 'lobby') startTour(lastRoom);
    });
  }

  function startTour(room) {
    const regions = Object.keys(room.board?.regions || {});
    tour = {
      legs: [
        { stage: 'hub', dur: 8000, cap: 'hub' },
        ...regions.map((r) => ({ stage: r, dur: 6500, cap: r })),
        { stage: 'hub', dur: 8000, cap: 'pharos', pharos: true },
      ],
      i: 0,
      startedAt: null,
    };
    handlers.onTourState?.(true);
  }

  function endTour() {
    if (!tour) return;
    tour = null;
    tourFogClose();
    handlers.onTourCaption?.(null);
    handlers.onTourState?.(false);
    if (lastRoom) {
      requestStage(desiredTarget(lastRoom));
      const st = stages[activeBoardId];
      if (st) startCinematic(st);        // the final swoop down to your boat
    }
  }

  function tickTour(now) {
    const leg = tour.legs[tour.i];
    if (activeBoardId !== leg.stage || !stages[activeBoardId] || fading) {
      if (!fading && activeBoardId !== leg.stage) requestStage(leg.stage);
      return;                            // stage still fading in — hold
    }
    const st = stages[activeBoardId];
    if (tour.startedAt == null) {
      tour.startedAt = now;
      const [title, body] = TOUR_RULES[leg.cap] || ['', ''];
      handlers.onTourCaption?.({ title, body, i: tour.i, n: tour.legs.length });
    }
    const k = Math.min(1, (now - tour.startedAt) / leg.dur);
    const b = stageBounds(st);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 160);
    // only the hub legs clear the air. The Vale is a MAZE — its flyover
    // stays inside the amber murk so nobody gets a peek at the middle
    if (leg.stage === 'hub') tourFogOpen(st, extent);
    else tourFogClose();
    if (leg.pharos) {
      // spiral down from high over the sea to the tower's very door
      const ph = nodeById.pharos || { x: 0, z: 0 };
      const e = _easeIO(k);
      const r = 330 - 268 * e;
      const hgt = 300 - 272 * e;
      const a = -Math.PI / 2 + 1.5 * e;
      camera.position.set(ph.x + Math.cos(a) * r, hgt, ph.z + Math.sin(a) * r);
      controls.target.set(ph.x, 3 + 11 * e, ph.z);
    } else if (leg.stage === 'hub') {
      // a slow high sweep across the whole Isles of Peace
      const a = -Math.PI / 2 + 0.9 * k;
      const r = extent * (0.60 - 0.10 * k);
      const hgt = extent * (0.52 - 0.10 * k);
      camera.position.set(cx + Math.cos(a) * r, hgt, cz + Math.sin(a) * r);
      controls.target.set(cx, 0, cz);
    } else {
      // realms hold their fog close — fly LOW along the road, gate → lair
      if (!leg.path) {
        const gate = Object.values(nodeById).find(
          (n) => n.type === 'gate' && n.region === leg.stage);
        const lair = Object.values(nodeById).find(
          (n) => n.type === 'lair' && n.region === leg.stage);
        leg.path = (gate && lair) ? { gate, lair }
          : { gate: { x: cx, z: cz }, lair: { x: cx, z: cz } };
      }
      const { gate, lair } = leg.path;
      const e = _easeIO(k);
      const px = gate.x + (lair.x - gate.x) * e;
      const pz = gate.z + (lair.z - gate.z) * e;
      const t2 = Math.min(1, e + 0.18);
      const lx = gate.x + (lair.x - gate.x) * t2;
      const lz = gate.z + (lair.z - gate.z) * t2;
      let dx = lx - px, dz = lz - pz;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      // the Vale's leg rides above its own fog ceiling: all you see is the
      // amber sea of murk — the maze keeps its secrets
      const hgt2 = leg.stage === 'autumn' ? 150 : 92;
      camera.position.set(px - dx * 65, hgt2, pz - dz * 65);
      controls.target.set(lx, 0, lz);
    }
    controls.update();
    st.sun.position.copy(controls.target).addScaledVector(st.sunDir, 380);
    st.sun.target.position.copy(controls.target);
    if (k >= 1) {
      tour.i += 1;
      tour.startedAt = null;
      handlers.onTourCaption?.(null);
      if (tour.i >= tour.legs.length) {
        endTour();
      } else {
        requestStage(tour.legs[tour.i].stage);
      }
    }
  }

  /* ── aerial chart mode: a live top-down view of the CURRENT region ──── */
  let mapMode = null;   // {saved, bounds, H, Hmin, Hmax, tx, tz, keys, drag}

  function stageBounds(st) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const id in st.islands) {
      const n = nodeById[id];
      if (!n) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
    }
    if (minX > maxX) { minX = maxX = minZ = maxZ = 0; }
    // a soft margin, but never past the mountain wall that rings the stage
    return { minX: minX - 45, maxX: maxX + 45, minZ: minZ - 45, maxZ: maxZ + 45 };
  }

  function enterMapView(dev) {
    const st = stages[activeBoardId];
    if (!st || battleOn || mapMode || tour) return false;
    // the maze allows no chart in normal play — but DEV mode overrides it so
    // you can see the whole Vale un-fogged and teleport anywhere in it
    if (st.theme.id === 'autumn' && !dev) return false;
    const b = stageBounds(st);
    const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 140);
    mapMode = {
      saved: { pos: camera.position.clone(), target: controls.target.clone() },
      bounds: b,
      H: extent * 0.72, Hmin: extent * 0.25, Hmax: extent * 1.15,
      tx: (b.minX + b.maxX) / 2, tz: (b.minZ + b.maxZ) / 2,
      keys: new Set(), drag: null, snapped: false,
      // the stage fog is tuned for deck height — from a chart-view altitude
      // it swallows every isle and bleaches the sea. Push it far out while
      // the chart is open so the REAL islands and blue water show.
      fogSave: st.scene.fog
        ? { stageId: activeBoardId, near: st.scene.fog.near, far: st.scene.fog.far }
        : null,
    };
    if (st.scene.fog) {
      st.scene.fog.near = extent * 1.6;
      st.scene.fog.far = extent * 5.0;
    }
    controls.enabled = false;
    skipCinematic();
    return true;
  }

  function exitMapView() {
    if (!mapMode) return;
    const fs = mapMode.fogSave;
    if (fs) {
      const st = stages[fs.stageId];
      if (st?.scene.fog) {
        st.scene.fog.near = fs.near;
        st.scene.fog.far = fs.far;
      }
    }
    camera.position.copy(mapMode.saved.pos);
    controls.target.copy(mapMode.saved.target);
    controls.enabled = true;
    mapMode = null;
  }

  function tickMapView(dt) {
    const m = mapMode;
    const sp = m.H * 0.9 * dt;                     // pan speed scales with height
    if (m.keys.has('w') || m.keys.has('arrowup')) m.tz -= sp;
    if (m.keys.has('s') || m.keys.has('arrowdown')) m.tz += sp;
    if (m.keys.has('a') || m.keys.has('arrowleft')) m.tx -= sp;
    if (m.keys.has('d') || m.keys.has('arrowright')) m.tx += sp;
    // locked within the mountains: the view can never leave the region
    m.tx = Math.max(m.bounds.minX, Math.min(m.bounds.maxX, m.tx));
    m.tz = Math.max(m.bounds.minZ, Math.min(m.bounds.maxZ, m.tz));
    _vA.set(m.tx, m.H, m.tz + m.H * 0.26);         // high, tipped slightly south
    if (!m.snapped) { camera.position.copy(_vA); m.snapped = true; }
    else camera.position.lerp(_vA, 0.14);
    camera.lookAt(m.tx, 0, m.tz);
    const st = stages[activeBoardId];
    if (st) {
      st.sun.position.set(m.tx, 0, m.tz).addScaledVector(st.sunDir, 380);
      st.sun.target.position.set(m.tx, 0, m.tz);
    }
  }

  /* screen-space projection of the region's points of interest + captains,
     polled by the HUD to float icon chips over the live aerial view */
  function mapProject() {
    if (!mapMode) return null;
    const st = stages[activeBoardId];
    if (!st) return null;
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    const out = [];
    for (const id in st.islands) {
      const n = nodeById[id];
      if (!n || n.type === 'sea') continue;
      _vA.set(n.x, (st.islands[id].plateauY ?? 1) + 2, n.z).project(camera);
      if (_vA.z > 1) continue;
      out.push({ id, type: n.type, name: n.name, region: n.region || null,
                 solved: !!n.solved, boss_name: n.boss_name || null,
                 defeated: (n.defeated || []).length,
                 x: (_vA.x * 0.5 + 0.5) * w, y: (-_vA.y * 0.5 + 0.5) * h });
    }
    for (const pid in ships) {
      const rec = ships[pid];
      if (rec.stageId !== activeBoardId) continue;
      _vA.copy(rec.root.position); _vA.y += 3; _vA.project(camera);
      if (_vA.z > 1) continue;
      out.push({ player: pid,
                 x: (_vA.x * 0.5 + 0.5) * w, y: (-_vA.y * 0.5 + 0.5) * h });
    }
    return out;
  }

  window.addEventListener('keydown', (e) => {
    if (!mapMode) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      mapMode.keys.add(k);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (mapMode) mapMode.keys.delete(e.key.toLowerCase());
  });
  renderer.domElement.addEventListener('contextmenu', (e) => {
    if (mapMode) e.preventDefault();
  });
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (mapMode && e.button === 2) mapMode.drag = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!mapMode || !mapMode.drag) return;
    const m = mapMode;
    const per = m.H * 0.0016;                      // world units per pixel
    m.tx -= (e.clientX - m.drag[0]) * per;
    m.tz -= (e.clientY - m.drag[1]) * per;
    m.drag = [e.clientX, e.clientY];
  });
  window.addEventListener('pointerup', () => { if (mapMode) mapMode.drag = null; });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (!mapMode) return;
    e.preventDefault();
    mapMode.H = Math.max(mapMode.Hmin,
      Math.min(mapMode.Hmax, mapMode.H * (1 + e.deltaY * 0.001)));
  }, { passive: false });

  /* ── the kraken surfacing beside a blocked ship ───────────────────────── */
  let krakenRec = null;   // {node, obj}
  function syncKraken(room) {
    const want = room?.minigame?.kraken ? room.minigame.island : null;
    const st = stages[activeBoardId];
    if (krakenRec && krakenRec.node !== want) {
      krakenRec.obj?.parent?.remove(krakenRec.obj);
      if (krakenRec.obj) disposeMonster(krakenRec.obj);
      krakenRec = null;
    }
    if (want && !krakenRec && st && stageHasNode(activeBoardId, want)) {
      krakenRec = { node: want, obj: null };
      getMonster('kraken', { scale: 1.9 }).then((mon) => {
        if (!krakenRec || krakenRec.node !== want) { disposeMonster(mon); return; }
        const n = nodeById[want];
        // it surfaces DEAD AHEAD, blocking the way onward (away from Home Port)
        const home = nodeById.home;
        let fx = n.x - (home?.x ?? 0), fz = n.z - (home?.z ?? 0);
        const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
        mon.position.set(n.x + fx * 9, -0.8, n.z + fz * 9);
        mon.lookAt(n.x, 0, n.z);
        mon.rotation.y += Math.PI / 2;              // face 90° counter-clockwise
        st.scene.add(mon);
        krakenRec.obj = mon;
      });
    }
    if (krakenRec?.obj) {
      animateMonster(krakenRec.obj, clock.getElapsedTime(), 'idle');
      krakenRec.obj.position.y = -0.8 + Math.sin(clock.getElapsedTime() * 1.1) * 0.25;  // heave
    }
  }

  const clock = new THREE.Clock();
  let tPrev = 0;
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    const dt = Math.min(0.1, t - tPrev);
    tPrev = t;
    if (battleOn) {
      if (mapMode) exitMapView();
      battleStage.update(t, dt);
      renderer.render(battleStage.scene, battleStage.camera);
      return;
    }
    const st = stages[activeBoardId];
    if (!st) return;
    const now = performance.now();
    tickAmbience(st, t);
    tickShips(st, t, now);
    tickWake(now);
    tickHighlights(t);
    syncValeArrows(lastRoom);
    for (let i = 0; i < valeArrows.children.length; i++) {
      const a = valeArrows.children[i];
      if (a.userData.ph == null) continue;          // click-strips don't bob
      a.position.y = 0.5 + Math.sin(t * 3 + a.userData.ph) * 0.14;
    }
    syncKraken(lastRoom);
    if (tour) tickTour(performance.now());
    else if (mapMode) tickMapView(dt);
    else tickCamera(st, t, dt);
    renderer.render(st.scene, camera);
  });

  /* ── public API ─────────────────────────────────────────────────────── */
  function battlePlay(kind, payload) {
    if (!battleOn) return;
    if (kind === 'target' || kind === 'targeted' || kind === 'set_target') {
      battleStage.setTargeted(payload && typeof payload === 'object' ? (payload.idx ?? null) : (payload ?? null));
      return;
    }
    battleStage.play(kind, payload);
  }

  const api = {
    update,
    battlePlay,
    battleActive: () => battleOn,
    arriving: () => arriving(lastRoom),
    animating: () => animatingPid(),
    currentStage: () => (battleOn ? 'battle' : (activeBoardId || 'hub')),
    enterMapView,
    exitMapView,
    mapActive: () => !!mapMode,
    mapProject,
    tourActive: () => !!tour,
    endTour,
  };

  /* debug handle for dev tooling / screenshot scripts */
  window.__thalassa = {
    scene: () => (battleOn ? battleStage.scene : stages[activeBoardId]?.scene),
    camera, controls, ships, stages,
    follow: () => viewFollowPid,
    animating: () => animatingPid(),
  };

  return api;
}

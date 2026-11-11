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
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { hashStr, mulberry32, flat } from './util.js';
import { themeFor } from './themes.js';
import { makeGround } from './water.js';
import { buildIsland, makeShip, makeParticles, nameSprite, makeRealmField, preloadStructures } from './islands.js';
import { preloadProps } from './props.js';
import { buildMountainWall, buildRealmBackdrop } from './wall.js';
import { getMonster, animateMonster, preloadMonsters, disposeMonster, BOSS_IDS } from './monsters.js';
import { createBattleStage } from './battle.js';
import { createWorldFx } from './worldfx.js';
import { spectralSwap } from './ghostswap.js';
import { installAtmosphere, applyLook, updateAtmosphere, setCloudShadows } from './gfx/atmosphere.js';
import { lookFor } from './gfx/looks.js';
import { makeSky, bakeEnvironment } from './gfx/sky.js';
import { makeLightRig } from './gfx/lighting.js';
import { makeOcean, WATER_Y } from './gfx/ocean.js';
import { createPipeline } from './gfx/pipeline.js';
import { makeShoreMap } from './gfx/shoremap.js';
import { planRoute, routeAt, routeS, helm, easeVoyage, obstacleIndex, smooth01 } from './travel.js';
import { REALM_INFO } from './themes.js';
import { islandRoom, laneBearing } from './isleshape.js';
import { makeTurnMarker as modelTurnMarker, makeReachBeacon, makeSeaLane, makeFootTrail, makeTrailArrowKit } from './models/props.js';

const FADE_MS = 480;               // fade-to-black hold before the swap
const GOLD = 0xffd75e;

/* preallocated scratch — the render loop must not allocate */
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();
const _ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/* ── little canvas textures (sun glow, wake foam) ───────────────────────── */

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

let TEX_GLOW = null, TEX_WAKE = null;
function ensureTextures() {
  if (TEX_GLOW) return;
  TEX_GLOW = radialTexture([
    [0, 'rgba(255,250,225,1)'], [0.18, 'rgba(255,240,190,0.9)'],
    [0.5, 'rgba(255,225,150,0.25)'], [1, 'rgba(255,220,140,0)'],
  ]);
  TEX_WAKE = radialTexture([
    [0, 'rgba(255,255,255,0.85)'], [0.45, 'rgba(230,250,255,0.5)'],
    [1, 'rgba(220,245,255,0)'],
  ]);
}

/* clouds, gulls and dolphins are gone — the sea keeps its own company */

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
  installAtmosphere();     // aerial-perspective fog on every material, before any compile
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  /* the HDR frame: bloom, sun shafts, tone map and film grade (gfx/pipeline.js) */
  const pipe = createPipeline(renderer);
  /* one shared top-down height map of the active stage — the ocean reads it
     for shallows, caustics and surf (gfx/shoremap.js) */
  const shore = makeShoreMap(renderer, { res: pipe.quality === 'high' ? 4096 : 2048 });

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
  // flat enough to lift the eye to the horizon — the Vale's golden barrow
  // beacon (and the realms' skylines) must be sightable from the deck
  controls.maxPolarAngle = 1.34;
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
  let preloadedRegion = null;   // last realm whose bestiary we streamed in
  let wasLobby = true;        // to catch the lobby → voyage transition
  let firstSnap = true;       // this page's first snapshot (a reload skips the tour)
  let cine = null;            // active establishing pan-over, or null
  const seenStages = new Set();

  let activeBoardId = null;   // board stage currently shown (also under battle)
  let battleOn = false;
  let battleHold = false;     // keep the diorama rendered under the win/death card
  let battleKey = null;
  let fading = false;
  let pendingTarget = null;
  let savedCam = null;        // board camera frozen while battling

  const ships = {};           // pid → ship record

  /* shared groups that ride along into whichever stage is active */
  const highlights = new THREE.Group();   // reachable rings
  let hiKey = '';
  /* the Vale's WAYFINDER: flat golden arrows laid on the ground along every
     trail your roll can walk — tap any arrow to take that road */
  const valeArrows = new THREE.Group();
  let arrowKey = '';
  // ONE long arrow per branch: a stretchable shaft plus a fixed head, so the
  // shaft can run the trail without distorting the arrowhead. Both lie flat;
  // pre-yaw the head's tip points -Z (yaw = atan2(-ux,-uz) aims it down-trail).
  // (models/props.js: a soft painted ribbon of light + glowing head, not
  // flat gold plates; depthTest off — an arrow is UI, trees never bury it)
  const ARROW = makeTrailArrowKit();
  const ARROW_SHAFT_GEO = ARROW.shaftGeo, ARROW_HEAD_GEO = ARROW.headGeo;
  const ARROW_HEAD_LEN = ARROW.headLen;
  const STRIP_GEO = new THREE.BoxGeometry(1, 1, 1);   // invisible click-ribbons
  const STRIP_MAT = new THREE.MeshBasicMaterial({
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
    // a vessel still sailing UP to a pass stays in the stage it sails in —
    // whatever the server says (it carries you through ~1.8 s after landfall,
    // long before the hull has reached the arch: that early carry is what
    // used to pop the Amber Vale in while the boat was still out at sea)
    if (cross && cross.pid === you) return cross.phase === 'approach' ? cross.from : cross.to;
    const held = ships[you];
    if (held?.hold && held.stageId) return held.stageId;
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
    // an EMPTY realm — just its pass, like the Vale mid-rebuild — centers its
    // stage out in the wilds BEYOND the gate, not on the gate itself, so the
    // backdrop ring and ground still wrap the ground the rebuild will fill
    if (nodes.every((n) => n.type === 'gate')) {
      const r = Math.hypot(c.x, c.z) || 1;
      c.x += (c.x / r) * 210;
      c.z += (c.z / r) * 210;
    }
    return c;
  }

  function buildStage(stageId, room) {
    const theme = themeFor(stageId);
    const scene = new THREE.Scene();
    // haze COLOUR belongs to the stage's look (so land, sea and sky horizon
    // agree); the sight DISTANCES are gameplay and stay with the theme
    const hazeHex = lookFor(stageId).fog.color;
    scene.background = new THREE.Color(hazeHex);
    scene.fog = new THREE.Fog(hazeHex, theme.fog.near, theme.fog.far);
    const center = stageCenter(stageId, room);
    const rng = mulberry32(hashStr('stage:' + stageId));

    /* light: the stage's look drives the shared atmosphere (sky, sun, haze);
       ambient comes from the sky itself, baked into scene.environment */
    const look = lookFor(stageId);
    scene.add(makeSky());
    const rig = makeLightRig(look);
    scene.add(rig.group);
    const sun = rig.sun, sunDir = rig.sunDir;
    scene.environmentIntensity = look.env;
    rig.follow(center, 60);

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
      : makeOcean(theme, look);
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
      // the Amber Vale wears NO mountain crescent: a flat endless wood that
      // simply dissolves into the murk — the fog is its wall
      wall = buildRealmBackdrop(theme, { radius: 520 });
      wall.position.set(center.x, 0, center.z);
      const gate = memberNodes(stageId, room).find((n) => n.type === 'gate');
      if (gate) wall.rotation.y = Math.atan2(gate.x - center.x, gate.z - center.z) + Math.PI;
    }
    if (wall) scene.add(wall);

    /* the wilds between the stops: berg fields, dune seas, vine channels,
       or the Vale's unbroken forest — every realm is FULL, no empty water */
    let field = null;
    if (stageId !== 'hub') {
      const members = memberNodes(stageId, room);
      const byId = new Map(members.map((n) => [n.id, n]));
      const segs = [];
      for (const [a, b] of room.board?.edges || []) {
        const na = byId.get(a), nb = byId.get(b);
        if (na && nb) segs.push([na.x, na.z, nb.x, nb.z]);
      }
      const gateN = members.find((n) => n.type === 'gate');
      if (stageId === 'autumn' && gateN) {
        // The Vale's fog reveals its stops over time, but the FOREST must
        // stand from the first frame and cover the WHOLE wedge the maze
        // lives in (its arcs swing ~±0.31 rad off the gate line) — so the
        // field's bounds come from virtual fill points fanned across the
        // wedge, never from however few stops the lantern has found.
        // Points only, no virtual seg: a seg would paint a worn dirt road
        // down a trail that does not exist.
        const gAng = Math.atan2(gateN.z, gateN.x);
        const gR = Math.hypot(gateN.x, gateN.z) || 1;
        // the maze now runs four arcs deep with the barrow far past the last
        // one — fan the fill wider (±0.42 rad) and out to the barrow so the
        // whole long wedge is walled with trees from the first frame.
        for (let d = 56; d <= 540; d += 58) {
          for (const off of [-0.42, -0.14, 0.14, 0.42]) {
            const a = gAng + off;
            members.push({ id: `fill${d}_${off}`, type: 'sea',
                           x: Math.cos(a) * (gR + d), z: Math.sin(a) * (gR + d) });
          }
        }
      }
      field = makeRealmField(theme, members, segs, rng, surf.heightAt);
      scene.add(field);
    }

    /* themed particles (snow / leaves / motes / dust); follow the camera */
    let particles = null;
    if (theme.particles) {
      particles = makeParticles(theme.particles);
      scene.add(particles.points);
    }

    const laneGroup = new THREE.Group();
    scene.add(laneGroup);

    return {
      id: stageId, theme, look, scene, center, rng, rig, env: null,
      sun, sunDir, surf, wall, particles, field,
      islands: {},           // nodeId → {key, group, proxy, R, plateauY, fxBits}
      proxyList: [],
      laneGroup, laneKey: '',
    };
  }

  function destroyStage(st) {
    if (litStage === st) litStage = null;
    st.env?.dispose();
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

  /* an island is sized to the free water round its node (no two isles grow
     into each other or over a lane) and opens its harbour toward the lane it
     is reached by — isleshape.js. The node snapshot itself is never touched. */
  let roomEdges = null, roomKey = '';
  function withRoom(node, nodes, room) {
    const solid = node.type !== 'sea' && node.type !== 'gate';
    if (!solid && node.look !== 'islet') return node;
    const edges = room.board?.edges || [];
    const k = edges.length + ':' + nodes.length;
    if (k !== roomKey) { roomKey = k; roomEdges = edges; }
    return { ...node, room: islandRoom(node, nodes, roomEdges, nodeById),
             dockA: solid ? laneBearing(node, roomEdges, nodeById) : null };
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
      const built = buildIsland(withRoom(node, nodes, room), st.theme, domains);
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
      st.shoreDirty = true;
    }
    for (const id of Object.keys(st.islands)) {
      if (present.has(id)) continue;
      const isle = st.islands[id];
      st.scene.remove(isle.group, isle.proxy);
      disposeDeep(isle.group);
      isle.proxy.geometry.dispose();
      delete st.islands[id];
      proxiesDirty = true;
      st.shoreDirty = true;
    }
    if (proxiesDirty) st.proxyList = Object.values(st.islands).map((i) => i.proxy);

    /* lanes: subtle dashes between member nodes only */
    const memberSet = present;
    const edges = (room.board?.edges || []).filter(([a, b]) => memberSet.has(a) && memberSet.has(b));
    const ekey = edges.map((e) => e.join('~')).join('|');
    if (ekey !== st.laneKey) {
      st.laneKey = ekey;
      /* the Vale's fog: as the lantern reveals trails, part the trees that
         stood on them — the way through was there all along */
      if (st.theme.id === 'autumn' && st.field) {
        const segs = edges
          .map(([a, b]) => [nodeById[a], nodeById[b]])
          .filter(([a, b]) => a && b)
          .map(([a, b]) => [a.x, a.z, b.x, b.z]);
        const onTrail = (x, z) => {
          for (const n of nodes) {
            // POIs get a proper CLEARING in the wood; plain trail stops just
            // enough for the stepping stone; the pass a wide open mouth
            const clear = n.type === 'gate' ? 22
              : n.type !== 'sea' ? 17 : 6.5;
            if (Math.hypot(n.x - x, n.z - z) < clear) return true;
          }
          for (const s of segs) {
            const dx = s[2] - s[0], dz = s[3] - s[1];
            const L2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / L2));
            if (Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) < 7.5) return true;
          }
          return false;
        };
        for (const o of [...st.field.children]) {
          if (onTrail(o.position.x, o.position.z)) {
            st.field.remove(o);
            disposeDeep(o);
          }
        }
        st.obstacles = null;                 // re-index the wood for routing
      }
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
          // A foot trail is a real line of worn flagstones through the ground.
          const vale = st.theme.id === 'autumn';
          const stoneHex = vale ? 0xa48e6a : 0xe6d7ae;
          // one merged mesh of worn, irregular flagstones (models/props.js);
          // in the Vale they dissolve before the fog's end (else far trails
          // read as rows of dark specks on the horizon)
          st.laneGroup.add(makeFootTrail(
            na.x + _vC.x * gapA, na.z + _vC.z * gapA,
            na.x + _vC.x * (len - gapB), na.z + _vC.z * (len - gapB),
            { hex: stoneHex, seed: hashStr('trail:' + a + '~' + b), fadeFar: vale ? 48 : 0 }));
          continue;
        }
        // a sea lane: a soft row of painted wake-dashes on the swell, fading
        // toward both stops (models/props.js) — not a dashed debug line
        st.laneGroup.add(makeSeaLane(
          na.x + _vC.x * gapA, na.z + _vC.z * gapA,
          na.x + _vC.x * (len - gapB), na.z + _vC.z * (len - gapB),
          { seed: hashStr(a + '~' + b) }));
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

  /* ── berths ─────────────────────────────────────────────────────────────
     Where a vessel parks at a stop. Every berth is chosen on the side the
     vessel ARRIVES from (so it never sails round an island to park on its
     far side) and away from any other ship already parked or bound there
     (so hulls never overlap). `from` is the approach point (or null). */
  let wonderSpots = null;            // (stageId) → [{x, z, pad}], set once worldFx exists
  const HULL_GAP = 9.0;              // two galleys side by side, bow to stern clear
  const FOOT_GAP = 1.7;              // two captains standing at one stop

  /* where every OTHER vessel in this stage is parked, or is bound to park */
  function berthsTaken(st, exceptPid) {
    const out = [];
    for (const pid in ships) {
      if (pid === exceptPid) continue;
      const r = ships[pid];
      if (r.stageId !== st?.id) continue;
      out.push(r.anim ? r.anim.route.pts[r.anim.route.pts.length - 1] : r.root.position);
    }
    // …and the wonders standing by a stop (a floe of penguins, a loot raft)
    if (st && wonderSpots) for (const q of wonderSpots(st.id)) out.push(q);
    return out;
  }
  function clearOf(p, taken, gap) {
    for (const q of taken) if (Math.hypot(p.x - q.x, p.z - q.z) < gap + (q.pad || 0)) return false;
    return true;
  }
  /* try `base + offsets[i]` until one is clear of every other vessel */
  function pickClear(make, taken, gap, n = 9) {
    let first = null;
    for (let i = 0; i < n; i++) {
      const k = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      const p = make(k);
      if (!first) first = p;
      if (clearOf(p, taken, gap)) return p;
    }
    return first;
  }

  function gateBerth(n, st, slotIdx, pid = null) {
    // Berth on the channel centerline (the radial axis through the arch), on
    // the side of the arch that belongs to the stage we're viewing — the hub
    // side while approaching, the realm side once across — so you come at the
    // pass head-on and pass THROUGH it, never around it. Extra vessels fan
    // out ACROSS the channel, each a hull's beam clear of the others.
    const rad = _vD.set(n.x, 0, n.z).normalize();             // outward (radial)
    const rx = rad.x, rz = rad.z;
    const inRealm = !!(st && st.id !== 'hub');
    const foot = isFootStage(st?.id);
    const along = inRealm ? 26 : 14;
    const dir = inRealm ? 1 : -1;                    // realm: outward; hub: inward
    const step = foot ? 2.2 : 5.0;
    const taken = berthsTaken(st, pid);
    return pickClear((k) => new THREE.Vector3(
      n.x + dir * rx * along - rz * k * step, 0,
      n.z + dir * rz * along + rx * k * step), taken, foot ? FOOT_GAP : 4.6, 5);
  }

  function slotFor(nodeId, slotIdx, st, from = null, pid = null) {
    const n = nodeById[nodeId];
    if (!n) return new THREE.Vector3();
    if (n.type === 'gate') return gateBerth(n, st, slotIdx, pid);
    const taken = berthsTaken(st, pid);
    // approach bearing from the stop (falls back to a per-captain bearing)
    const brg = from && Math.hypot(from.x - n.x, from.z - n.z) > 0.5
      ? Math.atan2(from.z - n.z, from.x - n.x) : (slotIdx / 6) * Math.PI * 2 + 0.8;
    // ON FOOT (the Vale's clearings, the desert's open dune stops) the
    // captain stands ON the stop itself; a second captain a step beside him.
    // A desert stop that carries an island (mound, shrine) is solid ground:
    // he halts on the sand just short of its rim, on the side he came from.
    if (st?.id === 'autumn' || isFootStage(st?.id)) {
      const isle = st.islands[nodeId];
      const structured = st.id !== 'autumn' && n.type !== 'sea';
      const r0 = structured ? (isle?.R ?? 4) * 1.05 + 1.6 : 0;
      return pickClear((k) => {
        if (!structured && k === 0) return new THREE.Vector3(n.x, 0, n.z);
        const a = brg + k * 0.5;
        const r = structured ? r0 : FOOT_GAP;
        return new THREE.Vector3(n.x + Math.cos(a) * r, 0, n.z + Math.sin(a) * r);
      }, taken, FOOT_GAP);
    }
    // an OPEN-WATER mooring (a shoal, no land under it): settle in its middle;
    // a second ship lies alongside, toward the side it came from
    if (n.type === 'sea' && !seaSolid(n)) {
      return pickClear((k) => {
        if (k === 0) return new THREE.Vector3(n.x, 0, n.z);
        const a = brg + (Math.abs(k) - 1) * 0.9 * Math.sign(k);
        return new THREE.Vector3(n.x + Math.cos(a) * HULL_GAP, 0, n.z + Math.sin(a) * HULL_GAP);
      }, taken, HULL_GAP);
    }
    // an island: lie off its beach on the approach side, a hull's width
    // clear of the sand; further captains fan round the coast
    const isle = st && st.islands[nodeId];
    const R = isle?.R ?? 4;
    const r = R * 1.12 + 4.6;
    return pickClear((k) => {
      const a = brg + k * Math.max(0.32, (HULL_GAP + 1) / r);
      return new THREE.Vector3(n.x + Math.cos(a) * r, 0, n.z + Math.sin(a) * r);
    }, taken, HULL_GAP);
  }

  /* an open-sea waypoint can still be SOLID GROUND — an islet or a rock
     stack — and the hull must treat it like any other island */
  function seaSolid(n) {
    return n?.type === 'sea' && (n.look === 'islet' || n.look === 'rocks');
  }

  /* a route that runs THROUGH a stop it does not end on (an island on the
     way, an islet buoy) passes beside it — on whichever side the straight
     line from the last point to the next one already favours */
  function lanePoint(nid, fromPos, st, toPos = null) {
    const n = nodeById[nid];
    const p = new THREE.Vector3(n.x, 0, n.z);
    if (n.type !== 'sea' || seaSolid(n)) {
      const r = (st?.islands[nid]?.R ?? 8) * 1.12 + 5;
      const tx = (toPos ? toPos.x : n.x) - fromPos.x, tz = (toPos ? toPos.z : n.z) - fromPos.z;
      const tl = Math.hypot(tx, tz) || 1;
      // which side of the chord does the island lie on? pass on the other
      // (left normal is (-tz, tx); the island's offset along it is −cross)
      const side = ((n.x - fromPos.x) * tz - (n.z - fromPos.z) * tx) >= 0 ? 1 : -1;
      p.x += (-tz / tl) * r * side;
      p.z += (tx / tl) * r * side;
    }
    return p;
  }

  /* ── ships & the walking captain ────────────────────────────────────── */
  /* the faceted gold gem over the captain whose turn it is (models/props.js;
     shared geometry + material, so the dispose on removal is harmless) */
  function makeTurnMarker() {
    return modelTurnMarker();
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
    // the name tag rides just over whichever form is showing
    rec.tag.position.y = foot && rec.captain ? 4.0 : 5.2;
    if (foot && !rec.captain && !rec.captainReq) {
      rec.captainReq = true;
      getMonster('captain', { tint: rec.color }).then((g) => {
        if (!ships[rec.pid]) return;               // player left meanwhile
        g.name = 'captain';
        // a MAN among the Vale's towering trees — smaller than before, still
        // planted exactly on the node's math (scale is around his feet)
        g.scale.setScalar(1.4);
        rec.captain = g;
        rec.root.add(g);
        applyMode(rec);
      }).catch(() => {});
    }
  }

  /* everything a route must keep clear of in this stage, as {x, z, r} discs
     whose r already includes the vessel's own clearance. A galley's bow and
     stern sit ~4 wu off its centre and swing out on a turn, so a hull stands
     off a coast by more than a walker does. */
  const _near = [];
  function routeSolids(st, rec, foot, a, b) {
    const hull = foot ? 1.1 : 4.6;
    const solids = [];
    for (const nid in st.islands) {
      const isle = st.islands[nid];
      const n = nodeById[nid];
      if (!n || n.type === 'gate') continue;
      if (n.type === 'sea') {
        // islets and rock stacks on the lanes are land too
        if (!seaSolid(n)) continue;
        solids.push({ x: n.x, z: n.z, r: (isle.R ?? 4) + (foot ? hull : 3.2) });
        continue;
      }
      // the Vale's stops are flush clearings, walked straight onto
      if (st.id === 'autumn') continue;
      solids.push({ x: n.x, z: n.z, r: (isle.R ?? 8) * (foot ? 1.0 : 1.08) + hull });
    }
    // the realm's field: bergs, stacks, dune rocks. (The Vale's wood is
    // already parted along every revealed trail — syncStage — and its broad
    // canopies would read as walls a man walks under, so it is not indexed.)
    if (st.field && st.id !== 'autumn') {
      if (!st.obstacles) st.obstacles = obstacleIndex(st.field);
      _near.length = 0;
      st.obstacles.near(a.x, a.z, b.x, b.z, 120, _near);
      for (const c of _near) solids.push({ x: c.x, z: c.z, r: c.r + hull * 0.8 });
    }
    // every other vessel in the stage — parked, or parking
    for (const pid in ships) {
      const o = ships[pid];
      if (o === rec || o.stageId !== st.id) continue;
      const p = o.anim ? o.anim.route.pts[o.anim.route.pts.length - 1] : o.root.position;
      solids.push({ x: p.x, z: p.z, r: foot ? 1.4 : 7.5 });
    }
    return solids;
  }

  /* the hub's mountain wall: nothing but a pass-bound hull may run up into
     the range's roots (r ≈ 488) — everywhere else stay a hull clear of it */
  function wallConstraint(st) {
    if (st.id !== 'hub') return null;
    const gates = [];
    for (const id in nodeById) {
      const g = nodeById[id];
      if (g.type === 'gate') gates.push(g.gate_angle ?? Math.atan2(g.z, g.x));
    }
    const R = 474;
    return (p) => {
      const r = Math.hypot(p.x, p.z);
      if (r <= R) return;
      const a = Math.atan2(p.z, p.x);
      for (const ga of gates) {
        if (Math.abs(Math.atan2(Math.sin(a - ga), Math.cos(a - ga))) * r < 16) return;
      }
      p.x *= R / r; p.z *= R / r;
    };
  }

  /* which way through a pass (unit vector) — 'in' is outward, into the realm */
  function passDir(g, into, out) {
    out.set(g.x, 0, g.z).normalize();
    if (!into) out.multiplyScalar(-1);
    return out;
  }

  function startTravel(rec, toNode, st) {
    // On foot the captain follows the trail stones stop to stop (corners only
    // lightly rounded); at sea the hull carves a smooth curve between the
    // lane's waypoints, round every coast, stack and moored ship.
    const onFoot = isFootStage(st?.id);
    const route = sailPath(rec.prevNode, toNode);
    const raw = [rec.root.position.clone()];
    if (route && route.length > 2) {
      const mids = route.slice(1, -1);
      for (let i = 0; i < mids.length; i++) {
        const n = nodeById[mids[i]];
        if (!n) continue;
        const nxt = nodeById[route[i + 2]];
        raw.push(onFoot ? new THREE.Vector3(n.x, 0, n.z)
                        : lanePoint(mids[i], raw[raw.length - 1], st,
                                    nxt ? _vC.set(nxt.x, 0, nxt.z) : null));
      }
    }
    const dest = nodeById[toNode];
    const prevN = nodeById[rec.prevNode];
    // a vessel bound for a PASS from this stage's own side is CROSSING: it
    // sails up the channel, through the arch, and only then leaves the stage
    // (the server's carry-through is held back until it gets there)
    rec.hold = null;
    if (dest && dest.type === 'gate' && prevN && prevN.type !== 'gate'
        && (st.id === 'hub' ? !prevN.region : prevN.region === st.id)) {
      const into = st.id === 'hub';
      rec.hold = { gate: dest.id, from: st.id, to: into ? (dest.region || 'hub') : 'hub' };
      const f = passDir(dest, into, _vD);
      const fx = f.x, fz = f.z;
      // straight up the fairway: well short of the arch, the berth, and on
      // through the arch to the far mouth of the pass
      const back = into ? 46 : 52, berth = into ? 14 : 26, beyond = into ? 24 : 16;
      raw.push(new THREE.Vector3(dest.x - fx * back, 0, dest.z - fz * back));
      raw.push(new THREE.Vector3(dest.x - fx * berth, 0, dest.z - fz * berth));
      raw.push(new THREE.Vector3(dest.x + fx * beyond, 0, dest.z + fz * beyond));
    } else {
      if (dest && dest.type === 'gate' && st.id === 'hub') {
        // approach the isles-facing berth straight down the channel
        const rad = _vD.set(dest.x, 0, dest.z).normalize();
        raw.push(new THREE.Vector3(dest.x - rad.x * 46, 0, dest.z - rad.z * 46));
      }
      raw.push(slotFor(toNode, rec.idx, st, raw[raw.length - 1], rec.pid));
    }
    const solids = routeSolids(st, rec, onFoot, raw[0], raw[raw.length - 1]);
    const plan = planRoute(raw, solids, {
      heading: rec.root.rotation.y, walk: onFoot, constrain: wallConstraint(st),
    });
    rec.arrivalPending = true;
    const total = plan.total;
    // unhurried: a voyage should read as a voyage, not a teleport — but the
    // hub's longest lanes were dragging past 7s a hop, so long legs pick up
    // speed while short putters keep their lazy glide. A crossing gets a
    // little extra to slow through the arch.
    const extra = rec.hold ? 900 : 0;
    rec.anim = {
      route: plan, total, t0: performance.now(), seg: 0,
      dur: (onFoot ? Math.min(9000, 900 + total * 52) : Math.min(5800, 700 + total * 32)) + extra,
    };
  }

  /* ══ CROSSING A PASS ════════════════════════════════════════════════════
     Entering (or leaving) a realm is a short cinematic, driven entirely by
     the local captain's own travel state:

       approach  the ship sails its lane and on up the channel between the
                 pass's bastions; as it nears the arch the camera drops low
                 astern and looks THROUGH it, the far side glowing in the
                 realm's accent, the haze thickening to the realm's colour
       cut       a beat before the hull stops in the arch the ink curtain
                 falls (requestStage → .scenefade); behind it the far stage
                 is raised and the vessel placed just through the arch
       reveal    the curtain lifts on the far side — the realm's banner and
                 music start HERE (handlers.onStageChange) — the camera rises
                 from deck height to the chase view while the ship glides (or
                 the captain steps off his beached galley and walks) on to
                 the first stop the server carried him to

     ~4–6 s all told; any tap or key skips it (to the plain fade); with
     prefers-reduced-motion, the Light tier's slow frames, a spectator, a
     rival's crossing or the opening tour it never starts (rivals' hulls
     still sail all the way through the arch before they leave the stage).
     A battle, a respawn or a dev drop mid-crossing aborts it cleanly. */
  let cross = null;   // {pid, gate, from, to, dir, phase, t0, dur, w, skip, fog, glow}
  const _cA = new THREE.Color();
  const reduceMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  };

  function saveFog(st) {
    const f = st?.scene.fog;
    return f ? { st, color: f.color.clone(), near: f.near, far: f.far } : null;
  }
  function hazeTo(save, hex, k, thick) {
    if (!save) return;
    const f = save.st.scene.fog;
    if (!f) return;
    f.color.copy(save.color).lerp(_cA.set(hex), k);
    f.near = save.near * (1 - 0.6 * thick);
    f.far = save.far * (1 - 0.55 * thick);
  }
  function restoreFog(save) {
    const f = save?.st.scene.fog;
    if (!f) return;
    f.color.copy(save.color); f.near = save.near; f.far = save.far;
  }
  function dropGlow() {
    if (!cross?.glow) return;
    cross.glow.parent?.remove(cross.glow);
    cross.glow.material.dispose();
    cross.glow = null;
  }

  function beginCrossing(rec) {
    if (cross || tour || renderPaused || battleOn || reduceMotion()) return;
    const h = rec.hold;
    const st = stages[h.from];
    const g = nodeById[h.gate];
    if (!st || !g) return;
    const into = h.from === 'hub';
    const realm = into ? h.to : h.from;
    cross = {
      pid: rec.pid, gate: h.gate, from: h.from, to: h.to, dir: into ? 'in' : 'out',
      phase: 'approach', t0: 0, dur: into ? 2900 : 1900, w: 0, skip: false,
      fog: saveFog(st), destFog: null, realm,
      haze: lookFor(h.to).fog.color, glow: null,
    };
    // the far side, glowing in its accent through the arch (HDR: it blooms)
    const accent = REALM_INFO[into ? realm : 'hub']?.accent ?? '#d9a441';
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX_GLOW, color: new THREE.Color(accent).multiplyScalar(2.2),
      transparent: true, opacity: 0, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending }));
    const f = passDir(g, into, _vB);
    glow.position.set(g.x + f.x * 40, 11, g.z + f.z * 40);
    glow.scale.set(70, 52, 1);
    glow.renderOrder = 4;
    st.scene.add(glow);
    cross.glow = glow;
  }

  /* the hull has reached the arch (or, for a crossing we don't film, has
     sailed through it): let the server's carry-through take effect */
  let resyncShips = false;
  function crossedPass(rec) {
    if (cross && cross.pid === rec.pid) {
      if (cross.phase !== 'approach') return;
      cross.phase = 'cut';
      requestStage(cross.to);           // the curtain; placeCrossed runs behind it
      return;
    }
    rec.hold = null;
    resyncShips = true;                  // honour the deferred carry this frame
  }

  function releaseHold(rec, drop) {
    rec.hold = null;
    if (drop && cross && cross.pid === rec.pid) abortCrossing();
  }

  /* behind the curtain: put the vessel just through the arch on the far side */
  function placeCrossed(st) {
    const rec = ships[cross.pid];
    const g = nodeById[cross.gate];
    if (!rec || !g) { abortCrossing(); return; }
    restoreFog(cross.fog);
    dropGlow();
    const into = cross.dir === 'in';
    const f = passDir(g, into, _vB);
    rec.hold = null;
    rec.anim = null;
    rec.arrivalPending = false;
    setShipStage(rec, st.id);
    rec.needPlace = false;
    rec.node = g.id;
    rec.prevNode = g.id;
    rec.root.position.set(g.x + f.x * 8, 0, g.z + f.z * 8);
    rec.root.rotation.y = Math.atan2(-f.z, f.x);
    const foot = isFootStage(st.id);
    if (foot !== (rec.mode === 'foot')) { rec.mode = foot ? 'foot' : 'sail'; applyMode(rec); }
    // ON FOOT: the galley is run up on the strand at the mouth of the pass
    // and left there; the captain steps down from it and walks on
    if (foot && into) beachHull(st, rec, g, f);
    cross.phase = 'reveal';
    cross.t0 = performance.now() + 140;           // the curtain starts to lift
    cross.destFog = saveFog(st);
    cross.placed = true;
  }

  function beachHull(st, rec, g, f) {
    if (st.beached) {
      st.scene.remove(st.beached);
      disposeDeep(st.beached);
    }
    const hull = makeShip(rec.color);
    hull.scale.setScalar(2);
    hull.name = 'beached';
    // nosed up the sand just past the arch, heeled over on her bilge
    const x = g.x + f.x * 11 - f.z * 8, z = g.z + f.z * 11 + f.x * 8;
    const y = st.surf.heightAt ? st.surf.heightAt(x, z) : 0;
    hull.position.set(x, y - 0.55, z);
    hull.rotation.set(0.16, Math.atan2(-f.z, f.x) + 0.35, 0.05);
    st.scene.add(hull);
    st.beached = hull;
  }

  function finishCrossing() {
    if (!cross) return;
    restoreFog(cross.destFog);
    restoreFog(cross.fog);
    dropGlow();
    const pid = cross.pid;
    cross = null;
    handlers.onArrive?.(pid);              // the HUD may hand the dice over now
  }

  function abortCrossing() {
    if (!cross) return;
    const rec = ships[cross.pid];
    restoreFog(cross.destFog);
    restoreFog(cross.fog);
    dropGlow();
    if (rec && rec.hold) { rec.hold = null; resyncShips = true; }
    const pid = cross.pid;
    cross = null;
    handlers.onArrive?.(pid);
  }

  function skipCrossing() {
    if (!cross) return;
    cross.skip = true;
    const rec = ships[cross.pid];
    if (cross.phase === 'approach' && rec?.anim) rec.anim.t0 -= rec.anim.dur;   // to the arch
    else if (cross.phase === 'reveal') {
      if (rec && rec.stageId === activeBoardId) snapBehindShip(rec);
      finishCrossing();
    }
  }

  function groundY(st, x, z) {
    return st.surf.heightAt ? Math.max(0, st.surf.heightAt(x, z)) : 0;
  }

  /* dev/QA only: window.__crossStops = [0.2, 0.8, 1.1, 1.6] freezes the
     crossing each time its progress (approach 0..1, reveal 1..2) passes the
     next stop, so a slow headless renderer can photograph exact beats;
     clearing window.__crossHold resumes it */
  function crossStop(progress) {
    const stops = window.__crossStops;
    if (!stops || !stops.length || window.__crossHold) return;
    if (progress >= stops[0]) {
      window.__crossPaused = stops.shift();
      window.__crossHold = true;
    }
  }

  /* the camera through a crossing; true while it owns the view */
  function crossingCamera(st, now, dt) {
    const rec = ships[cross.pid];
    const g = nodeById[cross.gate];
    if (!rec || !g || rec.stageId !== st.id) return false;
    const into = cross.dir === 'in';
    const P = rec.root.position;
    const yaw = rec.root.rotation.y;
    const sfx = Math.cos(yaw), sfz = -Math.sin(yaw);
    if (cross.phase === 'approach' || cross.phase === 'cut') {
      const d = Math.hypot(P.x - g.x, P.z - g.z);
      // monotone: once the camera has started down it never climbs back out
      cross.w = Math.max(cross.w, cross.phase === 'cut' ? 1 : 1 - smooth01(24, 90, d));
      const w = cross.w;
      if (cross.phase === 'approach') crossStop(w);
      hazeTo(cross.fog, cross.haze, w * 0.75, w);
      if (cross.glow) cross.glow.material.opacity = w * 0.85;
      if (w <= 0.001) return false;
      const f = passDir(g, into, _vB);
      const e = easeVoyage(w);
      // chase pose (where the normal follow-cam would be) → low astern,
      // eye through the arch to the glow beyond
      _vA.set(P.x - sfx * 26, 13, P.z - sfz * 26);
      // the low shot: astern on the fairway's centre line, but never closer
      // to the arch than its bastions (the eye must not end up in a pillar)
      const along = (P.x - g.x) * f.x + (P.z - g.z) * f.z;    // < 0 before the arch
      const camAlong = Math.min(along - 16, -36);
      const lat = (P.x - g.x) * -f.z + (P.z - g.z) * f.x;     // off the centre line
      // (astern of the hull wherever it is: by the run-in point it is on the
      // centre line anyway, so the arch frames up square as it gets there)
      _vC.set(g.x + f.x * camAlong - f.z * lat, 4.4, g.z + f.z * camAlong + f.x * lat);
      _vA.lerp(_vC, e);
      _vC.set(P.x + sfx * 3, 1.6, P.z + sfz * 3);
      _vD.set(g.x + f.x * 46, 7, g.z + f.z * 46);
      // the eye swings onto the arch only as the hull lines up with it
      _vC.lerp(_vD, e * (0.55 + 0.45 * smooth01(-46, -20, along)));
      _vA.y = Math.max(_vA.y, groundY(st, _vA.x, _vA.z) + 2.2);
      // ease in from wherever the player left the camera, by the hull's
      // PROGRESS (not by frame time): the same shot at 60 fps or at 5
      if (!cross.camFrom) {
        cross.camFrom = { pos: camera.position.clone(), tgt: controls.target.clone(), w };
      }
      const w0 = Math.min(cross.camFrom.w, 0.7);
      const b = smooth01(w0, w0 + 0.3, w);
      camera.position.lerpVectors(cross.camFrom.pos, _vA, b);
      controls.target.lerpVectors(cross.camFrom.tgt, _vC, b);
      camera.lookAt(controls.target);
      followSun(st, controls.target);
      return true;
    }
    if (cross.phase === 'reveal') {
      if (cross.skip) {
        snapBehindShip(rec);
        finishCrossing();
        return false;
      }
      const k = Math.min(1, Math.max(0, (now - cross.t0) / cross.dur));
      crossStop(1 + k);
      const e = easeVoyage(k);
      const f = passDir(g, into, _vB);
      // start: deck height in the mouth of the arch, looking out over the
      // realm; end: the ordinary chase pose behind the moving vessel
      // (on the side away from a beached hull, which lies to starboard)
      _vA.set(g.x - f.x * 3 + f.z * 3, 3.4, g.z - f.z * 3 - f.x * 3);
      _vC.set(P.x - sfx * 26, 13, P.z - sfz * 26);
      _vA.lerp(_vC, e);
      _vC.set(g.x + f.x * 70, 6, g.z + f.z * 70);
      _vD.set(P.x + sfx * 3, 1.6, P.z + sfz * 3);
      _vC.lerp(_vD, e);
      _vA.y = Math.max(_vA.y, groundY(st, _vA.x, _vA.z) + 2.2);
      camera.position.copy(_vA);
      controls.target.copy(_vC);
      camera.lookAt(controls.target);
      // the realm's own haze, thick at the threshold, thinning as we rise
      hazeTo(cross.destFog, cross.haze, 0, 1 - e);
      followSun(st, controls.target);
      if (k >= 1) finishCrossing();
      return true;
    }
    return false;
  }

  /* any key cuts the crossing short (the tap is handled with the other
     cinematics in pointerdown) */
  window.addEventListener('keydown', (e) => {
    if (cross && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) skipCrossing();
  });

  /* a realm crossed on foot (the desert): its captain walks, no boat */
  function isFootStage(stageId) {
    return !!(stageId && stageId !== 'hub'
      && lastRoom?.board?.regions?.[stageId]?.mode === 'foot');
  }

  function syncShips(room, you) {
    const playersByPid = {};
    const movedNow = [];
    room.players?.forEach((p, idx) => {
      playersByPid[p.pid] = p;
      const rec = ensureShip(p, idx);
      rec.idx = idx;

      // mid arrow-walk the server holds your true node until the roll
      // resolves, but hands YOU the walk's head — drive the captain there
      // so he strides up to each fork, then its arrows appear
      let nodeNow = (p.pid === myPid && room.walk?.node) ? room.walk.node : p.node;
      // CROSSING A PASS: the server carries a captain through ~1.8 s after
      // landfall, while the hull may still be miles out. Hold the vessel's
      // visual node at the gate until it has actually sailed through the arch
      // (tickShips releases the hold). A jump anywhere else — a dev drop, a
      // respawn at a haven — drops the hold and is honoured at once.
      // a hold only lives while its sail-up is actually playing on screen
      if (rec.hold && (!rec.anim || rec.stageId !== activeBoardId)
          && !(cross && cross.pid === rec.pid)) rec.hold = null;
      if (rec.hold) {
        const far = nodeById[nodeNow];
        const carried = nodeNow === rec.hold.gate
          || (far && (nbrs[rec.hold.gate] || []).includes(nodeNow)
              && (rec.hold.to === 'hub' ? !far.region : far.region === rec.hold.to));
        if (carried) nodeNow = rec.node;
        else releaseHold(rec, true);
      }
      const moved = rec.node !== nodeNow;
      if (moved) { rec.prevNode = rec.node; rec.node = nodeNow; movedNow.push(rec); }

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
        const inActive = stageHasNode(activeBoardId, rec.node);
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
      if (doTravel) {
        startTravel(rec, rec.node, stages[activeBoardId]);
        if (rec.hold && rec.pid === myPid) beginCrossing(rec);
      }
      if (rec.needPlace && rec.stageId && stages[rec.stageId]) {
        const pv = nodeById[rec.prevNode];
        rec.root.position.copy(slotFor(rec.node, rec.idx, stages[rec.stageId],
          pv ? _vC.set(pv.x, 0, pv.z) : null, rec.pid));
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
    // the Ghost Ship's trick: two captains traded places in one update →
    // each hull dissolves into spectral mist and condenses at the other's
    // berth (ghostswap.js) instead of the two gliding through each other
    for (let i = 0; i < movedNow.length; i++) {
      for (let j = i + 1; j < movedNow.length; j++) {
        const a = movedNow[i], b = movedNow[j];
        if (a.node !== b.prevNode || b.node !== a.prevNode || !a.anim || !b.anim) continue;
        if (a.stageId !== activeBoardId || b.stageId !== activeBoardId) continue;
        for (const r of [a, b]) {
          const pending = r.arrivalPending;
          r.anim = null;
          r.arrivalPending = false;
          spectralSwap(stages[activeBoardId].scene, r.root, slotFor(r.node, r.idx, stages[activeBoardId], null, r.pid));
          // the UI waits on the hull parking: hand it the arrival once the mist clears
          if (pending) setTimeout(() => onShipArrive(r.pid), 1450);
        }
      }
    }
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
    // my own crossing owns the view (and holds the dice) until the reveal
    if (cross && ships[cross.pid] && cross.phase !== 'reveal') return cross.pid;
    // (only vessels on the stage in view: an off-stage voyage is not watched)
    for (const pid in ships) {
      if (ships[pid].anim && ships[pid].stageId === activeBoardId) return pid;
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
    // only this stage's waters light up. The Amber Vale shows NO beacons at
    // all: the golden trail arrows are its one wayfinder, and light shafts
    // over fogged stops both spoiled the maze and doubled the signage.
    const onGate = nodeById[room.players?.find((p) => p.pid === you)?.node]?.type === 'gate';
    const ids = myTurn && activeBoardId !== 'autumn'
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

  /* the Vale's WAYFINDER: the server hands the walker their open trails
     (room.walk.options) — lay a run of flat golden arrows down each one.
     Tap an arrow and the roll walks that road, pausing at the next fork
     (fresh options arrive and the arrows re-lay). */
  function syncValeArrows(room, you) {
    const w = room?.walk;
    const want = activeBoardId === 'autumn' && !battleOn && !fading
      && room?.phase === 'sail' && room.turn === you
      && w && w.options && w.options.length && !animatingPid();
    const key = want ? w.node + '>' + w.options.join(',') : '';
    if (key === arrowKey) return;
    arrowKey = key;
    valeArrows.clear();                      // shared geometry/material: no dispose
    if (!want) return;
    const head = nodeById[w.node];
    if (!head) return;

    // FAN the branches apart on screen: whatever the maze generated, two
    // roads leaving this stop never DRAW (or hit-test) closer than ~29° —
    // the arrows stay distinct and every tap is unambiguous. The fanned
    // angle is presentation only; the tap still walks to the true stop.
    const MIN_FAN = 0.5;
    const dirs = [];
    for (const dest of w.options) {
      const d = nodeById[dest];
      if (!d) continue;
      dirs.push({ dest,
                  len: Math.hypot(d.x - head.x, d.z - head.z) || 1e-6,
                  ang: Math.atan2(d.z - head.z, d.x - head.x) });
    }
    dirs.sort((a, b) => a.ang - b.ang);
    for (let it = 0; it < 8; it++) {
      let moved = false;
      for (let k = 0; k + 1 < dirs.length; k++) {
        const gap = dirs[k + 1].ang - dirs[k].ang;
        if (gap < MIN_FAN) {
          const push = (MIN_FAN - gap) / 2 + 0.005;
          dirs[k].ang -= push;
          dirs[k + 1].ang += push;
          moved = true;
        }
      }
      if (dirs.length > 2) {                       // the wraparound pair
        const wrap = dirs[0].ang + 2 * Math.PI - dirs[dirs.length - 1].ang;
        if (wrap < MIN_FAN) {
          const push = (MIN_FAN - wrap) / 2 + 0.005;
          dirs[0].ang += push;
          dirs[dirs.length - 1].ang -= push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    valeArrows.userData.fan = {};                  // ground-tap fallback reads this
    for (const f of dirs) valeArrows.userData.fan[f.dest] = f.ang;

    for (const { dest, len, ang } of dirs) {
      const ux = Math.cos(ang), uz = Math.sin(ang);
      const yaw = Math.atan2(-ux, -uz);            // -Z pre-yaw → down-trail

      // ONE long arrow per branch: shaft from the captain's feet, head at
      // the far end — a single unmistakable pointer per road
      const start = 3.5;
      const tip = Math.max(start + 7, Math.min(len - 2, 26));
      const shaftLen = tip - ARROW_HEAD_LEN - start;
      const shaft = new THREE.Mesh(ARROW_SHAFT_GEO, ARROW.shaftMat);
      shaft.scale.set(1, 1, shaftLen);
      shaft.position.set(head.x + ux * (start + shaftLen / 2), 0.3,
                         head.z + uz * (start + shaftLen / 2));
      shaft.rotation.y = yaw;
      shaft.renderOrder = 30;                      // over stones, trees, smoke
      shaft.userData = { node: dest, walkArrow: true };
      const ahead = new THREE.Mesh(ARROW_HEAD_GEO, ARROW.headMat);
      ahead.position.set(head.x + ux * (tip - ARROW_HEAD_LEN), 0.3,
                         head.z + uz * (tip - ARROW_HEAD_LEN));
      ahead.rotation.y = yaw;
      ahead.renderOrder = 30;
      ahead.userData = { node: dest, walkArrow: true };
      valeArrows.add(shaft, ahead);

      // a fat invisible ribbon so a tap ANYWHERE along the branch — shaft,
      // TIP, or a stretch past the tip — takes that road
      const L = Math.max(12, Math.min(len - 2, tip + 8));
      const strip = new THREE.Mesh(STRIP_GEO, STRIP_MAT);
      strip.scale.set(18, 5, L);
      strip.position.set(head.x + ux * (L / 2 + 1.5), 1.6, head.z + uz * (L / 2 + 1.5));
      strip.rotation.y = Math.atan2(ux, uz);
      strip.userData = { node: dest, walkArrow: true };
      valeArrows.add(strip);
    }
  }

  /* A bold "you can land here" beacon: a bright ring on the water, a shaft of
   * gold light, and a big downward chevron hovering over the spot. Unmistakable
   * from the low chase camera, and steady (gentle bob, no harsh flicker).
   * Every piece is a click target and carries userData.node. */
  const HL_BRIGHT = 0xffe27a;
  function addBeacon(nid, n, R) {
    const x = n?.x ?? 0, z = n?.z ?? 0;
    const rr = Math.max(3.6, R);
    // ring, halo, beam, chev, disc — same roles/userData as before, drawn as
    // a crisp soft-edged ring, a pool of light, a fading shaft and a gold gem
    // (models/props.js). Fog-free: it is UI.
    highlights.add(...makeReachBeacon(nid, x, z, rr, HL_BRIGHT));
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
    // the Vale is a wall of giant trees that swallows the horizon — let the
    // eye crane further up here to look past the canopy to the barrow beacon
    // poking through it; other realms keep the flatter cap (just the skyline).
    // And LOCK the chase in tight to the captain so the camera can't dolly
    // back out through the trunks (no clipping deep into the wood).
    // (OrbitControls.update() clamps the live distance into this band every
    // frame, so an already-dollied-out camera pulls itself back in on entry)
    if (stageId === 'autumn') {
      controls.maxPolarAngle = 1.52;
      controls.minDistance = 20; controls.maxDistance = 26;
    } else {
      controls.maxPolarAngle = 1.34;
      controls.minDistance = 16; controls.maxDistance = 84;
    }
    if (lastRoom) syncStage(st, lastRoom);
    if (cross && cross.phase === 'cut' && cross.to === stageId) placeCrossed(st);
    /* move the ride-along groups into this scene */
    st.scene.add(highlights, fx, valeArrows);
    hiKey = '';
    arrowKey = '';
    for (const sp of wakePool) sp.visible = false;
    if (lastRoom) {
      syncShips(lastRoom, myPid);
      syncHighlights(lastRoom, myPid);
      syncValeArrows(lastRoom, myPid);
    }
    if (cross && cross.placed && cross.to === stageId) {
      // just through the arch: glide on to the first stop (or, if the server
      // has not carried us yet, out to the realm-side berth)
      cross.placed = false;
      const rec = ships[cross.pid];
      if (rec && !rec.anim) startTravel(rec, rec.node, st);
    } else if (prevId !== stageId) {
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
    // (b.mode comes from the server: for a fight in a private Vale the node
    // id is veiled, so the local board can't answer "on foot?")
    const heroKind = (b.is_pharos || b.mode === 'foot' || node?.mode === 'foot')
      ? 'captain' : 'ship';
    battleKey = b.node + '|' + (fighter?.pid || '') + '|' + (b.name || '') + '|' + (b.round != null ? 'r' : '');
    battleStage.enter({
      battle: b, room, you: myPid, theme,
      heroColor: fighter?.color || '#e4572e', heroKind,
    });
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    battleStage.resize(w, h);
    pipe.setLook(battleStage.look());     // the diorama's exposure, bloom and grade
    litStage = null;
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
    // (a pass crossing counts to its last frame: no tray under the arch)
    if (cross && cross.pid === mover) return true;
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
    // a battle interrupts a crossing; otherwise the crossing owns the stage
    if (cross && (room.battle || battleHold)) abortCrossing();
    if (cross) return cross.phase === 'approach' ? cross.from : cross.to;
    const mine = ships[myPid];
    if (mine?.hold && mine.stageId && !room.battle) return mine.stageId;
    // hold the cut to the battle stage until the boat finishes sailing up —
    // and keep it up through the VICTORY / YOU DIED card, so the closing
    // beat plays over the diorama, not the board the fight has left behind.
    if ((room.battle || battleHold) && !arriving(room)) return 'battle';
    // The Amber Vale is each captain's PRIVATE labyrinth — fogged from everyone
    // else — so the view only ever walks INTO the woods for ME. While I stand
    // in my own Vale, stay there no matter whose turn it is: otherwise a rival's
    // turn out on the hub would yank the camera off to the sea and blank my
    // whole forest for the length of their move ("after a battle all the trees
    // despawn" — the turn had simply passed to a captain out of the woods).
    const me = room.players?.find((p) => p.pid === myPid);
    const myNode = me && nodeById[me.node];
    if (myNode && myNode.region === 'autumn' && myNode.type !== 'gate')
      return 'autumn';
    // stay in the stage of whoever is actually on the move (or the active
    // captain once everyone's parked) — but never get dragged INTO the Vale to
    // spectate a rival's maze we cannot see; hold our own ground instead.
    const focus = focusPid(room) || myPid;
    let tgt = stageForViewer(room, focus);
    if (tgt === 'autumn' && focus !== myPid) tgt = stageForViewer(room, myPid);
    return tgt;
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
    // hold the arena reveal behind the black curtain until the boss model is
    // actually loaded — the entrance is lost if the boss pops in afterwards.
    const gate = target === 'battle' ? bossReady(lastRoom) : Promise.resolve();
    gate.then(() => setTimeout(() => {
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
    }, FADE_MS));
  }

  /* resolve once every BOSS in the pending fight has its model loaded (or at
   * once if there's no boss / it's already warm) — used to keep the battle
   * curtain down until the entrance can actually land. */
  function bossReady(room) {
    const b = room && room.battle;
    if (!b || !b.enemies) return Promise.resolve();
    const bosses = b.enemies
      .map((e) => e.model || e.name)
      .filter((id) => id && BOSS_IDS.has(id));
    if (!bosses.length) return Promise.resolve();
    return Promise.all(preloadMonsters(bosses)).catch(() => {});
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
    cross = null;
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

    /* rematch / new sea detection. NOT total node count: the Amber Vale's
     * fog reveals stops (its gate included) mid-game, growing the list —
     * counting them made every reveal read as a brand-new sea, wiping the
     * world and replaying the whole opening fly-over. Only hub-side data is
     * stable through reveals; a real rematch re-rolls Home Port's position
     * and the hub's waypoint lattice. (Both branches fixed this the same
     * way — the hub count is kept as a belt-and-suspenders rematch guard.) */
    const home = nodeById.home;
    const hubN = nodes.reduce((k, n) => k + (n.region ? 0 : 1), 0);
    const sig = `${home?.x},${home?.z}:${room.code}:${hubN}`;
    if (boardSig && boardSig !== sig) clearWorld();
    boardSig = sig;

    if (!preloadedCaptain && nodes.some((n) => n.mode === 'foot')) {
      preloadedCaptain = true;
      preloadMonsters(['captain']);
    }

    /* Preload the WHOLE bestiary of the realm the local captain now stands in
     * (or the open-sea ambush pool in the hub) the instant we cross into it —
     * every model a hunting ground could roll, plus the boss — so a fight never
     * stalls streaming a cold GLB. Keyed on the region so it fires once per
     * crossing, and covers any entry path (sailing in, or landing straight into
     * an ambush) that the stage-activation preload might skip. */
    const meNode = nodeById[room.players?.find((p) => p.pid === you)?.node];
    const myRegion = meNode ? (meNode.region || 'hub') : null;
    const rmodels = room.config?.region_models;
    if (myRegion && myRegion !== preloadedRegion && rmodels) {
      preloadedRegion = myRegion;
      preloadMonsters(rmodels[myRegion] || rmodels.hub || []);
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
      syncValeArrows(room, you);
    }

    /* now pick the stage — stays glued to whoever is mid-sail, and only hands
     * off to the next captain once their boat has actually parked. The
     * opening tour owns the stage while it runs. */
    if (!tour) requestStage(desiredTarget(room));

    /* establishing pan: once when the voyage begins, and each time you first
     * cross into a new realm (never in the lobby, never mid-battle) */
    // A RELOAD / rejoin into a running voyage (this page's very first
    // snapshot is already past the lobby) warms the models silently and
    // drops you straight back at your ship — no fly-over, no loading curtain
    // over a live question. Only a voyage seen starting (lobby → play, or a
    // rematch) gets the tour.
    if (firstSnap && room.code !== 'title-vista') {     // (the title backdrop isn't a snapshot)
      firstSnap = false;
      if (!lobbyMode) { wasLobby = false; warmSilently(); }
    }
    if (wasLobby && !lobbyMode && activeBoardId && !battleOn) {
      seenStages.add(activeBoardId);
      gateTourThenStart();               // preload → loading bar → fly-over
    }
    wasLobby = lobbyMode;

    /* battle re-key: a brand-new fight arriving while one is showing */
    if (battleOn && room.battle) {
      const fighter = room.players?.find((p) => p.pid === room.turn);
      // include the monster NAME so a mid-fight foe SWAP re-keys: the Sphinx
      // failing her riddle replaces herself with a real pack on the SAME node,
      // same fighter, same round — without her name in the key the diorama
      // would keep showing the Sphinx while you fight her guard.
      const key = room.battle.node + '|' + (fighter?.pid || '') + '|' + (room.battle.name || '') + '|' + (room.battle.round != null ? 'r' : '');
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
    skipCrossing();           // …and a pass crossing
    endTour();                // …and the opening tour
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    // fingers drift: a real-world tap easily wanders past 6px, and every
    // one of those used to be discarded as a camera drag — the #1 "my tap
    // did nothing" report on the Vale arrows
    const slop = e.pointerType === 'touch' ? 18 : 9;
    if (moved > slop || battleOn || fading || renderPaused) return;  // view-only drag
    const st = stages[activeBoardId];
    // NOT gated on proxyList: the fogged Vale can have ZERO built islands,
    // and this early-out was killing every tap before the trail arrows even
    // got raycast — the arrows read as simply broken
    if (!st) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(pointer, camera);

    // THE AMBER VALE WALK: the arrows are DIRECTIONAL, not precise hitboxes.
    // The fanned trails overlap heavily near the captain, so raycasting the
    // ribbons grabbed the wrong branch (or missed). Instead: any tap picks
    // the branch whose fanned arrow points nearest it — deterministic, and
    // the road you tapped is always the road you get. This runs FIRST and
    // owns every tap on a Vale walk turn, so the overlap can never mislead.
    const w = lastRoom?.walk;
    if (w && w.options && w.options.length && lastRoom.turn === myPid
        && lastRoom.phase === 'sail' && activeBoardId === 'autumn') {
      const head = nodeById[w.node];
      const pt = ray.ray.intersectPlane(_ground, _vD);
      if (head && pt) {
        const px = pt.x - head.x, pz = pt.z - head.z;
        const pd = Math.hypot(px, pz);
        if (pd > 1.5) {
          let best = null, bestDot = -2;         // ALWAYS take the nearest arrow
          const fan = valeArrows.userData.fan || {};
          for (const dest of w.options) {
            // judge against the FANNED direction the arrows actually draw at
            let dx, dz;
            if (fan[dest] != null) {
              dx = Math.cos(fan[dest]); dz = Math.sin(fan[dest]);
            } else {
              const dn = nodeById[dest];
              if (!dn) continue;
              dx = dn.x - head.x; dz = dn.z - head.z;
              const L = Math.hypot(dx, dz) || 1e-6; dx /= L; dz /= L;
            }
            const dot = (px * dx + pz * dz) / pd;
            if (dot > bestDot) { bestDot = dot; best = dest; }
          }
          if (best) handlers.onNodeClick?.(best, true);
        }
      }
      return;                                    // Vale-walk taps are ours
    }

    // prefer a LEGAL stop among ALL hits: from behind the ship your own
    // stop's (invisible, tall) proxy covers the lit stops ahead, and taking
    // the first hit swallowed the tap. Nearest legal hit wins; else nearest.
    const hits = ray.intersectObjects(
      [...st.proxyList, ...highlights.children, ...valeArrows.children], false)
      .filter((h) => h.object.userData.node);
    const legal = (lastRoom && lastRoom.turn === myPid && lastRoom.phase === 'sail')
      ? new Set([...Object.keys(lastRoom.reachable || {}), ...(lastRoom.walk?.options || [])])
      : null;
    let hit = (legal && hits.find((h) => legal.has(h.object.userData.node))) || null;
    if (!hit && legal && legal.size) {
      // a near miss on a phone: the lit stop closest on screen within a
      // finger's width still counts
      const lim = e.pointerType === 'touch' ? 44 : 26;
      let bestD = lim, bestId = null;
      for (const id of legal) {
        const n = nodeById[id];
        if (!n || !stageHasNode(activeBoardId, id)) continue;
        _vD.set(n.x, (st.islands[id]?.plateauY ?? 0) + 1, n.z).project(camera);
        if (_vD.z > 1) continue;                    // behind the camera
        const sx = (_vD.x + 1) / 2 * rect.width, sy = (1 - _vD.y) / 2 * rect.height;
        const d = Math.hypot(sx - (e.clientX - rect.left), sy - (e.clientY - rect.top));
        if (d < bestD) { bestD = d; bestId = id; }
      }
      if (bestId) hit = { object: { userData: { node: bestId } } };
    }
    hit = hit || hits[0];
    if (hit) {
      handlers.onNodeClick?.(hit.object.userData.node,
                             !!hit.object.userData.walkArrow);
    }
  });

  /* ── resize ─────────────────────────────────────────────────────────── */
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pipe.setSize(w, h);
    battleStage.resize(w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ── per-frame animation ────────────────────────────────────────────── */
  function tickAmbience(st, t) {
    st.surf.update(t, controls.target, st.scene.fog);
    st.wall?.userData?.update?.(t);
    if (st.particles) {
      st.particles.points.position.x = controls.target.x;
      st.particles.points.position.z = controls.target.z;
      st.particles.update(t);
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

  let shipPrev = 0, shipDt = 0.016;
  function tickShips(st, t, now) {
    // real elapsed time (not the render clamp): the helm must keep pace with
    // the route progress, which is wall-clock — even on a starved frame
    shipDt = shipPrev ? Math.min(0.5, (now - shipPrev) / 1000) : 0.016;
    shipPrev = now;
    let arrived = null;
    for (const pid in ships) {
      const rec = ships[pid];
      if (rec.stageId !== st.id) {
        // a voyage on a stage nobody is watching finishes at once: left
        // un-ticked it never ended, and held the dice ("the dust still
        // settles") and the camera for every captain on another stage
        if (rec.anim && !(cross && cross.pid === rec.pid)) {
          const an = rec.anim;
          routeAt(an.route, an.total, rec.root.position, _vA, an.seg);
          rec.root.rotation.y = Math.atan2(-_vA.z, _vA.x);
          if (rec.hold) crossedPass(rec);
          rec.anim = null;
          if (rec.arrivalPending) { rec.arrivalPending = false; arrived = arrived || rec.pid; }
        }
        continue;
      }
      let moving = false;
      if (rec.anim) {
        const an = rec.anim;
        const k = Math.min(1, (now - an.t0) / an.dur);
        const s = routeS(an.route, easeVoyage(k), an.seg);
        an.seg = routeAt(an.route, s, rec.root.position, _vA, an.seg);
        // the bow follows the curve's tangent at a capped turn rate — no
        // pivoting on the spot, no crabbing sideways; a walker turns quicker
        const foot = rec.mode === 'foot';
        // a man facing the wrong way turns on his heel BEFORE he steps off
        // (a hull can't — its route already leaves along the bow)
        if (foot) {
          let off = Math.atan2(-_vA.z, _vA.x) - rec.root.rotation.y;
          off -= Math.round(off / (Math.PI * 2)) * Math.PI * 2;
          if (Math.abs(off) > 0.6 && s < an.total * 0.5) an.t0 += shipDt * 1000;
        }
        rec.root.rotation.y = helm(rec.root.rotation.y, _vA.x, _vA.z, shipDt,
                                   foot ? 5.5 : 1.9, foot ? 14 : 7);
        if (foot && st.surf.heightAt) rec.root.position.y = Math.max(0, st.surf.heightAt(rec.root.position.x, rec.root.position.z));
        moving = true;
        // a crossing vessel CUTS through the arch a beat before it stops
        if (rec.hold && (k >= 1 || (cross && cross.pid === rec.pid && an.total - s < 7))) {
          crossedPass(rec);
        }
        if (rec.anim && k >= 1) {
          rec.anim = null; moving = false;
          if (rec.arrivalPending) { rec.arrivalPending = false; arrived = rec.pid; }
        }
        /* wake foam while the galley sails — dropped at the stern, so the
           trail of foam traces the curve the hull actually carved */
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
        const wave = st.surf.waveHeight;
        if (wave) {
          // ride the real swell: heave with the surface, pitch and roll to its slope
          const p = rec.root.position, yaw = rec.root.rotation.y;
          const fx = Math.cos(yaw), fz = -Math.sin(yaw);
          const h0 = wave(p.x, p.z, t);
          const bow = wave(p.x + fx * 2.2, p.z + fz * 2.2, t), stern = wave(p.x - fx * 2.2, p.z - fz * 2.2, t);
          const port = wave(p.x - fz * 1.0, p.z + fx * 1.0, t), stbd = wave(p.x + fz * 1.0, p.z - fx * 1.0, t);
          rec.galley.position.y = (h0 - WATER_Y) * 0.85;
          rec.galley.rotation.z = Math.atan2(bow - stern, 4.4) * 0.8;
          rec.galley.rotation.x = Math.atan2(stbd - port, 2.0) * 0.6 + Math.sin(t * 1.4 + rec.phase) * 0.015;
        } else {
          rec.galley.position.y = Math.sin(t * 1.9 + rec.phase) * 0.1;
          rec.galley.rotation.z = Math.sin(t * 1.4 + rec.phase) * 0.04;
        }
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
    if (resyncShips && lastRoom) {
      resyncShips = false;
      syncShips(lastRoom, myPid);
      requestStage(desiredTarget(lastRoom));
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
      followSun(st, controls.target);
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
    followSun(st, controls.target);
    return true;
  }

  /* ── AFTER A ROLL: frame the ship AND every stop it may sail to ─────────
     The chase cam sits low behind the ship, so the lit stops were often all
     off-screen. While it is my sail decision the follow point leans toward
     the stops' centre (reachAim) and the eye eases OUT — just far enough —
     until all of them sit inside a safe screen box (reachFit). A drag or
     pinch by the player hands the camera back to them for that decision. */
  let reachKey = '', reachManual = false, reachPts = [];
  {
    // a real drag / pinch / wheel — not a tap on a stop — is "manual"
    let dn = null;
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => { dn = [e.clientX, e.clientY]; });
    el.addEventListener('pointermove', (e) => {
      if (dn && reachKey && Math.hypot(e.clientX - dn[0], e.clientY - dn[1]) > 18) reachManual = true;
    });
    el.addEventListener('pointerup', () => { dn = null; });
    el.addEventListener('wheel', () => { if (reachKey) reachManual = true; }, { passive: true });
  }
  function reachTargets(st) {
    const r = lastRoom;
    const ok = r && r.phase === 'sail' && r.turn === myPid && !r.battle && !tour && !cross
      && !cine && !battleOn && activeBoardId !== 'autumn' && ships[myPid]?.stageId === st.id;
    const ids = ok ? Object.keys(r.reachable || {}).filter((id) => stageHasNode(st.id, id)).sort() : [];
    const key = ids.length ? st.id + '#' + ids.join(',') : '';
    if (key !== reachKey) {
      reachKey = key; reachManual = false;
      reachPts = ids.map((id) => {
        const n = nodeById[id];
        return new THREE.Vector3(n.x, (st.islands[id]?.plateauY ?? 0) + 1, n.z);
      });
      reachAll = ids.map((id, i) => ({ id, v: reachPts[i] }));
      // frame the stops within a sane radius of the ship (a big fork can fan
      // stops far apart); the far ones are the chart's job. Keep ≥ the nearest.
      const sp = ships[myPid]?.root.position;
      if (sp && reachPts.length) {
        reachPts.sort((a, b) => a.distanceToSquared(sp) - b.distanceToSquared(sp));
        // (a narrow portrait screen holds less sea side to side: frame closer stops)
        const R = 95 * Math.min(1, Math.max(0.6, camera.aspect * 1.3));
        const near = reachPts.filter((v, i) => i === 0 || Math.hypot(v.x - sp.x, v.z - sp.z) <= R);
        reachPts = near;
      }
    }
    return reachKey && !reachManual ? reachPts : null;
  }
  /* EDGE POINTERS — a legal stop the frame cannot hold (a narrow phone holds
     ~50 units of sea side to side; a roll can fan stops 110 apart) gets a
     gilded chip on the screen edge, pointing its way and naming it. Tapping
     the chip sails there, so no legal stop is ever out of reach of a thumb. */
  let reachAll = [];
  const EDGE_LABEL = { sea: 'Open water', rocks: 'Open water', haven: 'Haven', shrine: 'Oracle', shop: 'Trader',
    puzzle: 'Puzzle spire', monster: 'Hunting ground', gate: 'Mountain pass', home: 'Home Port',
    lair: 'Boss lair', pharos: 'The Pharos' };
  const edgeEl = document.createElement('div');
  edgeEl.id = 'reachEdge';
  container.appendChild(edgeEl);
  const edgeChips = new Map();
  let edgeShown = false;
  function edgeChip(id) {
    let c = edgeChips.get(id);
    if (c) return c;
    c = document.createElement('button');
    c.type = 'button';
    c.className = 'redge';
    c.innerHTML = '<span class="redge-arrow"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12h12M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="redge-name"></span>';
    c.addEventListener('pointerdown', (e) => e.stopPropagation());
    c.addEventListener('click', (e) => { e.stopPropagation(); handlers.onNodeClick?.(id, false); });
    edgeEl.appendChild(c);
    edgeChips.set(id, c);
    return c;
  }
  function tickReachEdge(st) {
    const r = lastRoom;
    const on = reachKey && r && r.phase === 'sail' && r.turn === myPid && !cross && !cine && !tour
      && !battleOn && activeBoardId !== 'autumn' && !animatingPid();
    if (!on) {
      if (edgeShown) { edgeShown = false; for (const c of edgeChips.values()) c.remove(); edgeChips.clear(); }
      return;
    }
    edgeShown = true;
    const w = container.clientWidth, h = container.clientHeight;
    const portrait = w < h * 0.8;
    // the clear window between the HUD bars (NDC)
    const xm = portrait ? 0.8 : 0.9, yTop = portrait ? 0.6 : 0.68, yBot = portrait ? -0.46 : -0.5;
    const live = new Set();
    const placed = [];
    for (const { id, v } of reachAll) {
      _vD.copy(v).project(camera);
      let x = _vD.x, y = _vD.y;
      const behind = _vD.z > 1;
      if (behind) { x = -x; y = -y; }
      if (!behind && Math.abs(x) <= 0.97 && y <= 0.84 && y >= -0.62) continue;   // in view: its own glow does the job
      live.add(id);
      const k = Math.min(xm / Math.max(Math.abs(x), 1e-4), (y > 0 ? yTop : -yBot) / Math.max(Math.abs(y), 1e-4));
      if (k < 1 || behind) { x *= k; y *= k; }
      x = Math.max(-xm, Math.min(xm, x)); y = Math.max(yBot, Math.min(yTop, y));
      let px = (x * 0.5 + 0.5) * w, py = (-y * 0.5 + 0.5) * h;
      // chips for stops in the same quarter stack along the edge
      const along = Math.abs(x) >= xm - 0.02 ? 'y' : 'x';
      for (let n = 0; n < 8; n++) {
        const hit = placed.find((q) => Math.abs(q.px - px) < 118 && Math.abs(q.py - py) < 36);
        if (!hit) break;
        if (along === 'y') py += (py >= hit.py ? 38 : -38); else px += (px >= hit.px ? 122 : -122);
      }
      px = Math.max(62, Math.min(w - 62, px));
      placed.push({ px, py });
      const c = edgeChip(id);
      const n = nodeById[id];
      const name = (n.type !== 'sea' && n.name) || EDGE_LABEL[n.type] || 'A stop';
      const nm = c.lastChild;
      if (nm.textContent !== name) nm.textContent = name;
      c.style.transform = `translate(${px.toFixed(0)}px, ${py.toFixed(0)}px) translate(-50%, -50%)`;
      c.firstChild.style.transform = `rotate(${(Math.atan2(-(y), x) * 180 / Math.PI).toFixed(0)}deg)`;
    }
    for (const [id, c] of edgeChips) if (!live.has(id)) { c.remove(); edgeChips.delete(id); }
  }

  function reachAim(st, aim) {
    const pts = reachTargets(st);
    if (!pts || !pts.length) return;
    let x = aim.x, z = aim.z;
    for (const p of pts) { x += p.x; z += p.z; }
    const k = 1 / (pts.length + 1);
    // lean halfway to the centroid: the ship stays well in frame
    aim.x += (x * k - aim.x) * 0.5;
    aim.z += (z * k - aim.z) * 0.5;
  }
  const _reachSph = new THREE.Spherical();
  const REACH_MAX = 140;            // how far out the eye may ease to frame a roll
  let reachBase = null;             // {stage, max}: the stage's own zoom cap, restored after
  function reachFit(st, dt) {
    const pts = reachTargets(st);
    const k = Math.min(1, dt * 1.6);
    if (reachBase && reachBase.stage !== st.id) reachBase = null;   // the stage re-set its caps
    if (!pts || !pts.length) {
      // the decision is over: ease back in to the stage's own zoom cap
      if (!reachBase) return;
      _vD.subVectors(camera.position, controls.target);
      _reachSph.setFromVector3(_vD);
      if (_reachSph.radius > reachBase.max + 0.5) {
        _reachSph.radius = Math.max(reachBase.max, _reachSph.radius * (1 - k * 0.6));
        controls.maxDistance = Math.max(reachBase.max, _reachSph.radius);
        _vD.setFromSpherical(_reachSph);
        camera.position.copy(controls.target).add(_vD);
      } else {
        controls.maxDistance = reachBase.max;
        reachBase = null;
      }
      return;
    }
    const portrait = camera.aspect < 0.8;
    // keep clear of the HUD: the top bar and the bottom tray / belt
    const xm = portrait ? 0.84 : 0.86, yTop = portrait ? 0.62 : 0.7, yBot = portrait ? -0.5 : -0.55;
    const ship = ships[myPid].root.position;
    let out = false;
    for (let i = -1; i < pts.length && !out; i++) {
      _vD.copy(i < 0 ? ship : pts[i]).project(camera);
      out = _vD.z > 1 || Math.abs(_vD.x) > xm || _vD.y > yTop || _vD.y < yBot;
    }
    if (!out) return;
    if (!reachBase) reachBase = { stage: st.id, max: controls.maxDistance };
    controls.maxDistance = Math.max(controls.maxDistance, REACH_MAX);
    _vD.subVectors(camera.position, controls.target);
    _reachSph.setFromVector3(_vD);
    // ease out AND tip the eye a little more overhead — both widen the
    // patch of sea in view; stop as soon as everything fits
    _reachSph.radius = Math.min(REACH_MAX, _reachSph.radius * (1 + k));
    _reachSph.phi = Math.max(0.62, _reachSph.phi - k * 0.25);
    _vD.setFromSpherical(_reachSph);
    camera.position.copy(controls.target).add(_vD);
  }

  function tickCamera(st, t, dt = 0.016) {
    if (window.__freezeCam) {              // dev/screenshot hook only
      followSun(st, controls.target);
      controls.update();
      return;
    }
    controls.autoRotate = lobbyMode && !cine;
    viewFollowPid = focusPid(lastRoom);   // follow the mover, then the next captain
    if (cross) { if (crossingCamera(st, performance.now(), dt)) return; }
    if (cine) { if (tickCinematic(st, performance.now())) return; }
    if (!lobbyMode) {
      const rec = viewFollowPid ? ships[viewFollowPid] : null;
      if (rec && rec.stageId === st.id) {
        _vA.copy(rec.root.position);
        // nearing the berth, the eye leads a little toward it so the stop
        // the vessel is making for is framed, not just its stern
        if (rec.anim) {
          const pts = rec.anim.route.pts, end = pts[pts.length - 1];
          const left = Math.hypot(end.x - _vA.x, end.z - _vA.z);
          _vA.lerp(end, 0.3 * smooth01(40, 8, left));
        }
        if (!rec.anim && rec.pid === myPid) reachAim(st, _vA);   // after a roll
        _vA.y = 1.6;
        _vB.subVectors(_vA, controls.target);
        if (_vB.lengthSq() > 0.0001) {
          // frame-rate independent follow (≈ the old 0.1 / 0.06 per frame at 60 fps)
          _vB.multiplyScalar(1 - Math.exp(-dt * (rec.anim ? 6.3 : 3.7)));
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
      reachFit(st, dt);                   // after a roll: every lit stop in view
    }
    controls.update();
    guardCamera(st);
    /* keep the tight shadow frustum (and the sun) glued to the action */
    followSun(st, controls.target);
  }

  /* the eye never sinks into land: over an island it stays above the
     plateau, over the dunes / forest floor above the ground, and it is
     pushed out of any berg, stack or trunk it would sit inside */
  const _camNear = [];
  function guardCamera(st) {
    const c = camera.position;
    let floor = st.surf.heightAt ? Math.max(0, st.surf.heightAt(c.x, c.z)) + 2.2 : 1.2;
    for (const id in st.islands) {
      const isle = st.islands[id];
      const n = nodeById[id];
      if (!n || (n.type === 'sea' && !seaSolid(n)) || n.type === 'gate') continue;
      const d = Math.hypot(c.x - n.x, c.z - n.z);
      if (d < (isle.R ?? 4) * 1.05) floor = Math.max(floor, (isle.plateauY ?? 1) * 1.25 + 3.5);
    }
    if (st.obstacles) {
      _camNear.length = 0;
      st.obstacles.near(c.x, c.z, c.x, c.z, 2, _camNear);
      for (const o of _camNear) {
        const dx = c.x - o.x, dz = c.z - o.z, d = Math.hypot(dx, dz);
        const need = o.r + 1.5;
        if (d < need && d > 1e-3) { c.x = o.x + dx / d * need; c.z = o.z + dz / d * need; }
      }
    }
    if (c.y < floor) c.y = floor;
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
      'Slay tyrants and bank THREE sigil seals to open its door — then face the Dark Presence. First to take the tower wins the sea.'],
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
  function warmSilently() {             // a rejoin: same preload, no curtain, no tour
    if (loadGate) return;
    loadGate = true;
    const jobs = [...preloadStructures(), ...preloadProps(),
                  ...preloadMonsters(['captain', ...BOSS_IDS])];
    Promise.allSettled(jobs).catch(() => {});
  }
  function gateTourThenStart() {
    if (loadGate) return;
    loadGate = true;
    const jobs = [
      ...preloadStructures(),
      ...preloadProps(),
      // every boss up front: a boss that streams in AFTER its arena curtain
      // lifts kills the entrance, so warm them all before anyone can arrive
      ...preloadMonsters(['captain', ...BOSS_IDS]),
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
    // only the hub legs clear the air — realms keep their close moody fog
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
      // (a realm with no lair yet — the empty Vale — flies gate → deep wilds)
      if (!leg.path) {
        const gate = Object.values(nodeById).find(
          (n) => n.type === 'gate' && n.region === leg.stage);
        const lair = Object.values(nodeById).find(
          (n) => n.type === 'lair' && n.region === leg.stage);
        leg.path = gate
          ? { gate, lair: lair || { x: gate.x * 1.6, z: gate.z * 1.6 } }
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
      camera.position.set(px - dx * 65, 92, pz - dz * 65);
      controls.target.set(lx, 0, lz);
    }
    controls.update();
    followSun(st, controls.target);
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

  /* the voyage chart (chart.js) is an opaque 2D sheet: while it is fully
     open the world stops rendering (battles always render) */
  let renderPaused = false;

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

  /* ── the kraken surfacing beside a blocked ship ───────────────────────── */
  let krakenRec = null;   // {node, obj}

  /* ── world wonders (events.py → room.world) — static/worldfx.js ─────── */
  const worldFx = createWorldFx();
  wonderSpots = worldFx.spots;
  const worldCtx = {
    stages, stageHasNode, groundY, t: 0, camera,
    get nodeById() { return nodeById; },
    islandR: (stageId, nid) => stages[stageId]?.islands?.[nid]?.R ?? 6,
  };
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
        st.scene.add(mon);
        krakenRec.obj = mon;
      });
    }
    if (krakenRec?.obj) {
      const mon = krakenRec.obj;
      // the kraken's FACE is its local +X (the two glowing eyes and the beak) —
      // aim it straight at the captain's ship every frame so she always glares
      // at the boat (upright: a plain yaw, never the lookAt pitch that tipped her)
      const n = nodeById[krakenRec.node];
      const ship = ships[room?.turn]?.root?.position;
      const tx = ship ? ship.x : (n ? n.x : mon.position.x);
      const tz = ship ? ship.z : (n ? n.z : mon.position.z);
      mon.rotation.set(0, Math.atan2(mon.position.z - tz, tx - mon.position.x), 0);
      animateMonster(mon, tNow, 'idle');
      mon.position.y = -0.8 + Math.sin(tNow * 1.1) * 0.25;  // heave
    }
  }

  /* shadows travel with the view. The sun's shadow frustum is a tight box
     (that's what keeps the shadows crisp), but it used to sit pinned on the
     stage CENTRE — beyond ~120 wu from the Pharos every island rendered
     shadowless and flat. Follow the camera target instead, snapped to a
     coarse grid so the shadow edges don't crawl as the boat glides. */
  function followSun(st, target, dist) {
    st.rig.follow(target, dist ?? camera.position.distanceTo(target));
  }
  function tickSunShadow(st) { followSun(st, controls.target); }

  /* make a stage's light the live one: shared atmosphere, grade, sky ambient */
  let litStage = null;
  function bakeShore(st) {
    st.shoreDirty = false;
    if (!st.surf.setShoreMap) return;                 // sand stages have no sea
    let far = 240;
    for (const id in st.islands) {
      const p = st.islands[id].group.position;
      far = Math.max(far, Math.hypot(p.x - st.center.x, p.z - st.center.z) + 90);
    }
    shore.bake(st.scene, { x: st.center.x, z: st.center.z, size: far * 2 });
    st.surf.setShoreMap(shore);
  }
  function lightStage(st) {
    if (litStage === st) { if (st.shoreDirty) bakeShore(st); return; }
    litStage = st;
    bakeShore(st);
    applyLook(st.look);
    pipe.setLook(st.look);
    if (!st.env) {
      st.env = bakeEnvironment(renderer);
      st.scene.environment = st.env.texture;
    }
  }

  const clock = new THREE.Timer();
  let tPrev = 0, tNow = 0, msPrev = 0;
  renderer.setAnimationLoop(() => {
    clock.update();
    // dev/QA: freeze (see crossStop) or slow (__crossSlow = 0..1, the share
    // of each frame's time withheld) the crossing for slow headless capture
    const slowK = window.__crossHold ? 1 : (cross ? (window.__crossSlow || 0) : 0);
    if (slowK) {
      const ms = (performance.now() - msPrev) * slowK;
      for (const pid in ships) if (ships[pid].anim) ships[pid].anim.t0 += ms;
      if (cross) cross.t0 += ms;
    }
    msPrev = performance.now();
    const t = tNow = clock.getElapsed();
    const dt = Math.min(0.1, t - tPrev);
    tPrev = t;
    if (battleOn) {
      litStage = null;                       // the diorama owns the light while it runs
      battleStage.update(t, dt);
      updateAtmosphere(battleStage.camera, t);
      pipe.render(battleStage.scene, battleStage.camera, dt);
      return;
    }
    if (renderPaused) return;
    const st = stages[activeBoardId];
    if (!st) return;
    const now = performance.now();
    tickAmbience(st, t);
    tickShips(st, t, now);
    tickWake(now);
    tickHighlights(t);
    syncValeArrows(lastRoom, myPid);   // keyed: re-lays when a stride ends
    syncKraken(lastRoom);
    worldCtx.t = tNow;
    worldFx.sync(lastRoom, worldCtx);
    if (tour) tickTour(performance.now());
    else tickCamera(st, t, dt);
    tickReachEdge(st);                    // a chip on the edge for any legal stop out of frame
    tickSunShadow(st);
    lightStage(st);
    setCloudShadows(pipe.quality !== 'low');
    updateAtmosphere(camera, t);
    pipe.render(st.scene, camera, dt);
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

  /* the title screen's backdrop: before any snapshot exists, raise a small
     stand-in archipelago (Pharos, Home Port, a few isles) so the entry card
     sits over the living world instead of a void. The first real snapshot
     has a different board signature and replaces it wholesale. */
  function showTitle() {
    if (lastRoom) return;
    const N = (id, type, x, z, extra = {}) => ({ id, type, x, z, name: '', ...extra });
    update({
      code: 'title-vista', phase: 'lobby', players: [], turn: null,
      board: {
        domains: {}, regions: {}, edges: [],
        nodes: [
          N('pharos', 'pharos', -34, -46), N('home', 'home', 0, 0),
          N('t_shrine', 'shrine', 52, -30, { domain: 'clio', charges: 2 }),
          N('t_haven', 'haven', -58, 22), N('t_shop', 'shop', 34, 46),
          N('t_puzzle', 'puzzle', -16, 70), N('t_shrine2', 'shrine', 96, 34, { domain: 'athena', charges: 2 }),
          N('t_sea1', 'sea', 22, -62, { look: 'islet' }), N('t_sea2', 'sea', -78, -30, { look: 'rocks' }),
          N('t_sea3', 'sea', 74, 86, { look: 'islet' }), N('t_sea4', 'sea', -70, 84, { look: 'islet' }),
        ],
      },
    }, null);
  }

  const api = {
    update,
    showTitle,
    battlePlay,
    battleActive: () => battleOn,
    holdBattleStage: (v) => { battleHold = !!v; },
    arriving: () => arriving(lastRoom),
    animating: () => animatingPid(),
    crossing: () => (cross ? cross.phase : null),
    currentStage: () => (battleOn ? 'battle' : (activeBoardId || 'hub')),
    pauseRender: (v) => { renderPaused = !!v; },
    renderPaused: () => renderPaused,
    tourActive: () => !!tour,
    endTour,
    quality: () => pipe.quality,
    setQuality: (q) => pipe.setQuality(q),
  };

  /* debug handle for dev tooling / screenshot scripts */
  window.__thalassa = {
    scene: () => (battleOn ? battleStage.scene : stages[activeBoardId]?.scene),
    camera, controls, ships, stages,
    follow: () => viewFollowPid,
    reach: () => ({ key: reachKey, manual: reachManual }),   // after-roll framing state
    animating: () => animatingPid(),
    crossing: () => (cross ? { phase: cross.phase, to: cross.to, w: +(cross.w || 0).toFixed(2) } : null),
  };

  return api;
}

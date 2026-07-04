/*
 * monsters.js — Agent C (creatures)
 *
 * Loads the 32 Blender-baked GLBs, hands out per-instance clones, and drives
 * ALL creature animation procedurally on the named-part contract from
 * tools/make_monsters.py (body/head/jaw/legXX/armX/wingX/tail0..N/vine0..N/
 * weapon/shield/eye/core/wisp/crown...).
 *
 * CONTRACT NOTE / deviation: the shipped GLBs contain NO material literally
 * named 'PlayerTint' (the make_monsters.py docstring promises one but the
 * captain builder names its tintable cloth material 'cloth', baked neutral
 * grey #8a8a8a). retint() therefore recolors 'PlayerTint' materials when
 * present and otherwise falls back to the neutral 'cloth' material, so the
 * captain tints correctly today and any future PlayerTint export also works.
 *
 * Axis note: the exporter bakes Y-up into every node, so in three.js space
 * creatures face +X, up is +Y, flanks are ±Z. Limb fore-aft swings are
 * rotations about Z, wing flaps about X, tail wags about Y.
 *
 * animateMonster(group, t, mode):
 *   'idle' | 'walk' | 'cast' | 'charge'  → t is GLOBAL time (seconds)
 *   'attack' | 'hurt' | 'die'            → t is LOCAL time since the action
 *                                          started (attack ~0.9s, hurt ~0.5s,
 *                                          die ~1.2s then holds)
 * The animator only ever touches CHILDREN of the returned wrapper group —
 * callers own the wrapper's own position/rotation/scale entirely.
 */
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { flat, mulberry32, hashStr } from './util.js';

export const MONSTER_IDS = [
  'wolf', 'fox', 'jackal', 'boar', 'stag', 'jaguar', 'stalker', 'shambler',
  'harpy', 'bird', 'vulture', 'raider', 'faun', 'monkey', 'cyclops',
  'drowned', 'golem', 'siren', 'wraith', 'shade', 'serpent', 'drake',
  'briar', 'crab', 'scorpion', 'skiff', 'captain', 'stag_king', 'wyrm',
  'colossus', 'matriarch', 'warden', 'tyrant', 'kraken', 'sphinx',
  // Meshy realm re-tints — same beast, re-skinned for its home realm
  'wolf_frost', 'golem_tomb', 'golem_jade', 'bird_poison',
  'serpent_dust', 'serpent_bloom',
];

/* The Meshy-generated GLBs come out at arbitrary unit-ish sizes; the whole
 * game (battle sizing, map placement, camera framing) is tuned in WORLD
 * heights. Normalize every template to its species height at load. */
const HEIGHTS = {
  wolf: 1.5, fox: 0.95, jackal: 1.1, boar: 1.5, stag: 2.0, jaguar: 1.4,
  stalker: 1.7, shambler: 1.9, harpy: 1.7, bird: 1.0, vulture: 1.25,
  raider: 1.8, faun: 1.7, monkey: 1.1, cyclops: 2.6, drowned: 1.8,
  golem: 2.4, siren: 1.8, wraith: 1.8, shade: 1.8, serpent: 2.2, drake: 1.7,
  briar: 1.7, crab: 1.3, scorpion: 1.6, skiff: 2.2, captain: 1.8,
  stag_king: 3.4, wyrm: 3.6, colossus: 4.2, matriarch: 4.2, warden: 4.6,
  tyrant: 4.2, kraken: 4.4, sphinx: 3.6,
  wolf_frost: 1.5, golem_tomb: 2.4, golem_jade: 2.4, bird_poison: 1.0,
  serpent_dust: 2.2, serpent_bloom: 2.2,
};

export const BOSS_IDS = new Set(['stag_king', 'wyrm', 'colossus', 'matriarch',
  'warden', 'tyrant', 'sphinx', 'kraken']);
const FLOATERS = new Set(['wraith', 'shade', 'siren', 'warden',
  // fliers hover too — wings out, feet never on the ground
  'bird', 'bird_poison', 'vulture', 'harpy']);
const BOATS = new Set(['skiff']);

/* a few Meshy sculpts came out of the auto-rig facing ±Z instead of the
 * game's +X convention — square them up at template time */
const MODEL_YAW = { sphinx: Math.PI / 2, monkey: Math.PI / 2, harpy: Math.PI / 2 };

const loader = new GLTFLoader();
const templates = new Map();     // id → Promise<Group>  (never rejects)

/* ── loading ──────────────────────────────────────────────────────────────── */

function ensureTemplate(id) {
  let p = templates.get(id);
  if (p) return p;
  p = loader.loadAsync(`/static/assets/monsters/${id}.glb`)
    .then((gltf) => prepareTemplate(gltf.scene, id))
    .catch((err) => {
      console.warn(`monsters: failed to load '${id}', using fallback`, err);
      return prepareTemplate(buildFallback(id), id);
    });
  templates.set(id, p);
  return p;
}

export function preloadMonsters(ids) {
  return ids.map((id) => ensureTemplate(id));
}

/* Saturate/deepen the baked colors ~15% (they export a touch pale), flag
 * shadows, and measure height once on the shared template. */
const _hsl = { h: 0, s: 0, l: 0 };
const _PROXY_PARTS = new Set(['eye', 'core', 'crown']);
function prepareTemplate(scene, id) {
  const seen = new Set();
  const procedural = !!scene.userData.procedural;
  if (MODEL_YAW[id]) scene.rotation.y = MODEL_YAW[id];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    // the Meshy auto-rig drops heuristic glow proxies (eye/core/crown balls)
    // that frequently float off the sculpt — the baked textures carry the
    // look, so hide them. The procedural fallback keeps its placed eyes.
    if (!procedural && _PROXY_PARTS.has((o.name || '').replace(/\.\d+$/, ''))) {
      o.visible = false;
      return;
    }
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (!m.userData.saturated) {
        m.userData.saturated = true;
        m.color.getHSL(_hsl);
        m.color.setHSL(_hsl.h, Math.min(1, _hsl.s * 1.15), _hsl.l * 0.96);
      }
    }
  });
  const box = new THREE.Box3().setFromObject(scene);
  const rawH = Math.max(0.05, box.max.y - box.min.y);
  const target = HEIGHTS[id];
  if (target && Math.abs(rawH - target) > 0.05) {
    scene.scale.multiplyScalar(target / rawH);   // feet stay on y=0
  }
  scene.userData.height = target || Math.max(0.6, rawH);
  scene.userData.monsterId = id;
  return scene;
}

/* Never-break fallback: a dark spiky ico-sphere with glowing eyes, named so
 * the animator still has body/head/eye to chew on. */
function buildFallback(id) {
  const rng = mulberry32(hashStr(id || 'fallback'));
  const root = new THREE.Group();
  root.name = 'root';
  root.userData.procedural = true;   // its eyes are PLACED, keep them visible
  const body = new THREE.Group();
  body.name = 'body';
  body.position.y = 0.85;
  root.add(body);
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 1),
    flat(0x1c202b, { roughness: 0.85 }));
  core.name = 'skull';
  body.add(core);
  const spikeGeo = new THREE.ConeGeometry(0.11, 0.5, 5);
  const spikeMat = flat(0x2b3140, { roughness: 0.7 });
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Mesh(spikeGeo, spikeMat);
    const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 1.6 - 0.4, rng() * 2 - 1).normalize();
    s.position.copy(dir).multiplyScalar(0.58);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    s.name = 'spike';
    body.add(s);
  }
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0.42, 0.28, 0);
  body.add(head);
  const eyeGeo = new THREE.SphereGeometry(0.09, 6, 4);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x0c0c0c, emissive: 0xff4a2a, emissiveIntensity: 3, flatShading: true });
  for (const sz of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.name = 'eye';
    e.position.set(0.2, 0.05, 0.18 * sz);
    head.add(e);
  }
  return root;
}

/* ── instancing ───────────────────────────────────────────────────────────── */

const RX_SUFFIX = /\.\d+$/;
const baseName = (n) => n.replace(RX_SUFFIX, '');

export async function getMonster(id, { tint = null, scale = 1 } = {}) {
  const tpl = await ensureTemplate(id);
  const inner = tpl.clone(true);
  const wrapper = new THREE.Group();
  wrapper.name = `monster:${id}`;
  wrapper.add(inner);

  // per-instance material clones for anything we animate (emissive pulse)
  // or recolor (tint) — everything else keeps sharing the cached material.
  const ownedMats = [];
  const emissives = [];
  const tintables = [];
  const cloneMap = new Map();
  inner.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    let changed = false;
    const out = mats.map((m) => {
      if (!m) return m;
      const bn = baseName(m.name || '');
      const glows = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.001;
      const tintable = bn === 'PlayerTint' || bn === 'cloth';
      if (!glows && !tintable) return m;
      let c = cloneMap.get(m);
      if (!c) {
        c = m.clone();
        cloneMap.set(m, c);
        ownedMats.push(c);
        if (glows) {
          emissives.push({
            mat: c,
            baseI: c.emissiveIntensity,
            baseE: c.emissive.clone(),
          });
        }
        if (tintable) tintables.push(c);
      }
      changed = true;
      return c;
    });
    if (changed) o.material = Array.isArray(o.material) ? out : out[0];
  });

  const rig = buildRig(inner, id);
  rig.emissives = emissives;
  wrapper.userData = {
    monsterId: id,
    rig,
    ownedMats,
    tintables,
    phase: (hashStr(id) % 628) / 100 + Math.random() * 2,
    height: tpl.userData.height,
    float: FLOATERS.has(id),
    boat: BOATS.has(id),
  };
  if (tint) retint(wrapper, tint);
  if (scale !== 1) wrapper.scale.setScalar(scale);
  return wrapper;
}

export function retint(group, cssColor) {
  const c = new THREE.Color(cssColor);
  const tintables = group.userData && group.userData.tintables;
  const apply = (mats, want) => {
    let hit = false;
    for (const m of mats) {
      if (baseName(m.name || '') === want) { m.color.copy(c); hit = true; }
    }
    return hit;
  };
  if (tintables && tintables.length) {
    if (!apply(tintables, 'PlayerTint')) apply(tintables, 'cloth');
    return;
  }
  // group wasn't made by getMonster — best-effort traverse
  const found = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m) found.push(m);
  });
  if (!apply(found, 'PlayerTint')) apply(found, 'cloth');
}

/* ── rig discovery ────────────────────────────────────────────────────────── */

function snap(node) {
  return {
    node,
    p: node.position.clone(),
    r: node.rotation.clone(),
    s: node.scale.clone(),
  };
}

function buildRig(inner, id) {
  const rig = {
    inner: snap(inner),
    body: null, head: null, jaw: null, weapon: null, shield: null,
    crown: null, bloom: null, stinger: null, tailtip: null, sail: null,
    legFL: null, legFR: null, legBL: null, legBR: null,
    armL: null, armR: null, legL: null, legR: null,
    wingL: null, wingR: null, clawL: null, clawR: null,
    tails: [], vines: [], wisps: [], bugLegs: [], tatters: [], weeds: [],
    all: [],       // every snapped part, for the per-frame reset
    emissives: [],
  };
  const grab = (sn) => { rig.all.push(sn); return sn; };
  inner.traverse((o) => {
    if (o === inner) return;
    const n = baseName(o.name || '');
    let m;
    if (n === 'body' || n === 'head' || n === 'jaw' || n === 'weapon' ||
        n === 'shield' || n === 'crown' || n === 'bloom' || n === 'stinger' ||
        n === 'tailtip' || n === 'sailm' ||
        n === 'legFL' || n === 'legFR' || n === 'legBL' || n === 'legBR' ||
        n === 'armL' || n === 'armR' || n === 'legL' || n === 'legR' ||
        n === 'wingL' || n === 'wingR' || n === 'clawL' || n === 'clawR') {
      const key = n === 'sailm' ? 'sail' : n;
      if (!rig[key]) rig[key] = grab(snap(o));
    } else if ((m = n.match(/^tail(\d+)$/))) {
      rig.tails[+m[1]] = grab(snap(o));
    } else if ((m = n.match(/^vine(\d+)$/))) {
      rig.vines[+m[1]] = grab(snap(o));
    } else if (n === 'wisp') {
      rig.wisps.push(grab(snap(o)));
    } else if (n === 'tatter') {
      rig.tatters.push(grab(snap(o)));
    } else if (n === 'weed') {
      rig.weeds.push(grab(snap(o)));
    } else if ((m = n.match(/^leg(\d+)([LR])$/))) {
      rig.bugLegs.push(Object.assign(grab(snap(o)), { i: +m[1], side: m[2] === 'L' ? 1 : -1 }));
    }
  });
  rig.tails = rig.tails.filter(Boolean);
  rig.vines = rig.vines.filter(Boolean);
  rig.quadruped = !!(rig.legFL && rig.legFR && rig.legBL && rig.legBR);
  rig.biped = !!(rig.legL && rig.legR);
  rig.slither = rig.tails.length >= 4;   // serpents: positional coil segments
  return rig;
}

function resetRig(rig) {
  for (const sn of rig.all) {
    sn.node.position.copy(sn.p);
    sn.node.rotation.copy(sn.r);
    sn.node.scale.copy(sn.s);
  }
  const inn = rig.inner;
  inn.node.position.copy(inn.p);
  inn.node.rotation.copy(inn.r);
  inn.node.scale.copy(inn.s);
  for (const e of rig.emissives) {
    e.mat.emissiveIntensity = e.baseI;
    e.mat.emissive.copy(e.baseE);
  }
}

/* ── the animator ─────────────────────────────────────────────────────────── */

const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeIn = (k) => k * k;
const clamp01 = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);
const _red = new THREE.Color(0xff3524);

export function animateMonster(group, t, mode) {
  const u = group.userData;
  if (!u || !u.rig) return;
  const rig = u.rig;
  const ph = u.phase;
  resetRig(rig);
  switch (mode) {
    case 'walk': poseLocomotion(rig, u, t, ph, true); break;
    case 'attack': poseAttack(rig, u, t, ph); break;
    case 'hurt': poseHurt(rig, u, t, ph); break;
    case 'die': poseDie(rig, u, t, ph); break;
    case 'cast': poseLocomotion(rig, u, t, ph, false); poseCast(rig, u, t, ph, false); break;
    case 'charge': poseLocomotion(rig, u, t, ph, false); poseCast(rig, u, t, ph, true); break;
    default: poseLocomotion(rig, u, t, ph, false); break;
  }
}

/* shared idle/walk body language */
function poseLocomotion(rig, u, t, ph, walking) {
  const body = rig.body;
  const w = t * (walking ? 7.5 : 2.1) + ph;

  if (body) {
    // breath: gentle vertical swell
    body.node.scale.y = body.s.y * (1 + Math.sin(t * 2.3 + ph) * 0.025);
    if (walking) {
      body.node.position.y = body.p.y + Math.abs(Math.sin(w)) * 0.07;
      body.node.rotation.z = body.r.z + Math.sin(w * 2) * 0.02;
    }
    if (u.float) {
      // wraith hover: bob high, slow figure-eight sway, no footwork
      body.node.position.y = body.p.y + 0.3 + Math.sin(t * 1.7 + ph) * 0.17;
      body.node.rotation.x = body.r.x + Math.sin(t * 0.9 + ph) * 0.07;
      body.node.rotation.z = body.r.z + Math.cos(t * 0.7 + ph) * 0.06;
    }
    if (u.boat) {
      body.node.position.y = body.p.y + Math.sin(t * 1.6 + ph) * 0.08;
      body.node.rotation.x = body.r.x + Math.sin(t * 1.1 + ph) * 0.05;
      body.node.rotation.z = body.r.z + Math.sin(t * 1.4 + ph + 2) * 0.04;
    }
  }

  if (rig.head) {
    const h = rig.head;
    h.node.rotation.y = h.r.y + Math.sin(t * 0.55 + ph) * 0.14;
    h.node.rotation.z = h.r.z + Math.sin(t * 0.8 + ph + 1.7) * 0.05
      + (walking ? Math.sin(w * 2) * 0.03 : 0);
  }

  // quadruped gait: diagonal pairs (FL+BR vs FR+BL)
  if (rig.quadruped) {
    const amp = walking ? 0.55 : 0.03;
    const a = Math.sin(w) * amp;
    rig.legFL.node.rotation.z = rig.legFL.r.z + a;
    rig.legBR.node.rotation.z = rig.legBR.r.z + a;
    rig.legFR.node.rotation.z = rig.legFR.r.z - a;
    rig.legBL.node.rotation.z = rig.legBL.r.z - a;
  }

  // biped gait + arm counterswing
  if (rig.biped) {
    const amp = walking ? 0.5 : 0.02;
    const a = Math.sin(w) * amp;
    rig.legL.node.rotation.z = rig.legL.r.z + a;
    rig.legR.node.rotation.z = rig.legR.r.z - a;
    if (rig.armL) rig.armL.node.rotation.z = rig.armL.r.z - a * 0.7 + (walking ? 0 : Math.sin(t * 1.9 + ph) * 0.05);
    if (rig.armR) rig.armR.node.rotation.z = rig.armR.r.z + a * 0.7 + (walking ? 0 : Math.sin(t * 1.9 + ph + 2) * 0.05);
  } else if (u.float) {
    // wraith arms drift like kelp
    if (rig.armL) rig.armL.node.rotation.x = rig.armL.r.x + Math.sin(t * 1.3 + ph) * 0.18;
    if (rig.armR) rig.armR.node.rotation.x = rig.armR.r.x - Math.sin(t * 1.3 + ph + 1.1) * 0.18;
  }

  // wings: soft idle flap, hard travel flap
  if (rig.wingL && rig.wingR) {
    const f = walking ? Math.sin(t * 9 + ph) * 0.55
                      : 0.1 + Math.sin(t * 2.6 + ph) * 0.16;
    rig.wingL.node.rotation.x = rig.wingL.r.x + f;
    rig.wingR.node.rotation.x = rig.wingR.r.x - f;
    if (rig.body && walking) {
      rig.body.node.position.y = rig.body.p.y + 0.2 + Math.sin(t * 9 + ph - 1.2) * 0.12;
    }
  }

  // tails: short tails wag, long serpent coils slither positionally
  if (rig.slither) {
    const n = rig.tails.length;
    for (let i = 0; i < n; i++) {
      const seg = rig.tails[i];
      const k = i / n;
      seg.node.position.z = seg.p.z + Math.sin(t * 2.4 + ph + i * 0.85) * 0.16 * (0.25 + k);
      seg.node.position.y = seg.p.y + Math.sin(t * 3.1 + ph + i * 1.2) * 0.05 * k;
    }
    if (rig.tailtip) {
      rig.tailtip.node.position.z = rig.tailtip.p.z + Math.sin(t * 2.4 + ph + n * 0.85) * 0.22;
    }
  } else {
    for (let i = 0; i < rig.tails.length; i++) {
      const seg = rig.tails[i];
      seg.node.rotation.y = seg.r.y + Math.sin(t * (walking ? 6 : 2.2) + ph + i * 0.7) * 0.28;
    }
    if (rig.stinger) {
      rig.stinger.node.rotation.z = rig.stinger.r.z + Math.sin(t * 2.0 + ph) * 0.1;
    }
  }

  // plant-horror vines writhe with phase offsets
  for (let i = 0; i < rig.vines.length; i++) {
    const v = rig.vines[i];
    v.node.rotation.y = v.r.y + Math.sin(t * 1.6 + ph + i * 1.9) * 0.22;
    v.node.rotation.x = v.r.x + Math.sin(t * 1.1 + ph + i * 2.6) * 0.14;
  }
  if (rig.bloom) {
    rig.bloom.node.rotation.y = rig.bloom.r.y + t * 0.25;
  }

  // arthropod scuttle
  if (rig.bugLegs.length) {
    const amp = walking ? 0.3 : 0.04;
    for (const l of rig.bugLegs) {
      const a = Math.sin(w * 1.35 + l.i * 2.1 + (l.side > 0 ? 0 : Math.PI)) * amp;
      l.node.rotation.x = l.r.x + a * l.side * 0.6;
      l.node.rotation.y = l.r.y + a;
    }
  }
  if (rig.clawL) rig.clawL.node.rotation.y = rig.clawL.r.y + Math.sin(t * 1.7 + ph) * 0.1;
  if (rig.clawR) rig.clawR.node.rotation.y = rig.clawR.r.y - Math.sin(t * 1.7 + ph + 0.8) * 0.1;

  // spectral wisps orbit their anchors
  for (let i = 0; i < rig.wisps.length; i++) {
    const wp = rig.wisps[i];
    wp.node.position.x = wp.p.x + Math.sin(t * 1.4 + i * 2.1 + ph) * 0.16;
    wp.node.position.z = wp.p.z + Math.cos(t * 1.4 + i * 2.1 + ph) * 0.16;
    wp.node.position.y = wp.p.y + Math.sin(t * 2.2 + i * 1.3 + ph) * 0.12;
  }
  for (let i = 0; i < rig.tatters.length; i++) {
    const tt = rig.tatters[i];
    tt.node.rotation.x = tt.r.x + Math.sin(t * 3.1 + i * 1.4 + ph) * 0.12;
  }
  for (let i = 0; i < rig.weeds.length; i++) {
    const wd = rig.weeds[i];
    wd.node.rotation.z = wd.r.z + Math.sin(t * 2.2 + i * 1.7 + ph) * 0.09;
  }
  if (rig.sail) {
    rig.sail.node.rotation.y = rig.sail.r.y + Math.sin(t * 1.2 + ph) * 0.05;
  }
}

/* attack: coiled windup → jaw-snapping lunge → recover.  t is LOCAL. */
function poseAttack(rig, u, t, ph) {
  const DUR = 0.9;
  const k = clamp01(t / DUR);
  // motion curve: -0.35 windup until 0.32, whipcrack to +1 at 0.5, ease home
  let drive;
  if (k < 0.32) drive = -easeOut(k / 0.32) * 0.38;
  else if (k < 0.52) drive = -0.38 + easeIn((k - 0.32) / 0.2) * 1.38;
  else drive = 1 - easeOut((k - 0.52) / 0.48);
  const body = rig.body;
  if (body) {
    body.node.position.x = body.p.x + drive * 0.55;
    body.node.rotation.z = body.r.z + (drive < 0 ? -drive * 0.35 : -drive * 0.12);
    if (u.float) body.node.position.y = body.p.y + 0.3 - Math.max(0, drive) * 0.15;
  }
  if (rig.head) {
    rig.head.node.rotation.z = rig.head.r.z - Math.max(0, drive) * 0.25
      + Math.min(0, drive) * 0.4;
  }
  // jaw snaps: gapes through the windup+lunge, clacks shut at contact
  if (rig.jaw) {
    const open = k < 0.5 ? easeOut(clamp01(k / 0.32)) : Math.max(0, 1 - (k - 0.5) / 0.12);
    rig.jaw.node.rotation.z = rig.jaw.r.z - open * 0.55;
  }
  // weapon arm hews down through the strike
  if (rig.weapon) {
    const swing = k < 0.32 ? -easeOut(k / 0.32) * 0.7
      : k < 0.55 ? -0.7 + easeIn((k - 0.32) / 0.23) * 1.6
      : 0.9 - easeOut((k - 0.55) / 0.45) * 0.9;
    rig.weapon.node.rotation.z = rig.weapon.r.z + swing;
  }
  if (rig.armR) rig.armR.node.rotation.z = rig.armR.r.z + drive * 0.9;
  if (rig.armL) rig.armL.node.rotation.z = rig.armL.r.z - drive * 0.35;
  if (rig.clawL) rig.clawL.node.rotation.y = rig.clawL.r.y + Math.max(0, drive) * 0.7;
  if (rig.clawR) rig.clawR.node.rotation.y = rig.clawR.r.y - Math.max(0, drive) * 0.7;
  if (rig.stinger) rig.stinger.node.rotation.z = rig.stinger.r.z - Math.max(0, drive) * 0.8;
  for (let i = 0; i < rig.vines.length; i++) {
    const v = rig.vines[i];
    v.node.rotation.y = v.r.y + drive * 0.5 * (i % 2 ? 1 : -1);
    v.node.rotation.x = v.r.x - Math.max(0, drive) * 0.3;
  }
  if (rig.wingL && rig.wingR) {
    const f = Math.sin(t * 22 + ph) * 0.5 * (1 - k * 0.5);
    rig.wingL.node.rotation.x = rig.wingL.r.x + f - Math.max(0, drive) * 0.4;
    rig.wingR.node.rotation.x = rig.wingR.r.x - f + Math.max(0, drive) * 0.4;
  }
  // emissives spike at the moment of contact
  const glow = 1 + Math.max(0, drive) * 1.6;
  for (const e of rig.emissives) e.mat.emissiveIntensity = e.baseI * glow;
}

/* flinch: sharp recoil + decaying shudder.  t is LOCAL. */
function poseHurt(rig, u, t, ph) {
  const DUR = 0.5;
  const k = clamp01(t / DUR);
  const decay = 1 - k;
  const shudder = Math.sin(k * Math.PI * 4 + ph) * decay;
  const body = rig.body;
  if (body) {
    body.node.position.x = body.p.x - easeOut(Math.min(1, k * 3)) * decay * 0.3;
    body.node.rotation.x = body.r.x + shudder * 0.14;
    body.node.rotation.z = body.r.z + decay * 0.12;
    if (u.float) body.node.position.y = body.p.y + 0.3 - decay * 0.1;
  }
  if (rig.head) {
    rig.head.node.rotation.z = rig.head.r.z + decay * 0.3;
    rig.head.node.rotation.y = rig.head.r.y + shudder * 0.2;
  }
  if (rig.jaw) rig.jaw.node.rotation.z = rig.jaw.r.z - decay * 0.3;
  for (const e of rig.emissives) e.mat.emissiveIntensity = e.baseI * (1 + decay * 1.2);
}

/* death: crumple, shrink, sink.  t is LOCAL; pose holds at t>=1.2s. */
function poseDie(rig, u, t) {
  const k = easeIn(clamp01(t / 1.2));
  const inn = rig.inner;
  const s = Math.max(0.04, 1 - k * 0.92);
  inn.node.scale.set(inn.s.x * s, inn.s.y * s, inn.s.z * s);
  inn.node.position.y = inn.p.y - k * u.height * 0.55;
  inn.node.rotation.z = inn.r.z + k * 0.5;
  inn.node.rotation.x = inn.r.x + k * 0.25;
  if (rig.jaw) rig.jaw.node.rotation.z = rig.jaw.r.z - clamp01(t / 0.25) * 0.4;
  for (const e of rig.emissives) e.mat.emissiveIntensity = e.baseI * Math.max(0, 1 - k * 1.4);
}

/* cast / charge: emissive pulse; charge also rears up, burning red. */
function poseCast(rig, u, t, ph, heavy) {
  const rate = heavy ? 12 : 8;
  const pulse = heavy ? 1.9 + Math.sin(t * rate + ph) * 1.4
                      : 1.5 + Math.sin(t * rate + ph) * 0.9;
  for (const e of rig.emissives) {
    e.mat.emissiveIntensity = e.baseI * pulse;
    if (heavy) e.mat.emissive.lerpColors(e.baseE, _red, 0.55 + Math.sin(t * rate + ph) * 0.25);
  }
  const body = rig.body;
  if (heavy && body) {
    // rear up, front lifted, trembling with held power
    body.node.rotation.z = body.r.z + 0.2 + Math.sin(t * 7 + ph) * 0.03;
    body.node.position.y = body.p.y + (u.float ? 0.42 : 0.14);
    if (rig.legFL) rig.legFL.node.rotation.z = rig.legFL.r.z + 0.55;
    if (rig.legFR) rig.legFR.node.rotation.z = rig.legFR.r.z + 0.45;
    if (rig.head) rig.head.node.rotation.z = rig.head.r.z + 0.18;
    if (rig.jaw) rig.jaw.node.rotation.z = rig.jaw.r.z - 0.35;
  }
  if (!heavy && rig.armL && rig.armR) {
    // arms raised in incantation
    rig.armL.node.rotation.z = rig.armL.r.z - 0.6 + Math.sin(t * 3 + ph) * 0.08;
    rig.armR.node.rotation.z = rig.armR.r.z - 0.6 + Math.sin(t * 3 + ph + 1) * 0.08;
  }
  if (rig.weapon && heavy) {
    rig.weapon.node.rotation.z = rig.weapon.r.z - 0.5;
  }
  for (let i = 0; i < rig.vines.length; i++) {
    const v = rig.vines[i];
    v.node.rotation.x = v.r.x - (heavy ? 0.4 : 0.2) + Math.sin(t * 5 + i * 1.9) * 0.1;
  }
}

/* Dispose the per-instance materials getMonster created (geometry stays —
 * it is shared with the cached template). battle.js calls this on exit. */
export function disposeMonster(group) {
  const u = group.userData;
  if (u && u.ownedMats) {
    for (const m of u.ownedMats) m.dispose();
    u.ownedMats.length = 0;
  }
}

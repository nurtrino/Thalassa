/*
 * battle.js — Agent C (the battle diorama)
 *
 * A separate cinematic scene scene.js renders while room.battle exists.
 * Over-the-shoulder camera with slow sway, themed backdrop from islands.js,
 * key/rim stage lighting, the hero (galley at anchor or the tinted captain
 * on foot), enemies ranked and scaled by max_hp, floating canvas damage
 * numbers, and every beat from the contract list.
 *
 * Cross-module calls (per FRONTEND-CONTRACTS.md): islands.makeBattleBackdrop,
 * islands.makeShip, monsters.getMonster/animateMonster, util.softDiscTexture.
 */
import * as THREE from 'three';
import { makeShip, makeBattleBackdrop } from './islands.js';
import { getMonster, animateMonster, preloadMonsters, disposeMonster, BOSS_IDS }
  from './monsters.js';
import { softDiscTexture, flat } from './util.js';

/* module-scope temps — zero per-frame allocation */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _col = new THREE.Color();

const HERO_HOME = new THREE.Vector3(-9, 0, 0);
const GOLD = 0xffd76a;
const ARCANE = 0x9a7bff;
const BACKFIRE = 0xc44dff;
const HURT_RED = 0xff6a52;

const clamp01 = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeIn = (k) => k * k;
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));

/* ── little scene pieces ──────────────────────────────────────────────────── */

/* gradient sky dome, vertex-colored so one draw call sells the mood */
function makeDome() {
  const geo = new THREE.SphereGeometry(170, 24, 12);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  return mesh;
}

function tintDome(dome, sky) {
  const pos = dome.geometry.attributes.position;
  const col = dome.geometry.attributes.color;
  const zen = _col.set(sky.zenith).clone();
  const mid = new THREE.Color(sky.mid);
  const hor = new THREE.Color(sky.horizon);
  for (let i = 0; i < pos.count; i++) {
    const k = clamp01(pos.getY(i) / 170 * 0.5 + 0.5);   // 0 nadir → 1 zenith
    let c;
    if (k > 0.55) c = _col.lerpColors(mid, zen, (k - 0.55) / 0.45);
    else c = _col.lerpColors(hor, mid, clamp01((k - 0.35) / 0.2));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

/* emergency backdrop if islands.js throws — plain themed disc + rocks */
function fallbackBackdrop(theme) {
  const g = new THREE.Group();
  const groundCol = theme.ground === 'sand'
    ? theme.palette.sand : theme.water.shallow;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(46, 40),
    flat(groundCol, { roughness: 1 }));
  disc.rotation.x = -Math.PI / 2;
  disc.receiveShadow = true;
  g.add(disc);
  const rockMat = flat(theme.palette.rock);
  for (let i = 0; i < 5; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(2 + (i % 3), 0), rockMat);
    const a = -0.6 + i * 0.85;
    r.position.set(Math.cos(a) * 34, 0.5, Math.sin(a) * 34);
    g.add(r);
  }
  return g;
}

function disposeDeep(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m.map && m.map !== softDiscTexture()) m.map.dispose();
      m.dispose();
    }
  });
}

/* ── damage numbers: pooled canvas sprites ───────────────────────────────── */

function makeDmgPool(scene, n = 10) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: 0 });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    spr.renderOrder = 50;
    scene.add(spr);
    pool.push({ spr, ctx, tex, active: false, t0: 0, dur: 1.1, x: 0, y: 0, z: 0, big: false });
  }
  return pool;
}

function spawnDmg(pool, t, text, x, y, z, cssColor, big) {
  let d = pool.find((e) => !e.active);
  if (!d) { d = pool[0]; }                       // steal the oldest slot
  const ctx = d.ctx;
  ctx.clearRect(0, 0, 256, 128);
  ctx.font = `900 ${big ? 96 : 78}px Alegreya, Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(10,12,18,0.9)';
  ctx.lineWidth = 12;
  ctx.strokeText(text, 128, 68);
  ctx.fillStyle = cssColor;
  ctx.fillText(text, 128, 68);
  d.tex.needsUpdate = true;
  d.active = true; d.t0 = t; d.big = !!big;
  d.x = x; d.y = y; d.z = z;
  d.spr.visible = true;
  return d;
}

function updateDmg(pool, t) {
  for (const d of pool) {
    if (!d.active) continue;
    const k = (t - d.t0) / d.dur;
    if (k >= 1) { d.active = false; d.spr.visible = false; continue; }
    const pop = k < 0.12 ? easeOut(k / 0.12) : 1;
    const s = (d.big ? 3.6 : 2.5) * (0.6 + 0.4 * pop) * (1 + k * 0.15);
    d.spr.scale.set(s, s * 0.5, 1);
    d.spr.position.set(d.x, d.y + easeOut(k) * 2.3, d.z);
    d.spr.material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
  }
}

/* ── impact flashes: pooled additive glow sprites ────────────────────────── */

function makeFlashPool(scene, n = 14) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    const mat = new THREE.SpriteMaterial({
      map: softDiscTexture(), color: 0xffffff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    spr.renderOrder = 40;
    scene.add(spr);
    pool.push({ spr, active: false, t0: 0, dur: 0.35, size: 2, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
  }
  return pool;
}

function spawnFlash(pool, t, x, y, z, color, size, dur = 0.35, vx = 0, vy = 0, vz = 0) {
  let f = pool.find((e) => !e.active) || pool[0];
  f.active = true; f.t0 = t; f.dur = dur; f.size = size;
  f.x = x; f.y = y; f.z = z; f.vx = vx; f.vy = vy; f.vz = vz;
  f.spr.material.color.set(color);
  f.spr.visible = true;
  return f;
}

function updateFlash(pool, t) {
  for (const f of pool) {
    if (!f.active) continue;
    const k = (t - f.t0) / f.dur;
    if (k >= 1) { f.active = false; f.spr.visible = false; continue; }
    const dt2 = t - f.t0;
    f.spr.position.set(f.x + f.vx * dt2, f.y + f.vy * dt2, f.z + f.vz * dt2);
    const s = f.size * (0.5 + easeOut(k) * 0.9);
    f.spr.scale.set(s, s, 1);
    f.spr.material.opacity = (1 - k) * 0.95;
  }
}

/* ── enemy sizing / arrangement ──────────────────────────────────────────── */

// per-model tweaks to the raw-bounds scale. monsters.js now normalizes every
// template to its species height at load, so this sits empty — kept as the
// knob for one-off framing fixes.
const MODEL_SCALE = {};

function sizeFor(e) {
  const model = e.model || e.name || '';
  if (BOSS_IDS.has(model) || (e.max_hp || 0) >= 12) return 2.2 * (MODEL_SCALE[model] || 1);
  if ((e.max_hp || 0) >= 6) return 1.8;
  // grunts read on stage: a battle miniature, not a speck by the hull
  return 1.45 + clamp01(((e.max_hp || 3) - 1) / 8) * 0.35;
}

/* deterministic ranks; bosses centered & at the back, minions screen it */
function computeLayout(scales) {
  const n = scales.length;
  const out = [];
  const bossIdx = scales.findIndex((s) => s >= 2);
  if (bossIdx >= 0) {
    const flankZ = [-5.2, 5.2, -8.8, 8.8, -2.4, 2.4];
    let f = 0;
    for (let i = 0; i < n; i++) {
      if (i === bossIdx) out.push({ x: 11.2, z: 0 });
      else out.push({ x: 6.0 + (f % 2) * 1.2, z: flankZ[f++ % flankZ.length] });
    }
  } else if (n <= 3) {
    for (let i = 0; i < n; i++) {
      out.push({ x: 7.4 + Math.abs(i - (n - 1) / 2) * 0.8, z: (i - (n - 1) / 2) * 4.6 });
    }
  } else {
    const front = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const inFront = i < front;
      const rank = inFront ? i : i - front;
      const count = inFront ? front : n - front;
      out.push({
        x: inFront ? 6.4 : 10.2,
        z: (rank - (count - 1) / 2) * 4.6 + (inFront ? 0 : 2.3),
      });
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════ */

export function createBattleStage(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.1, 420);
  camera.position.set(-17, 5, 7);

  /* lighting rig (persistent; retinted per theme) */
  const key = new THREE.DirectionalLight(0xfff1d6, 1.6);
  key.position.set(-14, 20, 13);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -20; key.shadow.camera.right = 22;
  key.shadow.camera.top = 20; key.shadow.camera.bottom = -14;
  key.shadow.camera.near = 4; key.shadow.camera.far = 70;
  key.shadow.bias = -0.0015;
  key.target.position.set(2, 0, 0);
  const rim = new THREE.DirectionalLight(0x9fc8ff, 0.9);
  rim.position.set(17, 9, -15);
  const hemi = new THREE.HemisphereLight(0xd6ecff, 0x3e5a4a, 0.5);
  const amb = new THREE.AmbientLight(0x28394a, 0.55);
  const heroLamp = new THREE.PointLight(0xffca7a, 0.65, 18, 2);
  heroLamp.position.set(-9, 4, 3);
  const flashLight = new THREE.PointLight(0xffffff, 0, 26, 2);
  const chargeLight = new THREE.PointLight(0xff3524, 0, 30, 2);
  scene.add(key, key.target, rim, hemi, amb, heroLamp, flashLight, chargeLight);

  const dome = makeDome();
  scene.add(dome);

  /* target pulse ring */
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.15, 1.5, 40),
    new THREE.MeshBasicMaterial({
      color: GOLD, transparent: true, opacity: 0.7, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.visible = false;
  scene.add(ring);

  /* guard shield: gold disc + glow that flares in front of the hero */
  const shield = new THREE.Group();
  const shieldDisc = new THREE.Mesh(
    new THREE.CircleGeometry(2.3, 36),
    new THREE.MeshBasicMaterial({
      color: GOLD, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  shieldDisc.rotation.y = Math.PI / 2;
  const shieldGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: GOLD, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  shieldGlow.scale.set(7, 7, 1);
  shield.add(shieldDisc, shieldGlow);
  shield.position.set(-5.6, 1.9, 0);
  shield.visible = false;
  scene.add(shield);

  /* charge telegraph aura */
  const aura = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: 0xff3524, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  aura.visible = false;
  aura.renderOrder = 30;
  scene.add(aura);

  /* one magic bolt + trail */
  const bolt = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: ARCANE, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  bolt.scale.set(1.6, 1.6, 1);
  bolt.visible = false;
  bolt.renderOrder = 45;
  const trail = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Sprite(bolt.material.clone());
    s.scale.set(1.1 - i * 0.2, 1.1 - i * 0.2, 1);
    s.visible = false;
    s.renderOrder = 44;
    scene.add(s);
    trail.push(s);
  }
  scene.add(bolt);

  const dmgPool = makeDmgPool(scene);
  const flashPool = makeFlashPool(scene);

  /* ── mutable battle state ─────────────────────────────────────────────── */
  const st = {
    active: false,
    t: 0,
    theme: null,
    backdrop: null,
    hero: {
      kind: 'ship', group: null, mon: null, holder: null,
      hurtT0: -9, atkT0: -9, ox: 0, oy: 0, oz: 0, rx: 0, ry: 0, rz: 0,
    },
    slots: [],
    beats: [],
    boltAnim: null,       // {from,ctrl,to,t0,dur,color,onHit}
    shieldT0: -9,
    targetIdx: null,
    chargeIdx: null,
    shake: 0,
    kick: 0,
    swayPh: Math.random() * 6,
    victory: false,
    victoryT0: 0,
    defeat: false,
    defeatT0: 0,
    dim: 0,               // defeat light dimmer 0..1
    camBase: new THREE.Vector3(-17, 5, 7),
    camGoal: new THREE.Vector3(-17, 5, 7),
    camLook: new THREE.Vector3(0.5, 2.0, -0.3),
    camLookGoal: new THREE.Vector3(0.5, 2.0, -0.3),
    baseKey: 1.6, baseRim: 0.9, baseHemi: 0.5, baseAmb: 0.55,
  };

  /* ── scene teardown ───────────────────────────────────────────────────── */
  function clearActors() {
    if (st.backdrop) {
      scene.remove(st.backdrop);
      disposeDeep(st.backdrop);
      st.backdrop = null;
    }
    const h = st.hero;
    if (h.holder) {
      scene.remove(h.holder);
      if (h.kind === 'ship' && h.group) disposeDeep(h.group);
      if (h.mon) disposeMonster(h.mon);
      h.holder = null; h.group = null; h.mon = null;
    }
    for (const s of st.slots) {
      scene.remove(s.holder);
      if (s.mon) disposeMonster(s.mon);
    }
    st.slots.length = 0;
    st.beats.length = 0;
    st.boltAnim = null;
    bolt.visible = false;
    for (const tr of trail) tr.visible = false;
    ring.visible = false;
    aura.visible = false;
    shield.visible = false;
    chargeLight.intensity = 0;
    flashLight.intensity = 0;
    for (const d of dmgPool) { d.active = false; d.spr.visible = false; }
    for (const f of flashPool) { f.active = false; f.spr.visible = false; }
  }

  /* camera framing from the tallest thing on stage */
  function reframe() {
    let maxH = 2.6;
    for (const s of st.slots) {
      const h = (s.mon ? s.mon.userData.height : 1.8) * s.scl;
      if (!s.dead && h > maxH) maxH = h;
    }
    const f = clamp01((maxH - 2.6) / 8);          // 0 grunts → 1 colossus
    st.camGoal.set(-17 - f * 7.5, 4.6 + f * 4.2, 7 + f * 3.4);
    st.camLookGoal.set(0.5 + f * 2.4, 1.9 + f * 2.2, -0.3);
  }

  /* ── enter / exit ─────────────────────────────────────────────────────── */
  function enter({ battle, room, you, theme, heroColor, heroKind }) {
    clearActors();
    st.active = true;
    st.theme = theme;
    st.victory = false;
    st.defeat = false;
    st.dim = 0;
    st.shake = 0;
    st.kick = 0;
    st.targetIdx = null;
    st.chargeIdx = null;
    st.hero.hurtT0 = -9;
    st.hero.atkT0 = -9;

    /* mood */
    tintDome(dome, theme.sky);
    scene.fog = new THREE.Fog(theme.fog.color, 55, 195);
    scene.background = null;
    key.color.set(theme.sun.color);
    key.intensity = st.baseKey = Math.min(2.2, theme.sun.intensity * 1.05);
    rim.color.set(theme.id === 'ice' ? 0xbfe8ff
      : theme.id === 'desert' ? 0xffd9a0
      : theme.id === 'jungle' ? 0x8fffc9
      : theme.id === 'autumn' ? 0xffb066 : 0x9fc8ff);
    rim.intensity = st.baseRim = 1.0;
    hemi.color.set(theme.hemi.sky);
    hemi.groundColor.set(theme.hemi.ground);
    hemi.intensity = st.baseHemi = theme.hemi.intensity * 0.7;
    amb.color.set(theme.ambient);
    amb.intensity = st.baseAmb = 0.55;

    /* backdrop */
    let bd;
    try { bd = makeBattleBackdrop(theme); }
    catch (err) { console.warn('battle: backdrop failed, using fallback', err); bd = fallbackBackdrop(theme); }
    bd.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
    st.backdrop = bd;
    scene.add(bd);

    /* hero */
    const h = st.hero;
    h.kind = heroKind === 'captain' ? 'captain' : 'ship';
    h.holder = new THREE.Group();
    h.holder.position.copy(HERO_HOME);
    h.holder.rotation.y = -0.12;
    scene.add(h.holder);
    if (h.kind === 'ship') {
      const ship = makeShip(heroColor || '#e4572e');
      ship.scale.setScalar(1.7);
      // float the hull ON the diorama water (disc sits at y≈-0.08) instead
      // of letting the keel sink through it
      ship.position.y = 0.92;
      ship.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      h.group = ship;
      h.holder.add(ship);
    } else {
      getMonster('captain', { tint: heroColor || '#e4572e', scale: 1.55 })
        .then((mon) => {
          if (!st.active || st.hero.holder !== h.holder) { disposeMonster(mon); return; }
          h.mon = mon;
          h.holder.add(mon);
        });
    }

    /* enemies — index-aligned with battle.enemies for beats/targeting */
    const enemies = (battle && battle.enemies) || [];
    preloadMonsters(enemies.map((e) => e.model || e.name || 'wolf'));
    const scales = enemies.map(sizeFor);
    const layout = computeLayout(scales);
    enemies.forEach((e, i) => {
      const id = e.model || e.name || 'wolf';
      const holder = new THREE.Group();
      holder.position.set(layout[i].x, 0, layout[i].z);
      holder.rotation.y = Math.PI + (i % 2 ? 0.07 : -0.07);
      holder.scale.setScalar(scales[i]);
      scene.add(holder);
      const slot = {
        holder, mon: null, id, scl: scales[i], boss: scales[i] >= 2,
        home: holder.position.clone(),
        dead: (e.hp || 0) <= 0, deadT0: st.t - 5,
        hurtT0: -9, atkT0: -9, lunge: null, castMode: null,
        ox: 0, oy: 0, oz: 0, rz: 0,
        phase: Math.random() * 6,
      };
      st.slots.push(slot);
      getMonster(id).then((mon) => {
        if (!st.active || st.slots[i] !== slot) { disposeMonster(mon); return; }
        slot.mon = mon;
        holder.add(mon);
        reframe();
      });
    });

    /* boss already winding up when we walk in (reconnect mid-fight) */
    if (battle && battle.charging) telegraph();

    reframe();
    st.camBase.copy(st.camGoal);
    st.camLook.copy(st.camLookGoal);
    camera.position.copy(st.camBase);
    camera.lookAt(st.camLook);
  }

  function exit() {
    st.active = false;
    clearActors();
  }

  /* ── beat helpers ─────────────────────────────────────────────────────── */

  function frontAttacker(preferBoss) {
    let pick = null;
    for (const s of st.slots) {
      if (s.dead) continue;
      if (s.castMode === 'charge') return s;              // the telegraphed one
      if (preferBoss && s.boss) return s;
      if (!pick || s.home.x < pick.home.x) pick = s;
    }
    return pick;
  }

  function enemyChest(slot) {
    return _v1.set(
      slot.home.x + slot.ox,
      (slot.mon ? slot.mon.userData.height : 1.6) * slot.scl * 0.55 + slot.oy,
      slot.home.z + slot.oz);
  }

  function hitEnemy(idx, dmg, color) {
    const slot = st.slots[idx];
    if (!slot) return;
    slot.hurtT0 = st.t;
    const p = enemyChest(slot);
    spawnFlash(flashPool, st.t, p.x - 0.6, p.y, p.z, color, 2.6 * slot.scl, 0.32);
    spawnFlash(flashPool, st.t, p.x - 0.2, p.y + 0.5, p.z + 0.3, 0xffffff, 1.3 * slot.scl, 0.22);
    if (dmg != null) spawnDmg(dmgPool, st.t, String(dmg), p.x, p.y + 0.9 * slot.scl, p.z, '#ffd76a', dmg >= 4);
    flashLight.color.set(color);
    flashLight.position.set(p.x, p.y + 0.5, p.z + 1.5);
    flashLight.intensity = 3.2;
    st.shake = Math.max(st.shake, 0.16);
  }

  function heroStruck(dmg, heavy) {
    const h = st.hero;
    h.hurtT0 = st.t;
    const y = h.kind === 'ship' ? 2.2 : 2.0;
    spawnFlash(flashPool, st.t, HERO_HOME.x + 1.4, y, HERO_HOME.z, HURT_RED, heavy ? 4.2 : 2.8, 0.4);
    if (dmg != null) spawnDmg(dmgPool, st.t, String(dmg), HERO_HOME.x, y + 1.6, HERO_HOME.z, '#ff8a70', !!heavy);
    flashLight.color.set(HURT_RED);
    flashLight.position.set(HERO_HOME.x + 1, y + 1, 2);
    flashLight.intensity = heavy ? 4.5 : 3;
    st.shake = Math.max(st.shake, heavy ? 0.55 : 0.28);
    st.kick = Math.max(st.kick, heavy ? 1.5 : 0.75);
  }

  function killSlot(idx) {
    const slot = st.slots[idx];
    if (!slot || slot.dead) return;
    slot.dead = true;
    slot.deadT0 = st.t;
    slot.castMode = null;
    if (st.chargeIdx === idx) clearCharge();
    if (st.targetIdx === idx) setTargeted(null);
    const p = enemyChest(slot);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      spawnFlash(flashPool, st.t, p.x, p.y * 0.6, p.z, 0xbfc8d6,
        1.5 * slot.scl, 0.6, Math.cos(a) * 2.2, 1.6 + i * 0.3, Math.sin(a) * 2.2);
    }
    reframe();
  }

  function clearCharge() {
    if (st.chargeIdx != null && st.slots[st.chargeIdx]) {
      st.slots[st.chargeIdx].castMode = null;
    }
    st.chargeIdx = null;
    aura.visible = false;
    chargeLight.intensity = 0;
  }

  function telegraph() {
    const boss = frontAttacker(true);
    if (!boss) return;
    const idx = st.slots.indexOf(boss);
    st.chargeIdx = idx;
    boss.castMode = 'charge';
    aura.visible = true;
    const h = (boss.mon ? boss.mon.userData.height : 2) * boss.scl;
    aura.position.set(boss.home.x, h * 0.5, boss.home.z);
    aura.scale.set(h * 2.4, h * 2.4, 1);
    chargeLight.position.set(boss.home.x - 1, h * 0.6, boss.home.z);
  }

  function fireBolt(fromV, toV, color, dur, onHit) {
    st.boltAnim = {
      from: fromV.clone(), to: toV.clone(),
      ctrl: fromV.clone().lerp(toV, 0.5).add(_v2.set(0, 3.5 + Math.abs(toV.x - fromV.x) * 0.18, 0)),
      t0: st.t, dur, onHit,
    };
    bolt.material.color.set(color);
    for (const tr of trail) tr.material.color.set(color);
    bolt.visible = true;
  }

  /* ── the beat API ─────────────────────────────────────────────────────── */
  function play(kind, payload = {}) {
    if (!st.active) return;
    if (kind !== 'charge_telegraph') clearCharge();
    const t = st.t;
    switch (kind) {
      case 'player_hit': {
        const idx = payload.idx ?? 0;
        if (payload.stance === 'magic') {
          const from = _v2.set(HERO_HOME.x + 0.5, st.hero.kind === 'ship' ? 4.6 : 2.6, HERO_HOME.z);
          const slot = st.slots[idx];
          const to = slot ? enemyChest(slot).clone() : _v3.set(8, 2, 0);
          fireBolt(from, to, ARCANE, 0.55, () => hitEnemy(idx, payload.dmg, ARCANE));
          st.hero.atkT0 = t;                        // captain raises arms too
        } else {
          st.beats.push({ kind: 'heroStrike', idx, t0: t, dur: 0.9, dmg: payload.dmg, fired: false });
          st.hero.atkT0 = t;
        }
        break;
      }
      case 'enemy_die':
        killSlot(payload.idx ?? 0);
        break;
      case 'enemy_attack': {
        const s = frontAttacker(!!payload.heavy);
        if (!s) break;
        st.beats.push({
          kind: 'enemyLunge', idx: st.slots.indexOf(s), t0: t,
          dur: payload.heavy ? 1.5 : 1.05, heavy: !!payload.heavy,
          dmg: payload.dmg, mode: 'hit', fired: false,
        });
        break;
      }
      case 'enemy_miss': {
        const s = frontAttacker(false);
        if (!s) break;
        st.beats.push({
          kind: 'enemyLunge', idx: st.slots.indexOf(s), t0: t,
          dur: 1.15, heavy: false, mode: 'miss', fired: false,
        });
        break;
      }
      case 'backfire': {
        // `to` outlives this call inside the onHit closure — real allocation
        const from = _v2.set(HERO_HOME.x + 0.5, st.hero.kind === 'ship' ? 4.6 : 2.6, HERO_HOME.z);
        const to = new THREE.Vector3(HERO_HOME.x + 0.6, st.hero.kind === 'ship' ? 2.4 : 1.4, HERO_HOME.z);
        fireBolt(from, to, BACKFIRE, 0.7, () => {
          spawnFlash(flashPool, st.t, to.x, to.y + 0.5, to.z, BACKFIRE, 3.4, 0.45);
          flashLight.color.set(BACKFIRE);
          flashLight.position.set(to.x, to.y + 1.5, 2);
          flashLight.intensity = 3.5;
          st.hero.hurtT0 = st.t;
          st.shake = Math.max(st.shake, 0.22);
        });
        st.hero.atkT0 = t;
        break;
      }
      case 'guard_block': {
        const s = frontAttacker(!!payload.heavy);
        if (!s) break;
        st.beats.push({
          kind: 'enemyLunge', idx: st.slots.indexOf(s), t0: t,
          dur: payload.heavy ? 1.5 : 1.15, heavy: !!payload.heavy,
          mode: 'block', fired: false,
        });
        break;
      }
      case 'charge_telegraph':
        telegraph();
        break;
      case 'victory': {
        st.victory = true;
        st.victoryT0 = t;
        setTargeted(null);
        let i = 0;
        for (const s of st.slots) {
          if (s.dead) continue;
          st.beats.push({ kind: 'slayAt', idx: st.slots.indexOf(s), t0: t + 0.25 + i * 0.22, dur: 0.01, fired: false });
          i++;
        }
        spawnFlash(flashPool, t, HERO_HOME.x, 4, HERO_HOME.z, GOLD, 5, 0.9, 0, 1.5, 0);
        break;
      }
      case 'defeat':
        st.defeat = true;
        st.defeatT0 = t;
        setTargeted(null);
        clearCharge();
        break;
      default:
        break;
    }
  }

  function setTargeted(idx) {
    st.targetIdx = (idx == null || !st.slots[idx] || st.slots[idx].dead) ? null : idx;
    ring.visible = st.targetIdx != null;
  }

  /* ── per-frame ────────────────────────────────────────────────────────── */

  function updateBeats(t) {
    for (let i = st.beats.length - 1; i >= 0; i--) {
      const b = st.beats[i];
      const k = (t - b.t0) / b.dur;
      if (b.kind === 'slayAt') {
        if (t >= b.t0) { killSlot(b.idx); st.beats.splice(i, 1); }
        continue;
      }
      if (k >= 1) {
        if (b.kind === 'enemyLunge' && st.slots[b.idx]) st.slots[b.idx].lunge = null;
        st.beats.splice(i, 1);
        continue;
      }
      if (b.kind === 'heroStrike') {
        // ram surge: coil back then drive the prow at the target
        let drive;
        if (k < 0.3) drive = -easeOut(k / 0.3) * 0.3;
        else if (k < 0.52) drive = -0.3 + easeIn((k - 0.3) / 0.22) * 1.3;
        else drive = 1 - easeInOut((k - 0.52) / 0.48);
        const h = st.hero;
        const reach = h.kind === 'ship' ? 5.2 : 2.6;
        h.ox += drive * reach;
        h.rz += (drive < 0 ? drive * 0.05 : -drive * 0.06);
        h.rx += -Math.max(0, drive) * 0.03;
        if (!b.fired && k >= 0.5) {
          b.fired = true;
          hitEnemy(b.idx, b.dmg, GOLD);
          st.kick = Math.max(st.kick, 0.4);
        }
      } else if (b.kind === 'enemyLunge') {
        const slot = st.slots[b.idx];
        if (!slot) continue;
        slot.lunge = b;
        const windEnd = b.heavy ? 0.42 : 0.32;
        const hitK = b.heavy ? 0.58 : 0.52;
        const stopX = b.mode === 'block' ? -4.2
          : b.mode === 'miss' ? HERO_HOME.x - 5.5
          : HERO_HOME.x + 1.6;
        const dx = stopX - slot.home.x;
        if (k < windEnd) {
          // windup: rear back; heavies tremble with intent
          const wk = easeOut(k / windEnd);
          slot.ox += wk * 1.4 * (b.heavy ? 1.5 : 1);
          slot.oy += wk * (b.heavy ? 0.9 : 0.3);
          slot.rz += wk * (b.heavy ? 0.3 : 0.15);
          if (b.heavy) slot.ox += Math.sin(t * 34) * 0.06;
        } else if (k < hitK) {
          const lk = easeIn((k - windEnd) / (hitK - windEnd));
          slot.ox += (1 - lk) * 1.4 * (b.heavy ? 1.5 : 1) + lk * dx;
          slot.oy += Math.sin(lk * Math.PI) * (b.heavy ? 1.6 : 0.9) + (1 - lk) * (b.heavy ? 0.9 : 0.3);
          slot.rz += (1 - lk) * (b.heavy ? 0.3 : 0.15) - lk * 0.12;
        } else {
          const rk = (k - hitK) / (1 - hitK);
          if (b.mode === 'miss') {
            // sailed clean past the hero — slink back home, embarrassed
            slot.ox += dx * (1 - easeInOut(rk));
            slot.rz += -Math.sin(rk * Math.PI) * 0.1;
          } else if (b.mode === 'block') {
            // bounces off the guard, overshooting home before settling
            const bounce = Math.sin(Math.min(1, rk * 1.2) * Math.PI) * 1.5;
            slot.ox += dx * (1 - easeOut(rk)) + bounce;
            slot.rz += Math.sin(rk * Math.PI) * 0.16;
          } else {
            const rk2 = easeInOut(rk);
            slot.ox += dx * (1 - rk2);
            slot.oy += Math.sin((1 - rk2) * Math.PI * 0.5) * 0.2;
          }
        }
        if (!b.fired && k >= hitK) {
          b.fired = true;
          if (b.mode === 'hit') heroStruck(b.dmg, b.heavy);
          else if (b.mode === 'block') {
            st.shieldT0 = t;
            shield.visible = true;
            spawnFlash(flashPool, t, shield.position.x, shield.position.y, shield.position.z, GOLD, 4.5, 0.45);
            flashLight.color.set(GOLD);
            flashLight.position.set(shield.position.x, shield.position.y + 1, 2);
            flashLight.intensity = 3.5;
            st.shake = Math.max(st.shake, b.heavy ? 0.3 : 0.16);
          } else if (b.mode === 'miss') {
            st.shake = Math.max(st.shake, 0.08);   // wind of the passing blow
          }
        }
      }
    }
  }

  function updateBolt(t) {
    const B = st.boltAnim;
    if (!B) return;
    const k = clamp01((t - B.t0) / B.dur);
    // quadratic bezier
    const posAt = (kk, out) => {
      const a = 1 - kk;
      out.set(
        a * a * B.from.x + 2 * a * kk * B.ctrl.x + kk * kk * B.to.x,
        a * a * B.from.y + 2 * a * kk * B.ctrl.y + kk * kk * B.to.y,
        a * a * B.from.z + 2 * a * kk * B.ctrl.z + kk * kk * B.to.z);
      return out;
    };
    posAt(k, bolt.position);
    bolt.material.opacity = 0.95;
    const pulse = 1.3 + Math.sin(t * 30) * 0.25;
    bolt.scale.set(pulse, pulse, 1);
    for (let i = 0; i < trail.length; i++) {
      const tk = Math.max(0, k - (i + 1) * 0.07);
      posAt(tk, trail[i].position);
      trail[i].visible = true;
      trail[i].material.opacity = 0.5 - i * 0.11;
    }
    if (k >= 1) {
      st.boltAnim = null;
      bolt.visible = false;
      for (const tr of trail) tr.visible = false;
      if (B.onHit) B.onHit();
    }
  }

  function heroPose(t) {
    const h = st.hero;
    if (!h.holder) return;
    h.ox = 0; h.oy = 0; h.oz = 0; h.rx = 0; h.ry = 0; h.rz = 0;
    // at-anchor bob
    if (h.kind === 'ship') {
      h.oy += Math.sin(t * 1.7) * 0.09;
      h.rz += Math.sin(t * 1.25) * 0.02;
      h.rx += Math.sin(t * 0.9 + 1.2) * 0.012;
    }
    // flinch
    const hk = (t - h.hurtT0) / 0.55;
    if (hk >= 0 && hk < 1) {
      const d = 1 - hk;
      h.ox += -d * 0.6;
      h.rz += Math.sin(hk * Math.PI * 4) * d * 0.07;
      h.rx += Math.sin(hk * Math.PI * 3) * d * 0.04;
    }
    // defeat: list to port and settle low
    if (st.defeat) {
      const dk = clamp01((t - st.defeatT0) / 2.6);
      h.rx += easeInOut(dk) * 0.5;
      h.oy += -easeInOut(dk) * (h.kind === 'ship' ? 0.9 : 0.5);
      h.ox += -easeInOut(dk) * 0.8;
    }
    // beat offsets were accumulated by updateBeats before this runs
  }

  function applyHero(t) {
    const h = st.hero;
    if (!h.holder) return;
    h.holder.position.set(HERO_HOME.x + h.ox, HERO_HOME.y + h.oy, HERO_HOME.z + h.oz);
    h.holder.rotation.set(h.rx, -0.12 + h.ry, h.rz);
    if (h.mon) {
      const ak = t - h.atkT0;
      const hk = t - h.hurtT0;
      if (st.defeat) animateMonster(h.mon, Math.min(t - st.defeatT0, 1.15), 'die');
      else if (hk >= 0 && hk < 0.5) animateMonster(h.mon, hk, 'hurt');
      else if (ak >= 0 && ak < 0.9) animateMonster(h.mon, ak, 'attack');
      else animateMonster(h.mon, t, 'idle');
    }
  }

  function updateSlots(t) {
    for (const s of st.slots) {
      // beat accumulators reset; updateBeats re-adds while a lunge is live
      const hadLunge = s.lunge;
      if (!hadLunge) { s.ox = 0; s.oy = 0; s.oz = 0; s.rz = 0; }
      s.holder.position.set(s.home.x + s.ox, s.home.y + s.oy, s.home.z + s.oz);
      s.holder.rotation.z = s.rz;
      if (s.dead && t - s.deadT0 > 1.45) s.holder.visible = false;
      if (!s.mon) continue;
      if (s.dead) {
        animateMonster(s.mon, t - s.deadT0, 'die');
      } else if (s.lunge) {
        // time-warp the attack pose across the lunge so the jaw snaps on contact
        const b = s.lunge;
        animateMonster(s.mon, clamp01((t - b.t0) / b.dur) * 0.88, 'attack');
      } else if (t - s.hurtT0 < 0.5) {
        animateMonster(s.mon, t - s.hurtT0, 'hurt');
      } else if (s.castMode) {
        animateMonster(s.mon, t, s.castMode);
      } else {
        animateMonster(s.mon, t + s.phase, 'idle');
      }
    }
    // zero the lunge accumulators AFTER pose application; beats rebuild them
    for (const s of st.slots) {
      if (s.lunge) { s.ox = 0; s.oy = 0; s.oz = 0; s.rz = 0; }
    }
  }

  function updateCamera(t, dt) {
    // frame goal easing (boss reveals, victory push-in)
    if (st.victory) {
      st.camGoal.set(-14.5, 3.9, 5.6);
      st.camLookGoal.set(HERO_HOME.x + 2, 2.2, HERO_HOME.z);
    }
    const ease = 1 - Math.exp(-dt * 2.2);
    st.camBase.lerp(st.camGoal, ease);
    st.camLook.lerp(st.camLookGoal, ease);

    // slow handheld sway — always gentle, never nauseating
    const sx = Math.sin(t * 0.26 + st.swayPh) * 0.38;
    const sy = Math.sin(t * 0.21 + st.swayPh * 2) * 0.16;
    const sz = Math.cos(t * 0.165 + st.swayPh) * 0.3;

    // impact kick: brief dolly toward the action, springs back
    st.kick *= Math.exp(-dt * 5.5);
    st.shake *= Math.exp(-dt * 4.2);
    const jx = Math.sin(t * 43.7) * st.shake;
    const jy = Math.sin(t * 57.3 + 1.7) * st.shake * 0.7;
    const jz = Math.sin(t * 38.1 + 3.1) * st.shake * 0.6;

    _v2.copy(st.camLook).sub(st.camBase).normalize();
    camera.position.set(
      st.camBase.x + sx + jx + _v2.x * st.kick,
      st.camBase.y + sy + jy + _v2.y * st.kick,
      st.camBase.z + sz + jz + _v2.z * st.kick);
    _v3.set(st.camLook.x + jx * 0.5, st.camLook.y + jy * 0.5, st.camLook.z + jz * 0.5);
    camera.lookAt(_v3);
  }

  function update(t, dt) {
    if (!st.active) return;
    st.t = t;
    dt = Math.min(dt || 0.016, 0.05);

    heroPose(t);          // base hero accumulators
    updateBeats(t);       // adds beat offsets (hero + slots)
    applyHero(t);
    updateSlots(t);
    updateBolt(t);
    updateDmg(dmgPool, t);
    updateFlash(flashPool, t);

    // guard shield flare
    const sk = (t - st.shieldT0) / 0.55;
    if (sk >= 0 && sk < 1) {
      shield.visible = true;
      const o = (1 - sk);
      shieldDisc.material.opacity = o * 0.8;
      shieldGlow.material.opacity = o * 0.7;
      const s = 0.7 + easeOut(sk) * 0.6;
      shieldDisc.scale.set(s, s, s);
    } else if (shield.visible) {
      shield.visible = false;
    }

    // target ring pulse
    if (st.targetIdx != null) {
      const slot = st.slots[st.targetIdx];
      if (!slot || slot.dead) { setTargeted(null); }
      else {
        const p = 1 + Math.sin(t * 5.5) * 0.07;
        ring.position.set(slot.home.x + slot.ox, 0.06, slot.home.z + slot.oz);
        ring.scale.set(slot.scl * p, slot.scl * p, 1);
        ring.material.opacity = 0.5 + Math.sin(t * 5.5) * 0.22;
      }
    }

    // charge telegraph: pulsing red menace on the boss
    if (st.chargeIdx != null) {
      const slot = st.slots[st.chargeIdx];
      if (slot && !slot.dead) {
        const pulse = 0.24 + Math.sin(t * 9) * 0.14;
        aura.material.opacity = pulse;
        chargeLight.intensity = 1.6 + Math.sin(t * 9) * 1.1;
        aura.position.x = slot.home.x + slot.ox;
        aura.position.z = slot.home.z + slot.oz;
      } else {
        clearCharge();
      }
    }

    // impact light decays fast
    flashLight.intensity *= Math.exp(-dt * 9);

    // defeat: the light goes out of the world
    if (st.defeat && st.dim < 1) {
      st.dim = clamp01(st.dim + dt / 2.2);
      const d = 1 - st.dim * 0.75;
      key.intensity = st.baseKey * d;
      rim.intensity = st.baseRim * (1 - st.dim * 0.5);
      hemi.intensity = st.baseHemi * d;
      amb.intensity = st.baseAmb * d;
      heroLamp.intensity = 0.65 * (1 - st.dim);
    }
    if (st.victory) {
      // warm the key light as the dust settles
      const vk = clamp01((t - st.victoryT0) / 2);
      key.intensity = st.baseKey * (1 + vk * 0.18);
    }

    if (st.backdrop && st.backdrop.userData.update) st.backdrop.userData.update(t);

    updateCamera(t, dt);
  }

  function resize(w, h) {
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  return { enter, exit, play, update, scene, camera, resize, setTargeted };
}

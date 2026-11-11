/*
 * worldfx.js — WORLD events on the board (events.py → room.world): the
 * wandering merchant, a pod of dolphins, a whirlpool, a fog bank, a surfaced
 * wreck, a festival, the roaming sea-serpent, and in the Amber Vale a fairy
 * ring, the fey market and a hound of Artemis. Each wonder is a small set
 * piece beside its stop that glides to its new stop when it moves.
 *
 * scene.js calls  fx.sync(room, ctx)  once a frame (like syncKraken), with
 * ctx = { stages, nodeById, stageHasNode, t, groundY, islandR }. Budget: a
 * handful of meshes per wonder, shared geometry/materials/textures, no
 * lights, no per-frame allocation; transparent pieces are small.
 */
import * as THREE from 'three';
import { makeShip } from './ship.js';
import { propGroup } from './props.js';
import { getMonster, animateMonster, disposeMonster } from './monsters.js';

const SEA_Y = -0.3;               // the ocean's rest level (gfx/ocean.js)
const _v = new THREE.Vector3();

/* ── shared textures / materials (built once) ──────────────────────────── */
let T = null;
function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function shared() {
  if (T) return T;
  const spiral = canvasTex(256, (g, s) => {
    g.translate(s / 2, s / 2);
    for (let arm = 0; arm < 4; arm++) {
      g.rotate(Math.PI / 2);
      for (let i = 0; i < 90; i++) {
        const a = i * 0.075, r = 6 + i * 1.32;
        g.fillStyle = `rgba(235, 250, 255, ${0.5 * (1 - i / 95)})`;
        g.beginPath();
        g.arc(Math.cos(a) * r, Math.sin(a) * r, 2.4 + i * 0.05, 0, Math.PI * 2);
        g.fill();
      }
    }
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, s / 2);
    grd.addColorStop(0, 'rgba(4, 22, 34, .85)');
    grd.addColorStop(0.35, 'rgba(10, 52, 70, .35)');
    grd.addColorStop(1, 'rgba(10, 52, 70, 0)');
    g.fillStyle = grd;
    g.fillRect(-s / 2, -s / 2, s, s);
  });
  const puff = canvasTex(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,.9)');
    grd.addColorStop(0.45, 'rgba(255,255,255,.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
  const glow = canvasTex(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,240,190,1)');
    grd.addColorStop(0.3, 'rgba(255,190,90,.6)');
    grd.addColorStop(1, 'rgba(255,150,40,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
  T = {
    whirlMat: new THREE.MeshBasicMaterial({ map: spiral, transparent: true, depthWrite: false,
                                            fog: true, opacity: 0.95 }),
    funnelMat: new THREE.MeshStandardMaterial({ color: 0x0c3a4c, roughness: 0.15, metalness: 0.0,
                                                transparent: true, opacity: 0.8, depthWrite: false,
                                                side: THREE.DoubleSide }),
    fogMat: new THREE.SpriteMaterial({ map: puff, color: 0xdfe8ec, transparent: true,
                                       opacity: 0.55, depthWrite: false, fog: true }),
    glowMat: new THREE.SpriteMaterial({ map: glow, color: 0xffd28a, transparent: true,
                                        blending: THREE.AdditiveBlending, depthWrite: false }),
    fairyMat: new THREE.SpriteMaterial({ map: glow, color: 0xb6f0ff, transparent: true,
                                         blending: THREE.AdditiveBlending, depthWrite: false }),
    dolphinMat: new THREE.MeshStandardMaterial({ color: 0x7f97a8, roughness: 0.32, metalness: 0.05 }),
    bellyMat: new THREE.MeshStandardMaterial({ color: 0xd9e2e6, roughness: 0.4 }),
    lanternMat: new THREE.MeshStandardMaterial({ color: 0xe0703a, emissive: 0xff9a40,
                                                 emissiveIntensity: 2.2, roughness: 0.6 }),
    raftMat: new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 }),
    clothMat: new THREE.MeshStandardMaterial({ color: 0xa8324a, roughness: 0.7, side: THREE.DoubleSide }),
  };
  // geometries
  const prof = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    const r = Math.sin(Math.PI * Math.pow(u, 0.8)) * 0.42 * (1 - 0.35 * u);
    prof.push(new THREE.Vector2(Math.max(0.001, r), (u - 0.5) * 3.0));
  }
  T.dolphinBody = new THREE.LatheGeometry(prof, 14).rotateZ(-Math.PI / 2);
  T.dolphinFin = new THREE.ConeGeometry(0.22, 0.6, 6).scale(0.35, 1, 1);
  T.dolphinTail = new THREE.ConeGeometry(0.34, 0.5, 6).scale(1, 1, 0.25).rotateZ(Math.PI / 2);
  T.disc = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  T.funnel = new THREE.CylinderGeometry(3.6, 0.4, 2.6, 28, 1, true);
  T.lantern = new THREE.SphereGeometry(0.32, 10, 8).scale(1, 1.3, 1);
  T.raft = new THREE.CylinderGeometry(0.8, 0.9, 0.18, 10);
  T.pennant = new THREE.PlaneGeometry(1.2, 0.7);
  return T;
}

/* ── builders ───────────────────────────────────────────────────────────── */
function dolphinPod() {
  const S = shared();
  const g = new THREE.Group();
  g.userData.kids = [];
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Group();
    const body = new THREE.Mesh(S.dolphinBody, S.dolphinMat);
    body.castShadow = true;
    const fin = new THREE.Mesh(S.dolphinFin, S.dolphinMat);
    fin.position.set(0.1, 0.42, 0);
    const tail = new THREE.Mesh(S.dolphinTail, S.dolphinMat);
    tail.position.set(-1.55, 0, 0);
    const belly = new THREE.Mesh(S.dolphinBody, S.bellyMat);
    belly.scale.set(0.96, 0.82, 0.9);
    belly.position.y = -0.06;
    d.add(body, belly, fin, tail);
    d.userData.ph = i * 2.1;
    g.add(d);
    g.userData.kids.push(d);
  }
  g.scale.setScalar(1.7);
  return g;
}

function whirlpool() {
  const S = shared();
  const g = new THREE.Group();
  const disc = new THREE.Mesh(S.disc, S.whirlMat);
  disc.scale.setScalar(9);
  disc.position.y = 0.06;
  disc.renderOrder = 2;
  const funnel = new THREE.Mesh(S.funnel, S.funnelMat);
  funnel.position.y = -1.2;
  g.add(funnel, disc);
  g.userData.spin = [disc, funnel];
  return g;
}

function fogBank() {
  const S = shared();
  const g = new THREE.Group();
  g.userData.puffs = [];
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Sprite(S.fogMat);
    const a = (i / 9) * Math.PI * 2;
    const r = 4 + (i % 3) * 3.2;
    s.position.set(Math.cos(a) * r, 1.4 + (i % 2) * 1.2, Math.sin(a) * r);
    s.scale.setScalar(9 + (i % 3) * 2.5);
    s.userData.base = s.position.clone();
    s.userData.ph = i * 0.7;
    g.add(s);
    g.userData.puffs.push(s);
  }
  return g;
}

function wreck() {
  const S = shared();
  const g = new THREE.Group();
  const hulk = propGroup('shipwreck', 2.2);
  hulk.rotation.y = 0.6;
  hulk.position.y = -0.9;
  const b1 = propGroup('barrel', 0.9);
  b1.position.set(3.4, -0.25, 1.6);
  const b2 = propGroup('amphora_pile', 0.8);
  b2.position.set(-2.6, -0.3, 2.4);
  const glint = new THREE.Sprite(S.glowMat);
  glint.scale.setScalar(2.6);
  glint.position.set(0.4, 0.9, 0.2);
  g.add(hulk, b1, b2, glint);
  g.userData.bob = [b1, b2];
  g.userData.glint = glint;
  return g;
}

function festival(R) {
  const S = shared();
  const g = new THREE.Group();
  g.userData.lights = [];
  const n = 10;
  const ring = R + 2.6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const l = new THREE.Group();
    const raft = new THREE.Mesh(S.raft, S.raftMat);
    const lamp = new THREE.Mesh(S.lantern, S.lanternMat);
    lamp.position.y = 0.45;
    l.add(raft, lamp);
    l.position.set(Math.cos(a) * ring, SEA_Y + 0.05, Math.sin(a) * ring);
    l.userData.ph = i * 0.9;
    g.add(l);
    g.userData.lights.push(l);
  }
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI + 0.7;
    const pole = propGroup('banner_pole', 1.3);
    pole.position.set(Math.cos(a) * (R + 1.2), SEA_Y, Math.sin(a) * (R + 1.2));
    const flag = new THREE.Mesh(S.pennant, S.clothMat);
    flag.position.set(Math.cos(a) * (R + 1.2) + 0.6, 3.2, Math.sin(a) * (R + 1.2));
    g.add(pole, flag);
    g.userData.flags = (g.userData.flags || []).concat(flag);
  }
  return g;
}

function fairyRing() {
  const S = shared();
  const g = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const m = propGroup('mushroom_cluster', 0.55 + (i % 3) * 0.12, false);
    m.position.set(Math.cos(a) * 2.4, 0, Math.sin(a) * 2.4);
    m.rotation.y = a * 3;
    g.add(m);
  }
  g.userData.motes = [];
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Sprite(S.fairyMat);
    s.scale.setScalar(0.7);
    s.userData.ph = i * 1.05;
    g.add(s);
    g.userData.motes.push(s);
  }
  return g;
}

function feyMarket() {
  const S = shared();
  const g = new THREE.Group();
  const fire = propGroup('campfire', 0.9);
  const p1 = propGroup('banner_pole', 1.1);
  p1.position.set(-2.2, 0, -0.6);
  const p2 = propGroup('banner_pole', 1.1);
  p2.position.set(2.2, 0, -0.4);
  const crates = propGroup('barrel', 0.7);
  crates.position.set(1.2, 0, 1.6);
  const jars = propGroup('amphora_pile', 0.6);
  jars.position.set(-1.4, 0, 1.4);
  g.add(fire, p1, p2, crates, jars);
  g.userData.motes = [];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Sprite(S.glowMat);
    s.scale.setScalar(0.8);
    s.userData.ph = i * 1.3;
    g.add(s);
    g.userData.motes.push(s);
  }
  return g;
}

function merchantShip() {
  const ship = makeShip('#8c6fa8');           // purple sails, a neutral hull
  ship.scale.setScalar(2.3);
  const g = new THREE.Group();
  g.add(ship);
  return g;
}

/* ── the sync loop ──────────────────────────────────────────────────────── */
export function createWorldFx() {
  const recs = new Map();          // wid → rec

  function stageOf(n) { return n.region || 'hub'; }

  function build(w, n, ctx, rec) {
    switch (w.model) {
      case 'merchant': return merchantShip();
      case 'dolphins': return dolphinPod();
      case 'whirlpool': return whirlpool();
      case 'fog': return fogBank();
      case 'wreck': return wreck();
      case 'festival': return festival(ctx.islandR(stageOf(n), w.node));
      case 'ring': return fairyRing();
      case 'feymarket': return feyMarket();
      case 'serpent':
      case 'hound': {
        const g = new THREE.Group();
        const id = w.model === 'serpent' ? 'serpent' : 'stalker';
        getMonster(id, { scale: w.model === 'serpent' ? 3.4 : 1.2 }).then((mon) => {
          if (recs.get(w.wid) !== rec) { disposeMonster(mon); return; }
          rec.monster = mon;
          g.add(mon);
        }).catch(() => {});
        return g;
      }
      default: return null;
    }
  }

  function anchor(w, n, ctx, foot) {
    // beside the stop, never on it: the ship berths at the stop itself
    if (w.model === 'festival' || w.model === 'whirlpool' || w.model === 'fog') {
      return _v.set(n.x, 0, n.z);
    }
    const a = (w.wid * 2.399) % (Math.PI * 2);
    // clear of any islet the stop sits on (sea stops can wear a rock or an isle)
    const isle = ctx.stages[stageOf(n)]?.islands?.[w.node];
    const r = foot ? 3.6 : (isle ? isle.R + 5 : 7.5);
    return _v.set(n.x + Math.cos(a) * r, 0, n.z + Math.sin(a) * r);
  }

  function sync(room, ctx) {
    const list = room?.world || [];
    const want = new Set();
    for (const w of list) {
      const n = ctx.nodeById[w.node];
      if (!n) continue;
      const stageId = stageOf(n);
      const st = ctx.stages[stageId];
      if (!st || !ctx.stageHasNode(stageId, w.node)) continue;
      want.add(w.wid);
      let rec = recs.get(w.wid);
      if (rec && rec.stageId !== stageId) { drop(w.wid); rec = null; }
      const foot = n.mode === 'foot' || stageId === 'autumn';
      if (!rec) {
        rec = { wid: w.wid, model: w.model, stageId, node: w.node, scene: st.scene, foot,
                pos: new THREE.Vector3(), to: new THREE.Vector3(), monster: null };
        const obj = build(w, n, ctx, rec);
        if (!obj) continue;
        rec.obj = obj;
        recs.set(w.wid, rec);
        anchor(w, n, ctx, foot);
        rec.pos.copy(_v);
        rec.to.copy(_v);
        obj.position.copy(_v);
        st.scene.add(obj);
      }
      if (rec.node !== w.node) {                 // it moved this round: glide
        rec.node = w.node;
        anchor(w, n, ctx, foot);
        rec.to.copy(_v);
      }
    }
    for (const wid of [...recs.keys()]) if (!want.has(wid)) drop(wid);
    tick(ctx);
  }

  function tick(ctx) {
    const t = ctx.t;
    for (const rec of recs.values()) {
      const o = rec.obj;
      // glide toward the new stop
      rec.pos.lerp(rec.to, 0.02);
      const dx = rec.to.x - rec.pos.x, dz = rec.to.z - rec.pos.z;
      const moving = dx * dx + dz * dz > 0.05;
      o.position.x = rec.pos.x;
      o.position.z = rec.pos.z;
      const st = ctx.stages[rec.stageId];
      const ground = rec.foot && st ? ctx.groundY(st, o.position.x, o.position.z) : SEA_Y;
      const u = o.userData;
      switch (rec.model) {
        case 'merchant':
          o.position.y = SEA_Y + 0.15 + Math.sin(t * 1.1 + rec.wid) * 0.12;
          o.rotation.z = Math.sin(t * 0.9 + rec.wid) * 0.035;
          o.rotation.y = moving ? Math.atan2(-dz, dx) : o.rotation.y + 0.0015;
          break;
        case 'dolphins':
          o.position.y = SEA_Y;
          for (const d of u.kids) {
            const ph = t * 1.3 + d.userData.ph;
            const a = ph * 0.6;
            d.position.set(Math.cos(a) * 3.2, Math.sin(ph * 2.2) * 1.1 - 0.35, Math.sin(a) * 3.2);
            d.rotation.set(0, -a - Math.PI / 2, Math.cos(ph * 2.2) * 0.6);
          }
          break;
        case 'whirlpool':
          o.position.y = SEA_Y;
          u.spin[0].rotation.y = -t * 0.9;
          u.spin[1].rotation.y = -t * 1.6;
          break;
        case 'fog':
          o.position.y = SEA_Y;
          for (const s of u.puffs) {
            s.position.x = s.userData.base.x + Math.sin(t * 0.21 + s.userData.ph) * 1.4;
            s.position.z = s.userData.base.z + Math.cos(t * 0.17 + s.userData.ph) * 1.4;
          }
          break;
        case 'wreck':
          o.position.y = SEA_Y;
          for (const [i, b] of u.bob.entries()) b.position.y = -0.3 + Math.sin(t * 1.4 + i * 2) * 0.12;
          u.glint.material.opacity = 0.55 + Math.sin(t * 3.1) * 0.35;
          break;
        case 'festival':
          o.position.y = 0;
          for (const l of u.lights) l.position.y = SEA_Y + 0.05 + Math.sin(t * 1.2 + l.userData.ph) * 0.1;
          for (const f of u.flags || []) f.rotation.y = Math.sin(t * 2 + f.position.x) * 0.25;
          break;
        case 'ring':
        case 'feymarket':
          o.position.y = ground;
          for (const s of u.motes || []) {
            const ph = t * 0.7 + s.userData.ph;
            s.position.set(Math.cos(ph) * 1.6, 1.2 + Math.sin(ph * 1.7) * 0.5, Math.sin(ph) * 1.6);
          }
          break;
        case 'serpent':
          o.position.y = SEA_Y - 0.2 + Math.sin(t * 0.9 + rec.wid) * 0.3;
          o.rotation.y = moving ? Math.atan2(-dz, dx) : Math.sin(t * 0.2) * 0.6;
          if (rec.monster) animateMonster(rec.monster, t, 'idle');
          break;
        case 'hound':
          o.position.y = ground;
          o.rotation.y = moving ? Math.atan2(-dz, dx) : Math.sin(t * 0.3 + rec.wid) * 0.8;
          if (rec.monster) animateMonster(rec.monster, t, 'idle');
          break;
        default:
          break;
      }
    }
  }

  function drop(wid) {
    const rec = recs.get(wid);
    if (!rec) return;
    rec.obj.parent?.remove(rec.obj);
    if (rec.monster) disposeMonster(rec.monster);
    recs.delete(wid);
  }

  function clear() { for (const wid of [...recs.keys()]) drop(wid); }

  return { sync, clear };
}

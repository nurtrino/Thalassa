/*
 * worldfx.js — WORLD events on the board (events.py → room.world): the
 * wandering merchant, a pod of dolphins, a whirlpool, a fog bank, a surfaced
 * wreck, a festival, the roaming sea-serpent, the runaway barge, the golden
 * fish, the ghost ship, the singing whales, Hermes, Daedalus' automaton, the
 * turtle isle, Icarus' crash; in the Amber Vale a fairy ring, the fey market
 * and a hound of Artemis; in the Bleached Reach the salt caravan, a
 * sandstorm, a mirage and the golden scarab. Each wonder is a set piece
 * beside its stop (models/eventprops.js, models/wonders.js) with a soft
 * light pool and a shaft of light so it reads from the board camera; sea
 * wonders ride the real swell (st.surf.waveHeight, as tickShips does) and
 * glide to their new stop when they move.
 *
 * scene.js calls  fx.sync(room, ctx)  once a frame (like syncKraken), with
 * ctx = { stages, nodeById, stageHasNode, t, groundY, islandR }. Budget: a
 * handful of merged meshes and a few sprites per wonder, shared geometry and
 * materials, no lights, no per-frame allocation. Builders animate themselves
 * (kit.animate); this file only places, heaves and steers them.
 */
import * as THREE from 'three';
import { propGroup } from './props.js';
import { getMonster, animateMonster, disposeMonster } from './monsters.js';
import { cached, mat, Parts, lathe, blob, glowSprite } from './models/kit.js';
import { makeMerchantShip, makeDolphin, makeWhirlpool, makeFogBank, makeWreck,
  makeFestivalPavilion } from './models/eventprops.js';
import { makeWonderBeacon, makeCaravan, makeSandstorm, makeMirage, makeScarab, makeBarge,
  makeGoldfish, makeGhostShip, makeWhales, makeHermesParcel, makeAutomaton, makeTurtleIsle,
  makeIcarusWreck } from './models/wonders.js';
import { buildRealmWonder, REALM_LOOK } from './worldfx_realms.js';

const SEA_Y = -0.3;               // the ocean's rest level (gfx/ocean.js WATER_Y)
const _v = new THREE.Vector3();

/* how each model sits and is marked:
     ride   — heave/pitch/roll on the swell (sea) · 'ground' — on the floor
     beacon — the colour of its light pool and shaft (null: none)
     centre — sits ON its stop (it surrounds the ship), else beside it
     off    — extra clearance beside the stop for big pieces
     face   — turns to face where it is travelling
     faceStop — its front (+x) turns to the stop it stands beside, and
                eases toward the camera (≤ ~70° off that) so a face is seen */
const LOOK = {
  merchant: { ride: true, beacon: 0xffc860, face: true },
  dolphins: { beacon: 0x9fe8ff, off: 3 },
  whirlpool: { beacon: 0xb48cff, centre: true, r: 9 },
  fog: { beacon: 0xdfe8ec, centre: true, r: 8, h: 10 },
  wreck: { ride: true, beacon: 0xffd070, off: 1 },
  festival: { beacon: 0xffa050 },
  serpent: { beacon: 0xff5a4a },
  barge: { ride: true, beacon: 0xffa050, face: true, off: 2 },
  goldfish: { beacon: 0xffd040 },
  ghostship: { ride: true, beacon: 0x6affb8, face: true },
  whales: { beacon: 0x9fe8ff, off: 2 },
  hermes: { beacon: 0xffe39a },
  automaton: { ride: true, beacon: 0x7ad8ff },
  turtleisle: { ride: true, beacon: 0x9fe870, face: true, off: 4, r: 9 },
  icarus: { ride: true, beacon: 0xffd070, off: 1 },
  ring: { ground: true, beacon: 0x9ff0d8 },
  feymarket: { ground: true, beacon: 0xd08aff },
  hound: { ground: true, beacon: 0xff5a4a, face: true },
  caravan: { ground: true, beacon: 0xffc860, face: true, off: 3 },
  sandstorm: { ground: true, beacon: 0xff8a4a, centre: true, r: 8 },
  mirage: { ground: true, beacon: 0x9fe8ff, off: 1 },
  beetle: { ground: true, beacon: 0xffd040, face: true, off: 1 },
};
Object.assign(LOOK, REALM_LOOK);   // the Frostfang Reach, the Verdigris Deep (worldfx_realms.js)

/* ── builders the prop libraries don't cover ───────────────────────────── */
function dolphinPod() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const d = makeDolphin({ r: 3.2 + i * 1.1, seed: i + 1, scale: 1.25 });
    d.rotation.y = i * 2.1;
    g.add(d);
  }
  return g;
}

/* paper lanterns on little floats, ringing the festival island */
function lanternFloatGeo() {
  return cached('geo:lanternfloat', () => {
    const p = new Parts();
    p.add(lathe([[0.0, -0.06], [0.42, -0.06], [0.46, 0.0], [0.42, 0.06], [0.0, 0.06]], 14), 0x8a6a44);
    p.add(lathe([[0.0, 0.06], [0.07, 0.06], [0.05, 0.42], [0.0, 0.42]], 8), 0x5a4030);
    return p.geometry();
  });
}
function festival(R) {
  const g = new THREE.Group();
  const lamps = [];
  const n = 12, ring = R + 2.6;
  const lampGeo = cached('geo:festlamp', () => blob(0.26, 1, 1.3));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const l = new THREE.Group();
    const float = new THREE.Mesh(lanternFloatGeo(), mat.wood());
    const lamp = new THREE.Mesh(lampGeo, mat.glow(i % 3 ? 0xffa040 : 0xff6a50, 2.6));
    lamp.position.y = 0.62;
    l.add(float, lamp);
    l.position.set(Math.cos(a) * ring, 0, Math.sin(a) * ring);
    l.userData.ph = i * 0.9;
    g.add(l);
    lamps.push(l);
  }
  // a pavilion on a round raft moored beside the island
  const raft = new THREE.Group();
  const deck = new THREE.Mesh(cached('geo:festraft', () => {
    const p = new Parts();
    p.add(lathe([[0.0, -0.35], [3.3, -0.35], [3.5, -0.1], [3.4, 0.08], [0.0, 0.08]], 28), (x, y, z, nx, ny, nz, c) => {
      c.setHex(ny > 0.5 ? 0xc9a06a : 0x6a4a2e);
    });
    return p.geometry();
  }), mat.wood());
  deck.receiveShadow = true;
  const pav = makeFestivalPavilion({ hue: 0xc8402e });
  pav.scale.setScalar(0.72);
  pav.position.y = 0.08;
  raft.add(deck, pav);
  raft.position.set(R + 6, 0, 0);
  g.add(raft);
  g.userData.lamps = lamps;
  g.userData.raft = raft;
  return g;
}

function fairyRing() {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const m = propGroup('mushroom_cluster', 0.6 + (i % 3) * 0.14, false);
    m.position.set(Math.cos(a) * 2.5, 0, Math.sin(a) * 2.5);
    m.rotation.y = a * 3;
    g.add(m);
  }
  g.userData.motes = [];
  for (let i = 0; i < 7; i++) {
    const s = glowSprite(0xb6f0ff, 0.7, 0.8);
    s.userData.ph = i * 0.9;
    g.add(s);
    g.userData.motes.push(s);
  }
  g.scale.setScalar(1.6);
  return g;
}

function feyMarket() {
  const g = new THREE.Group();
  const pav = makeFestivalPavilion({ hue: 0x6a3a8a });
  pav.scale.setScalar(0.7);
  g.add(pav);
  const fire = propGroup('campfire', 0.8);
  fire.position.set(2.6, 0, 1.4);
  const jars = propGroup('amphora_pile', 0.6);
  jars.position.set(-2.4, 0, 1.2);
  const crates = propGroup('barrel', 0.7);
  crates.position.set(1.8, 0, -2.0);
  g.add(fire, jars, crates);
  g.userData.motes = [];
  for (let i = 0; i < 6; i++) {
    const s = glowSprite(i % 2 ? 0xd08aff : 0xffd28a, 0.75, 0.85);
    s.userData.ph = i * 1.1;
    g.add(s);
    g.userData.motes.push(s);
  }
  return g;
}

/* ── the sync loop ──────────────────────────────────────────────────────── */
export function createWorldFx() {
  const recs = new Map();          // wid → rec

  function stageOf(n) { return n.region || 'hub'; }

  function model(w, n, ctx, rec) {
    switch (w.model) {
      case 'merchant': { const s = makeMerchantShip(); s.scale.setScalar(1.9); return s; }
      case 'dolphins': return dolphinPod();
      case 'whirlpool': return makeWhirlpool({ r: 9 });
      case 'fog': return makeFogBank({ w: 24, d: 12, h: 6, seed: w.wid });
      case 'wreck': { const s = makeWreck({ seed: w.wid }); s.scale.setScalar(1.25); return s; }
      case 'festival': return festival(ctx.islandR(stageOf(n), w.node));
      case 'ring': return fairyRing();
      case 'feymarket': return feyMarket();
      case 'barge': { const s = makeBarge(); s.scale.setScalar(0.9); return s; }
      case 'goldfish': return makeGoldfish();
      case 'ghostship': return makeGhostShip();
      case 'whales': return makeWhales();
      case 'hermes': return makeHermesParcel();
      case 'automaton': return makeAutomaton();
      case 'turtleisle': return makeTurtleIsle();
      case 'icarus': return makeIcarusWreck();
      case 'caravan': return makeCaravan();
      case 'sandstorm': return makeSandstorm();
      case 'mirage': return makeMirage();
      case 'beetle': return makeScarab();
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
      default: return buildRealmWonder(w.model);
    }
  }

  function build(w, n, ctx, rec) {
    const inner = model(w, n, ctx, rec);
    if (!inner) return null;
    const look = LOOK[w.model] || {};
    const o = new THREE.Group();
    const rider = new THREE.Group();      // the swell tilts this; the beacon stays upright
    rider.rotation.order = 'YXZ';
    rider.add(inner);
    o.add(rider);
    if (look.beacon != null) {
      const b = makeWonderBeacon({ color: look.beacon, r: look.r ?? 6, h: look.h ?? 15, seed: w.wid });
      b.position.y = look.ground ? 0.0 : -0.12;
      o.add(b);
    }
    o.userData.rider = rider;
    o.userData.look = look;
    return o;
  }

  function anchor(w, n, ctx, foot) {
    const look = LOOK[w.model] || {};
    // beside the stop, never on it: the ship berths at the stop itself
    if (look.centre) return _v.set(n.x, 0, n.z);
    const a = (w.wid * 2.399) % (Math.PI * 2);
    // clear of any islet the stop sits on (sea stops can wear a rock or an isle)
    const isle = ctx.stages[stageOf(n)]?.islands?.[w.node];
    const r = (foot ? 4.2 : (isle ? isle.R + 5 : 7.5)) + (look.off || 0);
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
                pos: new THREE.Vector3(), to: new THREE.Vector3(), monster: null, yaw: 0 };
        const obj = build(w, n, ctx, rec);
        if (!obj) continue;
        rec.obj = obj;
        recs.set(w.wid, rec);
        anchor(w, n, ctx, foot);
        rec.pos.copy(_v);
        rec.to.copy(_v);
        obj.position.copy(_v);
        // a fixed piece faces off at a pleasing angle; a traveller picks its heading as it goes;
        // `faceStop` pieces (a face, a figure) turn their +x to the stop the ship berths at
        rec.yaw = (LOOK[w.model] || {}).faceStop ? Math.atan2(-(n.z - _v.z), n.x - _v.x) : (w.wid * 1.37) % (Math.PI * 2);
        st.scene.add(obj);
      }
      if (rec.node !== w.node) {                 // it moved this round: glide
        rec.node = w.node;
        anchor(w, n, ctx, foot);
        rec.to.copy(_v);
        if ((LOOK[w.model] || {}).faceStop) rec.yawStop = Math.atan2(-(n.z - _v.z), n.x - _v.x);
      }
    }
    for (const wid of [...recs.keys()]) if (!want.has(wid)) drop(wid);
    tick(ctx);
  }

  function tick(ctx) {
    const t = ctx.t;
    for (const rec of recs.values()) {
      const o = rec.obj;
      const u = o.userData;
      const look = u.look;
      // glide toward the new stop
      rec.pos.lerp(rec.to, 0.02);
      const dx = rec.to.x - rec.pos.x, dz = rec.to.z - rec.pos.z;
      const moving = dx * dx + dz * dz > 0.05;
      o.position.x = rec.pos.x;
      o.position.z = rec.pos.z;
      const st = ctx.stages[rec.stageId];
      if (look.face && moving) {
        // turn smoothly onto the heading (models face +x)
        const want = Math.atan2(-dz, dx);
        let d = want - rec.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        rec.yaw += d * 0.05;
      }
      if (look.faceStop && ctx.camera) {
        // a face must be SEEN: turn (slowly, like a drifting berg) from the
        // stop toward wherever the camera is, at most ~70° off the stop
        const cx = ctx.camera.position.x - o.position.x, cz = ctx.camera.position.z - o.position.z;
        const base = rec.yawStop ?? (rec.yawStop = rec.yaw);
        let d = Math.atan2(-cz, cx) - base;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const want = base + Math.max(-1.2, Math.min(1.2, d));
        let e = want - rec.yaw;
        e = Math.atan2(Math.sin(e), Math.cos(e));
        rec.yaw += e * 0.02;
      }
      u.rider.rotation.y = rec.yaw;
      if (rec.foot || look.ground) {
        o.position.y = st ? ctx.groundY(st, o.position.x, o.position.z) : 0;
      } else if (look.ride) {
        const wave = st?.surf?.waveHeight;
        if (wave) {
          // ride the real swell: heave with the surface, pitch and roll to its slope
          const x = o.position.x, z = o.position.z;
          const h0 = wave(x, z, t);
          const fx = Math.cos(rec.yaw), fz = -Math.sin(rec.yaw);
          const bow = wave(x + fx * 2.6, z + fz * 2.6, t), stern = wave(x - fx * 2.6, z - fz * 2.6, t);
          const port = wave(x - fz * 1.2, z + fx * 1.2, t), stbd = wave(x + fz * 1.2, z - fx * 1.2, t);
          o.position.y = (h0 - SEA_Y) * 0.85;
          u.rider.rotation.z = Math.atan2(bow - stern, 5.2) * 0.8;
          u.rider.rotation.x = Math.atan2(stbd - port, 2.4) * 0.6;
        } else {
          o.position.y = Math.sin(t * 1.1 + rec.wid) * 0.1;
          u.rider.rotation.z = Math.sin(t * 0.9 + rec.wid) * 0.03;
        }
      } else {
        o.position.y = 0;
      }
      const r = u.rider.children[0];
      switch (rec.model) {
        case 'festival':
          for (const l of r.userData.lamps) {
            l.position.y = Math.sin(t * 1.2 + l.userData.ph) * 0.1;
            l.rotation.z = Math.sin(t * 0.9 + l.userData.ph) * 0.08;
          }
          r.userData.raft.position.y = Math.sin(t * 0.8) * 0.08;
          break;
        case 'ring':
        case 'feymarket':
          for (const s of r.userData.motes || []) {
            const ph = t * 0.7 + s.userData.ph;
            s.position.set(Math.cos(ph) * 2.2, 1.3 + Math.sin(ph * 1.7) * 0.5, Math.sin(ph) * 2.2);
          }
          break;
        case 'serpent':
          o.position.y = SEA_Y - 0.2 + Math.sin(t * 0.9 + rec.wid) * 0.3;
          if (!moving) u.rider.rotation.y = rec.yaw + Math.sin(t * 0.2) * 0.6;
          else u.rider.rotation.y = Math.atan2(-dz, dx);
          if (rec.monster) animateMonster(rec.monster, t, 'idle');
          break;
        case 'hound':
          if (!moving) u.rider.rotation.y = rec.yaw + Math.sin(t * 0.3 + rec.wid) * 0.8;
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
    rec.obj.traverse((x) => x.userData.realmDispose?.());
    if (rec.monster) disposeMonster(rec.monster);
    recs.delete(wid);
  }

  function clear() { for (const wid of [...recs.keys()]) drop(wid); }

  /* where the set pieces of a stage stand (and how wide): scene.js keeps a
     berthing hull clear of them, so no galley parks through the penguins */
  function spots(stageId) {
    const out = [];
    for (const rec of recs.values()) {
      if (rec.stageId !== stageId) continue;
      const look = LOOK[rec.model] || {};
      if (look.centre) continue;               // a whirlpool, a fog bank: meant to be sailed INTO
      out.push({ x: rec.to.x, z: rec.to.z, pad: Math.max(0, (look.r || 5) - 4) });
    }
    return out;
  }

  return { sync, clear, spots };
}

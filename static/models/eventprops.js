/*
 * models/eventprops.js — set pieces for map EVENTS (wandering merchant,
 * whirlpool, fog bank, treasure wreck, festival, roaming beasts …).
 *
 * Every builder:   makeX(opts = {}) → THREE.Group, origin at its foot / at
 * sea level's reference y = 0 (the sea surface is y = −0.3; things that float
 * are built to sit right when the group is at y = 0, like the ships).
 *
 * Animated ones carry userData.update(t) — a PURE function of global time in
 * seconds (safe to call every frame, from any clock). By default they also
 * animate themselves (an onBeforeRender hook, no scene code needed); pass
 * { auto: false } to drive them yourself with userData.update(t).
 * Geometry and materials are cached and shared between instances
 * (userData.shared) — disposing an instance is safe.
 *
 *   makeMerchantShip({ cargo = true })       neutral galley, deck cargo (+x bow;
 *                                            scale ×1.7–2 like the player ships)
 *   makeFishingBoat({ hull, seed })          small caique, rocks on the swell
 *   makeWhirlpool({ r = 7 })                 turning vortex with a foam lip
 *   makeFogBank({ w = 30, d = 14, h = 7, seed }) drifting low cloud (soft sprites)
 *   makeWreck({ seed })                      broken hull awash, treasure glint
 *   makeFestivalPavilion({ hue })            canopy, garlands, lanterns
 *   makeSignalFire({ color })                beacon pyre on a cairn, big flame
 *   makeTreasureChest({ open = true })       bronze-bound chest, gold, glint
 *   makeMessageBottle()                      corked bottle with a scroll, bobbing
 *   makeDolphin({ r = 6, seed })             leaps in an arc round its origin
 *   makeGull({ r = 5, h = 6, seed })         glides in circles, flaps now and then
 *   makeGoat({ coat, seed })                 grazing goat (≈0.9 u)
 *   makeDiceTable()                          a satyr's dice table: table, dice,
 *                                            cup, stools, wine
 *   makePhilosopherBarrel()                  Diogenes' pithos with lamp & scrolls
 *
 * EVENT_PROPS maps a short id to each builder (used by modeltest.html).
 */
import { THREE, cached, mat, tex, Parts, M, paint, lathe, box, tube, blob, rockGeometry, flame, glowSprite, animate,
  smooth, mulberry32, facet } from './kit.js';
import { makeFishingBoat as caique, makeCrate, makeAmphora, makeBarrelGeo } from './props.js';
import { makeShip } from '../ship.js';
import { softDiscTexture } from '../util.js';

function finish(g, update, opts) {
  if (update) {
    g.userData.update = update;
    if (opts.auto !== false) animate(g, update);
  }
  return g;
}

/* ── merchant ship ───────────────────────────────────────────────────────── */
export function makeMerchantShip(opts = {}) {
  const g = new THREE.Group();
  const ship = makeShip('#b8a888');            // undyed canvas, banded device
  g.add(ship);
  if (opts.cargo !== false) {
    const p = new Parts(), c = new Parts();
    const crate = makeCrate(), amph = makeAmphora(), barrel = makeBarrelGeo();
    for (const [x, z, s, kind] of [[-0.55, 0.12, 0.42, 0], [-0.55, -0.16, 0.42, 0], [-0.35, 0.0, 0.38, 2],
      [0.55, 0.14, 0.34, 1], [0.62, -0.1, 0.34, 1], [0.48, -0.02, 0.34, 1], [-0.8, 0.0, 0.36, 2]]) {
      const geo = (kind === 0 ? crate : kind === 1 ? amph : barrel).clone();
      (kind === 1 ? c : p).add(geo, null, M(x, 0.36, z, x * 7, s));
    }
    // a bale of cloth lashed on top
    p.add(new THREE.CylinderGeometry(0.09, 0.09, 0.42, 10).rotateX(Math.PI / 2), 0x7d3f8a, M(-0.55, 0.62, 0.0));
    g.add(p.mesh(mat.wood()), c.mesh(mat.plaster()));
  }
  return finish(g, (t) => {
    ship.position.y = Math.sin(t * 1.3) * 0.03;
    ship.rotation.x = Math.sin(t * 1.1 + 1) * 0.03;
    ship.rotation.z = Math.sin(t * 0.9) * 0.02;
  }, opts);
}

/* ── fishing boat ────────────────────────────────────────────────────────── */
export function makeFishingBoat(opts = {}) {
  const g = new THREE.Group();
  const b = caique({ seed: opts.seed ?? 1, hull: opts.hull ?? 0x2f6fae });
  b.position.y = -0.36;                        // waterline (hull y≈0.06) → sea level
  g.add(b);
  const ph = (opts.seed ?? 1) * 1.7;
  return finish(g, (t) => {
    b.position.y = -0.36 + Math.sin(t * 1.6 + ph) * 0.05;
    b.rotation.x = Math.sin(t * 1.3 + ph) * 0.06;
    b.rotation.z = Math.sin(t * 1.1 + ph + 1) * 0.04;
  }, opts);
}

/* ── whirlpool ───────────────────────────────────────────────────────────── */
function spiralTexture() {
  return cached('tex:spiral', () => {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    const img = c.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * 2 - 1, v = (y / S) * 2 - 1;
        const r = Math.hypot(u, v), a = Math.atan2(v, u);
        const arm = Math.sin(a * 4 + Math.log(r + 0.02) * 9);
        const k = smooth(0.35, 1, arm) * smooth(1.0, 0.75, r) * smooth(0.05, 0.25, r);
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(k * 255);
      }
    }
    c.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(cv);
  });
}
/* the eye of the vortex, painted ON the sea: deep blue-black at the heart
   fading out to clear, with darker trough-arms spiralling in (alpha-blended,
   so it darkens the water under it instead of glowing) */
function vortexTexture() {
  return cached('tex:vortex', () => {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    const img = c.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * 2 - 1, v = (y / S) * 2 - 1;
        const r = Math.hypot(u, v), a = Math.atan2(v, u);
        const arm = 0.5 + 0.5 * Math.sin(a * 3 + Math.log(r + 0.02) * 7);
        const core = 1 - smooth(0.0, 0.55, r);
        const k = Math.min(1, core * 1.15 + arm * 0.45 * smooth(1.0, 0.3, r) * smooth(0.02, 0.2, r)) * smooth(1.0, 0.82, r);
        const i = (y * S + x) * 4;
        const deep = smooth(0.5, 0.0, r);
        img.data[i] = Math.round(12 + 20 * (1 - deep));
        img.data[i + 1] = Math.round(34 + 50 * (1 - deep));
        img.data[i + 2] = Math.round(52 + 60 * (1 - deep));
        img.data[i + 3] = Math.round(k * 235);
      }
    }
    c.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}
/* The whirlpool reads as a vortex ON the surface (the ocean is opaque, so
   anything below it is lost): a dark sucking eye, three counter-turning
   layers of spiral foam arms tightening toward it, a churned rim of foam,
   and flotsam spiralling in to the centre. */
export function makeWhirlpool(opts = {}) {
  const r = opts.r ?? 7;
  const g = new THREE.Group();
  const disc = cached('geo:wpdisc', () => new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2));
  const eye = new THREE.Mesh(disc, cached('mat:wpeye', () => new THREE.MeshBasicMaterial({ map: vortexTexture(),
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  eye.scale.setScalar(r * 0.95);
  eye.position.y = -0.2;
  eye.renderOrder = 2;
  g.add(eye);
  const layers = [];
  for (const [k, sp, op, y] of [[1.08, 0.5, 0.7, -0.16], [0.74, 0.95, 0.6, -0.13], [0.44, 1.7, 0.55, -0.1]]) {
    const m = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ color: 0xf2fbff, map: spiralTexture(), transparent: true,
      opacity: op, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.scale.setScalar(r * k);
    m.position.y = y;
    m.renderOrder = 3;
    g.add(m);
    layers.push([m, sp]);
  }
  // the churned rim
  const rim = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ color: 0xeaf8ff, map: tex.ring(), transparent: true,
    opacity: 0.5, depthWrite: false }));
  rim.scale.setScalar(r * 1.15);
  rim.position.y = -0.17;
  rim.renderOrder = 3;
  g.add(rim);
  // flotsam caught in it: planks and a barrel circling inward
  const bits = [];
  const wood = new Parts();
  wood.add(box(1.4, 0.1, 0.28, 0), 0x7d5a38);
  const plankGeo = cached('geo:wpplank', () => wood.geometry());
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(i === 3 ? makeBarrelGeo() : plankGeo, mat.wood());
    if (i === 3) b.scale.setScalar(0.8);
    g.add(b);
    bits.push({ b, ph: i / 4 });
  }
  return finish(g, (t) => {
    for (let i = 0; i < layers.length; i++) layers[i][0].rotation.y = -t * layers[i][1];
    eye.rotation.y = -t * 0.3;
    for (const q of bits) {
      const k = (t * 0.05 + q.ph) % 1;                  // 0 rim → 1 swallowed
      const rr = r * (1 - k) * 0.95, a = -t * (0.4 + k * 1.6) - q.ph * 6.28;
      q.b.position.set(Math.cos(a) * rr, -0.22 - k * k * 0.6, Math.sin(a) * rr);
      q.b.rotation.set(0.15 * Math.sin(t + q.ph * 9), a + Math.PI / 2, k * 0.5);
    }
  }, opts);
}

/* ── fog bank ────────────────────────────────────────────────────────────── */
function puffTexture() {
  return cached('tex:puff', () => {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    const rng = mulberry32(19);
    for (let i = 0; i < 22; i++) {
      const x = S * (0.25 + rng() * 0.5), y = S * (0.3 + rng() * 0.45), rr = S * (0.12 + rng() * 0.18);
      const gr = c.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(255,255,255,0.32)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr; c.fillRect(0, 0, S, S);
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}
export function makeFogBank(opts = {}) {
  const w = opts.w ?? 30, d = opts.d ?? 14, h = opts.h ?? 7;
  const rng = mulberry32(opts.seed ?? 3);
  const g = new THREE.Group();
  const puffs = [];
  const material = new THREE.SpriteMaterial({ map: puffTexture(), color: opts.color ?? 0xe6ecef, transparent: true,
    opacity: opts.opacity ?? 0.75, depthWrite: false });
  const n = Math.round(14 + w * d / 40);
  for (let i = 0; i < n; i++) {
    const sp = new THREE.Sprite(material);
    const x = (rng() - 0.5) * w, z = (rng() - 0.5) * d;
    const s = h * (0.9 + rng() * 0.9) * (1 - 0.35 * Math.abs(x) / w * 2);
    sp.scale.set(s * 1.6, s, 1);
    const y = s * 0.32 + rng() * h * 0.2;
    sp.position.set(x, y, z);
    g.add(sp);
    puffs.push({ sp, x, z, y, ph: rng() * 6.28, sp0: 0.3 + rng() * 0.4 });
  }
  return finish(g, (t) => {
    for (const p of puffs) {
      p.sp.position.x = p.x + Math.sin(t * 0.07 * p.sp0 + p.ph) * 2.2;
      p.sp.position.y = p.y + Math.sin(t * 0.2 + p.ph) * 0.25;
    }
  }, opts);
}

/* ── treasure chest ──────────────────────────────────────────────────────── */
function chestParts(open) {
  return cached('geo:chest:' + open, () => {
    const p = new Parts(), b = new Parts(), au = new Parts();
    p.add(box(1.0, 0.55, 0.62, 0.04), 0x7a4e2a, M(0, 0.275, 0));
    // the barrel-vaulted lid, hinged at the back
    const lid = new THREE.CylinderGeometry(0.31, 0.31, 1.0, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2);   // dome up, axis along x
    // open: swung back ~70° on its hinge at the back top edge
    const hinge = (m) => (open ? new THREE.Matrix4().makeTranslation(0, 0.55, -0.31)
      .multiply(new THREE.Matrix4().makeRotationX(-1.2)).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.31)).multiply(m)
      : new THREE.Matrix4().makeTranslation(0, 0.55, 0).multiply(m));
    const lidM = hinge(new THREE.Matrix4());
    p.add(lid, 0x84552e, lidM);
    p.add(box(1.0, 0.03, 0.62, 0.01), 0x5a3a20, hinge(new THREE.Matrix4().makeTranslation(0, 0.015, 0)));
    for (const x of [-0.38, 0, 0.38]) {
      b.add(box(0.07, 0.57, 0.66, 0.01), 0x9a7a3a, M(x, 0.28, 0));
      const band = new THREE.TorusGeometry(0.32, 0.03, 4, 14, Math.PI).rotateY(Math.PI / 2);
      b.add(band, 0x9a7a3a, hinge(new THREE.Matrix4().makeTranslation(x, 0, 0)));
    }
    b.add(box(0.14, 0.18, 0.06, 0.01), 0xc9a24a, M(0, 0.5, 0.33));
    if (open) {
      // a heap of coin and a few goblets
      au.add(blob(0.42, 2, 0.32), 0xf2c04a, M(0, 0.5, 0, 0, 1.1, 1, 0.68));
      au.add(lathe([[0.0, 0], [0.08, 0], [0.03, 0.04], [0.03, 0.14], [0.1, 0.2], [0.11, 0.3], [0.0, 0.24]], 10), 0xe8b84a, M(0.25, 0.58, 0.1, 0, 1, 1, 1, 0.3));
      for (let i = 0; i < 6; i++) au.add(new THREE.CylinderGeometry(0.06, 0.06, 0.015, 10), 0xf6c850, M(-0.5 + i * 0.2, 0.01, 0.42 + (i % 2) * 0.1, 0, 1, 1, 1, 0.2 * i, 0.1));
    }
    return { wood: p.geometry(), bronze: b.geometry(), gold: open ? au.geometry() : null };
  });
}
export function makeTreasureChest(opts = {}) {
  const open = opts.open !== false;
  const g = new THREE.Group();
  const parts = chestParts(open);
  for (const [geo, m] of [[parts.wood, mat.wood()], [parts.bronze, mat.bronze()], [parts.gold, mat.gold()]]) {
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh);
  }
  if (!open) return g;
  const gl = glowSprite(0xffd060, 1.6, 0.5);
  gl.position.y = 0.75;
  g.add(gl);
  return finish(g, (t) => { gl.material.opacity = 0.4 + 0.2 * Math.sin(t * 2.3); }, opts);
}

/* ── surfacing wreck ─────────────────────────────────────────────────────── */
export function makeWreck(opts = {}) {
  const g = new THREE.Group();
  const rng = mulberry32(opts.seed ?? 7);
  const inner = new THREE.Group();
  g.add(inner);
  const p = new Parts();
  // a broken hull: a caique hull ×3, its bow half drowned, ribs standing proud
  const boat = caique({ hull: 0x5a4a3a });
  boat.traverse((o) => { if (o.isMesh) p.add(o.geometry.clone(), null, M(0, 0, 0, 0, 3)); });
  for (let i = 0; i < 6; i++) {
    const x = -2.4 + i * 0.6;
    p.add(tube([new THREE.Vector3(x, 0.2, -1.6), new THREE.Vector3(x, 1.5, -1.9), new THREE.Vector3(x, 2.1, -1.5)], 0.08, 0.05, 5, 5), 0x4a3a2a);
  }
  p.add(new THREE.CylinderGeometry(0.1, 0.14, 3.2, 7), 0x4a3a2a, M(0.6, 1.8, 0.1, 0, 1, 1, 1, 0.5, -0.35));
  const hull = p.mesh(mat.wood());
  inner.add(hull);
  inner.rotation.set(0.28, 0.4, -0.32);
  inner.position.y = -0.9;
  // seaweed rags and a barnacled rock
  const rk = new THREE.Mesh(rockGeometry(17, { r: 1.2, sy: 0.6, rock: 0x5d6a62, top: 0x3f6a3a, cover: 0.6, detail: 1 }), mat.rock());
  rk.position.set(2.2, -0.5, 1.2);
  g.add(rk);
  const chest = makeTreasureChest({ open: true, auto: false });
  chest.position.set(-0.6, 0.35, 0.6);
  chest.rotation.set(0.1, 0.5, 0.15);
  g.add(chest);
  const glint = glowSprite(0xfff0b0, 2.2, 0.7);
  glint.position.set(-0.6, 1.2, 0.6);
  g.add(glint);
  const ph = rng() * 6;
  return finish(g, (t) => {
    inner.position.y = -0.9 + Math.sin(t * 0.8 + ph) * 0.06;
    const tw = Math.max(0, Math.sin(t * 3.1 + ph)) * Math.max(0, Math.sin(t * 1.7));
    glint.material.opacity = 0.35 + 0.65 * tw;
    glint.scale.setScalar(1.6 + tw * 1.4);
    chest.userData.update?.(t);
  }, opts);
}

/* ── festival pavilion ───────────────────────────────────────────────────── */
export function makeFestivalPavilion(opts = {}) {
  const g = new THREE.Group();
  const hue = new THREE.Color(opts.hue ?? 0xc8402e);
  const cloth = new Parts(), wood = new Parts(), flags = new Parts();
  // an octagonal canopy with a scalloped valance, on eight posts
  const R = 2.6, H = 2.6;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    wood.add(new THREE.CylinderGeometry(0.06, 0.07, H, 6), 0xe9dcc0, M(Math.cos(a) * R, H / 2, Math.sin(a) * R));
  }
  const canopy = lathe([[R + 0.25, 0], [R * 0.8, 0.45], [R * 0.4, 1.05], [0.12, 1.55], [0.0, 1.6]], 32);
  const cp = canopy.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const a = Math.atan2(cp.getZ(i), cp.getX(i));
    const sag = 0.12 * Math.abs(Math.sin(a * 4)) * (1 - cp.getY(i) / 1.6);
    cp.setY(i, cp.getY(i) - sag);
  }
  canopy.computeVertexNormals();
  cloth.add(canopy, (x, y, z, nx, ny, nz, c) => {
    const a = Math.atan2(z, x);
    c.copy(Math.floor((a / (Math.PI * 2) + 0.5) * 16) % 2 ? hue : new THREE.Color(0xf1e8d4));
  }, M(0, H, 0));
  const val = lathe([[R + 0.25, 0], [R + 0.25, -0.4]], 48);
  const vp = val.attributes.position;
  for (let i = 0; i < vp.count; i++) {
    if (vp.getY(i) < -0.2) {
      const a = Math.atan2(vp.getZ(i), vp.getX(i));
      vp.setY(i, -0.4 + Math.abs(Math.sin(a * 12)) * 0.18);
    }
  }
  val.computeVertexNormals();
  cloth.add(val, 0xd9a441, M(0, H, 0));
  wood.add(lathe([[0.1, 0], [0.05, 0.5], [0.0, 0.6]], 8), 0xd9a441, M(0, H + 1.55, 0));
  // a long pennant from the finial
  const pen = new THREE.PlaneGeometry(1.4, 0.3, 6, 1);
  const pp = pen.attributes.position;
  for (let i = 0; i < pp.count; i++) pp.setY(i, pp.getY(i) * (1 - (pp.getX(i) + 0.7) / 1.8));
  pen.translate(0.7, 0, 0);
  const pennant = new THREE.Mesh(pen, new THREE.MeshStandardMaterial({ color: hue, side: THREE.DoubleSide, roughness: 0.9 }));
  pennant.position.set(0, H + 2.0, 0);
  // garlands: catenaries of little flags between the posts and two outer masts
  const masts = [[-5.5, 0], [5.5, 0]];
  for (const [mx, mz] of masts) wood.add(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6), 0xe9dcc0, M(mx, 2.1, mz));
  const flagColors = [0xc8402e, 0xd9a441, 0x2f6fae, 0x3f9a58, 0xf1e8d4];
  const lanterns = [];
  const line = (ax, ay, az, bx, by, bz, sag, nFlags) => {
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      pts.push(new THREE.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(t * Math.PI) * sag, az + (bz - az) * t));
    }
    wood.add(tube(pts, 0.015, 0.015, 12, 3), 0x5a4a3a);
    const curve = new THREE.CatmullRomCurve3(pts);
    for (let k = 1; k < nFlags; k++) {
      const q = curve.getPointAt(k / nFlags);
      const tri = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.13, 0, 0), new THREE.Vector3(0.13, 0, 0), new THREE.Vector3(0, -0.32, 0)]);
      tri.computeVertexNormals();
      const ang = Math.atan2(bz - az, bx - ax);
      flags.add(tri, flagColors[k % flagColors.length], M(q.x, q.y, q.z, -ang));
      if (k % 3 === 0) lanterns.push(q.clone());
    }
  };
  for (const [mx, mz] of masts) {
    const s = Math.sign(mx);
    line(mx, 4.0, mz, s * R, H + 0.1, 0.9, 0.5, 9);
    line(mx, 4.0, mz, s * R, H + 0.1, -0.9, 0.5, 9);
  }
  g.add(cloth.mesh(mat.cloth()), wood.mesh(mat.wood()), flags.mesh(mat.cloth(), { cast: false }), pennant);
  // paper lanterns glowing warm along the garlands
  const lampGeo = cached('geo:lantern', () => blob(0.16, 1, 1.25));
  const lamps = [];
  for (const q of lanterns) {
    const l = new THREE.Mesh(lampGeo, mat.glow(0xffb050, 2.6));
    l.position.set(q.x, q.y - 0.32, q.z);
    g.add(l);
    lamps.push(l);
  }
  const tableTop = new THREE.Mesh(cached('geo:festtable', () => {
    const p = new Parts();
    p.add(lathe([[1.0, 0.72], [1.0, 0.78], [0.0, 0.78]], 24), 0xa77a4c);
    p.add(new THREE.CylinderGeometry(0.08, 0.14, 0.72, 8), 0x7a5634, M(0, 0.36, 0));
    p.add(makeAmphora().clone(), null, M(0.3, 0.78, 0.1, 0, 0.5));
    p.add(blob(0.12, 1), 0x6d2f6a, M(-0.3, 0.86, 0.1));
    p.add(blob(0.12, 1), 0x6d2f6a, M(-0.2, 0.86, -0.12));
    p.add(blob(0.1, 1), 0xd8902a, M(-0.05, 0.85, 0.25));
    return p.geometry();
  }), mat.wood());
  tableTop.castShadow = true;
  g.add(tableTop);
  return finish(g, (t) => {
    pennant.rotation.y = Math.sin(t * 1.3) * 0.4;
    pennant.rotation.x = Math.sin(t * 2.7) * 0.15;
    for (let i = 0; i < lamps.length; i++) lamps[i].scale.setScalar(1 + Math.sin(t * 2.3 + i * 1.7) * 0.06);
  }, opts);
}

/* ── signal fire ─────────────────────────────────────────────────────────── */
export function makeSignalFire(opts = {}) {
  const g = new THREE.Group();
  const p = new Parts(), w = new Parts();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2, r = i % 2 ? 1.0 : 0.9;
    p.add(rockGeometry(31 + i, { r: 0.42, sy: 0.75, detail: 1, rock: 0x8d877c }), null, M(Math.cos(a) * r, 0.15, Math.sin(a) * r, a));
  }
  p.add(rockGeometry(57, { r: 0.85, sy: 0.55, detail: 2, rock: 0x8d877c }), null, M(0, 0.2, 0));
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    w.add(tube([new THREE.Vector3(Math.cos(a) * 0.75, 0.5, Math.sin(a) * 0.75), new THREE.Vector3(Math.cos(a) * 0.12, 1.9, Math.sin(a) * 0.12)],
      0.07, 0.05, 2, 5), (x, y, z, nx, ny, nz, c) => { c.setHex(y > 1.2 ? 0x241a12 : 0x6a4a2c); });
  }
  g.add(p.mesh(mat.rock()), w.mesh(mat.wood()));
  const f = flame({ w: 1.7, h: 3.0, color: opts.color ?? 0xff8a30, glow: 1.4, seed: 5, halo: 0.6 });
  f.position.y = 0.7;
  g.add(f);
  // a column of smoke
  const smoke = [];
  const sm = new THREE.SpriteMaterial({ map: softDiscTexture(), color: 0x4a4440, transparent: true, opacity: 0.35, depthWrite: false });
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Sprite(sm);
    g.add(s);
    smoke.push(s);
  }
  return finish(g, (t) => {
    for (let i = 0; i < smoke.length; i++) {
      const k = ((t * 0.18 + i / smoke.length) % 1);
      smoke[i].position.set(Math.sin(t * 0.4 + i) * 0.4 + k * 1.2, 3.2 + k * 7, Math.cos(t * 0.3 + i) * 0.3);
      smoke[i].scale.setScalar(1.2 + k * 3.5);
    }
    sm.opacity = 0.32;
  }, opts);
}

/* ── message bottle ──────────────────────────────────────────────────────── */
export function makeMessageBottle(opts = {}) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  g.add(inner);
  const glass = new THREE.Mesh(cached('geo:bottle', () => lathe([[0.0, 0], [0.16, 0], [0.18, 0.04], [0.18, 0.4], [0.12, 0.52],
    [0.06, 0.6], [0.055, 0.75], [0.07, 0.78], [0.0, 0.78]], 16)),
  cached('mat:bottleglass', () => new THREE.MeshStandardMaterial({ color: 0x2f7a52, roughness: 0.08, metalness: 0,
    transparent: true, opacity: 0.55, depthWrite: false })));
  const scroll = new THREE.Mesh(cached('geo:bottlescroll', () => new THREE.CylinderGeometry(0.07, 0.07, 0.36, 10)), mat.plain());
  scroll.material = cached('mat:parch', () => new THREE.MeshStandardMaterial({ color: 0xe8d8a8, roughness: 0.9 }));
  scroll.position.y = 0.24;
  const cork = new THREE.Mesh(cached('geo:cork', () => new THREE.CylinderGeometry(0.06, 0.05, 0.1, 8)),
    cached('mat:cork', () => new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.9 })));
  cork.position.y = 0.8;
  const holder = new THREE.Group();
  holder.add(scroll, glass, cork);
  holder.rotation.z = Math.PI / 2 - 0.35;
  holder.position.y = -0.25;
  holder.scale.setScalar(opts.scale ?? 1.6);
  inner.add(holder);
  const glint = glowSprite(0xffffff, 0.8, 0.5);
  glint.position.set(0.2, 0.0, 0);
  inner.add(glint);
  return finish(g, (t) => {
    inner.position.y = Math.sin(t * 1.7) * 0.07;
    inner.rotation.x = Math.sin(t * 1.3) * 0.25;
    inner.rotation.y = t * 0.15;
    glint.material.opacity = 0.2 + 0.5 * Math.max(0, Math.sin(t * 2.9));
  }, opts);
}

/* ── dolphin ─────────────────────────────────────────────────────────────── */
function dolphinGeo() {
  return cached('geo:dolphin', () => {
    // a lofted body along +x: elliptical sections, beak, melon
    const NX = 22, NR = 12;
    const pos = [], idx = [];
    const prof = (u) => {
      // u 0 tail → 1 beak tip: radius and centre height
      const r = 0.06 + 0.3 * Math.pow(Math.sin(Math.min(1, u * 1.05) * Math.PI * 0.92), 1.2) * (u < 0.85 ? 1 : 1 - (u - 0.85) * 4.5);
      const yc = 0.02 * Math.sin(u * Math.PI) + (u > 0.82 ? -0.04 : 0);
      return [Math.max(0.025, r), yc];
    };
    for (let i = 0; i <= NX; i++) {
      const u = i / NX, x = -1.0 + u * 2.0;
      const [r, yc] = prof(u);
      for (let j = 0; j <= NR; j++) {
        const a = (j / NR) * Math.PI * 2;
        pos.push(x, yc + Math.sin(a) * r * 0.95, Math.cos(a) * r * 0.82);
      }
    }
    for (let i = 0; i < NX; i++) {
      for (let j = 0; j < NR; j++) {
        const a = i * (NR + 1) + j, b = a + 1, c = a + NR + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    let body = new THREE.BufferGeometry();
    body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    body.setIndex(idx);
    body.computeVertexNormals();
    const p = new Parts();
    p.add(body, (x, y, z, nx, ny, nz, c) => {
      c.setHex(0x55697a);
      c.lerp(new THREE.Color(0xd9e2e6), smooth(0.1, -0.6, ny));
      if (x > 0.78 && Math.abs(z) > 0.1 && y > 0.04 && y < 0.1) c.setHex(0x1a1f24);
    });
    // dorsal fin, flukes, flippers
    const fin = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.15, 0.25, 0), new THREE.Vector3(0.2, 0.26, 0), new THREE.Vector3(-0.22, 0.55, 0)]);
    p.add(fin, 0x4a5d6e);
    const fluke = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.95, 0, 0), new THREE.Vector3(-1.25, 0, 0.36), new THREE.Vector3(-1.12, 0, 0),
      new THREE.Vector3(-0.95, 0, 0), new THREE.Vector3(-1.12, 0, 0), new THREE.Vector3(-1.25, 0, -0.36)]);
    p.add(fluke, 0x4a5d6e);
    for (const s of [-1, 1]) {
      const fl = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.35, -0.12, s * 0.2), new THREE.Vector3(0.15, -0.14, s * 0.22), new THREE.Vector3(0.05, -0.24, s * 0.42)]);
      p.add(fl, 0x55697a);
    }
    return p.geometry();
  });
}
export function makeDolphin(opts = {}) {
  const r = opts.r ?? 6;
  const g = new THREE.Group();
  const body = new THREE.Mesh(dolphinGeo(), cached('mat:dolphin', () => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.28, metalness: 0, side: THREE.DoubleSide })));
  body.castShadow = true;
  body.scale.setScalar(opts.scale ?? 1.1);
  g.add(body);
  const ph = (opts.seed ?? 1) * 2.3;
  const PERIOD = 3.2;
  return finish(g, (t) => {
    // swims round a circle; every PERIOD it breaks the surface in a leaping arc
    const a = t * 0.35 + ph;
    const k = ((t + ph) % PERIOD) / PERIOD;          // 0..1 through one leap cycle
    // between leaps it porpoises along the surface (back and dorsal fin out,
    // a gentle roll up and under) instead of vanishing below the opaque sea
    const leap = k < 0.42 ? Math.sin((k / 0.42) * Math.PI) : 0;
    const roll = k >= 0.42 ? Math.sin(((k - 0.42) / 0.58) * Math.PI * 2) : 0;
    const y = -0.42 + leap * 2.4 + roll * 0.12;
    body.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    body.rotation.set(0, -a - Math.PI / 2, 0);
    // pitch follows the arc: nose up rising, down falling
    const pitch = k < 0.42 ? Math.cos((k / 0.42) * Math.PI) * 0.75 : -roll * 0.12;
    body.rotateZ(pitch);
  }, opts);
}

/* ── gull ────────────────────────────────────────────────────────────────── */
function gullParts() {
  return cached('geo:gull', () => {
    const b = new Parts(), wing = new Parts();
    b.add(blob(0.12, 2, 1), 0xf2f2ee, M(0, 0, 0, 0, 2.2, 1, 1));
    b.add(blob(0.08, 1), 0xf2f2ee, M(0.24, 0.05, 0));
    b.add(new THREE.ConeGeometry(0.025, 0.12, 6).rotateZ(-Math.PI / 2), 0xe8b030, M(0.34, 0.04, 0));
    b.add(new THREE.ConeGeometry(0.07, 0.2, 4).rotateZ(Math.PI / 2), 0xe6e6e2, M(-0.3, 0.0, 0, 0, 1, 0.3, 1));
    // one wing (left, +z); the right is a mirrored mesh
    const w = new THREE.BufferGeometry();
    const P = [0.08, 0, 0, -0.1, 0, 0, -0.12, 0.0, 0.42, 0.04, 0.02, 0.4, -0.2, -0.02, 0.8, -0.08, -0.03, 0.78];
    w.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    w.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]);
    w.computeVertexNormals();
    wing.add(w, (x, y, z, nx, ny, nz, c) => { c.setHex(z > 0.6 ? 0x2a2a2a : 0xb7bcc2); });
    return { body: b.geometry(), wing: wing.geometry() };
  });
}
export function makeGull(opts = {}) {
  const r = opts.r ?? 5, h = opts.h ?? 6;
  const g = new THREE.Group();
  const parts = gullParts();
  const bird = new THREE.Group();
  const m = cached('mat:gull', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  const body = new THREE.Mesh(parts.body, m);
  const wl = new THREE.Mesh(parts.wing, m);
  const wr = new THREE.Mesh(parts.wing, m);
  wr.scale.z = -1;
  bird.add(body, wl, wr);
  bird.scale.setScalar(opts.scale ?? 1.2);
  g.add(bird);
  const ph = (opts.seed ?? 1) * 1.9;
  return finish(g, (t) => {
    const a = t * 0.4 + ph;
    bird.position.set(Math.cos(a) * r, h + Math.sin(t * 0.7 + ph) * 0.5, Math.sin(a) * r);
    bird.rotation.set(0.35, -a - Math.PI / 2, 0);     // banked into the turn
    const flapping = Math.sin(t * 0.5 + ph) > 0.3;
    const f = flapping ? Math.sin(t * 9 + ph) * 0.55 : 0.12 + Math.sin(t * 1.3) * 0.05;
    wl.rotation.x = -f;
    wr.rotation.x = f;
  }, opts);
}

/* ── goat ────────────────────────────────────────────────────────────────── */
function goatParts(coat) {
  return cached('geo:goat:' + coat, () => {
    const c0 = new THREE.Color(coat), belly = c0.clone().lerp(new THREE.Color(0xf2ece0), 0.4);
    const fur = (x, y, z, nx, ny, nz, c) => { c.copy(c0).lerp(belly, smooth(0.0, -0.8, ny) * 0.8); };
    const b = new Parts(), head = new Parts(), leg = new Parts();
    b.add(blob(0.3, 2), fur, M(0, 0.62, 0, 0, 1.55, 0.95, 0.8));
    b.add(blob(0.16, 1), fur, M(0.36, 0.78, 0, 0, 1.2, 1.3, 1, 0, -0.6));       // neck
    b.add(new THREE.ConeGeometry(0.07, 0.18, 6), c0, M(-0.48, 0.74, 0, 0, 1, 1, 1, 0, 1.0));   // tail
    // head (pivot at the neck top), muzzle, ears, horns, beard
    head.add(blob(0.13, 2), fur, M(0.08, 0, 0, 0, 1.35, 1, 0.85));
    head.add(blob(0.08, 1), c0.clone().multiplyScalar(0.85), M(0.22, -0.05, 0, 0, 1.2, 0.9, 0.9));
    head.add(new THREE.SphereGeometry(0.018, 6, 4), 0x1a1612, M(0.12, 0.05, 0.085));
    head.add(new THREE.SphereGeometry(0.018, 6, 4), 0x1a1612, M(0.12, 0.05, -0.085));
    for (const s of [-1, 1]) {
      head.add(tube([new THREE.Vector3(0.04, 0.09, s * 0.05), new THREE.Vector3(-0.04, 0.22, s * 0.08),
        new THREE.Vector3(-0.16, 0.24, s * 0.12), new THREE.Vector3(-0.2, 0.14, s * 0.13)], 0.032, 0.01, 8, 5), 0x8a7a5a);
      head.add(new THREE.ConeGeometry(0.04, 0.14, 5).rotateZ(Math.PI / 2 + 0.3), c0, M(-0.02, 0.06, s * 0.12, s * 0.6));
    }
    head.add(new THREE.ConeGeometry(0.035, 0.12, 5).rotateX(Math.PI), 0xd8d0c0, M(0.2, -0.15, 0));
    // one leg (hip pivot at y=0)
    leg.add(tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.01, -0.22, 0), new THREE.Vector3(-0.01, -0.46, 0)], 0.05, 0.03, 4, 6), c0);
    leg.add(new THREE.CylinderGeometry(0.03, 0.035, 0.06, 6), 0x2a2420, M(-0.01, -0.48, 0));
    return { body: b.geometry(), head: head.geometry(), leg: leg.geometry() };
  });
}
export function makeGoat(opts = {}) {
  const g = new THREE.Group();
  const parts = goatParts(opts.coat ?? 0xd8cdb8);
  const m = mat.plain();
  const body = new THREE.Mesh(parts.body, m);
  body.castShadow = true;
  const head = new THREE.Mesh(parts.head, m);
  head.castShadow = true;
  head.position.set(0.48, 0.92, 0);
  const legs = [];
  for (const [x, z] of [[0.3, 0.12], [0.3, -0.12], [-0.3, 0.12], [-0.3, -0.12]]) {
    const l = new THREE.Mesh(parts.leg, m);
    l.position.set(x, 0.5, z);
    l.castShadow = true;
    legs.push(l);
  }
  g.add(body, head, ...legs);
  g.scale.setScalar(opts.scale ?? 1.25);
  const ph = (opts.seed ?? 1) * 1.3;
  return finish(g, (t) => {
    // grazes: head dips to the grass, chews, looks up now and then
    const graze = smooth(-0.2, 0.4, Math.sin(t * 0.45 + ph));
    head.rotation.z = -graze * 1.05 + Math.sin(t * 7 + ph) * 0.03 * graze;
    head.position.y = 0.92 - graze * 0.2;
    head.rotation.y = (1 - graze) * Math.sin(t * 0.8 + ph) * 0.4;
    body.rotation.z = Math.sin(t * 2.1 + ph) * 0.01;
  }, opts);
}

/* ── the satyr's dice table ──────────────────────────────────────────────── */
function dieTexture() {
  return cached('tex:die', () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = '#efe6d2'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#2a1a14';
    for (const [x, y] of [[16, 16], [48, 48], [32, 32], [48, 16], [16, 48]]) { c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill(); }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}
export function makeDiceTable(opts = {}) {
  const g = new THREE.Group();
  const p = new Parts(), cer = new Parts();
  p.add(lathe([[0.95, 0.78], [0.95, 0.86], [0.88, 0.9], [0.0, 0.9]], 24), 0x8a5a34);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    p.add(tube([new THREE.Vector3(Math.cos(a) * 0.55, 0.8, Math.sin(a) * 0.55), new THREE.Vector3(Math.cos(a) * 0.62, 0.4, Math.sin(a) * 0.62),
      new THREE.Vector3(Math.cos(a) * 0.72, 0.0, Math.sin(a) * 0.72)], 0.05, 0.04, 6, 6), 0x6a4528);
  }
  for (const [x, z] of [[1.35, 0.2], [-1.25, -0.4]]) {
    p.add(lathe([[0.32, 0.42], [0.32, 0.48], [0.0, 0.48]], 14), 0x7a5634, M(x, 0, z));
    p.add(new THREE.CylinderGeometry(0.08, 0.12, 0.42, 8), 0x6a4528, M(x, 0.21, z));
  }
  // a leather dice cup lying on its side, a wine krater, a goatskin
  p.add(lathe([[0.0, 0], [0.11, 0], [0.13, 0.22], [0.12, 0.22], [0.1, 0.02], [0.0, 0.02]], 12), 0x4a2e1c,
    M(-0.35, 0.99, 0.2, 0.7, 1, 1, 1, 0, Math.PI / 2));
  cer.add(lathe([[0.0, 0], [0.12, 0], [0.08, 0.06], [0.2, 0.2], [0.26, 0.36], [0.28, 0.42], [0.0, 0.4]], 16), (x, y, z, nx, ny, nz, c) => {
    c.setHex(y > 1.2 && y < 1.26 ? 0x1a1210 : 0xb8643c);
  }, M(0.45, 0.9, -0.25));
  cer.add(blob(0.25, 1, 0.55), 0x8a6a4a, M(1.2, 0.52, -0.6, 0.4, 1.4, 1, 1));
  g.add(p.mesh(mat.wood()), cer.mesh(mat.plaster()));
  const dieGeo = cached('geo:die', () => box(0.12, 0.12, 0.12, 0.018, 1));
  const dieMat = cached('mat:die', () => new THREE.MeshStandardMaterial({ map: dieTexture(), roughness: 0.4 }));
  const dice = [];
  for (const [x, z] of [[0.05, 0.15], [0.22, 0.05], [-0.1, -0.12]]) {
    const d = new THREE.Mesh(dieGeo, dieMat);
    d.position.set(x, 0.96, z);
    d.castShadow = true;
    g.add(d);
    dice.push({ d, x, z });
  }
  return finish(g, (t) => {
    // every few seconds the dice tumble across the board
    const k = (t % 4.0) / 4.0;
    for (let i = 0; i < dice.length; i++) {
      const o = dice[i];
      if (k < 0.18) {
        const q = k / 0.18;
        o.d.position.set(o.x - 0.3 * (1 - q), 0.96 + Math.abs(Math.sin(q * Math.PI * 2)) * 0.12 * (1 - q), o.z);
        o.d.rotation.set(q * 9 + i, q * 6 + i * 2, q * 7);
      } else {
        o.d.position.set(o.x, 0.96, o.z);
        o.d.rotation.set(Math.round((9 + i) / (Math.PI / 2)) * Math.PI / 2, (6 + i * 2), Math.round(7 / (Math.PI / 2)) * Math.PI / 2);
      }
    }
  }, opts);
}

/* ── the philosopher's barrel (Diogenes' pithos) ─────────────────────────── */
export function makePhilosopherBarrel(opts = {}) {
  const g = new THREE.Group();
  const cer = new Parts(), misc = new Parts();
  // a great storage jar on its side, mouth toward +x, wedged with stones
  const jar = lathe([[0.0, 0], [0.3, 0], [0.62, 0.3], [0.78, 0.8], [0.74, 1.3], [0.52, 1.66], [0.4, 1.74], [0.46, 1.8],
    [0.44, 1.86], [0.36, 1.84], [0.34, 1.7], [0.3, 1.6]], 24);
  cer.add(jar, (x, y, z, nx, ny, nz, c) => {
    c.setHex(0xb8714a);
    if (Math.abs(y - 0.95) < 0.05 || Math.abs(y - 1.25) < 0.04) c.setHex(0x8a4a2e);   // incised bands
  }, M(-0.9, 0.78, 0, 0, 1, 1, 1, 0, -Math.PI / 2), 0, true);
  for (const z of [-0.6, 0.6]) {
    misc.add(rockGeometry(71 + z * 10, { r: 0.28, sy: 0.7, detail: 1, rock: 0x8d877c }), null, M(-0.2, 0.1, z));
  }
  // a straw mat, a clay lamp with its flame, a scroll and a cup
  misc.add(box(1.1, 0.03, 0.8, 0.01), 0xc9a86a, M(1.35, 0.015, 0.1));
  cer.add(lathe([[0.0, 0], [0.1, 0], [0.12, 0.05], [0.08, 0.08], [0.0, 0.08]], 12), 0xa8603c, M(1.15, 0.03, -0.2, 0, 1.4, 1, 1));
  misc.add(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 10).rotateX(Math.PI / 2), 0xe8d8a8, M(1.5, 0.09, 0.3, 0.4));
  cer.add(lathe([[0.0, 0], [0.06, 0], [0.04, 0.03], [0.1, 0.1], [0.0, 0.08]], 10), 0xb8643c, M(1.65, 0.03, -0.15));
  g.add(cer.mesh(mat.plaster()), misc.mesh(mat.rock()));
  const f = flame({ w: 0.16, h: 0.26, seed: 9, halo: 0.6 });
  f.position.set(1.3, 0.11, -0.2);
  g.add(f);
  return g;
}

export const EVENT_PROPS = {
  merchant: makeMerchantShip, fishing: makeFishingBoat, whirlpool: makeWhirlpool, fog: makeFogBank,
  wreck: makeWreck, festival: makeFestivalPavilion, signal: makeSignalFire, chest: makeTreasureChest,
  bottle: makeMessageBottle, dolphin: makeDolphin, gull: makeGull, goat: makeGoat, dice: makeDiceTable,
  barrel: makePhilosopherBarrel,
};

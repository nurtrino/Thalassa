/*
 * models/props.js — small procedural props used all over the map, and the
 * board's UI markers. (GLB props live in static/props.js; this is the
 * procedural set that replaces the old flat-shaded primitives.)
 *
 *   makeRock(rng, r, colorHex, {moss, snow, sea}) → Mesh   one good boulder
 *   makeRockCluster(rng, r, colorHex, opts)       → Mesh   2–4 merged boulders
 *   makeFishingBoat({seed, hull, sail})           → Group  small caique (+x bow)
 *   makeCrate() / makeAmphora() / makeBarrelGeo() → BufferGeometry (cached,
 *                                                   vertex-coloured; clone it)
 *   makeFlotsam(rng)                              → Group 'bob' (salvage raft)
 *   makeTurnMarker()                              → Mesh 'turnMarker' (scene.js
 *                                                   disposes geometry+material:
 *                                                   both are shared, safe)
 *   makeReachBeacon(nid, x, z, rr)                → [ring, halo, beam, chev, disc]
 *                                                   (roles as scene.js ticks them)
 *   makeSeaLane(ax, az, bx, bz, {seed})           → Mesh  soft wake-dash lane
 *   makeFootTrail(ax, az, bx, bz, {hex, seed})    → Mesh  merged flagstone path
 */
import { THREE, cached, mat, tex, Parts, M, paint, lathe, box, tube, blob, rockGeometry, glowSprite, smooth, mulberry32 } from './kit.js';
import { softDiscTexture } from '../util.js';

/* ── rocks ──────────────────────────────────────────────────────────────── */
export function makeRock(rng, r, colorHex = 0x93999e, { moss = false, snow = false, sand = false, detail = 2 } = {}) {
  const top = snow ? 0xf4f8fb : moss ? 0x5f7f3a : sand ? 0xe2cf9e : null;
  const geo = rockGeometry(Math.floor(rng() * 1e9), {
    r, sy: 0.6 + rng() * 0.3, detail, rock: colorHex, top,
    cover: top ? 0.75 : 0, strata: 0.6, base: -0.3,
  });
  const m = new THREE.Mesh(geo, mat.rock());
  m.castShadow = true; m.receiveShadow = true;
  m.rotation.y = rng() * 6.28;
  return m;
}

export function makeRockCluster(rng, r, colorHex = 0x93999e, opts = {}) {
  const p = new Parts();
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const rr = r * (i === 0 ? 1 : 0.4 + rng() * 0.35);
    const a = rng() * 6.28, d = i === 0 ? 0 : r * (0.7 + rng() * 0.5);
    const top = opts.snow ? 0xf4f8fb : opts.moss ? 0x5f7f3a : null;
    p.add(rockGeometry(Math.floor(rng() * 1e9), { r: rr, sy: 0.55 + rng() * 0.4, rock: colorHex, top,
      cover: top ? 0.7 : 0, detail: i === 0 ? 2 : 1, strata: 0.6 }), null, M(Math.cos(a) * d, 0, Math.sin(a) * d, rng() * 6));
  }
  return p.mesh(mat.rock());
}

/* ── stores ─────────────────────────────────────────────────────────────── */
export function makeCrate() {
  return cached('geo:crate', () => {
    const p = new Parts();
    p.add(box(0.6, 0.5, 0.6, 0.02), 0x9a7046, M(0, 0.25, 0));
    for (const s of [-1, 1]) {
      for (const [w, d, x, z] of [[0.64, 0.06, 0, s * 0.3], [0.06, 0.64, s * 0.3, 0]]) {
        p.add(box(w, 0.07, d, 0.01), 0x6b4a2c, M(x, 0.07, z));
        p.add(box(w, 0.07, d, 0.01), 0x6b4a2c, M(x, 0.46, z));
      }
    }
    // a diagonal brace on two faces
    p.add(box(0.06, 0.62, 0.03, 0.01), 0x6b4a2c, M(0, 0.25, 0.305, 0, 1, 1, 1, 0, 0.72));
    p.add(box(0.03, 0.62, 0.06, 0.01), 0x6b4a2c, M(0.305, 0.25, 0, 0, 1, 1, 1, 0.72, 0));
    return p.geometry();
  });
}

export function makeAmphora() {
  return cached('geo:amphora', () => {
    const p = new Parts();
    p.add(lathe([[0.0, 0.0], [0.05, 0.0], [0.08, 0.08], [0.2, 0.3], [0.24, 0.48], [0.2, 0.66], [0.09, 0.78],
      [0.075, 0.92], [0.11, 0.96], [0.1, 0.99], [0.0, 0.97]], 14), (x, y, z, nx, ny, nz, c) => {
      c.setHex(0xa9643f);
      if (y > 0.5 && y < 0.6) c.setHex(0x2a1a14);             // a painted black band
      c.multiplyScalar(0.85 + 0.15 * smooth(0, 0.6, y));
    });
    for (const s of [-1, 1]) {
      p.add(tube([new THREE.Vector3(s * 0.07, 0.9, 0), new THREE.Vector3(s * 0.2, 0.88, 0), new THREE.Vector3(s * 0.17, 0.68, 0)],
        0.02, 0.02, 6, 5), 0x9f5c3a);
    }
    return p.geometry();
  });
}

export function makeBarrelGeo() {
  return cached('geo:barrel', () => {
    const p = new Parts();
    p.add(lathe([[0.0, 0.0], [0.24, 0.0], [0.27, 0.12], [0.3, 0.35], [0.27, 0.58], [0.24, 0.7], [0.0, 0.7]], 16),
      (x, y, z, nx, ny, nz, c) => {
        const band = Math.abs(y - 0.12) < 0.03 || Math.abs(y - 0.58) < 0.03 || Math.abs(y - 0.3) < 0.02;
        c.setHex(band ? 0x3a3330 : 0x8f6440);
        if (!band) c.multiplyScalar(0.9 + 0.1 * Math.sin(Math.atan2(z, x) * 14));
      });
    return p.geometry();
  });
}

/* ── the fishing caique ─────────────────────────────────────────────────── */
function caiqueHull(L, B, H, D) {
  const NU = 18, NS = 12;
  const pos = [], col = [], idx = [];
  const W = NS + 1;
  for (let i = 0; i <= NU; i++) {
    const u = i / NU, t = 2 * u - 1;
    const x = (u - 0.5) * L;
    const w = B * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), t > 0 ? 2.0 : 2.6)), 0.62) + 0.01;
    const h = H + 0.22 * Math.pow(Math.abs(t), 2.4) * (t > 0 ? 1.2 : 0.9);
    const k = -D * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), 3.2)), 0.5) + (h * 0.6) * Math.pow(Math.abs(t), 6);
    for (let j = 0; j <= NS; j++) {
      const s = (j / NS) * 2 - 1, th = s * Math.PI / 2;
      const z = w * Math.sin(th);
      const y = k + (h - k) * (1 - Math.pow(Math.cos(th), 1.4));
      pos.push(x, y, z);
    }
  }
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NS; j++) {
      const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function makeFishingBoat({ seed = 1, hull = 0x2f6fae, sail = false, scale = 1 } = {}) {
  const key = `geo:caique:${hull}`;
  const geo = cached(key, () => {
    const p = new Parts();
    const L = 3.2, B = 0.62, H = 0.42, D = 0.32;
    const hullG = caiqueHull(L, B, H, D);
    const hc = new THREE.Color(hull);
    paint(hullG, (x, y, z, nx, ny, nz, c) => {
      if (y < 0.02) c.setHex(0x8e3a2a);                 // antifouling below the waterline
      else if (y > H - 0.06) c.setHex(0xf1ece0);        // white gunwale stripe
      else c.copy(hc);
      if (Math.abs(x - 1.25) < 0.08 && y > 0.18 && y < 0.3) c.setHex(0xf1ece0);   // painted eye
    });
    p.add(hullG, null);
    // inner skin (the visible inside of the boat) + thwarts
    const inner = caiqueHull(L * 0.97, B * 0.93, H - 0.03, D * 0.75);
    inner.index.array.reverse();
    inner.computeVertexNormals();
    p.add(inner, (x, y, z, nx, ny, nz, c) => { c.setHex(0xb08a5a); c.multiplyScalar(0.7 + 0.3 * smooth(-0.2, 0.4, y)); });
    for (const x of [-0.7, 0.1, 0.8]) p.add(box(0.18, 0.05, 1.0, 0.01), 0x9a7046, M(x, 0.2, 0));
    // stem and stern posts
    p.add(tube([new THREE.Vector3(1.55, 0.3, 0), new THREE.Vector3(1.66, 0.7, 0), new THREE.Vector3(1.6, 0.92, 0)], 0.045, 0.03, 6, 5), 0xf1ece0);
    p.add(tube([new THREE.Vector3(-1.55, 0.3, 0), new THREE.Vector3(-1.66, 0.62, 0), new THREE.Vector3(-1.62, 0.78, 0)], 0.045, 0.03, 6, 5), 0xf1ece0);
    // a folded sail on a short mast
    p.add(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 6), 0x6b4a2c, M(0.45, 1.1, 0));
    p.add(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 8).rotateZ(Math.PI / 2 - 0.35), 0xe8dcc0, M(0.3, 1.0, 0));
    // a coil of net in the stern
    p.add(blob(0.22, 1, 0.45), 0x7a6a4a, M(-0.9, 0.18, 0.05));
    const g = p.geometry();
    g.userData.shared = true;
    return g;
  });
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, mat.wood());
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  g.scale.setScalar(scale);
  return g;
}

/* ── flotsam: a lashed raft of crates, a barrel, a gold glint ───────────── */
export function makeFlotsam(rng) {
  const g = new THREE.Group();
  const p = new Parts();
  // three planks lashed crosswise
  for (let i = 0; i < 4; i++) p.add(box(1.7, 0.08, 0.26, 0.02), 0x7d5a38, M(0, 0.0, -0.42 + i * 0.28, (rng() - 0.5) * 0.08));
  for (const x of [-0.6, 0.6]) p.add(box(0.12, 0.07, 1.25, 0.02), 0x5f4128, M(x, 0.07, 0));
  const crate = makeCrate();
  p.add(crate.clone(), null, M(-0.35, 0.05, 0.05, rng() * 1.5, 0.95));
  p.add(crate.clone(), null, M(0.4, 0.05, -0.15, rng() * 1.5, 0.75));
  p.add(makeBarrelGeo().clone(), null, M(0.25, 0.32, 0.38, 0.3, 1, 1, 1, 0, Math.PI / 2));
  const mesh = p.mesh(mat.wood());
  g.add(mesh);
  // a spill of gold coin + a glint that blooms
  const gold = new THREE.Mesh(cached('geo:coinheap', () => blob(0.16, 1, 0.5)), mat.gold());
  gold.position.set(-0.35, 0.62, 0.05);
  g.add(gold);
  const gl = glowSprite(0xffd27a, 1.1, 0.6);
  gl.position.set(-0.35, 0.75, 0.05);
  g.add(gl);
  g.name = 'bob';
  return g;
}

/* ── UI markers ─────────────────────────────────────────────────────────── */
const GEM = 0xffc94a;
/* the current captain's marker: a faceted gold gem, point down, with a soft
   glow — HDR emissive so it blooms, never fogged */
export function makeTurnMarker() {
  const geo = cached('geo:turngem', () => {
    const g = lathe([[0.0, -0.62], [0.36, 0.0], [0.36, 0.06], [0.24, 0.24], [0.0, 0.28]], 8).toNonIndexed();
    g.computeVertexNormals();
    g.userData.shared = true;
    return g;
  });
  const material = cached('mat:turngem', () => new THREE.MeshStandardMaterial({
    color: GEM, metalness: 0.7, roughness: 0.22, emissive: GEM, emissiveIntensity: 1.25, fog: false }));
  const m = new THREE.Mesh(geo, material);
  m.name = 'turnMarker';
  m.position.y = 4.6;
  m.renderOrder = 9;
  const halo = new THREE.Sprite(cached('mat:turnhalo', () => new THREE.SpriteMaterial({ map: softDiscTexture(),
    color: new THREE.Color(1.2, 0.85, 0.35), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false })));
  halo.scale.setScalar(1.7);
  m.add(halo);
  return m;
}

/* reachable-stop beacon: a crisp double ring on the water, a soft pool of
   light, a slim fading shaft and a gold gem chevron. Roles and userData match
   scene.js's tickHighlights / hit-testing. Fog-free: it is UI. */
export function makeReachBeacon(nid, x, z, rr, color = 0xffe27a) {
  const c = new THREE.Color(color);
  const hdr = c.clone().multiplyScalar(1.5);
  const out = [];
  const ring = new THREE.Mesh(cached('geo:hlring', () => new THREE.RingGeometry(0.62, 1.0, 64).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: hdr, map: tex.ring(), transparent: true, depthWrite: false, fog: false,
      side: THREE.DoubleSide }));
  ring.scale.setScalar(rr * 1.62);
  ring.position.set(x, 0.32, z);
  ring.renderOrder = 6;
  ring.userData = { node: nid, role: 'ring' };
  out.push(ring);
  const halo = new THREE.Mesh(cached('geo:hlhalo', () => new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: c, map: softDiscTexture(), transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(rr * 1.5);
  halo.position.set(x, 0.28, z);
  halo.renderOrder = 5;
  halo.userData = { node: nid, role: 'halo' };
  out.push(halo);
  const beam = new THREE.Mesh(cached('geo:hlbeam', () => {
    const g = new THREE.CylinderGeometry(0.55, 0.8, 1, 24, 1, true);
    const uv = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < p.count; i++) uv.setY(i, p.getY(i) + 0.5);
    return g;
  }), new THREE.MeshBasicMaterial({ color: hdr, alphaMap: fadeTex(), transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  beam.scale.set(rr * 0.5, 14, rr * 0.5);
  beam.position.set(x, 7.2, z);
  beam.renderOrder = 6;
  beam.userData = { node: nid, role: 'beam' };
  out.push(beam);
  const chSize = Math.min(rr * 0.5, 2.6);
  const chev = new THREE.Mesh(cached('geo:hlchev', () => {
    const g = lathe([[0.0, -1.0], [0.62, 0.0], [0.62, 0.08], [0.36, 0.32], [0.0, 0.38]], 4).toNonIndexed();
    g.computeVertexNormals();
    return g;
  }), cached('mat:hlchev', () => new THREE.MeshStandardMaterial({ color: GEM, metalness: 0.6, roughness: 0.25,
    emissive: GEM, emissiveIntensity: 1.35, fog: false, transparent: true, opacity: 1 })));
  chev.scale.setScalar(chSize);
  chev.position.set(x, 9, z);
  chev.renderOrder = 8;
  chev.userData = { node: nid, role: 'chev', ph: (Math.abs(Math.floor(x * 7 + z * 13)) % 628) / 100 };
  out.push(chev);
  const disc = new THREE.Mesh(cached('geo:hldisc', () => new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2)),
    cached('mat:hldisc', () => new THREE.MeshBasicMaterial({ visible: false })));
  disc.scale.setScalar(rr * 1.8);
  disc.position.set(x, 0.4, z);
  disc.userData = { node: nid, role: 'disc' };
  out.push(disc);
  return out;
}

function fadeTex() {
  return cached('tex:hlfade', () => {
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 64;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 64, 0, 0);
    g.addColorStop(0, 'rgb(255,255,255)'); g.addColorStop(0.35, 'rgb(140,140,140)'); g.addColorStop(1, 'rgb(0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, 4, 64);
    return new THREE.CanvasTexture(cv);
  });
}

/* ── lanes ──────────────────────────────────────────────────────────────── */
function dashTex() {
  return cached('tex:wakedash', () => {
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 128;
    const c = cv.getContext('2d');
    const img = c.createImageData(32, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 32; x++) {
        const u = (x + 0.5) / 32 * 2 - 1, v = (y + 0.5) / 128 * 2 - 1;
        // a soft capsule, fuller at its head
        const r = Math.hypot(u, Math.max(0, Math.abs(v) - 0.7) / 0.3);
        const a = (1 - smooth(0.55, 1.0, r)) * (0.75 + 0.25 * (1 - v) / 2);
        const i = (y * 32 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    c.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/* a sea lane: a row of soft painted wake-dashes riding just above the swell,
   following a faint S so it reads as a sailing line, not a ruler. ends fade. */
export function makeSeaLane(ax, az, bx, bz, { seed = 1, color = 0xf4f0e2, opacity = 0.42 } = {}) {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L, px = -uz, pz = ux;
  const n = Math.max(1, Math.floor(L / 3.4));
  const rng = mulberry32(seed);
  const bend = (rng() - 0.5) * Math.min(4, L * 0.05);
  const pos = [], uv = [], col = [], idx = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const fade = smooth(0, 0.18, t) * smooth(1, 0.82, t);
    const off = Math.sin(t * Math.PI) * bend;
    const cx = ax + dx * t + px * off, cz = az + dz * t + pz * off;
    const hl = 0.85 * (0.6 + 0.4 * fade), hw = 0.22 * (0.6 + 0.4 * fade);
    // tangent of the bent path
    const tb = Math.cos(t * Math.PI) * Math.PI * bend / L;
    let tx = ux + px * tb, tz = uz + pz * tb;
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;
    const base = pos.length / 3;
    for (const [s, v] of [[-1, 0], [1, 0], [-1, 1], [1, 1]]) {
      const along = (v - 0.5) * 2 * hl;
      pos.push(cx + tx * along + nx * s * hw, 0, cz + tz * along + nz * s * hw);
      uv.push((s + 1) / 2, v);
      col.push(fade, fade, fade);
    }
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, map: dashTex(), vertexColors: true,
    transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
  // vertex colour scales the dash's brightness; alpha from the map. Dashes
  // near the stops are dimmer and smaller.
  m.position.y = 0.2;
  m.renderOrder = 2;
  return m;
}

/* an on-foot trail: one merged mesh of worn, irregular flagstones */
export function makeFootTrail(ax, az, bx, bz, { hex = 0xe6d7ae, seed = 1, y = 0.02 } = {}) {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L;
  const rng = mulberry32(seed);
  const n = Math.max(2, Math.floor(L / 2.6));
  const p = new Parts();
  for (let i = 0; i <= n; i++) {
    const d = (i / n) * L;
    for (let k = 0; k < (rng() < 0.4 ? 2 : 1); k++) {
      const side = (rng() - 0.5) * 1.6;
      const r = 0.42 + rng() * 0.3;
      const geo = rockGeometry(Math.floor(rng() * 1e9), { r, sy: 0.16, detail: 1, rough: 0.1, facets: 2,
        rock: hex, strata: 0, base: -0.2 });
      p.add(geo, null, M(ax + ux * d - uz * side, y, az + uz * d + ux * side, rng() * 6.28));
    }
  }
  const m = p.mesh(mat.rock(), { cast: false });
  m.receiveShadow = true;
  return m;
}

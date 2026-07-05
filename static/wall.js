/*
 * wall.js — the mountain wall that pens in the Isles of Peace, and the realm
 * backdrops beyond it (owner: Agent A). Replaces the legacy storm shader
 * entirely: jagged noise-displaced rock, snow caps, four carved passes with
 * braziers burning in each realm's accent color.
 *
 * Conventions: an "angle" here is atan2(z, x) of the thing's board position.
 * All peak rock is merged into ONE geometry per group (a single draw call)
 * so the wall is essentially free at runtime.
 */
import * as THREE from 'three';
import { mulberry32, hashStr, flat, displace, seedFrom, softDiscTexture } from './util.js';
import { REALM_INFO } from './themes.js';

/* deterministic per-vertex jitter (same recipe as util.displace) */
function vjit(x, y, z, seed) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
  return s - Math.floor(s);
}

// a fixed "sun" for baking mountain shading into vertex colors (the ring is
// drawn unlit so it never blacks out in fog / at noon — the facet definition
// and snow are painted in)
const _SUN = new THREE.Vector3(0.45, 0.78, 0.32).normalize();
const _vP = new THREE.Vector3(), _vQ = new THREE.Vector3(), _vR = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _fn = new THREE.Vector3();

/*
 * One jagged peak: displaced cone, vertex-colored rock → snow.
 * Returned geometry is non-indexed, already transformed into world space.
 */
function peakGeometry({ baseR, h, x, z, rotY, seed, rock, rockDark, snow,
                        snowline, haze = null, hazeAmt = 0 }) {
  // A real mountain, not a smooth cone: many facets, a concave (steeper-up)
  // profile, and RIDGED horizontal displacement — coherent spurs and gullies
  // keyed by angle so the silhouette breaks into aretes and couloirs.
  const geo = new THREE.ConeGeometry(baseR, h, 9, 6, true).toNonIndexed();
  const pos = geo.attributes.position;
  const rr = mulberry32((seed | 0) >>> 0);
  // per-peak ridge harmonics (a few random spurs around the massif)
  const p1 = rr() * 6.28, p2 = rr() * 6.28, p3 = rr() * 6.28;
  const lean = (rr() - 0.5) * 0.5, leanA = rr() * 6.28;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
    let frac = (vy + h / 2) / h;                 // 0 base .. 1 tip
    frac = Math.max(0, Math.min(1, frac));
    const th = Math.atan2(vz, vx);
    // ridged radial field: alternating spurs/gullies, fading toward the peak
    const ridge = (Math.sin(th * 3 + p1) * 0.6 +
                   Math.sin(th * 6 + p2) * 0.28 +
                   Math.sin(th * 11 + p3) * 0.14);
    const gully = Math.max(0, -ridge);           // carve gullies deeper
    const grow = 1 + ridge * 0.34 * (1 - frac) - gully * 0.22 * (1 - frac * 0.6);
    // concave profile: pinch the upper third for a steeper summit
    const prof = Math.pow(1 - frac, 0.28);
    let nx = vx * grow * prof;
    let nz = vz * grow * prof;
    // a little coherent jag + a summit lean so no two peaks read the same
    const j = vjit(vx, vy, vz, seed + 5) - 0.5;
    nx += j * baseR * 0.16 + Math.cos(leanA) * lean * frac * frac * baseR;
    nz += (vjit(vz, vx, vy, seed + 9) - 0.5) * baseR * 0.16 +
          Math.sin(leanA) * lean * frac * frac * baseR;
    const ny = vy + (vjit(vx, vz, vy, seed + 2) - 0.5) * h * 0.05;
    pos.setXYZ(i, nx, ny, nz);
  }

  // bake flat-facet shading + snow into vertex colors (unlit material reads it)
  const arr = pos.array;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let t = 0; t < pos.count; t += 3) {
    _vP.set(arr[t * 3], arr[t * 3 + 1], arr[t * 3 + 2]);
    _vQ.set(arr[t * 3 + 3], arr[t * 3 + 4], arr[t * 3 + 5]);
    _vR.set(arr[t * 3 + 6], arr[t * 3 + 7], arr[t * 3 + 8]);
    _e1.subVectors(_vQ, _vP); _e2.subVectors(_vR, _vP);
    _fn.crossVectors(_e1, _e2).normalize();
    if (_fn.y < 0) _fn.multiplyScalar(-1);        // outward/up
    const lit = 0.42 + 0.58 * Math.max(0, _fn.dot(_SUN));   // sun + fill
    for (let k = 0; k < 3; k++) {
      const vy = arr[(t + k) * 3 + 1];
      let frac = Math.max(0, Math.min(1, (vy + h / 2) / h));
      const jit = vjit(arr[(t + k) * 3], vy, arr[(t + k) * 3 + 2], seed + 5);
      const line = snowline + (jit - 0.5) * 0.13;
      const upFace = _fn.y;                        // snow clings to flatter tops
      if (frac > line && upFace > 0.25) {
        const kk = Math.min(1, (frac - line) / 0.06);
        c.copy(rock).lerp(snow, 0.45 + kk * 0.55);
        c.multiplyScalar(0.9 + lit * 0.32);        // snow: bright, low contrast
      } else {
        c.copy(rockDark).lerp(rock, Math.min(1, frac * 1.5 + jit * 0.3));
        c.multiplyScalar(lit);                     // rock: full facet contrast
      }
      if (haze && hazeAmt > 0) c.lerp(haze, Math.pow(1 - frac, 1.4) * hazeAmt);
      col[(t + k) * 3] = c.r; col[(t + k) * 3 + 1] = c.g; col[(t + k) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.rotateY(rotY);
  geo.translate(x, h / 2 - 4.5, z);   // roots sunk below the waterline
  return geo;
}

/* merge a list of colored non-indexed geometries into one mesh */
function mergeRock(geoms) {
  let total = 0;
  for (const g of geoms) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, o);
    col.set(g.attributes.color.array, o);
    o += g.attributes.position.count * 3;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.computeVertexNormals();
  // lighting is fully baked into the vertex colors (shading gradient, snow,
  // horizon haze) — an unlit material keeps the range reading as painted
  // distant mountains from every angle instead of going black at noon
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    vertexColors: true, fog: false }));
  mesh.frustumCulled = false;         // one ring, always partly in view
  return mesh;
}

const _d = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b)); // wrapped delta

function glowSprite(color, scale) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture(), color: new THREE.Color(color), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.set(scale, scale, 1);
  return sp;
}

/*
 * buildMountainWall — the great ring around the hub.
 * gates: [{angle, realm}] ×4; each gets a carved pass ~26 units wide.
 */
export function buildMountainWall({ radius = 560, gates = [], theme }) {
  const group = new THREE.Group();
  group.name = 'mountainwall';
  const rng = mulberry32(hashStr('wall:' + (theme?.id ?? 'hub')));
  const rock = new THREE.Color(theme.wall.rock);
  const rockDark = rock.clone().multiplyScalar(0.5);
  const snow = new THREE.Color(theme.wall.snow);

  const haze = new THREE.Color(theme.sky.horizon);
  const geoms = [];
  const rows = [
    // an extra OUTER row seals every sightline — the ring reads SOLID from above
    { r: radius + 46, n: 44, hMin: 64, hMax: 108, bMin: 48, bMax: 70, snowline: 0.55, haze: 0.6 },
    { r: radius,      n: 56, hMin: 72, hMax: 122, bMin: 50, bMax: 74, snowline: 0.55, haze: 0.55 },
    { r: radius - 48, n: 46, hMin: 46, hMax: 86,  bMin: 34, bMax: 54, snowline: 0.62, haze: 0.45 },
    { r: radius - 86, n: 24, hMin: 14, hMax: 32,  bMin: 16, bMax: 28, snowline: 2.0, haze: 0.4 }, // foothill rubble, no snow
  ];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const a = (i / row.n) * Math.PI * 2 + (rng() - 0.5) * (3.6 / row.n);
      const baseR = row.bMin + rng() * (row.bMax - row.bMin);
      // carve the passes: no rock near a gate angle
      let inGate = false;
      for (const gt of gates) {
        if (Math.abs(_d(a, gt.angle)) * row.r < 15 + baseR * 0.85) { inGate = true; break; }
      }
      if (inGate) continue;
      const rr = row.r + (rng() - 0.5) * 26;
      geoms.push(peakGeometry({
        baseR,
        h: row.hMin + rng() * (row.hMax - row.hMin),
        x: Math.cos(a) * rr, z: Math.sin(a) * rr,
        rotY: rng() * Math.PI * 2,
        seed: seedFrom(rng),
        rock, rockDark, snow, snowline: row.snowline,
        haze, hazeAmt: row.haze,
      }));
    }
  }
  group.add(mergeRock(geoms));

  /* the four passes: flanking bastions, carved lintel, braziers, realm haze */
  const flames = [];
  const lights = [];
  for (const gt of gates) {
    const accent = new THREE.Color(REALM_INFO[gt.realm]?.accent ?? '#d9a441');
    const gg = new THREE.Group();
    gg.name = 'pass:' + gt.realm;
    const dirX = Math.cos(gt.angle), dirZ = Math.sin(gt.angle);
    // local frame: +x along the channel (outward), +z across it
    gg.position.set(dirX * radius, 0, dirZ * radius);
    gg.rotation.y = -gt.angle;

    const bast = [];
    for (const side of [-1, 1]) {
      // a sheer cliff bastion each side of the ~26-unit channel
      bast.push(peakGeometry({
        baseR: 18, h: 96 + (side + 1) * 6, x: 0, z: side * 31,
        rotY: rng() * 6.28, seed: seedFrom(rng),
        rock, rockDark, snow, snowline: 0.5,
      }));
      // a shoulder crag leaning over the channel mouth
      bast.push(peakGeometry({
        baseR: 11, h: 52, x: -16, z: side * 25,
        rotY: rng() * 6.28, seed: seedFrom(rng),
        rock, rockDark, snow, snowline: 0.6,
      }));
    }
    gg.add(mergeRock(bast));

    // carved lintel bridging the pass, with a glowing sigil groove
    const lintel = new THREE.Mesh(
      displace(new THREE.BoxGeometry(10, 5, 40, 2, 1, 8), 1.4, seedFrom(rng)),
      flat(rock.clone().multiplyScalar(0.85)));
    lintel.position.set(0, 30, 0);
    gg.add(lintel);
    const groove = new THREE.Mesh(new THREE.BoxGeometry(10.6, 0.9, 34),
      flat(0x241f28, { emissive: accent, emissiveIntensity: 1.1 }));
    groove.position.set(0, 27.6, 0);
    gg.add(groove);

    // twin braziers at the mouths of the pass
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 9, 6),
        flat(rockDark));
      pillar.position.set(-6, 4.5, side * 15);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.0, 1.6, 7),
        flat(0x4a4a52, { emissive: accent, emissiveIntensity: 0.6 }));
      bowl.position.set(-6, 9.6, side * 15);
      const fl = glowSprite(accent, 9);
      fl.name = 'brazier';
      fl.position.set(-6, 11.6, side * 15);
      const li = new THREE.PointLight(accent, 26, 90, 1.7);
      li.position.set(-6, 12, side * 15);
      gg.add(pillar, bowl, fl, li);
      flames.push(fl);
      lights.push(li);
    }

    // a hint of the realm beyond: tinted haze filling the pass
    const haze = new THREE.Mesh(new THREE.PlaneGeometry(30, 34),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    haze.position.set(26, 15, 0);
    haze.rotation.y = Math.PI / 2;
    gg.add(haze);
    const gleam = glowSprite(accent, 16);
    gleam.material.opacity = 0.2;
    gleam.position.set(38, 11, 0);
    gg.add(gleam);

    group.add(gg);
  }

  group.userData.update = (t) => {
    for (let i = 0; i < flames.length; i++) {
      const s = 8.4 + Math.sin(t * 9 + i * 2.1) * 0.9 + Math.sin(t * 23 + i * 5.7) * 0.4;
      flames[i].scale.set(s, s * 1.3, 1);
      lights[i].intensity = 24 + Math.sin(t * 11 + i * 1.9) * 5;
    }
  };
  return group;
}

/* ── realm flavor pieces ────────────────────────────────────────────────── */

/* aurora: an additive ribbon strip, vertex-faded to nothing at the top edge */
function makeAurora(radius, gateAngle, rng) {
  const N = 56;
  const span = 2.4;
  const a0 = gateAngle + Math.PI - span / 2;   // hangs over the far horizon
  const pos = new Float32Array((N + 1) * 2 * 3);
  const col = new Float32Array((N + 1) * 2 * 3);
  const idx = [];
  const cBot = new THREE.Color(0x4fe3a0);
  const cMid = new THREE.Color(0x7fd4ef);
  const c = new THREE.Color();
  const baseY = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const k = i / N;
    const a = a0 + k * span;
    const r = radius * 0.94;
    const y = 128 + Math.sin(k * 9 + rng() * 0.4) * 10 + Math.sin(k * 23) * 4;
    baseY[i] = y;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pos[i * 6] = x;     pos[i * 6 + 1] = y;      pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x; pos[i * 6 + 4] = y + 52; pos[i * 6 + 5] = z;
    c.copy(cBot).lerp(cMid, 0.5 + 0.5 * Math.sin(k * 12));
    const edge = Math.sin(k * Math.PI);          // fade the ribbon's ends
    col[i * 6] = c.r * edge; col[i * 6 + 1] = c.g * edge; col[i * 6 + 2] = c.b * edge;
    col[i * 6 + 3] = 0; col[i * 6 + 4] = 0; col[i * 6 + 5] = 0; // top → black (invisible, additive)
    if (i < N) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false }));
  mesh.frustumCulled = false;
  mesh.name = 'aurora';
  const posAttr = geo.attributes.position;
  mesh.userData.update = (t) => {
    for (let i = 0; i <= N; i++) {
      const y = baseY[i] + Math.sin(t * 0.6 + i * 0.35) * 5 + Math.sin(t * 1.1 + i * 0.13) * 2.5;
      posAttr.array[i * 6 + 1] = y;
      posAttr.array[i * 6 + 4] = y + 52 + Math.sin(t * 0.4 + i * 0.5) * 6;
    }
    posAttr.needsUpdate = true;
  };
  return mesh;
}

/* jungle canopy wall: merged dark-green blobs hugging the ridge line */
function makeCanopyWall(radius, gateAngle, rng, theme) {
  const geoms = [];
  const deep = new THREE.Color(theme.palette.grass2);
  const lit = new THREE.Color(theme.palette.grass);
  const c = new THREE.Color();
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + (rng() - 0.5) * 0.12;
    if (Math.abs(_d(a, gateAngle)) < 0.09) continue;
    const rr = radius * 0.86 + (rng() - 0.5) * 30;
    const R = 12 + rng() * 12;
    const geo = new THREE.IcosahedronGeometry(R, 1).toNonIndexed();
    displace(geo, R * 0.4, seedFrom(rng));
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      const k = Math.min(1, Math.max(0, pos.getY(v) / R * 0.5 + 0.5));
      c.copy(deep).lerp(lit, k * 0.8 + vjit(pos.getX(v), pos.getY(v), pos.getZ(v), i) * 0.2);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.scale(1, 0.7 + rng() * 0.3, 1);
    geo.translate(Math.cos(a) * rr, R * 0.35, Math.sin(a) * rr);
    geoms.push(geo);
  }
  return mergeRock(geoms);
}

/* autumn: rolling amber hills — merged squashed domes */
function makeAmberHills(radius, gateAngle, rng, theme) {
  const geoms = [];
  const grass = new THREE.Color(theme.palette.grass);
  const grass2 = new THREE.Color(theme.palette.grass2);
  const rock = new THREE.Color(theme.palette.rock);
  const c = new THREE.Color();
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + (rng() - 0.5) * 0.18;
    if (Math.abs(_d(a, gateAngle)) < 0.1) continue;
    const rr = radius * 0.82 + (rng() - 0.5) * 60;
    const R = 26 + rng() * 22;
    const geo = new THREE.SphereGeometry(R, 10, 6).toNonIndexed();
    displace(geo, R * 0.16, seedFrom(rng));
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      const k = Math.min(1, Math.max(0, pos.getY(v) / R));
      c.copy(rock).lerp(grass2, Math.min(1, k * 2.4));
      if (k > 0.35) c.lerp(grass, (k - 0.35) * 1.3);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.scale(1 + rng() * 0.5, 0.32, 1);
    geo.rotateY(rng() * 6.28);
    geo.translate(Math.cos(a) * rr, -R * 0.06, Math.sin(a) * rr);
    geoms.push(geo);
  }
  return mergeRock(geoms);
}

/*
 * buildRealmBackdrop — the mountain crescent seen from inside a realm,
 * plus each realm's signature sky flavor. Denser on the gate side (the wall
 * you came through); open toward the realm's depths.
 * opts.gateAngle = atan2(z, x) of the realm's gate node (default 0).
 */
export function buildRealmBackdrop(theme, { radius = 520, gateAngle = 0 } = {}) {
  const group = new THREE.Group();
  group.name = 'backdrop:' + theme.id;
  const rng = mulberry32(hashStr('backdrop:' + theme.id));
  const rock = new THREE.Color(theme.wall.rock);
  const rockDark = rock.clone().multiplyScalar(0.5);
  const snow = new THREE.Color(theme.wall.snow);
  const updaters = [];

  /* the ridge crescent */
  const geoms = [];
  const rows = [
    { r: radius,      n: 40, hMin: 60, hMax: 110, bMin: 40, bMax: 62, snowline: 0.55 },
    { r: radius - 44, n: 30, hMin: 36, hMax: 72,  bMin: 26, bMax: 44, snowline: 0.62 },
  ];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const a = (i / row.n) * Math.PI * 2 + (rng() - 0.5) * (3.6 / row.n);
      const d = Math.abs(_d(a, gateAngle));
      if (d < 0.05) continue;                          // the pass stays open
      const keep = 0.3 + 0.7 * (Math.cos(d) + 1) / 2;  // dense near the gate side
      if (rng() > keep) continue;
      const baseR = row.bMin + rng() * (row.bMax - row.bMin);
      const rr = row.r + (rng() - 0.5) * 30;
      geoms.push(peakGeometry({
        baseR,
        h: row.hMin + rng() * (row.hMax - row.hMin),
        x: Math.cos(a) * rr, z: Math.sin(a) * rr,
        rotY: rng() * Math.PI * 2,
        seed: seedFrom(rng),
        rock, rockDark, snow,
        snowline: theme.id === 'desert' ? 0.72 : row.snowline,
        // dissolve the crescent toward the REALM'S FOG, hard: the material
        // ignores true fog (the baked-painting trick), so without this the
        // ridge floats over the murk as raw saturated slabs — worst in the
        // jungle, whose fog sits at 24 wu while the ridge stands at ~500
        haze: new THREE.Color(theme.fog.color), hazeAmt: 0.78,
      }));
    }
  }
  group.add(mergeRock(geoms));

  /* a welcoming pair of braziers on the realm side of the pass */
  {
    const accent = new THREE.Color(REALM_INFO[theme.id]?.accent ?? '#d9a441');
    const gx = Math.cos(gateAngle), gz = Math.sin(gateAngle);
    const flames = [];
    const lightArr = [];
    for (const side of [-1, 1]) {
      const px = gx * (radius - 30) - gz * side * 16;
      const pz = gz * (radius - 30) + gx * side * 16;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.5, 8, 6), flat(rockDark));
      pillar.position.set(px, 4, pz);
      const fl = glowSprite(accent, 8);
      fl.name = 'brazier';
      fl.position.set(px, 10.4, pz);
      const li = new THREE.PointLight(accent, 22, 80, 1.7);
      li.position.set(px, 10.8, pz);
      group.add(pillar, fl, li);
      flames.push(fl);
      lightArr.push(li);
    }
    updaters.push((t) => {
      for (let i = 0; i < flames.length; i++) {
        const s = 7.4 + Math.sin(t * 9 + i * 2.6) * 0.8;
        flames[i].scale.set(s, s * 1.3, 1);
        lightArr[i].intensity = 20 + Math.sin(t * 12 + i * 2.2) * 4;
      }
    });
  }

  /* theme flavor */
  if (theme.id === 'ice') {
    const aurora = makeAurora(radius, gateAngle, rng);
    group.add(aurora);
    updaters.push(aurora.userData.update);
    const aurora2 = makeAurora(radius * 0.8, gateAngle + 0.5, rng);
    aurora2.material.opacity = 0.35;
    group.add(aurora2);
    updaters.push(aurora2.userData.update);
    const sun = glowSprite(0xffe3b8, 55);
    sun.material.opacity = 0.35;
    sun.material.fog = false;
    sun.position.set(Math.cos(gateAngle + Math.PI) * radius * 0.9, 40,
                     Math.sin(gateAngle + Math.PI) * radius * 0.9);
    group.add(sun);
  } else if (theme.id === 'desert') {
    const sun = glowSprite(0xfff0c4, 90);
    sun.material.opacity = 0.45;
    sun.material.fog = false;
    sun.position.set(Math.cos(gateAngle + Math.PI) * radius * 0.85, 110,
                     Math.sin(gateAngle + Math.PI) * radius * 0.85);
    group.add(sun);
    const shimmers = [];
    for (let i = 0; i < 2; i++) {
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 1.3, 22 + i * 12),
        new THREE.MeshBasicMaterial({ color: 0xf9e3ae, transparent: true, opacity: 0.1 - i * 0.03,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      sh.position.set(Math.cos(gateAngle + Math.PI) * radius * 0.7, 16 + i * 14,
                      Math.sin(gateAngle + Math.PI) * radius * 0.7);
      sh.rotation.y = gateAngle + Math.PI / 2;
      group.add(sh);
      shimmers.push(sh);
    }
    updaters.push((t) => {
      const w = 1 + Math.sin(t * 1.7) * 0.06;
      sun.scale.set(130 * w, 130 / w, 1);
      for (let i = 0; i < shimmers.length; i++) {
        shimmers[i].scale.y = 1 + Math.sin(t * 2.3 + i * 1.7) * 0.18;
        shimmers[i].material.opacity = (0.1 - i * 0.03) * (1 + Math.sin(t * 3.1 + i) * 0.35);
      }
    });
  } else if (theme.id === 'jungle') {
    group.add(makeCanopyWall(radius, gateAngle, rng, theme));
    // god-light: a warm gleam low over the canopy
    const gleam = glowSprite(0xffe9ac, 60);
    gleam.material.opacity = 0.32;
    gleam.material.fog = false;
    gleam.position.set(Math.cos(gateAngle + Math.PI) * radius * 0.8, 80,
                       Math.sin(gateAngle + Math.PI) * radius * 0.8);
    group.add(gleam);
    updaters.push((t) => { gleam.material.opacity = 0.28 + Math.sin(t * 0.8) * 0.05; });
  } else if (theme.id === 'autumn') {
    group.add(makeAmberHills(radius, gateAngle, rng, theme));
    const sun = glowSprite(0xffc274, 75);
    sun.material.opacity = 0.42;
    sun.material.fog = false;
    sun.position.set(Math.cos(gateAngle + Math.PI) * radius * 0.9, 62,
                     Math.sin(gateAngle + Math.PI) * radius * 0.9);
    group.add(sun);
    updaters.push((t) => {
      const w = 1 + Math.sin(t * 0.9) * 0.03;
      sun.scale.set(75 * w, 75, 1);
    });
  } else {
    // hub theme passed defensively: just a sun gleam over the ridge
    const sun = glowSprite(theme.sun.color, 80);
    sun.material.fog = false;
    sun.position.set(Math.cos(gateAngle + Math.PI) * radius * 0.85, 70,
                     Math.sin(gateAngle + Math.PI) * radius * 0.85);
    group.add(sun);
  }

  group.userData.update = (t) => {
    for (let i = 0; i < updaters.length; i++) updaters[i](t);
  };
  return group;
}

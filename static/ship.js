/*
 * ship.js — the player's galley.
 *
 * The most-seen object in the game: every captain's piece on the board and the
 * hero of every sea battle. A stylized Aegean war galley, built procedurally:
 *   · a smooth lofted hull with sheer, a pitch-dark wet bottom, planked wood
 *     topsides and a painted wale in the captain's colour
 *   · curling stern post with a hanging lantern, raked stem with a bronze
 *     finial, a bronze ram at the waterline and the painted bow eye
 *   · planked deck with a gangway and thwarts, a bank of oars each side,
 *     steering oars, a row of shields on the rail, a striped stern awning
 *   · mast, yard, standing and running rigging, and a billowing square sail
 *     that glows when the sun is behind it
 *
 * Six ships must be told apart at a glance — and not by hue alone — so each
 * captain's colour also picks a different SAIL DEVICE (bands, pales, sun,
 * chevrons, quarters, lozenge).
 *
 *   makeShip(colorHex) → THREE.Group, +x is forward, y = 0 sits 0.15 above
 *   the waterline (callers scale ×1.7–2 and float the group at world y≈0, the
 *   sea surface being y = −0.3). About 5k triangles in 6 draw calls.
 *
 * Geometry and textures are cached and shared between ships (flagged
 * userData.shared); disposing a ship's meshes is still safe — three simply
 * re-uploads a shared buffer the next time another ship uses it.
 */
import * as THREE from 'three';
import { hashStr, softDiscTexture } from './util.js';
import { ATMO, bindAtmosphere } from './gfx/atmosphere.js';

/* ── proportions (model units) ───────────────────────────────────────────── */
const X0 = -1.74, X1 = 1.72;      // stern tip → bow tip
const WL = -0.15;                 // waterline in model space
const S_BAND = 0.72;              // girth parameter where the painted wale starts
const S_DECK = 0.84;              // girth parameter of the deck edge
const MAST_X = 0.12;
const NU = 34;                    // hull stations

const C = {
  wood: new THREE.Color(0xa06c3e), pitch: new THREE.Color(0x2a221f),
  deck: new THREE.Color(0xc9a672), gang: new THREE.Color(0xdcbf90),
  trim: new THREE.Color(0x543722), rope: new THREE.Color(0x3b2c1f),
  cream: new THREE.Color(0xeadfc4), rim: new THREE.Color(0x7c5a2a),
  boss: new THREE.Color(0xd9b45c), white: new THREE.Color(0xffffff),
};

const _Y = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4(), _n3 = new THREE.Matrix3();
const _col = new THREE.Color();
const _f = { x: 0, w: 0, h: 0, k: 0 };

const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/* ── the hull surface ────────────────────────────────────────────────────── */
/* station u (0 stern → 1 bow): x, half-beam, sheer height, keel height */
function frame(u, o = _f) {
  const t = 2 * u - 1, a = Math.abs(t);
  o.x = X0 + (X1 - X0) * u;
  o.w = 0.035 + 0.52 * Math.pow(Math.max(0, 1 - Math.pow(a, t < 0 ? 2.9 : 2.2)), 0.72);
  o.h = 0.40 + (t < 0 ? 0.50 : 0.42) * Math.pow(a, 3.2);
  const e = Math.pow(Math.max(0, (a - 0.5) / 0.5), t < 0 ? 2.5 : 3.0);
  o.k = -0.42 + (o.h + 0.42) * e;
  return o;
}

/* point on the hull skin: s runs keel (0) → sheer (1) round the bilge */
function hullPoint(u, s, side, out) {
  const f = frame(u);
  const th = s * Math.PI / 2;
  const z = f.w * Math.pow(Math.sin(th), 0.62);
  const y = f.k + (f.h - f.k) * (1 - Math.pow(Math.cos(th), 1.7));
  return out.set(f.x, y, side * z);
}

function hullNormal(u, s, side, out) {
  const du = 0.006, ds = 0.012;
  hullPoint(Math.min(1, u + du), s, side, _a);
  hullPoint(Math.max(0, u - du), s, side, _b);
  _a.sub(_b);                                           // along the hull (+x)
  hullPoint(u, Math.min(1, s + ds), side, _b);
  hullPoint(u, Math.max(0.002, s - ds), side, _c);
  _b.sub(_c);                                           // up the girth
  out.crossVectors(_a, _b).multiplyScalar(side);
  if (out.lengthSq() < 1e-12) out.set(0, -0.3, side);
  return out.normalize();
}

const deckY = (u) => hullPoint(u, S_DECK, 1, _e).y;
const deckHalf = (u) => Math.max(0.01, hullPoint(u, S_DECK, 1, _e).z - 0.035);

/* ── a tiny indexed-mesh builder (positions, smooth normals, uv, colour) ─── */
class Builder {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; }

  vert(px, py, pz, nx, ny, nz, u, v, col) {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.t.push(u, v);
    this.c.push(col.r, col.g, col.b);
    return this.p.length / 3 - 1;
  }

  /* two triangles, wound to agree with the vertex normals; slivers dropped */
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  tri(a, b, c) {
    const p = this.p, n = this.n;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * fx + fy * fy + fz * fz < 1e-14) return;
    const d = fx * (n[a * 3] + n[b * 3] + n[c * 3])
            + fy * (n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1])
            + fz * (n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]);
    if (d >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }

  /* (nu+1)×(nv+1) grid; fn(i, j, o) fills o.p / o.n (Vector3), o.u, o.v, o.c */
  grid(nu, nv, fn) {
    const base = this.p.length / 3;
    const o = { p: new THREE.Vector3(), n: new THREE.Vector3(), u: 0, v: 0, c: C.white };
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        fn(i, j, o);
        this.vert(o.p.x, o.p.y, o.p.z, o.n.x, o.n.y, o.n.z, o.u, o.v, o.c);
      }
    }
    const W = nv + 1;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = base + i * W + j;
        this.quad(a, a + W, a + W + 1, a + 1);
      }
    }
  }

  /* surface of revolution about local +Y, placed by `mat`. profile: rows of
     [r, y] or [r, y, colour] with y ascending (repeat a row to break colour). */
  lathe(profile, segs, mat, color = C.white, uvU = 1, uvV = 1) {
    const base = this.p.length / 3;
    const P = profile.length;
    _n3.getNormalMatrix(mat);
    for (let j = 0; j < P; j++) {
      // outward normal in the (r, y) plane from the neighbouring real segments
      let nr = 0, ny = 0;
      for (const [k0, k1] of [[j - 1, j], [j, j + 1]]) {
        if (k0 < 0 || k1 >= P) continue;
        const dr = profile[k1][0] - profile[k0][0], dy = profile[k1][1] - profile[k0][1];
        const l = Math.hypot(dr, dy);
        if (l < 1e-6) continue;
        nr += dy / l; ny += -dr / l;
      }
      // a repeated row borrows the slope from the far side of its twin
      if (nr === 0 && ny === 0) { nr = 1; }
      const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
      const col = profile[j][2] || color;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        _a.set(profile[j][0] * ca, profile[j][1], profile[j][0] * sa).applyMatrix4(mat);
        _b.set(nr * ca, ny, nr * sa).applyMatrix3(_n3).normalize();
        this.vert(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, (i / segs) * uvU, profile[j][1] * uvV, col);
      }
    }
    const W = segs + 1;
    for (let j = 0; j < P - 1; j++) {
      for (let i = 0; i < segs; i++) {
        const a = base + j * W + i;
        this.quad(a, a + 1, a + W + 1, a + W);
      }
    }
  }

  /* tapered tube along a curve */
  tube(curve, n, radial, radius, color, uvLen = 4) {
    const base = this.p.length / 3;
    const fr = curve.computeFrenetFrames(n, false);
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      curve.getPointAt(k, _a);
      const r = radius(k);
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        _b.copy(fr.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(fr.binormals[i], Math.sin(a));
        this.vert(_a.x + _b.x * r, _a.y + _b.y * r, _a.z + _b.z * r, _b.x, _b.y, _b.z,
          k * uvLen, j / radial, color);
      }
    }
    const W = radial + 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < radial; j++) {
        const a = base + i * W + j;
        this.quad(a, a + W, a + W + 1, a + 1);
      }
    }
  }

  /* merge any indexed three geometry, transformed, in one flat colour */
  merge(geo, mat, color) {
    const base = this.p.length / 3;
    const gp = geo.attributes.position, gn = geo.attributes.normal, gt = geo.attributes.uv;
    _n3.getNormalMatrix(mat);
    for (let i = 0; i < gp.count; i++) {
      _a.fromBufferAttribute(gp, i).applyMatrix4(mat);
      _b.fromBufferAttribute(gn, i).applyMatrix3(_n3).normalize();
      this.vert(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, gt.getX(i), gt.getY(i), color);
    }
    const idx = geo.index;
    for (let i = 0; i < idx.count; i += 3) {
      this.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
    }
  }

  build(withColor = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    g.userData.shared = true;
    return g;
  }
}

/* local +Y [0..1] → the segment a→b (radius left unscaled) */
function span(a, b, out = new THREE.Matrix4()) {
  _d.subVectors(b, a);
  const len = _d.length();
  _q.setFromUnitVectors(_Y, _d.multiplyScalar(1 / (len || 1)));
  return out.compose(a, _q, _s.set(1, len, 1));
}
/* local +Y → direction n at point p (unit scale) */
function facing(p, n, out = new THREE.Matrix4()) {
  _q.setFromUnitVectors(_Y, n);
  return out.compose(p, _q, _s.set(1, 1, 1));
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ── textures ────────────────────────────────────────────────────────────── */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/* pale planking: strakes with seams, butt joints and grain. Colour comes from
   the vertex tint, so one texture serves hull, deck, spars and painted work */
let _wood = null;
function woodTexture() {
  if (_wood) return _wood;
  const S = 256, ROW = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = lcg(90210);
  for (let r = 0; r < S / ROW; r++) {
    const tone = 206 + Math.floor(rnd() * 34);
    ctx.fillStyle = `rgb(${tone},${tone - 5},${tone - 12})`;
    ctx.fillRect(0, r * ROW, S, ROW);
    for (let i = 0; i < 30; i++) {                       // grain
      const y = r * ROW + 3 + rnd() * (ROW - 6), x = rnd() * S, len = 26 + rnd() * 110;
      ctx.strokeStyle = rnd() < 0.6 ? `rgba(70,48,30,${0.05 + rnd() * 0.13})`
                                    : `rgba(255,250,240,${0.06 + rnd() * 0.12})`;
      ctx.lineWidth = 0.6 + rnd() * 1.2;
      for (const ox of [0, -S]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y);
        ctx.lineTo(x + ox + len, y + (rnd() - 0.5) * 2.4);
        ctx.stroke();
      }
    }
    for (let i = 0; i < 2; i++) {                        // butt joints + trenails
      const x = Math.floor(rnd() * S);
      ctx.fillStyle = 'rgba(40,28,18,0.55)';
      ctx.fillRect(x, r * ROW + 2, 2, ROW - 2);
      ctx.fillStyle = 'rgba(30,22,16,0.6)';
      ctx.fillRect(x - 5, r * ROW + 8, 2, 2); ctx.fillRect(x - 5, r * ROW + 22, 2, 2);
      ctx.fillRect(x + 6, r * ROW + 8, 2, 2); ctx.fillRect(x + 6, r * ROW + 22, 2, 2);
    }
    ctx.fillStyle = 'rgba(28,20,14,0.78)';               // the seam and its lit lip
    ctx.fillRect(0, r * ROW, S, 2);
    ctx.fillStyle = 'rgba(255,248,235,0.30)';
    ctx.fillRect(0, r * ROW + 2, S, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.userData.shared = true;
  return (_wood = tex);
}

/* the apotropaic bow eye: white almond, dark rim, blue iris looking ahead */
let _eye = null;
function eyeTexture() {
  if (_eye) return _eye;
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const ctx = cv.getContext('2d');
  const almond = () => {
    ctx.beginPath();
    ctx.moveTo(6, 34);
    ctx.bezierCurveTo(36, 2, 92, 2, 122, 30);
    ctx.bezierCurveTo(92, 62, 36, 62, 6, 34);
    ctx.closePath();
  };
  almond(); ctx.fillStyle = '#f7f1e2'; ctx.fill();
  ctx.save(); almond(); ctx.clip();
  ctx.fillStyle = '#1d4f8a'; ctx.beginPath(); ctx.arc(74, 32, 19, 0, 6.3); ctx.fill();
  ctx.fillStyle = '#0c0f16'; ctx.beginPath(); ctx.arc(77, 32, 9.5, 0, 6.3); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(82, 26, 3.2, 0, 6.3); ctx.fill();
  ctx.restore();
  almond(); ctx.lineWidth = 6; ctx.strokeStyle = '#17120f'; ctx.lineJoin = 'round'; ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.userData.shared = true;
  return (_eye = tex);
}

/* each of the six captain colours flies its own device; any other colour
   falls back to a hash, so the mapping is stable for a given colour */
const DEVICES = ['bands', 'pales', 'sun', 'chevron', 'quarter', 'lozenge'];
const DEVICE_FOR = {
  '#e4572e': 'bands', '#2e86ab': 'pales', '#f6ae2d': 'sun',
  '#8e5572': 'chevron', '#33ca7f': 'quarter', '#6457a6': 'lozenge',
};
export function sailDevice(colorHex) {
  const key = String(colorHex).toLowerCase();
  return DEVICE_FOR[key] || DEVICES[hashStr('sail:' + key) % DEVICES.length];
}

const SAIL_ROWS = 220;            // canvas rows the cloth uses (of 256); below is solid colour
const _sailTex = new Map();
export function sailTexture(colorHex) {
  const key = String(colorHex).toLowerCase();
  let tex = _sailTex.get(key);
  if (tex) return tex;
  const S = 256, H = SAIL_ROWS;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const col = new THREE.Color(colorHex);
  const css = '#' + col.getHexString();
  const dark = '#' + col.clone().multiplyScalar(0.62).getHexString();
  ctx.fillStyle = '#efe5cb';
  ctx.fillRect(0, 0, S, S);

  ctx.fillStyle = css; ctx.strokeStyle = dark; ctx.lineWidth = 3; ctx.lineJoin = 'round';
  const fillStroke = () => { ctx.fill(); ctx.stroke(); };
  const device = sailDevice(key);
  if (device === 'bands') {
    for (const y of [22, 92, 162]) { ctx.beginPath(); ctx.rect(-4, y, S + 8, 36); fillStroke(); }
  } else if (device === 'pales') {
    for (const x of [24, 108, 192]) { ctx.beginPath(); ctx.rect(x, -4, 40, H + 8); fillStroke(); }
  } else if (device === 'sun') {
    const cx = 128, cy = 108;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a - 0.11) * 56, cy + Math.sin(a - 0.11) * 56);
      ctx.lineTo(cx + Math.cos(a) * 96, cy + Math.sin(a) * 96);
      ctx.lineTo(cx + Math.cos(a + 0.11) * 56, cy + Math.sin(a + 0.11) * 56);
      ctx.closePath(); fillStroke();
    }
    ctx.beginPath(); ctx.arc(cx, cy, 46, 0, 6.3); fillStroke();
  } else if (device === 'chevron') {
    for (const y of [10, 84, 158]) {
      ctx.beginPath();
      ctx.moveTo(-6, y); ctx.lineTo(128, y + 64); ctx.lineTo(S + 6, y);
      ctx.lineTo(S + 6, y + 34); ctx.lineTo(128, y + 98); ctx.lineTo(-6, y + 34);
      ctx.closePath(); fillStroke();
    }
    ctx.fillStyle = '#efe5cb'; ctx.fillRect(0, H, S, S - H);
  } else if (device === 'quarter') {
    ctx.beginPath(); ctx.rect(-4, -4, 132, H / 2 + 4); fillStroke();
    ctx.beginPath(); ctx.rect(128, H / 2, 132, H / 2 + 4); fillStroke();
  } else {                                               // lozenge
    const cx = 128, cy = H / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 100); ctx.lineTo(cx + 112, cy); ctx.lineTo(cx, cy + 100); ctx.lineTo(cx - 112, cy);
    ctx.closePath(); fillStroke();
    ctx.fillStyle = '#efe5cb';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 46); ctx.lineTo(cx + 52, cy); ctx.lineTo(cx, cy + 46); ctx.lineTo(cx - 52, cy);
    ctx.closePath(); fillStroke();
  }

  // the cloth itself: sewn panels, brail-line shading, a little weathering
  const rnd = lcg(hashStr(key) || 1);
  for (let x = 0; x <= S; x += 32) {
    ctx.fillStyle = 'rgba(60,44,28,0.20)'; ctx.fillRect(x - 1, 0, 2, H);
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x + 1, 0, 2, H);
  }
  for (let y = 44; y < H; y += 44) { ctx.fillStyle = 'rgba(60,44,28,0.10)'; ctx.fillRect(0, y, S, 2); }
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S, y = rnd() * H, r = 8 + rnd() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(70,52,34,0.07)' : 'rgba(255,255,255,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // hem + the solid-colour strip the pennant samples
  ctx.fillStyle = css; ctx.fillRect(0, H - 8, S, S - H + 8);
  ctx.fillStyle = dark; ctx.fillRect(0, H - 10, S, 2);

  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.userData.shared = true;
  _sailTex.set(key, tex);
  return tex;
}

/* ── materials (shared by every ship) ────────────────────────────────────── */
let _mats = null;
function materials() {
  if (_mats) return _mats;
  const wood = woodTexture();
  const body = new THREE.MeshStandardMaterial({
    map: wood, bumpMap: wood, bumpScale: 1.4, vertexColors: true,
    roughness: 0.72, metalness: 0 });
  const bronze = new THREE.MeshStandardMaterial({
    color: 0xc08a45, roughness: 0.36, metalness: 0.85 });
  const eye = new THREE.MeshStandardMaterial({
    map: eyeTexture(), transparent: true, alphaTest: 0.45, roughness: 0.6,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // the lantern flame is brighter than white, so it blooms
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.9, 0.62) });
  const glow = new THREE.SpriteMaterial({
    map: softDiscTexture(), color: 0xffb060, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false });
  _mats = { body, bronze, eye, lamp, glow, sails: new Map() };
  return _mats;
}

/* cloth lets the sun through: seen from the shaded side, a sail facing the
   sun glows with its own colours instead of going grey */
function sailMaterial(colorHex) {
  const M = materials();
  const key = String(colorHex).toLowerCase();
  let mat = M.sails.get(key);
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({
    map: sailTexture(key), side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    bindAtmosphere(shader);
    shader.uniforms.uSailSun = ATMO.uSunColor;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSailSun;')
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        #ifdef USE_FOG
          totalEmissiveRadiance += diffuseColor.rgb * uSailSun
            * ( 0.46 * clamp( dot( -normal, uAtmoSunView.xyz ), 0.0, 1.0 ) );
        #endif`);
  };
  mat.customProgramCacheKey = () => 'thalassa-sail';
  M.sails.set(key, mat);
  return mat;
}

/* ── geometry ────────────────────────────────────────────────────────────── */
const _unitBox = new THREE.BoxGeometry(1, 1, 1);

/* everything timber, paint and rope — one mesh, tinted per vertex */
function buildBody(paint) {
  const B = new Builder();
  const paintIn = paint.clone().multiplyScalar(0.6);
  const P = new THREE.Vector3(), N = new THREE.Vector3();

  /* hull skin, both sides */
  const ROWS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, S_BAND, S_BAND, 0.8, 0.9, 1];
  const BAND_FROM = ROWS.lastIndexOf(S_BAND);
  for (const side of [1, -1]) {
    B.grid(NU, ROWS.length - 1, (i, j, o) => {
      const u = i / NU, s = ROWS[j];
      hullPoint(u, s, side, o.p);
      hullNormal(u, s, side, o.n);
      o.u = u * 7; o.v = 0.06 + s * 2.4;
      if (j >= BAND_FROM) o.c = paint;
      else o.c = _col.copy(C.wood).lerp(C.pitch, smooth(WL + 0.2, WL + 0.02, o.p.y)).clone();
    });
    /* inner bulwark: sheer down to the deck edge */
    B.grid(NU - 4, 1, (i, j, o) => {
      const u = (i + 2) / NU;
      if (j === 0) { hullPoint(u, 1, side, o.p); o.p.z -= side * 0.04; }
      else o.p.set(frame(u).x, deckY(u), side * deckHalf(u));
      o.n.set(0, 0.25, -side).normalize();
      o.u = u * 7; o.v = j * 0.4;
      o.c = paintIn;
    });
    /* gunwale */
    const pts = [];
    for (let k = 0; k <= 22; k++) {
      const u = 0.015 + (k / 22) * 0.97;
      hullPoint(u, 1, side, P);
      pts.push(V(P.x, P.y + 0.012, P.z - side * 0.02));
    }
    B.tube(new THREE.CatmullRomCurve3(pts), 30, 5, () => 0.036, C.trim, 9);
  }

  /* deck: two side decks and a raised gangway down the middle */
  const D0 = 0.045, D1 = 0.955, ND = 30;
  const GW = 0.13, GH = 0.045;
  const du = (i) => D0 + (D1 - D0) * (i / ND);
  for (const side of [1, -1]) {
    B.grid(ND, 1, (i, j, o) => {
      const u = du(i), half = deckHalf(u);
      o.p.set(frame(u).x, deckY(u), side * (j ? half : Math.min(GW, half)));
      o.n.set(0, 1, 0);
      o.u = o.p.x * 2.2; o.v = o.p.z * 2.2 + 0.5;
      o.c = C.deck;
    });
    B.grid(ND, 1, (i, j, o) => {                         // gangway edge
      const u = du(i), half = Math.min(GW, deckHalf(u));
      o.p.set(frame(u).x, deckY(u) + (j ? GH : 0), side * half);
      o.n.set(0, 0, side);
      o.u = o.p.x * 2.2; o.v = j * 0.1;
      o.c = C.trim;
    });
  }
  B.grid(ND, 1, (i, j, o) => {                           // gangway top
    const u = du(i), half = Math.min(GW, deckHalf(u));
    o.p.set(frame(u).x, deckY(u) + GH, (j ? 1 : -1) * half);
    o.n.set(0, 1, 0);
    o.u = o.p.x * 2.2; o.v = j * 0.24 + 0.03;
    o.c = C.gang;
  });

  /* thwarts, oars and shields share the rowing stations */
  const OARS = 8;
  const oarU = (k) => 0.25 + (k / (OARS - 1)) * 0.5;
  for (let k = 0; k < OARS; k++) {
    const u = oarU(k), x = frame(u).x, half = deckHalf(u), y = deckY(u);
    for (const side of [1, -1]) {
      _m.compose(_a.set(x, y + 0.02, side * (GW + half) / 2), _q.identity(),
        _s.set(0.075, 0.04, Math.max(0.02, half - GW)));
      B.merge(_unitBox, _m, C.trim);
      // oar: out through the topside, blade in the water
      hullPoint(u, 0.63, side, P);
      const port = P.clone();
      const tip = V(port.x - 0.26, WL - 0.27, port.z + side * 0.58);
      const M = span(port, tip);
      B.lathe([[0.019, -0.12], [0.017, 0.7]], 5, M, C.gang, 1, 2);
      B.lathe([[0.03, 0.66, C.cream], [0.058, 0.8, C.cream], [0.05, 0.98, C.cream], [0.001, 1.0, C.cream]],
        4, M.clone().multiply(_m.makeScale(1, 1, 0.3)), C.cream, 1, 1);
    }
  }
  for (let k = 0; k < OARS - 1; k++) {
    const u = (oarU(k) + oarU(k + 1)) / 2;
    for (const side of [1, -1]) {
      hullPoint(u, 0.9, side, P);
      hullNormal(u, 0.9, side, N);
      // the wale is painted the captain's colour, so shields on it go pale/dark
      const fc = k % 2 ? C.cream : _col.copy(paint).multiplyScalar(0.45).clone();
      B.lathe([[0.128, -0.02, C.rim], [0.122, 0.012, C.rim], [0.122, 0.012, fc], [0.05, 0.036, fc],
               [0.05, 0.036, C.boss], [0.001, 0.058, C.boss]],
        8, facing(P.addScaledVector(N, 0.03), N), fc);
    }
  }

  /* stem and stern posts */
  const stern = new THREE.CatmullRomCurve3([
    V(-1.60, 0.56, 0), V(-1.74, 0.90, 0), V(-1.86, 1.20, 0), V(-1.85, 1.50, 0),
    V(-1.68, 1.72, 0), V(-1.42, 1.73, 0), V(-1.25, 1.58, 0)]);
  B.tube(stern, 18, 6, (k) => 0.078 - 0.046 * k, C.trim, 5);
  const stem = new THREE.CatmullRomCurve3([
    V(1.58, 0.52, 0), V(1.72, 0.82, 0), V(1.81, 1.08, 0), V(1.80, 1.32, 0), V(1.69, 1.49, 0)]);
  B.tube(stem, 12, 6, (k) => 0.074 - 0.036 * k, C.trim, 4);

  /* steering oars on the stern quarters */
  for (const side of [1, -1]) {
    const a = V(-1.22, 0.74, side * 0.40), b = V(-1.60, WL - 0.36, side * 0.50);
    const M = span(a, b);
    B.lathe([[0.022, -0.18], [0.024, 0.62]], 5, M, C.trim, 1, 2);
    B.lathe([[0.03, 0.58], [0.085, 0.74], [0.075, 0.97], [0.001, 1.0]], 4,
      M.clone().multiply(_m.makeScale(1, 1, 0.26)), C.trim);
    B.lathe([[0.012, 0], [0.012, 1]], 4, span(V(-1.19, 0.83, side * 0.39), V(-1.08, 0.86, side * 0.2)), C.trim);
  }

  /* striped awning over the helm */
  {
    const AX0 = -1.30, AX1 = -0.80, AR = 0.33, AH = 0.34, SEG = 8;
    const uOf = (x) => (x - X0) / (X1 - X0);
    for (const face of [1, -1]) {                        // outside, then lining
      for (let sgm = 0; sgm < SEG; sgm++) {
        const col = sgm % 2 ? C.cream : paint;
        const tint = face > 0 ? col : _col.copy(col).multiplyScalar(0.55).clone();
        B.grid(2, 1, (i, j, o) => {
          const x = AX0 + (AX1 - AX0) * (i / 2);
          const ph = ((sgm + j) / SEG) * Math.PI;
          const base = deckY(uOf(x)) + 0.16;
          const sag = 1 - 0.1 * Math.sin((i / 2) * Math.PI);
          o.p.set(x, base + Math.sin(ph) * AH * sag, Math.cos(ph) * AR);
          o.n.set(0, Math.sin(ph) * face, Math.cos(ph) * face);
          o.u = x * 1.5; o.v = ph * 0.4;
          o.c = tint;
        });
      }
    }
    for (const x of [AX0, AX1]) {                        // corner posts
      for (const side of [1, -1]) {
        const y = deckY(uOf(x));
        B.lathe([[0.016, 0], [0.016, 1]], 4, span(V(x, y, side * AR), V(x, y + 0.17, side * AR)), C.trim);
      }
    }
  }

  /* mast and yard */
  const mastFoot = V(MAST_X, deckY(0.54), 0), mastHead = V(MAST_X, 2.64, 0);
  B.lathe([[0.066, 0], [0.052, 0.55], [0.034, 1], [0.001, 1.004]], 7, span(mastFoot, mastHead), C.trim, 2, 6);
  const YARD_Y = 2.3, YARD_X = MAST_X + 0.075, YARD_Z = 1.04;
  B.lathe([[0.016, 0], [0.032, 0.25], [0.037, 0.5], [0.032, 0.75], [0.016, 1]], 6,
    span(V(YARD_X, YARD_Y, -YARD_Z), V(YARD_X, YARD_Y, YARD_Z)), C.trim, 2, 5);

  /* rigging */
  const rope = (a, b, r = 0.0105) => B.lathe([[r, 0], [r, 1]], 3, span(a, b), C.rope);
  rope(V(MAST_X, 2.58, 0), V(1.74, 1.40, 0));                       // forestay
  rope(V(MAST_X, 2.58, 0), V(-1.62, 1.70, 0));                      // backstay
  for (const side of [1, -1]) {
    rope(V(MAST_X, 2.22, 0), V(MAST_X - 0.42, 0.44, side * 0.53));  // shroud
    rope(V(MAST_X, 2.60, 0), V(YARD_X, YARD_Y + 0.02, side * YARD_Z * 0.86), 0.008);   // lift
    rope(V(YARD_X, YARD_Y, side * YARD_Z), V(-1.16, 0.78, side * 0.42), 0.008);        // brace
    rope(V(YARD_X + 0.03, 0.9, side * 0.86), V(-0.62, 0.47, side * 0.52), 0.008);      // sheet
  }
  return B.build();
}

/* ram, finials, lantern cage — bronze */
let _bronzeGeo = null;
function bronzeGeometry() {
  if (_bronzeGeo) return _bronzeGeo;
  const B = new Builder();
  // the ram: sheathed forefoot, three-finned at the waterline
  const root = V(1.30, WL - 0.05, 0), tip = V(2.04, WL + 0.07, 0);
  const M = span(root, tip);
  B.lathe([[0.15, 0], [0.125, 0.3], [0.085, 0.68], [0.045, 0.93], [0.001, 1]], 8,
    M.clone().multiply(_m.makeScale(0.92, 1, 0.7)));
  for (const k of [0.34, 0.58]) {                        // reinforcing bands
    B.lathe([[0.13 - k * 0.07, k - 0.03], [0.142 - k * 0.07, k], [0.13 - k * 0.07, k + 0.03]], 8,
      M.clone().multiply(_m.makeScale(0.92, 1, 0.7)));
  }
  // finials on the two posts
  const ball = [[0.001, -0.06], [0.045, -0.035], [0.06, 0], [0.045, 0.035], [0.001, 0.06]];
  B.lathe(ball, 7, _m.makeTranslation(1.67, 1.52, 0).clone());
  B.lathe(ball, 7, _m.makeTranslation(-1.23, 1.57, 0).clone());
  // lantern: hook, cap, base — the flame is its own mesh
  B.lathe([[0.008, 0], [0.008, 1]], 3, span(V(-1.23, 1.34, 0), V(-1.23, 1.53, 0)));
  B.lathe([[0.075, 0], [0.03, 0.05], [0.001, 0.075]], 6, _m.makeTranslation(-1.23, 1.325, 0).clone());
  B.lathe([[0.001, -0.02], [0.055, -0.012], [0.062, 0.006]], 6, _m.makeTranslation(-1.23, 1.19, 0).clone());
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.6, dx = Math.cos(a) * 0.056, dz = Math.sin(a) * 0.056;
    B.lathe([[0.006, 0], [0.006, 1]], 3, span(V(-1.23 + dx, 1.195, dz), V(-1.23 + dx, 1.33, dz)));
  }
  return (_bronzeGeo = B.build(false));
}

/* the bow eyes, moulded to the hull skin */
let _eyeGeo = null;
function eyeGeometry() {
  if (_eyeGeo) return _eyeGeo;
  const B = new Builder();
  const U0 = 0.80, U1 = 0.925, S0 = 0.6, S1 = 0.87;
  for (const side of [1, -1]) {
    B.grid(4, 3, (i, j, o) => {
      const u = U0 + (U1 - U0) * (i / 4), s = S0 + (S1 - S0) * (j / 3);
      const y0 = hullPoint(u, S0, side, _d).y, y1 = hullPoint(u, S1, side, _d).y;
      hullNormal(u, s, side, o.n);
      hullPoint(u, s, side, o.p).addScaledVector(o.n, 0.006);
      o.u = i / 4;                             // the iris sits toward the bow on both sides
      o.v = (o.p.y - y0) / Math.max(1e-4, y1 - y0);
    });
  }
  return (_eyeGeo = B.build(false));
}

/* the square sail (bellied by a following wind) and the masthead pennant */
let _sailGeo = null;
function sailGeometry() {
  if (_sailGeo) return _sailGeo;
  const B = new Builder();
  const NA = 14, NB = 10, TOP = 2.275, HGT = 1.38, WT = 1.96, WF = 1.74, X = MAST_X + 0.11;
  const at = (a, b, out) => {
    const span01 = Math.sin(Math.PI * a);
    const belly = 0.44 * Math.pow(span01, 0.85) * Math.pow(b, 0.62) * (1 - 0.3 * b)
                + 0.022 * Math.abs(Math.sin(a * Math.PI * 7)) * b;      // panels pillow between the seams
    return out.set(
      X + belly,
      TOP - b * HGT + 0.15 * b * b * span01,
      (a - 0.5) * (WT + (WF - WT) * b));
  };
  B.grid(NA, NB, (i, j, o) => {
    const a = i / NA, b = j / NB, e = 0.01;
    at(a, b, o.p);
    at(Math.min(1, a + e), b, _a).sub(at(Math.max(0, a - e), b, _b));
    at(a, Math.min(1, b + e), _b).sub(at(a, Math.max(0, b - e), _c));
    o.n.crossVectors(_b, _a).normalize();                 // faces forward (+x)
    if (o.n.x < 0) o.n.negate();
    o.u = a; o.v = 1 - b * (SAIL_ROWS - 4) / 256;
  });
  // pennant streaming forward from the masthead
  B.grid(5, 1, (i, j, o) => {
    const k = i / 5;
    o.p.set(MAST_X + 0.03 + k * 0.5, 2.6 - (j ? 0.15 * (1 - k * 0.85) : 0) - k * 0.03,
      Math.sin(k * 5.2) * 0.045 * k);
    o.n.set(-Math.cos(k * 5.2) * 0.2, 0, 1).normalize();
    o.u = 0.2 + k * 0.6; o.v = 0.03;
  });
  return (_sailGeo = B.build(false));
}

let _flameGeo = null;
const _bodyGeo = new Map();

/* ── the ship ────────────────────────────────────────────────────────────── */
export function makeShip(colorHex) {
  const key = String(colorHex || '#e4572e').toLowerCase();
  const M = materials();
  const g = new THREE.Group();

  let bodyGeo = _bodyGeo.get(key);
  if (!bodyGeo) { bodyGeo = buildBody(new THREE.Color(key)); _bodyGeo.set(key, bodyGeo); }
  const body = new THREE.Mesh(bodyGeo, M.body);
  body.name = 'hull';
  body.castShadow = true; body.receiveShadow = true;

  const bronze = new THREE.Mesh(bronzeGeometry(), M.bronze);
  bronze.castShadow = true;

  const sail = new THREE.Mesh(sailGeometry(), sailMaterial(key));
  sail.name = 'sail';
  sail.castShadow = true;

  const eyes = new THREE.Mesh(eyeGeometry(), M.eye);
  eyes.name = 'eyes';
  eyes.userData.noShadow = true;

  if (!_flameGeo) { _flameGeo = new THREE.SphereGeometry(0.05, 8, 6); _flameGeo.userData.shared = true; }
  const flame = new THREE.Mesh(_flameGeo, M.lamp);
  flame.name = 'lantern';
  flame.position.set(-1.23, 1.26, 0);
  flame.scale.set(1, 1.25, 1);
  flame.userData.noShadow = true;
  const halo = new THREE.Sprite(M.glow);
  halo.position.copy(flame.position);
  halo.scale.setScalar(0.62);

  g.add(body, bronze, sail, eyes, flame, halo);
  return g;
}

/*
 * travel.js — how a ship (or the walking captain) gets from A to B.
 *
 * scene.js decides WHERE a vessel goes (the lane's nodes, the berth it ends
 * on); this module turns that list of control points into a route a real
 * vessel could follow and moves it along that route:
 *
 *   · planRoute()   control points → a smooth, evenly sampled curve that
 *                   leaves along the bow's current heading (no spinning in
 *                   place), bends around every solid it was given (island
 *                   footprints, bergs, trees, parked ships) with a hull's
 *                   clearance, and ends exactly on the berth.
 *   · routeAt()     arc-length lookup: position + tangent at distance s.
 *   · helm()        believable turning — the bow swings toward the curve's
 *                   tangent at a capped rate, so nothing pivots on the spot.
 *   · obstacleIndex() a coarse spatial hash of a stage's field props (berg
 *                   fields, dune rocks, the Vale's trunks) so routing can ask
 *                   "what solid is near here" cheaply. Built once per stage.
 *
 * Everything here allocates only while PLANNING (once per voyage); the
 * per-frame calls write into caller-owned vectors.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _s = new THREE.Sphere();

/* ── obstacles ─────────────────────────────────────────────────────────── */

/**
 * Walk a stage's field (and anything else solid) and collect XZ discs
 * {x, z, r} for every prop that stands out of the water / ground: one per
 * mesh, one per instance of an InstancedMesh. Flat things (decals, ground
 * planes, lily pads under 0.6 high) and huge things (the floor itself) are
 * skipped. Returns a hash grid with a query(x, z, reach, out) method.
 */
export function obstacleIndex(root, { cell = 24, minTop = 0.6, maxR = 30 } = {}) {
  const list = [];
  if (root) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || o.visible === false) return;
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (!g.boundingBox) g.computeBoundingBox();
      const bs = g.boundingSphere, bb = g.boundingBox;
      const n = o.isInstancedMesh ? o.count : 1;
      for (let i = 0; i < n; i++) {
        if (o.isInstancedMesh) {
          o.getMatrixAt(i, _m);
          _m.premultiply(o.matrixWorld);
        } else {
          _m.copy(o.matrixWorld);
        }
        _s.copy(bs).applyMatrix4(_m);
        // vertical extent from the box: skip what lies flat
        const sy = Math.hypot(_m.elements[4], _m.elements[5], _m.elements[6]);
        const top = _m.elements[13] + bb.max.y * sy;
        if (top < minTop) continue;
        // footprint radius: the horizontal half-extent of the box, scaled
        const sx = Math.hypot(_m.elements[0], _m.elements[1], _m.elements[2]);
        const sz = Math.hypot(_m.elements[8], _m.elements[9], _m.elements[10]);
        const hx = Math.max(Math.abs(bb.max.x), Math.abs(bb.min.x)) * sx;
        const hz = Math.max(Math.abs(bb.max.z), Math.abs(bb.min.z)) * sz;
        // tall slender things (trunks) are mostly canopy: the solid part at
        // hull height is narrower than the crown — take 60% of the reach
        const r = Math.min(_s.radius, Math.max(hx, hz)) * 0.6;
        if (r > maxR || r < 0.25) continue;
        list.push({ x: _s.center.x, z: _s.center.z, r });
      }
    });
  }
  const grid = new Map();
  const key = (i, j) => i * 73856093 ^ j * 19349663;
  for (const c of list) {
    const i0 = Math.floor((c.x - c.r) / cell), i1 = Math.floor((c.x + c.r) / cell);
    const j0 = Math.floor((c.z - c.r) / cell), j1 = Math.floor((c.z + c.r) / cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        let b = grid.get(k);
        if (!b) grid.set(k, (b = []));
        b.push(c);
      }
    }
  }
  return {
    count: list.length,
    /** every disc within `reach` of the segment box around (x0,z0)-(x1,z1) */
    near(x0, z0, x1, z1, reach, out) {
      const seen = new Set();
      const i0 = Math.floor((Math.min(x0, x1) - reach) / cell);
      const i1 = Math.floor((Math.max(x0, x1) + reach) / cell);
      const j0 = Math.floor((Math.min(z0, z1) - reach) / cell);
      const j1 = Math.floor((Math.max(z0, z1) + reach) / cell);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) return out;   // absurd span: skip
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const b = grid.get(key(i, j));
          if (!b) continue;
          for (const c of b) if (!seen.has(c)) { seen.add(c); out.push(c); }
        }
      }
      return out;
    },
  };
}

/* ── planning ──────────────────────────────────────────────────────────── */

/**
 * planRoute(raw, solids, opts) → { pts: Vector3[], cum: number[], total }
 *
 * raw      control points; raw[0] is where the vessel is now, the last one
 *          the berth. Interior points are where the lane wants it to pass.
 * solids   [{x, z, r}] discs to keep clear of (r already includes clearance)
 * opts.heading  current bow yaw (scene convention: forward = (cos y, 0, -sin y));
 *               the route leaves along it so the hull never pivots in place
 * opts.walk     a walker: no lead-out swing, tighter corner rounding
 * opts.spacing  sample spacing of the finished curve (default 1 wu)
 * opts.constrain(p)  optional: pull a free sample back inside the playable
 *               area (the hub's mountain wall) — mutates p
 */
export function planRoute(raw, solids, opts = {}) {
  const spacing = opts.spacing ?? 1.0;
  const start = raw[0].clone();
  const end = raw[raw.length - 1].clone();
  start.y = end.y = 0;
  // 1 · control polygon, with a LEAD point off the bow so the curve departs
  //     along the current heading and swings round in a real turning circle
  const ctrl = [start];
  const direct = start.distanceTo(end);
  if (!opts.walk && opts.heading != null && direct > 3) {
    const lead = Math.min(7, Math.max(2.5, direct * 0.22));
    ctrl.push(new THREE.Vector3(start.x + Math.cos(opts.heading) * lead, 0,
                                start.z - Math.sin(opts.heading) * lead));
  }
  for (let i = 1; i < raw.length - 1; i++) {
    const p = raw[i].clone();
    p.y = 0;
    if (p.distanceTo(ctrl[ctrl.length - 1]) > 1.5) ctrl.push(p);
  }
  if (end.distanceTo(ctrl[ctrl.length - 1]) < 0.5 && ctrl.length > 1) ctrl.pop();
  ctrl.push(end);
  const nFixedHead = opts.walk || opts.heading == null || direct <= 3 ? 1 : 2;

  // solids the vessel is ALREADY inside the clearance of (it berthed snug
  // against an island, or its berth is snug against one) keep only the
  // clearance the endpoint has — else the first sample would be flung out
  const eff = [];
  for (const c of solids) {
    const ds = Math.hypot(c.x - start.x, c.z - start.z);
    const de = Math.hypot(c.x - end.x, c.z - end.z);
    const r = Math.min(c.r, ds - 0.4, de - 0.4);
    if (r > 0.3) eff.push({ x: c.x, z: c.z, r });
  }

  // 2 · densify the polygon (~2 wu) — corners get ROUNDED by the relaxation
  let pts = [];
  const fixed = [];
  for (let i = 0; i < ctrl.length; i++) {
    pts.push(ctrl[i].clone());
    fixed.push(i < nFixedHead || i === ctrl.length - 1);
    if (i === ctrl.length - 1) break;
    const a = ctrl[i], b = ctrl[i + 1];
    const n = Math.max(1, Math.ceil(a.distanceTo(b) / 2));
    for (let s = 1; s < n; s++) {
      pts.push(new THREE.Vector3().lerpVectors(a, b, s / n));
      fixed.push(false);
    }
  }
  const pushOut = () => {
    for (let i = 0; i < pts.length; i++) {
      if (fixed[i]) continue;
      const p = pts[i];
      for (const c of eff) {
        const dx = p.x - c.x, dz = p.z - c.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= c.r * c.r) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-4) {
          p.x = c.x + dx / d * c.r;
          p.z = c.z + dz / d * c.r;
        } else {
          // dead centre: step off to the side of the local direction
          const q = pts[Math.max(0, i - 1)], w = pts[Math.min(pts.length - 1, i + 1)];
          const tx = w.x - q.x, tz = w.z - q.z, tl = Math.hypot(tx, tz) || 1;
          p.x = c.x - tz / tl * c.r;
          p.z = c.z + tx / tl * c.r;
        }
      }
      if (opts.constrain) opts.constrain(p);
    }
  };
  // a walker keeps tight to its trail (stones): little rounding; a hull
  // gets several passes so corners open into proper arcs
  const passes = opts.walk ? 2 : 7;
  const k = opts.walk ? 0.25 : 0.5;
  pushOut();
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      if (fixed[i]) continue;
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      p.x += ((a.x + b.x) * 0.5 - p.x) * k;
      p.z += ((a.z + b.z) * 0.5 - p.z) * k;
    }
    pushOut();
  }

  // 3 · a centripetal Catmull–Rom through the relaxed samples, resampled at
  //     even spacing — no corner snaps, constant speed along the curve
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const L = curve.getLength();
  const n = Math.max(2, Math.ceil(L / spacing));
  const out = curve.getSpacedPoints(n);
  // the spline can sag a hair back into a disc between samples: final nudge
  for (let i = 1; i < out.length - 1; i++) {
    const p = out[i];
    p.y = 0;
    for (const c of eff) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d < c.r && d > 1e-4) { p.x = c.x + dx / d * c.r; p.z = c.z + dz / d * c.r; }
    }
    if (opts.constrain) opts.constrain(p);
  }
  out[0].copy(start);
  out[out.length - 1].copy(end);
  const cum = [0];
  for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + out[i].distanceTo(out[i - 1]));
  return { pts: out, cum, total: cum[cum.length - 1] };
}

/* ── following ─────────────────────────────────────────────────────────── */

/**
 * Point + tangent at arc length s. `hint` is the segment index to start the
 * search from (routes are walked forward, so this is O(1) amortised); the
 * index found is returned so the caller can keep it.
 */
export function routeAt(route, s, outPos, outDir, hint = 0) {
  const { pts, cum } = route;
  const last = pts.length - 1;
  s = Math.max(0, Math.min(route.total, s));
  let i = Math.min(Math.max(0, hint), last - 1);
  while (i < last - 1 && cum[i + 1] < s) i++;
  while (i > 0 && cum[i] > s) i--;
  const seg = cum[i + 1] - cum[i];
  const f = seg > 1e-6 ? (s - cum[i]) / seg : 1;
  outPos.lerpVectors(pts[i], pts[i + 1], f);
  // tangent from a short window around the sample: steady, never zero
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(last, i + 2)];
  outDir.subVectors(b, a);
  outDir.y = 0;
  if (outDir.lengthSq() < 1e-8) outDir.set(1, 0, 0);
  else outDir.normalize();
  return i;
}

const TAU = Math.PI * 2;
/** Swing `yaw` toward the heading of direction (dx, dz), at most `rate` rad/s. */
export function helm(yaw, dx, dz, dt, rate = 2.4, follow = 9) {
  const want = Math.atan2(-dz, dx);
  let diff = want - yaw;
  diff -= Math.round(diff / TAU) * TAU;
  // exponential follow, capped: a smooth swing that can't spin on the spot
  let step = diff * Math.min(1, dt * follow);
  const cap = rate * dt;
  if (step > cap) step = cap; else if (step < -cap) step = -cap;
  return yaw + step;
}

/** sine ease-in-out: the hull gathers way and coasts in, with a cruising
 *  peak only ~1.6× the mean speed (the quad ease peaked at 2×) */
export function easeVoyage(k) {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));
}

/** smoothstep */
export const smooth01 = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

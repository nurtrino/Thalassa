/*
 * chart.js — THE VOYAGE CHART (the chart button / key M).
 *
 * A hand-inked 2D sea chart drawn on one <canvas> over a parchment sheet,
 * in the "Aegean bronze" language: vellum, sepia ink, bronze structure,
 * Cinzel/Alegreya. It replaces the old zoomed-out 3D "aerial view" (which
 * re-rendered the whole stage from altitude, buried the lanes under terrain
 * and could not show anything off-stage).
 *
 * The chart is one continuous map of the WHOLE board in world coordinates
 * (x → right, z → down: the Frostfang Reach is north, the Bleached Reach
 * south, the Verdigris Deep west, the Amber Vale east). Two framings:
 *   · HERE  — fitted to the stage you are on (hub ring or one realm)
 *   · WORLD — the hub ring and all four realms, every captain at a glance
 * Level of detail follows the zoom: waypoints, icons and names fade in as
 * you zoom, realm titles take over as you zoom out.
 *
 * Reads ONLY the room snapshot (getRoom()) — no server knowledge beyond
 * Game.to_dict. Optional snapshot fields (roaming world events, bounties)
 * are drawn when present and ignored when not.
 *
 * The Amber Vale is a fog-of-war maze: the chart only inks Vale stops your
 * own lantern has found (a client-side lantern: LANTERN hops round every
 * stop you have stood on, plus whatever your roll can reach), remembered
 * per voyage in localStorage. A server-sent `seen`/`vale_seen` list, if one
 * ever ships, is honoured instead. Everything unexplored is vellum.
 *
 * Cost: while the sheet is fully open the 3D world is paused
 * (world.pauseRender) — the chart is opaque, so the GPU idles. The canvas
 * redraws only when something changed; the only animation (reachable-stop
 * pulse, the turn ring) runs at ≤ 30 fps.
 *
 * API: createChart({ world, getRoom, getYou, onPick, onToggle, isDev, sfx })
 *        → { open(opts), close(), toggle(), isOpen(), sync() }
 */
import { icon, esc } from './ui.js';
import { DOMAIN_COLORS, REALM_INFO } from './themes.js';
import { sailDevice } from './ship.js';

const REALMS = ['ice', 'desert', 'jungle', 'autumn'];
const LANTERN = 3;                       // == game.VALE_LANTERN
const INK = '#2c2212';
const INK_SOFT = 'rgba(44, 34, 18, .62)';
const PAPER = '#efe3c4';
const GOLD = '#c9a227';
const REALM_WASH = {
  ice: 'rgba(127, 196, 228, .30)', desert: 'rgba(222, 178, 98, .36)',
  jungle: 'rgba(86, 160, 104, .28)', autumn: 'rgba(226, 140, 60, .26)',
};
const REALM_INK = {
  ice: '#2f6f8c', desert: '#8a5a1c', jungle: '#2f6b3e', autumn: '#97501c', hub: '#6b4c12',
};
const STYLE = {
  home:    { icon: 'home',    fill: '#b08a1e', label: 'Home Port',      rank: 3, big: 1.2 },
  pharos:  { icon: 'tower',   fill: '#5b3f86', label: 'The Pharos',     rank: 3, big: 1.35 },
  shrine:  { icon: 'laurel',  fill: '#2e9e8f', label: 'Oracle',         rank: 1 },
  puzzle:  { icon: 'fitting', fill: '#5c5096', label: 'Puzzle spire',   rank: 1 },
  haven:   { icon: 'anchor',  fill: '#2f6283', label: 'Haven',          rank: 2 },
  shop:    { icon: 'market',  fill: '#3d7f4f', label: 'Trader',         rank: 1 },
  monster: { icon: 'spears',  fill: '#a4532a', label: 'Hunting ground', rank: 1 },
  lair:    { icon: 'skull',   fill: '#7e2418', label: 'Boss lair',      rank: 3, big: 1.2 },
  gate:    { icon: 'arch',    fill: '#3a3226', label: 'Mountain pass',  rank: 3, big: 1.1 },
};

/* chart-only glyphs, drawn in the ui.js icon contract (24-grid strokes) */
const EXTRA = {
  tower: 'M8.5 20.5h7M9.4 20.5l1.1-10.5h3l1.1 10.5M9.8 10h4.4M10.5 10V7h3v3M12 7V4.6' +
    'M5.6 6.4l2.6 1.2M18.4 6.4l-2.6 1.2M5.2 10h2.4M18.8 10h-2.4',
  spears: 'M5 19 19 5M19 5l-4.2.9M19 5l-.9 4.2M19 19 5 5M5 5l4.2.9M5 5l.9 4.2' +
    'M7.6 13.8l2.6 2.6M16.4 13.8l-2.6 2.6',
  arch: 'M3.5 20.5h17M5.5 20.5V10.4a6.5 6.5 0 0 1 13 0v10.1M9 20.5v-9.3a3 3 0 0 1 6 0v9.3',
  serpent: 'M2.8 15.5c1.8-3.4 4.4-3.4 6.2 0s4.4 3.4 6.2 0 3.6-4.6 5.4-3.6' +
    'M20.6 11.9l1.1-1.4M19.2 11.4l.3-1.8',
};

/* ── tiny helpers ──────────────────────────────────────────────────────── */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/* ui.js icons → Path2D (stroke + filled accents), cached */
const _glyph = new Map();
function glyph(name) {
  let g = _glyph.get(name);
  if (g) return g;
  const stroke = new Path2D(), fill = new Path2D();
  if (EXTRA[name]) {
    stroke.addPath(new Path2D(EXTRA[name]));
  } else {
    const svg = icon(name);
    const re = /<(path|circle|rect)\b([^>]*)\/>/g;
    let m;
    while ((m = re.exec(svg))) {
      const a = {};
      m[2].replace(/([a-z-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; return ''; });
      let p = new Path2D();
      if (m[1] === 'path') p = new Path2D(a.d);
      else if (m[1] === 'circle') p.arc(+a.cx, +a.cy, +a.r, 0, Math.PI * 2);
      else {
        const x = +a.x, y = +a.y, w = +a.width, h = +a.height, r = +(a.rx || 0);
        p.roundRect ? p.roundRect(x, y, w, h, r) : p.rect(x, y, w, h);
        const rot = /rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)/.exec(a.transform || '');
        if (rot) {
          const q = new Path2D();
          q.addPath(p, new DOMMatrix().translateSelf(+rot[2], +rot[3])
            .rotateSelf(+rot[1]).translateSelf(-rot[2], -rot[3]));
          p = q;
        }
      }
      (a.fill === 'currentColor' ? fill : stroke).addPath(p);
    }
  }
  g = { stroke, fill };
  _glyph.set(name, g);
  return g;
}
function drawGlyph(ctx, name, x, y, size, color, lw = 1.9) {
  const g = glyph(name);
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke(g.stroke); ctx.fill(g.fill);
  ctx.restore();
}

/* convex hull (monotone chain) of [x,z] points */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}
/* inflate a convex polygon and resample it into a wobbly "coastline" ring */
function coastRing(poly, pad, seed, step = 26) {
  if (poly.length < 3) return [];
  let cx = 0, cz = 0;
  for (const [x, z] of poly) { cx += x; cz += z; }
  cx /= poly.length; cz /= poly.length;
  const big = poly.map(([x, z]) => {
    const dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz) || 1;
    return [x + dx / L * pad, z + dz / L * pad];
  });
  const out = [], r = rng(seed);
  for (let i = 0; i < big.length; i++) {
    const a = big[i], b = big[(i + 1) % big.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const dx = x - cx, dz = z - cz, D = Math.hypot(dx, dz) || 1;
      const j = (r() - 0.5) * pad * 0.34;
      out.push([x + dx / D * j, z + dz / D * j]);
    }
  }
  return out;
}
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/* ── paper, sea hatching and the compass rose (built once) ─────────────── */
function makePaperTile() {
  const S = 384, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = PAPER; c.fillRect(0, 0, S, S);
  const r = rng(7);
  const img = c.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 14;
    d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.8;
  }
  c.putImageData(img, 0, 0);
  for (let i = 0; i < 26; i++) {                    // foxing + tea stains
    const x = r() * S, y = r() * S, rad = 10 + r() * 60;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(140, 100, 40, ${0.03 + r() * 0.05})`);
    g.addColorStop(1, 'rgba(140, 100, 40, 0)');
    c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  c.lineCap = 'round';
  for (let i = 0; i < 900; i++) {                   // vellum fibres
    const x = r() * S, y = r() * S, a = r() * Math.PI, L = 2 + r() * 7;
    c.strokeStyle = `rgba(${r() < 0.5 ? '90,64,24' : '255,250,235'}, ${0.05 + r() * 0.07})`;
    c.lineWidth = 0.6;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); c.stroke();
  }
  return cv;
}
function makeWaveTile() {
  const W = 46, H = 15, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.strokeStyle = 'rgba(38, 78, 92, .20)'; c.lineWidth = 0.9; c.lineCap = 'round';
  c.beginPath();
  c.moveTo(4, 9); c.quadraticCurveTo(9, 5, 14, 9); c.quadraticCurveTo(19, 13, 24, 9);
  c.moveTo(27, 3); c.quadraticCurveTo(31, 0.5, 35, 3);
  c.stroke();
  return cv;
}
function makeHatchTile() {
  const S = 14, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.strokeStyle = 'rgba(70, 50, 20, .16)'; c.lineWidth = 0.8;
  c.beginPath(); c.moveTo(0, S); c.lineTo(S, 0); c.moveTo(-2, 2); c.lineTo(2, -2);
  c.moveTo(S - 2, S + 2); c.lineTo(S + 2, S - 2); c.stroke();
  return cv;
}
function makeRose(px, dpr) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.round(px * dpr);
  const c = cv.getContext('2d');
  c.scale(dpr, dpr);
  const R = px / 2, o = R;
  c.translate(o, o);
  c.strokeStyle = INK; c.lineWidth = 1;
  c.globalAlpha = 0.85;
  c.beginPath(); c.arc(0, 0, R * 0.78, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(0, 0, R * 0.70, 0, Math.PI * 2); c.stroke();
  for (let i = 0; i < 32; i++) {
    const a = i / 32 * Math.PI * 2;
    c.beginPath();
    c.moveTo(Math.cos(a) * R * 0.70, Math.sin(a) * R * 0.70);
    c.lineTo(Math.cos(a) * R * (i % 4 ? 0.74 : 0.78), Math.sin(a) * R * (i % 4 ? 0.74 : 0.78));
    c.stroke();
  }
  const point = (a, len, w, light) => {
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(Math.cos(a) * len, Math.sin(a) * len);
      c.lineTo(Math.cos(a + side * Math.PI / 2) * w, Math.sin(a + side * Math.PI / 2) * w);
      c.closePath();
      c.fillStyle = (side < 0) === light ? '#f3e8cc' : (light ? '#a8841f' : INK);
      c.fill(); c.stroke();
    }
  };
  for (let i = 0; i < 4; i++) point(Math.PI / 4 + i * Math.PI / 2, R * 0.48, R * 0.09, true);
  for (let i = 0; i < 4; i++) point(-Math.PI / 2 + i * Math.PI / 2, R * 0.74, R * 0.13, i !== 0);
  c.globalAlpha = 1;
  c.beginPath(); c.arc(0, 0, R * 0.06, 0, Math.PI * 2); c.fillStyle = GOLD; c.fill(); c.stroke();
  c.font = `700 ${Math.round(R * 0.30)}px Cinzel, serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = INK;
  c.fillText('N', 0, -R * 0.90);
  return cv;
}

/* ═══════════════════════════════════════════════════════════════════════ */
export function createChart({ world, getRoom, getYou, onPick, onToggle = null, isDev = () => false, sfx = null }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let root = null, sheet = null, cv = null, ctx = null, tip = null;
  let W = 0, H = 0, dpr = 1;
  let open = false, closing = false, loop = 0, dirty = true, lastDraw = 0;
  let paperTile = null, wavePat = null, hatchPat = null, paperCv = null, roseCv = null;
  let fogCv = null, fogCtx = null;
  let tab = 'here', hereStage = 'hub';
  const view = { cx: 0, cz: 0, s: 0.5 };
  let anim = null;                         // {from, to, t0, dur}
  let dropX = 0;                           // timestamp of the sword X drop
  let board = null;                        // derived geometry, keyed by board signature
  const hits = [];
  const stats = { frames: 0, ms: 0 };
  window.__chartStats = () => ({ frames: stats.frames, avgMs: stats.frames ? +(stats.ms / stats.frames).toFixed(2) : 0 });
  // QA handle: client coords of a stop on the sheet (a reachable one if asked)
  window.__chartProbe = (reachOnly) => {
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const h = hits.find((q) => q.kind === 'node' && (reachOnly ? q.reach : q.pri === 1)
      && q.x > 40 && q.y > 120 && q.x < W - 300 && q.y < H - 80);
    return h ? { x: r.left + h.x, y: r.top + h.y, id: h.id } : null;
  };

  /* ── the Vale lantern (client-side fog of war) ───────────────────────── */
  let valeKey = '', valeSeen = new Set();
  function valeSync(room, me, B) {
    if (!B.vale.length) return;
    const key = `thalassa_vale:${room.code}:${me?.pid}:${B.valeSig}`;
    if (key !== valeKey) {
      valeKey = key;
      valeSeen = new Set();
      try { for (const id of JSON.parse(localStorage.getItem(key) || '[]')) valeSeen.add(id); } catch (e) { /* private mode */ }
    }
    const server = me?.seen || me?.vale_seen || room.vale_seen;
    if (Array.isArray(server)) { valeSeen = new Set(server); return; }
    const before = valeSeen.size;
    const light = (from, radius) => {
      if (!B.byId.has(from)) return;
      const depth = new Map([[from, 0]]), q = [from];
      while (q.length) {
        const cur = q.shift(), d = depth.get(cur);
        const n = B.byId.get(cur);
        if (n && n.region === 'autumn') valeSeen.add(cur);
        if (d >= radius) continue;
        for (const nb of B.adj.get(cur) || []) {
          if (depth.has(nb)) continue;
          const m = B.byId.get(nb);
          // the lantern walks the Vale's own trails — never back out to sea
          if (!m || (m.region !== 'autumn' && m.type !== 'gate')) continue;
          depth.set(nb, d + 1); q.push(nb);
        }
      }
    };
    if (me) {
      const n = B.byId.get(me.node);
      if (n && n.region === 'autumn') light(me.node, LANTERN);
      const ck = B.byId.get(me.checkpoint);
      if (ck && ck.region === 'autumn') valeSeen.add(ck.id);
      if (room.turn === me.pid) {
        const reach = Object.keys(room.reachable || {});
        if (reach.some((id) => B.byId.get(id)?.region === 'autumn')) {
          light(me.node, Math.max(LANTERN, (room.die || 0) + 1));
          for (const id of reach) valeSeen.add(id);
        }
        for (const id of room.walk?.options || []) valeSeen.add(id);
      }
    }
    if (valeSeen.size !== before) {
      try { localStorage.setItem(valeKey, JSON.stringify([...valeSeen])); } catch (e) { /* full / private */ }
    }
  }
  const shownNode = (n) => n && (n.region !== 'autumn' || n.type === 'gate' || valeSeen.has(n.id) || isDev());

  /* ── derived board geometry (rebuilt only when the board changes) ────── */
  function derive(room) {
    const nodes = room.board?.nodes || [];
    const edges = room.board?.edges || [];
    const sig = nodes.length + ':' + edges.length + ':' + (nodes[0]?.id || '') + ':' + (nodes[nodes.length - 1]?.id || '');
    if (board && board.sig === sig) return board;
    const byId = new Map(), adj = new Map();
    for (const n of nodes) { byId.set(n.id, n); adj.set(n.id, []); }
    for (const [a, b] of edges) { adj.get(a)?.push(b); adj.get(b)?.push(a); }
    const stageOf = (n) => (n.type === 'gate' || !n.region ? 'hub' : n.region);
    const hubNodes = nodes.filter((n) => !n.region && n.type !== 'gate');
    const gates = nodes.filter((n) => n.type === 'gate');
    let hubR = 0;
    for (const n of hubNodes) hubR = Math.max(hubR, Math.hypot(n.x, n.z));
    hubR = hubR || 450;
    const wallR = gates.length
      ? gates.reduce((s, g) => s + Math.hypot(g.x, g.z), 0) / gates.length
      : hubR + 45;
    const realms = {};
    for (const id of REALMS) {
      const mem = nodes.filter((n) => n.region === id && n.type !== 'gate');
      if (!mem.length) continue;
      const gate = gates.find((g) => g.region === id);
      const pts = mem.map((n) => [n.x, n.z]);
      if (gate) pts.push([gate.x, gate.z]);
      const ring = coastRing(hull(pts), 62, hashStr('realm:' + id));
      let cx = 0, cz = 0;
      for (const n of mem) { cx += n.x; cz += n.z; }
      cx /= mem.length; cz /= mem.length;
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const [x, z] of ring) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      // scattered motifs (dunes, floes, tree crowns) clear of every stop
      const r = rng(hashStr('motif:' + id)), motifs = [];
      for (let i = 0; i < 260 && motifs.length < 70; i++) {
        const x = minX + r() * (maxX - minX), z = minZ + r() * (maxZ - minZ);
        if (!pointInPoly(x, z, ring)) continue;
        if (mem.some((n) => Math.hypot(n.x - x, n.z - z) < 30)) continue;
        motifs.push([x, z, r()]);
      }
      const lair = mem.find((n) => n.type === 'lair') || null;
      realms[id] = { id, ring, cx, cz, gate, lair, motifs, mode: room.board.regions?.[id]?.mode,
        name: room.board.regions?.[id]?.name || REALM_INFO[id]?.name || id,
        boss: room.board.regions?.[id]?.boss || lair?.boss_name || '',
        bounds: { minX, maxX, minZ, maxZ } };
    }
    // the island blob for every point of interest: a seeded wobbly outline
    const blobs = new Map();
    for (const n of nodes) {
      if (n.type === 'sea' && n.look !== 'islet') continue;
      const r = rng(hashStr('isle:' + n.id)), k = 9, pts = [];
      for (let i = 0; i < k; i++) {
        const a = i / k * Math.PI * 2 + r() * 0.3;
        pts.push([Math.cos(a) * (0.78 + r() * 0.36), Math.sin(a) * (0.70 + r() * 0.34)]);
      }
      blobs.set(n.id, pts);
    }
    // the whole world's bounds
    let minX = -wallR - 80, maxX = wallR + 80, minZ = -wallR - 80, maxZ = wallR + 80;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - 80); maxX = Math.max(maxX, n.x + 80);
      minZ = Math.min(minZ, n.z - 80); maxZ = Math.max(maxZ, n.z + 80);
    }
    const vale = nodes.filter((n) => n.region === 'autumn' && n.type !== 'gate');
    const valeLair = vale.find((n) => n.type === 'lair');
    // wanderers' corners: the empty diagonals between the realms
    const serpents = [0.25, 0.75, 1.25, 1.75].map((f, i) => {
      const a = f * Math.PI, R = wallR + 300;
      return { x: Math.cos(a) * R, z: Math.sin(a) * R, flip: i % 2 };
    });
    board = { sig, byId, adj, stageOf, hubR, wallR, gates, realms, blobs, vale, serpents,
      valeSig: (valeLair?.id || '') + vale.length,
      // room round the edge for the realms' title ribbons
      world: { minX: minX - 60, maxX: maxX + 60, minZ: minZ - 200, maxZ: maxZ + 200 },
      hub: { minX: -wallR - 70, maxX: wallR + 70, minZ: -wallR - 70, maxZ: wallR + 70 } };
    return board;
  }

  /* ── framing ─────────────────────────────────────────────────────────── */
  function insets() {
    const phone = W < 720;
    if (phone) return { l: 8, t: 112, r: 8, b: 150 };
    const key = root?.classList.contains('keyopen') ? 236 : 0;
    return { l: 24 + key, t: 92, r: 286, b: 64 };
  }
  function fitTo(b, pad = 1) {
    const ins = insets();
    const aw = Math.max(80, W - ins.l - ins.r), ah = Math.max(80, H - ins.t - ins.b);
    const s = Math.min(aw / (b.maxX - b.minX), ah / (b.maxZ - b.minZ)) * pad;
    const mx = (ins.l + (W - ins.r)) / 2 - W / 2, my = (ins.t + (H - ins.b)) / 2 - H / 2;
    return { cx: (b.minX + b.maxX) / 2 - mx / s, cz: (b.minZ + b.maxZ) / 2 - my / s, s };
  }
  function stageBounds(stage) {
    const B = board;
    if (!B) return { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
    if (stage !== 'hub' && B.realms[stage]) return B.realms[stage].bounds;
    return B.hub;
  }
  const sLimits = () => {
    const wf = board ? fitTo(board.world).s : 0.2;
    return [wf * 0.8, Math.max(2.4, wf * 14)];
  };
  function clampView(v) {
    const [lo, hi] = sLimits();
    v.s = clamp(v.s, lo, hi);
    const b = board?.world || { minX: -900, maxX: 900, minZ: -900, maxZ: 900 };
    v.cx = clamp(v.cx, b.minX, b.maxX);
    v.cz = clamp(v.cz, b.minZ, b.maxZ);
    return v;
  }
  function goTo(to, animate = true) {
    clampView(to);
    if (!animate || reduce.matches || !open) {
      anim = null; view.cx = to.cx; view.cz = to.cz; view.s = to.s;
    } else {
      anim = { from: { ...view }, to, t0: performance.now(), dur: 420 };
    }
    dirty = true;
  }
  function frame(which) {
    tab = which;
    paintTabs();
    goTo(which === 'world' ? fitTo(board.world) : fitTo(stageBounds(hereStage)));
    renderCartouche();
  }
  const SX = (x) => (x - view.cx) * view.s + W / 2;
  const SY = (z) => (z - view.cz) * view.s + H / 2;

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  function build() {
    root = document.createElement('div');
    root.id = 'chart';
    root.className = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Chart of the voyage');
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="ch-sheet">
        <canvas class="ch-canvas" aria-hidden="true"></canvas>
        <div class="ch-top">
          <div class="ch-tabs" role="tablist">
            <button class="ch-tab" data-tab="here" role="tab"></button>
            <button class="ch-tab" data-tab="world" role="tab">${icon('compass', 15)}<span>World</span></button>
          </div>
          <div class="ch-cart"><div class="ch-cart-t"></div><div class="ch-cart-s"></div></div>
          <button class="ch-close" aria-label="Close the chart" title="Close (Esc)">${icon('kick', 18)}</button>
        </div>
        <aside class="ch-fleet" aria-label="Captains"></aside>
        <div class="ch-legend">
          <button class="ch-keybtn" aria-expanded="false">${icon('scroll', 14)}<span>Key</span></button>
          <div class="ch-keylist"></div>
        </div>
        <div class="ch-zoom">
          <button data-z="in" aria-label="Zoom in">+</button>
          <button data-z="out" aria-label="Zoom out">&minus;</button>
          <button data-z="me" aria-label="Find my ship" title="Find my ship">${icon('hull', 17)}</button>
        </div>
        <div class="ch-status" aria-live="polite"></div>
        <div class="ch-tip hidden"></div>
        <div class="ch-rod top"></div><div class="ch-rod bot"></div>
      </div>`;
    document.body.appendChild(root);
    sheet = root.querySelector('.ch-sheet');
    cv = root.querySelector('.ch-canvas');
    ctx = cv.getContext('2d');
    tip = root.querySelector('.ch-tip');
    root.querySelector('.ch-close').onclick = () => closeChart();
    for (const b of root.querySelectorAll('.ch-tab')) b.onclick = () => { click(); frame(b.dataset.tab); };
    root.querySelector('.ch-zoom').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      click();
      if (b.dataset.z === 'me') return focusPid(getYou());
      zoomAt(W / 2, H / 2, b.dataset.z === 'in' ? 1.6 : 1 / 1.6);
    };
    const keyBtn = root.querySelector('.ch-keybtn');
    keyBtn.onclick = () => {
      const on = !root.classList.contains('keyopen');
      root.classList.toggle('keyopen', on);
      keyBtn.setAttribute('aria-expanded', String(on));
      try { localStorage.setItem('thalassa_chartkey', on ? '1' : '0'); } catch (e) { /* ignore */ }
      if (W >= 720) frame(tab);
    };
    let keyPref = null;
    try { keyPref = localStorage.getItem('thalassa_chartkey'); } catch (e) { /* ignore */ }
    const keyOn = keyPref ? keyPref === '1' : innerWidth >= 720;
    root.classList.toggle('keyopen', keyOn);
    keyBtn.setAttribute('aria-expanded', String(keyOn));
    root.querySelector('.ch-keylist').innerHTML = legendHtml();
    root.querySelector('.ch-fleet').addEventListener('click', (e) => {
      const row = e.target.closest('[data-pid]');
      if (row) { click(); focusPid(row.dataset.pid); }
    });
    bindPointer();
    new ResizeObserver(() => { if (open) resize(); }).observe(sheet);
    paperTile = makePaperTile();
    wavePat = ctx.createPattern(makeWaveTile(), 'repeat');
    hatchPat = ctx.createPattern(makeHatchTile(), 'repeat');
    document.fonts?.ready?.then(() => { roseCv = null; dirty = true; });
  }
  function click() { sfx?.click?.(); }

  function legendHtml() {
    const med = (type, fill, glyphName) => `<span class="ch-med" style="--m:${fill}">${glyphSvg(glyphName)}</span>`;
    const row = (m, t) => `<div class="ch-krow">${m}<span>${t}</span></div>`;
    const dom = Object.values(DOMAIN_COLORS).map((c) => `<i style="background:${c}"></i>`).join('');
    return [
      row(med('home', STYLE.home.fill, 'home'), 'Home Port — bank your seals'),
      row(med('pharos', STYLE.pharos.fill, 'tower'), 'The Pharos'),
      row(`<span class="ch-med" style="--m:${STYLE.shrine.fill}">${glyphSvg('laurel')}</span>`, `Oracle <span class="ch-doms">${dom}</span>`),
      row(med('puzzle', STYLE.puzzle.fill, 'fitting'), 'Puzzle spire'),
      row(med('haven', STYLE.haven.fill, 'anchor'), 'Haven — checkpoint'),
      row(med('shop', STYLE.shop.fill, 'market'), 'Trader'),
      row(med('monster', STYLE.monster.fill, 'spears'), 'Hunting ground'),
      row(med('lair', STYLE.lair.fill, 'skull'), 'Boss lair — a seal'),
      row(med('gate', STYLE.gate.fill, 'arch'), 'Mountain pass'),
      row('<span class="ch-k-way"></span>', 'Waypoint'),
      row('<span class="ch-k-reach"></span>', 'Within your roll — tap to sail'),
      row(`<span class="ch-k-ck">${glyphSvg('flag')}</span>`, 'Your checkpoint'),
    ].join('');
  }
  function glyphSvg(name) {
    if (!EXTRA[name]) return icon(name);
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${EXTRA[name]}"/></svg>`;
  }

  function paintTabs() {
    if (!root) return;
    const here = root.querySelector('[data-tab="here"]');
    const info = REALM_INFO[hereStage] || REALM_INFO.hub;
    here.innerHTML = `${icon(info.icon || 'hub', 15)}<span>${esc(shortName(hereStage))}</span>`;
    for (const b of root.querySelectorAll('.ch-tab')) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
  }
  const stageName = (st) => (st === 'hub' ? REALM_INFO.hub.name
    : board?.realms[st]?.name || REALM_INFO[st]?.name || st);
  const shortName = (st) => stageName(st).replace(/^The /, '');

  function renderCartouche() {
    if (!root) return;
    const room = getRoom();
    const t = root.querySelector('.ch-cart-t'), s = root.querySelector('.ch-cart-s');
    if (!room || !board) return;
    let title, sub;
    const nm = (pid) => room.players.find((p) => p.pid === pid)?.name || '?';
    if (tab === 'world') {
      title = 'The Known World';
      const slain = REALMS.filter((r) => board.realms[r]?.lair?.defeated?.length).length;
      sub = `${slain ? `${slain} of 4 tyrants have fallen` : 'Four tyrants hold the four seals'} · ` +
        (room.pharos_open ? 'the Pharos stands OPEN' : 'the Pharos is sealed');
    } else if (hereStage === 'hub') {
      title = REALM_INFO.hub.name;
      sub = room.pharos_open ? 'The Pharos stands open — storm it!'
        : `Win a seal in each realm, bank ${room.config?.relics_to_win || 3} at Home Port`;
    } else {
      const R = board.realms[hereStage];
      title = R?.name || stageName(hereStage);
      const who = R?.lair?.defeated || [];
      sub = R?.lair && R.lair.id && shownNode(R.lair)
        ? `${R.boss || 'Its tyrant'}${who.length ? ' — slain by ' + who.map(nm).join(', ') : ' waits in the barrow'}`
        : `${R?.boss || 'Its tyrant'} waits somewhere beyond`;
      if (hereStage === 'autumn') sub += ' · the woods show only what your lantern has found';
    }
    t.textContent = title;
    s.textContent = sub;
    const ink = tab === 'world' ? REALM_INK.hub : (REALM_INK[hereStage] || REALM_INK.hub);
    root.querySelector('.ch-cart').style.setProperty('--ri', ink);
  }

  function renderFleet() {
    const room = getRoom();
    const el = root?.querySelector('.ch-fleet');
    if (!el || !room) return;
    const you = getYou();
    const need = room.config?.relics_to_win || 3;
    // turn order, starting with whoever holds the helm
    const ps = room.players.slice();
    const ti = ps.findIndex((p) => p.pid === room.turn);
    const order = ti > 0 ? ps.slice(ti).concat(ps.slice(0, ti)) : ps;
    el.innerHTML = `<div class="ch-fh">Captains</div>` + order.map((p) => {
      const n = board?.byId.get(p.node);
      let where = '—';
      if (p.veiled || (n && n.region === 'autumn' && n.type !== 'gate' && !shownNode(n) && p.pid !== you)) where = 'somewhere in the Amber Vale';
      else if (n) {
        const st = n.type === 'gate' ? null : (n.region || 'hub');
        where = n.type === 'gate' ? `at the ${esc(n.name || 'pass')}`
          : `${esc(shortName(st))}${n.type !== 'sea' ? ' · ' + esc(n.name || STYLE[n.type]?.label || '') : ''}`;
      }
      let seals = '';
      for (let i = 0; i < need; i++) {
        const cls = i < p.banked ? 'bank' : i < p.banked + p.cargo ? 'carry' : '';
        seals += `<i class="ch-seal ${cls}">${icon('relic')}</i>`;
      }
      return `<button class="ch-cap${p.pid === you ? ' me' : ''}${p.pid === room.turn ? ' turn' : ''}" data-pid="${esc(p.pid)}" style="--pc:${esc(p.color)}">` +
        `<span class="ch-dot">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span>` +
        `<span class="ch-cn">${esc(p.name)}${p.pid === you ? ' <em>you</em>' : ''}${p.pid === room.turn ? ` <b class="ch-helm">${icon('hull', 12)} at the helm</b>` : ''}</span>` +
        `<span class="ch-cw">${where}</span>` +
        `<span class="ch-cs" title="${p.banked} banked · ${p.cargo} carried">${seals}</span></button>`;
    }).join('');
  }

  function renderStatus() {
    const room = getRoom(), el = root?.querySelector('.ch-status');
    if (!el || !room) return;
    const you = getYou();
    const turnP = room.players.find((p) => p.pid === room.turn);
    let txt;
    if (isDev()) txt = 'DEV — tap any stop to jump there';
    else if (room.turn === you && room.phase === 'sail' && Object.keys(room.reachable || {}).length) {
      txt = `You rolled <b>${room.die ?? '?'}</b> — tap a gilded ring to set sail`;
    } else if (room.turn === you && room.phase === 'roll') txt = 'Your turn — close the chart and cast the die';
    else if (room.turn === you) txt = 'Your turn';
    else txt = turnP ? `${esc(turnP.name)} is at the helm` : '';
    el.innerHTML = txt;
    el.classList.toggle('go', room.turn === you);
  }

  /* ── input ───────────────────────────────────────────────────────────── */
  function zoomAt(px, py, f) {
    const base = anim ? anim.to : view;
    const wx = (px - W / 2) / view.s + view.cx, wz = (py - H / 2) / view.s + view.cz;
    const [lo, hi] = sLimits();
    const s = clamp(base.s * f, lo, hi);
    goTo({ s, cx: wx - (px - W / 2) / s, cz: wz - (py - H / 2) / s }, true);
  }
  function panBy(dx, dy) {
    anim = null;
    view.cx -= dx / view.s; view.cz -= dy / view.s;
    clampView(view);
    dirty = true;
  }
  function bindPointer() {
    const pts = new Map();
    let downAt = null, moved = 0, pinch = null;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 1) { downAt = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType }; moved = 0; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
        downAt = null;                         // a pinch is never a tap
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const r = cv.getBoundingClientRect();
      if (pts.size >= 2 && pinch) {
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        panBy(mx - pinch.mx, my - pinch.my);
        const [lo, hi] = sLimits();
        const f = clamp(view.s * d / pinch.d, lo, hi) / view.s;
        const px = mx - r.left, py = my - r.top;
        const wx = (px - W / 2) / view.s + view.cx, wz = (py - H / 2) / view.s + view.cz;
        view.s *= f;
        view.cx = wx - (px - W / 2) / view.s; view.cz = wz - (py - H / 2) / view.s;
        clampView(view);
        pinch = { d, mx, my };
        return;
      }
      const dx = e.clientX - p[0], dy = e.clientY - p[1];
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      moved += Math.hypot(dx, dy);
      const slop = downAt?.type === 'touch' ? 14 : 6;
      if (moved > slop) { panBy(dx, dy); hideTip(); cv.classList.add('grab'); }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      cv.classList.remove('grab');
      if (e.type !== 'pointerup' || !downAt || pts.size) { if (!pts.size) downAt = null; return; }
      const slop = downAt.type === 'touch' ? 14 : 6;
      const quick = performance.now() - downAt.t < 650;
      downAt = null;
      if (moved > slop || !quick) return;
      const r = cv.getBoundingClientRect();
      tap(e.clientX - r.left, e.clientY - r.top, e.pointerType);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 0.05 : 0.0022;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * k * (e.ctrlKey ? 2.5 : 1)));
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, 2);
    });
  }
  function onKey(e) {
    if (!open || closing) return;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    const step = 90;
    const k = e.key;
    if (k === 'ArrowLeft') panBy(step, 0);
    else if (k === 'ArrowRight') panBy(-step, 0);
    else if (k === 'ArrowUp') panBy(0, step);
    else if (k === 'ArrowDown') panBy(0, -step);
    else if (k === '+' || k === '=') zoomAt(W / 2, H / 2, 1.5);
    else if (k === '-' || k === '_') zoomAt(W / 2, H / 2, 1 / 1.5);
    else if (k === 'w' || k === 'W') frame(tab === 'world' ? 'here' : 'world');
    else return;
    e.preventDefault();
  }

  function tap(x, y, ptype) {
    const reach = 24 + (ptype === 'touch' ? 8 : 0);
    let best = null, bd = 1e9;
    for (const h of hits) {
      const d = Math.hypot(h.x - x, h.y - y) - Math.max(h.r, reach) - h.pri * 6;
      if (Math.hypot(h.x - x, h.y - y) <= Math.max(h.r, reach) && d < bd) { bd = d; best = h; }
    }
    if (!best) { hideTip(); return; }
    const room = getRoom();
    if (best.kind === 'node' && (best.reach || isDev())) {
      click();
      onPick?.(best.id, !!best.walk);
      if (!isDev()) closeChart();
      return;
    }
    showTip(best, x, y, room);
  }
  function hideTip() { tip?.classList.add('hidden'); }
  function showTip(h, x, y, room) {
    let html = '';
    const nm = (pid) => room.players.find((p) => p.pid === pid)?.name || '?';
    if (h.kind === 'player') {
      const p = room.players.find((q) => q.pid === h.id);
      if (!p) return;
      const n = board.byId.get(p.node);
      html = `<b style="color:${esc(p.color)}">${esc(p.name)}</b>${p.pid === getYou() ? ' (you)' : ''}` +
        `<span>${n ? esc(n.name || STYLE[n.type]?.label || '') : ''}</span>` +
        `<span>${p.banked} banked · ${p.cargo} carried · hull ${p.hull}/${p.max_hull}</span>` +
        (p.pid === room.turn ? '<span class="ch-tipgo">at the helm</span>' : '');
    } else if (h.kind === 'roam') {
      html = `<b>${esc(h.name)}</b>${h.desc ? `<span>${esc(h.desc)}</span>` : ''}`;
    } else {
      const n = board.byId.get(h.id);
      if (!n) return;
      const st = STYLE[n.type];
      let kind = st?.label || 'Waypoint';
      const lines = [];
      if (n.type === 'shrine') {
        kind = `Oracle of ${n.domain ? n.domain[0].toUpperCase() + n.domain.slice(1) : '?'}`;
        if (n.charges != null) lines.push(`${n.charges} blessing${n.charges === 1 ? '' : 's'} left${n.tier ? ` · tier ${n.tier}` : ''}`);
      } else if (n.type === 'gate') {
        kind = 'Mountain pass'; lines.push(`to ${stageName(n.region)}`);
      } else if (n.type === 'lair') {
        kind = `Lair of ${n.boss_name || 'the tyrant'}`;
        lines.push(n.defeated?.length ? 'slain by ' + n.defeated.map(nm).join(', ') : 'guards this realm\'s seal');
      } else if (n.type === 'monster') {
        if (n.monster) lines.push(`${n.monster.name}${n.monster.count > 1 ? ' ×' + n.monster.count : ''}${n.elite ? ' · elite' : ''}`);
        else lines.push('cleared');
      } else if (n.type === 'puzzle') lines.push(n.solved ? 'solved' : 'unsolved');
      else if (n.type === 'haven') lines.push('a safe harbour — becomes your checkpoint');
      else if (n.type === 'pharos') lines.push(room.pharos_open ? 'OPEN — the Dark Presence waits' : 'sealed until a captain banks the seals');
      else if (n.type === 'sea' && n.flotsam) lines.push('flotsam drifts here');
      if (n.id === room.sword_node) lines.push('X marks the sword in the stone');
      const me = room.players.find((p) => p.pid === getYou());
      if (me?.checkpoint === n.id) lines.push('your checkpoint');
      if (h.reach) lines.push('within your roll — tap again to sail');
      const name = n.type === 'sea' ? '' : (n.name || '');
      html = `<b>${esc(name || kind)}</b>${name && name !== kind ? `<span class="ch-tipk">${esc(kind)}</span>` : ''}` +
        lines.map((l) => `<span>${esc(l)}</span>`).join('');
    }
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = clamp(x - tw / 2, 8, W - tw - 8) + 'px';
    tip.style.top = (y - th - 22 < 60 ? y + 22 : y - th - 22) + 'px';
  }

  function focusPid(pid) {
    const room = getRoom();
    const p = room?.players.find((q) => q.pid === pid);
    if (!p || !board) return;
    let n = board.byId.get(p.node);
    if (n && !shownNode(n)) n = board.realms.autumn?.gate || n;
    if (!n) return;
    const st = n.type === 'gate' ? 'hub' : (n.region || 'hub');
    const fit = fitTo(stageBounds(st));
    const s = Math.max(fit.s, view.s);
    const ins = insets();
    const mx = (ins.l + (W - ins.r)) / 2 - W / 2, my = (ins.t + (H - ins.b)) / 2 - H / 2;
    goTo({ s, cx: n.x - mx / s, cz: n.z - my / s });
  }

  /* ── sizing ──────────────────────────────────────────────────────────── */
  function resize() {
    const r = sheet.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    const nd = Math.min(2, window.devicePixelRatio || 1);
    if (nw === W && nh === H && nd === dpr && paperCv) return;
    const refit = W !== 0 && (nw !== W || nh !== H);
    W = nw; H = nh; dpr = nd;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    // the sheet itself: paper + burnt vignette, baked once per size
    paperCv = document.createElement('canvas');
    paperCv.width = cv.width; paperCv.height = cv.height;
    const c = paperCv.getContext('2d');
    c.scale(dpr, dpr);
    c.fillStyle = c.createPattern(paperTile, 'repeat');
    c.fillRect(0, 0, W, H);
    const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    g.addColorStop(0, 'rgba(120, 80, 30, 0)');
    g.addColorStop(0.75, 'rgba(120, 80, 30, .12)');
    g.addColorStop(1, 'rgba(70, 40, 10, .42)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    fogCv = document.createElement('canvas');
    fogCv.width = cv.width; fogCv.height = cv.height;
    fogCtx = fogCv.getContext('2d');
    roseCv = null;
    if (refit && board) goTo(tab === 'world' ? fitTo(board.world) : fitTo(stageBounds(hereStage)), false);
    dirty = true;
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function tracePoly(c, ring) {
    c.beginPath();
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const mx = SX((a[0] + b[0]) / 2), my = SY((a[1] + b[1]) / 2);
      if (i === 0) c.moveTo(mx, my);
      else c.quadraticCurveTo(SX(a[0]), SY(a[1]), mx, my);
    }
    const a = ring[0], b = ring[1 % n];
    c.quadraticCurveTo(SX(a[0]), SY(a[1]), SX((a[0] + b[0]) / 2), SY((a[1] + b[1]) / 2));
    c.closePath();
  }
  function anchorPattern(p, sc = 1) {
    if (!p.setTransform) return;
    p.setTransform(new DOMMatrix().translateSelf(SX(0) % 92, SY(0) % 30).scaleSelf(sc, sc));
  }
  function onScreen(x, y, m = 60) { return x > -m && y > -m && x < W + m && y < H + m; }

  function drawSeas(B) {
    const s = view.s, x0 = SX(0), y0 = SY(0);
    // the inner sea of the Isles: a tinted wash, wave hatching, coast ripples
    ctx.save();
    ctx.beginPath(); ctx.arc(x0, y0, B.wallR * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(70, 136, 146, .20)'; ctx.fill();
    ctx.clip();
    if (s > 0.18) { anchorPattern(wavePat); ctx.fillStyle = wavePat; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(40, 80, 92, .55)';
    for (const [k, a] of [[0, 0.55], [14, 0.30], [30, 0.18], [50, 0.10]]) {
      ctx.globalAlpha = a / 0.55;
      ctx.lineWidth = k ? 0.8 : 1.4;
      ctx.beginPath(); ctx.arc(x0, y0, Math.max(1, (B.wallR - 12 - k) * s), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawRealms(B, t) {
    const s = view.s;
    for (const id of REALMS) {
      const R = B.realms[id];
      if (!R || R.ring.length < 3) continue;
      const bb = R.bounds;
      if (SX(bb.maxX) < -40 || SX(bb.minX) > W + 40 || SY(bb.maxZ) < -40 || SY(bb.minZ) > H + 40) continue;
      tracePoly(ctx, R.ring);
      ctx.fillStyle = REALM_WASH[id]; ctx.fill();
      if (R.mode !== 'foot' && s > 0.18) {
        ctx.save(); ctx.clip(); anchorPattern(wavePat); ctx.fillStyle = wavePat;
        ctx.globalAlpha = 0.8; ctx.fillRect(0, 0, W, H); ctx.restore();
      }
      // coastline: a bold ink line with a fine inner echo, hachured outward
      tracePoly(ctx, R.ring);
      ctx.strokeStyle = INK; ctx.lineWidth = clamp(1.6 * s + 0.6, 0.8, 2.2); ctx.stroke();
      if (s > 0.25) {
        ctx.save(); tracePoly(ctx, R.ring); ctx.clip();
        tracePoly(ctx, R.ring);
        ctx.strokeStyle = 'rgba(44, 34, 18, .22)'; ctx.lineWidth = 9 * Math.min(1.2, s); ctx.stroke();
        ctx.restore();
      }
      // motifs
      if (s > 0.16) {
        ctx.strokeStyle = 'rgba(44, 34, 18, .45)'; ctx.lineWidth = 1;
        const m = clamp(14 * s, 3, 12);
        for (const [x, z, r] of R.motifs) {
          const px = SX(x), py = SY(z);
          if (!onScreen(px, py, 20)) continue;
          ctx.beginPath();
          if (id === 'desert') {
            ctx.moveTo(px - m, py + m * 0.2); ctx.quadraticCurveTo(px - m * 0.2, py - m * 0.6, px + m, py + m * 0.2);
            ctx.moveTo(px - m * 0.2, py + m * 0.55); ctx.quadraticCurveTo(px + m * 0.3, py, px + m * 0.8, py + m * 0.5);
          } else if (id === 'ice') {
            const k = 5 + Math.floor(r * 3);
            for (let i = 0; i <= k; i++) {
              const a = i / k * Math.PI * 2, rr = m * (0.55 + ((i * 7 + r * 13) % 5) / 10);
              i ? ctx.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr * 0.7) : ctx.moveTo(px + rr, py);
            }
          } else if (id === 'jungle') {
            for (let i = 0; i < 4; i++) {
              const a = -Math.PI / 2 + (i - 1.5) * 0.7;
              ctx.moveTo(px, py); ctx.quadraticCurveTo(px + Math.cos(a) * m * 0.6, py + Math.sin(a) * m * 1.1, px + Math.cos(a) * m, py + Math.sin(a) * m * 0.6 + m * 0.2);
            }
            ctx.moveTo(px, py); ctx.lineTo(px + m * 0.1, py + m);
          } else {
            ctx.arc(px, py - m * 0.3, m * 0.5, 0, Math.PI * 2);
            ctx.moveTo(px, py + m * 0.2); ctx.lineTo(px, py + m * 0.75);
          }
          ctx.stroke();
        }
      }
    }
    void t;
  }

  function drawWall(B) {
    const s = view.s, x0 = SX(0), y0 = SY(0);
    const gateA = B.gates.map((g) => Math.atan2(g.z, g.x));
    const w = clamp(26 * s, 4.5, 15), h = w * 1.15;
    const rows = [B.wallR + 22, B.wallR + 48];
    ctx.lineJoin = 'round';
    for (let row = 0; row < rows.length; row++) {
      const R = rows[row];
      const n = clamp(Math.round(2 * Math.PI * R * s / (w * 1.5)), 40, 420);
      for (let i = 0; i < n; i++) {
        const a = (i + (row ? 0.5 : 0)) / n * Math.PI * 2;
        if (gateA.some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < 0.075)) continue;
        const jitter = ((i * 2654435761) >>> 0) % 100 / 100;
        const px = x0 + Math.cos(a) * R * s, py = y0 + Math.sin(a) * R * s;
        if (!onScreen(px, py, 30)) continue;
        const hh = h * (0.75 + jitter * 0.5), ww = w * (0.85 + jitter * 0.3);
        ctx.beginPath();
        ctx.moveTo(px - ww, py + hh * 0.35);
        ctx.lineTo(px - ww * 0.15, py - hh * 0.65);
        ctx.lineTo(px + ww, py + hh * 0.35);
        ctx.fillStyle = row ? '#ddcca2' : '#e6d7b2'; ctx.fill();
        ctx.strokeStyle = INK; ctx.lineWidth = clamp(s * 1.6, 0.7, 1.3); ctx.stroke();
        if (w > 7) {                                    // shade the lee side
          ctx.beginPath();
          for (let k = 1; k <= 3; k++) {
            const f = k / 4;
            ctx.moveTo(px - ww * 0.15 + ww * 1.15 * f * 0.9, py - hh * 0.65 + hh * f * 0.9);
            ctx.lineTo(px - ww * 0.15 + ww * 0.15 * f, py + hh * 0.3);
          }
          ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(44, 34, 18, .55)'; ctx.stroke();
        }
      }
    }
  }

  function drawSerpents(B) {
    const s = view.s;
    if (s > 0.45) return;
    const sz = clamp(120 * s, 34, 70);
    ctx.save();
    ctx.strokeStyle = 'rgba(70, 48, 20, .55)'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    for (const sp of B.serpents) {
      const px = SX(sp.x), py = SY(sp.z);
      if (!onScreen(px, py, sz * 2)) continue;
      const f = sp.flip ? -1 : 1;
      // three scaly coils breaking the water, a horned head rearing ahead
      const th = sz * 0.13;
      for (let k = 0; k < 3; k++) {
        const hx = px + f * (k - 1.2) * sz * 0.5, hr = sz * (0.2 - k * 0.02);
        ctx.beginPath();
        ctx.arc(hx, py, hr + th / 2, Math.PI, 0);
        ctx.arc(hx, py, hr - th / 2, 0, Math.PI, true);
        ctx.closePath();
        ctx.fillStyle = 'rgba(92, 60, 24, .5)'; ctx.fill();
        ctx.lineWidth = 1; ctx.stroke();
      }
      const nx = px + f * sz * 0.42, hx = px + f * sz * 0.9, hy = py - sz * 0.62;
      ctx.beginPath();
      ctx.moveTo(nx - f * th / 2, py);
      ctx.quadraticCurveTo(nx + f * sz * 0.05, py - sz * 0.6, hx, hy);
      ctx.lineTo(hx + f * sz * 0.26, hy + sz * 0.05);            // upper jaw
      ctx.lineTo(hx + f * sz * 0.06, hy + sz * 0.12);
      ctx.lineTo(hx + f * sz * 0.22, hy + sz * 0.2);             // lower jaw
      ctx.lineTo(hx - f * sz * 0.02, hy + sz * 0.2);
      ctx.quadraticCurveTo(nx + f * sz * 0.2, py - sz * 0.3, nx + f * th, py);
      ctx.closePath();
      ctx.fillStyle = 'rgba(92, 60, 24, .5)'; ctx.fill(); ctx.stroke();
      ctx.beginPath();                                            // horn + eye
      ctx.moveTo(hx - f * sz * 0.02, hy + sz * 0.02); ctx.lineTo(hx - f * sz * 0.16, hy - sz * 0.16); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx + f * sz * 0.06, hy + sz * 0.05, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f3e8cc'; ctx.fill();
      ctx.beginPath();                                            // the sea round it
      for (let k = -3; k <= 3; k++) {
        ctx.moveTo(px + k * sz * 0.3 - sz * 0.1, py + sz * 0.06);
        ctx.quadraticCurveTo(px + k * sz * 0.3, py - sz * 0.02, px + k * sz * 0.3 + sz * 0.1, py + sz * 0.06);
      }
      ctx.stroke();
      ctx.font = `italic ${Math.round(clamp(sz * 0.26, 10, 15))}px Alegreya, serif`;
      ctx.fillStyle = 'rgba(70, 48, 20, .6)'; ctx.textAlign = 'center';
      ctx.fillText('hic sunt dracones', px, py + sz * 0.42);
    }
    ctx.restore();
  }

  function laneWidth() { return clamp(0.5 + 1.7 * view.s, 0.7, 2.6); }
  function drawLanes(room, B) {
    const lw = laneWidth();
    const edges = room.board.edges || [];
    ctx.lineCap = 'round';
    for (const pass of [0, 1]) {               // sail lanes, then foot trails
      ctx.beginPath();
      for (const [a, b] of edges) {
        const na = B.byId.get(a), nb = B.byId.get(b);
        if (!na || !nb || !shownNode(na) || !shownNode(nb)) continue;
        const foot = na.mode === 'foot' || nb.mode === 'foot';
        if (foot !== !!pass) continue;
        const x1 = SX(na.x), y1 = SY(na.z), x2 = SX(nb.x), y2 = SY(nb.z);
        if (Math.max(x1, x2) < -10 || Math.min(x1, x2) > W + 10 || Math.max(y1, y2) < -10 || Math.min(y1, y2) > H + 10) continue;
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.strokeStyle = pass ? 'rgba(92, 52, 20, .78)' : 'rgba(44, 34, 18, .62)';
      ctx.lineWidth = pass ? lw * 1.25 : lw;
      ctx.setLineDash(pass ? [0.1, lw * 3.2] : [lw * 4.5, lw * 3]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawFog(room, B) {
    const R = B.realms.autumn;
    if (!R || isDev()) return;
    const bb = R.bounds;
    if (SX(bb.maxX) < 0 || SX(bb.minX) > W || SY(bb.maxZ) < 0 || SY(bb.minZ) > H) return;
    const c = fogCtx, s = view.s;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, W, H);
    // vellum over the whole Vale
    tracePoly(c, R.ring);
    c.save(); c.clip();
    c.drawImage(paperCv, 0, 0, W, H);
    c.fillStyle = 'rgba(214, 190, 140, .55)'; c.fillRect(0, 0, W, H);
    anchorPattern(hatchPat); c.fillStyle = hatchPat; c.fillRect(0, 0, W, H);
    c.restore();
    tracePoly(c, R.ring);
    c.setLineDash([5, 4]); c.strokeStyle = 'rgba(80, 50, 20, .6)'; c.lineWidth = 1.2; c.stroke(); c.setLineDash([]);
    const fs = Math.round(clamp(46 * s, 11, 22));
    c.font = `italic 600 ${fs}px Alegreya, serif`;
    c.textAlign = 'center'; c.fillStyle = 'rgba(80, 48, 16, .62)';
    c.fillText('Terra incognita', SX(R.cx + 40), SY(R.cz) - fs * 0.4);
    c.font = `italic ${Math.round(fs * 0.62)}px Alegreya, serif`;
    c.fillText('the woods show only what your lantern has found', SX(R.cx + 40), SY(R.cz) + fs * 0.7);
    // punch the lantern-lit ground out of the vellum
    c.globalCompositeOperation = 'destination-out';
    const seen = [...valeSeen].map((id) => B.byId.get(id)).filter(Boolean);
    const rad = Math.max(10, 36 * s);
    for (const n of seen) {
      const px = SX(n.x), py = SY(n.z);
      const g = c.createRadialGradient(px, py, rad * 0.35, px, py, rad);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    }
    c.lineCap = 'round'; c.lineWidth = Math.max(8, 30 * s); c.strokeStyle = 'rgba(0,0,0,.85)';
    c.beginPath();
    const gate = R.gate;
    for (const [a, b] of room.board.edges) {
      const na = B.byId.get(a), nb = B.byId.get(b);
      if (!na || !nb) continue;
      const ok = (n) => valeSeen.has(n.id) || n === gate;
      if (!ok(na) || !ok(nb) || (na.region !== 'autumn' && nb.region !== 'autumn')) continue;
      c.moveTo(SX(na.x), SY(na.z)); c.lineTo(SX(nb.x), SY(nb.z));
    }
    c.stroke();
    c.globalCompositeOperation = 'source-over';
    ctx.drawImage(fogCv, 0, 0, W, H);
  }

  function nodeRadius(n) {
    const base = clamp(5 + 9.5 * view.s, 8, 17);
    return base * (STYLE[n.type]?.big || 1);
  }
  function fillFor(n) {
    if (n.type === 'shrine') return DOMAIN_COLORS[n.domain] || STYLE.shrine.fill;
    return STYLE[n.type]?.fill || INK;
  }

  function drawNodes(room, B, me, reach, labels) {
    const s = view.s;
    const detail = s >= 0.3;
    const wayR = clamp(1.2 + 3.2 * s, 1.4, 5);
    // waypoints first, islands over them
    if (s >= 0.2) {
      for (const n of room.board.nodes) {
        if (n.type !== 'sea' || !shownNode(n)) continue;
        const px = SX(n.x), py = SY(n.z);
        if (!onScreen(px, py, 20)) continue;
        if (n.look === 'islet' && detail) {
          islandBlob(n, px, py, wayR * 1.9, '#e2cf9c');
        } else if (n.look === 'rocks' && detail) {
          ctx.fillStyle = INK_SOFT;
          for (const [dx, dy] of [[-1, 0.4], [0.9, 0.2], [0, -0.8]]) {
            ctx.beginPath(); ctx.arc(px + dx * wayR, py + dy * wayR, wayR * 0.5, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          ctx.beginPath(); ctx.arc(px, py, wayR, 0, Math.PI * 2);
          ctx.fillStyle = n.mode === 'foot' ? '#e7d6aa' : '#f2e8cf'; ctx.fill();
          ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1; ctx.stroke();
        }
        if (n.flotsam && detail) {
          ctx.fillStyle = '#8a6a2a';
          ctx.fillRect(px + wayR * 0.9, py - wayR * 1.6, wayR * 0.9, wayR * 0.9);
        }
        hits.push({ kind: 'node', id: n.id, x: px, y: py, r: wayR + 4, pri: reach.has(n.id) ? 3 : 0, reach: reach.has(n.id) });
      }
    }
    for (const n of room.board.nodes) {
      if (n.type === 'sea' || !shownNode(n)) continue;
      const px = SX(n.x), py = SY(n.z);
      if (!onScreen(px, py, 40)) continue;
      const R = nodeRadius(n);
      const col = fillFor(n);
      if (!detail) {
        // overview: a coloured seal-dot per landmark
        const r = n.type === 'sea' ? 2 : (STYLE[n.type]?.rank === 3 ? 4.6 : 3.2);
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        ctx.strokeStyle = INK; ctx.lineWidth = 0.8; ctx.stroke();
        hits.push({ kind: 'node', id: n.id, x: px, y: py, r: r + 6, pri: 1, reach: reach.has(n.id) });
        continue;
      }
      if (n.type !== 'gate') islandBlob(n, px, py, R * 1.6, n.mode === 'foot' ? '#e0c690' : '#e8d6a6');
      // the medallion: coloured disc, ink rim, cream glyph
      ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 1.6; ctx.strokeStyle = INK; ctx.stroke();
      if (n.type === 'gate') {
        ctx.beginPath(); ctx.arc(px, py, R + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = REALM_INFO[n.region]?.accent || GOLD; ctx.lineWidth = 2.5; ctx.stroke();
      }
      const spent = (n.type === 'lair' && n.defeated?.includes(me?.pid)) || (n.type === 'puzzle' && n.solved)
        || (n.type === 'monster' && !n.monster) || (n.type === 'shrine' && n.charges === 0);
      drawGlyph(ctx, STYLE[n.type]?.icon || 'relic', px, py, R * 1.22, '#fbf3dc', 2.1);
      if (spent) {
        ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(239, 227, 196, .55)'; ctx.fill();
      }
      // who has slain this tyrant: a ring of their colours
      if (n.type === 'lair' && n.defeated?.length) {
        const k = n.defeated.length;
        n.defeated.forEach((pid, i) => {
          const p = room.players.find((q) => q.pid === pid);
          const a = Math.PI / 2 + (i - (k - 1) / 2) * 0.55;
          const dx = px + Math.cos(a) * (R + 6), dy = py + Math.sin(a) * (R + 6);
          ctx.beginPath(); ctx.arc(dx, dy, 4, 0, Math.PI * 2);
          ctx.fillStyle = p?.color || '#888'; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();
        });
      }
      // a shrine's blessings left: tiny pips under the medallion
      if (n.type === 'shrine' && n.charges > 0 && s > 0.5) {
        for (let i = 0; i < n.charges; i++) {
          ctx.beginPath(); ctx.arc(px + (i - (n.charges - 1) / 2) * 6, py + R + 5, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.7; ctx.stroke();
        }
      }
      hits.push({ kind: 'node', id: n.id, x: px, y: py, r: R + 6, pri: reach.has(n.id) ? 3 : 1, reach: reach.has(n.id) });
      const rank = STYLE[n.type]?.rank || 1;
      const show = rank >= 3 ? (s >= 0.42 || (s >= 0.3 && !['gate', 'lair'].includes(n.type)))
        : rank === 2 ? s >= 0.48 : s >= 0.8;
      if (show) {
        let name = n.name || STYLE[n.type]?.label || '';
        if (n.type === 'gate') name = `To ${shortName(n.region)}`;
        if (n.type === 'lair') name = n.boss_name || name;
        labels.push({ text: name, x: px, y: py + R + (n.type === 'shrine' && s > 0.5 ? 14 : 11), rank,
          color: n.type === 'gate' ? (REALM_INK[n.region] || INK) : INK });
      }
    }
  }
  function islandBlob(n, px, py, r, fill) {
    const pts = board.blobs.get(n.id);
    if (!pts) return;
    ctx.beginPath();
    const k = pts.length;
    for (let i = 0; i <= k; i++) {
      const a = pts[i % k], b = pts[(i + 1) % k];
      const mx = px + (a[0] + b[0]) / 2 * r, my = py + (a[1] + b[1]) / 2 * r;
      if (i === 0) ctx.moveTo(mx, my);
      else ctx.quadraticCurveTo(px + a[0] * r, py + a[1] * r, mx, my);
    }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.1; ctx.stroke();
    if (r > 14) {                                // a ripple line round the coast
      ctx.save(); ctx.translate(px, py); ctx.scale(1.18, 1.18); ctx.translate(-px, -py);
      ctx.strokeStyle = 'rgba(40, 80, 92, .35)'; ctx.lineWidth = 0.7; ctx.stroke();
      ctx.restore();
    }
  }

  function placeLabels(labels, avoid) {
    const placed = avoid.slice();
    labels.sort((a, b) => b.rank - a.rank);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    for (const L of labels) {
      const big = L.rank >= 3;
      ctx.font = big ? `700 ${view.s > 0.7 ? 13 : 12}px Cinzel, serif` : 'italic 600 13px Alegreya, serif';
      const w = ctx.measureText(L.text).width, h = 15;
      const r = [L.x - w / 2 - 3, L.y - 1, L.x + w / 2 + 3, L.y + h];
      if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
      placed.push(r);
      ctx.strokeStyle = 'rgba(244, 234, 210, .92)'; ctx.lineWidth = 3.5;
      ctx.strokeText(L.text, L.x, L.y);
      ctx.fillStyle = L.color; ctx.fillText(L.text, L.x, L.y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function ribbon(text, x, y, fs, ink, sub, subInk) {
    ctx.font = `700 ${fs}px Cinzel, serif`;
    const w = ctx.measureText(text).width;
    ctx.font = `italic 600 ${Math.round(fs * 0.74)}px Alegreya, serif`;
    const w2 = sub ? ctx.measureText(sub).width : 0;
    const bw = Math.max(w, w2) + fs * 1.6, bh = fs * (sub ? 2.35 : 1.45);
    const x0 = x - bw / 2, y0 = y - fs * 1.05;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + bw, y0);
    ctx.lineTo(x0 + bw - fs * 0.35, y0 + bh / 2); ctx.lineTo(x0 + bw, y0 + bh);
    ctx.lineTo(x0, y0 + bh); ctx.lineTo(x0 + fs * 0.35, y0 + bh / 2); ctx.closePath();
    ctx.fillStyle = 'rgba(246, 237, 214, .93)'; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = `700 ${fs}px Cinzel, serif`; ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
    if (sub) {
      ctx.font = `italic 600 ${Math.round(fs * 0.74)}px Alegreya, serif`;
      ctx.fillStyle = subInk || INK; ctx.fillText(sub, x, y + fs * 1.05);
    }
    return { x0, y0, bw, bh };
  }
  function drawRealmTitles(room, B) {
    const s = view.s;
    // ribbons belong to the overview: once a realm fills the sheet, the
    // cartouche names it
    if (s > 0.42 || s > fitTo(B.world).s * 1.45) return;
    const fs = Math.round(clamp(52 * s, 12, 17));
    for (const id of REALMS) {
      const R = B.realms[id];
      if (!R) continue;
      // outside the realm, on the far side from the Isles (or beneath it)
      const vert = Math.abs(R.cz) > Math.abs(R.cx);
      const bb = R.bounds;
      const px = SX(R.cx);
      const py = vert && R.cz < 0 ? SY(bb.minZ) - fs * 1.9 : SY(bb.maxZ) + fs * 1.6;
      if (!onScreen(px, py, 80)) continue;
      const slain = R.lair?.defeated || [];
      const sub = R.boss ? (slain.length ? `${R.boss} — slain` : `${R.boss} holds the seal`) : '';
      const box = ribbon(R.name.toUpperCase(), px, py, fs, REALM_INK[id], sub);
      slain.forEach((pid, i) => {
        const p = room.players.find((q) => q.pid === pid);
        ctx.beginPath(); ctx.arc(box.x0 + box.bw - fs * 0.9 - i * 10, box.y0 + box.bh - fs * 0.55, 4, 0, Math.PI * 2);
        ctx.fillStyle = p?.color || '#888'; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();
      });
    }
  }

  function roamers(room) {
    const out = [];
    const add = (list, kind0) => {
      if (!list) return;
      const arr = Array.isArray(list) ? list : (typeof list === 'object' ? Object.values(list) : []);
      for (const e of arr) {
        if (!e || typeof e !== 'object') continue;
        const n = e.node ? board.byId.get(e.node) : null;
        if (n && !shownNode(n)) continue;
        const x = Number.isFinite(e.x) ? e.x : n?.x, z = Number.isFinite(e.z) ? e.z : n?.z;
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const kind = String(e.kind || e.type || kind0 || '');
        out.push({ x, z, kind, bounty: /bount/i.test(kind) || kind0 === 'bounty',
          name: String(e.name || e.title || e.label || (kind0 === 'bounty' ? 'Bounty' : 'Something stirs')),
          desc: String(e.desc || e.text || e.blurb || '') });
      }
    };
    add(room.world_events, 'event'); add(room.events, 'event'); add(room.roamers, 'event');
    add(room.wanderers, 'event'); add(room.bounties, 'bounty');
    return out;
  }

  function drawMarks(room, B, me, t) {
    const s = view.s;
    // your checkpoint: a pennant in your colour
    const ck = me && B.byId.get(me.checkpoint);
    if (ck && shownNode(ck) && ck.id !== 'home' || (ck && ck.id === 'home' && s > 0.3)) {
      const px = SX(ck.x), py = SY(ck.z), R = nodeRadius(ck);
      const fx = px - R * 0.95, fy = py - R * 0.4;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 20);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fx, fy - 20); ctx.lineTo(fx - 13, fy - 15.5); ctx.lineTo(fx, fy - 11); ctx.closePath();
      ctx.fillStyle = me.color; ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
    }
    // the trader's X over the sword islet
    const sw = room.sword_node && B.byId.get(room.sword_node);
    if (sw) {
      const k = dropX ? clamp((t - dropX) / 700, 0, 1) : 1;
      const e = 1 - Math.pow(1 - k, 3);
      const px = SX(sw.x), py = SY(sw.z) - (1 - e) * 60;
      const sz = clamp(14 * Math.max(0.6, s), 9, 16) * (1 + (1 - e) * 1.4);
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.75 * e;
      ctx.strokeStyle = '#b8261a'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(px - sz, py - sz); ctx.lineTo(px + sz, py + sz);
      ctx.moveTo(px + sz, py - sz * 0.9); ctx.lineTo(px - sz * 0.9, py + sz); ctx.stroke();
      ctx.restore();
      if (k >= 1) {
        ctx.font = '700 13px Cinzel, serif'; ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(244,234,210,.9)'; ctx.lineWidth = 3.5;
        ctx.strokeText('?', px, py - sz - 4); ctx.fillStyle = '#8e1c12'; ctx.fillText('?', px, py - sz - 4);
      }
      hits.push({ kind: 'node', id: sw.id, x: px, y: py, r: sz + 6, pri: 2 });
    }
    // roaming things and bounties (from the events snapshot, when present)
    for (const r of roamers(room)) {
      const px = SX(r.x), py = SY(r.z);
      if (!onScreen(px, py, 30)) continue;
      const R = clamp(6 + 8 * s, 8, 14);
      ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.fillStyle = r.bounty ? '#e9c75a' : '#f4e7c6'; ctx.fill();
      ctx.strokeStyle = r.bounty ? '#7a5a10' : '#8e2c1e'; ctx.lineWidth = 1.8; ctx.stroke();
      drawGlyph(ctx, r.bounty ? 'scroll' : 'serpent', px, py, R * 1.3, r.bounty ? '#5a3f0a' : '#8e2c1e', 2);
      hits.push({ kind: 'roam', id: r.name, name: r.name, desc: r.desc, x: px, y: py, r: R + 6, pri: 1 });
    }
  }

  function drawReach(room, B, reach, t) {
    if (!reach.size) return;
    const pulse = reduce.matches ? 0.5 : 0.5 + 0.5 * Math.sin(t / 260);
    for (const id of reach) {
      const n = B.byId.get(id);
      if (!n) continue;
      const px = SX(n.x), py = SY(n.z);
      if (!onScreen(px, py, 30)) continue;
      const R = (n.type === 'sea' ? clamp(5 + 3 * view.s, 6, 9) : nodeRadius(n)) + 6;
      ctx.beginPath(); ctx.arc(px, py, R + pulse * 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(201, 162, 39, ${0.35 + 0.4 * (1 - pulse)})`; ctx.lineWidth = 6; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.strokeStyle = '#a8841f'; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, R - 2.6, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff4cf'; ctx.lineWidth = 1; ctx.stroke();
      hits.push({ kind: 'node', id, x: px, y: py, r: Math.max(R + 6, 22), pri: 4, reach: true,
        walk: (room.walk?.options || []).includes(id) && !(id in (room.reachable || {})) });
    }
  }

  function drawDevice(c, dev, color, x, y, r) {
    c.save();
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.clip();
    c.fillStyle = '#f2e8cf'; c.fillRect(x - r, y - r, r * 2, r * 2);
    c.fillStyle = color;
    const u = r / 4;
    if (dev === 'bands') { c.fillRect(x - r, y - r * 0.7, r * 2, u * 1.1); c.fillRect(x - r, y - u * 0.55, r * 2, u * 1.1); c.fillRect(x - r, y + r * 0.42, r * 2, u * 1.1); }
    else if (dev === 'pales') { c.fillRect(x - r * 0.75, y - r, u * 1.1, r * 2); c.fillRect(x - u * 0.55, y - r, u * 1.1, r * 2); c.fillRect(x + r * 0.48, y - r, u * 1.1, r * 2); }
    else if (dev === 'sun') {
      c.beginPath(); c.arc(x, y, r * 0.42, 0, Math.PI * 2); c.fill();
      c.strokeStyle = color; c.lineWidth = Math.max(1.2, r * 0.14);
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; c.beginPath(); c.moveTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55); c.lineTo(x + Math.cos(a) * r * 0.92, y + Math.sin(a) * r * 0.92); c.stroke(); }
    } else if (dev === 'chevron') {
      c.beginPath(); c.moveTo(x - r, y - r * 0.3); c.lineTo(x, y + r * 0.35); c.lineTo(x + r, y - r * 0.3);
      c.lineTo(x + r, y + r * 0.2); c.lineTo(x, y + r * 0.85); c.lineTo(x - r, y + r * 0.2); c.closePath(); c.fill();
    } else if (dev === 'quarter') { c.fillRect(x - r, y - r, r, r); c.fillRect(x, y, r, r); }
    else { c.beginPath(); c.moveTo(x, y - r * 0.8); c.lineTo(x + r * 0.7, y); c.lineTo(x, y + r * 0.8); c.lineTo(x - r * 0.7, y); c.closePath(); c.fill(); }
    c.restore();
  }

  function layoutPlayers(room, B) {
    const you = getYou();
    const groups = new Map();
    for (const p of room.players) {
      let n = B.byId.get(p.node);
      let lost = !!p.veiled;
      if (n && !shownNode(n)) { n = B.realms.autumn?.gate || null; lost = true; }
      if (!n) continue;
      const k = n.id;
      if (!groups.has(k)) groups.set(k, { n, ps: [] });
      groups.get(k).ps.push({ p, lost });
    }
    const T = clamp(7 + 6 * view.s, 9, 13);
    const order = [];
    for (const { n, ps } of groups.values()) {
      ps.sort((a, b) => (a.p.pid === you) - (b.p.pid === you));   // you on top
      const k = ps.length;
      const R = n.type === 'sea' ? 4 : nodeRadius(n);
      ps.forEach(({ p, lost }, i) => {
        const a = -Math.PI / 2 + (i - (k - 1) / 2) * 0.62;
        const lift = R + T * 0.5 + (k > 1 ? 6 : 0);
        order.push({ p, lost, x: SX(n.x) + Math.cos(a) * lift, y: SY(n.z) + Math.sin(a) * lift, ax: SX(n.x), ay: SY(n.z) });
      });
    }
    order.sort((a, b) => (a.p.pid === you) - (b.p.pid === you));
    for (const o of order) {
      const r = o.p.pid === you ? T * 1.28 : T;
      o.r = r;
      o.box = [o.x - r - 4, o.y - r - 18, o.x + r + 4, o.y + r + 4];
    }
    return order;
  }
  function drawPlayers(room, order, t) {
    const you = getYou();
    const pulse = reduce.matches ? 0.5 : 0.5 + 0.5 * Math.sin(t / 300);
    for (const o of order) {
      const me = o.p.pid === you, turn = o.p.pid === room.turn;
      const r = o.r;
      // a fine tether down to the stop it stands on
      ctx.beginPath(); ctx.moveTo(o.ax, o.ay); ctx.lineTo(o.x, o.y);
      ctx.strokeStyle = 'rgba(44,34,18,.55)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.save();
      ctx.shadowColor = 'rgba(40, 24, 6, .45)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
      ctx.beginPath(); ctx.arc(o.x, o.y, r + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = INK; ctx.fill();
      ctx.restore();
      if (o.lost) ctx.globalAlpha = 0.55;
      drawDevice(ctx, sailDevice(o.p.color), o.p.color, o.x, o.y, r);
      ctx.beginPath(); ctx.arc(o.x, o.y, r + 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = o.p.color; ctx.lineWidth = 2.2; ctx.stroke();
      ctx.globalAlpha = 1;
      if (me) {
        ctx.beginPath(); ctx.arc(o.x, o.y, r + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = GOLD; ctx.lineWidth = 2.6; ctx.stroke();
      }
      if (turn) {
        ctx.beginPath(); ctx.arc(o.x, o.y, r + 7 + pulse * 5, 0, Math.PI * 2);
        ctx.strokeStyle = o.p.color; ctx.globalAlpha = 0.25 + 0.6 * (1 - pulse);
        ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
      }
      // the captain's initial on a little tag (YOU for you)
      const tag = me ? 'YOU' : (o.p.name || '?').slice(0, 1).toUpperCase();
      ctx.font = '800 10px Cinzel, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(tag).width + 8;
      const ty = o.y - r - 10;
      ctx.fillStyle = me ? GOLD : '#f4ead2';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(o.x - tw / 2, ty - 6.5, tw, 13, 3) : ctx.rect(o.x - tw / 2, ty - 6.5, tw, 13);
      ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = me ? '#1a1206' : INK; ctx.fillText(tag, o.x, ty + 0.5);
      ctx.textBaseline = 'alphabetic';
      hits.push({ kind: 'player', id: o.p.pid, x: o.x, y: o.y, r: r + 6, pri: 2 });
    }
  }

  function draw(t) {
    const t0 = performance.now();
    const room = getRoom();
    if (!room || !board) return;
    const B = board, you = getYou();
    const me = room.players.find((p) => p.pid === you);
    hits.length = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(paperCv, 0, 0, W, H);
    drawSerpents(B);
    drawSeas(B);
    drawRealms(B, t);
    drawWall(B);
    drawLanes(room, B);
    drawFog(room, B);
    const reach = new Set();
    if (room.turn === you && room.phase === 'sail') {
      for (const id of Object.keys(room.reachable || {})) reach.add(id);
      for (const id of room.walk?.options || []) reach.add(id);
    }
    const labels = [];
    drawNodes(room, B, me, reach, labels);
    drawMarks(room, B, me, t);
    drawReach(room, B, reach, t);
    drawRealmTitles(room, B);
    const fleet = layoutPlayers(room, B);
    placeLabels(labels, fleet.map((o) => o.box));
    drawPlayers(room, fleet, t);
    // the rose, fixed on the sheet
    const phone = W < 720;
    const rp = phone ? 64 : 112;
    if (!roseCv) roseCv = makeRose(rp, dpr);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(roseCv, phone ? W - rp - 6 : 22, phone ? 112 : H - rp - 20, rp, rp);
    ctx.globalAlpha = 1;
    stats.frames++; stats.ms += performance.now() - t0;
    return reach.size > 0 || room.players.some((p) => p.pid === room.turn);
  }

  function tick() {
    if (!open) { loop = 0; return; }
    loop = requestAnimationFrame(tick);
    const now = performance.now();
    let moving = false;
    if (anim) {
      const k = clamp((now - anim.t0) / anim.dur, 0, 1), e = ease(k);
      // zoom in log space so the glide feels even
      view.s = Math.exp(Math.log(anim.from.s) + (Math.log(anim.to.s) - Math.log(anim.from.s)) * e);
      view.cx = anim.from.cx + (anim.to.cx - anim.from.cx) * e;
      view.cz = anim.from.cz + (anim.to.cz - anim.from.cz) * e;
      if (k >= 1) anim = null;
      moving = true;
    }
    const dropping = dropX && now - dropX < 760;
    // pulses idle along at ~24 fps; anything the viewer drives runs at full rate
    if (dirty || moving || dropping || (animated && now - lastDraw > 42)) {
      dirty = false;
      lastDraw = now;
      animated = !!draw(now) && !reduce.matches;
    }
  }
  let animated = false;

  /* ── open / close ────────────────────────────────────────────────────── */
  function canOpen() {
    const room = getRoom();
    return !!room && room.phase !== 'lobby' && !world.tourActive?.() && !world.battleActive?.();
  }
  function openChart(opts = {}) {
    if (open || !canOpen()) return false;
    if (!root) build();
    const room = getRoom();
    derive(room);
    const me = room.players.find((p) => p.pid === getYou());
    valeSync(room, me, board);
    const cur = world.currentStage?.();
    const myN = board.byId.get(me?.node);
    hereStage = cur && cur !== 'battle' && (cur === 'hub' || board.realms[cur]) ? cur
      : (myN && myN.type !== 'gate' && myN.region) || 'hub';
    open = true; closing = false;
    root.classList.remove('hidden', 'closing');
    root.classList.add('opening');
    document.body.classList.add('charting');
    W = 0; resize();
    tab = 'here';
    paintTabs();
    goTo(fitTo(stageBounds(hereStage)), false);
    const focus = opts.focusNode && board.byId.get(opts.focusNode);
    if (focus) {
      const f = fitTo(stageBounds('hub'));
      goTo({ s: f.s * 1.6, cx: focus.x, cz: focus.z }, false);
    }
    dropX = opts.dropX ? performance.now() + (reduce.matches ? 0 : 380) : 0;
    renderCartouche(); renderFleet(); renderStatus(); hideTip();
    dirty = true;
    if (!loop) loop = requestAnimationFrame(tick);
    window.addEventListener('keydown', onKey);
    clearTimeout(openChart._t);
    openChart._t = setTimeout(() => {
      root.classList.remove('opening');
      // the sheet is opaque now — let the GPU rest under it
      if (open && !closing) world.pauseRender?.(true);
    }, reduce.matches ? 60 : 460);
    root.focus({ preventScroll: true });
    onToggle?.(true);
    return true;
  }
  function closeChart() {
    if (!open || closing) return;
    closing = true;
    world.pauseRender?.(false);
    window.removeEventListener('keydown', onKey);
    hideTip();
    root.classList.remove('opening');
    root.classList.add('closing');
    document.body.classList.remove('charting');
    clearTimeout(openChart._t);
    onToggle?.(false);
    setTimeout(() => {
      open = false; closing = false;
      root.classList.add('hidden');
      root.classList.remove('closing');
      cancelAnimationFrame(loop); loop = 0;
    }, reduce.matches ? 40 : 260);
  }

  /* called on every snapshot: keep the sheet current, remember the Vale */
  function sync() {
    const room = getRoom();
    if (!room || !room.board) return;
    if (room.phase === 'lobby') { board = null; return; }
    const B = derive(room);
    valeSync(room, room.players.find((p) => p.pid === getYou()), B);
    if (!open) return;
    renderCartouche(); renderFleet(); renderStatus();
    dirty = true;
  }

  return {
    open: openChart,
    close: closeChart,
    toggle: (opts) => (open && !closing ? (closeChart(), false) : openChart(opts)),
    isOpen: () => open && !closing,
    sync,
    setTab: (t) => { if (open) frame(t === 'world' ? 'world' : 'here'); },
  };
}

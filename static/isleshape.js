/*
 * isleshape.js — how big each island is, and what SHAPE it takes.
 *
 * buildIsland (islands.js) asks two questions before it raises terrain:
 *
 *   · how much room does this node have?  islandRoom() measures the free
 *     water round a node — its neighbours' footprints and every lane that
 *     passes it — so two close stops never grow into each other or over a
 *     sail line. The island's radius is clamped to that room.
 *   · what silhouette?  isleShape() picks, per node type and seed, from a
 *     small vocabulary layered on gfx/terrain.js: a sheltered harbour COVE
 *     on the side the lane arrives from (the dock sits in it), TWIN lobes,
 *     a rocky sea STACK off the main isle, TERRACES for the temples, a
 *     CLIFF face on one side, a drowned LAGOON for atoll islets.
 *
 * ISLE_FOOT is the footprint table: the farthest the coast of each node type
 * may reach (terrain is fitted so the coast's outermost point is exactly R).
 * board.py keeps the SAME table (ISLE_FOOT / SEA_FOOT) and plans every lane
 * and waypoint around it — tests/test_board_geometry.py checks they agree.
 * Importance shows in size: the Pharos and Home Port are the largest.
 */
import { mulberry32, hashStr } from './util.js';

export const ISLE_FOOT = {
  pharos: 24.0, home: 21.0, lair: 19.0, haven: 16.0,
  shrine: 15.0, monster: 15.0, puzzle: 14.0, shop: 14.0,
  gate: 13.0, sea: 1.5,
};
export const SEA_FOOT = { islet: 7.0, rocks: 4.5, buoy: 2.0, none: 1.5 };
export const FOOT_K = 0.72;
/* the smallest radius a landmark's island may shrink to (room clamp floor):
   the coast of a fitted isle dips to ~0.7 R, and the landmark must stay on
   land — the market's stalls reach ~6.2 wu, the Pharos rock ~13 */
export const MIN_R = { shop: 10.5, home: 12, pharos: 17, shrine: 8.5, puzzle: 8, haven: 9.5 };  // a walked realm's stop: a low mound on the sand
const GAP = 6.0;            // open water kept between two coasts / off a lane

/** coast radius the client may give the stop at `n` (worst case) */
export function footOf(n) {
  if (!n) return 0;
  if (n.type === 'sea') {
    if (n.mode === 'foot') return n.region === 'autumn' ? 1.9 : 3.0;
    if (n.region === 'ice' || n.region === 'jungle') return 4.4;
    return SEA_FOOT[n.look] ?? 2.0;
  }
  return (ISLE_FOOT[n.type] ?? 14.0) * (n.mode === 'foot' && n.type !== 'gate' ? FOOT_K : 1);
}

/**
 * The free radius round `node`: no island may reach closer than GAP to a
 * neighbour's worst-case coast, nor to any lane that does not touch it.
 * nodes: every node of the stage; edges: [[a, b]] ids.
 */
export function islandRoom(node, nodes, edges, byId) {
  let room = Infinity;
  for (const m of nodes) {
    if (m === node || m.id === node.id) continue;
    const d = Math.hypot(m.x - node.x, m.z - node.z);
    if (d > 140) continue;
    room = Math.min(room, d - footOf(m) - GAP);
  }
  for (const [a, b] of edges) {
    if (a === node.id || b === node.id) continue;
    const na = byId[a], nb = byId[b];
    if (!na || !nb) continue;
    const dx = nb.x - na.x, dz = nb.z - na.z;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((node.x - na.x) * dx + (node.z - na.z) * dz) / L2));
    const d = Math.hypot(na.x + dx * t - node.x, na.z + dz * t - node.z);
    if (d < 140) room = Math.min(room, d - GAP);
  }
  return room;
}

/** bearing (atan2(z, x), island-local) of the lane the island is usually
 *  reached by — its nearest linked stop */
export function laneBearing(node, edges, byId) {
  let best = null, bd = Infinity;
  for (const [a, b] of edges) {
    const o = a === node.id ? byId[b] : b === node.id ? byId[a] : null;
    if (!o) continue;
    const d = Math.hypot(o.x - node.x, o.z - node.z);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? Math.atan2(best.z - node.z, best.x - node.x) : null;
}

/**
 * Extra makeTerrain options + set dressing for an island, deterministic per
 * node id. Returns { terrain: {...opts}, stack: {a, r, H} | null,
 * mainK: coast scale for the main isle (room for a stack), mode: override }.
 * `dockA` is the lane bearing (harbours open toward it); `foot` = dry realm.
 */
export function isleShape(node, dockA, foot) {
  const rng = mulberry32(hashStr('shape:' + node.id));
  const out = { terrain: { fit: true }, stack: null, mainK: 1, mode: null };
  if (foot) return out;                         // mounds on sand / forest floor
  const away = (dockA ?? rng() * 6.28) + Math.PI + (rng() - 0.5) * 1.6;
  const harbour = (depth) => {
    if (dockA == null) return;
    out.terrain.cove = { a: dockA, depth, w: 0.42 + rng() * 0.2 };
  };
  const stack = (p) => {
    if (rng() >= p) return;
    // the main isle gives up a sliver of its footprint so the stack still
    // stands INSIDE the planned radius (lanes were planned round R)
    out.mainK = 0.8;
    out.stack = { a: away + (rng() - 0.5) * 1.2, r: 0.075 + rng() * 0.03, H: 2.6 + rng() * 2.4 };
  };
  const cliff = (p, k = 0.75) => {
    if (rng() < p) out.terrain.cliff = { a: away + (rng() - 0.5) * 0.8, k };
  };
  switch (node.type) {
    case 'pharos':
      // the colossus' rock: a broad mesa with a sheer seaward face
      // (Home Port always lies to the south, +z: the cliff faces north)
      out.terrain.cliff = { a: -Math.PI / 2, k: 0.7 };
      break;
    case 'home':
      harbour(0.3);
      break;
    case 'haven':
      harbour(0.34);
      if (rng() < 0.4) out.terrain.lobes = 0.22;
      break;
    case 'shrine':
      out.mode = 'terrace';                     // the temple on its terraces
      cliff(0.45);
      stack(0.25);
      break;
    case 'puzzle':
      cliff(0.5, 0.85);
      stack(0.35);
      break;
    case 'shop':
      // the market (~6.2 wu across its stalls at board scale) needs a broad
      // heart: no twin-lobed waist under it — a harbour, or gently uneven
      rng();
      harbour(0.24);
      break;
    case 'monster':
      stack(0.5);
      cliff(0.3);
      break;
    case 'lair':
      cliff(0.6, 0.9);
      break;
    default:
      break;
  }
  return out;
}

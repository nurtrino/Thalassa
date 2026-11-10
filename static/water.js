/*
 * water.js — the walked-on floors: desert sand and the Vale's forest floor.
 * (The sea itself lives in gfx/ocean.js.)
 */
import * as THREE from 'three';
import { mulberry32, hashStr } from './util.js';
import { makeGroundMaterial, GROUND_TILE } from './gfx/terrain.js';

/*
 * makeGround — the desert trek floor: a gently noise-displaced sand plane
 * with dune striping baked into vertex colors. Flat near the play area so
 * islands/props sit cleanly, rolling dunes toward the horizon.
 */
export function makeGround(theme, size = 3000, opts = {}) {
  const SEG = 260;
  const geo = new THREE.PlaneGeometry(size, size, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const rng = mulberry32(hashStr('ground:' + theme.id));
  const p1 = rng() * 6.28, p2 = rng() * 6.28, p3 = rng() * 6.28;
  const smooth = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };

  // The mesh is centred on the stage (translated by `center` in scene.js), so
  // its local (x,z) equals world minus centre. The Bleached Reach now ROLLS
  // with real dunes — but the roads must stay walkable, so dunes swell only
  // AWAY from the trail: flat lanes, a dune sea in the wilds between them.
  const cx = opts.center?.x ?? 0, cz = opts.center?.z ?? 0;
  const segs = opts.segs || [];                    // world-space [x0,z0,x1,z1]
  const isDesert = theme.id === 'desert';
  const isFlat = theme.id === 'autumn';            // the Vale floor is dead flat
  const DUNE = isDesert ? 0.9 : 0;                 // subtle, broad desert swells
  const segDist = (wx, wz) => {
    if (!segs.length) return 1e9;
    let d = 1e9;
    for (const s of segs) {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((wx - s[0]) * dx + (wz - s[1]) * dz) / L2));
      d = Math.min(d, Math.hypot(s[0] + dx * t - wx, s[1] + dz * t - wz));
    }
    return d;
  };
  // a real dune SEA: continuous transverse ridges marching across the wind,
  // their crest-lines wandering, crossed by a slower ground swell so it never
  // reads as a washboard. NOT isolated humps — the sand rolls everywhere.
  // an OPEN desert: broad, long-wavelength swells so the sand reads as a vast
  // flat expanse that merely breathes — not a field of humps crowding the road
  const wa = 0.7, ca = Math.cos(wa), sa = Math.sin(wa);
  const dunes = (wx, wz) => {
    const u = wx * ca + wz * sa;
    const v = -wx * sa + wz * ca;
    return Math.sin(u * 0.011 + Math.sin(v * 0.007 + p1) * 1.1) * 0.8
         + Math.sin(v * 0.008 - u * 0.005 + p2) * 0.5;    // ≈ −1.3 … 1.3, huge wavelength
  };
  // background relief that fills the far skyline the same way it always did
  const bg = (lx, lz) =>
      Math.sin(lx * 0.020 + lz * 0.012 + p1) * 0.55
    + Math.sin(lx * 0.007 - lz * 0.011 + p2) * 0.35
    + Math.sin((lx + lz) * 0.031 + p3) * 0.18;

  // world-space height sampler (also handed to islands.js so props sit on the
  // sand instead of floating above / sinking into the dunes). Only a NARROW
  // corridor along each road is flattened — the dune sea rolls right up to it.
  const heightAt = (wx, wz) => {
    // the Amber Vale is a walked-through FOREST FLOOR, not a dune sea: keep it
    // perfectly flat so every stepping stone, camp and barrow sits flush with
    // the trees on one continuous plane — no floating pads, no z-fighting.
    if (isFlat) return 0;
    const lx = wx - cx, lz = wz - cz;
    const r = Math.hypot(lx, lz);
    const bgAmp = 0.35 + smooth(110, 420, r) * 4.2;
    const lane = smooth(10, 45, segDist(wx, wz));   // a wide flat corridor along the road
    return bg(lx, lz) * bgAmp + dunes(wx, wz) * lane * DUNE;
  };

  const sand = new THREE.Color(theme.palette.sand);
  const sandDeep = new THREE.Color(theme.palette.grass2 ?? 0xa8905a);
  const sandHot = sand.clone().lerp(new THREE.Color(0xffffff), 0.18);
  const c = new THREE.Color();

  // a trodden dirt path baked right into the floor along the trail, so the
  // route reads clearly even before the waypoint markers stream in. Autumn is
  // a bare-earth track worn through the leaf litter; the desert a packed lane.
  const pathCol = new THREE.Color(theme.id === 'autumn' ? 0x83643a : 0xc7a468);
  const pathEdge = new THREE.Color(theme.id === 'autumn' ? 0x94764a : 0xd8b878);
  const PATH_W = 5.0;                                // half-width of the worn lane

  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);        // local == world − centre
    const y = heightAt(x + cx, z + cz);
    pos.setY(i, y);
    // dune striping: long diagonal ripples + darker hollows
    const stripe = 0.5 + 0.5 * Math.sin(x * 0.085 + z * 0.14 + Math.sin(x * 0.013 + p2) * 2.4);
    c.copy(sandDeep).lerp(sand, 0.45 + stripe * 0.55);
    if (y > 1.6) c.lerp(sandHot, Math.min(1, (y - 1.6) * 0.22)); // sunlit crests
    // paint the path: full dirt down the centre, feathering into a scuffed edge
    const pd = segDist(x + cx, z + cz);
    if (pd < PATH_W + 2.2) {
      const core = 1 - smooth(PATH_W - 1.5, PATH_W + 2.2, pd);
      c.lerp(pd < PATH_W - 1 ? pathCol : pathEdge, core * (0.6 + stripe * 0.25));
    }
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const GY = isFlat ? 0 : -0.35;
  // the floor tiles the same neutral mottle + bump the islands wear, so a
  // vast sand/leaf-litter plane has grain instead of reading as one flat fill
  const mesh = new THREE.Mesh(geo, makeGroundMaterial({ bump: 0.8, tide: false }));
  // the floor uses the terrain's world-scale grain
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / GROUND_TILE, pos.getZ(i) / GROUND_TILE);
  mesh.position.y = GY;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  // sampler in the mesh's own frame (adds the mesh y-offset) for placement
  return { mesh, update() {}, heightAt: (wx, wz) => GY + heightAt(wx, wz) };
}

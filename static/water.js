/*
 * water.js — themed sea + desert sand ground (owner: Agent A).
 * makeWater ports the legacy vertex-wave shader, parameterized by
 * theme.water (deep/shallow/sparkle/chop) and theme.sky, with manual linear
 * fog matching THREE.Fog so the sea vanishes with the islands.
 */
import * as THREE from 'three';
import { mulberry32, hashStr } from './util.js';

export function makeWater(theme, size = 3000) {
  const SEG = 190;
  const geo = new THREE.PlaneGeometry(size, size, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const sunDir = new THREE.Vector3(...theme.sun.position).normalize();
  const skyCol = new THREE.Color(theme.sky.mid)
    .lerp(new THREE.Color(theme.sky.horizon), 0.35);

  const uniforms = {
    t:        { value: 0 },
    deep:     { value: new THREE.Color(theme.water.deep) },
    shallow:  { value: new THREE.Color(theme.water.shallow) },
    sky:      { value: skyCol },
    sunDir:   { value: sunDir },
    sunCol:   { value: new THREE.Color(theme.sun.color) },
    chop:     { value: theme.water.chop },
    sparkle:  { value: theme.water.sparkle },
    fogColor: { value: new THREE.Color(theme.fog.color) },
    fogNear:  { value: theme.fog.near },
    fogFar:   { value: theme.fog.far * 1.15 },   // sea outlives isles a touch
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      uniform float t; uniform float chop;
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 p = position;
        float w1 = sin(p.x*0.14 + t*1.05), w2 = cos(p.z*0.17 + t*0.8),
              w3 = sin((p.x+p.z)*0.075 + t*0.5);
        p.y += (w1*0.34 + w2*0.30 + w3*0.28) * chop;
        float dx = (0.14*cos(p.x*0.14 + t*1.05)*0.34
                  + 0.075*cos((p.x+p.z)*0.075 + t*0.5)*0.28) * chop;
        float dz = (-0.17*sin(p.z*0.17 + t*0.8)*0.30
                  + 0.075*cos((p.x+p.z)*0.075 + t*0.5)*0.28) * chop;
        vN = normalize(vec3(-dx, 1.0, -dz));
        vW = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 deep; uniform vec3 shallow; uniform vec3 sky;
      uniform vec3 sunDir; uniform vec3 sunCol;
      uniform float t; uniform float sparkle;
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        vec3 N = normalize(vN);
        float lift = clamp(0.62 + N.x*1.4 + N.z*0.9, 0.0, 1.0);
        vec3 c = mix(deep, shallow, lift * 0.75);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        c = mix(c, sky, fres * 0.55);
        vec3 R = reflect(-sunDir, N);
        float spec = pow(max(dot(R, V), 0.0), 90.0);
        c += sunCol * spec * 0.8;
        float sp = pow(max(0.0, sin(vW.x*1.3 + t*2.1) * sin(vW.z*1.7 - t*1.7)), 18.0);
        c += vec3(0.9, 0.97, 1.0) * sp * 0.06 * sparkle;
        float fogF = clamp((length(vW - cameraPosition) - fogNear) / (fogFar - fogNear), 0.0, 1.0);
        c = mix(c, fogColor, fogF);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.62;
  mesh.name = 'water';
  return { mesh, update(t) { uniforms.t.value = t; }, heightAt: () => 0 };
}

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
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const GY = -0.35;
  const mesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  mesh.position.y = GY;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  // sampler in the mesh's own frame (adds the mesh y-offset) for placement
  return { mesh, update() {}, heightAt: (wx, wz) => GY + heightAt(wx, wz) };
}

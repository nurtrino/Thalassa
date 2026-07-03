/*
 * util.js — shared determinism + material helpers (owner: Agent A).
 * Everyone imports hashStr / mulberry32 / flat / displace / seedFrom from here.
 */
import * as THREE from 'three';

/* FNV-1a — stable across sessions, used to seed island/prop RNGs */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* tiny fast deterministic PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* the house material: flat-shaded standard */
export const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, ...extra });

/* displace vertices by a hash of their POSITION so shared/duplicated vertices
 * move identically — organic jitter with no torn faces or holes */
export function displace(geo, amt, seed = 0) {
  const p = geo.attributes.position;
  const h = (x, y, z, k) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + k * 91.7 + seed) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i,
      x + (h(x, y, z, 1) - 0.5) * amt,
      y + (h(x, y, z, 2) - 0.5) * amt,
      z + (h(x, y, z, 3) - 0.5) * amt);
  }
  geo.computeVertexNormals();
  return geo;
}

/* draw a fresh seed out of an rng stream */
export function seedFrom(rng) { return Math.floor(rng() * 1e9); }

/* one shared white radial-gradient texture — tint via material/sprite color.
 * Used for glows, braziers, wakes, particles. Cached. */
let _softTex = null;
export function softDiscTexture() {
  if (_softTex) return _softTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _softTex = new THREE.CanvasTexture(c);
  return _softTex;
}

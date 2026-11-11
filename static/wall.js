/*
 * wall.js — the mountain wall that pens in the Isles of Peace, and the realm
 * horizons beyond it. The rock itself is a lit heightfield range from
 * gfx/mountains.js; this file places it, carves the four passes, and dresses
 * each pass with its lintel, sigil groove and braziers in the realm's accent.
 *
 * Conventions: an "angle" here is atan2(z, x) of the thing's board position.
 */
import * as THREE from 'three';
import { makeRidge } from './gfx/mountains.js';
import { mulberry32, hashStr, flat, displace, seedFrom, softDiscTexture } from './util.js';
import { REALM_INFO } from './themes.js';
import { makeBrazierPillar } from './models/landmarks.js';

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

  /* the range itself: one lit heightfield ring with the passes carved through
     (gfx/mountains.js) — sun, sky ambient and haze treat it like any terrain */
  group.add(makeRidge({
    radius: radius - 72, depth: 270, height: 132,
    gates: gates.map((g) => ({ angle: g.angle, width: 30 })),
    palette: theme.wall.palette ?? { rock: theme.wall.rock, snow: theme.wall.snow },
    snowline: theme.wall.snowline ?? 0.74,
    seed: hashStr('ridge:' + (theme?.id ?? 'hub')),
  }));

  /* the four passes: flanking bastions, carved lintel, braziers, realm haze */
  const lights = [];
  for (const gt of gates) {
    const accent = new THREE.Color(REALM_INFO[gt.realm]?.accent ?? '#d9a441');
    const gg = new THREE.Group();
    gg.name = 'pass:' + gt.realm;
    const dirX = Math.cos(gt.angle), dirZ = Math.sin(gt.angle);
    // local frame: +x along the channel (outward), +z across it
    gg.position.set(dirX * radius, 0, dirZ * radius);
    gg.rotation.y = -gt.angle;

    // twin fire bowls on stone pillars at the mouth — the fire is HDR and
    // blooms; ONE accent light per pass (models/landmarks.js)
    // (no lintel: the carved pass is far wider than any span — a slab across
    // it only ever floated in mid-air; the realm gate at the node is the arch)
    for (const side of [-1, 1]) {
      const br = makeBrazierPillar(accent.getHex(), 9, Math.floor(rng() * 1e9));
      br.position.set(-6, 0, side * 15);
      gg.add(br);
    }
    const li = new THREE.PointLight(accent, 30, 100, 1.7);
    li.position.set(-6, 12, 0);
    gg.add(li);
    lights.push(li);

    // a hint of the realm beyond: tinted haze filling the pass
    // (soft-edged: a hard-edged quad read as a pale slab hanging in the pass)
    const haze = new THREE.Mesh(new THREE.PlaneGeometry(30, 34),
      new THREE.MeshBasicMaterial({ color: accent, map: softDiscTexture(), transparent: true, opacity: 0.15,
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
    // (the fire bowls flicker themselves; the pass light breathes with them)
    for (let i = 0; i < lights.length; i++) {
      lights[i].intensity = 28 + Math.sin(t * 11 + i * 1.9) * 5;
    }
  };
  return group;
}

export function buildRealmBackdrop(theme, { radius = 520, gateAngle = 0 } = {}) {
  const group = new THREE.Group();
  group.name = 'backdrop:' + theme.id;
  const rng = mulberry32(hashStr('backdrop:' + theme.id));
  const rock = new THREE.Color(theme.wall.rock);
  const rockDark = rock.clone().multiplyScalar(0.5);
  const snow = new THREE.Color(theme.wall.snow);
  const updaters = [];

  /* the horizon range — a lit heightfield ring (gfx/mountains.js). The
     Bleached Reach has NONE: it reads as an endless flat sand plane that just
     dissolves into its own haze. */
  if (theme.id !== 'desert') {
    const RANGE = {
      // the Frostfangs: tall, hard-edged, snow to the waterline, slate-blue rock
      // showing only where the faces are too steep to hold it
      ice:    { height: 172, jag: 1, snowline: 0.28,
                palette: { rock: 0x657e9a, rockDark: 0x34475f, strata: 0x93aac2, foot: 0xe4edf3, snow: 0xffffff } },
      // forested karst: steeper, humped ridges, rock only on the sheer faces
      jungle: { height: 118, jag: 0.55, snowline: 2,
                palette: { rock: 0x54705a, rockDark: 0x2a4534, strata: 0x7d9068, foot: 0x2c6e40, snow: 0xcfe3c2 } },
      autumn: { height: 70, jag: 0, snowline: 2,
                palette: { rock: 0x8a6a52, rockDark: 0x5a4234, strata: 0xb08a5a, foot: 0xb8692a, snow: 0xf6e9d2 } },
    }[theme.id] || { height: 120, jag: 1, snowline: 0.74,
                     palette: { rock: theme.wall.rock, snow: theme.wall.snow } };
    group.add(makeRidge({
      radius: radius - 20, depth: 260, ...RANGE,
      seed: hashStr('range:' + theme.id), segsPerUnit: 0.16, rows: 26,
    }));
  }

  /* a welcoming pair of braziers on the realm side of the pass */
  {
    const accent = new THREE.Color(REALM_INFO[theme.id]?.accent ?? '#d9a441');
    const gx = Math.cos(gateAngle), gz = Math.sin(gateAngle);
    for (const side of [-1, 1]) {
      const px = gx * (radius - 30) - gz * side * 16;
      const pz = gz * (radius - 30) + gx * side * 16;
      const br = makeBrazierPillar(accent.getHex(), 8, Math.floor(rng() * 1e9));
      br.position.set(px, 0, pz);
      group.add(br);
    }
    // one accent light between the pair
    const li = new THREE.PointLight(accent, 22, 90, 1.7);
    li.position.set(gx * (radius - 30), 10.8, gz * (radius - 30));
    group.add(li);
    updaters.push((t) => { li.intensity = 20 + Math.sin(t * 12) * 4; });
  }

  group.userData.update = (t) => {
    for (let i = 0; i < updaters.length; i++) updaters[i](t);
  };
  return group;
}

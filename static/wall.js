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

  group.userData.update = (t) => {
    for (let i = 0; i < updaters.length; i++) updaters[i](t);
  };
  return group;
}

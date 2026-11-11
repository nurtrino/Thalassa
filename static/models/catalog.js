/*
 * models/catalog.js — every procedural model in static/models/, by id, for
 * the contact sheet (static/modeltest.html?set=procedural) and for docs.
 * Each entry builds a fresh Group at the origin. Entries that need an island
 * (the Pharos isle, the home port town) build a real terrain to stand on.
 */
import * as THREE from 'three';
import * as L from './landmarks.js';
import * as P from './props.js';
import * as E from './eventprops.js';
import * as W from './wonders.js';
import { makeTerrain } from '../gfx/terrain.js';
import { mulberry32 } from '../util.js';

function isle(R, H, mode, palette) {
  return makeTerrain({ seed: 1234, R, H, mode, palette: { grass: 0x8fae6a, grass2: 0x6f9a5a, sand: 0xeedfb6, sandWet: 0xd9c489, rock: 0x9a958a, ...palette } });
}

export const CATALOG = {
  // landmarks
  pharos: () => {
    const g = new THREE.Group();
    const R = 17;
    const t = isle(R, 3.0, 'mesa', { grass: 0xcbbf9a, grass2: 0xb7ab88, sand: 0xeadcb6, rock: 0xa49c8c });
    g.add(t.mesh);
    const ph = L.makePharos();
    ph.position.y = t.heightAt(0);
    g.add(ph);
    L.dressPharosIsle(g, t, R, 5);
    return g;
  },
  pharos_tower: () => L.makePharos(),
  shrine_hub_a: () => L.makeShrineTemple('#e0b040', 'hub', false, 3),
  shrine_hub_b: () => L.makeShrineTemple('#4a8fe0', 'hub', false, 4),
  shrine_ice: () => L.makeShrineTemple('#7fd0ff', 'ice', false, 5),
  shrine_desert: () => L.makeShrineTemple('#ff8a3a', 'desert', false, 6),
  shrine_jungle: () => L.makeShrineTemple('#5fe07a', 'jungle', false, 7),
  shrine_autumn: () => L.makeShrineTemple('#e05a3a', 'autumn', false, 8),
  shrine_spent: () => L.makeShrineTemple('#e0b040', 'hub', true, 3),
  puzzle: () => L.makePuzzleSpire({ seed: 2 }),
  puzzle_solved: () => L.makePuzzleSpire({ solved: true, seed: 2 }),
  haven_sea: () => {
    const g = L.makeCampHaven({ kind: 'sea', seed: 3 });
    const cp = L.makeCheckpointBeacon();
    cp.position.set(-2.8, 0, 2.6);
    g.add(cp);
    return g;
  },
  haven_desert: () => L.makeCampHaven({ kind: 'desert', seed: 4 }),
  haven_autumn: () => L.makeCampHaven({ kind: 'autumn', seed: 5 }),
  checkpoint: () => L.makeCheckpointBeacon(),
  market: () => L.makeMarketSquare(0, { seed: 6 }),
  home: () => {
    const g = new THREE.Group();
    const R = 13;
    const t = isle(R, 1.7, 'mesa', {});
    g.add(t.mesh);
    L.makeHomeTown(g, t, R, 0.5, 9);
    const lh = L.makeLighthouse();
    lh.scale.setScalar(1.6);
    const p = t.place(3.9, 0.22);
    lh.position.set(p.x, p.y, p.z);
    g.add(lh);
    return g;
  },
  lighthouse: () => L.makeLighthouse(),
  gate_ice: () => L.makeGatePortal('#7fd0ff', 11, 0x8a8f98, 'ice'),
  gate_desert: () => L.makeGatePortal('#ffb04a', 12, 0xb09a78, 'desert'),
  gate_jungle: () => L.makeGatePortal('#5fe07a', 13, 0x7a8a72, 'jungle'),
  gate_autumn: () => L.makeGatePortal('#ff7a3a', 14, 0x8a6a52, 'autumn'),
  lair_altar: () => L.makeLairAltar('#ff5030', 4),
  relic: () => L.makeRelicBeacon(),
  brazier_pillar: () => L.makeBrazierPillar('#7fd0ff', 9, 2),
  // props
  rock: () => P.makeRock(mulberry32(3), 1.2, 0x93999e),
  rock_moss: () => P.makeRock(mulberry32(4), 1.2, 0x8a8a7a, { moss: true }),
  rock_snow: () => P.makeRock(mulberry32(5), 1.2, 0x7a8796, { snow: true }),
  rocks: () => P.makeRockCluster(mulberry32(6), 1.1, 0xa49c8c),
  fishing_boat: () => P.makeFishingBoat({ seed: 1 }),
  flotsam: () => P.makeFlotsam(mulberry32(2)),
  turn_marker: () => { const m = P.makeTurnMarker(); m.position.y = 1.2; return m; },
  reach_beacon: () => { const g = new THREE.Group(); g.add(...P.makeReachBeacon('x', 0, 0, 2.2)); return g; },
  sea_lane: () => P.makeSeaLane(-12, 0, 12, 0, { seed: 3 }),
  foot_trail: () => P.makeFootTrail(-8, 0, 8, 0, { seed: 3 }),
  // event props
  ...Object.fromEntries(Object.entries(E.EVENT_PROPS).map(([k, f]) => ['ev_' + k, () => f({})])),
  ...Object.fromEntries(Object.entries(W.WONDER_PROPS).map(([k, f]) => ['wd_' + k, () => f({})])),
};
export const CATALOG_IDS = Object.keys(CATALOG);

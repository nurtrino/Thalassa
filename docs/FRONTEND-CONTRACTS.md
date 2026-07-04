# Thalassa frontend rebuild — module contracts

Read this WHOLE file before writing code. Every module below is written by a
different author in parallel; the interfaces here are LAW. If you need
something from another module that is not listed, define the call the way
this document would and add a note at the top of your file — do not invent a
different shape for something already specified.

The old frontend lives in `static/legacy/` (scene.js, app.js, style.css,
index.html) for REFERENCE AND SALVAGE: port anything useful (shaders,
terrain, ship builder, minigame renderers, protocol handling). The new game
is *up close and personal*: a d3 instead of a d6, a camera that hugs your
ship, four themed realms behind a rocky mountain wall, real sailing,
dungeon-hard battles against Blender-made monsters, and a UI that looks like
a shipped game, not a prototype.

## Global conventions

- Plain ES modules, no build step. `three` resolves via the import map in
  index.html to `/static/vendor/three.module.min.js`. Also vendored:
  `/static/vendor/OrbitControls.js`, `/static/vendor/GLTFLoader.js` (import
  as `./vendor/GLTFLoader.js` from files in `static/`).
- `import * as THREE from 'three'` everywhere.
- All new code lives flat in `static/`. No frameworks, no external requests.
- Determinism helpers (copy into a shared `util.js` — owner: Agent A):
  `hashStr`, `mulberry32`, `flat(color, extra)` material helper, `displace`
  (all in legacy/scene.js L24-59). Everyone imports from `./util.js`.
- Dispose discipline: every module that removes meshes must
  `geometry.dispose()` and dispose materials it created.
- Look targets: flat-shaded low-poly, warm Aegean light in the hub, strongly
  differentiated realm moods. Colors read saturated and confident, not pastel.

## Server protocol (unchanged from legacy, plus new fields)

Client→server messages and snapshot shape: see legacy/app.js §protocol —
port it verbatim. New/changed since the legacy client was written:

- `roll` results are 1..3 (d3). `config.die_sides = 3`.
- `stance` accepts `'guard'` as well as `'attack'|'magic'` (guard = tier-I
  question; success blocks the whole enemy phase).
- `use {item:'planks'}` — patch 3 hull; legal on your turn in phases
  roll/sail/battle/shrine/haven/shop.
- `config.shop_items` now includes `planks`; costs rebalanced;
  `config.heavy_every=3`, `config.heavy_mult=2`, `config.planks_heal=3`.
- `room.battle` extra fields: `model` (string id), `enraged` (bool),
  `round` (int), `charging` (bool — the NEXT enemy blow is heavy),
  `region` (realm id or null), per-enemy `model`.
- `room.reveal.enemy_phase` extra fields: `blocked` (guard success),
  `heavy` (bool).
- Board nodes: `depth` (1..7, realm dungeon depth), `mode` (`'sail'|'foot'`,
  foot = the desert trek), `region` ∈
  `{'ice','desert','jungle','autumn'}` or absent (hub).
- `room.board.regions` = `{theme: {name, mode, boss}}` for the four realms.
- Players carry `items.planks`; `checkpoint` node id.

## Realm/stage model (the core new idea)

Every node belongs to a *stage*: `'hub'` (no `region` field) or its realm id.
The viewer SEES exactly one stage at a time:

- If `room.battle` exists → the **battle stage** (a separate diorama scene),
  themed by the battle node's `region` (null → hub theme). Everyone watches;
  it is the current turn.
- Else → the stage containing MY ship's node (spectators with no ship: hub).

Stage switches (sailing through a mountain pass, battle enter/exit) use a
0.6s fade: scene.js owns a `<div class="scenefade">` it appends to the
container; CSS (Agent D) styles it: fullscreen, `background:#06090d`,
`opacity 0 ↔ 1`, `transition: opacity .45s`, `pointer-events:none`.

`gate` nodes exist in BOTH stages (the pass is the door between them).

## Module contracts

### util.js + themes.js + water.js + islands.js + wall.js — Agent A (world kit)

**util.js**: `hashStr(s)`, `mulberry32(seed)`, `flat(color, extra={})`,
`displace(geo, amt, seed)`, `seedFrom(id)` — ported from legacy.

**themes.js**:
```js
export const DOMAIN_COLORS = { clio:'#d9a441', athena:'#2e9e8f',
                               apollo:'#7d5ba6', dionysos:'#e4572e' };
export const REALM_INFO = {   // display metadata (UI + scene share it)
  ice:    { name:'The Frostfang Reach', accent:'#7fd4ef', icon:'ice' },
  desert: { name:'The Bleached Reach',  accent:'#e8c27a', icon:'desert' },
  jungle: { name:'The Verdigris Deep',  accent:'#6fd490', icon:'jungle' },
  autumn: { name:'The Amber Vale',      accent:'#f0a24f', icon:'autumn' },
  hub:    { name:'The Safe Isles',      accent:'#d9a441', icon:'hub' },
};
export function themeFor(stageId) → THEME   // stageId 'hub'|realm id
```
`THEME` object (all fields required):
```js
{
  id, water: {deep:0x.., shallow:0x.., sparkle:1.0, chop:1.0},
  ground: 'water'|'sand',              // desert realm stands on sand
  sky: {zenith:0x.., mid:0x.., horizon:0x..},
  fog: {color:0x.., near:Number, far:Number},   // far ~ 260-340: you see 3-4 islands
  sun: {color:0x.., intensity:N, position:[x,y,z]},
  hemi: {sky:0x.., ground:0x.., intensity:N},
  ambient: 0x..,                       // faint ambient light color
  palette: {grass:0x.., grass2:0x.., sand:0x.., rock:0x..},  // terrain colors
  flora: 'aegean'|'pine'|'cactus'|'jungle'|'autumn',
  particles: null|'snow'|'leaves'|'motes'|'dust',
  wall: {rock:0x.., snow:0x.., glow:0x..},  // mountain wall + brazier color
}
```
Moods: hub = bright turquoise noon. ice = pale low sun, steel-blue water,
floes. desert = blazing sand, heat haze, ochre rock. jungle = emerald
waterways, dense green fog, god-ray warm sun. autumn = golden-hour amber,
bronze water, drifting leaves.

**water.js**: `makeWater(theme, size=3000)` → `{mesh, update(t)}` — port the
legacy vertex-wave shader (legacy/scene.js L331-377), parameterized by
theme.water + theme.sky. Also `makeGround(theme, size)` for `ground:'sand'`:
a gently noise-displaced sand plane with dune striping in vertex colors, plus
`update(t)` no-op.

**islands.js**:
- `makeTerrain({seed,R,H,mode,palette,lobes})` → `{mesh, heightAt(rr), rng}`
  (port legacy L401-495; keep the contract).
- `buildIsland(node, theme, domains)` → `{group, R, plateauY}` — port the
  legacy per-type dispatcher (L1346-1555) onto the theme system: terrain
  palette + flora from THEME; buildings ported (shrine temple, obelisk,
  haven tents, market, lighthouse, pharos, gate pillars→now a mountain-pass
  portal, lair altar). New flora sets per realm: `pine` (snowy conifers),
  `cactus` (saguaro + dead scrub + sandstone spires), `jungle` (tall canopy
  puffs + hanging vines feel), `autumn` (amber/red broadleaf). Desert-realm
  nodes (`node.mode==='foot'`): "islands" become rock outcrops/oases rising
  from SAND (no shallow-water disc, no foam ring — use a sand-ripple ring);
  sea-type nodes there are dune waypoints: a cairn or bleached ribs instead
  of a buoy.
- `makeShip(colorHex)` — port verbatim from legacy (L1024-1168), it's good.
- `makeParticles(kind)` → `{points, update(t)}` — snow/leaves/motes/dust
  drifting sprite systems, ~200 sprites, cylinder of radius ~180 around
  origin, y 0..60, wrapping.
- `makeBattleBackdrop(theme)` → `Group` — a 60×40-ish diorama backdrop for
  battle.js: themed ground disc + horizon props (bergs/dunes/canopy/amber
  trees/marble columns for hub), low-poly, centered at origin, hero faces +x.
- `nameSprite(name, colorHex)` — port from legacy (L1590).

**wall.js**:
- `buildMountainWall({radius=560, gates, theme})` → `Group`. `gates` =
  `[{angle, realm}]` (4 entries). A ring of jagged peaks replacing the old
  cloud wall: 2 concentric rows of noise-displaced cones/rock slabs,
  heights 60-120, vertex-colored rock→snow, fog-friendly. At each gate
  angle carve a PASS: a gap ~26 units wide flanked by two cliff bastions,
  a carved lintel, 2 brazier flames in the realm's `accent` color
  (PointLight + additive sprite named `'brazier'`), and a hint of the realm
  beyond (e.g. tinted haze plane). Group exposes `userData.update(t)` for
  brazier flicker.
- `buildRealmBackdrop(theme, {radius=520})` → `Group` — for realm stages: a
  surrounding crescent of the same mountain ridge behind/around, denser
  behind the gate side, plus theme flavor: aurora band (ice, additive
  ribbon), heat-shimmer sun disc (desert), canopy wall silhouettes (jungle),
  rolling amber hills (autumn). Also `userData.update(t)`.

### scene.js — Agent B (world orchestrator)

```js
export function createWorld(container, handlers) → {
  update(room, you),            // idempotent snapshot sync
  battlePlay(kind, payload),    // forwarded to battle stage (see battle.js)
  battleActive() → bool,
  currentStage() → 'hub'|realm|'battle',
}
// handlers: { onNodeClick(nodeId), onStageChange(stageId) }
```
Responsibilities:
- Renderer setup: antialias, ACESFilmic 1.05, `setPixelRatio(min(dpr,2))`,
  shadows PCFSoft 2048 (shadow camera tight around the followed ship ±120).
- **Stages**: lazily built `Stage` objects per stageId: scene graph with its
  own sky dome, water/ground, lights, fog, islands, lanes, wall/backdrop,
  particles. Hub stage gets `buildMountainWall`; realm stages get
  `buildRealmBackdrop`. Node membership: hub = nodes without `region`
  + all `gate` nodes; realm = nodes with that `region` + its gate node.
- Island sync per stage with legacy `viewKey` semantics (rebuild island group
  when its key changes). Lanes: subtle dashes only between nodes of the
  stage. Nodes clickable via invisible proxy cylinders →
  `handlers.onNodeClick(id)`; reachable highlight rings (gold, pulsing) when
  `room.phase==='sail' && room.turn===you`.
- **Ships**: one galley per player (`makeShip(color)` scale ~2) + nameSprite.
  Visible only on its node's stage. Animated sailing along the lane
  polyline (port legacy sailPath/tween, ease-in-out, yaw smoothing, bob) +
  a wake: small fading foam sprites dropped while moving. In the desert
  realm (`node.mode==='foot'`) swap the galley for the walking captain:
  `getMonster('captain', {tint: player.color})` from monsters.js, walk-bob
  animation via `animateMonster(g, t, 'walk')` while moving, 'idle' parked.
- **Camera**: OrbitControls, enablePan=false, `minDistance 16`,
  `maxDistance 84`, `maxPolarAngle 1.12`, damping. Follow MY ship (or the
  turn player's ship in my stage while spectating): every frame lerp
  controls.target (and camera by the same delta) toward the ship. Lobby:
  slow auto-rotate drift around Home Port at distance ~55. On stage switch:
  snap behind my ship facing its heading.
- **Fades**: own `<div class="scenefade">` in container; stage or battle
  transitions: fade in → swap active scene → fade out. Call
  `handlers.onStageChange(stageId)` after the swap ('battle' included).
- **Battle**: instantiate `createBattleStage(renderer)` from battle.js once;
  when `room.battle` appears, `enter(...)`; when it clears, `exit()`. While
  active, render battle scene instead of stage scene; forward `battlePlay`.
  Also freeze board camera state for restore.
- **Ambience**: gulls near hub islands (port birds), dolphin pods (hub
  only), drifting clouds per stage, brazier/beacon flicker via
  `group.userData.update`, particles update, water update, storm-free: NO
  storm shader anywhere (the cloud wall is GONE — mountains now).
- Per-frame budget: one `requestAnimationFrame` loop via
  `renderer.setAnimationLoop`; keep per-frame allocations near zero; cache
  named-child lookups at build time.
- `window.__thalassa = {scene(), camera, controls, ships, stages}` debug
  handle (screenshot tooling uses it).

### monsters.js + battle.js — Agent C (creatures & battle stage)

**monsters.js**:
```js
export function preloadMonsters(ids)            // fire & forget
export async function getMonster(id, {tint=null, scale=1} = {}) → Group
export function animateMonster(group, t, mode)  // 'idle'|'walk'|'attack'|'hurt'|'die'|'cast'|'charge'
export function retint(group, cssColor)         // recolor 'PlayerTint' materials
```
GLBs live at `/static/assets/monsters/<id>.glb` — ids:
wolf fox jackal boar stag jaguar stalker shambler harpy bird vulture raider
faun monkey cyclops drowned golem siren wraith shade serpent drake briar
crab scorpion skiff captain stag_king wyrm colossus matriarch warden tyrant
kraken sphinx.
(`tyrant` = The Dark Lord, the current final boss; `warden` is the retired
former final boss, kept as an asset.)
Load with GLTFLoader (`./vendor/GLTFLoader.js`), cache the parsed scene,
hand out `clone(true)` copies; clone materials that will be animated
(emissive pulse). Saturate/deepen base colors ~15% at load (they export a
touch pale). Named part contract (see tools/make_monsters.py header):
`body head jaw legFL legFR legBL legBR armL armR legL legR wingL wingR
tail0..tailN vine0..vineN weapon shield eye core wisp crown`.
`animateMonster` drives whatever parts exist: legs swing when walking, wings
flap, tails/vines writhe with phase offsets, wraiths bob & sway (no legs),
jaw snaps on attack, body lunge on attack, flinch on hurt, shrink-sink on
die, emissive pulse on cast/charge. Missing GLB → fallback: a dark spiky
ico-sphere with glowing eyes so the game never breaks.

**battle.js**:
```js
export function createBattleStage(renderer) → {
  enter({battle, room, you, theme, heroColor, heroKind}) // heroKind 'ship'|'captain'
  exit(),
  play(kind, payload),   // see beat list
  update(t, dt),         // drive animations; called by scene.js each frame
  scene, camera,         // scene.js renders these while active
  resize(w, h),
  setTargeted(idx|null), // pulse ring under enemy while player picks a target
}
```
Diorama: `makeBattleBackdrop(theme)` from islands.js + its own lighting rig
(key + rim + theme ambient). Hero at (-9, 0, 0) facing +x: the player's
galley (islands.js makeShip, at anchor, gentle bob) or the captain GLB for
foot battles (heroKind 'captain', tinted). Enemies from `battle.enemies`
(model ids) arranged at x≈+7, staggered in 1-2 ranks facing the hero,
scale by `max_hp` (grunts ~1, elites ~1.3, bosses ~2.2 and centered).
Camera: low over-the-shoulder from behind-left of the hero, slight slow
sway; punchy on beats (small dolly/shake).
Beats for `play(kind, payload)`:
- `'player_hit' {idx, dmg, stance}` — strike: hero lunge (ship: ram surge /
  captain: spear thrust); magic: additive bolt sprite arcs to enemy;
  then enemy flinch + floating damage number (canvas sprite, rises/fades).
- `'enemy_die' {idx}` — shrink+sink+puff.
- `'enemy_attack' {dmg, heavy}` — front enemy lunges at hero; hero flinch,
  camera kick; `heavy` = bigger windup + slam + stronger shake.
- `'enemy_miss'` — lunge overshoots past the hero.
- `'backfire'` — bolt fizzles at the hero, purple flash.
- `'guard_block' {heavy}` — gold shield flash in front of hero, enemy lunge
  bounces off.
- `'charge_telegraph'` — boss rears, red pulsing glow on it until next beat.
- `'victory'` / `'defeat'` — enemies collapse / hero lists & darkens.
Damage numbers + hit flashes are battle.js's job; DOM UI (HP bars etc.) is
NOT — app.js owns that.

### index.html + style.css — Agent D (design system)

Total redesign. Design language "AEGEAN BRONZE": deep ink navy surfaces
(#0b141d / #0f1b28), aged parchment cards (#efe6d0 text-bearing surfaces),
bronze/gold structure (#c9a227, #8a6c1c), thin double borders + corner
notches (CSS only, no images), display font Cinzel (vendored
`/static/fonts/cinzel-var.woff2`, weights 400-900), body font Alegreya
(`alegreya-var.woff2`, `alegreya-italic.woff2`). NO emoji anywhere in
chrome (icons are inline SVG, Agent E generates them from an icon map).
Buttons: bronze bevel, engraved letter-spacing caps, hover lift + glint,
active press; disabled = stone grey. Focus-visible rings, and
prefers-reduced-motion guards on all decorative animation.

Layers (all fixed, z ladder): world 0 < hud 10 < flash 14 < battle UI 15 <
overlays 20 < inspector 25 < mute 30 < dragghost 400. `.hidden{display:none
!important}`. Body mode classes: `.battling`, `.shake`. `.scenefade` (see
stage model). Keep `.overlay.clear` trick (battle question must not dim the
diorama).

DOM contract (ids Agent E renders into — define exactly these):
- `#world` canvas mount; `#muteBtn`.
- Title screen `#lobby.overlay`: `.title-hero` (game name w/ laurel SVG,
  tagline), `#joinForm` (`#nameInput`, `#joinBtn`), `#waitRoom`
  (`#lobbyPlayers` roster cards, `#addBotBtn`, `#startBtn`, `#copyLink`,
  `#waitMsg`), `.title-howto` (4 compact rule cards).
- HUD: `#players` (top-left column of captain cards: color chip, name, hull
  pips, scroll count, relic pips, realm badge, streak flame, turn glow),
  `#objective` (top-center under turn banner: relic progress + hint),
  `#turnBanner`, `#compass` (top-right: circular compass rose, needles
  point to home + each realm gate, distance pips; `#bounties` popover
  toggles from it), `#tray` (bottom-center action dock), `#dice` (d3
  result: `.die` with 3 pip faces, tumble animation), `#log` (bottom-left,
  last 4 log lines, fading), `#toasts`, `#itembelt` (bottom-right: owned
  consumable icons w/ counts, clickable when usable).
- Battle: `#battleHud` (letterbox `.cinebar`s), `#bmon` (enemy cards:
  name, HP segments, power pips, `targetable` state), `#bfoe`
  (boss banner: name, `charging` warning strip, `enraged` badge, round
  pips), `#bship` (hero hull), `#bactions` (STRIKE/MAGIC/GUARD big
  stance buttons w/ tier chips + FLEE + item slots), `#bturn` beat line.
- Question `#qmodal.overlay`: parchment scroll card `#qcard` (`#qhead`
  domain ribbon + `#qkind`, `#qtimer>#qtimerBar`, `#qtext`, `#qitems`,
  `#qopts` (2×2 grid), `#qnote`). Reveal states `.good .bad .ruled
  .picked`.
- Minigame `#mgmodal.overlay`: `#mgcard` (`#mghead`, `#mgtimerBar`,
  `#mgprompt`, `#mgboard`, `#mgnote`) — style all legacy minigame class
  names (mggrid mgcell nono given on drop-ok drop-bad mgpalette mgpiece
  used nonowrap nonogrid nclue simonpad mgpad lit agletters agtile agrow
  aginput ravgrid ravcell missing ravopts glyphopt dragghost).
- `#modal.overlay > #modalBody` generic (intro, upgrade pick `.upcard`s,
  winner). `#uppanel` player inspector. `#shopPanel` (bottom sheet above
  tray when phase shop: stall header, item rows w/ SVG icon, name, desc,
  price chip, BUY button).
- `#flash` (gold/red fullscreen flash), toasts `.toast/.err`.
Ship a static `static/uidemo.html` that instantiates every component with
dummy data (all states: turn/dead/charging/reveal/etc) so the design is
reviewable standalone — same stylesheet, no JS.

### app.js (+ ui.js if you want a split) — Agent E (client logic)

Port the legacy protocol/net layer (token, hello, reconnect w/ backoff,
ping, side-answers, minigames, timers) onto the NEW DOM contract above and
the NEW world API (`createWorld(container, {onNodeClick, onStageChange})`).
Key new behavior:
- d3 dice: tumble shows 1-3 (die faces show 1..3 twice); `dice` WS message
  unchanged.
- Stance UI: STRIKE/MAGIC/GUARD (+tier chips: strike I/II by boss, magic
  III, guard I); GUARD tooltip "read the blow — success turns it aside".
  Boss `charging` → show the warning strip in `#bfoe` + suggest guard;
  `enraged` badge; battle beats extended: on reveal with
  `enemy_phase.blocked` → `battlePlay('guard_block',{heavy})`; `heavy` hits
  → `('enemy_attack',{dmg,heavy:true})`; kills → `('enemy_die',{idx})`;
  boss `charging` after reveal → `('charge_telegraph')`. Keep legacy beat
  timings (900/1500/2200/2600ms) and sfx pairings (audio.js API unchanged).
- `#itembelt`: planks/gale/horn/hint/aegis with counts; enabled per engine
  legality (planks: your turn + hull damaged; gale: roll phase; horn:
  battle; hint: question). Sends `use {item}`.
- Compass: from board nodes compute bearing (atan2 of node − my node) to
  Home + 4 gates (+ lair once inside a realm); rotate needle SVGs; show
  realm name banner when I'm inside a realm (`onStageChange`).
- Roster realm badges: player's node.region initial (tooltip realm name).
- Shop: `#shopPanel` rows from `config.shop_items` (planks included).
- Reveal/notes: render engine notes (they include ENRAGES/heavy/guard
  text); strip leading emoji from log lines before display (engine says
  "⚔ ..." — replace known leading emoji with SVG icû or drop them).
- Minigames: port renderers from legacy (tetromino drag, nonogram, simon,
  anagram, ravens) 1:1 onto the styled classes.
- Intro modal: rewrite the 5-step rules card for the new game (d3, realms,
  dungeon depth, boss heavies/guard, planks).
- Icons: one `icon(name)` → inline SVG string map (scroll, hull, relic,
  streak, gale, horn, hint, planks, aegis, home, gate-ice/desert/jungle/
  autumn, skull, crown, guard, strike, magic, flee, compass rose...) —
  single consistent 24×24 stroke style (stroke #c9a227-ish, 1.8px,
  round caps). ui.js may hold these.
- `window.__send`, `window.__room` debug handles preserved.

## Verification expectations (all agents)

Your file must parse as an ES module (`node --input-type=module --check` is
not enough for imports — at minimum run `node -e "import('./static/X.js')"`
knowing bare `three` will fail to resolve under node: instead run
`node tools/checkjs.mjs static/X.js` which stubs `three`* — Agent A writes
this checker first; if it doesn't exist yet, write your own local syntax
check the same way). Keep files under ~1600 lines; split if bigger.

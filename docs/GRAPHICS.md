# Thalassa V2 — how the world is drawn

The V2 renderer lives in `static/gfx/`. Everything is plain ES modules on
vendored three.js r187 (`static/vendor/`), no build step.

## The frame

```
scene (linear HDR, MSAA half-float target)
  → bloom                 light sources brighter than white spread
  → sun shafts            radial march toward the sun (High only)
  → ACES tone map
  → film grade            contrast · saturation · split tone · vignette · dither
  → sRGB
```

`gfx/pipeline.js` owns this. Because the scene is HDR, anything emissive or
additive above 1.0 (the sun disc, beacons, braziers, spell bolts) blooms on
its own — there is no per-object glow hack.

**Quality tiers.** `High` (4× MSAA, bloom, sun shafts, 4096² shore map),
`Balanced` (2× MSAA, bloom) and `Light` (no MSAA, no bloom, 1× pixel ratio).
Desktop starts on High, touch devices on Balanced; a governor steps down by
itself if the frame rate stays under ~32 fps and remembers the choice. The
HUD's graphics button cycles tiers; `?gfx=low|medium|high` pins one.

## One atmosphere, shared by everything

`gfx/atmosphere.js` holds a single set of uniforms — sun direction and colour,
sky gradient, cloud deck, haze colour and density. Three things read them:

- **the sky dome** (`gfx/sky.js`): gradient, sun disc and glow, drifting fbm
  clouds lit toward the sun, stars and aurora where a stage calls for them;
- **the ocean's reflections** (`gfx/ocean.js`) — the water mirrors the same
  sky function, so clouds drift across the swell;
- **the fog on every material.** three's fog chunks are patched once so all
  fogged materials (terrain, GLB models, sprites, particles) get *aerial
  perspective*: radial distance, an exponential curve between
  `scene.fog.near/far`, height falloff (peaks stand clear of the haze their
  feet are lost in) and in-scatter that warms the haze toward the sun.
  `scene.fog` is still the control surface and `fog: false` still opts out.

A material that defines its own `onBeforeCompile` must call
`bindAtmosphere(shader)`.

**Cloud shadows.** The same patch multiplies the sun's direct light by a
drifting cloud-shade term (`thalassaCloudShadow`, cheap value noise in world
xz projected along the sun), and the ocean dims its body colour and puts out
its glitter under the same shade — so soft shadows travel across the sea, the
islands and the dunes together. A look sets it with
`cloudShadow {strength, size, speed, cover}`; coverage defaults to the sky's
own cloud cover. The Light tier turns it off (`setCloudShadows(false)`).

Ambient light is **baked from the sky**: `bakeEnvironment()` renders the
stage's sky (minus the sun disc) into a prefiltered cube map used as
`scene.environment`, so shadowed sides are sky-coloured and glossy surfaces
reflect the right horizon.

## Looks — the lighting script

`gfx/looks.js` has one entry per stage. A look is *only* light and grade:

| stage | script |
|---|---|
| `hub` | high Aegean afternoon — crisp white sun, cobalt zenith, fair-weather cloud |
| `ice` | polar low sun — amber light raking across blue shadow, aurora |
| `desert` | blazing noon — hard overhead sun, bleached haze |
| `jungle` | humid late morning — sun shafts through green-gold vapour |
| `autumn` | golden hour — sun on the horizon, long shadows |
| `pharos` | starless midnight on the lighthouse — ember firelight |

Fields: `sun {az, el, color, intensity}`, `sky {zenith, ground, curve, glow,
disc, clouds{cover, scale, speed, soft, lit, shade}, stars, aurora}`,
`fog {color, sunColor, sunGlow, heightFalloff, heightBase, heightAmount}`,
`env` (sky-ambient strength), `fill` (hemisphere), `shadow {strength, radius}`,
`exposure`, `bloom {strength, radius, threshold}`, `shafts`, `shaftColor`,
`grade {contrast, saturation, shadows, highlights, vignette}`.

Palettes and the gameplay fog distances (how many islands you can see) stay in
`static/themes.js`.

## The sun and its shadows

`gfx/lighting.js`: one directional sun whose shadow frustum follows the
camera target, resizes with camera distance (close shots get crisp shadows)
and is snapped to shadow texels so edges don't crawl while the ship moves.

## The sea

`gfx/ocean.js`: a camera-following polar grid (dense under the ship, sparse
at the horizon) displaced by five Gerstner swells. The fragment shader adds
three scrolling detail-normal layers, fresnel sky reflection, a sun glitter
path, light scattering through the crests and foam.

**Depth comes from the shore map.** `gfx/shoremap.js` renders every mesh on
`SHORE_LAYER` (island terrain and its underwater shelf, bergs, sea rocks,
the feet of the mountains) from straight above into a height texture. The
ocean samples it for water depth, which drives the turquoise shallows, the
seabed caustics, the surf line, and the calming of the swell as it runs up a
beach. It is re-baked whenever a stage's islands change. To make a new solid
object sit *in* the water properly: `mesh.layers.enable(SHORE_LAYER)`.
After the bake the heights are clamped (−20…+2, the range the ocean reads)
and blurred over a few texels, so the turquoise rim and surf round sheer
solids (bergs, sea stacks, quays) follow a smooth contour instead of the
texel grid.

Per-stage water lives in `theme.water`: `deep`, `shallow`, `seabed`,
`scatter`, `chop`, `sparkle`, `foam`, `clarity`, `reflect`. Sea level is
`WATER_Y = -0.3`; `waveHeight(x, z, t)` mirrors the vertex displacement in JS.

## Land

`gfx/terrain.js` — `makeTerrain({seed, R, H, mode, palette, lobes})` builds an
island as a grid heightfield: noise-warped coastline, a real beach profile,
an underwater shelf (never seen directly; it exists for the shore map),
colour from height *and slope* (sand → two-tone meadow → rock where it is too
steep for soil), plus instanced ground cover (grass tufts, bushes, pebbles).
`palette.dry` marks stages that stand on sand or forest floor rather than in
the sea; `palette.cover` picks `meadow | rocks | none`.
Shape options: `fit` (scale the coast so its farthest point is exactly `R` —
every board island uses it, so the footprint the chart plans lanes round is
the real one), `cove {a, depth, w}` (a bay bitten out at bearing `a`),
`cliff {a, k}` (land held high to a sheer coast on one side), `lagoon`
(an atoll's drowned heart), `mode: 'terrace'` (temple plateau over a broad
step). The returned object also carries `coastAt(bearing)` and `R`.
`static/isleshape.js` picks these per node type and seed (harbour coves open
toward the lane the island is reached by, docks sit in them; twin lobes; a
sea stack inside the footprint; terraces for temples; cliffs) and sizes each
island to the free water round its node (`islandRoom`), with the footprint
table `ISLE_FOOT` that `board.py` mirrors.
`makeGroundMaterial()` is the shared PBR ground (grain + relief maps, wet
glossy sand at the tide line).

`gfx/mountains.js` — `makeRidge()` raises ridged-noise ranges as ordinary lit
terrain (strata, scrub foothills, snow shoulders, passes carved for the realm
gates). The hub's wall and the realm horizons both use it.

## Models

GLB models (`static/assets/`) load through `static/props.js`,
`static/monsters.js` and `static/structures.js`; the landmarks players see
most (Pharos, shrines, puzzle spires, havens, market, home port, realm gates,
markers and lanes) are procedural, in `static/models/`. Which
models are kept, which were removed and what should be remade is tracked in
`docs/MODELS.md`.

## Working on the look

- Tune a stage's light in `gfx/looks.js`, its palette/water in `themes.js`.
- `tools/qa/run_qa.sh <out> visual` writes the reviewer screenshot set.
- Budgets (phones matter): ≲ 350k triangles and ≲ 500 draw calls in view per
  stage; merge static geometry or instance repeats; avoid new point lights.

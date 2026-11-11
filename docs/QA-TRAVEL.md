# QA — Travel & Chart Geometry

How sailing is audited, what was broken, what changed, and what remains.
The auditor is `tools/qa/travel_audit.py` (static, many seeds) plus the
`sail_monitor` suite in `tools/qa/run_qa.py` (dynamic, samples the moving
ship at 50 ms against every island footprint). Run both via
`tools/qa/run_qa.sh`.

## Round 2 — real footprints, smooth hulls, crossing the passes

### The early Amber Vale (and every realm's cut)
**Cause.** Landing on a pass ends your turn; ~1.8 s later the server's
*gate carry* (`server.py gate_walk_task` → `Game.gate_carry`) moves you on to
the first stop beyond it. The client started the sail-up animation when the
landing snapshot arrived, but the carry snapshot arrived while the hull was
still far out (a 3-hop approach is ~5 s of sailing): `syncShips` saw the node
jump to a realm stop, **killed the animation** and re-placed the ship, and
`stageForViewer`/`desiredTarget` switched stage at once. The Vale was worst:
`desiredTarget` hard-routes any captain standing on an autumn node straight
into the woods, so the forest popped in ~180 wu short of the gate (measured:
fade at t = 2.2 s with the ship 183 wu out; the Vale stage then took 12 s to
raise behind the curtain under the software renderer).

**Fix (client only, scene.js).** A vessel that sails toward a pass from its
own side carries `rec.hold`; while it is held the server's carry is *deferred*
(the visual node stays the gate), `stageForViewer` / `desiredTarget` keep the
stage it is sailing in, and the hold is released only when the hull has
actually gone through the arch. A jump anywhere else (dev drop, respawn)
drops the hold at once. The realm theme no longer starts on the carry either
(`app.js`: music follows the crossing, `world.crossing()`).

### Entering a region
`scene.js` "CROSSING A PASS" — approach (the ship runs up the fairway and
through the arch while the camera drops low astern and looks through it, the
far side glowing in the realm's accent, haze thickening to the realm's
colour) → cut (the `.scenefade` curtain, ~0.5 s) → reveal (the curtain lifts
on the realm side; banner + music start here via `onStageChange`; the camera
rises from deck height to the chase view as the ship glides — or the captain
steps off his beached galley and walks — to the first stop). Leaving plays
the same grammar, shorter. ~4–6 s; any tap or key skips; reduced motion,
spectators, rivals' crossings and the tour get the plain fade; a battle
aborts it. `window.__crossStops` freezes it at given beats for screenshots.

### Footprints
The terrain is now FITTED: an island's coast never passes its radius
(`gfx/terrain.js fit`), and `buildIsland` never exceeds `ISLE_FOOT`
(`static/isleshape.js`) — clamped further to the free water round the node.
`board.py` keeps the same table (`ISLE_FOOT`, `SEA_FOOT`, `SHELF_K`,
`footprint()`, `shelf()`; a test checks the two agree).

### Audit (200 seeds, tightened checks)
| | before | after |
|---|---|---|
| lane_through_island (ERROR) | 1.9/board | 0 |
| lane_grazes_island (< coast + 6 wu, now ERROR) | 3.7/board | 0 |
| waypoint_on_shelf (ERROR, new) | 4.2/board | 0 |
| lane_blocked_by_islet (ERROR, new) | 4.0/board | 0 |
| hops outside 10–100 wu (ERROR) | 1.1/board | 0 |
| hops median / p95 / max / min | 54 / 77 / 105 / 6.4 | 55 / 82 / 96 / 15.7 |
| route choice (landing stops per hub isle × roll 1–5) | 12.22 (worst 9.61) | 12.58 (worst 9.87) |

(The old audit, with its looser rules and guessed radii, called the same
"before" boards clean apart from 0.4 grazes/board.) Generation:
`_insert_waypoints` sizes the waypoint count from the coast-reserved END hops,
`_declip_lanes` relaxes every open-water waypoint off shelves / away from third
coasts / into the hop band (designed realm stops tethered within 14 wu so the
forks keep their shape), bends the rare island-to-island lane, splits/merges
hops, and only dresses a waypoint as an islet or rock stack where it blocks
nothing; `_place_sword` scores spots by real clearance. Tests:
`tests/test_board_geometry.py`.

### Sailing
`static/travel.js`: routes are centripetal Catmull–Rom curves through the
lane's control points, relaxed around every island, field solid (bergs, dune
rocks, the Vale's trunks — an obstacle index built once per stage) and other
vessel, leaving along the bow's current heading (no pivoting), followed by
arc length with a sine ease and a rate-capped helm. Berths are chosen on the
side the vessel arrives from and clear of other ships. The `sail_monitor`
suite now sails the hub AND every realm (both walked ones included) and
checks island / field / ship clips, helm slip and camera height.

**Slip, measured properly.** The live sampler runs against a software
renderer at 2–4 fps, where frames bunch and its slip / turn-rate numbers are
noisy in both directions. The trustworthy measure is a replay: capture each
real `rec.anim.route` during play, then step it at an ideal 60 fps through
the game's own `routeS` / `routeAt` / `helm` / `helmRate`. That replay found
hulls up to 152° off their bow, from two causes, both fixed in `travel.js`:

- the opening turning circle (kept as fixed geometry) could cut an island's
  clearance disc, and the samples after it were then flung out to the rim —
  a 7–9 wu jump in the route. The planner now takes the hand that intrudes
  least and concedes that clearance to the circle; any jump still left is
  re-laid evenly and smoothed (a route is always one continuous curve);
- the helm's turn cap was a fixed 1.9 rad/s, slower than a tight bend demands
  at cruising speed. `helmRate(speed)` now lets the bow swing as fast as the
  curve needs under way, and stays low at rest (no spinning on the spot).

- a turning circle may borrow sea-room but never the coast (`hard` radius
  on every solid); bow-on to a beach the hull comes about in a tighter circle
  (4.4 / 3.0 / 2.2 wu), and with no room at all turns where she lies first;
- a move superseded before its sail went anywhere (flee, then sail straight
  back) used to route out to a far waypoint and back through a hairpin; the
  route now starts from where the hull actually is.

The replay is now part of the `sail_monitor` suite and carries its verdict
(slip ≤ 45°, no step over 2.2 wu, nothing stuck turning); the live sampler's
slip is printed for information only. Typical result: median 9–13°, worst
33–40°. A walker who must turn on his heel has his clock HELD until he faces
the trail (it used to leak on slow frames, and he walked backwards).

## Why static + dynamic

Boards are rolled with a random seed per voyage (`game.py`), so one pretty
chart proves nothing. The static pass sweeps 15–40 seeds and checks pure
geometry; the dynamic pass boots the real client, rolls real dice, and
watches the animated ship for intrusions the geometry can't predict
(client-side path smoothing, camera behaviour).

## What the audit checks

| check | severity | meaning |
|---|---|---|
| `lane_through_island` | ERROR | a sail line crosses a third island's visual footprint — the ship clips terrain |
| `island_overlap` | ERROR | two island footprints intersect |
| `long_hop` | ERROR | one d3 step over 110 wu (≈ 4.2 s of sail animation) |
| `wall_breach` | ERROR | hub node outside the mountain wall / realm node inside it |
| `region_overlap` | ERROR/WARN | realms interleave (< 40 wu) / run close (< 120 wu) |
| `disconnected` | ERROR | node unreachable from Home Port |
| `island_clump` | WARN | coast gap under 6 wu |
| `short_hop` | WARN | a hop under 7 wu — reads as a twitch |
| `lane_grazes_island` | WARN | clearance under 2.5 wu — cosmetic |
| `dead_end` | WARN | hub island with a single lane |
| `vale_geometry` | INFO | Amber Vale trail crossing a POI pad (handoff — see below) |

## What was found (baseline, 40 seeds)

- **Ship clipping**: ~3.3 lanes per board cut straight through another
  island's footprint. The client's `avoidIslands` smoothing hid some of it,
  but buoys sat ON islands and lane markers crossed coasts.
- **Long distances**: hub hop p95 was **155 wu, max 285 wu** — at the old
  animation speed (700 ms + 40 ms/wu, cap 8 s) the outer ring was a parade
  of 7–8 s empty-water dollies. Root cause: `_MAX_WAYPOINTS = 1` silently
  defeated the "waypoint every ~60 wu" target on ring-3 arcs (280–360 wu).
- **Twitch hops**: realm lanes forced exactly 2 waypoints even on lanes
  with almost no open water after coast reserves, stacking buoys 4–6 wu
  apart.
- **Opening-tour replay / world wipe** (worst travel bug, found by the
  dynamic pass): the client detected "new sea" by *node count*. The Amber
  Vale's fog reveals stops (its own gate included) mid-game, so any player
  entering the Vale made every client wipe the world and replay the 42 s
  opening fly-over, leaving the rendered stage detached from where players
  actually stood.

## What changed

- `board.py` `_MAX_WAYPOINTS` 1 → 3, plus a hard rule: no hub hop may
  exceed ~90 wu regardless of caps (`ceil(length / 90) − 1` waypoints
  minimum).
- `board.py` `_declip_lanes()` (new, runs after `_insert_waypoints`):
  repels sea waypoints out of every island's clearance disc, then bends
  any lane that still crosses a third island by dropping a bend buoy off
  the coast; iterates until clean. The Amber Vale is exempt — its
  serpentine is designed geometry.
- `board.py` waypoint thinning: a lane keeps only as many waypoints as its
  open water affords (≥ ~10 wu per hop), ending the 4 wu buoy stacks.
- `static/scene.js` sail duration 700 + 40 ms/wu (cap 8 s) →
  700 + 32 ms/wu (cap 5.8 s).
- `static/scene.js` board signature for rematch detection now keys on
  Home Port position + room code + hub node count instead of total node
  count, so Vale reveals no longer wipe the world mid-game.

## Where it stands (40-seed audit after the fixes)

```
hops: median 54, p95 77, max 104 wu   (was median 57 / p95 155 / max 285)
ERROR                       0         (was ~35/board)
WARN  lane_grazes_island    0.2/board (cosmetic)
INFO  vale_geometry         2.0/board (handoff below)
```

Dynamic: 17-sail random walk, 18 legs sampled at 50 ms — zero footprint
intrusions, median leg 5.7 s, max 8.2 s (a full die-3 voyage).

## Handoff to the Amber Vale team (not touched by QA, by agreement)

- ~2 trail segments per board cross a POI's flush ground pad
  (`vale_geometry` INFO in the audit JSON — ids included). Harmless while
  pads are flat, but worth a look when dressing the maze.
- The Vale flyover leg of the opening tour shows only amber murk (its fog
  hides everything from tour altitude) — consider a lower camera or a
  brief fog lift for that leg.
- Vale trail hops run up to 285 wu stop-to-stop by design (fog-of-war
  walk). The audit exempts them; re-enable `long_hop` for autumn in
  `tools/qa/travel_audit.py` if that design changes.

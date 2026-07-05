# QA — Travel & Chart Geometry

How sailing is audited, what was broken, what changed, and what remains.
The auditor is `tools/qa/travel_audit.py` (static, many seeds) plus the
`sail_monitor` suite in `tools/qa/run_qa.py` (dynamic, samples the moving
ship at 50 ms against every island footprint). Run both via
`tools/qa/run_qa.sh`.

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

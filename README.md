# THALASSA 🏛️

A 2–6 player strategy–trivia board game set in a mythic Greek sea — rendered
in 3D, played from your phones/browsers. One server, one shared table:
everyone who opens the site joins the same voyage.

Up close and personal: you roll a bronze **d3**, the camera hugs your ship
(you can only see the next three or four islands), and the world ends at a
rocky **mountain wall**. Four carved passes lead to four realms — frost,
desert, jungle, and autumn — each a dungeon of worsening monsters with a
tyrant at the far end. Slay it, haul its sigil seal home, bank three, and
storm the Pharos.

## How a voyage works

1. Open the site, enter a name, **JOIN THE VOYAGE**. First captain in is the
   host; friends just open the same URL. The host can also invite AI
   **philosophers** to fill the table.
2. Host hits **SET SAIL**. Ships start at Home Port in the shadow of the
   Pharos.
3. On your turn, roll the d3 and sail **exactly** that far — the chart is a
   lattice of loops, and steering them is the game. A mountain pass **halts
   the voyage**: reach one and you make landfall there, whatever the die
   said. Islands do what islands do: shrines wager trivia for scrolls (tier
   I/II/III — a missed III costs you), puzzle spires deal minigames for ship
   fittings, havens set your respawn checkpoint and patch the hull, market
   isles sell gear, hunting grounds bite — and open water is never quite
   safe: **sea attacks** rise mid-crossing, the deeper the realm the surer.
4. **The realms.** Four passes pierce the mountains, and each realm **forks**
   into two roads to the boss: a **perilous road** — short and straight, but
   every stop is an elite pack in deep water — and a **long road** — a wide
   safe arc of many stops with a haven to camp and a shrine for scrolls, and
   only a couple of weak packs. Race the gauntlet or plod the safe way; the
   wilds are fine-grained, so a d3 only nudges you a spot or two per turn — a
   careful crawl, not a sprint. The desert is crossed *on foot* — you beach
   your ship at the pass. At the far end: the realm's **boss**, a personal
   trial (everyone faces their own, fresh).
5. **Battles** are stance + trivia, and bosses fight like bosses:
   | Stance | Question | Effect |
   |---|---|---|
   | **STRIKE** | tier I (II vs bosses) | 1 damage, reliable |
   | **MAGIC** | tier III | 3 damage; a miss backfires |
   | **GUARD** | tier I | riposte — turn the blow aside and drive it back for its power (2× a heavy) |
   | **FLEE** | 2 scrolls | 50/50 escape; never from a boss |

   Bosses counter **every** exchange, telegraph a **heavy blow** every third
   round (guard it or eat double damage), and **enrage** at half strength.
   You do not beat one without preparation: hull fittings, aegis charms,
   **pitch & planks** (patch 3 Health mid-battle), a war horn, and guard
   timing.
6. **Win.** Shipwreck sends seals back to their lairs — bank them at Home
   Port. Three banked seals open the Pharos; put down the Warden inside and
   the Aegean is yours.

Reconnects (refresh, phone lock) are seamless — identity is a token in
localStorage. Rivals can answer your questions from the side to skim
scrolls, so nobody is ever just waiting.

## The tech

| Piece | File | Role |
|---|---|---|
| Board | `board.py` | Procedural chart: three safe rings + four realm spines with dungeon depth, d3-tuned lane lengths. |
| Engine | `game.py` | Pure rules state machine — phases, wagers, battles (heavies/enrage/guard), economy, relics. No IO; 59 unit tests. |
| Questions | `questions.py` | The Trivia API v2 client with per-domain pools and an offline fallback set. |
| Bots | `bots.py` | Philosopher captains: sail/wager/shop/guard heuristics + per-tier answer accuracy. |
| Server | `server.py` | FastAPI + WebSockets: one shared table, d3 dice, timers, bot driver. |
| World | `static/scene.js` + `themes.js`, `islands.js`, `wall.js`, `water.js` | Five themed stages (Aegean hub + four realms), the mountain wall, close chase camera, animated sailing, on-foot desert trek. |
| Monsters | `tools/make_monsters.py` → `static/assets/monsters/*.glb` | 32 low-poly creatures and bosses **generated with Blender** (headless `bpy`), procedurally animated by named parts (`static/monsters.js`). |
| Battles | `static/battle.js` | Cinematic diorama per realm: lunges, spell bolts, guard flashes, damage numbers, telegraphed heavies. |
| UI | `static/index.html`, `style.css`, `app.js`, `ui.js` | "Aegean bronze" design system — Cinzel/Alegreya, parchment cards, engraved bronze buttons, SVG icons, compass HUD. |
| Audio | `static/audio.js` | Web Audio SFX + looping soundtrack with battle/puzzle/endgame scenes. |

No build step — plain ES modules; Three.js r160 vendored.

## Run locally

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
TRIVIA_OFFLINE=1 .venv/bin/uvicorn server:app --port 5070
# → http://127.0.0.1:5070  (open two tabs to simulate two players)
```

Dev loop: `tools/serve_dev.sh` starts a server with offline questions, fast
bots, and the dev-cheat hook; `tools/shoot.py` drives a headless Chromium
through every game state and screenshots it; `tools/make_monsters.py`
regenerates the Blender creature models (`pip install bpy`).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `TRIVIA_API_KEY` | unset | the-trivia-api.com key (keyed rate limits). |
| `TRIVIA_OFFLINE` | unset | `1` = never call the API; use built-in questions. |
| `QUESTION_SECS` | `35` | Answer window per question. |
| `REVEAL_SECS` | `5` | How long the answer reveal stays up. |
| `ABANDON_RESET_SECS` | `300` | Deserted mid-game table resets after this long. |
| `BOT_TEMPO` | `1.0` | Bot thinking-time multiplier (0.2 = speed chess). |
| `DEV_CHEATS` | unset | `1` = enable the test harness teleport hook. Never in production. |

## Tests

```bash
.venv/bin/pip install pytest && .venv/bin/python -m pytest tests/ -q
```

## QA pipeline

One command runs the whole quality gate — unit tests, JS syntax, a
multi-seed board-geometry audit (clipping lanes, hop lengths, clumping —
see `docs/QA-TRAVEL.md`), then headless-Chromium suites against a fresh
server each: smoke, a full play loop, realm stage routing, all three
battle decks, a sail monitor that samples the moving ship against every
island footprint, and the reviewer screenshot set:

```bash
.venv/bin/pip install playwright && tools/qa/run_qa.sh qa_report/latest
# → qa_report/latest/report.md (+ report.json, shots/)
```

Any console error, uncaught exception, or HTTP 4xx a page triggers fails
its suite. Reviewer-panel feedback lives in `docs/QA-REVIEWS.md`.

## Deploy

`render.yaml` is a ready Render Blueprint (single instance — the game lives
in process memory). Set `TRIVIA_API_KEY` in the dashboard after the first
deploy.

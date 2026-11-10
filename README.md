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
   | Move | Question | Effect |
   |---|---|---|
   | **STRIKE** | tier I (II vs bosses) | 1 damage, reliable |
   | **MAGIC** | tier III | 3 damage; a miss backfires |
   | **FLEE** | 1 scroll | 50/50 escape; never from a boss |

   And when a foe strikes back, the **DODGE** beat: a ring collapses onto
   its target and one perfectly-timed tap nulls **half** the blow — miss
   the window (it's tight) and it lands full. Foes take turns attacking
   from a visible **turn rail**; no foe swings more than twice in a row.
   Bosses counter **every** exchange and telegraph a **heavy blow** every
   third round (dodge it or eat double damage). You do not beat one without
   preparation: hull fittings, aegis
   charms, **pitch & planks** (patch 3 Health mid-battle), a war horn, and
   a steady dodge hand.
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
| Engine | `game.py` | Pure rules state machine — phases, wagers, battles (heavies/enrage/guard), economy, relics. No IO; covered by the unit suite and the fuzzing simulator (`tools/sim.py`). |
| Questions | `questions.py`, `data/trivia.json`, `data/jeopardy.json` | 2,252 audited multiple-choice questions tagged by difficulty (shrine tiers and STRIKE/MAGIC draw different pools, no repeats until a pool is spent) and a 54k-clue typed-answer deck with a lenient-on-typos, strict-on-guessing matcher. `tools/clean_jeopardy.py` rebuilds the deck. |
| Bots | `bots.py` | Philosopher captains: sail/wager/shop/guard heuristics + per-tier answer accuracy. |
| Server | `server.py` | FastAPI + WebSockets: one shared table, d3 dice, timers tied to what they time, an idle-turn clock so an absent captain never freezes the table, bot driver, per-socket send queues and rate limits. |
| World | `static/gfx/*` + `scene.js`, `islands.js`, `realms/*`, `wall.js`, `themes.js` | The V2 renderer: HDR pipeline (bloom, sun shafts, ACES, film grade), one shared sky/sun/haze model with sky-baked ambient, view-following sun shadows, a real ocean with shallows and surf from a baked shore map, heightfield islands and lit mountain ranges. Five stages (Aegean hub + four realms), each with its own lighting script. See `docs/GRAPHICS.md`. |
| Models | `static/assets/{monsters,props,structures}/*.glb` → `static/monsters.js`, `props.js`, `structures.js`, `modelmat.js` | 32 creature/boss sculpts, 36 props, 14 landmarks (AI-sculpted, see `tools/MESHY-PIPELINE.md`), finished per material class for the HDR renderer and animated procedurally by named part. `docs/MODELS.md` is the catalogue (kept / removed / stand-ins / to remake); `/static/modeltest.html` is the contact sheet. |
| Battles | `static/battle.js`, `static/realms/battle_sets.js`, `static/ship.js` | A composed diorama set per stage with its own key/rim rig; lunges, spell bolts, damage numbers, telegraphed heavies; the player's procedural Greek galley with a sail device per colour. |
| UI | `static/index.html`, `style.css`, `app.js`, `ui.js` | "Aegean bronze" design system — Cinzel/Alegreya, parchment cards, engraved bronze buttons, SVG icons, compass HUD. |
| Audio | `static/audio.js` | Web Audio SFX + looping soundtrack with battle/puzzle/endgame scenes. |

No build step — plain ES modules; three.js r187 vendored in `static/vendor/`.

## Run locally

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
TRIVIA_OFFLINE=1 .venv/bin/uvicorn server:app --port 5070
# → http://127.0.0.1:5070  (open two tabs to simulate two players)
```

Dev loop: `tools/serve_dev.sh` starts a server with offline questions, fast
bots, and the dev-cheat hook; `tools/shoot.py` drives a headless Chromium
through every game state and screenshots it; `/static/modeltest.html` shows
every model under any stage's lighting and `/static/battletest.html` stages
any enemy in the real battle scene.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `TRIVIA_API_KEY` | unset | Optional the-trivia-api.com key for live battle questions. Read only from the environment — never commit one. |
| `TRIVIA_OFFLINE` | unset | `1` = never call the API; use built-in questions. |
| `QUESTION_SECS` | `35` | Answer window per question. |
| `REVEAL_SECS` | `5` | How long the answer reveal stays up. |
| `ABANDON_RESET_SECS` | `300` | Deserted mid-game table resets after this long. |
| `BOT_TEMPO` | `1.0` | Bot thinking-time multiplier (0.2 = speed chess). |
| `DEV_CHEATS` | unset | `1` = enable the test harness teleport hook. Never in production. |
| `IDLE_TURN_SECS` | `120` | Seconds a connected captain may sit on a decision before the server takes a safe default for them (`0` = wait forever; off when `DEV_CHEATS=1` unless set). |
| `GONE_TURN_SECS` | `30` | The same clock for a captain whose socket has dropped. |
| `AWAY_TURN_SECS` | `20` | The clock for a captain already on autopilot. |
| `WS_MAX_SOCKETS` | `200` | Cap on simultaneous connections. |
| `DEV_CODE` | `783` | Code for the in-game dev panel; set it empty to disable the panel in production. |

## Tests

```bash
.venv/bin/pip install pytest && .venv/bin/python -m pytest tests/ -q
```

### Rules simulator

`tools/sim.py` plays whole voyages headlessly against `game.py` — no server,
no clock — and checks the engine's invariants after every action (valid
phase/turn, sane purses and hulls, seal conservation, nothing left over from
an earlier phase, JSON-safe snapshots that never leak an answer, a legal
move always available, turns that always end):

```bash
python3 tools/sim.py --games 500 --seed 1      # summary; exits non-zero on a failure
python3 tools/sim.py --games 1 --seed 137 --verbose    # replay one game, action by action
python3 tools/sim.py --mode bots --max-turns 3000      # honest bot voyages (balance numbers)
python3 tools/sim.py --study stances           # boss / Warden win rates by stance
```

Half the tables are honest all-bot voyages (the balance numbers), half are
"chaos" tables: random-legal play plus illegal, out-of-turn and malformed
calls (which must raise `GameError` and change nothing), stale timers, kicks,
disconnects, idle-clock autopilot and dev-style teleports. A small slice runs
in the unit suite (`tests/test_sim.py`).

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

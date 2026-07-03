# THALASSA 🏛️

A 2–6 player, 30-minute strategy trivia board game set in a tropical Greek
archipelago — rendered in 3D, played from your phones/browsers. One server,
one shared table: everyone who opens the site joins the same voyage.

Trivia · dice · resources · placement. Not your average trivia game: the
question floor starts at "hmm" and goes up from there.

## How a voyage works

1. Open the site, enter a name, hit **JOIN THE VOYAGE**. The first captain
   to join is the host; friends just open the same URL.
2. Host hits **SET SAIL**. Everyone sees the 3D archipelago; ships start at
   the Port of Piraeus. Anyone arriving mid-game spectates until the next
   game.
3. On your turn, roll 2d6 and **sail using either one die** (your choice) —
   the glowing islands are in range. Then the island decides:

| Island | What happens |
|---|---|
| **Great Library** (×5) | Wager a question tier: **I** → 1 scroll, **II** → 2, **III** → 3 *but a miss costs you a scroll*. Each library shows a **domain card** (Clio/History, Athena/Science, Apollo/Arts, Dionysos/Culture) — and **the Muse moves on**: after any answer there, the card rotates. The librarian also remembers you: no two visits to the same library in a row. |
| **The Oracle** | Pay 1 scroll, face a brutal question. Right → take any 3 scrolls. Wrong → the Pythia keeps your offering. |
| **Agora** | Trade 3 scrolls of one domain for 1 of another. |
| **Open isles** (×4) | One build plot each: **Academy** (3 scrolls — rivals landing here face a tuition question; you profit either way) or **Harbor** (2 scrolls — start any later turn from it). |
| **Delos** (center) | Locked until you hold **3 laurels**. |

4. **Laurels:** at a library *currently showing* a domain, spend 2 scrolls of
   it and pass a Tier-III **Trial** to earn that domain's laurel.
5. **Victory:** with 3 laurels, sail to Delos. Your opponents vote which
   domain your final **Symposium** question comes from (they will pick your
   worst). Answer it and the Aegean is yours; miss and sail out to try again.

Reconnects (page refresh, phone lock) are seamless — identity is a token in
localStorage. The host can skip a stuck player and call rematches.

## Questions

Live from [The Trivia API](https://the-trivia-api.com) — tiers map to
medium/hard only; there is deliberately no "easy". Set `TRIVIA_API_KEY`
(dashboard secret) for keyed access; without a key the public endpoint and
rate limits apply. If the API is unreachable the built-in fallback set keeps
games playable (`TRIVIA_OFFLINE=1` forces this — handy for dev).

## Architecture

| Piece | File | Role |
|---|---|---|
| Board | `board.py` | Island graph (13 nodes), domains, BFS reachability. |
| Engine | `game.py` | Pure rules state machine — phases, wagers, trials, economy, buildings, symposium. No IO; unit-tested. |
| Questions | `questions.py` | The Trivia API v2 client: per-domain/difficulty prefetch pools, dedupe, rate limiting, offline fallback. |
| Server | `server.py` | FastAPI: the single shared table, WebSocket protocol, dice RNG, phase timers, broadcast. |
| Client | `static/` | Vanilla JS + vendored Three.js: procedural 3D archipelago (water shader, temples, palms, triremes), CSS-3D dice, question cards. |

No build step — the frontend is plain ES modules; Three.js r160 is vendored
in `static/vendor/`.

## Run locally

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
TRIVIA_OFFLINE=1 .venv/bin/uvicorn server:app --port 5070
# → http://127.0.0.1:5070  (open two tabs to simulate two players)
```

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `TRIVIA_API_KEY` | unset | the-trivia-api.com API key (keyed rate limits; required for commercial use). |
| `TRIVIA_OFFLINE` | unset | `1` = never call the API; use the built-in fallback questions. |
| `QUESTION_SECS` | `35` | Answer window per question. |
| `REVEAL_SECS` | `5` | How long the answer reveal stays up. |
| `VOTE_SECS` | `25` | Symposium vote timeout (majority of cast votes wins). |
| `ABANDON_RESET_SECS` | `300` | A deserted mid-game table resets to a fresh lobby after this long. |

## Tests

```bash
.venv/bin/pip install pytest
.venv/bin/python -m pytest tests/ -q
```

## Deploy

`render.yaml` is a ready Render Blueprint (single instance — the game lives
in process memory). Set `TRIVIA_API_KEY` in the dashboard after the first
deploy.

# THALASSA — Puzzle Brief & New-Work Spec

Every puzzle in the game, described exactly as it works today, followed by a
concrete brief for the next round of work: **more puzzles, harder
tetrominoes, and non-boss enemy encounters that are pure puzzles (no
trivia).** Hand this to a bot the way you'd hand a spec to an engineer — the
"How it works today" half is ground truth from the code; the "Build this"
half is the assignment.

All puzzle logic lives in **`puzzles.py`** (generation + server-side
checking), is dealt from **`game.py`** (`_land` → `puzzle` node → `deal`),
transported by **`server.py`**, and rendered in **`static/app.js`**
(`renderTetromino` / `renderNonogram` / `renderSimon` / `renderAnagram` /
`renderRavens`). Names/blurbs are in `app.js` (`PUZZLE_TITLES` /
`PUZZLE_BLURBS`). Puzzles are **failable and timed** — the server enforces
the clock (`TIME_LIMITS`); `secret` fields are stripped before the client
ever sees the payload, so a puzzle is only as hard as it is on-screen.

---

## 0. Design rules (read first)

- **Server-authoritative & solvable.** Every generator must produce a puzzle
  the server can check without trusting the client, and every generated
  puzzle must be **guaranteed solvable** (tetromino tiles the region first;
  nonogram is generated from a real grid, etc.). Never ship a generator that
  can emit an impossible board.
- **`secret` stays secret.** Anything the client must not see (the anagram's
  word, the raven's answer index) goes under `data["secret"]` and is stripped
  in `server.py` before send. If you add a puzzle whose solution could be
  derived from the payload, hide the derivable part in `secret`.
- **The clock is the difficulty knob.** `TIME_LIMITS[kind]` (seconds) is the
  server-enforced budget; Simon is `None` (one wrong tap fails, no clock).
  Tightening the clock is the cheapest way to make an existing puzzle harder —
  use it deliberately, not accidentally.
- **Rivals can help.** Like trivia, other captains can chime in from the side
  — keep that in mind; a puzzle that's trivial for a table of six to
  brute-force in parallel isn't really a puzzle.
- **Flat, readable, on-theme.** UI is the "Aegean bronze" system (parchment
  cards, engraved bronze, Cinzel/Alegreya, SVG icons). New puzzle art must
  match; no stock game-y gradients.
- **Fail is real but soft.** A failed puzzle costs the reward (a ship
  fitting) and the turn, not a life — except where this brief explicitly
  makes a *puzzle-encounter* cost health (see §7). Don't invent harsher
  penalties without saying so.

---

## THE LIST — every puzzle in the game today

Six kinds. Five are **interactive minigames** (`INTERACTIVE`), one
(`riddle`) is a multiple-choice question routed through the trivia UI. Deal
weights today: tetromino/nonogram/simon/anagram/ravens = **3** each, riddle =
**1** (riddle only fires if an unused canned one remains, else it rerolls to
a generated kind).

### 1. Tetromino — "Sigil of the Isle"  ·  45s
- **What:** Talos-Principle sigil fill. Drag the given pieces to tile a
  **4×4** region exactly. **No rotation** — each piece is handed to you in the
  one orientation it must be placed.
- **How it works today:** `gen_tetromino(rng, w=4, h=4)` back-tracks a full
  tiling of the region *with rotations allowed during generation*, then hands
  the player each placed piece in its final (normalized) orientation, shuffled
  in order. A 4×4 board is exactly **four tetrominoes**. `check_tetromino`
  regroups the player's cell→piece assignment and confirms each group is the
  right 4-cell shape and the whole region is covered once.
- **Current difficulty:** low. 4×4 / 4 pieces / no rotation / 45s is a
  ~10-second puzzle for anyone who's seen Tetris. **This is the one the
  player called out as too easy — see §6.**

### 2. Nonogram — "The Weaver's Grid"  ·  30s
- **What:** 5×5 picross. Paint cells so every row and column matches its clue
  numbers. **Half the solution is pre-painted** ("given" cells, locked) as a
  head start against the short clock. Any grid matching the clues counts (not
  just the original).
- **How it works today:** `gen_nonogram(rng, n=5)` rolls a random 55%-density
  grid, rejects trivial/near-full ones (`n+2 ≤ filled ≤ n²−3`), derives
  row/col clues, then pre-reveals a random **half** of the filled cells.
  `check_nonogram` recomputes clues from the submitted grid and compares.

### 3. Simon — "Echoes of the Muses"  ·  no clock
- **What:** Memory. Watch a flashed sequence on a **3×3** (9-tile) pad, each
  tile with its own tone, then reproduce it. **One wrong tap fails it** — no
  timer.
- **How it works today:** `gen_simon(rng, length=6)` builds a length-**6**
  sequence with no immediate repeats. The sequence is public (client has to
  flash it); `check_simon` requires an exact match. Difficulty = sequence
  length.

### 4. Anagram — "The Scattered Letters"  ·  30s
- **What:** Unscramble a themed word (typed answer).
- **How it works today:** `gen_anagram` picks from `WORDS` (60 mythology /
  seafaring / worldly words, 6–9 letters), shuffles the letters (guaranteeing
  the scramble ≠ the word). The answer word rides in `secret`.
  `check_anagram` accepts the exact word **or** any other word from the list
  that's an anagram of the same letters.

### 5. Raven's Matrix — "The Pattern of Fate"  ·  30s
- **What:** A 3×3 glyph grid follows hidden row/column rules; pick the missing
  ninth tile from four options.
- **How it works today:** `gen_ravens` composes three independent systematic
  rules (over shape / count / fill), each `row`, `col`, or `latin`
  (`(r+c)%3`). It renders the first 8 cells, computes the 9th as the answer,
  and builds 3 distractors by mutating one attribute. Correct index rides in
  `secret`.

### 6. Riddle — "Riddle of the Isle"  ·  30s  ·  ★ placeholder set
- **What:** A hand-written brain-teaser, 4 options, routed through the trivia
  question UI (not an interactive minigame).
- **How it works today:** 6 canned riddles in `RIDDLES` (pencil-lead, river
  crossing, two-guards, snail-in-well, painted-cube, 3-3-8-8 = 24). Each fires
  at most once per game (`used_puzzles`). **The code itself flags these as
  placeholders to be replaced** with a curated public-domain set (Sam Loyd,
  Dudeney, Gardner, Smullyan, Puzzling.SE CC BY-SA).

---

## BUILD THIS — the assignment

Four workstreams. Keep everything server-authoritative and guaranteed
solvable. Where you add a difficulty tier, thread it through **one** new
parameter, don't fork the generators.

### 7. A difficulty signal from the world

Right now `puzzles.deal(rng, used)` has no idea *where* the puzzle spire sits.
It should. Add an optional **`difficulty` / `depth`** argument (0 = safe
rings, 1–3 = realm depth — the same `node["depth"]` the board already
carries) and thread it from `_land` in `game.py` into `deal`. Every generator
below reads it. Safe-ring spires stay gentle; deep-realm spires bite. This one
change is the backbone for "harder tetrominoes" and everything in §6/§8.

### 8. Harder tetrominoes  (the headline ask)

The 4×4 / 4-piece / no-rotation puzzle is too easy. Make it scale:

- **Bigger regions.** Grow past 4×4 to **5×5**, **6×5**, **6×6** by
  difficulty (a 6×6 is nine pieces). The tiler already handles arbitrary
  `w`/`h` and non-rectangular masks — feed it a **shaped region** (a carved
  sigil silhouette, cells masked out) so it isn't always a plain rectangle;
  the mask reads as an actual glyph and kills the "just fill the box" reflex.
- **Introduce rotation at the top tier.** Today pieces are pre-oriented, which
  is the biggest reason it's trivial. At difficulty ≥2, hand pieces in a
  **canonical orientation and let the player rotate them** (client: tap/tap-
  hold to rotate; server: `check_tetromino` must accept any rotation of the
  intended shape — normalize over `ROTATIONS`, not the single placed form).
  This is the single highest-impact change.
- **More pieces, tighter clock.** Scale piece count with area and pull the
  clock in (e.g. 45s → 60s for a 6×6 but with rotation, so net harder).
- **Optional: pentominoes.** For the very deepest spires, swap the tetromino
  set for a small **pentomino** set (F/L/N/P/T/U/V/W/X/Y/Z, 5 cells). The
  generator/checker are shape-agnostic — they only need the piece dictionary
  and `_rotations`. This alone turns it into a real packing puzzle.
- **Keep it solvable.** Generation still tiles first, so any region+piece-set
  you choose is solvable by construction. Verify the backtracker terminates
  quickly on 6×6 (it will; add a fuel counter as a guard).

### 9. More puzzles (breadth)

Add new interactive kinds so a table doesn't see the same five all game. Each
must be generatable, server-checkable, solvable, and clock-tuned. Strong
candidates, roughly easiest → hardest:

- **Lights-Out** — 4×4 toggle grid; tap flips a cell + its neighbors; clear
  the board. Always solvable from a scrambled-from-solved start; checkable by
  replaying taps. Great difficulty knob (grid size + scramble depth).
- **Mastermind / "Oracle's Cipher"** — deduce a 4-slot color code in N
  guesses with peg feedback. Deduction, not reflex; scales by colors/slots.
- **Sliding tile (15-puzzle) — "The Shifting Mosaic"** — restore a 3×3 (or
  4×4) image/glyph. Only ever generate from a solved state via legal shuffles
  (guarantees solvability); check against the goal permutation.
- **Flow / pipe-connect — "The Aqueduct"** — join matching terminals with
  non-crossing paths that fill the grid. Generate by carving paths first.
- **Path/maze sigil — "The Labyrinth Seal"** — trace a single unbroken path
  visiting every node once (Hamiltonian on a small generated graph that has
  one). Themed perfectly for a labyrinth realm.
- **Sequence — "The Fates' Thread"** — a numeric/glyph sequence with a hidden
  rule; type or pick the next term. Cheap to generate a family of rules;
  reuses the riddle UI path.

Pick **3–4** to ship; wire each into `_WEIGHTS`, `_GENERATORS`, `_CHECKERS`,
`TIME_LIMITS`, `INTERACTIVE`, and add a `PUZZLE_TITLES` / `PUZZLE_BLURBS`
entry + a `render*` function in `app.js`. Bump the deal weight of new kinds so
they actually show up, and let §7's difficulty gate the hardest ones to deep
realms only.

Also **replace the 6 placeholder riddles** (`RIDDLES`) with a curated set of
~24 public-domain teasers (the sources the code names), 4 options each, so
riddles stop repeating within a game.

### 10. Puzzle-only enemy encounters  (no trivia)

Today **every non-boss monster is a trivia battle** (`_land` → `battle` →
stance + trivia in `game.py`). The ask: **make some non-boss encounters pure
puzzles** — you face the creature, but you beat it with a minigame instead of
answering questions. Concretely:

- **A new encounter flavor: `puzzle_fight`.** Tag a subset of realm monster
  nodes (say the "weak packs" on the long road, and/or a per-realm signature
  creature) as puzzle-fights on the board (`board.py`, a node/encounter flag).
  In `_land`, when such a node fires, instead of opening the trivia `battle`
  UI, **deal an interactive puzzle** (reuse the §7 difficulty from the node's
  depth) presented in the **battle diorama**, not the puzzle-spire card — the
  monster is on screen, animated, looming.
- **Stakes, not fittings.** A puzzle-fight is a *fight*: solving it **defeats
  the enemy** (clears the node, normal battle spoils); **failing or timing
  out costs Health** (a hit from the creature) and bounces you, same as losing
  a battle round — it must feel like combat, not a spire. This is the one
  place §0's "fail is soft" is deliberately overridden.
- **Themed puzzle per creature.** Map creatures to puzzle kinds so it reads as
  the monster's "attack": e.g. a **Siren** → Simon (echo the song back or
  drown); a **Sphinx-kin** → riddle/sequence; a **Living Labyrinth** →
  path/maze seal; a **Gorgon-eye** → Lights-Out (extinguish the gaze); a
  **swarm** → tetromino (seal them out). Pick pairings that make narrative
  sense; expose the mapping in a small table so it's tunable.
- **Reuse the battle scene.** `static/battle.js` already stages a per-realm
  diorama with lunges/hits/damage numbers. Drive the puzzle inside it: enemy
  telegraphs → puzzle appears → solve = your strike lands / enemy falls; fail
  = enemy's blow connects, damage number, Health drops. Keep the existing
  battle music/SFX scene.
- **Balance.** These replace *some* trivia packs, not all — leave plenty of
  normal battles. Bosses are **never** puzzle-fights (they stay stance +
  trivia with heavies/enrage/guard). Make the puzzle-fight share per realm a
  single tunable constant.

### 11. Acceptance / done-when

- New `difficulty` arg flows board-depth → `deal` → every generator; safe
  rings stay easy, deep realms are visibly harder.
- Tetromino scales in region size, piece count, **and** rotation at the top
  tier; still provably solvable; 6×6 generates fast.
- 3–4 new interactive puzzle kinds shipped end-to-end (gen + check + render +
  titles/blurbs + weights + time limits), plus the riddle set replaced.
- A tunable fraction of non-boss realm encounters are puzzle-fights staged in
  the battle diorama, cost **Health** on failure, and are themed per creature;
  bosses untouched.
- All existing tests pass and new generators/checkers get unit tests
  (solvable-by-construction, checker rejects malformed payloads, `secret`
  never leaks). Verify headlessly with `tools/shoot.py` through each new
  puzzle state.

---

## Quick file map

| Concern | Where |
|---|---|
| Generate + check + weights + time limits | `puzzles.py` |
| Deal on landing; encounter routing; puzzle-fight flag | `game.py` (`_land`, `minigame_*`, `battle`) |
| Board node tags (which spires/monsters, depths) | `board.py` |
| Strip `secret`, transport, enforce clock | `server.py` |
| Puzzle rendering + titles/blurbs | `static/app.js` (`render*`, `PUZZLE_TITLES`, `PUZZLE_BLURBS`) |
| Battle diorama for puzzle-fights | `static/battle.js` |
| Puzzle/battle audio scenes | `static/audio.js`, `app.js` scene select |
| Tests | `tests/` (add `test_puzzles.py`) |

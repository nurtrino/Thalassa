# Events

Things happen between the shrines and the fights. A quiet landing in the
Isles of Peace or the Amber Vale has a real chance of meeting an **event**: a
story card with choices, a small game, something the whole table answers at
once, or a **world wonder** that lives on the chart for a few rounds. Nothing
depends on fast reactions: cards and games have no clock (the idle clock
backs them), table events give everyone a generous 40 seconds.

| Piece | File |
|---|---|
| Framework, hooks, bots, idle defaults, snapshot | `events.py` |
| Content (data only) | `event_data.py` |
| Game kinds (generators, moves, checkers, bots, solvers) | `eventgames.py` |
| Cards, game renderers, table UI, result card, HUD strip | `static/events.js`, `static/events.css` |
| World wonders on the 3D board | `static/worldfx.js` (hooked from `scene.js` beside `syncKraken`) |
| Tests | `tests/test_events.py` (+ the fuzzer: `tools/sim.py`) |
| The Bleached Reach (desert) and the second Isles set: content · 3D · tests | `event_data_desert.py`, `event_data_hub2.py` · `static/models/wonders.js` · `tests/test_events_desert_hub.py` |
| The realms (ice, jungle): content · game kinds · cards · 3D · tests | `event_data_ice.py`, `event_data_jungle.py` · `eventgames_realms.py` · `static/events_realms.js` + `.css` · `static/worldfx_realms.js` · `tests/test_events_realms.py` |

## How an event happens

1. `Game._land` resolves ambushes, monsters, lairs and the Sphinx as before.
   On a quiet landing it calls `events.on_land(g, p, nid)`.
2. A **world wonder** on that stop (or beside it, for those with `radius: 1`)
   is met first — once per captain per stop it occupies.
3. Otherwise a chance roll: `CHANCE[stage] × CLASS_MULT[node class]`
   (hub 0.40, Vale 0.50, Frostfang Reach / Verdigris Deep 0.50; open water /
   trail ×1.0, a spent shrine or solved spire ×0.8, a quiet realm hunting
   ground ×0.6 (class `wild`: no pack rose there; it takes events listed for
   `sea`), haven/market ×0.45, a charged shrine ×0.3). A landing that starts a
   fight never reaches this; a gate or a lair never meets an event (not even a
   radius-1 wonder next door). After a **heavy**
   event (a game, a table, a fight) a captain's chance is cut and only light
   events can fire for their next couple of turns.
4. An eligible event is drawn by weight (one already seen by that captain is
   four times less likely).
5. When it resolves, `Game._land_tail` finishes the landing — a haven still
   sets your checkpoint, a charged shrine still offers its wager — unless the
   outcome sent the turn elsewhere (a fight, a fitting pick, the kraken's
   riddles, a tow that ends the turn).

## The schema

### EVENT

```python
{"id": "goat", "stage": "hub", "kind": "game", "art": "goat",
 "where": ["sea", "islet"], "weight": 3, "heavy": True, "once": "player",
 "title": "The Goat Has Eaten Your Charts",
 "text": "A stowaway goat emerges from the hold…",
 "options": [OPTION, …]}
```

| key | meaning |
|---|---|
| `stage` | `"hub"` or a region key (`"autumn"`, `"ice"`, `"jungle"`, `"desert"`) |
| `kind` | `instant` (resolves at once, the card just reports) · `choice` (2–4 options) · `game` (a choice whose main option deals a game or puzzle; always offer a way out) · `table` (everyone answers) |
| `where` | node classes: `sea` (open water / Vale trail; also a quiet realm hunting ground, class `wild`), `islet` (spent shrine, solved spire), `haven`, `shop`, `shrine` (charged — the wager follows) |
| `weight` | relative odds (default 3) |
| `once` | `None`, `"game"` (once a voyage), `"player"` (once per captain) |
| `hostile` | Poseidon's Favor wards it off |
| `heavy` | a game / table / fight: the cooldown applies |
| `when` | `{"min_turn", "min_scrolls", "players_min", "hurt", "has_item", "lacks_upgrade", "has_cargo", "no_sword"}` |
| `world` | fires only when a captain meets the matching world wonder |
| `options` | choice / game cards |
| `outcome` or `roll` | instant events |
| `table` | table events (below) |
| `art` | illustration key for `static/events.js` (`M` motif table) |

**Conventions.** The **last option is the cautious one** and must have no
`requires` — the idle clock picks it for an absent captain, and it is the
"safe" answer a nervous player can always take. Every option has `stakes`:
the short line printed on its button saying what you risk or might win.

### OPTION

```python
{"label": "Pay the tithe", "stakes": "−1 scroll · Fortune's Favour",
 "requires": {"scrolls": 1},              # scrolls / item / upgrade / hull_gt / hurt
 "when": {"players_min": 2},              # optional: hidden behind "not now"
 "outcome": OUTCOME}                       # or "roll": [[weight, OUTCOME], …]
```

A `roll` is a gamble. **Fortune's Favour** throws it twice and keeps the
better; **Jinxed** keeps the worse.

### OUTCOME

| key | effect |
|---|---|
| `text` | first line of the result card |
| `scrolls` ±n | never below zero |
| `hull` ±n | heals cap at max; damage is turned by an Aegis Charm (if big enough) and **never sinks a ship** (floors at 1) |
| `item` / `items` | consumables (a full hold sells the extra for 1 scroll) |
| `item_spend` | uses up one of an item the option `requires` |
| `upgrade: True` | offers a two-fitting pick (`upgrade_pick` phase) |
| `buff` / `buffs` | `[id, n]`: `fair_wind` (+1 each roll), `becalmed` (−1, never below 1), `fortune`, `jinx` — n uses, cap 3; a wind blows away a calm and vice versa |
| `move` | `{"toward": "home" \| "haven" \| "shop" \| "lair" \| "gate" \| "random", "steps": n}` — a tow / a will-o'-wisp: positional, never onto a door or a fight; ends the turn |
| `skip: True` | lose your next turn |
| `reveal` | `"sword"` (the hidden islet, as if you bought the chart) · `"vale"` (lights the woods six hops out) |
| `fight` | `True` (a pack for this stop) or `{"name", "unit", "hp", "power", "model", "count"}` — starts a normal battle |
| `kraken: n` | the kraken's riddle gauntlet with n riddles |
| `game` | `{"kind", "params", "win": OUTCOME, "lose": OUTCOME, "score": [[threshold, OUTCOME], …]}` — the highest threshold met pays; below all of them pays `lose` |
| `puzzle` | `{"kind": lights_out \| sequence \| anagram \| riddle \| ravens \| sliding \| nonogram, "win", "lose"}` — an existing puzzles.py kind in the minigame card, with a generous clock |
| `table` | opens a table event (below) |
| `spawn` | a world wonder id to raise near here |
| `remove_world: True` | the wonder that triggered this event is gone |
| `log` | the short name used in the shared log |
| `swap: True` | the ghost ship's trick: trade places with a random rival on quiet water in the same waters (never across the wall, never into a fight or a door); ends the turn |
| `rival` | a simple OUTCOME that lands on one random OTHER captain (Hermes' misdelivered parcel) |

### TABLE

```python
{"kind": "bid", "prompt": "Your sealed bid…", "params": {"cap": 8, "worth": 6},
 "prize": {"items": ["aegis_charm", "planks"]}}
```

| kind | answer | resolution |
|---|---|---|
| `bid` | 0…min(cap, your scrolls) | highest unique bid pays and wins `prize`; a tie wins nothing |
| `guess` | `params.range` | closest to a hidden number wins `prize` (ties share) |
| `vote` | a `choices` index | the plurality choice's `outcome` applies to **everyone** |
| `gamble` | `"in"` / `"out"` | antes paid; one throw at `odds`; everyone in gets `win` |
| `lanes` | a lane index | each captain gets the hidden lane's outcome from `lanes: {name: OUTCOME}` |
| `lowest` | 1…`params.max` | the lowest number nobody else picked wins `prize` |
| `race` | a runner index | `params.field` = `[[name, form, weight], …]` (each runner's chance in 100 is public); the server runs the race (`params.legs` commentary) and every backer of the winner gets `pays[winner]` — long shots pay more; backing is free |

Answers are sealed (a snapshot shows only *who* has answered, plus your own
answer to you). The table closes when everyone has answered, when only
captains who cannot answer (no socket, on autopilot) remain, or when the
clock runs out — absent captains sit it out. Table prizes may only use the
simple outcome keys (scrolls, hull, items, buffs).

### WORLD wonder

```python
{"id": "merchant", "stage": "hub", "title": "The Wandering Merchant",
 "text": "…", "art": "merchant", "model": "merchant",
 "rounds": 8, "moves": 1, "where": "sea", "radius": 0, "weight": 4,
 "meet": "meet_merchant", "log": "her purple sails are sighted",
 "gone": "sails over the horizon"}
```

How a stage keeps its wonders is data (`events.WORLD_RULES`): the Isles of
Peace keep three to five on the chart (`max` 5, `min` 3: below the minimum a
round raises two at once; otherwise a 70% chance a round) — about four alive
on average; the Amber Vale and the Bleached Reach raise up to three (`min` 2)
near captains walking them — about 2.8 alive while someone is there; any other
realm takes `WORLD_RULE_DEFAULT` (up to two). An optional `bot` key says what
a philosopher's route planner thinks of it: `seek`, `curious`, `shop` (worth
it with scrolls to spend), `fight` (only with a sound hull) or `shun`. Once a round they
age, and movers hop along open water. `model` picks the 3D set piece in
`static/worldfx.js`; a new region's wonder needs a builder there (or reuse
one: `serpent`, `hound` and the props-based pieces are generic).

## Game kinds (`eventgames.py`)

Solo games run step by step on the server — the client sends a move, the
server answers with the new public state; secrets (the code, the pearl, the
heavy jar, the next tile, the satyr's next throw and his tells) never leave
it.

| kind | the game | how it is checked |
|---|---|---|
| `knucklebones` | push-your-luck: throw (faces 1·3·4·6; a 1 busts) or stop | server throws; `score` = pot when you stop |
| `higher_lower` | the oracle's tiles 1–9 ×2, call higher/lower, the spent tiles are public | server deck; a tie is free; wrong = lose; `score` = streak |
| `codebreak` | three different glyphs of four, six tries, "placed / present" feedback | exact match against the hidden code |
| `shells` | three cups with signs; "exactly N signs are true" | generator guarantees exactly one consistent cup |
| `weigh` | nine amphorae, one heavier, three weighings of equal pans, then pick | balance computed from the hidden jar; pick must match |
| `crossing` | wolf / goat / charts across a strait, one passenger at a time | state machine; something left with its eater = lose |
| `rps` | stone / scroll / shears vs a satyr whose tells never lie | first to 3; tells map one-to-one onto his throws |
| `nim` | take 1–3 pebbles, last one wins; the sage errs ~30% | server plays the sage |
| `haggle` | offer a price for the trader's goods; below his hidden reserve he says "an insult" (4+ short) or "tempting" (1–3 short); at or above it he shakes on it. Patience: 4 offers. `score` 4 = his exact lowest price … 1 = 3+ over. The deduced floor / ceiling are public | offers must climb; the solver probes the floor and spends its last offer on the ceiling (always a deal) |
| `floe` (realms) | cross a 4×6 floe field a row at a time, straight on or one aside; your floe tells how many reachable floes are thin; sounding poles test one; bear prints mark sound ice on every other row; stop to cash out | thin floes hidden; the generator guarantees every sound floe can reach a sound one; `score` = rows crossed (0 if you fall in) |
| `pairs` (realms) | memory match: 12 tiles, 6 pairs, 12 tries, no clock; seen tiles are marked; stop to cash out | faces hidden until turned; `score` = pairs found |
| `drums` (realms) | three rounds of "what beat comes next?" — four BOOM/tak patterns that follow one rule, pick the fifth of four | each round's answer is secret; `score` = rounds right |
| `plates` (realms) | press four temple plates in the one order the carved clues allow; a wrong plate resets them and costs a dart (survive two) | the clue set is trimmed to fix exactly one order; `score` = darts left + 1 |

Each has `gen`, `move` (a ValueError leaves the state untouched), `bot` (a
sensible, not perfect, philosopher), `solve` (the fuzzer's strong line),
`idle` (what the idle clock sends: `stop` cashes out a pot game; the others
are forfeited).

## Protocol (additive)

* phase **`event`** — the acting captain's card / game, or a table event.
  An event puzzle plays in the existing **`minigame`** phase with
  `minigame.event = true` and `minigame.event_title`.
* client → server: `event_choose{idx}` · `event_move{payload}` ·
  `event_answer{value}` (any seated captain, table step) ·
  `event_bet{value: bool}` (a rival, during a game or event puzzle — a right
  call skims a scroll) · `dev{event: id}` (DEV: force an event, or spawn a
  world wonder, on your stop).
* snapshot: `event` (the open event, secrets stripped) · `event_card` (the
  last result card `{seq, pid, id, title, art, lines, ok}`) · `world`
  (visible wonders `{wid, id, title, text, art, model, node, rounds,
  radius}`) · `event_info` (buff and game names) · `players[].buffs`.

## Bots and the idle clock

* Bots choose an option by expected value plus noise (a battered hull steers
  them away from fights), play games with `eventgames.bot`, answer table
  events with `table_bot`, and sometimes bet on a rival's game. Their route
  planning likes a merchant with scrolls to spend, a wreck, a festival, and
  shuns a serpent unless the hull is sound (`events.bot_wonder_score`).
* The idle clock (`server.idle_step`): a card takes its last (cautious)
  option; a game cashes out or forfeits; at a table the absent captain sits
  it out, and the next tick closes the table.

## Adding a region

1. Append records to `event_data.py` with `"stage": "<region>"` (and world
   wonders to `WORLD`). Use `where` classes that exist there (Vale trails
   and realm open water are both `sea`).
2. Add the stage's chance to `events.CHANCE` (default 0.30).
3. New art keys go in the `M` motif table of `static/events.js` (64×64 line
   art) — unknown keys fall back to a sea motif — or, for the realms, in
   `REALM_M` of `static/events_realms.js` (with the card backdrop in
   `realmBand`). A new world `model` needs a builder in `static/worldfx.js`,
   or in `static/worldfx_realms.js` (`BUILD` + its `REALM_LOOK` entry).
4. A new game kind: a generator/move/bot/solve in `eventgames.py` (register
   it in `GAMES` and `GAME_LABEL`), a renderer in `static/events.js`
   (`gameBody`), and it is covered by the parametrised tests in
   `tests/test_events.py` automatically.

## The Frostfang Reach and the Verdigris Deep

Both realms are sailed, so their events fire on open water, on a quiet
hunting ground (`wild`), at the realm's haven and at its shrine. Content is in
`event_data_ice.py` / `event_data_jungle.py`, merged into `event_data.EVENTS`
and `WORLD`.

**The Frostfang Reach (`ice`)** — 25 events and 4 wonders.

| kind | events |
|---|---|
| choice | Boreas Is Sulking · A Mammoth in the Ice · The Polar Bear's Kitchen · Hyperborean Tourists · The Floe Is Cracking · A Hot Spring in the Ice |
| game | The Aurora Takes Requests (lights-out) · The Ice-Fishing Philosopher (nim) · The Floe Field (floe) · Your Anchor Is on a Floe (floe) · The Auk's Ice-Hole Game (pairs) · A Frost Giant's Little Game (rps) · Coins in a Berg (knucklebones) · Nine Snowballs, One Rock (weigh) · Three Igloos and a Seal (shells) · The Icicle Harp (sequence) |
| instant | The Seal Choir · A Letter Frozen in the Ice · A Narwhal Escort · A Snowball Ambush |
| table | The Great Ice-Hole Derby (lanes) · How Many Icicles in the Giant's Beard? (guess) · The Aurora Plays for Everyone (vote) · The Polar Plunge (gamble) · The Walrus Auction (bid) |
| world | The Walrus Toll-Keeper (`walrus`: fixed; pay, riddle or out-stare) · The Aurora Whale (`aurora_whale`: roams; tows toward the Wyrm or the haven) · The Sleeping Giant (`berg_giant`: fixed, radius 1, hostile; silver or a fight) · The Penguin Parliament (`penguins`: fixed; a fleet-wide vote or a pairs game) |

**The Verdigris Deep (`jungle`)** — 24 events and 4 wonders.

| kind | events |
|---|---|
| choice | Monkeys in the Rigging · A Parrot Who Repeats Everything · A Golden Idol, Slightly Cursed · The Mosquito Cloud · A Lost Explorer · The Tree-Frog Apothecary |
| game | The Temple of the Four Plates (plates) · Drums Across the Water (drums) · The Piranha Crossing (crossing) · Vines That Want a Riddle (riddle) · Fireflies Spelling Something (anagram) · The Glow-Worm Grotto (pairs) · Cracking Coconuts (knucklebones) · The Stone Calendar (higher/lower) · The Sliding Mosaic (sliding) |
| instant | Rain, Sudden and Total · Something Falls on Your Head · Pink River Dolphins · The Giant Lilies Bloom |
| table | The Howler Monkey Choir (vote) · How Many Frogs on the Log? (guess) · The Lily-Raft Race (lanes) · The Piranha Lottery (lowest) · The Ruin-Raiders' Auction (bid) |
| world | The Monkey Traders (`monkey_raft`: roams; mystery bundles, a shell game) · The Hungry Orchid (`orchid`: fixed, radius 1, hostile; a fight or a song) · The Sloth Oracle (`sloth`: fixed; a turn for a secret) · The Jaguar Who Plays Fair (`jaguar`: roams, hostile; rps or a fight) |

The 3D pieces (`static/worldfx_realms.js`): a walrus with tusks and a brass
badge sprawled on a floe beside a TOLL sign; a translucent whale of green and
violet light circling in the air with ribbon trails; an iceberg with a
sleeping face, icicle beard and snore-mist; rows of penguins (one instanced
mesh) facing a wigged Speaker at an ice lectern; a bamboo raft heaped with
loot and crewed by monkeys in stolen hats; a giant pink orchid that breathes
open and shut on a lily-pad raft of roots, a toothed glowing heart; a dead
tree in the river with an ancient sloth hanging from a mossy branch; the
jaguar GLB lounging on a drifting mossy log.

## The Bleached Reach and the second Isles set

The desert is walked, so its events fire on the dune trail and its waypoints
(`sea`), a quiet hunting ground (`wild`), a spent shrine (`islet`), a charged
shrine and the haven — never on the pass, the lair or a Sphinx gate. A tow
(`move`) never carries a captain past an unanswered Sphinx gate (events._move).
Content: `event_data_desert.py` (25 events + 4 wonders) and
`event_data_hub2.py` (8 Isles cards + 8 wonders), merged into `event_data`.

**The Bleached Reach (`desert`)**

| kind | events |
|---|---|
| choice | A Djinn With a Literal Mind · The Sandal Salesman · A Colossal Head That Wants Company · A Mummy Who Is Mostly Lonely · A Camel With Opinions · A Well Among the Palms |
| game | The Sphinx's Junior Apprentice (riddle) · The Tax Scribe of Ra (codebreak) · The Bazaar Haggling Duel (haggle) · A Scorpion Plays Knucklebones · The Tomb With a Sliding Door (sliding) · The Sundial Priest's Sum (sequence) · Nine Canopic Jars (weigh) · The Dry River's Ferryman (crossing) · The Architect's Capstones (nim) |
| instant | Something Under the Sand · Spat On by a Passing Camel · Ancient Graffiti · A Single Generous Palm |
| table | The Great Camel Race (race) · The Caravanserai Auction (bid) · A Mirage Everyone Can See (vote) · The Date-Seller's Basket (guess) · Three Ways Round the Great Dune (lanes) · The Scarab Pit (gamble) |
| world | The Salt Caravan (`caravan`: roams; water, a haggle, a ride toward the haven) · A Wandering Sandstorm (`sandstorm`: roams, radius 1, hostile; scatters you) · A Shimmering Oasis (`mirage`: fixed; real or not) · The Golden Dung-Beetle (`beetle`: roams; help it, rob it, or bow) |

**The Isles of Peace, second set**

| kind | events |
|---|---|
| cards | Odysseus Asks for Directions · Diogenes Is in Your Light · The Fishwife of Piraeus (haggle) · Talos, Bronze Lifeguard · Sisyphus Lets Go (instant) · A Gull Steals Your Hat (instant) · The Hippocampus Derby (race) · The Argonauts' Lost Property (bid) |
| world | The Runaway Festival Barge (`barge`: drifts two stops a round; party, tow it in, or call a fleet vote) · The Golden Fish (`goldfish`: roams; pays the first to reach it) · The Ghost Ship (`ghostship`: roams, hostile; swap places with a rival) · The Singing Whales (`whales`: fixed, radius 1) · Hermes, Slightly Lost (`hermes`: two stops a round; a parcel for the wrong captain — `rival`) · Daedalus' Automaton (`automaton`: fixed; nim) · The Wandering Isle (`turtleisle`: hops three stops a round) · Icarus' Crash Site (`icarus`: fixed; salvage) |

**3D.** Every wonder in `static/worldfx.js` now uses a real set piece and a
marker: a soft additive light pool and a shaft of light (`makeWonderBeacon`,
coloured by temperament — gold for good fortune, red for hostile, cyan for
curious), and sea pieces ride the real swell (`st.surf.waveHeight`, as the
ships do). The old stand-ins are gone: the merchant is `makeMerchantShip`,
the dolphins are three `makeDolphin`s leaping round the stop, the whirlpool,
fog bank and wreck are their `eventprops.js` builders, the festival is a ring
of paper lanterns on floats round the island plus a pavilion on a moored
raft, and the fey market is a purple pavilion with a fire and motes.
`static/models/wonders.js` builds the rest procedurally: a three-camel salt
caravan with a drover; a turning column of blown sand; palms and a pool that
fade in and out; a giant scarab pushing a golden ball; a garlanded barge with
a pavilion and a goat; a golden fish leaping with a splash ring; a translucent
green galley in a mist; two humpbacks (one rolling, one breaching, a spout);
a winged parcel with a winged hat and a golden trail; a bronze automaton at a
pebble table on a raft; a sea turtle carrying a palm island; Icarus' wings
awash beside a sulking boy on a rock. They are in the contact sheet as
`wd_*` (`/static/modeltest.html?set=procedural`).

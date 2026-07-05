# QA — Reviewer Panel

Five independent reviewers, each with a distinct lens, reviewed the
post-overhaul build (QA screenshot set `qa_report/*/shots`, README, docs,
and source). Reviews are reproduced in full below, then triaged.

**Scores: mainstream 7/10 · strategy 7.5/10 · casual "would play again".**
Consensus strengths: the d3 loop-lattice sailing, battle staging, the
"Aegean bronze" UI identity, the ice realm, side-answering. Consensus
weaknesses: HUD/scene text contrast in high-key realms, enemy HP
readability, phone touch targets, jungle value separation.

## Triage

### Fixed in this pass
| finding | raised by | fix |
|---|---|---|
| Trader's Stall panel unreadable over water | mainstream, casual, AD, UX | **False alarm — harness artifact.** The panel is opaque; the QA screenshot caught the first frames of its 250 ms fade-in (it appears only once the arrival camera settles). The `visual` suite now waits for the sheet before shooting. Real fixes kept: nothing needed in product. |
| Realm title text vanishes on same-hue scenes (gold on sand) | mainstream, casual, AD, UX | Realm banner now sits on a translucent dark scrim pill with a blur, keeping the accent colour readable on any stage. |
| Specular/glitter tiling artifact on water (worst in ice) | AD | Glitter field rotated to an incommensurate axis pair — interference no longer forms a grid. |
| GUARD and FLEE adjacent (fat-finger flees) | casual | FLEE is separated from the stance trio with a spacer gap. |
| Rules/engine mismatch: README prices FLEE at 2 scrolls, engine charges 1 | strategy | README corrected to the engine's 1 scroll (`FLEE_COST`). |
| Correct/wrong answers signalled by colour only | UX | Revealed options now carry ✓/✗ glyphs beside the green/red fill. |
| No numeric countdown on the question timer | UX | The timer bar shows a seconds readout, and keeps the low-time colour shift. |
| Silent dead socket during long outages | UX | A persistent "reconnecting" veil now dims and blocks the board until the socket recovers. |
| Sub-44 px touch targets (mute, map, item slots) on phones | UX, casual | Mobile breakpoint bumps them to 44 px. |
| Meshy assets read glossy/smooth beside faceted world (canopy "glazed caramel") | AD | Structure/prop loaders clamp material roughness to ≥ 0.85. |
| Jungle value collapse (green fog on green islands) | AD | Jungle fog colour lifted ~8% so islands separate from the murk. |

### Backlog (worth doing, not in this pass)
- Enemy nameplates: segmented HP bars sized like the player's hearts, and
  tethered to creature world positions (battle.js). *(mainstream, casual, AD)*
- Guard-vs-Strike dominance against bosses; magic backfire scaling with
  depth; heavy-telegraph rhythm after enrage. Balance work — needs the
  game's designer, not QA. *(strategy)*
- Per-player sail patterns / shape badges for colour-blind identity. *(UX)*
- `prefers-reduced-motion` honoured in JS (camera swoops, lunges, sail
  tweens) — currently CSS-only. *(UX)*
- Simultaneous boss trials for 6-player endgames; per-tier question
  timing. *(strategy)*
- Desert set-dressing: fewer saguaros, more Greek ruin props; densify the
  middle distance. *(mainstream, AD)*
- Title screen: render the live board behind the entry card (smoke_title
  already shows how good it looks). *(AD)*
- Turn-queue indicator ("2 turns until you") beside the YOU pill. *(casual)*
- Pharos/lighthouse texture re-bake for chase-camera distances. *(mainstream)*
- Side-answer streak income cap for the seal leader. *(strategy)*

### Amber Vale team (hands-off for QA)
- Canopy gloss and single-silhouette monotony; bare white placeholder
  rock; two/three distinct tree silhouettes wanted. *(mainstream, AD)*

---

## Review 1 — Mainstream outlet

## Review: THALASSA — A Bronze Die, Four Realms, and a Lot of Promise

**By Cass Meridian, Senior Reviewer**

There's a moment early in THALASSA — a browser-based, phone-friendly strategy-trivia board game for 2–6 players — where the camera settles behind your little striped-sail ship, the Pharos lighthouse blazing on the horizon, dashed lanes threading between low-poly islands. It's genuinely lovely, and it announces the game's best trick: this is a digital board game that actually feels like a *place*.

First impressions land well. The title screen is a confident parchment-and-gold card — laurel wreaths, Cinzel small caps, engraved bronze buttons — that sells the "Aegean bronze" fantasy before you've rolled anything. My one flinch: RESET THE TABLE sits one tap below JOIN THE VOYAGE, a destructive act begging for a misfire.

Sailing is the heart, and it works. You roll a bronze d3, glowing halos mark your exact landing spots, and a toast spells out the rule ("Rolled 3 — sail exactly that far"). The lattice of looping routes turns a baby die into real navigation puzzles, and the close chase camera — you only ever see the next few islands — makes a small board feel like open water.

The four realms are the ambitious swing, and they're uneven. The Frostfang Reach is the standout: fog, drifting icebergs, crystal formations, a realm title in tracked-out glacial blue. The Verdigris Deep's murky swamp-green water and lily-pad shallows genuinely change the mood. The Bleached Reach's on-foot desert trek is a clever mechanical shift, but the space reads empty — and I have to ask why a mythic Greek desert is dotted with saguaro cacti. The autumn vale is a wall of identical orange broccoli-trees in peach fog; atmospheric at a squint, monotonous after two turns. Realm intro text also loves to camouflage itself — gold "THE BLEACHED REACH" against gold sand nearly disappears.

Battles are better staged than they read. Each fight is a proper diorama — your hoplite or beached ship facing rime harpies or salt jackals amid themed set dressing — and the stance system (Strike/Magic/Guard/Flee, each gated by trivia tiers) is a smart, tense loop, especially against bosses that telegraph heavies. But the enemy nameplates carry a health readout that's a single tiny red sliver labeled "power," while your own HP is a friendly row of hearts. In a game about reading a fight, the enemy's state is nearly invisible.

The UI is the same story: gorgeous system, shaky execution in spots. The compass HUD, player plaque, and typography are cohesive and classy. Then you dock at a market isle and the Trader's Stall panel renders almost fully transparent over blazing turquoise water — item names, prices, and BUY buttons dissolve into the sea. It's the single worst screen in the game.

What stands between THALASSA and feeling AAA is polish density: smudgy texture bakes on the Pharos the camera loves to hug, soft blurry blobs under the water surface that read as artifacts, middle-distances with nothing in them, and contrast failures exactly where information matters. The bones — art direction, camera, battle staging, that d3 lattice — are already there.

**Score: 7/10** — A charming, mechanically clever voyage that needs a readability pass and a set-dressing budget.

**What would raise the score**

- Raise the Trader's Stall panel's opacity or add a backdrop blur so item names, prices, and BUY buttons are legible over bright water on market isles.
- Replace the tiny "power" sliver on battle enemy nameplates with a segmented health bar sized like the player's hearts row.
- Add a dark scrim or outline behind realm intro titles so "THE BLEACHED REACH" doesn't vanish into same-hue sand.
- Swap the desert realm's saguaro cacti for Greek-appropriate props (broken columns, bleached statues, olive scrub) and densify its middle distance.
- Break up the autumn vale with two or three distinct tree silhouettes, visible trunks, and ground litter.
- Re-bake or trim-detail the Pharos and hub lighthouse textures, since the chase camera puts them inches from the lens.
- Fix the soft blurry under-surface blobs in the ice and jungle water shaders.
- Move RESET THE TABLE off the title card's main column and behind a confirmation dialog. *(QA note: a confirmation dialog already exists; placement stands.)*

---

## Review 2 — Strategy critic

## The Rules Lawyer's Log — Thalassa, reviewed by Kastellan "Meeples Before Temples" Vray

I came to Thalassa braced for the worst genre mashup since trivia met roll-and-move: a browser toy wearing a board game's clothes. I left having lost a ship, two seals, and an argument about Guard timing. That is usually a good sign.

**The d3 is the whole game, and it knows it.** Exact-movement dice are a graveyard of designs, but Thalassa's chart is a lattice of *loops* — ring roads, spokes, chords — so a roll of 2 is rarely one answer. You steer the small circles, orbit a shrine until the die cooperates, or bail down a spoke. The QA doc shows real sweat here: hop distances tuned from a p95 of 155 world-units down to 77, sail legs at a median 5.7 seconds, buoy-stacked twitch-hops purged. This is pacing engineering most physical games never get, and it shows at the table — turns *move*. The mountain-pass rule (landfall halts you, whatever the die said) is quietly the best line in the rulebook: it converts approach angles into planning without a single extra component.

**The realm fork is honest structure.** Perilous road: short, every stop an elite pack in deep water. Long road: a wide arc with a shrine, weak packs, and — the elegant bit — the haven checkpoint hung *out on a detour loop*, so safety costs tempo twice. Realm lanes are deliberately fine-grained (a waypoint every ~42 units), so a d3 nudges you one or two stops: the dungeon crawl actually crawls. Smart.

**Combat is a wager dressed as a fight**, and mostly the math sings. Strike is a tier-I question for 1 reliable damage. Magic is a tier-III question for 3, with a backfire on a miss. Guard is tier-I and ripostes the incoming blow for its own power — doubled on a boss's telegraphed heavy (every third exchange), which makes reading the heavy your biggest hit of the fight. Enrage at half health tightens the screws. Rivals answering from the sidelines for skimmed scrolls (with a streak bonus at three) is the killer app for multiplayer trivia: nobody is ever off-duty.

Now the worries. Against a boss, Guard answers an *easier* question than Strike, deals *more* damage (boss power, doubled on heavies), *and* negates the counter that Strike always eats. On paper Guard doesn't compete with Strike — it embarrasses it. Second: the magic backfire is 1 damage, cheap insurance on a 3-damage swing; a table with one trivia shark will watch them Magic-spam through the shallows. Third, a genuine rules-lawyer catch: the rulebook prices Flee at 2 scrolls; the engine charges 1. Pick one.

**Catch-up is well-judged.** Shipwreck sends unbanked seals back to their lairs and halves your scrolls — brutal, but bosses are personal trials, so nobody's win is sniped, and haven checkpoints keep the walk of shame short. The runaway leader still exists: 30 scrolls buys the Golden Fleece and near-immortality.

**Pacing:** at 2 players this is a taut 60–75 minutes of chess with a pub quiz inside it. At 6, the 35-second question window plus 5-second reveal makes every turn a broadcast; side-answering saves it from downtime death, but the solo boss trials at the far end stack up like planes over Heathrow.

**Score: 7.5/10.** A gimmick-free trivia engine bolted to a genuinely clever movement puzzle. Fix the stance dominance and the 6-player endgame and it's an 8.5.

**Design notes for the table:**
- Reconcile Flee's cost — README says 2 scrolls, `game.py` charges `FLEE_COST = 1`.
- Give Strike a niche vs Guard: e.g., Guard ripostes fail against power-1 trash, or Strike ignores enrage bonuses.
- Scale magic backfire with realm depth (1 flat damage is too cheap at tier-III reward levels).
- Shorten `QUESTION_SECS` for 2–3 players, or scale it per tier.
- Vary the heavy telegraph after enrage — a fixed every-third rhythm is solved by turn two.
- Cap side-answer streak income for the seal leader to soften snowballing.
- Run simultaneous boss trials when multiple captains reach lairs, or 6-player endgames sprawl.
- Consider a small scroll bounty per perilous-road elite, so the shortcut pays in loot as well as tempo.

---

## Review 3 — Art director

## THALASSA — Visual Review, Build full1
*— A.D. critique, board & battle passes, 2026-07-05*

**1. Cohesion.** The board layer is in good shape: the hand-built low-poly islands, ship, and buoys share a facet language and sit convincingly in the new water. The seam shows where Meshy assets land. The Pharos (vis_hub, flow_hub) survives because its baked grime and gold hinges read as "aged marble" and the silhouette stays architectural. The failures are organic assets: the hoodoo spires in vis_battle are smooth, clay-sculpted forms with zero facets standing beside flat-shaded toy cacti — two different games in one frame. Same in realm_autumn, where the Meshy canopy blobs carry a wet specular that reads as glazed caramel, not foliage. Rule going forward: Meshy assets get a roughness floor (~0.85), flattened normals at distance, and a light polygon-quantize pass so their silhouettes pick up facets; alternatively keep them for stone/architecture only, where smoothness is diegetic.

**2. Per-stage grades.**
- **Hub — A-.** Strength: flow_hub is the best frame in the build — Pharos anchoring lower-right, god-rays, route lines leading the eye. Fix: two lighthouses at wildly different scales in one shot (vis_hub) confuses the landmark hierarchy; restyle the small one as a beacon tower.
- **Ice — B+.** Strength: the low-sun glitter path in realm_ice is a genuine money shot; the hushed value script matches themes.js intent. Fix: the specular sheet shows a hard checkerboard tiling artifact across the glitter field (vis_ice, realm_ice) — rotate/scale the second sparkle octave in water.js to break the grid.
- **Desert — B-.** Strength: the dark cloaked pawn against high-key sand (vis_desert) is textbook figure-ground. Fix: realm_desert's gold title dissolves into the sand — swap realm titles to the theme accent with a dark rim, and give the horizon a ridge or heat-shimmer band; the upper third is dead.
- **Jungle — C+.** Strength: pink lotus clusters are perfect accent punctuation against silt water. Fix: green fog on green islands over brown water collapses value separation (vis_jungle) — raise sun intensity through gaps or brighten fog color 10%, and fix the hard-clipped flat islands at frame top.
- **Autumn — B.** Strength: long raking shadows through amber fog (realm_autumn) give the maze real mood, the best fog integration in the build. Fix: kill the canopy gloss, and texture the one bare white rock — it reads as an unshaded placeholder.
- **Battle — B-.** Strength: battle_stance's ship-in-foreground staging creates real depth and scale drama. Fix: enemy nameplates float at screen-top while the jackals stand mid-frame (vis_battle) — tether plates to the creatures; the jackals also vanish tonally into sand.
- **Title/UI — B+.** Strength: the parchment-and-gold card is a confident, ownable identity; smoke_title's blurred board backdrop is the right move. Fix: vis_title's flat black void wastes that equity — always render the board behind; and vis_shop is a shipping blocker: the trader panel is near-transparent and the ship renders *over* the modal. *(QA note: shown to be a screenshot-timing artifact — the sheet was caught mid fade-in; the panel is opaque in play.)*

**3. Lighting & value.** The five scripts in themes.js are legible and distinct — hub noon, ice low-key, desert high-key, autumn golden hour: a real color script. The weakness is midtone compression: desert and jungle live in a narrow value band with nothing anchoring the darks. The view-following shadows help (temple shadow in vis_question, tree shadows in autumn), but shadow opacity in high-key stages needs +15% to restore structure.

**4. The water.** The micro-ripple and glitter pass is the single biggest upgrade this build — hub water finally sparkles like the Aegean. Two defects: the periodic tiling in the specular (worst in ice), and the underwater "shallow" discs, which render as soft smears that read like depth-of-field errors (realm_ice lower half, vis_jungle) rather than shoals. Jungle's sparkle 0.4 leaves the silt water inert; nudge chop instead.

**5. Priority actions.**
1. Fix vis_shop: opaque panel background and render order so the ship never draws over the modal (style.css / ui.js). *(QA: harness artifact — capture timing fixed instead.)*
2. Break the specular tiling in water.js with a rotated second glitter octave.
3. Tether battle nameplates to enemy world positions (battle.js).
4. Add roughness floor + facet-quantize pass to Meshy imports (props.js / monsters.js).
5. Recolor realm title cards to theme accent with dark outline for desert/autumn legibility.
6. Lift jungle fog value or add god-ray gaps to restore island/water separation (themes.js jungle block).
7. Replace the soft shallow-disc gradient with a crisp shoreline shading band (water.js / islands.js).
8. Render the live board behind the entry card in vis_title as smoke_title already does (app.js).

---

## Review 4 — Casual player

## THALASSA: My Friend Said "Just Click the Link," and Honestly? That Part Ruled

*by a person who has rage-quit three Jackbox games and one friendship*

My friend texted a link. I tapped it, typed my name into a fancy parchment card that called me "captain," hit JOIN THE VOYAGE, and I was in. No account, no app store, no "verify you are human." I locked my phone mid-game, unlocked it, and my little boat was still there. That's already better than half the party games I own.

The title screen is gorgeous — gold letters, laurel leaves, a blurry lighthouse behind it. It also has four tiny paragraphs explaining the rules, which I did not read, because I have never read rules and I will die this way.

Turns out you don't need them. Big gold ROLL button at the bottom, you smash it, a die tells you a number, and some spots on the water light up with little light beams. Tap a glowing spot, boat sails there, boat does a cute wiggle. My body understood this in one turn. What my body did NOT understand: on my phone, the glowing rings are subtle and close together, and I absolutely sent my ship to the wrong rock at least twice. There's a tiny toast at the bottom that says "Rolled 3 — sail exactly that far" in italic font approximately the size of a grain of rice.

The trivia is where it gets fun and evil. You land on a shrine, wager on a question, and — best part — you can answer *other people's* questions from the couch and skim their rewards, so waiting for turns doesn't feel like watching someone parallel park. Then I sailed into open water and got AMBUSHED by two ice harpies. Suddenly I'm in a full 3D battle scene with four buttons: STRIKE, MAGIC, GUARD, FLEE. I fat-fingered FLEE while aiming for GUARD (they're touching!), lost the coin flip, and got pecked. The harpy health bars up top are little red slivers I had to squint at like a phone eye exam.

Also the desert level makes you walk?? On foot?? Iconic. Rude, but iconic.

**Would I play again?** Yes — genuinely, next game night. It looks like a Ghibli screensaver, my phone didn't melt, and the "steal trivia while you wait" thing fixes the boredom problem. But somebody please make it thumb-proof first.

**Annoyances & wishes:**
- GUARD and FLEE are neighbors in the battle row — separate them before I flee from another pigeon by accident.
- The shop menu is see-through with my ship's name tag sitting ON TOP of the price list; I could not read what I was buying. *(QA note: screenshot-timing artifact; opaque in play.)*
- The desert's title text is gold-on-sand and basically invisible.
- The hearts/scrolls bar in the top corner is microscopic on a phone.
- Make the glowing move-spots glow HARDER — big fat tap circles, please.
- Tell me how long until my turn instead of just a tiny "YOU" pill.
- The die only goes to 3, which felt like rolling a coupon.

---

## Review 5 — UX / accessibility

## THALASSA — Heuristic UX & Accessibility Review

*Reviewed by Claude, UX/Accessibility Specialist — heuristic pass over 17 QA screenshots, `style.css`, and client source. WCAG 2.2 AA lens, calibrated for a casual multiplayer game.*

### 1. Text contrast & legibility over 3D scenes

**Works:** The parchment/bronze HUD language is strong — dark chip HUD, gold-on-navy nameplates, and the bottom status ribbon (`flow_sail.png`: "Rolled 3 — sail exactly that far") all sit on opaque dark pills with text-shadow. Question cards are opaque parchment. **Fails:** Realm title cards are decorative text painted straight onto the scene: `realm_desert.png` shows "THE BLEACHED REACH" in pale gold over sand — nearly invisible; `vis_ice.png`/`realm_ice.png` render light-blue caps over sun-glinted water, dropping well below 3:1 where the glare band crosses. Worst offender: `vis_shop.png` — the Trader's Stall panel is semi-transparent over bright water; item names, prices, and BUY buttons are washed to near-illegibility, and Penelope's nameplate overlaps the list. "YOUR MOVE" in `vis_battle.png` (desert diorama) is thin italic over sand. **Fix:** give the shop panel an opaque parchment or ≥85%-opacity dark backdrop, and put realm titles on a scrim or add a heavy dark outline/shadow.

### 2. Color-only signaling

**Works:** Battle stances pair color with icons, text labels, and tier chips — exemplary. Question domains carry text labels ("History & Places"), not just their accent hue. **Fails:** The six player colors (`game.py`: `#e4572e, #2e86ab, #f6ae2d, #8e5572, #33ca7f, #6457a6`) include red/green and orange/yellow pairs that collapse under deuteranopia, and ships/chips differ *only* by color. The 35s timer bar's sole urgency cue is turning red at 25% (`startTimerBar`) — invisible to protans. Correct/wrong answer states (`.opt.good`/`.opt.bad`) differ only by green/red fill. **Fix:** add per-player sail patterns or shape badges, and a ✓/✗ glyph on revealed answers.

### 3. Timed questions & motion

**Works:** A genuine `prefers-reduced-motion: reduce` block exists and is thoughtful — charge stripes freeze "still striped," glows go static. 35s is generous, and `REVEAL_SECS` gives a readable beat. **Fails:** Reduced-motion coverage is CSS-only; no `matchMedia` in `scene.js`/`battle.js`/`app.js`, so camera swoops, sailing tweens, and battle lunges ignore the preference — the highest vestibular-risk motion is the unmitigated part. The timer is a 7px bar with no numeric countdown, raising cognitive load under pressure; there's no per-user time-extension option (WCAG 2.2.1 — defensible in synchronous multiplayer, but expose `QUESTION_SECS` as a host setting). **Fix:** gate camera easing/swoop amplitude on the same media query and add a seconds counter to the timer bar.

### 4. Touch targets at phone scale

**Works:** A real 700px breakpoint reflows everything bottom-anchored; answer options go single-column full-width; ROLL is huge. **Fails:** Mute/map (38×38), item slots (38–40px), small `.act` buttons (~30px tall), and shop BUY rows all land under the 44px comfortable minimum with 6–7px gaps; `.pname` at 11.5px is straining. **Fix:** bump interactive icons/slots to 44px with ≥8px gaps.

### 5. State feedback

**Works:** Turn pill ("YOU"), turn banner, toasts + battle log, action-oriented ribbons, and seamless token-based reconnect with exponential backoff are all solid. **Fails:** "Connection lost — reconnecting…" fires one transient toast on the first retry only — during a long outage the board looks alive and taps silently die. On mobile the log truncates to two entries, so "what just happened" evaporates. Whose-turn for *other* players is a small banner easy to miss mid-scene. **Fix:** persistent dimmed overlay while the socket is down, cleared on resume.

### Top 8 fixes

1. Make the shop panel backdrop opaque (`vis_shop.png` is currently unreadable over water). *(QA: harness artifact.)*
2. Add a scrim or heavy outline behind realm title cards, worst in `realm_desert.png`.
3. Show a persistent "reconnecting" overlay that blocks/dims input until the socket recovers.
4. Respect `prefers-reduced-motion` in JS: damp camera swoops, lunges, and sail tweens.
5. Add a numeric seconds readout (and a pulse, not just a red hue-shift) to the question timer.
6. Give each player a sail pattern/shape badge so identity survives color-blindness.
7. Enlarge mute, map, and item-belt targets to 44×44px on the mobile breakpoint.
8. Stamp ✓/✗ icons on revealed correct/wrong answer options alongside the green/red fill.

"""
Thalassa event CONTENT — pure data, read by events.py (schema in its header
and in docs/EVENTS.md). To add a region's events, append records with
``stage`` set to the region key ("ice", "jungle", "desert", …); a new kind
of game also needs a generator/checker in eventgames.py and a renderer in
static/events.js.

Conventions: an option's ``stakes`` is the short line printed on its button
(what you risk / what you might win); the LAST option of a card is the
cautious one (the idle clock picks it for an absent captain); every game
card offers a way to decline.
"""

# ── the Isles of Peace ──────────────────────────────────────────────────────
HUB = [
    # ── CHOICE cards ────────────────────────────────────────────────────────
    {"id": "zeno", "stage": "hub", "kind": "game", "art": "philosopher",
     "where": ["sea"], "weight": 3, "heavy": True, "once": "player",
     "title": "The Unmoving Philosopher",
     "text": "A bearded man sits in a rowboat in the middle of the lane and "
             "informs you that motion is impossible: to reach him you must first "
             "cover half the distance, then half of that… He will not shift until "
             "you concede, or out-think him at pebbles.",
     "options": [
         {"label": "Out-think him at pebbles", "stakes": "win: +3 scrolls · lose: Becalmed",
          "outcome": {"text": "He tips a heap of pebbles onto the thwart. 'Take one, two or "
                              "three. Whoever takes the last pebble wins the argument.'",
                      "game": {"kind": "nim", "params": {"err": 0.3},
                               "win": {"text": "He stares at the empty thwart, then at you, "
                                               "and rows away muttering about tortoises.",
                                       "scrolls": 3, "buff": ["fortune", 1]},
                               "lose": {"text": "'You see? You cannot win, therefore you "
                                                "cannot move.' Your crew half believes him.",
                                        "buff": ["becalmed", 1]}}}},
         {"label": "Nudge him with the ram", "stakes": "needs a Bronze Ram · +2 scrolls",
          "requires": {"upgrade": "ram"},
          "outcome": {"text": "A gentle bump disproves him at once. He drops his purse "
                              "in the excitement.", "scrolls": 2}},
         {"label": "Concede the paradox", "stakes": "Becalmed for a roll",
          "outcome": {"text": "'Very well, motion is impossible.' He beams, rows aside — and "
                              "your crew, now philosophically uncertain, rows half-heartedly.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "goat", "stage": "hub", "kind": "game", "art": "goat",
     "where": ["sea", "islet"], "weight": 3, "heavy": True, "once": "player",
     "title": "The Goat Has Eaten Your Charts",
     "text": "A stowaway goat emerges from the hold, chewing thoughtfully on what "
             "used to be the eastern half of the Aegean. The cook has a wolf-pup "
             "in a basket and opinions about goats.",
     "options": [
         {"label": "Ferry them ashore, one by one", "stakes": "a crossing puzzle · win: +3 scrolls, Fair Wind",
          "outcome": {"text": "Your skiff holds you and one passenger. Leave the wolf with "
                              "the goat, or the goat with the charts, and something gets eaten.",
                      "game": {"kind": "crossing", "params": {"max_trips": 11},
                               "win": {"text": "Everyone ashore, nobody eaten. The goat "
                                               "coughs up a coin purse in gratitude.",
                                       "scrolls": 3, "buff": ["fair_wind", 2]},
                               "lose": {"text": "There is a crunch. You sail on, poorer "
                                                "in charts and morale.", "scrolls": -1}}}},
         {"label": "Chase it round the deck", "stakes": "a gamble · scrolls or a bruise",
          "roll": [[1, {"text": "You corner it by the mast; it surrenders a mouthful of "
                                "soggy coin.", "scrolls": 2}],
                   [1, {"text": "It feints left. You go left. The mast does not.",
                        "hull": -1}]]},
         {"label": "Let it finish the map", "stakes": "Becalmed for a roll",
          "outcome": {"text": "You navigate by vibes for a while.", "buff": ["becalmed", 1]}},
     ]},

    {"id": "gulls", "stage": "hub", "kind": "choice", "art": "gulls",
     "where": ["sea", "islet", "shop", "haven"], "weight": 3,
     "title": "The Gulls Have Unionised",
     "text": "A delegation of gulls lands on your yard-arm. Their spokesbird, a "
             "one-legged veteran, presents demands: one fish per gull, per day, and "
             "the right to shriek at dawn.",
     "options": [
         {"label": "Pay the tithe", "stakes": "−1 scroll · Fortune's Favour",
          "requires": {"scrolls": 1},
          "outcome": {"text": "The gulls accept with dignity. A gull's blessing is a "
                              "mysterious, mostly white thing.",
                      "scrolls": -1, "buff": ["fortune", 1]}},
         {"label": "Put it to the whole fleet", "stakes": "everyone votes",
          "when": {"players_min": 2},
          "outcome": {"text": "The spokesbird agrees to a fleet-wide ballot.",
                      "table": {"kind": "vote", "prompt": "The gulls' demands — how does the fleet answer?",
                                "choices": [
                                    {"label": "Every ship pays a scroll",
                                     "outcome": {"text": "The gulls depart, fat and gracious.",
                                                 "scrolls": -1, "buff": ["fortune", 1]}},
                                    {"label": "Defy them",
                                     "outcome": {"text": "The gulls strike. Every deck is "
                                                         "splattered; every crew is cross.",
                                                 "buff": ["becalmed", 1]}}]}}},
         {"label": "Refuse", "stakes": "risky",
          "roll": [[1, {"text": "The gulls shrug and go and bother a fishing boat."}],
                   [1, {"text": "The gulls strike. It is not pretty, and the rigging "
                                "will never be the same.", "hull": -1}]]},
     ]},

    {"id": "siren", "stage": "hub", "kind": "game", "art": "siren",
     "where": ["sea"], "weight": 2, "heavy": True, "hostile": True,
     "title": "A Siren's Song",
     "text": "From a rock comes a song so lovely your oarsmen stop rowing and start "
             "crying. She sings of an islet no chart shows — and of what is buried there.",
     "options": [
         {"label": "Finish her song", "stakes": "a puzzle · win: +3 scrolls and her secret",
          "outcome": {"text": "She pauses on a phrase and waits for you to complete it.",
                      "puzzle": {"kind": "sequence",
                                 "win": {"text": "Delighted, she sings you the islet's "
                                                 "bearing.", "scrolls": 3, "reveal": "sword"},
                                 "lose": {"text": "She winces at your tuning. Your ship "
                                                  "drifts onto her rock.", "hull": -1}}}},
         {"label": "Listen, lashed to the mast", "stakes": "a gamble",
          "roll": [[3, {"text": "You hear the whole verse, including the bearing of a "
                                "hidden islet.", "reveal": "sword"}],
                   [2, {"text": "You hear the whole verse. So does the rope, which gives up.",
                        "hull": -1}]]},
         {"label": "Stop your ears with wax", "stakes": "safe",
          "outcome": {"text": "You sail past, smug and deaf, for most of the afternoon."}},
     ]},

    {"id": "fisherman", "stage": "hub", "kind": "choice", "art": "fisher",
     "where": ["sea", "islet", "haven"], "weight": 3,
     "title": "An Old Fisherman",
     "text": "An old man in a leaky boat holds up a fish the size of a child and "
             "a gap-toothed grin. 'Fresh! Mostly!'",
     "options": [
         {"label": "Buy his catch", "stakes": "−1 scroll · +2 Health",
          "requires": {"scrolls": 1, "hurt": True},
          "outcome": {"text": "Grilled on the deck, it mends spirits and planks alike.",
                      "scrolls": -1, "hull": 2}},
         {"label": "Help him haul his net", "stakes": "a gamble",
          "roll": [[2, {"text": "Up comes an amphora of pitch. He insists you keep it.",
                        "item": "planks"}],
                   [2, {"text": "Up comes a lot of seaweed and a very surprised crab.",
                        "scrolls": 1}],
                   [1, {"text": "Up comes nothing, and you strain your back.", "hull": -1}]]},
         {"label": "Ask for the news", "stakes": "Fair Wind",
          "outcome": {"text": "'Wind's turning,' he says, and he's right.",
                      "buff": ["fair_wind", 1]}},
     ]},

    {"id": "pirates", "stage": "hub", "kind": "choice", "art": "pirates",
     "where": ["sea"], "weight": 2, "hostile": True, "heavy": True,
     "title": "Pirates Off the Bow",
     "text": "A black-sailed galley wheels out from behind a headland. Its captain "
             "is waving a cutlass and, less convincingly, a lute.",
     "options": [
         {"label": "Fight them", "stakes": "a battle · loot if you win",
          "outcome": {"text": "You bring her about. Steel it is.", "fight": True}},
         {"label": "Pay them off", "stakes": "−2 scrolls",
          "requires": {"scrolls": 2},
          "outcome": {"text": "They take the scrolls and play you a ballad. It is bad.",
                      "scrolls": -2}},
         {"label": "Outrun them", "stakes": "a gamble",
          "roll": [[3, {"text": "You catch a gust and leave them in your wake.",
                        "buff": ["fair_wind", 1]}],
                   [2, {"text": "A grappling hook takes a bite of the rail before you "
                                "break free.", "hull": -1}]]},
     ]},

    {"id": "cyclops", "stage": "hub", "kind": "choice", "art": "cyclops",
     "where": ["sea"], "weight": 2, "once": "player",
     "title": "A Cyclops, Fishing With a Mast",
     "text": "A one-eyed giant stands waist-deep in the shallows, fishing with a "
             "ship's mast and a whale for bait. He squints at you. 'WHO ARE YOU?'",
     "options": [
         {"label": "'My name is Nobody.'", "stakes": "Fortune's Favour",
          "outcome": {"text": "He laughs until he cries. 'NOBODY! I HAD A FRIEND CALLED "
                              "THAT.' The sea feels luckier.", "buff": ["fortune", 2]}},
         {"label": "Ask him the way", "stakes": "a gamble · a long throw",
          "roll": [[1, {"text": "'THAT WAY.' He picks up your ship and throws it. Helpfully.",
                        "move": {"toward": "random", "steps": 3}}],
                   [1, {"text": "'THAT WAY.' He points with the mast and clips your stern.",
                        "hull": -1, "scrolls": 1}]]},
         {"label": "Row past quietly", "stakes": "safe",
          "outcome": {"text": "He is too busy with the whale to notice."}},
     ]},

    {"id": "taxman", "stage": "hub", "kind": "game", "art": "merman",
     "where": ["sea", "shop", "haven"], "weight": 2, "heavy": True,
     "title": "Poseidon's Tax Collector",
     "text": "A merman in a very official hat surfaces with a wax tablet. 'Harbour "
             "dues, captain. Two scrolls. Unless you'd care to claim an exemption?'",
     "options": [
         {"label": "Claim an exemption", "stakes": "a riddle · win: +2 · lose: −2",
          "outcome": {"text": "'Exemptions are granted to the wise. Answer me this.'",
                      "puzzle": {"kind": "riddle",
                                 "win": {"text": "'Exemption granted. And a refund, for "
                                                 "your trouble.'", "scrolls": 2},
                                 "lose": {"text": "'Fraudulent exemption. That's a fine.'",
                                          "scrolls": -2}}}},
         {"label": "Bribe him with a Gale Charm", "stakes": "a Gale Charm → +3 scrolls",
          "requires": {"item": "gale"},
          "outcome": {"text": "He pockets the charm, pays you for the inconvenience, and "
                              "swims off whistling.", "item_spend": "gale", "scrolls": 3}},
         {"label": "Pay the dues", "stakes": "−2 scrolls · Fortune's Favour",
          "requires": {"scrolls": 2},
          "outcome": {"text": "'Very civic of you.' He stamps your hull with a seal of "
                              "good standing.", "scrolls": -2, "buff": ["fortune", 1]}},
         {"label": "Dive for it", "stakes": "a gamble",
          "roll": [[1, {"text": "You simply sail away. He is not a fast swimmer."}],
                   [1, {"text": "He is a fast swimmer. He bites.", "hull": -1}]]},
     ]},

    {"id": "kraken", "stage": "hub", "kind": "choice", "art": "kraken",
     "where": ["sea"], "weight": 2, "hostile": True, "heavy": True,
     "title": "The Kraken Rises",
     "text": "The sea bulges. A tentacle as thick as a temple column lays itself "
             "across your bow, and an eye the size of a sail regards you. It wants "
             "riddles. Or lunch.",
     "options": [
         {"label": "Answer its riddles", "stakes": "two riddles · miss one: lose a turn",
          "outcome": {"text": "The eye narrows. Patterns swim up through the water.",
                      "kraken": 2, "log": "the kraken's riddles"}},
         {"label": "Toss it a cask of scrolls", "stakes": "−3 scrolls",
          "requires": {"scrolls": 3},
          "outcome": {"text": "It accepts the cask, reads two of the scrolls, and sinks "
                              "back, apparently satisfied with the prose.", "scrolls": -3}},
         {"label": "Run for it", "stakes": "a gamble · a lost turn",
          "roll": [[1, {"text": "You row like heroes and slip out from under the tentacle."}],
                   [1, {"text": "It drags your ship in a slow, insulting circle.",
                        "skip": True}]]},
     ]},

    {"id": "nereid", "stage": "hub", "kind": "instant", "art": "nereid",
     "where": ["sea", "islet", "shrine"], "weight": 2,
     "title": "A Nereid's Blessing",
     "text": "A sea-nymph rides your bow wave for a while, laughing, and touches "
             "the hull before she dives.",
     "roll": [[2, {"text": "The sprung planks close up like healing skin.", "hull": 2}],
              [2, {"text": "The wind comes round behind you.", "buff": ["fair_wind", 2]}],
              [1, {"text": "She leaves a pearl on the deck.", "scrolls": 2}]]},

    {"id": "bottle", "stage": "hub", "kind": "instant", "art": "bottle",
     "where": ["sea"], "weight": 3,
     "title": "A Message in a Bottle",
     "text": "A sealed bottle bobs against the hull.",
     "roll": [[3, {"text": "Inside: a shopping list from Penelope, and coin to pay for it.",
                   "scrolls": 2}],
              [1, {"text": "Inside: a chart with an islet circled in red.", "reveal": "sword"}],
              [2, {"text": "Inside: a gale, corked. You uncork it carefully later.",
                   "item": "gale"}],
              [2, {"text": "Inside: a very long poem about a very sad cloud. The crew "
                           "is moved.", "buff": ["fortune", 1]}]]},

    {"id": "poet", "stage": "hub", "kind": "instant", "art": "poet",
     "where": ["sea", "islet", "haven", "shop"], "weight": 2,
     "title": "A Stowaway Poet",
     "text": "A poet crawls out of a grain sack and insists on reciting his epic "
             "in exchange for passage.",
     "roll": [[1, {"text": "It is magnificent. Your crew rows as if pursued by Muses.",
                   "buff": ["fair_wind", 2]}],
              [1, {"text": "It is in eleven books. Your crew rows as if asleep.",
                   "buff": ["becalmed", 1]}],
              [1, {"text": "He pays his fare in a single, beautiful scroll.", "scrolls": 1}]]},

    {"id": "turtle", "stage": "hub", "kind": "choice", "art": "turtle",
     "where": ["sea", "islet"], "weight": 2, "when": {"hurt": True},
     "title": "The Turtle Physician",
     "text": "An enormous sea-turtle with a seaweed beard surfaces and peers at your "
             "hull. 'Hmm. Barnacles. Rot. Some very poor carpentry.' He has a satchel.",
     "options": [
         {"label": "Pay for treatment", "stakes": "−2 scrolls · +3 Health",
          "requires": {"scrolls": 2, "hurt": True},
          "outcome": {"text": "He works slowly but thoroughly. Turtles always do.",
                      "scrolls": -2, "hull": 3}},
         {"label": "Ask for a free consultation", "stakes": "+1 Health",
          "outcome": {"text": "'Rest it,' he says, and patches one plank out of pity.",
                      "hull": 1}},
     ]},

    {"id": "regatta", "stage": "hub", "kind": "table", "art": "regatta",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "An Impromptu Regatta",
     "text": "A herald on a buoy blows a conch: every ship in the Isles is "
             "entered in a race, like it or not. Three lanes. One swift, one calm, "
             "one full of rocks. Nobody knows which.",
     "table": {"kind": "lanes", "prompt": "Pick a lane — secretly.",
               "lanes": {"swift": {"text": "", "scrolls": 2, "buff": ["fair_wind", 1]},
                         "calm": {"scrolls": 1},
                         "rocky": {"hull": -1}},
               "log": "the regatta"}},

    {"id": "auction", "stage": "hub", "kind": "table", "art": "auction",
     "where": ["sea", "shop"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Floating Auction",
     "text": "A barge hung with lanterns drifts into the lane. Its auctioneer "
             "holds up an Aegis Charm and a crate of pitch: 'Sealed bids, captains, "
             "sealed bids! Highest pays, highest wins!'",
     "table": {"kind": "bid", "prompt": "Your sealed bid, in scrolls (0 to sit it out).",
               "params": {"cap": 8, "worth": 6},
               "prize": {"items": ["aegis_charm", "planks"]}, "log": "the floating auction"}},

    {"id": "olives", "stage": "hub", "kind": "table", "art": "amphorae",
     "where": ["sea", "islet", "shop", "haven"], "weight": 2,
     "heavy": True, "when": {"players_min": 2},
     "title": "How Many Olives?",
     "text": "A merchant with magnificent eyebrows holds up a glass jar of olives. "
             "'Closest guess takes three scrolls! Somewhere between twenty and eighty, "
             "I'll tell you that much.'",
     "table": {"kind": "guess", "prompt": "How many olives in the jar?",
               "params": {"range": [20, 80]},
               "prize": {"scrolls": 3}, "log": "the olive jar"}},

    {"id": "lottery", "stage": "hub", "kind": "table", "art": "dice",
     "where": ["sea", "islet", "haven"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "Poseidon's Lottery",
     "text": "A priest of the sea-god rows from ship to ship with a bronze urn. "
             "'Choose a number from one to five. The LOWEST number nobody else "
             "chose wins the god's favour!'",
     "table": {"kind": "lowest", "prompt": "Choose a number — the lowest unique one wins.",
               "params": {"max": 5},
               "prize": {"scrolls": 2, "item": "planks"}, "log": "Poseidon's lottery"}},

    {"id": "zeus_mood", "stage": "hub", "kind": "table", "art": "storm",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "Zeus Is in a Mood",
     "text": "Thunderheads pile up over the Pharos. Somebody has offended the "
             "father of the gods — probably by existing. The fleet must decide how "
             "to appease him.",
     "table": {"kind": "vote", "prompt": "How does the fleet appease Zeus?",
               "choices": [
                   {"label": "Each tosses a scroll overboard",
                    "outcome": {"text": "The sky clears. Zeus is placated, and "
                                        "slightly richer.",
                                "scrolls": -1, "buff": ["fortune", 1]}},
                   {"label": "Batten down and endure",
                    "outcome": {"text": "The storm breaks over every deck.", "hull": -1}},
                   {"label": "Sing a hymn, loudly",
                    "outcome": {"text": "It is so off-key that Zeus leaves to get "
                                        "away from it. Every crew is hoarse.",
                                "buff": ["becalmed", 1]}}],
               "log": "Zeus's mood"}},

    {"id": "festival_lottery", "stage": "hub", "kind": "table", "art": "festival",
     "where": ["islet", "haven", "shop"], "weight": 1, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Wine-Jar Wager",
     "text": "A tipsy priest of Dionysos staggers aboard with a jar and a die. "
             "'Ante one scroll! If the god throws high, every brave soul gets three "
             "back!' He hiccups. 'Probably.'",
     "table": {"kind": "gamble", "prompt": "Ante one scroll — or stay out.",
               "params": {"ante": 1}, "odds": 0.5,
               "win": {"scrolls": 3}, "hit_text": "The god throws a six!",
               "miss_text": "The god throws a one, and falls over.",
               "log": "the wine-jar wager"}},

    # ── GAMES ───────────────────────────────────────────────────────────────
    {"id": "satyr_dice", "stage": "hub", "kind": "game", "art": "satyr",
     "where": ["islet", "sea", "haven"], "weight": 3, "heavy": True,
     "title": "A Satyr at Knucklebones",
     "text": "A satyr sits on an upturned amphora rattling a sheep's knucklebone. "
             "'One throw at a time, captain. Pile up the points — but if it lands "
             "on the dog, you lose the lot.'",
     "options": [
         {"label": "Play (stake 1 scroll)", "stakes": "6+ breaks even · 12+: +3 · 18+: +5",
          "requires": {"scrolls": 1},
          "outcome": {"text": "He hands you the bone. It is warm and suspicious.",
                      "game": {"kind": "knucklebones", "params": {"goals": [6, 12, 18]},
                               "score": [[6, {"text": "You break even, and the satyr "
                                                      "sulks."}],
                                         [12, {"text": "The satyr pays up, grumbling.",
                                               "scrolls": 3}],
                                         [18, {"text": "The satyr pays up and weeps "
                                                       "openly.", "scrolls": 5}]],
                               "lose": {"text": "The dog! He pockets your stake.",
                                        "scrolls": -1}}}},
         {"label": "Decline politely", "stakes": "safe",
          "outcome": {"text": "'Coward,' he says, cheerfully."}},
     ]},

    {"id": "oracle_tiles", "stage": "hub", "kind": "game", "art": "oracle",
     "where": ["islet", "sea"], "weight": 3, "heavy": True,
     "title": "The Drowned Oracle's Tiles",
     "text": "On a half-sunk altar lies a bag of clay tiles numbered one to nine, "
             "two of each. A carved mouth says: 'CALL THE NEXT TILE HIGHER OR LOWER. "
             "THE SPENT TILES LIE BEFORE YOU. STOP WHEN YOU ARE WISE.'",
     "options": [
         {"label": "Draw the tiles", "stakes": "2 right: +1 · 3: +2 · 5: +4",
          "outcome": {"text": "The first tile clatters onto the altar.",
                      "game": {"kind": "higher_lower", "params": {"need": 5},
                               "score": [[2, {"text": "The altar spits out a scroll.",
                                              "scrolls": 1}],
                                         [3, {"text": "The altar spits out two scrolls.",
                                              "scrolls": 2}],
                                         [5, {"text": "The oracle laughs, delighted, and "
                                                      "the altar overflows.", "scrolls": 4,
                                              "buff": ["fortune", 1]}]],
                               "lose": {"text": "The tiles fall wrong and the altar "
                                                "goes silent."}}}},
         {"label": "Leave the oracle to her sleep", "stakes": "safe",
          "outcome": {"text": "Wise, possibly."}},
     ]},

    {"id": "sealed_jar", "stage": "hub", "kind": "game", "art": "amphorae",
     "where": ["sea", "islet"], "weight": 3, "heavy": True,
     "title": "A Jar Sealed With Three Glyphs",
     "text": "Your net drags up a jar stoppered with a bronze lock: three dials, "
             "four glyphs — owl, olive, wave, star. Scratched on the side: 'Six tries, "
             "then the acid.'",
     "options": [
         {"label": "Work the lock", "stakes": "a code-breaker · win: Aegis Charm, +2",
          "outcome": {"text": "Each try, the lock clicks: so many glyphs in place, so "
                              "many present but misplaced.",
                      "game": {"kind": "codebreak", "params": {"tries": 6},
                               "win": {"text": "The lid springs. Inside, wrapped in oilcloth: "
                                               "a charm and coin.",
                                       "item": "aegis_charm", "scrolls": 2},
                               "lose": {"text": "A hiss, a smell of lemons, and the jar's "
                                                "contents become soup."}}}},
         {"label": "Smash it", "stakes": "a gamble",
          "roll": [[1, {"text": "Coins everywhere!", "scrolls": 2}],
                   [1, {"text": "Bees. Somehow, bees.", "hull": -1}]]},
         {"label": "Throw it back", "stakes": "safe",
          "outcome": {"text": "Some jars are best left to the fish."}},
     ]},

    {"id": "sophist_cups", "stage": "hub", "kind": "game", "art": "cups",
     "where": ["sea", "islet", "shop"], "weight": 3, "heavy": True,
     "title": "The Sophist's Cups",
     "text": "A sophist on a raft has three cups, one pearl, and a sign on each "
             "cup. 'No sleight of hand, captain — I abhor manual labour. Only logic. "
             "I'll even tell you how many of my signs are true.'",
     "options": [
         {"label": "Wager a scroll", "stakes": "win: +3 · lose: −1",
          "requires": {"scrolls": 1},
          "outcome": {"text": "He sits back and lets you read.",
                      "game": {"kind": "shells",
                               "win": {"text": "The pearl! He applauds, genuinely.",
                                       "scrolls": 3},
                               "lose": {"text": "Empty. 'Logic is a harsh mistress.' "
                                                "He keeps your scroll.", "scrolls": -1}}}},
         {"label": "Play for the honour of it", "stakes": "win: Fortune's Favour",
          "outcome": {"text": "'Honour! How quaint.'",
                      "game": {"kind": "shells",
                               "win": {"text": "He tips his hat. You feel lucky.",
                                       "buff": ["fortune", 2]},
                               "lose": {"text": "'Better luck next paradox.'"}}}},
         {"label": "Sail on", "stakes": "safe",
          "outcome": {"text": "He shouts a syllogism after you."}},
     ]},

    {"id": "smuggler_amphorae", "stage": "hub", "kind": "game", "art": "amphorae",
     "where": ["sea", "islet", "shop"], "weight": 2, "heavy": True,
     "title": "The Smuggler's Nine Amphorae",
     "text": "A nervous smuggler offers you a deal: nine identical amphorae, one "
             "of them full of silver. 'Use my balance — three weighings, mind. Pick "
             "the heavy one and it's yours. I'm in a hurry.'",
     "options": [
         {"label": "Use the balance", "stakes": "a weighing puzzle · win: +4 scrolls",
          "outcome": {"text": "The balance creaks expectantly.",
                      "game": {"kind": "weigh", "params": {"jars": 9, "weighings": 3},
                               "win": {"text": "Silver! The smuggler is already gone.",
                                       "scrolls": 4},
                               "lose": {"text": "Olive oil. Very good olive oil, to be "
                                                "fair.", "hull": 1}}}},
         {"label": "Wave him off", "stakes": "safe",
          "outcome": {"text": "He rows away, looking over his shoulder."}},
     ]},

    {"id": "satyr_rps", "stage": "hub", "kind": "game", "art": "satyr",
     "where": ["islet", "sea"], "weight": 2, "heavy": True,
     "title": "Stone, Scroll, Shears",
     "text": "A satyr sprawled on a rock challenges you to stone, scroll, shears — "
             "first to three. He is a terrible bluffer; his ears give him away. "
             "You just have to learn how.",
     "options": [
         {"label": "Play him (stake 1 scroll)", "stakes": "win: +3, Fortune · lose: −1",
          "requires": {"scrolls": 1},
          "outcome": {"text": "He cracks his knuckles, then his hooves.",
                      "game": {"kind": "rps", "params": {"need": 3},
                               "win": {"text": "'Best of seven?' he pleads. You sail on.",
                                       "scrolls": 3, "buff": ["fortune", 1]},
                               "lose": {"text": "He bleats triumphantly.", "scrolls": -1}}}},
         {"label": "Decline", "stakes": "safe",
          "outcome": {"text": "He throws shears at your departing back. It is a gesture."}},
     ]},

    # ── WORLD meetings (fired only by landing on / beside the entity) ──────
    {"id": "meet_merchant", "stage": "hub", "kind": "game", "art": "merchant",
     "where": ["sea"], "world": True,
     "title": "The Wandering Merchant",
     "text": "A fat-bellied merchantman with patched purple sails heaves to. Her "
             "master leans on the rail. 'Captain! I sell what nobody else has — "
             "and I buy nothing.'",
     "options": [
         {"label": "Buy a sealed crate", "stakes": "−3 scrolls · who knows?",
          "requires": {"scrolls": 3},
          "roll": [[3, {"text": "Pitch and planks, packed in straw.", "scrolls": -3,
                        "items": ["planks", "planks"]}],
                   [3, {"text": "An Aegis Charm and a War Horn!", "scrolls": -3,
                        "items": ["aegis_charm", "horn"]}],
                   [1, {"text": "A ship's fitting, still in its wrapper.", "scrolls": -3,
                        "upgrade": True}],
                   [2, {"text": "Figs. Two hundred figs.", "scrolls": -3, "hull": 2}]]},
         {"label": "Buy his chart of the hidden islet", "stakes": "−6 scrolls",
          "requires": {"scrolls": 6}, "when": {"no_sword": True},
          "outcome": {"text": "He unrolls it with a flourish. An islet, circled in red.",
                      "scrolls": -6, "reveal": "sword"}},
         {"label": "Play his tile game", "stakes": "free · up to +4",
          "outcome": {"text": "'A sporting captain! Higher or lower, then.'",
                      "game": {"kind": "higher_lower", "params": {"need": 5},
                               "score": [[2, {"text": "He pays a scroll, sighing.",
                                              "scrolls": 1}],
                                         [3, {"text": "He pays two.", "scrolls": 2}],
                                         [5, {"text": "He pays four and throws in a "
                                                      "Gale Charm to make you leave.",
                                              "scrolls": 4, "item": "gale"}]],
                               "lose": {"text": "'Better luck next port!'"}}}},
         {"label": "Wave him on", "stakes": "safe",
          "outcome": {"text": "'Your loss!' he calls, cheerfully."}},
     ]},

    {"id": "meet_dolphins", "stage": "hub", "kind": "choice", "art": "dolphins",
     "where": ["sea"], "world": True,
     "title": "A Pod of Dolphins",
     "text": "Dolphins boil around your bow, clicking and grinning. One of them "
             "has taken hold of your bow-line, and is looking at you expectantly.",
     "options": [
         {"label": "Take a tow toward Home Port", "stakes": "carried up to 4 stops",
          "outcome": {"text": "They haul you along at a splendid clip.",
                      "move": {"toward": "home", "steps": 4}}},
         {"label": "Take a tow toward a haven", "stakes": "carried up to 4 stops",
          "outcome": {"text": "They know a quiet harbour, apparently.",
                      "move": {"toward": "haven", "steps": 4}}},
         {"label": "Feed them and wave", "stakes": "Fortune's Favour",
          "outcome": {"text": "They leap in thanks. Sailors say that's lucky.",
                      "buff": ["fortune", 2]}},
     ]},

    {"id": "meet_whirlpool", "stage": "hub", "kind": "choice", "art": "whirlpool",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "Charybdis' Little Sister",
     "text": "The sea tilts. A whirlpool — small, as these things go, but very "
             "enthusiastic — has your keel in its grip.",
     "options": [
         {"label": "Ride the spiral", "stakes": "flung somewhere · a gamble",
          "roll": [[1, {"text": "Round and round and OUT — somewhere else entirely.",
                        "move": {"toward": "random", "steps": 4}}],
                   [1, {"text": "It spits you out with something it had been keeping.",
                        "move": {"toward": "random", "steps": 3}, "scrolls": 2}]]},
         {"label": "Throw an offering in", "stakes": "−2 scrolls · Fair Wind",
          "requires": {"scrolls": 2},
          "outcome": {"text": "It burps contentedly and lets you go, with a push.",
                      "scrolls": -2, "buff": ["fair_wind", 2]}},
         {"label": "Row hard against it", "stakes": "−1 Health",
          "outcome": {"text": "Oars crack, but you hold your course.", "hull": -1}},
     ]},

    {"id": "meet_fog", "stage": "hub", "kind": "choice", "art": "fog",
     "where": ["sea"], "world": True,
     "title": "The Fog Bank",
     "text": "Grey wool swallows the masthead, then the bow. Somewhere off to "
             "port, a bell is ringing.",
     "options": [
         {"label": "Follow the bell", "stakes": "a gamble",
          "roll": [[1, {"text": "A lost buoy, hung with offerings. You help yourself.",
                        "scrolls": 2}],
                   [1, {"text": "You emerge — but where?",
                        "move": {"toward": "random", "steps": 3}}]]},
         {"label": "Feel your way out", "stakes": "Becalmed for 2 rolls",
          "outcome": {"text": "Slow, slow, careful.", "buff": ["becalmed", 2]}},
     ]},

    {"id": "meet_wreck", "stage": "hub", "kind": "game", "art": "wreck",
     "where": ["sea"], "world": True,
     "title": "A Wreck Surfaces",
     "text": "A storm has turned the sea-bed over, and an old trireme's hull has "
             "floated up, barnacled and gaping. Things glitter in the dark of the hold.",
     "options": [
         {"label": "Dive for treasure", "stakes": "dive deeper for more · an eel takes it all",
          "outcome": {"text": "Each dive deeper finds more — until the eel wakes.",
                      "remove_world": True,
                      "game": {"kind": "knucklebones", "params": {"goals": [6, 12, 18]},
                               "score": [[6, {"text": "A handful of old coin.",
                                              "scrolls": 2}],
                                         [12, {"text": "A chest of silver!", "scrolls": 4}],
                                         [18, {"text": "A captain's hoard — and his "
                                                       "lucky charm.", "scrolls": 6,
                                               "item": "aegis_charm"}]],
                               "lose": {"text": "The eel! You surface with nothing but "
                                                "a story and a bite.", "hull": -1}}}},
         {"label": "Salvage her planks", "stakes": "Pitch & Planks",
          "outcome": {"text": "Good seasoned timber.", "item": "planks",
                      "remove_world": True}},
         {"label": "Leave the dead in peace", "stakes": "Fortune's Favour",
          "outcome": {"text": "You pour a little wine on the water and sail on.",
                      "buff": ["fortune", 1]}},
     ]},

    {"id": "meet_festival", "stage": "hub", "kind": "choice", "art": "festival",
     "where": ["islet", "haven", "shop", "shrine", "sea"], "world": True,
     "title": "A Festival of Dionysos",
     "text": "Garlands on every mast, a flute somewhere, a goat in a hat. The "
             "island is having a festival and you are, apparently, invited.",
     "options": [
         {"label": "Join the dancing", "stakes": "+1 Health · +1 scroll",
          "outcome": {"text": "You dance until your knees hurt and your purse is "
                              "mysteriously heavier.", "hull": 1, "scrolls": 1}},
         {"label": "Sample the wine", "stakes": "a gamble",
          "roll": [[3, {"text": "Divine. You feel the god's favour.", "buff": ["fortune", 2]}],
                   [2, {"text": "You feel the god's favour tomorrow, in your head.",
                        "buff": ["becalmed", 1]}]]},
         {"label": "Enter the drinking contest", "stakes": "everyone may join",
          "outcome": {"text": "The festival master bangs a cup on the table.",
                      "table": {"kind": "lowest", "prompt": "How many cups can you "
                                "handle? The lowest number nobody else names wins "
                                "(the rest are under the table).",
                                "params": {"max": 5},
                                "prize": {"scrolls": 3, "hull": 1},
                                "log": "the drinking contest"}}},
     ]},

    {"id": "meet_serpent", "stage": "hub", "kind": "choice", "art": "serpent",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "The Roaming Sea-Serpent",
     "text": "Coils like green bronze rise on either side of your ship. The serpent "
             "has been prowling these lanes for days, and it is hungry.",
     "options": [
         {"label": "Fight it", "stakes": "a battle · it dives for good",
          "outcome": {"text": "You ready the oars and the courage.",
                      "fight": {"name": "The Roaming Serpent", "unit": "Sea-Serpent",
                                "hp": 4, "power": 1, "model": "serpent", "count": 1},
                      "remove_world": True}},
         {"label": "Throw it the salted fish", "stakes": "−2 scrolls",
          "requires": {"scrolls": 2},
          "outcome": {"text": "It swallows the barrel whole and loses interest.",
                      "scrolls": -2}},
         {"label": "Sneak past", "stakes": "a gamble",
          "roll": [[3, {"text": "It's watching a seal. You slip past."}],
                   [2, {"text": "A lazy tail-flick stoves in your stern.", "hull": -1}]]},
     ]},
]

# ── the Amber Vale ──────────────────────────────────────────────────────────
VALE = [
    {"id": "echo", "stage": "autumn", "kind": "choice", "art": "echo",
     "where": ["sea"], "weight": 3,
     "title": "Echo in the Clearing",
     "text": "A nymph sits on a mossy stone. Anything you say, she says back — "
             "the last few words of it, anyway.",
     "options": [
         {"label": "'Which way to the barrow?'", "stakes": "the woods are lit",
          "outcome": {"text": "'…the barrow? …the barrow?' But she points, and the "
                              "trail ahead brightens.", "reveal": "vale"}},
         {"label": "Sing a duet with her", "stakes": "Fortune's Favour",
          "outcome": {"text": "It is the best duet of your life, mostly because half "
                              "of it is her.", "buff": ["fortune", 1]}},
         {"label": "Shout something rude", "stakes": "a gamble",
          "roll": [[1, {"text": "It bounces round the valley and comes back ruder. A "
                                "squirrel drops an acorn on you.", "hull": -1}],
                   [1, {"text": "She laughs and throws you a coin.", "scrolls": 1}]]},
     ]},

    {"id": "narcissus", "stage": "autumn", "kind": "choice", "art": "narcissus",
     "where": ["sea"], "weight": 2,
     "title": "Narcissus on the Footbridge",
     "text": "A beautiful youth is lying across the only footbridge, gazing into "
             "the stream at himself. He has been there some time. He shows no sign "
             "of leaving.",
     "options": [
         {"label": "Hand him a Hint Stone to gaze into", "stakes": "a Hint Stone → +3 scrolls",
          "requires": {"item": "hint"},
          "outcome": {"text": "Portable reflection! He pays you handsomely and wanders "
                              "off, enraptured.", "item_spend": "hint", "scrolls": 3}},
         {"label": "Compliment him until he moves", "stakes": "Becalmed for a roll",
          "outcome": {"text": "It takes a long time. He agrees with all of it.",
                      "buff": ["becalmed", 1]}},
         {"label": "Wade the stream", "stakes": "−1 Health",
          "outcome": {"text": "It is colder than it looks.", "hull": -1}},
     ]},

    {"id": "pomegranate", "stage": "autumn", "kind": "choice", "art": "pomegranate",
     "where": ["sea"], "weight": 2, "once": "player",
     "title": "Persephone's Pomegranate",
     "text": "On a stump lies a split pomegranate, glistening. A note in neat "
             "handwriting: 'Help yourself. — P.'",
     "options": [
         {"label": "Eat a seed", "stakes": "a gamble · a nap",
          "roll": [[1, {"text": "Sweet as summer. Your bruises fade.", "hull": 3}],
                   [1, {"text": "You lie down for a moment and wake up a season later.",
                        "skip": True, "hull": 2}]]},
         {"label": "Pocket it for later", "stakes": "+1 scroll",
          "outcome": {"text": "Somebody will pay for an underworld fruit.", "scrolls": 1}},
         {"label": "Leave it", "stakes": "safe",
          "outcome": {"text": "You know how these stories go."}},
     ]},

    {"id": "wisp", "stage": "autumn", "kind": "game", "art": "wisp",
     "where": ["sea"], "weight": 3, "heavy": True,
     "title": "A Will-o'-the-Wisp",
     "text": "A blue light bobs between the trunks, just ahead, just ahead, just "
             "ahead. It seems to want you to follow.",
     "options": [
         {"label": "Follow it", "stakes": "a gamble · it knows a way",
          "roll": [[3, {"text": "It leads you straight and true, toward the barrow.",
                        "move": {"toward": "lair", "steps": 3}}],
                   [2, {"text": "It leads you in a merry circle and vanishes.",
                        "move": {"toward": "random", "steps": 2}}]]},
         {"label": "Catch it in a jar", "stakes": "a puzzle · win: a lantern and luck",
          "outcome": {"text": "It flickers across a grid of standing stones.",
                      "puzzle": {"kind": "lights_out",
                                 "win": {"text": "Caught! By its light the woods "
                                                 "unfold before you.",
                                         "reveal": "vale", "buff": ["fortune", 1]},
                                 "lose": {"text": "It slips the jar and blows a "
                                                  "raspberry.", "buff": ["becalmed", 1]}}}},
         {"label": "Ignore it", "stakes": "safe",
          "outcome": {"text": "It looks hurt, for a light."}},
     ]},

    {"id": "arachne", "stage": "autumn", "kind": "game", "art": "spider",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "Arachne's Loom",
     "text": "A web the size of a sail spans the trail, and in it a pattern only "
             "half-finished. A very large spider clears her throat. 'Finish the "
             "weave, and I'll spin you something nice.'",
     "options": [
         {"label": "Finish the weave", "stakes": "a picross · win: Aegis Charm",
          "outcome": {"text": "The rows and columns hum with their counts.",
                      "puzzle": {"kind": "nonogram",
                                 "win": {"text": "She spins you a ward of silk and "
                                                 "bronze.", "item": "aegis_charm"},
                                 "lose": {"text": "'Clumsy,' she says, and wraps your "
                                                  "boots for good measure.",
                                          "buff": ["becalmed", 1]}}}},
         {"label": "Duck under it", "stakes": "safe",
          "outcome": {"text": "Carefully, carefully."}},
     ]},

    {"id": "crow_lock", "stage": "autumn", "kind": "game", "art": "crow",
     "where": ["sea"], "weight": 3, "heavy": True,
     "title": "The Crow's Strongbox",
     "text": "A crow sits on an iron-bound box, which has three dials of four "
             "glyphs: acorn, leaf, moon, feather. 'Six tries,' the crow says. 'I'm "
             "counting.'",
     "options": [
         {"label": "Try the dials", "stakes": "a code-breaker · win: +3, Pitch & Planks",
          "outcome": {"text": "The crow watches every turn of the dials, unblinking.",
                      "game": {"kind": "codebreak", "params": {"tries": 6},
                               "win": {"text": "Click. The crow sighs and flies off.",
                                       "scrolls": 3, "item": "planks"},
                               "lose": {"text": "'Time,' says the crow, and sits back "
                                                "down on it."}}}},
         {"label": "Offer the crow a scroll for it", "stakes": "−1 scroll · a gamble",
          "requires": {"scrolls": 1},
          "roll": [[1, {"text": "The crow takes it and the box holds three more.",
                        "scrolls": 2}],
                   [1, {"text": "The crow takes it and flies off. The box is empty.",
                        "scrolls": -1}]]},
         {"label": "Leave the crow its box", "stakes": "safe",
          "outcome": {"text": "'Wise,' says the crow, sounding disappointed."}},
     ]},

    {"id": "pan_contest", "stage": "autumn", "kind": "game", "art": "satyr",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "Pan's Little Contest",
     "text": "Pan himself, goat-legged and grinning, leans on a beech. 'Stone, "
             "scroll, shears. First to three. I always win.' His ears are already "
             "twitching.",
     "options": [
         {"label": "Play the god", "stakes": "win: +3, Fair Wind · lose: −1 Health",
          "outcome": {"text": "He blows a note on his pipes. 'Begin!'",
                      "game": {"kind": "rps", "params": {"need": 3},
                               "win": {"text": "Pan roars with laughter and blesses "
                                               "your legs.", "scrolls": 3,
                                       "buff": ["fair_wind", 2]},
                               "lose": {"text": "He wins, and celebrates by headbutting "
                                                "you.", "hull": -1}}}},
         {"label": "Decline the god", "stakes": "a gamble",
          "roll": [[1, {"text": "He shrugs. Gods have other hobbies."}],
                   [1, {"text": "Gods do not like being declined. A sudden panic sends "
                                "you the long way round.", "buff": ["becalmed", 1]}]]},
     ]},

    {"id": "hedge_witch", "stage": "autumn", "kind": "choice", "art": "witch",
     "where": ["sea", "haven", "shop"], "weight": 3,
     "title": "The Hedge-Witch's Barrow",
     "text": "An old woman with a wheelbarrow full of jars blocks the trail. "
             "'Tonics, charms, fortunes! Cash only. Scrolls count as cash.'",
     "options": [
         {"label": "A tonic", "stakes": "−2 scrolls · +2 Health",
          "requires": {"scrolls": 2, "hurt": True},
          "outcome": {"text": "It tastes of mushrooms and regret, and it works.",
                      "scrolls": -2, "hull": 2}},
         {"label": "A charm", "stakes": "−3 scrolls · Aegis Charm",
          "requires": {"scrolls": 3},
          "outcome": {"text": "A knot of red thread and a bird bone. Surprisingly sturdy.",
                      "scrolls": -3, "item": "aegis_charm"}},
         {"label": "A fortune", "stakes": "−1 scroll · a gamble",
          "requires": {"scrolls": 1},
          "roll": [[2, {"text": "'A long journey. Good luck on it.'", "scrolls": -1,
                        "buff": ["fortune", 2]}],
                   [1, {"text": "'Oh dear,' she says, and won't say more.", "scrolls": -1,
                        "buff": ["jinx", 1]}]]},
         {"label": "Just browsing", "stakes": "safe",
          "outcome": {"text": "She sniffs."}},
     ]},

    {"id": "boar", "stage": "autumn", "kind": "choice", "art": "boar",
     "where": ["sea"], "weight": 2, "hostile": True, "heavy": True,
     "title": "The Erymanthian Boar's Little Cousin",
     "text": "Something the size of a cart, with tusks like sickles, is rooting "
             "for acorns in the middle of the trail. It looks up. It is not, "
             "apparently, little.",
     "options": [
         {"label": "Fight it", "stakes": "a battle",
          "outcome": {"text": "It lowers its head. So do you.",
                      "fight": {"name": "A Tusked Boar", "unit": "Great Boar",
                                "hp": 4, "power": 1, "model": "boar", "count": 1}}},
         {"label": "Throw it your acorns", "stakes": "−1 scroll",
          "requires": {"scrolls": 1},
          "outcome": {"text": "You had been keeping a scroll's worth of acorns. You do "
                              "not ask yourself why.", "scrolls": -1}},
         {"label": "Climb a tree and wait", "stakes": "Becalmed for a roll",
          "outcome": {"text": "It takes its time.", "buff": ["becalmed", 1]}},
     ]},

    {"id": "owl_trial", "stage": "autumn", "kind": "game", "art": "owl",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "Athena's Owl",
     "text": "An owl with an unnervingly intelligent stare drops a tablet at your "
             "feet. On it: a pattern with one tile missing.",
     "options": [
         {"label": "Complete the pattern", "stakes": "a puzzle · win: +2, Fortune",
          "outcome": {"text": "The owl tilts its head ninety degrees.",
                      "puzzle": {"kind": "ravens",
                                 "win": {"text": "The owl hoots approval and drops a "
                                                 "coin.", "scrolls": 2,
                                         "buff": ["fortune", 1]},
                                 "lose": {"text": "The owl turns its head all the way "
                                                  "round so as not to look at you."}}}},
         {"label": "Bow to the owl and pass", "stakes": "safe",
          "outcome": {"text": "It accepts the bow."}},
     ]},

    {"id": "leaf_pile", "stage": "autumn", "kind": "instant", "art": "leaves",
     "where": ["sea"], "weight": 3,
     "title": "A Suspiciously Large Leaf Pile",
     "text": "It is very large and very inviting. You jump in. Of course you do.",
     "roll": [[2, {"text": "Underneath: somebody's buried stash!", "scrolls": 2}],
              [1, {"text": "Underneath: a hedgehog. An affronted one.", "hull": -1}],
              [2, {"text": "Underneath: more leaves. It is wonderful.",
                   "buff": ["fortune", 1]}]]},

    {"id": "chestnuts", "stage": "autumn", "kind": "instant", "art": "fire",
     "where": ["sea", "haven"], "weight": 2,
     "title": "Chestnuts on the Fire",
     "text": "Woodcutters by a fire wave you over and press hot chestnuts into "
             "your hands.",
     "roll": [[2, {"text": "Warmth, and good company.", "hull": 2}],
              [1, {"text": "They tell you a short cut.", "buff": ["fair_wind", 1]}]]},

    {"id": "midas", "stage": "autumn", "kind": "instant", "art": "leaves",
     "where": ["sea"], "weight": 2,
     "title": "Midas Passed This Way",
     "text": "A whole tree has been turned to gold, leaf by leaf. Someone has "
             "clearly had a very bad week.",
     "roll": [[3, {"text": "You pocket a few fallen leaves.", "scrolls": 2}],
              [1, {"text": "You pocket a few fallen leaves, and touch your nose. "
                           "Hm.", "scrolls": 1, "buff": ["jinx", 1]}]]},

    {"id": "fireflies", "stage": "autumn", "kind": "instant", "art": "wisp",
     "where": ["sea"], "weight": 2,
     "title": "A River of Fireflies",
     "text": "Ten thousand fireflies drift down the trail like a slow green "
             "river, lighting every fork for a mile.",
     "outcome": {"text": "You read the woods ahead by their light.", "reveal": "vale"}},

    {"id": "herm", "stage": "autumn", "kind": "choice", "art": "herm",
     "where": ["sea"], "weight": 2,
     "title": "A Talking Herm",
     "text": "A boundary stone carved with the head of Hermes clears its throat. "
             "'Lost? Everyone's lost. For a scroll I'll point. For free I'll talk.'",
     "options": [
         {"label": "Pay him to point", "stakes": "−1 scroll · carried toward the barrow",
          "requires": {"scrolls": 1},
          "outcome": {"text": "He points with his eyebrows. You go that way, briskly.",
                      "scrolls": -1, "move": {"toward": "lair", "steps": 3}}},
         {"label": "Let him talk", "stakes": "the woods are lit",
          "outcome": {"text": "He talks for an hour. Some of it is directions.",
                      "reveal": "vale"}},
     ]},

    {"id": "fox_pebbles", "stage": "autumn", "kind": "game", "art": "fox",
     "where": ["sea"], "weight": 3, "heavy": True,
     "title": "The Fox Who Counts Pebbles",
     "text": "A red fox has arranged pebbles in a heap on a flat stone. 'We each "
             "take one, two or three. Whoever takes the last one wins my supper.' "
             "Its supper appears to be a sausage.",
     "options": [
         {"label": "Play for the sausage", "stakes": "win: +2 Health, +1 scroll",
          "outcome": {"text": "The fox sits, tail curled neatly round its paws.",
                      "game": {"kind": "nim", "params": {"err": 0.35},
                               "win": {"text": "The fox hands over the sausage with "
                                               "great dignity.", "hull": 2, "scrolls": 1},
                               "lose": {"text": "The fox eats the sausage in front of "
                                                "you, slowly."}}}},
         {"label": "Leave the fox to its supper", "stakes": "safe",
          "outcome": {"text": "It seems relieved."}},
     ]},

    {"id": "ferryman_brook", "stage": "autumn", "kind": "game", "art": "brook",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "The Brook Ferryman's Problem",
     "text": "A miserable ferryman sits beside a coracle with a fox, a hen, and "
             "a sack of grain. 'The boat takes me and one more. The fox eats the "
             "hen, the hen eats the grain. I've been here since Tuesday.'",
     "options": [
         {"label": "Solve it for him", "stakes": "a crossing puzzle · win: +3 scrolls",
          "outcome": {"text": "You roll up your sleeves.",
                      "game": {"kind": "crossing",
                               "params": {"max_trips": 11,
                                          "names": {"wolf": "fox", "goat": "hen",
                                                    "charts": "grain"}},
                               "win": {"text": "He weeps with gratitude and pays you "
                                               "his week's wages.", "scrolls": 3},
                               "lose": {"text": "There is a short, terrible noise. He "
                                                "does not thank you."}}}},
         {"label": "Wish him luck", "stakes": "safe",
          "outcome": {"text": "'Luck,' he says bitterly. 'Ha.'"}},
     ]},

    {"id": "bear_honey", "stage": "autumn", "kind": "choice", "art": "bear",
     "where": ["sea"], "weight": 2, "hostile": True, "heavy": True,
     "title": "A Bear Who Wants Your Honey",
     "text": "A brown bear rises on its hind legs and sniffs your pack with "
             "great interest. You do have honey. It knows you have honey.",
     "options": [
         {"label": "Hand over the honey", "stakes": "−1 scroll",
          "requires": {"scrolls": 1},
          "outcome": {"text": "It sits down and eats it, and forgets you exist.",
                      "scrolls": -1}},
         {"label": "Fight for your honey", "stakes": "a battle",
          "outcome": {"text": "Some things are worth fighting for.",
                      "fight": {"name": "A Hungry Bear", "unit": "Brown Bear",
                                "hp": 5, "power": 1, "model": "boar", "count": 1}}},
         {"label": "Play dead", "stakes": "a gamble",
          "roll": [[3, {"text": "It sniffs you, sighs, and leaves."}],
                   [1, {"text": "It sniffs you, then sits on you for a while.",
                        "hull": -1}]]},
     ]},

    {"id": "shepherd", "stage": "autumn", "kind": "table", "art": "sheep",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Lost Shepherd",
     "text": "A shepherd is weeping into a flock of sheep that will not stand "
             "still. 'I've lost count! Everyone, quick — how many are there?' "
             "It is somewhere between thirty and ninety.",
     "table": {"kind": "guess", "prompt": "How many sheep?",
               "params": {"range": [30, 90]},
               "prize": {"scrolls": 3}, "log": "the shepherd's count"}},

    {"id": "harvest_feast", "stage": "autumn", "kind": "table", "art": "feast",
     "where": ["sea", "haven"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "Demeter's Harvest Feast",
     "text": "Long tables appear in a clearing, groaning with food, and every "
             "captain in the land is summoned to them by a very insistent goose. "
             "The goddess asks only that you agree on the menu.",
     "table": {"kind": "vote", "prompt": "What does the feast serve?",
               "choices": [
                   {"label": "Pies, endless pies",
                    "outcome": {"text": "Everyone eats until they creak.", "hull": 2}},
                   {"label": "Honeyed cider",
                    "outcome": {"text": "Everyone feels wonderfully lucky.",
                                "buff": ["fortune", 1]}},
                   {"label": "Dance until dawn",
                    "outcome": {"text": "Gold rain falls on the dancers — and their "
                                        "feet ache.", "scrolls": 2,
                                "buff": ["becalmed", 1]}}],
               "log": "Demeter's feast"}},

    {"id": "squirrel_auction", "stage": "autumn", "kind": "table", "art": "acorn",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Squirrels' Auction",
     "text": "On a stump, a squirrel in a tiny auctioneer's cap is selling a "
             "golden acorn, a War Horn and a Gale Charm, all as one lot. Every "
             "captain in the woods hears the gavel.",
     "table": {"kind": "bid", "prompt": "Your sealed bid, in scrolls.",
               "params": {"cap": 8, "worth": 5},
               "prize": {"scrolls": 2, "items": ["horn", "gale"]},
               "log": "the squirrels' auction"}},

    {"id": "bracken_race", "stage": "autumn", "kind": "table", "art": "paths",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Three Paths of the Hare",
     "text": "A hare in a waistcoat challenges the whole Vale to a race. Three "
             "paths through the bracken: one is a shortcut, one is a long way "
             "round, and one ends in a bramble patch.",
     "table": {"kind": "lanes", "prompt": "Which path? (secretly)",
               "lanes": {"shortcut": {"scrolls": 2, "buff": ["fair_wind", 1]},
                         "long way": {"scrolls": 1},
                         "brambles": {"hull": -1}},
               "log": "the hare's race"}},

    # ── WORLD meetings in the Vale ─────────────────────────────────────────
    {"id": "meet_ring", "stage": "autumn", "kind": "choice", "art": "mushrooms",
     "where": ["sea"], "world": True,
     "title": "A Fairy Ring",
     "text": "A perfect circle of red-capped mushrooms, humming faintly. The air "
             "inside is a different colour.",
     "options": [
         {"label": "Step inside", "stakes": "whisked away · a gamble",
          "roll": [[1, {"text": "The world spins — you are somewhere else, and "
                                "feel marvellous.", "move": {"toward": "random", "steps": 4},
                        "hull": 1}],
                   [1, {"text": "The world spins — you are somewhere else, nearer "
                                "the barrow.", "move": {"toward": "lair", "steps": 4}}]]},
         {"label": "Pick the mushrooms", "stakes": "a gamble",
          "roll": [[1, {"text": "Rare and valuable.", "scrolls": 3, "remove_world": True}],
                   [1, {"text": "Rare and hallucinogenic.", "buff": ["becalmed", 2],
                        "remove_world": True}]]},
         {"label": "Walk round it", "stakes": "safe",
          "outcome": {"text": "You've read the stories."}},
     ]},

    {"id": "meet_feymarket", "stage": "autumn", "kind": "game", "art": "market",
     "where": ["sea"], "world": True,
     "title": "The Fey Market",
     "text": "Lanterns hang from the branches and stalls have sprung up like "
             "mushrooms. The traders have too many fingers and very good prices.",
     "options": [
         {"label": "Buy a pot of fey honey", "stakes": "−2 scrolls · +3 Health",
          "requires": {"scrolls": 2, "hurt": True},
          "outcome": {"text": "It tastes like a summer you never had.",
                      "scrolls": -2, "hull": 3}},
         {"label": "Trade your shadow for a wind", "stakes": "Fair Wind ×3 · Jinxed",
          "outcome": {"text": "Your feet are light, and your shadow is somebody "
                              "else's problem.", "buffs": [["fair_wind", 3], ["jinx", 1]]}},
         {"label": "Play the fey tiles", "stakes": "free · up to +4",
          "outcome": {"text": "A trader with moth-wing ears lays out the tiles.",
                      "game": {"kind": "higher_lower", "params": {"need": 5},
                               "score": [[2, {"scrolls": 1, "text": "A fey coin."}],
                                         [3, {"scrolls": 2, "text": "Two fey coins."}],
                                         [5, {"scrolls": 4, "item": "hint",
                                              "text": "A purse, and a seeing-stone."}]],
                               "lose": {"text": "The trader giggles. You owe him a "
                                                "dream; he'll collect later."}}}},
         {"label": "Keep walking", "stakes": "safe",
          "outcome": {"text": "Never eat the food. Everybody knows that."}},
     ]},

    {"id": "meet_hound", "stage": "autumn", "kind": "choice", "art": "hound",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "A Hound of Artemis",
     "text": "A silver hound as tall as a pony steps out of the bracken, ears "
             "pricked. It has been ranging these woods since dawn.",
     "options": [
         {"label": "Fight it", "stakes": "a battle · it runs off for good",
          "outcome": {"text": "It bares its teeth.",
                      "fight": {"name": "A Hound of Artemis", "unit": "Silver Hound",
                                "hp": 4, "power": 1, "model": "stalker", "count": 1},
                      "remove_world": True}},
         {"label": "Throw it a stick", "stakes": "a gamble",
          "roll": [[2, {"text": "It bounds off after the stick and never comes back.",
                        "remove_world": True}],
                   [1, {"text": "It brings the stick back. And again. And again.",
                        "buff": ["becalmed", 1]}]]},
         {"label": "Stand very still", "stakes": "a gamble",
          "roll": [[1, {"text": "It sniffs, and pads away."}],
                   [1, {"text": "It knocks you flat on its way past.", "hull": -1}]]},
     ]},
]

EVENTS = HUB + VALE

# the Bleached Reach and the second Isles set live in their own files
import event_data_desert as _desert  # noqa: E402
import event_data_hub2 as _hub2  # noqa: E402
EVENTS += _desert.EVENTS + _hub2.EVENTS
# the Frostfang Reach and the Verdigris Deep, likewise
import event_data_ice as _ice  # noqa: E402
import event_data_jungle as _jungle  # noqa: E402
EVENTS += _ice.EVENTS + _jungle.EVENTS

# ── WORLD entities: visible on the board, alive for a few rounds ───────────
WORLD = [
    {"id": "merchant", "stage": "hub", "title": "The Wandering Merchant",
     "text": "A purple-sailed merchantman trading in oddities. Sail into her stop "
             "to deal.", "art": "merchant", "model": "merchant",
     "rounds": 8, "moves": 1, "where": "sea", "radius": 0, "weight": 4,
     "meet": "meet_merchant", "log": "her purple sails are sighted",
     "gone": "sails over the horizon"},
    {"id": "dolphins", "stage": "hub", "title": "A Pod of Dolphins",
     "text": "Friendly dolphins offering tows. Sail into their stop.", "art": "dolphins",
     "model": "dolphins", "rounds": 5, "moves": 1, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_dolphins", "log": "they leap in the sea-lanes",
     "gone": "have swum away"},
    {"id": "whirlpool", "stage": "hub", "title": "A Whirlpool",
     "text": "Ships landing on or next to it are caught.", "art": "whirlpool",
     "model": "whirlpool", "rounds": 6, "moves": 0, "where": "sea", "radius": 1,
     "weight": 2, "meet": "meet_whirlpool", "log": "the sea begins to turn",
     "gone": "spins itself out"},
    {"id": "fog", "stage": "hub", "title": "A Fog Bank", "art": "fog",
     "text": "Landing in it or beside it slows you down.", "model": "fog",
     "rounds": 5, "moves": 1, "where": "sea", "radius": 1, "weight": 2,
     "meet": "meet_fog", "log": "rolls across the lanes", "gone": "burns off"},
    {"id": "wreck", "stage": "hub", "title": "A Surfaced Wreck", "art": "wreck",
     "text": "Treasure for the first to dive. Sail into its stop.", "model": "wreck",
     "rounds": 5, "moves": 0, "where": "sea", "radius": 0, "weight": 3,
     "meet": "meet_wreck", "log": "an old trireme floats up", "gone": "sinks again"},
    {"id": "festival", "stage": "hub", "title": "A Festival", "art": "festival",
     "text": "Dionysos is in town. Land on the island to join in.", "model": "festival",
     "rounds": 5, "moves": 0, "where": "islet", "radius": 0, "weight": 2,
     "meet": "meet_festival", "log": "flutes and garlands on an island",
     "gone": "winds down"},
    {"id": "serpent", "stage": "hub", "title": "The Roaming Sea-Serpent",
     "art": "serpent", "text": "A hungry serpent prowls the lanes. Avoid its stop — "
             "or go and fight it.", "model": "serpent", "rounds": 7, "moves": 1,
     "where": "sea", "radius": 0, "weight": 3, "meet": "meet_serpent",
     "log": "coils break the surface", "gone": "dives into the deep"},
    # the Amber Vale
    {"id": "ring", "stage": "autumn", "title": "A Fairy Ring", "art": "mushrooms",
     "text": "A ring of humming mushrooms. Step onto its stop to see where it takes you.",
     "model": "ring", "rounds": 6, "moves": 0, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_ring", "log": "mushrooms push up through the leaves",
     "gone": "withers"},
    {"id": "feymarket", "stage": "autumn", "title": "The Fey Market", "art": "market",
     "text": "Lantern-lit stalls with strange wares. Step onto its stop to trade.",
     "model": "feymarket", "rounds": 6, "moves": 0, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_feymarket", "log": "lanterns glimmer in the trees",
     "gone": "is packed away into the dark"},
    {"id": "hound", "stage": "autumn", "title": "A Hound of Artemis", "art": "hound",
     "text": "A silver hound ranging the trails. Avoid its stop — or face it.",
     "model": "hound", "rounds": 6, "moves": 1, "where": "sea", "radius": 0,
     "weight": 2, "meet": "meet_hound", "log": "a baying echoes through the trees",
     "gone": "answers a distant horn and is gone"},
]
WORLD += _desert.WORLD + _hub2.WORLD
WORLD += _ice.WORLD + _jungle.WORLD

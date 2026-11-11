"""
Thalassa event CONTENT, second set for the Isles of Peace — pure data, read by
events.py through event_data.py (schema: events.py header, docs/EVENTS.md).

This set leans on WORLD wonders: things that move about the chart where every
captain can see them and race for them — a runaway festival barge, a golden
fish that pays whoever reaches it first, a ghost ship that swaps two
captains' places, a pod of singing whales, Hermes with a misdelivered
parcel, a pebble-playing automaton, an island that is really a turtle, and
Icarus, crash-landed with salvage. Plus a handful of plain cards.

Conventions as in event_data.py: the LAST option of a card is the cautious
one and has no ``requires``; every option has ``stakes``.
"""

H = "hub"

EVENTS = [
    # ── plain cards ─────────────────────────────────────────────────────────
    {"id": "odysseus_lost", "stage": H, "kind": "choice", "art": "odysseus",
     "where": ["sea", "islet"], "weight": 2, "once": "player",
     "title": "Odysseus Asks for Directions",
     "text": "A battered ship hails you. Its captain, a man with a magnificent "
             "beard and a haunted look, leans over the rail. 'Ithaca? Rocky, "
             "goats, a wife who is very patient? Been looking for ten years.'",
     "options": [
         {"label": "Point him the right way", "stakes": "+1 scroll · Fair Wind",
          "outcome": {"text": "He weeps, embraces your figurehead, and pays you in "
                              "Trojan coin.", "scrolls": 1, "buff": ["fair_wind", 1]}},
         {"label": "Point him the wrong way, for a laugh", "stakes": "a gamble",
          "roll": [[1, {"text": "He sails off happily into another ten years. You feel "
                                "awful, but lucky.", "buff": ["fortune", 1]}],
                   [1, {"text": "He comes back an hour later, cross, with a very large "
                                "bow.", "hull": -1}]]},
         {"label": "Admit you are lost too", "stakes": "Fair Wind",
          "outcome": {"text": "You compare charts. Neither is any good, but between them "
                              "you find a following wind.", "buff": ["fair_wind", 1]}},
     ]},

    {"id": "diogenes", "stage": H, "kind": "choice", "art": "barrel",
     "where": ["islet", "haven", "shop"], "weight": 2,
     "title": "Diogenes Is in Your Light",
     "text": "A philosopher lives in a barrel on the quay, and your ship's shadow "
             "has fallen across him. He opens one eye. 'You. Big wooden thing. "
             "Stand out of my sunlight.'",
     "options": [
         {"label": "Ask him what he wants most", "stakes": "a gamble",
          "roll": [[1, {"text": "'For you to MOVE.' You move. He throws you an honest "
                                "coin — the only one he has.", "scrolls": 1}],
                   [1, {"text": "'Wisdom.' He hands you his lamp. You are not sure why, "
                                "but you feel luckier.", "buff": ["fortune", 1]}]]},
         {"label": "Buy him a new barrel", "stakes": "−2 scrolls · Fortune ×2",
          "requires": {"scrolls": 2},
          "outcome": {"text": "He refuses it on principle, then moves in that evening. The "
                              "gods find this very funny.", "scrolls": -2,
                      "buff": ["fortune", 2]}},
         {"label": "Move your ship", "stakes": "safe",
          "outcome": {"text": "He closes his eye. That is the most thanks anyone gets."}},
     ]},

    {"id": "fishwife", "stage": H, "kind": "game", "art": "fisher",
     "where": ["shop", "haven", "islet", "sea"], "weight": 3, "heavy": True,
     "title": "The Fishwife of Piraeus",
     "text": "A fishwife with forearms like hawsers slaps a giant tuna onto your "
             "rail. 'Best tuna in the Isles! Price? Ha! Make me an offer. Go on. "
             "Insult me. I dare you.'",
     "options": [
         {"label": "Haggle for the tuna", "stakes": "a haggle · up to +3, Health",
          "outcome": {"text": "She folds her arms. Name a price; she will tell you exactly "
                              "how insulted she is.",
                      "game": {"kind": "haggle", "params": {"range": [2, 13], "patience": 4},
                               "score": [[1, {"text": "Overpriced, but delicious.",
                                              "hull": 1}],
                                         [3, {"text": "A bargain. Your crew feasts.",
                                              "hull": 2}],
                                         [4, {"text": "Her lowest price! She hugs you, "
                                                      "hard, and you sell half the tuna on.",
                                              "hull": 2, "scrolls": 2}]],
                               "lose": {"text": "'Time's up, sweetheart.' She sells it to "
                                                "the next ship."}}}},
         {"label": "Say you are vegetarian", "stakes": "safe",
          "outcome": {"text": "She looks at you with genuine pity."}},
     ]},

    {"id": "talos_lifeguard", "stage": H, "kind": "choice", "art": "automaton",
     "where": ["sea"], "weight": 2, "hostile": True,
     "title": "Talos, Bronze Lifeguard",
     "text": "A bronze giant wades the shallows of a nearby isle, blowing a whistle "
             "at anything that moves. 'NO RUNNING ON THE DECK. NO DIVING. NO FUN.' "
             "He has spotted your crew diving.",
     "options": [
         {"label": "Apologise and pay the fine", "stakes": "−1 scroll · Fair Wind",
          "requires": {"scrolls": 1},
          "outcome": {"text": "He issues a receipt the size of a sail. Then, gruffly, a "
                              "following breeze.", "scrolls": -1, "buff": ["fair_wind", 2]}},
         {"label": "Pull the plug on his ankle", "stakes": "a gamble",
          "roll": [[1, {"text": "Ichor gushes out and he sits down, deflated. He leaves "
                                "a tip.", "scrolls": 2}],
                   [1, {"text": "He notices. He blows the whistle directly at your ship. "
                                "It is VERY loud.", "hull": -1}]]},
         {"label": "Sail away very slowly", "stakes": "Becalmed for a roll",
          "outcome": {"text": "'WALK, DON'T RUN,' he shouts after you.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "sisyphus", "stage": H, "kind": "instant", "art": "boulder",
     "where": ["sea", "islet"], "weight": 2,
     "title": "Sisyphus Lets Go",
     "text": "On a steep isle, a man pushing a boulder uphill loses his grip — "
             "again — and it bounds down into the sea beside you with an "
             "enormous splash.",
     "roll": [[2, {"text": "The wave carries you a fine way along.", "buff": ["fair_wind", 1]}],
              [1, {"text": "It knocks loose a barnacled chest from the cliff.", "scrolls": 2}],
              [1, {"text": "It soaks everything, including the bread.", "hull": -1}]]},

    {"id": "hat_gull", "stage": H, "kind": "instant", "art": "gulls",
     "where": ["sea", "haven", "shop", "islet"], "weight": 2,
     "title": "A Gull Steals Your Hat",
     "text": "A gull swoops, snatches your hat, and flies off with it. It is "
             "your good hat.",
     "roll": [[2, {"text": "It drops a different hat on deck. This one has a coin in it.",
                   "scrolls": 1}],
              [1, {"text": "It is wearing your hat now. It looks better in it. The crew "
                           "is demoralised.", "buff": ["becalmed", 1]}],
              [1, {"text": "It comes back for an apology. You feel oddly blessed.",
                   "buff": ["fortune", 1]}]]},

    {"id": "hippocampus_race", "stage": H, "kind": "table", "art": "regatta",
     "where": ["sea", "islet", "haven"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Hippocampus Derby",
     "text": "Poseidon's stable-nymphs are racing sea-horses round the Isles, and "
             "every captain is invited to back one, free. The form is chalked on a "
             "floating board.",
     "table": {"kind": "race", "prompt": "Back one sea-horse — secretly. Long shots pay more.",
               "params": {"field": [["Foam-Mane", "the god's own favourite", 5],
                                    ["Old Barnacle", "steady, salty, reliable", 3],
                                    ["Little Pickle", "small, keen, mostly lost", 1]],
                          "legs": ["Out of the stable", "Round the Pharos",
                                   "Into the home straight"]},
               "pays": [{"scrolls": 1},
                        {"scrolls": 2},
                        {"scrolls": 4, "buff": ["fair_wind", 1]}],
               "log": "the hippocampus derby"}},

    {"id": "argo_lost_property", "stage": H, "kind": "table", "art": "auction",
     "where": ["sea", "shop", "haven"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Argonauts' Lost Property",
     "text": "Jason's quartermaster is clearing out the Argo's lost-property "
             "chest: a Hint Stone, a Gale Charm, a crate of pitch and one sandal "
             "(Jason's, still damp). Sealed bids, everyone.",
     "table": {"kind": "bid", "prompt": "Your sealed bid, in scrolls (0 to sit it out).",
               "params": {"cap": 7, "worth": 5},
               "prize": {"items": ["hint", "gale", "planks"]},
               "log": "the Argo's lost property"}},

    # ── WORLD meetings ──────────────────────────────────────────────────────
    {"id": "meet_barge", "stage": H, "kind": "choice", "art": "barge",
     "where": ["sea"], "world": True,
     "title": "The Runaway Festival Barge",
     "text": "A barge hung with garlands drifts past with nobody steering, a band "
             "still playing, and a goat in charge of the wine. It bumps into you, "
             "cheerfully. The party is very much still going.",
     "options": [
         {"label": "Climb aboard and party", "stakes": "+1 Health · Fair Wind",
          "outcome": {"text": "You dance with the goat. The goat leads.",
                      "hull": 1, "buff": ["fair_wind", 1]}},
         {"label": "Steer it into harbour", "stakes": "carried toward a haven · +1",
          "outcome": {"text": "You tow it into port and the grateful owners pay salvage.",
                      "scrolls": 1, "move": {"toward": "haven", "steps": 3},
                      "remove_world": True}},
         {"label": "Call the whole fleet over", "stakes": "everyone votes",
          "when": {"players_min": 2},
          "outcome": {"text": "You blow a horn. Every captain hears it.",
                      "table": {"kind": "vote", "prompt": "The barge's band takes requests. "
                                "What do they play?",
                                "choices": [
                                    {"label": "Something rousing",
                                     "outcome": {"text": "Every crew rows like heroes.",
                                                 "buff": ["fair_wind", 1]}},
                                    {"label": "Something soothing",
                                     "outcome": {"text": "Every crew rests and mends.",
                                                 "hull": 1}},
                                    {"label": "The goat's song",
                                     "outcome": {"text": "Nobody knows what it means. "
                                                         "Everybody feels lucky.",
                                                 "buff": ["fortune", 1]}}],
                                "log": "the barge band"}}},
         {"label": "Fend it off with a boathook", "stakes": "safe",
          "outcome": {"text": "It drifts off, still playing."}},
     ]},

    {"id": "meet_goldfish", "stage": H, "kind": "choice", "art": "goldfish",
     "where": ["sea"], "world": True,
     "title": "The Golden Fish",
     "text": "A fish of solid, shining gold leaps across your bow and splashes "
             "down beside you. It looks up. 'Fine. You caught me. Quickly now, I "
             "have places to be.'",
     "options": [
         {"label": "Ask for treasure", "stakes": "+2 scrolls",
          "outcome": {"text": "It spits out two coins and is gone in a flash of gold.",
                      "scrolls": 2, "remove_world": True}},
         {"label": "Ask for a fair wind home", "stakes": "Fair Wind ×2 · Fortune",
          "outcome": {"text": "'Easy.' It flicks its tail and the sea turns behind you.",
                      "buffs": [["fair_wind", 2], ["fortune", 1]], "remove_world": True}},
         {"label": "Let it go without a wish", "stakes": "Fortune's Favour ×2",
          "outcome": {"text": "It stares at you. 'Nobody does that.' It leaves you its "
                              "blessing — and stays in the lane for the next captain.",
                      "buff": ["fortune", 2]}},
     ]},

    {"id": "meet_ghostship", "stage": H, "kind": "choice", "art": "ghostship",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "The Ghost Ship",
     "text": "A ship with grey sails and a green glow slides out of nowhere, "
             "crewed by sailors you can see straight through. Its captain bows. "
             "'We trade, captain. Your place for another's. Fair is fair.'",
     "options": [
         {"label": "Accept the trade", "stakes": "swap places with a rival",
          "outcome": {"text": "A cold wind, a lurch — and you are elsewhere, on another "
                              "captain's stretch of sea.", "swap": True}},
         {"label": "Trade a scroll instead", "stakes": "−1 scroll · Fortune",
          "requires": {"scrolls": 1},
          "outcome": {"text": "The ghost reads it, laughs a hollow laugh, and blesses you.",
                      "scrolls": -1, "buff": ["fortune", 1]}},
         {"label": "Refuse, politely", "stakes": "a gamble",
          "roll": [[2, {"text": "'Fair is fair,' he says, and fades."}],
                   [1, {"text": "He trades anyway. You get the bad end of it.", "swap": True}]]},
     ]},

    {"id": "meet_whales", "stage": H, "kind": "choice", "art": "whale",
     "where": ["sea"], "world": True,
     "title": "The Singing Whales",
     "text": "A pod of whales lies across the lane, singing. It is enormous and "
             "beautiful and nobody is getting past until the song is finished.",
     "options": [
         {"label": "Sing along", "stakes": "a gamble",
          "roll": [[2, {"text": "They like your harmony. One nudges you onward.",
                        "buff": ["fair_wind", 2]}],
                   [1, {"text": "They do not like your harmony. One sits on you, gently.",
                        "hull": -1}]]},
         {"label": "Ride the bow-wave of the biggest", "stakes": "carried along",
          "outcome": {"text": "She surges forward and you surf her wake, whooping.",
                      "move": {"toward": "random", "steps": 3}}},
         {"label": "Wait for the song to end", "stakes": "Becalmed · +1 Health",
          "outcome": {"text": "It is the longest, loveliest hour of your voyage.",
                      "buff": ["becalmed", 1], "hull": 1}},
     ]},

    {"id": "meet_hermes", "stage": H, "kind": "choice", "art": "hermes",
     "where": ["sea", "islet", "haven", "shop"], "world": True,
     "title": "Hermes, Slightly Lost",
     "text": "A young man in winged sandals lands on your deck, out of breath, "
             "with a parcel. 'Delivery! Sign here. You ARE the Golden Galley? "
             "No? It says Golden Galley. Ugh. They all look the same from up there.'",
     "options": [
         {"label": "Sign for it anyway", "stakes": "a gamble · it was not yours",
          "roll": [[2, {"text": "Inside: a War Horn and a note, 'For the big fight. "
                                "Love, Mum.'", "item": "horn"}],
                   [2, {"text": "Inside: someone's lunch. Delicious.", "hull": 2}],
                   [1, {"text": "Inside: a curse, addressed to somebody else. It does not "
                                "check the address either.", "buff": ["jinx", 1]}]]},
         {"label": "Help him find the right captain", "stakes": "+1 scroll · a rival gets it",
          "outcome": {"text": "You point him to a rival. He tips you and zooms off.",
                      "scrolls": 1, "rival": {"scrolls": 2}}},
         {"label": "Refuse delivery", "stakes": "safe",
          "outcome": {"text": "'Fine! FINE!' He takes off in a huff and a small tornado."}},
     ]},

    {"id": "meet_automaton", "stage": H, "kind": "game", "art": "automaton",
     "where": ["sea", "islet"], "world": True,
     "title": "The Pebble-Playing Automaton",
     "text": "On a raft sits a bronze automaton at a little table, gears whirring. "
             "A plaque reads: 'MADE BY DAEDALUS. UNDEFEATED AT PEBBLES. MOSTLY.' "
             "Its eyes click toward you.",
     "options": [
         {"label": "Challenge it", "stakes": "win: +3, Fortune · lose: −1 scroll",
          "requires": {"scrolls": 1},
          "outcome": {"text": "It sets out the pebbles with a ratcheting sound. Take one, "
                              "two or three; the last pebble wins.",
                      "game": {"kind": "nim", "params": {"err": 0.25},
                               "win": {"text": "Its gears grind to a halt. A drawer pops "
                                               "open with the prize money.", "scrolls": 3,
                                       "buff": ["fortune", 1], "remove_world": True},
                               "lose": {"text": "'UNDEFEATED,' it says, and takes your "
                                                "stake.", "scrolls": -1}}}},
         {"label": "Wind it up and watch", "stakes": "+1 scroll",
          "outcome": {"text": "It plays itself, loses, and pays itself. Some of it falls "
                              "on your side of the table.", "scrolls": 1}},
         {"label": "Leave the machine be", "stakes": "safe",
          "outcome": {"text": "Its eyes follow you all the way to the horizon."}},
     ]},

    {"id": "meet_turtleisle", "stage": H, "kind": "choice", "art": "turtle",
     "where": ["sea"], "world": True,
     "title": "An Island That Is Actually a Turtle",
     "text": "A small green island with three palms and a beach — on a chart "
             "that swears there is nothing here. You land. The island yawns.",
     "options": [
         {"label": "Make camp anyway", "stakes": "+2 Health · it wanders off with you",
          "outcome": {"text": "You sleep like a baby. When you wake, the island has swum "
                              "somewhere else, and so have you.", "hull": 2,
                      "move": {"toward": "random", "steps": 3}}},
         {"label": "Scrub its shell", "stakes": "+1 scroll · Fortune",
          "outcome": {"text": "It sighs with pleasure. Under the barnacles: a lost coin.",
                      "scrolls": 1, "buff": ["fortune", 1]}},
         {"label": "Apologise and leave", "stakes": "Fortune's Favour",
          "outcome": {"text": "The island blinks at you. Turtles remember kindness.",
                      "buff": ["fortune", 1]}},
     ]},

    {"id": "meet_icarus", "stage": H, "kind": "choice", "art": "icarus",
     "where": ["sea", "islet"], "world": True,
     "title": "Icarus Has Crash-Landed",
     "text": "Feathers everywhere. A young man is sitting on a wing-frame in the "
             "shallows, singed, soaked and sulking. 'Don't. Just don't. Dad "
             "already said it.'",
     "options": [
         {"label": "Salvage the wings", "stakes": "two Gale Charms",
          "outcome": {"text": "Good wax, good feathers, better wind. You bottle what you "
                              "can.", "items": ["gale", "gale"], "remove_world": True}},
         {"label": "Patch him up", "stakes": "+1 scroll · Fortune",
          "outcome": {"text": "He thanks you with the only coin he has, and promises to fly "
                              "lower. He will not.", "scrolls": 1, "buff": ["fortune", 1]}},
         {"label": "Say exactly what his dad said", "stakes": "safe",
          "outcome": {"text": "He throws a feather at you. It drifts, sadly, into the sea."}},
     ]},
]

WORLD = [
    {"id": "barge", "bot": "seek", "stage": H, "title": "The Runaway Festival Barge", "art": "barge",
     "text": "A party barge with nobody steering, drifting two stops a round. Bump "
             "into it to join in.", "model": "barge", "rounds": 6, "moves": 2,
     "where": "sea", "radius": 0, "weight": 3, "meet": "meet_barge",
     "log": "music drifts across the water", "gone": "drifts out of sight, still playing"},
    {"id": "goldfish", "bot": "seek", "stage": H, "title": "The Golden Fish", "art": "goldfish",
     "text": "Pays the first captain to reach it — and it never stays put.",
     "model": "goldfish", "rounds": 5, "moves": 1, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_goldfish", "log": "a flash of gold in the lanes",
     "gone": "dives deep"},
    {"id": "ghostship", "bot": "curious", "stage": H, "title": "The Ghost Ship", "art": "ghostship",
     "text": "Whoever meets it may trade places with a rival. Beware — or use it.",
     "model": "ghostship", "rounds": 5, "moves": 1, "where": "sea", "radius": 0,
     "weight": 2, "meet": "meet_ghostship", "log": "grey sails glow in the haze",
     "gone": "fades into nothing"},
    {"id": "whales", "bot": "curious", "stage": H, "title": "The Singing Whales", "art": "whale",
     "text": "A pod lying across the lane. Land on it or beside it to hear the song.",
     "model": "whales", "rounds": 5, "moves": 0, "where": "sea", "radius": 1,
     "weight": 3, "meet": "meet_whales", "log": "whale-song rolls across the Isles",
     "gone": "swim on, still singing"},
    {"id": "hermes", "bot": "curious", "stage": H, "title": "Hermes, Slightly Lost", "art": "hermes",
     "text": "The messenger god with a parcel for the wrong captain. He flits about.",
     "model": "hermes", "rounds": 4, "moves": 2, "where": "sea", "radius": 0,
     "weight": 2, "meet": "meet_hermes", "log": "winged sandals buzz the masts",
     "gone": "finally finds the right address"},
    {"id": "automaton", "bot": "seek", "stage": H, "title": "Daedalus' Automaton", "art": "automaton",
     "text": "A bronze pebble-player on a raft. Sail into its stop to challenge it.",
     "model": "automaton", "rounds": 7, "moves": 0, "where": "sea", "radius": 0,
     "weight": 2, "meet": "meet_automaton", "log": "gears whirr on a drifting raft",
     "gone": "winds down and sinks"},
    {"id": "turtleisle", "bot": "seek", "stage": H, "title": "The Wandering Isle", "art": "turtle",
     "text": "An island that is really a turtle. It swims to a new stop every round.",
     "model": "turtleisle", "rounds": 6, "moves": 3, "where": "sea", "radius": 0,
     "weight": 2, "meet": "meet_turtleisle", "log": "an island appears that no chart shows",
     "gone": "dives, palms and all"},
    {"id": "icarus", "bot": "seek", "stage": H, "title": "Icarus' Crash Site", "art": "icarus",
     "text": "Feathers, wax and a sulking boy. Salvage for whoever gets there first.",
     "model": "icarus", "rounds": 5, "moves": 0, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_icarus", "log": "something falls out of the sky",
     "gone": "is fished out by his father"},
]

"""
Event CONTENT for the Verdigris Deep (stage "jungle") — pure data in the
schema of event_data.py / docs/EVENTS.md. Merged into event_data.EVENTS and
event_data.WORLD.

The Deep is a warm green river-sea under a roof of leaves: lily rafts, drowned
temples, drums across the water, and animals with schemes. "sea" here is open
water (and a quiet hunting ground, which events treat like open water). The
last option of every card is the cautious one and needs nothing.
"""

EVENTS = [
    # ── CHOICE cards ────────────────────────────────────────────────────────
    {"id": "monkey_hat", "stage": "jungle", "kind": "choice", "art": "monkey",
     "where": ["sea", "haven"], "weight": 3,
     "title": "Monkeys in the Rigging",
     "text": "A troop of monkeys drops out of the canopy into your rigging. One "
             "of them has your hat. Another has your charts. A third has the "
             "ship's cat, which is taking it surprisingly well.",
     "options": [
         {"label": "Trade a scroll for it all back", "stakes": "−1 scroll · Fortune's Favour",
          "requires": {"scrolls": 1},
          "outcome": {"text": "The leader inspects the scroll, nods, and the troop "
                              "returns everything — plus a banana, as a receipt.",
                      "scrolls": -1, "buff": ["fortune", 2]}},
         {"label": "Chase them up the mast", "stakes": "a gamble",
          "roll": [[2, {"text": "You corner them on the yard. In the scramble they drop "
                                "a purse they stole from someone else.", "scrolls": 2}],
                   [2, {"text": "You chase them up the mast. They go down the other side. "
                                "You do not.", "hull": -1}]]},
         {"label": "Let them keep the hat", "stakes": "safe",
          "outcome": {"text": "It suits the monkey better, honestly."}},
     ]},

    {"id": "parrot", "stage": "jungle", "kind": "choice", "art": "parrot",
     "where": ["sea", "haven", "shrine"], "weight": 3,
     "title": "A Parrot Who Repeats Everything",
     "text": "A scarlet parrot lands on your shoulder and repeats, loudly, the "
             "last thing you said. Then the thing before that. Then your secret "
             "landing plans. There are rival ships within earshot.",
     "options": [
         {"label": "Teach it a lie", "stakes": "Fortune's Favour ×2",
          "outcome": {"text": "'THE TREASURE IS UPRIVER,' it bellows, flying off toward "
                              "your rivals. It is not upriver. You feel lucky.",
                      "buff": ["fortune", 2]}},
         {"label": "Bribe it with fruit", "stakes": "−1 scroll · Fair Wind",
          "requires": {"scrolls": 1},
          "outcome": {"text": "It swaps your secrets for a mango and a promise. It even "
                              "points the way.", "scrolls": -1, "buff": ["fair_wind", 2]}},
         {"label": "Say nothing at all", "stakes": "a gamble",
          "roll": [[2, {"text": "It gets bored and leaves. Silence is golden."}],
                   [1, {"text": "It repeats your silence, very loudly, to everyone. "
                                "Somehow this is worse.", "buff": ["jinx", 1]}]]},
     ]},

    {"id": "golden_idol", "stage": "jungle", "kind": "choice", "art": "idol",
     "where": ["sea", "shrine"], "weight": 2, "once": "player",
     "title": "A Golden Idol, Slightly Cursed",
     "text": "On a mossy pedestal in a half-drowned shrine sits a golden idol "
             "with a smug expression. The pedestal is a little too clean. The "
             "ceiling has a suspiciously round boulder-shaped hole in it.",
     "options": [
         {"label": "Swap it for a bag of sand", "stakes": "a gamble · +4 or a boulder",
          "roll": [[1, {"text": "Perfect weight. Not a sound. You stroll out, idol under "
                                "your arm, whistling.", "scrolls": 4}],
                   [1, {"text": "Click. A rumble. You run, the boulder rolls, and you get "
                                "to the boat with the idol and most of your stern.",
                        "scrolls": 4, "hull": -2}]]},
         {"label": "Just take it", "stakes": "+3 scrolls · Jinxed ×2",
          "outcome": {"text": "Nothing happens. Nothing at all. That is the worrying part.",
                      "scrolls": 3, "buff": ["jinx", 2]}},
         {"label": "Admire it and leave", "stakes": "safe",
          "outcome": {"text": "The idol looks faintly disappointed."}},
     ]},

    {"id": "mosquitoes", "stage": "jungle", "kind": "choice", "art": "mosquito",
     "where": ["sea"], "weight": 2, "hostile": True,
     "title": "The Mosquito Cloud",
     "text": "A grey cloud rises off the water with a sound like a thousand tiny "
             "violins. It is not a cloud. It has noticed you. It is very, very "
             "interested in you.",
     "options": [
         {"label": "Buy netting from a passing canoe", "stakes": "−1 scroll · safe",
          "requires": {"scrolls": 1},
          "outcome": {"text": "The canoe-trader saw you coming. Literally. But the net "
                              "holds.", "scrolls": -1}},
         {"label": "Smoke them out", "stakes": "a gamble",
          "roll": [[2, {"text": "Green wood on the brazier. The cloud coughs and leaves, "
                                "offended."}],
                   [1, {"text": "The smoke drives the mosquitoes off and your crew "
                                "with them, briefly, overboard.", "buff": ["becalmed", 1]}]]},
         {"label": "Row hard through it", "stakes": "−1 Health",
          "outcome": {"text": "You make it through, itching in places you did not know "
                              "you had.", "hull": -1}},
     ]},

    {"id": "explorer", "stage": "jungle", "kind": "choice", "art": "explorer",
     "where": ["sea", "haven"], "weight": 2, "once": "player",
     "title": "A Lost Explorer",
     "text": "A man in a sun hat and three compasses waves from a raft. He has "
             "been 'very nearly found' for eleven years. He has a map. It is "
             "covered in notes like 'probably here' and 'definitely not here?'",
     "options": [
         {"label": "Buy his best map", "stakes": "−2 scrolls · a hidden islet",
          "requires": {"scrolls": 2},
          "outcome": {"text": "He sells you the one marked 'quite sure'. It is, for once, "
                              "right.", "scrolls": -2, "reveal": "sword"}},
         {"label": "Give him a lift to the haven", "stakes": "towed toward the haven · +1",
          "outcome": {"text": "He navigates. You end up at the haven by a route that "
                              "should not exist, and he tips you.",
                      "scrolls": 1, "move": {"toward": "haven", "steps": 3}}},
         {"label": "Give him directions", "stakes": "Fortune's Favour",
          "outcome": {"text": "He thanks you warmly and sets off in the exact opposite "
                              "direction. You feel good anyway.",
                      "buff": ["fortune", 1]}},
     ]},

    {"id": "frog_apothecary", "stage": "jungle", "kind": "choice", "art": "frog",
     "where": ["sea", "haven", "shrine"], "weight": 3,
     "title": "The Tree-Frog Apothecary",
     "text": "On a lily pad the size of a dinner table, a tree frog in tiny "
             "spectacles runs a pharmacy. The labels read: 'FOR HULLS', 'FOR "
             "LUCK', and, in red, 'DO NOT LICK THE PHARMACIST'.",
     "options": [
         {"label": "Buy the hull tonic", "stakes": "−2 scrolls · +3 Health",
          "requires": {"scrolls": 2, "hurt": True},
          "outcome": {"text": "You pour it on the leaky planks. They swell, sigh, and "
                              "seal.", "scrolls": -2, "hull": 3}},
         {"label": "Lick the pharmacist", "stakes": "a gamble",
          "roll": [[1, {"text": "The colours! The sounds! You feel extraordinarily lucky "
                                "for reasons you cannot explain.", "buff": ["fortune", 2]}],
                   [1, {"text": "You spend a while explaining your feelings to a palm "
                                "tree.", "buff": ["becalmed", 2]}]]},
         {"label": "Read the labels and leave", "stakes": "+1 Health",
          "outcome": {"text": "The frog gives you a free sample, out of pity.", "hull": 1}},
     ]},

    # ── GAMES ───────────────────────────────────────────────────────────────
    {"id": "temple_plates", "stage": "jungle", "kind": "game", "art": "temple",
     "where": ["sea", "shrine"], "weight": 3, "heavy": True,
     "title": "The Temple of the Four Plates",
     "text": "Behind a curtain of roots, a drowned temple door: four stone plates "
             "in the floor — sun, moon, jaguar, serpent — and carvings on the wall "
             "saying in which order they must sink. The dart-holes in the walls "
             "suggest the order matters.",
     "options": [
         {"label": "Read the carvings and press", "stakes": "a logic puzzle · win: +3, Aegis",
          "outcome": {"text": "Each carving is one clue. Together they allow exactly one "
                              "order. A wrong plate pops them all back up — and a dart "
                              "flies.",
                      "game": {"kind": "plates", "params": {"darts": 2},
                               "win": {"text": "The door grinds open on a cache of "
                                               "temple gold and a warding amulet.",
                                       "scrolls": 3, "item": "aegis_charm"},
                               "lose": {"text": "Third dart. You retreat to the boat, "
                                                "looking like a pincushion.", "hull": -1}}}},
         {"label": "Prise a gem from the door", "stakes": "a gamble",
          "roll": [[1, {"text": "It pops out into your palm.", "scrolls": 2}],
                   [1, {"text": "A dart pops out into your shoulder.", "hull": -1}]]},
         {"label": "Leave the temple sleeping", "stakes": "safe",
          "outcome": {"text": "The stone faces watch you go, and seem to approve."}},
     ]},

    {"id": "drum_message", "stage": "jungle", "kind": "game", "art": "drum",
     "where": ["sea", "haven", "shrine"], "weight": 3, "heavy": True,
     "title": "Drums Across the Water",
     "text": "From the far bank, drums: BOOM, tak-tak, BOOM. A drummer on a stilt "
             "house waves you over. 'The river talks in patterns. Tell me what "
             "comes next and the river will be kind to you.'",
     "options": [
         {"label": "Answer the drums", "stakes": "3 patterns · 2 right: +2 · 3: +3, Fair Wind",
          "outcome": {"text": "He beats out a row of patterns, slowly, as many times as "
                              "you like.",
                      "game": {"kind": "drums", "params": {"rounds": 3, "need": 2},
                               "score": [[2, {"text": "'The river says yes.' He pays in "
                                                      "carved beads that spend like coin.",
                                              "scrolls": 2}],
                                         [3, {"text": "'The river says YES.' The whole "
                                                      "village drums you downstream.",
                                              "scrolls": 3, "buff": ["fair_wind", 2]}]],
                               "lose": {"text": "'The river says… maybe next time.'"}}}},
         {"label": "Drum something back", "stakes": "a gamble",
          "roll": [[1, {"text": "You play something rousing. They answer with a cheer and "
                                "a basket of fruit.", "hull": 1, "scrolls": 1}],
                   [1, {"text": "You play something that means, in drum, 'my mother is a "
                                "canoe'. They are very offended.", "buff": ["jinx", 1]}]]},
         {"label": "Wave and paddle on", "stakes": "safe",
          "outcome": {"text": "BOOM, tak. That probably means goodbye."}},
     ]},

    {"id": "piranha_crossing", "stage": "jungle", "kind": "game", "art": "piranha",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "The Piranha Crossing",
     "text": "A ferryman on a hollowed log has a jaguar cub, a monkey and a hand "
             "of bananas to get across a piranha-thick channel. 'The log takes "
             "me and one more. The cub eats the monkey. The monkey eats the "
             "bananas. The piranhas eat anybody who falls in.'",
     "options": [
         {"label": "Solve it for him", "stakes": "a crossing puzzle · win: +3 scrolls",
          "outcome": {"text": "You take the paddle. The piranhas take an interest.",
                      "game": {"kind": "crossing",
                               "params": {"max_trips": 11,
                                          "names": {"wolf": "jaguar cub", "goat": "monkey",
                                                    "charts": "bananas"}},
                               "win": {"text": "All across, nobody eaten. He pays you in "
                                               "river-gold.", "scrolls": 3},
                               "lose": {"text": "There is a short, terrible noise from the "
                                                "far bank."}}}},
         {"label": "Throw the piranhas a fish", "stakes": "a gamble",
          "roll": [[1, {"text": "They swarm the fish. You slip across, and spot a purse "
                                "in the shallows.", "scrolls": 1}],
                   [1, {"text": "They swarm the fish, then your oar.", "hull": -1}]]},
         {"label": "Wish him luck", "stakes": "safe",
          "outcome": {"text": "'Luck,' he says, looking at the piranhas. 'Ha.'"}},
     ]},

    {"id": "vine_riddle", "stage": "jungle", "kind": "game", "art": "vines",
     "where": ["sea", "haven", "shrine"], "weight": 3, "heavy": True,
     "title": "Vines That Want a Riddle",
     "text": "Thick green vines curl down from the canopy and wrap, gently but "
             "firmly, around your masts. A rustling voice: 'We are bored. Answer "
             "us a riddle and we let go.'",
     "options": [
         {"label": "Answer the vines", "stakes": "a riddle · win: +2 · lose: Becalmed ×2",
          "outcome": {"text": "The leaves lean in to listen.",
                      "puzzle": {"kind": "riddle",
                                 "win": {"text": "The vines unwind, delighted, and drop "
                                                 "a seed-pod full of coins on deck.",
                                         "scrolls": 2},
                                 "lose": {"text": "The vines hold on a while, out of "
                                                  "disappointment.",
                                          "buff": ["becalmed", 2]}}}},
         {"label": "Hack your way free", "stakes": "a gamble",
          "roll": [[1, {"text": "Snick, snick. You are free, and the vines sulk."}],
                   [1, {"text": "The vines snap back and give the mast a sharp smack.",
                        "hull": -1}]]},
         {"label": "Tell them a story instead", "stakes": "Becalmed for a roll",
          "outcome": {"text": "They like the story. They want another. Eventually they "
                              "fall asleep.", "buff": ["becalmed", 1]}},
     ]},

    {"id": "firefly_words", "stage": "jungle", "kind": "game", "art": "firefly",
     "where": ["sea", "haven"], "weight": 2, "heavy": True,
     "title": "Fireflies Spelling Something",
     "text": "At dusk the fireflies come out over the water and arrange "
             "themselves into letters — but jumbled, and blinking impatiently, as "
             "if waiting for you to put them right.",
     "options": [
         {"label": "Unscramble the word", "stakes": "a word puzzle · win: +2, Fortune",
          "outcome": {"text": "The letters hover, rearranging themselves whenever you "
                              "squint.",
                      "puzzle": {"kind": "anagram",
                                 "win": {"text": "The fireflies spell YES in huge green "
                                                 "letters, then follow you for a mile.",
                                         "scrolls": 2, "buff": ["fortune", 1]},
                                 "lose": {"text": "The fireflies spell NO and go home."}}}},
         {"label": "Catch a jar of them", "stakes": "+1 scroll",
          "outcome": {"text": "A firefly lantern sells well. You let them go later, "
                              "because you are not a monster.", "scrolls": 1}},
         {"label": "Just watch", "stakes": "safe",
          "outcome": {"text": "They spell something rude and fly off giggling."}},
     ]},

    {"id": "glowworm_grotto", "stage": "jungle", "kind": "game", "art": "firefly",
     "where": ["sea", "shrine"], "weight": 2, "heavy": True,
     "title": "The Glow-Worm Grotto",
     "text": "A cave mouth opens on the river. Inside, on twelve stone shelves, "
             "twelve carved shells — and in each shell a glowing worm curled into "
             "a shape. Each shape has a twin. An old woman knits by the door.",
     "options": [
         {"label": "Match the shells", "stakes": "3 pairs: +1 · 5: +3 · all 6: +4, Fortune",
          "outcome": {"text": "'Two at a time, love. I'll not hurry you. I've got this "
                              "whole jumper to finish.'",
                      "game": {"kind": "pairs", "params": {"pairs": 6, "tries": 12,
                                                           "goal": 3, "set": "jungle"},
                               "score": [[3, {"text": "'Not bad.' A coin from her apron.",
                                              "scrolls": 1}],
                                         [5, {"text": "'Very good!' Three coins.",
                                              "scrolls": 3}],
                                         [6, {"text": "'Every one!' She gives you a "
                                                      "glowing shell for luck.",
                                              "scrolls": 4, "buff": ["fortune", 2]}]],
                               "lose": {"text": "'Never mind. They're only worms.'"}}}},
         {"label": "Sit with her a while", "stakes": "+1 Health",
          "outcome": {"text": "She tells you about the river in the old days. You leave "
                              "with a scarf.", "hull": 1}},
         {"label": "Paddle past the cave", "stakes": "safe",
          "outcome": {"text": "The worms glow a little dimmer, disappointed."}},
     ]},

    {"id": "coconuts", "stage": "jungle", "kind": "game", "art": "coconut",
     "where": ["sea", "haven"], "weight": 3, "heavy": True,
     "title": "Cracking Coconuts",
     "text": "A palm leans over the water, heavy with coconuts. Some are full of "
             "sweet milk. Some, a passing monkey explains, are full of crab. You "
             "will know which when you crack one.",
     "options": [
         {"label": "Crack coconuts", "stakes": "crack on for more · a crab spoils the lot",
          "outcome": {"text": "Crack after crack, the milk adds up — until a crab "
                              "comes out swinging.",
                      "game": {"kind": "knucklebones", "params": {"goals": [6, 12, 18]},
                               "score": [[6, {"text": "Enough milk to mend a crew.",
                                              "hull": 2}],
                                         [12, {"text": "A barrel of milk, sold for good "
                                                       "coin.", "hull": 1, "scrolls": 3}],
                                         [18, {"text": "The monkey is so impressed he gives "
                                                       "you his savings.", "hull": 2,
                                               "scrolls": 4}]],
                               "lose": {"text": "A crab! It takes the milk, your dignity, "
                                                "and the end of your thumb.", "hull": -1}}}},
         {"label": "Leave them to the monkeys", "stakes": "safe",
          "outcome": {"text": "The monkey nods. Sensible."}},
     ]},

    {"id": "stone_calendar", "stage": "jungle", "kind": "game", "art": "calendar",
     "where": ["sea", "shrine"], "weight": 2, "heavy": True,
     "title": "The Stone Calendar",
     "text": "A great stone wheel stands in the shallows, carved with numbered "
             "glyphs. A priest-statue's mouth grinds open: 'THE NEXT DAY, HIGHER "
             "OR LOWER? THE PAST DAYS LIE BEFORE YOU.'",
     "options": [
         {"label": "Turn the wheel", "stakes": "2 right: +1 · 3: +2 · 5: +4",
          "outcome": {"text": "The wheel clunks round to its first glyph.",
                      "game": {"kind": "higher_lower", "params": {"need": 5},
                               "score": [[2, {"text": "A coin drops from the statue's "
                                                      "ear.", "scrolls": 1}],
                                         [3, {"text": "Two coins. The statue may be "
                                                      "smiling.", "scrolls": 2}],
                                         [5, {"text": "The statue laughs, grinding, and "
                                                      "spills its treasure.", "scrolls": 4,
                                              "buff": ["fortune", 1]}]],
                               "lose": {"text": "The wheel locks. The statue's mouth "
                                                "closes with a disapproving clunk."}}}},
         {"label": "Leave the days to themselves", "stakes": "safe",
          "outcome": {"text": "Time passes, as it does."}},
     ]},

    {"id": "mosaic_door", "stage": "jungle", "kind": "game", "art": "temple",
     "where": ["sea", "shrine"], "weight": 2, "heavy": True,
     "title": "The Sliding Mosaic",
     "text": "A temple door is covered in a mosaic of square tiles, one missing, "
             "the picture scrambled. Something behind the door is ticking — "
             "slowly, patiently, like it has been waiting a thousand years.",
     "options": [
         {"label": "Slide the tiles home", "stakes": "a sliding puzzle · win: +3 scrolls",
          "outcome": {"text": "Tile by tile, the picture of a jaguar swims into place.",
                      "puzzle": {"kind": "sliding",
                                 "win": {"text": "The door rolls aside on a little room "
                                                 "of offerings.", "scrolls": 3},
                                 "lose": {"text": "The ticking stops. That is somehow "
                                                  "worse. You leave quickly."}}}},
         {"label": "Leave it ticking", "stakes": "safe",
          "outcome": {"text": "Some doors are best left shut."}},
     ]},

    # ── INSTANTS ────────────────────────────────────────────────────────────
    {"id": "jungle_rain", "stage": "jungle", "kind": "instant", "art": "rain",
     "where": ["sea", "haven"], "weight": 3,
     "title": "Rain, Sudden and Total",
     "text": "The sky opens. Not rain, exactly — more as if the river has decided "
             "to visit from above.",
     "roll": [[2, {"text": "Fresh water fills every barrel. The crew is clean for the "
                           "first time in weeks.", "hull": 2}],
              [1, {"text": "Visibility nil. You drift in a warm grey roar.",
                   "buff": ["becalmed", 1]}],
              [2, {"text": "It washes something glittering out of the bank and onto "
                           "your deck.", "scrolls": 2}]]},

    {"id": "falling_fruit", "stage": "jungle", "kind": "instant", "art": "coconut",
     "where": ["sea", "haven"], "weight": 2,
     "title": "Something Falls on Your Head",
     "text": "You are looking up at the canopy, admiring it, when the canopy "
             "drops something on you.",
     "roll": [[2, {"text": "A mango, perfectly ripe. Your crew shares it.", "hull": 1}],
              [1, {"text": "A coconut. You see stars, and one of them looks lucky.",
                   "hull": -1, "buff": ["fortune", 1]}],
              [2, {"text": "A sloth. It apologises, slowly, and pays for the damage.",
                   "scrolls": 2}]]},

    {"id": "river_dolphins", "stage": "jungle", "kind": "instant", "art": "dolphins",
     "where": ["sea"], "weight": 2,
     "title": "Pink River Dolphins",
     "text": "Pink dolphins — actually pink, like sunset — surface around your "
             "hull and squeak at you in a tone that suggests they know something.",
     "roll": [[2, {"text": "They lead you through a channel you had not seen.",
                   "buff": ["fair_wind", 2]}],
              [1, {"text": "They nose a sunken chest up to the surface.",
                   "scrolls": 2, "item": "planks"}],
              [1, {"text": "They are, it turns out, just very pleased to see you. So "
                           "are you.", "buff": ["fortune", 1]}]]},

    {"id": "lily_bloom", "stage": "jungle", "kind": "instant", "art": "lily",
     "where": ["sea", "shrine"], "weight": 2,
     "title": "The Giant Lilies Bloom",
     "text": "All at once, every giant lily on the river opens — white, then pink, "
             "then a gold that makes the whole crew stop and stare.",
     "roll": [[2, {"text": "The scent is so sweet your wounds forget to ache.",
                   "hull": 2}],
              [1, {"text": "A beetle as big as your fist climbs out of one and pays "
                           "rent.", "scrolls": 1, "buff": ["fortune", 1]}]]},

    # ── TABLE events ────────────────────────────────────────────────────────
    {"id": "howler_choir", "stage": "jungle", "kind": "table", "art": "monkey",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Howler Monkey Choir",
     "text": "The howler monkeys of the whole Deep fill the canopy and announce, "
             "at tremendous volume, that tonight they will perform one song for "
             "every captain on the river. The captains must choose which.",
     "table": {"kind": "vote", "prompt": "What should the howlers sing?",
               "choices": [
                   {"label": "A lullaby",
                    "outcome": {"text": "Everyone sleeps like a stone. Very loud stones.",
                                "hull": 1}},
                   {"label": "A rowing song",
                    "outcome": {"text": "Every oar on the river finds the beat.",
                                "buff": ["fair_wind", 1]}},
                   {"label": "Their greatest hit (it is just screaming)",
                    "outcome": {"text": "The whole river shakes loose fruit and coin "
                                        "from the canopy — and nobody sleeps.",
                                "scrolls": 2, "buff": ["becalmed", 1]}}],
               "log": "the howler choir"}},

    {"id": "frog_count", "stage": "jungle", "kind": "table", "art": "frog",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "How Many Frogs on the Log?",
     "text": "A log drifts down the river carrying an absurd number of frogs. A "
             "heron perched on the end announces a competition: 'Closest guess "
             "wins three scrolls. Between twenty-five and ninety. Hurry, they're "
             "jumping off.' (They are not. Take your time.)",
     "table": {"kind": "guess", "prompt": "How many frogs on the log?",
               "params": {"range": [25, 90]},
               "prize": {"scrolls": 3}, "log": "the frog count"}},

    {"id": "lily_race", "stage": "jungle", "kind": "table", "art": "lily",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Lily-Raft Race",
     "text": "The river people are holding their lily-raft race, and every "
             "captain is given a raft and a paddle. Three channels: one fast, one "
             "slow, and one with a caiman in it.",
     "table": {"kind": "lanes", "prompt": "Pick a channel — secretly.",
               "lanes": {"fast": {"scrolls": 2, "buff": ["fair_wind", 1]},
                         "slow": {"scrolls": 1},
                         "caiman": {"hull": -1}},
               "log": "the lily-raft race"}},

    {"id": "toe_lottery", "stage": "jungle", "kind": "table", "art": "piranha",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Piranha Lottery",
     "text": "A riverside gambler explains the rules: every captain dangles some "
             "toes in the water, one to five. The piranhas, being fussy, only "
             "bother the crowded numbers. The lowest number nobody else picked "
             "wins the pot.",
     "table": {"kind": "lowest", "prompt": "How many toes do you dangle? (lowest unique wins)",
               "params": {"max": 5},
               "prize": {"scrolls": 3, "hull": 1}, "log": "the piranha lottery"}},

    {"id": "raider_auction", "stage": "jungle", "kind": "table", "art": "idol",
     "where": ["sea", "haven", "shrine"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Ruin-Raiders' Auction",
     "text": "A canoe of rather shifty ruin-raiders is auctioning a jade idol "
             "that 'definitely isn't cursed' and a seeing-stone, as one lot. "
             "'Sealed bids. No questions. Especially about the curse.'",
     "table": {"kind": "bid", "prompt": "Your sealed bid, in scrolls (0 to sit it out).",
               "params": {"cap": 8, "worth": 5},
               "prize": {"scrolls": 3, "items": ["hint"]}, "log": "the raiders' auction"}},

    # ── WORLD meetings ──────────────────────────────────────────────────────
    {"id": "meet_monkey_raft", "stage": "jungle", "kind": "game", "art": "monkey",
     "where": ["sea"], "world": True,
     "title": "The Monkey Traders",
     "text": "A bamboo raft piled with stolen goods drifts alongside, crewed by "
             "monkeys in a remarkable variety of other people's hats. Their "
             "captain holds up a sign: WE BUY. WE SELL. WE DO NOT GIVE BACK.",
     "options": [
         {"label": "Buy a mystery bundle", "stakes": "−2 scrolls · who knows?",
          "requires": {"scrolls": 2},
          "roll": [[3, {"text": "Pitch and planks, and a sock.", "scrolls": -2,
                        "items": ["planks"], "hull": 1}],
                   [2, {"text": "A Gale Charm and a War Horn, both slightly chewed.",
                        "scrolls": -2, "items": ["gale", "horn"]}],
                   [1, {"text": "A ship's fitting, still in its wrapper. Somebody is "
                                "going to miss this.", "scrolls": -2, "upgrade": True}],
                   [2, {"text": "Bananas. Two hundred bananas.", "scrolls": -2,
                        "hull": 2}]]},
         {"label": "Play their shell game", "stakes": "free · win: +3 scrolls",
          "outcome": {"text": "The captain sets out three coconut shells and a pearl, "
                              "and three signs it can't read but insists are true.",
                      "game": {"kind": "shells",
                               "win": {"text": "The pearl! The monkeys pay up, "
                                               "screeching with admiration.", "scrolls": 3},
                               "lose": {"text": "Empty. The monkeys screech with "
                                                "laughter, which is worse."}}}},
         {"label": "Let them search your hold", "stakes": "a gamble · a swap",
          "roll": [[1, {"text": "They take a scroll and leave a charm. A fair trade, "
                                "by monkey law.", "scrolls": -1, "item": "aegis_charm"}],
                   [1, {"text": "They take a scroll and leave a banana.", "scrolls": -1,
                        "hull": 1}]]},
         {"label": "Shoo them off", "stakes": "safe",
          "outcome": {"text": "They leave, taking your bucket on principle."}},
     ]},

    {"id": "meet_orchid", "stage": "jungle", "kind": "game", "art": "orchid",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "The Hungry Orchid",
     "text": "A flower the size of a sail rises from a raft of roots, glowing "
             "pink and smelling of honey and sweet, sweet ships. Its petals turn "
             "toward you. It has, you notice, teeth.",
     "options": [
         {"label": "Hack through its roots", "stakes": "a battle · it wilts for good",
          "outcome": {"text": "You draw steel. It draws vines.",
                      "fight": {"name": "The Hungry Orchid", "unit": "Strangler Bloom",
                                "hp": 4, "power": 1, "model": "serpent_bloom", "count": 1},
                      "remove_world": True}},
         {"label": "Sing it to sleep", "stakes": "a pattern puzzle · win: +3 scrolls",
          "outcome": {"text": "Flowers like music. This one likes it in a pattern.",
                      "puzzle": {"kind": "sequence",
                                 "win": {"text": "It droops, dozes, and drops the "
                                                 "shiny things it was keeping.",
                                         "scrolls": 3, "remove_world": True},
                                 "lose": {"text": "It does not like your tune. It "
                                                  "nibbles your bow.", "hull": -1}}}},
         {"label": "Feed it your spare rations", "stakes": "−1 scroll · safe",
          "requires": {"scrolls": 1},
          "outcome": {"text": "It eats the rations, then the sack, then politely "
                              "ignores you.", "scrolls": -1}},
         {"label": "Back-paddle hard", "stakes": "a gamble",
          "roll": [[2, {"text": "You pull clear. It snaps at the empty water."}],
                   [1, {"text": "It gets a petal round your stern before you pull away.",
                        "hull": -1}]]},
     ]},

    {"id": "meet_sloth", "stage": "jungle", "kind": "choice", "art": "sloth",
     "where": ["sea"], "world": True,
     "title": "The Sloth Oracle",
     "text": "From a dead tree standing in the river hangs a sloth of immense age "
             "and wisdom. Pilgrims say it knows everything. Pilgrims also say to "
             "bring a packed lunch, because it answers very, very slowly.",
     "options": [
         {"label": "Ask it the big question", "stakes": "lose a turn · +3 scrolls, a hidden islet",
          "outcome": {"text": "You ask. You wait. Night falls. Day breaks. It opens its "
                              "mouth. Night falls. At last: a bearing, and a tip.",
                      "skip": True, "scrolls": 3, "reveal": "sword"}},
         {"label": "Ask a very small question", "stakes": "Fortune's Favour ×2",
          "outcome": {"text": "'Will… I… be… lucky?' It thinks about it for an hour, then "
                              "nods. Once. That counts.", "buff": ["fortune", 2]}},
         {"label": "Leave it hanging", "stakes": "safe",
          "outcome": {"text": "It was going to say goodbye. You are gone long before it "
                              "finishes."}},
     ]},

    {"id": "meet_jaguar", "stage": "jungle", "kind": "game", "art": "jaguar",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "The Jaguar Who Plays Fair",
     "text": "A jaguar lounges on a sunken pillar in the river, tail twitching. "
             "'I could eat you,' she purrs. 'But I am bored, and I play fair. "
             "Stone, scroll, shears. My tail tells the truth — learn it.'",
     "options": [
         {"label": "Play her", "stakes": "win: +3, Aegis Charm · lose: −1 Health",
          "outcome": {"text": "She sits up, very straight, and her tail goes still.",
                      "game": {"kind": "rps", "params": {"need": 3},
                               "win": {"text": "'Fair is fair.' She leaves you a jade "
                                               "charm and slips off into the green.",
                                       "scrolls": 3, "item": "aegis_charm",
                                       "remove_world": True},
                               "lose": {"text": "'Fair is fair,' she says, and takes a "
                                                "swipe at your stern. Gently. Mostly.",
                                        "hull": -1}}}},
         {"label": "Fight her", "stakes": "a battle · she leaves for good",
          "outcome": {"text": "She sighs. 'So unsporting.'",
                      "fight": {"name": "The Jaguar", "unit": "Jaguar Queen",
                                "hp": 4, "power": 1, "model": "jaguar", "count": 1},
                      "remove_world": True}},
         {"label": "Bow and back away", "stakes": "a gamble",
          "roll": [[3, {"text": "She dips her head. Manners are fair too."}],
                   [1, {"text": "She takes your bow as an invitation to pounce, once, "
                                "for fun.", "hull": -1}]]},
     ]},
]

# ── WORLD entities in the Deep ──────────────────────────────────────────────
WORLD = [
    {"id": "monkey_raft", "stage": "jungle", "title": "The Monkey Traders", "art": "monkey",
     "text": "A raft of monkeys with stolen goods. Sail into their stop to trade.",
     "model": "monkey_raft", "rounds": 7, "moves": 1, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_monkey_raft", "bot": "shop",
     "log": "a raft of monkeys drifts into the channels", "gone": "paddles off downriver"},
    {"id": "orchid", "stage": "jungle", "title": "The Hungry Orchid", "art": "orchid",
     "text": "A giant carnivorous flower. Landing on or beside it means trouble — "
             "or a fight.", "model": "orchid", "rounds": 7, "moves": 0, "where": "sea",
     "radius": 1, "weight": 2, "meet": "meet_orchid", "bot": "fight",
     "log": "a giant flower opens on the river", "gone": "closes and sinks into the roots"},
    {"id": "sloth", "stage": "jungle", "title": "The Sloth Oracle", "art": "sloth",
     "text": "An ancient sloth who knows everything, eventually. Sail into its stop "
             "to ask.", "model": "sloth", "rounds": 8, "moves": 0, "where": "sea",
     "radius": 0, "weight": 3, "meet": "meet_sloth", "bot": "curious",
     "log": "a very old sloth is sighted in a dead tree", "gone": "finally finishes its sentence and leaves"},
    {"id": "jaguar", "stage": "jungle", "title": "The Jaguar Who Plays Fair", "art": "jaguar",
     "text": "A jaguar prowling the ruins. Avoid her stop — or play her for a prize.",
     "model": "jaguar", "rounds": 6, "moves": 1, "where": "sea", "radius": 0,
     "weight": 2, "meet": "meet_jaguar", "bot": "fight",
     "log": "a jaguar is seen on the drowned pillars", "gone": "melts into the green"},
]

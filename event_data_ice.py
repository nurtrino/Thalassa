"""
Event CONTENT for the Frostfang Reach (stage "ice") — pure data in the
schema of event_data.py / docs/EVENTS.md. Merged into event_data.EVENTS and
event_data.WORLD.

The Reach is a polar sea: bergs, floes, aurora, a sulking North Wind, and a
great many opinionated animals. "sea" here is open water (and a quiet
hunting ground, which events treat like open water). The last option of every
card is the cautious one and needs nothing.
"""

EVENTS = [
    # ── CHOICE cards ────────────────────────────────────────────────────────
    {"id": "boreas_sulk", "stage": "ice", "kind": "choice", "art": "boreas",
     "where": ["sea", "haven"], "weight": 3,
     "title": "Boreas Is Sulking",
     "text": "The North Wind himself sits on a berg with his arms folded and his "
             "cheeks puffed out. Nobody remembered his name-day. Not one card. "
             "The sea around him has gone dead calm out of sympathy.",
     "options": [
         {"label": "Recite him an ode", "stakes": "a gamble · Fair Wind or Becalmed",
          "roll": [[3, {"text": "'O Boreas, breath of the bright north…' He sniffs, dabs his "
                                "eye, and blows you a gale of gratitude.",
                        "buff": ["fair_wind", 2]}],
                   [2, {"text": "You rhyme 'Boreas' with 'bore us'. He takes it personally.",
                        "buff": ["becalmed", 2]}]]},
         {"label": "Give him a belated present", "stakes": "−1 scroll · Fair Wind ×2",
          "requires": {"scrolls": 1},
          "outcome": {"text": "You wrap a scroll in a ribbon of kelp. He unwraps it slowly, "
                              "pretends not to care, and then blows you halfway to "
                              "tomorrow.", "scrolls": -1, "buff": ["fair_wind", 2]}},
         {"label": "Wait for him to get over it", "stakes": "Becalmed for a roll",
          "outcome": {"text": "He does not get over it. You row.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "mammoth", "stage": "ice", "kind": "choice", "art": "mammoth",
     "where": ["sea"], "weight": 2, "once": "player",
     "title": "A Mammoth in the Ice",
     "text": "Inside a blue-white berg, perfectly preserved, stands a woolly "
             "mammoth. It has been there for ten thousand years. It looks, if "
             "anything, mildly annoyed about the wait.",
     "options": [
         {"label": "Chip him out", "stakes": "a gamble · a tow or a sneeze",
          "roll": [[3, {"text": "He steps out, shakes off the millennia, and gives your "
                                "ship a grateful shove with his trunk — a long one.",
                        "move": {"toward": "lair", "steps": 3}}],
                   [2, {"text": "The first breath he has taken since the Ice Age turns into "
                                "the first sneeze. It is a big sneeze.", "hull": -1,
                        "scrolls": 1}]]},
         {"label": "Chip off a bit of tusk", "stakes": "+2 scrolls · Jinxed",
          "outcome": {"text": "Ivory sells. He watches you do it, unblinking, through a "
                              "foot of ice. You will think about that look for a while.",
                      "scrolls": 2, "buff": ["jinx", 1]}},
         {"label": "Leave him to his nap", "stakes": "safe",
          "outcome": {"text": "Ten thousand years is a nap. Who are you to judge."}},
     ]},

    {"id": "polar_chef", "stage": "ice", "kind": "choice", "art": "polarbear",
     "where": ["sea", "haven"], "weight": 3,
     "title": "The Polar Bear's Kitchen",
     "text": "A polar bear in a tall white hat runs a floating kitchen off the "
             "back of a floe. A board reads: TODAY'S SPECIAL. Under it, in fresher "
             "chalk: YOU? He sharpens a knife and smiles very kindly.",
     "options": [
         {"label": "Order the fish chowder", "stakes": "−1 scroll · +2 Health",
          "requires": {"scrolls": 1, "hurt": True},
          "outcome": {"text": "It is, honestly, the best chowder in the Reach. Your crew "
                              "licks the bowls and the bowls are better for it.",
                      "scrolls": -1, "hull": 2}},
         {"label": "Compliment the chef", "stakes": "a gamble",
          "roll": [[3, {"text": "He blushes under the fur and sends you off with a "
                                "packed lunch and a good feeling about the day.",
                        "buff": ["fortune", 2]}],
                   [1, {"text": "You praise the seasoning. He had not seasoned it. He "
                                "swats your bowsprit on the way past.", "hull": -1}]]},
         {"label": "Sail on before he finishes the menu", "stakes": "safe",
          "outcome": {"text": "He waves the knife in a friendly way, and you wave back "
                              "from a growing distance."}},
     ]},

    {"id": "hyperboreans", "stage": "ice", "kind": "choice", "art": "tourists",
     "where": ["sea", "haven"], "weight": 2,
     "title": "Hyperborean Tourists",
     "text": "A boat full of sunburnt Hyperboreans — the happy people who live "
             "beyond the North Wind — hails you. They are in sandals. They are "
             "lost. They would like directions, a portrait, and a souvenir.",
     "options": [
         {"label": "Guide them to the haven", "stakes": "towed toward the haven · +2 scrolls",
          "outcome": {"text": "They row you there themselves, singing, and tip "
                              "generously in coins stamped with a smiling sun.",
                      "scrolls": 2, "move": {"toward": "haven", "steps": 4}}},
         {"label": "Sell them a genuine ice cube", "stakes": "+3 scrolls · Jinxed",
          "outcome": {"text": "'From the very North!' you say. They are thrilled. It is "
                              "melting. You feel bad about it later, as you should.",
                      "scrolls": 3, "buff": ["jinx", 1]}},
         {"label": "Pose for the portrait", "stakes": "Fortune's Favour",
          "outcome": {"text": "It takes an hour. You look heroic. The happiness of "
                              "Hyperboreans is, it turns out, catching.",
                      "buff": ["fortune", 1]}},
     ]},

    {"id": "cracking_floe", "stage": "ice", "kind": "choice", "art": "floe",
     "where": ["sea"], "weight": 2, "hostile": True,
     "title": "The Floe Is Cracking",
     "text": "You have moored against a broad floe to stretch your legs. There is "
             "a sound like a very large biscuit being snapped. A black line races "
             "across the ice between you and the ship.",
     "options": [
         {"label": "Jump for it", "stakes": "a gamble",
          "roll": [[3, {"text": "You clear the gap with a heroic leap and land in the "
                                "rigging. Everyone pretends it was on purpose."}],
                   [2, {"text": "You clear most of the gap. The rest of you arrives "
                                "wet and cross.", "hull": -1}]]},
         {"label": "Throw the cargo across first", "stakes": "−2 scrolls · safe",
          "requires": {"scrolls": 2},
          "outcome": {"text": "Lighter, you hop over with dignity. Some of the scrolls "
                              "make it. Most of them sink in a very literary way.",
                      "scrolls": -2}},
         {"label": "Ride the floe out", "stakes": "Becalmed for a roll",
          "outcome": {"text": "You sit on your half of the ice until the current brings "
                              "it back round. It takes a while.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "aurora_request", "stage": "ice", "kind": "game", "art": "aurora",
     "where": ["sea", "haven", "shrine"], "weight": 3, "heavy": True,
     "title": "The Aurora Takes Requests",
     "text": "The northern lights ripple overhead and, very slowly, spell out a "
             "word across the sky: REQUESTS? Green, violet and rose curtains wait "
             "politely for your answer.",
     "options": [
         {"label": "Tune the lights yourself", "stakes": "a lights puzzle · win: +2, Fortune",
          "outcome": {"text": "Every pane of light you touch flips its neighbours too.",
                      "puzzle": {"kind": "lights_out",
                                 "win": {"text": "The whole sky blazes in your colours. "
                                                 "Somewhere, a seal applauds.",
                                         "scrolls": 2, "buff": ["fortune", 2]},
                                 "lose": {"text": "The sky goes an embarrassed beige "
                                                  "and turns itself off."}}}},
         {"label": "Ask for a following wind", "stakes": "Fair Wind ×2",
          "outcome": {"text": "The lights swirl green and a soft wind rises behind you.",
                      "buff": ["fair_wind", 2]}},
         {"label": "Ask for something rude", "stakes": "a gamble",
          "roll": [[1, {"text": "The aurora spells it. Your crew laughs so hard they "
                                "find a scroll they had lost.", "scrolls": 2}],
                   [1, {"text": "The aurora spells YOUR name, then something rude about "
                                "it. The whole Reach sees.", "buff": ["jinx", 1]}]]},
         {"label": "Just watch", "stakes": "+1 Health",
          "outcome": {"text": "You lie on the deck and watch until your neck aches and "
                              "your heart doesn't.", "hull": 1}},
     ]},

    {"id": "hot_spring", "stage": "ice", "kind": "choice", "art": "spring",
     "where": ["sea", "haven"], "weight": 2, "when": {"hurt": True},
     "title": "A Hot Spring in the Ice",
     "text": "Steam rises from a pool in the middle of a floe, ringed with "
             "snow-monkeys who are, frankly, living their best lives. They budge "
             "up to make room.",
     "options": [
         {"label": "Soak a while", "stakes": "+2 Health",
          "outcome": {"text": "Your aches dissolve. A monkey hands you a warm stone to "
                              "hold. You will remember this monkey.", "hull": 2}},
         {"label": "Soak a long while", "stakes": "+4 Health · lose a turn",
          "outcome": {"text": "You wake up wrinkled as a walnut, the monkeys gone, the "
                              "stars out, and every plank of you mended.",
                      "hull": 4, "skip": True}},
         {"label": "Fill a barrel and go", "stakes": "+1 Health",
          "outcome": {"text": "A barrel of warm water for the hold. The monkeys think "
                              "you are mad.", "hull": 1}},
     ]},

    # ── GAMES ───────────────────────────────────────────────────────────────
    {"id": "ice_fisher", "stage": "ice", "kind": "game", "art": "fishhole",
     "where": ["sea", "haven"], "weight": 3, "heavy": True,
     "title": "The Ice-Fishing Philosopher",
     "text": "A man in seven coats sits by a hole in the ice, holding a line. 'If "
             "a fish is caught and nobody eats it, was it ever a fish?' He has a "
             "heap of frozen sprats beside him and an offer.",
     "options": [
         {"label": "Play his sprat game", "stakes": "win: +3 scrolls · lose: Becalmed",
          "outcome": {"text": "'Take one, two or three sprats. Whoever takes the last "
                              "sprat has understood the fish.'",
                      "game": {"kind": "nim", "params": {"err": 0.3},
                               "win": {"text": "'You have understood the fish,' he says "
                                               "gravely, and pays you in coin and sprats.",
                                       "scrolls": 3},
                               "lose": {"text": "'Have you understood the fish?' You have "
                                                "not. You sit and think about it.",
                                        "buff": ["becalmed", 1]}}}},
         {"label": "Ask him the meaning of ice", "stakes": "Fortune's Favour",
          "outcome": {"text": "'Water that has decided to stay.' You think about that "
                              "for days, and somehow it helps.",
                      "buff": ["fortune", 1]}},
         {"label": "Leave him to his hole", "stakes": "safe",
          "outcome": {"text": "He nods. The hole nods. Neither looks up."}},
     ]},

    {"id": "floe_path", "stage": "ice", "kind": "game", "art": "floe",
     "where": ["sea"], "weight": 3, "heavy": True,
     "title": "The Floe Field",
     "text": "Between you and the open lead lies a field of drifting floes, some "
             "thick, some thin as pastry. A seal on the far side shouts that it "
             "knows a short cut, and that the bear went this way earlier.",
     "options": [
         {"label": "Cross on foot", "stakes": "3 rows: +2 · all 6: +4, Fair Wind",
          "outcome": {"text": "Each floe you stand on creaks how many thin floes lie "
                              "ahead of you. The bear's prints mark sound ice.",
                      "game": {"kind": "floe", "params": {"rows": 6, "cols": 4, "poles": 3,
                                                          "goal": 3},
                               "score": [[3, {"text": "You stop on good ice and wave "
                                                      "the ship over. The seal pays up "
                                                      "for the show.", "scrolls": 2}],
                                         [6, {"text": "Clean across! The seal's short "
                                                      "cut is real, and so is its "
                                                      "admiration.", "scrolls": 4,
                                              "buff": ["fair_wind", 2]}]],
                               "lose": {"text": "A splash, or cold feet — either way you "
                                                "end up back aboard, damp and slow, and "
                                                "the seal will be telling this story for "
                                                "years.", "buff": ["becalmed", 1]}}}},
         {"label": "Sail the long way round", "stakes": "Becalmed for a roll",
          "outcome": {"text": "The long way is long. The seal looks disappointed in you.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "lost_anchor", "stage": "ice", "kind": "game", "art": "floe",
     "where": ["sea", "haven"], "weight": 2, "heavy": True,
     "title": "Your Anchor Is on a Floe",
     "text": "You dropped anchor. The anchor found a floe. The floe has drifted "
             "off with your anchor in the middle of a field of other floes, some "
             "of which look very thin indeed.",
     "options": [
         {"label": "Go and get it", "stakes": "a floe path · win: Pitch & Planks, +2",
          "outcome": {"text": "You take a sounding pole and step out onto the ice.",
                      "game": {"kind": "floe", "params": {"rows": 5, "cols": 4, "poles": 2,
                                                          "goal": 5},
                               "win": {"text": "Anchor recovered — and wedged under it, "
                                               "somebody else's lost cargo.",
                                       "item": "planks", "scrolls": 2},
                               "lose": {"text": "You turn back with cold feet and no "
                                                "anchor. The crew rigs a rock on a rope.",
                                        "scrolls": -1}}}},
         {"label": "Buy a new one at the next port", "stakes": "−1 scroll",
          "requires": {"scrolls": 1},
          "outcome": {"text": "You let the floe keep it. Floes need anchors too.",
                      "scrolls": -1}},
         {"label": "Drift without one", "stakes": "a gamble",
          "roll": [[1, {"text": "The current is kind and carries you on.",
                        "move": {"toward": "random", "steps": 2}}],
                   [1, {"text": "The current is not kind. You bump a berg.", "hull": -1}]]},
     ]},

    {"id": "fish_holes", "stage": "ice", "kind": "game", "art": "fishhole",
     "where": ["sea", "haven", "shrine"], "weight": 3, "heavy": True,
     "title": "The Auk's Ice-Hole Game",
     "text": "An elderly great auk runs a stall on a floe: twelve holes in the "
             "ice, each with a fish under it, every fish with a twin. 'Two lids a "
             "go, dear. Match the twins. No rush at all.'",
     "options": [
         {"label": "Play the holes", "stakes": "3 pairs: +1 · 5: +3 · all 6: +4, Aegis",
          "outcome": {"text": "She lifts nothing. 'You lift. I watch. Take all the time "
                              "you like, I'm extinct anyway.'",
                      "game": {"kind": "pairs", "params": {"pairs": 6, "tries": 12,
                                                           "goal": 3, "set": "ice"},
                               "score": [[3, {"text": "She pays you a fish and a coin.",
                                              "scrolls": 1, "hull": 1}],
                                         [5, {"text": "She pays three coins and calls you "
                                                      "'a sharp one'.", "scrolls": 3}],
                                         [6, {"text": "Every twin found. She gives you her "
                                                      "lucky charm. 'I won't need it.'",
                                              "scrolls": 4, "item": "aegis_charm"}]],
                               "lose": {"text": "'Never mind, dear. The fish enjoyed it.'"}}}},
         {"label": "Buy a fish and go", "stakes": "−1 scroll · +2 Health",
          "requires": {"scrolls": 1, "hurt": True},
          "outcome": {"text": "It is a very good fish.", "scrolls": -1, "hull": 2}},
         {"label": "Wish her good day", "stakes": "safe",
          "outcome": {"text": "'Every day is good when you're the last one,' she says."}},
     ]},

    {"id": "frost_giant", "stage": "ice", "kind": "game", "art": "giant",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "A Frost Giant's Little Game",
     "text": "A frost giant the size of a lighthouse is sitting on a berg, bored "
             "out of his mind. 'STONE, SCROLL, SHEARS. FIRST TO THREE.' His eyebrows "
             "have icicles. They twitch before every throw.",
     "options": [
         {"label": "Play the giant", "stakes": "win: +3, Fortune · lose: −1 Health",
          "outcome": {"text": "He cracks his knuckles. Three small avalanches result.",
                      "game": {"kind": "rps", "params": {"need": 3},
                               "win": {"text": "'AGAIN!' he roars, delighted, and throws "
                                               "you a purse the size of a sheep.",
                                       "scrolls": 3, "buff": ["fortune", 1]},
                               "lose": {"text": "He wins and celebrates with a friendly "
                                                "slap on your mast.", "hull": -1}}}},
         {"label": "Tell him a joke instead", "stakes": "a gamble",
          "roll": [[2, {"text": "He laughs so hard the berg splits and a seam of silver "
                                "shows in it.", "scrolls": 2}],
                   [1, {"text": "He doesn't get it. He asks you to explain it. Twice.",
                        "buff": ["becalmed", 1]}]]},
         {"label": "Row away while he blinks", "stakes": "safe",
          "outcome": {"text": "Giants blink slowly. You are well away."}},
     ]},

    {"id": "frozen_hoard", "stage": "ice", "kind": "game", "art": "berg",
     "where": ["sea", "shrine"], "weight": 3, "heavy": True,
     "title": "Coins in a Berg",
     "text": "A small berg drifts by with a pirate's hoard frozen in its heart. "
             "Each swing of the axe frees a few coins. Each swing also makes the "
             "berg groan in a way you would rather it didn't.",
     "options": [
         {"label": "Chip at it", "stakes": "chip on for more · a crack loses it all",
          "outcome": {"text": "Swing by swing. A crack-line spreads — the berg will "
                              "split if you push your luck.",
                      "game": {"kind": "knucklebones", "params": {"goals": [6, 12, 18]},
                               "score": [[6, {"text": "A frozen handful of coin.",
                                              "scrolls": 2}],
                                         [12, {"text": "A whole frozen purse!",
                                               "scrolls": 4}],
                                         [18, {"text": "The pirate's own strongbox, and his "
                                                       "lucky horn.", "scrolls": 5,
                                               "item": "horn"}]],
                               "lose": {"text": "CRACK. The berg rolls over and takes the "
                                                "hoard down with it. Your oar comes back "
                                                "in two pieces.", "hull": -1}}}},
         {"label": "Tow the whole berg", "stakes": "Becalmed ×2 · +2 scrolls",
          "outcome": {"text": "It is very heavy and very slow, and in port it melts into "
                              "a puddle of coin.", "scrolls": 2, "buff": ["becalmed", 2]}},
         {"label": "Let it drift", "stakes": "safe",
          "outcome": {"text": "Some treasure is meant for the fish."}},
     ]},

    {"id": "snowball_scale", "stage": "ice", "kind": "game", "art": "snowball",
     "where": ["sea", "haven"], "weight": 2, "heavy": True,
     "title": "Nine Snowballs, One Rock",
     "text": "An arctic fox has lined up nine identical snowballs on a floe. "
             "'One has a rock in it. Find it with my scale — three weighings — "
             "and you get to throw it at me. Fair's fair.'",
     "options": [
         {"label": "Borrow the scale", "stakes": "a weighing puzzle · win: +3, Fair Wind",
          "outcome": {"text": "The scale is made of two clam shells and great faith.",
                      "game": {"kind": "weigh", "params": {"jars": 9, "weighings": 3},
                               "win": {"text": "You find it. You throw it. You miss. The "
                                               "fox is so impressed it pays you anyway.",
                                       "scrolls": 3, "buff": ["fair_wind", 1]},
                               "lose": {"text": "You pick a snowball. It is just snow. The "
                                                "fox throws the right one at you.",
                                        "hull": -1}}}},
         {"label": "Throw all nine at him", "stakes": "a gamble",
          "roll": [[1, {"text": "One of them connects. The fox concedes the game and "
                                "its lunch money.", "scrolls": 2}],
                   [1, {"text": "He dodges all nine and throws back the tenth, which you "
                                "had not known about.", "hull": -1}]]},
         {"label": "Decline to play", "stakes": "safe",
          "outcome": {"text": "'Coward,' says the fox, packing another snowball."}},
     ]},

    {"id": "igloo_cups", "stage": "ice", "kind": "game", "art": "igloo",
     "where": ["sea", "haven", "shrine"], "weight": 2, "heavy": True,
     "title": "Three Igloos and a Seal",
     "text": "Three little igloos stand on a floe. A seal is hiding in one of them; "
             "you can hear it trying not to giggle. Each igloo has a sign, and the "
             "seal's mother swears how many of the signs are true.",
     "options": [
         {"label": "Find the seal", "stakes": "win: +3 scrolls · lose: −1",
          "requires": {"scrolls": 1},
          "outcome": {"text": "You walk round the igloos, reading.",
                      "game": {"kind": "shells",
                               "win": {"text": "Found! The seal shrieks with joy and its "
                                               "mother pays the finder's fee.",
                                       "scrolls": 3},
                               "lose": {"text": "Empty. The seal giggles from the next "
                                                "igloo along. You pay the fee for the "
                                                "game.", "scrolls": -1}}}},
         {"label": "Play for fun", "stakes": "win: Fortune's Favour",
          "outcome": {"text": "'No stakes,' says the mother seal. 'Just honour.'",
                      "game": {"kind": "shells",
                               "win": {"text": "The seal pops out and kisses you on the "
                                               "nose. That has to be lucky.",
                                       "buff": ["fortune", 2]},
                               "lose": {"text": "The seal wins. The seal always wins."}}}},
         {"label": "Leave them to their game", "stakes": "safe",
          "outcome": {"text": "Somewhere behind you, an igloo giggles."}},
     ]},

    {"id": "icicle_harp", "stage": "ice", "kind": "game", "art": "icicle",
     "where": ["sea", "shrine"], "weight": 2, "heavy": True,
     "title": "The Icicle Harp",
     "text": "Icicles hang from an overhanging berg in rows, and the wind plays "
             "them like a harp — the same few notes over and over, waiting for "
             "someone to finish the tune.",
     "options": [
         {"label": "Finish the tune", "stakes": "a pattern puzzle · win: +2, Fair Wind",
          "outcome": {"text": "The wind pauses on a phrase and waits.",
                      "puzzle": {"kind": "sequence",
                                 "win": {"text": "The berg rings like a bell, and a "
                                                 "warm wind follows you out.",
                                         "scrolls": 2, "buff": ["fair_wind", 2]},
                                 "lose": {"text": "A wrong note. An icicle drops, point "
                                                  "first, onto the deck.", "hull": -1}}}},
         {"label": "Snap off an icicle as a souvenir", "stakes": "+1 scroll",
          "outcome": {"text": "It plays one note when you tap it. Collectors pay for that.",
                      "scrolls": 1}},
         {"label": "Listen and sail on", "stakes": "safe",
          "outcome": {"text": "It follows you for a mile, softer and softer."}},
     ]},

    # ── INSTANTS ────────────────────────────────────────────────────────────
    {"id": "seal_choir", "stage": "ice", "kind": "instant", "art": "seal",
     "where": ["sea", "haven"], "weight": 3,
     "title": "The Seal Choir",
     "text": "Forty seals on a floe, in rows by height, are conducted by a very "
             "serious walrus. They launch into a hymn as you pass.",
     "roll": [[2, {"text": "It is glorious. Your crew rows in time to it.",
                   "buff": ["fair_wind", 2]}],
              [1, {"text": "They insist on an encore. And another. Your crew is "
                           "too polite to leave.", "buff": ["becalmed", 1]}],
              [2, {"text": "You throw a coin; the walrus throws back three. Conductors "
                           "are paid well up here.", "scrolls": 2}]]},

    {"id": "frozen_letter", "stage": "ice", "kind": "instant", "art": "bottle",
     "where": ["sea"], "weight": 3,
     "title": "A Letter Frozen in the Ice",
     "text": "A sealed letter is frozen into a passing floe. You chip it out and "
             "thaw it over a candle.",
     "roll": [[3, {"text": "It is a love letter, never sent, with a coin for the "
                           "postage. You send it on, and keep the change.",
                   "scrolls": 2}],
              [1, {"text": "It is a chart, with an islet circled in red.",
                   "reveal": "sword"}],
              [2, {"text": "It is a curse, very politely worded. You read it before "
                           "you notice.", "buff": ["jinx", 1], "scrolls": 1}],
              [2, {"text": "It is a recipe for a warming tonic. It works.", "hull": 2}]]},

    {"id": "narwhal_escort", "stage": "ice", "kind": "instant", "art": "narwhal",
     "where": ["sea"], "weight": 2,
     "title": "A Narwhal Escort",
     "text": "A narwhal surfaces beside your bow, tusk raised like a herald's "
             "trumpet, and swims ahead of you, clearing the floes.",
     "roll": [[3, {"text": "It clears a lane straight through the ice.",
                   "buff": ["fair_wind", 2]}],
              [1, {"text": "It spears a passing chest from the deep and drops it on "
                           "your deck.", "scrolls": 2, "item": "gale"}]]},

    {"id": "snowball_ambush", "stage": "ice", "kind": "instant", "art": "snowball",
     "where": ["sea", "haven"], "weight": 2,
     "title": "A Snowball Ambush",
     "text": "From behind a berg: a war-cry, and a volley of snowballs. A pack "
             "of arctic foxes, armed and delighted, pours out.",
     "roll": [[2, {"text": "You win the snowball war. The foxes surrender their "
                           "treasury: one scroll and some string.", "scrolls": 1}],
              [1, {"text": "You lose the snowball war. One of the snowballs had a "
                           "rock in it.", "hull": -1}],
              [2, {"text": "Nobody wins. Everybody laughs. It is a good day.",
                   "buff": ["fortune", 1]}]]},

    # ── TABLE events ────────────────────────────────────────────────────────
    {"id": "ice_derby", "stage": "ice", "kind": "table", "art": "fishhole",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Great Ice-Hole Derby",
     "text": "The Reach's fishing derby begins, and every captain is entered. "
             "Three holes have been cut in the ice: one teeming with fish, one "
             "empty, and one with a walrus underneath who does not want company.",
     "table": {"kind": "lanes", "prompt": "Which hole do you fish? (secretly)",
               "lanes": {"teeming": {"scrolls": 2, "hull": 1},
                         "empty": {"scrolls": 0},
                         "walrus": {"hull": -1}},
               "log": "the ice-hole derby"}},

    {"id": "giant_beard", "stage": "ice", "kind": "table", "art": "giant",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "How Many Icicles in the Giant's Beard?",
     "text": "A frost giant leans down over the whole fleet, beard first. 'GUESS "
             "HOW MANY ICICLES. CLOSEST WINS A PRIZE. IT IS BETWEEN FORTY AND A "
             "HUNDRED. I COUNTED THIS MORNING.'",
     "table": {"kind": "guess", "prompt": "How many icicles in the beard?",
               "params": {"range": [40, 100]},
               "prize": {"scrolls": 3, "item": "gale"}, "log": "the giant's beard"}},

    {"id": "aurora_concert", "stage": "ice", "kind": "table", "art": "aurora",
     "where": ["sea", "haven", "shrine"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Aurora Plays for Everyone",
     "text": "The northern lights gather over the whole Reach and spell, in "
             "letters a mile high: WHAT SHALL WE PLAY? Every captain may vote.",
     "table": {"kind": "vote", "prompt": "What should the aurora play?",
               "choices": [
                   {"label": "Something warm and green",
                    "outcome": {"text": "Every crew feels it in their bones.", "hull": 1}},
                   {"label": "Something fast and violet",
                    "outcome": {"text": "The wind picks up behind every ship.",
                                "buff": ["fair_wind", 1]}},
                   {"label": "Something gold, for luck",
                    "outcome": {"text": "Gold light pours down; a little of it stays "
                                        "in every purse.", "scrolls": 1}}],
               "log": "the aurora's concert"}},

    {"id": "polar_plunge", "stage": "ice", "kind": "table", "art": "spring",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Polar Plunge",
     "text": "A walrus in a sash announces the annual Polar Plunge: one scroll to "
             "enter, everyone jumps in at once, and if the sea-god is amused, every "
             "plunger is paid three. If not, well, it is very cold.",
     "table": {"kind": "gamble", "prompt": "Ante one scroll and jump — or stay dry.",
               "params": {"ante": 1}, "odds": 0.5,
               "win": {"scrolls": 3}, "hit_text": "The sea-god laughs a great bubbling "
               "laugh and pays every brave fool.",
               "miss_text": "The sea-god is not amused. It is very, very cold.",
               "log": "the polar plunge"}},

    {"id": "tusk_auction", "stage": "ice", "kind": "table", "art": "walrus",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Walrus Auction",
     "text": "A walrus with a gavel has a mammoth-ivory war horn and an Aegis "
             "Charm frozen in one block of ice. 'Sealed bids! Highest pays! I do "
             "not do refunds and I do not do ice-picks!'",
     "table": {"kind": "bid", "prompt": "Your sealed bid, in scrolls (0 to sit it out).",
               "params": {"cap": 8, "worth": 6},
               "prize": {"items": ["horn", "aegis_charm"]}, "log": "the walrus auction"}},

    # ── WORLD meetings ──────────────────────────────────────────────────────
    {"id": "meet_walrus", "stage": "ice", "kind": "game", "art": "walrus",
     "where": ["sea"], "world": True,
     "title": "The Walrus Toll-Keeper",
     "text": "An enormous walrus lies across a floe that lies across the lane. He "
             "wears a brass badge reading TOLL and an expression reading NO. 'Two "
             "scrolls,' he says, 'or one riddle. I have opinions about riddles.'",
     "options": [
         {"label": "Pay the toll", "stakes": "−2 scrolls · Fortune's Favour",
          "requires": {"scrolls": 2},
          "outcome": {"text": "He bites each scroll to check it, stamps your hull with "
                              "a wet flipper, and waves you on. Officially lucky.",
                      "scrolls": -2, "buff": ["fortune", 2]}},
         {"label": "Answer his riddle", "stakes": "a riddle · win: +2 · lose: Becalmed ×2",
          "outcome": {"text": "He clears his throat for a very long time.",
                      "puzzle": {"kind": "riddle",
                                 "win": {"text": "'Correct.' He is so pleased he pays YOU, "
                                                 "and rolls off the lane.", "scrolls": 2},
                                 "lose": {"text": "'Wrong.' He sits on your bow until he "
                                                  "feels better about it.",
                                          "buff": ["becalmed", 2]}}}},
         {"label": "Out-stare him", "stakes": "a gamble",
          "roll": [[1, {"text": "He blinks first. He has never blinked first. He leaves "
                                "in a huff, and the lane is clear for everyone.",
                        "remove_world": True, "scrolls": 1}],
                   [2, {"text": "You blink first. Walruses do not blink. You pay a fine "
                                "for trying.", "scrolls": -1}]]},
         {"label": "Turn back and go round", "stakes": "Becalmed for a roll",
          "outcome": {"text": "He watches you go the long way with deep satisfaction.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "meet_aurora_whale", "stage": "ice", "kind": "choice", "art": "whale",
     "where": ["sea"], "world": True,
     "title": "The Aurora Whale",
     "text": "A whale made of northern light swims through the air above the "
             "water, slow and enormous, trailing green and violet. It turns one "
             "kind eye toward you and sings something you feel in your teeth.",
     "options": [
         {"label": "Ride in its wake", "stakes": "carried toward the Wyrm · up to 4 stops",
          "outcome": {"text": "Its wake picks your ship up like a leaf and carries you "
                              "deep into the Reach.", "move": {"toward": "lair", "steps": 4}}},
         {"label": "Follow it to shelter", "stakes": "carried toward the haven",
          "outcome": {"text": "It knows where the quiet water is.",
                      "move": {"toward": "haven", "steps": 4}}},
         {"label": "Sing back to it", "stakes": "+2 Health · Fortune's Favour",
          "outcome": {"text": "You sing, badly. It sings back, beautifully. Something in "
                              "your hull and your heart mends.",
                      "hull": 2, "buff": ["fortune", 1]}},
         {"label": "Watch it pass", "stakes": "+1 Health",
          "outcome": {"text": "You will tell your grandchildren. They will not believe "
                              "you.", "hull": 1}},
     ]},

    {"id": "meet_berg_giant", "stage": "ice", "kind": "choice", "art": "berg",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "The Berg Is Snoring",
     "text": "The iceberg beside you has a nose. And closed eyes. And it is "
             "snoring — a slow, grinding snore that makes the sea shiver. It is "
             "not an iceberg. It is a giant, asleep, and very cold.",
     "options": [
         {"label": "Chip silver from his beard", "stakes": "a gamble · +3 or he wakes",
          "roll": [[3, {"text": "Tap, tap. Silver flakes from the frost. He mumbles "
                                "about his mother and sleeps on.", "scrolls": 3}],
                   [2, {"text": "He wakes. He is grumpy. He is enormous.",
                        "fight": {"name": "The Sleeping Giant", "unit": "Berg Giant",
                                  "hp": 5, "power": 1, "model": "golem", "count": 1},
                        "remove_world": True}]]},
         {"label": "Wake him with a broadside", "stakes": "a battle · he leaves for good",
          "outcome": {"text": "A bad idea, bravely executed.",
                      "fight": {"name": "The Sleeping Giant", "unit": "Berg Giant",
                                "hp": 5, "power": 1, "model": "golem", "count": 1},
                      "remove_world": True}},
         {"label": "Tiptoe past", "stakes": "a gamble",
          "roll": [[3, {"text": "Not a creak. He snores on."}],
                   [1, {"text": "He rolls over in his sleep. A lot of ice moves.",
                        "hull": -1}]]},
     ]},

    {"id": "meet_penguins", "stage": "ice", "kind": "game", "art": "penguin",
     "where": ["sea"], "world": True,
     "title": "The Penguin Parliament",
     "text": "You have drifted into the middle of a parliamentary session. Two "
             "hundred penguins in neat rows turn to stare. The Speaker, a very "
             "small penguin in a very large wig, raps a fish on a block of ice. "
             "'ORDER. The Honourable Ship has the floor.'",
     "options": [
         {"label": "Propose a motion to every fleet", "stakes": "everyone votes",
          "when": {"players_min": 2},
          "outcome": {"text": "The Speaker sends runners to every ship in the Reach.",
                      "table": {"kind": "vote", "prompt": "The motion before the House:",
                                "choices": [
                                    {"label": "Free fish for every crew",
                                     "outcome": {"text": "Carried. Fish all round.",
                                                 "hull": 1}},
                                    {"label": "A ship tax, paid to the penguins",
                                     "outcome": {"text": "Carried. The penguins are "
                                                         "delighted and very lucky to "
                                                         "know.", "scrolls": -1,
                                                 "buff": ["fortune", 1]}},
                                    {"label": "Abolish winter",
                                     "outcome": {"text": "Carried, unanimously. Winter "
                                                         "ignores it. Everyone sulks.",
                                                 "buff": ["becalmed", 1]}}],
                                "log": "the penguin parliament's vote"}}},
         {"label": "Recite the seating plan", "stakes": "a memory game · win: +3 scrolls",
          "outcome": {"text": "'The member must first find each penguin's twin. House "
                              "rules. Take your time; we have all winter.'",
                      "game": {"kind": "pairs", "params": {"pairs": 6, "tries": 12,
                                                           "goal": 4, "set": "ice"},
                               "score": [[4, {"text": "The House applauds by slapping "
                                                      "its flippers.", "scrolls": 2}],
                                         [6, {"text": "A perfect seating plan! You are "
                                                      "made an honorary penguin.",
                                              "scrolls": 3, "buff": ["fortune", 1]}]],
                               "lose": {"text": "'The member is out of order.' You are "
                                                "escorted off by two very small guards."}}}},
         {"label": "Bow to the Speaker and withdraw", "stakes": "Fortune's Favour",
          "outcome": {"text": "Good manners are noted in the minutes. It is lucky to be "
                              "in the minutes.", "buff": ["fortune", 1]}},
     ]},
]

# ── WORLD entities in the Reach ─────────────────────────────────────────────
WORLD = [
    {"id": "walrus", "stage": "ice", "title": "The Walrus Toll-Keeper", "art": "walrus",
     "text": "A walrus collecting tolls on a floe. Sail into his stop to pay, riddle "
             "or argue.", "model": "walrus", "rounds": 7, "moves": 0, "where": "sea",
     "radius": 0, "weight": 3, "meet": "meet_walrus", "bot": "curious",
     "log": "a walrus sets up a toll on the floes", "gone": "rolls off his floe and swims away"},
    {"id": "aurora_whale", "stage": "ice", "title": "The Aurora Whale", "art": "whale",
     "text": "A whale of northern light swimming through the air. Sail into its stop "
             "to ride its wake.", "model": "aurora_whale", "rounds": 6, "moves": 1,
     "where": "sea", "radius": 0, "weight": 3, "meet": "meet_aurora_whale", "bot": "seek",
     "log": "a whale of light rises out of the aurora", "gone": "fades into the dawn"},
    {"id": "berg_giant", "stage": "ice", "title": "The Sleeping Giant", "art": "berg",
     "text": "An iceberg that snores. Landing on or beside it wakes trouble — or "
             "pays in silver.", "model": "berg_giant", "rounds": 7, "moves": 0,
     "where": "sea", "radius": 1, "weight": 2, "meet": "meet_berg_giant", "bot": "fight",
     "log": "an iceberg begins to snore", "gone": "turns over and sinks, still asleep"},
    {"id": "penguins", "stage": "ice", "title": "The Penguin Parliament", "art": "penguin",
     "text": "Two hundred penguins in session on a floe. Sail into their stop to "
             "address the House.", "model": "penguins", "rounds": 6, "moves": 0,
     "where": "sea", "radius": 0, "weight": 3, "meet": "meet_penguins", "bot": "seek",
     "log": "the Penguin Parliament convenes on a floe", "gone": "rises for the season"},
]

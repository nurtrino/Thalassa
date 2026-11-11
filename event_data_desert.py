"""
Thalassa event CONTENT for the Bleached Reach (the desert realm) — pure data,
read by events.py through event_data.py (schema: events.py header and
docs/EVENTS.md).

The desert is crossed ON FOOT: its open stops are dune-trail waypoints
("sea" class), a spent shrine is an "islet", and the haven detour is a
"haven". Hunting grounds, Sphinx gates, the pass and the lair never host an
event (events.node_class), so nothing here can fire on a landing that starts
a fight. Tows ("move") never carry a captain past an unanswered Sphinx gate.

Conventions as in event_data.py: the LAST option of a card is the cautious
one and has no ``requires``; every option has ``stakes``.
"""

D = "desert"

EVENTS = [
    # ── CHOICE cards ────────────────────────────────────────────────────────
    {"id": "djinn", "stage": D, "kind": "choice", "art": "djinn",
     "where": ["sea", "islet"], "weight": 3, "once": "player",
     "title": "A Djinn With a Literal Mind",
     "text": "You kick a lamp half-buried in the sand. Out pours a djinn the size "
             "of a lighthouse, cracking his knuckles. 'One wish, mortal. Choose "
             "your words carefully. I certainly will.'",
     "options": [
         {"label": "'I wish to be rich beyond measure'", "stakes": "a gamble · scrolls, or sand",
          "roll": [[2, {"text": "Coins rain from the sky. Mostly on your head, but still.",
                        "scrolls": 3, "hull": -1}],
                   [1, {"text": "'Beyond measure' — he takes away every ruler, scale and "
                                "measuring cup you own. You are not richer. You are confused.",
                        "buff": ["becalmed", 1]}]]},
         {"label": "'I wish to be far from here'", "stakes": "whisked across the dunes",
          "outcome": {"text": "'Far from HERE? Easily.' The world folds, and so do you.",
                      "move": {"toward": "random", "steps": 3}}},
         {"label": "'I wish you a pleasant afternoon'", "stakes": "Fortune's Favour",
          "outcome": {"text": "Nobody has ever wished HIM anything. He weeps smoke, and "
                              "your luck feels very good indeed.", "buff": ["fortune", 2]}},
     ]},

    {"id": "sandals", "stage": D, "kind": "choice", "art": "sandal",
     "where": ["sea", "haven"], "weight": 3,
     "title": "The Sandal Salesman",
     "text": "A man with a cart of sandals has set up shop on top of a dune, "
             "miles from anyone. 'Captain! Your feet look TERRIBLE. Hermes "
             "himself wears these. Well. A cousin of his.'",
     "options": [
         {"label": "Buy the deluxe pair", "stakes": "−2 scrolls · Fair Wind ×3",
          "requires": {"scrolls": 2},
          "outcome": {"text": "They squeak with every step, but every step is longer.",
                      "scrolls": -2, "buff": ["fair_wind", 3]}},
         {"label": "Try on a free sample", "stakes": "a gamble",
          "roll": [[1, {"text": "Like walking on clouds. Clouds with good arch support.",
                        "buff": ["fair_wind", 1]}],
                   [1, {"text": "Two sizes too small. The blisters have blisters.",
                        "buff": ["becalmed", 1]}]]},
         {"label": "Point out that you have boots", "stakes": "safe",
          "outcome": {"text": "'Boots! In THIS economy?' He is still shouting as you leave."}},
     ]},

    {"id": "colossus_head", "stage": D, "kind": "choice", "art": "colossus",
     "where": ["sea", "islet"], "weight": 2,
     "title": "A Colossal Head That Wants Company",
     "text": "A stone head as big as a house juts from the sand, the rest of its "
             "king long since buried. It opens one enormous eye. 'Oh, a visitor! "
             "Nobody visits. Sit. Sit! Tell me what the world is like now.'",
     "options": [
         {"label": "Tell it the news", "stakes": "+2 scrolls",
          "outcome": {"text": "It is thrilled by everything, even the boring parts. When you "
                              "leave, it coughs up the coins from under its tongue.",
                      "scrolls": 2}},
         {"label": "Climb up for the view", "stakes": "a gamble · carried toward the haven",
          "roll": [[2, {"text": "From its brow you can see the whole road — and a short way "
                                "round to the haven.", "move": {"toward": "haven", "steps": 3}}],
                   [1, {"text": "It sneezes. You come down a lot faster than you went up.",
                        "hull": -1}]]},
         {"label": "Promise to visit again", "stakes": "safe",
          "outcome": {"text": "'Everyone says that,' it sighs, and closes its eye."}},
     ]},

    {"id": "mummy", "stage": D, "kind": "choice", "art": "mummy",
     "where": ["sea", "islet", "haven"], "weight": 2,
     "title": "A Mummy Who Is Mostly Lonely",
     "text": "A mummy shuffles out of a doorway in a dune, arms outstretched. You "
             "brace for a curse. Instead: 'Hello! Would you like some tea? It is "
             "three thousand years old. It has really brewed.'",
     "options": [
         {"label": "Stay for tea", "stakes": "+2 Health",
          "outcome": {"text": "The tea is dreadful, the company delightful. You leave rested.",
                      "hull": 2}},
         {"label": "Help him re-wrap a sleeve", "stakes": "Pitch & Planks",
          "outcome": {"text": "He insists you keep the spare linen and a pot of resin. "
                              "'Good for patching. Ask me how I know.'", "item": "planks"}},
         {"label": "Back away slowly", "stakes": "a gamble",
          "roll": [[2, {"text": "He waves sadly. You feel terrible about it for a mile."}],
                   [1, {"text": "He follows you, hurt, for a whole afternoon. You are slowed "
                                "by guilt and by a mummy.", "buff": ["becalmed", 1]}]]},
     ]},

    {"id": "camel_opinions", "stage": D, "kind": "choice", "art": "camel",
     "where": ["sea", "haven"], "weight": 3,
     "title": "A Camel With Opinions",
     "text": "A camel blocks the trail and looks at you down the full length of "
             "its nose. It has heard about you. It is not impressed.",
     "options": [
         {"label": "Bribe it with a date", "stakes": "−1 scroll · it carries you",
          "requires": {"scrolls": 1},
          "outcome": {"text": "It eats the date, considers, and kneels. A camel ride! It is "
                              "smelly and splendid.", "scrolls": -1,
                      "move": {"toward": "lair", "steps": 3}}},
         {"label": "Argue with it", "stakes": "a gamble",
          "roll": [[1, {"text": "You make an excellent point. The camel, stunned, steps "
                                "aside and spits out a coin it was keeping.", "scrolls": 2}],
                   [1, {"text": "The camel makes a better point, mostly with spit.",
                        "buff": ["jinx", 1]}]]},
         {"label": "Walk the long way round", "stakes": "Becalmed for a roll",
          "outcome": {"text": "The camel watches you go the whole way, smugly.",
                      "buff": ["becalmed", 1]}},
     ]},

    {"id": "oasis_well", "stage": D, "kind": "choice", "art": "oasis",
     "where": ["sea", "haven"], "weight": 3,
     "title": "A Well Among the Palms",
     "text": "Three palms, a stone well and a bucket on a rope. After the dunes "
             "it looks like a temple. Someone has carved 'MAKE A WISH' on the rim, "
             "and 'NOT YOU, KLEON' underneath.",
     "options": [
         {"label": "Drink deep and rest", "stakes": "+2 Health",
          "requires": {"hurt": True},
          "outcome": {"text": "Cold, sweet water. The ache goes out of your legs.", "hull": 2}},
         {"label": "Throw a scroll in for luck", "stakes": "−1 scroll · a gamble",
          "requires": {"scrolls": 1},
          "roll": [[2, {"text": "Something down there approves.", "scrolls": -1,
                        "buff": ["fortune", 2]}],
                   [1, {"text": "A hand comes out and throws back two. 'Wrong well.'",
                        "scrolls": 1}]]},
         {"label": "Fill your waterskins", "stakes": "Fair Wind",
          "outcome": {"text": "With full skins you march at a fine pace.",
                      "buff": ["fair_wind", 1]}},
     ]},

    {"id": "sphinx_apprentice", "stage": D, "kind": "game", "art": "sphinx",
     "where": ["sea", "islet"], "weight": 3, "heavy": True,
     "title": "The Sphinx's Junior Apprentice",
     "text": "A sphinx no bigger than a large dog sits on a rock, wearing a paper "
             "crown. 'HALT, traveller! I am the Sphinx's apprentice and I have "
             "written my own riddles. Most of them are about cheese.'",
     "options": [
         {"label": "Answer a proper riddle", "stakes": "a riddle · win: +2, Fortune",
          "outcome": {"text": "He clears his throat. 'This one is not about cheese. "
                              "Mother made me learn it.'",
                      "puzzle": {"kind": "riddle",
                                 "win": {"text": "'CORRECT!' He is thrilled. He pays you in "
                                                 "his pocket money.", "scrolls": 2,
                                         "buff": ["fortune", 1]},
                                 "lose": {"text": "'Wrong! Ha! Wait until I tell Mother.' He "
                                                  "skips off to tell Mother.",
                                          "buff": ["becalmed", 1]}}}},
         {"label": "Say 'is the answer a man?'", "stakes": "a gamble",
          "roll": [[1, {"text": "'…how did you KNOW?' It was a man. It is always a man.",
                        "scrolls": 2}],
                   [2, {"text": "'No! It was CHEESE.' He seems disappointed in you."}]]},
         {"label": "Laugh politely at the cheese ones", "stakes": "+1 scroll",
          "outcome": {"text": "Nobody has ever laughed at his riddles. He tips you a coin "
                              "and asks you to come back when he has more.", "scrolls": 1}},
     ]},

    {"id": "tax_scribe", "stage": D, "kind": "game", "art": "scribe",
     "where": ["sea", "haven", "islet"], "weight": 3, "heavy": True,
     "title": "The Tax Scribe of Ra",
     "text": "A scribe in a linen kilt sits at a folding desk in the middle of "
             "nowhere, reed pen poised. 'Sand tax, captain. Two scrolls per foot, "
             "per dune. Unless your exemption seal is in order?' His own seal has "
             "three dials.",
     "options": [
         {"label": "Read his seal and match it", "stakes": "a code-breaker · win: +3 scrolls",
          "outcome": {"text": "He turns the seal so you can see the dials, then looks away "
                              "very pointedly.",
                      "game": {"kind": "codebreak", "params": {"tries": 6},
                               "win": {"text": "'Everything appears to be in order.' He "
                                               "refunds a tax you did not know you paid.",
                                       "scrolls": 3},
                               "lose": {"text": "'Forgery is a separate tax.'",
                                        "scrolls": -1}}}},
         {"label": "Pay the tax", "stakes": "−2 scrolls · Fortune's Favour",
          "requires": {"scrolls": 2},
          "outcome": {"text": "He stamps your forehead with a little sun. It feels lucky.",
                      "scrolls": -2, "buff": ["fortune", 2]}},
         {"label": "Explain you are a sailor, not a walker", "stakes": "a gamble",
          "roll": [[1, {"text": "He has no form for that. Defeated by paperwork, he waves "
                                "you through."}],
                   [1, {"text": "He has a form for that. It takes all afternoon.",
                        "buff": ["becalmed", 1]}]]},
     ]},

    # ── GAMES ───────────────────────────────────────────────────────────────
    {"id": "bazaar_duel", "stage": D, "kind": "game", "art": "bazaar",
     "where": ["sea", "haven"], "weight": 3, "heavy": True,
     "title": "The Bazaar Haggling Duel",
     "text": "A pop-up bazaar has bloomed between two dunes, and its finest "
             "carpet-seller has chosen you. 'For you, my friend, a flying carpet. "
             "It does not fly. But the PRICE, my friend — the price will fly.'",
     "options": [
         {"label": "Haggle for the carpet", "stakes": "a haggle · a good bargain pays up to +4",
          "outcome": {"text": "He names a price. You both know it is a joke. Name yours — "
                              "he will tell you, honestly, how insulted he is.",
                      "game": {"kind": "haggle", "params": {"range": [2, 14], "patience": 4},
                               "score": [[1, {"text": "You overpaid, but it is a lovely "
                                                      "carpet. You sell it on for a "
                                                      "scroll.", "scrolls": 1}],
                                         [3, {"text": "A fair price! A collector buys it off "
                                                      "you on the spot.", "scrolls": 2}],
                                         [4, {"text": "His very lowest price. He weeps, "
                                                      "embraces you, and throws in a Gale "
                                                      "Charm.", "scrolls": 3, "item": "gale"}]],
                               "lose": {"text": "He rolls the carpet up. 'You have wasted "
                                                "my whole morning, my friend.'"}}}},
         {"label": "Admire the carpet and leave", "stakes": "safe",
          "outcome": {"text": "'My friend! My FRIEND! Come back!'"}},
     ]},

    {"id": "scorpion_bones", "stage": D, "kind": "game", "art": "scorpion",
     "where": ["sea", "islet"], "weight": 3, "heavy": True,
     "title": "A Scorpion Plays Knucklebones",
     "text": "Under a flat rock, a scorpion the size of a cat is shaking a "
             "knucklebone in one claw. It taps the sand twice with its tail: your "
             "turn. It has clearly done this before.",
     "options": [
         {"label": "Play (stake 1 scroll)", "stakes": "6+ breaks even · 12+: +3 · 18+: +5",
          "requires": {"scrolls": 1},
          "outcome": {"text": "It slides the bone across. Throw, pile up the points — and "
                              "stop before the dog comes up.",
                      "game": {"kind": "knucklebones", "params": {"goals": [6, 12, 18]},
                               "score": [[6, {"text": "Even. The scorpion clicks, "
                                                      "unimpressed."}],
                                         [12, {"text": "The scorpion pays up with very "
                                                       "bad grace.", "scrolls": 3}],
                                         [18, {"text": "It pays up, then sulks under its "
                                                       "rock for a week.", "scrolls": 5}]],
                               "lose": {"text": "The dog! The scorpion's tail does a little "
                                                "victory dance.", "scrolls": -1}}}},
         {"label": "Decline — it is a scorpion", "stakes": "safe",
          "outcome": {"text": "Reasonable. It goes back to playing against itself."}},
     ]},

    {"id": "tomb_door", "stage": D, "kind": "game", "art": "tomb",
     "where": ["sea", "islet"], "weight": 2, "heavy": True, "once": "player",
     "title": "The Tomb With a Sliding Door",
     "text": "The wind has uncovered a tomb door made of carved tiles, one "
             "missing, so the rest can slide. Scratched beside it in a hurry: "
             "'PUT THE PICTURE RIGHT AND IT OPENS. — a previous visitor, very thirsty.'",
     "options": [
         {"label": "Slide the tiles", "stakes": "a sliding puzzle · win: Aegis Charm, +2",
          "outcome": {"text": "The tiles grind under your fingers.",
                      "puzzle": {"kind": "sliding",
                                 "win": {"text": "The door sighs open. Inside: grave goods, "
                                                 "and a note that says 'TAKE ONE'.",
                                         "item": "aegis_charm", "scrolls": 2},
                                 "lose": {"text": "Something clicks inside. You decide not "
                                                  "to find out what."}}}},
         {"label": "Pry it open", "stakes": "a gamble",
          "roll": [[1, {"text": "It gives! A small hoard spills out.", "scrolls": 2}],
                   [1, {"text": "It gives — onto your foot.", "hull": -1}]]},
         {"label": "Leave the dead their door", "stakes": "safe",
          "outcome": {"text": "Some doors are shut for a reason."}},
     ]},

    {"id": "sundial", "stage": D, "kind": "game", "art": "sundial",
     "where": ["sea", "islet", "haven"], "weight": 2, "heavy": True,
     "title": "The Sundial Priest's Sum",
     "text": "A priest of the sun is chalking numbers along the shadow of a great "
             "sundial. 'The shadow moves by a rule! Tell me where it falls next and "
             "you may share my lunch.' His lunch is magnificent.",
     "options": [
         {"label": "Find the rule", "stakes": "a pattern puzzle · win: +2 Health, +1",
          "outcome": {"text": "He points at the marks: the shadow's last few hours.",
                      "puzzle": {"kind": "sequence",
                                 "win": {"text": "'Exactly so!' Lunch is figs, bread and "
                                                 "honey. You share it gladly.",
                                         "hull": 2, "scrolls": 1},
                                 "lose": {"text": "'Ah. No.' He eats his lunch in front "
                                                  "of you, very slowly."}}}},
         {"label": "Wish him a sunny day", "stakes": "safe",
          "outcome": {"text": "'It is ALWAYS a sunny day,' he says, with feeling."}},
     ]},

    {"id": "canopic_jars", "stage": D, "kind": "game", "art": "amphorae",
     "where": ["sea", "islet"], "weight": 2, "heavy": True,
     "title": "Nine Canopic Jars",
     "text": "In a shrine half-swallowed by sand stand nine jackal-headed jars and "
             "a set of scales. One jar is heavy with gold; the others hold things "
             "you would rather not think about. The scales will tip three times.",
     "options": [
         {"label": "Weigh the jars", "stakes": "a weighing puzzle · win: +4 scrolls",
          "outcome": {"text": "The scales were made for weighing hearts. Jars will do.",
                      "game": {"kind": "weigh", "params": {"jars": 9, "weighings": 3},
                               "win": {"text": "Gold! You put the lid back on the others "
                                               "without looking.", "scrolls": 4},
                               "lose": {"text": "You open the wrong jar. You will never "
                                                "eat liver again."}}}},
         {"label": "Leave the jars alone", "stakes": "safe",
          "outcome": {"text": "Very wise. Very, very wise."}},
     ]},

    {"id": "jackal_ibis", "stage": D, "kind": "game", "art": "brook",
     "where": ["sea"], "weight": 2, "heavy": True,
     "title": "The Dry River's Ferryman",
     "text": "Where a river ought to be, there is only a channel of quicksand, a "
             "reed raft on a rope, and a very tired ferryman with a jackal, an ibis "
             "and a sack of grain. 'The raft takes me and one more…'",
     "options": [
         {"label": "Work out the crossing", "stakes": "a crossing puzzle · win: +3 scrolls",
          "outcome": {"text": "The jackal eyes the ibis. The ibis eyes the grain.",
                      "game": {"kind": "crossing",
                               "params": {"max_trips": 11,
                                          "names": {"wolf": "jackal", "goat": "ibis",
                                                    "charts": "grain"}},
                               "win": {"text": "All across, all uneaten. He pays you "
                                               "his fare box.", "scrolls": 3},
                               "lose": {"text": "There is a squawk, then a gulp. The "
                                                "ferryman sits down in the sand."}}}},
         {"label": "Wade the quicksand", "stakes": "a gamble",
          "roll": [[1, {"text": "You make it across, slowly, sucking at every step.",
                        "buff": ["becalmed", 1]}],
                   [1, {"text": "It takes a boot and a bit of you.", "hull": -1}]]},
         {"label": "Wish him well", "stakes": "safe",
          "outcome": {"text": "'Well,' he says. 'Ha.'"}},
     ]},

    {"id": "pyramid_nim", "stage": D, "kind": "game", "art": "pyramid",
     "where": ["sea", "islet"], "weight": 2, "heavy": True,
     "title": "The Architect's Capstones",
     "text": "An architect with a model pyramid and a heap of tiny capstones "
             "challenges you. 'We take one, two or three. Whoever lays the LAST "
             "capstone has built the pyramid — and wins my plans.'",
     "options": [
         {"label": "Play the architect", "stakes": "win: +3 scrolls · lose: Becalmed",
          "outcome": {"text": "He sets out the stones in a neat heap.",
                      "game": {"kind": "nim", "params": {"err": 0.3},
                               "win": {"text": "He rolls up his plans and hands them over. "
                                               "Someone will pay for these.", "scrolls": 3},
                               "lose": {"text": "He lays the last stone and lectures you on "
                                                "load-bearing for an hour.",
                                        "buff": ["becalmed", 1]}}}},
         {"label": "Admire the model", "stakes": "safe",
          "outcome": {"text": "'Thank you! It will be finished in only forty years.'"}},
     ]},

    # ── INSTANT ─────────────────────────────────────────────────────────────
    {"id": "buried_amphora", "stage": D, "kind": "instant", "art": "amphorae",
     "where": ["sea"], "weight": 3,
     "title": "Something Under the Sand",
     "text": "Your foot strikes something hard. You dig.",
     "roll": [[3, {"text": "An amphora of old coin, sealed with wax.", "scrolls": 2}],
              [2, {"text": "A jar of resin and linen. A caravan's repair kit.",
                   "item": "planks"}],
              [1, {"text": "A tortoise, furious at being dug up.", "hull": -1}],
              [2, {"text": "A sandal. Just the one. It feels lucky somehow.",
                   "buff": ["fortune", 1]}]]},

    {"id": "camel_spit", "stage": D, "kind": "instant", "art": "camel",
     "where": ["sea", "haven"], "weight": 2,
     "title": "Spat On by a Passing Camel",
     "text": "A camel trotting the other way spits at you, accurately, from "
             "twenty paces.",
     "roll": [[2, {"text": "Inside the spit — you look closer, grimly — a coin.",
                   "scrolls": 1}],
              [1, {"text": "You spend the next hour cleaning up and sulking.",
                   "buff": ["becalmed", 1]}],
              [1, {"text": "Cool and refreshing, honestly, in this heat.", "hull": 1}]]},

    {"id": "graffiti", "stage": D, "kind": "instant", "art": "scribe",
     "where": ["sea", "islet"], "weight": 2,
     "title": "Ancient Graffiti",
     "text": "Someone has carved into a rock, three thousand years ago: 'NEBKA "
             "WAS HERE. NEBKA IS LOST. GO LEFT.'",
     "roll": [[2, {"text": "You go left. Nebka was right.", "buff": ["fair_wind", 1]}],
              [1, {"text": "Under it, smaller: 'NEBKA'S SAVINGS, BURIED HERE.'",
                   "scrolls": 2}],
              [1, {"text": "You go left. Nebka was wrong. Nebka is probably still out "
                           "here somewhere.", "buff": ["becalmed", 1]}]]},

    {"id": "shade_palm", "stage": D, "kind": "instant", "art": "oasis",
     "where": ["sea", "haven", "islet"], "weight": 2,
     "title": "A Single Generous Palm",
     "text": "One palm tree, all alone, casting exactly enough shade for one "
             "tired captain.",
     "roll": [[2, {"text": "You nap in its shade and wake up mended.", "hull": 1}],
              [1, {"text": "A date drops into your open mouth. The gods are kind.",
                   "buff": ["fortune", 1]}]]},

    # ── TABLE events ────────────────────────────────────────────────────────
    {"id": "camel_race", "stage": D, "kind": "table", "art": "camel",
     "where": ["sea", "haven"], "weight": 3, "heavy": True, "when": {"players_min": 2},
     "title": "The Great Camel Race",
     "text": "A crier on a dune bellows that the Great Camel Race starts NOW, and "
             "every captain in the Reach may back a runner for free. The bookmaker "
             "chalks up the form: the favourite, the steady one, and Humphrey.",
     "table": {"kind": "race", "prompt": "Back one camel — secretly. The long shots pay more.",
               "params": {"field": [["Sandstorm Sue", "won the last three races", 5],
                                    ["Old Pharaoh", "never fast, never stops", 3],
                                    ["Humphrey", "has been seen running. Once.", 1]],
                          "legs": ["Off the start line", "Round the dead palm",
                                   "Over the last dune"]},
               "pays": [{"scrolls": 1},
                        {"scrolls": 2},
                        {"scrolls": 4, "buff": ["fortune", 1]}],
               "log": "the camel race"}},

    {"id": "caravanserai_auction", "stage": D, "kind": "table", "art": "auction",
     "where": ["sea", "haven"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "The Caravanserai Auction",
     "text": "At a ruined caravanserai, a merchant prince auctions off a dead "
             "explorer's kit: an Aegis Charm, a War Horn and a waterskin with a "
             "suspicious slosh. Every captain hears the gong.",
     "table": {"kind": "bid", "prompt": "Your sealed bid, in scrolls (0 to sit it out).",
               "params": {"cap": 8, "worth": 6},
               "prize": {"items": ["aegis_charm", "horn"], "hull": 1},
               "log": "the caravanserai auction"}},

    {"id": "mirage_vote", "stage": D, "kind": "table", "art": "mirage",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "A Mirage Everyone Can See",
     "text": "The heat bends the horizon and every captain in the Reach sees the "
             "same three wonders shimmering at once. Nobody can agree which is "
             "real. The fleet will have to vote on it.",
     "table": {"kind": "vote", "prompt": "Which shimmer does the fleet walk toward?",
               "choices": [
                   {"label": "The palace of cool marble",
                    "outcome": {"text": "It is a real ruin with real shade. Everyone "
                                        "rests.", "hull": 1}},
                   {"label": "The lake full of boats",
                    "outcome": {"text": "It is sand. A lot of sand. Everyone is "
                                        "footsore.", "buff": ["becalmed", 1]}},
                   {"label": "The feast with dancing girls",
                    "outcome": {"text": "It is a goat with a bell. The goat is lucky, "
                                        "apparently.", "buff": ["fortune", 1]}}],
               "log": "the shared mirage"}},

    {"id": "date_basket", "stage": D, "kind": "table", "art": "oasis",
     "where": ["sea", "haven", "islet"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Date-Seller's Basket",
     "text": "A date-seller balances a basket on her head and challenges the "
             "whole Reach: 'Closest guess wins the basket AND three scrolls! "
             "More than forty dates, fewer than a hundred and twenty.'",
     "table": {"kind": "guess", "prompt": "How many dates in the basket?",
               "params": {"range": [40, 120]},
               "prize": {"scrolls": 3}, "log": "the date basket"}},

    {"id": "dune_paths", "stage": D, "kind": "table", "art": "paths",
     "where": ["sea"], "weight": 2, "heavy": True, "when": {"players_min": 2},
     "title": "Three Ways Round the Great Dune",
     "text": "The trail splits round a dune the size of a mountain. A guide "
             "swears one way is a shortcut, one is the long way, and one is "
             "quicksand. He will not say which. He finds this very funny.",
     "table": {"kind": "lanes", "prompt": "Which way round? (secretly)",
               "lanes": {"shortcut": {"scrolls": 1, "buff": ["fair_wind", 1]},
                         "long way": {"scrolls": 1},
                         "quicksand": {"hull": -1}},
               "log": "the great dune"}},

    {"id": "scarab_pit", "stage": D, "kind": "table", "art": "beetle",
     "where": ["sea", "islet", "haven"], "weight": 2, "heavy": True,
     "when": {"players_min": 2},
     "title": "The Scarab Pit",
     "text": "A gambler has a pit, a golden scarab and a following. 'Ante a "
             "scroll! If the scarab rolls its ball into the gold hole, every brave "
             "soul gets three back!' The scarab looks bored.",
     "table": {"kind": "gamble", "prompt": "Ante one scroll — or stay out.",
               "params": {"ante": 1}, "odds": 0.5,
               "win": {"scrolls": 3}, "hit_text": "The scarab rolls it straight in!",
               "miss_text": "The scarab rolls its ball home and goes to sleep.",
               "log": "the scarab pit"}},

    # ── WORLD meetings (fired only by meeting the entity) ───────────────────
    {"id": "meet_caravan", "stage": D, "kind": "game", "art": "caravan",
     "where": ["sea"], "world": True,
     "title": "The Salt Caravan",
     "text": "A string of camels piled high with salt, rugs and pots plods out "
             "of the shimmer. The caravan master raises a hand. 'Water? Wares? "
             "Or are you the kind who haggles?'",
     "options": [
         {"label": "Buy water and dates", "stakes": "−2 scrolls · +3 Health",
          "requires": {"scrolls": 2, "hurt": True},
          "outcome": {"text": "The best meal you have had in days.", "scrolls": -2, "hull": 3}},
         {"label": "Haggle for a salt-block", "stakes": "a haggle · up to +4",
          "outcome": {"text": "'Ha! A haggler. Name your price.'",
                      "game": {"kind": "haggle", "params": {"range": [1, 12], "patience": 4},
                               "score": [[1, {"text": "Dear, but salt is salt. You sell "
                                                      "it on.", "scrolls": 1}],
                                         [3, {"text": "A sharp deal. The salt sells high.",
                                              "scrolls": 2}],
                                         [4, {"text": "His floor price exactly. He laughs "
                                                      "and gives you a horn as well.",
                                              "scrolls": 3, "item": "horn"}]],
                               "lose": {"text": "'Too slow, friend. The caravan moves on.'"}}}},
         {"label": "Ride along a while", "stakes": "carried toward the haven",
          "outcome": {"text": "You ride on top of the salt, swaying and content.",
                      "move": {"toward": "haven", "steps": 3}}},
         {"label": "Wave them past", "stakes": "safe",
          "outcome": {"text": "The bells fade into the dunes."}},
     ]},

    {"id": "meet_sandstorm", "stage": D, "kind": "choice", "art": "sandstorm",
     "where": ["sea"], "world": True, "hostile": True,
     "title": "The Wandering Sandstorm",
     "text": "The sky goes brown. A wall of sand as tall as a temple rolls over "
             "the dune and swallows you whole. You cannot see your own hand.",
     "options": [
         {"label": "Let it carry you", "stakes": "scattered somewhere · a gamble",
          "roll": [[1, {"text": "It spins you round and drops you — somewhere else.",
                        "move": {"toward": "random", "steps": 4}}],
                   [1, {"text": "It drops you somewhere else, with a stranger's purse "
                                "in your lap.", "move": {"toward": "random", "steps": 3},
                        "scrolls": 2}]]},
         {"label": "Wrap your face and push on", "stakes": "−1 Health",
          "outcome": {"text": "It scours you raw, but you keep your road.", "hull": -1}},
         {"label": "Hunker down and wait", "stakes": "Becalmed for 2 rolls",
          "outcome": {"text": "You dig yourself out an hour later, gritty everywhere.",
                      "buff": ["becalmed", 2]}},
     ]},

    {"id": "meet_mirage", "stage": D, "kind": "choice", "art": "mirage",
     "where": ["sea"], "world": True,
     "title": "The Oasis That Might Be There",
     "text": "Palms, a pool, the glint of water — exactly where the map says "
             "there is nothing. It shimmers a little too much. Or not quite enough.",
     "options": [
         {"label": "Run in and drink", "stakes": "a gamble",
          "roll": [[1, {"text": "It is REAL. Cold water, deep shade, a fallen purse.",
                        "hull": 2, "scrolls": 1}],
                   [1, {"text": "A mouthful of hot sand. It was never there.",
                        "buff": ["becalmed", 1], "remove_world": True}]]},
         {"label": "Throw a pebble in first", "stakes": "a careful look · Fortune",
          "outcome": {"text": "The pebble plinks. Or does it? You decide the gods are "
                              "testing you, and pass the test by being sensible.",
                      "buff": ["fortune", 1]}},
         {"label": "Trust the map and walk on", "stakes": "safe",
          "outcome": {"text": "Behind you, something that sounds like a fountain laughs."}},
     ]},

    {"id": "meet_beetle", "stage": D, "kind": "choice", "art": "beetle",
     "where": ["sea"], "world": True,
     "title": "A Dung-Beetle With a Golden Ball",
     "text": "A beetle the size of a shield is rolling a ball across the trail. "
             "The ball glints. It is, unmistakably, gold. The beetle is, "
             "unmistakably, not sharing.",
     "options": [
         {"label": "Help it push", "stakes": "+2 scrolls",
          "outcome": {"text": "Together you roll it over the dune. The beetle, touched, "
                              "breaks you off a piece.", "scrolls": 2}},
         {"label": "Grab the ball", "stakes": "a gamble",
          "roll": [[1, {"text": "You wrestle it free! It is gold leaf over… well. You "
                                "keep the leaf.", "scrolls": 3, "remove_world": True}],
                   [1, {"text": "The beetle wins. Beetles always win. You are bruised "
                                "and sticky.", "hull": -1}]]},
         {"label": "Bow to the sacred scarab", "stakes": "Fortune's Favour",
          "outcome": {"text": "It pauses, waves a leg, and rolls on. You feel blessed.",
                      "buff": ["fortune", 1]}},
     ]},
]

WORLD = [
    {"id": "caravan", "bot": "shop", "stage": D, "title": "The Salt Caravan", "art": "caravan",
     "text": "Camels laden with salt and wares. Walk onto its stop to trade or haggle.",
     "model": "caravan", "rounds": 7, "moves": 1, "where": "sea", "radius": 0,
     "weight": 4, "meet": "meet_caravan", "log": "camel bells on the dunes",
     "gone": "plods over the horizon"},
    {"id": "sandstorm", "bot": "shun", "stage": D, "title": "A Wandering Sandstorm", "art": "sandstorm",
     "text": "Whoever lands on it or beside it is caught — and maybe scattered.",
     "model": "sandstorm", "rounds": 5, "moves": 1, "where": "sea", "radius": 1,
     "weight": 3, "meet": "meet_sandstorm", "log": "a brown wall rises on the dunes",
     "gone": "blows itself out"},
    {"id": "mirage", "bot": "curious", "stage": D, "title": "A Shimmering Oasis", "art": "mirage",
     "text": "An oasis that may or may not be real. Walk onto its stop to find out.",
     "model": "mirage", "rounds": 5, "moves": 0, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_mirage", "log": "palms shimmer where no palms should be",
     "gone": "wavers and is gone"},
    {"id": "beetle", "bot": "seek", "stage": D, "title": "The Golden Dung-Beetle", "art": "beetle",
     "text": "A giant scarab rolling a ball of gold along the trail. Catch it up.",
     "model": "beetle", "rounds": 6, "moves": 1, "where": "sea", "radius": 0,
     "weight": 3, "meet": "meet_beetle", "log": "something golden rolls across the sand",
     "gone": "rolls its ball into a burrow"},
]

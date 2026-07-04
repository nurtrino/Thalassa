"""Build a labelled contact sheet from one or more state files.
   python meshy_contact.py OUT.png state1.json [state2.json ...]"""
import json, os, sys, urllib.request
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "samples", "gallery")
os.makedirs(CACHE, exist_ok=True)

out = sys.argv[1]
states = sys.argv[2:]
items = []
for s in states:
    d = json.load(open(os.path.join(HERE, s)))
    for mid, e in d["models"].items():
        if e.get("thumb"):
            items.append((mid, e["thumb"]))
items.sort()

CELL, PAD, LBL, COLS = 220, 6, 24, 6
rows = (len(items) + COLS - 1) // COLS
W = COLS * (CELL + PAD) + PAD
H = rows * (CELL + LBL + PAD) + PAD + 34
sheet = Image.new("RGB", (W, H), (22, 22, 26))
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("arialbd.ttf", 15)
    big = ImageFont.truetype("arialbd.ttf", 22)
except Exception:
    font = big = ImageFont.load_default()
draw.text((PAD + 4, 8), f"{os.path.basename(out)} — {len(items)} models", (240, 220, 160), font=big)

for i, (label, url) in enumerate(items):
    cache = os.path.join(CACHE, f"{label}.png")
    if not os.path.exists(cache):
        try: urllib.request.urlretrieve(url, cache)
        except Exception as ex: print("skip", label, ex); continue
    try: im = Image.open(cache).convert("RGB").resize((CELL, CELL))
    except Exception: continue
    r, c = divmod(i, COLS)
    x = PAD + c * (CELL + PAD); y = 34 + PAD + r * (CELL + LBL + PAD)
    sheet.paste(im, (x, y))
    draw.text((x + 3, y + CELL + 3), label, (225, 225, 225), font=font)

sheet.save(os.path.join(HERE, out))
print("wrote", out, sheet.size)

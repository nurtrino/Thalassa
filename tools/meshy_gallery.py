"""
Build a labelled contact-sheet montage of every Meshy render, pulling the
thumbnail URLs recorded in the two state files. Output: samples/gallery.png
"""
import json
import os
import urllib.request
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SAMP = os.path.join(HERE, "samples", "gallery")
os.makedirs(SAMP, exist_ok=True)

STATES = [
    ("creature", os.path.join(HERE, ".meshy_state.json")),
    ("structure", os.path.join(HERE, ".meshy_structures_state.json")),
]

items = []   # (label, kind, thumb_url)
for kind, path in STATES:
    if not os.path.exists(path):
        continue
    d = json.load(open(path))
    for mid, e in d["models"].items():
        if e.get("thumb"):
            items.append((mid, kind, e["thumb"]))

# order: structures first (landmarks), then creatures alphabetically
items.sort(key=lambda t: (t[1] != "structure", t[0]))

CELL, PAD, LBL = 240, 8, 26
COLS = 7
rows = (len(items) + COLS - 1) // COLS
W = COLS * (CELL + PAD) + PAD
H = rows * (CELL + LBL + PAD) + PAD + 40
sheet = Image.new("RGB", (W, H), (18, 18, 20))
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("arialbd.ttf", 16)
    big = ImageFont.truetype("arialbd.ttf", 24)
except Exception:
    font = big = ImageFont.load_default()

draw.text((PAD + 4, 10), f"THALASSA × Meshy — {len(items)} renders", (240, 220, 160), font=big)

for i, (label, kind, url) in enumerate(items):
    cache = os.path.join(SAMP, f"{label}.png")
    if not os.path.exists(cache):
        try:
            urllib.request.urlretrieve(url, cache)
        except Exception as ex:
            print("skip", label, ex)
            continue
    try:
        im = Image.open(cache).convert("RGB").resize((CELL, CELL))
    except Exception:
        continue
    r, c = divmod(i, COLS)
    x = PAD + c * (CELL + PAD)
    y = 40 + PAD + r * (CELL + LBL + PAD)
    sheet.paste(im, (x, y))
    col = (150, 210, 255) if kind == "structure" else (230, 230, 230)
    draw.text((x + 4, y + CELL + 4), label, col, font=font)

out = os.path.join(HERE, "samples", "gallery.png")
sheet.save(out)
print("wrote", out, sheet.size)

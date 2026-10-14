"""Render `assets/acm-icon.svg` into the bitmap sizes the icon sets are assembled from.

Edge could rasterise this and does render the README banner — but its headless screenshot ignored
`--window-size` here and returned the desktop work area instead, which turned a 16px favicon into a
746x483 PNG. That was caught only because `build-icon.py` refuses a bitmap claiming a size it does
not have, which is the entire reason that check exists.

A polyline is a few numbers per vertex, so it is drawn here instead: Pillow at 4x, then one LANCZOS
reduction — the supersampling an icon wants anyway, and it produces exact pixel sizes instead of
whatever a browser decides. The geometry is **read out of the SVG** rather than repeated, because
two copies of a set of coordinates drift apart, and the copy that drifts is always the one nobody
is looking at.
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SVG = ROOT / "assets" / "acm-icon.svg"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build" / "acm-iconset"

# The names `build-icon.py` expects. It derives 24, 48, 64 and 256 from the 512 by halving.
SIZES = {
    "mark-16.png": 16,
    "mark-32.png": 32,
    "mark-128.png": 128,
    "mark-144.png": 144,
    "mark-512.png": 512,
}
SUPERSAMPLE = 4

if not SVG.exists():
    raise SystemExit(f"no mark to render at {SVG}")

text = SVG.read_text(encoding="utf-8")
view = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', text)
points = re.search(r'points="([^"]+)"', text)
stroke = re.search(r'stroke-width="([\d.]+)"', text)
colour = re.search(r'stroke="(#[0-9a-fA-F]{6})"', text)
if not (view and points and stroke and colour):
    raise SystemExit(f"{SVG.name} must carry a viewBox, a points= polyline, a stroke-width and a hex stroke")

view_width, view_height = float(view.group(1)), float(view.group(2))
if view_width != view_height:
    raise SystemExit(f"the mark is rendered square, but its viewBox is {view_width}x{view_height}")
vertices = [tuple(float(value) for value in pair.split(",")) for pair in points.group(1).split()]
width = float(stroke.group(1))
hexcode = colour.group(1)
rgb = tuple(int(hexcode[index : index + 2], 16) for index in (1, 3, 5)) + (255,)

OUT.mkdir(parents=True, exist_ok=True)
print(f"mark     {SVG.name}  {len(vertices)} vertices, stroke {width:g}, {hexcode}")

for name, size in SIZES.items():
    big = size * SUPERSAMPLE
    scale = big / view_width
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scaled = [(x * scale, y * scale) for x, y in vertices]
    pen = max(1, round(width * scale))
    # joint="curve" rounds the corners; the caps need drawing, because a polyline has square ends
    # and the mark's whole point is that no corner or end is sharp enough to vanish when blurred.
    draw.line(scaled, fill=rgb, width=pen, joint="curve")
    radius = pen / 2
    for x, y in (scaled[0], scaled[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=rgb)
    image.resize((size, size), Image.Resampling.LANCZOS).save(OUT / name)
    print(f"  {name:<30} {size}x{size}")

print(f"wrote    {OUT}")

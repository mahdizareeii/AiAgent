"""Render Free Local Agent's code-native monogram into desktop icon formats.

Optional maintainer tool: Python 3 + Pillow. Generated assets are committed, so
packaging and end users do not need Pillow. Keep geometry aligned with free-local-agent.svg.
"""
from pathlib import Path
import math
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
assets = root / "assets" / "branding"
svg = ET.parse(assets / "free-local-agent.svg").getroot()
ns = {"s": "http://www.w3.org/2000/svg"}
mark = svg.find("s:path", ns)
assert mark is not None and mark.attrib["d"] == "M8 18V6h9M8 12h7", "Update the icon renderer when the monogram geometry changes."

# Supersampling preserves the thin orbit and rounded line ends at small sizes.
sample = 2
image = Image.new("RGBA", (1024 * sample, 1024 * sample), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle(tuple(v * sample for v in (42, 42, 982, 982)), radius=210 * sample,
                       fill="#0b101b", outline="#253449", width=3 * sample)
scale = 29 * sample
origin = 164 * sample

def point(x, y):
    return (origin + x * scale, origin + y * scale)

accent = svg.attrib["stroke"]
orbit = svg.find("s:ellipse", ns)
assert orbit is not None and orbit.attrib["transform"] == "rotate(-35 12 12)"
cx, cy, rx, ry = (float(orbit.attrib[key]) for key in ("cx", "cy", "rx", "ry"))
angle = math.radians(-35)
outer, inner = [], []
half_stroke = float(orbit.attrib["stroke-width"]) / 2
for index in range(361):
    phase = math.radians(index)
    x, y = rx * math.cos(phase), ry * math.sin(phase)
    nx, ny = math.cos(phase) / rx, math.sin(phase) / ry
    normal = math.hypot(nx, ny)
    nx, ny = nx / normal * half_stroke, ny / normal * half_stroke
    for outline, direction in [(outer, 1), (inner, -1)]:
        px, py = x + direction * nx, y + direction * ny
        outline.append(point(cx + px * math.cos(angle) - py * math.sin(angle),
                             cy + px * math.sin(angle) + py * math.cos(angle)))
layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
orbit_draw = ImageDraw.Draw(layer)
rgb = tuple(int(accent[i:i + 2], 16) for i in (1, 3, 5))
orbit_draw.polygon(outer, fill=(*rgb, round(255 * float(orbit.attrib["opacity"])) ))
orbit_draw.polygon(inner, fill=(0, 0, 0, 0))
image = Image.alpha_composite(image, layer)
draw = ImageDraw.Draw(image)
width = round(float(svg.attrib["stroke-width"]) * scale)
radius = width / 2
for vertices in [[(8, 18), (8, 6), (17, 6)], [(8, 12), (15, 12)]]:
    coords = [point(x, y) for x, y in vertices]
    draw.line(coords, fill=accent, width=width, joint="curve")
    for x, y in coords:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=accent)
dot = svg.find("s:circle", ns)
assert dot is not None
x, y = point(float(dot.attrib["cx"]), float(dot.attrib["cy"]))
r = float(dot.attrib["r"]) * scale
draw.ellipse((x - r, y - r, x + r, y + r), fill=accent)
image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
image.save(assets / "free-local-agent.png", optimize=True)
image.save(assets / "free-local-agent.icns")
image.save(assets / "free-local-agent.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("Generated assets/branding/free-local-agent.png, free-local-agent.icns and free-local-agent.ico")

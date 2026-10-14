"""Render Free Local Agent's local-spark orbit mark into desktop icon formats.

Maintainer tool only: Python 3 + Pillow are needed to regenerate assets. The
PNG, ICNS, and ICO are committed so packaged users need no Pillow.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
assets = root / "assets" / "branding"
S = 4
size = 1024 * S
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((42*S, 42*S, 982*S, 982*S), radius=215*S, fill="#10243f", outline="#376a94", width=4*S)
# Two soft orbit strokes make the mark readable when reduced to dock size.
orbit = Image.new("RGBA", image.size, (0, 0, 0, 0))
od = ImageDraw.Draw(orbit)
od.ellipse((190*S, 315*S, 834*S, 710*S), outline="#55d6c3", width=10*S)
od.ellipse((265*S, 245*S, 760*S, 775*S), outline=(85, 214, 195, 115), width=4*S)
orbit = orbit.rotate(-32, resample=Image.Resampling.BICUBIC, center=(512*S, 512*S))
image = Image.alpha_composite(image, orbit)
draw = ImageDraw.Draw(image)
# Four-point local spark.
points = [(512*S,176*S),(562*S,462*S),(848*S,512*S),(562*S,562*S),(512*S,848*S),(462*S,562*S),(176*S,512*S),(462*S,462*S)]
draw.polygon(points, fill="#f6d365")
draw.ellipse((496*S,496*S,528*S,528*S), fill="#fff2b2")
draw.ellipse((745*S,210*S,785*S,250*S), fill="#55d6c3")
image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
image.save(assets / "free-local-agent.png", optimize=True)
image.save(assets / "free-local-agent.icns")
image.save(assets / "free-local-agent.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print("Generated assets/branding/free-local-agent.png, free-local-agent.icns and free-local-agent.ico")

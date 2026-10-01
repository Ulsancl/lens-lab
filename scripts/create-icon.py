"""Draw Lens Lab's original optical-bench icon; optional Pillow authoring tool."""
from pathlib import Path
from math import sin, pi
from PIL import Image, ImageDraw

target = Path(__file__).resolve().parents[1] / 'desktop' / 'assets'
target.mkdir(parents=True, exist_ok=True)
scale = 3
image = Image.new('RGBA', (512 * scale, 512 * scale))
draw = ImageDraw.Draw(image)
def xy(values): return tuple(round(v * scale) for v in values)
def line(points, fill, width): draw.line(xy(points), fill, width * scale, joint='curve')
draw.rounded_rectangle(xy((8, 8, 504, 504)), 98 * scale, '#102438', '#3c5c74', 7 * scale)
# Optical rail and two independently recognizable supports.
draw.rounded_rectangle(xy((63, 381, 449, 405)), 8 * scale, '#718797', '#c3dbe7', 3 * scale)
for x in range(86, 443, 28): line((x, 387, x, 398), '#283f50', 3)
line((105, 258, 105, 380), '#8fa8b7', 15)
line((254, 326, 254, 380), '#8fa8b7', 15)
line((424, 265, 424, 380), '#8fa8b7', 15)
# Three schematic rays meet on the screen after passing the lens.
for y in (160, 235, 310):
    line((82, y, 253, y, 424, 235), '#ffd28a', 8)
# A biconvex shape, drawn from two analytic sides (not an existing logo).
left = [(254 - 33 * sin(pi * i / 60), 117 + 236 * i / 60) for i in range(61)]
right = [(254 + 33 * sin(pi * i / 60), 117 + 236 * i / 60) for i in reversed(range(61))]
draw.polygon([xy(point) for point in left + right], fill='#69cede')
draw.line([xy(point) for point in left + right + [left[0]]], fill='#d3f9fa', width=5 * scale, joint='curve')
line((244, 152, 235, 202, 235, 258), '#b8f0f5', 5)
draw.rounded_rectangle(xy((68, 139, 107, 331)), 9 * scale, '#263e51', '#9ac8d5', 4 * scale)
line((87, 294, 87, 187), '#6bdeeb', 10)
draw.polygon([xy(p) for p in [(87, 162), (69, 191), (105, 191)]], fill='#6bdeeb')
draw.rounded_rectangle(xy((414, 145, 438, 326)), 5 * scale, '#edf6f2', '#aac5cf', 3 * scale)
draw.ellipse(xy((415, 224, 436, 246)), '#ffc77a')
image = image.resize((512, 512), Image.Resampling.LANCZOS)
image.save(target / 'app.png')
image.save(target / 'app.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
print('Created Lens Lab PNG/ICO assets.')

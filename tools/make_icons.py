"""Draw the AniShelf app icon (the Sakura bookmark) as PNG and ICO files.

Windows uses real image files for the taskbar and window icon, not the SVG inside the page.
This script draws the logo with Pillow and saves every size the app needs into static/icons/.

Run it again only if the logo changes:
    .venv\\Scripts\\python.exe tools\\make_icons.py
(Pillow is only needed for this script, not for running the app.)
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
VERMILION = (255, 90, 54, 255)
GROUND = (0, 0, 0, 255)
SUPERSAMPLE = 8  # draw 8x bigger, then shrink: smooth edges without anti-aliasing tricks


def petal_outline(cx: float, cy: float, angle_deg: float, steps: int = 40) -> list[tuple[float, float]]:
    """Points around one petal: an ellipse (3.6 wide, 5 tall) sitting 7 units above the centre,
    turned by angle_deg around the centre. Pillow can't draw rotated ellipses, so we
    walk around the ellipse ourselves and rotate each point (a 2D rotation matrix)."""
    turn = math.radians(angle_deg)
    points = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x, y = 3.6 * math.cos(t), -7 + 5 * math.sin(t)          # the petal before turning
        rx = x * math.cos(turn) - y * math.sin(turn)            # rotate around the centre
        ry = x * math.sin(turn) + y * math.cos(turn)
        points.append((cx + rx, cy + ry))
    return points


def draw_icon(size: int) -> Image.Image:
    """One square icon. The logo is designed on a 64x64 grid (same as the SVG in index.html)."""
    big = size * SUPERSAMPLE
    scale = big / 64  # how many big-pixels one design unit is

    def p(x: float, y: float) -> tuple[float, float]:
        return x * scale, y * scale

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 1. Black rounded square, so the icon reads on light and dark taskbars alike.
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=14 * scale, fill=GROUND)

    # 2. The bookmark ribbon: rounded top, a V-notch at the bottom.
    left, right, top, bottom, notch, radius = 12, 52, 6, 58, 46, 4
    d.rounded_rectangle([*p(left, top), *p(right, notch)], radius=radius * scale, fill=VERMILION)
    d.polygon([p(left, notch - 2), p(right, notch - 2), p(right, bottom), p(32, notch), p(left, bottom)],
              fill=VERMILION)

    # 3. The blossom: five oval petals around a centre, punched out in the ground colour,
    #    then a small vermilion dot in the middle (same shapes as the SVG logo).
    cx, cy = 32, 25
    for k in range(5):
        d.polygon([p(x, y) for x, y in petal_outline(cx, cy, angle_deg=72 * k)], fill=GROUND)
    d.ellipse([*p(cx - 3.2, cy - 3.2), *p(cx + 3.2, cy + 3.2)], fill=GROUND)
    d.ellipse([*p(cx - 2, cy - 2), *p(cx + 2, cy + 2)], fill=VERMILION)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 180, 192, 256, 512):
        draw_icon(size).save(OUT / f"icon-{size}.png")
    # A .ico file holds several sizes; Windows picks the best one for each place it shows it.
    draw_icon(256).save(OUT / "favicon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("Icons written to", OUT)


if __name__ == "__main__":
    main()

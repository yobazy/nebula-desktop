"""Draw the DMG window's background: the app on the left, Applications on the
right, an arrow between them. Writes a 1x and a 2x PNG and combines them
into the multi-resolution TIFF Finder uses on Retina screens.

    python3 scripts/dmg-background.py   # then rebuild: npm run tauri build

Positions must match bundle.macOS.dmg in src-tauri/tauri.conf.json."""

import math
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 660, 400
APP = (170, 180)  # icon centers, as in tauri.conf.json
APPS = (490, 180)
OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

ACCENT = (61, 91, 217)
INK = (85, 94, 114)


def font(size, bold=False):
    for path in (
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size, index=1 if bold and path.endswith(".ttc") else 0)
        except OSError:
            continue
    return ImageFont.load_default()


def draw(scale):
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h))
    # A soft vertical wash, near-white to a faint periwinkle.
    top, bottom = (248, 249, 253), (233, 237, 249)
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c

    # The nebula: two blurred glows, low enough to keep Finder's labels readable.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    for (cx, cy, r, color) in (
        (0.3, 0.35, 0.34, (157, 180, 255, 70)),
        (0.72, 0.62, 0.3, (196, 155, 255, 55)),
    ):
        g.ellipse([(cx - r) * w, (cy - r) * h * 1.6, (cx + r) * w, (cy + r) * h * 1.6], fill=color)
    glow = glow.filter(ImageFilter.GaussianBlur(60 * scale))
    img.paste(glow, (0, 0), glow)

    d = ImageDraw.Draw(img, "RGBA")
    rng = random.Random(7)
    for _ in range(28):
        x, y = rng.uniform(0, w), rng.uniform(0, h * 0.8)
        r = rng.choice((1, 1, 1.5)) * scale
        d.ellipse([x - r, y - r, x + r, y + r], fill=(120, 132, 180, rng.randint(40, 90)))

    # The arrow: a gentle arc from the app over to Applications.
    x0, x1, y = (APP[0] + 78) * scale, (APPS[0] - 78) * scale, APP[1] * scale
    lift = 22 * scale
    pts = []
    for i in range(41):
        t = i / 40
        pts.append((x0 + (x1 - x0) * t, y - math.sin(math.pi * t) * lift))
    d.line(pts, fill=ACCENT + (230,), width=round(3.2 * scale), joint="curve")
    # Head, pointing along the arc's last segment.
    (ax, ay), (bx, by) = pts[-2], pts[-1]
    ang = math.atan2(by - ay, bx - ax)
    size = 13 * scale
    head = [
        (bx + math.cos(ang) * size * 0.35, by + math.sin(ang) * size * 0.35),
        (bx - math.cos(ang - 0.5) * size, by - math.sin(ang - 0.5) * size),
        (bx - math.cos(ang + 0.5) * size, by - math.sin(ang + 0.5) * size),
    ]
    d.polygon(head, fill=ACCENT + (240,))

    title = "Drag Nebula Desktop into Applications"
    f = font(15 * scale, bold=True)
    tw = d.textlength(title, font=f)
    d.text(((w - tw) / 2, 312 * scale), title, font=f, fill=INK)
    sub = "Then open it from Applications. It sets up nebula for you."
    f2 = font(12 * scale)
    sw = d.textlength(sub, font=f2)
    d.text(((w - sw) / 2, 338 * scale), sub, font=f2, fill=(127, 136, 156))
    return img


one = os.path.join(OUT, "dmg-background.png")
two = os.path.join(OUT, "dmg-background@2x.png")
draw(1).save(one)
draw(2).save(two)
tiff = os.path.join(OUT, "dmg-background.tiff")
subprocess.run(["tiffutil", "-cathidpicheck", one, two, "-out", tiff], check=True, capture_output=True)
print("wrote", one, two, tiff)

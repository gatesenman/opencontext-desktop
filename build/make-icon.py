#!/usr/bin/env python3
"""Generates the app icon (build/icon.png, 1024px) and the tray icon
(src/assets/tray.png, 32px).

Design: a deep-blue rounded square (the OpenContext / openloomi palette),
holding a white "memory card" with text lines and an orange bookmark —
"a note this machine remembers for you"."""

import os

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
BLUE_TOP = (25, 74, 158)
BLUE_BOTTOM = (13, 48, 106)
CARD = (255, 255, 255)
LINE = (66, 114, 193)
LINE_SOFT = (196, 212, 238)
ORANGE = (233, 122, 34)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_APP = os.path.join(HERE, "icon.png")
OUT_TRAY = os.path.join(HERE, "..", "src", "assets", "tray.png")


def rounded_gradient(size: int, radius: int) -> Image.Image:
    """Vertical blue gradient clipped to a rounded square."""
    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(int(BLUE_TOP[i] + (BLUE_BOTTOM[i] - BLUE_TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
    gradient.putalpha(mask)
    return gradient


def draw_card(image: Image.Image, box: tuple[float, float, float, float], scale: float) -> None:
    """White note card with an orange bookmark and blue text lines."""
    x0, y0, x1, y1 = box
    radius = int(scale * 0.07)

    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [x0 + scale * 0.015, y0 + scale * 0.03, x1 + scale * 0.015, y1 + scale * 0.03],
        radius=radius,
        fill=(4, 16, 40, 110),
    )
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(scale * 0.03)))

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=CARD)

    # Orange bookmark ribbon hanging from the card's top edge.
    bw = (x1 - x0) * 0.16
    bx = x1 - (x1 - x0) * 0.17 - bw
    bh = (y1 - y0) * 0.30
    draw.polygon(
        [(bx, y0), (bx + bw, y0), (bx + bw, y0 + bh), (bx + bw / 2, y0 + bh * 0.72), (bx, y0 + bh)],
        fill=ORANGE,
    )

    # Text lines: a bold title, then lighter body lines.
    pad = (x1 - x0) * 0.13
    lh = (y1 - y0) * 0.075
    ty = y0 + (y1 - y0) * 0.30
    widths = (0.48, 0.74, 0.74, 0.55)
    colors = (LINE, LINE_SOFT, LINE_SOFT, LINE_SOFT)
    for width, color in zip(widths, colors):
        draw.rounded_rectangle(
            [x0 + pad, ty, x0 + pad + (x1 - x0 - 2 * pad) * width, ty + lh],
            radius=lh / 2,
            fill=color,
        )
        ty += lh * 2.0


def make_app_icon() -> None:
    image = rounded_gradient(SIZE, radius=int(SIZE * 0.225))

    # Subtle top highlight so the tile doesn't look flat.
    highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(highlight).ellipse(
        [-SIZE * 0.25, -SIZE * 0.55, SIZE * 1.25, SIZE * 0.45], fill=(255, 255, 255, 26)
    )
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE, SIZE], radius=int(SIZE * 0.225), fill=255)
    highlight.putalpha(Image.composite(highlight.getchannel("A"), Image.new("L", (SIZE, SIZE), 0), mask))
    image.alpha_composite(highlight)

    draw_card(image, (SIZE * 0.22, SIZE * 0.20, SIZE * 0.78, SIZE * 0.80), SIZE)
    image.save(OUT_APP)
    print(f"wrote {OUT_APP}")


def make_tray_icon() -> None:
    """Tray icons must read at 16-22px, so render big and downscale."""
    big = 512
    image = rounded_gradient(big, radius=int(big * 0.24))
    draw_card(image, (big * 0.18, big * 0.16, big * 0.82, big * 0.84), big)
    image = image.resize((32, 32), Image.LANCZOS)
    image.save(OUT_TRAY)
    print(f"wrote {OUT_TRAY}")


if __name__ == "__main__":
    make_app_icon()
    make_tray_icon()

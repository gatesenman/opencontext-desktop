#!/usr/bin/env python3
"""Generates build/icon.png — a 1024px app icon (temporal graph glyph)."""

import math
import os

from PIL import Image, ImageDraw

SIZE = 1024
BG_OUTER = (14, 17, 22)
BG_INNER = (26, 32, 44)
ACCENT = (248, 213, 42)
EDGE = (110, 128, 155)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")


def rounded_background(draw: ImageDraw.ImageDraw) -> None:
    draw.rounded_rectangle([0, 0, SIZE, SIZE], radius=int(SIZE * 0.22), fill=BG_OUTER)
    inset = SIZE * 0.06
    draw.rounded_rectangle(
        [inset, inset, SIZE - inset, SIZE - inset],
        radius=int(SIZE * 0.18),
        fill=BG_INNER,
    )


def main() -> None:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    rounded_background(draw)

    center = (SIZE / 2, SIZE / 2)
    radius = SIZE * 0.29
    nodes = [
        (
            center[0] + radius * math.cos(math.radians(-90 + index * 72)),
            center[1] + radius * math.sin(math.radians(-90 + index * 72)),
        )
        for index in range(5)
    ]

    for index, node in enumerate(nodes):
        draw.line([center, node], fill=EDGE, width=int(SIZE * 0.014))
        draw.line([node, nodes[(index + 1) % 5]], fill=EDGE, width=int(SIZE * 0.01))

    for node in nodes:
        r = SIZE * 0.052
        draw.ellipse([node[0] - r, node[1] - r, node[0] + r, node[1] + r], fill=ACCENT)

    r = SIZE * 0.085
    draw.ellipse(
        [center[0] - r, center[1] - r, center[0] + r, center[1] + r],
        fill=ACCENT,
        outline=BG_INNER,
        width=int(SIZE * 0.012),
    )

    image.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

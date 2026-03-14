from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024


def _rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def _background() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE))
    pixels = image.load()
    top = (6, 18, 28)
    bottom = (8, 79, 86)

    for y in range(SIZE):
        t = y / (SIZE - 1)
        row = (
            int(top[0] * (1 - t) + bottom[0] * t),
            int(top[1] * (1 - t) + bottom[1] * t),
            int(top[2] * (1 - t) + bottom[2] * t),
            255,
        )
        for x in range(SIZE):
            pixels[x, y] = row

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    draw.ellipse((-140, -180, 620, 580), fill=(73, 222, 209, 110))
    draw.ellipse((380, 350, 1120, 1080), fill=(255, 190, 92, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    image = Image.alpha_composite(image, glow)

    vignette = Image.new("L", (SIZE, SIZE), 0)
    vdraw = ImageDraw.Draw(vignette)
    vdraw.ellipse((-90, -70, SIZE + 90, SIZE + 110), fill=255)
    vignette = ImageChops.invert(vignette.filter(ImageFilter.GaussianBlur(130)))
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 85))
    image = Image.alpha_composite(image, Image.merge("RGBA", (vignette, vignette, vignette, vignette)).convert("RGBA"))
    image = Image.alpha_composite(image, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)))
    image = Image.blend(image, shadow, 0.18)

    highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hdraw = ImageDraw.Draw(highlight)
    hdraw.rounded_rectangle((24, 24, SIZE - 24, SIZE - 24), radius=230, outline=(255, 255, 255, 30), width=3)
    image = Image.alpha_composite(image, highlight)

    mask = _rounded_mask(SIZE, 230)
    rounded = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rounded.paste(image, (0, 0), mask)
    return rounded


def _link_outline(width: int, height: int, stroke: int, color: tuple[int, int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = stroke // 2 + 8
    draw.rounded_rectangle(
        (pad, pad, width - pad, height - pad),
        radius=width // 2,
        outline=color,
        width=stroke,
    )
    return image


def _place_link(canvas: Image.Image, center: tuple[int, int], angle: float, color: tuple[int, int, int, int], shadow_alpha: int) -> None:
    link = _link_outline(350, 520, 96, color)
    shadow = _link_outline(350, 520, 112, (0, 0, 0, shadow_alpha)).filter(ImageFilter.GaussianBlur(24))

    rotated_shadow = shadow.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    rotated = link.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)

    sx = center[0] - rotated_shadow.width // 2
    sy = center[1] - rotated_shadow.height // 2 + 18
    canvas.alpha_composite(rotated_shadow, (sx, sy))

    x = center[0] - rotated.width // 2
    y = center[1] - rotated.height // 2
    canvas.alpha_composite(rotated, (x, y))


def _details(canvas: Image.Image) -> None:
    accent = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(accent)
    draw.ellipse((720, 224, 816, 320), fill=(255, 188, 81, 255))
    draw.ellipse((270, 700, 346, 776), fill=(73, 222, 209, 210))
    accent = accent.filter(ImageFilter.GaussianBlur(1))
    canvas.alpha_composite(accent)

    shine = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shine)
    sdraw.rounded_rectangle((144, 134, 880, 416), radius=160, fill=(255, 255, 255, 18))
    shine = shine.filter(ImageFilter.GaussianBlur(32))
    canvas.alpha_composite(shine)


def build_icon() -> Image.Image:
    icon = _background()
    _place_link(icon, (418, 576), -34, (245, 249, 252, 255), 58)
    _place_link(icon, (612, 448), -34, (65, 222, 210, 255), 78)
    _details(icon)
    return icon


def save_outputs(icon: Image.Image) -> None:
    icon.save(ROOT / "icon.png")
    icon.save(ROOT / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    public_icons = ROOT / "public" / "icons"
    public_icons.mkdir(parents=True, exist_ok=True)
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(public_icons / "icon-512.png")
    icon.resize((192, 192), Image.Resampling.LANCZOS).save(public_icons / "icon-192.png")


if __name__ == "__main__":
    save_outputs(build_icon())

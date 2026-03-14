from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024


def _rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def _background() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (14, 23, 31, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (36, 36, SIZE - 36, SIZE - 36),
        radius=230,
        outline=(33, 47, 58, 255),
        width=10,
    )

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


def _place_link(canvas: Image.Image, center: tuple[int, int], angle: float, color: tuple[int, int, int, int]) -> None:
    link = _link_outline(350, 520, 96, color)
    rotated = link.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)

    x = center[0] - rotated.width // 2
    y = center[1] - rotated.height // 2
    canvas.alpha_composite(rotated, (x, y))


def build_icon() -> Image.Image:
    icon = _background()
    _place_link(icon, (420, 582), -34, (243, 247, 251, 255))
    _place_link(icon, (606, 442), -34, (62, 214, 198, 255))
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

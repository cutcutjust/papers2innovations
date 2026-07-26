from pathlib import Path

from PIL import Image, ImageDraw


def render(size: int) -> Image.Image:
    scale = 4
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    unit = size * scale / 1024

    def box(values: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
        return tuple(round(value * unit) for value in values)

    draw.rounded_rectangle(box((64, 64, 960, 960)), radius=round(184 * unit), fill="#176849")
    line_width = max(1, round(34 * unit))
    draw.line(box((292, 692, 512, 512, 728, 298)), fill="#9BE2BF", width=line_width)
    for center in ((292, 692), (728, 298)):
        x, y = center
        draw.ellipse(box((x - 58, y - 58, x + 58, y + 58)), fill="#DDF7E9")

    star = [(512, 244), (566, 440), (764, 512), (566, 574), (512, 780), (450, 574), (252, 512), (450, 440)]
    draw.polygon([(round(x * unit), round(y * unit)) for x, y in star], fill="#FFFFFF")
    draw.ellipse(box((474, 474, 550, 550)), fill="#176849")
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    output = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "src-tauri" / "icons"
    output.mkdir(parents=True, exist_ok=True)
    for size, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
        render(size).save(output / name, "PNG")
    render(256).save(output / "icon.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()

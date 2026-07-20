"""Verify sphere preview is a side-by-side montage of N stripe gores."""

from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw

from distort import build_stripe_sphere_preview


def _make_stripe(path: Path, color: tuple[int, int, int], size: tuple[int, int] = (40, 200)) -> None:
    img = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(img)
    # Top marker (north / city) — white bar
    draw.rectangle([0, 0, size[0] - 1, 12], fill=(255, 255, 255))
    img.save(path, format="PNG")


def test_stripe_count_becomes_columns() -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        colors = [
            (40, 80, 200),
            (200, 40, 80),
            (40, 200, 80),
            (200, 180, 40),
            (120, 40, 200),
            (40, 180, 200),
        ]
        stripes = []
        for i, color in enumerate(colors):
            path = root / f"out-{i:02d}.png"
            _make_stripe(path, color)
            stripes.append(path)

        dest = root / "preview.jpg"
        build_stripe_sphere_preview(stripes, dest, max_edge=600, background_color="#e8eddb")

        out = Image.open(dest).convert("RGB")
        assert out.size[0] == out.size[1] * 2
        n = len(colors)
        col_w = out.size[0] // n
        # Sample each column centre — should match that stripe's colour (not all one blob).
        for i, color in enumerate(colors):
            x = col_w * i + col_w // 2
            y = out.size[1] // 2
            r, g, b = out.getpixel((x, y))
            assert abs(r - color[0]) < 40, f"col {i}: expected ~{color}, got {(r, g, b)}"
            assert abs(g - color[1]) < 40, f"col {i}: expected ~{color}, got {(r, g, b)}"
            assert abs(b - color[2]) < 40, f"col {i}: expected ~{color}, got {(r, g, b)}"


def test_twelve_stripes_width_divides() -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        stripes = []
        for i in range(12):
            path = root / f"out-{i:02d}.png"
            _make_stripe(path, (50 + i * 10, 80, 160))
            stripes.append(path)
        dest = root / "preview.jpg"
        build_stripe_sphere_preview(stripes, dest, max_edge=1200)
        out = Image.open(dest)
        assert out.size[0] % 12 == 0
        assert out.size[0] == out.size[1] * 2


if __name__ == "__main__":
    test_stripe_count_becomes_columns()
    test_twelve_stripes_width_divides()
    print("ok")

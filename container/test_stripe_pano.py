"""Verify ImageMagick DePolar sphere-preview unwrap (Rmax=-1, Background gaps)."""

from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw

from distort import build_depolar_sphere_preview


def test_depolar_scalloped_bottom_uses_background() -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        size = 200
        bg = (232, 237, 219)
        img = Image.new("RGB", (size, size), bg)
        draw = ImageDraw.Draw(img)
        cx = cy = size // 2
        draw.ellipse([cx - 70, cy - 70, cx + 70, cy + 70], fill=(40, 80, 200))
        draw.ellipse([cx - 18, cy - 18, cx + 18, cy + 18], fill=(255, 255, 255))
        source = root / "input-distorted.jpg"
        img.save(source, format="JPEG", quality=95)

        dest = root / "preview.jpg"
        build_depolar_sphere_preview(
            source, dest, max_edge=400, background_color="#e8eddb"
        )

        out = Image.open(dest).convert("RGB")
        assert out.size == (400, 200)
        r, g, b = out.getpixel((out.size[0] // 2, 2))
        assert min(r, g, b) > 180, f"top should be near-white centre, got {(r, g, b)}"

        w, h = out.size
        landish = 0
        for x in (w // 8, w // 4, 3 * w // 8, 5 * w // 8, 3 * w // 4, 7 * w // 8):
            r, g, b = out.getpixel((x, h - 2))
            if r > 180 and g > 180 and b > 160:
                landish += 1
        assert landish >= 4, f"expected scalloped bottom mostly background, got {landish}/6"


if __name__ == "__main__":
    test_depolar_scalloped_bottom_uses_background()
    print("ok")

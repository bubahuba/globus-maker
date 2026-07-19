"""Verify spherical_prewarp preserves center and compresses toward the middle."""

from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from distort import BARREL_INVERSE_ARGS, spherical_prewarp


def _make_marker_image(path: Path, size: int = 256) -> None:
    """White canvas with a red center block and a blue marker above center."""
    img = Image.new("RGB", (size, size), (255, 255, 255))
    cx = cy = size // 2
    for y in range(cy - 10, cy + 11):
        for x in range(cx - 10, cx + 11):
            img.putpixel((x, y), (255, 0, 0))
    # Mid-top marker — under center-compress this moves inward (larger y).
    marker_y = 32
    for x in range(cx - 8, cx + 9):
        for y in range(marker_y - 3, marker_y + 4):
            img.putpixel((x, y), (0, 0, 255))
    img.save(path, format="PNG")


def _find_blue_y(img: Image.Image, cx: int, y_max: int) -> int | None:
    for y in range(0, y_max):
        r, g, b = img.getpixel((cx, y))
        if b > 180 and r < 100 and g < 100:
            return y
    return None


def _red_half_width(img: Image.Image, cx: int, cy: int) -> int:
    width = 0
    for x in range(cx, img.size[0]):
        r, g, b = img.getpixel((x, cy))
        if r > 200 and g < 80 and b < 80:
            width = x - cx
        elif width:
            break
    return width


def test_center_preserved() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "map.png"
        _make_marker_image(path, 256)
        spherical_prewarp(path)

        out = Image.open(path).convert("RGB")
        assert out.size == (256, 256)
        cx = cy = 128
        r, g, b = out.getpixel((cx, cy))
        assert r > 200 and g < 80 and b < 80, f"center not preserved: {(r, g, b)}"


def test_center_shrinks() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "map.png"
        size = 256
        _make_marker_image(path, size)
        before = _red_half_width(Image.open(path).convert("RGB"), size // 2, size // 2)
        spherical_prewarp(path)

        out = Image.open(path).convert("RGB")
        after = _red_half_width(out, size // 2, size // 2)
        assert after < before, f"expected center to shrink ({before} → {after})"

        found_y = _find_blue_y(out, size // 2, size // 2)
        assert found_y is not None, "blue rim marker not found after warp"
        # Center-compress pulls mid-radius content inward (toward center → larger y).
        assert found_y > 32, f"expected marker to move inward (y>32), got y={found_y}"


def test_identity_coeffs_keep_size() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "map.png"
        _make_marker_image(path, 128)
        spherical_prewarp(path, barrel_args="0.0 0.0 0.0 1.0")
        out = Image.open(path)
        assert out.size == (128, 128)


if __name__ == "__main__":
    assert BARREL_INVERSE_ARGS
    test_center_preserved()
    test_center_shrinks()
    test_identity_coeffs_keep_size()
    print("ok")

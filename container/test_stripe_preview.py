"""Stripe preview uploads are downscaled; on-disk originals stay full size."""

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from distort import STRIPE_PREVIEW_MAX_HEIGHT, jpeg_preview_bytes


def test_jpeg_preview_fits_height_and_keeps_disk() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "out-00.jpg"
        Image.new("RGB", (720, 4000), (180, 140, 90)).save(path, format="JPEG", quality=90)
        before = path.stat().st_size
        before_bytes = path.read_bytes()

        preview = jpeg_preview_bytes(path, max_height=STRIPE_PREVIEW_MAX_HEIGHT)
        assert path.read_bytes() == before_bytes
        assert path.stat().st_size == before

        out = Image.open(BytesIO(preview))
        assert out.size[1] == STRIPE_PREVIEW_MAX_HEIGHT
        assert out.size[0] == int(round(720 * STRIPE_PREVIEW_MAX_HEIGHT / 4000))
        assert len(preview) < before


def test_jpeg_preview_skips_upscale() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "out-01.jpg"
        Image.new("RGB", (72, 400), (10, 20, 30)).save(path, format="JPEG", quality=90)
        preview = jpeg_preview_bytes(path, max_height=500)
        out = Image.open(BytesIO(preview))
        assert out.size == (72, 400)


if __name__ == "__main__":
    test_jpeg_preview_fits_height_and_keeps_disk()
    test_jpeg_preview_skips_upscale()
    print("ok")

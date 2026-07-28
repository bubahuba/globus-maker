"""Stripe JPEGs carry print density so 100% print matches designed cm size."""

import math
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from PIL.ExifTags import Base as ExifBase

from distort import (
    PRINT_DPI,
    PRINT_PX_PER_CM,
    draw_stripe_cut_line,
    print_dpi,
    print_size_cm,
    save_print_jpeg,
)


def test_print_dpi_matches_px_per_cm() -> None:
    x, y = print_dpi()
    assert abs(x - PRINT_DPI) < 1e-9
    assert abs(y - PRINT_DPI) < 1e-9
    assert abs(x - PRINT_PX_PER_CM * 2.54) < 1e-9


def test_print_size_cm_for_reference_globe() -> None:
    # 25 cm globe → pole-to-pole ~39.27 cm → 6283×1131 stripe at 160 px/cm
    from globe_readme import stripe_height_px

    h = stripe_height_px(25.0)
    w = round(2 * 0.09 * (12 / 12) * h)
    w_cm, h_cm = print_size_cm(w, h)
    assert abs(h_cm - (math.pi * 25 / 2)) < 0.01
    assert abs(w_cm - w / PRINT_PX_PER_CM) < 1e-9


def test_save_print_jpeg_writes_dpi_and_exif_cm() -> None:
    from globe_readme import stripe_height_px

    h = stripe_height_px(25.0)
    w = round(2 * 0.09 * (12 / 12) * h)
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "out-00.jpg"
        img = Image.new("RGB", (w, h), (200, 160, 100))
        save_print_jpeg(img, path, quality=90)

        out = Image.open(path)
        dpi = out.info.get("dpi")
        assert dpi is not None
        assert abs(dpi[0] - PRINT_DPI) < 0.6
        assert abs(dpi[1] - PRINT_DPI) < 0.6

        exif = out.getexif()
        assert exif.get(ExifBase.ResolutionUnit) == 3  # centimeters
        xres = exif.get(ExifBase.XResolution)
        yres = exif.get(ExifBase.YResolution)
        assert xres is not None and yres is not None
        assert abs(float(xres) - PRINT_PX_PER_CM) < 0.05
        assert abs(float(yres) - PRINT_PX_PER_CM) < 0.05

        w_in = out.size[0] / dpi[0]
        h_in = out.size[1] / dpi[1]
        assert abs(h_in * 2.54 - (math.pi * 25 / 2)) < 0.15
        assert abs(w_in * 2.54 - w / PRINT_PX_PER_CM) < 0.15


def test_cut_line_preserves_print_density() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "out-01.jpg"
        Image.new("RGB", (144, 800), (40, 80, 120)).save(path, format="JPEG", quality=90)
        draw_stripe_cut_line(path)
        out = Image.open(path)
        dpi = out.info.get("dpi")
        assert dpi is not None
        assert abs(dpi[0] - PRINT_DPI) < 0.6
        h_cm = out.size[1] / PRINT_PX_PER_CM
        assert abs(h_cm - 5.0) < 1e-9


if __name__ == "__main__":
    test_print_dpi_matches_px_per_cm()
    test_print_size_cm_for_reference_globe()
    test_save_print_jpeg_writes_dpi_and_exif_cm()
    test_cut_line_preserves_print_density()
    print("ok")

"""Pole caps sheet: north map circle + empty-fill circle on white."""

from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw

from distort import (
    NONA_MID_EDGE_Y_FRAC,
    POLE_CAP_DIAMETER_CM,
    POLE_CAP_ENLARGE,
    PRINT_PX_PER_CM,
    build_pole_caps,
    pole_cap_output_side_px,
    pole_cap_source_radius_px,
    pole_caps_canvas_size_px,
)


def test_output_side_matches_print_dpi() -> None:
    assert pole_cap_output_side_px(5.0) == 800
    assert pole_cap_output_side_px(POLE_CAP_DIAMETER_CM) == int(
        round(POLE_CAP_DIAMETER_CM * PRINT_PX_PER_CM)
    )


def test_canvas_holds_two_circles() -> None:
    side = pole_cap_output_side_px(5.0)
    w, h = pole_caps_canvas_size_px(5.0)
    assert h == side
    assert w > side * 2  # gap between circles
    assert w == side * 2 + int(round(0.25 * PRINT_PX_PER_CM))


def test_source_radius_matches_stripe_tip() -> None:
    """Source disk for exact (no enlarge) match equals top half of cap diameter."""
    map_size = 4000.0
    globe_diameter_cm = 25.0
    cap_diameter_cm = 5.0
    src_r = pole_cap_source_radius_px(
        map_size,
        globe_diameter_cm,
        cap_diameter_cm=cap_diameter_cm,
        enlarge=1.0,
    )
    r_mid = map_size / 2.0
    d_cm = (src_r / r_mid) * NONA_MID_EDGE_Y_FRAC * globe_diameter_cm
    assert abs(d_cm - cap_diameter_cm / 2.0) < 1e-9


def test_enlarge_shrinks_source_disk() -> None:
    map_size = 4000.0
    globe_diameter_cm = 25.0
    exact = pole_cap_source_radius_px(map_size, globe_diameter_cm, enlarge=1.0)
    enlarged = pole_cap_source_radius_px(
        map_size, globe_diameter_cm, enlarge=POLE_CAP_ENLARGE
    )
    assert enlarged < exact
    assert abs(exact / enlarged - POLE_CAP_ENLARGE) < 1e-9


def test_source_radius_clamped_to_half_map() -> None:
    src_r = pole_cap_source_radius_px(
        1000.0, globe_diameter_cm=10.0, cap_diameter_cm=40.0, enlarge=1.0
    )
    assert src_r == 500.0


def test_build_pole_caps_two_circles() -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        src = root / "prewarp.jpg"
        size = 800
        img = Image.new("RGB", (size, size), (40, 160, 80))
        draw = ImageDraw.Draw(img)
        cx = cy = size // 2
        draw.ellipse([cx - 120, cy - 120, cx + 120, cy + 120], fill=(220, 40, 40))
        img.save(src, format="JPEG", quality=95)

        dest = root / "pole-caps.jpg"
        empty = "#112233"
        build_pole_caps(
            src,
            dest,
            diameter_cm=25.0,
            cap_diameter_cm=5.0,
            empty_fill=empty,
        )

        out = Image.open(dest).convert("RGB")
        expect_w, expect_h = pole_caps_canvas_size_px(5.0)
        assert out.size == (expect_w, expect_h)

        side = pole_cap_output_side_px(5.0)
        # Outside masks (canvas corner) is white.
        wr, wg, wb = out.getpixel((0, 0))
        assert wr > 250 and wg > 250 and wb > 250, f"corner: {(wr, wg, wb)}"

        # North circle centre (left) keeps the red disk.
        ncx = side // 2
        ncy = side // 2
        r, g, b = out.getpixel((ncx, ncy))
        assert r > 180 and g < 100 and b < 100, f"north centre: {(r, g, b)}"

        # South circle centre (right) is solid empty fill.
        gap = expect_w - side * 2
        scx = side + gap + side // 2
        scy = side // 2
        er, eg, eb = out.getpixel((scx, scy))
        assert abs(er - 0x11) < 12 and abs(eg - 0x22) < 12 and abs(eb - 0x33) < 12, (
            f"south centre: {(er, eg, eb)}"
        )

        # Mid-gap between circles stays white.
        gx = side + gap // 2
        gr, gg, gb = out.getpixel((gx, side // 2))
        assert gr > 250 and gg > 250 and gb > 250, f"gap: {(gr, gg, gb)}"


if __name__ == "__main__":
    test_output_side_matches_print_dpi()
    test_canvas_holds_two_circles()
    test_source_radius_matches_stripe_tip()
    test_enlarge_shrinks_source_disk()
    test_source_radius_clamped_to_half_map()
    test_build_pole_caps_two_circles()
    print("ok")

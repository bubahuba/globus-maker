"""Pole caps sheet: north map circle + empty-fill circle on white."""

from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw

from distort import (
    NONA_MID_EDGE_Y_FRAC,
    POLE_CAP_CENTER_MARK_DIAMETER_CM,
    POLE_CAP_DIAMETER_CM,
    POLE_CAP_ENLARGE,
    POLE_CAP_MASK_BLEED,
    PRINT_DPI,
    PRINT_PX_PER_CM,
    build_pole_caps,
    pole_cap_cut_radius_px,
    pole_cap_output_side_px,
    pole_cap_source_radius_px,
    pole_caps_canvas_size_px,
)


def test_output_side_includes_mask_bleed() -> None:
    cut_side = int(round(POLE_CAP_DIAMETER_CM * PRINT_PX_PER_CM))
    side = pole_cap_output_side_px(POLE_CAP_DIAMETER_CM)
    assert side == int(round(POLE_CAP_DIAMETER_CM * POLE_CAP_MASK_BLEED * PRINT_PX_PER_CM))
    assert side > cut_side


def test_cut_radius_matches_diameter() -> None:
    assert pole_cap_cut_radius_px(5.0) == 400.0


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


def _is_yellow(rgb: tuple[int, int, int]) -> bool:
    r, g, b = rgb
    # JPEG softens pure yellow, especially over dark south fill.
    return r > 220 and g > 170 and b < 100 and r >= g and g > b + 40


def _has_yellow_near(img: Image.Image, x: float, y: float, radius: int = 3) -> bool:
    w, h = img.size
    cx, cy = int(round(x)), int(round(y))
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            px, py = cx + dx, cy + dy
            if 0 <= px < w and 0 <= py < h and _is_yellow(img.getpixel((px, py))):
                return True
    return False


def test_build_pole_caps_cut_guides_and_bleed() -> None:
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
        cut_r = pole_cap_cut_radius_px(5.0)
        ncx = (side - 1) / 2.0
        ncy = (side - 1) / 2.0

        # Outside masks (canvas corner) is white.
        wr, wg, wb = out.getpixel((0, 0))
        assert wr > 250 and wg > 250 and wb > 250, f"corner: {(wr, wg, wb)}"

        # North circle interior (inside centre mark) keeps the red disk.
        # Sample a few pixels just outside the centre-mark ring.
        mark_r = (POLE_CAP_CENTER_MARK_DIAMETER_CM * PRINT_PX_PER_CM) / 2.0
        sample_r = int(round(mark_r + 8))
        r, g, b = out.getpixel((int(ncx) + sample_r, int(ncy)))
        assert r > 180 and g < 100 and b < 100, f"north interior: {(r, g, b)}"

        # Large yellow cut circle on the north cap.
        assert _has_yellow_near(out, ncx + cut_r, ncy), "missing north cut circle"

        # Small yellow centre mark.
        assert _has_yellow_near(out, ncx + mark_r, ncy), "missing north centre mark"

        # Bleed: just outside the cut circle but inside the mask still has map ink
        # (not white). Yellow stroke is ~2px; sample a bit further out.
        bleed_x = int(round(ncx + cut_r + 8))
        br, bg, bb = out.getpixel((bleed_x, int(ncy)))
        assert not (br > 250 and bg > 250 and bb > 250), f"expected bleed ink: {(br, bg, bb)}"

        # South circle centre (right) is solid empty fill (inside centre mark).
        gap = expect_w - side * 2
        scx = side + gap + (side - 1) / 2.0
        scy = (side - 1) / 2.0
        er, eg, eb = out.getpixel((int(scx) + sample_r, int(scy)))
        assert abs(er - 0x11) < 12 and abs(eg - 0x22) < 12 and abs(eb - 0x33) < 12, (
            f"south interior: {(er, eg, eb)}"
        )

        # South also gets the yellow cut circle + centre mark.
        assert _has_yellow_near(out, scx + cut_r, scy), "missing south cut circle"
        assert _has_yellow_near(out, scx + mark_r, scy), "missing south centre mark"

        # Mid-gap between circles stays white.
        gx = side + gap // 2
        gr, gg, gb = out.getpixel((gx, side // 2))
        assert gr > 250 and gg > 250 and gb > 250, f"gap: {(gr, gg, gb)}"

        # Same print density as stripes (100% print → designed cm size).
        meta = Image.open(dest)
        dpi = meta.info.get("dpi")
        assert dpi is not None
        assert abs(dpi[0] - PRINT_DPI) < 0.6
        assert abs(dpi[1] - PRINT_DPI) < 0.6
        assert abs(meta.size[1] / PRINT_PX_PER_CM - 5.0 * POLE_CAP_MASK_BLEED) < 0.02


if __name__ == "__main__":
    test_output_side_includes_mask_bleed()
    test_cut_radius_matches_diameter()
    test_canvas_holds_two_circles()
    test_source_radius_matches_stripe_tip()
    test_enlarge_shrinks_source_disk()
    test_source_radius_clamped_to_half_map()
    test_build_pole_caps_cut_guides_and_bleed()
    print("ok")

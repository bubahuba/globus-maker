"""Yellow lens cut-line overlay on meridian stripe JPEGs."""

from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from distort import (
    CUT_LINE_COLOR,
    CUT_LINE_ENLARGE,
    draw_stripe_cut_line,
    stripe_cut_line_half_width,
    stripe_cut_line_polygon,
)


def test_half_width_peaks_at_equator() -> None:
    w, h = 720.0, 4000.0
    equator_y = (h - 1.0) / 2.0
    mid = stripe_cut_line_half_width(equator_y, width=w, height=h, enlarge=1.0)
    top = stripe_cut_line_half_width(0.0, width=w, height=h, enlarge=1.0)
    bot = stripe_cut_line_half_width(h - 1.0, width=w, height=h, enlarge=1.0)
    assert abs(top) < 1e-9
    assert abs(bot) < 1e-9
    assert abs(mid - (w - 1.0) / 2.0) < 1e-6


def test_enlarge_fattens_shoulders() -> None:
    w, h = 720.0, 4000.0
    y = h * 0.15  # near pole — sin < 1/enlarge
    slim = stripe_cut_line_half_width(y, width=w, height=h, enlarge=1.0)
    fat = stripe_cut_line_half_width(y, width=w, height=h, enlarge=CUT_LINE_ENLARGE)
    assert fat > slim
    assert fat <= (w - 1.0) / 2.0


def test_polygon_is_closed_lens() -> None:
    poly = stripe_cut_line_polygon(144, 800, enlarge=1.0, stroke_px=2.0, samples=32)
    assert len(poly) >= 32
    # Tips near vertical centre at top/bottom.
    top = min(poly, key=lambda p: p[1])
    bot = max(poly, key=lambda p: p[1])
    assert abs(top[0] - 71.5) < 2.0
    assert abs(bot[0] - 71.5) < 2.0
    # Mid left/right near the padded edges.
    mid_y = 399.5
    mid_pts = sorted(poly, key=lambda p: abs(p[1] - mid_y))[:4]
    xs = [p[0] for p in mid_pts]
    assert min(xs) < 5
    assert max(xs) > 138


def test_draw_writes_yellow_on_edge_not_centre() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "out-00.jpg"
        img = Image.new("RGB", (144, 800), (200, 180, 140))
        img.save(path, format="JPEG", quality=90)

        draw_stripe_cut_line(path, enlarge=1.04, stroke_cm=0.02)

        out = Image.open(path).convert("RGB")
        # Centre of stripe should stay map-coloured (not yellow).
        cx, cy = 72, 400
        centre = out.getpixel((cx, cy))
        assert centre[0] < 240 and centre[1] < 230

        # A point on the mid-left cut edge should be yellow-ish.
        yellow_hits = 0
        for y in range(300, 500, 5):
            hw = stripe_cut_line_half_width(
                float(y), width=144.0, height=800.0, enlarge=1.04, edge_pad=1.0
            )
            x = int(round(71.5 - hw))
            x = max(0, min(143, x))
            r, g, b = out.getpixel((x, y))
            if r > 240 and g > 180 and b < 80:
                yellow_hits += 1
        assert yellow_hits >= 5

        # Tip neighbourhood near north pole should have yellow.
        tip_hits = 0
        for y in range(0, 40):
            for x in range(60, 85):
                r, g, b = out.getpixel((x, y))
                if r > 240 and g > 180 and b < 80:
                    tip_hits += 1
        assert tip_hits >= 1


def test_draw_is_idempotent_size() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "out-01.jpg"
        Image.new("RGB", (72, 400), (10, 20, 30)).save(path, format="JPEG", quality=85)
        draw_stripe_cut_line(path)
        w1, h1 = Image.open(path).size
        assert (w1, h1) == (72, 400)


if __name__ == "__main__":
    test_half_width_peaks_at_equator()
    test_enlarge_fattens_shoulders()
    test_polygon_is_closed_lens()
    test_draw_writes_yellow_on_edge_not_centre()
    test_draw_is_idempotent_size()
    print("ok")

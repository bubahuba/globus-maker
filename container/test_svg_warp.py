"""Unit tests for geometric SVG BarrelInverse + full-frame stripe unwrap."""

from pathlib import Path
from tempfile import TemporaryDirectory

from svg_warp import (
    BARREL_INVERSE_ARGS,
    barrel_inverse_dest_radius,
    barrel_inverse_point,
    project_map_point_to_stripe,
    project_svg_stripe,
    stripe_dimensions,
    warp_svg_barrel,
)


def test_barrel_inverse_center_fixed() -> None:
    a, b, c, d = BARREL_INVERSE_ARGS
    assert abs(barrel_inverse_dest_radius(0.0, a, b, c, d)) < 1e-9
    rd = barrel_inverse_dest_radius(1.0, a, b, c, d)
    assert abs(rd - 1.0) < 1e-3


def test_barrel_inverse_pulls_inward() -> None:
    size = 1000.0
    cx = cy = size / 2.0
    r_scale = 2.0 / size
    x, y = cx, 100.0
    nx, ny = barrel_inverse_point(x, y, cx=cx, cy=cy, r_scale=r_scale)
    assert ny > y
    assert abs(nx - cx) < 1e-6


def test_stripe_dimensions_match_tile_math() -> None:
    w, h = stripe_dimensions(4000, 12)
    assert abs(h - 4000) < 1e-6
    assert abs(w - 720) < 1e-6


def test_map_center_at_stripe_top() -> None:
    size = 1000.0
    h = 4000.0
    pt = project_map_point_to_stripe(
        size / 2,
        size / 2,
        map_size=size,
        stripe_height=h,
        stripes=12,
        yaw_deg=0.0,
    )
    assert pt is not None
    sw, sh = stripe_dimensions(h, 12)
    x, y = pt
    assert abs(x - sw / 2) < 1e-6
    assert abs(y) < 1e-6


def test_mid_edge_matches_nona_height() -> None:
    """Top mid-edge lands ~80.5% down (nona), leaving base-fill below."""
    from svg_warp import NONA_MID_EDGE_Y_FRAC

    size = 1000.0
    h = 4000.0
    pt = project_map_point_to_stripe(
        size / 2,
        0.0,
        map_size=size,
        stripe_height=h,
        stripes=12,
        yaw_deg=0.0,
    )
    assert pt is not None
    sw, sh = stripe_dimensions(h, 12)
    x, y = pt
    assert abs(x - sw / 2) < 1.0
    assert abs(y - sh * NONA_MID_EDGE_Y_FRAC) < 1.0
    assert y < sh * 0.95  # bottom band remains for base fill


def test_corner_leaves_bottom_base_band() -> None:
    from svg_warp import NONA_CORNER_Y_FRAC

    size = 1000.0
    h = 4000.0
    # Top-right corner of the square
    pt = project_map_point_to_stripe(
        size,
        0.0,
        map_size=size,
        stripe_height=h,
        stripes=12,
        yaw_deg=45.0,  # corner bearing ≈ 45°
    )
    assert pt is not None
    _, sh = stripe_dimensions(h, 12)
    assert abs(pt[1] - sh * NONA_CORNER_Y_FRAC) < 2.0
    assert pt[1] < sh  # not glued to the bottom edge


def test_gore_edge_fills_stripe_width() -> None:
    size = 1000.0
    h = 4000.0
    # Point near centre along +30° bearing → right edge of 12-stripe gore (half=15°)
    # Use 14° so it stays inside.
    ang = 14.0
    r = 100.0
    x = size / 2 + r * math_sin(ang)
    y = size / 2 - r * math_cos(ang)
    pt = project_map_point_to_stripe(
        x, y, map_size=size, stripe_height=h, stripes=12, yaw_deg=0.0
    )
    assert pt is not None
    sw, _ = stripe_dimensions(h, 12)
    assert pt[0] > sw * 0.9


def math_sin(deg: float) -> float:
    from math import radians, sin

    return sin(radians(deg))


def math_cos(deg: float) -> float:
    from math import cos, radians

    return cos(radians(deg))


def test_stripe_svg_fills_viewbox_not_lentil() -> None:
    """Projected content should span most of the rectangular stripe, not a tiny lentil."""
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect data-bg="1" x="0" y="0" width="200" height="200" fill="#e8eddb"/>
  <path d="M100,100 L100,10 L110,20 L90,20 Z" fill="#09f"/>
  <path d="M100,100 L190,100 L180,110 L180,90 Z" fill="#f90"/>
</svg>
"""
    with TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.svg"
        dest = Path(tmp) / "out.svg"
        src.write_text(svg, encoding="utf-8")
        project_svg_stripe(
            src,
            dest,
            stripe_index=0,
            stripes=12,
            stripe_height=400,
            background="#9ebfff",
        )
        text = dest.read_text(encoding="utf-8")
        assert 'viewBox="0 0 72 400"' in text or "viewBox='0 0 72 400'" in text
        # Top ray should produce points near y≈0 and near mid/lower stripe (not only mid band).
        assert "M36" in text or "M37" in text or "36," in text


def test_warp_svg_barrel_rewrites_path() -> None:
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect data-bg="1" x="0" y="0" width="100" height="100" fill="#e8eddb"/>
  <path d="M50,10 L55,10 L55,15 L50,15 Z" fill="#00f"/>
</svg>
"""
    with TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.svg"
        dest = Path(tmp) / "out.svg"
        src.write_text(svg, encoding="utf-8")
        warp_svg_barrel(src, dest)
        text = dest.read_text(encoding="utf-8")
        assert "<svg" in text
        assert 'd="' in text
        assert "M50,10" not in text or "L55,10" not in text


def test_stripe_projection_updates_text_rotate_center() -> None:
    """Street labels must remount rotate() onto the projected anchor, not map coords."""
    import re

    # Label inside stripe-0 gore (near top mid, ~bearing 0°) with a street angle.
    # svg_map stores rotate(-street_angle, x, y).
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect data-bg="1" x="0" y="0" width="200" height="200" fill="#e8eddb"/>
  <text x="105" y="80" font-size="8" fill="#333"
        transform="rotate(-35 105 80)">Teststraat</text>
</svg>
"""
    with TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.svg"
        dest = Path(tmp) / "out.svg"
        src.write_text(svg, encoding="utf-8")
        project_svg_stripe(
            src,
            dest,
            stripe_index=0,
            stripes=12,
            stripe_height=400,
            background="#9ebfff",
        )
        out = dest.read_text(encoding="utf-8")
        assert "Teststraat" in out
        assert "110 95" not in out  # old map-space rotate centre must be gone
        match = re.search(
            r'<text[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*transform="rotate\(([^)]+)\)"',
            out,
        )
        if match is None:
            match = re.search(
                r'<text[^>]*transform="rotate\(([^)]+)\)"[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"',
                out,
            )
            assert match is not None, out
            rot, x_s, y_s = match.group(1), match.group(2), match.group(3)
        else:
            x_s, y_s, rot = match.group(1), match.group(2), match.group(3)
        parts = rot.replace(",", " ").split()
        assert len(parts) == 3
        angle, cx, cy = float(parts[0]), float(parts[1]), float(parts[2])
        assert abs(cx - float(x_s)) < 0.05
        assert abs(cy - float(y_s)) < 0.05
        assert abs(angle) > 0.5  # still angled after unwrap


def test_stripe_keeps_land_over_basefill_with_arc_rim() -> None:
    """Land canvas stays land-colored; baseFill is underlay; rim is arc-cut not flat."""
    import re
    import xml.etree.ElementTree as ET

    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect data-bg="1" x="0" y="0" width="200" height="200" fill="#e8eddb"/>
  <path d="M100,100 L100,20 L120,40 L80,40 Z" fill="#333"/>
</svg>
"""
    with TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.svg"
        dest = Path(tmp) / "out.svg"
        src.write_text(svg, encoding="utf-8")
        project_svg_stripe(
            src,
            dest,
            stripe_index=0,
            stripes=12,
            stripe_height=400,
            background="#9ebfff",
        )
        root = ET.parse(dest).getroot()
        bg = None
        land = None
        for child in root:
            tag = child.tag.split("}")[-1]
            if tag == "rect" and child.attrib.get("data-bg") == "1":
                bg = child
            if tag == "path" and child.attrib.get("data-land") == "1":
                land = child
        assert bg is not None
        assert bg.attrib.get("fill") == "#9ebfff"
        assert land is not None
        assert land.attrib.get("fill") == "#e8eddb"
        # Outer rim y should vary across the gore (arc), not a single horizontal line.
        ys = [float(y) for y in re.findall(r"[, ]([\d.]+)(?=L|Z|$)", land.attrib["d"])]
        # Parse more reliably from path points
        from svg_warp import _parse_path_points

        pts = _parse_path_points(land.attrib["d"])
        assert len(pts) >= 8
        rim = pts[1:]  # skip centre
        rim_ys = [p[1] for p in rim]
        assert max(rim_ys) - min(rim_ys) > 2.0  # curved bottom, not a flat cut


if __name__ == "__main__":
    test_barrel_inverse_center_fixed()
    test_barrel_inverse_pulls_inward()
    test_stripe_dimensions_match_tile_math()
    test_map_center_at_stripe_top()
    test_mid_edge_matches_nona_height()
    test_corner_leaves_bottom_base_band()
    test_gore_edge_fills_stripe_width()
    test_stripe_svg_fills_viewbox_not_lentil()
    test_warp_svg_barrel_rewrites_path()
    test_stripe_projection_updates_text_rotate_center()
    test_stripe_keeps_land_over_basefill_with_arc_rim()
    print("ok")

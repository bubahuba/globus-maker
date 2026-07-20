"""Clip MVT polygons to the tile square (no neighbour-buffer double paint)."""

from tile_render import EXTENT, _clip_ring_to_rect, clip_polygons_to_tile_extent


def test_clip_removes_buffer_outside_extent() -> None:
    # Square that straddles the right tile edge into the neighbour buffer.
    ring = [
        [EXTENT - 100, 1000],
        [EXTENT + 200, 1000],
        [EXTENT + 200, 2000],
        [EXTENT - 100, 2000],
        [EXTENT - 100, 1000],
    ]
    clipped = _clip_ring_to_rect(ring, 0.0, 0.0, float(EXTENT), float(EXTENT))
    assert clipped, "expected clipped ring"
    xs = [p[0] for p in clipped]
    assert max(xs) <= EXTENT + 1e-6
    assert min(xs) >= -1e-6


def test_clip_polygons_drops_fully_outside() -> None:
    outside = [[[ [EXTENT + 10, 0], [EXTENT + 20, 0], [EXTENT + 20, 10], [EXTENT + 10, 10], [EXTENT + 10, 0] ]]]
    assert clip_polygons_to_tile_extent(outside) == []


def test_clip_keeps_interior() -> None:
    interior = [[[ [100, 100], [200, 100], [200, 200], [100, 200], [100, 100] ]]]
    out = clip_polygons_to_tile_extent(interior)
    assert len(out) == 1
    assert len(out[0][0]) >= 4


if __name__ == "__main__":
    test_clip_removes_buffer_outside_extent()
    test_clip_polygons_drops_fully_outside()
    test_clip_keeps_interior()
    print("test_tile_clip: ok")

"""Verify tile-scoped compositing stays on tile-sized buffers."""

from PIL import Image

from tile_render import (
    TILE_SIZE,
    _composite_tile_onto_canvas,
    _draw_polygon_layer,
    _ensure_rgba,
)


def test_composite_tile_onto_canvas_blends_region() -> None:
    canvas = Image.new("RGBA", (512, 512), (255, 255, 255, 255))
    tile = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    geometry = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
    }
    tile = _draw_polygon_layer(tile, geometry, "#ff0000", 1.0, render_size=TILE_SIZE)
    result = _composite_tile_onto_canvas(canvas, tile, 256, 0)

    assert result.size == (512, 512)
    # Pixel inside composited tile region is red; outside stays white.
    assert result.getpixel((300, 100))[:3] == (255, 0, 0)
    assert result.getpixel((100, 100))[:3] == (255, 255, 255)


def test_draw_polygon_stays_tile_sized() -> None:
    tile = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    geometry = {
        "type": "Polygon",
        "coordinates": [[[512, 512], [3584, 512], [3584, 3584], [512, 3584], [512, 512]]],
    }
    out = _draw_polygon_layer(tile, geometry, "#00ff00", 0.5, render_size=TILE_SIZE)
    assert out.size == (TILE_SIZE, TILE_SIZE)
    assert _ensure_rgba(out).mode == "RGBA"


if __name__ == "__main__":
    test_composite_tile_onto_canvas_blends_region()
    test_draw_polygon_stays_tile_sized()
    print("ok")

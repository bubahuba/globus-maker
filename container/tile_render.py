import asyncio
import math
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import mapbox_vector_tile
from PIL import Image, ImageDraw, ImageFont

# Large stitched maps are intentional; Pillow's decompression bomb default is too low.
Image.MAX_IMAGE_PIXELS = 250_000_000

USER_AGENT = "GlobusMaker/1.0 (globe stripe generator)"
TILEJSON_URL = "https://tiles.openfreemap.org/planet"
MAX_CONCURRENT = 2
TILE_SIZE = 256
MAX_RENDER_SCALE = 20
# Keep world canvas side within Pillow / memory limits; stitch upscales to targetOutputPx.
MAX_CANVAS_SIDE_PX = 12_288
TARGET_OUTPUT_PX = 4500
VECTOR_TILE_MAX_ZOOM = 14
# Supersample stitched input.jpg vs stripe height (stereographic projection needs extra pixels at poles).
INPUT_SUPERSAMPLE = 2
EXTENT = 4096
# MapLibre sizes are tuned for on-screen tiles; scale down for high-res print output.
LABEL_PRINT_SCALE = 0.25
LABEL_STROKE_WIDTH = 2
STREET_PRINT_SCALE = 0.25
STREET_CASING_PRINT_SCALE = 0.2
BOUNDARY_PRINT_SCALE = 0.6
STREET_EXCLUDE = {"path", "pedestrian", "rail", "transit", "aerialway", "ferry"}
BOUNDARY_ADMIN_LEVELS = {2, 4}
BOUNDARY_COUNTRY_COLOR = "#555555"
BOUNDARY_STATE_COLOR = "#888888"
BOUNDARY_DISPUTED_COLOR = "#b05050"
LAND_FOREST_CLASSES = {"wood", "forest", "grass", "meadow", "scrub"}

DEFAULT_MAP_LAYERS: dict[str, dict[str, Any]] = {
    "landForest": {"enabled": True, "color": "#e8eddb"},
    "water": {"enabled": True, "color": "#9ebfff"},
    "streets": {"enabled": True, "color": "#ffffff"},
    "buildings": {"enabled": True, "color": "#d9d5d0"},
    "streetNames": {"enabled": True, "color": "#555555"},
}

_tile_url_template: str | None = None
_vector_max_zoom: int = 14
_font_cache: dict[int, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


async def _resolve_tile_template(client: httpx.AsyncClient) -> str:
    global _tile_url_template, _vector_max_zoom
    if _tile_url_template:
        return _tile_url_template

    response = await client.get(TILEJSON_URL, headers={"User-Agent": USER_AGENT})
    response.raise_for_status()
    payload = response.json()
    _tile_url_template = payload["tiles"][0]
    _vector_max_zoom = int(payload.get("maxzoom", 14))
    return _tile_url_template


def _darken(color: str, amount: float = 0.15) -> str:
    r, g, b, _ = _hex_to_rgba(color)
    scale = 1 - amount

    def channel(value: int) -> str:
        return format(max(0, min(255, round(value * scale))), "02x")

    return f"#{channel(r)}{channel(g)}{channel(b)}"


def _normalize_map_layers(input_layers: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    layers = {key: dict(value) for key, value in DEFAULT_MAP_LAYERS.items()}
    if not input_layers:
        return layers

    for key, default in DEFAULT_MAP_LAYERS.items():
        override = input_layers.get(key)
        if not isinstance(override, dict):
            continue
        layers[key] = {
            "enabled": override.get("enabled", default["enabled"]),
            "color": override.get("color", default["color"]),
        }
    return layers


def build_render_palette_from_layers(input_layers: dict[str, Any] | None = None) -> dict[str, Any]:
    layers = _normalize_map_layers(input_layers)
    land = layers["landForest"]["color"] if layers["landForest"]["enabled"] else "#ffffff"

    return {
        "background": land,
        "land": land,
        "landForest": _darken(layers["landForest"]["color"], 0.12),
        "landPark": _darken(layers["landForest"]["color"], 0.08),
        "water": layers["water"]["color"],
        "streets": layers["streets"]["color"],
        "streetCasing": _darken(layers["streets"]["color"], 0.2),
        "buildings": layers["buildings"]["color"],
        "buildingOutline": _darken(layers["buildings"]["color"], 0.25),
        "labels": layers["streetNames"]["color"],
        "opacity": {
            "landGrass": 0.75,
            "landForest": 0.85,
            "landPark": 0.8,
        },
        "enabled": {
            "landForest": layers["landForest"]["enabled"],
            "water": layers["water"]["enabled"],
            "streets": layers["streets"]["enabled"],
            "buildings": layers["buildings"]["enabled"],
            "labels": layers["streetNames"]["enabled"],
        },
    }


def default_render_palette() -> dict[str, Any]:
    return build_render_palette_from_layers()


def resolve_render_palette(payload: dict[str, Any]) -> dict[str, Any]:
    render_palette = payload.get("renderPalette")
    if isinstance(render_palette, dict) and render_palette:
        return render_palette

    map_layers = payload.get("mapLayers")
    if isinstance(map_layers, dict) and map_layers:
        return build_render_palette_from_layers(map_layers)

    return default_render_palette()


def _hex_to_rgba(color: str, alpha: float = 1.0) -> tuple[int, int, int, int]:
    normalized = color.lstrip("#")
    if len(normalized) == 3:
        normalized = "".join(ch * 2 for ch in normalized)
    value = int(normalized[:6], 16)
    return (
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255,
        max(0, min(255, round(alpha * 255))),
    )


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if size in _font_cache:
        return _font_cache[size]
    try:
        _font_cache[size] = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            size=size,
        )
    except OSError:
        _font_cache[size] = ImageFont.load_default()
    return _font_cache[size]


def _coord_to_pixel(x: float, y: float, render_size: int = TILE_SIZE) -> tuple[float, float]:
    # MVT coords use a bottom-left origin (y increases north); screen pixels are top-left.
    return (x / EXTENT * render_size, (EXTENT - y) / EXTENT * render_size)


def _to_pixels(coords: list[list[float]], render_size: int = TILE_SIZE) -> list[tuple[float, float]]:
    return [_coord_to_pixel(coord[0], coord[1], render_size) for coord in coords]


def _to_canvas_pixels(
    coords: list[list[float]],
    tile_x: int,
    tile_y: int,
    min_x: int,
    min_y: int,
    tile_render_size: int,
) -> list[tuple[float, float]]:
    offset_x = (tile_x - min_x) * tile_render_size
    offset_y = (tile_y - min_y) * tile_render_size
    return [
        (offset_x + coord[0] / EXTENT * tile_render_size, offset_y + (EXTENT - coord[1]) / EXTENT * tile_render_size)
        for coord in coords
    ]


def _make_pixel_mapper(
    tile_x: int,
    tile_y: int,
    min_x: int,
    min_y: int,
    tile_render_size: int,
) -> Callable[[list[list[float]]], list[tuple[float, float]]]:
    def mapper(coords: list[list[float]]) -> list[tuple[float, float]]:
        return _to_canvas_pixels(coords, tile_x, tile_y, min_x, min_y, tile_render_size)

    return mapper


def _layer_features(decoded: dict[str, Any], layer_name: str) -> list[dict[str, Any]]:
    layer = decoded.get(layer_name, {})
    if isinstance(layer, dict):
        features = layer.get("features", [])
        return features if isinstance(features, list) else []
    return []


def _decode_feature_geometry(feature: dict[str, Any]) -> dict[str, Any] | None:
    geometry = feature.get("geometry")
    return geometry if isinstance(geometry, dict) else None


def _geometry_polygons(geometry: dict[str, Any]) -> list[list[list[float]]]:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    return []


def _geometry_lines(geometry: dict[str, Any]) -> list[list[list[float]]]:
    if geometry["type"] == "LineString":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiLineString":
        return geometry["coordinates"]
    return []


def _ensure_rgba(image: Image.Image) -> Image.Image:
    return image if image.mode == "RGBA" else image.convert("RGBA")


def _composite_tile_onto_canvas(
    canvas: Image.Image,
    tile: Image.Image,
    offset_x: int,
    offset_y: int,
) -> Image.Image:
    """Alpha-composite a tile-sized overlay onto the world canvas without full-canvas temps."""
    canvas = _ensure_rgba(canvas)
    tile = _ensure_rgba(tile)
    box = (offset_x, offset_y, offset_x + tile.width, offset_y + tile.height)
    region = canvas.crop(box)
    blended = Image.alpha_composite(_ensure_rgba(region), tile)
    canvas.paste(blended, (offset_x, offset_y))
    return canvas


def _draw_polygon_layer(
    base: Image.Image,
    geometry: dict[str, Any],
    color: str,
    opacity: float = 1.0,
    outline: str | None = None,
    render_size: int = TILE_SIZE,
    to_pixels: Callable[[list[list[float]]], list[tuple[float, float]]] | None = None,
) -> Image.Image:
    """Draw a polygon onto base. Callers must pass a tile-sized (or small) base, not the world canvas."""
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fill = _hex_to_rgba(color, opacity)
    outline_rgba = _hex_to_rgba(outline, 1.0) if outline else None
    map_coords = to_pixels or (lambda coords: _to_pixels(coords, render_size))

    for polygon in _geometry_polygons(geometry):
        outer = map_coords(polygon[0])
        if len(outer) >= 3:
            draw.polygon(outer, fill=fill, outline=outline_rgba)

    return Image.alpha_composite(_ensure_rgba(base), overlay)


def _draw_line_layer(
    base: Image.Image,
    geometry: dict[str, Any],
    color: str,
    width: int,
    opacity: float = 1.0,
    render_size: int = TILE_SIZE,
    to_pixels: Callable[[list[list[float]]], list[tuple[float, float]]] | None = None,
) -> Image.Image:
    """Draw a line onto base. Callers must pass a tile-sized (or small) base, not the world canvas."""
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    stroke = _hex_to_rgba(color, opacity)
    map_coords = to_pixels or (lambda coords: _to_pixels(coords, render_size))

    for line in _geometry_lines(geometry):
        points = map_coords(line)
        if len(points) >= 2:
            draw.line(points, fill=stroke, width=width, joint="curve")

    return Image.alpha_composite(_ensure_rgba(base), overlay)


def _interp_linear(zoom: float, z0: float, v0: float, z1: float, v1: float) -> float:
    if zoom <= z0:
        return v0
    if zoom >= z1:
        return v1
    t = (zoom - z0) / (z1 - z0)
    return v0 + t * (v1 - v0)


def _exp_interpolate(zoom: float, z0: float, v0: float, z1: float, v1: float, base: float = 1.2) -> float:
    """Match MapLibre ['interpolate', ['exponential', base], ['zoom'], ...]"""
    if zoom <= z0:
        return v0
    if zoom >= z1:
        return v1
    span = z1 - z0
    if span <= 0:
        return v0
    t = (base ** (zoom - z0) - 1) / (base**span - 1)
    return v0 * (1 - t) + v1 * t


def _street_line_width(zoom: int, render_scale: int = 1) -> int:
    width = _exp_interpolate(zoom, 10, 0.5, 16, 6, 1.2) * render_scale * STREET_PRINT_SCALE
    return max(1, round(width))


def _street_casing_width(zoom: int, render_scale: int = 1) -> int:
    width = _exp_interpolate(zoom, 10, 1, 16, 8, 1.2) * render_scale * STREET_CASING_PRINT_SCALE
    return max(1, round(width))


def _waterway_line_width(zoom: int, render_scale: int = 1) -> int:
    width = _interp_linear(zoom, 10, 0.5, 16, 3) * render_scale
    return max(1, round(width))


def _boundary_line_width(admin_level: int, zoom: int, render_scale: int = 1) -> int:
    """Keep country/state borders readable from continent scale (z1) through city scale (z14)."""
    if admin_level == 2:
        ref = _interp_linear(zoom, 1, 1.0, 14, 2.5)
    else:
        ref = _interp_linear(zoom, 1, 0.75, 14, 1.5)
    return max(1, round(ref * render_scale * BOUNDARY_PRINT_SCALE))


def _is_land_boundary(props: dict[str, Any]) -> bool:
    if props.get("admin_level") not in BOUNDARY_ADMIN_LEVELS:
        return False
    return props.get("maritime") not in (1, True, "1")


def _boundary_features(decoded: dict[str, Any]) -> list[tuple[int, bool, dict[str, Any]]]:
    items: list[tuple[int, bool, dict[str, Any]]] = []
    for feature in _layer_features(decoded, "boundary"):
        props = feature.get("properties", {})
        if not _is_land_boundary(props):
            continue
        geometry = _decode_feature_geometry(feature)
        if not geometry or geometry["type"] not in {"LineString", "MultiLineString"}:
            continue
        disputed = props.get("disputed") in (1, True, "1")
        items.append((int(props["admin_level"]), disputed, geometry))
    items.sort(key=lambda item: item[0], reverse=True)
    return items


def _draw_boundaries(
    base: Image.Image,
    decoded: dict[str, Any],
    zoom: int,
    render_scale: int = 1,
    *,
    render_size: int = TILE_SIZE,
    to_pixels: Callable[[list[list[float]]], list[tuple[float, float]]] | None = None,
) -> Image.Image:
    map_coords = to_pixels or (lambda coords: _to_pixels(coords, render_size))
    for admin_level, disputed, geometry in _boundary_features(decoded):
        if disputed:
            color = BOUNDARY_DISPUTED_COLOR
        elif admin_level == 2:
            color = BOUNDARY_COUNTRY_COLOR
        else:
            color = BOUNDARY_STATE_COLOR
        width = _boundary_line_width(admin_level, zoom, render_scale)
        base = _draw_line_layer(
            base,
            geometry,
            color,
            width,
            1.0,
            render_size=render_size,
            to_pixels=map_coords,
        )
    return base


def _label_font_size(zoom: int, kind: str = "default", place_class: str | None = None) -> float:
    """Map style text-size in screen pixels at the tile zoom level."""
    if kind == "street":
        return _interp_linear(zoom, 13, 9, 18, 12)
    if kind == "water":
        return _interp_linear(zoom, 9, 10, 14, 13)
    if kind == "place":
        if place_class == "country":
            return _interp_linear(zoom, 4, 13, 12, 18)
        if place_class in {"state", "region"}:
            return _interp_linear(zoom, 4, 11, 12, 14)
        if place_class in {"city", "town"}:
            return _interp_linear(zoom, 4, 10, 12, 13)
        return _interp_linear(zoom, 4, 9, 12, 11)
    return _interp_linear(zoom, 8, 10, 14, 13)


def _canvas_label_size(zoom: int, render_scale: int, kind: str = "default", place_class: str | None = None) -> int:
    px = _label_font_size(zoom, kind, place_class)
    return max(8, round(px * render_scale * LABEL_PRINT_SCALE))


def _line_midpoint_and_angle(
    geometry: dict[str, Any],
    to_pixels: Callable[[list[list[float]]], list[tuple[float, float]]],
) -> tuple[tuple[float, float], float] | None:
    lines = _geometry_lines(geometry)
    if not lines:
        return None
    points = to_pixels(max(lines, key=len))
    if len(points) < 2:
        return None
    mid = len(points) // 2
    p0, p1 = points[mid - 1], points[mid]
    anchor = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    angle = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
    if angle > 90:
        angle -= 180
    elif angle < -90:
        angle += 180
    return anchor, angle


def _feature_name(props: dict[str, Any]) -> str | None:
    for key in ("name", "name:latin", "name_en", "name_int"):
        value = props.get(key)
        if value:
            return str(value)
    return None


def _label_anchor(geometry: dict[str, Any], render_size: int = TILE_SIZE) -> tuple[float, float] | None:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None

    if geom_type == "Point":
        return _coord_to_pixel(coords[0], coords[1], render_size)
    if geom_type == "LineString":
        point = coords[len(coords) // 2]
        return _coord_to_pixel(point[0], point[1], render_size)
    if geom_type == "MultiLineString":
        first = coords[0]
        if not first:
            return None
        point = first[len(first) // 2]
        return _coord_to_pixel(point[0], point[1], render_size)
    if geom_type == "Polygon":
        ring = coords[0]
        if not ring:
            return None
        point = ring[len(ring) // 2]
        return _coord_to_pixel(point[0], point[1], render_size)
    if geom_type == "MultiPolygon":
        ring = coords[0][0]
        if not ring:
            return None
        point = ring[len(ring) // 2]
        return _coord_to_pixel(point[0], point[1], render_size)
    return None


PLACE_LABEL_PRIORITY = {
    "country": 0,
    "state": 1,
    "region": 2,
    "city": 3,
    "town": 4,
    "village": 5,
    "suburb": 6,
    "hamlet": 7,
    "neighbourhood": 8,
}
PRINT_PLACE_CLASSES = {"country", "state", "region", "city", "town"}
STREET_NAME_CLASSES = {"primary", "secondary", "tertiary", "minor", "residential", "service"}
STREET_LABEL_PRIORITY = {
    "motorway": 0,
    "trunk": 1,
    "primary": 2,
    "secondary": 3,
    "tertiary": 4,
    "minor": 5,
    "residential": 6,
    "service": 7,
}
# Pond/lake names dominate at print resolution — keep rivers and large water only.
WATER_NAME_CLASSES = {"river", "reservoir", "basin", "dock", "canal"}


class _LabelPlacer:
    def __init__(self, min_gap: int = 6) -> None:
        self._boxes: list[tuple[float, float, float, float]] = []
        self._min_gap = min_gap

    def _expanded(self, box: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        x0, y0, x1, y1 = box
        g = self._min_gap
        return (x0 - g, y0 - g, x1 + g, y1 + g)

    def _intersects(self, box: tuple[float, float, float, float]) -> bool:
        ax0, ay0, ax1, ay1 = self._expanded(box)
        for bx0, by0, bx1, by1 in self._boxes:
            if ax0 < bx1 and ax1 > bx0 and ay0 < by1 and ay1 > by0:
                return True
        return False

    def place(
        self,
        base: Image.Image,
        anchor: tuple[float, float],
        name: str,
        color: str,
        font_size: int,
        angle_deg: float = 0,
    ) -> Image.Image:
        text_img = _render_label_rgba(name, font_size, color, angle_deg)
        paste_x = int(anchor[0] - text_img.width / 2)
        paste_y = int(anchor[1] - text_img.height / 2)
        box = (paste_x, paste_y, paste_x + text_img.width, paste_y + text_img.height)
        if self._intersects(box):
            return base
        self._boxes.append(box)
        # Paste label RGBA directly — avoid allocating a full-canvas overlay per label.
        base = _ensure_rgba(base)
        base.paste(text_img, (paste_x, paste_y), text_img)
        return base


def _render_label_rgba(
    name: str,
    font_size: int,
    color: str,
    angle_deg: float = 0,
) -> Image.Image:
    font = _font(font_size)
    label_color = _hex_to_rgba(color, 1.0)
    halo = _hex_to_rgba("#ffffff", 1.0)

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bbox = probe.textbbox((0, 0), name, font=font, stroke_width=LABEL_STROKE_WIDTH)
    pad = LABEL_STROKE_WIDTH + 2
    text_img = Image.new(
        "RGBA",
        (bbox[2] - bbox[0] + pad * 2, bbox[3] - bbox[1] + pad * 2),
        (0, 0, 0, 0),
    )
    draw = ImageDraw.Draw(text_img)
    ox, oy = pad - bbox[0], pad - bbox[1]
    draw.text(
        (ox, oy),
        name,
        font=font,
        fill=label_color,
        stroke_width=LABEL_STROKE_WIDTH,
        stroke_fill=halo,
    )

    if angle_deg:
        text_img = text_img.rotate(angle_deg, expand=True, resample=Image.Resampling.BICUBIC)
    return text_img


def _draw_label_at_anchor(
    base: Image.Image,
    anchor: tuple[float, float],
    name: str,
    color: str,
    font_size: int,
    angle_deg: float = 0,
) -> Image.Image:
    text_img = _render_label_rgba(name, font_size, color, angle_deg)
    paste_x = int(anchor[0] - text_img.width / 2)
    paste_y = int(anchor[1] - text_img.height / 2)
    base = _ensure_rgba(base)
    base.paste(text_img, (paste_x, paste_y), text_img)
    return base


def _overlay_labels(
    image: Image.Image,
    decoded: dict[str, Any],
    label_zoom: int,
    render_palette: dict[str, Any],
    render_scale: int = 1,
) -> Image.Image:
    enabled = render_palette.get("enabled", {})
    if not enabled.get("labels", True):
        return image

    label_color = render_palette.get("labels", "#555555")
    base = image.convert("RGBA")
    render_size = TILE_SIZE * render_scale
    placer = _LabelPlacer(min_gap=4 * render_scale)

    place_candidates: list[tuple[int, str, dict[str, Any], dict[str, Any]]] = []
    if label_zoom >= 8:
        for feature in _layer_features(decoded, "place"):
            props = feature.get("properties", {})
            place_class = props.get("class")
            if place_class not in PRINT_PLACE_CLASSES:
                continue
            name = _feature_name(props)
            geometry = _decode_feature_geometry(feature)
            if not name or not geometry:
                continue
            priority = PLACE_LABEL_PRIORITY.get(place_class, 9)
            place_candidates.append((priority, name, geometry, props))

    place_candidates.sort(key=lambda item: (item[0], len(item[1])))
    for _, name, geometry, props in place_candidates:
        anchor = _label_anchor(geometry, render_size)
        if not anchor:
            continue
        font_size = _canvas_label_size(label_zoom, render_scale, "place", props.get("class"))
        base = placer.place(base, anchor, name, label_color, font_size)

    if label_zoom >= 12:
        for feature in _layer_features(decoded, "water_name"):
            props = feature.get("properties", {})
            if props.get("class") not in WATER_NAME_CLASSES:
                continue
            name = _feature_name(props)
            geometry = _decode_feature_geometry(feature)
            if not name or not geometry or len(name) > 24:
                continue
            anchor = _label_anchor(geometry, render_size)
            if not anchor:
                continue
            font_size = _canvas_label_size(label_zoom, render_scale, "water")
            base = placer.place(base, anchor, name, label_color, font_size)

    if label_zoom >= 13:
        street_candidates: list[tuple[int, str, dict[str, Any]]] = []
        for feature in _layer_features(decoded, "transportation_name"):
            props = feature.get("properties", {})
            road_class = props.get("class")
            if road_class not in STREET_NAME_CLASSES:
                continue
            name = _feature_name(props)
            geometry = _decode_feature_geometry(feature)
            if not name or not geometry or len(name) > 28:
                continue
            priority = STREET_LABEL_PRIORITY.get(road_class, 8)
            street_candidates.append((priority, name, geometry))

        street_candidates.sort(key=lambda item: (item[0], len(item[1])))
        font_size = _canvas_label_size(label_zoom, render_scale, "street")
        for _, name, geometry in street_candidates:
            placement = _line_midpoint_and_angle(geometry, lambda coords: _to_pixels(coords, render_size))
            if not placement:
                continue
            anchor, angle = placement
            base = placer.place(base, anchor, name, label_color, font_size, angle)

    return base.convert("RGB")


def _render_vector_tile(
    data: bytes,
    zoom: int,
    render_palette: dict[str, Any],
    *,
    include_labels: bool = True,
    label_zoom: int | None = None,
    render_scale: int = 1,
) -> Image.Image:
    decoded = mapbox_vector_tile.decode(data)
    palette = render_palette
    enabled = palette.get("enabled", {})
    opacity = palette.get("opacity", {})
    render_size = TILE_SIZE * render_scale

    image = Image.new(
        "RGBA",
        (render_size, render_size),
        _hex_to_rgba(palette.get("background", "#ffffff")),
    )

    if enabled.get("landForest", True):
        land_color = palette.get("land", "#e8eddb")
        forest_color = palette.get("landForest", land_color)
        park_color = palette.get("landPark", land_color)

        for feature in _layer_features(decoded, "landcover"):
            props = feature.get("properties", {})
            if props.get("class") not in LAND_FOREST_CLASSES:
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry:
                continue
            if props.get("class") in {"wood", "forest"}:
                image = _draw_polygon_layer(
                    image,
                    geometry,
                    forest_color,
                    opacity.get("landForest", 0.85),
                    render_size=render_size,
                )
            else:
                image = _draw_polygon_layer(
                    image,
                    geometry,
                    land_color,
                    opacity.get("landGrass", 0.75),
                    render_size=render_size,
                )

        for feature in _layer_features(decoded, "park"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                image = _draw_polygon_layer(
                    image,
                    geometry,
                    park_color,
                    opacity.get("landPark", 0.8),
                    render_size=render_size,
                )

    if enabled.get("water", True):
        water_color = palette.get("water", "#9ebfff")
        for feature in _layer_features(decoded, "water"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                image = _draw_polygon_layer(
                    image, geometry, water_color, 1.0, render_size=render_size
                )
        for feature in _layer_features(decoded, "waterway"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                image = _draw_line_layer(
                    image,
                    geometry,
                    water_color,
                    _waterway_line_width(zoom, render_scale),
                    1.0,
                    render_size=render_size,
                )

    if enabled.get("streets", True):
        street_color = palette.get("streets", "#ffffff")
        street_casing = palette.get("streetCasing", street_color)
        street_width = _street_line_width(zoom, render_scale)
        casing_width = _street_casing_width(zoom, render_scale)

        for feature in _layer_features(decoded, "transportation"):
            props = feature.get("properties", {})
            if props.get("class") in STREET_EXCLUDE:
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry or geometry["type"] not in {"LineString", "MultiLineString"}:
                continue
            image = _draw_line_layer(
                image, geometry, street_casing, casing_width, 1.0, render_size=render_size
            )
            image = _draw_line_layer(
                image, geometry, street_color, street_width, 1.0, render_size=render_size
            )

    if enabled.get("buildings", True) and zoom >= 13:
        building_color = palette.get("buildings", "#d9d5d0")
        building_outline = palette.get("buildingOutline", building_color)
        for feature in _layer_features(decoded, "building"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                image = _draw_polygon_layer(
                    image,
                    geometry,
                    building_color,
                    1.0,
                    outline=building_outline,
                    render_size=render_size,
                )

    image = _draw_boundaries(image, decoded, zoom, render_scale, render_size=render_size)

    if include_labels:
        return _overlay_labels(
            image.convert("RGB"),
            decoded,
            label_zoom if label_zoom is not None else zoom,
            render_palette,
            render_scale=render_scale,
        )
    return image.convert("RGB")


def _lng_to_pixel_x(lng: float, zoom: int) -> float:
    return ((lng + 180) / 360) * TILE_SIZE * (2**zoom)


def _lat_to_pixel_y(lat: float, zoom: int) -> float:
    sin_lat = math.sin(lat * math.pi / 180)
    y = 0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)
    return y * TILE_SIZE * (2**zoom)


def _pixel_to_tile(pixel: float) -> int:
    return int(math.floor(pixel / TILE_SIZE))


def _build_manifest_from_bounds(bounds: dict[str, float], zoom: int) -> dict[str, Any]:
    """Match BE/src/osm/tile-math.ts buildTileManifest crop math at a given zoom."""
    x_min = _lng_to_pixel_x(bounds["west"], zoom)
    x_max = _lng_to_pixel_x(bounds["east"], zoom)
    y_min = _lat_to_pixel_y(bounds["north"], zoom)
    y_max = _lat_to_pixel_y(bounds["south"], zoom)

    left = _pixel_to_tile(min(x_min, x_max))
    right = _pixel_to_tile(max(x_min, x_max))
    top = _pixel_to_tile(min(y_min, y_max))
    bottom = _pixel_to_tile(max(y_min, y_max))

    tile_cols = right - left + 1
    tile_rows = bottom - top + 1
    tiles = [{"x": x, "y": y} for y in range(top, bottom + 1) for x in range(left, right + 1)]

    canvas_width = tile_cols * TILE_SIZE
    canvas_height = tile_rows * TILE_SIZE
    crop_left = max(0, round(min(x_min, x_max) - left * TILE_SIZE))
    crop_top = max(0, round(min(y_min, y_max) - top * TILE_SIZE))
    crop_width = round(abs(x_max - x_min))
    crop_height = round(abs(y_max - y_min))

    return {
        "zoom": zoom,
        "tiles": tiles,
        "tileCols": tile_cols,
        "tileRows": tile_rows,
        "cropBox": {
            "left": crop_left,
            "top": crop_top,
            "width": min(crop_width, canvas_width - crop_left),
            "height": min(crop_height, canvas_height - crop_top),
        },
        "bounds": bounds,
        "outputSizePx": max(crop_width, crop_height),
        "targetOutputPx": max(max(crop_width, crop_height), TARGET_OUTPUT_PX),
    }


def _manifest_target_px(manifest: dict[str, Any]) -> int:
    crop = manifest["cropBox"]
    native_square = max(crop["width"], crop["height"])
    return int(
        manifest.get("targetOutputPx")
        or manifest.get("outputSizePx")
        or max(native_square, TARGET_OUTPUT_PX)
    )


def _compute_render_scale(
    crop_box: dict[str, int],
    target_px: int,
    tile_cols: int = 1,
    tile_rows: int = 1,
) -> int:
    """Pick render scale; cap by canvas size so large tile grids don't exceed memory limits."""
    native_square = max(crop_box["width"], crop_box["height"])
    if native_square <= 0 or target_px <= 0:
        return 1
    scale_for_target = math.ceil(target_px / native_square)
    grid_side = max(tile_cols, tile_rows) * TILE_SIZE
    scale_for_canvas = MAX_CANVAS_SIDE_PX // grid_side if grid_side > 0 else scale_for_target
    return min(MAX_RENDER_SCALE, scale_for_target, max(1, scale_for_canvas))


def fetch_manifest(manifest: dict[str, Any], fetch_zoom: int) -> dict[str, Any]:
    """Map a high-zoom manifest to the zoom used for vector tile fetching."""
    crop = manifest["cropBox"]
    target_px = _manifest_target_px(manifest)
    bounds = manifest.get("bounds")
    fetch_zoom = min(int(manifest.get("zoom", fetch_zoom)), fetch_zoom)

    if manifest["zoom"] <= fetch_zoom:
        render_scale = _compute_render_scale(crop, target_px, manifest["tileCols"], manifest["tileRows"])
        return {
            **manifest,
            "zoom": fetch_zoom,
            "renderScale": render_scale,
            "tilePixelSize": TILE_SIZE * render_scale,
            "targetOutputPx": target_px,
        }

    if bounds:
        work = _build_manifest_from_bounds(bounds, fetch_zoom)
        render_scale = _compute_render_scale(
            work["cropBox"], target_px, work["tileCols"], work["tileRows"]
        )
        return {
            **work,
            "targetOutputPx": target_px,
            "renderScale": render_scale,
            "tilePixelSize": TILE_SIZE * render_scale,
        }

    # Fallback if bounds missing (should not happen for API jobs).
    zoom_diff = manifest["zoom"] - fetch_zoom
    xs = sorted({tile["x"] for tile in manifest["tiles"]})
    ys = sorted({tile["y"] for tile in manifest["tiles"]})
    min_x, min_y = xs[0], ys[0]
    max_x, max_y = xs[-1], ys[-1]
    scale = 1 << zoom_diff
    fetch_crop = {
        "left": crop["left"] // scale,
        "top": crop["top"] // scale,
        "width": max(1, round(crop["width"] / scale)),
        "height": max(1, round(crop["height"] / scale)),
    }
    render_scale = _compute_render_scale(
        fetch_crop, target_px, (max_x >> zoom_diff) - (min_x >> zoom_diff) + 1, (max_y >> zoom_diff) - (min_y >> zoom_diff) + 1
    )
    return {
        **manifest,
        "zoom": fetch_zoom,
        "tiles": [
            {"x": x, "y": y}
            for y in range(min_y >> zoom_diff, (max_y >> zoom_diff) + 1)
            for x in range(min_x >> zoom_diff, (max_x >> zoom_diff) + 1)
        ],
        "tileCols": (max_x >> zoom_diff) - (min_x >> zoom_diff) + 1,
        "tileRows": (max_y >> zoom_diff) - (min_y >> zoom_diff) + 1,
        "cropBox": fetch_crop,
        "targetOutputPx": target_px,
        "renderScale": render_scale,
        "tilePixelSize": TILE_SIZE * render_scale,
    }


def _label_anchor_canvas(
    geometry: dict[str, Any],
    tile_x: int,
    tile_y: int,
    min_x: int,
    min_y: int,
    tile_render_size: int,
) -> tuple[float, float] | None:
    anchor = _label_anchor(geometry, tile_render_size)
    if not anchor:
        return None
    offset_x = (tile_x - min_x) * tile_render_size
    offset_y = (tile_y - min_y) * tile_render_size
    return (anchor[0] + offset_x, anchor[1] + offset_y)


def _render_decoded_geometry_to_canvas(
    canvas: Image.Image,
    decoded: dict[str, Any],
    tile_x: int,
    tile_y: int,
    min_x: int,
    min_y: int,
    zoom: int,
    render_palette: dict[str, Any],
    render_scale: int,
) -> Image.Image:
    """Draw non-label layers from one MVT tile onto a shared world canvas.

    Geometry is rasterized into a tile-sized buffer first, then composited once
    onto the world canvas — avoids allocating full-canvas overlays per feature.
    """
    palette = render_palette
    enabled = palette.get("enabled", {})
    opacity = palette.get("opacity", {})
    tile_render_size = TILE_SIZE * render_scale
    offset_x = (tile_x - min_x) * tile_render_size
    offset_y = (tile_y - min_y) * tile_render_size

    tile = Image.new("RGBA", (tile_render_size, tile_render_size), (0, 0, 0, 0))

    if enabled.get("landForest", True):
        land_color = palette.get("land", "#e8eddb")
        forest_color = palette.get("landForest", land_color)
        park_color = palette.get("landPark", land_color)

        for feature in _layer_features(decoded, "landcover"):
            props = feature.get("properties", {})
            if props.get("class") not in LAND_FOREST_CLASSES:
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry:
                continue
            if props.get("class") in {"wood", "forest"}:
                tile = _draw_polygon_layer(
                    tile,
                    geometry,
                    forest_color,
                    opacity.get("landForest", 0.85),
                    render_size=tile_render_size,
                )
            else:
                tile = _draw_polygon_layer(
                    tile,
                    geometry,
                    land_color,
                    opacity.get("landGrass", 0.75),
                    render_size=tile_render_size,
                )

        for feature in _layer_features(decoded, "park"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                tile = _draw_polygon_layer(
                    tile,
                    geometry,
                    park_color,
                    opacity.get("landPark", 0.8),
                    render_size=tile_render_size,
                )

    if enabled.get("water", True):
        water_color = palette.get("water", "#9ebfff")
        for feature in _layer_features(decoded, "water"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                tile = _draw_polygon_layer(
                    tile, geometry, water_color, 1.0, render_size=tile_render_size
                )
        for feature in _layer_features(decoded, "waterway"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                tile = _draw_line_layer(
                    tile,
                    geometry,
                    water_color,
                    _waterway_line_width(zoom, render_scale),
                    1.0,
                    render_size=tile_render_size,
                )

    if enabled.get("streets", True):
        street_color = palette.get("streets", "#ffffff")
        street_casing = palette.get("streetCasing", street_color)
        street_width = _street_line_width(zoom, render_scale)
        casing_width = _street_casing_width(zoom, render_scale)

        for feature in _layer_features(decoded, "transportation"):
            props = feature.get("properties", {})
            if props.get("class") in STREET_EXCLUDE:
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry or geometry["type"] not in {"LineString", "MultiLineString"}:
                continue
            tile = _draw_line_layer(
                tile,
                geometry,
                street_casing,
                casing_width,
                1.0,
                render_size=tile_render_size,
            )
            tile = _draw_line_layer(
                tile,
                geometry,
                street_color,
                street_width,
                1.0,
                render_size=tile_render_size,
            )

    if enabled.get("buildings", True) and zoom >= 13:
        building_color = palette.get("buildings", "#d9d5d0")
        building_outline = palette.get("buildingOutline", building_color)
        for feature in _layer_features(decoded, "building"):
            geometry = _decode_feature_geometry(feature)
            if geometry:
                tile = _draw_polygon_layer(
                    tile,
                    geometry,
                    building_color,
                    1.0,
                    outline=building_outline,
                    render_size=tile_render_size,
                )

    tile = _draw_boundaries(
        tile,
        decoded,
        zoom,
        render_scale,
        render_size=tile_render_size,
    )

    return _composite_tile_onto_canvas(canvas, tile, offset_x, offset_y)


def _overlay_labels_world(
    canvas: Image.Image,
    decoded_tiles: list[tuple[int, int, dict[str, Any]]],
    label_zoom: int,
    render_palette: dict[str, Any],
    min_x: int,
    min_y: int,
    render_scale: int,
) -> Image.Image:
    enabled = render_palette.get("enabled", {})
    if not enabled.get("labels", True):
        return canvas.convert("RGB") if canvas.mode != "RGB" else canvas

    label_color = render_palette.get("labels", "#555555")
    base = _ensure_rgba(canvas)
    tile_render_size = TILE_SIZE * render_scale
    placer = _LabelPlacer(min_gap=4 * render_scale)

    place_candidates: list[tuple[int, str, dict[str, Any], dict[str, Any], int, int]] = []
    if label_zoom >= 8:
        for tile_x, tile_y, decoded in decoded_tiles:
            for feature in _layer_features(decoded, "place"):
                props = feature.get("properties", {})
                place_class = props.get("class")
                if place_class not in PRINT_PLACE_CLASSES:
                    continue
                name = _feature_name(props)
                geometry = _decode_feature_geometry(feature)
                if not name or not geometry:
                    continue
                priority = PLACE_LABEL_PRIORITY.get(place_class, 9)
                place_candidates.append((priority, name, geometry, props, tile_x, tile_y))

    place_candidates.sort(key=lambda item: (item[0], len(item[1])))
    placed_names: set[str] = set()
    for _, name, geometry, props, tile_x, tile_y in place_candidates:
        if name in placed_names:
            continue
        anchor = _label_anchor_canvas(geometry, tile_x, tile_y, min_x, min_y, tile_render_size)
        if not anchor:
            continue
        font_size = _canvas_label_size(label_zoom, render_scale, "place", props.get("class"))
        before = len(placer._boxes)
        base = placer.place(base, anchor, name, label_color, font_size)
        if len(placer._boxes) > before:
            placed_names.add(name)

    if label_zoom >= 12:
        for tile_x, tile_y, decoded in decoded_tiles:
            for feature in _layer_features(decoded, "water_name"):
                props = feature.get("properties", {})
                if props.get("class") not in WATER_NAME_CLASSES:
                    continue
                name = _feature_name(props)
                geometry = _decode_feature_geometry(feature)
                if not name or not geometry or len(name) > 24:
                    continue
                anchor = _label_anchor_canvas(geometry, tile_x, tile_y, min_x, min_y, tile_render_size)
                if not anchor:
                    continue
                font_size = _canvas_label_size(label_zoom, render_scale, "water")
                base = placer.place(base, anchor, name, label_color, font_size)

    if label_zoom >= 13:
        street_candidates: list[tuple[int, str, dict[str, Any], int, int]] = []
        for tile_x, tile_y, decoded in decoded_tiles:
            to_pixels = _make_pixel_mapper(tile_x, tile_y, min_x, min_y, tile_render_size)
            for feature in _layer_features(decoded, "transportation_name"):
                props = feature.get("properties", {})
                road_class = props.get("class")
                if road_class not in STREET_NAME_CLASSES:
                    continue
                name = _feature_name(props)
                geometry = _decode_feature_geometry(feature)
                if not name or not geometry or len(name) > 28:
                    continue
                priority = STREET_LABEL_PRIORITY.get(road_class, 8)
                street_candidates.append((priority, name, geometry, tile_x, tile_y))

        street_candidates.sort(key=lambda item: (item[0], len(item[1])))
        placed_streets: set[str] = set()
        font_size = _canvas_label_size(label_zoom, render_scale, "street")
        for _, name, geometry, tile_x, tile_y in street_candidates:
            if name in placed_streets:
                continue
            to_pixels = _make_pixel_mapper(tile_x, tile_y, min_x, min_y, tile_render_size)
            placement = _line_midpoint_and_angle(geometry, to_pixels)
            if not placement:
                continue
            anchor, angle = placement
            before = len(placer._boxes)
            base = placer.place(base, anchor, name, label_color, font_size, angle)
            if len(placer._boxes) > before:
                placed_streets.add(name)

    return base.convert("RGB")


def _render_world_canvas(
    tile_payloads: list[tuple[int, int, bytes]],
    work_manifest: dict[str, Any],
    render_palette: dict[str, Any],
    on_render_progress: Callable[[int, int], None] | None = None,
) -> Image.Image:
    """Render all MVT tiles into one world-space canvas (fixes tile-buffer seam artifacts)."""
    tiles = work_manifest["tiles"]
    xs = sorted({tile["x"] for tile in tiles})
    ys = sorted({tile["y"] for tile in tiles})
    min_x, min_y = xs[0], ys[0]
    render_scale = work_manifest["renderScale"]
    tile_render_size = work_manifest["tilePixelSize"]
    zoom = work_manifest["zoom"]
    render_total = len(tile_payloads)

    canvas = Image.new(
        "RGBA",
        (work_manifest["tileCols"] * tile_render_size, work_manifest["tileRows"] * tile_render_size),
        _hex_to_rgba(render_palette.get("background", "#ffffff")),
    )

    decoded_tiles: list[tuple[int, int, dict[str, Any]]] = []
    rendered = 0
    for tile_x, tile_y, data in tile_payloads:
        if not data:
            continue
        decoded = mapbox_vector_tile.decode(data)
        decoded_tiles.append((tile_x, tile_y, decoded))
        canvas = _render_decoded_geometry_to_canvas(
            canvas, decoded, tile_x, tile_y, min_x, min_y, zoom, render_palette, render_scale
        )
        rendered += 1
        if on_render_progress:
            on_render_progress(rendered, render_total)

    return _overlay_labels_world(
        canvas,
        decoded_tiles,
        zoom,
        render_palette,
        min_x,
        min_y,
        render_scale,
    )


async def render_tiles(
    manifest: dict[str, Any],
    render_palette: dict[str, Any],
    tiles_dir: Path,
    on_progress: Callable[[int, int], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Fetch MVT tiles and render them on a single world canvas. Returns manifest for stitching."""
    tiles_dir.mkdir(parents=True, exist_ok=True)
    for stale in tiles_dir.glob("tile_*.png"):
        stale.unlink()
    canvas_path = tiles_dir / "canvas.png"
    if canvas_path.exists():
        canvas_path.unlink()

    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    completed = 0
    lock = asyncio.Lock()
    tile_payloads: list[tuple[int, int, bytes]] = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        tile_template = await _resolve_tile_template(client)
        fetch_zoom = min(int(manifest["zoom"]), _vector_max_zoom, VECTOR_TILE_MAX_ZOOM)
        work_manifest = fetch_manifest(manifest, fetch_zoom)
        tiles = work_manifest["tiles"]
        total = len(tiles)

        async def worker(tile: dict[str, int]) -> tuple[int, int, bytes]:
            nonlocal completed
            async with semaphore:
                url = tile_template.format(z=work_manifest["zoom"], x=tile["x"], y=tile["y"])
                response = await client.get(url, headers={"User-Agent": USER_AGENT})
                response.raise_for_status()
                data = response.content

                async with lock:
                    completed += 1
                    if on_progress:
                        await on_progress(completed, total * 2)

                return tile["x"], tile["y"], data

        tile_payloads = list(await asyncio.gather(*(worker(tile) for tile in tiles)))

    loop = asyncio.get_running_loop()

    def on_render_progress(done: int, _total: int) -> None:
        if not on_progress:
            return
        step = total + done
        asyncio.run_coroutine_threadsafe(on_progress(step, total * 2), loop)

    canvas = await asyncio.to_thread(
        _render_world_canvas,
        tile_payloads,
        work_manifest,
        render_palette,
        on_render_progress,
    )
    # Drop raw MVT payloads before encode — they are no longer needed.
    tile_payloads.clear()
    canvas.save(canvas_path, format="PNG")
    canvas.close()
    del canvas

    if on_progress:
        await on_progress(total * 2, total * 2)

    return work_manifest

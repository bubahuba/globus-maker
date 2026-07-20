"""Build a square SVG map from OpenFreeMap MVT tiles (vector, not raster)."""

from __future__ import annotations

import html
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import mapbox_vector_tile

from tile_render import (
    BOUNDARY_COUNTRY_COLOR,
    BOUNDARY_DISPUTED_COLOR,
    BOUNDARY_STATE_COLOR,
    BUILT_UP_CLASSES,
    EXTENT,
    clip_polygons_to_tile_extent,
    LAND_FOREST_CLASSES,
    LAND_ROCK_CLASSES,
    LAND_SAND_CLASSES,
    LAND_SNOW_CLASSES,
    LAND_WETLAND_CLASSES,
    MAX_CONCURRENT,
    PLACE_LABEL_PRIORITY,
    PRINT_PLACE_CLASSES,
    STREET_LABEL_PRIORITY,
    STREET_NAME_CLASSES,
    USER_AGENT,
    VECTOR_TILE_MAX_ZOOM,
    WATER_NAME_CLASSES,
    ZOOM_BUILDINGS_MIN,
    ZOOM_BUILT_UP_MIN,
    ZOOM_LABELS_PLACES_MIN,
    ZOOM_LABELS_STREETS_MIN,
    ZOOM_LABELS_WATER_MIN,
    _boundary_features,
    _boundary_line_width,
    _canvas_label_size,
    _decode_feature_geometry,
    _feature_name,
    _geometry_lines,
    _geometry_polygons,
    _is_rail_feature,
    _is_street_feature,
    _label_anchor,
    _layer_features,
    _line_midpoint_and_angle,
    _resolve_tile_template,
    _street_casing_width,
    _street_line_width,
    _waterway_line_width,
    fetch_manifest,
    map_canvas_color,
    map_land_fill_color,
    water_paint_color,
)
import tile_render as _tile_render

import asyncio
import httpx


def _fmt(n: float) -> str:
    if abs(n) < 1e-6:
        return "0"
    s = f"{n:.2f}"
    return s.rstrip("0").rstrip(".") or "0"


def _points_to_path(points: list[tuple[float, float]], *, close: bool = False) -> str:
    if len(points) < 2:
        return ""
    simplified: list[tuple[float, float]] = [points[0]]
    for pt in points[1:]:
        prev = simplified[-1]
        if abs(pt[0] - prev[0]) + abs(pt[1] - prev[1]) >= 0.35:
            simplified.append(pt)
    if len(simplified) < 2:
        return ""
    parts = [f"M{_fmt(simplified[0][0])},{_fmt(simplified[0][1])}"]
    for x, y in simplified[1:]:
        parts.append(f"L{_fmt(x)},{_fmt(y)}")
    if close:
        parts.append("Z")
    return "".join(parts)


class _SvgBuilder:
    def __init__(
        self,
        size: float,
        canvas_color: str,
        *,
        land_fill: str | None = None,
        min_gap: float = 6.0,
    ) -> None:
        self.size = size
        self.canvas_color = canvas_color
        self.land_fill = land_fill
        self.layers: dict[str, list[str]] = {
            "landcover": [],
            "park": [],
            "water": [],
            "waterway": [],
            "builtup": [],
            "buildings": [],
            "street_casing": [],
            "streets": [],
            "rail": [],
            "boundaries": [],
            "labels": [],
        }
        self._boxes: list[tuple[float, float, float, float]] = []
        self._min_gap = min_gap

    def add_polygon(
        self,
        layer: str,
        rings: list[list[tuple[float, float]]],
        fill: str,
        opacity: float = 1.0,
        stroke: str | None = None,
        stroke_width: float = 0.5,
    ) -> None:
        if not rings:
            return
        d_parts: list[str] = []
        for ring in rings:
            d = _points_to_path(ring, close=True)
            if d:
                d_parts.append(d)
        if not d_parts:
            return
        attrs = [f'd="{" ".join(d_parts)}"', f'fill="{fill}"']
        if opacity < 1.0:
            attrs.append(f'fill-opacity="{opacity:.3f}"')
        if stroke:
            attrs.append(f'stroke="{stroke}"')
            attrs.append(f'stroke-width="{_fmt(stroke_width)}"')
        else:
            attrs.append('stroke="none"')
        self.layers[layer].append(f"<path {' '.join(attrs)}/>")

    def add_line(
        self,
        layer: str,
        points: list[tuple[float, float]],
        stroke: str,
        width: float,
        opacity: float = 1.0,
    ) -> None:
        d = _points_to_path(points, close=False)
        if not d:
            return
        attrs = [
            f'd="{d}"',
            'fill="none"',
            f'stroke="{stroke}"',
            f'stroke-width="{_fmt(max(0.25, width))}"',
            'stroke-linejoin="round"',
            'stroke-linecap="round"',
        ]
        if opacity < 1.0:
            attrs.append(f'stroke-opacity="{opacity:.3f}"')
        self.layers[layer].append(f"<path {' '.join(attrs)}/>")

    def _intersects(self, box: tuple[float, float, float, float]) -> bool:
        ax0, ay0, ax1, ay1 = box
        g = self._min_gap
        ax0, ay0, ax1, ay1 = ax0 - g, ay0 - g, ax1 + g, ay1 + g
        for bx0, by0, bx1, by1 in self._boxes:
            if ax0 < bx1 and ax1 > bx0 and ay0 < by1 and ay1 > by0:
                return True
        return False

    def add_label(
        self,
        x: float,
        y: float,
        name: str,
        color: str,
        font_size: float,
        angle_deg: float = 0.0,
    ) -> None:
        # Approximate text box for collision
        w = max(8.0, len(name) * font_size * 0.55)
        h = font_size * 1.2
        box = (x - w / 2, y - h / 2, x + w / 2, y + h / 2)
        if self._intersects(box):
            return
        self._boxes.append(box)
        safe = html.escape(name)
        transform = ""
        if abs(angle_deg) > 0.5:
            transform = f' transform="rotate({_fmt(-angle_deg)} {_fmt(x)} {_fmt(y)})"'
        self.layers["labels"].append(
            f'<text x="{_fmt(x)}" y="{_fmt(y)}" fill="{color}" font-size="{_fmt(font_size)}" '
            f'font-family="DejaVu Sans, Arial, sans-serif" text-anchor="middle" '
            f'dominant-baseline="middle" stroke="#ffffff" stroke-width="{_fmt(max(0.5, font_size * 0.12))}" '
            f'paint-order="stroke fill"{transform}>{safe}</text>'
        )

    def to_svg(self) -> str:
        s = self.size
        land_attr = f' data-land-fill="{self.land_fill}"' if self.land_fill else ""
        parts = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_fmt(s)} {_fmt(s)}" '
            f'style="background:{self.canvas_color}"{land_attr}>',
            # Opaque canvas — CSS background alone is ignored by ImageMagick/rsvg and
            # becomes black after JPEG / DePolar.
            f'<rect data-bg="1" x="0" y="0" width="{_fmt(s)}" height="{_fmt(s)}" '
            f'fill="{self.canvas_color}"/>',
        ]
        order = [
            "landcover",
            "park",
            "water",
            "waterway",
            "builtup",
            "buildings",
            "street_casing",
            "streets",
            "rail",
            "boundaries",
            "labels",
        ]
        for name in order:
            items = self.layers[name]
            if not items:
                continue
            parts.append(f'<g id="{name}">')
            parts.extend(items)
            parts.append("</g>")
        parts.append("</svg>")
        return "\n".join(parts)


def _crop_transform(
    work_manifest: dict[str, Any],
) -> tuple[float, float, float, float, float]:
    """Return (scale, ox, oy, out_size, render_scale) mapping world → square SVG."""
    crop = work_manifest["cropBox"]
    render_scale = int(work_manifest.get("renderScale", 1))
    crop_l = crop["left"] * render_scale
    crop_t = crop["top"] * render_scale
    crop_w = crop["width"] * render_scale
    crop_h = crop["height"] * render_scale
    square = float(max(crop_w, crop_h))
    target = float(
        work_manifest.get("targetOutputPx")
        or work_manifest.get("outputSizePx")
        or square
    )
    pad_x = (square - crop_w) / 2.0
    pad_y = (square - crop_h) / 2.0
    scale = target / square if square else 1.0
    # world → svg: ((wx - crop_l + pad_x) * scale, (wy - crop_t + pad_y) * scale)
    ox = (-crop_l + pad_x) * scale
    oy = (-crop_t + pad_y) * scale
    return scale, ox, oy, target, float(render_scale)


def _map_coords(
    coords: list[list[float]],
    tile_x: int,
    tile_y: int,
    min_x: int,
    min_y: int,
    tile_render_size: float,
    scale: float,
    ox: float,
    oy: float,
) -> list[tuple[float, float]]:
    offset_x = (tile_x - min_x) * tile_render_size
    offset_y = (tile_y - min_y) * tile_render_size
    out: list[tuple[float, float]] = []
    for coord in coords:
        wx = offset_x + coord[0] / EXTENT * tile_render_size
        wy = offset_y + (EXTENT - coord[1]) / EXTENT * tile_render_size
        out.append((wx * scale + ox, wy * scale + oy))
    return out


def _append_tile_geometry(
    svg: _SvgBuilder,
    decoded: dict[str, Any],
    tile_x: int,
    tile_y: int,
    min_x: int,
    min_y: int,
    zoom: int,
    render_palette: dict[str, Any],
    tile_render_size: float,
    scale: float,
    ox: float,
    oy: float,
    render_scale: int,
) -> None:
    palette = render_palette
    enabled = palette.get("enabled", {})
    opacity = palette.get("opacity", {})

    def map_ring(coords: list[list[float]]) -> list[tuple[float, float]]:
        return _map_coords(coords, tile_x, tile_y, min_x, min_y, tile_render_size, scale, ox, oy)

    land_color = palette.get("land", "#e8eddb")
    forest_color = palette.get("landForest", land_color)
    park_color = palette.get("landPark", land_color)

    for feature in _layer_features(decoded, "landcover"):
        props = feature.get("properties", {})
        cls = props.get("class")
        geometry = _decode_feature_geometry(feature)
        if not geometry:
            continue
        for poly in clip_polygons_to_tile_extent(_geometry_polygons(geometry)):
            rings = [map_ring(ring) for ring in poly]
            if cls in LAND_FOREST_CLASSES:
                if not enabled.get("landForest", True):
                    continue
                if cls in {"wood", "forest"}:
                    svg.add_polygon("landcover", rings, forest_color, opacity.get("landForest", 0.85))
                else:
                    svg.add_polygon("landcover", rings, land_color, opacity.get("landGrass", 0.75))
            elif cls in LAND_SNOW_CLASSES and enabled.get("snow", True):
                svg.add_polygon(
                    "landcover",
                    rings,
                    palette.get("snow", "#f0f4f8"),
                    opacity.get("snow", 0.95),
                )
            elif cls in LAND_SAND_CLASSES and enabled.get("sand", True):
                svg.add_polygon(
                    "landcover",
                    rings,
                    palette.get("sand", "#e6d5a8"),
                    opacity.get("sand", 0.9),
                )
            elif cls in LAND_ROCK_CLASSES and enabled.get("rock", True):
                svg.add_polygon(
                    "landcover",
                    rings,
                    palette.get("rock", "#c2bdb6"),
                    opacity.get("rock", 0.9),
                )
            elif cls in LAND_WETLAND_CLASSES and enabled.get("wetland", True):
                svg.add_polygon(
                    "landcover",
                    rings,
                    palette.get("wetland", "#a8c4b0"),
                    opacity.get("wetland", 0.85),
                )

    if enabled.get("landForest", True):
        for feature in _layer_features(decoded, "park"):
            geometry = _decode_feature_geometry(feature)
            if not geometry:
                continue
            for poly in clip_polygons_to_tile_extent(_geometry_polygons(geometry)):
                svg.add_polygon(
                    "park",
                    [map_ring(ring) for ring in poly],
                    park_color,
                    opacity.get("landPark", 0.8),
                )

    # Always paint water geometry: water.color when on, Empty fill when off
    # (seas become empty-fill color so continents sit on empty-fill oceans).
    water_color = water_paint_color(palette)
    for feature in _layer_features(decoded, "water"):
        geometry = _decode_feature_geometry(feature)
        if not geometry:
            continue
        for poly in _geometry_polygons(geometry):
            svg.add_polygon("water", [map_ring(ring) for ring in poly], water_color, 1.0)

    for feature in _layer_features(decoded, "waterway"):
        geometry = _decode_feature_geometry(feature)
        if not geometry:
            continue
        width = _waterway_line_width(zoom, render_scale) * scale
        for line in _geometry_lines(geometry):
            svg.add_line("waterway", map_ring(line), water_color, width)

    if enabled.get("streets", True):
        street_color = palette.get("streets", "#ffffff")
        street_casing = palette.get("streetCasing", street_color)
        street_width = _street_line_width(zoom, render_scale) * scale
        casing_width = _street_casing_width(zoom, render_scale) * scale
        for feature in _layer_features(decoded, "transportation"):
            props = feature.get("properties", {})
            if not _is_street_feature(props):
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry or geometry["type"] not in {"LineString", "MultiLineString"}:
                continue
            for line in _geometry_lines(geometry):
                pts = map_ring(line)
                svg.add_line("street_casing", pts, street_casing, casing_width)
                svg.add_line("streets", pts, street_color, street_width)

    if enabled.get("rail", True):
        rail_color = palette.get("rail", "#6a6a6a")
        rail_width = max(0.25, _street_line_width(zoom, render_scale) * 0.45 * scale)
        for feature in _layer_features(decoded, "transportation"):
            props = feature.get("properties", {})
            if not _is_rail_feature(props):
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry or geometry["type"] not in {"LineString", "MultiLineString"}:
                continue
            for line in _geometry_lines(geometry):
                svg.add_line("rail", map_ring(line), rail_color, rail_width)

    if enabled.get("buildings", True) and zoom >= ZOOM_BUILT_UP_MIN:
        built_up_color = palette.get("builtUp", palette.get("buildings", "#d9d5d0"))
        # Clip to tile extent: MVT buffer duplicates landuse across neighbours;
        # translucent fills then stack into visible grid seams.
        for feature in _layer_features(decoded, "landuse"):
            props = feature.get("properties", {})
            if props.get("class") not in BUILT_UP_CLASSES:
                continue
            geometry = _decode_feature_geometry(feature)
            if not geometry:
                continue
            for poly in clip_polygons_to_tile_extent(_geometry_polygons(geometry)):
                svg.add_polygon(
                    "builtup",
                    [map_ring(ring) for ring in poly],
                    built_up_color,
                    opacity.get("builtUp", 0.55),
                )

    if enabled.get("buildings", True) and zoom >= ZOOM_BUILDINGS_MIN:
        building_color = palette.get("buildings", "#d9d5d0")
        building_outline = palette.get("buildingOutline", building_color)
        for feature in _layer_features(decoded, "building"):
            geometry = _decode_feature_geometry(feature)
            if not geometry:
                continue
            for poly in _geometry_polygons(geometry):
                svg.add_polygon(
                    "buildings",
                    [map_ring(ring) for ring in poly],
                    building_color,
                    1.0,
                    stroke=building_outline,
                    stroke_width=max(0.25, 0.4 * scale),
                )

    for admin_level, disputed, geometry in _boundary_features(decoded):
        if disputed:
            color = BOUNDARY_DISPUTED_COLOR
        elif admin_level == 2:
            color = BOUNDARY_COUNTRY_COLOR
        else:
            color = BOUNDARY_STATE_COLOR
        width = _boundary_line_width(admin_level, zoom, render_scale) * scale
        for line in _geometry_lines(geometry):
            svg.add_line("boundaries", map_ring(line), color, width)


def _append_labels(
    svg: _SvgBuilder,
    decoded_tiles: list[tuple[int, int, dict[str, Any]]],
    label_zoom: int,
    render_palette: dict[str, Any],
    min_x: int,
    min_y: int,
    tile_render_size: float,
    scale: float,
    ox: float,
    oy: float,
    render_scale: int,
) -> None:
    enabled = render_palette.get("enabled", {})
    if not enabled.get("labels", True):
        return
    label_color = render_palette.get("labels", "#555555")

    def to_svg_anchor(geometry: dict[str, Any], tile_x: int, tile_y: int) -> tuple[float, float] | None:
        anchor = _label_anchor(geometry, int(tile_render_size))
        if not anchor:
            return None
        offset_x = (tile_x - min_x) * tile_render_size
        offset_y = (tile_y - min_y) * tile_render_size
        return (offset_x + anchor[0]) * scale + ox, (offset_y + anchor[1]) * scale + oy

    place_candidates: list[tuple[int, str, dict[str, Any], dict[str, Any], int, int]] = []
    if label_zoom >= ZOOM_LABELS_PLACES_MIN:
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
    placed: set[str] = set()
    for _, name, geometry, props, tile_x, tile_y in place_candidates:
        if name in placed:
            continue
        anchor = to_svg_anchor(geometry, tile_x, tile_y)
        if not anchor:
            continue
        font_size = _canvas_label_size(label_zoom, render_scale, "place", props.get("class")) * scale
        before = len(svg._boxes)
        svg.add_label(anchor[0], anchor[1], name, label_color, max(6.0, font_size))
        if len(svg._boxes) > before:
            placed.add(name)

    if enabled.get("water", True) and label_zoom >= ZOOM_LABELS_WATER_MIN:
        for tile_x, tile_y, decoded in decoded_tiles:
            for feature in _layer_features(decoded, "water_name"):
                props = feature.get("properties", {})
                if props.get("class") not in WATER_NAME_CLASSES:
                    continue
                name = _feature_name(props)
                geometry = _decode_feature_geometry(feature)
                if not name or not geometry or len(name) > 24:
                    continue
                anchor = to_svg_anchor(geometry, tile_x, tile_y)
                if not anchor:
                    continue
                font_size = _canvas_label_size(label_zoom, render_scale, "water") * scale
                svg.add_label(anchor[0], anchor[1], name, label_color, max(6.0, font_size))

    if label_zoom >= ZOOM_LABELS_STREETS_MIN:
        street_candidates: list[tuple[int, str, dict[str, Any], int, int]] = []
        for tile_x, tile_y, decoded in decoded_tiles:
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
        font_size = _canvas_label_size(label_zoom, render_scale, "street") * scale
        for _, name, geometry, tile_x, tile_y in street_candidates:
            if name in placed_streets:
                continue

            def mapper(coords: list[list[float]], tx=tile_x, ty=tile_y) -> list[tuple[float, float]]:
                return _map_coords(
                    coords, tx, ty, min_x, min_y, tile_render_size, scale, ox, oy
                )

            placement = _line_midpoint_and_angle(geometry, mapper)
            if not placement:
                continue
            anchor, angle = placement
            before = len(svg._boxes)
            svg.add_label(
                anchor[0],
                anchor[1],
                name,
                label_color,
                max(6.0, font_size),
                angle_deg=angle,
            )
            if len(svg._boxes) > before:
                placed_streets.add(name)


def build_svg_from_payloads(
    tile_payloads: list[tuple[int, int, bytes]],
    work_manifest: dict[str, Any],
    render_palette: dict[str, Any],
    on_render_progress: Callable[[int, int], None] | None = None,
) -> str:
    tiles = work_manifest["tiles"]
    xs = sorted({tile["x"] for tile in tiles})
    ys = sorted({tile["y"] for tile in tiles})
    min_x, min_y = xs[0], ys[0]
    render_scale = int(work_manifest["renderScale"])
    tile_render_size = float(work_manifest["tilePixelSize"])
    zoom = int(work_manifest["zoom"])
    scale, ox, oy, out_size, _ = _crop_transform(work_manifest)

    # Root background = land canvas (or empty when land off). data-land-fill = warp silhouette.
    svg = _SvgBuilder(
        out_size,
        map_canvas_color(render_palette),
        land_fill=map_land_fill_color(render_palette),
        min_gap=4.0 * render_scale * scale,
    )

    decoded_tiles: list[tuple[int, int, dict[str, Any]]] = []
    total = len(tile_payloads)
    done = 0
    for tile_x, tile_y, data in tile_payloads:
        if not data:
            continue
        decoded = mapbox_vector_tile.decode(data)
        decoded_tiles.append((tile_x, tile_y, decoded))
        _append_tile_geometry(
            svg,
            decoded,
            tile_x,
            tile_y,
            min_x,
            min_y,
            zoom,
            render_palette,
            tile_render_size,
            scale,
            ox,
            oy,
            render_scale,
        )
        done += 1
        if on_render_progress:
            on_render_progress(done, total)

    _append_labels(
        svg,
        decoded_tiles,
        zoom,
        render_palette,
        min_x,
        min_y,
        tile_render_size,
        scale,
        ox,
        oy,
        render_scale,
    )
    return svg.to_svg()


async def render_svg_map(
    manifest: dict[str, Any],
    render_palette: dict[str, Any],
    output_path: Path,
    on_progress: Callable[[int, int], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Fetch MVT tiles and write a square SVG map to output_path."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    completed = 0
    lock = asyncio.Lock()

    async with httpx.AsyncClient(timeout=30.0) as client:
        tile_template = await _resolve_tile_template(client)
        fetch_zoom = min(
            int(manifest["zoom"]),
            _tile_render._vector_max_zoom,
            VECTOR_TILE_MAX_ZOOM,
        )
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
        asyncio.run_coroutine_threadsafe(on_progress(total + done, total * 2), loop)

    svg_text = await asyncio.to_thread(
        build_svg_from_payloads,
        tile_payloads,
        work_manifest,
        render_palette,
        on_render_progress,
    )
    tile_payloads.clear()
    output_path.write_text(svg_text, encoding="utf-8")
    if on_progress:
        await on_progress(total * 2, total * 2)
    return work_manifest

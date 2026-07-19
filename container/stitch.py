from collections.abc import Callable
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = 250_000_000


def _parse_hex(color: str) -> tuple[int, int, int]:
    normalized = color.lstrip("#")
    if len(normalized) == 3:
        normalized = "".join(ch * 2 for ch in normalized)
    value = int(normalized[:6], 16)
    return ((value >> 16) & 255, (value >> 8) & 255, value & 255)


def stitch_tiles(
    manifest: dict,
    tiles_dir: Path,
    output_path: Path,
    on_row_progress: Callable[[int, int], None] | None = None,
    background_color: str = "#ffffff",
    target_output_px: int | None = None,
) -> None:
    tile_cols = manifest["tileCols"]
    tile_rows = manifest["tileRows"]
    render_scale = manifest.get("renderScale", 1)
    tile_size = manifest.get("tilePixelSize", 256 * render_scale)
    background = _parse_hex(background_color)

    canvas_path = tiles_dir / "canvas.png"
    if canvas_path.exists():
        with Image.open(canvas_path) as canvas:
            canvas = canvas.convert("RGB")
    else:
        xs = sorted({tile["x"] for tile in manifest["tiles"]})
        ys = sorted({tile["y"] for tile in manifest["tiles"]})
        min_x, min_y = xs[0], ys[0]

        canvas_width = tile_cols * tile_size
        canvas_height = tile_rows * tile_size
        canvas = Image.new("RGB", (canvas_width, canvas_height), background)

        rows_seen: set[int] = set()
        for tile in manifest["tiles"]:
            x = tile["x"]
            y = tile["y"]
            tile_path = tiles_dir / f"tile_{x}_{y}.png"
            if not tile_path.exists():
                raise FileNotFoundError(f"Missing rendered tile: {tile_path}")

            with Image.open(tile_path) as tile_image:
                if tile_image.size != (tile_size, tile_size):
                    raise ValueError(
                        f"Tile {tile_path.name} is {tile_image.size[0]}x{tile_image.size[1]}, "
                        f"expected {tile_size}x{tile_size}"
                    )
                canvas.paste(
                    tile_image.convert("RGB"),
                    ((x - min_x) * tile_size, (y - min_y) * tile_size),
                )

            row_index = y - min_y + 1
            if y not in rows_seen:
                rows_seen.add(y)
                if on_row_progress:
                    on_row_progress(row_index, tile_rows)

    if on_row_progress and canvas_path.exists():
        on_row_progress(tile_rows, tile_rows)

    crop = manifest["cropBox"]
    crop_box = (
        crop["left"] * render_scale,
        crop["top"] * render_scale,
        (crop["left"] + crop["width"]) * render_scale,
        (crop["top"] + crop["height"]) * render_scale,
    )
    cropped = canvas.crop(crop_box)

    square = max(cropped.width, cropped.height)
    if cropped.width != square or cropped.height != square:
        square_image = Image.new("RGB", (square, square), background)
        paste_x = (square - cropped.width) // 2
        paste_y = (square - cropped.height) // 2
        square_image.paste(cropped, (paste_x, paste_y))
        cropped = square_image

    upscale_to = target_output_px or square
    if cropped.width != upscale_to:
        cropped = cropped.resize((upscale_to, upscale_to), Image.Resampling.LANCZOS)

    if output_path.suffix.lower() in {".jpg", ".jpeg"}:
        cropped.save(output_path, format="JPEG", quality=98)
    else:
        cropped.save(output_path)

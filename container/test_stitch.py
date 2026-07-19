"""Verify tile stitching places rows/columns at exact pixel offsets."""
from pathlib import Path
import tempfile

from PIL import Image, ImageDraw

from stitch import stitch_tiles


def _make_tile(path: Path, size: int, label: str, color: tuple[int, int, int]) -> None:
    image = Image.new("RGB", (size, size), color)
    draw = ImageDraw.Draw(image)
    draw.rectangle((4, 4, size - 5, size - 5), outline=(0, 0, 0), width=3)
    draw.text((12, 12), label, fill=(0, 0, 0))
    image.save(path)


def main() -> None:
    tile_size = 128
    manifest = {
        "zoom": 14,
        "tiles": [
            {"x": 10, "y": 20},
            {"x": 11, "y": 20},
            {"x": 12, "y": 20},
            {"x": 10, "y": 21},
            {"x": 11, "y": 21},
            {"x": 12, "y": 21},
            {"x": 10, "y": 22},
            {"x": 11, "y": 22},
            {"x": 12, "y": 22},
        ],
        "tileCols": 3,
        "tileRows": 3,
        "cropBox": {"left": 32, "top": 32, "width": 320, "height": 320},
        "renderScale": 1,
        "tilePixelSize": tile_size,
        "targetOutputPx": 320,
    }

    with tempfile.TemporaryDirectory() as tmp:
        tiles_dir = Path(tmp) / "tiles"
        tiles_dir.mkdir()
        colors = {
            (0, 0): (255, 200, 200),
            (1, 0): (200, 255, 200),
            (2, 0): (200, 200, 255),
            (0, 1): (255, 255, 200),
            (1, 1): (255, 200, 255),
            (2, 1): (200, 255, 255),
            (0, 2): (220, 180, 140),
            (1, 2): (180, 220, 140),
            (2, 2): (180, 140, 220),
        }
        for tile in manifest["tiles"]:
            col = tile["x"] - 10
            row = tile["y"] - 20
            label = f"{col},{row}"
            _make_tile(
                tiles_dir / f"tile_{tile['x']}_{tile['y']}.png",
                tile_size,
                label,
                colors[(col, row)],
            )

        output = Path(tmp) / "out.jpg"
        stitch_tiles(manifest, tiles_dir, output, background_color="#ffffff", target_output_px=320)

        with Image.open(output) as result:
            assert result.size == (320, 320)
            # Continuity check across the horizontal seam between rows 0 and 1.
            seam_y = 96  # crop top 32 + one tile row 64 = 96 in output crop space
            left = result.getpixel((40, seam_y - 1))
            right = result.getpixel((40, seam_y))
            assert left == right or abs(left[0] - right[0]) < 40, (
                f"Horizontal seam mismatch at y={seam_y}: {left} vs {right}"
            )

    print("stitch tests passed")


if __name__ == "__main__":
    main()

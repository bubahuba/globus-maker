"""Center-based spherical pre-warp before stereographic stripe projection.

Expands the map center (BarrelInverse) so stroke widths near the center stay
balanced after slize.pl stereographic → transverse-mercator remapping.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

# Mild center-expand for stereographic compensation.
# ImageMagick BarrelInverse: Rsrc = r*(A*r^3 + B*r^2 + C*r + D);
# D ≈ 1-C keeps the rim radius approximately fixed.
BARREL_INVERSE_ARGS = "0.0 0.0 -0.12 1.12"
JPEG_QUALITY = 98


def _magick_bin() -> str:
    for name in ("magick", "convert"):
        if shutil.which(name):
            return name
    raise FileNotFoundError("ImageMagick not found (magick/convert)")


def spherical_prewarp(
    image_path: Path,
    *,
    barrel_args: str = BARREL_INVERSE_ARGS,
    quality: int = JPEG_QUALITY,
) -> None:
    """Overwrite image_path with a center-expanding BarrelInverse warp in place."""
    image_path = Path(image_path)
    if not image_path.is_file():
        raise FileNotFoundError(f"Missing image for prewarp: {image_path}")

    magick = _magick_bin()
    suffix = image_path.suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=image_path.parent) as tmp:
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            magick,
            str(image_path),
            "-distort",
            "BarrelInverse",
            barrel_args,
        ]
        if suffix.lower() in {".jpg", ".jpeg"}:
            cmd.extend(["-quality", str(quality)])
        cmd.append(str(tmp_path))
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        tmp_path.replace(image_path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise

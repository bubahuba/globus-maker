"""Center-based spherical pre-warp before stereographic stripe projection.

Compresses the map center (BarrelInverse) so features near the pole appear
smaller before slize.pl stereographic → transverse-mercator remapping.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

# Center-compress for stereographic compensation.
# ImageMagick BarrelInverse: Rsrc = r*(A*r^3 + B*r^2 + C*r + D);
# D ≈ 1-C keeps the rim radius approximately fixed.
# Positive C (<1) shrinks the center; negative C expands it.
BARREL_INVERSE_ARGS = "0.0 0.0 0.35 0.65"
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
    background_color: str = "#e8eddb",
) -> None:
    """Overwrite image_path with a center-compressing BarrelInverse warp in place."""
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
            "-background",
            background_color,
            "-virtual-pixel",
            "Background",
            "-distort",
            "BarrelInverse",
            barrel_args,
        ]
        if suffix.lower() in {".jpg", ".jpeg"}:
            cmd.extend(["-quality", str(quality)])
        cmd.append(str(tmp_path))
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
            raise RuntimeError(f"ImageMagick prewarp failed: {detail}")
        tmp_path.replace(image_path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise

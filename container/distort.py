"""Center-based spherical pre-warp before stereographic stripe projection.

Compresses the map center (BarrelInverse) so features near the pole appear
smaller before slize.pl stereographic → transverse-mercator remapping.

Also builds the sphere-preview texture via ImageMagick DePolar on the
prewarped square map (centre = north pole).
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

# Sphere WebGL preview — keep under typical browser/decode limits.
SPHERE_PREVIEW_MAX_EDGE = 6000


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


def _identify_size(image_path: Path) -> tuple[int, int]:
    magick = _magick_bin()
    result = subprocess.run(
        [magick, "identify", "-format", "%w %h", str(image_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
        raise RuntimeError(f"ImageMagick identify failed: {detail}")
    parts = (result.stdout or "").strip().split()
    if len(parts) != 2:
        raise RuntimeError(f"Unexpected identify output: {result.stdout!r}")
    return int(parts[0]), int(parts[1])


def build_depolar_sphere_preview(
    source: Path,
    dest: Path,
    *,
    max_edge: int = SPHERE_PREVIEW_MAX_EDGE,
    quality: int = 85,
    background_color: str = "#e8eddb",
) -> Path:
    """Unwrap a centre-north square map with DePolar for sphere equirect UVs.

    Uses ``Rmax=-1`` (radius to the furthest corner): top = centre / north pole,
    bottom = scalloped corners with mid-side gaps filled via Background VP.
    See https://usage.imagemagick.org/distorts/#depolar
    """
    source = Path(source)
    dest = Path(dest)
    if not source.is_file():
        raise FileNotFoundError(f"Missing image for DePolar preview: {source}")

    magick = _magick_bin()
    width, height = _identify_size(source)
    work_edge = min(max_edge, max(width, height))
    out_w = max_edge if max_edge % 2 == 0 else max_edge - 1
    out_h = max(1, out_w // 2)

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=dest.parent) as tmp:
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            magick,
            str(source),
            "-resize",
            f"{work_edge}x{work_edge}>",
            "-background",
            background_color,
            "-virtual-pixel",
            "Background",
            "-distort",
            "DePolar",
            "-1",
            "-resize",
            f"{out_w}x{out_h}!",
            "-quality",
            str(quality),
            str(tmp_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size <= 0:
            detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
            raise RuntimeError(f"ImageMagick DePolar preview failed: {detail}")
        tmp_path.replace(dest)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise

    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("DePolar sphere preview produced an empty file")
    return dest

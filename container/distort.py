"""Raster helpers for sphere preview and optional JPEG BarrelInverse.

Primary paths use svg_warp / slize.pl for stripes. This module still provides:
- ImageMagick BarrelInverse for JPEG prewarp
- SVG→JPEG rasterization
- Sphere preview: DePolar unwrap of the prewarped map (equirect for WebGL)
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

# Center-compress for stereographic compensation.
# ImageMagick BarrelInverse samples: Rsrc = Rd / (A*Rd^3 + B*Rd^2 + C*Rd + D);
# D ≈ 1-C keeps the rim radius approximately fixed.
BARREL_INVERSE_ARGS = "0.0 0.0 0.35 0.65"
JPEG_QUALITY = 98

# Sphere WebGL preview — keep under typical browser/decode limits.
SPHERE_PREVIEW_MAX_EDGE = 6000


def _magick_bin() -> str:
    for name in ("magick", "convert"):
        if shutil.which(name):
            return name
    raise FileNotFoundError("ImageMagick not found (magick/convert)")


def rasterize_svg(
    svg_path: Path,
    dest: Path,
    *,
    max_edge: int = SPHERE_PREVIEW_MAX_EDGE,
    quality: int = 90,
    background_color: str = "#e8eddb",
) -> Path:
    """Rasterize an SVG to JPEG via ImageMagick (needs SVG delegate / rsvg)."""
    svg_path = Path(svg_path)
    dest = Path(dest)
    if not svg_path.is_file():
        raise FileNotFoundError(f"Missing SVG: {svg_path}")

    magick = _magick_bin()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=dest.parent) as tmp:
        tmp_path = Path(tmp.name)
    try:
        cmd = [
            magick,
            "-background",
            background_color,
            str(svg_path),
            "-resize",
            f"{max_edge}x{max_edge}>",
            "-quality",
            str(quality),
            str(tmp_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size <= 0:
            detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
            raise RuntimeError(f"ImageMagick SVG rasterize failed: {detail}")
        tmp_path.replace(dest)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise
    return dest


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


def build_stripe_sphere_preview(
    stripe_paths: list[Path],
    dest: Path,
    *,
    max_edge: int = SPHERE_PREVIEW_MAX_EDGE,
    quality: int = 85,
    background_color: str = "#e8eddb",
) -> Path:
    """Build an equirectangular globe texture from the N stripe gores.

    Stripes are laid out left→right (``out-00`` … ``out-(n-1)``) so the WebGL
    sphere shows exactly ``len(stripe_paths)`` longitudinal gores — not a
    DePolar unwrap of the square map.
    """
    paths = [Path(p) for p in stripe_paths]
    if not paths:
        raise ValueError("Need at least one stripe for sphere preview")
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(f"Missing stripe for sphere preview: {path}")

    dest = Path(dest)
    n = len(paths)
    # Even width, exact 2:1, columns divide cleanly across gores.
    out_w = max_edge if max_edge % 2 == 0 else max_edge - 1
    # Prefer width divisible by stripe count for sharp seams.
    col_w = max(1, out_w // n)
    out_w = col_w * n
    if out_w % 2:
        col_w += 1
        out_w = col_w * n
    out_h = max(1, out_w // 2)

    magick = _magick_bin()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=dest.parent) as tmp:
        tmp_path = Path(tmp.name)

    try:
        # Rasterize each gore to the same column size, then +append.
        cmd: list[str] = [magick, "-background", background_color]
        for path in paths:
            cmd.extend(
                [
                    "(",
                    str(path),
                    "-background",
                    background_color,
                    "-resize",
                    f"{col_w}x{out_h}!",
                    ")",
                ]
            )
        cmd.extend(
            [
                "+append",
                "-quality",
                str(quality),
                str(tmp_path),
            ]
        )
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size <= 0:
            detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
            raise RuntimeError(f"Stripe sphere preview failed: {detail}")
        tmp_path.replace(dest)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise

    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("Stripe sphere preview produced an empty file")
    return dest


def build_depolar_sphere_preview(
    source: Path,
    dest: Path,
    *,
    max_edge: int = SPHERE_PREVIEW_MAX_EDGE,
    quality: int = 85,
    background_color: str = "#e8eddb",
) -> Path:
    """Legacy DePolar unwrap (kept for tests). Prefer ``build_stripe_sphere_preview``."""
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

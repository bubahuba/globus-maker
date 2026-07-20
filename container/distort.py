"""Raster helpers for sphere preview and optional JPEG BarrelInverse.

Primary paths use svg_warp / slize.pl for stripes. This module still provides:
- ImageMagick BarrelInverse for JPEG prewarp
- SVG→JPEG rasterization
- Sphere preview: DePolar unwrap of the stitched map (equirect for WebGL)
- Pole caps sheet: north (prewarped centre) + empty-fill south, white outside
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from svg_warp import NONA_MID_EDGE_Y_FRAC

# Center-compress for stereographic compensation.
# ImageMagick BarrelInverse samples: Rsrc = Rd / (A*Rd^3 + B*Rd^2 + C*Rd + D);
# D ≈ 1-C keeps the rim radius approximately fixed.
BARREL_INVERSE_ARGS = "0.0 0.0 0.35 0.65"
JPEG_QUALITY = 98

# Sphere WebGL preview — keep under typical browser/decode limits.
SPHERE_PREVIEW_MAX_EDGE = 6000

# Print scale matches BE ``stripeHeightPx = diameterCm × 160``.
PRINT_PX_PER_CM = 160.0
# Physical circular cover diameter glued over converging stripe tips.
POLE_CAP_DIAMETER_CM = 5.0
# Cap imagery is slightly larger than the 1:1 prewarp→stripe match for glue overlap.
POLE_CAP_ENLARGE = 1.06


def pole_cap_source_radius_px(
    map_size: float,
    globe_diameter_cm: float,
    *,
    cap_diameter_cm: float = POLE_CAP_DIAMETER_CM,
    enlarge: float = POLE_CAP_ENLARGE,
    mid_edge_y_frac: float = NONA_MID_EDGE_Y_FRAC,
) -> float:
    """Radius in the prewarped square for a printed cap of ``cap_diameter_cm``.

    Near the map centre, ``nona``/stripe unwrap is approximately linear:
    ``y_frac ≈ (r / r_mid) * mid_edge_y_frac``. Printed stripe height equals
    ``globe_diameter_cm`` at ``PRINT_PX_PER_CM``, so a physical distance ``d`` cm
    from the tip corresponds to source radius
    ``r = r_mid * d / (mid_edge_y_frac * globe_diameter_cm)``.

    ``enlarge > 1`` takes a slightly smaller source disk so the printed cap is
    magnified relative to the prewarped map (easier physical overlap).
    """
    if map_size <= 0 or globe_diameter_cm <= 0 or cap_diameter_cm <= 0:
        raise ValueError("map_size, globe_diameter_cm, and cap_diameter_cm must be positive")
    if enlarge <= 0:
        raise ValueError("enlarge must be positive")
    if mid_edge_y_frac <= 0:
        raise ValueError("mid_edge_y_frac must be positive")

    r_mid = map_size / 2.0
    match_cm = (cap_diameter_cm / 2.0) / enlarge
    src_r = r_mid * match_cm / (mid_edge_y_frac * globe_diameter_cm)
    return min(src_r, r_mid)


def pole_cap_output_side_px(cap_diameter_cm: float = POLE_CAP_DIAMETER_CM) -> int:
    """Square JPEG side length at the same print DPI as the stripes."""
    if cap_diameter_cm <= 0:
        raise ValueError("cap_diameter_cm must be positive")
    return max(1, int(round(cap_diameter_cm * PRINT_PX_PER_CM)))


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
            "-background",
            background_color,
            "-alpha",
            "remove",
            "-alpha",
            "off",
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


def pole_caps_canvas_size_px(
    cap_diameter_cm: float = POLE_CAP_DIAMETER_CM,
    *,
    gap_px: int | None = None,
) -> tuple[int, int]:
    """Width × height of the two-circle pole-caps sheet (side by side on white)."""
    side = pole_cap_output_side_px(cap_diameter_cm)
    gap = max(0, int(round(0.25 * PRINT_PX_PER_CM)) if gap_px is None else gap_px)
    return side * 2 + gap, side


def build_pole_caps(
    image_path: Path,
    dest: Path,
    *,
    diameter_cm: float,
    cap_diameter_cm: float = POLE_CAP_DIAMETER_CM,
    enlarge: float = POLE_CAP_ENLARGE,
    quality: int = JPEG_QUALITY,
    empty_fill: str = "#e8eddb",
) -> Path:
    """One JPEG with two equal circles on a white sheet.

    Left: north pole — circular crop of the prewarped map centre, print-scaled
    to the stripe tips (slightly enlarged via ``enlarge`` for glue overlap).
    Right: south pole — same diameter, solid ``empty_fill`` only.
    Outside both circle masks is white.
    """
    image_path = Path(image_path)
    dest = Path(dest)
    if not image_path.is_file():
        raise FileNotFoundError(f"Missing image for pole caps: {image_path}")

    width, height = _identify_size(image_path)
    map_size = float(min(width, height))
    src_r = pole_cap_source_radius_px(
        map_size,
        diameter_cm,
        cap_diameter_cm=cap_diameter_cm,
        enlarge=enlarge,
    )
    # Even crop side so the circle centre lands on a pixel.
    crop = max(2, int(math.ceil(src_r * 2.0)))
    if crop % 2:
        crop += 1
    crop = min(crop, int(map_size) if int(map_size) % 2 == 0 else int(map_size) - 1)
    crop = max(2, crop)
    cx = cy = (crop - 1) / 2.0
    # Draw radius reaches the mid-edge of the square crop.
    draw_r = crop / 2.0 - 0.5
    out_side = pole_cap_output_side_px(cap_diameter_cm)
    gap = max(0, int(round(0.25 * PRINT_PX_PER_CM)))
    out_cx = out_cy = (out_side - 1) / 2.0
    out_draw_r = out_side / 2.0 - 0.5

    magick = _magick_bin()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=dest.parent) as tmp:
        tmp_path = Path(tmp.name)

    try:
        # North: map centre → circle, white outside.
        # South: empty-fill circle of the same output size, white outside.
        # Append horizontally with a white gap.
        cmd = [
            magick,
            "(",
            str(image_path),
            "-gravity",
            "Center",
            "-crop",
            f"{crop}x{crop}+0+0",
            "+repage",
            "(",
            "-size",
            f"{crop}x{crop}",
            "xc:Black",
            "-fill",
            "White",
            "-draw",
            f"circle {cx},{cy} {cx + draw_r},{cy}",
            ")",
            "-alpha",
            "off",
            "-compose",
            "CopyOpacity",
            "-composite",
            "-background",
            "White",
            "-alpha",
            "remove",
            "-alpha",
            "off",
            "-resize",
            f"{out_side}x{out_side}!",
            ")",
            "(",
            "-size",
            f"{gap}x{out_side}",
            "xc:White",
            ")",
            "(",
            "-size",
            f"{out_side}x{out_side}",
            "xc:White",
            "-fill",
            empty_fill,
            "-draw",
            f"circle {out_cx},{out_cy} {out_cx + out_draw_r},{out_cy}",
            ")",
            "+append",
            "-quality",
            str(quality),
            str(tmp_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size <= 0:
            detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
            raise RuntimeError(f"ImageMagick pole caps failed: {detail}")
        tmp_path.replace(dest)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise

    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("Pole caps produced an empty file")
    return dest


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
            "-alpha",
            "remove",
            "-alpha",
            "off",
            "-virtual-pixel",
            "Background",
            "-distort",
            "DePolar",
            "-1",
            "-background",
            background_color,
            "-alpha",
            "remove",
            "-alpha",
            "off",
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

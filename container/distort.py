"""Raster helpers for sphere preview and optional JPEG BarrelInverse.

Primary paths use svg_warp / slize.pl for stripes. This module still provides:
- ImageMagick BarrelInverse for JPEG prewarp
- SVG→JPEG rasterization
- Sphere preview: DePolar unwrap of the stitched map (equirect for WebGL)
- Pole caps sheet: north (prewarped centre) + empty-fill south, white outside
- Yellow lens cut-line overlay on meridian stripe JPEGs
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

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
# Physical circular cover cut diameter glued over converging stripe tips.
POLE_CAP_DIAMETER_CM = 5.0
# Cap imagery is slightly larger than the 1:1 prewarp→stripe match for glue overlap.
POLE_CAP_ENLARGE = 1.06
# Printed circular mask extends past the yellow cut circle (bleed beyond the cut line).
POLE_CAP_MASK_BLEED = 1.04
# Tiny yellow centre mark on each cap (helps align the cut-out).
POLE_CAP_CENTER_MARK_DIAMETER_CM = 0.2

# Meridian gore cut guide (yellow lens) on each stripe JPEG.
CUT_LINE_COLOR = (255, 220, 0)
# Fatten the sinusoidal gore slightly so neighbouring stripes overlap when cut.
CUT_LINE_ENLARGE = 1.04
# ~0.15 mm at print DPI — thin enough to stay a guide, thick enough to see.
CUT_LINE_STROKE_CM = 0.015


def stripe_cut_line_half_width(
    y: float,
    *,
    width: float,
    height: float,
    enlarge: float = CUT_LINE_ENLARGE,
    edge_pad: float = 0.0,
) -> float:
    """Half-width of the sphere-gore lens at row ``y`` (sinusoidal meridians).

    ``enlarge > 1`` fattens the pure ``sin`` gore so the cut is slightly larger
    than a 1:1 sphere sector (glue overlap with the neighbour stripe).
    """
    if width <= 0 or height <= 1:
        return 0.0
    if enlarge <= 0:
        raise ValueError("enlarge must be positive")
    t = max(0.0, min(1.0, y / (height - 1.0)))
    half = max(0.0, (width - 1.0) / 2.0 - edge_pad)
    return half * min(1.0, enlarge * math.sin(math.pi * t))


def stripe_cut_line_polygon(
    width: int,
    height: int,
    *,
    enlarge: float = CUT_LINE_ENLARGE,
    stroke_px: float = 2.0,
    samples: int | None = None,
) -> list[tuple[float, float]]:
    """Closed polygon for the lens cut-line (left meridian + right reversed)."""
    if width < 2 or height < 2:
        return []
    n = samples if samples is not None else max(64, height // 2)
    n = max(16, n)
    pad = max(0.0, stroke_px / 2.0)
    cx = (width - 1) / 2.0
    left: list[tuple[float, float]] = []
    for i in range(n + 1):
        y = (height - 1) * (i / n)
        hw = stripe_cut_line_half_width(
            y, width=float(width), height=float(height), enlarge=enlarge, edge_pad=pad
        )
        left.append((cx - hw, y))
    right = [(cx + (cx - x), y) for x, y in reversed(left)]
    return left + right


def draw_stripe_cut_line(
    image_path: Path,
    dest: Path | None = None,
    *,
    enlarge: float = CUT_LINE_ENLARGE,
    color: tuple[int, int, int] = CUT_LINE_COLOR,
    stroke_cm: float = CUT_LINE_STROKE_CM,
    quality: int = JPEG_QUALITY,
) -> Path:
    """Overlay a tiny yellow sphere-gore lens cut-line onto a stripe JPEG.

    The lens follows sinusoidal meridians (classic globe gore / football shape),
    fattened by ``enlarge`` so adjacent cut stripes share a little glue overlap.
    """
    image_path = Path(image_path)
    dest = Path(dest) if dest is not None else image_path
    if not image_path.is_file():
        raise FileNotFoundError(f"Missing stripe image: {image_path}")

    with Image.open(image_path) as src:
        img = src.convert("RGB")
    w, h = img.size
    stroke_px = max(1, int(round(stroke_cm * PRINT_PX_PER_CM)))
    poly = stripe_cut_line_polygon(w, h, enlarge=enlarge, stroke_px=float(stroke_px))
    if len(poly) >= 3:
        draw = ImageDraw.Draw(img)
        draw.line(poly + [poly[0]], fill=color, width=stroke_px, joint="curve")

    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.resolve() == image_path.resolve():
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=dest.parent) as tmp:
            tmp_path = Path(tmp.name)
        try:
            img.save(tmp_path, format="JPEG", quality=quality, optimize=True)
            tmp_path.replace(dest)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise
    else:
        img.save(dest, format="JPEG", quality=quality, optimize=True)
    return dest


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


def pole_cap_cut_radius_px(cap_diameter_cm: float = POLE_CAP_DIAMETER_CM) -> float:
    """Radius of the yellow cut circle at print DPI."""
    if cap_diameter_cm <= 0:
        raise ValueError("cap_diameter_cm must be positive")
    return (cap_diameter_cm * PRINT_PX_PER_CM) / 2.0


def pole_cap_output_side_px(
    cap_diameter_cm: float = POLE_CAP_DIAMETER_CM,
    *,
    mask_bleed: float = POLE_CAP_MASK_BLEED,
) -> int:
    """Square cell side for one cap (mask diameter, including bleed past the cut line)."""
    if cap_diameter_cm <= 0:
        raise ValueError("cap_diameter_cm must be positive")
    if mask_bleed <= 0:
        raise ValueError("mask_bleed must be positive")
    return max(1, int(round(cap_diameter_cm * mask_bleed * PRINT_PX_PER_CM)))


def _ellipse_bbox(cx: float, cy: float, radius: float) -> tuple[float, float, float, float]:
    return (cx - radius, cy - radius, cx + radius, cy + radius)


def _draw_cap_cut_guides(
    draw: ImageDraw.ImageDraw,
    *,
    cx: float,
    cy: float,
    cut_radius: float,
    center_mark_radius: float,
    stroke_px: int,
    color: tuple[int, int, int] = CUT_LINE_COLOR,
) -> None:
    """Yellow cut circle (cap diameter) + small centre mark."""
    if stroke_px < 1:
        stroke_px = 1
    if cut_radius > stroke_px:
        draw.ellipse(
            _ellipse_bbox(cx, cy, cut_radius),
            outline=color,
            width=stroke_px,
        )
    if center_mark_radius > stroke_px / 2.0:
        draw.ellipse(
            _ellipse_bbox(cx, cy, center_mark_radius),
            outline=color,
            width=stroke_px,
        )


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
    mask_bleed: float = POLE_CAP_MASK_BLEED,
) -> tuple[int, int]:
    """Width × height of the two-circle pole-caps sheet (side by side on white)."""
    side = pole_cap_output_side_px(cap_diameter_cm, mask_bleed=mask_bleed)
    gap = max(0, int(round(0.25 * PRINT_PX_PER_CM)) if gap_px is None else gap_px)
    return side * 2 + gap, side


def _parse_hex_rgb(color: str) -> tuple[int, int, int]:
    raw = color.strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) != 6:
        raise ValueError(f"Expected #RRGGBB color, got {color!r}")
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


def _circular_cap_cell(
    fill_rgb: tuple[int, int, int] | Image.Image,
    *,
    side: int,
    mask_radius: float,
    cut_radius: float,
    center_mark_radius: float,
    stroke_px: int,
) -> Image.Image:
    """White square with a circular fill (solid or image) + yellow cut guides."""
    cell = Image.new("RGB", (side, side), (255, 255, 255))
    cx = cy = (side - 1) / 2.0
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).ellipse(_ellipse_bbox(cx, cy, mask_radius), fill=255)

    if isinstance(fill_rgb, Image.Image):
        content = fill_rgb.convert("RGB").resize((side, side), Image.Resampling.LANCZOS)
    else:
        content = Image.new("RGB", (side, side), fill_rgb)

    cell.paste(content, (0, 0), mask)
    draw = ImageDraw.Draw(cell)
    _draw_cap_cut_guides(
        draw,
        cx=cx,
        cy=cy,
        cut_radius=cut_radius,
        center_mark_radius=center_mark_radius,
        stroke_px=stroke_px,
    )
    return cell


def build_pole_caps(
    image_path: Path,
    dest: Path,
    *,
    diameter_cm: float,
    cap_diameter_cm: float = POLE_CAP_DIAMETER_CM,
    enlarge: float = POLE_CAP_ENLARGE,
    mask_bleed: float = POLE_CAP_MASK_BLEED,
    quality: int = JPEG_QUALITY,
    empty_fill: str = "#e8eddb",
) -> Path:
    """One JPEG with two equal circles on a white sheet.

    Left: north pole — circular crop of the prewarped map centre, print-scaled
    to the stripe tips (content enlarged via ``enlarge`` for tip glue overlap).
    Right: south pole — same size, solid ``empty_fill`` only.

    Each cap has:
    - circular mask slightly larger than the cut (``mask_bleed`` past the yellow line)
    - large yellow cut circle at ``cap_diameter_cm``
    - small yellow centre mark for aligning the cut-out
    Outside both masks is white.
    """
    image_path = Path(image_path)
    dest = Path(dest)
    if not image_path.is_file():
        raise FileNotFoundError(f"Missing image for pole caps: {image_path}")
    if mask_bleed < 1.0:
        raise ValueError("mask_bleed must be >= 1 so the mask covers the cut line")

    with Image.open(image_path) as src_img:
        src = src_img.convert("RGB")
    map_size = float(min(src.size))
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

    sw, sh = src.size
    left = max(0, (sw - crop) // 2)
    top = max(0, (sh - crop) // 2)
    north_src = src.crop((left, top, left + crop, top + crop))

    side = pole_cap_output_side_px(cap_diameter_cm, mask_bleed=mask_bleed)
    cut_r = pole_cap_cut_radius_px(cap_diameter_cm)
    stroke_px = max(1, int(round(CUT_LINE_STROKE_CM * PRINT_PX_PER_CM)))
    # Mask fills the cell (bleed past the yellow cut circle); keep a tiny inset
    # so the disc edge stays inside the square.
    mask_r = max(cut_r + stroke_px, min((side - 1) / 2.0 - 0.5, cut_r * mask_bleed))
    center_mark_r = (POLE_CAP_CENTER_MARK_DIAMETER_CM * PRINT_PX_PER_CM) / 2.0
    empty_rgb = _parse_hex_rgb(empty_fill)

    north = _circular_cap_cell(
        north_src,
        side=side,
        mask_radius=mask_r,
        cut_radius=cut_r,
        center_mark_radius=center_mark_r,
        stroke_px=stroke_px,
    )
    south = _circular_cap_cell(
        empty_rgb,
        side=side,
        mask_radius=mask_r,
        cut_radius=cut_r,
        center_mark_radius=center_mark_r,
        stroke_px=stroke_px,
    )

    gap = max(0, int(round(0.25 * PRINT_PX_PER_CM)))
    canvas_w = side * 2 + gap
    canvas = Image.new("RGB", (canvas_w, side), (255, 255, 255))
    canvas.paste(north, (0, 0))
    canvas.paste(south, (side + gap, 0))

    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=dest.parent) as tmp:
        tmp_path = Path(tmp.name)
    try:
        canvas.save(tmp_path, format="JPEG", quality=quality, optimize=True)
        tmp_path.replace(dest)
    except Exception:
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

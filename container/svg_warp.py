"""Geometric BarrelInverse + full-frame meridian stripe unwrap for SVG paths.

Stripes match the bitmap/slize.pl *frame* (full ``stripeWidth × stripeHeight``
rectangle): each gore is a polar sector of the square map unwrapped onto that
rectangle (centre → top, rim → bottom) — not a TM “lentil” floating in empty space.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

# Match container/distort.py / slize.pl stripe sizing
BARREL_INVERSE_ARGS = (0.0, 0.0, 0.35, 0.65)
# slize.pl: height span = 2 * 0.5 * h; width = 2 * 0.09 * (12/stripes) * h
TM_HALF_H = 0.5000
STRIPE_DX_BASE = 0.09  # at 12 stripes
# Vertical coverage matched to nona on a square source (see container tests):
# mid-edge of the square lands ~80.5% down the stripe; corners ~86.4%; the rest
# of the stripe below is base-fill (same as slize.pl flatten-to-background).
NONA_MID_EDGE_Y_FRAC = 0.805
NONA_CORNER_Y_FRAC = 0.864

_NS = "http://www.w3.org/2000/svg"
_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_PATH_CMD_RE = re.compile(
    rf"([MmLlHhVvCcSsQqTtAaZz])|({_NUM})"
)


def parse_barrel_args(args: str | tuple[float, ...] = BARREL_INVERSE_ARGS) -> tuple[float, float, float, float]:
    if isinstance(args, str):
        parts = [float(p) for p in re.split(r"[\s,]+", args.strip()) if p]
        if len(parts) < 3:
            raise ValueError(f"Need at least A B C for barrel args, got {args!r}")
        if len(parts) == 3:
            a, b, c = parts
            d = 1.0 - a - b - c
            return a, b, c, d
        return parts[0], parts[1], parts[2], parts[3]
    return args  # type: ignore[return-value]


def barrel_inverse_dest_radius(rsrc: float, a: float, b: float, c: float, d: float) -> float:
    """Forward map: source radius → destination radius for BarrelInverse.

    ImageMagick samples with ``Rsrc = Rd / (A*Rd³ + B*Rd² + C*Rd + D)``.
    """
    if rsrc <= 0:
        return 0.0
    # Solve Rsrc * (A Rd³ + B Rd² + C Rd + D) = Rd
    # → A Rsrc Rd³ + B Rsrc Rd² + (C Rsrc - 1) Rd + D Rsrc = 0
    lo, hi = 0.0, max(rsrc * 4.0, 2.0)
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        poly = ((a * mid + b) * mid + c) * mid + d
        if poly <= 1e-12:
            hi = mid
            continue
        pred = mid / poly
        if pred < rsrc:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def barrel_inverse_point(
    x: float,
    y: float,
    *,
    cx: float,
    cy: float,
    r_scale: float,
    coeffs: tuple[float, float, float, float] = BARREL_INVERSE_ARGS,
) -> tuple[float, float]:
    """Warp one point from unwarped map space into BarrelInverse destination space."""
    a, b, c, d = coeffs
    dx = x - cx
    dy = y - cy
    r_px = math.hypot(dx, dy)
    if r_px < 1e-9 or r_scale <= 0:
        return x, y
    rsrc = r_px * r_scale  # normalized (1.0 = half min side)
    rd = barrel_inverse_dest_radius(rsrc, a, b, c, d)
    scale = (rd / rsrc) if rsrc else 1.0
    return cx + dx * scale, cy + dy * scale


def stripe_dimensions(stripe_height: float, stripes: int) -> tuple[float, float]:
    """Same frame size as slize.pl / BE ``stripeWidthPx`` × ``stripeHeightPx``."""
    dx = STRIPE_DX_BASE * (12.0 / stripes)
    width = 2.0 * dx * stripe_height
    height = 2.0 * TM_HALF_H * stripe_height
    return width, height


def project_map_point_to_stripe(
    x: float,
    y: float,
    *,
    map_size: float,
    stripe_height: float,
    stripes: int,
    yaw_deg: float,
) -> tuple[float, float] | None:
    """Unwrap one meridian sector of the square map into a stripe rectangle.

    - Bearing relative to the gore → full stripe width (no TM lentil).
    - Radius from map centre → vertical position with the same coverage as
      ``nona``/``slize.pl``: mid-edge and corners stop above the bottom, so the
      lower band stays base-fill color.
    """
    if map_size <= 0 or stripes < 1:
        return None
    cx = cy = map_size / 2.0
    dx = x - cx
    dy = cy - y  # image up
    r = math.hypot(dx, dy)

    # Bearing: 0° = up (toward top of map).
    bearing = math.degrees(math.atan2(dx, dy)) if r > 1e-9 else 0.0
    rel = (bearing - yaw_deg + 180.0) % 360.0 - 180.0
    half = 180.0 / stripes
    # Tiny overlap so seams don't drop shared edges.
    if abs(rel) > half * 1.001:
        return None

    sw, sh = stripe_dimensions(stripe_height, stripes)
    r_mid = map_size / 2.0
    r_corner = r_mid * math.sqrt(2.0)
    if r > r_corner + 1e-6:
        return None

    # Piecewise-linear radius→y matched to nona marker positions.
    if r <= r_mid or r_mid <= 0:
        y_frac = (r / r_mid) * NONA_MID_EDGE_Y_FRAC if r_mid > 0 else 0.0
    else:
        t = (r - r_mid) / (r_corner - r_mid)
        y_frac = NONA_MID_EDGE_Y_FRAC + t * (NONA_CORNER_Y_FRAC - NONA_MID_EDGE_Y_FRAC)

    px = (rel / half) * 0.5 * sw + 0.5 * sw
    py = y_frac * sh
    return px, py


# --- SVG path rewriting -----------------------------------------------------

def _fmt(n: float) -> str:
    if abs(n) < 1e-6:
        return "0"
    s = f"{n:.3f}"
    s = s.rstrip("0").rstrip(".")
    return s or "0"


def _densify_segment(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    *,
    max_step: float,
) -> list[tuple[float, float]]:
    """Return intermediate points along a segment (excluding start, including end)."""
    dist = math.hypot(x1 - x0, y1 - y0)
    if dist <= max_step or max_step <= 0:
        return [(x1, y1)]
    steps = max(1, int(math.ceil(dist / max_step)))
    return [
        (x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps))
        for i in range(1, steps + 1)
    ]


def _transform_path_d(
    d: str,
    mapper: Callable[[float, float], tuple[float, float] | None],
    *,
    densify_step: float = 0.0,
) -> str | None:
    """Apply mapper(x,y)->(x',y')|None to an SVG path `d` (absolute M/L/Z only)."""
    tokens = _PATH_CMD_RE.findall(d)
    if not tokens:
        return None

    out: list[str] = []
    cmd = ""
    nums: list[float] = []
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    any_kept = False
    pen_up = True

    def emit(mx: float, my: float) -> None:
        nonlocal any_kept, pen_up, start
        any_kept = True
        if pen_up:
            out.append(f"M{_fmt(mx)},{_fmt(my)}")
            start = (mx, my)
            pen_up = False
        else:
            out.append(f"L{_fmt(mx)},{_fmt(my)}")

    def flush_nums() -> None:
        nonlocal nums, cur, start, any_kept, cmd, pen_up
        if not cmd:
            nums = []
            return
        c = cmd
        if c in "Zz":
            if any_kept and not pen_up and (not out or out[-1] != "Z"):
                # Close only if start still maps (approximate with line to start)
                out.append("Z")
            pen_up = True
            cur = start
            nums = []
            cmd = ""
            return
        if c in "MmLl":
            i = 0
            absolute = c in "ML"
            is_move = c in "Mm"
            while i + 1 < len(nums):
                x, y = nums[i], nums[i + 1]
                i += 2
                if not absolute:
                    x += cur[0]
                    y += cur[1]
                if is_move:
                    cur = (x, y)
                    mapped = mapper(x, y)
                    if mapped is None:
                        pen_up = True
                    else:
                        emit(mapped[0], mapped[1])
                    is_move = False
                    continue

                samples = (
                    _densify_segment(cur[0], cur[1], x, y, max_step=densify_step)
                    if densify_step > 0
                    else [(x, y)]
                )
                for sx, sy in samples:
                    mapped = mapper(sx, sy)
                    if mapped is None:
                        pen_up = True
                    else:
                        emit(mapped[0], mapped[1])
                cur = (x, y)
        nums = []
        cmd = ""

    for kind, num in tokens:
        if kind:
            flush_nums()
            cmd = kind
            if kind in "Zz":
                flush_nums()
        else:
            nums.append(float(num))
    flush_nums()
    return "".join(out) if any_kept else None


_ROTATE_RE = re.compile(
    r"rotate\(\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)"
    r"(?:\s*,?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)"
    r"\s*,?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))?\s*\)"
)


def _parse_text_rotate(transform: str | None) -> float | None:
    """Return the SVG rotate angle (degrees) from a transform attribute, if any."""
    if not transform:
        return None
    match = _ROTATE_RE.search(transform)
    if not match:
        return None
    return float(match.group(1))


def _readable_angle(angle_deg: float) -> float:
    """Keep label angle in (-90, 90] so text stays upright-ish."""
    while angle_deg > 90:
        angle_deg -= 180
    while angle_deg <= -90:
        angle_deg += 180
    return angle_deg


def _transform_text_element(
    elem: ET.Element,
    mapper: Callable[[float, float], tuple[float, float] | None],
) -> None:
    """Remap text anchor and recompute rotate() so street labels follow the warp."""
    try:
        x = float(elem.attrib.get("x", "0"))
        y = float(elem.attrib.get("y", "0"))
    except ValueError:
        elem.set("data-empty", "1")
        return

    mapped = mapper(x, y)
    if mapped is None:
        elem.set("data-empty", "1")
        return
    mx, my = mapped
    elem.attrib["x"] = _fmt(mx)
    elem.attrib["y"] = _fmt(my)

    # svg_map stores rotate(-street_angle, x, y); recover street_angle and
    # re-estimate it after the warp by mapping a short tangent step.
    svg_rotate = _parse_text_rotate(elem.attrib.get("transform"))
    if svg_rotate is None:
        elem.attrib.pop("transform", None)
        return

    street_angle = -svg_rotate
    # Step length in source pixels — large enough for a stable atan2 after warp.
    delta = 8.0
    rad = math.radians(street_angle)
    x1 = x + math.cos(rad) * delta
    y1 = y + math.sin(rad) * delta
    mapped1 = mapper(x1, y1)
    if mapped1 is None:
        # Try the opposite direction along the street.
        mapped1 = mapper(x - math.cos(rad) * delta, y - math.sin(rad) * delta)
        if mapped1 is None:
            elem.attrib.pop("transform", None)
            return
        mx1, my1 = mapped1
        new_street = math.degrees(math.atan2(my - my1, mx - mx1))
    else:
        mx1, my1 = mapped1
        new_street = math.degrees(math.atan2(my1 - my, mx1 - mx))

    new_street = _readable_angle(new_street)
    if abs(new_street) < 0.5:
        elem.attrib.pop("transform", None)
    else:
        elem.attrib["transform"] = f"rotate({_fmt(-new_street)} {_fmt(mx)} {_fmt(my)})"


def _walk_and_transform(
    elem: ET.Element,
    mapper: Callable[[float, float], tuple[float, float] | None],
    *,
    densify_step: float = 0.0,
) -> None:
    tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
    if tag == "path" and "d" in elem.attrib:
        new_d = _transform_path_d(elem.attrib["d"], mapper, densify_step=densify_step)
        if new_d:
            elem.attrib["d"] = new_d
        else:
            elem.attrib["d"] = ""
            elem.set("data-empty", "1")
    elif tag == "text":
        _transform_text_element(elem, mapper)
    elif tag == "rect" and elem.attrib.get("data-bg") == "1":
        pass  # background handled by caller
    for child in list(elem):
        _walk_and_transform(child, mapper, densify_step=densify_step)
        if child.get("data-empty") == "1" or (
            child.tag.endswith("path") and not child.attrib.get("d")
        ):
            elem.remove(child)


def _register_svg_ns() -> None:
    ET.register_namespace("", _NS)


def warp_svg_barrel(
    src: Path,
    dest: Path,
    *,
    barrel_args: str | tuple[float, ...] = BARREL_INVERSE_ARGS,
) -> Path:
    """Apply BarrelInverse to all path/text coordinates in an SVG."""
    _register_svg_ns()
    tree = ET.parse(src)
    root = tree.getroot()
    vb = root.attrib.get("viewBox", "0 0 1 1").split()
    width = float(vb[2]) if len(vb) == 4 else float(root.attrib.get("width", 1))
    height = float(vb[3]) if len(vb) == 4 else float(root.attrib.get("height", 1))
    cx, cy = width / 2.0, height / 2.0
    r_scale = 2.0 / min(width, height)
    coeffs = parse_barrel_args(barrel_args)

    def mapper(x: float, y: float) -> tuple[float, float] | None:
        return barrel_inverse_point(x, y, cx=cx, cy=cy, r_scale=r_scale, coeffs=coeffs)

    _walk_and_transform(root, mapper, densify_step=0.0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tree.write(dest, encoding="utf-8", xml_declaration=True)
    return dest


def project_svg_stripe(
    src: Path,
    dest: Path,
    *,
    stripe_index: int,
    stripes: int,
    stripe_height: float,
    background: str,
) -> Path:
    """Project square map SVG into one meridian stripe SVG."""
    _register_svg_ns()
    tree = ET.parse(src)
    root = tree.getroot()
    vb = root.attrib.get("viewBox", "0 0 1 1").split()
    map_size = float(vb[2]) if len(vb) == 4 else float(root.attrib.get("width", 1))
    yaw = stripe_index * 360.0 / stripes
    sw, sh = stripe_dimensions(stripe_height, stripes)

    def mapper(x: float, y: float) -> tuple[float, float] | None:
        return project_map_point_to_stripe(
            x,
            y,
            map_size=map_size,
            stripe_height=stripe_height,
            stripes=stripes,
            yaw_deg=yaw,
        )

    # Densify so long edges crossing a gore boundary clip cleanly.
    step = max(2.0, map_size / 250.0)
    _walk_and_transform(root, mapper, densify_step=step)

    root.attrib["viewBox"] = f"0 0 {_fmt(sw)} {_fmt(sh)}"
    root.attrib["width"] = _fmt(sw)
    root.attrib["height"] = _fmt(sh)
    root.attrib["overflow"] = "hidden"

    # Ensure background rect matches stripe
    for child in list(root):
        tag = child.tag.split("}")[-1]
        if tag == "rect" and child.attrib.get("data-bg") == "1":
            child.attrib["width"] = _fmt(sw)
            child.attrib["height"] = _fmt(sh)
            child.attrib["fill"] = background
            break
    else:
        bg = ET.Element(f"{{{_NS}}}rect")
        bg.set("data-bg", "1")
        bg.set("x", "0")
        bg.set("y", "0")
        bg.set("width", _fmt(sw))
        bg.set("height", _fmt(sh))
        bg.set("fill", background)
        root.insert(0, bg)

    dest.parent.mkdir(parents=True, exist_ok=True)
    tree.write(dest, encoding="utf-8", xml_declaration=True)
    return dest


def project_all_stripes(
    src: Path,
    work_dir: Path,
    *,
    stripes: int,
    stripe_height: float,
    background: str,
    out_prefix: str = "out",
) -> list[Path]:
    paths: list[Path] = []
    for i in range(stripes):
        dest = work_dir / f"{out_prefix}-{i:02d}.svg"
        project_svg_stripe(
            src,
            dest,
            stripe_index=i,
            stripes=stripes,
            stripe_height=stripe_height,
            background=background,
        )
        paths.append(dest)
    return paths

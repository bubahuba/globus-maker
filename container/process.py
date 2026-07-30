import asyncio
import os
import shutil
import subprocess
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from distort import (
    SPHERE_PREVIEW_MAX_EDGE,
    STRIPE_PREVIEW_MAX_HEIGHT,
    build_depolar_sphere_preview,
    build_pole_caps,
    draw_stripe_cut_line,
    jpeg_preview_bytes,
    rasterize_svg,
    spherical_prewarp,
)
from globe_readme import diameter_cm_from_stripe_height_px, globe_readme_text
from PIL import Image
from job_queue import JobCancelled
from svg_map import render_svg_map
from svg_warp import warp_svg_barrel
from tile_render import resolve_render_palette

SPHERE_PREVIEW_NAME = "input-distorted-preview.jpg"
INPUT_SVG = "input.svg"
INPUT_DISTORTED_SVG = "input-distorted.svg"
INPUT_JPG = "input.jpg"
INPUT_DISTORTED_JPG = "input-distorted.jpg"
POLE_CAPS_JPG = "pole-caps.jpg"
GLOBE_README_TXT = "README.txt"


def _ensure_not_cancelled(cancel_event: asyncio.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise JobCancelled("Job cancelled")


def cleanup_job_workdir(work_root: Path, job_id: str) -> bool:
    """Remove the job's working directory. Returns True if something was deleted."""
    safe_id = Path(job_id).name
    if not safe_id or safe_id in {".", ".."}:
        return False
    work_dir = work_root / safe_id
    if not work_dir.is_dir():
        return False
    shutil.rmtree(work_dir, ignore_errors=True)
    return not work_dir.exists()


def _files_base_url(callback_url: str | None) -> str | None:
    if not callback_url:
        return None
    if callback_url.endswith("/progress"):
        return callback_url[: -len("/progress")] + "/files"
    return callback_url.rstrip("/") + "/files"


def _zip_upload_url(callback_url: str | None) -> str | None:
    if not callback_url:
        return None
    if callback_url.endswith("/progress"):
        return callback_url[: -len("/progress")] + "/zip"
    return callback_url.rstrip("/") + "/zip"


async def report_progress(callback_url: str | None, payload: dict) -> None:
    if not callback_url:
        return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.patch(callback_url, json=payload)
            response.raise_for_status()
            try:
                body = response.json()
            except Exception:
                body = {}
            if isinstance(body, dict) and body.get("abort"):
                raise JobCancelled("Job cancelled")
    except JobCancelled:
        raise
    except Exception as exc:
        if os.environ.get("DEBUG_PROGRESS"):
            print(f"[globus] progress callback failed: {exc}", flush=True)


async def upload_result_zip(callback_url: str | None, zip_path: Path) -> bool:
    """Upload finished stripes.zip to the API so Workers need not stream /process."""
    url = _zip_upload_url(callback_url)
    if not url or not zip_path.is_file():
        return False
    try:
        data = zip_path.read_bytes()
        if len(data) < 32:
            return False
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.put(
                url,
                content=data,
                headers={"Content-Type": "application/zip"},
            )
            response.raise_for_status()
            try:
                body = response.json()
            except Exception:
                body = {}
            if isinstance(body, dict) and body.get("abort"):
                raise JobCancelled("Job cancelled")
        return True
    except JobCancelled:
        raise
    except Exception as exc:
        print(f"[globus] zip upload failed: {exc}", flush=True)
        return False


def _content_type_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".svg":
        return "image/svg+xml"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    return "application/octet-stream"


def _is_complete_file(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < 8:
            return False
        suffix = path.suffix.lower()
        if suffix == ".svg":
            head = path.read_bytes()[:64].decode("utf-8", errors="ignore").lstrip()
            return head.startswith("<?xml") or head.startswith("<svg")
        if suffix in {".jpg", ".jpeg"}:
            with path.open("rb") as fh:
                if fh.read(2) != b"\xff\xd8":
                    return False
                fh.seek(-2, os.SEEK_END)
                return fh.read(2) == b"\xff\xd9"
        return True
    except OSError:
        return False


async def upload_job_file(
    callback_url: str | None,
    path: Path,
    *,
    preview_max_height: int | None = None,
) -> bool:
    """Upload a generated artifact so the UI can preview it while the job runs.

    When ``preview_max_height`` is set for a JPEG, uploads a downscaled copy and
    leaves the on-disk original untouched (zip packaging uses full size).
    """
    base = _files_base_url(callback_url)
    if not base or not path.is_file():
        return False
    if not _is_complete_file(path):
        return False
    url = f"{base}/{path.name}"
    try:
        if preview_max_height is not None and path.suffix.lower() in {".jpg", ".jpeg"}:
            data = await asyncio.to_thread(
                jpeg_preview_bytes, path, max_height=preview_max_height
            )
        else:
            data = path.read_bytes()
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.put(
                url,
                content=data,
                headers={"Content-Type": _content_type_for(path)},
            )
            response.raise_for_status()
            try:
                body = response.json()
            except Exception:
                body = {}
            if isinstance(body, dict) and body.get("abort"):
                raise JobCancelled("Job cancelled")
        return True
    except JobCancelled:
        raise
    except Exception as exc:
        print(f"[globus] file upload failed ({path.name}): {exc}", flush=True)
        return False


async def upload_sphere_preview_from_map(
    callback_url: str | None,
    work_dir: Path,
    source: Path,
    *,
    background_color: str = "#e8eddb",
) -> bool:
    """DePolar-unwrap the stitched square map (``input.svg``) for the globe viewer.

    Keeps the SVG land canvas (Base land fill). ``background_color`` (Empty fill)
    is only used for ImageMagick letterboxing / DePolar virtual pixels outside the
    map square — not painted over the continents.
    """
    if not source.is_file():
        return False
    preview = work_dir / SPHERE_PREVIEW_NAME
    raster_tmp: Path | None = None
    try:
        map_source = source
        if source.suffix.lower() == ".svg":
            raster_tmp = work_dir / "_sphere_src.jpg"
            await asyncio.to_thread(
                rasterize_svg,
                source,
                raster_tmp,
                max_edge=SPHERE_PREVIEW_MAX_EDGE,
                background_color=background_color,
            )
            map_source = raster_tmp

        await asyncio.to_thread(
            build_depolar_sphere_preview,
            map_source,
            preview,
            max_edge=SPHERE_PREVIEW_MAX_EDGE,
            background_color=background_color,
        )
    except Exception as exc:
        print(f"[globus] sphere DePolar preview failed: {exc}", flush=True)
        return False
    finally:
        if raster_tmp is not None:
            raster_tmp.unlink(missing_ok=True)
    ok = await upload_job_file(callback_url, preview)
    if not ok:
        print(f"[globus] sphere preview upload failed ({SPHERE_PREVIEW_NAME})", flush=True)
    return ok


async def run_slize(
    work_dir: Path,
    stripes: int,
    stripe_height_px: int,
    on_progress: Callable[[int, int], Awaitable[None]] | None = None,
    *,
    background_color: str = "#e8eddb",
    source_jpg: Path | None = None,
    cancel_event: asyncio.Event | None = None,
    on_stripe_ready: Callable[[Path], Awaitable[bool | None]] | None = None,
) -> list[Path]:
    source = source_jpg if source_jpg is not None else work_dir / INPUT_JPG
    cmd = [
        "perl",
        "/app/slize.pl",
        "--outprefix",
        "out",
        "--height",
        str(stripe_height_px),
        "--stripes",
        str(stripes),
        "--background",
        background_color,
        "--ptofile",
        str(work_dir / "ptofile.pto"),
        str(source),
    ]

    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(work_dir))
    last_reported = -1
    uploaded: set[str] = set()
    cut_lined: set[str] = set()

    async def finalize_stripe(path: Path) -> Path:
        """Draw the yellow lens cut guide once the JPEG is fully written."""
        if path.name in cut_lined:
            return path
        await asyncio.to_thread(draw_stripe_cut_line, path)
        cut_lined.add(path.name)
        return path

    async def publish_ready(paths: list[Path], *, include_newest: bool) -> None:
        if not on_stripe_ready or not paths:
            return
        candidates = paths if include_newest else paths[:-1]
        for path in candidates:
            if path.name in uploaded:
                continue
            await finalize_stripe(path)
            ok = await on_stripe_ready(path)
            if ok is False:
                continue
            uploaded.add(path.name)

    try:
        while True:
            _ensure_not_cancelled(cancel_event)
            stripe_paths = sorted(work_dir.glob("out-*.jpg"))
            completed = len(stripe_paths)
            await publish_ready(stripe_paths, include_newest=False)
            if on_progress and completed != last_reported:
                last_reported = completed
                await on_progress(min(completed, stripes), stripes)
            try:
                await asyncio.wait_for(proc.wait(), timeout=0.35)
                break
            except asyncio.TimeoutError:
                continue
    except JobCancelled:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        raise

    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)

    stripe_files = sorted(work_dir.glob("out-*.jpg"))
    for path in stripe_files:
        await finalize_stripe(path)
        if on_stripe_ready and path.name not in uploaded:
            await on_stripe_ready(path)
            uploaded.add(path.name)
    if on_progress:
        await on_progress(len(stripe_files), stripes)
    return stripe_files


def create_zip(
    work_dir: Path,
    stripe_files: list[Path],
    zip_path: Path,
    *,
    extras: tuple[str, ...] = (INPUT_SVG,),
    on_file_progress: Callable[[int, int], None] | None = None,
) -> None:
    files: list[Path] = []
    for name in extras:
        path = work_dir / name
        if path.exists():
            files.append(path)
    files.extend(stripe_files)
    total = len(files)

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for index, file_path in enumerate(files, start=1):
            zf.write(file_path, arcname=file_path.name)
            if on_file_progress:
                on_file_progress(index, total)


def _finish_workdir(work_dir: Path) -> None:
    for path in work_dir.iterdir():
        if path.name == "stripes.zip":
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


async def _render_input_svg(
    payload: dict,
    work_dir: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
) -> tuple[Path, dict]:
    """Fetch MVT tiles and build the square SVG map. Returns (input_svg, render_palette)."""
    manifest = payload["manifest"]
    render_palette = resolve_render_palette(payload)

    _ensure_not_cancelled(cancel_event)
    await report_progress(
        callback_url,
        {
            "status": "fetching_tiles",
            "progress": 5,
            "stepCurrent": 0,
            "stepTotal": 1,
            "stepUnit": "tile",
        },
    )

    async def on_tile_progress(current: int, total: int) -> None:
        _ensure_not_cancelled(cancel_event)
        progress = 5 + round(45 * current / total) if total else 5
        await report_progress(
            callback_url,
            {
                "status": "fetching_tiles",
                "progress": progress,
                "stepCurrent": current,
                "stepTotal": total,
                "stepUnit": "tile",
            },
        )

    input_svg = work_dir / INPUT_SVG
    await render_svg_map(
        manifest,
        render_palette,
        input_svg,
        on_progress=on_tile_progress,
    )

    _ensure_not_cancelled(cancel_event)
    await report_progress(
        callback_url,
        {
            "status": "stitching",
            "progress": 52,
            "stepCurrent": 1,
            "stepTotal": 1,
            "stepUnit": "row",
        },
    )
    await upload_job_file(callback_url, input_svg)
    return input_svg, render_palette


def _base_fill(render_palette: dict) -> str:
    land_color = render_palette.get("land") or "#e8eddb"
    return (
        render_palette.get("baseFill")
        or render_palette.get("background")
        or land_color
    )


async def _package_and_finish(
    work_dir: Path,
    stripe_files: list[Path],
    extras: tuple[str, ...],
    *,
    callback_url: str | None,
    schedule_progress: Callable[[dict], None],
    cancel_event: asyncio.Event | None,
    stripe_count: int = 0,
    packaging_start: int = 85,
) -> tuple[Path, bool]:
    _ensure_not_cancelled(cancel_event)
    zip_path = work_dir / "stripes.zip"
    file_total = len(stripe_files) + sum(
        1 for name in extras if (work_dir / name).exists()
    )

    def on_file_progress(current: int, total: int) -> None:
        span = 100 - packaging_start
        progress = packaging_start + round(span * current / total) if total else packaging_start
        schedule_progress(
            {
                "status": "packaging",
                "progress": min(progress, 99),
                "stepCurrent": current,
                "stepTotal": total,
                "stepUnit": "file",
            }
        )

    await report_progress(
        callback_url,
        {
            "status": "packaging",
            "progress": packaging_start,
            "stepCurrent": 0,
            "stepTotal": max(file_total, 1),
            "stepUnit": "file",
        },
    )
    create_zip(
        work_dir,
        stripe_files,
        zip_path,
        extras=extras,
        on_file_progress=on_file_progress,
    )
    _finish_workdir(work_dir)

    # Deliver zip via callback first (Cloudflare Workers often cannot wait for
    # the full /process response body). Fall back to returning the file.
    uploaded = await upload_result_zip(callback_url, zip_path)
    await report_progress(
        callback_url,
        {
            "status": "complete",
            "progress": 100,
            "stripeCount": stripe_count,
        },
    )
    return zip_path, uploaded


async def _prewarp_for_stripes(
    work_dir: Path,
    input_svg: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
    base_fill: str,
    raster_max_edge: int,
) -> Path:
    """BarrelInverse prewarp + full-res JPEG for ``slize.pl`` (globe / stripes only).

    ``input-distorted.svg`` stays on disk for rasterization only — not uploaded or zipped.
    """
    input_distorted_svg = work_dir / INPUT_DISTORTED_SVG

    _ensure_not_cancelled(cancel_event)
    await asyncio.to_thread(warp_svg_barrel, input_svg, input_distorted_svg)

    _ensure_not_cancelled(cancel_event)
    input_distorted_jpg = work_dir / INPUT_DISTORTED_JPG
    await asyncio.to_thread(
        rasterize_svg,
        input_distorted_svg,
        input_distorted_jpg,
        max_edge=raster_max_edge,
        background_color=base_fill,
    )
    return input_distorted_jpg


def _prepare_square_jpeg(source: Path, dest: Path, target_px: int) -> None:
    """Center-crop to square and resize to ``target_px`` as JPEG."""
    size = max(1, int(target_px))
    with Image.open(source) as img:
        rgb = img.convert("RGB")
        w, h = rgb.size
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        cropped = rgb.crop((left, top, left + side, top + side))
        if cropped.size != (size, size):
            cropped = cropped.resize((size, size), Image.Resampling.LANCZOS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        cropped.save(dest, format="JPEG", quality=95, optimize=True)


async def _download_source_map(url: str, dest: Path) -> None:
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        dest.write_bytes(response.content)


async def _prepare_uploaded_input_jpg(
    payload: dict,
    work_dir: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
) -> tuple[Path, dict]:
    """Download user map → square ``input.jpg``; skip OSM tiles / SVG stitch."""
    source_url = str(payload.get("sourceMapUrl") or "").strip()
    if not source_url:
        raise ValueError("sourceMapUrl is required for uploaded map jobs")

    render_palette = resolve_render_palette(payload)
    stripe_height_px = int(payload.get("stripeHeightPx") or 0)
    target_px = int(
        payload.get("manifest", {}).get("targetOutputPx") or stripe_height_px or SPHERE_PREVIEW_MAX_EDGE
    )

    _ensure_not_cancelled(cancel_event)
    await report_progress(
        callback_url,
        {
            "status": "fetching_tiles",
            "progress": 10,
            "stepCurrent": 0,
            "stepTotal": 1,
            "stepUnit": "tile",
        },
    )

    raw_path = work_dir / "_source-map-upload"
    await _download_source_map(source_url, raw_path)

    _ensure_not_cancelled(cancel_event)
    await report_progress(
        callback_url,
        {
            "status": "stitching",
            "progress": 40,
            "stepCurrent": 1,
            "stepTotal": 1,
            "stepUnit": "row",
        },
    )

    input_jpg = work_dir / INPUT_JPG
    await asyncio.to_thread(_prepare_square_jpeg, raw_path, input_jpg, target_px)
    raw_path.unlink(missing_ok=True)
    await upload_job_file(callback_url, input_jpg)
    return input_jpg, render_palette


async def _prewarp_uploaded_jpg(
    work_dir: Path,
    input_jpg: Path,
    *,
    cancel_event: asyncio.Event | None,
    base_fill: str,
) -> Path:
    """JPEG BarrelInverse prewarp for uploaded maps (no SVG warp)."""
    _ensure_not_cancelled(cancel_event)
    input_distorted_jpg = work_dir / INPUT_DISTORTED_JPG
    shutil.copy2(input_jpg, input_distorted_jpg)
    await asyncio.to_thread(
        spherical_prewarp,
        input_distorted_jpg,
        background_color=base_fill,
    )
    return input_distorted_jpg


async def _process_job_map(
    payload: dict,
    work_dir: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
    schedule_progress: Callable[[dict], None],
    output_format: str,
) -> tuple[Path, bool]:
    input_svg, render_palette = await _render_input_svg(
        payload,
        work_dir,
        callback_url=callback_url,
        cancel_event=cancel_event,
    )
    base_fill = _base_fill(render_palette)
    target_px = int(payload.get("manifest", {}).get("targetOutputPx") or SPHERE_PREVIEW_MAX_EDGE)

    if output_format == "svg":
        return await _package_and_finish(
            work_dir,
            [],
            (INPUT_SVG,),
            callback_url=callback_url,
            schedule_progress=schedule_progress,
            cancel_event=cancel_event,
            packaging_start=70,
        )

    _ensure_not_cancelled(cancel_event)
    input_jpg = work_dir / INPUT_JPG
    await asyncio.to_thread(
        rasterize_svg,
        input_svg,
        input_jpg,
        max_edge=target_px,
        background_color=base_fill,
    )
    await upload_job_file(callback_url, input_jpg)

    return await _package_and_finish(
        work_dir,
        [],
        (INPUT_JPG,),
        callback_url=callback_url,
        schedule_progress=schedule_progress,
        cancel_event=cancel_event,
        packaging_start=70,
    )


async def _process_job_globe(
    payload: dict,
    work_dir: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
    schedule_progress: Callable[[dict], None],
) -> tuple[Path, bool]:
    source_map_url = str(payload.get("sourceMapUrl") or "").strip()
    uploaded = bool(source_map_url)
    tiles = payload.get("manifest", {}).get("tiles") or []
    if not uploaded and not tiles:
        raise ValueError(
            "Job has no OSM tiles and no sourceMapUrl — rebuild/restart the processor "
            "and ensure the API sends sourceMapUrl for uploaded maps"
        )

    if uploaded:
        input_jpg, render_palette = await _prepare_uploaded_input_jpg(
            payload,
            work_dir,
            callback_url=callback_url,
            cancel_event=cancel_event,
        )
        map_source: Path = input_jpg
    else:
        input_svg, render_palette = await _render_input_svg(
            payload,
            work_dir,
            callback_url=callback_url,
            cancel_event=cancel_event,
        )
        map_source = input_svg

    base_fill = _base_fill(render_palette)
    stripes = int(payload["stripes"])
    stripe_height_px = int(payload["stripeHeightPx"])
    target_px = int(
        payload.get("manifest", {}).get("targetOutputPx") or stripe_height_px or SPHERE_PREVIEW_MAX_EDGE
    )

    # Sphere overview uses the square map (SVG stitch or uploaded JPEG).
    await upload_sphere_preview_from_map(
        callback_url,
        work_dir,
        map_source,
        background_color=base_fill,
    )

    if uploaded:
        input_distorted_jpg = await _prewarp_uploaded_jpg(
            work_dir,
            map_source,
            cancel_event=cancel_event,
            base_fill=base_fill,
        )
    else:
        input_distorted_jpg = await _prewarp_for_stripes(
            work_dir,
            map_source,
            callback_url=callback_url,
            cancel_event=cancel_event,
            base_fill=base_fill,
            raster_max_edge=max(target_px, stripe_height_px),
        )

    diameter_cm = float(payload.get("diameterCm") or 0)
    if diameter_cm <= 0:
        diameter_cm = diameter_cm_from_stripe_height_px(stripe_height_px)

    _ensure_not_cancelled(cancel_event)
    pole_caps = work_dir / POLE_CAPS_JPG
    await asyncio.to_thread(
        build_pole_caps,
        input_distorted_jpg,
        pole_caps,
        diameter_cm=diameter_cm,
        empty_fill=base_fill,
    )
    await upload_job_file(callback_url, pole_caps)

    _ensure_not_cancelled(cancel_event)
    await report_progress(
        callback_url,
        {
            "status": "projecting",
            "progress": 60,
            "stepCurrent": 0,
            "stepTotal": stripes,
            "stepUnit": "stripe",
        },
    )

    async def on_stripe_progress(current: int, total: int) -> None:
        progress = 60 + round(25 * current / total) if total else 60
        await report_progress(
            callback_url,
            {
                "status": "projecting",
                "progress": progress,
                "stepCurrent": current,
                "stepTotal": total,
                "stepUnit": "stripe",
            },
        )

    async def on_stripe_ready(path: Path) -> bool:
        return await upload_job_file(
            callback_url, path, preview_max_height=STRIPE_PREVIEW_MAX_HEIGHT
        )

    stripe_files = await run_slize(
        work_dir,
        stripes,
        stripe_height_px,
        on_progress=on_stripe_progress,
        background_color=base_fill,
        source_jpg=input_distorted_jpg,
        cancel_event=cancel_event,
        on_stripe_ready=on_stripe_ready,
    )
    await report_progress(
        callback_url,
        {
            "status": "projecting",
            "progress": 85,
            "stepCurrent": len(stripe_files),
            "stepTotal": stripes,
            "stepUnit": "stripe",
        },
    )

    zip_extras = (INPUT_JPG, POLE_CAPS_JPG) if uploaded else (INPUT_SVG, POLE_CAPS_JPG)
    readme = work_dir / GLOBE_README_TXT
    readme.write_text(
        globe_readme_text(
            stripe_count=stripes,
            diameter_cm=diameter_cm,
            uploaded=uploaded,
        ),
        encoding="utf-8",
    )
    return await _package_and_finish(
        work_dir,
        stripe_files,
        (GLOBE_README_TXT, *zip_extras),
        callback_url=callback_url,
        schedule_progress=schedule_progress,
        cancel_event=cancel_event,
        stripe_count=stripes,
        packaging_start=85,
    )


async def process_job(
    payload: dict,
    work_root: Path,
    cancel_event: asyncio.Event | None = None,
) -> tuple[Path, bool]:
    job_id = payload["jobId"]
    callback_url = payload.get("callbackUrl")
    mode = str(payload.get("mode") or "globe").lower()
    if mode not in {"map", "globe"}:
        mode = "globe"

    output_format = str(payload.get("outputFormat") or "jpg").lower()
    if output_format not in {"jpg", "jpeg", "svg"}:
        output_format = "jpg"
    if output_format == "jpeg":
        output_format = "jpg"
    if mode == "globe":
        output_format = "jpg"

    loop = asyncio.get_running_loop()

    def schedule_progress(update: dict) -> None:
        loop.create_task(report_progress(callback_url, update))

    work_dir = work_root / job_id
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        if mode == "map":
            return await _process_job_map(
                payload,
                work_dir,
                callback_url=callback_url,
                cancel_event=cancel_event,
                schedule_progress=schedule_progress,
                output_format=output_format,
            )
        return await _process_job_globe(
            payload,
            work_dir,
            callback_url=callback_url,
            cancel_event=cancel_event,
            schedule_progress=schedule_progress,
        )
    except JobCancelled:
        await report_progress(
            callback_url,
            {"status": "failed", "progress": 0, "error": "Cancelled"},
        )
        shutil.rmtree(work_dir, ignore_errors=True)
        raise
    except Exception as exc:
        await report_progress(
            callback_url,
            {"status": "failed", "progress": 0, "error": str(exc)},
        )
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

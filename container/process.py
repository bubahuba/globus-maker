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
    build_depolar_sphere_preview,
    rasterize_svg,
    spherical_prewarp,
)
from job_queue import JobCancelled
from stitch import stitch_tiles
from svg_map import render_svg_map
from svg_warp import project_all_stripes, warp_svg_barrel
from tile_render import INPUT_SUPERSAMPLE, fetch_manifest, render_tiles, resolve_render_palette

SPHERE_PREVIEW_NAME = "input-distorted-preview.jpg"
INPUT_SVG = "input.svg"
INPUT_DISTORTED_SVG = "input-distorted.svg"
INPUT_JPG = "input.jpg"
INPUT_DISTORTED_JPG = "input-distorted.jpg"


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


async def upload_job_file(callback_url: str | None, path: Path) -> bool:
    """Upload a generated artifact so the UI can preview it while the job runs."""
    base = _files_base_url(callback_url)
    if not base or not path.is_file():
        return False
    if not _is_complete_file(path):
        return False
    url = f"{base}/{path.name}"
    try:
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
    """DePolar-unwrap the centre-north map and upload for the globe viewer.

    A continuous equirect from the prewarped map looks much better at the
    north pole than a side-by-side montage of stripe gores.
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

    async def publish_ready(paths: list[Path], *, include_newest: bool) -> None:
        if not on_stripe_ready or not paths:
            return
        candidates = paths if include_newest else paths[:-1]
        for path in candidates:
            if path.name in uploaded:
                continue
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
    if on_stripe_ready:
        for path in stripe_files:
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
    extras: tuple[str, ...] = (INPUT_SVG, INPUT_DISTORTED_SVG),
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


async def _process_job_svg(
    payload: dict,
    work_dir: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
    schedule_progress: Callable[[dict], None],
) -> Path:
    manifest = payload["manifest"]
    render_palette = resolve_render_palette(payload)
    stripes = int(payload["stripes"])
    stripe_height_px = int(payload["stripeHeightPx"])

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
    input_distorted = work_dir / INPUT_DISTORTED_SVG

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

    land_color = render_palette.get("land") or "#e8eddb"
    base_fill = (
        render_palette.get("baseFill")
        or render_palette.get("background")
        or land_color
    )

    _ensure_not_cancelled(cancel_event)
    await asyncio.to_thread(warp_svg_barrel, input_svg, input_distorted)
    await upload_job_file(callback_url, input_distorted)

    # Globe texture from continuous DePolar unwrap (better poles than gore montage).
    await upload_sphere_preview_from_map(
        callback_url,
        work_dir,
        input_distorted,
        background_color=base_fill,
    )

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

    stripe_files = await asyncio.to_thread(
        project_all_stripes,
        input_distorted,
        work_dir,
        stripes=stripes,
        stripe_height=float(stripe_height_px),
        background=base_fill,
    )
    for index, path in enumerate(stripe_files, start=1):
        _ensure_not_cancelled(cancel_event)
        await upload_job_file(callback_url, path)
        await on_stripe_progress(index, stripes)

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

    _ensure_not_cancelled(cancel_event)
    zip_path = work_dir / "stripes.zip"
    extras = (INPUT_SVG, INPUT_DISTORTED_SVG)
    file_total = len(stripe_files) + sum(
        1 for name in extras if (work_dir / name).exists()
    )

    def on_file_progress(current: int, total: int) -> None:
        progress = 85 + round(15 * current / total)
        schedule_progress(
            {
                "status": "packaging",
                "progress": progress,
                "stepCurrent": current,
                "stepTotal": total,
                "stepUnit": "file",
            }
        )

    await report_progress(
        callback_url,
        {
            "status": "packaging",
            "progress": 85,
            "stepCurrent": 0,
            "stepTotal": file_total,
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

    await report_progress(
        callback_url,
        {
            "status": "complete",
            "progress": 100,
            "stripeCount": stripes,
        },
    )
    return zip_path


async def _process_job_jpg(
    payload: dict,
    work_dir: Path,
    *,
    callback_url: str | None,
    cancel_event: asyncio.Event | None,
    schedule_progress: Callable[[dict], None],
) -> Path:
    manifest = payload["manifest"]
    render_palette = resolve_render_palette(payload)
    stripes = int(payload["stripes"])
    stripe_height_px = int(payload["stripeHeightPx"])

    _ensure_not_cancelled(cancel_event)
    tile_manifest = fetch_manifest(manifest, 14)
    tile_count = len(tile_manifest["tiles"])
    tile_steps = tile_count * 2
    await report_progress(
        callback_url,
        {
            "status": "fetching_tiles",
            "progress": 5,
            "stepCurrent": 0,
            "stepTotal": tile_steps,
            "stepUnit": "tile",
        },
    )
    tiles_dir = work_dir / "tiles"

    async def on_tile_progress(current: int, total: int) -> None:
        _ensure_not_cancelled(cancel_event)
        progress = 5 + round(45 * current / total)
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

    work_manifest = await render_tiles(
        {**manifest, "targetOutputPx": int(manifest["targetOutputPx"]) * INPUT_SUPERSAMPLE},
        render_palette,
        tiles_dir,
        on_progress=on_tile_progress,
    )

    _ensure_not_cancelled(cancel_event)
    await report_progress(
        callback_url,
        {
            "status": "stitching",
            "progress": 50,
            "stepCurrent": 0,
            "stepTotal": work_manifest["tileRows"],
            "stepUnit": "row",
        },
    )
    input_jpg = work_dir / INPUT_JPG
    input_distorted = work_dir / INPUT_DISTORTED_JPG

    def on_row_progress(current: int, total: int) -> None:
        _ensure_not_cancelled(cancel_event)
        progress = 50 + round(10 * current / total)
        schedule_progress(
            {
                "status": "stitching",
                "progress": progress,
                "stepCurrent": current,
                "stepTotal": total,
                "stepUnit": "row",
            }
        )

    land_color = render_palette.get("land") or "#e8eddb"
    base_fill = (
        render_palette.get("baseFill")
        or render_palette.get("background")
        or land_color
    )

    stitch_tiles(
        work_manifest,
        tiles_dir,
        input_jpg,
        on_row_progress=on_row_progress,
        background_color=land_color,
        target_output_px=work_manifest.get("targetOutputPx"),
    )
    shutil.rmtree(tiles_dir, ignore_errors=True)
    await upload_job_file(callback_url, input_jpg)

    _ensure_not_cancelled(cancel_event)
    shutil.copy2(input_jpg, input_distorted)
    await asyncio.to_thread(
        spherical_prewarp,
        input_distorted,
        background_color=base_fill,
    )
    await upload_job_file(callback_url, input_distorted)

    # Globe texture from continuous DePolar unwrap (better poles than gore montage).
    await upload_sphere_preview_from_map(
        callback_url,
        work_dir,
        input_distorted,
        background_color=base_fill,
    )

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
        return await upload_job_file(callback_url, path)

    stripe_files = await run_slize(
        work_dir,
        stripes,
        stripe_height_px,
        on_progress=on_stripe_progress,
        background_color=base_fill,
        source_jpg=input_distorted,
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

    _ensure_not_cancelled(cancel_event)
    zip_path = work_dir / "stripes.zip"
    extras = (INPUT_JPG, INPUT_DISTORTED_JPG)
    file_total = len(stripe_files) + sum(
        1 for name in extras if (work_dir / name).exists()
    )

    def on_file_progress(current: int, total: int) -> None:
        progress = 85 + round(15 * current / total)
        schedule_progress(
            {
                "status": "packaging",
                "progress": progress,
                "stepCurrent": current,
                "stepTotal": total,
                "stepUnit": "file",
            }
        )

    await report_progress(
        callback_url,
        {
            "status": "packaging",
            "progress": 85,
            "stepCurrent": 0,
            "stepTotal": file_total,
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

    await report_progress(
        callback_url,
        {
            "status": "complete",
            "progress": 100,
            "stripeCount": stripes,
        },
    )
    return zip_path


async def process_job(
    payload: dict,
    work_root: Path,
    cancel_event: asyncio.Event | None = None,
) -> Path:
    job_id = payload["jobId"]
    callback_url = payload.get("callbackUrl")
    output_format = str(payload.get("outputFormat") or "jpg").lower()
    if output_format not in {"jpg", "jpeg", "svg"}:
        output_format = "jpg"
    if output_format == "jpeg":
        output_format = "jpg"

    loop = asyncio.get_running_loop()

    def schedule_progress(update: dict) -> None:
        loop.create_task(report_progress(callback_url, update))

    work_dir = work_root / job_id
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        if output_format == "jpg":
            return await _process_job_jpg(
                payload,
                work_dir,
                callback_url=callback_url,
                cancel_event=cancel_event,
                schedule_progress=schedule_progress,
            )
        return await _process_job_svg(
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

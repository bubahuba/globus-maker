import asyncio
import os
import shutil
import subprocess
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from distort import spherical_prewarp
from job_queue import JobCancelled
from stitch import stitch_tiles
from tile_render import INPUT_SUPERSAMPLE, fetch_manifest, render_tiles, resolve_render_palette


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


def _is_complete_jpeg(path: Path) -> bool:
    """True when the file has SOI/EOI markers (not still being written)."""
    try:
        with path.open("rb") as fh:
            head = fh.read(2)
            if head != b"\xff\xd8":
                return False
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if size < 4:
                return False
            fh.seek(-2, os.SEEK_END)
            return fh.read(2) == b"\xff\xd9"
    except OSError:
        return False


async def upload_job_file(callback_url: str | None, path: Path) -> bool:
    """Upload a generated JPEG so the UI can preview it while the job runs."""
    base = _files_base_url(callback_url)
    if not base or not path.is_file():
        return False
    if not _is_complete_jpeg(path):
        return False
    url = f"{base}/{path.name}"
    try:
        data = path.read_bytes()
        # Re-check after full read — writer may have still been appending.
        if not (data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"):
            return False
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.put(
                url,
                content=data,
                headers={"Content-Type": "image/jpeg"},
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
    # Distorted prewarp feed for stereographic striping (falls back to stitched input).
    source = source_jpg if source_jpg is not None else work_dir / "input.jpg"
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
        # Newest file may still be open for writing — skip it until the next
        # stripe appears or the process exits.
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
    # Final pass: upload any skipped newest files and refresh earlier uploads
    # in case a partial JPEG slipped through.
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
    on_file_progress: Callable[[int, int], None] | None = None,
) -> None:
    files: list[Path] = []
    for name in ("input.jpg", "input-distorted.jpg"):
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


async def process_job(
    payload: dict,
    work_root: Path,
    cancel_event: asyncio.Event | None = None,
) -> Path:
    job_id = payload["jobId"]
    callback_url = payload.get("callbackUrl")
    manifest = payload["manifest"]
    render_palette = resolve_render_palette(payload)
    stripes = int(payload["stripes"])
    stripe_height_px = int(payload["stripeHeightPx"])
    loop = asyncio.get_running_loop()

    def schedule_progress(update: dict) -> None:
        loop.create_task(report_progress(callback_url, update))

    work_dir = work_root / job_id
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
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
        input_jpg = work_dir / "input.jpg"
        input_distorted = work_dir / "input-distorted.jpg"

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
        # Base-fill checkbox → empty space in projected stripes (not map land).
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
        # Tiles are only needed for stitching — free disk before prewarp/slize.
        shutil.rmtree(tiles_dir, ignore_errors=True)
        await upload_job_file(callback_url, input_jpg)

        _ensure_not_cancelled(cancel_event)
        # Keep stitched input.jpg; prewarp a copy that feeds slize.pl.
        shutil.copy2(input_jpg, input_distorted)
        await asyncio.to_thread(
            spherical_prewarp,
            input_distorted,
            background_color=base_fill,
        )
        await upload_job_file(callback_url, input_distorted)

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
        extras = sum(1 for path in (input_jpg, input_distorted) if path.exists())
        file_total = len(stripe_files) + extras

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
            {"status": "packaging", "progress": 85, "stepCurrent": 0, "stepTotal": file_total, "stepUnit": "file"},
        )
        create_zip(work_dir, stripe_files, zip_path, on_file_progress=on_file_progress)

        # Keep only the zip for the HTTP response; drop intermediates on disk.
        for path in work_dir.iterdir():
            if path.name == "stripes.zip":
                continue
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)

        await report_progress(
            callback_url,
            {
                "status": "complete",
                "progress": 100,
                "stripeCount": stripes,
            },
        )
        return zip_path
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

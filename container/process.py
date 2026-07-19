import asyncio
import os
import shutil
import subprocess
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from distort import spherical_prewarp
from stitch import stitch_tiles
from tile_render import INPUT_SUPERSAMPLE, fetch_manifest, render_tiles, resolve_render_palette


async def report_progress(callback_url: str | None, payload: dict) -> None:
    if not callback_url:
        return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.patch(callback_url, json=payload)
            response.raise_for_status()
    except Exception as exc:
        if os.environ.get("DEBUG_PROGRESS"):
            print(f"[globus] progress callback failed: {exc}", flush=True)


async def run_slize(
    work_dir: Path,
    stripes: int,
    stripe_height_px: int,
    on_progress: Callable[[int, int], Awaitable[None]] | None = None,
) -> list[Path]:
    input_jpg = work_dir / "input.jpg"
    cmd = [
        "perl",
        "/app/slize.pl",
        "--outprefix",
        "out",
        "--height",
        str(stripe_height_px),
        "--stripes",
        str(stripes),
        "--ptofile",
        str(work_dir / "ptofile.pto"),
        str(input_jpg),
    ]

    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(work_dir))
    last_reported = -1
    while True:
        completed = len(list(work_dir.glob("out-*.jpg")))
        if on_progress and completed != last_reported:
            last_reported = completed
            await on_progress(min(completed, stripes), stripes)
        try:
            await asyncio.wait_for(proc.wait(), timeout=0.35)
            break
        except asyncio.TimeoutError:
            continue
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)

    stripe_files = sorted(work_dir.glob("out-*.jpg"))
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
    input_jpg = work_dir / "input.jpg"
    if input_jpg.exists():
        files.append(input_jpg)
    files.extend(stripe_files)
    total = len(files)

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for index, file_path in enumerate(files, start=1):
            zf.write(file_path, arcname=file_path.name)
            if on_file_progress:
                on_file_progress(index, total)


async def process_job(payload: dict, work_root: Path) -> Path:
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

        def on_row_progress(current: int, total: int) -> None:
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

        stitch_tiles(
            work_manifest,
            tiles_dir,
            input_jpg,
            on_row_progress=on_row_progress,
            background_color=render_palette.get("background", "#ffffff"),
            target_output_px=work_manifest.get("targetOutputPx"),
        )
        # Pre-expand center so stereographic striping keeps stroke widths balanced.
        await asyncio.to_thread(spherical_prewarp, input_jpg)

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

        stripe_files = await run_slize(
            work_dir,
            stripes,
            stripe_height_px,
            on_progress=on_stripe_progress,
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

        zip_path = work_dir / "stripes.zip"
        file_total = len(stripe_files) + (1 if input_jpg.exists() else 0)

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

        await report_progress(
            callback_url,
            {
                "status": "complete",
                "progress": 100,
                "stripeCount": stripes,
            },
        )
        return zip_path
    except Exception as exc:
        await report_progress(
            callback_url,
            {"status": "failed", "progress": 0, "error": str(exc)},
        )
        raise

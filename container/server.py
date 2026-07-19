import ctypes
import gc
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from job_queue import JobCancelled, processor_queue
from process import cleanup_job_workdir, process_job, report_progress

app = FastAPI(title="Globus Processor")
WORK_ROOT = Path(os.environ.get("WORK_DIR", "/tmp/globus-jobs"))


def _release_memory() -> None:
    """Return freed heap pages to the OS after a large Pillow job."""
    gc.collect()
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.malloc_trim(0)
    except (OSError, AttributeError):
        pass


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", **processor_queue.snapshot()}


@app.get("/queue")
async def queue_status() -> dict:
    return processor_queue.snapshot()


@app.delete("/process/{job_id}")
async def cancel_process(job_id: str) -> dict:
    """Cancel a queued/running job and delete its work directory."""
    cancelled = await processor_queue.cancel(job_id)
    cleaned = cleanup_job_workdir(WORK_ROOT, job_id)
    # Idempotent: OK even if the job already left the queue — still wipe files.
    return {
        "ok": True,
        "jobId": job_id,
        "cancelled": cancelled,
        "cleaned": cleaned,
    }


@app.post("/process")
async def process(payload: dict) -> Response:
    required = ("jobId", "manifest", "stripes", "stripeHeightPx")
    for key in required:
        if key not in payload:
            raise HTTPException(status_code=400, detail=f"Missing field: {key}")

    job_id = str(payload["jobId"])
    callback_url = payload.get("callbackUrl")

    async def on_queue_update(position: int, length: int) -> None:
        await report_progress(
            callback_url,
            {
                "status": "queued",
                "progress": 0,
                "queuePosition": position,
                "queueLength": length,
            },
        )

    async def work(cancel_event) -> Path:
        return await process_job(payload, WORK_ROOT, cancel_event=cancel_event)

    try:
        zip_path = await processor_queue.run(job_id, work, on_queue_update=on_queue_update)
        place = str(payload.get("placeName") or "globus").strip() or "globus"
        safe = "".join(ch if ch.isalnum() else "-" for ch in place).strip("-")[:60] or "globus"
        diameter = int(round(float(payload.get("diameterCm") or 0)))
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=f"{safe}-{diameter}cm.zip",
            # Wipe work dir after the zip has been fully sent to the API.
            background=BackgroundTask(cleanup_job_workdir, WORK_ROOT, job_id),
        )
    except JobCancelled as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "Job cancelled") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        _release_memory()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)

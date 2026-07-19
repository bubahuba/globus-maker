import ctypes
import gc
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response

from process import process_job

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
    return {"status": "ok"}


@app.post("/process")
async def process(payload: dict) -> Response:
    required = ("jobId", "manifest", "stripes", "stripeHeightPx")
    for key in required:
        if key not in payload:
            raise HTTPException(status_code=400, detail=f"Missing field: {key}")

    try:
        zip_path = await process_job(payload, WORK_ROOT)
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=f"globus-stripes-{payload['jobId']}.zip",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        _release_memory()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)

"""Single-flight job queue for the Globus processor."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field


class JobCancelled(Exception):
    """Raised when a queued or running job is cancelled."""


OnQueueUpdate = Callable[[int, int], Awaitable[None]]


@dataclass
class _Entry:
    job_id: str
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)


class ProcessorQueue:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._waiting: list[_Entry] = []
        self._running: _Entry | None = None
        self._wake = asyncio.Event()

    def _line_position(self, waiting_index: int) -> tuple[int, int]:
        """1-based position/length including the currently running job."""
        running = 1 if self._running is not None else 0
        length = len(self._waiting) + running
        position = waiting_index + 1 + running
        return position, length

    def snapshot(self, job_id: str | None = None) -> dict:
        waiting_ids = [entry.job_id for entry in self._waiting]
        position = None
        length = len(waiting_ids) + (1 if self._running else 0)
        if job_id and job_id in waiting_ids:
            position, length = self._line_position(waiting_ids.index(job_id))
        return {
            "runningJobId": self._running.job_id if self._running else None,
            "waitingJobIds": waiting_ids,
            "queueLength": length,
            "queuePosition": position,
        }

    async def cancel(self, job_id: str) -> bool:
        async with self._lock:
            for index, entry in enumerate(self._waiting):
                if entry.job_id == job_id:
                    entry.cancel_event.set()
                    self._waiting.pop(index)
                    self._wake.set()
                    return True
            if self._running and self._running.job_id == job_id:
                self._running.cancel_event.set()
                return True
        return False

    async def run(
        self,
        job_id: str,
        work: Callable[[asyncio.Event], Awaitable],
        on_queue_update: OnQueueUpdate | None = None,
    ):
        """Wait for a free slot, run work(cancel_event), then release."""
        entry = _Entry(job_id=job_id)
        async with self._lock:
            self._waiting.append(entry)
            position, length = self._line_position(self._waiting.index(entry))
            # Only notify when someone else is ahead / running.
            should_notify = self._running is not None or len(self._waiting) > 1

        if on_queue_update and should_notify:
            await on_queue_update(position, length)

        try:
            cancel_event = await self._acquire(entry, on_queue_update)
            if cancel_event.is_set():
                raise JobCancelled("Job cancelled")
            return await work(cancel_event)
        except JobCancelled:
            raise
        finally:
            async with self._lock:
                if entry in self._waiting:
                    self._waiting.remove(entry)
                if self._running is entry:
                    self._running = None
                self._wake.set()

    async def _acquire(
        self,
        entry: _Entry,
        on_queue_update: OnQueueUpdate | None,
    ) -> asyncio.Event:
        while True:
            if entry.cancel_event.is_set():
                raise JobCancelled("Job cancelled while queued")

            async with self._lock:
                if entry not in self._waiting:
                    raise JobCancelled("Job cancelled while queued")

                if self._running is None and self._waiting[0] is entry:
                    self._waiting.pop(0)
                    self._running = entry
                    self._wake.clear()
                    return entry.cancel_event

                position, length = self._line_position(self._waiting.index(entry))

            if on_queue_update:
                await on_queue_update(position, length)

            self._wake.clear()
            wake_task = asyncio.create_task(self._wake.wait())
            cancel_task = asyncio.create_task(entry.cancel_event.wait())
            try:
                done, pending = await asyncio.wait(
                    {wake_task, cancel_task},
                    timeout=1.0,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if cancel_task in done or entry.cancel_event.is_set():
                    raise JobCancelled("Job cancelled while queued")
            finally:
                for task in (wake_task, cancel_task):
                    if not task.done():
                        task.cancel()


processor_queue = ProcessorQueue()

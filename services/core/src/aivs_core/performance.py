"""Opt-in, bounded numeric diagnostics. Never writes media paths or request bodies."""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import os
import time
from collections import deque
from pathlib import Path
from threading import Lock

ENABLED = os.environ.get("AIVS_PERF_METRICS") == "1"
_events: deque[dict] = deque(maxlen=4096)
_counts: dict[str, int] = {}
_lock = Lock()


def record(stage: str, elapsed_ms: float) -> None:
    if ENABLED:
        with _lock:
            _events.append({"stage": stage, "duration_ms": elapsed_ms})
            _counts[stage] = _counts.get(stage, 0) + 1


def measured(stage: str):
    def decorate(fn):
        if not ENABLED:
            return fn
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def asynchronous(*args, **kwargs):
                start = time.perf_counter()
                try:
                    return await fn(*args, **kwargs)
                finally:
                    record(stage, (time.perf_counter() - start) * 1000)

            return asynchronous

        @functools.wraps(fn)
        def synchronous(*args, **kwargs):
            start = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                record(stage, (time.perf_counter() - start) * 1000)

        return synchronous

    return decorate


async def sample_loop_lag() -> None:
    samples = 0
    while True:
        start = time.perf_counter()
        await asyncio.sleep(0.1)
        record("event_loop_lag", max(0, (time.perf_counter() - start - 0.1) * 1000))
        samples += 1
        if samples % 50 == 0:
            await asyncio.to_thread(flush)  # Windows shutdown may skip lifespan finalization.


def flush() -> None:
    output = os.environ.get("AIVS_PERF_OUTPUT")
    if not ENABLED or not output:
        return
    with _lock:
        snapshot = {
            "schema_version": 1,
            "counts": dict(_counts),
            "capacity": 4096,
            "events": list(_events),
            "overwritten": max(0, sum(_counts.values()) - len(_events)),
        }
    try:
        # Atomic replacement preserves the previous complete sample on forced exit.
        target = Path(output)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(json.dumps(snapshot), encoding="utf-8")
        temporary.replace(target)
    except OSError:
        pass  # Diagnostics must not change application success/failure semantics.
